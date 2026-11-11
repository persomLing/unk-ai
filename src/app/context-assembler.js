import { awaitWithAbort } from '../utils/abortable.js';
import { createCapabilityHost } from './capability-host.js';

const TRUST_LEVELS = new Set(['user', 'configured-skill', 'external-data']);

function limit(value, fallback, ceiling) {
  return Number.isFinite(value) && value >= 0 ? Math.min(ceiling, Math.floor(value)) : fallback;
}

function freezeData(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeData(item, seen);
  return Object.freeze(value);
}

function field(value, maxLength = 256) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function publicRunContext(run, signal, deadlineAt) {
  const profile = run.profile || run.model || {};
  const target = run.target;
  return Object.freeze({
    conversationId: field(run.conversationId), turnId: field(run.turnId), runId: field(run.runId),
    mode: run.mode === 'agent' ? 'agent' : 'chat', signal, deadlineAt,
    model: Object.freeze({
      id: field(profile.id), model: field(profile.model),
      supportsVision: profile.supportsVision === true,
    }),
    ...(target ? { target: Object.freeze({
      ...(Number.isInteger(target.tabId ?? target.id) ? { tabId: target.tabId ?? target.id } : {}),
      url: field(target.url || target.expectedUrl, 4096),
      documentId: field(target.documentId), title: field(target.title, 512),
    }) } : {}),
    budget: Object.freeze(Object.fromEntries(Object.entries(run.budget || {})
      .filter(([, value]) => Number.isFinite(value) && value >= 0))),
  });
}

export class ContextProviderError extends Error {
  constructor(providerId, cause) {
    super(`必需的上下文能力「${providerId}」未能提供资料：${cause?.message || '能力不可用'}。`, { cause });
    this.name = 'ContextProviderError';
    this.code = 'CONTEXT_PROVIDER_FAILED';
    this.providerId = providerId;
  }
}

/** Validate only bounded output; never accept provider-supplied trust or priority. */
function normalizedBlocks(output, policy) {
  if (!Array.isArray(output)) throw new TypeError('上下文能力必须返回 ContextBlock 数组。');
  const blocks = [];
  const seen = new Set();
  let remaining = policy.maxChars;
  let discarded = output.length > policy.maxBlocks;
  for (const block of output.slice(0, policy.maxBlocks)) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string' || block.id.length > 256 || !block.id.trim()
      || typeof block.content !== 'string'
      || !block.source || typeof block.source !== 'object'
      || typeof block.source.kind !== 'string' || block.source.kind.length > 64 || !block.source.kind.trim()
      || ['url', 'title', 'capturedAt'].some(key => block.source[key] !== undefined && typeof block.source[key] !== 'string')) {
      throw new TypeError('上下文块缺少有效的 id、content 或 source.kind。');
    }
    if (seen.has(block.id)) continue;
    if (remaining === 0) { discarded = true; break; }
    const content = block.content.slice(0, remaining);
    if (!content.trim()) { discarded ||= block.content.length > content.length; continue; }
    seen.add(block.id);
    remaining -= content.length;
    blocks.push({
      id: block.id, providerId: policy.id, content,
      source: {
        kind: field(block.source.kind, 64),
        ...(block.source.url ? { url: field(block.source.url, 4096) } : {}),
        ...(block.source.title ? { title: field(block.source.title, 512) } : {}),
        ...(block.source.capturedAt ? { capturedAt: field(block.source.capturedAt, 64) } : {}),
      },
      trust: policy.trust, priority: policy.priority,
      truncated: block.truncated === true || content.length < block.content.length,
    });
  }
  if (discarded && blocks.length) blocks.at(-1).truncated = true;
  return { blocks, discarded };
}

/**
 * A descriptor supplies collect(input, run), or create(lifetime) -> { collect }.
 * Factories belong to the application lifetime, not a conversation. Required,
 * trust, timeout and budget policy belongs to the host descriptor. Caller data
 * is independently snapshotted for each provider, and credentials stay private.
 */
export function createContextAssembler({
  providers = [], maxChars = 16000, maxBlocks = 16,
  signal, initializationTimeoutMs = 3000, cleanupTimeoutMs = 1000,
} = {}) {
  const totalChars = limit(maxChars, 16000, 100000);
  const totalBlocks = limit(maxBlocks, 16, 64);
  const application = new AbortController();
  const abortApplication = () => application.abort(signal.reason);
  signal?.addEventListener('abort', abortApplication, { once: true });
  if (signal?.aborted) abortApplication();
  const host = createCapabilityHost({ signal: application.signal, initializationTimeoutMs, cleanupTimeoutMs });
  let policies;
  try { policies = providers.map((descriptor, index) => {
    if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id.trim()) throw new TypeError('Context provider id is required.');
    if ((typeof descriptor.collect === 'function') === (typeof descriptor.create === 'function')) {
      throw new TypeError(`Context provider ${descriptor.id} must specify collect or create.`);
    }
    const policy = Object.freeze({
      id: descriptor.id,
      required: descriptor.required === true,
      enabled: descriptor.enabled !== false,
      timeoutMs: Math.max(1, limit(descriptor.timeoutMs, 2000, 60000)),
      maxChars: limit(descriptor.maxChars, 8000, 100000),
      maxBlocks: limit(descriptor.maxBlocks, 8, 64),
      priority: Number.isFinite(descriptor.priority) ? descriptor.priority : 0,
      trust: TRUST_LEVELS.has(descriptor.trust) ? descriptor.trust : 'external-data',
      index,
    });
    host.add({
      id: policy.id,
      label: `上下文能力「${policy.id}」`,
      enabled: policy.enabled,
      create: descriptor.create || (() => ({ collect: descriptor.collect })),
      validate: implementation => {
        if (typeof implementation.collect !== 'function' || (implementation.apiVersion !== undefined && implementation.apiVersion !== 1)) {
          throw new TypeError('上下文能力需实现兼容的 collect 方法。');
        }
      },
    });
    return policy;
  }); } catch (error) {
    signal?.removeEventListener('abort', abortApplication);
    void host.dispose();
    throw error;
  }

  async function collectOne(policy, input, run) {
    const controller = new AbortController();
    const cancel = () => controller.abort(run.signal.reason);
    const cancelApplication = () => controller.abort(application.signal.reason);
    run.signal?.addEventListener('abort', cancel, { once: true });
    application.signal.addEventListener('abort', cancelApplication, { once: true });
    if (run.signal?.aborted) cancel();
    if (application.signal.aborted) cancelApplication();
    const deadlineAt = Math.min(Date.now() + policy.timeoutMs, Number.isFinite(run.deadlineAt) ? run.deadlineAt : Infinity);
    const timeout = () => controller.abort(new DOMException(`上下文能力「${policy.id}」执行超时。`, 'TimeoutError'));
    const timer = setTimeout(timeout, Math.max(0, deadlineAt - Date.now()));
    if (deadlineAt <= Date.now()) timeout();
    try {
      controller.signal.throwIfAborted();
      const provider = await host.require(policy.id, { signal: controller.signal, deadlineAt });
      controller.signal.throwIfAborted();
      const snapshot = freezeData(structuredClone(input));
      const context = publicRunContext(run, controller.signal, deadlineAt);
      const output = await awaitWithAbort(Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return provider.collect(snapshot, context);
      }), controller.signal);
      controller.signal.throwIfAborted();
      return normalizedBlocks(output, policy);
    } finally {
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', cancel);
      application.signal.removeEventListener('abort', cancelApplication);
    }
  }

  async function collect(input, run, { required = [] } = {}) {
    if (!run || typeof run.runId !== 'string' || !run.runId) throw new TypeError('Context collection requires a runId.');
    run.signal?.throwIfAborted();
    application.signal.throwIfAborted();
    if (Number.isFinite(run.deadlineAt) && run.deadlineAt <= Date.now()) throw new DOMException('上下文收集超时。', 'TimeoutError');
    const requiredIds = new Set(required);
    for (const id of requiredIds) {
      if (!policies.some(policy => policy.id === id)) throw new ContextProviderError(id, new Error('未注册该能力'));
    }
    const selected = policies.map(policy => ({ ...policy, required: policy.required || requiredIds.has(policy.id) }))
      .filter(policy => policy.enabled || policy.required)
      .sort((left, right) => Number(right.required) - Number(left.required) || right.priority - left.priority || left.index - right.index);
    const results = await awaitWithAbort(Promise.all(selected.map(async policy => {
      try {
        if (!totalChars || !totalBlocks || !policy.maxChars || !policy.maxBlocks) throw new Error('上下文预算为零');
        const result = await collectOne(policy, input, run);
        return { policy, ...result };
      } catch (error) { return { policy, error }; }
    })), run.signal);
    run.signal?.throwIfAborted();
    application.signal.throwIfAborted();
    if (Number.isFinite(run.deadlineAt) && run.deadlineAt <= Date.now()) throw new DOMException('上下文收集超时。', 'TimeoutError');
    const blocks = [];
    const issues = [];
    const contentSeen = new Set();
    let remaining = totalChars;
    for (const result of results) {
      const { policy } = result;
      if (result.error) {
        if (policy.required) throw new ContextProviderError(policy.id, result.error);
        issues.push({ providerId: policy.id, code: result.error.code || result.error.name || 'CONTEXT_PROVIDER_FAILED', message: result.error.message || String(result.error) });
        continue;
      }
      let contributed = false;
      let discarded = result.discarded;
      for (const block of result.blocks) {
        const identity = `${block.source.url || block.source.kind}\u0000${block.content}`;
        if (contentSeen.has(identity)) { contributed = true; continue; }
        if (!remaining || blocks.length >= totalBlocks) { discarded = true; break; }
        const content = block.content.slice(0, remaining);
        remaining -= content.length;
        contentSeen.add(identity);
        blocks.push({ ...block, content, truncated: block.truncated || content.length < block.content.length });
        discarded ||= content.length < block.content.length;
        contributed = true;
      }
      if (policy.required && !contributed) throw new ContextProviderError(policy.id, new Error('没有可纳入预算的有效上下文'));
      if (discarded || result.blocks.some(block => block.truncated)) {
        const last = blocks.findLast(block => block.providerId === policy.id);
        if (last) last.truncated = true;
        issues.push({ providerId: policy.id, code: 'CONTEXT_TRUNCATED', message: '上下文已按预算截断。' });
      }
    }
    return freezeData({ blocks, issues });
  }

  function dispose() {
    signal?.removeEventListener('abort', abortApplication);
    application.abort(new DOMException('上下文能力已关闭。', 'AbortError'));
    return host.dispose();
  }
  return Object.freeze({ collect, status: host.status, ready: host.ready(), dispose });
}

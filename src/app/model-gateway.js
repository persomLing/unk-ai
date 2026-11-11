import {
  requestAgentDecision,
  requestGatewayWebFetch,
  requestGatewayWebSearch,
  requestTextCompletion,
  streamChatCompletion,
  streamChatToolCompletion,
} from '../utils/llm-client.js';

export const MODEL_PURPOSES = Object.freeze([
  'answer', 'agent-decision', 'visual-decision', 'reading-decision', 'research-decision', 'web-search', 'web-fetch', 'compression', 'suggestions',
]);
export const DEFAULT_MODEL_TIMEOUTS = Object.freeze({
  answer: 120000, 'agent-decision': 60000, 'visual-decision': 8000,
  'reading-decision': 8000,
  'research-decision': 8000, 'web-search': 25000, 'web-fetch': 25000, compression: 30000, suggestions: 15000,
});

const MODEL_FIELDS = ['model', 'temperature', 'contextLength', 'maxTokens',
  'reasoningEnabled', 'reasoningEffort', 'supportsVision',
  'webSearchEndpoint', 'webFetchEndpoint', 'webSearchEnabled', 'webFetchEnabled'];
const PROFILE_FIELDS = ['endpointUrl', 'apiKey', ...MODEL_FIELDS];
const TRANSPORT_EVENTS = new Set(['started', 'headers', 'first-byte', 'progress', 'first-reasoning', 'first-content',
  'fallback', 'body-started', 'body-completed', 'completed', 'failed', 'cancelled'].map(value => `transport.${value}`));
const DIAGNOSTIC_REASONS = new Set(['complete', 'empty', 'reasoning-only', 'truncated', 'malformed', 'error-event',
  'rate-limit', 'unsupported-parameter', 'missing-body', 'http-error', 'network', 'stream-error', 'aborted', 'timeout']);
const DIAGNOSTIC_NUMBERS = ['attempt', 'firstByteMs', 'firstReasoningMs', 'firstContentMs', 'byteCount', 'chunkCount', 'eventCount'];

function notifyObserver(observer, event) {
  if (typeof observer !== 'function') return;
  try { Promise.resolve(observer(event)).catch(() => {}); } catch { /* Diagnostics never control generation. */ }
}

function diagnosticFields(value) {
  const fields = {};
  for (const key of DIAGNOSTIC_NUMBERS) {
    if (Number.isFinite(value?.[key]) && value[key] >= 0) fields[key] = Math.min(2147483647, Math.floor(value[key]));
  }
  if (Number.isInteger(value?.status) && value.status >= 100 && value.status <= 599) fields.status = value.status;
  if (['text/event-stream', 'application/json', 'text/json', 'text/plain', 'text/html', 'other', 'missing'].includes(value?.contentType)) fields.contentType = value.contentType;
  if (DIAGNOSTIC_REASONS.has(value?.reason)) fields.reason = value.reason;
  if (Number.isFinite(value?.durationMs) && value.durationMs >= 0) fields.transportDurationMs = Math.min(86400000, Math.floor(value.durationMs));
  return fields;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function pick(source, fields) {
  return Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

function errorWith(code, message, name = 'Error') {
  return Object.assign(new Error(message), { code, name });
}

function validId(id) {
  return typeof id === 'string' && id.trim().length > 0 && id.length <= 200;
}

function redact(value, key) {
  let text = String(value || '模型请求失败。');
  if (typeof key === 'string' && key.trim()) {
    text = text.split(key).join('[redacted]').split(key.trim()).join('[redacted]');
  }
  return text.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1000);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function safeFailure(error, key, purpose) {
  const name = error?.name === 'AbortError' ? 'AbortError' : error?.name === 'TimeoutError' ? 'TimeoutError' : 'Error';
  const code = name === 'AbortError' ? 'ERR_MODEL_CANCELLED'
    : name === 'TimeoutError' ? 'ERR_MODEL_TIMEOUT' : 'ERR_MODEL_REQUEST_FAILED';
  const failure = errorWith(code, redact(error?.message || error, key), name);
  // A read-only capability adapter may fall back only after a confirmed HTTP
  // absence. Preserve the bounded status, never raw endpoints or error objects.
  if (name === 'Error' && ['web-search', 'web-fetch'].includes(purpose)
    && Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) failure.status = error.status;
  return failure;
}

function cancellation(reason) {
  return errorWith('ERR_MODEL_CANCELLED', reason?.message || String(reason || '模型请求已取消。'),
    reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError');
}

/** Keep existing SSE and Agent compatibility fallbacks at the transport layer. */
export function createModelTransport({ fetchImpl } = {}) {
  return ({ purpose, profile, request, signal, onDelta, onReasoning, onDiagnostic }) => {
    const input = { ...profile, ...request, signal, onDiagnostic, ...(fetchImpl ? { fetchImpl } : {}) };
    if (purpose === 'answer') {
      const complete = Array.isArray(request.tools) ? streamChatToolCompletion : streamChatCompletion;
      return complete({ ...input, onDelta, onReasoning });
    }
    if (purpose === 'agent-decision') return requestAgentDecision(input);
    if (purpose === 'web-search') return requestGatewayWebSearch({ ...input, endpointName: profile.webSearchEndpoint, maxResults: input.maxResults });
    if (purpose === 'web-fetch') return requestGatewayWebFetch({ ...input, endpointName: profile.webFetchEndpoint });
    return requestTextCompletion(input);
  };
}

/**
 * One frozen provider configuration per run; independent requests per purpose.
 * The gateway never writes messages, retries an application request or emits
 * assistant lifecycle events. Only answer requests can receive stream callbacks.
 */
export function createModelGateway({
  transport = createModelTransport(),
  clock = {},
  onEvent: globalObserver,
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('Model transport must be a function.');
  if (globalObserver !== undefined && typeof globalObserver !== 'function') throw new TypeError('onEvent must be a function.');
  const now = clock.now || (() => Date.now());
  const schedule = clock.setTimeout || ((callback, delay) => setTimeout(callback, delay));
  const unschedule = clock.clearTimeout || (timer => clearTimeout(timer));

  function createRun({ runId, profile, signal: parentSignal, deadlineAt: runDeadline, onEvent, diagnosticContext } = {}) {
    if (!validId(runId)) throw new TypeError('A model run requires a stable runId.');
    if (!profile || typeof profile !== 'object') throw new TypeError('A model run requires a profile.');
    if (runDeadline !== undefined && !Number.isFinite(runDeadline)) throw new TypeError('Run deadlineAt must be finite.');
    if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');
    const config = freeze(structuredClone(pick(profile, PROFILE_FIELDS)));
    const modelInfo = freeze(structuredClone(pick(config, MODEL_FIELDS)));
    // Optional effects outlive the active turn. Snapshot only their submitted
    // identity; these fields never enter provider requests or execution state.
    const diagnosticOwner = Object.freeze(Object.fromEntries(['conversationId', 'turnId'].flatMap(key =>
      validId(diagnosticContext?.[key]) ? [[key, redact(diagnosticContext[key], config.apiKey)]] : [])));
    const controller = new AbortController();
    const requests = new Map();
    const cancelFromParent = () => controller.abort(parentSignal.reason || errorWith('ERR_MODEL_CANCELLED', '模型运行已取消。', 'AbortError'));
    parentSignal?.addEventListener('abort', cancelFromParent, { once: true });
    if (parentSignal?.aborted) cancelFromParent();

    function emit(type, entry, extra = {}) {
      // Fixed metadata only: never expose provider config, request/response
      // bodies, credentials, raw errors or the model's reasoning to telemetry.
      const event = Object.freeze({ type, ...diagnosticOwner, runId: redact(runId, config.apiKey),
        requestId: redact(entry.id, config.apiKey), purpose: entry.purpose,
        at: now(), durationMs: Math.max(0, now() - entry.startedAt), ...entry.diagnostics, ...extra });
      notifyObserver(globalObserver, event);
      notifyObserver(onEvent, event);
    }

    function request(options = {}) {
      const { requestId, purpose, signal, onDelta, onReasoning } = options;
      if (controller.signal.aborted) return Promise.reject(safeFailure(cancellation(controller.signal.reason), config.apiKey));
      if (runDeadline !== undefined && now() >= runDeadline) {
        return Promise.reject(errorWith('ERR_MODEL_TIMEOUT', '模型运行已超过截止时间。', 'TimeoutError'));
      }
      if (!validId(requestId)) return Promise.reject(errorWith('ERR_MODEL_REQUEST_ID', '模型请求缺少有效 requestId。'));
      if (!MODEL_PURPOSES.includes(purpose)) return Promise.reject(errorWith('ERR_MODEL_PURPOSE', '未知的模型请求用途。'));
      if (purpose !== 'answer' && (onDelta !== undefined || onReasoning !== undefined)) {
        return Promise.reject(errorWith('ERR_MODEL_PURPOSE', '辅助模型请求不能发布主回答内容。'));
      }
      if ((onDelta !== undefined && typeof onDelta !== 'function') || (onReasoning !== undefined && typeof onReasoning !== 'function')) {
        return Promise.reject(new TypeError('Stream callbacks must be functions.'));
      }
      if (purpose === 'web-search') {
        if (typeof options.query !== 'string' || !options.query.trim() || options.query.length > 200) {
          return Promise.reject(new TypeError('Web search requires a non-empty query of at most 200 characters.'));
        }
      }
      if (purpose === 'web-fetch') {
        try {
          const url = new URL(String(options.url || ''));
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        } catch {
          return Promise.reject(new TypeError('Web fetch requires a public HTTP or HTTPS URL.'));
        }
      }
      if (purpose === 'web-search' && config.webSearchEnabled === false) {
        return Promise.reject(errorWith('ERR_WEB_SEARCH_DISABLED', '联网搜索已在设置中关闭。'));
      }
      if (purpose === 'web-fetch' && config.webFetchEnabled === false) {
        return Promise.reject(errorWith('ERR_WEB_FETCH_DISABLED', '网页抓取已在设置中关闭。'));
      }
      if (!['web-search', 'web-fetch'].includes(purpose) && !Array.isArray(options.messages)) {
        return Promise.reject(new TypeError('Model request messages must be an array.'));
      }
      if (options.tools !== undefined && (!['answer', 'agent-decision'].includes(purpose) || !Array.isArray(options.tools))) {
        return Promise.reject(errorWith('ERR_MODEL_PURPOSE', '只有主回答或 Agent 决策请求可以声明工具数组。'));
      }
      if (options.toolChoice !== undefined && (purpose !== 'answer' || !Array.isArray(options.tools)
        || !['auto', 'none'].includes(options.toolChoice))) {
        return Promise.reject(errorWith('ERR_MODEL_PURPOSE', '工具选择只允许带工具数组的主回答使用 auto 或 none。'));
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUTS[purpose];
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0
        || (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))) {
        return Promise.reject(new TypeError('Model request timeout/deadline must be finite.'));
      }
      const defaultTokens = ['answer', 'agent-decision', 'suggestions'].includes(purpose) ? config.maxTokens
        : purpose === 'visual-decision' ? 80
          : purpose === 'research-decision' ? 120
            : config.maxTokens ? Math.min(4000, config.maxTokens) : undefined;
      const defaultTemperature = purpose === 'compression' ? undefined
        : ['agent-decision', 'visual-decision', 'research-decision'].includes(purpose) ? 0 : config.temperature;
      let input;
      let fingerprint;
      try {
        input = freeze(structuredClone({ ...(['web-search', 'web-fetch'].includes(purpose) ? {} : { messages: options.messages }),
          ...(purpose === 'agent-decision' ? { tools: options.tools || [] } : {}),
          ...(purpose === 'answer' && Array.isArray(options.tools) ? { tools: options.tools,
            toolChoice: options.toolChoice ?? 'auto' } : {}),
          ...(purpose === 'web-search' ? { query: options.query, maxResults: options.maxResults } : {}),
          ...(purpose === 'web-fetch' ? { url: options.url } : {}),
          ...(['web-search', 'web-fetch'].includes(purpose) ? {} : {
            maxTokens: Object.hasOwn(options, 'maxTokens') ? options.maxTokens : defaultTokens,
            temperature: Object.hasOwn(options, 'temperature') ? options.temperature : defaultTemperature,
          }),
        }));
        fingerprint = JSON.stringify(canonical({ purpose, input, timeoutMs, deadlineAt: options.deadlineAt }));
      } catch {
        return Promise.reject(new TypeError('Model request data must be serializable.'));
      }
      const existing = requests.get(requestId);
      if (existing) return existing.fingerprint === fingerprint ? existing.promise
        : Promise.reject(errorWith('ERR_MODEL_REQUEST_ID_REUSED', '相同 requestId 不可用于不同模型请求。'));

      const startedAt = now();
      const deadline = Math.min(startedAt + timeoutMs, runDeadline ?? Infinity, options.deadlineAt ?? Infinity);
      const requestController = new AbortController();
      const entry = { id: requestId, purpose, fingerprint, startedAt, settled: false, timer: null, promise: null,
        diagnostics: {}, firstSignals: new Set() };
      let resolveResult;
      let rejectResult;
      entry.promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      requests.set(requestId, entry);

      function settle(error, value) {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.timer !== null) unschedule(entry.timer);
        signal?.removeEventListener('abort', cancelRequest);
        controller.signal.removeEventListener('abort', cancelRun);
        if (error) {
          const safe = safeFailure(error, config.apiKey, purpose);
          requestController.abort(safe);
          emit(safe.name === 'AbortError' ? 'model.request.cancelled' : 'model.request.failed', entry, { errorCode: safe.code,
            ...(safe.name === 'AbortError' ? { reason: 'aborted' } : safe.name === 'TimeoutError' ? { reason: 'timeout' } : {}) });
          rejectResult(safe);
        } else {
          emit('model.request.completed', entry);
          resolveResult(value);
        }
      }
      const timeout = () => settle(errorWith('ERR_MODEL_TIMEOUT', '模型请求超时。', 'TimeoutError'));
      const cancelRequest = () => settle(cancellation(signal.reason));
      const cancelRun = () => settle(cancellation(controller.signal.reason));

      const observes = typeof globalObserver === 'function' || typeof onEvent === 'function';
      function onDiagnostic(event) {
        if (entry.settled || controller.signal.aborted || signal?.aborted || now() >= deadline || !TRANSPORT_EVENTS.has(event?.type)) return;
        const firstSignal = ['transport.first-content', 'transport.first-reasoning', 'transport.first-byte'].includes(event.type);
        if (firstSignal && entry.firstSignals.has(event.type)) return;
        if (firstSignal) entry.firstSignals.add(event.type);
        Object.assign(entry.diagnostics, diagnosticFields(event));
        emit(`model.${event.type}`, entry);
      }
      function firstOutput(kind, args) {
        if (observes && args.slice(0, 2).some(value => typeof value === 'string' && value.length > 0)) {
          const field = kind === 'reasoning' ? 'firstReasoningMs' : 'firstContentMs';
          onDiagnostic({ type: `transport.first-${kind}`, [field]: Math.max(0, now() - startedAt) });
        }
      }

      function live() {
        if (entry.settled) return false;
        if (controller.signal.aborted) { cancelRun(); return false; }
        if (signal?.aborted) { cancelRequest(); return false; }
        if (now() >= deadline) { timeout(); return false; }
        return true;
      }
      signal?.addEventListener('abort', cancelRequest, { once: true });
      controller.signal.addEventListener('abort', cancelRun, { once: true });
      if (!live()) return entry.promise;
      entry.timer = schedule(timeout, Math.max(0, deadline - now()));
      emit('model.request.started', entry);
      Promise.resolve().then(() => {
        if (!live()) return undefined;
        return transport({ purpose, profile: config, request: input, signal: requestController.signal,
          ...(observes ? { onDiagnostic } : {}),
          ...(purpose === 'answer' ? {
            onDelta: (...args) => { if (live()) { firstOutput('content', args); onDelta?.(...args); } },
            onReasoning: (...args) => { if (live()) { firstOutput('reasoning', args); onReasoning?.(...args); } },
          } : {}),
        });
      }).then(value => { if (live()) settle(null, value); }, error => { if (live()) settle(error); });
      return entry.promise;
    }

    function cancel(reason) {
      parentSignal?.removeEventListener('abort', cancelFromParent);
      controller.abort(reason instanceof Error ? reason : errorWith('ERR_MODEL_CANCELLED', reason || '模型运行已取消。', 'AbortError'));
    }

    return Object.freeze({ runId, modelInfo, signal: controller.signal, request, cancel, dispose: cancel });
  }

  return Object.freeze({ createRun });
}

import { awaitWithAbort, awaitWithTimeout } from '../utils/abortable.js';
import { assertPageTarget, pageTargetFields } from '../utils/page-target.js';
import {
  NETWORK_READING_LIMITS,
  NETWORK_READING_SETTINGS_KEY,
  getNetworkReadingGrant,
  networkReadingError,
  networkReadingOrigin,
  networkResponseSource,
  normalizeNetworkReadingSettings,
  sanitizeNetworkJson,
} from '../utils/network-reading.js';

const coordinators = new WeakMap();
export const NETWORK_READING_PORT = 'unk-ai-network-reading';
const fail = networkReadingError;
const safeToken = value => typeof value === 'string' && value.length >= 8 && value.length <= 160 && /^[\w:-]+$/.test(value);

/** One debugger attachment per tab. Timed-out attach/detach retains its lease until it really settles. */
export function createPageDebuggerCoordinator(api, { attachTimeoutMs = 8000, detachTimeoutMs = 1500 } = {}) {
  const leases = new Map();
  const onDetach = (source) => {
    const lease = leases.get(source.tabId);
    if (lease) lease.detached = true;
  };
  api.debugger.onDetach?.addListener(onDetach);
  async function acquire(target, { signal } = {}) {
    if (signal?.aborted) throw signal.reason;
    if (leases.has(target.tabId)) throw fail('NETWORK_DEBUGGER_BUSY', '本页调试器正在读取，请稍后重试。');
    const slot = { target: { tabId: target.tabId }, attached: false, detached: false, released: false, attachSettled: false };
    leases.set(target.tabId, slot);
    const remove = () => { if (leases.get(target.tabId) === slot) leases.delete(target.tabId); };
    const check = () => {
      if (signal?.aborted) throw signal.reason;
      if (slot.released || slot.detached || leases.get(target.tabId) !== slot) {
        throw fail('NETWORK_DEBUGGER_RELEASED', '页面调试会话已结束。');
      }
    };
    const cleanup = () => {
      if (slot.cleanup) return slot.cleanup;
      slot.cleanup = (async () => {
        // Do not let a late attach or detach act on a later caller's debugger session.
        try { await slot.attach; } catch { remove(); return; }
        if (!slot.attached || slot.detached) { remove(); return; }
        try { await api.debugger.detach(slot.target); }
        finally { remove(); }
      })();
      slot.cleanup.catch(() => {});
      return slot.cleanup;
    };
    const release = async () => {
      slot.released = true;
      await awaitWithTimeout(cleanup(), { timeoutMs: detachTimeoutMs, message: '释放页面调试器超时。' }).catch(() => {});
    };
    slot.attach = Promise.resolve().then(() => {
      check();
      return api.debugger.attach(slot.target, '1.3');
    }).then(() => { slot.attached = true; slot.attachSettled = true; }, error => { slot.attachSettled = true; throw error; });
    try {
      await awaitWithTimeout(slot.attach, { signal, timeoutMs: attachTimeoutMs, message: '连接页面调试器超时。' });
      check();
      return {
        target: slot.target,
        check,
        release,
        async sendCommand(method, parameters) {
          check();
          const result = await awaitWithAbort(api.debugger.sendCommand(slot.target, method, parameters), signal);
          check();
          return result;
        },
      };
    } catch (error) {
      slot.released = true;
      cleanup();
      throw error;
    }
  }
  return { acquire };
}

function coordinatorFor(api) {
  if (!coordinators.has(api)) coordinators.set(api, createPageDebuggerCoordinator(api));
  return coordinators.get(api);
}

/** Use sendCommand rather than raw chrome.debugger calls inside the callback. */
export async function withPageDebugger(target, operation, options = {}) {
  const api = options.chrome || globalThis.chrome;
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let lease;
  const timer = setTimeout(() => controller.abort(fail('NETWORK_DEBUGGER_TIMEOUT', '页面调试读取超时。')), options.timeoutMs ?? 20000);
  try {
    lease = await (options.coordinator || coordinatorFor(api)).acquire(target, { signal: controller.signal });
    return await awaitWithAbort(Promise.resolve().then(() => {
      lease.check();
      return operation(lease.target, lease.sendCommand);
    }), controller.signal);
  } finally {
    controller.abort(fail('NETWORK_DEBUGGER_RELEASED', '页面调试会话已结束。'));
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    await lease?.release();
  }
}

function trustedSender(api, sender) {
  if (!sender || sender.id !== api.runtime.id || sender.tab) return false;
  try {
    const actual = new URL(sender.url);
    const expected = new URL(api.runtime.getURL('src/sidepanel/index.html'));
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
  } catch { return false; }
}

function ownerKey(sender) { return `${sender.id}:${sender.documentId || sender.url}`; }

function targetOf(message) {
  const target = pageTargetFields(message);
  if (!Number.isInteger(target.tabId) || target.tabId < 0 || !target.expectedUrl || !target.documentId
    || !networkReadingOrigin(target.expectedUrl)) {
    throw fail('NETWORK_TARGET_INVALID', '接口读取需要固定标签页、完整地址和文档身份。');
  }
  return target;
}

/**
 * Bounded, read-only response capture. Requests are never replayed; headers and request bodies are never collected.
 * A sidepanel-owned runtime port is required, so closing that panel revokes the capture immediately.
 */
export function createNetworkReadingService(options = {}) {
  const api = options.chrome || globalThis.chrome;
  const coordinator = options.coordinator || coordinatorFor(api);
  const ioTimeoutMs = options.ioTimeoutMs ?? 3000;
  const durationMs = options.durationMs ?? NETWORK_READING_LIMITS.durationMs;
  const sessions = new Map();
  const bindings = new Map();
  const ports = new Set();
  const byTab = new Map();
  const validations = new Set();
  let disposed = false;

  function assertSender(sender) {
    if (disposed) throw fail('NETWORK_SERVICE_DISPOSED', '接口读取服务已释放。');
    if (!trustedSender(api, sender)) throw fail('NETWORK_SENDER_DENIED', '只有当前扩展侧栏可以管理接口读取。');
  }

  function identify(message, sender) {
    assertSender(sender);
    if (!safeToken(message?.sessionId) || !safeToken(message?.cancelToken)) {
      throw fail('NETWORK_SESSION_INVALID', '接口读取缺少有效的任务身份。');
    }
    return { key: message.sessionId, owner: ownerKey(sender) };
  }

  function check(session) {
    if (session.controller.signal.aborted) throw session.controller.signal.reason;
    if (disposed || sessions.get(session.id) !== session || byTab.get(session.target.tabId) !== session) {
      throw fail('NETWORK_SESSION_EXPIRED', '接口读取任务已失效。');
    }
    if (Date.now() >= session.expiresAt) throw fail('NETWORK_CAPTURE_COMPLETE', '本次接口监听时间已结束。');
    const binding = bindings.get(session.id);
    if (!binding || binding.port !== session.port || binding.closed) throw fail('NETWORK_PANEL_CLOSED', '接口读取侧栏已关闭。');
  }

  async function wait(session, operation) {
    check(session);
    const result = await awaitWithTimeout(Promise.resolve().then(() => { check(session); return operation(); }), {
      signal: session.controller.signal,
      timeoutMs: Math.min(ioTimeoutMs, Math.max(1, session.expiresAt - Date.now())),
      message: '接口读取校验或响应等待超时。',
    });
    check(session);
    return result;
  }

  async function actualTarget(target, verify = () => {}) {
    const tab = await api.tabs.get(target.tabId);
    verify();
    assertPageTarget({ tabId: target.tabId, expectedUrl: target.expectedUrl }, { tabId: tab.id, expectedUrl: tab.url });
    const results = await api.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      injectImmediately: true,
      func: () => ({ url: globalThis.location.href }),
    });
    verify();
    const main = results?.find(result => result.frameId === 0);
    if (!main) throw fail('PAGE_CHANGED', '原页面文档已变化，接口读取已结束。');
    const observed = { tabId: target.tabId, expectedUrl: main.result?.url, documentId: main.documentId };
    assertPageTarget(target, observed);
    return observed;
  }

  const getGrant = options.getGrant || ((url, config) => getNetworkReadingGrant(url, {
    ...config, storage: api.storage.local, timeoutMs: ioTimeoutMs,
  }));

  async function validate(session) {
    const grant = await wait(session, () => getGrant(session.target.expectedUrl, { signal: session.controller.signal }));
    if (!grant?.allowed || grant.origin !== session.origin) {
      throw fail('NETWORK_PERMISSION_DENIED', '该站点尚未允许接口读取，或授权已关闭。');
    }
    const observed = await wait(session, () => (options.getTarget || actualTarget)(session.target, () => check(session)));
    assertPageTarget(session.target, observed);
    check(session);
  }

  /** Reusing an existing response still requires a fresh background permission and document check. */
  async function validateGrant(message, sender) {
    assertSender(sender);
    const target = targetOf(message);
    const origin = networkReadingOrigin(target.expectedUrl);
    const controller = new AbortController();
    const boundary = { target, origin, controller };
    const deadline = Date.now() + ioTimeoutMs;
    const timer = setTimeout(() => controller.abort(fail('NETWORK_VALIDATION_TIMEOUT', '核验接口读取授权超时。')), ioTimeoutMs);
    const verify = () => {
      controller.signal.throwIfAborted();
      if (disposed) throw fail('NETWORK_SERVICE_DISPOSED', '接口读取服务已释放。');
      if (Date.now() >= deadline) throw fail('NETWORK_VALIDATION_TIMEOUT', '核验接口读取授权超时。');
    };
    const read = async operation => {
      verify();
      const result = await awaitWithAbort(Promise.resolve().then(() => { verify(); return operation(); }), controller.signal);
      verify();
      return result;
    };
    validations.add(boundary);
    try {
      const grant = await read(() => getGrant(target.expectedUrl, { signal: controller.signal }));
      if (!grant?.allowed || grant.origin !== origin) throw fail('NETWORK_PERMISSION_DENIED', '该站点尚未允许接口读取，或授权已关闭。');
      const observed = await read(() => (options.getTarget || actualTarget)(target, verify));
      assertPageTarget(target, observed);
      verify();
      return { allowed: true, origin, target: { ...observed } };
    } finally {
      clearTimeout(timer);
      validations.delete(boundary);
      controller.abort(fail('NETWORK_VALIDATION_FINISHED', '接口读取授权核验已结束。'));
    }
  }

  function snapshot(session) {
    return {
      sessionId: session.id,
      status: session.status,
      reason: session.reason || '',
      target: { ...session.target },
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      records: session.records.map(record => ({ ...record })),
      truncated: session.truncated,
      redactions: session.records.reduce((sum, record) => sum + record.redactions, 0),
      missedEarlierRequests: true,
    };
  }

  function end(session, reason = 'NETWORK_CANCELLED', { complete = false, retain = false } = {}) {
    if (session.status === 'stopped' || session.status === 'complete') {
      if (!retain) session.records.length = 0;
      return session.cleanup || Promise.resolve();
    }
    session.status = complete ? 'complete' : 'stopped';
    session.reason = reason;
    session.controller.abort(fail(reason, complete ? '本次接口监听时间已结束。' : '本次接口读取已结束。'));
    clearTimeout(session.timer);
    session.pending.clear();
    if (!retain) session.records.length = 0;
    if (byTab.get(session.target.tabId) === session) byTab.delete(session.target.tabId);
    session.cleanup = Promise.resolve(session.lease?.release()).catch(() => {});
    return session.cleanup;
  }

  function ownedSession(message, sender) {
    const identity = identify(message, sender);
    const session = sessions.get(identity.key);
    if (!session || session.owner !== identity.owner || session.cancelToken !== message.cancelToken) {
      throw fail('NETWORK_SESSION_EXPIRED', '接口读取任务不存在或不属于当前侧栏。');
    }
    assertPageTarget(session.target, targetOf(message));
    return session;
  }

  async function start(message, sender) {
    const identity = identify(message, sender);
    const target = targetOf(message);
    const binding = bindings.get(identity.key);
    if (!binding || binding.owner !== identity.owner || binding.cancelToken !== message.cancelToken || binding.closed) {
      throw fail('NETWORK_PORT_REQUIRED', '接口读取需要保持当前侧栏连接。');
    }
    const previous = sessions.get(identity.key);
    if (previous) { ownedSession(message, sender); return snapshot(previous); }
    if (byTab.has(target.tabId)) throw fail('NETWORK_DEBUGGER_BUSY', '此页面已有接口读取任务。');
    // Retain only a small number of completed, sanitized results for callers collecting them.
    for (const [id, old] of sessions) {
      if (sessions.size < 16) break;
      if (old.status === 'stopped' || old.status === 'complete') sessions.delete(id);
    }
    if (sessions.size >= 16) throw fail('NETWORK_SESSION_LIMIT', '同时读取的页面过多，请先结束已有任务。');
    const session = {
      id: identity.key, owner: identity.owner, cancelToken: message.cancelToken,
      target, origin: networkReadingOrigin(target.expectedUrl), port: binding.port,
      controller: new AbortController(), status: 'starting', reason: '',
      startedAt: Date.now(), expiresAt: Date.now() + Math.min(durationMs, NETWORK_READING_LIMITS.maxDurationMs),
      records: [], chars: 0, pending: new Map(), seen: new Set(), truncated: false,
      queue: Promise.resolve(), queued: 0,
    };
    sessions.set(session.id, session);
    byTab.set(target.tabId, session);
    session.timer = setTimeout(() => { end(session, 'NETWORK_CAPTURE_COMPLETE', { complete: true, retain: true }); }, Math.max(1, session.expiresAt - Date.now()));
    try {
      await validate(session);
      session.lease = await wait(session, () => coordinator.acquire(target, { signal: session.controller.signal }).then(lease => {
        session.lease = lease;
        if (session.controller.signal.aborted) { lease.release(); throw session.controller.signal.reason; }
        return lease;
      }));
      await validate(session);
      const tree = await wait(session, () => session.lease.sendCommand('Page.getFrameTree'));
      const frame = tree?.frameTree?.frame;
      let frameUrl;
      try { frameUrl = new URL(frame?.url); if (frame.urlFragment) frameUrl.hash = frame.urlFragment; } catch { /* Fail identity below. */ }
      if (!frame?.id || frameUrl?.href !== new URL(target.expectedUrl).href) {
        throw fail('PAGE_CHANGED', '页面文档变化，无法开始接口读取。');
      }
      session.frameId = frame.id;
      session.loaderId = frame.loaderId || '';
      session.status = 'listening';
      await wait(session, () => session.lease.sendCommand('Network.enable', {
        maxTotalBufferSize: NETWORK_READING_LIMITS.maxResponseBytes * 8,
        maxResourceBufferSize: NETWORK_READING_LIMITS.maxResponseBytes,
        maxPostDataSize: 0,
      }));
      await validate(session);
      return snapshot(session);
    } catch (error) {
      await end(session, error.code || error.name || 'NETWORK_CAPTURE_FAILED');
      throw error;
    }
  }

  async function read(message, sender) {
    const session = ownedSession(message, sender);
    if (session.status === 'stopped') {
      throw fail(session.reason || 'NETWORK_SESSION_EXPIRED', '本次接口读取已结束，请重新开始读取。');
    }
    if (session.status === 'listening' || session.status === 'starting') {
      try { await validate(session); }
      catch (error) { await end(session, error.code || 'NETWORK_CAPTURE_FAILED'); throw error; }
    } else if (session.status === 'complete') {
      try {
        const deadline = Date.now() + ioTimeoutMs;
        const verify = () => {
          if (Date.now() >= deadline) throw new DOMException('核验接口读取结果超时。', 'TimeoutError');
          if (disposed || sessions.get(session.id) !== session || !bindings.has(session.id) || session.status !== 'complete') {
            throw fail('NETWORK_SESSION_EXPIRED', '接口读取任务已失效。');
          }
        };
        verify();
        const grant = await awaitWithTimeout(getGrant(session.target.expectedUrl, {}), { timeoutMs: ioTimeoutMs });
        verify();
        if (!grant?.allowed || grant.origin !== session.origin) throw fail('NETWORK_PERMISSION_DENIED', '接口读取授权已关闭。');
        const observed = await awaitWithTimeout((options.getTarget || actualTarget)(session.target, verify), { timeoutMs: Math.max(1, deadline - Date.now()) });
        verify();
        assertPageTarget(session.target, observed);
      } catch (error) { session.records.length = 0; throw error; }
    }
    return snapshot(session);
  }

  async function stop(message, sender) {
    const session = ownedSession(message, sender);
    await end(session, 'NETWORK_CANCELLED');
    return snapshot(session);
  }

  async function capture(session, metadata) {
    let phase = 'validate';
    try {
      if (session.records.length >= NETWORK_READING_LIMITS.maxRecords || session.chars >= NETWORK_READING_LIMITS.maxTotalChars) {
        session.truncated = true;
        return;
      }
      await validate(session);
      phase = 'body';
      const response = await wait(session, () => session.lease.sendCommand('Network.getResponseBody', { requestId: metadata.requestId }));
      phase = 'validate';
      await validate(session);
      phase = 'sanitize';
      let body = response?.body;
      if (response?.base64Encoded) {
        if (typeof body !== 'string' || body.length > Math.ceil(NETWORK_READING_LIMITS.maxResponseBytes / 3) * 4) {
          throw fail('NETWORK_RESPONSE_LIMIT', '接口响应超过读取大小限制。');
        }
        body = new TextDecoder().decode(Uint8Array.from(atob(body), character => character.charCodeAt(0)));
      }
      const result = sanitizeNetworkJson(body, { maxChars: Math.min(NETWORK_READING_LIMITS.maxRecordChars, NETWORK_READING_LIMITS.maxTotalChars - session.chars) });
      check(session);
      session.records.push({
        sourceUrl: metadata.sourceUrl, mimeType: metadata.mimeType, statusCode: metadata.statusCode,
        capturedAt: Date.now(), ...result,
      });
      session.chars += result.text.length;
      session.truncated ||= result.truncated;
    } catch (error) {
      if (session.controller.signal.aborted) return;
      if (['NETWORK_RESPONSE_LIMIT', 'NETWORK_RESPONSE_FORMAT'].includes(error.code)) { session.truncated = true; return; }
      // An unavailable/evicted body is an explicit gap, not a request to fetch it again.
      if (phase === 'validate' || error.code === 'PAGE_CHANGED' || error.code === 'NETWORK_PERMISSION_DENIED' || error.name === 'TimeoutError') {
        await end(session, error.code || 'NETWORK_RESPONSE_TIMEOUT');
      } else { session.truncated = true; }
    }
  }

  function onEvent(source, method, parameters = {}) {
    const session = byTab.get(source.tabId);
    if (!session || session.status !== 'listening' || source.sessionId) return;
    try { check(session); } catch { return; }
    if (method === 'Network.responseReceived') {
      const response = parameters.response;
      const id = parameters.requestId;
      if (!response || typeof id !== 'string' || id.length > 160 || session.seen.has(id)
        || !['Fetch', 'XHR'].includes(parameters.type) || parameters.frameId !== session.frameId
        || (session.loaderId && parameters.loaderId && parameters.loaderId !== session.loaderId)
        || networkReadingOrigin(response.url) !== session.origin
        || !/^(?:application|text)\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.mimeType || '')) return;
      if (response.encodedDataLength > NETWORK_READING_LIMITS.maxResponseBytes
        || session.pending.size >= 12 || session.seen.size >= 64
        || session.records.length + session.queued >= NETWORK_READING_LIMITS.maxRecords) {
        session.truncated = true; return;
      }
      session.seen.add(id);
      session.pending.set(id, {
        requestId: id, sourceUrl: networkResponseSource(response.url),
        mimeType: String(response.mimeType).slice(0, 80), statusCode: Number(response.status) || 0,
      });
    } else if (method === 'Network.loadingFinished') {
      const metadata = session.pending.get(parameters.requestId);
      if (!metadata) return;
      session.pending.delete(parameters.requestId);
      if (parameters.encodedDataLength > NETWORK_READING_LIMITS.maxResponseBytes
        || session.records.length + session.queued >= NETWORK_READING_LIMITS.maxRecords) {
        session.truncated = true; return;
      }
      session.queued += 1;
      session.queue = session.queue.then(() => capture(session, metadata)).finally(() => { session.queued -= 1; });
      session.queue.catch(() => {});
    } else if (method === 'Network.loadingFailed') {
      if (session.pending.delete(parameters.requestId)) session.truncated = true;
    }
  }

  function onDetach(source) {
    const session = byTab.get(source.tabId);
    if (session) end(session, 'NETWORK_DEBUGGER_DETACHED');
  }
  function onUpdated(tabId, change) {
    const session = byTab.get(tabId);
    if (session && (change.status === 'loading' || (change.url && change.url !== session.target.expectedUrl))) end(session, 'PAGE_CHANGED');
    for (const boundary of validations) {
      if (boundary.target.tabId === tabId && (change.status === 'loading' || (change.url && change.url !== boundary.target.expectedUrl))) {
        boundary.controller.abort(fail('PAGE_CHANGED', '原页面已变化，不能复用接口数据。'));
      }
    }
  }
  function onRemoved(tabId) {
    const session = byTab.get(tabId);
    if (session) end(session, 'NETWORK_TAB_CLOSED');
    for (const boundary of validations) {
      if (boundary.target.tabId === tabId) boundary.controller.abort(fail('PAGE_CHANGED', '原页面已关闭，不能复用接口数据。'));
    }
  }
  function onStorage(changes, area) {
    if (area !== 'local' || !changes[NETWORK_READING_SETTINGS_KEY]) return;
    let settings;
    try { settings = normalizeNetworkReadingSettings(changes[NETWORK_READING_SETTINGS_KEY].newValue); } catch { settings = null; }
    for (const session of sessions.values()) {
      if (!settings?.origins[session.origin]?.allowed) end(session, 'NETWORK_PERMISSION_DENIED');
    }
    for (const boundary of validations) {
      if (!settings?.origins[boundary.origin]?.allowed) boundary.controller.abort(fail('NETWORK_PERMISSION_DENIED', '接口读取授权已关闭。'));
    }
  }

  function onConnect(port) {
    if (port.name !== NETWORK_READING_PORT) return;
    if (disposed || !trustedSender(api, port.sender)) { port.disconnect(); return; }
    ports.add(port);
    let binding;
    const bindTimer = setTimeout(() => port.disconnect(), ioTimeoutMs);
    const onMessage = message => {
      if (message?.type !== 'NETWORK_READING_BIND' || binding) return;
      try {
        const identity = identify(message, port.sender);
        if (bindings.has(identity.key) || sessions.has(identity.key)) throw fail('NETWORK_SESSION_INVALID', '接口读取任务身份已经使用。');
        binding = { id: identity.key, owner: identity.owner, cancelToken: message.cancelToken, port, closed: false };
        bindings.set(binding.id, binding);
        clearTimeout(bindTimer);
        port.postMessage({ type: 'NETWORK_READING_BOUND', sessionId: binding.id });
      } catch (error) {
        const code = error.code || 'NETWORK_BIND_FAILED';
        port.postMessage({ type: 'NETWORK_READING_BIND_ERROR', sessionId: message.sessionId,
          error: code, code, message: error.message || '接口读取连接建立失败。' });
        port.disconnect();
      }
    };
    const onDisconnect = () => {
      clearTimeout(bindTimer);
      ports.delete(port);
      if (binding) {
        binding.closed = true;
        if (bindings.get(binding.id) === binding) bindings.delete(binding.id);
        const session = sessions.get(binding.id);
        if (session?.port === port) end(session, 'NETWORK_PANEL_CLOSED');
      }
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  }

  const listeners = [
    [api.debugger.onEvent, onEvent], [api.debugger.onDetach, onDetach],
    [api.tabs.onUpdated, onUpdated], [api.tabs.onRemoved, onRemoved],
    [api.storage.onChanged, onStorage], [api.runtime.onConnect, onConnect],
  ];
  for (const [event, listener] of listeners) event?.addListener(listener);

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const boundary of validations) boundary.controller.abort(fail('NETWORK_SERVICE_DISPOSED', '接口读取服务已释放。'));
    validations.clear();
    for (const [event, listener] of listeners) event?.removeListener(listener);
    const pending = [...sessions.values()].map(session => end(session, 'NETWORK_SERVICE_DISPOSED'));
    for (const port of ports) port.disconnect();
    ports.clear();
    bindings.clear();
    await Promise.allSettled(pending);
    sessions.clear();
  }
  return { start, read, stop, validateGrant, dispose };
}

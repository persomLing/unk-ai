import { awaitWithAbort, awaitWithTimeout } from '../utils/abortable.js';

const MAX_TIMEOUT_MS = 60000;

function duration(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_TIMEOUT_MS, value) : fallback;
}

export class CapabilityUnavailableError extends Error {
  constructor(id, label, status, cause) {
    const reason = status === 'disabled' ? '已停用'
      : status === 'initializing' ? '仍在初始化'
        : status === 'disposed' ? '已关闭' : '初始化失败';
    super(`${label}暂不可用：${reason}${cause?.message ? `（${cause.message}）` : ''}。`, { cause });
    this.name = 'CapabilityUnavailableError';
    this.code = 'CAPABILITY_UNAVAILABLE';
    this.capabilityId = id;
    this.status = status;
  }
}

/**
 * Owns one application-lifetime instance of each trusted capability. A failed
 * optional factory cannot reject the application bootstrap. Factories acquire
 * resources through onCleanup and must check signal before acquiring more after
 * an await. This cannot preempt synchronous code or sandbox arbitrary scripts.
 */
export function createCapabilityHost({
  signal,
  initializationTimeoutMs = 3000,
  cleanupTimeoutMs = 1000,
  now = Date.now,
} = {}) {
  const records = new Map();
  const initLimit = duration(initializationTimeoutMs, 3000);
  const cleanupLimit = duration(cleanupTimeoutMs, 1000);
  let disposed = false;
  let disposal = null;

  function recordFor(id) {
    const record = records.get(id);
    if (!record) throw new Error(`Unknown capability: ${id}`);
    return record;
  }

  function snapshot(record) {
    return Object.freeze({
      id: record.id,
      status: record.status,
      ...(record.error ? { error: Object.freeze({ code: record.error.code || record.error.name || 'CAPABILITY_INIT_FAILED', message: record.error.message || String(record.error) }) } : {}),
    });
  }

  function clean(record, callback) {
    if (record.cleanedCallbacks.has(callback)) return;
    record.cleanedCallbacks.add(callback);
    let pending;
    try { pending = callback(); }
    catch { return; }
    const settled = awaitWithTimeout(Promise.resolve(pending), {
      timeoutMs: cleanupLimit, message: `${record.label}清理超时。`,
    }).catch(() => {});
    record.pendingCleanups.add(settled);
    void settled.then(() => record.pendingCleanups.delete(settled));
  }

  function cleanAll(record) {
    record.cleanupStarted = true;
    // Invoke all callbacks even when an earlier cleanup throws or never settles.
    for (const callback of record.cleanups.splice(0).reverse()) clean(record, callback);
    return Promise.allSettled([...record.pendingCleanups]);
  }

  function end(record, status, error) {
    if (record.status === 'disposed') return;
    record.status = status;
    record.error = error || null;
    clearTimeout(record.timer);
    if (!record.controller.signal.aborted) record.controller.abort(error || new DOMException('能力已关闭。', 'AbortError'));
    void cleanAll(record);
    record.resolveReady(snapshot(record));
  }

  function add({ id, label = id, enabled = true, create, validate = () => {}, timeoutMs } = {}) {
    if (disposed || signal?.aborted) throw new DOMException('能力宿主已关闭。', 'AbortError');
    if (typeof id !== 'string' || !id.trim() || id !== id.trim()) throw new TypeError('Capability id is required.');
    if (records.has(id)) throw new Error(`Capability already registered: ${id}`);
    if (typeof create !== 'function') throw new TypeError(`Capability ${id} requires a factory.`);
    const controller = new AbortController();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const record = {
      id, label, status: enabled ? 'initializing' : 'disabled', error: null,
      implementation: null, controller, ready, resolveReady, timer: null,
      cleanups: [], cleanedCallbacks: new Set(), pendingCleanups: new Set(), cleanupStarted: false,
    };
    records.set(id, record);
    if (!enabled) {
      resolveReady(snapshot(record));
      return snapshot(record);
    }
    const limit = duration(timeoutMs, initLimit);
    const deadlineAt = now() + limit;
    function onCleanup(callback) {
      if (typeof callback !== 'function') throw new TypeError('Cleanup must be a function.');
      if (record.cleanupStarted) clean(record, callback);
      else if (!record.cleanups.includes(callback)) record.cleanups.push(callback);
    }
    const lifetime = Object.freeze({ signal: controller.signal, deadlineAt, onCleanup });
    const fail = error => {
      if (record.status !== 'initializing') return;
      end(record, 'failed', error instanceof Error ? error : new Error(String(error)));
    };
    const complete = implementation => {
      if (implementation && typeof implementation.dispose === 'function') {
        const disposeMethod = implementation.dispose;
        onCleanup(() => disposeMethod.call(implementation));
      }
      if (record.status !== 'initializing') return;
      try {
        controller.signal.throwIfAborted();
        if (now() >= deadlineAt) throw new DOMException(`${label}初始化超时。`, 'TimeoutError');
        if (!implementation || typeof implementation !== 'object' || Array.isArray(implementation)) {
          throw new TypeError(`${label}没有返回有效的能力实现。`);
        }
        validate(implementation);
        record.implementation = Object.freeze(implementation);
        record.status = 'ready';
        clearTimeout(record.timer);
        resolveReady(snapshot(record));
      } catch (error) { fail(error); }
    };
    record.timer = setTimeout(() => fail(new DOMException(`${label}初始化超时。`, 'TimeoutError')), limit);
    try {
      const result = create(lifetime);
      // Keep current synchronous factories immediately available to UI commands.
      if (result && typeof result.then === 'function') Promise.resolve(result).then(complete, fail).catch(fail);
      else complete(result);
    } catch (error) { fail(error); }
    return snapshot(record);
  }

  function get(id) {
    const record = recordFor(id);
    if (record.status !== 'ready') throw new CapabilityUnavailableError(id, record.label, record.status, record.error);
    return record.implementation;
  }

  async function requireCapability(id, { signal: callerSignal, deadlineAt } = {}) {
    callerSignal?.throwIfAborted();
    if (Number.isFinite(deadlineAt) && deadlineAt <= now()) throw new DOMException('等待能力初始化超时。', 'TimeoutError');
    const record = recordFor(id);
    if (Number.isFinite(deadlineAt)) {
      await awaitWithTimeout(record.ready, { signal: callerSignal, timeoutMs: Math.max(1, deadlineAt - now()), message: '等待能力初始化超时。' });
    } else await awaitWithAbort(record.ready, callerSignal);
    callerSignal?.throwIfAborted();
    return get(id);
  }

  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    signal?.removeEventListener('abort', onAbort);
    for (const record of records.values()) end(record, 'disposed', signal?.reason);
    disposal = Promise.allSettled([...records.values()].map(record => cleanAll(record))).then(() => {});
    return disposal;
  }

  function onAbort() { void dispose(); }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) void dispose();

  return Object.freeze({
    add,
    get,
    require: requireCapability,
    signal: id => recordFor(id).controller.signal,
    status: id => snapshot(recordFor(id)),
    statuses: () => [...records.values()].map(snapshot),
    ready: () => Promise.all([...records.values()].map(record => record.ready)),
    dispose,
  });
}

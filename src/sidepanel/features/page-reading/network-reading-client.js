import { awaitWithAbort, awaitWithTimeout } from '../../../utils/abortable.js';
import { pageTargetFields, assertPageTarget } from '../../../utils/page-target.js';

const networkError = (message, code = 'NETWORK_READING_FAILED') => Object.assign(new Error(message), { code });

/** The port owns the capture lifetime; disconnection also cleans up on sidebar close. */
export function createNetworkReadingClient({ connect, sendMessage, createId = () => crypto.randomUUID(),
  captureMs = 3000, timeoutMs = 12000 } = {}) {
  const active = new Set();
  let disposed = false;
  async function capture(target, { signal, timeoutMs: requestedTimeout = timeoutMs } = {}) {
    if (disposed) throw new DOMException('接口读取已释放。', 'AbortError');
    signal?.throwIfAborted();
    const identity = pageTargetFields(target);
    if (!Number.isInteger(identity.tabId) || !identity.expectedUrl || !identity.documentId) {
      throw networkError('无法确认接口读取的页面身份。', 'PAGE_CHANGED');
    }
    const controller = new AbortController();
    active.add(controller);
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const deadline = setTimeout(() => controller.abort(new DOMException('接口读取超时。', 'TimeoutError')),
      Math.max(1, Math.min(timeoutMs, requestedTimeout)));
    const message = { ...identity, sessionId: createId(), cancelToken: createId() };
    let port, onMessage, onDisconnect, windowTimer, captured;
    const check = () => controller.signal.throwIfAborted();
    const request = async type => {
      check();
      const result = await awaitWithAbort(Promise.resolve().then(() => {
        check();
        return sendMessage({ ...message, type });
      }), controller.signal);
      check();
      if (result?.error) throw networkError(result.message || '接口读取失败。', result.code || result.error);
      if (!result || result.sessionId !== message.sessionId) throw networkError('接口读取返回了无效任务。');
      if (result.status === 'stopped') throw networkError('本次接口读取已结束。', result.reason || 'NETWORK_READING_STOPPED');
      return result;
    };
    try {
      check();
      port = connect({ name: 'unk-ai-network-reading' });
      const bound = new Promise((resolve, reject) => {
        onMessage = result => {
          if (result?.sessionId !== message.sessionId) return;
          if (result.error) {
            const error = networkError(result.message || '无法建立接口读取连接。', result.error);
            controller.abort(error);
            reject(error);
          }
          else if (result.type === 'NETWORK_READING_BOUND') resolve();
        };
        onDisconnect = () => controller.abort(networkError('接口读取连接已断开。', 'NETWORK_READING_DISCONNECTED'));
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);
        port.postMessage({ type: 'NETWORK_READING_BIND', sessionId: message.sessionId, cancelToken: message.cancelToken });
      });
      await awaitWithAbort(bound, controller.signal);
      await request('NETWORK_READING_START');
      check();
      await awaitWithAbort(new Promise(resolve => { windowTimer = setTimeout(resolve, Math.max(1, Math.min(3000, captureMs))); }), controller.signal);
      const result = await request('NETWORK_READING_READ');
      assertPageTarget(identity, result.target);
      captured = result;
    } finally {
      clearTimeout(deadline);
      clearTimeout(windowTimer);
      signal?.removeEventListener('abort', cancel);
      active.delete(controller);
      port?.onMessage.removeListener(onMessage);
      port?.onDisconnect.removeListener(onDisconnect);
      // On success, wait briefly for detach before the next screenshot/deep read.
      // Cancellation still releases the local wait immediately; the port is the lifetime guard.
      if (port) {
        const stop = Promise.resolve().then(() => sendMessage({ ...message, type: 'NETWORK_READING_STOP' }));
        stop.catch(() => {});
        try {
          if (!controller.signal.aborted) await awaitWithTimeout(stop, { signal, timeoutMs: 1800, message: '释放接口读取连接超时。' });
        } catch { /* Disconnect below also ends the original session. */ }
        finally { port.disconnect(); }
      }
      controller.abort(new DOMException('本轮接口读取结束。', 'AbortError'));
    }
    signal?.throwIfAborted();
    if (disposed) throw new DOMException('接口读取已关闭。', 'AbortError');
    return captured;
  }
  return Object.freeze({ capture, dispose() {
    disposed = true;
    for (const controller of active) controller.abort(new DOMException('接口读取已关闭。', 'AbortError'));
    active.clear();
  } });
}

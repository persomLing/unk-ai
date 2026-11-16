import { VIDEO_READING_PORT, VIDEO_LIMITS, videoError, videoTarget } from './video-request.js';

/** The port is the cancellation lease; closing the sidepanel also disconnects it. */
export function readVideoTranscript(connect, target, { signal, deadlineAt, runId, conversationId, turnId } = {}) {
  signal?.throwIfAborted();
  if (typeof connect !== 'function') throw videoError('VIDEO_READER_UNAVAILABLE', '视频字幕读取不可用，请重新打开扩展侧栏。');
  const requestId = 'video-' + crypto.randomUUID();
  const fixedTarget = videoTarget(target);
  return new Promise((resolve, reject) => {
    let port, timer, finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      port?.onMessage.removeListener(message); port?.onDisconnect.removeListener(disconnected);
      try { port?.disconnect(); } catch {}
      callback(value);
    };
    const cancel = () => finish(reject, signal.reason || new DOMException('视频字幕读取已停止。', 'AbortError'));
    const disconnected = () => finish(reject, videoError('VIDEO_CONNECTION_CLOSED', '字幕读取连接已中断，请重试。'));
    const message = response => {
      if (response?.requestId !== requestId) return;
      if (response.error) finish(reject, videoError(response.error, response.message || '字幕读取失败。'));
      else finish(resolve, response.result);
    };
    try {
      port = connect({ name: VIDEO_READING_PORT });
      port.onMessage.addListener(message); port.onDisconnect.addListener(disconnected);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => finish(reject, new DOMException('视频字幕读取超时，请重试。', 'TimeoutError')),
        Math.max(1, Math.min(VIDEO_LIMITS.timeoutMs + 1000, (deadlineAt || Infinity) - Date.now())));
      port.postMessage({ type: 'read', requestId, runId, conversationId, turnId, target: fixedTarget, deadlineAt });
    } catch (error) { finish(reject, error); }
  });
}

import { VIDEO_NAVIGATION_PORT, VIDEO_NAVIGATION_TIMEOUT_MS, captureVideoNavigation } from './video-navigation-request.js';
import { videoError } from './video-request.js';

/** One bounded time/title click. A seek response cannot silently become open. */
export function navigateVideoTimestamp(connect, input, { signal } = {}) {
  signal?.throwIfAborted();
  const request = captureVideoNavigation(input), requestId = 'video-seek-' + crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let port, timer, finished = false;
    const finish = (callback, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      port?.onMessage.removeListener(message); port?.onDisconnect.removeListener(disconnected);
      try { port?.disconnect(); } catch {}
      callback(result);
    };
    const cancel = () => finish(reject, signal.reason || new DOMException('视频定位已取消。', 'AbortError'));
    const disconnected = () => finish(reject, videoError('VIDEO_NAVIGATION_UNCERTAIN', '视频定位连接已中断，请先核对播放器位置。'));
    const message = response => {
      if (response?.requestId !== requestId) return;
      if (response.error) finish(reject, videoError(response.error, response.message || '视频定位失败。'));
      else if (!Number.isInteger(response.result?.tabId)
        || (request.action === 'seek' ? response.result.outcome !== 'seeked' || response.result.startMs !== request.startMs
          : !['focused', 'opened'].includes(response.result.outcome))) {
        finish(reject, videoError('VIDEO_NAVIGATION_UNCERTAIN', '无法确认视频定位结果，请先核对播放器位置。'));
      } else finish(resolve, response.result);
    };
    try {
      port = connect({ name: VIDEO_NAVIGATION_PORT });
      port.onMessage.addListener(message); port.onDisconnect.addListener(disconnected);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => finish(reject, videoError('VIDEO_NAVIGATION_UNCERTAIN',
        '视频定位等待超时，请先核对播放器位置；不会自动重复定位。')), VIDEO_NAVIGATION_TIMEOUT_MS + 1000);
      port.postMessage({ ...request, type: 'navigate', requestId, deadlineAt: Date.now() + VIDEO_NAVIGATION_TIMEOUT_MS });
    } catch (error) { finish(reject, error); }
  });
}

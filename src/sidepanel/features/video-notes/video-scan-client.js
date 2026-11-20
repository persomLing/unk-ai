import { videoError } from './video-request.js';
import { FRAME_SCAN, VIDEO_SCAN_PORT, VIDEO_STILL_TIMEOUT_MS, validateScanBlock, captureVideoStillRequest,
  validateVideoStill } from './video-scan-protocol.js';
import { createFrameSelection } from './frame-dedup.js';

export function scanVideoPage(connect, offer, { signal, deadlineAt, runId, conversationId, turnId, previous, onProgress } = {}) {
  signal?.throwIfAborted();
  if (typeof connect !== 'function') throw videoError('VIDEO_SCAN_UNAVAILABLE', '画面扫描不可用，请重新打开扩展侧栏。');
  const requestId = 'scan-' + crypto.randomUUID();
  const durationMs = Math.round(offer.video.duration * 1000);
  const selection = createFrameSelection(durationMs, { previous });
  return new Promise((resolve, reject) => {
    let port, timer, finished = false;
    let scannedMs = previous?.scannedMs || 0, quality = previous?.quality, resolution = previous?.resolution;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      port?.onMessage.removeListener(message); port?.onDisconnect.removeListener(disconnected);
      try { port?.disconnect(); } catch {}
      callback(value);
    };
    const done = status => finish(resolve, { status, ...selection.snapshot(), scannedMs, quality, resolution });
    const cancel = () => finish(reject, signal.reason || new DOMException('画面扫描已停止。', 'AbortError'));
    const disconnected = () => done('interrupted');
    const message = response => {
      if (response?.requestId !== requestId || finished) return;
      try {
        signal?.throwIfAborted();
        if (response.type === 'error') { finish(reject, videoError(response.code, response.message)); return; }
        if (response.type === 'done' && ['complete', 'interrupted', 'timeout', 'limited'].includes(response.status)) {
          if (response.scannedMs !== scannedMs) throw videoError('VIDEO_SCAN_INVALID', '分片进度不一致，未使用未确认的帧。');
          done(response.status); return;
        }
        const block = response.type === 'block' && validateScanBlock(response, scannedMs, durationMs);
        if (!block || !Number.isInteger(response.quality) || (quality && quality !== response.quality)
          || !/^\d{2,4}×\d{2,4}$/.test(response.resolution)) throw videoError('VIDEO_SCAN_INVALID', '画面扫描结果不有效，已停止。');
        for (const sample of block.samples) selection.add(sample);
        scannedMs = block.scannedMs; quality = response.quality; resolution = response.resolution;
        onProgress?.({ scannedMs, durationMs, retained: selection.snapshot().frames.length });
        signal?.throwIfAborted();
        port.postMessage({ type: 'ack', requestId, scannedMs });
      } catch (error) { finish(reject, error); }
    };
    try {
      port = connect({ name: VIDEO_SCAN_PORT });
      port.onMessage.addListener(message); port.onDisconnect.addListener(disconnected);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => done('timeout'), Math.max(1, Math.min(FRAME_SCAN.scanMs + 1000, deadlineAt - Date.now())));
      port.postMessage({ type: 'scan', requestId, deadlineAt, runId, conversationId, turnId, offer,
        resume: Boolean(previous), startMs: scannedMs, ...(quality ? { quality } : {}) });
    } catch (error) { finish(reject, error); }
  });
}

export function captureVideoStill(connect, input, { signal } = {}) {
  signal?.throwIfAborted();
  const request = captureVideoStillRequest(input);
  const requestId = 'still-' + crypto.randomUUID();
  const deadlineAt = Date.now() + VIDEO_STILL_TIMEOUT_MS;
  if (typeof connect !== 'function') throw videoError('VIDEO_SCAN_UNAVAILABLE', '画面解码不可用，请重新打开扩展侧栏。');
  return new Promise((resolve, reject) => {
    let port, timer, finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      port?.onMessage.removeListener(message);
      port?.onDisconnect.removeListener(disconnected);
      try { port?.disconnect(); } catch {}
      callback(value);
    };
    const cancel = () => finish(reject, signal.reason || new DOMException('视频截帧已停止。', 'AbortError'));
    const disconnected = () => finish(reject, videoError('VIDEO_SCAN_HOST_LOST', '原视频页面已关闭或解码连接已中断。'));
    const message = response => {
      if (response?.requestId !== requestId || finished) return;
      if (response.type === 'error') { finish(reject, videoError(response.code, response.message)); return; }
      const result = response.type === 'frame' && validateVideoStill(response.result, request.startMs);
      if (result) finish(resolve, result);
      else finish(reject, videoError('VIDEO_SCAN_INVALID', '无法确认返回的画面时间。'));
    };
    try {
      port = connect({ name: VIDEO_SCAN_PORT });
      port.onMessage.addListener(message);
      port.onDisconnect.addListener(disconnected);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => finish(reject, videoError('VIDEO_STILL_TIMEOUT', '等待视频分片解码超时。')), VIDEO_STILL_TIMEOUT_MS + 500);
      port.postMessage({ ...request, type: 'still', requestId, deadlineAt });
    } catch (error) { finish(reject, error); }
  });
}

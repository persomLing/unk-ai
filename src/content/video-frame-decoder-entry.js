import { captureVideoStreamFrame, scanVideoFrames } from './video-frame-decoder.js';
import { VIDEO_DECODER_PORT, bilibiliHostOrigin, isScanToken } from '../sidepanel/features/video-notes/video-scan-protocol.js';
import { awaitWithAbort } from '../utils/abortable.js';

if (!globalThis.unkAiFrameDecoderInstalled && bilibiliHostOrigin(location.href)) {
  globalThis.unkAiFrameDecoderInstalled = true;
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== VIDEO_DECODER_PORT || port.sender?.id !== chrome.runtime.id || port.sender?.tab) return;
    const controller = new AbortController(), { signal } = controller;
    const origin = location.origin;
    let requestId, awaiting;
    const disconnected = () => { controller.abort(); port.onMessage.removeListener(message); };
    const message = input => {
      if (requestId) {
        if (input?.requestId === requestId && input.type === 'ack' && input.scannedMs === awaiting?.cursor) awaiting.resolve();
        return;
      }
      if (!['scan', 'still'].includes(input?.type) || !isScanToken(input.requestId)) { port.disconnect(); return; }
      requestId = input.requestId;
      const send = value => { signal.throwIfAborted(); port.postMessage({ requestId, ...value }); };
      const pending = input.type === 'still'
        ? captureVideoStreamFrame({ ...input, signal }).then(result => send({ type: 'frame', result }))
        : scanVideoFrames({ ...input, signal, onBlock: async block => {
          if (location.origin !== origin || !bilibiliHostOrigin(location.href)) { controller.abort(); throw signal.reason; }
          const ack = new Promise(resolve => { awaiting = { cursor: block.scannedMs, resolve }; });
          send({ type: 'block', ...block });
          await awaitWithAbort(ack, signal);
          awaiting = null;
        } }).then(result => send({ type: 'done', ...result }));
      void pending.catch(error => {
        if (!signal.aborted) send({ type: 'error', code: error.code || 'VIDEO_DECODE_UNSUPPORTED' });
      }).catch(() => {});
    };
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnected);
  });
}

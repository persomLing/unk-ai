import { awaitWithAbort, awaitWithTimeout } from '../../../utils/abortable.js';
import { prepareImageDataUrl } from '../../../utils/attachments.js';
import { assertPageTarget, pageTargetFields } from '../../../utils/page-target.js';
import { cropImageDataUrl } from '../../../utils/image-crop.js';
import { capturePageTarget } from '../page-reading/page-target-capture.js';
export { selectionToImageRect } from './region-selection.js';

const cancelled = () => new DOMException('页面或会话已变化，已取消添加图片。', 'AbortError');

export function attachmentInputError(kind, { agentMode = false, supportsVision = false } = {}) {
  if (kind === 'document' && agentMode) return '页面操作支持图片指示位置，暂不支持文档附件。';
  if (kind === 'image' && !supportsVision) return '当前模型未标记视觉能力，请切换到视觉模型后添加图片。';
  return '';
}

/** One owner for file decoding, screenshot capture and the region dialog. */
export function createVisualPreparation({ getOwner, onBusy }) {
  let active = null;
  return {
    cancel() { active?.controller.abort(cancelled()); if (active) { active = null; onBusy(false); } },
    start() {
      this.cancel();
      const operation = { controller: new AbortController(), owner: [...getOwner()] };
      active = operation;
      const check = () => {
        operation.controller.signal.throwIfAborted();
        const current = getOwner();
        if (active !== operation || operation.owner.some((value, index) => !Object.is(value, current[index]))) {
          operation.controller.abort(cancelled());
          throw operation.controller.signal.reason;
        }
      };
      onBusy(true);
      return {
        signal: operation.controller.signal,
        check,
        async wait(pending, timeoutMs = 15000) {
          check();
          const result = await awaitWithTimeout(pending, { signal: operation.controller.signal, timeoutMs, message: '准备图片超时，请重试。' });
          check();
          return result;
        },
        finish() { operation.controller.abort(cancelled()); if (active === operation) { active = null; onBusy(false); } },
      };
    },
  };
}

export function decodeScreenshot(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('页面截图无法解码。'));
    image.src = dataUrl;
  });
}

function geometry(value) {
  const viewport = value?.viewport;
  const scroll = value?.scroll;
  return {
    ...(Number.isFinite(viewport?.width) && viewport.width > 0 && Number.isFinite(viewport?.height) && viewport.height > 0
      ? { viewport: { width: viewport.width, height: viewport.height } } : {}),
    ...(Number.isFinite(scroll?.x) && Number.isFinite(scroll?.y) ? { scroll: { x: scroll.x, y: scroll.y } } : {}),
  };
}

/** Explicit screenshots read no page text and never follow a changed active tab. */
export async function captureManualVisual({ queryActiveTab, sendMessage, readMetrics, decodeImage = decodeScreenshot,
  now = () => new Date().toISOString(), signal, checkOwner = () => {}, timeoutMs = 15000 }) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('页面截图超时，请重试。', 'TimeoutError')), timeoutMs);
  const check = () => { controller.signal.throwIfAborted(); checkOwner(); };
  const wait = async pending => { check(); const result = await awaitWithAbort(pending, controller.signal); check(); return result; };
  try {
    check();
    const target = await wait(capturePageTarget({ queryActiveTab, sendMessage, signal: controller.signal }));
    if (!Number.isInteger(target?.id) || !/^(https?|file):/i.test(target.url || '')) throw new Error('当前页面无法截图，请切换到网页后重试。');
    const metrics = geometry(readMetrics ? await wait(readMetrics(target)) : null);
    const response = await wait(sendMessage({ type: 'CAPTURE_ACTIVE_TAB', ...pageTargetFields(target) }));
    if (response?.error) throw Object.assign(new Error(response.message || response.error), { code: response.code || response.error });
    assertPageTarget(target, response);
    const capturedAt = now();
    if (readMetrics) {
      const latest = geometry(await wait(readMetrics(target)));
      if (JSON.stringify(metrics) !== JSON.stringify(latest)) throw Object.assign(new Error('截图期间页面滚动或尺寸发生变化，请重新截图。'), { code: 'PAGE_CHANGED' });
    }
    const image = await wait(decodeImage(response.dataUrl));
    if (!(image?.width > 0 && image?.height > 0)) throw new Error('截图尺寸无效。');
    const after = await wait(capturePageTarget({ queryActiveTab, sendMessage, signal: controller.signal }));
    assertPageTarget(target, after);
    const attachment = prepareImageDataUrl(response.dataUrl, { name: '当前页截图.jpg', pageTitle: target.title || '', pageUrl: target.url, source: 'page-capture' });
    return { ...attachment, width: image.width, height: image.height, scope: 'viewport', fullPage: false,
      capture: { version: 1, tabId: target.id, url: target.url,
        ...(response.documentId ? { documentId: response.documentId } : {}), capturedAt, ...metrics,
        image: { width: image.width, height: image.height } } };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

export async function cropManualVisual(attachment, rect, { cropImage = cropImageDataUrl, decodeImage = decodeScreenshot, signal, checkOwner = () => {} } = {}) {
  const check = () => { signal?.throwIfAborted(); checkOwner(); };
  check();
  const dataUrl = await awaitWithAbort(cropImage(attachment.dataUrl, rect, { viewport: attachment.capture.image }), signal);
  check();
  const size = await awaitWithAbort(decodeImage(dataUrl), signal);
  check();
  const prepared = prepareImageDataUrl(dataUrl, { name: '页面框选.jpg', pageTitle: attachment.pageTitle, pageUrl: attachment.pageUrl, source: 'page-capture' });
  return { ...prepared, ...size, scope: 'region', fullPage: false, capture: { ...attachment.capture, crop: { ...rect } } };
}

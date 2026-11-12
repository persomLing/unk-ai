import { awaitWithTimeout } from '../../../utils/abortable.js';
import { prepareImageDataUrl } from '../../../utils/attachments.js';
import { assertPageTarget, pageTargetFields } from '../../../utils/page-target.js';
import { normalizePageSelection, pageSelectionMatches } from '../../../utils/selection.js';

/** Rewind and retry keep exact captured pixels rather than reading a new image. */
export function retainedSelectionVisuals(selection, attachments = []) {
  const selected = normalizePageSelection(selection);
  if (!selected?.visuals?.length) return [];
  const retained = attachments.filter(item => item.source === 'page-selection');
  if (!retained.length) return [];
  if (retained.length !== selected.visuals.length || retained.some((item, index) => {
    const visual = selected.visuals[index], captured = item.capture?.visual;
    return item.figureId !== visual.id || !captured || captured.id !== visual.id
      || captured.type !== visual.type || captured.src !== visual.src || item.pageUrl !== selected.url
      || (selected.documentId && item.capture?.documentId !== selected.documentId)
      || (selected.tabId != null && item.capture?.tabId !== selected.tabId);
  })) throw new Error('原选区图片记录不匹配，请重新选择图片后提问。');
  if (attachments.filter(item => item.type === 'image').length > 3 || attachments.length > 6) {
    throw new Error('本轮图片最多 3 张，请减少图片后重新发送。');
  }
  return retained;
}

/** Required selected pixels: read-only, fixed document, bounded, never replayed. */
export async function captureSelectionVisuals({ selection, target, profile, attachments = [], sendMessage,
  signal, timeoutMs = 20000 } = {}) {
  signal?.throwIfAborted();
  const selected = normalizePageSelection(selection);
  if (!selected?.visuals?.length) return [];
  if (!profile?.supportsVision) throw new Error('选区包含图片，请选择支持视觉的模型后重新发送。');
  if (attachments.filter(item => item.type === 'image').length + selected.visuals.length > 3
    || attachments.length + selected.visuals.length > 6) {
    throw new Error('本轮图片最多 3 张，请减少已上传图片或缩小网页选区后重新发送。');
  }
  const identity = pageTargetFields(target);
  if (!Number.isInteger(identity.tabId) || !identity.documentId || !identity.expectedUrl) {
    throw new Error('无法确认选区图片所在文档，请重新选择后发送。');
  }
  assertPageTarget({ ...identity, ...(selected.tabId != null ? { tabId: selected.tabId } : {}),
    ...(selected.documentId ? { documentId: selected.documentId } : {}), expectedUrl: selected.url }, identity);
  const captureToken = crypto.randomUUID();
  try {
    const response = await awaitWithTimeout(Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return sendMessage({ type: 'CAPTURE_SELECTION_VISUAL_CONTEXT', ...identity, selection: selected, captureToken });
    }), { signal, timeoutMs, message: '选区图片读取超时，请回到原页面后重试。' });
    signal?.throwIfAborted();
    if (response?.error) throw Object.assign(new Error(response.message || response.error), { code: response.code || 'SELECTION_VISUAL_FAILED' });
    assertPageTarget(identity, response);
    if (!pageSelectionMatches(selected, response.selection) || response.images?.length !== selected.visuals.length) {
      throw new Error('选区图片已变化或未完整读取，请重新选择后发送。');
    }
    let bytes = 0;
    return response.images.map((image, index) => {
      if (image.figureId !== selected.visuals[index].id || (image.pageUrl && image.pageUrl !== identity.expectedUrl)) {
        throw new Error('选区图片来源已变化，请重新选择后发送。');
      }
      const attachment = prepareImageDataUrl(image.dataUrl, {
        name: `选区图片-${index + 1}.${/^data:image\/png;/i.test(image.dataUrl) ? 'png' : 'jpg'}`, pageTitle: selected.title, pageUrl: selected.url, source: 'page-selection',
      });
      bytes += attachment.size;
      if (bytes > 8 * 1024 * 1024) throw new Error('选区图片过大，请缩小选区后重新发送。');
      return { ...attachment, figureId: image.figureId, caption: String(image.caption || selected.visuals[index].alt || selected.visuals[index].title).slice(0, 500),
        scope: 'selection', fullPage: false, capture: { version: 1, tabId: identity.tabId,
          documentId: identity.documentId, url: identity.expectedUrl,
          visual: { id: selected.visuals[index].id, type: selected.visuals[index].type, src: selected.visuals[index].src } }, truncated: image.truncated === true };
    });
  } catch (error) {
    // Cancelling a wait does not undo a screenshot already taken. Tell the
    // background to stop any remaining captures; never wait for its cleanup.
    try { Promise.resolve(sendMessage({ type: 'CANCEL_SELECTION_VISUAL_CONTEXT', captureToken })).catch(() => {}); } catch {}
    throw error;
  }
}

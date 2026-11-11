import { safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { createImagePreviewViewport } from './image-preview-viewport.js';

/** View existing attachment pixels without changing the conversation or its source. */
export function createImagePreview({ document = globalThis.document, onError = () => {},
  fallbackFocus = () => null } = {}) {
  let conversationId = null;
  let active = null;
  let disposed = false;

  function close({ restoreFocus = true } = {}) {
    const preview = active;
    if (!preview) return;
    active = null;
    preview.removers.forEach(remove => remove());
    if (preview.dialog.open) preview.dialog.close();
    preview.dialog.remove();
    preview.image.removeAttribute('src');
    if (restoreFocus) {
      const target = preview.trigger?.isConnected ? preview.trigger : fallbackFocus();
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  }

  function open({ src, name = '图片预览', trigger = document.activeElement } = {}) {
    const source = safeAttachmentDataUrl(src);
    if (disposed || !source) return false;
    close({ restoreFocus: false });
    const dialog = document.createElement('dialog');
    dialog.className = 'image-preview-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'image-preview-title');
    const header = document.createElement('div');
    header.className = 'image-preview-header';
    const heading = document.createElement('h2');
    heading.id = 'image-preview-title';
    heading.textContent = String(name || '图片预览');
    heading.title = heading.textContent;
    const controls = document.createElement('div');
    controls.className = 'image-preview-controls';
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'image-preview-zoom';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('aria-label', '缩小图片');
    zoomOut.title = '缩小图片';
    const scaleLabel = document.createElement('span');
    scaleLabel.className = 'image-preview-scale';
    scaleLabel.textContent = '—';
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'image-preview-zoom';
    zoomIn.textContent = '+';
    zoomIn.setAttribute('aria-label', '放大图片');
    zoomIn.title = '放大图片';
    const sizeButton = document.createElement('button');
    sizeButton.type = 'button';
    sizeButton.className = 'image-preview-size';
    sizeButton.textContent = '原始尺寸';
    sizeButton.setAttribute('aria-pressed', 'false');
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'image-preview-close';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', '关闭图片预览');
    closeButton.title = '关闭图片预览（Esc）';
    controls.append(zoomOut, scaleLabel, zoomIn, sizeButton, closeButton);
    header.append(heading, controls);
    const viewport = document.createElement('div');
    viewport.className = 'image-preview-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', '图片查看区域，滚轮缩放，按住拖动；方向键移动，加减键缩放，0 复位');
    const image = document.createElement('img');
    image.className = 'image-preview-image';
    image.alt = heading.textContent;
    image.draggable = false;
    viewport.append(image);
    const hint = document.createElement('p');
    hint.className = 'image-preview-hint';
    hint.textContent = '滚轮缩放 · 按住拖动 · 双击切换尺寸';
    dialog.append(header, viewport, hint);
    const preview = { dialog, image, trigger, removers: [] };
    active = preview;
    const listen = (node, type, handler) => {
      const guarded = event => { if (active === preview) handler(event); };
      node.addEventListener(type, guarded);
      preview.removers.push(() => node.removeEventListener(type, guarded));
    };
    listen(closeButton, 'click', () => close());
    listen(dialog, 'click', event => { if (event.target === dialog) close(); });
    listen(dialog, 'cancel', event => { event.preventDefault(); close(); });
    listen(dialog, 'close', () => close());
    listen(image, 'error', () => {
      close();
      onError('无法预览这张图片，请重新添加原图片。', 'error');
    });
    image.src = source;
    document.body.append(dialog);
    try {
      dialog.showModal();
      const navigation = createImagePreviewViewport({ viewport, image, sizeButton, zoomIn, zoomOut, scaleLabel });
      preview.removers.push(() => navigation.dispose());
      closeButton.focus({ preventScroll: true });
      return true;
    } catch {
      close();
      onError('无法打开图片预览，请重试。', 'error');
      return false;
    }
  }

  function previewTarget(event) {
    const target = event.target?.closest?.('img[data-image-preview]');
    return target?.isConnected ? target : null;
  }
  function openTarget(target) {
    return open({ src: target.getAttribute('src'), name: target.getAttribute('alt'), trigger: target });
  }
  function onClick(event) {
    const target = previewTarget(event);
    if (target && openTarget(target)) event.preventDefault();
  }
  function onKeyDown(event) {
    if (active && event.key === 'Escape') {
      event.preventDefault();
      // Other Escape listeners must not close the history drawer underneath.
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.repeat || !['Enter', ' '].includes(event.key)) return;
    const target = previewTarget(event);
    if (target && openTarget(target)) event.preventDefault();
  }
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown, true);
  return {
    open,
    close,
    sync(nextId) {
      const next = nextId ?? null;
      if (conversationId !== next) close({ restoreFocus: false });
      conversationId = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      close({ restoreFocus: false });
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown, true);
    },
  };
}

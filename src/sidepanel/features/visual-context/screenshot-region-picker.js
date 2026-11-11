import { selectionToImageRect } from './region-selection.js';

/** Selection happens on a frozen preview inside the sidebar, never on the page. */
export function selectScreenshotRegion(attachment, { signal, document: doc = document } = {}) {
  signal?.throwIfAborted();
  const dialog = doc.createElement('dialog');
  dialog.className = 'screenshot-region-dialog';
  dialog.setAttribute('aria-label', '框选页面位置');
  dialog.innerHTML = `<div class="screenshot-region-header"><strong>框选页面位置</strong><button type="button" data-region-cancel aria-label="取消框选">×</button></div>
    <p>在截图上拖动，框出要让 AI 关注的位置。</p>
    <div class="screenshot-region-preview"><div class="screenshot-region-stage"><img alt="当前页面截图" draggable="false" /><div class="screenshot-region-selection" hidden></div></div></div>
    <p class="screenshot-region-status" aria-live="polite">还未选择区域 · 可重新拖动</p>
    <div class="screenshot-region-actions"><button type="button" data-region-cancel>取消</button><button type="button" data-region-confirm disabled>添加选中区域</button></div>`;
  const img = dialog.querySelector('img');
  const stage = dialog.querySelector('.screenshot-region-stage');
  const selection = dialog.querySelector('.screenshot-region-selection');
  const status = dialog.querySelector('.screenshot-region-status');
  const confirm = dialog.querySelector('[data-region-confirm]');
  img.src = attachment.dataUrl;
  doc.body.append(dialog);
  try { dialog.showModal(); } catch (error) { dialog.remove(); throw error; }
  return new Promise((resolve, reject) => {
    let start = null, rect = null, pointerId = null, settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      dialog.close(); dialog.remove();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(null, signal.reason || new DOMException('已取消框选。', 'AbortError'));
    const point = event => { const bounds = img.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; };
    const draw = event => {
      const bounds = img.getBoundingClientRect();
      rect = selectionToImageRect(start, point(event), bounds, attachment.capture.image);
      selection.hidden = !rect;
      confirm.disabled = !rect;
      if (rect) {
        Object.assign(selection.style, { left: `${rect.x / attachment.capture.image.width * 100}%`, top: `${rect.y / attachment.capture.image.height * 100}%`,
          width: `${rect.width / attachment.capture.image.width * 100}%`, height: `${rect.height / attachment.capture.image.height * 100}%` });
        status.textContent = `已选择 ${rect.width} × ${rect.height} · 可重新拖动`;
      } else status.textContent = '区域太小，请拖动框选';
    };
    stage.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !img.complete) return;
      event.preventDefault(); start = point(event); pointerId = event.pointerId;
      stage.setPointerCapture?.(pointerId); draw(event);
    });
    stage.addEventListener('pointermove', event => { if (start && event.pointerId === pointerId) draw(event); });
    stage.addEventListener('pointerup', event => {
      if (!start || event.pointerId !== pointerId) return;
      draw(event); start = null; stage.releasePointerCapture?.(pointerId); pointerId = null;
    });
    stage.addEventListener('pointercancel', () => { start = null; pointerId = null; });
    dialog.querySelectorAll('[data-region-cancel]').forEach(button => button.addEventListener('click', () => finish(null)));
    confirm.addEventListener('click', () => { if (rect) finish(rect); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.addEventListener('click', event => { if (event.target === dialog) finish(null); });
    dialog.addEventListener('close', () => finish(null));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

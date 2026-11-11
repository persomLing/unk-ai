const PADDING = 12;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Local image navigation only. Owns no attachment, conversation or storage data. */
export function createImagePreviewViewport({ viewport, image, sizeButton, zoomIn, zoomOut, scaleLabel }) {
  const window = viewport.ownerDocument.defaultView;
  const removers = [];
  let disposed = false;
  let state = null;
  let drag = null;

  function listen(target, type, handler, options) {
    if (!target) return;
    const guarded = event => { if (!disposed) handler(event); };
    target.addEventListener(type, guarded, options);
    removers.push(() => target.removeEventListener(type, guarded, options));
  }
  function fitScale() { return Math.min(1, Math.max(1, state.width - PADDING * 2) / state.imageWidth); }
  function minScale() { return Math.min(0.1, fitScale()); }
  function boundAxis(position, size, available) {
    return size <= available - PADDING * 2 ? (available - size) / 2
      : clamp(position, available - PADDING - size, PADDING);
  }
  function render() {
    if (!state) return;
    const width = state.imageWidth * state.scale, height = state.imageHeight * state.scale;
    state.x = boundAxis(state.x, width, state.width);
    state.y = boundAxis(state.y, height, state.height);
    image.style.width = `${state.imageWidth}px`;
    image.style.height = `${state.imageHeight}px`;
    image.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.scale})`;
    viewport.classList.add('is-ready');
    viewport.classList.toggle('can-pan', width > state.width - PADDING * 2 || height > state.height - PADDING * 2);
    scaleLabel.textContent = `${Math.round(state.scale * 1000) / 10}%`;
    scaleLabel.setAttribute('aria-label', `缩放比例 ${scaleLabel.textContent}`);
    zoomIn.disabled = state.scale >= MAX_SCALE - 1e-8;
    zoomOut.disabled = state.scale <= minScale() + 1e-8;
    sizeButton.disabled = false;
    sizeButton.textContent = state.fit ? '原始尺寸' : '适应宽度';
    sizeButton.setAttribute('aria-pressed', String(!state.fit));
  }
  function endDrag() {
    const previous = drag;
    drag = null;
    viewport.classList.remove('is-dragging');
    if (previous) {
      try { viewport.releasePointerCapture(previous.id); } catch { /* Capture may already have been released. */ }
    }
  }
  function fit() {
    if (!state) return;
    endDrag();
    state.fit = true;
    state.scale = fitScale();
    state.x = PADDING;
    state.y = PADDING;
    render();
  }
  function zoomTo(scale, point = { x: state.width / 2, y: state.height / 2 }) {
    endDrag();
    const next = clamp(scale, minScale(), MAX_SCALE);
    if (Math.abs(next - state.scale) < 1e-10) return;
    const ratio = next / state.scale;
    state.x = point.x - (point.x - state.x) * ratio;
    state.y = point.y - (point.y - state.y) * ratio;
    state.scale = next;
    state.fit = false;
    render();
  }
  function toggleSize() {
    if (!state) return;
    if (!state.fit) fit();
    else {
      zoomTo(1);
      // Even when fit already equals 100%, allow the next click to reset a pan.
      state.fit = false;
      render();
    }
  }
  function measure() {
    if (disposed) return;
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const imageWidth = image.naturalWidth, imageHeight = image.naturalHeight;
    if (!(width > 0 && height > 0 && imageWidth > 0 && imageHeight > 0)) return;
    if (!state) {
      state = { width, height, imageWidth, imageHeight, x: 0, y: 0, scale: 1, fit: true };
      fit();
    } else if (width !== state.width || height !== state.height) {
      endDrag();
      state.x += (width - state.width) / 2;
      state.y += (height - state.height) / 2;
      state.width = width;
      state.height = height;
      if (state.fit) fit();
      else {
        state.scale = clamp(state.scale, minScale(), MAX_SCALE);
        render();
      }
    }
  }
  function pointAt(event) {
    const rect = viewport.getBoundingClientRect();
    return { x: clamp(event.clientX - rect.left, 0, state.width), y: clamp(event.clientY - rect.top, 0, state.height) };
  }

  zoomIn.disabled = zoomOut.disabled = sizeButton.disabled = true;
  listen(image, 'load', measure);
  listen(viewport, 'wheel', event => {
    // Keep wheel navigation inside the modal, including at the zoom limits.
    event.preventDefault();
    if (!state || !Number.isFinite(event.deltaY) || !event.deltaY) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? state.height : 1;
    const delta = clamp(event.deltaY * unit, -240, 240);
    zoomTo(state.scale * Math.exp(-delta * 0.002), pointAt(event));
  }, { passive: false });
  listen(zoomIn, 'click', () => { if (state) zoomTo(state.scale * ZOOM_STEP); });
  listen(zoomOut, 'click', () => { if (state) zoomTo(state.scale / ZOOM_STEP); });
  listen(sizeButton, 'click', toggleSize);
  listen(viewport, 'dblclick', event => { event.preventDefault(); toggleSize(); });
  listen(viewport, 'dragstart', event => event.preventDefault());
  listen(viewport, 'pointerdown', event => {
    if (!state || drag || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: state.x, y: state.y };
    viewport.classList.add('is-dragging');
    try { viewport.setPointerCapture(event.pointerId); } catch { /* Document listeners also finish uncaptured drags. */ }
  });
  listen(viewport.ownerDocument, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (event.buttons === 0 && event.pointerType !== 'touch') { endDrag(); return; }
    event.preventDefault();
    state.x = drag.x + event.clientX - drag.startX;
    state.y = drag.y + event.clientY - drag.startY;
    render();
  }, { passive: false });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    listen(viewport.ownerDocument, type, event => { if (event.pointerId === drag?.id) endDrag(); });
  }
  listen(window, 'blur', endDrag);
  listen(viewport, 'keydown', event => {
    if (!state || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 120 : 40;
    const movement = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
    if (movement) {
      event.preventDefault();
      endDrag();
      state.x += movement[0];
      state.y += movement[1];
      render();
    } else if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') fit();
      else zoomTo(state.scale * (event.key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP));
    }
  });
  listen(window, 'resize', measure);
  const observer = typeof window?.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null;
  observer?.observe(viewport);
  measure();

  return { dispose() {
    if (disposed) return;
    disposed = true;
    removers.forEach(remove => remove());
    observer?.disconnect();
    endDrag();
    state = null;
  } };
}

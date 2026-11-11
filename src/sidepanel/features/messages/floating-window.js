const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"], [contenteditable=""]';

/** Position and resize one UI window without owning its conversation or scroll. */
export function createFloatingWindow({ element, dragHandle, resizeHandle,
  window = element?.ownerDocument?.defaultView, minWidth = 280, minHeight = 260,
  width = 420, height = 480, margin = 10, onDragEnd } = {}) {
  if (!element || !dragHandle || !resizeHandle || !window) throw new TypeError('浮窗需要窗口、拖动和尺寸调整节点。');
  const document = element.ownerDocument;
  const removers = [];
  let interaction = null;
  let disposed = false;
  const previousTouchAction = [dragHandle.style.touchAction, resizeHandle.style.touchAction];
  dragHandle.style.touchAction = 'none';
  resizeHandle.style.touchAction = 'none';

  const numeric = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  function viewport() {
    const viewWidth = Math.max(1, numeric(window.innerWidth, document.documentElement?.clientWidth || 1));
    const viewHeight = Math.max(1, numeric(window.innerHeight, document.documentElement?.clientHeight || 1));
    const insetX = Math.min(Math.max(0, margin), (viewWidth - 1) / 2);
    const insetY = Math.min(Math.max(0, margin), (viewHeight - 1) / 2);
    return { viewWidth, viewHeight, insetX, insetY,
      availableWidth: viewWidth - 2 * insetX, availableHeight: viewHeight - 2 * insetY };
  }
  function currentRect() {
    const rect = element.getBoundingClientRect();
    return {
      left: numeric(rect.left, numeric(element.style.left?.replace('px', ''), 0)),
      top: numeric(rect.top, numeric(element.style.top?.replace('px', ''), 0)),
      width: rect.width > 0 ? rect.width : numeric(element.style.width?.replace('px', ''), width),
      height: rect.height > 0 ? rect.height : numeric(element.style.height?.replace('px', ''), height),
    };
  }
  function fit(rect) {
    const view = viewport();
    const fittedWidth = clamp(rect.width, Math.min(minWidth, view.availableWidth), view.availableWidth);
    const fittedHeight = clamp(rect.height, Math.min(minHeight, view.availableHeight), view.availableHeight);
    return {
      left: clamp(rect.left, view.insetX, view.viewWidth - view.insetX - fittedWidth),
      top: clamp(rect.top, view.insetY, view.viewHeight - view.insetY - fittedHeight),
      width: fittedWidth,
      height: fittedHeight,
    };
  }
  function write(rect) {
    if (disposed) return;
    element.style.position = 'fixed';
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  }
  function resize(rect, deltaX, deltaY) {
    const view = viewport();
    const maxWidth = Math.max(1, view.viewWidth - view.insetX - rect.left);
    const maxHeight = Math.max(1, view.viewHeight - view.insetY - rect.top);
    write({ ...rect,
      width: clamp(rect.width + deltaX, Math.min(minWidth, maxWidth), maxWidth),
      height: clamp(rect.height + deltaY, Math.min(minHeight, maxHeight), maxHeight) });
  }
  function finish(event, completed = false) {
    if (!interaction || (event?.pointerId !== undefined && event.pointerId !== interaction.pointerId)) return;
    const current = interaction;
    interaction = null;
    try { current.handle.releasePointerCapture?.(current.pointerId); } catch {}
    if (!disposed && completed && current.mode === 'drag') {
      onDragEnd?.({ rect: currentRect(), deltaX: current.lastX - current.clientX,
        deltaY: current.lastY - current.clientY, pointerX: current.lastX, pointerY: current.lastY });
    }
  }
  function start(event, mode, handle) {
    if (disposed || interaction || event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    if (mode === 'drag' && event.target?.closest?.(INTERACTIVE)) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const rect = fit(currentRect());
    write(rect);
    interaction = { mode, handle, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      lastX: event.clientX, lastY: event.clientY, rect };
    try { handle.setPointerCapture?.(event.pointerId); } catch {}
    event.preventDefault();
  }
  function move(event) {
    if (disposed || !interaction || event.pointerId !== interaction.pointerId) return;
    const deltaX = event.clientX - interaction.clientX;
    const deltaY = event.clientY - interaction.clientY;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    interaction.lastX = event.clientX;
    interaction.lastY = event.clientY;
    const rect = interaction.rect;
    if (interaction.mode === 'drag') write(fit({ ...rect, left: rect.left + deltaX, top: rect.top + deltaY }));
    else resize(rect, deltaX, deltaY);
    event.preventDefault();
  }
  function keyResize(event) {
    if (disposed || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    finish();
    const step = event.shiftKey ? 60 : 20;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    resize(fit(currentRect()), dx, dy);
    event.preventDefault();
    event.stopPropagation();
  }
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  }
  listen(dragHandle, 'pointerdown', event => start(event, 'drag', dragHandle));
  listen(resizeHandle, 'pointerdown', event => start(event, 'resize', resizeHandle));
  listen(resizeHandle, 'keydown', keyResize);
  listen(document, 'pointermove', move, { capture: true, passive: false });
  listen(document, 'pointerup', event => finish(event, true), true);
  listen(document, 'pointercancel', finish, true);
  listen(dragHandle, 'lostpointercapture', finish);
  listen(resizeHandle, 'lostpointercapture', finish);
  listen(window, 'blur', () => finish());
  listen(window, 'resize', () => { finish(); write(fit(currentRect())); });

  return Object.freeze({
    rect: () => currentRect(),
    restoreRect(rect) {
      if (disposed || !rect) return;
      finish();
      const current = currentRect();
      write(fit({ left: numeric(rect.left, current.left), top: numeric(rect.top, current.top),
        width: numeric(rect.width, current.width), height: numeric(rect.height, current.height) }));
    },
    place(anchorRect) {
      if (disposed) return;
      finish();
      const view = viewport();
      const fitted = fit({ left: view.insetX, top: view.insetY, width, height });
      const anchorLeft = numeric(anchorRect?.left ?? anchorRect?.x, view.viewWidth - view.insetX - fitted.width);
      const anchorTop = numeric(anchorRect?.top ?? anchorRect?.y, view.insetY);
      const anchorRight = numeric(anchorRect?.right, anchorLeft + numeric(anchorRect?.width, 0));
      const anchorBottom = numeric(anchorRect?.bottom, anchorTop + numeric(anchorRect?.height, 0));
      const hasRightRoom = anchorRect && anchorRight + margin + fitted.width <= view.viewWidth - view.insetX;
      const left = hasRightRoom ? anchorRight + margin : anchorLeft;
      const top = anchorRect ? anchorBottom + margin : view.viewHeight - view.insetY - fitted.height;
      write(fit({ ...fitted, left, top }));
    },
    dispose() {
      if (disposed) return;
      finish();
      disposed = true;
      removers.forEach(remove => remove());
      [dragHandle.style.touchAction, resizeHandle.style.touchAction] = previousTouchAction;
    },
  });
}

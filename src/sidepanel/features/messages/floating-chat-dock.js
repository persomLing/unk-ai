const LAUNCHER_SIZE = 48;
const EDGE_DISTANCE = 24;
const DRAG_DISTANCE = 24;
const INSET = 10;
const LAUNCHER_GAP = 8;
const ANIMATION_MS = 260;
const LAUNCHER_DRAG_THRESHOLD = 4;

/** Collapse one floating view without changing its conversation or execution. */
export function createFloatingChatDock({ element, document = element?.ownerDocument, geometry,
  iconMarkup = '', onCollapse, onExpand, getBusy = () => false, getDetachedLabel = () => '',
  getActivity = () => 'answering', getUnread = () => false } = {}) {
  if (!document?.body || !element || !geometry?.rect || !geometry?.restoreRect) {
    throw new TypeError('追问收起需要浮窗、尺寸控制和文档。');
  }
  const view = document.defaultView;
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'selection-chat-launcher';
  launcher.innerHTML = iconMarkup;
  launcher.setAttribute('aria-label', '展开单独追问');
  if (element.id) launcher.setAttribute('aria-controls', element.id);
  launcher.style.position = 'fixed';
  launcher.style.right = `${INSET}px`;
  launcher.style.width = `${LAUNCHER_SIZE}px`;
  launcher.style.height = `${LAUNCHER_SIZE}px`;
  launcher.hidden = true;
  document.body.appendChild(launcher);

  let state = 'expanded';
  let savedRect = null;
  let savedFocus = null;
  let disposed = false;
  let generation = 0;
  let timer = null;
  let finishCurrent = null;
  let launcherTop = null;
  let launcherPointer = null;
  let draggedPointerId = null;
  const listeners = new AbortController();
  const { signal } = listeners;
  const animations = new Set();
  const initialInert = element.inert;
  const setTimer = view?.setTimeout?.bind(view) || globalThis.setTimeout;
  const clearTimer = view?.clearTimeout?.bind(view) || globalThis.clearTimeout;
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

  function setState(next) {
    state = next;
    element.dataset.dockState = next;
    launcher.dataset.state = next;
    launcher.setAttribute('aria-expanded', String(next === 'expanded' || next === 'expanding'));
  }
  function availableTop(desired, size, minimum, maximum) {
    const occupied = [];
    for (const node of document.querySelectorAll?.('.selection-chat-launcher') || []) {
      if (node === launcher || node.hidden || node.style.display === 'none') continue;
      const computed = view?.getComputedStyle?.(node);
      if (computed?.display === 'none' || computed?.visibility === 'hidden') continue;
      const bounds = node.getBoundingClientRect();
      // Use the layout slot, so another launcher's scale animation cannot shrink its reservation.
      const top = finite(parseFloat(node.style.top), bounds.top);
      const height = finite(parseFloat(node.style.height), bounds.height);
      if (Number.isFinite(top) && height > 0) occupied.push({ top, bottom: top + height });
    }
    const clamp = value => Math.max(minimum, Math.min(value, maximum));
    const target = clamp(desired);
    const candidates = new Set([target, minimum, maximum]);
    for (const slot of occupied) {
      candidates.add(clamp(slot.top - size - LAUNCHER_GAP));
      candidates.add(clamp(slot.bottom + LAUNCHER_GAP));
    }
    const ordered = [...candidates].sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
    return ordered.find(top => occupied.every(slot =>
      top + size + LAUNCHER_GAP <= slot.top || top >= slot.bottom + LAUNCHER_GAP)) ?? target;
  }
  function positionLauncher(rect = savedRect || geometry.rect(), preferredTop = launcherTop) {
    const height = Math.max(1, finite(view?.innerHeight, document.documentElement?.clientHeight || 1));
    const width = Math.max(1, finite(view?.innerWidth, document.documentElement?.clientWidth || 1));
    const size = Math.min(LAUNCHER_SIZE, width, height);
    const insetY = Math.min(INSET, Math.max(0, (height - size) / 2));
    const insetX = Math.min(INSET, Math.max(0, (width - size) / 2));
    const desiredTop = Number.isFinite(preferredTop) ? preferredTop : rect.top + rect.height / 2 - size / 2;
    const top = availableTop(desiredTop, size, insetY, height - size - insetY);
    launcher.style.right = `${insetX}px`;
    launcher.style.top = `${top}px`;
    launcher.style.width = `${size}px`;
    launcher.style.height = `${size}px`;
    return { left: width - size - insetX, top, width: size, height: size };
  }
  function sync() {
    if (disposed) return;
    if (state === 'docked' && !launcherPointer) positionLauncher();
    const busy = Boolean(getBusy());
    const phase = getActivity();
    const activity = busy ? ['thinking', 'answering', 'preparing'].includes(phase) ? phase : 'preparing' : 'idle';
    const unread = !busy && Boolean(getUnread());
    const detached = getDetachedLabel();
    launcher.dataset.busy = String(busy);
    launcher.dataset.activity = activity;
    launcher.dataset.unread = String(unread);
    launcher.dataset.detached = String(Boolean(detached));
    const progressLabel = { preparing: '正在准备回答', thinking: '正在思考', answering: '正在回答' };
    const description = [busy ? `${progressLabel[activity]}，收起后会继续` : unread ? '回答已完成，待查看' : '',
      typeof detached === 'string' ? detached : detached ? '已解除跟随当前对话' : ''].filter(Boolean).join('；');
    launcher.title = ['展开单独追问', '上下拖动调整位置', description].filter(Boolean).join(' · ');
    launcher.setAttribute('aria-description', ['可用上、下方向键移动图标', description].filter(Boolean).join('。'));
  }
  function cancelTransition() {
    generation += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    finishCurrent = null;
    for (const animation of animations) { try { animation.cancel(); } catch {} }
    animations.clear();
  }
  function transition(specs, complete) {
    const owner = generation;
    let pending = 0;
    let completed = false;
    const finish = () => {
      if (disposed || owner !== generation || completed) return;
      completed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      finishCurrent = null;
      for (const animation of animations) { try { animation.cancel(); } catch {} }
      animations.clear();
      complete();
    };
    finishCurrent = finish;
    const reducedMotion = view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (!reducedMotion) {
      for (const [target, frames] of specs) {
        if (typeof target.animate !== 'function') continue;
        try {
          const animation = target.animate(frames, { duration: ANIMATION_MS,
            easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' });
          animations.add(animation);
          pending += 1;
          Promise.resolve(animation.finished).catch(() => {}).then(() => {
            pending -= 1;
            if (!pending) finish();
          });
        } catch { /* A missing animation implementation must not leave the view stuck. */ }
      }
    }
    if (!pending) finish();
    else timer = setTimer(finish, ANIMATION_MS + 80);
  }
  function animationFrames(rect, dockRect) {
    const dx = dockRect.left + dockRect.width / 2 - rect.left - rect.width / 2;
    const dy = dockRect.top + dockRect.height / 2 - rect.top - rect.height / 2;
    const transform = `translate(${dx}px, ${dy}px) scale(${dockRect.width / rect.width}, ${dockRect.height / rect.height})`;
    return [
      { transform: 'translate(0, 0) scale(1, 1)', transformOrigin: 'center center', opacity: 1 },
      { transform, transformOrigin: 'center center', opacity: 0 },
    ];
  }
  function collapse() {
    if (disposed || state === 'docked' || state === 'collapsing') return false;
    const reversing = state === 'expanding';
    cancelTransition();
    if (!reversing || !savedRect) savedRect = { ...geometry.rect() };
    if (element.contains(document.activeElement)) savedFocus = document.activeElement;
    const dockRect = positionLauncher(savedRect);
    launcher.hidden = false;
    element.inert = true;
    setState('collapsing');
    sync();
    transition([
      [element, animationFrames(savedRect, dockRect)],
      [launcher, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }]],
    ], () => {
      element.hidden = true;
      setState('docked');
    });
    if (savedFocus) launcher.focus?.({ preventScroll: true });
    onCollapse?.();
    return true;
  }
  function expand() {
    if (disposed || state === 'expanded' || state === 'expanding') return false;
    endLauncherDrag();
    cancelTransition();
    element.hidden = false;
    geometry.restoreRect(savedRect);
    const rect = geometry.rect();
    const dockRect = positionLauncher(rect);
    launcher.hidden = false;
    element.inert = true;
    setState('expanding');
    sync();
    transition([
      [element, animationFrames(rect, dockRect).reverse()],
      [launcher, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.6)' }]],
    ], () => {
      launcher.hidden = true;
      element.inert = initialInert;
      setState('expanded');
      onExpand?.();
      if (disposed) return;
      const focus = element.contains(savedFocus) ? savedFocus : element.querySelector('textarea');
      if (!focus?.disabled) focus?.focus?.({ preventScroll: true });
    });
    return true;
  }
  function handleDragEnd({ rect, deltaX } = {}) {
    if (disposed || state !== 'expanded' || !rect || !Number.isFinite(deltaX) || deltaX < DRAG_DISTANCE) return false;
    const width = finite(view?.innerWidth, document.documentElement?.clientWidth || 1);
    const right = finite(rect.right, rect.left + rect.width);
    if (!Number.isFinite(right) || width - right > EDGE_DISTANCE) return false;
    return collapse();
  }

  function endLauncherDrag(event) {
    if (!launcherPointer || event?.pointerId !== undefined && event.pointerId !== launcherPointer.pointerId) return;
    const { pointerId, dragging } = launcherPointer;
    launcherPointer = null;
    if (!dragging) return;
    delete launcher.dataset.dragging;
    draggedPointerId = pointerId;
    try { launcher.releasePointerCapture(pointerId); } catch {}
  }

  function startLauncherDrag(event) {
    if (state !== 'docked' || launcherPointer || event.isPrimary === false || event.button !== 0) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    draggedPointerId = null;
    launcherPointer = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      startTop: finite(parseFloat(launcher.style.top), 0), dragging: false };
  }

  function moveLauncherPointer(event) {
    const current = launcherPointer;
    if (!current || event.pointerId !== current.pointerId) return;
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) { endLauncherDrag(event); return; }
    const deltaX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    if (!current.dragging) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < LAUNCHER_DRAG_THRESHOLD) return;
      current.dragging = true;
      launcher.dataset.dragging = 'true';
      try { launcher.setPointerCapture(event.pointerId); } catch {}
    }
    launcherTop = positionLauncher(savedRect, current.startTop + deltaY).top;
    if (event.cancelable) event.preventDefault();
  }

  function moveLauncherByKey(event) {
    if (state !== 'docked' || launcherPointer || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const delta = event.key === 'ArrowUp' ? -20 : 20;
    launcherTop = positionLauncher(savedRect, parseFloat(launcher.style.top) + delta).top;
    event.preventDefault();
    event.stopPropagation();
  }

  const click = event => {
    event.stopPropagation();
    if (draggedPointerId !== null && event.detail !== 0 && (!(event.pointerId > 0) || event.pointerId === draggedPointerId)) {
      draggedPointerId = null;
      event.preventDefault();
      return;
    }
    expand();
  };
  launcher.addEventListener('click', click, { signal });
  launcher.addEventListener('keydown', moveLauncherByKey, { signal });
  launcher.addEventListener('pointerdown', startLauncherDrag, { signal });
  launcher.addEventListener('lostpointercapture', endLauncherDrag, { signal });
  view?.addEventListener('pointermove', moveLauncherPointer, { capture: true, passive: false, signal });
  view?.addEventListener('pointerup', endLauncherDrag, { capture: true, signal });
  view?.addEventListener('pointercancel', endLauncherDrag, { capture: true, signal });
  view?.addEventListener('blur', () => endLauncherDrag(), { signal });
  view?.addEventListener('resize', () => {
    endLauncherDrag();
    if (state !== 'expanded') positionLauncher();
    finishCurrent?.();
  }, { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) endLauncherDrag(); }, { signal });
  setState('expanded');
  sync();

  return Object.freeze({ launcher, handleDragEnd, collapse, expand,
    isDocked: () => state === 'docked' || state === 'collapsing', sync,
    dispose() {
      if (disposed) return;
      cancelTransition();
      endLauncherDrag();
      disposed = true;
      listeners.abort();
      launcher.remove();
      element.hidden = false;
      element.inert = initialInert;
      setState('expanded');
      savedFocus = null;
    },
  });
}

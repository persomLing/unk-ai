const LAUNCHER_SIZE = 48;
const EDGE_DISTANCE = 24;
const DRAG_DISTANCE = 24;
const INSET = 10;
const LAUNCHER_GAP = 8;
const ANIMATION_MS = 260;

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
  function positionLauncher(rect = savedRect || geometry.rect()) {
    const height = Math.max(1, finite(view?.innerHeight, document.documentElement?.clientHeight || 1));
    const width = Math.max(1, finite(view?.innerWidth, document.documentElement?.clientWidth || 1));
    const size = Math.min(LAUNCHER_SIZE, width, height);
    const insetY = Math.min(INSET, Math.max(0, (height - size) / 2));
    const insetX = Math.min(INSET, Math.max(0, (width - size) / 2));
    const top = availableTop(rect.top + rect.height / 2 - size / 2, size, insetY, height - size - insetY);
    launcher.style.right = `${insetX}px`;
    launcher.style.top = `${top}px`;
    launcher.style.width = `${size}px`;
    launcher.style.height = `${size}px`;
    return { left: width - size - insetX, top, width: size, height: size };
  }
  function sync() {
    if (disposed) return;
    if (state === 'docked') positionLauncher();
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
    launcher.title = ['展开单独追问', description].filter(Boolean).join(' · ');
    launcher.setAttribute('aria-description', description);
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
  const click = event => { event.stopPropagation(); expand(); };
  const resize = () => { if (!disposed) { positionLauncher(); finishCurrent?.(); } };
  launcher.addEventListener('click', click);
  view?.addEventListener('resize', resize);
  setState('expanded');
  sync();

  return Object.freeze({ launcher, handleDragEnd, collapse, expand,
    isDocked: () => state === 'docked' || state === 'collapsing', sync,
    dispose() {
      if (disposed) return;
      cancelTransition();
      disposed = true;
      launcher.removeEventListener('click', click);
      view?.removeEventListener('resize', resize);
      launcher.remove();
      element.hidden = false;
      element.inert = initialInert;
      setState('expanded');
      savedFocus = null;
    },
  });
}

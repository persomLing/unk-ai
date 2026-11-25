import { COMPANION_GESTURES, createCompanionPainter } from './reading-companion-art.js';

/** A local UI projection. The composer owns the draft, selection and submission. */
export function createReadingCompanion({ button, panel, input, messages, occluders }) {
  const document = button.ownerDocument;
  const win = document.defaultView;
  const root = document.documentElement;
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  const controller = new AbortController();
  const listener = { signal: controller.signal };
  const passive = { ...listener, passive: true };
  const paint = createCompanionPainter(button.querySelector('canvas'), button.querySelector('.companion-hit'));
  if (!paint) {
    button.hidden = true;
    return { accepted() {}, dispose() {} };
  }
  const gestures = Object.keys(COMPANION_GESTURES);
  const since = Object.fromEntries(gestures.map(key => [key, -Infinity]));
  const pose = { x: 0, y: 0, curious: 0 };
  let aim = { x: 0, y: 0 };
  let selectionGaze = { x: 0, y: -1 };
  let origin, raf, previous, blinkStart, blinkTimer, typingTimer, hoverTimer, selectionTimer;
  let composing = false, typing = false, marked = false, inView = false, animated = false;

  function draw(now) {
    paint({ now, pose, since, blinkStart, selectionGaze });
  }

  function wake() {
    if (animated && !raf) raf = win.requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    if (!animated) return;
    const elapsed = previous ? Math.min(60, now - previous) : 16;
    const follow = 1 - Math.exp(-elapsed / 85);
    const lean = 1 - Math.exp(-elapsed / 125);
    const x = typing ? -0.75 : aim.x;
    const y = typing ? 0.8 : aim.y;
    pose.x += (x - pose.x) * follow;
    pose.y += (y - pose.y) * follow;
    pose.curious += (Number(typing) - pose.curious) * lean;
    if (now - blinkStart > 155) blinkStart = 0;
    draw(now);
    previous = now;
    if (Math.abs(x - pose.x) + Math.abs(y - pose.y) + Math.abs(Number(typing) - pose.curious) > 0.007
        || blinkStart || gestures.some(key => now - since[key] < COMPANION_GESTURES[key])) wake();
    else previous = 0;
  }

  function play(key) {
    const now = win.performance.now();
    if (!animated || now - since.shy < COMPANION_GESTURES.shy || now - since[key] < COMPANION_GESTURES[key]) return;
    since[key] = now;
    wake();
  }

  function scheduleBlink() {
    blinkTimer = win.setTimeout(() => {
      if (!animated) return;
      const now = win.performance.now();
      if (now - since.shy > COMPANION_GESTURES.shy && !typing) {
        blinkStart = now;
        wake();
      }
      scheduleBlink();
    }, 4600 + Math.random() * 3400);
  }

  function rest() {
    win.cancelAnimationFrame(raf);
    for (const timer of [blinkTimer, typingTimer, hoverTimer, selectionTimer]) win.clearTimeout(timer);
    previous = raf = blinkStart = 0;
    for (const key of gestures) since[key] = -Infinity;
    typing = marked = false;
    Object.assign(pose, { x: 0, y: 0, curious: 0 });
    aim = { x: 0, y: 0 };
    origin = null;
  }

  function sync() {
    origin = null;
    const mode = root.dataset.companion;
    const canAnimate = mode !== 'static' && mode !== 'off' && !reduced.matches;
    button.disabled = !canAnimate;
    const next = canAnimate && inView && !document.hidden && occluders.every(element => element.hidden);
    if (next === animated) return;
    animated = next;
    rest();
    // Restore the neutral illustration even when switching directly from a gesture to "off".
    draw(win.performance.now());
    if (animated) scheduleBlink();
  }

  function direction(clientX, clientY) {
    if (!origin) {
      const rect = button.getBoundingClientRect();
      origin = { x: rect.left + rect.width * 0.47, y: rect.top + rect.height * 0.53 };
    }
    const dx = clientX - origin.x, dy = clientY - origin.y;
    const distance = Math.max(72, Math.hypot(dx, dy));
    return { x: dx / distance, y: dy / distance };
  }

  panel.addEventListener('pointermove', event => {
    if (!animated || event.pointerType === 'touch') return;
    aim = direction(event.clientX, event.clientY);
    wake();
  }, passive);
  panel.addEventListener('pointerleave', () => { aim = { x: 0, y: 0 }; wake(); }, passive);
  function waitNearby() {
    win.clearTimeout(hoverTimer);
    if (animated) hoverTimer = win.setTimeout(() => play('notice'), 460);
  }
  button.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') waitNearby(); }, passive);
  button.addEventListener('pointerleave', () => win.clearTimeout(hoverTimer), passive);
  button.addEventListener('focus', () => { if (button.matches(':focus-visible')) waitNearby(); }, listener);
  button.addEventListener('blur', () => win.clearTimeout(hoverTimer), listener);
  button.addEventListener('pointerdown', event => {
    if (event.button === 0 && document.activeElement === input) event.preventDefault();
  }, listener);
  button.addEventListener('click', () => { win.clearTimeout(hoverTimer); play('shy'); }, listener);

  function curious() {
    if (!animated) return;
    win.clearTimeout(typingTimer);
    typing = true;
    wake();
    if (!composing) typingTimer = win.setTimeout(() => { typing = false; wake(); }, 950);
  }
  input.addEventListener('input', curious, listener);
  input.addEventListener('compositionstart', () => { composing = true; curious(); }, listener);
  input.addEventListener('compositionend', () => { composing = false; curious(); }, listener);
  input.addEventListener('blur', () => {
    win.clearTimeout(typingTimer);
    composing = typing = false;
    wake();
  }, listener);

  function selectedAnswer() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node.nodeType === 1 ? node : node.parentElement;
    return messages.contains(element) && element?.closest('.assistant-message [data-message-content]') ? range : null;
  }
  document.addEventListener('selectionchange', () => {
    if (!animated) return;
    win.clearTimeout(selectionTimer);
    if (!selectedAnswer()) { marked = false; return; }
    if (marked) return;
    selectionTimer = win.setTimeout(() => {
      const bounds = selectedAnswer()?.getBoundingClientRect();
      if (!bounds) return;
      marked = true;
      selectionGaze = direction(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      play('bookmark');
    }, 180);
  }, listener);

  const visibility = new win.IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); });
  const invalidateOrigin = () => { origin = null; };
  const layout = new win.ResizeObserver(invalidateOrigin);
  const prefs = new win.MutationObserver(sync);
  visibility.observe(button);
  layout.observe(button);
  layout.observe(button.closest('.composer-area'));
  prefs.observe(root, { attributes: true, attributeFilter: ['data-companion'] });
  for (const element of occluders) prefs.observe(element, { attributes: true, attributeFilter: ['hidden'] });
  win.addEventListener('resize', invalidateOrigin, passive);
  document.addEventListener('visibilitychange', sync, listener);
  reduced.addEventListener('change', sync, listener);
  draw(win.performance.now());
  sync();
  return {
    accepted() { typing = false; win.clearTimeout(typingTimer); play('turnPage'); },
    dispose() {
      animated = false;
      controller.abort();
      visibility.disconnect();
      layout.disconnect();
      prefs.disconnect();
      rest();
    },
  };
}

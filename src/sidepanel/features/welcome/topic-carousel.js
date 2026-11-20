const AUTO_SPEED = 0.014;
const INERTIA_DECAY_MS = 760;
const MAX_INERTIA_SPEED = 0.28;

export function createTopicCarousel({ viewport, track }) {
  const doc = viewport.ownerDocument;
  const win = doc.defaultView;
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new AbortController();
  const { signal } = listeners;
  let active = false;
  let hovered = false;
  let inView = true;
  let dragging = false;
  let pointerId = null;
  let capturedPointer = false;
  let keyboardNavigation = false;
  let suppressClick = false;
  let lastPointerX = 0;
  let lastPointerTime = 0;
  let dragDistance = 0;
  let inertiaSpeed = 0;
  let offset = 0;
  let period = 0;
  let frame = null;
  let previousFrameTime = null;
  let originalCount = 0;

  function realCards() {
    return Array.from(track.children).filter(card => !card.dataset.carouselClone);
  }

  function ensureLoop() {
    const cards = realCards();
    if (!cards.length || cards.length === originalCount && track.children.length === originalCount * 2) return;
    Array.from(track.children).filter(card => card.dataset.carouselClone).forEach(card => card.remove());
    originalCount = cards.length;
    const copies = cards.map(card => {
      const copy = card.cloneNode(true);
      copy.dataset.carouselClone = 'true';
      copy.setAttribute('aria-hidden', 'true');
      copy.inert = true;
      return copy;
    });
    track.append(...copies);
  }

  function measurePeriod() {
    ensureLoop();
    const cards = Array.from(track.children);
    const first = cards.find(card => !card.dataset.carouselClone);
    const copy = cards.find(card => card.dataset.carouselClone);
    if (!first || !copy) { period = 0; return; }
    const nextPeriod = copy.getBoundingClientRect().left - first.getBoundingClientRect().left;
    if (!Number.isFinite(nextPeriod) || nextPeriod <= 0) { period = 0; return; }
    const progress = period > 0 ? offset / period : 0;
    period = nextPeriod;
    offset = (progress * period) % period;
    paint();
  }

  function wrapOffset() {
    if (period <= 0) { offset = 0; return; }
    offset = ((offset % period) + period) % period;
  }

  function paint() {
    wrapOffset();
    track.style.transform = `translate3d(${-offset}px, 0, 0)`;
  }

  function canAnimate() {
    return !signal.aborted && active && inView && !doc.hidden && !motion.matches && !hovered && !dragging
      && !(keyboardNavigation && viewport.contains(doc.activeElement)) && period > 0;
  }

  function stopFrame() {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    previousFrameTime = null;
  }

  function animate(time) {
    frame = null;
    if (!canAnimate()) return;
    if (previousFrameTime !== null) {
      const delta = Math.min(48, Math.max(0, time - previousFrameTime));
      offset += (AUTO_SPEED + inertiaSpeed) * delta;
      inertiaSpeed *= Math.exp(-delta / INERTIA_DECAY_MS);
      if (Math.abs(inertiaSpeed) < .001) inertiaSpeed = 0;
      paint();
    }
    previousFrameTime = time;
    frame = win.requestAnimationFrame(animate);
  }

  function updateAnimation() {
    if (canAnimate()) {
      if (frame === null) frame = win.requestAnimationFrame(animate);
      return;
    }
    stopFrame();
  }

  function onPointerDown(event) {
    if (event.isPrimary === false || event.button !== 0) return;
    dragging = true;
    pointerId = event.pointerId;
    capturedPointer = false;
    lastPointerX = event.clientX;
    lastPointerTime = event.timeStamp || win.performance.now();
    dragDistance = 0;
    inertiaSpeed = 0;
    viewport.classList.add('is-dragging');
    updateAnimation();
  }

  function onPointerMove(event) {
    if (!dragging || event.pointerId !== pointerId) return;
    const delta = lastPointerX - event.clientX;
    const now = event.timeStamp || win.performance.now();
    const elapsed = Math.max(1, now - lastPointerTime);
    dragDistance += Math.abs(delta);
    offset += delta;
    inertiaSpeed = Math.max(-MAX_INERTIA_SPEED, Math.min(MAX_INERTIA_SPEED, delta / elapsed * .18));
    lastPointerX = event.clientX;
    lastPointerTime = now;
    paint();
    if (dragDistance > 4) {
      event.preventDefault();
      if (!capturedPointer) {
        try { viewport.setPointerCapture(event.pointerId); capturedPointer = true; } catch {}
      }
    }
  }

  function finishPointer(event, cancelled = false) {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    viewport.classList.remove('is-dragging');
    if (capturedPointer) {
      capturedPointer = false;
      try { viewport.releasePointerCapture(event.pointerId); } catch {}
    }
    if (event.pointerType !== 'touch' && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      const bounds = viewport.getBoundingClientRect();
      hovered = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    }
    if (cancelled) inertiaSpeed = 0;
    if (dragDistance > 4) {
      suppressClick = true;
      win.setTimeout(() => { suppressClick = false; }, 150);
    }
    updateAnimation();
  }

  viewport.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch') return;
    hovered = true;
    updateAnimation();
  }, { signal });
  viewport.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return;
    hovered = false;
    updateAnimation();
  }, { signal });
  viewport.addEventListener('pointerdown', onPointerDown, { signal });
  doc.addEventListener('pointerdown', () => { keyboardNavigation = false; }, { capture: true, signal });
  doc.addEventListener('keydown', () => { keyboardNavigation = true; }, { capture: true, signal });
  win.addEventListener('pointermove', onPointerMove, { capture: true, signal });
  win.addEventListener('pointerup', event => finishPointer(event), { capture: true, signal });
  win.addEventListener('pointercancel', event => finishPointer(event, true), { capture: true, signal });
  win.addEventListener('blur', () => {
    if (pointerId !== null) finishPointer({ pointerId }, true);
  }, { signal });
  viewport.addEventListener('lostpointercapture', event => finishPointer(event, true), { signal });
  viewport.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, signal });
  viewport.addEventListener('focusin', updateAnimation, { signal });
  viewport.addEventListener('focusout', event => {
    if (!viewport.contains(event.relatedTarget)) win.queueMicrotask(updateAnimation);
  }, { signal });
  doc.addEventListener('visibilitychange', updateAnimation, { signal });
  motion.addEventListener('change', updateAnimation, { signal });

  const resizeObserver = new win.ResizeObserver(() => {
    measurePeriod();
    updateAnimation();
  });
  resizeObserver.observe(viewport);
  const intersection = new win.IntersectionObserver(([entry]) => {
    inView = entry.intersectionRatio >= .5;
    updateAnimation();
  }, { threshold: .5 });
  intersection.observe(viewport);

  return {
    setActive(value) {
      if (signal.aborted || active === value) return;
      active = value;
      if (!active) { hovered = false; inertiaSpeed = 0; }
      measurePeriod();
      updateAnimation();
    },
    refresh() {
      measurePeriod();
      updateAnimation();
    },
    dispose() {
      active = false;
      stopFrame();
      listeners.abort();
      resizeObserver.disconnect();
      intersection.disconnect();
    },
  };
}

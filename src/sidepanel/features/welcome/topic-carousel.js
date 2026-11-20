const AUTO_SPEED = .014;
const MAX_INERTIA_SPEED = .42;
const INERTIA_DECAY = 340;
const DRAG_THRESHOLD = 8;

export function createTopicCarousel({ viewport, track }) {
  const doc = viewport.ownerDocument;
  const win = doc.defaultView;
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new AbortController();
  const { signal } = listeners;
  let active = false;
  let hovered = false;
  let inView = true;
  let keyboard = false;
  let press = null;
  let suppressedPointer = null;
  let speed = 0;
  let offset = 0;
  let period = 0;
  let maxOffset = 0;
  let cards = Array.from(track.children);
  let copies = [];
  let frame = null;
  let previousTime = null;

  function bounded(value) {
    return period ? ((value % period) + period) % period : Math.max(0, Math.min(maxOffset, value));
  }

  function paint() {
    track.style.transform = `translate3d(${-bounded(offset)}px, 0, 0)`;
  }

  function autoplay() {
    return active && inView && !doc.hidden && period > 0 && !hovered && !press
      && !(keyboard && viewport.contains(doc.activeElement));
  }

  function queueFrame() {
    if (!signal.aborted && frame === null) frame = win.requestAnimationFrame(animate);
  }

  function stopFrame() {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = previousTime = null;
  }

  function animate(time) {
    frame = null;
    if (press?.started) { paint(); return; }
    if (!autoplay()) { previousTime = null; return; }
    if (previousTime !== null) {
      const elapsed = Math.min(40, Math.max(0, time - previousTime));
      offset = bounded(offset + (AUTO_SPEED + speed) * elapsed);
      speed *= Math.exp(-elapsed / INERTIA_DECAY);
      if (Math.abs(speed) < .001) speed = 0;
      paint();
    }
    previousTime = time;
    queueFrame();
  }

  function syncAnimation() {
    if (press?.started || autoplay()) queueFrame();
    else stopFrame();
  }

  function removeCopies() {
    copies.forEach(copy => copy.remove());
    copies = [];
  }

  function revealFocusedCard() {
    const card = doc.activeElement;
    if (!keyboard || !cards.includes(card) || !maxOffset) return;
    const bounds = card.getBoundingClientRect();
    const left = bounds.left - cards[0].getBoundingClientRect().left;
    const right = left + bounds.width + 2;
    const position = bounded(offset);
    if (left < position) offset = left;
    else if (right > position + viewport.clientWidth) offset = Math.min(maxOffset, right - viewport.clientWidth);
    paint();
  }

  function measure() {
    const first = cards[0];
    const width = viewport.clientWidth;
    const firstLeft = first?.getBoundingClientRect().left;
    const span = first ? cards.at(-1).getBoundingClientRect().right - firstLeft : 0;
    maxOffset = width ? Math.max(0, span - width + 2) : 0;
    if (active && maxOffset > 2 && cards.length > 1 && !motion.matches) {
      if (!copies.length) {
        copies = cards.map(card => {
          const copy = doc.createElement('div');
          copy.className = card.className;
          Object.assign(copy.dataset, card.dataset, { carouselClone: 'true' });
          copy.setAttribute('aria-hidden', 'true');
          copy.append(...Array.from(card.childNodes, node => node.cloneNode(true)));
          return copy;
        });
        track.append(...copies);
      }
      period = copies[0].getBoundingClientRect().left - first.getBoundingClientRect().left;
    } else {
      removeCopies();
      period = 0;
    }
    if (!press) offset = bounded(offset);
    viewport.classList.toggle('is-overflowing', maxOffset > 2);
    viewport.classList.toggle('is-looping', period > 0);
    paint();
    revealFocusedCard();
    syncAnimation();
  }

  function onPointerDown(event) {
    if (press || !active || maxOffset <= 2 || event.isPrimary === false || event.button !== 0) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: bounded(offset),
      lastX: event.clientX, time: event.timeStamp, started: false };
    speed = 0;
    stopFrame();
  }

  function onPointerMove(event) {
    if (!press || event.pointerId !== press.id) return;
    if (event.pointerType !== 'touch' && event.buttons === 0) {
      finishPointer(event, true);
      return;
    }
    const distance = press.x - event.clientX;
    if (!press.started) {
      const vertical = Math.abs(press.y - event.clientY);
      if (event.pointerType === 'touch' && vertical >= DRAG_THRESHOLD && vertical > Math.abs(distance)) {
        finishPointer(event, true);
        return;
      }
      if (Math.abs(distance) < DRAG_THRESHOLD) return;
      press.started = true;
      viewport.classList.add('is-dragging');
      try { viewport.setPointerCapture(event.pointerId); } catch {}
    }
    if (event.cancelable) event.preventDefault();
    const velocity = (press.lastX - event.clientX) / Math.max(8, event.timeStamp - press.time);
    speed = Math.max(-MAX_INERTIA_SPEED, Math.min(MAX_INERTIA_SPEED, speed * .35 + velocity * .26));
    press.lastX = event.clientX;
    press.time = event.timeStamp;
    offset = press.origin + distance;
    queueFrame();
  }

  function finishPointer(event, cancelled = false) {
    if (!press || (event && event.pointerId !== press.id)) return;
    const { id, started, time } = press;
    press = null;
    viewport.classList.remove('is-dragging');
    if (started) {
      suppressedPointer = id;
      try { if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch {}
      offset = bounded(offset);
      paint();
    }
    if (event && event.pointerType !== 'touch' && Number.isFinite(event.clientY)) {
      const bounds = viewport.getBoundingClientRect();
      hovered = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    }
    if (cancelled || hovered || motion.matches || !started || (event && event.timeStamp - time > 85)) speed = 0;
    stopFrame();
    syncAnimation();
  }

  viewport.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch') return;
    if (event.buttons === 0) finishPointer(event, true);
    hovered = true;
    if (!press) speed = 0;
    syncAnimation();
  }, { signal });
  viewport.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return;
    hovered = false;
    syncAnimation();
  }, { signal });
  viewport.addEventListener('pointerdown', onPointerDown, { signal });
  doc.addEventListener('pointerdown', event => {
    keyboard = false;
    if (event.isPrimary !== false && event.button === 0) {
      if (press?.id === event.pointerId) finishPointer(null, true);
      suppressedPointer = null;
    }
    syncAnimation();
  }, { capture: true, signal });
  doc.addEventListener('keydown', () => { keyboard = true; revealFocusedCard(); syncAnimation(); }, { capture: true, signal });
  win.addEventListener('pointermove', onPointerMove, { capture: true, passive: false, signal });
  win.addEventListener('pointerup', event => finishPointer(event), { capture: true, signal });
  win.addEventListener('pointercancel', event => finishPointer(event, true), { capture: true, signal });
  win.addEventListener('blur', () => finishPointer(null, true), { signal });
  viewport.addEventListener('lostpointercapture', event => finishPointer(event, true), { signal });
  viewport.addEventListener('click', event => {
    if (suppressedPointer === null || event.detail === 0 || (event.pointerId > 0 && event.pointerId !== suppressedPointer)) return;
    suppressedPointer = null;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, signal });
  viewport.addEventListener('wheel', event => {
    if (press || maxOffset <= 2 || event.ctrlKey) return;
    const delta = event.shiftKey && !event.deltaX ? event.deltaY
      : Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : 0;
    if (!delta) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
    offset = bounded(offset + delta * scale);
    speed = 0;
    paint();
  }, { passive: false, signal });
  viewport.addEventListener('focusin', () => { revealFocusedCard(); syncAnimation(); }, { signal });
  viewport.addEventListener('focusout', () => win.queueMicrotask(syncAnimation), { signal });
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) finishPointer(null, true);
    syncAnimation();
  }, { signal });
  motion.addEventListener('change', measure, { signal });

  const resize = new win.ResizeObserver(measure);
  resize.observe(viewport);
  const intersection = new win.IntersectionObserver(([entry]) => {
    inView = entry.intersectionRatio >= .5;
    syncAnimation();
  }, { threshold: .5 });
  intersection.observe(viewport);

  return {
    setActive(value) {
      if (signal.aborted || active === value) return;
      active = value;
      if (!active) { hovered = false; speed = 0; finishPointer(null, true); }
      measure();
    },
    refresh() {
      finishPointer(null, true);
      removeCopies();
      cards = Array.from(track.children);
      offset = 0;
      measure();
    },
    dispose() {
      active = false;
      finishPointer(null, true);
      stopFrame();
      listeners.abort();
      resize.disconnect();
      intersection.disconnect();
    },
  };
}

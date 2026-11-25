import { icon } from '../../icons.js';
import { createTopicCarousel } from './topic-carousel.js';
import { mountWelcomeSky } from './welcome-sky.js';

function paintCard(button, item) {
  button.dataset.action = item.action;
  button.querySelector('.welcome-card-icon').innerHTML = icon(item.icon);
  button.querySelector('strong').textContent = item.label;
  const subtitle = button.querySelector('small');
  subtitle.textContent = item.description;
  subtitle.hidden = !item.description;
}

function createInteractiveGlobe(planet) {
  if (!planet || typeof planet.querySelectorAll !== 'function') {
    return { setActive() {}, dispose() {} };
  }
  const win = planet.ownerDocument?.defaultView;
  const meridians = [...planet.querySelectorAll('.planet-meridian')].slice(0, 6);
  const satellite = planet.querySelector('.planet-satellite');
  if (!meridians.length || !win?.requestAnimationFrame) {
    return { setActive() {}, dispose() {} };
  }
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const BASE_SPEED = 0.00024; // rad/ms (~26s per full rotation)
  const MAX_SPEED = 0.012;
  let angle = 0;
  let satAngle = 145;
  let velocity = BASE_SPEED;
  let active = false;
  let raf = 0;
  let lastTime = 0;
  let dragging = false;
  let dragged = false;
  let lastX = 0;
  let lastMoveTime = 0;
  let activePointerId = null;

  function paint() {
    const step = Math.PI / meridians.length;
    for (let i = 0; i < meridians.length; i += 1) {
      const phase = ((angle + i * step) % Math.PI + Math.PI) % Math.PI;
      const sx = Math.cos(phase);
      const visibility = Math.sin(phase);
      meridians[i].style.transform = `scaleX(${sx.toFixed(4)})`;
      meridians[i].style.opacity = (0.14 + visibility * 0.68).toFixed(3);
    }
    if (satellite) {
      satellite.style.transform = `rotate(${satAngle.toFixed(2)}deg)`;
    }
  }

  function tick(now) {
    raf = 0;
    if (!active || reduced?.matches) return;
    const dt = lastTime ? Math.min(48, now - lastTime) : 16;
    lastTime = now;
    if (!dragging) {
      angle += velocity * dt;
      satAngle = (satAngle + dt * (0.019 + Math.abs(velocity - BASE_SPEED) * 18)) % 360;
      const decay = Math.exp(-dt / 620);
      velocity = BASE_SPEED + (velocity - BASE_SPEED) * decay;
      if (Math.abs(velocity - BASE_SPEED) < 0.00001) velocity = BASE_SPEED;
    }
    paint();
    raf = win.requestAnimationFrame(tick);
  }

  function start() {
    if (!active || reduced?.matches || raf) return;
    lastTime = 0;
    raf = win.requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) {
      win.cancelAnimationFrame(raf);
      raf = 0;
    }
    lastTime = 0;
  }

  function onPointerDown(event) {
    if (event.button !== 0 || reduced?.matches) return;
    dragging = true;
    dragged = false;
    activePointerId = event.pointerId;
    lastX = event.clientX;
    lastMoveTime = win.performance?.now?.() || Date.now();
    planet.classList.add('is-dragging');
    try { planet.setPointerCapture?.(event.pointerId); } catch {}
    start();
  }

  function onPointerMove(event) {
    if (!dragging || event.pointerId !== activePointerId) return;
    const now = win.performance?.now?.() || Date.now();
    const dx = event.clientX - lastX;
    const dt = Math.max(8, now - lastMoveTime);
    if (Math.abs(dx) > 2) dragged = true;
    lastX = event.clientX;
    lastMoveTime = now;
    const deltaAngle = dx * 0.018;
    angle += deltaAngle;
    satAngle = (satAngle + dx * 0.65) % 360;
    velocity = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, deltaAngle / dt));
    paint();
  }

  function endDrag(event) {
    if (!dragging || (event && event.pointerId !== activePointerId)) return;
    dragging = false;
    planet.classList.remove('is-dragging');
    try { planet.releasePointerCapture?.(activePointerId); } catch {}
    activePointerId = null;
    if (!dragged) {
      // Gentle flick impulse on tap/click
      const dir = velocity < -BASE_SPEED ? -1 : 1;
      velocity = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, velocity + dir * 0.0052));
    }
    start();
  }

  planet.addEventListener('pointerdown', onPointerDown);
  planet.addEventListener('pointermove', onPointerMove);
  planet.addEventListener('pointerup', endDrag);
  planet.addEventListener('pointercancel', endDrag);
  paint();

  return {
    setActive(next) {
      active = Boolean(next);
      if (active) start();
      else stop();
    },
    dispose() {
      stop();
      planet.removeEventListener('pointerdown', onPointerDown);
      planet.removeEventListener('pointermove', onPointerMove);
      planet.removeEventListener('pointerup', endDrag);
      planet.removeEventListener('pointercancel', endDrag);
    },
  };
}

export function createWelcomeView(root, { createCarousel = createTopicCarousel, mountSky = mountWelcomeSky } = {}) {
  const template = root.querySelector('#welcome-card').content.firstElementChild;
  const start = root.querySelector('.welcome-start');
  const primary = template.cloneNode(true);
  primary.classList.add('welcome-primary');
  primary.querySelector('.welcome-card-end').innerHTML = icon('arrow-right');
  start.prepend(primary);
  const secondary = start.querySelector('.welcome-secondary');
  const viewport = root.querySelector('#welcome-carousel');
  const track = viewport.querySelector('.welcome-carousel-track');
  const carousel = createCarousel({ viewport, track });
  mountSky(root.ownerDocument?.querySelector?.('#welcome-sky') || root.querySelector('.welcome-sky'));
  const globe = createInteractiveGlobe(root.querySelector('.atlas-planet'));
  const empty = root.querySelector('#welcome-topics-empty');
  let previousTopics;
  let previousKind;

  function render(welcome) {
    const topicsKey = JSON.stringify(welcome.topics.map(({ id, label, description, icon }) => [id, label, description, icon]));
    if (topicsKey !== previousTopics) {
      previousTopics = topicsKey;
      empty.hidden = Boolean(welcome.topics.length);
      viewport.hidden = !welcome.topics.length;
      track.replaceChildren(...welcome.topics.map(topic => {
        const button = template.cloneNode(true);
        button.classList.add('welcome-topic');
        button.dataset.topicId = topic.id;
        button.title = [topic.label, topic.description].filter(Boolean).join(' · ');
        button.querySelector('.welcome-card-end').remove();
        paintCard(button, topic);
        return button;
      }));
      carousel.refresh();
    }
    if (welcome.kind === previousKind) return;
    previousKind = welcome.kind;
    root.querySelector('#welcome-title').textContent = welcome.title;
    root.querySelector('[data-welcome-subtitle]').textContent = welcome.subtitle;
    paintCard(primary, welcome.primary);
    primary.id = welcome.primary.action === 'summarize-page' ? 'summarize-page' : 'welcome-primary';
    secondary.hidden = !welcome.secondary;
    secondary.dataset.prompt = welcome.secondary?.prompt || '';
    secondary.title = welcome.secondary?.description || '';
    secondary.querySelector('span').textContent = welcome.secondary?.label || '';
  }

  return {
    render,
    setActive(next) {
      carousel.setActive(next);
      globe.setActive(next);
    },
    dispose() {
      globe.dispose();
      carousel.dispose();
    },
  };
}

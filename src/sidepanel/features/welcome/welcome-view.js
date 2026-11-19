import { icon } from '../../icons.js';

function paintCard(button, item) {
  button.dataset.action = item.action;
  button.querySelector('.welcome-card-icon').innerHTML = icon(item.icon);
  button.querySelector('strong').textContent = item.label;
  button.querySelector('small').textContent = item.description;
  button.setAttribute('aria-label', `${item.label}：${item.description}`);
}

export function createWelcomeView(root) {
  const template = root.querySelector('#welcome-card').content.firstElementChild;
  const start = root.querySelector('.welcome-start');
  const primary = template.cloneNode(true);
  primary.classList.add('welcome-primary');
  primary.querySelector('.welcome-card-end').innerHTML = icon('arrow-right');
  start.prepend(primary);
  const secondary = start.querySelector('.welcome-secondary');
  const carousel = root.querySelector('#welcome-carousel');
  const track = carousel.querySelector('.welcome-carousel-track');
  const pause = root.querySelector('.welcome-orbit-pause');
  const pauseIcon = pause.querySelector('[data-icon]');
  let paused = false, dragging = false, offset = 0, draggingFrom = 0;
  let settleTimer = 0, resumeTimer = 0;
  const normalize = () => {
    const width = track.scrollWidth / 2;
    if (width > 0) offset = ((offset % width) + width) % width;
    track.style.transform = `translate3d(${-offset}px, 0, 0)`;
  };
  const stepSize = () => {
    const cards = [...track.querySelectorAll('.welcome-topic')];
    if (!cards[0] || !cards[1]) return 156;
    return cards[1].getBoundingClientRect().left - cards[0].getBoundingClientRect().left;
  };
  pause.addEventListener('click', () => {
    paused = pause.getAttribute('aria-pressed') !== 'true';
    pause.setAttribute('aria-pressed', String(paused));
    pauseIcon.dataset.icon = paused ? 'play' : 'pause';
    pauseIcon.innerHTML = icon(paused ? 'play' : 'pause');
    pause.title = paused ? '继续话题巡游' : '暂停话题巡游';
    pause.setAttribute('aria-label', pause.title);
    carousel.dataset.paused = String(paused);
  });
  const pauseForPointer = event => {
    if (event.type === 'pointerdown') { dragging = true; draggingFrom = event.clientX + offset; carousel.setPointerCapture?.(event.pointerId); return; }
    if (event.type === 'pointermove' && dragging) { offset = draggingFrom - event.clientX; normalize(); return; }
    if (dragging && event.type === 'pointerup') {
      dragging = false;
      offset = Math.round(offset / step) * step;
      track.classList.add('is-settling');
      normalize();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => track.classList.remove('is-settling'), 450);
      return;
    }
    dragging = false;
  };
  carousel.addEventListener('pointerdown', pauseForPointer);
  carousel.addEventListener('pointermove', pauseForPointer);
  carousel.addEventListener('pointerup', pauseForPointer);
  carousel.addEventListener('pointercancel', pauseForPointer);
  carousel.addEventListener('pointerleave', () => { dragging = false; });
  carousel.addEventListener('focusin', () => { carousel.dataset.focusWithin = 'true'; });
  carousel.addEventListener('focusout', event => { if (!carousel.contains(event.relatedTarget)) carousel.dataset.focusWithin = 'false'; });
  carousel.addEventListener('mouseenter', () => { carousel.dataset.hovering = 'true'; clearTimeout(resumeTimer); });
  carousel.addEventListener('mouseleave', () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { carousel.dataset.hovering = 'false'; }, 1200);
  });
  carousel.addEventListener('wheel', event => {
    if (Math.abs(event.deltaY) < 1) return;
    event.preventDefault(); offset += event.deltaY; normalize();
  }, { passive: false });
  track.addEventListener('animationend', () => {
    if (paused || dragging) return;
    const width = track.scrollWidth / 2;
    offset = width > 0 ? ((offset + stepSize()) % width + width) % width : 0;
    track.classList.add('is-resetting');
    track.style.transform = `translate3d(${-offset}px, 0, 0)`;
    void track.offsetWidth;
    requestAnimationFrame(() => track.classList.remove('is-resetting'));
  });
  let previousKind, previousSignature = '', topicsMounted = false;

  return function render(welcome) {
    const signature = `${welcome.weekday}|${welcome.dateLabel}`;
    if (welcome.kind === previousKind && signature === previousSignature) return;
    previousKind = welcome.kind;
    previousSignature = signature;
    root.querySelector('#welcome-title').textContent = welcome.title;
    root.querySelector('[data-welcome-subtitle]').textContent = welcome.subtitle;
    paintCard(primary, welcome.primary);
    primary.id = welcome.primary.action === 'summarize-page' ? 'summarize-page' : 'welcome-primary';
    secondary.hidden = !welcome.secondary;
    secondary.dataset.prompt = welcome.secondary?.prompt || '';
    secondary.title = welcome.secondary?.description || '';
    secondary.querySelector('span').textContent = welcome.secondary?.label || '';

    if (!topicsMounted) {
      const build = (topic, copy) => {
        const button = template.cloneNode(true);
        button.classList.add('welcome-topic');
        button.dataset.topicId = topic.id;
        if (copy) { button.dataset.marqueeCopy = ''; button.setAttribute('aria-hidden', 'true'); button.tabIndex = -1; }
        button.querySelector('.welcome-card-end').textContent = String(welcome.topics.indexOf(topic) + 1).padStart(2, '0');
        paintCard(button, topic);
        return button;
      };
      const copies = [...welcome.topics, ...welcome.topics].map((topic, index) => build(topic, index >= welcome.topics.length));
      track.append(...copies);
      const samples = [...track.querySelectorAll('.welcome-topic')];
      const gap = samples[0] && samples[1] ? samples[1].getBoundingClientRect().left - samples[0].getBoundingClientRect().right : 8;
      if (samples[0]?.getBoundingClientRect?.().width) track.style.setProperty('--carousel-step', `${samples[0].getBoundingClientRect().width + gap}px`);
      offset = 0;
      normalize();
      topicsMounted = true;
    }
  };
}

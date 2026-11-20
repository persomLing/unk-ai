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

  return { render, setActive: carousel.setActive, dispose: carousel.dispose };
}

import { allowsMotion, playMotion, reveal } from '../../core/motion.js';

export function transitionReplyPhase(previous, next) {
  const region = previous.parentElement;
  region.querySelector('.reply-phase-exit')?.remove();
  if (allowsMotion(previous)) {
    const snapshot = previous.cloneNode(true);
    snapshot.classList.add('reply-phase-exit');
    snapshot.inert = true;
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.removeAttribute('data-activity-phase');
    snapshot.removeAttribute('data-message-progress');
    snapshot.removeAttribute('data-request-phase');
    snapshot.style.top = `${previous.offsetTop}px`;
    region.append(snapshot);
    playMotion(snapshot.querySelector('[data-progress-text]'), 'phase-label-exit', [
      { translate: '0 0' }, { translate: '0 -4px' },
    ], { duration: 120 });
    const leaving = playMotion(snapshot, 'phase-exit', [{ opacity: 0.8 }, { opacity: 0 }], { duration: 125 });
    leaving.finished.then(() => snapshot.remove(), () => snapshot.remove());
  }
  previous.replaceWith(next);
  reveal(next.querySelector('[data-progress-text]'), 'phase-label-enter', { distance: 4, duration: 155 });
  reveal(next.querySelector('.thinking-phase-icon'), 'phase-icon-enter', { duration: 145 });
}

export function finishReplyMotion(article, hadCursor) {
  const actions = article.querySelector(':scope > .message-actions');
  reveal(actions, 'reply-actions', { distance: 3, delay: 42, duration: 160 });
  reveal(article.querySelector('[data-message-elapsed]'), 'reply-elapsed', { distance: 3, duration: 170 });
  const content = article.querySelector('[data-message-content]');
  if (!hadCursor || !allowsMotion(content)) return;
  const cursor = content.ownerDocument.createElement('span');
  cursor.className = 'reply-cursor-exit';
  cursor.setAttribute('aria-hidden', 'true');
  content.append(cursor);
  const leaving = playMotion(cursor, 'reply-cursor-exit', [{ opacity: 0.76 }, { opacity: 0 }], { duration: 145 });
  leaving.finished.then(() => cursor.remove(), () => cursor.remove());
}

export function revealSuggestions(node, delay) {
  reveal(node?.querySelector('.try-next-label'), 'suggestions-enter', { distance: 6, delay });
  node?.querySelectorAll('.try-next-chip').forEach((chip, index) => {
    reveal(chip, 'suggestion-enter', { distance: 6, delay: delay + index * 40 });
  });
}

export function revealGeneratedImage(image, { delay = 0, reservedHeight = 0 } = {}) {
  if (!allowsMotion(image)) return;
  const media = image.parentElement;
  const height = media.offsetHeight;
  if (reservedHeight > 0 && height > 0 && Math.abs(height - reservedHeight) > 1) {
    playMotion(media, 'image-resize', [
      { height: `${reservedHeight}px`, overflow: 'clip' }, { height: `${height}px`, overflow: 'clip' },
    ], { duration: 210 });
  }
  function revealImage() {
    media.classList.remove('is-decoding');
    if (!image.isConnected || !image.naturalWidth) return;
    const fade = reveal(image, 'image-ready', { duration: 230, delay });
    if (!fade) return;
    media.classList.add('is-revealing');
    const finish = () => media.classList.remove('is-revealing');
    fade.finished.then(finish, finish);
  }
  if (image.complete) revealImage();
  else {
    media.classList.add('is-decoding');
    image.decode().then(revealImage, revealImage);
  }
}

import { reveal } from '../../core/motion.js';
import { icon } from '../../icons.js';

const pending = new WeakMap();

export function showCopied(button, { lock = false } = {}) {
  clearTimeout(pending.get(button));
  if (button.dataset) button.dataset.copied = 'true';
  if (lock) button.disabled = true;
  button.classList?.remove('is-copied');
  void button.offsetWidth;
  button.classList?.add('is-copied');
  button.innerHTML = icon('check');
  reveal(button.firstElementChild, 'copy-confirmation', { scale: 0.72, duration: 145 });
  const timer = setTimeout(() => {
    pending.delete(button);
    if (button.isConnected) {
      if (button.dataset) delete button.dataset.copied;
      if (lock) button.disabled = false;
      button.classList?.remove('is-copied');
      button.innerHTML = icon('copy');
    }
  }, 1500);
  timer.unref?.();
  pending.set(button, timer);
}

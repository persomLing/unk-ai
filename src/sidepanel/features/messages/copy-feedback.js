import { reveal } from '../../core/motion.js';
import { icon } from '../../icons.js';

const pending = new WeakMap();

export function showCopied(button) {
  clearTimeout(pending.get(button));
  button.innerHTML = icon('check');
  reveal(button.firstElementChild, 'copy-confirmation', { scale: 0.72, duration: 145 });
  const timer = setTimeout(() => {
    pending.delete(button);
    if (button.isConnected) button.innerHTML = icon('copy');
  }, 1500);
  timer.unref?.();
  pending.set(button, timer);
}

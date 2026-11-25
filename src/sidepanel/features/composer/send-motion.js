import { allowsMotion, playMotion } from '../../core/motion.js';

export function createSendMotion({ send, stop }) {
  let busy = false;
  let transition;
  let halo;

  function sync(next) {
    if (next === busy) return;
    busy = next;
    transition?.();
    const button = busy ? stop : send;
    if (!allowsMotion(button)) return;
    const glyph = button.firstElementChild;
    const previous = (busy ? send : stop).firstElementChild.cloneNode(true);
    previous.classList.add('send-glyph-out');
    const dot = button.ownerDocument.createElement('span');
    dot.className = 'send-glyph-dot';
    dot.setAttribute('aria-hidden', 'true');
    button.append(previous, dot);
    const press = playMotion(button, 'send-rebound', [{ scale: 0.94 }, { scale: 1.045, offset: 0.6 }, { scale: 1 }], { duration: 210 });
    const launch = busy
      ? [{ opacity: 1, transform: 'translate(0, 0) scale(1)' }, { opacity: 0.9, transform: 'translate(2px, -4px) scale(0.55)', offset: 0.65 }, { opacity: 0, transform: 'translate(4px, -8px) scale(0.2)' }]
      : [{ opacity: 1, scale: 1 }, { opacity: 0.85, scale: 0.2, offset: 0.75 }, { opacity: 0, scale: 0.12 }];
    const shrink = playMotion(previous, 'send-glyph-shrink', launch, { duration: 115 });
    const midpoint = playMotion(dot, 'send-glyph-dot', [{ opacity: 0 }, { opacity: 0.9, offset: 0.45 }, { opacity: 0 }],
      { delay: 50, duration: 95, fill: 'backwards' });
    const expand = playMotion(glyph, 'send-glyph-expand', [{ opacity: 0, scale: 0.22 }, { opacity: 1, scale: 1 }],
      { delay: 102, duration: 118, fill: 'backwards' });
    const remove = () => { previous.remove(); dot.remove(); };
    expand.finished.then(remove, remove);
    transition = () => { for (const animation of [press, shrink, midpoint, expand]) animation.cancel(); remove(); };
  }

  function accepted() {
    halo?.();
    const controls = send.parentElement;
    if (!allowsMotion(controls)) return;
    const ring = controls.ownerDocument.createElement('span');
    ring.className = 'send-accepted-ring';
    ring.setAttribute('aria-hidden', 'true');
    controls.append(ring);
    const animation = playMotion(ring, 'send-accepted', [{ opacity: 0.4, scale: 0.98 }, { opacity: 0, scale: 1.2 }], { duration: 340 });
    animation.finished.then(() => ring.remove(), () => ring.remove());
    halo = () => { animation.cancel(); ring.remove(); };
  }

  return { sync, accepted, dispose: () => { transition?.(); halo?.(); } };
}

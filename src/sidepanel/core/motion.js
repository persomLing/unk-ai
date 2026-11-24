const EASE_OUT = 'cubic-bezier(.2,.75,.25,1)';

export function allowsMotion(node) {
  const view = node?.ownerDocument?.defaultView;
  return Boolean(node?.animate && !view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function playMotion(node, name, keyframes, options) {
  if (!allowsMotion(node)) return null;
  const animation = node.animate(keyframes, { easing: EASE_OUT, ...options });
  animation.id = name;
  return animation;
}

export function reveal(node, name, { distance = 0, scale = 1, delay = 0, duration = 180 } = {}) {
  return playMotion(node, name, [
    { opacity: 0, translate: `0 ${distance}px`, scale },
    { opacity: 1, translate: '0 0', scale: 1 },
  ], { duration, delay, fill: 'backwards' });
}

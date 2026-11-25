import { COMPANION_GESTURES, createCompanionPainter } from './reading-companion-art.js';

/** A local UI projection. The composer owns the draft, selection and submission. */
export function createReadingCompanion({ button, panel, input, messages, occluders }) {
  const document = button.ownerDocument;
  const win = document.defaultView;
  const root = document.documentElement;
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  const controller = new AbortController();
  const listener = { signal: controller.signal };
  const passive = { ...listener, passive: true };
  const paint = createCompanionPainter(button.querySelector('canvas'), button.querySelector('.companion-hit'));
  if (!paint) {
    button.hidden = true;
    return { accepted() {}, dispose() {} };
  }
  const gestures = Object.keys(COMPANION_GESTURES);
  const since = Object.fromEntries(gestures.map(key => [key, -Infinity]));
  const pose = { x: 0, y: 0, curious: 0 };
  let aim = { x: 0, y: 0 };
  let selectionGaze = { x: 0, y: -1 };
  let origin, raf, previous, blinkStart, blinkTimer, typingTimer, hoverTimer, selectionTimer, whisperTimer, pokeResetTimer;
  let composing = false, typing = false, marked = false, inView = false, animated = false;
  let pokeCount = 0;
  let lastTheme = root.dataset.theme || 'light';
  const perch = button.parentElement;
  const whisper = perch ? document.createElement('span') : null;
  if (whisper) {
    whisper.className = 'companion-whisper';
    whisper.setAttribute('aria-hidden', 'true');
    whisper.hidden = true;
    perch.append(whisper);
  }

  function pickWhisper(pokes) {
    if (pokes >= 5) return '再点就要躲进书页里了…';
    if (pokes === 4) return '好啦好啦，我在认真看呢 ✨';
    const hour = new Date().getHours();
    const pool = hour < 6 || hour >= 23
      ? ['夜深了，记得护眼呀', '点灯夜读，陪你再看一篇', '慢慢读，不着急']
      : hour < 12
        ? ['早安，今天想翻哪一页？', '刚泡好茶，想了解点什么？', '随时听你差遣']
        : hour < 18
          ? ['午后好，顺手整理点资料？', '有意思的段落随时喊我', '正在翻书待命…']
          : ['傍晚好，今天收获怎么样？', '随时帮你划重点', '我在，直接问就好'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function showWhisper(text) {
    if (!whisper || !inView || root.dataset.companion === 'off') return;
    if (!occluders.every(element => element.hidden)) return;
    win.clearTimeout(whisperTimer);
    whisper.textContent = text;
    whisper.hidden = false;
    whisper.classList.remove('is-visible');
    void whisper.offsetWidth;
    whisper.classList.add('is-visible');
    whisperTimer = win.setTimeout(() => {
      whisper.classList.remove('is-visible');
      whisperTimer = win.setTimeout(() => { whisper.hidden = true; }, 220);
    }, 2200);
  }

  function draw(now) {
    paint({ now, pose, since, blinkStart, selectionGaze });
  }

  function wake() {
    if (animated && !raf) raf = win.requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    if (!animated) return;
    const elapsed = previous ? Math.min(60, now - previous) : 16;
    const follow = 1 - Math.exp(-elapsed / 85);
    const lean = 1 - Math.exp(-elapsed / 125);
    const x = typing ? -0.75 : aim.x;
    const y = typing ? 0.8 : aim.y;
    pose.x += (x - pose.x) * follow;
    pose.y += (y - pose.y) * follow;
    pose.curious += (Number(typing) - pose.curious) * lean;
    if (now - blinkStart > 155) blinkStart = 0;
    draw(now);
    previous = now;
    if (Math.abs(x - pose.x) + Math.abs(y - pose.y) + Math.abs(Number(typing) - pose.curious) > 0.007
        || blinkStart || gestures.some(key => now - since[key] < COMPANION_GESTURES[key])) wake();
    else previous = 0;
  }

  function play(key) {
    const now = win.performance.now();
    if (!animated || now - since.shy < COMPANION_GESTURES.shy || now - since[key] < COMPANION_GESTURES[key]) return;
    since[key] = now;
    wake();
  }

  function scheduleBlink() {
    blinkTimer = win.setTimeout(() => {
      if (!animated) return;
      const now = win.performance.now();
      if (now - since.shy > COMPANION_GESTURES.shy && !typing) {
        blinkStart = now;
        wake();
      }
      scheduleBlink();
    }, 4600 + Math.random() * 3400);
  }

  function rest() {
    win.cancelAnimationFrame(raf);
    for (const timer of [blinkTimer, typingTimer, hoverTimer, selectionTimer]) win.clearTimeout(timer);
    previous = raf = blinkStart = 0;
    for (const key of gestures) since[key] = -Infinity;
    typing = marked = false;
    Object.assign(pose, { x: 0, y: 0, curious: 0 });
    aim = { x: 0, y: 0 };
    origin = null;
  }

  function sync() {
    origin = null;
    const mode = root.dataset.companion;
    const canAnimate = mode !== 'static' && mode !== 'off' && !reduced.matches;
    button.disabled = !canAnimate;
    const next = canAnimate && inView && !document.hidden && occluders.every(element => element.hidden);
    if (next === animated) return;
    animated = next;
    rest();
    // Restore the neutral illustration even when switching directly from a gesture to "off".
    draw(win.performance.now());
    if (animated) scheduleBlink();
  }

  function direction(clientX, clientY) {
    if (!origin) {
      const rect = button.getBoundingClientRect();
      origin = { x: rect.left + rect.width * 0.47, y: rect.top + rect.height * 0.53 };
    }
    const dx = clientX - origin.x, dy = clientY - origin.y;
    const distance = Math.max(72, Math.hypot(dx, dy));
    return { x: dx / distance, y: dy / distance };
  }

  panel.addEventListener('pointermove', event => {
    if (!animated || event.pointerType === 'touch') return;
    aim = direction(event.clientX, event.clientY);
    wake();
  }, passive);
  panel.addEventListener('pointerleave', () => { aim = { x: 0, y: 0 }; wake(); }, passive);
  function waitNearby() {
    win.clearTimeout(hoverTimer);
    if (animated) hoverTimer = win.setTimeout(() => play('notice'), 460);
  }
  button.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') waitNearby(); }, passive);
  button.addEventListener('pointerleave', () => win.clearTimeout(hoverTimer), passive);
  button.addEventListener('focus', () => { if (button.matches(':focus-visible')) waitNearby(); }, listener);
  button.addEventListener('blur', () => win.clearTimeout(hoverTimer), listener);
  button.addEventListener('pointerdown', event => {
    if (event.button === 0 && document.activeElement === input) event.preventDefault();
  }, listener);
  button.addEventListener('click', () => {
    win.clearTimeout(hoverTimer);
    play('shy');
    pokeCount += 1;
    win.clearTimeout(pokeResetTimer);
    pokeResetTimer = win.setTimeout(() => { pokeCount = 0; }, 4500);
    button.classList.remove('is-poked');
    void button.offsetWidth;
    button.classList.add('is-poked');
    showWhisper(pickWhisper(pokeCount));
  }, listener);

  function curious() {
    if (!animated) return;
    win.clearTimeout(typingTimer);
    typing = true;
    wake();
    if (!composing) typingTimer = win.setTimeout(() => { typing = false; wake(); }, 950);
  }
  input.addEventListener('input', curious, listener);
  input.addEventListener('compositionstart', () => { composing = true; curious(); }, listener);
  input.addEventListener('compositionend', () => { composing = false; curious(); }, listener);
  input.addEventListener('blur', () => {
    win.clearTimeout(typingTimer);
    composing = typing = false;
    wake();
  }, listener);

  function selectedAnswer() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node.nodeType === 1 ? node : node.parentElement;
    return messages.contains(element) && element?.closest('.assistant-message [data-message-content]') ? range : null;
  }
  document.addEventListener('selectionchange', () => {
    if (!animated) return;
    win.clearTimeout(selectionTimer);
    if (!selectedAnswer()) { marked = false; return; }
    if (marked) return;
    selectionTimer = win.setTimeout(() => {
      const bounds = selectedAnswer()?.getBoundingClientRect();
      if (!bounds) return;
      marked = true;
      selectionGaze = direction(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      play('bookmark');
    }, 180);
  }, listener);

  const visibility = new win.IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); });
  const invalidateOrigin = () => { origin = null; };
  const layout = new win.ResizeObserver(invalidateOrigin);
  const prefs = new win.MutationObserver(mutations => {
    sync();
    for (const mutation of mutations) {
      if (mutation.target === root && mutation.attributeName === 'data-theme') {
        const nextTheme = root.dataset.theme || 'light';
        if (nextTheme !== lastTheme) {
          lastTheme = nextTheme;
          showWhisper(nextTheme === 'dark' ? '点灯夜读 ✨' : '天亮啦，继续阅读');
        }
      }
    }
  });
  visibility.observe(button);
  layout.observe(button);
  layout.observe(button.closest('.composer-area'));
  prefs.observe(root, { attributes: true, attributeFilter: ['data-companion', 'data-theme'] });
  for (const element of occluders) prefs.observe(element, { attributes: true, attributeFilter: ['hidden'] });
  win.addEventListener('resize', invalidateOrigin, passive);
  document.addEventListener('visibilitychange', sync, listener);
  reduced.addEventListener('change', sync, listener);
  draw(win.performance.now());
  sync();
  return {
    accepted() { typing = false; win.clearTimeout(typingTimer); play('turnPage'); },
    dispose() {
      animated = false;
      win.clearTimeout(whisperTimer);
      win.clearTimeout(pokeResetTimer);
      whisper?.remove();
      controller.abort();
      visibility.disconnect();
      layout.disconnect();
      prefs.disconnect();
      rest();
    },
  };
}

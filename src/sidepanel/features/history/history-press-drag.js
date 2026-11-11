// Inline helper. Callbacks are synchronous; keep panel itself mounted when rendering.
export function installPressDrag(panel, {
  canStart = () => true,
  start = () => {},
  move = () => {},
  finish = () => {},
  cancel: onCancel = () => {}
} = {}) {
  const doc = panel.ownerDocument;
  const win = doc.defaultView;
  let press = null;
  let timer = null;
  let disposed = false;
  let suppressedPointer = null;
  let selectionStyle = null;

  function clearTimer() {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  }

  function restorePresentation() {
    if (!selectionStyle) return;
    const { value, priority, hadClass } = selectionStyle;
    selectionStyle = null;
    if (value) panel.style.setProperty('user-select', value, priority);
    else panel.style.removeProperty('user-select');
    if (!hadClass) panel.classList.remove('is-press-drag');
  }

  function end(kind, point) {
    const previous = press;
    press = null;
    clearTimer();
    if (!previous) return;
    if (!previous.started) return;
    suppressedPointer = previous.pointerId;
    restorePresentation();
    try {
      if (panel.hasPointerCapture?.(previous.pointerId)) {
        panel.releasePointerCapture(previous.pointerId);
      }
    } catch {}
    // Cleanup precedes callbacks: a callback may render or begin another interaction.
    if (kind === 'finish') finish(point || { x: previous.x, y: previous.y });
    else onCancel();
  }

  function cancel() {
    end('cancel');
  }

  function activate(expected) {
    timer = null;
    if (disposed || press !== expected) return;
    if (!panel.contains(expected.source) || expected.source.disabled || !canStart()) {
      press = null;
      return;
    }
    expected.started = true;
    suppressedPointer = expected.pointerId;
    selectionStyle = {
      value: panel.style.getPropertyValue('user-select'),
      priority: panel.style.getPropertyPriority('user-select'),
      hadClass: panel.classList.contains('is-press-drag')
    };
    panel.style.setProperty('user-select', 'none');
    panel.classList.add('is-press-drag');
    doc.getSelection()?.removeAllRanges();
    // Capture on the stable root, never on a row that start() may replace.
    try { panel.setPointerCapture(expected.pointerId); } catch {}
    try {
      start(expected.chatId, {
        x: expected.x,
        y: expected.y,
        pointerId: expected.pointerId
      });
    } catch (error) {
      cancel();
      throw error;
    }
  }

  function onPointerDown(event) {
    // A fresh physical click must not be consumed by an earlier drag that produced no click.
    if (event.isPrimary !== false && event.button === 0 && !press?.started) {
      suppressedPointer = null;
    }
    if (disposed || !panel.contains(event.target)) return;
    if (event.button !== 0 || event.isPrimary === false) {
      if (press && !press.started) cancel();
      return;
    }
    if (press) return;
    const source = event.target.closest?.('button[data-open-chat]');
    if (!source || !panel.contains(source) || source.disabled || !canStart()) return;
    const expected = {
      pointerId: event.pointerId,
      chatId: source.dataset.openChat,
      source,
      x: event.clientX,
      y: event.clientY,
      originX: event.clientX,
      originY: event.clientY,
      started: false
    };
    press = expected;
    timer = win.setTimeout(() => activate(expected), 350);
  }

  function onPointerMove(event) {
    if (!press || event.pointerId !== press.pointerId) return;
    press.x = event.clientX;
    press.y = event.clientY;
    if (!press.started) {
      if (Math.hypot(press.x - press.originX, press.y - press.originY) > 6) cancel();
      return;
    }
    if (event.cancelable) event.preventDefault();
    move({ x: press.x, y: press.y });
  }

  function onPointerUp(event) {
    if (!press || event.pointerId !== press.pointerId) return;
    if (press.started && event.cancelable) event.preventDefault();
    end('finish', { x: event.clientX, y: event.clientY });
  }

  function onPointerCancel(event) {
    if (press && event.pointerId === press.pointerId) cancel();
  }

  function onLostCapture(event) {
    if (press?.started && event.pointerId === press.pointerId) cancel();
  }

  function onClick(event) {
    // Keyboard activation (detail === 0) stays available. Suppress only the release click.
    if (suppressedPointer === null || event.detail === 0) return;
    if (event.pointerId > 0 && event.pointerId !== suppressedPointer) return;
    suppressedPointer = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onContextMenu(event) {
    if (panel.contains(event.target) && press) cancel();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !press) return;
    const wasDragging = press.started;
    cancel();
    if (wasDragging) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onVisibilityChange() {
    if (doc.hidden) cancel();
  }

  const registrations = [
    [doc, 'pointerdown', onPointerDown, true],
    [doc, 'pointermove', onPointerMove, { capture: true, passive: false }],
    [doc, 'pointerup', onPointerUp, true],
    [doc, 'pointercancel', onPointerCancel, true],
    [panel, 'lostpointercapture', onLostCapture, true],
    [doc, 'click', onClick, true],
    [doc, 'contextmenu', onContextMenu, true],
    [doc, 'keydown', onKeyDown, true],
    [doc, 'visibilitychange', onVisibilityChange, false],
    [win, 'blur', cancel, false]
  ];
  registrations.forEach(([target, type, listener, options]) => {
    target.addEventListener(type, listener, options);
  });

  return {
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      suppressedPointer = null;
      registrations.forEach(([target, type, listener, options]) => {
        target.removeEventListener(type, listener, options);
      });
    }
  };
}

const DOCK_QUERY = '(min-width: 960px)';

/** Reuses one history drawer; presentation changes never rebuild its contents. */
export function createHistoryLayout({ app, drawer, backdrop, trigger, closeButton, searchInput,
  window = globalThis.window, onOpenChange = () => {} }) {
  const media = window.matchMedia(DOCK_QUERY);
  const document = drawer.ownerDocument;
  let wide = null, open = false, disposed = false;

  function apply(nextOpen, { focus = false, notify = false } = {}) {
    if (disposed) return;
    const changed = open !== nextOpen;
    const hiddenFocus = !nextOpen && drawer.contains(document.activeElement);
    open = nextOpen;
    app.classList.toggle('history-docked', wide && open);
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.inert = !open;
    backdrop.hidden = !open || wide;
    trigger.setAttribute('aria-expanded', String(open));
    if (wide) trigger.removeAttribute('aria-haspopup');
    else trigger.setAttribute('aria-haspopup', 'dialog');
    if (closeButton) {
      closeButton.setAttribute('title', wide ? '收起历史侧栏' : '关闭');
      closeButton.setAttribute('aria-label', wide ? '收起历史侧栏' : '关闭侧边栏');
    }
    if (focus) {
      if (open) (searchInput || closeButton)?.focus({ preventScroll: true });
      else trigger.focus({ preventScroll: true });
    } else if (hiddenFocus) trigger.focus({ preventScroll: true });
    if (changed || notify) onOpenChange(open);
  }

  function sync() {
    if (disposed) return;
    const first = wide === null, changedMode = wide !== media.matches;
    wide = media.matches;
    // Closing on shrink avoids turning a visible column into a covering drawer.
    // A new wide interval reopens it even after a previous manual wide close.
    apply(changedMode ? wide : open, { notify: first });
  }

  function setOpen(value, { keepDocked = false } = {}) {
    if (disposed) return;
    if (!value && keepDocked && wide) return;
    apply(Boolean(value), { focus: true });
  }

  media.addEventListener('change', sync);
  sync();
  return Object.freeze({ setOpen, isDocked: () => wide && open, isOpen: () => open, sync,
    dispose() { if (disposed) return; disposed = true; media.removeEventListener('change', sync); } });
}

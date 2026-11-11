/** Own one presenter's source list without owning links, messages or runs. */
export function createSourcePopover({ root, document = root?.ownerDocument } = {}) {
  if (!root || !document) throw new TypeError('来源列表需要正文根节点。');
  const view = document.defaultView;
  const removers = [];
  let active = null;
  let disposed = false;
  const listen = (node, type, handler, options) => {
    if (!node?.addEventListener) return;
    node.addEventListener(type, handler, options);
    removers.push(() => node.removeEventListener(type, handler, options));
  };
  function closeWrapper(wrapper) {
    const popover = wrapper?.querySelector('.sources-popover');
    const button = wrapper?.querySelector('[data-action="toggle-sources"]');
    if (popover) popover.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
    wrapper?.classList.remove('is-open');
  }
  function close({ restoreFocus = false } = {}) {
    if (disposed) return;
    const previous = active;
    active = null;
    if (previous) {
      previous.popover.hidden = true;
      previous.button.setAttribute('aria-expanded', 'false');
      previous.wrapper.classList.remove('is-open');
    }
    root.querySelectorAll('.message-sources.is-open').forEach(closeWrapper);
    if (restoreFocus && previous?.button.isConnected !== false && root.contains(previous?.button)) {
      previous.button.focus?.({ preventScroll: true });
    }
  }
  function sync() {
    if (disposed || !active) return;
    if (active.wrapper.isConnected === false || active.popover.isConnected === false
      || active.button.isConnected === false || !root.contains(active.wrapper)
      || active.wrapper.querySelector('.sources-popover') !== active.popover
      || active.wrapper.querySelector('[data-action="toggle-sources"]') !== active.button
      || active.popover.hidden || !active.wrapper.classList.contains('is-open')) close();
  }
  function isOpen() {
    sync();
    return !disposed && Boolean(active);
  }
  function toggle(button) {
    if (disposed || !button?.matches?.('[data-action="toggle-sources"]')
      || button.isConnected === false || !root.contains(button)) return false;
    sync();
    const wrapper = button.closest('.message-sources');
    const popover = wrapper?.querySelector('.sources-popover');
    if (!wrapper || !popover || !root.contains(wrapper) || popover.isConnected === false) return false;
    const wasOpen = active?.wrapper === wrapper && !popover.hidden;
    close();
    if (wasOpen) return false;
    active = { wrapper, popover, button };
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    wrapper.classList.add('is-open');
    return true;
  }
  listen(document, 'pointerdown', event => {
    if (!isOpen() || active.wrapper.contains(event.target)) return;
    close();
  }, true);
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    const restoreFocus = active.popover.contains(document.activeElement);
    event.preventDefault();
    event.stopImmediatePropagation();
    close({ restoreFocus });
  }, true);
  // Scrolling the source list itself remains usable. Moving its presenter or
  // viewport dismisses it so a detached anchor never floats over the input.
  listen(root, 'scroll', event => {
    if (isOpen() && !active.popover.contains(event.target)) close();
  }, true);
  listen(view, 'resize', () => close());
  listen(view, 'blur', () => close());
  const Observer = view?.MutationObserver;
  const observer = Observer ? new Observer(() => sync()) : null;
  observer?.observe(root, { childList: true, subtree: true });
  return Object.freeze({ toggle, close, sync, isOpen, dispose() {
    if (disposed) return;
    close();
    disposed = true;
    observer?.disconnect();
    removers.forEach(remove => remove());
  } });
}

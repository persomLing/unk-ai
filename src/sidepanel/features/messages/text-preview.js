export const LONG_MESSAGE_CHARACTERS = 160;
export const LONG_MESSAGE_LINES = 6;

export function shouldCollapseMessageText(value) {
  if (typeof value !== 'string') return false;
  return value.length >= LONG_MESSAGE_CHARACTERS || value.split(/\r\n?|\n/).length >= LONG_MESSAGE_LINES;
}

/** Show a fixed text snapshot without changing a message, draft or attachment. */
export function createTextPreview({ document = globalThis.document, onError = () => {},
  fallbackFocus = () => null } = {}) {
  let conversationId = null;
  let active = null;
  let disposed = false;
  const tracked = new Set();
  const window = document.defaultView;

  function measure(target) {
    if (disposed || !target.isConnected) return;
    const content = target.querySelector('[data-text-preview-content]');
    if (!content || content.clientWidth <= 0) return;
    const style = window?.getComputedStyle?.(content);
    const lineHeight = parseFloat(style?.lineHeight) || (parseFloat(style?.fontSize) || 13) * 1.7;
    const collapsed = content.scrollHeight > lineHeight * 5 + 1;
    target.classList.toggle('is-collapsed', collapsed);
    const more = target.querySelector('.user-text-preview-more');
    if (more) more.hidden = !collapsed;
    if (collapsed) {
      target.setAttribute('data-text-preview', 'message');
      target.setAttribute('role', 'button');
      target.setAttribute('tabindex', '0');
      target.setAttribute('aria-haspopup', 'dialog');
      target.setAttribute('aria-label', '查看完整消息');
    } else {
      for (const name of ['data-text-preview', 'role', 'tabindex', 'aria-haspopup', 'aria-label']) target.removeAttribute(name);
    }
  }
  const observer = typeof window?.ResizeObserver === 'function'
    ? new window.ResizeObserver(entries => { if (!disposed) entries.forEach(entry => measure(entry.target)); }) : null;
  function refresh(root = document) {
    if (disposed) return;
    for (const target of tracked) {
      if (!target.isConnected) { observer?.unobserve(target); tracked.delete(target); }
    }
    for (const target of root.querySelectorAll?.('[data-text-preview-candidate]') || []) {
      if (!tracked.has(target)) { tracked.add(target); observer?.observe(target); }
      measure(target);
    }
  }
  const onResize = () => refresh();
  window?.addEventListener('resize', onResize);

  function close({ restoreFocus = true } = {}) {
    const preview = active;
    if (!preview) return;
    active = null;
    preview.removers.forEach(remove => remove());
    if (preview.dialog.open) preview.dialog.close();
    preview.dialog.remove();
    preview.content.textContent = '';
    if (restoreFocus) {
      const target = preview.trigger?.isConnected ? preview.trigger : fallbackFocus();
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  }

  function open({ text, title = '完整消息', trigger = document.activeElement } = {}) {
    if (disposed || typeof text !== 'string' || !text.length) return false;
    close({ restoreFocus: false });
    const dialog = document.createElement('dialog');
    dialog.className = 'text-preview-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'text-preview-title');
    const header = document.createElement('div');
    header.className = 'text-preview-header';
    const heading = document.createElement('h2');
    heading.id = 'text-preview-title';
    heading.className = 'text-preview-title';
    heading.textContent = String(title || '完整消息');
    const closeButton = document.createElement('button');
    closeButton.className = 'text-preview-close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', '关闭文本预览');
    closeButton.title = '关闭文本预览（Esc）';
    header.append(heading, closeButton);
    const content = document.createElement('div');
    content.className = 'text-preview-content';
    content.tabIndex = 0;
    content.setAttribute('role', 'region');
    content.setAttribute('aria-label', '完整文本，可选择复制或滚动查看');
    content.textContent = text;
    dialog.append(header, content);
    const preview = { dialog, content, trigger, removers: [] };
    active = preview;
    const listen = (node, type, handler) => {
      const guarded = event => { if (active === preview) handler(event); };
      node.addEventListener(type, guarded);
      preview.removers.push(() => node.removeEventListener(type, guarded));
    };
    listen(closeButton, 'click', () => close());
    listen(dialog, 'click', event => { if (event.target === dialog) close(); });
    listen(dialog, 'cancel', event => { event.preventDefault(); close(); });
    listen(dialog, 'close', () => close());
    document.body.append(dialog);
    try {
      dialog.showModal();
      closeButton.focus({ preventScroll: true });
      return true;
    } catch {
      close();
      onError('无法打开文本预览，请重试。', 'error');
      return false;
    }
  }

  function previewTarget(event) {
    const target = event.target?.closest?.('[data-text-preview]');
    if (!target?.isConnected) return null;
    const control = event.target?.closest?.('button, a, input, textarea, select, [contenteditable="true"]');
    if (control && control !== target) return null;
    return target;
  }
  function selectingText(target) {
    const selection = document.getSelection?.();
    return selection && !selection.isCollapsed &&
      (target.contains(selection.anchorNode) || target.contains(selection.focusNode));
  }
  function openTarget(target) {
    const content = target.querySelector('[data-text-preview-content]');
    return open({ text: content?.textContent, title: target.getAttribute('data-text-preview-title') || '完整消息', trigger: target });
  }
  function onClick(event) {
    if (event.defaultPrevented || (event.button !== undefined && event.button !== 0)) return;
    const target = previewTarget(event);
    if (target && !selectingText(target) && openTarget(target)) event.preventDefault();
  }
  function onKeyDown(event) {
    if (active && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.defaultPrevented || event.repeat || !['Enter', ' '].includes(event.key)) return;
    const target = previewTarget(event);
    if (target && openTarget(target)) event.preventDefault();
  }
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown, true);
  return {
    open,
    close,
    refresh,
    sync(nextId) {
      const next = nextId ?? null;
      if (conversationId !== next) close({ restoreFocus: false });
      conversationId = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      close({ restoreFocus: false });
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown, true);
      window?.removeEventListener('resize', onResize);
      observer?.disconnect();
      tracked.clear();
    },
  };
}

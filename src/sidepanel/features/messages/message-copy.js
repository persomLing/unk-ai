import { awaitWithTimeout } from '../../../utils/abortable.js';
import { messageCopyContent } from './copy-text.js';

let nextMenuId = 0;

/** Owns only the copy menu and its clipboard wait. Closing cannot undo a
 * clipboard write that the browser has already accepted. */
export function createMessageCopy({ document = globalThis.document, writeText,
  notify = () => {}, timeoutMs = 3000 } = {}) {
  if (!document?.body || typeof writeText !== 'function') {
    throw new TypeError('Message copy needs a document and a clipboard writer.');
  }
  const view = document.defaultView;
  let current = null;
  let disposed = false;

  function close({ restoreFocus = false } = {}) {
    const entry = current;
    if (!entry) return;
    current = null;
    entry.controller.abort();
    entry.cleanup();
    entry.menu.remove();
    if (entry.button.getAttribute('aria-controls') === entry.menu.id) {
      entry.button.setAttribute('aria-expanded', 'false');
      entry.button.removeAttribute('aria-controls');
    }
    if (restoreFocus && entry.button.isConnected) entry.button.focus({ preventScroll: true });
  }

  function isCurrent(entry) {
    return !disposed && current === entry && !entry.controller.signal.aborted && entry.button.isConnected;
  }

  function position(entry) {
    if (!isCurrent(entry)) { if (current === entry) close(); return; }
    const rect = entry.button.getBoundingClientRect();
    const box = entry.menu.getBoundingClientRect();
    const width = view?.innerWidth || document.documentElement.clientWidth;
    const height = view?.innerHeight || document.documentElement.clientHeight;
    const inset = 8;
    const below = rect.bottom + inset;
    const top = below + box.height <= height - inset ? below : rect.top - box.height - inset;
    entry.menu.style.left = `${Math.max(inset, Math.min(rect.left, width - box.width - inset))}px`;
    entry.menu.style.top = `${Math.max(inset, Math.min(top, height - box.height - inset))}px`;
  }

  async function copy(entry, format) {
    if (!isCurrent(entry) || entry.pending) return;
    entry.pending = true;
    entry.menu.setAttribute('aria-busy', 'true');
    for (const option of entry.options) option.disabled = true;
    try {
      // Start during the click/keyboard activation, before yielding, so browser
      // clipboard permission still sees the user's gesture.
      await awaitWithTimeout(writeText(format === 'markdown' ? entry.content.markdown : entry.content.plainText), {
        signal: entry.controller.signal,
        timeoutMs,
        message: '复制等待超时，请确认剪贴板内容或手动选择文字。',
      });
      if (!isCurrent(entry)) { if (current === entry) close(); return; }
      const subject = entry.content.reasoningOnly ? '思考过程' : '回答';
      close({ restoreFocus: true });
      notify(`已复制${subject}（${format === 'markdown' ? 'Markdown' : '纯文本'}）`);
    } catch (error) {
      if (!isCurrent(entry)) { if (current === entry) close(); return; }
      close({ restoreFocus: true });
      notify(error?.name === 'TimeoutError' ? error.message : '复制失败，请手动选择文字。', 'error');
    }
  }

  function open({ button, message, conversationId } = {}) {
    if (disposed || !button?.isConnected) return false;
    if (current?.button === button) { close({ restoreFocus: true }); return false; }
    close();
    const content = Object.freeze(messageCopyContent(message));
    if (!content.markdown.trim()) { notify('暂无内容可复制'); return false; }

    const menu = document.createElement('div');
    menu.id = `message-copy-menu-${++nextMenuId}`;
    menu.className = 'message-copy-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', content.reasoningOnly ? '复制思考过程' : '复制回答');
    const entry = { menu, button, content, conversationId, messageId: message?.id,
      controller: new AbortController(), options: [], pending: false, cleanup: () => {} };
    current = entry;

    if (content.reasoningOnly) {
      const note = document.createElement('p');
      note.className = 'message-copy-note';
      note.id = `${menu.id}-note`;
      note.textContent = '当前仅有思考内容';
      menu.setAttribute('aria-describedby', note.id);
      menu.append(note);
    }
    for (const [format, label, hint, symbol] of [
      ['markdown', '复制 Markdown', '保留原始格式标记', 'M↓'],
      ['plain', '复制纯文本', '去除格式，保留内容和链接', 'Tt'],
    ]) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'message-copy-item';
      option.dataset.copyFormat = format;
      option.setAttribute('role', 'menuitem');
      option.tabIndex = entry.options.length ? -1 : 0;
      const glyph = document.createElement('span');
      glyph.className = 'message-copy-symbol';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = symbol;
      const text = document.createElement('span');
      text.className = 'message-copy-label';
      const title = document.createElement('span');
      title.textContent = label;
      const description = document.createElement('small');
      description.textContent = hint;
      text.append(title, description);
      option.append(glyph, text);
      option.addEventListener('click', () => { void copy(entry, format); });
      entry.options.push(option);
      menu.append(option);
    }

    const focusOption = (index) => {
      entry.options.forEach((option, position) => { option.tabIndex = index === position ? 0 : -1; });
      entry.options[index].focus({ preventScroll: true });
    };
    const onKeyDown = (event) => {
      if (current !== entry) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
        return;
      }
      if (event.key === 'Tab') { close({ restoreFocus: true }); return; }
      if (!menu.contains(event.target) || entry.pending) return;
      const index = Math.max(0, entry.options.indexOf(document.activeElement));
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? entry.options.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + entry.options.length) % entry.options.length;
        focusOption(next);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void copy(entry, entry.options[index].dataset.copyFormat);
      }
    };
    const outside = (event) => {
      if (!menu.contains(event.target) && !button.contains(event.target)) close();
    };
    const onScroll = (event) => { if (!menu.contains(event.target)) close(); };
    const onResize = () => position(entry);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    view?.addEventListener('resize', onResize);
    entry.cleanup = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      view?.removeEventListener('resize', onResize);
    };
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', menu.id);
    document.body.append(menu);
    position(entry);
    focusOption(0);
    return true;
  }

  function dispose() { close(); disposed = true; }
  return Object.freeze({ open, close, dispose });
}

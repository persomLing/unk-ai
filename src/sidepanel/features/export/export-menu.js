import { awaitWithTimeout } from '../../../utils/abortable.js';

/** Select an export type without taking ownership of conversation execution. */
export function createConversationExportMenu({ button, menu, document = globalThis.document,
  getState, onSelect, notify = () => {}, beforeOpen = () => {} }) {
  const options = [...menu.querySelectorAll('[data-conversation-export]')];
  // Escape header stacking contexts, including the page-source toolbar.
  document.body.append(menu);
  const removers = [];
  let conversationId = null;
  let pendingMarkdown = null;
  let disposed = false;
  const listen = (node, type, handler) => {
    node.addEventListener(type, handler);
    removers.push(() => node.removeEventListener(type, handler));
  };
  function close(restoreFocus = false) {
    const wasOpen = !menu.hidden;
    menu.hidden = true;
    conversationId = null;
    button.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) button.focus({ preventScroll: true });
  }
  function allowed(kind, state) {
    if (!state?.conversationId) return false;
    if (kind === 'document') return Boolean(state.hasTurns);
    if (kind === 'markdown') return Boolean(state.hasTurns) && !state.markdownBlocked && !pendingMarkdown;
    return kind === 'diagnostics' && !state.diagnosticBusy;
  }
  function refreshOptions(state) {
    for (const option of options) {
      option.disabled = !allowed(option.dataset.conversationExport, state);
      if (option.disabled) option.tabIndex = -1;
    }
    if (!menu.hidden && options.includes(document.activeElement) && document.activeElement.disabled) {
      const next = options.find(option => !option.disabled);
      if (next) { next.tabIndex = 0; next.focus({ preventScroll: true }); }
    }
  }
  function cancelMarkdown() {
    const operation = pendingMarkdown;
    pendingMarkdown = null;
    operation?.controller.abort(new DOMException('已取消导出', 'AbortError'));
  }
  async function selectMarkdown(fixedId) {
    const operation = { conversationId: fixedId, controller: new AbortController() };
    pendingMarkdown = operation;
    const isCurrent = () => !disposed && pendingMarkdown === operation && !operation.controller.signal.aborted
      && getState()?.conversationId === fixedId;
    const scope = Object.freeze({ signal: operation.controller.signal, isCurrent });
    try {
      // The existing Markdown adapter must capture its content before awaiting.
      await awaitWithTimeout(Promise.resolve(onSelect('markdown', fixedId, button, scope)), {
        signal: scope.signal, timeoutMs: 60000, message: '等待保存窗口超时，请检查浏览器下载列表。',
      });
    } catch (error) {
      if (isCurrent() && error?.name !== 'AbortError') notify('导出未完成，请重试。', 'error');
    } finally {
      operation.controller.abort();
      if (pendingMarkdown === operation) {
        pendingMarkdown = null;
        if (!menu.hidden) refreshOptions(getState());
      }
    }
  }
  function open(last = false) {
    if (disposed || button.disabled) return;
    const state = getState();
    if (!state.conversationId) return;
    if (pendingMarkdown && pendingMarkdown.conversationId !== state.conversationId) cancelMarkdown();
    beforeOpen();
    conversationId = state.conversationId;
    for (const option of options) {
      option.disabled = !allowed(option.dataset.conversationExport, state);
      option.tabIndex = -1;
    }
    menu.hidden = false;
    const rect = button.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const width = document.defaultView?.innerWidth || document.documentElement.clientWidth;
    const height = document.defaultView?.innerHeight || document.documentElement.clientHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.right - box.width, width - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 8, height - box.height - 8))}px`;
    button.setAttribute('aria-expanded', 'true');
    const enabled = options.filter(option => !option.disabled);
    const selected = last ? enabled.at(-1) : enabled[0];
    if (selected) { selected.tabIndex = 0; selected.focus({ preventScroll: true }); }
  }
  function select(kind) {
    if (disposed || menu.hidden) return;
    const fixedId = conversationId;
    const state = getState();
    if (fixedId !== state.conversationId) { close(true); notify('对话已切换，请重新打开导出菜单。'); return; }
    if (!allowed(kind, state)) return;
    close(true);
    if (kind === 'markdown') { void selectMarkdown(fixedId); return; }
    try { Promise.resolve(onSelect(kind, fixedId, button)).catch(() => notify('导出未完成，请重试。', 'error')); }
    catch { notify('导出未完成，请重试。', 'error'); }
  }
  listen(button, 'click', () => menu.hidden ? open() : close(true));
  listen(button, 'keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); open(event.key === 'ArrowUp');
  });
  for (const option of options) listen(option, 'click', () => select(option.dataset.conversationExport));
  listen(document, 'pointerdown', event => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
  });
  if (document.defaultView) listen(document.defaultView, 'resize', () => close());
  listen(document, 'keydown', event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    if (!menu.contains(event.target)) return;
    const enabled = options.filter(option => !option.disabled);
    if (!enabled.length) return;
    const index = Math.max(0, enabled.indexOf(document.activeElement));
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      enabled.forEach((option, i) => { option.tabIndex = i === next ? 0 : -1; });
      enabled[next].focus({ preventScroll: true });
    }
  });
  return Object.freeze({
    sync(id) {
      if (!menu.hidden && conversationId !== id) close();
      if (pendingMarkdown && pendingMarkdown.conversationId !== id) cancelMarkdown();
      if (!menu.hidden) refreshOptions(getState());
    },
    dispose() { disposed = true; close(); cancelMarkdown(); removers.forEach(remove => remove()); },
  });
}

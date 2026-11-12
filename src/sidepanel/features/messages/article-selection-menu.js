import { captureArticleSelection, articleSelectionBelongsTo, normalizeArticleSelection } from './article-selection.js';

/** Local reference controls own no model request or conversation persistence. */
export function createArticleSelectionMenu({ document = globalThis.document, root,
  getConversation, onQuote, onAsk, getViewportRect, onError = () => {} }) {
  const view = document.defaultView;
  const menu = document.createElement('div');
  menu.className = 'article-selection-menu';
  menu.setAttribute('role', 'toolbar');
  menu.setAttribute('aria-label', '选中内容操作');
  menu.hidden = true;
  const quote = document.createElement('button');
  quote.type = 'button';
  quote.textContent = '引用到当前对话';
  const ask = document.createElement('button');
  ask.type = 'button';
  ask.textContent = '单独追问这段内容';
  ask.title = '在可拖动的小窗口中，结合这段原文与上下文提问';
  menu.append(quote, ask);

  const editor = document.createElement('form');
  editor.className = 'article-quote-editor';
  editor.setAttribute('role', 'dialog');
  editor.setAttribute('aria-label', '添加引用注释');
  editor.hidden = true;
  const preview = document.createElement('blockquote');
  preview.className = 'article-quote-editor-preview';
  const input = document.createElement('textarea');
  input.className = 'article-quote-editor-input';
  input.rows = 2;
  input.maxLength = 2000;
  input.placeholder = '针对这段内容提问或添加说明…';
  input.setAttribute('aria-label', '引用注释');
  const feedback = document.createElement('p');
  feedback.className = 'article-quote-editor-feedback';
  feedback.setAttribute('role', 'alert');
  feedback.hidden = true;
  const footer = document.createElement('div');
  footer.className = 'article-quote-editor-actions';
  const hint = document.createElement('small');
  hint.textContent = '添加到当前对话 · Enter 确认';
  const cancel = document.createElement('button');
  cancel.className = 'article-quote-editor-cancel';
  cancel.type = 'button';
  cancel.textContent = '×';
  cancel.title = '取消';
  cancel.setAttribute('aria-label', '取消引用注释');
  const confirm = document.createElement('button');
  confirm.className = 'article-quote-editor-confirm';
  confirm.type = 'submit';
  confirm.textContent = '✓';
  confirm.title = '添加引用注释';
  confirm.setAttribute('aria-label', '添加引用注释');
  footer.append(hint, cancel, confirm);
  editor.append(preview, input, feedback, footer);
  document.body.append(menu, editor);
  const removers = [];
  let captured = null;
  let editing = null;
  let frame = null;
  let disposed = false;
  const listen = (node, type, handler, options) => {
    node.addEventListener(type, handler, options);
    removers.push(() => node.removeEventListener(type, handler, options));
  };
  const sourceFor = selection => [...(root.querySelectorAll?.('.assistant-message[data-message-id]') || [])]
    .find(node => node.dataset.messageId === selection?.messageId) || null;
  function belongs(snapshot) {
    if (!snapshot) return false;
    // Rewound references may come from another chat. Only the explicit updater
    // can edit those notes; the current draft still owns every confirmation.
    if (snapshot.ownerConversationId !== undefined) {
      if (typeof snapshot.onConfirm !== 'function' || typeof snapshot.isCurrent !== 'function'
        || getConversation()?.id !== snapshot.ownerConversationId) return false;
      try { return snapshot.isCurrent() === true; } catch { return false; }
    }
    return Boolean(articleSelectionBelongsTo(snapshot.selection, getConversation())
      && snapshot.owner?.isConnected !== false && snapshot.owner && root.contains(snapshot.owner));
  }
  function hide() {
    if (frame !== null) { view.cancelAnimationFrame(frame); frame = null; }
    captured = null;
    editing = null;
    menu.hidden = true;
    editor.hidden = true;
    input.value = '';
    input.disabled = false;
    confirm.disabled = false;
  }
  function place(node, anchor) {
    const viewportWidth = view.innerWidth, viewportHeight = view.innerHeight;
    const available = getViewportRect?.() || {};
    const minLeft = Math.max(8, Number(available.left) + 8 || 8);
    const maxRight = Math.min(viewportWidth - 8, Number(available.right) - 8 || viewportWidth - 8);
    const minTop = Math.max(8, Number(available.top) + 8 || 8);
    const maxBottom = Math.min(viewportHeight - 8, Number(available.bottom) - 8 || viewportHeight - 8);
    node.style.maxWidth = `${Math.max(0, maxRight - minLeft)}px`;
    node.style.maxHeight = `${Math.max(0, maxBottom - minTop)}px`;
    const rect = node.getBoundingClientRect();
    const left = Math.max(minLeft, Math.min(anchor.left, maxRight - rect.width));
    const preferredTop = anchor.top - rect.height - 8;
    const top = Math.max(minTop, Math.min(preferredTop >= minTop ? preferredTop : anchor.bottom + 8,
      maxBottom - rect.height));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }
  function refresh(event) {
    if (disposed || editing || menu.contains(event?.target) || editor.contains(event?.target)
      || (!menu.hidden && menu.contains(document.activeElement))
      || (!editor.hidden && editor.contains(document.activeElement))) return;
    const selected = captureArticleSelection({ selection: view.getSelection(), root, conversation: getConversation() });
    if (!selected) { hide(); return; }
    captured = { ...selected, owner: sourceFor(selected.selection) };
    if (!belongs(captured)) { hide(); return; }
    menu.hidden = false;
    place(menu, selected.rect);
  }
  function schedule(event) {
    if (disposed || editing || menu.contains(event?.target) || editor.contains(event?.target)) return;
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = view.requestAnimationFrame(() => { frame = null; refresh(event); });
  }
  function openQuote(selection, rect, { comment = '', title = '添加引用注释', onConfirm,
    ownerConversationId, isCurrent, getAnchorRect, sourceUnavailable = false } = {}) {
    if (disposed) return false;
    const ownedEdit = ownerConversationId !== undefined || isCurrent !== undefined;
    if (ownedEdit && (typeof onConfirm !== 'function' || typeof isCurrent !== 'function'
      || typeof ownerConversationId !== 'string' || !ownerConversationId)) { hide(); return false; }
    const fixedSelection = normalizeArticleSelection(selection);
    if (!fixedSelection) { hide(); return false; }
    const snapshot = { selection: fixedSelection, rect: structuredClone(rect), owner: sourceFor(fixedSelection),
      ...(ownedEdit ? { ownerConversationId, isCurrent, onConfirm } : {}) };
    if (!belongs(snapshot) || !rect) { hide(); return false; }
    hide();
    editing = { ...snapshot, onConfirm, getAnchorRect, returnFocus: document.activeElement };
    editor.setAttribute('aria-label', title);
    confirm.setAttribute('aria-label', title);
    confirm.title = title;
    hint.textContent = sourceUnavailable ? '原文不在当前回答中 · Enter 确认' : onConfirm ? '修改当前注释 · Enter 确认' : '添加到当前对话 · Enter 确认';
    preview.textContent = String(fixedSelection.text || '').replace(/\s+/g, ' ').slice(0, 180);
    input.value = String(comment || '').slice(0, 2000);
    feedback.hidden = true;
    editor.hidden = false;
    place(editor, rect);
    view.getSelection()?.removeAllRanges();
    input.focus({ preventScroll: true });
    return true;
  }
  function choose(action) {
    if (disposed || !belongs(captured)) { hide(); return; }
    const fixed = { selection: structuredClone(captured.selection), rect: structuredClone(captured.rect) };
    hide();
    view.getSelection()?.removeAllRanges();
    try { Promise.resolve(action(fixed.selection, fixed.rect)).catch(onError); }
    catch (error) { onError(error); }
  }
  async function submit(event) {
    event?.preventDefault();
    if (disposed || !editing || confirm.disabled) return;
    if (!belongs(editing)) { hide(); return; }
    const operation = editing;
    const comment = String(input.value || '').trim().slice(0, 2000);
    input.disabled = true;
    confirm.disabled = true;
    feedback.hidden = true;
    try {
      const result = await (operation.onConfirm
        ? operation.onConfirm(comment, structuredClone(operation.selection))
        : onQuote(structuredClone(operation.selection), structuredClone(operation.rect), comment));
      if (!disposed && editing === operation && result !== false) hide();
      else if (!disposed && editing === operation && result === false) {
        feedback.textContent = '引用未添加，请检查后重试。';
        feedback.hidden = false;
      }
    } catch (error) {
      if (!disposed && editing === operation) {
        feedback.textContent = error?.message || '引用未添加，请重试。';
        feedback.hidden = false;
        onError(error);
      }
    } finally {
      if (!disposed && editing === operation) { input.disabled = false; confirm.disabled = false; }
    }
  }
  // The toolbar retains the Range; the editor allows native input focus/caret.
  listen(menu, 'pointerdown', event => event.preventDefault());
  listen(quote, 'click', () => {
    if (!belongs(captured)) { hide(); return; }
    openQuote(captured.selection, captured.rect);
  });
  listen(ask, 'click', () => choose(onAsk));
  listen(editor, 'submit', submit);
  listen(confirm, 'click', event => { event.preventDefault(); void submit(); });
  function cancelEditing() {
    const target = editing?.returnFocus;
    hide();
    if (target?.isConnected && !menu.contains(target)) target.focus?.({ preventScroll: true });
  }
  listen(cancel, 'click', cancelEditing);
  listen(input, 'keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) void submit(event);
  });
  listen(document, 'pointerdown', event => {
    if (editing && !editor.contains(event.target) && !menu.contains(event.target)) hide();
  }, true);
  listen(document, 'pointerup', schedule);
  listen(document, 'keyup', event => { if (event.key !== 'Escape') schedule(event); });
  listen(document, 'selectionchange', schedule);
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape' || (menu.hidden && editor.hidden)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelEditing();
  }, true);
  listen(document, 'scroll', event => {
    if (editor.contains(event.target) || menu.contains(event.target)) return;
    if (editing?.getAnchorRect && belongs(editing)) {
      const rect = editing.getAnchorRect();
      if (rect) { place(editor, rect); return; }
    }
    hide();
  }, true);
  listen(view, 'resize', hide);
  return Object.freeze({
    hide, openQuote,
    dispose() {
      if (disposed) return;
      disposed = true;
      removers.forEach(remove => remove());
      hide();
      menu.remove();
      editor.remove();
    },
  });
}

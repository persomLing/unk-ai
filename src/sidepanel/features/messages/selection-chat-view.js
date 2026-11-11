import { escapeHtml } from '../../core/dom.js';
import { icon, hydrateIcons } from '../../icons.js';
import { messageMarkup, renderMessageContent } from './message-view.js';
import { createFloatingWindow } from './floating-window.js';
import { createFloatingChatDock } from './floating-chat-dock.js';
import { createSourcePopover } from './source-popover.js';
import { createFloatingChatActivity } from './floating-chat-activity.js';
import { createPastedTextDraft } from './pasted-text-draft.js';

/** A separate presenter for the existing conversation runtime. */
export function createSelectionChatView({ document = globalThis.document, runtime, selection, anchorRect,
  getReplaceBlockReason = () => '', onReplace, onClose = () => {}, fallbackFocus = () => null, textPreview = null }) {
  const view = document.defaultView;
  const element = document.createElement('section');
  element.className = 'selection-chat-window';
  element.id = `selection-chat-${runtime.state.conversation.id}`;
  element.dataset.conversationId = runtime.state.conversation.id;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-label', '单独追问这段内容');
  element.innerHTML = `<header class="selection-chat-header">
    <div class="selection-chat-heading"><strong>单独追问</strong><small class="selection-chat-storage">新对话 · 未分组</small></div>
    <div class="selection-chat-header-actions"><button class="selection-chat-collapse icon-button" type="button" aria-label="收起追问窗口" title="收起到右侧，回答会继续；点击图标可展开">${icon('chevron-right')}</button>
      <button class="selection-chat-close icon-button" type="button" aria-label="关闭追问窗口" title="结束选区跟踪；下次单独追问新建对话，已发送内容保留在历史中">${icon('close')}</button></div>
  </header>
  <p class="selection-chat-scope" role="status">本主对话的选区继续加入这里；关闭后再新建。</p>
  <details class="selection-chat-reference" open><summary><span>选中的原文</span><small>${escapeHtml(selection.heading || selection.title || '回答内容')}</small></summary>
    <blockquote>${escapeHtml(selection.text)}</blockquote><small>同时参考原提问、所在小节及相邻正文${selection.truncated ? '（内容已截断）' : ''}</small>
  </details>
  <div class="selection-chat-messages messages" aria-label="追问对话消息" aria-live="polite"></div>
  <p class="selection-chat-feedback" role="status" hidden></p>
  <form class="selection-chat-composer"><div class="pasted-text-list" hidden></div><textarea rows="2" maxlength="200000" placeholder="想了解这段内容的哪一部分？" aria-label="输入追问"></textarea>
    <div class="selection-chat-toolbar"><button class="selection-chat-replace" type="button" title="在主聊天区打开这段新对话，原对话保留在历史中">替换当前对话</button>
      <button class="selection-chat-send" type="submit" aria-label="发送追问" title="发送追问">${icon('arrow-up')}</button>
    </div>
  </form>
  <button class="selection-chat-resize" type="button" aria-label="调整窗口大小" title="拖动调整大小，也可使用方向键">${icon('resize')}</button>`;
  document.body.append(element);
  function bringToFront() {
    document.querySelectorAll('.selection-chat-window').forEach(node => { node.style.zIndex = '2400'; });
    element.style.zIndex = '2401';
  }
  bringToFront();
  const messages = element.querySelector('.selection-chat-messages');
  const input = element.querySelector('textarea');
  const send = element.querySelector('.selection-chat-send');
  const replace = element.querySelector('.selection-chat-replace');
  const feedback = element.querySelector('.selection-chat-feedback');
  const scope = element.querySelector('.selection-chat-scope');
  const reference = element.querySelector('.selection-chat-reference');
  const sources = createSourcePopover({ root: messages, document });
  let dock;
  const geometry = createFloatingWindow({ element, dragHandle: element.querySelector('header'),
    resizeHandle: element.querySelector('.selection-chat-resize'), window: view,
    onDragEnd: details => dock?.handleDragEnd(details) });
  geometry.place(anchorRect);
  const removers = [];
  let closed = false;
  let frame = null;
  let replacing = null;
  let detachedLabel = '';
  const isVisible = () => ['expanded', 'expanding'].includes(element.dataset.dockState)
    && document.visibilityState !== 'hidden';
  const activity = createFloatingChatActivity({ conversationId: runtime.state.conversation.id,
    getMessage: id => runtime.state.conversation?.messages.find(message => message.id === id),
    isVisible });
  dock = createFloatingChatDock({ element, document, geometry, iconMarkup: icon('message'),
    getBusy: () => runtime.isBusy(), getDetachedLabel: () => detachedLabel,
    getActivity: () => activity.snapshot().activity, getUnread: () => activity.snapshot().unread,
    onCollapse: () => sources.close(), onExpand: () => {
      if (isVisible()) activity.acknowledge();
      dock.sync();
      bringToFront();
    } });
  const listen = (node, type, handler, options) => {
    node.addEventListener(type, handler, options);
    removers.push(() => node.removeEventListener(type, handler, options));
  };
  function notice(text) {
    if (closed) return;
    feedback.textContent = String(text || '操作未完成，请重试。');
    feedback.hidden = false;
  }
  const pastedText = createPastedTextDraft({ input, container: element.querySelector('.pasted-text-list'),
    canEdit: () => !closed && !replacing && !input.disabled,
    notify: notice,
    onPreview: value => textPreview?.open(value),
    onChange: value => { runtime.state.draft = value; sync(); },
  });
  function sync() {
    if (closed) return;
    const busy = runtime.isBusy();
    const conversation = runtime.state.conversation;
    element.querySelector('.selection-chat-storage').textContent = !conversation?.messages.length ? '新对话 · 未分组'
      : conversation.syncStatus === 'error' ? '未分组 · 保存失败'
      : conversation.syncStatus === 'pending' ? '未分组 · 浏览器已保存'
      : conversation.syncStatus === 'synced' ? '未分组 · 已同步' : '未分组 · 保存中';
    input.disabled = Boolean(replacing);
    send.disabled = Boolean(replacing) || (!busy && !pastedText.getValue().trim());
    send.type = busy ? 'button' : 'submit';
    send.setAttribute('aria-label', busy ? '停止追问' : '发送追问');
    send.title = busy ? '停止生成，保留当前回答' : '发送追问';
    send.innerHTML = icon(busy ? 'stop' : 'arrow-up');
    const blocked = getReplaceBlockReason();
    replace.disabled = Boolean(replacing) || busy || !runtime.state.conversation?.messages.length || Boolean(blocked);
    replace.title = blocked || (busy ? '请等待回答完成，或先停止生成后打开到主聊天区' : '在主聊天区打开这段新对话，原对话保留在历史中');
    dock.sync();
  }
  function updateReference(value) {
    if (!value || closed) return;
    reference.querySelector('summary small').textContent = value.heading || value.title || '回答内容';
    reference.querySelector('blockquote').textContent = value.text;
    reference.querySelector(':scope > small').textContent = `同时参考原提问、所在小节及相邻正文${value.truncated ? '（内容已截断）' : ''}`;
    reference.open = true;
  }
  function acceptSelection(value) {
    if (closed || replacing || detachedLabel) return { accepted: false, reason: closed ? 'closed' : replacing ? 'transferring' : 'detached' };
    const result = runtime.setSelection(value);
    if (!result.accepted) return result;
    updateReference(result.selection);
    dock.expand();
    bringToFront();
    notice(result.pending ? '继续使用这段未分组追问。新选区用于下一问，当前回答继续。'
      : '已继续使用这段未分组追问；关闭窗口后，下次会新建。');
    if (!element.inert) input.focus({ preventScroll: true });
    sync();
    return result;
  }
  function setTracking(tracking, reason = '已切换主对话；新的选区将另开追问。') {
    if (closed || tracking || detachedLabel) return;
    detachedLabel = reason;
    element.dataset.detached = 'true';
    scope.textContent = `${reason}这里仍可独立续聊。`;
    scope.title = scope.textContent;
    dock.sync();
  }
  function paint() {
    if (closed) return;
    const atBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 48;
    const previousTop = messages.scrollTop;
    const conversation = runtime.state.conversation;
    sources.close();
    messages.innerHTML = (conversation?.messages || []).map(message => messageMarkup(message)).join('');
    messages.querySelectorAll('.user-message-actions, [data-action="copy"], .message-diagnostic-help').forEach(node => node.remove());
    for (const message of conversation?.messages || []) {
      const article = [...messages.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === message.id);
      if (message.role === 'assistant') renderMessageContent(article?.querySelector('[data-message-content]'), message.content, message.status === 'streaming');
    }
    hydrateIcons(messages);
    textPreview?.refresh(messages);
    messages.querySelectorAll('[data-action="regenerate"], [data-action="retry"]').forEach(button => { button.disabled = runtime.isBusy() || Boolean(replacing); });
    messages.scrollTop = atBottom ? messages.scrollHeight : previousTop;
    sync();
  }
  function schedule() {
    if (closed || frame !== null) return;
    frame = view.requestAnimationFrame(() => { frame = null; paint(); });
  }
  const unsubscribe = runtime.subscribe(event => {
    if (closed) return;
    activity.observe(event);
    if (event.type === 'notice') notice(event.message);
    if (event.type === 'draft') pastedText.setValue(runtime.state.draft || '');
    if (event.type === 'selection-updated') updateReference(event.selection);
    schedule();
  });
  function submit(event) {
    event?.preventDefault();
    if (closed || replacing || runtime.isBusy() || !pastedText.getValue().trim()) return;
    runtime.state.draft = pastedText.getValue();
    feedback.hidden = true;
    void runtime.send(pastedText.getValue()).catch(error => notice(error.message));
    sync();
  }
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    const hadFocus = element.contains(document.activeElement) || dock.launcher === document.activeElement;
    closed = true;
    replacing?.abort();
    if (frame !== null) view.cancelAnimationFrame(frame);
    unsubscribe();
    activity.dispose();
    sources.dispose();
    dock.dispose();
    geometry.dispose();
    pastedText.dispose();
    removers.forEach(remove => remove());
    element.remove();
    Promise.resolve(runtime.close()).catch(() => {});
    onClose();
    const target = restoreFocus && hadFocus ? fallbackFocus() : null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }
  listen(input, 'input', () => pastedText.handleInput());
  listen(input, 'paste', event => pastedText.handlePaste(event));
  listen(document, 'visibilitychange', () => {
    if (isVisible()) activity.acknowledge();
    dock.sync();
  });
  listen(element, 'pointerdown', bringToFront);
  listen(element.querySelector('form'), 'submit', submit);
  listen(input, 'keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) submit(event);
  });
  listen(send, 'click', event => {
    if (runtime.isBusy()) {
      event.preventDefault();
      if (event.detail > 1) return;
      runtime.stop();
      sync();
    }
  });
  listen(element.querySelector('.selection-chat-close'), 'click', () => close());
  listen(element.querySelector('.selection-chat-collapse'), 'click', () => dock.collapse());
  listen(document, 'keydown', event => {
    if (event.key === 'Escape' && element.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  }, true);
  async function openInMain() {
    if (closed || replacing || !runtime.state.conversation?.messages.length) return false;
    const blocked = getReplaceBlockReason();
    if (runtime.isBusy() || blocked) {
      dock.expand();
      notice(blocked || '请等待追问回答完成，或先停止生成后打开到主聊天区。');
      return false;
    }
    const operation = new AbortController();
    replacing = operation;
    sync();
    try {
      const moved = await onReplace(runtime, { signal: operation.signal,
        isCurrent: () => !closed && replacing === operation && !operation.signal.aborted });
      if (!closed && !operation.signal.aborted && moved !== false) {
        close({ restoreFocus: false });
        return true;
      }
      return false;
    } catch (error) {
      if (!closed && !operation.signal.aborted) { dock.expand(); notice(error.message); }
      return false;
    } finally {
      if (replacing === operation) { replacing = null; sync(); }
    }
  }
  listen(replace, 'click', openInMain);
  listen(messages, 'click', event => {
    const button = event.target.closest('[data-action]');
    const article = button?.closest('[data-message-id]');
    const message = runtime.state.conversation?.messages.find(item => item.id === article?.dataset.messageId);
    if (!message || closed || replacing) return;
    const action = button.dataset.action;
    if (['retry', 'regenerate'].includes(action) && !runtime.isBusy()) {
      void runtime.retry(message.id).catch(error => notice(error.message));
    } else if (action === 'toggle-thinking') {
      const content = button.closest('.thinking-block')?.querySelector('.thinking-content');
      if (content) {
        content.hidden = !content.hidden;
        message.userToggledThinking = true;
        message.thinkingExpanded = !content.hidden;
        button.setAttribute('aria-expanded', String(!content.hidden));
        button.classList.toggle('is-open', !content.hidden);
      }
    } else if (action === 'toggle-error') {
      message.errorExpanded = !message.errorExpanded;
      paint();
    } else if (action === 'toggle-sources') {
      sources.toggle(button);
    }
  });
  paint();
  input.focus({ preventScroll: true });
  return Object.freeze({ element, launcher: dock.launcher, conversationId: runtime.state.conversation.id,
    sync, close, openInMain, acceptSelection, setTracking, collapse: dock.collapse,
    expand: dock.expand, isDocked: dock.isDocked });
}

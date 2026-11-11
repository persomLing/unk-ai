import { icon } from '../../icons.js';

const MAX_PREVIEW = 220;
const HIDE_DELAY = 120;

function compactText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value, limit = MAX_PREVIEW) {
  const text = compactText(value);
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** The raw question excludes selection context and other model-only additions. */
export function originalQuestionFor(message) {
  return compactText(message?.displayContent ?? message?.content);
}

export function previewTextFor(message) {
  if (!message) return '';
  if (message.content) return truncate(message.content);
  if (message.reasoning) return '正在深度思考…';
  if (message.status === 'stopped') return '回答已停止。';
  if (message.status === 'error') return compactText(message.errorMessage) || '回答未完成。';
  return '正在生成回答…';
}

/** One user question and the assistant reply that follows it form one turn. */
export function turnsForConversation(conversation) {
  const turns = [];
  let pending = null;
  for (const message of Array.isArray(conversation?.messages) ? conversation.messages : []) {
    if (message?.role === 'user') {
      if (pending) turns.push(pending);
      pending = {
        id: message.id,
        conversationId: conversation.id,
        userId: message.id,
        assistantId: null,
        user: message,
        assistant: null,
        question: originalQuestionFor(message),
        answer: '',
        pageSource: message.pageSource || null,
      };
      continue;
    }
    if (message?.role === 'assistant' && pending && !pending.assistant) {
      pending.assistant = message;
      pending.assistantId = message.id;
      pending.answer = previewTextFor(message);
      if (!pending.pageSource && message.pageSource) pending.pageSource = message.pageSource;
    }
  }
  if (pending) {
    pending.answer = pending.answer || '等待回答…';
    turns.push(pending);
  }
  return turns;
}

function makeRailItem(turn, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'turn-navigator-item';
  button.dataset.turnUserId = turn.userId;
  button.setAttribute('aria-label', `定位到第 ${index + 1} 轮提问`);
  const line = document.createElement('span');
  line.className = 'turn-navigator-line';
  line.setAttribute('aria-hidden', 'true');
  button.append(line);
  return button;
}

function previewRow(className, text) {
  const node = document.createElement('div');
  node.className = className;
  node.textContent = text;
  return node;
}

export function createTurnNavigator({
  stage,
  view,
  messages,
  rail,
  preview,
  getConversation,
  openSource = () => {},
  onNavigate = () => {},
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = frame => cancelAnimationFrame(frame),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
  now = Date.now,
} = {}) {
  if (!stage || !view || !messages || !rail || !preview || typeof getConversation !== 'function') {
    throw new TypeError('TurnNavigator requires stage, view, messages, rail and preview.');
  }
  let turns = [];
  let conversationId = null;
  let previewTurnId = null;
  let updateFrame = null;
  let hideTimer = null;
  let resizeObserver = null;
  let disposed = false;

  function conversationCurrent() {
    return getConversation()?.id === conversationId;
  }

  function withdrawPreview() {
    clearTimer(hideTimer);
    hideTimer = null;
    previewTurnId = null;
    preview.hidden = true;
    preview.replaceChildren();
  }

  function scheduleWithdraw() {
    clearTimer(hideTimer);
    hideTimer = setTimer(() => {
      hideTimer = null;
      if (!rail.matches(':hover') && !preview.matches(':hover') && !rail.contains(document.activeElement)
        && !preview.contains(document.activeElement)) withdrawPreview();
    }, HIDE_DELAY);
  }

  function scheduleUpdate() {
    if (disposed || updateFrame !== null || preview.hidden) return;
    updateFrame = requestFrame(() => {
      updateFrame = null;
      const button = rail.querySelector(`[data-turn-user-id="${CSS.escape(previewTurnId || '')}"]`);
      positionPreview(button);
    });
  }

  function positionPreview(button) {
    if (preview.hidden || !button?.isConnected) return;
    const stageRect = stage.getBoundingClientRect();
    const itemRect = button.getBoundingClientRect();
    const cardHeight = preview.offsetHeight;
    const cardWidth = preview.offsetWidth;
    const maxTop = Math.max(8, stageRect.height - cardHeight - 8);
    const top = Math.max(8, Math.min(maxTop, itemRect.top - stageRect.top + itemRect.height / 2 - cardHeight / 2));
    const left = Math.max(8, itemRect.left - stageRect.left - cardWidth - 7);
    preview.style.top = `${Math.round(top)}px`;
    preview.style.left = `${Math.round(Math.max(0, left))}px`;
  }

  function renderPreview(turn, button) {
    preview.replaceChildren();
    const title = previewRow('turn-preview-title', turn.question || '未命名提问');
    title.title = turn.question || '';
    const answer = previewRow('turn-preview-answer', turn.answer || previewTextFor(turn.assistant));
    preview.append(title, answer);

    const sourceUrl = String(turn.pageSource?.url || '');
    if (sourceUrl) {
      const source = document.createElement('button');
      source.type = 'button';
      source.className = 'turn-preview-source';
      source.innerHTML = `${icon('globe')}<span>网页预览</span>`;
      source.addEventListener('click', event => {
        event.stopPropagation();
        withdrawPreview();
        openSource(sourceUrl);
      });
      preview.append(source);
    }
    preview.dataset.previewTurn = turn.userId;
    previewTurnId = turn.userId;
    preview.hidden = false;
    requestFrame(() => positionPreview(button));
  }

  function showPreview(button) {
    clearTimer(hideTimer);
    hideTimer = null;
    const turn = turns.find(item => item.userId === button?.dataset.turnUserId);
    if (!turn || previewTurnId === turn.userId && !preview.hidden) return;
    renderPreview(turn, button);
  }

  function navigate(button) {
    const index = [...rail.children].indexOf(button);
    const turn = turns[index];
    const article = turn && messages.querySelector(`[data-message-id="${CSS.escape(turn.userId)}"]`);
    if (!article) return;
    const behavior = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const delta = article.getBoundingClientRect().top - view.getBoundingClientRect().top - 12;
    onNavigate(turn);
    view.scrollBy({ top: delta, behavior });
    withdrawPreview();
  }

  function onPointerOver(event) {
    const button = event.target.closest('.turn-navigator-item');
    if (button) showPreview(button);
  }

  function onFocusIn(event) {
    const button = event.target.closest('.turn-navigator-item');
    if (button) showPreview(button);
  }

  function onKeyDown(event) {
    const buttons = [...rail.querySelectorAll('.turn-navigator-item')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      withdrawPreview();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus();
  }

  function sync(conversation) {
    if (disposed) return;
    conversationId = conversation?.id || null;
    turns = turnsForConversation(conversation);
    withdrawPreview();
    rail.replaceChildren(...turns.map(makeRailItem));
    const visible = turns.length > 0;
    rail.hidden = !visible;
    stage.classList.toggle('has-turn-navigator', visible);
    if (!visible) return;
    for (const button of rail.children) {
      button.addEventListener('pointerenter', () => showPreview(button));
      button.addEventListener('click', () => navigate(button));
    }
  }

  function resize() {
    scheduleUpdate();
    if (!preview.hidden) {
      const button = rail.querySelector(`[data-turn-user-id="${CSS.escape(previewTurnId || '')}"]`);
      if (button) positionPreview(button);
    }
  }

  rail.addEventListener('pointerover', onPointerOver);
  rail.addEventListener('pointerleave', scheduleWithdraw);
  rail.addEventListener('focusin', onFocusIn);
  rail.addEventListener('focusout', scheduleWithdraw);
  rail.addEventListener('keydown', onKeyDown);
  preview.addEventListener('pointerenter', () => { clearTimer(hideTimer); hideTimer = null; });
  preview.addEventListener('pointerleave', scheduleWithdraw);
  preview.addEventListener('focusout', scheduleWithdraw);
  view.addEventListener('scroll', scheduleUpdate, { passive: true });
  globalThis.addEventListener?.('resize', resize);
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => { if (!preview.hidden) scheduleUpdate(); });
    resizeObserver.observe(messages);
  }

  return Object.freeze({
    sync,
    update: scheduleUpdate,
    scheduleLayout: scheduleUpdate,
    dispose() {
      disposed = true;
      clearTimer(hideTimer);
      if (updateFrame !== null) cancelFrame(updateFrame);
      updateFrame = null;
      resizeObserver?.disconnect();
      rail.removeEventListener('pointerover', onPointerOver);
      rail.removeEventListener('pointerleave', scheduleWithdraw);
      rail.removeEventListener('focusin', onFocusIn);
      rail.removeEventListener('focusout', scheduleWithdraw);
      rail.removeEventListener('keydown', onKeyDown);
      view.removeEventListener('scroll', scheduleUpdate);
      globalThis.removeEventListener?.('resize', resize);
      withdrawPreview();
      rail.replaceChildren();
      rail.hidden = true;
      stage.classList.remove('has-turn-navigator');
    },
  });
}

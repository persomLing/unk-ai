import { icon } from '../../icons.js';
import { formatTime } from '../../core/format.js';
import { renderTurnPreview } from './turn-preview.js';
import { presentVideoNotesMessage } from '../video-notes/video-notes-presentation.js';

const MAX_PREVIEW = 220;
const HIDE_DELAY = 120;
const MAX_RAIL_TICKS = 8;
const DIRECTORY_MIN_TURNS = MAX_RAIL_TICKS + 1;
const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function visibleRailTurns(turns = []) {
  const start = Math.max(0, turns.length - MAX_RAIL_TICKS);
  return { start, turns: turns.slice(start) };
}

export function formatTurnSpanHeader(turns = []) {
  const times = turns
    .map(t => (t?.createdAt ? new Date(t.createdAt) : null))
    .filter(d => d && !Number.isNaN(d.getTime()));
  if (!times.length) return '当前对话目录';
  const first = times[0];
  const last = times[times.length - 1];
  const startTime = formatTime(first);
  const endTime = formatTime(last);
  const firstDate = `${first.getMonth() + 1}月${first.getDate()}日${WEEKDAYS_ZH[first.getDay()]}`;
  if (first.toDateString() === last.toDateString()) {
    return startTime === endTime ? `${firstDate}，${startTime}` : `${firstDate}，${startTime} – ${endTime}`;
  }
  const lastDate = `${last.getMonth() + 1}月${last.getDate()}日`;
  return `${first.getMonth() + 1}月${first.getDate()}日 ${startTime} – ${lastDate} ${endTime}`;
}

export function formatTurnPreviewTime(timestamp, nowMs = Date.now()) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const ref = new Date(nowMs);
  const timeText = formatTime(date);
  if (date.toDateString() === ref.toDateString()) return timeText;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  if (date.getFullYear() === ref.getFullYear()) return `${month}-${day} ${timeText}`;
  return `${date.getFullYear()}-${month}-${day} ${timeText}`;
}

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
        createdAt: message.createdAt || null,
        pageSource: message.pageSource || null,
      };
      continue;
    }
    if (message?.role === 'assistant' && pending && !pending.assistant) {
      pending.assistant = message;
      pending.assistantId = message.id;
      pending.answer = previewTextFor(message);
      if (!pending.createdAt && message.createdAt) pending.createdAt = message.createdAt;
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
  directory = null,
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
  let directoryOpen = false;
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
    const index = turns.indexOf(turn);
    const meta = document.createElement('div');
    meta.className = 'turn-preview-meta';
    const order = document.createElement('span');
    order.className = 'turn-preview-index';
    order.textContent = `${index >= 0 ? index + 1 : 1} / ${turns.length || 1}`;
    meta.append(order);
    const timeText = formatTurnPreviewTime(turn.createdAt, now());
    if (timeText) {
      const time = document.createElement('time');
      time.className = 'turn-preview-time';
      time.textContent = timeText;
      meta.append(time);
    }

    const title = previewRow('turn-preview-title', turn.question || '未命名提问');
    title.title = turn.question || '';
    const answer = previewRow('turn-preview-answer', turn.answer || previewTextFor(turn.assistant));
    const display = presentVideoNotesMessage(turn.assistant, [turn.user, turn.assistant]);
    if (display?.content) renderTurnPreview(answer, display.content);
    answer.setAttribute('role', 'region');
    answer.setAttribute('aria-label', '回答预览');
    preview.append(meta, title, answer);

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

  function activeTurnUserId() {
    if (!turns.length || !view?.getBoundingClientRect) return turns[turns.length - 1]?.userId || null;
    const viewTop = view.getBoundingClientRect().top + 56;
    let activeId = turns[0]?.userId || null;
    for (const turn of turns) {
      const article = messages.querySelector(`[data-message-id="${CSS.escape(turn.userId)}"]`);
      if (!article) continue;
      if (article.getBoundingClientRect().top <= viewTop) activeId = turn.userId;
      else break;
    }
    return activeId;
  }

  function closeDirectory() {
    if (!directoryOpen || !directory) return;
    directoryOpen = false;
    renderDirectory();
  }

  function positionDirectory() {
    if (!directory || directory.hidden) return;
    const firstRailItem = rail.firstElementChild;
    if (!firstRailItem || !stage?.getBoundingClientRect) return;
    const stageRect = stage.getBoundingClientRect();
    const itemRect = firstRailItem.getBoundingClientRect();
    if (!stageRect.height || !itemRect.height) return;
    const top = Math.max(12, Math.round(itemRect.top - stageRect.top - 16));
    directory.style.top = `${top}px`;
    const panel = directory.querySelector('.turn-directory-panel');
    if (panel) {
      const marginTop = 12;
      const marginBottom = 44;
      const maxPanelHeight = Math.max(160, Math.min(340, Math.floor(stageRect.height - marginTop - marginBottom)));
      panel.style.maxHeight = `${maxPanelHeight}px`;
      const panelHeight = Math.min(panel.offsetHeight || maxPanelHeight, maxPanelHeight);
      const clampedStageTop = Math.max(marginTop, Math.min(top - 4, stageRect.height - marginBottom - panelHeight));
      panel.style.top = `${Math.round(clampedStageTop - top)}px`;
    }
  }

  function renderDirectory() {
    if (!directory) return;
    const show = turns.length >= DIRECTORY_MIN_TURNS;
    directory.hidden = !show;
    if (!show) {
      directoryOpen = false;
      directory.replaceChildren();
      return;
    }
    const doc = directory.ownerDocument || globalThis.document;
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = `turn-directory-dash${directoryOpen ? ' is-open' : ''}`;
    trigger.setAttribute('aria-expanded', String(directoryOpen));
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-label', `展开本对话全部 ${turns.length} 轮目录`);
    trigger.title = `全部 ${turns.length} 轮对话目录`;
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      directoryOpen = !directoryOpen;
      if (directoryOpen) withdrawPreview();
      renderDirectory();
    });

    const children = [trigger];
    if (directoryOpen) {
      const panel = doc.createElement('div');
      panel.className = 'turn-directory-panel ui-popover';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', '本对话提问目录');

      const header = doc.createElement('div');
      header.className = 'turn-directory-header';
      const title = doc.createElement('strong');
      title.textContent = formatTurnSpanHeader(turns);
      const sub = doc.createElement('span');
      sub.textContent = `${turns.length} 轮对话`;
      header.append(title, sub);

      const list = doc.createElement('div');
      list.className = 'turn-directory-list';
      const activeId = activeTurnUserId();

      turns.forEach((turn, idx) => {
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = `turn-directory-row${turn.userId === activeId ? ' is-current' : ''}`;
        row.dataset.turnUserId = turn.userId;

        const timeEl = doc.createElement('time');
        timeEl.className = 'turn-directory-time';
        timeEl.textContent = turn.createdAt ? formatTime(new Date(turn.createdAt)) : `#${idx + 1}`;

        const textEl = doc.createElement('span');
        textEl.className = 'turn-directory-text';
        textEl.textContent = turn.question || '未命名提问';
        textEl.title = turn.question || '';

        row.append(timeEl, textEl);
        row.addEventListener('click', () => {
          navigateToTurn(turn);
          closeDirectory();
        });
        list.append(row);
      });

      panel.append(header, list);
      children.push(panel);
    }

    directory.replaceChildren(...children);
    requestFrame(positionDirectory);
  }

  function navigateToTurn(turn) {
    const article = turn && messages.querySelector(`[data-message-id="${CSS.escape(turn.userId)}"]`);
    if (!article) return;
    const behavior = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const delta = article.getBoundingClientRect().top - view.getBoundingClientRect().top - 12;
    onNavigate(turn);
    view.scrollBy({ top: delta, behavior });
    withdrawPreview();
  }

  function navigate(button) {
    const turn = turns.find(item => item.userId === button?.dataset.turnUserId);
    navigateToTurn(turn);
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

  function onDocumentPointerDown(event) {
    if (directoryOpen && directory && !directory.contains(event.target)) {
      closeDirectory();
    }
  }

  function onDocumentKeyDown(event) {
    if (directoryOpen && event.key === 'Escape') {
      closeDirectory();
    }
  }

  function sync(conversation) {
    if (disposed) return;
    conversationId = conversation?.id || null;
    turns = turnsForConversation(conversation);
    withdrawPreview();
    directoryOpen = false;
    const { start: railStart, turns: railTurns } = visibleRailTurns(turns);
    rail.replaceChildren(...railTurns.map((turn, offset) => makeRailItem(turn, railStart + offset)));
    const visible = turns.length > 0;
    rail.hidden = !visible;
    stage.classList.toggle('has-turn-navigator', visible);
    renderDirectory();
    if (!visible) return;
    for (const button of rail.children) {
      button.addEventListener('pointerenter', () => showPreview(button));
      button.addEventListener('click', () => navigate(button));
    }
  }

  function resize() {
    scheduleUpdate();
    positionDirectory();
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
  preview.addEventListener('keydown', onKeyDown);
  view.addEventListener('scroll', scheduleUpdate, { passive: true });
  globalThis.document?.addEventListener?.('pointerdown', onDocumentPointerDown);
  globalThis.document?.addEventListener?.('keydown', onDocumentKeyDown);
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
      preview.removeEventListener('keydown', onKeyDown);
      view.removeEventListener('scroll', scheduleUpdate);
      globalThis.document?.removeEventListener?.('pointerdown', onDocumentPointerDown);
      globalThis.document?.removeEventListener?.('keydown', onDocumentKeyDown);
      globalThis.addEventListener && globalThis.removeEventListener?.('resize', resize);
      withdrawPreview();
      directoryOpen = false;
      if (directory) {
        directory.replaceChildren();
        directory.hidden = true;
      }
      rail.replaceChildren();
      rail.hidden = true;
      stage.classList.remove('has-turn-navigator');
    },
  });
}

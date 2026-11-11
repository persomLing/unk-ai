import { compact, escape, filter, map } from 'lodash-es';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';
import { renderMarkdown } from '../../../utils/markdown.js';
import { imageAttachmentLoadError, safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { escapeHtml } from '../../core/dom.js';
import { formatTime } from '../../core/format.js';
import { hydrateIcons, icon } from '../../icons.js';
import { agentPanelMarkup } from './agent-message-view.js';
import { captureViewPosition, restoreViewPosition } from './scroll-position.js';
import { replyProgressLabel } from './reply-progress.js';
import { messageErrorMarkup, messageModeBadgeMarkup, syncMessageDecorations } from './message-decorations.js';
import { syncChildren } from './dom-reconcile.js';
import { thinkingPresentation } from './thinking-view.js';
import { parseSuggestionResponse } from './model-suggestions.js';
import { articleQuotes } from './article-quote-draft.js';
import { shouldCollapseMessageText } from './text-preview.js';

export { normalizeMessageError, syncMessageErrorToggle } from './message-decorations.js';

const SAFE_MARKDOWN = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
};

function protectMath(content) {
  const expressions = [];
  const text = String(content || '').replace(
    /```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$|(?<!\$)\$[^\s$][^$\n]*?[^\s$]\$(?!\$)/g,
    (match) => {
      if (!match.startsWith('$')) return match;
      const display = match.startsWith('$$');
      const source = match.slice(display ? 2 : 1, display ? -2 : -1).trim();
      if (!source) return match;
      // Dollar signs are common in prices, shell snippets and prose. Only
      // hand genuine math to KaTeX so CJK text cannot produce console warnings.
      if (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(source)) return match;
      const token = `UNKAIGUARDEDMATH${expressions.length}TOKEN`;
      expressions.push({ token, source, display });
      return token;
    },
  );
  return { text, expressions };
}

function replaceToken(container, item) {
  const formula = container.ownerDocument.createElement(item.display ? 'div' : 'span');
  if (item.display) formula.className = 'math-block';
  try {
    katex.render(item.source, formula, {
      displayMode: item.display,
      throwOnError: true,
      strict: 'ignore',
    });
  } catch {
    formula.textContent = item.source;
  }
  const NodeFilterApi = container.ownerDocument.defaultView?.NodeFilter || globalThis.NodeFilter;
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilterApi.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    const index = textNode.nodeValue.indexOf(item.token);
    if (index === -1) continue;
    textNode.splitText(index + item.token.length);
    textNode.splitText(index).replaceWith(formula);
    break;
  }
}

function renderedContent(content, streaming, ownerDocument) {
  const { text, expressions } = protectMath(content);
  const clean = DOMPurify.sanitize(renderMarkdown(text), SAFE_MARKDOWN);
  const template = ownerDocument.createElement('template');
  template.innerHTML = `${clean}${streaming && content
    ? '<span class="streaming-cursor" aria-label="正在生成"></span>'
    : ''}`;
  const fragment = template.content;
  expressions.forEach((item) => replaceToken(fragment, item));
  return fragment;
}

export function renderMessageContent(container, content, streaming = false) {
  if (!container) return;
  const fragment = renderedContent(content, streaming, container.ownerDocument);
  syncChildren(container, fragment);
  container.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow';
  });
  if (!streaming) {
    container.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  }
  syncMessageDecorations(container.closest('.assistant-message'));
}

function userMessageMarkup(message) {
  const files = Array.isArray(message.attachments) ? message.attachments : [];
  const images = map(filter(files, (item) =>
    item.type === 'image' && safeAttachmentDataUrl(item.dataUrl)), (item) =>
    `<img class="message-image" data-image-preview tabindex="0" role="button" aria-haspopup="dialog" aria-label="查看图片 ${escapeHtml(item.name)}" title="点击放大" src="${safeAttachmentDataUrl(item.dataUrl)}" alt="${escapeHtml(item.name)}" />`)
    .join('');
  const names = map(files, (item) =>
    `<span class="message-file">${icon(item.type === 'image' ? 'image' : 'file')}<span>${escapeHtml(item.name)}</span></span>`)
    .join('');
  const imageErrors = files.map(imageAttachmentLoadError).filter(Boolean)
    .map(error => `<small class="message-file-error">${escapeHtml(error)}</small>`).join('');
  const bodyText = message.displayContent ?? message.content;
  const body = !bodyText ? '' : shouldCollapseMessageText(bodyText)
    ? `<div class="user-text-preview" data-text-preview-candidate><div class="message-content user-text-preview-content" data-text-preview-content>${escape(bodyText).replace(/\r/g, '&#13;')}</div><span class="user-text-preview-more" aria-hidden="true" hidden>查看全文 ${icon('external')}</span></div>`
    : `<div class="message-content">${escapeHtml(bodyText)}</div>`;
  const preview = String(message.selection?.text || '').replace(/\s+/g, ' ').slice(0, 180);
  const annotations = message.selection?.sourceVersion === 2 ? articleQuotes(message.selection) : [];
  const selection = annotations.length
    ? `<details class="message-quote-bundle"><summary>${icon('quote')}<span>${annotations.length} 条引用注释</span></summary><ol>${annotations.map((quote, index) => `<li><span class="article-quote-number">${index + 1}</span><div><blockquote>${escapeHtml(quote.text)}</blockquote>${quote.comment ? `<p>${escapeHtml(quote.comment)}</p>` : '<small>仅引用原文</small>'}<small>${escapeHtml(quote.heading || quote.title || '对话回答')}</small></div></li>`).join('')}</ol></details>`
    : message.selection
    ? `<div class="message-selection"><span class="message-selection-icon">${icon('quote')}</span><div><strong>已选择文字</strong><small>${escapeHtml(preview)}${message.selection.text.length > 180 ? '…' : ''}</small></div></div>`
    : '';
  const actions = `<div class="user-message-actions" role="group" aria-label="提问操作">
    <button class="user-action-btn" data-action="rewind" data-message-id="${message.id}" type="button" aria-label="回退并重新编辑" title="回退到此提问并编辑">
      ${icon('rewind')}
    </button>
    <button class="user-action-btn" data-action="copy-user" data-message-id="${message.id}" type="button" aria-label="复制提问" title="复制提问">
      ${icon('copy')}
    </button>
  </div>`;
  return `<article class="message user-message" data-message-id="${message.id}">${messageModeBadgeMarkup(message)}${selection}${images}${body}${names ? `<div class="message-files">${names}</div>` : ''}${imageErrors}${actions}</article>`;
}

function sourcesMarkup(message) {
  const sources = Array.isArray(message.sources) ? message.sources : [];
  if (!sources.length) return '';
  const allRead = sources.every(source => source.readStatus === 'body');
  const sourceIcon = (source, mini = false) => {
    const favicon = typeof source.favicon === 'string' ? source.favicon.trim() : '';
    return `<span class="${mini ? 'source-icon-mini' : 'source-popover-icon'}"><span data-source-favicon-fallback aria-hidden="true">${icon('globe')}</span>${favicon ? `<img class="${mini ? 'source-favicon-mini' : 'source-popover-favicon'}" data-source-favicon src="${escapeHtml(favicon)}" alt="" hidden />` : ''}</span>`;
  };
  const favicons = sources.slice(0, 3).map(s => sourceIcon(s, true)).join('');
  const listItems = sources.map((s) => {
    let host = s.domain || '';
    if (!host && s.url) {
      try { host = new URL(s.url).hostname; } catch {}
    }
    const title = s.title || host || '引用信源';
    const evidence = s.readStatus === 'body' ? '已读正文'
      : ['search-summary', 'snippet'].includes(s.readStatus) ? '搜索摘要' : '读取状态未知';
    const details = `${host ? `${host} · ` : ''}${evidence}${s.truncated === true ? ' · 内容已截断' : ''}`;
    return `<a class="source-popover-item" href="${escapeHtml(s.url || '#')}" target="_blank" rel="noopener noreferrer">
      ${sourceIcon(s)}
      <div class="source-popover-meta">
        <strong class="source-popover-title">${escapeHtml(title)}</strong>
        <small class="source-popover-domain">${escapeHtml(details)}</small>
      </div>
    </a>`;
  }).join('');
  return `<div class="message-sources" data-sources-for="${message.id}">
    <button type="button" class="sources-pill" data-action="toggle-sources" aria-expanded="false" title="查看来源及读取状态">
      <span class="sources-favicons">${favicons}</span>
      <span class="sources-count">${allRead ? '已读取 ' : ''}${sources.length} 个来源</span>
      <i class="sources-chevron" data-icon="chevron-down"></i>
    </button>
    <div class="sources-popover" hidden>
      <div class="sources-popover-list">${listItems}</div>
    </div>
  </div>`;
}

function tryNextMarkup(message, { showSuggestions = false } = {}) {
  if (!showSuggestions) return '';
  const suggestions = Array.isArray(message.suggestions) && message.suggestions.length > 0
    ? parseSuggestionResponse(JSON.stringify(message.suggestions.filter(value => typeof value === 'string')), { answer: message.content })
    : [];
  if (!suggestions.length || message.status === 'streaming') return '';
  const chips = suggestions.map((s) =>
    `<button class="try-next-chip" type="button" data-suggestion="${escapeHtml(s)}">
      <span>${escapeHtml(s)}</span>
      ${icon('arrow-right')}
    </button>`
  ).join('');
  return `<div class="try-next-container" data-for-message="${message.id}">
    <span class="try-next-label">下一步探索</span>
    <div class="try-next-chips">${chips}</div>
  </div>`;
}

function assistantMessageMarkup(message, { showSuggestions = false } = {}) {
  const status = message.status || 'complete';
  const stopped = status === 'stopped'
    ? `<div class="message-state">${icon('stop')}已停止，已保留当前回答</div>`
    : '';
  const error = messageErrorMarkup(message);
  const retry = !message.agent && ['stopped', 'error'].includes(status)
    ? `<button class="action-text" data-action="retry" type="button">${icon('regenerate')}重试</button>`
    : '';
  const thinking = thinkingPresentation(message);
  const brainIcon = `<span class="thinking-brain-icon${thinking.active ? ' is-shaking' : ' is-settled'}" aria-hidden="true">${icon('brain')}</span>`;

  const streamingCursor = thinking.active
    ? '<span class="thinking-cursor" aria-hidden="true"></span>'
    : '';

  const thought = thinking.visible
    ? `<div class="thinking-block${thinking.active ? ' is-streaming' : ''}" data-thinking-for="${message.id}" data-message-thought>
        <button type="button" class="thinking-toggle${thinking.expanded ? ' is-open' : ''}" data-action="toggle-thinking" aria-expanded="${thinking.expanded ? 'true' : 'false'}">
          ${brainIcon}
          <span class="thinking-text" data-thinking-label>${thinking.label}</span>
          <i class="thinking-chevron" data-icon="chevron-down"></i>
        </button>
        <div class="thinking-content"${thinking.expanded ? '' : ' hidden'}><span class="thinking-reason-text" data-thinking-text>${escapeHtml(message.reasoning || '')}</span>${streamingCursor}</div>
      </div>`
    : '';

  const progress = replyProgressLabel(message);
  const progressState = progress
    ? `<div class="message-state request-progress" role="status" data-message-progress data-request-phase="${escapeHtml(message.requestPhase || '')}">${icon(message.requestPhase === 'reading' ? 'article' : 'history')}<span data-progress-text>${escapeHtml(progress)}</span></div>`
    : '';
  const model = message.model
    ? `<span class="message-model">${escapeHtml(message.model)}${message.reasoningEffort && message.reasoningEffort !== 'default' ? ` · ${escapeHtml(message.reasoningEffort)}` : ''}</span>`
    : '';
  const agent = message.agent
    ? agentPanelMarkup(message.agent)
    : '';
  const agentState = message.agent && message.status === 'streaming'
    ? `<div class="message-state">${icon('globe')}正在执行浏览器任务，进度会实时更新</div>`
    : '';
  const sources = sourcesMarkup(message);
  const tryNext = tryNextMarkup(message, { showSuggestions });
  return `<article class="message assistant-message" data-message-id="${message.id}">
    <div class="message-label"><span class="assistant-avatar">${icon('asterisk')}</span><span>UNK AI</span>${model}<time>${formatTime(message.createdAt)}</time></div>
    ${agent}${agentState}${thought}${progressState}<div class="message-content" data-message-content></div>${sources}${tryNext}${stopped}${error}
    <div class="message-actions">
      <button class="icon-button" data-action="copy" type="button" aria-label="复制回答" title="选择复制格式" aria-haspopup="menu" aria-expanded="false">${icon('copy')}</button>
      ${message.agent ? (['failed', 'cancelled'].includes(message.agent.status) ? `<button class="action-text" data-action="restart-agent" type="button">${icon('regenerate')}重新开始任务</button>` : '') : `<button class="icon-button" data-action="regenerate" type="button" aria-label="重新生成回答" title="重新生成回答">${icon('regenerate')}</button>`}${retry}
    </div>
  </article>`;
}

function nodeFromMarkup(ownerDocument, markup) {
  const template = ownerDocument.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

function updateThinkingView(article, message) {
  const presentation = thinkingPresentation(message);
  let block = article.querySelector('[data-message-thought]');
  if (!presentation.visible) {
    block?.remove();
    return;
  }
  if (!block) {
    block = nodeFromMarkup(article.ownerDocument, messageMarkup(message));
    const assistant = block?.querySelector?.('[data-message-thought]');
    const anchor = article.querySelector('[data-message-progress]') || article.querySelector('[data-message-content]');
    if (!assistant || !anchor) return;
    anchor.before(assistant);
    hydrateIcons(assistant);
    block = assistant;
  }
  block.classList.toggle('is-streaming', presentation.active);
  const button = block.querySelector('[data-action="toggle-thinking"]');
  const label = block.querySelector('[data-thinking-label]');
  const content = block.querySelector('.thinking-content');
  const reason = block.querySelector('[data-thinking-text]');
  const brain = block.querySelector('.thinking-brain-icon');
  if (button) {
    button.classList.toggle('is-open', presentation.expanded);
    button.setAttribute('aria-expanded', String(presentation.expanded));
  }
  if (label) label.textContent = presentation.label;
  if (content) content.hidden = !presentation.expanded;
  if (reason && reason.textContent !== String(message.reasoning || '')) reason.textContent = String(message.reasoning || '');
  if (brain) {
    brain.classList.toggle('is-shaking', presentation.active);
    brain.classList.toggle('is-settled', !presentation.active);
  }
  const cursor = content?.querySelector('.thinking-cursor');
  if (presentation.active && content && !cursor) {
    const span = article.ownerDocument.createElement('span');
    span.className = 'thinking-cursor';
    span.setAttribute('aria-hidden', 'true');
    content.append(span);
  } else if (!presentation.active) {
    cursor?.remove();
  }
}

function updateProgressView(article, message) {
  const progress = replyProgressLabel(message);
  let node = article.querySelector('[data-message-progress]');
  if (!progress) {
    node?.remove();
    return;
  }
  if (!node) {
    node = nodeFromMarkup(article.ownerDocument,
      `<div class="message-state request-progress" role="status" data-message-progress></div>`);
    article.querySelector('[data-message-content]')?.before(node);
  }
  const phase = String(message.requestPhase || '');
  const text = node.querySelector('[data-progress-text]');
  if (text) text.textContent = progress;
  else node.textContent = progress;
  if (node.dataset.requestPhase !== phase) {
    node.dataset.requestPhase = phase;
    const iconName = message.requestPhase === 'reading' ? 'article' : 'history';
    node.innerHTML = `${icon(iconName)}<span data-progress-text>${escapeHtml(progress)}</span>`;
  }
}

export function messageMarkup(message, options = {}) {
  return message?.role === 'user'
    ? userMessageMarkup(message)
    : assistantMessageMarkup(message, options);
}

export function updateStreamingMessage({
  message,
  article,
  messagesElement,
  conversationView,
  followToPage,
  showSuggestions = false,
}) {
  if (!message || !article) return false;
  if ((message.status || 'complete') !== 'streaming') {
    const position = captureViewPosition(conversationView, messagesElement);
    article.outerHTML = messageMarkup(message, { showSuggestions });
    const rendered = messagesElement.querySelector(`[data-message-id="${message.id}"]`);
    if (!rendered) return false;
    renderMessageContent(rendered.querySelector('[data-message-content]'), message.content, false);
    hydrateIcons(rendered);
    restoreViewPosition(conversationView, messagesElement, position, followToPage);
    return true;
  }
  const position = captureViewPosition(conversationView, messagesElement);
  updateThinkingView(article, message);
  updateProgressView(article, message);
  const contentElement = article.querySelector('[data-message-content]');
  if (!contentElement) return false;
  renderMessageContent(contentElement, message.content, true);
  restoreViewPosition(conversationView, messagesElement, position, followToPage);
  return true;
}

export function messageAttachments(message) {
  return Array.isArray(message?.attachments) ? message.attachments : [];
}

export function messageFileNames(message) {
  return compact(map(messageAttachments(message), 'name'));
}

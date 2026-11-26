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
import { disclaimerForSkill } from '../fund-mode/fund-mode-prompt.js';
import { getFundSkill } from '../fund-mode/fund-skills.js';
import { bindFundMarkdownInteractions, enhanceFundMarkdown } from '../fund-mode/fund-markdown-view.js';
import { agentPanelMarkup, syncAgentPanel } from './agent-message-view.js';
import { captureViewPosition, restoreViewPosition } from './scroll-position.js';
import { replyElapsedLabel } from './reply-progress.js';
import { replyActivityMarkup, updateReplyActivity } from './reply-activity-view.js';
import { finishReplyMotion, revealGeneratedImage, revealSuggestions } from './reply-motion.js';
import { allowsMotion, reveal } from '../../core/motion.js';
import { messageErrorMarkup, messageModeBadgeMarkup, syncMessageDecorations } from './message-decorations.js';
import { syncChildren } from './dom-reconcile.js';
import { parseSuggestionResponse, suggestedReadingQuestions, suggestedVideoQuestions } from './model-suggestions.js';
import { articleQuotes } from './article-quote-draft.js';
import { shouldCollapseMessageText } from './text-preview.js';
import { videoAttachmentName } from '../video-notes/video-notes-presentation.js';
import { videoNotesDetailsMarkup } from '../video-notes/transcript-context.js';
import { directImageForMessage } from '../../../utils/image-generation-command.js';
import { decorateCodeBlocks } from './code-blocks.js';
import { bindTableCellTooltips, decorateTableBlocks } from './table-blocks.js';
import { detachMessageIllustrations, generatedImagesMarkup, illustrationNote, imageReplyPlaceholder, replaceMessageIllustrations, restoreMessageIllustrations, videoIllustrationNote } from '../illustration/illustration-view.js';
import '../illustration/illustration-inline.css';

export { normalizeMessageError, syncMessageErrorToggle } from './message-decorations.js';
export { setThinkingExpanded } from './reply-activity-view.js';

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

export function renderMessageContent(container, content, streaming = false, { textOnly = false, fundMode = false } = {}) {
  if (!container) return;
  const fragment = renderedContent(content, streaming, container.ownerDocument);
  if (textOnly) fragment.querySelectorAll('picture, img, audio, video').forEach(node => node.remove());
  if (fundMode) enhanceFundMarkdown(fragment, { streaming });
  if (!streaming && container.hasAttribute('data-message-content')) {
    decorateCodeBlocks(fragment);
    decorateTableBlocks(fragment);
  }
  detachMessageIllustrations(container);
  syncChildren(container, fragment);
  restoreMessageIllustrations(container);
  if (fundMode) bindFundMarkdownInteractions(container);
  if (!streaming && container.hasAttribute('data-message-content')) bindTableCellTooltips(container);
  container.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow';
  });
  if (!streaming) {
    container.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  }
  syncMessageDecorations(container.closest('.assistant-message'));
}

function messageOperation(message) {
  if (message.pageCommand?.kind === 'video-notes' && message.pageCommand.version === 1) {
    const scan = message.pageCommand.frameFallback === true;
    const title = scan ? '从画面识别字幕' : '整理当前视频的笔记';
    const text = String(message.displayContent || '');
    return { title, type: scan ? '画面识别' : '视频笔记', iconName: scan ? 'scan' : 'video', text: text === title ? '' : text };
  }
  const image = directImageForMessage(message);
  if (!image) return null;
  return { title: '生成图片', type: message.attachments?.some(item => item.type === 'image') ? '参考图生图' : '图片生成',
    iconName: 'sparkles', text: image.prompt };
}

function userMessageMarkup(message) {
  const files = Array.isArray(message.attachments) ? message.attachments : [];
  const images = map(filter(files, (item) =>
    item.type === 'image' && safeAttachmentDataUrl(item.dataUrl)), (item) =>
    `<img class="message-image" data-image-preview tabindex="0" role="button" aria-haspopup="dialog" aria-label="查看图片 ${escapeHtml(item.name)}" title="点击放大" src="${safeAttachmentDataUrl(item.dataUrl)}" alt="${escapeHtml(item.name)}" />`)
    .join('');
  const names = map(files.filter(item => item.type !== 'skill'), (item) =>
    `<span class="message-file">${icon(item.type === 'image' ? 'image' : 'file')}<span>${escapeHtml(videoAttachmentName(item))}</span></span>`)
    .join('');
  const skills = files.filter(item => item.type === 'skill').map(item =>
    `<details class="message-skill"><summary>Skill · ${escapeHtml(item.name || '本轮指南')}</summary><pre>${escapeHtml(item.skill?.raw || '本轮 Skill 记录不可用，请回退重新选择。')}</pre></details>`).join('');
  const imageErrors = files.map(imageAttachmentLoadError).filter(Boolean)
    .map(error => `<small class="message-file-error">${escapeHtml(error)}</small>`).join('');
  const operation = messageOperation(message);
  const operationHeader = operation ? `<header class="user-operation-header"><span class="user-operation-icon">${icon(operation.iconName)}</span><span><small>快捷操作 · ${operation.type}</small><strong>${operation.title}</strong></span></header>` : '';
  const bodyText = operation ? operation.text : message.displayContent ?? message.content;
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
  return `<article class="message user-message${operation ? ' user-operation' : ''}" data-message-id="${message.id}">${operationHeader || messageModeBadgeMarkup(message)}${selection}${images}${body}${names ? `<div class="message-files">${names}</div>` : ''}${skills}${imageErrors}${actions}</article>`;
}

function fundChartsMarkup(message) {
  const charts = Array.isArray(message.fundCharts) ? message.fundCharts : [];
  const safe = charts.filter(item => typeof item?.url === 'string' && item.url.startsWith('https://')).slice(0, 4);
  if (!safe.length) return '';
  const items = safe.map(item => `
    <figure class="fund-chart-card">
      <div class="fund-chart-frame">
        <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.label || '盈米研报图表')}" loading="lazy" referrerpolicy="no-referrer" />
      </div>
      <figcaption>
        <span class="fund-chart-caption">${escapeHtml(item.label || '盈米研报图表')}</span>
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">查看大图 ↗</a>
      </figcaption>
    </figure>
  `).join('');
  return `<div class="fund-charts-grid">${items}</div>`;
}

function fundMetaMarkup(message) {
  if (!message.fundMode) return '';
  const status = message.status || 'complete';
  const list = Array.isArray(message.fundSources) ? message.fundSources : [];
  const skill = getFundSkill(message.fundSkillId);
  const skillBadge = skill ? ` · ${escapeHtml(skill.shortLabel)}` : '';
  const sourcesHtml = list.length ? `
    <details class="fund-sources-details">
      <summary><span>盈米 MCP 数据调用（${list.length} 项）${skillBadge}</span><span>展开</span></summary>
      <ul class="fund-sources-list">
        ${list.map(item => {
          const badge = item.ok === false
            ? '<span class="fund-source-tag is-error">失败</span>'
            : item.cached
              ? '<span class="fund-source-tag">命中缓存</span>'
              : `<span class="fund-source-tag">${Number(item.durationMs || 0)} ms</span>`;
          return `<li><span>${escapeHtml(item.label || item.tool || '盈米查询')}</span>${badge}</li>`;
        }).join('')}
      </ul>
    </details>
  ` : '';
  const disclaimerHtml = status === 'complete' || status === 'stopped'
    ? `<p class="fund-disclaimer">${escapeHtml(disclaimerForSkill(message.fundSkillId))}</p>`
    : '';
  if (!sourcesHtml && !disclaimerHtml) return '';
  return `<div class="fund-meta-footer">${sourcesHtml}${disclaimerHtml}</div>`;
}

function sourcesMarkup(message) {
  const sources = Array.isArray(message.sources) ? message.sources : [];
  if (!sources.length) return '';
  const readUnavailable = source => source.readError === 'upstream-unavailable';
  const allRead = sources.every(source => source.readStatus === 'body' && !readUnavailable(source));
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
    const unavailable = readUnavailable(s);
    const evidence = s.readStatus === 'body' ? (unavailable ? '已有正文' : '已读正文')
      : ['search-summary', 'snippet'].includes(s.readStatus) ? '搜索摘要' : '读取状态未知';
    const details = `${host ? `${host} · ` : ''}${evidence}${unavailable ? ' · 正文读取暂不可用' : ''}${s.truncated === true ? ' · 内容已截断' : ''}`;
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
    <div class="sources-popover ui-popover" hidden>
      <div class="sources-popover-list">${listItems}</div>
    </div>
  </div>`;
}

function tryNextMarkup(message, { showSuggestions = false } = {}) {
  if (!showSuggestions || (message.status && message.status !== 'complete')) return '';
  let suggestions = Array.isArray(message.suggestions) && message.suggestions.length > 0
    ? parseSuggestionResponse(JSON.stringify(message.suggestions.filter(value => typeof value === 'string')), { answer: message.content })
    : [];
  if (!suggestions.length && !message.agent) {
    if (message.videoNotesOutcome === 'notes') suggestions = suggestedVideoQuestions(message.content);
    else if (!message.videoNotesVersion) suggestions = suggestedReadingQuestions(message.content);
  }
  if (!suggestions.length) return '';
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

function assistantParts(message, { showSuggestions = false, frameActions, allowImageReference = false, textOnly = false, live = false } = {}) {
  const status = message.status || 'complete';
  const stopped = status === 'stopped'
    ? `<div class="message-state">${icon('stop')}已停止，已保留当前回答</div>`
    : '';
  const error = messageErrorMarkup(message);
  const retry = !message.agent && !frameActions?.hideRetry && ['stopped', 'error'].includes(status)
    ? `<button class="action-text" data-action="retry" type="button">${icon('regenerate')}重试</button>`
    : '';
  const activity = `<div class="message-activity">${live ? '' : replyActivityMarkup(message)}</div>`;
  const elapsed = live ? '' : replyElapsedLabel(message);
  const elapsedTitle = message.agent ? '从任务开始到结束，含暂停和人工处理时间'
    : '从本轮开始执行到回复结束，不含排队与回复后配图';
  const model = message.model
    ? `<span class="message-model">${escapeHtml(message.model)}${message.reasoningEffort && message.reasoningEffort !== 'default' ? ` · ${escapeHtml(message.reasoningEffort)}` : ''}</span>`
    : '';
  const agent = message.agent
    ? agentPanelMarkup(message.agent)
    : '';
  const sources = textOnly ? '' : sourcesMarkup(message);
  const fundCharts = textOnly ? '' : fundChartsMarkup(message);
  const fundMeta = textOnly ? '' : fundMetaMarkup(message);
  const tryNext = textOnly ? '' : tryNextMarkup(message, { showSuggestions });
  const details = textOnly ? '' : videoNotesDetailsMarkup(message.videoNotesScope);
  const frameButtons = frameActions?.buttons?.length ? `<div class="video-frame-actions" role="group" aria-label="视频画面识别">${frameActions.buttons.map(button =>
    `<button class="action-text" data-action="${escapeHtml(button.action)}" type="button" aria-haspopup="dialog">${icon('article')}${escapeHtml(button.label)}</button>`).join('')}</div>` : '';
  return {
    label: `<div class="message-label"><span class="assistant-avatar" aria-hidden="true"></span><span class="assistant-name">UNK AI</span>${model}<span class="message-meta">${live || elapsed ? `<span class="message-elapsed" data-message-elapsed title="${elapsedTitle}">${escapeHtml(elapsed)}</span>` : ''}<time>${formatTime(message.createdAt)}</time></span></div>`,
    agent, activity, body: '<div class="message-content" data-message-content></div>', videoNotesDetails: details, frameButtons,
    gallery: textOnly ? '' : generatedImagesMarkup(message, { allowImageReference }),
    illustration: textOnly ? '' : illustrationNote(message),
    videoIllustration: textOnly ? '' : videoIllustrationNote(message),
    sources, fundCharts, fundMeta, tryNext, stopped, error,
    actions: `<div class="message-actions"${status === 'streaming' ? ' inert' : ''}>
      <button class="icon-button" data-action="copy" type="button" aria-label="复制回答" title="选择复制格式" aria-haspopup="menu" aria-expanded="false">${icon('copy')}</button>
      ${message.agent ? (['failed', 'cancelled'].includes(message.agent.status) ? `<button class="action-text" data-action="restart-agent" type="button">${icon('regenerate')}重新开始任务</button>` : '') : frameActions?.hideRetry ? '' : `<button class="icon-button" data-action="regenerate" type="button" aria-label="重新生成回答" title="重新生成回答">${icon('regenerate')}</button>`}${retry}
    </div>`,
  };
}

function nodeFromMarkup(ownerDocument, markup) {
  const template = ownerDocument.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

export function createReplyClock({ root, getConversation, getRun, isVisible = () => true }) {
  let timer = null;
  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }
  function sync() {
    const ref = getRun()?.ref;
    const conversation = getConversation();
    const message = ref && conversation?.id === ref.conversationId && isVisible()
      ? conversation.messages.find(item => item.id === ref.assistantId && item.runId === ref.runId) : null;
    const article = message?.status === 'streaming' && root.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
    if (!article) { stop(); return; }
    updateReplyActivity(article, message);
    timer ??= setInterval(sync, 1000);
  }
  return Object.freeze({ sync, stop });
}

export function messageMarkup(message, options = {}) {
  return message?.role === 'user'
    ? userMessageMarkup(message)
    : `<article class="message assistant-message" data-message-id="${message.id}" data-response-status="${message.status || 'complete'}"${message.fundMode ? ' data-fund-mode="true"' : ''}>${Object.values(assistantParts(message, options)).join('')}</article>`;
}

const articlePaints = new WeakMap();
const figureId = node => node.dataset.illustrationId;

function paintParts(article, parts, cache) {
  let anchor = null;
  for (const [key, markup] of Object.entries(parts).reverse()) {
    const previous = cache.get(key);
    let node = previous?.node;
    if (markup !== previous?.markup) {
      const next = markup ? nodeFromMarkup(article.ownerDocument, markup) : null;
      if (key === 'agent' && node && next && node.dataset.agentTask === next.dataset.agentTask) syncAgentPanel(node, next);
      else {
        node?.remove();
        node = next;
        if (node) hydrateIcons(node);
      }
      if (node) cache.set(key, { node, markup });
      else cache.delete(key);
    }
    if (!node) continue;
    if (node.parentElement !== article || node.nextElementSibling !== anchor) article.insertBefore(node, anchor);
    anchor = node;
  }
}

function updateLiveReply(article, message, imageLayout) {
  const status = message.status || 'complete';
  article.dataset.responseStatus = status;
  article.classList.toggle('is-awaiting-first-token', status === 'streaming' && !message.agent && !message.content);
  updateReplyActivity(article, message);
  const activity = article.querySelector('.message-activity');
  const pending = activity.querySelector('[data-image-reply-placeholder]');
  if (message.status === 'streaming' && message.requestPhase === 'generating-image') {
    if (!pending) activity.append(nodeFromMarkup(article.ownerDocument, imageReplyPlaceholder(imageLayout)));
  } else pending?.remove();
}

export function paintConversationMessage(article, message, options = {}) {
  const previous = articlePaints.get(article);
  article.dataset.messageId = message.id;
  if (message.role === 'user') {
    const markup = userMessageMarkup(message);
    if (markup !== previous?.markup) {
      const next = nodeFromMarkup(article.ownerDocument, markup);
      article.className = next.className;
      article.replaceChildren(...next.childNodes);
    }
    articlePaints.set(article, { markup });
    return;
  }

  const { gallery, ...parts } = assistantParts(message, { ...options, live: true });
  const cache = previous?.parts || new Map();
  const galleryChanged = previous?.gallery !== gallery;
  const status = message.status || 'complete';
  const finished = previous?.status === 'streaming' && status === 'complete';
  const hadCursor = finished && Boolean(article.querySelector('.streaming-cursor'));
  const newSources = Boolean(parts.sources && !cache.has('sources'));
  const newSuggestions = Boolean(parts.tryNext && parts.tryNext !== cache.get('tryNext')?.markup);
  const reserve = new Map();
  const ready = new Set();
  let directHeight = 0;
  if (gallery && galleryChanged && previous && allowsMotion(article)) {
    for (const figure of article.querySelectorAll('figure.generated-image[data-illustration-id]')) {
      const pending = figure.querySelector('.generated-image-placeholder');
      if (pending) reserve.set(figureId(figure), pending.offsetHeight);
      else if (figure.querySelector('.generated-image-media')) ready.add(figureId(figure));
    }
    directHeight = article.querySelector('[data-image-reply-placeholder]')?.offsetHeight || 0;
  }
  if (!previous) article.className = 'message assistant-message';
  if (message.fundMode) article.dataset.fundMode = 'true';
  else delete article.dataset.fundMode;
  paintParts(article, parts, cache);
  updateLiveReply(article, message, options.imageLayout);
  const content = cache.get('body').node;
  if (galleryChanged) replaceMessageIllustrations(content, gallery ? nodeFromMarkup(article.ownerDocument, gallery) : null);
  if (galleryChanged || previous?.content !== message.content || previous?.status !== status) {
    renderMessageContent(content, message.content, status === 'streaming', { fundMode: Boolean(message.fundMode) });
  } else syncMessageDecorations(article);
  articlePaints.set(article, { parts: cache, gallery, status, content: message.content });
  if (finished) finishReplyMotion(article, hadCursor);
  if (!previous || status !== 'complete') return;

  if (newSources) {
    const sources = cache.get('sources').node;
    reveal(sources.querySelector('.sources-pill'), 'sources-enter', { distance: 4, delay: finished ? 90 : 0 });
    sources.querySelectorAll('.source-icon-mini').forEach((item, index) => {
      reveal(item, 'source-icon-enter', { distance: 3, delay: (finished ? 104 : 14) + index * 28 });
    });
  }
  if (gallery && galleryChanged) {
    const images = [...content.querySelectorAll('.generated-image-media > img')];
    images.forEach((image, index) => {
      const id = figureId(image.closest('figure'));
      if (!ready.has(id)) revealGeneratedImage(image, { delay: (finished ? 80 : 0) + index * 30, reservedHeight: reserve.get(id) || directHeight });
    });
  }
  if (newSuggestions && article.parentElement.dataset.nextExploration === 'on') {
    revealSuggestions(cache.get('tryNext').node, finished || newSources ? 150 : 0);
  }
}

export function updateStreamingMessage({
  message,
  frameActions,
  allowImageReference,
  article,
  messagesElement,
  conversationView,
  followToPage,
  showSuggestions = false,
  imageLayout,
}) {
  if (!message || !article) return false;
  if ((message.status || 'complete') !== 'streaming') {
    const position = captureViewPosition(conversationView, messagesElement);
    if (articlePaints.has(article)) {
      paintConversationMessage(article, message, { showSuggestions, frameActions, allowImageReference, imageLayout });
      restoreViewPosition(conversationView, messagesElement, position, followToPage);
      return true;
    }
    article.outerHTML = messageMarkup(message, { showSuggestions, frameActions, allowImageReference });
    const rendered = messagesElement.querySelector(`[data-message-id="${message.id}"]`);
    if (!rendered) return false;
    renderMessageContent(rendered.querySelector('[data-message-content]'), message.content, false, { fundMode: Boolean(message.fundMode) });
    hydrateIcons(rendered);
    restoreViewPosition(conversationView, messagesElement, position, followToPage);
    return true;
  }
  const position = captureViewPosition(conversationView, messagesElement);
  updateLiveReply(article, message, imageLayout);
  const contentElement = article.querySelector('[data-message-content]');
  if (!contentElement) return false;
  const painted = articlePaints.get(article);
  if (!painted || painted.content !== message.content) {
    renderMessageContent(contentElement, message.content, true, { fundMode: Boolean(message.fundMode) });
  }
  if (painted) painted.content = message.content;
  restoreViewPosition(conversationView, messagesElement, position, followToPage);
  return true;
}

export function messageAttachments(message) {
  return Array.isArray(message?.attachments) ? message.attachments : [];
}

export function messageFileNames(message) {
  return compact(map(messageAttachments(message), 'name'));
}

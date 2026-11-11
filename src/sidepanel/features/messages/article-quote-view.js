import { articleQuotes } from './article-quote-draft.js';

const HIGHLIGHT_NAME = 'unk-article-quotes';
const normalized = value => String(value || '').replace(/\r\n?/g, '\n').trim();
const markerSize = 22;
const MAX_RENDER_TEXT = 2000000;
const MAX_TEXT_NODES = 20000;

/** Present a quote draft without owning submission, storage or its references. */
export function createArticleQuoteView({ document = globalThis.document, root, host,
  getConversation, getSelection, onEdit = () => {}, onRemove = () => {}, onClear = () => {},
  focusInput = () => {}, getViewportRect } = {}) {
  if (!document || !root || !host) throw new TypeError('引用注释需要正文和输入区节点。');
  const view = document.defaultView;
  const registry = view?.CSS?.highlights;
  const HighlightType = view?.Highlight;
  const layer = document.createElement('div');
  layer.className = 'article-quote-markers';
  document.body.append(layer);
  host.classList.add('article-quote-draft');
  host.hidden = true;
  const removers = [];
  const rows = new Map();
  const markers = new Map();
  let quotes = [];
  let ranges = [];
  let expanded = false;
  let previousOwner = null;
  let rendered = '';
  let toggle, list;
  let frame = null;
  let refreshRanges = false;
  let disposed = false;
  const listen = (element, type, handler, options) => {
    element.addEventListener(type, handler, options);
    removers.push(() => element.removeEventListener(type, handler, options));
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const button = (className, text, action, label = text) => {
    const node = element('button', className, text);
    node.type = 'button';
    node.dataset.quoteAction = action;
    node.setAttribute('aria-label', label);
    return node;
  };
  function reflectExpanded() {
    toggle?.setAttribute('aria-expanded', String(expanded));
    if (list) list.hidden = !expanded;
    host.dataset.expanded = String(expanded);
  }
  function renderDraft() {
    rows.clear();
    toggle = button('article-quote-toggle', `${quotes.length} 条引用注释`, 'toggle');
    toggle.setAttribute('aria-expanded', String(expanded));
    list = element('ol', 'article-quote-list');
    list.setAttribute('aria-label', '当前提问的引用注释');
    quotes.forEach((quote, index) => {
      const number = index + 1;
      const row = element('li', 'article-quote-item');
      row.dataset.quoteId = quote.id;
      const numberLabel = element('span', 'article-quote-number', number);
      numberLabel.setAttribute('aria-hidden', 'true');
      const content = element('div', 'article-quote-item-content');
      const text = element('blockquote', 'article-quote-text', quote.text);
      const comment = element('p', 'article-quote-comment', quote.comment || '仅引用原文');
      const source = element('small', 'article-quote-source', `来自：${quote.heading || quote.title || '对话回答'}${quote.truncated || quote.commentTruncated ? ' · 内容已截断' : ''}`);
      const actions = element('div', 'article-quote-item-actions');
      const edit = button('article-quote-edit', '修改', 'edit', `修改第 ${number} 条引用注释`);
      const remove = button('article-quote-remove', '移除', 'remove', `移除第 ${number} 条引用注释`);
      edit.dataset.quoteId = remove.dataset.quoteId = quote.id;
      actions.append(edit, remove);
      content.append(text, comment, source, actions);
      row.append(numberLabel, content);
      list.append(row);
      rows.set(quote.id, { row, edit });
    });
    const actions = element('div', 'article-quote-actions');
    actions.append(button('article-quote-clear', '清空引用注释', 'clear'));
    host.replaceChildren(toggle, list, actions);
    reflectExpanded();
  }
  function textSnapshot(body) {
    const nodes = [];
    const walker = document.createTreeWalker(body, view?.NodeFilter?.SHOW_TEXT || 4);
    let text = '', node;
    while ((node = walker.nextNode())) {
      const value = String(node.nodeValue ?? node.textContent ?? '');
      if (nodes.length >= MAX_TEXT_NODES || text.length + value.length > MAX_RENDER_TEXT) return null;
      nodes.push({ node, start: text.length, end: text.length + value.length });
      text += value;
    }
    return { nodes, text };
  }
  function rangeFor(quote, body, snapshot) {
    let start = quote.anchor?.start, end = quote.anchor?.end;
    if (!quote.anchor) {
      start = snapshot.text.indexOf(quote.text);
      if (start < 0 || snapshot.text.indexOf(quote.text, start + 1) >= 0) return null;
      end = start + quote.text.length;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
      || end > snapshot.text.length || body.isConnected === false) return null;
    const boundary = position => {
      const entry = snapshot.nodes.find(item => position >= item.start && position <= item.end);
      return entry ? [entry.node, position - entry.start] : null;
    };
    const from = boundary(start), to = boundary(end);
    if (!from || !to) return null;
    try {
      const range = document.createRange();
      range.setStart(...from);
      range.setEnd(...to);
      const actual = normalized(range.toString());
      const matches = actual === quote.text || (quote.textTruncated && quote.originalLength >= actual.length
        && actual.startsWith(quote.text));
      return matches ? range : null;
    } catch { return null; }
  }
  function rebuildRanges(conversation) {
    ranges = [];
    const snapshots = new Map();
    const articles = [...root.querySelectorAll('.assistant-message[data-message-id]')];
    quotes.forEach((quote, index) => {
      if (quote.conversationId !== conversation?.id || !conversation.messages?.some(message =>
        message.id === quote.messageId && message.role === 'assistant')) return;
      const article = articles.find(node => node.dataset.messageId === quote.messageId && node.isConnected !== false);
      const body = article?.querySelector('[data-message-content]') || article?.querySelector('.message-content');
      if (!body) return;
      let snapshot = snapshots.get(body);
      if (!snapshots.has(body)) { snapshot = textSnapshot(body); snapshots.set(body, snapshot); }
      if (!snapshot) return;
      const range = rangeFor(quote, body, snapshot);
      if (range) ranges.push({ quote, range, number: index + 1 });
    });
    try {
      registry?.delete(HIGHLIGHT_NAME);
      if (ranges.length && HighlightType && registry) registry.set(HIGHLIGHT_NAME, new HighlightType(...ranges.map(item => item.range)));
    } catch { /* The draft and numbered anchors remain usable without Highlight. */ }
  }
  function viewport() {
    const available = getViewportRect?.() || {};
    const width = Number(view?.innerWidth) || Number(document.documentElement?.clientWidth) || 1;
    const height = Number(view?.innerHeight) || Number(document.documentElement?.clientHeight) || 1;
    return { left: Math.max(0, Number(available.left) || 0), top: Math.max(0, Number(available.top) || 0),
      right: Math.min(width, Number.isFinite(available.right) ? available.right : width),
      bottom: Math.min(height, Number.isFinite(available.bottom) ? available.bottom : height) };
  }
  function placeMarkers() {
    if (disposed) return;
    const visible = new Set(), occupied = [], bounds = viewport();
    for (const { quote, range, number } of ranges) {
      const rect = [...(range.getClientRects?.() || [])].filter(item => item.width > 0 && item.height > 0
        && item.right > bounds.left && item.left < bounds.right && item.bottom > bounds.top && item.top < bounds.bottom).at(-1);
      if (!rect || bounds.right - bounds.left < markerSize || bounds.bottom - bounds.top < markerSize) continue;
      const left = Math.min(bounds.right - markerSize, Math.max(bounds.left, rect.right + 2));
      const top = Math.min(bounds.bottom - markerSize, Math.max(bounds.top, rect.top - 12));
      const offsets = [[0, 0], [0, -24], [24, 0], [-24, 0], [0, 24], [24, -24], [-24, -24], [24, 24], [-24, 24], [0, -48], [0, 48]];
      const position = offsets.map(([x, y]) => ({ left: left + x, top: top + y })).find(candidate =>
        candidate.left >= bounds.left && candidate.left + markerSize <= bounds.right
        && candidate.top >= bounds.top && candidate.top + markerSize <= bounds.bottom
        && occupied.every(previous => Math.abs(previous.left - candidate.left) >= markerSize
          || Math.abs(previous.top - candidate.top) >= markerSize));
      if (!position) continue;
      occupied.push(position);
      visible.add(quote.id);
      let marker = markers.get(quote.id);
      if (!marker) {
        marker = element('button', 'article-quote-marker');
        marker.type = 'button';
        marker.dataset.quoteId = quote.id;
        layer.append(marker);
        markers.set(quote.id, marker);
      }
      marker.textContent = String(number);
      marker.setAttribute('aria-label', `查看第 ${number} 条引用注释`);
      marker.title = quote.comment || quote.text;
      marker.style.left = `${position.left}px`;
      marker.style.top = `${position.top}px`;
    }
    for (const [id, marker] of markers) if (!visible.has(id)) { marker.remove(); markers.delete(id); }
  }
  function sync() {
    if (disposed) return;
    if (frame !== null) { view.cancelAnimationFrame(frame); frame = null; }
    refreshRanges = false;
    const conversation = getConversation?.();
    quotes = articleQuotes(getSelection?.());
    const owner = conversation?.id || null;
    if (owner !== previousOwner) { expanded = false; previousOwner = owner; }
    host.hidden = !quotes.length;
    const next = JSON.stringify(quotes);
    if (next !== rendered) { rendered = next; renderDraft(); }
    else reflectExpanded();
    rebuildRanges(conversation);
    placeMarkers();
  }
  function schedule(rebuild) {
    if (disposed) return;
    refreshRanges ||= rebuild;
    if (frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (refreshRanges) sync(); else placeMarkers();
    });
  }
  listen(host, 'click', event => {
    if (disposed) return;
    const action = event.target.closest?.('[data-quote-action]');
    if (!action || !host.contains(action)) return;
    const kind = action.dataset.quoteAction;
    if (kind === 'toggle') { expanded = !expanded; reflectExpanded(); return; }
    if (kind === 'clear') { onClear(); focusInput(); return; }
    const quote = articleQuotes(getSelection?.()).find(item => item.id === action.dataset.quoteId);
    if (!quote) return;
    if (kind === 'edit') onEdit(quote);
    else if (kind === 'remove') onRemove(quote.id);
  });
  listen(layer, 'pointerdown', event => {
    if (event.target.closest?.('.article-quote-marker')) event.preventDefault();
  });
  listen(layer, 'click', event => {
    if (disposed) return;
    const marker = event.target.closest?.('.article-quote-marker');
    if (!marker || !layer.contains(marker) || !quotes.some(quote => quote.id === marker.dataset.quoteId)) return;
    expanded = true;
    reflectExpanded();
    const entry = rows.get(marker.dataset.quoteId);
    entry?.row.scrollIntoView?.({ block: 'nearest' });
    entry?.edit.focus({ preventScroll: true });
  });
  // The conversation scroller is an ancestor of the message root. Capture all
  // scroll events so fixed markers also follow that outer viewport.
  listen(document, 'scroll', () => schedule(false), true);
  listen(view, 'resize', () => schedule(false));
  const observer = view?.MutationObserver ? new view.MutationObserver(() => schedule(true)) : null;
  observer?.observe(root, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'open'] });
  sync();
  return Object.freeze({ sync, dispose() {
    if (disposed) return;
    disposed = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    observer?.disconnect();
    removers.forEach(remove => remove());
    registry?.delete(HIGHLIGHT_NAME);
    ranges = [];
    rows.clear(); markers.clear();
    layer.remove();
    host.replaceChildren();
    host.hidden = true;
  } });
}

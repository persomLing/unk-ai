import { articleQuotes } from './article-quote-draft.js';

const HIGHLIGHT_NAME = 'unk-article-quotes';
const normalized = value => String(value || '').replace(/\r\n?/g, '\n').trim();
const markerSize = 22;
const MAX_RENDER_TEXT = 2000000;
const MAX_TEXT_NODES = 20000;

/** Present a quote draft without owning submission, storage or its references. */
export function createArticleQuoteView({ document = globalThis.document, root, host,
  getConversation, getSelection, onEdit = () => {}, onRemove = () => {}, onClear = () => {},
  focusInput = () => {}, getViewportRect, scrollContainer = root?.parentElement,
  onLocateUnavailable = () => {} } = {}) {
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
    toggle = button('article-quote-toggle', `${quotes.length} 条引用注释`, 'toggle');
    toggle.setAttribute('aria-expanded', String(expanded));
    list = element('ol', 'article-quote-list');
    list.setAttribute('aria-label', '当前提问的引用注释');
    quotes.forEach((quote, index) => {
      const number = index + 1;
      const row = element('li', 'article-quote-item');
      row.dataset.quoteId = quote.id;
      const content = button('article-quote-locate', '', 'locate', `定位第 ${number} 条引用原文`);
      content.dataset.quoteId = quote.id;
      const numberLabel = element('span', 'article-quote-number', number);
      numberLabel.setAttribute('aria-hidden', 'true');
      const text = element('span', 'article-quote-text', quote.text);
      const comment = element('span', 'article-quote-comment', quote.comment || '仅引用原文');
      content.title = `${quote.text}\n${quote.comment || '仅引用原文'}\n来自：${quote.heading || quote.title || '对话回答'}${quote.truncated || quote.commentTruncated ? ' · 内容已截断' : ''}\n点击定位原文`;
      const actions = element('div', 'article-quote-item-actions');
      const edit = button('article-quote-edit', '修改', 'edit', `修改第 ${number} 条引用注释`);
      const remove = button('article-quote-remove', '×', 'remove', `移除第 ${number} 条引用注释`);
      edit.title = '在原文附近修改注释';
      remove.title = '移除引用注释';
      edit.dataset.quoteId = remove.dataset.quoteId = quote.id;
      actions.append(edit, remove);
      content.append(numberLabel, text, comment);
      row.append(content, actions);
      list.append(row);
    });
    const actions = element('div', 'article-quote-actions');
    actions.append(button('article-quote-clear', '清空引用注释', 'clear'));
    const header = element('div', 'article-quote-header');
    header.append(toggle, actions);
    host.replaceChildren(header, list);
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
  const rectsFor = range => [...(range.getClientRects?.() || [])].filter(rect => rect.width > 0 && rect.height > 0);
  const inBounds = (rect, bounds) => rect.right > bounds.left && rect.left < bounds.right
    && rect.bottom > bounds.top && rect.top < bounds.bottom;
  function clippingContainers(range) {
    const elementFor = node => node?.nodeType === 1 ? node : node?.parentElement;
    let node = elementFor(range.commonAncestorContainer);
    if (!node) {
      node = elementFor(range.startContainer);
      while (node && !node.contains(range.endContainer)) node = node.parentElement;
    }
    const containers = [];
    for (; node && root.contains(node); node = node.parentElement) {
      const style = view?.getComputedStyle?.(node);
      const x = style?.overflowX, y = style?.overflowY;
      if ([x, y].some(value => /^(auto|scroll|hidden|clip)$/.test(value))) containers.push({ node, x, y });
      if (node === root) break;
    }
    return containers;
  }
  function scrollport(node) {
    const rect = node.getBoundingClientRect();
    const left = rect.left + node.clientLeft, top = rect.top + node.clientTop;
    return { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight };
  }
  function rangeBounds(range) {
    const bounds = viewport();
    for (const { node, x, y } of clippingContainers(range)) {
      const rect = scrollport(node);
      if (/^(auto|scroll|hidden|clip)$/.test(x)) {
        bounds.left = Math.max(bounds.left, rect.left); bounds.right = Math.min(bounds.right, rect.right);
      }
      if (/^(auto|scroll|hidden|clip)$/.test(y)) {
        bounds.top = Math.max(bounds.top, rect.top); bounds.bottom = Math.min(bounds.bottom, rect.bottom);
      }
    }
    return bounds;
  }
  function visibleRect(range) {
    const bounds = rangeBounds(range);
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
    const rect = rectsFor(range).find(item => inBounds(item, bounds));
    if (!rect) return null;
    const left = Math.max(bounds.left, rect.left), top = Math.max(bounds.top, rect.top);
    const right = Math.min(bounds.right, rect.right), bottom = Math.min(bounds.bottom, rect.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  function anchorRect(id) {
    if (disposed) return null;
    // Revalidate against the current draft and DOM, never a stale rendered row.
    sync();
    const entry = ranges.find(item => item.quote.id === id);
    return entry ? visibleRect(entry.range) : null;
  }
  function locate(id) {
    if (disposed) return null;
    sync();
    const entry = ranges.find(item => item.quote.id === id);
    if (!entry) return null;
    // Reveal nested code/table scrollports from inside out before moving the
    // conversation. Clipped, non-scrollable content must never look located.
    const offset = (start, end, min, max) => start < min ? start - min
      : Math.max(0, start + Math.min(end - start, max - min) - max);
    for (const { node, x, y } of clippingContainers(entry.range)) {
      const rect = rectsFor(entry.range)[0];
      if (!rect) return null;
      const port = scrollport(node);
      const left = /^(auto|scroll|hidden)$/.test(x) && node.scrollWidth > node.clientWidth && node.clientWidth > 0
        ? offset(rect.left, rect.right, port.left, port.right) : 0;
      const top = /^(auto|scroll|hidden)$/.test(y) && node.scrollHeight > node.clientHeight && node.clientHeight > 0
        ? offset(rect.top, rect.bottom, port.top, port.bottom) : 0;
      if (left || top) node.scrollBy({ left, top, behavior: 'instant' });
    }
    const rect = rectsFor(entry.range)[0];
    if (!rect) return null;
    const bounds = viewport();
    const top = rect.top - (bounds.top + (bounds.bottom - bounds.top) / 2);
    scrollContainer?.scrollBy?.({ top, behavior: 'instant' });
    placeMarkers();
    return visibleRect(entry.range);
  }
  function placeMarkers() {
    if (disposed) return;
    const visible = new Set(), occupied = [], bounds = viewport();
    Object.assign(layer.style, { left: `${bounds.left}px`, top: `${bounds.top}px`,
      width: `${Math.max(0, bounds.right - bounds.left)}px`, height: `${Math.max(0, bounds.bottom - bounds.top)}px` });
    for (const { quote, range, number } of ranges) {
      const clip = rangeBounds(range);
      const rect = rectsFor(range).filter(item => inBounds(item, clip)).at(-1);
      if (!rect || clip.right - clip.left < markerSize || clip.bottom - clip.top < markerSize) continue;
      const left = Math.min(clip.right - markerSize, Math.max(clip.left, rect.right + 2));
      const top = Math.min(clip.bottom - markerSize, Math.max(clip.top, rect.top - 12));
      const offsets = [[0, 0], [0, -24], [24, 0], [-24, 0], [0, 24], [24, -24], [-24, -24], [24, 24], [-24, 24], [0, -48], [0, 48]];
      const position = offsets.map(([x, y]) => ({ left: left + x, top: top + y })).find(candidate =>
        candidate.left >= clip.left && candidate.left + markerSize <= clip.right
        && candidate.top >= clip.top && candidate.top + markerSize <= clip.bottom
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
      marker.setAttribute('aria-label', `修改第 ${number} 条引用注释`);
      marker.title = quote.comment || quote.text;
      marker.style.left = `${position.left - bounds.left}px`;
      marker.style.top = `${position.top - bounds.top}px`;
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
    if (owner !== previousOwner || !quotes.length) { expanded = false; previousOwner = owner; }
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
    if (kind === 'toggle') { expanded = !expanded; reflectExpanded(); schedule(false); return; }
    if (kind === 'clear') { onClear(); focusInput(); return; }
    const quote = articleQuotes(getSelection?.()).find(item => item.id === action.dataset.quoteId);
    if (!quote) return;
    if (kind === 'edit') onEdit(quote);
    else if (kind === 'remove') onRemove(quote.id);
    else if (kind === 'locate') {
      if (locate(quote.id)) markers.get(quote.id)?.focus({ preventScroll: true });
      else onLocateUnavailable(quote);
    }
  });
  listen(layer, 'pointerdown', event => {
    if (event.target.closest?.('.article-quote-marker')) event.preventDefault();
  });
  listen(layer, 'click', event => {
    if (disposed) return;
    const marker = event.target.closest?.('.article-quote-marker');
    if (!marker || !layer.contains(marker)) return;
    const quote = articleQuotes(getSelection?.()).find(item => item.id === marker.dataset.quoteId);
    if (quote) onEdit(quote);
  });
  // The conversation scroller is an ancestor of the message root. Capture all
  // scroll events so fixed markers also follow that outer viewport.
  listen(document, 'scroll', () => schedule(false), true);
  listen(view, 'resize', () => schedule(false));
  const observer = view?.MutationObserver ? new view.MutationObserver(() => schedule(true)) : null;
  observer?.observe(root, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'open'] });
  const resizeObserver = view?.ResizeObserver ? new view.ResizeObserver(() => schedule(false)) : null;
  if (scrollContainer) resizeObserver?.observe(scrollContainer);
  resizeObserver?.observe(host);
  sync();
  return Object.freeze({ sync, locate, anchorRect, dispose() {
    if (disposed) return;
    disposed = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    observer?.disconnect();
    resizeObserver?.disconnect();
    removers.forEach(remove => remove());
    registry?.delete(HIGHLIGHT_NAME);
    ranges = [];
    markers.clear();
    layer.remove();
    host.replaceChildren();
    host.hidden = true;
  } });
}

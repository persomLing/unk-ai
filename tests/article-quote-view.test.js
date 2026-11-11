import test from 'node:test';
import assert from 'node:assert/strict';
import { createArticleQuoteView } from '../src/sidepanel/features/messages/article-quote-view.js';

function attributeName(name) { return name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()); }
class Element extends EventTarget {
  constructor(document, tag = 'div') {
    super(); this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.nodeType = 1;
    this.children = []; this.dataset = {}; this.style = {}; this.attributes = new Map(); this.className = '';
    this.isConnected = true; this.hidden = false;
    this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); } };
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; child.isConnected = false; }); this.children = []; this.append(...children); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text ?? this.children.map(child => child.textContent ?? child.nodeValue ?? '').join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return name.startsWith('data-') ? this.dataset[attributeName(name)] ?? null : this.attributes.get(name) ?? null; }
  contains(target) { return this === target || this.children.some(child => child === target || child.contains?.(target)); }
  matches(selector) {
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    if (!classes.every(name => this.className.split(/\s+/).includes(name))) return false;
    const attrs = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    return attrs.every(([, name, value]) => this.getAttribute(name) !== null && (value === undefined || this.getAttribute(name) === value));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => child.nodeType === 1 ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : []); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; this.isConnected = false; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolled = true; }
}

function fixture(t, { text = '先说明 metadata，再说明 metadata。', anchor = { start: 18, end: 26 }, source = 'conversation-a' } = {}) {
  const document = new EventTarget(), window = new EventTarget(), frames = new Map(), observerRecords = [];
  let sequence = 0;
  window.innerWidth = 420; window.innerHeight = 600; window.NodeFilter = { SHOW_TEXT: 4 };
  window.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.CSS = { highlights: new Map([['other-highlight', { ownedBySomeoneElse: true }]]) };
  window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
  window.MutationObserver = class {
    constructor(callback) { this.callback = callback; observerRecords.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  document.defaultView = window; document.documentElement = { clientWidth: 420, clientHeight: 600 };
  document.createElement = tag => new Element(document, tag);
  document.body = new Element(document, 'body');
  const root = new Element(document, 'section'), host = new Element(document);
  const article = new Element(document, 'article'); article.className = 'assistant-message'; article.dataset.messageId = 'answer-a';
  const body = new Element(document); body.className = 'message-content'; body.attributes.set('data-message-content', '');
  const textNode = { nodeType: 3, nodeValue: text, parentElement: body };
  body.append(textNode); article.append(body); root.append(article); document.body.append(root, host);
  document.createTreeWalker = node => {
    const collect = value => value.nodeType === 3 ? [value] : value.children.flatMap(collect);
    const values = collect(node); let index = 0;
    return { nextNode: () => values[index++] || null };
  };
  document.createRange = () => ({
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
    absolute(node, offset) {
      const walker = document.createTreeWalker(body); let total = 0, current;
      while ((current = walker.nextNode())) { if (current === node) return total + offset; total += current.nodeValue.length; }
      throw new Error('Detached text boundary');
    },
    toString() {
      const walker = document.createTreeWalker(body); let all = '', current;
      while ((current = walker.nextNode())) all += current.nodeValue;
      return all.slice(this.absolute(this.startContainer, this.startOffset), this.absolute(this.endContainer, this.endOffset));
    },
    getClientRects() {
      const start = this.absolute(this.startContainer, this.startOffset), end = this.absolute(this.endContainer, this.endOffset);
      const left = 20 + start * 2, width = (end - start) * 2;
      return [{ left, top: 90, right: left + width, bottom: 110, width, height: 20 }];
    },
  });
  const start = text.lastIndexOf('metadata');
  const quote = { source: 'conversation', sourceVersion: 1, conversationId: source, messageId: 'answer-a', role: 'assistant',
    text: 'metadata', context: '术语说明', question: 'metadata 是什么？', title: 'RAG', heading: '资料', selectedAt: '2026-11-11',
    originalLength: 8, ...(anchor === false ? {} : { anchor: anchor || { start, end: start + 8 } }) };
  let selection = { ...quote, sourceVersion: 2, revision: 1, annotations: [{ ...quote, id: 'quote-a', comment: '解释这次出现的术语' }] };
  let conversation = { id: 'conversation-a', messages: [{ id: 'answer-a', role: 'assistant', content: text }] };
  let bounds = { left: 10, top: 60, right: 400, bottom: 480 };
  const calls = [];
  const controller = createArticleQuoteView({ document, root, host,
    getConversation: () => conversation, getSelection: () => selection,
    onEdit: value => calls.push(['edit', value]), onRemove: id => calls.push(['remove', id]),
    onClear: () => calls.push(['clear']), focusInput: () => calls.push(['focus']), getViewportRect: () => bounds });
  t.after(() => controller.dispose());
  const layer = document.body.children.at(-1);
  const fire = (receiver, type, target = receiver) => {
    const event = new Event(type, { cancelable: true }); Object.defineProperty(event, 'target', { value: target }); receiver.dispatchEvent(event); return event;
  };
  const click = node => fire(host.contains(node) ? host : layer, 'click', node);
  const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  return { document, window, root, host, layer, body, textNode, controller, frames, observerRecords, calls, fire, click, flush, quote,
    setSelection: value => { selection = value; }, get selection() { return selection; },
    setConversation: value => { conversation = value; }, setBounds: value => { bounds = value; } };
}

test('same-conversation references use their precise repeated-text anchor and register an independent highlight', t => {
  const fx = fixture(t, { anchor: null });
  assert.equal(fx.host.hidden, false);
  const highlight = fx.window.CSS.highlights.get('unk-article-quotes');
  assert.ok(highlight);
  assert.equal(highlight.ranges[0].startOffset, fx.textNode.nodeValue.lastIndexOf('metadata'));
  assert.equal(fx.layer.querySelectorAll('.article-quote-marker').length, 1);
  const marker = fx.layer.querySelector('.article-quote-marker');
  assert.equal(marker.dataset.quoteId, 'quote-a');
  assert.equal(marker.textContent, '1');
  assert.equal(marker.getAttribute('aria-label'), '查看第 1 条引用注释');
  assert.ok(fx.window.CSS.highlights.has('other-highlight'));
});

test('a reference to another source conversation remains in the draft while no marker or highlight appears', t => {
  const fx = fixture(t, { anchor: null, source: 'source-conversation' });
  assert.equal(fx.host.hidden, false);
  assert.match(fx.host.textContent, /解释这次出现的术语/);
  assert.equal(fx.layer.querySelectorAll('.article-quote-marker').length, 0);
  assert.equal(fx.window.CSS.highlights.has('unk-article-quotes'), false);
});

test('changed original text keeps reference data visible and removes its stale numbered anchor', t => {
  const fx = fixture(t, { anchor: null });
  fx.textNode.nodeValue = '这段回答已重新生成，原术语不再出现。';
  fx.observerRecords[0].callback();
  fx.flush();
  assert.equal(fx.host.hidden, false);
  assert.match(fx.host.textContent, /metadata/);
  assert.equal(fx.layer.querySelectorAll('.article-quote-marker').length, 0);
  assert.equal(fx.window.CSS.highlights.has('unk-article-quotes'), false);
});

test('legacy quotes only locate unique exact text and never choose the first repeated occurrence', t => {
  const duplicate = fixture(t, { anchor: false });
  assert.equal(duplicate.layer.querySelectorAll('.article-quote-marker').length, 0);
  const unique = fixture(t, { text: '这里解释 metadata 的用途。', anchor: false });
  assert.equal(unique.layer.querySelectorAll('.article-quote-marker').length, 1);
});

test('code highlighting may split text nodes without changing an anchored reference', t => {
  const fx = fixture(t, { text: '代码示例：metadata 用于过滤。', anchor: null });
  const prefix = { nodeType: 3, nodeValue: '代码示例：', parentElement: fx.body };
  const first = new Element(fx.document, 'span'), second = new Element(fx.document, 'span');
  first.className = 'hljs-title'; second.className = 'hljs-string';
  first.append({ nodeType: 3, nodeValue: 'meta', parentElement: first });
  second.append({ nodeType: 3, nodeValue: 'data', parentElement: second });
  fx.body.replaceChildren(prefix, first, second, { nodeType: 3, nodeValue: ' 用于过滤。', parentElement: fx.body });
  fx.observerRecords[0].callback(); fx.flush();
  const ranges = fx.window.CSS.highlights.get('unk-article-quotes').ranges;
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].toString(), 'metadata');
  assert.equal(fx.layer.querySelectorAll('.article-quote-marker').length, 1);
});

test('a truncated quote retains its full original anchored range for visual highlighting', t => {
  const fx = fixture(t, { text: '代码示例：metadata 用于过滤。', anchor: null });
  const quote = { ...fx.selection.annotations[0], text: 'meta', originalLength: 8, textTruncated: true };
  fx.setSelection({ ...fx.selection, annotations: [quote] });
  fx.controller.sync();
  assert.match(fx.host.textContent, /内容已截断/);
  assert.equal(fx.window.CSS.highlights.get('unk-article-quotes').ranges[0].toString(), 'metadata');
});

test('drafts start compact and preserve the chosen fold state when references are added or synchronized', t => {
  const fx = fixture(t, { anchor: null });
  const toggle = fx.host.querySelector('.article-quote-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(fx.host.querySelector('.article-quote-list').hidden, true);
  fx.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  fx.controller.sync();
  assert.equal(fx.host.querySelector('.article-quote-list').hidden, false);
  fx.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  fx.controller.sync();
  assert.equal(fx.host.querySelector('.article-quote-list').hidden, true);
  fx.click(fx.host.querySelector('.article-quote-edit'));
  fx.click(fx.host.querySelector('.article-quote-remove'));
  assert.equal(fx.calls[0][0], 'edit');
  assert.equal(fx.calls[0][1].id, 'quote-a');
  assert.deepEqual(fx.calls[1], ['remove', 'quote-a']);
  const first = fx.selection.annotations[0];
  fx.setSelection({ ...fx.selection, annotations: [first, { ...first, id: 'quote-b', comment: '' }] });
  fx.controller.sync();
  assert.equal(fx.host.querySelector('.article-quote-toggle').textContent, '2 条引用注释');
  assert.equal(fx.host.querySelector('.article-quote-list').hidden, true);
  assert.match(fx.host.textContent, /仅引用原文/);
  fx.click(fx.host.querySelector('.article-quote-toggle'));
  fx.setSelection({ ...fx.selection, annotations: [...fx.selection.annotations, { ...first, id: 'quote-c' }] });
  fx.controller.sync();
  assert.equal(fx.host.querySelector('.article-quote-toggle').textContent, '3 条引用注释');
  assert.equal(fx.host.querySelector('.article-quote-list').hidden, false);
  fx.click(fx.host.querySelector('.article-quote-clear'));
  assert.deepEqual(fx.calls.slice(-2), [['clear'], ['focus']]);
});

test('numbered anchors open and focus the matching edit control without invoking a model or edit action', t => {
  const fx = fixture(t, { anchor: null });
  assert.equal(fx.host.querySelector('.article-quote-list').hidden, true);
  const marker = fx.layer.querySelector('.article-quote-marker');
  assert.equal(fx.fire(fx.layer, 'pointerdown', marker).defaultPrevented, true);
  fx.click(marker);
  assert.equal(fx.host.querySelector('.article-quote-list').hidden, false);
  assert.equal(fx.document.activeElement, fx.host.querySelector('.article-quote-edit'));
  assert.deepEqual(fx.calls, []);
});

test('scrolling and resizing constrain marker placement to the actual text viewport', t => {
  const fx = fixture(t, { anchor: null });
  fx.setBounds({ left: 10, top: 130, right: 400, bottom: 480 });
  fx.fire(fx.document, 'scroll', fx.root); fx.flush();
  assert.equal(fx.layer.querySelectorAll('.article-quote-marker').length, 0);
  fx.setBounds({ left: 10, top: 60, right: 100, bottom: 480 });
  fx.fire(fx.window, 'resize'); fx.flush();
  const marker = fx.layer.querySelector('.article-quote-marker');
  assert.ok(marker);
  assert.ok(Number.parseFloat(marker.style.left) + 22 <= 100);
});

test('dispose cancels observations, pending positioning and detached control callbacks while preserving other highlights', t => {
  const fx = fixture(t, { anchor: null });
  const oldEdit = fx.host.querySelector('.article-quote-edit'), oldMarker = fx.layer.querySelector('.article-quote-marker');
  fx.observerRecords[0].callback();
  assert.equal(fx.frames.size, 1);
  fx.controller.dispose();
  fx.flush();
  fx.fire(fx.host, 'click', oldEdit); fx.fire(fx.layer, 'click', oldMarker);
  fx.fire(fx.document, 'scroll', fx.root); fx.fire(fx.window, 'resize');
  fx.controller.sync();
  assert.equal(fx.frames.size, 0);
  assert.equal(fx.observerRecords[0].disconnected, true);
  assert.equal(fx.layer.isConnected, false);
  assert.equal(fx.host.hidden, true);
  assert.equal(fx.window.CSS.highlights.has('unk-article-quotes'), false);
  assert.ok(fx.window.CSS.highlights.has('other-highlight'));
  assert.deepEqual(fx.calls, []);
});

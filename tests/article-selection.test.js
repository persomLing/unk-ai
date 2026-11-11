import test from 'node:test';
import assert from 'node:assert/strict';
import { captureArticleSelection, normalizeArticleSelection, articleSelectionBelongsTo,
  ARTICLE_SELECTION_LIMITS } from '../src/sidepanel/features/messages/article-selection.js';

class Node {
  constructor(tag = '', text = '') {
    this.nodeType = tag ? 1 : 3;
    this.tagName = tag.toUpperCase();
    this.text = text;
    this.children = [];
    this.dataset = {};
    this.classes = new Set();
    this.isConnected = true;
  }
  get textContent() { return this.nodeType === 3 ? this.text : this.children.map(node => node.textContent).join(''); }
  get innerText() { return this.textContent; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  matches(selector) {
    if (selector === '.message-content') return this.classes.has('message-content');
    if (selector === '.assistant-message[data-message-id]') return this.classes.has('assistant-message') && Boolean(this.dataset.messageId);
    if (selector === 'h1,h2,h3,h4,h5,h6') return /^H[1-6]$/.test(this.tagName);
    return false;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
const textNodes = root => root.nodeType === 3 ? [root] : root.children.flatMap(textNodes);
const textPosition = (root, node, offset) => {
  const target = node.nodeType === 3 ? node : textNodes(node)[0];
  let position = 0;
  for (const item of textNodes(root)) {
    if (item === target) return position + offset;
    position += item.text.length;
  }
  throw new Error('foreign boundary');
};

class Range {
  constructor(root, startNode, startOffset, endNode, endOffset, rects) {
    this.root = root;
    this.setStart(startNode, startOffset);
    this.setEnd(endNode, endOffset);
    this.rects = rects;
  }
  setStart(node, offset) { this.startContainer = node; this.startOffset = offset; this.start = textPosition(this.root, node, offset); }
  setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; this.end = textPosition(this.root, node, offset); }
  selectNodeContents(node) {
    const nodes = textNodes(node);
    this.setStart(nodes[0], 0);
    this.setEnd(nodes.at(-1), nodes.at(-1).text.length);
  }
  cloneRange() { return new Range(this.root, this.startContainer, this.startOffset, this.endContainer, this.endOffset, this.rects); }
  toString() { return this.root.textContent.slice(this.start, this.end); }
  getClientRects() { return this.rects; }
  getBoundingClientRect() { return this.rects[0]; }
  comparePoint(node, offset) { const position = textPosition(this.root, node, offset); return position < this.start ? -1 : position > this.end ? 1 : 0; }
}

function fixture({ before = '在向量库和 RAG 中，', text = 'metadata 是每个 chunk 附带的键值对',
  after = '（JSON/dict），存储时不参与向量化，但可过滤与回溯。', question = 'metadata 有什么用？' } = {}) {
  const root = new Node('section');
  const article = new Node('article'); article.classes.add('assistant-message'); article.dataset.messageId = 'answer-a';
  const body = new Node('div'); body.classes.add('message-content');
  const heading = new Node('h2'); heading.append(new Node('', '一、metadata 是什么'));
  const paragraph = new Node('p'), paragraphText = new Node('', before + text + after); paragraph.append(paragraphText);
  body.append(heading, paragraph);
  const thinking = new Node('div'); thinking.append(new Node('', 'PRIVATE_REASONING_SHOULD_NOT_BE_READ'));
  const controls = new Node('div'); controls.append(new Node('', 'PRIVATE_CONTROLS_SHOULD_NOT_BE_READ'));
  article.append(thinking, body, controls); root.append(article);
  const other = new Node('article'); other.classes.add('assistant-message'); other.dataset.messageId = 'answer-b';
  const otherBody = new Node('div'); otherBody.classes.add('message-content'); const otherText = new Node('', 'UNRELATED_ANSWER'); otherBody.append(otherText); other.append(otherBody); root.append(other);
  const conversation = { id: 'conversation-a', title: 'RAG 基础', messages: [
    { id: 'question-a', role: 'user', displayContent: question, content: 'RAW_HIDDEN_PROMPT' },
    { id: 'answer-a', role: 'assistant', content: 'metadata markdown', reasoning: 'PRIVATE_REASONING' },
    { id: 'question-b', role: 'user', content: 'UNRELATED_QUESTION' },
    { id: 'answer-b', role: 'assistant', content: 'UNRELATED_ANSWER' },
  ] };
  const rects = [{ left: 30, top: 150, width: 100, height: 22 }, { left: 30, top: 172, width: 140, height: 22 }];
  const range = new Range(root, paragraphText, before.length, paragraphText, before.length + text.length, rects);
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range };
  const capture = (overrides = {}) => captureArticleSelection({ selection, root, conversation,
    now: () => '2026-11-11T03:00:00.000Z', ...overrides });
  return { root, article, body, paragraphText, other, otherBody, otherText, conversation, selection, range, capture, rects };
}

test('capturing an article keeps the exact quote, surrounding answer, source heading and displayed original question', () => {
  const fx = fixture();
  const captured = fx.capture();
  assert.equal(captured.selection.text, 'metadata 是每个 chunk 附带的键值对');
  assert.equal(captured.selection.source, 'conversation');
  assert.equal(captured.selection.sourceVersion, 1);
  assert.equal(captured.selection.conversationId, 'conversation-a');
  assert.equal(captured.selection.messageId, 'answer-a');
  assert.equal(captured.selection.question, 'metadata 有什么用？');
  assert.equal(captured.selection.heading, '一、metadata 是什么');
  assert.match(captured.selection.context, /在向量库和 RAG 中/);
  assert.match(captured.selection.context, /可过滤与回溯/);
  assert.equal(captured.selection.url, '');
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE|UNRELATED|RAW_HIDDEN/);
  assert.deepEqual(captured.rect, { left: 30, top: 172, width: 140, height: 22, right: 170, bottom: 194 });
  fx.conversation.title = '后来打开的标题'; fx.paragraphText.text = '后来显示的文本';
  assert.equal(captured.selection.title, 'RAG 基础');
  assert.match(captured.selection.context, /在向量库和 RAG 中/);
});

test('native range boundaries choose the actual occurrence when the same term is repeated', () => {
  const fx = fixture({ before: 'metadata 的第一处定义。随后讨论过滤：', text: 'metadata', after: '这里指用于权限的键值字段。' });
  const captured = fx.capture();
  assert.match(captured.selection.context, /前文：[\s\S]*随后讨论过滤：/);
  assert.match(captured.selection.context, /后文：\n这里指用于权限/);
});

test('selection and context budgets preserve the nearby tail and head and explicitly record omissions', () => {
  const fx = fixture({ before: 'OUTSIDE_BEFORE'.repeat(600) + 'NEAR_BEFORE',
    text: '选中原文'.repeat(1800), after: 'NEAR_AFTER' + 'OUTSIDE_AFTER'.repeat(600), question: '原问题'.repeat(1000) });
  fx.conversation.title = '长标题'.repeat(100);
  const captured = fx.capture().selection;
  assert.equal(captured.text.length, ARTICLE_SELECTION_LIMITS.text);
  assert.ok(captured.context.length <= ARTICLE_SELECTION_LIMITS.context);
  assert.match(captured.context, /NEAR_BEFORE/); assert.match(captured.context, /NEAR_AFTER/);
  assert.equal(captured.question.length, ARTICLE_SELECTION_LIMITS.question);
  assert.equal(captured.title.length, ARTICLE_SELECTION_LIMITS.title);
  assert.equal(captured.originalLength, 7200);
  assert.equal(captured.textTruncated, true); assert.equal(captured.contextTruncated, true);
  assert.equal(captured.questionTruncated, true); assert.equal(captured.titleTruncated, true);
  assert.equal(captured.truncated, true);
  assert.deepEqual(normalizeArticleSelection(captured), captured, 'reopening retains truncation evidence');
});

test('cross-message, foreign-root, missing-source and detached selections are rejected', () => {
  const fx = fixture();
  fx.range.setEnd(fx.otherText, 5);
  assert.equal(fx.capture(), null);
  const next = fixture();
  assert.equal(next.capture({ root: next.other }), null);
  assert.equal(next.capture({ conversation: { ...next.conversation, id: 'another', messages: [] } }), null);
  next.body.isConnected = false;
  assert.equal(next.capture(), null);
});

test('thoughts, controls, user messages and empty or multiple ranges never become article references', () => {
  const fx = fixture();
  const thoughtText = fx.article.children[0].children[0];
  fx.range.setStart(thoughtText, 0); fx.range.setEnd(thoughtText, 8);
  assert.equal(fx.capture(), null);
  for (const invalid of [
    { isCollapsed: true, rangeCount: 1 }, { isCollapsed: false, rangeCount: 0 }, { isCollapsed: false, rangeCount: 2 },
  ]) assert.equal(fx.capture({ selection: invalid }), null);
  const user = fixture(); user.conversation.messages[1].role = 'user';
  assert.equal(user.capture(), null);
  const empty = fixture({ text: '  ' }); assert.equal(empty.capture(), null);
  const token = fixture({ text: 'x' }); assert.equal(token.capture().selection.text, 'x');
});

test('geometry ignores empty rects and rejects invalid geometry without retaining a live range', () => {
  const fx = fixture();
  fx.rects.push({ left: 0, top: 0, width: 0, height: 0 });
  assert.equal(fx.capture().rect.top, 172);
  fx.range.rects = [{ left: NaN, top: 0, width: 100, height: 20 }];
  assert.equal(fx.capture(), null);
  fx.selection.getRangeAt = () => { throw new Error('Range detached'); };
  assert.equal(fx.capture(), null);
});

test('source ownership follows the captured answer and does not follow another visible conversation', () => {
  const fx = fixture(); const selection = fx.capture().selection;
  assert.equal(articleSelectionBelongsTo(selection, fx.conversation), true);
  assert.equal(articleSelectionBelongsTo(selection, { ...fx.conversation, id: 'conversation-b' }), false);
  assert.equal(articleSelectionBelongsTo(selection, { ...fx.conversation, messages: [] }), false);
  assert.equal(articleSelectionBelongsTo({ ...selection, sourceVersion: 2 }, fx.conversation), false);
});

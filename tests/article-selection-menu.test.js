import test from 'node:test';
import assert from 'node:assert/strict';
import { createArticleSelectionMenu } from '../src/sidepanel/features/messages/article-selection-menu.js';

class Element extends EventTarget {
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document;
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classes = new Set();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.isConnected = true;
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  contains(target) { return this === target || this.children.some(child => child === target || child.contains?.(target)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  matches(selector) {
    if (selector === '.message-content') return this.classes.has('message-content');
    if (selector === '.assistant-message[data-message-id]') return this.classes.has('assistant-message') && Boolean(this.dataset.messageId);
    return false;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) || []),
    ]);
  }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 296, height: 38 }; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
    this.isConnected = false;
  }
  click() { this.dispatchEvent(new Event('click')); }
}

function fixture(t) {
  const document = new EventTarget();
  const view = new EventTarget();
  const frames = new Map();
  let nextFrame = 1;
  view.innerWidth = 340;
  view.innerHeight = 600;
  view.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
  view.cancelAnimationFrame = id => frames.delete(id);
  document.defaultView = view;
  document.createElement = tag => new Element(document, tag);
  document.body = new Element(document, 'body');
  const root = new Element(document, 'section');
  const article = new Element(document, 'article');
  article.classes.add('assistant-message'); article.dataset.messageId = 'answer-a';
  const body = new Element(document); body.classes.add('message-content');
  const text = { nodeType: 3, parentElement: body };
  body.append(text); article.append(body); root.append(article); document.body.append(root);
  const range = {
    startContainer: text, endContainer: text, startOffset: 12, endOffset: 20,
    toString: () => 'metadata 键值对',
    getClientRects: () => [{ left: 30, top: 150, width: 140, height: 22 }],
    cloneRange: () => {
      let part = '';
      return { selectNodeContents() {}, setEnd() { part = '前文围绕 RAG 解释。'; },
        setStart() { part = '后文说明过滤与引用。'; }, toString: () => part };
    },
  };
  const nativeSelection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range,
    removeAllRanges() { this.isCollapsed = true; this.rangeCount = 0; } };
  view.getSelection = () => nativeSelection;
  let conversation = { id: 'conversation-a', title: 'RAG 文章', messages: [
    { id: 'question-a', role: 'user', displayContent: 'metadata 是什么？' },
    { id: 'answer-a', role: 'assistant', content: 'metadata 的说明' },
  ] };
  const quoted = [], asked = [], errors = [];
  let quoteResult;
  const controller = createArticleSelectionMenu({ document, root, getConversation: () => conversation,
    onQuote: (selection, rect, comment) => {
      if (quoteResult instanceof Error) throw quoteResult;
      quoted.push({ selection, rect, comment });
      return quoteResult;
    },
    onAsk: (selection, rect) => asked.push({ selection, rect }), onError: error => errors.push(error) });
  t.after(() => controller.dispose());
  const menu = document.body.children.at(-2), editor = document.body.children.at(-1);
  const preview = editor.children[0], input = editor.children[1], feedback = editor.children[2];
  const cancel = editor.children[3].children[1], confirm = editor.children[3].children[2];
  const quote = menu.children[0], ask = menu.children[1];
  const fire = (receiver, type, target = receiver, fields = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, fields);
    receiver.dispatchEvent(event);
    return event;
  };
  const flush = () => {
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
  };
  const reveal = () => { fire(document, 'pointerup', root); flush(); assert.equal(menu.hidden, false); };
  return { document, view, frames, nativeSelection, controller, root, article, menu, quote, ask,
    editor, preview, input, feedback, cancel, confirm, quoted, asked, errors, fire, flush, reveal,
    setQuoteResult: value => { quoteResult = value; }, setConversation: value => { conversation = value; } };
}

test('toolbar actions preserve their captured quote when focusing them collapses the native selection', t => {
  const fx = fixture(t);
  fx.reveal();
  assert.equal(fx.ask.textContent, '单独追问这段内容');
  fx.nativeSelection.isCollapsed = true;
  fx.nativeSelection.rangeCount = 0;
  fx.document.activeElement = fx.ask;
  fx.fire(fx.document, 'selectionchange');
  fx.flush();
  assert.equal(fx.menu.hidden, false);
  fx.ask.click();
  assert.equal(fx.asked.length, 1);
  assert.equal(fx.asked[0].selection.text, 'metadata 键值对');
  assert.equal(fx.asked[0].selection.conversationId, 'conversation-a');
  assert.equal(fx.asked[0].selection.messageId, 'answer-a');
  assert.match(fx.asked[0].selection.context, /RAG/);
  assert.match(fx.asked[0].selection.context, /过滤与引用/);
  assert.equal(fx.menu.hidden, true);
  fx.ask.click();
  assert.equal(fx.asked.length, 1, 'a consumed snapshot cannot be reused');
});

test('a captured selection cannot be quoted into another visible conversation', t => {
  const fx = fixture(t);
  fx.reveal();
  fx.setConversation({ id: 'conversation-b', messages: [{ id: 'answer-a', role: 'assistant' }] });
  fx.quote.click();
  assert.deepEqual(fx.quoted, []);
  assert.deepEqual(fx.asked, []);
  assert.equal(fx.menu.hidden, true);
  assert.deepEqual(fx.errors, []);
});

test('explicit hiding cancels a pending selection frame rather than reopening the toolbar', t => {
  const fx = fixture(t);
  fx.fire(fx.document, 'selectionchange');
  assert.equal(fx.frames.size, 1);
  fx.controller.hide();
  fx.flush();
  assert.equal(fx.menu.hidden, true);
  fx.quote.click();
  assert.deepEqual(fx.quoted, []);
});

test('dispose removes pending selection work and prevents callbacks from old buttons or events', t => {
  const fx = fixture(t);
  fx.reveal();
  fx.fire(fx.document, 'selectionchange');
  fx.controller.dispose();
  fx.flush();
  assert.equal(fx.frames.size, 0);
  assert.equal(fx.menu.isConnected, false);
  fx.quote.click(); fx.ask.click();
  fx.fire(fx.document, 'pointerup'); fx.fire(fx.document, 'selectionchange');
  fx.flush();
  assert.equal(fx.frames.size, 0);
  assert.deepEqual(fx.quoted, []);
  assert.deepEqual(fx.asked, []);
  assert.deepEqual(fx.errors, []);
});

const settled = () => new Promise(resolve => setImmediate(resolve));

test('quoting opens the nearby comment editor without committing until confirmation', async t => {
  const fx = fixture(t);
  fx.reveal();
  fx.quote.click();
  assert.equal(fx.menu.hidden, true);
  assert.equal(fx.editor.hidden, false);
  assert.equal(fx.document.activeElement, fx.input);
  assert.equal(fx.preview.textContent, 'metadata 键值对');
  assert.equal(fx.input.placeholder, '针对这段内容提问或添加说明…');
  assert.deepEqual(fx.quoted, []);
  assert.deepEqual(fx.asked, []);
  assert.equal(fx.nativeSelection.isCollapsed, true);
  fx.fire(fx.document, 'selectionchange');
  fx.fire(fx.document, 'keyup', fx.input, { key: 'a' });
  fx.flush();
  assert.equal(fx.editor.hidden, false, 'typing must retain the fixed quote');
  assert.equal(fx.frames.size, 0);
  fx.input.value = '  为什么这些字段用于过滤？  ';
  fx.confirm.click();
  await settled();
  assert.equal(fx.quoted.length, 1);
  assert.equal(fx.quoted[0].comment, '为什么这些字段用于过滤？');
  assert.equal(fx.quoted[0].selection.text, 'metadata 键值对');
  assert.match(fx.quoted[0].selection.context, /RAG.*过滤与引用/s);
  assert.equal(fx.editor.hidden, true);
});

test('confirmation permits an empty comment for a reference alone and consumes it once', async t => {
  const fx = fixture(t);
  fx.reveal(); fx.quote.click();
  fx.confirm.click(); fx.confirm.click();
  await settled();
  assert.equal(fx.quoted.length, 1);
  assert.equal(fx.quoted[0].comment, '');
  fx.confirm.click(); await settled();
  assert.equal(fx.quoted.length, 1);
});

test('Enter confirms while Shift Enter and IME confirmation preserve the comment draft', async t => {
  const fx = fixture(t);
  fx.reveal(); fx.quote.click(); fx.input.value = '第一点\n第二点';
  for (const fields of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const event = fx.fire(fx.input, 'keydown', fx.input, { key: 'Enter', ...fields });
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(fx.quoted, []);
  const enter = fx.fire(fx.input, 'keydown', fx.input, { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  await settled();
  assert.equal(fx.quoted.length, 1);
  assert.equal(fx.quoted[0].comment, '第一点\n第二点');
});

test('editor pointer input keeps native caret behavior and outside cancellation commits nothing', t => {
  const fx = fixture(t);
  fx.reveal(); fx.quote.click(); fx.input.value = '未提交注释';
  const inputPointer = fx.fire(fx.document, 'pointerdown', fx.input);
  assert.equal(inputPointer.defaultPrevented, false);
  assert.equal(fx.editor.hidden, false);
  fx.fire(fx.document, 'pointerdown', fx.root);
  assert.equal(fx.editor.hidden, true);
  assert.equal(fx.input.value, '');
  assert.deepEqual(fx.quoted, []);
  fx.confirm.click();
  assert.deepEqual(fx.quoted, []);
});

test('Escape consumes only the visible reference layer and cancel never commits', t => {
  const fx = fixture(t);
  let escapedOutside = 0;
  fx.document.addEventListener('keydown', event => { if (event.key === 'Escape') escapedOutside++; });
  fx.reveal(); fx.quote.click();
  const escape = fx.fire(fx.document, 'keydown', fx.input, { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escapedOutside, 0);
  assert.equal(fx.editor.hidden, true);
  assert.deepEqual(fx.quoted, []);
  fx.fire(fx.document, 'keydown', fx.root, { key: 'Escape' });
  assert.equal(escapedOutside, 1);
  fx.nativeSelection.isCollapsed = false; fx.nativeSelection.rangeCount = 1;
  fx.reveal(); fx.quote.click(); fx.cancel.click();
  assert.equal(fx.editor.hidden, true);
  assert.deepEqual(fx.quoted, []);
});

for (const invalidation of ['conversation', 'message', 'detached-source']) {
  test(`an editor cannot commit after its ${invalidation} owner becomes invalid`, async t => {
    const fx = fixture(t);
    fx.reveal(); fx.quote.click(); fx.input.value = '旧注释';
    if (invalidation === 'conversation') fx.setConversation({ id: 'conversation-b', messages: [{ id: 'answer-a', role: 'assistant' }] });
    if (invalidation === 'message') fx.setConversation({ id: 'conversation-a', messages: [] });
    if (invalidation === 'detached-source') fx.article.remove();
    fx.confirm.click(); await settled();
    assert.deepEqual(fx.quoted, []);
    assert.equal(fx.editor.hidden, true);
  });
}

test('a rejected addition preserves editable text for correction rather than consuming the quote', async t => {
  const fx = fixture(t);
  fx.reveal(); fx.quote.click(); fx.input.value = '这段与第一点有什么关系？';
  fx.setQuoteResult(new Error('最多添加 8 条引用注释。'));
  fx.confirm.click(); await settled();
  assert.equal(fx.editor.hidden, false);
  assert.equal(fx.input.value, '这段与第一点有什么关系？');
  assert.equal(fx.input.disabled, false);
  assert.equal(fx.confirm.disabled, false);
  assert.equal(fx.feedback.hidden, false);
  assert.match(fx.feedback.textContent, /8 条/);
  assert.equal(fx.errors.length, 1);
  assert.deepEqual(fx.quoted, []);
  fx.setQuoteResult(undefined); fx.confirm.click(); await settled();
  assert.equal(fx.quoted.length, 1);
  assert.equal(fx.editor.hidden, true);
});

test('an explicit uncommitted result keeps the editor and a later success can retry it', async t => {
  const fx = fixture(t);
  fx.reveal(); fx.quote.click(); fx.input.value = '注释'; fx.setQuoteResult(false);
  fx.confirm.click(); await settled();
  assert.equal(fx.editor.hidden, false);
  assert.equal(fx.input.value, '注释');
  assert.equal(fx.feedback.hidden, false);
  assert.equal(fx.confirm.disabled, false);
  fx.setQuoteResult(undefined); fx.confirm.click(); await settled();
  assert.equal(fx.editor.hidden, true);
});

test('an existing annotation uses the provided update callback and never adds a duplicate quote', async t => {
  const fx = fixture(t), updates = [];
  fx.reveal(); fx.ask.click();
  const captured = fx.asked[0];
  assert.equal(fx.controller.openQuote(captured.selection, captured.rect, {
    comment: '旧注释', title: '修改引用注释', onConfirm: (comment, selection) => updates.push({ comment, selection }),
  }), true);
  assert.equal(fx.input.value, '旧注释');
  assert.equal(fx.editor.attributes.get('aria-label'), '修改引用注释');
  assert.equal(fx.confirm.attributes.get('aria-label'), '修改引用注释');
  fx.input.value = '修改后的注释'; fx.confirm.click(); await settled();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].comment, '修改后的注释');
  assert.equal(updates[0].selection.messageId, 'answer-a');
  assert.deepEqual(fx.quoted, []);
  assert.equal(fx.editor.hidden, true);
});

test('a rewound historical reference can edit its note under the current draft owner without its source DOM', async t => {
  const fx = fixture(t), updates = [];
  fx.reveal(); fx.ask.click();
  const historical = fx.asked[0];
  fx.article.remove();
  fx.setConversation({ id: 'conversation-b', messages: [] });
  assert.equal(fx.controller.openQuote(historical.selection, historical.rect, {
    comment: '历史注释', title: '修改引用注释', ownerConversationId: 'conversation-b', isCurrent: () => true,
    onConfirm: (comment, selection) => updates.push({ comment, selection }),
  }), true);
  fx.input.value = '回退后修改的注释'; fx.confirm.click(); await settled();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].comment, '回退后修改的注释');
  assert.equal(updates[0].selection.conversationId, 'conversation-a', 'historical source remains fixed');
  assert.equal(updates[0].selection.messageId, 'answer-a');
  assert.deepEqual(fx.quoted, []);
  assert.equal(fx.editor.hidden, true);
});

for (const invalidation of ['draft-owner-changed', 'reference-removed']) {
  test(`historical annotation editing cannot submit after ${invalidation}`, async t => {
    const fx = fixture(t), updates = [];
    fx.reveal(); fx.ask.click(); const historical = fx.asked[0];
    fx.article.remove(); fx.setConversation({ id: 'conversation-b', messages: [] });
    let current = true;
    assert.equal(fx.controller.openQuote(historical.selection, historical.rect, {
      ownerConversationId: 'conversation-b', isCurrent: () => current,
      onConfirm: comment => updates.push(comment),
    }), true);
    fx.input.value = '迟到的修改';
    if (invalidation === 'draft-owner-changed') fx.setConversation({ id: 'conversation-c', messages: [] });
    else current = false;
    fx.confirm.click(); await settled();
    assert.deepEqual(updates, []);
    assert.deepEqual(fx.quoted, []);
    assert.equal(fx.editor.hidden, true);
  });
}

test('detached-source allowances require a complete explicit update owner and cannot relax a new quote', async t => {
  const fx = fixture(t), updates = [];
  fx.reveal(); fx.ask.click(); const historical = fx.asked[0];
  fx.article.remove(); fx.setConversation({ id: 'conversation-b', messages: [] });
  const options = { ownerConversationId: 'conversation-b', isCurrent: () => true,
    onConfirm: comment => updates.push(comment) };
  for (const incomplete of [
    { ownerConversationId: options.ownerConversationId, isCurrent: options.isCurrent },
    { onConfirm: options.onConfirm, isCurrent: options.isCurrent },
    { ownerConversationId: options.ownerConversationId, onConfirm: options.onConfirm },
    { ...options, ownerConversationId: 'conversation-c' },
    { ...options, isCurrent: () => false },
  ]) {
    assert.equal(fx.controller.openQuote(historical.selection, historical.rect, incomplete), false);
    fx.confirm.click(); await settled();
  }
  assert.deepEqual(updates, []);
  assert.deepEqual(fx.quoted, []);
});

test('scroll, resize, explicit hide and disposal cancel unsubmitted editor work', async t => {
  for (const close of ['scroll', 'resize', 'hide', 'dispose']) {
    const fx = fixture(t);
    fx.reveal(); fx.quote.click(); fx.input.value = '尚未提交';
    if (close === 'scroll') fx.fire(fx.root, 'scroll');
    if (close === 'resize') fx.fire(fx.view, 'resize');
    if (close === 'hide') fx.controller.hide();
    if (close === 'dispose') fx.controller.dispose();
    fx.confirm.click(); await settled();
    assert.equal(fx.editor.hidden, true, close);
    assert.deepEqual(fx.quoted, [], close);
    assert.equal(fx.frames.size, 0, close);
    if (close === 'dispose') assert.equal(fx.editor.isConnected, false);
  }
});

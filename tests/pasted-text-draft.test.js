import test from 'node:test';
import assert from 'node:assert/strict';
import { createPastedTextDraft, isLongPastedText, PASTED_TEXT_CHAR_LIMIT } from '../src/sidepanel/features/messages/pasted-text-draft.js';

class Element extends EventTarget {
  constructor(document, tag) {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.value = '';
    this.selectionStart = this.selectionEnd = 0;
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  closest(selector) {
    const key = { '[data-pasted-text-action]': 'pastedTextAction', '[data-pasted-text-id]': 'pastedTextId' }[selector];
    return key && this.dataset[key] !== undefined ? this : this.parentNode?.closest(selector) || null;
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  focus() { this.ownerDocument.activeElement = this; }
}

function fixture(t, options = {}) {
  const document = { createElement(tag) { return new Element(document, tag); } };
  const input = document.createElement('textarea'), container = document.createElement('div');
  const changes = [], previews = [], notices = [];
  let editable = true;
  const controller = createPastedTextDraft({ input, container, onChange: value => changes.push(value),
    onPreview: value => previews.push(value), notify: value => notices.push(value), canEdit: () => editable, ...options });
  t.after(() => controller.dispose());
  function paste(text, extra = {}) {
    const event = new Event('paste', { cancelable: true });
    Object.assign(event, { clipboardData: { files: [], getData: type => type === 'text/plain' ? text : '' }, ...extra });
    return { handled: controller.handlePaste(event), prevented: event.defaultPrevented };
  }
  function edit(start, end, inserted, type = 'insertText', { readFirst = false } = {}) {
    input.setSelectionRange(start, end);
    const event = new Event('beforeinput');
    Object.assign(event, { inputType: type });
    input.dispatchEvent(event);
    input.value = input.value.slice(0, start) + inserted + input.value.slice(end);
    input.setSelectionRange(start + inserted.length, start + inserted.length);
    const before = readFirst ? controller.getValue() : null;
    controller.handleInput();
    if (readFirst) assert.equal(controller.getValue(), before, 'reading first must not apply an edit twice');
  }
  const action = (index, name) => container.children[index]?.children.find(node => node.dataset.pastedTextAction === name);
  function click(index, name) {
    const target = typeof index === 'number' ? action(index, name) : index;
    assert.ok(target);
    const event = new Event('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    container.dispatchEvent(event);
  }
  return { document, input, container, controller, changes, previews, notices, paste, edit, action, click,
    setEditable: value => { editable = value; } };
}

const long = label => `${label}\n${'文字 '.repeat(340)}\n\t保持尾部空格  `;

test('only substantial long plain text is folded; short, blank, HTML-only and image clipboard data are left to existing paste handling', t => {
  const fx = fixture(t);
  for (const text of ['', 'short text', ' '.repeat(2000), '\n'.repeat(20)]) assert.deepEqual(fx.paste(text), { handled: false, prevented: false });
  assert.equal(isLongPastedText('x'.repeat(999)), false);
  assert.equal(isLongPastedText('x'.repeat(1000)), true);
  assert.equal(isLongPastedText(Array.from({ length: 15 }, () => 'line').join('\n')), true);
  assert.equal(isLongPastedText(Array.from({ length: 14 }, () => 'line').join('\r\n')), false);
  assert.deepEqual(fx.paste(long('image with text'), { clipboardData: { files: [{ type: 'image/png' }], getData: () => long('text') } }), { handled: false, prevented: false });
  const prevented = new Event('paste', { cancelable: true });
  prevented.preventDefault();
  assert.equal(fx.controller.handlePaste(prevented), false);
  assert.equal(fx.container.hidden, true);
  assert.deepEqual(fx.changes, []);
});

test('a large paste replaces the selected visible text and retains the complete raw payload in the user draft', t => {
  const fx = fixture(t);
  const text = `  <script>not executable</script>\r\n${long('原文')}\r\n`;
  fx.controller.setValue('前面：替换此处：后面');
  fx.input.setSelectionRange(3, 7);
  assert.deepEqual(fx.paste(text), { handled: true, prevented: true });
  assert.equal(fx.input.value, '前面：：后面');
  assert.equal(fx.controller.getValue(), `前面：${text}：后面`);
  assert.equal(fx.changes.at(-1), `前面：${text}：后面`);
  assert.equal(fx.container.children.length, 1);
  assert.equal(fx.input.selectionStart, 3);
  const title = fx.action(0, 'preview').children[1].children[0];
  assert.equal(title.textContent, '<script>not executable</script>');
  assert.equal(title.children.length, 0, 'pasted markup must never create elements');
  fx.click(0, 'preview');
  assert.equal(fx.previews[0].text, text);
  assert.equal(fx.previews[0].trigger, fx.action(0, 'preview'));
  assert.equal(fx.previews[0].title, '粘贴的文本');
});

test('repeated paste at the caret retains order, duplicate text and later typed suffixes without synthesized separators', t => {
  const fx = fixture(t);
  const first = long('first'), second = long('second');
  fx.controller.setValue('前后');
  fx.input.setSelectionRange(1, 1);
  fx.paste(first);
  fx.paste(second);
  fx.paste(first);
  assert.equal(fx.controller.getValue(), `前${first}${second}${first}后`);
  fx.edit(1, 1, '\n追问：', 'insertText', { readFirst: true });
  assert.equal(fx.controller.getValue(), `前${first}${second}${first}\n追问：后`);
  assert.equal(fx.container.children.length, 3);
});

test('visible edits before and after folded text move its anchor, including repeated characters and selection replacements', t => {
  const fx = fixture(t);
  const text = long('block');
  fx.controller.setValue('aaaa');
  fx.input.setSelectionRange(2, 2);
  fx.paste(text);
  fx.edit(0, 0, 'a');
  assert.equal(fx.controller.getValue(), `aaa${text}aa`, 'beforeinput disambiguates insertion into repeated characters');
  fx.edit(0, 3, '前');
  assert.equal(fx.controller.getValue(), `前${text}aa`, 'replacing a prefix keeps the block after its replacement');
  fx.edit(1, 3, '后');
  assert.equal(fx.controller.getValue(), `前${text}后`);
  fx.edit(0, 1, '', 'deleteContentBackward');
  assert.equal(fx.controller.getValue(), `${text}后`);
  fx.edit(1, 1, '尾');
  assert.equal(fx.controller.getValue(), `${text}后尾`);
});

test('deleting around a collapsed caret preserves card contents and handles input without beforeinput', t => {
  const fx = fixture(t);
  const text = long('block');
  fx.controller.setValue('ABCD');
  fx.input.setSelectionRange(2, 2);
  fx.paste(text);
  const before = new Event('beforeinput');
  Object.assign(before, { inputType: 'deleteContentBackward' });
  fx.input.dispatchEvent(before);
  fx.input.value = 'ACD';
  fx.input.setSelectionRange(1, 1);
  fx.controller.handleInput();
  assert.equal(fx.controller.getValue(), `A${text}CD`);
  fx.input.value = 'A!CD';
  fx.controller.handleInput();
  assert.equal(fx.controller.getValue(), `A${text}!CD`, 'text typed at the collapsed caret follows the card');
});

test('folding a new paste over visible text retains existing cards on both sides in their original order', t => {
  const fx = fixture(t);
  const first = long('first'), second = long('second');
  fx.controller.setValue('abc');
  fx.input.setSelectionRange(1, 1);
  fx.paste(first);
  fx.input.setSelectionRange(0, 1);
  fx.paste(second);
  assert.equal(fx.controller.getValue(), second + first + 'bc');
  fx.click(1, 'edit');
  assert.equal(fx.controller.getValue(), second + first + 'bc');
  assert.equal(fx.input.value, first + 'bc');
});

test('editing any card unfolds and selects only that text while preserving the exact combined draft', t => {
  for (const index of [0, 1, 2]) {
    const fx = fixture(t);
    const blocks = [long('one'), long('two'), long('three')];
    fx.controller.setValue('pre|post');
    fx.input.setSelectionRange(4, 4);
    blocks.forEach(value => fx.paste(value));
    const canonical = fx.controller.getValue();
    fx.click(index, 'edit');
    assert.equal(fx.controller.getValue(), canonical);
    assert.equal(fx.input.value, `pre|${blocks[index]}post`);
    assert.equal(fx.input.value.slice(fx.input.selectionStart, fx.input.selectionEnd), blocks[index]);
    assert.equal(fx.document.activeElement, fx.input);
    assert.equal(fx.container.children.length, 2);
  }
});

test('removing one card leaves other text intact and stale detached card events cannot edit a new draft', t => {
  const fx = fixture(t);
  const first = long('first'), second = long('second');
  fx.paste(first);
  fx.paste(second);
  fx.edit(0, 0, 'question');
  const stale = fx.action(0, 'remove');
  fx.click(0, 'remove');
  assert.equal(fx.controller.getValue(), second + 'question');
  fx.click(stale);
  assert.equal(fx.controller.getValue(), second + 'question');
  fx.click(0, 'remove');
  assert.equal(fx.controller.getValue(), 'question');
  assert.equal(fx.container.hidden, true);
});

test('unfolding CRLF text uses native textarea newlines without shifting the remaining card into its content', t => {
  const fx = fixture(t);
  const first = long('first').replaceAll('\n', '\r\n'), second = long('second');
  fx.paste(first);
  fx.paste(second);
  fx.edit(0, 0, 'tail');
  assert.equal(fx.controller.getValue(), first + second + 'tail');
  fx.click(0, 'edit');
  const normalized = first.replace(/\r\n?/g, '\n');
  assert.equal(fx.controller.getValue(), normalized + second + 'tail');
  assert.equal(fx.input.value.slice(fx.input.selectionStart, fx.input.selectionEnd), normalized);
});

test('the card count and total text budget reject whole pastes without altering content, selection or emitting a false change', t => {
  const fx = fixture(t);
  for (let i = 0; i < 6; i++) assert.equal(fx.paste(long(`block${i}`)).handled, true);
  const before = fx.controller.getValue(), changes = fx.changes.length;
  assert.equal(fx.paste(long('seventh')).prevented, true);
  assert.equal(fx.controller.getValue(), before);
  assert.equal(fx.changes.length, changes);
  assert.match(fx.notices.at(-1), /6/);
  fx.controller.setValue('keep');
  fx.input.setSelectionRange(1, 3);
  assert.equal(fx.paste('x'.repeat(PASTED_TEXT_CHAR_LIMIT + 1)).prevented, true);
  assert.equal(fx.input.value, 'keep');
  assert.equal(fx.input.selectionStart, 1);
  assert.equal(fx.input.selectionEnd, 3);
  assert.match(fx.notices.at(-1), /200,000/);
  fx.paste('x'.repeat(PASTED_TEXT_CHAR_LIMIT));
  assert.equal(fx.controller.getValue().length, PASTED_TEXT_CHAR_LIMIT + 2);
  const full = fx.controller.getValue();
  fx.paste(long('overflow'));
  assert.equal(fx.controller.getValue(), full);
});

test('read-only state blocks card additions and edits while allowing full-text preview', t => {
  const fx = fixture(t);
  fx.paste(long('first'));
  fx.setEditable(false);
  const before = fx.controller.getValue();
  fx.paste(long('second'));
  fx.click(0, 'remove');
  fx.click(0, 'edit');
  assert.equal(fx.controller.getValue(), before);
  fx.click(0, 'preview');
  assert.equal(fx.previews.length, 1);
  assert.equal(fx.notices.length, 3);
});

test('external draft restore is full text, same-value refresh preserves cards, and only explicit scope changes clear the draft', t => {
  let currentScope = 'a';
  const fx = fixture(t, { getScope: () => currentScope });
  const text = long('first');
  fx.paste(text);
  fx.controller.setValue(fx.controller.getValue());
  assert.equal(fx.container.children.length, 1);
  assert.equal(fx.controller.sync('a'), false);
  currentScope = 'b';
  assert.equal(fx.controller.getValue(), text, 'first-send conversation identity changes must not erase a later draft');
  assert.equal(fx.controller.sync('b'), true);
  assert.equal(fx.input.value, '');
  assert.equal(fx.controller.getValue(), '');
  assert.equal(fx.container.hidden, true);
  assert.equal(fx.changes.length, 1, 'external sync does not emit a user edit');
  fx.controller.setValue('restored complete draft');
  assert.equal(fx.input.value, 'restored complete draft');
  fx.paste(text);
  fx.controller.setValue('');
  assert.equal(fx.controller.getValue(), '');
  assert.equal(fx.container.hidden, true);
});

test('disposal unfolds remaining text without losing it, removes handlers and stops new card creation', t => {
  const fx = fixture(t);
  const text = long('first');
  fx.controller.setValue('pre');
  fx.input.setSelectionRange(3, 3);
  fx.paste(text);
  const stale = fx.action(0, 'remove');
  fx.controller.dispose();
  assert.equal(fx.input.value, 'pre' + text);
  assert.equal(fx.container.hidden, true);
  assert.equal(fx.controller.getValue(), 'pre' + text);
  assert.deepEqual(fx.paste(long('second')), { handled: false, prevented: false });
  fx.click(stale);
  assert.equal(fx.input.value, 'pre' + text);
  fx.controller.setValue('not accepted');
  assert.equal(fx.controller.sync('new'), false);
  assert.equal(fx.input.value, 'pre' + text);
});

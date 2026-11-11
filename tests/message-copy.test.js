import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageCopy } from '../src/sidepanel/features/messages/message-copy.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class Element extends EventTarget {
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.rect = { left: 20, top: 40, right: 48, bottom: 68, width: 28, height: 28 };
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  contains(target) { return target === this || this.children.some(node => node.contains(target)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return this.className === 'message-copy-menu' ? { width: 224, height: 110 } : this.rect; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

function fixture(t, { writer, timeoutMs = 3000 } = {}) {
  const document = new EventTarget();
  const window = new EventTarget();
  Object.assign(window, { innerWidth: 360, innerHeight: 700 });
  document.defaultView = window;
  document.documentElement = { clientWidth: 360, clientHeight: 700 };
  document.createElement = tag => new Element(document, tag);
  document.body = new Element(document, 'body');
  const button = document.createElement('button');
  button.setAttribute('aria-expanded', 'false');
  document.body.append(button);
  const writes = [];
  const notices = [];
  const controller = createMessageCopy({ document, timeoutMs,
    writeText: text => { writes.push(text); return writer?.(text); },
    notify: (...args) => notices.push(args) });
  t.after(() => controller.dispose());
  const menu = () => document.body.children.find(node => node.getAttribute('role') === 'menu');
  const options = () => menu()?.children.filter(node => node.getAttribute('role') === 'menuitem') || [];
  const fire = (type, target, fields = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, fields);
    document.dispatchEvent(event);
    return event;
  };
  const open = (message = { id: 'a', content: '**回答**\n\n[说明](https://example.com)' }, trigger = button, conversationId = 'conversation-a') => controller.open({ button: trigger, message, conversationId });
  return { document, window, button, controller, writes, notices, menu, options, fire, open };
}

test('copy menu is a body-level popup with two keyboard choices and matching trigger ARIA', t => {
  const fx = fixture(t);
  assert.equal(fx.open(), true);
  assert.equal(fx.menu().parentNode, fx.document.body);
  assert.deepEqual(fx.options().map(option => option.dataset.copyFormat), ['markdown', 'plain']);
  assert.equal(fx.button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(fx.button.getAttribute('aria-expanded'), 'true');
  assert.equal(fx.button.getAttribute('aria-controls'), fx.menu().id);
  assert.equal(fx.document.activeElement, fx.options()[0]);
  assert.deepEqual(fx.writes, []);
  fx.fire('keydown', fx.options()[0], { key: 'ArrowDown' });
  assert.equal(fx.document.activeElement, fx.options()[1]);
  assert.deepEqual(fx.options().map(option => option.tabIndex), [-1, 0]);
  fx.fire('keydown', fx.options()[1], { key: 'Home' });
  assert.equal(fx.document.activeElement, fx.options()[0]);
  fx.fire('keydown', fx.options()[0], { key: 'End' });
  assert.equal(fx.document.activeElement, fx.options()[1]);
  fx.fire('keydown', fx.options()[1], { key: 'ArrowDown' });
  assert.equal(fx.document.activeElement, fx.options()[0]);
  const escape = fx.fire('keydown', fx.options()[0], { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(fx.menu(), undefined);
  assert.equal(fx.document.activeElement, fx.button);
  assert.equal(fx.button.getAttribute('aria-expanded'), 'false');
  assert.equal(fx.button.getAttribute('aria-controls'), null);
});

test('copy uses the opening snapshot and reports the selected format', async t => {
  const fx = fixture(t);
  const message = { id: 'message-a', content: '**原始回答**', reasoning: '思考' };
  fx.open(message);
  message.content = '后来更新的回答';
  fx.options()[0].click();
  assert.deepEqual(fx.writes, ['**原始回答**'], 'clipboard write starts inside the activating click');
  await tick();
  assert.deepEqual(fx.notices, [['已复制回答（Markdown）']]);
  assert.equal(fx.menu(), undefined);
  assert.equal(fx.document.activeElement, fx.button);
  fx.open();
  fx.fire('keydown', fx.options()[0], { key: 'End' });
  fx.fire('keydown', fx.options()[1], { key: 'Enter' });
  await tick();
  assert.equal(fx.writes[1], '回答\n\n说明 (https://example.com)');
  assert.deepEqual(fx.notices[1], ['已复制回答（纯文本）']);
});

test('only-reasoning copy is labeled explicitly and empty responses do not open a menu', async t => {
  const fx = fixture(t);
  fx.open({ id: 'thinking', content: ' ', reasoning: '**思考**中' });
  assert.equal(fx.menu().getAttribute('aria-label'), '复制思考过程');
  assert.equal(fx.menu().children[0].textContent, '当前仅有思考内容');
  fx.options()[1].click();
  await tick();
  assert.deepEqual(fx.writes, ['思考中']);
  assert.deepEqual(fx.notices, [['已复制思考过程（纯文本）']]);
  assert.equal(fx.open({ content: '', reasoning: '' }), false);
  assert.equal(fx.menu(), undefined);
  assert.deepEqual(fx.notices[1], ['暂无内容可复制']);
});

test('outside interaction closes without stealing focus and Tab resumes from the trigger', t => {
  const fx = fixture(t);
  const outside = fx.document.createElement('input');
  fx.document.body.append(outside);
  fx.open();
  outside.focus();
  fx.fire('pointerdown', outside);
  assert.equal(fx.menu(), undefined);
  assert.equal(fx.document.activeElement, outside);
  fx.open();
  const tab = fx.fire('keydown', fx.options()[0], { key: 'Tab' });
  assert.equal(tab.defaultPrevented, false);
  assert.equal(fx.menu(), undefined);
  assert.equal(fx.document.activeElement, fx.button);
  fx.open();
  fx.fire('scroll', fx.document.body);
  assert.equal(fx.menu(), undefined);
});

test('double activation writes once and a late old clipboard completion cannot close a new menu', async t => {
  const pending = deferred();
  const fx = fixture(t, { writer: () => pending.promise });
  fx.open();
  const firstChoice = fx.options()[0];
  firstChoice.click();
  firstChoice.click();
  assert.equal(fx.writes.length, 1);
  assert.equal(fx.menu().getAttribute('aria-busy'), 'true');
  const other = fx.document.createElement('button');
  fx.document.body.append(other);
  fx.open({ id: 'b', content: '另一会话' }, other, 'conversation-b');
  const newMenu = fx.menu();
  pending.resolve();
  await tick();
  assert.equal(fx.menu(), newMenu);
  assert.equal(other.getAttribute('aria-expanded'), 'true');
  assert.equal(fx.button.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(fx.notices, []);
  assert.equal(fx.document.activeElement, fx.options()[0]);
});

test('a rejected clipboard write and a bounded timeout report errors without claiming success', async t => {
  const failure = fixture(t, { writer: () => { throw new Error('Denied'); } });
  failure.open();
  failure.options()[0].click();
  await tick();
  assert.deepEqual(failure.notices, [['复制失败，请手动选择文字。', 'error']]);
  assert.equal(failure.menu(), undefined);
  const pending = deferred();
  const timeout = fixture(t, { writer: () => pending.promise, timeoutMs: 20 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  timeout.open();
  timeout.options()[1].click();
  t.mock.timers.tick(20);
  await tick();
  assert.deepEqual(timeout.notices, [['复制等待超时，请确认剪贴板内容或手动选择文字。', 'error']]);
  assert.equal(timeout.menu(), undefined);
  pending.resolve();
  await tick();
  assert.equal(timeout.notices.length, 1);
});

test('closing or disposing cancels the local wait and detached triggers receive no completion effects', async t => {
  for (const ending of ['close', 'dispose', 'detach']) {
    const pending = deferred();
    const fx = fixture(t, { writer: () => pending.promise });
    fx.open();
    fx.options()[0].click();
    if (ending === 'detach') fx.button.remove(); else fx.controller[ending]();
    pending.reject(new Error('late rejection'));
    await tick();
    assert.equal(fx.menu(), undefined);
    assert.deepEqual(fx.notices, []);
    if (ending === 'dispose') assert.equal(fx.open(), false);
  }
});

test('popup placement stays inside narrow viewports and flips above a bottom trigger', t => {
  const fx = fixture(t);
  fx.button.rect = { left: 320, top: 660, bottom: 688, width: 28, height: 28 };
  fx.open();
  assert.equal(fx.menu().style.left, '128px');
  assert.equal(fx.menu().style.top, '542px');
  fx.window.innerWidth = 280;
  fx.window.dispatchEvent(new Event('resize'));
  assert.equal(fx.menu().style.left, '48px');
});

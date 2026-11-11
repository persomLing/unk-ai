import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextPreview, shouldCollapseMessageText } from '../src/sidepanel/features/messages/text-preview.js';

class Element extends EventTarget {
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.open = false;
    this.clientWidth = 240;
    this.scrollHeight = 160;
    this._text = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, enabled) => {
        this.className = this.className.split(/\s+/).filter(value => value && value !== name).concat(enabled ? [name] : []).join(' ');
      },
    };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    return selector.split(',').some(value => {
      const part = value.trim();
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      const attribute = part.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
      if (attribute) return this.attributes.has(attribute[1]) && (!attribute[2] || this.getAttribute(attribute[1]) === attribute[2]);
      return this.tagName === part.toUpperCase();
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { if (this.ownerDocument.failShow) throw new Error('Cannot open'); this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent(new Event('close')); }
}

function fixture(t, { fallbackFocus } = {}) {
  const document = new EventTarget();
  const window = new EventTarget();
  document.defaultView = window;
  window.getComputedStyle = () => ({ lineHeight: '22.1px', fontSize: '13px' });
  const observers = [];
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
  };
  document.createElement = tag => new Element(document, tag);
  document.body = document.createElement('body');
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.getSelection = () => document.selection || { isCollapsed: true };
  const trigger = document.createElement('button');
  document.body.append(trigger);
  const errors = [];
  const controller = createTextPreview({ document, onError: (...args) => errors.push(args), fallbackFocus });
  controller.sync('conversation-a');
  t.after(() => controller.dispose());
  const fire = (receiver, type, target = receiver, fields = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, fields);
    receiver.dispatchEvent(event);
    return event;
  };
  const candidate = (text = '长文本\n'.repeat(40)) => {
    const target = document.createElement('div');
    target.className = 'user-text-preview';
    target.setAttribute('data-text-preview-candidate', '');
    const content = document.createElement('div');
    content.setAttribute('data-text-preview-content', '');
    content.textContent = text;
    const more = document.createElement('span');
    more.className = 'user-text-preview-more';
    target.append(content, more);
    document.body.append(target);
    controller.refresh();
    return { target, content, more };
  };
  const dialog = () => document.body.querySelector('.text-preview-dialog');
  const body = () => dialog()?.querySelector('.text-preview-content');
  const closeButton = () => dialog()?.querySelector('.text-preview-close');
  const open = (overrides = {}) => controller.open({ text: '完整\n文本', trigger, ...overrides });
  return { document, window, controller, trigger, errors, observers, fire, candidate, dialog, body, closeButton, open };
}

test('only sufficiently long text becomes a measurement candidate', () => {
  assert.equal(shouldCollapseMessageText('短消息'), false);
  assert.equal(shouldCollapseMessageText('x'.repeat(159)), false);
  assert.equal(shouldCollapseMessageText('x'.repeat(160)), true);
  assert.equal(shouldCollapseMessageText('a\nb\nc\nd\ne'), false);
  assert.equal(shouldCollapseMessageText('a\r\nb\r\nc\r\nd\r\ne\r\nf'), true);
  assert.equal(shouldCollapseMessageText(null), false);
});

test('preview keeps an exact fixed plain-text snapshot and escapes title as text', t => {
  const fx = fixture(t);
  const value = ' \t原文\r\n<script>bad()</script>\n\n' + '内容'.repeat(8000) + '\n末尾 ';
  const request = { text: value, title: '<img onerror=bad()>完整消息', trigger: fx.trigger };
  assert.equal(fx.controller.open(request), true);
  request.text = '后来修改';
  assert.equal(fx.dialog().open, true);
  assert.equal(fx.body().textContent, value);
  assert.equal(fx.body().children.length, 0);
  assert.equal(fx.dialog().querySelector('.text-preview-title').textContent, request.title);
  assert.equal(fx.dialog().querySelector('.text-preview-title').children.length, 0);
  assert.equal(fx.document.activeElement, fx.closeButton());
  assert.equal(fx.body().tabIndex, 0);
  assert.deepEqual(fx.errors, []);
});

test('real line overflow controls clipping affordance and responds to resizing', t => {
  const fx = fixture(t);
  const { target, content, more } = fx.candidate();
  assert.equal(target.classList.contains('is-collapsed'), true);
  assert.equal(target.getAttribute('role'), 'button');
  assert.equal(target.getAttribute('tabindex'), '0');
  assert.equal(more.hidden, false);
  content.scrollHeight = 110;
  fx.observers[0].callback([{ target }]);
  assert.equal(target.classList.contains('is-collapsed'), false);
  assert.equal(target.getAttribute('data-text-preview'), null);
  assert.equal(target.getAttribute('role'), null);
  assert.equal(target.getAttribute('tabindex'), null);
  assert.equal(more.hidden, true);
  content.scrollHeight = 222;
  fx.window.dispatchEvent(new Event('resize'));
  assert.equal(target.getAttribute('data-text-preview'), 'message');
  target.remove();
  fx.controller.refresh();
  assert.equal(fx.observers[0].targets.has(target), false);
});

test('delegated clicks and Enter or Space open the full original message', t => {
  const fx = fixture(t);
  const text = 'first\n'.repeat(20) + '完整末尾';
  const { target, content, more } = fx.candidate(text);
  for (const key of [null, 'Enter', ' ']) {
    const event = key ? fx.fire(fx.document, 'keydown', target, { key }) : fx.fire(fx.document, 'click', more);
    assert.equal(event.defaultPrevented, true);
    assert.equal(fx.body().textContent, text);
    fx.controller.close();
    assert.equal(fx.document.activeElement, target);
  }
  content.textContent = '随后修改';
  fx.fire(fx.document, 'click', content);
  assert.equal(fx.body().textContent, '随后修改');
});

test('selecting text and interacting with nested controls never opens a preview', t => {
  const fx = fixture(t);
  const { target, content } = fx.candidate();
  fx.document.selection = { isCollapsed: false, anchorNode: content, focusNode: content };
  const selected = fx.fire(fx.document, 'click', content);
  assert.equal(selected.defaultPrevented, false);
  assert.equal(fx.dialog(), null);
  fx.document.selection = { isCollapsed: true };
  for (const tag of ['button', 'a', 'input', 'textarea']) {
    const control = fx.document.createElement(tag);
    target.append(control);
    fx.fire(fx.document, 'click', control);
    fx.fire(fx.document, 'keydown', control, { key: 'Enter' });
    assert.equal(fx.dialog(), null, tag);
  }
  fx.fire(fx.document, 'click', content, { button: 2 });
  fx.fire(fx.document, 'keydown', target, { key: 'Enter', repeat: true });
  assert.equal(fx.dialog(), null);
});

test('close button, backdrop and Escape close only the current preview and restore focus', t => {
  for (const action of ['button', 'backdrop', 'escape', 'cancel']) {
    const fx = fixture(t);
    let outsideEscapes = 0;
    fx.document.addEventListener('keydown', event => { if (event.key === 'Escape') outsideEscapes++; });
    fx.open();
    const dialog = fx.dialog();
    const body = fx.body();
    fx.fire(dialog, 'click', body);
    assert.equal(fx.dialog(), dialog, 'clicking/selecting preview text does not close');
    if (action === 'button') fx.fire(fx.closeButton(), 'click');
    if (action === 'backdrop') fx.fire(dialog, 'click');
    if (action === 'escape') fx.fire(fx.document, 'keydown', body, { key: 'Escape' });
    if (action === 'cancel') fx.fire(dialog, 'cancel');
    assert.equal(fx.dialog(), null, action);
    assert.equal(dialog.open, false, action);
    assert.equal(body.textContent, '', 'closed preview releases its text snapshot');
    assert.equal(fx.document.activeElement, fx.trigger, action);
    assert.equal(outsideEscapes, 0);
  }
});

test('same-conversation renders retain the snapshot; switching closes without old focus', t => {
  const fx = fixture(t);
  fx.open({ text: 'original' });
  const dialog = fx.dialog();
  fx.controller.sync('conversation-a');
  fx.controller.refresh();
  assert.equal(fx.dialog(), dialog);
  assert.equal(fx.body().textContent, 'original');
  fx.controller.sync('conversation-b');
  assert.equal(fx.dialog(), null);
  assert.notEqual(fx.document.activeElement, fx.trigger);
});

test('replaced dialogs and disposed observers cannot close or change a new preview', t => {
  const fx = fixture(t);
  const { target } = fx.candidate();
  fx.open({ text: 'first' });
  const oldDialog = fx.dialog();
  fx.open({ text: 'second' });
  const current = fx.dialog();
  fx.fire(oldDialog, 'click');
  fx.fire(oldDialog, 'cancel');
  assert.equal(fx.dialog(), current);
  fx.controller.dispose();
  assert.equal(fx.dialog(), null);
  const role = target.getAttribute('role');
  target.querySelector('[data-text-preview-content]').scrollHeight = 1;
  fx.observers[0].callback([{ target }]);
  fx.window.dispatchEvent(new Event('resize'));
  fx.fire(fx.document, 'click', target);
  assert.equal(target.getAttribute('role'), role);
  assert.equal(fx.dialog(), null);
  assert.equal(fx.observers[0].disconnected, true);
  assert.equal(fx.open(), false);
});

test('invalid content does not replace an open preview and modal failures report once', t => {
  const fx = fixture(t);
  fx.open();
  const original = fx.dialog();
  for (const text of ['', null, undefined, {}]) assert.equal(fx.open({ text }), false);
  assert.equal(fx.dialog(), original);
  fx.controller.close();
  fx.document.failShow = true;
  assert.equal(fx.open(), false);
  assert.equal(fx.dialog(), null);
  assert.equal(fx.errors.length, 1);
});

test('closing restores a connected fallback but switching and disposal do not steal it', t => {
  let fallback, calls = 0;
  const fx = fixture(t, { fallbackFocus: () => { calls++; return fallback; } });
  fallback = fx.document.createElement('textarea');
  fx.document.body.append(fallback);
  fx.open();
  fx.trigger.remove();
  fx.controller.close();
  assert.equal(fx.document.activeElement, fallback);
  assert.equal(calls, 1);
  fx.open();
  fx.controller.sync('conversation-b');
  fx.open();
  fx.controller.dispose();
  assert.equal(calls, 1);
});

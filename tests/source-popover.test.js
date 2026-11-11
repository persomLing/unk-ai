import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourcePopover } from '../src/sidepanel/features/messages/source-popover.js';

class Element extends EventTarget {
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.hidden = false;
    this.classes = new Set();
    this.classList = {
      contains: name => this.classes.has(name),
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
    };
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
    this.parentNode = null;
  }
  contains(target) { return target === this || this.children.some(node => node.contains(target)); }
  matches(selector) {
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    const attribute = selector.match(/\[([^=\]]+)="([^"]+)"\]/);
    return classes.every(name => this.classList.contains(name)) &&
      (!attribute || this.getAttribute(attribute[1]) === attribute[2]);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(node => [node, ...node.querySelectorAll('*')]).filter(node => node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
}

function fixture(t) {
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  const observers = [];
  document.defaultView.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(root, options) { this.root = root; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  document.body = new Element(document, 'body');
  const root = new Element(document);
  const outside = new Element(document, 'button');
  document.body.append(root, outside);
  const makeSource = (parent = root) => {
    const wrapper = new Element(document);
    wrapper.classList.add('message-sources');
    const button = new Element(document, 'button');
    button.setAttribute('data-action', 'toggle-sources');
    button.setAttribute('aria-expanded', 'false');
    const popover = new Element(document);
    popover.classList.add('sources-popover');
    popover.hidden = true;
    const link = new Element(document, 'a');
    link.setAttribute('href', 'https://example.com/source');
    popover.append(link);
    wrapper.append(button, popover);
    parent.append(wrapper);
    return { wrapper, button, popover, link };
  };
  const first = makeSource();
  const second = makeSource();
  const controller = createSourcePopover({ root });
  t.after(() => controller.dispose());
  const fire = (receiver, type, target = receiver, fields = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, fields);
    receiver.dispatchEvent(event);
    return event;
  };
  const assertOpen = (source, expected) => {
    assert.equal(source.popover.hidden, !expected);
    assert.equal(source.button.getAttribute('aria-expanded'), String(expected));
    assert.equal(source.wrapper.classList.contains('is-open'), expected);
  };
  return { document, root, outside, first, second, controller, makeSource, fire, assertOpen, observers };
}

test('one presenter opens one source list and synchronizes visibility and accessibility on each toggle', t => {
  const fx = fixture(t);
  assert.equal(fx.controller.isOpen(), false);
  assert.equal(fx.controller.toggle(fx.first.button), true);
  fx.assertOpen(fx.first, true);
  assert.equal(fx.controller.isOpen(), true);
  assert.equal(fx.controller.toggle(fx.second.button), true);
  fx.assertOpen(fx.first, false);
  fx.assertOpen(fx.second, true);
  assert.equal(fx.controller.toggle(fx.second.button), false);
  fx.assertOpen(fx.second, false);
  assert.equal(fx.controller.isOpen(), false);
});

test('outside pointer presses dismiss sources without intercepting source links or other actions', t => {
  const fx = fixture(t);
  let downstreamActions = 0;
  fx.document.addEventListener('pointerdown', () => { downstreamActions += 1; });
  fx.controller.toggle(fx.first.button);
  for (const target of [fx.first.link, fx.first.popover, fx.first.button]) {
    const event = fx.fire(fx.document, 'pointerdown', target);
    assert.equal(event.defaultPrevented, false);
    fx.assertOpen(fx.first, true);
  }
  const event = fx.fire(fx.document, 'pointerdown', fx.outside);
  assert.equal(event.defaultPrevented, false);
  fx.assertOpen(fx.first, false);
  assert.equal(downstreamActions, 4, 'dismissal preserves normal link and button handling');
});

test('Escape dismisses only the source list, restores source-link focus, and then permits the window shortcut', t => {
  const fx = fixture(t);
  let windowCloseCalls = 0;
  fx.document.addEventListener('keydown', event => { if (event.key === 'Escape') windowCloseCalls += 1; }, true);
  fx.controller.toggle(fx.first.button);
  fx.first.link.focus();
  const escape = fx.fire(fx.document, 'keydown', fx.first.link, { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  fx.assertOpen(fx.first, false);
  assert.equal(fx.document.activeElement, fx.first.button);
  assert.deepEqual(fx.first.button.focusOptions, { preventScroll: true });
  assert.equal(windowCloseCalls, 0, 'the same Escape must not also close the floating chat');
  const nextEscape = fx.fire(fx.document, 'keydown', fx.first.button, { key: 'Escape' });
  assert.equal(nextEscape.defaultPrevented, false);
  assert.equal(windowCloseCalls, 1);
});

test('Escape preserves focus outside the source list and other keyboard input keeps it open', t => {
  const fx = fixture(t);
  fx.controller.toggle(fx.first.button);
  fx.outside.focus();
  const arrow = fx.fire(fx.document, 'keydown', fx.outside, { key: 'ArrowDown' });
  assert.equal(arrow.defaultPrevented, false);
  fx.assertOpen(fx.first, true);
  fx.fire(fx.document, 'keydown', fx.outside, { key: 'Escape' });
  assert.equal(fx.document.activeElement, fx.outside);
  fx.assertOpen(fx.first, false);
});

test('scrolling sources keeps them usable while presenter scrolling, resizing and losing focus dismiss them', t => {
  const fx = fixture(t);
  fx.controller.toggle(fx.first.button);
  for (const target of [fx.first.popover, fx.first.link]) {
    fx.fire(fx.root, 'scroll', target);
    fx.assertOpen(fx.first, true);
  }
  fx.fire(fx.root, 'scroll');
  fx.assertOpen(fx.first, false);
  for (const type of ['resize', 'blur']) {
    fx.controller.toggle(fx.first.button);
    fx.fire(fx.document.defaultView, type);
    fx.assertOpen(fx.first, false);
  }
});

test('message rerenders invalidate the old source list and permit replacement markup to open', t => {
  for (const removed of ['wrapper', 'popover', 'button']) {
    const fx = fixture(t);
    fx.controller.toggle(fx.first.button);
    fx.first[removed].remove();
    fx.observers[0].callback();
    assert.equal(fx.controller.isOpen(), false, removed);
    fx.assertOpen(fx.first, false);
    const replacement = fx.makeSource();
    assert.equal(fx.controller.toggle(replacement.button), true);
    fx.assertOpen(replacement, true);
    assert.equal(fx.controller.toggle(fx.first.button), false, 'stale buttons cannot reopen old sources');
    fx.assertOpen(replacement, true);
  }
});

test('foreign, detached or ordinary buttons do not change the current source list', t => {
  const fx = fixture(t);
  fx.controller.toggle(fx.first.button);
  const foreign = fx.makeSource(fx.document.body);
  const detached = fx.makeSource();
  detached.wrapper.remove();
  const missingList = fx.makeSource();
  missingList.popover.remove();
  for (const button of [null, fx.outside, foreign.button, detached.button, missingList.button]) {
    assert.equal(fx.controller.toggle(button), false);
    fx.assertOpen(fx.first, true);
  }
});

test('disposal closes sources, releases observation, and makes old buttons and queued callbacks inert', t => {
  const fx = fixture(t);
  fx.controller.toggle(fx.first.button);
  fx.controller.dispose();
  fx.assertOpen(fx.first, false);
  assert.equal(fx.observers[0].disconnected, true);
  assert.equal(fx.controller.toggle(fx.first.button), false);
  assert.equal(fx.controller.isOpen(), false);
  let resumedEscape = 0;
  fx.document.addEventListener('keydown', () => { resumedEscape += 1; });
  const escape = fx.fire(fx.document, 'keydown', fx.first.button, { key: 'Escape' });
  assert.equal(escape.defaultPrevented, false);
  assert.equal(resumedEscape, 1);
  fx.fire(fx.document, 'pointerdown', fx.outside);
  fx.fire(fx.root, 'scroll');
  fx.fire(fx.document.defaultView, 'resize');
  fx.observers[0].callback();
  fx.controller.close({ restoreFocus: true });
  fx.controller.dispose();
  fx.assertOpen(fx.first, false);
});

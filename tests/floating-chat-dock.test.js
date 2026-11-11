import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloatingWindow } from '../src/sidepanel/features/messages/floating-window.js';
import { createFloatingChatDock } from '../src/sidepanel/features/messages/floating-chat-dock.js';

class Element extends EventTarget {
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.hidden = false;
    this.inert = false;
    this.textContent = 'unchanged conversation';
    this.scrollTop = 124;
  }
  appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelector(selector) { return selector === 'textarea' ? this.children.find(child => child.tagName === 'TEXTAREA') : null; }
  closest() { return ['BUTTON', 'TEXTAREA'].includes(this.tagName) ? this : null; }
  focus() { this.ownerDocument.activeElement = this; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    if (this.hidden) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const left = parseFloat(this.style.left) || 0;
    const top = parseFloat(this.style.top) || 0;
    const width = parseFloat(this.style.width) || 0;
    const height = parseFloat(this.style.height) || 0;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}

function fixture(t, { animated = false, reducedMotion = false, onExpand } = {}) {
  const document = new EventTarget();
  const window = new EventTarget();
  window.innerWidth = 1000;
  window.innerHeight = 800;
  window.matchMedia = () => ({ matches: reducedMotion });
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
  window.clearTimeout = id => timers.delete(id);
  document.defaultView = window;
  document.documentElement = { clientWidth: 1000, clientHeight: 800 };
  const animationCalls = [];
  document.createElement = tag => {
    const node = new Element(document, tag);
    if (animated) node.animate = (frames, options) => {
      let resolve;
      const animation = { finished: new Promise(done => { resolve = done; }),
        cancelCount: 0, cancel() { this.cancelCount += 1; }, finish: () => resolve() };
      animationCalls.push({ node, frames, options, animation });
      return animation;
    };
    return node;
  };
  document.body = document.createElement('body');
  document.querySelectorAll = selector => {
    const found = [];
    const visit = node => {
      if (selector === '.selection-chat-launcher' && node.className === 'selection-chat-launcher') found.push(node);
      node.children.forEach(visit);
    };
    visit(document.body);
    return found;
  };
  const element = document.body.appendChild(document.createElement('div'));
  element.id = 'followup-window';
  const dragHandle = element.appendChild(document.createElement('header'));
  const resizeHandle = element.appendChild(document.createElement('button'));
  const textarea = element.appendChild(document.createElement('textarea'));
  textarea.value = 'draft remains';
  let dock;
  const geometry = createFloatingWindow({ element, dragHandle, resizeHandle, window,
    onDragEnd: details => dock.handleDragEnd(details) });
  geometry.place({ left: 20, top: 30, right: 70, bottom: 60 });
  let busy = false;
  let activity = 'preparing';
  let unread = false;
  let detached = '';
  let collapses = 0;
  let expands = 0;
  dock = createFloatingChatDock({ element, geometry, iconMarkup: '<svg>chat</svg>',
    getBusy: () => busy, getDetachedLabel: () => detached,
    getActivity: () => activity, getUnread: () => unread,
    onCollapse: () => { collapses += 1; }, onExpand: () => { expands += 1; onExpand?.(dock); } });
  t.after(() => { dock.dispose(); geometry.dispose(); });
  const fire = (target, type, fields = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, clientX: 100, clientY: 100, button: 0, isPrimary: true }, fields);
    target.dispatchEvent(event);
  };
  return { document, window, element, textarea, dragHandle, resizeHandle, geometry, dock, fire,
    animationCalls, timers, counters: () => ({ collapses, expands }),
    setBusy: value => { busy = value; }, setDetached: value => { detached = value; },
    setActivity: value => { activity = value; }, setUnread: value => { unread = value; },
    flushTimers: () => { for (const callback of [...timers.values()]) callback(); },
  };
}
const flushPromises = () => new Promise(resolve => setImmediate(resolve));
async function finishAnimations(calls) {
  calls.forEach(call => call.animation.finish());
  await flushPromises();
}

function siblingDock(t, fx, { top = 70 } = {}) {
  const element = fx.document.body.appendChild(fx.document.createElement('div'));
  let rect = { left: 570, top, width: 420, height: 480 };
  const geometry = { rect: () => ({ ...rect }), restoreRect: value => { rect = { ...value }; } };
  const dock = createFloatingChatDock({ element, geometry, iconMarkup: '<svg>chat</svg>' });
  t.after(() => dock.dispose());
  return dock;
}

function assertSeparated(docks, height) {
  const slots = docks.map(dock => ({ top: parseFloat(dock.launcher.style.top),
    height: parseFloat(dock.launcher.style.height) })).sort((a, b) => a.top - b.top);
  for (let i = 0; i < slots.length; i += 1) {
    assert.ok(slots[i].top >= 0 && slots[i].top + slots[i].height <= height);
    if (i) assert.ok(slots[i].top - slots[i - 1].top - slots[i - 1].height >= 8);
  }
}

test('only a deliberate rightward drag at the edge collapses the floating chat', t => {
  const fx = fixture(t);
  fx.geometry.restoreRect({ left: 570, top: 70, width: 420, height: 480 });
  assert.equal(fx.dock.isDocked(), false, 'initial placement at the edge');
  fx.fire(fx.dragHandle, 'pointerdown');
  fx.fire(fx.document, 'pointermove', { clientY: 230 });
  fx.fire(fx.document, 'pointerup', { clientY: 230 });
  assert.equal(fx.dock.isDocked(), false, 'vertical dragging');
  fx.fire(fx.dragHandle, 'pointerdown');
  fx.fire(fx.document, 'pointermove', { clientX: 123 });
  fx.fire(fx.document, 'pointerup', { clientX: 123 });
  assert.equal(fx.dock.isDocked(), false, 'short accidental motion');
  fx.geometry.restoreRect({ left: 80, top: 70, width: 420, height: 480 });
  assert.equal(fx.dock.handleDragEnd({ rect: fx.geometry.rect(), deltaX: 50 }), false, 'away from the edge');
  fx.fire(fx.dragHandle, 'pointerdown');
  fx.fire(fx.document, 'pointermove', { clientX: 700 });
  assert.equal(fx.dock.isDocked(), false, 'drag has not completed');
  fx.fire(fx.document, 'pointerup', { clientX: 700 });
  assert.equal(fx.dock.isDocked(), true);
  assert.equal(fx.element.hidden, true);
  assert.equal(fx.dock.launcher.hidden, false);
  assert.equal(fx.dock.launcher.dataset.state, 'docked');
});

test('launcher click restores the saved rectangle, draft, focus and scroll without touching conversation content', t => {
  const fx = fixture(t);
  fx.textarea.focus();
  const rect = fx.geometry.rect();
  assert.equal(fx.dock.collapse(), true);
  assert.equal(fx.document.activeElement, fx.dock.launcher);
  assert.equal(fx.dock.collapse(), false);
  fx.fire(fx.dock.launcher, 'click');
  assert.equal(fx.dock.isDocked(), false);
  assert.equal(fx.dock.launcher.hidden, true);
  assert.equal(fx.element.hidden, false);
  assert.equal(fx.element.inert, false);
  assert.deepEqual(fx.geometry.rect(), rect);
  assert.equal(fx.textarea.value, 'draft remains');
  assert.equal(fx.element.scrollTop, 124);
  assert.equal(fx.element.textContent, 'unchanged conversation');
  assert.equal(fx.document.activeElement, fx.textarea);
  assert.deepEqual(fx.counters(), { collapses: 1, expands: 1 });
  assert.equal(fx.dock.launcher.getAttribute('aria-controls'), 'followup-window');
});

test('viewport changes keep the launcher and restored window within the current viewport', t => {
  const fx = fixture(t);
  fx.geometry.restoreRect({ left: 570, top: 310, width: 420, height: 480 });
  fx.dock.collapse();
  fx.window.innerWidth = 320;
  fx.window.innerHeight = 360;
  fx.window.dispatchEvent(new Event('resize'));
  assert.ok(parseFloat(fx.dock.launcher.style.top) + 48 <= 350);
  fx.dock.expand();
  assert.deepEqual(fx.geometry.rect(), { left: 10, top: 10, width: 300, height: 340 });
});

test('reduced motion completes immediately even when Web Animations is available', t => {
  const fx = fixture(t, { animated: true, reducedMotion: true });
  fx.dock.collapse();
  assert.equal(fx.element.hidden, true);
  fx.dock.expand();
  assert.equal(fx.element.hidden, false);
  assert.equal(fx.dock.launcher.hidden, true);
  assert.equal(fx.animationCalls.length, 0);
  assert.equal(fx.timers.size, 0);
});

test('animated collapse and expand expose a bounded transition and finish in the correct visible state', async t => {
  const fx = fixture(t, { animated: true });
  fx.dock.collapse();
  assert.equal(fx.element.dataset.dockState, 'collapsing');
  assert.equal(fx.element.hidden, false);
  assert.equal(fx.element.inert, true);
  assert.equal(fx.animationCalls[0].options.duration, 260);
  await finishAnimations(fx.animationCalls);
  assert.equal(fx.element.hidden, true);
  assert.equal(fx.element.dataset.dockState, 'docked');
  assert.equal(fx.timers.size, 0);
  const oldCount = fx.animationCalls.length;
  fx.dock.expand();
  assert.equal(fx.element.dataset.dockState, 'expanding');
  assert.equal(fx.element.hidden, false);
  await finishAnimations(fx.animationCalls.slice(oldCount));
  assert.equal(fx.element.dataset.dockState, 'expanded');
  assert.equal(fx.dock.launcher.hidden, true);
  assert.equal(fx.element.inert, false);
});

test('late collapse completions cannot hide a window that is expanding again', async t => {
  const fx = fixture(t, { animated: true });
  fx.dock.collapse();
  const oldCalls = [...fx.animationCalls];
  fx.dock.expand();
  const newCalls = fx.animationCalls.slice(oldCalls.length);
  assert.ok(oldCalls.every(call => call.animation.cancelCount === 1));
  await finishAnimations(oldCalls);
  assert.equal(fx.element.hidden, false);
  assert.equal(fx.element.dataset.dockState, 'expanding');
  await finishAnimations(newCalls);
  assert.equal(fx.element.dataset.dockState, 'expanded');
  assert.deepEqual(fx.counters(), { collapses: 1, expands: 1 });
});

test('late expansion completions cannot reopen a window that is collapsing again', async t => {
  const fx = fixture(t, { animated: true });
  fx.dock.collapse();
  await finishAnimations(fx.animationCalls);
  const beforeExpand = fx.animationCalls.length;
  fx.dock.expand();
  const oldCalls = fx.animationCalls.slice(beforeExpand);
  fx.dock.collapse();
  const newCalls = fx.animationCalls.slice(beforeExpand + oldCalls.length);
  await finishAnimations(oldCalls);
  assert.equal(fx.element.dataset.dockState, 'collapsing');
  await finishAnimations(newCalls);
  assert.equal(fx.element.hidden, true);
  assert.equal(fx.element.dataset.dockState, 'docked');
  assert.deepEqual(fx.counters(), { collapses: 2, expands: 0 });
});

test('hung animation promises and viewport changes cannot leave a transition stuck', t => {
  const fx = fixture(t, { animated: true });
  fx.dock.collapse();
  fx.flushTimers();
  assert.equal(fx.element.dataset.dockState, 'docked');
  fx.dock.expand();
  fx.window.innerWidth = 320;
  fx.window.dispatchEvent(new Event('resize'));
  assert.equal(fx.element.dataset.dockState, 'expanded');
  assert.equal(fx.element.hidden, false);
  assert.ok(fx.geometry.rect().left + fx.geometry.rect().width <= 310);
  assert.equal(fx.timers.size, 0);
});

test('busy and detached launcher descriptions update without stopping or altering the chat', t => {
  const fx = fixture(t);
  fx.dock.collapse();
  fx.setBusy(true);
  fx.setDetached('已解除跟随，新选区将开始新的追问');
  fx.dock.sync();
  assert.equal(fx.dock.launcher.dataset.busy, 'true');
  assert.equal(fx.dock.launcher.dataset.detached, 'true');
  assert.match(fx.dock.launcher.title, /收起后会继续/);
  assert.match(fx.dock.launcher.title, /已解除跟随/);
  assert.equal(fx.element.hidden, true);
  assert.deepEqual(fx.counters(), { collapses: 1, expands: 0 });
  fx.setBusy(false);
  fx.setDetached('');
  fx.dock.sync();
  assert.equal(fx.dock.launcher.title, '展开单独追问');
});

test('launcher progress follows the current phase and suppresses unread while the command is busy', t => {
  const fx = fixture(t);
  fx.dock.collapse();
  fx.setBusy(true);
  // A successful terminal may arrive before the command finishes its cleanup.
  fx.setUnread(true);
  for (const [phase, label] of [['preparing', '正在准备回答'], ['thinking', '正在思考'], ['answering', '正在回答']]) {
    fx.setActivity(phase);
    fx.dock.sync();
    assert.equal(fx.dock.launcher.dataset.activity, phase);
    assert.equal(fx.dock.launcher.dataset.unread, 'false');
    assert.match(fx.dock.launcher.title, new RegExp(label));
    assert.doesNotMatch(fx.dock.launcher.title, /待查看/);
  }
  fx.setBusy(false);
  fx.dock.sync();
  assert.equal(fx.dock.launcher.dataset.activity, 'idle');
  assert.equal(fx.dock.launcher.dataset.unread, 'true');
  assert.match(fx.dock.launcher.getAttribute('aria-description'), /回答已完成，待查看/);
  assert.deepEqual(fx.counters(), { collapses: 1, expands: 0 });
});

test('viewing a completed answer clears its launcher badge permanently across another collapse', t => {
  let fx;
  fx = fixture(t, { onExpand: dock => { fx.setUnread(false); dock.sync(); } });
  fx.dock.collapse();
  fx.setUnread(true);
  fx.dock.sync();
  assert.equal(fx.dock.launcher.dataset.unread, 'true');
  fx.fire(fx.dock.launcher, 'click');
  assert.equal(fx.dock.launcher.dataset.unread, 'false');
  assert.equal(fx.dock.launcher.hidden, true);
  fx.dock.collapse();
  assert.equal(fx.dock.launcher.dataset.unread, 'false');
  assert.equal(fx.dock.launcher.title, '展开单独追问');
});

test('dispose removes the launcher, listeners and animations and ignores late completions', async t => {
  const fx = fixture(t, { animated: true });
  fx.dock.collapse();
  const calls = [...fx.animationCalls];
  fx.dock.dispose();
  assert.equal(fx.dock.launcher.parentElement, null);
  assert.equal(fx.timers.size, 0);
  assert.equal(fx.element.inert, false);
  assert.equal(fx.dock.expand(), false);
  assert.equal(fx.dock.collapse(), false);
  fx.fire(fx.dock.launcher, 'click');
  fx.window.dispatchEvent(new Event('resize'));
  await finishAnimations(calls);
  assert.equal(fx.element.hidden, false);
  assert.deepEqual(fx.counters(), { collapses: 1, expands: 0 });
  assert.ok(calls.every(call => call.animation.cancelCount === 1));
});

test('an expansion callback that closes the view cannot focus its old composer afterward', t => {
  const fx = fixture(t, { onExpand: dock => dock.dispose() });
  fx.textarea.focus();
  fx.dock.collapse();
  fx.document.activeElement = fx.document.body;
  fx.dock.expand();
  assert.equal(fx.document.activeElement, fx.document.body);
  assert.equal(fx.dock.launcher.parentElement, null);
});

test('multiple launchers reserve the nearest free slots without moving another collapse animation', async t => {
  const fx = fixture(t, { animated: true });
  const second = siblingDock(t, fx);
  const third = siblingDock(t, fx);
  fx.dock.collapse();
  const firstTop = fx.dock.launcher.style.top;
  const firstCalls = [...fx.animationCalls];
  second.collapse();
  third.collapse();
  assert.equal(firstTop, '286px');
  assert.equal(second.launcher.style.top, '230px');
  assert.equal(third.launcher.style.top, '342px');
  assertSeparated([fx.dock, second, third], 800);
  assert.equal(fx.dock.launcher.style.top, firstTop);
  assert.ok(firstCalls.every(call => call.animation.cancelCount === 0));
  assert.equal(fx.element.dataset.dockState, 'collapsing');
  await finishAnimations(fx.animationCalls);
});

test('hidden and disposed launchers release their slots without reordering visible neighbors', t => {
  const fx = fixture(t);
  const second = siblingDock(t, fx);
  const third = siblingDock(t, fx);
  second.collapse();
  assert.equal(second.launcher.style.top, '286px', 'hidden launchers do not reserve a slot');
  fx.dock.collapse();
  assert.equal(fx.dock.launcher.style.top, '230px');
  const firstTop = fx.dock.launcher.style.top;
  second.expand();
  assert.equal(fx.dock.launcher.style.top, firstTop);
  third.collapse();
  assert.equal(third.launcher.style.top, '286px');
  third.dispose();
  assert.equal(fx.dock.launcher.style.top, firstTop);
  second.collapse();
  assert.equal(second.launcher.style.top, '286px', 'disposed launchers do not reserve a slot');
  assertSeparated([fx.dock, second], 800);
});

test('resize and sync keep several launchers separated and degrade within extremely short viewports', async t => {
  const fx = fixture(t, { animated: true });
  fx.geometry.restoreRect({ left: 570, top: 310, width: 420, height: 480 });
  const second = siblingDock(t, fx, { top: 310 });
  const third = siblingDock(t, fx, { top: 310 });
  const docks = [fx.dock, second, third];
  docks.forEach(dock => dock.collapse());
  await finishAnimations(fx.animationCalls);
  const animationCount = fx.animationCalls.length;
  fx.window.innerHeight = 360;
  fx.window.dispatchEvent(new Event('resize'));
  docks.forEach(dock => dock.sync());
  assertSeparated(docks, 360);
  assert.equal(fx.animationCalls.length, animationCount);
  fx.window.innerHeight = 40;
  fx.window.dispatchEvent(new Event('resize'));
  docks.forEach(dock => dock.sync());
  for (const dock of docks) {
    assert.equal(dock.launcher.style.top, '0px');
    assert.equal(dock.launcher.style.height, '40px');
    assert.equal(dock.launcher.hidden, false);
  }
  assert.equal(fx.animationCalls.length, animationCount);
  assert.equal(fx.timers.size, 0);
});

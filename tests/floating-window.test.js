import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloatingWindow } from '../src/sidepanel/features/messages/floating-window.js';

class Element extends EventTarget {
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.captured = new Set();
    this.captureCalls = [];
    this.textContent = 'unchanged chat content';
    this.scrollTop = 124;
  }
  closest() { return ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) ? this : null; }
  setPointerCapture(id) { this.captured.add(id); this.captureCalls.push(['set', id]); }
  releasePointerCapture(id) { this.captured.delete(id); this.captureCalls.push(['release', id]); }
  getBoundingClientRect() {
    const left = parseFloat(this.style.left) || 0;
    const top = parseFloat(this.style.top) || 0;
    const width = parseFloat(this.style.width) || 0;
    const height = parseFloat(this.style.height) || 0;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}

function fixture(t, { width = 1000, height = 800, ...options } = {}) {
  const document = new EventTarget();
  const window = new EventTarget();
  window.innerWidth = width;
  window.innerHeight = height;
  document.defaultView = window;
  document.documentElement = { clientWidth: width, clientHeight: height };
  const element = new Element(document);
  const dragHandle = new Element(document);
  const resizeHandle = new Element(document, 'button');
  const controller = createFloatingWindow({ element, dragHandle, resizeHandle, window, ...options });
  t.after(() => controller.dispose());
  const fire = (receiver, type, fields = {}, target = receiver) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, { pointerId: 1, clientX: 100, clientY: 100, button: 0, isPrimary: true }, fields);
    receiver.dispatchEvent(event);
    return event;
  };
  controller.place({ left: 20, top: 30, right: 70, bottom: 60 });
  return { document, window, element, dragHandle, resizeHandle, controller, fire,
    rect: () => element.getBoundingClientRect() };
}

test('initial placement uses the selected text anchor and fits narrow viewports', t => {
  const fx = fixture(t);
  assert.deepEqual(fx.rect(), { left: 80, top: 70, width: 420, height: 480, right: 500, bottom: 550 });
  fx.controller.place({ left: 900, top: 760, right: 980, bottom: 785 });
  assert.deepEqual(fx.rect(), { left: 570, top: 310, width: 420, height: 480, right: 990, bottom: 790 });
  const narrow = fixture(t, { width: 250, height: 220 });
  assert.deepEqual(narrow.rect(), { left: 10, top: 10, width: 230, height: 200, right: 240, bottom: 210 });
  assert.equal(narrow.element.style.position, 'fixed');
});

test('header dragging clamps to the viewport, tracks only its pointer and ends on release', t => {
  const fx = fixture(t);
  assert.equal(fx.fire(fx.dragHandle, 'pointerdown').defaultPrevented, true);
  assert.ok(fx.dragHandle.captured.has(1));
  fx.fire(fx.document, 'pointermove', { pointerId: 2, clientX: 900, clientY: 700 });
  assert.equal(fx.rect().left, 80);
  fx.fire(fx.document, 'pointermove', { clientX: 200, clientY: 160 });
  assert.equal(fx.rect().left, 180);
  assert.equal(fx.rect().top, 130);
  fx.fire(fx.document, 'pointermove', { clientX: -500, clientY: -500 });
  assert.equal(fx.rect().left, 10);
  assert.equal(fx.rect().top, 10);
  fx.fire(fx.document, 'pointermove', { clientX: 2000, clientY: 2000 });
  assert.equal(fx.rect().right, 990);
  assert.equal(fx.rect().bottom, 790);
  const final = fx.rect();
  fx.fire(fx.document, 'pointerup');
  fx.fire(fx.document, 'pointermove', { clientX: 0, clientY: 0 });
  assert.deepEqual(fx.rect(), final);
  assert.deepEqual(fx.dragHandle.captureCalls, [['set', 1], ['release', 1]]);
  assert.equal(fx.element.scrollTop, 124);
  assert.equal(fx.element.textContent, 'unchanged chat content');
});

test('interactive header controls and non-primary pointer actions keep their native interaction', t => {
  const fx = fixture(t);
  const initial = fx.rect();
  for (const tag of ['button', 'a', 'input', 'textarea', 'select']) {
    const target = new Element(fx.document, tag);
    const event = fx.fire(fx.dragHandle, 'pointerdown', {}, target);
    assert.equal(event.defaultPrevented, false, tag);
    fx.fire(fx.document, 'pointermove', { clientX: 200, clientY: 200 });
    assert.deepEqual(fx.rect(), initial, tag);
  }
  for (const fields of [{ button: 2 }, { isPrimary: false }]) {
    assert.equal(fx.fire(fx.dragHandle, 'pointerdown', fields).defaultPrevented, false);
    fx.fire(fx.document, 'pointermove', { clientX: 200, clientY: 200 });
    assert.deepEqual(fx.rect(), initial);
  }
});

test('corner resizing changes both dimensions at the same origin and respects maximum and minimum size', t => {
  const fx = fixture(t);
  fx.fire(fx.resizeHandle, 'pointerdown');
  fx.fire(fx.document, 'pointermove', { clientX: 220, clientY: 180 });
  assert.deepEqual(fx.rect(), { left: 80, top: 70, width: 540, height: 560, right: 620, bottom: 630 });
  fx.fire(fx.document, 'pointermove', { clientX: 3000, clientY: 3000 });
  assert.deepEqual(fx.rect(), { left: 80, top: 70, width: 910, height: 720, right: 990, bottom: 790 });
  fx.fire(fx.document, 'pointermove', { clientX: -3000, clientY: -3000 });
  assert.equal(fx.rect().width, 280);
  assert.equal(fx.rect().height, 260);
  fx.fire(fx.document, 'pointercancel');
  const final = fx.rect();
  fx.fire(fx.document, 'pointermove', { clientX: 3000, clientY: 3000 });
  assert.deepEqual(fx.rect(), final);
  assert.equal(fx.resizeHandle.captured.size, 0);
});

test('Arrow keys resize without scrolling and Shift provides a larger step', t => {
  const fx = fixture(t);
  const initial = fx.rect();
  assert.equal(fx.fire(fx.resizeHandle, 'keydown', { key: 'ArrowRight' }).defaultPrevented, true);
  assert.equal(fx.rect().width, initial.width + 20);
  fx.fire(fx.resizeHandle, 'keydown', { key: 'ArrowDown', shiftKey: true });
  assert.equal(fx.rect().height, initial.height + 60);
  fx.fire(fx.resizeHandle, 'keydown', { key: 'ArrowLeft' });
  fx.fire(fx.resizeHandle, 'keydown', { key: 'ArrowUp', shiftKey: true });
  assert.deepEqual(fx.rect(), initial);
  assert.equal(fx.fire(fx.resizeHandle, 'keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.equal(fx.element.scrollTop, 124);
});

test('viewport resizing and window focus loss finish stale pointer interactions', t => {
  const fx = fixture(t);
  fx.fire(fx.dragHandle, 'pointerdown');
  fx.window.innerWidth = 320;
  fx.window.innerHeight = 360;
  fx.window.dispatchEvent(new Event('resize'));
  assert.deepEqual(fx.rect(), { left: 10, top: 10, width: 300, height: 340, right: 310, bottom: 350 });
  fx.fire(fx.document, 'pointermove', { clientX: 200, clientY: 200 });
  assert.equal(fx.rect().left, 10);
  assert.equal(fx.dragHandle.captured.size, 0);
  fx.fire(fx.resizeHandle, 'pointerdown');
  fx.window.dispatchEvent(new Event('blur'));
  const final = fx.rect();
  fx.fire(fx.document, 'pointermove', { clientX: 0, clientY: 0 });
  assert.deepEqual(fx.rect(), final);
  assert.equal(fx.resizeHandle.captured.size, 0);
});

test('dispose releases captures and listeners and prevents later positioning or geometry changes', t => {
  const fx = fixture(t);
  fx.fire(fx.dragHandle, 'pointerdown');
  const final = fx.rect();
  fx.controller.dispose();
  assert.equal(fx.dragHandle.captured.size, 0);
  assert.equal(fx.dragHandle.style.touchAction, undefined);
  assert.equal(fx.resizeHandle.style.touchAction, undefined);
  fx.fire(fx.document, 'pointermove', { clientX: 200, clientY: 200 });
  fx.fire(fx.resizeHandle, 'keydown', { key: 'ArrowRight' });
  fx.controller.place({ left: 500, top: 300 });
  fx.window.innerWidth = 240;
  fx.window.dispatchEvent(new Event('resize'));
  assert.deepEqual(fx.rect(), final);
  fx.controller.dispose();
});

test('only a released drag reports its tracked movement and final viewport rectangle', t => {
  const completions = [];
  const fx = fixture(t, { onDragEnd: details => completions.push(details) });
  fx.fire(fx.dragHandle, 'pointerdown', { clientX: 140, clientY: 120 });
  fx.fire(fx.document, 'pointermove', { clientX: 740, clientY: 160 });
  fx.fire(fx.document, 'pointerup', { pointerId: 2 });
  assert.equal(completions.length, 0);
  fx.fire(fx.document, 'pointerup', { clientX: 740, clientY: 160 });
  assert.deepEqual(completions, [{ rect: { left: 570, top: 110, width: 420, height: 480 },
    deltaX: 600, deltaY: 40, pointerX: 740, pointerY: 160 }]);
  fx.fire(fx.document, 'pointerup', { clientX: 740, clientY: 160 });
  fx.fire(fx.resizeHandle, 'pointerdown');
  fx.fire(fx.document, 'pointermove', { clientX: 140, clientY: 140 });
  fx.fire(fx.document, 'pointerup');
  assert.equal(completions.length, 1);
});

test('cancelled, interrupted and disposed drags never report a completed drag', t => {
  const completions = [];
  const fx = fixture(t, { onDragEnd: details => completions.push(details) });
  for (const end of [
    () => fx.fire(fx.document, 'pointercancel'),
    () => fx.fire(fx.dragHandle, 'lostpointercapture'),
    () => fx.window.dispatchEvent(new Event('blur')),
    () => fx.window.dispatchEvent(new Event('resize')),
    () => fx.controller.place(),
    () => fx.controller.restoreRect({ left: 80, top: 70, width: 420, height: 480 }),
    () => fx.controller.dispose(),
  ]) {
    fx.fire(fx.dragHandle, 'pointerdown');
    fx.fire(fx.document, 'pointermove', { clientX: 700, clientY: 180 });
    end();
    fx.fire(fx.document, 'pointerup');
  }
  assert.deepEqual(completions, []);
});

test('saved geometry is copied on read and fitted to the current viewport when restored', t => {
  const fx = fixture(t);
  const saved = fx.controller.rect();
  saved.left = 570;
  assert.equal(fx.rect().left, 80);
  fx.controller.restoreRect(saved);
  assert.equal(fx.rect().right, 990);
  fx.window.innerWidth = 320;
  fx.window.innerHeight = 360;
  fx.controller.restoreRect(saved);
  assert.deepEqual(fx.controller.rect(), { left: 10, top: 10, width: 300, height: 340 });
  fx.controller.dispose();
  fx.controller.restoreRect({ left: 100, top: 100, width: 280, height: 260 });
  assert.deepEqual(fx.controller.rect(), { left: 10, top: 10, width: 300, height: 340 });
});

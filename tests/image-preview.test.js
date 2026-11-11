import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagePreview } from '../src/sidepanel/features/messages/image-preview.js';

const source = 'data:image/png;base64,aW1hZ2U=';
const otherSource = 'data:image/jpeg;base64,b3RoZXI=';

class Element extends EventTarget {
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.open = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.complete = false;
    this.capturedPointers = new Set();
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  contains(target) { return target === this || this.children.some(node => node.contains(target)); }
  matches(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    const attribute = selector.match(/\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/);
    return (!tag || this.tagName === tag.toUpperCase()) &&
      (!attribute || (this.getAttribute(attribute[1]) !== null &&
        (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2])));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
  }
  focus() { this.ownerDocument.activeElement = this; }
  get clientWidth() { return this.ownerDocument.viewportRect.width; }
  get clientHeight() { return this.ownerDocument.viewportRect.height; }
  getBoundingClientRect() {
    const { x, y, width, height } = this.ownerDocument.viewportRect;
    return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height };
  }
  setPointerCapture(id) { this.capturedPointers.add(id); }
  hasPointerCapture(id) { return this.capturedPointers.has(id); }
  releasePointerCapture(id) { this.capturedPointers.delete(id); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  showModal() { this.open = true; this.showModalCount = (this.showModalCount || 0) + 1; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent(new Event('close')); }
}

function descendants(element) { return element ? [element, ...element.children.flatMap(descendants)] : []; }

function fixture(t, { fallbackFocus } = {}) {
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.viewportRect = { x: 12, y: 70, width: 560, height: 760 };
  const observers = [];
  document.defaultView.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  document.createElement = tag => new Element(document, tag);
  document.body = new Element(document, 'body');
  const trigger = document.createElement('button');
  document.body.append(trigger);
  const errors = [];
  const controller = createImagePreview({ document, onError: (...args) => errors.push(args), fallbackFocus });
  t.after(() => controller.dispose());
  const dialog = () => document.body.children.find(node => node.tagName === 'DIALOG');
  const elements = () => descendants(dialog());
  const image = () => elements().find(node => node.tagName === 'IMG');
  const viewport = () => elements().find(node => node.classList.contains('image-preview-viewport'));
  const button = label => elements().find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === label);
  const closeButton = () => elements().find(node => node.tagName === 'BUTTON' &&
    (node.getAttribute('aria-label') === '关闭图片预览' || node.textContent === '关闭图片预览'));
  const sizeButton = () => elements().find(node => node.tagName === 'BUTTON' && /原始尺寸|适应宽度/.test(node.textContent));
  const fire = (receiver, type, target = receiver, fields = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, fields);
    receiver.dispatchEvent(event);
    return event;
  };
  controller.sync('conversation-a');
  const open = (overrides = {}) => {
    if (overrides.conversationId) controller.sync(overrides.conversationId);
    return controller.open({ src: source, name: '图片附件', trigger, ...overrides });
  };
  const load = (width = 1200, height = 800) => {
    Object.assign(image(), { naturalWidth: width, naturalHeight: height, complete: true });
    fire(image(), 'load');
  };
  const geometry = () => {
    const transform = image().style.transform;
    const position = transform?.match(/translate3d\(\s*([-\d.e]+)px,\s*([-\d.e]+)px,\s*0(?:px)?\s*\)/);
    const scale = Number(transform?.match(/scale\(\s*([-\d.e]+)\s*\)/)?.[1]);
    assert.ok(position && Number.isFinite(scale), `Expected a translated and scaled image, got ${transform}`);
    return { x: Number(position[1]), y: Number(position[2]), scale, width: image().naturalWidth * scale, height: image().naturalHeight * scale };
  };
  const resize = (width, height) => {
    Object.assign(document.viewportRect, { width, height });
    observers.filter(observer => !observer.disconnected).forEach(observer => observer.callback([{ target: observer.target }]));
    document.defaultView.dispatchEvent(new Event('resize'));
  };
  return { document, controller, trigger, errors, dialog, elements, image, viewport, button, closeButton, sizeButton, fire, open, load, geometry, resize, observers };
}

test('image preview opens a body-level modal with a fixed source and a safe accessible title', t => {
  const fx = fixture(t);
  const title = '<img src=x onerror=alert(1)>长图';
  const request = { src: source, name: title, trigger: fx.trigger };
  assert.equal(fx.controller.open(request), true);
  request.src = otherSource;
  request.name = '后来更新的标题';
  assert.equal(fx.dialog().parentNode, fx.document.body);
  assert.equal(fx.dialog().open, true);
  assert.equal(fx.dialog().showModalCount, 1);
  assert.equal(fx.image().src, source);
  const labelledBy = fx.dialog().getAttribute('aria-labelledby');
  assert.ok(labelledBy);
  const heading = fx.elements().find(node => node.id === labelledBy);
  assert.equal(heading?.textContent, title);
  assert.equal(heading.children.length, 0);
  assert.ok(fx.closeButton(), 'the modal exposes a clearly named close button');
  assert.equal(fx.document.activeElement, fx.closeButton());
  assert.deepEqual(fx.errors, []);
});

test('marked image clicks and Enter or Space open a preview through document delegation', t => {
  const fx = fixture(t);
  const thumbnail = fx.document.createElement('img');
  thumbnail.src = source;
  thumbnail.alt = '长图附件';
  thumbnail.dataset.imagePreview = 'true';
  thumbnail.dataset.imageName = '长图附件';
  thumbnail.tabIndex = 0;
  fx.document.body.append(thumbnail);
  for (const activation of ['click', 'Enter', ' ']) {
    const event = activation === 'click' ? fx.fire(fx.document, 'click', thumbnail)
      : fx.fire(fx.document, 'keydown', thumbnail, { key: activation });
    assert.equal(fx.dialog()?.open, true, activation);
    assert.equal(fx.image().src, source);
    if (activation !== 'click') assert.equal(event.defaultPrevented, true);
    fx.closeButton().click();
    assert.equal(fx.document.activeElement, thumbnail);
  }
  const ordinary = fx.document.createElement('img');
  ordinary.src = source;
  fx.document.body.append(ordinary);
  fx.fire(fx.document, 'click', ordinary);
  assert.equal(fx.dialog(), undefined, 'images not marked for preview are ignored');
  fx.fire(fx.document, 'keydown', thumbnail, { key: 'ArrowDown' });
  assert.equal(fx.dialog(), undefined);
  fx.controller.dispose();
  fx.fire(fx.document, 'click', thumbnail);
  fx.fire(fx.document, 'keydown', thumbnail, { key: 'Enter' });
  assert.equal(fx.dialog(), undefined);
});

test('the close button, backdrop and native Escape cancellation close and restore trigger focus', t => {
  for (const action of ['button', 'backdrop', 'escape']) {
    const fx = fixture(t);
    fx.open();
    const dialog = fx.dialog();
    if (action === 'button') fx.closeButton().click();
    else if (action === 'backdrop') fx.fire(dialog, 'click');
    else fx.fire(dialog, 'cancel');
    assert.equal(fx.dialog(), undefined, action);
    assert.equal(dialog.open, false, action);
    assert.equal(fx.document.activeElement, fx.trigger, action);
    assert.deepEqual(fx.errors, []);
  }
});

test('Escape closes only the preview and stops other document shortcuts until the modal is closed', t => {
  const fx = fixture(t);
  let otherEscapeCalls = 0;
  fx.document.addEventListener('keydown', event => { if (event.key === 'Escape') otherEscapeCalls += 1; });
  fx.open();
  const escape = fx.fire(fx.document, 'keydown', fx.closeButton(), { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(fx.dialog(), undefined);
  assert.equal(fx.document.activeElement, fx.trigger);
  assert.equal(otherEscapeCalls, 0, 'the history drawer shortcut must not run for the same Escape');
  const nextEscape = fx.fire(fx.document, 'keydown', fx.trigger, { key: 'Escape' });
  assert.equal(nextEscape.defaultPrevented, false);
  assert.equal(otherEscapeCalls, 1, 'normal shortcuts resume after the preview closes');
});

test('clicking the image or modal content keeps the preview open', t => {
  const fx = fixture(t);
  fx.open();
  const dialog = fx.dialog();
  fx.fire(dialog, 'click', fx.image());
  assert.equal(fx.dialog(), dialog);
  const content = fx.elements().find(node => node !== dialog && node.tagName !== 'IMG' && node.tagName !== 'BUTTON');
  assert.ok(content);
  fx.fire(dialog, 'click', content);
  assert.equal(fx.dialog(), dialog);
});

test('the size control switches to original dimensions and back without changing the image', t => {
  const fx = fixture(t);
  fx.open();
  fx.load();
  const dialog = fx.dialog();
  const image = fx.image();
  const size = fx.sizeButton();
  assert.ok(size);
  assert.equal(size.textContent, '原始尺寸');
  assert.equal(size.getAttribute('aria-pressed'), 'false');
  size.click();
  assert.equal(size.textContent, '适应宽度');
  assert.equal(size.getAttribute('aria-pressed'), 'true');
  assert.equal(fx.dialog(), dialog);
  assert.equal(fx.image(), image);
  assert.equal(image.src, source);
  size.click();
  assert.equal(size.textContent, '原始尺寸');
  assert.equal(size.getAttribute('aria-pressed'), 'false');
});

test('same-conversation rendering preserves a preview but switching conversations closes it', t => {
  const fx = fixture(t);
  fx.open();
  const dialog = fx.dialog();
  fx.controller.sync('conversation-a');
  assert.equal(fx.dialog(), dialog);
  fx.controller.sync('conversation-b');
  assert.equal(fx.dialog(), undefined);
  assert.equal(dialog.open, false);
  assert.notEqual(fx.document.activeElement, fx.trigger, 'conversation switches do not focus the old image');
  const nextTrigger = fx.document.createElement('button');
  fx.document.body.append(nextTrigger);
  fx.open({ src: otherSource, trigger: nextTrigger, conversationId: 'conversation-b' });
  assert.equal(fx.image().src, otherSource);
  fx.controller.sync('conversation-b');
  assert.ok(fx.dialog());
});

test('closing and disposal do not focus detached triggers, and disposal prevents reopening', t => {
  const fx = fixture(t);
  fx.open();
  const close = fx.closeButton();
  fx.trigger.remove();
  fx.controller.close();
  assert.equal(fx.dialog(), undefined);
  assert.equal(fx.document.activeElement, close);
  fx.document.body.append(fx.trigger);
  fx.open();
  const dialog = fx.dialog();
  fx.controller.dispose();
  assert.equal(fx.dialog(), undefined);
  assert.equal(dialog.open, false);
  assert.equal(fx.open(), false);
  fx.fire(dialog, 'cancel');
  fx.fire(dialog, 'click');
  assert.equal(fx.dialog(), undefined);
  assert.deepEqual(fx.errors, []);
});

test('a detached image restores fallback focus on user close but conversation changes and disposal do not steal it', t => {
  let fallback;
  let fallbackCalls = 0;
  const fx = fixture(t, { fallbackFocus: () => { fallbackCalls += 1; return fallback; } });
  fallback = fx.document.createElement('textarea');
  fx.document.body.append(fallback);
  fx.open();
  fx.trigger.remove();
  fx.closeButton().click();
  assert.equal(fx.document.activeElement, fallback);
  assert.equal(fallbackCalls, 1);

  fx.document.body.append(fx.trigger);
  fx.open();
  fx.trigger.remove();
  fx.controller.sync('conversation-b');
  assert.equal(fallbackCalls, 1, 'switching conversations does not restore focus to the old input');
  fx.document.body.append(fx.trigger);
  fx.open();
  fx.trigger.remove();
  fx.controller.dispose();
  assert.equal(fallbackCalls, 1, 'disposing leaves subsequent UI in control of focus');
});

test('late errors from a replaced image cannot close or report against the current preview', t => {
  const fx = fixture(t);
  fx.open();
  const oldImage = fx.image();
  const oldDialog = fx.dialog();
  const otherTrigger = fx.document.createElement('button');
  fx.document.body.append(otherTrigger);
  fx.open({ src: otherSource, trigger: otherTrigger, conversationId: 'conversation-b' });
  const currentDialog = fx.dialog();
  oldImage.dispatchEvent(new Event('error'));
  fx.fire(oldDialog, 'cancel');
  assert.equal(fx.dialog(), currentDialog);
  assert.equal(fx.image().src, otherSource);
  assert.deepEqual(fx.errors, []);
  fx.image().dispatchEvent(new Event('error'));
  assert.equal(fx.dialog(), undefined);
  assert.equal(fx.errors.length, 1);
  assert.equal(fx.document.activeElement, otherTrigger);
});

test('only supported local image data URLs are accepted and invalid sources never create a modal', t => {
  const fx = fixture(t);
  for (const mime of ['png', 'jpeg', 'jpg', 'webp', 'gif']) {
    const valid = `data:image/${mime};base64,aW1hZ2U=`;
    assert.equal(fx.open({ src: valid }), true, mime);
    assert.equal(fx.image().src, valid);
    fx.controller.close();
  }
  for (const invalid of ['', null, 'https://example.com/image.png', 'file:///C:/image.png',
    'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,aW1hZ2U=',
    'data:image/png;base64,', 'data:image/png;base64,aW1hZ2U=<script>']) {
    assert.equal(fx.open({ src: invalid }), false, String(invalid));
    assert.equal(fx.dialog(), undefined);
  }
});

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} vs ${expected}`);
function wheel(fx, deltaY, fields = {}) {
  const { x, y, width } = fx.document.viewportRect;
  return fx.fire(fx.viewport(), 'wheel', fx.image(), {
    clientX: x + width * 0.6, clientY: y + 180, deltaY, deltaMode: 0, ...fields,
  });
}
function pointer(fx, type, fields = {}) {
  return fx.fire(type === 'pointerdown' ? fx.viewport() : fx.document, type, fx.viewport(), {
    pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
    clientX: 320, clientY: 320, ...fields,
  });
}

test('loaded images fit the width, center short images and keep the top of long images readable', t => {
  const fx = fixture(t);
  fx.open();
  fx.load(1200, 800);
  const short = fx.geometry();
  near(short.width, 536, 'wide image fills available width');
  near(short.x, 12, 'horizontal margin');
  near(short.y, (760 - short.height) / 2, 'short image vertically centered');
  fx.open();
  fx.load(720, 3400);
  const long = fx.geometry();
  near(long.width, 536, 'long image remains readable rather than fitting its full height');
  near(long.y, 12, 'long image opens at its top');
  fx.open();
  fx.load(160, 120);
  const small = fx.geometry();
  near(small.scale, 1, 'small images are not enlarged on open');
  near(small.x, 200, 'small image centered horizontally');
  near(small.y, 320, 'small image centered vertically');
});

test('wheel zoom preserves the image point under the pointer and consumes native scrolling', t => {
  const fx = fixture(t);
  fx.open();
  fx.load(720, 3400);
  const before = fx.geometry();
  const anchor = { x: 560 * 0.6, y: 180 };
  const pixel = { x: (anchor.x - before.x) / before.scale, y: (anchor.y - before.y) / before.scale };
  const zoomIn = wheel(fx, -120);
  const after = fx.geometry();
  assert.equal(zoomIn.defaultPrevented, true);
  assert.ok(after.scale > before.scale);
  near((anchor.x - after.x) / after.scale, pixel.x, 'pointer x pixel preserved');
  near((anchor.y - after.y) / after.scale, pixel.y, 'pointer y pixel preserved');
  wheel(fx, 120);
  near(fx.geometry().scale, before.scale, 'opposite wheel restores zoom');
  near(fx.geometry().y, before.y, 'opposite wheel restores vertical view');
});

test('wheel line and page modes zoom in the requested direction and invalid or zero deltas do not corrupt geometry', t => {
  const fx = fixture(t);
  fx.open();
  fx.load(720, 3400);
  for (const [deltaMode, deltaY] of [[1, -3], [2, -1]]) {
    const before = fx.geometry().scale;
    wheel(fx, deltaY, { deltaMode });
    assert.ok(fx.geometry().scale > before, `deltaMode ${deltaMode} zooms in`);
  }
  const before = fx.geometry();
  for (const deltaY of [0, Number.NaN, Number.POSITIVE_INFINITY]) wheel(fx, deltaY);
  assert.deepEqual(fx.geometry(), before);
});

test('zoom limits are bounded and fit remains reachable for extremely wide images', t => {
  const fx = fixture(t);
  fx.open();
  fx.load(720, 3400);
  for (let i = 0; i < 40; i++) wheel(fx, -1000);
  near(fx.geometry().scale, 8, 'maximum zoom is 800%');
  assert.equal(fx.button('放大图片').disabled, true);
  for (let i = 0; i < 70; i++) wheel(fx, 1000);
  near(fx.geometry().scale, 0.1, 'minimum regular zoom is 10%');
  assert.equal(fx.button('缩小图片').disabled, true);
  fx.sizeButton().click();
  near(fx.geometry().width, 536, 'fit restores width and position');
  near(fx.geometry().y, 12, 'fit restores the top of a long image');
  fx.open();
  fx.load(10000, 600);
  const fit = fx.geometry().scale;
  assert.ok(fit < 0.1);
  wheel(fx, 1000);
  near(fx.geometry().scale, fit, 'fit remains the lower limit for an extremely wide image');
});

test('primary pointer drag pans and clamps the image, then releases without closing the modal', t => {
  const fx = fixture(t);
  fx.open();
  fx.load(1200, 1600);
  fx.sizeButton().click();
  const before = fx.geometry();
  pointer(fx, 'pointerdown');
  assert.equal(fx.viewport().hasPointerCapture(7), true);
  pointer(fx, 'pointermove', { clientX: 250, clientY: 220 });
  const moved = fx.geometry();
  near(moved.x, before.x - 70, 'horizontal drag follows pointer');
  near(moved.y, before.y - 100, 'vertical drag follows pointer');
  pointer(fx, 'pointermove', { clientX: -100000, clientY: -100000 });
  const edge = fx.geometry();
  near(edge.x + edge.width, 548, 'cannot drag past the far horizontal edge');
  near(edge.y + edge.height, 748, 'cannot drag past the far vertical edge');
  pointer(fx, 'pointerup', { buttons: 0 });
  assert.equal(fx.viewport().hasPointerCapture(7), false);
  const released = fx.geometry();
  pointer(fx, 'pointermove', { clientX: 200, clientY: 100 });
  assert.deepEqual(fx.geometry(), released);
  assert.equal(fx.dialog().open, true);
});

test('secondary buttons and additional pointers do not take over a drag; cancellation and blur end it', t => {
  const fx = fixture(t);
  fx.open();
  fx.load(1200, 1600);
  fx.sizeButton().click();
  for (const fields of [{ button: 2, buttons: 2 }, { pointerType: 'touch', isPrimary: false, pointerId: 9 }]) {
    const before = fx.geometry();
    pointer(fx, 'pointerdown', fields);
    pointer(fx, 'pointermove', { ...fields, clientX: 100, clientY: 100 });
    assert.deepEqual(fx.geometry(), before);
  }
  for (const end of ['pointercancel', 'lostpointercapture', 'blur']) {
    pointer(fx, 'pointerdown');
    const beforeOther = fx.geometry();
    pointer(fx, 'pointerdown', { pointerId: 8 });
    pointer(fx, 'pointermove', { pointerId: 8, clientX: 50, clientY: 50 });
    assert.deepEqual(fx.geometry(), beforeOther, 'another pointer must not change the active drag');
    if (end === 'blur') fx.document.defaultView.dispatchEvent(new Event('blur'));
    else pointer(fx, end);
    const beforeMove = fx.geometry();
    pointer(fx, 'pointermove', { clientX: 100, clientY: 100 });
    assert.deepEqual(fx.geometry(), beforeMove, `${end} ends dragging`);
  }
});

test('keyboard, double click and resize keep zoom and navigation usable without a mouse', t => {
  const fx = fixture(t);
  fx.open();
  fx.load(1200, 3000);
  const fit = fx.geometry().scale;
  fx.fire(fx.viewport(), 'keydown', fx.viewport(), { key: '+' });
  assert.ok(fx.geometry().scale > fit);
  fx.fire(fx.viewport(), 'keydown', fx.viewport(), { key: '0' });
  near(fx.geometry().scale, fit, 'zero restores fit');
  fx.fire(fx.viewport(), 'dblclick', fx.viewport(), { clientX: 292, clientY: 450 });
  near(fx.geometry().scale, 1, 'double click opens native pixels');
  const before = fx.geometry();
  fx.fire(fx.viewport(), 'keydown', fx.viewport(), { key: 'ArrowDown' });
  near(fx.geometry().y, before.y - 40, 'arrow key pans');
  fx.fire(fx.viewport(), 'keydown', fx.viewport(), { key: 'ArrowRight', shiftKey: true });
  near(fx.geometry().x, before.x - 120, 'shift arrow pans farther');
  const centerPixel = { x: (280 - fx.geometry().x) / fx.geometry().scale, y: (380 - fx.geometry().y) / fx.geometry().scale };
  fx.resize(620, 680);
  near(fx.geometry().scale, 1, 'manual zoom survives resize');
  near((310 - fx.geometry().x) / fx.geometry().scale, centerPixel.x, 'resizing preserves center x');
  near((340 - fx.geometry().y) / fx.geometry().scale, centerPixel.y, 'resizing preserves center y');
  fx.sizeButton().click();
  fx.resize(480, 700);
  near(fx.geometry().width, 456, 'fit mode follows new viewport width');
  near(fx.geometry().y, 12, 'fit mode resets long image to its top');
});

test('same-conversation redraw retains the view and stale load, resize and pointer events cannot affect a replacement', t => {
  const fx = fixture(t);
  fx.open();
  fx.load(1200, 1600);
  fx.sizeButton().click();
  pointer(fx, 'pointerdown');
  pointer(fx, 'pointermove', { clientX: 280, clientY: 250 });
  const before = fx.geometry();
  fx.controller.sync('conversation-a');
  assert.deepEqual(fx.geometry(), before);
  const oldImage = fx.image(), oldViewport = fx.viewport(), oldObservers = [...fx.observers];
  fx.open({ src: otherSource, conversationId: 'conversation-b' });
  fx.load(600, 400);
  const replacement = fx.geometry();
  assert.equal(oldViewport.hasPointerCapture(7), false, 'closing releases pointer capture');
  oldImage.dispatchEvent(new Event('load'));
  oldObservers.forEach(observer => observer.callback([{ target: oldViewport }]));
  fx.fire(oldViewport, 'pointermove', oldViewport, { pointerId: 7, clientX: 20, clientY: 20 });
  fx.fire(oldViewport, 'wheel', oldViewport, { deltaY: -500, clientX: 200, clientY: 200 });
  assert.deepEqual(fx.geometry(), replacement);
  assert.equal(fx.image().src, otherSource);
  assert.deepEqual(fx.errors, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingControls } from '../src/sidepanel/features/page-reading/reading-controls.js';

const firstUrl = 'https://example.test/article';
const secondUrl = 'https://other.test/dashboard';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Element extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.dataset = {};
    this.children = [];
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new Event('focus')); }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
}

function fixture(t, options = {}) {
  const ids = ['composer-reading-controls', 'composer-reading-depth', 'composer-reading-depth-label',
    'composer-reading-menu', 'composer-network-allowed', 'composer-network-label', 'composer-network-note'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const root = new Element();
  root.querySelector = selector => elements.get(selector.slice(1)) || null;
  const node = id => elements.get(`composer-${id}`);
  const modeItems = ['auto', 'basic', 'deep'].map(mode => {
    const item = new Element();
    item.dataset.readingMode = mode;
    item.ownerDocument = root;
    return item;
  });
  node('reading-menu').children = modeItems;
  node('reading-menu').querySelectorAll = () => modeItems;
  node('reading-depth').children = [node('reading-depth-label')];
  node('network-allowed').children = [node('network-label')];
  root.children = [...elements.values()];
  for (const element of elements.values()) element.ownerDocument = root;
  const changes = [], writes = [], errors = [], modes = [], reads = [], grants = [];
  const controller = createReadingControls({ root,
    getNetworkAllowed: async url => { reads.push(url); return options.get ? options.get(url) : false; },
    setNetworkAllowed: async (url, allowed) => { writes.push({ url, allowed }); return options.set?.(url, allowed); },
    onModeChange: mode => modes.push(mode),
    onNetworkChange: (allowed, target) => changes.push({ allowed, ...target }),
    onGrantState: value => grants.push(value),
    onError: error => errors.push(error),
    ...options.controller,
  });
  t.after(() => controller.dispose());
  const key = (element, value) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value });
    element.dispatchEvent(event);
    return event;
  };
  const open = () => node('reading-depth').dispatchEvent(new Event('click'));
  return { controller, node, root, changes, writes, errors, modes, reads, grants, modeItems, key, open,
    show: values => controller.update({ url: firstUrl, pageEnabled: true, ...values }),
    changeMode: mode => {
      if (!controller.snapshot().menuOpen) open();
      modeItems.find(item => item.dataset.readingMode === mode).dispatchEvent(new Event('click'));
    },
    clickNetwork: () => node('network-allowed').dispatchEvent(new Event('click')),
    pressed: () => node('network-allowed').getAttribute('aria-pressed') === 'true',
  };
}

test('reading controls only appear for readable page-mode questions and never enable reading themselves', async t => {
  const value = fixture(t);
  assert.equal(value.node('reading-controls').hidden, true);
  assert.equal(value.reads.length, 0);
  await value.show({ pageEnabled: false });
  await value.show({ agentMode: true });
  await value.show({ url: 'chrome://newtab' });
  assert.equal(value.node('reading-controls').hidden, true);
  assert.equal(value.reads.length, 0);
  await value.show();
  assert.equal(value.node('reading-controls').hidden, false);
  assert.equal(value.controller.getMode(), 'auto');
  assert.equal(value.controller.getNetworkAllowed(), false);
  assert.equal(value.reads.length, 1);
});

test('depth selection is local, survives page toggles and ignores busy or hidden changes', async t => {
  const value = fixture(t);
  await value.show();
  value.changeMode('deep');
  assert.equal(value.controller.getMode(), 'deep');
  assert.deepEqual(value.modes, ['deep']);
  await value.show({ busy: true });
  value.changeMode('basic');
  assert.equal(value.controller.getMode(), 'deep');
  assert.equal(value.node('reading-depth-label').textContent, '深入');
  await value.show({ pageEnabled: false });
  value.changeMode('basic');
  assert.equal(value.controller.getMode(), 'deep');
  await value.show();
  assert.equal(value.node('reading-depth-label').textContent, '深入');
  assert.equal(value.modes.length, 1);
  await value.show({ mode: 'basic' });
  assert.equal(value.controller.getMode(), 'basic');
});

test('custom mode selection sets the label and checked item, closes, and restores trigger focus', async t => {
  const value = fixture(t);
  await value.show();
  value.open();
  assert.equal(value.node('reading-menu').hidden, false);
  assert.equal(value.node('reading-depth').getAttribute('aria-haspopup'), 'menu');
  assert.equal(value.node('reading-depth').getAttribute('aria-expanded'), 'true');
  assert.equal(value.root.activeElement, value.modeItems[0]);
  value.changeMode('deep');
  assert.equal(value.node('reading-depth-label').textContent, '深入');
  assert.match(value.node('reading-depth').title, /深入.*结构/);
  assert.equal(value.node('reading-depth').dataset.tooltip, value.node('reading-depth').title);
  assert.equal(value.modeItems[2].getAttribute('aria-checked'), 'true');
  assert.equal(value.modeItems[0].getAttribute('aria-checked'), 'false');
  assert.equal(value.node('reading-menu').hidden, true);
  assert.equal(value.root.activeElement, value.node('reading-depth'));
  assert.deepEqual(value.modes, ['deep']);
  value.changeMode('deep');
  assert.deepEqual(value.modes, ['deep'], 'choosing the current mode only closes the menu');
});

test('keyboard mode navigation wraps and supports Home, End, Escape and normal Tab exit', async t => {
  const value = fixture(t);
  await value.show({ mode: 'deep' });
  value.key(value.node('reading-depth'), 'ArrowDown');
  assert.equal(value.root.activeElement, value.modeItems[0]);
  value.key(value.node('reading-menu'), 'ArrowUp');
  assert.equal(value.root.activeElement, value.modeItems[2]);
  value.key(value.node('reading-menu'), 'ArrowDown');
  assert.equal(value.root.activeElement, value.modeItems[0]);
  value.key(value.node('reading-menu'), 'End');
  assert.equal(value.root.activeElement, value.modeItems[2]);
  value.key(value.node('reading-menu'), 'Home');
  assert.equal(value.root.activeElement, value.modeItems[0]);
  const escape = value.key(value.node('reading-menu'), 'Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(value.node('reading-menu').hidden, true);
  assert.equal(value.root.activeElement, value.node('reading-depth'));
  value.key(value.node('reading-depth'), 'ArrowUp');
  assert.equal(value.root.activeElement, value.modeItems[2]);
  const tab = value.key(value.node('reading-menu'), 'Tab');
  assert.equal(tab.defaultPrevented, false, 'native Tab advances from the trigger to the next outside control');
  assert.equal(value.node('reading-menu').hidden, true);
  assert.equal(value.root.activeElement, value.node('reading-depth'));
  assert.equal(value.controller.getMode(), 'deep', 'moving menu focus does not change the selected mode');
  assert.equal(value.modes.length, 0);
});

test('outside clicks and focus close the menu without stealing focus, and navigation closes it', async t => {
  const value = fixture(t);
  await value.show();
  value.open();
  value.root.activeElement = value.node('network-allowed');
  value.root.dispatchEvent(new Event('pointerdown'));
  assert.equal(value.node('reading-menu').hidden, true);
  assert.equal(value.root.activeElement, value.node('network-allowed'));
  value.open();
  value.root.activeElement = value.node('network-allowed');
  value.root.dispatchEvent(new Event('focusin'));
  assert.equal(value.node('reading-menu').hidden, true);
  assert.equal(value.root.activeElement, value.node('network-allowed'));
  value.open();
  await value.show({ url: 'https://example.test/other' });
  assert.equal(value.node('reading-menu').hidden, true);
  value.open();
  await value.show({ url: 'https://example.test/other', busy: true });
  assert.equal(value.node('reading-menu').hidden, true);
});

test('local files support depth while hiding unsupported network settings', async t => {
  const value = fixture(t);
  await value.show({ url: 'file:///C:/example/article.html' });
  assert.equal(value.node('reading-controls').hidden, false);
  assert.equal(value.node('network-allowed').hidden, true);
  assert.equal(value.reads.length, 0);
});

test('late consent reads cannot enable a newly selected site', async t => {
  const old = deferred();
  const value = fixture(t, { get: url => url === firstUrl ? old.promise : false });
  const first = value.show();
  await tick();
  assert.equal(value.node('network-allowed').disabled, true);
  await value.show({ url: secondUrl });
  old.resolve(true);
  await first;
  await tick();
  assert.equal(value.controller.snapshot().origin, 'https://other.test');
  assert.equal(value.pressed(), false);
  assert.equal(value.node('network-allowed').disabled, false);
  assert.equal(value.controller.getNetworkAllowed(), false);
});

test('repeated same-origin rendering reuses the current permission read', async t => {
  const value = fixture(t, { get: async () => true });
  await value.show();
  await value.show({ url: 'https://example.test/other#section' });
  await value.show({ url: 'https://example.test/other#section', busy: true });
  assert.equal(value.reads.length, 1);
  assert.equal(value.pressed(), true);
  assert.equal(value.node('network-allowed').disabled, true);
  assert.equal(value.controller.getNetworkAllowed(), true);
});

test('network changes only report the fixed site after confirmed persistence', async t => {
  const write = deferred();
  const value = fixture(t, { set: () => write.promise });
  await value.show();
  value.clickNetwork();
  await tick();
  assert.equal(value.node('network-allowed').dataset.state, 'saving');
  assert.equal(value.controller.getNetworkAllowed(), false);
  value.clickNetwork();
  assert.equal(value.writes.length, 1);
  assert.equal(value.changes.length, 0);
  write.resolve();
  await tick();
  assert.equal(value.pressed(), true);
  assert.equal(value.node('network-allowed').dataset.state, 'enabled');
  assert.equal(value.node('network-allowed').classes.has('is-enabled'), true);
  assert.deepEqual(value.changes, [{ allowed: true, url: firstUrl, origin: 'https://example.test' }]);
});

test('interface button toggles the confirmed value in one click with accessible state and tooltip', async t => {
  const value = fixture(t);
  await value.show();
  assert.match(value.node('network-allowed').title, /已关闭.*开启/);
  value.clickNetwork();
  assert.equal(value.node('network-label').textContent, '保存中');
  assert.equal(value.node('network-allowed').getAttribute('aria-busy'), 'true');
  await tick();
  assert.equal(value.pressed(), true);
  assert.match(value.node('network-allowed').title, /已开启.*关闭/);
  assert.equal(value.node('network-allowed').dataset.tooltip, value.node('network-allowed').title);
  assert.equal(value.node('network-allowed').getAttribute('aria-busy'), 'false');
  value.clickNetwork();
  await tick();
  assert.deepEqual(value.writes, [{ url: firstUrl, allowed: true }, { url: firstUrl, allowed: false }]);
  assert.equal(value.pressed(), false);
});

test('a late save keeps its original site and cannot change a replacement site', async t => {
  const write = deferred();
  const value = fixture(t, { set: () => write.promise });
  await value.show();
  value.clickNetwork();
  await tick();
  await value.show({ url: secondUrl });
  write.resolve();
  await tick();
  assert.deepEqual(value.writes, [{ url: firstUrl, allowed: true }]);
  assert.equal(value.pressed(), false);
  assert.equal(value.changes.length, 0);
  assert.equal(value.errors.length, 0);
});

test('failed permission reads stay off and offer a real retry', async t => {
  let reads = 0;
  const value = fixture(t, { get: async () => {
    if (++reads === 1) throw new Error('读取设置失败');
    return true;
  } });
  await value.show();
  assert.equal(value.pressed(), false);
  assert.equal(value.node('network-allowed').disabled, false);
  assert.equal(value.node('network-label').textContent, '未确认');
  assert.match(value.node('network-note').textContent, /读取设置失败/);
  value.clickNetwork();
  await tick();
  assert.equal(value.pressed(), true);
  assert.equal(value.writes.length, 0, 'an unconfirmed state must be read before any toggle');
});

test('busy or hidden interface controls cannot toggle or retry unconfirmed settings', async t => {
  const value = fixture(t, { get: async () => { throw new Error('设置尚未确认'); } });
  await value.show();
  assert.equal(value.node('network-allowed').disabled, false);
  await value.show({ busy: true });
  value.clickNetwork();
  await tick();
  assert.equal(value.reads.length, 1);
  assert.equal(value.writes.length, 0);
  await value.show({ pageEnabled: false });
  value.clickNetwork();
  await tick();
  assert.equal(value.reads.length, 1);
  assert.equal(value.writes.length, 0);
});

test('closing and reopening the same page discards the former unconfirmed grant read', async t => {
  const old = deferred();
  let reads = 0;
  const value = fixture(t, { get: () => ++reads === 1 ? old.promise : false });
  const first = value.show();
  await tick();
  await value.show({ pageEnabled: false });
  await value.show();
  const count = value.grants.length;
  old.resolve(true);
  await first;
  await tick();
  assert.equal(value.grants.length, count);
  assert.equal(value.pressed(), false);
  assert.equal(value.grants.at(-1).confirmed, true);
  assert.equal(value.grants.at(-1).allowed, false);
});

test('timed-out consent writes remain unconfirmed until the setting is read again', async t => {
  const write = deferred();
  let persisted = false;
  const value = fixture(t, { get: () => persisted, set: () => write.promise,
    controller: { timeoutMs: 15 } });
  await value.show();
  value.clickNetwork();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(value.pressed(), false);
  assert.equal(value.node('network-allowed').disabled, false);
  assert.equal(value.node('network-label').textContent, '未确认');
  assert.match(value.node('network-note').textContent, /尚未确认/);
  persisted = true;
  write.resolve();
  await tick();
  assert.equal(value.pressed(), false);
  assert.equal(value.changes.length, 0);
  value.clickNetwork();
  await tick();
  assert.equal(value.pressed(), true);
  assert.equal(value.writes.length, 1, 'rechecking does not blindly invert a possibly completed write');
});

test('a stalled settings read times out and does not keep the depth selector disabled', async t => {
  const value = fixture(t, { get: () => new Promise(() => {}), controller: { timeoutMs: 15 } });
  await value.show();
  assert.equal(value.node('reading-depth').disabled, false);
  assert.equal(value.node('network-allowed').disabled, false);
  assert.match(value.node('network-note').textContent, /超时/);
});

test('grant publication only exposes confirmed current-site settings and deduplicates ordinary paints', async t => {
  const firstRead = deferred();
  const value = fixture(t, { get: url => url === firstUrl ? firstRead.promise : true });
  const read = value.show();
  await tick();
  assert.deepEqual(value.grants.at(-1), { url: firstUrl, origin: 'https://example.test', allowed: false, confirmed: false });
  await value.show({ url: secondUrl });
  assert.deepEqual(value.grants.at(-1), { url: secondUrl, origin: 'https://other.test', allowed: true, confirmed: true });
  const count = value.grants.length;
  await value.show({ url: secondUrl, busy: true });
  assert.equal(value.grants.length, count);
  firstRead.resolve(true);
  await read;
  await tick();
  assert.equal(value.grants.length, count);
  await value.show({ url: secondUrl, pageEnabled: false });
  assert.deepEqual(value.grants.at(-1), { url: secondUrl, origin: 'https://other.test', allowed: false, confirmed: false });
});

test('pending or uncertain writes revoke the published snapshot until fresh confirmation', async t => {
  const write = deferred();
  const value = fixture(t, { get: () => true, set: () => write.promise, controller: { timeoutMs: 15 } });
  await value.show();
  assert.equal(value.grants.at(-1).allowed, true);
  value.clickNetwork();
  assert.equal(value.controller.getNetworkAllowed(), false);
  assert.equal(value.grants.at(-1).confirmed, false);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(value.grants.at(-1).confirmed, false);
  write.resolve();
  await tick();
  assert.equal(value.grants.at(-1).confirmed, false);
  await value.controller.refresh();
  assert.equal(value.grants.at(-1).confirmed, true);
  value.controller.dispose();
  assert.equal(value.grants.at(-1).allowed, false);
  assert.equal(value.grants.at(-1).confirmed, false);
});

test('disposal closes the menu, removes listeners and rejects late effects', async t => {
  const pending = deferred();
  const value = fixture(t, { get: () => pending.promise });
  const read = value.show();
  await tick();
  value.open();
  assert.equal(value.node('reading-menu').hidden, false);
  value.controller.dispose();
  pending.resolve(true);
  await read;
  await tick();
  value.changeMode('deep');
  value.clickNetwork();
  assert.equal(value.node('reading-controls').hidden, true);
  assert.equal(value.node('reading-menu').hidden, true);
  assert.equal(value.controller.getMode(), 'auto');
  assert.equal(value.controller.getNetworkAllowed(), false);
  assert.equal(value.errors.length, 0);
  assert.equal(value.writes.length, 0);
});

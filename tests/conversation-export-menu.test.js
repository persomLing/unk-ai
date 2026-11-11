import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationExportMenu } from '../src/sidepanel/features/export/export-menu.js';

class Element extends EventTarget {
  constructor(document, kind) { super(); this.ownerDocument = document; this.dataset = { conversationExport: kind }; this.style = {}; this.attributes = {}; this.disabled = false; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.ownerDocument.activeElement = this; }
  contains(target) { return target === this || this.children?.includes(target); }
  getBoundingClientRect() { return this.children ? { width: 244, height: 136 } : { right: 310, bottom: 42 }; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function fixture(t, initial = {}, onSelect) {
  const document = new EventTarget();
  document.defaultView = Object.assign(new EventTarget(), { innerWidth: 360, innerHeight: 740 });
  document.body = { append: menu => { menu.parentNode = document.body; } };
  const button = new Element(document);
  const menu = new Element(document); menu.hidden = true;
  const options = ['document', 'markdown', 'diagnostics'].map(kind => new Element(document, kind));
  menu.children = options; menu.querySelectorAll = () => options;
  let state = { conversationId: 'normal-chat', hasTurns: true, diagnosticBusy: false, ...initial };
  const selected = [], notices = [];
  const controller = createConversationExportMenu({ document, button, menu, getState: () => state,
    onSelect: (...args) => { selected.push(args); return onSelect?.(...args); }, notify: (...args) => notices.push(args) });
  t.after(() => controller.dispose());
  const key = (key, target = document.activeElement) => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key }); Object.defineProperty(event, 'target', { value: target });
    document.dispatchEvent(event);
  };
  return { document, button, menu, options, controller, selected, notices, key,
    option: kind => options.find(option => option.dataset.conversationExport === kind),
    update: patch => { state = { ...state, ...patch }; } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('ordinary conversations expose diagnostics and keep the original header trigger for document export', t => {
  const fx = fixture(t);
  fx.button.click();
  assert.equal(fx.menu.hidden, false);
  assert.equal(fx.menu.parentNode, fx.document.body);
  assert.equal(fx.button.attributes['aria-expanded'], 'true');
  fx.option('diagnostics').click();
  assert.deepEqual(fx.selected[0], ['diagnostics', 'normal-chat', fx.button]);
  assert.equal(fx.menu.hidden, true);
  fx.option('diagnostics').click();
  assert.equal(fx.selected.length, 1, 'hidden old menu clicks cannot submit twice');
  fx.button.click(); fx.options[0].click();
  assert.deepEqual(fx.selected[1], ['document', 'normal-chat', fx.button]);
});

test('a conversation without user turns can export diagnostics; diagnostic busy blocks only that option', t => {
  const fx = fixture(t, { hasTurns: false });
  fx.button.click();
  assert.equal(fx.options[0].disabled, true);
  assert.equal(fx.option('markdown').disabled, true);
  assert.equal(fx.option('diagnostics').disabled, false);
  assert.equal(fx.document.activeElement, fx.option('diagnostics'));
  fx.update({ diagnosticBusy: true }); fx.option('diagnostics').click();
  assert.equal(fx.selected.length, 0);
  fx.key('Escape'); fx.update({ hasTurns: true }); fx.button.click();
  assert.equal(fx.options[0].disabled, false);
  assert.equal(fx.option('markdown').disabled, false);
  assert.equal(fx.option('diagnostics').disabled, true);
});

test('switching conversations invalidates an open menu rather than exporting the new chat by mistake', t => {
  const fx = fixture(t);
  fx.button.click(); fx.update({ conversationId: 'other' }); fx.option('diagnostics').click();
  assert.equal(fx.selected.length, 0);
  assert.equal(fx.menu.hidden, true);
  assert.match(fx.notices[0][0], /对话已切换/);
  fx.button.click(); fx.controller.sync('third');
  assert.equal(fx.menu.hidden, true);
});

test('menu supports arrow navigation, Escape focus restoration and cleanup', t => {
  const fx = fixture(t);
  fx.button.click(); fx.key('ArrowDown');
  assert.equal(fx.document.activeElement, fx.option('markdown'));
  fx.key('ArrowDown'); assert.equal(fx.document.activeElement, fx.option('diagnostics'));
  fx.key('Home'); assert.equal(fx.document.activeElement, fx.options[0]);
  fx.key('Escape'); assert.equal(fx.document.activeElement, fx.button);
  assert.equal(fx.button.attributes['aria-expanded'], 'false');
  fx.controller.dispose(); fx.button.click();
  assert.equal(fx.menu.hidden, true);
});

test('Markdown reuses selection with fixed conversation ownership and blocks duplicate saves', async t => {
  const first = deferred();
  const fx = fixture(t, {}, kind => kind === 'markdown' ? first.promise : undefined);
  fx.button.click(); fx.option('markdown').click();
  assert.equal(fx.menu.hidden, true);
  const [kind, id, trigger, operation] = fx.selected[0];
  assert.deepEqual([kind, id, trigger], ['markdown', 'normal-chat', fx.button]);
  assert.equal(operation.signal.aborted, false);
  assert.equal(operation.isCurrent(), true);
  fx.option('markdown').click();
  fx.button.click();
  assert.equal(fx.option('markdown').disabled, true);
  assert.equal(fx.option('document').disabled, false);
  assert.equal(fx.option('diagnostics').disabled, false);
  fx.option('markdown').click();
  assert.equal(fx.selected.length, 1);
  fx.key('Escape');
  assert.equal(operation.signal.aborted, false, 'closing the menu does not undo an issued browser save');
  fx.button.click();
  assert.equal(fx.option('markdown').disabled, true);
  first.resolve(); await flush();
  assert.equal(fx.menu.hidden, false);
  assert.equal(fx.option('markdown').disabled, false);
  assert.equal(operation.isCurrent(), false);
});

test('switching conversations cancels Markdown and late completion cannot unlock a new save', async t => {
  const first = deferred(), second = deferred();
  const fx = fixture(t, {}, (_kind, id) => id === 'normal-chat' ? first.promise : second.promise);
  fx.button.click(); fx.option('markdown').click();
  const original = fx.selected[0][3];
  fx.update({ conversationId: 'other-chat' }); fx.controller.sync('other-chat');
  assert.equal(original.signal.aborted, true);
  assert.equal(original.isCurrent(), false);
  fx.button.click(); fx.option('markdown').click();
  const current = fx.selected[1][3];
  assert.equal(current.isCurrent(), true);
  first.reject(new Error('old download failed')); await flush();
  assert.deepEqual(fx.notices, [], 'old errors do not appear in the new conversation');
  fx.button.click();
  assert.equal(fx.option('markdown').disabled, true, 'old finally does not clear the new lock');
  assert.equal(current.signal.aborted, false);
  second.resolve(); await flush();
});

test('Markdown ownership notices a changed conversation before explicit sync and disposal cancels waits', async t => {
  const pending = deferred();
  const fx = fixture(t, {}, () => pending.promise);
  fx.button.click(); fx.option('markdown').click();
  const original = fx.selected[0][3];
  fx.update({ conversationId: 'other-chat' });
  assert.equal(original.isCurrent(), false);
  fx.controller.dispose();
  assert.equal(original.signal.aborted, true);
  pending.reject(new Error('late disposal failure')); await flush();
  assert.deepEqual(fx.notices, []);
  fx.button.click(); assert.equal(fx.menu.hidden, true);
});

test('Markdown callback failure releases its lock and reports once', async t => {
  let fail = true;
  const fx = fixture(t, {}, () => { if (fail) throw new Error('save failed'); });
  fx.button.click(); fx.option('markdown').click(); await flush();
  assert.deepEqual(fx.notices, [['导出未完成，请重试。', 'error']]);
  fail = false;
  fx.button.click(); assert.equal(fx.option('markdown').disabled, false);
  fx.option('markdown').click(); await flush();
  assert.equal(fx.selected.length, 2);
  assert.equal(fx.notices.length, 1);
});

test('Markdown preserves the existing busy block while other menu entries keep their own availability', t => {
  const fx = fixture(t, { markdownBlocked: true });
  fx.button.click();
  assert.equal(fx.option('markdown').disabled, true);
  assert.equal(fx.option('document').disabled, false);
  assert.equal(fx.option('diagnostics').disabled, false);
  fx.option('markdown').dispatchEvent(new Event('click'));
  assert.equal(fx.selected.length, 0, 'synthetic clicks cannot bypass live busy state');
  fx.update({ markdownBlocked: false }); fx.controller.sync('normal-chat');
  assert.equal(fx.option('markdown').disabled, false);
});

test('an open menu synchronizes live busy changes and moves focus off a newly disabled entry', t => {
  const fx = fixture(t);
  fx.button.click(); fx.key('ArrowDown');
  assert.equal(fx.document.activeElement, fx.option('markdown'));
  fx.update({ markdownBlocked: true, diagnosticBusy: true }); fx.controller.sync('normal-chat');
  assert.equal(fx.option('markdown').disabled, true);
  assert.equal(fx.option('diagnostics').disabled, true);
  assert.equal(fx.document.activeElement, fx.option('document'));
  assert.equal(fx.option('markdown').tabIndex, -1);
  fx.update({ markdownBlocked: false, diagnosticBusy: false }); fx.controller.sync('normal-chat');
  assert.equal(fx.option('markdown').disabled, false);
  assert.equal(fx.option('diagnostics').disabled, false);
});

test('finishing a pending Markdown save cannot override a newer generation busy block', async t => {
  const pending = deferred();
  const fx = fixture(t, {}, () => pending.promise);
  fx.button.click(); fx.option('markdown').click();
  fx.button.click();
  fx.update({ markdownBlocked: true }); fx.controller.sync('normal-chat');
  pending.resolve(); await flush();
  assert.equal(fx.menu.hidden, false);
  assert.equal(fx.option('markdown').disabled, true);
  assert.equal(fx.option('document').disabled, false);
  assert.equal(fx.option('diagnostics').disabled, false);
  fx.update({ markdownBlocked: false }); fx.controller.sync('normal-chat');
  assert.equal(fx.option('markdown').disabled, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { awaitWithTimeout } from '../src/utils/abortable.js';

const source = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
function section(begin, end) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, `missing UI section: ${begin}`);
  return source.slice(start, finish);
}
// Only the entry's UI initialization and event subscription run in this VM.
// Conversation, retry, model and persistence services have direct-import tests.
const themeSource = section('async function initTheme(signal)', 'function applyTheme(theme)');
const startupSource = section('const startupController = new AbortController();', 'function startSelectionSync()');
const subscriptionSource = section('let replyPaintPending = false;', 'function updateStreamingMessage(');
const composerClickSource = section("sendButton.addEventListener('click',", "$('#attach-menu').addEventListener('click',");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};
const folder = { configured: false, granted: false };
const config = { models: [{ id: 'test-model' }] };
const interrupted = () => ({ id: 'interrupted', messages: [{ id: 'answer', status: 'streaming' }] });

function bootFixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const calls = [], themes = [], notices = [], ui = [], handlers = new Map();
  const state = { ready: false, conversation: null, saveQueue: Promise.resolve() };
  const defaults = {
    initializeConversationSync: () => undefined,
    sessionGet: () => ({ pageSelection: null }),
    getDirectoryInfo: () => folder,
    migrateLegacyConversations: () => undefined,
    getProviderConfig: () => config,
    listSavedConversations: () => [],
    loadTemporaryConversation: () => null,
    loadConversation: () => null,
    saveCurrent: () => undefined,
    themeGet: () => ({ theme: 'dark' }),
    refreshHistory: () => undefined,
    restoreAgent: () => undefined,
  };
  const ports = Object.fromEntries(Object.entries(defaults).map(([name, implementation]) => [name, (...args) => {
    calls.push(name);
    return (overrides[name] || implementation)(...args);
  }]));
  const context = vm.createContext({
    ...ports, state, Date, AbortController, DOMException, structuredClone, awaitWithTimeout,
    chrome: { storage: { session: { get: ports.sessionGet }, local: { get: ports.themeGet } } },
    window: { addEventListener: (name, callback) => handlers.set(name, callback) },
    composerPageToggle: {}, input: {},
    applyTheme: theme => themes.push(theme),
    setPageSelection: () => ui.push('selection'),
    renderWelcomePrompts: () => ui.push('welcome'),
    renderConversation: () => ui.push('conversation'),
    startSelectionSync: () => ui.push('selection-sync'),
    watchSelectionInteractions: () => ui.push('selection-watch'),
    settleInterruptedReply: noop,
    normalizeDuplicateRetryTurns: messages => messages,
    normalizeProviderConfig: value => value,
    scheduleSave: noop,
    agentSlot: { restore: ports.restoreAgent },
    toast: (message, kind) => notices.push({ message, kind }),
    application: { dispose: () => ui.push('application-disposed') },
    composition: { dispose: () => ui.push('composition-disposed') },
    readingControls: { dispose: noop },
    enhancePageReading: { dispose: noop },
    networkReadingClient: { dispose: noop },
    diagnosticExporter: { dispose: () => ui.push('diagnostic-export-disposed') },
    conversationExportMenu: { dispose: noop },
    imagePreview: { dispose: () => ui.push('image-preview-disposed') },
    textPreview: { dispose: () => ui.push('text-preview-disposed') },
    pastedText: { dispose: () => ui.push('pasted-text-disposed') },
    removeRuntimeDiagnostics: () => ui.push('diagnostic-listeners-removed'),
    flushDiagnostics: () => new Promise(() => {}),
    turnNavigator: { dispose: () => ui.push('turn-navigator-disposed') },
    conversationSaver: { flush: () => ui.push('saves-flushed') },
    clearInterval: noop,
    find: (values, predicate) => values?.find(predicate),
    now: () => 'now',
    saveConversationByStorage: async () => undefined,
  });
  vm.runInContext(`${themeSource}\n${startupSource}\nglobalThis.boot = { initialize, startupController };`, context);
  let settled = false;
  return {
    state, calls, themes, notices, ui, context,
    get settled() { return settled; },
    start: () => context.boot.initialize().then(() => { settled = true; }),
    hide: () => handlers.get('pagehide')(),
  };
}

test('a rejected theme read falls back to light and does not block sidepanel startup', { timeout: 1000 }, async t => {
  const fx = bootFixture(t, { themeGet: async () => { throw new Error('Storage unavailable'); } });
  await fx.start();
  assert.equal(fx.state.ready, true);
  assert.deepEqual(fx.themes, ['light']);
  assert.ok(fx.calls.includes('restoreAgent'));
  assert.ok(fx.ui.includes('selection-sync'));
  assert.deepEqual(fx.notices, []);
});

test('a hung theme read releases startup after two seconds and cannot apply a late theme', { timeout: 1000 }, async t => {
  const late = deferred();
  const fx = bootFixture(t, { themeGet: () => late.promise });
  const pending = fx.start();
  await tick();
  assert.ok(fx.calls.includes('themeGet'));
  assert.equal(fx.state.ready, false);
  t.mock.timers.tick(1999);
  await tick();
  assert.equal(fx.settled, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(fx.state.ready, true);
  assert.deepEqual(fx.themes, ['light']);
  assert.deepEqual(fx.notices, []);
  late.resolve({ theme: 'dark' });
  await tick();
  assert.deepEqual(fx.themes, ['light']);
});

const stages = [
  { port: 'initializeConversationSync', label: '初始化会话同步' },
  { port: 'sessionGet', label: '读取选区', value: { pageSelection: null } },
  { port: 'getDirectoryInfo', label: '读取文件夹状态', value: folder },
  { port: 'migrateLegacyConversations', label: '兼容旧会话', setup: { getDirectoryInfo: () => ({ configured: true, granted: true }) } },
  { port: 'getProviderConfig', label: '读取模型配置', value: config },
  { port: 'listSavedConversations', label: '读取会话目录', value: [] },
  { port: 'loadTemporaryConversation', label: '读取临时会话', value: null },
  { port: 'loadConversation', label: '恢复会话', value: null, setup: { listSavedConversations: () => [{ id: 'saved' }] } },
  { port: 'saveCurrent', scenario: 'temporary recovery', label: '保存恢复后的会话', setup: { loadTemporaryConversation: interrupted } },
  { port: 'saveCurrent', scenario: 'saved recovery', label: '保存恢复后的会话', setup: {
    listSavedConversations: () => [{ id: 'saved' }], loadConversation: interrupted,
  } },
  { port: 'refreshHistory', label: '刷新会话目录', readyDuringWait: true },
  { port: 'restoreAgent', label: '恢复浏览器任务', readyDuringWait: true },
];
for (const stage of stages) {
  test(`startup bounds a hung ${stage.port}${stage.scenario ? ` (${stage.scenario})` : ''} to thirty seconds`, { timeout: 1000 }, async t => {
    const late = deferred();
    const fx = bootFixture(t, { ...stage.setup, [stage.port]: () => late.promise });
    const pending = fx.start();
    await tick();
    assert.ok(fx.calls.includes(stage.port));
    assert.equal(fx.state.ready, Boolean(stage.readyDuringWait));
    t.mock.timers.tick(29999);
    await tick();
    assert.equal(fx.settled, false);
    assert.deepEqual(fx.notices, []);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(fx.notices.length, 1);
    assert.equal(fx.notices[0].kind, 'error');
    assert.match(fx.notices[0].message, new RegExp(`${stage.label}超时`));
    const callsAtTimeout = [...fx.calls];
    const uiAtTimeout = [...fx.ui];
    late.resolve(stage.value);
    await tick();
    assert.deepEqual(fx.calls, callsAtTimeout, 'late I/O must not resume the remaining startup stages');
    assert.deepEqual(fx.ui, uiAtTimeout);
    assert.equal(fx.state.ready, Boolean(stage.readyDuringWait));
  });
}

test('startup stages share one thirty-second deadline instead of each receiving a new budget', { timeout: 1000 }, async t => {
  const sync = deferred(), provider = deferred();
  const fx = bootFixture(t, { initializeConversationSync: () => sync.promise, getProviderConfig: () => provider.promise });
  const pending = fx.start();
  t.mock.timers.tick(18000);
  sync.resolve();
  await tick();
  assert.ok(fx.calls.includes('getProviderConfig'));
  t.mock.timers.tick(11999);
  await tick();
  assert.equal(fx.settled, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(Date.now(), 30000);
  assert.match(fx.notices[0].message, /读取模型配置超时/);
  assert.equal(fx.state.ready, false);
  provider.reject(new Error('Late provider failure'));
  await tick(); // A rejected late browser/storage promise must still be observed.
});

for (const port of ['getProviderConfig', 'themeGet']) {
  test(`pagehide cancels startup waiting for ${port} and a late result cannot set ready`, { timeout: 1000 }, async t => {
    const late = deferred();
    const fx = bootFixture(t, { [port]: () => late.promise });
    const pending = fx.start();
    await tick();
    assert.ok(fx.calls.includes(port));
    fx.hide();
    await pending;
    assert.equal(fx.context.boot.startupController.signal.aborted, true);
    assert.equal(fx.state.ready, false);
    assert.equal(fx.ui.filter(value => value === 'application-disposed').length, 1);
    assert.equal(fx.ui.filter(value => value === 'composition-disposed').length, 1);
    assert.equal(fx.ui.filter(value => value === 'image-preview-disposed').length, 1);
    assert.equal(fx.ui.filter(value => value === 'text-preview-disposed').length, 1);
    assert.equal(fx.ui.filter(value => value === 'pasted-text-disposed').length, 1);
    assert.equal(fx.ui.filter(value => value === 'saves-flushed').length, 1);
    assert.deepEqual(fx.themes, []);
    assert.deepEqual(fx.notices, []);
    const callsAtHide = [...fx.calls];
    late.resolve(port === 'themeGet' ? { theme: 'dark' } : config);
    await tick();
    assert.equal(fx.state.ready, false);
    assert.deepEqual(fx.themes, []);
    assert.deepEqual(fx.calls, callsAtHide);
    assert.equal(fx.ui.includes('welcome'), false);
    assert.equal(fx.ui.includes('selection-sync'), false);
  });
}

function paintFixture() {
  const frames = [], paints = [], contexts = [];
  const state = { conversation: { id: 'first', messages: [] }, followToPage: true };
  let subscriber;
  const context = vm.createContext({
    state, application: { subscribe: handler => { subscriber = handler; } },
    requestAnimationFrame: callback => frames.push(callback),
    updateStreamingMessage: id => paints.push({ id, runId: state.conversation.messages.find(message => message.id === id)?.runId }),
    turnNavigator: { scheduleLayout: () => {} },
    refreshContextUsage: value => contexts.push(value),
  });
  vm.runInContext(subscriptionSource, context);
  const message = (runId, assistantId = 'answer') => ({ id: assistantId, runId, content: `${runId} first chunk` });
  return {
    state, frames, paints, contexts, message,
    emit: (runId, conversationId = state.conversation.id, assistantId = 'answer') => subscriber({
      type: 'run:message', runId, conversationId, assistantId,
    }),
    flush: () => { assert.ok(frames.length > 0, 'a frame must be scheduled'); frames.shift()(); },
  };
}

for (const switchConversation of [false, true]) {
  test(`a pending frame paints the new run's first chunk after ${switchConversation ? 'switching conversations' : 'retrying the same assistant'}`, () => {
    const fx = paintFixture();
    fx.state.conversation.messages = [fx.message('old-run')];
    fx.emit('old-run');
    fx.state.conversation = { id: switchConversation ? 'second' : 'first', messages: [fx.message('new-run')] };
    fx.emit('new-run');
    assert.equal(fx.frames.length, 1, 'updates within a frame should still be coalesced');
    fx.flush();
    assert.deepEqual(fx.paints, [{ id: 'answer', runId: 'new-run' }]);
    assert.equal(fx.contexts.length, 1);
    assert.equal(fx.contexts[0].beforeAssistantId, 'answer');
    fx.emit('new-run');
    fx.flush();
    assert.equal(fx.paints.length, 2, 'the consumed frame must release the pending-paint latch');
  });
}

test('a stale frame cannot paint a replacement run that reuses the same assistant id', () => {
  const fx = paintFixture();
  fx.state.conversation.messages = [fx.message('old-run')];
  fx.emit('old-run');
  fx.state.conversation.messages = [fx.message('new-run')];
  fx.flush();
  assert.deepEqual(fx.paints, []);
  assert.deepEqual(fx.contexts, []);
  fx.emit('new-run');
  fx.flush();
  assert.deepEqual(fx.paints, [{ id: 'answer', runId: 'new-run' }]);
});

function composerClickFixture(agentBusy, restartPending = false) {
  const handlers = new Map(), calls = [];
  const button = name => ({ addEventListener: (type, handler) => {
    assert.equal(type, 'click');
    handlers.set(name, handler);
  } });
  const context = vm.createContext({
    sendButton: button('send'), stopButton: button('stop'),
    sendMessage: () => calls.push('send'),
    stopActiveReply: () => calls.push('chat-stop'),
    updateComposer: () => calls.push('composer'),
    renderConversation: () => calls.push('conversation'),
    agentSlot: { isBusy: () => agentBusy, stop: reason => { calls.push(`agent-stop:${reason}`); } },
    agentTaskRestart: { isPending: () => restartPending, cancel: () => { calls.push('restart-cancel'); } },
  });
  vm.runInContext(composerClickSource, context);
  return { calls, click: (name, detail) => handlers.get(name)({ detail }) };
}

test('Stop cancels a suspended task restart before cancelling the submission wait', () => {
  const fx = composerClickFixture(false, true);
  fx.click('stop', 1);
  assert.deepEqual(fx.calls, ['restart-cancel', 'chat-stop', 'composer', 'conversation']);
});

for (const agentBusy of [false, true]) {
  const mode = agentBusy ? 'Agent' : 'chat';
  const stopCalls = agentBusy ? ['agent-stop:user'] : ['chat-stop', 'composer', 'conversation'];

  test(`${mode} ignores the second send click landing on Stop while a subsequent single click still stops`, () => {
    const fx = composerClickFixture(agentBusy);
    fx.click('send', 1);
    // Real Chrome dispatches detail=2 to the newly shown Stop at the same position.
    fx.click('stop', 2);
    assert.deepEqual(fx.calls, ['send'], 'a send double-click must not cancel the just-started reply');
    fx.click('stop', 1);
    assert.deepEqual(fx.calls, ['send', ...stopCalls], 'a new single-click gesture must still stop immediately');
  });

  test(`${mode} keeps keyboard Stop activation with detail zero available`, () => {
    const fx = composerClickFixture(agentBusy);
    fx.click('send', 0);
    fx.click('stop', 0);
    assert.deepEqual(fx.calls, ['send', ...stopCalls]);
  });
}

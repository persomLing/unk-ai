import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNetworkReadingService,
  createPageDebuggerCoordinator,
  withPageDebugger,
  NETWORK_READING_PORT,
} from '../src/background/network-reading-service.js';
import { NETWORK_READING_SETTINGS_KEY } from '../src/utils/network-reading.js';

function event() {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), emit: (...args) => { for (const listener of listeners) listener(...args); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function setup(t, options = {}) {
  const state = { tab: { id: 1, url: 'https://a.test/page', documentId: 'doc-a' }, allowed: true, attached: 0, detached: 0, commands: [], bodies: new Map(), sends: [] };
  const sender = { id: 'test-id', url: 'chrome-extension://test-id/src/sidepanel/index.html', documentId: 'panel-a' };
  const chrome = {
    runtime: { id: sender.id, getURL: path => `chrome-extension://test-id/${path}`, onConnect: event() },
    storage: {
      onChanged: event(),
      local: { get: async () => ({ [NETWORK_READING_SETTINGS_KEY]: { version: 1, origins: { 'https://a.test': { allowed: state.allowed } } } }) },
    },
    tabs: { onUpdated: event(), onRemoved: event(), get: async () => ({ ...state.tab }) },
    scripting: { executeScript: async ({ target }) => {
      if (target.documentIds[0] !== state.tab.documentId) throw Object.assign(new Error('Document changed'), { code: 'PAGE_CHANGED' });
      return [{ frameId: 0, documentId: state.tab.documentId, result: { url: state.tab.url } }];
    } },
    debugger: {
      onEvent: event(), onDetach: event(),
      attach: async () => { state.attached += 1; },
      detach: async target => { state.detached += 1; chrome.debugger.onDetach.emit(target); },
      sendCommand: async (target, method, args) => {
        state.commands.push({ target, method, args });
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a', loaderId: state.tab.documentId, url: state.tab.url } } };
        if (method === 'Network.getResponseBody') return { body: state.bodies.get(args.requestId), base64Encoded: false };
        return {};
      },
    },
  };
  const coordinator = createPageDebuggerCoordinator(chrome, { attachTimeoutMs: 20, detachTimeoutMs: 10 });
  const service = createNetworkReadingService({ chrome, coordinator, durationMs: 5000, ioTimeoutMs: 100, ...options });
  const message = { sessionId: 'session-aaaaaaaa', cancelToken: 'token-aaaaaaaa', tabId: 1, expectedUrl: state.tab.url, documentId: state.tab.documentId };
  function bind(input = message, owner = sender) {
    const port = { name: NETWORK_READING_PORT, sender: owner, onMessage: event(), onDisconnect: event(), disconnected: false,
      postMessage: payload => state.sends.push(payload),
      disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } },
    };
    chrome.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'NETWORK_READING_BIND', sessionId: input.sessionId, cancelToken: input.cancelToken });
    return port;
  }
  function response(id, data, overrides = {}) {
    state.bodies.set(id, typeof data === 'string' ? data : JSON.stringify(data));
    chrome.debugger.onEvent.emit({ tabId: 1 }, 'Network.responseReceived', {
      requestId: id, type: 'Fetch', frameId: 'frame-a', loaderId: state.tab.documentId,
      response: { url: 'https://a.test/api/list?token=private', mimeType: 'application/json', status: 200, ...overrides.response }, ...overrides,
    });
    chrome.debugger.onEvent.emit({ tabId: 1 }, 'Network.loadingFinished', { requestId: id, encodedDataLength: 20 });
  }
  async function flush() { for (let index = 0; index < 12; index += 1) await tick(); }
  t.after(() => service.dispose());
  return { state, chrome, sender, coordinator, service, message, bind, response, flush };
}

test('only a bound sidepanel can start and network permission defaults to denial', async t => {
  const fixture = setup(t);
  const { service, message, sender, state, bind } = fixture;
  await assert.rejects(service.start(message, { ...sender, tab: { id: 1 } }), { code: 'NETWORK_SENDER_DENIED' });
  await assert.rejects(service.start(message, { ...sender, url: 'chrome-extension://test-id/src/options/index.html' }), { code: 'NETWORK_SENDER_DENIED' });
  await assert.rejects(service.start(message, sender), { code: 'NETWORK_PORT_REQUIRED' });
  bind(); state.allowed = false;
  await assert.rejects(service.start(message, sender), { code: 'NETWORK_PERMISSION_DENIED' });
  assert.equal(state.attached, 0);
});

test('captures only same-origin main-document Fetch/XHR JSON and returns sanitized bounded evidence', async t => {
  const { service, message, sender, state, bind, response, flush } = setup(t);
  bind(); await service.start(message, sender);
  response('ok', { label: 'price', value: 42, email: 'private@example.test', accessToken: 'secret-token' });
  response('cross', { value: 99 }, { response: { url: 'https://other.test/data', mimeType: 'application/json' } });
  response('frame', { value: 98 }, { frameId: 'other-frame' });
  response('html', { value: 97 }, { response: { url: 'https://a.test/login', mimeType: 'text/html' } });
  response('image', { value: 96 }, { type: 'Image' });
  await flush();
  const result = await service.read(message, sender);
  assert.equal(result.records.length, 1);
  assert.match(result.records[0].text, /42/);
  assert.doesNotMatch(result.records[0].text, /secret-token|private@example/);
  assert.equal(result.records[0].sourceUrl, 'https://a.test/api/list');
  assert.equal(result.missedEarlierRequests, true);
  assert.deepEqual(state.commands.filter(command => command.method === 'Network.getResponseBody').map(command => command.args.requestId), ['ok']);
  assert.ok(state.commands.every(command => !/requestPostData|replay|Fetch\./.test(command.method)));
});

test('duplicate completion events cannot add a second record and response count stays bounded', async t => {
  const { service, message, sender, state, chrome, bind, response, flush } = setup(t);
  bind(); await service.start(message, sender);
  response('same', { value: 1 });
  chrome.debugger.onEvent.emit({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'same' });
  for (let i = 0; i < 12; i += 1) response(`r${i}`, { value: i });
  await flush();
  const result = await service.read(message, sender);
  assert.equal(result.records.length, 6);
  assert.equal(state.commands.filter(command => command.method === 'Network.getResponseBody' && command.args.requestId === 'same').length, 1);
  assert.equal(result.truncated, true);
});

test('changing or reloading the original document cancels capture even at the same URL', async t => {
  const { service, message, sender, state, chrome, bind, response, flush } = setup(t);
  bind(); await service.start(message, sender);
  response('before', { value: 1 }); await flush();
  state.tab.documentId = 'doc-replacement';
  chrome.tabs.onUpdated.emit(1, { status: 'loading' });
  response('late', { value: 2 }); await flush();
  await assert.rejects(service.read(message, sender), { code: 'PAGE_CHANGED' });
  assert.equal((await service.stop(message, sender)).records.length, 0);
  assert.equal(state.detached, 1);
});

test('document identity is rechecked before reading a response even without a tab event', async t => {
  const { service, message, sender, state, bind, response, flush } = setup(t);
  bind(); await service.start(message, sender);
  state.tab.documentId = 'new-doc';
  response('changed', { value: 1 }, { loaderId: 'doc-a' }); await flush();
  await assert.rejects(service.read(message, sender), { code: 'PAGE_CHANGED' });
  assert.equal(state.commands.filter(command => command.method === 'Network.getResponseBody').length, 0);
});

test('revoking permission or closing the owning panel stops and clears captured data', async t => {
  const { service, message, sender, chrome, bind, response, flush } = setup(t);
  bind(); await service.start(message, sender);
  response('before', { value: 1 }); await flush();
  chrome.storage.onChanged.emit({ [NETWORK_READING_SETTINGS_KEY]: { newValue: { version: 1, origins: {} } } }, 'local');
  await assert.rejects(service.read(message, sender), { code: 'NETWORK_PERMISSION_DENIED' });
  assert.equal((await service.stop(message, sender)).records.length, 0);
  const next = { ...message, sessionId: 'session-bbbbbbbb', cancelToken: 'token-bbbbbbbb' };
  const port = bind(next); await service.start(next, sender);
  port.disconnect();
  await assert.rejects(service.read(next, sender), { code: 'NETWORK_PANEL_CLOSED' });
});

test('stopping during a pending response rejects late evidence and preserves a newer session', async t => {
  const { service, message, sender, chrome, coordinator, bind, response, flush } = setup(t);
  const body = deferred();
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = (target, method, args) => method === 'Network.getResponseBody' && args.requestId === 'slow' ? body.promise : original(target, method, args);
  bind(); await service.start(message, sender);
  response('slow', { value: 1 }); await flush();
  await service.stop(message, sender);
  const next = { ...message, sessionId: 'session-bbbbbbbb', cancelToken: 'token-bbbbbbbb' };
  bind(next); await service.start(next, sender);
  body.resolve({ body: '{"value":"late"}' }); await flush();
  assert.equal((await service.read(next, sender)).status, 'listening');
  assert.equal((await service.read(next, sender)).records.length, 0);
  await assert.rejects(withPageDebugger({ tabId: 1 }, async () => {}, { chrome, coordinator }), { code: 'NETWORK_DEBUGGER_BUSY' });
});

test('session expiry detaches and can return only already captured sanitized records', async t => {
  const { service, message, sender, state, bind, response, flush } = setup(t, { durationMs: 30 });
  bind(); await service.start(message, sender);
  response('before', { value: 1 }); await flush();
  await pause(45);
  const result = await service.read(message, sender);
  assert.equal(result.status, 'complete');
  assert.equal(result.records.length, 1);
  assert.equal(state.detached, 1);
});

test('external debugger detach ends capture without reattaching', async t => {
  const { service, message, sender, state, chrome, bind } = setup(t);
  bind(); await service.start(message, sender);
  chrome.debugger.onDetach.emit({ tabId: 1 }, 'canceled_by_user');
  await assert.rejects(service.read(message, sender), { code: 'NETWORK_DEBUGGER_DETACHED' });
  assert.equal(state.attached, 1);
});

test('oversized and invalid JSON bodies are skipped with a visible gap', async t => {
  const { service, message, sender, bind, response, flush } = setup(t);
  bind(); await service.start(message, sender);
  response('huge', JSON.stringify({ value: 'x'.repeat(70000) }));
  response('invalid', '{broken'); await flush();
  const result = await service.read(message, sender);
  assert.equal(result.records.length, 0);
  assert.equal(result.truncated, true);
});

test('a timed out attach cleans up when it finally resolves and keeps other callers out until then', async t => {
  const { service, message, sender, state, chrome, coordinator, bind } = setup(t);
  const attached = deferred();
  chrome.debugger.attach = () => attached.promise;
  bind();
  await assert.rejects(service.start(message, sender), { name: 'TimeoutError' });
  await assert.rejects(withPageDebugger({ tabId: 1 }, async () => {}, { chrome, coordinator }), { code: 'NETWORK_DEBUGGER_BUSY' });
  attached.resolve(); await tick(); await tick();
  assert.equal(state.detached, 1);
  chrome.debugger.attach = async () => { state.attached += 1; };
  assert.equal(await withPageDebugger({ tabId: 1 }, async (_target, sendCommand) => { await sendCommand('Page.getFrameTree'); return 'ok'; }, { chrome, coordinator }), 'ok');
});

test('a late callback from a timed out short debugger read cannot send another command', async t => {
  const { chrome, coordinator, state } = setup(t);
  const later = deferred();
  let callbackResult;
  const result = withPageDebugger({ tabId: 1 }, async (_target, sendCommand) => {
    await later.promise;
    callbackResult = sendCommand('Page.captureScreenshot').catch(error => error.code);
    return callbackResult;
  }, { chrome, coordinator, timeoutMs: 10 });
  await assert.rejects(result, { code: 'NETWORK_DEBUGGER_TIMEOUT' });
  later.resolve(); await tick();
  assert.equal(await callbackResult, 'NETWORK_DEBUGGER_TIMEOUT');
  assert.equal(state.commands.length, 0);
});

test('a timed out target lookup cannot inject a late script or attach a debugger', async t => {
  const { service, message, sender, state, chrome, bind, flush } = setup(t, { ioTimeoutMs: 10 });
  const tab = deferred();
  let injected = 0;
  chrome.tabs.get = () => tab.promise;
  chrome.scripting.executeScript = async () => { injected += 1; return []; };
  bind();
  await assert.rejects(service.start(message, sender), { name: 'TimeoutError' });
  tab.resolve({ ...state.tab }); await flush();
  assert.equal(injected, 0);
  assert.equal(state.attached, 0);
});

test('a hung detach retains its lease after stop returns until the actual detach settles', async t => {
  const { service, message, sender, chrome, coordinator, bind } = setup(t);
  const detached = deferred();
  bind(); await service.start(message, sender);
  chrome.debugger.detach = () => detached.promise;
  await service.stop(message, sender);
  await assert.rejects(coordinator.acquire({ tabId: 1 }), { code: 'NETWORK_DEBUGGER_BUSY' });
  detached.resolve(); await tick();
  const next = await coordinator.acquire({ tabId: 1 });
  chrome.debugger.detach = async () => {};
  await next.release();
});

test('a hash route is checked using both CDP URL and URL fragment', async t => {
  const { service, message, sender, chrome, state, bind } = setup(t);
  state.tab.url = 'https://a.test/page#/chapter';
  message.expectedUrl = state.tab.url;
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = (target, method, args) => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { id: 'frame-a', loaderId: 'doc-a', url: 'https://a.test/page', urlFragment: '#/chapter' } } }
    : original(target, method, args);
  bind();
  assert.equal((await service.start(message, sender)).status, 'listening');
});

test('a different owner or token cannot read, stop, or reuse a running session', async t => {
  const { service, message, sender, bind } = setup(t);
  bind(); await service.start(message, sender);
  await assert.rejects(service.read({ ...message, cancelToken: 'token-wrong-token' }, sender), { code: 'NETWORK_SESSION_EXPIRED' });
  await assert.rejects(service.stop(message, { ...sender, documentId: 'panel-other' }), { code: 'NETWORK_SESSION_EXPIRED' });
  await assert.rejects(service.read({ ...message, expectedUrl: 'https://a.test/other' }, sender), { code: 'PAGE_CHANGED' });
  assert.equal((await service.start(message, sender)).status, 'listening');
});

test('cache grant validation checks a trusted sidepanel and complete document without a port or debugger', async t => {
  const { service, message, sender, state } = setup(t);
  const result = await service.validateGrant(message, sender);
  assert.deepEqual(result, { allowed: true, origin: 'https://a.test', target: { tabId: 1, expectedUrl: message.expectedUrl, documentId: message.documentId } });
  assert.equal(state.attached, 0);
  assert.equal(state.commands.length, 0);
  await assert.rejects(service.validateGrant(message, { ...sender, tab: { id: 1 } }), { code: 'NETWORK_SENDER_DENIED' });
  state.allowed = false;
  await assert.rejects(service.validateGrant(message, sender), { code: 'NETWORK_PERMISSION_DENIED' });
  state.allowed = true;
  state.tab.documentId = 'changed-document';
  await assert.rejects(service.validateGrant(message, sender), { code: 'PAGE_CHANGED' });
});

test('permission revocation during cache document validation cancels the wait and prevents a late script', async t => {
  const { service, message, sender, chrome, state, flush } = setup(t);
  const target = deferred();
  let injected = 0;
  chrome.tabs.get = () => target.promise;
  chrome.scripting.executeScript = async () => { injected += 1; return []; };
  const pending = service.validateGrant(message, sender);
  const rejected = assert.rejects(pending, { code: 'NETWORK_PERMISSION_DENIED' });
  await tick();
  state.allowed = false;
  chrome.storage.onChanged.emit({ [NETWORK_READING_SETTINGS_KEY]: { newValue: { version: 1, origins: {} } } }, 'local');
  await rejected;
  target.resolve(state.tab); await flush();
  assert.equal(injected, 0);
  assert.equal(state.attached, 0);
});

test('cache grant validation is bounded and cannot inject after its deadline', async t => {
  const { service, message, sender, chrome, state, flush } = setup(t, { ioTimeoutMs: 10 });
  const target = deferred();
  let injected = 0;
  chrome.tabs.get = () => target.promise;
  chrome.scripting.executeScript = async () => { injected += 1; return []; };
  await assert.rejects(service.validateGrant(message, sender), { code: 'NETWORK_VALIDATION_TIMEOUT' });
  target.resolve(state.tab); await flush();
  assert.equal(injected, 0);
  assert.equal(state.attached, 0);
});

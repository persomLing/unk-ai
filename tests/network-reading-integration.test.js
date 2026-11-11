import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkReadingClient } from '../src/sidepanel/features/page-reading/network-reading-client.js';
import { createSupplementalReader } from '../src/sidepanel/features/page-reading/supplemental-reading.js';
import { createNetworkReadingService, createPageDebuggerCoordinator, withPageDebugger } from '../src/background/network-reading-service.js';
import { NETWORK_READING_SETTINGS_KEY } from '../src/utils/network-reading.js';
import { normalizePageContext, pageContextForModel } from '../src/utils/reading-context.js';
import { pageSourceFor } from '../src/utils/turn-source.js';

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    emit: (...args) => { for (const listener of [...listeners]) listener(...args); },
  };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fixture(t, options = {}) {
  const target = { tabId: 7, expectedUrl: 'https://example.test/report', documentId: 'report-document' };
  const page = { tabId: target.tabId, url: target.expectedUrl, documentId: target.documentId,
    title: 'Report', text: 'This is the current report body, with an overview of the prices and report data.' };
  const sender = { id: 'integration-extension', url: 'chrome-extension://integration-extension/src/sidepanel/index.html', documentId: 'sidepanel-document' };
  const state = { allowed: true, target: { ...target }, attaches: 0, detaches: 0, detachFinished: false,
    messages: [], bodies: new Map(), commands: [], enabled: deferred(), bodyRead: deferred(), ports: [] };
  const chrome = {
    runtime: { id: sender.id, getURL: path => `chrome-extension://${sender.id}/${path}`, onConnect: event() },
    tabs: { get: async () => ({ id: state.target.tabId, url: state.target.expectedUrl }), onUpdated: event(), onRemoved: event() },
    scripting: { executeScript: async () => [{ frameId: 0, documentId: state.target.documentId, result: { url: state.target.expectedUrl } }] },
    storage: {
      onChanged: event(),
      local: { get: async () => ({ [NETWORK_READING_SETTINGS_KEY]: { version: 1, origins: {
        'https://example.test': { allowed: state.allowed, updatedAt: '2026-11-05T00:00:00.000Z' },
      } } }) },
    },
    debugger: {
      onEvent: event(), onDetach: event(),
      attach: async () => { state.attaches += 1; state.detachFinished = false; },
      detach: async () => { state.detaches += 1; if (options.detachDelay) await pause(options.detachDelay); state.detachFinished = true; },
      sendCommand: async (_target, method, params) => {
        state.commands.push({ method, params });
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame', url: state.target.expectedUrl, loaderId: state.target.documentId } } };
        if (method === 'Network.enable') { state.enabled.resolve(); return {}; }
        if (method === 'Network.getResponseBody') { state.bodyRead.resolve(); return { body: state.bodies.get(params.requestId), base64Encoded: false }; }
        if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
        return {};
      },
    },
  };
  const coordinator = createPageDebuggerCoordinator(chrome, { attachTimeoutMs: 100, detachTimeoutMs: 100 });
  const service = createNetworkReadingService({ chrome, coordinator, ioTimeoutMs: 100, durationMs: 5000 });
  function connect({ name }) {
    let closed = false;
    const clientPort = { name, onMessage: event(), onDisconnect: event() };
    const backgroundPort = { name, sender, onMessage: event(), onDisconnect: event() };
    clientPort.postMessage = message => { if (!closed) queueMicrotask(() => backgroundPort.onMessage.emit(structuredClone(message))); };
    backgroundPort.postMessage = message => { if (!closed) queueMicrotask(() => clientPort.onMessage.emit(structuredClone(message))); };
    clientPort.disconnect = () => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => backgroundPort.onDisconnect.emit());
    };
    backgroundPort.disconnect = () => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => { clientPort.onDisconnect.emit(); backgroundPort.onDisconnect.emit(); });
    };
    state.ports.push({ clientPort, backgroundPort, closed: () => closed });
    queueMicrotask(() => chrome.runtime.onConnect.emit(backgroundPort));
    return clientPort;
  }
  async function sendMessage(message) {
    state.messages.push(structuredClone(message));
    const method = { NETWORK_READING_START: 'start', NETWORK_READING_READ: 'read', NETWORK_READING_STOP: 'stop', NETWORK_READING_VALIDATE: 'validateGrant' }[message.type];
    if (options.hangRead && method === 'read') return new Promise(() => {});
    try { return structuredClone(await service[method](message, sender)); }
    catch (error) { return { error: error.code || 'NETWORK_READING_FAILED', message: error.message }; }
  }
  let sequence = 0;
  const client = createNetworkReadingClient({ connect, sendMessage,
    createId: options.createId || (() => `integration-id-${++sequence}`), captureMs: options.captureMs ?? 25, timeoutMs: options.timeoutMs ?? 500 });
  const enhance = createSupplementalReader({ networkClient: client, getNetworkGrant: async (boundTarget, { signal } = {}) => {
    signal?.throwIfAborted();
    const result = await sendMessage({ ...boundTarget, type: 'NETWORK_READING_VALIDATE' });
    signal?.throwIfAborted();
    if (result.error) throw Object.assign(new Error(result.message), { code: result.error });
    return result;
  } });
  function emitResponse(id = 'report-response', body = { label: 'price', amount: 19, email: 'person@example.test', token: 'private-response-token' }) {
    state.bodies.set(id, JSON.stringify(body));
    chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Network.responseReceived', {
      requestId: id, frameId: 'main-frame', loaderId: target.documentId, type: 'Fetch',
      response: { url: 'https://example.test/api/report?session=private-query-token', mimeType: 'application/json', status: 200 },
    });
    chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Network.loadingFinished', { requestId: id, encodedDataLength: 100 });
  }
  t.after(async () => { enhance.dispose(); client.dispose(); await service.dispose(); });
  return { target, page, state, chrome, service, client, coordinator, enhance, emitResponse };
}

test('real client and service capture one response, retain only sanitized context, and save small per-turn metadata', async t => {
  const { page, target, state, enhance, emitResponse } = fixture(t);
  const pending = enhance('请读取接口数据', { page, target, mode: 'auto', allowNetwork: true });
  await state.enabled.promise;
  emitResponse(); await state.bodyRead.promise;
  const result = await pending;
  assert.equal(result.networkReading.status, 'captured');
  assert.equal(result.networkReading.records.length, 1);
  const savedPage = normalizePageContext(structuredClone(result));
  const input = pageContextForModel(savedPage);
  assert.match(input, /"amount"|\\"amount\\"/);
  assert.match(input, /不可信网页数据/);
  assert.doesNotMatch(input, /person@example\.test|private-response-token|private-query-token|integration-id/);
  const source = pageSourceFor(result);
  assert.equal(source.reading.networkCount, 1);
  assert.equal(source.reading.networkStatus, 'captured');
  assert.doesNotMatch(JSON.stringify(source), /amount|private|integration-id/);
  assert.deepEqual(state.messages.map(message => message.type), ['NETWORK_READING_START', 'NETWORK_READING_READ', 'NETWORK_READING_STOP']);
  assert.ok(state.ports.every(port => port.closed()));
});

test('permission revocation during optional capture propagates rather than becoming an empty successful supplement', async t => {
  const { page, target, state, chrome, enhance } = fixture(t);
  const pending = enhance('这些接口响应的数据呢', { page, target, mode: 'auto', allowNetwork: true });
  const rejected = assert.rejects(pending, { code: 'NETWORK_PERMISSION_DENIED' });
  await state.enabled.promise;
  state.allowed = false;
  chrome.storage.onChanged.emit({ [NETWORK_READING_SETTINGS_KEY]: { newValue: { version: 1, origins: {} } } }, 'local');
  await rejected;
  assert.equal(state.detaches, 1);
});

test('navigation during optional capture cannot return an old page as a successful supplement', async t => {
  const { page, target, state, chrome, enhance } = fixture(t);
  const pending = enhance('这些接口响应的数据呢', { page, target, mode: 'auto', allowNetwork: true });
  const rejected = assert.rejects(pending, { code: 'PAGE_CHANGED' });
  await state.enabled.promise;
  state.target.documentId = 'new-document-at-same-url';
  chrome.tabs.onUpdated.emit(target.tabId, { status: 'loading' });
  await rejected;
  assert.equal(state.detaches, 1);
});

test('cancellation after capture starts disconnects the real service and never sends READ later', async t => {
  const { page, target, state, enhance } = fixture(t, { captureMs: 100 });
  const controller = new AbortController();
  const pending = enhance('请读取接口数据', { page, target, mode: 'auto', allowNetwork: true, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await state.enabled.promise;
  controller.abort();
  await rejected; await tick();
  assert.equal(state.detaches, 1);
  assert.ok(!state.messages.some(message => message.type === 'NETWORK_READING_READ'));
  assert.ok(state.ports.every(port => port.closed()));
});

test('a lost READ reply times out, closes the capture, and optional evidence is marked unavailable', async t => {
  const { page, target, state, enhance } = fixture(t, { hangRead: true, timeoutMs: 65, captureMs: 5 });
  const result = await enhance('这些接口响应的数据呢', { page, target, mode: 'auto', allowNetwork: true });
  await tick();
  assert.equal(result.networkReading.status, 'unavailable');
  assert.equal(state.detaches, 1);
  assert.equal(state.messages.filter(message => message.type === 'NETWORK_READING_READ').length, 1);
  assert.ok(state.ports.every(port => port.closed()));
});

test('successful capture releases the actual debugger before a following screenshot starts', async t => {
  const { target, state, client, chrome, coordinator } = fixture(t, { detachDelay: 25, captureMs: 2 });
  await client.capture(target);
  assert.equal(state.detachFinished, true);
  const image = await withPageDebugger({ tabId: target.tabId }, (_target, sendCommand) => sendCommand('Page.captureScreenshot'), { chrome, coordinator });
  assert.equal(image.data, 'AAAA');
});

test('a rejected bind returns its precise reason without starting or hanging the capture', async t => {
  const { target, state, client } = fixture(t, { createId: () => 'short' });
  await assert.rejects(client.capture(target), { code: 'NETWORK_SESSION_INVALID' });
  assert.equal(state.attaches, 0);
  assert.ok(!state.messages.some(message => message.type === 'NETWORK_READING_START'));
});

test('a cached follow-up uses the real background validation route without another debugger attachment', async t => {
  const { page, target, state, enhance, emitResponse } = fixture(t);
  const options = { page, target, mode: 'auto', allowNetwork: true, cacheScope: { conversationId: 'real-conversation' } };
  const pending = enhance('请读取接口数据', options);
  await state.enabled.promise;
  emitResponse();
  const first = await pending;
  const second = await enhance('这些接口数据是什么意思', options);
  assert.equal(second.networkReading.status, 'reused');
  assert.equal(second.networkReading.records[0].capturedAt, first.networkReading.records[0].capturedAt);
  assert.ok(second.networkReading.note.includes(first.networkReading.cache.capturedAt));
  assert.equal(state.attaches, 1);
  assert.equal(state.messages.filter(message => message.type === 'NETWORK_READING_VALIDATE').length, 1);
  assert.equal(state.messages.filter(message => message.type === 'NETWORK_READING_START').length, 1);
  assert.match(pageContextForModel(second), /本轮未重新监听/);
  state.allowed = false;
  await assert.rejects(enhance('这些接口数据是什么意思', options), { code: 'NETWORK_PERMISSION_DENIED' });
  assert.equal(state.attaches, 1);
});

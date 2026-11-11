import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkReadingClient } from '../src/sidepanel/features/page-reading/network-reading-client.js';
const target = { tabId: 1, url: 'https://example.test/report', documentId: 'doc' };
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: value => { for (const fn of listeners) fn(value); } }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const messages = []; let disconnects = 0; let id = 0;
  const port = { onMessage: event(), onDisconnect: event(),
    postMessage: message => queueMicrotask(() => port.onMessage.emit({ type: 'NETWORK_READING_BOUND', sessionId: message.sessionId })),
    disconnect: () => { disconnects++; port.onDisconnect.emit(); } };
  const client = createNetworkReadingClient({ captureMs: 1, createId: () => `id-${++id}`,
    connect: () => port, sendMessage: async message => {
      messages.push(message);
      return options.send ? options.send(message) : { sessionId: message.sessionId, target, records: [] };
    }, ...options });
  return { client, port, messages, disconnects: () => disconnects };
}
test('capture binds its lifetime and stops after reading only its own target', async () => {
  const value = fixture();
  const result = await value.client.capture(target);
  assert.equal(result.target.documentId, 'doc');
  assert.deepEqual(value.messages.map(m => m.type), ['NETWORK_READING_START', 'NETWORK_READING_READ', 'NETWORK_READING_STOP']);
  assert.equal(value.disconnects(), 1);
});
test('stop during a pending start disconnects and cannot launch a late read', async () => {
  let resolve;
  const wait = new Promise(yes => { resolve = yes; });
  const value = fixture({ send: message => message.type === 'NETWORK_READING_START' ? wait : { sessionId: message.sessionId } });
  const stop = new AbortController();
  const pending = value.client.capture(target, { signal: stop.signal });
  await tick();
  stop.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolve({ sessionId: value.messages[0].sessionId });
  await tick();
  assert.equal(value.disconnects(), 1);
  assert.ok(!value.messages.some(m => m.type === 'NETWORK_READING_READ'));
});
test('a different document response is rejected and capture always releases', async () => {
  const value = fixture({ send: async message => ({ sessionId: message.sessionId, target: { ...target, documentId: 'other' } }) });
  await assert.rejects(value.client.capture(target), { code: 'PAGE_CHANGED' });
  assert.equal(value.disconnects(), 1);
});
test('missing permission propagates without waiting or retrying a request', async () => {
  const value = fixture({ send: async () => ({ error: 'NETWORK_PERMISSION_DENIED', message: '本站未允许接口读取' }) });
  await assert.rejects(value.client.capture(target), { code: 'NETWORK_PERMISSION_DENIED' });
  assert.equal(value.messages.filter(m => m.type === 'NETWORK_READING_START').length, 1);
  assert.equal(value.messages.filter(m => m.type === 'NETWORK_READING_READ').length, 0);
});
test('dispose cancels a hung bind and rejects future captures', async () => {
  const value = fixture();
  value.port.postMessage = () => {};
  const pending = value.client.capture(target);
  value.client.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(value.client.capture(target), { name: 'AbortError' });
  assert.equal(value.disconnects(), 1);
});

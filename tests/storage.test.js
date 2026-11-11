import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createConversation,
  deleteConversation,
  getConversation,
  getProviderConfig,
  listConversations,
  saveConversation,
  saveProviderConfig,
} from '../src/utils/storage.js';

function createChrome(t, { failOn } = {}) {
  const data = new Map();
  const writes = [];
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  const local = {
    async get(keys) {
      const requested = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const result = {};
      for (const key of requested) if (data.has(key)) result[key] = clone(data.get(key));
      return result;
    },
    async set(items) {
      const key = Object.keys(items)[0];
      if (failOn?.(key, items)) throw new Error('Simulated storage quota error');
      writes.push({ key, value: clone(items[key]) });
      for (const [name, value] of Object.entries(items)) data.set(name, clone(value));
    },
    async remove(keys) {
      const key = Array.isArray(keys) ? keys[0] : keys;
      if (failOn?.(key)) throw new Error('Simulated remove error');
      for (const name of Array.isArray(keys) ? keys : [keys]) data.delete(name);
    },
  };
  globalThis.chrome = { storage: { local } };
  t.after(() => { delete globalThis.chrome; });
  return { data, writes };
}

function conversation(id, title, updatedAt, messages = []) {
  return { version: 1, id, title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt, messages };
}

test('provider config is versioned and persisted in the dedicated local key', async (t) => {
  const { data } = createChrome(t);
  assert.equal(await getProviderConfig(), null);
  const saved = await saveProviderConfig({
    endpointUrl: 'https://llm.example/v1/chat/completions',
    apiKey: 'local-secret',
    model: 'model',
    temperature: 0,
    webSearchEndpoint: 'tools/search',
    webFetchEndpoint: 'tools/fetch',
    webFetchEnabled: false,
  });
  assert.equal(saved.version, 4);
  assert.equal(saved.webSearchEndpoint, 'tools/search');
  assert.equal(saved.webFetchEndpoint, 'tools/fetch');
  assert.equal(saved.webFetchEnabled, false);
  assert.equal(data.get('providerConfig').apiKey, 'local-secret');
  assert.equal(data.get('providerConfig').models.length, 1);
  assert.equal(data.get('providerConfig').selectedModelId, 'model');
  assert.equal(data.has('conversationIndex'), false);
  assert.deepEqual(await getProviderConfig(), saved);
});

test('a denied origin persistence hint does not block chrome local storage', async (t) => {
  const { data } = createChrome(t);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
  Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: { persist: async () => false } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis.navigator, 'storage', descriptor);
    else delete globalThis.navigator.storage;
  });
  const record = conversation('large', 'Large draft', '2026-01-01T00:00:00.000Z', [
    { id: 'u1', role: 'user', content: 'x'.repeat(1100000) },
  ]);
  await saveConversation(record);
  assert.equal(data.get('conversation:large').messages[0].content.length, 1100000);
});

test('create uses UUID and ISO timestamps and writes a consistent index', async (t) => {
  const { data } = createChrome(t);
  const created = await createConversation('First chat');

  assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);
  assert.equal(created.createdAt, created.updatedAt);
  assert.deepEqual(created.messages, []);
  assert.deepEqual(await getConversation(created.id), created);
  assert.deepEqual(data.get('conversationIndex'), [{
    id: created.id,
    title: 'First chat',
    updatedAt: created.updatedAt,
    messageCount: 0,
  }]);
});

test('saving replaces its index entry, sorts descending, and updates message count', async (t) => {
  createChrome(t);
  await saveConversation(conversation('a', 'Older', '2026-01-01T00:00:00.000Z'));
  await saveConversation(conversation('b', 'Newer', '2026-02-01T00:00:00.000Z'));
  await saveConversation(conversation('c', 'Middle', '2026-01-15T00:00:00.000Z'));
  const changed = conversation('a', 'Renamed', '2026-03-01T00:00:00.000Z', [
    { id: 'm1', role: 'user', content: 'Hello', status: 'complete', createdAt: '2026-03-01T00:00:00.000Z' },
  ]);
  await saveConversation(changed);

  assert.deepEqual((await listConversations()).map((entry) => entry.id), ['a', 'b', 'c']);
  assert.equal((await listConversations())[0].title, 'Renamed');
  assert.equal((await listConversations())[0].messageCount, 1);
  assert.equal((await listConversations()).length, 3);
});

test('conversation record is written before the index and retained if indexing fails', async (t) => {
  const { data, writes } = createChrome(t, { failOn: (key) => key === 'conversationIndex' });
  const value = conversation('important', 'Kept', '2026-04-01T00:00:00.000Z');
  await assert.rejects(saveConversation(value), /quota/);

  assert.equal(writes[0].key, 'conversation:important');
  assert.deepEqual(data.get('conversation:important'), value);
  assert.equal(data.has('conversationIndex'), false);
  assert.deepEqual(await getConversation('important'), value);
});

test('getConversation restores interrupted streaming messages as stopped', async (t) => {
  const { data } = createChrome(t);
  data.set('conversation:interrupted', conversation('interrupted', 'Recovered', '2026-01-01T00:00:00.000Z', [
    {
      id: 'a',
      role: 'assistant',
      content: 'partial',
      status: 'streaming',
      reasoningStartedAt: 123,
      reasoningFinishedAt: 456,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ]));

  const result = await getConversation('interrupted');
  assert.equal(result.messages[0].status, 'stopped');
  assert.equal('reasoningStartedAt' in result.messages[0], false);
  assert.equal('reasoningFinishedAt' in result.messages[0], false);
  assert.equal(data.get('conversation:interrupted').messages[0].status, 'streaming');
});

test('deleting removes content and index without disturbing other conversations', async (t) => {
  const { data } = createChrome(t);
  await saveConversation(conversation('keep', 'Keep', '2026-01-01T00:00:00.000Z'));
  await saveConversation(conversation('delete', 'Delete', '2026-02-01T00:00:00.000Z'));

  assert.equal(await deleteConversation('delete'), true);
  assert.equal(await getConversation('delete'), null);
  assert.equal(data.has('conversation:delete'), false);
  assert.deepEqual((await listConversations()).map((entry) => entry.id), ['keep']);
  assert.equal(await deleteConversation('delete'), false);
});

test('malformed index and missing IDs fail closed without overwriting records', async (t) => {
  const { data, writes } = createChrome(t);
  data.set('conversationIndex', null);
  assert.deepEqual(await listConversations(), []);
  assert.equal(await getConversation(''), null);
  assert.equal(await getConversation('missing'), null);
  await assert.rejects(saveConversation({}), /valid id/);
  assert.equal(writes.length, 0);
});

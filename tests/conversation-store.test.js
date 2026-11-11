import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearTemporaryConversation,
  getTemporaryConversation,
  listLegacyConversationRecords,
  saveTemporaryConversation,
  saveConversation,
} from '../src/utils/storage.js';

function createChrome(t) {
  const data = new Map();
  const local = {
    async get(keys) {
      const result = {};
      if (keys === null) {
        for (const [key, value] of data) result[key] = structuredClone(value);
        return result;
      }
      for (const key of (Array.isArray(keys) ? keys : [keys])) {
        if (data.has(key)) result[key] = structuredClone(data.get(key));
      }
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) data.delete(key);
    },
  };
  globalThis.chrome = { storage: { local } };
  t.after(() => { delete globalThis.chrome; });
  return data;
}

test('only one temporary conversation is retained', async (t) => {
  createChrome(t);
  await saveTemporaryConversation({ id: 'one', title: 'One', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messages: [] });
  await saveTemporaryConversation({ id: 'two', title: 'Two', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', messages: [] });
  const temporary = await getTemporaryConversation();
  assert.equal(temporary.id, 'two');
  assert.equal(temporary.storage, 'temporary');
});

test('clearing temporary conversation does not touch saved conversations', async (t) => {
  createChrome(t);
  await saveConversation({ id: 'saved', title: 'Saved', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messages: [] });
  await saveTemporaryConversation({ id: 'temp', title: 'Temp', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messages: [] });
  await clearTemporaryConversation();
  assert.equal(await getTemporaryConversation(), null);
  assert.equal((await listLegacyConversationRecords()).some((item) => item.id === 'saved'), true);
});


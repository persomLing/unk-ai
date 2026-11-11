import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryIndexedDB } from './helpers/memory-indexeddb.js';

import {
  deleteConversationRecord,
  chooseConversationDirectory,
  getDirectoryInfo,
  readAllConversationRecords,
  readConversationRecord,
  requestDirectoryPermission,
  restoreConversationDirectory,
  refreshDirectoryMeta,
  writeConversationRecord,
} from '../src/utils/local-directory.js';

function createDirectoryHarness(t) {
  const root = new Map();
  let storedHandle = null;

  function directory(name) {
    return {
      name,
      async getDirectoryHandle(child, { create = false } = {}) {
        if (!root.has(child)) {
          if (!create) throw new DOMException('Missing directory', 'NotFoundError');
          root.set(child, new Map());
        }
        return directory(child);
      },
      async getFileHandle(fileName, { create = false } = {}) {
        if (!root.has(fileName)) {
          if (!create) throw new DOMException('Missing file', 'NotFoundError');
          root.set(fileName, '');
        }
        return {
          async createWritable() {
            let value = '';
            return {
              async write(chunk) { value += String(chunk); },
              async close() { root.set(fileName, value); },
            };
          },
          async getFile() {
            return { text: async () => String(root.get(fileName) || '') };
          },
        };
      },
      async removeEntry(fileName) {
        if (!root.has(fileName)) throw new DOMException('Missing file', 'NotFoundError');
        root.delete(fileName);
      },
      async *entries() {
        for (const [name, value] of root) {
          if (typeof value === 'string') {
            yield [name, {
              kind: 'file',
              getFile: async () => ({ text: async () => value }),
            }];
          }
        }
      },
    };
  }

  globalThis.showDirectoryPicker = async () => directory('fixture-root');
  globalThis.indexedDB = {
    open() {
      const request = {};
      const store = {
        get(_key) {
          const result = { result: storedHandle };
          queueMicrotask(() => result.onsuccess?.());
          return result;
        },
        put(handle) {
          storedHandle = handle;
          const result = {};
          queueMicrotask(() => result.onsuccess?.());
          return result;
        },
      };
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const transaction = { objectStore: () => store };
            setTimeout(() => transaction.oncomplete?.(), 0);
            return transaction;
          },
          close() {},
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
  t.after(() => {
    delete globalThis.showDirectoryPicker;
    delete globalThis.indexedDB;
    delete globalThis.__unkAiDirectoryHandle;
  });
  globalThis.__unkAiDirectoryHandle = {
    ...directory('fixture-root'),
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ storageDirectoryMeta: { name: 'fixture-root' } }),
        set: async () => {},
      },
    },
  };
  t.after(() => { delete globalThis.chrome; });
  return root;
}

test('file store round-trips a conversation and deletes the matching file', async (t) => {
  createDirectoryHarness(t);
  const conversation = {
    id: 'abc-123',
    title: 'Saved',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [{ id: 'm1', role: 'user', content: 'hello', status: 'complete' }],
  };
  await writeConversationRecord(conversation);
  assert.deepEqual(await readConversationRecord(conversation.id), conversation);
  assert.equal((await readAllConversationRecords()).length, 1);
  assert.equal(await deleteConversationRecord(conversation.id), true);
  assert.equal(await readConversationRecord(conversation.id), null);
});

test('changing folders replaces the cached selection in this and other documents', async (t) => {
  createDirectoryHarness(t);
  const original = globalThis.__unkAiDirectoryHandle;
  const replacement = { ...original, name: 'new-folder' };
  globalThis.showDirectoryPicker = async () => replacement;
  await chooseConversationDirectory();
  assert.equal((await getDirectoryInfo()).name, 'new-folder');
  // Simulate another already-open side panel retaining the previous handle.
  globalThis.__unkAiDirectoryHandle = original;
  assert.equal((await refreshDirectoryMeta()).name, 'new-folder');
  assert.equal(globalThis.__unkAiDirectoryHandle, replacement);
});

test('a failed directory-handle transaction does not report or cache the new selection', async (t) => {
  createDirectoryHarness(t);
  const original = globalThis.__unkAiDirectoryHandle;
  const database = memoryIndexedDB();
  database.control.failNextWrite = true;
  globalThis.indexedDB = database;
  globalThis.showDirectoryPicker = async () => ({ ...original, name: 'uncommitted-folder' });
  await assert.rejects(chooseConversationDirectory(), /quota/i);
  assert.equal(globalThis.__unkAiDirectoryHandle, original);
});

test('a stored folder with prompt permission is reported as configured but not granted', async (t) => {
  const root = createDirectoryHarness(t);
  globalThis.__unkAiDirectoryHandle = null;
  const handle = {
    ...globalThis.__unkAiDirectoryHandle,
    name: 'unk_ai_data',
    async queryPermission() { return 'prompt'; },
    async requestPermission() { return 'granted'; },
  };
  globalThis.__unkAiDirectoryHandle = handle;
  const info = await getDirectoryInfo();
  assert.equal(info.configured, true);
  assert.equal(info.granted, false);
  assert.equal(info.permission, 'prompt');
  assert.equal(info.name, 'unk_ai_data');
  assert.ok(root);
});

test('restoring permission reuses the same folder instead of choosing a new one', async (t) => {
  createDirectoryHarness(t);
  const original = globalThis.__unkAiDirectoryHandle;
  let requested = 0;
  globalThis.__unkAiDirectoryHandle = {
    ...original,
    name: 'unk_ai_data',
    async queryPermission() { return requested ? 'granted' : 'prompt'; },
    async requestPermission() { requested += 1; return 'granted'; },
  };
  const meta = await restoreConversationDirectory();
  assert.equal(requested, 1);
  assert.equal(meta.name, 'unk_ai_data');
  assert.equal((await getDirectoryInfo()).granted, true);
});

test('requesting permission accepts the session-restored folder handle', async (t) => {
  createDirectoryHarness(t);
  const original = globalThis.__unkAiDirectoryHandle;
  let requested = 0;
  globalThis.indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            return {
              objectStore: () => ({
                get() {
                  const result = {};
                  queueMicrotask(() => result.onsuccess?.({ target: { result: null } }));
                  return result;
                },
              }),
            };
          },
          close() {},
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
  globalThis.__unkAiDirectoryHandle = {
    ...original,
    async queryPermission() { return requested ? 'granted' : 'prompt'; },
    async requestPermission() { requested += 1; return 'granted'; },
  };

  assert.equal(await requestDirectoryPermission(), true);
  assert.equal(requested, 1);
});

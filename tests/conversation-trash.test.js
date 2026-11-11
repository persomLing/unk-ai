import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryIndexedDB } from './helpers/memory-indexeddb.js';
import * as store from '../src/utils/conversation-store.js';
import { bindConversationWriteTarget, listPendingConversationWrites } from '../src/utils/conversation-outbox.js';

function setup(t) {
  function setGlobal(key, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  const database = memoryIndexedDB();
  setGlobal('indexedDB', database);
  const browser = new Map();
  setGlobal('chrome', { storage: { local: {
    async get(key) { return { [key]: browser.get(key) }; },
    async set(values) { for (const [key, value] of Object.entries(values)) browser.set(key, structuredClone(value)); },
    async remove(key) { browser.delete(key); },
  } } });
  function directory(name) {
    const files = new Map();
    const writes = [];
    const handle = {
      name, files, writes, failDeleteIds: new Set(),
      async queryPermission() { return 'granted'; },
      async getDirectoryHandle() { return this; },
      async getFileHandle(id, { create = false } = {}) {
        if (!create && !files.has(id)) throw new DOMException('Missing', 'NotFoundError');
        return {
          async getFile() { return { text: async () => { await handle.beforeRead?.(id); return files.get(id); } }; },
          async createWritable() {
            let content;
            return {
              async write(value) { content = value; },
              async close() { await handle.beforeClose?.(id, content); files.set(id, content); writes.push({ id, content }); },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(id) {
        await handle.beforeDelete?.(id);
        if (handle.failDeleteIds.has(id)) throw new Error('Folder temporarily unavailable');
        if (!files.delete(id)) throw new DOMException('Missing', 'NotFoundError');
      },
      async *entries() { for (const [name, value] of files) yield [name, { kind: 'file', getFile: async () => ({ text: async () => value }) }]; },
    };
    return handle;
  }
  const folder = directory('A');
  setGlobal('__unkAiDirectoryHandle', folder);
  return { database, browser, folder, directory };
}

const conversation = (id = 'trash-c1', text = 'Original') => ({ version: 2, id, storage: 'local', title: id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', messages: [{ id: 'u1', role: 'user', content: text }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('confirmed deletion hides history, blocks late snapshots, and undo restores only the deleted record', async t => {
  const { folder } = setup(t);
  const original = await store.saveLocalConversation(conversation());
  const result = await store.trashSavedConversations([original.id]);
  assert.deepEqual(result.deletedIds, [original.id]);
  assert.deepEqual(result.pendingIds, []);
  assert.equal(folder.files.has(`${original.id}.json`), false);
  assert.equal(await store.loadConversation(original.id), null);
  assert.deepEqual(await store.listSavedConversations(), []);
  await assert.rejects(store.commitConversationByStorage(original), /删除/);
  assert.equal((await listPendingConversationWrites()).length, 0);
  const latest = await store.getLatestConversationDeletion();
  assert.equal(latest.token, result.token);
  assert.deepEqual(latest.ids, [original.id]);
  const restored = await store.restoreTrashedConversations(result.token);
  assert.deepEqual(restored.restoredIds, [original.id]);
  const loaded = await store.loadConversation(original.id);
  assert.equal(loaded.updatedAt, original.updatedAt);
  assert.equal(loaded.messages[0].content, 'Original');
  assert.ok(loaded.storageGeneration);
  await assert.rejects(store.commitConversationByStorage(original), /版本|失效/);
  await store.saveLocalConversation({ ...loaded, title: 'Newer title' });
  await store.restoreTrashedConversations(result.token);
  assert.equal((await store.loadConversation(original.id)).title, 'Newer title', 'repeat undo must not overwrite newer content');
});

test('undo keeps the original directory even after folder selection changes', async t => {
  const { folder, directory } = setup(t);
  await store.saveLocalConversation(conversation());
  const result = await store.trashSavedConversations(['trash-c1']);
  const next = directory('B');
  globalThis.__unkAiDirectoryHandle = next;
  const restored = await store.restoreTrashedConversations(result.token);
  assert.deepEqual(restored.restoredIds, ['trash-c1']);
  assert.equal(folder.files.has('trash-c1.json'), true);
  assert.equal(next.files.size, 0);
});

test('undo refuses to overwrite a different file created after deletion', async t => {
  const { folder } = setup(t);
  await store.saveLocalConversation(conversation());
  const result = await store.trashSavedConversations(['trash-c1']);
  const newer = conversation('trash-c1', 'Externally changed');
  folder.files.set('trash-c1.json', JSON.stringify(newer));
  const restored = await store.restoreTrashedConversations(result.token);
  assert.deepEqual(restored.restoredIds, []);
  assert.equal(restored.failed[0].id, 'trash-c1');
  assert.match(restored.failed[0].message, /变化|不同|覆盖/);
  assert.equal(JSON.parse(folder.files.get('trash-c1.json')).messages[0].content, 'Externally changed');
});

test('batch deletion reports partial disk failure and keeps both records recoverable', async t => {
  const { folder } = setup(t);
  await store.saveLocalConversation(conversation('trash-c1'));
  await store.saveLocalConversation(conversation('trash-c2'));
  folder.failDeleteIds.add('trash-c1.json');
  const result = await store.trashSavedConversations(['trash-c1', 'trash-c2']);
  assert.deepEqual(result.deletedIds, ['trash-c2']);
  assert.deepEqual(result.pendingIds, ['trash-c1']);
  assert.deepEqual(await store.listSavedConversations(), []);
  folder.failDeleteIds.clear();
  const restored = await store.restoreTrashedConversations(result.token);
  assert.deepEqual(restored.restoredIds.sort(), ['trash-c1', 'trash-c2']);
  assert.equal((await store.listSavedConversations()).length, 2);
});

test('a durable trash commit failure does not delete the disk record', async t => {
  const { folder, database } = setup(t);
  await store.saveLocalConversation(conversation());
  database.control.failNextWrite = true;
  const result = await store.trashSavedConversations(['trash-c1']);
  assert.deepEqual(result.deletedIds, []);
  assert.equal(result.failed[0].id, 'trash-c1');
  assert.match(result.failed[0].message, /quota/i);
  assert.equal(folder.files.has('trash-c1.json'), true);
  assert.ok(await store.loadConversation('trash-c1'));
});

test('timeout while waiting for an older writer cancels deletion before any mutation', async t => {
  const { folder } = setup(t);
  const entered = deferred(), release = deferred();
  folder.beforeClose = async () => { entered.resolve(); await release.promise; };
  try {
    await store.commitConversationByStorage(conversation());
    await entered.promise;
    const result = await store.trashSavedConversations(['trash-c1'], { timeoutMs: 10 });
    assert.deepEqual(result.pendingIds, []);
    assert.equal(result.failed[0].id, 'trash-c1');
    release.resolve();
    await store.flushConversationWrites({ timeoutMs: 300 });
    assert.ok(await store.loadConversation('trash-c1'));
    assert.equal(await store.getLatestConversationDeletion(), null);
  } finally { release.resolve(); await store.flushConversationWrites({ timeoutMs: 300 }); }
});

test('a timed out disk delete retains its lock and undo safely follows the original operation', async t => {
  const { folder } = setup(t);
  await store.saveLocalConversation(conversation());
  const entered = deferred(), release = deferred();
  folder.beforeDelete = async () => { entered.resolve(); await release.promise; };
  try {
    const result = await store.trashSavedConversations(['trash-c1'], { timeoutMs: 10 });
    await entered.promise;
    assert.deepEqual(result.deletedIds, []);
    assert.deepEqual(result.pendingIds, ['trash-c1']);
    await assert.rejects(store.commitConversationByStorage(conversation()), /删除/);
    const undo = store.restoreTrashedConversations(result.token, { timeoutMs: 300 });
    release.resolve();
    assert.deepEqual((await undo).restoredIds, ['trash-c1']);
    assert.equal((await store.loadConversation('trash-c1')).messages[0].content, 'Original');
  } finally { release.resolve(); }
});

test('deletion captures the newest durable revision committed while it reads the original file', async t => {
  const { folder } = setup(t);
  await store.saveLocalConversation(conversation());
  const entered = deferred(), release = deferred();
  folder.beforeRead = async () => { entered.resolve(); await release.promise; };
  const deletion = store.trashSavedConversations(['trash-c1']);
  await entered.promise;
  await store.commitConversationByStorage(conversation('trash-c1', 'Newly committed'));
  release.resolve();
  const result = await deletion;
  folder.beforeRead = null;
  assert.deepEqual(result.deletedIds, ['trash-c1']);
  await store.restoreTrashedConversations(result.token);
  assert.equal((await store.loadConversation('trash-c1')).messages[0].content, 'Newly committed');
});

test('temporary slots are not accepted by the history deletion API', async t => {
  const { browser } = setup(t);
  browser.set('temporaryConversation', { ...conversation(), storage: 'temporary' });
  const result = await store.trashSavedConversations(['trash-c1']);
  assert.equal(result.failed[0].id, 'trash-c1');
  assert.equal(browser.get('temporaryConversation').id, 'trash-c1');
});

test('a stalled pre-delete read times out and releases the disk lock without a late mutation', async t => {
  const { folder } = setup(t);
  await store.saveLocalConversation(conversation());
  const entered = deferred(), release = deferred();
  folder.beforeRead = async () => { entered.resolve(); await release.promise; };
  try {
    const result = await store.trashSavedConversations(['trash-c1'], { timeoutMs: 10 });
    await entered.promise;
    assert.equal(result.failed[0].id, 'trash-c1');
    const saved = await store.saveLocalConversation(conversation('trash-c1', 'Saved after read timeout'), { timeoutMs: 200 });
    assert.equal(saved.syncStatus, 'synced', 'abandoned read must not keep a disk lock');
    release.resolve();
    folder.beforeRead = null;
    assert.equal((await store.loadConversation('trash-c1')).messages[0].content, 'Saved after read timeout');
    assert.equal(await store.getLatestConversationDeletion(), null);
  } finally { release.resolve(); }
});

test('a concurrent copied-record rebind cannot redirect deletion into another directory', async t => {
  const { folder, directory } = setup(t);
  await store.saveLocalConversation(conversation());
  const next = directory('B');
  const entered = deferred(), release = deferred();
  folder.beforeRead = async () => { entered.resolve(); await release.promise; };
  const deletion = store.trashSavedConversations(['trash-c1']);
  await entered.promise;
  await bindConversationWriteTarget('trash-c1', next);
  await store.commitConversationByStorage(conversation('trash-c1', 'Copy in B'));
  release.resolve();
  const result = await deletion;
  folder.beforeRead = null;
  assert.deepEqual(result.deletedIds, []);
  assert.match(result.failed[0].message, /目录已变化/);
  await store.flushConversationWrites({ timeoutMs: 200 });
  assert.equal(JSON.parse(folder.files.get('trash-c1.json')).messages[0].content, 'Original');
  assert.equal(JSON.parse(next.files.get('trash-c1.json')).messages[0].content, 'Copy in B');
});

test('schema v2 adds trash without resetting v1 pending records or their target directory', async t => {
  const { database, folder } = setup(t);
  await new Promise((resolve, reject) => {
    const request = database.open('unk-ai-conversation-sync', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('outbox'); request.result.createObjectStore('targets'); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction(['outbox', 'targets'], 'readwrite');
      tx.objectStore('outbox').put({ id: 'trash-c1', revision: 'old-version-revision', conversation: conversation(), directoryHandle: folder, queuedAt: '2026-01-01', error: '' }, 'trash-c1');
      tx.objectStore('targets').put(folder, 'trash-c1');
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  assert.equal((await listPendingConversationWrites())[0].revision, 'old-version-revision');
  assert.equal((await store.flushConversationWrites()).synced, 1);
  const result = await store.trashSavedConversations(['trash-c1']);
  assert.deepEqual(result.deletedIds, ['trash-c1']);
  await store.restoreTrashedConversations(result.token);
  assert.equal(JSON.parse(folder.files.get('trash-c1.json')).messages[0].content, 'Original');
});

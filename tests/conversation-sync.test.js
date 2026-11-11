import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryIndexedDB } from './helpers/memory-indexeddb.js';
import {
  commitConversationByStorage,
  deleteSavedConversation,
  flushConversationWrites,
  initializeConversationSync,
  listSavedConversations,
  loadConversation,
  promoteTemporaryConversation,
  retryPendingConversationWrites,
  saveLocalConversation,
} from '../src/utils/conversation-store.js';
import {
  acknowledgeConversationWrite,
  getPendingConversationWrite,
  listPendingConversationWrites,
  stageConversationWrite,
  updatePendingConversationWrite,
} from '../src/utils/conversation-outbox.js';

function setup(t) {
  function setGlobal(key, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const database = memoryIndexedDB();
  setGlobal('indexedDB', database);
  const browser = new Map();
  setGlobal('chrome', { storage: { local: {
    async get(key) { return { [key]: browser.get(key) }; },
    async set(items) { for (const [key, value] of Object.entries(items)) browser.set(key, structuredClone(value)); },
    async remove(key) { browser.delete(key); },
  } } });
  function directory(name) {
    const files = new Map();
    const activeWriters = new Map();
    const maxWriters = new Map();
    const writes = [];
    const handle = {
      name, files, maxWriters, writes, permission: 'granted', failWrite: false,
      async queryPermission() { return this.permission; },
      async getDirectoryHandle() { return this; },
      async getFileHandle(id, { create = false } = {}) {
        if (!create && !files.has(id)) throw new DOMException('Missing', 'NotFoundError');
        return {
          async getFile() { return { text: async () => files.get(id) }; },
          async createWritable() {
            let next;
            let closed = false;
            const active = (activeWriters.get(id) || 0) + 1;
            activeWriters.set(id, active);
            maxWriters.set(id, Math.max(maxWriters.get(id) || 0, active));
            const finish = () => {
              if (closed) return;
              closed = true;
              activeWriters.set(id, activeWriters.get(id) - 1);
            };
            return {
              async write(text) { if (handle.failWrite) throw new Error('Folder disconnected'); next = text; },
              async close() {
                await handle.beforeClose?.(id, next);
                files.set(id, next);
                writes.push({ id, record: JSON.parse(next) });
                finish();
              },
              async abort() { finish(); },
            };
          },
        };
      },
      async removeEntry(id) { if (!files.delete(id)) throw new DOMException('Missing', 'NotFoundError'); },
      async *entries() {
        for (const [name, value] of files) yield [name, { kind: 'file', getFile: async () => ({ text: async () => value }) }];
      },
    };
    return handle;
  }
  const folder = directory('A');
  setGlobal('__unkAiDirectoryHandle', folder);
  return { browser, database, folder, directory };
}

const conversation = (content = 'hello') => ({ id: 'c1', storage: 'local', title: 'Conversation', messages: [{ id: 'u1', role: 'user', content }] });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message, timeoutMs = 300) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('failed folder writes remain durable and overlay the older disk history', async (t) => {
  const { folder } = setup(t);
  assert.equal((await saveLocalConversation(conversation('old'))).syncStatus, 'synced');
  folder.failWrite = true;
  const result = await saveLocalConversation(conversation('new'));
  assert.equal(result.syncStatus, 'pending');
  assert.equal(result.syncDirectoryName, 'A');
  assert.match(result.syncError, /disconnected/);
  assert.equal(JSON.parse(folder.files.get('c1.json')).messages[0].content, 'old');
  assert.equal((await loadConversation('c1')).messages[0].content, 'new');
  assert.equal((await listSavedConversations())[0].syncStatus, 'pending');
  folder.failWrite = false;
  const retry = await retryPendingConversationWrites();
  assert.equal(retry.synced, 1);
  assert.equal(retry.pending, 0);
  assert.equal(JSON.parse(folder.files.get('c1.json')).messages[0].content, 'new');
  assert.equal((await listPendingConversationWrites()).length, 0);
});

test('startup replays a committed outbox entry after the previous document was lost', async (t) => {
  const { folder } = setup(t);
  await stageConversationWrite(conversation(), folder);
  assert.equal(folder.files.size, 0);
  const reloaded = await import(`../src/utils/conversation-store.js?reload=${Date.now()}`);
  const result = await reloaded.initializeConversationSync();
  assert.equal(result.synced, 1);
  assert.equal(JSON.parse(folder.files.get('c1.json')).messages[0].content, 'hello');
});

test('switching the selected folder cannot redirect a pending or existing conversation', async (t) => {
  const { folder, directory } = setup(t);
  folder.failWrite = true;
  await saveLocalConversation(conversation('pending in A'));
  const next = directory('B');
  globalThis.__unkAiDirectoryHandle = next;
  folder.failWrite = false;
  const retried = await initializeConversationSync();
  assert.equal(retried.conversations[0].syncDirectoryName, 'A');
  const saved = await saveLocalConversation(conversation('updated in A'));
  assert.equal(saved.syncDirectoryName, 'A');
  assert.equal(next.files.size, 0);
  assert.equal(JSON.parse(folder.files.get('c1.json')).messages[0].content, 'updated in A');
});

test('reloading a copied conversation reports its actual selected folder instead of stale file metadata', async (t) => {
  const { folder, directory } = setup(t);
  await saveLocalConversation(conversation());
  const next = directory('B');
  next.files.set('c1.json', folder.files.get('c1.json'));
  globalThis.__unkAiDirectoryHandle = next;
  const loaded = await loadConversation('c1');
  assert.equal(loaded.syncDirectoryName, 'B');
  assert.equal((await listSavedConversations())[0].syncDirectoryName, 'B');
  const saved = await saveLocalConversation({ ...loaded, title: 'Updated copy' });
  assert.equal(saved.syncDirectoryName, 'B');
  assert.equal(JSON.parse(next.files.get('c1.json')).title, 'Updated copy');
  assert.equal(JSON.parse(folder.files.get('c1.json')).title, 'Conversation');
});

test('an outbox commit failure rejects before writing a file or clearing the temporary record', async (t) => {
  const { database, browser, folder } = setup(t);
  browser.set('temporaryConversation', conversation());
  database.control.failNextWrite = true;
  await assert.rejects(promoteTemporaryConversation(conversation()), /quota/i);
  assert.ok(browser.has('temporaryConversation'));
  assert.equal(folder.files.size, 0);
  assert.equal((await listPendingConversationWrites()).length, 0);
});

test('promotion preserves a durable pending record before clearing temporary storage', async (t) => {
  const { browser, folder } = setup(t);
  browser.set('temporaryConversation', conversation());
  folder.permission = 'denied';
  const result = await promoteTemporaryConversation(conversation());
  assert.equal(result.syncStatus, 'pending');
  assert.equal(browser.has('temporaryConversation'), false);
  assert.equal((await loadConversation('c1')).messages[0].content, 'hello');
});

test('deleting a pending conversation prevents a later retry from recreating it', async (t) => {
  const { folder } = setup(t);
  folder.failWrite = true;
  await saveLocalConversation(conversation());
  folder.failWrite = false;
  await deleteSavedConversation(conversation());
  await retryPendingConversationWrites();
  assert.equal(folder.files.size, 0);
  assert.equal((await listPendingConversationWrites()).length, 0);
});

test('durable commits and unrelated sync progress while a same-conversation disk close stalls', async (t) => {
  const { folder, directory } = setup(t);
  const closing = deferred();
  const release = deferred();
  folder.beforeClose = async (id, text) => {
    if (id === 'c1.json' && JSON.parse(text).messages[0].content === 'old') {
      closing.resolve();
      await release.promise;
    }
  };
  try {
    const first = await within(commitConversationByStorage(conversation('old')), 'Durable commit waited for disk');
    assert.equal(first.syncStatus, 'pending');
    await within(closing.promise, 'Background sync did not start');
    const nextFolder = directory('B');
    globalThis.__unkAiDirectoryHandle = nextFolder;
    const newer = await within(commitConversationByStorage(conversation('new')), 'New revision waited for stalled writer');
    assert.equal(newer.syncStatus, 'pending');
    assert.equal(newer.syncDirectoryName, 'A');
    assert.equal((await loadConversation('c1')).messages[0].content, 'new');

    const other = await within(saveLocalConversation({ ...conversation('other'), id: 'c2' }), 'Unrelated sync waited for c1');
    assert.equal(other.syncStatus, 'synced');
    assert.equal(JSON.parse(nextFolder.files.get('c2.json')).messages[0].content, 'other');
    assert.equal(folder.files.has('c1.json'), false);

    // Timing out only ends this observer's wait; the old writer must retain
    // the file lock until close really settles, including across another panel.
    const otherPanel = await import(`../src/utils/conversation-store.js?stalled=${Date.now()}`);
    const retry = await within(otherPanel.flushConversationWrites({ timeoutMs: 10 }), 'Flush was not bounded');
    assert.equal(retry.pending, 1);
    assert.equal(retry.synced, 0);
    assert.equal((await flushConversationWrites({ timeoutMs: 10 })).pending, 1);
    assert.equal(folder.maxWriters.get('c1.json'), 1);
    assert.equal((await getPendingConversationWrite('c1')).conversation.messages[0].content, 'new');

    release.resolve();
    await within(otherPanel.flushConversationWrites({ timeoutMs: 200 }), 'Writer did not resume after release');
    const synced = await flushConversationWrites({ timeoutMs: 200 });
    assert.equal(synced.pending, 0);
    assert.equal(JSON.parse(folder.files.get('c1.json')).messages[0].content, 'new');
    assert.deepEqual(folder.writes.filter((write) => write.id === 'c1.json').map((write) => write.record.messages[0].content), ['old', 'new']);
    assert.equal(folder.maxWriters.get('c1.json'), 1);
    assert.equal(nextFolder.files.has('c1.json'), false);
  } finally {
    release.resolve();
    await flushConversationWrites({ timeoutMs: 200 });
  }
});

test('promotion can finish its durable commit while the previous revision is still syncing', async (t) => {
  const { browser, folder } = setup(t);
  const closing = deferred();
  const release = deferred();
  folder.beforeClose = async () => { closing.resolve(); await release.promise; };
  try {
    await commitConversationByStorage(conversation('old'));
    await within(closing.promise, 'Background sync did not start');
    browser.set('temporaryConversation', { ...conversation('promoted'), storage: 'temporary' });
    const promoted = await within(promoteTemporaryConversation(conversation('promoted'), { waitForSync: false }), 'Promotion waited for disk');
    assert.equal(promoted.storage, 'local');
    assert.equal(promoted.syncStatus, 'pending');
    assert.equal(browser.has('temporaryConversation'), false);
    assert.equal((await getPendingConversationWrite('c1')).conversation.messages[0].content, 'promoted');
  } finally {
    release.resolve();
    await flushConversationWrites({ timeoutMs: 200 });
  }
});

test('a failed durable commit rejects without starting sync or discarding temporary storage', async (t) => {
  const { browser, database, folder } = setup(t);
  browser.set('temporaryConversation', conversation());
  database.control.failNextWrite = true;
  await assert.rejects(promoteTemporaryConversation(conversation(), { waitForSync: false }), /quota/i);
  assert.equal(browser.has('temporaryConversation'), true);
  assert.equal(folder.maxWriters.size, 0);
  assert.equal((await listPendingConversationWrites()).length, 0);
});

test('temporary commits use browser storage without enqueueing a folder write', async (t) => {
  const { browser, folder } = setup(t);
  const saved = await commitConversationByStorage({ ...conversation('temporary'), storage: 'temporary' });
  assert.equal(saved.storage, 'temporary');
  assert.equal(browser.get('temporaryConversation').messages[0].content, 'temporary');
  assert.equal((await listPendingConversationWrites()).length, 0);
  assert.equal(folder.maxWriters.size, 0);
});

test('late acknowledgements and errors cannot erase or replace a newer outbox revision', async (t) => {
  const { folder } = setup(t);
  const older = await stageConversationWrite(conversation('old'), folder);
  const newer = await stageConversationWrite(conversation('new'), folder);
  assert.equal(await updatePendingConversationWrite({ ...older, error: 'Late disk failure' }), false);
  await acknowledgeConversationWrite(older.id, older.revision);
  const pending = await getPendingConversationWrite('c1');
  assert.equal(pending.revision, newer.revision);
  assert.equal(pending.conversation.messages[0].content, 'new');
  assert.equal(pending.error, '');
});

test('parallel durable commits retain each conversation when sync is unavailable', async (t) => {
  const { folder } = setup(t);
  folder.permission = 'denied';
  await Promise.all([
    commitConversationByStorage(conversation('one')),
    commitConversationByStorage({ ...conversation('two'), id: 'c2' }),
  ]);
  await flushConversationWrites();
  const pending = await listPendingConversationWrites();
  assert.deepEqual(pending.map((item) => item.id).sort(), ['c1', 'c2']);
});

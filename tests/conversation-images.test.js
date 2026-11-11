import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDirectory } from './helpers/memory-directory.js';
import { memoryIndexedDB } from './helpers/memory-indexeddb.js';
import { hydrateConversationImages } from '../src/utils/conversation-images.js';
import { readAllConversationRecords, readConversationRecord, writeConversationRecord } from '../src/utils/local-directory.js';
import { loadConversation, saveLocalConversation, retryPendingConversationWrites, trashSavedConversations, restoreTrashedConversations, listSavedConversations } from '../src/utils/conversation-store.js';
import { getPendingConversationWrite } from '../src/utils/conversation-outbox.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=';
const conversation = (id = 'images-c1') => ({ version: 2, id, storage: 'local', title: '图片测试', messages: [
  { id: 'u1', role: 'user', content: '分析图片', attachments: [{ id: 'img1', type: 'image', name: '参考.png', mime: 'image/png', dataUrl: PNG, width: 1, height: 1 }] },
] });
const image = record => record.messages[0].attachments[0];

function setup(t) {
  const folder = memoryDirectory('A');
  const browser = new Map();
  const globals = { indexedDB: memoryIndexedDB(), __unkAiDirectoryHandle: folder, chrome: { storage: { local: {
    async get(key) { return { [key]: browser.get(key) }; },
    async set(values) { for (const [key, value] of Object.entries(values)) browser.set(key, structuredClone(value)); },
    async remove(key) { browser.delete(key); },
  } } } };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  return folder;
}

test('disk JSON contains only versioned image paths; bytes round-trip without changing the live record', async t => {
  const folder = setup(t);
  const original = conversation();
  await writeConversationRecord(original, { directoryHandle: folder });
  const record = await readConversationRecord(original.id, { directoryHandle: folder });
  assert.equal(image(record).dataUrl, undefined);
  assert.equal(image(record).imageStorageVersion, 1);
  assert.match(image(record).imagePath, /^images\/[a-f0-9]{64}\.png$/);
  const json = await (await (await folder.getDirectoryHandle('conversations')).getFileHandle(`${original.id}.json`)).getFile();
  assert.doesNotMatch(await json.text(), /base64|data:image/);
  assert.equal(image(original).dataUrl, PNG);
  assert.equal(image(original).imagePath, undefined);
  assert.equal(image(await hydrateConversationImages(record, { directoryHandle: folder })).dataUrl, PNG);
  assert.ok(folder.control.writes[0].startsWith('images/'));
  assert.equal(folder.control.writes.at(-1), `conversations/${original.id}.json`);
});

test('identical pixels share one file and historical listing never reads image bytes', async t => {
  const folder = setup(t);
  await writeConversationRecord(conversation('images-a'), { directoryHandle: folder });
  await writeConversationRecord(conversation('images-b'), { directoryHandle: folder });
  assert.equal((await folder.getDirectoryHandle('images')).children.size, 1);
  assert.equal(folder.control.writes.filter(path => path.startsWith('images/')).length, 1);
  folder.control.beforeRead = async path => { assert.ok(!path.startsWith('images/'), 'list must not hydrate'); };
  assert.equal((await readAllConversationRecords({ directoryHandle: folder })).length, 2);
});

test('an image write failure preserves the previous JSON and durable pending pixels for retry in the original folder', async t => {
  const folder = setup(t);
  await saveLocalConversation({ ...conversation(), messages: [{ id: 'u0', role: 'user', content: 'old' }] });
  folder.control.failImages = true;
  const failed = await saveLocalConversation(conversation());
  assert.equal(failed.syncStatus, 'pending');
  assert.match(failed.syncError, /保存图片/);
  assert.equal((await readConversationRecord(failed.id, { directoryHandle: folder })).messages[0].content, 'old');
  assert.equal(image((await getPendingConversationWrite(failed.id)).conversation).dataUrl, PNG);
  const other = memoryDirectory('B');
  globalThis.__unkAiDirectoryHandle = other;
  folder.control.failImages = false;
  assert.equal((await retryPendingConversationWrites()).synced, 1);
  assert.equal(other.children.size, 0);
  const loaded = await hydrateConversationImages(await readConversationRecord(failed.id, { directoryHandle: folder }), { directoryHandle: folder });
  assert.equal(image(loaded).dataUrl, PNG);
});

test('old inline records hydrate unchanged and migrate to paths on the next normal save', async t => {
  const folder = setup(t);
  const original = conversation();
  const directory = await folder.getDirectoryHandle('conversations', { create: true });
  const file = await directory.getFileHandle(`${original.id}.json`, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(original));
  await writable.close();
  assert.equal(image(await loadConversation(original.id)).dataUrl, PNG);
  assert.equal((await saveLocalConversation(await loadConversation(original.id))).syncStatus, 'synced');
  assert.equal(image(await readConversationRecord(original.id, { directoryHandle: folder })).dataUrl, undefined);
});

test('missing, corrupted, unsupported and escaping image paths stay visible without reading outside images', async t => {
  const folder = setup(t);
  await writeConversationRecord(conversation(), { directoryHandle: folder });
  const record = await readConversationRecord('images-c1', { directoryHandle: folder });
  const images = await folder.getDirectoryHandle('images');
  const filename = image(record).imagePath.split('/')[1];
  images.children.get(filename).blob = new Blob(['different bytes']);
  assert.match(image(await hydrateConversationImages(record, { directoryHandle: folder })).loadError, /变化或损坏/);
  images.children.delete(filename);
  assert.match(image(await loadConversation(record.id)).loadError, /缺失/);
  assert.equal((await listSavedConversations()).length, 1, 'missing pixels do not hide history');
  let lookedUp = false;
  const forbidden = { queryPermission: async () => 'granted', getDirectoryHandle: async () => { lookedUp = true; throw new Error('unexpected'); } };
  image(record).imagePath = '../private.png';
  assert.match(image(await hydrateConversationImages(record, { directoryHandle: forbidden })).loadError, /路径无效/);
  assert.equal(lookedUp, false);
  image(record).imageStorageVersion = 99;
  assert.match(image(await hydrateConversationImages(record, { directoryHandle: forbidden })).loadError, /版本不受支持/);
});

test('trash and undo preserve shared images and restore paths in the bound folder', async t => {
  const folder = setup(t);
  await saveLocalConversation(conversation());
  const disk = await readConversationRecord('images-c1', { directoryHandle: folder });
  const deletion = await trashSavedConversations(['images-c1']);
  assert.deepEqual(deletion.deletedIds, ['images-c1']);
  assert.equal((await folder.getDirectoryHandle('images')).children.size, 1);
  globalThis.__unkAiDirectoryHandle = memoryDirectory('B');
  assert.deepEqual((await restoreTrashedConversations(deletion.token)).restoredIds, ['images-c1']);
  globalThis.__unkAiDirectoryHandle = folder;
  assert.equal(image(await loadConversation('images-c1')).dataUrl, PNG);
  assert.equal(image(await readConversationRecord('images-c1', { directoryHandle: folder })).imagePath, image(disk).imagePath);
});

test('a stalled image close keeps the writer lock, leaves JSON uncommitted, and cannot acknowledge a newer revision', async t => {
  const folder = setup(t);
  let resume, started;
  const gate = new Promise(resolve => { resume = resolve; });
  const reached = new Promise(resolve => { started = resolve; });
  let stalled = false;
  folder.control.beforeClose = async path => {
    if (path.startsWith('images/') && !stalled) { stalled = true; started(); await gate; }
  };
  const saving = saveLocalConversation(conversation(), { timeoutMs: 10 });
  await reached;
  assert.equal((await saving).syncStatus, 'pending');
  assert.equal(folder.children.has('conversations'), false, 'JSON cannot precede image close');
  const newer = conversation();
  newer.messages[0].content = 'newer';
  assert.equal((await saveLocalConversation(newer, { timeoutMs: 10 })).syncStatus, 'pending');
  resume();
  assert.equal((await retryPendingConversationWrites()).synced, 1);
  assert.equal((await readConversationRecord(newer.id, { directoryHandle: folder })).messages[0].content, 'newer');
  assert.equal(image(await loadConversation(newer.id)).dataUrl, PNG);
  assert.equal(await getPendingConversationWrite(newer.id), null);
});

test('hydration fixes the directory before waiting and a revoked permission produces a visible attachment error', async t => {
  const folder = setup(t);
  await writeConversationRecord(conversation(), { directoryHandle: folder });
  const record = await readConversationRecord('images-c1', { directoryHandle: folder });
  let resume, reached;
  const gate = new Promise(resolve => { resume = resolve; });
  const reading = new Promise(resolve => { reached = resolve; });
  folder.control.beforeRead = async path => { if (path.startsWith('images/')) { reached(); await gate; } };
  const pending = loadConversation(record.id);
  await reading;
  const other = memoryDirectory('B');
  globalThis.__unkAiDirectoryHandle = other;
  resume();
  assert.equal(image(await pending).dataUrl, PNG);
  assert.equal(other.children.size, 0);
  folder.control.permission = 'denied';
  assert.match(image(await hydrateConversationImages(record, { directoryHandle: folder })).loadError, /授权已失效/);
});

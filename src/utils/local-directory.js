import { externalizeConversationImages } from './conversation-images.js';

const DB_NAME = 'unk-ai-file-storage';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'conversation-directory';
const META_KEY = 'storageDirectoryMeta';
const CONVERSATION_DIR = 'conversations';

function indexedDbAvailable() {
  return typeof globalThis.indexedDB !== 'undefined';
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!indexedDbAvailable()) {
      reject(new Error('当前浏览器不支持本地文件夹存储。'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地存储数据库。'));
  });
}

async function readHandle() {
  if (!indexedDbAvailable()) return null;
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('无法读取本地存储权限。'));
    });
  } finally {
    database.close();
  }
}

async function writeHandle(handle) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const request = transaction.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
      transaction.oncomplete = () => resolve(true);
      transaction.onabort = () => reject(transaction.error || new Error('保存本地存储权限的事务已取消。'));
      transaction.onerror = () => reject(transaction.error || new Error('无法保存本地存储权限。'));
      request.onerror = () => reject(request.error || new Error('无法保存本地存储权限。'));
    });
  } finally {
    database.close();
  }
}

async function writeDirectoryMeta(meta) {
  const area = globalThis.chrome?.storage?.local;
  if (!area) return;
  await area.set({ [META_KEY]: meta });
}

export function directoryPickerSupported() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

export function conversationFilename(id) {
  const safe = String(id || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  if (!safe) throw new Error('会话 ID 无效。');
  return `${safe}.json`;
}

async function permissionFor(handle, { request = false } = {}) {
  if (!handle) return 'denied';
  try {
    const options = { mode: 'readwrite' };
    let permission = await handle.queryPermission(options);
    if (permission === 'prompt' && request) permission = await handle.requestPermission(options);
    return permission;
  } catch {
    return 'denied';
  }
}

/** Read the shared selection before consulting the document's session cache. */
export async function getConversationDirectoryHandle() {
  const handle = await readHandle() || globalThis.__unkAiDirectoryHandle || null;
  if (handle) globalThis.__unkAiDirectoryHandle = handle;
  return handle;
}

export async function getConversationDirectory({ requestPermission = false } = {}) {
  const handle = await getConversationDirectoryHandle();
  if (!handle) return null;
  const permission = await permissionFor(handle, { request: requestPermission });
  if (permission === 'granted') globalThis.__unkAiDirectoryHandle = handle;
  return permission === 'granted' ? handle : null;
}

export async function getDirectoryInfo() {
  if (typeof globalThis.showDirectoryPicker !== 'function') {
    return { supported: false, configured: false, permission: 'unsupported' };
  }
  const handle = await getConversationDirectoryHandle();
  const permission = await permissionFor(handle);
  const granted = permission === 'granted';
  if (granted && handle) globalThis.__unkAiDirectoryHandle = handle;
  return {
    supported: true,
    configured: Boolean(handle),
    permission,
    granted,
    name: handle?.name || '',
  };
}

export async function chooseConversationDirectory() {
  if (!directoryPickerSupported()) {
    throw new Error('当前浏览器不支持选择本地文件夹，请使用最新版 Chrome。');
  }
  const handle = await globalThis.showDirectoryPicker({
    id: 'unk-ai-conversations',
    mode: 'readwrite',
    startIn: 'documents',
  });
  const permission = await permissionFor(handle, { request: true });
  if (permission !== 'granted') throw new Error('没有获得该文件夹的读写权限。');
  await writeHandle(handle);
  globalThis.__unkAiDirectoryHandle = handle;
  const meta = {
    name: handle.name || '已选择的文件夹',
    permission,
    configuredAt: new Date().toISOString(),
  };
  await writeDirectoryMeta(meta);
  return meta;
}

/**
 * Re-request access to the shared folder selection from a user gesture.
 */
export async function requestDirectoryPermission() {
  const handle = await getConversationDirectoryHandle();
  if (!handle) return false;
  return permissionFor(handle, { request: true }).then((permission) => permission === 'granted');
}

/**
 * Restore permission for the already chosen folder without asking the user to
 * pick it again. Must be called from a user gesture (for example a click).
 */
export async function restoreConversationDirectory() {
  const handle = await getConversationDirectoryHandle();
  if (!handle) return null;
  const permission = await permissionFor(handle, { request: true });
  if (permission !== 'granted') return null;
  await writeHandle(handle);
  globalThis.__unkAiDirectoryHandle = handle;
  const meta = {
    name: handle.name || '本地文件夹',
    permission,
    granted: true,
    configuredAt: new Date().toISOString(),
  };
  await writeDirectoryMeta(meta);
  return meta;
}

export async function refreshDirectoryMeta() {
  const info = await getDirectoryInfo();
  const meta = {
    name: info.name || '',
    permission: info.permission,
    granted: info.granted,
    configuredAt: new Date().toISOString(),
  };
  if (info.configured) await writeDirectoryMeta(meta);
  return info;
}

async function conversationRoot({ directoryHandle } = {}) {
  const root = directoryHandle === undefined ? await getConversationDirectory() : directoryHandle;
  if (!root) throw new Error('请先在设置中选择本地对话存储位置。');
  if (await permissionFor(root) !== 'granted') throw new Error(`“${root.name || '本地文件夹'}”的读写授权已失效。`);
  return root;
}

async function conversationsDirectory({ create = false, directoryHandle } = {}) {
  const root = await conversationRoot({ directoryHandle });
  return root.getDirectoryHandle(CONVERSATION_DIR, { create });
}

export async function writeConversationRecord(conversation, { directoryHandle } = {}) {
  if (!conversation?.id) throw new Error('无法写入没有 ID 的会话。');
  const root = await conversationRoot({ directoryHandle });
  // Finish all image writes before replacing the JSON. On failure, the outbox
  // retains the complete pixels and the previous conversation file stays valid.
  const record = await externalizeConversationImages(conversation, { directoryHandle: root });
  const directory = await conversationsDirectory({ create: true, directoryHandle: root });
  const file = await directory.getFileHandle(conversationFilename(conversation.id), { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(JSON.stringify(record, null, 2));
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  }
  return true;
}

export async function readConversationRecord(id, { directoryHandle } = {}) {
  try {
    const directory = await conversationsDirectory({ directoryHandle });
    const file = await directory.getFileHandle(conversationFilename(id));
    return JSON.parse(await (await file.getFile()).text());
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.message?.includes('本地对话存储位置')) return null;
    throw new Error(`读取本地会话失败：${error.message || '文件不可用'}`);
  }
}

export async function deleteConversationRecord(id, { directoryHandle } = {}) {
  try {
    const directory = await conversationsDirectory({ directoryHandle });
    await directory.removeEntry(conversationFilename(id));
    return true;
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.message?.includes('本地对话存储位置')) return false;
    throw new Error(`删除本地会话失败：${error.message || '文件不可用'}`);
  }
}

export async function readAllConversationRecords({ directoryHandle } = {}) {
  let directory;
  try {
    directory = await conversationsDirectory({ directoryHandle });
  } catch {
    return [];
  }
  const records = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await (await handle.getFile()).text());
      if (record?.id && Array.isArray(record.messages)) records.push(record);
    } catch {
      // A malformed single file must not prevent the remaining history loading.
    }
  }
  return records;
}


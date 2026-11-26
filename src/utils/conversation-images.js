import { awaitWithTimeout } from './abortable.js';

export const IMAGE_STORAGE_VERSION = 1;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_WAIT_MS = 5000;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME_TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([mime, extension]) => [extension, mime]));
const IMAGE_PATH = /^images\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/;
const IMAGE_FILENAME = /^([a-f0-9]{64})\.(png|jpg|webp|gif)$/;

function imageAttachments(conversation) {
  return (conversation.messages || []).flatMap(message => Array.isArray(message?.attachments)
    ? message.attachments.filter(attachment => attachment?.type === 'image') : []);
}

function imageWait(promise) {
  return awaitWithTimeout(promise, { timeoutMs: IMAGE_WAIT_MS, message: '读取或保存本地图片超时，请检查原数据文件夹。' });
}

async function digest(bytes) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function decodeImage(dataUrl) {
  const matched = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!matched) throw new Error('图片数据格式无效。');
  const encoded = matched[2].replace(/\s/g, '');
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('本地图片不能超过 8 MiB。');
  let binary;
  try { binary = atob(encoded); } catch { throw new Error('图片 Base64 数据已损坏。'); }
  if (!binary.length || binary.length > MAX_IMAGE_BYTES) throw new Error('本地图片为空或超过 8 MiB。');
  const mime = matched[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  return { mime, bytes: Uint8Array.from(binary, character => character.charCodeAt(0)) };
}

function encodeImage(bytes, mime) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return `data:${mime};base64,${btoa(chunks.join(''))}`;
}

function parsedPath(attachment) {
  if (attachment.imageStorageVersion !== IMAGE_STORAGE_VERSION) throw new Error('本地图片存储版本不受支持。');
  const matched = IMAGE_PATH.exec(String(attachment.imagePath || ''));
  if (!matched) throw new Error('本地图片路径无效，必须位于原数据文件夹的 images/ 中。');
  return { hash: matched[1], filename: `${matched[1]}.${matched[2]}`, mime: MIME_TYPES[matched[2]] };
}

async function readImage(directory, path) {
  const handle = await directory.getFileHandle(path.filename);
  const file = await handle.getFile();
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error('本地图片为空或超过 8 MiB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (await digest(bytes) !== path.hash) throw new Error('本地图片内容已变化或损坏。');
  return { bytes, mime: path.mime };
}

async function writeImage(directory, path, bytes) {
  try {
    // Content-addressed files can be shared by retries and different messages.
    await readImage(directory, path);
    return;
  } catch (error) {
    if (error.name !== 'NotFoundError' && !/本地图片.*(?:为空|变化|损坏)/.test(error.message)) throw error;
  }
  const file = await directory.getFileHandle(path.filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  }
}

/** Keep browser/outbox pixels intact; only the disk clone contains paths. */
export async function externalizeConversationImages(conversation, { directoryHandle } = {}) {
  const copy = structuredClone(conversation);
  const attachments = imageAttachments(copy);
  if (!attachments.length) return copy;
  if (!directoryHandle) throw new Error('没有可用的原图片存储目录。');
  const directory = await directoryHandle.getDirectoryHandle('images', { create: true });
  const written = new Set();
  for (const attachment of attachments) {
    try {
      if (attachment.dataUrl) {
        const { bytes, mime } = decodeImage(attachment.dataUrl);
        const hash = await digest(bytes);
        const filename = `${hash}.${EXTENSIONS[mime]}`;
        // The existing store bounds the caller's wait while its writer keeps
        // the conversation lock until all non-cancellable writes finish.
        if (!written.has(filename)) await writeImage(directory, { filename, hash, mime }, bytes);
        written.add(filename);
        attachment.imagePath = `images/${filename}`;
        attachment.imageStorageVersion = IMAGE_STORAGE_VERSION;
        attachment.mime = mime;
      } else {
        const path = parsedPath(attachment);
        if (!written.has(path.filename)) await imageWait(readImage(directory, path));
        written.add(path.filename);
      }
      delete attachment.dataUrl;
      delete attachment.loadError;
    } catch (error) {
      throw new Error(`保存图片“${attachment.name || '图片'}”失败：${error.message || '原图片文件不可用'}`);
    }
  }
  return copy;
}

/** Hydrate one opened conversation, never every item in the history list. */
export async function hydrateConversationImages(conversation, { directoryHandle } = {}) {
  const copy = structuredClone(conversation);
  const attachments = imageAttachments(copy).filter(attachment => attachment.imagePath && !attachment.dataUrl);
  const reads = new Map();
  await Promise.all(attachments.map(async attachment => {
    try {
      const path = parsedPath(attachment);
      if (!directoryHandle) throw new Error('原图片存储目录不可用，请恢复原文件夹权限。');
      if (!reads.has(attachment.imagePath)) {
        reads.set(attachment.imagePath, imageWait((async () => {
          if (await directoryHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('原图片文件夹授权已失效。');
          const directory = await directoryHandle.getDirectoryHandle('images');
          const { bytes, mime } = await readImage(directory, path);
          return encodeImage(bytes, mime);
        })()));
      }
      attachment.dataUrl = await reads.get(attachment.imagePath);
      delete attachment.loadError;
    } catch (error) {
      attachment.loadError = `无法读取图片“${attachment.name || '图片'}”（${attachment.imagePath}）：${error.name === 'NotFoundError' ? '原图片文件缺失，请恢复 images 文件夹或重新添加图片。' : error.message || '文件不可用'}`;
    }
  }));
  return copy;
}

function mergeInto(target, source) {
  for (const item of source) target.add(item);
}

/** Collect referenced content-addressed image filenames from one conversation. */
export async function collectConversationImageFilenames(conversation, { includeDataUrlHashes = false, onlyWithoutDataUrl = false } = {}) {
  const filenames = new Set();
  for (const attachment of imageAttachments(conversation || {})) {
    if (onlyWithoutDataUrl && attachment.dataUrl) continue;
    if (attachment.imagePath) {
      const matched = IMAGE_PATH.exec(String(attachment.imagePath));
      if (matched) filenames.add(`${matched[1]}.${matched[2]}`);
    }
    if (includeDataUrlHashes && attachment.dataUrl) {
      try {
        const { bytes, mime } = decodeImage(attachment.dataUrl);
        const hash = await digest(bytes);
        filenames.add(`${hash}.${EXTENSIONS[mime]}`);
      } catch {
        // Ignore malformed inline dataUrls when collecting references for GC.
      }
    }
  }
  return filenames;
}

/** Delete unreferenced SHA-256 image files in `images/` when all live roots verify cleanly. */
export async function pruneUnusedConversationImages({ directoryHandle, getLiveRoots } = {}) {
  if (!directoryHandle) return { deleted: 0, failed: 0, skipped: true, reason: 'no-directory' };
  let permission;
  try {
    permission = await directoryHandle.queryPermission({ mode: 'readwrite' });
  } catch {
    permission = 'denied';
  }
  if (permission !== 'granted') return { deleted: 0, failed: 0, skipped: true, reason: 'permission-denied' };

  let imagesDir;
  try {
    imagesDir = await directoryHandle.getDirectoryHandle('images');
  } catch (error) {
    if (error?.name === 'NotFoundError') return { deleted: 0, failed: 0, skipped: false };
    return { deleted: 0, failed: 0, skipped: true, reason: 'images-unreadable' };
  }

  const candidates = [];
  try {
    for await (const [name, handle] of imagesDir.entries()) {
      if (handle?.kind === 'file' && IMAGE_FILENAME.test(name)) candidates.push(name);
    }
  } catch {
    return { deleted: 0, failed: 0, skipped: true, reason: 'images-unreadable' };
  }
  if (!candidates.length) return { deleted: 0, failed: 0, skipped: false };

  const { pendingWrites = [], trashedDeletions = [], temporaryConversation = null } = (await getLiveRoots?.()) || {};
  const referenced = new Set();
  for (const entry of pendingWrites) {
    mergeInto(referenced, await collectConversationImageFilenames(entry?.conversation, { includeDataUrlHashes: true }));
  }
  for (const entry of trashedDeletions) {
    if (entry && entry.state !== 'restored' && entry.conversation) {
      mergeInto(referenced, await collectConversationImageFilenames(entry.conversation, { includeDataUrlHashes: false, onlyWithoutDataUrl: true }));
    }
  }
  if (temporaryConversation) {
    mergeInto(referenced, await collectConversationImageFilenames(temporaryConversation, { includeDataUrlHashes: true }));
  }

  let conversationsDir = null;
  try {
    conversationsDir = await directoryHandle.getDirectoryHandle('conversations');
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      return { deleted: 0, failed: 0, skipped: true, reason: 'conversations-unreadable' };
    }
  }

  if (conversationsDir) {
    try {
      for await (const [name, handle] of conversationsDir.entries()) {
        if (handle?.kind !== 'file' || !name.endsWith('.json')) continue;
        let record;
        try {
          record = JSON.parse(await (await handle.getFile()).text());
        } catch {
          return { deleted: 0, failed: 0, skipped: true, reason: 'corrupt-conversation-record' };
        }
        if (!record || typeof record !== 'object') {
          return { deleted: 0, failed: 0, skipped: true, reason: 'corrupt-conversation-record' };
        }
        mergeInto(referenced, await collectConversationImageFilenames(record, { includeDataUrlHashes: false }));
      }
    } catch {
      return { deleted: 0, failed: 0, skipped: true, reason: 'conversations-unreadable' };
    }
  }

  let deleted = 0;
  let failed = 0;
  for (const filename of candidates) {
    if (referenced.has(filename)) continue;
    try {
      await imagesDir.removeEntry(filename);
      deleted += 1;
    } catch (error) {
      if (error?.name !== 'NotFoundError') failed += 1;
    }
  }
  return { deleted, failed, skipped: false };
}

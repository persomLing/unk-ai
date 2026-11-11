import { awaitWithTimeout } from './abortable.js';

export const IMAGE_STORAGE_VERSION = 1;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_WAIT_MS = 5000;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME_TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([mime, extension]) => [extension, mime]));
const IMAGE_PATH = /^images\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/;

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

import { readPdfFromFile } from './pdf-reader.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'log',
]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;
const MAX_DOCUMENT_CHARS = 50_000;

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function extensionOf(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function tooLarge(size, limit, label) {
  return size > limit ? new Error(`${label}不能超过 ${Math.round(limit / 1024 / 1024)} MB。`) : null;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('无法读取这个文件。'));
    reader.readAsDataURL(file);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解码这张图片。'));
    image.src = source;
  });
}

async function prepareImage(file) {
  const error = tooLarge(file.size, MAX_IMAGE_BYTES, '图片');
  if (error) throw error;
  const original = await readAsDataUrl(file);
  const image = await loadImage(original);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  if (scale === 1 && file.size <= 700 * 1024) {
    return {
      id: makeId(),
      type: 'image',
      name: file.name || '图片',
      mime: file.type,
      size: file.size,
      dataUrl: original,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法处理这张图片。');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const dataUrl = canvas.toDataURL(mime, 0.8);
  return {
    id: makeId(),
    type: 'image',
    name: file.name || '图片',
    mime,
    size: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
    dataUrl,
    width: canvas.width,
    height: canvas.height,
  };
}

function decodeXmlText(xml) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('DOCX 内容无法解析。');
  return Array.from(document.getElementsByTagNameNS('*', 'p'))
    .map((paragraph) => Array.from(paragraph.getElementsByTagNameNS('*', 't'))
      .map((node) => node.textContent || '')
      .join(''))
    .filter((line) => line.trim())
    .join('\n');
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 DOCX 解压，请升级 Chrome 后重试。');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readDocx(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('这不是有效的 DOCX 文件。');

  const decoder = new TextDecoder();
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  let target = null;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (name === 'word/document.xml') {
      target = { method, compressedSize, localOffset };
      break;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!target) {
    throw new Error('DOCX 中没有可读取的正文。');
  }
  if (target.localOffset + 30 > bytes.length || view.getUint32(target.localOffset, true) !== 0x04034b50) {
    throw new Error('DOCX 文件结构不完整。');
  }
  const localNameLength = view.getUint16(target.localOffset + 26, true);
  const localExtraLength = view.getUint16(target.localOffset + 28, true);
  const dataStart = target.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = bytes.slice(dataStart, dataStart + target.compressedSize);
  let xmlBytes;
  if (target.method === 0) xmlBytes = compressed;
  else if (target.method === 8) xmlBytes = await inflateRaw(compressed);
  else throw new Error('DOCX 使用了不支持的压缩方式。');
  return decodeXmlText(new TextDecoder().decode(xmlBytes));
}

function stripHtml(html) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  document.querySelectorAll('script, style, noscript, template').forEach((node) => node.remove());
  return document.body?.innerText || document.body?.textContent || '';
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function prepareDocument(file) {
  const extension = extensionOf(file.name);
  if (extension === 'pdf' || file.type === 'application/pdf') {
    const pdfError = tooLarge(file.size, MAX_PDF_BYTES, 'PDF');
    if (pdfError) throw pdfError;
    const pdf = await readPdfFromFile(file, { maxBudget: MAX_DOCUMENT_CHARS });
    return {
      id: makeId(),
      type: 'document',
      name: file.name || 'document.pdf',
      mime: file.type || 'application/pdf',
      size: file.size,
      text: pdf.text,
      truncated: pdf.truncated,
      chars: pdf.chars,
      pages: pdf.structure?.pdf?.pageCount || 0,
      pagesRead: pdf.structure?.pdf?.pagesRead || 0,
    };
  }
  const error = tooLarge(file.size, MAX_DOCUMENT_BYTES, '文档');
  if (error) throw error;
  let text = '';
  if (extension === 'docx') {
    text = await readDocx(file);
  } else if (TEXT_EXTENSIONS.has(extension)) {
    const raw = await file.text();
    text = ['html', 'htm', 'xml'].includes(extension) ? stripHtml(raw) : raw;
  } else {
    throw new Error('暂不支持这个文档格式，请选择 TXT、Markdown、CSV、JSON、DOCX 或 PDF。');
  }
  text = cleanText(text);
  if (!text) throw new Error('这个文档没有可读取的文字。');
  const truncated = text.length > MAX_DOCUMENT_CHARS;
  if (truncated) text = text.slice(0, MAX_DOCUMENT_CHARS);
  return {
    id: makeId(),
    type: 'document',
    name: file.name || '文档',
    mime: file.type || 'application/octet-stream',
    size: file.size,
    text,
    truncated,
    chars: text.length,
  };
}

export async function prepareAttachment(file, kind) {
  if (!(file instanceof File)) throw new Error('没有选择文件。');
  if (kind === 'image') {
    const extension = extensionOf(file.name);
    if (!IMAGE_TYPES.has(file.type) && !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
      throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片。');
    }
    return prepareImage(file);
  }
  return prepareDocument(file);
}

export function prepareImageDataUrl(dataUrl, {
  name = '网页截图.jpg',
  pageTitle = '',
  pageUrl = '',
  source = 'page-capture',
} = {}) {
  const safe = safeAttachmentDataUrl(dataUrl);
  if (!safe) throw new Error('截图格式不受支持。');
  const comma = safe.indexOf(',');
  const base64 = comma >= 0 ? safe.slice(comma + 1) : '';
  if (!base64) throw new Error('截图内容为空。');
  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'image',
    name,
    mime: safe.slice(5, safe.indexOf(';')),
    size: Math.round(base64.length * 0.75),
    dataUrl: safe,
    source,
    pageTitle,
    pageUrl,
  };
}

export function safeAttachmentDataUrl(value) {
  const url = String(value || '');
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(url) ? url : '';
}

/** Hydrated or recoverable pixels take precedence over an earlier disk error. */
export function imageAttachmentLoadError(attachment) {
  if (attachment?.type !== 'image' || safeAttachmentDataUrl(attachment.dataUrl)) return '';
  const name = String(attachment.name || '图片');
  const reason = String(attachment.loadError || '').trim() || '图片内容不可用，请重新添加原图片。';
  return `图片“${name}”不可用：${reason}`;
}

export function assertImageAttachmentsAvailable(attachments) {
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const message = imageAttachmentLoadError(attachment);
    if (!message) continue;
    const error = new Error(message);
    error.code = 'ERR_IMAGE_ATTACHMENT_UNAVAILABLE';
    throw error;
  }
}

export function attachmentContext(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.length) return message.content;
  const references = attachments.map((attachment) => {
    if (attachment.type === 'document') {
      const name = String(attachment.name).replace(/[<>&"]/g, (character) => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
      })[character]);
      return `\n\n<attachment name="${name}">\n${attachment.text || ''}\n</attachment>`;
    }
    return `\n\n[用户附带了图片：${attachment.name}]`;
  }).join('');
  return `${message.content}${references}`;
}

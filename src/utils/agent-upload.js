import { MAX_AGENT_REFERENCE_BYTES, normalizeAgentReferenceImages } from './agent-reference-images.js';

const extensions = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' });
const error = (code, message) => Object.assign(new Error(message), { code });
const scopeError = () => error('ERR_UPLOAD_SCOPE', '参考图片不属于当前有效任务或页面目标，请核对后继续。');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const mimeAllowed = value => Object.hasOwn(extensions, value);

function httpUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw scopeError();
    return parsed;
  } catch { throw scopeError(); }
}

function safeName(value, mime, index) {
  const basename = String(value || '').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const stem = basename.replace(/\.[^.]*$/, '').replace(/^\.+|\.+$/g, '').slice(0, 110) || `reference-${index + 1}`;
  return `${stem}${extensions[mime]}`;
}

const metadata = entry => entry.references.map(({ referenceId, name, mime, size }) => ({ referenceId, name, mime, size }));

/** The registry owns task-submitted bytes only. Nothing is loaded from paths or URLs, or persisted. */
export function createAgentUploadRegistry() {
  const entries = new Map();

  function clear(taskId) {
    const entry = entries.get(taskId);
    if (!entry) return;
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entries.delete(taskId);
  }

  function register({ taskId, epoch, tabId, url, referenceImages = [], signal } = {}) {
    if (!validId(taskId) || !Number.isInteger(epoch) || epoch <= 0 || !Number.isInteger(tabId) || tabId < 0 || signal?.aborted) throw scopeError();
    const origin = httpUrl(url).origin;
    const references = normalizeAgentReferenceImages(referenceImages).map((value, index) => ({
      referenceId: `reference-${index + 1}`, name: safeName(value.name, value.mime, index), mime: value.mime, size: value.size,
      base64: value.dataUrl.slice(value.dataUrl.indexOf(',') + 1),
    }));
    const previous = entries.get(taskId);
    if (previous) {
      if (previous.tabId !== tabId || previous.origin !== origin || epoch < previous.epoch) throw scopeError();
      if (previous.epoch === epoch) {
        if (JSON.stringify(previous.references) !== JSON.stringify(references) || previous.signal?.aborted) throw scopeError();
        return metadata(previous);
      }
      clear(taskId);
    }
    const entry = { taskId, epoch, tabId, origin, references, signal };
    entry.onAbort = () => { if (entries.get(taskId) === entry) clear(taskId); };
    entries.set(taskId, entry);
    signal?.addEventListener('abort', entry.onAbort, { once: true });
    return metadata(entry);
  }

  function entryFor({ taskId, epoch, tabId, url, signal } = {}) {
    const entry = entries.get(taskId);
    if (!entry || entry.epoch !== epoch || entry.tabId !== tabId || entry.signal?.aborted || signal?.aborted
      || httpUrl(url).origin !== entry.origin) throw scopeError();
    return entry;
  }

  function list(identity) { return metadata(entryFor(identity)); }

  function resolve(identity = {}) {
    const entry = entryFor(identity);
    const { taskId, epoch, tabId, url, frameId, frameOrigin, frameUrl, documentId, snapshotId, elementId, referenceId } = identity;
    if (!Number.isInteger(frameId) || frameId < 0 || frameOrigin !== entry.origin || httpUrl(frameUrl).origin !== entry.origin
      || !validId(snapshotId) || !validId(elementId) || (documentId != null && !validId(documentId))) throw scopeError();
    const reference = entry.references.find(value => value.referenceId === referenceId);
    if (!reference) throw scopeError();
    const payload = { ...reference, target: { taskId, epoch, tabId, url, frameId, frameOrigin, frameUrl, snapshotId, elementId,
      ...(documentId ? { documentId } : {}) } };
    validateAgentUploadPayload(payload);
    return payload;
  }

  return { register, list, resolve, clear };
}

export function acceptsAgentUpload(accept, reference) {
  if (!mimeAllowed(reference?.mime)) return false;
  const filters = String(accept || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
  const extension = extensions[reference.mime];
  return !filters.length || filters.some(value => value === 'image/*' || value === reference.mime || value === extension
    || (reference.mime === 'image/jpeg' && value === '.jpeg'));
}

/** Validate before execution. MIME declaration alone does not make arbitrary bytes an image. */
export function validateAgentUploadPayload(payload) {
  const invalid = () => error('ERR_UPLOAD_INVALID', '参考图片数据无效或格式不匹配，请重新添加 PNG、JPG、WebP 或 GIF 图片。');
  if (!payload || !/^reference-[1-3]$/.test(payload.referenceId || '') || !mimeAllowed(payload.mime)
    || typeof payload.name !== 'string' || payload.name.length < 1 || payload.name.length > 120
    || /[\\/\u0000-\u001f\u007f]/.test(payload.name) || !payload.name.toLowerCase().endsWith(extensions[payload.mime])
    || typeof payload.base64 !== 'string' || payload.base64.length % 4 !== 0
    || payload.base64.length > Math.ceil(MAX_AGENT_REFERENCE_BYTES * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.base64)) throw invalid();
  const size = payload.base64.length * 3 / 4 - (payload.base64.endsWith('==') ? 2 : payload.base64.endsWith('=') ? 1 : 0);
  if (!Number.isInteger(payload.size) || payload.size !== size || size <= 0 || size > MAX_AGENT_REFERENCE_BYTES) throw invalid();
  let header;
  try { header = atob(payload.base64.slice(0, 24)); } catch { throw invalid(); }
  const valid = payload.mime === 'image/png' ? header.startsWith('\x89PNG\r\n\x1a\n')
    : payload.mime === 'image/jpeg' ? header.startsWith('\xff\xd8\xff')
      : payload.mime === 'image/gif' ? /^GIF8[79]a/.test(header)
        : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  if (!valid) throw invalid();
  return true;
}

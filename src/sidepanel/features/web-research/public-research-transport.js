import { awaitWithAbort } from '../../../utils/abortable.js';
import { parseSearchResults } from './web-research.js';
import { publicResearchUrl } from './research-tools.js';

const MAX_BYTES = 128 * 1024;
const MAX_BODY_CHARS = 8000;
const TIMEOUT_MS = 12000;

function entities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] || whole;
    const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}

function textOf(value) {
  return entities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function pageOf(raw, type) {
  if (type.includes('text/plain')) return { title: '', content: raw.trim() };
  const title = textOf(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '').slice(0, 200);
  const inert = raw.replace(/<!--[\s\S]*?-->|<(head|script|style|nav|header|footer|form|aside|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  return { title, content: textOf(inert) };
}

async function boundedBody(response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('公开网页没有可读取的响应正文。');
  const chunks = [];
  let size = 0, truncated = false;
  try {
    while (size < MAX_BYTES) {
      signal.throwIfAborted();
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      const bytes = value.subarray(0, MAX_BYTES - size);
      chunks.push(bytes); size += bytes.byteLength;
      if (value.byteLength > bytes.byteLength || size >= MAX_BYTES) { truncated = true; break; }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const utf8 = new TextDecoder().decode(bytes);
    const charset = String(response.headers?.get?.('content-type') || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
      || utf8.match(/<meta\b[^>]*charset\s*=\s*["']?([^"'\s/>]+)/i)?.[1] || 'utf-8';
    let text = utf8;
    try { text = new TextDecoder(charset).decode(bytes); } catch { /* Keep UTF-8 when the declared charset is unsupported. */ }
    return { text, truncated };
  } finally {
    // Cancellation must not wait for a non-cooperating stream's cleanup.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

/** Low-level public fallback: one model-selected query or page per call. It
 * neither chooses follow-up work nor controls the user's current browser tab. */
export function createPublicResearchTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('公开检索需要 fetch。');

  async function request(url, { signal, deadlineAt } = {}) {
    const target = publicResearchUrl(url);
    if (!target) throw new TypeError('公开检索只接受公开 HTTP/HTTPS 地址。');
    if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) throw new TypeError('公开检索截止时间无效。');
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason || new DOMException('公开检索已停止。', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const remaining = Math.min(TIMEOUT_MS, deadlineAt === undefined ? Infinity : deadlineAt - Date.now());
    if (remaining <= 0) controller.abort(new DOMException('公开检索超时。', 'TimeoutError'));
    const timer = setTimeout(() => controller.abort(new DOMException('公开检索超时。', 'TimeoutError')), Math.max(1, remaining));
    try {
      controller.signal.throwIfAborted();
      const response = await awaitWithAbort(fetchImpl(target, { method: 'GET', credentials: 'omit',
        redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' }, signal: controller.signal }), controller.signal);
      controller.signal.throwIfAborted();
      if (!response.ok) throw Object.assign(new Error(`公开网页请求失败（HTTP ${response.status}）。`), { status: response.status });
      // A custom adapter must respect the same policy as native redirect:error.
      if (response.url && publicResearchUrl(response.url) !== target) throw new Error('公开网页响应地址变化，不能跟随未核验的重定向。');
      const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
      if (type && !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/.test(type)) throw new Error('来源类型不是可读取的网页正文。');
      const body = await boundedBody(response, controller.signal);
      controller.signal.throwIfAborted();
      return { ...body, type, url: target };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  return Object.freeze({
    async search(query, options = {}) {
      if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) throw new TypeError('公开搜索查询无效。');
      const fixedQuery = query.trim();
      const response = await request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(fixedQuery)}`, options);
      options.signal?.throwIfAborted();
      const results = parseSearchResults(response.text).filter(item => publicResearchUrl(item.url))
        .slice(0, Math.min(6, Math.max(1, Number(options.maxResults) || 6)));
      return { ok: true, engine: 'public-html', query: fixedQuery, results, truncated: response.truncated };
    },
    async fetch(url, options = {}) {
      const response = await request(url, options);
      options.signal?.throwIfAborted();
      const parsed = pageOf(response.text, response.type);
      if (parsed.content.length < 80) throw new Error('公开来源没有足够的可读取正文。');
      return { ok: true, url: response.url, title: parsed.title, content: parsed.content.slice(0, MAX_BODY_CHARS),
        truncated: response.truncated || parsed.content.length > MAX_BODY_CHARS, engine: 'public-html' };
    },
  });
}

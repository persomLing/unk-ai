const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const MIN_TEXT_CHARS = 20;
const FILE_ACCESS_HINT = '无法读取本地 PDF。请在 chrome://extensions 打开 UNK AI 的详情，启用「允许访问文件网址」并重新加载扩展后重试；也可以把 PDF 拖入输入框作为附件。';

const CJK = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/;

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function isPdfUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return false;
    let pathname = parsed.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* keep raw path */ }
    return /\.pdf$/i.test(pathname);
  } catch {
    return false;
  }
}

export function looksLikePdf(bytes) {
  if (!bytes || !bytes.length) return false;
  const head = bytes.subarray(0, Math.min(1024, bytes.length));
  let prefix = '';
  for (let index = 0; index < Math.min(head.length, 16); index += 1) {
    prefix += String.fromCharCode(head[index]);
  }
  if (prefix.includes('%PDF-')) return true;
  try {
    return new TextDecoder('latin1').decode(head).includes('%PDF-');
  } catch {
    return false;
  }
}

export function pdfTitleFromUrl(url) {
  try {
    const { pathname } = new URL(String(url || ''));
    let name = pathname.split('/').filter(Boolean).pop() || '';
    try { name = decodeURIComponent(name); } catch { /* keep raw name */ }
    return normalizeTitle(name.replace(/\.pdf$/i, '')) || 'PDF 文档';
  } catch {
    return 'PDF 文档';
  }
}

function needsSpace(previous, next) {
  const left = previous.slice(-1);
  const right = next[0] || '';
  if (!left || !right || /\s/.test(left) || /\s/.test(right)) return false;
  if (CJK.test(left) || CJK.test(right)) return false;
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9("'“”‘’]/.test(right);
}

/**
 * Rebuild readable lines from PDF.js text items. Positions are only used to
 * recover breaks; the content-stream order is kept so multi-column PDFs do not
 * get re-sorted unpredictably.
 */
export function assemblePdfPageText(items) {
  const lines = [];
  let line = '';
  let previous = null;
  const flush = () => {
    const value = line.replace(/[ \t]+/g, ' ').trimEnd();
    if (value) lines.push(value);
    line = '';
    previous = null;
  };
  for (const item of Array.isArray(items) ? items : []) {
    const value = String(item?.str ?? '');
    if (!value) {
      if (item?.hasEOL) flush();
      continue;
    }
    const transform = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const height = Math.abs(Number(item.height) || Number(transform[3]) || 0);
    if (previous) {
      const sameLine = Math.abs(y - previous.y) <= Math.max(2, Math.min(previous.height, height) * 0.45);
      if (!sameLine || x < previous.x - 1) {
        flush();
      } else {
        const gap = x - (previous.x + previous.width);
        if (gap > Math.max(1.5, height * 0.18) && needsSpace(previous.str, value)) line += ' ';
      }
    }
    line += value;
    previous = { x, y, width: Number(item.width) || 0, height, str: value };
    if (item.hasEOL) flush();
  }
  flush();
  return lines.join('\n');
}

function pageMarker(pageNumber) {
  return `\n\n[第 ${pageNumber} 页]\n`;
}

/**
 * Build the page-context shape consumed by reading-context.js. Keeps the
 * character budget exact, records page coverage and never includes raw bytes.
 */
export function buildPdfPageContext({
  title = 'PDF 文档',
  url = '',
  pages = [],
  pageCount = pages.length,
  maxBudget = 60000,
  capturedAt = '',
} = {}) {
  const budget = Math.max(2000, Number(maxBudget) || 60000);
  const totalPages = Math.max(Number(pageCount) || 0, pages.length);
  const footerReserve = 96;
  const parts = [];
  let used = 0;
  let pagesRead = 0;
  let truncated = false;
  for (let index = 0; index < pages.length; index += 1) {
    const marker = pageMarker(index + 1);
    const body = String(pages[index] || '').trim();
    const block = `${marker}${body || '（本页未提取到文字）'}`;
    const remaining = budget - used - footerReserve;
    if (remaining <= marker.length + 8) {
      truncated = true;
      break;
    }
    if (block.length <= remaining) {
      parts.push(block);
      used += block.length;
      pagesRead += 1;
      continue;
    }
    parts.push(block.slice(0, remaining));
    used += remaining;
    pagesRead += 1;
    truncated = true;
    break;
  }
  if (pagesRead < pages.length || pagesRead < totalPages) truncated = true;
  let text = parts.join('').replace(/^\s+/, '');
  if (truncated) {
    const remainingPages = Math.max(0, totalPages - pagesRead);
    text += remainingPages > 0
      ? `\n\n[已读取 ${pagesRead}/${totalPages} 页，其余 ${remainingPages} 页未包含在本次读取中]`
      : '\n\n[已达到读取预算，本页内容已截断]';
  }
  const sections = Array.from({ length: pagesRead }, (_, index) => ({
    id: `pdf-page-${index + 1}`,
    level: 1,
    text: `第 ${index + 1} 页`,
  }));
  return {
    title: normalizeTitle(title) || pdfTitleFromUrl(url),
    url,
    text,
    chars: text.length,
    truncated,
    sections,
    structure: {
      pdf: {
        pageCount: totalPages,
        pagesRead,
        truncated,
      },
    },
    capturedAt,
  };
}

async function allowedFileAccess() {
  const extension = globalThis.chrome?.extension;
  if (!extension?.isAllowedFileSchemeAccess) return true;
  return new Promise((resolve) => {
    try {
      extension.isAllowedFileSchemeAccess((allowed) => resolve(Boolean(allowed)));
    } catch {
      resolve(true);
    }
  });
}

function readLocalBytes(url, signal) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.open('GET', url, true);
    request.responseType = 'arraybuffer';
    request.onload = () => {
      if (settled) return;
      settled = true;
      if (request.status && request.status !== 200) {
        reject(new Error(`无法读取本地 PDF（HTTP ${request.status}）。`));
        return;
      }
      const buffer = request.response;
      if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) {
        reject(new Error('本地 PDF 是空文件或无法读取。'));
        return;
      }
      if (buffer.byteLength > MAX_PDF_BYTES) {
        reject(new Error('PDF 超过 40 MB，暂不支持读取。'));
        return;
      }
      resolve(new Uint8Array(buffer));
    };
    request.onerror = () => fail(new Error(FILE_ACCESS_HINT));
    request.onabort = () => fail(new Error('PDF 读取已取消。'));
    if (signal?.addEventListener) {
      signal.addEventListener('abort', () => request.abort(), { once: true });
    }
    request.send();
  });
}

async function readLimitedBody(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) throw new Error('PDF 超过 40 MB，暂不支持读取。');
    return new Uint8Array(buffer);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new Error('PDF 超过 40 MB，暂不支持读取。');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readRemoteBytes(url, signal) {
  let response;
  try {
    response = await fetch(url, { credentials: 'include', redirect: 'follow', signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('无法下载这个 PDF，请检查网络或登录状态。');
  }
  if (!response.ok) {
    throw new Error(`无法下载这个 PDF（HTTP ${response.status}），可能需要登录或链接已失效。`);
  }
  const length = Number(response.headers.get('content-length')) || 0;
  if (length > MAX_PDF_BYTES) throw new Error('PDF 超过 40 MB，暂不支持读取。');
  const bytes = await readLimitedBody(response, MAX_PDF_BYTES);
  if (!looksLikePdf(bytes)) {
    throw new Error('这个地址返回的不是可读取的 PDF，可能需要登录、链接已失效或被防盗链拦截。');
  }
  return bytes;
}

export async function readPdfBytes(url, { signal } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error('PDF 地址无效。');
  }
  if (parsed.protocol === 'file:') {
    if (!await allowedFileAccess()) throw new Error(FILE_ACCESS_HINT);
    return readLocalBytes(parsed.href, signal);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('当前地址不是可读取的 PDF 链接。');
  }
  return readRemoteBytes(parsed.href, signal);
}

let pdfjsPromise = null;
let workerConfigured = false;

function extensionAsset(path) {
  try {
    return globalThis.chrome?.runtime?.getURL?.(path) || '';
  } catch {
    return '';
  }
}

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (!workerConfigured) {
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default || worker;
        workerConfigured = true;
      }
      return pdfjs;
    })().catch((error) => {
      pdfjsPromise = null;
      throw new Error(`PDF 解析组件加载失败：${error?.message || error}`);
    });
  }
  return pdfjsPromise;
}

async function openPdfDocument(bytes) {
  const pdfjs = await loadPdfjs();
  const cMapUrl = extensionAsset('pdfjs/cmaps/');
  const standardFontDataUrl = extensionAsset('pdfjs/standard_fonts/');
  let task;
  try {
    task = pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
      ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
    });
    return await task.promise;
  } catch (error) {
    await Promise.resolve(task.destroy?.()).catch(() => {});
    if (error?.name === 'PasswordException' || /password/i.test(error?.message || '')) {
      throw new Error('这个 PDF 有密码保护，暂不支持读取。');
    }
    throw new Error(`PDF 解析失败：${error?.message || '文件可能已损坏。'}`);
  }
}

export async function extractPdfPages(pdfDocument, { maxChars = 0, maxPages = MAX_PDF_PAGES } = {}) {
  const total = Number(pdfDocument?.numPages) || 0;
  const limit = Math.min(total, Math.max(1, Number(maxPages) || MAX_PDF_PAGES));
  const pages = [];
  let characters = 0;
  for (let number = 1; number <= limit; number += 1) {
    let text = '';
    try {
      const page = await pdfDocument.getPage(number);
      const content = await page.getTextContent();
      text = assemblePdfPageText(content?.items);
      page.cleanup?.();
    } catch {
      // One damaged page must not make the whole document unreadable.
    }
    pages.push(text);
    characters += text.length;
    if (maxChars && characters >= maxChars * 1.15) break;
  }
  return { pages, pageCount: total, pagesRead: pages.length };
}

export async function readPdfFromBytes(bytes, {
  title = '',
  url = '',
  maxBudget = 60000,
  capturedAt = '',
} = {}) {
  const document = await openPdfDocument(bytes);
  try {
    let metadataTitle = '';
    try {
      const metadata = await document.getMetadata();
      metadataTitle = normalizeTitle(metadata?.info?.Title);
    } catch {
      metadataTitle = '';
    }
    const extracted = await extractPdfPages(document, { maxChars: maxBudget });
    const plain = extracted.pages.join('').trim();
    if (plain.length < MIN_TEXT_CHARS) {
      const error = new Error('这个 PDF 没有可提取的文字，可能是扫描件。可以用视觉模型截取页面，或把页面截图作为图片附件。');
      error.code = 'PDF_NO_TEXT';
      throw error;
    }
    return buildPdfPageContext({
      title: metadataTitle || title || pdfTitleFromUrl(url),
      url,
      pages: extracted.pages,
      pageCount: extracted.pageCount,
      maxBudget,
      capturedAt,
    });
  } finally {
    await Promise.resolve(document.destroy?.()).catch(() => {});
  }
}

export async function readPdfFromUrl(url, {
  title = '',
  maxBudget = 60000,
  signal,
  capturedAt = '',
} = {}) {
  const bytes = await readPdfBytes(url, { signal });
  return readPdfFromBytes(bytes, {
    title: title || pdfTitleFromUrl(url),
    url,
    maxBudget,
    capturedAt,
  });
}

export async function readPdfFromFile(file, { maxBudget = 50000, title = '' } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('没有选择 PDF 文件。');
  if (Number(file.size) > MAX_PDF_BYTES) throw new Error('PDF 不能超过 40 MB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikePdf(bytes)) throw new Error('这不是有效的 PDF 文件。');
  return readPdfFromBytes(bytes, {
    title: title || file.name || 'PDF 文档',
    maxBudget,
  });
}

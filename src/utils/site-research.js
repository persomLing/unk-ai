import MarkdownIt from 'markdown-it';
import { awaitWithAbort } from './abortable.js';
import { normalizeReadingPolicy, permitsSiteReading, scoreReadingCandidate } from './reading-plan.js';

const markdown = new MarkdownIt({ html: false, linkify: false });
const MAX_LINKS = 160;
const MAX_PAGES = 3;
const MAX_BUDGET = 24000;
const MAX_BYTES = 128 * 1024;
const MAX_TIMEOUT = 20000;
const REQUEST_TIMEOUT = 8000;
const BLOCKED_HOST = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|test|invalid|onion)$/i;
const ACTION_PATH = /(?:^|\/)(?:api|admin|login|logout|signin|signout|oauth|auth|account|settings|delete|remove|unsubscribe|checkout|payment|download)(?:[/.;_-]|$)/i;
const DOCUMENT_EXTENSION = /\.(?:md|markdown|html?|xhtml)$/i;
const ANY_EXTENSION = /\.[a-z0-9]{1,8}$/i;

const cleanText = (value, limit = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const errorFor = (code, message) => Object.assign(new Error(message), { code });

/** A self-contained, read-only function suitable for executeScript({ world: 'MAIN' }). */
export function captureSiteResearchDiscovery() {
  const doc = globalThis.document;
  const bounded = (value, max = 1000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const own = (object, key) => {
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
  };
  const config = own(globalThis, '$docsify');
  let docsify = null;
  if (config && typeof config === 'object') {
    const alias = {};
    let unsupportedConfig = false;
    const rawAlias = own(config, 'alias');
    if (rawAlias != null) {
      if (typeof rawAlias !== 'object' || Array.isArray(rawAlias)) unsupportedConfig = true;
      else {
        const keys = Object.keys(rawAlias);
        if (keys.length > 30) unsupportedConfig = true;
        for (const key of keys.slice(0, 30)) {
          const value = own(rawAlias, key);
          if (typeof value !== 'string' || key.length > 500 || value.length > 1000) unsupportedConfig = true;
          else Object.defineProperty(alias, key, { value, enumerable: true });
        }
      }
    }
    const primitive = (key, fallback) => {
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return fallback;
      if (!Object.hasOwn(descriptor, 'value')) { unsupportedConfig = true; return fallback; }
      const value = descriptor.value;
      if (typeof value === 'string' && value.length <= 1000 || typeof value === 'boolean') return value;
      unsupportedConfig = true;
      return fallback;
    };
    docsify = {
      basePath: primitive('basePath', ''),
      homepage: primitive('homepage', 'README.md'),
      ext: primitive('ext', '.md'),
      routerMode: primitive('routerMode', 'hash'),
      loadSidebar: primitive('loadSidebar', false),
      alias,
      unsupportedConfig,
    };
  }
  let anchors = [];
  try {
    anchors = [...doc.querySelectorAll('nav a[href], [role="navigation"] a[href], .sidebar-nav a[href], .sidebar a[href], .book-summary a[href]')];
    if (!anchors.length) anchors = [...doc.querySelectorAll('a[href]')];
  } catch { /* An unavailable directory yields an empty discovery. */ }
  const chapterLinks = [];
  const sectionLinks = [];
  const seen = new Set();
  const documentKey = (value) => {
    const parsed = new URL(value);
    return docsify && parsed.hash.startsWith('#/')
      ? parsed.origin + parsed.pathname + parsed.hash.split('?')[0]
      : parsed.origin + parsed.pathname + parsed.search;
  };
  const currentKey = documentKey(globalThis.location.href);
  for (const anchor of anchors.slice(0, 5000)) {
    const raw = anchor.getAttribute?.('href');
    if (!raw || raw.length > 2000) continue;
    let url;
    try { url = new URL(raw, doc.baseURI || globalThis.location.href).href; } catch { continue; }
    const title = bounded(anchor.textContent || anchor.getAttribute?.('aria-label'), 300);
    if (!title || seen.has(url)) continue;
    if (new URL(url).origin !== new URL(globalThis.location.href).origin) continue;
    seen.add(url);
    const current = documentKey(url) === currentKey;
    const kind = current ? /(?:[?#]id=|#[^/])/.test(new URL(url).hash) ? 'section' : 'current' : 'chapter';
    const collection = current ? sectionLinks : chapterLinks;
    if (collection.length < (current ? 30 : 130)) collection.push({ title, url, kind });
  }
  const navigation = [...chapterLinks, ...sectionLinks];
  return {
    version: 1,
    url: bounded(globalThis.location?.href, 2000),
    title: bounded(doc?.title, 300),
    baseUri: bounded(doc?.baseURI || globalThis.location?.href, 2000),
    navigation,
    chapterLinks,
    sectionLinks,
    docsify,
  };
}

function unsafeEncoding(value) {
  let decoded = String(value || '');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || /%2f|%5c/i.test(decoded)) return true;
    if (/(?:^|\/)(?:\.{1,2})(?:\/|[?#]|$)/.test(decoded)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { return true; }
  }
  return false;
}

function publicUrl(value, base) {
  if (typeof value !== 'string' || !value || value.length > 2000 || unsafeEncoding(value)) return null;
  let url;
  try { url = new URL(value, base); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || !hostname.includes('.') || hostname.includes(':') || /^[\d.]+$/.test(hostname)
    || hostname.endsWith('.') || BLOCKED_HOST.test(hostname)) return null;
  if (url.search || ACTION_PATH.test(url.pathname)) return null;
  return url;
}

function scopedUrl(value, base, documentRoot = '') {
  const url = publicUrl(value, base.href);
  if (!url || url.origin !== base.origin) return null;
  if (documentRoot && !url.pathname.startsWith(documentRoot)) return null;
  return url;
}

function supportedAliases(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const aliases = Object.entries(value);
  if (aliases.length > 30) return null;
  const supported = [];
  for (const [key, target] of aliases) {
    if (typeof target !== 'string' || key.length > 500 || target.length > 1000 || unsafeEncoding(key) || unsafeEncoding(target)) return null;
    // Support a single Docsify wildcard with literal surroundings. No page
    // supplied expression is ever passed to RegExp or executed as code.
    const pattern = key === '/.*/_sidebar.md' ? '/(.*)/_sidebar.md' : key;
    const parts = pattern.split('(.*)');
    if (parts.length > 2 || !/^\/[\p{L}\p{N}\s/_.,、&+\-]+$/u.test(parts.join('capture'))) return null;
    const wildcard = parts.length === 2;
    if (target.includes('$') && (!wildcard || target.split('$1').join('').includes('$'))) return null;
    supported.push({ key, target, wildcard, prefix: parts[0], suffix: parts[1] || '' });
  }
  return supported;
}

function docsifySettings(config, base) {
  if (!config || typeof config !== 'object' || config.unsupportedConfig
    || config.routerMode !== 'hash' || !['.md', '.markdown'].includes(config.ext)
    || typeof config.basePath !== 'string' || typeof config.homepage !== 'string') return null;
  const aliases = supportedAliases(config.alias || {});
  if (!aliases) return null;
  const directory = new URL('.', base.href);
  const root = config.basePath ? scopedUrl(config.basePath, base) : directory;
  if (!root || root.hash || root.search) return null;
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  return { root, ext: config.ext, homepage: config.homepage, loadSidebar: config.loadSidebar, aliases };
}

function applyAlias(route, settings) {
  let result = route;
  const visited = new Set();
  for (let count = 0; count < 5; count += 1) {
    if (visited.has(result)) return null;
    visited.add(result);
    const entry = settings.aliases.find(({ key, wildcard, prefix, suffix }) => wildcard
      ? result.length >= prefix.length + suffix.length && result.startsWith(prefix) && result.endsWith(suffix)
      : key === result);
    if (!entry) return result;
    const captured = entry.wildcard ? result.slice(entry.prefix.length, result.length - entry.suffix.length) : '';
    const replacement = entry.target.split('$1').join(captured);
    const target = replacement.startsWith('/') ? replacement : '/' + replacement;
    if (target.length > 2000 || unsafeEncoding(target)) return null;
    if (target === result) return result;
    result = target;
  }
  return null;
}

function docsifyCandidate(link, base, settings, { rawMarkdown = false } = {}) {
  const source = scopedUrl(link.url || link.href, base);
  if (!source) return null;
  let route;
  let sourceUrl = source.href;
  if (rawMarkdown) {
    if (!source.pathname.startsWith(settings.root.pathname) || !DOCUMENT_EXTENSION.test(source.pathname)) return null;
    route = '/' + source.pathname.slice(settings.root.pathname.length);
    const display = new URL(base.href);
    display.hash = '/' + route.slice(1).replace(/\.(?:md|markdown)$/i, '');
    sourceUrl = display.href;
  } else {
    if (source.pathname !== base.pathname || !source.hash.startsWith('#/')) return null;
    const [path, query = ''] = source.hash.slice(1).split('?');
    if (query && [...new URLSearchParams(query).keys()].some(key => key !== 'id')) return null;
    try { route = decodeURIComponent(path); } catch { return null; }
    if (unsafeEncoding(route)) return null;
    if (route === '/') route = '/' + settings.homepage;
    else if (!/\.[a-z0-9]+$/i.test(route)) route += settings.ext;
  }
  const aliased = applyAlias(route, settings);
  if (!aliased) return null;
  const fetchUrl = scopedUrl(aliased.replace(/^\//, ''), settings.root, settings.root.pathname);
  if (!fetchUrl || !/\.(?:md|markdown)$/i.test(fetchUrl.pathname)) return null;
  fetchUrl.hash = '';
  return { title: cleanText(link.title || link.text, 300), url: sourceUrl, fetchUrl: fetchUrl.href };
}

function htmlCandidate(link, base) {
  const source = scopedUrl(link.url || link.href, base);
  if (!source) return null;
  if (ANY_EXTENSION.test(source.pathname) && !DOCUMENT_EXTENSION.test(source.pathname)) return null;
  const fetchUrl = new URL(source.href);
  fetchUrl.hash = '';
  return { title: cleanText(link.title || link.text, 300), url: source.href, fetchUrl: fetchUrl.href };
}

function queryTerms(question) {
  const query = cleanText(question, 2000).toLowerCase();
  const words = [...query.matchAll(/[a-z][a-z0-9+-]{1,30}/g)].map(match => match[0]);
  const stop = new Set(['this', 'that', 'the', 'and', 'for', 'with', 'please', 'page', 'site', 'chapter', 'chapters']);
  const terms = new Set(words.filter(word => !stop.has(word)));
  const chineseStop = new Set(['这个', '网站', '目录', '章节', '总结', '相关', '帮我', '看看', '哪些', '介绍', '一下', '阅读', '先看', '当前', '内容', '可以', '帮忙', '怎么', '如何', '了解', '查找', '找到', '需要', '分别', '给我']);
  for (const run of query.match(/[\u3400-\u9fff]+/g) || []) {
    for (let index = 0; index + 1 < Math.min(run.length, 80); index += 1) {
      const term = run.slice(index, index + 2);
      if (!chineseStop.has(term)) terms.add(term);
    }
  }
  const agent = /\bagents?\b|智能体/i.test(query);
  if (agent) { terms.add('agent'); terms.add('智能体'); }
  const chapters = new Set([...query.matchAll(/(?:第\s*)?(\d{1,3})\s*(?:章|chapter)|chapter\s*(\d{1,3})/gi)].map(match => Number(match[1] || match[2])));
  return { query, terms: [...terms].slice(0, 80), agent, chapters };
}

function relevance(candidate, query) {
  const title = candidate.title.toLowerCase();
  let score = 0;
  for (const term of query.terms) if (title.includes(term)) score += term.length > 2 ? 20 : 8;
  const chapter = title.match(/第\s*(\d{1,3})\s*章|chapter\s*(\d{1,3})/i);
  if (chapter && query.chapters.has(Number(chapter[1] || chapter[2]))) score += 200;
  if (query.agent && /agent|智能体/i.test(title)) {
    if (/langgraph|a2a|多智能体/i.test(title)) score += 18;
    if (/\bagent\b/i.test(title)) score += 24;
  }
  if (!score) return 0;
  const path = decodeURIComponent(new URL(candidate.fetchUrl).pathname);
  score -= Math.min(8, Math.max(0, path.split('/').length - 3) * 2);
  return score + (chapter ? 5 : 0) + 5 / Math.max(1, title.length);
}

function sidebarUrl(base, settings) {
  if (!settings || !settings.loadSidebar) return null;
  const file = settings.loadSidebar === true ? '_sidebar.md' : settings.loadSidebar;
  if (typeof file !== 'string' || !file || unsafeEncoding(file)) return null;
  const route = applyAlias('/' + file.replace(/^\//, ''), settings);
  if (!route) return null;
  const url = scopedUrl(route.replace(/^\//, ''), settings.root, settings.root.pathname);
  if (!url || !/\.(?:md|markdown)$/i.test(url.pathname) || url.hash) return null;
  return url.href;
}

/** Build candidates only from captured directory URLs or a fetched configured sidebar. */
export function planSiteResearch({ page, question, discovery, maxPages = MAX_PAGES, directory, readingPolicy } = {}) {
  const policy = normalizeReadingPolicy(readingPolicy);
  if (policy && !permitsSiteReading(policy)) return { baseUrl: page?.url || '', candidates: [], directoryMatches: [], directoryUrl: '', status: 'no_matches', message: '' };
  const base = publicUrl(page?.url);
  if (!base || !discovery || discovery.url !== base.href || policy?.baseUrl && policy.baseUrl !== base.href) {
    return { baseUrl: page?.url || '', candidates: [], directoryUrl: '', status: 'unavailable', message: '页面来源不可用于同站研究，继续基于当前页回答。' };
  }
  const docsify = discovery.docsify ? docsifySettings(discovery.docsify, base) : null;
  if (discovery.docsify && !docsify) {
    return { baseUrl: base.href, candidates: [], directoryUrl: '', status: 'unavailable', message: '当前文档站路由配置不受支持，未猜测其他章节地址。' };
  }
  const input = Array.isArray(directory) ? directory : discovery.navigation;
  const links = Array.isArray(input) ? input.slice(0, MAX_LINKS) : [];
  const query = queryTerms(question);
  const current = docsify ? docsifyCandidate({ url: base.href, title: page.title }, base, docsify) : htmlCandidate({ url: base.href, title: page.title }, base);
  const seen = new Set();
  const readable = [];
  const currentMatches = [];
  if (current && policy && scoreReadingCandidate(question, current) > 0) {
    currentMatches.push({ ...current, kind: 'current', score: scoreReadingCandidate(question, current) });
  }
  for (const link of links) {
    const candidate = docsify
      ? docsifyCandidate(link, base, docsify, { rawMarkdown: Array.isArray(directory) })
      : htmlCandidate(link, base);
    if (!candidate || !candidate.title) continue;
    const kind = candidate.fetchUrl === current?.fetchUrl ? (docsify ? /[?&]id=/.test(candidate.url) : Boolean(new URL(candidate.url).hash)) ? 'section' : 'current' : 'chapter';
    const ranked = { ...candidate, kind, score: policy ? scoreReadingCandidate(question, candidate) : relevance(candidate, query) };
    if (kind !== 'chapter') { if (ranked.score > 0) currentMatches.push(ranked); continue; }
    if (seen.has(candidate.fetchUrl)) continue;
    seen.add(candidate.fetchUrl);
    readable.push(ranked);
  }
  const ranked = readable
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  const preferCurrent = policy?.scope === 'auto' && policy.intent !== 'locate'
    && (!policy.planned || !policy.selectedUrls.length) && policy.reason !== 'explicit-site-question'
    && currentMatches.length > 0;
  const selected = policy?.planned ? readable.filter(candidate => policy.selectedUrls.includes(candidate.url)) : preferCurrent ? [] : ranked;
  const candidates = selected
    .slice(0, Math.min(MAX_PAGES, Math.max(1, Number(maxPages) || MAX_PAGES)))
    .map(({ score: _score, kind: _kind, ...candidate }) => candidate);
  const directoryMatches = [...(preferCurrent ? [] : ranked), ...currentMatches].slice(0, 12).map(({ title, url, kind }) => ({ title, url, kind }));
  const located = policy?.intent === 'locate' && directoryMatches.length > 0;
  const directoryUrl = !preferCurrent && !located && !Array.isArray(directory) && !readable.length ? sidebarUrl(base, docsify) || '' : '';
  return {
    baseUrl: base.href,
    candidates,
    directoryMatches,
    directoryUrl,
    currentPagePreferred: preferCurrent,
    status: candidates.length || directoryUrl ? 'ready' : 'no_matches',
    message: preferCurrent ? '当前页面已匹配本轮主题，未补读其他章节。' : candidates.length || directoryUrl ? '' : '目录中没有找到与本轮问题明确匹配的可读取链接，继续基于当前页回答。',
  };
}

function markdownLinks(source, base) {
  const links = [];
  for (const token of markdown.parse(source, {})) {
    if (token.type !== 'inline') continue;
    let current = null;
    for (const child of token.children || []) {
      if (child.type === 'link_open') current = { href: child.attrGet('href'), title: '' };
      else if (child.type === 'link_close') {
        if (current?.href && current.title) {
          try { links.push({ title: current.title, url: new URL(current.href, base).href }); } catch { /* Invalid directory link. */ }
        }
        current = null;
      } else if (current && ['text', 'code_inline'].includes(child.type)) current.title += child.content;
    }
    if (links.length >= MAX_LINKS) break;
  }
  return links.slice(0, MAX_LINKS);
}

function entities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] || whole;
    const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}

/** Parse detached HTML as text only; no DOM is created and no resources can load. */
function htmlText(source) {
  const title = entities(source.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i)?.[1] || '').replace(/<[^>]*>/g, '');
  const omitted = new Set(['script', 'style', 'nav', 'header', 'footer', 'form', 'aside', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'select', 'textarea', 'button']);
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const blocks = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'tr', 'br']);
  const stack = [];
  const all = [];
  const article = [];
  const append = (value) => { all.push(value); if (stack.some(tag => tag === 'article' || tag === 'main')) article.push(value); };
  const tokens = source.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</gi) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    const match = token.match(/^<(\/?)\s*([a-z][\w:-]*)/i);
    if (!match) { if (!stack.some(tag => omitted.has(tag) || tag === 'head')) append(entities(token)); continue; }
    const tag = match[2].toLowerCase();
    if (match[1]) {
      if (!stack.some(item => omitted.has(item) || item === 'head') && blocks.has(tag)) append('\n');
      const index = stack.lastIndexOf(tag);
      if (index >= 0) stack.length = index;
    } else {
      if (!stack.some(item => omitted.has(item) || item === 'head') && blocks.has(tag)) append('\n');
      if (!voids.has(tag) && !token.endsWith('/>')) stack.push(tag);
    }
  }
  const normalize = parts => parts.join('').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: cleanText(title), text: normalize(article).length >= 80 ? normalize(article) : normalize(all) };
}

function documentText(raw, contentType, fetchUrl) {
  if (/html|xhtml/i.test(contentType) || /^\s*(?:<!doctype|<html\b)/i.test(raw)) {
    if (/\.(?:md|markdown)$/i.test(new URL(fetchUrl).pathname)) throw errorFor('RESEARCH_NOT_DOCUMENT', '章节返回了 HTML 页面，没有读取为 Markdown 正文。');
    if (/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(raw)) throw errorFor('RESEARCH_LOGIN_REQUIRED', '链接要求登录，未将登录页作为正文。');
    return htmlText(raw);
  }
  if (contentType && !/^(?:text\/(?:plain|markdown|x-markdown)|application\/octet-stream)(?:;|$)/i.test(contentType)) {
    throw errorFor('RESEARCH_NOT_DOCUMENT', '目标不是可读取的静态文本。');
  }
  const title = markdown.parse(raw, {}).find((token, index, tokens) => token.type === 'inline' && tokens[index - 1]?.type === 'heading_open')?.content || '';
  return { title: cleanText(title), text: raw.replace(/\r\n?/g, '\n').trim() };
}

function boundedText(value, budget) {
  if (value.length <= budget) return { text: value, truncated: false };
  const marker = '\n\n[…正文已截断…]\n\n';
  if (budget <= marker.length) return { text: value.slice(0, budget), truncated: true };
  const available = budget - marker.length;
  return { text: value.slice(0, Math.ceil(available * 0.7)) + marker + value.slice(-Math.floor(available * 0.3)), truncated: true };
}

async function fetchDocument(url, { fetchImpl, signal }) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => controller.abort(errorFor('RESEARCH_REQUEST_TIMEOUT', '读取链接超时。')), REQUEST_TIMEOUT);
  let reader;
  try {
    controller.signal.throwIfAborted();
    const response = await awaitWithAbort(Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return fetchImpl(url, {
        method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
        headers: { Accept: 'text/markdown, text/plain, text/html;q=0.8' }, signal: controller.signal,
      });
    }), controller.signal);
    if (!response?.ok || response.status !== 200) throw errorFor('RESEARCH_HTTP_ERROR', `链接读取失败（HTTP ${Number(response?.status) || 0}）。`);
    if (response.redirected || response.url && response.url !== url) throw errorFor('RESEARCH_REDIRECT_BLOCKED', '链接发生跳转，本轮未跟随读取。');
    const length = Number(response.headers?.get?.('content-length')) || 0;
    if (length > MAX_BYTES) throw errorFor('RESEARCH_TOO_LARGE', '章节超过本轮单页读取大小上限。');
    let raw = '';
    if (response.body?.getReader) {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      while (true) {
        const chunk = await awaitWithAbort(reader.read(), controller.signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw errorFor('RESEARCH_TOO_LARGE', '章节超过本轮单页读取大小上限。');
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } else {
      raw = await awaitWithAbort(response.text(), controller.signal);
      if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw errorFor('RESEARCH_TOO_LARGE', '章节超过本轮单页读取大小上限。');
    }
    controller.signal.throwIfAborted();
    return { raw, contentType: response.headers?.get?.('content-type') || '' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    if (reader) Promise.resolve(reader.cancel()).catch(() => {});
  }
}

/** Fetch only selected, same-origin public documents; never navigate or call a model. */
export async function readSiteResearch({ page, question, discovery, signal, readingPolicy, maxBudget = MAX_BUDGET, maxPages = MAX_PAGES, timeoutMs = MAX_TIMEOUT, fetchImpl = globalThis.fetch } = {}) {
  const capturedAt = new Date().toISOString();
  const policy = normalizeReadingPolicy(readingPolicy);
  const result = { version: 1, baseUrl: String(page?.url || ''), capturedAt, sources: [], directoryMatches: [], selectedUrls: [], planned: false, failures: [], status: 'unavailable', message: '', fetchedCount: 0, truncated: false };
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason || new DOMException('同站研究已取消。', 'AbortError'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(errorFor('RESEARCH_TIMEOUT', '同站研究已达到本轮时间上限。')), Math.max(1, Math.min(MAX_TIMEOUT, Number(timeoutMs) || MAX_TIMEOUT)));
  const failed = (url, error) => result.failures.push({ url, code: error?.code || 'RESEARCH_FETCH_FAILED', message: cleanText(error?.message || '链接读取失败。', 240) });
  let remaining = Math.max(0, Math.min(MAX_BUDGET, Math.floor(Number(maxBudget) || 0)));
  try {
    controller.signal.throwIfAborted();
    let plan = planSiteResearch({ page, question, discovery, maxPages, readingPolicy: policy });
    result.status = plan.status === 'ready' ? 'unavailable' : plan.status;
    result.message = plan.message;
    if (remaining < 80 || typeof fetchImpl !== 'function') { result.message = '本轮没有足够预算读取额外章节，继续基于当前页回答。'; return result; }
    if (plan.directoryUrl) {
      try {
        const directory = await fetchDocument(plan.directoryUrl, { fetchImpl, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (/html/i.test(directory.contentType)) throw errorFor('RESEARCH_NOT_DIRECTORY', '目录没有返回 Markdown 文本。');
        plan = planSiteResearch({ page, question, discovery, maxPages, readingPolicy: policy, directory: markdownLinks(directory.raw, plan.directoryUrl) });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        failed(plan.directoryUrl, error);
        result.message = '未能读取公开目录，继续基于当前页回答。';
        return result;
      }
    }
    result.planned = plan.status !== 'unavailable';
    result.directoryMatches = plan.directoryMatches || [];
    result.selectedUrls = plan.candidates.map(candidate => candidate.url);
    if (plan.currentPagePreferred) {
      result.currentPagePreferred = true;
      result.status = 'no_matches';
      result.message = plan.message;
      return result;
    }
    if (policy?.intent === 'locate' || !plan.candidates.length && result.directoryMatches.length) {
      result.status = result.directoryMatches.length ? 'directory_only' : plan.status;
      result.message = result.directoryMatches.length ? '已定位目录中的匹配条目，尚未读取这些章节正文。' : plan.message;
      return result;
    }
    if (!plan.candidates.length) { result.status = plan.status; result.message = plan.message; return result; }
    for (let index = 0; index < plan.candidates.length; index += 1) {
      const candidate = plan.candidates[index];
      try {
        controller.signal.throwIfAborted();
        const document = await fetchDocument(candidate.fetchUrl, { fetchImpl, signal: controller.signal });
        controller.signal.throwIfAborted();
        const parsed = documentText(document.raw, document.contentType, candidate.fetchUrl);
        if (parsed.text.length < 80 || /^(?:loading|please wait|正在加载|加载中)/i.test(parsed.text)) throw errorFor('RESEARCH_EMPTY', '章节没有返回足够的可读正文。');
        const budget = Math.floor(remaining / (plan.candidates.length - index));
        const content = boundedText(parsed.text, budget);
        controller.signal.throwIfAborted();
        result.sources.push({ url: candidate.url, fetchUrl: candidate.fetchUrl, title: parsed.title || candidate.title, text: content.text, capturedAt: new Date().toISOString(), truncated: content.truncated });
        remaining -= content.text.length;
        result.truncated ||= content.truncated;
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        failed(candidate.url, error);
        if (controller.signal.aborted) break;
      }
    }
    if (signal?.aborted) throw signal.reason || new DOMException('同站研究已取消。', 'AbortError');
    result.fetchedCount = result.sources.length;
    result.status = result.sources.length ? result.failures.length ? 'partial' : 'complete' : 'unavailable';
    result.message = result.status === 'complete' ? `已读取 ${result.sources.length} 个同站章节。`
      : result.status === 'partial' ? `已读取 ${result.sources.length} 个同站章节，另有 ${result.failures.length} 个链接未能读取。`
        : '所选链接没有返回可用正文，继续基于当前页回答。';
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

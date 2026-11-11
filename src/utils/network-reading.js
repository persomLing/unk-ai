import { awaitWithTimeout } from './abortable.js';

export const NETWORK_READING_SETTINGS_KEY = 'networkReadingPermissions';
export const NETWORK_READING_LIMITS = Object.freeze({
  durationMs: 30000,
  maxDurationMs: 60000,
  maxRecords: 6,
  maxResponseBytes: 64 * 1024,
  maxTotalChars: 16000,
  maxRecordChars: 6000,
});
const SETTINGS_LOCK = 'unk-ai-network-reading-permissions';
const writers = new WeakMap();

export function networkReadingError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function networkReadingOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}

export function normalizeNetworkReadingSettings(value) {
  if (value === undefined) return { version: 1, revision: 0, origins: {} };
  if (!value || value.version !== 1 || !value.origins || typeof value.origins !== 'object' || Array.isArray(value.origins)) {
    throw networkReadingError('NETWORK_SETTINGS_VERSION', '接口读取授权记录无法识别，请检查扩展版本。');
  }
  const origins = {};
  for (const [origin, entry] of Object.entries(value.origins)) {
    if (networkReadingOrigin(origin) !== origin || !entry || typeof entry.allowed !== 'boolean') {
      throw networkReadingError('NETWORK_SETTINGS_INVALID', '接口读取授权记录损坏，未覆盖已有设置。');
    }
    origins[origin] = { allowed: entry.allowed, updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '' };
  }
  return { version: 1, revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0, origins };
}

function settingsStorage(options) {
  const storage = options.storage || globalThis.chrome?.storage?.local;
  if (!storage) throw networkReadingError('NETWORK_STORAGE_UNAVAILABLE', '接口读取授权存储不可用。');
  return storage;
}

function bounded(pending, options = {}) {
  return awaitWithTimeout(pending, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 3000,
    message: '读取或保存接口读取授权超时。',
  });
}

export async function getNetworkReadingGrant(value, options = {}) {
  const origin = networkReadingOrigin(value);
  if (!origin) throw networkReadingError('NETWORK_ORIGIN_INVALID', '接口读取只支持 HTTP/HTTPS 页面。');
  if (options.signal?.aborted) throw options.signal.reason;
  const result = await bounded(settingsStorage(options).get(NETWORK_READING_SETTINGS_KEY), options);
  const settings = normalizeNetworkReadingSettings(result?.[NETWORK_READING_SETTINGS_KEY]);
  return { version: 1, origin, allowed: settings.origins[origin]?.allowed === true, updatedAt: settings.origins[origin]?.updatedAt || '' };
}

/** Keep the queue/lock until the actual write settles, even if its caller stops waiting. */
export async function setNetworkReadingGrant(origin, allowed, options = {}) {
  if (!origin || networkReadingOrigin(origin) !== origin || typeof allowed !== 'boolean') {
    throw networkReadingError('NETWORK_ORIGIN_INVALID', '接口读取授权需要明确的站点和开关值。');
  }
  const storage = settingsStorage(options);
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  const check = () => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (Date.now() >= deadline) throw new DOMException('保存接口读取授权超时。', 'TimeoutError');
  };
  const operation = async () => {
    check();
    const result = await storage.get(NETWORK_READING_SETTINGS_KEY);
    check();
    const settings = normalizeNetworkReadingSettings(result?.[NETWORK_READING_SETTINGS_KEY]);
    if (!Object.hasOwn(settings.origins, origin) && Object.keys(settings.origins).length >= 200) {
      throw networkReadingError('NETWORK_SETTINGS_LIMIT', '已保存的接口读取站点达到上限。');
    }
    const entry = { allowed, updatedAt: new Date().toISOString() };
    settings.origins[origin] = entry;
    settings.revision += 1;
    check();
    await storage.set({ [NETWORK_READING_SETTINGS_KEY]: settings });
    return { version: 1, origin, ...entry };
  };
  const pending = (writers.get(storage) || Promise.resolve()).catch(() => {}).then(() => {
    check();
    const locks = options.locks ?? globalThis.navigator?.locks;
    return locks?.request ? locks.request(SETTINGS_LOCK, operation) : operation();
  });
  writers.set(storage, pending.catch(() => {}));
  return bounded(pending, options);
}

const PRIVATE_KEY = /(?:password|passwd|pwd|secret|token|authorization|cookie|session(?:id|key)?|api[_-]?key|credential|csrf|xsrf|email|e[_-]?mail|phone|mobile|telephone|contact|address|ssn|socialsecurity|identity|idcard|passport|creditcard|cardnumber|bankaccount|accountnumber|birth|dob|fullname|firstname|lastname|username|nickname|realname|user[_-]?id|customer[_-]?id|account[_-]?id|姓名|身份证|手机号|电话|邮箱|住址|地址|密码|密钥|令牌)/i;
const PRIVATE_STRING = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\+?\d[\d ()-]{8,}\d)\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b)/gi;

function redactBasicText(value, state) {
  return String(value).replace(PRIVATE_STRING, () => { state.redactions += 1; return '[已脱敏]'; });
}

function redactText(value, state) {
  return redactBasicText(value, state)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, url => {
      const source = networkResponseSource(url);
      if (source !== url) state.redactions += 1;
      return source || '[已脱敏]';
    })
    .replace(/\b(?:password|secret|token|api[_-]?key|authorization|sessionid)\s*[=:]\s*[^\s,;]+/gi, () => { state.redactions += 1; return '[已脱敏]'; });
}

/** Endpoint evidence excludes credentials, query values and fragments. */
export function networkResponseSource(value) {
  const origin = networkReadingOrigin(value);
  if (!origin) return '';
  const url = new URL(value);
  const state = { redactions: 0 };
  const path = url.pathname.split('/').map(segment => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { decoded = segment; }
    if (decoded.length > 48 || /[A-F0-9]{16,}/i.test(decoded)) return '[已脱敏]';
    return redactBasicText(decoded, state);
  }).join('/');
  return `${origin}${path}`.slice(0, 1200);
}

/** Return only bounded, redacted JSON. Never persist or return the original payload. */
export function sanitizeNetworkJson(body, options = {}) {
  const maxBytes = options.maxBytes ?? NETWORK_READING_LIMITS.maxResponseBytes;
  const maxChars = options.maxChars ?? NETWORK_READING_LIMITS.maxRecordChars;
  if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > maxBytes) {
    throw networkReadingError('NETWORK_RESPONSE_LIMIT', '接口响应超过读取大小限制。');
  }
  let data;
  try { data = JSON.parse(body); }
  catch { throw networkReadingError('NETWORK_RESPONSE_FORMAT', '接口响应不是有效的 JSON。'); }
  const state = { redactions: 0, nodes: 0, truncated: false };
  const visit = (value, depth = 0, key = '') => {
    state.nodes += 1;
    if (PRIVATE_KEY.test(key)) { state.redactions += 1; return '[已脱敏]'; }
    if (depth > 8 || state.nodes > 1000) { state.truncated = true; return '[已截断]'; }
    if (typeof value === 'string') {
      const redacted = redactText(value, state);
      if (redacted.length > 1000) state.truncated = true;
      return redacted.slice(0, 1000);
    }
    if (Array.isArray(value)) {
      if (value.length > 100) state.truncated = true;
      return value.slice(0, 100).map(item => visit(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      const result = Object.create(null);
      const entries = Object.entries(value);
      if (entries.length > 100) state.truncated = true;
      for (const [childKey, child] of entries.slice(0, 100)) {
        const safeKey = redactText(childKey, state).slice(0, 100);
        result[safeKey] = visit(child, depth + 1, childKey);
      }
      return result;
    }
    // Long numeric values commonly represent identifiers or phone/card numbers.
    if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) >= 1e10) {
      state.redactions += 1;
      return '[已脱敏]';
    }
    return value;
  };
  const redacted = visit(data);
  const serialized = JSON.stringify(redacted, null, 2);
  const truncated = state.truncated || serialized.length > maxChars;
  return { text: serialized.slice(0, maxChars), truncated, redactions: state.redactions };
}

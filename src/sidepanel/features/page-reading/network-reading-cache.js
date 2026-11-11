import { pageTargetFields } from '../../../utils/page-target.js';
import { networkReadingOrigin } from '../../../utils/network-reading.js';
import { normalizeNetworkReading } from '../../../utils/network-reading-context.js';

export const NETWORK_CACHE_TTL_MS = 5 * 60 * 1000;
export const NETWORK_CACHE_MAX_ENTRIES = 4;
const MAX_SIGNATURE_CHARS = 180000;
const FRESH_REQUEST = /最新|实时|当前最新|刚更新|重新(?:抓包|采集|捕获|读取|获取|请求|查询)|再(?:抓|采集|捕获|请求|查询)|(?:刷新|更新).{0,12}(?:数据|接口|响应|页面|网页)|不要.{0,6}(?:缓存|旧数据)|不用.{0,6}缓存|\b(?:latest|live|real[- ]?time|fresh data|refresh|recapture|re-fetch|refetch|no cache|bypass cache)\b/i;
const MISSING_REQUEST = /缺少|缺失|不足|不完整|没(?:有)?(?:抓到|读到|包含|采集到)|漏(?:了|掉)|还缺|补(?:充|齐).{0,8}(?:数据|字段|接口)|\b(?:missing|incomplete|not enough|not captured)\b/i;
const STOP_WORDS = new Set(['请', '帮我', '一下', '一遍', '这个', '这些', '那个', '那些', '这份', '中的', '页面', '网页', '当前', '本页', '刚才', '上面', '之前', '继续', '接口', '响应', '数据', '读取', '抓包', '查看', '获取', '分析', '总结', '解释', '说明', '介绍', '告诉', '看看', '具体', '多少', '什么', '怎么', '为什么', '意思', '含义', '信息', '内容', '数字', '数值', '比较', '对比', '变化', '最高', '最低', '最大', '最小', '能否', '可以', '结果', 'api', 'response', 'responses', 'data', 'page', 'read', 'capture', 'inspect', 'explain', 'please', 'the', 'these', 'those', 'this', 'that', 'again', 'what', 'why', 'how', 'show', 'me', 'same', 'result', 'results']);

const normalizedQuestion = question => String(question || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 2000);

function topicWords(question) {
  const text = normalizedQuestion(question);
  const segments = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)].filter(item => item.isWordLike).map(item => item.segment)
    : text.match(/[a-z][a-z0-9_-]+|[\u3400-\u9fff]{2,}/g) || [];
  // ICU can split domain terms such as 营收 into single characters. Adjacent pairs retain those terms.
  const words = [];
  let characters = '';
  const flush = () => {
    if (characters.length === 1) words.push(characters);
    for (let index = 0; index + 1 < characters.length; index += 1) words.push(characters.slice(index, index + 2));
    characters = '';
  };
  for (const segment of segments) {
    if (/^[请帮把的了在是和及与将就呢吗啊中为你我他它这那再还谁怎何哪]$/.test(segment)) flush();
    else if (/^[\u3400-\u9fff]$/.test(segment)) characters += segment;
    else { flush(); words.push(segment); }
  }
  flush();
  return [...new Set(words.filter(word => (word.length >= 2 || /^[\u3400-\u9fff]$/.test(word))
    && !/^\d+$/.test(word) && !STOP_WORDS.has(word)))].slice(0, 30);
}

function related(question, entry) {
  const query = normalizedQuestion(question);
  if (query === entry.question) return true;
  const words = topicWords(query);
  if (!words.length) return /这些|这份|刚才|上面|之前|继续|再解释|\b(?:these|those|same|that result|explain it)\b/i.test(query);
  const evidence = entry.network.records.map(record => record.text).join('\n').toLowerCase();
  return words.every(word => entry.topics.includes(word) || evidence.includes(word));
}

function canonical(value, depth = 0) {
  if (depth > 14) throw new Error('Page evidence is too deeply nested');
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key], depth + 1);
    return result;
  }
  return value;
}

/** Exact bounded semantic content comparison; timestamps, source labels and prior responses are not evidence. */
function pageSignature(page) {
  if (!page || typeof page.text !== 'string' || !page.text.trim()) return '';
  try {
    const signature = JSON.stringify(canonical({
      text: page.text.replace(/\s+/g, ' ').trim(),
      forms: page.structure?.forms || [],
      tables: { normalized: page.tables || [], structure: page.structure?.tables || [] },
      semanticTree: { normalized: page.semanticTree || [], structure: page.structure?.semanticTree || [] },
      bodyStatus: page.bodyStatus || '', truncated: page.truncated === true,
    }));
    return signature.length <= MAX_SIGNATURE_CHARS ? signature : '';
  } catch { return ''; }
}

function hasEvidenceGap(page, question) {
  if (page.truncated || page.bodyStatus === 'unavailable' || MISSING_REQUEST.test(question)) return true;
  if ((page.readingAssessment?.gaps || []).some(gap => gap !== 'network-evidence')) return true;
  const tables = [...(page.tables || []), ...(page.structure?.tables || [])];
  return tables.some(table => table.truncated || (Number(table.rowCount) > (table.rows?.length || 0)));
}

function usefulResponse(network) {
  if (network?.status !== 'captured' || network.truncated || !network.records?.length) return false;
  return network.records.every(record => {
    if (record.truncated || record.statusCode < 200 || record.statusCode >= 300) return false;
    try {
      const data = JSON.parse(record.text);
      if (data === null || data === '' || (typeof data === 'object' && Object.keys(data).length === 0)) return false;
      if (data && typeof data === 'object' && (data.error || data.errors || data.exception)) return false;
      if (data && typeof data === 'object' && Object.keys(data).length === 1) {
        const [only] = Object.values(data);
        if (Array.isArray(only) && !only.length) return false;
      }
      return true;
    } catch { return false; }
  });
}

function timestamp(value) {
  const numeric = Number(value);
  const result = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(String(value || ''));
  return Number.isFinite(result) ? result : null;
}

/** Per-reader memory only. No response is restored from saved conversations. */
export function createNetworkReadingCache({ now = Date.now } = {}) {
  const entries = new Map();
  const observations = new Map();
  let nextId = 0;
  const prune = () => {
    const time = now();
    for (const [id, entry] of entries) if (time >= entry.expiresAt || time < entry.createdAt) entries.delete(id);
  };
  function invalidate({ origin, conversationId } = {}) {
    for (const [id, entry] of entries) {
      if ((!origin || entry.origin === origin) && (!conversationId || entry.conversationId === conversationId)) entries.delete(id);
    }
    for (const [key, context] of observations) {
      if ((!origin || context.origin === origin) && (!conversationId || context.conversationId === conversationId)) observations.delete(key);
    }
  }
  function observe({ cacheScope, target, page, question }) {
    prune();
    const conversationId = cacheScope?.conversationId;
    const identity = pageTargetFields(target || page);
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200
      || !Number.isInteger(identity.tabId) || !identity.documentId || !identity.expectedUrl) return null;
    const origin = networkReadingOrigin(identity.expectedUrl);
    if (!origin) return null;
    const signature = pageSignature(page);
    const key = JSON.stringify([conversationId, identity.tabId, identity.expectedUrl, identity.documentId]);
    for (const [id, entry] of entries) {
      if (entry.conversationId === conversationId && entry.target.tabId === identity.tabId
        && (entry.key !== key || !signature || entry.signature !== signature)) entries.delete(id);
    }
    const observationKey = JSON.stringify([conversationId, identity.tabId]);
    const context = { conversationId, target: identity, origin, key, observationKey, signature, page };
    observations.delete(observationKey);
    observations.set(observationKey, context);
    while (observations.size > 8) observations.delete(observations.keys().next().value);
    if (FRESH_REQUEST.test(question) || MISSING_REQUEST.test(question)) {
      for (const [id, entry] of entries) if (entry.key === key) entries.delete(id);
      context.forceFresh = true;
    }
    return context;
  }
  const isCurrent = context => !context || observations.get(context.observationKey) === context;
  function lookup(context, question, page) {
    prune();
    if (!context?.signature || !isCurrent(context) || context.forceFresh || hasEvidenceGap(page, question)) return null;
    return [...entries.values()].reverse().find(entry => entry.key === context.key
      && entry.signature === context.signature && related(question, entry)) || null;
  }
  function reuse(entry, context, question, page) {
    prune();
    if (!entry || entries.get(entry.id) !== entry || lookup(context, question, page) !== entry) return null;
    entries.delete(entry.id);
    entries.set(entry.id, entry);
    return normalizeNetworkReading({ ...structuredClone(entry.network), status: 'reused', cache: {
      version: 1, capturedAt: entry.capturedAt, reusedAt: new Date(now()).toISOString(), expiresAt: new Date(entry.expiresAt).toISOString(),
    } }, page);
  }
  function store(context, question, page, network) {
    prune();
    if (!context?.signature || !isCurrent(context) || hasEvidenceGap(page, question) || !usefulResponse(network)) return network;
    const topics = topicWords(question);
    const evidence = network.records.map(record => record.text).join('\n').toLowerCase();
    // Capturing any JSON is not proof that it contains the requested topic or fields.
    if (topics.length && !topics.every(topic => evidence.includes(topic))) return network;
    const createdAt = now();
    const captures = network.records.map(record => timestamp(record.capturedAt)).filter(value => value !== null && value <= createdAt);
    const capturedAt = new Date(captures.length ? Math.min(...captures) : createdAt).toISOString();
    const expiresAt = createdAt + NETWORK_CACHE_TTL_MS;
    const saved = normalizeNetworkReading({ ...network, cache: {
      version: 1, capturedAt, reusedAt: '', expiresAt: new Date(expiresAt).toISOString(),
    } }, page);
    const normalized = normalizedQuestion(question);
    for (const [id, entry] of entries) if (entry.key === context.key && entry.question === normalized) entries.delete(id);
    const entry = { ...context, page: undefined, id: ++nextId, question: normalized, topics,
      network: structuredClone(saved), createdAt, expiresAt, capturedAt };
    entries.set(entry.id, entry);
    while (entries.size > NETWORK_CACHE_MAX_ENTRIES) entries.delete(entries.keys().next().value);
    return saved;
  }
  return { observe, lookup, reuse, store, invalidate, isCurrent };
}

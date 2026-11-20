import { awaitWithAbort, awaitWithTimeout } from '../../../utils/abortable.js';

export const WELCOME_TOPICS_KEY = 'welcomeTopicPreferences';
export const TOPIC_DATE_TOKEN = '{{北京时间}}';
export const TOPIC_LIMITS = Object.freeze({ count: 24, title: 36, subtitle: 72, prompt: 4000 });

const sourceRequirements = '每项附来源链接、发布时间和事件发生时间（未知请注明），区分事实与可能影响，合并重复报道。';
export const TOPIC_TIME_INSTRUCTIONS = `现在是北京时间 ${TOPIC_DATE_TOKEN}。请基于可核实的信息作答；无法联网请明说，不编造时事，可信信息不足时宁缺毋滥。`;
export const DEFAULT_WELCOME_TOPICS = Object.freeze([
  ['news', '国内外大事', '近24小时，发生了什么', '整理近24小时值得关注的国内外大事，按重要性选3—5件；必要时补充近7日背景。'],
  ['ai', 'AI圈动态', '模型、产品和行业新动向', '梳理近24小时的 AI 模型、产品和行业重要动态，选3—5件；必要时补充近7日背景，区分正式发布与传闻。'],
  ['tech', '科技新品', '近7日，有哪些值得看', '看看近7日值得关注的科技新品，选3—5项，优先近24小时更新；说清新在哪里、发布或上市状态。'],
  ['business', '商业与市场', '公司、政策与市场变化', '整理近24小时重要的公司、政策与市场变化，选3—5件；必要时补充近7日背景，市场数据注明时点。'],
].map(([id, title, subtitle, request]) => Object.freeze({ id, title, subtitle,
  prompt: `${request}\n${TOPIC_TIME_INSTRUCTIONS}\n${sourceRequirements}`,
})));

export const BUILTIN_TOPIC_LABELS = Object.freeze(Object.fromEntries(DEFAULT_WELCOME_TOPICS.map(({ id, title }) => [id, title])));

export function isWelcomeTopicId(value) {
  return typeof value === 'string' && (Object.hasOwn(BUILTIN_TOPIC_LABELS, value) || /^topic-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value));
}

export function normalizeWelcomeTopic(value) {
  const { id, title, subtitle, prompt } = value || {};
  if (!isWelcomeTopicId(id)) throw new Error('话题编号无效。');
  function field(text, key, label, optional = false) {
    const result = typeof text === 'string' ? text.trim() : '';
    if ((!result && !optional) || result.length > TOPIC_LIMITS[key]) {
      throw new Error(`${label}${optional ? '最多' : '需要 1 到'} ${TOPIC_LIMITS[key]} 个字符。`);
    }
    return result;
  }
  return {
    id,
    title: field(title, 'title', '标题').replace(/\s+/g, ' '),
    subtitle: field(subtitle, 'subtitle', '副标题', true).replace(/\s+/g, ' '),
    prompt: field(prompt, 'prompt', '提示内容'),
  };
}

export function decodeWelcomeTopics(value) {
  if (value === undefined) return DEFAULT_WELCOME_TOPICS.map(topic => ({ ...topic }));
  if (value?.version !== 1) throw new Error('话题灵感的设置版本无法读取。');
  if (!Array.isArray(value.topics) || value.topics.length > TOPIC_LIMITS.count) throw new Error('话题灵感的列表格式无效。');
  const topics = value.topics.map(normalizeWelcomeTopic);
  if (new Set(topics.map(topic => topic.id)).size !== topics.length) throw new Error('列表中有重复的话题编号。');
  return topics;
}

export async function loadWelcomeTopics(storage, signal) {
  const value = await awaitWithTimeout(storage.get(WELCOME_TOPICS_KEY), { signal, timeoutMs: 3000, message: '读取话题灵感超时。' });
  if (!value || typeof value !== 'object') throw new Error('浏览器未返回话题设置。');
  return decodeWelcomeTopics(value[WELCOME_TOPICS_KEY]);
}

export function saveWelcomeTopic({ storage, previous, next, signal, locks = globalThis.navigator?.locks }) {
  const timeout = AbortSignal.timeout(8000);
  const saveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  async function write() {
    const topics = await loadWelcomeTopics(storage, saveSignal);
    const topic = next ? normalizeWelcomeTopic(next) : null;
    const id = previous?.id || topic?.id;
    if (!id || (topic && topic.id !== id)) throw new Error('话题编号无效。');
    const index = topics.findIndex(item => item.id === id);
    const current = topics[index] || null;
    if (JSON.stringify(current) === JSON.stringify(topic)) return topics;
    if (JSON.stringify(current) !== JSON.stringify(previous ?? null)) {
      throw new Error('这条话题已在其他设置页修改，请关闭编辑后重新选择。');
    }
    if (index >= 0) topics.splice(index, 1, ...(topic ? [topic] : []));
    else if (topics.length < TOPIC_LIMITS.count) topics.push(topic);
    else throw new Error(`最多可保存 ${TOPIC_LIMITS.count} 条话题。`);
    saveSignal.throwIfAborted();
    await storage.set({ [WELCOME_TOPICS_KEY]: { version: 1, topics } });
    return topics;
  }
  const pending = locks?.request ? locks.request(WELCOME_TOPICS_KEY, { signal: saveSignal }, write) : write();
  return awaitWithAbort(pending, saveSignal);
}

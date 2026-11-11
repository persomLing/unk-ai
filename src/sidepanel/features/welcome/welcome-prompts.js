import { isReadablePageUrl } from '../page-reading/page-control-state.js';
import { normalizeDraftSource } from './draft-source.js';

/**
 * Welcome data uses tab metadata only. Rendering never reads the page or calls
 * a model; secondary actions and topics only place a prompt in the composer.
 */
const PAGE_RULES = [
  {
    kind: 'repository',
    test: ({ url }) => /(?:^|\.)(?:github\.com|gitlab\.com|gitee\.com|bitbucket\.org)$/i.test(hostname(url)),
  },
  {
    kind: 'pdf',
    test: ({ url, title }) => /\.pdf(?:$|[?#])/i.test(url) || /\bPDF\b/i.test(title),
  },
  {
    kind: 'video',
    test: ({ url }) => /(?:^|\.)(?:youtube\.com|bilibili\.com|vimeo\.com)$/i.test(hostname(url)),
  },
  {
    kind: 'qa',
    test: ({ url }) => /(?:^|\.)(?:stackoverflow\.com|stackexchange\.com|zhihu\.com|reddit\.com)$/i.test(hostname(url)),
  },
  {
    kind: 'search',
    test: ({ url, title }) => /\/search(?:[/?#]|$)/i.test(pathname(url))
      || /(?:^|\.)(?:google\.[a-z.]+|bing\.com|baidu\.com)$/i.test(hostname(url))
      || /搜索|search results/i.test(title),
  },
  {
    kind: 'docs',
    test: ({ url }) => /(?:^|\.)docs\./i.test(hostname(url))
      || /\/docs?(?:\/|$)/i.test(pathname(url))
      || /developer|documentation|api reference/i.test(hostname(url)),
  },
];

const PAGE_SECONDARY_ACTIONS = {
  repository: {
    id: 'repository-entry',
    label: '先看哪些文件',
    description: '梳理项目结构和阅读入口',
    icon: 'folder',
    prompt: '帮我梳理这个代码仓库的用途、结构和主要入口，建议先读哪些文件；无法读取源码的部分请说明。',
  },
  pdf: {
    id: 'pdf-key-points',
    label: '整理关键结论',
    description: '提取结论、依据和页码',
    icon: 'file',
    prompt: '整理这份 PDF 的关键结论和依据，标注可核对的页码；无法读取的内容请说明。',
  },
  docs: {
    id: 'docs-pitfalls',
    label: '看看容易踩的坑',
    description: '找出前提、限制和易错点',
    icon: 'info',
    prompt: '这份文档有哪些容易忽略的使用前提、限制和易错点？请结合原文简要说明。',
  },
  qa: {
    id: 'qa-solutions',
    label: '梳理解法',
    description: '比较解法和适用条件',
    icon: 'message',
    prompt: '梳理这个页面的问题和解法，比较适用条件，并区分已验证的答案与猜测。',
  },
  video: {
    id: 'video-notes',
    label: '整理页面笔记',
    description: '根据简介或可读字幕整理',
    icon: 'edit',
    prompt: '根据视频页可读的简介或字幕整理简洁笔记；没有字幕或无法读取视频内容时请说明，不要推测。',
  },
  search: {
    id: 'search-comparison',
    label: '比较搜索结果',
    description: '找出相关且可靠的信息',
    icon: 'search',
    prompt: '比较这页搜索结果的相关性和来源可靠性，指出值得进一步阅读的内容；区分摘要与已经核实的事实。',
  },
};

const TOPICS = [
  {
    id: 'news',
    label: '国内外大事',
    description: '近24小时，发生了什么',
    icon: 'globe',
    request: '整理近24小时值得关注的国内外大事，按重要性选3—5件；必要时补充近7日背景。',
  },
  {
    id: 'ai',
    label: 'AI圈动态',
    description: '模型、产品和行业新动向',
    icon: 'brain',
    request: '梳理近24小时的 AI 模型、产品和行业重要动态，选3—5件；必要时补充近7日背景，区分正式发布与传闻。',
  },
  {
    id: 'tech',
    label: '科技新品',
    description: '近7日，有哪些值得看',
    icon: 'sparkles',
    request: '看看近7日值得关注的科技新品，选3—5项，优先近24小时更新；说清新在哪里、发布或上市状态。',
  },
  {
    id: 'business',
    label: '商业与市场',
    description: '公司、政策与市场变化',
    icon: 'article',
    request: '整理近24小时重要的公司、政策与市场变化，选3—5件；必要时补充近7日背景，市场数据注明时点。',
  },
];

function hostname(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase(); } catch { return ''; }
}

function pathname(value) {
  try { return new URL(String(value || '')).pathname; } catch { return ''; }
}

/** Classify tab metadata using the same readability boundary as page controls. */
export function pageKindFor(tab = {}) {
  const url = String(tab?.url || '');
  const title = String(tab?.title || '');
  if (!isReadablePageUrl(url)) return 'no-page';
  return PAGE_RULES.find((rule) => rule.test({ url, title }))?.kind || 'page';
}

/** Include the Beijing date and time even if the browser uses another zone. */
export function currentDatePrompt(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `现在是北京时间 ${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}。请基于可核实的信息作答；无法联网请明说，不编造时事，可信信息不足时宁缺毋滥。`;
}

/**
 * primary: summarize-page or focus-input
 * secondary: one fill-prompt action or null
 * topics: four ordered fill-prompt actions; no automatic request or page read
 */
export function welcomePromptsFor(tab = {}, { now = new Date() } = {}) {
  const kind = pageKindFor(tab);
  const readable = kind !== 'no-page';
  const secondary = PAGE_SECONDARY_ACTIONS[kind];
  const sourceRequirements = '每项附来源链接、发布时间和事件发生时间（未知请注明），区分事实与可能影响，合并重复报道。';
  const datePrompt = currentDatePrompt(now);
  return Object.freeze({
    kind,
    title: readable ? '这页想看懂什么？' : '今天想了解什么？',
    subtitle: readable ? '聊聊当前页面，也可以看看最近的大事。' : '直接提问，或挑一个感兴趣的话题。',
    primary: Object.freeze({
      id: readable ? 'summarize-page' : 'ask-question',
      label: readable ? '总结当前页' : '直接提问',
      description: readable ? '快速了解内容和重点' : '在下方写下你的问题',
      icon: 'sparkles',
      prompt: '',
      action: readable ? 'summarize-page' : 'focus-input',
    }),
    secondary: secondary ? Object.freeze({ ...secondary, action: 'fill-prompt' }) : null,
    topics: Object.freeze(TOPICS.map(({ request, ...topic }) => Object.freeze({
      ...topic,
      prompt: `${request}\n${datePrompt}\n${sourceRequirements}`,
      draftSource: Object.freeze(normalizeDraftSource({ scope: 'independent', topicId: topic.id })),
      action: 'fill-prompt',
    }))),
  });
}


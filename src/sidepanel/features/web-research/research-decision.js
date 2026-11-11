const MAX_QUESTION_CHARS = 3000;
const MAX_ATTACHMENTS = 6;

export const RESEARCH_DECISIONS = Object.freeze(['search', 'skip']);

const hasText = value => typeof value === 'string' && Boolean(value.trim());
const boundedCount = value => Number.isFinite(value) ? Math.max(0, Math.min(MAX_ATTACHMENTS, Math.floor(value))) : 0;

function normalizeInputSummary(value) {
  return {
    imageCount: boundedCount(value?.imageCount),
    documentCount: boundedCount(value?.documentCount),
    hasSelection: value?.hasSelection === true,
    hasPage: value?.hasPage === true,
  };
}

/** Describe only material this turn can actually use; never copy its content or identifiers. */
export function researchInputSummary({ attachments = [], includeVisual = true, selection = null, page = null } = {}) {
  const available = Array.isArray(attachments) ? attachments : [];
  return normalizeInputSummary({
    imageCount: includeVisual === false ? 0 : available.filter(item => item?.type === 'image' && hasText(item.dataUrl)).length,
    documentCount: available.filter(item => item?.type === 'document' && hasText(item.text)).length,
    hasSelection: hasText(selection?.text),
    hasPage: page?.bodyStatus !== 'unavailable' && hasText(page?.text),
  });
}

export function researchDecisionMessages({ question = '', pageTitle = '', year, inputSummary } = {}) {
  return [
    {
      role: 'system',
      content: [
        '你是 UNK AI 的联网核实决策器。只判断本轮回答是否需要公开网页检索，不回答问题。',
        `当前北京时间年份：${year}。`,
        '需要检索：新闻、近期变化、具体版本/型号、价格、库存、票务、开放时间、交通、活动安排、政策，或其他可能已变化且无法仅靠稳定知识确认的事实。',
        '不需要检索：数学、代码、语法、稳定概念、翻译、写作，以及与当前网页/附件直接相关的阅读问题。',
        'inputSummary 仅说明本轮有多少可用图片、文档，以及是否有选区和页面正文；它不是资料正文。仅解释这些资料时无需公开检索，混合外部事实问题仍应判断是否需要核实。',
        '既有明确用户资料也不是实时事实，不能代替外部核实。',
        '不确定时选择检索：错误引用旧年份或过期价格，比多一次检索更严重。',
        '只输出 JSON：{"search":true,"reason":"简短原因"} 或 {"search":false,"reason":"简短原因"}。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: String(question || '').slice(0, MAX_QUESTION_CHARS),
        currentPageTitle: String(pageTitle || '').slice(0, 300),
        inputSummary: normalizeInputSummary(inputSummary),
      }),
    },
  ];
}

/** Malformed or unavailable decisions fail closed: research instead of guessing. */
export function parseResearchDecision(value) {
  const source = String(value || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || source;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('联网核实判断格式无效。');
  let parsed;
  try { parsed = JSON.parse(fenced.slice(start, end + 1)); } catch { throw new Error('联网核实判断格式无效。'); }
  if (typeof parsed?.search !== 'boolean') throw new Error('联网核实判断缺少 search 布尔值。');
  return Object.freeze({
    search: parsed.search,
    reason: String(parsed.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  });
}

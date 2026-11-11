import { CONVERSATION_ANNOTATION_LIMITS, normalizeConversationSelection } from '../../../utils/selection.js';

export const ARTICLE_QUOTE_LIMITS = CONVERSATION_ANNOTATION_LIMITS;
const text = value => String(value || '').replace(/\r\n?/g, '\n').trim();
const timestamp = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

/** Read either the legacy single quote or the versioned annotation draft. */
export function articleQuotes(value) {
  const selection = normalizeConversationSelection(value);
  if (!selection) return [];
  return selection.sourceVersion === 2 ? selection.annotations
    : [{ ...selection, id: 'legacy-reference', comment: '', commentOriginalLength: 0, commentTruncated: false }];
}

function error(message, code) { return Object.assign(new Error(message), { code }); }
function assertBudgets(entries) {
  if (entries.length > ARTICLE_QUOTE_LIMITS.count) throw error('一次最多引用 8 段内容，请先移除一条引用。', 'quote-count-limit');
  if (entries.some(entry => entry.comment.length > ARTICLE_QUOTE_LIMITS.comment)) {
    throw error('每条注释最多 2000 字符，请缩短后再添加。', 'quote-comment-limit');
  }
  if (entries.reduce((sum, entry) => sum + entry.comment.length, 0) > ARTICLE_QUOTE_LIMITS.comments) {
    throw error('本次引用的注释合计最多 8000 字符，请缩短注释或移除引用。', 'quote-comments-limit');
  }
  if (entries.reduce((sum, entry) => sum + entry.text.length + entry.context.length, 0) > ARTICLE_QUOTE_LIMITS.reference) {
    throw error('本次引用的原文与上下文合计最多 16000 字符，请减少引用后再添加。', 'quote-reference-limit');
  }
}

function materialize(entries, previous, now) {
  if (!entries.length) return null;
  assertBudgets(entries);
  const { id, comment, commentOriginalLength, commentTruncated, ...first } = entries[0];
  const revision = (previous?.sourceVersion === 2 ? previous.revision : 0) + 1;
  // The suffix changes even when several edits happen within one clock tick.
  return normalizeConversationSelection({ ...first, sourceVersion: 2, revision,
    selectedAt: `${text(now()).slice(0, 30)}#${revision}`, annotations: entries });
}

/** Append immutably; a quote's source is fixed before any later UI callback. */
export function appendArticleQuote(previous, value, comment = '', options = {}) {
  if (value?.sourceVersion === 2) throw error('请引用一段明确的回答原文。', 'invalid-quote');
  const selection = normalizeConversationSelection(value);
  if (!selection) throw error('选中的回答引用已失效，请重新选择。', 'invalid-quote');
  const prior = previous?.source === 'conversation' ? normalizeConversationSelection(previous) : null;
  if (previous?.source === 'conversation' && !prior) throw error('已有引用已失效，请先清除后重新选择。', 'invalid-quote-draft');
  if (prior && prior.conversationId !== selection.conversationId) {
    throw error('这段引用属于另一段对话，请回到原对话重新选择。', 'quote-conversation-mismatch');
  }
  const entries = articleQuotes(prior);
  const id = text((options.makeId || makeId)()).slice(0, 200);
  if (!id || entries.some(entry => entry.id === id)) throw error('引用编号创建失败，请重试。', 'quote-id-conflict');
  const commentText = text(comment);
  entries.push({ ...selection, id, comment: commentText, commentOriginalLength: commentText.length, commentTruncated: false });
  return materialize(entries, prior, options.now || timestamp);
}

export function removeArticleQuote(previous, id, options = {}) {
  const prior = normalizeConversationSelection(previous);
  if (!prior) return null;
  const entries = articleQuotes(prior);
  if (!entries.some(entry => entry.id === id)) return prior;
  return materialize(entries.filter(entry => entry.id !== id), prior, options.now || timestamp);
}

export function updateArticleQuote(previous, id, comment, options = {}) {
  const prior = normalizeConversationSelection(previous);
  if (!prior) throw error('引用草稿已失效，请重新选择。', 'invalid-quote-draft');
  const entries = articleQuotes(prior);
  if (!entries.some(entry => entry.id === id)) throw error('这条引用已移除，请重新选择。', 'quote-not-found');
  const commentText = text(comment);
  const updated = entries.map(entry => entry.id === id
    ? { ...entry, comment: commentText, commentOriginalLength: commentText.length, commentTruncated: false } : entry);
  return materialize(updated, prior, options.now || timestamp);
}

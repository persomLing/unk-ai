import { CONVERSATION_SELECTION_LIMITS, normalizeConversationSelection,
  conversationSelectionContextForModel } from '../../../utils/selection.js';

export const ARTICLE_SELECTION_LIMITS = CONVERSATION_SELECTION_LIMITS;
export const normalizeArticleSelection = normalizeConversationSelection;
export const articleSelectionContextForModel = conversationSelectionContextForModel;

const normalizedText = value => String(value || '').replace(/\r\n?/g, '\n').trim();
const compactText = value => normalizedText(value).replace(/\s+/g, ' ');

/** Only displayed question text belongs with the selected answer. */
function originalQuestion(conversation, answerIndex) {
  for (let index = answerIndex - 1; index >= 0; index--) {
    const message = conversation.messages[index];
    if (message?.role !== 'user') continue;
    const text = normalizedText(message.displayContent ?? message.content);
    // Older messages may not have a separate displayContent field.
    return text.split(/\n\s*<(?:selection_context|selected_text|image_reference|attached_visuals)\b/)[0].trim();
  }
  return '';
}

function elementFor(node) { return node?.nodeType === 1 ? node : node?.parentElement; }
function contains(node, target) { return Boolean(node && target && (node === target || node.contains?.(target))); }

function nearestHeading(body, range) {
  const ownHeading = elementFor(range.startContainer)?.closest?.('h1,h2,h3,h4,h5,h6');
  if (ownHeading && contains(body, ownHeading)) return compactText(ownHeading.innerText || ownHeading.textContent);
  let found = '';
  for (const heading of body.querySelectorAll?.('h1,h2,h3,h4,h5,h6') || []) {
    try {
      if (range.comparePoint(heading, 0) < 0) found = compactText(heading.innerText || heading.textContent);
      else break;
    } catch { break; }
  }
  return found;
}

function selectionRect(range) {
  const rects = Array.from(range.getClientRects?.() || []).filter(rect => rect.width > 0 && rect.height > 0);
  const rect = rects.at(-1) || range.getBoundingClientRect?.();
  if (!rect) return null;
  const left = Number(rect.left ?? rect.x), top = Number(rect.top ?? rect.y);
  const width = Number(rect.width), height = Number(rect.height);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** Capture one visible assistant answer synchronously; no live DOM is retained. */
export function captureArticleSelection({ selection, root, conversation, now = () => new Date().toISOString() } = {}) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !root || !conversation?.id
    || !Array.isArray(conversation.messages)) return null;
  try {
    const range = selection.getRangeAt(0);
    const body = elementFor(range.startContainer)?.closest?.('.message-content');
    const endBody = elementFor(range.endContainer)?.closest?.('.message-content');
    const article = body?.closest?.('.assistant-message[data-message-id]');
    if (!body || body !== endBody || !article || !contains(root, article)
      || body.isConnected === false || article.isConnected === false
      || !contains(body, range.startContainer) || !contains(body, range.endContainer)) return null;
    const answerIndex = conversation.messages.findIndex(message => message?.id === article.dataset?.messageId);
    const answer = conversation.messages[answerIndex];
    if (!answer || answer.role !== 'assistant') return null;
    const rawText = range.toString();
    const text = normalizedText(rawText);
    if (!text) return null;
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(body);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = range.cloneRange();
    afterRange.selectNodeContents(body);
    afterRange.setStart(range.endContainer, range.endOffset);
    const rawBefore = beforeRange.toString();
    const before = normalizedText(rawBefore);
    const after = normalizedText(afterRange.toString());
    const context = [
      before ? `前文：\n${before.slice(-ARTICLE_SELECTION_LIMITS.nearby)}` : '',
      after ? `后文：\n${after.slice(0, ARTICLE_SELECTION_LIMITS.nearby)}` : '',
    ].filter(Boolean).join('\n\n');
    const payload = normalizeArticleSelection({
      source: 'conversation', conversationId: conversation.id, messageId: answer.id, role: 'assistant',
      text, context, question: originalQuestion(conversation, answerIndex), title: conversation.title,
      heading: nearestHeading(body, range), selectedAt: now(), originalLength: text.length,
      anchor: { start: rawBefore.length + rawText.length - rawText.trimStart().length,
        end: rawBefore.length + rawText.trimEnd().length },
      contextTruncated: before.length > ARTICLE_SELECTION_LIMITS.nearby || after.length > ARTICLE_SELECTION_LIMITS.nearby,
    });
    const rect = selectionRect(range);
    return payload && rect ? { selection: payload, rect } : null;
  } catch { return null; }
}

/** Bound to the original conversation and answer rather than the currently visible page. */
export function articleSelectionBelongsTo(value, conversation) {
  const selection = normalizeArticleSelection(value);
  return Boolean(selection && selection.conversationId === conversation?.id
    && conversation.messages?.some(message => message?.id === selection.messageId && message.role === 'assistant'));
}

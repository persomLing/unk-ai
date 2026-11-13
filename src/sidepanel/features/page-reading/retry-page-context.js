import { readingPolicyForRetry } from '../../../utils/reading-plan.js';
import { assertPageTarget } from '../../../utils/page-target.js';
import { safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { retainedSelectionVisuals } from '../visual-context/selection-visual-context.js';

const hasText = value => typeof value === 'string' && Boolean(value.trim());

/** Reuse only the exact successful read still held by this conversation.
 * This is not a historical body store or a fallback for failed preparation.
 * Reading already applied its size budgets; keep its full payload and truncation
 * evidence intact, then let the ordinary model context budget apply as before. */
export function retainedPageForRetry(conversation, question) {
  if (question?.pageContextEnabled !== true || readingPolicyForRetry(question).scope === 'none') return null;
  const source = question.pageSource, page = conversation?.pageContext;
  if (!source || !page || source.unavailable || !hasText(source.url) || source.url !== page.url
    || !hasText(source.capturedAt) || source.capturedAt !== page.capturedAt
    || !hasText(page.text) || (page.bodyStatus != null && page.bodyStatus !== 'read')) return null;
  if (source.tabId != null && (!Number.isInteger(source.tabId) || source.tabId !== page.tabId)) return null;
  if (source.documentId != null && (!hasText(source.documentId) || source.documentId !== page.documentId)) return null;
  try {
    if (!['http:', 'https:', 'file:'].includes(new URL(source.url).protocol)) return null;
    const visuals = question.selection?.visuals;
    if (visuals != null && !Array.isArray(visuals)) return null;
    if (visuals?.length) {
      if (question.selection.url !== source.url) return null;
      assertPageTarget(question.selection, page);
      const retained = retainedSelectionVisuals(question.selection, question.attachments || []);
      if (retained.length !== visuals.length || retained.some(image => image.type !== 'image'
        || !safeAttachmentDataUrl(image.dataUrl))) return null;
    }
    return structuredClone(page);
  } catch {
    // Bad legacy metadata or missing pixels require the normal original-page
    // preparation path; they must never make unrelated material look reusable.
    return null;
  }
}

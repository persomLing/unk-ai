import { awaitWithAbort, awaitWithTimeout } from '../../../utils/abortable.js';
import { normalizeResearch } from '../../../utils/research-context.js';
import { readSiteResearch } from '../../../utils/site-research.js';
import { normalizeReadingPolicy, permitsSiteReading, readingPolicyForTurn } from '../../../utils/reading-plan.js';
import { normalizePageContext } from '../../../utils/reading-context.js';
import { assertPageTarget } from '../../../utils/page-target.js';

const deadlineError = (code, message) => Object.assign(new Error(message), { code, name: 'TimeoutError' });
const identityError = error => /PAGE_CHANGED|DOCUMENT_CHANGED/.test(error?.code || '') || /页面.*变化|文档.*变化/.test(error?.message || '');

/** Base-body and directory work share a deadline. New page-mode turns require the base body. */
export async function preparePageReading(question, {
  target, readingPolicy, readPage, sendMessage, readResearch = readSiteResearch, signal,
  timeoutMs = 20000, onPhase = () => {},
} = {}) {
  const policy = normalizeReadingPolicy(readingPolicy) || readingPolicyForTurn({ question });
  signal?.throwIfAborted();
  if (policy.scope === 'none') return null;
  const identity = { tabId: target?.tabId ?? target?.id, url: target?.url, ...(target?.documentId ? { documentId: target.documentId } : {}) };
  if (!Number.isInteger(identity.tabId) || !identity.url) throw new Error('无法确认本轮页面来源，请重新选择网页。');
  if (policy.baseUrl && policy.baseUrl !== identity.url) throw Object.assign(new Error('页面与原提问来源不同，请回到原页面重试。'), { code: 'PAGE_CHANGED' });
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason || new DOMException('阅读已取消。', 'AbortError'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const duration = Math.max(1, Math.min(20000, Number(timeoutMs) || 20000));
  const expiresAt = Date.now() + duration;
  const timer = setTimeout(() => controller.abort(deadlineError('READING_TIMEOUT', '本轮网页读取已达到时间上限。')), duration);
  const check = () => {
    signal?.throwIfAborted();
    if (controller.signal.aborted && controller.signal.reason?.code !== 'READING_TIMEOUT') throw controller.signal.reason;
  };
  const stage = async (operation, milliseconds, code, message) => {
    const stageController = new AbortController();
    const stop = () => stageController.abort(controller.signal.reason);
    controller.signal.addEventListener('abort', stop, { once: true });
    if (controller.signal.aborted) stop();
    const limit = Math.max(1, Math.min(milliseconds, expiresAt - Date.now()));
    const stageTimer = setTimeout(() => stageController.abort(deadlineError(code, message)), limit);
    try {
      return await awaitWithAbort(Promise.resolve().then(() => {
        stageController.signal.throwIfAborted();
        return operation(stageController.signal, limit);
      }), stageController.signal);
    } finally {
      clearTimeout(stageTimer);
      controller.signal.removeEventListener('abort', stop);
    }
  };
  const fail = error => {
    if (identityError(error)) controller.abort(error);
    check();
    return { error };
  };
  try {
    onPhase('reading');
    const bodyPending = stage(async (bodySignal, limit) => {
      const value = await readPage({ target: { ...target, ...identity }, signal: bodySignal, timeoutMs: limit });
      bodySignal.throwIfAborted();
      assertPageTarget(identity, value);
      if (!value?.text || value.text.trim().length < 20 || value.bodyStatus === 'unavailable') throw new Error('当前页没有返回可读正文。');
      return { page: normalizePageContext({ ...value, bodyStatus: 'read' }) };
    }, 7000, 'BODY_READ_TIMEOUT', '当前页正文读取超时。').catch(fail);

    const directoryPending = permitsSiteReading(policy)
      ? stage(async directorySignal => {
        const value = await sendMessage({ type: 'CAPTURE_SITE_RESEARCH', tabId: identity.tabId, expectedUrl: identity.url,
          ...(identity.documentId ? { documentId: identity.documentId } : {}) });
        directorySignal.throwIfAborted();
        if (value?.error) throw Object.assign(new Error(value.message || '读取目录失败。'), { code: value.error });
        if (!value?.documentId) throw new Error('无法确认目录的文档身份。');
        assertPageTarget(identity, value);
        return { discovery: value };
      }, 4000, 'DIRECTORY_READ_TIMEOUT', '页面目录读取超时。').catch(fail)
      : Promise.resolve({ discovery: null });

    const relatedPending = directoryPending.then(async directory => {
      if (!directory.discovery) return { ...directory, research: null };
      check();
      controller.signal.throwIfAborted();
      onPhase('researching');
      const locator = { ...identity, documentId: directory.discovery.documentId, title: target?.title || directory.discovery.title || '' };
      try {
        const research = await awaitWithAbort(readResearch({ page: locator, question, discovery: directory.discovery,
          readingPolicy: policy, signal: controller.signal, maxPages: 3, maxBudget: 24000,
          timeoutMs: Math.max(1, expiresAt - Date.now() - 25) }), controller.signal);
        check();
        return { ...directory, research };
      } catch (error) { return { ...directory, ...fail(error), research: null }; }
    });
    const [body, related] = await Promise.all([bodyPending, relatedPending]);
    check();
    if (body.page && related.discovery) assertPageTarget(related.discovery, body.page);
    const current = body.page;
    if (policy.requireCurrentPage && !current) throw body.error || new Error('未能读取当前页面正文，请重试或关闭页面模式。');
    // A local match is already represented by the current body's source. Do
    // not add a second directory-only record that says that same chapter is unread.
    const research = related.research?.currentPagePreferred ? null : normalizeResearch(related.research, identity.url);
    const directoryAnswersQuestion = policy.intent === 'locate' && research?.directoryMatches?.length;
    if (!current && !research?.sources.length && !directoryAnswersQuestion) throw body.error || related.error || new Error('未能读取当前正文或相关章节，请稍后重试。');
    const planned = policy.planned || related.research?.planned === true;
    const completedPolicy = { ...policy, baseUrl: identity.url,
      ...(permitsSiteReading(policy) && planned ? { planned: true,
        selectedUrls: policy.planned ? policy.selectedUrls : related.research.selectedUrls || [] } : {}) };
    return normalizePageContext({ ...(current || {}), ...identity,
      documentId: related.discovery?.documentId || current?.documentId || identity.documentId,
      title: current?.title || target?.title || related.discovery?.title || '当前页面',
      text: current?.text || '', bodyStatus: current ? 'read' : 'unavailable',
      capturedAt: current?.capturedAt || new Date().toISOString(), readingPolicy: completedPolicy,
      structure: { ...(current?.structure || {}), ...(research ? { research } : {}) },
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort(new DOMException('本轮读取已完成。', 'AbortError'));
  }
}

/** Reading never controls a tab. The base identity remains fixed after discovery. */
export async function researchPageForRequest(page, question, {
  signal, sendMessage, readResearch = readSiteResearch,
} = {}) {
  signal?.throwIfAborted();
  if (!page?.url || !Number.isInteger(page.tabId) || !page.documentId) {
    throw new Error('无法确认研究页面，请重新读取当前网页后重试。');
  }
  const discovery = await awaitWithTimeout(sendMessage({ type: 'CAPTURE_SITE_RESEARCH',
    tabId: page.tabId, expectedUrl: page.url, documentId: page.documentId }), {
    signal, timeoutMs: 8000, message: '读取站点目录超时，请重试。',
  });
  signal?.throwIfAborted();
  if (discovery?.error) throw new Error(discovery.message || '读取站点目录失败，请重试。');
  if (!discovery || discovery.url !== page.url || discovery.documentId !== page.documentId
    || discovery.tabId !== page.tabId) throw new Error('页面已变化，请针对当前页面重新提问。');
  const research = await readResearch({ page, question, discovery, signal, maxPages: 3, maxBudget: 24000, timeoutMs: 20000 });
  signal?.throwIfAborted();
  return { ...page, structure: { ...page.structure, research: normalizeResearch(research, page.url) } };
}

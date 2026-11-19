import { awaitWithTimeout } from '../utils/abortable.js';
import { pageSourceFor } from '../utils/turn-source.js';
import { parseRepositoryUrl } from '../utils/repository-reader.js';
import { normalizePageUrl } from '../sidepanel/features/page-reading/page-source.js';
import { isReadablePageUrl } from '../sidepanel/features/page-reading/page-control-state.js';
import { preparePageReading } from '../sidepanel/features/page-reading/site-research-slot.js';
import { capturePageTarget } from '../sidepanel/features/page-reading/page-target-capture.js';
import { retainedPageForRetry } from '../sidepanel/features/page-reading/retry-page-context.js';
import { readingPolicyForRetry } from '../utils/reading-plan.js';
import { assertPageTarget } from '../utils/page-target.js';
import { normalizeReadingOptions } from '../utils/reading-options.js';

const retryPageError = (message, code) => Object.assign(new Error(message), { code });
const pageSwitchOffError = () => retryPageError(
  '页面读取已关闭，且本轮没有可核对的已读资料。请回到原页面并开启页面读取后重试，或回退提问改用普通问答。',
  'RETRY_PAGE_SWITCH_OFF',
);

/**
 * Page identity and preparation shared by ordinary retries.
 *
 * This module owns no turn or message lifecycle. The caller still owns the
 * Runner, submission signal, message replacement and final save.
 */
export function createRetryPagePreparation({
  state,
  browser,
  readCurrentPageForRequest,
  enhancePageReading,
  modelFor,
  setAssistantPhase,
  getConversation = () => state?.conversation,
  retryTarget,
  refreshRetry,
  waitWithTimeout = awaitWithTimeout,
} = {}) {
  if (!state) throw new TypeError('Retry page preparation requires state.');
  if (!browser?.queryActiveTab || !browser?.sendMessage) throw new TypeError('Retry page preparation requires browser ports.');
  if (typeof readCurrentPageForRequest !== 'function') throw new TypeError('Retry page preparation requires a page reader.');

  async function validateRetryPageTarget(question, signal) {
    if (retryTarget) return retryTarget(question, signal);
    signal?.throwIfAborted();
    if (readingPolicyForRetry(question).scope === 'none' || question.pageContextEnabled === false
      || (!question.pageSource?.url && question.pageContextEnabled !== true)) {
      question.pageContextEnabled = false;
      return null;
    }
    if (state.disablePageContext) throw pageSwitchOffError();
    const originalUrl = normalizePageUrl(question.pageSource?.url);
    if (!originalUrl) throw new Error('这条提问没有记录页面来源，请针对当前页面重新提问。');
    const target = await waitWithTimeout(capturePageTarget({
      queryActiveTab: () => browser.queryActiveTab(),
      sendMessage: message => browser.sendMessage(message), signal,
    }), {
      signal, message: '获取重试页面超时，请重试。',
    });
    signal?.throwIfAborted();
    if (!target?.id || !isReadablePageUrl(target.url) || normalizePageUrl(target.url) !== originalUrl) {
      throw retryPageError('当前页面与这条提问的来源不同，请回到原页面并开启页面读取后重试，或回退提问改用普通问答。', 'RETRY_PAGE_TARGET_CHANGED');
    }
    try {
      assertPageTarget(question.pageSource, target);
    } catch (error) {
      if (error.code !== 'PAGE_CHANGED') throw error;
      throw retryPageError('当前页面与这条提问的来源不同，页面可能已切换或刷新。请回到原页面并开启页面读取后重试，或回退提问重新发送。', 'RETRY_PAGE_TARGET_CHANGED');
    }
    if (state.disablePageContext) throw pageSwitchOffError();
    return target;
  }

  async function prepareRetryContext(question, retainedPage, signal) {
    signal.throwIfAborted();
    if (retainedPage && state.disablePageContext) return { target: null, page: retainedPage };
    try {
      const target = await validateRetryPageTarget(question, signal);
      signal.throwIfAborted();
      return { target, page: null };
    } catch (error) {
      signal.throwIfAborted();
      if (retainedPage && ['RETRY_PAGE_SWITCH_OFF', 'RETRY_PAGE_TARGET_CHANGED'].includes(error.code)) {
        return { target: null, page: retainedPage };
      }
      throw error;
    }
  }

  async function refreshPageForRetry(conversation, question, assistant, signal, preparedTarget, owner, history) {
    if (refreshRetry) return refreshRetry(conversation, question, assistant, signal, preparedTarget);
    const target = preparedTarget === undefined ? await validateRetryPageTarget(question, signal) : preparedTarget;
    signal?.throwIfAborted();
    if (!target) return;
    if (state.disablePageContext) throw pageSwitchOffError();
    const originalUrl = normalizePageUrl(question.pageSource?.url);
    setAssistantPhase?.(assistant, 'reading');
    const content = question.displayContent || question.content || '';
    const repository = Boolean(parseRepositoryUrl(target.url) && /源码|代码仓库|仓库结构|source code|repository/i.test(content));
    const readingPolicy = readingPolicyForRetry(question);
    let page = await preparePageReading(content, {
      target, readingPolicy: repository ? { ...readingPolicy, scope: 'page' } : readingPolicy, signal,
      readPage: ({ target: readTarget, signal: readSignal, timeoutMs }) => readCurrentPageForRequest(content, {
        target: readTarget, repository, signal: readSignal, timeoutMs,
      }),
      sendMessage: message => browser.sendMessage(message),
      onPhase: phase => { if (!signal?.aborted) setAssistantPhase?.(assistant, phase); },
    });
    signal?.throwIfAborted();
    if (!page || normalizePageUrl(page.url) !== originalUrl) throw new Error('未能重新读取原页面正文，本轮未使用旧内容，请稍后重试。');
    if (enhancePageReading && !repository && owner) {
      const supplementalTarget = { ...target, documentId: page.documentId || target.documentId };
      page = await waitWithTimeout(enhancePageReading(content, {
        page, target: supplementalTarget,
        cacheScope: { conversationId: conversation.id },
        ...normalizeReadingOptions(question.readingOptions), history: history || [], modelRun: modelFor(owner), signal,
        onPhase: phase => {
          owner.assertCurrent();
          if (getConversation() !== conversation) throw new DOMException('本次重试已取消', 'AbortError');
          setAssistantPhase?.(assistant, phase);
        },
      }), { signal, timeoutMs: 25000, message: '补充原页面资料超时，请重试。' });
      signal?.throwIfAborted();
      owner.assertCurrent();
      if (getConversation() !== conversation) throw new DOMException('本次重试已取消', 'AbortError');
      assertPageTarget(supplementalTarget, page);
    }
    conversation.pageContext = page;
    question.pageSource = pageSourceFor(page);
    question.pageContextEnabled = true;
    question.readingPolicy = page.readingPolicy || readingPolicy;
    state.pendingPage = null;
  }

  return Object.freeze({
    validateRetryPageTarget,
    prepareRetryContext,
    refreshPageForRetry,
    retainedPageForRetry,
    needsPagePreparation(question, retainedPage) {
      return readingPolicyForRetry(question).scope !== 'none'
        && (question.pageContextEnabled === true || question.pageSource?.url)
        && !(retainedPage && state.disablePageContext);
    },
  });
}

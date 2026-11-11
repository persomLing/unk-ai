import { defaults, isString, merge } from 'lodash-es';
import { isPdfUrl } from '../../../utils/pdf-reader.js';
import { normalizePageContext } from '../../../utils/reading-context.js';
import { assertPageTarget, pageTargetFields } from '../../../utils/page-target.js';
import { $, text, toast } from '../../core/dom.js';

export const PAGE_READ_TIMEOUT_MS = 30000;

export const PAGE_READ_DEFAULTS = Object.freeze({
  maxBudget: 60000,
  includeStructure: true,
  includeLinks: true,
  lazyLoad: true,
  lazyOptions: {
    maxSteps: 8,
    stepDelayMs: 80,
    timeoutMs: 5000,
  },
  limits: {
    nodes: 6000,
    headings: 120,
    links: 80,
    tables: 20,
    forms: 20,
    figures: 80,
  },
});

export function pageReadRequest(options = {}) {
  const input = defaults({}, options, PAGE_READ_DEFAULTS);
  const deep = input.deep === true;
  return {
    type: deep ? 'EXTRACT_DEEP_PAGE' : 'EXTRACT_PAGE',
    maxBudget: input.maxBudget,
    includeStructure: input.includeStructure,
    includeLinks: input.includeLinks,
    deepReading: deep,
    lazyLoad: input.lazyLoad,
    lazyOptions: input.lazyOptions,
    forceRefresh: input.forceRefresh === true,
    ...pageTargetFields(input),
    options: {
      includeStructure: input.includeStructure,
      includeLinks: input.includeLinks,
      limits: merge({}, PAGE_READ_DEFAULTS.limits, input.limits),
    },
  };
}

export function normalizePageResponse(response, now = new Date().toISOString()) {
  if (!response || !isString(response.text) || text(response.text).length < 20) {
    throw new Error('页面正文尚未就绪或没有可读内容，请稍后重试。');
  }
  return normalizePageContext({
    ...response,
    capturedAt: response.capturedAt || now,
  });
}

export function showPageReading(deep = false, quiet = false) {
  if (quiet) return;
  const titleElement = $('#page-title');
  const captionElement = $('#page-caption');
  if (titleElement) titleElement.textContent = deep ? '正在深度读取网页…' : '正在读取网页…';
  if (captionElement) {
    captionElement.textContent = deep
      ? '临时读取结构，完成后释放调试器'
      : '只读取一次，不持续监控';
  }
  const button = $('#summarize-page');
  if (button) button.disabled = true;
}

export function showPdfReading(quiet = false) {
  if (quiet) return;
  const title = $('#page-title');
  const caption = $('#page-caption');
  if (title) title.textContent = '正在解析 PDF…';
  if (caption) caption.textContent = '本地提取文字，不上传原始文件';
  const button = $('#summarize-page');
  if (button) button.disabled = true;
}

export function showPageReadFailure(quiet = false) {
  if (quiet) return;
  const title = $('#page-title');
  const caption = $('#page-caption');
  if (title) title.textContent = '暂时无法读取网页';
  if (caption) caption.textContent = '普通对话不受影响';
}

export function notifyPageReadFailure(error) {
  toast(error?.message || '网页读取失败，请稍后重试。', 'error');
}

function readError(name, message, code) {
  return Object.assign(new Error(message), { name, code });
}

/** One deadline covers tab lookup, browser messages, readiness retries and PDF/repository reads. */
function readingDeadline(externalSignal, requestedTimeout) {
  const timeoutMs = Math.max(1, Math.min(PAGE_READ_TIMEOUT_MS, Number(requestedTimeout) || PAGE_READ_TIMEOUT_MS));
  const controller = new AbortController();
  const stopped = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  // An already-aborted caller can fail before the first raced operation.
  stopped.catch(() => {});
  const cancel = () => controller.abort(
    externalSignal?.reason instanceof Error
      ? externalSignal.reason
      : readError('AbortError', '网页读取已取消。', 'PAGE_READ_ABORTED'),
  );
  externalSignal?.addEventListener('abort', cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(readError(
    'TimeoutError', '网页读取超时，请稍后重试；本轮未使用旧页面内容。', 'PAGE_READ_TIMEOUT',
  )), timeoutMs);
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    check,
    run(operation) {
      check();
      return Promise.race([Promise.resolve().then(() => { check(); return operation(); }), stopped]);
    },
    async wait(milliseconds) {
      let retryTimer;
      try { await this.run(() => new Promise(resolve => { retryTimer = setTimeout(resolve, milliseconds); })); }
      finally { clearTimeout(retryTimer); }
    },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancel);
    },
  };
}

function bodyIsReady(response) {
  const content = typeof response?.text === 'string' ? response.text.trim() : '';
  return content.length >= 20
    && response?.readiness?.ready !== false
    && !/^(?:loading|please wait|正在加载|加载中|请稍候)[\s.。…!！-]*$/i.test(content);
}

/**
 * Page-reading feature slot.
 *
 * Responsible for: active-tab extraction, optional CDP deep reading, iframe
 * aggregation, lazy-load materialization, and compatibility with older
 * service workers. UI rendering is injected so the slot remains testable.
 */
export function createPageReaderSlot({
  sendMessage,
  queryActiveTab,
  queryTab = (id) => globalThis.chrome?.tabs?.get?.(id),
  sendTabMessage,
  readPdf,
  readRepository,
  isPdf = isPdfUrl,
  getNow = () => new Date().toISOString(),
  ui = {},
}) {
  async function readPdfPage(url, { maxBudget, title = '', signal } = {}) {
    if (typeof readPdf !== 'function') throw new Error('当前版本没有启用 PDF 读取。');
    if (!url) throw new Error('没有找到可读取的 PDF 地址。');
    return readPdf(url, { maxBudget, title, signal, capturedAt: getNow() });
  }

  async function read(options = {}) {
    const settings = defaults({}, options, {
      maxBudget: PAGE_READ_DEFAULTS.maxBudget,
      deep: false,
      quiet: false,
      source: 'page',
      maxFiles: 24,
      timeoutMs: PAGE_READ_TIMEOUT_MS,
      readAttempts: 4,
      retryDelayMs: 500,
      throwOnError: false,
    });
    const deadline = readingDeadline(settings.signal, settings.timeoutMs);
    let tab = null;
    try {
      try {
        tab = Number.isInteger(settings.tabId)
          ? await deadline.run(() => queryTab?.(settings.tabId)) || { id: settings.tabId, url: settings.expectedUrl }
          : await deadline.run(() => queryActiveTab?.());
      } catch (error) {
        deadline.check();
        throw error;
      }
      const pdfUrl = tab?.url && isPdf(tab.url) ? tab.url : '';
      if (pdfUrl) ui.beginPdf?.(settings.quiet);
      else ui.begin?.(settings.deep, settings.quiet);
      deadline.check();
      if (!tab?.id) throw new Error('没有找到目标标签页，请重新选择页面。');
      if (tab) assertPageTarget(settings, { ...tab, tabId: tab.id, documentId: settings.documentId });
      const target = pageTargetFields({ ...settings, tabId: tab?.id, expectedUrl: settings.expectedUrl || tab?.url });
      const finish = (value, { pdf = false } = {}) => {
        deadline.check();
        if (!pdf) assertPageTarget({
          expectedUrl: target.expectedUrl,
          ...(settings.source === 'page' && target.documentId ? { documentId: target.documentId } : {}),
        }, value);
        return normalizePageResponse({ ...value, tabId: target.tabId, documentId: value?.documentId || target.documentId }, getNow());
      };
      if (settings.source === 'repository') {
        if (typeof readRepository !== 'function') throw new Error('当前版本没有启用仓库读取。');
        return finish(
          await deadline.run(() => readRepository(tab?.url || '', {
            maxFiles: settings.maxFiles,
            maxBudget: settings.maxBudget,
            signal: deadline.signal,
            capturedAt: getNow(),
          })),
        );
      }
      if (pdfUrl) {
        return finish(
          await deadline.run(() => readPdfPage(pdfUrl, {
            maxBudget: settings.maxBudget,
            title: tab?.title || '',
            signal: deadline.signal,
          })),
          { pdf: true },
        );
      }
      const attempts = Math.max(1, Math.min(4, Math.floor(Number(settings.readAttempts) || 4)));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const request = { ...pageReadRequest({ ...settings, forceRefresh: settings.forceRefresh || attempt > 0 }), ...target };
        let response = await deadline.run(() => sendMessage(request));
        if (response?.error) throw Object.assign(new Error(response.message || response.error), { code: response.code || response.error });
        if (response?.pdf) {
          ui.beginPdf?.(settings.quiet);
          return finish(
            await deadline.run(() => readPdfPage(response.pdf.url || tab?.url, {
              maxBudget: settings.maxBudget,
              title: response.pdf.title || tab?.title || '',
              signal: deadline.signal,
            })),
            { pdf: true },
          );
        }
        if (response?.url) assertPageTarget(target, { ...response, tabId: response.tabId ?? target.tabId });
        if (response && !response.structure && !response.links && !response.tables && sendTabMessage) {
          const detailed = await deadline.run(() => sendTabMessage(tab.id, { ...request, type: 'EXTRACT_PAGE' }));
          if (detailed && !detailed.error) {
            assertPageTarget({ expectedUrl: response.url, documentId: response.documentId }, detailed);
            response = merge({}, response, detailed);
          }
        }
        if (bodyIsReady(response)) return finish(response);
        if (attempt + 1 < attempts) {
          ui.waiting?.(settings.quiet, attempt + 1);
          const delay = Math.max(0, Math.min(1000, Number(settings.retryDelayMs) || 0));
          await deadline.wait(delay * (attempt + 1));
        }
      }
      throw readError('PageNotReadyError', '页面正文仍未加载完成或没有可读内容，请稍后重试。', 'PAGE_NOT_READY');
    } catch (error) {
      if (settings.signal?.aborted || error?.name === 'AbortError') {
        if (settings.throwOnError) throw error;
        return null;
      }
      ui.fail?.(settings.quiet);
      if (settings.throwOnError) throw error;
      ui.notify?.(error);
      return null;
    } finally {
      deadline.dispose();
      ui.end?.(settings.quiet);
    }
  }

  return Object.freeze({ read });
}

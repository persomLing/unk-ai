import { prepareAdaptiveReading } from './adaptive-reading.js';
import { normalizeNetworkReading } from '../../../utils/network-reading-context.js';
import { awaitWithTimeout } from '../../../utils/abortable.js';
import { assertPageTarget } from '../../../utils/page-target.js';
import { createNetworkReadingCache } from './network-reading-cache.js';
import { normalizeReadingAssessment } from '../../../utils/reading-assessment.js';

const explicitNetwork = question => /抓包|(?:读取|查看|分析|检查|捕获).{0,12}(?:接口(?:数据|响应|返回)|网络请求)|\b(?:read|inspect|capture|analy[sz]e).{0,20}(?:api response|network request)/i.test(question);
const propagate = error => ['AbortError', 'NotAllowedError', 'SecurityError'].includes(error?.name)
  || /PAGE_CHANGED|DOCUMENT_CHANGED|PERMISSION|DENIED|FORBIDDEN|CANCELLED/i.test(error?.code || '');

function withNetworkEvidence(page, networkReading) {
  const result = { ...page, networkReading };
  if (networkReading?.records.length && page.readingAssessment) {
    const gaps = page.readingAssessment.gaps.filter(gap => gap !== 'network-evidence');
    result.readingAssessment = normalizeReadingAssessment({ ...page.readingAssessment, gaps,
      status: page.readingAssessment.status === 'limited' && !gaps.length ? 'checked' : page.readingAssessment.status });
  }
  return result;
}

/** Existing page preparation owns the body; this adapter only adds bounded evidence. */
export function createSupplementalReader({ readDeep, networkClient, getNetworkGrant, now = Date.now } = {}) {
  const cache = createNetworkReadingCache({ now });
  const active = new Set();
  let disposed = false;
  async function read(question, options) {
    const started = Date.now();
    const cacheContext = cache.observe({ cacheScope: options.cacheScope, target: options.target || options.page,
      page: options.page, question });
    if (cacheContext && options.allowNetwork === false) cache.invalidate({ origin: cacheContext.origin });
    const checkCacheContext = () => {
      options.signal?.throwIfAborted();
      if (!cache.isCurrent(cacheContext)) throw new DOMException('本次接口读取已被较新的页面读取替代。', 'AbortError');
    };
    let page = await prepareAdaptiveReading(question, { ...options, readDeep });
    options.signal?.throwIfAborted();
    const required = explicitNetwork(question);
    const candidate = typeof getNetworkGrant === 'function' ? cache.lookup(cacheContext, question, page) : null;
    const needed = required || (options.mode !== 'basic' && (page.readingAssessment?.networkRecommended || candidate));
    if (!needed) return page;
    if (!options.allowNetwork) {
      if (cacheContext) cache.invalidate({ origin: cacheContext.origin });
      if (required) throw Object.assign(new Error('本轮需要接口数据，请先在“接口数据”中允许本站读取，再重新发送。'), { code: 'NETWORK_PERMISSION_DENIED' });
      return { ...page, networkReading: normalizeNetworkReading({ version: 1, status: 'disabled', records: [] }, page) };
    }
    options.onPhase?.(candidate ? 'checking-evidence' : 'reading-network');
    options.signal?.throwIfAborted();
    try {
      if (candidate) {
        const grant = await awaitWithTimeout(Promise.resolve().then(() => {
          options.signal?.throwIfAborted();
          return getNetworkGrant(cacheContext.target, { signal: options.signal });
        }), { signal: options.signal, timeoutMs: Math.max(1, Math.min(3000, 23000 - (Date.now() - started))), message: '核验接口缓存授权超时。' });
        options.signal?.throwIfAborted();
        checkCacheContext();
        if (!grant?.allowed || grant.origin !== cacheContext.origin) {
          throw Object.assign(new Error('接口读取授权已关闭，不能复用此前数据。'), { code: 'NETWORK_PERMISSION_DENIED' });
        }
        if (!grant.target) throw Object.assign(new Error('未能核验接口缓存的页面身份。'), { code: 'PAGE_CHANGED' });
        assertPageTarget(cacheContext.target, grant.target);
        const reused = cache.reuse(candidate, cacheContext, question, page);
        options.signal?.throwIfAborted();
        if (reused) return withNetworkEvidence(page, reused);
      }
      if (candidate) options.onPhase?.('reading-network');
      checkCacheContext();
      if (!networkClient) throw new Error('接口读取暂不可用。');
      const remaining = Math.max(1, Math.min(12000, 23000 - (Date.now() - started)));
      const result = await awaitWithTimeout(Promise.resolve().then(() => {
        checkCacheContext();
        return networkClient.capture(options.target || page, { signal: options.signal, timeoutMs: remaining });
      }), { signal: options.signal, timeoutMs: remaining, message: '补充接口数据超时。' });
      checkCacheContext();
      page = withNetworkEvidence(page, normalizeNetworkReading(result, page));
      if (required && !page.networkReading?.records?.length) {
        throw Object.assign(new Error('本次监听没有取得可用接口响应；已完成的旧请求无法补抓。本轮未刷新页面或重放请求。'), { code: 'NETWORK_REQUIRED_EMPTY' });
      }
      if (typeof getNetworkGrant === 'function') {
        page.networkReading = cache.store(cacheContext, question, page, page.networkReading);
      }
      return page;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      if (cacheContext && cache.isCurrent(cacheContext)) cache.invalidate({ origin: cacheContext.origin, conversationId: cacheContext.conversationId });
      if (required || propagate(error)) throw error;
      return { ...page, networkReading: normalizeNetworkReading({ version: 1, status: 'unavailable', records: [] }, page) };
    }
  }
  async function enhancePageReading(question, options = {}) {
    if (disposed) throw new DOMException('页面补充读取已关闭。', 'AbortError');
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    active.add(controller);
    try {
      return await read(question, { ...options, signal: controller.signal });
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      active.delete(controller);
    }
  }
  enhancePageReading.invalidate = criteria => cache.invalidate(criteria);
  enhancePageReading.dispose = () => {
    disposed = true;
    cache.invalidate();
    for (const controller of active) controller.abort(new DOMException('页面补充读取已关闭。', 'AbortError'));
    active.clear();
  };
  return enhancePageReading;
}

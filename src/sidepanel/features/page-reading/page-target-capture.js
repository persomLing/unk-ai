import { awaitWithTimeout } from '../../../utils/abortable.js';
import { assertPageTarget, pageTargetFields } from '../../../utils/page-target.js';
import { isPdfUrl } from '../../../utils/pdf-reader.js';

/** Capture identity before configuration/storage waits; this reads no page body. */
export async function capturePageTarget({ queryActiveTab, sendMessage, bindDocument = true, signal, expectedTarget } = {}) {
  return awaitWithTimeout((async () => {
    const tab = await queryActiveTab();
    signal?.throwIfAborted();
    if (expectedTarget) assertPageTarget({ tabId: expectedTarget.tabId, url: expectedTarget.url }, { ...tab, tabId: tab?.id });
    if (!tab?.id || !/^https?:/i.test(tab.url || '') || !bindDocument || isPdfUrl(tab.url)) {
      if (expectedTarget?.documentId) throw Object.assign(new Error('无法确认原页面文档身份，请重新选择。'), { code: 'PAGE_CHANGED' });
      return tab || null;
    }
    const identity = await sendMessage({ type: 'CAPTURE_PAGE_TARGET', tabId: tab.id, expectedUrl: tab.url,
      ...(expectedTarget?.documentId ? { documentId: expectedTarget.documentId } : {}) });
    signal?.throwIfAborted();
    if (identity?.error) throw Object.assign(new Error(identity.message || identity.error), { code: identity.code || identity.error });
    if (!identity?.documentId) throw new Error('无法确认当前页面，请重试。');
    assertPageTarget({ tabId: tab.id, url: tab.url, ...pageTargetFields(expectedTarget) }, identity);
    return { ...tab, documentId: identity.documentId };
  })(), { signal, timeoutMs: 5000, message: '确认当前页面超时，请重试。' });
}

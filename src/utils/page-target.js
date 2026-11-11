function parsedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function stableUrl(value, { includeSearch = true } = {}) {
  const url = parsedUrl(value);
  if (!url) return '';
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.origin}${pathname}${includeSearch ? url.search : ''}`;
}

/**
 * Prefer an exact open copy (ignoring only the hash). Some readers append
 * tracking query parameters; an unambiguous same-path tab is also accepted.
 */
export function findOpenTabForSource(tabs, sourceUrl) {
  const target = parsedUrl(sourceUrl);
  if (!target) return null;
  const available = (Array.isArray(tabs) ? tabs : []).filter((tab) =>
    tab && Number.isInteger(tab.id) && parsedUrl(tab.url));
  const exactUrl = stableUrl(target.href);
  const exact = available.filter((tab) => stableUrl(tab.url) === exactUrl);
  if (exact.length) {
    return exact.find((tab) => tab.active) || exact[0];
  }

  const originAndPath = stableUrl(target.href, { includeSearch: false });
  const samePath = available.filter((tab) =>
    stableUrl(tab.url, { includeSearch: false }) === originAndPath);
  return samePath.length === 1 ? samePath[0] : null;
}

// Reading/capture identity is stricter than an "open source" convenience link:
// query parameters and fragments can identify a different SPA document.
export function pageTargetFields(value = {}) {
  return {
    ...(Number.isInteger(value.tabId ?? value.id) ? { tabId: value.tabId ?? value.id } : {}),
    ...(value.documentId ? { documentId: String(value.documentId) } : {}),
    ...((value.expectedUrl || value.url) ? { expectedUrl: String(value.expectedUrl || value.url) } : {}),
  };
}

export function assertPageTarget(expected = {}, actual = {}) {
  const target = pageTargetFields(expected);
  const observed = pageTargetFields(actual);
  const normalizedUrl = (value) => {
    try { return new URL(value).href; } catch { return String(value || ''); }
  };
  if ((target.tabId !== undefined && observed.tabId !== target.tabId)
    || (target.documentId && observed.documentId !== target.documentId)
    || (target.expectedUrl && normalizedUrl(observed.expectedUrl) !== normalizedUrl(target.expectedUrl))) {
    const error = new Error('页面在读取过程中发生了变化，请重新读取后再试。');
    error.code = 'PAGE_CHANGED';
    throw error;
  }
  return actual;
}

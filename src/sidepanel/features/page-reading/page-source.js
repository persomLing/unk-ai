const READABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const TRACKING_QUERY_KEYS = new Set(['gclid', 'fbclid']);
const TRACKING_QUERY_PREFIXES = ['utm_'];

function isTrackingQueryKey(key) {
  const normalizedKey = key.toLowerCase();
  return (
    TRACKING_QUERY_KEYS.has(normalizedKey) ||
    TRACKING_QUERY_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))
  );
}

/**
 * Normalize a page URL for source comparison.
 *
 * Article anchors are ignored, hash routes are preserved, tracking-only query parameters are removed, and
 * all remaining path/query information is preserved. Relative, malformed, or
 * unsupported URLs return `null` so callers can fail closed.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizePageUrl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const input = value.trim();
  if (!input) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  if (!READABLE_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }

  // Anchor links within an article do not change its reading. Hash routers do.
  if (!/^#!?\//.test(parsed.hash)) parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (isTrackingQueryKey(key)) {
      parsed.searchParams.delete(key);
    }
  }

  return parsed.href;
}

/**
 * @typedef {'same'|'different'|'no-active'|'no-old'} PageSourceState
 * @typedef {'use-existing'|'read-active'|'check-active'} PageSourceAction
 * @typedef {Object} PageSourceDecision
 * @property {PageSourceState} sourceState
 * @property {PageSourceAction} action
 * @property {string|null} oldUrl Normalized URL used by the existing reading.
 * @property {string|null} activeUrl Normalized URL of the active browser tab.
 * @property {string} title Trimmed title supplied by the caller.
 * @property {boolean} explicitPageRequest Whether the user explicitly referred
 *   to the current page in this turn.
 */

/**
 * Decide whether an existing page reading can be reused or the active page
 * should be checked/read.
 *
 * Policy:
 * - Same normalized URL: reuse unless the user requested a fresh reading.
 * - No active URL: keep the existing source.
 * - Different URL without an explicit current-page request: ask/check first.
 * - Different URL with an explicit current-page request: read the active page.
 * - No old URL: check the active page, or read it when explicitly requested.
 *
 * @param {{
 *   oldUrl?: unknown,
 *   activeUrl?: unknown,
 *   title?: unknown,
 *   explicitPageRequest?: unknown
 *   forceRefresh?: boolean
 * }} [input]
 * @returns {PageSourceDecision}
 */
export function resolvePageSource(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const oldUrl = normalizePageUrl(source.oldUrl);
  const activeUrl = normalizePageUrl(source.activeUrl);
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const explicitPageRequest = source.explicitPageRequest === true;

  if (!activeUrl) {
    return {
      sourceState: 'no-active',
      action: 'use-existing',
      oldUrl,
      activeUrl: null,
      title,
      explicitPageRequest,
    };
  }

  if (!oldUrl) {
    return {
      sourceState: 'no-old',
      action: explicitPageRequest || source.forceRefresh === true ? 'read-active' : 'check-active',
      oldUrl: null,
      activeUrl,
      title,
      explicitPageRequest,
    };
  }

  if (oldUrl === activeUrl) {
    return {
      sourceState: 'same',
      action: source.forceRefresh === true ? 'read-active' : 'use-existing',
      oldUrl,
      activeUrl,
      title,
      explicitPageRequest,
    };
  }

  return {
    sourceState: 'different',
    action: explicitPageRequest || source.forceRefresh === true ? 'read-active' : 'check-active',
    oldUrl,
    activeUrl,
    title,
    explicitPageRequest,
  };
}

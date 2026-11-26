export const FUND_USAGE_STORAGE_KEY = 'fundModeDailyUsage';
export const FUND_REMOTE_QUOTA_STORAGE_KEY = 'fundModeRemoteQuota';
export const FUND_MARKET_TEMP_STORAGE_KEY = 'fundModeDailyMarketTemp';
export const FUND_DAILY_FEED_STORAGE_KEY = 'fundModeDailyFeed';
export const FUND_FEED_MORNING_HOUR_CST = 9;
const DEFAULT_MAX_ENTRIES = 120;

/** Return current Beijing date key (YYYY-MM-DD), aligned with Yingmi 00:00 CST quota reset. */
export function beijingDateKey(timestampMs = Date.now()) {
  const shifted = new Date(Number(timestampMs) + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Return the daily auto-refresh cycle key anchored at a fixed Beijing morning hour (default 09:00 CST).
 * Before 09:00 CST, belongs to the previous day's cycle; at/after 09:00 CST, advances to today's cycle.
 */
export function beijingMorningCycleKey(timestampMs = Date.now(), anchorHour = FUND_FEED_MORNING_HOUR_CST) {
  const shifted = new Date(Number(timestampMs) + (8 - anchorHour) * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}@${String(anchorHour).padStart(2, '0')}:00`;
}

function stableSortValue(value) {
  if (Array.isArray(value)) return value.map(stableSortValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) sorted[key] = stableSortValue(entry);
    }
    return sorted;
  }
  return value;
}

export function canonicalToolKey(endpoint, toolName, args = {}) {
  return `${String(endpoint || '').trim()}::${String(toolName || '').trim()}::${JSON.stringify(stableSortValue(args || {}))}`;
}

/** Bounded in-memory LRU cache with per-entry TTL for read-only fund MCP tool calls. */
export function createFundToolCache({ maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
  const map = new Map();

  function get(key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      map.delete(key);
      return null;
    }
    // Refresh LRU order.
    map.delete(key);
    map.set(key, entry);
    return structuredClone(entry.value);
  }

  function set(key, value, ttlMs) {
    const ttl = Number(ttlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    if (map.has(key)) map.delete(key);
    while (map.size >= maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
    map.set(key, {
      value: structuredClone(value),
      expiresAt: now() + ttl,
      cachedAt: now(),
    });
  }

  function clear() {
    map.clear();
  }

  function size() {
    const current = now();
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt <= current) map.delete(key);
    }
    return map.size;
  }

  return Object.freeze({ get, set, clear, size });
}

function defaultStorage() {
  return globalThis.chrome?.storage?.local || null;
}

export async function loadDailyFundUsage({ storage = defaultStorage(), now = Date.now } = {}) {
  const today = beijingDateKey(now());
  if (!storage?.get) return { date: today, count: 0, limit: null, remaining: null, source: 'local' };
  try {
    const data = await storage.get([FUND_USAGE_STORAGE_KEY, FUND_REMOTE_QUOTA_STORAGE_KEY]);
    const remote = data?.[FUND_REMOTE_QUOTA_STORAGE_KEY];
    const saved = data?.[FUND_USAGE_STORAGE_KEY];
    const localCount = saved && saved.date === today && Number.isInteger(saved.count) && saved.count >= 0 ? saved.count : 0;
    if (remote && remote.date === today && (Number.isFinite(remote.used) || Number.isFinite(remote.limit))) {
      return {
        date: today,
        count: Number.isFinite(remote.used) ? remote.used : localCount,
        limit: Number.isFinite(remote.limit) ? remote.limit : null,
        remaining: Number.isFinite(remote.remaining) ? remote.remaining : null,
        source: 'remote',
      };
    }
    return { date: today, count: localCount, limit: null, remaining: null, source: 'local' };
  } catch {
    return { date: today, count: 0, limit: null, remaining: null, source: 'local' };
  }
}

export async function saveRemoteFundQuota(quota, { storage = defaultStorage(), now = Date.now } = {}) {
  if (!quota || typeof quota !== 'object') return null;
  const today = beijingDateKey(now());
  const record = {
    date: today,
    used: Number.isFinite(quota.used) ? Math.max(0, Math.round(quota.used)) : null,
    limit: Number.isFinite(quota.limit) && quota.limit > 0 ? Math.round(quota.limit) : null,
    remaining: Number.isFinite(quota.remaining) ? Math.max(0, Math.round(quota.remaining)) : null,
    updatedAt: now(),
  };
  if (record.used === null && record.limit === null) return null;
  if (storage?.set) {
    try {
      await storage.set({ [FUND_REMOTE_QUOTA_STORAGE_KEY]: record });
    } catch {
      // Non-fatal quota write failure.
    }
  }
  return {
    date: today,
    count: record.used ?? 0,
    limit: record.limit,
    remaining: record.remaining,
    source: 'remote',
  };
}

export async function incrementDailyFundUsage(delta = 1, { storage = defaultStorage(), now = Date.now } = {}) {
  const today = beijingDateKey(now());
  let localCount = 0;
  if (storage?.get) {
    try {
      const data = await storage.get(FUND_USAGE_STORAGE_KEY);
      const saved = data?.[FUND_USAGE_STORAGE_KEY];
      if (saved && saved.date === today && Number.isInteger(saved.count) && saved.count >= 0) {
        localCount = saved.count;
      }
    } catch {}
  }
  const nextCount = Math.max(0, localCount + Math.max(0, Number(delta) || 0));
  if (storage?.set) {
    try {
      await storage.set({ [FUND_USAGE_STORAGE_KEY]: { date: today, count: nextCount } });
    } catch {
      // Non-fatal usage counter write failure.
    }
  }
  return loadDailyFundUsage({ storage, now });
}

export async function loadDailyMarketTemperature({ storage = defaultStorage(), now = Date.now } = {}) {
  const today = beijingDateKey(now());
  if (!storage?.get) return null;
  try {
    const data = await storage.get(FUND_MARKET_TEMP_STORAGE_KEY);
    const saved = data?.[FUND_MARKET_TEMP_STORAGE_KEY];
    if (saved && saved.date === today && saved.snapshot && typeof saved.snapshot === 'object') {
      return saved.snapshot;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveDailyMarketTemperature(snapshot, { storage = defaultStorage(), now = Date.now } = {}) {
  const today = beijingDateKey(now());
  if (!storage?.set || !snapshot || typeof snapshot !== 'object') return snapshot;
  try {
    await storage.set({
      [FUND_MARKET_TEMP_STORAGE_KEY]: {
        version: 1,
        date: today,
        savedAt: now(),
        snapshot,
      },
    });
  } catch {
    // Non-fatal cache write failure.
  }
  return snapshot;
}

export async function clearDailyMarketTemperature({ storage = defaultStorage() } = {}) {
  if (!storage?.remove) return;
  try {
    await storage.remove(FUND_MARKET_TEMP_STORAGE_KEY);
    await storage.remove(FUND_DAILY_FEED_STORAGE_KEY);
  } catch {
    // Ignore cleanup errors.
  }
}

export async function loadDailyFundFeed({ storage = defaultStorage(), now = Date.now } = {}) {
  const currentCycle = beijingMorningCycleKey(now());
  const today = beijingDateKey(now());
  if (!storage?.get) return null;
  try {
    const data = await storage.get(FUND_DAILY_FEED_STORAGE_KEY);
    const saved = data?.[FUND_DAILY_FEED_STORAGE_KEY];
    if (!saved || !saved.feed || typeof saved.feed !== 'object') return null;
    if (saved.cycleKey) {
      if (saved.cycleKey !== currentCycle) return null;
    } else if (saved.date !== today) {
      return null;
    }
    return {
      ...saved.feed,
      meta: saved.meta && typeof saved.meta === 'object' ? saved.meta : {},
      cycleKey: saved.cycleKey || currentCycle,
    };
  } catch {
    return null;
  }
}

export async function saveDailyFundFeed(patch, { storage = defaultStorage(), now = Date.now } = {}) {
  const currentCycle = beijingMorningCycleKey(now());
  const today = beijingDateKey(now());
  const current = (await loadDailyFundFeed({ storage, now })) || {};
  const { meta: patchMeta, cycleKey: _ignoredCycle, ...feedPatch } = patch || {};
  const { meta: currentMeta, cycleKey: _currentCycle, ...currentFeed } = current;
  const nextFeed = { ...currentFeed, ...feedPatch };
  const nextMeta = { ...(currentMeta || {}), ...(patchMeta || {}) };
  if (storage?.set) {
    try {
      await storage.set({
        [FUND_DAILY_FEED_STORAGE_KEY]: {
          version: 2,
          date: today,
          cycleKey: currentCycle,
          savedAt: now(),
          feed: nextFeed,
          meta: nextMeta,
        },
      });
    } catch {
      // Non-fatal feed cache write failure.
    }
  }
  return { ...nextFeed, meta: nextMeta, cycleKey: currentCycle };
}

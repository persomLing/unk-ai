import { createMcpHttpClient, sanitizeMcpEndpoint } from '../../../utils/mcp-http-client.js';

export const FUND_MODE_STORAGE_KEY = 'fundModeConfig';
export const FUND_TOOLS_CACHE_KEY = 'fundModeToolsCache';
export const DEFAULT_YINGMI_ENDPOINT = 'https://stargate.yingmi.com/mcp/v2';
export const DEFAULT_DAILY_QUOTA = 500;
export const TOOLS_LIST_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_FUND_MODE_CONFIG = Object.freeze({
  version: 1,
  endpoint: DEFAULT_YINGMI_ENDPOINT,
  apiKey: '',
  dailyQuota: DEFAULT_DAILY_QUOTA,
  lastConnectedAt: '',
  lastToolCount: 0,
});

function defaultStorage() {
  return globalThis.chrome?.storage?.local || null;
}

export function normalizeFundModeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  let endpoint = DEFAULT_YINGMI_ENDPOINT;
  if (typeof source.endpoint === 'string' && source.endpoint.trim()) {
    try {
      endpoint = sanitizeMcpEndpoint(source.endpoint);
    } catch {
      endpoint = DEFAULT_YINGMI_ENDPOINT;
    }
  }
  const quota = Number(source.dailyQuota);
  return {
    version: 1,
    endpoint,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    dailyQuota: Number.isFinite(quota) && quota > 0 ? Math.round(quota) : DEFAULT_DAILY_QUOTA,
    lastConnectedAt: typeof source.lastConnectedAt === 'string' ? source.lastConnectedAt : '',
    lastToolCount: Number.isInteger(source.lastToolCount) && source.lastToolCount >= 0 ? source.lastToolCount : 0,
  };
}

export function hasFundModeApiKey(config) {
  return Boolean(config && typeof config.apiKey === 'string' && config.apiKey.trim().length > 0);
}

/** Redact sensitive fields before logging or exporting diagnostics. */
export function redactFundModeConfig(config) {
  const normalized = normalizeFundModeConfig(config);
  return {
    version: normalized.version,
    endpoint: normalized.endpoint,
    hasApiKey: hasFundModeApiKey(normalized),
    dailyQuota: normalized.dailyQuota,
    lastConnectedAt: normalized.lastConnectedAt,
    lastToolCount: normalized.lastToolCount,
  };
}

export async function loadFundModeConfig(storage = defaultStorage()) {
  if (!storage?.get) return normalizeFundModeConfig();
  try {
    const data = await storage.get(FUND_MODE_STORAGE_KEY);
    return normalizeFundModeConfig(data?.[FUND_MODE_STORAGE_KEY]);
  } catch {
    return normalizeFundModeConfig();
  }
}

export async function saveFundModeConfig(patch = {}, storage = defaultStorage()) {
  const current = await loadFundModeConfig(storage);
  const next = normalizeFundModeConfig({ ...current, ...patch });
  if (storage?.set) {
    await storage.set({ [FUND_MODE_STORAGE_KEY]: next });
  }
  return next;
}

export async function loadCachedMcpTools(endpoint, { storage = defaultStorage(), now = Date.now } = {}) {
  if (!storage?.get) return null;
  try {
    const data = await storage.get(FUND_TOOLS_CACHE_KEY);
    const entry = data?.[FUND_TOOLS_CACHE_KEY];
    if (!entry || entry.endpoint !== endpoint || !Array.isArray(entry.tools) || !entry.tools.length) return null;
    if (now() - Number(entry.cachedAt || 0) > TOOLS_LIST_TTL_MS) return null;
    return entry.tools;
  } catch {
    return null;
  }
}

export async function saveCachedMcpTools(endpoint, tools, { storage = defaultStorage(), now = Date.now } = {}) {
  if (!storage?.set || !Array.isArray(tools)) return;
  try {
    await storage.set({
      [FUND_TOOLS_CACHE_KEY]: {
        version: 1,
        endpoint,
        cachedAt: now(),
        tools,
      },
    });
  } catch {
    // Non-fatal cache write failure.
  }
}

export async function clearCachedMcpTools(storage = defaultStorage()) {
  if (!storage?.remove) return;
  try {
    await storage.remove(FUND_TOOLS_CACHE_KEY);
  } catch {
    // Ignore cleanup errors.
  }
}

export function createYingmiMcpClient({ endpoint = DEFAULT_YINGMI_ENDPOINT, apiKey = '', transport } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('尚未配置盈米 MCP API Key，请先在设置页「基金研究」中填写。');
  return createMcpHttpClient({
    endpoint,
    headers: { 'x-api-key': key },
    ...(transport ? { transport } : {}),
  });
}

export async function testFundModeConnection({
  endpoint = DEFAULT_YINGMI_ENDPOINT,
  apiKey = '',
  transport,
  signal,
  storage = defaultStorage(),
  now = Date.now,
} = {}) {
  const startedAt = now();
  const client = createYingmiMcpClient({ endpoint, apiKey, transport });
  const tools = await client.listTools({ signal, timeoutMs: 20000 });
  const latencyMs = Math.max(0, now() - startedAt);
  await saveCachedMcpTools(client.endpoint, tools, { storage, now });
  return {
    ok: true,
    endpoint: client.endpoint,
    toolCount: tools.length,
    latencyMs,
    serverInfo: client.serverInfo,
    tools,
  };
}

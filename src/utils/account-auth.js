import { normalizeProviderConfig } from './profiles.js';
import { awaitWithTimeout } from './abortable.js';

export const ACCOUNT_SESSION_KEY = 'accountSession';
export const LOCAL_CONFIG_BACKUP_KEY = 'localProviderConfigBackup';
export const ACCOUNT_CONFIG_CACHE_KEY = 'accountProviderConfigCache';
export const PROVIDER_CONFIG_KEY = 'providerConfig';
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

function readBuiltInAccountServerUrl() {
  let raw = '';
  try {
    // Direct member access allows Vite to inline VITE_UNK_ACCOUNT_SERVER_URL at build time.
    raw = import.meta.env.VITE_UNK_ACCOUNT_SERVER_URL || '';
  } catch {}
  if (!raw && typeof process !== 'undefined' && process?.env) {
    raw = process.env.VITE_UNK_ACCOUNT_SERVER_URL || '';
  }
  const clean = String(raw || '').trim();
  if (!clean) return '';
  try {
    return normalizeServerUrl(clean);
  } catch {
    return '';
  }
}

export const DEFAULT_ACCOUNT_SERVER_URL = readBuiltInAccountServerUrl();

export function hasBuiltInAccountServerUrl(url = DEFAULT_ACCOUNT_SERVER_URL) {
  return Boolean(String(url || '').trim());
}

export function hasSavedAccountSession(session) {
  return Boolean(
    session &&
    typeof session === 'object' &&
    typeof session.token === 'string' &&
    session.token.trim() &&
    session.user &&
    typeof session.user.username === 'string' &&
    session.user.username.trim(),
  );
}

export function isBuiltInAccountMcpProxyUrl(parsed, configuredUrl = DEFAULT_ACCOUNT_SERVER_URL) {
  const base = String(configuredUrl || '').trim();
  if (!parsed || typeof parsed !== 'object' || !base) return false;
  try {
    const origin = new URL(base).origin;
    return parsed.origin === origin && String(parsed.pathname || '').startsWith('/api/unk/mcp/');
  } catch {
    return false;
  }
}

let operationQueue = Promise.resolve();

function serialize(fn) {
  const next = operationQueue.then(fn, fn);
  operationQueue = next.catch(() => {});
  return next;
}

function defaultStorage() {
  return globalThis.chrome?.storage?.local || null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function redactSecret(text, secret) {
  let out = String(text || '');
  if (typeof secret === 'string' && secret.trim()) {
    out = out.split(secret).join('[redacted]').split(secret.trim()).join('[redacted]');
  }
  return out.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}

/**
 * Normalize the server base URL (e.g. `http://127.0.0.1:7864` or `https://ai.example.com`).
 * Strips trailing `/v1` or `/` so both API calls and `/v1` projection stay consistent.
 */
export function normalizeServerUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('请填写账号服务器地址。');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('服务器地址不是有效的 HTTP 或 HTTPS URL。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('服务器地址必须使用 HTTP 或 HTTPS 协议。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('服务器地址中不能包含用户名或密码。');
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${parsed.origin}${cleanPath}`.replace(/\/+$/, '');
}

export function defaultAccountSession() {
  return {
    version: 1,
    mode: 'local',
    serverUrl: DEFAULT_ACCOUNT_SERVER_URL,
    token: '',
    expiresAt: '',
    user: null,
    configMode: 'inherit',
    configVersion: '',
    lastSyncedAt: '',
    status: 'idle',
    yingmi: { enabled: false, endpoint: '' },
  };
}

export function normalizeAccountSession(raw) {
  const defaults = defaultAccountSession();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  let serverUrl = defaults.serverUrl;
  if (typeof raw.serverUrl === 'string' && raw.serverUrl.trim()) {
    try { serverUrl = normalizeServerUrl(raw.serverUrl); } catch { serverUrl = defaults.serverUrl; }
  }
  const mode = raw.mode === 'account' ? 'account' : 'local';
  const status = ['idle', 'active', 'expired', 'disabled'].includes(raw.status)
    ? raw.status
    : (mode === 'account' ? 'active' : 'idle');
  const user = raw.user && typeof raw.user === 'object' && typeof raw.user.username === 'string'
    ? {
        id: String(raw.user.id || ''),
        username: String(raw.user.username || ''),
        displayName: String(raw.user.displayName || raw.user.username || ''),
      }
    : null;
  const yingmi = raw.yingmi && typeof raw.yingmi === 'object'
    ? {
        enabled: Boolean(raw.yingmi.enabled),
        endpoint: typeof raw.yingmi.endpoint === 'string' ? raw.yingmi.endpoint : '',
      }
    : { enabled: false, endpoint: '' };

  return {
    version: 1,
    mode,
    serverUrl,
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
    user,
    configMode: raw.configMode === 'custom' ? 'custom' : 'inherit',
    configVersion: typeof raw.configVersion === 'string' ? raw.configVersion : '',
    lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : '',
    status,
    yingmi,
  };
}

export function projectRemoteProfileToProviderConfig({ serverUrl, token, profile } = {}) {
  const base = normalizeServerUrl(serverUrl);
  const p = profile && typeof profile === 'object' ? profile : {};
  const normalized = normalizeProviderConfig({
    version: 4,
    endpointUrl: `${base}/v1`,
    apiKey: String(token || '').trim(),
    webSearchEndpoint: p.webSearchEndpoint || 'tools/search',
    webFetchEndpoint: p.webFetchEndpoint || 'tools/fetch',
    webSearchEnabled: p.webSearchEnabled !== false,
    webFetchEnabled: p.webFetchEnabled !== false,
    selectedModelId: p.selectedModelId || '',
    selectedEffort: p.selectedEffort || 'default',
    selectedImageModelId: p.selectedImageModelId || '',
    models: Array.isArray(p.models) ? p.models : [],
  });
  return { ...normalized, version: 4 };
}

async function requestJson(url, { method = 'GET', token = '', body, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持网络请求。');
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const response = await awaitWithTimeout(
      fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit',
        signal: controller.signal,
      }),
      {
        signal: controller.signal,
        timeoutMs,
        message: '请求账号服务超时，请检查网络后重试。',
        onTimeout: () => controller.abort(new DOMException('请求超时', 'TimeoutError')),
      },
    );
    const text = await response.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: response.ok, status: response.status, data, text };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
    throw new Error('无法连接到账号服务，请检查网络或稍后重试。', { cause: error });
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export async function loginAccount({ serverUrl, username, password, signal, fetchImpl = globalThis.fetch } = {}) {
  const cleanServerUrl = normalizeServerUrl(serverUrl);
  const cleanUser = String(username || '').trim();
  const rawPwd = String(password || '');
  if (!cleanUser || !rawPwd) throw new Error('请输入账号和密码。');

  const res = await requestJson(`${cleanServerUrl}/api/unk/login`, {
    method: 'POST',
    body: { username: cleanUser, password: rawPwd },
    signal,
    fetchImpl,
  });
  if (!res.ok || !res.data?.token) {
    const code = res.data?.error || '';
    const msg = res.data?.message || `登录失败（HTTP ${res.status}）`;
    const err = new Error(redactSecret(msg, rawPwd));
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return {
    serverUrl: cleanServerUrl,
    token: String(res.data.token),
    expiresAt: String(res.data.expiresAt || ''),
    user: res.data.user || { id: '', username: cleanUser, displayName: cleanUser },
    configMode: res.data.configMode === 'custom' ? 'custom' : 'inherit',
    configVersion: String(res.data.configVersion || ''),
    profile: res.data.profile || {},
    yingmi: res.data.yingmi || { enabled: false, endpoint: '' },
  };
}

export async function fetchAccountProfile({ serverUrl, token, version = '', signal, fetchImpl = globalThis.fetch } = {}) {
  const cleanServerUrl = normalizeServerUrl(serverUrl);
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('缺少登录凭证。');
  const qs = version ? `?version=${encodeURIComponent(version)}` : '';
  const res = await requestJson(`${cleanServerUrl}/api/unk/profile${qs}`, {
    method: 'GET',
    token: cleanToken,
    signal,
    fetchImpl,
  });
  if (!res.ok) {
    const err = new Error(redactSecret(res.data?.message || `同步模型配置失败（HTTP ${res.status}）`, cleanToken));
    err.status = res.status;
    err.code = res.data?.error || '';
    throw err;
  }
  return {
    serverUrl: cleanServerUrl,
    unchanged: Boolean(res.data?.unchanged),
    configVersion: String(res.data?.configVersion || ''),
    configMode: res.data?.configMode === 'custom' ? 'custom' : 'inherit',
    user: res.data?.user || null,
    profile: res.data?.profile || null,
    yingmi: res.data?.yingmi || null,
  };
}

export async function logoutAccount({ serverUrl, token, signal, fetchImpl = globalThis.fetch } = {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return { ok: true };
  const cleanServerUrl = normalizeServerUrl(serverUrl);
  await requestJson(`${cleanServerUrl}/api/unk/logout`, {
    method: 'POST',
    token: cleanToken,
    body: {},
    signal,
    timeoutMs: 4000,
    fetchImpl,
  });
  return { ok: true };
}

export async function changeAccountPassword({
  serverUrl,
  token,
  currentPassword,
  newPassword,
  signal,
  fetchImpl = globalThis.fetch,
  storage = defaultStorage(),
} = {}) {
  const cleanServerUrl = normalizeServerUrl(serverUrl);
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('尚未登录账号。');
  if (!currentPassword || !newPassword || String(newPassword).length < 6) {
    throw new Error('新密码长度至少需要 6 位。');
  }
  const res = await requestJson(`${cleanServerUrl}/api/unk/password`, {
    method: 'POST',
    token: cleanToken,
    body: { currentPassword, newPassword },
    signal,
    fetchImpl,
  });
  if (!res.ok || !res.data?.token) {
    const err = new Error(redactSecret(res.data?.message || `修改密码失败（HTTP ${res.status}）`, cleanToken));
    err.status = res.status;
    err.code = res.data?.error || '';
    throw err;
  }
  const nextToken = String(res.data.token);
  const nextExpiresAt = String(res.data.expiresAt || '');
  await serialize(async () => {
    if (!storage?.get || !storage?.set) return;
    const data = await storage.get([ACCOUNT_SESSION_KEY, PROVIDER_CONFIG_KEY, ACCOUNT_CONFIG_CACHE_KEY]);
    const session = normalizeAccountSession(data?.[ACCOUNT_SESSION_KEY]);
    if (hasSavedAccountSession(session)) {
      session.token = nextToken;
      session.expiresAt = nextExpiresAt;
      session.status = 'active';
      const payload = { [ACCOUNT_SESSION_KEY]: session };
      if (session.mode === 'account' && data?.[PROVIDER_CONFIG_KEY]) {
        const updatedConfig = normalizeProviderConfig({
          ...data[PROVIDER_CONFIG_KEY],
          apiKey: nextToken,
        });
        payload[PROVIDER_CONFIG_KEY] = { ...updatedConfig, version: 4 };
      }
      const cached = data?.[ACCOUNT_CONFIG_CACHE_KEY]?.config;
      if (cached) {
        const updatedCache = normalizeProviderConfig({
          ...cached,
          apiKey: nextToken,
        });
        payload[ACCOUNT_CONFIG_CACHE_KEY] = {
          version: 1,
          savedAt: new Date().toISOString(),
          config: { ...updatedCache, version: 4 },
        };
      }
      await storage.set(payload);
    }
  });
  return { ok: true, token: nextToken, expiresAt: nextExpiresAt };
}

export async function getAccountSession(storage = defaultStorage()) {
  if (!storage?.get) return defaultAccountSession();
  try {
    const data = await storage.get(ACCOUNT_SESSION_KEY);
    return normalizeAccountSession(data?.[ACCOUNT_SESSION_KEY]);
  } catch {
    return defaultAccountSession();
  }
}

/**
 * Enter Account Login Mode:
 * - Backs up the latest local `providerConfig` into `localProviderConfigBackup` when transitioning from `local` mode,
 *   while re-logins in `account` mode keep the existing local backup intact.
 * - Writes `accountSession`, `providerConfig`, and `accountProviderConfigCache`.
 */
export async function enterAccountMode(loginResult, storage = defaultStorage()) {
  if (!storage?.get || !storage?.set) throw new Error('本地存储不可用。');
  return serialize(async () => {
    const data = await storage.get([ACCOUNT_SESSION_KEY, LOCAL_CONFIG_BACKUP_KEY, PROVIDER_CONFIG_KEY]);
    const prevSession = normalizeAccountSession(data?.[ACCOUNT_SESSION_KEY]);
    const nowIso = new Date().toISOString();
    const toSave = {};

    if (prevSession.mode !== 'account') {
      const existingConfig = normalizeProviderConfig(data?.[PROVIDER_CONFIG_KEY]);
      toSave[LOCAL_CONFIG_BACKUP_KEY] = {
        version: 1,
        savedAt: nowIso,
        config: existingConfig ? clone(existingConfig) : null,
      };
    }

    const nextSession = normalizeAccountSession({
      version: 1,
      mode: 'account',
      serverUrl: loginResult.serverUrl,
      token: loginResult.token,
      expiresAt: loginResult.expiresAt,
      user: loginResult.user,
      configMode: loginResult.configMode,
      configVersion: loginResult.configVersion,
      lastSyncedAt: nowIso,
      status: 'active',
      yingmi: loginResult.yingmi,
    });
    const projectedConfig = projectRemoteProfileToProviderConfig({
      serverUrl: nextSession.serverUrl,
      token: nextSession.token,
      profile: loginResult.profile,
    });
    toSave[ACCOUNT_SESSION_KEY] = nextSession;
    toSave[PROVIDER_CONFIG_KEY] = projectedConfig;
    toSave[ACCOUNT_CONFIG_CACHE_KEY] = {
      version: 1,
      savedAt: nowIso,
      config: clone(projectedConfig),
    };
    await storage.set(toSave);
    return { session: nextSession, providerConfig: projectedConfig };
  });
}

/**
 * Switch temporarily to local API mode WITHOUT logging out or clearing the saved account session.
 * Restores any backed-up local `providerConfig` while keeping account config cached in `accountProviderConfigCache`.
 */
export async function switchToLocalMode(storage = defaultStorage()) {
  if (!storage?.get || !storage?.set) throw new Error('本地存储不可用。');
  return serialize(async () => {
    const data = await storage.get([
      ACCOUNT_SESSION_KEY,
      LOCAL_CONFIG_BACKUP_KEY,
      ACCOUNT_CONFIG_CACHE_KEY,
      PROVIDER_CONFIG_KEY,
    ]);
    const prevSession = normalizeAccountSession(data?.[ACCOUNT_SESSION_KEY]);
    if (prevSession.mode !== 'account') {
      return {
        session: prevSession,
        providerConfig: normalizeProviderConfig(data?.[PROVIDER_CONFIG_KEY]) || null,
      };
    }

    const nowIso = new Date().toISOString();
    const backup = data?.[LOCAL_CONFIG_BACKUP_KEY];
    const restoredConfig = backup && typeof backup === 'object' && backup.config
      ? normalizeProviderConfig(backup.config)
      : null;

    const currentAccountConfig = normalizeProviderConfig(data?.[PROVIDER_CONFIG_KEY]);
    const nextSession = normalizeAccountSession({
      ...prevSession,
      mode: 'local',
    });

    const toSet = { [ACCOUNT_SESSION_KEY]: nextSession };
    if (currentAccountConfig) {
      toSet[ACCOUNT_CONFIG_CACHE_KEY] = {
        version: 1,
        savedAt: nowIso,
        config: clone({ ...currentAccountConfig, version: 4 }),
      };
    }
    const toRemove = [LOCAL_CONFIG_BACKUP_KEY];
    if (restoredConfig) {
      toSet[PROVIDER_CONFIG_KEY] = { ...restoredConfig, version: 4 };
    } else {
      toRemove.push(PROVIDER_CONFIG_KEY);
    }

    await storage.set(toSet);
    if (storage.remove) await storage.remove(toRemove);
    return { session: nextSession, providerConfig: restoredConfig };
  });
}

/**
 * Resume a previously logged-in account session cleanly from local API mode,
 * backing up any edits made in local API mode and restoring the cached account `providerConfig`.
 */
export async function switchToAccountMode({ storage = defaultStorage() } = {}) {
  if (!storage?.get || !storage?.set) throw new Error('本地存储不可用。');
  return serialize(async () => {
    const data = await storage.get([
      ACCOUNT_SESSION_KEY,
      LOCAL_CONFIG_BACKUP_KEY,
      ACCOUNT_CONFIG_CACHE_KEY,
      PROVIDER_CONFIG_KEY,
    ]);
    const prevSession = normalizeAccountSession(data?.[ACCOUNT_SESSION_KEY]);
    if (!hasSavedAccountSession(prevSession)) {
      return { ok: false, needsLogin: true, session: prevSession, providerConfig: null };
    }
    if (prevSession.mode === 'account') {
      return {
        ok: true,
        session: prevSession,
        providerConfig: normalizeProviderConfig(data?.[PROVIDER_CONFIG_KEY]) || null,
      };
    }

    const nowIso = new Date().toISOString();
    const existingLocal = normalizeProviderConfig(data?.[PROVIDER_CONFIG_KEY]);
    const cachedRaw = data?.[ACCOUNT_CONFIG_CACHE_KEY]?.config;
    const cachedConfig = cachedRaw ? normalizeProviderConfig(cachedRaw) : null;
    const nextSession = normalizeAccountSession({
      ...prevSession,
      mode: 'account',
      serverUrl: prevSession.serverUrl || DEFAULT_ACCOUNT_SERVER_URL,
    });

    const toSet = {
      [ACCOUNT_SESSION_KEY]: nextSession,
      [LOCAL_CONFIG_BACKUP_KEY]: {
        version: 1,
        savedAt: nowIso,
        config: existingLocal ? clone(existingLocal) : null,
      },
    };
    const toRemove = [];
    if (cachedConfig) {
      toSet[PROVIDER_CONFIG_KEY] = { ...cachedConfig, version: 4 };
    } else {
      toRemove.push(PROVIDER_CONFIG_KEY);
    }

    await storage.set(toSet);
    if (toRemove.length && storage.remove) await storage.remove(toRemove);
    return { ok: true, session: nextSession, providerConfig: cachedConfig };
  });
}

/**
 * Sync the active account's remote UNK profile into `providerConfig`.
 * - 401/disabled marks `accountSession.status` without erasing local backup or throwing mid-startup.
 * - Network/offline errors degrade gracefully and preserve the last synced `providerConfig`.
 */
export async function syncAccountProfile({
  storage = defaultStorage(),
  fetchImpl = globalThis.fetch,
  signal,
  force = false,
} = {}) {
  const initial = await getAccountSession(storage);
  if (initial.mode !== 'account' || !initial.token || !initial.serverUrl) {
    return { ok: false, skipped: true, reason: 'not_account_mode', session: initial };
  }

  let remote;
  try {
    remote = await fetchAccountProfile({
      serverUrl: initial.serverUrl,
      token: initial.token,
      version: force ? '' : initial.configVersion,
      signal,
      fetchImpl,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (error?.status === 401 || error?.status === 403) {
      const nextStatus = error.code === 'unk_account_disabled' ? 'disabled' : 'expired';
      const updated = await serialize(async () => {
        const current = await getAccountSession(storage);
        if (current.mode !== 'account' || current.token !== initial.token) return current;
        const next = { ...current, status: nextStatus };
        await storage.set({ [ACCOUNT_SESSION_KEY]: next });
        return next;
      });
      return { ok: false, status: nextStatus, message: error.message, session: updated };
    }
    return { ok: false, offline: true, message: error?.message || '无法连接账号服务器。', session: initial };
  }

  return serialize(async () => {
    const current = await getAccountSession(storage);
    if (current.mode !== 'account' || current.token !== initial.token) {
      return { ok: false, skipped: true, reason: 'session_changed', session: current };
    }
    const nowIso = new Date().toISOString();
    if (remote.unchanged) {
      const next = { ...current, lastSyncedAt: nowIso, status: 'active' };
      await storage.set({ [ACCOUNT_SESSION_KEY]: next });
      return { ok: true, changed: false, session: next };
    }

    const next = normalizeAccountSession({
      ...current,
      user: remote.user || current.user,
      configMode: remote.configMode || current.configMode,
      configVersion: remote.configVersion || current.configVersion,
      yingmi: remote.yingmi || current.yingmi,
      lastSyncedAt: nowIso,
      status: 'active',
    });
    const projectedConfig = projectRemoteProfileToProviderConfig({
      serverUrl: next.serverUrl,
      token: next.token,
      profile: remote.profile,
    });
    await storage.set({
      [ACCOUNT_SESSION_KEY]: next,
      [PROVIDER_CONFIG_KEY]: projectedConfig,
      [ACCOUNT_CONFIG_CACHE_KEY]: {
        version: 1,
        savedAt: nowIso,
        config: clone(projectedConfig),
      },
    });
    return { ok: true, changed: true, session: next, providerConfig: projectedConfig };
  });
}

/**
 * Explicitly log out of the saved account session and clear its cached remote config.
 * When called while in `account` mode, losslessly restores `localProviderConfigBackup`.
 * When called from `local` mode (clearing a parked account), keeps current local `providerConfig`.
 */
export async function exitAccountMode({
  revokeRemote = true,
  storage = defaultStorage(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = await getAccountSession(storage);
  if (revokeRemote && hasSavedAccountSession(current) && current.serverUrl) {
    try {
      await logoutAccount({ serverUrl: current.serverUrl, token: current.token, fetchImpl });
    } catch {
      // Network failure must never block logging out cleanly on the client.
    }
  }

  if (!storage?.get || !storage?.set) return { session: defaultAccountSession(), restoredConfig: null };
  return serialize(async () => {
    const data = await storage.get([ACCOUNT_SESSION_KEY, LOCAL_CONFIG_BACKUP_KEY, PROVIDER_CONFIG_KEY]);
    const latest = normalizeAccountSession(data?.[ACCOUNT_SESSION_KEY]);
    const wasAccountMode = latest.mode === 'account';
    const backup = data?.[LOCAL_CONFIG_BACKUP_KEY];
    const restoredConfig = wasAccountMode
      ? (backup && typeof backup === 'object' && backup.config ? normalizeProviderConfig(backup.config) : null)
      : (normalizeProviderConfig(data?.[PROVIDER_CONFIG_KEY]) || null);

    const nextSession = {
      ...defaultAccountSession(),
      mode: 'local',
      serverUrl: DEFAULT_ACCOUNT_SERVER_URL,
      status: 'idle',
    };

    const toSet = { [ACCOUNT_SESSION_KEY]: nextSession };
    const toRemove = [LOCAL_CONFIG_BACKUP_KEY, ACCOUNT_CONFIG_CACHE_KEY];
    if (wasAccountMode) {
      if (restoredConfig) {
        toSet[PROVIDER_CONFIG_KEY] = { ...restoredConfig, version: 4 };
      } else {
        toRemove.push(PROVIDER_CONFIG_KEY);
      }
    }

    await storage.set(toSet);
    if (storage.remove) await storage.remove(toRemove);
    return { session: nextSession, restoredConfig };
  });
}

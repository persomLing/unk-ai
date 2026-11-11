const SETTINGS_KEY = 'agentSettings';
const GRANTS_KEY = 'agentOriginGrants';
const GRANTS_LOCK = 'unk-ai-agent-origin-grants';
let grantWrites = Promise.resolve();

/**
 * Grants share one stored object, so the entire read/change/write must run
 * under the same extension-origin lock in side panels and the options page.
 * Keep a local queue for environments without Web Locks; that fallback only
 * serializes this module instance. A caller timeout must not release the lock
 * before the actual storage write has settled.
 */
function mutateGrants(operation) {
  const pending = grantWrites.catch(() => {}).then(() => {
    const locks = globalThis.navigator?.locks;
    return locks?.request ? locks.request(GRANTS_LOCK, operation) : operation();
  });
  grantWrites = pending.catch(() => {});
  return pending;
}

export const DEFAULT_AGENT_SETTINGS = Object.freeze({
  enabled: false,
  strictMode: false,
  captureEvidence: true,
  maxSteps: 20,
  maxMinutes: 5,
});

export const RESTRICTED_AGENT_SCHEMES = /^(?:chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|file):/i;
const RESTRICTED_AGENT_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com']);

function storageArea() {
  const area = globalThis.chrome?.storage?.local;
  if (!area) throw new Error('chrome.storage.local 不可用。');
  return area;
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

export function normalizeAgentSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    enabled: input.enabled === true,
    strictMode: input.strictMode === true,
    captureEvidence: input.captureEvidence !== false,
    maxSteps: clamp(input.maxSteps, 5, 40, DEFAULT_AGENT_SETTINGS.maxSteps),
    maxMinutes: clamp(input.maxMinutes, 1, 30, DEFAULT_AGENT_SETTINGS.maxMinutes),
  };
}

export function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

export function isHttpUrl(url) {
  return Boolean(originOf(url));
}

export function agentPageError(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return '无法识别当前页面地址。';
  }
  const host = parsed.hostname;
  if (RESTRICTED_AGENT_SCHEMES.test(parsed.href) || RESTRICTED_AGENT_HOSTS.has(host)) {
    return '这个页面不允许浏览器控制。请切换到普通 http/https 网页后重试。';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return '只支持 http/https 网页。';
  }
  return '';
}

export async function getAgentSettings() {
  const result = await storageArea().get(SETTINGS_KEY);
  return normalizeAgentSettings(result?.[SETTINGS_KEY]);
}

export async function saveAgentSettings(patch) {
  const current = await getAgentSettings();
  const next = normalizeAgentSettings({ ...current, ...(patch || {}) });
  await storageArea().set({ [SETTINGS_KEY]: next });
  return next;
}

function normalizeGrants(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const grants = {};
  for (const [origin, grant] of Object.entries(value)) {
    if (!originOf(origin) || originOf(origin) !== origin) continue;
    if (!grant || typeof grant !== 'object') continue;
    if (grant.scope === 'always') {
      grants[origin] = {
        scope: 'always',
        grantedAt: typeof grant.grantedAt === 'string' ? grant.grantedAt : '',
      };
    } else if (grant.scope === 'task' && typeof grant.taskId === 'string' && grant.taskId) {
      grants[origin] = {
        scope: 'task',
        taskId: grant.taskId,
        grantedAt: typeof grant.grantedAt === 'string' ? grant.grantedAt : '',
      };
    }
  }
  return grants;
}

export async function getOriginGrants() {
  const result = await storageArea().get(GRANTS_KEY);
  return normalizeGrants(result?.[GRANTS_KEY]);
}

export async function getOriginGrant(origin, taskId = '') {
  if (!origin) return null;
  const grants = await getOriginGrants();
  const grant = grants[origin];
  if (!grant) return null;
  if (grant.scope === 'always') return grant;
  if (taskId && grant.taskId === taskId) return grant;
  return null;
}

export async function grantOrigin(origin, { scope = 'task', taskId = '' } = {}) {
  if (!origin || originOf(origin) !== origin) throw new Error('站点地址无效。');
  if (scope !== 'always' && (!taskId || typeof taskId !== 'string')) {
    throw new Error('本次任务授权缺少任务 ID。');
  }
  return mutateGrants(async () => {
    const grants = await getOriginGrants();
    grants[origin] = scope === 'always'
      ? { scope: 'always', grantedAt: new Date().toISOString() }
      : { scope: 'task', taskId, grantedAt: new Date().toISOString() };
    await storageArea().set({ [GRANTS_KEY]: grants });
    return grants[origin];
  });
}

export async function revokeOrigin(origin) {
  return mutateGrants(async () => {
    const grants = await getOriginGrants();
    if (!grants[origin]) return false;
    delete grants[origin];
    await storageArea().set({ [GRANTS_KEY]: grants });
    return true;
  });
}

export async function clearTaskGrants(taskId) {
  if (!taskId) return 0;
  return mutateGrants(async () => {
    const grants = await getOriginGrants();
    let removed = 0;
    for (const [origin, grant] of Object.entries(grants)) {
      if (grant.scope === 'task' && grant.taskId === taskId) {
        delete grants[origin];
        removed += 1;
      }
    }
    if (removed) await storageArea().set({ [GRANTS_KEY]: grants });
    return removed;
  });
}

export async function listOriginGrants() {
  const grants = await getOriginGrants();
  return Object.entries(grants)
    .map(([origin, grant]) => ({ origin, ...grant }))
    .sort((left, right) => left.origin.localeCompare(right.origin));
}

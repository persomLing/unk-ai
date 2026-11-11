import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AGENT_SETTINGS,
  agentPageError,
  clearTaskGrants,
  getAgentSettings,
  getOriginGrant,
  grantOrigin,
  listOriginGrants,
  normalizeAgentSettings,
  originOf,
  revokeOrigin,
  saveAgentSettings,
} from '../src/utils/agent-permissions.js';

function createChrome(t) {
  const data = new Map();
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const local = {
    async get(keys) {
      const requested = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      const result = {};
      for (const key of requested) if (data.has(key)) result[key] = clone(data.get(key));
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, clone(value));
    },
  };
  globalThis.chrome = { storage: { local } };
  t.after(() => { delete globalThis.chrome; });
  return { data };
}

function installLocks(t, locks) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  });
}

function sharedLocks() {
  const queues = new Map();
  return {
    request(name, operation) {
      const pending = (queues.get(name) || Promise.resolve()).catch(() => {}).then(operation);
      queues.set(name, pending);
      return pending;
    },
  };
}

test('agent settings default to disabled and normalize bounds', async (t) => {
  createChrome(t);
  assert.deepEqual(await getAgentSettings(), DEFAULT_AGENT_SETTINGS);
  const saved = await saveAgentSettings({ enabled: true, strictMode: true, maxSteps: 999, maxMinutes: 0 });
  assert.equal(saved.enabled, true);
  assert.equal(saved.strictMode, true);
  assert.equal(saved.maxSteps, 40);
  assert.equal(saved.maxMinutes, 1);
  assert.equal(normalizeAgentSettings({ captureEvidence: false }).captureEvidence, false);
});

test('task grants only work for the task that created them', async (t) => {
  createChrome(t);
  await grantOrigin('https://example.test', { scope: 'task', taskId: 'task-a' });
  assert.ok(await getOriginGrant('https://example.test', 'task-a'));
  assert.equal(await getOriginGrant('https://example.test', 'task-b'), null);
  await grantOrigin('https://always.test', { scope: 'always' });
  assert.equal((await getOriginGrant('https://always.test', 'task-b')).scope, 'always');
});

test('revoke and task-scoped cleanup remove only intended grants', async (t) => {
  createChrome(t);
  await grantOrigin('https://a.test', { scope: 'task', taskId: 'task-a' });
  await grantOrigin('https://b.test', { scope: 'task', taskId: 'task-b' });
  await grantOrigin('https://c.test', { scope: 'always' });
  assert.equal(await clearTaskGrants('task-a'), 1);
  assert.equal(await getOriginGrant('https://a.test', 'task-a'), null);
  assert.ok(await getOriginGrant('https://b.test', 'task-b'));
  assert.ok(await getOriginGrant('https://c.test', 'any'));
  assert.equal(await revokeOrigin('https://b.test'), true);
  assert.equal(await revokeOrigin('https://b.test'), false);
  const list = await listOriginGrants();
  assert.deepEqual(list.map((item) => item.origin), ['https://c.test']);
});

test('concurrent grants and cleanup retain new grants without Web Locks in one module', async (t) => {
  createChrome(t);
  installLocks(t, undefined);
  await Promise.all([
    grantOrigin('https://a.test', { scope: 'task', taskId: 'old' }),
    grantOrigin('https://b.test', { scope: 'always' }),
  ]);
  assert.ok(await getOriginGrant('https://a.test', 'old'));
  assert.ok(await getOriginGrant('https://b.test', 'any'));
  await Promise.all([
    clearTaskGrants('old'),
    revokeOrigin('https://b.test'),
    grantOrigin('https://c.test', { scope: 'task', taskId: 'new' }),
  ]);
  assert.deepEqual((await listOriginGrants()).map(item => item.origin), ['https://c.test']);
});

test('a shared origin lock protects grants, revocation and cleanup across module instances', async (t) => {
  createChrome(t);
  installLocks(t, sharedLocks());
  // Distinct module instances model sidepanel/options contexts with independent
  // local queues but the same extension storage and Web Lock manager.
  const panel = await import('../src/utils/agent-permissions.js?panel');
  const options = await import('../src/utils/agent-permissions.js?options');
  await Promise.all([
    panel.grantOrigin('https://task.test', { scope: 'task', taskId: 'old' }),
    options.grantOrigin('https://revoked.test', { scope: 'always' }),
  ]);
  assert.ok(await panel.getOriginGrant('https://task.test', 'old'));
  assert.ok(await options.getOriginGrant('https://revoked.test', 'any'));
  await Promise.all([
    panel.clearTaskGrants('old'),
    options.grantOrigin('https://new.test', { scope: 'task', taskId: 'new' }),
    panel.revokeOrigin('https://revoked.test'),
  ]);
  assert.deepEqual((await panel.listOriginGrants()).map(item => item.origin), ['https://new.test']);
  assert.equal((await options.getOriginGrant('https://new.test', 'new')).taskId, 'new');
});

test('delayed old-task cleanup cannot remove a replacement task grant on the same origin', async (t) => {
  createChrome(t);
  installLocks(t, sharedLocks());
  const panel = await import('../src/utils/agent-permissions.js?replacement-panel');
  const previous = await import('../src/utils/agent-permissions.js?previous-panel');
  await previous.grantOrigin('https://same.test', { scope: 'task', taskId: 'old' });
  await Promise.all([
    panel.grantOrigin('https://same.test', { scope: 'task', taskId: 'new' }),
    previous.clearTaskGrants('old'),
  ]);
  assert.equal(await panel.getOriginGrant('https://same.test', 'old'), null);
  assert.equal((await panel.getOriginGrant('https://same.test', 'new')).taskId, 'new');
});

test('failed storage writes reject their caller and do not block later grant changes', async (t) => {
  createChrome(t);
  installLocks(t, sharedLocks());
  const local = chrome.storage.local;
  const write = local.set;
  let fail = true;
  local.set = async (value) => {
    if (fail) { fail = false; throw new Error('storage unavailable'); }
    return write(value);
  };
  const failed = grantOrigin('https://failed.test', { scope: 'always' });
  const succeeded = grantOrigin('https://ok.test', { scope: 'always' });
  await assert.rejects(failed, /storage unavailable/);
  await succeeded;
  assert.deepEqual((await listOriginGrants()).map(item => item.origin), ['https://ok.test']);
});

test('origin helpers reject restricted pages', () => {
  assert.equal(originOf('https://example.test/a'), 'https://example.test');
  assert.equal(originOf('file:///C:/a.pdf'), '');
  assert.equal(originOf('not a url'), '');
  assert.match(agentPageError('chrome://extensions'), /不允许/);
  assert.match(agentPageError('file:///C:/a.pdf'), /不允许|只支持/);
  assert.equal(agentPageError('https://example.test/a'), '');
});

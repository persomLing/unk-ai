import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERSATION_ORGANIZATION_KEY as KEY,
  createConversationOrganizationStore,
  normalizeConversationOrganization,
} from '../src/utils/conversation-organization.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function sharedLocks() {
  const queues = new Map();
  let active = 0, maximum = 0;
  return {
    get active() { return active; },
    get maximum() { return maximum; },
    request(name, operation) {
      const pending = (queues.get(name) || Promise.resolve()).catch(() => {}).then(async () => {
        active += 1; maximum = Math.max(maximum, active);
        try { return await operation(); } finally { active -= 1; }
      });
      queues.set(name, pending);
      return pending;
    },
  };
}

function fixture(t, { initial, locks = sharedLocks(), timeoutMs = 5000 } = {}) {
  const data = new Map();
  if (initial !== undefined) data.set(KEY, structuredClone(initial));
  const listeners = new Set(), writes = [];
  let sequence = 0;
  const hooks = {};
  const storage = {
    async get(key) {
      await hooks.get?.(key);
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(patch) {
      await hooks.set?.(patch);
      const changes = {};
      for (const [key, value] of Object.entries(patch)) {
        changes[key] = { oldValue: structuredClone(data.get(key)), newValue: structuredClone(value) };
        data.set(key, structuredClone(value));
      }
      writes.push(structuredClone(patch));
      for (const listener of listeners) listener(changes, 'local');
    },
  };
  const storageChanges = { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
  const stores = [];
  const create = options => {
    const store = createConversationOrganizationStore({
      storage, storageChanges, locks, timeoutMs,
      now: () => '2026-11-05T00:00:00.000Z', randomId: () => String(++sequence), ...options,
    });
    stores.push(store);
    return store;
  };
  const store = create();
  t.after(() => stores.forEach(value => value.dispose()));
  return { store, create, storage, data, hooks, writes, listeners, locks };
}

test('old histories without organization metadata start ungrouped without writing or changing records', async t => {
  const fx = fixture(t);
  const conversation = { id: 'old-conversation', title: '旧对话', updatedAt: '2025-01-01', messages: [{ content: '内容' }] };
  fx.data.set('unrelated-conversation', structuredClone(conversation));
  const index = await fx.store.read();
  assert.deepEqual(index, { version: 1, revision: 0, groups: [], assignments: {}, titles: {}, preferences: { view: 'groups', collapsed: [] } });
  assert.equal(fx.writes.length, 0);
  assert.deepEqual(fx.data.get('unrelated-conversation'), conversation);
});

test('group creation, rename, assignment and preferences persist across store instances', async t => {
  const fx = fixture(t);
  const created = await fx.store.createGroup('  云服务  ');
  const id = created.groups[0].id;
  assert.equal(created.groups[0].name, '云服务');
  assert.equal(created.groups[0].createdAt, '2026-11-05T00:00:00.000Z');
  await fx.store.moveConversations(['c1', 'c2', 'c1'], id);
  await fx.store.renameGroup(id, '云端资料');
  await fx.store.updatePreferences({ view: 'all', collapsed: [id, 'none', id] });
  const reopened = await fx.create().read();
  assert.equal(reopened.revision, 4);
  assert.deepEqual(reopened.assignments, { c1: id, c2: id });
  assert.equal(reopened.groups[0].name, '云端资料');
  assert.deepEqual(reopened.preferences, { view: 'all', collapsed: [id, 'none'] });
  assert.ok(fx.writes.every(write => Object.keys(write).length === 1 && Object.hasOwn(write, KEY)));
});

test('deleting a group ungroups only its members and retains their names and conversation data', async t => {
  const fx = fixture(t);
  const first = (await fx.store.createGroup('第一组')).groups[0].id;
  const second = (await fx.store.createGroup('第二组')).groups[1].id;
  await fx.store.moveConversations(['c1', 'c2'], first);
  await fx.store.moveConversations(['c3'], second);
  await fx.store.renameConversation('c1', '已改名对话');
  await fx.store.updatePreferences({ collapsed: [first, second, 'none'] });
  const record = { id: 'c1', messages: [{ content: '保留正文' }], updatedAt: '2026-01-01' };
  fx.data.set('conversation-record', structuredClone(record));
  const removed = await fx.store.deleteGroup(first);
  assert.deepEqual(removed.assignments, { c3: second });
  assert.deepEqual(removed.titles, { c1: '已改名对话' });
  assert.deepEqual(removed.preferences.collapsed, [second, 'none']);
  assert.deepEqual(fx.data.get('conversation-record'), record);
  assert.deepEqual(removed.groups.map(group => group.id), [second]);
});

test('conversation title overrides cannot be replaced by an unrelated old full conversation snapshot', async t => {
  const fx = fixture(t);
  const group = (await fx.store.createGroup('资料')).groups[0].id;
  await fx.store.moveConversations(['c1', 'c2'], group);
  const oldSnapshot = { id: 'c1', title: '旧名字', updatedAt: '2026-01-01', messages: [{ content: '历史消息' }] };
  fx.data.set('conversation:c1', structuredClone(oldSnapshot));
  await fx.store.renameConversation('c1', '  用户指定名称  ');
  await fx.storage.set({ 'conversation:c1': { ...oldSnapshot, messages: [...oldSnapshot.messages, { content: '迟到的辅助保存' }] } });
  const index = await fx.store.read();
  assert.equal(index.titles.c1, '用户指定名称');
  assert.deepEqual(index.assignments, { c1: group, c2: group });
  assert.equal(fx.data.get('conversation:c1').updatedAt, oldSnapshot.updatedAt);
  assert.equal(fx.data.get('conversation:c1').messages.length, 2);
});

test('moving to ungrouped does not change other groups and idempotent actions do not write extra revisions', async t => {
  const fx = fixture(t);
  const group = (await fx.store.createGroup('资料')).groups[0].id;
  await fx.store.moveConversations(['c1', 'c2'], group);
  const before = fx.writes.length;
  await fx.store.moveConversations(['c1'], group);
  await fx.store.moveConversations([], group);
  await fx.store.renameGroup(group, '资料');
  await fx.store.updatePreferences({ view: 'groups', collapsed: [] });
  assert.equal(fx.writes.length, before);
  const moved = await fx.store.moveConversations(['c1'], null);
  assert.deepEqual(moved.assignments, { c2: group });
  await fx.store.renameConversation('c2', '名称');
  const writes = fx.writes.length;
  await fx.store.renameConversation('c2', '名称');
  assert.equal(fx.writes.length, writes);
});

test('invalid names, duplicate groups and invalid destinations leave the index unchanged', async t => {
  const fx = fixture(t);
  const group = (await fx.store.createGroup('AI 学习')).groups[0].id;
  const before = await fx.store.read();
  for (const operation of [
    () => fx.store.createGroup('  '),
    () => fx.store.createGroup('未分组'),
    () => fx.store.createGroup('a'.repeat(25)),
    () => fx.store.createGroup('ai 学习'),
    () => fx.store.renameGroup(group, '含\n换行'),
    () => fx.store.renameGroup('missing', '缺失'),
    () => fx.store.deleteGroup('none'),
    () => fx.store.moveConversations(['c1'], 'missing'),
    () => fx.store.moveConversations(['__proto__'], group),
    () => fx.store.renameConversation('c1', 'x'.repeat(121)),
    () => fx.store.renameConversation('c1', ''),
    () => fx.store.updatePreferences({ view: 'invalid' }),
    () => fx.store.updatePreferences({ unexpected: true }),
  ]) await assert.rejects(operation);
  assert.deepEqual(await fx.store.read(), before);
  assert.equal(fx.writes.length, 1);
});

test('a missing or corrupt storage result and a newer schema never trigger a reset write', async t => {
  for (const invalid of [null, {}, { version: 2 }, { version: 1, revision: 0, groups: [], assignments: null }]) {
    const fx = fixture(t, { initial: invalid });
    await assert.rejects(fx.store.read());
    await assert.rejects(fx.store.createGroup('新分组'));
    assert.deepEqual(fx.data.get(KEY), invalid);
    assert.equal(fx.writes.length, 0);
  }
  const fx = fixture(t);
  fx.storage.get = async () => undefined;
  await assert.rejects(fx.store.createGroup('错误读取'), /读取历史分组失败/);
  assert.equal(fx.writes.length, 0);
});

test('parallel mutations in one instance retain all names and assignments without Web Locks', async t => {
  const fx = fixture(t, { locks: null });
  const index = await fx.store.createGroup('资料');
  const id = index.groups[0].id;
  await Promise.all([
    fx.store.moveConversations(['c1'], id),
    fx.store.renameConversation('c1', '第一条'),
    fx.store.moveConversations(['c2'], id),
    fx.store.renameConversation('c2', '第二条'),
  ]);
  const result = await fx.store.read();
  assert.equal(result.revision, 5);
  assert.deepEqual(result.assignments, { c1: id, c2: id });
  assert.deepEqual(result.titles, { c1: '第一条', c2: '第二条' });
});

test('shared Web Locks re-read the latest version before cross-document mutations', async t => {
  const fx = fixture(t);
  const other = fx.create();
  const group = (await fx.store.createGroup('资料')).groups[0].id;
  await Promise.all([
    fx.store.moveConversations(['c1'], group),
    other.renameConversation('c1', '改名'),
    other.moveConversations(['c2'], group),
    fx.store.updatePreferences({ view: 'all' }),
  ]);
  await Promise.all([fx.store.deleteGroup(group), other.renameConversation('c3', '另外一条')]);
  const result = await other.read();
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.assignments, {});
  assert.deepEqual(result.titles, { c1: '改名', c3: '另外一条' });
  assert.equal(result.preferences.view, 'all');
  assert.equal(result.revision, 7);
  assert.equal(fx.locks.maximum, 1);
});

test('queued commands fix their input arrays and preferences at submission time', async t => {
  const fx = fixture(t);
  const id = (await fx.store.createGroup('资料')).groups[0].id;
  const gate = deferred();
  fx.hooks.get = () => gate.promise;
  const ids = ['c1'], collapsed = [id];
  const moving = fx.store.moveConversations(ids, id);
  const preferences = fx.store.updatePreferences({ view: 'all', collapsed });
  ids[0] = 'c2'; collapsed.push('none');
  gate.resolve();
  await Promise.all([moving, preferences]);
  const result = await fx.store.read();
  assert.deepEqual(result.assignments, { c1: id });
  assert.deepEqual(result.preferences, { view: 'all', collapsed: [id] });
});

test('storage failures reject without optimistic notifications and the next mutation can recover', async t => {
  const fx = fixture(t);
  const notices = [];
  fx.store.subscribe(snapshot => notices.push(snapshot));
  fx.hooks.set = () => { throw new Error('quota failure'); };
  await assert.rejects(fx.store.createGroup('失败'), /quota failure/);
  assert.equal(notices.length, 0);
  assert.equal(fx.data.has(KEY), false);
  fx.hooks.set = null;
  await fx.store.createGroup('成功');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].groups[0].name, '成功');
});

test('a timed-out read cannot later create a group or release its lock while the read is still pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fx = fixture(t, { timeoutMs: 100 });
  const gate = deferred();
  fx.hooks.get = () => gate.promise;
  const task = fx.store.createGroup('迟到分组');
  const rejection = assert.rejects(task, error => error.name === 'TimeoutError');
  await tick();
  t.mock.timers.tick(100);
  await rejection;
  assert.equal(fx.locks.active, 1);
  gate.resolve();
  await tick();
  assert.equal(fx.locks.active, 0);
  assert.equal(fx.writes.length, 0);
  fx.hooks.get = null;
  assert.deepEqual((await fx.store.read()).groups, []);
});

test('timeout during a storage set retains the real lock until commit and later changes merge that committed revision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fx = fixture(t, { timeoutMs: 100 });
  const gate = deferred();
  let first = true;
  fx.hooks.set = () => { if (first) { first = false; return gate.promise; } };
  const task = fx.store.createGroup('已发出写入');
  const rejection = assert.rejects(task, error => error.name === 'TimeoutError');
  await tick();
  t.mock.timers.tick(100);
  await rejection;
  assert.equal(fx.locks.active, 1);
  const later = fx.create().renameConversation('c1', '后来的命名');
  await tick();
  assert.equal(fx.writes.length, 0);
  gate.resolve();
  const result = await later;
  assert.equal(result.groups[0].name, '已发出写入');
  assert.equal(result.titles.c1, '后来的命名');
  assert.equal(result.revision, 2);
  assert.equal(fx.locks.maximum, 1);
});

test('an expired command still queued behind a write cannot execute later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fx = fixture(t, { timeoutMs: 100 });
  const gate = deferred();
  fx.hooks.set = () => gate.promise;
  const first = fx.store.createGroup('先发出');
  const firstRejected = assert.rejects(first, error => error.name === 'TimeoutError');
  const queued = fx.store.renameConversation('c1', '已取消等待');
  const queuedRejected = assert.rejects(queued, error => error.name === 'TimeoutError');
  await tick();
  t.mock.timers.tick(100);
  await Promise.all([firstRejected, queuedRejected]);
  gate.resolve();
  await tick();
  assert.equal(fx.writes.length, 1);
  assert.deepEqual(fx.data.get(KEY).titles, {});
});

test('dispose cancels waiting callers, blocks queued writes and rejects late subscriptions or commands', async t => {
  const fx = fixture(t);
  const gate = deferred();
  fx.hooks.get = () => gate.promise;
  const notices = [];
  fx.store.subscribe(value => notices.push(value));
  const first = fx.store.createGroup('关闭中的分组');
  const rejected = assert.rejects(first, error => error.name === 'AbortError');
  const queued = fx.store.renameConversation('c1', '关闭后的命名');
  const queuedRejected = assert.rejects(queued, error => error.name === 'AbortError');
  await tick();
  fx.store.dispose();
  await Promise.all([rejected, queuedRejected]);
  gate.resolve();
  await tick();
  assert.equal(fx.writes.length, 0);
  assert.deepEqual(notices, []);
  assert.equal(fx.listeners.size, 0);
  await assert.rejects(fx.store.read(), error => error.name === 'AbortError');
  await assert.rejects(fx.store.createGroup('无效'), error => error.name === 'AbortError');
  assert.throws(() => fx.store.subscribe(() => {}), error => error.name === 'AbortError');
});

test('subscriptions receive detached committed snapshots once and observe valid external changes', async t => {
  const fx = fixture(t), received = [];
  fx.store.subscribe(snapshot => { received.push(snapshot); snapshot.groups.length = 0; });
  fx.store.subscribe(() => { throw new Error('subscriber bug'); });
  fx.store.subscribe(async () => { throw new Error('async subscriber bug'); });
  const created = await fx.store.createGroup('资料');
  assert.equal(received.length, 1);
  assert.equal(created.groups.length, 1);
  assert.equal((await fx.store.read()).groups.length, 1);
  const other = fx.create();
  await other.renameConversation('c1', '外部更名');
  assert.equal(received.length, 2);
  assert.equal(received[1].titles.c1, '外部更名');
  for (const listener of fx.listeners) listener({ [KEY]: { newValue: created } }, 'local');
  assert.equal(received.length, 2, 'late lower revisions cannot overwrite current UI state');
  await tick();
});

test('normalization keeps unrelated future-compatible v1 metadata and drops only stale collapse preferences', () => {
  const input = { version: 1, revision: 4, groups: [], assignments: {}, titles: {}, extra: { keep: true }, preferences: { view: 'all', collapsed: ['missing', 'none'], futurePreference: 1 } };
  const normalized = normalizeConversationOrganization(input);
  assert.deepEqual(normalized.extra, { keep: true });
  assert.deepEqual(normalized.preferences, { view: 'all', collapsed: ['none'], futurePreference: 1 });
  normalized.extra.keep = false;
  assert.equal(input.extra.keep, true);
});

test('a delayed storage event cannot downgrade the revision already returned by read', async t => {
  const initial = { version: 1, revision: 9, groups: [], assignments: {}, titles: { c1: '当前名称' }, preferences: { view: 'groups', collapsed: [] } };
  const fx = fixture(t, { initial }), notices = [];
  fx.store.subscribe(snapshot => notices.push(snapshot));
  assert.equal((await fx.store.read()).revision, 9);
  for (const listener of fx.listeners) listener({ [KEY]: { newValue: { ...initial, revision: 8, titles: { c1: '过期名称' } } } }, 'local');
  assert.equal(notices.length, 0);
});

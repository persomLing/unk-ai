import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createMessageRewind } from '../src/sidepanel/features/messages/message-rewind.js';
import { createAgentTaskRestart } from '../src/sidepanel/features/agent/agent-task-restart.js';
import { createHistoryNavigation } from '../src/sidepanel/features/history/history-navigation.js';
import { projectHistory } from '../src/sidepanel/features/history/history-model.js';
import { CONVERSATION_ORGANIZATION_KEY, createConversationOrganizationStore } from '../src/utils/conversation-organization.js';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function boundary(initial = { id: 'original' }) {
  let current = initial;
  const timers = new Set(), busy = [], errors = [];
  const navigation = createHistoryNavigation({
    getCurrent: () => current,
    onBusy: value => busy.push(value), onLateError: error => errors.push(error),
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn),
  });
  return { navigation, busy, errors, get current() { return current; }, set current(value) { current = value; },
    expire: () => [...timers].forEach(fn => fn()) };
}

test('a timed-out read releases navigation and cannot replace a newer conversation', async () => {
  const fixture = boundary(), read = deferred();
  const first = fixture.navigation.run(async operation => {
    const value = await operation.read(read.promise);
    operation.commit(() => { fixture.current = value; });
  });
  await tick(); fixture.expire();
  await assert.rejects(first, { name: 'TimeoutError' });
  await tick();
  assert.equal(fixture.navigation.busy, false);
  await fixture.navigation.run(operation => operation.commit(() => { fixture.current = { id: 'new' }; }));
  read.resolve({ id: 'late' }); await tick();
  assert.equal(fixture.current.id, 'new');
  assert.deepEqual(fixture.errors, []);
});

test('an expired callback queued behind another save cannot start a later write', async () => {
  const fixture = boundary(), queue = deferred();
  let writes = 0;
  const first = fixture.navigation.run(async operation => {
    await operation.read(queue.promise.then(async () => {
      operation.assertCurrent();
      await operation.persist(async () => { writes += 1; });
    }));
  });
  await tick(); fixture.expire(); await assert.rejects(first, { name: 'TimeoutError' });
  queue.resolve(); await tick();
  assert.equal(writes, 0);
  assert.equal(fixture.navigation.busy, false);
});

test('a started single-slot write keeps ownership after observer timeout and prevents another navigation', async () => {
  const fixture = boundary(), write = deferred();
  const first = fixture.navigation.run(async operation => {
    const value = await operation.persist(() => write.promise);
    operation.commit(() => { fixture.current = value; });
  });
  await tick(); fixture.expire();
  await assert.rejects(first, /仍在保存/);
  assert.equal(fixture.navigation.busy, true);
  await assert.rejects(fixture.navigation.run(() => {}), /上一项历史操作/);
  assert.deepEqual(fixture.busy, [true]);
  write.resolve({ id: 'confirmed-draft' }); await tick();
  assert.equal(fixture.current.id, 'confirmed-draft');
  assert.equal(fixture.navigation.busy, false);
  assert.deepEqual(fixture.busy, [true, false]);
});

test('an unexpected owner change cannot be overwritten even by a confirmed write', async () => {
  const fixture = boundary(), write = deferred();
  const pending = fixture.navigation.run(async operation => {
    const value = await operation.persist(() => write.promise);
    operation.commit(() => { fixture.current = value; });
  });
  await tick(); fixture.current = { id: 'another-owner' }; write.resolve({ id: 'late' });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fixture.current.id, 'another-owner');
});

test('closing the sidebar prevents a pending write from starting the next operation or committing UI state', async () => {
  const fixture = boundary(), write = deferred();
  let secondWrites = 0;
  const pending = fixture.navigation.run(async operation => {
    await operation.persist(() => write.promise);
    await operation.persist(async () => { secondWrites += 1; });
    operation.commit(() => { fixture.current = { id: 'late' }; });
  });
  await tick(); fixture.navigation.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  write.resolve(); await tick();
  assert.equal(secondWrites, 0);
  assert.equal(fixture.current.id, 'original');
  await assert.rejects(fixture.navigation.run(() => {}), { name: 'AbortError' });
});

test('a failed write after observer timeout reports its outcome once and releases the gate', async () => {
  const fixture = boundary(), write = deferred();
  const pending = fixture.navigation.run(operation => operation.persist(() => write.promise));
  await tick(); fixture.expire(); await assert.rejects(pending, /仍在保存/);
  write.reject(new Error('storage quota')); await tick();
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0].message, /storage quota/);
  assert.equal(fixture.navigation.busy, false);
});

const source = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
function section(begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, `missing history UI section: ${begin}`);
  return source.slice(start, finish);
}
// These functions are UI adapters; use the real navigation boundary above.
const navigationSource = section('async function selectConversation(id)', 'async function ensureConversation(signal)');
const deletionSource = section('function historyDeletionBlocked(ids)', '\nhistorySidebar = createHistorySidebar(');
const regenerateSource = section('async function regenerate(assistantId)', 'async function exportChat(');
const messageHandlerSource = section("messagesElement.addEventListener('click', async (event) => {", "for (const dialog of document.querySelectorAll('dialog'))");

function entryFixture({ previous = { id: 'previous', storage: 'local', messages: [] }, moveError,
  load, promoteError, selectionChats } = {}) {
  const calls = [], timers = new Set();
  const records = new Map();
  if (previous?.storage === 'local') records.set(previous.id, structuredClone(previous));
  const state = { conversation: previous, conversations: [], attachments: [], messageQueue: [], ready: true, draft: '' };
  const input = { value: '', focus() { calls.push(['focus']); } };
  let handler, sequence = 0;
  let temporary = previous?.storage === 'temporary' ? structuredClone(previous) : null;
  let organizationSnapshot = {
    version: 1, revision: 0,
    groups: ['group', 'group-one'].map(id => ({ id, name: id, createdAt: '2026-11-09T00:00:00.000Z' })),
    assignments: {}, titles: {}, preferences: { view: 'groups', collapsed: [] },
  };
  const organization = createConversationOrganizationStore({
    storage: {
      get: async () => ({ [CONVERSATION_ORGANIZATION_KEY]: structuredClone(organizationSnapshot) }),
      set: async patch => { organizationSnapshot = structuredClone(patch[CONVERSATION_ORGANIZATION_KEY]); },
    }, storageChanges: null, locks: null,
  });
  const write = async conversation => {
    const saved = structuredClone(conversation);
    if (saved.storage === 'temporary') temporary = saved;
    else records.set(saved.id, saved);
    return saved;
  };
  const context = vm.createContext({
    state, input, historyMutationBusy: false, historyOrganization: null,
    pastedText: { getValue: () => input.value, setValue: value => { input.value = value; } },
    toast: (...args) => calls.push(['toast', ...args]),
    visualPreparation: { cancel: () => calls.push(['cancel']) },
    getDirectoryInfo: async () => ({ granted: false, configured: false }),
    requestDirectoryPermission: async () => false,
    loadConversation: async id => {
      calls.push(['load', id]);
      return load ? load(id) : structuredClone(records.get(id) || (temporary?.id === id ? temporary : null));
    },
    ...(selectionChats ? { selectionChats: new Set(selectionChats) } : {}),
    createTemporaryConversation: async () => {
      const id = ++sequence === 1 ? 'created' : `created-${sequence}`;
      calls.push(['create', id]);
      return write({ id, storage: 'temporary', title: '新对话', messages: [] });
    },
    promoteTemporaryConversation: async conversation => {
      calls.push(['promote', conversation.id]);
      if (promoteError) throw promoteError;
      const saved = await write({ ...conversation, storage: 'local', syncStatus: 'pending' });
      temporary = null;
      return saved;
    },
    conversationOrganization: { moveConversations: async (ids, group) => {
      calls.push(['move', ids, group]);
      if (moveError) throw moveError;
      return organization.moveConversations(Array.from(ids), group);
    } },
    conversationSaver: { flush() {}, enqueue: operation => Promise.resolve().then(operation) },
    renderConversation: () => calls.push(['render', state.conversation?.id]),
    renderStorageBadge: () => calls.push(['storage']),
    refreshHistory: async () => {
      calls.push(['refresh']);
      state.conversations = [...records.values()].map(record => ({ id: record.id, title: record.title,
        messageCount: record.messages.length }));
      context.historyOrganization = await organization.read();
    },
    setHistoryOpen: open => calls.push(['history', open]),
    processQueue: () => calls.push(['queue']),
    find: (values, predicate) => values?.find(predicate),
    messagesElement: { addEventListener: (_type, fn) => { handler = fn; } },
    agentSlot: { isBusy: () => false, getTask: () => ({ id: 'task' }), resume: async () => calls.push(['resume']), stop: async () => calls.push(['stop']) },
    agentTurnCallbacks: { reconcile: value => calls.push(['agent-reconcile', value.id]) },
    application: {
      repository: { reconcile: value => calls.push(['reconcile', value.id]) },
      conversations: { regenerate: async id => calls.push(['regenerate', id]) },
    },
  });
  context.historyNavigation = createHistoryNavigation({
    getCurrent: () => state.conversation,
    onBusy: busy => { context.historyMutationBusy = busy; calls.push(['busy', busy]); },
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn),
  });
  const blocked = () => context.historyMutationBusy ? '正在整理历史对话，请稍后。' : '';
  context.messageRewind = createMessageRewind({ getConversation: () => state.conversation, getBlockReason: blocked,
    applyDraft() {}, saveConversation: async () => {}, onChanged() {} });
  context.agentTaskRestart = createAgentTaskRestart({ getConversation: () => state.conversation, getBlockReason: blocked,
    notify: (...args) => calls.push(['toast', ...args]) });
  vm.runInContext(`${navigationSource}\n${deletionSource}\n${regenerateSource}\n${messageHandlerSource}`, context);
  return { context, state, input, calls, records, write,
    get temporary() { return temporary; },
    get projectedHistory() { return projectHistory(state.conversations, organizationSnapshot); },
    expire: () => [...timers].forEach(fn => fn()),
    newChat: group => context.newConversation(group), select: id => context.selectConversation(id),
    regenerate: id => context.regenerate(id),
    action: async (action, { agent = false } = {}) => {
      const button = { dataset: agent ? { agentAction: action } : { action }, closest: () => agent ? { dataset: { agentTask: 'task' } } : { dataset: { messageId: 'answer' } } };
      const target = { closest: selector => selector === (agent ? '[data-agent-action]' : '[data-action]') ? button : null };
      return handler({ target, preventDefault() {} });
    },
  };
}

for (const failure of ['missing-group', 'write-failure']) {
  test(`group assignment ${failure} opens the temporary draft and reports the failure without saving empty history`, async () => {
    const value = entryFixture(failure === 'write-failure' ? { moveError: new Error('索引写入失败') } : {});
    await value.newChat(failure === 'missing-group' ? 'removed-group' : 'group');
    assert.equal(value.state.conversation.id, 'created');
    assert.equal(value.state.conversation.storage, 'temporary');
    assert.ok(value.calls.some(([name, id]) => name === 'render' && id === 'created'));
    assert.ok(value.calls.some(([name, message]) => name === 'toast' && /临时会话.*归组未确认/.test(message)));
    assert.equal(value.calls.some(([name]) => name === 'promote'), false);
    assert.equal(value.records.has('created'), false);
    assert.equal(value.projectedHistory.all.some(entry => entry.id === 'created'), false);
    assert.equal(value.context.historyMutationBusy, false);
  });
}

test('creating a grouped blank draft does not require a durable outbox write', async () => {
  const value = entryFixture({ promoteError: new Error('outbox unavailable') });
  await value.newChat('group');
  assert.equal(value.state.conversation.id, 'created');
  assert.equal(value.state.conversation.storage, 'temporary');
  assert.equal(value.context.historyOrganization.assignments.created, 'group');
  assert.equal(value.calls.some(([name]) => name === 'promote' || name === 'toast'), false);
});

test('global and grouped new conversations stay temporary while the grouped draft keeps its assignment', async () => {
  const plain = entryFixture(); await plain.newChat();
  assert.equal(plain.state.conversation.storage, 'temporary');
  assert.equal(plain.calls.some(([name]) => name === 'move'), false);
  const grouped = entryFixture(); await grouped.newChat('group-one');
  assert.equal(grouped.state.conversation.storage, 'temporary');
  assert.equal(grouped.calls.find(([name]) => name === 'move')[2], 'group-one');
  assert.equal(grouped.context.historyOrganization.assignments.created, 'group-one');
  assert.equal(grouped.calls.some(([name]) => name === 'promote'), false);
  assert.equal(grouped.records.has('created'), false);
});

for (const draft of ['', '只输入，还没有发送']) {
  test(`switching away from a grouped ${draft ? 'unsent input' : 'blank'} draft does not save a conversation in history`, async () => {
    const value = entryFixture();
    await value.newChat('group-one');
    value.input.value = draft;
    value.state.draft = draft;
    await value.select('previous');
    assert.equal(value.state.conversation.id, 'previous');
    assert.deepEqual([...value.records.keys()], ['previous']);
    assert.equal(value.calls.some(([name]) => name === 'promote'), false);
    assert.equal(value.projectedHistory.all.some(entry => entry.id === 'created'), false);
    assert.equal(value.projectedHistory.all.filter(entry => entry.group === 'group-one').length, 0);
  });
}

test('repeated new conversation actions replace blank drafts without promoting any of them', async () => {
  const value = entryFixture();
  for (const group of ['group-one', null, 'group', 'none']) await value.newChat(group);
  assert.equal(value.state.conversation.id, 'created-4');
  assert.equal(value.state.conversation.storage, 'temporary');
  assert.equal(value.temporary.id, 'created-4');
  assert.deepEqual([...value.records.keys()], ['previous']);
  assert.equal(value.calls.some(([name]) => name === 'promote'), false);
  assert.equal(value.projectedHistory.all.length, 1);
});

for (const granted of [false, true]) {
  test(`a grouped draft's first submitted question ${granted ? 'promotes its original ID' : 'is still promoted by the next new conversation'} and retains its group`, async () => {
    const value = entryFixture();
    await value.newChat('group-one');
    const sender = createConversationServiceFixture({
      state: value.state, input: value.input,
      getDirectoryInfo: async () => ({ granted }),
      promoteTemporaryConversation: value.context.promoteTemporaryConversation,
      saveCurrent: ({ conversation }) => value.write(conversation),
      scheduleSave: () => { void value.write(value.state.conversation); },
    });
    value.input.value = '第一条实际发送的问题';
    await sender.sendMessage();
    await tick();
    assert.equal(sender.modelRequests.length, 1);
    assert.equal(value.state.conversation.id, 'created');
    assert.equal(value.state.conversation.storage, granted ? 'local' : 'temporary');
    await value.newChat('group');
    assert.deepEqual(value.calls.filter(([name]) => name === 'promote').map(([, id]) => id), ['created']);
    assert.equal(value.records.get('created').messages[0].role, 'user');
    assert.equal(value.records.get('created').messages[0].content, '第一条实际发送的问题');
    assert.equal(value.records.has('created-2'), false);
    assert.equal(value.projectedHistory.all.find(entry => entry.id === 'created').group, 'group-one');
    assert.equal(value.state.conversation.storage, 'temporary');
    assert.equal(value.context.historyOrganization.assignments['created-2'], 'group');
  });
}

test('a timed-out real history load cannot switch the entry after another navigation', async () => {
  const read = deferred(), value = entryFixture({ load: () => read.promise });
  const pending = value.select('late'); await tick(); value.expire();
  await assert.rejects(pending, { name: 'TimeoutError' }); await tick();
  await value.newChat();
  read.resolve({ id: 'late', messages: [] }); await tick();
  assert.equal(value.state.conversation.id, 'created');
  assert.equal(value.calls.some(([name, id]) => name === 'render' && id === 'late'), false);
});

test('opening a saved floating conversation delegates to its owner without loading a second snapshot or application', async () => {
  const handedOff = deferred(), opened = [];
  const floating = { conversationId: 'floating-chat', openInMain: () => { opened.push(floating.conversationId); return handedOff.promise; } };
  const value = entryFixture({ selectionChats: [floating], load: async id => ({ id, messages: [] }) });
  const original = value.state.conversation;
  const pending = value.select('floating-chat');
  await tick();
  assert.deepEqual(opened, ['floating-chat']);
  assert.equal(value.calls.some(([name]) => ['load', 'reconcile', 'agent-reconcile', 'render', 'cancel'].includes(name)), false);
  assert.equal(value.state.conversation, original);
  assert.equal(value.context.historyNavigation.busy, false);
  handedOff.resolve(true);
  assert.equal(await pending, true);
  assert.equal(value.calls.some(([name]) => ['load', 'reconcile', 'agent-reconcile', 'render'].includes(name)), false);
});

for (const outcome of ['blocked', 'failed']) {
  test(`a ${outcome} floating conversation handoff keeps the current main conversation and never falls back to a disk load`, async () => {
    let opens = 0;
    const floating = { conversationId: 'floating-chat', openInMain: async () => {
      opens++;
      if (outcome === 'failed') throw new Error('侧边对话保存失败');
      return false;
    } };
    const value = entryFixture({ selectionChats: [floating], load: async id => ({ id, messages: [] }) });
    const original = value.state.conversation;
    const pending = value.select('floating-chat');
    if (outcome === 'failed') await assert.rejects(pending, /侧边对话保存失败/);
    else assert.equal(await pending, false);
    assert.equal(opens, 1);
    assert.equal(value.state.conversation, original);
    assert.equal(value.calls.some(([name]) => ['load', 'reconcile', 'agent-reconcile', 'render'].includes(name)), false);
    assert.equal(value.context.historyNavigation.busy, false);
  });
}

test('a different saved conversation retains normal history loading while a floating owner is open', async () => {
  let opens = 0;
  const floating = { conversationId: 'floating-chat', openInMain: async () => { opens++; return true; } };
  const value = entryFixture({ selectionChats: [floating] });
  value.records.set('other-chat', { id: 'other-chat', storage: 'local', messages: [] });
  await value.select('other-chat');
  assert.equal(opens, 0);
  assert.equal(value.state.conversation.id, 'other-chat');
  assert.deepEqual(value.calls.filter(([name]) => name === 'load').map(([, id]) => id), ['other-chat']);
  assert.deepEqual(value.calls.filter(([name]) => name === 'reconcile').map(([, id]) => id), ['other-chat']);
  assert.ok(value.calls.some(([name, id]) => name === 'render' && id === 'other-chat'));
});

test('a busy main reply blocks floating handoff before consulting its owner', async () => {
  let opens = 0;
  const value = entryFixture({ selectionChats: [{ conversationId: 'floating-chat', openInMain: async () => { opens++; return true; } }] });
  value.state.generatingId = value.state.conversation.id;
  const original = value.state.conversation;
  await value.select('floating-chat');
  assert.equal(opens, 0);
  assert.equal(value.state.conversation, original);
  assert.equal(value.calls.some(([name]) => ['load', 'reconcile', 'agent-reconcile', 'render'].includes(name)), false);
  assert.ok(value.calls.some(([name, message]) => name === 'toast' && /停止当前任务/.test(message)));
});

for (const busy of [false, true]) {
  test(`deleting a saved conversation with an ${busy ? 'active' : 'idle'} floating owner requires closing that window first`, () => {
    const floating = { conversationId: 'floating-chat', runtime: { isBusy: () => busy } };
    const value = entryFixture({ selectionChats: [floating] });
    assert.match(value.context.historyDeletionBlocked(['floating-chat']), /先关闭.*追问窗口|追问窗口.*关闭/);
    assert.match(value.context.historyDeletionBlocked(['other-chat', 'floating-chat']), /追问窗口/);
    value.context.selectionChats.delete(floating);
    assert.equal(value.context.historyDeletionBlocked(['floating-chat']), '');
  });
}

test('an unrelated floating window does not prevent deletion, while existing queued-turn protection remains', () => {
  const value = entryFixture({ selectionChats: [{ conversationId: 'floating-chat' }] });
  assert.equal(value.context.historyDeletionBlocked(['other-chat']), '');
  value.state.messageQueue.push({ conversationId: 'other-chat', content: '等待发送的问题' });
  assert.match(value.context.historyDeletionBlocked(['other-chat']), /排队问题/);
});

test('history ownership blocks retry and destructive message controls while retaining Agent Stop', async () => {
  const value = entryFixture({ previous: { id: 'current', messages: [{ id: 'answer', role: 'assistant' }] } });
  value.context.historyMutationBusy = true;
  await value.regenerate('answer');
  await value.action('rewind');
  await value.action('restart-agent');
  await value.action('resume', { agent: true });
  await value.action('stop', { agent: true });
  assert.equal(value.calls.some(([name]) => name === 'regenerate'), false);
  assert.equal(value.calls.some(([name]) => name === 'resume'), false);
  assert.equal(value.calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal(value.state.conversation.messages.length, 1);
  value.context.historyMutationBusy = false;
  await value.regenerate('answer');
  assert.equal(value.calls.filter(([name]) => name === 'regenerate').length, 1);
});

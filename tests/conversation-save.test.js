import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createConversationSaver } from '../src/sidepanel/features/storage/conversation-save.js';
import { createAgentTurnCallbacks } from '../src/sidepanel/features/agent/agent-turn-callbacks.js';
import { createHistoryNavigation } from '../src/sidepanel/features/history/history-navigation.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ storage = 'local' } = {}) {
  const state = { conversation: { id: 'a', storage, title: 'A', messages: [] }, saveQueue: Promise.resolve() };
  const records = new Map();
  let temporary = storage === 'temporary' ? structuredClone(state.conversation) : null;
  if (storage === 'local') records.set('a', structuredClone(state.conversation));
  const writes = [];
  const errors = [];
  const timers = new Map();
  let timerId = 0;
  async function load(id) { return structuredClone(temporary?.id === id ? temporary : records.get(id) || null); }
  async function write(conversation) {
    const copy = structuredClone(conversation);
    writes.push(copy);
    if (copy.storage === 'temporary') temporary = copy;
    else records.set(copy.id, copy);
    return copy;
  }
  const saver = createConversationSaver({
    getConversation: () => state.conversation, loadConversation: load, writeConversation: write,
    getQueue: () => state.saveQueue, setQueue: pending => { state.saveQueue = pending; },
    onError: (id, error) => errors.push({ id, error }),
    setTimer: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimer: id => timers.delete(id),
  });
  const callbacks = createAgentTurnCallbacks({
    getConversation: () => state.conversation, ensureConversation: async () => state.conversation,
    save: (conversation, message) => { void saver.save(conversation, { agentMessage: message }); },
    render: () => {}, createId: () => 'assistant-a',
  });
  return { state, records, writes, errors, saver, callbacks, timers, write, load,
    temporary: () => temporary, setTemporary: value => { temporary = value; } };
}

test('a delayed save stays attached to its scheduled conversation after switching', async () => {
  const { state, saver, writes, timers } = fixture();
  state.conversation.title = 'Latest A';
  saver.schedule();
  state.conversation = { id: 'b', storage: 'local', messages: [], title: 'B' };
  [...timers.values()][0]();
  await state.saveQueue;
  assert.equal(writes.at(-1).id, 'a');
  assert.equal(writes.at(-1).title, 'Latest A');
  assert.equal(state.conversation.id, 'b');
});

test('same-id reload finalization cancels a stale delayed snapshot of that conversation', async () => {
  const { state, saver, callbacks, records, timers } = fixture();
  await callbacks.begin({ taskId: 'task-a', goal: 'Read A' });
  await state.saveQueue;
  saver.schedule();
  const staleTimer = [...timers.values()][0];
  state.conversation = structuredClone(state.conversation);
  state.conversation.title = 'Reloaded title';
  await callbacks.end({ taskId: 'task-a', status: 'finished', result: 'Final answer' });
  await state.saveQueue;
  staleTimer();
  await state.saveQueue;
  assert.equal(timers.size, 0);
  assert.equal(records.get('a').messages[0].content, 'Final answer');
  assert.equal(records.get('a').messages[0].status, 'complete');
  assert.equal(records.get('a').title, 'Reloaded title');
});

test('rescheduling a reloaded same-id conversation uses the fresh object', async () => {
  const { state, saver, writes, timers } = fixture();
  saver.schedule();
  state.conversation = { ...state.conversation, title: 'Reloaded title' };
  saver.schedule();
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  await state.saveQueue;
  assert.equal(writes.at(-1).title, 'Reloaded title');
});

test('a late Agent save merges only its message into the original stored conversation', async () => {
  const { state, saver, callbacks, records } = fixture();
  await callbacks.begin({ taskId: 'task-a', goal: 'Read A' });
  await state.saveQueue;
  const original = state.conversation;
  records.get('a').title = 'Renamed in history';
  records.get('a').messages.push({ id: 'preserve', role: 'user', content: 'Later message' });
  state.conversation = { id: 'b', storage: 'local', title: 'B', messages: [] };
  await callbacks.end({ taskId: 'task-a', status: 'finished', result: 'Final A' });
  await saver.save(state.conversation);
  assert.equal(records.get('a').messages[0].content, 'Final A');
  assert.equal(records.get('a').title, 'Renamed in history');
  assert.equal(records.get('a').messages.at(-1).content, 'Later message');
  assert.equal(records.get('b').messages.length, 0);
  assert.equal(original.messages[0].content, 'Final A');
});

test('newConversation serializes promotion and temporary creation ahead of a late Agent result', async () => {
  const f = fixture({ storage: 'temporary' });
  const { state, saver, callbacks, records, errors } = f;
  await callbacks.begin({ taskId: 'task-a', goal: 'Read A' });
  await state.saveQueue;
  saver.schedule(state.conversation);
  const entered = deferred();
  const release = deferred();
  const source = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('async function newConversation('), source.indexOf('async function ensureConversation('));
  let imagePreparationsCancelled = 0;
  const context = vm.createContext({
    state, conversationSaver: saver, agentSlot: { isBusy: () => false },
    historyNavigation: createHistoryNavigation({ getCurrent: () => state.conversation }),
    agentTurnCallbacks: callbacks, application: { repository: { reconcile() {} } },
    visualPreparation: { cancel: () => { imagePreparationsCancelled++; } },
    getDirectoryInfo: async () => ({ granted: true }),
    promoteTemporaryConversation: async conversation => {
      await f.write({ ...conversation, storage: 'local' });
      f.setTemporary(null);
      entered.resolve();
      await release.promise;
      return { syncStatus: 'synced' };
    },
    createTemporaryConversation: async () => {
      const next = { id: 'b', storage: 'temporary', messages: [], title: 'B' };
      f.setTemporary(structuredClone(next));
      return next;
    },
    toast: () => {}, setHistoryOpen: () => {}, renderConversation: () => {}, renderStorageBadge: () => {},
    refreshHistory: async () => {}, input: { focus: () => {} },
  });
  vm.runInContext(functionSource, context);
  const switching = context.newConversation();
  await entered.promise;
  await callbacks.end({ taskId: 'task-a', status: 'finished', result: 'Final during promotion' });
  release.resolve();
  await switching;
  await state.saveQueue;
  assert.equal(records.get('a').storage, 'local');
  assert.equal(records.get('a').messages[0].content, 'Final during promotion');
  assert.equal(f.temporary().id, 'b');
  assert.equal(f.temporary().messages.length, 0);
  assert.equal(state.conversation.id, 'b');
  assert.equal(imagePreparationsCancelled, 1);
  assert.equal(errors.length, 0);
});

test('a conversation loaded before the final write can reconcile without another task callback', async () => {
  const { state, callbacks } = fixture();
  await callbacks.begin({ taskId: 'task-a', goal: 'Read A' });
  await state.saveQueue;
  const loadedEarlier = structuredClone(state.conversation);
  state.conversation = { id: 'b', messages: [] };
  await callbacks.end({ taskId: 'task-a', status: 'finished', result: 'Known final answer' });
  state.conversation = loadedEarlier;
  callbacks.reconcile(loadedEarlier);
  assert.equal(loadedEarlier.messages[0].content, 'Known final answer');
  assert.equal(loadedEarlier.messages[0].status, 'complete');
  await state.saveQueue;
});

test('a removed owner cannot be recreated by a queued task save', async () => {
  const { state, callbacks, records, errors, writes } = fixture();
  await callbacks.begin({ taskId: 'task-a', goal: 'Read A' });
  await state.saveQueue;
  state.conversation = { id: 'b', storage: 'local', messages: [] };
  records.delete('a');
  const count = writes.length;
  await callbacks.end({ taskId: 'task-a', status: 'finished', result: 'Late result' });
  await state.saveQueue.catch(() => {});
  assert.equal(writes.length, count);
  assert.equal(records.has('a'), false);
  assert.equal(errors[0].id, 'a');
});

test('settling an older save does not replace the queue for a newer pending save', async () => {
  const { state, saver } = fixture();
  const firstGate = deferred();
  const secondGate = deferred();
  const first = saver.enqueue(() => firstGate.promise);
  const second = saver.enqueue(() => secondGate.promise);
  assert.equal(state.saveQueue, second);
  firstGate.resolve();
  await first;
  assert.equal(state.saveQueue, second);
  secondGate.resolve();
  await second;
});

test('an unavailable original conversation times out without blocking later saves or accepting its late read', async () => {
  const read = deferred();
  const message = { id: 'agent-a', role: 'assistant', content: 'Final A', status: 'complete',
    agent: { taskId: 'task-a', status: 'finished' } };
  const original = { id: 'a', storage: 'local', messages: [message] };
  const current = { id: 'b', storage: 'temporary', messages: [] };
  const writes = [];
  const errors = [];
  const saver = createConversationSaver({
    getConversation: () => current,
    loadConversation: () => read.promise,
    writeConversation: async value => { writes.push(value); return value; },
    onError: (id, error) => errors.push({ id, error }), readTimeoutMs: 10,
  });
  const pending = saver.save(original, { agentMessage: message });
  const next = saver.save(current);
  await Promise.all([pending, next]);
  assert.equal(errors[0].error.name, 'TimeoutError');
  assert.deepEqual(writes.map(value => value.id), ['b']);
  read.resolve(original);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(writes.map(value => value.id), ['b']);
});

test('saving a visible owned task does not read its conversation back from disk', async () => {
  const message = { id: 'agent-a', role: 'assistant', content: 'Final A', status: 'complete',
    agent: { taskId: 'task-a', status: 'finished' } };
  const current = { id: 'a', storage: 'temporary', messages: [message] };
  let reads = 0;
  const saver = createConversationSaver({
    getConversation: () => current,
    loadConversation: () => { reads += 1; return new Promise(() => {}); },
    writeConversation: async value => value,
  });
  const saved = await saver.save(current, { agentMessage: message });
  assert.equal(saved.id, 'a');
  assert.equal(reads, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationRepository } from '../src/app/conversation-repository.js';
import { createConversationSaver } from '../src/sidepanel/features/storage/conversation-save.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const state = { conversation: { id: 'a', storage: 'local', title: 'A', messages: [] }, queue: Promise.resolve() };
  const records = new Map([['a', structuredClone(state.conversation)]]);
  const writes = [];
  const changes = [];
  const timers = new Map();
  let timerId = 0;
  let messageId = 0;
  const saver = createConversationSaver({
    getConversation: () => state.conversation,
    loadConversation: async id => structuredClone(records.get(id) || null),
    writeConversation: async value => {
      const saved = structuredClone(value);
      writes.push(saved);
      records.set(saved.id, saved);
      return saved;
    },
    getQueue: () => state.queue, setQueue: value => { state.queue = value; },
    setTimer: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimer: id => timers.delete(id),
  });
  const repository = createConversationRepository({ getConversation: () => state.conversation, saver,
    createId: () => `message-${++messageId}`, now: () => '2026-11-02T00:00:00Z',
    onChange: change => changes.push(change) });
  return { state, records, writes, changes, timers, saver, repository };
}

function begin(repository, runId = 'run-1', fields = {}) {
  return repository.begin({ runId, user: { content: 'Question', ...fields } });
}

test('begin claims an optimistic pair without storing it and repeating the same run is idempotent', () => {
  const { state, repository, writes, changes } = fixture();
  state.conversation.messages.push(
    { id: 'user', role: 'user', content: 'Question', optimistic: true, pageSource: { url: 'https://a.test' } },
    { id: 'answer', role: 'assistant', content: '', status: 'streaming', optimistic: true },
  );
  const ref = repository.begin({ assistantId: 'answer', runId: 'run' });
  assert.deepEqual(ref, { conversationId: 'a', turnId: 'user', runId: 'run', assistantId: 'answer', userId: 'user' });
  assert.equal(Object.isFrozen(ref), true);
  assert.equal(repository.begin({ assistantId: 'answer', runId: 'run' }), ref);
  assert.equal(state.conversation.messages.length, 2);
  assert.equal(state.conversation.messages[1].optimistic, true);
  assert.equal(writes.length, 0);
  assert.equal(changes.length, 1);
});

test('begin creates one pair and rejects missing run IDs or reuse in another conversation', () => {
  const { state, repository } = fixture();
  assert.throws(() => repository.begin({ user: { content: 'Question' } }), /runId/);
  assert.equal(state.conversation.messages.length, 0);
  const ref = begin(repository);
  assert.equal(begin(repository), ref);
  state.conversation = { id: 'b', messages: [] };
  assert.throws(() => begin(repository), /替换/);
  assert.equal(state.conversation.messages.length, 0);
});

test('updates and deltas preserve provenance while refusing identity and status patches', () => {
  const { repository } = fixture();
  const source = { url: 'https://source.test', title: 'Source' };
  const ref = begin(repository, 'run', { pageSource: source });
  assert.equal(repository.update(ref, { content: 'Hello', pageSource: source, sources: [source], reasoning: 'Think',
    id: 'malicious', role: 'user', turnId: 'other', runId: 'other', terminalRunId: 'run', status: 'complete' }), true);
  source.title = 'Changed elsewhere';
  assert.equal(repository.append(ref, { content: ' world', reasoning: ' more' }), true);
  const { user, assistant } = repository.get(ref);
  assert.equal(assistant.id, ref.assistantId);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.turnId, ref.turnId);
  assert.equal(assistant.runId, 'run');
  assert.equal(assistant.status, 'streaming');
  assert.equal(assistant.terminalRunId, undefined);
  assert.equal(assistant.content, 'Hello world');
  assert.equal(assistant.reasoning, 'Think more');
  assert.equal(assistant.sources[0].title, 'Source');
  assert.equal(user.pageSource.title, 'Source');
});

test('a run commits one terminal result and late updates, cancellation and duplicate completion are ignored', () => {
  const { repository } = fixture();
  const ref = begin(repository);
  repository.update(ref, { reasoningStartedAt: 10, reasoningFinishedAt: 20 });
  assert.equal(repository.finish(ref, { status: 'complete', content: 'Final', sources: [{ url: 'https://a.test' }] }), true);
  assert.equal(repository.finish(ref, { status: 'stopped', content: 'Late stop' }), false);
  assert.equal(repository.finish(ref, { status: 'error', errorMessage: 'Late error' }), false);
  assert.equal(repository.append(ref, { content: 'late' }), false);
  const { assistant } = repository.get(ref);
  assert.equal(assistant.content, 'Final');
  assert.equal(assistant.status, 'complete');
  assert.equal(assistant.terminalRunId, ref.runId);
  assert.equal(Object.hasOwn(assistant, 'reasoningStartedAt'), false);
  assert.throws(() => repository.finish(ref, { status: 'paused' }), /terminal/);
});

test('cancelling during preparation finalizes both optimistic messages for persistence', async () => {
  const { repository, records } = fixture();
  const ref = repository.begin({ runId: 'preparing', user: { content: 'Question', optimistic: true },
    assistant: { optimistic: true } });
  assert.equal(repository.finish(ref, { status: 'stopped' }), true);
  await repository.save(ref, { required: true });
  assert.equal(records.get('a').messages.length, 2);
  assert.equal(records.get('a').messages[1].status, 'stopped');
  assert.equal(Object.hasOwn(records.get('a').messages[0], 'optimistic'), false);
  assert.equal(Object.hasOwn(records.get('a').messages[1], 'optimistic'), false);
});

test('an unpersisted cancelled pair can be committed to its unchanged original timeline after switching', async () => {
  const { state, repository, records } = fixture();
  const ref = repository.begin({ runId: 'preparing', user: { content: 'Question', optimistic: true },
    assistant: { optimistic: true } });
  repository.finish(ref, { status: 'stopped' });
  state.conversation = { id: 'b', storage: 'temporary', messages: [] };
  await repository.save(ref, { required: true });
  assert.equal(records.get('a').messages.length, 2);
  assert.equal(records.get('a').messages[1].status, 'stopped');
  assert.equal(records.get('a').messages[0].content, 'Question');
  assert.equal(records.has('b'), false);
});

test('an offscreen retry persists only its guarded replacement structure and refreshed question source', async () => {
  const { state, repository, records } = fixture();
  const first = begin(repository, 'first');
  repository.finish(first, { status: 'complete', content: 'Old answer' });
  await repository.save(first, { required: true });
  const retry = repository.retry({ assistantId: first.assistantId, runId: 'retry' });
  repository.get(retry).user.pageSource = { url: 'https://refreshed.test' };
  repository.finish(retry, { status: 'error', errorMessage: 'Preparation failed' });
  state.conversation = { id: 'b', messages: [] };
  await repository.save(retry, { required: true });
  assert.equal(records.get('a').messages.length, 2);
  assert.equal(records.get('a').messages[1].id, retry.assistantId);
  assert.equal(records.get('a').messages[1].status, 'error');
  assert.equal(records.get('a').messages[0].pageSource.url, 'https://refreshed.test');
});

test('initial structural commits reject a concurrently changed original timeline', async () => {
  const { state, repository, records } = fixture();
  const ref = begin(repository);
  repository.finish(ref, { status: 'stopped' });
  records.get('a').messages.push({ id: 'external', role: 'user', content: 'Newer saved question' });
  state.conversation = { id: 'b', messages: [] };
  await assert.rejects(repository.save(ref, { required: true }), /记录已变化/);
  assert.deepEqual(records.get('a').messages.map(item => item.id), ['external']);
});

test('only current completed runs accept suggestions and decorations cannot change answer identity or content', () => {
  const { repository } = fixture();
  const ref = begin(repository);
  assert.equal(repository.decorate(ref, { suggestions: ['Next'] }), false);
  repository.finish(ref, { status: 'complete', content: 'Final' });
  assert.equal(repository.decorate(ref, { suggestions: ['Next'], content: 'Replacement', status: 'error', runId: 'other' }), true);
  assert.equal(repository.decorate(ref, { suggestions: ['Next'] }), false);
  const { assistant } = repository.get(ref);
  assert.equal(assistant.content, 'Final');
  assert.equal(assistant.status, 'complete');
  assert.equal(assistant.runId, ref.runId);
  const next = repository.retry({ assistantId: ref.assistantId, runId: 'next' });
  assert.equal(repository.decorate(ref, { suggestions: ['Late'] }), false);
  repository.finish(next, { status: 'error', errorMessage: 'Failed' });
  assert.equal(repository.decorate(next, { suggestions: ['Unavailable'] }), false);
});

test('starting a replacement run makes cancellation and re-begin of the old run ineffective', () => {
  const { repository } = fixture();
  const old = begin(repository, 'old');
  repository.update(old, { content: 'Old partial', errorMessage: 'Old error' });
  const next = repository.begin({ assistantId: old.assistantId, runId: 'next' });
  repository.append(next, { content: 'New partial' });
  assert.equal(repository.get(old), null);
  assert.equal(repository.finish(old, { status: 'stopped' }), false);
  assert.throws(() => repository.begin({ assistantId: old.assistantId, runId: 'old' }), /替换/);
  assert.equal(repository.get(next).assistant.content, 'New partial');
  assert.equal(repository.get(next).assistant.errorMessage, undefined);
});

test('retry uses the existing duplicate-folding and page-scope rules and invalidates removed run references', () => {
  const { state, repository } = fixture();
  const source = { url: 'https://original.test', capturedAt: 'then' };
  const question = id => ({ id, role: 'user', content: 'Question', pageSource: source, pageContextEnabled: true,
    readingPolicy: { version: 1, scope: 'page', intent: 'read' }, attachments: [{ id: 'file' }] });
  state.conversation.messages = [question('first'), { id: 'failed-1', role: 'assistant', status: 'stopped' },
    question('duplicate'), { id: 'failed-2', role: 'assistant', status: 'error' },
    { id: 'later', role: 'user', content: 'Later question' }, { id: 'later-answer', role: 'assistant', status: 'complete' }];
  const old = repository.begin({ assistantId: 'failed-2', runId: 'old' });
  repository.finish(old, { status: 'error', errorMessage: 'Failed' });
  const ref = repository.retry({ assistantId: 'failed-2', runId: 'retry' });
  assert.equal(state.conversation.messages.length, 2);
  assert.equal(ref.userId, 'first');
  assert.equal(ref.turnId, 'first');
  assert.equal(repository.get(ref).user.pageSource.url, source.url);
  assert.equal(repository.get(ref).user.readingPolicy.scope, 'page');
  assert.equal(repository.get(ref).user.attachments[0].id, 'file');
  state.conversation = { id: 'b', messages: [] };
  assert.equal(repository.get(old), null);
  assert.equal(repository.update(old, { content: 'Late' }), false);
});

test('ordinary retry refuses an Agent turn without modifying the conversation', () => {
  const { state, repository } = fixture();
  state.conversation.messages = [{ id: 'user', role: 'user', agentTask: true },
    { id: 'answer', role: 'assistant', agent: { taskId: 'task' } }];
  const before = structuredClone(state.conversation);
  assert.throws(() => repository.retry({ assistantId: 'answer', runId: 'run' }), /普通对话重试/);
  assert.deepEqual(state.conversation, before);
});

test('same-id reload updates the new object, preserves unrelated changes and never recreates a removed message', () => {
  const { state, repository } = fixture();
  const ref = begin(repository);
  const original = state.conversation;
  state.conversation = structuredClone(original);
  state.conversation.title = 'Reloaded title';
  state.conversation.messages.push({ id: 'other', role: 'user', content: 'Keep' });
  state.conversation.messages[1].status = 'stopped'; // Existing storage normalization.
  assert.equal(repository.update(ref, { content: 'Fresh' }), true);
  assert.equal(state.conversation.messages[1].status, 'streaming');
  assert.equal(original.messages[1].content, '');
  assert.equal(state.conversation.title, 'Reloaded title');
  assert.equal(state.conversation.messages.at(-1).content, 'Keep');
  state.conversation.messages = state.conversation.messages.filter(item => item.id !== ref.assistantId);
  assert.equal(repository.finish(ref, { status: 'complete', content: 'Must not recreate' }), false);
  state.conversation = { id: 'b', messages: [] };
  assert.equal(repository.update(ref, { content: 'Cannot resurrect the detached old object' }), false);
});

test('reconcile restores a known final result into a stale same-id load without another callback', () => {
  const { state, repository } = fixture();
  const ref = begin(repository);
  const stale = structuredClone(state.conversation);
  state.conversation = { id: 'b', messages: [] };
  repository.finish(ref, { status: 'complete', content: 'Final in A' });
  stale.messages.push({ id: 'keep', role: 'user', content: 'Keep' });
  repository.reconcile(stale);
  assert.equal(stale.messages[1].content, 'Final in A');
  assert.equal(stale.messages[1].terminalRunId, ref.runId);
  assert.equal(stale.messages.at(-1).id, 'keep');
});

test('saving after switching merges only the owned answer and retains the original storage binding', async () => {
  const { state, repository, records } = fixture();
  const ref = begin(repository);
  await repository.save(ref, { required: true });
  records.get('a').title = 'Renamed A';
  records.get('a').syncDirectoryName = 'Original folder';
  records.get('a').messages.push({ id: 'later', role: 'user', content: 'Keep later' });
  const original = state.conversation;
  original.storage = 'temporary'; // The retained owner can predate promotion.
  state.conversation = { id: 'b', storage: 'temporary', messages: [] };
  repository.finish(ref, { status: 'complete', content: 'Answer A', sources: [{ url: 'https://a.test' }] });
  await repository.save(ref, { required: true });
  assert.equal(records.get('a').storage, 'local');
  assert.equal(records.get('a').syncDirectoryName, 'Original folder');
  assert.equal(records.get('a').title, 'Renamed A');
  assert.equal(records.get('a').messages[1].content, 'Answer A');
  assert.equal(records.get('a').messages.at(-1).content, 'Keep later');
  assert.equal(records.has('b'), false);
});

test('an old queued save is discarded after retry and cannot overwrite the new run', async () => {
  const { repository, saver, records, writes } = fixture();
  const old = begin(repository, 'old');
  await repository.save(old, { required: true });
  const gate = deferred();
  saver.enqueue(() => gate.promise);
  repository.update(old, { content: 'Old partial' });
  const oldSave = repository.save(old);
  const ref = repository.retry({ assistantId: old.assistantId, runId: 'new' });
  repository.finish(ref, { status: 'complete', content: 'New final' });
  const newSave = repository.save(ref, { required: true });
  gate.resolve();
  assert.equal(await oldSave, null);
  await newSave;
  assert.equal(writes.length, 2);
  assert.equal(records.get('a').messages[1].content, 'New final');
  assert.equal(records.get('a').messages[1].runId, 'new');
});

test('a same-id final save cancels the previous object timer and preserves cleared fields', async () => {
  const { state, repository, timers, records } = fixture();
  const ref = begin(repository);
  repository.update(ref, { reasoningStartedAt: 20, errorMessage: 'Old error' });
  repository.schedule(ref);
  const oldTimer = [...timers.values()][0];
  state.conversation = structuredClone(state.conversation);
  repository.finish(ref, { status: 'complete', content: 'Final', errorMessage: undefined });
  await repository.save(ref, { required: true });
  oldTimer();
  await state.queue;
  assert.equal(timers.size, 0);
  assert.equal(records.get('a').messages[1].content, 'Final');
  assert.equal(Object.hasOwn(records.get('a').messages[1], 'errorMessage'), false);
  assert.equal(Object.hasOwn(records.get('a').messages[1], 'reasoningStartedAt'), false);
});

test('a delayed lower revision does not overwrite a newer stored terminal answer', async () => {
  const { state, repository, saver, records } = fixture();
  const ref = begin(repository);
  await repository.save(ref, { required: true });
  const gate = deferred();
  saver.enqueue(() => gate.promise);
  repository.update(ref, { content: 'Old partial' });
  const pending = repository.save(ref);
  const stored = records.get('a').messages[1];
  Object.assign(stored, { content: 'Already committed', runRevision: 100, terminalRunId: ref.runId, status: 'complete' });
  state.conversation = { id: 'b', messages: [] };
  gate.resolve();
  await pending;
  assert.equal(records.get('a').messages[1].content, 'Already committed');
  assert.equal(records.get('a').messages[1].status, 'complete');
});

test('a save failure does not reopen a committed message or allow a second terminal result', async () => {
  const state = { conversation: { id: 'a', messages: [] } };
  const saver = createConversationSaver({ getConversation: () => state.conversation,
    loadConversation: async () => null, writeConversation: async () => { throw new Error('Disk unavailable'); } });
  const repository = createConversationRepository({ getConversation: () => state.conversation, saver });
  const ref = begin(repository);
  repository.finish(ref, { status: 'complete', content: 'Visible final' });
  await assert.rejects(repository.save(ref, { required: true }), /Disk unavailable/);
  assert.equal(repository.get(ref).assistant.status, 'complete');
  assert.equal(repository.finish(ref, { status: 'error', content: 'Replacement' }), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';
import { memoryIndexedDB } from './helpers/memory-indexeddb.js';
import { appendArticleQuote, updateArticleQuote } from '../src/sidepanel/features/messages/article-quote-draft.js';
import { createMessageRewind } from '../src/sidepanel/features/messages/message-rewind.js';
import { normalizeDraftSource } from '../src/sidepanel/features/welcome/draft-source.js';
import { normalizePageSelection, shouldReleaseSelection } from '../src/utils/selection.js';
import { requestMessagesFor } from '../src/utils/context.js';
import { commitLocalConversation, loadConversation, flushConversationWrites } from '../src/utils/conversation-store.js';
import { getPendingConversationWrite } from '../src/utils/conversation-outbox.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await tick();
  }
}
const now = () => '2026-11-11T07:00:00.000Z';
const quote = (text = 'metadata 用于过滤') => ({ source: 'conversation', sourceVersion: 1, conversationId: 'quote-lifecycle',
  messageId: 'source-answer', role: 'assistant', text, context: 'metadata 是每个 chunk 的键值对，字段用于过滤与保留来源。',
  question: 'metadata 是什么？', title: 'RAG 语义上下文', heading: 'metadata', selectedAt: 'original-capture',
  anchor: { start: 35, end: 35 + text.length } });
const add = (previous, id, comment, text) => appendArticleQuote(previous, quote(text), comment, { makeId: () => id, now });
const sourceMessages = () => [
  { id: 'source-question', role: 'user', content: 'metadata 是什么？', displayContent: 'metadata 是什么？', pageContextEnabled: false },
  { id: 'source-answer', role: 'assistant', content: 'metadata 是每个 chunk 的键值对，字段用于过滤与保留来源。', status: 'complete' },
];
const sendOptions = () => ({ pageContextEnabled: false, directModelRequest: true, pageTargetPromise: Promise.resolve(null) });

function runtime(t, ports = {}) {
  const starts = [], gates = [], saves = [];
  const state = { conversation: { id: 'quote-lifecycle', version: 2, storage: 'local', title: 'RAG 语义上下文',
    createdAt: now(), updatedAt: now(), messages: sourceMessages() }, pageSelection: null };
  const fixture = createConversationServiceFixture({ state, now,
    saveCurrent: async options => { saves.push(structuredClone(options.conversation)); },
    generateReply: async (assistant, run) => {
      const gate = deferred(); gates.push(gate);
      const user = fixture.repository.get(run.ref).user;
      starts.push({ assistantId: assistant.id, userId: user.id, selection: structuredClone(user.selection),
        request: requestMessagesFor(state.conversation, assistant.id, null) });
      return gate.promise;
    }, ...ports });
  t.after(() => { for (const gate of gates) gate.resolve('Cleanup answer'); fixture.dispose(); });
  return { fixture, state, starts, gates, saves };
}

test('immutable annotation edits cannot change an in-flight turn, queued snapshot or their completion ownership', async t => {
  const value = runtime(t), { fixture, state, starts, gates } = value;
  const ended = [];
  fixture.subscribe(event => {
    if (event.type !== 'reply-ended') return;
    ended.push(structuredClone(event.selectionUsed));
    if (shouldReleaseSelection(state.pageSelection, event.selectionUsed)) state.pageSelection = null;
  });
  const original = add(null, 'quote-1', 'SENT_COMMENT');
  state.pageSelection = original;
  const sending = fixture.sendMessage('解释第一处引用', sendOptions());
  await until(() => starts.length === 1, 'first annotated turn never reached its controlled model gate');
  const sentUser = state.conversation.messages.find(item => item.id === starts[0].userId);
  assert.deepEqual(sentUser.selection, original);
  assert.deepEqual(starts[0].selection, original);

  state.pageSelection = updateArticleQuote(state.pageSelection, 'quote-1', 'QUEUE_COMMENT', { now });
  state.pageSelection = add(state.pageSelection, 'quote-2', 'SECOND_QUEUED_COMMENT', '来源可以回溯');
  const queuedDraft = structuredClone(state.pageSelection);
  await fixture.sendMessage('回答两条排队引用', sendOptions());
  assert.equal(state.messageQueue.length, 1);
  assert.deepEqual(state.messageQueue[0].selection, queuedDraft);
  assert.equal(state.pageSelection, null);

  state.pageSelection = updateArticleQuote(state.messageQueue[0].selection, 'quote-2', 'NEW_DRAFT_COMMENT', { now });
  state.pageSelection = add(state.pageSelection, 'quote-3', 'THIRD_DRAFT_COMMENT', '来源必须真实读取');
  const newerDraft = structuredClone(state.pageSelection);
  assert.deepEqual(state.messageQueue[0].selection, queuedDraft, 'queued shallow envelope keeps its immutable annotation array');
  assert.deepEqual(sentUser.selection, original, 'submitted annotations must not follow newer draft edits');
  assert.doesNotMatch(JSON.stringify(starts[0].request), /QUEUE_COMMENT|NEW_DRAFT_COMMENT|THIRD_DRAFT_COMMENT/);

  gates[0].resolve('First controlled answer');
  await sending;
  await until(() => starts.length === 2, 'the saved queue item did not enter its own model gate');
  assert.deepEqual(ended[0], original);
  assert.deepEqual(state.pageSelection, newerDraft, 'an older completion must not clear a newer annotation draft');
  assert.deepEqual(starts[1].selection, queuedDraft);
  assert.match(JSON.stringify(starts[1].request.at(-1)), /QUEUE_COMMENT|SECOND_QUEUED_COMMENT/);
  assert.doesNotMatch(JSON.stringify(starts[1].request.at(-1)), /NEW_DRAFT_COMMENT|THIRD_DRAFT_COMMENT/);
  gates[1].resolve('Second controlled answer');
  await until(() => !state.generatingId && !state.isSubmitting, 'queued annotated turn failed to settle');
  assert.deepEqual(ended[1], queuedDraft);
  assert.deepEqual(state.pageSelection, newerDraft);
  assert.equal(state.conversation.messages.filter(item => item.role === 'user').length, 3);
  assert.equal(state.conversation.messages.filter(item => item.role === 'assistant' && item.status === 'complete').length, 3);
});

test('the real queue recall UI adapter restores the full annotation bundle for independent editing', async t => {
  const { fixture, state, starts, gates } = runtime(t);
  const first = fixture.sendMessage('Keep a reply busy', sendOptions());
  await until(() => starts.length === 1, 'controlled busy reply did not start');
  state.pageSelection = add(add(null, 'quote-1', '第一条注释'), 'quote-2', '第二条注释', '保留原始来源');
  const selected = structuredClone(state.pageSelection);
  await fixture.sendMessage('撤回后编辑这些注释', sendOptions());
  const queued = state.messageQueue[0];
  assert.deepEqual(queued.selection, selected);
  // This is the existing entry-owned UI adapter only. Submission, queueing and
  // generation above execute the directly imported command service and runner.
  const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
  const begin = entry.indexOf('function recallQueueItem() {');
  const end = entry.indexOf('async function processQueue()', begin);
  assert.ok(begin >= 0 && end > begin);
  let focusCount = 0;
  fixture.input.focus = () => { focusCount++; };
  const context = vm.createContext({ state, input: fixture.input, normalizeDraftSource,
    pastedText: { getValue: () => fixture.input.value, setValue: value => { fixture.input.value = value; } },
    renderAttachments() {}, resizeInput() {}, updateComposer() {}, renderQueueBar() {}, toast() {},
    setPageSelection: value => { state.pageSelection = normalizePageSelection(value); } });
  vm.runInContext(entry.slice(begin, end), context);
  context.recallQueueItem();
  assert.equal(state.messageQueue.length, 0);
  assert.equal(state.draft, '撤回后编辑这些注释');
  assert.deepEqual(state.pageSelection, selected);
  assert.equal(focusCount, 1);
  state.pageSelection = updateArticleQuote(state.pageSelection, 'quote-2', '撤回后的新注释', { now });
  assert.equal(queued.selection.annotations[1].comment, '第二条注释');
  gates[0].resolve('Finished original reply');
  await first;
  assert.equal(starts.length, 1, 'recalling the queued bundle prevents its automatic submission');
});

test('retry retains the submitted annotations and rewind restores a detached editable copy', async t => {
  const { fixture, state, starts, gates } = runtime(t);
  const submitted = add(add(null, 'quote-1', '解释过滤边界'), 'quote-2', '保留引用依据', 'source 指向原文');
  state.pageSelection = submitted;
  const first = fixture.sendMessage('按这两条引用解释', sendOptions());
  await until(() => starts.length === 1, 'annotated question did not start');
  const userId = starts[0].userId, oldAssistantId = starts[0].assistantId;
  gates[0].resolve('Initial controlled answer'); await first;
  state.pageSelection = updateArticleQuote(submitted, 'quote-2', '无关的新草稿注释', { now });
  const newerDraft = structuredClone(state.pageSelection);
  const retrying = fixture.regenerate(oldAssistantId);
  await until(() => starts.length === 2, 'annotated retry did not start');
  assert.equal(starts[1].userId, userId);
  assert.notEqual(starts[1].assistantId, oldAssistantId);
  assert.deepEqual(starts[1].selection, submitted);
  assert.doesNotMatch(JSON.stringify(starts[1].request.at(-1)), /无关的新草稿注释/);
  assert.deepEqual(state.pageSelection, newerDraft);
  gates[1].resolve('Retry controlled answer'); await retrying;
  assert.equal(state.conversation.messages.filter(item => item.id === userId).length, 1);
  assert.equal(state.conversation.messages.some(item => item.id === oldAssistantId), false);
  const submittedUser = state.conversation.messages.find(item => item.id === userId);
  let restored;
  const rewind = createMessageRewind({ getConversation: () => state.conversation,
    applyDraft: draft => { restored = draft; state.draft = draft.text; state.pageSelection = draft.selection; },
    saveConversation: async () => {} });
  assert.deepEqual(await rewind.rewind(userId), { ok: true, current: true });
  assert.equal(restored.text, '按这两条引用解释');
  assert.deepEqual(restored.selection, submitted);
  assert.notEqual(restored.selection.annotations, submittedUser.selection.annotations);
  state.pageSelection = updateArticleQuote(state.pageSelection, 'quote-1', '回退后修改的注释', { now });
  assert.equal(submittedUser.selection.annotations[0].comment, '解释过滤边界');
  assert.deepEqual(state.conversation.messages.map(item => item.id), ['source-question', 'source-answer']);
});

test('conversation store commits and reloads complete versioned annotation data through the real outbox', async t => {
  const setGlobal = (key, value) => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { if (prior) Object.defineProperty(globalThis, key, prior); else delete globalThis[key]; });
  };
  setGlobal('indexedDB', memoryIndexedDB());
  setGlobal('__unkAiDirectoryHandle', null);
  const browser = new Map();
  setGlobal('chrome', { storage: { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(browser.get(key))])); },
    async set(items) { for (const [key, value] of Object.entries(items)) browser.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) browser.delete(key); },
  } } });
  const { fixture, state, starts, gates } = runtime(t, { saveCurrent: async ({ conversation }) => commitLocalConversation(conversation) });
  const submitted = add(add(null, 'quote-1', '解释 metadata'), 'quote-2', '这里需要什么依据？', '来源要真实读取');
  state.pageSelection = submitted;
  const sending = fixture.sendMessage('保存多处原文和注释', sendOptions());
  await until(() => starts.length === 1, 'required outbox save failed before annotated generation');
  const pending = await getPendingConversationWrite(state.conversation.id);
  const committedUser = pending.conversation.messages.find(item => item.id === starts[0].userId);
  assert.deepEqual(committedUser.selection, submitted);
  assert.equal(committedUser.selection.sourceVersion, 2);
  assert.equal(committedUser.selection.annotations.length, 2);
  gates[0].resolve('Saved controlled answer'); await sending;
  await commitLocalConversation(state.conversation);
  await flushConversationWrites();
  const loaded = await loadConversation(state.conversation.id);
  const restoredUser = loaded.messages.find(item => item.id === starts[0].userId);
  assert.deepEqual(restoredUser.selection, submitted);
  assert.deepEqual(restoredUser.selection.annotations[1].anchor, submitted.annotations[1].anchor);
  assert.match(JSON.stringify(requestMessagesFor(loaded, undefined, null).findLast(item => item.role === 'user').content), /解释 metadata|这里需要什么依据/);
  loaded.messages.find(item => item.id === starts[0].userId).selection.annotations[0].comment = '只修改重载副本';
  assert.equal((await loadConversation(state.conversation.id)).messages.find(item => item.id === starts[0].userId)
    .selection.annotations[0].comment, '解释 metadata');
});

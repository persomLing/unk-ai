import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { awaitWithAbort, awaitWithTimeout } from '../src/utils/abortable.js';
import { pageSourceFor } from '../src/utils/turn-source.js';
import { requestMessagesFor } from '../src/utils/context.js';
import { isReadablePageUrl } from '../src/sidepanel/features/page-reading/page-control-state.js';
import { createPageReadState } from '../src/sidepanel/features/page-reading/page-read-state.js';
import { normalizeDraftSource } from '../src/sidepanel/features/welcome/draft-source.js';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';

const source = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
function section(begin, end) {
  const start = source.indexOf(begin);
  assert.ok(start >= 0, `missing ${begin}`);
  return source.slice(start, source.indexOf(end, start));
}
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const withDeadline = (timeoutMs) => (pending, options) => awaitWithTimeout(pending, { ...options, ...(timeoutMs == null ? {} : { timeoutMs }) });

function fixture({ configure = async () => true, validate = async () => undefined, refresh = async () => {}, timeoutMs } = {}) {
  const state = {
    conversation: { id: 'original', messages: [{ id: 'question', role: 'user', content: 'Question' }, { id: 'answer', role: 'assistant', content: 'Answer', status: 'complete' }] },
    messageQueue: [], selectedEffort: 'default',
  };
  const saves = [];
  const generations = [];
  const errors = [];
  const refreshCalls = [];
  const events = [];
  let ids = 0;
  const noop = () => {};
  const context = createConversationServiceFixture({
    state, awaitWithTimeout: withDeadline(timeoutMs),
    agentSlot: { isBusy: () => false, isMode: () => false },
    makeId: () => `retry-${++ids}`, now: () => '',
    activeChatProfile: () => ({ id: 'test-model' }),
    ensureConfigured: configure,
    validateRetryPageTarget: validate,
    setAssistantPhase: (assistant, phase) => { assistant.requestPhase = phase; },
    refreshPageForRetry: async (conversation, question, assistant, signal, target) => {
      events.push('refresh');
      refreshCalls.push({ conversation, question, assistant, signal, target });
      return refresh(conversation, question, assistant, signal, target);
    },
    saveCurrent: async (options) => { events.push('save'); const pending = deferred(); saves.push({ ...pending, options }); return pending.promise; },
    generateReply: async (assistant) => {
      events.push('generate');
      generations.push({ conversationId: state.conversation.id, assistant, messages: requestMessagesFor(state.conversation, assistant.id, state.conversation.pageContext) });
      return 'Fixture model answer';
    },
    renderQueueBar: noop, renderConversation: noop, updateComposer: noop, processQueue: noop, scheduleSave: noop,
    toast: (message) => errors.push(message),
  });
  return { state, saves, generations, errors, refreshCalls, events, retry: (id = 'answer') => context.regenerate(id), stop: () => context.stopActiveReply() };
}

test('retry cancellation releases its submission lock before a slow save completes', async () => {
  const fixtureValue = fixture();
  const { state, saves, generations, retry, stop } = fixtureValue;
  const pending = retry();
  await tick();
  assert.equal(state.isSubmitting, true);
  assert.equal(saves[0].options.required, true);
  stop();
  await pending;
  assert.equal(state.isSubmitting, false);
  assert.equal(state.conversation.messages.at(-1).status, 'stopped');
  assert.equal(generations.length, 0);
  saves[0].resolve();
  await tick();
  assert.equal(generations.length, 0, 'late storage completion must not launch the stopped retry');
});

test('a retry cannot launch in a different conversation after its save', async () => {
  const { state, saves, generations, retry } = fixture();
  const pending = retry();
  await tick();
  state.conversation = { id: 'different', messages: [] };
  saves[0].resolve();
  await pending;
  assert.equal(generations.length, 0);
  assert.equal(state.conversation.messages.length, 0);
  assert.equal(state.isSubmitting, false);
});

test('an older retry cleanup cannot release or generate over its replacement owner', async () => {
  const { state, saves, generations, retry } = fixture();
  const first = retry();
  await tick();
  const replacement = retry(state.conversation.messages.at(-1).id);
  await tick();
  const replacementOwner = state.submissionOwner;
  await first;
  saves[0].resolve();
  await tick();
  assert.equal(state.submissionOwner, replacementOwner);
  assert.equal(state.isSubmitting, true);
  assert.equal(generations.length, 0);
  saves[1].resolve();
  await replacement;
  assert.equal(generations.length, 1);
  assert.equal(generations[0].assistant.id, state.conversation.messages.at(-1).id);
  assert.equal(state.isSubmitting, false);
});

test('retry does not send a model request when the required save fails', async () => {
  const { state, saves, generations, errors, retry } = fixture();
  const pending = retry();
  await tick();
  saves[0].reject(new Error('Disk unavailable'));
  await pending;
  assert.equal(generations.length, 0);
  assert.equal(state.conversation.messages.at(-1).status, 'error');
  assert.match(errors[0], /Disk unavailable/);
  assert.equal(state.isSubmitting, false);
});

test('retry captures its target before a slow model configuration read', async () => {
  const configured = deferred();
  let documentId = 'document-at-click';
  const value = fixture({ configure: () => configured.promise, validate: async () => ({ id: 9, documentId }) });
  const pending = value.retry();
  documentId = 'refreshed-during-configuration';
  configured.resolve(true);
  await tick();
  assert.equal(value.refreshCalls[0].target.documentId, 'document-at-click');
  value.saves[0].resolve();
  await pending;
  assert.equal(value.generations.length, 1);
});

test('cancellation during retry configuration leaves no replacement or late save', async () => {
  const configured = deferred();
  const { state, saves, generations, retry, stop } = fixture({ configure: () => configured.promise });
  const pending = retry();
  stop();
  await pending;
  configured.resolve(true);
  await tick();
  assert.equal(state.conversation.messages.at(-1).id, 'answer');
  assert.equal(state.isSubmitting, false);
  assert.equal(saves.length, 0);
  assert.equal(generations.length, 0);
});

test('retry refreshes the retained question after duplicate folding and before saving or generating', async () => {
  const refreshed = deferred();
  const { state, saves, refreshCalls, events, retry } = fixture({ refresh: () => refreshed.promise });
  const retained = { id: 'first-question', role: 'user', content: 'Question' };
  const removed = { id: 'duplicate-question', role: 'user', content: 'Question' };
  state.conversation.messages = [retained, { id: 'first-answer', role: 'assistant', status: 'stopped' }, removed, { id: 'duplicate-answer', role: 'assistant', status: 'error' }];
  const pending = retry('duplicate-answer');
  await tick();
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].question, retained);
  assert.notEqual(refreshCalls[0].question, removed);
  assert.equal(refreshCalls[0].assistant, state.conversation.messages.at(-1));
  assert.equal(refreshCalls[0].assistant.requestPhase, 'preparing');
  assert.equal(state.conversation.messages.length, 2);
  assert.equal(saves.length, 0);
  assert.deepEqual(events, ['refresh']);
  refreshed.resolve();
  await tick();
  assert.deepEqual(events, ['refresh', 'save']);
  assert.equal(refreshCalls[0].assistant.requestPhase, 'saving');
  saves[0].resolve();
  await pending;
  assert.deepEqual(events, ['refresh', 'save', 'generate']);
});

test('retry reading failures do not save a ready request or start the model', async () => {
  const { state, saves, generations, errors, retry } = fixture({ refresh: async () => { throw new Error('页面正文无法读取'); } });
  await retry();
  assert.equal(saves.length, 0);
  assert.equal(generations.length, 0);
  assert.equal(state.conversation.messages.at(-1).status, 'error');
  assert.match(errors[0], /正文无法读取/);
  assert.equal(state.isSubmitting, false);
});

test('stopping a retry during page refresh prevents a late save and model request', async () => {
  const refreshed = deferred();
  const { state, saves, generations, refreshCalls, retry, stop } = fixture({ refresh: () => refreshed.promise });
  const pending = retry();
  await tick();
  stop();
  await pending;
  assert.equal(refreshCalls[0].signal.aborted, true);
  assert.equal(state.isSubmitting, false);
  assert.equal(state.conversation.messages.at(-1).status, 'stopped');
  refreshed.resolve();
  await tick();
  assert.equal(saves.length, 0);
  assert.equal(generations.length, 0);
});

function agentSubmissionFixture({ agentMode = true, configure = async () => true, ensure, timeoutMs, query = async () => [{ id: 1, url: 'https://page.test' }], read = async () => null } = {}) {
  const state = { conversation: { id: 'original', messages: [] }, ready: true, attachments: [], messageQueue: [], selectedEffort: 'default', disablePageContext: true };
  const save = deferred();
  let starts = 0;
  const modelRequests = [];
  const errors = [];
  const readCalls = [];
  const noop = () => {};
  const input = { value: 'Unsent draft' };
  const context = createConversationServiceFixture({
    state, input, awaitWithTimeout: withDeadline(timeoutMs),
    chrome: { tabs: { query }, runtime: { sendMessage: async message => ({ tabId: message.tabId, url: message.expectedUrl, documentId: 'fixture-document' }) } },
    makeId: () => Math.random().toString(), now: () => '',
    agentSlot: { isMode: () => agentMode, isBusy: () => false, start: async () => { starts += 1; return true; } },
    ensureConversation: () => ensure ? ensure(state) : Promise.resolve(state.conversation), ensureConfigured: configure,
    saveCurrent: () => save.promise,
    activeChatProfile: () => ({ id: 'test-model' }), conversationTitle: (content) => content,
    setAssistantPhase: (assistant, phase) => { if (assistant) assistant.requestPhase = phase; },
    getDirectoryInfo: async () => ({ granted: false }),
    readCurrentPageForRequest: async (question, options) => { readCalls.push({ question, ...options }); return read(question, options); },
    renderContextChip: noop, hasVision: () => true,
    generateReply: async (assistant) => { modelRequests.push(assistant); return 'Fixture model answer'; },
    setPageSelection: (selection) => { state.pageSelection = selection; }, renderPageSelection: noop,
    truncateText: (value) => value,
    resizeInput: noop, renderAttachments: noop, updateComposer: noop, renderQueueBar: noop,
    renderConversation: noop, processQueue: noop, scheduleSave: noop, toast: (message) => errors.push(message),
  });
  return { state, input, save, modelRequests, errors, readCalls, send: context.sendMessage, stop: context.stopActiveReply, starts: () => starts };
}

test('stopping during the pre-Agent save prevents a late browser task start', async () => {
  const { save, send, stop, starts } = agentSubmissionFixture();
  const pending = send('Browser task');
  await tick();
  stop();
  save.resolve();
  await pending;
  assert.equal(starts(), 0);
});

test('dispatching a queued payload preserves text still being drafted in the composer', async () => {
  const { input, save, send, stop, starts } = agentSubmissionFixture();
  const pending = send('Queued browser task', { fromQueue: true, attachments: [], selection: null, pageContextEnabled: false });
  await tick();
  assert.equal(input.value, 'Unsent draft');
  stop();
  save.resolve();
  await pending;
  assert.equal(starts(), 0);
  assert.equal(input.value, 'Unsent draft');
});

test('ordinary send cancellation stops waiting for a slow required save and never starts later', async () => {
  const { state, save, send, stop, modelRequests } = agentSubmissionFixture({ agentMode: false });
  const pending = send('Ordinary question');
  await tick();
  assert.equal(state.isSubmitting, true);
  assert.equal(state.conversation.messages.at(-1).status, 'streaming');
  stop();
  await pending;
  assert.equal(state.isSubmitting, false);
  assert.equal(state.conversation.messages.at(-1).status, 'stopped');
  assert.equal(modelRequests.length, 0);
  save.resolve();
  await tick();
  assert.equal(modelRequests.length, 0);
});

test('attachment-only save failure settles the existing answer without duplicating the draft', async () => {
  const { state, input, save, send, modelRequests } = agentSubmissionFixture({ agentMode: false });
  state.attachments = [{ id: 'only-file', type: 'document', name: 'note.txt', text: 'Document body' }];
  input.value = '';
  const pending = send('');
  await tick();
  save.reject(new Error('Disk unavailable'));
  await pending;
  assert.equal(modelRequests.length, 0);
  assert.equal(state.isSubmitting, false);
  assert.equal(state.conversation.messages.length, 2);
  assert.equal(state.conversation.messages.at(-1).status, 'error');
  assert.match(state.conversation.messages.at(-1).errorMessage, /Disk unavailable/);
  assert.equal(state.attachments.length, 0, 'the retained failed turn owns its attachment; do not also restore it to the draft');
});

test('queued sends retain the conversation that accepted the submission', async () => {
  const { state, send } = agentSubmissionFixture({ agentMode: false });
  state.generatingId = state.conversation.id;
  await send('Question for the original conversation');
  assert.equal(state.messageQueue.length, 1);
  assert.equal(state.messageQueue[0].conversationId, 'original');
});

test('a queued send during first-conversation preparation binds to the created conversation', async () => {
  const prepared = deferred();
  const { state, save, send, modelRequests } = agentSubmissionFixture({ agentMode: false, ensure: () => prepared.promise });
  state.conversation = null;
  const first = send('First question');
  await tick();
  assert.equal(state.isSubmitting, true);
  await send('Queued before the first conversation exists');
  assert.equal(state.messageQueue.length, 1);
  const unrelated = { id: 'unrelated', conversationId: null, submissionOwner: {} };
  state.messageQueue.push(unrelated);
  const created = { id: 'first-created', messages: [] };
  state.conversation = created;
  prepared.resolve(created);
  try {
    await tick();
    assert.equal(state.messageQueue[0].conversationId, created.id);
    assert.equal(unrelated.conversationId, null, 'only the owning submission may bind a preparation queue');
    assert.equal(modelRequests.length, 0, 'binding occurs during preparation, before the required save completes');
  } finally {
    save.resolve();
    await first;
  }
});

test('a waiting queue never submits an original-conversation question into another conversation', async () => {
  const queued = { id: 'queued', conversationId: 'original', content: 'Original question', pageContextEnabled: true, readingPolicy: { scope: 'page' } };
  const state = { conversation: { id: 'original', messages: [] }, messageQueue: [queued], disablePageContext: true };
  const sent = [];
  const context = createConversationServiceFixture({
    state, agentSlot: { isBusy: () => false }, renderQueueBar: () => {},
    generateReply: assistant => sent.push({ assistant, conversationId: state.conversation.id }),
  });
  await context.processQueue();
  assert.equal(sent.length, 0, 'the page-disabled queue should wait');
  state.conversation = { id: 'new-conversation', messages: [] };
  state.disablePageContext = false;
  await context.processQueue();
  assert.equal(sent.length, 0, 'switching conversations must not retarget a queued submission');
});

test('returning to the original conversation resumes its waiting queue exactly once', async () => {
  const queued = { id: 'queued', conversationId: 'original', content: 'Original question', pageContextEnabled: false };
  const state = { conversation: { id: 'other', messages: [] }, messageQueue: [queued], disablePageContext: false };
  const sent = [];
  const context = createConversationServiceFixture({
    state, agentSlot: { isBusy: () => false }, renderQueueBar: () => {},
    agentTurnCallbacks: { reconcile: () => {} },
    loadConversation: async (id) => ({ id, messages: [] }),
    refreshHistory: async () => {}, setHistoryOpen: () => {}, renderConversation: () => {}, toast: () => {},
    generateReply: (assistant, run) => sent.push({ assistant, commandId: run.commandId, conversationId: state.conversation.id }),
  });
  await context.processQueue();
  assert.equal(sent.length, 0);
  state.conversation = { id: 'original', messages: [] };
  context.repository.reconcile(state.conversation);
  await context.processQueue();
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, 'original');
  assert.equal(sent[0].commandId, 'queued');
  assert.equal(state.messageQueue.length, 0);
  await context.processQueue();
  assert.equal(sent.length, 1);
});

test('queued ordinary sends preserve live composer text, attachments and selection', async () => {
  const { state, input, save, send, modelRequests } = agentSubmissionFixture({ agentMode: false });
  const draftAttachment = { id: 'draft-file', type: 'document', text: 'Unsent document' };
  const draftSelection = { text: 'Fresh selection', url: 'https://new.test' };
  state.attachments = [draftAttachment];
  state.pageSelection = draftSelection;
  const pending = send('Queued question', { fromQueue: true, attachments: [], selection: null, pageContextEnabled: false });
  await tick();
  assert.equal(input.value, 'Unsent draft');
  assert.deepEqual(state.attachments, [draftAttachment]);
  assert.equal(state.pageSelection, draftSelection);
  save.resolve();
  await pending;
  assert.equal(modelRequests.length, 1);
  assert.equal(input.value, 'Unsent draft');
  assert.deepEqual(state.attachments, [draftAttachment]);
  assert.equal(state.pageSelection, draftSelection);
  assert.equal(state.conversation.messages[0].attachments.length, 0);
  assert.equal(state.conversation.messages[0].selection, null);
});

test('a queued preparation failure restores its payload without erasing a newer draft', async () => {
  const { state, input, send } = agentSubmissionFixture({ agentMode: false, configure: async () => false });
  const draftAttachment = { id: 'draft-file', type: 'document', text: 'Draft' };
  const queuedAttachment = { id: 'queued-file', type: 'document', text: 'Queued' };
  state.attachments = [draftAttachment];
  await send('Queued question', { fromQueue: true, attachments: [queuedAttachment], selection: null, pageContextEnabled: false });
  assert.equal(input.value, 'Unsent draft\n\nQueued question');
  assert.deepEqual(Array.from(state.attachments, (item) => item.id), ['draft-file', 'queued-file']);
  assert.equal(state.conversation.messages.length, 0);
  assert.equal(state.isSubmitting, false);
});

test('retry preparation timeout releases the lock and ignores late configuration', { timeout: 1000 }, async () => {
  const configured = deferred();
  const { state, saves, generations, errors, retry } = fixture({ configure: () => configured.promise, timeoutMs: 10 });
  await retry();
  assert.equal(state.isSubmitting, false);
  assert.equal(state.submissionController, null);
  assert.equal(state.conversation.messages.at(-1).id, 'answer');
  assert.match(errors[0], /配置超时/);
  configured.resolve(true);
  await tick();
  assert.equal(saves.length, 0);
  assert.equal(generations.length, 0);
});

test('retry save timeout settles the visible reply and cannot launch after storage recovers', { timeout: 1000 }, async () => {
  const { state, saves, generations, errors, retry } = fixture({ timeoutMs: 10 });
  await retry();
  assert.equal(state.isSubmitting, false);
  assert.equal(state.sendInFlight, false);
  assert.equal(state.conversation.messages.at(-1).status, 'error');
  assert.match(state.conversation.messages.at(-1).errorMessage, /保存消息超时/);
  assert.match(errors[0], /尚未请求模型/);
  saves[0].resolve();
  await tick();
  assert.equal(generations.length, 0);
});

test('ordinary send save timeout ends preparation and never sends a late model request', { timeout: 1000 }, async () => {
  const { state, save, modelRequests, errors, send } = agentSubmissionFixture({ agentMode: false, timeoutMs: 10 });
  await send('Question with stalled storage');
  assert.equal(state.isSubmitting, false);
  assert.equal(state.sendInFlight, false);
  assert.equal(state.conversation.messages.at(-1).status, 'error');
  assert.match(errors[0], /保存消息超时/);
  save.resolve();
  await tick();
  assert.equal(modelRequests.length, 0);
});

test('Agent preparation timeout restores its queued draft once and cannot start on late configuration', { timeout: 1000 }, async () => {
  const configured = deferred();
  const { state, input, send, starts } = agentSubmissionFixture({ configure: () => configured.promise, timeoutMs: 10 });
  await send('Queued browser task', { fromQueue: true, pageContextEnabled: false });
  assert.equal(input.value, 'Unsent draft\n\nQueued browser task');
  assert.equal(state.isSubmitting, false);
  assert.equal(state.conversation.messages.length, 0);
  configured.resolve(true);
  await tick();
  assert.equal(starts(), 0);
  assert.equal(input.value, 'Unsent draft\n\nQueued browser task');
});

test('a summary cannot silently become a plain prompt if the active tab is no longer readable', async () => {
  const { state, send, modelRequests, readCalls, errors } = agentSubmissionFixture({ agentMode: false, query: async () => [{ id: 2, url: 'chrome://settings' }] });
  state.disablePageContext = false;
  await send('请总结这个网页', { requirePage: true });
  assert.equal(readCalls.length, 0);
  assert.equal(modelRequests.length, 0);
  assert.equal(state.isSubmitting, false);
  assert.equal(state.conversation.messages.at(-1).status, 'error');
  assert.match(errors[0], /页面|网页/);
});

function summaryFixture({ disabled = false, active = { url: 'https://page.test' } } = {}) {
  const state = { ready: true, disablePageContext: disabled, activePageSignal: active };
  const sent = [];
  const notices = [];
  const input = { value: '请按主题归纳' };
  const context = vm.createContext({
    state, input, Date, isReadablePageUrl, normalizeDraftSource,
    pastedText: { getValue: () => input.value },
    agentSlot: { isMode: () => false, isBusy: () => false },
    sendMessage: async (text, options) => sent.push({ text, options }),
    toast: (message) => notices.push(message),
  });
  vm.runInContext(section('let lastSummarizeAt', 'async function switchToActivePage()'), context);
  return { state, input, sent, notices, summarize: context.summarizePage };
}

test('summary handler does not send or enable page reading when the page switch is off', async () => {
  const { state, input, sent, notices, summarize } = summaryFixture({ disabled: true });
  await summarize();
  assert.equal(sent.length, 0);
  assert.equal(state.disablePageContext, true);
  assert.equal(input.value, '请按主题归纳');
  assert.match(notices[0], /页面读取已关闭/);
});

test('enabled summary requires a page and preserves the current toggle choice', async () => {
  const { state, sent, summarize } = summaryFixture();
  await summarize();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '请按主题归纳');
  assert.equal(sent[0].options.requirePage, true);
  assert.equal(sent[0].options.pageContextEnabled, undefined);
  assert.equal(state.disablePageContext, false);
});

const oldPage = { url: 'https://page.test/article', title: 'Article', text: 'STALE_NAVIGATION_SHELL', capturedAt: '2026-10-29', documentId: 'old-document' };
const freshPage = { ...oldPage, text: 'FRESH_ARTICLE_BODY: 今天重新读取的完整正文。', capturedAt: '2026-10-30', documentId: 'new-document' };

function pageRefreshFixture({ query = async () => [{ id: 9, url: oldPage.url, documentId: freshPage.documentId }], read = async () => freshPage, disabled = false, timeoutMs } = {}) {
  const state = { disablePageContext: disabled, pendingPage: oldPage };
  const reads = [];
  let queries = 0;
  const question = { id: 'question', role: 'user', content: '请总结这个网页', status: 'complete', pageContextEnabled: true, pageSource: pageSourceFor(oldPage) };
  const assistant = { id: 'answer', role: 'assistant', status: 'streaming', content: '' };
  const conversation = { id: 'original', pageContext: oldPage, messages: [question, assistant] };
  const context = vm.createContext({
    state, awaitWithAbort, awaitWithTimeout: withDeadline(timeoutMs),
    chrome: { tabs: { query: async () => { queries += 1; return query(); } },
      runtime: { sendMessage: async message => ({ tabId: message.tabId, url: message.expectedUrl, documentId: freshPage.documentId }) } },
    setAssistantPhase: (message, phase) => { message.requestPhase = phase; },
    activeContextWindow: () => 128000, updatePageToolbar: () => {},
    pageReadState: createPageReadState({ onChange: activity => { state.readingPage = activity.status === 'reading'; } }),
    pageReaderSlot: { read: async (options) => { reads.push(options); const page = await read(options); return page ? { ...page, tabId: options.tabId } : page; } },
  });
  // The page adapter remains a UI composition port. Retry orchestration itself
  // is imported from the application service, never extracted into a VM.
  vm.runInContext(section('async function readCurrentPageForRequest(', 'function adoptPageSource('), context);
  const service = createConversationServiceFixture({ ...context, state });
  return {
    state, question, assistant, conversation, reads, queries: () => queries,
    refresh: (signal) => service.refreshPageForRetry(conversation, question, assistant, signal),
    validate: service.validateRetryPageTarget,
    refreshForRetry: service.refreshPageForRetry,
  };
}

test('retry keeps ordinary questions page-free even when old page metadata remains', async () => {
  const value = pageRefreshFixture({ disabled: true });
  value.question.pageContextEnabled = false;
  await value.refresh();
  assert.equal(value.queries(), 0);
  assert.equal(value.reads.length, 0);
  assert.equal(value.conversation.pageContext, oldPage);
  const messages = requestMessagesFor(value.conversation, value.assistant.id, value.conversation.pageContext);
  assert.doesNotMatch(JSON.stringify(messages), /STALE_NAVIGATION_SHELL/);
});

test('page retry requires both an enabled switch and a recorded source', async () => {
  const disabled = pageRefreshFixture({ disabled: true });
  await assert.rejects(disabled.refresh(), /页面读取已关闭/);
  assert.equal(disabled.queries(), 0);
  const missing = pageRefreshFixture();
  missing.question.pageSource = null;
  await assert.rejects(missing.refresh(), /没有记录页面来源/);
  assert.equal(missing.queries(), 0);
});

test('retry rejects a different active page before reading it', async () => {
  const value = pageRefreshFixture({ query: async () => [{ id: 10, url: 'https://other.test/article' }] });
  await assert.rejects(value.refresh(), /来源不同/);
  assert.equal(value.reads.length, 0);
  assert.equal(value.conversation.pageContext, oldPage);
});

test('retry rechecks a switch turned off while the active tab was being resolved', async () => {
  const tabs = deferred();
  const value = pageRefreshFixture({ query: () => tabs.promise });
  const pending = value.refresh();
  value.state.disablePageContext = true;
  tabs.resolve([{ id: 9, url: oldPage.url }]);
  await assert.rejects(pending, /页面读取已关闭/);
  assert.equal(value.reads.length, 0);
});

test('reopening the switch and retrying rereads the original page and sends only its fresh body', async () => {
  const reading = pageRefreshFixture({ disabled: true });
  reading.state.disablePageContext = false;
  const { state, saves, generations, retry } = fixture({ validate: reading.validate, refresh: reading.refreshForRetry });
  state.conversation.pageContext = oldPage;
  Object.assign(state.conversation.messages[0], { pageContextEnabled: true, pageSource: pageSourceFor(oldPage) });
  const pending = retry();
  await tick();
  assert.equal(reading.reads.length, 1);
  assert.equal(reading.queries(), 1, 'reading must reuse the tab captured by preflight');
  assert.equal(reading.reads[0].forceRefresh, true);
  assert.equal(reading.reads[0].expectedUrl, oldPage.url);
  assert.equal(reading.reads[0].tabId, 9);
  assert.equal(reading.reads[0].throwOnError, true);
  assert.equal(state.conversation.pageContext.text, freshPage.text);
  assert.equal(state.conversation.messages[0].pageSource.capturedAt, freshPage.capturedAt);
  assert.equal(state.conversation.messages[0].pageSource.documentId, freshPage.documentId);
  saves[0].resolve();
  await pending;
  assert.equal(generations.length, 1);
  assert.match(JSON.stringify(generations[0].messages), /FRESH_ARTICLE_BODY/);
  assert.doesNotMatch(JSON.stringify(generations[0].messages), /STALE_NAVIGATION_SHELL/);
});

test('stopping a real retry read keeps a late body from being adopted or sent', async () => {
  const body = deferred();
  const reading = pageRefreshFixture({ read: () => body.promise });
  const { state, saves, generations, retry, stop } = fixture({ validate: reading.validate, refresh: reading.refreshForRetry });
  state.conversation.pageContext = oldPage;
  Object.assign(state.conversation.messages[0], { pageContextEnabled: true, pageSource: pageSourceFor(oldPage) });
  const pending = retry();
  await tick();
  assert.equal(state.conversation.messages.at(-1).requestPhase, 'reading');
  stop();
  await pending;
  assert.equal(reading.reads[0].signal.aborted, true);
  assert.equal(reading.state.readingPage, false);
  assert.equal(state.isSubmitting, false);
  body.resolve(freshPage);
  await tick();
  assert.equal(state.conversation.pageContext, oldPage);
  assert.equal(saves.length, 0);
  assert.equal(generations.length, 0);
});

test('page read timeout stops the retry instead of sending its cached shell', async () => {
  const reading = pageRefreshFixture({ read: async () => { throw new DOMException('网页读取超时，请重试。', 'TimeoutError'); } });
  const { state, saves, generations, errors, retry } = fixture({ validate: reading.validate, refresh: reading.refreshForRetry });
  state.conversation.pageContext = oldPage;
  Object.assign(state.conversation.messages[0], { pageContextEnabled: true, pageSource: pageSourceFor(oldPage) });
  await retry();
  assert.equal(state.conversation.messages.at(-1).status, 'error');
  assert.match(errors[0], /读取超时/);
  assert.equal(state.isSubmitting, false);
  assert.equal(reading.state.readingPage, false);
  assert.equal(saves.length, 0);
  assert.equal(generations.length, 0);
});

test('a timed-out retry tab lookup cannot read or overwrite page context later', { timeout: 1000 }, async () => {
  const tabs = deferred();
  const value = pageRefreshFixture({ query: () => tabs.promise, timeoutMs: 10 });
  await assert.rejects(value.refresh(), (error) => error.name === 'TimeoutError' && /获取重试页面超时/.test(error.message));
  tabs.resolve([{ id: 9, url: oldPage.url }]);
  await tick();
  assert.equal(value.reads.length, 0);
  assert.equal(value.conversation.pageContext, oldPage);
});

test('legacy ordinary retry explicitly disables page context before building the model request', async () => {
  const reading = pageRefreshFixture();
  const { state, saves, generations, retry } = fixture({ validate: reading.validate, refresh: reading.refreshForRetry });
  state.conversation.pageContext = oldPage;
  const question = state.conversation.messages[0];
  assert.equal(question.pageContextEnabled, undefined);
  assert.equal(question.pageSource, undefined);
  const pending = retry();
  await tick();
  assert.equal(question.pageContextEnabled, false);
  assert.equal(reading.queries(), 0);
  assert.equal(reading.reads.length, 0);
  saves[0].resolve();
  await pending;
  assert.equal(generations.length, 1);
  assert.doesNotMatch(JSON.stringify(generations[0].messages), /STALE_NAVIGATION_SHELL|FRESH_ARTICLE_BODY/);
});

function addPageHistory(value) {
  const { state } = value;
  state.conversation.pageContext = oldPage;
  Object.assign(state.conversation.messages[0], { pageContextEnabled: true, pageSource: pageSourceFor(oldPage) });
  state.conversation.messages.push(
    { id: 'later-question', role: 'user', content: 'Do not lose this later question', status: 'complete' },
    { id: 'later-answer', role: 'assistant', content: 'Do not lose this later answer', status: 'complete' },
  );
  return { messages: state.conversation.messages, snapshot: structuredClone(state.conversation.messages) };
}

for (const { name, options, error } of [
  { name: 'the page switch is off', options: { disabled: true }, error: /页面读取已关闭/ },
  { name: 'another page is active', options: { query: async () => [{ id: 10, url: 'https://other.test/article' }] }, error: /来源不同/ },
]) {
  test(`retry preserves the original answer and later turns when ${name}`, async () => {
    const reading = pageRefreshFixture(options);
    const value = fixture({ validate: reading.validate, refresh: reading.refreshForRetry });
    const original = addPageHistory(value);
    await value.retry('answer');
    assert.equal(value.state.conversation.messages, original.messages);
    assert.deepEqual(value.state.conversation.messages, original.snapshot);
    assert.equal(value.state.conversation.pageContext, oldPage);
    assert.match(value.errors[0], error);
    assert.equal(value.state.isSubmitting, false);
    assert.equal(value.state.sendInFlight, false);
    assert.equal(reading.reads.length, 0);
    assert.equal(value.refreshCalls.length, 0);
    assert.equal(value.saves.length, 0);
    assert.equal(value.generations.length, 0);
  });
}

test('cancelling retry preflight preserves all original turns and ignores a late tab result', async () => {
  const tabs = deferred();
  const reading = pageRefreshFixture({ query: () => tabs.promise });
  const value = fixture({ validate: reading.validate, refresh: reading.refreshForRetry });
  const original = addPageHistory(value);
  const pending = value.retry('answer');
  await tick();
  assert.equal(value.state.conversation.messages, original.messages);
  value.stop();
  await pending;
  tabs.resolve([{ id: 9, url: oldPage.url }]);
  await tick();
  assert.equal(value.state.conversation.messages, original.messages);
  assert.deepEqual(value.state.conversation.messages, original.snapshot);
  assert.equal(value.state.isSubmitting, false);
  assert.equal(reading.reads.length, 0);
  assert.equal(value.saves.length, 0);
  assert.equal(value.generations.length, 0);
});

test('retry preflight timeout preserves original history before releasing its lock', { timeout: 1000 }, async () => {
  const tabs = deferred();
  const reading = pageRefreshFixture({ query: () => tabs.promise, timeoutMs: 10 });
  const value = fixture({ validate: reading.validate, refresh: reading.refreshForRetry });
  const original = addPageHistory(value);
  await value.retry('answer');
  assert.match(value.errors[0], /获取重试页面超时/);
  assert.equal(value.state.isSubmitting, false);
  tabs.resolve([{ id: 9, url: oldPage.url }]);
  await tick();
  assert.equal(value.state.conversation.messages, original.messages);
  assert.deepEqual(value.state.conversation.messages, original.snapshot);
  assert.equal(reading.reads.length, 0);
  assert.equal(value.saves.length, 0);
  assert.equal(value.generations.length, 0);
});

test('refresh rechecks the switch even with a target already captured by preflight', async () => {
  const reading = pageRefreshFixture();
  const target = await reading.validate(reading.question);
  reading.state.disablePageContext = true;
  await assert.rejects(
    reading.refreshForRetry(reading.conversation, reading.question, reading.assistant, undefined, target),
    /页面读取已关闭/,
  );
  assert.equal(reading.queries(), 1);
  assert.equal(reading.reads.length, 0);
  assert.equal(reading.conversation.pageContext, oldPage);
});

test('page-off image uploads do not inherit old page metadata while explicit screenshot sources survive', async () => {
  const { state, save, send, modelRequests } = agentSubmissionFixture({ agentMode: false });
  state.disablePageContext = true;
  state.conversation.pageContext = oldPage;
  state.attachments = [
    { id: 'uploaded-image', type: 'image', name: 'upload.png', dataUrl: 'data:image/png;base64,AAAA' },
    { id: 'page-screenshot', type: 'image', name: 'screenshot.png', dataUrl: 'data:image/png;base64,BBBB', pageUrl: 'https://capture.test/original', pageTitle: 'Original screenshot source', scope: 'page' },
  ];
  const pending = send('请描述附件');
  await tick();
  save.resolve();
  await pending;
  assert.equal(modelRequests.length, 1);
  const user = state.conversation.messages.find((message) => message.role === 'user');
  assert.equal(user.pageContextEnabled, false);
  assert.equal(user.pageSource, null);
  const upload = user.attachments.find((attachment) => attachment.id === 'uploaded-image');
  assert.equal(Object.hasOwn(upload, 'pageUrl'), false);
  assert.equal(Object.hasOwn(upload, 'pageTitle'), false);
  assert.equal(Object.hasOwn(upload, 'scope'), false);
  const screenshot = user.attachments.find((attachment) => attachment.id === 'page-screenshot');
  assert.equal(screenshot.pageUrl, 'https://capture.test/original');
  assert.equal(screenshot.pageTitle, 'Original screenshot source');
  assert.equal(screenshot.scope, 'page');
});

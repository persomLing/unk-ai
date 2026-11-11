import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidepanelApplication } from '../src/sidepanel/composition/application-root.js';
import { createModelGateway } from '../src/app/model-gateway.js';
import { createContextService } from '../src/app/context-service.js';
import { observeModelDiagnostic } from '../src/utils/diagnostic-observer.js';
import { createDiagnosticLogService } from '../src/utils/diagnostic-log.js';
import { createDiagnosticStore } from '../src/utils/diagnostic-store.js';
import { memoryIndexedDB } from './helpers/memory-indexeddb.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a late suggestion failure remains in its original conversation export after the main reply ends', async t => {
  const logs = createDiagnosticLogService({ store: createDiagnosticStore({ indexedDB: memoryIndexedDB(), timeoutMs: 200 }),
    getDirectory: async () => null, autoFlush: false });
  const pendingLogs = [];
  const record = event => { const pending = logs.recordDiagnostic(event); pendingLogs.push(pending); return pending; };
  const original = { id: 'original-conversation', storage: 'temporary', title: 'Original', messages: [] };
  const state = { config: { webSearchEnabled: false }, conversation: original, ready: true, attachments: [], messageQueue: [],
    selectedEffort: 'default', selectedModelId: 'model', disablePageContext: true, draft: '' };
  const profile = { model: 'model', contextLength: 8192, maxTokens: 256, webSearchEnabled: false };
  let rejectSuggestion;
  const suggestion = new Promise((_resolve, reject) => { rejectSuggestion = reject; });
  const gateway = createModelGateway({ onEvent: event => observeModelDiagnostic(record, event), transport: input => {
    if (input.purpose === 'suggestions') return suggestion;
    input.onDelta('Answer', 'Answer');
    return 'Answer';
  } });
  let id = 0;
  const saver = { save: async conversation => conversation, schedule: () => {} };
  const application = createSidepanelApplication({ state, conversationSaver: saver, modelGateway: gateway, recordDiagnostic: record,
    browser: { queryActiveTab: async () => null, sendMessage: async () => ({}) },
    agentSlot: { isBusy: () => false, isMode: () => false },
    ensureConversation: async () => state.conversation, ensureConfigured: async () => true,
    saveCurrent: async () => state.conversation, scheduleSave: () => {}, getDirectoryInfo: async () => ({ granted: false }),
    promoteTemporaryConversation: async conversation => conversation,
    readCurrentPageForRequest: async () => assert.fail('No page read requested'), autoVisualAttachments: async () => [],
    activeChatProfile: () => profile, profileFor: () => profile, conversationTitle: () => 'Original', hasVision: () => false,
    makeId: () => `id-${++id}`, now: () => new Date().toISOString() });
  t.after(() => { application.dispose(); logs.dispose(); });
  await application.conversations.sendMessage('Explain a stable concept.');
  await tick();
  assert.equal(original.messages.at(-1).status, 'complete');
  assert.equal(application.runner.active(), null);
  state.conversation = { id: 'other-conversation', storage: 'temporary', messages: [] };
  rejectSuggestion(new Error('Provider unavailable SECRET'));
  await tick();
  await Promise.all(pendingLogs);
  const bundle = await logs.collectDiagnosticLogs({ conversationId: original.id });
  const failure = bundle.events.find(event => event.event === 'model.request.failed' && event.data.purpose === 'suggestions');
  assert.ok(failure, 'the optional failure must be included in the originating conversation export');
  assert.equal(failure.context.conversationId, bundle.scope.conversationId);
  assert.ok(failure.context.turnId);
  assert.equal(bundle.events.filter(event => event.event === 'turn.terminal').length, 1);
  assert.equal(original.messages.at(-1).status, 'complete');
  assert.equal(original.messages.at(-1).content, 'Answer');
  assert.equal((await logs.collectDiagnosticLogs({ conversationId: state.conversation.id })).events.length, 0);
  assert.doesNotMatch(JSON.stringify(bundle), /SECRET|original-conversation|Explain a stable concept/);
});

test('independent compression diagnostics retain the submitted conversation after a view change', async t => {
  const events = [];
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const original = { id: 'original', messages: Array.from({ length: 10 }, (_, index) => ({ id: `history-${index}`,
    role: index % 2 ? 'assistant' : 'user', status: 'complete', content: `第${index}条已确认记录。`.repeat(350) })) };
  original.messages.push({ id: 'current-user', role: 'user', content: 'Continue', status: 'complete' },
    { id: 'current-answer', role: 'assistant', content: '', status: 'streaming' });
  const state = { conversation: original };
  const gateway = createModelGateway({ onEvent: event => observeModelDiagnostic(value => events.push(value), event), transport: () => pending });
  const service = createContextService({ state, modelGateway: gateway, profileFor: () => ({ model: 'model', contextLength: 8192, maxTokens: 512 }),
    save: () => {}, createId: () => 'independent' });
  t.after(() => service.dispose());
  const result = service.compress(original, 'current-answer', { manual: true });
  await tick();
  state.conversation = { id: 'new-current', messages: [] };
  resolve('Confirmed summary');
  assert.equal(await result, true);
  assert.ok(events.length >= 2);
  assert.ok(events.every(event => event.context.conversationId === original.id));
  assert.equal(events.find(event => event.event === 'model.request.completed').data.purpose, 'compression');
});

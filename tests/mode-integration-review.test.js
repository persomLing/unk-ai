import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';
import { requestMessagesFor } from '../src/utils/context.js';
import { getTemporaryConversation, saveTemporaryConversation } from '../src/utils/storage.js';
import { readingPolicyForTurn, readingPolicyForRetry } from '../src/utils/reading-plan.js';
import { agentFailureForMessage } from '../src/utils/agent-conversation.js';
import { createAgentTurnCallbacks } from '../src/sidepanel/features/agent/agent-turn-callbacks.js';
import { normalizeMessageError } from '../src/sidepanel/features/messages/message-decorations.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function submissionFixture({ agentMode = false, configure = async () => true } = {}) {
  const state = {
    conversation: { id: 'conversation', messages: [] }, ready: true,
    attachments: [], messageQueue: [], selectedEffort: 'default', disablePageContext: true,
  };
  let mode = agentMode;
  let nextId = 0;
  const input = { value: '' };
  const modelRequests = [];
  const starts = [];
  const errors = [];
  const noop = () => {};
  const context = createConversationServiceFixture({
    state, input,
    chrome: {
      tabs: { query: async () => [{ id: 1, url: 'https://page.test' }] },
      runtime: { sendMessage: async message => ({ tabId: message.tabId, url: message.expectedUrl, documentId: 'document-at-click' }) },
    },
    agentSlot: {
      isMode: () => mode, isBusy: () => false,
      start: async (goal, options) => { starts.push({ goal, options }); return true; },
    },
    makeId: () => `message-${++nextId}`, now: () => '',
    ensureConversation: async () => state.conversation, ensureConfigured: configure,
    saveCurrent: async () => {},
    activeChatProfile: () => ({ id: 'test-model' }), conversationTitle: String,
    setAssistantPhase: (assistant, phase) => { if (assistant) assistant.requestPhase = phase; },
    getDirectoryInfo: async () => ({ granted: false }),
    renderContextChip: noop, hasVision: () => true,
    readCurrentPageForRequest: async () => { throw new Error('unexpected page read'); },
    generateReply: async assistant => {
      modelRequests.push(requestMessagesFor(state.conversation, assistant.id, state.conversation.pageContext));
      return 'Fixture model answer';
    },
    setPageSelection: selection => { state.pageSelection = selection; }, renderPageSelection: noop,
    truncateText: String, resizeInput: noop, renderAttachments: noop, updateComposer: noop,
    renderQueueBar: noop, renderConversation: noop, scheduleSave: noop,
    toast: message => errors.push(message),
  });
  return { state, input, modelRequests, starts, errors,
    setMode: value => { mode = value; }, send: context.sendMessage, processQueue: context.processQueue };
}

for (const initialMode of [false, true]) {
  test(`configuration waits preserve the submitted ${initialMode ? 'operation' : 'chat'} mode`, async () => {
    const configured = deferred();
    const value = submissionFixture({ agentMode: initialMode, configure: () => configured.promise });
    const pending = value.send('解释这个任务');
    await tick();
    value.setMode(!initialMode);
    configured.resolve(true);
    await pending;
    assert.deepEqual(value.errors, []);
    const user = value.state.conversation.messages.find(message => message.role === 'user');
    assert.equal(user.agentTask, initialMode);
    assert.equal(user.readingPolicy.scope, 'none');
    assert.equal(value.starts.length, Number(initialMode));
    assert.equal(value.modelRequests.length, Number(!initialMode));
    if (initialMode) assert.equal(value.starts[0].options.target.documentId, 'document-at-click');
  });
}

test('identical wording queued in chat and operation modes remains two distinct requests', async () => {
  const value = submissionFixture();
  value.state.generatingId = 'previous-response';
  await value.send('执行同一个目标');
  value.setMode(true);
  await value.send('执行同一个目标');
  assert.equal(value.state.messageQueue.length, 2);
  assert.deepEqual(Array.from(value.state.messageQueue, item => item.agentTask), [false, true]);
  value.state.generatingId = null;
  await value.processQueue();
  await tick();
  await tick();
  assert.equal(value.modelRequests.length, 1);
  assert.equal(value.starts.length, 1);
  assert.deepEqual(Array.from(value.state.conversation.messages.filter(item => item.role === 'user'), item => item.agentTask), [false, true]);
});

function queueBehindMatchingFailure({ switchMode = false, anotherPrompt = false } = {}) {
  const value = submissionFixture();
  const policy = readingPolicyForTurn({ question: '重复问题', pageContextEnabled: false });
  value.state.conversation.messages = [
    { id: 'prior-user', role: 'user', content: '重复问题', agentTask: false, pageContextEnabled: false, readingPolicy: policy },
    { id: 'prior-answer', role: 'assistant', content: '', status: 'streaming' },
  ];
  value.state.generatingId = 'prior-answer';
  return (async () => {
    await value.send('重复问题');
    if (anotherPrompt) await value.send('下一个问题');
    value.setMode(switchMode);
    value.state.conversation.messages[1].status = 'error';
    value.state.generatingId = null;
    await value.processQueue();
    await tick();
    await tick();
    return value;
  })();
}

test('a queued chat prompt survives a same-wording failure after the mode button changes', async () => {
  const value = await queueBehindMatchingFailure({ switchMode: true });
  assert.equal(value.modelRequests.length, 1, 'captured chat mode must still reach the model');
  assert.equal(value.starts.length, 0);
  assert.deepEqual(value.errors, ['已加入排队，将在当前回答完成后自动发送']);
});

test('a same-wording queued retry cannot discard later queued prompts', async () => {
  const value = await queueBehindMatchingFailure({ anotherPrompt: true });
  assert.equal(value.modelRequests.length, 2, 'both queued prompts must be dispatched');
  assert.ok(value.state.conversation.messages.some(message => message.role === 'user' && message.content === '下一个问题'));
});

test('scope none retry performs no read and never sends a stale page body', async () => {
  const state = { disablePageContext: true };
  let tabQueries = 0;
  const context = createConversationServiceFixture({
    state, readingPolicyForRetry,
    chrome: { tabs: { query: async () => { tabQueries += 1; return []; } } },
  });
  const question = {
    id: 'user', role: 'user', content: '你好', pageContextEnabled: true,
    readingPolicy: { version: 1, scope: 'none', intent: 'read', reason: 'small-talk' },
    pageSource: { url: 'https://page.test', unavailable: true },
  };
  assert.equal(await context.validateRetryPageTarget(question), null);
  assert.equal(question.pageContextEnabled, false);
  assert.equal(tabQueries, 0);
  const answer = { id: 'answer', role: 'assistant', content: '' };
  const page = { url: 'https://page.test', text: 'STALE_BODY_SHOULD_NOT_BE_SENT' };
  const messages = requestMessagesFor({ messages: [question, answer], pageContext: page }, answer.id, page);
  assert.doesNotMatch(JSON.stringify(messages), /STALE_BODY_SHOULD_NOT_BE_SENT/);
});

test('a legacy retry remains page-only while recorded operation and reading metadata stay out of model text', () => {
  assert.equal(readingPolicyForRetry({ pageContextEnabled: true, pageSource: { url: 'https://page.test' } }).scope, 'page');
  const question = {
    id: 'user', role: 'user', content: '普通内容', pageContextEnabled: false, agentTask: true,
    readingPolicy: { version: 1, scope: 'none', intent: 'read', reason: 'POLICY_METADATA_SENTINEL' },
    errorExpanded: true,
  };
  const answer = { id: 'answer', role: 'assistant', content: '' };
  const messages = requestMessagesFor({ messages: [question, answer] }, answer.id, null);
  assert.doesNotMatch(JSON.stringify(messages), /POLICY_METADATA_SENTINEL|agentTask|errorExpanded/);
});

test('Agent completion keeps the full result once and a separate compact failure reason', async () => {
  const message = { id: 'assistant', role: 'assistant', content: '', agent: { taskId: 'task' } };
  const reason = '未能打开目标章节。\n' + '详细诊断记录。'.repeat(100);
  const turn = { taskId: 'task', status: 'failed', result: reason, ...agentFailureForMessage(reason) };
  const conversation = { id: 'conversation', messages: [message] };
  const callbacks = createAgentTurnCallbacks({
    getConversation: () => conversation,
    ensureConversation: async () => conversation,
    render: () => {}, save: () => {},
  });
  await callbacks.end(turn);
  assert.equal(message.content, reason);
  assert.equal(message.errorMessage, '未能打开目标章节。');
  assert.equal(message.errorDetail, '');
  assert.equal(message.errorCode, 'AGENT_TASK_FAILED');
  const duplicate = normalizeMessageError({ ...message, errorMessage: reason, errorDetail: reason });
  assert.equal(duplicate.text, '浏览器任务未完成。');
  assert.equal(duplicate.detail, '');
});

test('storage round trips preserve operation mode, expanded errors, and the planned reading sources', async () => {
  const previousChrome = globalThis.chrome;
  const stored = {};
  globalThis.chrome = { storage: { local: {
    get: async key => ({ [key]: structuredClone(stored[key]) }),
    set: async value => Object.assign(stored, structuredClone(value)),
  } } };
  try {
    const readingPolicy = {
      version: 1, scope: 'auto', intent: 'read', reason: 'explicit-site-question',
      baseUrl: 'https://page.test', planned: true, selectedUrls: ['https://page.test/chapter20'],
    };
    const messages = [
      { id: 'reading', role: 'user', content: '找 MCP 章节并总结', agentTask: false, pageContextEnabled: true, readingPolicy },
      { id: 'operation', role: 'user', content: '打开 MCP 章节', agentTask: true, pageContextEnabled: false, readingPolicy: { version: 1, scope: 'none', intent: 'read' } },
      { id: 'failure', role: 'assistant', status: 'error', errorMessage: '执行失败。', errorDetail: '完整诊断。', errorExpanded: true, thinkingExpanded: false },
    ];
    await saveTemporaryConversation({ id: 'roundtrip', messages });
    const restored = await getTemporaryConversation();
    assert.deepEqual(restored.messages, messages);
    assert.deepEqual(readingPolicyForRetry(restored.messages[0]), readingPolicy);
    assert.equal(readingPolicyForRetry(restored.messages[1]).scope, 'none');
  } finally {
    globalThis.chrome = previousChrome;
  }
});

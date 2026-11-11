import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';
import { prepareAdaptiveReading } from '../src/sidepanel/features/page-reading/adaptive-reading.js';
import { createModelGateway } from '../src/app/model-gateway.js';
import { createChatService } from '../src/app/chat-service.js';

const target = { id: 7, tabId: 7, url: 'https://example.test/report', documentId: 'doc-report', title: 'Report' };
const page = { ...target, text: 'Verified report evidence. '.repeat(20) };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(t, ports = {}) {
  const calls = [];
  const value = createConversationServiceFixture({
    state: { disablePageContext: false, activePageSignal: target, readingMode: 'auto',
      networkReadingGrant: { origin: 'https://example.test', allowed: true },
      conversation: { id: 'adaptive-chat', messages: [] }, ...ports.state },
    browser: { queryActiveTab: async () => target, sendMessage: async () => target },
    readCurrentPageForRequest: async () => page,
    ...ports,
    enhancePageReading: async (query, options) => {
      calls.push({ query, options });
      return ports.enhancePageReading ? ports.enhancePageReading(query, options) : options.page;
    },
  });
  t.after(() => value.dispose());
  return { ...value, calls };
}

test('reading preparation uses the captured mode, history and frozen run before one main answer', async t => {
  const configured = deferred();
  const value = fixture(t, { ensureConfigured: () => configured.promise });
  value.state.conversation.messages.push({ id: 'old-q', role: 'user', content: '旧问题', pageSource: target });
  const pending = value.sendMessage('请核对报表的数据');
  value.state.readingMode = 'deep';
  value.state.networkReadingGrant.allowed = false;
  value.state.conversation.messages[0].content = '迟到修改';
  configured.resolve(true);
  await pending;
  assert.equal(value.calls.length, 1);
  const options = value.calls[0].options;
  assert.equal(options.mode, 'auto');
  assert.equal(options.allowNetwork, true);
  assert.equal(options.history[0].content, '旧问题');
  assert.equal(typeof options.modelRun.request, 'function');
  assert.equal(options.target.documentId, target.documentId);
  assert.deepEqual(options.cacheScope, { conversationId: 'adaptive-chat' });
  assert.equal(value.modelRequests.length, 1);
  assert.equal(value.state.conversation.messages.at(-2).readingOptions.mode, 'auto');
});

test('disabled page and independent questions do not enter supplemental reading', async t => {
  const value = fixture(t);
  value.state.disablePageContext = true;
  await value.sendMessage('认真一点，请深入读取');
  assert.equal(value.calls.length, 0);
  value.state.disablePageContext = false;
  await value.sendMessage('独立问题', { directModelRequest: true });
  assert.equal(value.calls.length, 0);
});

test('a visual evidence recommendation reaches the existing screenshot path before the answer', async t => {
  let captures = 0;
  const value = fixture(t, {
    enhancePageReading: async (_, options) => ({ ...options.page, readingAssessment: { visualRecommended: true } }),
    autoVisualAttachments: async (_, visualPage, signal, modelRun) => {
      captures++;
      assert.equal(visualPage.url, page.url);
      assert.equal(signal.aborted, false);
      assert.equal(typeof modelRun.request, 'function');
      return [];
    },
  });
  await value.sendMessage('比较这几条曲线的峰值');
  assert.equal(captures, 1);
  assert.equal(value.modelRequests.length, 1);
});

test('stopping supplemental reading rejects late work and permits a new unique answer', async t => {
  const held = deferred();
  let count = 0;
  const value = fixture(t, { enhancePageReading: async (_, options) => ++count === 1 ? held.promise : options.page });
  const first = value.sendMessage('第一次核验');
  await tick();
  assert.equal(value.calls.length, 1);
  value.stopActiveReply();
  await first;
  assert.equal(value.modelRequests.length, 0);
  assert.equal(value.calls[0].options.signal.aborted, true);
  await value.sendMessage('第二次核验');
  held.resolve({ ...page, text: 'LATE OLD BODY' });
  await tick();
  assert.equal(value.modelRequests.length, 1);
  assert.equal(value.state.conversation.messages.at(-1).status, 'complete');
  assert.notEqual(value.state.conversation.pageContext.text, 'LATE OLD BODY');
});

test('queue and retry retain original depth while legacy retries stay basic without network', async t => {
  const value = fixture(t);
  value.state.generatingId = 'busy';
  value.state.readingMode = 'deep';
  await value.sendMessage('读取这页');
  assert.equal(value.state.messageQueue[0].readingOptions.mode, 'deep');
  value.state.readingMode = 'basic';
  value.state.generatingId = null;
  await value.processQueue();
  await tick();
  assert.equal(value.calls[0].options.mode, 'deep');
  assert.deepEqual(value.calls[0].options.cacheScope, { conversationId: 'adaptive-chat' });
  const answerId = value.state.conversation.messages.at(-1).id;
  await value.regenerate(answerId);
  assert.equal(value.calls[1].options.mode, 'deep');
  assert.deepEqual(value.calls[1].options.cacheScope, { conversationId: 'adaptive-chat' });
  assert.equal(value.state.conversation.messages.filter(m => m.role === 'user').length, 1);
  delete value.state.conversation.messages[0].readingOptions;
  await value.regenerate(value.state.conversation.messages.at(-1).id);
  assert.equal(value.calls[2].options.mode, 'basic');
  assert.equal(value.calls[2].options.allowNetwork, false);
});

test('foreign or failed supplementation never writes or generates a second main reply', async t => {
  const value = fixture(t, { enhancePageReading: async () => ({ ...page, url: 'https://other.test/' }) });
  await value.sendMessage('读取报表');
  assert.equal(value.modelRequests.length, 0);
  assert.equal(value.state.conversation.messages.at(-1).status, 'error');
  assert.notEqual(value.state.conversation.pageContext?.url, 'https://other.test/');
});

test('a same-URL document replacement during supplementation cannot publish or start the answer', async t => {
  const value = fixture(t, { enhancePageReading: async () => ({ ...page, documentId: 'replacement-document' }) });
  await value.sendMessage('读取报表');
  assert.equal(value.calls.length, 1);
  assert.equal(value.modelRequests.length, 0);
  assert.equal(value.state.conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(value.state.conversation.messages.at(-1).status, 'error');
  assert.match(value.notices.join(' '), /页面.*变化/);
  assert.notEqual(value.state.conversation.pageContext?.documentId, 'replacement-document');
});

test('a different conversation rejects late supplement phases and content on both send and retry', async t => {
  for (const retry of [false, true]) {
    await t.test(retry ? 'retry' : 'send', async child => {
      const held = deferred();
      let count = 0;
      const value = fixture(child, { enhancePageReading: async (_, options) => {
        count += 1;
        return retry && count === 1 ? options.page : held.promise;
      } });
      if (retry) await value.sendMessage('读取报表');
      const previousAnswerCount = value.modelRequests.length;
      const pending = retry
        ? value.regenerate(value.state.conversation.messages.at(-1).id)
        : value.sendMessage('读取报表');
      await tick();
      const options = value.calls.at(-1).options;
      const other = { id: 'other-conversation', messages: [{ id: 'untouched', role: 'user', content: '新会话草稿' }],
        pageContext: { ...page, text: 'OTHER CONVERSATION BODY' } };
      const before = structuredClone(other);
      value.state.conversation = other;
      assert.deepEqual(options.cacheScope, { conversationId: 'adaptive-chat' }, 'the in-flight cache key stays with the submitted conversation');
      const progressCount = value.events.filter(event => event.type === 'progress').length;
      assert.throws(() => options.onPhase('reading-deep'), { name: 'AbortError' });
      held.resolve({ ...page, text: 'LATE PREVIOUS CONVERSATION BODY' });
      await pending;
      assert.equal(value.modelRequests.length, previousAnswerCount);
      assert.deepEqual(other, before);
      assert.equal(value.events.filter(event => event.type === 'progress').length, progressCount);
    });
  }
});

test('real adaptive reading, frozen Gateway and ChatService supplement before one streamed main reply', async t => {
  const decisionsStarted = deferred(), decisionResult = deferred();
  const transportCalls = [], deepReads = [], lifecycle = [];
  const mutableProfile = { id: 'fixed-profile', model: 'fixed-model', contextLength: 8192, maxTokens: 512 };
  const extraEvidence = 'DEEP_EVIDENCE: 缓存命中率字段为 cache_hit_ratio，当前值为 75%。';
  const gateway = createModelGateway({ transport: async ({ purpose, profile, request, onDelta }) => {
    transportCalls.push({ purpose, model: profile.model, request });
    assert.equal(Object.isFrozen(profile), true);
    if (purpose === 'reading-decision') {
      decisionsStarted.resolve();
      return decisionResult.promise;
    }
    if (purpose === 'answer') {
      assert.equal(deepReads.length, 1, 'the answer must wait for the evidence supplement');
      assert.match(JSON.stringify(request.messages), /DEEP_EVIDENCE/);
      onDelta('核实后的回答。', '核实后的回答。');
      return '核实后的回答。';
    }
    if (purpose === 'suggestions') return '[]';
    throw new Error(`Unexpected model purpose: ${purpose}`);
  } });
  let chat;
  const value = fixture(t, {
    modelGateway: gateway,
    profileFor: () => mutableProfile,
    replyService: { generate: options => chat.generate(options) },
    enhancePageReading: (query, options) => prepareAdaptiveReading(query, { ...options,
      readDeep: async request => {
        deepReads.push(request);
        assert.equal(request.target.expectedUrl, target.url);
        assert.equal(request.target.documentId, target.documentId);
        assert.equal(request.lazyLoad, false);
        return { ...page, text: `${page.text}\n${extraEvidence}`,
          semanticTree: [{ type: 'table', text: extraEvidence }],
          deepReading: { source: 'cdp', available: true, truncated: false } };
      },
    }),
  });
  chat = createChatService({ repository: value.repository, runner: value.runner, modelGateway: gateway });
  t.after(() => chat.dispose());
  const unsubscribe = value.runner.subscribe(event => lifecycle.push(event));
  t.after(unsubscribe);
  const query = '缓存命中率具体字段在哪里？';
  const pending = value.sendMessage(query);
  await decisionsStarted.promise;
  assert.equal(transportCalls.filter(call => call.purpose === 'answer').length, 0);
  await value.sendMessage(query); // A second click while deciding must not create another turn.
  mutableProfile.model = 'changed-after-submission';
  decisionResult.resolve('{"action":"deep","gap":"target"}');
  await pending;
  await tick();
  assert.equal(transportCalls.filter(call => call.purpose === 'reading-decision').length, 1);
  assert.equal(transportCalls.filter(call => call.purpose === 'answer').length, 1);
  assert.equal(deepReads.length, 1);
  assert.deepEqual(transportCalls.filter(call => ['reading-decision', 'answer'].includes(call.purpose)).map(call => call.model),
    ['fixed-model', 'fixed-model']);
  assert.equal(value.state.conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(value.state.conversation.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(value.state.conversation.messages.at(-1).status, 'complete');
  assert.equal(value.state.conversation.messages.at(-1).content, '核实后的回答。');
  assert.equal(value.state.conversation.pageContext.readingAssessment.addedEvidence, true);
  assert.equal(lifecycle.filter(event => event.type === 'terminal').length, 1);
  assert.ok(lifecycle.some(event => event.type === 'phase' && event.phase === 'checking-evidence'));
  assert.ok(lifecycle.some(event => event.type === 'phase' && event.phase === 'reading-deep'));
});

test('supplement permission refusal remains visible and never falls through to a model answer', async t => {
  const value = fixture(t, { enhancePageReading: async () => {
    throw new DOMException('当前站点接口读取权限被拒绝。', 'NotAllowedError');
  } });
  await value.sendMessage('读取接口返回的数据');
  assert.equal(value.modelRequests.length, 0);
  assert.equal(value.state.conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(value.state.conversation.messages.at(-1).status, 'error');
  assert.match(value.notices.join(' '), /权限被拒绝/);
  assert.equal(value.state.conversation.pageContext, undefined);
});

test('queued supplemental cache scope waits for its original conversation and never adopts the visible conversation', async t => {
  const value = fixture(t);
  const original = value.state.conversation;
  value.state.generatingId = original.id;
  await value.sendMessage('读取原会话的这份报表');
  assert.equal(value.state.messageQueue.length, 1);
  assert.equal(value.state.messageQueue[0].conversationId, original.id);
  value.state.generatingId = null;
  const other = { id: 'other-chat', messages: [], pageContext: { ...page, text: 'OTHER CACHED BODY' } };
  value.state.conversation = other;
  await value.processQueue();
  await tick();
  assert.equal(value.calls.length, 0);
  assert.equal(value.state.messageQueue.length, 1);
  value.state.conversation = original;
  await value.processQueue();
  await tick();
  assert.equal(value.calls.length, 1);
  assert.deepEqual(value.calls[0].options.cacheScope, { conversationId: original.id });
  assert.equal(value.calls[0].options.page.text, page.text.trim());
  assert.equal(value.modelRequests.length, 1);
  assert.deepEqual(other.messages, []);
  assert.equal(other.pageContext.text, 'OTHER CACHED BODY');
});

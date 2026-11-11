import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextService } from '../src/app/context-service.js';
import { createChatService } from '../src/app/chat-service.js';
import { createConversationRepository } from '../src/app/conversation-repository.js';
import { createTurnRunner } from '../src/app/turn-runner.js';
import { createModelGateway } from '../src/app/model-gateway.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const profile = { model: 'test-model', contextLength: 8192, maxTokens: 512 };

function history() {
  const messages = Array.from({ length: 10 }, (_, index) => ({ id: `history-${index}`,
    role: index % 2 ? 'assistant' : 'user', status: 'complete', content: `第${index}条已确认记录。`.repeat(350) }));
  messages.push({ id: 'current-user', role: 'user', status: 'complete', content: '继续回答当前问题。', pageContextEnabled: false },
    { id: 'current-answer', role: 'assistant', status: 'streaming', content: '' });
  return { id: 'conversation', messages };
}

function fixture({ gateway, request = async () => '保留用户目标与已确认事实的摘要。', save, getProfile = () => profile } = {}) {
  const state = {};
  const conversation = history();
  const events = [], saves = [], timers = new Map();
  let created = 0, disposed = 0, timerId = 0;
  const service = createContextService({ state, profileFor: getProfile,
    modelGateway: gateway || { createRun: () => { created += 1; return { request, dispose: () => { disposed += 1; } }; } },
    save: value => { saves.push(value); return save?.(value); },
    onEvent: event => events.push(event), createId: () => 'context',
    setTimer: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimer: id => timers.delete(id),
  });
  return { state, conversation, service, events, saves, timers, created: () => created, disposed: () => disposed,
    compress: options => service.compress(conversation, 'current-answer', { manual: true, ...options }) };
}

test('successful compression changes only the summary and reports save scheduling rather than durable success', async () => {
  const fx = fixture({ save: () => 77 });
  const before = structuredClone(fx.conversation.messages);
  assert.equal(await fx.compress(), true);
  assert.match(fx.conversation.contextSummary.text, /用户目标/);
  assert.deepEqual(fx.conversation.messages, before);
  assert.equal(fx.saves.length, 1);
  assert.equal(fx.events.find(event => event.persistence)?.persistence, 'requested');
  assert.equal(fx.events.some(event => /已保存|已落盘|已同步/.test(event.message || '')), false);
  assert.equal(fx.state.compressing, false);
  assert.equal(fx.state.compressionController, null);
  assert.equal(fx.disposed(), 1);
  assert.equal(fx.timers.size, 0);
});

test('optional request failure leaves the existing summary and main answer untouched', async () => {
  const fx = fixture({ request: async () => { throw new Error('Compression provider failed'); } });
  const previous = { text: 'Earlier summary', throughMessageId: 'history-0' };
  fx.conversation.contextSummary = previous;
  assert.equal(await fx.compress(), false);
  assert.equal(fx.conversation.contextSummary, previous);
  assert.equal(fx.saves.length, 0);
  assert.equal(fx.conversation.messages.at(-1).status, 'streaming');
  assert.match(fx.events.find(event => event.kind === 'error').message, /Compression provider failed/);
  assert.equal(fx.state.compressing, false);
});

test('a compression timeout stops waiting even when the supplied model run ignores cancellation', async () => {
  const late = deferred();
  let requestSignal;
  const fx = fixture();
  const pending = fx.compress({ modelRun: { request: options => { requestSignal = options.signal; return late.promise; } } });
  [...fx.timers.values()][0]();
  assert.equal(await pending, false);
  assert.equal(requestSignal.aborted, true);
  assert.equal(fx.timers.size, 0);
  assert.equal(fx.state.compressing, false);
  assert.match(fx.events.find(event => event.kind === 'error').message, /超时/);
  late.resolve('不能采用的迟到摘要');
  await tick();
  assert.equal(fx.conversation.contextSummary, undefined);
  assert.equal(fx.saves.length, 0);
});

test('parent cancellation propagates its exact reason instead of becoming an optional failure', async () => {
  const pendingModel = deferred();
  const fx = fixture({ request: () => pendingModel.promise });
  const parent = new AbortController();
  const reason = new DOMException('Parent run stopped', 'AbortError');
  const pending = fx.compress({ signal: parent.signal });
  parent.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(fx.state.compressing, false);
  assert.equal(fx.saves.length, 0);
  assert.equal(fx.timers.size, 0);
  fx.state.compressing = true;
  await assert.rejects(fx.compress({ signal: parent.signal }), error => error === reason);
});

test('an older request cannot commit a late summary or clear the newer controller in finally', async () => {
  const old = deferred(), next = deferred();
  let connections = 0;
  const fx = fixture({ gateway: { createRun: () => {
    const gate = ++connections === 1 ? old : next;
    return { request: () => gate.promise, dispose: () => {} };
  } } });
  const first = fx.compress();
  const firstController = fx.state.compressionController;
  fx.state.compressing = false; // Simulate ownership being replaced by a new app run.
  const second = fx.compress();
  const nextController = fx.state.compressionController;
  assert.notEqual(nextController, firstController);
  old.resolve('Stale summary');
  assert.equal(await first, false);
  assert.equal(fx.state.compressionController, nextController);
  assert.equal(fx.state.compressing, true);
  assert.equal(fx.conversation.contextSummary, undefined);
  next.resolve('Current summary');
  assert.equal(await second, true);
  assert.equal(fx.conversation.contextSummary.text, 'Current summary');
  assert.equal(fx.saves.length, 1);
});

test('createRun throwing still releases its timer and parent listener and emits a visible error', async () => {
  const parent = new AbortController();
  let added = 0, removed = 0;
  const add = parent.signal.addEventListener.bind(parent.signal);
  const remove = parent.signal.removeEventListener.bind(parent.signal);
  parent.signal.addEventListener = (...args) => { if (args[0] === 'abort') added++; return add(...args); };
  parent.signal.removeEventListener = (...args) => { if (args[0] === 'abort') removed++; return remove(...args); };
  const fx = fixture({ gateway: { createRun() { throw new Error('Gateway construction failed'); } } });
  assert.equal(await fx.compress({ signal: parent.signal }), false);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.equal(fx.timers.size, 0);
  assert.equal(fx.state.compressing, false);
  assert.equal(fx.state.compressionController, null);
  assert.match(fx.events.find(event => event.kind === 'error').message, /Gateway construction failed/);
});

test('invalid optional profile configuration is reported without allocating a model run', async () => {
  const fx = fixture({ getProfile: () => { throw new Error('Profile unavailable'); } });
  assert.equal(await fx.compress(), false);
  assert.equal(fx.created(), 0);
  assert.equal(fx.timers.size, 0);
  assert.match(fx.events.find(event => event.kind === 'error').message, /Profile unavailable/);
});

test('asynchronous save rejection is observed separately and cannot turn a usable summary into an answer failure', async () => {
  const saving = deferred();
  const fx = fixture({ save: () => saving.promise });
  assert.equal(await fx.compress(), true);
  assert.equal(fx.events.some(event => event.persistence === 'saved'), false);
  saving.reject(new Error('Save queue rejected'));
  await tick();
  assert.match(fx.events.find(event => event.kind === 'error').message, /保存未完成.*Save queue rejected/);
  assert.ok(fx.conversation.contextSummary.text);
  assert.equal(fx.conversation.messages.at(-1).status, 'streaming');
});

test('a synchronously failed save scheduler emits no misleading success receipt', async () => {
  const fx = fixture({ save: () => { throw new Error('Scheduler unavailable'); } });
  assert.equal(await fx.compress(), true, 'the summary was applied in memory, independently of storage');
  assert.equal(fx.events.some(event => event.persistence), false);
  assert.match(fx.events.find(event => event.kind === 'error').message, /保存未完成.*Scheduler unavailable/);
});

test('dispose cancels active work, ignores late completions and refuses future compression', async () => {
  const late = deferred();
  const fx = fixture({ request: () => late.promise });
  const pending = fx.compress();
  fx.service.dispose();
  const eventCount = fx.events.length;
  assert.equal(await pending, false);
  late.resolve('Late after disposal');
  await tick();
  assert.equal(await fx.compress(), false);
  assert.equal(fx.created(), 1);
  assert.equal(fx.saves.length, 0);
  assert.equal(fx.events.length, eventCount);
  assert.equal(fx.timers.size, 0);
});

for (const failure of ['request failure', 'timeout']) {
  test(`real chat still completes when optional compression has a ${failure}`, { timeout: 2000 }, async t => {
    const state = { conversation: history() };
    const calls = [];
    const repository = createConversationRepository({ getConversation: () => state.conversation,
      saver: { schedule() {}, save: async () => {} } });
    const runner = createTurnRunner({ repository });
    const modelGateway = createModelGateway({ transport: request => {
      calls.push(request.purpose);
      if (request.purpose === 'compression') {
        if (failure === 'request failure') throw new Error('Optional failure');
        return new Promise(() => {});
      }
      return request.purpose === 'suggestions' ? '[]' : '主回答正常完成。';
    } });
    const context = createContextService({ state, modelGateway, profileFor: () => profile, save: () => {}, timeoutMs: 10 });
    const chat = createChatService({ repository, runner, modelGateway, compress: context.compress });
    t.after(() => { context.dispose(); chat.dispose(); runner.dispose(); });
    const assistant = state.conversation.messages.at(-1);
    await chat.generate({ conversation: state.conversation, assistant, profile, contextWindow: 8192 });
    assert.ok(calls.includes('compression'));
    assert.equal(calls.filter(purpose => purpose === 'answer').length, 1);
    assert.equal(assistant.status, 'complete');
    assert.equal(assistant.content, '主回答正常完成。');
    assert.equal(state.compressing, false);
    assert.equal(runner.active(), null);
  });
}

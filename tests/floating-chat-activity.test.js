import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloatingChatActivity } from '../src/sidepanel/features/messages/floating-chat-activity.js';
import { createSelectionChatRuntime } from '../src/sidepanel/features/messages/selection-chat-runtime.js';
import { createModelGateway } from '../src/app/model-gateway.js';

function fixture(options = {}) {
  let visible = options.visible ?? false;
  const messages = new Map([['answer-a', { id: 'answer-a', role: 'assistant', status: 'complete', content: '完成的回答' }]]);
  const presenter = createFloatingChatActivity({ conversationId: 'chat-a',
    getMessage: options.getMessage || (id => messages.get(id)), isVisible: options.isVisible || (() => visible) });
  const event = (type, fields = {}) => ({ type: `run:${type}`, runId: 'run-a', conversationId: 'chat-a', assistantId: 'answer-a', ...fields });
  const start = (fields = {}) => {
    presenter.observe(event('started', { conversationId: null, assistantId: null, ...fields }));
    presenter.observe(event('bound', fields));
  };
  const complete = fields => presenter.observe(event('terminal', { status: 'completed', ...fields }));
  return { presenter, event, start, complete, messages, setVisible: value => { visible = value; } };
}

test('a fresh or merely reopened presentation has no activity or unread answer', () => {
  const fx = fixture();
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
  const before = fx.presenter.snapshot();
  fx.presenter.observe({ type: 'saved', conversationId: 'chat-a' });
  fx.presenter.observe({ type: 'conversation', conversationId: 'chat-a' });
  fx.presenter.observe({ type: 'reply-ended', assistantId: 'answer-a' });
  assert.deepEqual(fx.presenter.snapshot(), before);
  assert.equal(fx.presenter.acknowledge(), false);
});

test('only the active bound run drives preparation, thinking and answering', () => {
  const fx = fixture();
  fx.presenter.observe(fx.event('started', { conversationId: null, assistantId: null }));
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'preparing', unread: false });
  assert.equal(fx.presenter.observe(fx.event('phase', { phase: 'reasoning' })), false, 'not yet bound');
  fx.presenter.observe(fx.event('bound'));
  fx.presenter.observe(fx.event('phase', { phase: 'waiting-model' }));
  assert.equal(fx.presenter.snapshot().activity, 'preparing');
  fx.presenter.observe(fx.event('phase', { phase: 'reasoning' }));
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'thinking', unread: false });
  fx.presenter.observe(fx.event('message', { phase: 'answering' }));
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'answering', unread: false });
  fx.presenter.observe(fx.event('phase', { phase: 'web-research' }));
  assert.equal(fx.presenter.snapshot().activity, 'preparing');
  assert.equal(fx.presenter.observe(fx.event('phase', { phase: 'unknown' })), false);
  assert.equal(fx.presenter.observe(fx.event('phase', { phase: 'reasoning', assistantId: 'foreign-answer' })), false);
  assert.equal(fx.presenter.snapshot().activity, 'preparing');
});

test('a successful hidden answer becomes unread until the user views it', () => {
  const fx = fixture();
  fx.start();
  fx.complete();
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: true });
  const prior = fx.presenter.snapshot();
  assert.equal(fx.presenter.acknowledge(), true);
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
  assert.equal(prior.unread, true, 'snapshot does not mutate with the view');
  assert.ok(Object.isFrozen(prior));
  assert.equal(fx.presenter.acknowledge(), false);
});

test('completion seen in an expanded or expanding window never creates an unread badge', () => {
  const fx = fixture({ visible: true });
  fx.start();
  fx.complete();
  fx.setVisible(false);
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
  fx.presenter.observe(fx.event('terminal', { status: 'completed' }));
  assert.equal(fx.presenter.snapshot().unread, false);
});

test('hidden completion remains unread until explicitly acknowledged after expansion', () => {
  const fx = fixture();
  fx.start();
  fx.complete();
  fx.setVisible(true);
  fx.presenter.observe({ type: 'saved', conversationId: 'chat-a' });
  assert.equal(fx.presenter.snapshot().unread, true, 'an expanding window does not automatically acknowledge an earlier result');
  fx.setVisible(false);
  assert.equal(fx.presenter.snapshot().unread, true, 'reversing expansion keeps the unread result');
  fx.presenter.acknowledge();
  assert.equal(fx.presenter.snapshot().unread, false);
});

test('a fresh question clears old unread state while duplicate and superseded events stay inert', () => {
  const fx = fixture();
  fx.start(); fx.complete();
  assert.equal(fx.presenter.snapshot().unread, true);
  fx.start({ runId: 'run-b', assistantId: 'answer-b' });
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'preparing', unread: false });
  fx.presenter.observe(fx.event('phase', { phase: 'reasoning' }));
  fx.complete();
  fx.presenter.observe(fx.event('started'));
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'preparing', unread: false });
  fx.messages.set('answer-b', { id: 'answer-b', role: 'assistant', status: 'complete', content: '新的回答' });
  fx.complete({ runId: 'run-b', assistantId: 'answer-b' });
  assert.equal(fx.presenter.snapshot().unread, true);
  fx.presenter.acknowledge();
  fx.complete({ runId: 'run-b', assistantId: 'answer-b' });
  fx.start({ runId: 'run-b', assistantId: 'answer-b' });
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
});

test('foreign conversations and mismatched terminals cannot claim the fixed presentation', () => {
  const fx = fixture();
  assert.equal(fx.presenter.observe(fx.event('started', { conversationId: 'foreign' })), false);
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
  fx.start();
  assert.equal(fx.complete({ conversationId: 'foreign' }), false);
  assert.equal(fx.complete({ assistantId: 'foreign-answer' }), false);
  assert.equal(fx.complete({ runId: 'foreign-run' }), false);
  assert.equal(fx.complete({ status: 'running' }), false);
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'preparing', unread: false });
  fx.complete();
  assert.equal(fx.presenter.snapshot().unread, true);
  fx.presenter.acknowledge();
  fx.presenter.observe(fx.event('started', { runId: 'candidate', conversationId: null }));
  fx.presenter.observe(fx.event('bound', { runId: 'candidate', conversationId: 'foreign' }));
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
});

test('failed and cancelled runs end the animation without claiming a new completed answer', () => {
  for (const status of ['failed', 'cancelled']) {
    const fx = fixture();
    fx.start();
    fx.presenter.observe(fx.event('phase', { phase: 'reasoning' }));
    fx.presenter.observe(fx.event('terminal', { status }));
    assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
    fx.complete();
    assert.equal(fx.presenter.snapshot().unread, false, 'late success cannot reopen a stopped or failed run');
  }
});

test('an unbound run can settle without leaving preparation active or inventing an unread answer', () => {
  for (const status of ['failed', 'cancelled', 'completed']) {
    const fx = fixture();
    fx.presenter.observe(fx.event('started', { conversationId: null, assistantId: null }));
    assert.equal(fx.presenter.observe(fx.event('terminal', { conversationId: 'foreign', assistantId: null, status })), false);
    assert.equal(fx.presenter.snapshot().activity, 'preparing');
    assert.equal(fx.presenter.observe(fx.event('terminal', { conversationId: null, assistantId: null, status })), true);
    assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
    assert.equal(fx.presenter.observe(fx.event('bound')), false);
    assert.equal(fx.presenter.observe(fx.event('phase', { phase: 'reasoning' })), false);
    assert.equal(fx.complete(), false);
    fx.start({ runId: 'run-b', assistantId: 'answer-b' });
    assert.deepEqual(fx.presenter.snapshot(), { activity: 'preparing', unread: false });
  }
});

test('only a nonempty complete assistant message can create a new unread answer', () => {
  for (const message of [null, { id: 'foreign', role: 'assistant', status: 'complete', content: '正文' },
    { id: 'answer-a', role: 'user', status: 'complete', content: '正文' },
    { id: 'answer-a', role: 'assistant', status: 'streaming', content: '正文' },
    { id: 'answer-a', role: 'assistant', status: 'error', content: '部分正文' },
    { id: 'answer-a', role: 'assistant', status: 'complete', content: '  ', reasoning: '只有思考' }]) {
    const fx = fixture({ getMessage: () => message });
    fx.start(); fx.complete();
    assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
  }
});

test('optional decoration, save completion and invalid events never change unread or activity', () => {
  const fx = fixture();
  fx.start(); fx.complete(); fx.presenter.acknowledge();
  for (const type of ['saved', 'conversation', 'notice', 'composer', 'draft', 'reply-ended', 'selection-updated', 'run:persistence-error']) {
    assert.equal(fx.presenter.observe({ type, conversationId: 'chat-a', runId: 'run-a', assistantId: 'answer-a', status: 'completed' }), false);
  }
  for (const event of [null, {}, fx.event('started', { runId: null }), fx.event('started', { runId: '' })]) {
    assert.equal(fx.presenter.observe(event), false);
  }
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
});

test('failed observation callbacks and disposal cannot leave running or unread state behind', () => {
  for (const callbacks of [{ getMessage: () => { throw new Error('message unavailable'); } },
    { isVisible: () => { throw new Error('view unavailable'); } }]) {
    const fx = fixture(callbacks);
    fx.start();
    assert.doesNotThrow(() => fx.complete());
    assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
  }
  const fx = fixture();
  fx.start(); fx.complete();
  fx.presenter.dispose();
  assert.deepEqual(fx.presenter.snapshot(), { activity: 'idle', unread: false });
  assert.equal(fx.presenter.observe(fx.event('started', { runId: 'new' })), false);
  assert.equal(fx.presenter.acknowledge(), false);
});

test('the real floating runtime exposes thinking, answering and exactly one successful unread terminal', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  let ids = 0;
  const gateway = createModelGateway({ transport: async request => {
    if (request.purpose === 'suggestions') return '[]';
    request.onReasoning('结合原文思考', '结合原文思考');
    reached();
    await gate;
    request.onDelta('完整正文', '完整正文');
    return '完整正文';
  } });
  const runtime = createSelectionChatRuntime({ selection: { source: 'conversation', sourceVersion: 1,
    conversationId: 'original', messageId: 'original-answer', role: 'assistant', text: '原文', context: '相关语境', question: '原问题' },
    makeId: () => `activity-real-${++ids}`, getConfig: () => ({ models: [{ id: 'model' }], webSearchEnabled: false }),
    getProfile: () => ({ model: 'model', endpointUrl: 'https://local-fixture.invalid/v1', contextLength: 16000, maxTokens: 256, webSearchEnabled: false }),
    modelGateway: gateway, writeConversation: async conversation => ({ ...structuredClone(conversation), syncStatus: 'pending' }),
    loadConversation: async () => null });
  const states = [], terminals = [];
  const presenter = createFloatingChatActivity({ conversationId: runtime.state.conversation.id,
    getMessage: id => runtime.state.conversation.messages.find(message => message.id === id), isVisible: () => false });
  const unsubscribe = runtime.subscribe(event => {
    presenter.observe(event);
    states.push({ event: event.type, ...presenter.snapshot() });
    if (event.type === 'run:terminal') terminals.push(event);
  });
  t.after(async () => { release(); unsubscribe(); presenter.dispose(); runtime.close(); await runtime.flush().catch(() => {}); });
  const send = runtime.send('解释原文');
  await started;
  assert.deepEqual(presenter.snapshot(), { activity: 'thinking', unread: false });
  release();
  await send;
  assert.ok(states.some(state => state.activity === 'answering' && !state.unread));
  assert.deepEqual(presenter.snapshot(), { activity: 'idle', unread: true });
  assert.equal(terminals.length, 1);
  presenter.acknowledge();
  await runtime.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(presenter.snapshot(), { activity: 'idle', unread: false }, 'late save and suggestions do not relight the badge');
  presenter.observe(terminals[0]);
  assert.equal(presenter.snapshot().unread, false);
});

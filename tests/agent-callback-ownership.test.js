import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTurnCallbacks } from '../src/sidepanel/features/agent/agent-turn-callbacks.js';

function fixture(ensure) {
  const state = { conversation: { id: 'conversation-a', title: 'Test', messages: [] } };
  const saves = [];
  const renders = [];
  let counter = 0;
  const callbacks = createAgentTurnCallbacks({
    getConversation: () => state.conversation,
    ensureConversation: ensure || (async () => state.conversation),
    createId: () => `answer-${++counter}`,
    render: options => renders.push(options),
    save: (conversation, message) => {
      saves.push({ conversation, message });
      return new Promise(() => {});
    },
  });
  return { state, callbacks, renders, saves };
}

test('diagnostic ownership is read only and stays bound when the visible conversation changes', async () => {
  const { callbacks, state } = fixture();
  assert.deepEqual(callbacks.getDiagnosticContext('unknown'), {});
  const message = await callbacks.begin({ taskId: 'task-a', goal: 'secret goal', status: 'running' });
  state.conversation = { id: 'conversation-b', messages: [] };
  assert.deepEqual(callbacks.getDiagnosticContext('task-a'), { conversationId: 'conversation-a', turnId: message.id });
  const copy = callbacks.getDiagnosticContext('task-a');
  copy.conversationId = 'mutated';
  assert.equal(callbacks.getDiagnosticContext('task-a').conversationId, 'conversation-a');
  assert.equal(state.conversation.messages.length, 0);
});

test('a late agent callback updates its own task without overwriting the new task', async () => {
  const { state, callbacks, renders } = fixture();
  state.conversation.messages = [
    { id: 'old', role: 'assistant', status: 'streaming', agent: { taskId: 'old-task', status: 'running' } },
    { id: 'new', role: 'assistant', status: 'streaming', content: '', agent: { taskId: 'new-task', status: 'running' } },
  ];
  await callbacks.end({ taskId: 'old-task', status: 'cancelled', result: 'Old task stopped' });
  assert.equal(state.conversation.messages[0].status, 'stopped');
  assert.equal(state.conversation.messages[1].agent.taskId, 'new-task');
  assert.equal(state.conversation.messages[1].status, 'streaming');
  assert.equal(state.conversation.messages[1].content, '');
  assert.equal(renders.at(-1).scroll, false);
  await callbacks.update({ taskId: 'old-task', status: 'running', steps: [] });
  assert.equal(state.conversation.messages[0].agent.status, 'cancelled');
});

test('agent UI callbacks do not wait for disk writes to finish', async () => {
  const { callbacks, state, saves } = fixture();
  await callbacks.begin({ taskId: 'task', goal: 'Read chapter', status: 'running' });
  await callbacks.update({ taskId: 'task', status: 'running', steps: [] });
  await callbacks.end({ taskId: 'task', status: 'failed', result: 'Page read timed out' });
  assert.equal(state.conversation.messages[0].status, 'error');
  assert.equal(saves.length, 3);
});

test('cancelled begin callback cannot insert a late task message', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { callbacks, state } = fixture(() => waiting);
  const controller = new AbortController();
  const pending = callbacks.begin({ taskId: 'old-task' }, { signal: controller.signal });
  controller.abort();
  release(state.conversation);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(state.conversation.messages.length, 0);
});

test('switching conversations keeps the final answer and save attached to its original owner', async () => {
  const { callbacks, state, saves, renders } = fixture();
  const original = state.conversation;
  await callbacks.begin({ taskId: 'task-a', goal: 'Read A', status: 'running' });
  state.conversation = { id: 'conversation-b', messages: [] };
  const renderCount = renders.length;
  await callbacks.end({ taskId: 'task-a', status: 'finished', result: 'Answer for A' });
  assert.equal(original.messages[0].content, 'Answer for A');
  assert.equal(original.messages[0].status, 'complete');
  assert.equal(state.conversation.messages.length, 0);
  assert.equal(saves.at(-1).conversation, original);
  assert.equal(renders.length, renderCount);
});

test('returning to a reloaded object of the same conversation updates that object', async () => {
  const { callbacks, state, saves } = fixture();
  await callbacks.begin({ taskId: 'task-a', goal: 'Read A' });
  const reloaded = structuredClone(state.conversation);
  reloaded.title = 'New title';
  reloaded.messages.push({ id: 'another', role: 'user', content: 'Keep me' });
  state.conversation = reloaded;
  await callbacks.end({ taskId: 'task-a', status: 'finished', result: 'Final A' });
  assert.equal(reloaded.messages[0].content, 'Final A');
  assert.equal(saves.at(-1).conversation, reloaded);
  assert.equal(reloaded.title, 'New title');
  assert.equal(reloaded.messages.at(-1).content, 'Keep me');
});

test('terminal progress does not consume the final answer and duplicate final callbacks are ignored', async () => {
  const { callbacks, state, saves } = fixture();
  await callbacks.begin({ taskId: 'task-a', goal: 'Read A' });
  await callbacks.update({ taskId: 'task-a', status: 'finished', steps: [{ title: 'Done' }] });
  assert.equal(state.conversation.messages[0].status, 'streaming');
  await callbacks.end({ taskId: 'task-a', status: 'finished', result: 'First final answer' });
  const saveCount = saves.length;
  await callbacks.end({ taskId: 'task-a', status: 'failed', result: 'Late replacement' });
  await callbacks.update({ taskId: 'task-a', status: 'running', steps: [] });
  assert.equal(state.conversation.messages[0].content, 'First final answer');
  assert.equal(state.conversation.messages[0].status, 'complete');
  assert.equal(saves.length, saveCount);
});

test('unknown restored checkpoints never create or alter messages in the current conversation', async () => {
  const { callbacks, state, saves } = fixture();
  await callbacks.begin({ taskId: 'current-task', goal: 'Current' });
  const before = structuredClone(state.conversation);
  const count = saves.length;
  assert.equal(await callbacks.restore({ taskId: 'unknown-checkpoint' }), null);
  assert.equal(await callbacks.end({ taskId: 'unknown-checkpoint', status: 'finished', result: 'Old' }), null);
  assert.deepEqual(state.conversation, before);
  assert.equal(saves.length, count);
});

test('restoring a matching checkpoint binds the existing message for later conversation switches', async () => {
  const { callbacks, state } = fixture();
  const original = state.conversation;
  original.messages.push({ id: 'restored-message', role: 'assistant', content: '', status: 'stopped',
    agent: { taskId: 'restored-task', status: 'running', steps: [] } });
  await callbacks.restore({ taskId: 'restored-task' });
  assert.equal(original.messages[0].agent.status, 'paused');
  state.conversation = { id: 'other', messages: [] };
  await callbacks.end({ taskId: 'restored-task', status: 'finished', result: 'Restored result' });
  assert.equal(original.messages[0].content, 'Restored result');
});

test('a deleted timeline message is not recreated by a late final callback', async () => {
  const { callbacks, state, saves } = fixture();
  await callbacks.begin({ taskId: 'task', goal: 'Read' });
  state.conversation.messages = [];
  const count = saves.length;
  assert.equal(await callbacks.end({ taskId: 'task', status: 'finished', result: 'Late' }), null);
  assert.equal(state.conversation.messages.length, 0);
  assert.equal(saves.length, count);
});

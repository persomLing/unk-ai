import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureAgentTurnMessage } from '../src/utils/agent-conversation.js';

test('the same agent task creates exactly one assistant turn', () => {
  const messages = [{ id: 'user-1', role: 'user', content: '整理网传消息' }];
  const first = ensureAgentTurnMessage(messages, { taskId: 'task-1', goal: '整理网传消息' }, () => 'assistant-1');
  const second = ensureAgentTurnMessage(messages, { taskId: 'task-1', goal: '整理网传消息' }, () => 'assistant-2');
  assert.equal(first, second);
  assert.equal(messages.filter((message) => message.agent?.taskId === 'task-1').length, 1);
});

test('different agent tasks still create separate turns', () => {
  const messages = [];
  ensureAgentTurnMessage(messages, { taskId: 'task-1', goal: '任务一' }, () => 'assistant-1');
  ensureAgentTurnMessage(messages, { taskId: 'task-2', goal: '任务二' }, () => 'assistant-2');
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 2);
});

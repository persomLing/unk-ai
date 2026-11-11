import test from 'node:test';
import assert from 'node:assert/strict';
import { sendFingerprint, isDuplicateSend } from '../src/sidepanel/features/messages/send-guard.js';
import { stoppedReplyForPrompt, normalizeDuplicateRetryTurns } from '../src/sidepanel/features/messages/retry-flow.js';
import { agentFailureForMessage } from '../src/utils/agent-conversation.js';

test('identical prompts in chat and operation mode remain separate submissions', () => {
  const common = { text: '找到mcp章节并总结一下', pageContextEnabled: false };
  const chat = sendFingerprint({ ...common, agentTask: false });
  const operation = sendFingerprint({ ...common, agentTask: true });
  assert.equal(isDuplicateSend({ fingerprint: operation, lastFingerprint: chat, lastSentAt: 100, now: 110 }), false);
  assert.equal(isDuplicateSend({ fingerprint: operation, lastFingerprint: operation, lastSentAt: 100, now: 110 }), true);
  const context = { pageContextEnabled: false, selection: null, attachments: [] };
  const question = { role: 'user', content: common.text, ...context };
  const answer = { role: 'assistant', status: 'error' };
  assert.equal(stoppedReplyForPrompt([question, answer], common.text, { ...context, agentTask: true }), null);
  assert.equal(normalizeDuplicateRetryTurns([question, answer, { ...question, agentTask: true }]).length, 3);
});

test('reading policies preserve retry scope and chosen sources', () => {
  const question = { role: 'user', content: '找MCP章节', pageContextEnabled: true,
    readingPolicy: { version: 1, scope: 'auto', planned: true, selectedUrls: ['https://a.test/20'] } };
  const answer = { role: 'assistant', status: 'stopped' };
  assert.equal(stoppedReplyForPrompt([question, answer], question.content, { ...question }), answer);
  assert.equal(stoppedReplyForPrompt([question, answer], question.content, { ...question, readingPolicy: undefined }), null);
  assert.equal(stoppedReplyForPrompt([question, answer], question.content, { ...question,
    readingPolicy: { ...question.readingPolicy, selectedUrls: ['https://a.test/21'] } }), null);
});

test('failure metadata retains a short reason instead of the whole answer', () => {
  const reason = '未能打开第20章，已停止重复操作。\n\n' + '当前只读到了概述。'.repeat(100);
  const error = agentFailureForMessage(reason);
  assert.equal(error.errorMessage, '未能打开第20章，已停止重复操作。');
  assert.equal(error.errorDetail, undefined);
  assert.equal(error.errorCode, 'AGENT_TASK_FAILED');
  assert.ok(agentFailureForMessage('长'.repeat(900)).errorMessage.length <= 180);
});

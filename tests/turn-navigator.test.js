import test from 'node:test';
import assert from 'node:assert/strict';
import {
  originalQuestionFor,
  previewTextFor,
  turnsForConversation,
} from '../src/sidepanel/features/messages/turn-navigator.js';

const conversation = {
  id: 'conversation-1',
  messages: [
    { id: 'user-1', role: 'user', content: '问题一\n\n<selection_context>不应显示</selection_context>', displayContent: '问题一' },
    { id: 'assistant-1', role: 'assistant', content: '回答一', status: 'complete' },
    { id: 'user-2', role: 'user', content: '问题二', status: 'complete' },
    { id: 'assistant-2', role: 'assistant', content: '', reasoning: '思考中', status: 'streaming' },
    { id: 'user-3', role: 'user', content: '问题三', status: 'complete' },
  ],
};

test('turns pair each original question with the following assistant reply', () => {
  const turns = turnsForConversation(conversation);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map(turn => [turn.userId, turn.assistantId]), [
    ['user-1', 'assistant-1'],
    ['user-2', 'assistant-2'],
    ['user-3', null],
  ]);
  assert.equal(turns[0].question, '问题一');
  assert.equal(turns[0].answer, '回答一');
  assert.equal(turns[1].answer, '正在深度思考…');
  assert.equal(turns[2].answer, '等待回答…');
});

test('displayContent is the original question and content fallback stays single-line', () => {
  assert.equal(originalQuestionFor({ content: '发送内容', displayContent: '  原始提问  ' }), '原始提问');
  assert.equal(originalQuestionFor({ content: '第一行\n第二行' }), '第一行 第二行');
  assert.equal(originalQuestionFor(null), '');
});

test('assistant previews handle error, stop and long answers without markup', () => {
  assert.equal(previewTextFor({ status: 'error', errorMessage: '请求超时' }), '请求超时');
  assert.equal(previewTextFor({ status: 'stopped' }), '回答已停止。');
  const preview = previewTextFor({ content: ` **标题** ${'内容'.repeat(200)}` });
  assert.match(preview, /^\*\*标题\*\* /);
  assert.match(preview, /…$/);
  assert.ok(preview.length <= 221);
});

test('malformed conversations do not invent turns', () => {
  assert.deepEqual(turnsForConversation(null), []);
  assert.deepEqual(turnsForConversation({ id: 'x', messages: null }), []);
  const orphanOnly = turnsForConversation({ id: 'x', messages: [{ role: 'assistant', content: '孤立回答' }] });
  assert.deepEqual(orphanOnly, []);
});

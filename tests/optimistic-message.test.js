import test from 'node:test';
import assert from 'node:assert/strict';

function snapshotForStorage(conversation) {
  return {
    ...conversation,
    messages: (conversation.messages || []).filter((message) => !message.optimistic),
  };
}

test('optimistic messages render immediately but are excluded from preflight persistence', () => {
  const conversation = {
    id: 'c1',
    messages: [
      { id: 'u0', role: 'user', content: 'old' },
      { id: 'u1', role: 'user', content: '为什么要向量化', optimistic: true },
      { id: 'a1', role: 'assistant', content: '', status: 'streaming', optimistic: true },
    ],
  };
  const saved = snapshotForStorage(conversation);
  assert.equal(conversation.messages.length, 3);
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].content, 'old');
});

test('removing optimistic markers makes the completed turn persistable', () => {
  const conversation = {
    messages: [{ id: 'u1', role: 'user', content: '问题', optimistic: true }],
  };
  delete conversation.messages[0].optimistic;
  assert.equal(snapshotForStorage(conversation).messages.length, 1);
});

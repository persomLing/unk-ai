import test from 'node:test';
import assert from 'node:assert/strict';

import {
  liveReplyState,
  settleInterruptedReply,
} from '../src/sidepanel/features/messages/reply-state.js';

test('a stale streaming message without an active controller is not a live reply', () => {
  assert.equal(liveReplyState({
    generatingId: 'c1',
    conversationId: 'c1',
    assistant: { status: 'streaming' },
    signal: null,
  }), false);
  assert.equal(liveReplyState({
    generatingId: 'c1',
    conversationId: 'c2',
    assistant: { status: 'streaming' },
    signal: { aborted: false },
  }), false);
  assert.equal(liveReplyState({
    generatingId: 'c1',
    conversationId: 'c1',
    assistant: { status: 'streaming' },
    signal: { aborted: false },
  }), true);
});

test('interrupted streaming is settled so send controls can be restored', () => {
  const assistant = { status: 'streaming', reasoningStartedAt: 1 };
  assert.equal(settleInterruptedReply(assistant, { aborted: true }), true);
  assert.equal(assistant.status, 'stopped');
  assert.equal('reasoningStartedAt' in assistant, false);
  assert.equal(settleInterruptedReply(assistant), false);
});

test('settling a reply clears stale timing even when its status already completed', () => {
  const assistant = { status: 'complete', reasoningStartedAt: 1, reasoningFinishedAt: 2 };
  assert.equal(settleInterruptedReply(assistant, { aborted: true }), false);
  assert.equal('reasoningStartedAt' in assistant, false);
  assert.equal('reasoningFinishedAt' in assistant, false);
});


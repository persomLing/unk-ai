import test from 'node:test';
import assert from 'node:assert/strict';
import { thinkingPresentation } from '../src/sidepanel/features/messages/thinking-view.js';

test('a manually closed thinking row stays closed while reasoning deltas continue', () => {
  const message = {
    status: 'streaming',
    reasoning: '先核对来源。',
    content: '',
    userToggledThinking: true,
    thinkingExpanded: false,
    reasoningStartedAt: 1_000,
  };
  const first = thinkingPresentation(message, 4_200);
  assert.equal(first.visible, true);
  assert.equal(first.active, true);
  assert.equal(first.expanded, false);
  assert.match(first.label, /正在深度思考 3 秒/);

  message.reasoning += '再比较时间。';
  const updated = thinkingPresentation(message, 5_000);
  assert.equal(updated.expanded, false, 'stream updates must not override a manual collapse');
  assert.equal(updated.active, true);
});

test('thinking settles when answer text begins and does not invent a duration', () => {
  const message = { status: 'streaming', reasoning: '思考完成。', content: '开始回答。' };
  const presentation = thinkingPresentation(message, 9_000);
  assert.equal(presentation.active, false);
  assert.equal(presentation.settle, true);
  assert.equal(presentation.expanded, false);
  assert.equal(presentation.label, '已深度思考');
});

test('an empty or completed message has no live thinking presentation', () => {
  assert.equal(thinkingPresentation({ status: 'streaming', reasoning: '' }).visible, false);
  const completed = thinkingPresentation({ status: 'complete', reasoning: '步骤', reasoningSeconds: 2 });
  assert.equal(completed.visible, true);
  assert.equal(completed.active, false);
  assert.equal(completed.label, '已深度思考（用时 2 秒）');
});

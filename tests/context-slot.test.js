import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compressionEndpoint,
  compressionHeaders,
  compressionRequestBody,
  compressionTranscript,
  mergeContextSummary,
  summaryFromPayload,
} from '../src/sidepanel/features/context/context-slot.js';

test('context slot builds a bounded compression request', () => {
  const request = compressionRequestBody({ model: 'm', maxTokens: 64000 }, '用户：目标');
  assert.equal(request.model, 'm');
  assert.equal(request.max_tokens, 4000);
  assert.equal(request.stream, false);
  assert.match(request.messages[0].content, /压缩/);
});

test('context slot normalizes endpoints and auth headers', () => {
  assert.equal(
    compressionEndpoint({ endpointUrl: 'https://example.test/v1/chat/completions' }),
    'https://example.test/v1/chat/completions',
  );
  assert.equal(compressionHeaders({ apiKey: 'secret' }).Authorization, 'Bearer secret');
  assert.equal(compressionHeaders({ apiKey: '' }).Authorization, undefined);
});

test('context slot extracts summaries and keeps previous counters', () => {
  assert.equal(summaryFromPayload({ choices: [{ message: { content: '摘要' } }] }), '摘要');
  assert.equal(summaryFromPayload({ choices: [{ message: { content: [{ text: '摘' }, { text: '要' }] } }] }), '摘要');
  assert.throws(() => summaryFromPayload({}), /没有返回/);
  const summary = mergeContextSummary(
    { originalMessageCount: 2 },
    [{ id: 'a' }, { id: 'b' }],
    { used: 100, total: 200 },
    'now',
  );
  assert.equal(summary.originalMessageCount, 4);
  assert.equal(summary.throughMessageId, 'b');
  assert.equal(summary.tokensBefore, 100);
  assert.equal(compressionTranscript([{ role: 'assistant', content: '回答' }]), '助手：回答');
});

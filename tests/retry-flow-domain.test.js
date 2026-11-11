import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesForRetry, normalizeDuplicateRetryTurns, samePrompt, sameTurnContext, stoppedReplyForPrompt } from '../src/sidepanel/features/messages/retry-flow.js';

test('retry folds consecutive stopped copies of the same prompt into one turn', () => {
  const messages = [
    { id: 'u1', role: 'user', content: '看看今天 A 股' },
    { id: 'a1', role: 'assistant', content: '', status: 'stopped' },
    { id: 'u2', role: 'user', content: '看看今天 A 股' },
    { id: 'a2', role: 'assistant', content: '', status: 'stopped' },
  ];
  const replacement = { id: 'a3', role: 'assistant', content: '', status: 'streaming' };
  assert.deepEqual(messagesForRetry(messages, 'a2', replacement), [messages[0], replacement]);
});

test('retry preserves earlier distinct turns', () => {
  const earlier = [{ id: 'u0', role: 'user', content: '之前的问题' }, { id: 'a0', role: 'assistant', content: '回答', status: 'complete' }];
  const question = { id: 'u1', role: 'user', content: '当前问题' };
  const stopped = { id: 'a1', role: 'assistant', content: '', status: 'stopped' };
  const replacement = { id: 'a2', role: 'assistant', content: '', status: 'streaming' };
  assert.deepEqual(messagesForRetry([...earlier, question, stopped], 'a1', replacement), [...earlier, question, replacement]);
});

test('samePrompt normalizes whitespace and detects a repeated prompt', () => {
  assert.equal(samePrompt('  看看今天 A 股\n市场表现 ', '看看今天 A 股 市场表现'), true);
  assert.equal(samePrompt('再解释一下原因', '看看今天 A 股市场表现'), false);
});

test('a repeated prompt after a stopped answer retries that answer', () => {
  const answer = { id: 'a1', role: 'assistant', status: 'stopped' };
  const messages = [{ id: 'u1', role: 'user', content: '看看今天 A 股' }, answer];
  assert.equal(stoppedReplyForPrompt(messages, '看看今天 A 股'), answer);
  assert.equal(stoppedReplyForPrompt(messages, '再分析市场风险'), null);
});

test('normalization removes old failed retry copies but keeps the latest response', () => {
  const question = { id: 'u1', role: 'user', content: '看看今天 A 股' };
  const latestQuestion = { id: 'u2', role: 'user', content: '看看今天 A 股' };
  const latestAnswer = { id: 'a2', role: 'assistant', content: '最新回答', status: 'complete' };
  assert.deepEqual(normalizeDuplicateRetryTurns([
    question,
    { id: 'a1', role: 'assistant', content: '', status: 'stopped' },
    latestQuestion,
    latestAnswer,
  ]), [question, latestAnswer]);
});

test('normalization keeps separate prompts and intentional selection turns', () => {
  const previousQuestion = { id: 'u1', role: 'user', content: '看看今天 A 股' };
  const selectedQuestion = { id: 'u2', role: 'user', content: '看看今天 A 股', selection: { text: 'A 股' } };
  const messages = [previousQuestion, { id: 'a1', role: 'assistant', status: 'stopped' }, selectedQuestion];
  assert.equal(normalizeDuplicateRetryTurns(messages).length, 3);
});

const pageContext = {
  pageSource: { url: 'https://a.test/article', capturedAt: '2026-10-30T01:00:00Z', documentId: 'doc-a', tabId: 1 },
  pageContextEnabled: true,
};

test('same turn context compares source snapshot, toggle, selection and attachments', () => {
  assert.equal(sameTurnContext({}, {}), true);
  assert.equal(sameTurnContext(pageContext, structuredClone(pageContext)), true);
  assert.equal(sameTurnContext(pageContext, { page: { ...pageContext.pageSource, documentId: undefined, docId: 'doc-a' }, pageContextEnabled: true }), true);
  const changes = [
    { ...pageContext, pageSource: { ...pageContext.pageSource, url: 'https://b.test/article' } },
    { ...pageContext, pageSource: { ...pageContext.pageSource, capturedAt: '2026-10-30T02:00:00Z' } },
    { ...pageContext, pageSource: { ...pageContext.pageSource, documentId: 'doc-b' } },
    { ...pageContext, pageSource: { ...pageContext.pageSource, tabId: 2 } },
    { ...pageContext, pageSource: { ...pageContext.pageSource, unavailable: true } },
    { ...pageContext, pageContextEnabled: false },
    { ...pageContext, pageContextEnabled: undefined },
    { ...pageContext, selection: { text: 'Selected text', url: 'https://a.test/article' } },
    { ...pageContext, attachments: [{ id: 'file-a', text: 'Content' }] },
    {},
  ];
  for (const changed of changes) assert.equal(sameTurnContext(pageContext, changed), false);
  assert.equal(sameTurnContext({ attachments: [{ id: 'file', text: 'A' }] }, { attachments: [{ text: 'B', id: 'file' }] }), false);
  assert.equal(sameTurnContext({ selection: { text: 'A', url: 'https://a.test' } }, { selection: { url: 'https://a.test', text: 'A' } }), true);
});

test('same wording on another page is preserved during normalization and explicit retry', () => {
  const variants = [
    { ...pageContext, pageSource: { ...pageContext.pageSource, url: 'https://b.test/article' } },
    { ...pageContext, pageSource: { ...pageContext.pageSource, capturedAt: 'later' } },
    { ...pageContext, pageSource: { ...pageContext.pageSource, documentId: 'new-document' } },
    { ...pageContext, pageSource: { ...pageContext.pageSource, unavailable: true } },
    { ...pageContext, pageContextEnabled: false },
    { ...pageContext, selection: { text: 'Other selected text' } },
    { ...pageContext, attachments: [{ id: 'file', text: 'New document' }] },
  ];
  for (const variant of variants) {
    const messages = [
      { id: 'u-a', role: 'user', content: '这个呢', ...pageContext },
      { id: 'a-a', role: 'assistant', status: 'stopped' },
      { id: 'u-b', role: 'user', content: '这个呢', ...variant },
      { id: 'a-b', role: 'assistant', status: 'error' },
    ];
    assert.deepEqual(normalizeDuplicateRetryTurns(messages), messages);
    const replacement = { id: 'replacement', role: 'assistant', status: 'streaming' };
    assert.deepEqual(messagesForRetry(messages, 'a-b', replacement), [...messages.slice(0, 3), replacement]);
  }
});

test('identical contextual retries still collapse while selection and attachment changes do not', () => {
  const context = { ...pageContext, selection: { text: 'A', context: 'Before A' }, attachments: [{ id: 'same-id', text: 'Document A' }] };
  const question = { id: 'u1', role: 'user', content: '这个呢', ...context };
  const retry = { id: 'u2', role: 'user', content: '这个呢', ...structuredClone(context) };
  const answer = { id: 'a2', role: 'assistant', status: 'complete' };
  const previous = { id: 'a1', role: 'assistant', status: 'error' };
  assert.deepEqual(normalizeDuplicateRetryTurns([question, previous, retry, answer]), [question, answer]);
  for (const changed of [
    { ...retry, selection: { text: 'B', context: 'Before A' } },
    { ...retry, attachments: [{ id: 'same-id', text: 'Document B' }] },
  ]) {
    assert.equal(normalizeDuplicateRetryTurns([question, previous, changed, answer]).length, 4);
    assert.deepEqual(messagesForRetry([question, previous, changed, answer], 'a2', answer), [question, previous, changed, answer]);
  }
});

test('automatic stopped-reply matching requires matching current page and toggle context', () => {
  const answer = { id: 'a1', role: 'assistant', status: 'stopped' };
  const messages = [{ id: 'u1', role: 'user', content: '这个呢', ...pageContext }, answer];
  assert.equal(stoppedReplyForPrompt(messages, '这个呢', pageContext), answer);
  assert.equal(stoppedReplyForPrompt(messages, '这个呢'), null);
  assert.equal(stoppedReplyForPrompt(messages, '这个呢', { ...pageContext, pageContextEnabled: false }), null);
  assert.equal(stoppedReplyForPrompt(messages, '这个呢', { ...pageContext, pageSource: { ...pageContext.pageSource, url: 'https://b.test/article' } }), null);
  assert.equal(stoppedReplyForPrompt(messages, '这个呢', { ...pageContext, pageSource: { url: 'https://a.test/article' } }), null);
  assert.equal(stoppedReplyForPrompt(messages, '这个呢', { ...pageContext, pageSource: { ...pageContext.pageSource, unavailable: true } }), null);
  assert.equal(stoppedReplyForPrompt(messages, '这个呢', { ...pageContext, attachments: [{ id: 'new-file' }] }), null);
  assert.equal(stoppedReplyForPrompt([{ role: 'user', content: '旧提问' }, answer], '旧提问'), answer);
});

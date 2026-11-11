import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a closed page switch holds queued research until enabled and retains the original scope', async () => {
  const target = { id: 7, url: 'https://page.test/chapter', documentId: 'queued-document' };
  const original = { id: 'queued', content: '找Agent章节', pageContextEnabled: true,
    readingPolicy: { version: 1, scope: 'page', intent: 'read' }, pageTargetPromise: Promise.resolve(target) };
  const state = { messageQueue: [original], disablePageContext: true };
  const reads = [];
  let queries = 0;
  const fixture = createConversationServiceFixture({ state,
    browser: { queryActiveTab: async () => { queries += 1; return { id: 99, url: 'https://other.test' }; }, sendMessage: async () => ({}) },
    readCurrentPageForRequest: async (question, options) => {
      reads.push({ question, options });
      return { ...target, tabId: target.id, title: 'Original chapter', text: 'The original Agent chapter contains a complete readable body.', capturedAt: 'now' };
    },
  });
  await fixture.processQueue();
  assert.equal(fixture.modelRequests.length, 0);
  assert.equal(reads.length, 0);
  assert.equal(state.messageQueue.length, 1);
  state.disablePageContext = false;
  await fixture.processQueue();
  await tick();
  assert.equal(fixture.modelRequests.length, 1, JSON.stringify(fixture.notices));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].options.target.id, 7);
  assert.equal(reads[0].options.target.documentId, 'queued-document');
  assert.equal(queries, 0, 'dispatch must reuse the target captured when queued');
  const question = state.conversation.messages.find(message => message.role === 'user');
  assert.equal(question.readingPolicy.scope, 'page');
  assert.equal(question.pageSource.url, target.url);
});

test('queued plain questions can run with page reading disabled', async () => {
  const fixture = createConversationServiceFixture({ state: {
    messageQueue: [{ id: 'plain', content: '你好', pageContextEnabled: false }], disablePageContext: true,
  }, readCurrentPageForRequest: async () => { throw new Error('Unexpected page read'); } });
  await fixture.processQueue();
  await tick();
  assert.equal(fixture.modelRequests.length, 1);
  assert.equal(fixture.state.conversation.messages[0].content, '你好');
  assert.equal(fixture.state.conversation.messages[0].pageContextEnabled, false);
  assert.equal(fixture.state.conversation.messages[1].status, 'complete');
});

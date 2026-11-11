import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';
import { requestMessagesFor } from '../src/utils/context.js';
import { readingPolicyForTurn, readingPolicyForRetry } from '../src/utils/reading-plan.js';
import { preparePageReading } from '../src/sidepanel/features/page-reading/site-research-slot.js';

const target = { id: 7, tabId: 7, url: 'https://ecs-buy.aliyun.com/ecs#/custom/prepay/cn-beijing',
  title: '阿里云 - 弹性计算', documentId: 'ecs-document' };
const page = { ...target, text: 'ECS_PAGE_BODY：地域北京、包年包月、2 vCPU、4 GiB 内存。'.repeat(8) };
const question = '不太懂这些配置啥的跟我讲一讲';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const reads = [], payloads = [];
  const state = { disablePageContext: false, activePageSignal: target,
    conversation: { id: 'page-mode-conversation', messages: [], pageContext: page }, ...options.state };
  const value = createConversationServiceFixture({ state,
    browser: { queryActiveTab: options.queryActiveTab || (async () => target), sendMessage: async () => target },
    readCurrentPageForRequest: async (query, request) => {
      reads.push({ query, request });
      return options.readPage ? options.readPage(query, request) : page;
    },
    generateReply: async assistant => {
      payloads.push(requestMessagesFor(state.conversation, assistant.id, state.conversation.pageContext));
      return '配置解释';
    },
  });
  t.after(() => value.service.dispose());
  return { ...value, reads, payloads };
}

test('an enabled page mode reads colloquial questions, small talk and attachments before answering', async t => {
  for (const [query, attachments] of [[question, []], ['你好', []], ['总结附件', [{ id: 'attachment', type: 'document', name: 'notes.txt', text: 'ATTACHMENT_BODY' }]]]) {
    await t.test(query, async child => {
      const value = fixture(child, { state: { attachments } });
      await value.sendMessage(query);
      assert.equal(value.reads.length, 1);
      assert.equal(value.reads[0].request.target.documentId, target.documentId);
      const user = value.state.conversation.messages.find(message => message.role === 'user');
      assert.equal(user.pageContextEnabled, true);
      assert.equal(user.readingPolicy.requireCurrentPage, true);
      assert.equal(user.pageSource.url, target.url);
      assert.match(JSON.stringify(value.payloads[0]), /ECS_PAGE_BODY/);
    });
  }
});

test('a disabled page mode never reads or includes the old page body', async t => {
  const value = fixture(t, { state: { disablePageContext: true } });
  await value.sendMessage(question);
  assert.equal(value.reads.length, 0);
  assert.equal(value.modelRequests.length, 1);
  assert.equal(value.state.conversation.messages[0].pageContextEnabled, false);
  assert.doesNotMatch(JSON.stringify(value.payloads), /ECS_PAGE_BODY/);
});

test('an enabled page read failure remains visible and cannot launch a model request', async t => {
  const value = fixture(t, { readPage: async () => { throw new Error('当前页面正文读取失败'); } });
  await value.sendMessage(question);
  assert.equal(value.reads.length, 1);
  assert.equal(value.modelRequests.length, 0);
  assert.equal(value.state.conversation.messages.at(-1).status, 'error');
  assert.match(value.notices.join(' '), /正文读取失败/);
});

test('a stopped page read cannot launch late generation or clear a subsequent submission', async t => {
  const firstRead = deferred();
  let count = 0;
  const value = fixture(t, { readPage: async () => ++count === 1 ? firstRead.promise : page });
  const first = value.sendMessage(question);
  await tick();
  value.stopActiveReply();
  await first;
  assert.equal(value.modelRequests.length, 0);
  await value.sendMessage('解释这些配置的作用');
  assert.equal(value.modelRequests.length, 1);
  firstRead.resolve(page);
  await tick();
  assert.equal(value.modelRequests.length, 1);
  assert.equal(value.state.conversation.messages.at(-1).status, 'complete');
});

test('queued page mode retains its required original page after the active tab changes', async t => {
  const value = fixture(t, { state: { generatingId: 'busy-conversation' } });
  await value.sendMessage(question);
  await tick();
  assert.equal(value.state.messageQueue[0].readingPolicy.requireCurrentPage, true);
  value.state.activePageSignal = { id: 8, tabId: 8, url: 'https://other.example.com', title: 'Other page' };
  value.state.generatingId = null;
  await value.processQueue();
  await tick();
  assert.equal(value.modelRequests.length, 1);
  assert.equal(value.reads[0].request.target.id, target.id);
  assert.equal(value.state.conversation.messages[0].pageSource.url, target.url);
  assert.equal(value.state.conversation.messages[0].readingPolicy.requireCurrentPage, true);
});

test('retry keeps page mode required and replaces the answer without a duplicate question', async t => {
  let count = 0;
  const value = fixture(t, { readPage: async () => {
    if (++count === 1) return page;
    throw new Error('重试时当前正文不可用');
  } });
  await value.sendMessage(question);
  const answerId = value.state.conversation.messages.at(-1).id;
  await value.regenerate(answerId);
  assert.equal(value.reads.length, 2);
  assert.equal(value.modelRequests.length, 1);
  assert.equal(value.state.conversation.messages.length, 2);
  assert.equal(value.state.conversation.messages[0].readingPolicy.requireCurrentPage, true);
  assert.equal(value.state.conversation.messages.at(-1).status, 'error');
  assert.match(value.notices.join(' '), /当前正文不可用/);
});

test('ordinary questions remain usable when the visible tab has no readable page', async t => {
  const active = { id: 8, tabId: 8, url: 'chrome://newtab', title: '新标签页' };
  const value = fixture(t, { state: { activePageSignal: active, disablePageContext: true }, queryActiveTab: async () => active });
  await value.sendMessage('帮我解释什么是虚拟机');
  assert.equal(value.reads.length, 0);
  assert.equal(value.modelRequests.length, 1);
  assert.equal(value.state.conversation.messages[0].pageContextEnabled, false);
});

test('a readable page selected at submission cannot silently become a plain question', async t => {
  const value = fixture(t, { queryActiveTab: async () => null });
  await value.sendMessage(question);
  assert.equal(value.modelRequests.length, 0);
  assert.match(value.notices.join(' '), /页面|网页/);
});

test('new page mode requires the base body even if a related chapter is readable', async () => {
  const query = '找到站内 MCP 章节并总结';
  const readingPolicy = readingPolicyForTurn({ question: query, pageContextEnabled: true });
  await assert.rejects(preparePageReading(query, { target, readingPolicy,
    readPage: async () => { throw new Error('当前页面正文读取失败'); },
    sendMessage: async () => ({ ...target, navigation: [] }),
    readResearch: async () => ({ status: 'complete', baseUrl: target.url,
      sources: [{ url: 'https://ecs-buy.aliyun.com/mcp', title: 'MCP chapter', text: 'Readable related MCP evidence. '.repeat(8) }] }),
  }), /正文读取失败/);
});

test('retry keeps the new required-page flag without broadening historical policies', () => {
  const current = readingPolicyForTurn({ question, pageContextEnabled: true });
  assert.equal(readingPolicyForRetry({ pageContextEnabled: true, readingPolicy: current }).requireCurrentPage, true);
  const legacy = { version: 1, scope: 'auto', intent: 'read', reason: 'explicit-site-question' };
  assert.deepEqual(readingPolicyForRetry({ pageContextEnabled: true, readingPolicy: legacy }), legacy);
  assert.equal(readingPolicyForRetry({ pageContextEnabled: false, readingPolicy: current }).scope, 'none');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readingPolicyForTurn, scoreReadingCandidate } from '../src/utils/reading-plan.js';
import { planSiteResearch, readSiteResearch } from '../src/utils/site-research.js';
import { preparePageReading } from '../src/sidepanel/features/page-reading/site-research-slot.js';
import { readSourcesForPage } from '../src/utils/research-context.js';

const target = { tabId: 7, documentId: 'doc-rag', title: '第 1-3 章 RAG、微调、续训与智能体选型',
  url: 'https://docs.example.com/book/#/1-3-rag?id=implementation' };
const discovery = { ...target, docsify: { basePath: '/book/', homepage: 'README.md', ext: '.md', routerMode: 'hash' },
  navigation: [
    { title: '2.5 实现方式', url: 'https://docs.example.com/book/#/1-3-rag?id=implementation' },
    { title: '第 8 章 信息同步', url: 'https://docs.example.com/book/#/8-sync' },
    { title: '第 12 章 召回信息合并与上下文构建', url: 'https://docs.example.com/book/#/12-context' },
    { title: '第 13 章 SQL 生成前的信息过滤与补全', url: 'https://docs.example.com/book/#/13-filter' },
    { title: '第 18 章 RAG 实现案例', url: 'https://docs.example.com/book/#/18-rag' },
  ] };
const question = 'rag实现方式有哪些';

test('a contextual explanation remains on the current page without requiring a live selection', () => {
  for (const query of ['结合上下文解释一下', '这句话是什么意思', '解释一下上面这段话']) {
    assert.equal(readingPolicyForTurn({ question: query }).scope, 'page', query);
  }
  assert.equal(readingPolicyForTurn({ question: '结合站内其他章节解释 RAG' }).scope, 'auto');
});

test('a named RAG question does not select chapters solely because they mention implementation or information', () => {
  for (const title of ['第 8 章 信息同步与实现方式', '第 12 章 召回信息合并与上下文构建', '第 13 章 SQL 的实现方式']) {
    assert.equal(scoreReadingCandidate(question, { title }), 0, title);
  }
  assert.ok(scoreReadingCandidate(question, { title: '第 2 章 检索增强生成' }) > 0);
});

test('ordinary topic reading prefers a matching current article over other chapters', async () => {
  let fetches = 0;
  const page = await preparePageReading(question, { target, readingPolicy: readingPolicyForTurn({ question, pageTitle: target.title }),
    readPage: async () => ({ ...target, text: 'RAG实现方式：自建检索管线，或使用托管知识库与工作流。'.repeat(8) }),
    sendMessage: async () => discovery,
    readResearch: options => readSiteResearch({ ...options, fetchImpl: async () => {
      fetches++; return new Response('UNREQUESTED_OTHER_CHAPTER '.repeat(20));
    } }),
  });
  assert.equal(fetches, 0);
  assert.equal(page.bodyStatus, 'read');
  assert.equal(page.structure.research, undefined);
  assert.deepEqual(page.readingPolicy.selectedUrls, []);
  assert.equal(readSourcesForPage(page).length, 1);
  assert.equal(readSourcesForPage(page)[0].url, target.url);
});

test('an explicit site request still reads matching independent chapters, including on retries', () => {
  const query = '找到站内其他 RAG 章节并总结';
  const policy = readingPolicyForTurn({ question: query });
  const plan = planSiteResearch({ page: target, discovery, question: query, readingPolicy: policy });
  assert.equal(plan.candidates.length, 1);
  assert.match(plan.candidates[0].url, /18-rag/);
  const retry = planSiteResearch({ page: target, discovery, question, readingPolicy: {
    ...policy, reason: 'topic-on-current-site', planned: true, selectedUrls: [plan.candidates[0].url],
  } });
  assert.deepEqual(retry.candidates, plan.candidates);
});

test('an explanation with only a directory match fails instead of presenting that directory as sufficient reading', async () => {
  await assert.rejects(preparePageReading(question, { target, readingPolicy: readingPolicyForTurn({ question, pageTitle: target.title }),
    readPage: async () => { throw new Error('Current body unavailable'); },
    sendMessage: async () => ({ ...discovery, navigation: discovery.navigation.slice(0, 1) }),
    readResearch: options => readSiteResearch({ ...options, fetchImpl: async () => { assert.fail('No unrelated fetch'); } }),
  }), /Current body unavailable/);
});

test('a legacy chapter locator can use directory evidence when its body fails', async () => {
  const query = 'RAG在哪里';
  let fetches = 0;
  const page = await preparePageReading(query, { target, readingPolicy: { version: 1, scope: 'auto', intent: 'locate', reason: 'topic-on-current-site' },
    readPage: async () => { throw new Error('Current body unavailable'); },
    sendMessage: async () => ({ ...discovery, navigation: [{ title: target.title, url: target.url }],
      docsify: { ...discovery.docsify, loadSidebar: true } }),
    readResearch: options => readSiteResearch({ ...options, fetchImpl: async () => { fetches++; throw new Error('Sidebar unavailable'); } }),
  });
  assert.equal(page.bodyStatus, 'unavailable');
  assert.equal(page.structure.research.status, 'directory_only');
  assert.ok(page.structure.research.directoryMatches.some(entry => entry.url === target.url));
  assert.equal(readSourcesForPage(page).length, 0);
  assert.equal(fetches, 0);
});

test('retrying current-page preference keeps the empty chapter plan without unread directory claims', async () => {
  let fetches = 0;
  const settings = { target, readingPolicy: readingPolicyForTurn({ question, pageTitle: target.title }),
    readPage: async () => ({ ...target, text: 'RAG实现方式：自建检索管线，或使用托管知识库与工作流。'.repeat(8) }),
    sendMessage: async () => ({ ...discovery, navigation: [], docsify: { ...discovery.docsify, loadSidebar: true } }),
    readResearch: options => readSiteResearch({ ...options, fetchImpl: async () => { fetches++; throw new Error('Unexpected fetch'); } }),
  };
  const initial = await preparePageReading(question, settings);
  const retried = await preparePageReading(question, { ...settings, readingPolicy: initial.readingPolicy });
  assert.deepEqual(retried.readingPolicy.selectedUrls, []);
  assert.equal(retried.structure.research, undefined);
  assert.equal(readSourcesForPage(retried).length, 1);
  assert.equal(fetches, 0);
});

test('an explicit comparison keeps each named topic while rejecting generic instruction matches', () => {
  for (const [query, titles] of [
    ['找到MCP和Agent相关章节并比较', ['第 20 章 MCP 模型上下文协议', '第 21 章 Agent 智能体']],
    ['比较站内RAG和微调的实现方式', ['第 2 章 RAG', '第 3 章 微调']],
  ]) {
    const links = titles.map((title, index) => ({ title, url: `https://docs.example.com/book/#/comparison-${index}` }));
    const plan = planSiteResearch({ page: target, question: query, discovery: { ...discovery, navigation: links },
      readingPolicy: readingPolicyForTurn({ question: query }) });
    assert.equal(plan.candidates.length, 2, query);
    assert.equal(scoreReadingCandidate(query, { title: '第 12 章 信息同步的实现方式' }), 0);
  }
});

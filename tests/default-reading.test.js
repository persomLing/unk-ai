import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { preparePageReading } from '../src/sidepanel/features/page-reading/site-research-slot.js';
import { captureSiteResearchDiscovery, readSiteResearch, planSiteResearch } from '../src/utils/site-research.js';
import { readingPolicyForTurn } from '../src/utils/reading-plan.js';
import { readSourcesForPage } from '../src/utils/research-context.js';
import { requestMessagesFor, fitMessagesToBudget, estimateMessagesTokens } from '../src/utils/context.js';

const base = { tabId: 7, documentId: 'doc-a', url: 'https://docs.example.com/book/#/intro', title: 'Intro', text: 'CURRENT_BODY '.repeat(30), capturedAt: '2026-10-30T00:00:00Z' };
const chapterUrl = 'https://docs.example.com/book/#/20-MCP模型上下文协议';
const discovery = { ...base, navigation: [
  { title: 'MCP 概述', url: `${base.url}?id=mcp-overview`, kind: 'section' },
  { title: '第 20 章 MCP 模型上下文协议', url: chapterUrl, kind: 'chapter' },
  { title: '第 21 章 Agent 智能体', url: 'https://docs.example.com/book/#/21-Agent', kind: 'chapter' },
], docsify: { basePath: '/book/', homepage: 'README.md', ext: '.md', routerMode: 'hash', loadSidebar: '_sidebar.md', alias: { '/translations/en/(.*)_sidebar.md': '/_sidebar.en.md' }, unsupportedConfig: false } };
const question = '找到 MCP 章节并总结';
const policy = readingPolicyForTurn({ question });
const legacyPolicy = (intent = 'read') => ({ version: 1, scope: 'auto', intent, reason: 'explicit-site-question' });
const turn = () => new Promise(resolve => setImmediate(resolve));
const body = '# 第 20 章 MCP 模型上下文协议\n\nCHAPTER_20_BODY ' + 'MCP lets models use explicit tool and resource interfaces. '.repeat(15);

function options(extra = {}) {
  const requests = [];
  return { requests, target: base, readingPolicy: policy,
    readPage: async () => base, sendMessage: async () => discovery,
    readResearch: value => readSiteResearch({ ...value, fetchImpl: async (url, init) => {
      requests.push({ url, init }); return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
    } }), ...extra };
}

test('default ordinary MCP reading fetches the independent chapter and records a retry policy', async () => {
  const settings = options();
  const page = await preparePageReading(question, settings);
  assert.equal(page.bodyStatus, 'read');
  assert.equal(settings.requests.length, 1);
  assert.equal(decodeURI(settings.requests[0].url), 'https://docs.example.com/book/20-MCP模型上下文协议.md');
  assert.equal(page.structure.research.directoryMatches[0].kind, 'chapter');
  assert.equal(page.structure.research.directoryMatches[1].kind, 'section');
  assert.deepEqual(page.readingPolicy.selectedUrls, [new URL(chapterUrl).href]);
  assert.equal(page.readingPolicy.planned, true);
  assert.equal(page.url, base.url);
});

test('the full numbered MCP request fetches chapter 20 without weak model/context matches', async () => {
  const query = '找到第20章MCP模型上下文协议并总结';
  const navigation = [...discovery.navigation,
    { title: '12-召回信息合并与上下文构建', url: 'https://docs.example.com/book/#/实战项目-电商问数/12-召回信息合并与上下文构建' },
    { title: '1-1-大模型认知与工程概览', url: 'https://docs.example.com/book/#/1-1-大模型认知与工程概览' },
  ];
  const settings = options({ readingPolicy: readingPolicyForTurn({ question: query }), sendMessage: async () => ({ ...discovery, navigation }) });
  const page = await preparePageReading(query, settings);
  assert.equal(settings.requests.length, 1);
  assert.deepEqual(page.readingPolicy.selectedUrls, [new URL(chapterUrl).href]);
});

test('legacy retries preserve readable chapters when the original optional current body times out', async (t) => {
  let bodySignal;
  const settings = options({ readingPolicy: legacyPolicy(), readPage: ({ signal, timeoutMs }) => {
    bodySignal = signal; assert.ok(timeoutMs <= 7000); return new Promise(() => {});
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = preparePageReading(question, settings);
  await turn();
  assert.equal(settings.requests.length, 1);
  t.mock.timers.tick(7001);
  const page = await pending;
  assert.equal(bodySignal.aborted, true);
  assert.equal(page.bodyStatus, 'unavailable');
  assert.equal(page.text, '');
  assert.equal(readSourcesForPage(page).length, 1);
  assert.equal(readSourcesForPage(page)[0].url, new URL(chapterUrl).href);
  const messages = requestMessagesFor({ messages: [{ id: 'u', role: 'user', content: question, pageContextEnabled: true, readingPolicy: page.readingPolicy }] }, undefined, page);
  const outgoing = JSON.stringify(messages);
  assert.match(outgoing, /CHAPTER_20_BODY/);
  assert.match(outgoing, /没有读取到该页正文/);
  assert.doesNotMatch(outgoing, /CURRENT_BODY|<page_content>/);
});

test('a legacy locate-only policy can answer from the directory without claiming chapter bodies', async () => {
  const localQuestion = '本站哪里讲 MCP';
  const settings = options({ readingPolicy: legacyPolicy('locate'), readPage: async () => { throw new Error('Body not ready'); } });
  const page = await preparePageReading(localQuestion, settings);
  assert.equal(settings.requests.length, 0);
  assert.equal(page.structure.research.status, 'directory_only');
  assert.equal(page.structure.research.sources.length, 0);
  assert.ok(page.structure.research.directoryMatches.length);
  assert.equal(readSourcesForPage(page).length, 0);
});

test('local, selected and disabled policies never launch directory discovery or extra GETs', async () => {
  for (const input of [
    { question: '总结这页' },
    { question: '只解释选中段落', selection: { text: 'MCP' } },
    { question, pageContextEnabled: false },
    { question: '总结附件', attachments: [{ type: 'document' }] },
  ]) {
    let reads = 0;
    const readingPolicy = readingPolicyForTurn(input);
    const page = await preparePageReading(input.question, { target: base, readingPolicy,
      readPage: async () => { reads++; return base; }, sendMessage() { assert.fail('No directory discovery'); },
      readResearch() { assert.fail('No related reads'); },
    });
    assert.equal(reads, readingPolicy.scope === 'none' ? 0 : 1);
    assert.equal(Boolean(page), readingPolicy.scope !== 'none');
  }
});

test('an independent chapter is not displaced by hundreds of current-page table-of-contents entries', () => {
  const anchors = [...Array.from({ length: 250 }, (_, index) => ({ title: `MCP 小节 ${index}`, href: `#/intro?id=section-${index}` })), { title: '第 20 章 MCP 模型上下文协议', href: '#/20-MCP模型上下文协议' }]
    .map(item => ({ textContent: item.title, getAttribute: name => name === 'href' ? item.href : null }));
  const context = vm.createContext({ URL, location: { href: base.url }, $docsify: discovery.docsify,
    document: { title: base.title, baseURI: base.url, querySelectorAll: () => anchors } });
  const captured = vm.runInContext(`(${captureSiteResearchDiscovery.toString()})()`, context);
  assert.equal(captured.sectionLinks.length, 30);
  assert.equal(captured.chapterLinks.length, 1);
  const plan = planSiteResearch({ page: base, question, discovery: captured, readingPolicy: policy });
  assert.equal(plan.candidates.length, 1);
  assert.equal(decodeURI(plan.candidates[0].url), chapterUrl);
});

test('planned retries cannot expand their source set when new matching chapters appear', async () => {
  const initial = await preparePageReading(question, options());
  const expanded = { ...discovery, navigation: [...discovery.navigation, { title: '第 25 章 MCP 实战', url: 'https://docs.example.com/book/#/25-MCP实战' }] };
  const settings = options({ readingPolicy: initial.readingPolicy, sendMessage: async () => expanded });
  await preparePageReading(question, settings);
  assert.equal(settings.requests.length, 1);
  assert.match(decodeURI(settings.requests[0].url), /20-MCP/);
});

test('a temporary missing directory item cannot erase the pinned source policy', async () => {
  const initial = await preparePageReading(question, options());
  const settings = options({ readingPolicy: initial.readingPolicy, sendMessage: async () => ({ ...discovery, navigation: [discovery.navigation[2]] }) });
  const retry = await preparePageReading(question, settings);
  assert.equal(settings.requests.length, 0);
  assert.deepEqual(retry.readingPolicy.selectedUrls, initial.readingPolicy.selectedUrls);
});

test('a failed first directory fetch leaves planning retryable instead of pinning an empty source set', async () => {
  const failed = await preparePageReading(question, options({ sendMessage: async () => ({ ...discovery, navigation: [] }),
    readResearch: value => readSiteResearch({ ...value, fetchImpl: async () => new Response('', { status: 503 }) }) }));
  assert.equal(failed.readingPolicy.planned, undefined);
  const retrySettings = options({ readingPolicy: failed.readingPolicy });
  const retried = await preparePageReading(question, retrySettings);
  assert.equal(retrySettings.requests.length, 1);
  assert.deepEqual(retried.readingPolicy.selectedUrls, [new URL(chapterUrl).href]);
});

test('a planned empty source set remains empty even if matching chapters appear later', async () => {
  const initial = await preparePageReading(question, options({ sendMessage: async () => ({ ...discovery, navigation: [discovery.navigation[2]] }) }));
  assert.deepEqual(initial.readingPolicy.selectedUrls, []);
  const settings = options({ readingPolicy: initial.readingPolicy });
  const retry = await preparePageReading(question, settings);
  assert.equal(settings.requests.length, 0);
  assert.deepEqual(retry.readingPolicy.selectedUrls, []);
});

test('legacy static HTML section matches remain directory evidence without refetching the current body', async () => {
  const target = { ...base, url: 'https://docs.example.com/book/index.html' };
  const localQuestion = '本站哪里讲 MCP';
  const page = await preparePageReading(localQuestion, {
    target, readingPolicy: legacyPolicy('locate'),
    readPage: async () => { throw new Error('Body not ready'); },
    sendMessage: async () => ({ ...target, docsify: null, navigation: [{ title: 'MCP 概述', url: `${target.url}#mcp` }] }),
    readResearch: value => readSiteResearch({ ...value, fetchImpl() { assert.fail('No body GET for directory-only evidence'); } }),
  });
  assert.equal(page.bodyStatus, 'unavailable');
  assert.equal(page.structure.research.directoryMatches[0].kind, 'section');
  assert.equal(readSourcesForPage(page).length, 0);
});

test('same-URL document replacement and route changes fail instead of downgrading to related-only answers', async (t) => {
  for (const replacement of [{ documentId: 'doc-b' }, { url: 'https://docs.example.com/book/#/other' }]) {
    await t.test(JSON.stringify(replacement), async () => {
      const settings = options({ readPage: async () => ({ ...base, ...replacement }) });
      await assert.rejects(preparePageReading(question, settings), error => error.code === 'PAGE_CHANGED');
    });
  }
  await assert.rejects(preparePageReading(question, options({ sendMessage: async () => ({ ...discovery, documentId: 'doc-b' }) })), error => error.code === 'PAGE_CHANGED');
});

test('cancelling the shared operation promptly abandons pending body and directory work', async () => {
  const controller = new AbortController();
  let captured;
  const settings = options({ signal: controller.signal, readPage: () => new Promise(() => {}), sendMessage: () => new Promise(resolve => { captured = resolve; }) });
  const pending = preparePageReading(question, settings);
  await turn();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  captured(discovery);
  await turn();
  assert.equal(settings.requests.length, 0);
});

test('body, directory and related reads share one total deadline instead of accumulating timeouts', async (t) => {
  const settings = options({ timeoutMs: 1000, readResearch: () => new Promise(() => {}) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = preparePageReading(question, settings);
  await turn();
  t.mock.timers.tick(1001);
  const page = await pending;
  assert.equal(page.bodyStatus, 'read');
  assert.equal(page.structure.research, undefined);
  assert.equal(page.readingPolicy.planned, undefined);
});

test('legacy linked-only evidence keeps actual chapter text and URL under a small model budget', async () => {
  const settings = options({ readingPolicy: legacyPolicy(), readPage: async () => { throw new Error('Read unavailable'); }, readResearch: async value => ({ baseUrl: value.page.url, status: 'complete', selectedUrls: [new URL(chapterUrl).href], sources: [{ url: chapterUrl, title: 'MCP chapter', text: 'MCP_EVIDENCE ' + '文'.repeat(23000) }] }) });
  const page = await preparePageReading(question, settings);
  const conversation = { messages: [{ id: 'u', role: 'user', content: question, pageContextEnabled: true, readingPolicy: page.readingPolicy }] };
  const fitted = fitMessagesToBudget(conversation, requestMessagesFor(conversation, undefined, page), 8000, 1000);
  assert.ok(estimateMessagesTokens(fitted) <= 6760);
  assert.match(JSON.stringify(fitted), /MCP_EVIDENCE/);
  assert.equal(readSourcesForPage(page).length, 1);
});

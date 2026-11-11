import test from 'node:test';
import assert from 'node:assert/strict';
import { webResearchPolicy } from '../src/sidepanel/features/web-research/web-research.js';
import * as researchDecision from '../src/sidepanel/features/web-research/research-decision.js';

const { parseResearchDecision, researchDecisionMessages, researchInputSummary } = researchDecision;
const image = { type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=', name: 'PRIVATE_IMAGE_NAME' };
const imageSummary = { imageCount: 1, documentCount: 0, hasSelection: false, hasPage: false };

test('local policy separates forced search, local facts and model judgment', () => {
  assert.equal(webResearchPolicy('现在是几月几号').scope, 'skip');
  assert.equal(webResearchPolicy('第一次去洛阳怎么玩，门票和开放时间怎么安排').scope, 'search');
  assert.equal(webResearchPolicy('整理近24小时国内外大事').scope, 'search');
  assert.equal(webResearchPolicy('什么是闭包').scope, 'auto');
});

test('direct material reading skips research only when usable turn evidence is present', () => {
  const questions = [
    '这里是正常的嘛', '这正常吗？', '解释这张截图里的 curl 返回',
    '帮我排查附件日志里的错误', '总结这份文档', '把选中的这段翻译成英文',
    '只根据页面正文解释这几个字段', '解释这张图，并说明这里是否正常',
    'Is this normal?', 'Does this output look correct?',
    'Explain the curl output in this screenshot.', 'Summarize the attached document.',
    'Translate this selection into Chinese.', 'Debug this error message.',
    '只解释这张截图，不用联网。', 'Explain this screenshot without searching the web.',
    '解释截图中的搜索按钮', 'Explain the web search result in this screenshot.',
  ];
  for (const question of questions) {
    assert.equal(webResearchPolicy(question, imageSummary).scope, 'skip', question);
    assert.equal(webResearchPolicy(question).scope, 'auto', `No material: ${question}`);
  }
  for (const summary of [{ documentCount: 1 }, { hasSelection: true }, { hasPage: true }]) {
    assert.equal(webResearchPolicy('这里是正常的嘛', summary).scope, 'skip');
  }
});

test('attachments do not override fresh facts, versions or explicit external research', () => {
  for (const question of [
    '解释截图，并联网核实是否是官方支持的行为',
    '总结附件，再搜索官方文档的处理方式',
    '这张图的价格今天还有效吗', '总结截图，gpt-5 支持这些参数吗',
    'Explain this screenshot and look up the official documentation.',
    'Translate this and verify whether it is still supported.',
    'Is this normal for the latest release?',
    '解释截图并上网查这个报错', 'Search the web for this error.',
  ]) assert.equal(webResearchPolicy(question, imageSummary).scope, 'search', question);
});

test('ambiguous or mixed external factual questions still require model judgment', () => {
  for (const question of [
    '这个方案可以吗', '你觉得怎么样', 'Can this service handle our production traffic?',
    '解释截图，顺便推荐最便宜的云服务',
    'Summarize this document and recommend the cheapest provider.',
    '解释截图并告诉我这个供应商支持哪些其他协议',
    '解释截图以及告诉我美国总统是谁',
    'Explain this screenshot plus tell me who won the election.',
    '解释这张截图并总结官网的收费标准',
    '解释截图，然后解读 https://example.org/pricing 这页的收费标准',
    'Explain this screenshot. Find the official compatibility requirements.',
    'Explain this screenshot. Tell me who won the election.',
    '解释截图，总结美国总统的任期',
    'Explain this screenshot and summarize the company history.',
    '解释这张图，并说明是否正常',
  ]) assert.equal(webResearchPolicy(question, imageSummary).scope, 'auto', question);
});

test('research input metadata counts only usable material and respects disabled vision', () => {
  const attachments = [image, { type: 'image', dataUrl: ' ' }, { type: 'image' },
    { type: 'document', text: 'PRIVATE_DOCUMENT_BODY', name: 'PRIVATE_DOCUMENT_NAME' },
    { type: 'document', text: ' ' }, { type: 'file', text: 'UNSUPPORTED_FILE' }];
  assert.deepEqual(researchInputSummary({ attachments, selection: { text: 'selected text' }, page: { text: 'page body' } }),
    { imageCount: 1, documentCount: 1, hasSelection: true, hasPage: true });
  assert.deepEqual(researchInputSummary({ attachments, includeVisual: false, selection: { text: ' ' }, page: { title: 'Only title' } }),
    { imageCount: 0, documentCount: 1, hasSelection: false, hasPage: false });
  assert.deepEqual(researchInputSummary({ page: { text: 'stale body', bodyStatus: 'unavailable' } }),
    { imageCount: 0, documentCount: 0, hasSelection: false, hasPage: false });
  assert.deepEqual(researchInputSummary(), { imageCount: 0, documentCount: 0, hasSelection: false, hasPage: false });
  assert.equal(researchInputSummary({ attachments: Array(100).fill(image) }).imageCount, 6);
});

test('decision prompt carries the current year and prefers research when uncertain', () => {
  const messages = researchDecisionMessages({ question: '这个方案可以吗', pageTitle: '文档', year: '2026' });
  assert.match(messages[0].content, /2026/);
  assert.match(messages[0].content, /不确定时选择检索/);
  assert.equal(messages[1].role, 'user');
  assert.deepEqual(JSON.parse(messages[1].content), { question: '这个方案可以吗', currentPageTitle: '文档',
    inputSummary: { imageCount: 0, documentCount: 0, hasSelection: false, hasPage: false } });
});

test('gray-area decision receives bounded metadata without attachment content or identifiers', () => {
  const messages = researchDecisionMessages({ question: '这个方案可以吗', year: '2026', inputSummary: {
    imageCount: 999, documentCount: -1, hasSelection: 'yes', hasPage: true,
    attachments: [image], text: 'PRIVATE_BODY', name: 'PRIVATE_NAME', url: 'https://private.test/',
  } });
  assert.deepEqual(JSON.parse(messages[1].content).inputSummary,
    { imageCount: 6, documentCount: 0, hasSelection: false, hasPage: true });
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_|private\.test|data:image/);
  assert.equal(JSON.parse(researchDecisionMessages({ inputSummary: { imageCount: Infinity } })[1].content).inputSummary.imageCount, 0);
});

test('decision parsing accepts strict JSON and fails closed on malformed output', () => {
  assert.deepEqual(parseResearchDecision('```json\n{"search":true,"reason":"价格可能变化"}\n```'), { search: true, reason: '价格可能变化' });
  assert.deepEqual(parseResearchDecision('{"search":false,"reason":"稳定概念"}'), { search: false, reason: '稳定概念' });
  assert.throws(() => parseResearchDecision('maybe'), /格式无效/);
  assert.throws(() => parseResearchDecision('{"search":"yes"}'), /search/);
});

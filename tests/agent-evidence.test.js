import test from 'node:test';
import assert from 'node:assert/strict';

import { agentReadingSources, agentResultWithSources, assessChapterCompletion, boundedPageReadings, combinePageEvidence, observationFeedback } from '../src/utils/agent-evidence.js';

test('appends the latest conversation answer after extracted page text', () => {
  const result = combinePageEvidence({
    title: 'DeepSeek 网传消息整理',
    url: 'https://chat.deepseek.com/a/chat/1',
    text: '页面正文：DeepSeek 网传消息整理。',
  }, [
    '用户：今天有没有关于 DeepSeek 的小道消息？',
    '助手：今日网传消息包括 V5 占位符、GPT-6 Astra、官网指纹异动和千亿融资。',
  ]);
  assert.ok(result.text.startsWith('页面正文'));
  assert.match(result.text, /V5 占位符/);
  assert.match(result.text, /<latest_conversation>/);
});

test('deduplicates repeated recent messages and caps evidence', () => {
  const result = combinePageEvidence({ text: 'base' }, ['answer', 'answer']);
  assert.equal((result.text.match(/answer/g) || []).length, 1);
  const huge = combinePageEvidence({ text: 'x'.repeat(30000) }, []);
  assert.equal(huge.text.length, 20000);
  assert.equal(huge.truncated, true);
});

test('keeps page evidence when recent messages are unavailable', () => {
  const result = combinePageEvidence({ text: 'page only' }, []);
  assert.equal(result.text, 'page only');
  assert.equal(result.truncated, false);
});

test('a full-length article does not crowd out the latest conversation evidence', () => {
  const result = combinePageEvidence({ text: 'ARTICLE '.repeat(5000) }, ['LATEST_CONVERSATION: 本轮回复中的关键结论。']);
  assert.ok(result.text.startsWith('ARTICLE'));
  assert.match(result.text, /LATEST_CONVERSATION/);
  assert.ok(result.text.endsWith('</latest_conversation>'));
  assert.ok(result.text.length <= 20000);
  assert.equal(result.truncated, true);
});

test('page readings deduplicate URL/query and retain recent bodies under a total budget', () => {
  const result = boundedPageReadings([
    { url: 'https://page.test/old', text: 'discard' },
    { url: 'https://page.test/current', query: 'chapter', text: 'stale' },
    { url: 'https://page.test/other', text: 'A'.repeat(15000) },
    { url: 'https://page.test/current', query: 'chapter', text: 'NEW '.repeat(4000) },
  ]);
  assert.ok(result.length <= 3);
  assert.equal(result.reduce((sum, reading) => sum + reading.text.length, 0), 18000);
  assert.ok(result.every(reading => reading.text.length <= 10000));
  assert.ok(result.every(reading => reading.truncated));
  assert.equal(result.filter(reading => reading.url === 'https://page.test/current').length, 1);
  assert.ok(result.at(-1).text.startsWith('NEW'));
  assert.equal(boundedPageReadings([{ url: 'javascript:alert(1)', text: 'bad' }]).length, 0);
});

test('final sources contain no body data and readable links preserve source provenance', () => {
  const readings = [{ url: 'https://page.test/a', title: 'Chapter [1]', text: 'PRIVATE_BODY', capturedAt: '2026-10-30' }];
  const sources = agentReadingSources(readings);
  assert.deepEqual(sources, [{ url: 'https://page.test/a', title: 'Chapter [1]', capturedAt: '2026-10-30', truncated: false }]);
  assert.doesNotMatch(JSON.stringify(sources), /PRIVATE_BODY/);
  const result = agentResultWithSources('Answer', readings);
  assert.match(result, /https:\/\/page.test\/a/);
  assert.match(result, /Chapter \\\[1\\\]/);
  assert.doesNotMatch(result, /PRIVATE_BODY/);
});

test('observation feedback ignores reassigned IDs and distinguishes visible change from verified success', () => {
  const before = { url: 'https://page.test', summary: 'Contents', scrollY: 0, elements: [{ id: 'e1', name: 'Next', role: 'button' }] };
  const unchanged = observationFeedback(before, { ...before, elements: [{ id: 'e17', name: 'Next', role: 'button' }] });
  assert.equal(unchanged.changed, false);
  assert.match(unchanged.message, /尚未确认/);
  const scrolled = observationFeedback(before, { ...before, scrollY: 800 });
  assert.equal(scrolled.changed, true);
  assert.match(scrolled.message, /仍需.*确认/);
  assert.equal(observationFeedback({}, {}).changed, null);
});

test('container feedback follows stable identity and ignores other containers and changing clocks', () => {
  const target = { id: 'e1', stableKey: 'frame:sidebar', name: '教程目录', scroll: { top: 0, left: 0, directions: ['down'] } };
  const other = { id: 'e2', stableKey: 'frame:main', name: '正文', scroll: { top: 0, left: 0, directions: ['down'] } };
  const before = { url: 'https://docs.test', summary: '时钟 12:00', scrollY: 0, elements: [target, other] };
  const after = { ...before, summary: '时钟 12:01', scrollY: 200,
    elements: [{ ...target, id: 'e8' }, { ...other, scroll: { top: 300, left: 0, directions: ['down'] } }] };
  const context = { action: 'scroll_page', args: { elementId: 'e1', direction: 'down' } };
  assert.equal(observationFeedback(before, after, context).changed, false);
  after.elements[0].scroll = { top: 262, left: 0, directions: ['up', 'down'] };
  assert.equal(observationFeedback(before, after, context).changed, true);
  assert.match(observationFeedback(before, after, context).message, /教程目录.*262/);
  assert.equal(observationFeedback(before, { ...after, elements: [other] }, context).changed, null);
});

test('targeted feedback detects chapter expansion and main content without treating toolbar noise as success', () => {
  const target = { id: 'e1', stableKey: 'chapter-group', name: '基础篇', state: { expanded: false }, layout: { region: 'navigation' } };
  const clock = { id: 'e2', stableKey: 'clock', name: '12:00', layout: { region: 'toolbar' } };
  const before = { url: 'https://docs.test', title: '教程', summary: '12:00', content: { heading: '第一章', text: '正文' }, elements: [target, clock] };
  const noise = { ...before, summary: '12:01', elements: [target, { ...clock, name: '12:01' }] };
  const context = { action: 'click_element', args: { elementId: 'e1' } };
  assert.equal(observationFeedback(before, noise, context).changed, false);
  assert.equal(observationFeedback(before, { ...noise, elements: [{ ...target, state: { expanded: true } }, clock] }, context).changed, true);
  assert.equal(observationFeedback(before, { ...noise, content: { heading: '第20章', text: 'MCP正文' } }, context).changed, true);
});

test('chapter completion requires the target document and heading instead of the current-page overview', () => {
  const chapter = { name: '第20章 MCP 模型上下文协议', href: 'https://docs.test/#/chapter20', navigation: { kind: 'document' } };
  const section = { name: 'MCP 概述', href: 'https://docs.test/#/intro?id=mcp', navigation: { kind: 'section' } };
  const overview = { url: 'https://docs.test/#/intro', title: '导读', text: 'MCP 概述\n这里简要提到 MCP。' };
  for (const goal of ['找到 MCP 章节并总结', '阅读第20章并总结', '总结第二十章']) {
    const result = assessChapterCompletion(goal, [section, chapter], [overview]);
    assert.equal(result.ok, false);
    assert.equal(result.target.url, chapter.href);
    assert.match(result.reason, /同名概述不能替代/);
    assert.equal(assessChapterCompletion(goal, [chapter], [{ ...overview, url: chapter.href }]).ok, false, 'a new route with the old article is still insufficient');
    assert.equal(assessChapterCompletion(goal, [chapter], [{ url: `${chapter.href}?id=architecture`, title: '教程', text: '# 第20章 MCP 模型上下文协议\n实际正文。' }]).ok, true);
  }
});

test('chapter completion is limited to clear reading goals and tolerates unknown non-numbered targets', () => {
  assert.equal(assessChapterCompletion('解释 MCP 概念', [], []).ok, true);
  assert.equal(assessChapterCompletion('找到 MCP 章节并总结', [], []).ok, true);
  assert.equal(assessChapterCompletion('打开第20章', [], []).ok, true, 'navigation alone does not demand body evidence');
  assert.equal(assessChapterCompletion('总结第20章', [], [{ url: 'https://docs.test', title: '概述', text: '当前页概述' }]).ok, false);
  assert.equal(assessChapterCompletion('总结第20章', [], [{ url: 'https://docs.test', title: '概述', text: '本页还会提到第20章的知识。' }]).ok, false);
  assert.equal(assessChapterCompletion('总结第20章', [], [{ url: 'https://docs.test/ch20', title: '第20章', text: '真实正文' }]).ok, true);
});

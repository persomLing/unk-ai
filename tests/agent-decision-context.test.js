import test from 'node:test';
import assert from 'node:assert/strict';
import { sameAgentReadingContent, compactAgentPageReadings, compactAgentRegionData, agentDecisionInputMetrics } from '../src/sidepanel/features/agent/decision-context.js';
import { summarizeRegionReadings } from '../src/utils/agent-region-data.js';

test('identical evidence is recognized across query wording but never across page/document identity', () => {
  const source = { url: 'https://site.test/app', documentId: 'doc', text: 'model\r\n2.6', query: 'model' };
  assert.equal(sameAgentReadingContent(source, { ...source, text: 'model\n2.6', query: 'settings' }), true);
  assert.equal(sameAgentReadingContent(source, { ...source, documentId: 'other' }), false);
  assert.equal(sameAgentReadingContent(source, { ...source, url: 'https://site.test/new' }), false);
  const region = { ...source, rows: [{ label: 'model', text: '2.6' }], frameUrl: source.url };
  assert.equal(sameAgentReadingContent(region, { ...region, query: 'options' }, { region: true }), true);
  assert.equal(sameAgentReadingContent(region, { ...region, rows: [{ label: 'model', text: '2.7' }] }, { region: true }), false);
});

test('write decisions remove repeated bodies and mark excerpts without modifying task evidence', () => {
  const readings = [
    { url: 'https://site.test/app', title: 'Settings', query: 'model', text: 'A'.repeat(8000), capturedAt: '2026-11-06T03:00:00Z' },
    { url: 'https://site.test/app', title: 'Settings', query: 'options', text: 'A'.repeat(8000), capturedAt: '2026-11-06T03:00:01Z' },
    { url: 'https://site.test/help', title: 'Help', query: 'usage', text: 'B'.repeat(8000), capturedAt: '2026-11-06T03:00:02Z' },
  ];
  const before = structuredClone(readings);
  const result = compactAgentPageReadings(readings, { executionRequired: true });
  assert.equal(result.readings.length, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.truncated, true);
  assert.ok(result.readings.every(item => item.text.length < 1600 && item.truncated));
  assert.deepEqual(result.readings.map(item => [item.url, item.title, item.capturedAt]), [
    ['https://site.test/app', 'Settings', '2026-11-06T03:00:01Z'], ['https://site.test/help', 'Help', '2026-11-06T03:00:02Z'],
  ]);
  assert.match(result.readings[0].text, /完整已读正文保留/);
  assert.deepEqual(readings, before);
});

test('reading-only tasks preserve the existing reading budget and source ordering', () => {
  const readings = [{ url: 'https://site.test/app', text: 'A'.repeat(9000), query: 'a' }, { url: 'https://site.test/help', text: 'B'.repeat(9000), query: 'b' }];
  const result = compactAgentPageReadings(readings);
  assert.equal(result.readings.reduce((sum, item) => sum + item.text.length, 0), 18000);
  assert.equal(result.removed, 0);
  assert.equal(result.truncated, false);
});

test('write region decisions retain the latest excerpt and exact source within a shared structured budget', () => {
  const data = summarizeRegionReadings(Array.from({ length: 4 }, (_, index) => ({
    url: 'https://site.test/app', title: 'Image studio', query: `field-${index}`, capturedAt: `2026-11-06T03:00:0${index}Z`,
    text: `最新配置${index}\n${'说明'.repeat(990)}`, rows: [], totalRows: 0,
    ...(index === 3 ? { queryMatched: false, notice: '区域未匹配指定字段' } : {}),
  })));
  const before = structuredClone(data);
  assert.ok(JSON.stringify(data).length > 3000);
  const result = compactAgentRegionData(data, { executionRequired: true });
  assert.ok(JSON.stringify(result).length <= 3000);
  const latest = result.sources.find(item => item.id === 4);
  assert.equal(latest.url, 'https://site.test/app');
  assert.equal(latest.capturedAt, '2026-11-06T03:00:03Z');
  assert.equal(latest.queryMatched, false);
  assert.equal(latest.notice, '区域未匹配指定字段');
  assert.match(result.excerpts.find(item => item.sourceId === 4).text, /^最新配置3/);
  assert.equal(result.summaryTruncated, true);
  assert.equal(result.truncated, true);
  assert.ok(result.omittedReadings > 0);
  assert.match(result.coverage, /动作决策节选.*完整已读资料/s);
  for (const excerpt of result.excerpts) assert.ok(result.sources.some(source => source.id === excerpt.sourceId));
  assert.deepEqual(data, before);
});

test('bounded write-region rankings preserve extrema, counts, conflicts and every retained source reference', () => {
  const data = summarizeRegionReadings(Array.from({ length: 3 }, (_, page) => ({
    url: `https://site.test/models?page=${page}`, title: 'Model metrics', query: '缓存命中率', capturedAt: `2026-11-06T03:00:0${page}Z`,
    rows: [
      ...Array.from({ length: 50 }, (_, index) => ({ label: `model-${page}-${index}`, text: `缓存命中率 ${page === 0 && index === 49 ? 99.8 : page * 10 + index / 10}%` })),
      ...(page < 2 ? [{ label: '冲突型号', text: `缓存命中率 ${page * 10 + 70}%` }] : []),
    ],
    ...(page === 2 ? { totalRows: 55, omittedRows: 5, truncated: true } : {}),
  })));
  const before = structuredClone(data);
  assert.ok(JSON.stringify(data).length > 3000);
  const result = compactAgentRegionData(data, { executionRequired: true });
  assert.ok(JSON.stringify(result).length <= 3000);
  const group = result.groups.find(item => item.query === '缓存命中率');
  assert.equal(group.rowCount, 152);
  assert.equal(group.conflictingLabels, 1);
  assert.equal(group.unresolvedCount, 2);
  assert.equal(group.rankings[0].count, 150);
  assert.equal(group.rankings[0].highest[0].label, 'model-0-49');
  assert.equal(group.rankings[0].highest[0].value, 99.8);
  assert.ok(result.omittedRows > data.omittedRows);
  assert.equal(result.truncated, true);
  assert.equal(result.summaryTruncated, true);
  for (const ranking of group.rankings) for (const item of [...ranking.highest, ...ranking.lowest]) {
    for (const sourceId of item.sourceIds) assert.ok(result.sources.some(source => source.id === sourceId));
  }
  for (const item of group.unresolved) assert.ok(result.sources.some(source => source.id === item.sourceId));
  assert.deepEqual(data, before);
});

test('a long latest source URL is kept whole and never leaves untraceable excerpts or numeric rows', () => {
  const url = `https://site.test/app?selection=${'x'.repeat(1850)}`;
  const data = summarizeRegionReadings([
    { url: 'https://site.test/older', query: 'old', text: 'old'.repeat(600), rows: [] },
    { url, title: 'title'.repeat(40), capturedAt: '2026-11-06T03:00:07Z', query: 'latest', text: 'LATEST\n' + 'body'.repeat(490), rows: [] },
  ]);
  const result = compactAgentRegionData(data, { executionRequired: true });
  assert.ok(JSON.stringify(result).length <= 3000);
  assert.equal(result.sources.find(item => item.id === 2).url, url);
  assert.match(result.excerpts.find(item => item.sourceId === 2).text, /^LATEST/);
  assert.ok(result.excerpts.every(item => result.sources.some(source => source.id === item.sourceId)));
});

test('reading-only region data keeps the full existing structure and ordering without an action excerpt', () => {
  const data = summarizeRegionReadings(Array.from({ length: 5 }, (_, index) => ({
    url: `https://site.test/${index}`, query: 'help', text: '完整资料'.repeat(450), rows: [],
  })));
  assert.ok(JSON.stringify(data).length > 3000);
  assert.equal(compactAgentRegionData(data), data);
  assert.equal(compactAgentRegionData(null, { executionRequired: true }), null);
});

test('request metrics include only scalar sizes and distinguish embedded images from text', () => {
  assert.deepEqual(agentDecisionInputMetrics([
    { role: 'system', content: 'PRIVATE' },
    { role: 'user', content: [{ type: 'text', text: 'prompt' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ]), { inputTextChars: 13, imageCount: 1, imageBytes: 3 });
});

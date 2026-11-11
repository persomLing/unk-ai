import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegionReadings, summarizeRegionReadings, regionReadingSources } from '../src/utils/agent-region-data.js';

const reading = (page, rows, overrides = {}) => ({ url: `https://shop.test/models?page=${page}`, title: '商家列表',
  regionKey: 'main-list', query: '缓存命中率', capturedAt: '2026-11-02T08:00:00Z', rows, totalRows: rows.length, ...overrides });
const row = (label, value) => ({ label, text: `${label}\n价格 5元\n缓存命中率 ${value}\n可用率 99.9%` });

test('three-page numeric ranking retains first-page winners independently of body budget', () => {
  let readings = [];
  for (let page = 1; page <= 3; page++) readings = mergeRegionReadings(readings,
    reading(page, Array.from({ length: 59 }, (_, index) => row(`商家${page}-${index}`, `${page === 1 && index === 58 ? 99.8 : page * 10 + index / 10}%`))));
  const result = summarizeRegionReadings(readings);
  assert.equal(result.sources.length, 3);
  assert.equal(result.groups[0].rowCount, 177);
  assert.equal(result.groups[0].rankings[0].highest[0].label, '商家1-58');
  assert.equal(result.groups[0].rankings[0].highest[0].value, 99.8);
  assert.equal(result.truncated, false);
  assert.equal(result.rankingLimit, 20);
});

test('same region reread replaces data while cross-page exact duplicates retain every source', () => {
  let readings = mergeRegionReadings([], reading(1, [row('商家A', '50%')]));
  readings = mergeRegionReadings(readings, reading(1, [row('商家A', '80%')]));
  readings = mergeRegionReadings(readings, reading(2, [row('商家A', '80%'), row('商家B', '60%')]));
  assert.equal(readings.length, 2);
  const result = summarizeRegionReadings(readings);
  assert.equal(result.groups[0].duplicatesRemoved, 1);
  assert.deepEqual(result.groups[0].rankings[0].highest.map(item => item.value), [80, 60]);
  assert.equal(result.groups[0].rankings[0].highest[0].sourceIds.length, 2);
});

test('missing/ambiguous metric never falls back to a different percentage or invents a merchant', () => {
  const result = summarizeRegionReadings([reading(1, [
    row('无数据', '暂无数据'), row('越界', '150%'), row('', '90%'),
    { label: '冲突字段', text: '缓存命中率 30% 缓存命中率 40%' },
    { label: '真实零', text: '缓存命中率：0%' },
  ])]);
  assert.equal(result.groups[0].unresolvedCount, 4);
  assert.deepEqual(result.groups[0].rankings[0].highest.map(item => item.value), [0]);
});

test('unstructured region text remains readable with an explicit excerpt boundary', () => {
  const result = summarizeRegionReadings([reading(1, [], { text: '目标位置的说明正文', query: '' })]);
  assert.equal(result.excerpts[0].text, '目标位置的说明正文');
  assert.equal(result.excerpts[0].sourceId, 1);
});

test('a substring of another metric and multiple occurrences are not a unique metric value', () => {
  const result = summarizeRegionReadings([reading(1, [
    { label: '相似字段', text: '非缓存命中率 90%' },
    { label: '多个字段', text: '缓存命中率 暂无数据\n缓存命中率 80%' },
  ])]);
  assert.equal(result.groups[0].unresolvedCount, 2);
  assert.equal(result.groups[0].rankings.length, 0);
});

test('table metric labels must match exactly; incompatible units are not ranked together', () => {
  const result = summarizeRegionReadings([reading(1, [
    { label: '美元', cells: [{ label: '输入价格', text: '$2/M' }, { label: '输出价格', text: '$100/M' }] },
    { label: '人民币', cells: [{ label: '输入价格', text: '¥1/M' }] },
    { label: '相似表头', cells: [{ label: '输出价格', text: '$0.1/M' }] },
  ], { query: '输入价格' })]);
  assert.equal(result.groups[0].rankings.length, 2);
  assert.equal(result.groups[0].unresolvedCount, 1);
  assert.deepEqual(result.groups[0].rankings.map(group => group.unit).sort(), ['$/M', '¥/M']);
});

test('same merchant with conflicting values is flagged and excluded from definitive ranking', () => {
  const result = summarizeRegionReadings([
    reading(1, [row('重复商家', '70%')]), reading(2, [row('重复商家', '90%'), row('独立商家', '80%')]),
  ]);
  assert.equal(result.groups[0].conflictingLabels, 1);
  assert.equal(result.groups[0].rankings[0].highest[0].label, '独立商家');
  assert.equal(result.groups[0].unresolvedCount, 2);
});

test('bounded storage and prompt explicitly expose incomplete rows and preserve page metadata', () => {
  let readings = [];
  for (let page = 1; page <= 12; page++) readings = mergeRegionReadings(readings,
    reading(page, Array.from({ length: 200 }, (_, index) => ({ ...row(`店${page}-${index}`, '80%'), text: `缓存命中率 80%\n${'长'.repeat(900)}` }))));
  const result = summarizeRegionReadings(readings);
  assert.equal(result.truncated, true);
  assert.ok(result.omittedRows > 0);
  assert.ok(JSON.stringify(readings).length < 250000);
  assert.ok(JSON.stringify(result).length <= 14000);
  assert.equal(regionReadingSources(readings).length, 12);
});

test('malformed or unsafe sources cannot become trusted evidence and input is never mutated', () => {
  const valid = reading(1, [row('商家', '80%')]);
  const original = structuredClone(valid);
  assert.deepEqual(mergeRegionReadings([], { ...valid, url: 'javascript:alert(1)' }), []);
  const state = mergeRegionReadings([], valid);
  valid.rows[0].text = 'changed';
  assert.deepEqual(state[0].rows[0].text, original.rows[0].text);
  const summary = summarizeRegionReadings(state);
  summary.sources[0].title = 'changed';
  assert.equal(state[0].title, original.title);
  assert.equal(regionReadingSources(state)[0].url, original.url);
});

test('rereading a retained page cannot erase evidence of permanently omitted pages', () => {
  let state = [];
  for (let page = 1; page <= 41; page++) state = mergeRegionReadings(state, reading(page, [row(`商家${page}`, '80%')]));
  assert.equal(summarizeRegionReadings(state).omittedReadings, 1);
  state = mergeRegionReadings(state, reading(41, [row('商家41', '81%')]));
  const result = summarizeRegionReadings(state);
  assert.equal(result.omittedReadings, 1);
  assert.equal(result.omittedRows, 1);
  assert.equal(result.truncated, true);
});

test('an unmatched requested field remains explicit in the source and fallback text', () => {
  const result = summarizeRegionReadings([reading(1, [], {
    queryMatched: false, notice: '区域未匹配缓存命中率', text: '这里只是价格筛选区',
  })]);
  assert.equal(result.sources[0].queryMatched, false);
  assert.equal(result.excerpts[0].notice, '区域未匹配缓存命中率');
});

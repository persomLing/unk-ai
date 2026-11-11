import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupplementalReader } from '../src/sidepanel/features/page-reading/supplemental-reading.js';
import { NETWORK_CACHE_TTL_MS } from '../src/sidepanel/features/page-reading/network-reading-cache.js';
import { networkReadingForModel, normalizeNetworkReading } from '../src/utils/network-reading-context.js';
import { normalizePageContext } from '../src/utils/reading-context.js';

const query = '请读取接口数据中的营收';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture(t) {
  const state = { time: Date.parse('2026-11-05T04:00:00Z'), captures: 0, grants: 0, allowed: true, capture: null, grant: null };
  const page = { tabId: 1, url: 'https://example.test/report?quarter=3#summary', documentId: 'document-a',
    title: '公司报告', text: '本页是公司报告，包含营收、成本以及库存的说明。',
    structure: { forms: [{ fields: [{ tag: 'select', label: '币种', selectionKnown: true, selectedOptions: [{ value: 'CNY', text: '人民币' }] }] }] } };
  const identity = value => ({ tabId: value.tabId, expectedUrl: value.expectedUrl || value.url, documentId: value.documentId });
  function response(target, amount = state.captures, extra = {}) {
    return { sessionId: `capture-session-${state.captures}`, status: 'listening', target: identity(target), records: [{
      sourceUrl: 'https://example.test/api/report', statusCode: 200, mimeType: 'application/json', capturedAt: state.time,
      text: JSON.stringify({ 营收: amount, 成本: 40 }), truncated: false, redactions: 0, ...extra,
    }] };
  }
  const reader = createSupplementalReader({
    now: () => state.time,
    networkClient: { capture: async (target, options) => { state.captures += 1; return state.capture ? state.capture(target, options) : response(target); } },
    getNetworkGrant: async (target, options) => {
      state.grants += 1;
      return state.grant ? state.grant(target, options) : { allowed: state.allowed, origin: new URL(target.expectedUrl).origin, target };
    },
  });
  const read = (question = query, options = {}) => {
    const current = options.page || structuredClone(page);
    return reader(question, { page: current, target: identity(current), mode: 'auto', allowNetwork: true,
      cacheScope: { conversationId: 'conversation-a' }, ...options });
  };
  t.after(() => reader.dispose());
  return { reader, state, page, read, response, identity };
}

test('same-page related follow-ups reuse a sanitized response after a fresh background grant check', async t => {
  const { read, state, page } = fixture(t);
  const first = await read();
  state.time += 60000;
  const second = await read('营收为什么变化');
  assert.equal(state.captures, 1);
  assert.equal(state.grants, 1);
  assert.equal(second.networkReading.status, 'reused');
  assert.equal(second.networkReading.records[0].capturedAt, first.networkReading.records[0].capturedAt);
  assert.equal(second.networkReading.cache.capturedAt, first.networkReading.cache.capturedAt);
  assert.equal(second.networkReading.cache.expiresAt, first.networkReading.cache.expiresAt);
  assert.equal(second.networkReading.cache.reusedAt, new Date(state.time).toISOString());
  assert.ok(second.networkReading.note.includes(first.networkReading.cache.capturedAt));
  assert.ok(second.networkReading.note.includes(new Date(state.time).toISOString()));
  assert.ok(!second.readingAssessment.gaps.includes('network-evidence'));
  const model = networkReadingForModel(second.networkReading, page);
  assert.match(model, /复用|本轮未重新监听/);
  assert.match(model, /reusedAt/);
  assert.doesNotMatch(model, /capture-session/);
});

test('an unrelated ordinary turn preserves same-page cache without attaching it to that turn', async t => {
  const { read, state } = fixture(t);
  await read();
  const unrelated = await read('你好');
  assert.equal(unrelated.networkReading, undefined);
  const next = await read('这些营收数据怎么解释');
  assert.equal(next.networkReading.status, 'reused');
  assert.equal(state.captures, 1);
});

test('unrelated API topics require new capture while an earlier matching topic remains reusable', async t => {
  const { read, state } = fixture(t);
  await read();
  const unrelated = await read('请读取接口数据中的库存');
  assert.equal(unrelated.networkReading.status, 'captured');
  assert.equal(state.captures, 2);
  assert.equal((await read()).networkReading.status, 'reused');
  assert.equal(state.captures, 2);
});

test('a related word cannot hide a newly requested field absent from cached JSON', async t => {
  const { read, state } = fixture(t);
  await read();
  assert.equal((await read('请读取接口数据中的营收和净利润')).networkReading.status, 'captured');
  assert.equal(state.captures, 2);
  await read('请读取接口数据中的营收和净利润');
  assert.equal(state.captures, 3, 'an insufficient fresh capture must not become a reusable result');
});

test('conversation, tab, complete URL and document identity isolate responses', async t => {
  const { read, state, page } = fixture(t);
  await read();
  await read(query, { cacheScope: { conversationId: 'conversation-b' } });
  await read(query, { page: { ...page, tabId: 2 } });
  await read(query, { page: { ...page, url: 'https://example.test/report?quarter=4#summary' } });
  await read(query, { page: { ...page, documentId: 'document-reloaded' } });
  assert.equal(state.captures, 5);
  assert.equal(state.grants, 0);
});

test('changed text or selected configuration invalidates old data even at the same URL', async t => {
  const { read, state, page } = fixture(t);
  await read();
  const changed = { ...structuredClone(page), text: `${page.text} 本期财报已经更新。` };
  await read(query, { page: changed });
  assert.equal(state.captures, 2);
  changed.structure.forms[0].fields[0].selectedOptions = [{ value: 'USD', text: '美元' }];
  await read(query, { page: changed });
  assert.equal(state.captures, 3);
  await read(query, { page });
  assert.equal(state.captures, 4, 'returning to old visible content must not resurrect an invalidated capture');
});

test('empty normalized arrays cannot mask changed tables or semantic state retained in structure', async t => {
  const { read, state, page } = fixture(t);
  const initial = normalizePageContext({ ...page, tables: [], semanticTree: [], structure: {
    ...page.structure, tables: [{ headers: ['营收'], rows: [['10']] }],
    semanticTree: [{ type: 'checkbox', text: '季度选项', checked: true }],
  } });
  assert.equal(initial.tables.length, 0);
  assert.equal(initial.semanticTree.length, 0);
  await read(query, { page: initial });
  const changedTable = structuredClone(initial);
  changedTable.structure.tables[0].rows[0][0] = '20';
  await read(query, { page: changedTable });
  assert.equal(state.captures, 2);
  const changedState = structuredClone(changedTable);
  changedState.structure.semanticTree[0].checked = false;
  await read(query, { page: changedState });
  assert.equal(state.captures, 3);
});

test('reuse does not extend the original five-minute expiry and memory keeps at most four captures', async t => {
  const { read, state } = fixture(t);
  const first = await read();
  state.time += NETWORK_CACHE_TTL_MS - 1000;
  assert.equal((await read()).networkReading.cache.expiresAt, first.networkReading.cache.expiresAt);
  state.time += 1000;
  assert.equal((await read()).networkReading.status, 'captured');
  for (const conversationId of ['b', 'c', 'd', 'e']) await read(query, { cacheScope: { conversationId } });
  const previous = state.captures;
  await read();
  assert.equal(state.captures, previous + 1);
});

test('truncated, empty or visibly incomplete evidence is never reused', async t => {
  const { read, state, page, response } = fixture(t);
  state.capture = target => response(target, 1, { truncated: true });
  await read(); await read();
  assert.equal(state.captures, 2);
  state.capture = target => response(target, 1, { text: '{}' });
  await read(); await read();
  assert.equal(state.captures, 4);
  state.capture = null;
  const incomplete = { ...page, truncated: true };
  await read('接口响应中的营收', { page: incomplete });
  await read('接口响应中的营收', { page: incomplete });
  assert.equal(state.captures, 6);
});

test('latest, explicit recapture and reported gaps bypass cache without falling back after failure', async t => {
  const { read, state } = fixture(t);
  await read();
  await read('请读取最新接口数据中的营收');
  assert.equal(state.captures, 2);
  state.capture = () => { throw new Error('capture failed'); };
  await assert.rejects(read('请重新读取接口数据中的营收'), /capture failed/);
  state.capture = null;
  assert.equal((await read()).networkReading.status, 'captured');
  assert.equal(state.captures, 4);
  await read('请读取接口数据，刚才营收数据不完整');
  assert.equal(state.captures, 5);
});

test('revoked permission clears cache and re-enabling requires another capture', async t => {
  const { read, state, reader } = fixture(t);
  await read();
  state.allowed = false;
  await assert.rejects(read(), { code: 'NETWORK_PERMISSION_DENIED' });
  state.allowed = true;
  assert.equal((await read()).networkReading.status, 'captured');
  reader.invalidate({ origin: 'https://example.test' });
  assert.equal((await read()).networkReading.status, 'captured');
  assert.equal(state.captures, 3);
});

test('fresh background validation must return the original complete target', async t => {
  const { read, state } = fixture(t);
  await read();
  state.grant = target => ({ allowed: true, origin: 'https://example.test', target: { ...target, documentId: 'wrong-document' } });
  await assert.rejects(read(), { code: 'PAGE_CHANGED' });
  assert.equal(state.captures, 1);
});

test('cancelled validation cannot return data or clear a later successful reuse', async t => {
  const { read, state } = fixture(t);
  await read();
  const waiting = deferred();
  state.grant = () => waiting.promise;
  const controller = new AbortController();
  const pending = read(query, { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  state.grant = null;
  assert.equal((await read()).networkReading.status, 'reused');
  waiting.resolve({ allowed: true, origin: 'https://example.test', target: { tabId: 1 } }); await tick();
  assert.equal((await read()).networkReading.status, 'reused');
  assert.equal(state.captures, 1);
});

test('cancelled uncooperative capture cannot overwrite or invalidate a newer cached response', async t => {
  const { read, state, response, page, identity } = fixture(t);
  const waiting = deferred();
  state.capture = () => waiting.promise;
  const controller = new AbortController();
  const pending = read(query, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  state.capture = target => response(target, 99);
  await read();
  waiting.resolve(response(identity(page), 1)); await tick();
  const next = await read();
  assert.equal(next.networkReading.status, 'reused');
  assert.match(next.networkReading.records[0].text, /99/);
  assert.equal(state.captures, 2);
});

test('a superseded page observation cannot store a late uncancelled capture', async t => {
  const { read, state, response, page, identity } = fixture(t);
  const waiting = deferred();
  state.capture = () => waiting.promise;
  const pending = read();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick();
  const changed = { ...page, text: `${page.text} 新版本。` };
  state.capture = target => response(target, 99);
  await read(query, { page: changed });
  waiting.resolve(response(identity(page), 1)); await rejected;
  const next = await read(query, { page: changed });
  assert.equal(next.networkReading.status, 'reused');
  assert.match(next.networkReading.records[0].text, /99/);
});

test('missing scope keeps old behavior, and disposal cancels pending reuse and rejects later calls', async t => {
  const { read, state, reader } = fixture(t);
  await read(query, { cacheScope: undefined }); await read(query, { cacheScope: undefined });
  assert.equal(state.captures, 2);
  await read();
  const waiting = deferred(); state.grant = () => waiting.promise;
  const pending = read(); await tick(); reader.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(read(), { name: 'AbortError' });
});

test('saved reused metadata cannot claim a new capture or carry arbitrary cache fields', () => {
  const page = { url: 'https://example.test/report' };
  const normalized = normalizeNetworkReading({ version: 1, status: 'reused', records: [{ sourceUrl: 'https://example.test/api', text: '{"value":1}' }],
    cache: { version: 1, capturedAt: '2026-11-05T04:00:00Z', reusedAt: '2026-11-05T04:01:00Z', expiresAt: '2026-11-05T04:05:00Z', secret: 'never-copy' } }, page);
  assert.equal(normalized.status, 'reused');
  assert.equal(normalized.cache.secret, undefined);
  assert.doesNotMatch(networkReadingForModel(normalized, page), /never-copy/);
  const malformed = normalizeNetworkReading({ ...normalized, cache: { version: 1, capturedAt: 'invalid' } }, page);
  assert.equal(malformed.status, 'unavailable');
  assert.equal(malformed.records.length, 0);
});

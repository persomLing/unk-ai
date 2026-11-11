import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupplementalReader } from '../src/sidepanel/features/page-reading/supplemental-reading.js';
import { normalizeNetworkReading } from '../src/utils/network-reading-context.js';
import { normalizePageContext, pageContextForModel } from '../src/utils/reading-context.js';
import { pageSourceFor } from '../src/utils/turn-source.js';

const page = { tabId: 1, url: 'https://example.test/report', documentId: 'doc-a', text: 'Report body and current page evidence. '.repeat(10) };
const result = records => ({ sessionId: 'session', status: 'listening', target: page, records });
const row = { sourceUrl: 'https://example.test/api/report?token=secret', mimeType: 'application/json', statusCode: 200,
  capturedAt: '2026-11-05T00:00:00Z', text: '{"value":123}', truncated: false, redactions: 0 };

test('authorized explicit API request captures once and keeps bounded data in context, only metadata per turn', async () => {
  let count = 0;
  const read = createSupplementalReader({ networkClient: { capture: async () => { count++; return result([row]); } } });
  const value = normalizePageContext(await read('读取接口数据', { page, target: page, mode: 'auto', allowNetwork: true }));
  assert.equal(count, 1);
  assert.match(pageContextForModel(value), /123/);
  assert.match(pageContextForModel(value), /不可信网页数据/);
  assert.doesNotMatch(JSON.stringify(value.networkReading), /secret|sessionId/);
  assert.equal(pageSourceFor(value).reading.networkCount, 1);
  assert.doesNotMatch(JSON.stringify(pageSourceFor(value)), /123|api\/report/);
});
test('explicit API reading cannot silently fall back when denied or when there is no response', async () => {
  let calls = 0;
  const read = createSupplementalReader({ networkClient: { capture: async () => { calls++; return result([]); } } });
  await assert.rejects(read('查看接口返回', { page, target: page, allowNetwork: false }), { code: 'NETWORK_PERMISSION_DENIED' });
  assert.equal(calls, 0);
  await assert.rejects(read('查看接口返回', { page, target: page, allowNetwork: true }), { code: 'NETWORK_REQUIRED_EMPTY' });
  assert.equal(calls, 1);
});
test('missing table coverage requests deep evidence once, then records optional network gaps without pretending complete', async () => {
  let reads = 0, networks = 0;
  const incomplete = { ...page, tables: [{ rowCount: 30, rows: [[1]] }] };
  const read = createSupplementalReader({ readDeep: async () => {
    reads++; return { ...incomplete, deepReading: { source: 'cdp', available: true } };
  }, networkClient: { capture: async () => { networks++; return result([]); } } });
  const value = await read('给出全部数据的排名', { page: incomplete, target: page, allowNetwork: true });
  assert.equal(reads, 1);
  assert.equal(networks, 1);
  assert.equal(value.networkReading.status, 'empty');
  assert.match(pageContextForModel(value), /不能据此声称完整排名|不代表整页/);
});
test('optional network permission revocation and page changes are not swallowed', async () => {
  const incomplete = { ...page, tables: [{ rowCount: 30, rows: [[1]] }] };
  for (const code of ['NETWORK_PERMISSION_DENIED', 'PAGE_CHANGED']) {
    const read = createSupplementalReader({ readDeep: async () => ({ ...incomplete, deepReading: { source: 'cdp', available: true } }),
      networkClient: { capture: async () => { throw Object.assign(new Error('refused'), { code }); } } });
    await assert.rejects(read('全部数据排名', { page: incomplete, target: page, allowNetwork: true }), { code });
  }
});
test('network normalization strips foreign sources, budgets records and refuses the wrong document', () => {
  const value = normalizeNetworkReading(result([{ ...row, sourceUrl: 'https://other.test/api' },
    ...Array.from({ length: 8 }, () => ({ ...row, text: 'x'.repeat(20000) }))]), page);
  assert.ok(value.records.length <= 6);
  assert.ok(value.records.reduce((n, record) => n + record.text.length, 0) <= 16000);
  assert.equal(value.truncated, true);
  assert.ok(value.records.every(record => record.sourceUrl.startsWith('https://example.test/')));
  assert.throws(() => normalizeNetworkReading({ ...result([row]), target: { ...page, documentId: 'new-doc' } }, page), { code: 'PAGE_CHANGED' });
});

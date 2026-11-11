import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticExporter, diagnosticCoverageText, diagnosticStatusText } from '../src/sidepanel/features/diagnostics/diagnostic-export.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bundle = { format: 'unk-ai-diagnostic-bundle', events: [{ event: 'turn.failed' }], coverage: { partial: true }, status: {} };

test('export fixes Beijing date and conversation before waiting and prevents duplicate downloads', async () => {
  const gate = deferred();
  const scopes = [], downloads = [], notices = [];
  let clock = Date.parse('2026-11-05T16:01:00Z');
  const exporter = createDiagnosticExporter({ now: () => clock,
    collect: scope => { scopes.push(scope); return gate.promise; }, download: output => downloads.push(output),
    notify: message => notices.push(message) });
  const input = { conversationId: 'original' };
  const first = exporter.exportToday(input);
  input.conversationId = 'next'; clock += 86400000;
  assert.equal((await exporter.exportToday(input)).reason, 'busy');
  gate.resolve(bundle);
  assert.equal((await first).ok, true);
  assert.deepEqual(scopes, [{ date: '2026-11-06', conversationId: 'original' }]);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'unk-ai-diagnostics-2026-11-06-conversation.json');
  assert.deepEqual(JSON.parse(await downloads[0].blob.text()), bundle);
  assert.match(notices.at(-1), /缺失或截断/);
});

test('unbound scope cannot accidentally export every conversation; all requires an explicit flag', async () => {
  const scopes = [];
  const exporter = createDiagnosticExporter({ collect: scope => { scopes.push(scope); return bundle; }, download: () => {} });
  assert.equal((await exporter.exportToday()).reason, 'scope');
  assert.equal(scopes.length, 0);
  assert.equal((await exporter.exportToday({ all: true })).ok, true);
  assert.equal(Object.hasOwn(scopes[0], 'conversationId'), false);
});

test('collection timeout and late resolution never trigger a download', async () => {
  const gate = deferred(), downloads = [], notices = [];
  const exporter = createDiagnosticExporter({ collect: () => gate.promise, download: value => downloads.push(value),
    timeoutMs: 10, notify: text => notices.push(text) });
  assert.equal((await exporter.exportToday({ conversationId: 'a' })).reason, 'failed');
  assert.match(notices.at(-1), /超时/);
  gate.resolve(bundle);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloads.length, 0);
});

test('disposal cancels pending collection; download failures stay visible and can be retried', async () => {
  const gate = deferred(), downloads = [], notices = [];
  const first = createDiagnosticExporter({ collect: () => gate.promise, download: value => downloads.push(value) });
  const pending = first.exportToday({ conversationId: 'a' });
  first.dispose(); gate.resolve(bundle);
  assert.equal((await pending).reason, 'cancelled');
  assert.equal(downloads.length, 0);
  let fail = true;
  const second = createDiagnosticExporter({ collect: () => bundle,
    download: () => { if (fail) throw new Error('浏览器下载失败'); }, notify: text => notices.push(text) });
  assert.equal((await second.exportToday({ conversationId: 'a' })).ok, false);
  assert.match(notices.at(-1), /浏览器下载失败/);
  fail = false;
  assert.equal((await second.exportToday({ conversationId: 'a' })).ok, true);
});

test('empty/partial logs and pending writes are never presented as fully saved evidence', () => {
  assert.match(diagnosticCoverageText({ events: [], coverage: { partial: true } }), /没有找到.*无法.*还原/);
  assert.match(diagnosticCoverageText({ events: [], coverage: { partial: true } }), /缺失或截断/);
  assert.match(diagnosticStatusText({ directory: { configured: true, permission: 'denied' },
    pending: { events: 3, unbound: 2 }, dropped: { overflow: 7 }, lastError: {} }), /不可写.*待写 3 条.*未绑定.*未能保留 7 条.*尚未确认写入/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationDiagnostics, diagnosticFailure, observeModelDiagnostic } from '../src/utils/diagnostic-observer.js';
import { sanitizeDiagnosticEvent } from '../src/utils/diagnostic-schema.js';

test('repeated streaming phase notifications do not flood logs or reset phase duration', async () => {
  const events = [];
  const diagnostics = createApplicationDiagnostics({ record: event => events.push(event), runner: { active: () => null }, repository: {} });
  diagnostics.observe({ type: 'started', runId: 'r', phase: 'preparing', at: 0, startedAt: 0 });
  diagnostics.observe({ type: 'phase', runId: 'r', phase: 'answering', at: 10, startedAt: 0 });
  for (let i = 11; i < 500; i++) diagnostics.observe({ type: 'phase', runId: 'r', phase: 'answering', at: i, startedAt: 0 });
  diagnostics.observe({ type: 'terminal', runId: 'r', phase: 'idle', at: 510, startedAt: 0, status: 'completed' });
  assert.equal(events.length, 3);
  const clean = await sanitizeDiagnosticEvent(events[1], { salt: 'salt', now: Date.now(), id: crypto.randomUUID() });
  assert.equal(clean.data.previousPhase, 'preparing');
  assert.equal(clean.data.previousPhaseDurationMs, 10);
  assert.equal(events[2].data.phase, 'answering');
  assert.equal(events[2].data.durationMs, 500);
});

test('port observations retain original owner and target across awaits and rethrow the original error', async () => {
  let resolve, active = { runId: 'run-a', ref: { conversationId: 'a', turnId: 'turn-a' } };
  const events = [];
  const diagnostics = createApplicationDiagnostics({ runner: { active: () => active }, repository: {}, record: event => events.push(event) });
  const failure = new DOMException('page private path permission denied SECRET', 'NotAllowedError');
  const read = diagnostics.wrap(() => new Promise((_yes, reject) => { resolve = reject; }), {
    identify: target => ({ tabId: target.id, documentId: target.documentId }),
  });
  const pending = read({ id: 17, documentId: 'doc-a' });
  active = { runId: 'run-b', ref: { conversationId: 'b', turnId: 'turn-b' } };
  resolve(failure);
  await assert.rejects(pending, error => error === failure);
  assert.equal(events[1].event, 'reading.failed');
  assert.deepEqual(events[1].context, { runId: 'run-a', conversationId: 'a', turnId: 'turn-a', tabId: 17, documentId: 'doc-a' });
  assert.equal(events[1].error.reason, 'permission-denied');
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
});

test('gateway stage metadata survives the persistent schema without payload or raw IDs', async () => {
  const collected = [];
  observeModelDiagnostic(event => collected.push(event), { type: 'model.transport.headers', runId: 'run-secret', requestId: 'query-secret',
    purpose: 'answer', status: 429, contentType: 'application/json', durationMs: 45, firstByteMs: 30, apiKey: 'secret-value' });
  const clean = await sanitizeDiagnosticEvent(collected[0], { salt: 'salt', now: Date.now(), id: crypto.randomUUID() });
  assert.equal(clean.event, 'model.transport.headers');
  assert.equal(clean.data.httpStatus, 429);
  assert.equal(clean.data.purpose, 'answer');
  assert.equal(clean.data.firstByteMs, 30);
  assert.match(clean.context.requestId, /^h_/);
  assert.equal(JSON.stringify(clean).includes('secret'), false);
});

test('failure classification never persists raw messages or stack traces', () => {
  const result = diagnosticFailure({ name: 'TypeError', message: 'Failed to fetch SECRET', stack: 'TOKEN' });
  assert.equal(result.reason, 'network');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('TOKEN'), false);
});

test('known reading and storage failures retain fixed codes and reasons without copying error text', async () => {
  const examples = [
    [{ code: 'NETWORK_REQUIRED_EMPTY', message: '本次监听没有取得可用接口响应；已完成的旧请求无法补抓。' }, 'empty'],
    [{ code: 'DEEP_READING_UNSUPPORTED', message: '当前来源不支持网页深度结构读取。' }, 'unavailable'],
    [{ code: 'PAGE_CHANGED', message: 'network timeout SECRET' }, 'page-changed'],
    [{ code: 'PAGE_NOT_READY', name: 'PageNotReadyError', message: '页面正文仍未加载完成或没有可读内容。' }, 'unavailable'],
    [{ code: 'NETWORK_READING_DISCONNECTED', message: '接口读取连接已断开。' }, 'background-unreachable'],
    [{ code: 'NETWORK_RESPONSE_FORMAT', message: '接口响应不是有效的 JSON。' }, 'malformed'],
    [{ code: 'ERR_DIAGNOSTIC_FILE_CONFLICT', reason: 'file-conflict' }, 'file-conflict'],
    [{ code: 'ERR_DIAGNOSTIC_PERMISSION', reason: 'permission-prompt' }, 'permission-prompt'],
    [{ code: 'ERR_MODEL_TIMEOUT', message: 'SECRET' }, 'timeout'],
  ];
  for (const [input, reason] of examples) {
    const failure = diagnosticFailure(input);
    assert.equal(failure.code, input.code);
    assert.equal(failure.reason, reason);
    const persisted = await sanitizeDiagnosticEvent({ event: 'reading.failed', source: 'page-reading', error: failure },
      { salt: 'salt', now: Date.now(), id: crypto.randomUUID() });
    assert.equal(persisted.error.code, input.code);
    assert.equal(persisted.error.reason, reason);
    assert.equal(JSON.stringify(failure).includes('SECRET'), false);
  }
});

test('failure codes and names use exact allowlists even when arbitrary credentials look like codes', () => {
  for (const code of ['ERR_PRIVATE_BEARER_TOKEN', 'NETWORK_REQUIRED_EMPTY_SECRET', 'sk-private', '__proto__']) {
    const result = diagnosticFailure({ code, name: 'PRIVATE_NAME', reason: 'PRIVATE_REASON', message: 'private message', stack: 'private stack' });
    assert.deepEqual(result, { name: 'Error', reason: 'unknown', code: 'ERR_UNKNOWN' });
  }
  assert.equal(diagnosticFailure({ code: 'ERR_PRIVATE_BEARER_TOKEN', message: 'Failed to fetch' }).code, 'ERR_NETWORK');
  assert.deepEqual(diagnosticFailure({ code: 'ERR_DIAGNOSTIC_PERMISSION', reason: 'PRIVATE_REASON' }),
    { name: 'Error', reason: 'permission-denied', code: 'ERR_DIAGNOSTIC_PERMISSION' });
});

test('failure observations retain only valid numeric HTTP status evidence', () => {
  assert.equal(diagnosticFailure({ status: 503 }).httpStatus, 503);
  assert.equal(diagnosticFailure({ httpStatus: 429 }).httpStatus, 429);
  for (const status of [0, 99, 600, '503 SECRET', Infinity]) {
    assert.equal(diagnosticFailure({ status }).httpStatus, undefined);
  }
});

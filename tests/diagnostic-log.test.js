import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryIndexedDB } from './helpers/memory-indexeddb.js';
import { createDiagnosticLogService } from '../src/utils/diagnostic-log.js';
import { createDiagnosticStore } from '../src/utils/diagnostic-store.js';
import { sanitizeDiagnosticData, validateStoredDiagnostic } from '../src/utils/diagnostic-schema.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function directory(name = 'selected') {
  const files = new Map();
  const children = new Map();
  const control = { permission: 'granted', writes: 0, closes: 0, beforeWrite: null, beforeClose: null };
  const root = {
    kind: 'directory', name, files, children, control,
    async queryPermission() { return control.permission; },
    async isSameEntry(other) { return other === root; },
    async getDirectoryHandle(child, { create = false } = {}) {
      if (!children.has(child)) {
        if (!create) throw new DOMException('missing', 'NotFoundError');
        children.set(child, directory(child));
      }
      return children.get(child);
    },
    async getFileHandle(filename, { create = false } = {}) {
      if (!files.has(filename)) {
        if (!create) throw new DOMException('missing', 'NotFoundError');
        files.set(filename, '');
      }
      return {
        kind: 'file', name: filename,
        async getFile() {
          const text = files.get(filename);
          return { size: new TextEncoder().encode(text).length, text: async () => text };
        },
        async createWritable() {
          let content = '';
          return {
            async write(value) { control.writes += 1; await control.beforeWrite?.(); content = String(value); },
            async close() { control.closes += 1; await control.beforeClose?.(); files.set(filename, content); },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(filename) { files.delete(filename); },
    async *entries() {
      for (const filename of files.keys()) yield [filename, await root.getFileHandle(filename)];
      for (const [name, child] of children) yield [name, child];
    },
  };
  return root;
}

function locks() {
  let busy = false;
  return {
    async request(_name, options, callback) {
      if (busy && options.ifAvailable) return callback(null);
      busy = true;
      try { return await callback({ name: 'test-lock' }); }
      finally { busy = false; }
    },
  };
}

function fixture(options = {}) {
  let now = Date.parse('2026-11-06T16:30:00Z'); // Nov 7 in Beijing.
  let selected = directory();
  const database = memoryIndexedDB();
  const store = createDiagnosticStore({ indexedDB: database, timeoutMs: 60 });
  const configuration = {
    store, now: () => now, getDirectory: async () => selected,
    locks: locks(), autoFlush: false,
    ioTimeoutMs: 60, flushTimeoutMs: 160, collectTimeoutMs: 180,
    ...options,
  };
  return {
    store, database, configuration,
    service: createDiagnosticLogService(configuration),
    get selected() { return selected; },
    setDirectory(value) { selected = value; },
    setNow(value) { now = Date.parse(value); },
  };
}

const event = (context = {}, data = {}) => ({ event: 'agent.action-result', source: 'agent', level: 'error', context, data });

test('diagnostics whitelist evidence, anonymize identifiers, and never persist free text', async () => {
  const f = fixture();
  const secret = 'private-search-phrase';
  const circular = {}; circular.self = circular;
  const saved = await f.service.recordDiagnostic({
    ...event({ conversationId: 'conversation-one', requestId: `search:${secret}`, taskId: 'task-one', tabId: 3 }, {
      ok: false, errorCount: 3, phase: 'action', durationMs: 15,
      origin: `https://alice:password@example.test/path?q=${secret}#key`,
      text: secret, args: circular, goal: secret, headers: { authorization: secret },
    }),
    question: secret, answer: secret, error: { code: 'ERR_ELEMENT_CHANGED', name: 'Error', message: secret, stack: secret, reason: secret },
  });
  assert.equal(saved.buffered, true);
  const bundle = await f.service.collectDiagnosticLogs({ conversationId: 'conversation-one' });
  assert.equal(bundle.date, '2026-11-07');
  assert.equal(bundle.events.length, 1);
  assert.match(bundle.events[0].context.requestId, /^h_[a-f0-9]{64}$/);
  assert.notEqual(bundle.events[0].context.conversationId, 'conversation-one');
  assert.equal(bundle.events[0].context.tabId, 3);
  assert.equal(bundle.events[0].data.origin, 'https://example.test');
  assert.equal(bundle.events[0].error.code, 'ERR_ELEMENT_CHANGED');
  assert.equal(bundle.events[0].data.errorCount, 3);
  assert.ok(!JSON.stringify(bundle).includes(secret));
  assert.ok(!JSON.stringify(await f.store.read()).includes(secret));
  assert.ok(!JSON.stringify(bundle).includes('password'));
});

test('browser buffering commits before disk writes and binds old pending events to their original folder', async () => {
  const f = fixture();
  const first = f.selected;
  first.control.permission = 'denied';
  await f.service.recordDiagnostic(event({ conversationId: 'one' }));
  const replacement = directory('replacement');
  f.setDirectory(replacement);
  await f.service.recordDiagnostic(event({ conversationId: 'two' }));
  await f.service.flushDiagnostics();
  assert.equal((await f.service.getDiagnosticStatus()).pending.events, 1);
  assert.equal(replacement.children.get('diagnostics').files.size, 1);
  const replacementText = [...replacement.children.get('diagnostics').files.values()].join('');
  const firstBundle = await f.service.collectDiagnosticLogs({ conversationId: 'one' });
  assert.equal(firstBundle.events.length, 1);
  assert.ok(!replacementText.includes(firstBundle.events[0].id));
  first.control.permission = 'granted';
  await f.service.flushDiagnostics();
  assert.equal(first.children.get('diagnostics').files.size, 1);
  assert.equal((await f.service.getDiagnosticStatus()).pending.events, 0);
});

test('independent contexts atomically preserve both events and correlate stable hashed IDs', async () => {
  const f = fixture();
  const other = createDiagnosticLogService({ ...f.configuration, store: createDiagnosticStore({ indexedDB: f.database, timeoutMs: 60 }) });
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? other : f.service).recordDiagnostic(event({ conversationId: 'same', taskId: 'same-task' }, { step: i }))));
  const bundle = await other.collectDiagnosticLogs({ conversationId: 'same' });
  assert.equal(bundle.events.length, 12);
  assert.equal(new Set(bundle.events.map(entry => entry.context.taskId)).size, 1);
  await Promise.all([f.service.flushDiagnostics(), other.flushDiagnostics()]);
  const final = await other.collectDiagnosticLogs({ conversationId: 'same' });
  assert.equal(final.events.length, 12);
  assert.equal(new Set(final.events.map(entry => entry.id)).size, 12);
});

test('a timed-out disk close retains immutable batch identity and cannot overwrite newer events', async () => {
  const f = fixture({ ioTimeoutMs: 15, flushTimeoutMs: 30 });
  const logDirectory = await f.selected.getDirectoryHandle('diagnostics', { create: true });
  const gate = deferred();
  logDirectory.control.beforeClose = () => gate.promise;
  await f.service.recordDiagnostic(event({ conversationId: 'one' }, { step: 1 }));
  const timedOut = await f.service.flushDiagnostics();
  assert.equal(timedOut.pending.events, 1);
  assert.equal(logDirectory.control.closes, 1);
  await f.service.recordDiagnostic(event({ conversationId: 'one' }, { step: 2 }));
  await f.service.flushDiagnostics();
  assert.equal(logDirectory.control.closes, 1, 'an uncertain writer remains the owner until actual completion');
  gate.resolve();
  logDirectory.control.beforeClose = null;
  await new Promise(resolve => setTimeout(resolve, 10));
  await f.service.flushDiagnostics();
  const bundle = await f.service.collectDiagnosticLogs({ conversationId: 'one' });
  assert.deepEqual(bundle.events.map(entry => entry.data.step).sort(), [1, 2]);
  assert.equal(logDirectory.files.size, 2);
  assert.equal((await f.service.getDiagnosticStatus()).pending.events, 0);
});

test('buffer limits retain bounded data, count overflow, and leave unbound events unredirected', async () => {
  const f = fixture({ maxPendingEvents: 2, maxPendingBytes: 4096 });
  f.setDirectory(null);
  for (let i = 0; i < 5; i += 1) await f.service.recordDiagnostic(event({ conversationId: 'one' }, { step: i }));
  const status = await f.service.getDiagnosticStatus();
  assert.equal(status.pending.events, 2);
  assert.equal(status.pending.unbound, 2);
  assert.equal(status.dropped.overflow, 3);
  const selected = directory('later');
  f.setDirectory(selected);
  await f.service.flushDiagnostics();
  assert.equal((await f.service.getDiagnosticStatus()).pending.unbound, 2);
  assert.equal(selected.children.get('diagnostics')?.files.size || 0, 0);
});

test('retention removes only verified managed shards outside seven Beijing dates', async () => {
  const f = fixture();
  f.setNow('2026-10-30T16:30:00Z'); // Oct 31.
  await f.service.recordDiagnostic(event({ conversationId: 'old' }));
  await f.service.flushDiagnostics();
  const logDirectory = f.selected.children.get('diagnostics');
  const oldName = [...logDirectory.files.keys()][0];
  logDirectory.files.set('my-notes.json', '{"private":"untouched"}');
  const fakeName = oldName.replace(/-([a-f0-9-]+)\.json$/, '-00000000-0000-4000-8000-000000000000.json');
  logDirectory.files.set(fakeName, '{"private":"also untouched"}');
  f.setNow('2026-10-31T16:30:00Z'); // Nov 1: retained on Nov 7.
  await f.service.recordDiagnostic(event({ conversationId: 'boundary' }));
  await f.service.flushDiagnostics();
  const boundaryName = [...logDirectory.files.keys()].find(name => name.includes('2026-11-01'));
  f.setNow('2026-11-06T16:30:00Z');
  await f.service.flushDiagnostics();
  assert.equal(logDirectory.files.has(oldName), false);
  assert.equal(logDirectory.files.has(boundaryName), true);
  assert.equal(logDirectory.files.has('my-notes.json'), true);
  assert.equal(logDirectory.files.has(fakeName), true);
});

test('export follows conversation run/task associations, excludes other conversations, and labels bounded shared events', async () => {
  const f = fixture({ sharedLimit: 2 });
  await f.service.recordDiagnostic(event({ conversationId: 'wanted', runId: 'run-one', taskId: 'task-one' }));
  await f.service.recordDiagnostic(event({ runId: 'run-one' }, { step: 1 }));
  await f.service.recordDiagnostic(event({ taskId: 'task-one' }, { step: 2 }));
  await f.service.recordDiagnostic(event({ conversationId: 'other', taskId: 'task-one' }, { step: 3 }));
  for (let i = 0; i < 3; i += 1) await f.service.recordDiagnostic({ event: 'runtime.error', source: 'runtime', data: { count: i } });
  await f.service.flushDiagnostics();
  const bundle = await f.service.collectDiagnosticLogs({ conversationId: 'wanted' });
  assert.equal(bundle.events.length, 3);
  assert.equal(bundle.sharedEvents.length, 2);
  assert.equal(bundle.scope.association, 'conversation-and-linked-runs-tasks');
  assert.equal(bundle.coverage.sharedTruncated, true);
  assert.ok(bundle.sharedEvents.every(entry => entry.shared === true));
  assert.equal(bundle.status.version, 1);
});

test('unavailable database, permission waits, malformed input and closed services are bounded and never throw', async () => {
  const hanging = createDiagnosticLogService({
    store: { read: () => new Promise(() => {}), update: () => new Promise(() => {}) },
    getDirectory: () => new Promise(() => {}), ioTimeoutMs: 15, autoFlush: false,
  });
  const begin = Date.now();
  assert.equal((await hanging.recordDiagnostic(event())).accepted, false);
  assert.ok(Date.now() - begin < 200);
  assert.equal((await hanging.getDiagnosticStatus()).available, false);
  const f = fixture();
  const hostile = Object.defineProperty({}, 'event', { get() { throw new Error('private error'); } });
  assert.equal((await f.service.recordDiagnostic(hostile)).accepted, false);
  f.service.dispose();
  assert.equal((await f.service.recordDiagnostic(event())).reason, 'closed');
});

test('existing mismatching shard files are never overwritten and pending evidence is retained', async () => {
  const f = fixture({ flushTimeoutMs: 100 });
  const logs = await f.selected.getDirectoryHandle('diagnostics', { create: true });
  const original = logs.getFileHandle;
  logs.getFileHandle = async function (name, options) {
    if (!logs.files.has(name) && !options?.create) logs.files.set(name, 'user file');
    return original.call(logs, name, options);
  };
  await f.service.recordDiagnostic(event({ conversationId: 'one' }));
  const status = await f.service.flushDiagnostics();
  assert.equal(status.pending.events, 1);
  assert.equal(logs.control.writes, 0);
  assert.equal(status.lastError.code, 'ERR_DIAGNOSTIC_FILE_CONFLICT');
});

test('today export and old-file cleanup are not starved by 700 unrelated or retained entries', async () => {
  const f = fixture({ collectTimeoutMs: 1000, flushTimeoutMs: 1000 });
  const logs = await f.selected.getDirectoryHandle('diagnostics', { create: true });
  for (let index = 0; index < 700; index += 1) {
    logs.files.set(`user-file-${index}.json`, 'untouched');
    logs.files.set(`unk-ai-diagnostic-v1-2026-11-06-${crypto.randomUUID()}.json`, 'not today or expired');
  }
  f.setNow('2026-10-30T16:30:00Z');
  await f.service.recordDiagnostic(event({ conversationId: 'old' }));
  await f.service.flushDiagnostics();
  const oldName = [...logs.files.keys()].find(name => name.includes('2026-10-31'));
  f.setNow('2026-11-06T16:30:00Z');
  await f.service.recordDiagnostic(event({ conversationId: 'today' }));
  await f.service.flushDiagnostics();
  assert.equal(logs.files.has(oldName), false);
  assert.equal(logs.files.has('user-file-0.json'), true);
  const bundle = await f.service.collectDiagnosticLogs({ conversationId: 'today' });
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.coverage.partial, false);
});

test('anonymous run associations survive midnight while export contains only the requested day', async () => {
  const f = fixture();
  f.setNow('2026-11-06T15:59:00Z');
  await f.service.recordDiagnostic({ event: 'turn.bound', source: 'turn-runner', context: { conversationId: 'night', runId: 'overnight' } });
  await f.service.flushDiagnostics();
  f.setNow('2026-11-06T16:01:00Z');
  await f.service.recordDiagnostic({ event: 'model.request.failed', source: 'model-gateway', context: { runId: 'overnight' }, data: { httpStatus: 503 } });
  await f.service.flushDiagnostics();
  const restarted = createDiagnosticLogService(f.configuration);
  const bundle = await restarted.collectDiagnosticLogs({ conversationId: 'night' });
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.events[0].event, 'model.request.failed');
  assert.equal(bundle.date, '2026-11-07');
  assert.equal(bundle.coverage.associationLookbackDays, 7);
});

test('a committed shard with failed acknowledgement is verified on retry without another write', async () => {
  const f = fixture();
  const logs = await f.selected.getDirectoryHandle('diagnostics', { create: true });
  logs.control.beforeClose = () => { f.database.control.failNextWrite = true; };
  await f.service.recordDiagnostic(event({ conversationId: 'one' }));
  await f.service.flushDiagnostics();
  assert.equal((await f.service.getDiagnosticStatus()).pending.events, 1);
  assert.equal(logs.control.writes, 1);
  logs.control.beforeClose = null;
  await f.service.flushDiagnostics();
  assert.equal(logs.control.writes, 1);
  assert.equal((await f.service.getDiagnosticStatus()).pending.events, 0);
  assert.equal((await f.service.collectDiagnosticLogs({ conversationId: 'one' })).events.length, 1);
});

test('export is read-only and still includes pending evidence when a new transaction would fail', async () => {
  const f = fixture({ appVersion: '0.18.0' });
  await f.service.recordDiagnostic(event({ conversationId: 'one' }));
  f.database.control.failNextWrite = true;
  const bundle = await f.service.collectDiagnosticLogs({ conversationId: 'one' });
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.appVersion, '0.18.0');
  assert.equal(bundle.events[0].appVersion, '0.18.0');
  assert.equal(f.database.control.failNextWrite, true, 'export must not require a successful mutation');
});

test('bursts above the 100 in-flight cap count overflow once without counting a database outage', async () => {
  const gate = deferred();
  const f = fixture({ getDirectory: () => gate.promise, ioTimeoutMs: 1000 });
  const records = Array.from({ length: 150 }, (_, step) => f.service.recordDiagnostic(event({ conversationId: 'burst' }, { step })));
  gate.resolve(f.selected);
  const accepted = await Promise.all(records);
  assert.equal(accepted.filter(result => result.accepted).length, 100);
  const status = await f.service.getDiagnosticStatus();
  assert.equal(status.pending.events, 100);
  assert.equal(status.dropped.overflow, 50);
  assert.equal(status.dropped.unavailable, 0);
});

test('successful automatic flushes continue past the batch cap until all buffered records are written', async t => {
  const f = fixture({ maxBatchEvents: 1, maxBatchesPerFlush: 2, autoFlush: true, flushDelayMs: 1, ioTimeoutMs: 1000 });
  t.after(() => f.service.dispose());
  for (let step = 0; step < 5; step += 1) await f.service.recordDiagnostic(event({ conversationId: 'many' }, { step }));
  const deadline = Date.now() + 1000;
  while ((await f.service.getDiagnosticStatus()).pending.events && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.service.getDiagnosticStatus()).pending.events, 0);
  assert.equal(f.selected.children.get('diagnostics').files.size, 5);
});

test('automatic permission failures stop retrying, while a failed old directory does not starve a writable new one', async t => {
  const controls = locks();
  let attempts = 0;
  const f = fixture({ autoFlush: true, flushDelayMs: 1, maxBatchEvents: 1, locks: { request(...args) { attempts += 1; return controls.request(...args); } } });
  t.after(() => f.service.dispose());
  f.selected.control.permission = 'denied';
  for (let step = 0; step < 4; step += 1) await f.service.recordDiagnostic(event({ conversationId: 'old' }, { step }));
  await new Promise(resolve => setTimeout(resolve, 35));
  const failedAttempts = attempts;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(attempts, failedAttempts, 'permission failure must not start an automatic retry loop');
  const writable = directory('writable');
  f.setDirectory(writable);
  await f.service.recordDiagnostic(event({ conversationId: 'new' }));
  await f.service.flushDiagnostics();
  assert.equal(writable.children.get('diagnostics').files.size, 1);
  assert.equal((await f.service.getDiagnosticStatus()).pending.events, 4);
});

test('successful retention chunks reschedule cleanup without requiring another user event', async t => {
  const f = fixture({ autoFlush: true, flushDelayMs: 1, maxCleanupFiles: 2 });
  t.after(() => f.service.dispose());
  f.setNow('2026-10-30T16:30:00Z');
  await f.service.recordDiagnostic(event({ conversationId: 'old' }));
  await f.service.flushDiagnostics();
  const logs = f.selected.children.get('diagnostics');
  const template = JSON.parse([...logs.files.values()][0]);
  for (let index = 0; index < 4; index += 1) {
    const batchId = crypto.randomUUID();
    logs.files.set(`unk-ai-diagnostic-v1-2026-10-31-${batchId}.json`, JSON.stringify({ ...template, batchId }));
  }
  f.setNow('2026-11-06T16:30:00Z');
  await f.service.flushDiagnostics();
  const deadline = Date.now() + 1000;
  while (logs.files.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(logs.files.size, 0);
});

test('runtime locations retain only published extension module shapes and numeric line/column evidence', async () => {
  const f = fixture();
  const allowed = ['service-worker.js', 'src/sidepanel/sidepanel.js', 'src/options/options.js', 'assets/sidepanel-ABc_123.js'];
  for (const module of allowed) {
    await f.service.recordDiagnostic({
      event: 'runtime.error', source: 'runtime', context: { conversationId: 'one' },
      data: { module, line: 42, column: 7, filename: 'https://private.test/secret', stack: 'private trace' },
      error: { name: 'TypeError', message: 'private message', stack: 'private trace' },
    });
  }
  const bundle = await f.service.collectDiagnosticLogs({ conversationId: 'one' });
  assert.deepEqual(bundle.events.map(entry => entry.data.module).sort(), allowed.sort());
  assert.ok(bundle.events.every(entry => entry.data.line === 42 && entry.data.column === 7));
  assert.ok(!JSON.stringify(bundle).includes('private'));
  for (const module of [
    'https://private.test/assets/app.js', 'chrome-extension://id/service-worker.js',
    '/service-worker.js', '../service-worker.js', 'src/sidepanel/../private.js',
    'src/sidepanel/secret/key.js', 'src/options/options.js?token=private',
    'assets/app.js#private', 'assets/app.js\nprivate', 'assets/app.js\n', 'C:\\secret\\app.js',
    `assets/${'a'.repeat(160)}.js`,
  ]) {
    const clean = sanitizeDiagnosticData({ module, line: '42', column: -1 });
    assert.equal(clean.module, undefined, module);
    assert.equal(clean.line, undefined);
    assert.equal(clean.column, undefined);
  }
  const reread = validateStoredDiagnostic({ ...bundle.events[0], data: { module: 'https://private.test/assets/app.js', line: 42, column: 7, stack: 'private trace' } });
  assert.deepEqual(reread.data, { line: 42, column: 7 });
});

test('safe response MIME classes distinguish HTML/plain/JSON errors without retaining arbitrary MIME text', () => {
  for (const contentType of ['application/json', 'text/event-stream', 'text/html', 'text/plain', 'text/json', 'other', 'missing']) {
    assert.equal(sanitizeDiagnosticData({ contentType }).contentType, contentType);
  }
  assert.equal(sanitizeDiagnosticData({ contentType: 'text/html; secret=private' }).contentType, 'other');
  assert.equal(sanitizeDiagnosticData({ contentType: 'private' }).contentType, 'other');
});

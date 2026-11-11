import { getConversationDirectoryHandle } from './local-directory.js';
import { awaitWithTimeout } from './abortable.js';
import { createDiagnosticStore, emptyDiagnosticState } from './diagnostic-store.js';
import { cleanDiagnosticDirectory, readDiagnosticDirectory, writeDiagnosticBatch } from './diagnostic-directory.js';
import {
  DIAGNOSTIC_VERSION, DIAGNOSTIC_RETENTION_DAYS, DIAGNOSTIC_FORMAT, DIAGNOSTIC_BUNDLE_FORMAT,
  beijingDate, oldestDiagnosticDate, diagnosticError, hashDiagnosticId,
  sanitizeDiagnosticEvent, sanitizeDiagnosticError, snapshotDiagnosticInput, validateStoredDiagnostic,
} from './diagnostic-schema.js';

const bytesOf = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;

/** Diagnostic I/O is independent of conversation persistence and cannot own a reply. */
export function createDiagnosticLogService(options = {}) {
  const now = options.now || Date.now;
  const ioTimeoutMs = options.ioTimeoutMs ?? 1000;
  const store = options.store || createDiagnosticStore({ timeoutMs: ioTimeoutMs });
  const getDirectory = options.getDirectory || getConversationDirectoryHandle;
  const maxPendingEvents = options.maxPendingEvents ?? 2000;
  const maxPendingBytes = options.maxPendingBytes ?? 2 * 1024 * 1024;
  const maxBatchEvents = Math.min(options.maxBatchEvents ?? 40, 100);
  const maxBatchesPerFlush = options.maxBatchesPerFlush ?? 25;
  const flushTimeoutMs = options.flushTimeoutMs ?? 3500;
  const collectTimeoutMs = options.collectTimeoutMs ?? 8000;
  const sharedLimit = options.sharedLimit ?? 40;
  const maxAssociations = options.maxAssociations ?? 8000;
  const inflight = new Set();
  let closed = false;
  let schedule = null;
  let flushing = null;
  let lastError = null;
  const volatileDrops = { overflow: 0, unavailable: 0 };

  function appVersion() {
    try {
      const value = options.appVersion || globalThis.chrome?.runtime?.getManifest?.()?.version;
      return typeof value === 'string' && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(value) ? value : 'unknown';
    } catch { return 'unknown'; }
  }

  const wait = (pending, timeoutMs = ioTimeoutMs) => awaitWithTimeout(pending, { timeoutMs });
  function remember(error) {
    try { lastError = sanitizeDiagnosticError(error); }
    catch { lastError = { code: 'ERR_DIAGNOSTIC_UNKNOWN', name: 'Error', reason: 'unknown' }; }
    return lastError;
  }
  function prune(state) {
    const oldest = oldestDiagnosticDate(now());
    const expired = state.entries.filter(entry => entry.date < oldest);
    state.entries = state.entries.filter(entry => entry.date >= oldest);
    state.batches = state.batches.filter(batch => batch.date >= oldest);
    state.links = (state.links || []).filter(link => beijingDate(Date.parse(link.at)) >= oldest);
    state.dropped.expired += expired.length;
  }
  function associate(state, record) {
    const conversationId = record.context.conversationId;
    if (!conversationId) return;
    state.links ||= [];
    for (const kind of ['runId', 'taskId']) {
      const id = record.context[kind];
      if (!id) continue;
      const previous = state.links.find(link => link.kind === kind && link.id === id && link.conversationId === conversationId);
      if (previous) previous.at = record.at;
      else state.links.push({ kind, id, conversationId, at: record.at });
    }
    if (state.links.length > maxAssociations) {
      const excess = state.links.length - maxAssociations;
      state.links.sort((a, b) => a.at.localeCompare(b.at));
      state.links.splice(0, excess);
      state.dropped.associations = (state.dropped.associations || 0) + excess;
    }
  }
  async function metadata() {
    return wait(store.update(state => {
      if (!state.salt) state.salt = globalThis.crypto.randomUUID();
      if (!state.ownerId) state.ownerId = globalThis.crypto.randomUUID();
      if (!state.startedAt) state.startedAt = new Date(now()).toISOString();
      return { salt: state.salt, ownerId: state.ownerId };
    }));
  }
  function requestFlush() {
    if (closed || options.autoFlush === false || schedule) return;
    schedule = setTimeout(() => { schedule = null; void flushDiagnostics(); }, options.flushDelayMs ?? 1000);
    schedule.unref?.();
  }

  function recordDiagnostic(input) {
    if (closed) return Promise.resolve({ accepted: false, buffered: false, reason: 'closed' });
    let snapshot;
    let at;
    let id;
    try { snapshot = snapshotDiagnosticInput(input); at = now(); id = globalThis.crypto.randomUUID(); }
    catch (error) { remember(error); return Promise.resolve({ accepted: false, buffered: false, reason: 'invalid-data' }); }
    if (inflight.size >= 100) { volatileDrops.overflow += 1; return Promise.resolve({ accepted: false, buffered: false, reason: 'overflow' }); }
    const pending = (async () => {
      try {
        const [meta, binding] = await Promise.all([
          metadata(),
          wait(Promise.resolve().then(getDirectory)).then(handle => ({ handle: handle || null }), error => ({ handle: null, error: remember(error) })),
        ]);
        const record = await wait(sanitizeDiagnosticEvent(snapshot, { salt: meta.salt, now: at, id }));
        record.appVersion = appVersion();
        if (closed) return { accepted: false, buffered: false, reason: 'closed' };
        const bytes = bytesOf(record);
        const missed = { ...volatileDrops };
        volatileDrops.overflow = 0;
        volatileDrops.unavailable = 0;
        let result;
        try { result = await wait(store.update(state => {
          prune(state);
          state.dropped.unavailable += missed.unavailable;
          state.dropped.overflow += missed.overflow;
          const used = state.entries.reduce((sum, entry) => sum + entry.bytes, 0);
          if (bytes > 8192 || state.entries.length >= maxPendingEvents || used + bytes > maxPendingBytes) {
            state.dropped.overflow += 1;
            return { accepted: false, buffered: false, reason: 'overflow' };
          }
          state.entries.push({ id, date: beijingDate(at), record, bytes, directoryHandle: binding.handle, batchId: null });
          associate(state, record);
          if (binding.error) state.lastError = binding.error;
          return { accepted: true, buffered: true, id };
        })); } catch (error) { volatileDrops.unavailable += missed.unavailable; volatileDrops.overflow += missed.overflow; throw error; }
        requestFlush();
        return result;
      } catch (error) {
        volatileDrops.unavailable += 1;
        remember(error);
        return { accepted: false, buffered: false, reason: lastError.reason || 'storage-unavailable' };
      }
    })();
    inflight.add(pending);
    void pending.then(() => inflight.delete(pending), () => inflight.delete(pending));
    return pending;
  }

  async function directoryStatus() {
    try {
      const handle = await wait(Promise.resolve().then(getDirectory));
      if (!handle) return { configured: false, permission: 'unconfigured', name: '' };
      const permission = await wait(handle.queryPermission({ mode: 'readwrite' }));
      return { configured: true, permission: ['granted', 'denied', 'prompt'].includes(permission) ? permission : 'unknown', name: String(handle.name || '').slice(0, 100) };
    } catch { return { configured: null, permission: 'unavailable', name: '' }; }
  }

  function statusFor(state, directory, available = true) {
    return {
      version: DIAGNOSTIC_VERSION, available, retentionDays: DIAGNOSTIC_RETENTION_DAYS,
      directory, pending: {
        events: state.entries.length, bytes: state.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        batches: state.batches.length, unbound: state.entries.filter(entry => !entry.directoryHandle).length,
      },
      dropped: { ...state.dropped, overflow: state.dropped.overflow + volatileDrops.overflow, unavailable: state.dropped.unavailable + volatileDrops.unavailable },
      lastWriteAt: state.lastWriteAt, lastError: lastError || state.lastError,
      flushing: Boolean(flushing), closed,
    };
  }

  async function getDiagnosticStatus() {
    try {
      const [stored, directory] = await Promise.allSettled([wait(store.read()), directoryStatus()]);
      if (stored.status === 'rejected') remember(stored.reason);
      return statusFor(stored.status === 'fulfilled' ? stored.value : emptyDiagnosticState(), directory.status === 'fulfilled' ? directory.value : { configured: null, permission: 'unavailable', name: '' }, stored.status === 'fulfilled');
    } catch (error) {
      remember(error);
      return statusFor(emptyDiagnosticState(), { configured: null, permission: 'unavailable', name: '' }, false);
    }
  }

  async function sameDirectory(first, second, checkpoint) {
    if (first === second) return true;
    try { const same = await first.isSameEntry(second); checkpoint(); return same; }
    catch (error) { checkpoint(); return false; }
  }

  async function excludedDirectory(handle, excluded, checkpoint) {
    for (const root of excluded) if (await sameDirectory(root, handle, checkpoint)) return true;
    return false;
  }

  async function prepareBatch(checkpoint, excluded = []) {
    const state = await store.read();
    checkpoint();
    let first;
    for (const entry of state.entries) {
      if (!entry.batchId && entry.directoryHandle && !await excludedDirectory(entry.directoryHandle, excluded, checkpoint)) { first = entry; break; }
    }
    if (!first) return null;
    const selected = [first.id];
    let bytes = first.bytes;
    for (const entry of state.entries) {
      if (entry.id === first.id || entry.batchId || entry.date !== first.date || !entry.directoryHandle) continue;
      if (selected.length >= maxBatchEvents || bytes + entry.bytes > 128 * 1024) break;
      if (await sameDirectory(first.directoryHandle, entry.directoryHandle, checkpoint)) { selected.push(entry.id); bytes += entry.bytes; }
    }
    checkpoint();
    const id = globalThis.crypto.randomUUID();
    return store.update(current => {
      prune(current);
      const entries = current.entries.filter(entry => selected.includes(entry.id) && !entry.batchId);
      if (!entries.length) return null;
      const content = JSON.stringify({
        format: DIAGNOSTIC_FORMAT, version: DIAGNOSTIC_VERSION, ownerId: current.ownerId,
        batchId: id, date: first.date, createdAt: new Date(now()).toISOString(),
        eventCount: entries.length, events: entries.map(entry => entry.record),
      });
      const batch = { id, date: first.date, directoryHandle: first.directoryHandle, content };
      for (const entry of entries) entry.batchId = id;
      current.batches.push(batch);
      return batch;
    });
  }

  async function flushWorker(deadline, outcome) {
    const checkpoint = () => {
      if (closed) throw diagnosticError('ERR_DIAGNOSTIC_CLOSED', 'closed');
      if (Date.now() >= deadline) throw diagnosticError('ERR_DIAGNOSTIC_TIMEOUT', 'timeout', 'TimeoutError');
    };
    checkpoint();
    await store.update(prune);
    checkpoint();
    const selected = await getDirectory();
    checkpoint();
    const roots = selected ? [selected] : [];
    const attempted = outcome.attempted;
    const failedRoots = [];
    let failure = null;
    for (let count = 0; count < maxBatchesPerFlush; count += 1) {
      const state = await store.read();
      checkpoint();
      let batch;
      for (const candidate of state.batches) {
        if (!attempted.has(candidate.id) && !await excludedDirectory(candidate.directoryHandle, failedRoots, checkpoint)) { batch = candidate; break; }
      }
      batch ||= await prepareBatch(checkpoint, failedRoots);
      checkpoint();
      if (!batch) break;
      attempted.add(batch.id);
      let knownRoot = false;
      for (const root of roots) if (await sameDirectory(root, batch.directoryHandle, checkpoint)) { knownRoot = true; break; }
      if (!knownRoot) roots.push(batch.directoryHandle);
      try {
        await writeDiagnosticBatch(batch, checkpoint);
        // A confirmed close may arrive late. Ack only this immutable batch, never newer entries.
        await store.update(current => {
          current.entries = current.entries.filter(entry => entry.batchId !== batch.id);
          current.batches = current.batches.filter(value => value.id !== batch.id);
          current.lastWriteAt = new Date(now()).toISOString();
        });
        outcome.progressed += 1;
      } catch (error) { failure = remember(error); failedRoots.push(batch.directoryHandle); }
      checkpoint();
    }
    const meta = await store.read();
    checkpoint();
    for (const root of roots) {
      try {
        const cleanup = await cleanDiagnosticDirectory(root, { ownerId: meta.ownerId, oldestDate: oldestDiagnosticDate(now()), checkpoint, maxFiles: options.maxCleanupFiles ?? 600 });
        outcome.cleaned += cleanup.removed;
        outcome.cleanupLimited ||= cleanup.limited;
      }
      catch (error) { failure ||= remember(error); }
      checkpoint();
    }
    lastError = failure;
    await store.update(state => { state.lastError = failure; });
  }

  async function flushDiagnostics() {
    try {
      await wait(Promise.allSettled([...inflight]));
      if (closed) return getDiagnosticStatus();
      if (!flushing) {
        const locks = options.locks || globalThis.navigator?.locks;
        if (!locks?.request) {
          remember(diagnosticError('ERR_DIAGNOSTIC_LOCK', 'lock-unavailable'));
          return getDiagnosticStatus();
        }
        const deadline = Date.now() + flushTimeoutMs;
        const outcome = { progressed: 0, attempted: new Set(), cleaned: 0, cleanupLimited: false };
        // Do not release the cross-context lock on caller timeout. Late file close remains serialized.
        const actual = Promise.resolve(locks.request('unk-ai-diagnostics:disk:v1', { ifAvailable: true }, lock => {
          if (!lock) return;
          return flushWorker(deadline, outcome);
        })).catch(error => { remember(error); });
        flushing = actual;
        void actual.then(async () => {
          if (flushing === actual) flushing = null;
          // Continue successful bounded chunks. Failed/permission-lost folders alone never spin.
          if (closed || options.autoFlush === false) return;
          if (outcome.cleaned && outcome.cleanupLimited) requestFlush();
          if (!outcome.progressed) return;
          try {
            const remaining = await wait(store.read());
            if (remaining.entries.some(entry => entry.directoryHandle && (!entry.batchId || !outcome.attempted.has(entry.batchId)))) requestFlush();
          } catch { /* A new event or explicit flush can retry unavailable storage. */ }
        });
      }
      await wait(flushing, flushTimeoutMs);
    } catch (error) { remember(error); }
    return getDiagnosticStatus();
  }

  async function collectDiagnosticLogs({ date, conversationId } = {}) {
    const generatedAt = new Date(now()).toISOString();
    const selectedDate = date === undefined ? beijingDate(now()) : String(date);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)
      && Number.isFinite(Date.parse(`${selectedDate}T00:00:00Z`))
      && new Date(`${selectedDate}T00:00:00Z`).toISOString().slice(0, 10) === selectedDate;
    const coverage = { sources: ['browser-buffer', 'selected-directory'], retentionDays: DIAGNOSTIC_RETENTION_DAYS, associationLookbackDays: DIAGNOSTIC_RETENTION_DAYS, filesRead: 0, partial: false, reasons: [], sharedTruncated: false, otherDirectoriesIncluded: false, droppedScope: 'all-contexts' };
    let state = emptyDiagnosticState();
    let events = [];
    let target;
    const deadline = Date.now() + collectTimeoutMs;
    const collectWait = pending => {
      if (Date.now() >= deadline) {
        void Promise.resolve(pending).catch(() => {});
        return Promise.reject(diagnosticError('ERR_DIAGNOSTIC_TIMEOUT', 'timeout', 'TimeoutError'));
      }
      return wait(pending, Math.max(1, Math.min(ioTimeoutMs, deadline - Date.now())));
    };
    try {
      if (!validDate || selectedDate < oldestDiagnosticDate(now()) || selectedDate > beijingDate(now())) throw diagnosticError('ERR_DIAGNOSTIC_DATE', 'invalid-data');
      await collectWait(Promise.allSettled([...inflight]));
      state = await collectWait(store.read());
      if (conversationId) target = await collectWait(hashDiagnosticId(conversationId, state.salt));
      const selected = await collectWait(Promise.resolve().then(getDirectory));
      const disk = selected ? await readDiagnosticDirectory(selected, { ownerId: state.ownerId, date: selectedDate, wait: collectWait }) : { events: [], filesRead: 0, partial: false, reasons: [] };
      coverage.filesRead = disk.filesRead;
      coverage.partial = disk.partial;
      coverage.reasons.push(...disk.reasons);
      events = disk.events;
    } catch (error) {
      coverage.partial = true;
      coverage.reasons.push(sanitizeDiagnosticError(error)?.reason || 'unknown');
    }
    // Pending records survive unavailable folders and are useful in the diagnostic bundle.
    events.push(...state.entries.filter(entry => entry.date === selectedDate).map(entry => entry.record));
    events = [...new Map(events.map(validateStoredDiagnostic).filter(Boolean).map(entry => [entry.id, entry])).values()]
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    coverage.totalDayEvents = events.length;
    coverage.recordingStartedAt = state.startedAt || null;
    coverage.firstEventAt = events[0]?.at || null;
    coverage.lastEventAt = events.at(-1)?.at || null;
    const related = new Set();
    if (target) for (const link of state.links || []) {
      if (link.conversationId === target && beijingDate(Date.parse(link.at)) >= oldestDiagnosticDate(now())) {
        if (link.kind === 'runId') related.add(`run:${link.id}`);
        if (link.kind === 'taskId') related.add(`task:${link.id}`);
      }
    }
    if (target) for (const entry of events) if (entry.context.conversationId === target) {
      if (entry.context.runId) related.add(`run:${entry.context.runId}`);
      if (entry.context.taskId) related.add(`task:${entry.context.taskId}`);
    }
    const shared = conversationId ? events.filter(entry => !entry.context.conversationId && !entry.context.runId && !entry.context.taskId && ['storage', 'diagnostics', 'runtime', 'options'].includes(entry.source)) : [];
    const matched = !conversationId ? events : events.filter(entry => target && (entry.context.conversationId === target
      || (!entry.context.conversationId && (related.has(`run:${entry.context.runId}`) || related.has(`task:${entry.context.taskId}`)))));
    coverage.sharedTruncated = shared.length > sharedLimit;
    coverage.matchedEvents = matched.length;
    const status = await getDiagnosticStatus();
    coverage.associationsTruncated = Boolean(status.dropped.associations);
    if (!status.available || status.dropped.overflow || status.dropped.unavailable || coverage.associationsTruncated) coverage.partial = true;
    if (status.dropped.overflow) coverage.reasons.push('buffer-overflow');
    if (status.dropped.unavailable || !status.available) coverage.reasons.push('buffer-unavailable');
    if (coverage.associationsTruncated) coverage.reasons.push('association-limit');
    coverage.reasons = [...new Set(coverage.reasons)];
    return {
      format: DIAGNOSTIC_BUNDLE_FORMAT, version: DIAGNOSTIC_VERSION, appVersion: appVersion(), date: selectedDate,
      timezone: 'Asia/Shanghai', generatedAt,
      capabilities: { persistentBuffer: status.available, fileSystemDirectory: status.directory.configured === true, crossContextFileLock: Boolean((options.locks || globalThis.navigator?.locks)?.request), anonymizedIdentifiers: true },
      scope: { conversationId: target || null, association: conversationId ? 'conversation-and-linked-runs-tasks' : 'all-conversations', identifiers: 'salted-sha256', sharedLimit },
      coverage,
      // Folder labels belong to local UI, not exported evidence.
      status: { ...status, directory: { configured: status.directory.configured, permission: status.directory.permission } },
      events: matched, sharedEvents: shared.slice(-sharedLimit).map(entry => ({ ...entry, shared: true })),
    };
  }

  function dispose() {
    closed = true;
    clearTimeout(schedule);
    schedule = null;
  }
  return { recordDiagnostic, getDiagnosticStatus, flushDiagnostics, collectDiagnosticLogs, dispose };
}

let defaultService;
const service = () => defaultService ||= createDiagnosticLogService();
export const recordDiagnostic = event => {
  try { return service().recordDiagnostic(event); }
  catch { return Promise.resolve({ accepted: false, buffered: false, reason: 'unavailable' }); }
};
export const getDiagnosticStatus = () => service().getDiagnosticStatus();
export const flushDiagnostics = () => service().flushDiagnostics();
export const collectDiagnosticLogs = options => service().collectDiagnosticLogs(options);

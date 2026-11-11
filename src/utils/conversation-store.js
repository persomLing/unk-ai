import {
  clearTemporaryConversation,
  getTemporaryConversation,
  listLegacyConversationRecords,
  removeLegacyConversationRecords,
  saveTemporaryConversation,
} from './storage.js';
import {
  deleteConversationRecord,
  getConversationDirectoryHandle,
  readAllConversationRecords,
  readConversationRecord,
  writeConversationRecord,
} from './local-directory.js';
import {
  acknowledgeConversationWrite,
  bindConversationWriteTarget,
  forgetConversationWrite,
  getConversationDeletion,
  getConversationWriteTarget,
  getPendingConversationWrite,
  listPendingConversationWrites,
  listConversationDeletions,
  restoreConversationDeletion,
  stageConversationDeletion,
  stageConversationWrite,
  updatePendingConversationWrite,
  updateConversationDeletion,
  withConversationSyncLock,
} from './conversation-outbox.js';
import { awaitWithAbort } from './abortable.js';
import { hydrateConversationImages } from './conversation-images.js';

const DEFAULT_SYNC_WAIT_MS = 1500;
const syncJobs = new Map();
const deletionOperations = new Map();
const DEFAULT_HISTORY_WAIT_MS = 5000;

function newId() {
  return globalThis.crypto.randomUUID();
}

function timestamp() {
  return new Date().toISOString();
}

function normalize(record) {
  const copy = structuredClone(record);
  if (!Array.isArray(copy.messages)) copy.messages = [];
  copy.messages.forEach((message) => {
    if (message?.status === 'streaming') {
      message.status = 'stopped';
      delete message.reasoningStartedAt;
      delete message.reasoningFinishedAt;
    }
  });
  return copy;
}

function entry(conversation) {
  return {
    id: conversation.id,
    title: conversation.title || '未命名会话',
    updatedAt: conversation.updatedAt || conversation.createdAt || '',
    messageCount: conversation.messages?.length || 0,
    compressed: Boolean(conversation.contextSummary?.text),
    syncStatus: conversation.syncStatus || 'synced',
    syncError: conversation.syncError || '',
    syncDirectoryName: conversation.syncDirectoryName || '',
  };
}

export async function createTemporaryConversation(title = '新对话') {
  const current = await getTemporaryConversation();
  if (current) await clearTemporaryConversation();
  const createdAt = timestamp();
  const conversation = {
    version: 2,
    id: newId(),
    storage: 'temporary',
    title,
    createdAt,
    updatedAt: createdAt,
    messages: [],
  };
  return saveTemporaryConversation(conversation);
}

export async function loadTemporaryConversation() {
  return getTemporaryConversation();
}

export async function promoteTemporaryConversation(conversation, { waitForSync = true, timeoutMs } = {}) {
  const promoted = {
    ...conversation,
    storage: 'local',
    updatedAt: timestamp(),
  };
  const saved = waitForSync
    ? await saveLocalConversation(promoted, { timeoutMs })
    : await commitLocalConversation(promoted);
  // Pending still means the complete record has committed to the durable outbox.
  await clearTemporaryConversation();
  return saved;
}

async function stageLocalConversation(conversation) {
  const saved = normalize({ ...conversation, storage: 'local', syncStatus: 'synced', syncError: '' });
  const target = await getConversationWriteTarget(saved.id) || await getConversationDirectoryHandle();
  // This transaction is the required save boundary. It must never wait for a
  // disk writer or the Web Lock that protects that writer.
  return stageConversationWrite(saved, target);
}

function pendingConversation(pending, error = pending.error || '') {
  return {
    ...pending.conversation,
    syncStatus: 'pending',
    syncError: error,
    syncDirectoryName: pending.directoryHandle?.name || '',
  };
}

/** Commit browser storage durably, then synchronize the folder in the background. */
export async function commitLocalConversation(conversation) {
  const pending = await stageLocalConversation(conversation);
  scheduleConversationSync(pending.id).catch(() => {});
  return pendingConversation(pending);
}

/** Compatibility API for callers that also want a bounded folder-sync attempt. */
export async function saveLocalConversation(conversation, options = {}) {
  const pending = await stageLocalConversation(conversation);
  return waitForConversationSync(pending, scheduleConversationSync(pending.id), options);
}

function scheduleConversationSync(id) {
  const existing = syncJobs.get(id);
  if (existing) {
    existing.requested = true;
    return existing.promise;
  }
  const job = { requested: false, promise: null };
  const cleanup = () => {
    if (syncJobs.get(id) === job) syncJobs.delete(id);
  };
  job.promise = withConversationSyncLock(async () => {
    let saved = null;
    try {
      do {
        job.requested = false;
        // A queued task must not write its original snapshot: another document
        // may have committed and synchronized a newer revision in the meantime.
        const pending = await getPendingConversationWrite(id);
        if (!pending) return saved;
        saved = await synchronizeEntry(pending);
        const latest = await getPendingConversationWrite(id);
        if (latest && latest.revision !== pending.revision) job.requested = true;
      } while (job.requested);
      return saved;
    } finally {
      cleanup();
    }
  }, id);
  syncJobs.set(id, job);
  // Also clean up if acquiring a Web Lock itself fails.
  job.promise.then(cleanup, cleanup);
  return job.promise;
}

async function waitForConversationSync(pending, task, { timeoutMs = DEFAULT_SYNC_WAIT_MS } = {}) {
  const delay = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : DEFAULT_SYNC_WAIT_MS;
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), delay);
    task.then(
      (saved) => { clearTimeout(timer); resolve({ saved }); },
      (error) => { clearTimeout(timer); resolve({ error }); },
    );
  });
  if (outcome.timedOut) return pendingConversation(pending);
  if (outcome.error) return pendingConversation(pending, outcome.error.message || '文件夹同步暂时不可用。');
  // Another panel may already have synchronized the record before our task ran.
  const status = outcome.saved || { syncStatus: 'synced', syncError: '', syncDirectoryName: pending.directoryHandle?.name || '' };
  return {
    ...pending.conversation,
    syncStatus: status.syncStatus,
    syncError: status.syncError,
    syncDirectoryName: status.syncDirectoryName,
  };
}

async function synchronizeEntry(pending) {
  try {
    const lifecycle = await getConversationDeletion(pending.id);
    if (lifecycle && lifecycle.state !== 'restored') {
      await acknowledgeConversationWrite(pending.id, pending.revision);
      return { ...pending.conversation, syncStatus: 'deleted' };
    }
    if (!pending.directoryHandle) {
      pending.directoryHandle = await getConversationWriteTarget(pending.id) || await getConversationDirectoryHandle();
      pending.conversation.syncDirectoryName = pending.directoryHandle?.name || '';
      // If a newer commit replaced this revision while resolving its target,
      // let the worker pick up that commit before touching the disk.
      if (!await updatePendingConversationWrite(pending)) return pendingConversation(pending);
    }
    await writeConversationRecord(pending.conversation, { directoryHandle: pending.directoryHandle });
    await acknowledgeConversationWrite(pending.id, pending.revision);
    return { ...pending.conversation, syncStatus: 'synced', syncError: '', syncDirectoryName: pending.directoryHandle?.name || '' };
  } catch (error) {
    pending.error = error.message || '本地文件夹暂时不可写。';
    // The original record is already durable even if recording this error fails.
    await updatePendingConversationWrite(pending).catch(() => {});
    return pendingConversation(pending);
  }
}

/** Retry once on startup, after restoring permission, or when explicitly saving. */
export async function retryPendingConversationWrites(options = {}) {
  const entries = await listPendingConversationWrites();
  // Separate conversations can sync independently even when one disk writer
  // stalls. Each wait is bounded, but the underlying writer retains its lock.
  const savedEntries = await Promise.all(entries.map((pending) =>
    waitForConversationSync(pending, scheduleConversationSync(pending.id), options)));
  const result = { synced: 0, pending: 0, errors: [], conversations: [] };
  for (const saved of savedEntries) {
    result.conversations.push({ id: saved.id, syncStatus: saved.syncStatus, syncError: saved.syncError, syncDirectoryName: saved.syncDirectoryName });
    if (saved.syncStatus === 'synced') result.synced += 1;
    else {
      result.pending += 1;
      if (saved.syncError) result.errors.push({ id: saved.id, message: saved.syncError });
    }
  }
  return result;
}

export const initializeConversationSync = retryPendingConversationWrites;
export const flushConversationWrites = retryPendingConversationWrites;

export async function listSavedConversations() {
  const directoryHandle = await getConversationDirectoryHandle();
  const records = await readAllConversationRecords({ directoryHandle });
  const combined = new Map(records.map((record) => [record.id, { ...record, syncDirectoryName: directoryHandle?.name || '' }]));
  // Pending records remain discoverable even when folder access has expired.
  for (const pending of await listPendingConversationWrites()) {
    combined.set(pending.id, {
      ...pending.conversation,
      syncStatus: 'pending',
      syncError: pending.error || '',
      syncDirectoryName: pending.directoryHandle?.name || '',
    });
  }
  const deleted = new Set((await listConversationDeletions()).filter(record => record.state !== 'restored').map(record => record.id));
  return [...combined.values()].filter(record => !deleted.has(record.id)).map(entry).sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt)) || String(left.id).localeCompare(String(right.id)));
}

export async function loadConversation(id) {
  const temporary = await getTemporaryConversation();
  if (temporary?.id === id) return temporary;
  const lifecycle = await getConversationDeletion(id);
  if (lifecycle && lifecycle.state !== 'restored') return null;
  const pending = await getPendingConversationWrite(id);
  if (pending) {
    const current = await getConversationDeletion(id);
    if (current && current.state !== 'restored') return null;
    const hydrated = await hydrateConversationImages(normalize({ ...pending.conversation, syncStatus: 'pending', syncError: pending.error || '', syncDirectoryName: pending.directoryHandle?.name || '' }), { directoryHandle: pending.directoryHandle });
    const latest = await getConversationDeletion(id);
    return latest && latest.state !== 'restored' ? null : hydrated;
  }
  const directoryHandle = await getConversationDirectoryHandle();
  const record = await readConversationRecord(id, { directoryHandle });
  const current = await getConversationDeletion(id);
  if (current && current.state !== 'restored') return null;
  if (record) await bindConversationWriteTarget(id, directoryHandle);
  const hydrated = record ? await hydrateConversationImages(record, { directoryHandle }) : null;
  const latest = await getConversationDeletion(id);
  if (latest && latest.state !== 'restored') return null;
  return hydrated ? normalize({ ...hydrated, ...(latest?.generation ? { storageGeneration: latest.generation } : {}), storage: 'local', syncStatus: 'synced', syncError: '', syncDirectoryName: directoryHandle?.name || '' }) : null;
}

function historyWaitMs(timeoutMs) {
  return Number.isFinite(timeoutMs) ? Math.min(30000, Math.max(1, timeoutMs)) : DEFAULT_HISTORY_WAIT_MS;
}

function boundedHistoryRead(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时，请稍后重新核对。`)), historyWaitMs(timeoutMs));
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function checkHistoryOperation(guard) {
  if (guard.cancelled) throw new Error('等待保存或读取超时，本次操作未开始修改会话。');
}

function historyRead(promise, guard) {
  return awaitWithAbort(promise, guard.controller.signal);
}

/** The observer is bounded; an in-flight transaction or disk operation keeps its lock. */
function observeHistoryOperation(id, operation, { timeoutMs } = {}) {
  const guard = { phase: 'waiting', cancelled: false, expired: false, controller: new AbortController() };
  const task = withConversationSyncLock(() => operation(guard), id);
  const observed = new Promise(resolve => {
    const timer = setTimeout(() => {
      guard.expired = true;
      if (guard.phase === 'waiting' || guard.phase === 'reading') {
        guard.cancelled = true;
        guard.controller.abort(new Error('等待保存或读取超时，本次操作未开始修改会话。'));
        resolve({ id, kind: 'failed', message: '等待保存或读取超时，本次操作未开始修改会话。' });
      } else {
        resolve({ id, kind: 'pending', message: '操作已开始，但完成结果尚未确认；请重新核对或撤销，已提交的恢复记录会保留。' });
      }
    }, historyWaitMs(timeoutMs));
    task.then(
      value => { clearTimeout(timer); resolve({ id, ...value }); },
      error => { clearTimeout(timer); resolve({ id, kind: 'failed', message: error?.message || '会话操作失败。' }); },
    );
  });
  return { task, observed };
}

function comparableRecord(value, root = true) {
  if (Array.isArray(value)) return value.map(item => comparableRecord(item, false));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !root || !['syncStatus', 'syncError', 'syncDirectoryName'].includes(key))
    .map(key => [key, comparableRecord(value[key], false)]));
}

async function sameDirectory(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left.isSameEntry !== 'function') return false;
  return left.isSameEntry(right);
}

async function recordFingerprint(record) {
  if (!record) return null;
  const data = new TextEncoder().encode(JSON.stringify(comparableRecord(record)));
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function deleteForHistory(id, token, directoryAtSubmission, deletedAt, guard) {
  checkHistoryOperation(guard);
  guard.phase = 'reading';
  const previous = await historyRead(getConversationDeletion(id), guard);
  checkHistoryOperation(guard);
  if (previous && previous.state !== 'restored') throw new Error('该会话已经删除，可使用已有删除记录撤销。');
  const pending = await historyRead(getPendingConversationWrite(id), guard);
  const target = pending?.directoryHandle || await historyRead(getConversationWriteTarget(id), guard) || directoryAtSubmission;
  checkHistoryOperation(guard);
  const disk = await historyRead(readConversationRecord(id, { directoryHandle: target }), guard);
  checkHistoryOperation(guard);
  const fingerprint = await historyRead(recordFingerprint(disk), guard);
  checkHistoryOperation(guard);
  let deleted;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await historyRead(getPendingConversationWrite(id), guard);
    checkHistoryOperation(guard);
    if (latest && !await historyRead(sameDirectory(latest.directoryHandle, target), guard)) throw new Error('会话的存储目录已变化，请重新打开后再删除。');
    checkHistoryOperation(guard);
    guard.phase = 'committing';
    try {
      deleted = await stageConversationDeletion(id, pending?.conversation || (disk ? normalize({ ...disk, storage: 'local' }) : null), target, { token, diskFingerprint: fingerprint, deletedAt, expectedPendingRevision: latest?.revision || null });
      break;
    } catch (error) {
      if (error.code !== 'CONVERSATION_REVISION_CHANGED' || attempt === 2) throw error;
      if (guard.expired) throw new Error('删除提交未完成且等待已超时，请重新核对会话。');
      guard.phase = 'reading';
      checkHistoryOperation(guard);
    }
  }
  guard.phase = 'deleting';
  try {
    await deleteConversationRecord(id, { directoryHandle: deleted.directoryHandle });
    await updateConversationDeletion(id, token, { state: 'deleted', completedAt: timestamp(), error: '' });
    return { kind: 'deleted' };
  } catch (error) {
    // The backup+tombstone transaction already committed. A diagnostic failure
    // cannot turn a deleted/unknown disk result into a successful deletion.
    await updateConversationDeletion(id, token, { state: 'pending', error: error?.message || '文件夹删除尚未完成。' }).catch(() => {});
    return { kind: 'pending', message: error?.message || '文件夹删除尚未完成，恢复记录已保留。' };
  }
}

/** Delete only saved local records. Browser backups and per-id fences make undo safe. */
export async function trashSavedConversations(ids, options = {}) {
  if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    throw new TypeError('请选择 1 至 200 条有效的本地对话。');
  }
  const uniqueIds = [...new Set(ids)];
  const token = newId();
  const deletedAt = timestamp();
  if (!uniqueIds.length) return { token, deletedIds: [], pendingIds: [], failed: [] };
  const directory = await boundedHistoryRead(getConversationDirectoryHandle(), options.timeoutMs, '读取原存储目录');
  const jobs = uniqueIds.map(id => observeHistoryOperation(id, guard => deleteForHistory(id, token, directory, deletedAt, guard), options));
  deletionOperations.set(token, { ids: uniqueIds, deletedAt });
  Promise.allSettled(jobs.map(job => job.task)).then(() => deletionOperations.delete(token));
  const results = await Promise.all(jobs.map(job => job.observed));
  return {
    token,
    deletedIds: results.filter(result => result.kind === 'deleted').map(result => result.id),
    pendingIds: results.filter(result => result.kind === 'pending').map(result => result.id),
    failed: results.filter(result => result.kind === 'failed').map(({ id, message }) => ({ id, message })),
    pending: results.filter(result => result.kind === 'pending').map(({ id, message }) => ({ id, message })),
  };
}

async function restoreForHistory(id, token, guard) {
  checkHistoryOperation(guard);
  guard.phase = 'reading';
  const deleted = await historyRead(getConversationDeletion(id), guard);
  checkHistoryOperation(guard);
  if (!deleted || deleted.token !== token) throw new Error('删除记录已变化，无法覆盖当前会话。');
  if (deleted.state === 'restored') return { kind: 'restored', storageGeneration: deleted.generation };
  const current = await historyRead(readConversationRecord(id, { directoryHandle: deleted.directoryHandle }), guard);
  checkHistoryOperation(guard);
  const currentFingerprint = await historyRead(recordFingerprint(current), guard);
  const backupFingerprint = await historyRead(recordFingerprint(deleted.conversation), guard);
  checkHistoryOperation(guard);
  if (current && currentFingerprint !== deleted.diskFingerprint && currentFingerprint !== backupFingerprint) {
    throw new Error('原目录中已有不同的会话内容，撤销不会覆盖新文件。');
  }
  guard.phase = 'committing';
  const restored = await restoreConversationDeletion(id, token);
  if (restored.alreadyRestored) return { kind: 'restored', storageGeneration: restored.storageGeneration };
  guard.phase = 'syncing';
  // This operation already owns the same disk lock as ordinary writers.
  // Synchronize directly to avoid waiting on a job queued behind ourselves.
  const latest = await getPendingConversationWrite(id);
  const result = latest ? await synchronizeEntry(latest) : { syncStatus: 'synced' };
  return { kind: 'restored', storageGeneration: restored.conversation.storageGeneration, syncStatus: result.syncStatus, syncDirectoryName: restored.directoryHandle?.name || '' };
}

export async function restoreTrashedConversations(token, options = {}) {
  if (typeof token !== 'string' || !token) throw new TypeError('缺少有效的删除记录。');
  const records = await boundedHistoryRead(listConversationDeletions(), options.timeoutMs, '读取恢复记录');
  const ids = [...new Set([...records.filter(record => record.token === token).map(record => record.id), ...(deletionOperations.get(token)?.ids || [])])];
  const results = await Promise.all(ids.map(id => observeHistoryOperation(id, guard => restoreForHistory(id, token, guard), options).observed));
  return {
    token,
    restoredIds: results.filter(result => result.kind === 'restored').map(result => result.id),
    pendingIds: results.filter(result => result.kind === 'pending').map(result => result.id),
    failed: results.filter(result => result.kind === 'failed').map(({ id, message }) => ({ id, message })),
    conversations: results.filter(result => result.kind === 'restored').map(({ id, storageGeneration, syncStatus, syncDirectoryName }) => ({ id, storageGeneration, syncStatus, syncDirectoryName })),
  };
}

/** Recover the latest still-active undo token after closing/reopening the side panel. */
export async function getLatestConversationDeletion(options = {}) {
  const records = (await boundedHistoryRead(listConversationDeletions(), options.timeoutMs, '读取最近删除记录'))
    .filter(record => record.state !== 'restored' && record.conversation)
    .sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)) || String(right.token).localeCompare(String(left.token)));
  if (!records.length) return null;
  const latest = records[0];
  const sameBatch = records.filter(record => record.token === latest.token);
  return { token: latest.token, ids: sameBatch.map(record => record.id), deletedAt: latest.deletedAt, pendingIds: sameBatch.filter(record => record.state === 'pending').map(record => record.id) };
}

export async function commitConversationByStorage(conversation) {
  if (conversation.storage === 'temporary') return saveTemporaryConversation(conversation);
  return commitLocalConversation(conversation);
}

export async function saveConversationByStorage(conversation, options = {}) {
  if (conversation.storage === 'temporary') return saveTemporaryConversation(conversation);
  return saveLocalConversation(conversation, options);
}

export async function deleteSavedConversation(conversation) {
  if (!conversation) return false;
  if (conversation.storage === 'temporary') {
    await clearTemporaryConversation();
    return true;
  }
  return withConversationSyncLock(async () => {
    const pending = await getPendingConversationWrite(conversation.id);
    const directoryHandle = await getConversationWriteTarget(conversation.id) || await getConversationDirectoryHandle();
    const deleted = await deleteConversationRecord(conversation.id, { directoryHandle });
    await forgetConversationWrite(conversation.id, pending?.revision || null);
    return deleted;
  }, conversation.id);
}

/**
 * Move records created by earlier versions out of chrome.storage.local.
 * Local files win when both copies exist, so this is safe to run repeatedly.
 */
export async function migrateLegacyConversations() {
  const legacy = await listLegacyConversationRecords();
  if (!legacy.length) return { migrated: 0 };
  const existing = new Map((await readAllConversationRecords()).map((record) => [record.id, record]));
  const migratedIds = [];
  for (const conversation of legacy) {
    const current = existing.get(conversation.id);
    if (!current || String(conversation.updatedAt) > String(current.updatedAt)) {
      await writeConversationRecord({ ...conversation, storage: 'local' });
      migratedIds.push(conversation.id);
    } else {
      migratedIds.push(conversation.id);
    }
  }
  await removeLegacyConversationRecords(migratedIds);
  return { migrated: migratedIds.length };
}


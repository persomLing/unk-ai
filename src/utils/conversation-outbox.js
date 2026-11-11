const DATABASE_NAME = 'unk-ai-conversation-sync';
const OUTBOX = 'outbox';
const TARGETS = 'targets';
const TRASH = 'trash';
const localQueues = new Map();

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('浏览器本地数据库不可用，无法安全保存会话。'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      for (const name of [OUTBOX, TARGETS, TRASH]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('无法打开会话同步数据库。'));
    request.onblocked = () => reject(new Error('会话同步数据库升级被其他窗口阻止，请关闭旧侧栏后重试。'));
  });
}

async function transaction(stores, mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(failure || tx.error || new Error('会话同步数据库写入失败。'));
      tx.onabort = () => reject(failure || tx.error || new Error('会话同步数据库事务已取消。'));
      try {
        operation(tx, (value) => { result = value; }, (error) => { failure = error; tx.abort(); });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    database.close();
  }
}

/**
 * Serialize disk access for one conversation across side panels. Browser
 * commits do not take this lock: a disconnected disk must not block the outbox.
 * A caller timing out must keep the operation (and its lock) alive until the
 * actual writer has finished, otherwise an older writer can close last.
 */
export function withConversationSyncLock(operation, conversationId = 'legacy') {
  const key = `unk-ai-conversation-sync:${conversationId}`;
  const pending = (localQueues.get(key) || Promise.resolve()).catch(() => {}).then(() => {
    const locks = globalThis.navigator?.locks;
    return locks?.request ? locks.request(key, operation) : operation();
  });
  localQueues.set(key, pending);
  const cleanup = () => {
    if (localQueues.get(key) === pending) localQueues.delete(key);
  };
  pending.then(cleanup, cleanup);
  return pending;
}

function requireConversationId(conversation) {
  if (!conversation || typeof conversation.id !== 'string' || !conversation.id) {
    throw new TypeError('A conversation with a valid id is required.');
  }
}

export function stageConversationWrite(conversation, selectedDirectory) {
  requireConversationId(conversation);
  return transaction([OUTBOX, TARGETS, TRASH], 'readwrite', (tx, finish, fail) => {
    const targets = tx.objectStore(TARGETS);
    const lifecycle = tx.objectStore(TRASH).get(conversation.id);
    lifecycle.onsuccess = () => {
      const deleted = lifecycle.result;
      if (deleted && deleted.state !== 'restored') {
        const error = new Error('该会话已删除，迟到的保存不会重新创建它。');
        error.code = 'CONVERSATION_DELETED';
        fail(error);
        return;
      }
      if (deleted?.generation && conversation.storageGeneration !== deleted.generation) {
        const error = new Error('该会话的旧保存版本已失效，请重新打开恢复后的对话。');
        error.code = 'CONVERSATION_GENERATION_MISMATCH';
        fail(error);
        return;
      }
      const request = targets.get(conversation.id);
      request.onsuccess = () => {
        // A folder switch must never redirect an already-bound conversation.
        const directoryHandle = request.result || selectedDirectory || null;
        const entry = {
          id: conversation.id,
          revision: globalThis.crypto.randomUUID(),
          conversation: { ...conversation, syncDirectoryName: directoryHandle?.name || '' },
          directoryHandle,
          queuedAt: new Date().toISOString(),
          error: '',
        };
        if (directoryHandle) targets.put(directoryHandle, conversation.id);
        tx.objectStore(OUTBOX).put(entry, conversation.id);
        finish(entry);
      };
    };
  });
}

export function getConversationDeletion(id) {
  return transaction([TRASH], 'readonly', (tx, finish) => {
    const request = tx.objectStore(TRASH).get(id);
    request.onsuccess = () => finish(request.result || null);
  });
}

export function listConversationDeletions() {
  return transaction([TRASH], 'readonly', (tx, finish) => {
    const request = tx.objectStore(TRASH).getAll();
    request.onsuccess = () => finish(request.result || []);
  });
}

/** The backup, tombstone and outbox removal commit together before touching disk. */
export function stageConversationDeletion(id, candidate, directoryHandle, { token, diskFingerprint, deletedAt, expectedPendingRevision } = {}) {
  if (typeof id !== 'string' || !id || !token) throw new TypeError('A conversation id and deletion token are required.');
  return transaction([OUTBOX, TARGETS, TRASH], 'readwrite', (tx, finish, fail) => {
    const trash = tx.objectStore(TRASH);
    const previous = trash.get(id);
    previous.onsuccess = () => {
      if (previous.result && previous.result.state !== 'restored') {
        if (previous.result.token === token) finish(previous.result);
        else fail(new Error('该会话已经删除，请使用原删除记录撤销。'));
        return;
      }
      const outbox = tx.objectStore(OUTBOX);
      const pending = outbox.get(id);
      pending.onsuccess = () => {
        if (expectedPendingRevision !== undefined && (pending.result?.revision || null) !== expectedPendingRevision) {
          const error = new Error('会话保存版本已变化，请重新核对后删除。');
          error.code = 'CONVERSATION_REVISION_CHANGED';
          fail(error);
          return;
        }
        // A new commit may arrive while the caller reads the old disk record.
        // Its complete durable revision is the only valid undo snapshot.
        const conversation = pending.result?.conversation || candidate;
        if (!conversation?.id || conversation.id !== id || conversation.storage === 'temporary') {
          fail(new Error('未找到可删除的本地会话，临时对话不能在历史列表中删除。'));
          return;
        }
        const entry = {
          id, token, state: 'pending', conversation,
          directoryHandle: directoryHandle || null,
          revision: pending.result?.revision || null,
          diskFingerprint: diskFingerprint || null,
          deletedAt: deletedAt || new Date().toISOString(),
          error: '',
        };
        trash.put(entry, id);
        outbox.delete(id);
        if (entry.directoryHandle) tx.objectStore(TARGETS).put(entry.directoryHandle, id);
        finish(entry);
      };
    };
  });
}

export function updateConversationDeletion(id, token, patch) {
  return transaction([TRASH], 'readwrite', (tx, finish) => {
    const store = tx.objectStore(TRASH);
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result;
      if (!current || current.token !== token || current.state === 'restored') { finish(false); return; }
      store.put({ ...current, ...patch, id, token }, id);
      finish(true);
    };
  });
}

/** Undo creates one new outbox revision and invalidates every pre-delete snapshot. */
export function restoreConversationDeletion(id, token) {
  return transaction([OUTBOX, TARGETS, TRASH], 'readwrite', (tx, finish, fail) => {
    const trash = tx.objectStore(TRASH);
    const request = trash.get(id);
    request.onsuccess = () => {
      const deleted = request.result;
      if (!deleted || deleted.token !== token) { fail(new Error('删除记录已变化，无法覆盖当前会话。')); return; }
      if (deleted.state === 'restored') { finish({ alreadyRestored: true, id, storageGeneration: deleted.generation }); return; }
      if (!deleted.conversation) { fail(new Error('该删除记录没有可恢复的备份。')); return; }
      const outbox = tx.objectStore(OUTBOX);
      const pending = outbox.get(id);
      pending.onsuccess = () => {
        if (pending.result) { fail(new Error('已有新的会话内容，撤销不会覆盖它。')); return; }
        const generation = globalThis.crypto.randomUUID();
        const entry = {
          id, revision: globalThis.crypto.randomUUID(),
          conversation: { ...deleted.conversation, storage: 'local', storageGeneration: generation, syncDirectoryName: deleted.directoryHandle?.name || '' },
          directoryHandle: deleted.directoryHandle || null,
          queuedAt: new Date().toISOString(), error: '',
        };
        outbox.put(entry, id);
        if (entry.directoryHandle) tx.objectStore(TARGETS).put(entry.directoryHandle, id);
        // Retain only the generation fence once the full record is durable in
        // the outbox. Repeating undo cannot replay the old backup over new data.
        trash.put({ id, token, state: 'restored', generation, deletedAt: deleted.deletedAt, restoredAt: new Date().toISOString() }, id);
        finish(entry);
      };
    };
  });
}

export function listPendingConversationWrites() {
  return transaction([OUTBOX], 'readonly', (tx, finish) => {
    const request = tx.objectStore(OUTBOX).getAll();
    request.onsuccess = () => finish(request.result || []);
  });
}

export function getPendingConversationWrite(id) {
  return transaction([OUTBOX], 'readonly', (tx, finish) => {
    const request = tx.objectStore(OUTBOX).get(id);
    request.onsuccess = () => finish(request.result || null);
  });
}

export function getConversationWriteTarget(id) {
  return transaction([TARGETS], 'readonly', (tx, finish) => {
    const request = tx.objectStore(TARGETS).get(id);
    request.onsuccess = () => finish(request.result || null);
  });
}

export function bindConversationWriteTarget(id, directoryHandle) {
  if (!directoryHandle) return Promise.resolve();
  return transaction([TARGETS], 'readwrite', (tx) => {
    tx.objectStore(TARGETS).put(directoryHandle, id);
  });
}

export function updatePendingConversationWrite(entry) {
  return transaction([OUTBOX, TARGETS], 'readwrite', (tx, finish) => {
    const store = tx.objectStore(OUTBOX);
    const request = store.get(entry.id);
    request.onsuccess = () => {
      if (request.result?.revision !== entry.revision) {
        finish(false);
        return;
      }
      store.put(entry, entry.id);
      if (entry.directoryHandle) tx.objectStore(TARGETS).put(entry.directoryHandle, entry.id);
      finish(true);
    };
  });
}

export function acknowledgeConversationWrite(id, revision) {
  return transaction([OUTBOX], 'readwrite', (tx) => {
    const store = tx.objectStore(OUTBOX);
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result?.revision === revision) store.delete(id);
    };
  });
}

export function forgetConversationWrite(id, revision) {
  return transaction([OUTBOX, TARGETS], 'readwrite', (tx) => {
    const store = tx.objectStore(OUTBOX);
    const request = store.get(id);
    request.onsuccess = () => {
      // A commit made while deletion was waiting on the disk is still durable.
      if (revision !== undefined && (request.result?.revision || null) !== revision) return;
      store.delete(id);
      tx.objectStore(TARGETS).delete(id);
    };
  });
}

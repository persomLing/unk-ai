import { DIAGNOSTIC_VERSION, diagnosticError } from './diagnostic-schema.js';

export function emptyDiagnosticState() {
  return { version: DIAGNOSTIC_VERSION, salt: '', ownerId: '', startedAt: null, links: [], entries: [], batches: [], dropped: { overflow: 0, expired: 0, unavailable: 0, associations: 0 }, lastWriteAt: null, lastError: null };
}

/** One atomic state transaction makes append/claims/counters safe across extension contexts. */
export function createDiagnosticStore({ indexedDB, timeoutMs = 1000 } = {}) {
  function open() {
    return new Promise((resolve, reject) => {
      const databaseApi = indexedDB || globalThis.indexedDB;
      if (!databaseApi) { reject(diagnosticError('ERR_DIAGNOSTIC_DATABASE', 'storage-unavailable')); return; }
      let ended = false;
      const timer = setTimeout(() => { ended = true; reject(diagnosticError('ERR_DIAGNOSTIC_TIMEOUT', 'timeout', 'TimeoutError')); }, timeoutMs);
      let request;
      try { request = databaseApi.open('unk-ai-diagnostics', 1); }
      catch (error) { clearTimeout(timer); reject(error); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
      };
      request.onsuccess = () => {
        if (ended) { request.result.close(); return; }
        ended = true; clearTimeout(timer);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      const fail = () => { if (!ended) { ended = true; clearTimeout(timer); reject(request.error || diagnosticError('ERR_DIAGNOSTIC_DATABASE', 'storage-unavailable')); } };
      request.onerror = fail;
      request.onblocked = fail;
    });
  }

  async function transaction(mutator) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('state', mutator ? 'readwrite' : 'readonly');
        let result;
        let failure;
        const timer = setTimeout(() => {
          failure = diagnosticError('ERR_DIAGNOSTIC_TIMEOUT', 'timeout', 'TimeoutError');
          try { tx.abort(); } catch { reject(failure); }
        }, timeoutMs);
        tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
        tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(failure || tx.error || diagnosticError('ERR_DIAGNOSTIC_DATABASE', 'storage-failed')); };
        const store = tx.objectStore('state');
        const request = store.get('current');
        request.onsuccess = () => {
          try {
            const state = request.result || emptyDiagnosticState();
            if (state.version !== DIAGNOSTIC_VERSION) throw diagnosticError('ERR_DIAGNOSTIC_VERSION', 'database-version');
            if (mutator) {
              result = mutator(state);
              if (result?.then) throw diagnosticError('ERR_DIAGNOSTIC_ASYNC_MUTATION', 'invalid-data');
              store.put(state, 'current');
            } else result = state;
          } catch (error) { failure = error; tx.abort(); }
        };
      });
    } finally { db.close(); }
  }
  return { read: () => transaction(), update: mutator => transaction(mutator) };
}

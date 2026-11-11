// Transaction-aware IndexedDB fixture. Directory handles stand in for the
// browser's structured-cloneable FileSystemDirectoryHandle objects.
function copy(value) {
  if (!value || typeof value !== 'object') return value;
  if (typeof value.queryPermission === 'function') return value;
  if (Array.isArray(value)) return value.map(copy);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
}

export function memoryIndexedDB() {
  const databases = new Map();
  const versions = new Map();
  const transactionQueues = new Map();
  const control = { failNextWrite: false };
  return {
    control,
    open(name, requestedVersion) {
      const request = {};
      queueMicrotask(() => {
        const previousVersion = versions.get(name) || 0;
        const nextVersion = requestedVersion || previousVersion || 1;
        if (nextVersion < previousVersion) {
          request.error = new DOMException('Requested version is older than the database', 'VersionError');
          request.onerror?.();
          return;
        }
        const upgrade = nextVersion > previousVersion;
        if (!databases.has(name)) databases.set(name, new Map());
        versions.set(name, nextVersion);
        const stores = databases.get(name);
        request.result = {
          objectStoreNames: { contains: (key) => stores.has(key) },
          createObjectStore(key) { stores.set(key, new Map()); },
          close() {},
          transaction(names, mode) {
            const selected = Array.isArray(names) ? names : [names];
            let working;
            let pending = 0;
            let active = true;
            let started = false;
            const requests = [];
            const queue = transactionQueues.get(name) || [];
            transactionQueues.set(name, queue);
            function release() {
              queue.shift();
              if (queue.length) queueMicrotask(queue[0]);
            }
            const tx = {
              abort() {
                if (!active) return;
                active = false;
                queueMicrotask(() => { tx.onabort?.(); release(); });
              },
              objectStore(key) {
                function run(operation) {
                  const result = {};
                  pending += 1;
                  const perform = () => queueMicrotask(() => {
                    if (!active) return;
                    try {
                      result.result = operation(working.get(key));
                      result.onsuccess?.();
                    } catch (error) {
                      result.error = error;
                      tx.error = error;
                      result.onerror?.();
                      tx.abort();
                    }
                    pending -= 1;
                    complete();
                  });
                  if (started) perform();
                  else requests.push(perform);
                  return result;
                }
                return {
                  get: (id) => run((values) => copy(values.get(id))),
                  getAll: () => run((values) => [...values.values()].map(copy)),
                  put: (value, id) => run((values) => { values.set(id, copy(value)); return id; }),
                  delete: (id) => run((values) => values.delete(id)),
                };
              },
            };
            function complete() {
              queueMicrotask(() => {
                if (!active || pending) return;
                if (mode === 'readwrite' && control.failNextWrite) {
                  control.failNextWrite = false;
                  tx.error = new DOMException('Disk quota exceeded', 'QuotaExceededError');
                  tx.abort();
                  return;
                }
                active = false;
                if (mode === 'readwrite') for (const [key, values] of working) stores.set(key, values);
                tx.oncomplete?.();
                release();
              });
            }
            // Real IndexedDB serializes overlapping read/write transactions.
            // Start snapshots after preceding commits rather than letting the
            // fixture's last whole-store copy erase unrelated concurrent saves.
            queue.push(() => {
              working = new Map(selected.map((key) => [key, new Map([...stores.get(key)].map(([id, value]) => [id, copy(value)]))]));
              started = true;
              for (const request of requests) request();
              complete();
            });
            if (queue.length === 1) queueMicrotask(queue[0]);
            return tx;
          },
        };
        if (upgrade) request.onupgradeneeded?.({ oldVersion: previousVersion, newVersion: nextVersion });
        request.onsuccess?.();
      });
      return request;
    },
  };
}

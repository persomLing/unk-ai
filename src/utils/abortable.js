/** Stop waiting promptly while safely observing completion of non-cancellable work. */
export function awaitWithAbort(pending, signal) {
  if (!signal) return Promise.resolve(pending);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, signal.reason || new DOMException('请求已取消', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(pending).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) cancel();
  });
}

/** Bound preparation I/O without leaving rejected late completions unobserved. */
export async function awaitWithTimeout(pending, { signal, timeoutMs = 15000, message = '准备请求超时，请重试。' } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException(message, 'TimeoutError')), timeoutMs);
  try { return await awaitWithAbort(pending, controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

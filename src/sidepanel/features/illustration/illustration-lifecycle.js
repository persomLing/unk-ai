import { awaitWithAbort } from '../../../utils/abortable.js';

export const illustrationKey = ref => JSON.stringify([ref.conversationId, ref.turnId, ref.runId, ref.assistantId, ref.userId]);

/** Cancellable post-turn ownership. Image generation has no elapsed-time
 * limit; planning, browser capture and verification keep their own bounds. */
export function createIllustrationScope({ repository, isCurrent = () => true, onCancel = () => {} }) {
  const jobs = new Map();
  let disposed = false;
  function owned(ref, content) {
    if (disposed || !isCurrent(ref)) return null;
    const pair = repository.get(ref);
    if (!pair || pair.assistant.status !== 'complete' || pair.assistant.terminalRunId !== ref.runId
      || (content !== undefined && pair.assistant.content !== content)) return null;
    return pair;
  }
  function open(ref, content) {
    const key = illustrationKey(ref), controller = new AbortController();
    const job = { ref, signal: controller.signal,
      owned: () => owned(ref, content),
      read: () => controller.signal.aborted ? null : owned(ref, content),
      finish() { if (jobs.get(key) === job) jobs.delete(key); },
      cancel(reason) {
        if (controller.signal.aborted) return;
        try { onCancel(job); } catch { /* Cancellation must still revoke every job. */ }
        finally { controller.abort(reason); job.finish(); }
      },
    };
    jobs.set(key, job);
    return job;
  }
  function cancel(assistantId, reason = new DOMException('配图已取消。', 'AbortError')) {
    let changed = false;
    for (const job of [...jobs.values()]) if (!assistantId || job.ref.assistantId === assistantId) { job.cancel(reason); changed = true; }
    return changed;
  }
  return Object.freeze({ owned, open, cancel,
    active: (conversationId, assistantId) => [...jobs.values()].some(job => job.ref.conversationId === conversationId
      && job.ref.assistantId === assistantId && Boolean(job.read())),
    dispose() { cancel(); disposed = true; },
  });
}

/** A timed read/capture must also revoke the underlying port or model request,
 * not just release its caller's wait. Never use this around image generation. */
export async function illustrationStage(operation, { signal, timeoutMs, message }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException(message, 'TimeoutError')), timeoutMs);
  try {
    if (signal?.aborted) cancel();
    controller.signal.throwIfAborted();
    return await awaitWithAbort(Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }), controller.signal);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

export function illustrationFailure(error, phase, profile) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined;
  const reason = error?.code === 'ILLUSTRATION_PROMPT_INVALID' ? 'prompt-invalid'
    : error?.code === 'ILLUSTRATION_PLAN_INVALID' ? 'plan-invalid'
    : error?.code === 'ERR_IMAGE_MODEL_MISSING' ? 'no-image-model'
    : error?.name === 'TimeoutError' ? 'timeout'
      : status === 429 ? 'rate-limit' : status === 401 || status === 403 ? 'access-denied'
        : phase === 'plan' ? 'plan-failed' : phase === 'save' ? 'save-failed' : phase === 'verify' ? 'verify-failed' : 'generate-failed';
  let message = String(error?.message || '').replace(/bearer\s+\S+/gi, 'Bearer [redacted]');
  for (const key of [profile?.apiKey, profile?.imageProfile?.apiKey]) {
    if (typeof key === 'string' && key.trim()) message = message.split(key).join('[redacted]').split(key.trim()).join('[redacted]');
  }
  return { version: 1, status: 'unavailable', reason, ...(status ? { httpStatus: status } : {}),
    ...(message ? { message: message.slice(0, 300) } : {}) };
}

/** Saved loading boxes cannot resume a charged request after a reload. */
export function settleInterruptedIllustrations(conversation, isActive = () => false) {
  let changed = false;
  for (const message of conversation?.messages || []) {
    if (message.role !== 'assistant') continue;
    if (isActive(message.id)) continue;
    for (const field of ['illustration', 'videoIllustration']) {
      const info = message[field];
      if (!info || info.status !== 'generating') continue;
      message[field] = { ...info, status: 'unavailable', reason: 'interrupted',
        items: (Array.isArray(info.items) ? info.items : []).map(item => item.status === 'loading' ? { ...item, status: 'unavailable', reason: 'interrupted' } : item) };
      changed = true;
    }
  }
  return changed;
}

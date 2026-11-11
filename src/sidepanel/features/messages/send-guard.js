/**
 * Prevent the same prompt from being submitted twice by a rapid click/Enter
 * duplicate. Queueing must not bypass this check.
 */
export const DUPLICATE_SEND_WINDOW_MS = 1200;

/** Snapshot the capabilities with the prompt so switching mode creates a new turn. */
export function sendFingerprint({ text = '', selection, attachments = [], agentTask = false, pageContextEnabled = false, readingPolicy, readingOptions } = {}) {
  return JSON.stringify({
    text: String(text), selection: selection || null,
    attachments: attachments.map(item => item.id), agentTask: Boolean(agentTask),
    pageContextEnabled: Boolean(pageContextEnabled),
    readingScope: readingPolicy ? `${readingPolicy.version}:${readingPolicy.scope}:${readingPolicy.intent}` : '',
    readingOptions: pageContextEnabled ? readingOptions || null : null,
  });
}

export function isDuplicateSend({
  fingerprint,
  lastFingerprint,
  lastSentAt,
  now = Date.now(),
  windowMs = DUPLICATE_SEND_WINDOW_MS,
} = {}) {
  return Boolean(
    fingerprint
    && fingerprint === lastFingerprint
    && Number.isFinite(lastSentAt)
    && now - lastSentAt < windowMs,
  );
}

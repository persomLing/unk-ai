/** Per-turn capabilities. Missing historical records deliberately stay basic. */
export function normalizeReadingOptions(value, fallback = 'basic') {
  const mode = value?.version === 1 && ['basic', 'auto', 'deep'].includes(value.mode) ? value.mode : fallback;
  return { version: 1, mode, allowNetwork: value?.version === 1 && value.allowNetwork === true };
}

export function captureReadingHistory(messages = []) {
  return messages.slice(-12).filter(message => ['user', 'assistant'].includes(message?.role)).map(message => ({
    id: message.id, role: message.role, content: String(message.displayContent || message.content || '').slice(0, 2000),
    mode: message.mode, agentTask: message.agentTask === true, pageContextEnabled: message.pageContextEnabled,
    ...(message.pageSource ? { pageSource: { ...message.pageSource } } : {}),
    ...(message.status ? { status: message.status } : {}),
  }));
}

export function readingOptionsAtSubmission(state, options, enabled) {
  if (!enabled) return normalizeReadingOptions(null);
  if (options.readingOptions) return normalizeReadingOptions(options.readingOptions);
  let origin = '';
  try { origin = new URL(state.activePageSignal?.url).origin; } catch {}
  return normalizeReadingOptions({ version: 1,
    mode: options.deep === true ? 'deep' : state.readingMode || 'auto',
    allowNetwork: Boolean(origin && state.networkReadingGrant?.origin === origin && state.networkReadingGrant.allowed),
  }, 'auto');
}

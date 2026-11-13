/** Per-turn capabilities. Missing historical records deliberately stay basic. */
export function normalizeReadingOptions(value, fallback = 'basic') {
  if (value?.version === 2) {
    const allowed = value.networkPolicy === 'page-turn' && value.allowNetwork === true;
    return { version: 2, mode: ['basic', 'auto', 'deep'].includes(value.mode) ? value.mode : fallback,
      allowNetwork: allowed, networkPolicy: allowed ? 'page-turn' : 'disabled' };
  }
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

export function readingOptionsAtSubmission(_state, options, enabled) {
  if (!enabled) return normalizeReadingOptions(null);
  if (options.readingOptions) return normalizeReadingOptions(options.readingOptions);
  return normalizeReadingOptions({ version: 2,
    mode: options.deep === true ? 'deep' : 'auto',
    allowNetwork: true, networkPolicy: 'page-turn',
  }, 'auto');
}

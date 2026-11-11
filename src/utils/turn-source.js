/** Small, persistent provenance records; page bodies are never copied per turn. */
export function pageSourceFor(page) {
  if (!page?.url) return null;
  return {
    url: String(page.url),
    title: String(page.title || '').slice(0, 300),
    capturedAt: String(page.capturedAt || ''),
    ...(Number.isInteger(page.tabId) ? { tabId: page.tabId } : {}),
    ...(page.documentId ? { documentId: page.documentId } : {}),
    ...(page.readingAssessment ? { reading: {
      mode: page.readingAssessment.mode, status: page.readingAssessment.status,
      supplemented: page.readingAssessment.addedEvidence === true,
      rechecked: page.readingAssessment.rechecked === true,
      note: String(page.readingAssessment.note || '').slice(0, 900),
      ...(page.networkReading ? { networkStatus: page.networkReading.status,
        networkCount: Math.min(6, page.networkReading.records?.length || 0),
        networkNote: String(page.networkReading.note || '').slice(0, 300) } : {}),
    } } : {}),
  };
}

export function messageSource(message) {
  return message?.pageSource || message?.sources?.find((source) => source?.url) || null;
}

export function sourceNote(source, label = '此消息引用的页面') {
  if (!source?.url) return '';
  return `\n\n[${label}：${JSON.stringify({ title: String(source.title || '').slice(0, 300), url: String(source.url).slice(0, 2000), ...(source.capturedAt ? { capturedAt: source.capturedAt } : {}) })}]`;
}

/** Match messages by stable IDs after storage cloning, never by object identity. */
export function finalizePendingTurn(conversation, userId, assistantId, userFields = {}) {
  const user = conversation?.messages?.find((message) => message.id === userId && message.role === 'user');
  const assistant = conversation?.messages?.find((message) => message.id === assistantId && message.role === 'assistant');
  if (!user || !assistant) return null;
  Object.assign(user, userFields);
  delete user.optimistic;
  delete assistant.optimistic;
  assistant.status = 'streaming';
  return { user, assistant };
}

export function sourceMatchesPage(source, page) {
  return Boolean(page && !source?.unavailable && (!source?.url || (source.url === page.url
    && (!source.capturedAt || source.capturedAt === page.capturedAt)
    && (!source.documentId || source.documentId === page.documentId))));
}

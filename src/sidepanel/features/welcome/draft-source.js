const TOPIC_LABELS = Object.freeze({
  news: '国内外大事',
  ai: 'AI圈动态',
  tech: '科技新品',
  business: '商业与市场',
});

/** Keep source intent separate from editable text and exclude executable fields. */
export function normalizeDraftSource(value) {
  if (!value || typeof value !== 'object' || value.scope !== 'independent') return null;
  const topicId = typeof value.topicId === 'string' ? value.topicId : '';
  if (!Object.hasOwn(TOPIC_LABELS, topicId)) return null;
  return { scope: 'independent', topicId, label: TOPIC_LABELS[topicId] };
}

import { BUILTIN_TOPIC_LABELS, isWelcomeTopicId, TOPIC_LIMITS } from './topic-preferences.js';

/** Keep source intent separate from editable text and exclude executable fields. */
export function normalizeDraftSource(value) {
  if (!value || typeof value !== 'object' || value.scope !== 'independent') return null;
  const { topicId } = value;
  if (!isWelcomeTopicId(topicId)) return null;
  const original = BUILTIN_TOPIC_LABELS[topicId];
  if (value.version === undefined && original) return { scope: 'independent', topicId, label: original };
  const label = typeof value.label === 'string' ? value.label.trim().replace(/\s+/g, ' ') : '';
  if (value.version !== 1 || !label || label.length > TOPIC_LIMITS.title) return null;
  return original === label ? { scope: 'independent', topicId, label } : { version: 1, scope: 'independent', topicId, label };
}

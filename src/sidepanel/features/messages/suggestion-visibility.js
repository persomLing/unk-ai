/**
 * Suggestions belong only to the most recent assistant answer. Historical
 * answers keep their text, sources, and actions, but not stale "try next"
 * chips that would look like part of the current turn.
 */
export function showSuggestionsFor(message, latestAssistantId, latestMessageRole = 'assistant') {
  return Boolean(
    message
    && message.role === 'assistant'
    && message.id
    && message.id === latestAssistantId
    && latestMessageRole === 'assistant'
    && message.status !== 'streaming',
  );
}

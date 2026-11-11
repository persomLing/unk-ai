/** Derive the thinking row from message state so streaming updates and a user
 * click agree on the same open/closed value. Re-rendering that row must never
 * make a manual collapse look like it was ignored. */
export function thinkingPresentation(message, now = Date.now()) {
  const isStreaming = message?.status === 'streaming';
  const hasReasoning = Boolean(message?.reasoning);
  const active = isStreaming && !message?.content && hasReasoning;
  const expanded = message?.userToggledThinking !== undefined
    ? Boolean(message.thinkingExpanded)
    : false;
  const elapsedSeconds = message?.reasoningSeconds
    || (message?.reasoningStartedAt ? Math.max(1, Math.round((now - message.reasoningStartedAt) / 1000)) : 0);
  const label = isStreaming
    ? (active
        ? `正在深度思考${elapsedSeconds ? ` ${elapsedSeconds} 秒` : ''}…`
        : `已深度思考${elapsedSeconds ? `（用时 ${elapsedSeconds} 秒）` : ''}`)
    : `已深度思考${message?.reasoningSeconds ? `（用时 ${message.reasoningSeconds} 秒）` : ''}`;
  return Object.freeze({
    visible: hasReasoning,
    active,
    expanded,
    elapsedSeconds,
    label,
    settle: !active,
  });
}

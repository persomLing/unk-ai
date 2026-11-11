/**
 * Keep the composer's send/stop affordance tied to a live request, not merely
 * to a possibly stale generating id. A stream can end without a final delta
 * (provider disconnect, aborted fetch, or reload), leaving the message as
 * "streaming" while no request is actually active.
 */
export function liveReplyState({ generatingId, conversationId, assistant, signal } = {}) {
  return Boolean(
    generatingId
    && conversationId
    && generatingId === conversationId
    && assistant?.status === 'streaming'
    && signal
    && signal.aborted !== true,
  );
}

export function settleInterruptedReply(assistant, { aborted = false } = {}) {
  if (!assistant) return false;
  const wasStreaming = assistant.status === 'streaming';
  if (wasStreaming) {
    assistant.status = aborted ? 'stopped' : 'error';
    if (!aborted && !assistant.errorMessage) {
      assistant.errorMessage = '生成已中断，请重试。';
    }
  }
  // Even a completed message can briefly retain timing data if a render
  // races its final status update. A settled message must never animate as
  // if it were still thinking.
  delete assistant.reasoningStartedAt;
  delete assistant.reasoningFinishedAt;
  return wasStreaming;
}

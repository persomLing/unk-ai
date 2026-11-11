const EVENTS = new Set(['run:started', 'run:bound', 'run:phase', 'run:message', 'run:terminal']);
const PREPARING = new Set(['preparing', 'reading', 'reading-index', 'reading-related', 'checking-evidence',
  'reading-deep', 'reading-network', 'researching', 'checking-research', 'web-research', 'saving',
  'compressing', 'collecting-context', 'waiting-model']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const validId = value => typeof value === 'string' && Boolean(value.trim());

/** Presentation state for one floating conversation; it never owns a run. */
export function createFloatingChatActivity({ conversationId, getMessage, isVisible } = {}) {
  if (!validId(conversationId) || typeof getMessage !== 'function' || typeof isVisible !== 'function') {
    throw new TypeError('追问按钮状态需要会话、消息查询和可见性。');
  }
  let activity = 'idle';
  let unread = false;
  let active = null;
  let disposed = false;
  // A previously observed start cannot revive a finished or superseded run.
  const observedRuns = new Set();

  function observe(event) {
    if (disposed || !event || !EVENTS.has(event.type) || !validId(event.runId)) return false;
    if (event.type === 'run:started') {
      if (observedRuns.has(event.runId) || (event.conversationId != null && event.conversationId !== conversationId)) return false;
      observedRuns.add(event.runId);
      active = { runId: event.runId, assistantId: null };
      activity = 'preparing';
      unread = false;
      return true;
    }
    if (!active || event.runId !== active.runId) return false;
    if (event.type === 'run:bound') {
      if (event.conversationId !== conversationId) {
        if (!active.assistantId) { active = null; activity = 'idle'; }
        return false;
      }
      if (!validId(event.assistantId) || (active.assistantId && event.assistantId !== active.assistantId)) return false;
      active.assistantId = event.assistantId;
      return true;
    }
    // Preparation may be cancelled or fail before the runner binds a message.
    if (event.type === 'run:terminal' && !active.assistantId && TERMINAL.has(event.status)
      && event.assistantId == null && (event.conversationId == null || event.conversationId === conversationId)) {
      active = null;
      activity = 'idle';
      return true;
    }
    if (!active.assistantId || event.conversationId !== conversationId || event.assistantId !== active.assistantId) return false;
    if (event.type === 'run:terminal') {
      if (!TERMINAL.has(event.status)) return false;
      const owner = active;
      active = null;
      activity = 'idle';
      if (event.status !== 'completed') return true;
      let message, visible;
      try {
        message = getMessage(owner.assistantId);
        visible = isVisible();
      } catch { return true; }
      if (disposed || active) return true;
      if (message?.id === owner.assistantId && message.role === 'assistant' && message.status === 'complete'
        && typeof message.content === 'string' && message.content.trim() && !visible) unread = true;
      return true;
    }
    if (event.phase === 'reasoning') activity = 'thinking';
    else if (event.phase === 'answering') activity = 'answering';
    else if (PREPARING.has(event.phase)) activity = 'preparing';
    else return false;
    return true;
  }

  return Object.freeze({ observe,
    acknowledge() {
      if (disposed || !unread) return false;
      unread = false;
      return true;
    },
    snapshot: () => Object.freeze({ activity, unread }),
    dispose() {
      if (disposed) return;
      disposed = true;
      active = null;
      activity = 'idle';
      unread = false;
      observedRuns.clear();
    },
  });
}

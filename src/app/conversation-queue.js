/** Queue state for submissions that belong to a specific conversation. */
export function createConversationQueue({
  state,
  isDisposed = () => false,
  isBusy = () => false,
  isPageDisabled = () => false,
  getConversationId = () => state?.conversation?.id,
  send,
  onChange = () => {},
} = {}) {
  if (!state) throw new TypeError('Conversation queue requires state.');
  if (typeof send !== 'function') throw new TypeError('Conversation queue requires a sender.');
  if (!Array.isArray(state.messageQueue)) state.messageQueue = [];

  const notify = () => { try { onChange(); } catch {} };

  function enqueue(item) {
    state.messageQueue.push(item);
    return item;
  }

  function clear() {
    state.messageQueue = [];
  }

  function bindConversation(owner, conversationId) {
    for (const item of state.messageQueue) {
      if (item.conversationId === null && item.submissionOwner === owner) {
        item.conversationId = conversationId;
        delete item.submissionOwner;
      }
    }
  }

  function process() {
    if (isDisposed() || !state.messageQueue.length || isBusy()) return;
    const head = state.messageQueue[0];
    if (Object.hasOwn(head, 'conversationId') && head.conversationId !== getConversationId()) {
      notify();
      return;
    }
    if (isPageDisabled(head)) {
      notify();
      return;
    }
    const next = state.messageQueue.shift();
    notify();
    if (next) void send(next.content, { ...next, fromQueue: true });
  }

  return Object.freeze({
    enqueue,
    clear,
    bindConversation,
    process,
    hasConversation(conversationId) {
      return state.messageQueue.some(item => item.conversationId === conversationId);
    },
  });
}

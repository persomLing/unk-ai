import { awaitWithTimeout } from '../../../utils/abortable.js';

/** Ordered saves and delayed saves with an explicit conversation owner. */
export function createConversationSaver({
  getConversation,
  loadConversation,
  writeConversation,
  getQueue,
  setQueue,
  onSaved = () => {},
  onError = () => {},
  now = () => new Date().toISOString(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  readTimeoutMs = 10000,
}) {
  let localQueue = Promise.resolve();
  let scheduled = null;

  function enqueue(operation) {
    const previous = getQueue ? getQueue() : localQueue;
    const pending = previous.catch(() => {}).then(operation);
    localQueue = pending;
    setQueue?.(pending);
    return pending;
  }

  function cancelScheduled(conversation) {
    if (!scheduled || (conversation && scheduled.conversation.id !== conversation.id)) return null;
    const entry = scheduled;
    scheduled = null;
    clearTimer(entry.timer);
    return entry.conversation;
  }

  async function agentSnapshot(snapshot, message) {
    // Resolve storage again inside the queue: a temporary owner may have been
    // promoted before a late task callback reaches its turn to save.
    let current = getConversation();
    const stored = current?.id === snapshot.id ? null : await awaitWithTimeout(loadConversation(snapshot.id), {
      timeoutMs: readTimeoutMs, message: '读取原任务会话超时，结果未写入其他会话。',
    });
    current = getConversation();
    const source = current?.id === snapshot.id ? current : stored;
    if (!source) throw new Error('原任务会话已不可用，结果未写入其他会话。');
    const target = structuredClone(source);
    target.messages = (target.messages || []).filter(item => !item.optimistic);
    const owned = target.messages.find(item => item.id === message.id
      && item.role === 'assistant' && item.agent?.taskId === message.agent?.taskId);
    if (!owned) throw new Error('原任务消息已不存在，结果未写入其他消息。');
    Object.assign(owned, structuredClone(message));
    if (stored?.storage === 'local') target.storage = 'local';
    target.updatedAt = snapshot.updatedAt;
    return target;
  }

  async function runSnapshot(snapshot, message, isCurrent, turn) {
    if (isCurrent && !isCurrent()) return null;
    let current = getConversation();
    const stored = current?.id === snapshot.id ? null : await awaitWithTimeout(loadConversation(snapshot.id), {
      timeoutMs: readTimeoutMs, message: '读取原会话超时，回答未写入其他会话。',
    });
    if (isCurrent && !isCurrent()) return null;
    current = getConversation();
    const source = current?.id === snapshot.id ? current : stored;
    if (!source) throw new Error('原会话已不可用，回答未写入其他会话。');
    const target = structuredClone(source);
    target.messages = (target.messages || []).filter(item => !item.optimistic);
    if (!target.messages.some(item => item.id === message.id) && turn) {
      // A cancelled preparation may not have persisted its optimistic pair yet.
      // Apply its append/retry structure only if the saved timeline is still the
      // exact ID sequence it started from; never recreate a changed timeline.
      if (JSON.stringify(target.messages.map(item => item.id)) !== JSON.stringify(turn.baseMessageIds)) {
        throw new Error('原会话记录已变化，未覆盖新的消息。');
      }
      const storedMessages = new Map(target.messages.map(item => [item.id, item]));
      const submittedMessages = new Map(snapshot.messages.map(item => [item.id, item]));
      if (!turn.messageIds.every(id => submittedMessages.has(id)) || !submittedMessages.has(turn.userId)) {
        throw new Error('本轮消息尚未完成准备，未提交不完整的回合。');
      }
      target.messages = turn.messageIds.map(id => structuredClone(id === turn.userId
        ? submittedMessages.get(id) : storedMessages.get(id) || submittedMessages.get(id)));
    }
    const ownedIndex = target.messages.findIndex(item => item.id === message.id && item.role === 'assistant');
    const owned = target.messages[ownedIndex];
    if (!owned) throw new Error('原回答已不存在，结果未写入其他消息。');
    // Older checkpoints can lack run metadata. Once present, a different run
    // must never be replaced, and delayed saves cannot regress its revision.
    if ((owned.runId && owned.runId !== message.runId)
      || (owned.turnId && owned.turnId !== message.turnId)) return null;
    const newer = owned.runId === message.runId && (owned.runRevision || 0) > (message.runRevision || 0);
    const terminal = owned.terminalRunId === message.runId && message.terminalRunId !== message.runId;
    if (!newer && !terminal) target.messages[ownedIndex] = structuredClone(message);
    if (stored?.storage === 'local') target.storage = 'local';
    target.updatedAt = snapshot.updatedAt;
    return target;
  }

  async function save(conversation = getConversation(), { required = false, agentMessage = null, message = null, isCurrent = null, turn = null } = {}) {
    if (isCurrent && !isCurrent()) return null;
    cancelScheduled(conversation);
    if (!conversation) return;
    try {
      conversation.updatedAt = now();
      const snapshot = structuredClone({ ...conversation,
        messages: (conversation.messages || []).filter(message => !message.optimistic) });
      const ownedMessage = agentMessage ? structuredClone(agentMessage) : null;
      const runMessage = message ? structuredClone(message) : null;
      const turnMutation = turn ? structuredClone(turn) : null;
      const saved = await enqueue(async () => {
        const target = runMessage ? await runSnapshot(snapshot, runMessage, isCurrent, turnMutation)
          : ownedMessage ? await agentSnapshot(snapshot, ownedMessage) : snapshot;
        if (!target || (isCurrent && !isCurrent())) return null;
        return writeConversation(target);
      });
      if (saved) onSaved(snapshot.id, saved);
      return saved;
    } catch (error) {
      onError(conversation.id, error);
      if (required) throw error;
    }
  }

  function flush() {
    const entry = scheduled;
    const conversation = cancelScheduled();
    if (conversation) void save(conversation, entry.options);
  }

  function schedule(conversation = getConversation(), options = {}) {
    if (!conversation) return null;
    if (options.isCurrent && !options.isCurrent()) return null;
    if (scheduled?.conversation.id === conversation.id) {
      scheduled.conversation = conversation;
      scheduled.options = options;
      return scheduled.timer;
    }
    // Moving to another conversation cannot silently replace its pending save.
    flush();
    const entry = { conversation, options, timer: null };
    entry.timer = setTimer(() => {
      if (scheduled !== entry) return;
      scheduled = null;
      void save(entry.conversation, entry.options);
    }, 450);
    scheduled = entry;
    return entry.timer;
  }

  return Object.freeze({ save, schedule, flush, enqueue });
}

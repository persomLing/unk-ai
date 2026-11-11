import {
  agentTurnForMessage,
  ensureAgentTurnMessage,
  fallbackAgentSummary,
} from '../../../utils/agent-conversation.js';

const finalStatus = { finished: 'complete', failed: 'error', cancelled: 'stopped' };
const terminal = (message) => Boolean(finalStatus[message?.agent?.status])
  && finalStatus[message?.agent?.status] === message?.status
  && Boolean(message?.content?.trim());

/** Bind every callback to its original conversation/message, independently of
 * which conversation the UI currently displays. Persistence must enqueue the
 * supplied owner immediately and must not read a later "current conversation".
 */
export function createAgentTurnCallbacks({
  getConversation,
  ensureConversation,
  save,
  render,
  getProfile = () => null,
  getEffort = () => 'default',
  createId = () => crypto.randomUUID(),
  titleFor = text => String(text || '').slice(0, 34),
  now = () => new Date().toISOString(),
}) {
  const owners = new Map();

  function findMessage(conversation, taskId, messageId) {
    return conversation?.messages?.find(message => message.role === 'assistant'
      && message.agent?.taskId === taskId && (!messageId || message.id === messageId)) || null;
  }

  function bind(conversation, message) {
    if (!conversation?.id || !message?.id || !message.agent?.taskId) return null;
    const owner = { conversationId: conversation.id, messageId: message.id, conversation, message };
    owners.set(message.agent.taskId, owner);
    return owner;
  }

  function resolve(taskId) {
    if (!taskId) return null;
    const current = getConversation();
    const owner = owners.get(taskId);
    if (!owner) return bind(current, findMessage(current, taskId));
    if (current?.id === owner.conversationId) {
      const message = findMessage(current, taskId, owner.messageId);
      // A removed/replaced message must not be recreated by a late callback.
      if (!message) return null;
      if (terminal(owner.message) && !terminal(message)) Object.assign(message, structuredClone(owner.message));
      owner.conversation = current;
      owner.message = message;
    }
    return owner;
  }

  function reconcile(conversation) {
    // Loading may have started before a final save committed. Reuse the final
    // result already known by this panel without replacing other messages.
    for (const owner of owners.values()) {
      if (conversation?.id !== owner.conversationId) continue;
      const message = findMessage(conversation, owner.message.agent.taskId, owner.messageId);
      if (!message) continue;
      if (terminal(owner.message) && !terminal(message)) Object.assign(message, structuredClone(owner.message));
      owner.conversation = conversation;
      owner.message = message;
    }
    return conversation;
  }

  function changed(owner, { scroll = false } = {}) {
    if (getConversation() === owner.conversation) render({ scroll });
    save(owner.conversation, structuredClone(owner.message));
  }

  async function begin(turn, { signal } = {}) {
    signal?.throwIfAborted();
    if (!turn?.taskId) return null;
    const existing = resolve(turn.taskId);
    if (existing) return existing.message;
    const conversation = await ensureConversation(signal);
    signal?.throwIfAborted();
    if (!conversation?.id) return null;
    // Concurrent begin callbacks may have bound the task during the await.
    const established = owners.get(turn.taskId);
    if (established) return established.message;
    const message = ensureAgentTurnMessage(conversation.messages, turn, createId);
    const profile = getProfile();
    message.model = turn.model || profile?.id || '';
    message.modelId = profile?.id || '';
    message.reasoningEffort = getEffort();
    if (!conversation.title || conversation.title === '新对话') conversation.title = titleFor(turn.goal) || '浏览器任务';
    const owner = bind(conversation, message);
    if (owner) changed(owner, { scroll: true });
    return message;
  }

  async function update(turn, { signal } = {}) {
    signal?.throwIfAborted();
    const owner = resolve(turn?.taskId);
    if (!owner) return null;
    const { message } = owner;
    if (terminal(message)) return message;
    message.agent = { ...message.agent, ...agentTurnForMessage(turn), taskId: turn.taskId };
    changed(owner);
    return message;
  }

  async function end(turn, { signal } = {}) {
    signal?.throwIfAborted();
    const owner = resolve(turn?.taskId);
    if (!owner) return null;
    const { message } = owner;
    // The first terminal callback wins, including after a conversation reload.
    if (terminal(message)) return message;
    message.agent = { ...message.agent, ...agentTurnForMessage(turn), taskId: turn.taskId };
    message.status = turn.status === 'finished' ? 'complete' : turn.status === 'cancelled' ? 'stopped' : 'error';
    message.content = turn.result || fallbackAgentSummary(turn);
    if (Array.isArray(turn.sources)) message.sources = turn.sources;
    message.errorMessage = turn.status === 'failed' ? turn.errorMessage || '页面操作未完成，请查看执行记录。' : '';
    message.errorDetail = turn.status === 'failed' ? turn.errorDetail || '' : '';
    message.errorCode = turn.status === 'failed' ? turn.errorCode || '' : '';
    changed(owner, { scroll: owner.conversation.messages.at(-1) === message });
    return message;
  }

  async function restore(turn, { signal } = {}) {
    signal?.throwIfAborted();
    const owner = resolve(turn?.taskId);
    // Old checkpoints contain no conversationId. Only an actual matching
    // timeline message establishes ownership; never attach it to another chat.
    if (!owner) return null;
    const { message } = owner;
    if (message.agent.status === 'running') {
      message.agent.status = 'paused';
      message.agent.steps = [...(message.agent.steps || []), {
        kind: 'warning', title: '任务已暂停',
        detail: '侧边栏或扩展曾中断，未自动重放页面动作。', at: now(), status: 'done',
      }];
      changed(owner);
    }
    return message;
  }

  function getDiagnosticContext(taskId) {
    const owner = owners.get(taskId);
    return owner ? { conversationId: owner.conversationId, turnId: owner.messageId } : {};
  }

  return Object.freeze({ begin, update, end, restore, reconcile, getDiagnosticContext });
}

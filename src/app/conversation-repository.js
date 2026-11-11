import { messagesForRetry } from '../sidepanel/features/messages/retry-flow.js';

const TERMINAL_STATUSES = new Set(['complete', 'error', 'stopped']);
const MUTABLE_FIELDS = new Set([
  'content', 'reasoning', 'reasoningStartedAt', 'reasoningFinishedAt', 'reasoningSeconds',
  'requestPhase', 'phaseStartedAt', 'model', 'modelId', 'reasoningEffort',
  'sources', 'pageSource', 'suggestions', 'selectionUsed', 'includeVisual',
  'errorMessage', 'errorDetail', 'errorCode', 'contextIssues',
]);
const keyFor = (conversationId, assistantId) => JSON.stringify([conversationId, assistantId]);
const clone = value => structuredClone(value);

function applyFields(message, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (!MUTABLE_FIELDS.has(key)) continue;
    if (value === undefined) delete message[key];
    else message[key] = clone(value);
  }
}

/**
 * @typedef {Readonly<{conversationId: string, turnId: string, runId: string,
 *   assistantId: string, userId: string}>} TurnReference
 */

/**
 * Conditional message updates, independent of the Runner's execution state.
 * The UI may still supply its current conversation during migration. Registered
 * references retain their original conversation when another chat is displayed.
 * No method starts models, chooses tools, or automatically persists a new turn.
 *
 * @param {{getConversation: Function, saver?: object, createId?: Function,
 *   now?: Function, onChange?: Function}} dependencies
 */
export function createConversationRepository({
  getConversation,
  saver,
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
  onChange = () => {},
}) {
  if (typeof getConversation !== 'function') throw new TypeError('getConversation is required.');
  // This is an ownership index, not another run state machine. Terminal and
  // revision markers live on messages and survive storage cloning/reloading.
  const owners = new Map();
  const runReferences = new Map();

  function conversationFor(conversation, conversationId) {
    const target = conversation || getConversation();
    if (!target?.id || (conversationId && target.id !== conversationId)) {
      throw new Error('找不到本轮所属会话。');
    }
    if (!Array.isArray(target.messages)) throw new TypeError('Conversation messages must be an array.');
    return target;
  }

  function findPair(conversation, assistantId, userId) {
    const index = conversation.messages.findIndex(item => item.id === assistantId && item.role === 'assistant');
    if (index < 0) return null;
    const user = userId
      ? conversation.messages.find(item => item.id === userId && item.role === 'user')
      : conversation.messages.slice(0, index).findLast(item => item.role === 'user');
    return user ? { conversation, user, assistant: conversation.messages[index] } : null;
  }

  function reconcileOwner(owner, conversation) {
    const pair = findPair(conversation, owner.ref.assistantId, owner.ref.userId);
    if (!pair) return null;
    const { assistant } = pair;
    if (assistant.runId && assistant.runId !== owner.ref.runId) return null;
    if (assistant.turnId && assistant.turnId !== owner.ref.turnId) return null;
    const known = owner.lastAssistant;
    const older = !assistant.runId || (assistant.runRevision || 0) < known.runRevision;
    const missingFinal = known.terminalRunId === owner.ref.runId && assistant.terminalRunId !== owner.ref.runId;
    if (older || missingFinal) {
      for (const field of MUTABLE_FIELDS) {
        if (Object.hasOwn(known, field)) assistant[field] = clone(known[field]);
        else delete assistant[field];
      }
      for (const field of ['turnId', 'runId', 'runRevision', 'terminalRunId', 'status']) {
        if (Object.hasOwn(known, field)) assistant[field] = known[field];
        else delete assistant[field];
      }
    }
    owner.conversation = conversation;
    return pair;
  }

  /** Locate by IDs again on every operation; never trust a stale message object. */
  function get(ref) {
    if (!ref) return null;
    const key = keyFor(ref.conversationId, ref.assistantId);
    const owner = owners.get(key);
    if (!owner || owner.ref.runId !== ref.runId || owner.ref.turnId !== ref.turnId || owner.ref.userId !== ref.userId) return null;
    const current = getConversation();
    const conversation = current?.id === ref.conversationId ? current : owner.conversation;
    const pair = reconcileOwner(owner, conversation);
    if (!pair || pair.assistant.runId !== ref.runId || pair.assistant.turnId !== ref.turnId) {
      owners.delete(key);
      return null;
    }
    return pair;
  }

  function changed(ref, pair, kind) {
    const owner = owners.get(keyFor(ref.conversationId, ref.assistantId));
    owner.lastAssistant = clone(pair.assistant);
    try { onChange({ ref, ...pair, kind }); } catch { /* A view cannot roll back a committed mutation. */ }
  }

  /**
   * Claim an existing (including optimistic) pair, or create a pair from user
   * and assistant inputs. runId is supplied by the Runner; turnId defaults to
   * the retained user's ID. Repeating begin for the same run is idempotent.
   * @returns {TurnReference}
   */
  function begin({ conversation, conversationId, turnId, runId, user, assistant, assistantId, mutationBaseIds } = {}) {
    if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required.');
    if (turnId !== undefined && (typeof turnId !== 'string' || !turnId)) throw new TypeError('turnId must be a non-empty string.');
    if (user?.agentTask || assistant?.agent) throw new Error('浏览器任务使用独立的 Agent 回合适配器。');
    const target = conversationFor(conversation, conversationId);
    const baseMessageIds = mutationBaseIds || target.messages.filter(item => !item.optimistic).map(item => item.id);
    const targetId = assistantId || assistant?.id;
    const knownRef = runReferences.get(runId);
    if (knownRef) {
      if (knownRef.conversationId !== target.id || (targetId && knownRef.assistantId !== targetId)
        || (turnId && knownRef.turnId !== turnId) || !get(knownRef)) throw new Error('本次执行已经被替换，不能重新认领。');
      return knownRef;
    }
    let pair = targetId ? findPair(target, targetId) : null;
    if (!pair) {
      if (targetId && target.messages.some(item => item.id === targetId)) throw new Error('回答没有对应的用户提问。');
      if (!user) throw new Error('开始回合需要用户消息或已存在的回答。');
      const userId = user.id || createId();
      let question = target.messages.find(item => item.id === userId);
      if (question && question.role !== 'user') throw new Error('用户消息标识已被占用。');
      const answerId = targetId || createId();
      if (answerId === userId || target.messages.some(item => item.id === answerId)) throw new Error('回答标识已被占用。');
      if (!question) {
        question = { ...clone(user), id: userId, role: 'user', createdAt: user.createdAt || now(), status: 'complete' };
        target.messages.push(question);
      }
      const answer = { content: '', status: 'streaming', createdAt: now(), ...clone(assistant || {}), id: answerId, role: 'assistant' };
      target.messages.push(answer);
      pair = { conversation: target, user: question, assistant: answer };
    }
    if (pair.user.agentTask || pair.assistant.agent) throw new Error('浏览器任务使用独立的 Agent 回合适配器。');
    const actualTurnId = turnId || pair.user.turnId || pair.user.id;
    if (typeof actualTurnId !== 'string' || !actualTurnId) throw new TypeError('turnId must be a non-empty string.');
    if (pair.user.turnId && pair.user.turnId !== actualTurnId) throw new Error('用户提问已经属于另一回合。');
    const key = keyFor(target.id, pair.assistant.id);
    const existing = owners.get(key);
    if (existing?.ref.runId === runId && existing.ref.turnId === actualTurnId) {
      if (!reconcileOwner(existing, target)) throw new Error('本轮消息已被替换。');
      return existing.ref;
    }
    for (const [ownerKey, owner] of owners) {
      if (owner.ref.conversationId === target.id && owner.ref.turnId === actualTurnId) owners.delete(ownerKey);
    }
    const sameRun = pair.assistant.runId === runId;
    if (!sameRun) {
      if (pair.assistant.runId) {
        for (const field of MUTABLE_FIELDS) {
          if (!['model', 'modelId', 'reasoningEffort', 'selectionUsed'].includes(field)) delete pair.assistant[field];
        }
        pair.assistant.content = '';
      }
      delete pair.assistant.terminalRunId;
      pair.assistant.runRevision = 0;
      pair.assistant.status = 'streaming';
    }
    pair.user.turnId = actualTurnId;
    pair.assistant.turnId = actualTurnId;
    pair.assistant.runId = runId;
    pair.assistant.runRevision ||= 0;
    const ref = Object.freeze({ conversationId: target.id, turnId: actualTurnId, runId,
      assistantId: pair.assistant.id, userId: pair.user.id });
    owners.set(key, { ref, conversation: target, lastAssistant: clone(pair.assistant),
      baseMessageIds: [...baseMessageIds], messageIds: target.messages.map(item => item.id) });
    runReferences.set(runId, ref);
    changed(ref, pair, 'begin');
    return ref;
  }

  /** Patch answer data only. undefined removes an allowed field. */
  function update(ref, patch) {
    const pair = get(ref);
    if (!pair || pair.assistant.terminalRunId === ref.runId) return false;
    applyFields(pair.assistant, patch);
    pair.assistant.status = 'streaming';
    pair.assistant.runRevision += 1;
    changed(ref, pair, 'update');
    return true;
  }

  function append(ref, { content = '', reasoning = '' } = {}) {
    const pair = get(ref);
    if (!pair || pair.assistant.terminalRunId === ref.runId) return false;
    return update(ref, { content: (pair.assistant.content || '') + String(content),
      reasoning: (pair.assistant.reasoning || '') + String(reasoning) });
  }

  /** First complete/error/stopped result for the active run wins. */
  function finish(ref, { status, ...patch } = {}) {
    if (!TERMINAL_STATUSES.has(status)) throw new TypeError('Invalid terminal message status.');
    const pair = get(ref);
    if (!pair || pair.assistant.terminalRunId === ref.runId) return false;
    applyFields(pair.assistant, patch);
    pair.assistant.status = status;
    pair.assistant.terminalRunId = ref.runId;
    pair.assistant.runRevision += 1;
    delete pair.user.optimistic;
    delete pair.assistant.optimistic;
    delete pair.assistant.reasoningStartedAt;
    delete pair.assistant.reasoningFinishedAt;
    changed(ref, pair, 'finish');
    return true;
  }

  /** Optional follow-up suggestions may decorate a successful result only. */
  function decorate(ref, { suggestions } = {}) {
    const pair = get(ref);
    if (!pair || pair.assistant.status !== 'complete' || pair.assistant.terminalRunId !== ref.runId) return false;
    if (!Array.isArray(suggestions) || suggestions.some(value => typeof value !== 'string')) {
      throw new TypeError('suggestions must be an array of strings.');
    }
    if (JSON.stringify(pair.assistant.suggestions || []) === JSON.stringify(suggestions)) return false;
    pair.assistant.suggestions = clone(suggestions);
    pair.assistant.runRevision += 1;
    changed(ref, pair, 'decorate');
    return true;
  }

  /** Explicit retry preserves the established question/source folding rules. */
  function retry({ conversation, conversationId, assistantId, runId, assistant = {} } = {}) {
    if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required.');
    if (runReferences.has(runId)) throw new Error('重试必须使用新的执行标识。');
    const target = conversationFor(conversation, conversationId);
    const mutationBaseIds = target.messages.filter(item => !item.optimistic).map(item => item.id);
    const replacement = { ...clone(assistant), id: assistant.id || createId(), role: 'assistant',
      content: '', status: 'streaming', createdAt: assistant.createdAt || now() };
    if (target.messages.some(item => item.id === replacement.id)) throw new Error('重试必须使用新的回答标识。');
    const messages = messagesForRetry(target.messages, assistantId, replacement);
    if (!messages) throw new Error('这条回答不支持普通对话重试。');
    target.messages = messages;
    for (const [key, owner] of owners) {
      if (owner.ref.conversationId === target.id && !messages.some(item => item.id === owner.ref.assistantId)) owners.delete(key);
    }
    return begin({ conversation: target, assistantId: replacement.id, runId, mutationBaseIds });
  }

  function saveOptions(ref, pair) {
    const owner = owners.get(keyFor(ref.conversationId, ref.assistantId));
    return { message: pair.assistant, isCurrent: () => Boolean(get(ref)),
      turn: { userId: ref.userId, baseMessageIds: owner.baseMessageIds, messageIds: owner.messageIds } };
  }

  function save(ref, { required = false } = {}) {
    const pair = get(ref);
    if (!pair) return Promise.resolve(null);
    if (!saver?.save) throw new TypeError('A conversation saver is required.');
    return saver.save(pair.conversation, { required, ...saveOptions(ref, pair) });
  }

  function schedule(ref) {
    const pair = get(ref);
    if (!pair) return null;
    if (!saver?.schedule) throw new TypeError('A conversation saver is required.');
    return saver.schedule(pair.conversation, saveOptions(ref, pair));
  }

  function reconcile(conversation) {
    for (const [key, owner] of owners) {
      if (owner.ref.conversationId === conversation?.id && !reconcileOwner(owner, conversation)) owners.delete(key);
    }
    return conversation;
  }

  return Object.freeze({ begin, get, update, append, finish, decorate, retry, save, schedule, reconcile });
}

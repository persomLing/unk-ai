import { createSidepanelApplication } from '../../composition/application-root.js';
import { createConversationSaver } from '../storage/conversation-save.js';
import { commitLocalConversation, loadConversation as loadStoredConversation } from '../../../utils/conversation-store.js';
import { awaitWithTimeout } from '../../../utils/abortable.js';
import { normalizeConversationSelection, shouldReleaseSelection } from '../../../utils/selection.js';

const copy = value => value == null ? null : structuredClone(value);
const timestamp = () => new Date().toISOString();
const savedFields = ['syncStatus', 'syncError', 'syncDirectoryName', 'storageGeneration'];

/** One floating chat owns one ordinary application, with private draft/run state.
 * The global temporary-conversation slot is deliberately not involved: the
 * first submitted turn commits through the normal outbox and history path. */
export function createSelectionChatRuntime({ selection, getConfig = () => null, getProfile = () => null,
  writeConversation = commitLocalConversation, loadConversation = loadStoredConversation,
  modelGateway, recordDiagnostic = () => {}, onSaved = () => {}, onError = () => {},
  makeId = () => crypto.randomUUID(), now = timestamp, flushTimeoutMs = 10000 } = {}) {
  const fixedSelection = normalizeConversationSelection(selection);
  if (!fixedSelection || fixedSelection.sourceVersion !== 1) {
    throw new TypeError('侧边提问需要有效的文章选区。');
  }
  const sourceConversationId = fixedSelection.conversationId;
  const createdAt = now();
  const state = {
    conversation: { version: 2, id: makeId(), storage: 'local', title: '新对话', createdAt, updatedAt: createdAt, messages: [] },
    ready: true, config: copy(getConfig()), attachments: [], messageQueue: [],
    selectedModelId: '', selectedEffort: 'default', disablePageContext: true,
    directModelRequest: '', draft: '', draftSource: null, pageSelection: copy(fixedSelection),
    saveQueue: Promise.resolve(), pendingPage: null, activePageSignal: null,
  };
  const listeners = new Set();
  const lifetime = new AbortController();
  let closed = false;
  let transferring = false;
  let transferDirty = false;
  let commandPending = false;
  // The service projects its submitted quote back into pageSelection after
  // preparation waits. Keep the next quote separately so that old preparation
  // and terminal callbacks cannot overwrite a later explicit selection.
  let pendingSelection = copy(fixedSelection);
  let selectionRevision = 0;
  let activeCommand = null;
  let fixedProfile = null;
  const emit = event => {
    if (closed) return;
    for (const listener of listeners) { try { listener(event); } catch {} }
  };
  const notifyError = error => {
    try { onError(error, state.conversation.id); } catch {}
    emit({ type: 'notice', kind: 'error', message: error?.message || '侧边对话未能保存，请重试。' });
  };
  const storedSaver = createConversationSaver({
    getConversation: () => state.conversation, loadConversation, writeConversation,
    getQueue: () => state.saveQueue, setQueue: queue => { state.saveQueue = queue; }, now,
    onSaved: (conversationId, saved) => {
      if (state.conversation.id === conversationId) {
        // Store normalization turns the persisted streaming snapshot into a
        // stopped one. Only save metadata may update an active in-memory run.
        for (const key of savedFields) if (Object.hasOwn(saved, key)) state.conversation[key] = saved[key];
      }
      try { onSaved(conversationId, saved); } catch {}
      emit({ type: 'saved', conversationId, syncStatus: saved?.syncStatus || 'synced' });
    },
    onError: (_conversationId, error) => {
      state.conversation.syncStatus = 'error';
      state.conversation.syncError = error?.message || '保存失败';
      notifyError(error);
    },
  });
  const saver = Object.freeze({ ...storedSaver,
    schedule(conversation, options) {
      // Only optional completion effects can still decorate a settled chat.
      // Keep their mutations in the final required snapshot instead of letting
      // a new delayed write outlive transfer to the main application.
      if (transferring) { transferDirty = true; return null; }
      return storedSaver.schedule(conversation, options);
    },
  });
  const profileFor = () => copy(fixedProfile);
  const application = createSidepanelApplication({
    state, conversationSaver: saver, modelGateway, recordDiagnostic,
    browser: { queryActiveTab: async () => null, sendMessage: async () => ({}) },
    ensureConversation: async signal => { signal?.throwIfAborted(); return state.conversation; },
    ensureConfigured: async signal => {
      signal?.throwIfAborted();
      if (fixedProfile?.endpointUrl && fixedProfile?.model) return true;
      emit({ type: 'notice', message: '请先配置模型服务，你的输入已保留。', kind: 'error' });
      return false;
    },
    saveCurrent: options => saver.save(options?.conversation || state.conversation, options),
    scheduleSave: () => saver.schedule(state.conversation),
    getDirectoryInfo: async () => ({ granted: false }),
    promoteTemporaryConversation: async conversation => conversation,
    readCurrentPageForRequest: async () => { throw new Error('文章选区提问不读取当前浏览器页面。'); },
    autoVisualAttachments: async () => [], activeChatProfile: () => fixedProfile ? { id: fixedProfile.model } : null,
    profileFor, conversationTitle: text => String(text || '').trim().slice(0, 34) || '选区提问',
    hasVision: () => fixedProfile?.supportsVision === true, makeId, now,
  });
  const unsubscribe = application.subscribe(event => {
    if (event.type === 'reply-ended') {
      if (activeCommand?.kind === 'send' && activeCommand.revision === selectionRevision
        && shouldReleaseSelection(activeCommand.selection, event.selectionUsed)) {
        pendingSelection = null;
        selectionRevision += 1;
      }
      if (!closed) state.pageSelection = copy(pendingSelection);
    }
    emit(event);
  });

  function captureConfiguration() {
    state.config = copy(getConfig());
    fixedProfile = copy(getProfile());
    state.selectedModelId = fixedProfile?.model || fixedProfile?.id || '';
    state.selectedEffort = fixedProfile?.reasoningEffort || 'default';
  }
  function isBusy() {
    return transferring || commandPending || Boolean(state.generatingId || state.isSubmitting || state.compressing || application.runner.active());
  }
  function getSelection() { return copy(pendingSelection); }
  function setSelection(value) {
    const reject = reason => ({ accepted: false, pending: false, selection: getSelection(), reason });
    if (closed) return reject('closed');
    if (transferring) return reject('transferring');
    const next = normalizeConversationSelection(value);
    if (!next || next.sourceVersion !== 1) return reject('invalid-selection');
    if (next.conversationId !== sourceConversationId) return reject('source-mismatch');
    const pending = isBusy();
    pendingSelection = copy(next);
    selectionRevision += 1;
    if (!pending) state.pageSelection = copy(pendingSelection);
    emit({ type: 'selection-updated', selection: getSelection(), pending });
    return { accepted: true, pending, selection: getSelection() };
  }
  async function command(operation, kind) {
    if (closed || isBusy()) return false;
    commandPending = true;
    const currentCommand = { kind, revision: selectionRevision, selection: getSelection() };
    activeCommand = currentCommand;
    try {
      captureConfiguration();
      if (kind === 'send') state.pageSelection = copy(currentCommand.selection);
      await operation();
      return !closed;
    } catch (error) {
      if (!closed && error?.name !== 'AbortError') notifyError(error);
      return false;
    } finally {
      if (activeCommand === currentCommand) {
        activeCommand = null;
        commandPending = false;
        if (!closed) state.pageSelection = copy(pendingSelection);
      }
      emit({ type: 'composer' });
    }
  }
  function send(text = state.draft) {
    const submitted = String(text || '').trim();
    if (!submitted) return Promise.resolve(false);
    return command(() => application.conversations.sendMessage(submitted, {
      pageContextEnabled: false, agentTask: false, directModelRequest: true,
      pageTargetPromise: Promise.resolve(null),
    }), 'send');
  }
  function retry(assistantId) {
    return command(() => application.conversations.regenerate(assistantId), 'retry');
  }
  function stop() {
    if (closed) return false;
    state.messageQueue = [];
    const stopped = application.conversations.stopActiveReply();
    emit({ type: 'composer' });
    return stopped;
  }
  async function flush() {
    saver.flush();
    return await awaitWithTimeout(state.saveQueue, { timeoutMs: flushTimeoutMs,
      message: '等待侧边对话保存超时，已有写入仍可能完成，请重新核对。' });
  }
  function close() {
    if (closed) return;
    stop();
    closed = true;
    lifetime.abort(new DOMException('侧边对话窗口已关闭。', 'AbortError'));
    application.dispose();
    unsubscribe();
    listeners.clear();
    saver.flush();
  }
  async function takeConversation({ signal, isCurrent = () => true } = {}) {
    if (closed) throw new DOMException('侧边对话窗口已关闭。', 'AbortError');
    if (isBusy()) throw new Error('请等待侧边回答结束或停止后再替换当前对话。');
    if (!state.conversation.messages.some(message => message.role === 'user' && !message.optimistic)) {
      throw new Error('请先在侧边窗口发送一条消息，再替换当前对话。');
    }
    transferring = true;
    emit({ type: 'composer' });
    const transferSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    const assertTransfer = () => {
      transferSignal.throwIfAborted();
      if (!isCurrent()) throw new DOMException('对话切换已失效，未释放侧边对话。', 'AbortError');
    };
    const deadlineAt = Date.now() + flushTimeoutMs;
    const waitForTransfer = pending => awaitWithTimeout(pending, {
      signal: transferSignal, timeoutMs: Math.max(1, deadlineAt - Date.now()),
      message: '保存侧边对话超时，请保留窗口并重新核对。',
    });
    try {
      // A new required save permits recovery from a prior failed queue item.
      // Commands stay frozen while this wait owns the transfer, and a close
      // cancels waiting without pretending the queued disk write was undone.
      do {
        assertTransfer();
        transferDirty = false;
        await waitForTransfer(saver.save(state.conversation, { required: true }));
        assertTransfer();
        saver.flush();
        await waitForTransfer(state.saveQueue);
        assertTransfer();
      } while (transferDirty);
      // No await separates release and cloning: a late auxiliary callback now
      // observes the disposed service before it can mutate or schedule a write.
      application.dispose();
      unsubscribe();
      const conversation = copy(state.conversation);
      closed = true;
      listeners.clear();
      return conversation;
    } finally {
      transferring = false;
      if (transferDirty && !closed) saver.schedule(state.conversation);
      emit({ type: 'composer' });
    }
  }
  return Object.freeze({ state, application, send, stop, retry, isBusy, getSelection, setSelection,
    close, dispose: close, flush, takeConversation,
    subscribe(listener) { if (closed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); } });
}

import { awaitWithTimeout } from '../utils/abortable.js';
import { finalizePendingTurn, pageSourceFor } from '../utils/turn-source.js';
import { messageWithSelection, pageSelectionMatches } from '../utils/selection.js';
import { captureSelectionVisuals, retainedSelectionVisuals } from '../sidepanel/features/visual-context/selection-visual-context.js';
import { readingPolicyForTurn } from '../utils/reading-plan.js';
import { parseRepositoryUrl } from '../utils/repository-reader.js';
import { normalizePageUrl } from '../sidepanel/features/page-reading/page-source.js';
import { isReadablePageUrl } from '../sidepanel/features/page-reading/page-control-state.js';
import { preparePageReading } from '../sidepanel/features/page-reading/site-research-slot.js';
import { capturePageTarget } from '../sidepanel/features/page-reading/page-target-capture.js';
import { sendFingerprint, isDuplicateSend } from '../sidepanel/features/messages/send-guard.js';
import { messagesForRetry, stoppedReplyForPrompt } from '../sidepanel/features/messages/retry-flow.js';
import { settleInterruptedReply } from '../sidepanel/features/messages/reply-state.js';
import { contextWindowFor } from '../utils/context.js';
import { normalizeDraftSource } from '../sidepanel/features/welcome/draft-source.js';
import { normalizeAgentReferenceImages, assertAgentReferenceTarget, assertAgentVision } from '../utils/agent-reference-images.js';
import { assertPageTarget } from '../utils/page-target.js';
import { captureReadingHistory, readingOptionsAtSubmission } from '../utils/reading-options.js';
import { assertImageAttachmentsAvailable } from '../utils/attachments.js';
import { selectedSkill } from '../sidepanel/features/skills/skill-context.js';
import { selectedVideoTranscript } from '../sidepanel/features/video-notes/video-request.js';
import { rewoundCommandForDraft } from '../sidepanel/features/messages/rewound-command.js';
import { assertImageCommand, directImageForMessage, IMAGE_TURN_TIMEOUT_MS } from '../utils/image-generation-command.js';
import { createRetryPagePreparation } from './retry-page-preparation.js';
import { createConversationQueue } from './conversation-queue.js';

/** Application command service. The state object is a compatibility projection
 * consumed by the existing presenters; browser/storage are injected ports.
 * There is no DOM or model transport in this module. */
export function createConversationService(deps) {
  const { state, browser, runner, repository, modelGateway, replyService,
    ensureConversation, ensureConfigured, saveCurrent, scheduleSave,
    getDirectoryInfo, promoteTemporaryConversation, readCurrentPageForRequest,
    autoVisualAttachments, activeChatProfile, profileFor,
    conversationTitle, hasVision, makeId = () => crypto.randomUUID(),
    now = () => new Date().toISOString(), truncateText = text => String(text).slice(0, 34),
    waitWithTimeout = awaitWithTimeout } = deps;
  const agentSlot = deps.agentSlot;
  const pageCommands = deps.pageCommands || {};
  const listeners = new Set();
  let disposed = false;
  const profiles = new Map(), connections = new Map();
  const pagePreparations = new WeakSet();
  const plainText = value => String(value ?? '');
  const find = (values, predicate) => values?.find(predicate);
  const emit = (type, data = {}) => { for (const listener of listeners) { try { listener({ type, ...data }); } catch {} } };
  const draft = { get value() { return state.draft || ''; }, set value(value) { state.draft = value; } };
  const resizeInput = () => emit('draft');
  const renderAttachments = () => emit('attachments');
  const renderPageSelection = () => emit('selection');
  const updateComposer = () => emit('composer');
  const renderQueueBar = () => emit('queue');
  const renderConversation = options => emit('conversation', options);
  const renderContextChip = () => emit('context');
  const toast = (message, kind) => emit('notice', { message, kind });
  const requireModel = () => {
    toast('请先为当前对话选择模型，草稿已保留。');
    emit('model-required');
  };
  const setPageSelection = value => { state.pageSelection = value; emit('selection'); };
  const setAssistantPhase = (assistant, phase) => {
    if (!assistant) return;
    const run = runner.active();
    if (run?.ref?.assistantId === assistant.id) run.phase(phase);
    else { assistant.requestPhase = phase; assistant.phaseStartedAt = Date.now(); }
    emit('progress', { assistantId: assistant.id });
  };
  function modelFor(run) {
    if (!connections.has(run.runId)) connections.set(run.runId, modelGateway.createRun({ runId: run.runId,
      profile: profiles.get(run.runId), signal: run.signal, deadlineAt: run.deadlineAt }));
    return connections.get(run.runId);
  }
  function disposeModel(run) { connections.get(run.runId)?.dispose(); connections.delete(run.runId); profiles.delete(run.runId); }
  function commandModel(run, profile, assertCurrent) {
    return () => {
      assertCurrent();
      profiles.set(run.runId, profile);
      return modelFor(run);
    };
  }
  const retryPagePreparation = createRetryPagePreparation({
    state,
    browser,
    readCurrentPageForRequest,
    enhancePageReading: deps.enhancePageReading,
    modelFor,
    setAssistantPhase,
    getConversation: () => state.conversation,
    retryTarget: deps.retryTarget,
    refreshRetry: deps.refreshRetry,
    waitWithTimeout,
  });
  const conversationQueue = createConversationQueue({
    state,
    isDisposed: () => disposed,
    isBusy: () => Boolean(state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy()),
    isPageDisabled: item => item.pageContextEnabled && item.readingPolicy?.scope !== 'none' && state.disablePageContext,
    isModelUnavailable: item => !directImageForMessage(item)
      && !profileFor(item.modelId ?? state.selectedModelId, item.effort ?? state.selectedEffort),
    getConversationId: () => state.conversation?.id,
    send: (content, options) => sendMessage(content, options),
    onChange: renderQueueBar,
  });
  async function generateReply(assistant, run) {
    run.assertCurrent();
    state.controller = { signal: run.signal, abort: reason => run.cancel(reason) };
    state.replyOwner = run;
    state.generatingId = run.ref.conversationId;
    state.activeAssistantId = assistant.id;
    updateComposer();
    emit('reply-started', { assistantId: assistant.id });
    try {
      const profile = profiles.get(run.runId);
      return await replyService.generate({ conversation: repository.get(run.ref).conversation, assistant, run,
        profile, modelRun: modelFor(run), contextWindow: contextWindowFor(profile, state.config),
        assertOwner: () => {
          if (disposed || state.replyOwner !== run || state.conversation?.id !== run.ref.conversationId) {
            throw new DOMException('本轮所属会话已切换或执行已被替换。', 'AbortError');
          }
        },
        favicon: state.activePageSignal?.favIconUrl || '' });
    } finally {
      if (state.replyOwner === run) {
        state.controller = null; state.replyOwner = null; state.generatingId = null; state.activeAssistantId = null;
        emit('reply-ended', { assistantId: assistant.id, selectionUsed: assistant.selectionUsed });
        updateComposer();
      }
    }
  }
  async function processQueue() {
    conversationQueue.process();
  }
  async function sendMessage(text = draft.value, options = {}) {
    if (disposed) return;
    const submittedText = plainText(text).trim();
    let command = null, commandRequest = null, commandResult = null, commandProfile = null;
    let restoredCommand;
    try { restoredCommand = rewoundCommandForDraft(state, submittedText, options); }
    catch (error) { toast(error.message, 'error'); return; }
    const requestedCommand = options.pageCommand || restoredCommand?.pageCommand;
    const modelId = options.modelId ?? state.selectedModelId;
    const effort = options.effort ?? state.selectedEffort;
    const imageCommand = !requestedCommand && directImageForMessage({ content: submittedText });
    let imageProfile;
    if (imageCommand) {
      try {
        if (options.agentTask ?? agentSlot?.isMode()) throw new Error('请先退出页面操作，再使用聊天生图。');
        imageProfile = structuredClone(profileFor(modelId, effort, { allowDefaultModel: true }));
        assertImageCommand(imageCommand, options.fromQueue ? options.attachments || [] : state.attachments, imageProfile);
      } catch (error) {
        toast(error.message, 'error');
        if (options.fromQueue) queueMicrotask(processQueue);
        return;
      }
    }
    if (requestedCommand) {
      try {
        command = Object.hasOwn(pageCommands, requestedCommand.kind) ? pageCommands[requestedCommand.kind] : null;
        if (!command) throw new Error('这个页面命令尚不可用，请重新打开侧栏。');
        commandRequest = command.capture(requestedCommand);
        commandProfile = structuredClone(profileFor(modelId, effort));
        command.validateSubmission?.(commandRequest, { restored: Boolean(restoredCommand), attachments: state.attachments,
          profile: commandProfile });
      } catch (error) { toast(error.message, 'error'); return; }
      if (state.disablePageContext && (!restoredCommand || command.needsRead({ attachments: state.attachments }))) {
        toast('请先选中原视频页面并开启页面读取，再使用视频笔记。'); return;
      }
      if (options.fromQueue || state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy()) {
        toast('请等待当前任务完成或停止后，再整理视频笔记。'); return;
      }
    }
    // Menu commands preserve concurrent drafts; a restored command belongs to
    // the question being edited and consumes that draft through the same run.
    const preserveDraft = Boolean((command && !restoredCommand) || options.preserveComposerDraft === true);
    let content = command?.promptFor?.(submittedText, commandRequest) || command?.prompt || submittedText;
    const displayContent = command ? submittedText || command.label : content;
    const requestSource = command ? null : normalizeDraftSource(options.fromQueue || Object.hasOwn(options, 'requestSource')
      ? options.requestSource : state.draftSource);
    const independent = requestSource?.scope === 'independent';
    let directModelRequest = !command && (independent || (options.directModelRequest ?? (state.directModelRequest === content)));
    let attachments = preserveDraft ? [] : structuredClone(options.fromQueue ? options.attachments || [] : state.attachments);
    const capturedSelection = command || independent || imageCommand ? null
      : Object.hasOwn(options, 'selection') ? options.selection : options.fromQueue ? options.selection : state.pageSelection;
    const selection = capturedSelection ? structuredClone(capturedSelection) : null;
    const clearSubmittedQuote = () => {
      if (!options.fromQueue && capturedSelection?.source === 'conversation' && state.pageSelection === capturedSelection) {
        setPageSelection(null);
      }
    };
    const agentTask = !command && !independent && Boolean(options.agentTask ?? agentSlot?.isMode());
    const pageContextEnabled = !command && !imageCommand && !agentTask && (options.pageContextEnabled ?? !state.disablePageContext) && !directModelRequest;
    let readingPolicy = (!independent && options.readingPolicy) || readingPolicyForTurn({ question: submittedText, pageContextEnabled,
      directModelRequest, selection, attachments, mode: agentTask ? 'agent' : 'chat', pageTitle: state.activePageSignal?.title });
    const readingOptions = readingOptionsAtSubmission(state, options, pageContextEnabled && readingPolicy.scope !== 'none');
    const readingHistory = options.fromQueue && options.readingHistory
      ? captureReadingHistory(options.readingHistory) : captureReadingHistory(state.conversation?.messages);
    const researchEnabled = false; // Legacy field; new turns use the versioned reading policy.
    const replaceActiveReply = !preserveDraft && state.directReplaceReply === true;

    if (!content && !attachments.length && !selection?.text) return;
    if (!state.ready || state.preparingAttachments) return;
    if (!command && !imageCommand && !profileFor(modelId, effort)) { requireModel(); return; }
    if (!preserveDraft) state.directReplaceReply = false;
    try {
      assertImageAttachmentsAvailable(attachments);
      selectedSkill(attachments, { agentTask });
      selectedVideoTranscript(attachments, { agentTask });
    }
    catch (error) { toast(error.message, 'error'); return; }
    // Capture the target at the click/queue event, before configuration or storage awaits.
    const pageTargetPromise = command || independent || imageCommand ? Promise.resolve(null) : options.pageTargetPromise || capturePageTarget({
      queryActiveTab: () => browser.queryActiveTab(),
      sendMessage: message => browser.sendMessage(message),
      bindDocument: agentTask || (pageContextEnabled && readingPolicy.scope !== 'none'),
    });
    // A queued snapshot can fail before its turn; retain that failure without an unhandled rejection.
    pageTargetPromise.catch(() => {});


    if (agentSlot?.isBusy()) {
      toast('浏览器任务仍在运行，请先停止或接管后再发送。', 'error');
      return;
    }

    const stoppedReply = !command && !options.fromQueue && !replaceActiveReply ? stoppedReplyForPrompt(state.conversation?.messages, submittedText, {
      pageSource: pageContextEnabled ? pageSourceFor(state.activePageSignal) : null,
      pageContextEnabled, researchEnabled, readingPolicy, readingOptions, agentTask, selection, attachments,
    }) : null;
    if (stoppedReply) {
      if (draft.value.trim() === submittedText) draft.value = '';
      if (!options.fromQueue) state.draftSource = null;
      if (!options.fromQueue) state.rewoundCommand = null;
      state.draft = draft.value;
      clearSubmittedQuote();
      resizeInput();
      await regenerate(stoppedReply.id);
      return;
    }

    const fingerprint = command ? JSON.stringify(commandRequest)
      : sendFingerprint({ text: submittedText, selection, attachments, agentTask, pageContextEnabled, readingPolicy, readingOptions });
    if (!options.fromQueue && !replaceActiveReply && isDuplicateSend({
      fingerprint,
      lastFingerprint: state.lastSentFingerprint,
      lastSentAt: state.lastSentAt,
    })) return;

    // A replacement owns a fresh submission lifecycle. Discard stale queued prompts
    // and invalidate the previous sender before starting this replacement.
    if (replaceActiveReply) {
      stopActiveReply();
      conversationQueue.clear();
      state.submissionOwner = null;
      state.isSubmitting = false;
      state.sendInFlight = false;
      renderQueueBar();
    }

    if (state.generatingId || state.isSubmitting || state.compressing) {
      const queueItem = {
        id: makeId(),
        modelId, effort,
        conversationId: state.conversation?.id || null,
        submissionOwner: state.conversation ? null : state.submissionOwner,
        content,
        attachments,
        selection,
        requestSource,
        directModelRequest,
        pageContextEnabled,
        researchEnabled,
        readingPolicy,
        readingOptions,
        readingHistory,
        agentTask,
        pageTargetPromise,
        preserveComposerDraft: options.preserveComposerDraft === true,
        deep: options.deep === true,
        createdAt: now(),
      };
      conversationQueue.enqueue(queueItem);
      state.lastSentFingerprint = fingerprint;
      state.lastSentAt = Date.now();
      if (directModelRequest && !preserveDraft) state.directModelRequest = '';
      directModelRequest = false;
      if (!preserveDraft) {
        draft.value = '';
        state.draft = '';
        state.draftSource = null;
        state.rewoundCommand = null;
        state.attachments = [];
        state.pageSelection = null;
      }
      resizeInput();
      renderAttachments();
      renderPageSelection();
      updateComposer();
      renderQueueBar();
      return;
    }

    const submissionOwner = runner.begin({ commandId: options.commandId || options.id || makeId(), mode: agentTask ? 'agent' : 'chat',
      ...(command ? { timeoutMs: command.executionTimeoutMs } : imageCommand ? { timeoutMs: IMAGE_TURN_TIMEOUT_MS } : {}) });
    if (['completed', 'failed', 'cancelled'].includes(submissionOwner.status)) return;
    const submissionController = { signal: submissionOwner.signal, abort: reason => submissionOwner.cancel(reason) };
    state.submissionController = submissionController;
    state.submissionOwner = submissionOwner;
    if (command || (!agentTask && pageContextEnabled && readingPolicy.scope !== 'none')) pagePreparations.add(submissionOwner);
    state.lastSentFingerprint = fingerprint;
    state.lastSentAt = Date.now();
    const releaseSendLocks = () => {
      state.sendInFlight = false;
      state.lastSentFingerprint = '';
    };
    state.sendInFlight = true;
    state.lastSentAt = Date.now();
    state.isSubmitting = true;
    let earlyConversation = null;
    let earlyUserMessage = null;
    let earlyAssistantMessage = null;
    const assertSubmission = () => {
      submissionOwner.assertCurrent();
      if (state.submissionOwner !== submissionOwner || (earlyConversation && state.conversation?.id !== earlyConversation.id)) {
        throw new DOMException('本次发送已取消', 'AbortError');
      }
    };
    const waitForPreparation = (pending, message, timeoutMs) => waitWithTimeout(pending, {
      signal: submissionController.signal, message, ...(timeoutMs ? { timeoutMs } : {}),
    });
    const restoreDraft = () => {
      if (earlyConversation && earlyUserMessage && earlyAssistantMessage) {
        earlyConversation.messages = earlyConversation.messages.filter(
          (message) => message.id !== earlyUserMessage.id && message.id !== earlyAssistantMessage.id,
        );
        renderConversation();
      }
      if (preserveDraft) { updateComposer(); return; }
      const hasNewDraft = Boolean(draft.value.trim());
      const restoredText = command ? submittedText || command.label : content;
      draft.value = hasNewDraft ? draft.value + '\n\n' + restoredText : restoredText;
      // Do not transfer a failed submission's scope onto text drafted later.
      if (!hasNewDraft) {
        state.draftSource = normalizeDraftSource(requestSource);
        state.rewoundCommand = restoredCommand ? structuredClone(restoredCommand) : null;
      }
      state.draft = draft.value;
      state.attachments = [...state.attachments, ...attachments.filter(item => !state.attachments.some(existing => existing.id === item.id))];
      if (!state.pageSelection && selection) setPageSelection(selection);
      renderAttachments();
      resizeInput();
      updateComposer();
    };
    // 立即清空输入框并重置尺寸，提供即时响应感，阻断短时间重复点击/回车
    if (!options.fromQueue && !preserveDraft) {
      draft.value = '';
      state.draft = '';
      state.draftSource = null;
      state.rewoundCommand = null;
      state.attachments = [];
      clearSubmittedQuote();
    }
    resizeInput();
    renderAttachments();
    updateComposer();

    try {
      const intendedTab = command
        ? commandRequest.target.documentId ? commandRequest.target : await waitForPreparation(capturePageTarget({
          queryActiveTab: async () => ({ ...commandRequest.target, id: commandRequest.target.tabId }),
          sendMessage: message => browser.sendMessage(message), signal: submissionController.signal,
        }), '确认原视频页面超时，请重试。')
        : pageContextEnabled || agentTask ? await waitForPreparation(pageTargetPromise, '获取当前页面超时，请重试。') : null;
      assertSubmission();
      if (command) commandRequest = command.capture({ ...commandRequest, target: intendedTab });
      earlyConversation = await waitForPreparation(ensureConversation(submissionController.signal), '准备会话超时，输入已保留，请重试。');
      assertSubmission();
      // Queueing is also possible while the first conversation is being created.
      // Bind only prompts captured by this submission; never adopt another queue.
      if (earlyConversation) {
        conversationQueue.bindConversation(submissionOwner, earlyConversation.id);
      }
      if (earlyConversation && content && !agentTask) {
        earlyUserMessage = {
          id: makeId(),
          role: 'user',
          content: messageWithSelection(content, selection),
          displayContent,
          ...(command ? { pageCommand: structuredClone(commandRequest) } : {}),
          pageContextEnabled: pageContextEnabled && readingPolicy.scope !== 'none',
          researchEnabled,
          readingPolicy,
          readingOptions,
          ...(requestSource ? { requestSource } : {}),
          agentTask,
          pageSource: pageContextEnabled && readingPolicy.scope !== 'none' && intendedTab?.url ? { ...pageSourceFor({ ...intendedTab, tabId: intendedTab.id }), unavailable: true } : null,
          selection: selection || null,
          status: 'complete',
          createdAt: now(),
          ...(attachments.length ? { attachments: attachments.slice(0, 6) } : {}),
          optimistic: true,
        };
        earlyAssistantMessage = {
          id: makeId(),
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: now(),
          model: modelId ?? activeChatProfile()?.id ?? '',
          modelId: modelId ?? activeChatProfile()?.id ?? '',
          reasoningEffort: effort,
          optimistic: true,
          ...command?.assistantFields,
        };
        earlyConversation.messages.push(earlyUserMessage, earlyAssistantMessage);
        submissionOwner.bind({ conversation: earlyConversation, user: earlyUserMessage, assistant: earlyAssistantMessage });
        if (!earlyConversation.title || earlyConversation.title === '新对话') {
          earlyConversation.title = conversationTitle(command ? displayContent : content, attachments);
        }
        renderConversation({ scroll: true });
        setAssistantPhase(earlyAssistantMessage, 'preparing');
        // Do not persist the optimistic streaming bubble; storage normalization
        // would turn it into a stopped message before the request starts.
      }
      if (command) {
        setAssistantPhase(earlyAssistantMessage, 'reading');
        commandResult = await waitForPreparation(command.prepare(commandRequest, {
          attachments,
          run: submissionOwner, allowPageRead: () => !state.disablePageContext, profile: commandProfile,
          getModelRun: commandModel(submissionOwner, commandProfile, assertSubmission),
        }), command.preparationMessage?.(commandRequest) || '读取视频字幕超时，请重试。',
          command.preparationTimeoutFor?.(commandRequest) ?? command.preparationTimeoutMs ?? 21000);
        assertSubmission();
        commandRequest = commandResult.request;
        attachments = structuredClone(commandResult.attachments);
        const accepted = repository.get(submissionOwner.ref);
        if (accepted) { accepted.user.pageCommand = structuredClone(commandRequest); accepted.user.attachments = structuredClone(attachments); }
        pagePreparations.delete(submissionOwner);
      }
      if (!commandResult?.reply) {
        if (!await waitForPreparation(ensureConfigured(submissionController.signal), '读取模型配置超时，请重试。')) {
          if (command) throw new Error('字幕已读取，请在设置中添加模型后重试。');
          restoreDraft();
          return;
        }
        assertSubmission();
        const available = imageProfile || profileFor(modelId, effort);
        if (!available || (command && !commandProfile)) {
          if (command) throw new Error('字幕已保留，请为当前对话选择模型后重试。');
          restoreDraft();
          requireModel();
          return;
        }
        profiles.set(submissionOwner.runId, structuredClone(command ? commandProfile : available));
      }
      assertSubmission();
      const savedSelectedImages = !agentTask ? retainedSelectionVisuals(selection, attachments) : [];
      if (!agentTask && selection?.visuals?.length && (!pageContextEnabled || readingPolicy.scope === 'none')) {
        throw new Error('选区包含图片，请开启“基于当前页”后重新发送。');
      }
      if (!agentTask && selection?.visuals?.length && !profiles.get(submissionOwner.runId)?.supportsVision) {
        throw new Error('选区包含图片，请选择支持视觉的模型后重新发送。');
      }
      if (!agentTask && selection?.visuals?.length) assertPageTarget(selection, intendedTab || {});
      if (agentTask) {
        if (!content) { restoreDraft(); toast('请描述要根据图片完成的页面操作。', 'error'); return; }
        const referenceImages = normalizeAgentReferenceImages(attachments);
        const profile = profiles.get(submissionOwner.runId);
        assertAgentVision(referenceImages, profile);
        assertAgentReferenceTarget(referenceImages, intendedTab);
        const conversation = await waitForPreparation(ensureConversation(submissionController.signal));
        assertSubmission();
        if (!conversation) {
          restoreDraft();
          return;
        }
        const userMessage = {
          id: makeId(),
          role: 'user',
          content,
          displayContent: content,
          status: 'complete',
          createdAt: now(),
          agentTask: true,
          readingPolicy,
          pageContextEnabled: false,
          pageSource: intendedTab?.url ? pageSourceFor({ ...intendedTab, tabId: intendedTab.id }) : null,
          ...(referenceImages.length ? { attachments: referenceImages, includeVisual: true } : {}),
        };
        conversation.messages.push(userMessage);
        earlyUserMessage = userMessage;
        if (conversation.messages.length === 1) conversation.title = truncateText(content, 34) || '浏览器任务';
        state.pendingPage = null;
        renderConversation({ scroll: true });
        await waitForPreparation((submissionOwner.ref ? repository.save(submissionOwner.ref, { required: true }) : saveCurrent({ required: true })), '保存消息超时，尚未开始任务，请重试。');
        assertSubmission();
        const started = await agentSlot.start(content, { target: intendedTab, referenceImages, profile });
        if (started) {
          updateComposer();
        } else {
          const userIndex = conversation.messages.findIndex(message => message.id === userMessage.id);
          const hasTaskReply = userIndex >= 0 && conversation.messages.slice(userIndex + 1).some(message => message.agent);
          if (!hasTaskReply) {
            conversation.messages = conversation.messages.filter((message) => message.id !== userMessage.id);
            restoreDraft();
          }
          renderConversation();
          scheduleSave();
        }
        return;
      }
      if (directModelRequest && !selection?.text) {
        state.pendingPage = null;
        if (!options.fromQueue) {
          state.pageSelection = null;
          renderPageSelection();
        }
      }
      if (selection?.url && !savedSelectedImages.length && selection.captureSource !== 'context-menu') {
        try {
          const tab = await waitForPreparation(pageTargetPromise, '获取选区页面超时，请重试。');
          if (tab?.id && /^https?:/i.test(tab.url || '')) {
            const result = await waitForPreparation(browser.sendMessage({ type: 'GET_PAGE_SELECTION', tabId: tab.id,
              expectedUrl: tab.url, ...(tab.documentId ? { documentId: tab.documentId } : {}) }), '核对网页选区超时，请重试。');
            assertSubmission();
            const liveText = String(result?.selection?.text || '');
            if (liveText && (liveText !== selection.text || (selection.visuals?.length && !pageSelectionMatches(selection, result.selection)))) {
              setPageSelection(result.selection);
              toast('网页选区已变化，请确认后重新发送。');
              restoreDraft();
              return;
            }
            if (!liveText) {
              setPageSelection(null);
              toast('网页中的选中文字已取消。');
              restoreDraft();
              return;
            }
          }
        } catch (error) {
          if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
          if (selection?.visuals?.length) throw error;
          // Privileged pages may block script execution; keep the captured text.
        }
      }
      if (!preserveDraft && (!pageContextEnabled || readingPolicy.scope === 'none')) state.pendingPage = null;
      let requestPage = null;
      if (pageContextEnabled && readingPolicy.scope !== 'none') {
        const target = intendedTab;
        assertSubmission();
        if (target?.id && isReadablePageUrl(target.url)) {
          if (selection?.url && normalizePageUrl(selection.url) !== normalizePageUrl(target.url)) throw new Error('选中文字来自另一页面，请重新选择后发送。');
          const repository = Boolean(parseRepositoryUrl(target.url) && /源码|代码仓库|仓库结构|source code|repository/i.test(content));
          setAssistantPhase(earlyAssistantMessage, 'reading');
          if (repository) readingPolicy = { ...readingPolicy, scope: 'page' };
          requestPage = await preparePageReading(content, {
            target, readingPolicy, signal: submissionController.signal,
            readPage: ({ target: readTarget, signal, timeoutMs }) => readCurrentPageForRequest(content, {
              target: readTarget, repository, deep: !deps.enhancePageReading && options.deep === true, signal, timeoutMs,
            }),
            sendMessage: message => browser.sendMessage(message),
            onPhase: phase => { if (!submissionController.signal.aborted) setAssistantPhase(earlyAssistantMessage, phase); },
          });
          assertSubmission();
          if (!requestPage || normalizePageUrl(requestPage.url) !== normalizePageUrl(target.url)) throw new Error('未能读取本轮页面，请重试或关闭页面开关后发送。');
          if (deps.enhancePageReading && !repository) {
            const supplementalTarget = { ...target, documentId: requestPage.documentId || target.documentId };
            requestPage = await waitForPreparation(deps.enhancePageReading(content, {
              page: requestPage, target: supplementalTarget,
              cacheScope: { conversationId: earlyConversation?.id },
              ...readingOptions, history: readingHistory, modelRun: modelFor(submissionOwner),
              signal: submissionController.signal,
              onPhase: phase => { assertSubmission(); setAssistantPhase(earlyAssistantMessage, phase); },
            }), '补充页面资料超时，请重试。', 25000);
            assertSubmission();
            assertPageTarget(supplementalTarget, requestPage);
          }
          readingPolicy = requestPage.readingPolicy || readingPolicy;
          state.pendingPage = requestPage;
        } else if (options.requirePage || readingPolicy.requireCurrentPage) {
          throw new Error('当前页面没有可读取的正文，请切换到网页后重试。');
        }
      }
      const visualPage = requestPage;
      if (selection?.visuals?.length && !savedSelectedImages.length) {
        setAssistantPhase(earlyAssistantMessage, 'reading');
        const selectedImages = await captureSelectionVisuals({ selection,
          target: requestPage || intendedTab, profile: profiles.get(submissionOwner.runId), attachments,
          sendMessage: message => browser.sendMessage(message), signal: submissionController.signal });
        assertSubmission();
        attachments = [...attachments, ...selectedImages];
        // Keep accepted pixels on this turn even if later storage preparation
        // fails or is stopped; retry must not recapture a changed page image.
        const preparedTurn = repository.get(submissionOwner.ref);
        if (preparedTurn) {
          preparedTurn.user.attachments = structuredClone(attachments);
          preparedTurn.user.includeVisual = true;
        }
        if (selection.visualsTruncated) toast(`选区共有 ${selection.visualCount} 张图片，本轮读取前 ${selection.visuals.length} 张。`);
      }
      const mentionsVisual = requestPage?.readingAssessment?.visualRecommended === true
        || /截图|看图|看下图|图表|图片|界面|样式|长相|长什么样|视觉|颜色|排版/i.test(content);
      if (!researchEnabled && mentionsVisual && content && visualPage && !attachments.some((attachment) => attachment.type === 'image')) {
        const automatic = await waitForPreparation(autoVisualAttachments(content, visualPage, submissionController.signal, modelFor(submissionOwner)), '读取页面图片超时，请重试。');
        assertSubmission();
        if (automatic.length) {
          attachments = [...attachments, ...automatic];
          const pendingPage = state.pendingPage;
          if (pendingPage) pendingPage.visualCapturedAt = now();
        }
      }
      // The remaining work uses accepted page data, with no further browser read.
      pagePreparations.delete(submissionOwner);
      // Capture before ensureConversation(): creating a new conversation clears pendingPage.
      const pendingPage = state.pendingPage;
      const conversation = await waitForPreparation(ensureConversation(submissionController.signal));
      assertSubmission();
      if (!conversation) {
        restoreDraft();
        return;
      }
      const firstMessage = conversation.messages.length === 0;
      if (requestPage) conversation.pageContext = requestPage;
      if (!preserveDraft) state.pendingPage = null;
      renderContextChip();
      setAssistantPhase(earlyAssistantMessage, 'saving');
      const storage = await waitForPreparation(getDirectoryInfo(), '获取保存位置超时，请重试。');
      assertSubmission();
      if (storage.granted && !conversation.storage) conversation.storage = 'temporary';
      if (conversation.storage !== 'local' && storage.granted) {
        const promoted = await waitForPreparation(promoteTemporaryConversation(conversation), '保存会话超时，尚未请求模型，请重试。');
        assertSubmission();
        Object.assign(conversation, promoted);
        earlyUserMessage = conversation.messages.find(message => message.id === earlyUserMessage?.id) || null;
        earlyAssistantMessage = conversation.messages.find(message => message.id === earlyAssistantMessage?.id) || null;
        state.storageInfo = storage;
      }
      const selectionForMessage = selection || null;
      const messageText = messageWithSelection(content, selectionForMessage);
      const turnSource = pageSourceFor(requestPage);
      const includeVisual = attachments.some((attachment) => attachment.type === 'image')
        && (selection?.visuals?.length ? profiles.get(submissionOwner.runId)?.supportsVision === true : hasVision());
      if (earlyAssistantMessage) earlyAssistantMessage.selectionUsed = selectionForMessage;
      if (earlyUserMessage && conversation.messages.includes(earlyUserMessage)) {
        earlyUserMessage.pageSource = turnSource;
        earlyUserMessage.pageContextEnabled = pageContextEnabled && Boolean(requestPage);
        earlyUserMessage.researchEnabled = researchEnabled;
        earlyUserMessage.readingPolicy = readingPolicy;
        earlyUserMessage.readingOptions = readingOptions;
        if (requestSource) earlyUserMessage.requestSource = requestSource;
        earlyUserMessage.content = messageText;
        earlyUserMessage.displayContent = displayContent;
        if (command) earlyUserMessage.pageCommand = structuredClone(commandRequest);
        earlyUserMessage.selection = selectionForMessage;
        earlyUserMessage.includeVisual = includeVisual;
        earlyUserMessage.attachments = attachments.slice(0, 6);
      } else {
        earlyUserMessage = {
            id: makeId(),
            role: 'user',
            content: messageText,
            pageSource: turnSource,
            pageContextEnabled: pageContextEnabled && Boolean(requestPage),
            researchEnabled,
            readingPolicy,
            readingOptions,
            ...(requestSource ? { requestSource } : {}),
            agentTask,
            displayContent,
            ...(command ? { pageCommand: structuredClone(commandRequest) } : {}),
            selection: selectionForMessage,
            status: 'complete',
            createdAt: now(),
            ...(includeVisual ? { includeVisual: true } : {}),
            ...(attachments.length ? { attachments: attachments.slice(0, 6) } : {}),
          };
        earlyAssistantMessage = { id: makeId(), role: 'assistant', content: '', status: 'streaming', createdAt: now(), model: modelId ?? activeChatProfile()?.id ?? '', modelId: modelId ?? activeChatProfile()?.id ?? '', reasoningEffort: effort, selectionUsed: selectionForMessage };
        Object.assign(earlyAssistantMessage, command?.assistantFields);
        conversation.messages.push(earlyUserMessage, earlyAssistantMessage);
        submissionOwner.bind({ conversation, user: earlyUserMessage, assistant: earlyAssistantMessage });
      }
      if (firstMessage) conversation.title = conversationTitle(command?.label || content || selectionForMessage?.text || '', attachments);
      if (selectionForMessage && selectionForMessage.source !== 'conversation' && !options.fromQueue) {
        setPageSelection(selectionForMessage);
      }
      if (!options.fromQueue && !preserveDraft) state.attachments = [];
      renderAttachments();
      if (earlyUserMessage && earlyAssistantMessage) finalizePendingTurn(conversation, earlyUserMessage.id, earlyAssistantMessage.id);
      renderConversation({ scroll: true });
      setAssistantPhase(conversation.messages.at(-1), 'saving');
      await waitForPreparation((submissionOwner.ref ? repository.save(submissionOwner.ref, { required: true }) : saveCurrent({ required: true })), '保存消息超时，尚未请求模型，请重试。');
      assertSubmission();
      if (commandResult?.reply) { submissionOwner.complete(commandResult.reply); renderConversation(); }
      else await generateReply(earlyAssistantMessage, submissionOwner);
    } catch (error) {
      const cancelled = error.name === 'AbortError' || submissionController.signal.aborted;
      submissionOwner.fail(cancelled ? new DOMException('请求已取消。', 'AbortError') : error);
      const target = earlyConversation || state.conversation;
      const pending = repository.get(submissionOwner.ref);
      if (pending) {
        if (state.conversation?.id === target.id) { renderConversation(); scheduleSave(); }
      } else if (state.submissionOwner === submissionOwner && !earlyUserMessage) {
        restoreDraft();
      }
      if (!cancelled) toast('发送失败：' + (error.message || '未知错误'), 'error');
    } finally {
      pagePreparations.delete(submissionOwner);
      if (!['completed', 'failed', 'cancelled'].includes(submissionOwner.status)) {
        if (agentTask) submissionOwner.complete(); else submissionOwner.cancel();
      }
      disposeModel(submissionOwner);
      if (directModelRequest && state.submissionOwner === submissionOwner) state.directModelRequest = '';
      if (state.submissionOwner === submissionOwner) {
        state.submissionController = null;
        state.submissionOwner = null;
        state.isSubmitting = false;
        releaseSendLocks();
        updateComposer();
        processQueue();
      }
    }
  }

  function stopActiveReply() {
    runner.cancel();
    const owner = state.replyOwner;
    const controller = state.controller;
    state.submissionController?.abort();
    state.compressionController?.abort();
    owner?.controller?.abort();
    for (const message of state.conversation?.messages || []) {
      if (!message.agent) settleInterruptedReply(message, { aborted: true });
    }
    state.replyOwner = null;
    state.controller = null;
    state.generatingId = null;
    state.activeAssistantId = null;
    controller?.abort();
    return Boolean(owner || controller);
  }

  function cancelPagePreparation() {
    const owner = state.submissionOwner;
    if (!owner || owner.signal.aborted || !pagePreparations.has(owner)) return false;
    stopActiveReply();
    return true;
  }

  async function regenerate(assistantId, { preparationAction } = {}) {
    if (disposed) return;
    if (agentSlot?.isBusy()) return;
    const conversation = state.conversation;
    if (!conversation?.messages.some((message) => message.id === assistantId && message.role === 'assistant')) return;
    if (conversation.messages.find(message => message.id === assistantId)?.agent) return;
    const retryIndex = conversation.messages.findIndex(message => message.id === assistantId);
    const originalQuestion = conversation.messages.slice(0, retryIndex).findLast(message => message.role === 'user');
    const modelId = state.selectedModelId, effort = state.selectedEffort;
    const imageCommand = directImageForMessage(originalQuestion);
    let imageProfile;
    let command = null, commandRequest = null, commandProfile = null, commandAttachments = [];
    if (originalQuestion?.pageCommand) {
      try {
        command = Object.hasOwn(pageCommands, originalQuestion.pageCommand.kind) ? pageCommands[originalQuestion.pageCommand.kind] : null;
        if (!command) throw new Error('本轮页面命令尚不可用，不能改用普通提问重试。');
        // Refuse unknown versions before replacing any existing answer, and
        // capture a private copy before the retry's first asynchronous wait.
        commandProfile = structuredClone(profileFor(modelId, effort));
        const snapshot = command.captureRetry(originalQuestion, { conversationId: conversation.id, preparationAction, profile: commandProfile });
        commandRequest = snapshot.request;
        commandAttachments = snapshot.attachments;
        preparationAction = snapshot.preparationAction;
      } catch (error) { toast(error.message, 'error'); return; }
      if ((commandAttachments.length || commandRequest.frameFallback) && !commandProfile) { requireModel(); return; }
    } else if (imageCommand) {
      try {
        imageProfile = structuredClone(profileFor(modelId, effort, { allowDefaultModel: true }));
        assertImageCommand(imageCommand, originalQuestion.attachments || [], imageProfile);
      } catch (error) { toast(error.message, 'error'); return; }
    } else if (!profileFor(modelId, effort)) { requireModel(); return; }
    stopActiveReply();
    conversationQueue.clear();
    const submissionOwner = runner.begin({ commandId: makeId(), mode: 'chat',
      ...(command ? { timeoutMs: command.executionTimeoutMs } : imageCommand ? { timeoutMs: IMAGE_TURN_TIMEOUT_MS } : {}) });
    const submissionController = { signal: submissionOwner.signal, abort: reason => submissionOwner.cancel(reason) };
    state.submissionOwner = submissionOwner;
    state.submissionController = submissionController;
    state.isSubmitting = true;
    state.sendInFlight = true;
    renderQueueBar();
    updateComposer();
    const commandNeedsRead = command?.needsRead({ attachments: commandAttachments, preparationAction });
    let commandResult = null;
    // Freeze verified evidence before any configuration, browser or storage wait.
    const retainedPage = commandRequest || imageCommand ? null : retryPagePreparation.retainedPageForRetry(conversation, originalQuestion);
    if (commandNeedsRead) pagePreparations.add(submissionOwner);
    if (!commandRequest && !imageCommand && originalQuestion
      && retryPagePreparation.needsPagePreparation(originalQuestion, retainedPage)) pagePreparations.add(submissionOwner);
    const readingHistory = captureReadingHistory(conversation.messages.slice(0, Math.max(0, conversation.messages.indexOf(originalQuestion))));
    const retryTargetPromise = commandRequest || imageCommand ? Promise.resolve({ target: null, page: null }) : originalQuestion
      ? retryPagePreparation.prepareRetryContext({ ...originalQuestion }, retainedPage, submissionController.signal).then(context => {
        if (context.page) pagePreparations.delete(submissionOwner);
        return context;
      })
      : Promise.reject(new Error('找不到这条回答对应的提问，无法重新生成。'));
    retryTargetPromise.catch(() => {});
    let next = null;
    const assertCurrent = () => {
      submissionOwner.assertCurrent();
      if (state.submissionOwner !== submissionOwner || state.conversation !== conversation) {
        throw new DOMException('本次重试已取消', 'AbortError');
      }
    };
    // File writes may safely finish in the storage queue after cancellation;
    // their completion must not retain the UI lock or launch a late request.
    const waitForCurrent = (pending) => new Promise((resolve, reject) => {
      const signal = submissionController.signal;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        callback(value);
      };
      const cancel = () => finish(reject, new DOMException('本次重试已取消', 'AbortError'));
      signal.addEventListener('abort', cancel, { once: true });
      Promise.resolve(pending).then((value) => finish(resolve, value), (error) => finish(reject, error));
      if (signal.aborted) cancel();
    });
    try {
      if (!command) {
        const configured = await waitWithTimeout(ensureConfigured(submissionController.signal), { signal: submissionController.signal, message: '读取模型配置超时，请重试。' });
        assertCurrent();
        if (!configured) return;
        const profile = imageProfile || profileFor(modelId, effort);
        if (!profile) { requireModel(); return; }
        profiles.set(submissionOwner.runId, structuredClone(profile));
      }
      const messages = conversation.messages;
      const assistant = find(messages, (message) => message.id === assistantId);
      if (!assistant || assistant.role !== 'assistant') return;
      const replacement = { id: makeId(), role: 'assistant', content: '', status: 'streaming', requestPhase: 'preparing', createdAt: now(), model: modelId ?? activeChatProfile()?.id ?? '', modelId: modelId ?? activeChatProfile()?.id ?? '', reasoningEffort: effort };
      Object.assign(replacement, command?.assistantFields);
      const replacementMessages = messagesForRetry(messages, assistantId, replacement);
      if (!replacementMessages) throw new Error('找不到这条回答对应的提问，无法重新生成。');
      const question = replacementMessages.findLast((message) => message.role === 'user');
      if (!question) throw new Error('找不到这条回答对应的提问，无法重新生成。');
      const { target, page: retainedReading } = await waitForCurrent(retryTargetPromise);
      assertCurrent();
      if (!imageCommand && question.selection?.visuals?.length) assertPageTarget(question.selection, retainedReading || target || {});
      const ref = repository.retry({ conversation, assistantId, runId: submissionOwner.runId, assistant: replacement });
      const retained = repository.get(ref);
      next = retained.assistant;
      if (!target && !retainedReading) retained.user.pageContextEnabled = false;
      submissionOwner.bind({ conversation, user: retained.user, assistant: next });
      renderConversation({ scroll: true });
      setAssistantPhase(next, 'preparing');
      if (command) {
        setAssistantPhase(next, commandNeedsRead ? 'reading' : 'preparing');
        commandResult = await waitWithTimeout(command.prepare(commandRequest, {
          attachments: commandAttachments, run: submissionOwner, preparationAction, profile: commandProfile,
          allowPageRead: () => preparationAction === 'continue' ? state.pageContextPreference !== false : !state.disablePageContext,
          getModelRun: commandModel(submissionOwner, commandProfile, assertCurrent),
        }), { signal: submissionController.signal, timeoutMs: command.preparationTimeoutFor?.(commandRequest) ?? command.preparationTimeoutMs ?? 21000,
          message: command.preparationMessage?.(commandRequest) || '读取原视频字幕超时，请重试。' });
        assertCurrent();
        retained.user.pageCommand = structuredClone(commandResult.request);
        retained.user.attachments = structuredClone(commandResult.attachments);
        pagePreparations.delete(submissionOwner);
        if (!commandResult.reply) {
          const configured = await waitWithTimeout(ensureConfigured(submissionController.signal), {
            signal: submissionController.signal, message: '读取模型配置超时，请重试。',
          });
          assertCurrent();
          if (!configured) throw new Error('字幕已保留，请在设置中添加模型后重试。');
          if (!commandProfile || !profileFor(modelId, effort)) throw new Error('字幕已保留，请为当前对话选择模型后重试。');
          profiles.set(submissionOwner.runId, commandProfile);
        }
      } else if (retainedReading) {
        pagePreparations.delete(submissionOwner);
        conversation.pageContext = retainedReading;
        state.pendingPage = null;
        toast('本次重试使用本轮已读的原页面资料，未重新读取当前页面。');
      } else if (!imageCommand) {
        await waitForCurrent(retryPagePreparation.refreshPageForRetry(conversation, retained.user, next,
          submissionController.signal, target, submissionOwner, readingHistory));
      }
      assertCurrent();
      if (!imageCommand && retained.user.selection?.visuals?.length) {
        const fixedProfile = profiles.get(submissionOwner.runId);
        if (!fixedProfile?.supportsVision) throw new Error('选区包含图片，请选择支持视觉的模型后重试。');
        const existing = retained.user.attachments || [];
        assertImageAttachmentsAvailable(existing);
        const captured = retainedSelectionVisuals(retained.user.selection, existing);
        if (!captured.length) {
          const images = await captureSelectionVisuals({ selection: retained.user.selection, target,
            profile: fixedProfile, attachments: existing, signal: submissionController.signal,
            sendMessage: message => browser.sendMessage(message) });
          assertCurrent();
          retained.user.attachments = [...existing, ...images];
        }
        retained.user.includeVisual = true;
      }
      pagePreparations.delete(submissionOwner);
      setAssistantPhase(next, 'saving');
      await waitWithTimeout((submissionOwner.ref ? repository.save(submissionOwner.ref, { required: true }) : saveCurrent({ required: true })), { signal: submissionController.signal, message: '保存消息超时，尚未请求模型，请重试。' });
      assertCurrent();
      if (!conversation.messages.includes(next)) return;
      if (commandResult?.reply) { submissionOwner.complete(commandResult.reply); renderConversation(); }
      else await waitForCurrent(generateReply(next, submissionOwner));
    } catch (error) {
      const cancelled = submissionController.signal.aborted || error.name === 'AbortError';
      submissionOwner.fail(cancelled ? new DOMException('请求已取消。', 'AbortError') : error);
      if (next && conversation.messages.includes(next)) {
        if (state.conversation === conversation) {
          renderConversation();
          scheduleSave();
        }
      }
      if (!cancelled) toast(error.message || '重新生成失败。', 'error');
    } finally {
      pagePreparations.delete(submissionOwner);
      if (!['completed', 'failed', 'cancelled'].includes(submissionOwner.status)) submissionOwner.cancel();
      disposeModel(submissionOwner);
      if (state.submissionOwner === submissionOwner) {
        state.submissionOwner = null;
        state.submissionController = null;
        state.isSubmitting = false;
        state.sendInFlight = false;
        updateComposer();
        processQueue();
      }
    }
  }


  return Object.freeze({ sendMessage, regenerate, stopActiveReply, cancelPagePreparation, processQueue,
    validateRetryPageTarget: retryPagePreparation.validateRetryPageTarget,
    refreshPageForRetry: retryPagePreparation.refreshPageForRetry,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; runner.cancel(); for (const connection of connections.values()) connection.dispose(); connections.clear(); profiles.clear(); listeners.clear(); } });
}

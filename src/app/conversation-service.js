import { awaitWithAbort, awaitWithTimeout } from '../utils/abortable.js';
import { finalizePendingTurn, pageSourceFor } from '../utils/turn-source.js';
import { messageWithSelection } from '../utils/selection.js';
import { readingPolicyForTurn, readingPolicyForRetry } from '../utils/reading-plan.js';
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
import { captureReadingHistory, normalizeReadingOptions, readingOptionsAtSubmission } from '../utils/reading-options.js';
import { assertImageAttachmentsAvailable } from '../utils/attachments.js';

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
  const listeners = new Set();
  let disposed = false;
  const profiles = new Map(), connections = new Map();
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
    if (disposed) return;
    if (!state.messageQueue || state.messageQueue.length === 0) return;
    if (state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy()) return;
    const head = state.messageQueue[0];
    // A queued prompt belongs to the conversation captured at submission, even
    // if a disabled page switch leaves it waiting while another chat is opened.
    if (Object.hasOwn(head, 'conversationId') && head.conversationId !== state.conversation?.id) {
      renderQueueBar();
      return;
    }
    if (state.messageQueue[0].pageContextEnabled && state.messageQueue[0].readingPolicy?.scope !== 'none' && state.disablePageContext) {
      renderQueueBar();
      return;
    }
    const next = state.messageQueue.shift();
    renderQueueBar();
    if (next) {
      void sendMessage(next.content, { ...next, fromQueue: true });
    }
  }
  async function sendMessage(text = draft.value, options = {}) {
    if (disposed) return;
    const submittedText = plainText(text).trim();
    const modelId = options.modelId || state.selectedModelId;
    const effort = options.effort || state.selectedEffort;
    let content = submittedText;
    const requestSource = normalizeDraftSource(options.fromQueue || Object.hasOwn(options, 'requestSource')
      ? options.requestSource : state.draftSource);
    const independent = requestSource?.scope === 'independent';
    let directModelRequest = independent || (options.directModelRequest ?? (state.directModelRequest === content));
    let attachments = structuredClone(options.fromQueue ? options.attachments || [] : state.attachments);
    const capturedSelection = independent ? null : options.fromQueue ? options.selection : state.pageSelection;
    const selection = capturedSelection ? { ...capturedSelection } : null;
    const agentTask = !independent && Boolean(options.agentTask ?? agentSlot?.isMode());
    const pageContextEnabled = !agentTask && (options.pageContextEnabled ?? !state.disablePageContext) && !directModelRequest;
    let readingPolicy = (!independent && options.readingPolicy) || readingPolicyForTurn({ question: submittedText, pageContextEnabled,
      directModelRequest, selection, attachments, mode: agentTask ? 'agent' : 'chat', pageTitle: state.activePageSignal?.title });
    const readingOptions = readingOptionsAtSubmission(state, options, pageContextEnabled && readingPolicy.scope !== 'none');
    const readingHistory = options.fromQueue && options.readingHistory
      ? captureReadingHistory(options.readingHistory) : captureReadingHistory(state.conversation?.messages);
    const researchEnabled = false; // Legacy field; new turns use the versioned reading policy.
    const replaceActiveReply = state.directReplaceReply === true;
    state.directReplaceReply = false;

    if (!content && !attachments.length && !selection?.text) return;
    if (!state.ready || state.preparingAttachments) return;
    try { assertImageAttachmentsAvailable(attachments); }
    catch (error) { toast(error.message, 'error'); return; }
    // Capture the target at the click/queue event, before configuration or storage awaits.
    const pageTargetPromise = independent ? Promise.resolve(null) : options.pageTargetPromise || capturePageTarget({
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

    const stoppedReply = !options.fromQueue && !replaceActiveReply ? stoppedReplyForPrompt(state.conversation?.messages, submittedText, {
      pageSource: pageContextEnabled ? pageSourceFor(state.activePageSignal) : null,
      pageContextEnabled, researchEnabled, readingPolicy, readingOptions, agentTask, selection, attachments,
    }) : null;
    if (stoppedReply) {
      if (draft.value.trim() === submittedText) draft.value = '';
      if (!options.fromQueue) state.draftSource = null;
      state.draft = draft.value;
      resizeInput();
      await regenerate(stoppedReply.id);
      return;
    }

    const fingerprint = sendFingerprint({ text: submittedText, selection, attachments, agentTask, pageContextEnabled, readingPolicy, readingOptions });
    if (!options.fromQueue && !replaceActiveReply && isDuplicateSend({
      fingerprint,
      lastFingerprint: state.lastSentFingerprint,
      lastSentAt: state.lastSentAt,
    })) return;

    // A replacement owns a fresh submission lifecycle. Discard stale queued prompts
    // and invalidate the previous sender before starting this replacement.
    if (replaceActiveReply) {
      stopActiveReply();
      state.messageQueue = [];
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
        deep: options.deep === true,
        createdAt: now(),
      };
      state.messageQueue.push(queueItem);
      state.lastSentFingerprint = fingerprint;
      state.lastSentAt = Date.now();
      if (directModelRequest) state.directModelRequest = '';
      directModelRequest = false;
      draft.value = '';
      state.draft = '';
      state.draftSource = null;
      state.attachments = [];
      state.pageSelection = null;
      resizeInput();
      renderAttachments();
      renderPageSelection();
      updateComposer();
      renderQueueBar();
      toast('已加入排队，将在当前回答完成后自动发送');
      return;
    }

    const submissionOwner = runner.begin({ commandId: options.commandId || options.id || makeId(), mode: agentTask ? 'agent' : 'chat' });
    if (['completed', 'failed', 'cancelled'].includes(submissionOwner.status)) return;
    const submissionController = { signal: submissionOwner.signal, abort: reason => submissionOwner.cancel(reason) };
    state.submissionController = submissionController;
    state.submissionOwner = submissionOwner;
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
      const hasNewDraft = Boolean(draft.value.trim());
      draft.value = hasNewDraft ? draft.value + '\n\n' + content : content;
      // Do not transfer a failed submission's scope onto text drafted later.
      if (!hasNewDraft) state.draftSource = normalizeDraftSource(requestSource);
      state.draft = draft.value;
      state.attachments = [...state.attachments, ...attachments.filter(item => !state.attachments.some(existing => existing.id === item.id))];
      if (!state.pageSelection && selection) setPageSelection(selection);
      renderAttachments();
      resizeInput();
      updateComposer();
    };
    // 立即清空输入框并重置尺寸，提供即时响应感，阻断短时间重复点击/回车
    if (!options.fromQueue) {
      draft.value = '';
      state.draft = '';
      state.draftSource = null;
      state.attachments = [];
    }
    resizeInput();
    renderAttachments();
    updateComposer();

    try {
      const intendedTab = pageContextEnabled || agentTask ? await waitForPreparation(pageTargetPromise, '获取当前页面超时，请重试。') : null;
      assertSubmission();
      earlyConversation = await waitForPreparation(ensureConversation(submissionController.signal), '准备会话超时，输入已保留，请重试。');
      assertSubmission();
      // Queueing is also possible while the first conversation is being created.
      // Bind only prompts captured by this submission; never adopt another queue.
      if (earlyConversation) {
        for (const item of state.messageQueue) {
          if (item.conversationId === null && item.submissionOwner === submissionOwner) {
            item.conversationId = earlyConversation.id;
            delete item.submissionOwner;
          }
        }
      }
      if (earlyConversation && content && !agentTask) {
        earlyUserMessage = {
          id: makeId(),
          role: 'user',
          content: messageWithSelection(content, selection),
          displayContent: content,
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
          model: activeChatProfile()?.id || '',
          modelId: activeChatProfile()?.id || '',
          reasoningEffort: state.selectedEffort,
          optimistic: true,
        };
        earlyConversation.messages.push(earlyUserMessage, earlyAssistantMessage);
        submissionOwner.bind({ conversation: earlyConversation, user: earlyUserMessage, assistant: earlyAssistantMessage });
        if (!earlyConversation.title || earlyConversation.title === '新对话') {
          earlyConversation.title = conversationTitle(content, attachments);
        }
        renderConversation({ scroll: true });
        setAssistantPhase(earlyAssistantMessage, 'preparing');
        // Do not persist the optimistic streaming bubble; storage normalization
        // would turn it into a stopped message before the request starts.
      }
      if (!await waitForPreparation(ensureConfigured(submissionController.signal), '读取模型配置超时，请重试。')) {
        restoreDraft();
        return;
      }
      assertSubmission();
      profiles.set(submissionOwner.runId, structuredClone(profileFor(modelId, effort)));
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
      if (selection?.url) {
        try {
          const tab = await waitForPreparation(pageTargetPromise, '获取选区页面超时，请重试。');
          if (tab?.id && /^https?:/i.test(tab.url || '')) {
            const result = await waitForPreparation(browser.sendMessage({ type: 'GET_PAGE_SELECTION', tabId: tab.id }), '核对网页选区超时，请重试。');
            assertSubmission();
            const liveText = String(result?.selection?.text || '');
            if (liveText && liveText !== selection.text) {
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
          // Privileged pages may block script execution; keep the captured text.
        }
      }
      if (!pageContextEnabled || readingPolicy.scope === 'none') state.pendingPage = null;
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
      state.pendingPage = null;
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
      const includeVisual = attachments.some((attachment) => attachment.type === 'image') && hasVision();
      if (earlyAssistantMessage) earlyAssistantMessage.selectionUsed = selectionForMessage;
      if (earlyUserMessage && conversation.messages.includes(earlyUserMessage)) {
        earlyUserMessage.pageSource = turnSource;
        earlyUserMessage.pageContextEnabled = pageContextEnabled && Boolean(requestPage);
        earlyUserMessage.researchEnabled = researchEnabled;
        earlyUserMessage.readingPolicy = readingPolicy;
        earlyUserMessage.readingOptions = readingOptions;
        if (requestSource) earlyUserMessage.requestSource = requestSource;
        earlyUserMessage.content = messageText;
        earlyUserMessage.displayContent = content;
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
            displayContent: content,
            selection: selectionForMessage,
            status: 'complete',
            createdAt: now(),
            ...(includeVisual ? { includeVisual: true } : {}),
            ...(attachments.length ? { attachments: attachments.slice(0, 6) } : {}),
          };
        earlyAssistantMessage = { id: makeId(), role: 'assistant', content: '', status: 'streaming', createdAt: now(), model: activeChatProfile()?.id || '', modelId: activeChatProfile()?.id || '', reasoningEffort: state.selectedEffort, selectionUsed: selectionForMessage };
        conversation.messages.push(earlyUserMessage, earlyAssistantMessage);
        submissionOwner.bind({ conversation, user: earlyUserMessage, assistant: earlyAssistantMessage });
      }
      if (firstMessage) conversation.title = conversationTitle(content || selectionForMessage?.text || '', attachments);
      if (selectionForMessage && !options.fromQueue) {
        state.pageSelection = selectionForMessage;
        renderPageSelection();
      }
      if (!options.fromQueue) state.attachments = [];
      renderAttachments();
      if (earlyUserMessage && earlyAssistantMessage) finalizePendingTurn(conversation, earlyUserMessage.id, earlyAssistantMessage.id);
      renderConversation({ scroll: true });
      setAssistantPhase(conversation.messages.at(-1), 'saving');
      await waitForPreparation((submissionOwner.ref ? repository.save(submissionOwner.ref, { required: true }) : saveCurrent({ required: true })), '保存消息超时，尚未请求模型，请重试。');
      assertSubmission();
      await generateReply(earlyAssistantMessage, submissionOwner);
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

  async function validateRetryPageTarget(question, signal) {
    if (deps.retryTarget) return deps.retryTarget(question, signal);
    signal?.throwIfAborted();
    // Retrying an ordinary question must retain its original scope.
    if (readingPolicyForRetry(question).scope === 'none' || question.pageContextEnabled === false || (!question.pageSource?.url && question.pageContextEnabled !== true)) {
      question.pageContextEnabled = false;
      return null;
    }
    if (state.disablePageContext) throw new Error('页面读取已关闭，请开启页面开关后再重试。');
    const originalUrl = normalizePageUrl(question.pageSource?.url);
    if (!originalUrl) throw new Error('这条提问没有记录页面来源，请针对当前页面重新提问。');
    const target = await waitWithTimeout(capturePageTarget({
      queryActiveTab: () => browser.queryActiveTab(),
      sendMessage: message => browser.sendMessage(message), signal,
    }), {
      signal, message: '获取重试页面超时，请重试。',
    });
    signal?.throwIfAborted();
    if (!target?.id || !isReadablePageUrl(target.url) || normalizePageUrl(target.url) !== originalUrl) {
      throw new Error('当前页面与这条提问的来源不同，请回到原页面重试，或针对当前页面重新提问。');
    }
    if (state.disablePageContext) throw new Error('页面读取已关闭，请开启页面开关后再重试。');
    return target;
  }

  async function refreshPageForRetry(conversation, question, assistant, signal, preparedTarget, owner, history) {
    if (deps.refreshRetry) return deps.refreshRetry(conversation, question, assistant, signal, preparedTarget);
    const target = preparedTarget === undefined ? await validateRetryPageTarget(question, signal) : preparedTarget;
    signal?.throwIfAborted();
    if (!target) return;
    if (state.disablePageContext) throw new Error('页面读取已关闭，请开启页面开关后再重试。');
    const originalUrl = normalizePageUrl(question.pageSource?.url);
    setAssistantPhase(assistant, 'reading');
    const content = question.displayContent || question.content || '';
    const repository = Boolean(parseRepositoryUrl(target.url) && /源码|代码仓库|仓库结构|source code|repository/i.test(content));
    const readingPolicy = readingPolicyForRetry(question);
    let page = await preparePageReading(content, {
      target, readingPolicy: repository ? { ...readingPolicy, scope: 'page' } : readingPolicy, signal,
      readPage: ({ target: readTarget, signal: readSignal, timeoutMs }) => readCurrentPageForRequest(content, {
        target: readTarget, repository, signal: readSignal, timeoutMs,
      }),
      sendMessage: message => browser.sendMessage(message),
      onPhase: phase => { if (!signal?.aborted) setAssistantPhase(assistant, phase); },
    });
    signal?.throwIfAborted();
    if (!page || normalizePageUrl(page.url) !== originalUrl) throw new Error('未能重新读取原页面正文，本轮未使用旧内容，请稍后重试。');
    if (deps.enhancePageReading && !repository && owner) {
      const supplementalTarget = { ...target, documentId: page.documentId || target.documentId };
      page = await waitWithTimeout(deps.enhancePageReading(content, {
        page, target: supplementalTarget,
        cacheScope: { conversationId: conversation.id },
        ...normalizeReadingOptions(question.readingOptions), history: history || [], modelRun: modelFor(owner), signal,
        onPhase: phase => {
          owner.assertCurrent();
          if (state.conversation !== conversation) throw new DOMException('本次重试已取消', 'AbortError');
          setAssistantPhase(assistant, phase);
        },
      }), { signal, timeoutMs: 25000, message: '补充原页面资料超时，请重试。' });
      signal?.throwIfAborted();
      owner.assertCurrent();
      if (state.conversation !== conversation) throw new DOMException('本次重试已取消', 'AbortError');
      assertPageTarget(supplementalTarget, page);
    }
    conversation.pageContext = page;
    question.pageSource = pageSourceFor(page);
    question.pageContextEnabled = true;
    question.readingPolicy = page.readingPolicy || readingPolicy;
    state.pendingPage = null;
  }

  async function regenerate(assistantId) {
    if (disposed) return;
    if (agentSlot?.isBusy()) return;
    const conversation = state.conversation;
    if (!conversation?.messages.some((message) => message.id === assistantId && message.role === 'assistant')) return;
    if (conversation.messages.find(message => message.id === assistantId)?.agent) return;
    stopActiveReply();
    state.messageQueue = [];
    const submissionOwner = runner.begin({ commandId: makeId(), mode: 'chat' });
    const submissionController = { signal: submissionOwner.signal, abort: reason => submissionOwner.cancel(reason) };
    const modelId = state.selectedModelId, effort = state.selectedEffort;
    state.submissionOwner = submissionOwner;
    state.submissionController = submissionController;
    state.isSubmitting = true;
    state.sendInFlight = true;
    renderQueueBar();
    updateComposer();
    const retryIndex = conversation.messages.findIndex(message => message.id === assistantId);
    const originalQuestion = conversation.messages.slice(0, retryIndex).findLast(message => message.role === 'user');
    const readingHistory = captureReadingHistory(conversation.messages.slice(0, Math.max(0, conversation.messages.indexOf(originalQuestion))));
    const retryTargetPromise = originalQuestion
      ? validateRetryPageTarget({ ...originalQuestion }, submissionController.signal)
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
      const configured = await waitWithTimeout(ensureConfigured(submissionController.signal), { signal: submissionController.signal, message: '读取模型配置超时，请重试。' });
      assertCurrent();
      if (!configured) return;
      profiles.set(submissionOwner.runId, structuredClone(profileFor(modelId, effort)));
      const messages = conversation.messages;
      const assistant = find(messages, (message) => message.id === assistantId);
      if (!assistant || assistant.role !== 'assistant') return;
      const replacement = { id: makeId(), role: 'assistant', content: '', status: 'streaming', requestPhase: 'preparing', createdAt: now(), model: activeChatProfile()?.id || '', modelId: activeChatProfile()?.id || '', reasoningEffort: state.selectedEffort };
      const replacementMessages = messagesForRetry(messages, assistantId, replacement);
      if (!replacementMessages) throw new Error('找不到这条回答对应的提问，无法重新生成。');
      const question = replacementMessages.findLast((message) => message.role === 'user');
      if (!question) throw new Error('找不到这条回答对应的提问，无法重新生成。');
      const target = await waitForCurrent(retryTargetPromise);
      assertCurrent();
      const ref = repository.retry({ conversation, assistantId, runId: submissionOwner.runId, assistant: replacement });
      const retained = repository.get(ref);
      next = retained.assistant;
      if (!target) retained.user.pageContextEnabled = false;
      submissionOwner.bind({ conversation, user: retained.user, assistant: next });
      renderConversation({ scroll: true });
      setAssistantPhase(next, 'preparing');
      await waitForCurrent(refreshPageForRetry(conversation, retained.user, next, submissionController.signal, target, submissionOwner, readingHistory));
      assertCurrent();
      setAssistantPhase(next, 'saving');
      await waitWithTimeout((submissionOwner.ref ? repository.save(submissionOwner.ref, { required: true }) : saveCurrent({ required: true })), { signal: submissionController.signal, message: '保存消息超时，尚未请求模型，请重试。' });
      assertCurrent();
      if (!conversation.messages.includes(next)) return;
      await waitForCurrent(generateReply(next, submissionOwner));
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


  return Object.freeze({ sendMessage, regenerate, stopActiveReply, processQueue, validateRetryPageTarget, refreshPageForRetry,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; runner.cancel(); for (const connection of connections.values()) connection.dispose(); connections.clear(); profiles.clear(); listeners.clear(); } });
}

/**
 * UNK AI side-panel entry.
 *
 * MODULE NAVIGATION
 * -----------------
 * core/dom.js
 *   DOM lookup, escaping and toast primitives.
 * core/format.js
 *   Text/time/URL formatting helpers.
 * composition/composition-root.js
 *   Wires feature slots to browser APIs. Replace implementations here.
 * features/messages/message-view.js
 *   Markdown, math, code highlighting and message markup.
 * features/models/model-switcher.js
 *   Active model resolution and model/effort dropdown rendering.
 * features/attachments/attachments-slot.js
 *   Attachment normalization, de-duplication and rendering.
 * features/page-reading/page-reader-slot.js
 *   Page extraction, deep reading, iframe aggregation and fallback.
 * features/visual-context/auto-visual-slot.js
 *   Model-guided screenshot decision and automatic visual attachment.
 * features/context/context-slot.js
 *   Context compression request, response parsing and summary metadata.
 * utils/*
 *   Framework-independent domain services (LLM, storage, page context,
 *   profiles, exporters, image cropping).
 *
 * The entry retains UI state and browser/storage adapters. Submit, queue,
 * retry and ordinary reply execution are delegated to app services.
 */

import { awaitWithAbort, awaitWithTimeout } from '../utils/abortable.js';
import { find, includes, map, trim } from 'lodash-es';
import { pageControlState, pageFaviconUrl, isReadablePageUrl, pageContextEnabledForNavigation } from './features/page-reading/page-control-state.js';
import { captureViewPosition, restoreViewPosition } from './features/messages/scroll-position.js';
import {
  getProviderConfig,
} from '../utils/storage.js';
import {
  createTemporaryConversation,
  initializeConversationSync,
  retryPendingConversationWrites,
  trashSavedConversations,
  restoreTrashedConversations,
  getLatestConversationDeletion,
  listSavedConversations,
  loadConversation,
  loadTemporaryConversation,
  migrateLegacyConversations,
  promoteTemporaryConversation,
  saveConversationByStorage,
} from '../utils/conversation-store.js';
import {
  getDirectoryInfo,
  requestDirectoryPermission,
  restoreConversationDirectory,
} from '../utils/local-directory.js';
import {
  contextUsageFor,
  contextWindowFor,
  formatTokenCount,
} from '../utils/context.js';
import { normalizeProviderConfig, requestProfile } from '../utils/profiles.js';
import { exportConversationMarkdown } from '../utils/exporter.js';
import { createMessageCopy } from './features/messages/message-copy.js';
import { createExportController } from './features/export/export-controller.js';
import { createConversationExportMenu } from './features/export/export-menu.js';
import { createExportDownloader } from './features/export/download-export.js';
import { recordDiagnostic, collectDiagnosticLogs, flushDiagnostics } from '../utils/diagnostic-log.js';
import { diagnosticFailure, safeDiagnostic, observeModelDiagnostic, observeConversationSaveDiagnostic, installRuntimeDiagnostics } from '../utils/diagnostic-observer.js';
import { createDiagnosticExporter } from './features/diagnostics/diagnostic-export.js';
import './features/messages/message-copy.css';
import './features/export/export-dialog.css';
import {
  prepareAttachment,
  prepareImageDataUrl,
  safeAttachmentDataUrl,
} from '../utils/attachments.js';
import { readPdfFromUrl } from '../utils/pdf-reader.js';
import { findOpenTabForSource, pageTargetFields } from '../utils/page-target.js';
import { normalizePageUrl, resolvePageSource } from './features/page-reading/page-source.js';
import { createReadingControls } from './features/page-reading/reading-controls.js';
import { createNetworkReadingClient } from './features/page-reading/network-reading-client.js';
import { createSupplementalReader } from './features/page-reading/supplemental-reading.js';
import { getNetworkReadingGrant, setNetworkReadingGrant } from '../utils/network-reading.js';
import { parseRepositoryUrl, readRepository as repositoryReader } from '../utils/repository-reader.js';
import {
  normalizePageSelection,
  shouldReleaseSelection,
} from '../utils/selection.js';
import {
  welcomePromptsFor,
} from './features/welcome/welcome-prompts.js';
import { normalizeDraftSource } from './features/welcome/draft-source.js';
import { createAgentTurnCallbacks } from './features/agent/agent-turn-callbacks.js';
import { createConversationSaver } from './features/storage/conversation-save.js';
import { createConversationOrganizationStore } from '../utils/conversation-organization.js';
import { createHistorySidebar } from './features/history/history-sidebar.js';
import { createHistoryNavigation } from './features/history/history-navigation.js';
import { createHistoryLayout } from './features/history/history-layout.js';
import './features/history/history-sidebar.css';
import { cropImageDataUrl, stitchCapturedPage } from '../utils/image-crop.js';
import { stitchPlanForCaptures } from '../utils/page-capture.js';
import {
  findFigureForPick,
  normalizePageContext,
  normalizeVisualCapture,
  pageContextStats,
} from '../utils/reading-context.js';
import { icon, hydrateIcons } from './icons.js';
import { formatDate, formatTime, truncateText } from './core/format.js';
import {
  liveReplyState,
  settleInterruptedReply,
} from './features/messages/reply-state.js';
import { normalizeDuplicateRetryTurns, samePrompt } from './features/messages/retry-flow.js';
import {
  storageBadgeState,
  storageSetupState,
} from './features/storage/storage-state.js';
import { showSuggestionsFor } from './features/messages/suggestion-visibility.js';
import {
  messageMarkup,
  renderMessageContent,
  updateStreamingMessage as updateMessageView,
} from './features/messages/message-view.js';
import { createTurnNavigator } from './features/messages/turn-navigator.js';
import { createImagePreview } from './features/messages/image-preview.js';
import { createTextPreview } from './features/messages/text-preview.js';
import { createPastedTextDraft } from './features/messages/pasted-text-draft.js';
import { createSourceIconFallback } from './features/messages/source-icons.js';
import { createArticleSelectionMenu } from './features/messages/article-selection-menu.js';
import { createArticleQuoteView } from './features/messages/article-quote-view.js';
import { appendArticleQuote, articleQuotes, removeArticleQuote, updateArticleQuote } from './features/messages/article-quote-draft.js';
import './features/messages/selection-chat.css';
import { createSelectionChatRuntime } from './features/messages/selection-chat-runtime.js';
import { createSelectionChatView } from './features/messages/selection-chat-view.js';
import { createSelectionChatSessions } from './features/messages/selection-chat-sessions.js';
import { createMessageRewind } from './features/messages/message-rewind.js';
import { createAgentTaskRestart, agentRestartControl } from './features/agent/agent-task-restart.js';
import {
  activeModel,
  renderModelSwitcher as renderModelSwitcherView,
  selectedEffortFor,
  toggleModelDropdown,
  selectModelOption,
} from './features/models/model-switcher.js';
import {
  ATTACHMENT_LIMIT,
  mergeAttachments,
  renderAttachmentList,
} from './features/attachments/attachments-slot.js';
import {
  notifyPageReadFailure,
  showPageReadFailure,
  showPageReading,
  showPdfReading,
} from './features/page-reading/page-reader-slot.js';
import { createSidepanelComposition } from './composition/composition-root.js';
import { createSidepanelApplication } from './composition/application-root.js';
import { createModelGateway } from '../app/model-gateway.js';
import { capturePageTarget } from './features/page-reading/page-target-capture.js';
import { createPageReadState } from './features/page-reading/page-read-state.js';
import { createPageQuestionChoice, needsPageQuestionChoice } from './features/page-reading/page-question-choice.js';
import { attachmentInputError, createVisualPreparation } from './features/visual-context/manual-visual-capture.js';

const $ = (selector) => document.querySelector(selector);
const input = $('#message-input');
const messagesElement = $('#messages');
const conversationView = $('#conversation-view');
const sendButton = $('#send-message');
const stopButton = $('#stop-generation');
const historyDrawer = $('#history-drawer');
const conversationStage = $('#conversation-stage');
const turnNavigatorElement = $('#turn-navigator');
const turnPreview = $('#turn-preview');
let historySidebar = null;
let historyMutationBusy = false;
let historySidebarBusy = false;
let historyNavigationBusy = false;
let historyRefreshVersion = 0;
let historyOrganization = null;
let deletedActiveConversationId = null;
let selectionChatSessions = null;
const conversationOrganization = createConversationOrganizationStore();

const state = {
  conversation: null,
  conversations: [],
  config: null,
  selectedModelId: '',
  selectedEffort: 'default',
  controller: null,
  generatingId: null,
  activeAssistantId: null,
  saveQueue: Promise.resolve(),
  pendingPage: null,
  followToPage: true,
  saveTimer: null,
  draft: '',
  draftSource: null,
  attachments: [],
  preparingAttachments: false,
  autoVisualRunning: false,
  storageInfo: null,
  compressing: false,
  contextClosed: true,
  contextUsage: null,
  pageSelection: null,
  activePageSignal: null,
  directModelRequest: '',
  lastSentFingerprint: '',
  lastSentAt: 0,
  selectionPoll: null,
  ready: false,
  messageQueue: [],
  isSubmitting: false,
  sendInFlight: false,
  submissionOwner: null,
  directReplaceReply: false,
  historySearchQuery: '',
  pageContextPreference: true,
  disablePageContext: true,
  readingMode: 'auto',
  networkReadingGrant: null,
  draftPageTarget: null,
  readingPage: false,
  submissionController: null,
  compressionController: null,
  progressTimer: null,
};

const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();
const plainText = (value) => String(value ?? '');
const visualPreparation = createVisualPreparation({
  getOwner: () => [state.conversation, state.submissionOwner, state.generatingId, agentSlot?.getTask()?.id,
    state.activePageSignal?.tabId, state.activePageSignal?.url],
  onBusy: (busy) => { state.preparingAttachments = busy; renderAttachments(); updateComposer(); },
});

const pageReadState = createPageReadState({ onChange: activity => {
  state.readingPage = activity?.status === 'reading';
  updatePageToolbar();
} });

const pageQuestionChoice = createPageQuestionChoice({
  snapshot: () => ({ conversation: state.conversation, draft: pastedText.getValue(),
    tabId: state.activePageSignal?.tabId, url: state.activePageSignal?.url, title: state.activePageSignal?.title,
    mode: `${Boolean(agentSlot?.isMode())}:${state.disablePageContext}`,
    source: normalizeDraftSource(state.draftSource)?.topicId || '',
    selection: JSON.stringify(state.pageSelection || null), attachments: [...state.attachments] }),
  render: value => {
    const panel = $('#composer-page-choice');
    if (!panel) return;
    panel.hidden = !value;
    if (value) $('#composer-page-choice-text').textContent = `这次需要结合“${value.title || '当前页'}”吗？`;
  },
  enablePage: () => setPageMode(true),
  submit: (text, { replaceActiveReply, ...options }) => {
    state.directReplaceReply = replaceActiveReply === true;
    return application.conversations.sendMessage(text, options);
  },
});

function setPageMode(enabled) {
  state.pageContextPreference = enabled;
  state.disablePageContext = !enabled || !state.activePageSignal;
  if (!enabled && agentTaskRestart.isPending()) agentTaskRestart.cancel();
  if (enabled) state.draftSource = null;
  if (state.disablePageContext && (agentSlot?.isMode() || agentSlot?.isBusy())) {
    // stop revokes the current owner synchronously; cleanup keeps its captured task.
    void agentSlot.stop('已关闭“基于当前页”，页面操作已停止。').catch(() => toast('页面操作停止失败，请检查任务状态。', 'error'));
    agentSlot.setMode(false);
  }
  if (state.disablePageContext && state.isSubmitting) stopActiveReply();
  updateComposer();
  renderQueueBar();
  if (!state.disablePageContext) void processQueue();
}

function renderQueueBar() {
  const queueBar = $('#queue-bar');
  const queuePreview = $('#queue-preview');
  if (!queueBar || !queuePreview) return;
  const count = state.messageQueue?.length || 0;
  if (count === 0) {
    queueBar.hidden = true;
    queuePreview.textContent = '';
  } else {
    queueBar.hidden = false;
    const item = state.messageQueue[0];
    const preview = item.content || (item.attachments?.length ? `[${item.attachments.length}个附件]` : '新消息');
    const badge = count > 1 ? ` (+${count - 1})` : '';
    const waitingForConversation = Object.hasOwn(item, 'conversationId') && item.conversationId !== state.conversation?.id;
    const waitingForPage = item.pageContextEnabled && state.disablePageContext;
    const waiting = waitingForConversation
      ? (item.conversationId ? '等待返回原会话 · ' : '等待会话准备，可撤回编辑 · ')
      : waitingForPage ? '等待开启页面读取 · ' : '';
    const sourceHint = normalizeDraftSource(item.requestSource) ? '独立话题 · ' : '';
    queuePreview.textContent = `${waiting}${sourceHint}${truncateText(preview, 26)}${badge}`;
  }
}

function recallQueueItem() {
  if (!state.messageQueue || state.messageQueue.length === 0) return;
  const item = state.messageQueue.pop();
  if (!item) return;
  pastedText.setValue(item.content || '');
  state.draft = pastedText.getValue();
  state.draftSource = normalizeDraftSource(item.requestSource);
  state.attachments = item.attachments || [];
  renderAttachments();
  setPageSelection(item.selection || null);
  resizeInput();
  updateComposer();
  renderQueueBar();
  input.focus();
  toast('已撤回排队消息到输入框');
}

async function processQueue() { return application.conversations.processQueue(); }
let selectionClearing = false;
const turnNavigator = createTurnNavigator({
  stage: conversationStage,
  view: conversationView,
  messages: messagesElement,
  rail: turnNavigatorElement,
  preview: turnPreview,
  getConversation: () => state.conversation,
  openSource: url => openSourcePage({ url }),
  onNavigate: () => { state.followToPage = false; },
});

const messageCopy = createMessageCopy({ writeText: text => navigator.clipboard.writeText(text), notify: toast });
const agentTaskRestart = createAgentTaskRestart({
  getConversation: () => state.conversation,
  getBlockReason: () => {
    if (historyMutationBusy) return '正在整理历史对话，请稍后重新开始任务。';
    if (!state.ready || state.preparingAttachments) return '正在准备附件或会话，请稍后重新开始任务。';
    if (state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy()) return '任务仍在运行，请先停止再重新开始。';
    if (!state.pageContextPreference || normalizeDraftSource(state.draftSource)) return '请先开启“基于当前页”，再重新开始页面操作。';
    return '';
  },
  queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab),
  getTab: id => chrome.tabs.get(id),
  activateTab: id => chrome.tabs.update(id, { active: true }),
  captureTarget: signal => capturePageTarget({
    queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab),
    sendMessage: message => chrome.runtime.sendMessage(message), signal,
  }),
  onTarget: tab => { syncActivePageSignal(tab); updateComposer(); },
  setMode: enabled => agentSlot.setMode(enabled),
  // Only this validated restart enters the existing service while its local
  // preparation guard blocks user sends and retries.
  submit: (goal, options) => application.conversations.sendMessage(goal, options),
  notify: toast, onPending: pending => { if (pending) pageQuestionChoice.clear(); updateComposer(); },
});
const messageRewind = createMessageRewind({
  getConversation: () => state.conversation,
  getBlockReason: () => {
    if (historyMutationBusy) return '正在整理历史对话，请稍后编辑。';
    if (!state.ready || state.preparingAttachments) return '正在准备附件或会话，请稍后回退。';
    if (state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy() || agentTaskRestart.isPending()) return '任务仍在运行，请先停止再回退。';
    return '';
  },
  applyDraft: draft => {
    pageQuestionChoice.clear();
    pastedText.setValue(draft.text);
    state.draft = draft.text;
    state.draftSource = draft.requestSource;
    state.attachments = draft.attachments;
    state.lastSentFingerprint = '';
    state.lastSentAt = 0;
    renderAttachments();
    setPageSelection(draft.selection);
    resizeInput();
    input.focus();
    updateComposer();
  },
  saveConversation: conversation => saveCurrent({ required: true, conversation }),
  onChanged: () => renderConversation(),
});
const conversationExport = createExportController({ notify: toast,
  download: createExportDownloader({ download: options => chrome.downloads.download(options) }) });
const imagePreview = createImagePreview({ document, onError: toast, fallbackFocus: () => input });
const textPreview = createTextPreview({ document, onError: toast, fallbackFocus: () => input });
// Like the existing textarea, this is the current sidebar draft until explicitly
// submitted or replaced. Its hidden spans are always included in state.draft.
const pastedText = createPastedTextDraft({ input, container: $('#pasted-text-list'),
  canEdit: () => !input.readOnly && !input.disabled,
  notify: message => toast(message, 'error'),
  onPreview: value => textPreview.open(value),
  onChange: value => {
    if (!String(state.draft || '').trim() && value.trim()) state.draftPageTarget = state.activePageSignal ? { ...state.activePageSignal } : null;
    state.draft = value;
    if (!value.trim()) state.draftSource = null;
    resizeInput();
    updateComposer();
  },
});
const sourceIcons = createSourceIconFallback({ root: document });
let diagnosticExportBusy = false;
let diagnosticFeedbackOwner = null;
const diagnosticExporter = createDiagnosticExporter({ collect: collectDiagnosticLogs,
  download: createExportDownloader({ download: options => chrome.downloads.download(options) }),
  notify: (text, kind) => {
    const owner = diagnosticFeedbackOwner;
    const feedback = owner?.messageId && owner.conversationId === state.conversation?.id
      ? messagesElement.querySelector(`[data-message-id="${CSS.escape(owner.messageId)}"] .message-diagnostic-feedback`) : null;
    if (feedback) feedback.textContent = text;
    else toast(text, kind);
  },
});
async function exportConversationDiagnostics(conversationId, messageId = null) {
  if (diagnosticExportBusy || !conversationId) return;
  diagnosticExportBusy = true;
  diagnosticFeedbackOwner = { conversationId, messageId };
  try { await diagnosticExporter.exportToday({ conversationId }); }
  finally { diagnosticExportBusy = false; }
}
const markdownDownloader = createExportDownloader({ download: options => chrome.downloads.download(options) });
const conversationExportMenu = createConversationExportMenu({
  button: $('#export-selected'), menu: $('#conversation-export-menu'),
  getState: () => ({ conversationId: state.conversation?.id, diagnosticBusy: diagnosticExportBusy,
    markdownBlocked: Boolean(state.generatingId || agentSlot?.isBusy() || state.isSubmitting
      || state.compressing || agentTaskRestart.isPending()),
    hasTurns: state.conversation?.messages.some(message => message.role === 'user') }),
  beforeOpen: () => messageCopy.close(), notify: toast,
  onSelect: (kind, conversationId, trigger, operation) => kind === 'markdown'
    ? exportChat(conversationId, operation)
    : kind === 'diagnostics'
    ? exportConversationDiagnostics(conversationId)
    : conversationExport.open(state.conversation, trigger),
});
const removeRuntimeDiagnostics = installRuntimeDiagnostics(window, recordDiagnostic);
void flushDiagnostics();

hydrateIcons();

function escapeHtml(value) {
  return plainText(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return includes(['http:', 'https:'], url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function hasVision() {
  return Boolean(activeChatProfile()?.supportsVision);
}

function toast(message, kind = '') {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), kind === 'error' ? 5500 : 3200);
}


async function initTheme(signal) {
  if (!globalThis.chrome?.storage?.local) return;
  try {
    const { theme = 'light' } = await awaitWithTimeout(chrome.storage.local.get('theme'), { signal, timeoutMs: 2000 });
    applyTheme(theme);
  } catch (error) {
    if (signal?.aborted) throw error;
    applyTheme('light');
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggleBtn = $('#theme-toggle');
  if (toggleBtn) {
    const isDark = theme === 'dark';
    toggleBtn.setAttribute('aria-label', isDark ? '切换为亮色模式' : '切换为暗色模式');
    toggleBtn.setAttribute('title', isDark ? '切换为亮色模式' : '切换为暗色模式');
    toggleBtn.innerHTML = `<i data-icon="${isDark ? 'sun' : 'moon'}"></i>`;
    hydrateIcons(toggleBtn);
  }
}

async function toggleTheme() {
  const currentTheme = document.documentElement.dataset.theme || 'light';
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  if (globalThis.chrome?.storage?.local) {
    await chrome.storage.local.set({ theme: nextTheme });
  }
  applyTheme(nextTheme);
}

function activeChatProfile() {
  return activeModel(state.config, state.selectedModelId);
}

function renderModelSwitcher() {
  return renderModelSwitcherView({
    config: state.config,
    selectedModelId: state.selectedModelId,
    selectedEffort: state.selectedEffort,
    generating: Boolean(state.generatingId) || Boolean(agentSlot?.isBusy()),
    onClose: () => toggleModelDropdown(false),
  });
}

function renderContextChip() {
  const chip = $('#context-chip');
  if (chip) chip.hidden = true;
}

function renderPageSelection() {
  const chip = $('#selection-chip');
  const selection = state.pageSelection;
  if (selection?.source === 'conversation' && !state.articleQuoteDraftOwnerId) state.articleQuoteDraftOwnerId = state.conversation?.id || '';
  if (selection?.source !== 'conversation') state.articleQuoteDraftOwnerId = null;
  if (typeof articleQuoteView !== 'undefined') articleQuoteView.sync();
  chip.hidden = !selection?.text || selection.source === 'conversation';
  if (!selection?.text) return;
  const preview = trim(selection.text.replace(/\s+/g, ' '));
  const visualLabel = selection.visuals?.length ? ` · 含 ${selection.visualCount || selection.visuals.length} 张图片` : '';
  $('#selection-chip-title').textContent = `${selection.source === 'conversation' ? '已引用回答' : '已选择 1 项'}${visualLabel} · ${preview.slice(0, 34)}${preview.length > 34 ? '…' : ''}`;
  $('#selection-chip-preview').textContent = selection.title
    ? `来自：${selection.title}`
    : selection.url || (selection.source === 'conversation' ? '对话回答' : '当前网页');
  chip.title = preview;
}

let welcomeViewKey = '';
function renderWelcomePrompts() {
  const container = $('#welcome-chips');
  if (!container) return;
  const welcome = welcomePromptsFor(state.activePageSignal || {});
  const { primary, secondary, topics } = welcome;
  // Metadata polling must not replace focused cards. Date-sensitive prompts are
  // rebuilt when clicked so a panel left open overnight still uses today's date.
  const viewKey = JSON.stringify({ ...welcome, topics: topics.map(({ prompt, ...topic }) => topic) });
  if (viewKey === welcomeViewKey) return;
  welcomeViewKey = viewKey;
  $('#welcome-title').textContent = welcome.title;
  const subtitle = $('#welcome-title')?.nextElementSibling;
  if (subtitle?.tagName === 'P') subtitle.textContent = welcome.subtitle;
  container.innerHTML = `
    <div class="welcome-start">
      <button id="${primary.action === 'summarize-page' ? 'summarize-page' : 'welcome-primary'}"
        class="welcome-chip welcome-primary" type="button"
        data-action="${escapeHtml(primary.action)}">
        <span class="welcome-action-icon">${icon(primary.icon)}</span>
        <span class="welcome-action-copy"><strong>${escapeHtml(primary.label)}</strong><small>${escapeHtml(primary.description)}</small></span>
        <span class="welcome-action-arrow">${icon('arrow-right')}</span>
      </button>
      ${secondary ? `<button class="welcome-chip welcome-secondary" type="button"
        data-action="fill-prompt" data-prompt="${escapeHtml(secondary.prompt)}"
        title="${escapeHtml(secondary.description)}"><span>${escapeHtml(secondary.label)}</span>${icon('arrow-right')}</button>` : ''}
    </div>
    <div class="welcome-topics" aria-labelledby="welcome-topics-title">
      <div class="welcome-section-heading"><h2 id="welcome-topics-title">从这些话题开始</h2><span>点选后可编辑</span></div>
      <div class="welcome-topic-grid">
        ${topics.map(topic => `<button class="welcome-chip welcome-topic" type="button"
          data-topic="${escapeHtml(topic.id)}" data-topic-id="${escapeHtml(topic.id)}" data-action="fill-prompt">
          <span class="welcome-topic-icon">${icon(topic.icon)}</span>
          <strong>${escapeHtml(topic.label)}</strong><small>${escapeHtml(topic.description)}</small>
        </button>`).join('')}
      </div>
    </div>`;
}

function setPageSelection(value) {
  if (selectionClearing && value) return;
  // A late webpage-selection poll cannot replace an explicitly quoted answer.
  if (state.pageSelection?.source === 'conversation' && value?.source !== 'conversation') return;
  const next = normalizePageSelection(value);
  if (JSON.stringify(next) === JSON.stringify(state.pageSelection)) return;
  state.pageSelection = next;
  state.articleQuoteDraftOwnerId = next?.source === 'conversation' ? state.conversation?.id || '' : null;
  renderPageSelection();
  updateComposer();
}

function clearPageSelection() {
  const wasArticle = state.pageSelection?.source === 'conversation';
  selectionClearing = true;
  state.pageSelection = null;
  renderPageSelection();
  updateComposer();
  if (wasArticle) { selectionClearing = false; return; }
  try {
    chrome.runtime.sendMessage({ type: 'CLEAR_PAGE_SELECTION' }).catch(() => {});
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_PAGE_SELECTION' }).catch(() => {});
    });
  } finally {
    setTimeout(() => { selectionClearing = false; }, 700);
  }
}

function renderAttachments() {
  renderAttachmentList(state.attachments);
  $('#attach-button').disabled = state.preparingAttachments;
}

function toggleAttachMenu(open = !$('#attach-menu').hidden) {
  const menu = $('#attach-menu');
  menu.hidden = !open;
  $('#attach-button').setAttribute('aria-expanded', String(open));
}

async function addAttachments(files, kind) {
  const selected = Array.from(files || []);
  if (!selected.length || state.generatingId || state.isSubmitting || agentSlot?.isBusy()) return;
  const error = attachmentInputError(kind, { agentMode: agentSlot?.isMode(), supportsVision: hasVision() });
  if (error) { toast(error, 'error'); return; }
  const operation = visualPreparation.start();
  toggleAttachMenu(false);
  let added = 0;
  try {
    for (const file of selected) {
      try {
        const prepared = await operation.wait(prepareAttachment(file, kind));
        const currentError = attachmentInputError(kind, { agentMode: agentSlot?.isMode(), supportsVision: hasVision() });
        if (currentError) throw new Error(currentError);
        const limit = agentSlot?.isMode() ? 3 : ATTACHMENT_LIMIT;
        if (state.attachments.length >= limit) { toast(`每条消息最多添加 ${limit} 个附件。`); break; }
        const next = mergeAttachments(state.attachments, [prepared]);
        if (next.length === state.attachments.length) { toast(`“${prepared.name}”已经添加。`); continue; }
        operation.check();
        state.attachments.push(prepared);
        added += 1;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        toast(error.message || `无法读取 ${file.name}。`, 'error');
      }
    }
    if (added) input.focus();
  } catch (error) { if (error.name !== 'AbortError') toast(error.message, 'error'); }
  finally { operation.finish(); }
}

async function captureVisiblePage() {
  if (!hasVision()) {
    toggleAttachMenu(false);
    return;
  }
  if (state.generatingId || state.preparingAttachments) return;
  toggleAttachMenu(false);
  await captureVisualContext({ scope: 'viewport' });
}

async function captureVisualContext({
  scope = 'viewport',
  silent = false,
  returnCaptures = false,
  commit = true,
} = {}) {
  if (!hasVision()) {
    if (!silent) toast('当前模型未标记视觉能力。请切换到视觉模型后读取页面画面。', 'error');
    return returnCaptures ? [] : undefined;
  }
  if (state.generatingId || state.preparingAttachments) return returnCaptures ? [] : undefined;
  if (state.attachments.length >= 6) {
    if (!silent) toast('每条消息最多添加 6 个附件。');
    return returnCaptures ? [] : undefined;
  }
  state.preparingAttachments = true;
  renderAttachments();
  updatePageToolbar();
  state.preparingAttachments = !silent;
  let fallbackReason = '';
  let preparedCaptures = [];
  try {
    const page = normalizePageContext(state.pendingPage || state.conversation?.pageContext);
    let captures = [];
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CAPTURE_PAGE_VISUAL_CONTEXT',
        scope,
        maxImages: scope === 'page' ? 2 : 1,
        maxEdge: 1600,
      });
      if (response?.error) throw new Error(response.error);
      if (response?.chunks?.length || response?.captureChunks?.length) {
        const captureData = response.captureChunks?.length ? response.captureChunks : response.chunks;
        const dataUrls = captureData
          .map((chunk) => safeAttachmentDataUrl(String(chunk?.dataUrl || '')))
          .filter(Boolean);
        const plan = stitchPlanForCaptures(response.plan, response.chunks || captureData);
        if (plan && dataUrls.length) {
          const dataUrl = await stitchCapturedPage(plan, dataUrls, {
            maxBytes: 2 * 1024 * 1024,
            quality: 0.8,
          });
          captures = normalizeVisualCapture({ dataUrl, scope: 'page', fullPage: true }, {
            pageTitle: response.title || page?.title,
            pageUrl: response.url || page?.url,
            scope: 'page',
            fullPage: true,
          });
          if (response.plan?.truncated || response.truncated) {
            fallbackReason = '页面较长，视觉上下文已截断';
          }
        }
      } else {
        captures = normalizeVisualCapture(response, {
          pageTitle: page?.title,
          pageUrl: page?.url,
          scope,
          fullPage: scope === 'page',
        });
      }
    } catch (error) {
      fallbackReason = error?.message || '视觉截图接口失败';
    }
    if (!captures.length && scope === 'page') {
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'CAPTURE_FULL_PAGE',
          options: { maxBytes: 2 * 1024 * 1024, maxWidth: 1600, maxHeight: 12000, maxChunks: 12 },
        });
        if (result?.error) throw new Error(result.error);
        const captureData = result?.captureChunks?.length ? result.captureChunks : (result?.chunks || []);
        const chunks = captureData.slice(0, 12)
          .map((chunk) => safeAttachmentDataUrl(String(chunk?.dataUrl || '')))
          .filter(Boolean);
        const plan = stitchPlanForCaptures(result?.plan, result?.chunks || captureData);
        if (plan && chunks.length) {
          const stitchPlan = {
            ...plan,
            chunks: plan.chunks.slice(0, chunks.length),
          };
          const dataUrl = await stitchCapturedPage(stitchPlan, chunks, {
            maxBytes: 2 * 1024 * 1024,
            quality: 0.8,
          });
          captures = normalizeVisualCapture({ dataUrl, scope: 'page' }, {
            pageTitle: result.title || page?.title,
            pageUrl: result.url || page?.url,
            scope: 'page',
            fullPage: true,
          });
        }
      } catch (error) {
        fallbackReason = error.message || '全页截图失败';
      }
    }
    if (!captures.length) {
      const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_ACTIVE_TAB' });
      if (response?.error) throw new Error(response.error);
      const dataUrl = safeAttachmentDataUrl(String(response?.dataUrl || ''));
      if (!dataUrl) throw new Error('截图格式不受支持。');
      captures = [{
        dataUrl,
        pageTitle: page?.title || '',
        pageUrl: page?.url || '',
        scope: 'viewport',
        fullPage: false,
      }];
      fallbackReason ||= '当前仅能截取可见画面';
    }
    const available = Math.max(0, 6 - state.attachments.length);
    const addedAttachments = [];
    for (const capture of captures.slice(0, available)) {
      const prepared = prepareImageDataUrl(capture.dataUrl, {
        name: `${capture.scope === 'figure' ? '图表' : '页面'}视觉-${formatTime(now()).replace(':', '')}.jpg`,
        pageTitle: capture.pageTitle || page?.title || '',
        pageUrl: capture.pageUrl || page?.url || '',
        source: 'page-visual-context',
      });
      const added = {
        ...prepared,
        figureId: capture.figureId || '',
        caption: capture.caption || '',
        section: capture.section || [],
        nearby: capture.nearby || '',
        scope: capture.scope || scope,
        fullPage: Boolean(capture.fullPage),
      };
      addedAttachments.push(added);
    }
    preparedCaptures = addedAttachments;
    if (commit) state.attachments.push(...addedAttachments);
    renderAttachments();
    updateComposer();
    input.focus();
    const added = Math.min(available, captures.length);
  if (!silent && commit) {
      toast(added
        ? `已添加 ${added} 张页面画面${fallbackReason ? `（${fallbackReason}）` : '，将随下一条提问发送'}。`
        : '没有可添加的页面画面。');
    }
    return returnCaptures ? preparedCaptures : undefined;
  } catch (error) {
    if (!silent) toast(error.message || '页面视觉读取失败，文字阅读不受影响。', 'error');
    return returnCaptures ? [] : undefined;
  } finally {
    state.preparingAttachments = false;
    renderAttachments();
    updateComposer();
    updatePageToolbar();
  }
}

/**
 * Ask the selected model whether this turn needs visual evidence. The local
 * preflight keeps ordinary text-only questions from paying for an extra call.
 * Any routing or capture error degrades silently to the existing text path.
 */
async function autoVisualAttachments(question, page, signal = null, modelRun = null) {
  signal?.throwIfAborted();
  if (state.autoVisualRunning) return [];
  state.autoVisualRunning = true;
  try {
    return await awaitWithAbort(autoVisualSlot.resolve(question, page, { signal, modelRun }), signal);
  } catch {
    signal?.throwIfAborted();
    return [];
  } finally {
    state.autoVisualRunning = false;
  }
}

async function captureSelectedFigure() {
  if (!hasVision()) {
    toggleAttachMenu(false);
    toast('当前模型不支持视觉，无法截取图表。请先切换到标记了“视觉”的模型。', 'error');
    return;
  }
  if (state.generatingId || state.preparingAttachments) return;
  toggleAttachMenu(false);
  try {
    const started = await chrome.runtime.sendMessage({ type: 'START_FIGURE_PICKER' });
    if (started?.error) throw new Error(started.error);
    toast('在网页中点击一张图表或图片即可截取，按 Esc 取消。');
  } catch (error) {
    toast(error.message || '无法开始选择图表。', 'error');
  }
}

async function captureFigurePick(pick) {
  if (!pick?.rect || state.generatingId || state.preparingAttachments) return;
  if (!hasVision()) {
    toast('当前模型不支持视觉，已取消图表截图。', 'error');
    return;
  }
  state.preparingAttachments = true;
  renderAttachments();
  try {
    const shot = await chrome.runtime.sendMessage({ type: 'CAPTURE_ACTIVE_TAB', tabId: pick.tabId, expectedUrl: pick.url, documentId: pick.documentId });
    if (shot?.error) throw new Error(shot.error);
    const dataUrl = await cropImageDataUrl(shot.dataUrl, pick.rect, { viewport: pick.viewport });
    const page = normalizePageContext(state.pendingPage || state.conversation?.pageContext);
    const matched = findFigureForPick(page, pick);
    const prepared = prepareImageDataUrl(dataUrl, {
      name: `图表截图-${formatTime(now()).replace(':', '')}.jpg`,
      pageTitle: pick.title || '',
      pageUrl: pick.url || '',
    });
    if (state.attachments.length >= 6) throw new Error('每条消息最多添加 6 个附件。');
    state.attachments.push({
      ...prepared,
      label: pick.label || '',
      figureId: matched?.id || pick.figureId || '',
      caption: matched?.caption || pick.caption || pick.label || '',
      section: matched?.section || [],
      nearby: matched?.nearby || '',
      scope: 'figure',
    });
    renderAttachments();
    updateComposer();
    input.focus();
    toast(`已截取：${pick.label || '图表'}`);
  } catch (error) {
    toast(error.message || '图表截图失败。', 'error');
  } finally {
    state.preparingAttachments = false;
    renderAttachments();
    updateComposer();
  }
}

function activeContextWindow() {
  return contextWindowFor(activeChatProfile(), state.config);
}

function currentContextUsage({ beforeAssistantId } = {}) {
  if (!state.conversation) {
    return contextUsageFor({ messages: [] }, beforeAssistantId, state.pendingPage, activeContextWindow());
  }
  return contextUsageFor(
    state.conversation,
    beforeAssistantId,
    state.pendingPage || state.conversation.pageContext,
    activeContextWindow(),
  );
}

function renderStorageBadge() {
  const badge = $('#storage-badge');
  const temporary = state.conversation?.storage !== 'local';
  const badgeState = storageBadgeState(state.storageInfo, {
    temporary,
    conversationName: state.conversation?.messages?.length ? 'conversation' : '',
    syncStatus: state.conversation?.syncStatus,
    syncError: state.conversation?.syncError,
    directoryName: state.conversation?.syncDirectoryName,
  });
  badge.classList.toggle('local', !temporary);
  badge.innerHTML = `${icon(badgeState.icon)}<span>${escapeHtml(badgeState.label)}</span>`;
  badge.title = badgeState.title;
  $('#save-conversation').hidden = !badgeState.saveVisible;
}

function setContextPanel(open) {
  state.contextClosed = !open;
  const popover = $('#context-popover');
  popover.hidden = !open;
  $('#context-meter-button').setAttribute('aria-expanded', String(open));
  if (open) renderContextUsage();
}

function renderContextUsage(options) {
  const usage = currentContextUsage(options);
  state.contextUsage = usage;
  const button = $('#context-meter-button');
  const percent = Math.min(100, usage.percent);
  const exceedsCapacity = usage.used > usage.total;
  const activeModel = activeChatProfile();
  button.classList.toggle('warning', usage.percent >= 75 && usage.percent < 90);
  button.classList.toggle('danger', usage.percent >= 90);
  const capacityLabel = exceedsCapacity ? `资料估算为容量的 ${usage.percent}%，发送前将按预算裁剪` : `容量已用 ${usage.percent}%`;
  const description = `会话整理 · ${capacityLabel}，点击查看详情与整理`;
  button.setAttribute('aria-label', description);
  button.title = description;
  button.dataset.tooltip = description;
  button.hidden = !activeModel;
  const progressBar = $('#context-progress-bar');
  if (progressBar) progressBar.style.width = `${percent}%`;
  const label = $('#context-meter-label');
  if (label) label.textContent = exceedsCapacity ? '待裁剪' : `${usage.percent}%`;
  const modelName = $('#context-model-name');
  if (modelName) modelName.textContent = activeModel ? activeModel.name : '';
  const usedPercent = $('#context-used-percent');
  if (usedPercent) usedPercent.textContent = exceedsCapacity ? '资料超过模型容量' : `${usage.percent}% 已用`;
  const remainingPercent = $('#context-remaining-percent');
  if (remainingPercent) remainingPercent.textContent = `（剩余 ${usage.remainingPercent}%）`;
  const tokenCount = $('#context-token-count');
  if (tokenCount) tokenCount.textContent = `${exceedsCapacity ? '裁剪前估算' : '已用'} ${formatTokenCount(usage.used)} Tokens，模型容量 ${formatTokenCount(usage.total)}`;
  const thresholdLabel = $('#context-threshold-label');
  if (thresholdLabel) thresholdLabel.textContent = exceedsCapacity ? '发送前整理历史并按来源分配正文预算，以上不是实际发送量或账单用量。' : `达到 ${formatTokenCount(usage.threshold)}（90%）自动整理较早记录`;
  const summary = state.conversation?.contextSummary;
  const summaryRow = $('#context-summary-row');
  if (summaryRow) {
    summaryRow.hidden = !summary?.text;
    if (summary?.text) {
      $('#context-summary-time').textContent = summary.compressedAt ? formatDate(summary.compressedAt) : '';
      $('#context-summary-count').textContent = summary.originalMessageCount
        ? ` · ${summary.originalMessageCount} 条较早消息`
        : '';
      $('#context-summary-preview').textContent = summary.text;
    }
  }
  const page = normalizePageContext(state.pendingPage || state.conversation?.pageContext);
  const pageStats = pageContextStats(page);
  const pageRow = $('#context-page-row');
  if (pageRow) {
    pageRow.hidden = !page;
    if (page) {
      $('#context-page-title').textContent = page.title;
      const details = [
        pageStats.chars ? `${formatTokenCount(pageStats.chars)} 字符` : '',
        pageStats.pdfPages
          ? `${pageStats.pdfPages} 页${pageStats.pdfPagesRead && pageStats.pdfPagesRead < pageStats.pdfPages ? ` · 已读取 ${pageStats.pdfPagesRead} 页` : ''}`
          : '',
        pageStats.deepReading
          ? `深度结构已读取${pageStats.axNodes ? ` · ${pageStats.axNodes} 个语义节点` : ''}${pageStats.domNodes ? ` · ${pageStats.domNodes} 个结构节点` : ''}`
          : '',
        !pageStats.pdfPages && pageStats.outline ? `${pageStats.outline} 个章节` : '',
        pageStats.tables ? `${pageStats.tables} 个表格` : '',
        pageStats.links ? `${pageStats.links} 个链接` : '',
        pageStats.forms ? `${pageStats.forms} 个表单` : '',
        pageStats.figures ? `${pageStats.figures} 个图片/图表索引` : '',
        pageStats.truncated ? '正文已截断' : '',
      ].filter(Boolean);
      $('#context-page-detail').textContent = details.length
        ? `已读取：${details.join(' · ')}。${state.pendingPage ? '用于下一次提问。' : '已关联到本会话。'}`
        : `已读取《${page.title}》。`;
    }
  }
  if (state.contextClosed) return;
  $('#context-popover').hidden = false;
}

function refreshContextUsage(options) {
  state.contextUsage = currentContextUsage(options);
  renderContextUsage(options);
  return state.contextUsage;
}

function renderLocalPrompt() {
  const storageState = storageSetupState(state.storageInfo);
  const normalized = normalizeProviderConfig(state.config);
  const missingModel = !normalized?.models?.length;
  const setup = $('#setup-required');
  setup.hidden = storageState.hidden && !missingModel;
  if (setup.hidden) return;
  setup.dataset.storageAction = storageState.hidden ? 'settings' : storageState.action;
  setup.dataset.storageKind = storageState.hidden ? 'model' : storageState.kind;
  const actionLabel = storageState.action === 'reauthorize' ? '恢复权限' : '去设置';
  setup.innerHTML = `${icon(storageState.hidden ? 'settings' : 'folder')}<span>${storageState.hidden
    ? '先在设置中添加并启用一个模型'
    : escapeHtml(storageState.title)}</span><button type="button">${actionLabel}</button>`;
}

function renderConversation({ scroll = false } = {}) {
  if (typeof articleSelectionMenu !== 'undefined') articleSelectionMenu.hide();
  if (typeof selectionChatSessions !== 'undefined') selectionChatSessions?.syncConversation(state.conversation?.id);
  if (state.pageSelection?.source === 'conversation' && state.articleQuoteDraftOwnerId
    && state.articleQuoteDraftOwnerId !== state.conversation?.id) {
    state.pageSelection = null;
    state.articleQuoteDraftOwnerId = null;
  }
  const customTitle = historyOrganization?.titles?.[state.conversation?.id];
  if (customTitle && state.conversation) state.conversation.title = customTitle;
  const conversation = state.conversation;
  messageCopy.close();
  conversationExport.sync(conversation?.id);
  conversationExportMenu.sync(conversation?.id);
  imagePreview.sync(conversation?.id);
  textPreview.sync(conversation?.id);
  const viewPosition = captureViewPosition(conversationView, messagesElement);
  const hasMessages = Boolean(conversation?.messages.length);
  $('#welcome').hidden = hasMessages;
  messagesElement.hidden = !hasMessages;
  const heading = $('#conversation-title');
  const title = hasMessages ? conversation.title || '新对话' : '';
  heading.hidden = !hasMessages;
  heading.textContent = title;
  heading.title = title;
  document.title = title ? `${title} - UNK AI` : 'UNK AI - 阅读与对话';
  const latestAssistant = [...(conversation?.messages || [])]
    .reverse()
    .find((message) => message.role === 'assistant');
  const latestMessageRole = conversation?.messages.at(-1)?.role || '';
  messagesElement.innerHTML = hasMessages
    ? conversation.messages.map((message) => messageMarkup(message, {
      showSuggestions: showSuggestionsFor(message, latestAssistant?.id, latestMessageRole),
    })).join('')
    : '';
  for (const message of conversation?.messages || []) {
    if (message.role === 'assistant') {
      renderMessageContent(
        messagesElement.querySelector(`[data-message-id="${message.id}"] [data-message-content]`),
        message.content,
        message.status === 'streaming',
      );
    }
  }
  renderContextChip();
  textPreview.refresh(messagesElement);
  renderModelSwitcher();
  renderAttachments();
  renderPageSelection();
  renderStorageBadge();
  renderLocalPrompt();
  restoreViewPosition(conversationView, messagesElement, viewPosition, state.followToPage);
  turnNavigator.sync(conversation);
  getDirectoryInfo().then((info) => {
    state.storageInfo = info;
    renderStorageBadge();
    renderLocalPrompt();
  }).catch(() => {});
  renderContextUsage();
  updatePageToolbar();
  updateComposer();
  if (scroll) scrollToLatest(false);
  updateLatestVisibility();
}

function openSourcePage(options = {}) {
  const url = safeHttpUrl(options.url
    || state.activePageSignal?.url || state.pendingPage?.url || state.conversation?.pageContext?.url);
  if (!url) return;
  chrome.tabs.query({}).then((tabs) => {
    const target = findOpenTabForSource(tabs, url);
    if (target) {
      chrome.tabs.update(target.id, { active: true });
      if (Number.isInteger(target.windowId)) {
        chrome.windows.update(target.windowId, { focused: true });
      }
      return;
    }
    chrome.tabs.create({ url });
  });
}

function updatePageToolbar() {
  const page = normalizePageContext(state.pendingPage || state.conversation?.pageContext);
  const active = state.activePageSignal;
  const draftSource = normalizeDraftSource(state.draftSource);
  const pageEnabled = !state.disablePageContext && !draftSource;
  void readingControls.update({ url: active?.url || '', pageEnabled,
    mode: state.readingMode, agentMode: Boolean(agentSlot?.isMode()),
    busy: !state.ready || Boolean(state.generatingId) || state.isSubmitting || state.compressing || state.preparingAttachments,
  });
  pageQuestionChoice.refresh();
  if (!pastedText.getValue().trim()) state.draftPageTarget = null;
  const draftPageChanged = Boolean(state.draftPageTarget && active
    && (state.draftPageTarget.url !== active.url || state.draftPageTarget.tabId !== active.tabId));
  const disabled = Boolean(state.generatingId) || state.isSubmitting || state.compressing || state.preparingAttachments
    || Boolean(agentSlot?.isBusy()) || Boolean(agentSlot?.isMode());
  const summarizeBtn = $('#summarize-page');
  if (summarizeBtn) {
    summarizeBtn.disabled = disabled || state.disablePageContext || !active;
    summarizeBtn.title = state.disablePageContext ? '请先开启输入框中的页面读取开关' : '读取并总结当前页面';
    const hint = summarizeBtn.querySelector('small');
    if (hint) hint.textContent = state.disablePageContext ? '页面读取已关闭，开启后可总结' : '快速了解内容和重点';
  }
  const latestRead = pageReadState.current();
  const activity = latestRead?.target?.conversationId === state.conversation?.id ? latestRead : null;
  const control = pageControlState({ active, page, enabled: pageEnabled, activity, draftPageChanged });
  const pageToggle = $('#composer-page-toggle');
  if (pageToggle) pageToggle.checked = pageEnabled;
  if (pageToggle) pageToggle.disabled = false;
  const pageControl = $('#composer-page-control');
  if (pageControl) pageControl.hidden = !control.available;
  const modes = $('#composer-modes');
  if (modes) modes.hidden = !control.available || !pageEnabled;
  const agentToggle = $('#agent-toggle');
  if (agentToggle) {
    const availability = composition.status('agent');
    agentToggle.disabled = !state.ready || Boolean(state.generatingId) || state.isSubmitting || state.compressing
      || Boolean(agentSlot?.isBusy()) || availability.status !== 'ready' || !control.available || !pageEnabled;
    agentToggle.title = availability.status === 'ready' ? (agentSlot?.isMode() ? '关闭页面操作' : '页面操作')
      : availability.status === 'initializing' ? '页面操作正在初始化' : '页面操作暂不可用，请重新打开侧栏';
  }
  const iconContainer = $('#composer-page-icon');
  const favicon = control.available ? pageFaviconUrl(active) : '';
  if (iconContainer && iconContainer.dataset.favicon !== favicon) {
    iconContainer.dataset.favicon = favicon;
    iconContainer.innerHTML = icon('globe');
    if (favicon) {
      const fallback = iconContainer.firstElementChild;
      const img = document.createElement('img');
      img.className = 'page-pill-fav';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.hidden = true;
      img.addEventListener('load', () => { img.hidden = false; fallback?.setAttribute('hidden', ''); });
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = favicon;
      iconContainer.append(img);
    }
  }
  const pill = $('#composer-page-pill');
  if (pill) {
    pill.title = control.title + '\n' + control.url + '\n' + control.status;
    pill.classList.toggle('is-off', !pageEnabled);
    pill.classList.toggle('is-changed', control.changed && pageEnabled);
  }
  const name = $('#composer-page-name');
  if (name) name.textContent = control.available ? control.title : '当前网页';
  const modeLabel = $('#composer-page-mode');
  if (modeLabel) modeLabel.textContent = control.label;
  const status = $('#composer-page-status');
  if (status) {
    status.hidden = !control.available || !pageEnabled || Boolean(agentSlot?.isMode());
    status.textContent = control.status;
    status.classList.toggle('is-error', pageEnabled && activity?.status === 'failed'
      && activity?.target?.url === active?.url);
    status.title = control.title + '\n' + control.url;
  }
  const modeHint = $('#composer-mode-hint');
  if (modeHint) {
    modeHint.hidden = !draftSource && !(agentSlot?.isMode() && pageEnabled && control.available);
    modeHint.textContent = draftSource
      ? `独立话题 · ${draftSource.label} · 本轮不携带当前网页`
      : agentSlot?.isMode() && pageEnabled && control.available ? '授权后执行页面动作；切换标签或手动操作时暂停。'
        : '';
  }
  if (input && state.ready) input.placeholder = draftSource ? '编辑独立话题…（本轮不携带当前网页）'
    : agentSlot?.isMode() ? '描述要在当前页面完成的任务…' : !active || state.disablePageContext ? '输入问题…' : '问问这个页面，例如：这些配置怎么选？';

}

function activePageSignal(tab) {
  if (!isReadablePageUrl(tab?.url)) return null;
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: String(tab.title || '').trim(),
    favIconUrl: tab.favIconUrl || '',
  };
}

function syncActivePageSignal(tab = null) {
  const next = activePageSignal(tab);
  if (state.activePageSignal?.tabId !== next?.tabId || state.activePageSignal?.url !== next?.url) visualPreparation.cancel();
  const enabled = pageContextEnabledForNavigation(state.activePageSignal, next, state.pageContextPreference);
  state.disablePageContext = !enabled;
  const toggle = $('#composer-page-toggle');
  if (toggle) toggle.checked = enabled;
  state.activePageSignal = next;
  renderWelcomePrompts();
  return next;
}

async function resolveCurrentPageSource(explicitPageRequest = false, forceRefresh = false) {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  const active = syncActivePageSignal(tab);
  const existing = normalizePageContext(state.pendingPage || state.conversation?.pageContext);
  return resolvePageSource({
    oldUrl: state.conversation?.pageContext?.url || state.pendingPage?.url || '',
    activeUrl: active?.url || '',
    title: active?.title || existing?.title || '',
    explicitPageRequest,
    forceRefresh,
  });
}

async function readCurrentPageForRequest(request, { deep = false, lazyLoad = deep, repository = false, target = null, signal = null, timeoutMs } = {}) {
  const tab = target || await chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab);
  const tabId = tab?.id ?? tab?.tabId;
  if (!tabId) return null;
  const maxBudget = Math.min(50000, Math.max(3000, Math.floor(activeContextWindow() * 0.45)));
  return pageReadState.run({ ...tab, conversationId: state.conversation?.id }, signal, () => pageReaderSlot.read({ maxBudget, deep, source: repository ? 'repository' : 'page', tabId, expectedUrl: tab.url || tab.expectedUrl, documentId: tab.documentId, forceRefresh: true, lazyLoad, signal, timeoutMs, quiet: false, throwOnError: true }));
}

function adoptPageSource(page) {
  const normalized = normalizePageContext(page);
  if (!normalized) return false;
  if (state.conversation) {
    state.conversation.pageContext = normalized;
  }
  state.pendingPage = null;
  renderContextChip();
  updatePageToolbar();
  refreshContextUsage();
  return true;
}

function readMatchesActiveSource(page, source) {
  const pageUrl = normalizePageUrl(page?.url);
  if (!pageUrl || !source.activeUrl) return false;
  if (pageUrl === source.activeUrl) return true;
  const parsedPage = parseRepositoryUrl(pageUrl);
  const parsedActive = parseRepositoryUrl(source.activeUrl);
  return Boolean(parsedPage && parsedActive
    && parsedPage.provider === parsedActive.provider
    && parsedPage.owner === parsedActive.owner
    && parsedPage.repo === parsedActive.repo);
}

function currentTabUrl() {
  return state.activePageSignal?.url || '';
}

function activePageTitle() {
  return state.activePageSignal?.title || '';
}

function updateComposer() {
  const generating = Boolean(state.generatingId);
  const agentMode = Boolean(agentSlot?.isMode());
  const agentBusy = Boolean(agentSlot?.isBusy());
  const restartPending = agentTaskRestart.isPending();
  const busy = generating || agentBusy || state.isSubmitting || state.compressing || restartPending;
  const activeAssistant = find(
    state.conversation?.messages,
    (message) => message.id === state.activeAssistantId,
  );
  const hasLiveRequest = liveReplyState({
    generatingId: state.generatingId,
    conversationId: state.conversation?.id,
    assistant: activeAssistant,
    signal: state.controller?.signal,
  });
  const scrollLatest = $('#scroll-latest');
  if (scrollLatest) {
    scrollLatest.classList.toggle('is-streaming', busy);
  }
  // Regenerate/retry remains available while a reply streams so it can replace a stale turn.
  for (const button of messagesElement.querySelectorAll('[data-action="regenerate"], [data-action="retry"]')) {
    button.disabled = agentBusy || agentMode || historyMutationBusy || restartPending;
  }
  for (const button of messagesElement.querySelectorAll('[data-action="restart-agent"]')) {
    const control = agentRestartControl({ busy: busy || historyMutationBusy || state.preparingAttachments || !state.ready,
      pagePreference: state.pageContextPreference, independent: Boolean(normalizeDraftSource(state.draftSource)) });
    button.disabled = control.disabled;
    button.title = control.title;
  }
  const draftText = pastedText.getValue().trim();
  const hasDraft = Boolean(draftText || state.attachments.length || state.pageSelection?.text);
  const canQueue = busy && !agentBusy && !agentMode && !restartPending;
  sendButton.hidden = busy && (!canQueue || !hasDraft);
  sendButton.title = canQueue ? '加入队列' : '发送消息';
  stopButton.hidden = !busy;
  sendButton.disabled = (agentMode
    ? !draftText
    : (!draftText && !state.attachments.length && !state.pageSelection?.text))
    || !state.ready || state.preparingAttachments || historyMutationBusy || (busy && !canQueue);
  const composerPageToggle = $('#composer-page-toggle');
  const composerPagePill = $('#composer-page-pill');
  if (composerPageToggle && composerPagePill) {
    composerPagePill.classList.toggle('is-off', !composerPageToggle.checked);
    if (!composerPageToggle.checked) {
      input.placeholder = '输入消息…（不携带当前网页）';
    } else {
      input.placeholder = (state.conversation?.pageContext || state.pendingPage) ? '针对当前网页提问…' : '输入消息…';
    }
  }
  renderModelSwitcher();
  $('#new-chat').disabled = busy || historyMutationBusy;
  $('#history-new-chat').disabled = busy || historyMutationBusy;
  historySidebar?.setBusy(busy || historyMutationBusy);
  $('#export-selected').disabled = !state.conversation?.id;
  conversationExportMenu.sync(state.conversation?.id);
  $('#attach-button').disabled = busy || state.preparingAttachments;
  const documentAttachment = $('#attach-menu [data-attach-kind="document"]');
  if (documentAttachment) { documentAttachment.disabled = agentMode; documentAttachment.classList.toggle('is-disabled', agentMode); }
  input.readOnly = !state.ready || agentBusy || historyMutationBusy || restartPending;
  input.placeholder = agentMode ? '描述要在当前页面完成的任务…' : state.disablePageContext ? '输入消息…（本轮不读取网页）' : state.activePageSignal ? '针对当前网页提问…' : '输入消息…';
  $('#composer').classList.toggle('is-generating', busy);
  updatePageToolbar();
}

function scrollToLatest(force = false) {
  if (!force && !state.followToPage) return;

  conversationView.scrollTo({ top: conversationView.scrollHeight, behavior: 'instant' });
  state.followToPage = true;
  $('#scroll-latest').hidden = true;
}

function updateLatestVisibility() {
  const overflow = conversationView.scrollHeight - conversationView.clientHeight;
  const distance = overflow - conversationView.scrollTop;
  $('#scroll-latest').hidden = overflow <= 1 || distance < 65 || !state.conversation?.messages.length;
}

function setAssistantPhase(assistant, phase) {
  if (!assistant) return;
  // Execution phases are owned by the application; this function only paints.
  updateStreamingMessage(assistant.id);
  if (state.progressTimer) return;
  state.progressTimer = setInterval(() => {
    const pending = (state.conversation?.messages || []).filter(message =>
      message.status === 'streaming' && message.requestPhase && !message.content && !message.reasoning && !message.agent);
    if (!pending.length) {
      clearInterval(state.progressTimer);
      state.progressTimer = null;
      return;
    }
    for (const message of pending) updateStreamingMessage(message.id);
  }, 1000);
}

// Render the generic welcome immediately. The chrome API fills in the active
// page during initialize; previewing the built HTML without the extension must
// still show the new prompts instead of the static fallback.
renderWelcomePrompts();

function renderHistoryList() {
  historySidebar?.update({ entries: state.conversations || [], activeId: state.conversation?.id,
    query: state.historySearchQuery, snapshot: historyOrganization });
}

async function refreshHistory() {
  const version = ++historyRefreshVersion;
  try {
  const [conversations, organization] = await awaitWithTimeout(Promise.all([
    listSavedConversations(), conversationOrganization.read(),
  ]), { timeoutMs: 15000, message: '读取历史会话超时，请重试。' });
  if (version !== historyRefreshVersion) return;
  state.conversations = conversations;
  if (!historyOrganization || organization.revision >= historyOrganization.revision) historyOrganization = organization;
  renderHistoryList();
  const title = historyOrganization.titles[state.conversation?.id];
  if (title && state.conversation.title !== title) { state.conversation.title = title; renderConversation(); }
  } catch (error) { if (version === historyRefreshVersion) historySidebar?.setLoadError(error); throw error; }
}

function setHistoryOpen(open) {
  historyLayout.setOpen(open, { keepDocked: true });
}

async function selectConversation(id) {
  if (state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy()) {
    toast('请先停止当前任务，再切换会话。');
    return;
  }
  const floatingChat = typeof selectionChats === 'undefined' ? null
    : [...selectionChats].find(chat => chat.conversationId === id);
  if (floatingChat) return floatingChat.openInMain();
  return historyNavigation.run(async operation => {
    visualPreparation.cancel();
    const conversation = await operation.read(loadConversation(id));
    if (!conversation) {
      toast('会话不存在，可能已被删除。', 'error');
      await operation.read(refreshHistory());
      return;
    }
    operation.commit(() => {
      state.conversation = conversation;
      agentTurnCallbacks.reconcile(conversation);
      application.repository.reconcile(conversation);
      state.pendingPage = null;
      setHistoryOpen(false);
      renderConversation({ scroll: true });
    });
    await operation.read(refreshHistory());
    void processQueue();
  }, { label: '读取历史会话' });
}

async function newConversation(groupId = null) {
  if (state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy() || historyNavigation.busy) {
    toast('请先停止当前任务，再新建会话。');
    return null;
  }
  return historyNavigation.run(async operation => {
    visualPreparation.cancel();
    let storageInfo = await operation.read(getDirectoryInfo());
    if (!storageInfo.granted && storageInfo.configured) {
      if (await operation.read(requestDirectoryPermission())) storageInfo = await operation.read(getDirectoryInfo());
    }
    state.storageInfo = storageInfo;
    const previous = state.conversation;
    conversationSaver.flush();
    let created;
    let groupingError = null;
    await operation.read(conversationSaver.enqueue(async () => {
      operation.assertCurrent();
      const currentTemporary = previous?.storage === 'temporary' ? previous : null;
      if (currentTemporary?.messages.length) {
        const saved = await operation.persist(() => promoteTemporaryConversation(currentTemporary));
        // If a later new-draft write fails, the original record remains local.
        Object.assign(currentTemporary, { storage: saved.storage || 'local', syncStatus: saved.syncStatus,
          syncError: saved.syncError || '', syncDirectoryName: saved.syncDirectoryName || '' });
        if (saved.storageGeneration) currentTemporary.storageGeneration = saved.storageGeneration;
        renderStorageBadge();
        toast(saved.syncStatus === 'pending' ? '上一条对话已保存在浏览器，等待同步到文件夹。' : '上一条对话已保存到本地文件夹。');
      }
      created = await operation.persist(() => createTemporaryConversation('新对话'));
      if (typeof groupId === 'string' && groupId !== 'none') {
        // Group metadata does not make an empty draft a saved history record.
        // The existing submission/save paths promote it when it is used.
        try {
          const snapshot = await operation.read(conversationOrganization.moveConversations([created.id], groupId));
          if (!historyOrganization || snapshot.revision >= historyOrganization.revision) historyOrganization = snapshot;
        } catch (error) {
          operation.assertCurrent();
          groupingError = error;
        }
      }
    }));
    operation.commit(() => {
      state.conversation = created;
      agentTurnCallbacks.reconcile(created);
      application.repository.reconcile(created);
      state.pendingPage = null;
      state.attachments = [];
      state.followToPage = true;
      setHistoryOpen(false);
      renderConversation();
    });
    if (groupingError) toast(`新对话仍为临时会话，归组未确认：${groupingError.message}`, 'error');
    await operation.read(refreshHistory());
    input.focus();
    return created;
  }, { label: '新建对话' });
}

async function ensureConversation(signal) {
  signal?.throwIfAborted();
  if (state.conversation) return state.conversation;
  const storageInfo = await getDirectoryInfo();
  signal?.throwIfAborted();
  const conversation = await createTemporaryConversation('新对话');
  signal?.throwIfAborted();
  state.storageInfo = storageInfo;
  state.conversation = conversation;
  renderConversation();
  return state.conversation;
}

const conversationSaver = createConversationSaver({
  getConversation: () => state.conversation,
  loadConversation,
  writeConversation: saveConversationByStorage,
  getQueue: () => state.saveQueue,
  setQueue: (pending) => { state.saveQueue = pending; },
  now,
  onSaved: (conversationId, saved) => {
    observeConversationSaveDiagnostic(recordDiagnostic, conversationId, saved);
    if (state.conversation?.id === conversationId) {
      state.conversation.syncStatus = saved?.syncStatus || 'synced';
      state.conversation.syncError = saved?.syncError || '';
      state.conversation.syncDirectoryName = saved?.syncDirectoryName || '';
      renderStorageBadge();
    }
  },
  onError: (conversationId, error) => {
    safeDiagnostic(recordDiagnostic, { event: 'storage.failed', source: 'storage', level: 'error', context: { conversationId }, data: { stage: 'saving' }, error: diagnosticFailure(error) });
    if (state.conversation?.id === conversationId) { state.conversation.syncStatus = 'error'; state.conversation.syncError = error.message; renderStorageBadge(); }
    toast(`本地保存失败：${error.message || '请检查文件夹权限'}`, 'error');
  },
});

function updateHistoryMutationBusy() {
  historyMutationBusy = historySidebarBusy || historyNavigationBusy;
  updateComposer();
}

const historyNavigation = createHistoryNavigation({
  getCurrent: () => state.conversation,
  onBusy: busy => { historyNavigationBusy = busy; updateHistoryMutationBusy(); },
  onLateError: error => toast(error.message || '历史操作未完成，请重新核对。', 'error'),
});

function historyDeletionBlocked(ids) {
  if (state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy()) return '请先停止当前任务，再删除对话。';
  if (typeof selectionChats !== 'undefined' && [...selectionChats].some(chat => ids.includes(chat.conversationId))) {
    return '请先关闭所选对话的追问窗口，再删除对话。';
  }
  if (state.messageQueue.some(item => ids.includes(item.conversationId))) return '所选对话还有排队问题，请先发送或撤回排队内容。';
  return '';
}

historySidebar = createHistorySidebar({
  drawer: historyDrawer, organization: conversationOrganization, formatDate,
  onOpen: selectConversation,
  onNew: newConversation,
  onQuery: query => { state.historySearchQuery = query; },
  onBusy: busy => { historySidebarBusy = busy; updateHistoryMutationBusy(); },
  onRenamed: (id, title) => {
    if (historyOrganization) historyOrganization.titles[id] = title;
    if (state.conversation?.id === id) { state.conversation.title = title; renderConversation(); }
  },
  deletionBlocked: historyDeletionBlocked,
  onRefresh: refreshHistory,
  onError: error => toast(error.message || '整理历史对话失败。', 'error'),
  onDelete: async ids => {
    const original = state.conversation;
    const reason = historyDeletionBlocked(ids); if (reason) throw new Error(reason);
    conversationSaver.flush();
    await awaitWithTimeout(state.saveQueue, { timeoutMs: 10000, message: '等待会话保存超时，尚未开始删除。' });
    const currentReason = historyDeletionBlocked(ids); if (currentReason) throw new Error(currentReason);
    const result = await trashSavedConversations(ids);
    if (!startupController.signal.aborted && state.conversation === original
      && [...result.deletedIds, ...result.pendingIds].includes(original?.id)) {
      deletedActiveConversationId = state.conversation.id;
      state.conversation = null; state.pendingPage = null;
      renderConversation();
    }
    return result;
  },
  onRestore: async token => {
    const result = await restoreTrashedConversations(token);
    if (!state.conversation && result.restoredIds.includes(deletedActiveConversationId)) {
      const originalId = deletedActiveConversationId;
      try {
        await historyNavigation.run(async operation => {
          const restored = await operation.read(loadConversation(originalId));
          if (state.conversation || deletedActiveConversationId !== originalId) return;
          operation.commit(() => {
            state.conversation = restored;
            if (restored) { agentTurnCallbacks.reconcile(restored); application.repository.reconcile(restored); }
            deletedActiveConversationId = null;
            renderConversation();
          });
        }, { label: '打开已恢复的对话' });
      } catch (error) { toast(`对话已恢复，打开失败：${error.message}`, 'error'); }
    }
    return result;
  },
});
const historyLayout = createHistoryLayout({
  app: $('#app'), drawer: historyDrawer, backdrop: $('#drawer-backdrop'),
  trigger: $('#open-history'), closeButton: $('#close-history'), searchInput: $('#history-search-input'), window,
  onOpenChange: open => historySidebar?.setOpen(open),
});
conversationOrganization.subscribe(snapshot => {
  historyOrganization = snapshot;
  const title = snapshot.titles[state.conversation?.id];
  if (title && state.conversation.title !== title) { state.conversation.title = title; renderConversation(); }
});

async function saveCurrent({ required = false, conversation = state.conversation, agentMessage = null } = {}) {
  return conversationSaver.save(conversation, { required, agentMessage });
}

function scheduleSave() {
  state.saveTimer = conversationSaver.schedule(state.conversation);
}

function conversationTitle(text, attachments = []) {
  const title = truncateText(text, 34);
  if (title) return title;
  return truncateText(attachments[0]?.name, 34) || '新对话';
}

async function ensureConfigured(signal) {
  const config = await getProviderConfig();
  signal?.throwIfAborted();
  const storageInfo = await getDirectoryInfo();
  signal?.throwIfAborted();
  state.config = config;
  state.storageInfo = storageInfo;

  const normalized = normalizeProviderConfig(state.config);
  if (!normalized?.endpointUrl || !normalized?.models?.length) {
    state.draft = pastedText.getValue();
    toast('请先配置模型服务，你的输入已保留。');
    chrome.runtime.openOptionsPage();
    return false;
  }
  return true;
}

async function readPage({ deep = false, quiet = false } = {}) {
  return readPageAtBudget(60000, { deep, quiet });
}

async function readPageAtBudget(maxBudget, { deep = false, quiet = false } = {}) {
  return pageReaderSlot.read({ maxBudget, deep, quiet });
}

async function readRepositoryAtBudget(maxBudget, { maxFiles = 24, quiet = false } = {}) {
  return pageReaderSlot.read({
    source: 'repository',
    maxBudget,
    maxFiles,
    deep: false,
    quiet,
  });
}

const agentTurnCallbacks = createAgentTurnCallbacks({
  getConversation: () => state.conversation,
  ensureConversation,
  save: (conversation, message) => { void saveCurrent({ conversation, agentMessage: message }); },
  render: renderConversation,
  getProfile: activeChatProfile,
  getEffort: () => state.selectedEffort,
  createId: makeId,
  titleFor: (text) => truncateText(text, 34),
  now,
});

async function beginAgentTurn(turn, { signal } = {}) {
  return agentTurnCallbacks.begin(turn, { signal });
}

async function updateAgentTurn(turn, { signal } = {}) {
  return agentTurnCallbacks.update(turn, { signal });
}

async function endAgentTurn(turn, { signal } = {}) {
  return agentTurnCallbacks.end(turn, { signal });
}

async function restoreAgentTurn(turn, { signal } = {}) {
  return agentTurnCallbacks.restore(turn, { signal });
}

const modelGateway = createModelGateway({ onEvent: event => observeModelDiagnostic(recordDiagnostic, event) });
const composition = createSidepanelComposition({
  reading: {
  sendMessage: (message) => chrome.runtime.sendMessage(message),
  queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab),
  sendTabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  readPdf: (url, options) => readPdfFromUrl(url, options),
  readRepository: (url, options) => repositoryReader(url, options),
  getNow: now,
  ui: {
    begin: (deep, quiet) => showPageReading(deep, quiet),
    beginPdf: (quiet) => showPdfReading(quiet),
    fail: (quiet) => showPageReadFailure(quiet),
    notify: notifyPageReadFailure,
    end: (quiet) => { if (!quiet) updatePageToolbar(); },
  },
  },
  visual: {
    modelGateway,
    getProfile: activeChatProfile,
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    isBusy: () => state.preparingAttachments || Boolean(state.generatingId),
  },
  agent: {
    modelGateway,
    recordDiagnostic,
    getDiagnosticContext: taskId => agentTurnCallbacks.getDiagnosticContext(taskId),
    getPageModeEnabled: () => !state.disablePageContext && !normalizeDraftSource(state.draftSource)
      && isReadablePageUrl(state.activePageSignal?.url),
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab),
    getProfile: () => requestProfile(state.config, {
      modelId: state.selectedModelId,
      effort: state.selectedEffort,
    }),
    focusInput: () => input.focus(),
    restoreTurn: restoreAgentTurn,
    beginTurn: beginAgentTurn,
    updateTurn: updateAgentTurn,
    endTurn: endAgentTurn,
    onStateChange: () => {
      if (agentSlot?.isMode()) state.draftSource = null;
      updateComposer();
      updatePageToolbar();
      if (!agentSlot?.isBusy() && !state.generatingId && !state.isSubmitting) {
        processQueue();
      }
    },
  },
});
const pageReaderSlot = composition.reading;
const autoVisualSlot = composition.visual;
const agentSlot = composition.agent;
const networkReadingClient = createNetworkReadingClient({
  connect: options => chrome.runtime.connect(options),
  sendMessage: message => chrome.runtime.sendMessage(message),
});
const enhancePageReading = createSupplementalReader({
  readDeep: options => readCurrentPageForRequest('', options), networkClient: networkReadingClient,
  getNetworkGrant: async (target, { signal }) => {
    const response = await awaitWithTimeout(chrome.runtime.sendMessage({
      type: 'NETWORK_READING_VALIDATE', ...pageTargetFields(target),
    }), { signal, timeoutMs: 4000, message: '核对接口资料授权超时，请重试。' });
    signal?.throwIfAborted();
    if (response?.error) throw Object.assign(new Error(response.message || '无法核对接口资料授权。'), { code: response.error });
    return response;
  },
});
const readingControls = createReadingControls({
  getNetworkAllowed: async url => {
    const grant = await getNetworkReadingGrant(url);
    return grant.allowed;
  },
  setNetworkAllowed: (url, allowed) => setNetworkReadingGrant(new URL(url).origin, allowed),
  onModeChange: mode => { state.readingMode = mode; },
  onGrantState: ({ origin, allowed, confirmed }) => {
    state.networkReadingGrant = { origin, allowed: confirmed && allowed };
    if (origin && (!confirmed || !allowed)) enhancePageReading.invalidate({ origin });
  },
  onError: error => toast(error.message || '读取设置暂不可用。', 'error'),
});
void composition.ready.then(() => updateComposer());

const application = createSidepanelApplication({
  state, conversationSaver, agentSlot, modelGateway, recordDiagnostic,
  browser: {
    queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab || null),
    sendMessage: message => chrome.runtime.sendMessage(message),
  },
  ensureConversation, ensureConfigured, saveCurrent, scheduleSave, getDirectoryInfo,
  promoteTemporaryConversation, readCurrentPageForRequest, autoVisualAttachments, enhancePageReading,
  activeChatProfile, profileFor: (modelId = state.selectedModelId, effort = state.selectedEffort) => requestProfile(state.config, { modelId, effort }),
  conversationTitle, hasVision, makeId, now, truncateText,
});
const selectionChats = new Set();
let selectionChatsDisposed = false;
selectionChatSessions = createSelectionChatSessions({ getConversationId: () => state.conversation?.id,
  createChat: (selection, anchorRect) => {
    const runtime = createSelectionChatRuntime({ selection, modelGateway, recordDiagnostic,
      getConfig: () => state.config,
      getProfile: () => requestProfile(state.config, { modelId: state.selectedModelId, effort: state.selectedEffort }),
      onSaved: () => { if (!selectionChatsDisposed) void refreshHistory().catch(() => {}); },
    });
    let chat;
    try {
      chat = createSelectionChatView({ document, runtime, selection, anchorRect, textPreview,
        getReplaceBlockReason: selectionChatReplaceBlockReason, onReplace: replaceWithSelectionChat,
        fallbackFocus: () => input, onClose: () => {
          selectionChats.delete(chat);
          selectionChatSessions.forget(chat);
        } });
    } catch (error) {
      Promise.resolve(runtime.close()).catch(() => {});
      throw error;
    }
    selectionChats.add(chat);
    return chat;
  },
});
function selectionChatReplaceBlockReason() {
  return !state.ready || state.generatingId || state.isSubmitting || state.compressing
    || agentSlot?.isBusy() || agentTaskRestart.isPending() || historyNavigation.busy
    ? '请先完成或停止主聊天区的任务，再替换当前对话。' : '';
}
function articleQuoteMutationBlocked() {
  return state.isSubmitting && !state.generatingId ? '正在准备发送，请稍后再修改引用注释。' : '';
}
async function replaceWithSelectionChat(runtime, { signal, isCurrent }) {
  const blocked = selectionChatReplaceBlockReason();
  if (blocked) throw new Error(blocked);
  return historyNavigation.run(async operation => {
    const check = () => {
      signal.throwIfAborted();
      operation.assertCurrent();
      if (!isCurrent()) throw new DOMException('追问窗口已关闭，未切换对话。', 'AbortError');
    };
    check();
    visualPreparation.cancel();
    conversationSaver.flush();
    if (state.conversation?.messages.length) await operation.read(saveCurrent({ required: true }));
    check();
    const conversation = await operation.read(runtime.takeConversation({ signal, isCurrent: () => { check(); return true; } }));
    check();
    operation.commit(() => {
      state.conversation = conversation;
      agentTurnCallbacks.reconcile(conversation);
      application.repository.reconcile(conversation);
      state.pendingPage = null;
      state.pageSelection = null;
      state.draftSource = null;
      setHistoryOpen(false);
      renderConversation({ scroll: true });
      refreshContextUsage();
    });
    void refreshHistory().catch(() => {});
    input.focus({ preventScroll: true });
    return true;
  }, { label: '打开单独追问对话' });
}
const articleQuoteView = createArticleQuoteView({ document, root: messagesElement, host: $('#article-quote-draft'),
  getConversation: () => state.conversation, getSelection: () => state.pageSelection,
  scrollContainer: conversationView,
  getViewportRect: () => conversationView.getBoundingClientRect(),
  onLocateUnavailable: () => toast('当前对话中无法定位这段原文，引用内容仍已保留。'),
  focusInput: () => input.focus({ preventScroll: true }),
  onEdit: quote => {
    const blocked = articleQuoteMutationBlocked();
    if (blocked) { toast(blocked); return; }
    const ownerId = state.conversation?.id;
    const sourceRect = articleQuoteView.anchorRect(quote.id) || articleQuoteView.locate(quote.id);
    const bounds = conversationView.getBoundingClientRect();
    const rect = sourceRect || { left: bounds.left + 16, right: bounds.right - 16,
      top: bounds.top + 16, bottom: bounds.top + 16, width: Math.max(0, bounds.width - 32), height: 0 };
    articleSelectionMenu.openQuote(quote, rect, {
      comment: quote.comment, title: '修改引用注释', ownerConversationId: ownerId,
      getAnchorRect: sourceRect ? () => articleQuoteView.anchorRect(quote.id) : undefined,
      sourceUnavailable: !sourceRect,
      isCurrent: () => state.conversation?.id === ownerId && articleQuotes(state.pageSelection).some(item => item.id === quote.id),
      onConfirm: comment => {
        if (state.conversation?.id !== ownerId) return false;
        const blocked = articleQuoteMutationBlocked();
        if (blocked) throw new Error(blocked);
        setPageSelection(updateArticleQuote(state.pageSelection, quote.id, comment));
        input.focus({ preventScroll: true });
        return true;
      },
    });
  },
  onRemove: id => {
    const blocked = articleQuoteMutationBlocked();
    if (blocked) { toast(blocked); return; }
    const next = removeArticleQuote(state.pageSelection, id);
    if (next) setPageSelection(next); else clearPageSelection();
  },
  onClear: () => {
    const blocked = articleQuoteMutationBlocked();
    if (blocked) toast(blocked); else clearPageSelection();
  },
});
const articleSelectionMenu = createArticleSelectionMenu({ document, root: messagesElement,
  getConversation: () => state.conversation,
  getViewportRect: () => conversationView.getBoundingClientRect(),
  onQuote: (selection, _rect, comment = '') => {
    if (agentSlot?.isBusy()) { toast('请先停止页面操作，再引用回答提问。'); return false; }
    const blocked = articleQuoteMutationBlocked();
    if (blocked) throw new Error(blocked);
    if (selection.conversationId !== state.conversation?.id) throw new Error('当前对话已切换，请重新选择需要引用的内容。');
    const next = appendArticleQuote(state.pageSelection, selection, comment);
    selectionClearing = false;
    agentSlot?.setMode(false);
    pageQuestionChoice.clear();
    state.draftSource = null;
    setPageSelection(next);
    input.focus({ preventScroll: true });
    return true;
  },
  onAsk: (selection, anchorRect) => {
    if (selectionChatsDisposed) return;
    const result = selectionChatSessions.open(selection, anchorRect);
    if (!result.accepted) throw new Error(result.reason === 'source-mismatch'
      ? '当前对话已切换，请重新选择需要追问的内容。' : '追问窗口暂时无法接收选区，请稍后重试。');
    return true;
  },
  onError: error => toast(error.message || '无法打开选区提问，请重试。', 'error'),
});
let replyPaintPending = false;
let latestReplyPaint = null;
application.subscribe(event => {
  if (typeof selectionChats !== 'undefined') for (const chat of selectionChats) chat.sync();
  if (event.type === 'draft') { pastedText.setValue(state.draft || ''); resizeInput(); }
  else if (event.type === 'attachments') renderAttachments();
  else if (event.type === 'selection') renderPageSelection();
  else if (event.type === 'composer') updateComposer();
  else if (event.type === 'queue') renderQueueBar();
  else if (event.type === 'context') { renderContextChip(); refreshContextUsage(); }
  else if (event.type === 'notice') toast(event.message, event.kind);
  else if (event.type === 'conversation') renderConversation({ scroll: event.scroll });
  else if (event.type === 'progress' || event.type === 'run:phase') {
    const assistant = state.conversation?.messages.find(message => message.id === event.assistantId);
    if (assistant) setAssistantPhase(assistant);
  } else if (event.type === 'run:message') {
    if (state.conversation?.id !== event.conversationId) return;
    latestReplyPaint = event;
    if (replyPaintPending) return;
    replyPaintPending = true;
    requestAnimationFrame(() => {
      replyPaintPending = false;
      const pending = latestReplyPaint;
      latestReplyPaint = null;
      if (state.conversation?.id !== pending?.conversationId) return;
      const message = state.conversation.messages.find(item => item.id === pending.assistantId && item.runId === pending.runId);
      if (!message) return;
      updateStreamingMessage(message.id);
      turnNavigator.scheduleLayout();
      if (state.followToPage) refreshContextUsage({ beforeAssistantId: message.id });
    });
  } else if (event.type === 'reply-started') scrollToLatest(false);
  else if (event.type === 'reply-ended') {
    if (state.pageSelection && shouldReleaseSelection(state.pageSelection, event.selectionUsed)) clearPageSelection();
    renderConversation(); refreshContextUsage(); void refreshHistory().catch(() => {});
  } else if (event.type === 'run:terminal') {
    if (state.conversation?.id === event.conversationId) { renderConversation(); refreshContextUsage(); }
  } else if (event.type === 'run:persistence-error') {
    toast('回答已生成，但保存调度失败，请保留当前会话并重试保存。', 'error');
  } else if (event.type === 'run:commit-error') {
    toast('本轮结果写入失败，请检查会话后重试。', 'error');
  } else if (event.type === 'compression-settled') {
    renderContextUsage(); updateComposer(); void processQueue();
  }
});


function updateStreamingMessage(id) {
  const message = find(state.conversation?.messages, (item) => item.id === id);
  const article = messagesElement.querySelector(`[data-message-id="${id}"]`);
  const latestAssistant = [...(state.conversation?.messages || [])]
    .reverse()
    .find((item) => item.role === 'assistant');
  const latestMessageRole = state.conversation?.messages.at(-1)?.role || '';
  updateMessageView({
    message,
    article,
    messagesElement,
    conversationView,
    followToPage: state.followToPage,
    showSuggestions: showSuggestionsFor(message, latestAssistant?.id, latestMessageRole),
  });
  updateLatestVisibility();
}

async function compressContext(conversation, beforeAssistantId, options) {
  return application.contextService.compress(conversation, beforeAssistantId, options);
}

async function sendMessage(text = pastedText.getValue(), options = {}) {
  if (!options.fromQueue && state.pageSelection?.source === 'conversation') {
    options = { ...options, directModelRequest: true, pageContextEnabled: false,
      agentTask: false, pageTargetPromise: Promise.resolve(null) };
  }
  if (agentTaskRestart.isPending()) { toast('正在准备重新开始任务，请先停止或等待完成。'); return; }
  if (historyMutationBusy) { toast('正在整理历史对话，请稍后发送。'); return; }
  if (state.preparingAttachments) { toast('请先完成图片选择，或取消后再发送。'); return; }
  if ((options.agentTask || agentSlot?.isMode()) && (state.disablePageContext
    || normalizeDraftSource(state.draftSource) || !isReadablePageUrl(state.activePageSignal?.url))) {
    toast('请先开启“基于当前页”，再使用页面操作。');
    return;
  }
  state.draft = pastedText.getValue();
  if (state.ready && !options.fromQueue && !options.requirePage && !Object.hasOwn(options, 'pageContextEnabled')
    && needsPageQuestionChoice({ question: text, enabled: !state.disablePageContext,
      active: state.activePageSignal, messages: state.conversation?.messages,
      attachments: state.attachments, selection: state.pageSelection,
      independent: Boolean(normalizeDraftSource(state.draftSource)) || options.directModelRequest === true
        || state.directModelRequest === String(text).trim(), agentMode: Boolean(options.agentTask || agentSlot?.isMode()) })) {
    const replaceActiveReply = state.directReplaceReply === true;
    state.directReplaceReply = false;
    pageQuestionChoice.offer(text, { ...options, replaceActiveReply });
    return;
  }
  pageQuestionChoice.clear();
  return application.conversations.sendMessage(text, options);
}

function stopActiveReply() { return application.conversations.stopActiveReply(); }

let lastSummarizeAt = 0;
async function summarizePage() {
  const nowTs = Date.now();
  if (nowTs - lastSummarizeAt < 500) return;
  lastSummarizeAt = nowTs;
  if (state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy() || agentSlot?.isMode() || !state.ready) {
    toast('正在生成中，请等待完成或点击停止。', 'error');
    return;
  }
  if (state.disablePageContext) {
    toast('页面读取已关闭，请先开启输入框中的页面开关。');
    return;
  }
  if (!state.activePageSignal || !isReadablePageUrl(state.activePageSignal.url)) {
    toast('当前页面没有可读取的正文。');
    return;
  }
  const summaryPrompt = (!normalizeDraftSource(state.draftSource) && pastedText.getValue().trim())
    || '请总结这个网页的主要内容、核心观点和关键结论。用简洁清晰的 Markdown 组织回答。';
  state.draftSource = null;
  state.lastSentFingerprint = '';
  await sendMessage(summaryPrompt, { requirePage: true });
}

async function switchToActivePage() {
  if (state.generatingId || state.isSubmitting || state.compressing || agentSlot?.isBusy() || !state.ready) return;
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  syncActivePageSignal(tab);
  const previous = normalizePageContext(state.pendingPage || state.conversation?.pageContext);
  const source = await resolveCurrentPageSource(true, true);
  if (source.action !== 'read-active') {
    toast('浏览器当前没有可读取的网页。');
    return;
  }
  const page = await readCurrentPageForRequest('', { deep: true, target: tab });
  if (!page || !readMatchesActiveSource(page, source)) {
    toast('没有读取到浏览器当前页面的正文。', 'error');
    return;
  }
  adoptPageSource(page);
  if (previous && normalizePageUrl(previous.url) !== normalizePageUrl(page.url)) {
    toast(`页面来源已切换：${page.title || page.url}`);
  } else {
    toast('已读取当前页面。');
  }
}

async function regenerate(assistantId) {
  if (agentTaskRestart.isPending()) { toast('正在准备重新开始任务，请先停止或等待完成。'); return; }
  if (historyMutationBusy) { toast('正在整理历史对话，请稍后重试。'); return; }
  return application.conversations.regenerate(assistantId);
}

async function exportChat(conversationId, { signal, isCurrent } = {}) {
  if (state.conversation?.id !== conversationId || !state.conversation?.messages.length || signal?.aborted) return;
  try {
    // Serialize synchronously before the browser save can outlive this chat.
    const { filename, content } = exportConversationMarkdown(state.conversation);
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    await markdownDownloader({ blob, filename, signal });
    if (isCurrent?.()) toast('已选择导出位置，正在保存 Markdown。');
  } catch (error) {
    if (error.name !== 'AbortError' && isCurrent?.()) toast(`导出失败：${error.message || '请重试'}`, 'error');
  }
}

input.addEventListener('input', () => {
  pastedText.handleInput();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendMessage();
  }
});
input.addEventListener('paste', (event) => {
  const images = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'));
  if (!images.length) { pastedText.handlePaste(event); return; }
  event.preventDefault();
  addAttachments(images, 'image');
});
function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

sendButton.addEventListener('click', () => sendMessage());
stopButton.addEventListener('click', (event) => {
  // Send becomes Stop in the same position. A double-click's second click
  // still belongs to the send gesture, not a new cancellation command.
  if (event.detail > 1) return;
  if (agentTaskRestart.isPending()) agentTaskRestart.cancel();
  if (agentSlot?.isBusy()) {
    void agentSlot.stop('user');
    return;
  }
  stopActiveReply();
  updateComposer();
  renderConversation();
});
$('#attach-menu').addEventListener('click', (event) => {
  const item = event.target.closest('[data-attach-kind]');
  if (!item) return;
  toggleAttachMenu(false);
  const kind = item.dataset.attachKind;
  if (kind === 'image') $('#image-input').click();
  else if (kind === 'document') $('#document-input').click();
});
$('#image-input')?.addEventListener('change', (event) => {
  addAttachments(event.target.files, 'image');
  event.target.value = '';
});
$('#document-input').addEventListener('change', (event) => {
  addAttachments(event.target.files, 'document');
  event.target.value = '';
});
$('#attachment-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-attachment-id]');
  if (!button) return;
  state.attachments = state.attachments.filter((attachment) => attachment.id !== button.dataset.attachmentId);
  renderAttachments();
  updateComposer();
  input.focus();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.context-control')) setContextPanel(false);
  if (event.target.closest('#attach-button')) {
    if (!state.generatingId) toggleAttachMenu($('#attach-menu').hidden);
    return;
  }
  if (!event.target.closest('.attach-control')) toggleAttachMenu(false);
}, true);
$('#composer').addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  $('#composer').classList.add('is-dragging');
});
$('#composer').addEventListener('dragleave', (event) => {
  if (!event.currentTarget.contains(event.relatedTarget)) $('#composer').classList.remove('is-dragging');
});
$('#composer').addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  $('#composer').classList.remove('is-dragging');
  const files = Array.from(event.dataTransfer.files);
  const images = files.filter((file) => file.type.startsWith('image/'));
  const documents = files.filter((file) => !file.type.startsWith('image/'));
  if (images.length) addAttachments(images, 'image');
  if (documents.length) addAttachments(documents, 'document');
});
$('#new-chat').addEventListener('click', () => {
  if (!historyMutationBusy) void newConversation().catch(error => toast(error.message || '新建对话失败。', 'error'));
});
$('#setup-required').addEventListener('click', async (event) => {
  if (!event.target.closest('button')) return;
  const setup = $('#setup-required');
  if (setup.dataset.storageAction !== 'reauthorize') {
    chrome.runtime.openOptionsPage();
    return;
  }
  const button = event.target.closest('button');
  button.disabled = true;
  button.textContent = '授权中…';
  try {
    const restored = await restoreConversationDirectory();
    state.storageInfo = await getDirectoryInfo();
    if (!restored || !state.storageInfo.granted) {
      toast('没有获得本地文件夹权限，请稍后重试，或去设置重新选择文件夹。', 'error');
      return;
    }
    renderStorageBadge();
    renderLocalPrompt();
    try {
      await migrateLegacyConversations();
    } catch {
      // History refresh still works even if legacy migration is unavailable.
    }
    await refreshHistory();
    renderConversation();
    toast(`已恢复“${state.storageInfo.name || '本地文件夹'}”的读写权限。`);
  } finally {
    button.disabled = false;
    if (!state.storageInfo?.granted) {
      renderLocalPrompt();
    }
  }
});
$('#context-meter-button').addEventListener('click', (event) => {
  event.stopPropagation();
  setContextPanel($('#context-popover').hidden);
});
$('#save-conversation').addEventListener('click', async () => {
  if (historyMutationBusy) { toast('正在整理历史对话，请稍后保存。'); return; }
  if (!state.conversation || state.conversation.storage === 'local') return;
  let storage = await getDirectoryInfo();
  if (!storage.granted && storage.configured) {
    renderLocalPrompt();
    toast('本地文件夹权限已失效，请先点击上方的“恢复权限”。', 'error');
    return;
  }
  if (!storage.granted) {
    toast('请先在设置中授权本地文件夹。');
    chrome.runtime.openOptionsPage();
    return;
  }
  const saved = await promoteTemporaryConversation(state.conversation);
  Object.assign(state.conversation, saved);
  renderConversation();
  await refreshHistory();
  toast('对话已保存到本地文件夹。');
});
$('#page-locate')?.addEventListener('click', openSourcePage);
$('#page-locate')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openSourcePage();
  }
});
$('#chat-effort').addEventListener('change', (event) => {
  state.selectedEffort = event.target.value;
});

$('#theme-toggle')?.addEventListener('click', toggleTheme);

$('#model-trigger')?.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleModelDropdown();
});

$('#model-dropdown')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const modelItem = event.target.closest('[data-model-id]');
  if (modelItem) {
    const modelId = modelItem.dataset.modelId;
    const selected = selectModelOption(state.config, modelId);
    if (!selected) return;
    state.selectedModelId = selected.id;
    state.selectedEffort = selectedEffortFor(selected);
    renderModelSwitcher();
    updatePageToolbar();
    updateComposer();
    toggleModelDropdown(false);
    return;
  }

  const effortPill = event.target.closest('[data-effort]');
  if (effortPill) {
    const effortValue = effortPill.dataset.effort;
    state.selectedEffort = effortValue;
    const effortSelect = $('#chat-effort');
    if (effortSelect) {
      effortSelect.value = effortValue;
      effortSelect.dispatchEvent(new Event('change'));
    }
    renderModelSwitcher();
    toggleModelDropdown(false);
    return;
  }

  const settingsBtn = event.target.closest('#dropdown-open-settings');
  if (settingsBtn) {
    toggleModelDropdown(false);
    chrome.runtime.openOptionsPage();
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#model-switcher')) {
    toggleModelDropdown(false);
  }
});

$('#welcome')?.addEventListener('click', async (event) => {
  const chip = event.target.closest('.welcome-chip');
  if (!chip) return;
  event.preventDefault();
  event.stopPropagation();
  if (chip.dataset.action === 'summarize-page') {
    await summarizePage();
    return;
  }
  if (chip.dataset.action === 'focus-input') {
    input.focus();
    input.scrollIntoView({ block: 'nearest' });
    $('#composer').classList.add('is-attention');
    setTimeout(() => $('#composer').classList.remove('is-attention'), 900);
    return;
  }
  const topic = chip.dataset.topicId
    ? welcomePromptsFor(state.activePageSignal || {}).topics.find(item => item.id === chip.dataset.topicId)
    : null;
  const prompt = topic?.prompt || chip.dataset.prompt;
  if (prompt) {
    pastedText.setValue(prompt);
    state.draft = prompt;
    state.draftSource = normalizeDraftSource(topic?.draftSource);
    if (state.draftSource) {
      agentSlot?.setMode(false);
      clearPageSelection();
    }
    state.directModelRequest = '';
    resizeInput();
    updateComposer();
    input.focus();
  }
});

$('#queue-recall')?.addEventListener('click', recallQueueItem);


const composerPageToggle = $('#composer-page-toggle');
const composerPagePill = $('#composer-page-pill');
if (composerPageToggle) {
  composerPageToggle.addEventListener('change', () => {
    setPageMode(composerPageToggle.checked);
  });
}
$('#composer-page-choice')?.addEventListener('click', event => {
  const action = event.target.closest('[data-page-choice]')?.dataset.pageChoice;
  if (action === 'page' || action === 'plain') void pageQuestionChoice.choose(action === 'page');
});
// Global outside-click and ESC listeners for sources popover (auto-close)
document.addEventListener('click', (event) => {
  if (event.target.closest('.message-sources')) return;
  const openSources = document.querySelectorAll('.message-sources.is-open');
  for (const wrap of openSources) {
    const popover = wrap.querySelector('.sources-popover');
    const toggle = wrap.querySelector('[data-action="toggle-sources"]');
    if (popover) popover.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('is-open');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const openSources = document.querySelectorAll('.message-sources.is-open');
    for (const wrap of openSources) {
      const popover = wrap.querySelector('.sources-popover');
      const toggle = wrap.querySelector('[data-action="toggle-sources"]');
      if (popover) popover.hidden = true;
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('is-open');
    }
  }
});

$('#page-refresh')?.addEventListener('click', switchToActivePage);
$('#clear-selection').addEventListener('click', clearPageSelection);
$('#open-settings').addEventListener('click', () => {
  toggleModelDropdown(false);
  chrome.runtime.openOptionsPage();
});
$('#open-history').addEventListener('click', async () => {
  setHistoryOpen(true);
  try {
    await refreshHistory();
    historySidebar.restoreUndo(await getLatestConversationDeletion());
  } catch (error) { toast(error.message || '读取历史失败，请重试。', 'error'); }
});
$('#close-history').addEventListener('click', () => historyLayout.setOpen(false));
$('#drawer-backdrop').addEventListener('click', () => historyLayout.setOpen(false));

const historySearchInput = $('#history-search-input');
const historySearchClear = $('#history-search-clear');
if (historySearchInput) {
  historySearchInput.addEventListener('input', () => {
    state.historySearchQuery = historySearchInput.value;
    if (historySearchClear) historySearchClear.hidden = !historySearchInput.value;
    renderHistoryList();
  });
}
if (historySearchClear && historySearchInput) {
  historySearchClear.addEventListener('click', () => {
    historySearchInput.value = '';
    state.historySearchQuery = '';
    historySearchClear.hidden = true;
    historySearchInput.focus();
    renderHistoryList();
  });
}
historyDrawer.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const focusable = [...historyDrawer.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
    .filter(node => !node.hidden && node.getClientRects().length);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
$('#scroll-latest button').addEventListener('click', () => scrollToLatest(true));

conversationView.addEventListener('scroll', () => {
  if (Date.now() < Number(conversationView.dataset.scrollRestoringUntil || 0)) return;
  const atBottom = conversationView.scrollHeight - conversationView.scrollTop - conversationView.clientHeight < 65;
  state.followToPage = atBottom;
  updateLatestVisibility();
});

conversationView.addEventListener('wheel', (event) => {
  if (event.deltaY < 0 && conversationView.scrollHeight > conversationView.clientHeight + 1) state.followToPage = false;
  updateLatestVisibility();
}, { passive: true });
conversationView.addEventListener('touchmove', () => { state.followToPage = false; }, { passive: true });

messagesElement.addEventListener('click', async (event) => {
  const tryNextChip = event.target.closest('.try-next-chip');
  if (tryNextChip && tryNextChip.dataset.suggestion) {
    event.preventDefault();
    if (historyMutationBusy) { toast('正在整理历史对话，请稍后重试。'); return; }
    if (agentSlot?.isBusy()) return;
    const sourceArticle = tryNextChip.closest('[data-message-id]');
    const sourceAssistant = find(state.conversation?.messages, (message) => message.id === sourceArticle?.dataset.messageId);
    const sourceIndex = state.conversation?.messages?.indexOf(sourceAssistant) ?? -1;
    const sourceQuestion = sourceIndex > 0 ? state.conversation.messages[sourceIndex - 1] : null;
    if (sourceAssistant && sourceQuestion?.role === 'user' && samePrompt(tryNextChip.dataset.suggestion, sourceQuestion.displayContent || sourceQuestion.content || '')) {
      await regenerate(sourceAssistant.id);
      return;
    }
    state.directReplaceReply = true;
    pastedText.setValue(tryNextChip.dataset.suggestion);
    state.draftSource = null;
    resizeInput();
    await sendMessage();
    return;
  }
  const button = event.target.closest('[data-action]');
  const agentButton = event.target.closest('[data-agent-action]');
  if (agentButton) {
    const action = agentButton.dataset.agentAction;
    if (historyMutationBusy && action !== 'stop') { toast('正在整理历史对话，请稍后继续任务。'); return; }
    const taskId = agentButton.closest('[data-agent-task]')?.dataset.agentTask;
    if (!taskId || taskId !== agentSlot.getTask()?.id) {
      toast('这不是当前浏览器任务，请使用当前任务的操作按钮。');
      return;
    }
    if (action === 'resume') await agentSlot.resume();
    if (action === 'stop') await agentSlot.stop('user');
    return;
  }
  if (!button) return;
  const messageElement = button.closest('[data-message-id]');
  if (!messageElement) return;
  const id = messageElement.dataset.messageId;
  const message = find(state.conversation?.messages, (item) => item.id === id);
  if (!message) return;
  if (button.dataset.action === 'export-diagnostics') {
    if (diagnosticExportBusy) return;
    button.disabled = true;
    try { await exportConversationDiagnostics(state.conversation.id, id); }
    finally { button.disabled = false; }
    return;
  }
  if (button.dataset.action === 'restart-agent') {
    await agentTaskRestart.restart(id);
    return;
  }
  if (button.dataset.action === 'toggle-error') {
    const keyboardFocus = event.detail === 0 && document.activeElement === button;
    message.errorExpanded = !message.errorExpanded;
    state.followToPage = false;
    updateStreamingMessage(message.id);
    if (keyboardFocus) messagesElement.querySelector(`[data-message-id="${CSS.escape(message.id)}"] [data-action="toggle-error"]`)?.focus({ preventScroll: true });
    updateLatestVisibility();
    return;
  }
  if (button.dataset.action === 'toggle-thinking') {
    const block = button.closest('.thinking-block');
    const thoughtContent = block?.querySelector('.thinking-content');
    if (!thoughtContent) return;
    const willOpen = thoughtContent.hidden;
    thoughtContent.hidden = !willOpen;
    message.userToggledThinking = true;
    message.thinkingExpanded = willOpen;
    if (willOpen) state.followToPage = false;
    updateLatestVisibility();
    button.setAttribute('aria-expanded', String(willOpen));
    button.classList.toggle('is-open', willOpen);
    return;
  }
  if (button.dataset.action === 'copy-user') {
    const textToCopy = message.displayContent || message.content || '';
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      toast('复制失败，请手动选择文字。', 'error');
      return;
    }
    button.innerHTML = icon('check');
    toast('提问内容已复制');
    setTimeout(() => { button.innerHTML = icon('copy'); }, 1600);
    return;
  }
  if (button.dataset.action === 'rewind') {
    const conversation = state.conversation;
    try {
      const result = await messageRewind.rewind(id);
      if (!result.ok) { if (result.message) toast(result.message); return; }
      if (result.current) toast('已回退到该提问，附件已恢复，可重新编辑');
    } catch (error) {
      if (state.conversation === conversation) toast(error.message || '草稿已恢复，但回退保存失败，请保留当前侧栏并重试保存。', 'error');
    }
    return;
  }
  if (button.dataset.action === 'toggle-sources') {
    const wrap = button.closest('.message-sources');
    const popover = wrap?.querySelector('.sources-popover');
    if (popover) {
      const isHidden = popover.hidden;
      popover.hidden = !isHidden;
      button.setAttribute('aria-expanded', String(isHidden));
      wrap.classList.toggle('is-open', isHidden);
    }
    return;
  }
  if (button.dataset.action === 'copy') {
    messageCopy.open({ button, message, conversationId: state.conversation?.id });
    return;
  } else if (button.dataset.action === 'regenerate' || button.dataset.action === 'retry') {
    await regenerate(id);
  }
});

for (const dialog of document.querySelectorAll('dialog')) {
  if (dialog.classList.contains('ho-dialog')) continue;
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    toggleModelDropdown(false);
    if (historyLayout.isOpen() && !historyLayout.isDocked()) historyLayout.setOpen(false);
  }
});
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.theme) {
    applyTheme(changes.theme.newValue || 'light');
  }
  if (area === 'local' && changes.storageDirectoryMeta) {
    getDirectoryInfo().then((info) => {
      const wasGranted = Boolean(state.storageInfo?.granted);
      state.storageInfo = info;
      renderStorageBadge();
      renderLocalPrompt();
      if (info.granted) {
        void retryPendingConversationWrites().then((result) => {
          const sync = result.conversations.find(item => item.id === state.conversation?.id);
          if (sync) { Object.assign(state.conversation, sync); renderStorageBadge(); }
          return refreshHistory();
        });
      }
    }).catch(() => {});
  }
  if (area === 'local' && changes.providerConfig) {
    state.config = normalizeProviderConfig(changes.providerConfig.newValue);
    state.selectedModelId = state.config?.selectedModelId || state.config?.models?.[0]?.id || '';
    state.selectedEffort = state.config?.selectedEffort || state.config?.models?.[0]?.reasoningDefaultEffort || 'default';
    renderModelSwitcher();
    updatePageToolbar();
    updateComposer();
    state.contextUsage = null;
    refreshContextUsage();
  }
  if (area === 'session' && Object.prototype.hasOwnProperty.call(changes, 'pageSelection')) {
    setPageSelection(changes.pageSelection.newValue);
  }
  if (area === 'session' && Object.prototype.hasOwnProperty.call(changes, 'pageFigurePick')) {
    if (changes.pageFigurePick.newValue) {
      const pick = changes.pageFigurePick.newValue;
      chrome.storage.session.remove('pageFigurePick').catch(() => {});
      captureFigurePick(pick);
    }
  }
});
const startupController = new AbortController();
window.addEventListener('pagehide', () => {
  if (typeof articleSelectionMenu !== 'undefined') articleSelectionMenu.dispose();
  if (typeof articleQuoteView !== 'undefined') articleQuoteView.dispose();
  if (typeof selectionChats !== 'undefined') {
    selectionChatsDisposed = true;
    selectionChatSessions?.dispose();
    for (const chat of [...selectionChats]) chat.close({ restoreFocus: false });
  }
  imagePreview.dispose();
  textPreview.dispose();
  pastedText.dispose();
  if (typeof sourceIcons !== 'undefined') sourceIcons.dispose();
  conversationExportMenu.dispose();
  diagnosticExporter.dispose();
  removeRuntimeDiagnostics();
  void flushDiagnostics();
  readingControls.dispose();
  enhancePageReading.dispose();
  networkReadingClient.dispose();
  if (typeof historyNavigation !== 'undefined') historyNavigation.dispose();
  if (typeof historyLayout !== 'undefined') historyLayout.dispose();
  if (typeof historySidebar !== 'undefined') historySidebar?.dispose();
  if (typeof conversationOrganization !== 'undefined') conversationOrganization.dispose();
  if (typeof messageCopy !== 'undefined') messageCopy.dispose();
  if (typeof conversationExport !== 'undefined') conversationExport.dispose();
  if (typeof visualPreparation !== 'undefined') visualPreparation.cancel();
  startupController.abort();
  application.dispose();
  void composition.dispose();
  state.controller?.abort();
  state.submissionController?.abort();
  state.compressionController?.abort();
  clearInterval(state.selectionPoll);
  clearInterval(state.progressTimer);
  conversationSaver.flush();
  if (typeof turnNavigator !== 'undefined') turnNavigator.dispose();
  if (state.conversation && state.activeAssistantId) {
    const streaming = find(state.conversation.messages, (message) => message.id === state.activeAssistantId);
    if (streaming?.status === 'streaming') streaming.status = 'stopped';
    state.conversation.updatedAt = now();
    const snapshot = structuredClone(state.conversation);
    state.saveQueue = state.saveQueue.catch(() => {}).then(() => saveConversationByStorage(snapshot)).catch(() => {});
  }
});

async function initialize() {
  const deadline = Date.now() + 30000;
  const waitStartup = (pending, label) => awaitWithTimeout(pending, {
    signal: startupController.signal, timeoutMs: Math.max(1, deadline - Date.now()), message: `${label}超时，请重新打开侧栏。`,
  });
  try {
    if (!globalThis.chrome?.storage?.session) {
      state.ready = true;
      renderWelcomePrompts();
      renderConversation();
      return;
    }
    // Keep the preference separate from availability; unreadable tabs cannot reset it.
    state.pageContextPreference = true;
    state.disablePageContext = true;
    if (composerPageToggle) composerPageToggle.checked = false;
    await waitStartup(initializeConversationSync(), '初始化会话同步');
    const session = await waitStartup(chrome.storage.session.get('pageSelection'), '读取选区');
    setPageSelection(session?.pageSelection);
    state.storageInfo = await waitStartup(getDirectoryInfo(), '读取文件夹状态');
    if (state.storageInfo.granted) await waitStartup(migrateLegacyConversations(), '兼容旧会话');
    const config = await waitStartup(getProviderConfig(), '读取模型配置');
    const conversations = await waitStartup(listSavedConversations(), '读取会话目录');
    state.config = config;
    state.conversations = conversations;
    state.conversation = await waitStartup(loadTemporaryConversation(), '读取临时会话');
    if (state.conversation?.messages?.some((message) => message.status === 'streaming')) {
      state.conversation.messages.forEach((message) => {
        settleInterruptedReply(message, { aborted: true });
      });
      await waitStartup(saveCurrent(), '保存恢复后的会话');
    }
    if (!state.conversation && conversations.length) {
      state.conversation = await waitStartup(loadConversation(conversations[0].id), '恢复会话');
      if (state.conversation?.messages.some((message) => message.status === 'streaming')) {
        state.conversation.messages.forEach((message) => {
          settleInterruptedReply(message, { aborted: true });
        });
        await waitStartup(saveCurrent(), '保存恢复后的会话');
      }
    }
    await initTheme(startupController.signal);
    state.ready = true;
    renderWelcomePrompts();
    renderConversation();
    startSelectionSync();
    watchSelectionInteractions();
    await waitStartup(refreshHistory(), '刷新会话目录');
    if (state.conversation?.messages) {
      const normalized = normalizeDuplicateRetryTurns(state.conversation.messages);
      if (normalized.length !== state.conversation.messages.length) { state.conversation.messages = normalized; scheduleSave(); }
    }
    await waitStartup(agentSlot.restore(), '恢复浏览器任务');
    const normalizedCfg = normalizeProviderConfig(state.config);
    if (state.storageInfo.configured && !state.storageInfo.granted) {
      toast('本地文件夹权限已失效，请点击上方“恢复权限”。');
    } else if (!normalizedCfg?.models?.length) {
      toast('请先配置并启用一个模型。');
    }
  } catch (error) {
    if (startupController.signal.aborted) return;
    toast(`初始化失败：${error.message}`, 'error');
    input.placeholder = '本地存储不可用，请检查扩展权限';
  }
}

function startSelectionSync() {
  clearInterval(state.selectionPoll);
  const syncCurrentTab = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      syncActivePageSignal(tab);
      updatePageToolbar();
    } catch {}
  };
  chrome.tabs?.onActivated?.addListener(() => { void syncCurrentTab(); });
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
      pageReadState.invalidate(tabId);
      if (tabId === state.activePageSignal?.tabId) pageQuestionChoice.clear();
    }
    if (tabId === state.activePageSignal?.tabId && (changeInfo.url || changeInfo.status === 'loading')) visualPreparation.cancel();
    if (tab?.active && (changeInfo.url || changeInfo.title || changeInfo.favIconUrl || changeInfo.status === 'complete')) {
      syncActivePageSignal(tab);
      updatePageToolbar();
    }
  });
  window.addEventListener('focus', () => { void syncCurrentTab(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncCurrentTab();
  });
  void syncCurrentTab();

  state.selectionPoll = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      syncActivePageSignal(tab);
      updatePageToolbar();
      if (!tab?.id || !/^https?:/i.test(tab.url || '')) return;
      const result = await chrome.runtime.sendMessage({ type: 'GET_PAGE_SELECTION', tabId: tab.id });
      const selection = result?.selection || null;
      if (!selection) {
        if (state.pageSelection) {
          const stable = (value) => String(value || '').replace(/#.*$/, '');
          if (stable(state.pageSelection.url) !== stable(tab.url)) return;
        }
        setPageSelection(null);
        return;
      }
      setPageSelection(selection);
    } catch {
      // A transient worker restart is not proof that the selection is gone.
      // Keep the last good selection; the next user interaction retries.
    }
  }, 700);
}

function watchSelectionInteractions() {
  const resync = () => setTimeout(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:/i.test(tab.url || '')) return;
      const result = await chrome.runtime.sendMessage({ type: 'GET_PAGE_SELECTION', tabId: tab.id });
      setPageSelection(result?.selection || null);
    } catch {
      // Keep the last good capture if the tab is mid-navigation.
    }
  }, 140);
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#composer') && !event.target.closest('#model-switcher')) resync();
  }, true);
  window.addEventListener('focus', resync, true);
}

initialize();

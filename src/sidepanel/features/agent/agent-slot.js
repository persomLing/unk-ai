import { $, escapeHtml, toast } from '../../core/dom.js';
import { icon } from '../../icons.js';
import {
  AGENT_ACTIONS,
  actionSignature,
  actionLabel,
  agentToolDefinitions,
  buildAgentMessages,
  fitAgentMessagesToBudget,
  findElement,
  normalizeAgentAction,
  parseJsonAction,
} from '../../../utils/agent-schema.js';
import { assessAgentAction } from '../../../utils/agent-safety.js';
import {
  agentPageError,
  clearTaskGrants,
  getAgentSettings,
  getOriginGrant,
  grantOrigin,
  originOf,
  saveAgentSettings,
} from '../../../utils/agent-permissions.js';
import { createModelGateway } from '../../../app/model-gateway.js';
import { awaitWithAbort, awaitWithTimeout } from '../../../utils/abortable.js';
import { normalizeAgentReferenceImages, assertAgentReferenceTarget, assertAgentVision } from '../../../utils/agent-reference-images.js';
import { estimateMessagesTokens } from '../../../utils/context.js';
import { mergeRegionReadings, summarizeRegionReadings, regionReadingSources } from '../../../utils/agent-region-data.js';
import { agentReadingSources, boundedPageReadings, observationFeedback, assessChapterCompletion } from '../../../utils/agent-evidence.js';
import { createAgentDiagnosticReporter, agentDiagnosticError } from '../../../utils/agent-diagnostics.js';
import { agentDiagnosticFingerprint } from '../../../utils/agent-diagnostic-fields.js';
import { agentTargetKey, verifyAgentAction, verifyAgentState, needsAgentPlan, agentRecoveryProfile,
  canVerifyConsumedAgentUpload, verifyAgentUploadAcceptance } from './action-verification.js';
import { compactAgentPageReadings, compactAgentRegionData, sameAgentReadingContent, agentDecisionInputMetrics } from './decision-context.js';
import { createAgentVisualObservation, selectAgentVisualTarget } from './visual-observation.js';
import {
  createTaskProgress, taskProgressScope, setTaskProgressTarget, updateTaskPlan, hasTaskExecutionOutcome,
  recordTaskDecision, recordTaskOutcome, recordTaskEvidence, assessTaskProgress,
  assessTaskCompletion, taskProgressContext, taskProgressCheckpoint, restoreTaskProgress,
} from './task-progress.js';
import {
  agentTurnForMessage,
  agentFailureForMessage,
  appendAgentStep,
  createAgentTurn,
  fallbackAgentSummary,
  finishAgentTurn,
} from '../../../utils/agent-conversation.js';

const STEP_ICONS = {
  observe: 'eye',
  decide: 'sparkles',
  action: 'globe',
  result: 'check',
  approval: 'shield',
  warning: 'lock',
  error: 'info',
  info: 'info',
};
const MAX_LOG_STEPS = 60;
const MAX_RECENT = 5;
const REPEAT_LIMIT = 3;
const MODEL_TIMEOUT = 60000;
const TASK_KEY = 'agentTask';
const AUDIT_KEY = 'agentAudit';
const PAGE_MODE_REQUIRED = '请先开启“基于当前页”，再使用页面操作。';
const PAGE_MODE_DISABLED = '已关闭“基于当前页”，页面操作已停止。';
const DEFAULT_TIMEOUTS = Object.freeze({ preparation: 15000, observe: 30000, action: 30000, cleanup: 1500, evidence: 3000, model: MODEL_TIMEOUT });
const VISUAL_INTERRUPTION_ERRORS = new Set(['ERR_PAGE_CHANGED', 'ERR_ORIGIN_NOT_ALLOWED', 'ERR_CONTROL_DISABLED',
  'ERR_TASK_CANCELLED', 'ERR_TASK_PAUSED', 'ERR_TAB_NOT_FOUND', 'ERR_PAGE_RESTRICTED']);
const PHASE_LABELS = { locate: '正在定位页面', settings: '正在读取控制设置', saving: '正在保存任务', permission: '正在核对站点授权', authorizing: '正在保存站点授权', activate: '正在启动页面控制', observe: '正在读取页面', read: '正在读取页面正文', think: '模型思考中', wait: '等待你确认', act: '正在执行页面动作', idle: '运行中' };

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${random}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timeLabel(value) {
  try {
    return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function isBusyStatus(status) {
  return ['preparing', 'running', 'paused'].includes(status);
}

/**
 * Browser-agent slot. The side panel owns the decision loop; the background
 * owns page observation, DOM execution and deterministic permission checks.
 */
export function createAgentSlot({
  sendMessage,
  queryActiveTab,
  getProfile,
  getPageModeEnabled = () => false,
  restoreTurn = null,
  beginTurn = null,
  updateTurn = null,
  endTurn = null,
  focusInput = () => $('#message-input')?.focus(),
  onStateChange = () => {},
  recordDiagnostic = () => {},
  getDiagnosticContext = () => ({}),
  captureEvidence = true,
  cropVisualImage,
  timeouts = {},
  modelGateway = createModelGateway(),
  signal: lifetimeSignal,
  onCleanup,
} = {}) {
  lifetimeSignal?.throwIfAborted();
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const panel = $('#agent-panel');
  const toggle = $('#agent-toggle');
  const goalElement = $('#agent-goal');
  const originElement = $('#agent-origin');
  const statusElement = $('#agent-status');
  const stepsElement = $('#agent-steps');
  const interaction = $('#agent-interaction');
  const stopButton = $('#agent-stop');
  const takeoverButton = $('#agent-takeover');
  const closeButton = $('#agent-close');

  const state = {
    mode: false,
    task: null,
    running: false,
    cancelled: false,
    resumeRequested: false,
    controller: null,
    pendingInteraction: null,
    turn: null,
    watchdog: null,
    loopNudged: false,
    interruption: Promise.resolve(),
    owner: null,
    loopOwner: null,
  };

  const modelProfiles = new WeakMap();
  const listeners = new Set();
  const interactionListeners = new Set();
  let disposed = false;
  let disposal = null;

  function captureDiagnosticContext(task, owner) {
    try {
      const context = getDiagnosticContext(task.id) || {};
      owner.diagnosticContext = { conversationId: context.conversationId, turnId: context.turnId };
    } catch { owner.diagnosticContext = {}; }
  }

  function diagnosticContext(task, owner) {
    return { ...owner?.diagnosticContext, taskId: task.id, runId: owner?.runId, tabId: task.tabId };
  }

  function diagnose(task, owner, event, data = {}, error = null, extra = {}) {
    createAgentDiagnosticReporter(recordDiagnostic, 'agent', diagnosticContext(task, owner))(event,
      { step: task.step, maxSteps: task.maxSteps, hardMaxSteps: task.settings?.maxSteps, ...data }, error, extra);
  }

  function assertActive() {
    if (disposed) throw new DOMException('页面操作能力已释放。', 'AbortError');
    lifetimeSignal?.throwIfAborted();
  }

  function registerRemoval(remove) {
    const cleanup = () => {
      if (!listeners.delete(cleanup)) return;
      interactionListeners.delete(cleanup);
      remove();
    };
    listeners.add(cleanup);
    return cleanup;
  }

  function listenDom(element, type, handler, transient = false) {
    if (!element?.addEventListener) return;
    const listener = (...args) => { if (!disposed && !lifetimeSignal?.aborted) return handler(...args); };
    const remove = registerRemoval(() => element.removeEventListener?.(type, listener));
    if (transient) interactionListeners.add(remove);
    // Register removal first in case a host throws after partially attaching.
    element.addEventListener(type, listener);
  }

  function listenChrome(event, handler) {
    if (!event?.addListener) return;
    const listener = (...args) => { if (!disposed && !lifetimeSignal?.aborted) return handler(...args); };
    registerRemoval(() => event.removeListener?.(listener));
    event.addListener(listener);
  }

  function taskModel(task) {
    let stored = modelProfiles.get(task);
    if (!stored) {
      const profile = getProfile?.();
      if (!profile) throw new Error('请先配置一个可用模型。');
      stored = { profile: structuredClone(profile), epoch: 0 };
      modelProfiles.set(task, stored);
    }
    return stored;
  }

  function startModelRun(task, owner) {
    const stored = taskModel(task);
    owner.modelRun?.dispose();
    owner.runId = `agent:${task.id}:${++stored.epoch}`;
    owner.modelRun = modelGateway.createRun({
      runId: owner.runId, profile: task.recoveryModelProfile || stored.profile,
      signal: owner.controller.signal, ...(task.deadline > 0 ? { deadlineAt: task.deadline } : {}),
    });
    owner.decisionCount = 0;
  }

  function dispose() {
    if (disposed) return disposal;
    disposed = true;
    lifetimeSignal?.removeEventListener('abort', dispose);
    state.owner?.controller.abort();
    state.owner?.modelRun?.dispose();
    state.controller?.abort();
    clearInterval(state.watchdog);
    for (const remove of [...listeners]) { try { remove(); } catch { /* Continue releasing other listeners. */ } }
    clearInteraction(true);
    state.running = false;
    state.cancelled = true;
    state.resumeRequested = false;
    state.loopOwner = null;
    state.mode = false;
    const task = state.task;
    if (task && !['finished', 'failed', 'cancelled'].includes(task.status)) {
      diagnose(task, state.owner, 'agent.task.paused', { errorCount: task.errorCount || 0 }, { code: 'ERR_TASK_PAUSED', reason: 'disposed' });
      task.status = 'paused';
      disposal = interruptExecution('AGENT_PAUSE', task);
      void setPageOverlay(false, '', task);
    }
    hidePanel();
    return disposal;
  }
  onCleanup?.(dispose);
  lifetimeSignal?.addEventListener('abort', dispose, { once: true });

  function assertTask(task, owner = state.owner) {
    assertActive();
    if (!owner || owner !== state.owner || task !== state.task || owner.task !== task) throw new DOMException('任务已被替换', 'AbortError');
    owner.controller.signal.throwIfAborted();
    if (['preparing', 'running'].includes(task.status) && !getPageModeEnabled()) {
      // Recheck the live prerequisite before and after every bounded wait;
      // a late observation or decision must not authorize another page action.
      void stop(PAGE_MODE_DISABLED);
      throw new DOMException(PAGE_MODE_DISABLED, 'AbortError');
    }
  }

  async function waitTask(task, operation, { phase, timeoutMs = limits.preparation, message } = {}) {
    const owner = state.owner;
    assertTask(task, owner);
    if (phase) setPhase(phase, task);
    try {
      const result = await awaitWithTimeout(Promise.resolve().then(() => { assertTask(task, owner); return operation(); }), {
        signal: owner.controller.signal, timeoutMs,
        message: message || `${PHASE_LABELS[phase || task.phase] || '任务准备'}超时，任务已停止，请重试。`,
      });
      assertTask(task, owner);
      return result;
    } catch (error) {
      if (error.name === 'TimeoutError') task.skipSummary = true;
      throw error;
    }
  }

  async function bestEffort(operation, timeoutMs = limits.cleanup) {
    try { return await awaitWithTimeout(Promise.resolve().then(operation), { timeoutMs }); }
    catch { return null; }
  }

  function interruptExecution(type, task = state.task) {
    if (!task?.tabId) return Promise.resolve();
    const request = { type, tabId: task.tabId, taskId: task.id };
    state.interruption = bestEffort(() => sendMessage(request));
    return state.interruption;
  }

  async function activateExecution(task, resume = false) {
    if (!resume && task.startDocumentId) {
      const identity = await waitTask(task, () => sendMessage({ type: 'CAPTURE_PAGE_TARGET', tabId: task.tabId,
        expectedUrl: task.currentUrl, documentId: task.startDocumentId }), { phase: 'activate' });
      if (identity?.error || identity?.documentId !== task.startDocumentId || identity?.url !== task.currentUrl) {
        throw new Error('准备期间页面已刷新或变化，任务未开始。请核对页面后重试。');
      }
    }
    await waitTask(task, () => state.interruption, { phase: 'activate' });
    const response = await waitTask(task, () => sendMessage({ type: resume ? 'AGENT_RESUME' : 'AGENT_START', tabId: task.tabId, taskId: task.id,
      expectedUrl: task.currentUrl, referenceImages: task.referenceImages || [] }), { phase: 'activate' });
    if (response?.error || !response?.ok) throw new Error(response?.message || '无法启动后台执行器。');
    task.uploadReferences = Array.isArray(response.uploadReferences) ? response.uploadReferences : [];
    task.autoApprove = response.autoApprove === true;
    task.actionSequence = Math.max(task.actionSequence || 0,
      Number.isSafeInteger(response.actionSequence) && response.actionSequence >= 0 ? response.actionSequence : 0);
    // Budgets belong to this execution window, just like the frozen model run.
    task.budget = { maxSteps: task.settings.maxSteps, maxMinutes: task.settings.maxMinutes };
  }

  function armWatchdog() {
    clearInterval(state.watchdog);
    state.watchdog = setInterval(() => {
      const task = state.task;
      if (!task || !isBusyStatus(task.status)) return;
      const exceeded = Number(task.deadline) > 0 && Date.now() > Number(task.deadline);
      renderStatus();
      if (exceeded && task.status === 'running' && task.phase !== 'wait') {
        task.skipSummary = true;
        void finishTask('任务超过时间上限，已自动停止。', 'failed');
      }
    }, 1000);
  }

  function taskBusy() {
    return Boolean(state.running || (state.task && ['preparing', 'running'].includes(state.task.status)));
  }

  function setMode(value, { silent = false } = {}) {
    assertActive();
    if (value && !getPageModeEnabled()) { toast(PAGE_MODE_REQUIRED); return false; }
    if (value && taskBusy()) return false;
    if (!value && state.task && isBusyStatus(state.task.status)) return false;
    state.mode = value;
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(value));
      toggle.setAttribute('aria-label', value ? '关闭页面操作' : '页面操作');
      toggle.title = value ? '关闭页面操作' : '页面操作';
    }
    if (!value) {
      hidePanel();
      if (state.task && !taskBusy() && !state.running) state.task = null;
    }
    if (!silent) onStateChange();
    return true;
  }

  function toggleMode() {
    if (taskBusy()) return;
    const next = !state.mode;
    if (!setMode(next)) return;
    if (next) {
      toast('页面操作已开启：描述要在当前页面完成的任务。');
      focusInput();
    }
  }

  function showPanel() {
    if (panel) panel.hidden = false;
  }

  function hidePanel() {
    if (panel) panel.hidden = true;
    clearInteraction();
  }

  function setPhase(phase, task = state.task) {
    if (!task || state.task !== task) return;
    if (task.phase !== phase || !task.phaseStartedAt) task.phaseStartedAt = Date.now();
    task.phase = phase;
    renderStatus();
    renderControls();
  }

  function addStep(kind, title, detail = '') {
    if (!state.task) return;
    const step = {
      kind,
      title: String(title || '').slice(0, 220),
      detail: String(detail || '').slice(0, 360),
      at: nowIso(),
      status: 'done',
    };
    state.task.steps.push(step);
    if (state.task.steps.length > MAX_LOG_STEPS) state.task.steps.splice(0, state.task.steps.length - MAX_LOG_STEPS);
    if (state.turn) {
      appendAgentStep(state.turn, step);
      Promise.resolve(updateTurn?.({ ...state.turn }, { signal: state.owner?.controller.signal })).catch(() => {});
    }
    renderSteps();
  }

  function recordTiming(task, owner, phase, startedAt, extra = {}) {
    if (disposed || state.task !== task || state.owner !== owner || owner?.controller.signal.aborted) return;
    const metric = { phase, durationMs: Math.max(0, Math.round(performance.now() - startedAt)), step: task.step };
    for (const key of ['inputTokens', 'elements', 'textChars', 'rows', 'scanMs', 'candidates', 'readMs']) {
      if (Number.isFinite(extra[key])) metric[key] = Math.max(0, Math.round(extra[key]));
    }
    task.metrics = [...(task.metrics || []), metric].slice(-120);
    const label = { observe: '页面观察', model: '模型决策', action: '页面动作', read: '正文读取', region: '区域读取' }[phase];
    const details = [`${metric.durationMs} 毫秒`,
      metric.elements !== undefined ? `${metric.elements} 个元素` : '',
      metric.candidates !== undefined ? `检查 ${metric.candidates} 个候选` : '',
      metric.scanMs !== undefined ? `扫描 ${metric.scanMs} 毫秒` : '',
      metric.inputTokens !== undefined ? `输入约 ${metric.inputTokens} tokens` : '',
      metric.textChars !== undefined ? `${metric.textChars} 字符` : '',
      metric.rows !== undefined ? `${metric.rows} 行` : ''].filter(Boolean).join(' · ');
    addStep('info', `${label}耗时`, details);
  }

  function pushRecent(entry) {
    if (!state.task) return;
    state.task.recent.push({
      id: entry.id || '',
      action: String(entry.action || '').slice(0, 200),
      ok: entry.ok !== false,
      message: String(entry.message || '').slice(0, 260),
      error: String(entry.error || '').slice(0, 100),
      signature: String(entry.signature || ''),
      observedChange: typeof entry.observedChange === 'boolean' ? entry.observedChange : null,
      observationFeedback: String(entry.observationFeedback || '').slice(0, 360),
    });
    if (state.task.recent.length > MAX_RECENT) state.task.recent.splice(0, state.task.recent.length - MAX_RECENT);
  }

  function repeatedAction(action, observation) {
    const recent = state.task?.recent || [];
    const signature = `${observation?.url || ''}|${actionSignature(action.action, action.args, observation?.elements)}`;
    const count = recent.filter((item) => item.signature === signature && item.ok !== false && item.observedChange === false).length;
    return count >= REPEAT_LIMIT - 1;
  }

  function verifyPendingAction(task, observation) {
    const pendingActions = [...(task.pendingVerifications || []), ...(task.pendingAction ? [task.pendingAction] : [])];
    task.pendingAction = null;
    task.pendingVerifications = [];
    for (const pending of pendingActions) {
      const feedback = verifyAgentAction(pending, observation);
      const recent = task.recent.find(item => item.id === pending.id);
      if (recent) {
        recent.observedChange = pending.action === AGENT_ACTIONS.wait ? null : feedback.changed;
        recent.observationFeedback = feedback.message;
      }
      if (pending.lastObservation !== observation) {
        addStep('info', '已核对动作后的页面', feedback.message);
        if (task.progress) recordTaskEvidence(task.progress, { scope: taskProgressScope(task.progress), actionId: pending.id,
          kind: 'action', verified: feedback.verified, changed: feedback.changed === true, snapshotId: observation.snapshotId });
        diagnose(task, state.owner, feedback.verified ? 'agent.verify.completed' : 'agent.verify.failed',
          { action: pending.action, verified: feedback.verified, observedChange: feedback.changed === true },
          feedback.verified ? null : { code: 'ERR_ACTION_UNVERIFIED', reason: 'check' }, { actionId: pending.id, snapshotId: observation.snapshotId });
      }
      if (!feedback.verified && pending.needsVerification && pending.observation.url === observation.url
        && (!pending.observation.documentId || pending.observation.documentId === observation.documentId)) {
        pending.lastObservation = observation;
        task.pendingVerifications.push(pending);
      }
    }
    task.pendingVerifications = task.pendingVerifications.slice(-40);
  }

  async function verifyConsumedUpload(task, owner, pending) {
    return waitTask(task, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        assertTask(task, owner);
        const after = await observeWithRecovery(task);
        assertTask(task, owner);
        if (!after || after.url !== pending.observation.url || !after.documentId
          || after.documentId !== pending.observation.documentId) return null;
        const prior = findElement(pending.observation.elements, pending.args.elementId);
        const targets = (after.elements || []).filter(element => prior?.stableKey && element.stableKey === prior.stableKey
          && element.frameId === prior.frameId);
        if (targets.length !== 1) return null;
        const result = await sendMessage({ type: 'AGENT_VERIFY_UPLOAD', taskId: task.id, tabId: task.tabId,
          expectedUrl: after.url, snapshotId: after.snapshotId, elementId: targets[0].id,
          uploadActionId: pending.id, referenceId: pending.args.referenceId, diagnosticContext: diagnosticContext(task, owner) });
        assertTask(task, owner);
        if (verifyAgentUploadAcceptance(pending, after, result?.receipt, { taskId: task.id, tabId: task.tabId })) {
          return { observation: after, receipt: result.receipt };
        }
        if (result?.error !== 'ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED') return null;
        if (!attempt) await awaitWithAbort(delay(120), owner.controller.signal);
      }
      return null;
    }, { phase: 'observe', timeoutMs: limits.evidence, message: '参考图片接收核对超时，任务已停止，不会重新上传或继续提交。' });
  }

  async function readPage(task, observation, query) {
    const owner = state.owner;
    const startedAt = performance.now();
    const response = await waitTask(task, () => sendMessage({
      type: 'AGENT_READ_PAGE', taskId: task.id, tabId: task.tabId,
      expectedUrl: observation.url, snapshotId: observation.snapshotId, query,
    }), { phase: 'read', timeoutMs: limits.observe, message: '读取页面正文超时，任务已停止，请检查页面后重试。' });
    recordTiming(task, owner, 'read', startedAt, { textChars: response?.text?.length, readMs: response?.metrics?.readMs });
    if (response?.error) return response;
    if (!response?.ok || typeof response.text !== 'string' || !response.text.trim()) {
      return { error: 'ERR_PAGE_EVIDENCE_EMPTY', message: '没有读取到可用正文，请检查页面或换一个章节关键词。' };
    }
    if (response.url !== observation.url) return { error: 'ERR_PAGE_CHANGED', message: '正文来源与当前观察不同，请核对页面后继续。' };
    const reading = { ...response, query, capturedAt: response.capturedAt || nowIso() };
    const previous = (task.pageReadings || []).find(item => sameAgentReadingContent(item, reading));
    const sources = [...(task.pageReadings || []).filter(item => !sameAgentReadingContent(item, reading)), reading];
    task.pageReadings = boundedPageReadings(sources).map(item => {
      const source = sources.find(value => value.url === item.url && value.query === item.query);
      return { ...item, ...(source?.documentId ? { documentId: source.documentId } : {}) };
    });
    const current = task.pageReadings.find(item => item.url === response.url && item.query === query);
    return { ok: true, reading: current, repeated: Boolean(previous) };
  }

  async function readRegion(task, observation, args) {
    const owner = state.owner;
    const startedAt = performance.now();
    const response = await waitTask(task, () => sendMessage({
      type: 'AGENT_READ_REGION', taskId: task.id, tabId: task.tabId,
      expectedUrl: observation.url, snapshotId: observation.snapshotId,
      elementId: args.elementId, query: args.query,
    }), { phase: 'read', timeoutMs: limits.observe, message: '读取页面区域超时，任务已停止，请核对页面后重试。' });
    recordTiming(task, owner, 'region', startedAt, { rows: response?.regionReading?.rows?.length,
      textChars: response?.regionReading?.text?.length, readMs: response?.metrics?.readMs });
    if (response?.error) return response;
    const reading = response?.regionReading;
    if (!response?.ok || !reading || (!Array.isArray(reading.rows) || (!reading.rows.length && !reading.text?.trim()))) {
      return { error: 'ERR_PAGE_EVIDENCE_EMPTY', message: '没有读取到可用区域数据，请选择包含正文或列表的区域。' };
    }
    if (reading.url !== observation.url) return { error: 'ERR_PAGE_CHANGED', message: '区域来源与当前观察不同，请核对页面后继续。' };
    const previous = task.regionReadings || [];
    const updated = mergeRegionReadings(previous, { ...reading, query: args.query });
    task.regionReadings = updated;
    const current = updated.at(-1);
    const prior = previous.find(item => item.regionKey === current?.regionKey && sameAgentReadingContent(item, current, { region: true }));
    return { ok: true, reading: current, repeated: Boolean(prior) };
  }

  function taskSources(task) {
    const sources = new Map();
    for (const source of [...agentReadingSources(task.pageReadings), ...regionReadingSources(task.regionReadings)]) {
      sources.set(source.url, { ...source, truncated: Boolean(source.truncated || sources.get(source.url)?.truncated) });
    }
    return [...sources.values()];
  }

  function resultWithTaskSources(summary, task) {
    let result = String(summary || '').trim();
    const links = [];
    for (const source of taskSources(task)) {
      if (result.includes(source.url)) continue;
      const title = String(source.title || source.url).slice(0, 100).replace(/[\\[\]]/g, '\\$&');
      const url = source.url.replace(/</g, '%3C').replace(/>/g, '%3E');
      const link = `- [${title}](<${url}>)`;
      if (result.length + links.join('\n').length + link.length + 10 <= 6000) links.push(link);
    }
    return links.length ? `${result}\n\n读取来源：\n${links.join('\n')}` : result;
  }

  function recordObservationFacts(observation) {
    if (!state.task) return;
    const lines = String(observation?.summary || '')
      .split(/\n|；|;/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const useful = lines.filter((line) =>
      /(?:[¥￥$€£]\s?\d|\d+(?:\.\d+)?\s?%|已启用|已禁用|已过期|有效|无效|余额|总量|请求|积分|额度)/.test(line),
    ).slice(0, 8);
    for (const text of useful) {
      const fact = { text, source: observation.url };
      if (state.task.facts.some((item) => item.text === fact.text)) continue;
      state.task.facts.push(fact);
    }
    state.task.facts = state.task.facts.slice(-20);
  }

  function navigationLoop(observation) {
    const history = (state.task?.visitedUrls || []).slice(-6);
    const current = String(observation?.url || '');
    if (!current) return false;
    const repeats = history.filter((url) => url === current).length;
    return repeats >= 3 && new Set(history).size >= 2;
  }

  function renderHeader() {
    if (!state.task) return;
    if (goalElement) {
      goalElement.textContent = state.task.goal;
      goalElement.title = state.task.goal;
    }
    if (originElement) {
      originElement.textContent = state.task.currentOrigin || state.task.origin || '';
    }
  }

  function renderStatus() {
    if (!statusElement || !state.task) return;
    const task = state.task;
    const statusLabels = {
      paused: '已暂停',
      finished: '已完成',
      failed: '已失败',
      cancelled: '已停止',
    };
    const elapsed = Math.max(0, Math.floor((Date.now() - (task.phaseStartedAt || Date.now())) / 1000));
    const label = statusLabels[task.status] || `${PHASE_LABELS[task.phase] || '准备中'}${task.phase !== 'wait' && elapsed ? ` · ${elapsed} 秒` : ''}…`;
    const dot = task.status === 'paused' ? 'paused' : task.status === 'finished' ? 'done' : task.status === 'failed' ? 'failed' : task.phase || 'idle';
    const plan = task.progress ? taskProgressContext(task.progress).plan : [];
    const currentStep = plan.find(item => item.status === 'in_progress');
    statusElement.innerHTML = `
      <span class="agent-status-dot ${escapeHtml(dot)}"></span>
      <span>${escapeHtml(label)}</span>
      <span class="agent-step-count">${task.maxSteps === 0 ? `第 ${task.step} 步 · 步数不限` : `第 ${task.step}/${task.maxSteps} 步`}</span>
      ${plan.length ? `<span class="agent-plan-status" title="${escapeHtml(currentStep?.title || '核对任务结果')}">目标 ${plan.filter(item => item.status === 'completed' && item.verified).length}/${plan.length}</span>` : ''}
      ${task.settings?.strictMode ? '<span class="agent-strict">严格模式</span>' : task.autoApprove && task.settings?.autoApprove ? '<span class="agent-strict">自动批准</span>' : ''}
      ${task.budget?.maxMinutes === 0 ? '<span class="agent-step-count">时长不限</span>' : ''}
    `;
  }

  function renderControls() {
    if (!state.task) {
      if (stopButton) stopButton.hidden = true;
      if (takeoverButton) takeoverButton.hidden = true;
      return;
    }
    const stoppable = ['preparing', 'running', 'paused'].includes(state.task.status);
    if (stopButton) stopButton.hidden = !stoppable;
    if (takeoverButton) {
      takeoverButton.hidden = !stoppable;
      takeoverButton.textContent = state.task.status === 'paused' ? '继续' : '接管';
    }
  }

  function renderSteps() {
    if (!stepsElement) return;
    stepsElement.hidden = true;
    stepsElement.innerHTML = '';
  }

  function render() {
    if (!state.task) return;
    renderHeader();
    renderStatus();
    renderControls();
    renderSteps();
  }

  function clearInteraction(resolvePending = true) {
    for (const remove of [...interactionListeners]) remove();
    if (state.pendingInteraction) {
      const pending = state.pendingInteraction;
      state.pendingInteraction = null;
      if (resolvePending) pending(null);
    }
    if (interaction) {
      interaction.hidden = true;
      interaction.innerHTML = '';
      interaction.className = 'agent-interaction';
    }
  }

  async function setPageOverlay(visible, label = '', task = state.task) {
    if (!task?.tabId) return;
    try {
      await bestEffort(() => sendMessage({
        type: 'AGENT_OVERLAY',
        tabId: task.tabId,
        taskId: task.id,
        visible,
        goal: task.goal,
        label: label || (visible ? 'UNK AI 正在操作页面' : ''),
      }));
    } catch {
      // The overlay is an affordance; execution safety does not depend on it.
    }
  }

  function showInteraction({
    tone = 'info',
    eyebrow = '',
    title,
    body = '',
    meta = [],
    image = '',
    checkbox = '',
    checkboxChecked = false,
    buttons = [],
    focusValue = '',
  }) {
    if (!interaction) return Promise.resolve(null);
    clearInteraction(true);
    interaction.hidden = false;
    interaction.className = `agent-interaction ${tone}`;
    const safeImage = /^data:image\/jpeg;base64,/i.test(String(image || '')) ? String(image) : '';
    interaction.innerHTML = `
      <div class="agent-card-head">
        ${eyebrow ? `<span class="agent-card-eyebrow">${escapeHtml(eyebrow)}</span>` : ''}
        <strong>${escapeHtml(title || '')}</strong>
      </div>
      ${body ? `<p class="agent-card-body">${escapeHtml(body)}</p>` : ''}
      ${meta.length ? `<div class="agent-card-meta">${meta.map((item) => `
        <div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>
      `).join('')}</div>` : ''}
      ${safeImage ? `<img class="agent-card-shot" src="${escapeHtml(safeImage)}" alt="当前页面截图" />` : ''}
      ${checkbox ? `<label class="agent-card-check"><input id="agent-strict-mode" type="checkbox" ${checkboxChecked ? 'checked' : ''} />${escapeHtml(checkbox)}</label>` : ''}
      <div class="agent-card-actions">${buttons.map((button, index) => `
        <button class="agent-button ${escapeHtml(button.kind || 'secondary')}" type="button" data-choice="${index}">${escapeHtml(button.label)}</button>
      `).join('')}</div>
    `;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        for (const remove of [...interactionListeners]) remove();
        state.pendingInteraction = null;
        if (interaction) {
          interaction.hidden = true;
          interaction.innerHTML = '';
        }
        resolve(value);
      };
      state.pendingInteraction = done;
      interaction.querySelectorAll('[data-choice]').forEach((button) => {
        listenDom(button, 'click', () => {
          const choice = buttons[Number(button.dataset.choice)];
          const strict = checkbox ? Boolean(interaction.querySelector('#agent-strict-mode')?.checked) : undefined;
          done(checkbox ? { choice: choice?.value, strictMode: strict } : choice?.value);
        }, true);
      });
      if (focusValue) {
        const target = [...interaction.querySelectorAll('[data-choice]')]
          .find((button) => buttons[Number(button.dataset.choice)]?.value === focusValue);
        target?.focus();
      }
    });
  }

  async function evidenceShot(task = state.task) {
    if (!captureEvidence || !task) return '';
    try {
      const response = await awaitWithTimeout(sendMessage({
        type: 'AGENT_CAPTURE',
        tabId: task.tabId,
        taskId: task.id,
      }), { signal: state.owner?.controller.signal, timeoutMs: limits.evidence });
      return /^data:image\/jpeg;base64,/i.test(response?.dataUrl || '') ? response.dataUrl : '';
    } catch {
      return '';
    }
  }

  async function ensureControlEnabled(task) {
    const owner = state.owner;
    let settings = await waitTask(task, () => getAgentSettings(), { phase: 'settings' });
    if (settings.enabled) {
      task.settings = settings;
      return true;
    }
    setPhase('wait', task);
    const value = await showInteraction({
      tone: 'info',
      eyebrow: 'PERMISSION',
      title: '开启浏览器控制？',
      body: settings.autoApprove
        ? '你已在设置中选择自动批准：授权站点内的提交、删除、上传等操作会直接执行。新站点仍需授权，随时可以停止或接管。'
        : 'UNK AI 可以读取当前网页、点击和输入。提交、删除、上传等风险动作会逐次询问，随时可以停止或接管。',
      checkbox: '严格模式：点击、输入、选择和导航等动作都需确认',
      checkboxChecked: settings.strictMode,
      buttons: [
        { label: '开启并继续', value: 'enable', kind: 'primary' },
        { label: '取消', value: 'cancel' },
      ],
      focusValue: 'cancel',
    });
    assertTask(task, owner);
    if (!value || value.choice !== 'enable') return false;
    settings = await waitTask(task, () => saveAgentSettings({ enabled: true, strictMode: Boolean(value.strictMode),
      autoApprove: settings.autoApprove && !value.strictMode }), { phase: 'authorizing' });
    task.settings = settings;
    addStep('info', '已开启浏览器控制', settings.strictMode ? '严格模式已开启' : settings.autoApprove ? '自动批准已开启：授权站点内风险动作直接执行' : '风险动作需要确认');
    return true;
  }

  async function ensureOrigin(task, origin, reason = '') {
    const owner = state.owner;
    if (!origin) return false;
    const existing = await waitTask(task, () => getOriginGrant(origin, task.id), { phase: 'permission' });
    if (existing) return true;
    setPhase('wait', task);
    const value = await showInteraction({
      tone: 'info',
      eyebrow: 'SITE PERMISSION',
      title: `允许控制 ${origin}？`,
      body: reason || '只在这个站点执行任务。UNK AI 可以读取页面、点击和输入；随时可以停止或接管。',
      meta: [
        { label: '站点', value: origin },
        { label: '范围', value: '仅当前任务或始终允许，可随时撤销' },
      ],
      buttons: [
        { label: '仅本次任务', value: 'task', kind: 'primary' },
        { label: '始终允许', value: 'always' },
        { label: '拒绝', value: 'deny' },
      ],
      focusValue: 'deny',
    });
    assertTask(task, owner);
    if (!value || value === 'deny') return false;
    try {
      await waitTask(task, () => grantOrigin(origin, { scope: value, taskId: task.id }), { phase: 'authorizing' });
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
      toast(error.message || '无法保存站点授权。', 'error');
      return false;
    }
    addStep('info', `已授权 ${origin}`, value === 'always' ? '始终允许' : '仅本次任务');
    return true;
  }

  async function askApproval({ action, args, observation, assessment }) {
    const task = state.task;
    const owner = state.owner;
    const target = findElement(observation.elements, args.elementId);
    const image = await evidenceShot(task);
    assertTask(task, owner);
    const label = actionLabel(action, args, observation.elements);
    const value = await showInteraction({
      tone: 'warning',
      eyebrow: 'CONFIRMATION',
      title: '这个动作需要你确认',
      body: assessment.reason || '这个动作会改变页面，需要你确认后才能执行。',
      meta: [
        { label: '动作', value: label },
        { label: '目标', value: target?.name || target?.text || args.url || '当前页面' },
        { label: '站点', value: originOf(observation.url) || state.task.origin },
      ],
      image,
      buttons: [
        { label: '允许一次', value: 'approve', kind: 'primary' },
        { label: '取消', value: 'cancel' },
      ],
      focusValue: 'cancel',
    });
    assertTask(task, owner);
    return value === 'approve';
  }

  function pauseTask(reason, { handoff = false } = {}) {
    if (!state.task || ['finished', 'failed', 'cancelled'].includes(state.task.status)) return;
    const task = state.task;
    diagnose(task, state.owner, 'agent.task.paused', { errorCount: task.errorCount || 0, phase: task.phase }, { code: 'ERR_TASK_PAUSED', reason: handoff ? 'handoff' : 'paused' });
    state.task.status = 'paused';
    state.owner?.controller.abort();
    state.owner?.modelRun?.dispose();
    void interruptExecution('AGENT_PAUSE');
    state.task.pauseReason = reason || '任务已暂停。';
    state.resumeRequested = false;
    state.controller?.abort();
    state.controller = null;
    task.visualEvidence = null;
    if (state.pendingInteraction) state.pendingInteraction(null);
    addStep('warning', handoff ? '需要你接管' : '任务已暂停', reason || '');
    if (handoff) {
      addStep('info', '已切换到人工操作', '点击“继续任务”后会重新观察页面，不会重放刚才的动作。');
    }
    void setPageOverlay(false);
    saveCheckpoint();
    render();
    onStateChange();
    if (handoff) return;
    showInteraction({
      tone: 'info',
      eyebrow: 'PAUSED',
      title: '任务已暂停',
      body: reason || '你可以继续在原页面操作，准备好后点击继续。',
      buttons: [
        { label: '继续任务', value: 'resume', kind: 'primary' },
        { label: '结束任务', value: 'end' },
      ],
      focusValue: 'end',
    }).then((value) => {
      if (state.task !== task || task.status !== 'paused') return;
      if (value === 'resume') void resume();
      else if (value === 'end') void stop('user');
    });
  }

  async function resume() {
    assertActive();
    const task = state.task;
    if (!task || task.status !== 'paused') return;
    if (!getPageModeEnabled()) { toast(PAGE_MODE_REQUIRED); return false; }
    if (state.running) { state.resumeRequested = true; return; }
    const owner = { task, controller: new AbortController() };
    captureDiagnosticContext(task, owner);
    state.owner = owner;
    state.resumeRequested = false;
    state.cancelled = false;
    state.running = true;
    task.status = 'preparing';
    clearInteraction(true);
    try {
      // A live task retains its initial model across resumes. A checkpoint
      // restored in a new panel snapshots the selected model on first resume.
      if (task.referenceImageCount && !task.referenceImages?.length) throw new Error('上次任务的参考图片未保留在运行检查点，请从原消息重新开始任务。');
      if (task.regionReadingCount && !task.regionReadings?.length) throw new Error('上次任务的区域数据未保留在运行检查点，请从原消息重新开始任务，重新读取各页后比较。');
      assertAgentVision(task.referenceImages || [], taskModel(task).profile);
      const tab = await waitTask(task, () => chrome.tabs.get(task.tabId), { phase: 'locate' });
      const pageError = agentPageError(tab?.url);
      if (pageError) throw new Error(pageError);
      task.currentUrl = tab.url;
      await waitTask(task, () => chrome.tabs.update(task.tabId, { active: true }), { phase: 'locate' });
      const enabled = await ensureControlEnabled(task);
      if (!enabled) { pauseTask('需要先开启浏览器控制。'); return; }
      const origin = originOf(tab.url);
      const granted = await ensureOrigin(task, origin, '继续任务前需要重新确认这个站点。');
      if (!granted) { pauseTask('未获得站点授权，任务仍在暂停。'); return; }
      await activateExecution(task, true);
      assertTask(task, owner);
      task.status = 'running';
      task.deadline = task.budget.maxMinutes === 0 ? 0 : Date.now() + task.budget.maxMinutes * 60000;
      task.pendingProgress = task.progress ? taskProgressCheckpoint(task.progress) : task.savedProgress;
      task.progress = null;
      startModelRun(task, owner);
      task.errorCount = 0;
      task.currentOrigin = origin;
      setPhase('observe', task);
      armWatchdog();
      addStep('info', '任务继续', origin);
      void setPageOverlay(true, '', task);
      void saveCheckpoint();
      render();
      onStateChange();
      state.running = false;
      void runLoop();
    } catch (error) {
      if (state.task === task && state.owner === owner && error.name !== 'AbortError') {
        task.skipSummary = true;
        await finishTask(error.message || '后台执行器无法恢复。', 'failed', task);
      }
    } finally {
      if (state.owner === owner && state.loopOwner !== owner) state.running = false;
    }
  }

  async function stop(reason = 'user') {
    if (disposed) return disposal;
    const task = state.task;
    if (!task || ['finished', 'failed', 'cancelled'].includes(task.status)) return;
    return finishTask(reason === 'user' ? '你停止了任务。' : reason, 'cancelled', task,
      reason === 'user' ? 'user-stop' : reason === PAGE_MODE_DISABLED ? 'page-mode-disabled' : 'task-cancelled');
  }

  async function concludeTurn(task, status, summary, turn) {
    if (!turn) return;
    finishAgentTurn(turn, { status, summary: summary || fallbackAgentSummary(turn) });
    const snapshot = agentTurnForMessage(turn);
    const controller = new AbortController();
    try {
      await bestEffort(() => endTurn?.({ ...snapshot, ...task.failure, taskId: task.id, sources: taskSources(task) }, { signal: controller.signal }), limits.preparation);
    } finally { controller.abort(); }
  }

  async function finishTask(summary, status = 'finished', task = state.task, diagnosticReason) {
    if (!task || state.task !== task) return;
    if (task.finalization) return task.finalization;
    const stopReason = diagnosticReason || (task.errorCount >= 3 ? 'error-limit' : status === 'finished' ? 'task-finished' : status === 'failed' ? 'task-failed' : 'task-cancelled');
    diagnose(task, state.owner, 'agent.task.stopped', { status, errorCount: task.errorCount || 0, phase: task.phase, reason: stopReason },
      status === 'finished' ? null : { code: status === 'cancelled' ? 'ERR_TASK_CANCELLED' : 'ERR_AGENT_FAILED', reason: stopReason });
    const turn = state.turn;
    task.status = status;
    task.phase = 'idle';
    clearInterval(state.watchdog);
    task.failure = status === 'failed' ? agentFailureForMessage(summary) : null;
    task.result = resultWithTaskSources(summary, task);
    state.cancelled = true;
    state.owner?.controller.abort();
    state.owner?.modelRun?.dispose();
    state.controller?.abort();
    state.controller = null;
    task.visualObserver?.dispose();
    task.visualEvidence = null;
    state.running = false;
    state.loopOwner = null;
    state.resumeRequested = false;
    clearInteraction(true);
    addStep(status === 'failed' ? 'error' : 'result', status === 'finished' ? '任务完成' : status === 'cancelled' ? '任务已停止' : '任务失败', task.result);
    const interruption = interruptExecution(status === 'cancelled' || task.skipSummary ? 'AGENT_CANCEL' : 'AGENT_PAUSE', task);
    void setPageOverlay(false, '', task);
    render();
    onStateChange();
    task.finalization = (async () => {
      await interruption;
      try { await concludeTurn(task, status, task.result, turn); }
      finally { await cleanupTask(task, status); }
      if (disposed || state.task !== task) return;
      state.mode = false;
      if (toggle) {
        toggle.setAttribute('aria-pressed', 'false');
        toggle.setAttribute('aria-label', '页面操作');
        toggle.title = '页面操作';
      }
      hidePanel();
      onStateChange();
    })();
    return task.finalization;
  }

  async function cleanupTask(task, status) {
    if (!task) return;
    // Per-task keys prevent delayed cleanup from removing a newer checkpoint.
    const key = `${TASK_KEY}:${task.id}`;
    const terminalKey = `${TASK_KEY}:ended:${task.id}`;
    await bestEffort(() => chrome.storage.session.set({ [terminalKey]: { id: task.id, endedAt: nowIso() } }));
    await bestEffort(() => clearTaskGrants(task.id));
    await bestEffort(() => chrome.storage.session.remove(key));
    if (task.tabId) await bestEffort(() => sendMessage({ type: 'AGENT_RELEASE', tabId: task.tabId, taskId: task.id }));
    await saveAudit(task, status);
    await bestEffort(async () => {
      const stored = await awaitWithTimeout(chrome.storage.session.get(null), { timeoutMs: limits.cleanup });
      const ended = Object.entries(stored || {}).filter(([name]) => name.startsWith(`${TASK_KEY}:ended:`))
        .sort((a, b) => String(b[1]?.endedAt || '').localeCompare(String(a[1]?.endedAt || '')));
      const obsolete = ended.slice(10).flatMap(([name, record]) => [name, `${TASK_KEY}:${record.id}`]);
      if (obsolete.length) await chrome.storage.session.remove(obsolete);
    });
  }

  async function saveAudit(task, status) {
    if (!task || task.audited) return;
    task.audited = true;
    try {
      const result = await awaitWithTimeout(chrome.storage.local.get(AUDIT_KEY), { timeoutMs: limits.cleanup });
      const audit = Array.isArray(result?.[AUDIT_KEY]) ? result[AUDIT_KEY] : [];
      audit.unshift({
        id: task.id,
        goal: String(task.goal || '').slice(0, 400),
        origin: task.currentOrigin || task.origin,
        status,
        startedAt: task.startedAt,
        endedAt: nowIso(),
        metrics: (task.metrics || []).slice(-120),
        steps: task.steps.slice(-40).map((step) => ({
          kind: step.kind,
          title: step.title,
          detail: step.detail,
          at: step.at,
        })),
      });
      await awaitWithTimeout(chrome.storage.local.set({ [AUDIT_KEY]: audit.slice(0, 10) }), { timeoutMs: limits.cleanup });
    } catch {
      // Audit persistence must never break the task UI.
    }
  }

  async function saveCheckpoint() {
    const task = state.task;
    if (!task) return;
    try {
      await awaitWithTimeout(chrome.storage.session.set({
        [`${TASK_KEY}:${task.id}`]: {
          id: task.id,
          goal: task.goal,
          tabId: task.tabId,
          origin: task.origin,
          currentOrigin: task.currentOrigin || task.origin,
          currentUrl: task.currentUrl || '',
          status: task.status,
          phase: task.phase || 'idle',
          step: task.step,
          maxSteps: task.maxSteps,
          startedAt: task.startedAt,
          deadline: task.deadline,
          steps: task.steps.slice(-30),
          facts: (task.facts || []).slice(-20),
          referenceImageCount: task.referenceImages?.length || task.referenceImageCount || 0,
          regionReadingCount: task.regionReadings?.length || task.regionReadingCount || 0,
          metrics: (task.metrics || []).slice(-120),
          progress: task.progress ? taskProgressCheckpoint(task.progress) : task.pendingProgress || task.savedProgress || null,
          planningRequired: task.planningRequired === true,
        },
      }), { timeoutMs: limits.cleanup });
    } catch {
      // Session checkpoints are best effort; a task can still finish safely.
    }
  }

  async function observeWithRecovery(task = state.task) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      const owner = state.owner;
      const startedAt = performance.now();
      diagnose(task, owner, 'agent.observe.started', { attempt, phase: 'observe' });
      try {
        response = await waitTask(task, () => sendMessage({
          type: 'AGENT_OBSERVE',
          tabId: task.tabId,
          taskId: task.id,
          diagnosticContext: diagnosticContext(task, owner),
        }), { phase: 'observe', timeoutMs: limits.observe, message: '读取页面超时，未请求下一步模型，任务已停止。请检查页面后重试。' });
        recordTiming(task, owner, 'observe', startedAt, { elements: response?.elements?.length,
          scanMs: response?.metrics?.scanMs, candidates: response?.metrics?.candidateCount });
        diagnose(task, owner, response?.error ? 'agent.observe.failed' : 'agent.observe.completed', {
          attempt, durationMs: performance.now() - startedAt, elementCount: response?.elements?.length, frameCount: response?.frames,
        }, response?.error ? agentDiagnosticError(response, 'scan') : null, { snapshotId: response?.snapshotId });
      } catch (error) {
        diagnose(task, owner, 'agent.observe.failed', { attempt, durationMs: performance.now() - startedAt,
          late: state.owner !== owner || owner.controller.signal.aborted }, agentDiagnosticError(error, 'request'));
        if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
        throw new Error(error?.message || '后台无法连接。');
      }
      if (!response?.error) return response;
      if (['ERR_TASK_PAUSED', 'ERR_TASK_CANCELLED', 'ERR_PAGE_CHANGED'].includes(response.error)) {
        pauseTask(response.message || '后台任务已中断，请核对页面后继续。');
        return null;
      }
      if (response.error === 'ERR_CONTROL_DISABLED') {
        const enabled = await ensureControlEnabled(task);
        if (!enabled) return null;
        continue;
      }
      if (response.error === 'ERR_ORIGIN_NOT_ALLOWED') {
        const granted = await ensureOrigin(task, response.origin, '当前页面已切换到新的站点。');
        if (!granted) return null;
        continue;
      }
      const error = new Error(response.message || '无法读取当前页面。');
      error.code = response.error;
      throw error;
    }
    return null;
  }

  async function inspectTaskVisual(task, observation, elementId, { refresh = false, optional = false } = {}) {
    const owner = state.owner;
    const priorTarget = findElement(observation.elements, elementId);
    if (refresh && priorTarget) {
      const fresh = await observeWithRecovery(task);
      assertTask(task, owner);
      if (!fresh || fresh.url !== observation.url || (observation.documentId && fresh.documentId !== observation.documentId)) {
        return { ok: false, error: 'ERR_PAGE_CHANGED', message: '页面已变化，请重新核对局部视觉目标。', observation: fresh || observation };
      }
      const candidates = fresh.elements.filter(item => priorTarget.stableKey ? item.stableKey === priorTarget.stableKey
        : item.tag === priorTarget.tag && item.role === priorTarget.role && item.name === priorTarget.name
          && item.frameId === priorTarget.frameId && item.domId === priorTarget.domId && item.fieldName === priorTarget.fieldName);
      if (candidates.length !== 1) return { ok: false, error: 'ERR_ELEMENT_NOT_FOUND', message: '新观察未能唯一确认原目标，请重新选择。', observation: fresh };
      observation = fresh;
      elementId = candidates[0].id;
    }
    assertTask(task, owner);
    task.visualObserver ||= createAgentVisualObservation({ timeoutMs: limits.evidence, cropImage: cropVisualImage,
      capture: ({ signal: _signal, ...message }) => sendMessage(message) });
    const result = await waitTask(task, () => task.visualObserver.inspect({ task, observation, elementId,
      profile: taskModel(task).profile, signal: owner.controller.signal,
      isCurrent: source => state.task === task && state.owner === owner && task.status === 'running'
        && !owner.controller.signal.aborted && task.tabId === source.tabId && task.currentUrl === source.url,
    }), { phase: 'observe', timeoutMs: limits.evidence, message: '局部视觉观察超时。' });
    assertTask(task, owner);
    if (result.ok) task.visualEvidence = { ...result.visual, optional };
    return { ...result, observation };
  }

  async function decideAction(observation) {
    const task = state.task;
    const owner = state.owner;
    const recovery = task.recoveryRequested;
    if (recovery) {
      task.recoveryRequested = null;
      // An executor rejection is handled by deterministic recovery, not by increasing reasoning.
      if (recovery.reason === 'no-progress' && !task.recoveryModelProfile) {
        const profile = agentRecoveryProfile(taskModel(task).profile);
        if (profile) {
          task.recoveryModelProfile = profile;
          startModelRun(task, owner);
          addStep('info', '正在重新规划', '已提高当前模型的思考强度，保留原任务和执行记录。');
        }
      }
    }
    if ((recovery || task.recoveryVisionPending) && taskModel(task).profile.supportsVision && !task.recoveryVisionUsed) {
        const selection = selectAgentVisualTarget(observation, { goal: task.goal, plan: taskProgressContext(task.progress).plan });
        task.recoveryVisionPending = !selection.ok;
        if (!selection.ok) {
          // A missing target is not a capture. A later concrete subgoal may
          // resolve it within the existing three-decision recovery budget.
          pushRecent({ action: 'visual-recovery', ok: false, error: selection.error,
            message: `${selection.message} 请使用当前可操作元素推进；需要的控件仍不可用时请求接管。` });
          addStep('warning', '局部视觉未找到目标', selection.message);
          diagnose(task, owner, 'agent.read.failed', { action: AGENT_ACTIONS.inspectVisual, strategy: 'visual',
            elementCount: selection.candidateElementIds.length, imageCount: 0 }, agentDiagnosticError(selection, 'inspect'),
            { snapshotId: observation.snapshotId });
        } else {
        task.recoveryVisionUsed = true;
        try {
          const result = await inspectTaskVisual(task, observation, selection.target.id, { optional: true });
          addStep(result.ok ? 'observe' : 'warning', '局部视觉恢复', result.ok ? result.visual.notice : result.message);
          pushRecent({ action: 'visual-recovery', ok: result.ok, error: result.error, message: result.ok
            ? `已取得相关控件附近画面，候选元素：${result.visual.candidateElementIds.join('、')}。根据当前状态执行下一步，截图不代表任务已完成。`
            : `${result.message || '局部视觉资料不可用。'} 请使用当前元素资料推进操作或请求接管。` });
          diagnose(task, owner, result.ok ? 'agent.read.completed' : 'agent.read.failed', {
            action: AGENT_ACTIONS.inspectVisual, strategy: 'visual', imageCount: result.ok ? 1 : 0,
          }, result.ok ? null : agentDiagnosticError(result, 'inspect'), { snapshotId: observation.snapshotId });
          if (result.ok) {
            diagnose(task, owner, 'agent.task.progress', { strategy: 'visual' }, null, { snapshotId: observation.snapshotId });
          } else if (VISUAL_INTERRUPTION_ERRORS.has(result.error)) {
            pauseTask(result.message || '局部视觉观察的页面目标或控制许可已失效。');
            return null;
          }
        } catch (error) {
          assertTask(task, owner);
          if (error.name === 'AbortError') throw error;
          if (VISUAL_INTERRUPTION_ERRORS.has(error.code)) {
            pauseTask(error.message || '局部视觉观察的页面目标或控制许可已失效。');
            return null;
          }
          pushRecent({ action: 'visual-recovery', ok: false, error: error.code || 'ERR_VISUAL_CAPTURE_FAILED',
            message: '局部视觉资料暂不可用，请使用当前元素资料推进操作或请求接管。' });
          addStep('warning', '局部视觉恢复失败', '局部视觉资料暂不可用，请使用当前元素资料推进操作或请求接管。');
          diagnose(task, owner, 'agent.read.failed', { action: AGENT_ACTIONS.inspectVisual, strategy: 'visual', imageCount: 0 },
            agentDiagnosticError(error, 'inspect'), { snapshotId: observation.snapshotId });
        }
        }
    }
    const modelRun = owner.modelRun;
    if (!modelRun) throw new Error('任务模型尚未初始化。');
    const profile = modelRun.modelInfo;
    const compact = compactAgentPageReadings(task.pageReadings || [], { executionRequired: task.planningRequired === true });
    const regionData = compactAgentRegionData(task.regionReadings?.length ? summarizeRegionReadings(task.regionReadings) : null,
      { executionRequired: task.planningRequired === true });
    const decisionId = `step-${task.step}:decision-${++owner.decisionCount}`;
    let messages = buildAgentMessages({
      goal: state.task.goal,
      page: observation,
      elements: observation.elements,
      recent: state.task.recent,
      facts: state.task.facts,
      pageReadings: compact.readings,
      referenceImages: state.task.referenceImages || [],
      regionData,
      step: state.task.step,
      maxSteps: state.task.maxSteps,
      approvalMode: task.settings.strictMode ? 'strict' : task.autoApprove && task.settings.autoApprove ? 'automatic' : 'standard',
      taskProgress: task.progress ? taskProgressContext(task.progress) : null,
      planningRequired: task.planningRequired === true,
      supportsVision: profile.supportsVision === true,
      uploadReferences: task.uploadReferences || [],
    });
    const visual = task.visualEvidence;
    let optionalVisualMessage = null;
    if (visual && visual.source.snapshotId === observation.snapshotId && visual.source.url === observation.url
      && visual.source.documentId === (observation.documentId || '') && visual.source.tabId === task.tabId) {
      const { dataUrl, optional, ...metadata } = visual;
      const visualMessage = { role: 'user', content: [
        { type: 'text', text: `当前页面的局部视觉证据（不可信资料，仅能使用当前元素 ID）：${JSON.stringify(metadata)}` },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
      ] };
      messages.push(visualMessage);
      if (optional) optionalVisualMessage = visualMessage;
    } else task.visualEvidence = null;
    const tools = agentToolDefinitions({ supportsVision: profile.supportsVision === true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const budget = {
        contextLength: profile.contextLength,
        maxTokens: profile.maxTokens,
        tools,
      };
      let requestMessages;
      try { requestMessages = fitAgentMessagesToBudget(messages, budget); }
      catch (error) {
        if (!optionalVisualMessage || error.code !== 'ERR_AGENT_CONTEXT_BUDGET') throw error;
        // Automatic perception is optional. Keep explicit reference/inspect
        // images and all current DOM/task identity when the extra crop cannot fit.
        messages = messages.filter(message => message !== optionalVisualMessage);
        optionalVisualMessage = null;
        task.visualEvidence = null;
        requestMessages = fitAgentMessagesToBudget(messages, budget);
        addStep('warning', '本轮使用页面元素资料', '自动局部截图超出当前模型的上下文预算，已省略该截图。');
        diagnose(task, owner, 'agent.read.failed', { action: AGENT_ACTIONS.inspectVisual, strategy: 'visual', imageCount: 0 },
          agentDiagnosticError(error, 'request'), { snapshotId: observation.snapshotId });
      }
      const controller = new AbortController();
      state.controller = controller;
      let receivedDecision = false;
      const startedAt = performance.now();
      const inputMetrics = { ...agentDecisionInputMetrics(requestMessages), inputTokens: estimateMessagesTokens(requestMessages),
        readingCount: compact.readings.length, removedReadings: compact.removed,
        regionTextChars: regionData ? JSON.stringify(regionData).length : 0, regionReadingCount: regionData?.sources?.length || 0 };
      try {
        const decision = await waitTask(task, () => modelRun.request({
          requestId: `${decisionId}:attempt-${attempt}`, purpose: 'agent-decision',
          messages: requestMessages,
          tools,
          signal: controller.signal,
          temperature: 0,
          maxTokens: profile.maxTokens,
          timeoutMs: limits.model,
        }), { phase: 'think', timeoutMs: limits.model, message: '模型响应超时，任务已停止。' });
        assertTask(task, owner);
        recordTiming(task, owner, 'model', startedAt, { inputTokens: estimateMessagesTokens(requestMessages) });
        receivedDecision = true;
        const raw = decision.kind === 'tool'
          ? { action: decision.name, args: decision.args, reason: decision.reason }
          : parseJsonAction(decision.content);
        if (!raw) throw new Error('模型没有返回 JSON 动作。');
        const normalized = normalizeAgentAction(raw);
        diagnose(task, owner, 'agent.decision.completed', { action: normalized.action, attempt,
          durationMs: performance.now() - startedAt, ...inputMetrics }, null, { snapshotId: observation.snapshotId, elementId: normalized.args?.elementId });
        return normalized;
      } catch (error) {
        diagnose(task, owner, 'agent.decision.failed', { attempt, durationMs: performance.now() - startedAt,
          late: state.owner !== owner || owner.controller.signal.aborted, ...inputMetrics }, agentDiagnosticError(error, receivedDecision ? 'parse' : 'request'), { snapshotId: observation.snapshotId });
        if (state.cancelled || state.task?.status !== 'running') return null;
        if (error.name === 'TimeoutError') { task.skipSummary = true; throw new Error('模型响应超时。'); }
        if (error?.name === 'AbortError') return null;
        if (!receivedDecision) throw error;
        if (attempt === 0) {
          messages = [...messages, {
            role: 'user',
            content: '上一次输出不是有效动作。请只返回一个工具调用；如果工具不可用，只返回一个 JSON 对象 {"action":"...","args":{...}}。',
          }];
          continue;
        }
        throw error;
      } finally {
        controller.abort();
        if (state.controller === controller) state.controller = null;
      }
    }
    return null;
  }

  async function executeAction(action, args, observation, actionId, approved) {
    const task = state.task;
    const owner = state.owner;
    const startedAt = performance.now();
    const target = findElement(observation.elements, args.elementId);
    const context = { actionId, snapshotId: observation.snapshotId, elementId: args.elementId, documentId: task.startDocumentId };
    const [targetId, argumentId] = await Promise.all([
      agentDiagnosticFingerprint(task.id, agentTargetKey({ action, args }, observation)),
      agentDiagnosticFingerprint(task.id, args),
    ]);
    assertTask(task, owner);
    Object.assign(context, { targetId, argumentId });
    const details = { action, frameId: target?.frameId, tag: target?.tag, role: target?.role,
      inputType: target?.type, disabled: target?.disabled === true, errorCount: task.errorCount || 0,
      ...(action === AGENT_ACTIONS.type && typeof args.text === 'string' ? { expectedChars: args.text.length } : {}) };
    diagnose(task, owner, 'agent.action.started', details, null, context);
    const base = {
      tabId: task.tabId,
      taskId: task.id,
      expectedUrl: observation.url,
      actionId,
      actionSequence: task.actionSequence,
      diagnosticContext: diagnosticContext(task, owner),
      approval: { confirmed: Boolean(approved), actionId },
    };
    const message = action === AGENT_ACTIONS.navigate ? { ...base, type: 'AGENT_NAVIGATE', args }
      : action === AGENT_ACTIONS.wait ? { ...base, type: 'AGENT_WAIT', args } : {
      ...base,
      type: 'AGENT_ACT',
      snapshotId: observation.snapshotId,
      action,
      args,
    };
    try {
      const result = await waitTask(task, () => sendMessage(message), { phase: 'act', timeoutMs: limits.action, message: '页面动作等待超时，执行结果未确认，任务已停止。请核对页面，避免重复操作。' });
      recordTiming(task, owner, 'action', startedAt);
      const failed = !result || result.ok === false || Boolean(result.error);
      const failureStage = result?.diagnostics?.failureStage || 'execute';
      diagnose(task, owner, failed ? 'agent.action.failed' : 'agent.action.completed', { ...details,
        durationMs: performance.now() - startedAt, errorCount: (task.errorCount || 0) + (failed ? 1 : 0),
        changedFields: result?.diagnostics?.changedFields, snapshotAgeMs: result?.diagnostics?.snapshotAgeMs,
        executionStatus: result?.diagnostics?.executionStatus,
        ...(failed ? { failureStage } : {}),
      }, failed ? agentDiagnosticError(result || { error: 'ERR_ACTION_FAILED' }, failureStage) : null, context);
      return result;
    } catch (error) {
      diagnose(task, owner, 'agent.action.failed', { ...details, durationMs: performance.now() - startedAt,
        failureStage: 'request', late: state.owner !== owner || owner.controller.signal.aborted }, agentDiagnosticError(error, 'request'), context);
      throw error;
    }
  }

  async function runLoop() {
    if (state.running || !state.task) return;
    const task = state.task;
    const owner = state.owner;
    state.loopOwner = owner;
    state.running = true;
    state.cancelled = false;
    let reusableObservation = null;
    try {
      while (state.task === task && state.owner === owner && task.status === 'running' && !state.cancelled) {
        if (task.deadline > 0 && Date.now() > task.deadline) {
          await finishTask('任务超时。', 'failed', task, 'timeout');
          break;
        }
        try {
          task.settings = await waitTask(task, () => getAgentSettings(), { phase: 'settings' });
        } catch (error) {
          if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
          // Keep the last known settings if storage is temporarily unavailable.
        }
        if (state.task !== task || task.status !== 'running') return;
        if (!task.settings?.enabled) {
          pauseTask('浏览器控制已在设置中关闭。');
          return;
        }
        task.step += 1;
        if (!reusableObservation) setPhase('observe');
        let observation;
        try {
          observation = reusableObservation || await observeWithRecovery(task);
          reusableObservation = null;
        } catch (error) {
          if (state.task !== task || state.owner !== owner || task.status !== 'running' || error.name === 'AbortError') return;
          task.skipSummary = true;
          await finishTask(error.message || '无法读取当前页面。', 'failed', task);
          break;
        }
        if (state.task !== task || task.status !== 'running') return;
        if (!observation) {
          if (state.task?.status === 'paused') return;
          await finishTask('没有获得页面观察结果。', 'failed');
          break;
        }
        task.currentOrigin = originOf(observation.url) || task.currentOrigin;
        task.currentUrl = observation.url;
        if (!task.progress) {
          task.progress = restoreTaskProgress(task.pendingProgress,
            { taskId: task.id, tabId: task.tabId, url: observation.url,
              documentId: observation.documentId || task.pendingProgress?.scope?.documentId || task.startDocumentId || '',
              maxSteps: task.budget.maxSteps === 0 ? 0 : Math.min(task.maxSteps || 12, task.budget.maxSteps),
              hardMaxSteps: task.budget.maxSteps, deadline: task.deadline,
              executionRequired: task.planningRequired === true });
          // An explicit resume starts the existing bounded time window; it does not increase the step cap.
          task.progress.deadline = task.deadline;
          task.pendingProgress = null;
          task.maxSteps = taskProgressContext(task.progress).maxSteps;
        }
        verifyPendingAction(task, observation);
        setTaskProgressTarget(task.progress, { taskId: task.id, tabId: task.tabId, url: observation.url,
          documentId: observation.documentId || task.startDocumentId || '' });
        const policy = assessTaskProgress(task.progress, { step: task.step - 1, now: Date.now() });
        if (policy.decision === 'stop') {
          task.step -= 1;
          const message = policy.reason === 'action-unconfirmed' ? '页面动作结果未确认，任务已停止。请核对页面，避免重复提交。'
            : ['repeated-failure', 'no-progress'].includes(policy.reason) ? '重新观察和调整方法后仍没有有效进展，任务已停止。请查看操作记录或导出本对话诊断日志。'
              : '达到本次任务的步数或时间预算，任务已停止；已完成的操作保留。';
          diagnose(task, owner, 'agent.task.progress', { strategy: 'stop', reason: policy.reason });
          await finishTask(message, 'failed', task, policy.reason);
          break;
        }
        if (policy.decision === 'extend') {
          task.maxSteps = policy.maxSteps;
          addStep('info', '任务取得进展', `已核验新的结果，继续执行；本次最多 ${task.maxSteps} 步，不超过设置上限。`);
          diagnose(task, owner, 'agent.task.progress', { strategy: 'extend' });
        } else if (policy.decision === 'replan') {
          task.recoveryRequested = { reason: policy.reason };
          pushRecent({ action: 'replan', ok: false, error: 'ERR_REPLAN_REQUIRED', message: '当前方法持续失败或没有进展。请结合任务计划、具体错误和当前状态改变方法；不要重复读取清空失败，不要重复提交结果不明的动作。' });
          addStep('warning', '正在调整执行方法', '保留已完成步骤，重新核对当前障碍。');
          diagnose(task, owner, 'agent.task.progress', { strategy: 'replan', reason: policy.reason });
          const fresh = await observeWithRecovery(task);
          assertTask(task, owner);
          if (!fresh) return;
          if (fresh.url !== observation.url || (observation.documentId && fresh.documentId !== observation.documentId)) {
            pauseTask('重新观察时页面发生变化，请核对后继续。');
            return;
          }
          observation = fresh;
        }
      if (!state.lastObservationUrl || state.lastObservationUrl !== observation.url) {
        state.loopNudged = false;
      }
      state.lastObservationUrl = observation.url;
      if (task.visitedUrls.at(-1) !== observation.url) {
        task.visitedUrls = [...task.visitedUrls, observation.url].filter(Boolean).slice(-12);
      }
      if (navigationLoop(observation)) {
        await finishTask('检测到页面导航循环：Agent 在多个页面之间反复跳转，已停止以避免死循环。', 'failed');
        break;
      }
        addStep(
          'observe',
          `观察页面 · ${observation.elements.length} 个可交互元素`,
          [observation.title, observation.flags?.passwordField ? '页面包含密码字段，不会自动输入' : '', observation.flags?.captcha ? '检测到验证码/人机验证' : ''].filter(Boolean).join(' · '),
        );
        recordObservationFacts(observation);
        render();
        saveCheckpoint();
        if (observation.flags?.captcha) {
          pauseTask('检测到验证码或人机验证，请先在页面上完成验证。', { handoff: true });
          return;
        }
        setPhase('think');
        let action;
        try {
          action = await decideAction(observation);
        } catch (error) {
          if (state.task !== task || state.owner !== owner || task.status !== 'running') return;
          await finishTask(error.message || '模型没有返回可执行动作。', 'failed', task, 'model-failure');
          break;
        }
        if (state.task !== task || state.owner !== owner || task.status !== 'running') return;
        if (!action) {
          if (state.task !== task || state.owner !== owner || task.status !== 'running') return;
          continue;
        }
        recordTaskDecision(task.progress, { scope: taskProgressScope(task.progress), decisionId: `${owner.runId}:${task.step}`,
          step: task.step, action: action.action });
        const label = actionLabel(action.action, action.args, observation.elements);
        const signature = `${observation.url || ''}|${actionSignature(action.action, action.args, observation.elements)}`;
        addStep('decide', `模型选择：${label}`, action.reason || '');
        render();
        saveCheckpoint();
        if (action.action === AGENT_ACTIONS.plan) {
          const updated = updateTaskPlan(task.progress, action.args, taskProgressScope(task.progress));
          if (!updated.ok) throw new Error('任务计划格式无效，请重新开始任务。');
          const plan = taskProgressContext(task.progress).plan;
          addStep('info', '已更新任务计划', plan.map(item => `${item.status === 'completed' && item.verified ? '✓' : item.status === 'in_progress' ? '→' : '·'} ${item.title}`).join('\n'));
          diagnose(task, owner, 'agent.task.progress', { totalSteps: plan.length, completedSteps: plan.filter(item => item.status === 'completed' && item.verified).length });
          reusableObservation = observation;
          continue;
        }
        if (action.action === AGENT_ACTIONS.inspectVisual) {
          let result;
          try { result = await inspectTaskVisual(task, observation, action.args.elementId, { refresh: true }); }
          catch (error) {
            assertTask(task, owner);
            if (error.name === 'AbortError') return;
            await finishTask(error.message || '局部视觉观察失败，请核对页面后继续。', 'failed', task);
            return;
          }
          assertTask(task, owner);
          if (VISUAL_INTERRUPTION_ERRORS.has(result.error)) {
            pauseTask(result.message || '局部视觉观察的页面目标已失效。'); return;
          }
          addStep(result.ok ? 'observe' : 'warning', '局部视觉观察', result.ok ? result.visual.notice : result.message);
          pushRecent({ action: label, ok: result.ok, message: result.ok
            ? `已查看控件附近区域，候选元素：${result.visual.candidateElementIds.join('、')}。请据此操作，无需重复截图。` : result.message,
            error: result.error, signature, observedChange: false });
          diagnose(task, owner, result.ok ? 'agent.read.completed' : 'agent.read.failed', { action: action.action, strategy: 'visual',
            imageCount: result.ok ? 1 : 0, imageBytes: result.ok ? agentDecisionInputMetrics([{ content: [{ type: 'image_url', image_url: { url: result.visual.dataUrl } }] }]).imageBytes : 0 },
            result.ok ? null : agentDiagnosticError(result, 'inspect'), { snapshotId: result.observation?.snapshotId });
          if (result.handoff) { pauseTask(result.message, { handoff: true }); return; }
          reusableObservation = result.ok || result.error === 'ERR_VISUAL_REGION_REPEATED' ? result.observation : null;
          continue;
        }
        if (task.planningRequired && !taskProgressContext(task.progress).plan.length
          && ![AGENT_ACTIONS.read, AGENT_ACTIONS.readRegion, AGENT_ACTIONS.handoff, AGENT_ACTIONS.fail].includes(action.action)) {
          task.planWarnings = (task.planWarnings || 0) + 1;
          pushRecent({ action: 'plan-required', ok: false, message: '这是多步骤任务，请先用 update_plan 建立 3–8 个子目标和最终核验步骤，再执行页面操作。' });
          if (task.planWarnings >= 2) { await finishTask('模型未建立可执行的任务计划，已停止。', 'failed', task); return; }
          reusableObservation = observation;
          continue;
        }
        if (action.action === AGENT_ACTIONS.verify) {
          const fresh = await observeWithRecovery(task);
          assertTask(task, owner);
          if (!fresh) return;
          const result = verifyAgentState(action, observation, fresh);
          if (result.error === 'ERR_PAGE_CHANGED') { pauseTask(result.message); return; }
          const fingerprint = await agentDiagnosticFingerprint(task.id, [agentTargetKey(action, observation), action.args.field, action.args.expected]);
          assertTask(task, owner);
          const targetKey = agentTargetKey(action, observation);
          const executionRelevant = hasTaskExecutionOutcome(task.progress, targetKey);
          if (result.ok) recordTaskEvidence(task.progress, { scope: taskProgressScope(task.progress), kind: 'state',
            fingerprint, targetKey, verified: true, executionRelevant, snapshotId: fresh.snapshotId });
          else recordTaskOutcome(task.progress, { scope: taskProgressScope(task.progress), actionId: `${owner.runId}:${task.step}:verify`,
            action: action.action, targetKey: agentTargetKey(action, observation), ok: false, errorCode: result.error, failureStage: 'check', executionStatus: 'verified', requiresVerification: false });
          addStep(result.ok ? 'result' : 'warning', '核对控件状态', result.message);
          pushRecent({ action: label, ok: result.ok, error: result.error, message: result.message });
          diagnose(task, owner, result.ok ? 'agent.verify.completed' : 'agent.verify.failed', { action: action.action, verified: result.ok },
            result.ok ? null : agentDiagnosticError(result, 'check'), { snapshotId: fresh.snapshotId });
          reusableObservation = fresh;
          continue;
        }
        if (repeatedAction(action, observation) && task.repeatWarning !== signature) {
          task.repeatWarning = signature;
          addStep('warning', '重复动作尚未确认可见变化', '要求读取正文或改变方法，避免重复提交。');
          pushRecent({
            action: 'loop-guard',
            ok: false,
            message: '同一动作后的观察多次一致。请使用 read_page 核对正文、改变方法或请求接管，不要重复提交。已有正文足够时用 finish_task 回答。',
            error: 'ERR_LOOP_NUDGE',
            signature: '',
          });
          reusableObservation = observation;
          continue;
        }
        if (repeatedAction(action, observation)) {
          pauseTask('重复动作后仍无法从观察中确认变化，已暂停。请核对页面后继续，避免重复提交。', { handoff: true });
          return;
        }

        if (action.action === AGENT_ACTIONS.finish) {
          const verified = assessTaskCompletion(task.progress, { scope: taskProgressScope(task.progress) });
          if (!verified.ok) {
            task.verificationWarnings = (task.verificationWarnings || 0) + 1;
            addStep('warning', '任务结果尚未核验', '仍有未完成的目标或未确认的页面动作，请核对当前页面。');
            pushRecent({ action: 'finish_task', ok: false, error: 'ERR_TASK_UNVERIFIED', message: `尚不能完成：${verified.reason}；缺少目标 ${verified.missingStepIds.join(', ')}。请取得真实结果证据并更新计划。` });
            if (task.verificationWarnings >= 2) { await finishTask('任务结果尚未核验，已停止。请核对页面，避免重复提交。', 'failed', task); return; }
            reusableObservation = observation;
            continue;
          }
          const completion = assessChapterCompletion(task.goal, observation.elements, task.pageReadings);
          if (!completion.ok) {
            task.completionWarnings = (task.completionWarnings || 0) + 1;
            addStep('warning', '目标章节正文尚未核实', completion.reason);
            pushRecent({ action: 'finish_task', ok: false, error: 'ERR_CHAPTER_NOT_READ', message: completion.reason });
            if (task.completionWarnings >= 2) {
              await finishTask(completion.reason, 'failed', task);
              break;
            }
            reusableObservation = observation;
            continue;
          }
          await finishTask(action.args.summary, 'finished');
          break;
        }
        if (action.action === AGENT_ACTIONS.fail) {
          await finishTask(action.args.reason, 'failed');
          break;
        }
        if (action.action === AGENT_ACTIONS.handoff) {
          pauseTask(action.args.reason, { handoff: true });
          return;
        }

        if (action.action === AGENT_ACTIONS.read || action.action === AGENT_ACTIONS.readRegion) {
          const region = action.action === AGENT_ACTIONS.readRegion;
          diagnose(task, owner, 'agent.read.started', { action: action.action }, null, { snapshotId: observation.snapshotId });
          let result;
          try { result = region ? await readRegion(task, observation, action.args) : await readPage(task, observation, action.args.query); }
          catch (error) {
            diagnose(task, owner, 'agent.read.failed', { action: action.action, late: state.owner !== owner || owner.controller.signal.aborted },
              agentDiagnosticError(error, 'request'), { snapshotId: observation.snapshotId });
            throw error;
          }
          assertTask(task, owner);
          diagnose(task, owner, result.ok ? 'agent.read.completed' : 'agent.read.failed', { action: action.action,
            textChars: result.reading?.text?.length, rowCount: result.reading?.rows?.length, repeated: result.repeated === true,
            truncated: result.reading?.truncated === true }, result.ok ? null : agentDiagnosticError(result, 'read'), { snapshotId: observation.snapshotId });
          if (['ERR_TASK_PAUSED', 'ERR_TASK_CANCELLED', 'ERR_PAGE_CHANGED'].includes(result.error)) {
            pauseTask(result.message || '页面已经变化，请核对后继续。');
            return;
          }
          if (['ERR_PAGE_READ_TIMEOUT', 'ERR_REGION_READ_TIMEOUT'].includes(result.error)) {
            await finishTask(result.message || '读取页面正文超时，请检查页面后重试。', 'failed', task);
            return;
          }
          if (!result.ok) {
            task.errorCount = (task.errorCount || 0) + 1;
            addStep('warning', '未读取到页面正文', result.message || result.error);
            pushRecent({ action: label, ok: false, message: result.message, error: result.error, signature });
            if (task.errorCount >= 3) { await finishTask('连续无法读取正文，请核对页面后重试。', 'failed', task); return; }
          } else {
            task.errorCount = 0;
            const reading = result.reading;
            const fingerprint = await agentDiagnosticFingerprint(task.id, region ? JSON.stringify(reading.rows || []) + reading.text : reading.text);
            assertTask(task, owner);
            recordTaskEvidence(task.progress, { scope: taskProgressScope(task.progress), kind: 'reading', verified: true,
              fingerprint, snapshotId: observation.snapshotId });
            const detail = `已读取 ${region ? `${reading.rows.length} 行、${reading.text.length} 字符` : `${reading.text.length} 字符`}${reading.truncated ? '（部分数据，已截断）' : ''}${result.repeated ? '；与上次相同，无需重复读取' : ''}。`;
            addStep('observe', region ? '已读取页面区域' : '已读取页面正文', detail);
            pushRecent({ action: label, ok: true, message: detail, signature, observedChange: !result.repeated });
          }
          // Reading does not mutate the DOM; retain the guarded snapshot for the next decision.
          reusableObservation = result.ok ? observation : null;
          render();
          void saveCheckpoint();
          continue;
        }

        const assessment = assessAgentAction({
          action: action.action,
          args: action.args,
          elements: observation.elements,
          settings: task.settings,
          currentUrl: observation.url,
          uploadReferences: task.uploadReferences || [],
        });
        if (assessment.level === 'blocked') {
          task.errorCount = (task.errorCount || 0) + 1;
          recordTaskOutcome(task.progress, { scope: taskProgressScope(task.progress), actionId: `${owner.runId}:${task.step}:blocked`,
            action: action.action, targetKey: agentTargetKey(action, observation), ok: false, errorCode: 'ERR_SAFETY_BLOCKED', failureStage: 'safety' });
          diagnose(task, owner, 'agent.action.failed', { action: action.action, failureStage: 'safety', errorCount: task.errorCount },
            { code: 'ERR_SAFETY_BLOCKED', reason: 'safety' }, { snapshotId: observation.snapshotId, elementId: action.args?.elementId });
          addStep('warning', '安全策略已阻断', assessment.reason || '');
          pushRecent({ action: label, ok: false, error: 'ERR_SAFETY_BLOCKED', message: assessment.reason || '' });
          render();
          if (task.errorCount >= 3) {
            await finishTask('连续遇到安全阻断，任务已停止。', 'failed');
            break;
          }
          continue;
        }
        if (assessment.targetOrigin && assessment.targetOrigin !== originOf(observation.url)) {
          setPhase('wait');
          const granted = await ensureOrigin(task, assessment.targetOrigin, '这个动作会访问其他站点。');
          if (state.task !== task || state.owner !== owner || task.status !== 'running') return;
          if (!granted) {
            addStep('warning', '已取消跨站访问', assessment.targetOrigin);
            pushRecent({ action: label, ok: false, error: 'ERR_ORIGIN_DENIED', message: '用户拒绝了站点授权。' });
            render();
            continue;
          }
        }
        let approved = false;
        const automatic = task.autoApprove && task.settings.autoApprove && !task.settings.strictMode;
        if (assessment.level === 'confirm' && automatic) {
          addStep('approval', '按自动批准模式执行', actionLabel(action.action, action.args, observation.elements));
          render();
        } else if (assessment.level === 'confirm') {
          setPhase('wait');
          approved = await askApproval({ action: action.action, args: action.args, observation, assessment });
          if (state.task !== task || state.owner !== owner || task.status !== 'running') return;
          if (!approved) {
            addStep('warning', '你取消了这次操作', actionLabel(action.action, action.args, observation.elements));
            pushRecent({ action: label, ok: false, error: 'ERR_USER_DENIED', message: '用户取消了操作。' });
            task.errorCount = (task.errorCount || 0) + 1;
            render();
            if (task.errorCount >= 3) {
              await finishTask('连续取消操作，任务已停止。', 'failed');
              break;
            }
            continue;
          }
          addStep('approval', '你已确认这次操作', actionLabel(action.action, action.args, observation.elements));
          render();
        }
        if (state.task !== task || state.owner !== owner || task.status !== 'running') return;

        setPhase('act');
        const actionId = `${task.id}:${++task.actionSequence}`;
        let result;
        try {
          result = await executeAction(action.action, action.args, observation, actionId, approved);
        } catch (error) {
          if (state.task !== task || state.owner !== owner || task.status !== 'running' || error.name === 'AbortError') return;
          if (error.name === 'TimeoutError') {
            await finishTask(error.message, 'failed', task);
            return;
          }
          result = { ok: false, error: 'ERR_BACKGROUND_UNREACHABLE', message: error.message || '后台操作失败。' };
        }
        if (!result || typeof result !== 'object') result = { ok: false, error: 'ERR_ACTION_FAILED', message: '没有收到执行结果。' };
        if (state.task !== task || state.owner !== owner || task.status !== 'running') return;
        const actionFailed = result.ok === false || Boolean(result.error);
        const uncertain = result.diagnostics?.executionStatus === 'uncertain'
          || ['ERR_ACTION_RESULT_UNKNOWN', 'ERR_UPLOAD_UNCERTAIN', 'ERR_ACTION_TIMEOUT'].includes(result.error);
        const trackedOutcome = recordTaskOutcome(task.progress, { scope: taskProgressScope(task.progress), actionId,
          action: action.action, targetKey: agentTargetKey(action, observation), ok: !actionFailed, uncertain,
          errorCode: result.error, failureStage: result.diagnostics?.failureStage || 'execute',
          executionStatus: result.diagnostics?.executionStatus,
          // Harmless navigation/focus attempts may be abandoned once actual reading answers the task.
          // Stateful controls and confirmed submissions still require their own result evidence.
          requiresVerification: !(action.action === AGENT_ACTIONS.click && assessment.level === 'normal'
            && !['checked', 'pressed', 'expanded'].some(key => key in (findElement(observation.elements, action.args.elementId)?.state || {}))),
        });
        if (uncertain) {
          if (canVerifyConsumedAgentUpload(action.action, result)) {
            addStep('info', '正在核对参考图片预览', '文件输入框未保留预期选择，正在只读核对本次图片的新预览，不会重新上传。');
            let accepted;
            try {
              accepted = await verifyConsumedUpload(task, owner, { id: actionId, action: action.action, args: action.args, result, observation });
            } catch (error) {
              if (state.task !== task || state.owner !== owner || task.status !== 'running' || error.name === 'AbortError') return;
            }
            assertTask(task, owner);
            if (accepted) {
              const evidence = recordTaskEvidence(task.progress, { scope: taskProgressScope(task.progress), actionId,
                kind: 'action', verified: true, changed: true, snapshotId: accepted.observation.snapshotId });
              if (evidence.accepted && evidence.evidenceId) {
                task.errorCount = 0;
                addStep('result', '已核对参考图片的新预览', '网页已接受本次参考图片；服务器处理或后续生成结果仍须页面核验。');
                pushRecent({ id: actionId, action: label, ok: true, signature, observedChange: true,
                  message: `已逐字节核对 ${action.args.referenceId} 的新预览，网站已接受这张参考图，无需再次上传。` });
                diagnose(task, owner, 'agent.verify.completed', { action: action.action, verified: true, observedChange: true },
                  null, { actionId, snapshotId: accepted.observation.snapshotId });
                reusableObservation = accepted.observation;
                render(); saveCheckpoint();
                continue;
              }
            }
            diagnose(task, owner, 'agent.verify.failed', { action: action.action, verified: false },
              { code: 'ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED', reason: 'check' }, { actionId });
          }
          await finishTask('页面动作可能已经执行，但结果未确认。任务已停止，请核对页面后再继续，避免重复提交。', 'failed', task);
          return;
        }
        if (result.error === 'ERR_UPLOAD_UNSUPPORTED') {
          pauseTask('当前页面不支持自动选择参考图片。请在网站中手动上传本次参考图，完成后点击“继续”；已有任务进度会保留。', { handoff: true });
          return;
        }
        if (result.ok === false || result.error) {
          if (['ERR_TASK_PAUSED', 'ERR_TASK_CANCELLED', 'ERR_PAGE_CHANGED'].includes(result.error)) {
            pauseTask(result.message || '后台执行已暂停，请核对页面后继续。');
            return;
          }
          task.errorCount = (task.errorCount || 0) + 1;
          addStep('error', '操作未完成', result.message || result.error);
          pushRecent({ action: label, ok: false, error: result.error, message: result.message || '', signature });
          if (result.error === 'ERR_ORIGIN_NOT_ALLOWED' && result.origin) {
            const granted = await ensureOrigin(task, result.origin, '这个操作需要新的站点授权。');
            assertTask(task, owner);
            if (granted) {
              pushRecent({ action: label, ok: false, error: 'ERR_ORIGIN_GRANTED', message: '已授权，下一轮重新观察。' });
            }
          }
          render();
          if (result.error === 'ERR_TAB_NOT_FOUND' || result.error === 'ERR_PAGE_RESTRICTED') {
            await finishTask(result.message || '页面不可用。', 'failed');
            break;
          }
          if (task.errorCount >= 3) {
            await finishTask('连续操作失败，任务已停止。', 'failed');
            break;
          }
          continue;
        }
        task.errorCount = 0;
        addStep('result', result.message || '动作完成', result.tabTitle || '');
        pushRecent({
          id: actionId,
          action: label,
          ok: true,
          message: result.message || '',
          signature,
        });
        task.pendingAction = { id: actionId, action: action.action, args: action.args, effect: result.effect, result, observation,
          needsVerification: trackedOutcome.needsVerification };
        if (result.tabUrl) task.currentOrigin = originOf(result.tabUrl) || task.currentOrigin;
        if (result.tabUrl) task.currentUrl = result.tabUrl;
        render();
        saveCheckpoint();
        await awaitWithAbort(delay(280), owner.controller.signal);
      }
    } catch (error) {
      if (state.task === task && state.owner === owner && task.status === 'running' && error.name !== 'AbortError') {
        await finishTask(error.message || '任务执行失败。', 'failed', task);
      }
    } finally {
      if (state.loopOwner === owner) {
        state.loopOwner = null;
        state.running = false;
        onStateChange();
        if (state.resumeRequested && state.task === task && task.status === 'paused') {
          state.resumeRequested = false;
          void resume();
        }
      }
    }
  }

  async function start(goal, { target = null, referenceImages = [], profile: submittedProfile = null } = {}) {
    assertActive();
    const content = String(goal || '').trim();
    if (!content || taskBusy()) return false;
    if (!getPageModeEnabled()) { toast(PAGE_MODE_REQUIRED); return false; }
    const profile = structuredClone(submittedProfile || getProfile?.());
    if (!profile) { toast('请先配置并启用一个模型。'); return false; }
    let images;
    try {
      images = normalizeAgentReferenceImages(referenceImages);
      assertAgentVision(images, profile);
      if (target) assertAgentReferenceTarget(images, target);
    } catch (error) { toast(error.message, 'error'); return false; }
    clearInteraction(true);
    const task = {
      id: makeId('task'), goal: content, tabId: target?.id ?? null, currentUrl: target?.url || '', startDocumentId: target?.documentId || '', origin: '', currentOrigin: '',
      status: 'preparing', phase: 'locate', phaseStartedAt: Date.now(), step: 0, maxSteps: 20,
      startedAt: nowIso(), deadline: Date.now() + 5 * 60000,
      steps: [], recent: [], visitedUrls: [], facts: [], pageReadings: [], errorCount: 0, settings: null,
      referenceImages: images, regionReadings: [], metrics: [],
      planningRequired: needsAgentPlan(content),
    };
    const owner = { task, controller: new AbortController() };
    modelProfiles.set(task, { profile, epoch: 0 });
    state.task = task;
    state.owner = owner;
    state.turn = null;
    state.cancelled = false;
    state.resumeRequested = false;
    state.mode = true;
    if (toggle) toggle.setAttribute('aria-pressed', 'true');
    showPanel();
    render();
    armWatchdog();
    onStateChange();
    try {
      const tab = await waitTask(task, () => queryActiveTab(), { phase: 'locate' });
      if (!tab?.id) throw new Error('没有找到可操作的当前标签页。');
      if (target && (tab.id !== target.id || tab.url !== target.url)) throw new Error('当前标签页已变化，任务未开始。请回到原页面后重试。');
      if (images.some(image => image.capture)) {
        const identity = await waitTask(task, () => sendMessage({ type: 'CAPTURE_PAGE_TARGET', tabId: tab.id, expectedUrl: tab.url }), { phase: 'locate' });
        if (identity?.error) throw new Error(identity.message || '无法核对截图页面，请重新截图。');
        assertAgentReferenceTarget(images, { ...identity, id: tab.id });
        if (identity?.documentId) task.startDocumentId = identity.documentId;
      }
      const pageError = agentPageError(tab.url);
      if (pageError) throw new Error(pageError);
      const origin = originOf(tab.url);
      if (!origin) throw new Error('当前页面不是可控制的 http/https 网页。');
      Object.assign(task, { tabId: tab.id, origin, currentOrigin: origin, currentUrl: tab.url });
      state.turn = createAgentTurn({ goal: content, taskId: task.id, startedAt: task.startedAt, model: profile.model || profile.id || '' });
      await waitTask(task, () => beginTurn?.({ ...state.turn, taskId: task.id, goal: content }, { signal: owner.controller.signal }), { phase: 'saving' });
      captureDiagnosticContext(task, owner);
      diagnose(task, owner, 'agent.task.started', { phase: task.phase, errorCount: 0 });
      addStep('info', '任务开始', content);
      const enabled = await ensureControlEnabled(task);
      if (!enabled) { await abortPreparation('已取消浏览器控制。', task); return false; }
      task.maxSteps = Math.min(12, task.settings.maxSteps);
      const granted = await ensureOrigin(task, origin, task.settings.autoApprove
        ? '自动批准模式：任务将在这个站点观察页面，提交、删除、上传等风险动作会直接执行。'
        : '任务将在这个站点观察页面，风险动作会在你确认后执行。');
      if (!granted) { await abortPreparation('未获得站点授权。', task); return false; }
      const active = await waitTask(task, () => queryActiveTab(), { phase: 'locate' });
      if (active?.id !== tab.id || active?.url !== tab.url) throw new Error('授权期间页面已变化，任务未开始。请核对页面后重试。');
      await activateExecution(task);
      assertTask(task, owner);
      task.status = 'running';
      task.deadline = task.budget.maxMinutes === 0 ? 0 : Date.now() + task.budget.maxMinutes * 60000;
      task.progress = createTaskProgress({ taskId: task.id, tabId: task.tabId, url: task.currentUrl, documentId: task.startDocumentId || '',
        maxSteps: task.maxSteps, hardMaxSteps: task.settings.maxSteps, deadline: task.deadline, executionRequired: task.planningRequired === true });
      startModelRun(task, owner);
      setPhase('observe', task);
      void saveCheckpoint();
      void setPageOverlay(true, '', task);
      render();
      onStateChange();
      void runLoop();
      return true;
    } catch (error) {
      if (state.task !== task || state.owner !== owner || error.name === 'AbortError') return false;
      await abortPreparation(error.message || '无法启动浏览器任务。', task, 'failed');
      return false;
    }
  }

  async function abortPreparation(reason, task = state.task, status = 'cancelled') {
    if (!task || state.task !== task) return;
    task.skipSummary = true;
    await finishTask(reason || '任务已取消。', status, task);
  }

  async function restore() {
    assertActive();
    const initialTask = state.task;
    const initialOwner = state.owner;
    let stored;
    try {
      const result = await awaitWithTimeout(chrome.storage.session.get(null), { timeoutMs: limits.preparation });
      const candidates = Object.entries(result || {})
        .filter(([key, value]) => (key === TASK_KEY || (key.startsWith(`${TASK_KEY}:`) && !key.startsWith(`${TASK_KEY}:ended:`))) && value?.id && value.goal)
        .map(([, value]) => value)
        .filter(value => !result[`${TASK_KEY}:ended:${value.id}`] && !['finished', 'failed', 'cancelled'].includes(value.status))
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
      stored = candidates[0];
    } catch {
      stored = null;
    }
    assertActive();
    if (!stored || !stored.goal || ['finished', 'failed', 'cancelled'].includes(stored.status)) return;
    const settings = await bestEffort(() => getAgentSettings(), limits.preparation);
    assertActive();
    if (!settings || state.task !== initialTask || state.owner !== initialOwner || taskBusy()) return;
    state.task = {
      ...stored,
      settings,
      status: 'paused',
      phase: 'idle',
      pausedReason: '检测到上次任务中断。',
      errorCount: 0,
      recent: [],
      visitedUrls: [],
      facts: Array.isArray(stored.facts) ? stored.facts : [],
      progress: null,
      savedProgress: stored.progress,
      planningRequired: stored.planningRequired === true || needsAgentPlan(stored.goal),
    };
    const task = state.task;
    const owner = { task, controller: new AbortController() };
    state.owner = owner;
    state.turn = createAgentTurn({
      goal: stored.goal,
      taskId: stored.id,
      startedAt: stored.startedAt,
    });
    let restored;
    try { restored = await waitTask(task, () => restoreTurn?.({
      taskId: stored.id,
      goal: stored.goal,
      startedAt: stored.startedAt,
    }, { signal: owner.controller.signal }), { phase: 'saving' }); }
    catch { if (state.task !== task || state.owner !== owner) return; }
    assertTask(task, owner);
    captureDiagnosticContext(task, owner);
    if (restored?.agent) {
      state.turn = {
        ...state.turn,
        steps: Array.isArray(restored.agent.steps) ? restored.agent.steps : [],
        status: 'running',
      };
    }
    state.mode = true;
    if (toggle) toggle.setAttribute('aria-pressed', 'true');
    showPanel();
    renderHeader();
    render();
    onStateChange();
    addStep('warning', '检测到上次任务中断', '未自动重放任何页面动作；请核对页面后继续。');
    pauseTask('检测到扩展重启或侧栏关闭，任务已暂停。请核对当前页面后继续。');
  }

  function closePanel() {
    if (taskBusy()) {
      const task = state.task;
      void stop('user').then(() => {
        if (state.task !== task) return;
        setMode(false, { silent: true });
        hidePanel();
        onStateChange();
      });
      return;
    }
    state.task = null;
    state.turn = null;
    setMode(false, { silent: true });
    hidePanel();
    onStateChange();
  }

  try {
    listenDom(toggle, 'click', toggleMode);
    listenDom(stopButton, 'click', () => void stop('user'));
    listenDom(closeButton, 'click', closePanel);
    listenDom(takeoverButton, 'click', () => {
      if (!state.task) return;
      if (state.task.status === 'paused') void resume();
      else pauseTask('你已接管页面。准备好后点击继续。');
    });
    listenChrome(chrome.tabs?.onActivated, ({ tabId }) => {
      if (!state.task || !taskBusy() || state.task.status === 'paused') return;
      if (tabId !== state.task.tabId) {
        if (state.task.status === 'preparing') { void stop('你切换了标签页，已停止任务准备。'); return; }
        pauseTask('你切换了标签页，任务已暂停。');
      }
    });
    listenChrome(chrome.tabs?.onUpdated, (tabId, info) => {
      const task = state.task;
      if (!task || task.tabId !== tabId || !['preparing', 'running'].includes(task.status) || task.phase === 'act') return;
      if (info.status === 'loading' || (info.url && info.url !== task.currentUrl)) {
        if (task.status === 'preparing') { void stop('页面发生导航或刷新，已停止任务准备。'); return; }
        pauseTask('页面发生导航或刷新，已暂停，请核对后继续。');
      }
    });
    listenChrome(chrome.runtime?.onMessage, (message) => {
      if (message?.type !== 'AGENT_TAKEOVER') return false;
      if (!state.task || message.tabId !== state.task.tabId) return false;
      if (message.taskId && message.taskId !== state.task.id) return false;
      if (taskBusy() && state.task.status !== 'paused') {
        pauseTask('检测到你操作了页面，已暂停自动操作。现在可以手动操作；准备好后点击继续。', { handoff: true });
      }
      return false;
    });
    assertActive();
  } catch (error) {
    dispose();
    throw error;
  }

  return Object.freeze({
    isMode: () => state.mode,
    isBusy: taskBusy,
    toggleMode,
    setMode,
    start,
    stop,
    resume,
    restore,
    closePanel,
    dispose,
    getTask: () => state.task,
  });
}

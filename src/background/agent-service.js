import {
  AGENT_ACTIONS,
  normalizeAgentAction,
} from '../utils/agent-schema.js';
import {
  agentPageError,
  getAgentSettings,
  getOriginGrant,
  getOriginGrants,
  originOf,
} from '../utils/agent-permissions.js';
import {
  assessAgentAction,
  classifyElement,
} from '../utils/agent-safety.js';
import { combinePageEvidence } from '../utils/agent-evidence.js';
import { createAgentRuntime } from '../utils/agent-runtime.js';
import { createAgentUploadRegistry } from '../utils/agent-upload.js';
import { awaitWithAbort, awaitWithTimeout } from '../utils/abortable.js';
import { recordDiagnostic } from '../utils/diagnostic-log.js';
import { createAgentDiagnosticReporter, agentDiagnosticError } from '../utils/agent-diagnostics.js';
import { withPageDebugger } from './network-reading-service.js';

const AGENT_SCANNER_FILES = ['content/agent-scanner.js'];
const AGENT_READER_FILES = ['content/extractor.js'];
const MAX_ELEMENTS = 80;
const LOAD_TIMEOUT = 20000;
const CAPTURE_QUALITY = 62;
const CAPTURE_TIMEOUT = 3000;
const UPLOAD_VERIFY_TIMEOUT = 3000;
const OBSERVE_TIMEOUT = 20000;
const OVERLAY_TIMEOUT = 2000;
const ALL_FRAMES_TIMEOUT = 2500;
const READ_PAGE_TIMEOUT = 20000;
const READ_PAGE_BUDGET = 10000;
const AUTHORITY_TIMEOUT = 3000;
const INTERRUPT_TIMEOUT = 2000;
// Keep this permission-bearing projection aligned with the injected scanner.
const ELEMENT_SEMANTIC_FIELDS = 'tag role name text type autocomplete domId fieldName disabled contentEditable inputMode href targetOrigin targetBlank download formRole formAction formOrigin formIsSearch scrollOnly readable readOnly regionKind fileInput uploadOnly'.split(' ');
const semanticValue = (key, value) => key === 'fileInput' && value
  ? { accept: value.accept || '', multiple: value.multiple === true, directory: value.directory === true,
    viaLabel: value.viaLabel === true, viaOverlay: value.viaOverlay === true } : value;
const semanticSignature = value => JSON.stringify(Object.fromEntries(ELEMENT_SEMANTIC_FIELDS
  .filter(key => Object.prototype.hasOwnProperty.call(value || {}, key)).map(key => [key, semanticValue(key, value[key])])));
const changedSemanticFields = (before, after) => ELEMENT_SEMANTIC_FIELDS.filter(key =>
  JSON.stringify(semanticValue(key, before?.[key])) !== JSON.stringify(semanticValue(key, after?.[key])));

const snapshots = new Map();
const runtime = createAgentRuntime(chrome.storage.session);
const uploadRegistry = createAgentUploadRegistry();
const activeReadBoundaries = new Set();
const taskEpochs = new Map();
const taskScopes = new Map();
const pendingTaskScopes = new Set();

/** Bound only observation/UI work; uncertain DOM actions keep their runtime queue lock. */
function createReadBoundary(message, timeoutMs, code, timeoutMessage) {
  const controller = new AbortController();
  const error = (errorCode, detail) => Object.assign(new Error(detail), { code: errorCode });
  const boundary = {
    tabId: message.tabId,
    taskId: message.taskId,
    epoch: taskEpochs.get(message.taskId),
    signal: controller.signal,
    expiresAt: Date.now() + timeoutMs,
    cancel(cancelled = false) {
      controller.abort(error(cancelled ? 'ERR_TASK_CANCELLED' : 'ERR_TASK_PAUSED', '任务已暂停或结束，页面读取已取消。'));
    },
    pageChanged() {
      controller.abort(error('ERR_PAGE_CHANGED', '页面在读取期间已变化，请重新观察。'));
    },
    check(lease) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (Date.now() >= this.expiresAt) {
        controller.abort(error(code, timeoutMessage));
        throw controller.signal.reason;
      }
      if (lease) runtime.check(lease);
    },
    async wait(operation, lease) {
      this.check(lease);
      const cancel = () => this.cancel();
      lease?.signal?.addEventListener('abort', cancel, { once: true });
      if (lease?.signal?.aborted) cancel();
      try {
        const result = await awaitWithAbort(Promise.resolve().then(() => {
          this.check(lease);
          return operation();
        }), controller.signal);
        this.check(lease);
        return result;
      } finally {
        lease?.signal?.removeEventListener('abort', cancel);
      }
    },
    dispose() {
      clearTimeout(timer);
      activeReadBoundaries.delete(this);
    },
  };
  const timer = setTimeout(() => controller.abort(error(code, timeoutMessage)), timeoutMs);
  activeReadBoundaries.add(boundary);
  return boundary;
}

export async function pauseAgentTask(message, { cancelled = false, expectedEpoch } = {}) {
  const pageEpoch = expectedEpoch ?? taskEpochs.get(message.taskId);
  const reads = [...activeReadBoundaries].filter(boundary => boundary.taskId === message.taskId
    && boundary.tabId === message.tabId && (pageEpoch === undefined || boundary.epoch === pageEpoch));
  const snapshot = snapshots.get(message.tabId);
  let cleanup = Promise.resolve();
  const interruption = runtime.interrupt(message, cancelled, { expectedEpoch, onInterrupt() {
    for (const boundary of reads) boundary.cancel(cancelled);
    if (snapshot?.taskId === message.taskId && snapshots.get(message.tabId) === snapshot
      && (pageEpoch === undefined || snapshot.epoch === pageEpoch)) clearSnapshot(message.tabId);
    // Dispatch page invalidation after the runtime's epoch comparison, but
    // before its storage wait. Neither late cleanup nor a hung write may
    // remove a newer guard or postpone revoking the original document.
    if (Number.isFinite(pageEpoch)) cleanup = awaitWithTimeout(Promise.resolve().then(() => chrome.scripting.executeScript({
      target: { tabId: message.tabId, allFrames: true }, injectImmediately: true,
      func: (taskId, expectedEpoch) => {
        globalThis.__unkAiAgentScanner?.cancelTask?.(taskId, expectedEpoch);
        globalThis.__unkAiAgentScanner?.removeOverlay?.(taskId, expectedEpoch);
      },
      args: [message.taskId, pageEpoch],
    })), { timeoutMs: INTERRUPT_TIMEOUT }).catch(() => {});
  } });
  try {
    await awaitWithTimeout(interruption, { timeoutMs: INTERRUPT_TIMEOUT, message: '任务已在本地停止，但后台暂停记录尚未确认。' });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw Object.assign(new Error(error.message, { cause: error }), { code: 'ERR_TASK_PAUSE_UNCONFIRMED' });
    throw error;
  }
  await cleanup;
  return { ok: true };
}

function agentError(code, message, extra = {}) {
  return { error: code, message, ...extra };
}

function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function snapshotId() {
  return `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clearSnapshot(tabId) {
  snapshots.delete(tabId);
}

function activeSnapshot(tabId, snapshot) {
  const current = snapshots.get(tabId);
  if (!current || current.snapshotId !== snapshot) {
    throw new Error('ERR_SNAPSHOT_EXPIRED');
  }
  return current;
}

async function tabFor(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('ERR_TAB_INVALID');
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('ERR_TAB_NOT_FOUND');
  }
  if (!tab?.id) throw new Error('ERR_TAB_NOT_FOUND');
  const pageError = agentPageError(tab.url);
  if (pageError) {
    const error = new Error(pageError);
    error.code = 'ERR_PAGE_RESTRICTED';
    throw error;
  }
  return tab;
}

async function controlFor(tab, taskId) {
  const settings = await getAgentSettings();
  if (!settings.enabled) {
    const error = new Error('浏览器控制已关闭。请在任务面板中开启。');
    error.code = 'ERR_CONTROL_DISABLED';
    throw error;
  }
  const origin = originOf(tab.url);
  if (!origin) {
    const error = new Error('当前页面不是可控制的 http/https 网页。');
    error.code = 'ERR_PAGE_RESTRICTED';
    throw error;
  }
  const grant = await getOriginGrant(origin, taskId);
  if (!grant) {
    const error = new Error(`尚未授权控制 ${origin}。`);
    error.code = 'ERR_ORIGIN_NOT_ALLOWED';
    error.origin = origin;
    throw error;
  }
  return { settings, origin, grant };
}

function grantsTask(grant, taskId) {
  return grant?.scope === 'always' || (grant?.scope === 'task' && grant.taskId === taskId);
}

function rememberTaskOrigins(lease, origins, { replace = false } = {}) {
  runtime.check(lease);
  const current = taskScopes.get(lease.task.id);
  if (current?.epoch !== lease.epoch) return;
  current.origins = new Set([...(replace ? [] : current.origins), ...origins.filter(Boolean)]);
}

/** Fresh authority at a final read/write boundary; a stalled lookup never authorizes work. */
async function verifyAuthority(tab, taskId, origins, lease) {
  runtime.check(lease);
  let settings, grants;
  try {
    [settings, grants] = await awaitWithTimeout(Promise.all([getAgentSettings(), getOriginGrants()]), {
      signal: lease.signal, timeoutMs: AUTHORITY_TIMEOUT, message: '核对页面操作权限超时，未授权执行后续操作。',
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw Object.assign(new Error(error.message, { cause: error }), { code: 'ERR_AGENT_PERMISSION_TIMEOUT' });
    throw error;
  }
  runtime.check(lease);
  if (!settings.enabled) throw Object.assign(new Error('浏览器控制已关闭。'), { code: 'ERR_CONTROL_DISABLED' });
  const mainOrigin = originOf(tab?.url);
  if (!mainOrigin) throw Object.assign(new Error('当前页面不是可控制的 http/https 网页。'), { code: 'ERR_PAGE_RESTRICTED' });
  for (const origin of new Set([mainOrigin, ...origins.filter(Boolean)])) {
    if (!grantsTask(grants[origin], taskId)) throw Object.assign(new Error(`页面控制授权已失效：${origin}。`), {
      code: 'ERR_ORIGIN_NOT_ALLOWED', origin,
    });
  }
  return settings;
}

function assessmentFailure(assessment, message) {
  if (assessment.level === 'blocked') return agentError('ERR_SAFETY_BLOCKED', assessment.reason || '这个动作被安全策略阻断。', {
    risk: 'blocked', reason: assessment.reason || '',
  });
  if (needsApproval(assessment) && !approvalSatisfied(message)) return agentError('ERR_SAFETY_BLOCKED', assessment.reason || '这个动作需要用户确认。', {
    risk: 'confirm', reason: assessment.reason || '', requiresConfirmation: true,
  });
  return null;
}

function onAgentAuthorityChanged(changes, area) {
  if (area !== 'local' || (!changes.agentSettings && !changes.agentOriginGrants)) return;
  const setting = changes.agentSettings;
  const restricted = setting && (setting.newValue?.enabled !== true
    || (setting.newValue?.strictMode === true && setting.oldValue?.strictMode !== true));
  const grants = changes.agentOriginGrants;
  // Capture running epochs synchronously, including activation still waiting
  // for its first session write. The runtime compares them again after ready().
  for (const owner of runtime.activeTasks()) {
    const scope = taskScopes.get(owner.taskId);
    const origins = scope?.tabId === owner.tabId && scope.epoch === owner.epoch ? [...scope.origins] : [];
    for (const pending of pendingTaskScopes) {
      if (pending.taskId === owner.taskId && pending.tabId === owner.tabId) origins.push(pending.origin);
    }
    if (!origins.length) origins.push(...Object.keys(grants?.oldValue || {}));
    const revoked = grants && origins.some(origin => grantsTask(grants.oldValue?.[origin], owner.taskId)
      && !grantsTask(grants.newValue?.[origin], owner.taskId));
    if (restricted || revoked) void pauseAgentTask(owner, { expectedEpoch: owner.epoch }).catch(() => {});
  }
}

chrome.storage?.onChanged?.addListener(onAgentAuthorityChanged);

function scanInjected(snapshot, maxElements, options) {
  if (Date.now() >= options.expiresAt) return { error: 'ERR_PAGE_OBSERVE_TIMEOUT' };
  const origin = globalThis.location.origin;
  if (!options.origins.includes(origin)) return { blockedOrigin: origin };
  const scanner = globalThis.__unkAiAgentScanner;
  if (!scanner) {
    return { error: 'ERR_SCANNER_MISSING', message: '页面扫描器未注入。' };
  }
  const result = scanner.scan(snapshot, { maxElements, taskId: options.taskId, epoch: options.epoch });
  if (Date.now() >= options.expiresAt) {
    globalThis.__unkAiAgentSnapshots?.delete(snapshot);
    return { error: 'ERR_PAGE_OBSERVE_TIMEOUT' };
  }
  return result;
}

async function injectScanner(tabId, boundary, lease, allFrames = true) {
  try {
    await boundary.wait(() => {
      const pending = chrome.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId },
        injectImmediately: true,
        files: AGENT_SCANNER_FILES,
      });
      return allFrames ? awaitWithTimeout(pending, { signal: boundary.signal, timeoutMs: ALL_FRAMES_TIMEOUT }) : pending;
    }, lease);
    return { allFrames };
  } catch {
    boundary.check(lease);
    if (!allFrames) return false;
    try {
      await boundary.wait(() => chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, files: AGENT_SCANNER_FILES }), lease);
      return { allFrames: false };
    } catch {
      boundary.check(lease);
      return false;
    }
  }
}

async function runScan(tabId, id, options, boundary, lease, allFrames = true) {
  try {
    return await boundary.wait(() => {
      const scanOptions = allFrames
        ? { ...options, expiresAt: Math.min(options.expiresAt, Date.now() + ALL_FRAMES_TIMEOUT) }
        : options;
      const pending = chrome.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId },
        injectImmediately: true,
        func: scanInjected,
        args: [id, MAX_ELEMENTS, scanOptions],
      });
      return allFrames ? awaitWithTimeout(pending, { signal: boundary.signal, timeoutMs: ALL_FRAMES_TIMEOUT }) : pending;
    }, lease);
  } catch {
    boundary.check(lease);
    if (!allFrames) throw new Error('ERR_PAGE_SCAN_FAILED');
    return boundary.wait(() => chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: scanInjected,
      args: [id, MAX_ELEMENTS, options],
    }), lease);
  }
}

async function toggleAgentOverlay(tabId, { visible, taskId = '', goal = '', label = '', epoch } = {}, boundary, lease) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'ERR_TAB_INVALID' };
  if (!visible && !Number.isFinite(epoch)) return { ok: true };
  try {
    if (visible && !await injectScanner(tabId, boundary, lease, false)) {
      return { ok: false, error: 'ERR_SCANNER_MISSING' };
    }
    const results = await boundary.wait(() => chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: ({ shouldShow, taskId: id, goal: text, label: caption, epoch, expiresAt }) => {
        if (Date.now() >= expiresAt) return { ok: false, error: 'ERR_OVERLAY_TIMEOUT' };
        const scanner = globalThis.__unkAiAgentScanner;
        if (!scanner) return { ok: false, error: 'ERR_SCANNER_MISSING' };
        return shouldShow
          ? scanner.showOverlay({ taskId: id, goal: text, label: caption, epoch })
          : scanner.removeOverlay(id, epoch);
      },
      args: [{
        shouldShow: visible === true,
        taskId: String(taskId || ''),
        goal: String(goal || ''),
        label: String(label || ''),
        epoch: lease?.epoch ?? epoch,
        expiresAt: boundary.expiresAt,
      }],
    }), lease);
    return results?.[0]?.result || { ok: true };
  } catch {
    boundary.check(lease);
    return { ok: false, error: 'ERR_OVERLAY_FAILED' };
  }
}

function mergeFlags(results) {
  return results.reduce((flags, entry) => {
    const current = entry?.result?.flags || {};
    flags.passwordField = flags.passwordField || current.passwordField === true;
    flags.captcha = flags.captcha || current.captcha === true;
    flags.login = flags.login || current.login === true;
    flags.uploadRequiresHandoff = flags.uploadRequiresHandoff || current.uploadRequiresHandoff === true;
    return flags;
  }, { passwordField: false, captcha: false, login: false });
}

function frameLabel(result, frameId) {
  return result?.isTop ? '主页面' : `iframe ${frameId}`;
}

async function observeAgentPage({ tabId, taskId } = {}, lease, boundary, diagnostic) {
  const started = performance.now();
  diagnostic?.check('tab');
  const tab = await boundary.wait(() => tabFor(tabId), lease);
  diagnostic?.check('control-permission');
  const { settings } = await boundary.wait(() => controlFor(tab, taskId), lease);
  let uploadReferences = [];
  try { uploadReferences = uploadRegistry.list({ taskId, epoch: lease.epoch, tabId, url: tab.url, signal: lease.signal }); }
  catch (error) { if (error?.code !== 'ERR_UPLOAD_SCOPE') throw error; }
  const grants = await boundary.wait(() => getOriginGrants(), lease);
  const origins = Object.entries(grants).filter(([, grant]) => grant.scope === 'always' || grant.taskId === taskId).map(([origin]) => origin);
  rememberTaskOrigins(lease, origins);
  boundary.check(lease);
  const id = snapshotId();
  diagnostic?.check('inject', {}, { snapshotId: id });
  const injected = await injectScanner(tabId, boundary, lease, true);
  if (!injected) return agentError('ERR_SCANNER_MISSING', '无法向当前页面注入扫描器。');
  let results;
  try {
    boundary.check(lease);
    diagnostic?.check('scan');
    results = await runScan(tabId, id, { origins, taskId, epoch: lease.epoch, expiresAt: boundary.expiresAt }, boundary, lease, injected.allFrames);
  } catch {
    boundary.check(lease);
    return agentError('ERR_PAGE_SCAN_FAILED', '无法读取当前页面。请刷新页面后重试。');
  }
  const valid = (Array.isArray(results) ? results : [])
    .filter((entry) => entry?.result && !entry.result.error && !entry.result.blockedOrigin)
    .sort((left, right) => (Number(right.result.isTop) - Number(left.result.isTop)) || (left.frameId - right.frameId));
  const top = valid.find((entry) => entry.frameId === 0 && entry.result.isTop);
  if (!top) return agentError('ERR_PAGE_SCAN_FAILED', '页面没有返回可用的观察结果。');
  const records = new Map();
  const elements = [];
  const frameQueues = valid.map(frame => (frame.result.elements || []).map(element => ({ frame, element })));
  const candidateCount = frameQueues.reduce((sum, queue) => sum + queue.length, 0);
  const chosen = [];
  let scrollCount = 0;
  while (chosen.length < MAX_ELEMENTS && frameQueues.some(queue => queue.length)) {
    for (const queue of frameQueues) {
      let candidate;
      while (queue.length) {
        const next = queue.shift();
        if (next.element.scroll && scrollCount >= 8) continue;
        candidate = next;
        break;
      }
      if (!candidate) continue;
      chosen.push(candidate);
      if (candidate.element.scroll) scrollCount += 1;
      if (chosen.length === MAX_ELEMENTS) break;
    }
  }
  const mergeOmittedCount = candidateCount - chosen.length;
  const globalIds = new Map(chosen.map(({ frame, element }, index) => [`${frame.frameId}:${element.id}`, `e${index + 1}`]));
  for (const { frame, element } of chosen) {
    const label = frameLabel(frame.result, frame.frameId);
      const elementId = globalIds.get(`${frame.frameId}:${element.id}`);
      // Layout and scroll positions are observations, not permission-bearing
      // metadata. Keep the scanner's semantic signature independently stable.
      const { id: localId, stableKey, layout, state, select, scroll, navigation, rect, ...meta } = element;
      const targetKey = stableKey ? `f${frame.frameId}:${stableKey}` : '';
      const classification = classifyElement(meta, { currentUrl: top.result.url });
      let uploadCapability;
      if (meta.uploadOnly && meta.fileInput) {
        const referenceIds = meta.fileInput.supported && !meta.fileInput.directory ? uploadReferences.filter(reference =>
          assessAgentAction({ action: 'upload_reference_image', args: { elementId, referenceId: reference.referenceId },
            elements: [{ ...meta, id: elementId, frameOrigin: originOf(frame.result.url) }], settings,
            currentUrl: tab.url, uploadReferences }).level === 'confirm').map(reference => reference.referenceId) : [];
        uploadCapability = { risk: referenceIds.length ? 'confirm' : 'blocked', referenceIds,
          reason: referenceIds.length ? '专用上传可选择这些任务参考图，每次需要确认；普通点击和输入仍被禁止。'
            : '当前没有可用于此控件的任务参考图，或上传控件不受支持；需要用户接管。' };
      }
      records.set(elementId, {
        frameId: frame.frameId,
        frameOrigin: originOf(frame.result.url),
        frameUrl: frame.result.url,
        documentId: frame.documentId,
        localId,
        meta,
        stableKey: targetKey,
      });
      const containerId = layout?.scrollContainerId && globalIds.get(`${frame.frameId}:${layout.scrollContainerId}`);
      const mappedLayout = layout ? { ...layout } : null;
      if (mappedLayout) {
        delete mappedLayout.scrollContainerId;
        delete mappedLayout.scrollContainerKey;
        if (containerId) {
          mappedLayout.scrollContainerId = containerId;
          mappedLayout.scrollContainerKey = `f${frame.frameId}:${layout.scrollContainerKey}`;
        }
      }
      elements.push({
        ...meta,
        id: elementId,
        ...(targetKey ? { stableKey: targetKey } : {}),
        ...(mappedLayout ? { layout: mappedLayout } : {}),
        ...(state ? { state } : {}),
        ...(select ? { select } : {}),
        ...(uploadCapability ? { uploadCapability } : {}),
        ...(scroll ? { scroll } : {}),
        ...(navigation ? { navigation } : {}),
        frame: label,
        frameId: frame.frameId,
        mainFrame: frame.result.isTop === true,
        ...(rect ? { rect } : {}),
        risk: classification.level,
        riskReason: classification.reason || '',
        targetOrigin: classification.targetOrigin || meta.targetOrigin || '',
      });
  }
  const observation = {
    snapshotId: id,
    documentId: valid.find(entry => entry.frameId === 0 && entry.result.isTop)?.documentId,
    tabId,
    url: String(top.result.url || tab.url || ''),
    title: String(top.result.title || tab.title || ''),
    summary: String(top.result.summary || ''),
    scrollY: Number(top.result.scrollY) || 0,
    pageHeight: Number(top.result.pageHeight) || 0,
    viewport: top.result.viewport,
    scroll: top.result.scroll,
    content: top.result.content,
    flags: mergeFlags(valid),
    elements,
    frames: valid.length,
    blockedFrameOrigins: [...new Set(results.map((entry) => entry.result?.blockedOrigin).filter(Boolean))],
    capturedAt: new Date().toISOString(),
    metrics: {
      observeMs: Math.max(0, performance.now() - started),
      scanMs: valid.reduce((sum, frame) => sum + (Number(frame.result.metrics?.scanMs) || 0), 0),
      candidateCount: valid.reduce((sum, frame) => sum + (Number(frame.result.metrics?.candidateCount) || 0), 0),
      layoutNodeCount: valid.reduce((sum, frame) => sum + (Number(frame.result.metrics?.layoutNodeCount) || 0), 0),
      returnedCount: elements.length,
      omittedCount: mergeOmittedCount + valid.reduce((sum, frame) => sum + Math.max(0, Number(frame.result.metrics?.omittedCount) || 0), 0),
      candidateTruncated: mergeOmittedCount > 0 || valid.some(frame => frame.result.metrics?.candidateTruncated === true),
      scanTruncated: mergeOmittedCount > 0 || valid.some(frame => frame.result.metrics?.scanTruncated === true
        || frame.result.metrics?.candidateTruncated === true),
    },
  };
  const latest = await boundary.wait(() => tabFor(tabId), lease);
  checkExpectedUrl({ expectedUrl: tab.url }, latest);
  checkExpectedUrl({ expectedUrl: top.result.url }, latest);
  const observedOrigins = valid.map(frame => originOf(frame.result.url));
  await boundary.wait(() => verifyAuthority(latest, taskId, observedOrigins, lease), lease);
  const documents = await boundary.wait(() => chrome.scripting.executeScript({
    target: { tabId, frameIds: valid.map(frame => frame.frameId) },
    func: () => globalThis.location.href,
  }), lease);
  for (const frame of valid) {
    const current = documents?.find(entry => entry.frameId === frame.frameId);
    if (!current || (frame.documentId && current.documentId !== frame.documentId) || current.result !== frame.result.url) {
      return agentError('ERR_PAGE_CHANGED', '观察期间页面或框架文档已变化，请重新观察。');
    }
  }
  rememberTaskOrigins(lease, observedOrigins, { replace: true });
  boundary.check(lease);
  observation.metrics.observeMs = Math.max(0, performance.now() - started);
  snapshots.set(tabId, {
    snapshotId: id,
    taskId,
    epoch: lease.epoch,
    documentId: valid.find((entry) => entry.frameId === 0 && entry.result.isTop)?.documentId,
    elements: records,
    observation,
    createdAt: Date.now(),
  });
  diagnostic?.check('complete', { elementCount: elements.length, frameCount: valid.length }, {
    snapshotId: id, documentId: valid.find(entry => entry.frameId === 0)?.documentId,
  });
  return observation;
}

async function executeInFrame(tabId, frameId, localId, action, args, snapshot, expected) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: expected.documentId ? { tabId, documentIds: [expected.documentId] } : { tabId, frameIds: [frameId] },
      func: (id, elementId, name, actionArgs, expectation) => {
        const scanner = globalThis.__unkAiAgentScanner;
        return scanner?.perform(id, elementId, name, actionArgs, expectation)
          || { ok: false, error: 'ERR_SCANNER_MISSING', message: '页面扫描器未注入。' };
      },
      args: [snapshot, localId, action, args, expected],
    });
    return result || { ok: false, error: 'ERR_ACTION_FAILED', message: '页面没有返回操作结果。' };
  } catch {
    return {
      ok: false,
      error: 'ERR_ACTION_FAILED',
      message: '页面在操作过程中发生变化，请重新观察。',
    };
  }
}

function needsApproval(assessment) {
  return assessment.level === 'confirm';
}

function approvalSatisfied(message) {
  return message?.approval?.confirmed === true
    && typeof message.approval.actionId === 'string'
    && message.approval.actionId === message.actionId;
}

function checkExpectedUrl(message, tab) {
  if (message.expectedUrl && String(tab?.url || '') !== message.expectedUrl) {
    throw Object.assign(new Error('页面地址已变化，请核对页面后重新观察。'), { code: 'ERR_PAGE_CHANGED' });
  }
}

async function performAgentAction(message = {}, lease, diagnostic) {
  diagnostic?.check('tab');
  const tab = await tabFor(message.tabId);
  diagnostic?.check('page-target');
  checkExpectedUrl(message, tab);
  diagnostic?.check('page-target', { status: 'completed' });
  diagnostic?.check('control-permission');
  const { settings } = await controlFor(tab, message.taskId);
  diagnostic?.check('control-permission', { status: 'completed' });
  let action;
  try {
    diagnostic?.check('normalize');
    action = normalizeAgentAction({ action: message.action, args: message.args });
  } catch (error) {
    return agentError('ERR_ACTION_INVALID', error.message || '动作参数无效。');
  }
  if (action.action === AGENT_ACTIONS.navigate) {
    return navigateAgentPage({ ...message, args: action.args }, lease, diagnostic);
  }
  if (action.action === AGENT_ACTIONS.wait) {
    return waitAgentPage({ ...message, args: action.args }, lease, diagnostic);
  }
  if (![AGENT_ACTIONS.click, AGENT_ACTIONS.type, AGENT_ACTIONS.press, AGENT_ACTIONS.scroll, AGENT_ACTIONS.select, 'upload_reference_image'].includes(action.action)) {
    return agentError('ERR_ACTION_INVALID', '这个动作由任务面板处理，不发送到页面。');
  }

  let current;
  try {
    diagnostic?.check('snapshot');
    current = activeSnapshot(message.tabId, message.snapshotId);
    diagnostic?.check('snapshot', { status: 'completed', snapshotAgeMs: Math.max(0, Date.now() - current.createdAt) });
  } catch {
    return agentError('ERR_SNAPSHOT_EXPIRED', '页面快照已过期，请重新观察。');
  }
  let record;
  diagnostic?.check('element');
  if ((action.action === AGENT_ACTIONS.scroll || action.action === AGENT_ACTIONS.press) && !action.args.elementId) {
    record = { frameId: 0, frameOrigin: originOf(tab.url), localId: '', meta: {} };
  } else {
    record = current.elements.get(action.args.elementId);
  }
  if (!record) return agentError('ERR_ELEMENT_NOT_FOUND', '目标元素不在当前快照中。');

  diagnostic?.check('frame-permission', { frameId: record.frameId, tag: record.meta?.tag, role: record.meta?.role,
    inputType: record.meta?.type, disabled: record.meta?.disabled === true }, { documentId: record.documentId });
  if (!await getOriginGrant(record.frameOrigin, message.taskId)) {
    return agentError('ERR_ORIGIN_NOT_ALLOWED', '目标 iframe 尚未授权。', { origin: record.frameOrigin });
  }
  diagnostic?.check('frame-permission', { status: 'completed' });
  runtime.check(lease);
  diagnostic?.check('inspect');
  const inspections = await chrome.scripting.executeScript({
    target: record.documentId ? { tabId: message.tabId, documentIds: [record.documentId] } : { tabId: message.tabId, frameIds: [record.frameId] },
    func: (id, elementId) => globalThis.__unkAiAgentScanner?.inspect(id, elementId)
      || { error: 'ERR_SCANNER_MISSING', message: '页面扫描器未注入。' },
    args: [message.snapshotId, record.localId],
  });
  if (record.documentId && inspections?.[0]?.documentId !== record.documentId) {
    return agentError('ERR_PAGE_CHANGED', '目标文档已变化，请重新观察。');
  }
  const inspection = inspections?.[0]?.result;
  if (!inspection || inspection.error) return inspection || agentError('ERR_ELEMENT_NOT_FOUND', '无法重新校验目标元素。');
  diagnostic?.check('frame-target');
  if (originOf(inspection.url) !== record.frameOrigin) {
    return agentError('ERR_ELEMENT_CHANGED', 'iframe 来源已变化，请重新观察。');
  }
  diagnostic?.check('frame-target', { status: 'completed' });
  const freshMeta = inspection.meta || {};
  diagnostic?.check('element-signature');
  if (record.localId) {
    const changedFields = changedSemanticFields(record.meta, freshMeta);
    if (changedFields.length) {
      diagnostic?.check('element-signature', { changedFields });
      return agentError('ERR_ELEMENT_CHANGED', '元素的文字、字段或跳转目标已变化，请重新观察并确认。');
    }
  }
  const assessedId = action.args.elementId || 'e0';
  diagnostic?.check('element-signature', { status: 'completed' });

  diagnostic?.check('safety');
  const assessment = assessAgentAction({
    action: action.action,
    args: { ...action.args, elementId: assessedId },
    elements: freshMeta.name || freshMeta.role
      ? [{ ...freshMeta, id: assessedId }]
      : [],
    settings,
    currentUrl: inspection.url,
    uploadReferences: action.action === 'upload_reference_image'
      ? uploadRegistry.list({ taskId: message.taskId, epoch: lease.epoch, tabId: message.tabId, url: tab.url, signal: lease.signal }) : [],
  });
  if (assessment.level === 'blocked') {
    return agentError('ERR_SAFETY_BLOCKED', assessment.reason || '这个动作被安全策略阻断。', {
      risk: 'blocked',
      reason: assessment.reason || '',
    });
  }
  diagnostic?.check('safety', { status: 'completed' });
  if (assessment.targetOrigin && assessment.targetOrigin !== originOf(tab.url)) {
    diagnostic?.check('target-permission');
    const grant = await getOriginGrant(assessment.targetOrigin, message.taskId);
    if (!grant) {
      return agentError('ERR_ORIGIN_NOT_ALLOWED', `尚未授权访问 ${assessment.targetOrigin}。`, {
        origin: assessment.targetOrigin,
        risk: assessment.level,
      });
    }
    diagnostic?.check('target-permission', { status: 'completed' });
  }
  diagnostic?.check('approval');
  if (needsApproval(assessment) && !approvalSatisfied(message)) {
    return agentError('ERR_SAFETY_BLOCKED', assessment.reason || '这个动作需要用户确认。', {
      risk: 'confirm',
      reason: assessment.reason || '',
      requiresConfirmation: true,
    });
  }
  diagnostic?.check('approval', { status: 'completed' });

  diagnostic?.check('recheck');
  rememberTaskOrigins(lease, [record.frameOrigin, assessment.targetOrigin]);
  const before = await chrome.tabs.get(message.tabId).catch(() => null);
  checkExpectedUrl(message, before);
  const currentSettings = await verifyAuthority(before, message.taskId, [record.frameOrigin, assessment.targetOrigin], lease);
  const finalAssessment = assessAgentAction({ action: action.action, args: { ...action.args, elementId: assessedId },
    elements: freshMeta.name || freshMeta.role ? [{ ...freshMeta, id: assessedId }] : [],
    settings: currentSettings, currentUrl: inspection.url,
    uploadReferences: action.action === 'upload_reference_image'
      ? uploadRegistry.list({ taskId: message.taskId, epoch: lease.epoch, tabId: message.tabId, url: before.url, signal: lease.signal }) : [],
  });
  const finalFailure = assessmentFailure(finalAssessment, message);
  if (finalFailure) return finalFailure;
  runtime.check(lease);
  activeSnapshot(message.tabId, message.snapshotId);
  if (originOf(before?.url) !== originOf(tab.url)) return agentError('ERR_ELEMENT_CHANGED', '主页面来源已变化。');
  const actionArgs = action.action === 'upload_reference_image' ? { ...action.args,
    upload: uploadRegistry.resolve({ taskId: message.taskId, epoch: lease.epoch, tabId: message.tabId, url: before.url,
      frameId: record.frameId, frameOrigin: record.frameOrigin, frameUrl: inspection.url, documentId: record.documentId,
      snapshotId: message.snapshotId, elementId: record.localId, referenceId: action.args.referenceId, signal: lease.signal }) } : action.args;
  diagnostic?.check('execute', { executionStatus: 'uncertain' });
  const result = await executeInFrame(
    message.tabId,
    record.frameId,
    record.localId,
    action.action,
    actionArgs,
    message.snapshotId,
    { taskId: message.taskId, epoch: lease.epoch, actionId: message.actionId, tabId: message.tabId, topUrl: before.url, frameId: record.frameId, frameOrigin: record.frameOrigin,
      documentId: record.documentId, signature: semanticSignature(freshMeta) },
  );
  if (action.action === AGENT_ACTIONS.type) {
    for (const stage of (Array.isArray(result?.diagnostics?.stages) ? result.diagnostics.stages : []).slice(0, 16)) {
      diagnostic?.emit('agent.input.stage', { ...stage, action: action.action, late: lease.signal.aborted },
        stage.stage === result.diagnostics.failureStage ? agentDiagnosticError({ ...result, name: result.diagnostics.errorName }, stage.stage) : null);
    }
  }
  if (!result?.error && result?.ok !== false) diagnostic?.check('settle');
  clearSnapshot(message.tabId);
  const asynchronousMutation = action.action === AGENT_ACTIONS.select || action.action === 'upload_reference_image';
  if (!asynchronousMutation) await delay(180, lease.signal);
  const after = await chrome.tabs.get(message.tabId).catch(() => null);
  if (asynchronousMutation && result?.ok && !result.error) {
    // Selection now waits for a page update. Revalidate authority and document
    // identity after that new async boundary before publishing its result.
    diagnostic?.check('recheck', { executionStatus: 'uncertain' });
    runtime.check(lease);
    checkExpectedUrl({ expectedUrl: tab.url }, after);
    await controlFor(after, message.taskId);
    runtime.check(lease);
    if (!await getOriginGrant(record.frameOrigin, message.taskId)) {
      return agentError('ERR_ORIGIN_NOT_ALLOWED', '目标框架授权已撤销，操作结果未核实。', { origin: record.frameOrigin });
    }
    runtime.check(lease);
    const documents = await chrome.scripting.executeScript({
      target: { tabId: message.tabId, frameIds: [record.frameId] }, func: () => globalThis.location.href,
    });
    runtime.check(lease);
    if (!documents?.[0] || (record.documentId && documents[0].documentId !== record.documentId)
      || documents[0].result !== record.frameUrl) {
      return agentError('ERR_PAGE_CHANGED', '操作后目标文档已变化，结果未核实。');
    }
    diagnostic?.check('check', { status: 'completed', executionStatus: 'verified' });
  }
  return {
    ...result,
    ...(result.effect?.type === 'scroll' ? { effect: { ...result.effect,
      targetId: action.args.elementId || '', targetKey: record.stableKey || 'page' } } : {}),
    tabUrl: String(after?.url || ''),
    tabTitle: String(after?.title || ''),
    urlChanged: Boolean(before?.url && after?.url && before.url !== after.url),
    observedUrl: String(tab.url || ''),
  };
}

async function navigateAgentPage(message = {}, lease, diagnostic) {
  diagnostic?.check('tab');
  const tab = await tabFor(message.tabId);
  diagnostic?.check('page-target');
  checkExpectedUrl(message, tab);
  diagnostic?.check('control-permission');
  const { settings } = await controlFor(tab, message.taskId);
  diagnostic?.check('control-permission', { status: 'completed' });
  let action;
  try {
    diagnostic?.check('normalize');
    action = normalizeAgentAction({ action: AGENT_ACTIONS.navigate, args: message.args });
  } catch (error) {
    return agentError('ERR_ACTION_INVALID', error.message || '导航参数无效。');
  }
  const targetOrigin = originOf(action.args.url);
  if (!targetOrigin) return agentError('ERR_ACTION_INVALID', '只允许导航到 http/https 地址。');
  if (targetOrigin !== originOf(tab.url)) {
    diagnostic?.check('target-permission');
    const grant = await getOriginGrant(targetOrigin, message.taskId);
    if (!grant) {
      return agentError('ERR_ORIGIN_NOT_ALLOWED', `尚未授权访问 ${targetOrigin}。`, {
        origin: targetOrigin,
        risk: 'confirm',
      });
    }
    diagnostic?.check('target-permission', { status: 'completed' });
  }
  diagnostic?.check('safety');
  const assessment = assessAgentAction({
    action: action.action,
    args: action.args,
    elements: [],
    settings,
    currentUrl: tab.url,
  });
  if (assessment.level === 'blocked') {
    return agentError('ERR_SAFETY_BLOCKED', assessment.reason || '这个导航被安全策略阻断。', {
      risk: 'blocked',
      reason: assessment.reason || '',
    });
  }
  diagnostic?.check('approval');
  if (needsApproval(assessment) && !approvalSatisfied(message)) {
    return agentError('ERR_SAFETY_BLOCKED', assessment.reason || '这个导航需要用户确认。', {
      risk: 'confirm',
      reason: assessment.reason || '',
      requiresConfirmation: true,
    });
  }
  try {
    diagnostic?.check('recheck');
    rememberTaskOrigins(lease, [targetOrigin]);
    const before = await tabFor(message.tabId);
    checkExpectedUrl(message, before);
    const currentSettings = await verifyAuthority(before, message.taskId, [targetOrigin], lease);
    const finalFailure = assessmentFailure(assessAgentAction({ action: action.action, args: action.args,
      elements: [], settings: currentSettings, currentUrl: before.url }), message);
    if (finalFailure) return finalFailure;
    checkExpectedUrl({ expectedUrl: before.url }, await tabFor(message.tabId));
    runtime.check(lease);
    diagnostic?.check('execute', { executionStatus: 'uncertain' });
    await chrome.tabs.update(message.tabId, { url: action.args.url });
    diagnostic?.check('execute', { status: 'completed', executionStatus: 'started' });
  } catch (error) {
    if (error.code) throw error;
    return agentError('ERR_NAVIGATION_FAILED', '无法打开这个地址。');
  }
  clearSnapshot(message.tabId);
  diagnostic?.check('settle');
  const loaded = await waitForLoad(message.tabId, lease.signal);
  const after = await chrome.tabs.get(message.tabId).catch(() => null);
  return {
    ok: true,
    message: `已打开 ${action.args.url}`,
    loaded,
    tabUrl: String(after?.url || ''),
    tabTitle: String(after?.title || ''),
    urlChanged: true,
  };
}

async function waitAgentPage(message = {}, lease, diagnostic) {
  diagnostic?.check('tab');
  const tab = await tabFor(message.tabId);
  diagnostic?.check('page-target');
  checkExpectedUrl(message, tab);
  diagnostic?.check('control-permission');
  await controlFor(tab, message.taskId);
  diagnostic?.check('control-permission', { status: 'completed' });
  diagnostic?.check('settle');
  const seconds = Math.min(10, Math.max(0.2, Number(message.args?.seconds) || 0.8));
  if (message.args?.load === true) {
    const loaded = await waitForLoad(message.tabId, lease.signal);
    runtime.check(lease);
    return { ok: true, loaded, message: loaded ? '页面加载完成。' : '等待页面加载超时。' };
  }
  await delay(seconds * 1000, lease.signal);
  runtime.check(lease);
  return { ok: true, message: `已等待 ${seconds} 秒。` };
}

function waitForLoad(tabId, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener('abort', aborted);
      resolve(value);
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(true);
    };
    const aborted = () => finish(false);
    if (signal?.aborted) return finish(false);
    signal?.addEventListener('abort', aborted, { once: true });
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => finish(false), LOAD_TIMEOUT);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') finish(true);
    }).catch(() => finish(false));
  });
}

function missingCaptureGrant(error) {
  if (error?.code || ['AbortError', 'TimeoutError', 'NotAllowedError', 'SecurityError'].includes(error?.name)) return false;
  const message = typeof error === 'string' ? error : error?.message;
  return typeof message === 'string' && /^Either\s+(?:the\s+)?['"]?<all_urls>['"]?\s+or\s+(?:the\s+)?['"]?activeTab['"]?\s+(?:permission\s+)?(?:is\s+)?required\.?$/i.test(message.trim());
}

async function captureAgentPage({ tabId, taskId, expectedUrl, documentId, snapshotId: expectedSnapshot } = {}, lease, boundary) {
  const tab = await boundary.wait(() => tabFor(tabId), lease);
  await boundary.wait(() => controlFor(tab, taskId), lease);
  const guarded = Boolean(expectedUrl || documentId || expectedSnapshot);
  const current = expectedSnapshot ? snapshots.get(tabId) : null;
  const pinnedDocumentId = current?.documentId || documentId;
  let captureGeometry;
  const verify = async () => {
    boundary.check(lease);
    const latest = await boundary.wait(() => tabFor(tabId), lease);
    await boundary.wait(() => controlFor(latest, taskId), lease);
    boundary.check(lease);
    if (expectedUrl && latest.url !== expectedUrl) return agentError('ERR_PAGE_CHANGED', '截图期间页面已变化。');
    if (expectedSnapshot && (!current || snapshots.get(tabId) !== current || current.snapshotId !== expectedSnapshot
      || current.taskId !== taskId || current.epoch !== lease.epoch)) return agentError('ERR_SNAPSHOT_EXPIRED', '截图对应的页面观察已过期。');
    if (documentId && current?.documentId && documentId !== current.documentId) return agentError('ERR_PAGE_CHANGED', '截图的目标文档不匹配。');
    const [active] = await boundary.wait(() => chrome.tabs.query({ active: true, windowId: tab.windowId }), lease);
    boundary.check(lease);
    if (active?.id !== tabId) return agentError('ERR_TAB_NOT_ACTIVE', '当前页面不在前台，无法截图证据。');
    if (pinnedDocumentId) {
      const entries = await boundary.wait(() => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
        func: () => ({ url: location.href, viewport: { width: innerWidth, height: innerHeight }, scrollY }) }), lease);
      boundary.check(lease);
      const geometry = entries?.[0]?.result;
      if (entries?.[0]?.documentId !== pinnedDocumentId || (expectedUrl && geometry?.url !== expectedUrl)) {
        return agentError('ERR_PAGE_CHANGED', '截图期间页面文档已更换。');
      }
      const expectedViewport = current?.observation?.viewport;
      if (expectedSnapshot && ((expectedViewport && (geometry?.viewport?.width !== expectedViewport.width
        || geometry?.viewport?.height !== expectedViewport.height)) || geometry?.scrollY !== current?.observation?.scrollY)) {
        return agentError('ERR_SNAPSHOT_EXPIRED', '截图期间视口或滚动位置变化，请重新观察局部区域。');
      }
      if (captureGeometry && (JSON.stringify(captureGeometry.viewport) !== JSON.stringify(geometry.viewport)
        || captureGeometry.scrollY !== geometry.scrollY)) return agentError('ERR_SNAPSHOT_EXPIRED', '截图期间页面布局范围变化。');
      captureGeometry = geometry;
    }
    return null;
  };
  try {
    const before = await verify();
    if (before) return before;
    boundary.check(lease);
    let dataUrl;
    try {
      dataUrl = await boundary.wait(() => chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg', quality: CAPTURE_QUALITY,
      }), lease);
    } catch (error) {
      boundary.check(lease);
      if (!missingCaptureGrant(error)) throw error;
      const beforeFallback = await verify();
      if (beforeFallback) return beforeFallback;
      // Only fixed main-document captures may acquire the already permitted debugger.
      // Approval-only screenshots without source identity keep the native failure behavior.
      if (!expectedUrl || !pinnedDocumentId || !captureGeometry || !chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
        return agentError('ERR_CAPTURE_FAILED', '原生截图缺少临时页面授权，当前截图没有可用的固定文档调试通道。');
      }
      boundary.check(lease);
      dataUrl = await boundary.wait(() => withPageDebugger({ tabId }, async (_target, sendCommand) => {
        // Attaching Chrome's debugger may change the viewport through its infobar.
        // Never reuse old crop coordinates across that geometry change.
        const attached = await verify();
        if (attached) throw Object.assign(new Error(attached.message), { code: attached.error });
        boundary.check(lease);
        const shot = await sendCommand('Page.captureScreenshot', {
          format: 'jpeg', quality: CAPTURE_QUALITY, fromSurface: true, captureBeyondViewport: false,
        });
        boundary.check(lease);
        const captured = await verify();
        if (captured) throw Object.assign(new Error(captured.message), { code: captured.error });
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(shot?.data || '')) {
          throw Object.assign(new Error('没有获取到调试截图。'), { code: 'ERR_CAPTURE_FAILED' });
        }
        return `data:image/jpeg;base64,${shot.data}`;
      }, { chrome, signal: boundary.signal, timeoutMs: Math.max(1, boundary.expiresAt - Date.now()) }), lease);
    }
    const after = await verify();
    if (after) return after;
    if (!/^data:image\/jpeg;base64,/.test(dataUrl || '')) {
      return agentError('ERR_CAPTURE_FAILED', '没有获取到页面截图。');
    }
    return { ok: true, dataUrl, ...(guarded ? { tabId, url: expectedUrl, documentId: pinnedDocumentId, snapshotId: expectedSnapshot,
      ...(captureGeometry ? { viewport: captureGeometry.viewport, scrollY: captureGeometry.scrollY } : {}) } : {}) };
  } catch (error) {
    if (lease.signal?.aborted) return agentError('ERR_TASK_PAUSED', '截图期间任务已暂停。');
    if (error?.code === 'NETWORK_DEBUGGER_BUSY') return agentError('ERR_CAPTURE_DEBUGGER_BUSY', '本页调试器正在读取，局部截图暂不可用。');
    if (error?.code === 'NETWORK_DEBUGGER_TIMEOUT' || error?.code === 'ERR_CAPTURE_TIMEOUT') {
      return agentError('ERR_CAPTURE_TIMEOUT', '页面截图超过三秒等待上限，已停止本次截图。');
    }
    if (/^ERR_(?:ORIGIN_NOT_ALLOWED|CONTROL_DISABLED|PAGE_CHANGED|SNAPSHOT_EXPIRED|TAB_NOT_ACTIVE|TASK_PAUSED|TASK_CANCELLED|TAB_NOT_FOUND|PAGE_RESTRICTED)$/.test(error?.code || '')) {
      return agentError(error.code, error.message);
    }
    return agentError('ERR_CAPTURE_FAILED', '浏览器没有允许截图。');
  }
}

async function readAgentPageEvidence({ tabId, taskId } = {}, lease) {
  const tab = await tabFor(tabId);
  await controlFor(tab, taskId);
  try {
    runtime.check(lease);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const extractor = globalThis.__unkAiExtractor;
        if (!extractor?.extractPageContent) {
          return { error: 'ERR_EXTRACTOR_MISSING' };
        }
        const page = extractor.extractPageContent({ maxBudget: 16000, includeStructure: false });
        const visibleText = (node) => String(node?.innerText || node?.textContent || '')
          .replace(/\r\n?/g, '\n')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const candidates = Array.from(document.querySelectorAll([
          '[data-testid="conversation-turn"]',
          '[data-message-author-role]',
          '[data-role="assistant"]',
          '[role="article"]',
        ].join(','))).filter((node) => {
          const text = visibleText(node);
          return text.length >= 120 && text.length <= 12000;
        });
        const latest = [...new Set(candidates
          .sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top)
          .slice(0, 2)
          .map(visibleText)
          .filter(Boolean))];
        return { page, latest };
      },
    });
    const data = result?.result;
    const page = data?.page && !data.error ? combinePageEvidence(data.page, data.latest) : data;
    if (!page || page.error || typeof page.text !== 'string' || page.text.trim().length < 20) {
      return agentError('ERR_PAGE_EVIDENCE_EMPTY', '当前页面没有可读取的正文。');
    }
    return {
      ok: true,
      title: String(page.title || tab.title || ''),
      url: String(page.url || tab.url || ''),
      text: page.text,
      truncated: page.truncated === true,
    };
  } catch {
    return agentError('ERR_PAGE_EVIDENCE_FAILED', '无法读取当前页面正文。');
  }
}

/** This function runs in the isolated main-document world and never mutates the DOM. */
function readPageInjected(expected, readText = false) {
  const verify = () => {
    if (Date.now() >= expected.expiresAt) return { error: 'ERR_PAGE_READ_TIMEOUT' };
    if (globalThis.top !== globalThis || location.href !== expected.url) return { error: 'ERR_PAGE_CHANGED' };
    const snapshot = globalThis.__unkAiAgentSnapshots?.get(expected.snapshotId);
    if (!snapshot || snapshot.taskId !== expected.taskId || snapshot.epoch !== expected.epoch) {
      return { error: 'ERR_SNAPSHOT_EXPIRED' };
    }
    if (snapshot.url !== expected.url) return { error: 'ERR_PAGE_CHANGED' };
    return null;
  };
  const invalid = verify();
  if (invalid) return invalid;
  if (!readText) return { url: location.href };
  const extractor = globalThis.__unkAiExtractor;
  if (!extractor?.extractPageContent) return { error: 'ERR_EXTRACTOR_MISSING' };
  // Select the relevant chapter before reducing the returned text budget. The
  // extractor already traverses the body; no lazy scrolling or link fetch runs.
  const page = extractor.extractPageContent({ maxBudget: Number.MAX_SAFE_INTEGER, includeStructure: false });
  if (page?.url !== expected.url) return { error: 'ERR_PAGE_CHANGED' };
  const fullText = typeof page.text === 'string' ? page.text.trim() : '';
  if (!fullText) return { error: 'ERR_PAGE_READ_EMPTY' };
  let start = 0;
  if (fullText.length > expected.maxLength && expected.query) {
    const terms = [...new Set(expected.query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [])]
      .filter((term) => term.length > 1).slice(0, 24);
    const headings = new Set((Array.isArray(page.sections) ? page.sections : []).map((section) => String(section.text || '').trim()));
    const sections = [{ start: 0, title: '' }];
    for (const match of fullText.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)) {
      if (headings.has(match[0].trim())) {
        if (match.index === 0) sections[0].title = match[0];
        else sections.push({ start: match.index, title: match[0] });
      }
    }
    let best = { score: 0, start: 0, firstMatch: 0, headingMatch: false };
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      const body = fullText.slice(section.start, sections[index + 1]?.start).toLocaleLowerCase();
      const title = section.title.toLocaleLowerCase();
      let score = 0;
      let firstMatch = body.length;
      let headingMatch = false;
      for (const term of terms) {
        const match = body.indexOf(term);
        if (match < 0) continue;
        firstMatch = Math.min(firstMatch, match);
        score += 1;
        if (title.includes(term)) { score += 5; headingMatch = true; }
      }
      if (score > best.score) best = { score, start: section.start, firstMatch, headingMatch };
    }
    if (best.score) start = best.start + (best.headingMatch ? 0 : Math.max(0, best.firstMatch - 1000));
  }
  const text = fullText.slice(start, start + expected.maxLength);
  const after = verify();
  if (after) return after;
  return {
    url: location.href,
    title: String(page.title || document.title || ''),
    text,
    truncated: page.truncated === true || start > 0 || text.length < fullText.length,
    capturedAt: new Date().toISOString(),
  };
}

async function readAgentPage(message, lease, boundary) {
  if (typeof message.expectedUrl !== 'string' || !message.expectedUrl
    || typeof message.snapshotId !== 'string' || !message.snapshotId
    || (message.query !== undefined && (typeof message.query !== 'string' || message.query.length > 200))) {
    return agentError('ERR_ACTION_INVALID', '正文读取需要有效的页面地址、快照和不超过 200 字符的查询词。');
  }
  const checkSnapshot = () => {
    boundary.check(lease);
    let current;
    try { current = activeSnapshot(message.tabId, message.snapshotId); } catch {
      throw Object.assign(new Error('页面快照已过期，请重新观察。'), { code: 'ERR_SNAPSHOT_EXPIRED' });
    }
    if (current.taskId !== message.taskId || current.epoch !== lease.epoch || taskEpochs.get(message.taskId) !== lease.epoch) {
      throw Object.assign(new Error('任务的页面快照已过期，请重新观察。'), { code: 'ERR_SNAPSHOT_EXPIRED' });
    }
    if (!current.documentId || current.observation.url !== message.expectedUrl) {
      throw Object.assign(new Error('主文档已变化或无法确认，请重新观察。'), { code: 'ERR_PAGE_CHANGED' });
    }
    return current;
  };
  const current = checkSnapshot();
  const expected = {
    url: message.expectedUrl,
    taskId: message.taskId,
    epoch: lease.epoch,
    snapshotId: message.snapshotId,
    query: (message.query || '').trim(),
    maxLength: READ_PAGE_BUDGET,
    expiresAt: boundary.expiresAt,
  };
  const assertTab = async () => {
    const tab = await boundary.wait(() => tabFor(message.tabId), lease);
    checkExpectedUrl(message, tab);
    await boundary.wait(() => controlFor(tab, message.taskId), lease);
    checkSnapshot();
  };
  const readDocument = async (readText, pinned = true) => {
    checkSnapshot();
    let entries;
    try {
      entries = await boundary.wait(() => chrome.scripting.executeScript({
        target: { tabId: message.tabId, ...(pinned ? { documentIds: [current.documentId] } : { frameIds: [0] }) },
        injectImmediately: true,
        func: readPageInjected,
        args: [expected, readText],
      }), lease);
    } catch (error) {
      boundary.check(lease);
      throw Object.assign(new Error('读取期间主文档已变化或不可访问，请重新观察。'), { code: 'ERR_PAGE_CHANGED', cause: error });
    }
    const entry = entries?.find((result) => result.frameId === 0);
    if (!entry || entry.documentId !== current.documentId) {
      throw Object.assign(new Error('读取期间主文档已更换，请重新观察。'), { code: 'ERR_PAGE_CHANGED' });
    }
    const result = entry.result;
    if (result?.error) throw Object.assign(new Error('页面正文读取失败，请重新观察后重试。'), { code: result.error });
    if (result?.url !== expected.url) throw Object.assign(new Error('读取期间页面地址已变化。'), { code: 'ERR_PAGE_CHANGED' });
    checkSnapshot();
    return result;
  };
  await assertTab();
  await readDocument(false);
  // Only install the inert extractor in the already verified main document.
  // Never reinject content.js, install event handlers, or materialize lazy DOM.
  try {
    await boundary.wait(() => chrome.scripting.executeScript({
      target: { tabId: message.tabId, documentIds: [current.documentId] },
      injectImmediately: true,
      files: AGENT_READER_FILES,
    }), lease);
  } catch (error) {
    boundary.check(lease);
    throw Object.assign(new Error('无法在已观察的主文档中加载正文读取器，请重新观察。'), { code: 'ERR_PAGE_CHANGED', cause: error });
  }
  await assertTab();
  const page = await readDocument(true);
  await assertTab();
  await readDocument(false, false);
  if (!page.text?.trim()) return agentError('ERR_PAGE_READ_EMPTY', '当前页面没有可读取的正文。');
  return { ok: true, ...page };
}

function readRegionInjected(expected, readText = true) {
  if (Date.now() >= expected.expiresAt) return { error: 'ERR_PAGE_READ_TIMEOUT' };
  if (location.href !== expected.frameUrl) return { error: 'ERR_PAGE_CHANGED' };
  const snapshot = globalThis.__unkAiAgentSnapshots?.get(expected.snapshotId);
  if (!snapshot || snapshot.taskId !== expected.taskId || snapshot.epoch !== expected.epoch) return { error: 'ERR_SNAPSHOT_EXPIRED' };
  const record = snapshot.get(expected.localId);
  if (!record?.meta.readable || !record.meta.readOnly || !record.element.isConnected) return { error: 'ERR_REGION_INVALID' };
  if (!readText) return { url: location.href };
  const scanner = globalThis.__unkAiAgentScanner;
  if (!scanner?.readRegion) return { error: 'ERR_SCANNER_MISSING' };
  return scanner.readRegion(expected.snapshotId, expected.localId, expected);
}

async function readAgentRegion(message, lease, boundary) {
  const started = performance.now();
  if (typeof message.expectedUrl !== 'string' || !message.expectedUrl || typeof message.snapshotId !== 'string'
    || !message.snapshotId || !/^e\d+$/.test(message.elementId || '')
    || (message.query !== undefined && (typeof message.query !== 'string' || message.query.length > 80))) {
    return agentError('ERR_ACTION_INVALID', '区域读取需要有效的页面、快照、区域 ID 和不超过 80 字符的字段名称。');
  }
  const fail = (code, text) => { throw Object.assign(new Error(text), { code }); };
  const checkSnapshot = () => {
    boundary.check(lease);
    let value;
    try { value = activeSnapshot(message.tabId, message.snapshotId); } catch { fail('ERR_SNAPSHOT_EXPIRED', '页面快照已过期，请重新观察。'); }
    if (value.taskId !== message.taskId || value.epoch !== lease.epoch || taskEpochs.get(message.taskId) !== lease.epoch) fail('ERR_SNAPSHOT_EXPIRED', '区域不再属于当前有效任务。');
    if (value.observation.url !== message.expectedUrl || !value.documentId) fail('ERR_PAGE_CHANGED', '任务页面已变化，请重新观察。');
    return value;
  };
  const current = checkSnapshot();
  const record = current.elements.get(message.elementId);
  if (!record?.meta.readable || !record.meta.readOnly || !record.documentId) return agentError('ERR_REGION_INVALID', '只能读取当前观察明确标注的内容区域。');
  const expected = { taskId: message.taskId, epoch: lease.epoch, snapshotId: message.snapshotId,
    regionId: message.elementId, localId: record.localId, frameUrl: record.frameUrl, pageUrl: message.expectedUrl,
    query: (message.query || '').trim(), expiresAt: boundary.expiresAt };
  const assertAllowed = async () => {
    const tab = await boundary.wait(() => tabFor(message.tabId), lease);
    checkExpectedUrl(message, tab);
    await boundary.wait(() => controlFor(tab, message.taskId), lease);
    if (!await boundary.wait(() => getOriginGrant(record.frameOrigin, message.taskId), lease)) fail('ERR_ORIGIN_NOT_ALLOWED', '区域所在框架的站点授权已失效。');
    checkSnapshot();
  };
  const runInDocument = async ({ frameId, documentId, func, args, currentFrame = false }) => {
    checkSnapshot();
    let entries;
    try {
      entries = await boundary.wait(() => chrome.scripting.executeScript({
        target: { tabId: message.tabId, ...(currentFrame ? { frameIds: [frameId] } : { documentIds: [documentId] }) },
        injectImmediately: true, func, args,
      }), lease);
    } catch (error) { boundary.check(lease); fail('ERR_PAGE_CHANGED', '区域读取期间文档已更换或不可访问。'); }
    const entry = entries?.find(item => item.frameId === frameId);
    if (!entry || entry.documentId !== documentId) fail('ERR_PAGE_CHANGED', '区域读取期间文档已更换。');
    if (entry.result?.error) fail(entry.result.error, '区域读取失败，请重新观察后重试。');
    checkSnapshot();
    return entry.result;
  };
  const verifyMain = (currentFrame = false) => runInDocument({ frameId: 0, documentId: current.documentId, currentFrame,
    func: readPageInjected, args: [{ ...expected, url: message.expectedUrl }, false] });
  await assertAllowed();
  await verifyMain();
  const result = await runInDocument({ frameId: record.frameId, documentId: record.documentId, func: readRegionInjected, args: [expected, true] });
  await assertAllowed();
  await runInDocument({ frameId: record.frameId, documentId: record.documentId, currentFrame: true, func: readRegionInjected, args: [expected, false] });
  await verifyMain(true);
  await assertAllowed();
  if (!result?.ok || !result.regionReading || (!result.regionReading.text && !result.regionReading.rows?.length)) return agentError('ERR_PAGE_READ_EMPTY', '选定区域没有可读取的正文或数据行。');
  return { ...result, regionReading: { ...result.regionReading, frameId: record.frameId,
    regionKey: `f${record.frameId}:${result.regionReading.regionKey}` },
    metrics: { ...result.metrics, totalReadMs: Math.max(0, performance.now() - started) } };
}

function uploadReceiptInjected(snapshotId, localId, expected, verifyReceipt = false) {
  if (Date.now() >= expected.expiresAt) return { error: 'ERR_UPLOAD_VERIFY_TIMEOUT' };
  if (location.href !== expected.frameUrl) return { error: 'ERR_PAGE_CHANGED' };
  const snapshot = globalThis.__unkAiAgentSnapshots?.get(snapshotId);
  if (!snapshot || snapshot.taskId !== expected.taskId || snapshot.epoch !== expected.epoch) return { error: 'ERR_SNAPSHOT_EXPIRED' };
  if (snapshot.url !== expected.frameUrl) return { error: 'ERR_PAGE_CHANGED' };
  const record = snapshot.get(localId);
  if (typeof globalThis.HTMLInputElement !== 'function' || !(record?.element instanceof globalThis.HTMLInputElement)
    || record.element.type !== 'file' || !record.element.isConnected || record.meta?.tag !== 'input' || record.meta?.type !== 'file') {
    return { error: 'ERR_UPLOAD_SCOPE' };
  }
  const scanner = globalThis.__unkAiAgentScanner;
  if (!scanner) return { error: 'ERR_SCANNER_MISSING' };
  return verifyReceipt
    ? scanner.verifyUploadReceipt?.(snapshotId, localId, expected) || { error: 'ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED' }
    : scanner.inspect(snapshotId, localId);
}

/** Confirm only a pending upload's receipt. This read never changes its cached action result. */
async function verifyAgentUpload(message, lease, boundary) {
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
  if (!validId(message.snapshotId) || !validId(message.uploadActionId) || !/^e\d+$/.test(message.elementId || '')
    || !/^reference-[1-3]$/.test(message.referenceId || '') || typeof message.expectedUrl !== 'string' || !message.expectedUrl) {
    return agentError('ERR_ACTION_INVALID', '上传核验需要有效的任务页面、新快照、文件框及原上传动作和参考图 ID。');
  }
  const fail = (code, text) => { throw Object.assign(new Error(text), { code }); };
  const original = lease.task.actions.get(message.uploadActionId)?.result;
  if (original?.error !== 'ERR_UPLOAD_UNCERTAIN' || original.upload?.requiresAcceptanceVerification !== true
    || original.upload.referenceId !== message.referenceId || original.upload.epoch !== lease.epoch
    || original.observedUrl !== message.expectedUrl) {
    return agentError('ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED', '原上传没有可核验的当前任务回执，不会重新上传或继续提交。');
  }
  let current;
  const checkSnapshot = () => {
    boundary.check(lease);
    let value;
    try { value = activeSnapshot(message.tabId, message.snapshotId); } catch { fail('ERR_SNAPSHOT_EXPIRED', '页面快照已过期，请重新观察。'); }
    if ((current && value !== current) || value.taskId !== message.taskId || value.epoch !== lease.epoch
      || taskEpochs.get(message.taskId) !== lease.epoch) fail('ERR_SNAPSHOT_EXPIRED', '上传核验快照不再属于当前有效任务。');
    if (value.observation.url !== message.expectedUrl || !value.documentId) fail('ERR_PAGE_CHANGED', '任务主文档已变化或无法确认。');
    return value;
  };
  current = checkSnapshot();
  const record = current.elements.get(message.elementId);
  if (record?.meta.tag !== 'input' || record.meta.type !== 'file' || !record.meta.uploadOnly || !record.documentId
    || record.frameOrigin !== originOf(message.expectedUrl) || originOf(record.frameUrl) !== record.frameOrigin
    || original.upload.documentId !== record.documentId || original.upload.frameId !== record.frameId) {
    return agentError('ERR_UPLOAD_SCOPE', '只能核验原文档中同源的原生文件输入框。');
  }
  const expected = { taskId: message.taskId, epoch: lease.epoch, actionId: message.uploadActionId,
    referenceId: message.referenceId, tabId: message.tabId, frameId: record.frameId, documentId: record.documentId,
    frameUrl: record.frameUrl, pageUrl: message.expectedUrl, expiresAt: boundary.expiresAt };
  const assertAllowed = async () => {
    const tab = await boundary.wait(() => tabFor(message.tabId), lease);
    checkExpectedUrl(message, tab);
    await boundary.wait(() => controlFor(tab, message.taskId), lease);
    if (!await boundary.wait(() => getOriginGrant(record.frameOrigin, message.taskId), lease)) fail('ERR_ORIGIN_NOT_ALLOWED', '文件框所在框架的站点授权已失效。');
    checkSnapshot();
    const references = uploadRegistry.list({ taskId: message.taskId, epoch: lease.epoch, tabId: message.tabId,
      url: tab.url, signal: lease.signal });
    if (!references.some(reference => reference.referenceId === message.referenceId)) fail('ERR_UPLOAD_SCOPE', '原参考图片不再属于当前任务。');
  };
  const runInDocument = async (frameId, documentId, func, args, currentFrame = false) => {
    checkSnapshot();
    let entries;
    try {
      entries = await boundary.wait(() => chrome.scripting.executeScript({
        target: { tabId: message.tabId, ...(currentFrame ? { frameIds: [frameId] } : { documentIds: [documentId] }) },
        injectImmediately: true, func, args,
      }), lease);
    } catch { boundary.check(lease); fail('ERR_PAGE_CHANGED', '上传核验期间原文档已更换或不可访问。'); }
    const entry = entries?.find(value => value.frameId === frameId);
    if (!entry || entry.documentId !== documentId) fail('ERR_PAGE_CHANGED', '上传核验期间目标文档已更换。');
    checkSnapshot();
    return entry.result;
  };
  const verifyMain = async (currentFrame = false) => {
    const result = await runInDocument(0, current.documentId, readPageInjected, [{ ...expected,
      snapshotId: message.snapshotId, url: message.expectedUrl }, false], currentFrame);
    if (result?.error || result?.url !== message.expectedUrl) fail(result?.error || 'ERR_PAGE_CHANGED', '上传核验期间主页面已变化。');
  };
  const inspectTarget = async (currentFrame = false) => {
    const result = await runInDocument(record.frameId, record.documentId, uploadReceiptInjected,
      [message.snapshotId, record.localId, expected, false], currentFrame);
    if (result?.error) fail(result.error, '上传核验文件框已变化，请重新观察。');
    if (result?.url !== record.frameUrl || semanticSignature(result?.meta) !== semanticSignature(record.meta)) fail('ERR_ELEMENT_CHANGED', '上传核验目标已变化，请重新观察。');
  };
  await assertAllowed();
  await verifyMain();
  await inspectTarget();
  await assertAllowed();
  const result = await runInDocument(record.frameId, record.documentId, uploadReceiptInjected,
    [message.snapshotId, record.localId, expected, true]);
  await assertAllowed();
  await inspectTarget(true);
  await verifyMain(true);
  await assertAllowed();
  if (result?.error) return result;
  const receipt = result?.receipt;
  if (result?.ok !== true || receipt?.version !== 1 || receipt.accepted !== true || receipt.kind !== 'new-matching-preview'
    || receipt.serverConfirmed !== false || receipt.actionId !== message.uploadActionId || receipt.referenceId !== message.referenceId
    || receipt.taskId !== message.taskId || receipt.epoch !== lease.epoch || receipt.tabId !== message.tabId
    || receipt.frameId !== record.frameId || receipt.documentId !== record.documentId || receipt.url !== message.expectedUrl
    || receipt.snapshotId !== message.snapshotId) {
    return agentError('ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED', '页面未返回归属于原上传的有效回执，不会重新上传或继续提交。');
  }
  return { ok: true, receipt };
}

export async function handleAgentMessage(message, sendResponse, { recordDiagnostic: log = recordDiagnostic } = {}) {
  const type = message?.type;
  const isAction = ['AGENT_ACT', 'AGENT_NAVIGATE', 'AGENT_WAIT'].includes(type);
  const observed = type === 'AGENT_OBSERVE';
  const startedAt = performance.now();
  const report = createAgentDiagnosticReporter(log, 'background', {
    ...message?.diagnosticContext, taskId: message?.taskId, tabId: message?.tabId,
    actionId: message?.actionId, snapshotId: message?.snapshotId, elementId: message?.args?.elementId,
  });
  const details = { action: type === 'AGENT_NAVIGATE' ? AGENT_ACTIONS.navigate : type === 'AGENT_WAIT' ? AGENT_ACTIONS.wait : message?.action,
    ...(isAction ? { executionStatus: 'not-started' } : {}),
    ...(message?.action === AGENT_ACTIONS.type && typeof message?.args?.text === 'string' ? { expectedChars: message.args.text.length } : {}) };
  const context = {};
  const diagnostic = {
    stage: 'request',
    emit(event, data, error) { report(event, { ...details, ...data }, error, context); },
    check(stage, data = {}, extra = {}) {
      this.stage = stage;
      const { status, ...retained } = data;
      Object.assign(details, retained);
      Object.assign(context, extra);
      if (isAction) this.emit('agent.action.check', { stage, status: status || 'started' });
    },
  };
  const actionResult = result => {
    if (!isAction || !result || typeof result !== 'object') return result;
    const failed = Boolean(result.error || result.ok === false);
    const existing = result.diagnostics || {};
    return { ...result, diagnostics: { version: 1,
      ...(Number.isFinite(details.snapshotAgeMs) ? { snapshotAgeMs: details.snapshotAgeMs } : {}),
      ...(details.changedFields?.length ? { changedFields: details.changedFields } : {}),
      executionStatus: details.executionStatus,
      ...(failed ? { failureStage: diagnostic.stage } : {}),
      ...existing } };
  };
  if (isAction || observed) diagnostic.emit(isAction ? 'agent.action.started' : 'agent.observe.started', { stage: 'request' });
  const completed = result => {
    result = actionResult(result);
    if (!isAction && !observed) return result;
    const failed = Boolean(result?.error || result?.ok === false);
    const failureStage = result?.diagnostics?.failureStage || diagnostic.stage;
    const lastStage = Array.isArray(result?.diagnostics?.stages) ? result.diagnostics.stages.at(-1) : null;
    diagnostic.emit(`agent.${isAction ? 'action' : 'observe'}.${failed ? 'failed' : 'completed'}`, {
      ...lastStage,
      ...(result?.diagnostics?.changedFields ? { changedFields: result.diagnostics.changedFields } : {}),
      ...(Number.isFinite(result?.diagnostics?.snapshotAgeMs) ? { snapshotAgeMs: result.diagnostics.snapshotAgeMs } : {}),
      ...(result?.diagnostics?.executionStatus ? { executionStatus: result.diagnostics.executionStatus } : {}),
      durationMs: Math.max(0, performance.now() - startedAt), stage: diagnostic.stage,
      ...(failed ? { failureStage } : {}),
    }, failed ? agentDiagnosticError({ ...result, name: result?.diagnostics?.errorName }, failureStage) : null);
    return result;
  };
  const overlayEpoch = type === 'AGENT_OVERLAY' ? taskEpochs.get(message.taskId) : undefined;
  const boundary = type === 'AGENT_OBSERVE'
    ? createReadBoundary(message, OBSERVE_TIMEOUT, 'ERR_PAGE_OBSERVE_TIMEOUT', '读取页面超时，未生成新的观察快照。请稍后重试。')
    : type === 'AGENT_CAPTURE'
      ? createReadBoundary(message, CAPTURE_TIMEOUT, 'ERR_CAPTURE_TIMEOUT', '页面截图超过三秒等待上限，已停止本次截图。')
      : type === 'AGENT_VERIFY_UPLOAD'
        ? createReadBoundary(message, UPLOAD_VERIFY_TIMEOUT, 'ERR_UPLOAD_VERIFY_TIMEOUT', '参考图片回执核验超过三秒等待上限，已停止本次核验。')
      : ['AGENT_READ_PAGE', 'AGENT_READ_REGION'].includes(type)
      ? createReadBoundary(message, READ_PAGE_TIMEOUT, 'ERR_PAGE_READ_TIMEOUT', '读取正文超时，请重新观察后重试。')
      : type === 'AGENT_OVERLAY'
        ? createReadBoundary(message, OVERLAY_TIMEOUT, 'ERR_OVERLAY_TIMEOUT', '页面任务提示暂时无法显示。')
        : null;
  const runner = {
    AGENT_OBSERVE: (lease) => observeAgentPage(message, lease, boundary, diagnostic),
    AGENT_ACT: (lease) => performAgentAction(message, lease, diagnostic),
    AGENT_NAVIGATE: (lease) => navigateAgentPage(message, lease, diagnostic),
    AGENT_WAIT: (lease) => waitAgentPage(message, lease, diagnostic),
    AGENT_CAPTURE: (lease) => captureAgentPage(message, lease, boundary),
    AGENT_VERIFY_UPLOAD: (lease) => verifyAgentUpload(message, lease, boundary),
    AGENT_PAGE_EVIDENCE: (lease) => readAgentPageEvidence(message, lease),
    AGENT_READ_PAGE: (lease) => readAgentPage(message, lease, boundary),
    AGENT_READ_REGION: (lease) => readAgentRegion(message, lease, boundary),
  }[type];
  try {
    let result;
    if (type === 'AGENT_START' || type === 'AGENT_RESUME') {
      const tab = await tabFor(message.tabId);
      await controlFor(tab, message.taskId);
      const pendingScope = { taskId: message.taskId, tabId: message.tabId, origin: originOf(tab.url) };
      pendingTaskScopes.add(pendingScope);
      try {
        const lease = await runtime.activate(message, { resume: type === 'AGENT_RESUME' });
        runtime.check(lease);
        const previousScope = taskScopes.get(message.taskId);
        if (previousScope?.epoch !== lease.epoch || previousScope.tabId !== message.tabId) {
          taskScopes.set(message.taskId, { tabId: message.tabId, epoch: lease.epoch, origins: new Set([pendingScope.origin]) });
        } else previousScope.origins.add(pendingScope.origin);
        taskEpochs.set(message.taskId, lease.epoch);
        try {
          await verifyAuthority(tab, message.taskId, [], lease);
          const uploadReferences = uploadRegistry.register({ taskId: message.taskId, epoch: lease.epoch, tabId: message.tabId,
            url: tab.url, referenceImages: message.referenceImages || [], signal: lease.signal });
          runtime.check(lease);
          result = { ok: true, uploadReferences };
        } catch (error) {
          await pauseAgentTask(message, { expectedEpoch: lease.epoch }).catch(() => {});
          throw error;
        }
      } finally {
        pendingTaskScopes.delete(pendingScope);
      }
    } else if (['AGENT_PAUSE', 'AGENT_CANCEL', 'AGENT_RELEASE'].includes(type)) {
      result = await pauseAgentTask(message, { cancelled: type !== 'AGENT_PAUSE' });
    } else if (type === 'AGENT_OVERLAY') {
      const display = (lease) => toggleAgentOverlay(message.tabId, {
        visible: message.visible === true, taskId: message.taskId, goal: message.goal, label: message.label, epoch: overlayEpoch,
      }, boundary, lease);
      result = await boundary.wait(() => message.visible ? runtime.run(message, display) : display());
    } else if (runner) {
      const execute = () => runtime.run(message, async lease => {
        try { return actionResult(await runner(lease)); }
        catch (error) {
          return actionResult(agentError(error?.code || 'ERR_AGENT_FAILED', error?.message || '浏览器 Agent 操作失败。',
            error?.origin ? { origin: error.origin } : {}));
        }
      }, {
        action: ['AGENT_ACT', 'AGENT_NAVIGATE', 'AGENT_WAIT'].includes(type),
        readOnly: type === 'AGENT_PAGE_EVIDENCE',
      });
      result = boundary ? await boundary.wait(execute) : await execute();
    } else return false;
    sendResponse(completed(result));
  } catch (error) {
    sendResponse(completed(agentError(
      type === 'AGENT_CAPTURE' && error?.code === 'ERR_TASK_CANCELLED' ? 'ERR_TASK_PAUSED' : error?.code || 'ERR_AGENT_FAILED',
      error?.message || '浏览器 Agent 操作失败。',
    )));
  } finally {
    boundary?.dispose();
  }
  return true;
}

chrome.tabs?.onUpdated?.addListener((tabId, info) => {
  if (info.status === 'loading' || info.url) {
    clearSnapshot(tabId);
    for (const boundary of activeReadBoundaries) if (boundary.tabId === tabId) boundary.pageChanged();
  }
});
chrome.tabs?.onRemoved?.addListener((tabId) => {
  clearSnapshot(tabId);
  for (const boundary of activeReadBoundaries) if (boundary.tabId === tabId) boundary.pageChanged();
});

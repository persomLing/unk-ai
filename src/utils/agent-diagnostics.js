import { diagnosticChangedFields, AGENT_EXECUTION_STATES, AGENT_STRATEGIES } from './agent-diagnostic-fields.js';

const ACTIONS = new Set('read_page read_region inspect_visual click_element type_text press_key scroll_page select_option navigate wait_for request_human_handoff finish_task fail_task update_plan upload_reference_image verify_state'.split(' '));
const STAGES = new Set('tab page-target control-permission normalize snapshot element frame-permission inspect frame-target element-signature safety target-permission approval recheck execute settle inject scan target focus select set events check submit complete request parse terminal read'.split(' '));
const REASONS = new Set('user-stop page-mode-disabled error-limit model-failure timeout no-progress repeated-failure action-unconfirmed deadline hard-step-limit step-limit-no-progress step-limit task-finished task-failed task-cancelled handoff paused disposed replaced'.split(' '));
const TAGS = new Set('input textarea select button a div span summary label form body html other'.split(' '));
const ROLES = new Set('textbox searchbox combobox button link checkbox radio switch spinbutton slider tab menuitem region other'.split(' '));
const INPUT_TYPES = new Set('text textarea search email url tel number password hidden checkbox radio range color date datetime-local month week time file button submit reset image'.split(' '));
const BOOLEANS = new Set('readOnly disabled connected visible focused valueMatched late repeated observedChange truncated verified'.split(' '));
const NUMBERS = new Set('durationMs frameId expectedChars actualChars errorCount elementCount frameCount attempt step maxSteps hardMaxSteps snapshotAgeMs textChars rowCount failureCount noProgressCount completedSteps totalSteps referenceCount inputTokens inputTextChars imageCount imageBytes readingCount removedReadings regionTextChars regionReadingCount'.split(' '));
const IDS = new Set('conversationId turnId taskId runId actionId tabId documentId snapshotId elementId targetId argumentId'.split(' '));
const EVENTS = new Set('agent.action.started agent.action.completed agent.action.failed agent.action.check agent.input.stage agent.observe.started agent.observe.completed agent.observe.failed agent.decision.completed agent.decision.failed agent.task.started agent.task.paused agent.task.stopped agent.task.progress agent.read.started agent.read.completed agent.read.failed agent.verify.completed agent.verify.failed'.split(' '));

/** An additional allowlist at the Agent boundary keeps even injected loggers value-free. */
export function agentDiagnosticData(value = {}) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (BOOLEANS.has(key) && typeof item === 'boolean') result[key] = item;
    else if (NUMBERS.has(key) && Number.isFinite(item)) result[key] = Math.max(0, Math.min(1e9, item));
    else if (key === 'action' && ACTIONS.has(item)) result[key] = item;
    else if (['stage', 'failureStage'].includes(key) && STAGES.has(item)) result[key] = item;
    else if (key === 'reason' && REASONS.has(item)) result[key] = item;
    else if (key === 'tag' && TAGS.has(item)) result[key] = item;
    else if (key === 'role' && ROLES.has(item)) result[key] = item;
    else if (key === 'inputType' && INPUT_TYPES.has(item)) result[key] = item;
    else if (key === 'status' && ['started', 'completed', 'failed', 'cancelled', 'paused', 'finished'].includes(item)) result[key] = item;
    else if (key === 'phase' && ['locate', 'settings', 'saving', 'permission', 'authorizing', 'activate', 'observe', 'read', 'think', 'wait', 'act', 'idle'].includes(item)) result[key] = item;
    else if (key === 'changedFields' && Array.isArray(item)) result[key] = diagnosticChangedFields(item);
    else if (key === 'executionStatus' && AGENT_EXECUTION_STATES.has(item)) result[key] = item;
    else if (key === 'strategy' && AGENT_STRATEGIES.has(item)) result[key] = item;
  }
  return result;
}

function diagnosticContext(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => IDS.has(key)
    && (key === 'tabId' ? Number.isInteger(item) : typeof item === 'string' && item.length > 0 && item.length <= 200)));
}

export function agentDiagnosticError(error, reason) {
  const value = typeof error === 'string' ? error : error?.code || error?.error;
  return {
    ...(typeof value === 'string' && /^ERR_[A-Z0-9_]{1,70}$/.test(value) ? { code: value } : error ? { code: 'ERR_AGENT_FAILED' } : {}),
    ...(['AbortError', 'TimeoutError', 'TypeError', 'Error', 'InvalidStateError', 'NotAllowedError', 'SecurityError', 'NotFoundError', 'DataCloneError', 'SyntaxError'].includes(error?.name) ? { name: error.name } : {}),
    ...(STAGES.has(reason) || REASONS.has(reason) ? { reason } : {}),
  };
}

export function createAgentDiagnosticReporter(record, source, context = {}) {
  const fixed = diagnosticContext(context);
  return (event, data = {}, error = null, extra = {}) => {
    try {
      if (!EVENTS.has(event)) return;
      const entry = { event, source, level: event.endsWith('.failed') || data.status === 'failed' ? 'error' : event.endsWith('.paused') ? 'warn' : 'info',
        context: { ...fixed, ...diagnosticContext(extra) }, data: agentDiagnosticData(data) };
      if (error) entry.error = agentDiagnosticError(error, error.reason);
      Promise.resolve(record?.(entry)).catch(() => {});
    } catch { /* Diagnostics must never affect a page action or task lifecycle. */ }
  };
}

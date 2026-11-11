import { diagnosticChangedFields, AGENT_EXECUTION_STATES, AGENT_STRATEGIES } from './agent-diagnostic-fields.js';

export const DIAGNOSTIC_VERSION = 1;
export const DIAGNOSTIC_RETENTION_DAYS = 7;
export const DIAGNOSTIC_FORMAT = 'unk-ai-diagnostic-shard';
export const DIAGNOSTIC_BUNDLE_FORMAT = 'unk-ai-diagnostic-bundle';
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^h_[a-f0-9]{64}$/;
const EVENT = /^(?:turn|model(?:\.request|\.transport)?|reading|research|agent(?:\.action|\.observation|\.observe|\.task|\.decision|\.input|\.read|\.verify)?|storage|runtime|diagnostic)\.(?:start|started|complete|completed|failed|cancelled|paused|resumed|observe|decision|action|action-result|request|headers|first-byte|progress|first-reasoning|first-content|fallback|body-started|body-completed|buffered|flushed|error|export|unknown|stopped|timeout|rejected|check|stage|bound|phase|terminal|persistence-error|commit-error)$/;
const SOURCES = new Set('sidepanel background content conversation chat turn-runner model-gateway llm-client page-reading web-research agent storage diagnostics runtime options'.split(' '));
const NUMBERS = 'durationMs elapsedMs transportDurationMs previousPhaseDurationMs step errorCount attempt httpStatus statusCode inputTokens outputTokens totalTokens textChars bytes count resultCount sourceCount elementCount frameCount rowCount queueLength pendingCount droppedCount firstByteMs firstContentMs firstReasoningMs chunkCount byteCount eventCount expectedChars actualChars frameId line column inputTextChars imageCount imageBytes readingCount removedReadings regionTextChars regionReadingCount'.split(' ');
const BOOLEANS = 'ok success cancelled timedOut partial hasContent hasReasoning hasOutput hasPageContext pageChanged permissionGranted requiresConfirmation safetyBlocked observedChange retried cached truncated streaming readOnly disabled connected visible valueMatched focused late'.split(' ');
const PHASES = new Set('unknown idle start started preparing preparation locate activate settings permission authorizing saving observe observation read reading region think decision act action verify inspect input write submit click scroll navigate wait model request transport headers body stream first-byte first-content first-reasoning progress fallback complete completed failed cancelled paused stopped cleanup buffer flush export render research checking-research web-research waiting-model gateway scanner background safety snapshot element before-input after-input value-check tab page-target control-permission normalize frame-permission frame-target element-signature target-permission approval recheck execute settle inject scan target focus select set events check parse terminal reading-index reading-related checking-evidence reading-deep reading-network compressing collecting-context reasoning answering'.split(' '));
const STATUS = new Set('unknown pending queued preparing started running streaming complete completed finished failed cancelled paused stopped done ok error success denied granted prompt unavailable unsupported partial timeout uncertain blocked waiting'.split(' '));
const PURPOSE = new Set('unknown chat answer main-answer main-reply agent-decision visual visual-decision auto-visual reading-decision research-decision web-research web-search web-fetch compression context-compression summary suggestions suggested-questions recommendation connection-test'.split(' '));
const ACTIONS = new Set('unknown click_element type_text press_key scroll_page select_option navigate wait wait_for read_page read_region inspect_visual finish_task fail_task handoff_to_user request_human_handoff capture_page observe update_plan upload_reference_image verify_state'.split(' '));
const REASONS = new Set('unknown timeout cancelled aborted closed unavailable permission-denied permission-prompt no-directory directory-unavailable storage-unavailable storage-quota storage-failed database-version file-conflict invalid-data overflow expired lock-unavailable busy network http-error empty-output truncated-output protocol-error background-unreachable page-changed snapshot-expired element-not-found element-changed element-disabled element-detached element-occluded not-editable input-rejected safety-blocked user-denied pending-unconfirmed export-limit complete empty reasoning-only truncated malformed error-event rate-limit unsupported-parameter missing-body stream-error user-stop page-mode-disabled error-limit model-failure no-progress repeated-failure action-unconfirmed deadline hard-step-limit step-limit-no-progress step-limit task-finished task-failed task-cancelled handoff paused disposed replaced'.split(' '));
for (const phase of PHASES) REASONS.add(phase);
const TAGS = new Set('unknown input textarea button select option a div span form iframe body document'.split(' '));
const ROLES = new Set('unknown textbox searchbox combobox button link checkbox radio switch spinbutton slider listbox option menuitem tab gridcell row cell region'.split(' '));
const INPUT_TYPES = new Set('unknown text search email number tel url password checkbox radio hidden submit button reset range date datetime-local month week time color file'.split(' '));
const ERROR_NAMES = new Set('Error TypeError RangeError SyntaxError AbortError TimeoutError NetworkError NotAllowedError NotFoundError SecurityError QuotaExceededError InvalidStateError DataCloneError UnknownError VersionError ConstraintError OperationError'.split(' '));
const CODES = /^[A-Z][A-Z0-9_]{2,79}$/;
const CONTEXT_IDS = ['conversationId', 'turnId', 'runId', 'taskId', 'requestId', 'actionId', 'documentId', 'snapshotId', 'elementId', 'targetId', 'argumentId'];

export function beijingDate(time = Date.now()) {
  return new Date(Number(time) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function oldestDiagnosticDate(time) {
  return beijingDate(Number(time) - (DIAGNOSTIC_RETENTION_DAYS - 1) * 86400000);
}

export function diagnosticError(code, reason = 'unknown', name = 'Error') {
  return Object.assign(new Error(reason), { code, reason, name });
}

export function sanitizeDiagnosticError(error) {
  if (!error || typeof error !== 'object') return undefined;
  const code = typeof error.code === 'string' && CODES.test(error.code) ? error.code : 'ERR_DIAGNOSTIC_UNKNOWN';
  const name = ERROR_NAMES.has(error.name) ? error.name : 'Error';
  let reason = REASONS.has(error.reason) ? error.reason : 'unknown';
  if (reason === 'unknown') reason = ({ TimeoutError: 'timeout', AbortError: 'aborted', NotAllowedError: 'permission-denied', QuotaExceededError: 'storage-quota', VersionError: 'database-version' })[name] || 'unknown';
  const result = { code, name, reason };
  if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) result.httpStatus = error.httpStatus;
  return result;
}

export function sanitizeDiagnosticData(data) {
  const result = {};
  if (!data || typeof data !== 'object') return result;
  for (const key of NUMBERS) if (Number.isFinite(data[key]) && data[key] >= 0 && data[key] <= Number.MAX_SAFE_INTEGER) result[key] = data[key];
  for (const key of BOOLEANS) if (typeof data[key] === 'boolean') result[key] = data[key];
  for (const key of ['maxSteps', 'hardMaxSteps', 'snapshotAgeMs', 'failureCount', 'noProgressCount', 'completedSteps', 'totalSteps', 'referenceCount']) {
    if (Number.isFinite(data[key]) && data[key] >= 0 && data[key] <= Number.MAX_SAFE_INTEGER) result[key] = data[key];
  }
  for (const key of ['repeated', 'verified']) if (typeof data[key] === 'boolean') result[key] = data[key];
  if (Array.isArray(data.changedFields)) result.changedFields = diagnosticChangedFields(data.changedFields);
  if (AGENT_EXECUTION_STATES.has(data.executionStatus)) result.executionStatus = data.executionStatus;
  if (AGENT_STRATEGIES.has(data.strategy)) result.strategy = data.strategy;
  if (Number.isInteger(data.status) && data.status >= 100 && data.status <= 599) result.httpStatus = data.status;
  for (const [key, values] of Object.entries({ phase: PHASES, previousPhase: PHASES, stage: PHASES, failureStage: PHASES, status: STATUS, purpose: PURPOSE, action: ACTIONS, reason: REASONS, tag: TAGS, role: ROLES, inputType: INPUT_TYPES })) {
    if (typeof data[key] === 'string') result[key] = values.has(data[key]) ? data[key] : 'unknown';
  }
  if (typeof data.errorCode === 'string' && CODES.test(data.errorCode)) result.errorCode = data.errorCode;
  if (typeof data.contentType === 'string') result.contentType = ['application/json', 'text/event-stream', 'text/html', 'text/plain', 'text/json', 'other', 'missing'].includes(data.contentType) ? data.contentType : 'other';
  if (typeof data.module === 'string' && data.module.length <= 160
    && data.module.trim() === data.module
    && /^(?:service-worker\.js|src\/(?:sidepanel|options)\/[a-z-]+\.js|assets\/[A-Za-z0-9_-]+\.js)$/.test(data.module)) result.module = data.module;
  if (typeof data.origin === 'string' && data.origin.length <= 8192) {
    try { const url = new URL(data.origin); if (['http:', 'https:'].includes(url.protocol) && url.origin.length <= 512) result.origin = url.origin; } catch { /* No arbitrary URL text is retained. */ }
  }
  return result;
}

export async function hashDiagnosticId(value, salt) {
  if (typeof value !== 'string' || !value || value.length > 4096) return undefined;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\u0000${value}`));
  return `h_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function sanitizeDiagnosticEvent(input, { salt, now, id }) {
  if (!input || typeof input !== 'object') throw diagnosticError('ERR_DIAGNOSTIC_INPUT', 'invalid-data');
  const context = {};
  await Promise.all(CONTEXT_IDS.map(async key => {
    const hash = await hashDiagnosticId(input.context?.[key], salt);
    if (hash) context[key] = hash;
  }));
  if (Number.isInteger(input.context?.tabId) && input.context.tabId >= 0) context.tabId = input.context.tabId;
  const result = {
    id, at: new Date(now).toISOString(),
    event: typeof input.event === 'string' && EVENT.test(input.event) ? input.event : 'diagnostic.unknown',
    level: ['debug', 'info', 'warn', 'error'].includes(input.level) ? input.level : 'info',
    source: SOURCES.has(input.source) ? input.source : 'diagnostics',
    context, data: sanitizeDiagnosticData(input.data),
  };
  const error = sanitizeDiagnosticError(input.error);
  if (error) result.error = error;
  return result;
}

/** Capture only approved scalar input before asynchronous storage/crypto work. */
export function snapshotDiagnosticInput(input) {
  if (!input || typeof input !== 'object') throw diagnosticError('ERR_DIAGNOSTIC_INPUT', 'invalid-data');
  const context = {};
  for (const key of CONTEXT_IDS) if (typeof input.context?.[key] === 'string' && input.context[key].length <= 4096) context[key] = input.context[key];
  if (Number.isInteger(input.context?.tabId)) context.tabId = input.context.tabId;
  return {
    event: typeof input.event === 'string' && EVENT.test(input.event) ? input.event : 'diagnostic.unknown',
    source: SOURCES.has(input.source) ? input.source : 'diagnostics',
    level: ['debug', 'info', 'warn', 'error'].includes(input.level) ? input.level : 'info',
    context, data: sanitizeDiagnosticData(input.data), error: sanitizeDiagnosticError(input.error),
  };
}

/** Files are untrusted input too: never export added text, credentials or raw IDs. */
export function validateStoredDiagnostic(input) {
  if (!input || !UUID.test(input.id) || !Number.isFinite(Date.parse(input.at))) return null;
  const context = {};
  for (const key of CONTEXT_IDS) if (typeof input.context?.[key] === 'string' && HASH.test(input.context[key])) context[key] = input.context[key];
  if (Number.isInteger(input.context?.tabId) && input.context.tabId >= 0) context.tabId = input.context.tabId;
  const event = {
    id: input.id, at: new Date(input.at).toISOString(),
    event: typeof input.event === 'string' && EVENT.test(input.event) ? input.event : 'diagnostic.unknown',
    level: ['debug', 'info', 'warn', 'error'].includes(input.level) ? input.level : 'info',
    source: SOURCES.has(input.source) ? input.source : 'diagnostics',
    context, data: sanitizeDiagnosticData(input.data),
  };
  const error = sanitizeDiagnosticError(input.error);
  if (error) event.error = error;
  if (typeof input.appVersion === 'string' && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(input.appVersion)) event.appVersion = input.appVersion;
  return event;
}

/** Diagnostics observe execution; neither their return values nor failures own it. */
export function safeDiagnostic(record, event) {
  try { Promise.resolve(record?.(event)).catch(() => {}); } catch { /* Optional telemetry. */ }
}

/** A durable browser record may still be waiting for its folder-sync result. */
export function observeConversationSaveDiagnostic(record, conversationId, saved) {
  const failed = saved?.syncStatus === 'error' || Boolean(saved?.syncError);
  const pending = saved?.syncStatus === 'pending';
  safeDiagnostic(record, { event: failed ? 'storage.failed' : pending ? 'storage.progress' : 'storage.completed',
    source: 'storage', level: failed ? 'error' : 'info', context: { conversationId },
    data: { stage: 'saving', status: saved?.syncStatus === 'synced' ? 'complete' : 'pending' },
    error: saved?.syncError ? diagnosticFailure({ message: saved.syncError }) : undefined });
}

/** Classify locally, then discard the raw message (which may contain secrets). */
export function diagnosticFailure(error) {
  const names = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'NetworkError',
    'NotAllowedError', 'NotFoundError', 'SecurityError', 'QuotaExceededError', 'InvalidStateError',
    'DataCloneError', 'UnknownError', 'VersionError', 'ConstraintError', 'OperationError'];
  const name = names.includes(error?.name) ? error.name : 'Error';
  // Exact internal codes only: an uppercase-looking external code can still be
  // a credential. Keep a fixed cause even when the user-facing wording changes.
  const causes = {
    PAGE_CHANGED: 'page-changed', PAGE_NOT_READY: 'unavailable', PAGE_READ_ABORTED: 'aborted', PAGE_READ_TIMEOUT: 'timeout',
    READING_BODY_REQUIRED: 'empty', READING_TIMEOUT: 'timeout', BODY_READ_TIMEOUT: 'timeout', DIRECTORY_READ_TIMEOUT: 'timeout',
    ADAPTIVE_READING_TIMEOUT: 'timeout', READING_DECISION_TIMEOUT: 'timeout',
    DEEP_READING_UNSUPPORTED: 'unavailable', DEEP_READING_UNAVAILABLE: 'unavailable', DEEP_READING_PERMISSION_DENIED: 'permission-denied',
    NETWORK_REQUIRED_EMPTY: 'empty', NETWORK_PERMISSION_DENIED: 'permission-denied', NETWORK_SENDER_DENIED: 'permission-denied',
    NETWORK_READING_FAILED: 'network', NETWORK_READING_STOPPED: 'stopped', NETWORK_READING_DISCONNECTED: 'background-unreachable',
    NETWORK_DEBUGGER_BUSY: 'busy', NETWORK_DEBUGGER_RELEASED: 'closed', NETWORK_DEBUGGER_TIMEOUT: 'timeout',
    NETWORK_TARGET_INVALID: 'invalid-data', NETWORK_ORIGIN_INVALID: 'invalid-data', NETWORK_SERVICE_DISPOSED: 'disposed',
    NETWORK_SESSION_INVALID: 'invalid-data', NETWORK_SESSION_EXPIRED: 'expired', NETWORK_SESSION_LIMIT: 'busy',
    NETWORK_CAPTURE_COMPLETE: 'complete', NETWORK_PANEL_CLOSED: 'closed', NETWORK_PORT_REQUIRED: 'background-unreachable',
    NETWORK_VALIDATION_TIMEOUT: 'timeout', NETWORK_VALIDATION_FINISHED: 'complete',
    NETWORK_RESPONSE_LIMIT: 'overflow', NETWORK_RESPONSE_FORMAT: 'malformed', NETWORK_SETTINGS_LIMIT: 'overflow',
    NETWORK_SETTINGS_VERSION: 'database-version', NETWORK_SETTINGS_INVALID: 'invalid-data', NETWORK_STORAGE_UNAVAILABLE: 'storage-unavailable',
    RESEARCH_TIMEOUT: 'timeout', RESEARCH_REQUEST_TIMEOUT: 'timeout', RESEARCH_FETCH_FAILED: 'network', RESEARCH_HTTP_ERROR: 'http-error',
    RESEARCH_EMPTY: 'empty', RESEARCH_NOT_DOCUMENT: 'malformed', RESEARCH_NOT_DIRECTORY: 'malformed',
    RESEARCH_LOGIN_REQUIRED: 'permission-denied', RESEARCH_REDIRECT_BLOCKED: 'safety-blocked', RESEARCH_TOO_LARGE: 'overflow',
    PDF_NO_TEXT: 'empty', CONVERSATION_DELETED: 'expired', CONVERSATION_GENERATION_MISMATCH: 'replaced', CONVERSATION_REVISION_CHANGED: 'file-conflict',
    ERR_MODEL_CANCELLED: 'aborted', ERR_MODEL_TIMEOUT: 'timeout', ERR_MODEL_REQUEST_FAILED: 'model-failure',
    ERR_MODEL_REQUEST_ID: 'invalid-data', ERR_MODEL_PURPOSE: 'invalid-data', ERR_MODEL_REQUEST_ID_REUSED: 'invalid-data',
    ERR_WEB_SEARCH_DISABLED: 'unavailable', ERR_WEB_FETCH_DISABLED: 'unavailable',
    ERR_DIAGNOSTIC_FILE_CONFLICT: 'file-conflict', ERR_DIAGNOSTIC_PERMISSION: 'permission-denied', ERR_DIAGNOSTIC_DIRECTORY: 'no-directory',
    ERR_DIAGNOSTIC_DATABASE: 'storage-unavailable', ERR_DIAGNOSTIC_VERSION: 'database-version', ERR_DIAGNOSTIC_LOCK: 'lock-unavailable',
    ERR_DIAGNOSTIC_TIMEOUT: 'timeout', ERR_DIAGNOSTIC_CLOSED: 'closed', ERR_DIAGNOSTIC_INPUT: 'invalid-data',
    ERR_DIAGNOSTIC_DATE: 'invalid-data', ERR_DIAGNOSTIC_ASYNC_MUTATION: 'invalid-data',
  };
  const code = typeof error?.code === 'string' && Object.hasOwn(causes, error.code) ? error.code : null;
  const message = String(error?.message || '');
  let reason = code ? causes[code] : 'unknown';
  if (code === 'ERR_DIAGNOSTIC_PERMISSION' && error.reason === 'permission-prompt') reason = 'permission-prompt';
  else if (code === 'ERR_DIAGNOSTIC_DATABASE' && error.reason === 'storage-failed') reason = 'storage-failed';
  if (!code) {
    if (name === 'AbortError') reason = 'aborted';
    else if (name === 'TimeoutError' || /超时|timed?\s*out/i.test(message)) reason = 'timeout';
    else if (['NotAllowedError', 'SecurityError'].includes(name) || /权限|授权|permission|not allowed/i.test(message)) reason = 'permission-denied';
    else if (/页面.*变化|文档.*变化|page.*changed|target.*changed/i.test(message)) reason = 'page-changed';
    else if (/receiving end|message port|connection.*closed|后台.*连接/i.test(message)) reason = 'background-unreachable';
    else if (/空回答|empty|no.*content/i.test(message)) reason = 'empty-output';
    else if (/截断|truncat|未正常结束/i.test(message)) reason = 'truncated-output';
    else if (/fetch|network|网络|无法连接/i.test(message)) reason = 'network';
    else if (name === 'QuotaExceededError') reason = 'storage-quota';
    else if (name === 'VersionError') reason = 'database-version';
  }
  const result = { name, reason, code: code || `ERR_${reason.replaceAll('-', '_').toUpperCase()}` };
  const httpStatus = error?.httpStatus ?? error?.status;
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
  return result;
}

export function observeModelDiagnostic(record, event) {
  if (!event || typeof event.type !== 'string') return;
  const type = event.type.startsWith('model.') ? event.type : `model.${event.type}`;
  safeDiagnostic(record, { event: type, source: 'model-gateway',
    level: type.endsWith('failed') ? 'error' : 'info',
    context: { runId: event.runId, requestId: event.requestId,
      conversationId: event.conversationId, turnId: event.turnId },
    data: { ...event, ...(event.data || {}), purpose: event.purpose },
    error: event.errorCode ? { code: event.errorCode, reason: event.reason, name: event.errorName } : undefined });
}

export function createApplicationDiagnostics({ record, runner, repository, now = Date.now }) {
  const runs = new Map();
  const contextFor = () => {
    const run = runner.active();
    return { runId: run?.runId, conversationId: run?.ref?.conversationId, turnId: run?.ref?.turnId };
  };
  function observe(event) {
    if (event.type === 'message') return;
    const previous = runs.get(event.runId);
    // Streaming currently emits phase on each token; log transitions only.
    if (event.type === 'phase' && previous?.phase === event.phase) return;
    const ref = runner.active()?.runId === event.runId ? runner.active().ref : previous?.ref;
    const context = { runId: event.runId, conversationId: event.conversationId, turnId: event.turnId };
    const terminal = event.type === 'terminal';
    const message = terminal && ref ? repository.get(ref)?.assistant : null;
    const failed = event.status === 'failed' || event.type.endsWith('error');
    safeDiagnostic(record, { event: `turn.${event.type}`, source: 'turn-runner', level: failed ? 'error' : 'info', context,
      data: { status: event.status, phase: terminal ? previous?.phase : event.phase,
        ...(terminal ? { durationMs: Math.max(0, event.at - (previous?.at ?? event.startedAt)) }
          : event.type === 'phase' && previous ? { previousPhase: previous.phase, previousPhaseDurationMs: Math.max(0, event.at - previous.at) } : {}),
        elapsedMs: Math.max(0, event.at - event.startedAt),
        ...(message ? { hasContent: Boolean(message.content), hasReasoning: Boolean(message.reasoning), partial: failed && Boolean(message.content) } : {}) },
      error: failed && message ? diagnosticFailure({ message: message.errorMessage, code: message.errorCode }) : undefined });
    if (terminal) runs.delete(event.runId);
    else {
      runs.set(event.runId, { at: event.at, phase: event.phase, ref });
      if (runs.size > 64) runs.delete(runs.keys().next().value);
    }
  }
  function wrap(operation, { event = 'reading', source = 'page-reading', stage = 'read', identify = () => ({}), describe = () => ({}), summarize = () => ({}) } = {}) {
    if (typeof operation !== 'function') return operation;
    return async (...args) => {
      const context = contextFor();
      try { Object.assign(context, identify(...args)); } catch { /* Metadata only. */ }
      const started = now();
      let data = { stage };
      try { data = { ...data, ...describe(...args) }; } catch { /* Observers cannot reject operations. */ }
      safeDiagnostic(record, { event: `${event}.started`, source, context, data });
      try {
        const result = await operation(...args);
        let evidence = {};
        try { evidence = summarize(result) || {}; } catch { /* Keep the actual result. */ }
        safeDiagnostic(record, { event: `${event}.completed`, source, context,
          data: { ...data, ...evidence, durationMs: Math.max(0, now() - started) } });
        return result;
      } catch (error) {
        safeDiagnostic(record, { event: `${event}.${error?.name === 'AbortError' ? 'cancelled' : 'failed'}`, source, context,
          level: error?.name === 'AbortError' ? 'info' : 'error',
          data: { ...data, durationMs: Math.max(0, now() - started) }, error: diagnosticFailure(error) });
        throw error;
      }
    };
  }
  return { observe, wrap, dispose: () => runs.clear() };
}

export function diagnosticCodeLocation(event, ownLocation) {
  let own;
  try { own = new URL(ownLocation); } catch { return {}; }
  if (!['chrome-extension:', 'http:', 'https:'].includes(own.protocol)) return {};
  const candidates = [{ url: event?.filename, line: event?.lineno, column: event?.colno }];
  const stack = event?.error?.stack || event?.reason?.stack;
  if (typeof stack === 'string') {
    for (const match of stack.slice(0, 8000).matchAll(/((?:chrome-extension|https?):\/\/[^\s)]+):(\d+):(\d+)/g)) {
      candidates.push({ url: match[1], line: Number(match[2]), column: Number(match[3]) });
    }
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.url);
      const filename = url.pathname.replace(/^\//, '');
      if (url.protocol !== own.protocol || url.host !== own.host || url.search || url.hash || url.username || url.password
        || !/^(?:service-worker\.js|src\/(?:sidepanel|options)\/[a-z-]+\.js|assets\/[A-Za-z0-9_-]+\.js)$/.test(filename)
        || filename.length > 160) continue;
      return { module: filename,
        ...(Number.isInteger(candidate.line) && candidate.line > 0 ? { line: candidate.line } : {}),
        ...(Number.isInteger(candidate.column) && candidate.column > 0 ? { column: candidate.column } : {}) };
    } catch { /* Only an own published module location may be retained. */ }
  }
  return {};
}

export function installRuntimeDiagnostics(target, record, source = 'sidepanel') {
  const onError = event => safeDiagnostic(record, { event: 'runtime.error', source, level: 'error',
    data: { stage: 'render', ...diagnosticCodeLocation(event, target.location?.href) }, error: diagnosticFailure(event.error || { message: event.message }) });
  const onRejection = event => safeDiagnostic(record, { event: 'runtime.error', source, level: 'error',
    data: { stage: 'wait', ...diagnosticCodeLocation(event, target.location?.href) }, error: diagnosticFailure(event.reason) });
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  safeDiagnostic(record, { event: 'runtime.started', source, data: {} });
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

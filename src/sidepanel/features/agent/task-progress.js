const VERSION = 1;
const MUTATIONS = new Set(['click_element', 'type_text', 'press_key', 'scroll_page', 'select_option', 'navigate', 'upload_reference_image']);
const EXECUTION_ACTIONS = new Set([...MUTATIONS].filter(action => action !== 'scroll_page'));
const STATE_EXECUTION_ACTIONS = new Set(['click_element', 'type_text', 'select_option', 'upload_reference_image']);
const EXECUTION_STATES = new Set(['not_started', 'started', 'verified', 'uncertain']);
const STATES = new Set(['pending', 'in_progress', 'completed']);
const text = (value, length = 200) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const integer = (value, fallback = 0, max = Number.MAX_SAFE_INTEGER) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.floor(Number(value)))) : fallback;
const stepLimit = (value, fallback) => value === 0 ? 0 : Number.isFinite(value) && value > 0 ? Math.max(1, integer(value)) : fallback;
const identity = value => ({ taskId: text(value?.taskId), tabId: Number.isInteger(value?.tabId) ? value.tabId : -1,
  url: typeof value?.url === 'string' ? value.url.trim() : '', documentId: text(value?.documentId) });
const scopeKey = value => JSON.stringify(identity(value));
const acceptedScope = (state, scope) => Boolean(state?.version === VERSION && scope && scopeKey(state.scope) === scopeKey(scope) && state.scope.epoch === scope.epoch);
const activeStep = state => state.plan.find(step => step.status === 'in_progress')?.id || '';
const stepFor = (state, id) => state.plan.find(step => step.id === id);
const currentEvidence = (state, step) => state.evidence.filter(item => item.verified && item.stepVerified && item.stepId === step.id && item.stepTitle === step.title);
const verifiedStep = (state, step) => currentEvidence(state, step).length > 0;

/** Recent history stays bounded; each current goal may retain one older proof. */
function retainTaskHistory(state) {
  const recentEvidence = new Set(state.evidence.slice(-160));
  const proofs = new Set(state.plan.map(step => currentEvidence(state, step).at(-1)).filter(Boolean));
  state.evidence = state.evidence.filter(item => recentEvidence.has(item) || proofs.has(item));
  const actionProofs = new Set(state.evidence.filter(item => item.verified && item.kind === 'action').map(item => item.actionId));
  const pinnedActions = new Set([...proofs].filter(item => item.kind === 'action').map(item => item.actionId));
  const recentOutcomes = new Set(state.outcomes.slice(-200));
  // Keep an older pinned action with its proof. Evict resolved receipts when
  // their proof expires, rather than restoring them as newly unverified work.
  state.outcomes = state.outcomes.filter(item => (recentOutcomes.has(item) || pinnedActions.has(item.actionId))
    && (!item.verified || actionProofs.has(item.actionId)));
}

// This flag is supplied by deterministic goal checks, never by model arguments.
// Browsing facts and incidental scrolls can explain a task without advancing its writes.
const executionEvidence = item => item.executionRelevant !== false && (item.kind === 'action'
  ? EXECUTION_ACTIONS.has(item.action) && item.changed === true
  : item.executionRelevant === true && (item.kind === 'state' || (item.kind === 'reading' && item.stepVerified === true)));

function normalizedPlan(steps) {
  if (!Array.isArray(steps) || steps.length < 3 || steps.length > 8) return null;
  const result = steps.map(step => ({ id: text(step?.id, 40), title: text(step?.title, 160), status: STATES.has(step?.status) ? step.status : '' }));
  if (result.some(step => !/^[a-zA-Z0-9_-]+$/.test(step.id) || !step.title || !step.status)
    || new Set(result.map(step => step.id)).size !== result.length || result.filter(step => step.status === 'in_progress').length > 1) return null;
  return result;
}

/** State only: callers own task leases, real observations, I/O and the hard wall-clock deadline. */
export function createTaskProgress(config = {}) {
  const requestedSteps = stepLimit(config.maxSteps, 12);
  const hardMaxSteps = stepLimit(config.hardMaxSteps, requestedSteps);
  // An unlimited hard budget has no soft step ceiling; safety/progress checks still apply.
  const maxSteps = hardMaxSteps === 0 ? 0 : Math.min(requestedSteps || hardMaxSteps, hardMaxSteps);
  const executionRequired = config.executionRequired === true;
  return {
    version: VERSION, scope: { ...identity(config), epoch: 1 },
    executionRequired,
    initialMaxSteps: maxSteps, maxSteps, hardMaxSteps,
    deadline: Number.isFinite(config.deadline) ? config.deadline : 0,
    noProgressLimit: Math.max(3, integer(config.noProgressLimit, executionRequired ? 4 : 6, 30)),
    plan: [], decisions: [], outcomes: [], failures: [], evidence: [],
    decisionCount: 0, noProgressDecisions: 0, progressVersion: 0, lastExtensionProgressVersion: 0,
    extensions: 0, sequence: 0, replan: { used: false, required: false, baseline: 0 }, lastState: null,
  };
}

export function taskProgressScope(state) { return Object.freeze({ ...state.scope }); }

/** A retained DOM key cannot carry write credit across task/page/document scopes. */
export function hasTaskExecutionOutcome(state, targetKey) {
  const target = text(targetKey, 200);
  if (!target || state?.version !== VERSION) return false;
  const current = scopeKey(state.scope);
  return state.outcomes.some(outcome => outcome.scopeKey === current && outcome.targetKey === target
    && outcome.ok && STATE_EXECUTION_ACTIONS.has(outcome.action));
}

/** Call only after the orchestrator has validated an expected document transition. */
export function setTaskProgressTarget(state, target) {
  const next = identity({ ...state.scope, ...target });
  if (next.taskId !== state.scope.taskId || next.tabId !== state.scope.tabId) return { accepted: false, reason: 'task-mismatch' };
  if (scopeKey(next) === scopeKey(state.scope)) return { accepted: true, changed: false };
  state.scope = { ...next, epoch: state.scope.epoch + 1 };
  if (!state.executionRequired) state.noProgressDecisions = 0;
  state.lastState = { kind: 'document-transition' };
  return { accepted: true, changed: true };
}

export function updateTaskPlan(state, input, scope) {
  if (!acceptedScope(state, scope)) return { accepted: false, ok: false, reason: 'stale-scope' };
  const steps = normalizedPlan(input?.steps);
  if (!steps) return { accepted: false, ok: false, reason: 'invalid-plan' };
  state.plan = steps;
  retainTaskHistory(state);
  state.replan.required = false;
  state.lastState = { kind: 'plan-updated' };
  return { accepted: true, ok: true, plan: taskProgressContext(state).plan };
}

export function recordTaskDecision(state, input = {}) {
  if (!acceptedScope(state, input.scope)) return { accepted: false, reason: 'stale-scope' };
  const id = text(input.decisionId);
  if (!id) return { accepted: false, reason: 'missing-id' };
  const key = `${state.scope.epoch}:${id}`;
  if (state.decisions.includes(key)) return { accepted: true, duplicate: true };
  state.decisions = [...state.decisions, key].slice(-200);
  state.decisionCount += 1;
  state.noProgressDecisions += 1;
  state.sequence += 1;
  state.lastState = { kind: 'decision', action: text(input.action, 60), step: integer(input.step) };
  return { accepted: true, duplicate: false };
}

function failureKey(value) { return JSON.stringify([value.scopeKey, value.action, value.targetKey, value.errorCode, value.failureStage]); }

export function recordTaskOutcome(state, input = {}) {
  if (!acceptedScope(state, input.scope)) return { accepted: false, reason: 'stale-scope' };
  const actionId = text(input.actionId);
  if (!actionId) return { accepted: false, reason: 'missing-id' };
  const old = state.outcomes.find(item => item.actionId === actionId);
  if (old) return { accepted: true, duplicate: true, failureCount: state.failures.find(item => item.key === old.failureKey)?.count || 0 };
  const stepId = text(input.stepId, 40) || activeStep(state);
  const outcome = {
    scopeKey: scopeKey(state.scope), actionId, action: text(input.action, 60), targetKey: text(input.targetKey, 200),
    ok: input.ok === true, uncertain: input.uncertain === true,
    executionStatus: EXECUTION_STATES.has(input.executionStatus) ? input.executionStatus : '',
    errorCode: text(input.errorCode, 100) || 'ERR_ACTION_FAILED', failureStage: text(input.failureStage, 80) || 'execute',
    stepId, stepTitle: stepFor(state, stepId)?.title || '', verified: false,
    requiresVerification: input.requiresVerification !== false && (MUTATIONS.has(input.action) || input.uncertain === true),
    sequence: ++state.sequence,
  };
  let failureCount = 0;
  if (!outcome.ok) {
    const key = failureKey(outcome);
    let failure = state.failures.find(item => item.key === key);
    if (!failure) { failure = { key, scopeKey: outcome.scopeKey, action: outcome.action, targetKey: outcome.targetKey, errorCode: outcome.errorCode, failureStage: outcome.failureStage, count: 0 }; state.failures.push(failure); }
    failure.count += 1;
    outcome.failureKey = key;
    failureCount = failure.count;
  }
  state.outcomes.push(outcome);
  const mayHaveMutated = MUTATIONS.has(outcome.action) && (outcome.ok || outcome.uncertain
    || ['started', 'verified', 'uncertain'].includes(outcome.executionStatus));
  const contradictedState = outcome.action === 'verify_state' && !outcome.ok
    && outcome.errorCode === 'ERR_STATE_NOT_MATCHED' && outcome.executionStatus === 'verified';
  if (outcome.targetKey && (mayHaveMutated || contradictedState)) {
    // A failed verification is not proof that the old value survived. Revoke
    // state and action proof for this target while preserving unrelated data.
    for (const evidence of state.evidence) if (['action', 'state'].includes(evidence.kind)
      && evidence.scopeKey === outcome.scopeKey && evidence.targetKey === outcome.targetKey) evidence.verified = false;
  }
  state.failures = state.failures.slice(-200);
  retainTaskHistory(state);
  state.lastState = { kind: outcome.ok ? 'action-awaiting-verification' : 'action-failed', action: outcome.action, failureCount, errorCode: outcome.ok ? '' : outcome.errorCode, failureStage: outcome.failureStage };
  return { accepted: true, duplicate: false, failureCount, needsVerification: outcome.requiresVerification && (outcome.ok || outcome.uncertain) };
}

/** verified is supplied by deterministic execution/observation code, never copied from model arguments. */
export function recordTaskEvidence(state, input = {}) {
  if (!acceptedScope(state, input.scope)) return { accepted: false, progressed: false, reason: 'stale-scope' };
  if (!['action', 'reading', 'state'].includes(input.kind)) return { accepted: false, progressed: false, reason: 'unsupported-evidence' };
  if (input.verified !== true) return { accepted: true, progressed: false, reason: 'unverified' };
  let outcome;
  let key;
  let stepId = text(input.stepId, 40) || activeStep(state);
  let changed = false;
  if (input.kind === 'action') {
    outcome = state.outcomes.find(item => item.actionId === input.actionId && item.scopeKey === scopeKey(state.scope));
    if (!outcome || (!outcome.ok && !outcome.uncertain) || !text(input.snapshotId)) return { accepted: false, progressed: false, reason: 'missing-action-evidence' };
    key = `action:${outcome.actionId}`;
    stepId = text(input.stepId, 40) || outcome.stepId;
    changed = input.changed === true;
    outcome.verified = true;
    outcome.uncertain = false;
    for (const failure of state.failures) {
      if (failure.scopeKey === outcome.scopeKey && failure.action === outcome.action && failure.targetKey === outcome.targetKey) failure.count = 0;
    }
  } else {
    const fingerprint = text(input.fingerprint, 200);
    if (!fingerprint) return { accepted: false, progressed: false, reason: 'missing-reading-fingerprint' };
    if (input.kind === 'state' && !text(input.snapshotId)) return { accepted: false, progressed: false, reason: 'missing-state-snapshot' };
    key = `${input.kind}:${scopeKey(state.scope)}:${fingerprint}`;
    changed = input.kind === 'reading';
  }
  const priorEvidence = state.evidence.find(item => item.key === key);
  const stepVerified = input.kind === 'action' || input.kind === 'state' || input.stepVerified === true;
  if (priorEvidence && (input.kind === 'action' || !stepVerified || state.evidence.some(item => item.verified && item.key === key && item.stepId === stepId && item.stepTitle === (stepFor(state, stepId)?.title || '')))) return { accepted: true, progressed: false, duplicate: true };
  const executionRelevant = typeof input.executionRelevant === 'boolean' ? input.executionRelevant : undefined;
  const evidence = { id: `evidence-${++state.sequence}`, key, scopeKey: scopeKey(state.scope), kind: input.kind,
    actionId: outcome?.actionId || '', action: outcome?.action || '', stepId, stepTitle: stepFor(state, stepId)?.title || '',
    targetKey: text(input.targetKey) || outcome?.targetKey || '',
    snapshotId: text(input.snapshotId), verified: true, stepVerified, executionRelevant,
    changed, sequence: state.sequence };
  const progressed = !priorEvidence && (changed || input.kind === 'state') && (!state.executionRequired || executionEvidence(evidence));
  evidence.progressed = progressed;
  state.evidence.push(evidence);
  retainTaskHistory(state);
  if (progressed) { state.progressVersion += 1; state.noProgressDecisions = 0; }
  state.lastState = { kind: input.kind === 'action' ? 'action-verified' : input.kind === 'state' ? 'state-verified' : 'reading-evidence', action: outcome?.action || '', evidenceId: evidence.id, changed };
  return { accepted: true, progressed, evidenceId: evidence.id };
}

export function assessTaskProgress(state, { step = 0, now = Date.now() } = {}) {
  const result = (decision, reason) => ({ decision, reason, maxSteps: state.maxSteps });
  if (state.deadline > 0 && now >= state.deadline) return result('stop', 'deadline');
  const current = scopeKey(state.scope);
  if (state.outcomes.some(item => item.scopeKey === current && item.uncertain && !item.verified)) return result('stop', 'action-unconfirmed');
  if (state.hardMaxSteps > 0 && step >= state.hardMaxSteps) return result('stop', 'hard-step-limit');
  const failures = state.failures.filter(item => item.scopeKey === current);
  const worst = Math.max(0, ...failures.map(item => item.count));
  if (worst >= 3) return result('stop', 'repeated-failure');
  const stalled = state.noProgressDecisions >= state.noProgressLimit;
  if ((worst >= 2 || stalled) && !state.replan.used) {
    state.replan = { used: true, required: true, baseline: state.noProgressDecisions };
    return result('replan', worst >= 2 ? 'repeated-failure' : 'no-progress');
  }
  if (stalled && state.replan.used && state.noProgressDecisions >= state.replan.baseline + 3) return result('stop', 'no-progress');
  if (state.hardMaxSteps > 0 && step >= state.maxSteps) {
    if (state.maxSteps >= state.hardMaxSteps) return result('stop', 'hard-step-limit');
    if (state.progressVersion <= state.lastExtensionProgressVersion || stalled) return result('stop', 'step-limit-no-progress');
    state.maxSteps = Math.min(state.hardMaxSteps, state.maxSteps + Math.max(1, Math.ceil(state.initialMaxSteps / 2)));
    state.lastExtensionProgressVersion = state.progressVersion;
    state.extensions += 1;
    return result('extend', 'verified-progress');
  }
  return result('continue', 'within-budget');
}

export function assessTaskCompletion(state, { scope } = {}) {
  if (!acceptedScope(state, scope)) return { ok: false, reason: 'stale-scope', missingStepIds: [] };
  const missingStepIds = state.plan.filter(step => step.status !== 'completed' || !verifiedStep(state, step)).map(step => step.id);
  if (missingStepIds.length) return { ok: false, reason: 'plan-unverified', missingStepIds };
  const pending = state.outcomes.filter(item => item.scopeKey === scopeKey(state.scope) && !item.verified && item.requiresVerification && (item.ok || item.uncertain)).filter(item => {
    if (item.uncertain) return true;
    const step = stepFor(state, item.stepId);
    return !step || step.status !== 'completed' || step.title !== item.stepTitle || !currentEvidence(state, step).some(evidence => evidence.sequence > item.sequence);
  });
  if (pending.length) return { ok: false, reason: 'action-unconfirmed', missingStepIds: [], pendingActionIds: pending.map(item => item.actionId) };
  return { ok: true, reason: 'verified', missingStepIds: [] };
}

export function taskProgressContext(state) {
  return {
    version: VERSION, executionRequired: state.executionRequired === true, maxSteps: state.maxSteps, hardMaxSteps: state.hardMaxSteps,
    plan: state.plan.map(step => ({ ...step, verified: verifiedStep(state, step), evidenceCount: currentEvidence(state, step).length })),
    decisionCount: state.decisionCount, noProgressDecisions: state.noProgressDecisions, noProgressLimit: state.noProgressLimit,
    ...(state.replan.used ? { recoveryDecisionsRemaining: Math.max(0, Math.min(3, state.replan.baseline + 3 - state.noProgressDecisions)) } : {}),
    verifiedProgressCount: state.progressVersion, extensions: state.extensions, replan: { ...state.replan },
    failures: state.failures.filter(item => item.scopeKey === scopeKey(state.scope) && item.count).slice(-8).map(({ action, targetKey, errorCode, failureStage, count }) => ({ action, targetKey, errorCode, failureStage, count })),
    pendingActionIds: state.outcomes.filter(item => item.scopeKey === scopeKey(state.scope) && !item.verified && item.requiresVerification && (item.ok || item.uncertain)).slice(-12).map(item => item.actionId),
    evidence: state.evidence.slice(-8).map(({ id, kind, actionId, action, stepId, snapshotId, scopeKey: sourceKey, verified, stepVerified, changed, executionRelevant }) => {
      const source = JSON.parse(sourceKey);
      return { id, kind, actionId, action, stepId, snapshotId, verified, stepVerified, changed, executionRelevant,
        source: { url: source.url, documentId: source.documentId } };
    }),
    lastState: state.lastState ? { ...state.lastState } : null,
  };
}

export function taskProgressCheckpoint(state) {
  return JSON.parse(JSON.stringify({ ...state, scope: { ...state.scope }, plan: state.plan.map(item => ({ ...item })) }));
}

/** Resume renews the local epoch. Unknown versions/owners never inherit completion or permission. */
export function restoreTaskProgress(saved, config = {}) {
  const savedOwnerMatches = saved?.version === VERSION && scopeKey(saved.scope) === scopeKey(config);
  const executionRequired = typeof config.executionRequired === 'boolean' ? config.executionRequired : savedOwnerMatches && saved.executionRequired === true;
  const state = createTaskProgress({ ...config, executionRequired });
  if (!saved || saved.version !== VERSION || scopeKey(saved.scope) !== scopeKey(state.scope)) return state;
  state.scope.epoch = integer(saved.scope?.epoch, 1) + 1;
  state.plan = normalizedPlan(saved.plan) || [];
  if (Number.isInteger(saved.maxSteps) && saved.maxSteps >= state.maxSteps && saved.maxSteps <= state.hardMaxSteps) state.maxSteps = saved.maxSteps;
  if (config.deadline !== 0 && Number.isFinite(saved.deadline) && saved.deadline > 0) state.deadline = state.deadline > 0 ? Math.min(state.deadline, saved.deadline) : saved.deadline;
  for (const key of ['decisionCount', 'noProgressDecisions', 'progressVersion', 'lastExtensionProgressVersion', 'extensions', 'sequence']) state[key] = integer(saved[key]);
  state.replan = { used: saved.replan?.used === true, required: saved.replan?.required === true, baseline: integer(saved.replan?.baseline) };
  state.decisions = (Array.isArray(saved.decisions) ? saved.decisions : []).filter(item => typeof item === 'string').slice(-200).map(item => text(item, 240));
  const current = scopeKey(state.scope);
  for (const item of (Array.isArray(saved.failures) ? saved.failures : []).slice(-200)) {
    if (item?.scopeKey !== current) continue;
    const failure = { scopeKey: current, action: text(item.action, 60), targetKey: text(item.targetKey), errorCode: text(item.errorCode, 100), failureStage: text(item.failureStage, 80), count: integer(item.count) };
    failure.key = failureKey(failure); state.failures.push(failure);
  }
  for (const item of (Array.isArray(saved.outcomes) ? saved.outcomes : []).slice(-208)) {
    if (item?.scopeKey !== current || !text(item.actionId)) continue;
    state.outcomes.push({ scopeKey: current, actionId: text(item.actionId), action: text(item.action, 60), targetKey: text(item.targetKey),
      ok: item.ok === true, uncertain: item.uncertain === true, verified: false, requiresVerification: item.requiresVerification !== false,
      executionStatus: EXECUTION_STATES.has(item.executionStatus) ? item.executionStatus : '',
      errorCode: text(item.errorCode, 100), failureStage: text(item.failureStage, 80), stepId: text(item.stepId, 40), stepTitle: text(item.stepTitle, 160), sequence: integer(item.sequence) });
  }
  for (const item of (Array.isArray(saved.evidence) ? saved.evidence : []).slice(-168)) {
    if (item?.scopeKey !== current || item.verified !== true || !['action', 'reading', 'state'].includes(item.kind) || typeof item.key !== 'string') continue;
    // Keep URL identity complete while bounding only the evidence fingerprint.
    const prefix = `${item.kind}:${current}:`;
    const key = item.kind === 'action' ? `action:${text(item.actionId)}`
      : item.key.startsWith(prefix) && text(item.key.slice(prefix.length), 200) ? `${prefix}${text(item.key.slice(prefix.length), 200)}` : '';
    if (!key || key !== item.key) continue;
    const outcome = item.kind === 'action' && state.outcomes.find(value => value.actionId === item.actionId && (value.ok || value.uncertain));
    if (item.kind === 'action' && (!outcome || !text(item.snapshotId))) continue;
    if (item.kind === 'state' && !text(item.snapshotId)) continue;
    const evidence = { id: text(item.id), key, scopeKey: current, kind: item.kind, actionId: text(item.actionId), action: text(item.action, 60),
      stepId: text(item.stepId, 40), stepTitle: text(item.stepTitle, 160), snapshotId: text(item.snapshotId), verified: true,
      targetKey: text(item.targetKey), stepVerified: item.kind === 'action' || item.kind === 'state' || item.stepVerified === true,
      executionRelevant: typeof item.executionRelevant === 'boolean' ? item.executionRelevant : undefined,
      progressed: item.progressed === true, changed: item.changed === true, sequence: integer(item.sequence) };
    state.evidence.push(evidence);
    if (outcome) { outcome.verified = true; outcome.uncertain = false; }
  }
  retainTaskHistory(state);
  // Restored history is context, not a fresh extension credit. Require new real evidence after resume.
  state.progressVersion = state.evidence.filter(item => item.verified && (item.progressed || item.changed)
    && (!state.executionRequired || executionEvidence(item))).length;
  state.lastExtensionProgressVersion = state.progressVersion;
  if (state.executionRequired && saved.executionRequired !== true) {
    // Legacy checkpoints counted fresh text as progress. Keep their history and
    // failure budgets, but route a stalled write through the existing bounded
    // recovery instead of inheriting an artificial zero-stall counter.
    state.noProgressDecisions = Math.max(state.noProgressDecisions, Math.min(state.decisionCount, state.noProgressLimit));
  }
  return state;
}

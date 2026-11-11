import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskProgress, taskProgressScope, setTaskProgressTarget, updateTaskPlan,
  recordTaskDecision, recordTaskOutcome, recordTaskEvidence, assessTaskProgress,
  assessTaskCompletion, taskProgressContext, taskProgressCheckpoint, restoreTaskProgress,
} from '../src/sidepanel/features/agent/task-progress.js';

const config = { taskId: 'task-one', tabId: 3, url: 'https://site.test/form', documentId: 'doc-one', maxSteps: 12, hardMaxSteps: 20, deadline: 10000 };
const create = extra => createTaskProgress({ ...config, ...extra });
const failure = (state, id, extra = {}) => recordTaskOutcome(state, {
  scope: taskProgressScope(state), actionId: id, action: 'select_option', targetKey: 'native-select',
  ok: false, errorCode: 'ERR_ELEMENT_CHANGED', failureStage: 'element-signature', ...extra,
});
const reading = (state, fingerprint) => recordTaskEvidence(state, {
  scope: taskProgressScope(state), kind: 'reading', fingerprint, verified: true, snapshotId: 'read-snapshot',
});
const decision = (state, step, action = 'read_page') => recordTaskDecision(state, {
  scope: taskProgressScope(state), decisionId: `decision-${step}`, step, action,
});
const plan = active => ['定位页面', '填写信息', '核对结果'].map((title, index) => ({
  id: `step-${index + 1}`, title, status: index < active ? 'completed' : index === active ? 'in_progress' : 'pending',
}));

test('a write task gets one recovery opportunity when new readings and plan edits leave all five goals unexecuted', () => {
  const state = create({ executionRequired: true });
  const scope = taskProgressScope(state);
  const steps = ['定位页面', '选择模型', '上传参考图', '填写提示词', '核对生成结果'].map((title, index) => ({
    id: `write-${index}`, title, status: index === 0 ? 'in_progress' : 'pending',
  }));
  updateTaskPlan(state, { steps }, scope);
  for (let index = 1; index <= 4; index += 1) {
    decision(state, index, index % 2 ? 'update_plan' : 'read_region');
    updateTaskPlan(state, { steps }, scope);
    assert.equal(reading(state, `new-page-wrapper-${index}`).progressed, false);
    assert.equal(recordTaskEvidence(state, { scope, kind: 'state', fingerprint: `unrelated-clock-${index}`,
      targetKey: 'unrelated-clock', verified: true, snapshotId: `snapshot-${index}` }).progressed, false);
  }
  assert.equal(taskProgressContext(state).plan.filter(item => item.status === 'completed' && item.verified).length, 0);
  assert.equal(taskProgressContext(state).noProgressDecisions, 4);
  assert.equal(assessTaskProgress(state, { step: 4, now: 1000 }).decision, 'replan');
  for (let index = 5; index <= 6; index += 1) {
    decision(state, index, 'read_page');
    reading(state, `recovery-reading-${index}`);
    updateTaskPlan(state, { steps }, scope);
    assert.equal(assessTaskProgress(state, { step: index, now: 1000 }).decision, 'continue');
  }
  decision(state, 7, 'verify_state');
  recordTaskEvidence(state, { scope, kind: 'state', fingerprint: 'unrelated-layout',
    targetKey: 'unrelated-layout', verified: true, snapshotId: 'snapshot-7' });
  assert.equal(assessTaskProgress(state, { step: 7, now: 1000 }).reason, 'no-progress');
  assert.equal(taskProgressContext(state).extensions, 0);
});

test('write-task reading and incidental scrolling cannot buy a step extension', () => {
  const state = create({ executionRequired: true });
  const scope = taskProgressScope(state);
  reading(state, 'first-reading');
  recordTaskOutcome(state, { scope, actionId: 'scroll', action: 'scroll_page', targetKey: 'page', ok: true });
  assert.equal(recordTaskEvidence(state, { scope, actionId: 'scroll', kind: 'action',
    verified: true, changed: true, snapshotId: 'scrolled' }).progressed, false);
  assert.equal(assessTaskProgress(state, { step: 12, now: 1000 }).decision, 'stop');
  assert.equal(taskProgressContext(state).verifiedProgressCount, 0);
});

test('write-task progress requires a verified effective action or a trusted corresponding goal state', () => {
  const state = create({ executionRequired: true, noProgressLimit: 3 });
  const scope = taskProgressScope(state);
  updateTaskPlan(state, { steps: plan(0) }, scope);
  decision(state, 1); decision(state, 2);
  recordTaskOutcome(state, { scope, actionId: 'choose', action: 'select_option', targetKey: 'model', ok: true });
  assert.equal(recordTaskEvidence(state, { scope, actionId: 'choose', kind: 'action',
    verified: true, changed: true, snapshotId: 'chosen' }).progressed, true);
  assert.equal(taskProgressContext(state).noProgressDecisions, 0);
  decision(state, 3);
  assert.equal(recordTaskEvidence(state, { scope, kind: 'state', fingerprint: 'model-correct', targetKey: 'model',
    executionRelevant: true, verified: true, snapshotId: 'model-correct' }).progressed, true);
  assert.equal(taskProgressContext(state).noProgressDecisions, 0);
  assert.equal(assessTaskProgress(state, { step: 12, now: 1000 }).decision, 'extend');
});

test('only a deterministically verified preparatory subgoal can make reading count for a write task', () => {
  const state = create({ executionRequired: true });
  const scope = taskProgressScope(state);
  updateTaskPlan(state, { steps: plan(0) }, scope);
  decision(state, 1);
  assert.equal(recordTaskEvidence(state, { scope, kind: 'reading', fingerprint: 'irrelevant-body',
    verified: true, executionRelevant: true, snapshotId: 'read' }).progressed, false);
  assert.equal(recordTaskEvidence(state, { scope, kind: 'reading', fingerprint: 'required-page',
    verified: true, executionRelevant: true, stepVerified: true, snapshotId: 'required' }).progressed, true);
  assert.equal(taskProgressContext(state).noProgressDecisions, 0);
  decision(state, 2, 'update_plan');
  updateTaskPlan(state, { steps: plan(1) }, scope);
  assert.equal(taskProgressContext(state).plan[0].verified, true);
  assert.equal(taskProgressContext(state).verifiedProgressCount, 1);
  assert.equal(taskProgressContext(state).noProgressDecisions, 1, 'declaring a verified step completed must not count its proof again');
});

test('write-task document transitions preserve stall counting and reject old-document callbacks', () => {
  const state = create({ executionRequired: true });
  const oldScope = taskProgressScope(state);
  for (let index = 1; index <= 4; index += 1) decision(state, index);
  assert.equal(setTaskProgressTarget(state, { ...config, documentId: 'doc-two' }).accepted, true);
  assert.equal(recordTaskEvidence(state, { scope: oldScope, kind: 'state', fingerprint: 'late',
    executionRelevant: true, verified: true, snapshotId: 'late' }).accepted, false);
  assert.equal(taskProgressContext(state).noProgressDecisions, 4);
  assert.equal(assessTaskProgress(state, { step: 4, now: 1000 }).decision, 'replan');
});

test('write-task checkpoints retain the execution policy and do not treat legacy readings as fresh execution', () => {
  const state = create({ executionRequired: true });
  decision(state, 1);
  reading(state, 'saved-page');
  const saved = taskProgressCheckpoint(state);
  assert.equal(saved.executionRequired, true);
  const restored = restoreTaskProgress(saved, config);
  assert.equal(taskProgressContext(restored).executionRequired, true);
  assert.equal(taskProgressContext(restored).noProgressDecisions, 1);
  assert.equal(taskProgressContext(restored).verifiedProgressCount, 0);
  assert.equal(taskProgressContext(restoreTaskProgress(saved, { ...config, taskId: 'another-task' })).executionRequired, false);
  assert.equal(taskProgressContext(restoreTaskProgress({ ...saved, version: 99 }, config)).executionRequired, false);

  const legacy = create();
  for (let index = 1; index <= 6; index += 1) { decision(legacy, index); reading(legacy, `old-reading-${index}`); }
  const legacySaved = taskProgressCheckpoint(legacy);
  delete legacySaved.executionRequired;
  const migrated = restoreTaskProgress(legacySaved, { ...config, executionRequired: true });
  assert.equal(taskProgressContext(migrated).plan.length, 0);
  assert.equal(taskProgressContext(migrated).verifiedProgressCount, 0);
  assert.equal(assessTaskProgress(migrated, { step: 6, now: 1000 }).decision, 'replan');
  assert.equal(assessTaskProgress(migrated, { step: 12, now: 1000 }).decision, 'stop');
});

test('reads never reset repeated action failures: replan at two, stop at three', () => {
  const state = create();
  assert.equal(failure(state, 'one').failureCount, 1);
  for (let i = 0; i < 5; i += 1) reading(state, `new-reading-${i}`);
  assert.equal(failure(state, 'two').failureCount, 2);
  assert.equal(assessTaskProgress(state, { step: 8, now: 1000 }).decision, 'replan');
  assert.equal(assessTaskProgress(state, { step: 8, now: 1001 }).decision, 'continue');
  updateTaskPlan(state, { steps: plan(0) }, taskProgressScope(state));
  reading(state, 'another-real-reading');
  assert.equal(failure(state, 'three').failureCount, 3);
  assert.equal(assessTaskProgress(state, { step: 10, now: 2000 }).decision, 'stop');
});

test('failure grouping includes the deterministic stage and ignores duplicate action results', () => {
  const state = create();
  failure(state, 'one');
  assert.equal(failure(state, 'one').duplicate, true);
  assert.equal(failure(state, 'two', { failureStage: 'execute' }).failureCount, 1);
  assert.equal(assessTaskProgress(state, { step: 2, now: 1000 }).decision, 'continue');
});

test('task and document ownership reject late outcomes and isolate a new document failure budget', () => {
  const state = create();
  const oldScope = taskProgressScope(state);
  failure(state, 'one');
  failure(state, 'two');
  assert.equal(recordTaskOutcome(state, { scope: { ...oldScope, taskId: 'another' }, actionId: 'foreign', ok: false }).accepted, false);
  assert.equal(setTaskProgressTarget(state, { ...config, documentId: 'doc-two' }).accepted, true);
  assert.equal(recordTaskOutcome(state, { scope: oldScope, actionId: 'late', ok: false }).accepted, false);
  assert.equal(recordTaskEvidence(state, { scope: oldScope, kind: 'reading', fingerprint: 'late-data', verified: true }).accepted, false);
  assert.equal(failure(state, 'new-one').failureCount, 1);
  assert.equal(assessTaskProgress(state, { step: 3, now: 1000 }).decision, 'continue');
  assert.equal(assessTaskProgress(create({ taskId: 'new-task' }), { step: 0, now: 1000 }).decision, 'continue');
});

test('model-completed plan steps require separate real evidence and renamed goals lose their old verification', () => {
  const state = create();
  updateTaskPlan(state, { steps: plan(3) }, taskProgressScope(state));
  assert.equal(assessTaskCompletion(state, { scope: taskProgressScope(state) }).ok, false);
  for (let index = 0; index < 3; index += 1) {
    updateTaskPlan(state, { steps: plan(index) }, taskProgressScope(state));
    const id = `action-${index}`;
    recordTaskOutcome(state, { scope: taskProgressScope(state), actionId: id, action: 'click_element', targetKey: `target-${index}`, ok: true });
    recordTaskEvidence(state, { scope: taskProgressScope(state), actionId: id, kind: 'action', verified: true, changed: true, snapshotId: `fresh-${index}` });
  }
  updateTaskPlan(state, { steps: plan(3) }, taskProgressScope(state));
  assert.equal(assessTaskCompletion(state, { scope: taskProgressScope(state) }).ok, true);
  const changed = plan(3); changed[0].title = '新增的其他工作';
  updateTaskPlan(state, { steps: changed }, taskProgressScope(state));
  assert.equal(assessTaskCompletion(state, { scope: taskProgressScope(state) }).ok, false);
});

test('simple legacy completion remains possible, but a successful unverified action cannot complete', () => {
  const state = create();
  const scope = taskProgressScope(state);
  assert.equal(assessTaskCompletion(state, { scope }).ok, true);
  recordTaskOutcome(state, { scope, actionId: 'write', action: 'type_text', targetKey: 'title', ok: true });
  assert.equal(assessTaskCompletion(state, { scope }).ok, false);
  reading(state, 'some-page-text');
  assert.equal(assessTaskCompletion(state, { scope }).ok, false);
  assert.equal(recordTaskEvidence(state, { scope, actionId: 'write', kind: 'action', verified: false, changed: true, snapshotId: 'fresh' }).progressed, false);
  recordTaskEvidence(state, { scope, actionId: 'write', kind: 'action', verified: true, changed: true, snapshotId: 'fresh' });
  assert.equal(assessTaskCompletion(state, { scope }).ok, true);
});

test('only a verified success of the same action and target resolves its failures', () => {
  const state = create();
  failure(state, 'one');
  failure(state, 'two');
  recordTaskOutcome(state, { scope: taskProgressScope(state), actionId: 'ok', action: 'select_option', targetKey: 'native-select', ok: true });
  assert.equal(assessTaskProgress(state, { step: 3, now: 1000 }).decision, 'replan');
  recordTaskEvidence(state, { scope: taskProgressScope(state), actionId: 'ok', kind: 'action', verified: true, changed: true, snapshotId: 'fresh' });
  assert.equal(assessTaskProgress(state, { step: 4, now: 1000 }).decision, 'continue');
  assert.equal(failure(state, 'new-failure').failureCount, 1);
});

test('repeated reading fingerprints and generic changed observations cannot manufacture progress', () => {
  const state = create();
  decision(state, 1);
  assert.equal(reading(state, 'same-body').progressed, true);
  decision(state, 2);
  assert.equal(reading(state, 'same-body').progressed, false);
  assert.equal(recordTaskEvidence(state, { scope: taskProgressScope(state), kind: 'observation', verified: true, changed: true, fingerprint: 'clock-changed' }).accepted, false);
  assert.equal(taskProgressContext(state).noProgressDecisions, 1);
  assert.equal(decision(state, 2).duplicate, true);
  assert.equal(taskProgressContext(state).noProgressDecisions, 1);
});

test('step extensions require fresh evidence, stay below the user hard cap and never extend the deadline', () => {
  const noEvidence = create();
  assert.equal(assessTaskProgress(noEvidence, { step: 12, now: 1000 }).decision, 'stop');
  const state = create();
  reading(state, 'first');
  const extended = assessTaskProgress(state, { step: 12, now: 1000 });
  assert.equal(extended.decision, 'extend');
  assert.equal(extended.maxSteps, 18);
  assert.equal(assessTaskProgress(state, { step: 18, now: 1000 }).decision, 'stop');
  reading(state, 'second');
  assert.equal(assessTaskProgress(state, { step: 18, now: 1000 }).maxSteps, 20);
  reading(state, 'third');
  assert.equal(assessTaskProgress(state, { step: 20, now: 1000 }).decision, 'stop');
  assert.equal(assessTaskProgress(state, { step: 5, now: 10000 }).reason, 'deadline');
});

test('no-progress gives one bounded replan opportunity and plan edits do not reset it', () => {
  const state = create({ noProgressLimit: 3 });
  for (let i = 1; i <= 3; i += 1) decision(state, i);
  assert.equal(assessTaskProgress(state, { step: 3, now: 1000 }).decision, 'replan');
  updateTaskPlan(state, { steps: plan(0) }, taskProgressScope(state));
  for (let i = 4; i <= 6; i += 1) decision(state, i);
  assert.equal(assessTaskProgress(state, { step: 6, now: 1000 }).decision, 'stop');
  assert.equal(taskProgressContext(state).replan.used, true);
});

test('an uncertain action stops before retries even with fresh unrelated reading evidence', () => {
  const state = create();
  failure(state, 'unknown', { uncertain: true, errorCode: 'ERR_ACTION_TIMEOUT', failureStage: 'execute' });
  reading(state, 'new-body');
  assert.equal(assessTaskProgress(state, { step: 2, now: 1000 }).reason, 'action-unconfirmed');
  assert.equal(assessTaskCompletion(state, { scope: taskProgressScope(state) }).ok, false);
});

test('checkpoint restoration validates identity, retains failures, renews epoch and caps saved budgets', () => {
  const state = create();
  const scope = taskProgressScope(state);
  updateTaskPlan(state, { steps: plan(0) }, scope);
  failure(state, 'one'); failure(state, 'two');
  const saved = JSON.parse(JSON.stringify(taskProgressCheckpoint(state)));
  saved.maxSteps = 999; saved.hardMaxSteps = 999;
  const restored = restoreTaskProgress(saved, config);
  assert.equal(taskProgressContext(restored).hardMaxSteps, 20);
  assert.equal(assessTaskProgress(restored, { step: 4, now: 1000 }).decision, 'replan');
  assert.equal(recordTaskOutcome(restored, { scope, actionId: 'late', ok: false }).accepted, false);
  const foreign = restoreTaskProgress(saved, { ...config, taskId: 'other' });
  assert.equal(taskProgressContext(foreign).plan.length, 0);
  assert.equal(assessTaskProgress(foreign, { step: 0, now: 1000 }).decision, 'continue');
  assert.equal(taskProgressContext(restoreTaskProgress({ ...saved, version: 99 }, config)).plan.length, 0);
});

test('reading verifies returned data but cannot complete a write goal without an explicit read-only step check', () => {
  const state = create();
  updateTaskPlan(state, { steps: plan(0) }, taskProgressScope(state));
  reading(state, 'real-page-body');
  assert.equal(taskProgressContext(state).plan[0].verified, false);
  recordTaskEvidence(state, { scope: taskProgressScope(state), kind: 'reading', fingerprint: 'verified-section', verified: true, stepVerified: true, snapshotId: 'fresh' });
  assert.equal(taskProgressContext(state).plan[0].verified, true);
});

test('the hard step cap wins over replanning and a soft cap cannot silently raise the user limit', () => {
  const state = create({ maxSteps: 20, hardMaxSteps: 10 });
  assert.equal(taskProgressContext(state).maxSteps, 10);
  failure(state, 'one'); failure(state, 'two');
  assert.equal(assessTaskProgress(state, { step: 10, now: 1000 }).decision, 'stop');
  assert.equal(taskProgressContext(state).replan.used, false);
});

test('changing an already verified control invalidates its earlier goal evidence', () => {
  const state = create();
  updateTaskPlan(state, { steps: plan(0) }, taskProgressScope(state));
  const scope = taskProgressScope(state);
  recordTaskOutcome(state, { scope, actionId: 'first', action: 'select_option', targetKey: 'same-field', ok: true });
  recordTaskEvidence(state, { scope, actionId: 'first', kind: 'action', snapshotId: 'first-snapshot', verified: true, changed: true });
  assert.equal(taskProgressContext(state).plan[0].verified, true);
  updateTaskPlan(state, { steps: plan(1) }, scope);
  recordTaskOutcome(state, { scope, actionId: 'second', action: 'select_option', targetKey: 'same-field', ok: true });
  assert.equal(taskProgressContext(state).plan[0].verified, false);
});

test('trusted fresh state assertions verify already-correct goals without manufacturing repeated progress', () => {
  const state = create();
  updateTaskPlan(state, { steps: plan(0) }, taskProgressScope(state));
  const scope = taskProgressScope(state);
  assert.equal(recordTaskEvidence(state, { scope, kind: 'state', fingerprint: 'checked:true', verified: true }).accepted, false);
  const evidence = { scope, kind: 'state', fingerprint: 'checked:true', snapshotId: 'fresh', verified: true };
  assert.equal(recordTaskEvidence(state, evidence).progressed, true);
  assert.equal(taskProgressContext(state).plan[0].verified, true);
  assert.equal(recordTaskEvidence(state, evidence).progressed, false);
  assert.equal(taskProgressContext(state).verifiedProgressCount, 1);
  updateTaskPlan(state, { steps: plan(1) }, scope);
  assert.equal(recordTaskEvidence(state, { ...evidence, snapshotId: 'newest' }).progressed, false);
  assert.equal(taskProgressContext(state).plan[1].verified, true);
  assert.equal(taskProgressContext(state).verifiedProgressCount, 1);
});

function completeStatePlan() {
  const state = create();
  const scope = taskProgressScope(state);
  for (let index = 0; index < 3; index += 1) {
    updateTaskPlan(state, { steps: plan(index) }, scope);
    recordTaskEvidence(state, { scope, kind: 'state', fingerprint: `field-${index}:correct`,
      targetKey: `field-${index}`, snapshotId: `snapshot-${index}`, verified: true });
  }
  updateTaskPlan(state, { steps: plan(3) }, scope);
  assert.equal(assessTaskCompletion(state, { scope }).ok, true);
  return state;
}

test('failed writes that reached execution revoke old target proof without revoking unrelated proof', () => {
  for (const executionStatus of ['started', 'verified', 'uncertain']) {
    const state = completeStatePlan();
    const scope = taskProgressScope(state);
    failure(state, 'retry', { targetKey: 'field-0', executionStatus, errorCode: 'ERR_ACTION_NOT_APPLIED', failureStage: 'check' });
    assert.equal(assessTaskCompletion(state, { scope }).ok, false, executionStatus);
    assert.deepEqual(taskProgressContext(state).plan.map(step => step.verified), [false, true, true]);
    assert.equal(taskProgressContext(state).failures[0].count, 1);
    assert.equal(taskProgressContext(restoreTaskProgress(taskProgressCheckpoint(state), config)).plan[0].verified, false);
  }
  const unchanged = completeStatePlan();
  failure(unchanged, 'rejected', { targetKey: 'field-0', executionStatus: 'not_started' });
  assert.equal(assessTaskCompletion(unchanged, { scope: taskProgressScope(unchanged) }).ok, true);
});

test('fresh state mismatches revoke stale proof and the same fact can be verified again without progress credit', () => {
  const state = completeStatePlan();
  const scope = taskProgressScope(state);
  recordTaskOutcome(state, { scope, actionId: 'mismatch', action: 'verify_state', targetKey: 'field-0',
    ok: false, errorCode: 'ERR_STATE_NOT_MATCHED', failureStage: 'check', executionStatus: 'verified', requiresVerification: false });
  assert.equal(assessTaskCompletion(state, { scope }).ok, false);
  assert.deepEqual(taskProgressContext(state).plan.map(step => step.verified), [false, true, true]);
  const outcome = recordTaskEvidence(state, { scope, kind: 'state', stepId: 'step-1', fingerprint: 'field-0:correct',
    targetKey: 'field-0', snapshotId: 'restored-state', verified: true });
  assert.equal(outcome.progressed, false);
  assert.equal(assessTaskCompletion(state, { scope }).ok, true);
  assert.equal(taskProgressContext(state).verifiedProgressCount, 3);
  assert.equal(taskProgressContext(state).failures[0].count, 1);
});

test('a failed different mutation of the same target revokes action proof too', () => {
  const state = create();
  const scope = taskProgressScope(state);
  updateTaskPlan(state, { steps: plan(0) }, scope);
  recordTaskOutcome(state, { scope, actionId: 'selected', action: 'select_option', targetKey: 'field', ok: true });
  recordTaskEvidence(state, { scope, actionId: 'selected', kind: 'action', snapshotId: 'selected-state', verified: true, changed: true });
  assert.equal(taskProgressContext(state).plan[0].verified, true);
  recordTaskOutcome(state, { scope, actionId: 'changed', action: 'press_key', targetKey: 'field',
    ok: false, executionStatus: 'started', errorCode: 'ERR_ACTION_NOT_APPLIED', failureStage: 'check' });
  assert.equal(taskProgressContext(state).plan[0].verified, false);
});

test('full URLs remain execution identity and long-URL evidence survives checkpoint restoration', () => {
  const url = `https://site.test/form?q=${'x'.repeat(2400)}`;
  const state = create({ url: `${url}&owner=one` });
  const scope = taskProgressScope(state);
  assert.equal(scope.url, `${url}&owner=one`);
  assert.equal(recordTaskOutcome(state, { scope: { ...scope, url: `${url}&owner=two` }, actionId: 'foreign', ok: false }).accepted, false);
  updateTaskPlan(state, { steps: plan(0) }, scope);
  recordTaskEvidence(state, { scope, kind: 'state', targetKey: 'field', fingerprint: 'field:correct', snapshotId: 'fresh', verified: true });
  const restored = restoreTaskProgress(taskProgressCheckpoint(state), { ...config, url: scope.url });
  assert.equal(taskProgressContext(restored).plan[0].verified, true);
  const repeated = recordTaskEvidence(restored, { scope: taskProgressScope(restored), kind: 'state', targetKey: 'field',
    fingerprint: 'field:correct', snapshotId: 'new-fresh', verified: true });
  assert.equal(repeated.duplicate, true);
});

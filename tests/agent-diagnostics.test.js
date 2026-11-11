import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentDiagnosticReporter, agentDiagnosticError } from '../src/utils/agent-diagnostics.js';
import { sanitizeDiagnosticEvent } from '../src/utils/diagnostic-schema.js';

test('Agent diagnostic metadata strips values and preserves usable tokens through the actual log schema', async () => {
  const entries = [];
  const original = { conversationId: 'conversation-old', taskId: 'task-old', tabId: 8 };
  const report = createAgentDiagnosticReporter(entry => entries.push(entry), 'background', original);
  original.conversationId = 'conversation-new';
  report('agent.input.stage', { action: 'type_text', stage: 'check', failureStage: 'check', tag: 'input', role: 'textbox',
    expectedChars: 12, actualChars: 0, valueMatched: false, focused: true,
    text: 'PRIVATE_INPUT', label: 'PRIVATE_LABEL', goal: 'PRIVATE_GOAL', args: { text: 'PRIVATE_NESTED' },
  }, { code: 'ERR_ACTION_FAILED', name: 'Error', reason: 'check', message: 'PRIVATE_ERROR' }, { actionId: 'action-old', elementId: 'e1' });
  assert.equal(entries[0].context.conversationId, 'conversation-old');
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_|conversation-new/);
  const stored = await sanitizeDiagnosticEvent(entries[0], { salt: 'test-only', now: 0, id: '00000000-0000-4000-8000-000000000001' });
  assert.equal(stored.event, 'agent.input.stage');
  assert.equal(stored.source, 'background');
  assert.equal(stored.data.failureStage, 'check');
  assert.equal(stored.data.actualChars, 0);
  assert.equal(stored.data.valueMatched, false);
  assert.equal(stored.error.reason, 'check');
  assert.match(stored.context.actionId, /^h_/);
  assert.doesNotMatch(JSON.stringify(stored), /conversation-old|task-old|action-old|PRIVATE_/);
});

test('all real Agent action names retain their meaning after diagnostic serialization', async () => {
  for (const action of ['type_text', 'click_element', 'wait_for', 'request_human_handoff', 'inspect_visual']) {
    let entry;
    createAgentDiagnosticReporter(value => { entry = value; }, 'agent', { taskId: 'task' })('agent.decision.completed', { action });
    const saved = await sanitizeDiagnosticEvent(entry, { salt: 'test-only', now: 0, id: '00000000-0000-4000-8000-000000000001' });
    assert.equal(saved.data.action, action);
  }
});

test('Agent request sizes survive serialization while request contents stay excluded', async () => {
  let entry;
  createAgentDiagnosticReporter(value => { entry = value; }, 'agent', { taskId: 'task' })('agent.decision.completed', {
    inputTokens: 500, inputTextChars: 1800, imageCount: 1, imageBytes: 8192, readingCount: 2, removedReadings: 1, regionTextChars: 2500, regionReadingCount: 1,
    prompt: 'PRIVATE_PROMPT', dataUrl: 'data:image/jpeg;base64,PRIVATE_IMAGE',
  });
  const saved = await sanitizeDiagnosticEvent(entry, { salt: 'test-only', now: 0, id: '00000000-0000-4000-8000-000000000001' });
  assert.deepEqual(saved.data, { inputTokens: 500, inputTextChars: 1800, imageCount: 1, imageBytes: 8192, readingCount: 2, removedReadings: 1, regionTextChars: 2500, regionReadingCount: 1 });
  assert.doesNotMatch(JSON.stringify([entry, saved]), /PRIVATE_|data:image/);
});

test('diagnostic failures cannot throw, and arbitrary external error messages are omitted', async () => {
  for (const record of [() => { throw new Error('PRIVATE_ERROR'); }, () => Promise.reject(new Error('PRIVATE_ERROR'))]) {
    const report = createAgentDiagnosticReporter(record, 'agent', { taskId: 'task' });
    assert.doesNotThrow(() => report('agent.action.failed', { action: 'click_element' }, agentDiagnosticError(new Error('PRIVATE_DETAIL'), 'execute')));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(agentDiagnosticError(new Error('PRIVATE_DETAIL'), 'execute'), { code: 'ERR_AGENT_FAILED', name: 'Error', reason: 'execute' });
});

test('Agent recovery evidence survives both allowlists without logging field values', async () => {
  let entry;
  const report = createAgentDiagnosticReporter(value => { entry = value; }, 'agent', { taskId: 'task' });
  report('agent.action.failed', {
    action: 'select_option', failureStage: 'element-signature', step: 7, maxSteps: 12, hardMaxSteps: 20,
    snapshotAgeMs: 12101, executionStatus: 'not-started', changedFields: ['name', 'formAction', 'PRIVATE_FIELD', 'name'],
    previousValue: 'PRIVATE_VALUE', currentValue: 'PRIVATE_VALUE',
  }, { code: 'ERR_ELEMENT_CHANGED', reason: 'element-signature' }, { targetId: 'fp_target', argumentId: 'fp_args' });
  const saved = await sanitizeDiagnosticEvent(entry, { salt: 'test-only', now: 0, id: '00000000-0000-4000-8000-000000000001' });
  assert.deepEqual(saved.data.changedFields, ['name', 'formAction']);
  assert.equal(saved.data.executionStatus, 'not-started');
  assert.equal(saved.data.snapshotAgeMs, 12101);
  assert.equal(saved.data.step, 7);
  assert.equal(saved.data.maxSteps, 12);
  assert.equal(saved.data.hardMaxSteps, 20);
  assert.match(saved.context.targetId, /^h_/);
  assert.match(saved.context.argumentId, /^h_/);
  assert.doesNotMatch(JSON.stringify([entry, saved]), /PRIVATE_/);
});

test('reading and recovery events keep their counts and outcome with no document text', async () => {
  for (const event of ['agent.read.started', 'agent.read.completed', 'agent.read.failed', 'agent.task.progress', 'agent.verify.completed']) {
    let entry;
    createAgentDiagnosticReporter(value => { entry = value; }, 'agent', { taskId: 'task' })(event,
      { action: 'read_region', textChars: 230, rowCount: 12, observedChange: false, repeated: true, strategy: 'replan', text: 'PRIVATE_BODY' });
    const saved = await sanitizeDiagnosticEvent(entry, { salt: 'test-only', now: 0, id: '00000000-0000-4000-8000-000000000001' });
    assert.equal(saved.event, event);
    assert.equal(saved.data.rowCount, 12);
    assert.equal(saved.data.strategy, 'replan');
    assert.equal(saved.data.repeated, true);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_BODY/);
  }
});

test('task stopping preserves the actual stall, uncertainty, deadline and step reasons through both allowlists', async () => {
  for (const reason of ['no-progress', 'repeated-failure', 'action-unconfirmed', 'deadline', 'hard-step-limit', 'step-limit-no-progress']) {
    let entry;
    createAgentDiagnosticReporter(value => { entry = value; }, 'agent', { taskId: 'task' })('agent.task.stopped', { reason }, { code: 'ERR_AGENT_FAILED', reason });
    const saved = await sanitizeDiagnosticEvent(entry, { salt: 'test-only', now: 0, id: '00000000-0000-4000-8000-000000000001' });
    assert.equal(saved.data.reason, reason);
    assert.equal(saved.error.reason, reason);
  }
});

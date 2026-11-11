import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentAction, verifyAgentState, needsAgentPlan, agentTargetKey, agentRecoveryProfile,
  verifyAgentUploadAcceptance } from '../src/sidepanel/features/agent/action-verification.js';

const page = selected => ({ url: 'https://example.test/form', summary: 'Form', elements: [{
  id: 'e1', stableKey: 'model', tag: 'select', role: 'combobox', name: 'Model', select: { selected: [{ value: selected, text: selected }] },
}] });

test('only a byte-matched receipt from the original upload and fresh page can resolve its uncertainty', () => {
  const before = { ...page('2.6'), tabId: 7, snapshotId: 'old', documentId: 'document' };
  before.elements = [{ id: 'e1', stableKey: 'file', frameId: 0, type: 'file' }];
  const after = { ...structuredClone(before), snapshotId: 'new', summary: '1/6, reference preview is visible' };
  const pending = { id: 'upload-1', action: 'upload_reference_image', args: { elementId: 'e1', referenceId: 'reference-1' }, observation: before,
    result: { error: 'ERR_UPLOAD_UNCERTAIN', upload: { requiresAcceptanceVerification: true, referenceId: 'reference-1', epoch: 3, documentId: 'document', frameId: 0 },
      diagnostics: { stages: [{ stage: 'check', valueMatched: false }] } } };
  const receipt = { version: 1, accepted: true, kind: 'new-matching-preview', taskId: 'task', tabId: 7, epoch: 3,
    documentId: 'document', frameId: 0, url: before.url, snapshotId: 'new', actionId: 'upload-1', referenceId: 'reference-1', serverConfirmed: false };
  const check = (value = receipt, current = after) => verifyAgentUploadAcceptance(pending, current, value, { taskId: 'task', tabId: 7 });
  assert.equal(check(), true);
  for (const changed of [{ accepted: false }, { kind: 'count-changed' }, { actionId: 'other' }, { referenceId: 'reference-2' },
    { taskId: 'other' }, { tabId: 8 }, { epoch: 4 }, { documentId: 'other' }, { frameId: 1 }, { snapshotId: 'old' },
    { url: before.url + '#other' }, { serverConfirmed: true }]) assert.equal(check({ ...receipt, ...changed }), false);
  assert.equal(check(null), false);
  assert.equal(check(receipt, { ...after, documentId: 'other' }), false);
  assert.equal(check(receipt, { ...after, snapshotId: 'old' }), false);
  assert.equal(check(receipt, { ...after, elements: [...after.elements, { ...after.elements[0], id: 'e2' }] }), false);
});
test('select verification requires the requested current value and tolerates renumbered snapshots', () => {
  const pending = { action: 'select_option', args: { elementId: 'e1', value: '2.6' }, observation: page('2.5') };
  const after = page('2.6'); after.elements[0].id = 'e14';
  assert.equal(verifyAgentAction(pending, after).verified, true);
  assert.equal(verifyAgentAction(pending, page('2.5')).verified, false);
  after.url += '/elsewhere';
  assert.equal(verifyAgentAction(pending, after).verified, false);
  assert.equal(agentTargetKey(pending, pending.observation), 'model');
});
test('unrelated page changes do not confirm checkbox changes or selection success', () => {
  const before = { url: 'https://example.test', summary: 'Form', elements: [{ id: 'e1', stableKey: 'animate', state: { checked: false } }] };
  const after = structuredClone(before); after.summary = 'Clock changed';
  const pending = { action: 'click_element', args: { elementId: 'e1' }, observation: before };
  assert.equal(verifyAgentAction(pending, after).verified, false);
  after.elements[0].state.checked = true;
  assert.equal(verifyAgentAction(pending, after).verified, true);
});
test('complexity and recovery do not silently change a model or enable unsupported thinking', () => {
  assert.equal(needsAgentPlan('选择2.6，勾选动态，上传图片，填写提示词并生成'), true);
  assert.equal(needsAgentPlan('选择2.6'), false);
  assert.equal(needsAgentPlan('解释页面内容'), false);
  assert.equal(needsAgentPlan('1. 读概述\n2. 读安装章节\n3. 比较差异'), false);
  assert.equal(agentRecoveryProfile({ reasoningEnabled: false, reasoningEffort: 'low' }), null);
  const original = { model: 'chosen', apiKey: 'test-only', reasoningEnabled: true, reasoningEffort: 'low' };
  assert.deepEqual(agentRecoveryProfile(original), { ...original, reasoningEffort: 'medium' });
  assert.equal(original.reasoningEffort, 'low');
});

test('already-satisfied state is verified without toggling, and ambiguous or foreign documents are rejected', () => {
  const action = { args: { elementId: 'e1', field: 'selectedValue', expected: '2.6' } };
  assert.equal(verifyAgentState(action, page('2.6'), page('2.6')).ok, true);
  assert.equal(verifyAgentState(action, page('2.6'), page('2.5')).ok, false);
  const duplicate = page('2.6'); duplicate.elements.push({ ...duplicate.elements[0], id: 'e9' });
  assert.equal(verifyAgentState(action, page('2.6'), duplicate).ok, false);
  assert.equal(verifyAgentState(action, { ...page('2.6'), documentId: 'old' }, { ...page('2.6'), documentId: 'new' }).error, 'ERR_PAGE_CHANGED');
});

test('old document execution results and truncated option prefixes cannot verify current controls', () => {
  for (const action of ['select_option', 'click_element', 'type_text', 'upload_reference_image']) {
    const before = { ...page('2.6'), documentId: 'old' };
    before.elements[0].state = { checked: false };
    const after = { ...page('2.6'), documentId: 'new' };
    after.elements[0].state = { checked: true };
    const pending = { action, args: { elementId: 'e1', value: '2.6' }, observation: before,
      result: { diagnostics: { valueMatched: true }, upload: { fileSelected: true } } };
    assert.equal(verifyAgentAction(pending, after).verified, false);
  }
  const prefix = 'x'.repeat(160);
  assert.equal(verifyAgentState({ args: { elementId: 'e1', field: 'selectedValue', expected: prefix } }, page(prefix), page(prefix)).ok, false);
});

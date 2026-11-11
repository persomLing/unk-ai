import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDomActionRequest,
  DOM_ACTION_TYPES,
  executeDomAction,
} from '../src/utils/dom-actions.js';

test('DOM action contract is reserved but explicitly marked unsupported', () => {
  const request = createDomActionRequest('click', { selector: '.example' });
  assert.deepEqual(DOM_ACTION_TYPES, ['click', 'type', 'scroll', 'select']);
  assert.equal(request.supported, false);
  assert.equal(request.risk, 'medium');
  assert.equal(request.requiresConfirmation, true);
});

test('the future executor does not mutate pages in this version', async () => {
  await assert.rejects(executeDomAction(), /只读网页/);
});

test('unknown DOM actions are rejected', () => {
  assert.throws(() => createDomActionRequest('navigate'), /不支持/);
});

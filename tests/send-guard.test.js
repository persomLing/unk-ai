import test from 'node:test';
import assert from 'node:assert/strict';

import { isDuplicateSend } from '../src/sidepanel/features/messages/send-guard.js';

test('rapid duplicate sends are rejected even while the first is being queued', () => {
  assert.equal(isDuplicateSend({
    fingerprint: 'hello',
    lastFingerprint: 'hello',
    lastSentAt: 1000,
    now: 1100,
  }), true);
});

test('a distinct prompt or a later send is accepted', () => {
  assert.equal(isDuplicateSend({
    fingerprint: 'hello',
    lastFingerprint: 'hello',
    lastSentAt: 1000,
    now: 1100,
  }), true);
  assert.equal(isDuplicateSend({
    fingerprint: 'hello',
    lastFingerprint: 'other',
    lastSentAt: 1000,
    now: 1100,
  }), false);
  assert.equal(isDuplicateSend({
    fingerprint: 'hello',
    lastFingerprint: 'hello',
    lastSentAt: 1000,
    now: 3000,
  }), false);
});

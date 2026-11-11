import test from 'node:test';
import assert from 'node:assert/strict';

import {
  storageBadgeState,
  storageSetupState,
} from '../src/sidepanel/features/storage/storage-state.js';

test('a configured folder with expired permission asks for reauthorization, not a new folder', () => {
  const state = storageSetupState({ supported: true, configured: true, granted: false });
  assert.equal(state.kind, 'permission');
  assert.equal(state.action, 'reauthorize');
  assert.match(state.title, /重新授权/);
});

test('a missing folder keeps the original setup action', () => {
  const state = storageSetupState({ supported: true, configured: false, granted: false });
  assert.equal(state.kind, 'missing');
  assert.equal(state.action, 'settings');
});

test('a granted folder hides the setup prompt and uses automatic-save copy', () => {
  assert.equal(storageSetupState({ supported: true, configured: true, granted: true }).hidden, true);
  const badge = storageBadgeState(
    { granted: true, configured: true, name: 'unk_ai_data' },
    { temporary: true, conversationName: 'conversation' },
  );
  assert.match(badge.label, /自动保存/);
  assert.equal(badge.saveVisible, true);
});

test('an expired permission uses the configured folder name in the badge', () => {
  const badge = storageBadgeState(
    { granted: false, configured: true, name: 'unk_ai_data' },
    { temporary: true },
  );
  assert.equal(badge.label, '本地文件夹待授权');
  assert.match(badge.title, /unk_ai_data/);
  assert.equal(badge.saveVisible, false);
});

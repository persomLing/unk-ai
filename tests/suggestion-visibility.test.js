import test from 'node:test';
import assert from 'node:assert/strict';

import { showSuggestionsFor } from '../src/sidepanel/features/messages/suggestion-visibility.js';

test('only the latest completed assistant answer exposes suggestions', () => {
  assert.equal(showSuggestionsFor(
    { id: 'a2', role: 'assistant', status: 'complete' },
    'a2',
  ), true);
  assert.equal(showSuggestionsFor(
    { id: 'a1', role: 'assistant', status: 'complete' },
    'a2',
  ), false);
});

test('user messages and streaming answers never expose suggestions', () => {
  assert.equal(showSuggestionsFor({ id: 'u1', role: 'user', status: 'complete' }, 'u1'), false);
  assert.equal(showSuggestionsFor({ id: 'a2', role: 'assistant', status: 'streaming' }, 'a2'), false);
});

test('old suggestions disappear as soon as a new user turn starts', () => {
  assert.equal(showSuggestionsFor(
    { id: 'a2', role: 'assistant', status: 'complete' },
    'a2',
    'user',
  ), false);
});

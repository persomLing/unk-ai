import test from 'node:test';
import assert from 'node:assert/strict';

import { findOpenTabForSource } from '../src/utils/page-target.js';

test('returns the existing active tab for an exact page match', () => {
  const tabs = [
    { id: 1, active: false, windowId: 10, url: 'https://lesson.example/course/4' },
    { id: 2, active: true, windowId: 11, url: 'https://lesson.example/course/4#quiz' },
  ];
  assert.equal(findOpenTabForSource(tabs, 'https://lesson.example/course/4').id, 2);
});

test('matches the same path when a single tab has tracking query parameters', () => {
  const tabs = [
    { id: 3, windowId: 10, url: 'https://lesson.example/course/4?from=home' },
    { id: 4, windowId: 10, url: 'https://lesson.example/course/5' },
  ];
  assert.equal(findOpenTabForSource(tabs, 'https://lesson.example/course/4').id, 3);
});

test('does not pick an arbitrary duplicate when the same path is ambiguous', () => {
  const tabs = [
    { id: 5, windowId: 10, url: 'https://lesson.example/course/4?a=1' },
    { id: 6, windowId: 10, url: 'https://lesson.example/course/4?b=2' },
  ];
  assert.equal(findOpenTabForSource(tabs, 'https://lesson.example/course/4'), null);
});

test('returns null only when no existing tab matches', () => {
  assert.equal(findOpenTabForSource([{ id: 7, url: 'https://other.example' }], 'https://lesson.example/course/4'), null);
  assert.equal(findOpenTabForSource([], 'https://lesson.example/course/4'), null);
});

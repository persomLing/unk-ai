import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  formatDate,
  formatTime,
  safeHttpUrl,
  truncateText,
} from '../src/sidepanel/core/format.js';

test('core formatters handle text, URLs, dates and byte limits', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
  assert.equal(safeHttpUrl('https://example.test/a'), 'https://example.test/a');
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(formatTime('not-a-date'), '');
  assert.equal(formatDate('not-a-date'), '');
  assert.equal(truncateText('  a   b  ', 3), 'a b');
});

test('core truncation follows lodash clamp semantics', () => {
  assert.equal(truncateText('abcdef', 3), 'abc…');
  assert.equal(truncateText('abcdef', -1), '…');
});

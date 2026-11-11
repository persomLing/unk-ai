import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeFramePages } from '../src/utils/page-merge.js';

function frameResult(frameId, text, extra = {}) {
  return {
    frameId,
    result: {
      title: `Frame ${frameId}`,
      url: `https://example.test/frame-${frameId}`,
      text,
      sections: [{ level: 1, text: `Section ${frameId}` }],
      figures: [],
      structure: {
        landmarks: [],
        headings: [{ level: 1, text: `Section ${frameId}` }],
        links: [],
        tables: [],
        forms: [],
        figures: [],
        truncated: {},
      },
      ...extra,
    },
  };
}

test('merges top document and accessible iframe text with frame boundaries', () => {
  const merged = mergeFramePages([
    frameResult(0, 'Main article body that is long enough.'),
    frameResult(3, 'Embedded lesson body that is also long enough.'),
  ]);
  assert.match(merged.text, /Main article body/);
  assert.match(merged.text, /<embedded_frame source="Frame 3 · https:\/\/example\.test\/frame-3">/);
  assert.match(merged.text, /Embedded lesson body/);
  assert.equal(merged.frameCount, 1);
  assert.deepEqual(merged.structure.headings.map((item) => item.text), [
    'Section 0',
    'Section 3',
  ]);
});

test('ignores empty and failed frames and enforces the text budget', () => {
  const merged = mergeFramePages([
    frameResult(0, 'A'.repeat(5000)),
    frameResult(1, 'ignored'),
    { frameId: 2, result: { error: 'blocked' } },
    frameResult(4, 'B'.repeat(5000)),
  ], 2200);
  assert.ok(merged.text.length <= 2200);
  assert.equal(merged.truncated, true);
  assert.doesNotMatch(merged.text, /ignored/);
  assert.match(merged.text, /embedded_frame/);
});

test('returns null when no frame exposes readable text', () => {
  assert.equal(mergeFramePages([{ frameId: 0, result: { error: 'blocked' } }]), null);
  assert.equal(mergeFramePages([]), null);
});

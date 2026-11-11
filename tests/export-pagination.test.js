import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_LIMITS, assertExportActive, exportCanvasSize, paginateHeight } from '../src/sidepanel/features/export/pagination.js';

function covers(pages, height, capacity) {
  assert.equal(pages[0].top, 0);
  assert.equal(pages.at(-1).bottom, Math.ceil(height));
  assert.equal(pages.reduce((sum, page) => sum + page.height, 0), Math.ceil(height));
  pages.forEach((page, i) => {
    assert.equal(page.height, page.bottom - page.top);
    assert.ok(page.height > 0 && page.height <= capacity);
    if (i) assert.equal(page.top, pages[i - 1].bottom);
  });
}

test('pagination covers all content once and moves a crossing text line to the next page', () => {
  const pages = paginateHeight(253.2, { pageHeight: 100, lines: [{ top: 94.5, bottom: 109.2 }] });
  assert.equal(pages[0].bottom, 94);
  covers(pages, 253.2, 100);
});

test('short table rows and heading groups stay together when space permits', () => {
  const pages = paginateHeight(250, { pageHeight: 100, blocks: [{ top: 72, bottom: 120 }, { top: 160, bottom: 187 }],
    lines: [{ top: 66, bottom: 75 }] });
  assert.equal(pages[0].bottom, 66);
  covers(pages, 250, 100);
});

test('long code and paragraphs split at line boundaries without dropping their tail', () => {
  const lines = Array.from({ length: 125 }, (_, i) => ({ top: i * 19 + 2, bottom: i * 19 + 18 }));
  const pages = paginateHeight(2375, { pageHeight: 100, lines, blocks: [{ top: 0, bottom: 2375 }] });
  covers(pages, 2375, 100);
  for (const page of pages.slice(0, -1)) {
    assert.equal(lines.some(line => line.top < page.bottom && line.bottom > page.bottom), false);
  }
});

test('one oversized unbreakable item is sliced continuously instead of losing content or looping', () => {
  const pages = paginateHeight(325, { pageHeight: 100, lines: [{ top: 0, bottom: 325 }] });
  covers(pages, 325, 100);
  assert.equal(pages.length, 4);
});

test('limits reject huge documents and invalid geometry rather than returning a partial export', () => {
  assert.throws(() => paginateHeight(4001, { pageHeight: 100 }), /40 页/);
  assert.throws(() => paginateHeight(4000, { pageHeight: 100, lines: [{ top: 99, bottom: 105 }] }), /40 页/);
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => paginateHeight(value), TypeError);
    assert.throws(() => exportCanvasSize(value), TypeError);
  }
  assert.throws(() => paginateHeight(100, { maxPages: 41 }), TypeError);
  assert.throws(() => paginateHeight(100, { pageHeight: 0.5 }), TypeError);
  assert.throws(() => exportCanvasSize(16001), /改用 PDF/);
  assert.throws(() => exportCanvasSize(100, { format: 'html' }), TypeError);
});

test('PNG stays sharp while canvas allocation respects the pixel and edge budgets', () => {
  const small = exportCanvasSize(1000);
  assert.equal(small.scale, 2);
  const tall = exportCanvasSize(16000);
  assert.ok(tall.scale >= 1.5 && tall.scale <= 2);
  assert.ok(tall.pixelWidth * tall.pixelHeight <= EXPORT_LIMITS.canvasPixels);
  assert.ok(tall.pixelHeight <= EXPORT_LIMITS.canvasEdge);
  assert.throws(() => exportCanvasSize(50000, { format: 'pdf' }), /画布上限/);
});

test('already cancelled exports reject before allocating or paginating', () => {
  const controller = new AbortController();
  controller.abort(new DOMException('停止导出', 'AbortError'));
  for (const action of [() => assertExportActive(controller.signal),
    () => paginateHeight(100, { signal: controller.signal }),
    () => exportCanvasSize(100, { signal: controller.signal })]) {
    assert.throws(action, error => error.name === 'AbortError' && error.message === '停止导出');
  }
});

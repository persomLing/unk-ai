export const EXPORT_LIMITS = Object.freeze({
  width: 800,
  pngHeight: 16000,
  canvasPixels: 32_000_000,
  canvasEdge: 32760,
  pages: 40,
  pageHeight: Math.floor(800 * 273 / 186),
});

export function assertExportActive(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('导出已取消。', 'AbortError');
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name}必须是有限正数。`);
}

export function exportCanvasSize(height, { format = 'png', signal } = {}) {
  assertExportActive(signal);
  positive(height, '导出高度');
  if (!['png', 'pdf'].includes(format)) throw new TypeError('不支持的导出格式。');
  const cssHeight = Math.ceil(height);
  if (format === 'png' && cssHeight > EXPORT_LIMITS.pngHeight) {
    throw new Error('内容过长，PNG 最多支持 16000 像素高度，请减少所选回合或改用 PDF。');
  }
  const scale = Math.min(2, Math.sqrt(EXPORT_LIMITS.canvasPixels / (EXPORT_LIMITS.width * cssHeight)),
    EXPORT_LIMITS.canvasEdge / cssHeight);
  if (scale < 1.5) throw new Error('内容超过清晰导出的画布上限，请减少所选回合或改用 PDF。');
  // Rounding down keeps the allocated canvas inside the pixel budget.
  const pixelWidth = Math.floor(EXPORT_LIMITS.width * scale);
  const pixelHeight = Math.floor(cssHeight * scale);
  return { width: EXPORT_LIMITS.width, height: cssHeight, scale, pixelWidth, pixelHeight };
}

function normalizedIntervals(intervals, totalHeight) {
  return intervals.filter(item => Number.isFinite(item?.top) && Number.isFinite(item?.bottom)
    && item.bottom > item.top && item.bottom > 0 && item.top < totalHeight)
    .map(item => ({ top: Math.max(0, Math.floor(item.top)), bottom: Math.min(totalHeight, Math.ceil(item.bottom)) }))
    .sort((a, b) => a.top - b.top);
}

function safeCut(start, end, intervals) {
  let cut = end;
  // Moving upward can intersect an earlier overlapping line or table row.
  for (let index = intervals.length - 1; index >= 0; index--) {
    const item = intervals[index];
    if (item.top < cut && item.bottom > cut) cut = Math.max(start, item.top);
  }
  return cut;
}

/** Consecutive slices cover every CSS pixel exactly once, including oversized blocks. */
export function paginateHeight(totalHeight, { pageHeight = EXPORT_LIMITS.pageHeight,
  lines = [], blocks = [], maxPages = EXPORT_LIMITS.pages, signal } = {}) {
  assertExportActive(signal);
  positive(totalHeight, '内容高度');
  positive(pageHeight, '页面高度');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > EXPORT_LIMITS.pages) {
    throw new TypeError('导出页数上限必须为 1 到 40 的整数。');
  }
  const height = Math.ceil(totalHeight);
  const capacity = Math.floor(pageHeight);
  if (capacity < 1) throw new TypeError('页面高度至少为 1 像素。');
  if (height > capacity * maxPages) throw new Error(`内容超过 ${maxPages} 页，请减少所选回合。`);
  const lineRanges = normalizedIntervals(lines, height);
  const blockRanges = normalizedIntervals(blocks, height).filter(item => item.bottom - item.top <= capacity * 0.8);
  const pages = [];
  let top = 0;
  while (top < height) {
    assertExportActive(signal);
    if (pages.length >= maxPages) throw new Error(`内容分页后超过 ${maxPages} 页，请减少所选回合。`);
    const target = Math.min(top + capacity, height);
    let bottom = target;
    if (target < height) {
      const withBlocks = safeCut(top, safeCut(top, target, blockRanges), lineRanges);
      bottom = withBlocks >= top + capacity * 0.4 ? withBlocks : safeCut(top, target, lineRanges);
      // A single unbreakable item taller than a page is sliced without dropping pixels.
      if (bottom <= top) bottom = target;
    }
    pages.push({ top, bottom, height: bottom - top });
    top = bottom;
  }
  return pages;
}

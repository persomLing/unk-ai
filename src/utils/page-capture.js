export const CAPTURE_MESSAGE_TYPES = Object.freeze({
  visible: 'CAPTURE_ACTIVE_TAB',
  fullPage: 'CAPTURE_FULL_PAGE',
  region: 'CAPTURE_PAGE_REGION',
  cancel: 'CANCEL_PAGE_CAPTURE',
  progress: 'CAPTURE_PAGE_PROGRESS',
});

export const PAGE_CAPTURE_DEFAULTS = Object.freeze({
  captureQuality: 76,
  quality: 80,
  maxWidth: 1600,
  maxHeight: 16000,
  maxPixels: 24_000_000,
  maxBytes: 4 * 1024 * 1024,
  maxChunks: 18,
  timeoutMs: 45_000,
  settleMs: 90,
  throttleMs: 560,
  includeFixedHeader: true,
});

const NUMBER_LIMITS = {
  captureQuality: [30, 95],
  quality: [30, 95],
  maxWidth: [320, 4096],
  maxHeight: [480, 24_000],
  maxPixels: [1_000_000, 64_000_000],
  maxBytes: [256 * 1024, 16 * 1024 * 1024],
  maxChunks: [1, 30],
  timeoutMs: [2_000, 120_000],
  settleMs: [0, 2_000],
  throttleMs: [0, 3_000],
};

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Math.round(clamp(finiteNumber(value, fallback), minimum, maximum));
}

export function normalizePageCaptureOptions(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {};
  for (const [key, fallback] of Object.entries(PAGE_CAPTURE_DEFAULTS)) {
    if (key === 'includeFixedHeader') continue;
    const [minimum, maximum] = NUMBER_LIMITS[key];
    normalized[key] = boundedInteger(source[key], fallback, minimum, maximum);
  }
  normalized.includeFixedHeader = source.includeFixedHeader !== false;
  return normalized;
}

function rawPageMetrics(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const viewportWidth = Math.max(1, Math.round(finiteNumber(
    source.viewportWidth ?? source.width,
    1,
  )));
  const viewportHeight = Math.max(1, Math.round(finiteNumber(
    source.viewportHeight ?? source.height,
    1,
  )));
  const pageWidth = Math.max(viewportWidth, Math.round(finiteNumber(
    source.pageWidth ?? source.scrollWidth,
    viewportWidth,
  )));
  const pageHeight = Math.max(viewportHeight, Math.round(finiteNumber(
    source.pageHeight ?? source.scrollHeight,
    viewportHeight,
  )));
  const fixedHeaderHeight = clamp(
    Math.round(finiteNumber(source.fixedHeaderHeight ?? source.headerHeight, 0)),
    0,
    Math.floor(viewportHeight * 0.35),
  );
  const captureWidth = Math.max(viewportWidth, Math.round(finiteNumber(
    source.captureWidth,
    viewportWidth,
  )));
  const captureHeight = Math.max(viewportHeight, Math.round(finiteNumber(
    source.captureHeight,
    viewportHeight,
  )));
  const contentLeft = clamp(
    Math.round(finiteNumber(source.contentLeft, 0)),
    0,
    captureWidth - viewportWidth,
  );
  const contentTop = clamp(
    Math.round(finiteNumber(source.contentTop, 0)),
    0,
    captureHeight - viewportHeight,
  );
  const captureDevicePixelRatio = clamp(finiteNumber(
    source.captureDevicePixelRatio ?? source.devicePixelRatio,
    1,
  ), 0.5, 4);
  return {
    viewportWidth,
    viewportHeight,
    pageWidth,
    pageHeight,
    scrollX: Math.max(0, Math.round(finiteNumber(source.scrollX, 0))),
    scrollY: Math.max(0, Math.round(finiteNumber(source.scrollY, 0))),
    devicePixelRatio: clamp(finiteNumber(source.devicePixelRatio, 1), 0.5, 4),
    fixedHeaderHeight,
    captureWidth,
    captureHeight,
    contentLeft,
    contentTop,
    captureDevicePixelRatio,
    title: String(source.title || ''),
    url: String(source.url || ''),
  };
}

// Keeps the public normalizer strict for tests and callers: unknown fields are
// intentionally stripped. Capture-specific fields are parsed by the planner.
export function normalizePageMetrics(value = {}) {
  return rawPageMetrics(value);
}

function capturePageMetrics(value = {}) {
  const metrics = rawPageMetrics(value);
  const source = value && typeof value === 'object' ? value : {};
  metrics.captureWidth = Math.max(metrics.viewportWidth, Math.round(finiteNumber(
    source.captureWidth,
    metrics.viewportWidth,
  )));
  metrics.captureHeight = Math.max(metrics.viewportHeight, Math.round(finiteNumber(
    source.captureHeight,
    metrics.viewportHeight,
  )));
  metrics.contentLeft = clamp(
    Math.round(finiteNumber(source.contentLeft, 0)),
    0,
    metrics.captureWidth - metrics.viewportWidth,
  );
  metrics.contentTop = clamp(
    Math.round(finiteNumber(source.contentTop, 0)),
    0,
    metrics.captureHeight - metrics.viewportHeight,
  );
  metrics.captureDevicePixelRatio = clamp(finiteNumber(
    source.captureDevicePixelRatio ?? source.devicePixelRatio,
    1,
  ), 0.5, 4);
  return metrics;
}

/**
 * Build a vertical capture plan in CSS pixels. The first chunk includes the
 * fixed header; later chunks crop it from the top so the header appears once.
 * The UI maps each source crop into capture.width/height after capture.
 */
export function createPageCapturePlan(rawMetrics, rawOptions = {}) {
  const metrics = capturePageMetrics(rawMetrics);
  const options = normalizePageCaptureOptions(rawOptions);
  const headerHeight = options.includeFixedHeader === false
    ? 0
    : Math.max(0, metrics.fixedHeaderHeight - metrics.contentTop);
  const step = Math.max(1, metrics.viewportHeight - headerHeight);
  const maxScrollY = Math.max(0, metrics.pageHeight - metrics.viewportHeight);
  const chunks = [];
  let covered = 0;
  let index = 0;
  let lastScrollY = -1;

  while (covered < metrics.pageHeight && chunks.length < options.maxChunks) {
    const requestedScrollY = index === 0 ? 0 : index * step;
    const scrollY = Math.min(maxScrollY, requestedScrollY);
    if (index > 0 && scrollY <= lastScrollY) break;
    const requestedSourceTop = index === 0
      ? metrics.contentTop
      : metrics.contentTop + headerHeight;
    const sourceTop = Math.max(requestedSourceTop, metrics.contentTop + covered - scrollY);
    const sourceBottom = Math.min(
      metrics.contentTop + metrics.viewportHeight,
      metrics.contentTop + metrics.pageHeight - scrollY,
    );
    if (sourceBottom <= sourceTop) break;

    const outputY = scrollY + sourceTop - metrics.contentTop;
    const height = sourceBottom - sourceTop;
    chunks.push({
      index,
      scrollY,
      sourceOffsetY: outputY,
      sourceCrop: {
        x: metrics.contentLeft,
        y: sourceTop,
        width: metrics.viewportWidth,
        height,
      },
      outputY,
      outputHeight: height,
    });
    covered = Math.max(covered, scrollY + sourceBottom - metrics.contentTop);
    lastScrollY = scrollY;
    index += 1;
  }

  const targetHeight = Math.max(1, covered);
  const targetWidth = metrics.viewportWidth;
  const scale = Math.min(
    1,
    options.maxWidth / targetWidth,
    options.maxHeight / targetHeight,
    Math.sqrt(options.maxPixels / (targetWidth * targetHeight)),
  );
  const width = Math.max(1, Math.round(targetWidth * scale));
  const height = Math.max(1, Math.round(targetHeight * scale));

  for (const chunk of chunks) {
    const outputY = Math.round(chunk.outputY * scale);
    const outputBottom = Math.round((chunk.outputY + chunk.outputHeight) * scale);
    chunk.outputY = outputY;
    chunk.outputHeight = Math.max(1, outputBottom - outputY);
    const sourceWidth = chunk.sourceCrop.width * scale;
    chunk.destination = {
      x: 0,
      y: chunk.outputY,
      width: Math.max(1, Math.round(sourceWidth)),
      height: chunk.outputHeight,
    };
  }

  return {
    metrics,
    options,
    viewport: {
      width: metrics.viewportWidth,
      height: metrics.viewportHeight,
    },
    captureViewport: {
      width: metrics.captureWidth,
      height: metrics.captureHeight,
    },
    page: {
      width: metrics.pageWidth,
      height: metrics.pageHeight,
      title: metrics.title,
      url: metrics.url,
    },
    width,
    height,
    scale,
    fixedHeaderHeight: options.includeFixedHeader === false ? 0 : metrics.fixedHeaderHeight,
    chunks,
    truncated: covered < metrics.pageHeight,
    capturedPageHeight: covered,
  };
}

/**
 * Normalize picker rectangles. The legacy picker supplies viewport-relative
 * coordinates plus scrollX/scrollY; page-relative regions are also supported.
 */
export function normalizePageRegion(region, rawMetrics, options = {}) {
  const metrics = capturePageMetrics(rawMetrics);
  if (!region || typeof region !== 'object') return null;
  const rectValue = region.rect && typeof region.rect === 'object' ? region.rect : region;
  const values = [rectValue.x, rectValue.y, rectValue.width, rectValue.height].map(Number);
  if (values.some((number) => !Number.isFinite(number))) return null;
  let [x, y, width, height] = values;
  if (width < 1 || height < 1) return null;

  const coordinateSpace = String(
    options.coordinateSpace || region.coordinateSpace || rectValue.coordinateSpace || 'viewport',
  ).toLowerCase();
  if (coordinateSpace !== 'page') {
    x += finiteNumber(region.scrollX ?? rectValue.scrollX, metrics.scrollX);
    y += finiteNumber(region.scrollY ?? rectValue.scrollY, metrics.scrollY);
  }

  const left = clamp(x, 0, metrics.pageWidth - 1);
  const top = clamp(y, 0, metrics.pageHeight - 1);
  const right = clamp(x + width, left + 1, metrics.pageWidth);
  const bottom = clamp(y + height, top + 1, metrics.pageHeight);
  return {
    pageRect: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
    coordinateSpace: 'page',
    clipped: left !== x || top !== y || right !== x + width || bottom !== y + height,
    viewport: {
      width: metrics.captureWidth,
      height: metrics.captureHeight,
    },
    page: {
      width: metrics.pageWidth,
      height: metrics.pageHeight,
    },
  };
}

export function calculateRegionScroll(normalizedRegion, rawMetrics, options = {}) {
  const metrics = capturePageMetrics(rawMetrics);
  if (!normalizedRegion?.pageRect) {
    return { scrollX: metrics.scrollX, scrollY: metrics.scrollY, needed: false };
  }
  const rect = normalizedRegion.pageRect;
  const header = options.ignoreFixedHeader ? 0 : metrics.fixedHeaderHeight;
  const contentHeight = Math.max(1, metrics.viewportHeight - header);
  const visibleTop = metrics.scrollY + metrics.contentTop + header;
  const visibleBottom = metrics.scrollY + metrics.contentTop + metrics.viewportHeight;
  const visibleLeft = metrics.scrollX;
  const visibleRight = metrics.scrollX + metrics.viewportWidth;
  const fullyVisible = rect.x >= visibleLeft
    && rect.x + rect.width <= visibleRight
    && rect.y >= visibleTop
    && rect.y + rect.height <= visibleBottom;
  if (fullyVisible) {
    return { scrollX: metrics.scrollX, scrollY: metrics.scrollY, needed: false };
  }

  const targetX = rect.x - Math.max(0, (metrics.viewportWidth - rect.width) / 2);
  const targetY = rect.height <= contentHeight
    ? rect.y - metrics.contentTop - header - Math.max(0, (contentHeight - rect.height) / 2)
    : rect.y - metrics.contentTop - header;
  return {
    scrollX: Math.round(clamp(targetX, 0, Math.max(0, metrics.pageWidth - metrics.viewportWidth))),
    scrollY: Math.round(clamp(targetY, 0, Math.max(0, metrics.pageHeight - metrics.viewportHeight))),
    needed: true,
  };
}

export function regionCaptureTail(plan, captures) {
  const chunks = Array.isArray(captures) ? captures : [];
  if (!chunks.length) {
    return { chunks: [], length: 0, offset: 0, blankHeight: 0 };
  }
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  const offset = Math.max(0, Math.round(Number(first?.offsetY) || 0));
  const end = Math.max(0, Math.round(Number(last?.offsetY) + Number(last?.height)));
  return {
    chunks,
    length: Math.max(0, end - offset),
    offset,
    blankHeight: Math.max(0, Math.round(Number(plan?.height) || 0) - end),
  };
}

/**
 * Plan a potentially off-screen region. Chunks overlap only when the fixed
 * header must be skipped, and all source crops are viewport-relative.
 */
export function createRegionCapturePlan(normalizedRegion, rawMetrics, rawOptions = {}) {
  const metrics = capturePageMetrics(rawMetrics);
  const options = normalizePageCaptureOptions(rawOptions);
  const rect = normalizedRegion?.pageRect;
  if (!rect) return null;
  const header = options.includeFixedHeader === false ? 0 : metrics.fixedHeaderHeight;
  const usableHeight = Math.max(1, metrics.viewportHeight - header);
  const maxChunks = options.maxChunks;
  const initialScroll = calculateRegionScroll(normalizedRegion, metrics, {
    ignoreFixedHeader: options.includeFixedHeader === false,
  });
  const maxScrollY = Math.max(0, metrics.pageHeight - metrics.viewportHeight);
  const chunks = [];
  let covered = 0;
  let index = 0;

  while (covered < rect.height && chunks.length < maxChunks) {
    const requestedScrollY = rect.y - metrics.contentTop - header + index * usableHeight;
    const scrollY = clamp(
      index === 0 ? initialScroll.scrollY : requestedScrollY,
      0,
      maxScrollY,
    );
    const targetTop = rect.y + covered;
    const contentTop = metrics.contentTop + header;
    const contentBottom = metrics.contentTop + metrics.viewportHeight;
    const sourceTop = clamp(targetTop - scrollY, contentTop, contentBottom - 1);
    const sourceBottom = Math.min(
      contentBottom,
      rect.y + rect.height - scrollY,
    );
    if (sourceBottom <= sourceTop) {
      if (scrollY >= maxScrollY) break;
      index += 1;
      continue;
    }
    const contentLeft = metrics.contentLeft;
    const contentRight = metrics.contentLeft + metrics.viewportWidth;
    const sourceLeft = clamp(rect.x - metrics.scrollX, contentLeft, contentRight - 1);
    const sourceRight = Math.min(
      contentRight,
      rect.x + rect.width - metrics.scrollX,
    );
    if (sourceRight <= sourceLeft) break;
    const outputHeight = Math.min(rect.height - covered, sourceBottom - sourceTop);
    chunks.push({
      index,
      scrollX: initialScroll.scrollX,
      scrollY,
      sourceOffsetY: covered,
      sourceCrop: {
        x: sourceLeft,
        y: sourceTop,
        width: sourceRight - sourceLeft,
        height: outputHeight,
      },
      outputY: covered,
      outputHeight,
    });
    covered += outputHeight;
    index += 1;
  }

  const outputWidth = Math.max(1, Math.min(
    rect.width,
    metrics.viewportWidth - Math.max(0, metrics.contentLeft - 0),
  ));
  const outputHeight = Math.max(1, covered);
  const scale = Math.min(
    1,
    options.maxWidth / outputWidth,
    options.maxHeight / outputHeight,
    Math.sqrt(options.maxPixels / (outputWidth * outputHeight)),
  );
  const width = Math.max(1, Math.round(outputWidth * scale));
  const height = Math.max(1, Math.round(outputHeight * scale));
  for (const chunk of chunks) {
    const outputY = Math.round(chunk.outputY * scale);
    const outputBottom = Math.round((chunk.outputY + chunk.outputHeight) * scale);
    chunk.destination = {
      x: 0,
      y: outputY,
      width: Math.max(1, Math.round(chunk.sourceCrop.width * scale)),
      height: Math.max(1, outputBottom - outputY),
    };
  }
  return {
    metrics,
    options,
    pageRect: { ...rect },
    viewport: {
      width: metrics.captureWidth,
      height: metrics.captureHeight,
    },
    width,
    height,
    scale,
    fixedHeaderHeight: header,
    chunks,
    truncated: covered < rect.height,
    capturedHeight: covered,
  };
}

export function computeRegionCrop(rect, rawMetrics) {
  const metrics = capturePageMetrics(rawMetrics);
  const values = [rect?.x, rect?.y, rect?.width, rect?.height].map(Number);
  if (values.some((number) => !Number.isFinite(number))) return null;
  const [x, y, width, height] = values;
  if (width < 1 || height < 1) return null;
  const contentTop = metrics.contentTop;
  const contentBottom = metrics.contentTop + metrics.viewportHeight;
  const contentLeft = metrics.contentLeft;
  const contentRight = metrics.contentLeft + metrics.viewportWidth;
  const header = contentTop + metrics.fixedHeaderHeight;
  const left = clamp(x, contentLeft, contentRight);
  const top = clamp(y, header, contentBottom);
  const right = clamp(x + width, left, contentRight);
  const bottom = clamp(y + height, top, contentBottom);
  if (right <= left || bottom <= top) return null;
  return {
    cropRect: {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(1, Math.round(right - left)),
      height: Math.max(1, Math.round(bottom - top)),
    },
    viewport: {
      width: metrics.captureWidth,
      height: metrics.captureHeight,
    },
    clipped: left !== x || top !== y || right !== x + width || bottom !== y + height,
  };
}

export function stitchPlanForCaptures(plan, captures) {
  if (!plan || !Array.isArray(plan.chunks)) return null;
  const available = new Set(
    (Array.isArray(captures) ? captures : []).map((capture) => Number(capture?.index)),
  );
  const chunks = plan.chunks.filter((chunk) => available.has(Number(chunk.index)));
  return {
    ...plan,
    chunks,
    height: capturedOutputHeight(plan, chunks),
    truncated: Boolean(plan.truncated)
      || chunks.length < Math.max(plan.chunks.length, Number(plan.planChunkCount) || 0),
  };
}

export function capturedOutputHeight(plan, captures) {
  const chunks = Array.isArray(captures) ? captures : [];
  if (!chunks.length) return 1;
  return Math.max(
    1,
    ...chunks.map((chunk) => {
      const destination = chunk?.destination;
      if (!destination) return 0;
      return Math.round(Number(destination.y) + Number(destination.height));
    }),
  );
}

export function captureResultForUi(result) {
  if (!result || typeof result !== 'object') return result;
  const plan = result.plan && typeof result.plan === 'object' ? result.plan : {};
  const captures = Array.isArray(result.chunks) ? result.chunks : [];
  const captureByIndex = new Map(captures.map((capture) => [Number(capture?.index), capture]));
  const declaredChunks = Array.isArray(plan.chunks) ? plan.chunks : [];
  const planChunks = declaredChunks
    .filter((chunk) => captureByIndex.has(Number(chunk?.index)))
    .map((chunk) => {
      const capture = captureByIndex.get(Number(chunk.index));
      return {
        ...chunk,
        sourceCrop: capture?.sourceCrop || chunk.sourceCrop,
        destination: capture?.destination || chunk.destination,
        scrollX: capture?.scrollX ?? chunk.scrollX,
        scrollY: capture?.scrollY ?? chunk.scrollY,
      };
    });
  const chunks = planChunks.length ? planChunks : captures.map((capture) => ({
    index: capture.index,
    scrollX: capture.scrollX,
    scrollY: capture.scrollY,
    sourceCrop: capture.sourceCrop,
    destination: capture.destination,
  }));
  const limited = limitCapturesByBytes(
    captures,
    result.maxBytes || PAGE_CAPTURE_DEFAULTS.maxBytes,
  );
  const shippedChunks = limited.overLimit
    ? chunks
    : chunks.slice(0, limited.captures.length);
  const output = {
    ...result,
    plan: {
      ...plan,
      ...stitchPlanForCaptures({
        ...plan,
        planChunkCount: declaredChunks.length,
        chunks: shippedChunks,
        truncated: Boolean(plan.truncated)
          || limited.overLimit
          || captures.length < declaredChunks.length,
      }, limited.captures),
      captureChunks: Array.isArray(plan.captureChunks) ? plan.captureChunks : undefined,
    },
    chunks: shippedChunks.map((chunk) => ({ ...chunk })),
    captureChunks: limited.captures.map((chunk) => ({
      index: chunk.index,
      scrollX: chunk.scrollX,
      scrollY: chunk.scrollY,
      sourceCrop: chunk.sourceCrop,
      destination: chunk.destination,
      dataUrl: chunk.dataUrl,
      bytes: chunk.bytes,
    })),
  };
  output.plan.metrics = undefined;
  return output;
}

export function jpegDataUrlBytes(value) {
  const dataUrl = String(value || '');
  if (!/^data:image\/jpe?g;base64,/i.test(dataUrl)) return 0;
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s+/g, '');
  if (!base64) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function limitCapturesByBytes(captures, maxBytes) {
  const limit = Math.max(1, Number(maxBytes) || 1);
  const accepted = [];
  let bytes = 0;
  for (const capture of Array.isArray(captures) ? captures : []) {
    const size = Math.max(0, Number(capture?.bytes) || jpegDataUrlBytes(capture?.dataUrl));
    if (accepted.length && bytes + size > limit) break;
    accepted.push(capture);
    bytes += size;
    if (bytes >= limit) break;
  }
  return {
    captures: accepted,
    bytes,
    truncated: accepted.length < (Array.isArray(captures) ? captures.length : 0),
    overLimit: bytes > limit,
  };
}

export function resizeStitchPlanForPixelLimit(plan, maxPixels = 24_000_000) {
  if (!plan || !Number.isFinite(Number(plan.width)) || !Number.isFinite(Number(plan.height))) {
    throw new Error('页面截图尺寸无效。');
  }
  const width = Math.max(1, Math.round(Number(plan.width)));
  const height = Math.max(1, Math.round(Number(plan.height)));
  const limit = Math.max(1, Number(maxPixels) || 24_000_000);
  const pixels = width * height;
  if (pixels <= limit) {
    const chunks = Array.isArray(plan.chunks) ? plan.chunks : [];
    return {
      ...plan,
      width,
      height,
      scale: Number(plan.scale) || 1,
      chunks,
      captureChunks: Array.isArray(plan.captureChunks) ? plan.captureChunks : undefined,
    };
  }
  const ratio = Math.sqrt(limit / pixels);
  const chunks = Array.isArray(plan.chunks) ? plan.chunks : [];
  return {
    ...plan,
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    scale: (Number(plan.scale) || 1) * ratio,
    chunks: chunks.map((chunk) => {
      const destination = chunk.destination || {};
      const y = Math.round(Number(destination.y) * ratio);
      const bottom = Math.round((Number(destination.y) + Number(destination.height)) * ratio);
      return {
        ...chunk,
        destination: {
          x: 0,
          y,
          width: Math.max(1, Math.round(Number(destination.width) * ratio)),
          height: Math.max(1, bottom - y),
        },
      };
    }),
    captureChunks: Array.isArray(plan.captureChunks)
      ? plan.captureChunks.map((chunk) => {
        const destination = chunk.destination || {};
        const y = Math.round(Number(destination.y) * ratio);
        const bottom = Math.round((Number(destination.y) + Number(destination.height)) * ratio);
        return {
          ...chunk,
          destination: {
            x: 0,
            y,
            width: Math.max(1, Math.round(Number(destination.width) * ratio)),
            height: Math.max(1, bottom - y),
          },
        };
      })
      : undefined,
  };
}

export function captureFailure(code, message) {
  return {
    error: String(message || '页面截图失败。'),
    code: String(code || 'CAPTURE_FAILED'),
  };
}

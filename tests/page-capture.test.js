import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateRegionScroll,
  captureResultForUi,
  computeRegionCrop,
  createPageCapturePlan,
  createRegionCapturePlan,
  jpegDataUrlBytes,
  limitCapturesByBytes,
  normalizePageCaptureOptions,
  normalizePageRegion,
  resizeStitchPlanForPixelLimit,
} from "../src/utils/page-capture.js";
import { stitchCapturedPage } from "../src/utils/image-crop.js";

const metrics = {
  viewportWidth: 1000,
  viewportHeight: 800,
  pageWidth: 1000,
  pageHeight: 2200,
  scrollX: 0,
  scrollY: 120,
  fixedHeaderHeight: 60,
  title: "Long page",
  url: "https://example.test/long",
};

test("full-page planning omits the fixed header after the first screen", () => {
  const plan = createPageCapturePlan(metrics, { maxChunks: 8 });
  assert.equal(plan.chunks[0].sourceCrop.y, 0);
  assert.equal(plan.chunks[1].sourceCrop.y, 60);
  assert.equal(plan.chunks[1].scrollY, 740);
  assert.equal(plan.chunks[0].outputY, 0);
  assert.equal(plan.chunks[1].outputY, 800);
  assert.deepEqual(plan.viewport, { width: 1000, height: 800 });
  assert.equal(plan.truncated, false);
});

test("full-page planning truncates instead of looping forever at Chrome's scroll limit", () => {
  const plan = createPageCapturePlan({
    ...metrics,
    pageHeight: 100000,
  }, { maxChunks: 4 });
  assert.equal(plan.chunks.length, 4);
  assert.equal(plan.truncated, true);
  assert.ok(plan.chunks.every((chunk, index, list) => index === 0 || chunk.scrollY > list[index - 1].scrollY));
});

test("capture options and JPEG sizes are bounded", () => {
  const options = normalizePageCaptureOptions({
    quality: 500,
    captureQuality: 12,
    maxChunks: 500,
    timeoutMs: 1,
    includeFixedHeader: false,
  });
  assert.equal(options.quality, 95);
  assert.equal(options.captureQuality, 30);
  assert.equal(options.maxChunks, 30);
  assert.equal(options.timeoutMs, 2000);
  assert.equal(options.includeFixedHeader, false);
  assert.equal(jpegDataUrlBytes("data:image/jpeg;base64,AAAA"), 3);
  assert.equal(jpegDataUrlBytes("data:image/png;base64,AAAA"), 0);
});

test("a single oversized first chunk is retained but marked over the byte cap", () => {
  const limited = limitCapturesByBytes([
    { index: 0, bytes: 900 },
    { index: 1, bytes: 400 },
  ], 1000);
  assert.deepEqual(limited.captures.map((chunk) => chunk.index), [0]);
  assert.equal(limited.bytes, 900);
  assert.equal(limited.truncated, true);
  assert.equal(limited.overLimit, false);
  const single = limitCapturesByBytes([{ index: 0, bytes: 1200 }], 1000);
  assert.equal(single.captures.length, 1);
  assert.equal(single.overLimit, true);
});

test("viewport rectangles from the figure picker are converted to page coordinates", () => {
  const region = normalizePageRegion({
    rect: { x: 20, y: 100, width: 400, height: 300 },
    scrollY: 120,
  }, metrics);
  assert.deepEqual(region.pageRect, { x: 20, y: 220, width: 400, height: 300 });
  assert.equal(region.coordinateSpace, "page");
});

test("off-screen figures get a safe scroll target and a viewport crop", () => {
  const region = normalizePageRegion({
    rect: { x: 100, y: 600, width: 500, height: 300 },
    scrollY: 0,
  }, { ...metrics, scrollY: 0 });
  const scroll = calculateRegionScroll(region, { ...metrics, scrollY: 0 });
  assert.equal(scroll.needed, true);
  assert.ok(scroll.scrollY > 0);
  const crop = computeRegionCrop({
    x: 100,
    y: 220,
    width: 500,
    height: 300,
  }, { ...metrics, scrollY: 220 });
  assert.deepEqual(crop.cropRect, { x: 100, y: 220, width: 500, height: 300 });
});

test("positive page rects produce a region plan with a fixed-header-safe first crop", () => {
  const region = normalizePageRegion({
    x: 100,
    y: 400,
    width: 600,
    height: 900,
    coordinateSpace: "page",
  }, { ...metrics, pageHeight: 2000 });
  const plan = createRegionCapturePlan(region, { ...metrics, pageHeight: 2000 });
  assert.ok(plan.chunks.length >= 2);
  assert.equal(plan.chunks[0].sourceCrop.x, 100);
  assert.ok(plan.chunks[0].sourceCrop.y >= 60);
  assert.equal(plan.chunks[0].destination.y, 0);
});

test("the UI stitcher uses plan source crops and injectable canvas primitives", async () => {
  const plan = createPageCapturePlan(metrics, { maxChunks: 2, maxWidth: 1000, maxHeight: 8000 });
  const calls = [];
  const context = {
    drawImage(...args) {
      calls.push(args.slice(1));
    },
  };
  const canvas = {
    getContext: () => context,
    toDataURL: () => "data:image/jpeg;base64,AAAA",
  };
  const image = { naturalWidth: 1000, naturalHeight: 800 };
  const result = await stitchCapturedPage(plan, [
    "data:image/jpeg;base64,AAAA",
    "data:image/jpeg;base64,BBBB",
  ], {
    createCanvas: () => canvas,
    loadImage: async () => image,
    encodeCanvas: async () => "data:image/jpeg;base64,AAAA",
  });
  assert.equal(result, "data:image/jpeg;base64,AAAA");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 0);
  assert.equal(calls[0][1], 0);
  assert.equal(calls[1][1], 60);
});

test("UI results retain only the chunks that fit under the byte cap", () => {
  const plan = createPageCapturePlan(metrics, { maxChunks: 3 });
  const ui = captureResultForUi({
    plan: {
      ...plan,
      chunks: plan.chunks,
      truncated: false,
    },
    chunks: [{
      index: 0,
      sourceCrop: plan.chunks[0].sourceCrop,
      destination: plan.chunks[0].destination,
      dataUrl: "data:image/jpeg;base64,AAAA",
      bytes: 3,
    }],
  });
  assert.equal(ui.plan.chunks.length, 1);
  assert.equal(ui.plan.height, ui.plan.chunks[0].destination.height);
  assert.equal(ui.plan.truncated, true);
});

test("stitch plans are downscaled before allocating an oversized canvas", () => {
  const plan = createPageCapturePlan({
    ...metrics,
    pageHeight: 100000,
  }, { maxChunks: 18, maxHeight: 100000, maxPixels: 64_000_000 });
  const resized = resizeStitchPlanForPixelLimit(plan, 24_000_000);
  assert.ok(resized.width * resized.height <= 24_000_000);
  assert.equal(resized.chunks[0].destination.y, 0);
  assert.ok(resized.chunks[1].destination.y > 0);
});

test("UI results enforce the byte cap using dataUrl sizes", () => {
  const plan = createPageCapturePlan(metrics, { maxChunks: 2 });
  const chunk = (dataUrl) => ({
    dataUrl,
    sourceCrop: plan.chunks[0].sourceCrop,
    destination: plan.chunks[0].destination,
  });
  const ui = captureResultForUi({
    maxBytes: 3,
    plan: { ...plan, chunks: plan.chunks.slice(0, 2) },
    chunks: [
      { index: 0, ...chunk("data:image/jpeg;base64,AAAA") },
      { index: 1, ...chunk("data:image/jpeg;base64,BBBB") },
    ],
  });
  assert.equal(ui.captureChunks.length, 1);
  assert.equal(ui.plan.truncated, true);
});

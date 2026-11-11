import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import "../src/content/extractor.js";

const { materializeLazyContent } = globalThis.__unkAiExtractor;

function createView(options = {}) {
  const calls = [];
  let y = options.initialY || 240;
  let x = options.initialX || 12;
  const documentElement = {
    scrollTop: options.initialY || 240,
    scrollLeft: options.initialX || 12,
    scrollHeight: options.scrollHeight || 3000,
  };
  const body = {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: options.scrollHeight || 3000,
  };
  const document = {
    documentElement,
    body,
    scrollingElement: documentElement,
    defaultView: null,
    addEventListener() {},
    removeEventListener() {},
  };
  const view = {
    document,
    innerHeight: 800,
    get scrollY() { return y; },
    get scrollX() { return x; },
    scrollTo(value) {
      y = value.top;
      x = value.left;
      calls.push({ top: value.top, left: value.left });
    },
  };
  document.defaultView = view;
  return { view, calls, get position() { return { x, y }; } };
}

test("lazy materialization scrolls through content and restores the original position", async () => {
  const fixture = createView();
  const result = await materializeLazyContent({
    window: fixture.view,
    document: fixture.view.document,
    timeoutMs: 1000,
    stepDelayMs: 0,
    maxSteps: 3,
  });
  assert.ok(result.steps >= 2);
  assert.equal(result.restored, true);
  assert.deepEqual(fixture.position, { x: 12, y: 240 });
  assert.ok(fixture.calls.some((call) => call.top > 240));
  assert.equal(fixture.calls.at(-1).top, 240);
});

test("lazy materialization restores scroll after cancellation", async () => {
  const fixture = createView({ initialY: 480 });
  const controller = new AbortController();
  Promise.resolve().then(() => controller.abort());
  await assert.rejects(
    materializeLazyContent({
      window: fixture.view,
      document: fixture.view.document,
      signal: controller.signal,
      timeoutMs: 1000,
      stepDelayMs: 20,
    }),
    /取消/,
  );
  assert.deepEqual(fixture.position, { x: 12, y: 480 });
});

test("lazy materialization times out rather than hanging", async () => {
  const fixture = createView();
  await assert.rejects(
    materializeLazyContent({
      window: fixture.view,
      document: fixture.view.document,
      timeoutMs: 3,
      stepDelayMs: 100,
    }),
    /超时/,
  );
  assert.deepEqual(fixture.position, { x: 12, y: 240 });
});

test("content bridge supports async lazy extraction and keeps synchronous legacy messages", async () => {
  const fixture = createView({ initialY: 100, scrollHeight: 2400 });
  fixture.view.__unkAiExtractor = {
    extractPageContent(options) {
      return {
        text: "Lazy body",
        truncated: false,
        sections: [],
        figures: [],
        structure: options.includeStructure ? { landmarks: [] } : undefined,
      };
    },
  };
  fixture.view.__unkAiExtractor.materializeLazyContent = materializeLazyContent;
  const listeners = [];
  fixture.view.chrome = {
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } },
  };
  const context = vm.createContext(fixture.view);
  context.globalThis = context;
  vm.runInContext(readFileSync(new URL("../src/content/content.js", import.meta.url), "utf8"), context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  let syncResponse;
  assert.equal(listeners[0]({ type: "EXTRACT_PAGE", maxBudget: 500 }, {}, (value) => {
    syncResponse = value;
  }), false);
  assert.equal(syncResponse.text, "Lazy body");
  assert.equal(syncResponse.structure, undefined);

  const asyncResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0]({
      type: "EXTRACT_PAGE",
      lazyLoad: { timeoutMs: 1000, stepDelayMs: 0, maxSteps: 2 },
      includeStructure: true,
    }, {}, resolve);
    assert.equal(keepAlive, true);
  });
  assert.equal(asyncResponse.text, "Lazy body");
  assert.equal(asyncResponse.lazyMaterialization.available, true);
  assert.equal(asyncResponse.lazyMaterialization.restored, true);
  assert.ok(asyncResponse.structure);
  assert.deepEqual(fixture.position, { x: 12, y: 100 });
});


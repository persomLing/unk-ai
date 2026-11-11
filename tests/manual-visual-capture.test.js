import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualPreparation, captureManualVisual, cropManualVisual, attachmentInputError, selectionToImageRect } from '../src/sidepanel/features/visual-context/manual-visual-capture.js';

const shot = 'data:image/jpeg;base64,AAAA';
const target = { id: 4, url: 'https://example.test/list?page=2#cards', title: 'Cards', documentId: 'doc-a' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fixture = (overrides = {}) => ({
  queryActiveTab: async () => target,
  sendMessage: async message => message.type === 'CAPTURE_PAGE_TARGET'
    ? { tabId: target.id, url: target.url, documentId: target.documentId }
    : { tabId: target.id, url: target.url, documentId: target.documentId, dataUrl: shot },
  readMetrics: async () => ({ viewport: { width: 1000, height: 600 }, scroll: { x: 0, y: 320 } }),
  decodeImage: async () => ({ width: 2000, height: 1200 }),
  now: () => '2026-11-02T09:00:00.000Z',
  ...overrides,
});

test('operation mode accepts image input while documents and nonvisual models are rejected', () => {
  assert.equal(attachmentInputError('image', { agentMode: true, supportsVision: true }), '');
  assert.match(attachmentInputError('document', { agentMode: true, supportsVision: true }), /文档/);
  assert.match(attachmentInputError('image', { supportsVision: false }), /视觉/);
});

test('manual capture binds the original document and retains real image and viewport geometry', async () => {
  const calls = [];
  const defaults = fixture();
  const value = await captureManualVisual(fixture({ sendMessage: async message => { calls.push(message); return defaults.sendMessage(message); } }));
  assert.equal(value.type, 'image');
  assert.equal(value.dataUrl, shot);
  assert.deepEqual(value.capture, { version: 1, tabId: 4, url: target.url, documentId: 'doc-a', capturedAt: '2026-11-02T09:00:00.000Z', viewport: { width: 1000, height: 600 }, scroll: { x: 0, y: 320 }, image: { width: 2000, height: 1200 } });
  const request = calls.find(message => message.type === 'CAPTURE_ACTIVE_TAB');
  assert.equal(request.tabId, 4);
  assert.equal(request.expectedUrl, target.url);
  assert.equal(request.documentId, 'doc-a');
});

test('a changed page or document cannot become a screenshot attachment', async () => {
  const defaults = fixture();
  await assert.rejects(captureManualVisual(fixture({ sendMessage: async message => message.type === 'CAPTURE_ACTIVE_TAB'
    ? { tabId: 5, url: target.url, documentId: 'doc-a', dataUrl: shot } : defaults.sendMessage(message) })), { code: 'PAGE_CHANGED' });
  let queries = 0;
  await assert.rejects(captureManualVisual(fixture({ queryActiveTab: async () => ++queries === 1 ? target : { ...target, url: 'https://example.test/other' } })), { code: 'PAGE_CHANGED' });
});

test('cancel during a stalled capture settles promptly and discards its late image', async () => {
  const late = deferred(), entered = deferred(), controller = new AbortController();
  const defaults = fixture();
  const pending = captureManualVisual(fixture({ signal: controller.signal, sendMessage: message => {
    if (message.type !== 'CAPTURE_ACTIVE_TAB') return defaults.sendMessage(message);
    entered.resolve(); return late.promise;
  } }));
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  late.resolve({ tabId: 4, url: target.url, documentId: 'doc-a', dataUrl: shot });
});

test('selection coordinates follow displayed image scale, reverse drag and clipping', () => {
  assert.deepEqual(selectionToImageRect({ x: 240, y: 140 }, { x: 40, y: 20 }, { width: 400, height: 240 }, { width: 2000, height: 1200 }), { x: 200, y: 100, width: 1000, height: 600, coordinateSpace: 'image' });
  assert.deepEqual(selectionToImageRect({ x: -20, y: -10 }, { x: 500, y: 300 }, { width: 400, height: 240 }, { width: 2000, height: 1200 }), { x: 0, y: 0, width: 2000, height: 1200, coordinateSpace: 'image' });
  assert.equal(selectionToImageRect({ x: 2, y: 2 }, { x: 3, y: 3 }, { width: 400, height: 240 }, { width: 2000, height: 1200 }), null);
});

test('preparation ownership rejects a late attachment after conversation or execution changes', async () => {
  let owner = ['conversation-a', null];
  const manager = createVisualPreparation({ getOwner: () => owner, onBusy: () => {} });
  for (const changed of [['conversation-b', null], ['conversation-b', 'new-run']]) {
    const operation = manager.start();
    const late = deferred();
    const pending = operation.wait(late.promise);
    owner = changed;
    late.resolve('old image');
    await assert.rejects(pending, { name: 'AbortError' });
    operation.finish();
  }
});

test('an old preparation finally cannot release a newer operation', async () => {
  const busy = [];
  const manager = createVisualPreparation({ getOwner: () => ['a'], onBusy: value => busy.push(value) });
  const first = manager.start();
  const second = manager.start();
  first.finish();
  assert.equal(busy.at(-1), true);
  assert.equal(first.signal.aborted, true);
  second.finish();
  assert.equal(busy.at(-1), false);
});

test('capture does not invent missing viewport fields and rejects a changed document after decoding', async () => {
  const value = await captureManualVisual(fixture({ readMetrics: undefined }));
  assert.equal('viewport' in value.capture, false);
  assert.equal('scroll' in value.capture, false);
  let decoded = false;
  const defaults = fixture();
  await assert.rejects(captureManualVisual(fixture({
    decodeImage: async () => { decoded = true; return { width: 100, height: 80 }; },
    sendMessage: async message => {
      const value = await defaults.sendMessage(message);
      return decoded && message.type === 'CAPTURE_PAGE_TARGET' ? { ...value, documentId: 'new-doc' } : value;
    },
  })), { code: 'PAGE_CHANGED' });
});

test('cropping preserves the original screenshot space while recording actual output dimensions', async () => {
  const original = await captureManualVisual(fixture());
  const crop = { x: 200, y: 100, width: 1000, height: 600, coordinateSpace: 'image' };
  const result = await cropManualVisual(original, crop, {
    cropImage: async (_data, rect, options) => { assert.deepEqual(rect, crop); assert.deepEqual(options.viewport, { width: 2000, height: 1200 }); return shot; },
    decodeImage: async () => ({ width: 1000, height: 600 }),
  });
  assert.equal(result.width, 1000);
  assert.equal(result.height, 600);
  assert.deepEqual(result.capture, { ...original.capture, crop });
  assert.equal(original.capture.crop, undefined);
});

test('cancelled cropping cannot start image decoding after a late canvas result', async () => {
  const original = await captureManualVisual(fixture());
  const late = deferred();
  const controller = new AbortController();
  let decodes = 0;
  const pending = cropManualVisual(original, { x: 0, y: 0, width: 100, height: 100 }, {
    signal: controller.signal, cropImage: () => late.promise, decodeImage: () => { decodes++; return { width: 100, height: 100 }; },
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  late.resolve(shot);
  await Promise.resolve();
  assert.equal(decodes, 0);
});

test('capture and preparation have bounded waits; finishing also closes pending selectors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = captureManualVisual(fixture({ queryActiveTab: () => new Promise(() => {}), timeoutMs: 20 }));
  const failed = assert.rejects(pending, { name: 'TimeoutError' });
  t.mock.timers.tick(20);
  await failed;
  const manager = createVisualPreparation({ getOwner: () => ['a'], onBusy: () => {} });
  const operation = manager.start();
  operation.finish();
  assert.equal(operation.signal.aborted, true);
});

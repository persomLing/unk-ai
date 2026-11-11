import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createAutoVisualSlot } from '../src/sidepanel/features/visual-context/auto-visual-slot.js';
import { awaitWithAbort } from '../src/utils/abortable.js';
import { createModelGateway } from '../src/app/model-gateway.js';

const page = { tabId: 4, documentId: 'document-a', url: 'https://example.test/a', title: 'Page A', text: 'Public chart description' };
const getProfile = () => ({ endpointUrl: 'https://model.test/v1', model: 'vision', supportsVision: true });
const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"screenshot":true,"scope":"viewport"}' } }] }) });

test('visual preflight preserves the source identity across its asynchronous model decision', async () => {
  let request;
  const slot = createAutoVisualSlot({ getProfile, fetchImpl, sendMessage: async (value) => {
    request = value;
    return { ...page, images: [{ dataUrl: 'data:image/jpeg;base64,AAAA', pageUrl: page.url, scope: 'viewport', fullPage: false }] };
  } });
  const result = await slot.resolve('解释这张图表', page);
  assert.equal(request.tabId, 4);
  assert.equal(request.documentId, 'document-a');
  assert.equal(request.expectedUrl, page.url);
  assert.equal(result[0].pageUrl, page.url);
});

test('an unexpected screenshot source is discarded instead of being mislabeled', async () => {
  const slot = createAutoVisualSlot({ getProfile, fetchImpl, sendMessage: async () => ({
    tabId: 5, documentId: 'document-b', url: 'https://example.test/b',
    images: [{ dataUrl: 'data:image/jpeg;base64,AAAA' }],
  }) });
  assert.deepEqual(await slot.resolve('解释这张图表', page), []);
});

test('historical pages with no live tab identity do not trigger an active-tab screenshot', async () => {
  let called = false;
  const slot = createAutoVisualSlot({ getProfile, fetchImpl, sendMessage: async () => { called = true; } });
  assert.deepEqual(await slot.resolve('解释这张图表', { ...page, tabId: undefined }), []);
  assert.equal(called, false);
});

test('an already cancelled visual request never starts preflight or capture', async () => {
  const controller = new AbortController();
  controller.abort();
  const slot = createAutoVisualSlot({
    getProfile,
    fetchImpl: () => { throw new Error('must not fetch'); },
    sendMessage: () => { throw new Error('must not capture'); },
  });
  await assert.rejects(slot.resolve('解释这张图表', page, { signal: controller.signal }), { name: 'AbortError' });
});

test('cancelling a stalled preflight settles promptly and its late response cannot capture', async () => {
  const controller = new AbortController();
  let finishFetch;
  let fetchSignal;
  let fetchStarted;
  const started = new Promise(resolve => { fetchStarted = resolve; });
  let captures = 0;
  const slot = createAutoVisualSlot({
    getProfile,
    fetchImpl: (_url, options) => {
      fetchSignal = options.signal;
      fetchStarted();
      return new Promise(resolve => { finishFetch = resolve; });
    },
    sendMessage: async () => { captures += 1; },
  });
  const pending = slot.resolve('解释这张图表', page, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetchSignal.aborted, true);
  finishFetch(await fetchImpl());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(captures, 0);
});

test('cancelling while parsing a preflight response prevents a late screenshot decision', async () => {
  const controller = new AbortController();
  let finishJson;
  let jsonStarted;
  const started = new Promise(resolve => { jsonStarted = resolve; });
  let captures = 0;
  const slot = createAutoVisualSlot({
    getProfile,
    fetchImpl: async () => ({ ok: true, json: () => {
      jsonStarted();
      return new Promise(resolve => { finishJson = resolve; });
    } }),
    sendMessage: async () => { captures += 1; },
  });
  const pending = slot.resolve('解释这张图表', page, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finishJson({ choices: [{ message: { content: '{"screenshot":true,"scope":"viewport"}' } }] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(captures, 0);
});

test('cancelling a pending screenshot discards a late successful result', async () => {
  const controller = new AbortController();
  let finishCapture;
  let captureStarted;
  const started = new Promise(resolve => { captureStarted = resolve; });
  const slot = createAutoVisualSlot({ getProfile, fetchImpl, sendMessage: () => {
    captureStarted();
    return new Promise(resolve => { finishCapture = resolve; });
  } });
  const pending = slot.resolve('解释这张图表', page, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finishCapture({ ...page, images: [{ dataUrl: 'data:image/jpeg;base64,AAAA', pageUrl: page.url, scope: 'viewport' }] });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('the sidepanel visual wrapper releases its running flag without waiting for a stalled capture', async () => {
  const source = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function autoVisualAttachments(');
  const end = source.indexOf('async function captureSelectedFigure(', start);
  const controller = new AbortController();
  let receivedSignal;
  const context = vm.createContext({
    state: { autoVisualRunning: false }, awaitWithAbort,
    autoVisualSlot: { resolve: (_question, _page, options) => {
      receivedSignal = options.signal;
      return new Promise(() => {});
    } },
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.resolveVisual = autoVisualAttachments;', context);
  const pending = context.resolveVisual('解释这张图表', page, controller.signal);
  assert.equal(context.state.autoVisualRunning, true);
  assert.equal(receivedSignal, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(context.state.autoVisualRunning, false);
});

test('visual resolution reuses the submitting run and never reads a changed model selection', async () => {
  const requested = [];
  const run = createModelGateway({ transport: input => {
    requested.push(input);
    return input.purpose === 'visual-decision' ? '{"screenshot":true,"scope":"viewport"}' : 'Later answer';
  } }).createRun({ runId: 'submission', profile: { model: 'original', supportsVision: true } });
  const slot = createAutoVisualSlot({
    getProfile: () => { throw new Error('must use submitted run'); },
    modelGateway: { createRun: () => { throw new Error('must not create a second run'); } },
    sendMessage: async () => ({ ...page, images: [{ dataUrl: 'data:image/jpeg;base64,AAAA', pageUrl: page.url, scope: 'viewport' }] }),
  });
  const result = await slot.resolve('解释这张图表', page, { modelRun: run });
  assert.equal(result.length, 1);
  assert.equal(requested[0].profile.model, 'original');
  assert.equal(requested[0].purpose, 'visual-decision');
  assert.equal(run.signal.aborted, false);
  assert.equal(await run.request({ requestId: 'answer', purpose: 'answer', messages: [{ role: 'user', content: 'Explain' }] }), 'Later answer');
  slot.dispose(); run.dispose();
});

test('releasing the visual slot cancels its pending capture without disposing a shared model run', async () => {
  const run = createModelGateway({ transport: () => '{"screenshot":true,"scope":"viewport"}' })
    .createRun({ runId: 'submission', profile: { model: 'vision', supportsVision: true } });
  const cleanups = [];
  let finishCapture;
  let captureStarted;
  const started = new Promise(resolve => { captureStarted = resolve; });
  const slot = createAutoVisualSlot({
    onCleanup: callback => cleanups.push(callback),
    sendMessage: () => { captureStarted(); return new Promise(resolve => { finishCapture = resolve; }); },
  });
  const pending = slot.resolve('解释这张图表', page, { modelRun: run });
  await started;
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  cleanups[0]();
  await cancelled;
  finishCapture({ ...page, images: [{ dataUrl: 'data:image/jpeg;base64,AAAA' }] });
  assert.equal(run.signal.aborted, false);
  await assert.rejects(slot.decide('解释图表', page, { modelRun: run }), { name: 'AbortError' });
  slot.dispose(); run.dispose();
});

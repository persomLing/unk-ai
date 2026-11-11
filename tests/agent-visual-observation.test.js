import test from 'node:test';
import assert from 'node:assert/strict';
import * as visualObservation from '../src/sidepanel/features/agent/visual-observation.js';
const { createAgentVisualObservation, cropAgentVisualImage, planAgentVisualRegion, chooseAgentVisualTarget, selectAgentVisualTarget } = visualObservation;

const dataUrl = 'data:image/jpeg;base64,aGVsbG8=';
const task = () => ({ id: 'task-1', tabId: 7, status: 'running' });
const observation = () => ({ tabId: 7, url: 'https://example.test/tool?version=2#settings', documentId: 'document-1', snapshotId: 'snapshot-1',
  viewport: { width: 1000, height: 700 }, scrollY: 0, elements: [
    { id: 'e1', stableKey: 'animate', mainFrame: true, frameId: 0, tag: 'button', name: '动态', rect: { x: 390, y: 280, width: 28, height: 24 } },
    { id: 'e2', mainFrame: true, frameId: 0, rect: { x: 360, y: 245, width: 100, height: 20 } },
    { id: 'e3', mainFrame: false, frameId: 2, rect: { x: 390, y: 280, width: 28, height: 24 } },
    { id: 'e4', mainFrame: true, frameId: 0, rect: { x: 900, y: 600, width: 28, height: 24 } },
  ] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const captured = fields => ({ ok: true, dataUrl, url: 'https://example.test/tool?version=2#settings', documentId: 'document-1', snapshotId: 'snapshot-1', ...fields });
const cropped = () => ({ dataUrl, image: { width: 640, height: 400 }, sourceImage: { width: 2000, height: 1400 } });

test('a small control receives local label context with only intersecting main-page candidate IDs', () => {
  const original = observation();
  const copy = structuredClone(original);
  const result = planAgentVisualRegion(original, 'e1');
  assert.deepEqual(result.crop, { x: 244, y: 192, width: 320, height: 200 });
  assert.deepEqual(result.candidateElementIds, ['e1', 'e2']);
  assert.deepEqual(original, copy);
  assert.equal(planAgentVisualRegion(original, 'e3').error, 'ERR_VISUAL_FRAME_UNSUPPORTED');
  assert.equal(planAgentVisualRegion(original, 'e9').error, 'ERR_ELEMENT_NOT_FOUND');
  original.elements[0].rect.x = 1010;
  assert.equal(planAgentVisualRegion(original, 'e1').error, 'ERR_VISUAL_TARGET_NOT_VISIBLE');
});

test('context windows clamp at viewport borders and stay bounded for large containers', () => {
  const page = observation();
  page.elements[0].rect = { x: -8, y: -4, width: 28, height: 24 };
  assert.deepEqual(planAgentVisualRegion(page, 'e1').crop, { x: 0, y: 0, width: 320, height: 200 });
  page.elements[0].rect = { x: 0, y: 0, width: 1000, height: 700 };
  const result = planAgentVisualRegion(page, 'e1');
  assert.equal(result.crop.width, 640);
  assert.equal(result.crop.height, 480);
  page.viewport = { width: 200, height: 120 };
  page.elements[0].rect = { x: 190, y: 110, width: 28, height: 24 };
  assert.deepEqual(planAgentVisualRegion(page, 'e1').crop, { x: 0, y: 0, width: 200, height: 120 });
});

test('automatic crops follow the active writing subgoal and avoid ambiguous or generic containers', () => {
  const page = observation();
  page.elements.push({ id: 'e5', mainFrame: true, frameId: 0, tag: 'select', name: 'Model', rect: { x: 100, y: 100, width: 150, height: 32 } },
    { id: 'e6', mainFrame: true, frameId: 0, tag: 'input', type: 'file', name: 'Upload image', fileInput: {}, rect: { x: 100, y: 150, width: 150, height: 32 } },
    { id: 'e7', mainFrame: true, frameId: 0, tag: 'input', type: 'checkbox', name: 'Animate', rect: { x: 100, y: 200, width: 24, height: 24 } });
  const goal = '选择模型，上传图片，勾选动态';
  assert.equal(chooseAgentVisualTarget(page, { goal, plan: [{ title: '选择模型', status: 'in_progress' }] })?.id, 'e5');
  assert.equal(chooseAgentVisualTarget(page, { goal, plan: [{ title: '上传参考图', status: 'in_progress' }] })?.id, 'e6');
  assert.equal(chooseAgentVisualTarget(page, { goal, plan: [{ title: '勾选动态', status: 'in_progress' }] })?.id, 'e7');
  page.elements.push({ ...page.elements.find(element => element.id === 'e5'), id: 'e8' });
  assert.equal(chooseAgentVisualTarget(page, { goal: '选择模型' }), null);
  assert.equal(chooseAgentVisualTarget(page, { goal: '查看页面有什么内容' }), null);
  for (const id of ['e5', 'e8']) page.elements.find(element => element.id === id).readOnly = true;
  assert.equal(chooseAgentVisualTarget(page, { goal: '选择模型' }), null);
  page.elements.find(element => element.id === 'e6').mainFrame = false;
  assert.equal(chooseAgentVisualTarget(page, { goal: '上传图片' }), null);
});

test('generic observation plans fall back to the user goal and expose the selected intent', () => {
  const page = observation();
  page.elements.push({ id: 'e5', mainFrame: true, frameId: 0, tag: 'select', name: 'Model', rect: { x: 100, y: 100, width: 150, height: 32 } });
  for (const title of ['了解页面', '定位并检查图像生成表单']) {
    assert.equal(chooseAgentVisualTarget(page, { goal: '选择模型2.6', plan: [{ title, status: 'in_progress' }] })?.id, 'e5');
    const result = selectAgentVisualTarget(page, { goal: '选择模型2.6', plan: [{ title, status: 'in_progress' }] });
    assert.equal(result.ok, true);
    assert.equal(result.target.id, 'e5');
    assert.equal(result.intentSource, 'goal');
    assert.equal(result.reason, 'unique-control');
  }
  assert.equal(selectAgentVisualTarget(page, { goal: '选择模型2.6', plan: [{ title: '选择模型', status: 'in_progress' }] }).intentSource, 'plan');
});

test('prompt fields and Chinese GIF requests identify current editable or animation controls', () => {
  for (const field of [{ tag: 'textarea', name: '' }, { tag: 'div', role: 'textbox', name: 'Prompt' }]) {
    const page = observation();
    page.elements = [{ id: 'e5', mainFrame: true, frameId: 0, rect: { x: 100, y: 100, width: 240, height: 100 }, ...field }];
    const result = selectAgentVisualTarget(page, { goal: '填写提示词' });
    assert.equal(result.ok, true);
    assert.equal(result.target.id, 'e5');
    page.elements[0].readOnly = true;
    assert.equal(selectAgentVisualTarget(page, { goal: '填写提示词' }).error, 'ERR_VISUAL_TARGET_NOT_FOUND');
  }
  for (const title of ['勾选动图', '开启GIF', '开启 gif 动画']) {
    const page = observation();
    page.elements = [{ id: 'e5', mainFrame: true, frameId: 0, tag: 'input', type: 'checkbox', name: 'GIF', rect: { x: 100, y: 100, width: 24, height: 24 } }];
    assert.equal(selectAgentVisualTarget(page, { goal: title }).target.id, 'e5');
  }
});

test('native control semantics outrank incidental image words in a complete image task', () => {
  const page = observation();
  page.elements = [
    { id: 'e5', mainFrame: true, frameId: 0, tag: 'select', name: 'gpt-image-2.6', rect: { x: 100, y: 100, width: 200, height: 32 } },
    { id: 'e6', mainFrame: true, frameId: 0, tag: 'input', type: 'file', name: '', fileInput: {}, rect: { x: 100, y: 155, width: 200, height: 32 } },
  ];
  const result = selectAgentVisualTarget(page, { goal: '选择模型2.6并上传图片' });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'compact-control-group');
  assert.deepEqual(result.candidateElementIds, ['e5', 'e6']);
});

test('a complete goal receives a compact form crop without requiring one relevant control', () => {
  const page = observation();
  page.elements = [
    { id: 'e5', mainFrame: true, frameId: 0, tag: 'select', name: 'Model', rect: { x: 100, y: 100, width: 240, height: 32 } },
    { id: 'e6', mainFrame: true, frameId: 0, tag: 'textarea', name: 'Prompt', rect: { x: 100, y: 150, width: 240, height: 100 } },
    { id: 'e7', mainFrame: true, frameId: 0, tag: 'input', type: 'checkbox', name: 'GIF', rect: { x: 100, y: 265, width: 24, height: 24 } },
    { id: 'e8', mainFrame: true, frameId: 0, tag: 'button', name: 'Generate', rect: { x: 100, y: 550, width: 240, height: 40 } },
    { id: 'e9', mainFrame: false, frameId: 2, tag: 'button', name: 'GIF', rect: { x: 100, y: 265, width: 24, height: 24 } },
  ];
  const original = structuredClone(page);
  const result = selectAgentVisualTarget(page, { goal: '选择模型2.6，填写提示词，勾选GIF并生成' });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'compact-control-group');
  assert.deepEqual(result.candidateElementIds, ['e5', 'e6', 'e7']);
  const region = planAgentVisualRegion(page, result.target.id);
  assert.equal(region.ok, true);
  for (const id of result.candidateElementIds) {
    const { rect } = page.elements.find(element => element.id === id);
    assert.ok(rect.x >= region.crop.x && rect.y >= region.crop.y
      && rect.x + rect.width <= region.crop.x + region.crop.width
      && rect.y + rect.height <= region.crop.y + region.crop.height);
  }
  assert.deepEqual(page, original);
  assert.ok(region.crop.width <= 640 && region.crop.height <= 480);
});

test('duplicate controls and separated equally relevant forms produce explicit ambiguity', () => {
  const page = observation();
  page.elements = [
    { id: 'e5', mainFrame: true, frameId: 0, tag: 'select', name: 'Model', rect: { x: 100, y: 100, width: 200, height: 32 } },
    { id: 'e6', mainFrame: true, frameId: 0, tag: 'select', name: 'Model', rect: { x: 700, y: 100, width: 200, height: 32 } },
  ];
  const result = selectAgentVisualTarget(page, { goal: '选择模型2.6' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ERR_VISUAL_TARGET_AMBIGUOUS');
  assert.equal(result.reason, 'duplicate-controls');
  assert.deepEqual(result.candidateElementIds, ['e5', 'e6']);
  assert.equal(chooseAgentVisualTarget(page, { goal: '选择模型2.6' }), null);
  page.elements[1].rect = { ...page.elements[0].rect };
  assert.equal(selectAgentVisualTarget(page, { goal: '选择模型2.6' }).error, 'ERR_VISUAL_TARGET_AMBIGUOUS');
  const unknown = selectAgentVisualTarget(page, { goal: '了解页面有什么' });
  assert.equal(unknown.error, 'ERR_VISUAL_TARGET_NOT_FOUND');
  assert.equal(unknown.reason, 'no-relevant-intent');
});

test('separated subgoals cannot become a random full-page observation', () => {
  const page = observation();
  page.elements = [
    { id: 'e5', mainFrame: true, frameId: 0, tag: 'select', name: 'Model', rect: { x: 100, y: 100, width: 200, height: 32 } },
    { id: 'e6', mainFrame: true, frameId: 0, tag: 'textarea', name: 'Prompt', rect: { x: 700, y: 100, width: 200, height: 100 } },
  ];
  assert.equal(selectAgentVisualTarget(page, { goal: '选择模型，填写提示词' }).reason, 'separated-controls');
  page.elements[1].rect.x = 100;
  page.elements[1].rect.y = 150;
  page.elements.push(
    { id: 'e7', mainFrame: true, frameId: 0, tag: 'input', type: 'checkbox', name: 'GIF', rect: { x: 700, y: 100, width: 24, height: 24 } },
    { id: 'e8', mainFrame: true, frameId: 0, tag: 'button', name: 'Generate', rect: { x: 700, y: 150, width: 200, height: 32 } },
  );
  const result = selectAgentVisualTarget(page, { goal: '选择模型，填写提示词，勾选GIF并生成' });
  assert.equal(result.error, 'ERR_VISUAL_TARGET_AMBIGUOUS');
  assert.equal(result.reason, 'separated-groups');
});

test('the existing cropper uses real high-DPI pixels and records the downscaled dimensions', async () => {
  const draws = [];
  const output = await cropAgentVisualImage(dataUrl, { x: 100, y: 80, width: 640, height: 480 }, {
    viewport: { width: 1000, height: 700 },
    loadImage: async () => ({ naturalWidth: 2000, naturalHeight: 1400 }),
    createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage: (...args) => draws.push(args) }) }),
    encodeCanvas: () => dataUrl,
  });
  assert.deepEqual(draws[0].slice(1), [200, 160, 1280, 960, 0, 0, 960, 720]);
  assert.deepEqual(output, { dataUrl, image: { width: 960, height: 720 }, sourceImage: { width: 2000, height: 1400 } });
});

test('guarded capture and crop return pinned source, origin, scale and untrusted candidate evidence', async () => {
  const calls = [];
  const service = createAgentVisualObservation({ capture: async request => { calls.push(request); return captured(); },
    cropImage: async (source, rect, options) => { calls.push({ source, rect, options }); return cropped(); } });
  const page = observation();
  const result = await service.inspect({ task: task(), observation: page, elementId: 'e1', profile: { supportsVision: true } });
  assert.equal(result.ok, true);
  assert.equal(calls[0].type, 'AGENT_CAPTURE');
  assert.equal(calls[0].expectedUrl, page.url);
  assert.equal(calls[0].documentId, page.documentId);
  assert.equal(calls[0].snapshotId, page.snapshotId);
  assert.equal(calls[0].taskId, 'task-1');
  assert.deepEqual(result.visual.candidateElementIds, ['e1', 'e2']);
  assert.deepEqual(result.visual.scale, { sourceX: 2, sourceY: 2, outputX: 2, outputY: 2 });
  assert.deepEqual(result.visual.crop, { x: 244, y: 192, width: 320, height: 200, coordinateSpace: 'viewport-css' });
  assert.equal(result.visual.source.url, page.url);
  assert.equal(result.visual.source.snapshotId, page.snapshotId);
  assert.equal(result.visual.source.taskId, 'task-1');
  assert.equal(result.visual.untrusted, true);
  assert.match(result.visual.notice, /不是执行指令/);
  service.dispose();
});

test('foreign tab, complete URL, document and snapshot captures are discarded before cropping', async () => {
  for (const field of [{ tabId: 8 }, { url: 'https://example.test/tool?version=3#settings' }, { documentId: 'document-2' }, { snapshotId: 'snapshot-2' }, { viewport: { width: 800, height: 700 } }]) {
    let crops = 0;
    const service = createAgentVisualObservation({ capture: async () => captured(field), cropImage: async () => { crops++; return cropped(); } });
    assert.equal((await service.inspect({ task: task(), observation: observation(), elementId: 'e1', profile: { supportsVision: true } })).error, 'ERR_PAGE_CHANGED');
    assert.equal(crops, 0);
    service.dispose();
  }
});

test('late capture after cancellation is ignored and never starts cropping', async () => {
  const pending = deferred();
  const controller = new AbortController();
  let crops = 0;
  const service = createAgentVisualObservation({ capture: () => pending.promise, cropImage: async () => { crops++; return cropped(); } });
  const result = service.inspect({ task: task(), observation: observation(), elementId: 'e1', profile: { supportsVision: true }, signal: controller.signal });
  controller.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(result, { name: 'AbortError' });
  pending.resolve(captured());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(crops, 0);
  service.dispose();
});

test('ownership, target geometry or page changes during crop prevent publishing visual evidence', async () => {
  for (const change of ['owner', 'rect', 'url', 'document', 'snapshot', 'viewport']) {
    const pending = deferred();
    const started = deferred();
    let current = true;
    const page = observation();
    const service = createAgentVisualObservation({ capture: async () => captured(), cropImage: () => { started.resolve(); return pending.promise; } });
    const result = service.inspect({ task: task(), observation: page, elementId: 'e1', profile: { supportsVision: true }, isCurrent: () => current });
    await started.promise;
    if (change === 'owner') current = false;
    if (change === 'rect') page.elements[0].rect.x += 40;
    if (change === 'url') page.url += '-changed';
    if (change === 'document') page.documentId = 'document-2';
    if (change === 'snapshot') page.snapshotId = 'snapshot-2';
    if (change === 'viewport') page.viewport.width = 800;
    pending.resolve(cropped());
    await assert.rejects(result, { code: 'ERR_PAGE_CHANGED' });
    service.dispose();
  }
});

test('capture waits are bounded and timed-out late results cannot start a crop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  let crops = 0;
  const service = createAgentVisualObservation({ timeoutMs: 20, capture: () => pending.promise, cropImage: async () => { crops++; return cropped(); } });
  const waiting = service.inspect({ task: task(), observation: observation(), elementId: 'e1', profile: { supportsVision: true } });
  const rejected = assert.rejects(waiting, { name: 'TimeoutError' });
  t.mock.timers.tick(20);
  await rejected;
  pending.resolve(captured());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(crops, 0);
  service.dispose();
});

test('missing vision, repeated targets across snapshots and total budgets cannot cause unlimited screenshots', async () => {
  let captures = 0;
  const service = createAgentVisualObservation({ maxCaptures: 2, capture: async request => { captures++; return captured({ snapshotId: request.snapshotId }); }, cropImage: async () => cropped() });
  const args = { task: task(), observation: observation(), elementId: 'e1', profile: { supportsVision: false } };
  assert.deepEqual((await service.inspect(args)).handoff, true);
  assert.equal(captures, 0);
  args.profile.supportsVision = true;
  assert.equal((await service.inspect(args)).ok, true);
  args.observation.snapshotId = 'new-snapshot';
  assert.equal((await service.inspect(args)).error, 'ERR_VISUAL_REGION_REPEATED');
  args.elementId = 'e4';
  assert.equal((await service.inspect(args)).ok, true);
  args.elementId = 'e2';
  assert.equal((await service.inspect(args)).error, 'ERR_VISUAL_LIMIT');
  assert.equal(captures, 2);
  service.dispose();
  assert.equal((await service.inspect(args)).error, 'ERR_VISUAL_DISPOSED');
});

test('invalid and oversized crop outputs never enter a model context', async () => {
  for (const output of [{ ...cropped(), dataUrl: 'https://example.test/image.jpg' },
    { ...cropped(), image: { width: 961, height: 400 } }, { ...cropped(), dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(700000) }]) {
    const service = createAgentVisualObservation({ capture: async () => captured(), cropImage: async () => output });
    assert.equal((await service.inspect({ task: task(), observation: observation(), elementId: 'e1', profile: { supportsVision: true } })).error, 'ERR_VISUAL_IMAGE_INVALID');
    service.dispose();
  }
});

test('disposal cancels a pending crop and rejects a second task using the same service', async () => {
  const pending = deferred();
  const started = deferred();
  const service = createAgentVisualObservation({ capture: async () => captured(), cropImage: () => { started.resolve(); return pending.promise; } });
  const args = { task: task(), observation: observation(), elementId: 'e1', profile: { supportsVision: true } };
  const waiting = service.inspect(args);
  await started.promise;
  assert.equal((await service.inspect({ ...args, task: { ...task(), id: 'task-2' } })).error, 'ERR_VISUAL_TASK_CHANGED');
  service.dispose();
  await assert.rejects(waiting, { name: 'AbortError' });
  pending.resolve(cropped());
  await new Promise(resolve => setImmediate(resolve));
});

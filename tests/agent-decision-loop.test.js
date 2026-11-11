import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSlot } from '../src/sidepanel/features/agent/agent-slot.js';
import { estimateMessagesTokens, estimateTextTokens } from '../src/utils/context.js';
import { createModelGateway } from '../src/app/model-gateway.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'expected lifecycle state was not reached'); await sleep(1); }
}

class Element {
  hidden = true;
  dataset = {};
  listeners = {};
  attributes = {};
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  removeEventListener(name, fn) { if (this.listeners[name] === fn) delete this.listeners[name]; }
  focus() {}
  append() {}
  remove() {}
  set innerHTML(value) {
    this.html = value;
    this.buttons = Array.from(value.matchAll(/data-choice="(\d+)"/g), match => {
      const button = new Element(); button.dataset.choice = match[1]; return button;
    });
  }
  get innerHTML() { return this.html || ''; }
  querySelectorAll() { return this.buttons || []; }
  querySelector() { return { checked: false }; }
  choose(index) { this.buttons[index].listeners.click(); }
}

const observation = { snapshotId: 'snapshot', title: 'Page', url: 'https://allowed.test/app', summary: 'Page contents', elements: [], flags: {} };
const decisionResponse = action => Response.json({ choices: [{ message: { content: JSON.stringify(action) } }] });

function fixture(t, { send, fetch: fetchOverride, begin, end, restore, get, set, remove, query = async () => ({ id: 1, url: observation.url }), getPageModeEnabled = () => true, authorized = true, stored = {}, timeouts = {}, profile = {}, modelGateway, signal, onCleanup, recordDiagnostic, getDiagnosticContext, cropVisualImage } = {}) {
  const original = { chrome: globalThis.chrome, document: globalThis.document, fetch: globalThis.fetch };
  const elements = new Map(['agent-panel', 'agent-toggle', 'agent-goal', 'agent-origin', 'agent-status', 'agent-steps', 'agent-interaction', 'agent-stop', 'agent-takeover', 'agent-close', 'toast-region'].map(id => [`#${id}`, new Element()]));
  const events = [];
  const models = [];
  const diagnostics = [];
  const turns = [];
  const tasks = new Set();
  const data = { agentSettings: { enabled: true }, agentOriginGrants: authorized ? { 'https://allowed.test': { scope: 'always' } } : {}, ...stored };
  const base = {
    async get(key) { return key == null ? { ...data } : { [key]: data[key] }; },
    async set(value) { Object.assign(data, value); },
    async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete data[item]; },
  };
  const area = {
    get: key => get ? get(key, base) : base.get(key),
    set: value => set ? set(value, base) : base.set(value),
    remove: key => remove ? remove(key, base) : base.remove(key),
  };
  const activated = [];
  const updated = [];
  const messages = [];
  const tabUpdates = [];
  const eventFor = listeners => ({
    addListener: listener => listeners.push(listener),
    removeListener: listener => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
  });
  globalThis.document = { querySelector: selector => elements.get(selector) || null, createElement: () => new Element() };
  globalThis.chrome = {
    storage: { local: area, session: area },
    tabs: {
      onActivated: eventFor(activated),
      onUpdated: eventFor(updated),
      get: async id => ({ id, url: observation.url }),
      update: async (id, options) => { tabUpdates.push({ id, options }); return { id, url: observation.url }; },
    },
    runtime: { onMessage: eventFor(messages) },
  };
  globalThis.fetch = async (url, request) => {
    models.push({ url, request });
    return fetchOverride ? fetchOverride(url, request) : decisionResponse({ action: 'finish_task', args: { summary: 'Done' } });
  };
  const slot = createAgentSlot({
    queryActiveTab: query,
    getPageModeEnabled,
    getProfile: () => ({ endpointUrl: 'https://model.test/v1', apiKey: 'test-only', model: 'fixture', ...(typeof profile === 'function' ? profile() : profile) }),
    modelGateway, signal, onCleanup, getDiagnosticContext, cropVisualImage,
    recordDiagnostic: entry => { diagnostics.push(structuredClone(entry)); return recordDiagnostic?.(entry); },
    timeouts: { preparation: 30, observe: 70, action: 40, cleanup: 10, evidence: 15, model: 70, summary: 20, ...timeouts },
    beginTurn: async (turn, options) => { turns.push({ kind: 'begin', turn, options }); if (begin) return begin(turn, options); },
    endTurn: async (turn, options) => { turns.push({ kind: 'end', turn, options }); if (end) return end(turn, options); },
    restoreTurn: restore,
    onStateChange: () => { if (slot.getTask()) tasks.add(slot.getTask()); },
    sendMessage: async message => {
      events.push(message);
      const custom = send ? await send(message) : undefined;
      if (custom !== undefined) return custom;
      if (message.type === 'AGENT_OBSERVE') return observation;
      if (message.type === 'AGENT_PAGE_EVIDENCE') return { error: 'NO_EVIDENCE' };
      return { ok: true };
    },
  });
  t.after(async () => {
    await slot.stop();
    await Promise.allSettled([...tasks].map(task => task.finalization));
    await slot.dispose();
    Object.assign(globalThis, original);
  });
  return { slot, data, events, models, turns, elements, tabUpdates, diagnostics, listeners: { activated, updated, messages },
    activate: tabId => activated.forEach(listener => listener({ tabId })),
    update: (tabId, info) => updated.forEach(listener => listener(tabId, info)),
    takeover: reason => messages.forEach(listener => listener({ type: 'AGENT_TAKEOVER', tabId: 1, taskId: slot.getTask()?.id, reason })),
  };
}

const writeGoal = '选择2.6模型，上传参考图，填写提示词后生成动态图';
const writePlan = active => ['选择模型', '上传参考图', '填写提示词', '生成动态图', '核对结果'].map((title, index) => ({
  id: `goal-${index}`, title, status: index < active ? 'completed' : index === active ? 'in_progress' : 'pending',
}));
const requestText = request => JSON.parse(request.body).messages.map(message => typeof message.content === 'string'
  ? message.content : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n');
const rawPayload = request => {
  const content = JSON.parse(request.body).messages[1].content;
  const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  return JSON.parse(text.slice(text.indexOf('{')));
};

test('a state check after a SPA URL transition cannot credit a successful write from the old page', { timeout: 3000 }, async t => {
  let requests = 0, snapshots = 0, selected = '2.5', pageUrl = observation.url;
  const pending = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000, action: 1000 },
    fetch: () => {
      requests += 1;
      if (requests === 1) return decisionResponse({ action: 'update_plan', args: { steps: writePlan(0) } });
      if (requests === 2) return decisionResponse({ action: 'select_option', args: { elementId: 'e1', value: '2.6' } });
      if (requests === 3 || requests === 5) return decisionResponse({ action: 'verify_state', args: { elementId: 'e1', field: 'selectedValue', expected: '2.6' } });
      if (requests === 4) return decisionResponse({ action: 'navigate', args: { url: 'https://allowed.test/second' } });
      return pending.promise;
    },
    send: message => {
      if (message.type === 'AGENT_OBSERVE') return { ...observation, url: pageUrl, documentId: 'spa-document', snapshotId: `spa-${++snapshots}`,
        elements: [{ id: 'e1', stableKey: 'same-model-control', tag: 'select', role: 'combobox', name: '模型', select: { selected: [{ value: selected, text: selected }] } }] };
      if (message.type === 'AGENT_ACT' && message.action === 'select_option') { selected = message.args.value; return { ok: true, diagnostics: { executionStatus: 'verified' } }; }
      if (message.type === 'AGENT_NAVIGATE') {
        // The background accepted an SPA transition; its retained control now
        // belongs to another full URL despite sharing a document and stable key.
        pageUrl = 'https://allowed.test/second';
        return { ok: true, tabUrl: pageUrl, diagnostics: { executionStatus: 'verified' } };
      }
    },
  });
  await value.slot.start(writeGoal);
  await until(() => requests === 6 || ['failed', 'paused'].includes(value.slot.getTask().status), 1500);
  assert.equal(requests, 6, JSON.stringify({ status: value.slot.getTask().status, result: value.slot.getTask().result, events: value.events.map(item => item.type) }));
  const progress = value.slot.getTask().progress;
  const states = progress.evidence.filter(item => item.kind === 'state');
  assert.equal(states.length, 2);
  assert.equal(states[0].executionRelevant, true, 'same-page verification must retain execution credit');
  assert.equal(states[1].executionRelevant, false, 'the old-page select must not credit the retained control on a new URL');
  assert.equal(progress.progressVersion, 3, 'only the selection, same-page state check and navigation may add execution progress');
  assert.equal(progress.noProgressDecisions, 1, 'checking a new-page default must not reset the stall budget');
  assert.equal(progress.scope.url, pageUrl);
  await value.slot.stop();
  pending.resolve(decisionResponse({ action: 'finish_task', args: { summary: 'late' } }));
});

test('a real write-task loop recovers by the fourth decision and stops after three further unexecuted decisions', { timeout: 4000 }, async t => {
  let decisions = 0, reads = 0, snapshots = 0;
  const ended = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000 }, end: turn => ended.resolve(turn),
    fetch: () => decisionResponse(++decisions % 2
      ? { action: 'update_plan', args: { steps: writePlan(0) } }
      : { action: 'read_page', args: { query: `different-query-${decisions}` } }),
    send: message => message.type === 'AGENT_OBSERVE'
      ? { ...observation, documentId: 'doc-one', snapshotId: `snapshot-${++snapshots}` }
      : message.type === 'AGENT_READ_PAGE'
        ? { ok: true, url: observation.url, documentId: 'doc-one', title: 'Generator', text: `A fresh but unexecuted page body ${++reads}` }
        : undefined,
  });
  assert.equal(await value.slot.start(writeGoal), true);
  const result = await ended.promise;
  await value.slot.getTask().finalization;
  assert.equal(result.status, 'failed');
  assert.ok(decisions <= 7, `unexecuted writes consumed ${decisions} decisions instead of at most seven`);
  const replans = value.diagnostics.filter(entry => entry.event === 'agent.task.progress' && entry.data.strategy === 'replan');
  assert.equal(replans.length, 1);
  assert.ok(replans[0].data.step <= 5, 'recovery must start immediately after at most four completed decisions');
  assert.equal(value.diagnostics.some(entry => entry.event === 'agent.task.progress' && entry.data.strategy === 'extend'), false);
  assert.equal(value.events.some(message => ['AGENT_ACT', 'AGENT_UPLOAD_REFERENCE'].includes(message.type)), false);
  assert.equal(value.diagnostics.find(entry => entry.event === 'agent.task.stopped').data.reason, 'no-progress');
  assert.equal(value.turns.filter(turn => turn.kind === 'begin').length, 1);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
});

test('a query-only page reread reports unchanged evidence and keeps one actual source body', { timeout: 2000 }, async t => {
  const requests = [];
  let reads = 0;
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000 },
    fetch: (_url, request) => {
      requests.push(request);
      return decisionResponse(requests.length <= 2
        ? { action: 'read_page', args: { query: requests.length === 1 ? '模型说明' : '再检查模型说明' } }
        : { action: 'finish_task', args: { summary: '已读取，同一正文无需重复抓取。' } });
    },
    send: message => message.type === 'AGENT_READ_PAGE' ? {
      ok: true, url: observation.url, documentId: 'doc-one', title: 'Model instructions',
      text: '同一篇实际正文；模型说明与操作入口。', capturedAt: `2026-11-06T03:46:0${++reads}Z`, truncated: false,
    } : undefined,
  });
  await value.slot.start('读一次页面正文');
  await until(() => value.slot.getTask().status === 'finished', 1500);
  await value.slot.getTask().finalization;
  assert.match(requestText(requests[2]), /与上次相同|正文未变化|相同正文/);
  assert.equal(value.slot.getTask().pageReadings.length, 1);
  assert.equal(value.slot.getTask().pageReadings[0].url, observation.url);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
});

test('trimmed multimodal decisions retain the image, task goal and actual page source through a malformed-decision repair', { timeout: 3000 }, async t => {
  const sourceBody = '中文页面资料与必要操作说明。'.repeat(1000).slice(0, 10000);
  const goal = '总结页面文章，参考图仅作为解释资料';
  const requests = [];
  const image = { id: 'reference', type: 'image', name: 'reference.png', dataUrl: 'data:image/png;base64,aGVsbG8=', width: 800, height: 600 };
  const value = fixture(t, {
    profile: { supportsVision: true, contextLength: 8000, maxTokens: 100 },
    timeouts: { model: 1000, observe: 1000, preparation: 100 },
    fetch: (_url, request) => {
      requests.push(request);
      const sent = JSON.parse(request.body);
      assert.ok(estimateMessagesTokens(sent.messages) + estimateTextTokens(JSON.stringify(sent.tools)) + sent.max_tokens <= 7200);
      assert.equal(rawPayload(request).goal, goal);
      const pictures = sent.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url');
      assert.equal(pictures[0]?.image_url.url, image.dataUrl);
      if (requests.length === 1) return decisionResponse({ action: 'read_page', args: { query: '文章' } });
      assert.equal(rawPayload(request).page_readings[0].url, observation.url);
      assert.equal(rawPayload(request).page_readings[0].truncated, true);
      if (requests.length === 2) return Response.json({ choices: [{ message: { content: 'Malformed action' } }] });
      assert.match(requestText(request), /上一次输出不是有效动作/);
      return decisionResponse({ action: 'finish_task', args: { summary: '已结合图文总结。' } });
    },
    send: message => message.type === 'AGENT_READ_PAGE'
      ? { ok: true, url: observation.url, title: 'Reference article', capturedAt: '2026-11-06T03:46:00Z', text: sourceBody, truncated: false }
      : undefined,
  });
  await value.slot.start(goal, { referenceImages: [image] });
  await until(() => value.slot.getTask().status === 'finished', 2000);
  await value.slot.getTask().finalization;
  assert.equal(requests.length, 3);
  assert.equal(value.slot.getTask().pageReadings[0].text, sourceBody);
  assert.equal(value.turns.find(item => item.kind === 'end').turn.sources[0].url, observation.url);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
});

for (const [label, emptyMessage] of [['empty content', { content: '' }], ['empty tools', { content: '', tool_calls: [] }]]) {
  test(`HTTP200 ${label} after a verified selection does not replay the action or create another main turn`, { timeout: 3000 }, async t => {
    let requests = 0, selected = '2.5', snapshots = 0;
    const ended = deferred();
    const value = fixture(t, {
      timeouts: { model: 1000, observe: 1000, action: 1000 }, end: turn => ended.resolve(turn),
      fetch: () => ++requests === 1 ? decisionResponse({ action: 'update_plan', args: { steps: writePlan(0) } })
        : requests === 2 ? decisionResponse({ action: 'select_option', args: { elementId: 'e1', value: '2.6' } })
          : Response.json({ choices: [{ message: emptyMessage }] }),
      send: message => {
        if (message.type === 'AGENT_OBSERVE') return { ...observation, documentId: 'doc-one', snapshotId: `snapshot-${++snapshots}`,
          elements: [{ id: 'e1', stableKey: 'model', tag: 'select', role: 'combobox', name: '模型', select: { selected: [{ value: selected, text: selected }] } }] };
        if (message.type === 'AGENT_ACT') { selected = message.args.value; return { ok: true, diagnostics: { executionStatus: 'verified', stages: [{ stage: 'check', valueMatched: true }] } }; }
      },
    });
    await value.slot.start(writeGoal);
    const result = await ended.promise;
    await value.slot.getTask().finalization;
    assert.equal(result.status, 'failed');
    assert.equal(requests, 3);
    assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 1);
    assert.equal(selected, '2.6');
    assert.equal(value.turns.filter(turn => turn.kind === 'begin').length, 1);
    assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
    assert.equal(value.diagnostics.filter(entry => entry.event === 'agent.verify.completed' && entry.data.action === 'select_option').length, 1);
  });
}

test('real verified select, checkbox and input effects let a write loop complete its plan', { timeout: 5000 }, async t => {
  const steps = active => ['选择模型', '开启动态', '填写提示词'].map((title, index) => ({ id: `verified-${index}`, title,
    status: index < active ? 'completed' : index === active ? 'in_progress' : 'pending' }));
  const decisions = [
    { action: 'update_plan', args: { steps: steps(0) } },
    { action: 'select_option', args: { elementId: 'e1', value: '2.6' } },
    { action: 'update_plan', args: { steps: steps(1) } },
    { action: 'click_element', args: { elementId: 'e2' } },
    { action: 'update_plan', args: { steps: steps(2) } },
    { action: 'type_text', args: { elementId: 'e3', text: '生成动态图提示词' } },
    { action: 'update_plan', args: { steps: steps(3) } },
    { action: 'finish_task', args: { summary: '设置已完成并核验' } },
  ];
  let index = 0, selected = '2.5', checked = false, snapshots = 0;
  const ended = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000, action: 1000 }, end: turn => ended.resolve(turn),
    fetch: () => decisionResponse(decisions[index++] || { action: 'fail_task', args: { reason: 'Unexpected replay' } }),
    send: message => {
      if (message.type === 'AGENT_OBSERVE') return { ...observation, documentId: 'doc-one', snapshotId: `snapshot-${++snapshots}`, elements: [
        { id: 'e1', stableKey: 'model', tag: 'select', role: 'combobox', name: '模型', select: { selected: [{ value: selected, text: selected }] } },
        { id: 'e2', stableKey: 'animate', tag: 'input', type: 'checkbox', role: 'checkbox', name: '动态', state: { checked } },
        { id: 'e3', stableKey: 'prompt', tag: 'textarea', role: 'textbox', name: '提示词' },
      ] };
      if (message.type === 'AGENT_ACT') {
        if (message.action === 'select_option') selected = message.args.value;
        if (message.action === 'click_element') checked = true;
        return { ok: true, diagnostics: { executionStatus: 'verified', stages: [{ stage: 'check', valueMatched: true }] } };
      }
    },
  });
  await value.slot.start('选择2.6模型，开启动态，填写提示词');
  assert.equal((await ended.promise).status, 'finished');
  await value.slot.getTask().finalization;
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 3);
  assert.equal(value.diagnostics.some(entry => entry.event === 'agent.task.progress' && entry.data.strategy === 'replan'), false);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
});

const fullVisual = 'data:image/jpeg;base64,ZnVsbC1zY3JlZW4=';
const croppedVisual = 'data:image/jpeg;base64,Y3JvcHBlZA==';
const visualViewport = { width: 1000, height: 700 };
const visualPage = revision => ({ ...observation, tabId: 1, documentId: 'doc-one', snapshotId: `visual-${revision}`,
  viewport: visualViewport, scrollY: 0, elements: [
    { id: `e${revision}`, stableKey: 'model', mainFrame: true, frameId: 0, tag: 'select', role: 'combobox', name: 'Model',
      rect: { x: 100, y: 100, width: 150, height: 32 }, select: { selected: [{ value: '2.5', text: '2.5' }] } },
    { id: 'e99', stableKey: 'neighbour', mainFrame: true, frameId: 0, tag: 'button', role: 'button', name: '说明',
      rect: { x: 120, y: 152, width: 60, height: 25 } },
  ] });
const visualCapture = message => ({ ok: true, taskId: message.taskId, tabId: message.tabId, url: message.expectedUrl,
  documentId: message.documentId, snapshotId: message.snapshotId, dataUrl: fullVisual, viewport: visualViewport });
const visualCrop = () => ({ dataUrl: croppedVisual, image: { width: 640, height: 400 }, sourceImage: { width: 2000, height: 1400 } });
const imageParts = request => JSON.parse(request.body).messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  .filter(part => part.type === 'image_url');

test('inspect_visual refreshes the stable target, sends a local image with current candidate IDs and never repeats its capture', { timeout: 2500 }, async t => {
  let snapshots = 0, crops = 0;
  const requests = [];
  const value = fixture(t, {
    profile: { supportsVision: true }, timeouts: { model: 1000, observe: 1000, evidence: 1000 },
    cropVisualImage: async (source, rect, options) => {
      crops += 1;
      assert.equal(source, fullVisual);
      assert.deepEqual(options.viewport, visualViewport);
      assert.equal(options.signal.aborted, false);
      assert.ok(rect.width <= 640 && rect.height <= 480);
      return visualCrop();
    },
    fetch: (_url, request) => {
      requests.push(request);
      if (requests.length === 1) return decisionResponse({ action: 'inspect_visual', args: { elementId: 'e1' } });
      if (requests.length === 2) {
        assert.equal(imageParts(request).at(-1).image_url.url, croppedVisual);
        const text = requestText(request);
        assert.match(text, /"candidateElementIds":\["e2","e99"\]/);
        assert.match(text, /"snapshotId":"visual-2"/);
        assert.match(text, /"coordinateSpace":"viewport-css"/);
        assert.match(text, /"untrusted":true/);
        return decisionResponse({ action: 'inspect_visual', args: { elementId: 'e2' } });
      }
      assert.match(requestText(request), /已经进行过局部视觉观察/);
      return decisionResponse({ action: 'finish_task', args: { summary: '已查看控件附近画面' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? visualPage(++snapshots)
      : message.type === 'AGENT_CAPTURE' ? visualCapture(message) : undefined,
  });
  await value.slot.start('查看模型控件');
  await until(() => value.slot.getTask().status === 'finished', 1800);
  await value.slot.getTask().finalization;
  const captures = value.events.filter(message => message.type === 'AGENT_CAPTURE');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].taskId, value.slot.getTask().id);
  assert.equal(captures[0].tabId, 1);
  assert.equal(captures[0].expectedUrl, observation.url);
  assert.equal(captures[0].documentId, 'doc-one');
  assert.equal(captures[0].snapshotId, 'visual-2', 'capture must use a fresh rematched snapshot rather than the model input snapshot');
  assert.equal(crops, 1);
  assert.equal(value.events.some(message => ['AGENT_ACT', 'AGENT_NAVIGATE'].includes(message.type)), false);
  assert.equal(requests.length, 3);
  assert.equal(value.turns.filter(item => item.kind === 'begin').length, 1);
  assert.equal(value.turns.filter(item => item.kind === 'end').length, 1);
});

test('a missing automatic visual target is reported without consuming capture and can recover after a concrete replan', { timeout: 2500 }, async t => {
  let requests = 0;
  const ended = deferred();
  const value = fixture(t, {
    profile: { supportsVision: true }, timeouts: { model: 1000, observe: 1000, evidence: 1000 }, end: turn => ended.resolve(turn),
    cropVisualImage: visualCrop,
    fetch: (_url, request) => {
      requests += 1;
      if (requests <= 4) return decisionResponse({ action: 'update_plan', args: { steps: writePlan(1) } });
      if (requests === 5) {
        assert.equal(value.slot.getTask().recoveryVisionUsed === true, false, 'no candidate is not a capture attempt');
        assert.match(requestText(request), /未找到|没有找到|不可用/);
        assert.equal(value.diagnostics.some(item => item.event === 'agent.read.failed' && item.error?.code === 'ERR_VISUAL_TARGET_NOT_FOUND'), true);
        return decisionResponse({ action: 'update_plan', args: { steps: writePlan(0) } });
      }
      assert.equal(requests, 6);
      assert.equal(imageParts(request).at(-1).image_url.url, croppedVisual);
      return decisionResponse({ action: 'fail_task', args: { reason: 'Recovered only after a current candidate existed' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? visualPage(1)
      : message.type === 'AGENT_CAPTURE' ? visualCapture(message) : undefined,
  });
  await value.slot.start(writeGoal);
  assert.equal((await ended.promise).status, 'failed');
  await value.slot.getTask().finalization;
  assert.match(value.slot.getTask().result, /Recovered only after/);
  assert.equal(requests, 6);
  assert.equal(value.events.filter(item => item.type === 'AGENT_CAPTURE').length, 1);
  assert.equal(value.events.some(item => item.type === 'AGENT_ACT'), false);
});

test('failed optional automatic capture is visible in decision feedback and diagnostics without replaying the capture', { timeout: 2500 }, async t => {
  let requests = 0;
  const ended = deferred();
  const value = fixture(t, {
    profile: { supportsVision: true }, timeouts: { model: 1000, observe: 1000, evidence: 1000 }, end: turn => ended.resolve(turn),
    fetch: (_url, request) => {
      if (++requests <= 4) return decisionResponse({ action: 'update_plan', args: { steps: writePlan(0) } });
      assert.match(requestText(request), /ERR_CAPTURE_FAILED/);
      assert.equal(value.diagnostics.some(item => item.event === 'agent.read.failed' && item.error?.code === 'ERR_CAPTURE_FAILED'), true);
      return decisionResponse({ action: 'fail_task', args: { reason: 'Capture failure retained' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? visualPage(1)
      : message.type === 'AGENT_CAPTURE' ? { error: 'ERR_CAPTURE_FAILED', message: '局部截图不可用' } : undefined,
  });
  await value.slot.start(writeGoal);
  assert.equal((await ended.promise).status, 'failed');
  await value.slot.getTask().finalization;
  assert.match(value.slot.getTask().result, /Capture failure retained/);
  assert.equal(requests, 5);
  assert.equal(value.events.filter(item => item.type === 'AGENT_CAPTURE').length, 1);
});

test('the real write loop budgets region summaries while preserving task text and provenance', { timeout: 2500 }, async t => {
  let requests = 0, reads = 0;
  const ended = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000 }, end: turn => ended.resolve(turn),
    fetch: (_url, request) => {
      requests += 1;
      if (requests === 1) return decisionResponse({ action: 'update_plan', args: { steps: writePlan(0) } });
      if (requests <= 4) return decisionResponse({ action: 'read_region', args: { elementId: 'e8', query: `操作说明${requests}` } });
      const payload = rawPayload(request);
      assert.ok(JSON.stringify(payload.region_data).length <= 3000);
      assert.equal(payload.region_data.summaryTruncated, true);
      assert.equal(payload.region_data.sources.at(-1).url, observation.url);
      assert.match(payload.region_data.excerpts.at(-1).text, /第三份/);
      assert.equal(value.slot.getTask().regionReadings.at(-1).text.length, 2000);
      return decisionResponse({ action: 'fail_task', args: { reason: 'Region budget retained task evidence' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? { ...observation, documentId: 'doc-one', elements: [{ id: 'e8', tag: 'main', readable: true, readOnly: true }] }
      : message.type === 'AGENT_READ_REGION' ? { ok: true, regionReading: { url: observation.url, documentId: 'doc-one',
        regionKey: 'instructions', title: '操作说明', rows: [], text: `${++reads === 3 ? '第三份' : '早前'}操作说明。`.repeat(800).slice(0, 4000),
        totalRows: 0, capturedAt: `2026-11-06T05:36:0${reads}Z`, truncated: false } } : undefined,
  });
  await value.slot.start(writeGoal);
  assert.equal((await ended.promise).status, 'failed');
  await value.slot.getTask().finalization;
  assert.match(value.slot.getTask().result, /Region budget retained/);
  assert.equal(requests, 5);
  const metrics = value.diagnostics.filter(entry => entry.event === 'agent.decision.completed').at(-1).data;
  assert.ok(metrics.regionTextChars <= 3000);
  assert.ok(metrics.regionReadingCount > 0);
});

test('a nonvisual model hands off an explicit visual inspection without a capture or mutation', { timeout: 2000 }, async t => {
  let snapshots = 0;
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000, evidence: 1000 },
    fetch: () => decisionResponse({ action: 'inspect_visual', args: { elementId: 'e1' } }),
    send: message => message.type === 'AGENT_OBSERVE' ? visualPage(++snapshots) : undefined,
  });
  await value.slot.start('查看模型控件');
  await until(() => value.slot.getTask().status === 'paused', 1200);
  assert.equal(value.models.length, 1);
  assert.equal(value.events.some(message => ['AGENT_CAPTURE', 'AGENT_ACT'].includes(message.type)), false);
  assert.match(value.slot.getTask().pauseReason, /不支持视觉|接管/);
});

test('a stalled write automatically inspects a fresh model-control region after four decisions', { timeout: 2500 }, async t => {
  let snapshots = 0, requests = 0, crops = 0;
  const ended = deferred();
  const value = fixture(t, {
    profile: { supportsVision: true }, timeouts: { model: 1000, observe: 1000, evidence: 1000 }, end: turn => ended.resolve(turn),
    cropVisualImage: async () => { crops += 1; return visualCrop(); },
    fetch: (_url, request) => {
      requests += 1;
      if (requests <= 4) return decisionResponse(requests % 2
        ? { action: 'update_plan', args: { steps: writePlan(0) } }
        : { action: 'read_page', args: { query: `fresh-reading-${requests}` } });
      assert.equal(requests, 5);
      assert.equal(imageParts(request).at(-1).image_url.url, croppedVisual);
      assert.match(requestText(request), /"candidateElementIds":\["e2","e99"\]/);
      return decisionResponse({ action: 'fail_task', args: { reason: '已验证局部视觉恢复，结束测试' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? visualPage(++snapshots)
      : message.type === 'AGENT_CAPTURE' ? visualCapture(message)
        : message.type === 'AGENT_READ_PAGE' ? { ok: true, url: observation.url, documentId: 'doc-one', text: `内容变化但未执行 ${requests}` } : undefined,
  });
  await value.slot.start(writeGoal);
  assert.equal((await ended.promise).status, 'failed');
  await value.slot.getTask().finalization;
  const captures = value.events.filter(message => message.type === 'AGENT_CAPTURE');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].snapshotId, 'visual-2');
  assert.equal(crops, 1);
  assert.equal(value.events.some(message => message.type === 'AGENT_ACT'), false);
  assert.equal(value.diagnostics.filter(entry => entry.event === 'agent.task.progress' && entry.data.strategy === 'visual').length, 1);
});

test('visual recovery with no observed candidate stops within its one recovery budget and never invents a screenshot target', { timeout: 2000 }, async t => {
  let requests = 0, crops = 0;
  const ended = deferred();
  const value = fixture(t, {
    profile: { supportsVision: true }, timeouts: { model: 1000, observe: 1000, evidence: 1000 }, end: turn => ended.resolve(turn),
    cropVisualImage: async () => { crops += 1; return visualCrop(); },
    fetch: () => decisionResponse(++requests % 2
      ? { action: 'update_plan', args: { steps: writePlan(0) } }
      : { action: 'read_page', args: { query: `missing-candidate-${requests}` } }),
    send: message => message.type === 'AGENT_OBSERVE' ? { ...visualPage(1), elements: [] }
      : message.type === 'AGENT_READ_PAGE' ? { ok: true, url: observation.url, text: `Fresh unexecuted content ${requests}` } : undefined,
  });
  await value.slot.start(writeGoal);
  assert.equal((await ended.promise).status, 'failed');
  await value.slot.getTask().finalization;
  assert.ok(requests <= 7);
  assert.equal(crops, 0);
  assert.equal(value.events.some(message => ['AGENT_CAPTURE', 'AGENT_ACT'].includes(message.type)), false);
  assert.equal(value.diagnostics.filter(entry => entry.event === 'agent.task.progress' && entry.data.strategy === 'replan').length, 1);
  assert.equal(value.turns.filter(item => item.kind === 'end').length, 1);
});

for (const phase of ['capture', 'crop']) {
  test(`stopping a pending visual ${phase} discards its late result without publishing into the next task`, { timeout: 3500 }, async t => {
    const oldWait = deferred(), newModel = deferred();
    let snapshots = 0, crops = 0, oldCapture, cropSignal;
    const value = fixture(t, {
      profile: { supportsVision: true }, timeouts: { model: 1000, observe: 1000, evidence: 1000 },
      cropVisualImage: async (_source, _rect, options) => {
        crops += 1; cropSignal = options.signal;
        return phase === 'crop' ? oldWait.promise : visualCrop();
      },
      fetch: () => value.models.length === 1 ? decisionResponse({ action: 'inspect_visual', args: { elementId: 'e1' } }) : newModel.promise,
      send: message => {
        if (message.type === 'AGENT_OBSERVE') return visualPage(++snapshots);
        if (message.type === 'AGENT_CAPTURE') { oldCapture = message; return phase === 'capture' ? oldWait.promise : visualCapture(message); }
      },
    });
    await value.slot.start('查看模型控件');
    await until(() => phase === 'capture' ? Boolean(oldCapture) : crops === 1, 1200);
    const oldId = value.slot.getTask().id;
    await value.slot.stop();
    assert.equal(value.slot.getTask().status, 'cancelled');
    assert.equal(await value.slot.start('读一次页面信息'), true);
    await until(() => value.models.length === 2, 1000);
    const newId = value.slot.getTask().id;
    assert.notEqual(newId, oldId);
    oldWait.resolve(phase === 'capture' ? visualCapture(oldCapture) : visualCrop());
    await tick(); await tick();
    assert.equal(value.models.length, 2, 'an old visual completion must not send another model request');
    assert.equal(value.slot.getTask().id, newId);
    assert.equal(value.slot.getTask().status, 'running');
    assert.equal(value.slot.getTask().visualEvidence == null, true);
    assert.equal(imageParts(value.models[1].request).length, 0);
    assert.equal(crops, phase === 'capture' ? 0 : 1);
    if (cropSignal) assert.equal(cropSignal.aborted, true);
    newModel.resolve(decisionResponse({ action: 'finish_task', args: { summary: '新任务完成' } }));
    await until(() => value.slot.getTask().status === 'finished', 1000);
    await value.slot.getTask().finalization;
    assert.equal(value.turns.filter(item => item.kind === 'begin').length, 2);
    assert.equal(value.turns.filter(item => item.kind === 'end').length, 2);
  });
}

test('an optional recovery image that exceeds a small context budget falls back to a real DOM decision', { timeout: 3000 }, async t => {
  const contextLength = 7500;
  let snapshots = 0, requests = 0, crops = 0;
  const value = fixture(t, {
    profile: { supportsVision: true, contextLength },
    timeouts: { model: 1000, observe: 1000, evidence: 1000 },
    cropVisualImage: async () => { crops += 1; return visualCrop(); },
    fetch: (_url, request) => {
      requests += 1;
      const sent = JSON.parse(request.body);
      assert.ok(estimateMessagesTokens(sent.messages) + estimateTextTokens(JSON.stringify(sent.tools)) + sent.max_tokens
        <= contextLength - Math.max(256, Math.ceil(contextLength * 0.1)), 'the actual DOM request must fit the full request budget');
      if (requests <= 4) return decisionResponse(requests % 2
        ? { action: 'update_plan', args: { steps: writePlan(0) } }
        : { action: 'read_page', args: { query: `budget-reading-${requests}` } });
      assert.equal(requests, 5);
      assert.equal(imageParts(request).length, 0, 'only the optional local image should be dropped');
      const messageBudget = contextLength - sent.max_tokens - estimateTextTokens(JSON.stringify(sent.tools))
        - Math.max(256, Math.ceil(contextLength * 0.1));
      assert.ok(estimateMessagesTokens(sent.messages) + 765 > messageBudget,
        'the retained DOM request must be close enough to its budget that even the local image alone cannot fit');
      assert.equal(rawPayload(request).goal, writeGoal);
      assert.ok(rawPayload(request).elements.some(element => element.id === 'e2'));
      return decisionResponse({ action: 'request_human_handoff', args: { reason: 'DOM fallback reached' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? visualPage(++snapshots)
      : message.type === 'AGENT_CAPTURE' ? visualCapture(message)
        : message.type === 'AGENT_READ_PAGE' ? { ok: true, url: observation.url, documentId: 'doc-one', text: `Unexecuted page body ${requests}` } : undefined,
  });
  await value.slot.start(writeGoal);
  await until(() => ['paused', 'failed'].includes(value.slot.getTask().status), 2200);
  assert.equal(value.slot.getTask().status, 'paused', value.slot.getTask().result);
  assert.equal(value.slot.getTask().pauseReason, 'DOM fallback reached');
  assert.equal(requests, 5);
  assert.equal(crops, 1);
  assert.equal(value.events.filter(message => message.type === 'AGENT_CAPTURE').length, 1);
  assert.equal(value.events.some(message => message.type === 'AGENT_ACT'), false);
});

test('an explicitly requested local image does not silently disappear when its context budget is insufficient', { timeout: 2500 }, async t => {
  let snapshots = 0;
  const value = fixture(t, {
    profile: { supportsVision: true, contextLength: 6600 },
    timeouts: { model: 1000, observe: 1000, evidence: 1000 },
    cropVisualImage: visualCrop,
    fetch: () => decisionResponse({ action: 'inspect_visual', args: { elementId: 'e1' } }),
    send: message => message.type === 'AGENT_OBSERVE' ? visualPage(++snapshots)
      : message.type === 'AGENT_CAPTURE' ? visualCapture(message) : undefined,
  });
  await value.slot.start('查看模型控件');
  await until(() => value.slot.getTask().status === 'failed', 1800);
  await value.slot.getTask().finalization;
  assert.match(value.slot.getTask().result, /上下文容量|上下文.*不足/);
  assert.equal(value.models.length, 1, 'the explicit inspection must not be followed by a decision without its required image');
  assert.equal(value.events.filter(message => message.type === 'AGENT_CAPTURE').length, 1);
  assert.equal(value.events.some(message => message.type === 'AGENT_ACT'), false);
});

test('a required user reference image fails visibly instead of being dropped to fit a small context', { timeout: 2500 }, async t => {
  const reference = { id: 'reference', type: 'image', name: 'reference.png',
    dataUrl: 'data:image/png;base64,aGVsbG8=', width: 800, height: 600 };
  const value = fixture(t, {
    profile: { supportsVision: true, contextLength: 6600 },
    timeouts: { model: 1000, observe: 1000, preparation: 1000 },
    send: message => message.type === 'AGENT_OBSERVE' ? visualPage(1) : undefined,
  });
  await value.slot.start('查看页面并按这张参考图说明', { referenceImages: [reference] });
  await until(() => value.slot.getTask().status === 'failed', 1800);
  await value.slot.getTask().finalization;
  assert.match(value.slot.getTask().result, /上下文容量|上下文.*不足/);
  assert.equal(value.models.length, 0, 'no model request may pretend it received the required reference image');
  assert.equal(value.slot.getTask().referenceImages[0].dataUrl, reference.dataUrl);
  assert.equal(value.events.some(message => ['AGENT_CAPTURE', 'AGENT_ACT'].includes(message.type)), false);
});

for (const automatic of [true, false]) {
  test(`${automatic ? 'automatic' : 'explicit'} visual capture control refusal pauses immediately without another model decision`, { timeout: 2500 }, async t => {
    let snapshots = 0, requests = 0, crops = 0;
    const refusal = '浏览器控制在截图期间已关闭，请核对后继续。';
    const value = fixture(t, {
      profile: { supportsVision: true },
      timeouts: { model: 1000, observe: 1000, evidence: 1000 },
      cropVisualImage: async () => { crops += 1; return visualCrop(); },
      fetch: () => {
        requests += 1;
        if (!automatic && requests === 1) return decisionResponse({ action: 'inspect_visual', args: { elementId: 'e1' } });
        if (automatic && requests <= 4) return decisionResponse(requests % 2
          ? { action: 'update_plan', args: { steps: writePlan(0) } }
          : { action: 'read_page', args: { query: `control-reading-${requests}` } });
        return decisionResponse({ action: 'request_human_handoff', args: { reason: 'Unexpected post-refusal decision' } });
      },
      send: message => {
        if (message.type === 'AGENT_OBSERVE') return visualPage(++snapshots);
        if (message.type === 'AGENT_READ_PAGE') return { ok: true, url: observation.url, documentId: 'doc-one', text: `Unexecuted page body ${requests}` };
        if (message.type === 'AGENT_CAPTURE') {
          value.data.agentSettings.enabled = false;
          return { ok: false, error: 'ERR_CONTROL_DISABLED', message: refusal };
        }
      },
    });
    await value.slot.start(automatic ? writeGoal : '查看模型控件');
    await until(() => ['paused', 'failed'].includes(value.slot.getTask().status), 1800);
    assert.equal(value.slot.getTask().status, 'paused', value.slot.getTask().result);
    assert.equal(requests, automatic ? 4 : 1, 'the control denial must stop new model requests in the current iteration');
    assert.equal(value.slot.getTask().pauseReason, refusal);
    assert.equal(value.events.filter(message => message.type === 'AGENT_CAPTURE').length, 1);
    assert.equal(crops, 0);
    assert.equal(value.events.some(message => message.type === 'AGENT_ACT'), false);
  });
}


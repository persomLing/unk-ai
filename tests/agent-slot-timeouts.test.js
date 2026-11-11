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

function fixture(t, { send, fetch: fetchOverride, begin, end, restore, get, set, remove, query = async () => ({ id: 1, url: observation.url }), getPageModeEnabled = () => true, authorized = true, stored = {}, timeouts = {}, profile = {}, modelGateway, signal, onCleanup, recordDiagnostic, getDiagnosticContext } = {}) {
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
    modelGateway, signal, onCleanup, getDiagnosticContext,
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

test('successful reads cannot erase repeated selection failures across fresh snapshots', { timeout: 5000 }, async t => {
  let decisions = 0, snapshots = 0, reads = 0;
  const finished = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000 }, end: turn => finished.resolve(turn),
    fetch: () => decisionResponse(++decisions % 2
      ? { action: 'select_option', args: { elementId: 'e1', value: '2.6' } }
      : { action: 'read_page', args: { query: `model options ${decisions}` } }),
    send: message => message.type === 'AGENT_OBSERVE'
      ? { ...observation, snapshotId: `snapshot-${++snapshots}`, elements: [{ id: 'e1', stableKey: 'model-field', tag: 'select', role: 'combobox', name: 'Model' }] }
      : message.type === 'AGENT_ACT' ? { error: 'ERR_ELEMENT_CHANGED', diagnostics: { failureStage: 'element-signature', executionStatus: 'not-started' } }
      : message.type === 'AGENT_READ_PAGE' ? { ok: true, url: observation.url, text: `Options 2.5 and 2.6; page revision ${++reads}` } : undefined,
  });
  await value.slot.start('选择模型 2.6');
  assert.equal((await finished.promise).status, 'failed');
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 3);
  assert.ok(value.events.some(message => message.type === 'AGENT_READ_PAGE'));
  assert.ok(value.diagnostics.some(entry => entry.event === 'agent.task.progress' && entry.data.strategy === 'replan'));
  assert.ok(value.diagnostics.some(entry => entry.event === 'agent.read.completed'));
});

test('an uncertain page submission ends without another action or a success summary', { timeout: 3000 }, async t => {
  const ended = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000 }, end: turn => ended.resolve(turn),
    fetch: () => decisionResponse({ action: 'click_element', args: { elementId: 'e1' } }),
    send: message => message.type === 'AGENT_OBSERVE'
      ? { ...observation, elements: [{ id: 'e1', tag: 'button', role: 'button', name: 'Open', type: 'button' }] }
      : message.type === 'AGENT_ACT' ? { error: 'ERR_ACTION_RESULT_UNKNOWN', diagnostics: { executionStatus: 'uncertain', failureStage: 'execute' } } : undefined,
  });
  await value.slot.start('打开工具');
  const result = await ended.promise;
  assert.equal(result.status, 'failed');
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 1);
  assert.match(value.slot.getTask().result, /未确认|不确定/);
});

test('a consumed reference upload proceeds to a confirmed local submit only after a matching preview receipt', { timeout: 5000 }, async t => {
  for (const accepted of [true, false]) await t.test(String(accepted), async t => {
    let snapshots = 0, decisions = 0, uploadId = '', submitted = false;
    const ended = deferred();
    const value = fixture(t, {
      profile: { supportsVision: true }, timeouts: { model: 1000, observe: 1000, action: 1000, evidence: 1000 },
      end: turn => ended.resolve(turn),
      fetch: () => decisionResponse(++decisions === 1
        ? { action: 'upload_reference_image', args: { elementId: 'e1', referenceId: 'reference-1' } }
        : decisions === 2 ? { action: 'click_element', args: { elementId: 'e2' } }
          : { action: 'finish_task', args: { summary: '本地模拟生成已完成' } }),
      send: message => {
        if (message.type === 'AGENT_START') return { ok: true, uploadReferences: [{ referenceId: 'reference-1', name: 'task.png', mime: 'image/png', size: 5 }] };
        if (message.type === 'AGENT_OBSERVE') return { ...observation, tabId: 1, documentId: 'document-1', snapshotId: `snapshot-${++snapshots}`,
          summary: submitted ? '本地模拟已提交' : uploadId ? '参考图 1/6，原文件输入框已清空' : '参考图 0/6', elements: [
            { id: 'e1', stableKey: 'reference-input', tag: 'input', role: 'button', type: 'file', name: 'Upload reference image', frameId: 0,
              fileInput: { supported: true, viaOverlay: true, accept: 'image/*', selectedFileCount: 0 },
              uploadCapability: { risk: 'confirm', referenceIds: ['reference-1'] } },
            { id: 'e2', stableKey: 'generate-button', tag: 'button', role: 'button', type: 'submit', name: '生成图片' },
          ] };
        if (message.type === 'AGENT_ACT' && message.action === 'upload_reference_image') {
          uploadId = message.actionId;
          return { error: 'ERR_UPLOAD_UNCERTAIN', upload: { referenceId: 'reference-1', requiresAcceptanceVerification: true,
            epoch: 1, documentId: 'document-1', frameId: 0 }, diagnostics: { executionStatus: 'uncertain', failureStage: 'check',
            stages: [{ stage: 'check', valueMatched: false }] } };
        }
        if (message.type === 'AGENT_VERIFY_UPLOAD') return accepted ? { ok: true, receipt: { version: 1, accepted: true,
          kind: 'new-matching-preview', taskId: message.taskId, epoch: 1, tabId: 1, frameId: 0, documentId: 'document-1',
          url: observation.url, snapshotId: message.snapshotId, actionId: uploadId, referenceId: 'reference-1', serverConfirmed: false } }
          : { error: 'ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED' };
        if (message.type === 'AGENT_ACT' && message.action === 'click_element') { submitted = true; return { ok: true }; }
      },
    });
    await value.slot.start('上传参考图并生成图片', { referenceImages: [{ type: 'image', name: 'task.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }] });
    const interaction = value.elements.get('#agent-interaction');
    await until(() => interaction.buttons?.length > 0, 1500);
    interaction.choose(0);
    if (accepted) {
      await until(() => value.events.some(item => item.type === 'AGENT_VERIFY_UPLOAD'), 1500);
      await until(() => interaction.buttons?.length > 0, 1500);
      interaction.choose(0);
    }
    const result = await ended.promise;
    assert.equal(result.status, accepted ? 'finished' : 'failed');
    assert.equal(value.events.filter(item => item.type === 'AGENT_ACT' && item.action === 'upload_reference_image').length, 1);
    assert.equal(value.events.filter(item => item.type === 'AGENT_ACT' && item.action === 'click_element').length, accepted ? 1 : 0);
    assert.equal(submitted, accepted, 'a mere count/summary change must never authorize the final submit');
    assert.ok(value.events.some(item => item.type === 'AGENT_VERIFY_UPLOAD'));
  });
});

test('stopping during preview verification ignores its late receipt and never retries or submits', async t => {
  const receipt = deferred();
  let verifyMessage;
  const value = fixture(t, {
    profile: { supportsVision: true }, timeouts: { model: 1000, observe: 1000, action: 1000, evidence: 1000 },
    fetch: () => decisionResponse({ action: 'upload_reference_image', args: { elementId: 'e1', referenceId: 'reference-1' } }),
    send: message => {
      if (message.type === 'AGENT_START') return { ok: true, uploadReferences: [{ referenceId: 'reference-1', name: 'task.png', mime: 'image/png', size: 5 }] };
      if (message.type === 'AGENT_OBSERVE') return { ...observation, tabId: 1, documentId: 'document', snapshotId: `snapshot-${value.events.length}`,
        elements: [{ id: 'e1', stableKey: 'file', frameId: 0, tag: 'input', role: 'button', name: 'Upload image', type: 'file',
          fileInput: { accept: 'image/*', supported: true, selectedFileCount: 0 }, uploadCapability: { risk: 'confirm', referenceIds: ['reference-1'] } }] };
      if (message.type === 'AGENT_ACT') return { error: 'ERR_UPLOAD_UNCERTAIN', upload: { requiresAcceptanceVerification: true,
        referenceId: 'reference-1', epoch: 1, documentId: 'document', frameId: 0 },
        diagnostics: { executionStatus: 'uncertain', stages: [{ stage: 'check', valueMatched: false }] } };
      if (message.type === 'AGENT_VERIFY_UPLOAD') { verifyMessage = message; return receipt.promise; }
    },
  });
  await value.slot.start('上传参考图片', { referenceImages: [{ type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=' }] });
  const interaction = value.elements.get('#agent-interaction');
  await until(() => interaction.buttons?.length > 0, 1500); interaction.choose(0);
  await until(() => verifyMessage, 1500);
  await value.slot.stop();
  receipt.resolve({ ok: true, receipt: { version: 1, accepted: true, kind: 'new-matching-preview', taskId: verifyMessage.taskId,
    tabId: 1, epoch: 1, frameId: 0, documentId: 'document', url: observation.url, snapshotId: verifyMessage.snapshotId,
    actionId: verifyMessage.uploadActionId, referenceId: 'reference-1', serverConfirmed: false } });
  await tick();
  assert.equal(value.slot.getTask().status, 'cancelled');
  assert.equal(value.events.filter(item => item.type === 'AGENT_ACT').length, 1);
  assert.equal(value.diagnostics.some(item => item.event === 'agent.verify.completed'), false);
});

test('a complex task advances its plan only alongside verified select, checkbox and input effects', { timeout: 5000 }, async t => {
  const plan = active => ['选择模型', '开启动态', '填写提示词'].map((title, index) => ({ id: `step-${index + 1}`, title,
    status: index < active ? 'completed' : index === active ? 'in_progress' : 'pending' }));
  const decisions = [
    { action: 'update_plan', args: { steps: plan(0) } },
    { action: 'select_option', args: { elementId: 'e1', value: '2.6' } },
    { action: 'update_plan', args: { steps: plan(1) } },
    { action: 'click_element', args: { elementId: 'e2' } },
    { action: 'update_plan', args: { steps: plan(2) } },
    { action: 'type_text', args: { elementId: 'e3', text: 'Animation prompt' } },
    { action: 'update_plan', args: { steps: plan(3) } },
    { action: 'finish_task', args: { summary: '设置已核验' } },
  ];
  let index = 0, selected = '2.5', checked = false;
  const ended = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000, action: 1000 }, end: turn => ended.resolve(turn),
    fetch: () => decisionResponse(decisions[index++] || { action: 'fail_task', args: { reason: 'Unexpected repeat' } }),
    send: message => {
      if (message.type === 'AGENT_OBSERVE') return { ...observation, elements: [
        { id: 'e1', stableKey: 'model', tag: 'select', role: 'combobox', name: 'Model', select: { selected: [{ value: selected, text: selected }] } },
        { id: 'e2', stableKey: 'animate', tag: 'input', type: 'checkbox', role: 'checkbox', name: 'Animate', state: { checked } },
        { id: 'e3', stableKey: 'prompt', tag: 'textarea', type: 'text', role: 'textbox', name: 'Prompt' },
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
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 3);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
  assert.equal(value.diagnostics.filter(entry => entry.event === 'agent.verify.completed').length, 3);
  assert.match(value.elements.get('#agent-status').innerHTML, /目标 3\/3/);
});

test('a model cannot finish a multi-step plan by only marking every step completed', { timeout: 3000 }, async t => {
  const ended = deferred();
  let decisions = 0;
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000 }, end: turn => ended.resolve(turn),
    fetch: () => decisionResponse(++decisions === 1
      ? { action: 'update_plan', args: { steps: ['选择', '勾选', '填写'].map((title, index) => ({ id: `s${index}`, title, status: 'completed' })) } }
      : { action: 'finish_task', args: { summary: 'Everything done' } }),
  });
  await value.slot.start('选择模型，勾选动态并填写提示词');
  assert.equal((await ended.promise).status, 'failed');
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 0);
  assert.match(value.slot.getTask().result, /尚未核验/);
});

test('stopping visual recovery discards the late screenshot and never sends it to a model', { timeout: 3000 }, async t => {
  const capture = deferred();
  const value = fixture(t, {
    profile: { supportsVision: true }, timeouts: { model: 1000, evidence: 1000, observe: 1000 },
    fetch: () => decisionResponse({ action: 'select_option', args: { elementId: 'e1', value: '2.6' } }),
    send: message => message.type === 'AGENT_OBSERVE'
      ? { ...observation, documentId: 'doc-one', viewport: { width: 1000, height: 800 },
        elements: [{ id: 'e1', stableKey: 'model', tag: 'select', role: 'combobox', name: 'Model', mainFrame: true,
          rect: { x: 20, y: 100, width: 160, height: 30 } }] }
      : message.type === 'AGENT_ACT' ? { error: 'ERR_ELEMENT_CHANGED', diagnostics: { failureStage: 'element-signature' } }
      : message.type === 'AGENT_CAPTURE' ? capture.promise : undefined,
  });
  await value.slot.start('选择模型2.6');
  await until(() => value.events.some(message => message.type === 'AGENT_CAPTURE'));
  const request = value.events.find(message => message.type === 'AGENT_CAPTURE');
  assert.equal(request.documentId, 'doc-one');
  assert.equal(request.expectedUrl, observation.url);
  assert.equal(request.snapshotId, observation.snapshotId);
  const requestsBeforeStop = value.models.length;
  await value.slot.stop();
  capture.resolve({ ok: true, url: observation.url, documentId: 'doc-one', snapshotId: observation.snapshotId, dataUrl: 'data:image/jpeg;base64,PRIVATE_SCREEN' });
  await tick();
  assert.equal(value.models.length, requestsBeforeStop);
  assert.equal(value.slot.getTask().status, 'cancelled');
});

test('fresh state verification resolves a delayed selection without replaying the write', { timeout: 3000 }, async t => {
  let decisions = 0, observes = 0;
  const ended = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000, action: 1000 }, end: turn => ended.resolve(turn),
    fetch: () => decisionResponse(++decisions === 1
      ? { action: 'select_option', args: { elementId: 'e1', value: '2.6' } }
      : decisions === 2 ? { action: 'verify_state', args: { elementId: 'e1', field: 'selectedValue', expected: '2.6' } }
        : { action: 'finish_task', args: { summary: '选项已核对' } }),
    send: message => message.type === 'AGENT_OBSERVE' ? { ...observation, documentId: 'doc-current', snapshotId: `s${++observes}`,
      elements: [{ id: 'e1', stableKey: 'model', tag: 'select', role: 'combobox', name: 'Model',
        select: { selected: [{ value: observes >= 3 ? '2.6' : '2.5', text: observes >= 3 ? '2.6' : '2.5' }] } }] } : undefined,
  });
  await value.slot.start('选择2.6');
  assert.equal((await ended.promise).status, 'finished');
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 1);
  assert.equal(observes, 3);
});

test('resume retains the actual document failure history when no starting document was supplied', { timeout: 3000 }, async t => {
  let decisions = 0;
  const ended = deferred();
  const value = fixture(t, {
    timeouts: { model: 1000, observe: 1000 }, end: turn => ended.resolve(turn),
    fetch: () => decisionResponse(++decisions === 2
      ? { action: 'request_human_handoff', args: { reason: '检查页面' } }
      : { action: 'select_option', args: { elementId: 'e1', value: '2.6' } }),
    send: message => message.type === 'AGENT_OBSERVE'
      ? { ...observation, documentId: 'doc-current', elements: [{ id: 'e1', stableKey: 'model', tag: 'select', role: 'combobox', name: 'Model' }] }
      : message.type === 'AGENT_ACT' ? { error: 'ERR_ELEMENT_CHANGED', diagnostics: { failureStage: 'element-signature', executionStatus: 'not-started' } } : undefined,
  });
  await value.slot.start('选择2.6');
  await until(() => value.slot.getTask().status === 'paused');
  await until(() => !value.slot.isBusy());
  await value.slot.resume();
  assert.equal((await ended.promise).status, 'failed');
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 3);
  assert.equal(value.slot.getTask().progress.scope.documentId, 'doc-current');
});

test('page mode must be enabled before Agent mode or a task can start', async t => {
  let pageEnabled = false;
  let queried = 0;
  const value = fixture(t, { getPageModeEnabled: () => pageEnabled, query: async () => { queried++; return { id: 1, url: observation.url }; } });
  value.slot.setMode(true);
  assert.equal(value.slot.isMode(), false);
  value.slot.toggleMode();
  assert.equal(value.slot.isMode(), false);
  assert.equal(await value.slot.start('页面操作需要先开启页面模式'), false);
  assert.equal(value.slot.getTask(), null);
  assert.equal(queried, 0);
  assert.equal(value.turns.length, 0);
  assert.equal(value.events.length, 0);
  assert.equal(value.models.length, 0);
  pageEnabled = true;
  value.slot.setMode(true);
  assert.equal(value.slot.isMode(), true);
});

test('Agent diagnostics retain action failures and terminal counts without task or input contents', async t => {
  // This verifies diagnostic ownership/counts, not timeout handling. Keep both
  // timer callbacks and deadline reads independent of parallel-suite load.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-06T00:00:00Z').getTime() });
  const decisionEntered = deferred(), releaseDecision = deferred(), ended = deferred();
  let decisions = 0;
  let currentConversation = 'conversation-original';
  const value = fixture(t, {
    getDiagnosticContext: () => ({ conversationId: currentConversation, turnId: 'turn-original' }),
    fetch: async () => {
      if (++decisions === 1) { decisionEntered.resolve(); await releaseDecision.promise; }
      return decisionResponse({ action: 'type_text', args: { elementId: 'e1', text: 'PRIVATE_INPUT_BODY' } });
    },
    end: turn => ended.resolve(turn),
    send: message => message.type === 'AGENT_OBSERVE' ? { ...observation, elements: [{ id: 'e1', tag: 'input', role: 'textbox', name: 'Field', type: 'text' }] }
      : message.type === 'AGENT_ACT' ? { error: 'ERR_ACTION_FAILED', message: 'PRIVATE_ERROR_BODY', diagnostics: { failureStage: 'check' } } : undefined,
  });
  assert.equal(await value.slot.start('PRIVATE_TASK_GOAL'), true);
  await decisionEntered.promise;
  currentConversation = 'conversation-new';
  releaseDecision.resolve();
  const completed = await ended.promise;
  await value.slot.getTask().finalization;
  assert.equal(completed.status, 'failed');
  const failed = value.diagnostics.filter(entry => entry.event === 'agent.action.failed');
  assert.equal(failed.length, 3);
  assert.ok(failed.every(entry => entry.context.conversationId === 'conversation-original' && entry.context.turnId === 'turn-original'));
  assert.ok(failed.every(entry => entry.context.taskId === value.slot.getTask().id && entry.context.actionId));
  const stopped = value.diagnostics.find(entry => entry.event === 'agent.task.stopped');
  assert.equal(stopped.data.errorCount, 3);
  assert.equal(stopped.error.reason, 'error-limit');
  assert.ok(value.diagnostics.some(entry => entry.event === 'agent.decision.completed' && entry.data.action === 'type_text'));
  assert.doesNotMatch(JSON.stringify(value.diagnostics), /PRIVATE_|Page contents|allowed\.test/);
});

test('cancelled Agent action diagnostics stay with the old owner and ignore its late success', async t => {
  const action = deferred();
  const value = fixture(t, {
    fetch: () => decisionResponse({ action: 'click_element', args: { elementId: 'e1' } }),
    send: message => message.type === 'AGENT_OBSERVE' ? { ...observation, elements: [{ id: 'e1', tag: 'button', role: 'button', name: 'Open', type: 'button' }] }
      : message.type === 'AGENT_ACT' ? action.promise : undefined,
    timeouts: { action: 500 },
    recordDiagnostic: () => Promise.reject(new Error('PRIVATE_LOG_ERROR')),
  });
  await value.slot.start('PRIVATE_TASK_GOAL');
  await until(() => value.events.some(event => event.type === 'AGENT_ACT'));
  const taskId = value.slot.getTask().id;
  await value.slot.stop();
  action.resolve({ ok: true, message: 'PRIVATE_LATE_RESULT' });
  await tick();
  assert.equal(value.slot.getTask().status, 'cancelled');
  assert.ok(value.diagnostics.some(entry => entry.event === 'agent.action.started'));
  assert.equal(value.diagnostics.some(entry => entry.event === 'agent.action.completed'), false);
  assert.ok(value.diagnostics.every(entry => entry.context.taskId === taskId));
  assert.doesNotMatch(JSON.stringify(value.diagnostics), /PRIVATE_/);
});

test('disabling page mode during preparation cancels the fixed task before activation', async t => {
  let pageEnabled = true;
  const saving = deferred();
  const value = fixture(t, { getPageModeEnabled: () => pageEnabled, begin: () => saving.promise, timeouts: { preparation: 500 } });
  const starting = value.slot.start('准备中的页面任务');
  await until(() => value.turns.some(turn => turn.kind === 'begin'));
  const task = value.slot.getTask();
  pageEnabled = false;
  saving.resolve();
  assert.equal(await starting, false);
  await task.finalization;
  assert.equal(task.status, 'cancelled');
  assert.match(task.result, /基于当前页/);
  assert.equal(value.turns.find(turn => turn.kind === 'begin').options.signal.aborted, true);
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
  assert.equal(value.events.some(message => message.type === 'AGENT_CANCEL' && message.taskId === task.id), true);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
  assert.equal(value.models.length, 0);
});

test('a late Agent decision cannot act after page mode was disabled', async t => {
  let pageEnabled = true;
  const decision = deferred();
  const value = fixture(t, {
    getPageModeEnabled: () => pageEnabled,
    fetch: () => decision.promise,
    timeouts: { model: 500 },
  });
  assert.equal(await value.slot.start('点击页面中的按钮'), true);
  await until(() => value.models.length === 1);
  const task = value.slot.getTask();
  pageEnabled = false;
  decision.resolve(decisionResponse({ action: 'click', args: { elementId: 'e1' } }));
  await until(() => task.status === 'cancelled');
  await task.finalization;
  assert.equal(value.events.some(message => message.type === 'AGENT_ACT'), false);
  assert.equal(value.events.some(message => message.type === 'AGENT_CANCEL' && message.taskId === task.id), true);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
  assert.equal(value.models.length, 1);
});

test('paused Agent tasks cannot resume or activate a tab until page mode is enabled', async t => {
  let pageEnabled = false;
  const value = fixture(t, { getPageModeEnabled: () => pageEnabled, stored: { agentTask: {
    id: 'page-mode-checkpoint', goal: '继续原页面任务', tabId: 1, origin: 'https://allowed.test',
    status: 'running', startedAt: '2026-11-02', steps: [], maxSteps: 20, step: 0,
  } } });
  await value.slot.restore();
  const task = value.slot.getTask();
  assert.equal(task.status, 'paused');
  await value.slot.resume();
  assert.equal(task.status, 'paused');
  assert.equal(value.tabUpdates.length, 0);
  assert.equal(value.events.some(message => message.type === 'AGENT_RESUME'), false);
  assert.equal(value.models.length, 0);
  pageEnabled = true;
  await value.slot.resume();
  await until(() => task.status === 'finished');
  await task.finalization;
  assert.equal(value.events.filter(message => message.type === 'AGENT_RESUME').length, 1);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
});

test('Agent sends fixed reference images through the gateway and completes one main turn', { timeout: 2000 }, async t => {
  const beginSaved = deferred();
  const seen = [];
  const gateway = createModelGateway({ transport: async input => {
    seen.push(input);
    return { kind: 'tool', name: 'finish_task', args: { summary: '已看图完成' } };
  } });
  const value = fixture(t, { begin: () => beginSaved.promise, profile: { supportsVision: true }, modelGateway: gateway, timeouts: { preparation: 500 } });
  const image = { id: 'image', type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=', width: 800, height: 600 };
  const starting = value.slot.start('读取图中区域', { referenceImages: [image] });
  await until(() => value.turns.some(turn => turn.kind === 'begin'));
  image.dataUrl = 'data:image/png;base64,Y2hhbmdlZA==';
  beginSaved.resolve();
  assert.equal(await starting, true);
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  const images = seen[0].request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url');
  assert.equal(images[0]?.image_url.url, 'data:image/png;base64,aGVsbG8=');
  assert.equal(seen[0].purpose, 'agent-decision');
  assert.equal(value.turns.filter(turn => turn.kind === 'begin').length, 1);
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
  assert.ok(value.slot.getTask().metrics.some(metric => metric.phase === 'model' && metric.inputTokens > 0));
});

test('a nonvisual Agent profile rejects required pictures without browser actions or model calls', async t => {
  const value = fixture(t);
  const started = await value.slot.start('看图操作', { referenceImages: [{ type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=' }] });
  assert.equal(started, false);
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
  assert.equal(value.models.length, 0);
});

test('a screenshot from a previous document is rejected before Agent activation', async t => {
  const value = fixture(t, { profile: { supportsVision: true } });
  const started = await value.slot.start('看图操作', { target: { id: 1, url: observation.url, documentId: 'new-document' }, referenceImages: [{ type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=', capture: { version: 1, tabId: 1, url: observation.url, documentId: 'old-document', capturedAt: '2026-11-02', image: { width: 800, height: 600 } } }] });
  assert.equal(started, false);
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
  assert.equal(value.models.length, 0);
});

test('read_region reaches a local ranking and one final response without rescanning the unchanged page', { timeout: 2000 }, async t => {
  const seen = [];
  const gateway = createModelGateway({ transport: async input => {
    seen.push(input);
    return seen.length === 1
      ? { kind: 'tool', name: 'read_region', args: { elementId: 'e3', query: '缓存命中率' } }
      : { kind: 'tool', name: 'finish_task', args: { summary: 'B 的缓存命中率最高。' } };
  } });
  const value = fixture(t, { modelGateway: gateway, send: message => {
    if (message.type === 'AGENT_OBSERVE') return { ...observation, elements: [{ id: 'e3', name: '商家列表', readable: true, readOnly: true }] };
    if (message.type === 'AGENT_READ_REGION') return { ok: true, regionReading: { url: observation.url, title: '商家列表', capturedAt: '2026-11-02', regionId: 'e3', regionKey: 'list', query: message.query, text: '', totalRows: 2, rows: [
      { label: 'A', text: 'A 缓存命中率 85%', cells: [{ label: '缓存命中率', text: '85%' }] },
      { label: 'B', text: 'B 缓存命中率 96%', cells: [{ label: '缓存命中率', text: '96%' }] },
    ] }, metrics: { readMs: 2 } };
  } });
  assert.equal(await value.slot.start('商家缓存命中率排名'), true);
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  const request = value.events.find(message => message.type === 'AGENT_READ_REGION');
  assert.equal(request.snapshotId, observation.snapshotId);
  assert.equal(request.expectedUrl, observation.url);
  assert.equal(request.elementId, 'e3');
  assert.equal(value.events.filter(message => message.type === 'AGENT_OBSERVE').length, 1);
  const prompt = seen[1].request.messages[1].content;
  const payload = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(payload.region_data.groups[0].rankings[0].highest[0].label, 'B');
  assert.equal(value.turns.filter(turn => turn.kind === 'end').length, 1);
  assert.equal(value.turns.find(turn => turn.kind === 'end').turn.sources[0].url, observation.url);
  assert.match(value.slot.getTask().result, /读取来源/);
});

test('stopping a region read prevents its late rows or metrics from reaching the next decision', async t => {
  const pending = deferred();
  let decisions = 0;
  const gateway = createModelGateway({ transport: async () => { decisions++; return { kind: 'tool', name: 'read_region', args: { elementId: 'e3', query: '缓存命中率' } }; } });
  const value = fixture(t, { modelGateway: gateway, send: message => message.type === 'AGENT_READ_REGION' ? pending.promise : undefined });
  await value.slot.start('读取列表');
  await until(() => value.events.some(message => message.type === 'AGENT_READ_REGION'));
  await value.slot.stop();
  pending.resolve({ ok: true, regionReading: { url: observation.url, regionKey: 'list', text: '', rows: [{ label: '迟到', text: '缓存命中率 99%' }] } });
  await tick();
  assert.equal(decisions, 1);
  assert.deepEqual(value.slot.getTask().regionReadings, []);
  assert.equal(value.slot.getTask().metrics.some(metric => metric.phase === 'region'), false);
});

test('a region response from another page pauses before using its rows', async t => {
  const gateway = createModelGateway({ transport: async () => ({ kind: 'tool', name: 'read_region', args: { elementId: 'e3', query: '缓存命中率' } }) });
  const value = fixture(t, { modelGateway: gateway, send: message => message.type === 'AGENT_READ_REGION' ? { ok: true, regionReading: { url: 'https://other.test/', regionKey: 'list', text: '错误页面', rows: [] } } : undefined });
  await value.slot.start('读取列表');
  await until(() => value.slot.getTask().status === 'paused');
  assert.deepEqual(value.slot.getTask().regionReadings, []);
});

test('an unchanged region reread ignores capture timestamps when reporting repeated data', async t => {
  const seen = [];
  let reads = 0;
  const gateway = createModelGateway({ transport: async input => {
    seen.push(input);
    return seen.length <= 2 ? { kind: 'tool', name: 'read_region', args: { elementId: 'e3', query: '缓存命中率' } }
      : { kind: 'tool', name: 'finish_task', args: { summary: '无需重复读取' } };
  } });
  const value = fixture(t, { modelGateway: gateway, send: message => message.type === 'AGENT_READ_REGION'
    ? { ok: true, regionReading: { url: observation.url, regionKey: 'list', capturedAt: `2026-11-02T08:00:0${++reads}Z`, text: '', totalRows: 1,
      rows: [{ label: 'A', text: '缓存命中率 90%' }] } } : undefined });
  await value.slot.start('读一次列表');
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  assert.match(seen[2].request.messages[1].content, /与上次相同/);
  assert.equal(value.slot.getTask().regionReadings.length, 1);
});

test('a restored checkpoint with missing region rows cannot resume a partial ranking', async t => {
  const value = fixture(t, { stored: { agentTask: { id: 'region-checkpoint', goal: '跨页排名', tabId: 1,
    origin: 'https://allowed.test', status: 'running', startedAt: '2026-11-02', steps: [], maxSteps: 20, step: 3,
    regionReadingCount: 3, facts: [{ text: '旧摘要 99%', source: observation.url }] } } });
  await value.slot.restore();
  await value.slot.resume();
  assert.equal(value.slot.getTask().status, 'failed');
  assert.match(value.slot.getTask().result, /区域数据|重新开始/);
  assert.equal(value.events.some(message => message.type === 'AGENT_RESUME'), false);
  assert.equal(value.models.length, 0);
});

test('site approval remains manual, then a hung first observation reports its real stage and stops without model calls', { timeout: 2000 }, async t => {
  const pendingRead = deferred();
  const value = fixture(t, { authorized: false, send: message => message.type === 'AGENT_OBSERVE' ? pendingRead.promise : undefined });
  const starting = value.slot.start('Read this page');
  const interaction = value.elements.get('#agent-interaction');
  await until(() => interaction.innerHTML.includes('允许控制'));
  await sleep(45);
  assert.equal(value.slot.getTask().phase, 'wait');
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
  interaction.choose(0);
  assert.equal(await starting, true);
  await until(() => value.events.some(message => message.type === 'AGENT_OBSERVE'));
  assert.equal(value.slot.getTask().step, 1);
  assert.match(value.elements.get('#agent-status').innerHTML, /正在读取页面/);
  await until(() => value.slot.getTask().status === 'failed');
  await value.slot.getTask().finalization;
  assert.equal(value.slot.isBusy(), false);
  assert.match(value.turns.find(turn => turn.kind === 'end').turn.result, /读取页面超时/);
  assert.equal(value.models.length, 0);
  assert.equal(value.events.some(message => message.type === 'AGENT_PAGE_EVIDENCE'), false);
  pendingRead.resolve(observation);
  await tick();
  assert.equal(value.models.length, 0);
});

test('activation timeout stops preparation and ignores a late backend acknowledgement', { timeout: 2000 }, async t => {
  const activation = deferred();
  const value = fixture(t, { send: message => message.type === 'AGENT_START' ? activation.promise : undefined });
  const starting = value.slot.start('Activate');
  await until(() => value.events.some(message => message.type === 'AGENT_START'));
  assert.match(value.elements.get('#agent-status').innerHTML, /正在启动页面控制/);
  assert.equal(await starting, false);
  assert.equal(value.slot.getTask().status, 'failed');
  assert.match(value.slot.getTask().result, /启动页面控制.*超时/);
  activation.resolve({ ok: true });
  await tick();
  assert.equal(value.events.some(message => message.type === 'AGENT_OBSERVE'), false);
  assert.equal(value.models.length, 0);
});

test('stopping a hung beginTurn aborts its signal and prevents late permissions or activation', { timeout: 2000 }, async t => {
  const begun = deferred();
  const value = fixture(t, { begin: () => begun.promise });
  const starting = value.slot.start('Save first');
  await until(() => value.turns.some(turn => turn.kind === 'begin'));
  assert.match(value.elements.get('#agent-status').innerHTML, /正在保存任务/);
  const stopped = value.slot.stop();
  assert.equal(value.slot.isBusy(), false);
  assert.equal(await starting, false);
  await stopped;
  assert.equal(value.turns.find(turn => turn.kind === 'begin').options.signal.aborted, true);
  begun.resolve();
  await tick();
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
});

test('a stalled best-effort checkpoint cannot block the observation or its terminal record', { timeout: 2000 }, async t => {
  const checkpoint = deferred();
  const value = fixture(t, { set: (record, base) => Object.keys(record).some(key => key.startsWith('agentTask:') && !key.startsWith('agentTask:ended:')) ? checkpoint.promise : base.set(record) });
  assert.equal(await value.slot.start('Read despite checkpoint delay'), true);
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  assert.equal(value.models.length, 1);
  assert.ok(value.data[`agentTask:ended:${value.slot.getTask().id}`]);
  checkpoint.resolve();
});

test('stop releases local execution immediately even if cancellation, storage, release and endTurn never respond', { timeout: 2000 }, async t => {
  const forever = deferred();
  const value = fixture(t, {
    send: message => ['AGENT_OBSERVE', 'AGENT_CANCEL', 'AGENT_RELEASE'].includes(message.type) ? forever.promise : undefined,
    end: () => forever.promise,
    remove: () => forever.promise,
  });
  await value.slot.start('Stop promptly');
  await until(() => value.events.some(message => message.type === 'AGENT_OBSERVE'));
  const stopping = value.slot.stop();
  assert.equal(value.slot.isBusy(), false);
  assert.equal(value.slot.getTask().status, 'cancelled');
  await stopping;
  assert.equal(value.slot.isMode(), false);
  assert.equal(value.models.length, 0);
  forever.resolve({ ok: true });
  await tick();
  assert.equal(value.models.length, 0);
});

test('old task cleanup and late observation cannot release a newer task or erase its checkpoint', { timeout: 2000 }, async t => {
  const firstRead = deferred();
  const secondRead = deferred();
  const removal = deferred();
  let firstId;
  const value = fixture(t, {
    send: message => message.type === 'AGENT_OBSERVE' ? (message.taskId === firstId ? firstRead.promise : secondRead.promise) : undefined,
    remove: async (key, base) => { if (key === `agentTask:${firstId}`) await removal.promise; return base.remove(key); },
  });
  const firstStart = value.slot.start('Old task');
  firstId = value.slot.getTask().id;
  await firstStart;
  await until(() => value.events.some(message => message.type === 'AGENT_OBSERVE' && message.taskId === firstId));
  const oldStop = value.slot.stop();
  assert.equal(await value.slot.start('New task'), true);
  const newTask = value.slot.getTask();
  await until(() => value.events.some(message => message.type === 'AGENT_OBSERVE' && message.taskId === newTask.id));
  firstRead.resolve(observation);
  removal.resolve();
  await oldStop;
  await tick();
  assert.equal(value.slot.getTask(), newTask);
  assert.equal(value.slot.isBusy(), true);
  assert.equal(value.slot.isMode(), true);
  assert.equal(newTask.status, 'running');
  assert.ok(value.data[`agentTask:${newTask.id}`]);
  assert.equal(value.models.length, 0);
  assert.equal(value.turns.filter(turn => turn.kind === 'end')[0].turn.taskId, firstId);
});

test('switching tabs aborts a hung read; resume rereads the original tab and ignores the old result', { timeout: 2000 }, async t => {
  const oldRead = deferred();
  const newRead = deferred();
  let reads = 0;
  const value = fixture(t, { send: message => message.type === 'AGENT_OBSERVE' ? (++reads === 1 ? oldRead.promise : newRead.promise) : undefined });
  await value.slot.start('Stay on the original page');
  await until(() => reads === 1);
  value.activate(2);
  assert.equal(value.slot.getTask().status, 'paused');
  await until(() => !value.slot.isBusy());
  await value.slot.resume();
  await until(() => reads === 2);
  assert.deepEqual(value.tabUpdates.map(update => update.id), [1]);
  assert.ok(value.events.filter(message => message.type === 'AGENT_OBSERVE').every(message => message.tabId === 1));
  oldRead.resolve(observation);
  await tick();
  assert.equal(value.models.length, 0);
  assert.equal(value.slot.getTask().status, 'running');
});

test('switching tabs during a hung model request cancels it and prevents the late action after resume', { timeout: 2000 }, async t => {
  const model = deferred();
  const secondRead = deferred();
  let reads = 0;
  const value = fixture(t, {
    fetch: () => model.promise,
    send: message => message.type === 'AGENT_OBSERVE' && ++reads > 1 ? secondRead.promise : undefined,
  });
  await value.slot.start('Read then decide');
  await until(() => value.models.length === 1);
  value.activate(2);
  assert.equal(value.models[0].request.signal.aborted, true);
  await until(() => !value.slot.isBusy());
  await value.slot.resume();
  await until(() => reads === 2);
  model.resolve(decisionResponse({ action: 'click_element', args: { elementId: 'late-button' } }));
  await tick();
  assert.equal(value.events.some(message => message.type === 'AGENT_ACT'), false);
  assert.equal(value.slot.getTask().status, 'running');
  assert.deepEqual(value.tabUpdates.map(update => update.id), [1]);
});

test('keyboard or wheel takeover pauses with a general manual-operation explanation', { timeout: 2000 }, async t => {
  const read = deferred();
  const value = fixture(t, { send: message => message.type === 'AGENT_OBSERVE' ? read.promise : undefined });
  await value.slot.start('Manual takeover');
  await until(() => value.events.some(message => message.type === 'AGENT_OBSERVE'));
  value.takeover('user-wheel');
  assert.equal(value.slot.getTask().status, 'paused');
  assert.match(value.slot.getTask().pauseReason, /你操作了页面/);
  read.resolve(observation);
  await tick();
  assert.equal(value.models.length, 0);
});

test('restore ignores ended task records and still accepts the legacy checkpoint without replaying actions', { timeout: 2000 }, async t => {
  const record = { id: 'legacy', goal: 'Interrupted', tabId: 1, origin: 'https://allowed.test', status: 'running', startedAt: '2026-10-29', steps: [], maxSteps: 20, step: 1 };
  const value = fixture(t, { stored: {
    agentTask: record,
    'agentTask:new-ended': { ...record, id: 'new-ended', startedAt: '2026-10-30' },
    'agentTask:ended:new-ended': { id: 'new-ended', endedAt: '2026-10-30' },
  } });
  await value.slot.restore();
  assert.equal(value.slot.getTask().id, 'legacy');
  assert.equal(value.slot.getTask().status, 'paused');
  assert.equal(value.events.some(message => ['AGENT_START', 'AGENT_RESUME', 'AGENT_OBSERVE', 'AGENT_ACT'].includes(message.type)), false);
});

test('settings timeout names the settings stage and does not invoke the backend or a model', { timeout: 2000 }, async t => {
  const settings = deferred();
  const value = fixture(t, { get: (key, base) => key === 'agentSettings' ? settings.promise : base.get(key) });
  const starting = value.slot.start('Read settings first');
  await until(() => value.slot.getTask().phase === 'settings');
  assert.match(value.elements.get('#agent-status').innerHTML, /正在读取控制设置/);
  assert.equal(await starting, false);
  assert.match(value.slot.getTask().result, /读取控制设置.*超时/);
  settings.resolve({ agentSettings: { enabled: true } });
  await tick();
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
  assert.equal(value.models.length, 0);
});

test('manual navigation pauses observation but title and favicon updates do not', { timeout: 2000 }, async t => {
  const read = deferred();
  const value = fixture(t, { send: message => message.type === 'AGENT_OBSERVE' ? read.promise : undefined });
  await value.slot.start('Watch this page');
  await until(() => value.events.some(message => message.type === 'AGENT_OBSERVE'));
  value.update(1, { title: 'Updated title', favIconUrl: 'https://allowed.test/icon.png' });
  value.update(1, { url: observation.url });
  value.update(2, { status: 'loading' });
  assert.equal(value.slot.getTask().status, 'running');
  value.update(1, { url: 'https://allowed.test/other' });
  assert.equal(value.slot.getTask().status, 'paused');
  assert.match(value.slot.getTask().pauseReason, /导航或刷新/);
  read.resolve(observation);
  await tick();
  assert.equal(value.models.length, 0);
});

test('a same-URL reload pauses while the model is deciding and blocks its late action', { timeout: 2000 }, async t => {
  const model = deferred();
  const value = fixture(t, { fetch: () => model.promise });
  await value.slot.start('Pause on reload');
  await until(() => value.models.length === 1);
  value.update(1, { status: 'loading' });
  assert.equal(value.slot.getTask().status, 'paused');
  assert.equal(value.models[0].request.signal.aborted, true);
  model.resolve(decisionResponse({ action: 'navigate', args: { url: 'https://allowed.test/other' } }));
  await tick();
  assert.equal(value.events.some(message => message.type === 'AGENT_NAVIGATE'), false);
});

test('agent-owned navigation carries the observed URL and does not pause on its own load events', { timeout: 2000 }, async t => {
  const navigation = deferred();
  const value = fixture(t, {
    fetch: () => decisionResponse({ action: 'navigate', args: { url: 'https://allowed.test/next' } }),
    send: message => message.type === 'AGENT_NAVIGATE' ? navigation.promise : undefined,
  });
  await value.slot.start('Navigate once');
  await until(() => value.events.some(message => message.type === 'AGENT_NAVIGATE'));
  const request = value.events.find(message => message.type === 'AGENT_NAVIGATE');
  assert.equal(request.expectedUrl, observation.url);
  assert.equal(value.slot.getTask().phase, 'act');
  value.update(1, { status: 'loading', url: 'https://allowed.test/next' });
  assert.equal(value.slot.getTask().status, 'running');
  await value.slot.stop();
  navigation.resolve({ ok: true, tabUrl: 'https://allowed.test/next' });
  await tick();
  assert.equal(value.models.length, 1);
});

test('backend page-change rejection pauses instead of retrying an action on the new page', { timeout: 2000 }, async t => {
  const value = fixture(t, {
    fetch: () => decisionResponse({ action: 'navigate', args: { url: 'https://allowed.test/next' } }),
    send: message => message.type === 'AGENT_NAVIGATE' ? { error: 'ERR_PAGE_CHANGED', message: '页面已经变化，请核对后继续。' } : undefined,
  });
  await value.slot.start('Avoid acting on changed pages');
  await until(() => value.slot.getTask().status === 'paused');
  assert.match(value.slot.getTask().pauseReason, /页面已经变化/);
  assert.equal(value.models.length, 1);
  assert.equal(value.events.filter(message => message.type === 'AGENT_NAVIGATE').length, 1);
});

test('action timeout reports an uncertain result and does not retry or request a model summary', { timeout: 2000 }, async t => {
  const navigation = deferred();
  const value = fixture(t, {
    fetch: () => decisionResponse({ action: 'navigate', args: { url: 'https://allowed.test/next' } }),
    send: message => message.type === 'AGENT_NAVIGATE' ? navigation.promise : undefined,
  });
  await value.slot.start('Do not repeat uncertain actions');
  await until(() => value.slot.getTask().status === 'failed');
  await value.slot.getTask().finalization;
  assert.match(value.slot.getTask().result, /执行结果未确认/);
  assert.equal(value.models.length, 1);
  assert.equal(value.events.filter(message => message.type === 'AGENT_NAVIGATE').length, 1);
  assert.equal(value.events.some(message => message.type === 'AGENT_PAGE_EVIDENCE'), false);
  navigation.resolve({ ok: true });
  await tick();
  assert.equal(value.models.length, 1);
});

test('finishing does not request extra evidence or another model summary', { timeout: 2000 }, async t => {
  const evidence = deferred();
  const value = fixture(t, { send: message => message.type === 'AGENT_PAGE_EVIDENCE' ? evidence.promise : undefined });
  await value.slot.start('Finish with bounded evidence');
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  assert.equal(value.models.length, 1);
  assert.equal(value.events.some(message => message.type === 'AGENT_PAGE_EVIDENCE'), false);
  assert.equal(value.turns.find(turn => turn.kind === 'end').turn.result, 'Done');
  assert.equal(value.slot.isBusy(), false);
  evidence.resolve({ text: 'Late page text', url: observation.url });
  await tick();
  assert.equal(value.models.length, 1);
});

test('terminal checkpoint history is bounded while preserving the current task marker', { timeout: 2000 }, async t => {
  const stored = {};
  for (let index = 0; index < 15; index += 1) {
    stored[`agentTask:old-${index}`] = { id: `old-${index}`, goal: 'Old', status: 'running' };
    stored[`agentTask:ended:old-${index}`] = { id: `old-${index}`, endedAt: `2020-01-${String(index + 1).padStart(2, '0')}` };
  }
  const read = deferred();
  const value = fixture(t, { stored, send: message => message.type === 'AGENT_OBSERVE' ? read.promise : undefined });
  await value.slot.start('Retain bounded history');
  const id = value.slot.getTask().id;
  await value.slot.stop();
  assert.ok(value.data[`agentTask:ended:${id}`]);
  assert.equal(Object.keys(value.data).filter(key => key.startsWith('agentTask:ended:')).length, 10);
  assert.equal(value.data['agentTask:old-0'], undefined);
});

test('read_page supplies the complete bounded body to the next decision and completes with source metadata', { timeout: 2000 }, async t => {
  const body = 'Article body '.repeat(450) + 'SECTION_FACT: 第三章的关键结论。';
  let decisions = 0;
  const value = fixture(t, {
    fetch: (_url, request) => {
      decisions += 1;
      const messages = JSON.parse(request.body).messages;
      if (decisions === 1) return decisionResponse({ action: 'read_page', args: { query: '第三章' } });
      assert.match(JSON.stringify(messages), /SECTION_FACT/);
      return decisionResponse({ action: 'finish_task', args: { summary: '第三章的关键结论。' } });
    },
    send: message => message.type === 'AGENT_READ_PAGE' ? { ok: true, url: observation.url, title: 'Third chapter', text: body, capturedAt: '2026-10-30T10:00:00Z', truncated: false } : undefined,
  });
  await value.slot.start('Find the third chapter and summarize');
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  const read = value.events.find(message => message.type === 'AGENT_READ_PAGE');
  assert.equal(read.query, '第三章');
  assert.equal(read.expectedUrl, observation.url);
  assert.equal(read.snapshotId, observation.snapshotId);
  assert.equal(read.taskId, value.slot.getTask().id);
  assert.equal(value.events.filter(message => message.type === 'AGENT_OBSERVE').length, 1);
  assert.equal(value.events.some(message => ['AGENT_ACT', 'AGENT_NAVIGATE', 'AGENT_PAGE_EVIDENCE'].includes(message.type)), false);
  assert.equal(value.models.length, 2, 'only the read decision and final answer are needed');
  const final = value.turns.find(turn => turn.kind === 'end').turn;
  assert.match(final.result, /关键结论/);
  assert.match(final.result, /https:\/\/allowed.test\/app/);
  assert.deepEqual(final.sources, [{ url: observation.url, title: 'Third chapter', capturedAt: '2026-10-30T10:00:00Z', truncated: false }]);
  assert.doesNotMatch(JSON.stringify(final.sources), /SECTION_FACT/);
});

test('an insufficient agent context fails explicitly before any model request or retry', { timeout: 2000 }, async t => {
  const value = fixture(t, { profile: { contextLength: 256 } });
  assert.equal(await value.slot.start('保留这个任务目标'), true);
  await until(() => value.slot.getTask().status === 'failed');
  await value.slot.getTask().finalization;
  assert.equal(value.models.length, 0);
  assert.match(value.slot.getTask().result, /上下文容量.*基础指令/);
  assert.match(value.turns.find(turn => turn.kind === 'end').turn.result, /切换更大上下文模型/);
});

test('small-context agent requests fit Chinese bodies and retry messages while retaining source evidence', { timeout: 3000 }, async t => {
  const body = '中文正文内容和引用证据。'.repeat(1000).slice(0, 10000);
  const goal = '总结第三章并说明出处';
  const element = { id: 'e1', role: 'link', name: '第三章', href: `${observation.url}#third` };
  const payloads = [];
  const value = fixture(t, {
    profile: { contextLength: 8000, maxTokens: 100 },
    timeouts: { model: 500, preparation: 100 },
    fetch: (_url, request) => {
      const sent = JSON.parse(request.body);
      const payload = JSON.parse(sent.messages[1].content.slice(sent.messages[1].content.indexOf('{')));
      payloads.push(payload);
      assert.equal(sent.max_tokens, 1200, 'the budget must follow the actual fixed Agent output limit');
      assert.ok(estimateMessagesTokens(sent.messages) + estimateTextTokens(JSON.stringify(sent.tools)) + sent.max_tokens <= 7200);
      assert.equal(payload.goal, goal);
      assert.equal(payload.elements[0].id, element.id);
      assert.equal(payload.elements[0].href, element.href);
      if (payloads.length === 1) return decisionResponse({ action: 'read_page', args: { query: '第三章' } });
      assert.equal(payload.page_readings[0].truncated, true);
      assert.ok(payload.page_readings[0].text.length > 0 && payload.page_readings[0].text.length < body.length);
      assert.equal(payload.page_readings[0].url, observation.url);
      if (payloads.length === 2) return Response.json({ choices: [{ message: { content: '不是合法动作' } }] });
      assert.match(sent.messages.at(-1).content, /上一次输出不是有效动作/);
      return decisionResponse({ action: 'finish_task', args: { summary: '已总结所提供的第三章内容。' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? { ...observation, elements: [element] }
      : message.type === 'AGENT_READ_PAGE' ? { ok: true, url: observation.url, title: '第三章', text: body, truncated: false } : undefined,
  });
  await value.slot.start(goal);
  await until(() => value.slot.getTask().status === 'finished', 1500);
  await value.slot.getTask().finalization;
  assert.equal(value.models.length, 3);
  assert.ok(payloads[2].page_readings[0].text.length < payloads[1].page_readings[0].text.length);
  assert.equal(value.slot.getTask().pageReadings[0].text, body, 'task evidence remains reusable after a request is trimmed');
});

test('read_page timeout ends the task without a late body or extra decision', { timeout: 2000 }, async t => {
  const body = deferred();
  const value = fixture(t, {
    fetch: () => decisionResponse({ action: 'read_page', args: {} }),
    send: message => message.type === 'AGENT_READ_PAGE' ? body.promise : undefined,
  });
  await value.slot.start('Read a stalled page');
  await until(() => value.events.some(message => message.type === 'AGENT_READ_PAGE'));
  assert.match(value.elements.get('#agent-status').innerHTML, /读取页面正文/);
  await until(() => value.slot.getTask().status === 'failed');
  await value.slot.getTask().finalization;
  assert.match(value.slot.getTask().result, /读取页面正文超时/);
  body.resolve({ ok: true, url: observation.url, text: 'LATE_BODY' });
  await tick();
  assert.equal(value.models.length, 1);
  assert.equal(value.slot.getTask().pageReadings.length, 0);
});

test('manual takeover while reading a body prevents a late reading from entering model context', { timeout: 2000 }, async t => {
  const body = deferred();
  const value = fixture(t, {
    fetch: () => decisionResponse({ action: 'read_page' }),
    send: message => message.type === 'AGENT_READ_PAGE' ? body.promise : undefined,
  });
  await value.slot.start('Read then allow takeover');
  await until(() => value.events.some(message => message.type === 'AGENT_READ_PAGE'));
  value.takeover('user-typed-page');
  assert.equal(value.slot.getTask().status, 'paused');
  body.resolve({ ok: true, url: observation.url, text: 'LATE_BODY' });
  await tick();
  assert.equal(value.models.length, 1);
  assert.equal(value.slot.getTask().pageReadings.length, 0);
});

test('read_page refuses a body from a different URL and pauses before the next model decision', { timeout: 2000 }, async t => {
  const value = fixture(t, {
    fetch: () => decisionResponse({ action: 'read_page' }),
    send: message => message.type === 'AGENT_READ_PAGE' ? { ok: true, url: 'https://other.test', text: 'OTHER_PAGE_BODY' } : undefined,
  });
  await value.slot.start('Do not mix page sources');
  await until(() => value.slot.getTask().status === 'paused');
  assert.match(value.slot.getTask().pauseReason, /来源与当前观察不同/);
  assert.equal(value.models.length, 1);
  assert.equal(value.slot.getTask().pageReadings.length, 0);
});

test('a backend body-read deadline ends the task without asking the model to retry', { timeout: 2000 }, async t => {
  const value = fixture(t, {
    fetch: () => decisionResponse({ action: 'read_page' }),
    send: message => message.type === 'AGENT_READ_PAGE' ? { error: 'ERR_PAGE_READ_TIMEOUT', message: '正文读取超时，请重试。' } : undefined,
  });
  await value.slot.start('Stop at the backend deadline');
  await until(() => value.slot.getTask().status === 'failed');
  await value.slot.getTask().finalization;
  assert.equal(value.models.length, 1);
  assert.equal(value.events.filter(message => message.type === 'AGENT_READ_PAGE').length, 1);
  assert.match(value.slot.getTask().result, /正文读取超时/);
});

test('an expired reading snapshot is replaced by a fresh observation before another body read', { timeout: 2000 }, async t => {
  let observations = 0;
  let reads = 0;
  let decisions = 0;
  const value = fixture(t, {
    fetch: () => decisionResponse(++decisions <= 2 ? { action: 'read_page' } : { action: 'finish_task', args: { summary: 'Read fresh snapshot' } }),
    send: message => {
      if (message.type === 'AGENT_OBSERVE') return { ...observation, snapshotId: `snapshot-${++observations}` };
      if (message.type === 'AGENT_READ_PAGE') return ++reads === 1
        ? { error: 'ERR_SNAPSHOT_EXPIRED', message: '快照已过期，请重新观察。' }
        : { ok: true, url: observation.url, text: 'Fresh readable content' };
    },
  });
  await value.slot.start('Refresh stale reading snapshot');
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  assert.deepEqual(value.events.filter(message => message.type === 'AGENT_READ_PAGE').map(message => message.snapshotId), ['snapshot-1', 'snapshot-2']);
  assert.equal(observations, 2);
  assert.equal(value.models.length, 3);
});

test('an explicit starting target must still be the active tab with the same complete URL', { timeout: 2000 }, async t => {
  const value = fixture(t, { query: async () => ({ id: 2, url: observation.url }) });
  assert.equal(await value.slot.start('Pinned task', { target: { id: 1, url: observation.url } }), false);
  assert.match(value.slot.getTask().result, /当前标签页已变化/);
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
  assert.equal(value.models.length, 0);
});

test('a page changed during permission setup is caught again before activation', { timeout: 2000 }, async t => {
  let calls = 0;
  const value = fixture(t, { query: async () => ({ id: 1, url: ++calls === 1 ? observation.url : `${observation.url}#changed` }) });
  assert.equal(await value.slot.start('Keep original URL', { target: { id: 1, url: observation.url } }), false);
  assert.match(value.slot.getTask().result, /授权期间页面已变化/);
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
});

test('switching tabs while site approval is pending ends preparation without activating a task', { timeout: 2000 }, async t => {
  const value = fixture(t, { authorized: false });
  const starting = value.slot.start('Wait for permission', { target: { id: 1, url: observation.url } });
  await until(() => value.elements.get('#agent-interaction').innerHTML.includes('允许控制'));
  value.activate(2);
  assert.equal(await starting, false);
  assert.equal(value.slot.getTask().status, 'cancelled');
  await value.slot.getTask().finalization;
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
});

test('successive scrolling with visible progress is not rejected as a repeated-action loop', { timeout: 2500 }, async t => {
  let observations = 0;
  let decisions = 0;
  const payloads = [];
  const value = fixture(t, {
    fetch: (_url, request) => {
      decisions += 1;
      const messages = JSON.parse(request.body).messages;
      payloads.push(JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{'))));
      return decisionResponse(decisions <= 3 ? { action: 'scroll_page', args: { direction: 'down' } } : { action: 'finish_task', args: { summary: 'Reached the section' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? { ...observation, scrollY: observations++ * 800 } : undefined,
  });
  await value.slot.start('Scroll through a long page');
  await until(() => value.slot.getTask().status === 'finished', 1500);
  await value.slot.getTask().finalization;
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 3);
  assert.equal(value.slot.getTask().steps.some(step => /重复动作/.test(step.title)), false);
  assert.match(payloads[1].recent.at(-1).observation_feedback, /滚动位置有变化/);
});

test('unchanged observations produce a conservative warning and favor a body read over repeated clicks', { timeout: 2500 }, async t => {
  let decisions = 0;
  const button = { id: 'e1', role: 'button', tag: 'button', name: 'Open section', disabled: false };
  const value = fixture(t, {
    fetch: () => {
      decisions += 1;
      if (decisions <= 3) return decisionResponse({ action: 'click_element', args: { elementId: 'e1' } });
      if (decisions === 4) return decisionResponse({ action: 'read_page' });
      return decisionResponse({ action: 'finish_task', args: { summary: 'Read the already available section' } });
    },
    send: message => message.type === 'AGENT_OBSERVE' ? { ...observation, elements: [button] }
      : message.type === 'AGENT_READ_PAGE' ? { ok: true, url: observation.url, title: 'Section', text: 'The section was already readable.' } : undefined,
  });
  await value.slot.start('Avoid repeated clicks');
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  assert.equal(value.events.filter(message => message.type === 'AGENT_ACT').length, 2);
  assert.equal(value.events.filter(message => message.type === 'AGENT_READ_PAGE').length, 1);
  assert.ok(value.slot.getTask().steps.some(step => step.title === '重复动作尚未确认可见变化'));
  assert.equal(value.models.length, 5);
});

test('a live task keeps its initial model and budget across a pause and resume', { timeout: 2000 }, async t => {
  const selected = { model: 'original-model', contextLength: 128000 };
  let calls = 0;
  const value = fixture(t, {
    profile: () => selected,
    fetch: () => decisionResponse(++calls === 1
      ? { action: 'request_human_handoff', args: { reason: 'Inspect the page' } }
      : { action: 'finish_task', args: { summary: 'Finished with original model' } }),
  });
  await value.slot.start('Keep the submitted configuration');
  await until(() => value.slot.getTask().status === 'paused');
  selected.model = 'changed-model'; selected.contextLength = 256;
  await value.slot.resume();
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  assert.deepEqual(value.models.map(item => JSON.parse(item.request.body).model), ['original-model', 'original-model']);
  assert.equal(value.turns.find(turn => turn.kind === 'begin').turn.model, 'original-model');
  assert.doesNotMatch(JSON.stringify(value.slot.getTask()), /test-only|apiKey/);
});

test('Agent decision repairs use distinct gateway request ids within one frozen run', { timeout: 2000 }, async t => {
  const gateway = createModelGateway();
  const runs = []; const requests = [];
  let calls = 0;
  const value = fixture(t, {
    modelGateway: { createRun(options) {
      runs.push(options.runId);
      const run = gateway.createRun(options);
      return { ...run, request(request) { requests.push(request); return run.request(request); } };
    } },
    fetch: () => ++calls === 1 ? Response.json({ choices: [{ message: { content: 'Malformed action' } }] })
      : decisionResponse({ action: 'finish_task', args: { summary: 'Repaired action' } }),
  });
  await value.slot.start('Repair one malformed decision');
  await until(() => value.slot.getTask().status === 'finished');
  await value.slot.getTask().finalization;
  assert.equal(runs.length, 1);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.match(requests[0].requestId, /step-1.*attempt-0/);
  assert.match(requests[1].requestId, /attempt-1/);
  assert.ok(requests.every(request => request.purpose === 'agent-decision' && request.maxTokens === 1200));
});

test('an Agent transport failure is reported without a second malformed-action retry', { timeout: 2000 }, async t => {
  const value = fixture(t, { fetch: () => new Response('Unauthorized', { status: 401 }) });
  await value.slot.start('Do not retry authentication failures');
  await until(() => value.slot.getTask().status === 'failed');
  await value.slot.getTask().finalization;
  assert.equal(value.models.length, 1);
  assert.match(value.slot.getTask().result, /401/);
});

test('disposing an active Agent removes listeners and rejects late model actions', { timeout: 2000 }, async t => {
  const late = deferred();
  const cleanups = [];
  const value = fixture(t, { fetch: () => late.promise, onCleanup: callback => cleanups.push(callback) });
  await value.slot.start('Stop when the capability is released');
  await until(() => value.models.length === 1);
  assert.ok(Object.values(value.listeners).every(listeners => listeners.length === 1));
  await cleanups[0]();
  assert.equal(value.models[0].request.signal.aborted, true);
  assert.equal(value.slot.isBusy(), false);
  assert.equal(value.slot.getTask().status, 'paused');
  assert.ok(Object.values(value.listeners).every(listeners => listeners.length === 0));
  for (const id of ['#agent-toggle', '#agent-stop', '#agent-close', '#agent-takeover']) {
    assert.equal(Object.keys(value.elements.get(id).listeners).length, 0);
  }
  late.resolve(decisionResponse({ action: 'navigate', args: { url: 'https://allowed.test/late' } }));
  await tick();
  assert.equal(value.events.some(message => message.type === 'AGENT_NAVIGATE'), false);
  await assert.rejects(value.slot.start('Cannot restart a disposed instance'), { name: 'AbortError' });
});

test('disposing during an asynchronous checkpoint restore cannot revive the panel', { timeout: 2000 }, async t => {
  const pending = deferred();
  const entered = deferred();
  const value = fixture(t, {
    stored: { 'agentTask:restore': { id: 'restore', goal: 'Restore original task', tabId: 1, currentUrl: observation.url, status: 'running' } },
    restore: () => { entered.resolve(); return pending.promise; },
  });
  const restoring = value.slot.restore();
  const rejected = assert.rejects(restoring, { name: 'AbortError' });
  await entered.promise;
  await value.slot.dispose();
  await rejected;
  pending.resolve({ agent: { status: 'running', steps: [] } });
  await tick();
  assert.equal(value.slot.isMode(), false);
  assert.equal(value.slot.isBusy(), false);
  assert.equal(value.elements.get('#agent-panel').hidden, true);
  assert.equal(value.models.length, 0);
});

test('disposing during site approval removes transient button listeners and ignores a retained old click', { timeout: 2000 }, async t => {
  const value = fixture(t, { authorized: false });
  const starting = value.slot.start('Wait for site approval');
  const interaction = value.elements.get('#agent-interaction');
  await until(() => interaction.innerHTML.includes('允许控制'));
  const buttons = [...interaction.buttons];
  const staleClick = buttons[0].listeners.click;
  await value.slot.dispose();
  assert.equal(await starting, false);
  assert.ok(buttons.every(button => Object.keys(button.listeners).length === 0));
  staleClick();
  await tick();
  assert.equal(value.events.some(message => message.type === 'AGENT_START'), false);
  assert.equal(value.models.length, 0);
});

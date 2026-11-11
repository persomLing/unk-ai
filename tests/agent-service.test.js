import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { withPageDebugger } from '../src/background/network-reading-service.js';

const scannerSource = readFileSync(new URL('../src/content/agent-scanner.js', import.meta.url), 'utf8');
const extractorSource = readFileSync(new URL('../src/content/extractor.js', import.meta.url), 'utf8');
let sequence = 0;
let documentSequence = 0;
const event = () => {
  const listeners = new Set();
  return { addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); } };
};

function frame(url, names, isTop = true) {
  const listeners = new Map();
  const messages = [];
  const dispatch = (type, { isTrusted = false, ...fields } = {}) => {
    const event = { type, isTrusted, cancelable: true, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...fields };
    for (const handler of [...listeners.get(type) || []]) {
      if (!listeners.get(type)?.has(handler)) continue;
      handler(event);
      if (event.stopped) break;
    }
    return event;
  };
  const createNode = tag => ({ tagName: tag.toUpperCase(), children: [], attributes: {},
    appendChild(node) { this.children.push(node); node.parentElement = this; },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
    setAttribute(key, value) { this.attributes[key] = value; },
    querySelector(selector) { return this.children.find(node => selector === `.${node.className}`) || this.children.map(node => node.querySelector(selector)).find(Boolean) || null; },
  });
  const documentElement = Object.assign(createNode('html'), { scrollHeight: 800 });
  const byId = (node, id) => node.id === id ? node : node.children.map(child => byId(child, id)).find(Boolean) || null;
  const body = { tagName: 'BODY', nodeType: 1, childNodes: [{ nodeType: 3, nodeValue: 'Actual page evidence '.repeat(5) }],
    innerText: 'Actual page evidence '.repeat(5), scrollHeight: 800, attributes: {} };
  const document = {
    title: 'Fixture', body, documentElement,
    createElement: createNode, querySelector() { return null; }, getElementById(id) { return byId(documentElement, id); },
    querySelectorAll(selector) { return selector.includes('a[href]') ? elements : []; },
    elementFromPoint(_x, y) { return elements.find((element) => Math.abs(element.getBoundingClientRect().top + 10 - y) < 2); },
  };
  const elements = names.map((name, index) => ({
    tagName: 'BUTTON', type: 'button', innerText: name, textContent: name, id: `button-${index}`, nodeType: 1, isConnected: true,
    attributes: {}, clicks: 0,
    getAttribute(key) { return this.attributes[key] ?? null; }, hasAttribute(key) { return key in this.attributes; },
    getRootNode() { return document; }, closest() { return null; },
    getBoundingClientRect() { return { top: 100 + index * 40, bottom: 120 + index * 40, left: 10, right: 90, width: 80, height: 20 }; },
    contains(other) { return this === other; }, scrollIntoView() {},
    focus() { document.activeElement = this; }, click() { if (!dispatch('click').prevented) this.clicks += 1; },
    dispatchEvent(event) { return !dispatch(event.type, { isTrusted: event.isTrusted }).prevented; },
  }));
  document.activeElement = elements[0];
  const location = new URL(url);
  document.location = location;
  const context = vm.createContext({ document, location, URL, URLSearchParams, Map, Set, Event,
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args),
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    chrome: { runtime: { sendMessage(message) { messages.push(message); return Promise.resolve(); } } },
    innerHeight: 800, innerWidth: 1000, scrollY: 0, getComputedStyle: () => ({ opacity: '1' }) });
  vm.runInContext(isTop ? 'globalThis.top=globalThis' : 'globalThis.top={}', context);
  return { context, elements, dispatch, messages, listeners, documentId: `document-${++documentSequence}` };
}

function sidebarFixture(frameValue, { count = 100, horizontal = false } = {}) {
  const { context } = frameValue;
  const document = context.document;
  const sample = frameValue.elements[0];
  const container = { ...sample, tagName: 'NAV', type: '', id: 'chapters', innerText: '教程目录', textContent: '教程目录',
    attributes: { 'aria-label': '教程目录' }, parentElement: null, style: { opacity: '1', overflowY: horizontal ? 'hidden' : 'auto', overflowX: horizontal ? 'auto' : 'hidden' },
    clientHeight: 320, clientWidth: 240, scrollHeight: horizontal ? 320 : count * 40, scrollWidth: horizontal ? 1800 : 240, scrollTop: 0, scrollLeft: 0,
    matches() { return false; },
    getBoundingClientRect() { return { top: 100, bottom: 420, left: 0, right: 240, width: 240, height: 320 }; },
    scrollBy({ top = 0, left = 0 }) { this.scrollTop = Math.min(this.scrollHeight - this.clientHeight, Math.max(0, this.scrollTop + top)); this.scrollLeft = Math.min(this.scrollWidth - this.clientWidth, Math.max(0, this.scrollLeft + left)); },
  };
  const links = Array.from({ length: count }, (_, index) => ({ ...sample, tagName: 'A', type: '', id: `chapter-${index + 1}`,
    innerText: `第${index + 1}章${index === 19 ? ' MCP 模型上下文协议' : ' 教程'}`, textContent: `第${index + 1}章`,
    attributes: { href: `#/chapter-${index + 1}`, ...(index === 0 ? { 'aria-current': 'page' } : {}) }, parentElement: container,
    getBoundingClientRect() { const top = 110 + index * 40 - container.scrollTop; return { top, bottom: top + 24, left: 10, right: 220, width: 210, height: 24 }; },
    click() { this.clicks += 1; context.location.hash = this.attributes.href; },
  }));
  const heading = { innerText: '第一章', textContent: '第一章' };
  const main = { ...sample, tagName: 'MAIN', type: '', id: 'main', innerText: '第一章正文', textContent: '第一章正文', attributes: {},
    style: { opacity: '1' }, querySelector: () => heading, querySelectorAll: () => [],
    getBoundingClientRect() { return { top: 80, bottom: 700, left: 280, right: 900, width: 620, height: 620 }; },
  };
  const button = { ...sample, id: 'main-button', innerText: '正文按钮', textContent: '正文按钮', parentElement: main,
    getBoundingClientRect() { return { top: 150, bottom: 175, left: 300, right: 400, width: 100, height: 25 }; },
  };
  const items = [...links, button];
  document.querySelectorAll = selector => selector.includes('a[href]') ? items : selector === '*' || selector === 'body *' ? [container, ...links, main, button] : [];
  document.querySelector = selector => selector.startsWith('main, article') ? main : null;
  document.elementFromPoint = (x, y) => items.find(element => {
    const rect = element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  });
  context.getComputedStyle = node => node.style || { opacity: '1' };
  context.scrollBy = ({ top = 0, left = 0 }) => { context.scrollY += top; context.scrollX = (context.scrollX || 0) + left; };
  return { container, links, button, main, heading };
}

async function fixture({ childOrigin = 'https://allowed.test', grantChild = true, recordDiagnostic, serializeResult = value => value, referenceImages = [] } = {}) {
  const data = { agentSettings: { enabled: true }, agentOriginGrants: { 'https://allowed.test': { scope: 'task', taskId: 'task' } } };
  if (grantChild) data.agentOriginGrants[childOrigin] = { scope: 'task', taskId: 'task' };
  const storage = { async get(key) { return structuredClone({ [key]: data[key] }); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  const frames = [frame('https://allowed.test/app', ['展开']), frame(`${childOrigin}/frame`, ['详情'], false)];
  let beforeGet = null;
  let beforeScript = null;
  let beforeCapture = null;
  let beforeAttach = null;
  let beforeCommand = null;
  const debuggerCalls = [];
  let activeTabId = 1;
  let captureCalls = 0;
  let tabUrl = 'https://allowed.test/app';
  const scriptRequests = [];
  const diagnostics = [];
  globalThis.chrome = {
    storage: { local: storage, session: storage, onChanged: event() },
    tabs: { async get() { if (beforeGet) await beforeGet(); return { id: 1, windowId: 3, url: tabUrl, title: 'Fixture', status: 'complete' }; },
      async query() { return [{ id: activeTabId }]; },
      async captureVisibleTab() { captureCalls++; if (beforeCapture) await beforeCapture(); return 'data:image/jpeg;base64,ZmFrZQ=='; },
      onUpdated: event(), onRemoved: event() },
    debugger: { onDetach: event(),
      async attach(target, version) { debuggerCalls.push({ method: 'attach', target, version }); if (beforeAttach) await beforeAttach(); },
      async detach(target) { debuggerCalls.push({ method: 'detach', target }); },
      async sendCommand(target, method, parameters) {
        debuggerCalls.push({ method, target, parameters });
        if (beforeCommand) { const result = await beforeCommand(method, parameters); if (result !== undefined) return result; }
        return method === 'Page.captureScreenshot' ? { data: 'ZmFrZS1jZHA=' } : {};
      },
    },
    scripting: { async executeScript(request) {
      scriptRequests.push(request);
      if (beforeScript) await beforeScript(request);
      const ids = request.target.documentIds
        ? frames.map((entry, id) => request.target.documentIds.includes(entry.documentId) ? id : -1).filter((id) => id >= 0)
        : request.target.allFrames ? [0, 1] : request.target.frameIds || [0];
      if (!ids.length) throw new Error('No document with this ID');
      return Promise.all(ids.map(async (id) => {
        const context = frames[id].context;
        if (request.files) {
          for (const file of request.files) vm.runInContext(file === 'content/extractor.js' ? extractorSource : scannerSource, context);
          return { frameId: id, documentId: frames[id].documentId };
        }
        context.__args = request.args || [];
        const result = await vm.runInContext(`(${request.func.toString()})(...__args)`, context);
        return { frameId: id, documentId: frames[id].documentId, result: serializeResult(result) };
      }));
    } },
  };
  let { handleAgentMessage } = await import(`../src/background/agent-service.js?fixture=${++sequence}`);
  const send = async (message) => { let result; await handleAgentMessage({ tabId: 1, taskId: 'task', ...message }, (value) => { result = value; }, {
    recordDiagnostic: entry => { diagnostics.push(structuredClone(entry)); return recordDiagnostic?.(entry); },
  }); return result; };
  assert.equal((await send({ type: 'AGENT_START', referenceImages })).ok, true);
  return { send, frames, data, scriptRequests, diagnostics, debuggerCalls,
    async restartWorker() { ({ handleAgentMessage } = await import(`../src/background/agent-service.js?fixture=${++sequence}`)); },
    get captureCalls() { return captureCalls; }, setActiveTabId(value) { activeTabId = value; }, setBeforeCapture(value) { beforeCapture = value; },
    setBeforeAttach(value) { beforeAttach = value; }, setBeforeCommand(value) { beforeCommand = value; },
    setBeforeGet(value) { beforeGet = value; }, setBeforeScript(value) { beforeScript = value; }, setTabUrl(value) { tabUrl = value; } };
}

function nativeSelect(frameValue, options = ['2.5', '2.6']) {
  const element = frameValue.elements[0];
  Object.assign(element, { tagName: 'SELECT', type: '', value: options[0], innerText: '', textContent: '',
    attributes: { 'aria-label': 'Model' }, multiple: false,
    options: options.map(value => ({ value, text: value, disabled: false,
      get selected() { return element.value === value; } })) });
  return element;
}

const uploadImage = { type: 'image', name: 'task-reference.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZgAAAABJRU5ErkJggg==' };
function nativeFileInput(frameValue, { accept = 'image/*' } = {}) {
  const element = frameValue.elements[0];
  class NativeInput {}
  Object.defineProperty(NativeInput.prototype, 'files', { get() { return this._files || []; }, set(value) { this.assignments++; this._files = [...value]; } });
  Object.setPrototypeOf(element, NativeInput.prototype);
  Object.assign(element, { tagName: 'INPUT', type: 'file', innerText: '', textContent: '', assignments: 0, multiple: false,
    attributes: { 'aria-label': 'Upload reference image', accept } });
  frameValue.context.HTMLInputElement = NativeInput;
  frameValue.context.File = File;
  frameValue.context.atob = atob;
  frameValue.context.DataTransfer = class {
    files = [];
    items = { add: file => { this.files.push(file); return file; } };
  };
  return element;
}

const uploadAction = (snapshotId, actionId = 'upload-1') => ({ type: 'AGENT_ACT', snapshotId, actionId,
  action: 'upload_reference_image', args: { elementId: 'e1', referenceId: 'reference-1' }, approval: { confirmed: true, actionId } });

function labeledHiddenFileInput(frameValue) {
  const input = nativeFileInput(frameValue);
  const label = { ...input, tagName: 'LABEL', type: '', id: 'upload-label', innerText: 'Choose reference image',
    textContent: 'Choose reference image', attributes: {}, control: input, labels: undefined, style: { opacity: '1' } };
  input.labels = [label];
  input.style = { display: 'none', opacity: '1' };
  input.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  frameValue.context.getComputedStyle = node => node.style || { opacity: '1' };
  return { input, label };
}

function styledChoiceInput(frameValue, type = 'checkbox') {
  const input = frameValue.elements[0];
  Object.assign(input, { tagName: 'INPUT', type, checked: false, innerText: '', textContent: '',
    attributes: {}, style: { opacity: '0', pointerEvents: 'none' },
    getBoundingClientRect: () => ({ top: 110, bottom: 111, left: 20, right: 21, width: 1, height: 1 }),
    click() { this.clicks++; this.checked = type === 'radio' || !this.checked; } });
  const label = { ...input, tagName: 'LABEL', type: '', id: 'gif-label', control: input, labels: undefined,
    attributes: {}, style: { opacity: '1' }, innerText: '生成 GIF 动图 按1张图计费', textContent: '生成 GIF 动图 按1张图计费',
    getBoundingClientRect: () => ({ top: 100, bottom: 149, left: 10, right: 306, width: 296, height: 49 }),
    contains: element => element === label || element === input,
    click() { this.clicks++; input.click(); } };
  input.labels = [label]; input.parentElement = label;
  frameValue.context.getComputedStyle = node => node.style || { opacity: '1' };
  frameValue.context.document.elementFromPoint = () => label;
  return { input, label };
}

function transparentUploadInput(frameValue) {
  const input = nativeFileInput(frameValue);
  const bounds = () => ({ top: 100, bottom: 150, left: 10, right: 304, width: 294, height: 50 });
  const parent = { ...input, tagName: 'DIV', type: '', id: 'upload-area', attributes: {}, labels: undefined,
    style: { opacity: '1', pointerEvents: 'auto' }, innerText: '点击或拖拽上传参考图', textContent: '点击或拖拽上传参考图',
    children: [input], getBoundingClientRect: bounds,
    contains: element => element === parent || element === input };
  Object.assign(input, { parentElement: parent, labels: [], style: { opacity: '0', pointerEvents: 'auto' },
    attributes: { 'aria-label': '上传参考图（最多6张）', accept: 'image/*' }, getBoundingClientRect: bounds });
  frameValue.context.getComputedStyle = node => node.style || { opacity: '1' };
  frameValue.context.document.elementFromPoint = () => input;
  return { input, parent };
}

function uploadPreviewFixture(frameValue) {
  const { input, parent } = transparentUploadInput(frameValue);
  const previews = [];
  const scope = { ...parent, id: 'reference-previews', children: [parent], parentElement: null,
    innerText: '参考图片', textContent: '参考图片',
    getBoundingClientRect: () => ({ top: 100, bottom: 270, left: 10, right: 304, width: 294, height: 170 }),
    contains: node => node === scope || node === parent || node === input || previews.includes(node),
    querySelectorAll: selector => selector === 'img' ? previews : [] };
  parent.parentElement = scope;
  frameValue.context.AbortController = AbortController;
  const addPreview = src => {
    const preview = { ...input, tagName: 'IMG', type: '', attributes: { alt: 'task-reference.png' },
      currentSrc: src, src, parentElement: scope, style: { opacity: '1' },
      getBoundingClientRect: () => ({ top: 160, bottom: 260, left: 10, right: 110, width: 100, height: 100 }) };
    previews.push(preview); scope.children.push(preview);
    return preview;
  };
  return { input, parent, scope, addPreview };
}

test('a consumed file selection requires a new matching blob preview before upload acceptance', async t => {
  for (const accepted of [true, false]) await t.test(String(accepted), async () => {
    const value = await fixture({ referenceImages: [uploadImage] });
    const { input, addPreview } = uploadPreviewFixture(value.frames[0]);
    const bytes = Uint8Array.from(atob(uploadImage.dataUrl.split(',')[1]), char => char.charCodeAt(0));
    value.frames[0].context.fetch = async () => new Response(accepted ? bytes : new Uint8Array(bytes.length),
      { headers: { 'Content-Type': 'image/png' } });
    input.dispatchEvent = event => { if (event.type === 'change') { input._files = []; addPreview('blob:https://allowed.test/new-reference'); } return true; };
    const before = await value.send({ type: 'AGENT_OBSERVE' });
    const action = uploadAction(before.snapshotId, 'consumed-preview');
    const result = await value.send(action);
    assert.equal(result.error, 'ERR_UPLOAD_UNCERTAIN');
    assert.equal(result.upload?.requiresAcceptanceVerification, true);
    const after = await value.send({ type: 'AGENT_OBSERVE' });
    const checked = await value.send({ type: 'AGENT_VERIFY_UPLOAD', expectedUrl: after.url, snapshotId: after.snapshotId,
      elementId: after.elements.find(element => element.type === 'file').id, uploadActionId: action.actionId, referenceId: 'reference-1' });
    assert.equal(checked?.receipt?.accepted === true, accepted, JSON.stringify(checked));
    assert.equal((await value.send(action)).error, 'ERR_UPLOAD_UNCERTAIN');
    assert.equal(input.assignments, 1, 'read-only acceptance checks must never repeat file selection');
  });
});

test('old, absent, hidden and foreign-origin previews cannot resolve a consumed upload', async t => {
  for (const kind of ['old', 'absent', 'hidden', 'foreign-origin']) await t.test(kind, async () => {
    const value = await fixture({ referenceImages: [uploadImage] });
    const { input, addPreview } = uploadPreviewFixture(value.frames[0]);
    let fetches = 0;
    const source = 'blob:https://allowed.test/existing-reference';
    if (kind === 'old') addPreview(source);
    value.frames[0].context.fetch = async () => { fetches++; return new Response(atob(uploadImage.dataUrl.split(',')[1])); };
    input.dispatchEvent = event => {
      if (event.type === 'change') {
        input._files = [];
        if (kind !== 'absent') {
          const node = addPreview(kind === 'foreign-origin' ? 'blob:https://other.test/reference' : source);
          if (kind === 'hidden') node.style.display = 'none';
        }
      }
      return true;
    };
    const before = await value.send({ type: 'AGENT_OBSERVE' });
    await value.send(uploadAction(before.snapshotId, 'unconfirmed-preview'));
    const after = await value.send({ type: 'AGENT_OBSERVE' });
    const result = await value.send({ type: 'AGENT_VERIFY_UPLOAD', expectedUrl: after.url, snapshotId: after.snapshotId,
      elementId: after.elements.find(element => element.type === 'file').id, uploadActionId: 'unconfirmed-preview', referenceId: 'reference-1' });
    assert.equal(result.error, 'ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED', JSON.stringify(result));
    assert.equal(fetches, 0);
    assert.equal(input.assignments, 1);
  });
});

test('styled native checkbox and radio use their associated visible label geometry and retain input state', async t => {
  for (const type of ['checkbox', 'radio']) await t.test(type, async () => {
    const value = await fixture();
    const { input, label } = styledChoiceInput(value.frames[0], type);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const target = observation.elements.find(element => element.type === type);
    assert.ok(target, 'the 1px transparent native choice must be represented by its actual label');
    assert.equal(target.name, '生成 GIF 动图 按1张图计费');
    assert.equal(target.rect.width, 296);
    assert.equal(target.state.checked, false);
    const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: `styled-${type}`,
      action: 'click_element', args: { elementId: target.id } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(input.clicks, 1);
    assert.equal(label.clicks, 1, 'the checked input is activated through its verified native label');
    assert.equal(input.checked, true);
    const after = await value.send({ type: 'AGENT_OBSERVE' });
    assert.equal(after.elements.find(element => element.type === type).state.checked, true);
  });
});

test('a transparent native file overlay on a visible upload area supports only confirmed reference uploads', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const { input } = transparentUploadInput(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const target = observation.elements.find(element => element.type === 'file');
  assert.ok(target, 'the hit-testable transparent upload overlay must be observable');
  assert.equal(target.rect.width, 294);
  assert.equal(target.fileInput.viaLabel, false);
  assert.equal(target.fileInput.viaOverlay, true);
  assert.equal(target.uploadOnly, true);
  assert.equal(target.uploadCapability.risk, 'confirm');
  const click = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'overlay-click',
    action: 'click_element', args: { elementId: target.id } });
  assert.equal(click.error, 'ERR_SAFETY_BLOCKED');
  const message = uploadAction(observation.snapshotId);
  message.args.elementId = target.id;
  const result = await value.send(message);
  assert.equal(result.upload?.fileSelected, true, JSON.stringify(result));
  assert.equal(input.assignments, 1);
});

test('styled choice labels cannot authorize clicks after linkage, visibility, target or permission changes', async t => {
  for (const kind of ['renamed', 'replaced', 'unlinked', 'hidden', 'hidden-ancestor', 'disabled', 'label-disabled',
    'occluded', 'ancestor-hit', 'pointer-none', 'detached', 'moved', 'page', 'document', 'permission']) await t.test(kind, async () => {
    const value = await fixture();
    const { input, label } = styledChoiceInput(value.frames[0]);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const target = observation.elements.find(element => element.type === 'checkbox');
    if (kind === 'renamed') label.innerText = label.textContent = 'Other option';
    if (kind === 'replaced') input.labels = [{ ...label }];
    if (kind === 'unlinked') label.control = null;
    if (kind === 'hidden') label.style.display = 'none';
    if (kind === 'hidden-ancestor') label.parentElement = { ...label, tagName: 'DIV', attributes: { 'aria-hidden': 'true' } };
    if (kind === 'disabled') input.disabled = true;
    if (kind === 'label-disabled') label.attributes['aria-disabled'] = 'true';
    if (kind === 'occluded') value.frames[0].context.document.elementFromPoint = () => value.frames[1].elements[0];
    if (kind === 'ancestor-hit') value.frames[0].context.document.elementFromPoint = () => ({ contains: element => element === label });
    if (kind === 'pointer-none') label.style.pointerEvents = 'none';
    if (kind === 'detached') input.isConnected = false;
    if (kind === 'moved') label.getBoundingClientRect = () => ({ top: 200, bottom: 249, left: 10, right: 306, width: 296, height: 49 });
    if (kind === 'page') value.frames[0].context.location.hash = '#changed';
    if (kind === 'document') value.frames[0].documentId = 'new-document';
    if (kind === 'permission') value.data.agentOriginGrants = {};
    const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: `invalid-choice-${kind}`,
      action: 'click_element', args: { elementId: target.id } });
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(input.clicks, 0);
    assert.equal(label.clicks, 0);
    assert.equal(input.checked, false);
  });
});

test('styled native choices expose clicks without opening hidden text or key input paths', async t => {
  for (const action of ['type_text', 'press_key']) await t.test(action, async () => {
    const value = await fixture();
    const { input, label } = styledChoiceInput(value.frames[0]);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: `choice-${action}`,
      action, args: { elementId: observation.elements.find(element => element.type === 'checkbox').id,
        ...(action === 'type_text' ? { text: 'other value' } : { key: 'Tab' }) } });
    assert.equal(result.error, 'ERR_CHOICE_CLICK_ONLY', JSON.stringify(result));
    assert.equal(input.clicks, 0);
    assert.equal(label.clicks, 0);
    assert.equal(input.value, undefined);
  });
});

test('styled choice linkage is rechecked after scrolling before the native label click', async () => {
  const value = await fixture();
  const { input, label } = styledChoiceInput(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  let scrollCount = 0;
  label.scrollIntoView = () => { if (++scrollCount === 2) label.control = null; };
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'choice-scroll-change',
    action: 'click_element', args: { elementId: observation.elements.find(element => element.type === 'checkbox').id } });
  assert.equal(result.error, 'ERR_ELEMENT_CHANGED', JSON.stringify(result));
  assert.equal(input.clicks, 0);
  assert.equal(label.clicks, 0);
});

test('transparent upload support excludes concealed, unnamed, tiny and non-hit-testable file inputs', async t => {
  for (const kind of ['display-none', 'visibility-hidden', 'pointer-none', 'tiny', 'offscreen', 'hidden-parent',
    'hidden-ancestor', 'aria-hidden', 'unnamed', 'occluded', 'no-area', 'oversized', 'cross-boundary', 'tiny-parent']) await t.test(kind, async () => {
    const value = await fixture({ referenceImages: [uploadImage] });
    const { input, parent } = transparentUploadInput(value.frames[0]);
    if (kind === 'display-none') input.style.display = 'none';
    if (kind === 'visibility-hidden') input.style.visibility = 'hidden';
    if (kind === 'pointer-none') input.style.pointerEvents = 'none';
    if (kind === 'tiny') input.getBoundingClientRect = () => ({ top: 100, bottom: 101, left: 10, right: 11, width: 1, height: 1 });
    if (kind === 'offscreen') input.getBoundingClientRect = () => ({ top: 1000, bottom: 1050, left: 10, right: 304, width: 294, height: 50 });
    if (kind === 'hidden-parent') parent.style.display = 'none';
    if (kind === 'hidden-ancestor') parent.parentElement = { ...parent, attributes: { 'aria-hidden': 'true' } };
    if (kind === 'aria-hidden') input.attributes['aria-hidden'] = 'true';
    if (kind === 'unnamed') { input.attributes = { accept: 'image/*' }; parent.innerText = parent.textContent = 'Settings'; }
    if (kind === 'occluded') value.frames[0].context.document.elementFromPoint = () => parent;
    if (kind === 'no-area') input.parentElement = null;
    if (kind === 'oversized') input.getBoundingClientRect = () => ({ top: 100, bottom: 150, left: 10, right: 900, width: 890, height: 50 });
    if (kind === 'cross-boundary') input.getBoundingClientRect = () => ({ top: 98, bottom: 148, left: 10, right: 304, width: 294, height: 50 });
    if (kind === 'tiny-parent') parent.getBoundingClientRect = () => ({ top: 100, bottom: 108, left: 10, right: 18, width: 8, height: 8 });
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    assert.equal(observation.elements.some(element => element.type === 'file'), false);
    assert.equal(observation.flags.uploadRequiresHandoff, true);
    assert.equal(input.assignments, 0);
  });
});

test('transparent upload coverage allows only a one pixel rounding margin at its visible parent', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const { input } = transparentUploadInput(value.frames[0]);
  input.getBoundingClientRect = () => ({ top: 99, bottom: 151, left: 9, right: 305, width: 296, height: 52 });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements.find(element => element.type === 'file')?.fileInput.viaOverlay, true);
});

test('transparent upload area identity and hit testing are rechecked before file selection', async t => {
  for (const kind of ['pointer-none', 'occluded', 'hidden-parent', 'replaced-parent', 'disabled', 'renamed',
    'parent-disabled', 'accept', 'out-of-area', 'page', 'document', 'permission']) await t.test(kind, async () => {
    const value = await fixture({ referenceImages: [uploadImage] });
    const { input, parent } = transparentUploadInput(value.frames[0]);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    if (kind === 'pointer-none') input.style.pointerEvents = 'none';
    if (kind === 'occluded') value.frames[0].context.document.elementFromPoint = () => parent;
    if (kind === 'hidden-parent') parent.style.display = 'none';
    if (kind === 'replaced-parent') input.parentElement = { ...parent };
    if (kind === 'disabled') input.disabled = true;
    if (kind === 'parent-disabled') parent.attributes['aria-disabled'] = 'true';
    if (kind === 'renamed') input.attributes['aria-label'] = 'Upload unrelated image';
    if (kind === 'accept') input.attributes.accept = 'image/jpeg';
    if (kind === 'out-of-area') input.getBoundingClientRect = () => ({ top: 100, bottom: 150, left: 10, right: 900, width: 890, height: 50 });
    if (kind === 'page') value.frames[0].context.location.hash = '#changed';
    if (kind === 'document') value.frames[0].documentId = 'new-document';
    if (kind === 'permission') value.data.agentOriginGrants = {};
    const result = await value.send(uploadAction(observation.snapshotId, `invalid-overlay-${kind}`));
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(input.assignments, 0);
  });
});

test('styled choice labels retain their authorized iframe input identity', async () => {
  const value = await fixture({ childOrigin: 'https://other.test' });
  const { input, label } = styledChoiceInput(value.frames[1]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const target = observation.elements.find(element => element.type === 'checkbox');
  assert.equal(target.frameId, 1);
  assert.equal(target.mainFrame, false);
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'iframe-styled-choice',
    action: 'click_element', args: { elementId: target.id } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(label.clicks, 1);
  assert.equal(input.checked, true);
  assert.equal(value.frames[0].elements[0].clicks, 0);
});

test('transparent upload overlays in authorized cross-origin frames cannot receive task reference bytes', async () => {
  const value = await fixture({ referenceImages: [uploadImage], childOrigin: 'https://other.test' });
  const { input } = transparentUploadInput(value.frames[1]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const target = observation.elements.find(element => element.type === 'file');
  assert.equal(target.fileInput.viaOverlay, true);
  assert.equal(target.uploadCapability.risk, 'blocked');
  assert.deepEqual(target.uploadCapability.referenceIds, []);
  const message = uploadAction(observation.snapshotId, 'iframe-overlay-upload');
  message.args.elementId = target.id;
  const result = await value.send(message);
  assert.equal(result.error, 'ERR_UPLOAD_SCOPE');
  assert.equal(input.assignments, 0);
});

test('transparent upload rejects changed visible parent meaning before selecting a reference', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const { input, parent } = transparentUploadInput(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  parent.innerText = parent.textContent = 'Delete account';
  const result = await value.send(uploadAction(observation.snapshotId, 'overlay-parent-meaning'));
  assert.equal(result.error, 'ERR_ELEMENT_CHANGED', JSON.stringify(result));
  assert.equal(input.assignments, 0);
});

test('transparent upload tolerates normal visible parent count updates after selecting the reference', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const { input, parent } = transparentUploadInput(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const dispatchEvent = input.dispatchEvent;
  input.dispatchEvent = event => {
    parent.innerText = parent.textContent = event.type === 'input' ? '已选择 1/6 参考图' : '上传参考图 1/6，显示预览';
    return dispatchEvent.call(input, event);
  };
  const result = await value.send(uploadAction(observation.snapshotId, 'overlay-parent-count'));
  assert.equal(result.upload?.fileSelected, true, JSON.stringify(result));
  assert.equal(input.assignments, 1);
  assert.equal(parent.innerText, '上传参考图 1/6，显示预览');
});

test('transparent upload rechecks parent meaning after payload preparation at the actual file assignment', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const { input, parent } = transparentUploadInput(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  value.frames[0].context.File = class extends File {
    constructor(...args) { super(...args); parent.innerText = parent.textContent = 'Delete account'; }
  };
  const result = await value.send(uploadAction(observation.snapshotId, 'overlay-parent-preparation'));
  assert.equal(result.error, 'ERR_ELEMENT_CHANGED', JSON.stringify(result));
  assert.equal(input.assignments, 0);
});

test('a transparent upload named by its parent can retain only count and preview text after selection', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const { input, parent } = transparentUploadInput(value.frames[0]);
  input.attributes = { accept: 'image/*' };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const dispatchEvent = input.dispatchEvent;
  input.dispatchEvent = event => {
    parent.innerText = parent.textContent = '1/6';
    return dispatchEvent.call(input, event);
  };
  const result = await value.send(uploadAction(observation.snapshotId, 'overlay-parent-only-count'));
  assert.equal(result.upload?.fileSelected, true, JSON.stringify(result));
  assert.equal(input.assignments, 1);
});

test('a hidden native file input can use its visible associated label only for a controlled upload', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const { input } = labeledHiddenFileInput(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const target = observation.elements.find(element => element.type === 'file');
  assert.ok(target);
  assert.equal(target.uploadOnly, true);
  assert.equal(target.fileInput.viaLabel, true);
  assert.equal(target.risk, 'blocked');
  assert.equal(target.uploadCapability.risk, 'confirm');
  assert.deepEqual(target.uploadCapability.referenceIds, ['reference-1']);
  assert.equal(target.name, 'Choose reference image');
  assert.equal(target.rect.width, 80);
  const click = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'click-upload-label',
    action: 'click_element', args: { elementId: target.id } });
  assert.equal(click.error, 'ERR_SAFETY_BLOCKED');
  const message = uploadAction(observation.snapshotId);
  message.args.elementId = target.id;
  const result = await value.send(message);
  assert.equal(result.upload?.fileSelected, true, JSON.stringify(result));
  assert.equal(input.assignments, 1);
});

test('label identity, linkage and visible meaning must survive until the upload executes', async t => {
  for (const kind of ['renamed', 'replaced', 'unlinked', 'hidden']) await t.test(kind, async () => {
    const value = await fixture({ referenceImages: [uploadImage] });
    const { input, label } = labeledHiddenFileInput(value.frames[0]);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    if (kind === 'renamed') { label.innerText = 'Send private image'; label.textContent = label.innerText; }
    if (kind === 'replaced') input.labels = [{ ...label }];
    if (kind === 'unlinked') label.control = null;
    if (kind === 'hidden') label.style.display = 'none';
    const result = await value.send(uploadAction(observation.snapshotId));
    assert.equal(result.error, 'ERR_ELEMENT_CHANGED', JSON.stringify(result));
    assert.equal(input.assignments, 0);
  });
});

test('an unassociated hidden input is not offered as an upload target', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const { input } = labeledHiddenFileInput(value.frames[0]);
  input.labels = [];
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements.some(element => element.type === 'file'), false);
  assert.equal(observation.flags.uploadRequiresHandoff, true);
});

test('a task reference is selected through the native file input once and its FileList is verified', async () => {
  const value = await fixture({ referenceImages: [uploadImage], serializeResult: sortedTransfer });
  const input = nativeFileInput(value.frames[0]);
  const events = [];
  input.dispatchEvent = event => { events.push(event.type); return true; };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements[0].fileInput.supported, true);
  assert.equal(observation.elements[0].fileInput.accept, 'image/*');
  const message = uploadAction(observation.snapshotId);
  const result = await value.send(message);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.upload.fileSelected, true);
  assert.equal(result.upload.serverConfirmed, false);
  assert.equal(result.diagnostics.executionStatus, 'verified');
  assert.equal(input.files[0].name, 'task-reference.png');
  assert.equal(input.files[0].type, 'image/png');
  assert.equal(input.files[0].size, 67);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal((await value.send(message)).upload.fileSelected, true);
  assert.equal(input.assignments, 1);
  assert.doesNotMatch(JSON.stringify(value.diagnostics), /task-reference|iVBORw0KGgo/);
});

test('upload permission requires a registered reference and this action confirmation', async () => {
  for (const registered of [false, true]) {
    const value = await fixture({ referenceImages: registered ? [uploadImage] : [] });
    const input = nativeFileInput(value.frames[0]);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const message = uploadAction(observation.snapshotId);
    if (registered) delete message.approval;
    const result = await value.send(message);
    assert.equal(result.error, 'ERR_SAFETY_BLOCKED');
    assert.equal(input.assignments, 0);
  }
});

test('unavailable native upload support is diagnosed before selecting any file', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const input = nativeFileInput(value.frames[0]);
  delete value.frames[0].context.DataTransfer;
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements[0].fileInput.supported, false);
  assert.equal(observation.elements[0].uploadCapability.risk, 'blocked');
  assert.deepEqual(observation.elements[0].uploadCapability.referenceIds, []);
  const result = await value.send(uploadAction(observation.snapshotId));
  assert.equal(result.error, 'ERR_UPLOAD_UNSUPPORTED');
  assert.equal(result.diagnostics.executionStatus, 'not-started');
  assert.equal(input.assignments, 0);
});

test('changed accept policy and cross-origin frames cannot receive task reference bytes', async () => {
  const changed = await fixture({ referenceImages: [uploadImage] });
  const input = nativeFileInput(changed.frames[0]);
  const observation = await changed.send({ type: 'AGENT_OBSERVE' });
  input.attributes.accept = '.pdf';
  const rejected = await changed.send(uploadAction(observation.snapshotId));
  assert.equal(rejected.error, 'ERR_ELEMENT_CHANGED');
  assert.deepEqual(rejected.diagnostics.changedFields, ['fileInput']);
  assert.equal(input.assignments, 0);
  const cross = await fixture({ referenceImages: [uploadImage], childOrigin: 'https://other.test' });
  const frameInput = nativeFileInput(cross.frames[1]);
  const crossObservation = await cross.send({ type: 'AGENT_OBSERVE' });
  const crossMessage = uploadAction(crossObservation.snapshotId);
  crossMessage.args.elementId = 'e2';
  assert.equal((await cross.send(crossMessage)).error, 'ERR_UPLOAD_SCOPE');
  assert.equal(frameInput.assignments, 0);
});

test('a page clearing its file selection leaves an uncertain upload and never replays the action', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const input = nativeFileInput(value.frames[0]);
  input.dispatchEvent = event => { if (event.type === 'change') queueMicrotask(() => { input._files = []; }); return true; };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const message = uploadAction(observation.snapshotId);
  const result = await value.send(message);
  assert.equal(result.error, 'ERR_UPLOAD_UNCERTAIN');
  assert.equal(result.diagnostics.executionStatus, 'uncertain');
  assert.notEqual(result.upload?.fileSelected, true);
  assert.equal((await value.send(message)).error, 'ERR_UPLOAD_UNCERTAIN');
  assert.equal(input.assignments, 1);
});

test('pausing during upload settlement stops verification without pretending the selected file was undone', async () => {
  const value = await fixture({ referenceImages: [uploadImage] });
  const input = nativeFileInput(value.frames[0]);
  let pause;
  input.dispatchEvent = event => { if (event.type === 'change') queueMicrotask(() => { pause = value.send({ type: 'AGENT_PAUSE' }); }); return true; };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send(uploadAction(observation.snapshotId));
  await pause;
  assert.equal(result.diagnostics.executionStatus, 'uncertain');
  assert.match(result.error, /^ERR_(TASK_PAUSED|UPLOAD_UNCERTAIN)$/);
  assert.equal(input.assignments, 1);
  assert.equal(input.files.length, 1);
  assert.notEqual(result.upload?.fileSelected, true);
});

test('upload rejects malformed image bytes and directory inputs before assigning files', async t => {
  for (const kind of ['bytes', 'directory']) await t.test(kind, async () => {
    const value = await fixture({ referenceImages: [{ ...uploadImage,
      ...(kind === 'bytes' ? { dataUrl: 'data:image/png;base64,aGVsbG8=' } : {}) }] });
    const input = nativeFileInput(value.frames[0]);
    if (kind === 'directory') input.webkitdirectory = true;
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const result = await value.send(uploadAction(observation.snapshotId));
    assert.equal(result.error, kind === 'bytes' ? 'ERR_UPLOAD_INVALID' : 'ERR_SAFETY_BLOCKED');
    assert.equal(result.diagnostics.executionStatus, 'not-started');
    assert.equal(input.assignments, 0);
  });
});

test('upload selection cannot be reported as verified after permission or document changes', async t => {
  for (const kind of ['grant', 'document']) await t.test(kind, async () => {
    const value = await fixture({ referenceImages: [uploadImage] });
    const input = nativeFileInput(value.frames[0]);
    input.dispatchEvent = event => {
      if (event.type === 'change') queueMicrotask(() => {
        if (kind === 'grant') delete value.data.agentOriginGrants['https://allowed.test'];
        else value.frames[0].documentId = 'new-upload-document';
      });
      return true;
    };
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const result = await value.send(uploadAction(observation.snapshotId));
    assert.equal(result.error, kind === 'grant' ? 'ERR_ORIGIN_NOT_ALLOWED' : 'ERR_PAGE_CHANGED');
    assert.equal(result.diagnostics.executionStatus, 'uncertain');
    assert.notEqual(result.upload?.fileSelected, true);
    assert.equal(input.assignments, 1);
  });
});

test('file input observations expose counts and capabilities without existing filenames or paths', async () => {
  const value = await fixture();
  const input = nativeFileInput(value.frames[0]);
  input._files = [{ name: 'PRIVATE_CUSTOMER_RECORD.png', size: 120 }];
  Object.defineProperty(input, 'value', { get() { throw new Error('file paths must never be read'); } });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements[0].fileInput.selectedFileCount, 1);
  assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_CUSTOMER_RECORD|fakepath/);
});

test('guarded capture returns evidence only for the observed active document', async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const request = { type: 'AGENT_CAPTURE', expectedUrl: 'https://allowed.test/app',
    documentId: value.frames[0].documentId, snapshotId: observation.snapshotId };
  const result = await value.send(request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.url, request.expectedUrl);
  assert.equal(result.documentId, request.documentId);
  assert.equal(result.snapshotId, request.snapshotId);
  assert.equal(value.captureCalls, 1);
});

const missingCapturePermission = () => { throw new Error("Either the '<all_urls>' or 'activeTab' permission is required."); };
const guardedCapture = observation => ({ type: 'AGENT_CAPTURE', expectedUrl: observation.url,
  documentId: observation.documentId, snapshotId: observation.snapshotId });
const captureFailureForChange = { url: 'ERR_PAGE_CHANGED', document: 'ERR_PAGE_CHANGED', 'active-tab': 'ERR_TAB_NOT_ACTIVE',
  grant: 'ERR_ORIGIN_NOT_ALLOWED', control: 'ERR_CONTROL_DISABLED', viewport: 'ERR_SNAPSHOT_EXPIRED', scroll: 'ERR_SNAPSHOT_EXPIRED' };
const changeCaptureTarget = (value, kind) => {
  if (kind === 'url') { value.setTabUrl('https://allowed.test/changed'); value.frames[0].context.location.href = 'https://allowed.test/changed'; }
  if (kind === 'document') value.frames[0].documentId = 'replacement-capture-document';
  if (kind === 'active-tab') value.setActiveTabId(2);
  if (kind === 'grant') value.data.agentOriginGrants = {};
  if (kind === 'control') value.data.agentSettings.enabled = false;
  if (kind === 'viewport') value.frames[0].context.innerWidth += 100;
  if (kind === 'scroll') value.frames[0].context.scrollY = 80;
};

test('a missing activeTab grant falls back once to a permitted viewport JPEG with fixed source identity', async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  value.setBeforeCapture(missingCapturePermission);
  const result = await value.send(guardedCapture(observation));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dataUrl, 'data:image/jpeg;base64,ZmFrZS1jZHA=');
  assert.equal(result.url, observation.url);
  assert.equal(result.documentId, observation.documentId);
  assert.equal(result.snapshotId, observation.snapshotId);
  assert.deepEqual(result.viewport, observation.viewport);
  assert.equal(value.captureCalls, 1);
  assert.deepEqual(value.debuggerCalls.map(call => call.method), ['attach', 'Page.captureScreenshot', 'detach']);
  assert.deepEqual(value.debuggerCalls[1].parameters, { format: 'jpeg', quality: 62, fromSurface: true, captureBeyondViewport: false });
  assert.deepEqual(value.debuggerCalls[1].target, { tabId: 1 });
});

test('capture refusals and arbitrary native errors never invoke the debugger fallback', async t => {
  for (const message of ['The user cancelled screenshot', 'activeTab permission was denied', 'Capture is disabled', 'No screenshot available']) {
    await t.test(message, async () => {
      const value = await fixture();
      const observation = await value.send({ type: 'AGENT_OBSERVE' });
      value.setBeforeCapture(() => { throw new Error(message); });
      const result = await value.send(guardedCapture(observation));
      assert.equal(result.error, 'ERR_CAPTURE_FAILED');
      assert.equal(result.dataUrl, undefined);
      assert.equal(value.debuggerCalls.length, 0);
    });
  }
});

test('an unpinned approval screenshot does not acquire a debugger after a missing activeTab grant', async () => {
  const value = await fixture();
  value.setBeforeCapture(missingCapturePermission);
  const result = await value.send({ type: 'AGENT_CAPTURE' });
  assert.equal(result.error, 'ERR_CAPTURE_FAILED');
  assert.equal(result.dataUrl, undefined);
  assert.equal(value.debuggerCalls.length, 0);
});

test('a document ID without a complete URL cannot expand the debugger capture scope', async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  value.setBeforeCapture(missingCapturePermission);
  const result = await value.send({ type: 'AGENT_CAPTURE', documentId: observation.documentId });
  assert.equal(result.error, 'ERR_CAPTURE_FAILED');
  assert.equal(result.dataUrl, undefined);
  assert.equal(value.debuggerCalls.length, 0);
});

for (const phase of ['native-rejection', 'attached', 'screenshot']) {
  test(`fallback rechecks task target and geometry after ${phase} without publishing a stale screenshot`, async t => {
    for (const kind of Object.keys(captureFailureForChange)) await t.test(kind, async () => {
      const value = await fixture();
      const observation = await value.send({ type: 'AGENT_OBSERVE' });
      value.setBeforeCapture(() => { if (phase === 'native-rejection') changeCaptureTarget(value, kind); missingCapturePermission(); });
      if (phase === 'attached') value.setBeforeAttach(() => changeCaptureTarget(value, kind));
      if (phase === 'screenshot') value.setBeforeCommand(() => changeCaptureTarget(value, kind));
      const result = await value.send(guardedCapture(observation));
      assert.equal(result.error, captureFailureForChange[kind], JSON.stringify(result));
      assert.equal(result.dataUrl, undefined);
      const commands = value.debuggerCalls.filter(call => call.method === 'Page.captureScreenshot');
      assert.equal(commands.length, phase === 'screenshot' ? 1 : 0);
      assert.equal(value.debuggerCalls.filter(call => call.method === 'attach').length, phase === 'native-rejection' ? 0 : 1);
      assert.equal(value.debuggerCalls.filter(call => call.method === 'detach').length, phase === 'native-rejection' ? 0 : 1);
    });
  });
}

test('cancelled missing-grant native captures never start a debugger attachment', async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  value.setBeforeCapture(async () => { await value.send({ type: 'AGENT_CANCEL' }); missingCapturePermission(); });
  const result = await value.send(guardedCapture(observation));
  assert.equal(result.error, 'ERR_TASK_PAUSED');
  assert.equal(result.dataUrl, undefined);
  assert.equal(value.debuggerCalls.length, 0);
});

for (const phase of ['attach', 'command']) {
  test(`cancelling a pending debugger ${phase} returns promptly and discards its late screenshot`, { timeout: 1800 }, async () => {
    const value = await fixture();
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    let release, entered;
    const pending = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    value.setBeforeCapture(missingCapturePermission);
    if (phase === 'attach') value.setBeforeAttach(() => { entered(); return pending; });
    else value.setBeforeCommand(() => { entered(); return pending; });
    const request = value.send(guardedCapture(observation));
    await ready;
    await value.send({ type: 'AGENT_CANCEL' });
    const result = await Promise.race([request, new Promise((_, reject) => setTimeout(() => reject(new Error('capture did not cancel promptly')), 500))]);
    assert.equal(result.error, 'ERR_TASK_PAUSED');
    assert.equal(result.dataUrl, undefined);
    release({ data: 'bGF0ZS1zY3JlZW5zaG90' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(value.debuggerCalls.filter(call => call.method === 'Page.captureScreenshot').length, phase === 'attach' ? 0 : 1);
    assert.equal(value.debuggerCalls.filter(call => call.method === 'detach').length, 1);
  });
}

test('a debugger already leased for reading fails capture clearly without a second attachment', async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const reading = withPageDebugger({ tabId: 1 }, async () => { entered(); await pending; }, { chrome: globalThis.chrome, timeoutMs: 2000 });
  await ready;
  value.setBeforeCapture(missingCapturePermission);
  const result = await value.send(guardedCapture(observation));
  assert.equal(result.error, 'ERR_CAPTURE_DEBUGGER_BUSY');
  assert.equal(result.dataUrl, undefined);
  assert.equal(value.debuggerCalls.filter(call => call.method === 'attach').length, 1);
  assert.equal(value.debuggerCalls.some(call => call.method === 'Page.captureScreenshot'), false);
  release(); await reading;
});

test('the shared three-second capture deadline prevents a late native rejection from attaching a debugger', { timeout: 5000 }, async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  let rejectNative;
  const pending = new Promise((_, reject) => { rejectNative = reject; });
  value.setBeforeCapture(() => pending);
  const started = performance.now();
  const result = await value.send(guardedCapture(observation));
  assert.equal(result.error, 'ERR_CAPTURE_TIMEOUT');
  assert.equal(result.dataUrl, undefined);
  assert.ok(performance.now() - started < 3800);
  rejectNative(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.debuggerCalls.length, 0);
});

test('a capture snapshot supplies document identity when the caller omits the explicit document ID', async t => {
  for (const timing of ['before', 'after']) await t.test(timing, async () => {
    const value = await fixture();
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    assert.equal(observation.documentId, value.frames[0].documentId);
    const request = { type: 'AGENT_CAPTURE', expectedUrl: 'https://allowed.test/app', snapshotId: observation.snapshotId };
    const replace = () => { value.frames[0].documentId = 'replacement-same-url'; };
    if (timing === 'before') replace(); else value.setBeforeCapture(replace);
    const result = await value.send(request);
    assert.equal(result.error, 'ERR_PAGE_CHANGED');
    assert.equal(result.dataUrl, undefined);
    assert.equal(value.captureCalls, timing === 'before' ? 0 : 1);
  });
});

test('local visual capture rejects stale viewport and scroll geometry before or after screenshot', async t => {
  for (const timing of ['before', 'after']) for (const change of ['viewport', 'scroll']) await t.test(`${timing}-${change}`, async () => {
    const value = await fixture();
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const modify = () => {
      if (change === 'viewport') value.frames[0].context.innerWidth += 120;
      else value.frames[0].context.scrollY = 80;
    };
    if (timing === 'before') modify(); else value.setBeforeCapture(modify);
    const result = await value.send({ type: 'AGENT_CAPTURE', expectedUrl: observation.url,
      documentId: observation.documentId, snapshotId: observation.snapshotId });
    assert.equal(result.error, 'ERR_SNAPSHOT_EXPIRED');
    assert.equal(result.dataUrl, undefined);
    assert.equal(value.captureCalls, timing === 'before' ? 0 : 1);
  });
});

test('guarded capture rejects URL, document and active-tab changes before or after capture', async t => {
  for (const timing of ['before', 'after']) for (const kind of ['url', 'document', 'active-tab']) {
    await t.test(`${timing}-${kind}`, async () => {
      const value = await fixture();
      const observation = await value.send({ type: 'AGENT_OBSERVE' });
      const request = { type: 'AGENT_CAPTURE', expectedUrl: 'https://allowed.test/app',
        documentId: value.frames[0].documentId, snapshotId: observation.snapshotId };
      const change = () => {
        if (kind === 'url') { value.setTabUrl('https://allowed.test/changed'); value.frames[0].context.location.href = 'https://allowed.test/changed'; }
        if (kind === 'document') value.frames[0].documentId = 'replacement-document';
        if (kind === 'active-tab') value.setActiveTabId(2);
      };
      if (timing === 'before') change(); else value.setBeforeCapture(change);
      const result = await value.send(request);
      assert.equal(result.error, kind === 'active-tab' ? 'ERR_TAB_NOT_ACTIVE' : 'ERR_PAGE_CHANGED', JSON.stringify(result));
      assert.equal(result.dataUrl, undefined);
      assert.equal(value.captureCalls, timing === 'before' ? 0 : 1);
    });
  }
});

test('cancelled capture tasks never publish a screenshot returned after cancellation', async t => {
  for (const timing of ['before', 'during']) await t.test(timing, async () => {
    const value = await fixture();
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const request = { type: 'AGENT_CAPTURE', expectedUrl: 'https://allowed.test/app',
      documentId: value.frames[0].documentId, snapshotId: observation.snapshotId };
    if (timing === 'before') await value.send({ type: 'AGENT_CANCEL' });
    else value.setBeforeCapture(() => value.send({ type: 'AGENT_CANCEL' }));
    const result = await value.send(request);
    assert.equal(result.error, 'ERR_TASK_PAUSED');
    assert.equal(result.dataUrl, undefined);
    assert.equal(value.captureCalls, timing === 'before' ? 0 : 1);
  });
});

const sortedTransfer = value => Array.isArray(value) ? value.map(sortedTransfer)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedTransfer(value[key])])) : value;

test('unapproved iframe is excluded and approved local IDs map to global action IDs', async () => {
  const denied = await fixture({ childOrigin: 'https://unapproved.test', grantChild: false });
  const filtered = await denied.send({ type: 'AGENT_OBSERVE' });
  assert.equal(filtered.elements.length, 1);
  assert.deepEqual(filtered.blockedFrameOrigins, ['https://unapproved.test']);
  const allowed = await fixture();
  const observation = await allowed.send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements[1].id, 'e2');
  const result = await allowed.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'click', action: 'click_element', args: { elementId: 'e2' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(allowed.frames[1].elements[0].clicks, 1);
});

test('fresh risk metadata invalidates an approval when a button changes meaning', async () => {
  const { send, frames } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  frames[0].elements[0].innerText = '删除记录';
  const result = await send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'click', approval: { confirmed: true, actionId: 'click' }, action: 'click_element', args: { elementId: 'e1' } });
  assert.equal(result.error, 'ERR_ELEMENT_CHANGED');
  assert.equal(frames[0].elements[0].clicks, 0);
});

test('scripting result key order does not invalidate unchanged select semantics', async () => {
  const value = await fixture({ serializeResult: sortedTransfer });
  const select = nativeSelect(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'reordered-select',
    action: 'select_option', args: { elementId: 'e1', value: '2.6' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(select.value, '2.6');
});

test('reordered scripting results still reject a real semantic change before selecting', async () => {
  const value = await fixture({ serializeResult: sortedTransfer });
  const select = nativeSelect(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  select.attributes['aria-label'] = 'PRIVATE_CHANGED_FIELD';
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'changed-select',
    action: 'select_option', args: { elementId: 'e1', value: '2.6' } });
  assert.equal(result.error, 'ERR_ELEMENT_CHANGED');
  assert.equal(select.value, '2.5');
  assert.deepEqual(result.diagnostics.changedFields, ['name']);
  assert.equal(result.diagnostics.executionStatus, 'not-started');
  assert.ok(result.diagnostics.snapshotAgeMs >= 0);
  assert.doesNotMatch(JSON.stringify([result.diagnostics, value.diagnostics]), /PRIVATE_CHANGED_FIELD|"2\.5"|"2\.6"/);
});

test('native and ARIA choice states are observable without reading editable text values', async () => {
  const value = await fixture();
  const checkbox = value.frames[0].elements[0];
  Object.assign(checkbox, { tagName: 'INPUT', type: 'checkbox', checked: true, value: 'PRIVATE_INPUT_VALUE',
    attributes: { 'aria-label': 'Animation' } });
  const toggle = value.frames[1].elements[0];
  toggle.attributes = { role: 'checkbox', 'aria-checked': 'mixed', 'aria-pressed': 'false' };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements[0].state.checked, true);
  assert.equal(observation.elements[1].state.checked, 'mixed');
  assert.equal(observation.elements[1].state.pressed, false);
  assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_INPUT_VALUE/);
  checkbox.indeterminate = true;
  const mixed = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(mixed.elements[0].state.checked, 'mixed');
});

test('native select observations retain bounded choices and an out-of-window selection', async () => {
  const value = await fixture();
  const select = nativeSelect(value.frames[0], Array.from({ length: 70 }, (_, index) => `Model ${index}`));
  select.value = 'Model 65';
  select.options[1].disabled = true;
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const choice = observation.elements[0].select;
  assert.equal(choice.optionCount, 70);
  assert.equal(choice.options.length, 40);
  assert.equal(choice.options[1].disabled, true);
  assert.deepEqual(structuredClone(choice.selected), [{ value: 'Model 65', text: 'Model 65' }]);
  assert.equal(choice.truncated, true);
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'bounded-select',
    action: 'select_option', args: { elementId: 'e1', value: 'Model 65' } });
  assert.equal(result.ok, true, 'choice observation data must not contaminate the permission signature');
});

test('select verifies the retained value after page updates and never repeats rolled-back events', async () => {
  const value = await fixture();
  const select = nativeSelect(value.frames[0]);
  let events = 0;
  select.dispatchEvent = event => {
    events++;
    if (event.type === 'change') queueMicrotask(() => { select.value = '2.5'; });
    return true;
  };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const message = { type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'rolled-back-select',
    action: 'select_option', args: { elementId: 'e1', value: '2.6' } };
  const result = await value.send(message);
  assert.equal(result.error, 'ERR_ACTION_NOT_APPLIED');
  assert.equal(result.diagnostics.failureStage, 'check');
  assert.equal(result.diagnostics.executionStatus, 'started');
  assert.equal(result.diagnostics.stages.at(-1).valueMatched, false);
  assert.equal(select.value, '2.5');
  assert.equal(events, 2);
  const duplicate = await value.send(message);
  assert.equal(duplicate.error, result.error);
  assert.equal(events, 2, 'the same actionId must return its result without dispatching again');
});

test('disabled select options are rejected before any input or change event', async () => {
  const value = await fixture();
  const select = nativeSelect(value.frames[0]);
  select.options[1].disabled = true;
  let events = 0;
  select.dispatchEvent = () => { events++; return true; };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'disabled-option',
    action: 'select_option', args: { elementId: 'e1', value: '2.6' } });
  assert.equal(result.error, 'ERR_ELEMENT_DISABLED');
  assert.equal(result.diagnostics.executionStatus, 'not-started');
  assert.equal(select.value, '2.5');
  assert.equal(events, 0);
});

test('cancelling while a select settles cannot publish a successful result or replay the write', async () => {
  const value = await fixture();
  const select = nativeSelect(value.frames[0]);
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  let events = 0;
  select.dispatchEvent = event => { events++; if (event.type === 'change') entered(); return true; };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const pending = value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'cancel-select',
    action: 'select_option', args: { elementId: 'e1', value: '2.6' } });
  await reached;
  await value.send({ type: 'AGENT_CANCEL' });
  const result = await pending;
  assert.equal(result.error, 'ERR_TASK_PAUSED');
  assert.equal(result.diagnostics.executionStatus, 'uncertain');
  assert.equal(events, 2);
  assert.equal(select.value, '2.6', 'cancelling a wait does not undo a dispatched write');
});

test('select never reports success after a route change or detached target during page updates', async t => {
  for (const change of ['route', 'detached']) await t.test(change, async () => {
    const value = await fixture();
    const select = nativeSelect(value.frames[0]);
    select.dispatchEvent = event => {
      if (event.type === 'change') queueMicrotask(() => {
        if (change === 'route') value.frames[0].context.location.hash = '/different';
        else select.isConnected = false;
      });
      return true;
    };
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: `changed-${change}`,
      action: 'select_option', args: { elementId: 'e1', value: '2.6' } });
    assert.equal(result.error, change === 'route' ? 'ERR_PAGE_CHANGED' : 'ERR_ELEMENT_DETACHED');
    assert.equal(result.diagnostics.executionStatus, 'uncertain');
  });
});

test('select rechecks permission and document identity before publishing its retained value', async t => {
  for (const change of ['grant', 'document']) await t.test(change, async () => {
    const value = await fixture();
    const select = nativeSelect(value.frames[0]);
    select.dispatchEvent = event => {
      if (event.type === 'change') queueMicrotask(() => {
        if (change === 'grant') value.data.agentOriginGrants = {};
        else value.frames[0].documentId = 'replacement-document';
      });
      return true;
    };
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: `revoked-${change}`,
      action: 'select_option', args: { elementId: 'e1', value: '2.6' } });
    assert.equal(result.error, change === 'grant' ? 'ERR_ORIGIN_NOT_ALLOWED' : 'ERR_PAGE_CHANGED');
    assert.equal(result.diagnostics.executionStatus, 'uncertain');
  });
});

test('cancelling at the last async boundary prevents the pending click', async () => {
  const { send, frames, setBeforeGet } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  let calls = 0;
  let unblock;
  let reached;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const atBoundary = new Promise((resolve) => { reached = resolve; });
  setBeforeGet(async () => { calls += 1; if (calls === 2) { reached(); await gate; } });
  const pending = send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'click', action: 'click_element', args: { elementId: 'e1' } });
  await atBoundary;
  assert.equal((await send({ type: 'AGENT_CANCEL' })).ok, true);
  unblock();
  assert.equal((await pending).error, 'ERR_TASK_PAUSED');
  assert.equal(frames[0].elements[0].clicks, 0);
  assert.equal((await send({ type: 'AGENT_RESUME' })).error, 'ERR_TASK_CANCELLED');
});

test('page evidence injection is self-contained and works while paused before grants are released', async () => {
  const { send, frames, data } = await fixture();
  frames[0].context.__unkAiExtractor = { extractPageContent() { return { text: 'Verified page evidence '.repeat(5), title: 'Evidence' }; } };
  assert.equal((await send({ type: 'AGENT_PAUSE' })).ok, true);
  const evidence = await send({ type: 'AGENT_PAGE_EVIDENCE' });
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.match(evidence.text, /Verified page evidence/);
  assert.ok(data.agentOriginGrants['https://allowed.test']);
  await send({ type: 'AGENT_RELEASE' });
  assert.equal((await send({ type: 'AGENT_PAGE_EVIDENCE' })).error, 'ERR_TASK_PAUSED');
});

test('scanner rechecks semantics at the actual mutation and consumes task invalidation', async () => {
  const { send, frames } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  const { context, elements } = frames[0];
  const scanner = context.__unkAiAgentScanner;
  const inspection = scanner.inspect(observation.snapshotId, 'e1');
  const records = context.__unkAiAgentSnapshots.get(observation.snapshotId);
  const expected = { signature: inspection.signature, frameOrigin: 'https://allowed.test', taskId: 'task', epoch: records.epoch };
  elements[0].attributes.formaction = 'https://other.test';
  elements[0].innerText = 'Pay now';
  assert.equal(scanner.perform(observation.snapshotId, 'e1', 'click_element', {}, expected).error, 'ERR_ELEMENT_CHANGED');
  scanner.cancelTask('task');
  assert.equal(scanner.perform(observation.snapshotId, 'e1', 'click_element', {}, expected).error, 'ERR_SNAPSHOT_EXPIRED');
  assert.equal(elements[0].clicks, 0);
});

test('scanner observations do not expose text stored in editable controls', async () => {
  const { send, frames } = await fixture();
  const element = frames[0].elements[0];
  element.tagName = 'TEXTAREA';
  element.innerText = 'private unsent message';
  element.textContent = 'private unsent message';
  element.attributes['aria-label'] = 'Message';
  const observation = await send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements[0].name, 'Message');
  assert.equal(observation.elements[0].text, '');
  assert.doesNotMatch(JSON.stringify(observation), /private unsent message/);
});

test('stopping interrupts a pending long wait instead of retaining the execution queue', { timeout: 1000 }, async () => {
  const { send } = await fixture();
  const waiting = send({ type: 'AGENT_WAIT', actionId: 'wait', args: { seconds: 10 } });
  await new Promise((resolve) => setImmediate(resolve));
  await send({ type: 'AGENT_CANCEL' });
  assert.equal((await waiting).error, 'ERR_TASK_PAUSED');
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const never = () => new Promise(() => {});
const isScanRequest = request => request.func?.name === 'scanInjected';
const isOverlayRequest = request => request.func?.toString().includes('shouldShow');

test('a stalled all-frame injection falls back promptly to immediate main-frame observation', async (t) => {
  const { send, scriptRequests, setBeforeScript } = await fixture({ childOrigin: 'https://comments.test', grantChild: false });
  setBeforeScript(request => request.files && request.target.allFrames ? never() : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send({ type: 'AGENT_OBSERVE' });
  await turn();
  t.mock.timers.tick(2501);
  const observation = await pending;
  assert.equal(observation.frames, 1);
  assert.equal(observation.elements[0].name, '展开');
  const reads = scriptRequests.filter(request => request.files || isScanRequest(request));
  assert.equal(reads.length, 3);
  assert.equal(reads[0].target.allFrames, true);
  assert.ok(reads.slice(1).every(request => !request.target.allFrames));
  assert.ok(reads.every(request => request.injectImmediately === true));
});

test('a stalled all-frame scan falls back to the main frame and keeps a bounded result', async (t) => {
  const { send, scriptRequests, setBeforeScript } = await fixture();
  setBeforeScript(request => isScanRequest(request) && request.target.allFrames ? never() : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send({ type: 'AGENT_OBSERVE' });
  await turn();
  t.mock.timers.tick(2501);
  const observation = await pending;
  assert.equal(observation.frames, 1);
  assert.equal(observation.elements[0].name, '展开');
  const scans = scriptRequests.filter(isScanRequest);
  assert.equal(scans.length, 2);
  assert.equal(scans[0].target.allFrames, true);
  assert.equal(scans[1].target.allFrames, undefined);
  assert.ok(scans.every(request => request.injectImmediately === true));
  assert.ok(scans[0].args[2].expiresAt < scans[1].args[2].expiresAt);
});

test('the overall observation deadline includes stalled main-frame injection and releases only the read queue', async (t) => {
  const { send, setBeforeScript } = await fixture();
  setBeforeScript(request => request.files ? never() : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send({ type: 'AGENT_OBSERVE' });
  await turn();
  t.mock.timers.tick(2501);
  await turn();
  t.mock.timers.tick(17500);
  assert.equal((await pending).error, 'ERR_PAGE_OBSERVE_TIMEOUT');
  setBeforeScript(null);
  await turn();
  const next = await send({ type: 'AGENT_OBSERVE' });
  assert.equal(next.elements[0].name, '展开');
});

test('cancelling an in-flight observation does not wait for its script result and allows resumed reads', async () => {
  const { send, setBeforeScript } = await fixture();
  setBeforeScript(request => isScanRequest(request) ? never() : undefined);
  const pending = send({ type: 'AGENT_OBSERVE' });
  await turn();
  assert.equal((await send({ type: 'AGENT_PAUSE' })).ok, true);
  assert.equal((await pending).error, 'ERR_TASK_PAUSED');
  setBeforeScript(null);
  assert.equal((await send({ type: 'AGENT_RESUME' })).ok, true);
  const next = await send({ type: 'AGENT_OBSERVE' });
  assert.equal(next.elements.length, 2);
});

test('a late expired scan is not published as an actionable background snapshot', async (t) => {
  const { send, frames, scriptRequests, setBeforeScript } = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setBeforeScript(request => isScanRequest(request) ? gate : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send({ type: 'AGENT_OBSERVE' });
  await turn();
  const staleId = scriptRequests.find(isScanRequest).args[0];
  t.mock.timers.tick(2501);
  await turn();
  t.mock.timers.tick(17500);
  assert.equal((await pending).error, 'ERR_PAGE_OBSERVE_TIMEOUT');
  for (const frame of frames) frame.context.Date = { now: () => Date.now() + 30000 };
  release();
  await turn();
  const result = await send({ type: 'AGENT_ACT', snapshotId: staleId, actionId: 'stale', action: 'click_element', args: { elementId: 'e1' } });
  assert.equal(result.error, 'ERR_SNAPSHOT_EXPIRED');
  assert.equal(frames[0].elements[0].clicks, 0);
  assert.equal(frames[0].context.__unkAiAgentSnapshots.has(staleId), false);
});

test('a stalled overlay releases its queue before the observation deadline', async (t) => {
  const { send, setBeforeScript } = await fixture();
  setBeforeScript(request => isOverlayRequest(request) ? never() : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const overlay = send({ type: 'AGENT_OVERLAY', visible: true });
  await turn();
  const observing = send({ type: 'AGENT_OBSERVE' });
  await turn();
  t.mock.timers.tick(2001);
  assert.equal((await overlay).error, 'ERR_OVERLAY_TIMEOUT');
  const observation = await observing;
  assert.equal(observation.elements.length, 2);
});

test('an overlay script that runs after its deadline never shows a stale task prompt', async (t) => {
  const { send, frames, setBeforeScript } = await fixture();
  let shown = 0;
  frames[0].context.__unkAiAgentScanner = { version: 3, showOverlay: () => { shown += 1; return { ok: true }; } };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setBeforeScript(request => isOverlayRequest(request) ? gate : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send({ type: 'AGENT_OVERLAY', visible: true });
  await turn();
  t.mock.timers.tick(2001);
  assert.equal((await pending).error, 'ERR_OVERLAY_TIMEOUT');
  frames[0].context.Date = { now: () => Date.now() + 3000 };
  release();
  await turn();
  assert.equal(shown, 0);
});

test('an observation timeout does not release an uncertain DOM action ahead of it', async (t) => {
  const { send, frames, scriptRequests, setBeforeScript } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markPerformEntered;
  const performEntered = new Promise(resolve => { markPerformEntered = resolve; });
  setBeforeScript(request => {
    if (!request.func?.toString().includes('scanner?.perform')) return;
    markPerformEntered();
    return gate;
  });
  const action = send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'first', action: 'click_element', args: { elementId: 'e1' } });
  let actionFinished = false;
  void action.then(() => { actionFinished = true; });
  // Start the read deadline only once the preceding action actually holds
  // the execution queue at the side-effect boundary, regardless of load.
  await Promise.race([performEntered, action.then(result => {
    throw new Error(`Action completed before entering the perform gate: ${JSON.stringify(result)}`);
  })]);
  const scansBefore = scriptRequests.filter(isScanRequest).length;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send({ type: 'AGENT_OBSERVE' });
  await turn();
  t.mock.timers.tick(20001);
  assert.equal((await pending).error, 'ERR_PAGE_OBSERVE_TIMEOUT');
  assert.equal(actionFinished, false);
  assert.equal(scriptRequests.filter(isScanRequest).length, scansBefore);
  assert.equal(frames[0].elements[0].clicks, 0);
  await send({ type: 'AGENT_CANCEL' });
  release();
  await turn();
  t.mock.timers.tick(181);
  await action;
  assert.equal(frames[0].elements[0].clicks, 0);
});

test('showing the initial overlay injects the main-frame scanner before the first observation', async () => {
  const { send, frames, scriptRequests } = await fixture();
  const result = await send({ type: 'AGENT_OVERLAY', visible: true, goal: 'Read this page' });
  assert.equal(result.ok, true);
  assert.ok(scriptRequests[0].files);
  assert.equal(scriptRequests[0].target.allFrames, undefined);
  assert.equal(scriptRequests[0].injectImmediately, true);
  const document = frames[0].context.document;
  assert.ok(document.getElementById('__unk_ai_agent_overlay'));
  assert.doesNotMatch(document.getElementById('__unk_ai_agent_overlay_style').textContent, /pointer-events: auto/);
  assert.equal(frames[0].listeners.get('pointerdown').size, 1);
  const observation = await send({ type: 'AGENT_OBSERVE' });
  const clicked = await send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'click-overlay-visible', action: 'click_element', args: { elementId: 'e1' } });
  assert.equal(clicked.ok, true);
  assert.equal(frames[0].elements[0].clicks, 1);
  assert.equal(frames[0].messages.length, 0);
});

test('trusted manual input revokes snapshots without depending on the visual overlay', async (t) => {
  for (const type of ['pointerdown', 'click', 'keydown', 'wheel', 'beforeinput', 'input']) {
    await t.test(type, async () => {
      const { send, frames } = await fixture();
      const observation = await send({ type: 'AGENT_OBSERVE' });
      assert.equal(frames[0].context.document.getElementById('__unk_ai_agent_overlay'), null);
      const takeover = frames[0].dispatch(type, { isTrusted: true });
      assert.equal(takeover.prevented, true);
      assert.equal(frames[0].context.__unkAiAgentSnapshots.has(observation.snapshotId), false);
      assert.equal(frames[0].messages.length, 1);
      assert.equal(frames[0].messages[0].type, 'AGENT_TAKEOVER');
      const action = await send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: `after-${type}`, action: 'click_element', args: { elementId: 'e1' } });
      assert.equal(action.error, 'ERR_SNAPSHOT_EXPIRED');
      assert.equal(frames[0].elements[0].clicks, 0);
      if (type === 'pointerdown') {
        assert.equal(frames[0].dispatch('pointerup', { isTrusted: true }).prevented, true);
        assert.equal(frames[0].dispatch('click', { isTrusted: true }).prevented, true);
      }
      assert.equal(frames[0].dispatch('click', { isTrusted: true }).prevented, false);
    });
  }
});

test('synthetic click and input events do not interrupt the task', async () => {
  const { send, frames } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  for (const type of ['pointerdown', 'click', 'keydown', 'wheel', 'beforeinput', 'input']) {
    assert.equal(frames[0].dispatch(type).prevented, false);
  }
  assert.equal(frames[0].messages.length, 0);
  assert.equal(frames[0].context.__unkAiAgentSnapshots.has(observation.snapshotId), true);
  frames[0].elements[0].tagName = 'TEXTAREA';
  frames[0].elements[0].attributes['aria-label'] = 'Message';
  const editable = await send({ type: 'AGENT_OBSERVE' });
  const action = await send({ type: 'AGENT_ACT', snapshotId: editable.snapshotId, actionId: 'synthetic-input', action: 'type_text', args: { elementId: 'e1', text: 'hello' } });
  assert.equal(action.ok, true);
  assert.equal(frames[0].messages.length, 0);
});

test('input diagnostics locate a rejected write without recording its value, label or page text', async () => {
  const value = await fixture();
  const input = value.frames[0].elements[0];
  Object.assign(input, { tagName: 'INPUT', type: 'text', value: '', innerText: '', textContent: '',
    attributes: { 'aria-label': 'PRIVATE_FIELD_LABEL' }, select() {},
    dispatchEvent(event) { if (event.type === 'input') this.value = ''; return true; } });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'input-failure',
    action: 'type_text', args: { elementId: 'e1', text: 'PRIVATE_INPUT_BODY' } });
  assert.equal(result.error, 'ERR_ACTION_FAILED');
  assert.equal(value.frames[0].context.document.activeElement, input);
  assert.equal(result.diagnostics.failureStage, 'check');
  const check = result.diagnostics.stages.find(stage => stage.stage === 'check');
  assert.equal(check.expectedChars, 18);
  assert.equal(check.actualChars, 0);
  assert.equal(check.valueMatched, false);
  assert.ok(result.diagnostics.stages.some(stage => stage.stage === 'focus' && stage.focused));
  const failed = value.diagnostics.find(entry => entry.event === 'agent.action.failed');
  assert.equal(failed.context.actionId, 'input-failure');
  assert.equal(failed.context.snapshotId, observation.snapshotId);
  assert.equal(failed.data.failureStage, 'check');
  assert.equal(failed.error.code, 'ERR_ACTION_FAILED');
  assert.ok(value.diagnostics.some(entry => entry.event === 'agent.input.stage' && entry.data.stage === 'events'));
  assert.doesNotMatch(JSON.stringify([result.diagnostics, value.diagnostics]), /PRIVATE_|Actual page evidence|allowed\.test/);
});

test('diagnostics distinguish pre-write selection errors and permission denial', async () => {
  const value = await fixture();
  const input = value.frames[0].elements[0];
  Object.assign(input, { tagName: 'INPUT', type: 'text', value: '', innerText: '', textContent: '',
    attributes: { 'aria-label': 'Field' }, select() { throw Object.assign(new Error('PRIVATE_SELECT_ERROR'), { name: 'InvalidStateError' }); } });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'select-failure',
    action: 'type_text', args: { elementId: 'e1', text: 'PRIVATE_INPUT_BODY' } });
  assert.equal(result.error, 'ERR_ACTION_FAILED');
  assert.equal(result.diagnostics.failureStage, 'select');
  assert.equal(result.diagnostics.errorName, 'InvalidStateError');
  assert.equal(value.diagnostics.find(entry => entry.event === 'agent.action.failed').error.name, 'InvalidStateError');
  assert.equal(input.value, '');
  value.data.agentOriginGrants = {};
  const denied = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'permission-failure',
    action: 'type_text', args: { elementId: 'e1', text: 'PRIVATE_INPUT_BODY' } });
  assert.equal(denied.error, 'ERR_ORIGIN_NOT_ALLOWED');
  const failure = value.diagnostics.find(entry => entry.event === 'agent.action.failed' && entry.context.actionId === 'permission-failure');
  assert.equal(failure.data.failureStage, 'control-permission');
  assert.doesNotMatch(JSON.stringify(value.diagnostics), /PRIVATE_|allowed\.test/);
});

test('a detached input reports current connection state at the inspection failure without attempting a write', async () => {
  const value = await fixture();
  const input = value.frames[0].elements[0];
  Object.assign(input, { tagName: 'INPUT', type: 'text', value: '', innerText: '', textContent: '', attributes: { 'aria-label': 'Field' } });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  input.isConnected = false;
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'detached-input',
    action: 'type_text', args: { elementId: 'e1', text: 'sample' } });
  assert.equal(result.error, 'ERR_ELEMENT_DETACHED');
  assert.equal(input.value, '');
  const event = value.diagnostics.find(entry => entry.event === 'agent.action.failed');
  assert.equal(event.data.failureStage, 'inspect');
  assert.equal(event.data.connected, false);
  assert.equal(event.data.expectedChars, 6);
});

test('throwing or rejected diagnostic writes do not change a successful page action', async t => {
  for (const reject of [false, true]) await t.test(String(reject), async () => {
    const value = await fixture({ recordDiagnostic() { if (reject) return Promise.reject(new Error('diagnostic unavailable')); throw new Error('diagnostic unavailable'); } });
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'logger-failure',
      action: 'click_element', args: { elementId: 'e1' } });
    assert.equal(result.ok, true);
    assert.equal(value.frames[0].elements[0].clicks, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(value.diagnostics.some(entry => entry.event === 'agent.action.completed'));
  });
});

test('a cancelled backend action keeps its diagnostic identity and never logs the late result as success', async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  value.setBeforeScript(request => {
    if (request.func?.toString().includes('scanner?.perform')) { entered(); return gate; }
  });
  const pending = value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'cancelled-original',
    action: 'click_element', args: { elementId: 'e1' }, diagnosticContext: { conversationId: 'original-conversation', runId: 'original-run' } });
  await reached;
  await value.send({ type: 'AGENT_CANCEL' });
  release();
  const result = await pending;
  assert.ok(result.error);
  const events = value.diagnostics.filter(entry => entry.context.actionId === 'cancelled-original');
  assert.ok(events.length);
  assert.ok(events.every(entry => entry.context.conversationId === 'original-conversation' && entry.context.runId === 'original-run'));
  assert.equal(events.some(entry => entry.event === 'agent.action.completed'), false);
  assert.equal(events.filter(entry => entry.event === 'agent.action.failed').length, 1);
  assert.equal(value.frames[0].elements[0].clicks, 0);
});

test('input diagnostics describe partial acceptance without changing the existing input result or replaying events', async () => {
  const value = await fixture();
  const input = value.frames[0].elements[0];
  let dispatched = 0;
  Object.assign(input, { tagName: 'INPUT', type: 'text', value: '', innerText: '', textContent: '', attributes: { 'aria-label': 'Field' },
    select() {}, dispatchEvent() { dispatched++; this.value = this.value.slice(-5); return true; } });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'partial-input',
    action: 'type_text', args: { elementId: 'e1', text: 'sample' } });
  assert.equal(result.ok, true, 'diagnostics must not silently change the existing tail-check behavior');
  assert.equal(dispatched, 2, 'only the existing input and change events may execute');
  const check = result.diagnostics.stages.find(stage => stage.stage === 'check');
  assert.equal(check.valueMatched, false);
  assert.equal(check.expectedChars, 6);
  assert.equal(check.actualChars, 5);
});

test('the first-click suppression expires after pointerup when a gesture has no click', async (t) => {
  const { send, frames } = await fixture();
  await send({ type: 'AGENT_OBSERVE' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  frames[0].dispatch('pointerdown', { isTrusted: true });
  frames[0].dispatch('pointerup', { isTrusted: true });
  t.mock.timers.tick(1201);
  assert.equal(frames[0].dispatch('click', { isTrusted: true }).prevented, false);
});

test('a long first press stays protected until its pointerup and click', async (t) => {
  const { send, frames } = await fixture();
  await send({ type: 'AGENT_OBSERVE' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  frames[0].dispatch('pointerdown', { isTrusted: true, pointerId: 4 });
  t.mock.timers.tick(5000);
  frames[0].dispatch('blur', { isTrusted: true, target: frames[0].elements[0] });
  assert.equal(frames[0].dispatch('pointerup', { isTrusted: true, pointerId: 9 }).prevented, false);
  assert.equal(frames[0].dispatch('pointerup', { isTrusted: true, pointerId: 4 }).prevented, true);
  assert.equal(frames[0].dispatch('click', { isTrusted: true, pointerId: 4 }).prevented, true);
  assert.equal(frames[0].dispatch('click', { isTrusted: true, pointerId: 4 }).prevented, false);
});

test('cancelled pointer gestures and window blur release the takeover click guard', async (t) => {
  for (const type of ['pointercancel', 'blur']) {
    await t.test(type, async () => {
      const { send, frames } = await fixture();
      await send({ type: 'AGENT_OBSERVE' });
      frames[0].dispatch('pointerdown', { isTrusted: true, pointerId: 4 });
      frames[0].dispatch(type, { isTrusted: true, pointerId: 4, target: vm.runInContext('globalThis', frames[0].context) });
      assert.equal(frames[0].dispatch('click', { isTrusted: true, pointerId: 4 }).prevented, false);
    });
  }
});

test('only approved frames install a takeover guard and a new document reinstalls it', async () => {
  const { send, frames } = await fixture({ childOrigin: 'https://unapproved.test', grantChild: false });
  await send({ type: 'AGENT_OBSERVE' });
  assert.equal(frames[0].listeners.get('keydown').size, 1);
  assert.equal(frames[1].listeners.get('keydown'), undefined);
  frames[0] = frame('https://allowed.test/app', ['Reloaded']);
  const observation = await send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements[0].name, 'Reloaded');
  frames[0].dispatch('keydown', { isTrusted: true });
  assert.equal(frames[0].messages.length, 1);
  assert.equal(frames[0].context.__unkAiAgentSnapshots.has(observation.snapshotId), false);
});

test('delayed cleanup from the previous epoch cannot remove a resumed task guard or snapshot', async () => {
  const { send, frames, setBeforeScript } = await fixture();
  const first = await send({ type: 'AGENT_OBSERVE' });
  const oldEpoch = frames[0].context.__unkAiAgentSnapshots.get(first.snapshotId).epoch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setBeforeScript(request => request.func?.toString().includes('expectedEpoch') ? gate : undefined);
  const pausing = send({ type: 'AGENT_PAUSE' });
  await turn();
  assert.equal((await send({ type: 'AGENT_RESUME' })).ok, true);
  const resumed = await send({ type: 'AGENT_OBSERVE' });
  const nextEpoch = frames[0].context.__unkAiAgentSnapshots.get(resumed.snapshotId).epoch;
  assert.ok(nextEpoch > oldEpoch);
  release();
  assert.equal((await pausing).ok, true);
  assert.equal(frames[0].context.__unkAiAgentSnapshots.has(resumed.snapshotId), true);
  assert.equal(frames[0].listeners.get('keydown').size, 1);
  frames[0].dispatch('keydown', { isTrusted: true });
  assert.equal(frames[0].messages.length, 1);
  assert.equal(frames[0].context.__unkAiAgentSnapshots.has(resumed.snapshotId), false);
});

test('a restarted worker skips unknown-epoch cleanup instead of clearing a resumed document', async () => {
  const { send, frames, scriptRequests, restartWorker, setBeforeScript } = await fixture();
  await send({ type: 'AGENT_OBSERVE' });
  await restartWorker();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cleanup = request => request.func?.toString().includes('expectedEpoch') || isOverlayRequest(request);
  const previousRequests = scriptRequests.length;
  setBeforeScript(request => cleanup(request) ? gate : undefined);
  const pausing = send({ type: 'AGENT_PAUSE' });
  const hiding = send({ type: 'AGENT_OVERLAY', visible: false });
  await turn();
  assert.equal((await send({ type: 'AGENT_RESUME' })).ok, true);
  const resumed = await send({ type: 'AGENT_OBSERVE' });
  release();
  assert.equal((await pausing).ok, true);
  assert.equal((await hiding).ok, true);
  assert.equal(scriptRequests.slice(previousRequests).filter(cleanup).length, 0);
  assert.equal(frames[0].context.__unkAiAgentSnapshots.has(resumed.snapshotId), true);
  assert.equal(frames[0].listeners.get('keydown').size, 1);
});

test('removing a task overlay removes its guard while stale task cleanup leaves a new task intact', async () => {
  const { send, frames } = await fixture();
  await send({ type: 'AGENT_OVERLAY', visible: true });
  await send({ type: 'AGENT_OVERLAY', visible: false });
  assert.equal(frames[0].listeners.get('keydown').size, 0);
  const scanner = frames[0].context.__unkAiAgentScanner;
  scanner.showOverlay({ taskId: 'new-task', epoch: 1 });
  scanner.cancelTask('task', 1);
  scanner.removeOverlay('task', 1);
  assert.ok(frames[0].context.document.getElementById('__unk_ai_agent_overlay'));
  frames[0].dispatch('keydown', { isTrusted: true });
  assert.equal(frames[0].messages.at(-1).taskId, 'new-task');
});

test('full expected URL changes block an action both at entry and after its final async read', async (t) => {
  for (const stage of ['entry', 'execution']) {
    await t.test(stage, async () => {
      const { send, frames, setTabUrl, setBeforeGet } = await fixture();
      const observation = await send({ type: 'AGENT_OBSERVE' });
      let reads = 0;
      if (stage === 'entry') setTabUrl('https://allowed.test/app#/other');
      else setBeforeGet(() => { if (++reads === 2) setTabUrl('https://allowed.test/app#/other'); });
      const result = await send({ type: 'AGENT_ACT', expectedUrl: observation.url, snapshotId: observation.snapshotId, actionId: 'route-change', action: 'click_element', args: { elementId: 'e1' } });
      assert.equal(result.error, 'ERR_PAGE_CHANGED');
      assert.equal(frames[0].elements[0].clicks, 0);
    });
  }
});

test('scanner rejects a same-origin hash change at the actual page mutation', async () => {
  const { send, frames } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  const scanner = frames[0].context.__unkAiAgentScanner;
  const inspection = scanner.inspect(observation.snapshotId, 'e1');
  const epoch = frames[0].context.__unkAiAgentSnapshots.get(observation.snapshotId).epoch;
  frames[0].context.location.hash = '/other';
  const result = scanner.perform(observation.snapshotId, 'e1', 'click_element', {}, { taskId: 'task', epoch, signature: inspection.signature, frameOrigin: 'https://allowed.test' });
  assert.equal(result.error, 'ERR_PAGE_CHANGED');
  assert.equal(frames[0].elements[0].clicks, 0);
});

const pageReadMessage = (observation, query) => ({ type: 'AGENT_READ_PAGE', expectedUrl: observation.url, snapshotId: observation.snapshotId, ...(query === undefined ? {} : { query }) });
const isPageRead = request => request.func?.name === 'readPageInjected';
const isTextRead = request => isPageRead(request) && request.args[1] === true;
const isExtractorFile = request => request.files?.includes('content/extractor.js');
const readingBlock = (tagName, value) => ({ tagName, nodeType: 1, attributes: {}, childNodes: [{ nodeType: 3, nodeValue: value }] });

test('read_page uses the real extractor only in the pinned authorized main document', async () => {
  const { send, frames, scriptRequests } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  const previous = scriptRequests.length;
  const result = await send(pageReadMessage(observation));
  assert.equal(result.ok, true);
  assert.equal(result.url, observation.url);
  assert.equal(result.title, 'Fixture');
  assert.equal(result.text, 'Actual page evidence '.repeat(5).trim());
  assert.equal(result.truncated, false);
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
  const requests = scriptRequests.slice(previous);
  assert.deepEqual(requests.find(isExtractorFile).files, ['content/extractor.js']);
  assert.ok(requests.every(request => !request.target.allFrames));
  assert.ok(requests.every(request => request.injectImmediately === true));
  assert.ok(requests.filter(request => !request.target.frameIds).every(request => request.target.documentIds[0] === frames[0].documentId));
  assert.ok(requests.some(request => isPageRead(request) && request.target.frameIds?.[0] === 0));
});

test('read_page selects a matching later chapter before applying its 10000 character budget', async () => {
  const { send, frames } = await fixture();
  frames[0].context.document.body.childNodes = [
    readingBlock('H2', 'Chapter 1 Introduction'),
    readingBlock('P', 'Unrelated opening discussion. '.repeat(600)),
    readingBlock('H2', 'Chapter 2 Network retries'),
    readingBlock('P', 'Relevant exponential backoff guidance. '.repeat(500)),
  ];
  const observation = await send({ type: 'AGENT_OBSERVE' });
  const result = await send(pageReadMessage(observation, 'network retries'));
  assert.equal(result.ok, true);
  assert.ok(result.text.startsWith('Chapter 2 Network retries'));
  assert.match(result.text, /exponential backoff/);
  assert.doesNotMatch(result.text, /Unrelated opening/);
  assert.equal(result.text.length, 10000);
  assert.equal(result.truncated, true);
});

test('read_page rejects empty content and invalid query or page identity arguments', async (t) => {
  for (const invalid of [{ query: 'x'.repeat(201) }, { query: { selector: 'body' } }, { expectedUrl: '' }, { snapshotId: '' }]) {
    await t.test(JSON.stringify(invalid).slice(0, 40), async () => {
      const { send, scriptRequests } = await fixture();
      const observation = await send({ type: 'AGENT_OBSERVE' });
      const count = scriptRequests.length;
      assert.equal((await send({ ...pageReadMessage(observation), ...invalid })).error, 'ERR_ACTION_INVALID');
      assert.equal(scriptRequests.length, count);
    });
  }
  const { send, frames } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  frames[0].context.document.body.childNodes = [];
  assert.equal((await send(pageReadMessage(observation))).error, 'ERR_PAGE_READ_EMPTY');
});

test('read_page requires an active task and its current snapshot epoch', async (t) => {
  for (const stage of ['paused', 'cancelled', 'resumed', 'old-snapshot', 'takeover']) {
    await t.test(stage, async () => {
      const { send, frames } = await fixture();
      const observation = await send({ type: 'AGENT_OBSERVE' });
      if (stage === 'cancelled') await send({ type: 'AGENT_CANCEL' });
      if (['paused', 'resumed'].includes(stage)) await send({ type: 'AGENT_PAUSE' });
      if (stage === 'resumed') await send({ type: 'AGENT_RESUME' });
      if (stage === 'old-snapshot') await send({ type: 'AGENT_OBSERVE' });
      if (stage === 'takeover') frames[0].dispatch('keydown', { isTrusted: true });
      const result = await send(pageReadMessage(observation));
      assert.equal(result.error, ['paused', 'cancelled'].includes(stage) ? 'ERR_TASK_PAUSED' : 'ERR_SNAPSHOT_EXPIRED');
      assert.equal(result.text, undefined);
    });
  }
});

test('read_page rejects a hash change at entry or inside the actual read', async (t) => {
  for (const stage of ['entry', 'read']) {
    await t.test(stage, async () => {
      const { send, frames, setTabUrl, setBeforeScript } = await fixture();
      const observation = await send({ type: 'AGENT_OBSERVE' });
      if (stage === 'entry') setTabUrl(`${observation.url}#/other`);
      else setBeforeScript(request => { if (isTextRead(request)) frames[0].context.location.hash = '/other'; });
      const result = await send(pageReadMessage(observation));
      assert.equal(result.error, 'ERR_PAGE_CHANGED');
      assert.equal(result.text, undefined);
    });
  }
});

test('read_page rejects same-URL document replacement before, during, and after extraction', async (t) => {
  for (const stage of ['entry', 'injection', 'read', 'after']) {
    await t.test(stage, async () => {
      const { send, frames, setBeforeScript } = await fixture();
      const observation = await send({ type: 'AGENT_OBSERVE' });
      const replace = () => { frames[0] = frame(observation.url, ['Replacement document']); };
      if (stage === 'entry') replace();
      else setBeforeScript(request => {
        if ((stage === 'injection' && isExtractorFile(request))
          || (stage === 'read' && isTextRead(request))
          || (stage === 'after' && isPageRead(request) && request.target.frameIds)) replace();
      });
      const result = await send(pageReadMessage(observation));
      assert.equal(result.error, 'ERR_PAGE_CHANGED');
      assert.equal(result.text, undefined);
    });
  }
});

test('read_page rechecks task grants and the global control setting before publishing text', async (t) => {
  for (const stage of ['entry', 'after']) {
    for (const change of ['grant', 'control']) {
      await t.test(`${stage}-${change}`, async () => {
        const { send, data, setBeforeScript } = await fixture();
        const observation = await send({ type: 'AGENT_OBSERVE' });
        const revoke = () => {
          if (change === 'grant') data.agentOriginGrants = {};
          else data.agentSettings.enabled = false;
        };
        if (stage === 'entry') revoke();
        else setBeforeScript(request => { if (isTextRead(request)) revoke(); });
        const result = await send(pageReadMessage(observation));
        assert.equal(result.error, change === 'grant' ? 'ERR_ORIGIN_NOT_ALLOWED' : 'ERR_CONTROL_DISABLED');
        assert.equal(result.text, undefined);
      });
    }
  }
});

test('read_page cancellation immediately releases the read queue and discards late extraction', async (t) => {
  for (const type of ['AGENT_PAUSE', 'AGENT_CANCEL']) {
    await t.test(type, async () => {
      const { send, frames, setBeforeScript } = await fixture();
      const observation = await send({ type: 'AGENT_OBSERVE' });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      setBeforeScript(request => isTextRead(request) ? gate : undefined);
      const pending = send(pageReadMessage(observation));
      await turn();
      assert.equal((await send({ type })).ok, true);
      assert.equal((await pending).error, type === 'AGENT_PAUSE' ? 'ERR_TASK_PAUSED' : 'ERR_TASK_CANCELLED');
      let reads = 0;
      frames[0].context.__unkAiExtractor = { extractPageContent() { reads += 1; throw new Error('late read'); } };
      release();
      await turn();
      assert.equal(reads, 0);
      setBeforeScript(null);
      if (type === 'AGENT_PAUSE') {
        assert.equal((await send({ type: 'AGENT_RESUME' })).ok, true);
        const fresh = await send({ type: 'AGENT_OBSERVE' });
        assert.equal((await send(pageReadMessage(fresh))).ok, true);
      }
    });
  }
});

test('the 20 second read_page deadline discards late extraction without invoking the extractor', async (t) => {
  const { send, frames, setBeforeScript } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setBeforeScript(request => isTextRead(request) ? gate : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send(pageReadMessage(observation));
  await turn();
  t.mock.timers.tick(20001);
  assert.equal((await pending).error, 'ERR_PAGE_READ_TIMEOUT');
  let reads = 0;
  frames[0].context.__unkAiExtractor = { extractPageContent() { reads += 1; throw new Error('late read'); } };
  frames[0].context.Date = { now: () => Date.now() + 30000 };
  release();
  await turn();
  assert.equal(reads, 0);
  delete frames[0].context.Date;
  setBeforeScript(null);
  const fresh = await send({ type: 'AGENT_OBSERVE' });
  assert.equal((await send(pageReadMessage(fresh))).ok, true);
});

test('read_page bounds a stalled extractor injection and releases its read queue', async (t) => {
  const { send, setBeforeScript, scriptRequests } = await fixture();
  const observation = await send({ type: 'AGENT_OBSERVE' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setBeforeScript(request => isExtractorFile(request) ? gate : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send(pageReadMessage(observation));
  await turn();
  t.mock.timers.tick(20001);
  assert.equal((await pending).error, 'ERR_PAGE_READ_TIMEOUT');
  release();
  await turn();
  assert.equal(scriptRequests.filter(isTextRead).length, 0);
  setBeforeScript(null);
  const fresh = await send({ type: 'AGENT_OBSERVE' });
  assert.equal((await send(pageReadMessage(fresh))).ok, true);
});

test('a clipped 100-chapter sidebar exposes its scroll target and discovers chapter 20 without moving the page', async () => {
  const value = await fixture();
  const sidebar = sidebarFixture(value.frames[0]);
  let observation = await value.send({ type: 'AGENT_OBSERVE' });
  let target = observation.elements.find(element => element.scrollOnly);
  assert.ok(target);
  assert.equal(target.layout.region, 'navigation');
  assert.equal(target.layout.position, 'left-top');
  assert.equal(target.scroll.clientHeight, 320);
  assert.equal(observation.elements.some(element => /第20章/.test(element.name)), false);
  assert.equal(observation.elements.some(element => /第10章/.test(element.name)), false, 'parent clipping applies even inside the window viewport');
  const first = observation.elements.find(element => /第1章/.test(element.name));
  assert.equal(first.layout.scrollContainerId, target.id);
  assert.equal(first.layout.scrollContainerKey, target.stableKey);
  assert.equal(first.state.current, 'page');
  assert.equal(first.navigation.kind, 'document');
  assert.equal(observation.content.heading, '第一章');
  for (let step = 0; step < 2; step += 1) {
    const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: `sidebar-${step}`, action: 'scroll_page', args: { elementId: target.id, direction: 'down', amount: 1 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.effect.status, 'moved');
    assert.equal(result.effect.after.top - result.effect.before.top, 262, 'distance follows container height');
    assert.equal(result.effect.targetId, target.id);
    assert.equal(result.effect.targetKey, target.stableKey);
    observation = await value.send({ type: 'AGENT_OBSERVE' });
    target = observation.elements.find(element => element.stableKey === target.stableKey);
  }
  assert.equal(value.frames[0].context.scrollY, 0);
  assert.ok(observation.elements.some(element => /第20章 MCP/.test(element.name)));
  assert.ok(observation.elements.some(element => element.name === '正文按钮'));
  assert.ok(observation.elements.length <= 80);
  assert.equal(sidebar.container.scrollTop, 524);
});

test('scroll effects distinguish a boundary, an unmoving target and an ordinary link', async () => {
  const value = await fixture();
  const sidebar = sidebarFixture(value.frames[0]);
  const act = async (id, direction = 'down') => {
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const element = observation.elements.find(id);
    return value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: `scroll-${Math.random()}`, action: 'scroll_page', args: { elementId: element.id, direction } });
  };
  assert.equal((await act(element => element.role === 'link')).error, 'ERR_NOT_SCROLLABLE');
  const scrollBy = sidebar.container.scrollBy;
  sidebar.container.scrollBy = () => {};
  const unchanged = await act(element => element.scrollOnly);
  assert.equal(unchanged.effect.status, 'unchanged');
  assert.match(unchanged.message, /没有产生滚动位移/);
  sidebar.container.scrollBy = scrollBy;
  sidebar.container.scrollTop = sidebar.container.scrollHeight - sidebar.container.clientHeight;
  const boundary = await act(element => element.scrollOnly);
  assert.equal(boundary.effect.status, 'at_boundary');
  assert.match(boundary.message, /边界.*没有移动/);
  assert.equal(value.frames[0].context.scrollY, 0);
});

test('horizontal scrolling uses container width and layout changes do not invalidate semantic safety metadata', async () => {
  const value = await fixture();
  const sidebar = sidebarFixture(value.frames[0], { horizontal: true });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const target = observation.elements.find(element => element.scrollOnly);
  sidebar.container.scrollLeft = 25;
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'horizontal', action: 'scroll_page', args: { elementId: target.id, direction: 'right' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.effect.before.left, 25);
  assert.equal(result.effect.after.left, 222);
  assert.equal(result.effect.status, 'moved');
});

test('iframe scroll-container relationships and effects are mapped to global snapshot IDs', async () => {
  const value = await fixture();
  sidebarFixture(value.frames[0]);
  sidebarFixture(value.frames[1]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const target = observation.elements.find(element => element.frame === 'iframe 1' && element.scrollOnly);
  const childLink = observation.elements.find(element => element.frame === 'iframe 1' && element.role === 'link');
  assert.equal(childLink.layout.scrollContainerId, target.id);
  assert.equal(childLink.layout.scrollContainerKey, target.stableKey);
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'child-scroll', action: 'scroll_page', args: { elementId: target.id, direction: 'down' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.effect.targetId, target.id);
  assert.equal(result.effect.targetKey, target.stableKey);
});

test('navigation states distinguish the current document, its anchor and another Docsify chapter', async () => {
  const value = await fixture();
  const sidebar = sidebarFixture(value.frames[0]);
  value.frames[0].context.location.hash = '#/chapter-1';
  value.setTabUrl('https://allowed.test/app#/chapter-1');
  sidebar.links[1].attributes.href = '#/chapter-1?id=mcp';
  sidebar.links[1].attributes['aria-expanded'] = 'true';
  sidebar.links[1].attributes['aria-selected'] = 'false';
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const links = observation.elements.filter(element => element.frame === '主页面' && element.role === 'link');
  assert.equal(links[0].navigation.kind, 'current_document');
  assert.equal(links[1].navigation.kind, 'section');
  assert.equal(links[2].navigation.kind, 'document');
  assert.equal(links[1].state.expanded, true);
  assert.equal(links[1].state.selected, false);
});

test('a directory with over 80 visible links cannot crowd out its scroll target or main region', async () => {
  const value = await fixture();
  const sidebar = sidebarFixture(value.frames[0], { count: 200 });
  sidebar.container.clientHeight = 600;
  sidebar.container.getBoundingClientRect = () => ({ top: 80, bottom: 680, left: 0, right: 240, width: 240, height: 600 });
  sidebar.links.forEach((link, index) => {
    link.getBoundingClientRect = () => ({ top: 80 + index * 5, bottom: 85 + index * 5, left: 10, right: 220, width: 210, height: 5 });
  });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(observation.elements.length, 80);
  assert.ok(observation.elements.some(element => element.scrollOnly));
  assert.ok(observation.elements.some(element => element.name === '正文按钮'));
  assert.ok(observation.elements.filter(element => element.scroll).length <= 8);
});

function regionFixture(frameValue, { count = 4, table = false } = {}) {
  const { context } = frameValue;
  const sample = frameValue.elements[0];
  const node = (tag, value = '', children = [], attributes = {}) => {
    const element = { ...sample, tagName: tag.toUpperCase(), type: '', id: '', attributes, style: { opacity: '1' },
      childNodes: [...(value ? [{ nodeType: 3, nodeValue: value }] : []), ...children],
      children, childElementCount: children.length,
      get textContent() { return this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.textContent).join(' '); },
      get innerText() { return this.textContent; },
      matches(selector) { return selector.split(',').some(part => part.trim().toLowerCase() === tag.toLowerCase()); },
      getBoundingClientRect() { return { top: 60, bottom: 680, left: 200, right: 960, width: 760, height: 620 }; },
      querySelectorAll(selector) { return all(this).filter(child => matches(child, selector)); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      contains(other) { return other === this || all(this).includes(other); },
      cloneNode() { throw new Error('whole-subtree cloning is forbidden'); },
    };
    for (const child of element.childNodes) { child.parentElement = element; child.parentNode = element; }
    return element;
  };
  const all = root => (root.children || []).flatMap(child => [child, ...all(child)]);
  const matches = (element, selector) => selector.split(',').some(raw => {
    const part = raw.trim().toLowerCase();
    if (part === '*' || part === 'body *') return true;
    if (part === 'a[href]') return element.tagName === 'A' && Boolean(element.attributes.href);
    const role = part.match(/^\[role=['"]?([^'"\]]+)/)?.[1];
    return role ? element.attributes.role === role : part === element.tagName.toLowerCase();
  });
  const header = node('tr', '', [node('th', '商家'), node('th', '缓存命中率')]);
  const rows = Array.from({ length: count }, (_, index) => table
    ? node('tr', '', [node('td', `商家 ${index + 1}`), node('td', `${80 + index}.5%`)])
    : node('li', '', [node('h3', `商家 ${index + 1}`), node('p', `缓存命中率 ${80 + index}.5%`)]));
  const secret = node('input', 'SECRET_INPUT');
  const hidden = node('p', 'SECRET_HIDDEN'); hidden.style.display = 'none';
  const region = node(table ? 'table' : 'ul', '', [...(table ? [header] : []), ...rows, secret, hidden], { 'aria-label': '商家列表' });
  const outside = node('aside', 'OUTSIDE_REGION');
  const body = node('body', '', [outside, region]);
  context.document.body = body;
  context.document.querySelectorAll = selector => all(body).filter(child => matches(child, selector));
  context.document.querySelector = selector => context.document.querySelectorAll(selector)[0] || null;
  context.getComputedStyle = element => element.style || { opacity: '1' };
  return { node, rows, region, body, outside, hidden };
}

const regionReadMessage = (observation, query = '缓存命中率') => ({
  type: 'AGENT_READ_REGION', expectedUrl: observation.url, snapshotId: observation.snapshotId,
  elementId: observation.elements.find(element => element.readable && element.frameId === 0)?.id, query,
});
const isRegionRead = request => request.func?.toString().includes('scanner.readRegion');

test('observation uses bounded value-free text without cloning and reports actual scan counters', async () => {
  const value = await fixture();
  regionFixture(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.ok(!observation.error, JSON.stringify(observation));
  assert.ok(Number.isFinite(observation.metrics.scanMs));
  assert.ok(observation.metrics.candidateCount >= observation.elements.length);
  assert.equal(observation.metrics.returnedCount, observation.elements.length);
  assert.doesNotMatch(observation.summary, /SECRET_INPUT|SECRET_HIDDEN/);
  const region = observation.elements.find(element => element.readable);
  assert.equal(region.readOnly, true);
  assert.equal(region.mainFrame, true);
  assert.deepEqual(JSON.parse(JSON.stringify(region.rect)), { x: 200, y: 60, width: 760, height: 620 });
});

test('region reads return named list rows without extracting the page or executing clicks', async () => {
  const value = await fixture();
  const nodes = regionFixture(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const before = value.scriptRequests.length;
  const result = await value.send(regionReadMessage(observation));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.regionReading.rows.length, 4);
  assert.equal(result.regionReading.totalRows, 4);
  assert.equal(result.regionReading.rows[0].label, '商家 1');
  assert.match(result.regionReading.rows[0].text, /80.5%/);
  assert.doesNotMatch(JSON.stringify(result.regionReading), /OUTSIDE_REGION|SECRET_INPUT|SECRET_HIDDEN/);
  assert.ok(result.regionReading.regionKey);
  assert.equal(result.regionReading.truncated, false);
  assert.ok(Number.isFinite(result.metrics.readMs));
  assert.equal(value.scriptRequests.slice(before).some(isExtractorFile), false);
  assert.equal(nodes.region.clicks, 0);
  const click = await value.send({ type: 'AGENT_ACT', expectedUrl: observation.url, snapshotId: observation.snapshotId,
    actionId: 'cannot-click-region', action: 'click_element', args: { elementId: regionReadMessage(observation).elementId } });
  assert.ok(click.error, JSON.stringify(click));
  assert.equal(nodes.region.clicks, 0);
});

test('table region reads retain real headers and bound excessive rows with an explicit truncation', async () => {
  const value = await fixture();
  regionFixture(value.frames[0], { count: 205, table: true });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send(regionReadMessage(observation));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.regionReading.rows.length, 200);
  assert.equal(result.regionReading.totalRows, 205);
  assert.equal(result.regionReading.truncated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.regionReading.rows[0].cells)), [{ label: '商家', text: '商家 1' }, { label: '缓存命中率', text: '80.5%' }]);
});

test('region reads reject stale snapshots, invalid targets and page identity changes', async t => {
  for (const change of ['snapshot', 'url', 'document', 'detached', 'query']) await t.test(change, async () => {
    const value = await fixture();
    const nodes = regionFixture(value.frames[0]);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const message = regionReadMessage(observation);
    if (change === 'snapshot') await value.send({ type: 'AGENT_OBSERVE' });
    if (change === 'url') value.frames[0].context.location.hash = '#changed';
    if (change === 'document') value.frames[0] = frame(observation.url, ['Replacement']);
    if (change === 'detached') nodes.region.isConnected = false;
    if (change === 'query') message.query = 'x'.repeat(81);
    const result = await value.send(message);
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(result.regionReading, undefined);
  });
});

test('region reads recheck revoked permission and cancel hung work without publishing late data', async t => {
  for (const change of ['grant', 'control', 'cancel']) await t.test(change, async () => {
    const value = await fixture();
    regionFixture(value.frames[0]);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    value.setBeforeScript(request => {
      if (!isRegionRead(request)) return;
      if (change === 'grant') value.data.agentOriginGrants = {};
      if (change === 'control') value.data.agentSettings.enabled = false;
      if (change === 'cancel') return gate;
    });
    const pending = value.send(regionReadMessage(observation));
    if (change === 'cancel') { await turn(); await value.send({ type: 'AGENT_CANCEL' }); }
    const result = await pending;
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(result.regionReading, undefined);
    release(); await turn();
  });
});

test('region fields that are missing never produce apparently complete ranking rows', async () => {
  const value = await fixture();
  regionFixture(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send(regionReadMessage(observation, '未知字段'));
  assert.equal(result.ok, true);
  assert.equal(result.regionReading.queryMatched, false);
  assert.equal(result.regionReading.rows.length, 0);
  assert.match(result.regionReading.notice, /未定位到/);
  assert.match(result.regionReading.text, /商家 1/);
});

test('long region rows carry their own truncation flag and never leak editable descendants', async () => {
  const value = await fixture();
  const nodes = regionFixture(value.frames[0]);
  const long = nodes.node('p', '缓存命中率 ' + 'x'.repeat(2000) + ' 99.5%');
  long.parentElement = nodes.rows[0];
  nodes.rows[0].children.push(long); nodes.rows[0].childNodes.push(long);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send(regionReadMessage(observation));
  assert.equal(result.regionReading.rows[0].truncated, true);
  assert.ok(result.regionReading.rows[0].text.length <= 800);
  assert.equal(result.regionReading.rows[1].truncated, false);
  assert.equal(result.regionReading.truncated, true);
});

test('region read validates the authorized frame document and discards late results after frame replacement', async t => {
  for (const change of ['read', 'replace', 'revoke']) await t.test(change, async () => {
    const value = await fixture({ childOrigin: 'https://child.test' });
    regionFixture(value.frames[1]);
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    const message = { ...regionReadMessage(observation), elementId: observation.elements.find(element => element.readable && element.frameId === 1).id };
    if (change === 'replace') value.setBeforeScript(request => { if (isRegionRead(request) && request.target.frameIds) value.frames[1] = frame('https://child.test/frame', ['Replacement'], false); });
    if (change === 'revoke') value.setBeforeScript(request => { if (isRegionRead(request)) delete value.data.agentOriginGrants['https://child.test']; });
    const result = await value.send(message);
    if (change === 'read') {
      assert.equal(result.ok, true);
      assert.equal(result.regionReading.frameUrl, 'https://child.test/frame');
      assert.equal(result.regionReading.url, observation.url);
    } else { assert.ok(result.error); assert.equal(result.regionReading, undefined); }
  });
});

test('region read deadline returns promptly and does not publish a late successful body', async t => {
  const value = await fixture();
  regionFixture(value.frames[0]);
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  value.setBeforeScript(request => isRegionRead(request) ? gate : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = value.send(regionReadMessage(observation));
  await turn(); t.mock.timers.tick(20001);
  const result = await pending;
  assert.equal(result.error, 'ERR_PAGE_READ_TIMEOUT');
  assert.equal(result.regionReading, undefined);
  release(); await turn();
});

test('styles and geometry are cached only during a scan and refreshed before real actions', async () => {
  const value = await fixture();
  let styles = 0, bounds = 0;
  const target = value.frames[0].elements[0];
  const originalBounds = target.getBoundingClientRect;
  target.getBoundingClientRect = () => { bounds++; return originalBounds(); };
  value.frames[0].context.getComputedStyle = node => { if (node === target) styles++; return { opacity: '1' }; };
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(styles, 1);
  assert.equal(bounds, 1);
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId, actionId: 'fresh-layout', action: 'click_element', args: { elementId: 'e1' } });
  assert.equal(result.ok, true);
  assert.ok(styles > 1 && bounds > 1, 'action checks must not reuse observation style or geometry');
});

test('table identity follows the named merchant column rather than a leading rank or numeric cell', async () => {
  const value = await fixture();
  const nodes = regionFixture(value.frames[0], { table: true });
  const prepend = (row, cell) => { cell.parentElement = row; row.children.unshift(cell); row.childNodes.unshift(cell); };
  prepend(nodes.region.children[0], nodes.node('th', '排名'));
  for (const [index, row] of nodes.rows.entries()) prepend(row, nodes.node('td', String(index + 1)));
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const result = await value.send(regionReadMessage(observation));
  assert.equal(result.regionReading.rows[0].label, '商家 1');
  assert.equal(result.regionReading.rows[1].label, '商家 2');
  assert.equal(result.regionReading.rows[0].cells[0].label, '排名');
  nodes.rows[0].children[1].childNodes[0].nodeValue = '123';
  const numeric = await value.send(regionReadMessage(observation));
  assert.equal(numeric.regionReading.rows[0].label, '', 'numeric rank-like values cannot masquerade as names');
});

test('main region reads repeated single-wrapper links with merchant leaves and split metric spans', async () => {
  const value = await fixture();
  const base = regionFixture(value.frames[0]);
  const { node } = base;
  const cards = Array.from({ length: 24 }, (_, index) => {
    const hidden = node('span', 'HIDDEN_MERCHANT'); hidden.style.display = 'none';
    const brand = node('span', '', [node('svg', '', [node('title', 'OpenAI')])]);
    const identity = node('div', '', [brand, hidden, node('button', '展开'), node('span', '123'),
      node('span', index === 0 ? 'GETAPI' : `真实商家 ${index + 1}`), node('span', '信用分 500', [], { 'aria-label': '店铺信用分:500' })]);
    const fields = node('div', '', [identity, node('div', 'gpt-6-astra'), node('p', '稳定的模型转发服务'),
      node('div', '', [node('span', '输入价格'), node('span', '¥1.98/M')]),
      node('div', '', [node('span', '缓存命中率'), node('span', '79.8%')])]);
    const card = node('a', '', [node('div', '', [node('div', '', [fields])])], { href: `/models/${11035 + index}` });
    card.className = 'block no-underline'; card.style.display = 'block';
    return card;
  });
  const container = node('div', '', cards, { 'aria-label': '商家卡片' }); container.className = 'space-y-2';
  const filters = node('ul', '', [node('li', '全部'), node('li', '价格'), node('li', '最新')]);
  const ordinaryLinks = node('div', '', [node('a', '', [node('span', '主页')], { href: '/' }),
    node('a', '', [node('span', '模型')], { href: '/models' }), node('a', '', [node('span', '文档')], { href: '/docs' })]);
  const main = node('main', '', [filters, ordinaryLinks, container], { 'aria-label': '模型商家主区' });
  base.body.children = [main]; base.body.childNodes = [main]; main.parentElement = base.body;
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  assert.ok(observation.elements.some(element => element.readable && element.name === '商家卡片'), 'the real list wrapper must be a controlled region');
  const mainTarget = observation.elements.find(element => element.readable && element.name === '模型商家主区');
  const result = await value.send({ ...regionReadMessage(observation), elementId: mainTarget.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.regionReading.rows.length, 24);
  assert.equal(result.regionReading.totalRows, 24);
  assert.equal(result.regionReading.rows[0].label, 'GETAPI');
  assert.equal(result.regionReading.rows[1].label, '真实商家 2');
  assert.equal(result.regionReading.rows[0].labelSource, 'visible-text');
  assert.match(result.regionReading.rows[0].text, /缓存命中率\s*79\.8%/);
  assert.doesNotMatch(result.regionReading.rows[0].text, /OpenAI|HIDDEN_MERCHANT/);
  assert.equal(result.regionReading.queryMatched, true);
  assert.equal(result.regionReading.truncated, false);
});

async function pendingUploadReceiptFixture(options = {}) {
  const value = await fixture({ referenceImages: [uploadImage], ...options });
  const uploadFrame = options.uploadFrame || 0;
  const nodes = uploadPreviewFixture(value.frames[uploadFrame]);
  const bytes = Uint8Array.from(atob(uploadImage.dataUrl.split(',')[1]), char => char.charCodeAt(0));
  value.frames[uploadFrame].context.fetch = async () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  nodes.input.dispatchEvent = event => {
    if (event.type === 'change') { nodes.input._files = []; nodes.addPreview('blob:https://allowed.test/backend-receipt'); }
    return true;
  };
  const before = await value.send({ type: 'AGENT_OBSERVE' });
  const action = uploadAction(before.snapshotId, 'backend-pending-upload');
  action.args.elementId = before.elements.find(element => element.type === 'file').id;
  const original = await value.send(action);
  assert.equal(original.error, 'ERR_UPLOAD_UNCERTAIN');
  assert.equal(original.upload.requiresAcceptanceVerification, true);
  const after = await value.send({ type: 'AGENT_OBSERVE' });
  const message = { type: 'AGENT_VERIFY_UPLOAD', expectedUrl: after.url, snapshotId: after.snapshotId,
    elementId: after.elements.find(element => element.type === 'file').id,
    uploadActionId: action.actionId, referenceId: 'reference-1' };
  return { ...value, ...nodes, bytes, before, after, action, original, message, uploadFrame };
}

const isUploadReceiptRead = request => request.func?.name === 'uploadReceiptInjected' && request.args?.[3] === true;

test('upload receipt checks pin original document and leave the uncertain upload result immutable', async () => {
  const value = await pendingUploadReceiptFixture();
  const checked = await value.send(value.message);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.receipt.actionId, value.action.actionId);
  assert.equal(checked.receipt.snapshotId, value.after.snapshotId);
  assert.equal(checked.receipt.serverConfirmed, false);
  const read = value.scriptRequests.find(isUploadReceiptRead);
  assert.deepEqual(read.target, { tabId: 1, documentIds: [value.frames[0].documentId] });
  assert.equal(read.args[2].documentId, value.frames[0].documentId);
  assert.deepEqual(await value.send(value.action), value.original);
  assert.equal(value.input.assignments, 1);
  assert.equal(value.data.agentExecutionTasks[0].actions.length, 1, 'receipt verification must not create an action intent');
});

test('upload receipt checks require the original uncertain action and matching reference', async t => {
  for (const kind of ['unknown-action', 'different-reference', 'successful-upload', 'resumed-epoch']) await t.test(kind, async () => {
    const value = await pendingUploadReceiptFixture();
    const message = { ...value.message };
    if (kind === 'unknown-action') message.uploadActionId = 'missing-upload';
    if (kind === 'different-reference') message.referenceId = 'reference-2';
    if (kind === 'successful-upload') {
      value.input.dispatchEvent = () => true;
      const selected = await value.send(uploadAction(value.after.snapshotId, 'successful-upload'));
      assert.equal(selected.ok, true);
      message.uploadActionId = 'successful-upload';
      const latest = await value.send({ type: 'AGENT_OBSERVE' });
      message.snapshotId = latest.snapshotId;
    }
    if (kind === 'resumed-epoch') {
      await value.send({ type: 'AGENT_PAUSE' });
      await value.send({ type: 'AGENT_RESUME', referenceImages: [uploadImage] });
      const latest = await value.send({ type: 'AGENT_OBSERVE' });
      message.snapshotId = latest.snapshotId;
    }
    const result = await value.send(message);
    assert.equal(result.error, 'ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED', JSON.stringify(result));
    assert.equal(result.receipt, undefined);
    assert.equal(value.scriptRequests.some(isUploadReceiptRead), false);
    assert.equal(value.input.assignments, kind === 'successful-upload' ? 2 : 1);
  });
});

test('upload receipt checks pin the same origin iframe and also recheck the original main document', async t => {
  for (const kind of ['accepted', 'frame-replaced', 'main-replaced']) await t.test(kind, async () => {
    const value = await pendingUploadReceiptFixture({ uploadFrame: 1 });
    const originalDocument = value.frames[1].documentId;
    value.frames[1].context.fetch = async () => {
      if (kind === 'frame-replaced') value.frames[1].documentId = 'new-frame-document';
      if (kind === 'main-replaced') value.frames[0].documentId = 'new-main-document';
      return new Response(value.bytes, { headers: { 'Content-Type': 'image/png' } });
    };
    const result = await value.send(value.message);
    const read = value.scriptRequests.find(isUploadReceiptRead);
    assert.deepEqual(read.target, { tabId: 1, documentIds: [originalDocument] });
    assert.equal(read.args[2].frameId, 1);
    if (kind === 'accepted') {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.receipt.documentId, originalDocument);
      assert.equal(result.receipt.frameId, 1);
      assert.equal(result.receipt.url, value.after.url);
    } else {
      assert.equal(result.error, 'ERR_PAGE_CHANGED', JSON.stringify(result));
      assert.equal(result.receipt, undefined);
    }
    assert.equal(value.input.assignments, 1);
    assert.equal(value.frames[0].elements[0].clicks, 0);
  });
});

test('upload receipt checks reject stale observations, changed full URLs and replaced native targets', async t => {
  for (const kind of ['snapshot', 'tab-url', 'frame-url', 'document', 'missing-document', 'native-input', 'type', 'detached', 'control', 'grant']) await t.test(kind, async () => {
    const value = await pendingUploadReceiptFixture();
    if (kind === 'snapshot') await value.send({ type: 'AGENT_OBSERVE' });
    if (kind === 'tab-url') value.setTabUrl(value.after.url + '#new');
    if (kind === 'frame-url') value.frames[0].context.location.hash = '#new';
    if (kind === 'document') value.frames[0] = frame(value.after.url, ['Replacement']);
    if (kind === 'missing-document') value.frames[0].documentId = undefined;
    if (kind === 'native-input') Object.setPrototypeOf(value.input, Object.prototype);
    if (kind === 'type') value.input.type = 'text';
    if (kind === 'detached') value.input.isConnected = false;
    if (kind === 'control') value.data.agentSettings.enabled = false;
    if (kind === 'grant') value.data.agentOriginGrants = {};
    const result = await value.send(value.message);
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(result.receipt, undefined);
    assert.equal(value.scriptRequests.some(isUploadReceiptRead), false, 'invalid targets must be refused before reading a preview');
    assert.equal(value.input.assignments, 1);
  });
});

test('upload receipt checks discard successful preview data after authority or document changes', async t => {
  for (const kind of ['control', 'grant', 'tab-url', 'frame-url', 'document', 'iframe-replacement']) await t.test(kind, async () => {
    const value = await pendingUploadReceiptFixture();
    value.frames[0].context.fetch = async () => {
      if (kind === 'control') value.data.agentSettings.enabled = false;
      if (kind === 'grant') value.data.agentOriginGrants = {};
      if (kind === 'tab-url') value.setTabUrl(value.after.url + '#new');
      if (kind === 'frame-url') value.frames[0].context.location.hash = '#new';
      if (kind === 'document') value.frames[0].documentId = 'replaced-during-preview';
      if (kind === 'iframe-replacement') {
        value.frames[0].context.top = {};
        value.frames[0].documentId = 'replacement-frame-document';
      }
      return new Response(value.bytes, { headers: { 'Content-Type': 'image/png' } });
    };
    const result = await value.send(value.message);
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(result.receipt, undefined);
    assert.equal(value.input.assignments, 1);
    assert.deepEqual(await value.send(value.action), value.original);
  });
});

test('upload receipt checks validate every receipt identity before exposing acceptance', async t => {
  for (const field of ['version', 'accepted', 'kind', 'serverConfirmed', 'actionId', 'referenceId', 'taskId', 'epoch', 'tabId',
    'frameId', 'documentId', 'url', 'snapshotId']) await t.test(field, async () => {
    const value = await pendingUploadReceiptFixture({ serializeResult: result => result?.receipt
      ? { ...result, receipt: { ...result.receipt, [field]: field === 'serverConfirmed' ? true : 'wrong' } } : result });
    const result = await value.send(value.message);
    assert.equal(result.error, 'ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED', JSON.stringify(result));
    assert.equal(result.receipt, undefined);
    assert.equal(value.input.assignments, 1);
  });
});

test('upload receipt checks cancel a hanging preview and never expose late acceptance', async () => {
  const value = await pendingUploadReceiptFixture();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  value.frames[0].context.fetch = async () => { started(); await gate; return new Response(value.bytes); };
  const pending = value.send(value.message);
  await reading;
  await value.send({ type: 'AGENT_CANCEL' });
  const result = await pending;
  assert.ok(['ERR_TASK_PAUSED', 'ERR_TASK_CANCELLED'].includes(result.error), JSON.stringify(result));
  assert.equal(result.receipt, undefined);
  release(); await turn();
  assert.equal(value.input.assignments, 1);
});

test('upload receipt three second boundary includes waiting behind another page action', async t => {
  const value = await pendingUploadReceiptFixture();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const executing = new Promise(resolve => { started = resolve; });
  value.setBeforeScript(request => {
    if (request.func?.toString().includes('scanner?.perform')) { started(); return gate; }
  });
  const action = value.send({ type: 'AGENT_ACT', snapshotId: value.after.snapshotId, actionId: 'queued-other-action',
    action: 'click_element', args: { elementId: value.after.elements.find(element => element.type === 'button').id } });
  await executing;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = value.send(value.message);
  await turn(); t.mock.timers.tick(3001);
  const result = await pending;
  assert.equal(result.error, 'ERR_UPLOAD_VERIFY_TIMEOUT');
  assert.equal(result.receipt, undefined);
  assert.equal(value.scriptRequests.some(isUploadReceiptRead), false);
  t.mock.timers.reset();
  release(); await action; await turn();
  assert.equal(value.input.assignments, 1);
});

test('upload receipt three second deadline aborts a hanging local blob read', async t => {
  const value = await pendingUploadReceiptFixture();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  value.frames[0].context.fetch = async () => { started(); await gate; return new Response(value.bytes); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = value.send(value.message);
  await reading; t.mock.timers.tick(3001);
  const result = await pending;
  assert.equal(result.error, 'ERR_UPLOAD_VERIFY_TIMEOUT');
  assert.equal(result.receipt, undefined);
  release(); await turn();
  assert.equal(value.input.assignments, 1);
});

test('navigation rechecks control and both origin grants immediately before tabs.update', async t => {
  for (const change of ['control', 'main-grant', 'target-grant']) await t.test(change, async () => {
    const value = await fixture();
    value.data.agentOriginGrants['https://target.test'] = { scope: 'task', taskId: 'task' };
    let reads = 0, updates = 0;
    chrome.tabs.update = async () => { updates += 1; };
    value.setBeforeGet(() => {
      if (++reads !== 2) return;
      if (change === 'control') value.data.agentSettings.enabled = false;
      else delete value.data.agentOriginGrants[change === 'main-grant' ? 'https://allowed.test' : 'https://target.test'];
    });
    const result = await value.send({ type: 'AGENT_NAVIGATE', actionId: 'revoked-navigation',
      expectedUrl: 'https://allowed.test/app', args: { url: 'https://target.test/next' },
      approval: { confirmed: true, actionId: 'revoked-navigation' } });
    assert.equal(updates, 0);
    assert.equal(result.error, change === 'control' ? 'ERR_CONTROL_DISABLED' : 'ERR_ORIGIN_NOT_ALLOWED');
  });
});

test('iframe actions recheck the frame grant after the last asynchronous tab read', async () => {
  const value = await fixture({ childOrigin: 'https://child.test' });
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  let reads = 0;
  value.setBeforeGet(() => { if (++reads === 2) delete value.data.agentOriginGrants['https://child.test']; });
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId,
    actionId: 'revoked-frame', expectedUrl: observation.url, action: 'click_element',
    args: { elementId: observation.elements.find(element => element.frameId === 1).id } });
  assert.equal(value.frames[1].elements[0].clicks, 0);
  assert.equal(result.error, 'ERR_ORIGIN_NOT_ALLOWED');
});

test('observations discard data whose control or frame grants were revoked during scanning', async t => {
  for (const change of ['control', 'main-grant', 'frame-grant']) await t.test(change, async () => {
    const value = await fixture({ childOrigin: 'https://child.test' });
    value.setBeforeScript(request => {
      if (request.func?.name !== 'scanInjected') return;
      if (change === 'control') value.data.agentSettings.enabled = false;
      else delete value.data.agentOriginGrants[change === 'main-grant' ? 'https://allowed.test' : 'https://child.test'];
    });
    const result = await value.send({ type: 'AGENT_OBSERVE' });
    assert.equal(result.snapshotId, undefined);
    assert.equal(result.elements, undefined);
    assert.equal(result.error, change === 'control' ? 'ERR_CONTROL_DISABLED' : 'ERR_ORIGIN_NOT_ALLOWED');
  });
});

test('stopping invalidates pending page scripts before a stalled session write finishes', async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  let releaseAction, enterAction, releaseStorage, enterStorage;
  const actionGate = new Promise(resolve => { releaseAction = resolve; });
  const actionEntered = new Promise(resolve => { enterAction = resolve; });
  const storageGate = new Promise(resolve => { releaseStorage = resolve; });
  const storageEntered = new Promise(resolve => { enterStorage = resolve; });
  value.setBeforeScript(request => {
    if (request.func?.toString().includes('scanner?.perform')) { enterAction(); return actionGate; }
  });
  const action = value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId,
    actionId: 'stop-pending-click', action: 'click_element', args: { elementId: 'e1' } });
  await actionEntered;
  const originalSet = chrome.storage.session.set;
  let delayNextWrite = true;
  chrome.storage.session.set = async data => {
    if (delayNextWrite) { delayNextWrite = false; enterStorage(); await storageGate; }
    return originalSet(data);
  };
  const cancellation = value.send({ type: 'AGENT_CANCEL' });
  await storageEntered;
  await turn();
  releaseAction();
  await turn();
  const clicksBeforeStorageSettled = value.frames[0].elements[0].clicks;
  releaseStorage();
  const [result, stopped] = await Promise.all([action, cancellation]);
  assert.equal(clicksBeforeStorageSettled, 0);
  assert.ok(result.error);
  assert.equal(stopped.ok, true);
});

test('frame merging reserves visible controls in later frames and discloses its omissions', async () => {
  const value = await fixture();
  value.frames[0] = frame('https://allowed.test/app', Array.from({ length: 90 }, (_, index) => `Main ${index}`));
  value.frames[1] = frame('https://allowed.test/frame', Array.from({ length: 20 }, (_, index) => `Child ${index}`), false);
  for (const current of value.frames) current.elements.forEach((element, index) => {
    element.getBoundingClientRect = () => ({ top: 10 + index * 5, bottom: 14 + index * 5,
      left: 10, right: 90, width: 80, height: 4 });
  });
  const result = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(result.elements.length, 80);
  assert.equal(result.elements.filter(element => element.frameId === 1).length, 20);
  assert.equal(result.metrics.returnedCount, 80);
  assert.equal(result.metrics.candidateTruncated, true);
  assert.equal(result.metrics.scanTruncated, true);
  assert.ok(result.metrics.omittedCount >= 20, 'known merge omissions must be disclosed even before scanner omissions');
});

test('a stricter setting observed at the final action boundary requires confirmation', async () => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  let reads = 0;
  value.setBeforeGet(() => { if (++reads === 2) value.data.agentSettings.strictMode = true; });
  const result = await value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId,
    actionId: 'new-strict-setting', action: 'click_element', args: { elementId: 'e1' } });
  assert.equal(value.frames[0].elements[0].clicks, 0);
  assert.equal(result.requiresConfirmation, true);
});

test('permission changes immediately invalidate in-flight scripts and require explicit resume', async t => {
  for (const change of ['control', 'main-grant', 'frame-grant', 'grant-task-owner', 'strict-mode']) await t.test(change, async () => {
    const value = await fixture({ childOrigin: 'https://child.test' });
    const observation = await value.send({ type: 'AGENT_OBSERVE' });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    value.setBeforeScript(request => {
      if (request.func?.toString().includes('scanner?.perform')) { entered(); return gate; }
    });
    const pending = value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId,
      actionId: 'permission-change-script', action: 'click_element',
      args: { elementId: observation.elements.find(element => element.frameId === 1).id } });
    await reached;
    const oldValue = structuredClone(change === 'control' || change === 'strict-mode'
      ? value.data.agentSettings : value.data.agentOriginGrants);
    if (change === 'control') value.data.agentSettings.enabled = false;
    else if (change === 'strict-mode') value.data.agentSettings.strictMode = true;
    else if (change === 'grant-task-owner') value.data.agentOriginGrants['https://child.test'] = { scope: 'task', taskId: 'other-task' };
    else delete value.data.agentOriginGrants[change === 'main-grant' ? 'https://allowed.test' : 'https://child.test'];
    const key = change === 'control' || change === 'strict-mode' ? 'agentSettings' : 'agentOriginGrants';
    chrome.storage.onChanged.emit({ [key]: { oldValue, newValue: structuredClone(value.data[key]) } }, 'local');
    await turn();
    release();
    const result = await pending;
    assert.equal(value.frames[1].elements[0].clicks, 0);
    assert.ok(result.error);
    assert.equal((await value.send({ type: 'AGENT_OBSERVE' })).error, 'ERR_TASK_PAUSED');
  });
});

test('adding a grant or changing unrelated storage does not pause a valid task', async () => {
  const value = await fixture();
  const oldValue = structuredClone(value.data.agentOriginGrants);
  value.data.agentOriginGrants['https://new.test'] = { scope: 'task', taskId: 'task' };
  chrome.storage.onChanged.emit({ agentOriginGrants: { oldValue, newValue: structuredClone(value.data.agentOriginGrants) } }, 'local');
  chrome.storage.onChanged.emit({ theme: { newValue: 'dark' } }, 'local');
  await turn();
  assert.ok((await value.send({ type: 'AGENT_OBSERVE' })).snapshotId);
});

test('observation requires a real top frame and rejects document replacement before publication', async t => {
  await t.test('no-top', async () => {
    const value = await fixture();
    value.frames[0].context.top = {};
    const result = await value.send({ type: 'AGENT_OBSERVE' });
    assert.equal(result.elements, undefined);
    assert.equal(result.error, 'ERR_PAGE_SCAN_FAILED');
  });
  await t.test('replaced-document', async () => {
    let value;
    value = await fixture({ serializeResult(result) {
      if (result?.snapshotId && result?.isTop) value.frames[0].documentId = 'replaced-after-scan';
      return result;
    } });
    const result = await value.send({ type: 'AGENT_OBSERVE' });
    assert.equal(result.elements, undefined);
    assert.equal(result.error, 'ERR_PAGE_CHANGED');
  });
});

test('a duplicate pending start preserves the active task iframe permission scope', async () => {
  const value = await fixture({ childOrigin: 'https://child.test' });
  await value.send({ type: 'AGENT_OBSERVE' });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const originalSet = chrome.storage.session.set;
  let writes = 0;
  chrome.storage.session.set = async record => {
    if (++writes === 1) { entered(); await gate; }
    return originalSet(record);
  };
  const starting = value.send({ type: 'AGENT_START' });
  await reached;
  const oldValue = structuredClone(value.data.agentOriginGrants);
  delete value.data.agentOriginGrants['https://child.test'];
  chrome.storage.onChanged.emit({ agentOriginGrants: { oldValue, newValue: structuredClone(value.data.agentOriginGrants) } }, 'local');
  await turn();
  release();
  const result = await starting;
  assert.equal(result.error, 'ERR_TASK_PAUSED');
  assert.equal((await value.send({ type: 'AGENT_OBSERVE' })).error, 'ERR_TASK_PAUSED');
});

test('a reload during final observation authorization never republishes the old document', async () => {
  const value = await fixture();
  const originalGet = chrome.storage.local.get;
  let settingReads = 0;
  chrome.storage.local.get = async key => {
    const result = await originalGet(key);
    if (key === 'agentSettings' && ++settingReads === 2) {
      value.frames[0] = frame('https://allowed.test/app', ['New document']);
      chrome.tabs.onUpdated.emit(1, { status: 'loading' });
    }
    return result;
  };
  const result = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(result.snapshotId, undefined);
  assert.equal(result.error, 'ERR_PAGE_CHANGED');
});

test('a stalled final authority lookup times out without executing or poisoning the action queue', async t => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const originalGet = chrome.storage.local.get;
  let release, entered, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  chrome.storage.local.get = async key => {
    if (key === 'agentSettings' && ++reads === 2) { entered(); await gate; }
    return originalGet(key);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = value.send({ type: 'AGENT_ACT', snapshotId: observation.snapshotId,
    actionId: 'permission-timeout', action: 'click_element', args: { elementId: 'e1' } });
  await reached;
  t.mock.timers.tick(3001);
  const result = await pending;
  assert.equal(result.error, 'ERR_AGENT_PERMISSION_TIMEOUT');
  assert.equal(value.frames[0].elements[0].clicks, 0);
  release();
  await turn();
  assert.equal(value.frames[0].elements[0].clicks, 0);
  t.mock.timers.reset();
  assert.ok((await value.send({ type: 'AGENT_OBSERVE' })).snapshotId);
});

test('pause reports an unconfirmed session write within its bound and keeps the write serialized', async t => {
  const value = await fixture();
  const observation = await value.send({ type: 'AGENT_OBSERVE' });
  const originalSet = chrome.storage.session.set;
  let release, entered, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  chrome.storage.session.set = async record => {
    if (++writes === 1) { entered(); await gate; }
    return originalSet(record);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = value.send({ type: 'AGENT_PAUSE' });
  await reached;
  await turn();
  assert.equal(value.frames[0].context.__unkAiAgentSnapshots.has(observation.snapshotId), false);
  t.mock.timers.tick(2001);
  assert.equal((await pending).error, 'ERR_TASK_PAUSE_UNCONFIRMED');
  const resuming = value.send({ type: 'AGENT_RESUME' });
  await turn();
  assert.equal(writes, 1, 'resume may not bypass the actual pending session write');
  release();
  assert.equal((await resuming).ok, true);
  t.mock.timers.reset();
  const fresh = await value.send({ type: 'AGENT_OBSERVE' });
  assert.ok(fresh.snapshotId);
  assert.equal(value.frames[0].context.__unkAiAgentSnapshots.has(fresh.snapshotId), true);
});

test('revocation during final document verification discards the observation', async () => {
  const value = await fixture({ childOrigin: 'https://child.test' });
  value.setBeforeScript(request => {
    if (!request.target.frameIds || !request.func?.toString().includes('globalThis.location.href')) return;
    const oldValue = structuredClone(value.data.agentOriginGrants);
    delete value.data.agentOriginGrants['https://child.test'];
    chrome.storage.onChanged.emit({ agentOriginGrants: { oldValue, newValue: structuredClone(value.data.agentOriginGrants) } }, 'local');
  });
  const result = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(result.snapshotId, undefined);
  assert.equal(result.error, 'ERR_TASK_PAUSED');
});

test('authority revocation includes an activation whose initial session write is pending', async () => {
  const value = await fixture();
  await value.send({ type: 'AGENT_RELEASE' });
  value.data.agentOriginGrants['https://allowed.test'] = { scope: 'task', taskId: 'new-task' };
  const originalSet = chrome.storage.session.set;
  let release, entered, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  chrome.storage.session.set = async record => {
    if (++writes === 1) { entered(); await gate; }
    return originalSet(record);
  };
  const starting = value.send({ type: 'AGENT_START', taskId: 'new-task' });
  await reached;
  const oldValue = structuredClone(value.data.agentOriginGrants);
  value.data.agentOriginGrants = {};
  chrome.storage.onChanged.emit({ agentOriginGrants: { oldValue, newValue: {} } }, 'local');
  await turn();
  release();
  assert.equal((await starting).error, 'ERR_TASK_PAUSED');
  assert.equal((await value.send({ type: 'AGENT_OBSERVE', taskId: 'new-task' })).error, 'ERR_TASK_PAUSED');
});

test('navigation rechecks the full URL after its final asynchronous authority lookup', async () => {
  const value = await fixture();
  const originalGet = chrome.storage.local.get;
  let reads = 0, updates = 0;
  chrome.storage.local.get = async key => {
    const result = await originalGet(key);
    if (key === 'agentSettings' && ++reads === 2) value.setTabUrl('https://allowed.test/other#route');
    return result;
  };
  chrome.tabs.update = async () => { updates += 1; };
  const result = await value.send({ type: 'AGENT_NAVIGATE', expectedUrl: 'https://allowed.test/app',
    actionId: 'navigation-late-page-change', args: { url: 'https://allowed.test/next' } });
  assert.equal(updates, 0);
  assert.equal(result.error, 'ERR_PAGE_CHANGED');
});

test('an iframe replacement during final authority lookup cannot publish old observation data', async () => {
  const value = await fixture();
  const originalGet = chrome.storage.local.get;
  let reads = 0;
  chrome.storage.local.get = async key => {
    const result = await originalGet(key);
    if (key === 'agentSettings' && ++reads === 2) value.frames[1] = frame('https://allowed.test/frame', ['New frame'], false);
    return result;
  };
  const result = await value.send({ type: 'AGENT_OBSERVE' });
  assert.equal(result.elements, undefined);
  assert.equal(result.error, 'ERR_PAGE_CHANGED');
});

import test from 'node:test';
import { captureSiteResearchDiscovery } from '../src/utils/site-research.js';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { assertPageTarget, pageTargetFields } from '../src/utils/page-target.js';
import { mergeFramePages } from '../src/utils/page-merge.js';
import { mergeDeepReading, summarizeAccessibilityTree, summarizeDomSnapshot } from '../src/utils/deep-reading.js';
import { createPageDebuggerCoordinator, withPageDebugger } from '../src/background/network-reading-service.js';

function worker({ setTimer = setTimeout, pause = async () => {} } = {}) {
  const state = {
    activeId: 1,
    tabs: new Map([
      [1, { id: 1, url: 'https://example.test/a', title: 'A', documentId: 'doc-a', windowId: 1 }],
      [2, { id: 2, url: 'https://example.test/b', title: 'B', documentId: 'doc-b', windowId: 1 }],
    ]),
    commands: [], listeners: [], afterExtract: null, afterDiscovery: null, afterScreenshot: null, scriptBlocked: false, handled: 0, pauses: [], broadcasts: [],
  };
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: 'extension-id', getURL: (path) => `chrome-extension://extension-id/${path}`, onMessage: { addListener(fn) { state.listeners.push(fn); } }, onInstalled: event, onStartup: event, sendMessage: async (message) => { state.broadcasts.push(message); } },
    tabs: {
      get: async (id) => ({ ...state.tabs.get(id) }),
      query: async () => [{ ...state.tabs.get(state.activeId) }],
      captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA',
    },
    scripting: { executeScript: async ({ target, files, func }) => {
      if (state.scriptBlocked) throw new Error('Cannot access PDF viewer');
      const tab = state.tabs.get(target.tabId);
      if (target.documentIds && !target.documentIds.includes(tab.documentId)) throw new Error('Document no longer exists');
      if (files) return [];
      if (func === captureSiteResearchDiscovery) {
        const entry = { frameId: 0, documentId: tab.documentId, result: { url: tab.url, navigation: [] } };
        state.afterDiscovery?.();
        return [entry];
      }
      if (String(func).includes('const extractor = globalThis.__unkAiExtractor')) {
        const result = [{ frameId: 0, documentId: tab.documentId, result: { title: tab.title, url: tab.url, text: `Public article ${tab.title} text long enough to read.`, structure: {} } }];
        state.afterExtract?.();
        return result;
      }
      return [{ frameId: 0, documentId: tab.documentId, result: { url: tab.url } }];
    } },
    debugger: {
      attach: async () => {}, detach: async () => {},
      sendCommand: async (target, method) => {
        state.commands.push({ tabId: target.tabId, method });
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'root', role: { value: 'heading' }, name: { value: state.tabs.get(target.tabId).title } }] };
        if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] };
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', loaderId: state.tabs.get(target.tabId).documentId, url: state.tabs.get(target.tabId).url } } };
        if (method === 'Page.captureScreenshot') { state.afterScreenshot?.(); return { data: 'AAAA' }; }
        return {};
      },
    },
    contextMenus: { onClicked: event, removeAll: (fn) => fn(), create() {} },
    commands: { onCommand: event }, sidePanel: {},
  };
  const coordinator = createPageDebuggerCoordinator(chrome, { detachTimeoutMs: 5 });
  const context = vm.createContext({ chrome, URL, setTimeout: setTimer, clearTimeout, TextDecoder,
    withPageDebugger: (target, operation, options) => withPageDebugger(target, operation, { ...options, chrome, coordinator }),
    assertPageTarget, pageTargetFields, mergeFramePages, mergeDeepReading, summarizeAccessibilityTree, summarizeDomSnapshot, captureSiteResearchDiscovery,
    handleAgentMessage: async () => { state.handled += 1; return true; }, pauseAgentTask: async (message) => { state.pauses.push(message); await pause(); },
  });
  const source = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8').replace(/^import\s[\s\S]*?;\s*$/gm, '');
  vm.runInContext(`${source}\nglobalThis.api = { extractActivePage, captureDeepReading, captureVisualContext, captureBoundVisible, captureSiteResearch };`, context);
  return { state, api: context.api, chrome };
}

test('deep reading stays on the original tab after the active tab changes', async () => {
  const { state, api } = worker();
  state.afterExtract = () => { state.activeId = 2; };
  const page = await api.extractActivePage({ tabId: 1, expectedUrl: 'https://example.test/a' });
  const deep = await api.captureDeepReading(state.tabs.get(page.tabId), page);
  assert.equal(deep.url, 'https://example.test/a');
  assert.equal(deep.documentId, 'doc-a');
  assert.equal(deep.semanticTree[0].text, 'A');
  assert.ok(state.commands.every((command) => command.tabId === 1));
});

test('research discovery remains on its chosen tab and rejects same-URL document replacement', async () => {
  const { state, api } = worker();
  state.activeId = 2;
  const discovery = await api.captureSiteResearch({ tabId: 1, expectedUrl: 'https://example.test/a', documentId: 'doc-a' });
  assert.equal(discovery.tabId, 1);
  assert.equal(discovery.url, 'https://example.test/a');
  state.afterDiscovery = () => { state.tabs.get(1).documentId = 'new-doc'; };
  await assert.rejects(api.captureSiteResearch({ tabId: 1, expectedUrl: 'https://example.test/a', documentId: 'doc-a' }), { code: 'PAGE_CHANGED' });
});

test('a stalled debugger detach cannot keep a finished deep read pending forever', async () => {
  const scheduled = [];
  const { state, api, chrome } = worker({ setTimer: (callback, milliseconds) => {
    scheduled.push(milliseconds);
    return setTimeout(callback, 5);
  } });
  chrome.debugger.detach = () => new Promise(() => {});
  const page = await api.extractActivePage({ tabId: 1, expectedUrl: 'https://example.test/a' });
  const deep = await api.captureDeepReading(state.tabs.get(1), page);
  assert.match(deep.text, /Public article A/);
  assert.equal(deep.deepReading.available, true);
});

test('reloading the same URL during extraction rejects the stale document', async () => {
  const { state, api } = worker();
  state.afterExtract = () => { state.tabs.get(1).documentId = 'replacement-document'; };
  await assert.rejects(api.extractActivePage({ tabId: 1, expectedUrl: 'https://example.test/a' }), { code: 'PAGE_CHANGED' });
});

test('a hanging iframe injection cannot block an already readable main document', async () => {
  const { api, chrome } = worker({ setTimer: callback => setTimeout(callback, 5) });
  const execute = chrome.scripting.executeScript;
  const calls = [];
  chrome.scripting.executeScript = options => {
    calls.push(options);
    if (options.target.allFrames && options.files) return new Promise(() => {});
    return execute(options);
  };
  const page = await Promise.race([
    api.extractActivePage({ tabId: 1, expectedUrl: 'https://example.test/a', documentId: 'doc-a', lazyLoad: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('iframe blocked the main document')), 150)),
  ]);
  assert.match(page.text, /Public article A/);
  assert.equal(page.documentId, 'doc-a');
  const injection = calls.find(call => call.files);
  assert.deepEqual(Array.from(injection.target.documentIds), ['doc-a']);
  assert.equal(injection.injectImmediately, true);
});

test('a hanging iframe extraction retains the main body and still checks document identity', async () => {
  const { api, chrome, state } = worker({ setTimer: callback => setTimeout(callback, 5) });
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = options => {
    if (options.target.allFrames && options.func) return new Promise(() => {});
    return execute(options);
  };
  const page = await Promise.race([
    api.extractActivePage({ tabId: 1, expectedUrl: 'https://example.test/a', documentId: 'doc-a', lazyLoad: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('iframe extraction blocked the main document')), 150)),
  ]);
  assert.match(page.text, /Public article A/);
  assert.equal(page.documentId, 'doc-a');
  chrome.scripting.executeScript = options => {
    if (options.target.allFrames && options.func) {
      state.tabs.get(1).documentId = 'replacement-doc';
      return new Promise(() => {});
    }
    return execute(options);
  };
  await assert.rejects(api.extractActivePage({ tabId: 1, expectedUrl: 'https://example.test/a', documentId: 'doc-a', lazyLoad: false }), { code: 'PAGE_CHANGED' });
});

test('a main document without frames does not start optional frame injection', async () => {
  const { api, chrome } = worker();
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async options => {
    assert.notEqual(options.target.allFrames, true);
    const results = await execute(options);
    for (const result of results) if (result.result?.text) result.result.hasFrames = false;
    return results;
  };
  const page = await api.extractActivePage({ tabId: 1, expectedUrl: 'https://example.test/a', lazyLoad: false });
  assert.match(page.text, /Public article A/);
});

test('the final content bridge fallback preserves a wrong-route PAGE_CHANGED error', async () => {
  const { api, chrome } = worker();
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = options => {
    if (String(options.func).includes('const extractor = globalThis.__unkAiExtractor')) throw new Error('Direct extraction unavailable');
    return execute(options);
  };
  let messages = 0;
  chrome.tabs.sendMessage = async () => {
    if (++messages === 1) throw new Error('Bridge not attached');
    return { title: 'Other route', url: 'https://example.test/b', text: 'This is another route and cannot become the original article.' };
  };
  await assert.rejects(api.extractActivePage({ tabId: 1, expectedUrl: 'https://example.test/a', documentId: 'doc-a', lazyLoad: false }), { code: 'PAGE_CHANGED' });
  assert.equal(messages, 2);
});

test('automatic screenshots use the specified source tab and discard a navigated document', async () => {
  const { state, api } = worker();
  state.activeId = 2;
  const identity = { tabId: 1, expectedUrl: 'https://example.test/a', documentId: 'doc-a' };
  const shot = await api.captureVisualContext(identity);
  assert.equal(shot.url, 'https://example.test/a');
  assert.ok(state.commands.every((command) => command.tabId === 1));
  state.afterScreenshot = () => { state.tabs.get(1).documentId = 'replacement-document'; };
  await assert.rejects(api.captureVisualContext(identity), { code: 'PAGE_CHANGED' });
});

test('visible-tab fallback never captures another active tab under the old source label', async () => {
  const { state, api } = worker();
  state.activeId = 2;
  await assert.rejects(api.captureBoundVisible({ tabId: 1, url: 'https://example.test/a', documentId: 'doc-a' }, 80), { code: 'PAGE_CHANGED' });
});

test('script-blocked PDF screenshots retain a CDP document identity check', async () => {
  const { state, api } = worker();
  state.scriptBlocked = true;
  const target = { tabId: 1, expectedUrl: 'https://example.test/a' };
  assert.equal((await api.captureVisualContext(target)).url, target.expectedUrl);
  state.afterScreenshot = () => { state.tabs.get(1).documentId = 'new-pdf-document'; };
  await assert.rejects(api.captureVisualContext(target), { code: 'PAGE_CHANGED' });
});

test('agent control messages accept extension documents and reject content-script senders', async () => {
  const { state } = worker();
  const listener = state.listeners.at(-1);
  let response;
  assert.equal(listener({ type: 'AGENT_START' }, { id: 'extension-id', tab: { id: 1 }, url: 'https://example.test/a' }, (value) => { response = value; }), false);
  assert.equal(response.error, 'ERR_AGENT_SENDER');
  assert.equal(state.handled, 0);
  assert.equal(listener({ type: 'AGENT_START' }, { id: 'extension-id', url: 'chrome-extension://extension-id/src/sidepanel/index.html' }, () => {}), true);
  await Promise.resolve();
  assert.equal(state.handled, 1);
});

test('a page takeover pauses the background task before its UI broadcast', async () => {
  const { state } = worker();
  state.listeners[0]({ type: 'AGENT_TAKEOVER', taskId: 'task-a' }, { id: 'extension-id', tab: { id: 1 } });
  assert.equal(state.pauses.length, 1);
  assert.equal(state.pauses[0].taskId, 'task-a');
  assert.equal(state.pauses[0].tabId, 1);
});

test('takeover notifies the UI even if background pause cleanup never settles', async () => {
  let finishPause;
  let deadline;
  const { state } = worker({
    pause: () => new Promise(resolve => { finishPause = resolve; }),
    setTimer: (callback, ms) => { assert.equal(ms, 1500); deadline = callback; return 0; },
  });
  state.listeners[0]({ type: 'AGENT_TAKEOVER', taskId: 'task-a', reason: 'user-keyboard' }, { id: 'extension-id', tab: { id: 1 } });
  assert.equal(state.pauses.length, 1);
  assert.equal(state.broadcasts.length, 0);
  deadline();
  assert.equal(state.broadcasts.length, 1);
  assert.equal(state.broadcasts[0].reason, 'user-keyboard');
  finishPause();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.broadcasts.length, 1, 'late cleanup must not broadcast a duplicate takeover');
});

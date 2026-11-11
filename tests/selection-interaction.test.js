import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// This remains an entry-owned UI event adapter, not a migrated conversation service.
const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
const start = entry.indexOf('function watchSelectionInteractions() {');
const end = entry.indexOf('\ninitialize();', start);
assert.ok(start >= 0 && end > start);
const adapter = entry.slice(start, end);

function fixture({ selection = { text: '新的网页选区', url: 'https://example.test/article' }, error = null } = {}) {
  const pointerListeners = [], focusListeners = [], timers = [], requests = [];
  const captured = { text: '提问前已经捕获的选区', url: 'https://example.test/article' };
  let current = captured;
  let queries = 0;
  const context = vm.createContext({
    document: { addEventListener(type, listener) { if (type === 'pointerdown') pointerListeners.push(listener); } },
    window: { addEventListener(type, listener) { if (type === 'focus') focusListeners.push(listener); } },
    setTimeout: callback => { timers.push(callback); return timers.length; },
    chrome: {
      tabs: { query: async () => { queries++; return [{ id: 7, url: 'https://example.test/article' }]; } },
      runtime: { sendMessage: async message => {
        requests.push(message);
        if (error) throw error;
        return { selection };
      } },
    },
    setPageSelection: value => { current = value; },
  });
  vm.runInContext(`${adapter}\nwatchSelectionInteractions();`, context);
  return { captured, requests, timers,
    get current() { return current; },
    get queries() { return queries; },
    pointer(ancestors = []) {
      const target = { closest: selector => ancestors.includes(selector) ? { selector } : null };
      pointerListeners.forEach(listener => listener({ target }));
    },
    focus() { focusListeners.forEach(listener => listener()); },
    async flush() { while (timers.length) await timers.shift()(); },
  };
}

test('choosing a header model or its nested options preserves the captured selection without re-reading', async () => {
  const value = fixture({ selection: null });
  for (const child of ['#model-trigger', '[data-model-id]', '[data-effort]', '#dropdown-open-settings']) {
    value.pointer([child, '#model-switcher']);
  }
  await value.flush();
  assert.equal(value.queries, 0);
  assert.equal(value.requests.length, 0);
  assert.equal(value.current, value.captured);
});

test('composer pointer interactions retain the existing no-reread behavior', async () => {
  const value = fixture({ selection: null });
  value.pointer(['#message-input', '#composer']);
  value.pointer(['#composer-reading-depth', '#composer']);
  await value.flush();
  assert.equal(value.queries, 0);
  assert.equal(value.current, value.captured);
});

test('other sidebar interactions and focus still refresh page selection without reading the page body', async () => {
  const value = fixture();
  value.pointer(['#theme-toggle']);
  value.focus();
  await value.flush();
  assert.equal(value.queries, 2);
  assert.equal(value.requests.length, 2);
  assert.ok(value.requests.every(request => request.type === 'GET_PAGE_SELECTION' && request.tabId === 7));
  assert.equal(value.current.text, '新的网页选区');
});

test('a failed selection refresh retains the last captured selection', async () => {
  const value = fixture({ error: new Error('worker restarting') });
  value.focus();
  await value.flush();
  assert.equal(value.requests.length, 1);
  assert.equal(value.current, value.captured);
});

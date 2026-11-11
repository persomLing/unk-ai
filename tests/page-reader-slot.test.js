import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageReaderSlot } from '../src/sidepanel/features/page-reading/page-reader-slot.js';

function pdfPage(url, title = 'Report') {
  const text = 'PDF body text long enough to pass normalization.';
  return {
    title,
    url,
    text,
    chars: text.length,
    truncated: false,
    sections: [{ id: 'pdf-page-1', level: 1, text: '第 1 页' }],
    structure: { pdf: { pageCount: 1, pagesRead: 1, truncated: false } },
  };
}

test('an active PDF tab is parsed locally without extracting page DOM', async () => {
  const calls = [];
  const slot = createPageReaderSlot({
    sendMessage: async () => {
      calls.push('message');
      throw new Error('the DOM extractor must not run for PDFs');
    },
    queryActiveTab: async () => ({ id: 7, url: 'https://example.test/report.pdf', title: 'Tab title' }),
    sendTabMessage: async () => {
      calls.push('tab-message');
      return null;
    },
    readPdf: async (url, options) => {
      calls.push(`pdf:${url}:${options.maxBudget}`);
      return pdfPage(url);
    },
    getNow: () => '2026-10-29T00:00:00.000Z',
    ui: {
      begin: () => calls.push('begin'),
      beginPdf: () => calls.push('beginPdf'),
      end: () => calls.push('end'),
    },
  });
  const page = await slot.read({ deep: true });
  assert.equal(page.title, 'Report');
  assert.equal(page.structure.pdf.pageCount, 1);
  assert.equal(page.capturedAt, '2026-10-29T00:00:00.000Z');
  assert.deepEqual(calls, ['beginPdf', 'pdf:https://example.test/report.pdf:60000', 'end']);
});

test('a PDF descriptor returned by the background is parsed locally', async () => {
  const calls = [];
  const slot = createPageReaderSlot({
    sendMessage: async () => ({ pdf: { url: 'https://example.test/download?id=1', title: 'Online report' } }),
    queryActiveTab: async () => ({ id: 8, url: 'https://example.test/viewer?id=1', title: 'Viewer' }),
    sendTabMessage: async () => {
      calls.push('tab-message');
      return null;
    },
    readPdf: async (url, options) => {
      calls.push(`pdf:${url}:${options.title}`);
      return pdfPage(url, 'Online report');
    },
    ui: {
      begin: () => calls.push('begin'),
      beginPdf: () => calls.push('beginPdf'),
      end: () => calls.push('end'),
    },
  });
  const page = await slot.read();
  assert.equal(page.title, 'Online report');
  assert.deepEqual(calls, ['begin', 'beginPdf', 'pdf:https://example.test/download?id=1:Online report', 'end']);
});

test('PDF parsing failures are surfaced and do not fall back to DOM extraction', async () => {
  const calls = [];
  const slot = createPageReaderSlot({
    sendMessage: async () => {
      calls.push('message');
      return { text: 'unrelated page text' };
    },
    queryActiveTab: async () => ({ id: 9, url: 'file:///C:/reports/local.pdf', title: 'Local report' }),
    sendTabMessage: async () => null,
    readPdf: async () => {
      throw new Error('请在 chrome://extensions 启用文件网址访问。');
    },
    ui: {
      beginPdf: () => calls.push('beginPdf'),
      fail: () => calls.push('fail'),
      notify: (error) => calls.push(`notify:${error.message}`),
      end: () => calls.push('end'),
    },
  });
  const page = await slot.read();
  assert.equal(page, null);
  assert.deepEqual(calls, [
    'beginPdf',
    'fail',
    'notify:请在 chrome://extensions 启用文件网址访问。',
    'end',
  ]);
});

test('repository source reads code files instead of extracting page DOM', async () => {
  const calls = [];
  const slot = createPageReaderSlot({
    sendMessage: async () => {
      calls.push('page-message');
      throw new Error('DOM extraction must not run for repository source');
    },
    queryActiveTab: async () => ({
      id: 10,
      url: 'https://github.com/acme/demo',
      title: 'acme/demo',
    }),
    sendTabMessage: async () => null,
    readRepository: async (url, options) => {
      calls.push(`repository:${url}:${options.maxFiles}`);
      const text = 'Repository source text long enough to pass normalization.';
      return {
        title: 'acme/demo',
        url,
        text,
        chars: text.length,
        outline: [{ id: 'repo', level: 1, text: 'acme/demo' }],
        structure: { github: { readFiles: ['README.md'], readFileCount: 1 } },
      };
    },
    ui: { begin: () => calls.push('begin'), end: () => calls.push('end') },
  });
  const page = await slot.read({ source: 'repository', maxFiles: 7 });
  assert.equal(page.structure.github.readFileCount, 1);
  assert.deepEqual(calls, [
    'begin',
    'repository:https://github.com/acme/demo:7',
    'end',
  ]);
});

test('repository source surfaces reader failure without falling back to the page', async () => {
  const calls = [];
  const slot = createPageReaderSlot({
    sendMessage: async () => {
      calls.push('page-message');
      return { text: 'unrelated page text long enough for normalization' };
    },
    queryActiveTab: async () => ({ id: 11, url: 'https://github.com/acme/demo', title: 'demo' }),
    sendTabMessage: async () => {
      calls.push('tab-message');
      return null;
    },
    readRepository: async () => {
      throw new Error('repository unavailable');
    },
    ui: {
      begin: () => calls.push('begin'),
      fail: () => calls.push('fail'),
      notify: (error) => calls.push(`notify:${error.message}`),
      end: () => calls.push('end'),
    },
  });
  const page = await slot.read({ source: 'repository' });
  assert.equal(page, null);
  assert.deepEqual(calls, [
    'begin',
    'fail',
    'notify:repository unavailable',
    'end',
  ]);
});

test('reading pins the queried tab and rejects a response from a different page', async () => {
  const calls = [];
  const slot = createPageReaderSlot({
    queryActiveTab: async () => ({ id: 12, url: 'https://example.test/a' }),
    sendMessage: async (request) => {
      calls.push(request);
      return { ...pdfPage('https://example.test/b'), tabId: 13, documentId: 'other-document' };
    },
  });
  assert.equal(await slot.read(), null);
  assert.equal(calls[0].tabId, 12);
  assert.equal(calls[0].expectedUrl, 'https://example.test/a');
});

test('explicit targets preserve document identity without consulting the active tab', async () => {
  const slot = createPageReaderSlot({
    queryActiveTab: async () => { throw new Error('must not query active'); },
    queryTab: async (id) => ({ id, url: 'https://example.test/a' }),
    sendMessage: async (request) => ({ ...pdfPage(request.expectedUrl), tabId: request.tabId, documentId: request.documentId }),
  });
  const page = await slot.read({ tabId: 12, expectedUrl: 'https://example.test/a', documentId: 'doc-a' });
  assert.equal(page.tabId, 12);
  assert.equal(page.documentId, 'doc-a');
});

const never = () => new Promise(() => {});
const readingTab = { id: 21, url: 'https://example.test/#/chapter-3', title: 'RAG' };
const pageResult = (value = 'Chapter three explains retrieval augmented generation in detail.') => ({
  url: readingTab.url, tabId: readingTab.id, documentId: 'doc-21', text: value, structure: {}, links: [],
});

test('the overall deadline includes a tab lookup that never answers', async () => {
  const calls = [];
  const slot = createPageReaderSlot({
    queryActiveTab: never,
    sendMessage: async () => { calls.push('extract'); return pageResult(); },
    ui: { fail: () => calls.push('fail'), notify: () => calls.push('notify'), end: () => calls.push('end') },
  });
  await assert.rejects(slot.read({ timeoutMs: 15, throwOnError: true }), { name: 'TimeoutError', code: 'PAGE_READ_TIMEOUT' });
  assert.deepEqual(calls, ['fail', 'end']);
});

test('both ordinary and deep worker reads time out without retrying or falling back', async () => {
  for (const deep of [false, true]) {
    const calls = [];
    const slot = createPageReaderSlot({
      queryActiveTab: async () => readingTab,
      sendMessage: (request) => { calls.push(request.type); return never(); },
      sendTabMessage: async () => { calls.push('fallback'); return pageResult(); },
      ui: { end: () => calls.push('end') },
    });
    await assert.rejects(slot.read({ deep, timeoutMs: 15, throwOnError: true }), { code: 'PAGE_READ_TIMEOUT' });
    assert.deepEqual(calls, [deep ? 'EXTRACT_DEEP_PAGE' : 'EXTRACT_PAGE', 'end']);
  }
});

test('legacy detail extraction shares the same bounded wait', async () => {
  const slot = createPageReaderSlot({
    queryActiveTab: async () => readingTab,
    sendMessage: async () => ({ url: readingTab.url, text: 'A valid plain article body from an older worker.' }),
    sendTabMessage: never,
  });
  await assert.rejects(slot.read({ timeoutMs: 15, throwOnError: true }), { code: 'PAGE_READ_TIMEOUT' });
});

test('a caller abort settles a pending browser message immediately and suppresses notification', async () => {
  const controller = new AbortController();
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const calls = [];
  const slot = createPageReaderSlot({
    queryActiveTab: async () => readingTab,
    sendMessage: () => { started(); return never(); },
    ui: { notify: () => calls.push('notify'), end: () => calls.push('end') },
  });
  const read = slot.read({ signal: controller.signal, throwOnError: true });
  await pending;
  controller.abort();
  await assert.rejects(read, { name: 'AbortError' });
  assert.deepEqual(calls, ['end']);
});

test('timed out PDF reads receive the internal cancellation signal', async () => {
  let signal;
  const slot = createPageReaderSlot({
    queryActiveTab: async () => ({ ...readingTab, url: 'https://example.test/report.pdf' }),
    readPdf: (_url, options) => { signal = options.signal; return never(); },
  });
  await assert.rejects(slot.read({ timeoutMs: 15, throwOnError: true }), { code: 'PAGE_READ_TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('an unready SPA is freshly extracted again on the original tab and document', async () => {
  const calls = [];
  const slot = createPageReaderSlot({
    queryTab: async () => readingTab,
    queryActiveTab: () => { throw new Error('must not switch to the active tab'); },
    sendMessage: async request => {
      calls.push(request);
      return calls.length === 1 ? pageResult('') : pageResult();
    },
  });
  const page = await slot.read({ tabId: 21, expectedUrl: readingTab.url, documentId: 'doc-21', retryDelayMs: 0, throwOnError: true });
  assert.match(page.text, /Chapter three/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].forceRefresh, true);
  assert.ok(calls.every(request => request.tabId === 21 && request.documentId === 'doc-21' && request.expectedUrl === readingTab.url));
});

test('readiness retries are finite and return an explicit failure instead of a shell', async () => {
  let calls = 0;
  const slot = createPageReaderSlot({
    queryActiveTab: async () => readingTab,
    sendMessage: async () => { calls += 1; return pageResult('Loading...'); },
  });
  await assert.rejects(slot.read({ readAttempts: 3, retryDelayMs: 0, throwOnError: true }), { code: 'PAGE_NOT_READY' });
  assert.equal(calls, 3);
});

test('a deadline during readiness waiting prevents the next extraction', async () => {
  let calls = 0;
  const slot = createPageReaderSlot({
    queryActiveTab: async () => readingTab,
    sendMessage: async () => { calls += 1; return pageResult(''); },
  });
  await assert.rejects(slot.read({ timeoutMs: 15, retryDelayMs: 50, throwOnError: true }), { code: 'PAGE_READ_TIMEOUT' });
  assert.equal(calls, 1);
});

test('late worker replies cannot complete or restart a timed out read', async () => {
  let reply;
  const calls = [];
  const slot = createPageReaderSlot({
    queryActiveTab: async () => readingTab,
    sendMessage: () => new Promise(resolve => { reply = resolve; }),
    ui: { notify: error => calls.push(error.code), end: () => calls.push('end') },
  });
  assert.equal(await slot.read({ timeoutMs: 15 }), null);
  reply(pageResult());
  await Promise.resolve();
  assert.deepEqual(calls, ['PAGE_READ_TIMEOUT', 'end']);
});

test('an unready reply from another route is rejected without retrying it', async () => {
  let calls = 0;
  const slot = createPageReaderSlot({
    queryActiveTab: async () => readingTab,
    sendMessage: async () => { calls += 1; return { ...pageResult(''), url: 'https://example.test/#/other' }; },
  });
  await assert.rejects(slot.read({ retryDelayMs: 0, throwOnError: true }), { code: 'PAGE_CHANGED' });
  assert.equal(calls, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicResearchTransport } from '../src/sidepanel/features/web-research/public-research-transport.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const markup = `<a class="result__a" href="https://evidence.test/article">Public evidence</a>
  <div class="result__snippet">Search summary with dates.</div>`;

test('public search sends the exact model query and returns summaries without automatic page reads', async () => {
  const calls = [];
  const transport = createPublicResearchTransport({ fetchImpl: async (url, init) => {
    calls.push({ url, init }); return new Response(markup, { headers: { 'content-type': 'text/html' } });
  } });
  const result = await transport.search('1998 finals historical results');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('q'), '1998 finals historical results');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(result.results[0].url, 'https://evidence.test/article');
  assert.equal(result.results[0].content, undefined);
  assert.match(result.results[0].snippet, /Search summary/);
});

test('public page reads inert bounded HTML and strips navigation, scripts and styles', async () => {
  const transport = createPublicResearchTransport({ fetchImpl: async () => new Response(
    `<html><head><title>A &amp; B</title><style>PRIVATE_STYLE</style></head>
    <body><nav>PRIVATE_NAV</nav><script>PRIVATE_SCRIPT</script><article>${'A &lt; B &amp; C. '.repeat(20)}</article></body></html>`,
    { headers: { 'content-type': 'text/html' } }) });
  const result = await transport.fetch('https://evidence.test/article');
  assert.equal(result.url, 'https://evidence.test/article');
  assert.equal(result.title, 'A & B');
  assert.match(result.content, /A < B & C/);
  assert.doesNotMatch(result.content, /PRIVATE/);
  assert.equal(result.truncated, false);
});

test('public fetch rejects unsafe targets, redirects and non-page bodies before publishing evidence', async () => {
  let calls = 0;
  const unsafe = createPublicResearchTransport({ fetchImpl: async () => { calls++; return new Response('body'); } });
  for (const url of ['http://127.0.0.1/private', 'http://router.local/x', 'https://a:b@public.test/x', 'file:///private']) {
    await assert.rejects(unsafe.fetch(url), /公开|地址/);
  }
  assert.equal(calls, 0);
  const redirect = createPublicResearchTransport({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }) });
  await assert.rejects(redirect.fetch('https://evidence.test/article'), /302|重定向/);
  const binary = createPublicResearchTransport({ fetchImpl: async () => new Response('PDF', { headers: { 'content-type': 'application/pdf' } }) });
  await assert.rejects(binary.fetch('https://evidence.test/document'), /正文|类型/);
});

test('unexpected redirected response identity cannot replace the original source', async () => {
  const response = new Response('A full readable public body. '.repeat(20));
  Object.defineProperty(response, 'url', { value: 'http://127.0.0.1/private' });
  const transport = createPublicResearchTransport({ fetchImpl: async () => response });
  await assert.rejects(transport.fetch('https://evidence.test/article'), /地址|重定向/);
});

test('public body budget limits oversized stream chunks and cancels remaining transport', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('x'.repeat(200000)));
  }, cancel() { cancelled = true; } });
  const transport = createPublicResearchTransport({ fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/plain' } }) });
  const result = await transport.fetch('https://evidence.test/article');
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 8000);
  assert.equal(cancelled, true);
});

test('public read handles a declared non-UTF8 charset', async () => {
  const bytes = new Uint8Array(Array.from({ length: 100 }, () => [0xbb, 0xd8, 0xc3, 0xfb]).flat());
  const transport = createPublicResearchTransport({ fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'text/plain; charset=gbk' } }) });
  const result = await transport.fetch('https://evidence.test/article');
  assert.equal(result.content, '回名'.repeat(100));
});

test('public transport stops a non-cooperating fetch and a hanging response stream', async () => {
  const stopped = new AbortController(); let sentSignal;
  const transport = createPublicResearchTransport({ fetchImpl: (_url, { signal }) => {
    sentSignal = signal; return new Promise(() => {});
  } });
  const pending = transport.search('source', { signal: stopped.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); stopped.abort(new DOMException('stop', 'AbortError')); await rejected;
  assert.equal(sentSignal.aborted, true);
  let cancelled = false;
  const hanging = createPublicResearchTransport({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects(hanging.fetch('https://evidence.test/article', { deadlineAt: Date.now() + 20 }), { name: 'TimeoutError' });
  assert.equal(cancelled, true);
});

test('public search filters additional private forms and exposes response truncation', async () => {
  const privateResult = '<a class="result__a" href="http://100.64.0.1/private">Private</a><div class="result__snippet">Private summary.</div>';
  const transport = createPublicResearchTransport({ fetchImpl: async () => new Response(privateResult + markup + 'x'.repeat(150000), { headers: { 'content-type': 'text/html' } }) });
  const result = await transport.search('source');
  assert.deepEqual(result.results.map(item => item.url), ['https://evidence.test/article']);
  assert.equal(result.truncated, true);
});

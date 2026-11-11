import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchToolSession, RESEARCH_TOOL_CONTRACTS } from '../src/sidepanel/features/web-research/research-tools.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const tool = (name, args, id = `${name}-1`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const body = 'Public source body containing the evidence and relevant dates. '.repeat(12).trim();
const source = (name = 'one', extra = {}) => ({ title: `Source ${name}`, url: `https://${name}.test/article`, snippet: 'Search summary only.', ...extra });
function fixture(t, { request, ...options } = {}) {
  const calls = [];
  const session = createResearchToolSession({ connection: { request(input) {
    calls.push(input);
    return request?.(input) ?? { results: [source()] };
  } }, now: () => Date.parse('2026-11-09T02:00:00Z'), ...options });
  t.after(() => session.dispose());
  return { calls, session };
}

test('tool schemas are read-only, bounded and only expose fetching when enabled', t => {
  const { session } = fixture(t, { fetchEnabled: false });
  assert.deepEqual(session.tools.map(item => item.function.name), ['web_search']);
  const schema = session.tools[0].function.parameters;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.query.maxLength, 200);
  assert.equal(RESEARCH_TOOL_CONTRACTS.web_search.readOnly, true);
  assert.equal(RESEARCH_TOOL_CONTRACTS.read_webpage.retrySafe, true);
  assert.ok(Object.isFrozen(session.tools));
  return assert.rejects(session.execute(tool('read_webpage', { sourceId: 'source-1' })), /未启用|不可用/);
});

test('search sends exactly the model query once and does not prefetch sources', async t => {
  const { session, calls } = fixture(t);
  const result = await session.execute(tool('web_search', { query: '怎么核对最新发布？' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, 'web-search');
  assert.equal(calls[0].query, '怎么核对最新发布？');
  assert.equal(result.untrusted, true);
  assert.equal(result.sources[0].readStatus, 'search-summary');
  assert.equal(result.sources[0].url, source().url);
  assert.equal(result.sources[0].capturedAt, '2026-11-09T02:00:00.000Z');
  assert.match(result.notice, /不可信|不是指令/);
});

test('existing complete source bodies are reused without a second gateway request', async t => {
  const { session, calls } = fixture(t, { request: () => ({ results: [source('one', { content: body })] }) });
  const searched = await session.execute(tool('web_search', { query: 'source' }));
  const read = await session.execute(tool('read_webpage', { sourceId: searched.sources[0].sourceId }));
  assert.equal(calls.length, 1);
  assert.equal(read.source.readStatus, 'body');
  assert.equal(read.source.text, body);
  assert.equal(read.reused, true);
});

test('only a source returned in this session can be fetched and its identity stays fixed', async t => {
  const { session, calls } = fixture(t, { request: input => input.purpose === 'web-search'
    ? { results: [source()] } : { url: source().url, content: body, title: 'Readable title' } });
  await assert.rejects(session.execute(tool('read_webpage', { sourceId: 'source-999' })), /来源/);
  await assert.rejects(session.execute(tool('read_webpage', { url: source().url }, 'bad-url')), /参数/);
  const searched = await session.execute(tool('web_search', { query: 'source' }));
  const read = await session.execute(tool('read_webpage', { sourceId: searched.sources[0].sourceId }, 'read-valid'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, source().url);
  assert.equal(calls[1].purpose, 'web-fetch');
  assert.equal(read.source.sourceId, searched.sources[0].sourceId);
  assert.equal(session.sources()[0].text, body);
});

test('source redirection cannot silently rebind a source ID', async t => {
  const { session } = fixture(t, { request: input => input.purpose === 'web-search'
    ? { results: [source()] } : { url: 'https://other.test/unrelated', content: body } });
  const result = await session.execute(tool('web_search', { query: 'source' }));
  await assert.rejects(session.execute(tool('read_webpage', { sourceId: result.sources[0].sourceId })), /地址|来源/);
  assert.equal(session.sources()[0].url, source().url);
  assert.equal(session.sources()[0].readStatus, 'search-summary');
});

test('private, credentials, local and non-HTTP source URLs are excluded before registration', async t => {
  const blocked = ['http://127.0.0.1/x', 'http://2130706433/x', 'http://10.0.0.1/x', 'http://172.20.0.1/x',
    'http://192.168.1.1/x', 'http://169.254.169.254/x', 'http://100.64.0.1/x', 'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x', 'http://[fc00::1]/x', 'http://[fe80::1]/x', 'http://localhost/x',
    'http://sub.localhost/x', 'http://router.local/x', 'https://user:password@public.test/x', 'file:///secret'];
  const { session } = fixture(t, { request: () => ({ results: [...blocked.map(url => ({ url, title: 'Private', snippet: 'Private' })), source()] }) });
  const result = await session.execute(tool('web_search', { query: 'source' }));
  assert.deepEqual(result.sources.map(item => item.url), [source().url]);
  assert.equal(session.sources().length, 1);
});

test('arguments and call identity are validated before any side effect', async t => {
  const { session, calls } = fixture(t);
  for (const candidate of [
    tool('delete_page', {}), tool('web_search', { query: '' }, 'empty'),
    tool('web_search', { query: 'x'.repeat(201) }, 'long'), tool('web_search', { query: 'x', endpoint: 'evil' }, 'extra'),
    { id: 'malformed', type: 'function', function: { name: 'web_search', arguments: '{' } },
    { id: 'array', type: 'function', function: { name: 'web_search', arguments: '[]' } },
  ]) await assert.rejects(session.execute(candidate), /工具|参数/);
  assert.equal(calls.length, 0);
  await session.execute(tool('web_search', { query: 'first' }, 'same-call'));
  await assert.rejects(session.execute(tool('web_search', { query: 'different' }, 'same-call')), /重复|归属|复用/);
  assert.equal(calls.length, 1);
});

test('duplicate calls and concurrent identical queries share the original request', async t => {
  const wait = deferred();
  const { session, calls } = fixture(t, { request: () => wait.promise });
  const a = session.execute(tool('web_search', { query: 'same' }, 'call-a'));
  const b = session.execute(tool('web_search', { query: 'same' }, 'call-b'));
  const c = session.execute(tool('web_search', { query: 'same' }, 'call-a'));
  await tick();
  assert.equal(calls.length, 1);
  wait.resolve({ results: [source()] });
  assert.deepEqual(await a, await b);
  assert.deepEqual(await a, await c);
  await session.execute(tool('web_search', { query: 'same' }, 'call-c'));
  assert.equal(calls.length, 1);
});

test('fetching the same source twice concurrently does not duplicate transport', async t => {
  const wait = deferred();
  const { session, calls } = fixture(t, { request: input => input.purpose === 'web-search' ? { results: [source()] } : wait.promise });
  const result = await session.execute(tool('web_search', { query: 'source' }));
  const a = session.execute(tool('read_webpage', { sourceId: result.sources[0].sourceId }, 'read-a'));
  const b = session.execute(tool('read_webpage', { sourceId: result.sources[0].sourceId }, 'read-b'));
  await tick();
  assert.equal(calls.length, 2);
  wait.resolve({ content: body, url: source().url });
  assert.deepEqual(await a, await b);
});

test('search and total call budgets reject before another side effect', async t => {
  const { session, calls } = fixture(t, { maxSearches: 1, maxCalls: 2,
    request: input => input.purpose === 'web-search' ? { results: [source(), source('two')] } : { content: body } });
  const result = await session.execute(tool('web_search', { query: 'source' }));
  await assert.rejects(session.execute(tool('web_search', { query: 'another' }, 'second-search')), /预算|次数/);
  await session.execute(tool('read_webpage', { sourceId: result.sources[0].sourceId }));
  await assert.rejects(session.execute(tool('read_webpage', { sourceId: result.sources[1].sourceId }, 'third-call')), /预算|次数/);
  assert.equal(calls.length, 2);
});

test('source registry and serialized results have hard size bounds and report truncation', async t => {
  let round = 0;
  const { session } = fixture(t, { maxSearches: 3, request: () => ({ results: Array.from({ length: 20 }, (_, i) =>
    source(`round${round}-item${i}`, { content: 'x'.repeat(24000), title: 'Title'.repeat(300) })) }) });
  for (round = 0; round < 3; round++) {
    const result = await session.execute(tool('web_search', { query: `query ${round}` }, `search-${round}`));
    assert.ok(JSON.stringify(result).length <= 12000);
    assert.ok(result.sources.length <= 6);
    assert.equal(result.truncated, true);
  }
  assert.ok(session.sources().length <= 12);
  assert.ok(session.sources().every(item => item.text.length <= 8000 && item.truncated));
});

test('reused bodies also respect the serialized JSON budget after escaping', async t => {
  const { session } = fixture(t, { request: () => ({ results: [source('one', { content: '"'.repeat(7500) })] }) });
  const found = await session.execute(tool('web_search', { query: 'quoted body' }));
  const result = await session.execute(tool('read_webpage', { sourceId: found.sources[0].sourceId }));
  assert.equal(result.reused, true);
  assert.ok(JSON.stringify(result).length <= 12000);
  assert.equal(result.source.truncated, true);
});

test('duplicate URLs keep their IDs and full URL distinctions are retained', async t => {
  const { session } = fixture(t, { request: () => ({ results: [source(), source(), source('one', { url: `${source().url}?version=2` })] }) });
  const a = await session.execute(tool('web_search', { query: 'first' }));
  const b = await session.execute(tool('web_search', { query: 'second' }, 'search-b'));
  assert.equal(a.sources.length, 2);
  assert.deepEqual(a.sources.map(item => item.sourceId), b.sources.map(item => item.sourceId));
  assert.equal(session.sources().length, 2);
});

test('permission, transport and empty-source failures remain visible and are not retried', async t => {
  const failure = Object.assign(new Error('permission denied'), { status: 403 });
  const { session, calls } = fixture(t, { request: () => Promise.reject(failure) });
  await assert.rejects(session.execute(tool('web_search', { query: 'source' })), error => error === failure);
  await assert.rejects(session.execute(tool('web_search', { query: 'source' }, 'again')), error => error === failure);
  assert.equal(calls.length, 1);
  const empty = fixture(t, { request: () => ({ results: [] }) });
  await assert.rejects(empty.session.execute(tool('web_search', { query: 'empty' })), /来源|结果/);
});

test('stop promptly ends a non-cooperating request and late sources cannot be published', async t => {
  const wait = deferred(); const abort = new AbortController();
  const { session, calls } = fixture(t, { signal: abort.signal, request: () => wait.promise });
  const pending = session.execute(tool('web_search', { query: 'source' }));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick();
  abort.abort(new DOMException('stopped', 'AbortError'));
  await rejected;
  assert.equal(calls[0].signal.aborted, true);
  wait.resolve({ results: [source()] });
  await tick();
  assert.deepEqual(session.sources(), []);
  await assert.rejects(session.execute(tool('web_search', { query: 'later' }, 'later')), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('deadline bounds a hanging gateway independently and blocks new requests', async t => {
  const { session, calls } = fixture(t, { now: Date.now, deadlineAt: Date.now() + 25, request: () => new Promise(() => {}) });
  await assert.rejects(session.execute(tool('web_search', { query: 'source' })), { name: 'TimeoutError' });
  await assert.rejects(session.execute(tool('web_search', { query: 'later' }, 'later')), { name: 'TimeoutError' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
});

test('disposing a session cancels active fetching and prevents late record changes', async t => {
  const wait = deferred();
  const { session, calls } = fixture(t, { request: input => input.purpose === 'web-search' ? { results: [source()] } : wait.promise });
  const found = await session.execute(tool('web_search', { query: 'source' }));
  const pending = session.execute(tool('read_webpage', { sourceId: found.sources[0].sourceId }));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); session.dispose(); await rejected;
  wait.resolve({ content: body }); await tick();
  assert.equal(session.sources()[0].readStatus, 'search-summary');
  assert.equal(calls[1].signal.aborted, true);
  await assert.rejects(session.execute(tool('read_webpage', { sourceId: found.sources[0].sourceId }, 'new-read')), { name: 'AbortError' });
});

test('validate rejects a malformed batch without reserving calls or starting transport', async t => {
  const { session, calls } = fixture(t);
  const good = tool('web_search', { query: 'source' });
  assert.doesNotThrow(() => session.validate(good));
  assert.throws(() => session.validate(tool('read_webpage', { sourceId: 'not-returned' })), /来源/);
  assert.throws(() => session.validate(tool('web_search', { query: 'source', extra: true })), /参数/);
  assert.equal(calls.length, 0);
  await session.execute(good);
  assert.equal(calls.length, 1);
});

test('later search bodies upgrade an existing source without changing its ID or fetching again', async t => {
  let searches = 0;
  const { session, calls } = fixture(t, { request: () => ({ results: [source('one', ++searches === 1 ? {} : { content: body })] }) });
  const first = await session.execute(tool('web_search', { query: 'first' }, 'first'));
  const next = await session.execute(tool('web_search', { query: 'second' }, 'second'));
  assert.equal(next.sources[0].sourceId, first.sources[0].sourceId);
  assert.equal(next.sources[0].readStatus, 'body');
  const read = await session.execute(tool('read_webpage', { sourceId: first.sources[0].sourceId }));
  assert.equal(read.reused, true);
  assert.equal(read.source.text, body);
  assert.equal(calls.length, 2);
});

test('source metadata reports only evidence actually returned to the model', async t => {
  const longBody = body.repeat(5);
  const { session } = fixture(t, { request: () => ({ results: [source('one', { content: longBody })] }) });
  const result = await session.execute(tool('web_search', { query: 'source' }));
  assert.deepEqual(session.sources(), result.sources);
  assert.equal(session.sources()[0].truncated, true);
  const read = await session.execute(tool('read_webpage', { sourceId: result.sources[0].sourceId }));
  assert.deepEqual(session.sources(), [read.source]);
  assert.equal(session.sources()[0].truncated, false);
});

test('missing gateway capabilities use explicit fallback without prefetching or changing queries', async t => {
  const publicCalls = [];
  const { session, calls } = fixture(t, { request: () => Promise.reject(Object.assign(new Error('missing'), { status: 404 })),
    fallbackSearch: async (query, options) => { publicCalls.push({ query, options }); return { results: [source()] }; },
    fallbackFetch: async (url, options) => { publicCalls.push({ url, options }); return { url, content: body }; } });
  const found = await session.execute(tool('web_search', { query: '1998 年历史事件' }));
  assert.equal(publicCalls.length, 1);
  assert.equal(publicCalls[0].query, '1998 年历史事件');
  assert.equal(publicCalls[0].options.signal, calls[0].signal);
  await session.execute(tool('read_webpage', { sourceId: found.sources[0].sourceId }));
  assert.equal(publicCalls.length, 2);
  assert.equal(publicCalls[1].url, source().url);
});

test('fallback never hides authentication, permission, quota, network, cancellation or timeout failures', async t => {
  const failures = [401, 403, 429, 500].map(status => Object.assign(new Error('failed'), { status }));
  failures.push(new TypeError('fetch failed'), new DOMException('stopped', 'AbortError'), new DOMException('slow', 'TimeoutError'));
  for (const failure of failures) {
    let used = false;
    const { session } = fixture(t, { request: () => Promise.reject(failure), fallbackSearch: async () => { used = true; return { results: [source()] }; } });
    await assert.rejects(session.execute(tool('web_search', { query: 'source' })), error => error === failure);
    assert.equal(used, false);
  }
});

test('fallback shares the original tool deadline and late fallback results remain unpublished', async t => {
  const wait = deferred(); let fallbackSignal;
  const { session } = fixture(t, { now: Date.now, deadlineAt: Date.now() + 30,
    request: () => Promise.reject(Object.assign(new Error('missing'), { status: 501 })),
    fallbackSearch: (_query, { signal }) => { fallbackSignal = signal; return wait.promise; } });
  await assert.rejects(session.execute(tool('web_search', { query: 'source' })), { name: 'TimeoutError' });
  assert.equal(fallbackSignal.aborted, true);
  wait.resolve({ results: [source()] }); await tick();
  assert.deepEqual(session.sources(), []);
});

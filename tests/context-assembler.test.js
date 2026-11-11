import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextAssembler } from '../src/app/context-assembler.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const run = overrides => ({ conversationId: 'conversation', turnId: 'turn', runId: 'run', mode: 'chat', ...overrides });
const block = (content, extras = {}) => ({ id: 'body', content, source: { kind: 'fixture', url: 'https://page.test/' }, ...extras });

test('throwing, malformed and hanging optional providers cannot block usable context', async () => {
  const forever = deferred();
  let hangingSignal;
  const assembler = createContextAssembler({ providers: [
    { id: 'throws', collect() { throw new Error('optional failed'); } },
    { id: 'invalid', collect: () => ({ content: 'not an array' }) },
    { id: 'hangs', timeoutMs: 15, collect(_input, context) { hangingSignal = context.signal; return forever.promise; } },
    { id: 'good', collect: () => [block('actual context')] },
  ] });
  const result = await assembler.collect({ question: 'answer normally' }, run());
  assert.deepEqual(result.blocks.map(item => item.content), ['actual context']);
  assert.deepEqual(result.issues.map(item => item.providerId), ['throws', 'invalid', 'hangs']);
  assert.equal(hangingSignal.aborted, true);
  forever.resolve([block('late data')]);
  await tick();
  assert.equal(result.blocks.length, 1);
  await assembler.dispose();
});

test('required providers and explicitly requested disabled or unknown providers fail clearly', async () => {
  const assembler = createContextAssembler({ providers: [
    { id: 'optional', collect() { throw new Error('source missing'); } },
    { id: 'disabled', enabled: false, collect() { throw new Error('must not start'); } },
  ] });
  await assert.rejects(assembler.collect({}, run(), { required: ['optional'] }), error => error.code === 'CONTEXT_PROVIDER_FAILED' && /source missing/.test(error.message));
  await assert.rejects(assembler.collect({}, run(), { required: ['disabled'] }), /已停用/);
  await assert.rejects(assembler.collect({}, run(), { required: ['unknown'] }), /未注册/);
  await assembler.dispose();
});

test('empty required context is an error while optional disabled features do not run', async () => {
  const assembler = createContextAssembler({ providers: [
    { id: 'required', required: true, collect: () => [] },
    { id: 'disabled', enabled: false, collect() { assert.fail('disabled provider ran'); } },
  ] });
  await assert.rejects(assembler.collect({}, run()), /有效上下文/);
  await assembler.dispose();
});

test('each provider receives a separate immutable input and no model credentials', async () => {
  const input = { question: 'original', target: { url: 'https://page.test/' } };
  const contexts = [];
  const assembler = createContextAssembler({ providers: [
    { id: 'mutates', collect(value) { value.target.url = 'https://wrong.test/'; return []; } },
    { id: 'inspects', collect(value, context) {
      assert.notEqual(value, input);
      assert.equal(value.target.url, input.target.url);
      contexts.push(context);
      return [block('safe', { providerId: 'fake', trust: 'user', priority: 999 })];
    } },
  ] });
  const result = await assembler.collect(input, run({ profile: { id: 'model', model: 'fixture', apiKey: 'private-key', endpointUrl: 'https://private-endpoint/' }, budget: { maxTokens: 100, apiKey: 'also-private' } }));
  assert.equal(input.target.url, 'https://page.test/');
  assert.equal(contexts[0].profile, undefined);
  assert.doesNotMatch(JSON.stringify(contexts[0]), /private/);
  assert.equal(contexts[0].model.id, 'model');
  assert.equal(result.blocks[0].providerId, 'inspects');
  assert.equal(result.blocks[0].trust, 'external-data');
  assert.equal(result.blocks[0].priority, 0);
  assert.equal(result.issues[0].providerId, 'mutates');
  await assembler.dispose();
});

test('host budgets prioritize required data, deduplicate sources and mark truncation', async () => {
  const assembler = createContextAssembler({ maxChars: 10, maxBlocks: 3, providers: [
    { id: 'optional', priority: 999, collect: () => [block('optional body')] },
    { id: 'required', required: true, collect: () => [block('required')] },
    { id: 'duplicate', required: true, collect: () => [block('required')] },
  ] });
  const result = await assembler.collect({}, run());
  assert.deepEqual(result.blocks.map(item => item.content), ['required', 'op']);
  assert.equal(result.blocks[1].truncated, true);
  assert.equal(result.blocks.reduce((total, item) => total + item.content.length, 0), 10);
  assert.ok(result.issues.some(item => item.code === 'CONTEXT_TRUNCATED'));
  assert.throws(() => { result.blocks[0].content = 'changed'; }, TypeError);
  await assembler.dispose();
});

test('per-provider block and character limits bound excessive output', async () => {
  const assembler = createContextAssembler({ providers: [
    { id: 'many', maxBlocks: 1, maxChars: 4, collect: () => Array.from({ length: 10000 }, (_, index) => block('long content', { id: String(index) })) },
  ] });
  const result = await assembler.collect({}, run());
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].content, 'long');
  assert.equal(result.blocks[0].truncated, true);
  await assembler.dispose();
});

test('a caller cancellation is propagated rather than downgraded to an optional failure', async () => {
  const waiting = deferred();
  const started = deferred();
  const controller = new AbortController();
  let providerSignal;
  const assembler = createContextAssembler({ providers: [
    { id: 'waiting', collect(_input, context) { providerSignal = context.signal; started.resolve(); return waiting.promise; } },
  ] });
  const result = assembler.collect({}, run({ signal: controller.signal }));
  await started.promise;
  controller.abort(new DOMException('user stopped', 'AbortError'));
  await assert.rejects(result, /user stopped/);
  assert.equal(providerSignal.aborted, true);
  waiting.resolve([block('late')]);
  await assembler.dispose();
});

test('disposing the assembler aborts in-flight collection and prevents subsequent calls', async () => {
  const waiting = deferred();
  const started = deferred();
  const assembler = createContextAssembler({ providers: [
    { id: 'waiting', collect() { started.resolve(); return waiting.promise; } },
  ] });
  const result = assembler.collect({}, run());
  await started.promise;
  await assembler.dispose();
  await assert.rejects(result, /已关闭/);
  await assert.rejects(assembler.collect({}, run()), /已关闭/);
  waiting.resolve([]);
});

test('factory failure and timed out initialization remain isolated from other providers', async () => {
  const waiting = deferred();
  let cleanupCount = 0;
  const assembler = createContextAssembler({ initializationTimeoutMs: 15, providers: [
    { id: 'throws', create({ onCleanup }) { onCleanup(() => cleanupCount++); throw new Error('init failed'); } },
    { id: 'hangs', create: () => waiting.promise },
    { id: 'good', collect: () => [block('works')] },
  ] });
  const result = await assembler.collect({}, run());
  assert.equal(cleanupCount, 1);
  assert.equal(result.blocks[0].content, 'works');
  assert.equal(result.issues.length, 2);
  await assembler.dispose();
  waiting.resolve({ collect: () => [block('late')] });
});

test('an expired run or already cancelled run never starts a provider', async () => {
  let calls = 0;
  const assembler = createContextAssembler({ providers: [{ id: 'check', collect() { calls++; return []; } }] });
  await assert.rejects(assembler.collect({}, run({ deadlineAt: Date.now() - 1 })), /超时/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(assembler.collect({}, run({ signal: controller.signal })), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assembler.dispose();
});

test('the overall run deadline is fatal even when the active provider is optional', async () => {
  const waiting = deferred();
  const assembler = createContextAssembler({ providers: [{ id: 'optional', timeoutMs: 1000, collect: () => waiting.promise }] });
  await assert.rejects(assembler.collect({}, run({ deadlineAt: Date.now() + 20 })), /上下文收集超时/);
  waiting.resolve([]);
  await assembler.dispose();
});

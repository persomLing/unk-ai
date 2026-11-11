import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitWithAbort, awaitWithTimeout } from '../src/utils/abortable.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('preparation timeout rejects a never-settling operation with a useful timeout reason', { timeout: 1000 }, async () => {
  const operation = deferred();
  const controller = new AbortController();
  await assert.rejects(
    awaitWithTimeout(operation.promise, { signal: controller.signal, timeoutMs: 10, message: '读取网页超时，请重试。' }),
    (error) => error.name === 'TimeoutError' && error.message === '读取网页超时，请重试。',
  );
  assert.equal(controller.signal.aborted, false, 'a local stage timeout must not mutate the caller signal');
  operation.reject(new Error('Late I/O failure'));
  await tick(); // An unobserved late rejection would fail the Node test runner.
});

test('user cancellation wins over a preparation deadline and preserves its reason', async () => {
  const operation = deferred();
  const controller = new AbortController();
  const reason = new DOMException('用户停止了请求', 'AbortError');
  const waiting = awaitWithTimeout(operation.promise, { signal: controller.signal, timeoutMs: 1000 });
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  operation.resolve('late completion');
  await tick();
});

test('already cancelled preparation observes a late rejection without running on', async () => {
  const operation = deferred();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(awaitWithTimeout(operation.promise, { signal: controller.signal }), { name: 'AbortError' });
  operation.reject(new Error('Cancelled operation eventually failed'));
  await tick();
});

test('successful and failed I/O settle normally before the deadline', async () => {
  assert.equal(await awaitWithTimeout(Promise.resolve('saved'), { timeoutMs: 1000 }), 'saved');
  const failure = new Error('Storage denied');
  await assert.rejects(awaitWithTimeout(Promise.reject(failure), { timeoutMs: 1000 }), (error) => error === failure);
  assert.equal(await awaitWithAbort(Promise.resolve('no signal')), 'no signal');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../src/app/capability-host.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('synchronous capabilities are immediately usable and disabled factories never run', async () => {
  const host = createCapabilityHost();
  const implementation = { run: () => 'ready' };
  host.add({ id: 'enabled', create: () => implementation });
  host.add({ id: 'disabled', enabled: false, create: () => { throw new Error('must not start'); } });
  assert.equal(host.get('enabled'), implementation);
  assert.equal(host.get('enabled').run(), 'ready');
  assert.equal(host.status('disabled').status, 'disabled');
  assert.throws(() => host.get('disabled'), error => error.code === 'CAPABILITY_UNAVAILABLE' && /已停用/.test(error.message));
  assert.deepEqual((await host.ready()).map(item => item.status), ['ready', 'disabled']);
  await host.dispose();
});

test('partial initialization failure cleans listeners without rejecting other capability readiness', async () => {
  const target = new EventTarget();
  let events = 0;
  const host = createCapabilityHost();
  host.add({ id: 'broken', create({ onCleanup }) {
    const listener = () => events++;
    onCleanup(() => target.removeEventListener('test', listener));
    target.addEventListener('test', listener);
    throw new Error('factory failed after binding');
  } });
  host.add({ id: 'good', create: () => ({ run: () => true }) });
  target.dispatchEvent(new Event('test'));
  assert.equal(events, 0);
  assert.equal(host.get('good').run(), true);
  await host.ready();
  await assert.rejects(host.require('broken'), /factory failed after binding/);
  await host.dispose();
});

test('a hung factory times out, aborts its lifetime and discards late completion', async () => {
  const waiting = deferred();
  let lifetime;
  let earlyCleanup = 0;
  let lateCleanup = 0;
  const host = createCapabilityHost({ initializationTimeoutMs: 15 });
  host.add({ id: 'hung', create(context) { lifetime = context; context.onCleanup(() => earlyCleanup++); return waiting.promise; } });
  await host.ready();
  assert.equal(host.status('hung').status, 'failed');
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(earlyCleanup, 1);
  waiting.resolve({ run() {}, dispose() { lateCleanup++; } });
  await tick();
  assert.equal(lateCleanup, 1);
  assert.throws(() => host.get('hung'), /初始化超时/);
  await host.dispose();
  assert.equal(earlyCleanup, 1);
});

test('caller cancellation stops waiting without destroying an independently initializing capability', async () => {
  const waiting = deferred();
  const host = createCapabilityHost();
  host.add({ id: 'later', create: () => waiting.promise });
  const controller = new AbortController();
  const result = host.require('later', { signal: controller.signal });
  controller.abort(new DOMException('caller stopped', 'AbortError'));
  await assert.rejects(result, /caller stopped/);
  const implementation = { run() {} };
  waiting.resolve(implementation);
  await host.ready();
  assert.equal(host.get('later'), implementation);
  await host.dispose();
});

test('application abort settles pending initialization and invokes cleanup only once', async () => {
  const application = new AbortController();
  const pending = deferred();
  let cleanups = 0;
  const host = createCapabilityHost({ signal: application.signal });
  host.add({ id: 'active', create({ onCleanup }) { onCleanup(() => cleanups++); return pending.promise; } });
  application.abort();
  await host.ready();
  assert.equal(host.status('active').status, 'disposed');
  await host.dispose();
  assert.equal(cleanups, 1);
  await assert.rejects(host.require('active'), /已关闭/);
  pending.resolve({ run() {} });
});

test('throwing and hung cleanup cannot skip other callbacks or block disposal forever', async () => {
  const pending = deferred();
  const order = [];
  const host = createCapabilityHost({ cleanupTimeoutMs: 10 });
  host.add({ id: 'active', create({ onCleanup }) {
    onCleanup(() => order.push('first'));
    onCleanup(() => { order.push('throws'); throw new Error('cleanup failure'); });
    onCleanup(() => { order.push('hangs'); return pending.promise; });
    return { run() {} };
  } });
  await host.dispose();
  assert.deepEqual(order, ['hangs', 'throws', 'first']);
  pending.resolve();
});

test('invalid returned contracts are isolated and clean up their instance', async () => {
  let cleaned = false;
  const host = createCapabilityHost();
  host.add({ id: 'invalid', create: () => ({ dispose() { cleaned = true; } }), validate(value) {
    if (typeof value.run !== 'function') throw new TypeError('run required');
  } });
  assert.equal(cleaned, true);
  assert.throws(() => host.get('invalid'), /run required/);
  assert.throws(() => host.add({ id: 'invalid', create: () => ({}) }), /already registered/);
  await host.dispose();
});

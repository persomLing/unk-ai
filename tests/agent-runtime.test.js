import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/utils/agent-runtime.js';

function fixture() {
  const data = {};
  const storage = { async get(key) { return structuredClone({ [key]: data[key] }); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  return { storage, data, runtime: createAgentRuntime(storage) };
}
const message = { taskId: 'task', tabId: 1, actionId: 'action', type: 'AGENT_ACT', action: 'click_element', args: { elementId: 'e1' } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('duplicates execute once and different actions share a serial tab queue', async () => {
  const { runtime, data } = fixture();
  await runtime.activate(message);
  const entered = deferred();
  const unblock = deferred();
  const seen = [];
  const execute = async () => { seen.push('first'); entered.resolve(); await unblock.promise; return { ok: true }; };
  const first = runtime.run(message, execute, { action: true });
  await entered.promise;
  const duplicate = runtime.run(message, execute, { action: true });
  const next = runtime.run({ ...message, actionId: 'next', args: { text: 'private draft' } }, async () => { seen.push('second'); return { ok: true }; }, { action: true });
  assert.deepEqual(seen, ['first']);
  unblock.resolve();
  assert.deepEqual(await Promise.all([first, duplicate, next]), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(seen, ['first', 'second']);
  assert.doesNotMatch(JSON.stringify(data), /private draft/);
  await assert.rejects(runtime.run({ ...message, args: { elementId: 'e9' } }, execute, { action: true }), /不同参数/);
});

test('cancellation invalidates in-flight and queued leases and persists across restart', async () => {
  const { runtime, storage } = fixture();
  await runtime.activate(message);
  const entered = deferred();
  const unblock = deferred();
  let mutations = 0;
  const first = runtime.run(message, async (lease) => { entered.resolve(); await unblock.promise; runtime.check(lease); mutations += 1; return { ok: true }; }, { action: true });
  await entered.promise;
  const next = runtime.run({ ...message, actionId: 'next' }, async () => { mutations += 1; }, { action: true });
  // Attach immediately because a cancellation may reject before the queue is entered.
  const settled = Promise.allSettled([first, next]);
  await runtime.interrupt(message, true);
  unblock.resolve();
  await settled;
  assert.equal(mutations, 0);
  await assert.rejects(runtime.activate(message, { resume: true }), /已经结束/);
  await assert.rejects(createAgentRuntime(storage).activate(message, { resume: true }), /已经结束/);
});

test('worker restart requires explicit resume and never replays an uncertain intent', async () => {
  const { runtime, storage, data } = fixture();
  await runtime.activate(message);
  await runtime.run(message, async () => ({ ok: true }), { action: true });
  data.agentExecutionTasks[0].actions[0][1].result = null;
  const restarted = createAgentRuntime(storage);
  await assert.rejects(restarted.run(message, () => {}), /暂停/);
  await assert.rejects(restarted.activate(message), /明确继续/);
  await restarted.activate(message, { resume: true });
  let mutations = 0;
  const result = await restarted.run(message, () => { mutations += 1; }, { action: true });
  assert.equal(result.error, 'ERR_ACTION_INTERRUPTED');
  assert.equal(mutations, 0);
});

test('paused tasks allow final evidence but cannot mutate; one task owns a tab', async () => {
  const { runtime } = fixture();
  await runtime.activate(message);
  await assert.rejects(runtime.activate({ taskId: 'other', tabId: 1 }), /已有/);
  await runtime.interrupt(message);
  await assert.rejects(runtime.run(message, () => {}), /暂停/);
  assert.deepEqual(await runtime.run(message, () => ({ text: 'evidence' }), { readOnly: true }), { text: 'evidence' });
});

test('an epoch-bound delayed interruption cannot invalidate a resumed lease', async () => {
  const { runtime } = fixture();
  const original = await runtime.activate(message);
  await runtime.interrupt(message);
  const resumed = await runtime.activate(message, { resume: true });
  let invalidations = 0;
  const result = await runtime.interrupt(message, false, { expectedEpoch: original.epoch,
    onInterrupt() { invalidations += 1; } });
  assert.equal(result, false);
  assert.equal(invalidations, 0);
  assert.doesNotThrow(() => runtime.check(resumed));
  assert.equal(resumed.signal.aborted, false);
});

test('an old activation persistence failure leaves a newer resumed lease intact', async () => {
  const { runtime, storage } = fixture();
  const entered = deferred();
  let rejectWrite;
  const blocked = new Promise((_, reject) => { rejectWrite = reject; });
  const originalSet = storage.set;
  let writes = 0;
  storage.set = async value => {
    if (++writes === 1) { entered.resolve(); await blocked; }
    return originalSet(value);
  };
  const first = runtime.activate(message);
  const firstRejected = assert.rejects(first, /failed old write/);
  await entered.promise;
  const interrupted = runtime.interrupt(message);
  await new Promise(resolve => setImmediate(resolve));
  const resumed = runtime.activate(message, { resume: true });
  const resumedResult = Promise.allSettled([resumed]);
  await new Promise(resolve => setImmediate(resolve));
  rejectWrite(new Error('failed old write'));
  await firstRejected;
  await interrupted;
  const [result] = await resumedResult;
  assert.equal(result.status, 'fulfilled');
  assert.doesNotThrow(() => runtime.check(result.value));
  assert.equal(result.value.signal.aborted, false);
});

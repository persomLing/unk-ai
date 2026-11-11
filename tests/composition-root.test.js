import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidepanelComposition } from '../src/sidepanel/composition/composition-root.js';
import { SLOT_CONTRACTS } from '../src/sidepanel/composition/slots.js';

function agentImplementation() {
  let mode = false;
  return {
    isMode: () => mode, isBusy: () => false, getTask: () => null,
    toggleMode: () => { mode = !mode; }, setMode: value => { mode = value; },
    start: async () => true, stop: async () => {}, resume: async () => {},
    restore: async () => {}, closePanel() {},
  };
}

const factories = {
  reading: () => ({ read: async () => ({ text: 'page content' }) }),
  visual: () => ({ decide: async () => ({ screenshot: false }), resolve: async () => [] }),
  agent: agentImplementation,
};
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('production composition seals the real feature contracts before publishing instances', t => {
  const original = { chrome: globalThis.chrome, document: globalThis.document };
  let composition;
  t.after(async () => { await composition?.dispose(); Object.assign(globalThis, original); });
  globalThis.document = { querySelector: () => null };
  globalThis.chrome = {
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
  };
  const sendMessage = async () => ({});
  const queryActiveTab = async () => null;
  const getProfile = () => null;
  composition = createSidepanelComposition({
    reading: { sendMessage, queryActiveTab },
    visual: { sendMessage, getProfile },
    agent: { sendMessage, queryActiveTab, getProfile },
  });

  assert.equal(composition.registry.isSealed(), true);
  assert.deepEqual(composition.registry.names(), ['reading', 'visual', 'agent']);
  for (const [name, methods] of Object.entries(SLOT_CONTRACTS)) {
    assert.equal(composition[name], composition.registry.get(name));
    for (const method of methods) assert.equal(typeof composition[name][method], 'function');
  }
  const replacement = { read() {} };
  assert.throws(() => composition.registry.register('reading', replacement), /sealed/);
  assert.throws(() => composition.registry.replace('reading', replacement), /sealed/);
  assert.equal(composition.reading, composition.registry.get('reading'));
  assert.throws(() => { composition.reading = replacement; }, TypeError);
});

test('all optional capabilities can be disabled without blocking basic composer state', async () => {
  const composition = createSidepanelComposition({}, { factories, enabled: { reading: false, visual: false, agent: false } });
  assert.equal(composition.agent.isMode(), false);
  assert.equal(composition.agent.isBusy(), false);
  assert.equal(composition.agent.getTask(), null);
  await composition.agent.restore();
  await composition.agent.stop();
  composition.agent.setMode(false);
  await assert.rejects(composition.reading.read({}), /网页读取.*已停用/);
  await assert.rejects(composition.agent.start('explicit task'), /页面操作.*已停用/);
  assert.throws(() => composition.agent.setMode(true), /页面操作.*已停用/);
  assert.deepEqual((await composition.ready).map(item => item.status), ['disabled', 'disabled', 'disabled']);
  await composition.dispose();
});

test('optional factory failures keep working reading available and clean partially bound listeners', async () => {
  const target = new EventTarget();
  let events = 0;
  const composition = createSidepanelComposition({}, { factories: {
    ...factories,
    visual: () => { throw new Error('visual initialization failed'); },
    agent: ({ onCleanup }) => {
      const listener = () => events++;
      onCleanup(() => target.removeEventListener('test', listener));
      target.addEventListener('test', listener);
      throw new Error('agent initialization failed');
    },
  } });
  target.dispatchEvent(new Event('test'));
  assert.equal(events, 0);
  assert.equal(composition.agent.isBusy(), false);
  assert.equal((await composition.reading.read()).text, 'page content');
  await assert.rejects(composition.agent.start('explicit task'), /agent initialization failed/);
  await assert.rejects(composition.visual.resolve('question', {}), /visual initialization failed/);
  await composition.ready;
  await composition.dispose();
});

test('reading factory failure is reported on explicit reading without crashing composition', async () => {
  const composition = createSidepanelComposition({}, { factories: { ...factories, reading: () => { throw new Error('reader missing'); } } });
  assert.equal(composition.agent.isBusy(), false);
  assert.equal(composition.status('reading').status, 'failed');
  await assert.rejects(composition.reading.read({}), /网页读取.*reader missing/);
  await composition.dispose();
});

test('synchronous agent factories preserve immediate mode changes', async () => {
  const composition = createSidepanelComposition({}, { factories });
  assert.equal(composition.status('agent').status, 'ready');
  composition.agent.setMode(true);
  assert.equal(composition.agent.isMode(), true);
  composition.agent.toggleMode();
  assert.equal(composition.agent.isMode(), false);
  await composition.dispose();
});

test('async factories have bounded readiness and stable published references', async () => {
  const pending = deferred();
  const composition = createSidepanelComposition({}, { factories: { ...factories, reading: () => pending.promise } });
  const reading = composition.reading;
  const request = reading.read({});
  assert.equal(composition.status('reading').status, 'initializing');
  pending.resolve({ read: async () => ({ text: 'ready later' }) });
  assert.equal((await request).text, 'ready later');
  assert.equal(composition.registry.get('reading'), reading);
  assert.equal(composition.reading, reading);
  await composition.dispose();

  const hung = deferred();
  const timed = createSidepanelComposition({}, { factories: { ...factories, reading: () => hung.promise }, initializationTimeoutMs: 15 });
  await assert.rejects(timed.reading.read({}), /初始化超时/);
  assert.equal(timed.agent.isBusy(), false);
  await timed.dispose();
  hung.resolve({ read: async () => ({ text: 'late' }) });
});

test('composition disposal aborts in-flight capability calls and ignores late results', async () => {
  const waiting = deferred();
  const started = deferred();
  let readSignal;
  const composition = createSidepanelComposition({}, { factories: { ...factories, reading: () => ({ read(options) {
    readSignal = options.signal;
    started.resolve();
    return waiting.promise;
  } }) } });
  const result = composition.reading.read({});
  await started.promise;
  await composition.dispose();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(readSignal.aborted, true);
  waiting.resolve({ text: 'late page' });
  await assert.rejects(composition.reading.read({}), /已关闭/);
});

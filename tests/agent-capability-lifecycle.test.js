import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSlot } from '../src/sidepanel/features/agent/agent-slot.js';
import { createCapabilityHost } from '../src/app/capability-host.js';

function environment(t, { failUpdated = false } = {}) {
  const previous = { document: globalThis.document, chrome: globalThis.chrome };
  const elements = new Map();
  const events = [];
  class Element {
    hidden = false;
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  }
  function event(fail = false) {
    const listeners = new Set();
    const value = {
      listeners,
      addListener(callback) { listeners.add(callback); if (fail) throw new Error('Listener registration failed after attaching'); },
      removeListener: callback => listeners.delete(callback),
    };
    events.push(value);
    return value;
  }
  globalThis.document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  } };
  globalThis.chrome = { tabs: { onActivated: event(), onUpdated: event(failUpdated) }, runtime: { onMessage: event() } };
  t.after(() => Object.assign(globalThis, previous));
  return { elements, events };
}

test('a real Agent factory failure removes already attached DOM and Chrome listeners without failing another capability', async t => {
  const { elements, events } = environment(t, { failUpdated: true });
  const host = createCapabilityHost();
  host.add({ id: 'agent', create: lifetime => createAgentSlot({ ...lifetime }) });
  host.add({ id: 'other', create: () => ({ read: () => 'available' }) });
  await host.ready();
  assert.equal(host.status('agent').status, 'failed');
  assert.equal(host.get('other').read(), 'available');
  assert.ok([...elements.values()].every(element => element.listeners.size === 0));
  assert.ok(events.every(event => event.listeners.size === 0));
  await host.dispose();
});

test('host disposal releases a real Agent factory exactly once and its retained instance cannot restart', async t => {
  const { elements, events } = environment(t);
  const host = createCapabilityHost();
  host.add({ id: 'agent', create: lifetime => createAgentSlot({ ...lifetime }) });
  const agent = await host.require('agent');
  assert.ok(events.every(event => event.listeners.size === 1));
  assert.equal([...elements.values()].reduce((sum, element) => sum + element.listeners.size, 0), 4);
  await host.dispose();
  await host.dispose();
  assert.ok([...elements.values()].every(element => element.listeners.size === 0));
  assert.ok(events.every(event => event.listeners.size === 0));
  await assert.rejects(agent.start('Cannot start after host disposal'), { name: 'AbortError' });
});

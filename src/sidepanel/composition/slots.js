/**
 * Canonical feature names. Attachments and context are still helper modules;
 * they do not have a registered runtime contract yet.
 */
export const SLOT_NAMES = Object.freeze({
  reading: 'reading',
  visual: 'visual',
  attachments: 'attachments',
  context: 'context',
  agent: 'agent',
});

/** Required methods of the implementations currently wired by the app. */
export const SLOT_CONTRACTS = Object.freeze({
  [SLOT_NAMES.reading]: Object.freeze(['read']),
  [SLOT_NAMES.visual]: Object.freeze(['decide', 'resolve']),
  [SLOT_NAMES.agent]: Object.freeze([
    'isMode', 'isBusy', 'toggleMode', 'setMode', 'start', 'stop',
    'resume', 'restore', 'closePanel', 'getTask',
  ]),
});

/**
 * Register implementations during composition, then seal before publishing
 * references to consumers. Replacements are explicit and only allowed before
 * sealing: runtime replacement would leave existing consumers on old instances
 * and can leave the old instance's browser listeners running.
 *
 * New slot types must declare a contract through the `contracts` option.
 * This is a trusted in-process module boundary, not a plugin sandbox.
 */
export function createSlotRegistry(initial = {}, { contracts = SLOT_CONTRACTS } = {}) {
  const requiredMethods = new Map(Object.entries(contracts).map(([name, methods]) => {
    if (!name.trim() || name !== name.trim() || !Array.isArray(methods) || !methods.length
      || methods.some(method => typeof method !== 'string' || !method.trim() || method !== method.trim())) {
      throw new TypeError(`Invalid feature slot contract: ${name}`);
    }
    return [name, [...new Set(methods)]];
  }));
  const slots = new Map();
  let sealed = false;

  function assertMutable() {
    if (sealed) throw new Error('Feature slot registry is sealed. Change implementations in the composition root.');
  }

  function validate(name, implementation) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim()) {
      throw new TypeError('A non-empty feature slot name is required.');
    }
    if (!requiredMethods.has(name)) throw new Error(`Unknown feature slot contract: ${name}`);
    if (!implementation || typeof implementation !== 'object' || Array.isArray(implementation)) {
      throw new TypeError(`Feature slot ${name} requires an implementation object.`);
    }
    const missing = requiredMethods.get(name).filter(method => typeof implementation[method] !== 'function');
    if (missing.length) throw new TypeError(`Feature slot ${name} is missing methods: ${missing.join(', ')}`);
  }

  const registry = Object.freeze({
    register(name, implementation) {
      assertMutable();
      if (slots.has(name)) throw new Error(`Feature slot already registered: ${name}. Use replace before sealing.`);
      validate(name, implementation);
      slots.set(name, implementation);
      return implementation;
    },
    replace(name, implementation) {
      assertMutable();
      if (!slots.has(name)) throw new Error(`Unknown feature slot: ${name}`);
      validate(name, implementation);
      slots.set(name, implementation);
      return implementation;
    },
    seal() {
      if (sealed) return registry;
      // Recheck before freezing in case a factory changed its public methods.
      for (const [name, implementation] of slots) validate(name, implementation);
      for (const implementation of slots.values()) Object.freeze(implementation);
      sealed = true;
      return registry;
    },
    isSealed() {
      return sealed;
    },
    has(name) {
      return slots.has(name);
    },
    get(name) {
      if (!slots.has(name)) throw new Error(`Unknown feature slot: ${name}`);
      return slots.get(name);
    },
    names() {
      return [...slots.keys()];
    },
  });

  for (const [name, implementation] of Object.entries(initial)) registry.register(name, implementation);
  return registry;
}

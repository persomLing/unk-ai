/**
 * Composition root.
 *
 * This module selects the concrete side-panel feature implementations. The
 * entry supplies their dependencies; some legacy modules still access chrome
 * directly. Contracts are checked and registration is sealed before consumers
 * receive references, so the registry and those references cannot diverge.
 *
 * Slot ownership:
 * - reading      -> features/page-reading/page-reader-slot.js
 * - visual       -> features/visual-context/auto-visual-slot.js
 * - agent        -> features/agent/agent-slot.js
 * Attachments and context currently remain helper modules outside the registry.
 */
import { createAgentSlot } from '../features/agent/agent-slot.js';
import { createAutoVisualSlot } from '../features/visual-context/auto-visual-slot.js';
import { createPageReaderSlot } from '../features/page-reading/page-reader-slot.js';
import { createSlotRegistry, SLOT_NAMES, SLOT_CONTRACTS } from './slots.js';
import { createCapabilityHost } from '../../app/capability-host.js';
import { awaitWithAbort } from '../../utils/abortable.js';

const DEFAULT_FACTORIES = Object.freeze({
  reading: createPageReaderSlot,
  visual: createAutoVisualSlot,
  agent: createAgentSlot,
});
const LABELS = Object.freeze({ reading: '网页读取', visual: '自动视觉', agent: '页面操作' });

export function createSidepanelComposition(deps, {
  factories = {}, enabled = {}, signal, initializationTimeoutMs = 3000, cleanupTimeoutMs = 1000,
} = {}) {
  const host = createCapabilityHost({ signal, initializationTimeoutMs, cleanupTimeoutMs });
  for (const name of Object.keys(DEFAULT_FACTORIES)) {
    host.add({
      id: name,
      label: LABELS[name],
      enabled: enabled[name] !== false,
      create: lifetime => (factories[name] || DEFAULT_FACTORIES[name])({ ...deps[name], ...lifetime }),
      validate: implementation => {
        const missing = SLOT_CONTRACTS[name].filter(method => typeof implementation[method] !== 'function');
        if (missing.length) throw new TypeError(`${LABELS[name]}缺少方法：${missing.join(', ')}`);
      },
    });
  }
  async function invoke(name, method, args, options) {
    if (!['initializing', 'ready'].includes(host.status(name).status)) host.get(name);
    const controller = new AbortController();
    const callerSignal = options?.signal;
    const lifetimeSignal = host.signal(name);
    const cancelCaller = () => controller.abort(callerSignal.reason);
    const cancelLifetime = () => controller.abort(lifetimeSignal.reason);
    callerSignal?.addEventListener('abort', cancelCaller, { once: true });
    lifetimeSignal.addEventListener('abort', cancelLifetime, { once: true });
    if (callerSignal?.aborted) cancelCaller();
    if (lifetimeSignal.aborted) cancelLifetime();
    try {
      const implementation = await host.require(name, { signal: controller.signal, deadlineAt: options?.deadlineAt });
      controller.signal.throwIfAborted();
      const parameters = [...args];
      const optionsIndex = name === 'reading' || method === 'resume' ? 0 : name === 'visual' ? 2 : 1;
      parameters[optionsIndex] = { ...options, signal: controller.signal };
      const result = await awaitWithAbort(Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return implementation[method](...parameters);
      }), controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      callerSignal?.removeEventListener('abort', cancelCaller);
      lifetimeSignal.removeEventListener('abort', cancelLifetime);
    }
  }
  function optionalState(method, fallback, args = []) {
    if (host.status(SLOT_NAMES.agent).status !== 'ready') return fallback;
    return host.get(SLOT_NAMES.agent)[method](...args);
  }
  const reading = Object.freeze({ read: options => invoke('reading', 'read', [options], options) });
  const visual = Object.freeze({
    decide: (question, page, options) => invoke('visual', 'decide', [question, page, options], options),
    resolve: (question, page, options) => invoke('visual', 'resolve', [question, page, options], options),
  });
  const agent = Object.freeze({
    isMode: () => optionalState('isMode', false),
    isBusy: () => optionalState('isBusy', false),
    getTask: () => optionalState('getTask', null),
    toggleMode: (...args) => host.get('agent').toggleMode(...args),
    setMode: (mode, ...args) => mode ? host.get('agent').setMode(mode, ...args) : optionalState('setMode', false, [mode, ...args]),
    start: (goal, options) => invoke('agent', 'start', [goal, options], options),
    resume: options => invoke('agent', 'resume', [options], options),
    stop: (...args) => optionalState('stop', Promise.resolve(), args),
    closePanel: (...args) => optionalState('closePanel', undefined, args),
    async restore(...args) {
      try { return (await host.require('agent')).restore(...args); }
      catch (error) { if (host.status('agent').status === 'ready') throw error; return null; }
    },
  });
  const registry = createSlotRegistry({
    [SLOT_NAMES.reading]: reading,
    [SLOT_NAMES.visual]: visual,
    [SLOT_NAMES.agent]: agent,
  }).seal();
  return Object.freeze({
    registry,
    reading: registry.get(SLOT_NAMES.reading),
    visual: registry.get(SLOT_NAMES.visual),
    agent: registry.get(SLOT_NAMES.agent),
    status: host.status,
    ready: host.ready(),
    dispose: host.dispose,
  });
}

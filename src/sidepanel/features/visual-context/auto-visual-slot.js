import { compact } from 'lodash-es';
import { assertPageTarget, pageTargetFields } from '../../../utils/page-target.js';
import { awaitWithAbort } from '../../../utils/abortable.js';
import { createModelGateway, createModelTransport } from '../../../app/model-gateway.js';
import { localVisualDecision, needsVisualPreflight, parseVisualDecision } from '../../../utils/visual-intent.js';
import { visualAttachmentsFromResponse, visualDecisionMessages } from './visual-slot.js';

/** Optional visual context uses the submitting run's frozen model when supplied. */
export function createAutoVisualSlot({
  getProfile,
  sendMessage,
  fetchImpl,
  modelGateway = createModelGateway({ transport: createModelTransport({ fetchImpl }) }),
  isBusy = () => false,
  generateName = () => String(Date.now()),
  signal: lifetimeSignal,
  onCleanup,
}) {
  lifetimeSignal?.throwIfAborted();
  const operations = new Set();
  let disposed = false;

  function assertActive() {
    if (disposed) throw new DOMException('视觉能力已释放。', 'AbortError');
    lifetimeSignal?.throwIfAborted();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetimeSignal?.removeEventListener('abort', dispose);
    for (const controller of operations) controller.abort();
    operations.clear();
  }
  onCleanup?.(dispose);
  lifetimeSignal?.addEventListener('abort', dispose, { once: true });

  async function withRun(options, operation) {
    assertActive();
    const controller = new AbortController();
    const parents = [...new Set([lifetimeSignal, options.signal, options.modelRun?.signal].filter(Boolean))];
    const cancel = () => controller.abort(parents.find(parent => parent.aborted)?.reason);
    for (const parent of parents) parent.addEventListener('abort', cancel, { once: true });
    if (parents.some(parent => parent.aborted)) cancel();
    operations.add(controller);
    let ownedRun;
    try {
      controller.signal.throwIfAborted();
      let run = options.modelRun;
      if (!run) {
        const profile = getProfile?.();
        if (profile) run = ownedRun = modelGateway.createRun({
          runId: `visual-${generateName()}`, profile, signal: controller.signal,
        });
      }
      return await operation(run, controller.signal);
    } finally {
      ownedRun?.dispose();
      for (const parent of parents) parent.removeEventListener('abort', cancel);
      operations.delete(controller);
    }
  }

  async function decideWithRun(question, page, run, signal, requestId) {
    signal.throwIfAborted();
    const fallback = localVisualDecision(question, page);
    if (!needsVisualPreflight(question, page)) return { screenshot: false, scope: 'none', reason: '无需视觉判断' };
    if (!run) return fallback;
    try {
      const text = await run.request({
        requestId: requestId || 'visual-decision', purpose: 'visual-decision',
        messages: visualDecisionMessages(question, page), signal, timeoutMs: 8000,
        maxTokens: 80, temperature: 0,
      });
      signal.throwIfAborted();
      return parseVisualDecision(text, fallback);
    } catch {
      signal.throwIfAborted();
      return fallback;
    }
  }

  function decide(question, page, options = {}) {
    return withRun(options, (run, signal) => decideWithRun(question, page, run, signal, options.requestId));
  }

  function resolve(question, page, options = {}) {
    return withRun(options, async (run, signal) => {
      if (isBusy() || !Number.isInteger(page?.tabId) || !page?.url || !run?.modelInfo.supportsVision) return [];
      const target = pageTargetFields(page);
      const decision = await decideWithRun(question, page, run, signal, options.requestId);
      signal.throwIfAborted();
      if (!decision?.screenshot) return [];
      try {
        const scope = decision.scope === 'viewport' ? 'viewport' : 'page';
        const response = await awaitWithAbort(sendMessage({
          type: 'CAPTURE_PAGE_VISUAL_CONTEXT', ...target, scope, maxEdge: 1600, maxHeight: 12000,
        }), signal);
        signal.throwIfAborted();
        if (response?.error) return [];
        assertPageTarget(target, response);
        return compact(visualAttachmentsFromResponse(response, page, scope));
      } catch {
        signal.throwIfAborted();
        return [];
      }
    });
  }

  return Object.freeze({ decide, resolve, dispose });
}

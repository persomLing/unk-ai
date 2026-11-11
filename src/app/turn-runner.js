import { awaitWithAbort } from '../utils/abortable.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PHASES = new Set(['preparing', 'reading', 'reading-index', 'reading-related', 'checking-evidence', 'reading-deep', 'reading-network', 'researching', 'checking-research', 'web-research', 'saving', 'compressing', 'collecting-context', 'waiting-model', 'reasoning', 'answering']);

/** One document's turn coordinator. It owns execution, cancellation and the
 * terminal commit; storage owns durability and the UI only observes events.
 * A command id identifies delivery, not prompt text. IDs are never reused for
 * a deliberate retry. Browser Agent action leases remain background-owned.
 */
export function createTurnRunner({ repository, createId = () => crypto.randomUUID(), now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, historyLimit = 64 } = {}) {
  if (!repository) throw new TypeError('TurnRunner requires a conversation repository.');
  const commands = new Map();
  const listeners = new Set();
  let active = null;
  let disposed = false;

  function notify(event) {
    const snapshot = Object.freeze(event);
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* A view is not an execution owner. */ }
    }
  }

  function begin({ commandId = createId(), mode = 'chat', timeoutMs = 240000 } = {}) {
    if (disposed) throw new DOMException('本次会话运行环境已关闭。', 'AbortError');
    if (commands.has(commandId)) return commands.get(commandId);
    if (active) throw new Error('当前回合尚未结束，请先停止或排队。');
    const runId = createId();
    const controller = new AbortController();
    const startedAt = now();
    let status = 'preparing', phase = 'preparing', ref = null, sequence = 0;
    let execution = null, timer = null;
    const isOpen = () => !TERMINAL.has(status) && active === run && !controller.signal.aborted;
    const emit = type => notify({ type, commandId, runId, mode, status, phase, seq: sequence,
      conversationId: ref?.conversationId || null, turnId: ref?.turnId || null,
      assistantId: ref?.assistantId || null, startedAt, at: now() });

    function settle(nextStatus, fields = {}) {
      if (!isOpen()) return false;
      // Single synchronous commit point. Async folder sync cannot reopen it.
      status = nextStatus;
      phase = 'idle';
      clearTimer(timer);
      const messageStatus = nextStatus === 'completed' ? 'complete' : nextStatus === 'cancelled' ? 'stopped' : 'error';
      try {
        if (ref) {
          const committed = repository.finish(ref, { ...fields, status: messageStatus,
            reasoningStartedAt: undefined, reasoningFinishedAt: undefined });
          if (!committed) {
            status = 'cancelled';
            controller.abort(new DOMException('本轮消息已被替换。', 'AbortError'));
          } else {
            try { repository.schedule(ref); }
            catch { emit('persistence-error'); }
          }
        }
      } catch (error) {
        status = 'failed';
        controller.abort(error);
        emit('commit-error');
      } finally {
        if (active === run) active = null;
        emit('terminal');
      }
      return true;
    }

    const run = Object.freeze({
      commandId, runId, signal: controller.signal,
      get ref() { return ref; },
      get status() { return status; },
      get phaseName() { return phase; },
      get deadlineAt() { return startedAt + timeoutMs; },
      assertCurrent() {
        controller.signal.throwIfAborted();
        if (!isOpen()) throw new DOMException('本次执行已结束或被替换。', 'AbortError');
      },
      bind(args) {
        run.assertCurrent();
        if (ref) {
          if (args.assistant?.id !== ref.assistantId || args.conversation?.id !== ref.conversationId) {
            throw new Error('不能把执行重新绑定到另一回合。');
          }
          return ref;
        }
        ref = repository.begin({ ...args, runId });
        emit('bound');
        return ref;
      },
      phase(value) {
        if (!isOpen() || !PHASES.has(value)) return false;
        phase = value;
        status = ['waiting-model', 'reasoning', 'answering'].includes(value) ? 'running' : 'preparing';
        if (ref) repository.update(ref, { requestPhase: value, phaseStartedAt: now() });
        emit('phase');
        return true;
      },
      accept(event) {
        if (!isOpen() || !ref || !event || event.runId !== runId
          || event.conversationId !== ref.conversationId || event.turnId !== ref.turnId
          || event.assistantId !== ref.assistantId || !Number.isInteger(event.seq) || event.seq <= sequence) return false;
        if (!repository.update(ref, event.patch || {})) return false;
        sequence = event.seq;
        emit('message');
        return true;
      },
      update(patch) { return ref ? run.accept({ ...ref, seq: sequence + 1, patch }) : false; },
      complete(fields = {}) {
        if (ref && !String(fields.content || '').trim()) return run.fail(new Error('模型返回了空回答，请重试。'));
        return settle('completed', fields);
      },
      fail(error) {
        if (error?.name === 'AbortError') return run.cancel(error);
        const changed = settle('failed', { errorMessage: error?.message || '执行失败，请重试。' });
        if (changed) controller.abort(error);
        return changed;
      },
      cancel(reason = new DOMException('请求已取消。', 'AbortError')) {
        const changed = reason?.name === 'TimeoutError'
          ? settle('failed', { errorMessage: reason.message }) : settle('cancelled');
        if (changed) controller.abort(reason);
        return changed;
      },
      execute(operation) {
        if (execution) return execution;
        if (!isOpen()) return Promise.resolve(null);
        execution = (async () => {
          try {
            const result = await awaitWithAbort(Promise.resolve().then(() => {
              run.assertCurrent();
              return operation(run);
            }), controller.signal);
            if (isOpen()) run.complete(result || {});
            return result;
          } catch (error) {
            if (isOpen()) run.fail(error);
            return null;
          } finally {
            if (isOpen()) run.fail(new Error('生成已中断，请重试。'));
          }
        })();
        return execution;
      },
    });
    active = run;
    commands.set(commandId, run);
    while (commands.size > historyLimit) {
      const [key, oldest] = commands.entries().next().value;
      if (oldest === active) break;
      commands.delete(key);
    }
    timer = setTimer(() => run.cancel(new DOMException('本轮执行超时，已保留生成内容，请重试。', 'TimeoutError')), timeoutMs);
    emit('started');
    return run;
  }

  return Object.freeze({ begin, active: () => active,
    cancel: reason => active?.cancel(reason) || false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; active?.cancel(); commands.clear(); listeners.clear(); },
  });
}

const STORAGE_KEY = 'agentExecutionTasks';

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Background-owned task leases. A restart always requires an explicit resume. */
export function createAgentRuntime(storage) {
  const tasks = new Map();
  const queues = new Map();
  let loaded;
  let writes = Promise.resolve();

  function ready() {
    if (!loaded) loaded = (async () => {
      const saved = await storage.get(STORAGE_KEY);
      for (const entry of saved?.[STORAGE_KEY] || []) {
        if (!entry?.id || !Number.isInteger(entry.tabId)) continue;
        tasks.set(entry.id, {
          ...entry,
          status: entry.status === 'cancelled' ? 'cancelled' : 'paused',
          epoch: (Number(entry.epoch) || 0) + 1,
          actions: new Map((entry.actions || []).map(([id, action]) => [id, {
            ...action,
            result: action.result || { error: 'ERR_ACTION_INTERRUPTED', message: '上次动作结果未确认，请核对页面；不会重放该动作。' },
          }])),
        });
      }
    })();
    return loaded;
  }

  function persist() {
    const value = [...tasks.values()].map((task) => ({
      id: task.id, tabId: task.tabId, status: task.status, epoch: task.epoch,
      actions: [...task.actions].map(([id, action]) => [id, {
        fingerprint: action.fingerprint,
        result: action.result || null,
      }]),
    }));
    const pending = writes.then(() => storage.set({ [STORAGE_KEY]: value }));
    writes = pending.catch(() => {});
    return pending;
  }

  async function activate(message, { resume = false } = {}) {
    await ready();
    const { taskId, tabId } = message;
    if (typeof taskId !== 'string' || !taskId || !Number.isInteger(tabId)) {
      throw runtimeError('ERR_TASK_INVALID', '任务 ID 或标签页无效。');
    }
    let task = tasks.get(taskId);
    if (task?.status === 'cancelled') throw runtimeError('ERR_TASK_CANCELLED', '任务已经结束，不能重新执行。');
    if (task && task.tabId !== tabId) throw runtimeError('ERR_TASK_INVALID', '任务绑定的标签页不匹配。');
    if (task?.status === 'paused' && !resume) throw runtimeError('ERR_TASK_PAUSED', '任务已暂停，需要用户明确继续。');
    for (const other of tasks.values()) {
      if (other.id !== taskId && other.tabId === tabId && other.status === 'running') {
        throw runtimeError('ERR_TAB_BUSY', '这个标签页已有浏览器任务正在执行。');
      }
    }
    if (!task) {
      task = { id: taskId, tabId, status: 'paused', epoch: 0, actions: new Map() };
      tasks.set(taskId, task);
    }
    if (task.status !== 'running') {
      task.epoch += 1;
      task.controller = new AbortController();
    }
    task.status = 'running';
    const lease = { task, epoch: task.epoch, signal: task.controller.signal };
    try { await persist(); } catch (error) {
      if (task.epoch === lease.epoch) {
        task.status = 'paused';
        task.epoch += 1;
        task.controller.abort();
      }
      throw error;
    }
    check(lease);
    return lease;
  }

  function check(lease) {
    if (!lease || (lease.task.status !== 'running' && !(lease.readOnly && lease.task.status === 'paused')) || lease.task.epoch !== lease.epoch) {
      throw runtimeError('ERR_TASK_PAUSED', '任务已暂停或结束，请由用户核对后继续。');
    }
  }

  async function leaseFor(message, readOnly = false) {
    await ready();
    const task = tasks.get(message.taskId);
    if (!task || task.tabId !== message.tabId) throw runtimeError('ERR_TASK_PAUSED', '后台任务状态已丢失，请核对页面后继续。');
    const lease = { task, epoch: task.epoch, readOnly, signal: task.controller?.signal };
    check(lease);
    return lease;
  }

  async function interrupt({ taskId, tabId }, cancelled = false, { expectedEpoch, onInterrupt } = {}) {
    await ready();
    let task = tasks.get(taskId);
    if (expectedEpoch !== undefined && (!task || task.epoch !== expectedEpoch)) return false;
    if (!task && taskId && Number.isInteger(tabId)) {
      task = { id: taskId, tabId, epoch: 0, actions: new Map(), status: 'paused' };
      tasks.set(taskId, task);
    }
    if (!task || task.tabId !== tabId) return false;
    const interruptedEpoch = task.epoch;
    task.epoch += 1;
    if (task.status !== 'cancelled') task.status = cancelled ? 'cancelled' : 'paused';
    if (task.status === 'cancelled') task.actions.clear();
    onInterrupt?.({ taskId, tabId, epoch: interruptedEpoch });
    task.controller?.abort();
    await persist();
    return true;
  }

  async function run(message, execute, { action = false, readOnly = false } = {}) {
    const lease = await leaseFor(message, readOnly);
    let entry;
    if (action) {
      if (typeof message.actionId !== 'string' || !message.actionId || message.actionId.length > 200) {
        throw runtimeError('ERR_ACTION_INVALID', '页面动作缺少有效的 actionId。');
      }
      const encoded = new TextEncoder().encode(JSON.stringify([message.type, message.action, message.args, message.snapshotId, message.approval]));
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      check(lease);
      entry = lease.task.actions.get(message.actionId);
      if (entry) {
        if (entry.fingerprint !== fingerprint) throw runtimeError('ERR_ACTION_ID_REUSED', '相同动作 ID 不可用于不同参数。');
        return entry.promise || entry.result;
      }
      if (lease.task.actions.size >= 200) throw runtimeError('ERR_TASK_LIMIT', '任务动作记录已达到上限，请开始新任务。');
      entry = { fingerprint, result: null };
      lease.task.actions.set(message.actionId, entry);
    }
    const previous = queues.get(message.tabId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      try {
        check(lease);
        if (action) await persist(); // Record intent before any page mutation.
        check(lease);
        const result = await execute(lease);
        if (entry) entry.result = result;
        return result;
      } catch (error) {
        const result = { error: error.code || 'ERR_AGENT_FAILED', message: error.message || '页面操作失败。', ...(error.origin ? { origin: error.origin } : {}) };
        if (entry) entry.result = result;
        return result;
      } finally {
        if (entry) await persist();
      }
    });
    if (entry) entry.promise = pending;
    queues.set(message.tabId, pending);
    void pending.finally(() => {
      if (queues.get(message.tabId) === pending) queues.delete(message.tabId);
      if (entry) entry.promise = null;
    }).catch(() => {});
    return pending;
  }

  const activeTasks = () => [...tasks.values()].filter(task => task.status === 'running')
    .map(task => ({ taskId: task.id, tabId: task.tabId, epoch: task.epoch }));

  return { activate, check, interrupt, run, activeTasks };
}

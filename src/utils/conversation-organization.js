import { awaitWithAbort } from './abortable.js';

export const CONVERSATION_ORGANIZATION_KEY = 'conversationOrganization';
export const CONVERSATION_ORGANIZATION_VERSION = 1;
const ORGANIZATION_LOCK = 'unk-ai-conversation-organization';
const DEFAULT_TIMEOUT_MS = 5000;
const UNSAFE_IDS = new Set(['__proto__', 'prototype', 'constructor']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, label = '会话') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) || UNSAFE_IDS.has(value)) {
    throw new Error(`${label} ID 无效。`);
  }
  return value;
}

function groupIdentifier(value) {
  const id = identifier(value, '分组');
  if (id === 'none') throw new Error('“未分组”不是可编辑的分组。');
  return id;
}

function name(value, maximum, label) {
  if (typeof value !== 'string') throw new Error(`${label}不能为空。`);
  const result = value.trim();
  if (!result) throw new Error(`${label}不能为空。`);
  if ([...result].length > maximum) throw new Error(`${label}最多 ${maximum} 个字。`);
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label}不能包含换行或控制字符。`);
  return result;
}

function comparableName(value) {
  return value.normalize('NFKC').toLowerCase();
}

function groupName(value) {
  const result = name(value, 24, '分组名称');
  if (comparableName(result) === '未分组') throw new Error('“未分组”是保留名称。');
  return result;
}

function conversationIds(values) {
  if (!Array.isArray(values)) throw new Error('请选择要整理的对话。');
  return [...new Set(values.map(value => identifier(value)))];
}

function emptySnapshot() {
  return {
    version: CONVERSATION_ORGANIZATION_VERSION,
    revision: 0,
    groups: [],
    assignments: {},
    titles: {},
    preferences: { view: 'groups', collapsed: [] },
  };
}

/** Missing pre-feature metadata is valid; damaged or newer records are not reset. */
export function normalizeConversationOrganization(value) {
  if (value === undefined) return emptySnapshot();
  if (!object(value)) throw new Error('历史分组数据损坏，未修改原记录。');
  if (value.version !== CONVERSATION_ORGANIZATION_VERSION) {
    throw new Error('历史分组数据版本不受支持，请更新扩展后重试。');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.groups)) {
    throw new Error('历史分组数据损坏，未修改原记录。');
  }
  const ids = new Set(), names = new Set();
  const groups = value.groups.map(group => {
    if (!object(group) || typeof group.createdAt !== 'string' || !group.createdAt) {
      throw new Error('历史分组数据损坏，未修改原记录。');
    }
    const id = groupIdentifier(group.id), displayName = groupName(group.name);
    const comparable = comparableName(displayName);
    if (ids.has(id) || names.has(comparable)) throw new Error('历史分组数据包含重复分组，未修改原记录。');
    ids.add(id); names.add(comparable);
    return { ...group, id, name: displayName };
  });
  const assignments = value.assignments === undefined ? {} : value.assignments;
  const titles = value.titles === undefined ? {} : value.titles;
  if (!object(assignments) || !object(titles)) throw new Error('历史分组映射损坏，未修改原记录。');
  for (const [id, groupId] of Object.entries(assignments)) {
    identifier(id);
    if (!ids.has(groupIdentifier(groupId))) throw new Error('历史分组映射指向不存在的分组，未修改原记录。');
  }
  for (const [id, title] of Object.entries(titles)) {
    identifier(id); name(title, 120, '对话名称');
  }
  const preferences = value.preferences === undefined ? {} : value.preferences;
  if (!object(preferences) || (preferences.view !== undefined && !['groups', 'all'].includes(preferences.view))) {
    throw new Error('历史列表偏好损坏，未修改原记录。');
  }
  const collapsed = preferences.collapsed ?? [];
  if (!Array.isArray(collapsed)) throw new Error('历史列表偏好损坏，未修改原记录。');
  collapsed.forEach(id => identifier(id, '分组'));
  return structuredClone({
    ...value,
    groups,
    assignments,
    titles,
    preferences: { ...preferences, view: preferences.view ?? 'groups', collapsed: [...new Set(collapsed)].filter(id => id === 'none' || ids.has(id)) },
  });
}

function disposedError() {
  return new DOMException('历史分组服务已关闭。', 'AbortError');
}

/**
 * Logical organization is separate from conversation file snapshots. Renaming
 * or moving history never rewrites messages, changes their times, or moves files.
 * Web Locks protect cross-document read/change/write; without them this instance
 * still serializes writes. A caller timeout stops waiting, not an in-flight set.
 */
export function createConversationOrganizationStore({
  storage = globalThis.chrome?.storage?.local,
  storageChanges = globalThis.chrome?.storage?.onChanged,
  locks = globalThis.navigator?.locks,
  now = () => new Date().toISOString(),
  randomId = () => globalThis.crypto.randomUUID(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const lifetime = new AbortController();
  const listeners = new Set();
  const waitMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : DEFAULT_TIMEOUT_MS;
  let queue = Promise.resolve();
  let publishedRevision = -1;

  function guard(signal) {
    if (lifetime.signal.aborted) throw disposedError();
    if (signal?.aborted) throw signal.reason;
  }

  function publish(snapshot) {
    if (lifetime.signal.aborted || snapshot.revision <= publishedRevision) return;
    publishedRevision = snapshot.revision;
    for (const listener of listeners) {
      // A subscriber cannot turn a committed storage write into an apparent failure.
      try { Promise.resolve(listener(structuredClone(snapshot))).catch(() => {}); } catch {}
    }
  }

  async function readRaw(signal) {
    guard(signal);
    if (!storage?.get || !storage?.set) throw new Error('浏览器本地存储不可用，无法保存历史分组。');
    const result = await storage.get(CONVERSATION_ORGANIZATION_KEY);
    guard(signal);
    if (!object(result)) throw new Error('读取历史分组失败，浏览器未返回有效存储结果。');
    return normalizeConversationOrganization(result?.[CONVERSATION_ORGANIZATION_KEY]);
  }

  function command(operation) {
    if (lifetime.signal.aborted) return Promise.reject(disposedError());
    const controller = new AbortController();
    const cancel = () => controller.abort(disposedError());
    lifetime.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException(
      '整理历史对话超时；正在进行的存储写入可能仍会完成，请刷新列表核对。', 'TimeoutError',
    )), waitMs);
    const run = async () => {
      guard(controller.signal);
      const current = await readRaw(controller.signal);
      guard(controller.signal);
      return operation(current, controller.signal);
    };
    const pending = queue.catch(() => {}).then(() => {
      guard(controller.signal);
      return locks?.request ? locks.request(ORGANIZATION_LOCK, run) : run();
    });
    // Keep the real work in the queue and inside the lock after a waiting caller
    // times out. The next mutation must read after the earlier set has settled.
    queue = pending.catch(() => {});
    return awaitWithAbort(pending, controller.signal).finally(() => {
      clearTimeout(timer);
      lifetime.signal.removeEventListener('abort', cancel);
    });
  }

  function mutate(change) {
    return command(async (current, signal) => {
      const next = structuredClone(current);
      const changed = change(next);
      if (!changed) return current;
      if (next.revision === Number.MAX_SAFE_INTEGER) throw new Error('历史分组版本已达上限，未修改原记录。');
      next.revision += 1;
      guard(signal);
      await storage.set({ [CONVERSATION_ORGANIZATION_KEY]: next });
      guard(signal);
      publish(next);
      return structuredClone(next);
    });
  }

  function ensureUnique(snapshot, displayName, exceptId) {
    if (snapshot.groups.some(group => group.id !== exceptId && comparableName(group.name) === comparableName(displayName))) {
      throw new Error('已经有同名分组。');
    }
  }

  function findGroup(snapshot, id) {
    const group = snapshot.groups.find(item => item.id === id);
    if (!group) throw new Error('该分组已不存在，请刷新列表后重试。');
    return group;
  }

  const onStorageChange = (changes, areaName) => {
    if (areaName !== 'local' || !changes?.[CONVERSATION_ORGANIZATION_KEY]) return;
    // Invalid external data must be surfaced by read(), never replaced with an
    // empty index in a storage-event callback.
    try { publish(normalizeConversationOrganization(changes[CONVERSATION_ORGANIZATION_KEY].newValue)); } catch {}
  };
  storageChanges?.addListener?.(onStorageChange);

  return Object.freeze({
    read: () => command(current => {
      // A delayed change event must not downgrade a snapshot already returned
      // by an explicit refresh, even before this instance has written anything.
      publishedRevision = Math.max(publishedRevision, current.revision);
      return current;
    }),
    createGroup(displayName) {
      return mutate(snapshot => {
        const validName = groupName(displayName);
        ensureUnique(snapshot, validName);
        const id = groupIdentifier(`group-${randomId()}`);
        if (snapshot.groups.some(group => group.id === id)) throw new Error('无法生成唯一分组 ID，请重试。');
        const createdAt = now();
        if (typeof createdAt !== 'string' || !createdAt) throw new Error('无法确定分组创建时间。');
        snapshot.groups.push({ id, name: validName, createdAt });
        return true;
      });
    },
    renameGroup(id, displayName) {
      return mutate(snapshot => {
        const group = findGroup(snapshot, groupIdentifier(id));
        const validName = groupName(displayName);
        ensureUnique(snapshot, validName, id);
        if (group.name === validName) return false;
        group.name = validName;
        return true;
      });
    },
    deleteGroup(id) {
      return mutate(snapshot => {
        findGroup(snapshot, groupIdentifier(id));
        snapshot.groups = snapshot.groups.filter(group => group.id !== id);
        for (const [conversationId, groupId] of Object.entries(snapshot.assignments)) {
          if (groupId === id) delete snapshot.assignments[conversationId];
        }
        snapshot.preferences.collapsed = snapshot.preferences.collapsed.filter(groupId => groupId !== id);
        return true;
      });
    },
    moveConversations(ids, destination = null) {
      const requestedIds = Array.isArray(ids) ? [...ids] : ids;
      return mutate(snapshot => {
        const selected = conversationIds(requestedIds);
        if (destination !== null) findGroup(snapshot, groupIdentifier(destination));
        let changed = false;
        for (const id of selected) {
          if ((snapshot.assignments[id] ?? null) === destination) continue;
          if (destination === null) delete snapshot.assignments[id];
          else snapshot.assignments[id] = destination;
          changed = true;
        }
        return changed;
      });
    },
    renameConversation(id, displayName) {
      return mutate(snapshot => {
        identifier(id);
        const validName = name(displayName, 120, '对话名称');
        if (snapshot.titles[id] === validName) return false;
        snapshot.titles[id] = validName;
        return true;
      });
    },
    updatePreferences(patch) {
      const requested = object(patch)
        ? { ...patch, ...(Array.isArray(patch.collapsed) ? { collapsed: [...patch.collapsed] } : {}) }
        : patch;
      return mutate(snapshot => {
        if (!object(requested) || Object.keys(requested).some(key => !['view', 'collapsed'].includes(key))) {
          throw new Error('历史列表偏好无效。');
        }
        const next = { ...snapshot.preferences };
        if (requested.view !== undefined) {
          if (!['groups', 'all'].includes(requested.view)) throw new Error('历史列表视图无效。');
          next.view = requested.view;
        }
        if (requested.collapsed !== undefined) {
          if (!Array.isArray(requested.collapsed)) throw new Error('折叠分组列表无效。');
          requested.collapsed.forEach(id => identifier(id, '分组'));
          const known = new Set(['none', ...snapshot.groups.map(group => group.id)]);
          next.collapsed = [...new Set(requested.collapsed)].filter(id => known.has(id));
        }
        if (JSON.stringify(next) === JSON.stringify(snapshot.preferences)) return false;
        snapshot.preferences = next;
        return true;
      });
    },
    subscribe(listener) {
      guard();
      if (typeof listener !== 'function') throw new TypeError('历史分组订阅需要回调函数。');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(disposedError());
      listeners.clear();
      storageChanges?.removeListener?.(onStorageChange);
    },
  });
}

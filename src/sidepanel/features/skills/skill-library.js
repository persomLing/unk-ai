import { awaitWithAbort } from '../../../utils/abortable.js';
import { parseSkillMarkdown } from './skill-format.js';

export const SKILL_LIBRARY_KEY = 'importedSkills';
export const SKILL_LIBRARY_VERSION = 1;
export const SKILL_LIBRARY_LIMITS = Object.freeze({ maxRecords: 20, maxBytes: 1024 * 1024 });
const LOCK_NAME = 'unk-ai-imported-skills';
const queues = new WeakMap();
const byteLength = value => new TextEncoder().encode(value).length;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const comparableName = value => value.normalize('NFKC').trim().toLowerCase();
const closedError = () => new DOMException('技能库已关闭。', 'AbortError');

function recordId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('技能记录 ID 无效。');
  return value;
}

/** No migration rewrites existing data: this feature starts at version 1. */
export function normalizeSkillLibrary(value) {
  if (value === undefined) return { schemaVersion: SKILL_LIBRARY_VERSION, revision: 0, records: [] };
  if (!object(value) || value.schemaVersion !== SKILL_LIBRARY_VERSION) {
    throw new Error('技能库数据版本不受支持或已损坏，未修改原记录。');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.records)
    || value.records.length > SKILL_LIBRARY_LIMITS.maxRecords) throw new Error('技能库数据损坏，未修改原记录。');
  if (byteLength(JSON.stringify(value)) > SKILL_LIBRARY_LIMITS.maxBytes) throw new Error('技能库超过 1 MiB，未修改原记录。');
  const ids = new Set(), names = new Set();
  const records = value.records.map(record => {
    if (!object(record) || typeof record.raw !== 'string' || typeof record.sourceFileName !== 'string'
      || typeof record.importedAt !== 'string' || !Number.isFinite(Date.parse(record.importedAt))) {
      throw new Error('技能库记录损坏，未修改原记录。');
    }
    const id = recordId(record.id);
    const parsed = parseSkillMarkdown(record.raw, { fileName: record.sourceFileName });
    if (record.name !== parsed.name) throw new Error('技能名称与原文不一致，未修改原记录。');
    const nameKey = comparableName(parsed.name);
    if (ids.has(id) || names.has(nameKey)) throw new Error('技能库包含重复记录，未修改原记录。');
    ids.add(id); names.add(nameKey);
    return { id, name: parsed.name, raw: parsed.raw, sourceFileName: parsed.sourceFileName, importedAt: record.importedAt };
  });
  return { schemaVersion: SKILL_LIBRARY_VERSION, revision: value.revision, records };
}

/**
 * A caller timeout cancels waiting, not an already-started chrome.storage.set.
 * Keep that write in the actual queue/Web Lock until it settles, so a later
 * delete reads its committed revision and cannot be overwritten by the old set.
 */
export function createSkillLibrary({
  storage = globalThis.chrome?.storage?.local,
  locks = globalThis.navigator?.locks,
  now = () => new Date().toISOString(),
  randomId = () => globalThis.crypto.randomUUID(),
  timeoutMs = 5000,
} = {}) {
  const lifetime = new AbortController();
  const listeners = new Set();
  let publishedRevision = -1;
  const waitMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 5000;
  function guard(signal) {
    if (lifetime.signal.aborted) throw closedError();
    signal?.throwIfAborted();
    if (!storage?.get || !storage?.set) throw new Error('浏览器本地存储不可用，无法读取或保存技能。');
  }
  function publish(snapshot) {
    if (lifetime.signal.aborted || snapshot.revision <= publishedRevision) return;
    publishedRevision = snapshot.revision;
    for (const listener of listeners) {
      try { Promise.resolve(listener(structuredClone(snapshot))).catch(() => {}); } catch { /* Independent view. */ }
    }
  }
  async function read(signal) {
    guard(signal);
    // A read can stop waiting safely: it cannot overwrite a following command.
    const result = await awaitWithAbort(storage.get(SKILL_LIBRARY_KEY), signal);
    guard(signal);
    if (!object(result)) throw new Error('浏览器未返回有效的技能库数据。');
    return normalizeSkillLibrary(result[SKILL_LIBRARY_KEY]);
  }
  function command(operation, signal) {
    try { guard(signal); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    const close = () => controller.abort(closedError());
    signal?.addEventListener('abort', cancel, { once: true });
    lifetime.signal.addEventListener('abort', close, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException(
      '技能库操作超时；已开始的保存可能仍会完成，请重新打开技能库核对。', 'TimeoutError',
    )), waitMs);
    const run = async () => {
      guard(controller.signal);
      const current = await read(controller.signal);
      guard(controller.signal);
      const result = await operation(current, controller.signal);
      guard(controller.signal);
      publish(result.snapshot);
      return structuredClone(result.value);
    };
    const pending = (queues.get(storage) || Promise.resolve()).catch(() => {}).then(() => {
      guard(controller.signal);
      return locks?.request ? locks.request(LOCK_NAME, { signal: controller.signal }, run) : run();
    });
    queues.set(storage, pending.catch(() => {}));
    return awaitWithAbort(pending, controller.signal).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      lifetime.signal.removeEventListener('abort', close);
    });
  }
  async function commit(snapshot, signal) {
    const next = normalizeSkillLibrary(snapshot);
    guard(signal);
    await storage.set({ [SKILL_LIBRARY_KEY]: structuredClone(next) });
    guard(signal);
    return next;
  }
  return Object.freeze({
    list({ signal } = {}) { return command(async snapshot => ({ snapshot, value: snapshot }), signal); },
    importMarkdown(raw, { fileName = 'SKILL.md', signal } = {}) {
      let parsed;
      try { parsed = parseSkillMarkdown(raw, { fileName }); } catch (error) { return Promise.reject(error); }
      return command(async (snapshot, operationSignal) => {
        if (snapshot.records.length >= SKILL_LIBRARY_LIMITS.maxRecords) throw new Error('最多保存 20 个技能，请先移除不需要的技能。');
        if (snapshot.records.some(record => comparableName(record.name) === comparableName(parsed.name))) {
          throw new Error(`技能“${parsed.name}”已存在。请先删除旧条目再导入，不会自动覆盖。`);
        }
        const record = { id: recordId(randomId()), name: parsed.name, raw: parsed.raw,
          sourceFileName: parsed.sourceFileName, importedAt: now() };
        const next = await commit({ ...snapshot, revision: snapshot.revision + 1, records: [record, ...snapshot.records] }, operationSignal);
        return { snapshot: next, value: record };
      }, signal);
    },
    remove(id, { signal } = {}) {
      try { recordId(id); } catch (error) { return Promise.reject(error); }
      return command(async (snapshot, operationSignal) => {
        const records = snapshot.records.filter(record => record.id !== id);
        if (records.length === snapshot.records.length) return { snapshot, value: snapshot };
        const next = await commit({ ...snapshot, revision: snapshot.revision + 1, records }, operationSignal);
        return { snapshot: next, value: next };
      }, signal);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { lifetime.abort(closedError()); listeners.clear(); },
  });
}

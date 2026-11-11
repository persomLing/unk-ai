import { normalizeProviderConfig } from './profiles.js';

const PROVIDER_CONFIG_KEY = 'providerConfig';
const CONVERSATION_INDEX_KEY = 'conversationIndex';
const CONVERSATION_PREFIX = 'conversation:';
const TEMPORARY_CONVERSATION_KEY = 'temporaryConversation';

function localStorageArea() {
  const area = globalThis.chrome?.storage?.local;
  if (!area) throw new Error('chrome.storage.local is unavailable.');
  return area;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function id() {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is unavailable.');
  }
  return randomUUID.call(globalThis.crypto);
}

function now() {
  return new Date().toISOString();
}

async function read(keys) {
  return localStorageArea().get(keys === null ? null : keys);
}

async function write(items) {
  const bytes = new Blob([JSON.stringify(items)]).size;
  if (bytes > 8 * 1024 * 1024) {
    throw new Error('临时对话超过浏览器本地存储限制，请先保存到本地文件夹或移除附件。');
  }
  if (bytes > 1024 * 1024) {
    // Persistence protects origin storage from eviction; it is not permission
    // to use chrome.storage.local. A denied hint must not discard the draft.
    await globalThis.navigator?.storage?.persist?.().catch(() => {});
  }
  await localStorageArea().set(items);
}

function validIndex(index) {
  return Array.isArray(index) ? index.filter((entry) => entry && typeof entry.id === 'string') : [];
}

function compareUpdatedAt(left, right) {
  const difference = String(right.updatedAt).localeCompare(String(left.updatedAt));
  return difference || String(left.id).localeCompare(String(right.id));
}

function indexEntry(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
  };
}

function normalizeConversation(conversation) {
  const normalized = clone(conversation);
  if (!Array.isArray(normalized.messages)) normalized.messages = [];
  for (const message of normalized.messages) {
    if (message?.status === 'streaming') {
      message.status = 'stopped';
      delete message.reasoningStartedAt;
      delete message.reasoningFinishedAt;
    }
  }
  return normalized;
}

/** Return the local provider configuration, or null when it has not been set. */
export async function getProviderConfig() {
  const result = await read(PROVIDER_CONFIG_KEY);
  return normalizeProviderConfig(result[PROVIDER_CONFIG_KEY]);
}

/** Save a versioned provider configuration without writing it anywhere else. */
export async function saveProviderConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Provider configuration must be an object.');
  }
  const saved = { ...normalizeProviderConfig(config), version: 4 };
  await write({ [PROVIDER_CONFIG_KEY]: saved });
  return clone(saved);
}

export async function listConversations() {
  const result = await read(CONVERSATION_INDEX_KEY);
  return validIndex(result[CONVERSATION_INDEX_KEY])
    .map(clone)
    .sort(compareUpdatedAt);
}

export async function getConversation(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) return null;
  const key = `${CONVERSATION_PREFIX}${conversationId}`;
  const result = await read(key);
  return result[key] ? normalizeConversation(result[key]) : null;
}

/** Persist the complete record before updating its index entry. */
export async function saveConversation(conversation) {
  if (!conversation || typeof conversation.id !== 'string' || !conversation.id) {
    throw new TypeError('A conversation with a valid id is required.');
  }

  const saved = normalizeConversation(conversation);
  saved.version = 1;
  await write({ [`${CONVERSATION_PREFIX}${saved.id}`]: saved });

  const result = await read(CONVERSATION_INDEX_KEY);
  const index = validIndex(result[CONVERSATION_INDEX_KEY])
    .filter((entry) => entry.id !== saved.id);
  index.push(indexEntry(saved));
  index.sort(compareUpdatedAt);
  await write({ [CONVERSATION_INDEX_KEY]: index });
  return clone(saved);
}

export async function createConversation(title = 'New conversation') {
  const timestamp = now();
  const conversation = {
    version: 1,
    id: id(),
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  };
  await saveConversation(conversation);
  return conversation;
}

export async function deleteConversation(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) return false;
  const key = `${CONVERSATION_PREFIX}${conversationId}`;
  const existing = await read(key);
  if (!existing[key]) return false;

  await localStorageArea().remove(key);
  const result = await read(CONVERSATION_INDEX_KEY);
  const index = validIndex(result[CONVERSATION_INDEX_KEY])
    .filter((entry) => entry.id !== conversationId);
  await write({ [CONVERSATION_INDEX_KEY]: index });
  return true;
}

/** There is deliberately only one temporary conversation key. */
export async function getTemporaryConversation() {
  const result = await read(TEMPORARY_CONVERSATION_KEY);
  return result[TEMPORARY_CONVERSATION_KEY]
    ? normalizeConversation({ ...result[TEMPORARY_CONVERSATION_KEY], storage: 'temporary' })
    : null;
}

export async function saveTemporaryConversation(conversation) {
  if (!conversation || typeof conversation.id !== 'string' || !conversation.id) {
    throw new TypeError('A conversation with a valid id is required.');
  }
  const saved = normalizeConversation({ ...conversation, storage: 'temporary' });
  saved.version = 2;
  await write({ [TEMPORARY_CONVERSATION_KEY]: saved });
  return clone(saved);
}

export async function clearTemporaryConversation() {
  await localStorageArea().remove(TEMPORARY_CONVERSATION_KEY);
}

/** Read older records that were stored entirely in chrome.storage.local. */
export async function listLegacyConversationRecords() {
  const result = await read(null);
  return Object.entries(result)
    .filter(([key, value]) => key.startsWith(CONVERSATION_PREFIX) && value?.id && Array.isArray(value.messages))
    .map(([, value]) => normalizeConversation({ ...value, storage: 'legacy' }));
}

export async function removeLegacyConversationRecords(ids) {
  const keys = [...new Set((ids || []).map((id) => `${CONVERSATION_PREFIX}${id}`))];
  if (keys.length) await localStorageArea().remove(keys);
}

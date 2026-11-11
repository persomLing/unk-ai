import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_READING_SETTINGS_KEY,
  getNetworkReadingGrant,
  setNetworkReadingGrant,
  sanitizeNetworkJson,
  networkResponseSource,
} from '../src/utils/network-reading.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(value) { Object.assign(data, structuredClone(value)); },
  };
}

test('network permissions default off and simultaneous origin writes retain each grant', async () => {
  const storage = memoryStorage();
  assert.equal((await getNetworkReadingGrant('https://a.test/path', { storage })).allowed, false);
  await Promise.all([
    setNetworkReadingGrant('https://a.test', true, { storage }),
    setNetworkReadingGrant('https://b.test', true, { storage }),
  ]);
  assert.equal((await getNetworkReadingGrant('https://a.test/page', { storage })).allowed, true);
  assert.equal((await getNetworkReadingGrant('https://b.test', { storage })).allowed, true);
  await setNetworkReadingGrant('https://a.test', false, { storage });
  assert.equal((await getNetworkReadingGrant('https://a.test', { storage })).allowed, false);
  assert.equal(storage.data[NETWORK_READING_SETTINGS_KEY].version, 1);
  assert.equal(storage.data[NETWORK_READING_SETTINGS_KEY].revision, 3);
});

test('unknown permission versions are not overwritten', async () => {
  const storage = memoryStorage();
  storage.data[NETWORK_READING_SETTINGS_KEY] = { version: 99, origins: { preserved: true } };
  await assert.rejects(setNetworkReadingGrant('https://a.test', true, { storage }), { code: 'NETWORK_SETTINGS_VERSION' });
  assert.equal(storage.data[NETWORK_READING_SETTINGS_KEY].version, 99);
});

test('a timed out write retains serialization and cannot overwrite a subsequent revoke', async () => {
  const storage = memoryStorage();
  const original = storage.set;
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  storage.set = async value => {
    if (!release) {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return original(value);
  };
  const grant = setNetworkReadingGrant('https://a.test', true, { storage, timeoutMs: 15 });
  await started;
  await assert.rejects(grant, { name: 'TimeoutError' });
  const revoke = setNetworkReadingGrant('https://a.test', false, { storage, timeoutMs: 500 });
  release();
  await revoke;
  assert.equal((await getNetworkReadingGrant('https://a.test', { storage })).allowed, false);
});

test('aborted or queued expired permission changes do not start later writes', async () => {
  const storage = memoryStorage();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(setNetworkReadingGrant('https://a.test', true, { storage, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(storage.data[NETWORK_READING_SETTINGS_KEY], undefined);
  await assert.rejects(getNetworkReadingGrant('https://a.test', { storage: { get: () => new Promise(() => {}) }, timeoutMs: 5 }), { name: 'TimeoutError' });
});

test('JSON responses redact credentials and common personal data before returning any text', () => {
  const result = sanitizeNetworkJson(JSON.stringify({
    access_token: 'secret-value', nested: { password: 'dont-show', email: 'a@example.test', mobile: '13800138000' },
    notes: 'Write a@example.test or +1 202-555-0198, Bearer abcd-secret',
    link: 'https://a.test/read?api_key=secret-link', description: 'token=private-token',
    count: 21, rates: [1, 2, 3],
  }));
  assert.doesNotMatch(result.text, /secret-value|dont-show|a@example\.test|13800138000|202-555|abcd-secret|secret-link|private-token/);
  assert.match(result.text, /"count": 21/);
  assert.ok(result.redactions >= 7);
});

test('JSON response budgets reject oversized bytes and label structural/text truncation', () => {
  assert.throws(() => sanitizeNetworkJson('{"text":"你好"}', { maxBytes: 10 }), { code: 'NETWORK_RESPONSE_LIMIT' });
  assert.throws(() => sanitizeNetworkJson('<html>login</html>'), { code: 'NETWORK_RESPONSE_FORMAT' });
  const result = sanitizeNetworkJson(JSON.stringify({ rows: Array.from({ length: 150 }, (_, i) => ({ label: `r${i}`, value: i })) }), { maxChars: 100 });
  assert.equal(result.text.length, 100);
  assert.equal(result.truncated, true);
});

test('response source metadata drops query credentials, fragments and personal path values', () => {
  const source = networkResponseSource('https://a.test/api/a%40example.test/13800138000?token=secret#private');
  assert.doesNotMatch(source, /secret|private|example\.test|13800138000/);
  assert.match(source, /^https:\/\/a.test\/api\//);
});

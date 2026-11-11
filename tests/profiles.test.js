import test from 'node:test';
import assert from 'node:assert/strict';

import { credentialForModel, normalizeProfile, normalizeProviderConfig, requestProfile, updateProfileGenerationSettings } from '../src/utils/profiles.js';
import { normalizeModel } from '../src/utils/llm-client.js';

test('migrates a single-model v2 config into a model library', () => {
  const config = normalizeProviderConfig({
    version: 2,
    endpointUrl: 'http://localhost:7864/v1',
    apiKey: 'secret',
    model: 'cn:hy4-preview',
    contextLength: 960000,
    maxTokens: 64000,
    reasoningEnabled: true,
    reasoningEffort: 'high',
  });
  assert.equal(config.version, 4);
  assert.equal(config.models.length, 1);
  assert.equal(config.selectedModelId, 'cn:hy4-preview');
  assert.equal(config.models[0].endpointUrl, 'http://localhost:7864/v1');
  assert.equal(requestProfile(config).model, 'cn:hy4-preview');
  assert.equal(requestProfile(config).reasoningEffort, 'high');
});

test('web capability endpoints default for old configs and normalize editable names', () => {
  const legacy = normalizeProviderConfig({ version: 3, endpointUrl: 'http://localhost:7864/v1', models: [{ id: 'model' }] });
  assert.equal(legacy.webSearchEndpoint, 'web_search');
  assert.equal(legacy.webFetchEndpoint, 'web_fetch');
  assert.equal(legacy.webSearchEnabled, true);
  assert.equal(legacy.webFetchEnabled, true);

  const customized = normalizeProviderConfig({
    endpointUrl: 'http://localhost:7864/v1',
    webSearchEndpoint: '/search/',
    webFetchEndpoint: 'reader',
    webFetchEnabled: false,
    models: [{ id: 'model' }],
  });
  assert.equal(customized.webSearchEndpoint, 'search');
  assert.equal(customized.webFetchEndpoint, 'reader');
  assert.equal(customized.webFetchEnabled, false);
  assert.equal(customized.webSearchEnabled, true);
});

test('unknown capabilities from a standard models list remain editable', () => {
  const unknown = normalizeProfile(normalizeModel({ id: 'vision-model', object: 'model' }));
  assert.equal(unknown.supportsVision, null);
  assert.equal(unknown.supportsReasoning, null);
  const enabled = updateProfileGenerationSettings(unknown, { reasoningEnabled: true, visionEnabled: true, reasoningEffort: 'high' });
  const config = normalizeProviderConfig({ endpointUrl: 'https://provider.test/v1', models: [enabled] });
  assert.equal(requestProfile(config).supportsVision, true);
  assert.equal(requestProfile(config).reasoningEnabled, true);
  assert.equal(requestProfile(config).reasoningEffort, 'high');
});

test('explicitly disabling saved capabilities and changing defaults survive normalization', () => {
  const original = normalizeProfile({ id: 'model', supportsVision: true, supportsReasoning: true, reasoningDefaultEffort: 'high' });
  const edited = updateProfileGenerationSettings(original, { reasoningEnabled: false, visionEnabled: false, reasoningEffort: 'low' });
  const reloaded = normalizeProviderConfig({ endpointUrl: 'https://provider.test/v1', models: [edited] });
  assert.equal(requestProfile(reloaded).reasoningEnabled, false);
  assert.equal(requestProfile(reloaded).supportsVision, false);
  assert.equal(reloaded.models[0].reasoningDefaultEffort, 'low');
});

test('resolves multiple models and per-request effort overrides', () => {
  const config = normalizeProviderConfig({
    endpointUrl: 'http://localhost:7864/v1',
    apiKey: '',
    selectedModelId: 'second',
    selectedEffort: 'low',
    models: [
      { id: 'first', name: 'First', contextLength: 128000, maxOutputTokens: 4096, supportsReasoning: true, reasoningEfforts: ['low', 'high'] },
      { id: 'second', name: 'Second', contextLength: 1000000, maxOutputTokens: 128000, temperature: 0.4, supportsReasoning: true, reasoningEfforts: ['low', 'high', 'max'] },
    ],
  });
  assert.equal(config.models.length, 2);
  assert.equal(requestProfile(config).model, 'second');
  assert.equal(requestProfile(config, { modelId: 'first', effort: 'high' }).model, 'first');
  assert.equal(requestProfile(config, { modelId: 'first', effort: 'high' }).reasoningEffort, 'high');
  assert.equal(requestProfile(config).temperature, 0.4);
  assert.equal(requestProfile(config, { temperature: 0.8 }).temperature, 0.8);
});

test('credentials key changes with either URL or API key', () => {
  assert.equal(credentialForModel('https://a.test/v1', 'k1'), 'https://a.test/v1\u0000k1');
  assert.notEqual(
    credentialForModel('https://a.test/v1', 'k1'),
    credentialForModel('https://b.test/v1', 'k1'),
  );
  assert.notEqual(
    credentialForModel('https://a.test/v1', 'k1'),
    credentialForModel('https://a.test/v1', 'k2'),
  );
});

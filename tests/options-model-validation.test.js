import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelGeneration } from '../src/options/model-validation.js';
import { normalizeProfile } from '../src/utils/profiles.js';

function config(overrides = {}) {
  return {
    selectedModelId: 'model-b', selectedModelName: '模型 B',
    temperature: 0.4, contextLength: 16000, maxTokens: 2048,
    models: [
      { id: 'model-a', name: '模型 A', temperature: 0.3, contextLength: 32000, maxOutputTokens: 4096 },
      { id: 'model-b', name: '模型 B', temperature: 0.4, contextLength: 16000, maxOutputTokens: 2048 },
    ],
    ...overrides,
  };
}

function expectInvalid(value, modelId, field, message) {
  assert.throws(() => validateModelGeneration(value), error => {
    assert.equal(error.modelId, modelId);
    assert.equal(error.field, field);
    assert.match(error.message, message);
    return true;
  });
}

test('valid multiple-model settings are checked without mutating drafts', () => {
  const draft = config();
  const before = structuredClone(draft);
  assert.doesNotThrow(() => validateModelGeneration(draft));
  assert.deepEqual(draft, before);
});

test('undefined and null defaults remain valid for both current controls and saved profiles', () => {
  for (const missing of [undefined, null]) {
    const draft = config({ temperature: missing, contextLength: missing, maxTokens: missing });
    draft.models[0] = { id: 'model-a', name: '模型 A', temperature: missing, contextLength: missing, maxOutputTokens: missing };
    assert.doesNotThrow(() => validateModelGeneration(draft));
  }
  const oldProfile = normalizeProfile({ id: 'old', temperature: '', contextLength: '', maxOutputTokens: '' });
  assert.doesNotThrow(() => validateModelGeneration({ models: [oldProfile] }));
});

test('top-level errors identify the selected model and its visible form field', () => {
  expectInvalid(config({ temperature: -0.1 }), 'model-b', 'temperature', /模型 B.*Temperature/);
  expectInvalid(config({ contextLength: 1.5 }), 'model-b', 'contextLength', /模型 B.*上下文长度/);
  expectInvalid(config({ maxTokens: 0 }), 'model-b', 'maxTokens', /模型 B.*最大输出/);
});

test('a nonselected model cannot hide invalid generation fields when another model is saved', () => {
  for (const [field, value, formField, message] of [
    ['temperature', 2.1, 'temperature', /模型 A.*Temperature/],
    ['contextLength', -1, 'contextLength', /模型 A.*上下文长度/],
    ['maxOutputTokens', 3.5, 'maxTokens', /模型 A.*最大输出/],
  ]) {
    const draft = config();
    draft.models[0][field] = value;
    expectInvalid(draft, 'model-a', formField, message);
  }
});

test('temperature accepts both endpoints and rejects nonfinite and nonnumeric values', () => {
  for (const temperature of [0, 2]) {
    assert.doesNotThrow(() => validateModelGeneration(config({ temperature })));
  }
  for (const temperature of [NaN, Infinity, -Infinity, '0.5', '', false]) {
    expectInvalid(config({ temperature }), 'model-b', 'temperature', /0 到 2/);
  }
});

test('token budgets require positive safe integers before any normalizer can hide invalid values', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4096', '', false]) {
    expectInvalid(config({ contextLength: value }), 'model-b', 'contextLength', /正整数/);
    expectInvalid(config({ maxTokens: value }), 'model-b', 'maxTokens', /正整数/);
  }
  assert.doesNotThrow(() => validateModelGeneration(config({ contextLength: Number.MAX_SAFE_INTEGER, maxTokens: 1 })));
});

test('maximum output must be lower than context in current and nonselected model drafts', () => {
  for (const maxTokens of [16000, 16001]) {
    expectInvalid(config({ maxTokens }), 'model-b', 'maxTokens', /小于上下文长度/);
  }
  const draft = config();
  draft.models[0].maxOutputTokens = draft.models[0].contextLength;
  expectInvalid(draft, 'model-a', 'maxTokens', /模型 A.*小于上下文长度/);
});

test('an unspecified token budget does not invent a limit for the other budget', () => {
  assert.doesNotThrow(() => validateModelGeneration(config({ contextLength: null, maxTokens: 2048 })));
  assert.doesNotThrow(() => validateModelGeneration(config({ contextLength: 16000, maxTokens: undefined })));
  const draft = config();
  draft.models[0].contextLength = null;
  assert.doesNotThrow(() => validateModelGeneration(draft));
});

test('fallback identity still locates the first model when no explicit selection exists', () => {
  expectInvalid(config({ selectedModelId: '', temperature: 3 }), 'model-a', 'temperature', /模型 A/);
  expectInvalid({ selectedModelId: 'legacy', selectedModelName: '旧模型', models: [], maxTokens: -1 }, 'legacy', 'maxTokens', /旧模型/);
});

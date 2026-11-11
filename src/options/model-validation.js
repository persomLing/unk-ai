const isDefault = value => value === undefined || value === null;

function invalid(modelId, modelName, field, message) {
  const error = new Error(`模型“${modelName}”的${message}`);
  error.modelId = modelId;
  error.field = field;
  return error;
}

function validateValues({ temperature, contextLength, maxTokens }, modelId, modelName) {
  if (!isDefault(temperature)
    && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw invalid(modelId, modelName, 'temperature', ' Temperature 需为 0 到 2 之间的数值。');
  }
  for (const [field, value, label] of [
    ['maxTokens', maxTokens, '最大输出'],
    ['contextLength', contextLength, '上下文长度'],
  ]) {
    if (!isDefault(value) && (!Number.isSafeInteger(value) || value < 1)) {
      throw invalid(modelId, modelName, field, `${label}需为正整数。`);
    }
  }
  if (!isDefault(contextLength) && !isDefault(maxTokens) && maxTokens >= contextLength) {
    throw invalid(modelId, modelName, 'maxTokens', '最大输出需要小于上下文长度。');
  }
}

/** Validate editable numeric values before profile normalization can discard them. */
export function validateModelGeneration(config) {
  const models = Array.isArray(config.models) ? config.models : [];
  const selected = models.find(model => model.id === config.selectedModelId) || models[0];
  const selectedId = selected?.id || config.selectedModelId || '';
  const selectedName = selected?.name || config.selectedModelName || selectedId || '当前模型';
  validateValues(config, selectedId, selectedName);
  for (const model of models) {
    validateValues({
      temperature: model.temperature,
      contextLength: model.contextLength,
      maxTokens: model.maxOutputTokens,
    }, model.id || '', model.name || model.id || '未命名模型');
  }
}

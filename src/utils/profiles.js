const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high'];
export const DEFAULT_WEB_SEARCH_ENDPOINT = 'web_search';
export const DEFAULT_WEB_FETCH_ENDPOINT = 'web_fetch';

function endpointName(value, fallback) {
  const normalized = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return normalized || fallback;
}

function capability(value) {
  return typeof value === 'boolean' ? value : null;
}

export function modelKey(model) {
  return `${model?.endpointUrl || ''}\u0000${model?.id || model?.model || ''}`;
}

export function normalizeEffort(value, fallback = 'default') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

/** Normalize one saved model, keeping old single-model configs compatible. */
export function normalizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const id = String(profile.id || profile.model || '').trim();
  if (!id) return null;
  const efforts = Array.isArray(profile.reasoningEfforts)
    ? [...new Set(profile.reasoningEfforts.map((effort) => String(effort).trim()).filter(Boolean))]
    : [];
  return {
    id,
    endpointUrl: String(profile.endpointUrl || ''),
    name: String(profile.name || id),
    description: String(profile.description || ''),
    contextLength: Number(profile.contextLength) || null,
    maxOutputTokens: Number(profile.maxOutputTokens ?? profile.maxTokens) || null,
    temperature: profile.temperature !== undefined && profile.temperature !== null && profile.temperature !== ''
      ? Number(profile.temperature)
      : null,
    supportsReasoning: capability(profile.supportsReasoning ?? profile.reasoningEnabled),
    supportsVision: capability(profile.supportsVision ?? profile.visionEnabled),
    reasoningEfforts: efforts.length ? efforts : DEFAULT_REASONING_EFFORTS,
    reasoningDefaultEffort: normalizeEffort(profile.reasoningDefaultEffort || profile.reasoningEffort),
  };
}

/** Convert editable controls to canonical fields, including explicit false. */
export function updateProfileGenerationSettings(profile, settings) {
  return normalizeProfile({
    ...profile,
    contextLength: settings.contextLength ?? null,
    maxOutputTokens: settings.maxOutputTokens ?? null,
    temperature: settings.temperature ?? null,
    supportsReasoning: Boolean(settings.reasoningEnabled),
    supportsVision: Boolean(settings.visionEnabled),
    reasoningDefaultEffort: normalizeEffort(settings.reasoningEffort),
  });
}

export function credentialForModel(endpointUrl, apiKey) {
  return `${String(endpointUrl || '').trim()}\u0000${String(apiKey || '')}`;
}

/** Read models from either the new library or the previous single-model shape. */
export function normalizeProviderConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  let profiles = Array.isArray(config.models)
    ? config.models.map(normalizeProfile).filter(Boolean)
    : [];
  if (!profiles.length && config.model) profiles = [normalizeProfile(config)];
  profiles = profiles.map((profile) => ({ ...profile, endpointUrl: profile.endpointUrl || String(config.endpointUrl || '') }));
  const selected = profiles.find((profile) => profile.id === config.selectedModelId)
    || profiles.find((profile) => profile.id === config.model)
    || profiles[0]
    || null;
  return {
    version: 4,
    endpointUrl: String(config.endpointUrl || ''),
    apiKey: String(config.apiKey || ''),
    webSearchEndpoint: endpointName(config.webSearchEndpoint, DEFAULT_WEB_SEARCH_ENDPOINT),
    webFetchEndpoint: endpointName(config.webFetchEndpoint, DEFAULT_WEB_FETCH_ENDPOINT),
    webSearchEnabled: config.webSearchEnabled !== false,
    webFetchEnabled: config.webFetchEnabled !== false,
    temperature: config.temperature,
    contextLength: Number(config.contextLength) || selected?.contextLength || null,
    maxTokens: Number(config.maxTokens) || selected?.maxOutputTokens || null,
    selectedModelId: selected?.id || '',
    selectedModelName: String(config.selectedModelName || selected?.name || selected?.id || ''),
    selectedEffort: normalizeEffort(config.selectedEffort || selected?.reasoningDefaultEffort),
    models: profiles,
  };
}

export function selectedModel(config) {
  const normalized = normalizeProviderConfig(config);
  if (!normalized) return null;
  return normalized.models.find((model) => model.id === normalized.selectedModelId) || normalized.models[0] || null;
}

/** Build request-level settings for the selected model without mutating config. */
export function requestProfile(config, overrides = {}) {
  const normalized = normalizeProviderConfig(config);
  if (!normalized) return null;
  const model = normalized.models.find((item) => item.id === (overrides.modelId || normalized.selectedModelId))
    || normalized.models[0]
    || null;
  if (!model) return null;
  const reasoningEnabled = overrides.reasoningEnabled ?? model.supportsReasoning;
  const effort = normalizeEffort(overrides.effort || normalized.selectedEffort || model.reasoningDefaultEffort);
  const storedTemperature = normalized.temperature !== undefined && normalized.temperature !== null
    && normalized.temperature !== ''
    ? Number(normalized.temperature)
    : null;
  const temperature = overrides.temperature ?? model.temperature ?? storedTemperature;
  return {
    endpointUrl: normalized.endpointUrl,
    apiKey: normalized.apiKey,
    webSearchEndpoint: normalized.webSearchEndpoint,
    webFetchEndpoint: normalized.webFetchEndpoint,
    webSearchEnabled: normalized.webSearchEnabled,
    webFetchEnabled: normalized.webFetchEnabled,
    model: model.id,
    temperature,
    contextLength: Number(overrides.contextLength) || Number(model.contextLength) || normalized.contextLength || 128000,
    maxTokens: Number(overrides.maxTokens) || Number(model.maxOutputTokens) || normalized.maxTokens || undefined,
    reasoningEnabled,
    reasoningEffort: effort,
    supportsVision: model.supportsVision,
  };
}

import { normalizeProviderConfig } from '../../../utils/profiles.js';
import { directImageForMessage } from '../../../utils/image-generation-command.js';

export function modelSelectionFor(model, effort = model?.reasoningDefaultEffort) {
  const allowedEffort = model?.supportsReasoning && model.reasoningEfforts?.includes(effort);
  return { version: 1, modelId: model?.id || '', effort: allowedEffort ? effort : 'default' };
}

function lastConversationModel(messages) {
  let model = null;
  let question = null;
  for (const message of messages || []) {
    if (message?.role === 'user') question = message;
    if (message?.role !== 'assistant' || message.optimistic || directImageForMessage(question)) continue;
    const modelId = message.modelId || message.model;
    if (typeof modelId === 'string' && modelId) model = { modelId, effort: message.reasoningEffort };
  }
  return model;
}

export function resolveConversationModel(config, conversation, draftSelection) {
  const normalized = normalizeProviderConfig(config);
  const hasSelection = conversation ? Object.hasOwn(conversation, 'modelSelection') : Boolean(draftSelection);
  const saved = conversation?.modelSelection ?? draftSelection;
  const selection = hasSelection ? (saved?.version === 1 ? saved : { modelId: '' })
    : lastConversationModel(conversation?.messages);
  if (!selection && !conversation?.messages?.length) {
    return modelSelectionFor(normalized?.models.find(item => item.kind === 'chat'));
  }
  const modelId = selection ? selection.modelId : normalized?.selectedModelId;
  const model = normalized?.models.find(item => item.kind === 'chat' && item.id === modelId);
  const effort = selection?.effort ?? (selection ? model?.reasoningDefaultEffort : normalized?.selectedEffort);
  return modelSelectionFor(model, effort);
}

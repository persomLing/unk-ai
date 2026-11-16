// Provider-neutral estimates, not a tokenizer or a billing meter. Keep one
// accounting path for preview, request telemetry and input budget checks.
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const ESTIMATED_IMAGE_TOKENS = 765;
const MESSAGE_OVERHEAD = 4;
const REQUEST_OVERHEAD = 3;

export function estimateTextTokens(value) {
  const text = String(value ?? '');
  let tokens = 0;
  for (const character of text) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/u.test(character)) tokens += 1;
    else if (/\s/u.test(character)) tokens += 0.18;
    else if (/[.,;:!?'"()[\]{}<>/\\|`~@#$%^&*_+=-]/u.test(character)) tokens += 0.35;
    else if (character.codePointAt(0) > 0xffff) tokens += 2;
    else if (character.charCodeAt(0) > 0x7f) tokens += 1;
    else tokens += 0.27;
  }
  return Math.ceil(tokens);
}

/** Buckets describe the wire roles, never guess instructions from text tags.
 * Page, document and provider messages belong to messages; a history summary
 * sent in a system message belongs to system. Images/framing belong to other.
 * Binary file payloads have unknown provider-side extraction cost, not zero. */
export function estimateRequestTokens({ messages = [], tools = [] } = {}) {
  const breakdown = { system: 0, tools: 0, messages: 0, other: REQUEST_OVERHEAD };
  let imageCount = 0, unestimatedParts = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') { unestimatedParts++; continue; }
    const category = ['system', 'developer'].includes(message.role) ? 'system'
      : ['tool', 'function'].includes(message.role) ? 'tools' : 'messages';
    breakdown.other += MESSAGE_OVERHEAD;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object') { unestimatedParts++; continue; }
        if (part.type === 'text') breakdown[category] += estimateTextTokens(part.text);
        else if (part.type === 'image_url') { breakdown.other += ESTIMATED_IMAGE_TOKENS; imageCount++; }
        else unestimatedParts++;
      }
    } else breakdown[category] += estimateTextTokens(message.content);
    if (message.reasoning_content) breakdown[category] += estimateTextTokens(message.reasoning_content);
    if (message.tool_calls?.length) breakdown.tools += estimateTextTokens(JSON.stringify(message.tool_calls));
    if (message.function_call) breakdown.tools += estimateTextTokens(JSON.stringify(message.function_call));
    if (message.tool_call_id) breakdown.tools += estimateTextTokens(message.tool_call_id);
    if (message.name) breakdown.other += estimateTextTokens(message.name);
  }
  if (tools.length) breakdown.tools += estimateTextTokens(JSON.stringify(tools));
  return { method: 'heuristic-v2', estimated: true, breakdown, imageCount, unestimatedParts,
    used: Object.values(breakdown).reduce((sum, tokens) => sum + tokens, 0) };
}

export function estimateMessagesTokens(messages) {
  return estimateRequestTokens({ messages: messages || [] }).used;
}

const nonnegative = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
export function inputTokenBudget(contextWindow, reserveTokens = 0) {
  const total = Math.max(1, nonnegative(contextWindow) || DEFAULT_CONTEXT_WINDOW);
  return Math.max(0, Math.floor(total * 0.97) - nonnegative(reserveTokens));
}

export function compressionThreshold(contextWindow, reserveTokens = 0) {
  return Math.floor(inputTokenBudget(contextWindow, reserveTokens) * 0.9);
}

export function requestTokenUsage({ messages = [], tools = [], contextWindow, maxTokens = 0, additionalInputTokens = 0 } = {}) {
  const estimate = estimateRequestTokens({ messages, tools });
  // Compression can reserve known tool/provider messages before assembling its
  // base history. This is input, and must never be confused with output reserve.
  const additional = nonnegative(additionalInputTokens);
  estimate.breakdown.other += additional;
  const used = estimate.used + additional;
  const total = Math.max(1, nonnegative(contextWindow) || DEFAULT_CONTEXT_WINDOW);
  const reservedOutputTokens = nonnegative(maxTokens);
  const inputBudget = inputTokenBudget(total, reservedOutputTokens);
  const threshold = compressionThreshold(total, reservedOutputTokens);
  return { ...estimate, used, total, inputBudget, threshold, reservedOutputTokens,
    safetyTokens: total - Math.floor(total * 0.97),
    percent: Math.min(999, Math.round(used / total * 100)),
    budgetPercent: inputBudget > 0 ? Math.min(999, Math.round(used / inputBudget * 100)) : 999,
    remainingPercent: Math.max(0, Math.round((inputBudget - used) / total * 100)),
    overBudget: used > inputBudget,
    shouldCompress: used >= threshold };
}

/** Integer shares add up to 100 even for tiny buckets and rounding ties. */
export function tokenShares(breakdown) {
  const entries = Object.entries(breakdown);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return Object.fromEntries(entries.map(([key]) => [key, 0]));
  const shares = entries.map(([key, count], index) => ({ key, index, value: count / total * 100,
    rounded: Math.floor(count / total * 100) }));
  let remaining = 100 - shares.reduce((sum, share) => sum + share.rounded, 0);
  for (const share of [...shares].sort((a, b) => (b.value - b.rounded) - (a.value - a.rounded) || a.index - b.index)) {
    if (remaining-- > 0) share.rounded++;
  }
  return Object.fromEntries(shares.map(({ key, rounded }) => [key, rounded]));
}

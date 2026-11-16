import { estimateMessagesTokens, trimTextToTokenBudget } from '../utils/context.js';
import { inputTokenBudget } from '../utils/token-usage.js';

export function providerContextMessage(block, maxTokens) {
  const heading = `[补充资料 ${JSON.stringify({ provider: block.providerId, source: block.source, truncated: block.truncated })}]\n`;
  const tag = block.trust === 'configured-skill' ? 'selected_skill' : 'reference_data';
  const wrapperCost = estimateMessagesTokens([{ role: 'user', content: `<${tag}>\n\n</${tag}>` }]);
  const content = maxTokens === undefined ? heading + block.content
    : trimTextToTokenBudget(heading + block.content, maxTokens - wrapperCost);
  return { role: 'user', content: content ? `<${tag}>\n${content}\n</${tag}>` : '' };
}

export function requiredContextReserve(blocks, required = []) {
  const ids = new Set(required);
  const necessary = (blocks || []).filter(block => ids.has(block.providerId));
  return necessary.length ? 64 + necessary.reduce((sum, block) => sum + estimateMessagesTokens([providerContextMessage(block)]), 0) : 0;
}

/** Optional data uses spare budget. Required data is reserved before history is
 * compressed/fitted, and is still checked here for complete inclusion. */
export function appendProviderContext(messages, blocks, contextWindow, maxTokens = 0, { required = [] } = {}) {
  const output = structuredClone(messages);
  let remaining = inputTokenBudget(contextWindow, maxTokens) - estimateMessagesTokens(output) - 64;
  const included = [];
  const requiredIds = new Set(required), includedIds = new Set();
  const budgetError = () => Object.assign(new Error('本轮选用的 Skill 或必需上下文无法完整放入模型容量，请缩短指南或问题，或换用更大上下文的模型。'), { code: 'ERR_CONTEXT_BUDGET' });
  const ordered = [...(blocks || [])].sort((a, b) => Number(requiredIds.has(b.providerId)) - Number(requiredIds.has(a.providerId)));
  for (const block of ordered) {
    const necessary = requiredIds.has(block.providerId);
    if (necessary && block.truncated) throw budgetError();
    if (remaining < 64) break;
    const message = providerContextMessage(block, necessary ? undefined : Math.min(remaining, 3000));
    if (!message.content) continue;
    const cost = estimateMessagesTokens([message]);
    if (cost > remaining) { if (necessary) throw budgetError(); else continue; }
    included.push(message);
    includedIds.add(block.providerId);
    remaining -= cost;
  }
  if ([...requiredIds].some(id => !includedIds.has(id))) throw budgetError();
  const lastUser = output.findLastIndex(message => message.role === 'user');
  output.splice(lastUser < 0 ? output.length : lastUser, 0, ...included);
  return output;
}

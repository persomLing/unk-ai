import { awaitWithAbort } from '../../../utils/abortable.js';
import { estimateRequestTokens, inputTokenBudget } from '../../../utils/token-usage.js';
import {
  createYingmiMcpClient,
  loadCachedMcpTools,
  loadFundModeConfig,
  saveCachedMcpTools,
} from './fund-mode-config.js';
import {
  canonicalToolKey,
  createFundToolCache,
  incrementDailyFundUsage,
  saveRemoteFundQuota,
} from './fund-tool-cache.js';
import {
  DISCOVER_TOOLS_NAME,
  discoverToolsSchema,
  extractSafeChartUrls,
  fundToolCacheTtl,
  fundToolLabel,
  selectCategoryMcpTools,
  selectCoreMcpTools,
  toOpenAiToolSchema,
  trimToolPayload,
} from './fund-tool-registry.js';
import { buildFundModeSystemPrompt } from './fund-mode-prompt.js';
import {
  computePortfolioMath,
  getFundSkill,
  inferFundSkillId,
  PORTFOLIO_MATH_TOOL_NAME,
  portfolioMathToolSchema,
  sanitizeFundToolArgs,
} from './fund-skills.js';

const MAX_TOOL_ROUNDS = 5;
const MAX_REMOTE_CALLS = 8;
const MAX_BATCH_CALLS = 10;
const MAX_BATCH_CONCURRENCY = 3;
const MAX_PROTOCOL_RETRIES = 5;
const TOOL_BUDGET_MS = 60000;
const SINGLE_TOOL_TIMEOUT_MS = 18000;
const DSML_ARTIFACT_RE = /<\/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*[^>]*>/gi;

const sharedFundCache = createFundToolCache();

export function clearSharedFundToolCache() {
  sharedFundCache.clear();
}

export function sharedFundToolCacheSize() {
  return sharedFundCache.size();
}

function hasSubstantiveContent(value) {
  if (typeof value !== 'string') return false;
  return value.replace(DSML_ARTIFACT_RE, '').trim().length > 0;
}

function joined(prefix, value) {
  return prefix && value ? `${prefix}\n\n${value}` : prefix || value || '';
}

function requestCost(messages, tools) {
  return estimateRequestTokens({ messages, tools }).used;
}

function budgetInstructions(remoteCallsUsed = 0, round = 0, exhausted = false) {
  return `本轮盈米 MCP 工具剩余预算：远程调用 ${Math.max(0, MAX_REMOTE_CALLS - remoteCallsUsed)} 次，工具轮 ${Math.max(0, MAX_TOOL_ROUNDS - round)} 轮。本地 discover_fund_tools 与命中缓存的重复调用不扣远程额度。`
    + (exhausted
      ? '本轮工具预算已结束，请基于已返回的数据完成结构化研报回答，明确标注数据缺口与未核实部分，绝不编造数字。'
      : '优先使用批量工具减少调用次数；数据足够时直接完成研报回答。');
}

export function fundContextReserve({ now = Date.now() } = {}) {
  const sampleMessages = [
    { role: 'system', content: buildFundModeSystemPrompt({ now, hasPageContext: true }) },
    { role: 'system', content: budgetInstructions() },
  ];
  // Reserve room for ~20 core tool schemas + system instructions.
  return estimateRequestTokens({ messages: sampleMessages, tools: [discoverToolsSchema()] }).used + 3600;
}

function fitFundToolContext(messages, tools, budget) {
  while (requestCost(messages, tools) > budget) {
    let largest = null;
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      if (typeof message.content === 'string' && message.content.length > 500
        && (!largest || message.content.length > largest.content.length)) {
        largest = message;
      }
    }
    if (!largest) {
      throw new Error('基金工具返回资料超过模型上下文容量，请精简问题或调大上下文窗口。');
    }
    try {
      const parsed = JSON.parse(largest.content);
      const nextLimit = Math.max(300, Math.floor(largest.content.length * 0.6));
      const trimmed = trimToolPayload(parsed.data ?? parsed, nextLimit);
      parsed.data = trimmed.data;
      parsed.truncated = true;
      largest.content = JSON.stringify(parsed);
    } catch {
      largest.content = `${largest.content.slice(0, Math.max(300, Math.floor(largest.content.length * 0.6)))}…[已截断]`;
    }
  }
}

function budgetResult(reason, remoteCallsUsed) {
  return {
    kind: 'budget',
    ok: false,
    executed: false,
    code: 'ERR_FUND_TOOL_LIMIT',
    reason,
    remaining: { remoteCalls: Math.max(0, MAX_REMOTE_CALLS - remoteCallsUsed) },
    notice: '本次远程工具未执行。本轮工具预算已结束，请依据已返回数据完成回答并注明未核实项。',
  };
}

function parseToolArgs(call) {
  const raw = call?.function?.arguments;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error(`工具 ${call?.function?.name || ''} 的参数不是有效 JSON。`);
  }
}

/**
 * Create a per-turn Fund Mode MCP tool session with Layer-1 core tools,
 * on-demand category discovery, LRU caching, and Beijing daily quota tracking.
 */
export async function createFundToolSession({
  config,
  client,
  cache = sharedFundCache,
  storage,
  transport,
  preloadCategories = [],
  signal,
  now = Date.now,
} = {}) {
  const resolvedConfig = config || await loadFundModeConfig(storage);
  const mcpClient = client || createYingmiMcpClient({
    endpoint: resolvedConfig.endpoint,
    apiKey: resolvedConfig.apiKey,
    transport,
  });

  let allTools = await loadCachedMcpTools(mcpClient.endpoint, { storage, now });
  if (!allTools || !allTools.length) {
    allTools = await mcpClient.listTools({ signal, timeoutMs: 20000 });
    await saveCachedMcpTools(mcpClient.endpoint, allTools, { storage, now });
  }

  const allByName = new Map(allTools.filter(tool => tool?.name).map(tool => [tool.name, tool]));
  const activeSchemas = new Map();
  for (const coreTool of selectCoreMcpTools(allTools)) {
    activeSchemas.set(coreTool.name, toOpenAiToolSchema(coreTool));
  }
  if (Array.isArray(preloadCategories) && preloadCategories.length) {
    for (const extraTool of selectCategoryMcpTools(allTools, preloadCategories)) {
      if (!activeSchemas.has(extraTool.name)) {
        activeSchemas.set(extraTool.name, toOpenAiToolSchema(extraTool));
      }
    }
  }
  const hasMoreTools = allTools.length > activeSchemas.size;

  function getTools() {
    const list = [...activeSchemas.values(), portfolioMathToolSchema()];
    if (hasMoreTools) list.push(discoverToolsSchema());
    return list;
  }

  function isAllowed(name) {
    return name === DISCOVER_TOOLS_NAME || name === PORTFOLIO_MATH_TOOL_NAME || activeSchemas.has(name);
  }

  function fingerprint(name, args) {
    const cleanArgs = name === DISCOVER_TOOLS_NAME || name === PORTFOLIO_MATH_TOOL_NAME
      ? args
      : sanitizeFundToolArgs(name, args);
    return canonicalToolKey(mcpClient.endpoint, name, cleanArgs);
  }

  function isCached(name, args) {
    if (name === DISCOVER_TOOLS_NAME || name === PORTFOLIO_MATH_TOOL_NAME) return true;
    const ttl = fundToolCacheTtl(name);
    if (ttl <= 0) return false;
    return cache.get(fingerprint(name, args)) !== null;
  }

  async function execute(name, args, { signal: callSignal } = {}) {
    if (name === PORTFOLIO_MATH_TOOL_NAME) {
      const outcome = computePortfolioMath(args || {});
      return {
        ok: outcome.ok === true,
        local: true,
        cached: true,
        toolName: PORTFOLIO_MATH_TOOL_NAME,
        label: fundToolLabel(PORTFOLIO_MATH_TOOL_NAME),
        durationMs: 0,
        charts: [],
        payload: outcome,
      };
    }

    if (name === DISCOVER_TOOLS_NAME) {
      const categories = Array.isArray(args?.categories) ? args.categories : [];
      const unlocked = selectCategoryMcpTools(allTools, categories);
      for (const tool of unlocked) {
        activeSchemas.set(tool.name, toOpenAiToolSchema(tool));
      }
      return {
        ok: true,
        local: true,
        cached: true,
        toolName: DISCOVER_TOOLS_NAME,
        label: fundToolLabel(DISCOVER_TOOLS_NAME),
        durationMs: 0,
        charts: [],
        payload: {
          ok: true,
          unlockedTools: unlocked.map(tool => ({
            name: tool.name,
            label: fundToolLabel(tool.name),
            description: String(tool.description || '').slice(0, 160),
          })),
          notice: unlocked.length
            ? '已将上述专项工具加载到本轮可用列表，下一轮可直接调用。'
            : '未匹配到新的专项工具，请检查分类名或使用现有工具。',
        },
      };
    }

    if (!allByName.has(name)) {
      throw new Error(`未找到盈米 MCP 工具：${name}`);
    }

    const sanitizedArgs = sanitizeFundToolArgs(name, args);
    const key = fingerprint(name, sanitizedArgs);
    const ttl = fundToolCacheTtl(name);
    const startedAt = now();

    if (ttl > 0) {
      const cached = cache.get(key);
      if (cached !== null) {
        return {
          ok: true,
          local: false,
          cached: true,
          toolName: name,
          label: fundToolLabel(name),
          durationMs: 0,
          charts: extractSafeChartUrls(cached.data, fundToolLabel(name)),
          payload: {
            ok: true,
            tool: name,
            cached: true,
            truncated: cached.truncated === true,
            data: cached.data,
          },
        };
      }
    }

    try {
      const raw = await mcpClient.callTool(name, sanitizedArgs, { signal: callSignal, timeoutMs: SINGLE_TOOL_TIMEOUT_MS });
      const durationMs = Math.max(0, now() - startedAt);
      if (mcpClient.lastQuota) void saveRemoteFundQuota(mcpClient.lastQuota, { storage, now });
      void incrementDailyFundUsage(1, { storage, now });

      if (raw.isError) {
        return {
          ok: false,
          local: false,
          cached: false,
          toolName: name,
          label: fundToolLabel(name),
          durationMs,
          charts: [],
          payload: {
            ok: false,
            tool: name,
            error: raw.text || '盈米 MCP 工具返回错误。',
          },
        };
      }

      const rawData = raw.structured !== null ? raw.structured : raw.text;
      const charts = extractSafeChartUrls(rawData, fundToolLabel(name));
      const trimmed = trimToolPayload(rawData);
      if (ttl > 0) {
        cache.set(key, { data: trimmed.data, truncated: trimmed.truncated }, ttl);
      }

      return {
        ok: true,
        local: false,
        cached: false,
        toolName: name,
        label: fundToolLabel(name),
        durationMs,
        charts,
        payload: {
          ok: true,
          tool: name,
          cached: false,
          truncated: trimmed.truncated,
          data: trimmed.data,
        },
      };
    } catch (error) {
      if (error?.name === 'AbortError' || callSignal?.aborted) throw error;
      if (error?.code === 'MCP_AUTH_ERROR' || error?.code === 'MCP_RATE_LIMIT') throw error;
      const durationMs = Math.max(0, now() - startedAt);
      return {
        ok: false,
        local: false,
        cached: false,
        toolName: name,
        label: fundToolLabel(name),
        durationMs,
        charts: [],
        payload: {
          ok: false,
          tool: name,
          code: error?.code || 'MCP_TOOL_ERROR',
          error: error?.message || '盈米 MCP 工具调用失败。',
        },
      };
    }
  }

  return Object.freeze({
    endpoint: mcpClient.endpoint,
    totalToolCount: allTools.length,
    getTools,
    isAllowed,
    fingerprint,
    isCached,
    execute,
    dispose() {},
  });
}

/**
 * Bounded Fund Research Mode tool loop.
 * Streams through the original ChatService/TurnRunner callbacks and never commits terminal state.
 */
export async function runFundResearchAnswer({
  connection,
  run,
  messages,
  createSession = createFundToolSession,
  hasPageContext = false,
  skillId = '',
  question = '',
  contextWindow,
  maxTokens = 0,
  now = Date.now,
  onDelta,
  onReasoning,
  onFundMeta,
  onToolStart,
} = {}) {
  run.assertCurrent();
  const toolController = new AbortController();
  const cancel = () => toolController.abort(run.signal.reason);
  run.signal.addEventListener('abort', cancel, { once: true });

  const resolvedSkillId = skillId || inferFundSkillId(question);
  const resolvedSkill = getFundSkill(resolvedSkillId);
  run.phase('web-research', resolvedSkill ? `正在准备「${resolvedSkill.name}」工具…` : '正在连接盈米基金 MCP…');
  let session;
  try {
    session = await awaitWithAbort(createSession({
      signal: toolController.signal,
      now,
      preloadCategories: resolvedSkill?.preloadCategories || [],
    }), run.signal);
  } catch (error) {
    run.signal.removeEventListener('abort', cancel);
    throw error;
  }

  const history = structuredClone(messages);
  const systemPrompt = buildFundModeSystemPrompt({ now: now(), hasPageContext, skillId: resolvedSkillId });
  const budgetStatus = { role: 'system', content: '' };
  history.splice(history.findLastIndex(message => message.role === 'system') + 1, 0,
    { role: 'system', content: systemPrompt },
    budgetStatus);

  const budget = inputTokenBudget(contextWindow, maxTokens);
  let content = '';
  let reasoning = '';
  let remoteCallsUsed = 0;
  let remainingToolMs = TOOL_BUDGET_MS;
  let forceFinal = false;
  let protocolRetries = 0;
  const fundSources = [];
  const fundCharts = [];
  const seenCharts = new Set();
  const roundResults = new Map();

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      run.assertCurrent();
      const available = session.getTools();
      const exhausted = forceFinal || round === MAX_TOOL_ROUNDS || remoteCallsUsed >= MAX_REMOTE_CALLS || remainingToolMs <= 0 || !available.length;
      const tools = exhausted ? [] : available;
      budgetStatus.content = budgetInstructions(remoteCallsUsed, round, exhausted);
      fitFundToolContext(history, tools, budget);

      run.phase('waiting-model');
      const prefix = content;
      const reasoningPrefix = reasoning;
      let result;
      for (let attempt = 0; ; attempt++) {
        run.assertCurrent();
        const requestId = attempt === 0 ? `fund-answer-${round}` : `fund-answer-${round}-retry-${attempt}`;
        const retryForceFinal = attempt > 0 && (exhausted || fundSources.length > 0);
        const attemptTools = retryForceFinal ? [] : tools;
        if (retryForceFinal) {
          budgetStatus.content = budgetInstructions(remoteCallsUsed, round, true);
          fitFundToolContext(history, attemptTools, budget);
        }
        result = await awaitWithAbort(connection.request({
          requestId,
          purpose: 'answer',
          messages: history,
          tools: attemptTools,
          toolChoice: (exhausted || retryForceFinal) ? 'none' : 'auto',
          timeoutMs: 120000,
          onDelta: (delta, full) => { run.assertCurrent(); onDelta?.(delta, joined(prefix, full)); },
          onReasoning: (delta, full) => { run.assertCurrent(); onReasoning?.(delta, joined(reasoningPrefix, full)); },
        }), run.signal);
        run.assertCurrent();
        if (!result || typeof result.content !== 'string' || !Array.isArray(result.toolCalls)) {
          throw new Error('当前模型服务不支持流式工具调用（tool_calls），无法在基金模式下调用盈米 MCP。');
        }
        const calls = result.toolCalls;
        const protocolInvalid = calls.length > 0 && (exhausted || retryForceFinal || calls.length > MAX_BATCH_CALLS || result.finishReason !== 'tool_calls');
        if (!protocolInvalid) break;
        if (hasSubstantiveContent(result.content) || protocolRetries >= MAX_PROTOCOL_RETRIES || run.deadlineAt - now() <= 5000) {
          throw new Error('模型在基金数据收尾时仍请求工具或响应异常中断，请重试。');
        }
        protocolRetries++;
        if (result.content) onDelta?.('', prefix);
        if (result.reasoning) onReasoning?.('', reasoningPrefix);
        run.phase('waiting-model');
      }

      content = joined(prefix, result.content);
      reasoning = joined(reasoningPrefix, result.reasoning);
      const calls = result.toolCalls;
      if (!calls.length) {
        if (!result.content.trim()) throw new Error('模型返回了空回答，请重试。');
        return { content, reasoning, sources: [], fundSources, fundCharts, fundSkillId: resolvedSkillId };
      }

      const ids = new Set();
      const validated = calls.map(call => {
        const name = call?.function?.name;
        if (!call?.id || ids.has(call.id) || !session.isAllowed(name)) {
          throw new Error(`模型请求了未开放的基金工具：${name || '未知'}`);
        }
        ids.add(call.id);
        const args = parseToolArgs(call);
        return {
          call,
          name,
          args,
          fingerprint: session.fingerprint(name, args),
          budgetReason: '',
        };
      });

      let plannedRemote = remoteCallsUsed;
      const plannedFingerprints = new Set(roundResults.keys());
      for (const entry of validated) {
        const isFree = entry.name === DISCOVER_TOOLS_NAME
          || entry.name === PORTFOLIO_MATH_TOOL_NAME
          || plannedFingerprints.has(entry.fingerprint)
          || session.isCached(entry.name, entry.args);
        if (isFree) continue;
        if (plannedRemote >= MAX_REMOTE_CALLS) {
          entry.budgetReason = 'call-limit';
          forceFinal = true;
          continue;
        }
        plannedFingerprints.add(entry.fingerprint);
        plannedRemote++;
      }

      history.push({
        role: 'assistant',
        content: result.message?.content ?? result.content,
        ...(typeof result.message?.reasoning_content === 'string' ? { reasoning_content: result.message.reasoning_content } : {}),
        tool_calls: structuredClone(calls),
      });

      const executable = validated.filter(entry => !entry.budgetReason);
      if (executable.length) {
        onToolStart?.();
        const progressLabel = executable.length === 1
          ? `正在${fundToolLabel(executable[0].name)}…`
          : `正在${fundToolLabel(executable[0].name)}等 ${executable.length} 项查询…`;
        run.phase('web-research', progressLabel);
      }

      for (let index = 0; index < validated.length; index += MAX_BATCH_CONCURRENCY) {
        run.assertCurrent();
        const batch = validated.slice(index, index + MAX_BATCH_CONCURRENCY);
        if (remainingToolMs <= 0) {
          for (const entry of batch) {
            if (!entry.budgetReason && entry.name !== DISCOVER_TOOLS_NAME) entry.budgetReason = 'time-limit';
          }
          forceFinal = true;
        }
        const startedAt = now();
        const timer = batch.some(entry => !entry.budgetReason)
          ? setTimeout(
            () => toolController.abort(new DOMException('本轮基金数据查询已超过时间预算。', 'TimeoutError')),
            Math.max(1, Math.min(remainingToolMs, run.deadlineAt - now())),
          )
          : null;

        let batchResults;
        try {
          batchResults = await awaitWithAbort(Promise.all(batch.map(async entry => {
            run.assertCurrent();
            if (entry.budgetReason) return null;
            if (roundResults.has(entry.fingerprint)) {
              return roundResults.get(entry.fingerprint);
            }
            const outcome = await session.execute(entry.name, entry.args, { signal: toolController.signal });
            if (!outcome.local && !outcome.cached) {
              remoteCallsUsed++;
            }
            if (outcome.ok && !outcome.local) {
              roundResults.set(entry.fingerprint, { ...outcome, cached: true, durationMs: 0 });
            }
            return outcome;
          })), toolController.signal);
        } finally {
          if (timer !== null) clearTimeout(timer);
          remainingToolMs -= Math.max(0, now() - startedAt);
        }

        run.assertCurrent();
        for (let offset = 0; offset < batch.length; offset++) {
          const entry = batch[offset];
          const outcome = batchResults[offset];
          if (entry.budgetReason || !outcome) {
            history.push({
              role: 'tool',
              tool_call_id: entry.call.id,
              content: JSON.stringify(budgetResult(entry.budgetReason || 'time-limit', remoteCallsUsed)),
            });
            continue;
          }
          history.push({
            role: 'tool',
            tool_call_id: entry.call.id,
            content: JSON.stringify(outcome.payload),
          });
          if (!outcome.local) {
            fundSources.push({
              tool: outcome.toolName,
              label: outcome.label,
              cached: outcome.cached === true,
              ok: outcome.ok === true,
              durationMs: outcome.durationMs,
            });
            for (const chart of outcome.charts || []) {
              if (!seenCharts.has(chart.url)) {
                seenCharts.add(chart.url);
                fundCharts.push(chart);
              }
            }
          }
        }
        if (fundSources.length || fundCharts.length) {
          onFundMeta?.({ fundSources: [...fundSources], fundCharts: [...fundCharts], fundSkillId: resolvedSkillId });
        }
      }
    }
    throw new Error('基金研究工具循环未返回完整回答，请重试。');
  } finally {
    session.dispose();
    run.signal.removeEventListener('abort', cancel);
  }
}

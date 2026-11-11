import { estimateMessagesTokens, fitMessagesToBudget, requestMessagesFor, trimTextToTokenBudget } from '../utils/context.js';
import { pageSourceFor, sourceMatchesPage } from '../utils/turn-source.js';
import { pageForResearchScope, readSourcesForPage } from '../utils/research-context.js';
import { suggestionMessages, parseSuggestionResponse } from '../sidepanel/features/messages/model-suggestions.js';
import { samePrompt } from '../sidepanel/features/messages/retry-flow.js';
import { runResearchAnswer } from '../sidepanel/features/web-research/research-answer-loop.js';

/** Optional provider data uses only spare budget, never displaces the question,
 * page evidence or system rules, and enters as clearly delimited user data. */
export function appendProviderContext(messages, blocks, contextWindow, maxTokens = 0) {
  const output = structuredClone(messages);
  let remaining = Math.floor(contextWindow * 0.97) - Number(maxTokens || 0) - estimateMessagesTokens(output) - 64;
  const included = [];
  for (const block of blocks || []) {
    if (remaining < 64) break;
    const heading = `[补充资料 ${JSON.stringify({ provider: block.providerId, source: block.source, truncated: block.truncated })}]\n`;
    const wrapperCost = estimateMessagesTokens([{ role: 'user', content: '<reference_data>\n\n</reference_data>' }]);
    const content = trimTextToTokenBudget(heading + block.content, Math.min(remaining - wrapperCost, 3000));
    if (!content) continue;
    const message = { role: 'user', content: `<reference_data>\n${content}\n</reference_data>` };
    const cost = estimateMessagesTokens([message]);
    if (cost > remaining) continue;
    included.push(message);
    remaining -= cost;
  }
  const lastUser = output.findLastIndex(message => message.role === 'user');
  output.splice(lastUser < 0 ? output.length : lastUser, 0, ...included);
  return output;
}

function friendlyError(error) {
  if (error?.name === 'AbortError') return error;
  if (error instanceof TypeError && /fetch/i.test(error.message)) return new Error('无法连接模型服务，请检查网络、Endpoint 与服务状态。');
  return error;
}

/** Executes a prepared chat turn. Presentation is a subscriber of TurnRunner;
 * this service never reads current UI state or owns an assistant DOM element. */
export function createChatService({ repository, runner, modelGateway, contextAssembler,
  researchTools = null,
  compress = async () => {}, now = Date.now, setInterval: every = globalThis.setInterval,
  clearInterval: clearEvery = globalThis.clearInterval } = {}) {
  const effects = new Set();
  const generations = new WeakMap();
  let disposed = false;

  async function suggest(ref, profile, answer) {
    const target = repository.get(ref);
    if (!target || target.assistant.status !== 'complete') return;
    if (disposed) return;
    let effect;
    try {
      effect = modelGateway.createRun({ runId: `${ref.runId}:suggestions`, profile,
        diagnosticContext: { conversationId: ref.conversationId, turnId: ref.turnId } });
      effects.add(effect);
      const question = target.user.displayContent || target.user.content || '';
      const raw = await effect.request({ requestId: 'suggestions', purpose: 'suggestions', timeoutMs: 12000,
        messages: suggestionMessages({ question, answer, sources: target.assistant.sources,
          page: target.user.pageContextEnabled === false ? null : target.user.pageSource || null }) });
      if (disposed) return;
      const current = repository.get(ref);
      if (!current || current.assistant.status !== 'complete' || current.assistant.content !== answer) return;
      const suggestions = parseSuggestionResponse(raw, { question, answer, requireGrounding: true }).filter(value => !samePrompt(value, question));
      if (suggestions.length && repository.decorate(ref, { suggestions })) repository.schedule(ref);
    } catch { /* Optional post-turn work does not change the answer's outcome. */ }
    finally { effect?.dispose(); effects.delete(effect); }
  }

  function generate(options) {
    const { assistant, run: suppliedRun } = options;
    const run = suppliedRun || runner.begin({ commandId: assistant.id });
    // Idempotency wraps preparation and post-turn effects as well as transport.
    // A second delivery must not clear partial output or repeat suggestions.
    if (generations.has(run)) return generations.get(run);
    const pending = Promise.resolve().then(() => executeGeneration({ ...options, run }));
    generations.set(run, pending);
    return pending;
  }

  async function executeGeneration({ conversation, assistant, profile, contextWindow, run, modelRun, favicon = '' }) {
    let connection, timer = null;
    try {
      if (disposed) { run.cancel(); return null; }
      run.assertCurrent();
      const index = conversation.messages.findIndex(message => message.id === assistant.id);
      const user = conversation.messages.slice(0, index).findLast(message => message.role === 'user');
      if (!user) { run.fail(new Error('找不到本轮提问。')); return null; }
      if (!run.ref) run.bind({ conversation, user, assistant });
      const ref = run.ref;
      if (!profile) { run.fail(new Error('请先在设置中添加至少一个模型。')); return null; }
      const fixedProfile = structuredClone(profile);
      const researchEnabled = typeof researchTools === 'function' && fixedProfile.webSearchEnabled !== false;
      const requestPage = user.pageContextEnabled === false
        || (user.pageSource && !sourceMatchesPage(user.pageSource, conversation.pageContext))
        ? null : structuredClone(pageForResearchScope(conversation.pageContext, user.readingPolicy ?? user.researchEnabled));
      const question = user.displayContent || user.content || '';
      connection = modelRun || modelGateway.createRun({ runId: run.runId, profile: fixedProfile, signal: run.signal, deadlineAt: run.deadlineAt });
      let reasoningStartedAt = 0, reasoningFinishedAt = 0, reasoning = '';
      let reasoningElapsedMs = 0, reasoningSegmentAt = null;
      const duration = () => reasoningStartedAt ? Math.max(1, Math.round((reasoningElapsedMs
        + (reasoningSegmentAt === null ? 0 : now() - reasoningSegmentAt)) / 1000)) : 0;
      const pauseReasoning = () => {
        if (reasoningSegmentAt === null) return;
        reasoningElapsedMs += Math.max(0, now() - reasoningSegmentAt);
        reasoningSegmentAt = null;
        reasoningFinishedAt = now();
      };
      run.update({ content: '', reasoning: '', reasoningSeconds: 0, reasoningStartedAt: undefined,
        reasoningFinishedAt: undefined, model: fixedProfile.model, modelId: fixedProfile.model, reasoningEffort: fixedProfile.reasoningEffort });
      const result = await run.execute(async () => {
        run.phase('compressing');
        await compress(conversation, assistant.id, { signal: run.signal, profile: fixedProfile, modelRun: connection });
        run.assertCurrent();
        // Optional providers must leave room for tool schemas and the loop's
        // own instructions instead of making a previously valid answer fail.
        const requestReserve = Number(fixedProfile.maxTokens || 0) + (researchEnabled ? 1200 : 0);
        let messages = fitMessagesToBudget(conversation, requestMessagesFor(conversation, assistant.id, requestPage), contextWindow, requestReserve);
        if (contextAssembler) {
          run.phase('collecting-context');
          const collected = await contextAssembler.collect({ question,
            selection: user.selection || null, attachments: user.attachments || [] }, {
            ...ref, signal: run.signal, deadlineAt: run.deadlineAt, mode: 'chat',
            model: connection.modelInfo, target: pageSourceFor(requestPage),
            budget: { contextWindow, maxTokens: fixedProfile.maxTokens || 0 },
          });
          run.assertCurrent();
          messages = appendProviderContext(messages, collected.blocks, contextWindow, requestReserve);
          if (collected.issues.length) run.update({ contextIssues: collected.issues.map(issue => ({ providerId: issue.providerId || issue.id, code: issue.code })) });
        }
        run.phase('waiting-model');
        timer = every(() => {
          if (reasoningSegmentAt !== null) run.update({ reasoningSeconds: duration() });
        }, 1000);
        const callbacks = {
          onDelta: (_delta, full) => {
            if (!full) return;
            pauseReasoning();
            run.phase('answering');
            if (run.update({ content: full, reasoningFinishedAt: reasoningFinishedAt || undefined, reasoningSeconds: duration() })) repository.schedule(ref);
          },
          onReasoning: (_delta, full) => {
            reasoning = full;
            if (full && !reasoningStartedAt) reasoningStartedAt = now();
            if (full && reasoningSegmentAt === null) { reasoningSegmentAt = now(); reasoningFinishedAt = 0; }
            run.phase('reasoning');
            if (run.update({ reasoning: full, reasoningStartedAt: reasoningStartedAt || undefined,
              reasoningFinishedAt: reasoningFinishedAt || undefined, reasoningSeconds: duration() })) repository.schedule(ref);
          },
        };
        const pageSources = readSourcesForPage(requestPage, favicon);
        const result = researchEnabled
          ? await runResearchAnswer({ connection, run, messages, createTools: researchTools, contextWindow,
            maxTokens: fixedProfile.maxTokens, fetchEnabled: fixedProfile.webFetchEnabled !== false, now, ...callbacks,
            onToolStart: () => { pauseReasoning(); run.update({ reasoningFinishedAt: reasoningFinishedAt || undefined, reasoningSeconds: duration() }); },
            onSources: values => {
              run.assertCurrent();
              if (run.update({ sources: [...pageSources, ...values] })) repository.schedule(ref);
            } })
          : { content: await connection.request({ requestId: 'answer', purpose: 'answer', messages, timeoutMs: 120000, ...callbacks }), sources: [] };
        run.assertCurrent();
        pauseReasoning();
        const sources = [...pageSources, ...result.sources];
        if (requestPage && conversation.repository?.url === requestPage.url && !sources.some(source => source.url === requestPage.url)) {
          const repo = conversation.repository;
          sources.push({ title: `${repo.owner}/${repo.name}`, url: repo.url, domain: 'github.com', favicon: 'https://github.githubassets.com/favicons/favicon.svg' });
        }
        return { content: result.content, reasoning, reasoningSeconds: duration(), sources, pageSource: pageSourceFor(requestPage) };
      });
      if (run.status === 'completed' && result?.content) void suggest(ref, fixedProfile, result.content);
      return result;
    } catch (error) { run.fail(friendlyError(error)); return null; }
    finally { clearEvery(timer); if (!modelRun) connection?.dispose(); }
  }

  return Object.freeze({ generate, dispose() { disposed = true; for (const effect of effects) effect.dispose(); effects.clear(); } });
}

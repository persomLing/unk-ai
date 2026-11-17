import { fitMessagesToBudget, requestMessagesFor } from '../utils/context.js';
import { pageSourceFor, sourceMatchesPage } from '../utils/turn-source.js';
import { pageForResearchScope, readSourcesForPage } from '../utils/research-context.js';
import { suggestionMessages, parseSuggestionResponse } from '../sidepanel/features/messages/model-suggestions.js';
import { samePrompt } from '../sidepanel/features/messages/retry-flow.js';
import { runResearchAnswer, researchContextReserve } from '../sidepanel/features/web-research/research-answer-loop.js';
import { hasSelectedSkill, selectedSkill, SKILL_PROVIDER_ID } from '../sidepanel/features/skills/skill-context.js';
import { appendProviderContext, requiredContextReserve } from './context-request.js';
import { awaitWithAbort } from '../utils/abortable.js';
import { ContextProviderError } from './context-assembler.js';
export { appendProviderContext } from './context-request.js';

function friendlyError(error) {
  if (error?.name === 'AbortError') return error;
  if (error instanceof TypeError && /fetch/i.test(error.message)) return new Error('无法连接模型服务，请检查网络、Endpoint 与服务状态。');
  return error;
}

/** Executes a prepared chat turn. Presentation is a subscriber of TurnRunner;
 * this service never reads current UI state or owns an assistant DOM element. */
export function createChatService({ repository, runner, modelGateway, contextAssembler,
  researchTools = null,
  replyPolicyFor = () => ({}),
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

  async function executeGeneration({ conversation, assistant, profile, contextWindow, run, modelRun,
    favicon = '', assertOwner = () => {} }) {
    let connection, timer = null;
    try {
      if (disposed) { run.cancel(); return null; }
      run.assertCurrent();
      const index = conversation.messages.findIndex(message => message.id === assistant.id);
      const user = conversation.messages.slice(0, index).findLast(message => message.role === 'user');
      if (!user) { run.fail(new Error('找不到本轮提问。')); return null; }
      if (!run.ref) run.bind({ conversation, user, assistant });
      selectedSkill(user.attachments);
      const submittedUser = structuredClone(user);
      const policy = replyPolicyFor(submittedUser);
      const formatContent = policy.formatContent || (content => content);
      const requiredContext = [...new Set([...(hasSelectedSkill(user.attachments) ? [SKILL_PROVIDER_ID] : []), ...(policy.requiredContext || [])])];
      if (requiredContext.length && !contextAssembler) throw new Error('本轮 Skill 或必需上下文能力未装配，无法执行所选任务。');
      const ref = run.ref;
      const assertCurrent = () => {
        run.assertCurrent();
        assertOwner();
        if (disposed || !repository.get(ref)) throw new DOMException('本轮消息已被替换或运行环境已关闭。', 'AbortError');
      };
      if (!profile) { run.fail(new Error('请先在设置中添加至少一个模型。')); return null; }
      const fixedProfile = structuredClone(profile);
      const researchEnabled = policy.research !== false && typeof researchTools === 'function' && fixedProfile.webSearchEnabled !== false;
      const requestPage = policy.isolated || user.pageContextEnabled === false
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
        reasoningFinishedAt: undefined, model: fixedProfile.model, modelId: fixedProfile.model, reasoningEffort: fixedProfile.reasoningEffort,
        ...policy.assistantFields });
      const result = await run.execute(async () => {
        assertCurrent();
        const requestReserve = Number(fixedProfile.maxTokens || 0)
          + (researchEnabled ? researchContextReserve({ fetchEnabled: fixedProfile.webFetchEnabled !== false, now: now() }) : 0);
        const requestConversation = policy.isolated ? { messages: [submittedUser, assistant] } : conversation;
        let contextInput = { question, selection: submittedUser.selection || null, attachments: submittedUser.attachments || [] };
        if (policy.prepareContext) {
          // Registration failures must precede any auxiliary model work.
          for (const id of requiredContext) {
            try {
              const status = contextAssembler.status?.(id);
              if (status?.status === 'disabled' || status?.status === 'failed') throw new Error(status.error?.message || '能力已停用');
            } catch (error) { throw new ContextProviderError(id, new Error('未注册或无法使用该能力', { cause: error })); }
          }
          run.phase('collecting-context');
          const prepared = await awaitWithAbort(Promise.resolve().then(() => {
            assertCurrent();
            return policy.prepareContext({ input: structuredClone(contextInput),
              // Reserve the real current question and wrappers; history can be
              // compressed after required data has been prepared.
              messages: requestMessagesFor({ messages: [submittedUser, assistant] }, assistant.id, requestPage),
              contextWindow, maxTokens: requestReserve, signal: run.signal, assertCurrent,
              requestText: async ({ requestId, messages, maxTokens }) => {
                assertCurrent();
                const raw = await connection.request({ requestId, messages, maxTokens,
                  purpose: 'video-summary', timeoutMs: 60000, temperature: 0 });
                assertCurrent();
                return raw;
              } });
          }), run.signal);
          assertCurrent();
          contextInput = { ...contextInput, ...prepared };
        }
        let collected = { blocks: [], issues: [] };
        if (contextAssembler) {
          run.phase('collecting-context');
          collected = await contextAssembler.collect(contextInput, {
            ...ref, signal: run.signal, deadlineAt: run.deadlineAt, mode: 'chat',
            model: connection.modelInfo, target: pageSourceFor(requestPage),
            budget: { contextWindow, maxTokens: fixedProfile.maxTokens || 0 },
          }, { required: requiredContext, ...(policy.contextMaxChars === undefined ? {} : { maxChars: policy.contextMaxChars }) });
          assertCurrent();
          if (collected.issues.length) run.update({ contextIssues: collected.issues.map(issue => ({ providerId: issue.providerId || issue.id, code: issue.code })) });
        }
        // Required provider data is known before compression. Reserve it along
        // with the real tool definitions/instructions and configured output.
        const baseReserve = requestReserve + requiredContextReserve(collected.blocks, requiredContext);
        if (!policy.isolated) {
          run.phase('compressing');
          await compress(conversation, assistant.id, { signal: run.signal, profile: fixedProfile, modelRun: connection,
            reserveTokens: baseReserve, contextWindow, page: requestPage });
        }
        assertCurrent();
        let messages = fitMessagesToBudget(requestConversation, requestMessagesFor(requestConversation, assistant.id, requestPage), contextWindow, baseReserve);
        messages = appendProviderContext(messages, collected.blocks, contextWindow, requestReserve, { required: requiredContext });
        run.phase('waiting-model');
        timer = every(() => {
          if (reasoningSegmentAt !== null) run.update({ reasoningSeconds: duration() });
        }, 1000);
        const callbacks = {
          onDelta: (_delta, full) => {
            if (!full) return;
            pauseReasoning();
            run.phase('answering');
            if (run.update({ content: formatContent(full), reasoningFinishedAt: reasoningFinishedAt || undefined, reasoningSeconds: duration() })) repository.schedule(ref);
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
        const pageSources = [...(policy.sources || []), ...readSourcesForPage(requestPage, favicon)];
        assertCurrent();
        const result = researchEnabled
          ? await runResearchAnswer({ connection, run, messages, createTools: researchTools, contextWindow,
            maxTokens: fixedProfile.maxTokens, fetchEnabled: fixedProfile.webFetchEnabled !== false, now, ...callbacks,
            onToolStart: () => { pauseReasoning(); run.update({ reasoningFinishedAt: reasoningFinishedAt || undefined, reasoningSeconds: duration() }); },
            onSources: values => {
              run.assertCurrent();
              if (run.update({ sources: [...pageSources, ...values] })) repository.schedule(ref);
            } })
          : { content: await connection.request({ requestId: 'answer', purpose: 'answer', messages, timeoutMs: 120000, ...callbacks }), sources: [] };
        assertCurrent();
        pauseReasoning();
        const sources = [...pageSources, ...result.sources];
        if (requestPage && conversation.repository?.url === requestPage.url && !sources.some(source => source.url === requestPage.url)) {
          const repo = conversation.repository;
          sources.push({ title: `${repo.owner}/${repo.name}`, url: repo.url, domain: 'github.com', favicon: 'https://github.githubassets.com/favicons/favicon.svg' });
        }
        return { content: formatContent(result.content), reasoning, reasoningSeconds: duration(), sources,
          pageSource: pageSourceFor(requestPage), ...policy.assistantFields, ...policy.completionFields };
      });
      if (policy.suggestions !== false && run.status === 'completed' && result?.content) void suggest(ref, fixedProfile, result.content);
      return result;
    } catch (error) { run.fail(friendlyError(error)); return null; }
    finally { clearEvery(timer); if (!modelRun) connection?.dispose(); }
  }

  return Object.freeze({ generate, dispose() { disposed = true; for (const effect of effects) effect.dispose(); effects.clear(); } });
}

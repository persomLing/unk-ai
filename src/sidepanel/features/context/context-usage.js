import { contextUsageFor, contextWindowFor } from '../../../utils/context.js';
import { messageWithSelection } from '../../../utils/selection.js';
import { readingPolicyForTurn } from '../../../utils/reading-plan.js';
import { pageSourceFor, sourceMatchesPage } from '../../../utils/turn-source.js';
import { providerContextMessage } from '../../../app/context-request.js';
import { createSkillContextProvider } from '../skills/skill-context.js';
import { createVideoContextProvider } from '../video-notes/transcript-context.js';
import { initialResearchContext } from '../web-research/research-answer-loop.js';

const previewProviders = [createSkillContextProvider(), createVideoContextProvider()];

/** Read-only forecast of a normal submission. It never fetches a page, invokes
 * arbitrary providers or changes saved messages. Only the built-in, pure
 * attachment serializers run here; the actual request is measured separately. */
export function estimateDraftContext({ conversation = { messages: [] }, beforeAssistantId,
  draft = '', attachments = [], selection = null, page = null, target = null,
  pageEnabled = false, independent = false, profile = {}, config, now = Date.now() } = {}) {
  const readingPolicy = readingPolicyForTurn({ question: draft, pageContextEnabled: pageEnabled,
    directModelRequest: independent, selection: independent ? null : selection, attachments, mode: 'chat', pageTitle: target?.title });
  const canUsePage = pageEnabled && !independent && readingPolicy.scope !== 'none';
  const sameTarget = Boolean(target?.url && sourceMatchesPage(target, page)
    && (!(target.tabId ?? target.id) || (target.tabId ?? target.id) === page?.tabId));
  const requestPage = canUsePage && sameTarget ? page : null;
  const selected = independent ? null : selection;
  const pendingUser = { role: 'user', content: messageWithSelection(draft, selected), displayContent: draft,
    attachments: attachments.slice(0, 6), selection: selected, includeVisual: profile.supportsVision === true,
    pageContextEnabled: Boolean(requestPage), pageSource: pageSourceFor(requestPage), readingPolicy };
  const extraMessages = [];
  let incomplete = false;
  for (const provider of previewProviders) {
    try {
      for (const block of provider.collect({ attachments: pendingUser.attachments }, { mode: 'chat' })) {
        // These built-ins already validate their sizes and source fields. Match
        // the assembler's omission of empty optional provenance fields.
        const source = Object.fromEntries(Object.entries(block.source).filter(([, value]) => Boolean(value)));
        extraMessages.push(providerContextMessage({ ...block, source, providerId: provider.id, trust: provider.trust, truncated: false }));
      }
    } catch { incomplete = true; } // An invalid draft is labelled, never submitted here.
  }
  const research = profile.webSearchEnabled === false ? { tools: [], messages: [] }
    : initialResearchContext({ fetchEnabled: profile.webFetchEnabled !== false, now });
  const usage = contextUsageFor(conversation || { messages: [] }, beforeAssistantId, requestPage,
    contextWindowFor(profile, config), { pendingUser, extraMessages: [...extraMessages, ...research.messages],
      tools: research.tools, maxTokens: profile.maxTokens });
  // Do not retain prompt bodies in the meter's state.
  delete usage.messages;
  return { ...usage, scope: 'preview', modelName: profile.name || profile.model || '',
    pendingContext: incomplete || (canUsePage && !requestPage) || Boolean(selected?.visuals?.length) };
}

/** Ephemeral numeric snapshots, bound to the exact answer run. Auxiliary model
 * requests and late events can never replace this meter. Nothing is persisted. */
export function createContextUsageTracker({ getActiveRun, onChange = () => {}, limit = 30 } = {}) {
  const snapshots = new Map();
  let disposed = false;
  return Object.freeze({
    observe(event) {
      if (disposed || event?.type !== 'model.request.started' || event.purpose !== 'answer' || !event.inputUsage) return false;
      const run = getActiveRun();
      if (!run?.ref || run.runId !== event.runId || run.signal?.aborted) return false;
      try { run.assertCurrent(); } catch { return false; }
      const { conversationId, assistantId, turnId } = run.ref;
      const snapshot = { conversationId, assistantId, turnId, runId: run.runId, requestId: event.requestId,
        usage: structuredClone(event.inputUsage), at: event.at };
      snapshots.delete(conversationId);
      snapshots.set(conversationId, snapshot);
      while (snapshots.size > limit) snapshots.delete(snapshots.keys().next().value);
      try { onChange(conversationId); } catch { /* Presentation never blocks a request. */ }
      return true;
    },
    get(conversation) {
      const snapshot = snapshots.get(conversation?.id);
      if (!snapshot) return null;
      const message = conversation?.messages?.find(item => item.id === snapshot?.assistantId && item.runId === snapshot?.runId);
      if (!message || message.role !== 'assistant') return null;
      return { ...structuredClone(snapshot.usage), scope: 'request', modelName: message.modelId || message.model || '',
        requestId: snapshot.requestId, assistantId: snapshot.assistantId };
    },
    dispose() { disposed = true; snapshots.clear(); },
  });
}

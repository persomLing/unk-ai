import { createTurnRunner } from '../../app/turn-runner.js';
import { createConversationRepository } from '../../app/conversation-repository.js';
import { createConversationService } from '../../app/conversation-service.js';
import { createChatService } from '../../app/chat-service.js';
import { createContextService } from '../../app/context-service.js';
import { createContextAssembler } from '../../app/context-assembler.js';
import { createModelGateway } from '../../app/model-gateway.js';
import { createApplicationDiagnostics } from '../../utils/diagnostic-observer.js';
import { readSourcesForPage } from '../../utils/research-context.js';
import { createResearchToolSession } from '../features/web-research/research-tools.js';
import { createPublicResearchTransport } from '../features/web-research/public-research-transport.js';
import { createSkillContextProvider } from '../features/skills/skill-context.js';
import { createVideoContextProvider } from '../features/video-notes/transcript-context.js';
import { createVideoNotesCommand } from '../features/video-notes/video-notes-command.js';
import { readVideoTranscript as readTranscriptFromPort } from '../features/video-notes/video-reading-client.js';
import { captureVideoStill, scanVideoPage } from '../features/video-notes/video-scan-client.js';
import { createImageIllustration } from '../features/illustration/image-illustration.js';
import { createVideoIllustration } from '../features/video-notes/video-illustration.js';
import { settleInterruptedIllustrations } from '../features/illustration/illustration-lifecycle.js';
import { createImageReply } from '../features/illustration/image-reply.js';
import { directImageForMessage } from '../../utils/image-generation-command.js';

export function readingDiagnosticEvidence(page) {
  return { hasPageContext: Boolean(page?.text?.trim()), textChars: page?.text?.length || 0,
    sourceCount: readSourcesForPage(page).length,
    truncated: Boolean(page?.truncated || page?.networkReading?.truncated || page?.structure?.research?.truncated),
    cached: page?.networkReading?.status === 'reused' };
}
/** Core application wiring. New context providers are registered here through
 * descriptors; they never need to change submit/retry or the model stream. */
export function createSidepanelApplication({ state, conversationSaver, browser, agentSlot,
  modelGateway = createModelGateway(), contextProviders = [],
  textOnly = false, suggestionsEnabled = () => true,
  readVideoTranscript = (target, options) => readTranscriptFromPort(browser?.connect, target, options),
  scanVideo = (offer, options) => scanVideoPage(browser?.connect, offer, options),
  researchTools = createResearchToolSession, researchOptions = {}, recordDiagnostic = () => {}, nowMs = Date.now, ...ports }) {
  // Config loads after this composition and may change later. ChatService
  // checks the search setting from each turn's frozen model profile.
  const publicResearch = createPublicResearchTransport(researchOptions);
  const listeners = new Set();
  const emit = event => { for (const listener of listeners) { try { listener(event); } catch {} } };
  const repository = createConversationRepository({ getConversation: () => state.conversation,
    saver: conversationSaver, createId: ports.makeId, now: ports.now,
    onChange: event => {
      if (event.kind === 'decorate' && state.conversation?.id === event.ref.conversationId) emit({ type: 'conversation' });
    } });
  const runner = createTurnRunner({ repository, createId: ports.makeId, now: nowMs });
  const diagnostics = createApplicationDiagnostics({ record: recordDiagnostic, runner, repository });
  const observedPorts = { ...ports,
    readCurrentPageForRequest: diagnostics.wrap(ports.readCurrentPageForRequest, {
      identify: (_question, options) => ({ tabId: options?.target?.id ?? options?.target?.tabId, documentId: options?.target?.documentId }),
      describe: (_question, options) => ({ stage: options?.deep ? 'inspect' : 'read' }), summarize: readingDiagnosticEvidence }),
    enhancePageReading: diagnostics.wrap(ports.enhancePageReading, { stage: 'inspect', summarize: readingDiagnosticEvidence,
      identify: (_question, options) => ({ tabId: options?.target?.id ?? options?.target?.tabId, documentId: options?.target?.documentId }) }),
  };
  for (const name of ['ensureConversation', 'ensureConfigured', 'getDirectoryInfo', 'promoteTemporaryConversation']) {
    observedPorts[name] = diagnostics.wrap(ports[name], { event: 'storage', source: 'storage', stage: name === 'ensureConfigured' ? 'settings' : 'preparing',
      summarize: result => name === 'ensureConfigured' ? { ok: result === true }
        : name === 'getDirectoryInfo' ? { permissionGranted: result?.granted === true } : { ok: Boolean(result?.id) } });
  }
  const videoNotes = createVideoNotesCommand({ readTranscript: readVideoTranscript, scanVideo, now: nowMs });
  const pageCommands = Object.freeze(textOnly ? {} : { 'video-notes': videoNotes });
  const contextAssembler = createContextAssembler({ providers: [createSkillContextProvider(), createVideoContextProvider(), ...contextProviders] });
  const contextService = createContextService({ state, modelGateway, profileFor: ports.profileFor,
    createId: ports.makeId, now: ports.now,
    save: conversation => conversationSaver.schedule(conversation),
    onEvent: event => emit(event.type === 'settled' ? { ...event, type: 'compression-settled' } : event) });
  const chatService = createChatService({ repository, runner, modelGateway, contextAssembler, now: nowMs,
    replyPolicyFor: textOnly ? () => ({ suggestions: false }) : videoNotes.replyPolicy,
    suggestionsEnabled,
    compress: textOnly ? undefined : contextService.compress, researchTools: !textOnly && researchTools ? options => {
      const session = researchTools({ ...options, fallbackSearch: publicResearch.search, fallbackFetch: publicResearch.fetch });
      return { ...session, execute: diagnostics.wrap(session.execute, { event: 'research', source: 'web-research', stage: 'research',
        summarize: result => ({ resultCount: result?.sources?.length || (result?.source ? 1 : 0) }) }) };
    } : null });
  const generateImage = createImageReply({ repository, getProfile: () => ports.profileFor(undefined, undefined, { allowDefaultModel: true }), makeId: ports.makeId });
  const replyService = { generate: options => !textOnly && directImageForMessage(repository.get(options.run.ref)?.user)
    ? generateImage(options) : chatService.generate(options) };
  const conversationService = createConversationService({ state, browser, agentSlot, runner, repository,
    modelGateway, replyService, ...observedPorts, pageCommands });
  conversationService.subscribe(emit);
  const getIllustrationConfig = () => ({ ...state.config,
    selectedModelId: state.selectedModelId || state.config?.selectedModelId,
    selectedEffort: state.selectedEffort || state.config?.selectedEffort });
  const illustration = createImageIllustration({ repository, modelGateway, getConfig: getIllustrationConfig,
    makeId: ports.makeId, isCurrent: ref => state.conversation?.id === ref.conversationId });
  const videoIllustration = createVideoIllustration({ repository, modelGateway, getConfig: getIllustrationConfig,
    captureFrame: diagnostics.wrap((input, options) => captureVideoStill(browser?.connect, input, options), {
      event: 'diagnostic', source: 'diagnostics', stage: 'capture',
      identify: input => ({ conversationId: input?.conversationId, turnId: input?.turnId, runId: input?.runId,
        tabId: input?.target?.tabId, documentId: input?.target?.documentId }),
      summarize: result => ({ status: result?.outcome === 'captured' ? 'success' : 'unavailable',
        blackFrame: result?.outcome === 'black-frame',
        frameCount: result?.outcome === 'captured' ? 1 : 0 }),
    }),
    makeId: ports.makeId, now: nowMs, recordDiagnostic, isCurrent: ref => state.conversation?.id === ref.conversationId });
  const cancelIllustrations = assistantId => {
    const chat = illustration.cancel(assistantId), video = videoIllustration.cancel(assistantId);
    return chat || video;
  };
  const conversations = Object.freeze({ ...conversationService,
    stopActiveReply() { const cancelled = cancelIllustrations(); return conversationService.stopActiveReply() || cancelled; },
  });
  runner.subscribe(event => { try { diagnostics.observe(event); } catch { /* UI remains independent of diagnostics. */ }
    const typed = { ...event, type: `run:${event.type}` };
    if (!textOnly) {
      try { illustration.handle(typed); } catch { /* Optional decoration cannot affect the run. */ }
      try { videoIllustration.handle(typed); } catch { /* Optional decoration cannot affect the run. */ }
    }
    emit(typed); });
  return Object.freeze({ conversations, runner, repository, contextService, contextAssembler, modelGateway,
    cancelIllustrations, cancelSuggestions: chatService.cancelSuggestions, videoFrameRecovery: videoNotes.recovery,
    reconcileIllustrations(conversation) {
      const changed = settleInterruptedIllustrations(conversation, assistantId => illustration.active(conversation.id, assistantId)
        || videoIllustration.active(conversation.id, assistantId));
      if (changed) conversationSaver.schedule(conversation);
      return changed;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { conversations.dispose(); runner.dispose(); videoNotes.dispose(); illustration.dispose(); videoIllustration.dispose(); diagnostics.dispose(); chatService.dispose(); contextService.dispose(); void contextAssembler.dispose(); listeners.clear(); },
  });
}

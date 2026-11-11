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
  researchTools = createResearchToolSession, researchOptions = {}, recordDiagnostic = () => {}, ...ports }) {
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
  const runner = createTurnRunner({ repository, createId: ports.makeId });
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
  const contextAssembler = createContextAssembler({ providers: contextProviders });
  const contextService = createContextService({ state, modelGateway, profileFor: ports.profileFor,
    createId: ports.makeId, now: ports.now,
    save: conversation => conversationSaver.schedule(conversation),
    onEvent: event => emit(event.type === 'settled' ? { ...event, type: 'compression-settled' } : event) });
  const chatService = createChatService({ repository, runner, modelGateway, contextAssembler,
    compress: contextService.compress, researchTools: researchTools ? options => {
      const session = researchTools({ ...options, fallbackSearch: publicResearch.search, fallbackFetch: publicResearch.fetch });
      return { ...session, execute: diagnostics.wrap(session.execute, { event: 'research', source: 'web-research', stage: 'research',
        summarize: result => ({ resultCount: result?.sources?.length || (result?.source ? 1 : 0) }) }) };
    } : null });
  const conversations = createConversationService({ state, browser, agentSlot, runner, repository,
    modelGateway, replyService: chatService, ...observedPorts });
  conversations.subscribe(emit);
  runner.subscribe(event => { try { diagnostics.observe(event); } catch { /* UI remains independent of diagnostics. */ } emit({ ...event, type: `run:${event.type}` }); });
  return Object.freeze({ conversations, runner, repository, contextService, contextAssembler, modelGateway,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { conversations.dispose(); runner.dispose(); diagnostics.dispose(); chatService.dispose(); contextService.dispose(); void contextAssembler.dispose(); listeners.clear(); },
  });
}

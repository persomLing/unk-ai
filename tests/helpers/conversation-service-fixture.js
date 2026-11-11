import { createConversationService } from '../../src/app/conversation-service.js';
import { createConversationRepository } from '../../src/app/conversation-repository.js';
import { createTurnRunner } from '../../src/app/turn-runner.js';
import { createModelGateway } from '../../src/app/model-gateway.js';

/** Real command service, runner and repository with replaceable boundary ports.
 * Legacy view callbacks are observers only; they do not own turn transitions.
 */
export function createConversationServiceFixture(ports = {}) {
  const state = ports.state || {};
  const defaults = { conversation: { id: 'conversation', messages: [] }, ready: true,
    attachments: [], messageQueue: [], selectedEffort: 'default', selectedModelId: 'test-model',
    disablePageContext: true, directModelRequest: '', draft: '' };
  for (const [key, value] of Object.entries(defaults)) if (!Object.hasOwn(state, key)) state[key] = value;
  const input = ports.input || { value: state.draft };
  state.draft = input.value ?? state.draft;
  Object.defineProperty(input, 'value', { configurable: true,
    get: () => state.draft, set: value => { state.draft = value; } });
  const notices = [], modelRequests = [], events = [];
  let id = 0, runId = 0;
  const makeId = ports.makeId || (() => `message-${++id}`);
  const saveCurrent = ports.saveCurrent || (async () => {});
  const saver = {
    save: (conversation, options) => saveCurrent({ ...options, conversation }),
    schedule: () => ports.scheduleSave?.(),
  };
  const repository = createConversationRepository({ getConversation: () => state.conversation,
    saver, createId: makeId, now: ports.now });
  const runner = createTurnRunner({ repository, createId: () => `fixture-run-${++runId}`,
    setTimer: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return timer; } });
  const profileFor = ports.profileFor || (() => ({ id: 'test-model', model: 'test-model', contextLength: 128000,
    maxTokens: 2000, ...ports.activeChatProfile?.() }));
  const modelGateway = ports.modelGateway || createModelGateway({ transport: async () => 'Fixture model answer' });
  const replyService = ports.replyService || {
    async generate({ assistant, conversation, run, profile }) {
      modelRequests.push({ assistant, conversation, ref: run.ref, profile });
      const result = await ports.generateReply?.(assistant, run);
      const content = typeof result === 'string' ? result : result?.content || assistant.content || 'Fixture model answer';
      const fields = { ...(result && typeof result === 'object' ? result : {}), content };
      run.complete(fields);
      return fields;
    },
  };
  const service = createConversationService({
    state, repository, runner, modelGateway, replyService,
    browser: ports.browser || {
      queryActiveTab: async () => ports.chrome?.tabs?.query
        ? (await ports.chrome.tabs.query({ active: true, currentWindow: true }))?.[0] || null
        : { id: 1, url: 'https://page.test' },
      sendMessage: message => ports.chrome?.runtime?.sendMessage?.(message)
        || Promise.resolve({ tabId: message.tabId, url: message.expectedUrl, documentId: 'fixture-document' }),
    },
    agentSlot: { isBusy: () => false, isMode: () => false, start: async () => true, ...ports.agentSlot },
    ensureConversation: ports.ensureConversation || (async () => state.conversation),
    ensureConfigured: ports.ensureConfigured || (async () => true),
    saveCurrent, scheduleSave: ports.scheduleSave || (() => {}),
    getDirectoryInfo: ports.getDirectoryInfo || (async () => ({ granted: false })),
    promoteTemporaryConversation: ports.promoteTemporaryConversation || (async conversation => conversation),
    readCurrentPageForRequest: ports.readCurrentPageForRequest || (async () => null),
    autoVisualAttachments: ports.autoVisualAttachments || (async () => []),
    enhancePageReading: ports.enhancePageReading,
    activeChatProfile: ports.activeChatProfile || (() => profileFor()), profileFor,
    conversationTitle: ports.conversationTitle || (text => String(text)), hasVision: ports.hasVision || (() => true),
    makeId, now: ports.now, truncateText: ports.truncateText,
    waitWithTimeout: ports.awaitWithTimeout,
    retryTarget: ports.validateRetryPageTarget, refreshRetry: ports.refreshPageForRetry,
  });
  const handlers = { draft: 'resizeInput', attachments: 'renderAttachments', selection: 'renderPageSelection',
    composer: 'updateComposer', queue: 'renderQueueBar', conversation: 'renderConversation', context: 'renderContextChip' };
  service.subscribe(event => {
    events.push(event);
    if (event.type === 'notice') { notices.push(event.message); ports.toast?.(event.message, event.kind); }
    else if (event.type === 'progress') {
      const message = state.conversation?.messages.find(item => item.id === event.assistantId);
      if (message) ports.setAssistantPhase?.(message, message.requestPhase);
    } else ports[handlers[event.type]]?.(event);
  });
  return { ...service, service, runner, repository, state, input, modelRequests, notices, events };
}

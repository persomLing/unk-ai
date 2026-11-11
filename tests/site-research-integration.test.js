import test from 'node:test';
import assert from 'node:assert/strict';
import { researchPageForRequest } from '../src/sidepanel/features/page-reading/site-research-slot.js';
import { normalizeResearch, readSourcesForPage } from '../src/utils/research-context.js';
import { normalizePageContext } from '../src/utils/reading-context.js';
import { requestMessagesFor, fitMessagesToBudget, estimateMessagesTokens } from '../src/utils/context.js';
import { messagesForRetry, sameTurnContext } from '../src/sidepanel/features/messages/retry-flow.js';

const base = { url: 'https://docs.example.com/#/intro', tabId: 7, documentId: 'doc-a', title: 'Intro', text: 'Current chapter evidence', capturedAt: '2026-10-30T00:00:00Z' };
const research = { baseUrl: base.url, status: 'complete', sources: [
  { url: 'https://docs.example.com/#/agent', title: 'Agent', text: 'Agent chapter body', capturedAt: base.capturedAt },
] };
const page = { ...base, structure: { research } };

test('research discovery is pinned to the original tab/document and causes no tab actions', async () => {
  const commands = [];
  const result = await researchPageForRequest(base, 'agent', {
    sendMessage: async message => { commands.push(message); return { ...base, navigation: [] }; },
    readResearch: async options => { assert.equal(options.page, base); assert.equal(options.maxPages, 3); return research; },
  });
  assert.deepEqual(commands, [{ type: 'CAPTURE_SITE_RESEARCH', tabId: 7, documentId: 'doc-a', expectedUrl: base.url }]);
  assert.equal(result.url, base.url);
  assert.equal(result.structure.research.sources[0].text, 'Agent chapter body');
});

test('stale discovery or cancellation never launches link reads or adopts late research', async () => {
  let reads = 0;
  await assert.rejects(researchPageForRequest(base, 'agent', {
    sendMessage: async () => ({ ...base, documentId: 'doc-b' }),
    readResearch: async () => { reads++; return research; },
  }), /页面已变化/);
  assert.equal(reads, 0);
  const controller = new AbortController();
  await assert.rejects(researchPageForRequest(base, 'agent', {
    signal: controller.signal, sendMessage: async () => base,
    readResearch: async () => { controller.abort(); return research; },
  }), { name: 'AbortError' });
  assert.equal(base.structure, undefined);
});

test('research normalization bounds persisted bodies and rejects cross-site/duplicate sources', () => {
  const result = normalizeResearch({ ...research, sources: [
    ...Array.from({ length: 8 }, (_, index) => ({ url: `https://docs.example.com/#/${index}`, text: '中'.repeat(16000) })),
    { url: 'https://foreign.example.com/chapter', text: 'unrelated' },
  ] }, base.url);
  assert.equal(result.sources.reduce((total, source) => total + source.text.length, 0), 24000);
  assert.equal(result.truncated, true);
  assert.equal(normalizeResearch(research, 'https://docs.example.com/#/other'), null);
  assert.equal(normalizePageContext(page).structure.research.sources[0].text, 'Agent chapter body');
  const sources = readSourcesForPage(page);
  assert.equal(sources.length, 2);
  assert.ok(sources.every(source => !Object.hasOwn(source, 'text')));
});

test('only an enabled research turn receives linked bodies; page off and ordinary retry do not', () => {
  const question = { id: 'u', role: 'user', content: 'Summarize agent', pageSource: { url: base.url, capturedAt: base.capturedAt }, pageContextEnabled: true, researchEnabled: true };
  const conversation = { messages: [question] };
  assert.match(JSON.stringify(requestMessagesFor(conversation, undefined, page)), /Agent chapter body/);
  question.researchEnabled = false;
  let request = JSON.stringify(requestMessagesFor(conversation, undefined, page));
  assert.doesNotMatch(request, /Agent chapter body/);
  assert.match(request, /Current chapter evidence/);
  question.researchEnabled = true;
  question.pageContextEnabled = false;
  request = JSON.stringify(requestMessagesFor(conversation, undefined, page));
  assert.doesNotMatch(request, /Agent chapter body|Current chapter evidence/);
});

test('an 8k model budget preserves representative text and URLs from the base and both linked sources', () => {
  const longPage = { ...page, text: `BASE_BODY_MARKER ${'主'.repeat(6000)}`, structure: { research: { ...research, sources: [
    { url: 'https://docs.example.com/#/agent-21', title: 'Agent 21', text: `CHAPTER_21_MARKER ${'甲'.repeat(12000)}` },
    { url: 'https://docs.example.com/#/agent-26', title: 'Agent 26', text: `CHAPTER_26_MARKER ${'乙'.repeat(12000)}` },
  ] } } };
  const conversation = { messages: [{ id: 'u', role: 'user', content: '请总结Agent章节', researchEnabled: true, pageContextEnabled: true }] };
  const messages = requestMessagesFor(conversation, undefined, longPage);
  const fitted = fitMessagesToBudget(conversation, messages, 8000, 1000);
  assert.ok(estimateMessagesTokens(fitted) <= 6760);
  const outgoing = JSON.stringify(fitted);
  for (const value of ['请总结Agent章节', 'BASE_BODY_MARKER', 'CHAPTER_21_MARKER', 'CHAPTER_26_MARKER', base.url, 'https://docs.example.com/#/agent-21', 'https://docs.example.com/#/agent-26']) {
    assert.ok(outgoing.includes(value), value);
  }
  assert.match(outgoing, /truncated/);
  assert.match(outgoing, /内容因上下文预算截断/);
  assert.ok(fitted.every(message => Object.keys(message).every(key => ['role', 'content'].includes(key))));
  assert.ok(longPage.structure.research.sources[0].text.length > 12000);
  assert.equal(readSourcesForPage(longPage).length, 3);
});

test('research fitting records any sources excluded by an exceptionally small budget', () => {
  const lengthyTitle = '资料'.repeat(150);
  const longPage = { ...page, title: lengthyTitle, text: `BASE_KEEP ${'主'.repeat(1000)}`, structure: { research: { ...research, sources: Array.from({ length: 3 }, (_, index) => ({
    url: `https://docs.example.com/#/linked-${index}`, title: lengthyTitle, text: `SOURCE_${index} ${'文'.repeat(1000)}`,
  })) } } };
  const conversation = { messages: [{ id: 'u', role: 'user', content: '总结', researchEnabled: true, pageContextEnabled: true }] };
  const fitted = fitMessagesToBudget(conversation, requestMessagesFor(conversation, undefined, longPage), 2300, 1000);
  const outgoing = JSON.stringify(fitted);
  assert.match(outgoing, /BASE_KEEP/);
  assert.match(outgoing, /omittedSourceCount/);
  assert.match(outgoing, /因上下文预算未加入本次模型请求/);
  assert.ok(estimateMessagesTokens(fitted) <= 1231);
});

test('research and ordinary sends are distinct turns and Agent cannot use generic regeneration', () => {
  assert.equal(sameTurnContext({ researchEnabled: true }, { researchEnabled: false }), false);
  const messages = [{ id: 'u', role: 'user', content: 'Do task', agentTask: true }, { id: 'a', role: 'assistant', agent: { taskId: 'task' } }];
  assert.equal(messagesForRetry(messages, 'a', { id: 'new', role: 'assistant' }), null);
});

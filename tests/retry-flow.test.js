import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';

const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('replacement sends invalidate old submission ownership and queued prompts', async () => {
  const oldConfiguration = deferred(), newConfiguration = deferred();
  let configurations = 0;
  const fixture = createConversationServiceFixture({ ensureConfigured: () => ++configurations === 1
    ? oldConfiguration.promise : newConfiguration.promise });
  const old = fixture.sendMessage('Old question');
  await tick();
  await fixture.sendMessage('Queued stale question');
  assert.equal(fixture.state.messageQueue.length, 1);
  fixture.state.directReplaceReply = true;
  const replacement = fixture.sendMessage('Replacement question');
  await tick();
  const replacementOwner = fixture.state.submissionOwner;
  oldConfiguration.resolve(true);
  await old;
  assert.equal(fixture.state.submissionOwner, replacementOwner);
  assert.equal(fixture.state.isSubmitting, true);
  newConfiguration.resolve(true);
  await replacement;
  assert.equal(fixture.modelRequests.length, 1);
  assert.equal(fixture.repository.get(fixture.modelRequests[0].ref).user.content, 'Replacement question');
  assert.equal(fixture.state.messageQueue.length, 0);
  assert.equal(fixture.state.sendInFlight, false);
});

test('a repeated failed question retries the original turn without appending a duplicate question', async () => {
  let calls = 0;
  const fixture = createConversationServiceFixture({ generateReply: async () => {
    if (++calls === 1) throw new Error('Provider unavailable');
    return 'Recovered answer';
  } });
  await fixture.sendMessage('Original question');
  const questionId = fixture.state.conversation.messages[0].id;
  const failedId = fixture.state.conversation.messages[1].id;
  assert.equal(fixture.state.conversation.messages[1].status, 'error');
  await fixture.sendMessage('Original question');
  assert.equal(calls, 2);
  assert.equal(fixture.state.conversation.messages.length, 2);
  assert.equal(fixture.state.conversation.messages[0].id, questionId);
  assert.notEqual(fixture.state.conversation.messages[1].id, failedId);
  assert.equal(fixture.state.conversation.messages[1].content, 'Recovered answer');
});

test('follow-up chip presenters dispatch retry or replacement commands', () => {
  assert.match(entry, /samePrompt\(tryNextChip\.dataset\.suggestion/);
  assert.match(entry, /await regenerate\(sourceAssistant\.id\)/);
  assert.match(entry, /state\.directReplaceReply = true/);
});

test('rendering does not normalize, settle or persist conversation records', () => {
  const render = entry.slice(entry.indexOf('function renderConversation('), entry.indexOf('function openSourcePage('));
  assert.ok(render.length > 0, 'the renderer should be found');
  assert.doesNotMatch(render, /normalizeDuplicateRetryTurns|settleInterruptedReply|scheduleSave|saveCurrent/);
  assert.doesNotMatch(render, /conversation\.messages\s*=/);
});

test('legacy duplicate repair belongs to the load lifecycle and is persisted there', () => {
  const initialize = entry.slice(entry.indexOf('async function initialize('), entry.indexOf('function startSelectionSync('));
  assert.match(initialize, /normalizeDuplicateRetryTurns\(state\.conversation\.messages\)/);
  assert.match(initialize, /state\.conversation\.messages = normalized/);
  assert.match(initialize, /scheduleSave\(\)/);
});

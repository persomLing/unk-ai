import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSlot } from '../src/sidepanel/features/agent/agent-slot.js';

test('finishing uses the existing model result and saves it before revoking task grants', { timeout: 3000 }, async (t) => {
  const original = { chrome: globalThis.chrome, document: globalThis.document, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  const events = [];
  const completedTurns = [];
  let modelCalls = 0;
  const data = { agentSettings: { enabled: true }, agentOriginGrants: {} };
  const area = {
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, value); },
    async remove(key) { delete data[key]; },
  };
  const event = { addListener() {} };
  globalThis.document = { querySelector: () => null };
  globalThis.chrome = { storage: { local: area, session: area }, tabs: { onActivated: event }, runtime: { onMessage: event } };
  globalThis.fetch = async (_url, request) => {
    modelCalls += 1;
    const body = JSON.parse(request.body);
    if (body.tools) return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'finish_task', args: { summary: 'Done' } }) } }] });
    events.push('summary');
    assert.match(JSON.stringify(body.messages), /Verified page evidence/);
    return Response.json({ choices: [{ message: { content: 'Verified summary' } }] });
  };
  let completed;
  const cleanup = new Promise((resolve) => { completed = resolve; });
  const slot = createAgentSlot({
    queryActiveTab: async () => ({ id: 1, url: 'https://allowed.test/app' }),
    getPageModeEnabled: () => true,
    getProfile: () => ({ endpointUrl: 'https://model.test/v1', apiKey: 'test-only', model: 'fixture' }),
    beginTurn: async ({ taskId }) => { data.agentOriginGrants['https://allowed.test'] = { scope: 'task', taskId }; },
    endTurn: async (turn) => { events.push('turn-saved'); completedTurns.push(turn); },
    sendMessage: async (message) => {
      events.push(message.type);
      if (message.type === 'AGENT_OBSERVE') return { snapshotId: 'snapshot', title: 'Page', url: 'https://allowed.test/app', summary: 'Page', elements: [], flags: {} };
      if (message.type === 'AGENT_PAGE_EVIDENCE') {
        assert.ok(data.agentOriginGrants['https://allowed.test'], 'task grant must exist during evidence read');
        return { ok: true, text: 'Verified page evidence', url: 'https://allowed.test/app' };
      }
      if (message.type === 'AGENT_RELEASE') {
        assert.equal(data.agentOriginGrants['https://allowed.test'], undefined);
        completed();
      }
      return { ok: true };
    },
  });
  assert.equal(await slot.start('Summarize this page'), true);
  await cleanup;
  await slot.getTask().finalization;
  assert.ok(events.indexOf('AGENT_START') < events.indexOf('AGENT_OBSERVE'));
  assert.equal(modelCalls, 1);
  assert.equal(events.includes('AGENT_PAGE_EVIDENCE'), false);
  assert.equal(completedTurns[0].result, 'Done');
  assert.ok(events.indexOf('AGENT_PAUSE') < events.indexOf('turn-saved'));
  assert.ok(events.indexOf('turn-saved') < events.indexOf('AGENT_RELEASE'));
});

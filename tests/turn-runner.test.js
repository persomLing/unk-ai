import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/app/turn-runner.js';

function fixture() {
  const updates = [], commits = [], events = [], timers = new Map();
  let id = 0;
  const repository = {
    begin: args => ({ conversationId: args.conversation.id, turnId: args.turnId || args.user.id,
      runId: args.runId, userId: args.user.id, assistantId: args.assistant.id }),
    update: (ref, patch) => { updates.push({ ref, patch }); return true; },
    finish: (ref, patch) => { commits.push({ ref, patch }); return true; },
    schedule() {},
  };
  const runner = createTurnRunner({ repository, createId: () => `run-${++id}`, now: () => 100,
    setTimer: callback => { timers.set(++id, callback); return id; }, clearTimer: id => timers.delete(id) });
  runner.subscribe(event => events.push(event));
  const bind = run => run.bind({ conversation: { id: 'c' }, user: { id: 'u' }, assistant: { id: `a-${run.runId}` } });
  return { runner, bind, repository, updates, commits, events, timers };
}

test('one command executes once and one run commits its terminal answer once', async () => {
  const { runner, bind, commits } = fixture();
  const run = runner.begin({ commandId: 'click-1', mode: 'chat' });
  bind(run);
  let calls = 0;
  const operation = async () => { calls++; return { content: 'Answer' }; };
  const first = run.execute(operation);
  const duplicate = runner.begin({ commandId: 'click-1', mode: 'chat' }).execute(operation);
  await Promise.all([first, duplicate]);
  assert.equal(calls, 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].patch.status, 'complete');
  assert.equal(run.complete({ content: 'Second answer' }), false);
});

test('cancel releases an uncooperative executor and rejects all late events', async () => {
  const { runner, bind, commits, updates } = fixture();
  const run = runner.begin({ commandId: 'old' });
  bind(run);
  let finish;
  const pending = run.execute(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  run.cancel();
  await pending;
  const next = runner.begin({ commandId: 'new' });
  bind(next);
  assert.equal(run.update({ content: 'Late content' }), false);
  finish({ content: 'Late answer' });
  await Promise.resolve();
  assert.equal(commits.length, 1);
  assert.equal(commits[0].patch.status, 'stopped');
  assert.equal(updates.some(entry => entry.patch.content === 'Late content'), false);
  assert.equal(runner.active(), next);
  next.cancel();
});

test('preparation timeout ends a bound turn and does not depend on transport cancellation', async () => {
  const { runner, bind, commits, timers } = fixture();
  const run = runner.begin({ commandId: 'timeout', timeoutMs: 50 });
  bind(run);
  const pending = run.execute(() => new Promise(() => {}));
  [...timers.values()][0]();
  await pending;
  assert.equal(commits[0].patch.status, 'error');
  assert.match(commits[0].patch.errorMessage, /超时/);
  assert.equal(runner.active(), null);
});

test('repeated or out-of-order events and mismatched identity do not update a turn', () => {
  const { runner, bind, updates } = fixture();
  const run = runner.begin({ commandId: 'events' });
  const ref = bind(run);
  assert.equal(run.accept({ ...ref, seq: 2, patch: { content: 'AB' } }), true);
  assert.equal(run.accept({ ...ref, seq: 2, patch: { content: 'ABAB' } }), false);
  assert.equal(run.accept({ ...ref, seq: 1, patch: { content: 'A' } }), false);
  assert.equal(run.accept({ ...ref, runId: 'another', seq: 3, patch: { content: 'Wrong' } }), false);
  assert.equal(updates.filter(entry => entry.patch.content).length, 1);
  run.cancel();
});

test('a throwing renderer cannot abort the model execution or duplicate its terminal event', async () => {
  const { runner, bind, commits, events } = fixture();
  runner.subscribe(() => { throw new Error('broken view'); });
  const run = runner.begin({ commandId: 'view-failure' });
  bind(run);
  await run.execute(async () => ({ content: 'Answer' }));
  assert.equal(commits.length, 1);
  assert.equal(events.filter(event => event.type === 'terminal').length, 1);
});

test('empty visible output fails and diagnostics never contain prompt or credentials', async () => {
  const { runner, bind, commits, events } = fixture();
  const run = runner.begin({ commandId: 'empty', profile: { apiKey: 'SECRET' } });
  bind(run);
  await run.execute(async () => ({ content: '   ', reasoning: 'private reasoning' }));
  assert.equal(commits[0].patch.status, 'error');
  assert.match(commits[0].patch.errorMessage, /空回答/);
  assert.doesNotMatch(JSON.stringify(events), /SECRET|private reasoning/);
});

test('a stale repository terminal cannot report successful completion or retain the active run', async () => {
  const { runner, bind, repository, events } = fixture();
  const run = runner.begin({ commandId: 'stale-terminal' });
  bind(run);
  repository.finish = () => false;
  await run.execute(async () => ({ content: 'late answer' }));
  assert.equal(run.status, 'cancelled');
  assert.equal(run.signal.aborted, true);
  assert.equal(runner.active(), null);
  assert.equal(events.filter(event => event.type === 'terminal').length, 1);
});

test('a failed persistence scheduler reports the failure and releases the completed answer', async () => {
  const { runner, bind, repository, events, commits } = fixture();
  const run = runner.begin({ commandId: 'schedule-failure' });
  bind(run);
  repository.schedule = () => { throw new Error('scheduler unavailable'); };
  await run.execute(async () => ({ content: 'answer' }));
  assert.equal(run.status, 'completed');
  assert.equal(commits.length, 1);
  assert.equal(runner.active(), null);
  assert.equal(events.filter(event => event.type === 'persistence-error').length, 1);
  const next = runner.begin({ commandId: 'after-schedule-failure' });
  next.cancel();
});

test('a failed terminal writer releases the run and emits one failed terminal', async () => {
  const { runner, bind, repository, events } = fixture();
  const run = runner.begin({ commandId: 'commit-failure' });
  bind(run);
  repository.finish = () => { throw new Error('invalid data'); };
  await run.execute(async () => ({ content: 'answer' }));
  assert.equal(run.status, 'failed');
  assert.equal(runner.active(), null);
  assert.equal(events.filter(event => event.type === 'terminal').length, 1);
});

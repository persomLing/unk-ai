import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearchAnswer } from '../src/sidepanel/features/web-research/research-answer-loop.js';
import { createResearchToolSession } from '../src/sidepanel/features/web-research/research-tools.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const decision = (calls = [], content = '', reasoning = '') => ({ content, reasoning, toolCalls: calls,
  finishReason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: content || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) } });
const source = (id = 'one', extra = {}) => ({ url: `https://evidence.example/${id}`, title: id, snippet: '实际返回的摘要。'.repeat(12), ...extra });

function toolResults(input) {
  return input.messages.filter(message => message.role === 'tool')
    .map(message => ({ id: message.tool_call_id, value: JSON.parse(message.content) }));
}

function assertPairedTools(input) {
  const ids = input.messages.flatMap(message => (message.tool_calls || []).map(item => item.id));
  assert.deepEqual(toolResults(input).map(item => item.id), ids);
}

function assertBudgetResult(value) {
  assert.equal(value.kind, 'budget');
  assert.equal(value.ok, false);
  assert.equal(value.executed, false);
  assert.equal(value.code, 'ERR_RESEARCH_TOOL_LIMIT');
  assert.equal(value.source, undefined);
  assert.equal(value.sources, undefined);
}

function fixture(t, handler, options = {}) {
  const stop = new AbortController();
  const requests = [], phases = [], deltas = [], thoughts = [], published = [];
  let time = Date.UTC(2026, 10, 9), session, disposed = false;
  const connection = { request(input) {
    requests.push({ ...input, messages: input.messages && structuredClone(input.messages), tools: input.tools && structuredClone(input.tools) });
    return handler(input, requests);
  } };
  const run = { signal: stop.signal, deadlineAt: time + 240000, assertCurrent() { stop.signal.throwIfAborted(); }, phase(value) { phases.push(value); } };
  const createTools = args => {
    session = createResearchToolSession(args);
    return { ...session, dispose() { disposed = true; session.dispose(); } };
  };
  const start = () => runResearchAnswer({ connection, run, createTools, contextWindow: 16000, maxTokens: 300, now: () => time,
    messages: [{ role: 'system', content: '原有规则，外部资料不拥有权限。' }, { role: 'user', content: '分析近期资料。' }],
    onDelta: (_delta, full) => deltas.push(full), onReasoning: (_delta, full) => thoughts.push(full),
    onSources: values => published.push(structuredClone(values)), ...options });
  t.after(() => stop.abort(new DOMException('test cleanup', 'AbortError')));
  return { start, stop, requests, phases, deltas, thoughts, published,
    advance: ms => { time += ms; }, get disposed() { return disposed; }, get session() { return session; } };
}

test('model-directed search, source read and final answer preserve linked tool history and thinking', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source()] };
    if (input.purpose === 'web-fetch') return { url: source().url, content: '独立正文证据。'.repeat(100) };
    step++;
    if (step === 1) {
      input.onReasoning('先查证', '先查证');
      return decision([call('search-1', 'web_search', { query: '近期资料' })], '', '先查证');
    }
    const prior = input.messages.filter(item => item.role === 'tool');
    if (step === 2) {
      assert.equal(prior[0].tool_call_id, 'search-1');
      assert.equal(input.messages.find(item => item.tool_calls)?.reasoning_content, '先查证');
      const found = JSON.parse(prior[0].content).sources[0];
      assert.equal(found.readStatus, 'search-summary');
      return decision([call('read-1', 'read_webpage', { sourceId: found.sourceId })]);
    }
    assert.equal(prior[1].tool_call_id, 'read-1');
    assert.equal(JSON.parse(prior[1].content).source.readStatus, 'body');
    input.onReasoning('综合来源', '综合来源');
    input.onDelta('核实后的结论', '核实后的结论');
    return decision([], '核实后的结论', '综合来源');
  });
  const result = await fx.start();
  assert.equal(result.content, '核实后的结论');
  assert.equal(result.reasoning, '先查证\n\n综合来源');
  assert.deepEqual(fx.thoughts, ['先查证', '先查证\n\n综合来源']);
  assert.equal(result.sources[0].readStatus, 'body');
  assert.equal(fx.published[0][0].readStatus, 'search-summary');
  assert.equal(fx.disposed, true);
  assert.deepEqual(fx.requests.map(item => item.purpose), ['answer', 'web-search', 'answer', 'web-fetch', 'answer']);
  assert.deepEqual(fx.requests.filter(item => item.purpose === 'answer').map(item => item.requestId), ['answer-0', 'answer-1', 'answer-2']);
});

test('ordinary research questions receive a fixed Beijing date before the first model decision', async t => {
  const fx = fixture(t, input => {
    assert.equal(input.purpose, 'answer');
    assert.match(input.messages.filter(item => item.role === 'system').map(item => item.content).join('\n'), /北京时间\s*2026年11月9日/);
    return decision([], '无需调用工具也能回答。');
  });
  await fx.start();
});

test('model thinking time does not spend the separate tool execution budget', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source()] };
    if (++step === 1) {
      fx.advance(60000);
      return decision([call('search-after-thinking', 'web_search', { query: '深度分析后需要的资料' })]);
    }
    return decision([], '已经检索并完成回答。');
  });
  const result = await fx.start();
  assert.equal(result.content, '已经检索并完成回答。');
  assert.equal(fx.requests.filter(item => item.purpose === 'web-search').length, 1);
});

test('independent tools execute at most two at a time and results retain call order', async t => {
  const waits = [deferred(), deferred(), deferred()];
  let models = 0, searches = 0, active = 0, maxActive = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') {
      const index = searches++; active++; maxActive = Math.max(maxActive, active);
      return waits[index].promise.finally(() => { active--; });
    }
    if (++models === 1) return decision([0, 1, 2].map(index => call(`search-${index}`, 'web_search', { query: `资料 ${index}` })));
    assert.deepEqual(input.messages.filter(item => item.role === 'tool').map(item => item.tool_call_id), ['search-0', 'search-1', 'search-2']);
    return decision([], '来自三个来源的答案');
  });
  const pending = fx.start();
  await tick();
  assert.equal(searches, 2);
  waits[1].resolve({ results: [source('second')] });
  await tick();
  assert.equal(searches, 2);
  waits[0].resolve({ results: [source('first')] });
  await tick();
  assert.equal(searches, 3);
  waits[2].resolve({ results: [source('third')] });
  const result = await pending;
  assert.equal(maxActive, 2);
  assert.deepEqual(result.sources.map(item => item.title), ['first', 'second', 'third']);
});

test('whole batch validation rejects an unreturned source before any search starts', async t => {
  const fx = fixture(t, input => {
    if (input.purpose !== 'answer') assert.fail('No tool side effect is allowed');
    return decision([call('search', 'web_search', { query: '资料' }), call('read', 'read_webpage', { sourceId: 'not-yet-returned' })]);
  });
  await assert.rejects(fx.start(), /来源/);
  assert.equal(fx.requests.length, 1);
  assert.equal(fx.disposed, true);
});

test('a required tool failure stops without invoking an ungrounded final answer', async t => {
  const denied = Object.assign(new Error('permission denied'), { status: 403 });
  const fx = fixture(t, input => input.purpose === 'answer'
    ? decision([call('search', 'web_search', { query: '需要核实' })]) : Promise.reject(denied));
  await assert.rejects(fx.start(), error => error === denied);
  assert.deepEqual(fx.requests.map(item => item.purpose), ['answer', 'web-search']);
  assert.deepEqual(fx.published, []);
  assert.equal(fx.disposed, true);
});

test('stop during a hanging tool suppresses late evidence and all later model calls', async t => {
  const wait = deferred();
  const fx = fixture(t, input => input.purpose === 'answer'
    ? decision([call('search', 'web_search', { query: '资料' })]) : wait.promise);
  const pending = fx.start();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick();
  fx.stop.abort(new DOMException('stopped', 'AbortError'));
  await rejected;
  wait.resolve({ results: [source()] });
  await tick();
  assert.equal(fx.requests.length, 2);
  assert.deepEqual(fx.published, []);
  assert.deepEqual(fx.session.sources(), []);
  assert.equal(fx.disposed, true);
});

test('six tool calls force a final response without tools while keeping every result', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: Array.from({ length: 5 }, (_, index) => source(String(index))) };
    if (input.purpose === 'web-fetch') return { url: input.url, content: '已读正文。'.repeat(100) };
    if (++step === 1) return decision([call('search', 'web_search', { query: '多份资料' })]);
    if (step === 2) return decision(JSON.parse(input.messages.at(-1).content).sources.map((item, index) => call(`read-${index}`, 'read_webpage', { sourceId: item.sourceId })));
    assert.deepEqual(input.tools, []);
    assert.equal(input.toolChoice, 'none');
    assert.equal(input.messages.filter(item => item.role === 'tool').length, 6);
    return decision([], '根据已取得的五份正文回答。');
  });
  const result = await fx.start();
  assert.equal(result.sources.length, 5);
  assert.equal(fx.requests.filter(item => item.purpose !== 'answer').length, 6);
  assert.equal(step, 3);
});

test('a fourth search receives a paired budget result and a final answer even if the model ignores available tools', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source(input.query)] };
    step++;
    if (step === 1) return decision([0, 1, 2].map(index => call(`search-${index}`, 'web_search', { query: `q${index}` })));
    if (step === 2) {
      assert.ok(input.tools.every(item => item.function.name !== 'web_search'));
      return decision([call('fourth', 'web_search', { query: 'q3' })]);
    }
    assert.equal(step, 3);
    assert.deepEqual(input.tools, []);
    assert.equal(input.toolChoice, 'none');
    assertPairedTools(input);
    assertBudgetResult(toolResults(input).at(-1).value);
    return decision([], '依据已取得资料回答，第四次搜索未执行。');
  });
  const result = await fx.start();
  assert.match(result.content, /第四次搜索未执行/);
  assert.equal(fx.requests.filter(item => item.purpose === 'web-search').length, 3);
});

test('two searches yielding eleven sources can use one remaining search and finish after refusing the extra search', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: input.query === 'first'
      ? Array.from({ length: 6 }, (_, index) => source(`first-${index}`))
      : input.query === 'second' ? Array.from({ length: 5 }, (_, index) => source(`second-${index}`)) : [source('first-0')] };
    if (++step === 1) {
      input.onReasoning('先搜索', '先搜索');
      input.onDelta('先核实资料。', '先核实资料。');
      return decision([call('first', 'web_search', { query: 'first' }), call('second', 'web_search', { query: 'second' })], '先核实资料。', '先搜索');
    }
    if (step === 2) {
      assert.equal(fx.published.at(-1).length, 11);
      return decision([call('third', 'web_search', { query: 'third' }), call('extra', 'web_search', { query: 'extra' })]);
    }
    assert.equal(step, 3);
    assert.deepEqual(input.tools, []);
    assert.equal(input.toolChoice, 'none');
    assertPairedTools(input);
    const results = toolResults(input);
    assert.equal(results.at(-2).id, 'third');
    assert.equal(results.at(-2).value.kind, 'search');
    assertBudgetResult(results.at(-1).value);
    input.onReasoning('综合证据', '综合证据');
    input.onDelta('已核实的最终答案。', '已核实的最终答案。');
    return decision([], '已核实的最终答案。', '综合证据');
  });
  const result = await fx.start();
  assert.equal(result.content, '先核实资料。\n\n已核实的最终答案。');
  assert.equal(result.reasoning, '先搜索\n\n综合证据');
  assert.deepEqual(fx.deltas, ['先核实资料。', '先核实资料。\n\n已核实的最终答案。']);
  assert.deepEqual(fx.thoughts, ['先搜索', '先搜索\n\n综合证据']);
  assert.equal(result.sources.length, 11);
  assert.deepEqual(fx.requests.filter(item => item.purpose === 'web-search').map(item => item.query), ['first', 'second', 'third']);
});

test('four valid searches in the first batch execute only three and preserve the refused call in final context', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source(input.query)] };
    if (++step === 1) return decision([0, 1, 2, 3].map(index => call(`search-${index}`, 'web_search', { query: `q${index}` })));
    assert.deepEqual(input.tools, []);
    assert.equal(input.toolChoice, 'none');
    assertPairedTools(input);
    assert.equal(toolResults(input).length, 4);
    assertBudgetResult(toolResults(input).at(-1).value);
    return decision([], '根据三个检索结果完成，第四项尚未检索。');
  });
  const result = await fx.start();
  assert.equal(result.sources.length, 3);
  assert.equal(fx.requests.filter(item => item.purpose === 'web-search').length, 3);
});

for (const invalid of [
  { label: 'invalid parameters', value: call('bad', 'web_search', { query: '' }), pattern: /参数/ },
  { label: 'unknown tool', value: call('bad', 'delete_page', { query: 'x' }), pattern: /工具/ },
  { label: 'unreturned source', value: call('bad', 'read_webpage', { sourceId: 'not-yet-returned' }), pattern: /来源/ },
  { label: 'duplicate ID', value: call('search-0', 'web_search', { query: 'other' }), pattern: /重复/ },
]) {
  test(`budget overflow cannot hide ${invalid.label} or dispatch any preceding tool`, async t => {
    const fx = fixture(t, input => {
      if (input.purpose !== 'answer') assert.fail('the whole invalid batch must be rejected before tool dispatch');
      return decision([...Array.from({ length: 4 }, (_, index) => call(`search-${index}`, 'web_search', { query: `q${index}` })), invalid.value]);
    });
    await assert.rejects(fx.start(), invalid.pattern);
    assert.equal(fx.requests.length, 1);
    assert.equal(fx.disposed, true);
  });
}

test('identical searches within and across batches reuse transport without consuming another search slot', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source(input.query)] };
    if (++step === 1) return decision([0, 1, 2].map(index => call(`same-${index}`, 'web_search', { query: 'same' })));
    if (step === 2) {
      assert.ok(input.tools.some(item => item.function.name === 'web_search'));
      return decision([call('same-again', 'web_search', { query: 'same' }), call('second', 'web_search', { query: 'second' })]);
    }
    if (step === 3) {
      assert.ok(input.tools.some(item => item.function.name === 'web_search'));
      return decision([call('third', 'web_search', { query: 'third' })]);
    }
    assertPairedTools(input);
    assert.equal(toolResults(input).length, 6);
    assert.equal(toolResults(input).some(item => item.value.kind === 'budget'), false);
    return decision([], '三个不同查询所得的答案。');
  });
  const result = await fx.start();
  assert.equal(result.sources.length, 3);
  assert.deepEqual(fx.requests.filter(item => item.purpose === 'web-search').map(item => item.query), ['same', 'second', 'third']);
});

test('three completed searches keep source reading available while repeated reads do not consume call slots', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source(input.query)] };
    if (input.purpose === 'web-fetch') return { url: input.url, content: '确实读取的正文。'.repeat(100) };
    if (++step === 1) return decision([0, 1, 2].map(index => call(`search-${index}`, 'web_search', { query: `q${index}` })));
    const found = toolResults(input).find(item => item.value.kind === 'search').value.sources[0].sourceId;
    if (step === 2) {
      assert.ok(input.tools.every(item => item.function.name !== 'web_search'));
      assert.ok(input.tools.some(item => item.function.name === 'read_webpage'));
      return decision([call('read', 'read_webpage', { sourceId: found })]);
    }
    if (step === 3) return decision([0, 1, 2].map(index => call(`read-again-${index}`, 'read_webpage', { sourceId: found })));
    assertPairedTools(input);
    assert.equal(toolResults(input).some(item => item.value.kind === 'budget'), false);
    return decision([], '结合已读正文完成回答。');
  });
  const result = await fx.start();
  assert.equal(result.sources.filter(item => item.readStatus === 'body').length, 1);
  assert.equal(fx.requests.filter(item => item.purpose === 'web-fetch').length, 1);
  assert.equal(fx.requests.filter(item => item.purpose === 'web-search').length, 3);
});

test('cached tools still stop after four model tool rounds and receive a tool-free final response', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source()] };
    if (++step <= 4) return decision([call(`same-${step}`, 'web_search', { query: 'same' })]);
    assert.equal(step, 5);
    assert.deepEqual(input.tools, []);
    assert.equal(input.toolChoice, 'none');
    assertPairedTools(input);
    assert.equal(toolResults(input).length, 4);
    return decision([], '四轮后依据已有资料完成。');
  });
  await fx.start();
  assert.equal(fx.requests.filter(item => item.purpose === 'web-search').length, 1);
  assert.equal(fx.requests.filter(item => item.purpose === 'answer').length, 5);
});

test('a mixed batch fills the sixth distinct tool operation and refuses a new search while retaining cached reads', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: Array.from({ length: 5 }, (_, index) => source(`${input.query}-${index}`)) };
    if (input.purpose === 'web-fetch') return { url: input.url, content: '已读正文。'.repeat(100) };
    if (++step === 1) return decision([call('initial', 'web_search', { query: 'initial' })]);
    const found = toolResults(input)[0].value.sources;
    if (step === 2) return decision(found.slice(0, 4).map((item, index) => call(`read-${index}`, 'read_webpage', { sourceId: item.sourceId })));
    if (step === 3) return decision([
      call('final-read', 'read_webpage', { sourceId: found[4].sourceId }),
      call('denied-search', 'web_search', { query: 'new' }),
      call('cached-read', 'read_webpage', { sourceId: found[0].sourceId }),
    ]);
    assert.deepEqual(input.tools, []);
    assert.equal(input.toolChoice, 'none');
    assertPairedTools(input);
    const results = toolResults(input).slice(-3);
    assert.equal(results[0].value.kind, 'read');
    assertBudgetResult(results[1].value);
    assert.equal(results[2].value.kind, 'read');
    return decision([], '依据已读的五份正文回答，额外搜索未执行。');
  });
  const result = await fx.start();
  assert.equal(result.sources.length, 5);
  assert.equal(fx.requests.filter(item => item.purpose === 'web-fetch').length, 5);
  assert.equal(fx.requests.filter(item => item.purpose === 'web-search').length, 1);
});

test('every model request receives updated remaining search, tool and round budgets', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source()] };
    const notice = input.messages.filter(message => message.role === 'system' && /剩余/.test(message.content)).at(-1)?.content;
    assert.ok(notice, 'the model must receive a remaining budget notice');
    if (++step === 1) {
      assert.match(notice, /搜索[^\d]*3/);
      assert.match(notice, /工具[^\d]*6/);
      assert.match(notice, /轮[^\d]*4|4[^\d]*轮/);
      return decision([call('search', 'web_search', { query: '资料' })]);
    }
    assert.match(notice, /搜索[^\d]*2/);
    assert.match(notice, /工具[^\d]*5/);
    assert.match(notice, /轮[^\d]*3|3[^\d]*轮/);
    return decision([], '资料足够，完成回答。');
  });
  await fx.start();
});

test('an empty final response after budget refusal still fails even when an earlier explanation was streamed', async t => {
  let step = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source(input.query)] };
    if (++step === 1) {
      input.onDelta('我先查证。', '我先查证。');
      return decision([0, 1, 2, 3].map(index => call(`search-${index}`, 'web_search', { query: `q${index}` })), '我先查证。');
    }
    assert.equal(input.toolChoice, 'none');
    return decision([], '', '只有思考，没有回答');
  });
  await assert.rejects(fx.start(), /空回答/);
  assert.deepEqual(fx.deltas, ['我先查证。']);
});

test('stopping while waiting for the budget final response suppresses late content and leaves prior sources intact', async t => {
  const final = deferred();
  let step = 0, finalInput;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source(input.query)] };
    if (++step === 1) return decision([0, 1, 2, 3].map(index => call(`search-${index}`, 'web_search', { query: `q${index}` })));
    assert.equal(input.toolChoice, 'none');
    finalInput = input;
    return final.promise;
  });
  const pending = fx.start();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  for (let count = 0; count < 6 && !finalInput; count++) await tick();
  assert.ok(finalInput);
  assert.equal(fx.published.at(-1).length, 3);
  fx.stop.abort(new DOMException('stopped during final response', 'AbortError'));
  await rejected;
  assert.throws(() => finalInput.onDelta('迟到答案', '迟到答案'), { name: 'AbortError' });
  final.resolve(decision([], '迟到答案'));
  await tick();
  assert.deepEqual(fx.deltas, []);
  assert.equal(fx.requests.filter(item => item.purpose === 'answer').length, 2);
  assert.equal(fx.requests.filter(item => item.purpose === 'web-search').length, 3);
  assert.equal(fx.disposed, true);
});

test('a successful batch exhausting the time budget refuses later undispatched calls and completes from its existing sources', async t => {
  let step = 0, searches = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') {
      const result = { results: [source(input.query)] };
      if (++searches === 2) return Promise.resolve(result).then(value => { fx.advance(45000); return value; });
      return result;
    }
    if (++step === 1) return decision([0, 1, 2].map(index => call(`search-${index}`, 'web_search', { query: `q${index}` })));
    assert.deepEqual(input.tools, []);
    assert.equal(input.toolChoice, 'none');
    assertPairedTools(input);
    const refused = toolResults(input).at(-1).value;
    assertBudgetResult(refused);
    assert.equal(refused.reason, 'time-limit');
    assert.deepEqual(refused.remaining, { searches: 1, calls: 4 });
    return decision([], '根据已经取得的两份资料回答，后续查询未执行。');
  });
  const result = await fx.start();
  assert.equal(result.sources.length, 2);
  assert.equal(searches, 2);
  assert.equal(fx.requests.filter(item => item.purpose === 'answer').length, 2);
});

test('a running tool timing out at the cumulative time limit still fails without a final model response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wait = deferred();
  let step = 0, fetches = 0;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') {
      fx.advance(11000);
      return { results: [source(input.query)] };
    }
    if (input.purpose === 'web-fetch') { fetches++; return wait.promise; }
    if (++step <= 3) return decision([call(`search-${step}`, 'web_search', { query: `q${step}` })]);
    const found = toolResults(input)[0].value.sources[0].sourceId;
    return decision([call('read', 'read_webpage', { sourceId: found })]);
  });
  const pending = fx.start();
  const rejected = assert.rejects(pending, error => error.name === 'TimeoutError' && /时间预算/.test(error.message));
  for (let count = 0; count < 6 && !fetches; count++) await tick();
  assert.equal(fetches, 1);
  t.mock.timers.tick(12000);
  await rejected;
  wait.resolve({ content: '迟到的正文。'.repeat(100) });
  await tick();
  assert.equal(fx.requests.filter(item => item.purpose === 'answer').length, 4);
  assert.equal(fx.requests.filter(item => item.purpose === 'web-search').length, 3);
  assert.equal(fx.published.at(-1).length, 3);
  assert.ok(fx.published.at(-1).every(item => item.readStatus === 'search-summary'));
  assert.equal(fx.disposed, true);
});

test('tool context truncation is declared in both model evidence and final source metadata', async t => {
  let step = 0, seenBody;
  const fx = fixture(t, input => {
    if (input.purpose === 'web-search') return { results: [source()] };
    if (input.purpose === 'web-fetch') return { url: input.url, content: '确'.repeat(5000) };
    if (++step === 1) return decision([call('search', 'web_search', { query: '资料' })]);
    if (step === 2) return decision([call('read', 'read_webpage', { sourceId: JSON.parse(input.messages.at(-1).content).sources[0].sourceId })]);
    seenBody = JSON.parse(input.messages.at(-1).content).source;
    return decision([], '根据部分正文回答，并说明资料有截断。');
  }, { contextWindow: 2200, maxTokens: 200 });
  const result = await fx.start();
  assert.ok(seenBody.text.length < 5000);
  assert.equal(seenBody.truncated, true);
  assert.equal(result.sources[0].truncated, true);
});

test('oversized native reasoning stops before another model request rather than dropping tool pairs', async t => {
  const fx = fixture(t, input => input.purpose === 'answer'
    ? decision([call('search', 'web_search', { query: '资料' })], '', '推理'.repeat(3000))
    : { results: [source()] }, { contextWindow: 2200, maxTokens: 200 });
  await assert.rejects(fx.start(), /上下文容量/);
  assert.equal(fx.requests.filter(item => item.purpose === 'answer').length, 1);
  assert.equal(fx.disposed, true);
});

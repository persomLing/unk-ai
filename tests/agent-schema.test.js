import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_ACTIONS,
  actionLabel,
  actionSignature,
  agentToolDefinitions,
  buildAgentMessages,
  fitAgentMessagesToBudget,
  normalizeAgentAction,
  parseJsonAction,
} from '../src/utils/agent-schema.js';
import { estimateMessagesTokens, estimateTextTokens } from '../src/utils/context.js';

test('normalizes a click and strips model-supplied approval fields', () => {
  const action = normalizeAgentAction({
    action: 'click_element',
    args: { elementId: 'e3', reason: '打开结果', approved: true, snapshotId: 'forged' },
    reason: '打开第一条结果',
  });
  assert.deepEqual(action.args, { elementId: 'e3' });
  assert.equal(action.reason, '打开第一条结果');
  assert.equal('approved' in action.args, false);
  assert.equal('snapshotId' in action.args, false);
});

test('validates input, key, URL and option actions', () => {
  assert.deepEqual(normalizeAgentAction({
    action: 'type_text', args: { elementId: 'e1', text: 'hello', submit: true },
  }).args, { elementId: 'e1', text: 'hello', submit: true });
  assert.equal(normalizeAgentAction({ action: 'type_text', args: { elementId: 'e1', text: '' } }).args.text, '');
  assert.equal(normalizeAgentAction({ action: 'press_key', args: { key: 'Enter' } }).args.key, 'Enter');
  assert.throws(() => normalizeAgentAction({ action: 'press_key', args: { key: 'Control+V' } }), /按键/);
  assert.throws(() => normalizeAgentAction({ action: 'navigate', args: { url: 'javascript:alert(1)' } }), /http/);
  assert.equal(normalizeAgentAction({ action: 'navigate', args: { url: 'https://example.test/a' } }).args.url, 'https://example.test/a');
  assert.throws(() => normalizeAgentAction({ action: 'scroll_page', args: { direction: 'sideways' } }), /方向/);
  assert.equal(normalizeAgentAction({ action: 'scroll_page', args: { direction: 'down', amount: 99 } }).args.amount, 5);
});

test('parses a JSON action with or without markdown fences', () => {
  assert.deepEqual(parseJsonAction('```json\n{"action":"finish_task","args":{"summary":"done"}}\n```'), {
    action: 'finish_task',
    args: { summary: 'done' },
    reason: undefined,
  });
  assert.equal(parseJsonAction('not json'), null);
  assert.deepEqual(parseJsonAction('prefix {"action":"fail_task","args":{"reason":"x"},"reason":"why"} suffix').action, 'fail_task');
});

test('tool definitions expose page reading and safe actions without observe/CDP or scripts', () => {
  const names = agentToolDefinitions().map((tool) => tool.function.name);
  assert.deepEqual(names, [
    AGENT_ACTIONS.plan,
    AGENT_ACTIONS.read,
    AGENT_ACTIONS.readRegion,
    AGENT_ACTIONS.inspectVisual,
    AGENT_ACTIONS.verify,
    AGENT_ACTIONS.click,
    AGENT_ACTIONS.type,
    AGENT_ACTIONS.press,
    AGENT_ACTIONS.scroll,
    AGENT_ACTIONS.select,
    AGENT_ACTIONS.upload,
    AGENT_ACTIONS.navigate,
    AGENT_ACTIONS.wait,
    AGENT_ACTIONS.handoff,
    AGENT_ACTIONS.finish,
    AGENT_ACTIONS.fail,
  ]);
  assert.equal(names.includes('observe_page'), false);
  assert.equal(names.includes('js'), false);
  assert.equal(names.includes('tab_cdp_call'), false);
});

test('update_plan validates three to eight short goals and never accepts model proof or permissions', () => {
  const steps = [
    { id: 'find', title: '定位目标', status: 'completed', verified: true, approved: true },
    { id: 'fill', title: '填写信息', status: 'in_progress' },
    { id: 'check', title: '核对结果', status: 'pending' },
  ];
  const action = normalizeAgentAction({ action: 'update_plan', args: { steps, taskId: 'forged', evidence: 'forged' } });
  assert.deepEqual(action.args, { steps: steps.map(({ id, title, status }) => ({ id, title, status })) });
  assert.throws(() => normalizeAgentAction({ action: 'update_plan', args: { steps: steps.slice(0, 2) } }), /计划/);
  assert.throws(() => normalizeAgentAction({ action: 'update_plan', args: { steps: [...steps, ...steps] } }), /计划/);
  assert.throws(() => normalizeAgentAction({ action: 'update_plan', args: { steps: steps.map(step => ({ ...step, status: 'in_progress' })) } }), /计划/);
  const parsed = parseJsonAction(JSON.stringify({ action: 'update_plan', args: { steps } }));
  assert.equal(normalizeAgentAction(parsed).args.steps.length, 3);
});

test('visual inspection is a bounded read-only request for an observed ID and cannot carry execution coordinates', () => {
  assert.deepEqual(normalizeAgentAction({ action: 'inspect_visual', args: { elementId: 'e3' } }).args, { elementId: 'e3' });
  for (const args of [{ x: 20, y: 30 }, { elementId: 'e3', x: 20 }, { elementId: 'e3', selector: '#button' },
    { elementId: 'e3', approved: true }, { elementId: 'e3', snapshotId: 'forged' }]) {
    assert.throws(() => normalizeAgentAction({ action: 'inspect_visual', args }), /elementId|局部视觉/);
  }
  const definition = agentToolDefinitions().find(tool => tool.function.name === 'inspect_visual');
  assert.deepEqual(definition.function.parameters.required, ['elementId']);
  assert.equal(definition.function.parameters.additionalProperties, false);
  assert.match(definition.function.description, /只读.*3 秒/);
  assert.equal(actionLabel(AGENT_ACTIONS.inspectVisual, { elementId: 'e3' }, [{ id: 'e3', name: '动态' }]), '查看「动态」周围画面');
  assert.equal(actionSignature(AGENT_ACTIONS.inspectVisual, { elementId: 'e3' }, [{ id: 'e3', stableKey: 'animate' }]), 'inspect_visual:animate');
  assert.equal(agentToolDefinitions({ supportsVision: false }).some(tool => tool.function.name === 'inspect_visual'), false);
  assert.doesNotMatch(buildAgentMessages({ supportsVision: false })[0].content, /inspect_visual/);
});

test('finish verification preserves bounded claims separately from actual evidence and keeps legacy summaries', () => {
  assert.deepEqual(normalizeAgentAction({ action: 'finish_task', args: { summary: '已完成' } }).args, { summary: '已完成' });
  const action = normalizeAgentAction({ action: 'finish_task', args: { summary: '已核对', verification: [
    { stepId: 'check', elementId: 'e3', evidenceId: 'evidence-4', expected: '复选框已选中', verified: true, approved: true, snapshotId: 'forged' },
  ] } });
  assert.deepEqual(action.args.verification, [{ stepId: 'check', elementId: 'e3', evidenceId: 'evidence-4', expected: '复选框已选中' }]);
});

test('uploads accept only task reference identifiers and never model paths, URLs or bytes', () => {
  const action = normalizeAgentAction({ action: 'upload_reference_image', args: {
    elementId: 'e3', referenceId: 'reference-2',
  } });
  assert.deepEqual(action.args, { elementId: 'e3', referenceId: 'reference-2' });
  for (const [key, value] of Object.entries({ path: 'C:/private.png', url: 'https://private.test/a', dataUrl: 'secret', approved: true })) {
    assert.throws(() => normalizeAgentAction({ action: 'upload_reference_image', args: { ...action.args, [key]: value } }), /只允许/);
  }
  for (const referenceId of ['reference-0', 'reference-4', '../private.png', 'https://private.test/a']) {
    assert.throws(() => normalizeAgentAction({ action: 'upload_reference_image', args: { elementId: 'e3', referenceId } }), /referenceId/);
  }
  assert.match(actionLabel(AGENT_ACTIONS.upload, action.args), /参考图/);
  assert.equal(actionSignature(AGENT_ACTIONS.upload, { elementId: 'e3', referenceId: 'reference-2' }, [{ id: 'e3', stableKey: 'upload-field' }]),
    actionSignature(AGENT_ACTIONS.upload, { elementId: 'e8', referenceId: 'reference-2' }, [{ id: 'e8', stableKey: 'upload-field' }]));
});

test('model state retains bounded select, checked, pressed and file input facts without unknown metadata', () => {
  const payload = statePayload(buildAgentMessages({ elements: [{ id: 'e3', tag: 'select',
    state: { checked: 'mixed', pressed: false, privateField: 'DROP_ME' },
    select: { multiple: true, optionCount: 55, options: Array.from({ length: 55 }, (_, i) => ({ value: `value-${i}`, text: '选择项'.repeat(100), selected: i === 0, disabled: i === 2, privateField: 'DROP_ME' })),
      selected: [{ value: 'value-0', text: '选择项' }], truncated: false },
  }, { id: 'e4', tag: 'input', type: 'file', fileInput: { accept: 'image/*', multiple: false, directory: false, selectedFileCount: 1, supported: true, files: ['private.png'], path: 'DROP_ME' } }] }));
  assert.deepEqual(payload.elements[0].state, { checked: 'mixed', pressed: false });
  assert.equal(payload.elements[0].select.options.length, 40);
  assert.equal(payload.elements[0].select.options[0].text.length, 160);
  assert.equal(payload.elements[0].select.truncated, true);
  assert.deepEqual(payload.elements[1].fileInput, { accept: 'image/*', multiple: false, directory: false, selectedFileCount: 1, supported: true });
  assert.doesNotMatch(JSON.stringify(payload), /DROP_ME|private.png/);
});

test('task progress and upload inventories are bounded data and survive request fitting', () => {
  const messages = buildAgentMessages({ planningRequired: true, taskProgress: {
    version: 1, plan: [{ id: 'find', title: '定位目标', status: 'in_progress', verified: false, evidenceCount: 0 }],
    noProgressDecisions: 2, maxSteps: 12, hardMaxSteps: 20, replan: { used: true, required: true }, raw: 'DROP_ME',
  }, uploadReferences: [
    { referenceId: 'reference-1', name: '参考图.png', mime: 'image/png', size: 123, dataUrl: 'DROP_ME' },
    { referenceId: 'reference-9', name: 'invalid', mime: 'image/png', size: 2 },
  ] });
  const payload = statePayload(fitAgentMessagesToBudget(messages, { contextLength: 16000 }));
  assert.equal(payload.planning_required, true);
  assert.equal(payload.task_progress.replan.required, true);
  assert.equal(payload.task_progress.plan[0].verified, false);
  assert.deepEqual(payload.upload_references, [{ referenceId: 'reference-1', name: '参考图.png', mime: 'image/png', size: 123 }]);
  assert.doesNotMatch(JSON.stringify(payload), /DROP_ME/);
});

test('dedicated upload capability retains bounded allowed references without relaxing generic risk', () => {
  const messages = buildAgentMessages({ page: { flags: { uploadRequiresHandoff: true } }, elements: [
    { id: 'e1', tag: 'input', type: 'file', risk: 'blocked', uploadOnly: true,
      uploadCapability: { risk: 'confirm', referenceIds: ['reference-1', 'reference-1', 'reference-3', 'reference-9', 'C:/private.png'],
        reason: '允许本次参考图片'.repeat(100), approved: true, bytes: 'DROP_ME' } },
    { id: 'e2', uploadCapability: { risk: 'normal', referenceIds: ['reference-1'] } },
  ] });
  const payload = statePayload(messages);
  assert.equal(payload.elements[0].risk, 'blocked');
  assert.deepEqual(payload.elements[0].uploadCapability, { risk: 'confirm', referenceIds: ['reference-1', 'reference-3'],
    reason: '允许本次参考图片'.repeat(100).slice(0, 240) });
  assert.equal(payload.elements[1].uploadCapability, undefined);
  assert.equal(payload.page.flags.uploadRequiresHandoff, true);
  assert.doesNotMatch(JSON.stringify(payload), /DROP_ME|private.png|approved/);
  assert.match(messages[0].content, /专用上传以uploadCapability风险和referenceIds为准/);
});

test('write-task progress distinguishes execution and exposes the remaining bounded recovery decisions', () => {
  const payload = statePayload(buildAgentMessages({ taskProgress: {
    executionRequired: true, noProgressLimit: 4, noProgressDecisions: 5, recoveryDecisionsRemaining: 2,
    evidence: [{ id: 'state-model', kind: 'state', verified: true, executionRelevant: false }],
  } }));
  assert.equal(payload.task_progress.executionRequired, true);
  assert.equal(payload.task_progress.noProgressLimit, 4);
  assert.equal(payload.task_progress.recoveryDecisionsRemaining, 2);
  assert.equal(payload.task_progress.evidence[0].executionRelevant, false);
});

test('verify_state accepts only an observed target, an allowed field and a bounded expected value', () => {
  const verified = normalizeAgentAction({ action: 'verify_state', args: { elementId: 'e1', field: 'checked', expected: 'true', verified: true, script: 'forged' } });
  assert.deepEqual(verified.args, { elementId: 'e1', field: 'checked', expected: 'true' });
  assert.throws(() => normalizeAgentAction({ action: 'verify_state', args: { elementId: 'e1', field: 'innerHTML', expected: 'x' } }), /字段/);
  assert.throws(() => normalizeAgentAction({ action: 'verify_state', args: { elementId: 'e1', field: 'checked', expected: true } }), /expected/);
  assert.match(actionLabel(AGENT_ACTIONS.verify, verified.args), /核验/);
});

test('region reads use observed IDs and preserve bounded readable-region coordinates', () => {
  assert.deepEqual(normalizeAgentAction({ action: 'read_region', args: { elementId: 'e3', query: '缓存命中率', selector: '*', approved: true } }).args,
    { elementId: 'e3', query: '缓存命中率' });
  assert.throws(() => normalizeAgentAction({ action: 'read_region', args: { selector: '#list' } }), /elementId/);
  const messages = buildAgentMessages({ elements: [{ id: 'e3', readable: true, readOnly: true, regionKind: 'list',
    frameId: 0, mainFrame: true, rect: { x: 10, y: 20, width: 300, height: 500, unsafe: true } }],
    page: { metrics: { scanTruncated: true, privateDiagnostic: 'not-model-input' } },
    regionData: { groups: [], truncated: true, omittedRows: 20 } });
  const payload = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  assert.equal(payload.elements[0].readable, true);
  assert.equal(payload.elements[0].mainFrame, true);
  assert.deepEqual(payload.elements[0].rect, { x: 10, y: 20, width: 300, height: 500 });
  assert.equal(payload.region_data.omittedRows, 20);
  assert.equal(payload.page.scanTruncated, true);
  assert.equal(payload.page.metrics, undefined);
});

test('decision payload reports candidate omissions independently of scan work limits', () => {
  const elements = Array.from({ length: 80 }, (_, index) => ({ id: `e${index + 1}`, name: `Button ${index}` }));
  const messages = buildAgentMessages({ elements, page: { metrics: {
    scanTruncated: false, candidateTruncated: true, omittedCount: 11, returnedCount: 80,
    privateDiagnostic: 'must-not-reach-model',
  } } });
  const payload = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  assert.equal(payload.page.scanTruncated, true);
  assert.equal(payload.page.candidateTruncated, true);
  assert.equal(payload.page.omittedCount, 11);
  assert.equal(payload.page.returnedCount, payload.elements.length);
  assert.equal(payload.page.metrics, undefined);
  assert.doesNotMatch(messages[1].content, /must-not-reach-model/);
});

test('decision payload counts its own element budget without inventing unknown scan omissions', () => {
  const elements = Array.from({ length: 83 }, (_, index) => ({ id: `e${index + 1}` }));
  const payloadFor = metrics => {
    const messages = buildAgentMessages({ elements, page: { metrics } });
    return JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  };
  const known = payloadFor({ scanTruncated: false, omittedCount: 7 });
  assert.equal(known.elements.length, 80);
  assert.equal(known.page.omittedCount, 10);
  assert.equal(known.page.candidateTruncated, true);
  assert.equal(known.page.scanTruncated, true);
  for (const invalid of [-1, Infinity, 'PRIVATE_VALUE', { secret: 'PRIVATE_VALUE' }]) {
    const partial = payloadFor({ scanTruncated: true, omittedCount: invalid });
    assert.equal(partial.page.omittedCount, 3);
    assert.equal(partial.page.returnedCount, 80);
    assert.doesNotMatch(JSON.stringify(partial), /PRIVATE_VALUE/);
  }
});

test('prompt includes goal, page summary and risk-annotated elements', () => {
  const messages = buildAgentMessages({
    goal: '打开第一条搜索结果',
    page: { url: 'https://example.test', title: '搜索', summary: '结果列表', flags: { passwordField: false } },
    elements: [{ id: 'e1', role: 'link', name: '结果一', risk: 'normal' }],
    recent: [{ action: 'click_element', ok: false, error: 'ERR_ELEMENT_MOVED' }],
    step: 2,
    maxSteps: 20,
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /不输入密码/);
  assert.match(messages[0].content, /风险/);
  assert.match(messages[1].content, /打开第一条搜索结果/);
  assert.match(messages[1].content, /"risk":"normal"/);
  assert.match(messages[1].content, /ERR_ELEMENT_MOVED/);
});

test('action labels never echo typed text', () => {
  const label = actionLabel(AGENT_ACTIONS.type, { elementId: 'e1', text: 'secret-value' }, [
    { id: 'e1', name: '邮箱' },
  ]);
  assert.match(label, /邮箱/);
  assert.match(label, /12 个字符/);
  assert.doesNotMatch(label, /secret-value/);
});

test('action signatures remain stable when observation element IDs change', () => {
  const first = actionSignature(
    AGENT_ACTIONS.click,
    { elementId: 'e3' },
    [{ id: 'e3', name: '模型广场' }],
  );
  const second = actionSignature(
    AGENT_ACTIONS.click,
    { elementId: 'e17' },
    [{ id: 'e17', name: '模型广场' }],
  );
  assert.equal(first, second);
  assert.match(first, /模型广场/);
});

test('prompt tells the agent to finish when the current page already has the answer', () => {
  const messages = buildAgentMessages({
    goal: '查余额并找最实惠的 GPT 模型',
    page: { url: 'https://ruoli.dev/pricing', title: '模型广场' },
    elements: [],
  });
  assert.match(messages[0].content, /finish_task/);
  assert.match(messages[0].content, /不要重复点击导航入口/);
  assert.match(messages[0].content, /read_page/);
  assert.match(messages[0].content, /不会再由第二个模型补写/);
  assert.match(messages[0].content, /fail_task/);
});

test('read_page accepts a bounded query and strips model-supplied browser authority', () => {
  const result = normalizeAgentAction({ action: 'read_page', args: { query: 'x'.repeat(500), url: 'https://other.test', script: 'read secrets', taskId: 'forged', approved: true } });
  assert.deepEqual(result.args, { query: 'x'.repeat(200) });
  assert.deepEqual(normalizeAgentAction({ action: 'read_page' }).args, { query: '' });
  assert.match(actionLabel(AGENT_ACTIONS.read, { query: '第三章' }), /第三章/);
  assert.equal(actionSignature(AGENT_ACTIONS.read, { query: '第三章' }), 'read_page:第三章');
});

test('body evidence and post-action feedback reach the model independently from short action logs', () => {
  const body = '正文'.repeat(2500) + 'SECTION_FACT';
  const messages = buildAgentMessages({
    goal: '总结章节', page: { url: 'https://example.test/article', summary: '仅标题' },
    pageReadings: [{ url: 'https://example.test/article', title: '第三章', text: body, capturedAt: '2026-10-30', query: '第三章' }],
    recent: [{ action: 'click', ok: true, observationFeedback: '尚未确认可见变化' }],
  });
  const payload = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  assert.equal(payload.page_readings[0].text, body);
  assert.equal(payload.page_readings[0].capturedAt, '2026-10-30');
  assert.match(payload.recent[0].observation_feedback, /尚未确认/);
});

test('observation links retain only bounded valid HTTP destinations as data', () => {
  const messages = buildAgentMessages({ elements: [
    { id: 'e1', name: 'Chapter', href: 'https://docs.test/chapter#part' },
    { id: 'e2', name: 'Unsafe', href: 'javascript:alert(1)' },
    { id: 'e3', name: 'Huge', href: `https://docs.test/${'x'.repeat(1500)}` },
  ] });
  const payload = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  assert.equal(payload.elements[0].href, 'https://docs.test/chapter#part');
  assert.equal(Object.hasOwn(payload.elements[1], 'href'), false);
  assert.equal(Object.hasOwn(payload.elements[2], 'href'), false);
});

const statePayload = messages => JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
const estimatedDecisionTokens = (messages, tools = agentToolDefinitions(), maxTokens = 1200) =>
  estimateMessagesTokens(messages) + estimateTextTokens(JSON.stringify(tools)) + maxTokens;
const longReadingMessages = (overrides = {}) => buildAgentMessages({
  goal: '总结“第三章”并解释结论，不要丢失这个目标。',
  page: { url: 'https://example.test/chapter', title: '章节', summary: '页面概览' },
  elements: [{ id: 'e1', role: 'link', name: '第三章', href: 'https://example.test/chapter#third' }],
  recent: [{ action: 'read_page', ok: true, observationFeedback: '已读取正文' }],
  facts: [{ text: '已经核对的事实', source: 'https://example.test/chapter' }],
  pageReadings: [0, 1, 2].map(index => ({
    url: `https://example.test/chapter${index}`, title: `第${index}章`, query: '章节',
    text: `${index}正文中的中文论述和证据。`.repeat(600).slice(0, 6000),
    capturedAt: '2026-10-30T10:00:00Z', truncated: false,
  })),
  ...overrides,
});

for (const contextLength of [8000, 16000]) {
  test(`agent budget fits long Chinese readings into ${contextLength} tokens without damaging task JSON`, () => {
    const messages = longReadingMessages();
    const original = structuredClone(messages);
    const fitted = fitAgentMessagesToBudget(messages, { contextLength });
    const { page_readings: beforeReadings, ...before } = statePayload(messages);
    const { page_readings: afterReadings, ...after } = statePayload(fitted);
    assert.ok(estimatedDecisionTokens(fitted) <= contextLength - Math.ceil(contextLength * 0.1));
    assert.deepEqual(after, before, 'goal, elements, page, facts and recent actions must survive intact');
    assert.equal(after.elements[0].href, 'https://example.test/chapter#third');
    assert.equal(afterReadings.length, 3);
    assert.ok(afterReadings.some((reading, index) => reading.text.length < beforeReadings[index].text.length));
    assert.ok(afterReadings.at(-1).text.length > 0, 'the latest reading takes priority');
    afterReadings.forEach((reading, index) => {
      const { text, truncated, ...metadata } = reading;
      const { text: sourceText, truncated: _wasTruncated, ...sourceMetadata } = beforeReadings[index];
      assert.deepEqual(metadata, sourceMetadata);
      assert.ok(sourceText.startsWith(text));
      if (text.length < sourceText.length) assert.equal(truncated, true);
    });
    assert.deepEqual(messages, original, 'request fitting must not alter reusable evidence');
  });
}

test('agent budget defaults to 128k and preserves the complete bounded reading payload', () => {
  const messages = longReadingMessages();
  assert.equal(statePayload(messages).page_readings.reduce((sum, reading) => sum + reading.text.length, 0), 18000);
  for (const contextLength of [undefined, null, 0, -1, 'not a number']) {
    assert.deepEqual(fitAgentMessagesToBudget(messages, { contextLength }), messages);
  }
});

test('agent budget reports a base request overflow without dropping its goal or elements', () => {
  const messages = buildAgentMessages({
    goal: '必须保留的用户目标',
    elements: Array.from({ length: 80 }, (_, index) => ({ id: `e${index}`, name: '重要的页面元素'.repeat(20) })),
  });
  assert.throws(() => fitAgentMessagesToBudget(messages, { contextLength: 8000 }), error =>
    error.code === 'ERR_AGENT_CONTEXT_BUDGET' && /基础指令、目标、页面元素/.test(error.message));
  assert.throws(() => fitAgentMessagesToBudget(buildAgentMessages(), { contextLength: 256 }), error =>
    error.code === 'ERR_AGENT_CONTEXT_BUDGET');
});

test('agent budget includes retry instructions, custom tool schemas and the actual output reserve', () => {
  const messages = longReadingMessages({ supportsVision: false });
  const tools = [...agentToolDefinitions({ supportsVision: false }), { type: 'function', function: { name: 'extra', description: '工具说明'.repeat(150) } }];
  const options = { contextLength: 8000, maxTokens: 1800, tools };
  const first = fitAgentMessagesToBudget(messages, options);
  const correction = { role: 'user', content: '请重新输出有效的工具调用。'.repeat(50) };
  const retried = fitAgentMessagesToBudget([...messages, correction], options);
  assert.deepEqual(retried.at(-1), correction);
  assert.ok(estimatedDecisionTokens(retried, tools, 1800) <= 7200);
  assert.ok(statePayload(retried).page_readings.at(-1).text.length < statePayload(first).page_readings.at(-1).text.length);
});

test('structured navigation and bounded scroll state survive a small-model request budget', () => {
  const container = { id: 'e1', name: '教程目录', role: 'region', scrollOnly: true, stableKey: 'frame:sidebar',
    layout: { region: 'navigation', regionName: '教程目录', position: 'left-middle', visible: true },
    scroll: { top: 262, left: 0, maxTop: 3600, maxLeft: 0, clientHeight: 320, clientWidth: 240, directions: ['up', 'down'], privateField: 'DROP_ME' } };
  const link = { id: 'e2', name: '第20章 MCP', href: 'https://docs.test/#/chapter20', stableKey: 'frame:chapter20',
    layout: { region: 'navigation', regionName: '教程目录', position: 'left-middle', visible: true, scrollContainerId: 'e1', scrollContainerKey: container.stableKey },
    state: { current: 'page', expanded: true, selected: false }, navigation: { kind: 'document' } };
  const messages = buildAgentMessages({ goal: '总结第20章', elements: [container, link],
    page: { viewport: { width: 1000, height: 800 }, scroll: container.scroll, content: { heading: '第20章', text: 'MCP 正文摘要' } },
    pageReadings: [{ url: link.href, title: link.name, text: '中文正文'.repeat(2500) }] });
  const fitted = fitAgentMessagesToBudget(messages, { contextLength: 8000 });
  const payload = statePayload(fitted);
  assert.equal(payload.elements[0].scrollOnly, true);
  assert.equal(payload.elements[0].scroll.top, 262);
  assert.deepEqual(payload.elements[1].state, link.state);
  assert.equal(payload.elements[1].layout.scrollContainerId, 'e1');
  assert.equal(payload.elements[1].navigation.kind, 'document');
  assert.equal(payload.page.content.heading, '第20章');
  assert.equal(payload.page.viewport.width, 1000);
  assert.doesNotMatch(JSON.stringify(payload), /DROP_ME/);
  assert.ok(estimatedDecisionTokens(fitted) <= 7200);
  assert.equal(payload.page_readings[0].truncated, true);
  assert.notEqual(actionSignature('scroll_page', { elementId: 'e1', direction: 'down' }, [container]),
    actionSignature('scroll_page', { elementId: 'e2', direction: 'down' }, [{ ...container, id: 'e2', stableKey: 'frame:main' }]));
  assert.equal(actionSignature('scroll_page', { elementId: 'e1', direction: 'down' }, [container]),
    actionSignature('scroll_page', { elementId: 'e7', direction: 'down' }, [{ ...container, id: 'e7' }]));
});

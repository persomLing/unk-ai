import test from 'node:test';
import assert from 'node:assert/strict';

import { assessAgentAction, classifyElement } from '../src/utils/agent-safety.js';
import { AGENT_ACTIONS } from '../src/utils/agent-schema.js';

const currentUrl = 'https://example.test/app';

test('scroll-only containers cannot be repurposed as clickable or editable targets', () => {
  const elements = [{ id: 'e1', role: 'region', name: '教程目录', scrollOnly: true }];
  for (const action of ['click_element', 'type_text', 'select_option', 'press_key']) {
    assert.equal(assessAgentAction({ action, args: { elementId: 'e1' }, elements, currentUrl }).level, 'blocked');
  }
  assert.equal(assessAgentAction({ action: 'scroll_page', args: { elementId: 'e1' }, elements, currentUrl }).level, 'normal');
});

test('readable regions allow only reading and real-container scrolling, never mutation targets', () => {
  const elements = [{ id: 'e1', role: 'region', name: '商家列表', readable: true, readOnly: true, scroll: { maxTop: 1000 } }];
  for (const action of ['click_element', 'type_text', 'select_option', 'press_key']) {
    assert.equal(assessAgentAction({ action, args: { elementId: 'e1' }, elements, currentUrl }).level, 'blocked');
  }
  assert.equal(assessAgentAction({ action: 'read_region', args: { elementId: 'e1' }, elements, currentUrl }).level, 'normal');
  assert.equal(assessAgentAction({ action: 'read_region', args: { elementId: 'e2' }, elements, currentUrl }).level, 'blocked');
  assert.equal(assessAgentAction({ action: 'scroll_page', args: { elementId: 'e1' }, elements, currentUrl }).level, 'normal');
});
const element = (overrides = {}) => ({
  id: 'e1',
  role: 'button',
  name: '按钮',
  tag: 'button',
  type: '',
  disabled: false,
  ...overrides,
});

test('reading the already authorized page never becomes a mutating action in strict mode', () => {
  assert.deepEqual(assessAgentAction({ action: AGENT_ACTIONS.read, args: { query: '第三章' }, settings: { strictMode: true }, currentUrl }), { level: 'normal', reason: '' });
});

test('password and payment fields are hard blocked', () => {
  assert.equal(classifyElement(element({ tag: 'input', type: 'password', name: '密码' }), { currentUrl }).level, 'blocked');
  assert.equal(classifyElement(element({ tag: 'input', autocomplete: 'cc-csc', name: '安全码' }), { currentUrl }).level, 'blocked');
  assert.equal(classifyElement(element({ name: '确认支付' }), { currentUrl }).level, 'blocked');
  assert.equal(classifyElement(element({ name: '立即购买' }), { currentUrl }).level, 'blocked');
});

test('delete is confirm, search submit is normal, generic submit is confirm', () => {
  assert.equal(classifyElement(element({ name: '删除记录' }), { currentUrl }).level, 'confirm');
  assert.equal(classifyElement(element({ name: '搜索', formRole: 'search', tag: 'button', type: 'submit' }), { currentUrl }).level, 'normal');
  assert.equal(classifyElement(element({ name: '提交订单', type: 'submit' }), { currentUrl }).level, 'blocked');
  assert.equal(classifyElement(element({ name: '提交表单', type: 'submit' }), { currentUrl }).level, 'confirm');
});

test('cross-origin navigation and target blank are treated carefully', () => {
  const cross = classifyElement(element({ tag: 'a', href: 'https://other.test/x', name: '文档' }), { currentUrl });
  assert.equal(cross.level, 'confirm');
  assert.equal(cross.targetOrigin, 'https://other.test');
  assert.equal(classifyElement(element({ tag: 'a', href: 'https://other.test/x', targetBlank: true }), { currentUrl }).level, 'blocked');
  assert.equal(classifyElement(element({ tag: 'a', href: 'javascript:alert(1)' }), { currentUrl }).level, 'blocked');
});

test('strict mode promotes normal actions to confirmation', () => {
  const normal = assessAgentAction({
    action: AGENT_ACTIONS.click,
    args: { elementId: 'e1' },
    elements: [element()],
    currentUrl,
  });
  assert.equal(normal.level, 'normal');
  const strict = assessAgentAction({
    action: AGENT_ACTIONS.click,
    args: { elementId: 'e1' },
    elements: [element()],
    settings: { strictMode: true },
    currentUrl,
  });
  assert.equal(strict.level, 'confirm');
});

test('typing and Enter are confirmation-worthy, password typing is blocked', () => {
  assert.equal(assessAgentAction({
    action: AGENT_ACTIONS.type,
    args: { elementId: 'e1', text: 'x', submit: true },
    elements: [element({ tag: 'input', name: '关键词' })],
    currentUrl,
  }).level, 'confirm');
  assert.equal(assessAgentAction({
    action: AGENT_ACTIONS.type,
    args: { elementId: 'e1', text: 'x' },
    elements: [element({ tag: 'input', type: 'password', name: '密码' })],
    currentUrl,
  }).level, 'blocked');
  assert.equal(assessAgentAction({
    action: AGENT_ACTIONS.press,
    args: { key: 'Enter' },
    elements: [],
    currentUrl,
  }).level, 'confirm');
});

test('navigate marks cross-origin targets for origin approval', () => {
  const result = assessAgentAction({
    action: AGENT_ACTIONS.navigate,
    args: { url: 'https://other.test/page' },
    elements: [],
    currentUrl,
  });
  assert.equal(result.level, 'confirm');
  assert.equal(result.targetOrigin, 'https://other.test');
  assert.equal(assessAgentAction({
    action: AGENT_ACTIONS.navigate,
    args: { url: 'javascript:alert(1)' },
    elements: [],
    currentUrl,
  }).level, 'blocked');
});

test('missing elements and unknown actions are blocked', () => {
  assert.equal(assessAgentAction({
    action: AGENT_ACTIONS.click,
    args: { elementId: 'e9' },
    elements: [],
    currentUrl,
  }).level, 'blocked');
  assert.equal(assessAgentAction({ action: 'run_js', args: {}, elements: [], currentUrl }).level, 'blocked');
});

test('sensitive text fields use labels and DOM field identifiers without autocomplete', () => {
  for (const fields of [{ name: 'CVV' }, { name: 'PIN' }, { name: '输入安全码' }, { name: '', domId: 'userPin' }, { name: '', fieldName: 'account_password' }]) {
    assert.equal(classifyElement(element({ tag: 'input', type: 'text', ...fields }), { currentUrl }).level, 'blocked');
  }
  assert.equal(classifyElement(element({ tag: 'input', type: 'text', name: 'Shipping address' }), { currentUrl }).level, 'normal');
});

test('cross-origin form destinations survive search and strict-mode assessment', () => {
  for (const strictMode of [false, true]) {
    for (const formRole of ['', 'search']) {
      const result = assessAgentAction({
        action: AGENT_ACTIONS.type,
        args: { elementId: 'e1', text: 'query', submit: true },
        elements: [element({ tag: 'input', type: 'text', name: 'Query', formRole, formAction: 'https://other.test/search', formOrigin: 'https://other.test' })],
        currentUrl,
        settings: { strictMode },
      });
      assert.equal(result.level, 'confirm');
      assert.equal(result.targetOrigin, 'https://other.test');
    }
  }
  assert.equal(classifyElement(element({ name: 'Go', type: 'submit' }), { currentUrl }).level, 'confirm');
  assert.equal(assessAgentAction({ action: AGENT_ACTIONS.press, args: { elementId: 'e1', key: 'Enter' }, elements: [element({ name: 'Pay now' })], currentUrl }).level, 'blocked');
});

test('only an explicit task reference upload to a native file input reaches confirmation', () => {
  const uploadReferences = [{ referenceId: 'reference-1', name: 'reference.png', mime: 'image/png', size: 67 }];
  const input = element({ tag: 'input', type: 'file', name: '上传参考图', fileInput: { accept: 'image/*', multiple: false, selectedFileCount: 0 } });
  const assess = (overrides = {}) => assessAgentAction({ action: 'upload_reference_image', args: { elementId: 'e1', referenceId: 'reference-1' },
    elements: [input], uploadReferences, currentUrl, ...overrides });
  assert.equal(assess().level, 'confirm');
  assert.equal(assess({ settings: { strictMode: false } }).level, 'confirm');
  assert.equal(assess({ uploadReferences: [] }).level, 'blocked');
  assert.equal(assess({ args: { elementId: 'e1', referenceId: 'reference-2' } }).level, 'blocked');
  assert.equal(assess({ args: { elementId: 'e1', referenceId: 'reference-1', url: 'https://elsewhere.test/file' } }).level, 'blocked');
  for (const change of [{ tag: 'button', type: '' }, { disabled: true }, { readOnly: true },
    { name: '支付凭据' }, { name: '人机验证图片' }, { formAction: 'https://other.test/receive' },
    { fileInput: { accept: '.pdf' } }, { frameOrigin: 'https://other.test' }]) {
    assert.equal(assess({ elements: [{ ...input, ...change }] }).level, 'blocked');
  }
  for (const action of ['click_element', 'type_text', 'press_key', 'select_option']) {
    assert.equal(assess({ action }).level, 'blocked');
  }
});

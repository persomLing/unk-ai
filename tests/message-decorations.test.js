import test from 'node:test';
import assert from 'node:assert/strict';
import {
  messageErrorMarkup,
  messageModeBadgeMarkup,
  normalizeMessageError,
  syncMessageErrorToggle,
} from '../src/sidepanel/features/messages/message-decorations.js';

test('new error records combine their short reason and distinct diagnostics without changing the record', () => {
  const message = Object.freeze({ status: 'error', errorMessage: '读取第 20 章超时。', errorDetail: '已尝试目录链接。\r\n服务没有在截止时间前返回。' });
  assert.deepEqual(normalizeMessageError(message), {
    summary: '读取第 20 章超时。',
    detail: '已尝试目录链接。\n服务没有在截止时间前返回。',
    text: '读取第 20 章超时。\n已尝试目录链接。\n服务没有在截止时间前返回。',
    expanded: false,
  });
  assert.equal(message.errorDetail.includes('\r\n'), true);
});

test('legacy long error text remains complete and defaults to collapsed independently of thinking', () => {
  const original = '旧错误诊断及剩余执行记录。\n'.repeat(80).trim();
  const message = { status: 'error', errorMessage: original, thinkingExpanded: true, userToggledThinking: true };
  assert.equal(normalizeMessageError(message).text, original);
  assert.equal(normalizeMessageError(message).expanded, false);
  assert.equal(normalizeMessageError({ ...message, errorExpanded: true }).expanded, true);
  assert.match(messageErrorMarkup(message), /aria-expanded="false"/);
  assert.match(messageErrorMarkup({ ...message, errorExpanded: true }), /message-error is-expanded/);
});

test('legacy Agent errors and new diagnostics never repeat an identical normal answer', () => {
  const answer = '完整答案第一段。\n完整答案第二段。';
  const legacy = normalizeMessageError({ status: 'error', agent: {}, content: answer, errorMessage: ` ${answer.replaceAll('\n', '\r\n')} ` });
  assert.equal(legacy.text, '浏览器任务未完成。');
  const current = normalizeMessageError({ status: 'error', agent: {}, content: answer, errorMessage: '任务未完成。', errorDetail: answer });
  assert.equal(current.text, '任务未完成。');
  assert.doesNotMatch(messageErrorMarkup({ id: 'old', status: 'error', agent: {}, content: answer, errorMessage: answer }), /完整答案/);
});

test('related but different diagnostics are retained, and repeated short reasons appear only once', () => {
  const answer = '未读取第 20 章。';
  assert.equal(normalizeMessageError({ status: 'error', content: answer, errorMessage: `${answer}网络请求超时。` }).text, `${answer}网络请求超时。`);
  assert.equal(normalizeMessageError({ status: 'error', errorMessage: '超时。', errorDetail: '超时。' }).text, '超时。');
  assert.equal(normalizeMessageError({ status: 'error', errorMessage: '超时。', errorDetail: '超时。\n完整诊断' }).text, '超时。\n完整诊断');
  assert.equal(normalizeMessageError({ status: 'complete', errorMessage: '过去的错误' }), null);
  assert.equal(messageErrorMarkup({ status: 'stopped', errorMessage: '过去的错误' }), '');
});

test('error markup escapes diagnostics and identifiers and supplies accessible independent controls', () => {
  const html = messageErrorMarkup({ id: 'a"<>', status: 'error', errorMessage: '<script>alert(1)</script>', errorExpanded: true });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /aria-controls="message-error-a%22%3C%3E"/);
  assert.match(html, /data-action="toggle-error"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, / hidden>收起<\/button>/);
  assert.doesNotMatch(html, /toggle-thinking/);
});

test('only user messages with persisted true agentTask get the page-operation badge', () => {
  const question = { role: 'user', content: '找到 MCP 章节并总结' };
  assert.equal(messageModeBadgeMarkup(question), '');
  assert.equal(messageModeBadgeMarkup({ ...question, agentTask: false }), '');
  assert.equal(messageModeBadgeMarkup({ ...question, agentTask: 'true' }), '');
  const operation = messageModeBadgeMarkup({ ...question, agentTask: true });
  assert.match(operation, /message-mode-badge/);
  assert.match(operation, /页面操作/);
  assert.match(operation, /以页面操作模式发送/);
  assert.equal(messageModeBadgeMarkup({ role: 'assistant', agentTask: true }), '');
});

test('reused interface evidence is named in the collapsed label and keeps its original-time explanation', () => {
  const html = messageModeBadgeMarkup({ role: 'user', pageSource: { reading: {
    networkStatus: 'reused', networkCount: 2,
    networkNote: '原采集时间：2026-11-05T07:00:00.000Z。本轮未重新监听。<script>网页资料</script>',
  } } });
  assert.match(html, /<summary>已复用接口资料 · 2 个接口响应<\/summary>/);
  assert.match(html, /2026-11-05T07:00:00.000Z/);
  assert.match(html, /本轮未重新监听/);
  assert.doesNotMatch(html, /<script>/);
});

function errorLayout(height, { width = 240, lineHeight = '18.4px' } = {}) {
  const detail = { clientWidth: width, scrollHeight: height, ownerDocument: { defaultView: { getComputedStyle: () => ({ lineHeight }) } } };
  const toggle = { hidden: true };
  const card = { querySelector(selector) { return selector === '.message-error-detail' ? detail : toggle; } };
  return { root: { querySelectorAll: () => [card] }, detail, toggle };
}

test('short errors need no toggle while genuinely wrapped long errors can be expanded', () => {
  const short = errorLayout(18);
  syncMessageErrorToggle(short.root);
  assert.equal(short.toggle.hidden, true);
  const twoLines = errorLayout(37);
  syncMessageErrorToggle(twoLines.root);
  assert.equal(twoLines.toggle.hidden, true);
  const threeLines = errorLayout(55);
  syncMessageErrorToggle(threeLines.root);
  assert.equal(threeLines.toggle.hidden, false);
});

test('resize remeasurement handles 320px panels and keeps the collapse control on expanded long details', () => {
  const layout = errorLayout(37, { width: 440 });
  syncMessageErrorToggle(layout.root);
  assert.equal(layout.toggle.hidden, true);
  layout.detail.clientWidth = 236;
  layout.detail.scrollHeight = 74;
  syncMessageErrorToggle(layout.root);
  assert.equal(layout.toggle.hidden, false);
  layout.detail.clientHeight = 74; // All text is visible after expansion.
  syncMessageErrorToggle(layout.root);
  assert.equal(layout.toggle.hidden, false);
  layout.detail.clientWidth = 440;
  layout.detail.scrollHeight = 37;
  syncMessageErrorToggle(layout.root);
  assert.equal(layout.toggle.hidden, true);
});

test('unlaid-out and missing error cards are harmless until they have measurable text', () => {
  const layout = errorLayout(300, { width: 0 });
  syncMessageErrorToggle(layout.root);
  assert.equal(layout.toggle.hidden, true);
  assert.doesNotThrow(() => syncMessageErrorToggle(null));
  assert.doesNotThrow(() => syncMessageErrorToggle({ querySelectorAll: () => [{ querySelector: () => null }] }));
});

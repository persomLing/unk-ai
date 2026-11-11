import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMessagesFor, fitMessagesToBudget, estimateMessagesTokens, trimTextToTokenBudget, estimateTextTokens } from '../src/utils/context.js';
import { finalizePendingTurn, pageSourceFor } from '../src/utils/turn-source.js';
import { pageControlState, pageFaviconUrl, isReadablePageUrl } from '../src/sidepanel/features/page-reading/page-control-state.js';
import { storageBadgeState } from '../src/sidepanel/features/storage/storage-state.js';

const a = { url: 'https://test.invalid/model/a', title: 'Pricing', text: 'Model A costs $0.04.' };
const b = { url: 'https://test.invalid/model/b', title: 'Pricing', text: 'Model B costs $0.20.', capturedAt: '2026-10-30T06:49:05Z' };
function conversation(enabled = true) {
  return { messages: [
    { id: 'u1', role: 'user', content: '按6.8换算', pageSource: pageSourceFor(a), status: 'complete' },
    { id: 'a1', role: 'assistant', content: 'A is 0.272 yuan', sources: [{ url: a.url }], status: 'complete' },
    { id: 'u2', role: 'user', content: '这个呢', pageSource: pageSourceFor(b), pageContextEnabled: enabled, status: 'complete' },
    { id: 'a2', role: 'assistant', content: '', status: 'streaming' },
  ] };
}
test('new page follows the old answer and belongs to the latest question', () => {
  const messages = requestMessagesFor(conversation(), 'a2', b);
  const index = messages.findIndex(m => m.content.includes('<page_content>'));
  assert.equal(messages[index - 1].role, 'assistant');
  assert.match(messages[index - 1].content, /model\/a/);
  assert.match(messages[index].content, /本轮已切换页面/);
  assert.match(messages[index + 1].content, /这个呢/);
  assert.equal(messages.filter(m => m.content.includes('<page_content>')).length, 1);
});
test('page switch off excludes the page body even with a cached conversation page', () => {
  const messages = requestMessagesFor(conversation(false), 'a2', b);
  assert.ok(!JSON.stringify(messages).includes(b.text));
});
test('retry of an old source never substitutes another page body', () => {
  const c = conversation();
  const messages = requestMessagesFor(c, 'a1', b);
  assert.ok(!JSON.stringify(messages).includes(b.text));
  assert.match(JSON.stringify(messages), /正文目前不可用/);
});
test('failed page reading never lets a retry use an older cached body at the same URL', () => {
  const c = conversation();
  c.messages[2].pageSource = { ...pageSourceFor(b), unavailable: true };
  const messages = requestMessagesFor(c, 'a2', b);
  assert.ok(!JSON.stringify(messages).includes(b.text));
  assert.match(JSON.stringify(messages), /正文目前不可用/);
});
test('same URL with a different capture version is not the original turn page', () => {
  const messages = requestMessagesFor(conversation(), 'a2', { ...b, capturedAt: '2026-10-30T07:00:00Z' });
  assert.ok(!JSON.stringify(messages).includes(b.text));
});
test('cloned optimistic turn is finalized by id and both messages survive saving', () => {
  const early = { id: 'u', role: 'user', content: 'question', optimistic: true };
  const c = structuredClone({ messages: [early, { id: 'a', role: 'assistant', optimistic: true, status: 'stopped' }] });
  const turn = finalizePendingTurn(c, 'u', 'a', { pageSource: pageSourceFor(b) });
  assert.equal(turn.assistant.status, 'streaming');
  assert.equal(c.messages.filter(m => !m.optimistic).length, 2);
  assert.equal(c.messages.filter(m => m.role === 'user').length, 1);
});
test('large single question is explicitly rejected rather than exceeding budget', () => {
  const c = { messages: [{ role: 'user', content: '中'.repeat(10000) }] };
  assert.throws(() => fitMessagesToBudget(c, requestMessagesFor(c, null, null), 8192, 1000), /超过模型上下文/);
});
test('bounded page context keeps current question and request under the hard budget', () => {
  const c = conversation();
  const messages = requestMessagesFor(c, 'a2', { ...b, text: '文'.repeat(18000) });
  const result = fitMessagesToBudget(c, messages, 8192, 1000);
  assert.ok(estimateMessagesTokens(result) <= Math.floor(8192 * .97) - 1000);
  assert.match(result.at(-1).content, /这个呢/);
  assert.match(JSON.stringify(result), /预算截断/);
});
test('text truncation observes its own estimate and output reservation is validated', () => {
  assert.ok(estimateTextTokens(trimTextToTokenBudget('中'.repeat(2000), 300)) <= 300);
  assert.throws(() => fitMessagesToBudget({}, [{ role: 'user', content: 'ok' }], 8192, 8192), /输出预算/);
});
test('source control uses the new browser URL even when both pages have the same title', () => {
  const state = pageControlState({ active: b, page: a });
  assert.equal(state.url, b.url);
  assert.equal(state.changed, true);
  assert.match(state.status, /页面已切换/);
  assert.match(pageControlState({ active: b, enabled: false }).status, /不读取/);
});
test('browser internal pages and restricted extension stores do not offer page reading', () => {
  for (const url of ['chrome://newtab', 'about:blank', 'chrome-extension://abc/page.html', 'https://chromewebstore.google.com/detail/test', 'https://chrome.google.com/webstore/detail/test']) {
    assert.equal(isReadablePageUrl(url), false);
    assert.equal(pageControlState({ active: { url } }).available, false);
    assert.equal(pageFaviconUrl({ url }), '');
  }
  assert.equal(isReadablePageUrl('file:///D:/article.html'), true);
  assert.equal(isReadablePageUrl('https://example.com/article'), true);
});
test('page icons use a safe supplied favicon with a same-site fallback', () => {
  assert.equal(pageFaviconUrl({ url: a.url, favIconUrl: 'https://test.invalid/icon.png' }), 'https://test.invalid/icon.png');
  assert.equal(pageFaviconUrl({ url: a.url, favIconUrl: 'javascript:alert(1)' }), 'https://test.invalid/favicon.ico');
  assert.equal(pageFaviconUrl({ url: 'file:///D:/article.html' }), '');
  assert.equal(pageFaviconUrl({ url: a.url, favIconUrl: 'data:image/png;base64,aA==' }), 'data:image/png;base64,aA==');
});
test('pending and failed saves are never labelled saved to a folder', () => {
  assert.match(storageBadgeState({}, { temporary: false, syncStatus: 'pending' }).label, /待同步/);
  assert.match(storageBadgeState({}, { syncStatus: 'error' }).label, /尚未保存/);
});

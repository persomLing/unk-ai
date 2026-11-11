import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pageContextEnabledForNavigation,
  pageControlState,
} from '../src/sidepanel/features/page-reading/page-control-state.js';

const article = { tabId: 7, url: 'https://example.test/article', title: 'Article' };

test('readable pages use the user preference, including after unavailable tabs', () => {
  for (const previous of [null, undefined, { tabId: 7, url: 'chrome://newtab' }, { tabId: 7, url: 'about:blank' }]) {
    assert.equal(pageContextEnabledForNavigation(previous, article, false), false);
    assert.equal(pageContextEnabledForNavigation(previous, article, true), true);
  }
  assert.equal(pageContextEnabledForNavigation(null, { id: 7, url: 'file:///D:/article.pdf' }, false), false);
});

test('a different tab or page URL preserves a manually closed switch', () => {
  for (const next of [
    { ...article, tabId: 8 },
    { id: 8, url: article.url },
    { ...article, url: 'https://example.test/another' },
    { ...article, url: 'https://example.test/article?page=2' },
    { ...article, url: 'http://example.test/article' },
  ]) assert.equal(pageContextEnabledForNavigation(article, next, false), false);
});

test('same-page polls and presentation or focus changes preserve the manual switch', () => {
  for (const next of [
    { ...article },
    { ...article, title: 'Updated title', favIconUrl: 'https://example.test/icon.png' },
    { ...article, windowId: 2, active: true, focused: true, observedAt: 700 },
    { id: 7, url: article.url },
    { url: article.url },
  ]) {
    assert.equal(pageContextEnabledForNavigation(article, next, false), false);
    assert.equal(pageContextEnabledForNavigation(article, next, true), true);
  }
  assert.equal(pageContextEnabledForNavigation({ url: article.url }, article, false), false);
});

test('anchors, tracking changes and hash routes all preserve the chosen mode', () => {
  const previous = { ...article, url: article.url + '?utm_source=feed#intro' };
  const next = { ...article, url: article.url + '?utm_source=email&gclid=campaign#conclusion' };
  assert.equal(pageContextEnabledForNavigation(previous, next, false), false);
  for (const prefix of ['#/', '#!/']) {
    assert.equal(pageContextEnabledForNavigation(
      { ...article, url: 'https://example.test/' + prefix + 'one' },
      { ...article, url: 'https://example.test/' + prefix + 'two' },
      false,
    ), false);
  }
});

test('source hints distinguish chosen scope from actual reading and target changes', () => {
  assert.equal(pageControlState({ active: article }).label, '基于当前页');
  assert.equal(pageControlState({ active: article, enabled: false }).label, '普通提问');
  assert.match(pageControlState({ active: article }).status, /发送时读取/);
  for (const [status, expected] of [['reading', /正在读取/], ['read', /已读取.*重新读取/], ['failed', /读取失败/], ['stopped', /已停止/]]) {
    assert.match(pageControlState({ active: article, activity: { target: article, status } }).status, expected);
  }
  assert.match(pageControlState({ active: article, draftPageChanged: true }).status, /页面已切换/);
  assert.match(pageControlState({ active: { ...article, tabId: 8 }, activity: { target: article, status: 'reading' } }).status, /已提交的原页/);
  assert.doesNotMatch(pageControlState({ active: { ...article, tabId: 8 }, activity: { target: article, status: 'read' } }).status, /已读取/);
});

test('unreadable pages stay unavailable under the existing display rules', () => {
  for (const url of [
    '', 'not a URL', 'chrome://newtab', 'about:blank', 'chrome-extension://id/panel.html',
    'https://chromewebstore.google.com/detail/test', 'https://chrome.google.com/webstore/detail/test',
  ]) {
    const next = { tabId: 8, url };
    assert.equal(pageContextEnabledForNavigation(article, next, true), false);
    assert.equal(pageControlState({ active: next }).available, false);
  }
  assert.equal(pageContextEnabledForNavigation(article, null, true), false);
});

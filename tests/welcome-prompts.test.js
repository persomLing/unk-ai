import test from 'node:test';
import assert from 'node:assert/strict';

import {
  currentDatePrompt,
  pageKindFor,
  welcomePromptsFor,
} from '../src/sidepanel/features/welcome/welcome-prompts.js';
import { isReadablePageUrl } from '../src/sidepanel/features/page-reading/page-control-state.js';

const now = new Date('2026-10-29T16:30:00Z');

test('classifies common page kinds from URL and title without reading content', () => {
  assert.equal(pageKindFor({ url: 'https://github.com/foo/bar' }), 'repository');
  assert.equal(pageKindFor({ url: 'https://example.test/report.pdf', title: 'Report' }), 'pdf');
  assert.equal(pageKindFor({ url: 'file:///D:/reports/report.pdf' }), 'pdf');
  assert.equal(pageKindFor({ url: 'https://example.test/docs/start' }), 'docs');
  assert.equal(pageKindFor({ url: 'https://www.bilibili.com/video/BV1' }), 'video');
  assert.equal(pageKindFor({ url: 'https://www.google.com/search?q=test' }), 'search');
  assert.equal(pageKindFor({ url: 'https://stackoverflow.com/questions/1' }), 'qa');
  assert.equal(pageKindFor({ url: 'https://example.test/article' }), 'page');
});

test('welcome classification shares the page control readability boundary', () => {
  for (const url of [
    'https://example.test/article',
    'file:///D:/reports/page.html',
    'chrome://settings',
    'chrome-extension://example/page.html',
    'about:blank',
    'https://chromewebstore.google.com/detail/example',
    'https://chrome.google.com/webstore/detail/example',
    'https://chrome.google.com/other',
    'https://chromewebstore.google.com.example.test/article',
    'not a URL',
    '',
  ]) {
    assert.equal(pageKindFor({ url }) !== 'no-page', isReadablePageUrl(url), url);
  }
});

test('readable pages offer summarization while unavailable pages focus the composer', () => {
  const page = welcomePromptsFor({ url: 'https://example.test/article' }, { now });
  assert.equal(page.primary.action, 'summarize-page');
  assert.equal(page.primary.label, '总结当前页');
  assert.equal(page.secondary, null);

  const unavailable = welcomePromptsFor({ url: 'chrome://settings' }, { now });
  assert.equal(unavailable.primary.action, 'focus-input');
  assert.equal(unavailable.primary.label, '直接提问');
  assert.equal(unavailable.primary.prompt, '');
  assert.equal(unavailable.secondary, null);
});

test('specialized pages offer at most one secondary action that only fills a draft', () => {
  for (const [url, id] of [
    ['https://github.com/foo/bar', 'repository-entry'],
    ['file:///D:/report.pdf', 'pdf-key-points'],
    ['https://example.test/docs/start', 'docs-pitfalls'],
    ['https://stackoverflow.com/questions/1', 'qa-solutions'],
    ['https://www.bilibili.com/video/BV1', 'video-notes'],
    ['https://www.google.com/search?q=test', 'search-comparison'],
  ]) {
    const { secondary } = welcomePromptsFor({ url }, { now });
    assert.equal(Array.isArray(secondary), false);
    assert.equal(secondary.id, id);
    assert.equal(secondary.action, 'fill-prompt');
    assert.equal(secondary.send, undefined);
    assert.ok(secondary.prompt);
    assert.ok(secondary.description);
  }
});

test('every welcome state offers the same four topics with news and AI first', () => {
  for (const url of ['chrome://settings', 'https://example.test/article', 'file:///D:/report.pdf']) {
    const welcome = welcomePromptsFor({ url }, { now });
    assert.deepEqual(welcome.topics.map(({ id, label }) => [id, label]), [
      ['news', '国内外大事'],
      ['ai', 'AI圈动态'],
      ['tech', '科技新品'],
      ['business', '商业与市场'],
    ]);
    for (const topic of welcome.topics) {
      assert.equal(topic.action, 'fill-prompt');
      assert.equal(topic.send, undefined);
      for (const field of ['id', 'label', 'description', 'icon', 'prompt']) {
        assert.equal(typeof topic[field], 'string');
        assert.ok(topic[field].length > 0);
      }
    }
    assert.equal(welcome.tryPrompt, undefined);
    assert.equal(welcome.suggestions, undefined);
  }
});

test('live topic drafts specify time windows, evidence and honest search limits', () => {
  const { topics } = welcomePromptsFor({}, { now });
  for (const { prompt } of topics) {
    assert.match(prompt, /北京时间 2026年10月30日 00:30/);
    assert.match(prompt, /近24小时/);
    assert.match(prompt, /近7日/);
    assert.match(prompt, /来源链接/);
    assert.match(prompt, /发布时间/);
    assert.match(prompt, /事件发生时间（未知请注明）/);
    assert.match(prompt, /区分事实与可能影响/);
    assert.match(prompt, /合并重复报道/);
    assert.match(prompt, /无法联网请明说/);
    assert.match(prompt, /不编造时事/);
    assert.match(prompt, /可信信息不足时宁缺毋滥/);
  }
});

test('Beijing dates cross UTC day and year boundaries and refresh between calls', () => {
  assert.match(currentDatePrompt(new Date('2026-12-31T16:05:00Z')), /北京时间 2027年01月01日 00:05/);
  const before = welcomePromptsFor({}, { now: new Date('2026-10-29T15:59:00Z') });
  const after = welcomePromptsFor({}, { now: new Date('2026-10-29T16:00:00Z') });
  assert.match(before.topics[0].prompt, /2026年10月29日 23:59/);
  assert.match(after.topics[0].prompt, /2026年10月30日 00:00/);
});

test('building welcome data only inspects URL and title metadata', () => {
  const tab = {
    url: 'https://example.test/article',
    title: 'An article',
    get body() { throw new Error('must not read page body'); },
    get document() { throw new Error('must not access a page document'); },
    get content() { throw new Error('must not request page content'); },
  };
  assert.equal(welcomePromptsFor(tab, { now }).kind, 'page');
});


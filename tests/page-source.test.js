import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePageUrl,
  resolvePageSource,
} from '../src/sidepanel/features/page-reading/page-source.js';

test('reuses the existing reading for the same normalized URL', () => {
  const decision = resolvePageSource({
    oldUrl: 'https://EXAMPLE.com/docs/guide?utm_source=feed&gclid=abc#intro',
    activeUrl: 'https://example.com/docs/guide?fbclid=xyz#install',
    title: '  Installation guide  ',
    explicitPageRequest: true,
  });

  assert.deepEqual(decision, {
    sourceState: 'same',
    action: 'use-existing',
    oldUrl: 'https://example.com/docs/guide',
    activeUrl: 'https://example.com/docs/guide',
    title: 'Installation guide',
    explicitPageRequest: true,
  });
});

test('ignores hash and tracking parameters but preserves meaningful query data', () => {
  assert.equal(
    normalizePageUrl('https://example.com/search?utm_medium=email&q=alpha&page=2#results'),
    'https://example.com/search?q=alpha&page=2',
  );
  assert.equal(
    normalizePageUrl('https://example.com/article?id=7&UTM_SOURCE=feed'),
    'https://example.com/article?id=7',
  );
  assert.notEqual(
    normalizePageUrl('https://example.com/search?q=alpha&page=2'),
    normalizePageUrl('https://example.com/search?q=alpha&page=3'),
  );
});

test('detects different paths as different sources without automatic overwrite', () => {
  const decision = resolvePageSource({
    oldUrl: 'https://example.com/course/one',
    activeUrl: 'https://example.com/course/two',
    explicitPageRequest: false,
  });

  assert.equal(decision.sourceState, 'different');
  assert.equal(decision.action, 'check-active');
});

test('reads the active page when the user explicitly references a different page', () => {
  const decision = resolvePageSource({
    oldUrl: 'https://example.com/course/one',
    activeUrl: 'https://example.com/course/two#lesson',
    title: 'Course two',
    explicitPageRequest: true,
  });

  assert.equal(decision.sourceState, 'different');
  assert.equal(decision.action, 'read-active');
  assert.equal(decision.oldUrl, 'https://example.com/course/one');
  assert.equal(decision.activeUrl, 'https://example.com/course/two');
});

test('checks the active page when there is no old page', () => {
  const decision = resolvePageSource({
    oldUrl: '',
    activeUrl: 'https://example.com/new-page',
    explicitPageRequest: false,
  });

  assert.equal(decision.sourceState, 'no-old');
  assert.equal(decision.action, 'check-active');
  assert.equal(decision.oldUrl, null);
});

test('reads the active page when there is no old page and access is explicit', () => {
  const decision = resolvePageSource({
    activeUrl: 'https://example.com/new-page',
    explicitPageRequest: true,
  });

  assert.equal(decision.sourceState, 'no-old');
  assert.equal(decision.action, 'read-active');
});

test('keeps the existing source when there is no active URL', () => {
  const decision = resolvePageSource({
    oldUrl: 'https://example.com/previous-page',
    activeUrl: '',
    explicitPageRequest: true,
  });

  assert.equal(decision.sourceState, 'no-active');
  assert.equal(decision.action, 'use-existing');
  assert.equal(decision.oldUrl, 'https://example.com/previous-page');
  assert.equal(decision.activeUrl, null);
});

test('fails closed for malformed and unsupported URLs', () => {
  assert.equal(normalizePageUrl('not a valid URL'), null);
  assert.equal(normalizePageUrl('/relative/path'), null);
  assert.equal(normalizePageUrl('javascript:alert(1)'), null);

  const decision = resolvePageSource({
    oldUrl: 'not a valid URL',
    activeUrl: 'https://example.com/valid-page',
    explicitPageRequest: false,
  });

  assert.equal(decision.sourceState, 'no-old');
  assert.equal(decision.action, 'check-active');
  assert.equal(decision.oldUrl, null);
});

test('force refresh rereads an unchanged URL without inventing a page when none is active', () => {
  assert.equal(resolvePageSource({ oldUrl: 'https://example.test/page', activeUrl: 'https://example.test/page', forceRefresh: true }).action, 'read-active');
  assert.equal(resolvePageSource({ oldUrl: 'https://example.test/page', forceRefresh: true }).action, 'use-existing');
});

test('hash routes distinguish SPA pages while article anchors share a source', () => {
  assert.notEqual(normalizePageUrl('https://example.test/#/one'), normalizePageUrl('https://example.test/#/two'));
  assert.notEqual(normalizePageUrl('https://example.test/#!/one'), normalizePageUrl('https://example.test/#!/two'));
  assert.equal(normalizePageUrl('https://example.test/#intro'), normalizePageUrl('https://example.test/#end'));
});

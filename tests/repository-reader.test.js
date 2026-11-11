import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RepositoryReaderError,
  isSupportedRepositoryUrl,
  parseRepositoryUrl,
  readRepository,
  repositoryContextSummary,
  repositoryProviderForUrl,
} from '../src/utils/repository-reader.js';

const GITHUB_URL = 'https://github.com/acme/demo';
const GITHUB_API = 'https://api.github.com/repos/acme/demo';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(value, status = 200) {
  return new Response(value, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function createGithubFetch() {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url === GITHUB_API) {
      return jsonResponse({
        full_name: 'acme/demo',
        default_branch: 'main',
      });
    }
    if (url === `${GITHUB_API}/git/trees/main?recursive=1`) {
      return jsonResponse({
        truncated: false,
        tree: [
          { path: 'README.md', type: 'blob', size: 20, sha: 'readme-sha' },
        ],
      });
    }
    if (url.startsWith('https://raw.githubusercontent.com/acme/demo/main/')) {
      return textResponse('# Demo\n\nRepository source.');
    }
    return textResponse('unexpected request', 500);
  };
  return { fetch, calls };
}

test('parseRepositoryUrl normalizes GitHub repository, tree, and blob URLs', () => {
  assert.deepEqual(parseRepositoryUrl(GITHUB_URL), {
    provider: 'github',
    owner: 'acme',
    repo: 'demo',
    branch: null,
    path: null,
    kind: 'repository',
    canonicalUrl: GITHUB_URL,
  });
  assert.deepEqual(parseRepositoryUrl('https://github.com/acme/demo/tree/main/src'), {
    provider: 'github',
    owner: 'acme',
    repo: 'demo',
    branch: 'main',
    path: 'src',
    kind: 'directory',
    canonicalUrl: GITHUB_URL,
  });
  assert.deepEqual(parseRepositoryUrl('https://github.com/acme/demo/blob/main/src/index.js'), {
    provider: 'github',
    owner: 'acme',
    repo: 'demo',
    branch: 'main',
    path: 'src/index.js',
    kind: 'file',
    canonicalUrl: GITHUB_URL,
  });
});

test('parseRepositoryUrl recognizes GitLab subgroups and source views', () => {
  assert.deepEqual(
    parseRepositoryUrl('https://gitlab.com/acme/platform/demo/-/tree/main/src'),
    {
      provider: 'gitlab',
      owner: 'acme/platform',
      repo: 'demo',
      branch: 'main',
      path: 'src',
      kind: 'directory',
      canonicalUrl: 'https://gitlab.com/acme/platform/demo',
    },
  );
  assert.deepEqual(
    parseRepositoryUrl('https://gitlab.com/acme/platform/demo/-/blob/main/src/index.js'),
    {
      provider: 'gitlab',
      owner: 'acme/platform',
      repo: 'demo',
      branch: 'main',
      path: 'src/index.js',
      kind: 'file',
      canonicalUrl: 'https://gitlab.com/acme/platform/demo',
    },
  );
});

test('parseRepositoryUrl recognizes Gitee and Bitbucket repository URLs', () => {
  assert.deepEqual(parseRepositoryUrl('https://gitee.com/acme/demo/tree/main/src'), {
    provider: 'gitee',
    owner: 'acme',
    repo: 'demo',
    branch: 'main',
    path: 'src',
    kind: 'directory',
    canonicalUrl: 'https://gitee.com/acme/demo',
  });
  assert.deepEqual(parseRepositoryUrl('https://bitbucket.org/acme/demo/src/main/src/index.js'), {
    provider: 'bitbucket',
    owner: 'acme',
    repo: 'demo',
    branch: 'main',
    path: 'src/index.js',
    kind: 'file',
    canonicalUrl: 'https://bitbucket.org/acme/demo',
  });
});

test('provider helpers reject non-repository pages and lookalike domains', () => {
  const rejected = [
    'https://example.com/acme/demo',
    'https://github.com.evil.test/acme/demo',
    'https://gitlab.com/explore/projects',
    'https://gitlab.com/acme/demo/-/issues/1',
    'https://gitee.com/acme/demo/issues',
    'https://bitbucket.org/acme/demo/pull-requests',
    'https://github.com/acme/demo/issues',
  ];
  for (const value of rejected) {
    assert.equal(parseRepositoryUrl(value), null, value);
    assert.equal(repositoryProviderForUrl(value), null, value);
    assert.equal(isSupportedRepositoryUrl(value), false, value);
  }

  assert.equal(repositoryProviderForUrl('https://gitlab.com/acme/demo'), 'gitlab');
  assert.equal(isSupportedRepositoryUrl('https://bitbucket.org/acme/demo'), true);
});

test('readRepository forwards injected fetch to the GitHub adapter', async () => {
  const fixture = createGithubFetch();
  const result = await readRepository(GITHUB_URL, {
    fetch: fixture.fetch,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });

  assert.equal(fixture.calls[0], GITHUB_API);
  assert.equal(result.structure.github.readFiles[0], 'README.md');
  assert.match(result.text, /Repository source/);
});

test('recognized providers without readers fail before requesting the network', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return jsonResponse({});
  };

  await assert.rejects(
    readRepository('https://gitlab.com/acme/demo', { fetch }),
    (error) => error instanceof RepositoryReaderError
      && error.code === 'provider-unsupported'
      && error.provider === 'gitlab',
  );
  assert.equal(called, false);
});

test('invalid repository URLs fail with invalid-url', async () => {
  await assert.rejects(
    readRepository('https://example.com/acme/demo'),
    (error) => error instanceof RepositoryReaderError
      && error.code === 'invalid-url'
      && error.provider === null,
  );
});

test('GitHub read failures are propagated unchanged', async () => {
  const fetch = async (url) => {
    assert.equal(url, GITHUB_API);
    return jsonResponse({ message: 'Not Found' }, 404);
  };

  await assert.rejects(
    readRepository(GITHUB_URL, { fetch }),
    (error) => error.name === 'GithubRepoError'
      && error.code === 'http'
      && error.status === 404,
  );
});

test('repositoryContextSummary is bounded provenance rather than source text', async () => {
  const fixture = createGithubFetch();
  const result = await readRepository(GITHUB_URL, {
    fetch: fixture.fetch,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });
  const summary = repositoryContextSummary(result, 180);

  assert.ok(summary.length <= 180);
  assert.match(summary, /来源：GitHub/);
  assert.match(summary, /仓库：acme\/demo/);
  assert.match(summary, /README\.md/);
  assert.doesNotMatch(summary, /Repository source/);
  assert.equal(repositoryContextSummary(result, 0), '');
});

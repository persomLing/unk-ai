import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGithubRepoUrl,
  parseGithubRepoUrl,
  readGithubRepository,
} from '../src/utils/github-repo.js';
import {
  normalizePageContext,
  pageContextForModel,
} from '../src/utils/reading-context.js';

const REPO_URL = 'https://github.com/acme/demo';
const REPO_API = 'https://api.github.com/repos/acme/demo';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...headers,
    },
  });
}

function tree(entries, truncated = false) {
  return { sha: 'tree-sha', truncated, tree: entries };
}

function blob(path, size = 20) {
  return { path, mode: '100644', type: 'blob', size, sha: `sha-${path}` };
}

function metadata(overrides = {}) {
  return {
    full_name: 'acme/demo',
    default_branch: 'main',
    description: 'A focused demo repository',
    topics: ['demo', 'reader'],
    language: 'JavaScript',
    stargazers_count: 42,
    forks_count: 7,
    license: { spdx_id: 'MIT' },
    ...overrides,
  };
}

function createApiFixture({
  repo = metadata(),
  treeData = tree([
    blob('README.md'),
    blob('package.json'),
    blob('src/index.js'),
    blob('src/feature.js'),
  ]),
  files = {
    'README.md': '# Demo\n\nRead me first.',
    'package.json': '{"name":"demo","main":"src/index.js"}',
    'src/index.js': 'export const demo = true;',
    'src/feature.js': 'export const feature = true;',
  },
  rawStatus = {},
} = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === REPO_API) return jsonResponse(repo);
    if (url.startsWith(`${REPO_API}/git/trees/`)) return jsonResponse(treeData);
    const prefix = 'https://raw.githubusercontent.com/acme/demo/main/';
    if (url.startsWith(prefix)) {
      const path = decodeURIComponent(url.slice(prefix.length));
      const status = rawStatus[path] || 200;
      if (status !== 200) return textResponse('not found', status);
      if (!(path in files)) return textResponse('not found', 404);
      return textResponse(files[path]);
    }
    return textResponse('unexpected URL', 500);
  };
  return { fetch, calls };
}

test('GitHub repository URLs are validated and parsed without accepting lookalike hosts', () => {
  assert.equal(isGithubRepoUrl(REPO_URL), true);
  assert.equal(isGithubRepoUrl('https://github.com/acme/demo/tree/main/src'), true);
  assert.equal(isGithubRepoUrl('https://github.com/acme/demo.git'), true);
  assert.equal(isGithubRepoUrl('https://github.com.evil.test/acme/demo'), false);
  assert.equal(isGithubRepoUrl('https://api.github.com/repos/acme/demo'), false);
  assert.equal(isGithubRepoUrl('https://github.com/acme/demo/issues'), false);
  assert.equal(isGithubRepoUrl('https://github.com/acme/demo/tree/main%2F..%2Fevil'), false);
  assert.equal(isGithubRepoUrl('ftp://github.com/acme/demo'), false);
  assert.equal(isGithubRepoUrl('not a url'), false);

  assert.deepEqual(parseGithubRepoUrl(REPO_URL), {
    owner: 'acme',
    repo: 'demo',
    branch: null,
    path: null,
    kind: 'repository',
    canonicalUrl: REPO_URL,
  });
  assert.deepEqual(parseGithubRepoUrl('https://github.com/acme/demo/tree/main/src/lib'), {
    owner: 'acme',
    repo: 'demo',
    branch: 'main',
    path: 'src/lib',
    kind: 'directory',
    canonicalUrl: REPO_URL,
  });
  assert.equal(parseGithubRepoUrl('https://github.com/acme/demo/tree/main/src/lib')?.kind, 'directory');
});

test('successful reads fetch metadata, a recursive tree, and prioritized raw files', async () => {
  const fixture = createApiFixture();
  const result = await readGithubRepository(REPO_URL, {
    fetch: fixture.fetch,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });

  assert.equal(fixture.calls.length, 6);
  assert.equal(fixture.calls[0].url, REPO_API);
  assert.match(fixture.calls[1].url, /\/git\/trees\/main\?recursive=1$/);
  assert.ok(fixture.calls.some((call) => (
    call.url === 'https://raw.githubusercontent.com/acme/demo/main/README.md'
  )));
  assert.equal(result.title, 'acme/demo');
  assert.equal(result.url, REPO_URL);
  assert.match(result.text, /<file path="README\.md">\n# Demo/);
  assert.match(result.text, /<file path="package\.json">/);
  assert.ok(result.text.indexOf('<file path="README.md">') < result.text.indexOf('<file path="package.json">'));
  assert.ok(result.text.indexOf('<file path="package.json">') < result.text.indexOf('<file path="src/index.js">'));
  assert.deepEqual(result.structure.github.readFiles, [
    'README.md',
    'package.json',
    'src/index.js',
    'src/feature.js',
  ]);
  assert.equal(result.structure.github.fileCount, 4);
  assert.equal(result.structure.github.branch, 'main');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.outline[0], {
    id: 'github-repository',
    level: 1,
    text: 'acme/demo',
  });
  const normalized = normalizePageContext(result);
  assert.ok(normalized);
  assert.equal(normalized.title, 'acme/demo');
  assert.equal(normalized.outline.length, 5);
  assert.equal(normalized.structure.github.branch, 'main');
  assert.match(pageContextForModel(normalized), /<page_content>/);
  assert.match(pageContextForModel(normalized), /<file path="README\.md">/);
});

test('tree and blob URLs scope the tree and encode branch and file path segments', async () => {
  const calls = [];
  const scopedTree = tree([
    blob('src/lib/entry file.js'),
    blob('src/lib/ignored.ts'),
    blob('other.js'),
  ]);
  const fetch = async (url) => {
    calls.push(url);
    if (url === REPO_API) return jsonResponse(metadata({ default_branch: 'main' }));
    if (url === `${REPO_API}/git/trees/feature%2Fdocs?recursive=1`) {
      return jsonResponse(scopedTree);
    }
    if (url === 'https://raw.githubusercontent.com/acme/demo/feature/docs/src/lib/entry%20file.js') {
      return textResponse('export default 1;');
    }
    return textResponse('missing', 404);
  };

  const result = await readGithubRepository(
    'https://github.com/acme/demo/tree/feature%2Fdocs/src/lib',
    {
      fetch,
      maxFiles: 1,
      capturedAt: '2026-10-29T00:00:00.000Z',
    },
  );

  assert.equal(result.structure.github.branch, 'feature/docs');
  assert.equal(result.structure.github.path, 'src/lib');
  assert.deepEqual(result.structure.github.readFiles, ['src/lib/entry file.js']);
  assert.match(result.text, /<file path="src\/lib\/entry file\.js">/);
  assert.doesNotMatch(result.text, /other\.js/);
  assert.ok(calls.includes(`${REPO_API}/git/trees/feature%2Fdocs?recursive=1`));
  assert.ok(calls.includes(
    'https://raw.githubusercontent.com/acme/demo/feature/docs/src/lib/entry%20file.js',
  ));
});

test('critical files win over nested source files when maxFiles is small', async () => {
  const treeData = tree([
    blob('src/a.js'),
    blob('src/deep/b.js'),
    blob('manifest.json'),
    blob('pnpm-workspace.yaml'),
    blob('package.json'),
    blob('README.md'),
  ]);
  const fixture = createApiFixture({
    treeData,
    files: {
      'README.md': 'readme',
      'package.json': '{"name":"demo"}',
      'manifest.json': '{"manifest_version":3}',
      'pnpm-workspace.yaml': 'packages:\n  - src',
      'src/a.js': 'a',
      'src/deep/b.js': 'b',
    },
  });
  const result = await readGithubRepository(REPO_URL, {
    fetch: fixture.fetch,
    maxFiles: 4,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });

  assert.deepEqual(result.structure.github.readFiles, [
    'README.md',
    'package.json',
    'manifest.json',
    'pnpm-workspace.yaml',
  ]);
  assert.equal(result.structure.github.limitedByFileCount, true);
  assert.equal(result.truncated, true);
});

test('the total character budget is a hard cap and is reported as truncation', async () => {
  const fixture = createApiFixture({
    treeData: tree([
      blob('README.md', 5000),
      blob('src/index.js', 5000),
    ]),
    files: {
      'README.md': `# Long\n${'R'.repeat(5000)}`,
      'src/index.js': `export const value = "${'S'.repeat(5000)}";`,
    },
  });
  const result = await readGithubRepository(REPO_URL, {
    fetch: fixture.fetch,
    maxBudget: 1200,
    maxFileChars: 5000,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });

  assert.ok(result.text.length <= 1200, `expected <= 1200 chars, got ${result.text.length}`);
  assert.equal(result.chars, result.text.length);
  assert.equal(result.truncated, true);
  assert.match(result.text, /\[内容因总字符预算截断\]/);
  assert.doesNotMatch(result.text, /R{4000}/);
});

test('per-file size and file-count limits prevent extra raw requests', async () => {
  const fixture = createApiFixture({
    treeData: tree([
      blob('README.md', 3 * 1024 * 1024),
      blob('package.json'),
      blob('src/index.js'),
      blob('src/other.js'),
    ]),
    files: {
      'package.json': '{"name":"demo"}',
      'src/index.js': 'export default 1;',
      'src/other.js': 'export default 2;',
    },
  });
  const result = await readGithubRepository(REPO_URL, {
    fetch: fixture.fetch,
    maxFiles: 2,
    maxFileBytes: 1024 * 1024,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });

  const rawCalls = fixture.calls.filter((call) => call.url.includes('raw.githubusercontent.com'));
  assert.equal(rawCalls.length, 2);
  assert.deepEqual(result.structure.github.readFiles, ['package.json', 'src/index.js']);
  assert.equal(result.structure.github.skipped.oversized, 1);
  assert.equal(result.structure.github.limitedByFileCount, true);
});

test('API failures reject with an HTTP status instead of returning partial context', async () => {
  const fetch = async (url) => {
    if (url === REPO_API) {
      return jsonResponse({ message: 'Not Found' }, 404);
    }
    return textResponse('unexpected', 500);
  };
  await assert.rejects(
    readGithubRepository(REPO_URL, { fetch }),
    (error) => error.code === 'http'
      && error.status === 404
      && /读取仓库元数据失败/.test(error.message)
      && /Not Found/.test(error.message),
  );
});

test('non-GitHub and non-repository URLs never trigger fetch', async () => {
  let fetched = false;
  const fetch = async () => {
    fetched = true;
    return jsonResponse({});
  };
  await assert.rejects(
    readGithubRepository('https://example.test/acme/demo', { fetch }),
    /仅支持/,
  );
  await assert.rejects(
    readGithubRepository('https://github.com/acme', { fetch }),
    /仅支持/,
  );
  assert.equal(fetched, false);
});

test('sensitive, binary, lock, and vendored paths are filtered before raw reads', async () => {
  const treeData = tree([
    blob('.env'),
    blob('config/private.key'),
    blob('src/credentials.js'),
    blob('logo.png'),
    blob('package-lock.json'),
    blob('node_modules/lodash/index.js'),
    blob('README.md'),
    blob('src/index.js'),
  ]);
  const fixture = createApiFixture({
    treeData,
    files: {
      'README.md': 'safe readme',
      'src/index.js': 'export default 1;',
    },
  });
  const result = await readGithubRepository(REPO_URL, {
    fetch: fixture.fetch,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });

  assert.deepEqual(result.structure.github.readFiles, ['README.md', 'src/index.js']);
  assert.equal(result.structure.github.skipped.sensitive, 3);
  assert.equal(result.structure.github.skipped.binary, 1);
  assert.equal(result.structure.github.skipped.lock, 1);
  assert.equal(result.structure.github.skipped.vendored, 1);
  assert.doesNotMatch(result.text, /\.env|private\.key|credentials\.js|package-lock\.json/);
});

test('binary-looking raw text is rejected even when its extension looks safe', async () => {
  const fixture = createApiFixture({
    treeData: tree([blob('README.md'), blob('src/index.js')]),
    files: {
      'README.md': 'readme',
      'src/index.js': `const x = "\u0000\u0001\u0002";`,
    },
  });
  const result = await readGithubRepository(REPO_URL, {
    fetch: fixture.fetch,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });

  assert.deepEqual(result.structure.github.readFiles, ['README.md']);
  assert.equal(result.structure.github.skipped.binary, 1);
});

test('raw requests respect the configured concurrency limit', async () => {
  const entries = Array.from({ length: 12 }, (_, index) => blob(`src/file-${index}.js`));
  const files = Object.fromEntries(entries.map((entry) => [entry.path, entry.path]));
  let active = 0;
  let maximum = 0;
  const fetch = async (url) => {
    if (url === REPO_API) {
      return jsonResponse(metadata());
    }
    if (url.startsWith(`${REPO_API}/git/trees/`)) {
      return jsonResponse(tree([blob('README.md'), ...entries]));
    }
    if (url.includes('raw.githubusercontent.com')) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const path = decodeURIComponent(url.split('/main/')[1]);
      return textResponse(files[path] || 'readme');
    }
    return textResponse('missing', 404);
  };

  await readGithubRepository(REPO_URL, {
    fetch,
    maxFiles: 12,
    concurrency: 4,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });
  assert.equal(maximum, 4);
});

test('an aborted read rejects promptly without leaking a network request', async () => {
  const controller = new AbortController();
  const fetch = async () => new Promise(() => {});
  const pending = readGithubRepository(REPO_URL, {
    fetch,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('request timeout rejects even when a fetch stub ignores AbortSignal', async () => {
  const fetch = async () => new Promise(() => {});
  await assert.rejects(
    readGithubRepository(REPO_URL, { fetch, timeoutMs: 20 }),
    (error) => error.code === 'timeout' && /超时/.test(error.message),
  );
});

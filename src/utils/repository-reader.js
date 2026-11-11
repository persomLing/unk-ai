import {
  parseGithubRepoUrl,
  readGithubRepository,
} from './github-repo.js';

const PROVIDER_CONFIG = {
  github: {
    provider: 'github',
    label: 'GitHub',
    canonicalHost: 'github.com',
    hosts: new Set(['github.com', 'www.github.com']),
  },
  gitlab: {
    provider: 'gitlab',
    label: 'GitLab',
    canonicalHost: 'gitlab.com',
    hosts: new Set(['gitlab.com', 'www.gitlab.com']),
    reservedRoots: new Set([
      'admin',
      'api',
      'dashboard',
      'explore',
      'groups',
      'help',
      'import',
      'login',
      'oauth',
      'profile',
      'projects',
      'public',
      'search',
      'settings',
      'snippets',
      'users',
    ]),
  },
  gitee: {
    provider: 'gitee',
    label: 'Gitee',
    canonicalHost: 'gitee.com',
    hosts: new Set(['gitee.com', 'www.gitee.com']),
    reservedRoots: new Set([
      'about',
      'dashboard',
      'enterprises',
      'explore',
      'gitee',
      'help',
      'issues',
      'login',
      'notifications',
      'organizations',
      'projects',
      'pull_requests',
      'search',
      'settings',
      'signup',
      'users',
    ]),
  },
  bitbucket: {
    provider: 'bitbucket',
    label: 'Bitbucket',
    canonicalHost: 'bitbucket.org',
    hosts: new Set(['bitbucket.org', 'www.bitbucket.org']),
    reservedRoots: new Set([
      'account',
      'admin',
      'dashboard',
      'downloads',
      'login',
      'product',
      'projects',
      'repo',
      'search',
      'signup',
      'team',
      'users',
    ]),
  },
};

const PROVIDER_BY_HOST = new Map();
for (const config of Object.values(PROVIDER_CONFIG)) {
  for (const host of config.hosts) PROVIDER_BY_HOST.set(host, config.provider);
}

const READERS = {
  github: readGithubRepository,
};

const PROVIDER_LABELS = Object.fromEntries(
  Object.values(PROVIDER_CONFIG).map((config) => [config.provider, config.label]),
);

const SAFE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_.~!$&'()*+,;=:@%+-]+$/;
const SAFE_PATH_SEGMENT_BANNED = new Set(['.', '..']);

export class RepositoryReaderError extends Error {
  constructor(message, { code = 'repository-reader-error', provider = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RepositoryReaderError';
    this.code = code;
    this.provider = provider;
  }
}

function decodePath(value) {
  if (typeof value !== 'string') return null;
  const segments = [];
  for (const raw of value.split('/')) {
    if (!raw) continue;
    let segment;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (
      !segment
      || segment.includes('/')
      || segment.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(segment)
      || SAFE_PATH_SEGMENT_BANNED.has(segment)
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

function safeName(value) {
  return SAFE_NAME.test(value) && !SAFE_PATH_SEGMENT_BANNED.has(value);
}

function safeSourcePath(value) {
  if (!value) return null;
  const segments = value.split('/');
  if (!segments.length) return null;
  return segments.every((segment) => (
    SAFE_PATH_SEGMENT.test(segment)
    && !SAFE_PATH_SEGMENT_BANNED.has(segment)
  ));
}

function stripGitSuffix(value) {
  return value.toLowerCase().endsWith('.git') ? value.slice(0, -4) : value;
}

function canonicalUrl(provider, ownerSegments, repo) {
  const config = PROVIDER_CONFIG[provider];
  return `https://${config.canonicalHost}/${[
    ...ownerSegments,
    repo,
  ].map(encodeURIComponent).join('/')}`;
}

function baseRepositoryResult(provider, ownerSegments, repo, branch = null, path = null, kind = 'repository') {
  return {
    provider,
    owner: ownerSegments.join('/'),
    repo,
    branch,
    path,
    kind,
    canonicalUrl: canonicalUrl(provider, ownerSegments, repo),
  };
}

function parseGitlab(segments) {
  if (segments.length < 2) return null;
  if (PROVIDER_CONFIG.gitlab.reservedRoots.has(segments[0].toLowerCase())) return null;

  const markerIndex = segments.findIndex((segment, index) => (
    index >= 2 && segment === '-'
  ));
  let ownerSegments;
  let repo;
  let branch = null;
  let path = null;
  let kind = 'repository';

  if (markerIndex >= 0) {
    ownerSegments = segments.slice(0, markerIndex - 1);
    repo = stripGitSuffix(segments[markerIndex - 1] || '');
    const action = segments[markerIndex + 1]?.toLowerCase();
    if (action !== 'tree' && action !== 'blob') return null;
    if (!segments[markerIndex + 2]) return null;
    branch = segments[markerIndex + 2];
    path = segments.slice(markerIndex + 3).join('/') || null;
    kind = action === 'blob' ? 'file' : 'directory';
    if (kind === 'file' && !path) return null;
  } else {
    ownerSegments = segments.slice(0, -1);
    repo = stripGitSuffix(segments.at(-1));
  }

  if (ownerSegments.length < 1 || !ownerSegments.every(safeName) || !safeName(repo)) {
    return null;
  }
  if (branch && (!safeName(branch) || !safeSourcePath(path))) return null;
  if (path && !safeSourcePath(path)) return null;
  return baseRepositoryResult('gitlab', ownerSegments, repo, branch, path, kind);
}

function parseGitee(segments) {
  if (segments.length < 2) return null;
  if (PROVIDER_CONFIG.gitee.reservedRoots.has(segments[0].toLowerCase())) return null;

  const owner = segments[0];
  const repo = stripGitSuffix(segments[1] || '');
  const action = segments[2]?.toLowerCase();
  let branch = null;
  let path = null;
  let kind = 'repository';

  if (segments.length > 2) {
    if (action !== 'tree' && action !== 'blob') return null;
    branch = segments[3] || null;
    path = segments.slice(4).join('/') || null;
    kind = action === 'blob' ? 'file' : 'directory';
    if (kind === 'file' && (!branch || !path)) return null;
  }

  if (!safeName(owner) || !safeName(repo)) return null;
  if (branch && !safeName(branch)) return null;
  if (path && !safeSourcePath(path)) return null;
  return baseRepositoryResult('gitee', [owner], repo, branch, path, kind);
}

function inferBitbucketKind(path) {
  if (!path) return 'directory';
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return basename.includes('.') ? 'file' : 'directory';
}

function parseBitbucket(segments) {
  if (segments.length < 2) return null;
  if (PROVIDER_CONFIG.bitbucket.reservedRoots.has(segments[0].toLowerCase())) return null;

  const owner = segments[0];
  const repo = stripGitSuffix(segments[1] || '');
  const action = segments[2]?.toLowerCase();
  let branch = null;
  let path = null;
  let kind = 'repository';

  if (segments.length > 2) {
    if (action !== 'src') return null;
    branch = segments[3] || null;
    path = segments.slice(4).join('/') || null;
    kind = inferBitbucketKind(path);
  }

  if (!safeName(owner) || !safeName(repo)) return null;
  if (branch && !safeName(branch)) return null;
  if (path && !safeSourcePath(path)) return null;
  return baseRepositoryResult('bitbucket', [owner], repo, branch, path, kind);
}

/**
 * Parse a supported code-hosting URL into a provider-neutral repository shape.
 * Only repository roots and provider-specific source views are accepted.
 */
export function parseRepositoryUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.username || url.password || url.port) return null;

  const provider = PROVIDER_BY_HOST.get(url.hostname.toLowerCase());
  if (!provider) return null;
  if (provider === 'github') {
    const parsed = parseGithubRepoUrl(value);
    return parsed ? { provider, ...parsed } : null;
  }

  const segments = decodePath(url.pathname);
  if (!segments) return null;
  if (provider === 'gitlab') return parseGitlab(segments);
  if (provider === 'gitee') return parseGitee(segments);
  if (provider === 'bitbucket') return parseBitbucket(segments);
  return null;
}

export function repositoryProviderForUrl(value) {
  return parseRepositoryUrl(value)?.provider ?? null;
}

/**
 * True when the URL is a recognized repository URL, even if the provider's
 * source reader is not implemented yet.
 */
export function isSupportedRepositoryUrl(value) {
  return Boolean(parseRepositoryUrl(value));
}

/**
 * Read a repository through its provider adapter. Provider errors are
 * intentionally propagated unchanged so callers can inspect status and code.
 */
export async function readRepository(value, options = {}) {
  const parsed = parseRepositoryUrl(value);
  if (!parsed) {
    throw new RepositoryReaderError('无法识别为受支持的代码托管仓库 URL。', {
      code: 'invalid-url',
    });
  }

  const reader = READERS[parsed.provider];
  if (typeof reader !== 'function') {
    throw new RepositoryReaderError(
      `${PROVIDER_LABELS[parsed.provider]} 仓库读取尚未实现；当前仅支持读取 GitHub 仓库。`,
      {
        code: 'provider-unsupported',
        provider: parsed.provider,
      },
    );
  }

  return reader(value, options);
}

function formatFileList(files, limit = 4) {
  if (!Array.isArray(files) || !files.length) return '';
  const shown = files.slice(0, limit).map((file) => String(file)).join('、');
  return files.length > limit ? `${shown} 等 ${files.length} 个文件` : shown;
}

/**
 * Build a short provenance label for UI display. It never substitutes for the
 * repository source text returned by readRepository.
 */
export function repositoryContextSummary(result, maxChars = 1200) {
  const limit = Number.isFinite(Number(maxChars))
    ? Math.max(0, Math.floor(Number(maxChars)))
    : 1200;
  if (!limit || !result || typeof result !== 'object') return '';

  const parsed = parseRepositoryUrl(result.url);
  const provider = parsed?.provider;
  const github = provider === 'github' ? result.structure?.github : null;
  const title = String(result.title || (parsed ? `${parsed.owner}/${parsed.repo}` : '仓库')).trim();
  const lines = [
    `来源：${PROVIDER_LABELS[provider] || '代码仓库'}`,
    `仓库：${title}`,
  ];
  if (github?.branch) lines.push(`分支：${github.branch}`);
  if (github?.path) lines.push(`范围：${github.path}`);
  if (github?.readFileCount != null) {
    lines.push(`已读取：${github.readFileCount} 个文件`);
  }
  const files = formatFileList(github?.readFiles);
  if (files) lines.push(`文件：${files}`);
  if (result.truncated) lines.push('完整性：内容已截断');
  if (result.url) lines.push(`链接：${String(result.url)}`);
  return lines.join('\n').slice(0, limit);
}

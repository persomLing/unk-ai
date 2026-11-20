import { awaitWithAbort } from '../utils/abortable.js';

const REPOSITORY = 'persomLing/unk-ai';
const GITHUB = `https://github.com/${REPOSITORY}`;
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const VERSION = /^(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})$/;
const ZIP_LIMIT = 24 * 1024 * 1024;
const RELEASE_LIMIT = 512 * 1024;

export const RELEASES_URL = `${GITHUB}/releases`;

function versionParts(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(part => part <= 65535) ? parts : null;
}

export function releaseUpdate(release, installedVersion) {
  const installed = versionParts(installedVersion);
  const version = typeof release?.tag_name === 'string' ? release.tag_name.slice(1) : '';
  const candidate = versionParts(version);
  if (release?.draft !== false || release?.prerelease !== false || release?.tag_name !== `v${version}` || !candidate || !installed) {
    throw new Error('GitHub 返回的正式版本信息无效。');
  }
  const changed = candidate.findIndex((part, index) => part !== installed[index]);
  if (changed === -1 || candidate[changed] < installed[changed]) return null;
  const name = `unk-ai-v${version}.zip`;
  const url = `${RELEASES_URL}/download/v${version}/${name}`;
  const assets = Array.isArray(release.assets) ? release.assets.filter(asset => asset?.name === name && asset.state === 'uploaded') : [];
  const [asset] = assets;
  if (assets.length !== 1 || asset.browser_download_url !== url || !Number.isSafeInteger(asset.size)
    || asset.size < 1 || asset.size > ZIP_LIMIT || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest || '')) {
    throw new Error('正式版本缺少可校验的安装包。');
  }
  return Object.freeze({ version, name, url, size: asset.size, sha256: asset.digest.slice(7).toLowerCase(), notesUrl: `${RELEASES_URL}/tag/v${version}` });
}

async function readBytes(response, limit, signal) {
  if (!response.body || Number(response.headers.get('Content-Length')) > limit) throw new Error('更新文件大小超出限制。');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await awaitWithAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('更新文件大小超出限制。');
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function checkGitHubUpdate(version, { fetchImpl = fetch, signal } = {}) {
  const requestSignal = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
  const response = await awaitWithAbort(fetchImpl(RELEASE_API, { signal: requestSignal, credentials: 'omit', redirect: 'error',
    cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } }), requestSignal);
  if (!response.ok) throw new Error(`GitHub 检查更新失败（HTTP ${response.status}）。`);
  const payload = JSON.parse(new TextDecoder().decode(await readBytes(response, RELEASE_LIMIT, requestSignal)));
  return releaseUpdate(payload, version);
}

export async function fetchUpdateArchive(update, { fetchImpl = fetch, signal } = {}) {
  const requestSignal = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
  const response = await awaitWithAbort(fetchImpl(update.url, { signal: requestSignal, credentials: 'omit', cache: 'no-store' }), requestSignal);
  const location = new URL(response.url);
  const allowedOrigin = ['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'].includes(location.origin);
  if (!response.ok || (!allowedOrigin && location.href !== update.url)) throw new Error('无法从 GitHub 下载经过确认的安装包。');
  const bytes = await readBytes(response, update.size, requestSignal);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes.length !== update.size || digest !== update.sha256) throw new Error('安装包 SHA-256 校验失败。');
  requestSignal.throwIfAborted();
  return bytes;
}

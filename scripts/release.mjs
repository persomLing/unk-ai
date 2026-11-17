import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

export function githubRepository(remote) {
  const match = String(remote).match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!match || match.slice(1).some(part => part === '.' || part === '..')) throw new Error('发布仅支持明确的 GitHub 仓库地址。');
  return match[1] + '/' + match[2];
}

export function releaseNotes(markdown, version) {
  if (!versionPattern.test(version)) throw new Error('版本号必须为 X.Y.Z。');
  const headings = [...markdown.matchAll(/^## (\d+\.\d+\.\d+) [—-] (\d{4}-\d{2}-\d{2})\s*$/gm)];
  const matches = headings.filter(heading => heading[1] === version);
  if (matches.length !== 1) throw new Error('CHANGELOG 必须有且只有一段当前版本的更新说明。');
  const heading = matches[0], next = headings.find(item => item.index > heading.index);
  const body = markdown.slice(heading.index + heading[0].length, next?.index ?? markdown.length).trim();
  if (!body || !/^-\s+\S/m.test(body)) throw new Error('当前版本的更新说明不能为空。');
  return { date: heading[2], body };
}

export function prepareReleaseFiles(cwd = root) {
  const metadata = jsonFile(resolve(cwd, 'package.json'));
  const manifest = jsonFile(resolve(cwd, 'manifest.json'));
  const lock = jsonFile(resolve(cwd, 'package-lock.json'));
  const version = metadata.version;
  if (!versionPattern.test(version) || [manifest.version, lock.version, lock.packages?.['']?.version].some(value => value !== version)) {
    throw new Error('manifest、package 和锁文件版本必须一致。');
  }
  const guide = readFileSync(resolve(cwd, 'docs/USER-GUIDE.html'), 'utf8');
  if (!guide.includes('适用版本：' + version)) throw new Error('请先更新操作手册并运行 npm run docs:build。');
  const section = releaseNotes(readFileSync(resolve(cwd, 'CHANGELOG.md'), 'utf8'), version);
  const notes = '# UNK AI v' + version + '\n\n' + section.body + '\n\n## 安装与更新\n\n'
    + '下载并解压 `unk-ai-v' + version + '.zip`，在 Chrome 扩展管理页加载直接包含 `manifest.json` 的目录。'
    + '更新时替换扩展程序文件、重新加载扩展并重开侧栏。包内 `USER-GUIDE.html` 可离线阅读。\n';
  const output = resolve(cwd, 'output');
  mkdirSync(output, { recursive: true });
  const notesPath = resolve(output, 'release-notes-v' + version + '.md');
  writeFileSync(notesPath, notes, 'utf8');
  return { version, tag: 'v' + version, date: section.date, notes, notesPath };
}

export function validatePackage(packagePath, report, version, commit) {
  if (report?.version !== version || report.commit !== commit || !report.manifestAtRoot
    || !(report.allBuildFilesEqualDist || report.allFilesEqualDist)) throw new Error('版本包校验记录与当前版本、提交不匹配。');
  const bytes = readFileSync(packagePath);
  if (bytes.length !== report.bytes || digest(bytes) !== report.sha256) throw new Error('版本包的大小或 SHA-256 与校验记录不同。');
  return { path: packagePath, name: basename(packagePath), bytes: bytes.length, sha256: report.sha256 };
}

export function createGitHubClient({ token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('GitHub 登录凭据不可用。');
  async function request(url, { method = 'GET', body, binary = false, missingOkay = false } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'uploads.github.com'].includes(parsed.hostname)) throw new Error('无效的 GitHub 发布地址。');
    const response = await fetchImpl(url, { method, redirect: 'error',
      signal: AbortSignal.timeout(binary ? 120000 : 30000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'unk-ai-release',
        ...(body ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(body ? { body: binary ? body : JSON.stringify(body) } : {}) });
    if (missingOkay && response.status === 404) return null;
    if (!response.ok) throw new Error('GitHub 发布请求失败（HTTP ' + response.status + '）。');
    return response.json();
  }
  return {
    json: (path, options) => request('https://api.github.com' + path, options),
    upload: (repository, releaseId, name, bytes) => request('https://uploads.github.com/repos/' + repository
      + '/releases/' + releaseId + '/assets?name=' + encodeURIComponent(name), { method: 'POST', body: bytes, binary: true }),
  };
}

/** Read the configured Git helper into memory; credentials never enter logs or artifacts. */
export function authenticatedGitHubClient(remote, cwd = root) {
  githubRepository(remote);
  let token;
  try {
    const credential = execFileSync('git', ['credential', 'fill'], { cwd, encoding: 'utf8', windowsHide: true,
      input: 'url=https://github.com/' + githubRepository(remote) + '.git\n\n', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });
    token = credential.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
  } catch { /* Report only the missing login, never helper output. */ }
  return createGitHubClient({ token });
}

export async function publishGitHubRelease({ client, repository, tag, commit, notes, assets, latest = true,
  progress = () => {} }) {
  githubRepository('https://github.com/' + repository);
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(commit) || !notes?.trim() || !assets?.length) throw new Error('发布信息不完整。');
  const repoPath = '/repos/' + repository;
  const reference = await client.json(repoPath + '/git/ref/tags/' + tag);
  let object = reference.object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('无效的远端 tag。');
    object = (await client.json(repoPath + '/git/tags/' + object.sha)).object;
  }
  if (object?.type !== 'commit' || object.sha !== commit) throw new Error('远端 tag 未指向待发布的提交。');
  // Hash every local artifact before creating a draft or changing a release.
  const files = assets.map(path => {
    const bytes = readFileSync(path), name = basename(path);
    if (!/^[\w.-]+$/.test(name)) throw new Error('无效的版本资产文件名。');
    return { name, bytes, sha256: digest(bytes) };
  });
  if (new Set(files.map(file => file.name)).size !== files.length) throw new Error('版本资产不能同名。');
  let release = await client.json(repoPath + '/releases/tags/' + tag, { missingOkay: true });
  // Drafts may be absent from the by-tag endpoint; retry the same draft safely.
  if (!release) release = (await client.json(repoPath + '/releases?per_page=100')).find(item => item.tag_name === tag);
  if (!release) release = await client.json(repoPath + '/releases', { method: 'POST', body: {
    tag_name: tag, target_commitish: commit, name: 'UNK AI ' + tag, body: notes, draft: true, prerelease: false,
  } });
  if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error('GitHub 未返回有效的 Release。');
  for (const file of files) {
    const existing = (release.assets || []).find(asset => asset.name === file.name);
    progress((existing ? '核对 ' : '上传 ') + file.name);
    const asset = existing || await client.upload(repository, release.id, file.name, file.bytes);
    if (asset.size !== file.bytes.length || asset.digest !== 'sha256:' + file.sha256) {
      throw new Error('GitHub 资产校验不匹配：' + file.name + '。保留现有资产，请核对后重试。');
    }
  }
  const published = await client.json(repoPath + '/releases/' + release.id, { method: 'PATCH', body: {
    name: 'UNK AI ' + tag, body: notes, draft: false, prerelease: false, make_latest: latest ? 'true' : 'false',
  } });
  if (published.draft || published.tag_name !== tag) throw new Error('Release 尚未确认发布成功。');
  return { tag, commit, url: published.html_url, assets: files.map(file => ({ name: file.name, bytes: file.bytes.length, sha256: file.sha256 })) };
}

async function releaseCurrent() {
  if (git(['status', '--porcelain'])) throw new Error('请先提交本次版本代码，再运行 npm run release。');
  const prepared = prepareReleaseFiles();
  const commit = git(['rev-parse', 'HEAD']);
  const branch = git(['branch', '--show-current']);
  if (!branch) throw new Error('请在明确的发布分支上运行。');
  const remote = git(['remote', 'get-url', 'origin']);
  const repository = githubRepository(remote);
  const client = authenticatedGitHubClient(remote);
  const details = await client.json('/repos/' + repository);
  if (details.permissions?.push !== true) throw new Error('当前 GitHub 登录没有仓库发布权限。');
  const existingTag = git(['tag', '--list', prepared.tag])
    ? git(['rev-parse', '--verify', 'refs/tags/' + prepared.tag + '^{commit}']) : null;
  if (existingTag && existingTag !== commit) throw new Error('该版本 tag 已绑定其他提交，请递增版本号。');
  console.log('检查版本 ' + prepared.version + '（' + commit.slice(0, 7) + '）');
  if (process.platform === 'win32') execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run check'], { cwd: root, stdio: 'inherit', windowsHide: true });
  else execFileSync('npm', ['run', 'check'], { cwd: root, stdio: 'inherit' });
  if (git(['status', '--porcelain']) || git(['rev-parse', 'HEAD']) !== commit) throw new Error('检查期间源码或提交发生变化，请重新提交并发布。');
  writeFileSync(resolve(root, 'output/release-check-v' + prepared.version + '.json'), JSON.stringify({
    version: prepared.version, commit, command: 'npm run check', passed: true, completedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  const packagePath = resolve(root, 'unk-ai-v' + prepared.version + '.zip');
  const reportPath = resolve(root, 'output/package-v' + prepared.version + '-validation.json');
  if (!existsSync(packagePath)) execFileSync('pwsh', ['-NoProfile', '-File', resolve(root, 'scripts/package-release.ps1')], { cwd: root, stdio: 'inherit', windowsHide: true });
  const packageInfo = validatePackage(packagePath, jsonFile(reportPath), prepared.version, commit);
  const checksum = resolve(root, 'output/unk-ai-v' + prepared.version + '.sha256');
  const guidePath = resolve(root, 'output/unk-ai-v' + prepared.version + '-user-guide.html');
  writeFileSync(guidePath, readFileSync(resolve(root, 'docs/USER-GUIDE.html')));
  writeFileSync(checksum, packageInfo.sha256 + '  ' + basename(packagePath) + '\n' + digest(readFileSync(guidePath)) + '  ' + basename(guidePath) + '\n');
  if (!existingTag) git(['tag', '-a', prepared.tag, commit, '-F', prepared.notesPath]);
  console.log('推送 ' + branch + ' 与 ' + prepared.tag);
  git(['push', '--atomic', 'origin', 'HEAD:refs/heads/' + branch, 'refs/tags/' + prepared.tag]);
  const result = await publishGitHubRelease({ client, repository, tag: prepared.tag, commit, notes: prepared.notes,
    assets: [packagePath, checksum, guidePath], progress: console.log });
  writeFileSync(resolve(root, 'output/release-v' + prepared.version + '-published.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--prepare-notes') console.log(JSON.stringify(prepareReleaseFiles()));
    else if (process.argv.length === 2) await releaseCurrent();
    else throw new Error('使用 npm run release，或 node scripts/release.mjs --prepare-notes。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

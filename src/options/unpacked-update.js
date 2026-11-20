import { unzipSync } from 'fflate';
import { awaitWithTimeout } from '../utils/abortable.js';

const BUILD_ROOTS = new Set(['_locales', 'assets', 'content', 'icons', 'pdfjs', 'src', 'third-party']);
const RELEASE_FILES = new Set(['RELEASE-NOTES.md', 'RELEASE-INFO.json', 'USER-GUIDE.html']);
const MAX_FILE_SIZE = 12 * 1024 * 1024;
const MAX_TOTAL_SIZE = 48 * 1024 * 1024;
const MAX_ENTRIES = 1800;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const IO = { timeoutMs: 12000, message: '等待安装目录读写超时。' };
const decoder = new TextDecoder('utf-8', { fatal: true });
const disk = pending => awaitWithTimeout(pending, IO);

function safeParts(name) {
  const parts = name.replace(/\/$/, '').split('/');
  if (name.length > 200 || parts.length > 8 || parts.some(part => !/^[a-z0-9_][a-z0-9_.-]*$/i.test(part)
    || part.endsWith('.') || DEVICE_NAME.test(part) || part === '__proto__')) throw new Error('安装包含有不安全的文件路径。');
  return parts;
}

function unchangedAccess(installed, incoming) {
  for (const key of ['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions']) {
    const existing = new Set(installed[key] || []);
    if (!Array.isArray(incoming[key] ?? []) || (incoming[key] || []).some(value => !existing.has(value))) return false;
  }
  const existingMatches = new Set((installed.content_scripts || []).flatMap(script => script.matches || []));
  return (incoming.content_scripts || []).every(script => Array.isArray(script.matches) && script.matches.every(value => existingMatches.has(value)));
}

export function unpackUpdate(bytes, version, installed) {
  const seen = new Set();
  let total = 0;
  const files = unzipSync(bytes, { filter(file) {
    const name = file.name.toLowerCase(), parts = safeParts(file.name);
    if (seen.has(name) || seen.size >= MAX_ENTRIES || file.originalSize > MAX_FILE_SIZE) throw new Error('安装包文件数量或大小无效。');
    seen.add(name);
    total += file.originalSize;
    if (total > MAX_TOTAL_SIZE) throw new Error('安装包解压大小超出限制。');
    if (RELEASE_FILES.has(file.name)) return false;
    if (file.name === 'manifest.json' || file.name === 'service-worker.js') return true;
    if (!BUILD_ROOTS.has(parts[0]) || (!file.name.endsWith('/') && parts.length === 1)) throw new Error('安装包包含无法识别的扩展文件。');
    return !file.name.endsWith('/');
  } });
  const incoming = files['manifest.json'] && JSON.parse(decoder.decode(files['manifest.json']));
  if (!incoming || incoming.manifest_version !== 3 || incoming.version !== version || incoming.name !== installed.name
    || incoming.key !== installed.key || incoming.update_url !== installed.update_url || !unchangedAccess(installed, incoming)) {
    throw new Error('安装包的版本、身份或权限与当前安装不一致。请从版本说明查看安装步骤。');
  }
  const required = [incoming.background?.service_worker, incoming.options_ui?.page, incoming.side_panel?.default_path,
    ...(incoming.content_scripts || []).flatMap(script => script.js || [])];
  for (const path of required) {
    if (typeof path !== 'string' || !Object.hasOwn(files, path) || !files[path].byteLength) throw new Error('安装包缺少必需的扩展文件。');
  }
  const entries = Object.entries(files);
  return entries.filter(([name]) => name !== 'manifest.json').concat([['manifest.json', files['manifest.json']]]);
}

async function fileAt(root, name, create) {
  const parts = safeParts(name), filename = parts.pop();
  let directory = root;
  for (const part of parts) directory = await disk(directory.getDirectoryHandle(part, { create }));
  return { directory, filename, file: await disk(directory.getFileHandle(filename, { create })) };
}

async function put(file, bytes) {
  const opening = file.createWritable({ mode: 'exclusive' });
  let writer;
  try { writer = await disk(opening); }
  catch (error) { void opening.then(late => late.abort()).catch(() => {}); throw error; }
  try {
    await disk(writer.write(bytes));
    await disk(writer.close());
  } catch (error) {
    await disk(writer.abort()).catch(() => {});
    throw error;
  }
}

export async function verifyInstallDirectory(root, runtime, { fetchImpl = fetch } = {}) {
  let manifest;
  try {
    const { file } = await fileAt(root, 'manifest.json', false);
    const current = await disk(file.getFile());
    if (current.size > 128 * 1024) throw new Error('manifest size');
    manifest = JSON.parse(await disk(current.text()));
  } catch { throw new Error('请选择 Chrome 当前加载的扩展文件夹。'); }
  const installed = runtime.getManifest();
  if (manifest.version !== installed.version || manifest.name !== installed.name || manifest.manifest_version !== 3) {
    throw new Error('所选目录与当前扩展的版本不一致。');
  }
  const marker = `unk-ai-update-${crypto.randomUUID()}.txt`;
  const bytes = new TextEncoder().encode(crypto.randomUUID());
  const { file } = await fileAt(root, marker, true);
  try {
    await put(file, bytes);
    const signal = AbortSignal.timeout(4500);
    const response = await disk(fetchImpl(runtime.getURL(marker), { cache: 'no-store', signal }));
    if (!response.ok || await disk(response.text()) !== decoder.decode(bytes)) throw new Error('directory mismatch');
  } catch { throw new Error('无法确认此文件夹是 Chrome 当前加载的扩展目录。'); }
  finally { await disk(root.removeEntry(marker)); }
}

export async function writeUnpackedUpdate(root, entries) {
  let backupSize = 0;
  const snapshots = [];
  for (const [name, bytes] of entries) {
    try {
      const { file } = await fileAt(root, name, false);
      const previous = await disk(file.getFile());
      backupSize += previous.size;
      if (backupSize > MAX_TOTAL_SIZE) throw new Error('当前安装需要备份的文件过大。');
      snapshots.push({ name, bytes, previous: await disk(previous.arrayBuffer()) });
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
      snapshots.push({ name, bytes });
    }
  }
  const applied = [];
  try {
    for (const snapshot of snapshots) {
      const location = await fileAt(root, snapshot.name, true);
      applied.push({ ...location, previous: snapshot.previous });
      await put(location.file, snapshot.bytes);
    }
  } catch (error) {
    let restored = true;
    for (const item of applied.reverse()) {
      try {
        if (item.previous) await put(item.file, item.previous);
        else await disk(item.directory.removeEntry(item.filename));
      } catch { restored = false; }
    }
    if (!restored || error?.name === 'TimeoutError') throw new Error('安装目录写入结果需要核对。请解压已校验的新版安装包到原目录后重新加载。');
    throw new Error('浏览器未能写入安装目录，已回退本次写入。可以下载安装包手动更新。');
  }
}

import { checkGitHubUpdate, fetchUpdateArchive, RELEASES_URL } from './github-update.js';
import { unpackUpdate, verifyInstallDirectory, writeUnpackedUpdate } from './unpacked-update.js';

export function installUpdateSettings({ root, runtime, win = window }) {
  const installed = runtime.getManifest();
  const checkButton = root.querySelector('#check-extension-update');
  const installButton = root.querySelector('#install-extension-update');
  const downloadLink = root.querySelector('#download-extension-update');
  const notesLink = root.querySelector('#extension-release-notes');
  const feedback = root.querySelector('#extension-update-status');
  const canInstall = typeof win.showDirectoryPicker === 'function' && Boolean(win.navigator.locks);
  const lifetime = new AbortController();
  let busy = false, update = null;

  root.querySelector('#extension-installed-version').textContent = `v${installed.version}`;
  notesLink.href = RELEASES_URL;

  function status(message, kind = '') {
    if (lifetime.signal.aborted) return;
    feedback.textContent = message;
    feedback.className = `inline-feedback ${kind}`.trim();
    feedback.hidden = !message;
  }

  function paint() {
    checkButton.disabled = busy;
    installButton.disabled = busy;
    installButton.hidden = !update || !canInstall;
    downloadLink.hidden = !update;
    notesLink.href = update?.notesUrl || RELEASES_URL;
    if (update) downloadLink.href = update.url;
    else downloadLink.removeAttribute('href');
  }

  async function check() {
    if (busy) return;
    busy = true;
    update = null;
    paint();
    status('正在检查 GitHub 发布版本…');
    try {
      update = await checkGitHubUpdate(installed.version, { signal: lifetime.signal });
      if (!update) status('已是最新正式版本。', 'success');
      else status(canInstall ? `发现 v${update.version}。更新时请选择 Chrome 当前加载的扩展文件夹。`
        : `发现 v${update.version}。可以下载新版安装包。`, 'success');
    } catch (error) { status(error?.name === 'TimeoutError' ? '检查更新超时，请稍后重试。' : error.message || '无法检查更新。', 'error'); }
    finally { busy = false; if (!lifetime.signal.aborted) paint(); }
  }

  const guardClose = event => { event.preventDefault(); };

  async function install() {
    if (busy || !canInstall || !update) return;
    const selected = update;
    busy = true;
    paint();
    try {
      const directory = await win.showDirectoryPicker({ id: 'unk-ai-installation', mode: 'readwrite' });
      lifetime.signal.throwIfAborted();
      await win.navigator.locks.request('unk-ai-extension-update', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('另一个设置页正在更新扩展。');
        status('正在下载并校验安装包…');
        const bytes = await fetchUpdateArchive(selected, { signal: lifetime.signal });
        const entries = unpackUpdate(bytes, selected.version, installed);
        lifetime.signal.throwIfAborted();
        status('正在核对 Chrome 当前加载的目录…');
        await verifyInstallDirectory(directory, runtime);
        lifetime.signal.throwIfAborted();
        win.addEventListener('beforeunload', guardClose);
        try {
          status(`正在安装 v${selected.version}，请保持设置页打开。`);
          await writeUnpackedUpdate(directory, entries);
        } finally { win.removeEventListener('beforeunload', guardClose); }
        status(`已写入 v${selected.version}，正在重新加载扩展。`, 'success');
        runtime.reload();
      });
    } catch (error) {
      if (error?.name === 'AbortError') status('已取消更新。');
      else status(error?.name === 'TimeoutError' ? '更新等待超时，可以下载安装包手动更新。' : error.message || '安装更新失败。', 'error');
    } finally { busy = false; if (!lifetime.signal.aborted) paint(); }
  }

  checkButton.addEventListener('click', check);
  installButton.addEventListener('click', install);
  paint();
  return () => {
    lifetime.abort();
    checkButton.removeEventListener('click', check);
    installButton.removeEventListener('click', install);
  };
}

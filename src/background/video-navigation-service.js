import { awaitWithAbort, awaitWithTimeout } from '../utils/abortable.js';
import { assertPageTarget } from '../utils/page-target.js';
import { videoError, videoPageUrl, videoTarget } from '../sidepanel/features/video-notes/video-request.js';
import { VIDEO_NAVIGATION_PORT, VIDEO_NAVIGATION_TIMEOUT_MS, videoNavigationToken,
  captureVideoNavigation, matchesVideoPage } from '../sidepanel/features/video-notes/video-navigation-request.js';
import { seekBilibiliVideo } from '../sidepanel/features/video-notes/bilibili-player.js';

const uncertain = () => videoError('VIDEO_NAVIGATION_UNCERTAIN', '无法确认视频定位结果，请先核对播放器位置；不会自动重复定位。');
const missingTab = error => /No tab with id|Invalid tab ID/i.test(error?.message || '');
const missingDocument = error => /No document with id|No frame with id|Frame with ID .* was removed/i.test(error?.message || '');
const pageRequired = () => videoError('VIDEO_PAGE_REQUIRED', '请先点击笔记标题，回到对应视频页面，再调整播放进度。');
const pageChanged = () => videoError('PAGE_CHANGED', '当前播放器与这条笔记的视频或分集不一致，请先点击标题回到对应视频。');
function trusted(api, sender) {
  if (sender?.id !== api.runtime.id || sender.tab) return false;
  try { return new URL(sender.url).href === api.runtime.getURL('src/sidepanel/index.html'); } catch { return false; }
}

/** Explicit sidepanel clicks only. Time clicks can seek the active matching
 * video; title clicks can focus/open it. Each new click resolves and pins its
 * live URL/document before acting. Disconnect revokes remaining work, not an
 * effect already dispatched. Seeking can never fall back to navigation. */
export function createVideoNavigationService({ chrome: api = globalThis.chrome,
  timeoutMs = VIDEO_NAVIGATION_TIMEOUT_MS, ioTimeoutMs = 2000 } = {}) {
  const ports = new Map(), locks = new Map();
  let disposed = false;
  function check(job) {
    job.controller.signal.throwIfAborted();
    if (disposed || job.finished || Date.now() >= job.deadlineAt) throw uncertain();
  }
  async function wait(job, operation) {
    check(job);
    const result = await awaitWithTimeout(Promise.resolve().then(() => { check(job); return operation(); }),
      { signal: job.controller.signal, timeoutMs: Math.max(1, Math.min(ioTimeoutMs, job.deadlineAt - Date.now())),
        message: '核对原视频页面超时，请稍后重试。' });
    check(job);
    return result;
  }
  function acquire(job, key) {
    if (locks.has(key) && locks.get(key) !== job) throw videoError('VIDEO_NAVIGATION_BUSY', '上次视频操作尚未确认，请稍后再试。');
    locks.set(key, job); job.keys.add(key);
  }
  function release(job) {
    if (job.finished && !job.effects) for (const key of job.keys) if (locks.get(key) === job) locks.delete(key);
  }
  async function effect(job, operation) {
    check(job); job.effects++;
    const pending = Promise.resolve().then(() => { check(job); return operation(); });
    void pending.then(() => { job.effects--; release(job); }, () => { job.effects--; release(job); });
    try { return await wait(job, () => pending); }
    catch (error) {
      if (error.name === 'TimeoutError') throw uncertain();
      throw error;
    }
  }
  function assertPlayer(result, expected) {
    if (result?.outcome === 'changed') throw pageChanged();
    if (result?.outcome === 'identity-unavailable') throw videoError('VIDEO_PLAYER_IDENTITY_UNAVAILABLE', '暂时无法确认播放器的当前分集，请等视频加载完成后再点击时间码。');
    if (result?.outcome === 'unavailable') throw videoError('VIDEO_PLAYER_NOT_READY', '当前视频播放器尚未就绪，请等待视频加载后再点击时间码。');
    if (result?.outcome !== expected) throw uncertain();
  }
  async function seek(job) {
    const { target, video, startMs } = job.request;
    let tab;
    try { tab = await wait(job, () => api.tabs.get(target.tabId)); }
    catch (error) { if (missingTab(error)) throw pageRequired(); throw error; }
    if (tab.id !== target.tabId || !matchesVideoPage(tab.url, video)) throw pageChanged();
    if (!tab.active) throw pageRequired();
    if (tab.status === 'loading' || (tab.pendingUrl && tab.pendingUrl !== tab.url)) {
      throw videoError('VIDEO_PLAYER_NOT_READY', '视频页面正在加载，请稍后再调整播放进度。');
    }
    job.windowId = tab.windowId;
    const live = { tabId: tab.id, url: tab.url };
    const input = { expectedUrl: live.url, bvid: video.bvid, cid: video.cid, part: video.part,
      duration: video.duration, startMs, deadlineAt: job.deadlineAt };
    const observed = await wait(job, () => api.scripting.executeScript({
      target: { tabId: live.tabId, frameIds: [0] }, world: 'MAIN', injectImmediately: true,
      func: seekBilibiliVideo, args: [{ ...input, inspectOnly: true }],
    }));
    const frame = observed?.find(entry => entry.frameId === 0);
    assertPlayer(frame?.result, 'ready');
    const bound = videoTarget({ ...live, url: frame.result.url, documentId: frame.documentId }, { documentRequired: true });
    assertPageTarget(live, bound);
    if (frame.result.bvid !== video.bvid || frame.result.cid !== video.cid) throw pageChanged();
    job.target = bound;
    let result;
    try {
      const frames = await effect(job, () => api.scripting.executeScript({
        target: { tabId: bound.tabId, documentIds: [bound.documentId] }, world: 'MAIN', injectImmediately: true,
        func: seekBilibiliVideo, args: [input],
      }));
      result = frames?.find(entry => entry.frameId === 0 && entry.documentId === bound.documentId)?.result;
    } catch (error) { if (missingDocument(error)) throw pageChanged(); throw error; }
    assertPlayer(result, 'seeked');
    if (result.startMs !== startMs) throw uncertain();
    return { outcome: 'seeked', tabId: bound.tabId, startMs };
  }
  async function open(job) {
    const { target, video } = job.request;
    const tabs = await wait(job, () => api.tabs.query({ url: [
      'https://www.bilibili.com/video/*', 'https://bilibili.com/video/*', 'https://m.bilibili.com/video/*',
    ] }));
    const candidates = (Array.isArray(tabs) ? tabs : []).filter(tab => Number.isInteger(tab.id)
      && matchesVideoPage(tab.pendingUrl || tab.url, video));
    const existing = candidates.find(tab => tab.id === target.tabId) || candidates.find(tab => tab.active) || candidates[0];
    if (!existing) {
      const opened = await effect(job, () => api.tabs.create({ url: videoPageUrl(video), active: true }));
      if (!Number.isInteger(opened?.id)) throw uncertain();
      return { outcome: 'opened', tabId: opened.id };
    }
    acquire(job, 'tab:' + existing.id);
    const tab = await wait(job, () => api.tabs.get(existing.id));
    assertPageTarget({ tabId: existing.id, url: existing.pendingUrl || existing.url }, { tabId: tab.id, url: tab.pendingUrl || tab.url });
    if (!matchesVideoPage(tab.pendingUrl || tab.url, video)) throw pageChanged();
    job.target = { tabId: tab.id, url: tab.pendingUrl || tab.url };
    const focused = await effect(job, () => api.tabs.update(tab.id, { active: true }));
    assertPageTarget(job.target, { tabId: focused.id, url: focused.pendingUrl || focused.url });
    if (Number.isInteger(tab.windowId) && api.windows?.update) await effect(job, () => api.windows.update(tab.windowId, { focused: true }));
    return { outcome: 'focused', tabId: tab.id };
  }
  function onConnect(port) {
    if (port.name !== VIDEO_NAVIGATION_PORT) return;
    if (disposed || !trusted(api, port.sender) || ports.size >= 4) { port.disconnect(); return; }
    let job = null, started = false;
    const disconnect = () => {
      if (job) { job.finished = true; job.controller.abort(); clearTimeout(job.timer); release(job); }
      ports.delete(port); port.onMessage.removeListener(message); port.onDisconnect.removeListener(disconnect);
    };
    const fail = (request, error) => {
      if (ports.has(port)) try { port.postMessage({ requestId: request?.requestId,
        error: typeof error.code === 'string' ? error.code : error.name || 'VIDEO_NAVIGATION_FAILED',
        message: error.message || '视频定位失败。' }); } catch {}
    };
    const message = request => {
      if (started) return;
      started = true;
      try {
        if (disposed || request?.type !== 'navigate' || !videoNavigationToken(request.requestId)) throw videoError('VIDEO_NAVIGATION_INVALID', '视频定位请求无效。');
        const fixed = captureVideoNavigation(request);
        job = { request: fixed, controller: new AbortController(), effects: 0, finished: false, keys: new Set(),
          deadlineAt: Math.min(Date.now() + timeoutMs, Number.isFinite(request.deadlineAt) ? request.deadlineAt : 0) };
        acquire(job, fixed.action === 'seek' ? 'tab:' + fixed.target.tabId : 'video:' + fixed.video.bvid + ':' + fixed.video.part);
        job.timer = setTimeout(() => job.controller.abort(uncertain()), Math.max(1, job.deadlineAt - Date.now()));
        void awaitWithAbort(fixed.action === 'seek' ? seek(job) : open(job), job.controller.signal).then(result => {
          check(job); port.postMessage({ requestId: request.requestId, result });
        }).catch(error => fail(request, error)).finally(() => { disconnect(); try { port.disconnect(); } catch {} });
      } catch (error) { fail(request, error); disconnect(); try { port.disconnect(); } catch {} }
    };
    ports.set(port, disconnect); port.onMessage.addListener(message); port.onDisconnect.addListener(disconnect);
  }
  const updated = (tabId, change) => {
    if (!change.url && change.status !== 'loading') return;
    const job = locks.get('tab:' + tabId);
    job?.controller.abort(videoError('PAGE_CHANGED', '定位期间原视频页面发生变化，请核对后再点击时间。'));
  };
  const removed = tabId => updated(tabId, { status: 'loading' });
  const activated = ({ tabId, windowId }) => {
    for (const job of new Set(locks.values())) if (job.request.action === 'seek' && Number.isInteger(job.windowId)
      && job.windowId === windowId && job.request.target.tabId !== tabId) job.controller.abort(pageRequired());
  };
  api.runtime.onConnect.addListener(onConnect);
  api.tabs.onUpdated?.addListener(updated); api.tabs.onRemoved?.addListener(removed);
  api.tabs.onActivated?.addListener(activated);
  return Object.freeze({ dispose() {
    if (disposed) return;
    disposed = true; api.runtime.onConnect.removeListener(onConnect);
    api.tabs.onUpdated?.removeListener(updated); api.tabs.onRemoved?.removeListener(removed);
    api.tabs.onActivated?.removeListener(activated);
    for (const [port, disconnect] of [...ports]) { disconnect(); try { port.disconnect(); } catch {} }
    locks.clear();
  } });
}

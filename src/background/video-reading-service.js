import { awaitWithAbort, awaitWithTimeout } from '../utils/abortable.js';
import { assertPageTarget } from '../utils/page-target.js';
import { VIDEO_READING_PORT, VIDEO_LIMITS, videoTarget, videoError, parseVideoUrl,
  validateVideoResult } from '../sidepanel/features/video-notes/video-request.js';
import { biliVideoMetadata, biliSubtitleTrack, biliSubtitleBody,
  readBilibiliPageIdentity } from '../sidepanel/features/video-notes/bilibili-adapter.js';

const token = value => typeof value === 'string' && /^[\w:-]{1,160}$/.test(value);
function trusted(api, sender) {
  if (sender?.id !== api.runtime.id || sender.tab) return false;
  try {
    const url = new URL(sender.url), expected = new URL(api.runtime.getURL('src/sidepanel/index.html'));
    return url.origin === expected.origin && url.protocol === expected.protocol
      && url.host === expected.host && url.pathname === expected.pathname;
  } catch { return false; }
}

/** One short, read-only job per trusted sidepanel port. Disconnect revokes its work. */
export function createVideoReadingService({ chrome: api = globalThis.chrome, fetch: fetcher = globalThis.fetch,
  timeoutMs = VIDEO_LIMITS.timeoutMs, requestMs = VIDEO_LIMITS.requestMs, ioTimeoutMs = 3000 } = {}) {
  const sessions = new Set(), ports = new Set(), cleanups = new Map();
  let disposed = false;
  function check(session) {
    session.controller.signal.throwIfAborted();
    if (disposed || !sessions.has(session)) throw videoError('VIDEO_SESSION_CLOSED', '字幕读取已结束。');
    if (Date.now() >= session.deadlineAt) throw new DOMException('视频字幕读取超时，请重试。', 'TimeoutError');
  }
  async function wait(session, operation) {
    check(session);
    const result = await awaitWithTimeout(Promise.resolve().then(() => { check(session); return operation(); }), {
      signal: session.controller.signal, timeoutMs: ioTimeoutMs, message: '核对原视频页面超时，请重试。',
    });
    check(session);
    return result;
  }
  async function verify(session, video) {
    const target = session.target;
    const tab = await wait(session, () => api.tabs.get(target.tabId));
    assertPageTarget({ tabId: target.tabId, url: target.url }, { tabId: tab.id, url: tab.url });
    const frames = await wait(session, () => api.scripting.executeScript({
      target: { tabId: target.tabId, ...(target.documentId ? { documentIds: [target.documentId] } : { frameIds: [0] }) },
      world: 'MAIN', injectImmediately: true, func: readBilibiliPageIdentity,
    }));
    const frame = frames?.find(entry => entry.frameId === 0);
    const actual = videoTarget({ tabId: tab.id, url: frame?.result?.url, documentId: frame?.documentId }, { documentRequired: true });
    assertPageTarget(target, actual);
    const parsed = parseVideoUrl(actual.url), bvid = frame.result.bvid;
    if ((bvid && (video?.bvid || parsed.bvid) && bvid !== (video?.bvid || parsed.bvid))
      || (video && frame.result.cid && Number(frame.result.cid) !== video.cid)) {
      throw videoError('PAGE_CHANGED', '播放器仍在切换视频或分 P，请等待加载完成后重新整理。');
    }
    session.target = actual;
    return actual;
  }
  async function json(session, url, credentials, video, { fullTranscript = false } = {}) {
    await verify(session, video);
    check(session);
    const controller = new AbortController();
    const abort = () => controller.abort(session.controller.signal.reason);
    session.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('读取 B 站字幕超时，请稍后重试。', 'TimeoutError')), requestMs);
    let reader;
    try {
      const response = await awaitWithAbort(fetcher(url, { signal: controller.signal, credentials,
        redirect: 'error', headers: { Accept: 'application/json' } }), controller.signal);
      check(session); controller.signal.throwIfAborted();
      if (response.redirected || (response.url && response.url !== url)) {
        throw videoError('VIDEO_REDIRECT_DENIED', '字幕请求发生了未经验证的跳转，已停止读取。');
      }
      if (!response.ok) {
        throw videoError(response.status === 401 || response.status === 403 ? 'VIDEO_ACCESS_DENIED' : 'VIDEO_HTTP_ERROR',
          response.status === 401 || response.status === 403
            ? 'B 站拒绝了视频字幕请求，请确认登录状态和访问权限。' : 'B 站字幕请求失败，请稍后重试。');
      }
      if (!fullTranscript && Number(response.headers.get('content-length')) > VIDEO_LIMITS.maxBytes) throw videoError('VIDEO_INPUT_BUDGET', '视频信息响应超出读取上限。');
      reader = response.body?.getReader();
      if (!reader) throw videoError('VIDEO_API_INVALID', '字幕接口返回了空响应。');
      const decoder = new TextDecoder(), chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await awaitWithAbort(reader.read(), controller.signal);
        check(session); controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (!fullTranscript && size > VIDEO_LIMITS.maxBytes) throw videoError('VIDEO_INPUT_BUDGET', '视频信息响应超出读取上限。');
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      await verify(session, video);
      controller.signal.throwIfAborted();
      try { return JSON.parse(chunks.join('')); }
      catch { throw videoError('VIDEO_API_INVALID', '字幕接口未返回有效数据，请稍后重试。'); }
    } finally {
      clearTimeout(timer);
      session.controller.signal.removeEventListener('abort', abort);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
  async function read(session) {
    const parsed = parseVideoUrl(session.target.url);
    const viewUrl = 'https://api.bilibili.com/x/web-interface/view?' + (parsed.bvid
      ? 'bvid=' + encodeURIComponent(parsed.bvid) : 'aid=' + parsed.aid);
    const video = biliVideoMetadata(await json(session, viewUrl, 'include'), session.target.url);
    await verify(session, video);
    const playerUrl = 'https://api.bilibili.com/x/player/wbi/v2?aid=' + video.aid + '&cid=' + video.cid;
    const track = biliSubtitleTrack(await json(session, playerUrl, 'include', video), video);
    let result = { kind: 'unavailable', reason: 'no-subtitles' };
    if (track) result = biliSubtitleBody(await json(session, track.url, 'omit', video, { fullTranscript: true }), video);
    await verify(session, video);
    check(session);
    // Do not return CDN signed URLs, player payloads, cookies or request headers.
    return validateVideoResult({ version: 1, ...result, video, target: session.target,
      capturedAt: new Date().toISOString(),
      ...(result.kind === 'ready' ? { track: { id: track.id, language: track.language, label: track.label, kind: track.kind } } : {}) });
  }
  const onConnect = port => {
    if (port.name !== VIDEO_READING_PORT) return;
    if (disposed || !trusted(api, port.sender)) { port.disconnect(); return; }
    ports.add(port);
    let started = false, session = null;
    const disconnect = () => {
      if (session) {
        session.controller.abort(new DOMException('视频笔记侧栏连接已关闭。', 'AbortError'));
        sessions.delete(session); clearTimeout(session.timer);
      }
      ports.delete(port);
      cleanups.delete(port);
      port.onMessage.removeListener(message); port.onDisconnect.removeListener(disconnect);
    };
    const message = request => {
      if (started) return;
      started = true;
      let target;
      try {
        if (disposed || request?.type !== 'read' || !token(request.requestId) || !token(request.runId)
          || !token(request.conversationId) || !token(request.turnId) || sessions.size >= 4) {
          throw videoError('VIDEO_REQUEST_INVALID', '视频笔记任务身份无效或读取任务过多。');
        }
        target = videoTarget(request.target);
      } catch (error) {
        try { port.postMessage({ requestId: request?.requestId, error: error.code || 'VIDEO_REQUEST_INVALID', message: error.message }); } catch {}
        disconnect(); port.disconnect(); return;
      }
      const remaining = Number.isFinite(request.deadlineAt) ? request.deadlineAt - Date.now() : timeoutMs;
      session = { target, controller: new AbortController(), requestId: request.requestId,
        deadlineAt: Date.now() + Math.min(timeoutMs, remaining) };
      sessions.add(session);
      session.timer = setTimeout(() => session.controller.abort(new DOMException('视频字幕读取超时，请重试。', 'TimeoutError')),
        Math.max(1, Math.min(timeoutMs, remaining)));
      const operation = read(session);
      void awaitWithAbort(operation, session.controller.signal).then(result => {
        check(session);
        port.postMessage({ requestId: request.requestId, result });
      }).catch(error => {
        if (ports.has(port)) {
          try { port.postMessage({ requestId: request.requestId,
            error: error.code || error.name || 'VIDEO_READING_FAILED', message: error.message || '视频字幕读取失败。' }); } catch {}
        }
      }).finally(() => { disconnect(); try { port.disconnect(); } catch {} });
    };
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnect);
    cleanups.set(port, disconnect);
  };
  const navigation = (tabId, change) => {
    if (!change.url && change.status !== 'loading') return;
    for (const session of sessions) if (session.target.tabId === tabId) {
      session.controller.abort(videoError('PAGE_CHANGED', '原视频页面已变化，请重新整理当前视频。'));
    }
  };
  const removed = tabId => navigation(tabId, { status: 'loading' });
  api.runtime.onConnect.addListener(onConnect);
  api.tabs.onUpdated?.addListener(navigation);
  api.tabs.onRemoved?.addListener(removed);
  return Object.freeze({ dispose() {
    if (disposed) return;
    disposed = true;
    api.runtime.onConnect.removeListener(onConnect);
    api.tabs.onUpdated?.removeListener(navigation); api.tabs.onRemoved?.removeListener(removed);
    for (const port of [...ports]) { cleanups.get(port)?.(); try { port.disconnect(); } catch {} }
    for (const session of sessions) { session.controller.abort(); clearTimeout(session.timer); }
    sessions.clear(); ports.clear();
  } });
}

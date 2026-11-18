import { awaitWithAbort, awaitWithTimeout } from '../utils/abortable.js';
import { assertPageTarget } from '../utils/page-target.js';
import { biliVideoMetadata } from '../sidepanel/features/video-notes/bilibili-adapter.js';
import { validateVideoResult, videoError } from '../sidepanel/features/video-notes/video-request.js';
import { FRAME_SCAN, VIDEO_SCAN_PORT, VIDEO_DECODER_PORT, bilibiliHostOrigin, canScanFrames,
  isScanCursor, isScanToken, selectBilibiliDash, validateScanBlock } from '../sidepanel/features/video-notes/video-scan-protocol.js';

const hostLost = () => videoError('VIDEO_SCAN_HOST_LOST', '原 B 站页面已离开，画面扫描已停止。');
const invalid = () => videoError('VIDEO_SCAN_INVALID', '画面扫描任务或返回数据不有效，已停止。');

function isSidepanel(api, sender) {
  if (sender?.id !== api.runtime.id || sender.tab) return false;
  try {
    const url = new URL(sender.url), panel = new URL(api.runtime.getURL('src/sidepanel/index.html'));
    return url.protocol === panel.protocol && url.host === panel.host && url.pathname === panel.pathname;
  } catch { return false; }
}

async function fetchMetadata(fetcher, url, signal) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(FRAME_SCAN.blockMs)]);
  let response;
  try { response = await awaitWithAbort(fetcher(url, { signal, credentials: 'include', redirect: 'error',
    headers: { Accept: 'application/json' } }), signal); }
  catch { signal.throwIfAborted(); throw videoError('VIDEO_SCAN_NETWORK', '无法连接 B 站视频接口，请检查网络后重试。'); }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw videoError('VIDEO_SCAN_NETWORK', 'B 站视频接口未返回可用数据，请检查原视频和访问权限。');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await awaitWithAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw invalid();
      text += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); } catch { throw invalid(); }
  } finally { void reader.cancel().catch(() => {}); }
}

export function createVideoScanService({ chrome: api = globalThis.chrome, fetch: fetcher = globalThis.fetch, decoderFile,
  scanMs = FRAME_SCAN.scanMs, blockMs = FRAME_SCAN.blockMs, ioMs = 5000 } = {}) {
  const jobs = new Set(), leases = new Set(), ports = new Map();
  let disposed = false;

  async function readHost(job, tabId, documentId) {
    const target = { tabId, ...(documentId ? { documentIds: [documentId] } : { frameIds: [0] }) };
    const frames = await awaitWithTimeout(api.scripting.executeScript({ target, world: 'ISOLATED', injectImmediately: true,
      func: () => location.href }), { signal: job.signal, timeoutMs: ioMs });
    job.signal.throwIfAborted();
    const frame = frames?.find(entry => entry.frameId === 0);
    if (!frame?.documentId || !bilibiliHostOrigin(frame.result)) throw hostLost();
    return { tabId, documentId: frame.documentId, url: frame.result };
  }

  async function attachHost(job, original, resume) {
    let host;
    if (!resume) {
      try { host = await readHost(job, original.tabId, original.documentId); }
      catch { job.signal.throwIfAborted(); throw hostLost(); }
      const expected = assertPageTarget(original, host);
      if (leases.has(expected.tabId)) throw videoError('VIDEO_SCAN_TAB_BUSY', '这个标签页已有画面扫描正在运行。');
    } else {
      const tabs = await awaitWithTimeout(api.tabs.query({ url: ['https://www.bilibili.com/*', 'https://bilibili.com/*', 'https://m.bilibili.com/*'] }),
        { signal: job.signal, timeoutMs: ioMs });
      job.signal.throwIfAborted();
      for (const tab of tabs.filter(item => Number.isInteger(item.id) && !leases.has(item.id)).slice(0, 4)) {
        try { host = await readHost(job, tab.id); }
        catch { job.signal.throwIfAborted(); }
        if (host && !leases.has(host.tabId)) break;
        host = null;
      }
      if (!host) {
        const tab = await awaitWithTimeout(api.tabs.create({ url: 'https://www.bilibili.com/', active: false }),
          { signal: job.signal, timeoutMs: ioMs });
        job.signal.throwIfAborted();
        const expires = Date.now() + ioMs;
        do {
          try { host = await readHost(job, tab.id); break; }
          catch { job.signal.throwIfAborted(); }
          await new Promise(resolve => setTimeout(resolve, 250));
          job.signal.throwIfAborted();
        } while (Date.now() < expires);
      }
      if (!host || leases.has(host.tabId)) throw hostLost();
    }
    job.signal.throwIfAborted();
    job.host = host;
    leases.add(host.tabId);
  }

  async function start(job, offer, quality, resume, connect) {
    await attachHost(job, offer.target, resume);
    const { video } = offer;
    const view = await fetchMetadata(fetcher, `https://api.bilibili.com/x/web-interface/view?bvid=${video.bvid}`, job.signal);
    job.signal.throwIfAborted();
    const actual = biliVideoMetadata(view, offer.target.url);
    if (actual.aid !== video.aid || actual.cid !== video.cid || actual.duration !== video.duration) {
      throw videoError('PAGE_CHANGED', '原视频或分 P 的信息已变化，请重新读取字幕。');
    }
    if (view.data.rights?.pay || view.data.is_chargeable_season || view.data.is_upower_exclusive || view.data.rights?.is_stein_gate) {
      throw videoError('VIDEO_SCAN_ACCESS_DENIED', '画面识别不处理付费、互动或受保护视频。');
    }
    const play = `https://api.bilibili.com/x/player/playurl?avid=${video.aid}&bvid=${video.bvid}&cid=${video.cid}&fnval=16&qn=64&fourk=0`;
    const media = selectBilibiliDash(await fetchMetadata(fetcher, play, job.signal), video, quality);
    job.signal.throwIfAborted();
    try {
      const host = await readHost(job, job.host.tabId, job.host.documentId);
      if (bilibiliHostOrigin(host.url) !== bilibiliHostOrigin(job.host.url)) throw hostLost();
      const anchor = { tabId: job.host.tabId, documentIds: [job.host.documentId] };
      const injection = await awaitWithTimeout(api.scripting.executeScript({ target: anchor, world: 'ISOLATED',
        files: [decoderFile], injectImmediately: true }), { signal: job.signal, timeoutMs: ioMs });
      job.signal.throwIfAborted();
      if (!injection?.some(frame => frame.frameId === 0 && frame.documentId === job.host.documentId)) throw hostLost();
    } catch { job.signal.throwIfAborted(); throw hostLost(); }
    connect(media);
  }

  const accept = port => {
    if (port.name !== VIDEO_SCAN_PORT) return;
    if (disposed || !isSidepanel(api, port.sender)) { port.disconnect(); return; }
    let job, decoder, requestId, timer, blockTimer, scannedMs = 0, pending, quality, resolution, finished = false;
    const post = value => port.postMessage({ requestId, ...value });
    const close = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(blockTimer);
      ports.delete(port);
      port.onMessage.removeListener(message); port.onDisconnect.removeListener(close);
      if (job) {
        job.controller.abort(); jobs.delete(job);
        if (job.host) leases.delete(job.host.tabId);
      }
      try { decoder?.disconnect(); } catch {}
      try { port.disconnect(); } catch {}
    };
    const finish = result => { if (!finished) { try { post(result); } catch {} finally { close(); } } };
    const done = status => finish({ type: 'done', status, scannedMs: pending ?? scannedMs, quality, resolution });
    const error = failure => {
      if (failure.code === 'VIDEO_SCAN_HOST_LOST' && job) done('interrupted');
      else finish({ type: 'error', code: failure.code || 'VIDEO_SCAN_FAILED', message: failure.code
        ? failure.message : '未能准备画面扫描，请检查原视频页面或稍后重试。' });
    };
    const armBlock = () => { clearTimeout(blockTimer); blockTimer = setTimeout(() => done('timeout'), blockMs); };
    const connect = (media, durationMs) => {
      quality = media.quality;
      resolution = `${media.width}×${media.height}`;
      decoder = api.tabs.connect(job.host.tabId, { name: VIDEO_DECODER_PORT, documentId: job.host.documentId });
      decoder.onDisconnect.addListener(() => done('interrupted'));
      decoder.onMessage.addListener(value => {
        if (finished || value?.requestId !== requestId) return;
        if (value.type === 'done' && pending === undefined && value.scannedMs === scannedMs && ['complete', 'limited'].includes(value.status)) {
          done(value.status); return;
        }
        if (value.type === 'error') {
          const mediaDenied = value.code === 'VIDEO_MEDIA_INACCESSIBLE';
          error(videoError(mediaDenied ? value.code : 'VIDEO_DECODE_UNSUPPORTED', mediaDenied
            ? 'B 站视频分片无法读取（可能受跨域、地区或访问限制）。'
            : '无法解码这个视频流；加密流或不兼容的编码/分片格式不受支持。'));
          return;
        }
        const block = value.type === 'block' && pending === undefined && validateScanBlock(value, scannedMs, durationMs);
        if (!block) { error(invalid()); return; }
        pending = block.scannedMs;
        armBlock();
        try { post({ type: 'block', quality, resolution, ...block }); } catch { close(); }
      });
      armBlock();
      decoder.postMessage({ type: 'scan', requestId, media, durationMs, startMs: scannedMs });
    };
    const message = input => {
      if (job) {
        if (input?.type !== 'ack' || input.requestId !== requestId || pending === undefined || input.scannedMs !== pending) return;
        scannedMs = pending; pending = undefined; armBlock();
        try { decoder.postMessage(input); } catch { done('interrupted'); }
        return;
      }
      try {
        requestId = input?.requestId;
        if (input?.type !== 'scan' || ![requestId, input.runId, input.conversationId, input.turnId].every(isScanToken)
          || typeof input.resume !== 'boolean' || !Number.isFinite(input.deadlineAt) || disposed || !decoderFile) throw invalid();
        if (jobs.size >= 2) throw videoError('VIDEO_SCAN_BUSY', '已有两项画面扫描在运行，请稍后重试。');
        const offer = validateVideoResult(input.offer);
        const durationMs = Math.round(offer.video.duration * 1000);
        if (offer.kind !== 'unavailable' || !canScanFrames(offer.reason) || !isScanCursor(input.startMs, durationMs)
          || (!input.resume && (input.startMs !== 0 || input.quality !== undefined))
          || (input.quality !== undefined && (!Number.isInteger(input.quality) || input.quality < 1 || input.quality > 256))) throw invalid();
        if (durationMs > FRAME_SCAN.maxDurationMs) throw videoError('VIDEO_SCAN_DURATION', '画面扫描只支持不超过 2 小时的单个视频分 P。');
        scannedMs = input.startMs;
        const controller = new AbortController();
        job = { controller, signal: controller.signal, host: null };
        jobs.add(job);
        const remaining = Math.min(scanMs, input.deadlineAt - Date.now());
        if (remaining <= 0) { done('timeout'); return; }
        timer = setTimeout(() => done('timeout'), remaining);
        void start(job, offer, input.quality, input.resume, media => connect(media, durationMs)).catch(error);
      } catch (failure) { error(failure); }
    };
    port.onMessage.addListener(message); port.onDisconnect.addListener(close);
    ports.set(port, close);
  };

  api.runtime.onConnect.addListener(accept);
  return Object.freeze({ dispose() {
    disposed = true;
    api.runtime.onConnect.removeListener(accept);
    for (const close of ports.values()) close();
  } });
}

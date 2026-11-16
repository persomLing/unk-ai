import { parseVideoUrl, videoError, normalizeVideoCues } from './video-request.js';

const fail = message => videoError('VIDEO_API_INVALID', message || 'B 站没有返回有效的视频字幕资料，请稍后重试。');
const nonSpeech = /^(?:\s*(?:\[(?:music|instrumental|applause|silence|音乐|纯音乐|掌声|音效)\]|[（(](?:音乐|纯音乐|掌声|音效|music)[）)]|[♪♫♬]+)\s*)+$/i;

export function biliApiData(response) {
  if (!response || typeof response.code !== 'number') throw fail();
  if ([-101, -102, -403, 62002, 62004].includes(response.code)) {
    throw videoError('VIDEO_ACCESS_DENIED', 'B 站视频或字幕暂不可访问，请确认登录状态和视频访问权限。');
  }
  if ([-352, -412, -509].includes(response.code)) throw videoError('VIDEO_RATE_LIMITED', 'B 站暂时限制了字幕请求，请稍后重试。');
  if (response.code !== 0 || !response.data || typeof response.data !== 'object') throw fail();
  return response.data;
}

export function biliVideoMetadata(response, url) {
  const parsed = parseVideoUrl(url), data = biliApiData(response);
  if (!parsed || (parsed.bvid && data.bvid !== parsed.bvid) || (parsed.aid && data.aid !== parsed.aid)
    || !/^BV[a-zA-Z0-9]{10}$/.test(data.bvid || '') || !Array.isArray(data.pages)) throw fail();
  const parts = data.pages.filter(page => page?.page === parsed.part);
  if (parts.length !== 1) throw videoError('VIDEO_PART_MISSING', '找不到当前视频分 P，请等待页面加载完成后重试。');
  const part = parts[0];
  if (!Number.isSafeInteger(data.aid) || data.aid <= 0 || !Number.isSafeInteger(part.cid) || part.cid <= 0
    || !Number.isFinite(part.duration) || part.duration <= 0 || typeof data.title !== 'string' || !data.title.trim()) throw fail();
  // Only a complete, unique 1..N list supports a total. Partial metadata can
  // still identify the selected P, but must not turn its length into a total.
  const completeParts = data.pages.length <= 99999 && data.pages.every((page, index) =>
    page?.page === index + 1 && Number.isSafeInteger(page.cid) && page.cid > 0)
    && new Set(data.pages.map(page => page.cid)).size === data.pages.length;
  return { platform: 'bilibili', bvid: data.bvid, aid: data.aid, cid: part.cid,
    part: parsed.part, title: data.title.slice(0, 512), duration: part.duration,
    ...(completeParts ? { partCount: data.pages.length } : {}),
    partTitle: typeof part.part === 'string' ? part.part.slice(0, 256) : '' };
}

/** The CDN allowlist is deliberately separate from extension host permissions. */
export function biliSubtitleUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw fail();
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    const jsonSubtitle = /^\/bfs\/(?:subtitle|ai_subtitle)\/[a-zA-Z0-9/_.-]+\.json$/.test(url.pathname);
    // Current Bilibili AI tracks also use an opaque production resource without
    // a file extension. Keep this exception on its observed host and path.
    const productionAiSubtitle = url.hostname === 'aisubtitle.hdslb.com'
      && /^\/bfs\/ai_subtitle\/prod\/[a-f0-9]{32,128}$/.test(url.pathname);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !/^(?:aisubtitle|i\d)\.hdslb\.com$/.test(url.hostname)
      || !(jsonSubtitle || productionAiSubtitle)) throw fail();
    return url.href;
  } catch { throw videoError('VIDEO_SUBTITLE_URL_DENIED', '字幕地址不在支持的 B 站字幕来源中，已停止读取。'); }
}

export function biliSubtitleTrack(response, video) {
  const data = biliApiData(response);
  if (data.cid !== video.cid || data.aid !== video.aid || data.bvid !== video.bvid) {
    throw videoError('PAGE_CHANGED', '播放器与原视频分 P 不一致，请重新读取。');
  }
  if (data.need_login_subtitle || data.subtitle?.need_login_subtitle) {
    throw videoError('VIDEO_LOGIN_REQUIRED', '这个视频的字幕需要登录 B 站后才能读取。');
  }
  if (!data.subtitle || !Array.isArray(data.subtitle.subtitles) || data.subtitle.subtitles.length > 100) throw fail();
  const tracks = [];
  for (const row of data.subtitle.subtitles) {
    if (/danmaku|弹幕/i.test(String(row?.lan || '') + ' ' + String(row?.lan_doc || ''))) continue;
    if (!row || typeof row.lan !== 'string' || !row.lan || !row.subtitle_url) throw fail();
    const language = row.lan.replace(/^ai-/, '');
    if (!/^(?:[a-z]{2,3})(?:-[a-z0-9]{2,8})*$/i.test(language)) throw fail();
    const kind = Number(row.ai_type) > 0 || row.lan.startsWith('ai-') || /自动/.test(row.lan_doc || '') ? 'auto' : 'manual';
    tracks.push({ id: String(row.id_str || row.id || row.lan).slice(0, 120), language,
      label: typeof row.lan_doc === 'string' ? row.lan_doc.slice(0, 64) : language,
      kind, url: biliSubtitleUrl(row.subtitle_url) });
  }
  const score = track => (/^zh(?:-|$)/i.test(track.language) ? 0 : 10) + (track.kind === 'manual' ? 0 : 1);
  tracks.sort((left, right) => score(left) - score(right) || left.language.localeCompare(right.language));
  return tracks[0] || null;
}

export function biliSubtitleBody(response, video) {
  if (!response || !Array.isArray(response.body)) throw fail('字幕文件没有有效正文，尚未生成笔记。');
  const cues = normalizeVideoCues(response.body.map(cue => ({
    startMs: typeof cue?.from === 'number' ? cue.from * 1000 : NaN,
    endMs: typeof cue?.to === 'number' ? cue.to * 1000 : NaN, text: cue?.content,
  })), video.duration);
  if (!cues.length) return { kind: 'unavailable', reason: 'empty-subtitles' };
  if (cues.every(cue => nonSpeech.test(cue.text))) return { kind: 'unavailable', reason: 'non-speech' };
  return { kind: 'ready', cues };
}

/** Executed as a fixed MAIN-world function; only bounded identity fields leave the page. */
export function readBilibiliPageIdentity() {
  const scalar = value => (typeof value === 'string' || typeof value === 'number') ? String(value).slice(0, 64) : '';
  return { url: location.href,
    bvid: scalar(globalThis.bvid || globalThis.__INITIAL_STATE__?.videoData?.bvid),
    cid: scalar(globalThis.cid) };
}

import { assertPageTarget, pageTargetFields } from '../../../utils/page-target.js';

export const VIDEO_READING_PORT = 'unk-ai-video-notes';
export const VIDEO_PROVIDER_ID = 'video-transcript';
export const VIDEO_CONTEXT_MAX_CHARS = 15000;
export const VIDEO_LIMITS = Object.freeze({ timeoutMs: 20000, requestMs: 8000,
  maxBytes: 2 * 1024 * 1024, maxCues: 20000, maxChars: 300000 });
export const videoError = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => videoError('VIDEO_DATA_INVALID', '视频字幕资料不完整或版本不支持，请回到原视频重新整理。');
const integer = value => Number.isSafeInteger(value) && value > 0;
const field = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';

/** URL recognition is metadata only. It never implies the presence of subtitles. */
export function parseVideoUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10}|av[1-9]\d*)\/?$/);
    const part = url.searchParams.get('p') ?? '1';
    if (!match || url.searchParams.getAll('p').length > 1 || !/^[1-9]\d{0,4}$/.test(part)) return null;
    const bvid = match[1].startsWith('BV') ? match[1] : '';
    const aid = bvid ? null : Number(match[1].slice(2));
    if (aid !== null && !integer(aid)) return null;
    return { platform: 'bilibili', bvid, aid, part: Number(part) };
  } catch { return null; }
}

export function videoTarget(value, { documentRequired = false } = {}) {
  const fields = pageTargetFields(value);
  if (!Number.isInteger(fields.tabId) || fields.tabId < 0 || !parseVideoUrl(fields.expectedUrl)
    || (documentRequired && !fields.documentId) || (fields.documentId && fields.documentId.length > 160)) {
    throw videoError('VIDEO_TARGET_INVALID', '请选中 B 站普通视频页面后，再使用视频笔记。');
  }
  return { tabId: fields.tabId, url: fields.expectedUrl,
    ...(fields.documentId ? { documentId: fields.documentId } : {}) };
}

export function captureVideoRequest(value) {
  if (!value || value.kind !== 'video-notes' || value.version !== 1) throw invalid();
  return { kind: 'video-notes', version: 1, target: videoTarget(value.target) };
}

export function normalizeVideoCues(values, duration) {
  if (!Array.isArray(values) || values.length > VIDEO_LIMITS.maxCues) throw invalid();
  const cues = [];
  let chars = 0, previousStart = -1;
  for (const value of values) {
    if (!value || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)
      || value.startMs < 0 || value.endMs <= value.startMs || value.endMs > (duration + 10) * 1000
      || value.startMs < previousStart || typeof value.text !== 'string') throw invalid();
    previousStart = value.startMs;
    const text = value.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    chars += text.length;
    if (chars > VIDEO_LIMITS.maxChars) throw videoError('VIDEO_INPUT_BUDGET', '字幕超出读取上限，尚未整理整片视频。');
    if (text) cues.push({ id: 'c' + (cues.length + 1), startMs: Math.round(value.startMs),
      endMs: Math.round(value.endMs), text });
  }
  return cues;
}

export function validateVideoResult(value, expectedTarget) {
  if (!value || value.version !== 1 || !['ready', 'unavailable'].includes(value.kind)) throw invalid();
  const target = videoTarget(value.target, { documentRequired: true });
  if (expectedTarget) assertPageTarget(expectedTarget, target);
  const parsed = parseVideoUrl(target.url), video = value.video;
  if (!video || video.platform !== 'bilibili' || !/^BV[a-zA-Z0-9]{10}$/.test(video.bvid || '')
    || !integer(video.aid) || !integer(video.cid) || video.part !== parsed.part
    || (video.partCount !== undefined && (!integer(video.partCount) || video.partCount < video.part || video.partCount > 99999))
    || (parsed.bvid && parsed.bvid !== video.bvid) || (parsed.aid && parsed.aid !== video.aid)
    || !Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 172800
    || !field(video.title, 512) || !Number.isFinite(Date.parse(value.capturedAt))) throw invalid();
  const result = { version: 1, kind: value.kind, target,
    video: { platform: 'bilibili', bvid: video.bvid, aid: video.aid, cid: video.cid,
      part: video.part, title: field(video.title, 512), duration: video.duration,
      ...(video.partCount !== undefined ? { partCount: video.partCount } : {}),
      ...(field(video.partTitle, 256) ? { partTitle: field(video.partTitle, 256) } : {}) },
    capturedAt: value.capturedAt };
  if (value.kind === 'unavailable') {
    if (!['no-subtitles', 'empty-subtitles', 'non-speech'].includes(value.reason)) throw invalid();
    return { ...result, reason: value.reason };
  }
  const track = value.track;
  if (!track || !field(track.id, 120) || !/^(?:[a-z]{2,3})(?:-[a-z0-9]{2,8})*$/i.test(track.language || '')
    || !['manual', 'auto'].includes(track.kind)) throw invalid();
  const cues = normalizeVideoCues(value.cues, video.duration);
  if (!cues.length) throw invalid();
  return { ...result, track: { id: field(track.id, 120), language: track.language,
    label: field(track.label, 64) || track.language, kind: track.kind }, cues };
}

export function hasVideoTranscript(attachments) {
  return Array.isArray(attachments) && attachments.some(item => item?.type === 'video-transcript');
}

export function selectedVideoTranscript(attachments, { agentTask = false } = {}) {
  const values = (Array.isArray(attachments) ? attachments : []).filter(item => item?.type === 'video-transcript');
  if (!values.length) return null;
  if (agentTask) throw videoError('VIDEO_AGENT_UNSUPPORTED', '视频字幕当前仅支持普通问答，请退出页面操作模式，或移除字幕附件。');
  if (values.length !== 1) throw invalid();
  const value = validateVideoResult(values[0].videoTranscript);
  if (value.kind !== 'ready') throw invalid();
  return value;
}

export function createVideoAttachment(value) {
  const transcript = validateVideoResult(value);
  if (transcript.kind !== 'ready') throw invalid();
  return { type: 'video-transcript',
    id: 'video:' + transcript.video.bvid + ':' + transcript.video.cid + ':' + transcript.track.id + ':' + transcript.capturedAt,
    name: videoCaptionTitle(transcript.video),
    size: new TextEncoder().encode(JSON.stringify(transcript)).byteLength, videoTranscript: transcript };
}

export function videoDisplayTitle(video) {
  return field(video.partTitle, 256) || field(video.title, 512);
}

export function videoCaptionTitle(video) {
  return videoDisplayTitle(video) + ' · P' + video.part
    + (video.partCount ? '/' + video.partCount : '') + ' 字幕';
}

/** Shareable fallback; only the original video/P and subtitle time are encoded. */
export function videoPageUrl(video) {
  return 'https://www.bilibili.com/video/' + video.bvid + '/?p=' + video.part;
}

export function videoTimestampUrl(video, startMs) {
  return videoPageUrl(video) + '&t=' + Math.floor(startMs / 1000);
}

export function videoTimestamp(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60);
  return (minutes >= 60 ? String(Math.floor(minutes / 60)).padStart(2, '0') + ':' : '')
    + String(minutes % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}

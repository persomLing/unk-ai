import { parseVideoUrl, videoTarget, videoError } from './video-request.js';

export const VIDEO_NAVIGATION_PORT = 'unk-ai-video-navigation';
export const VIDEO_NAVIGATION_TIMEOUT_MS = 6000;
export const videoNavigationToken = value => typeof value === 'string' && /^[\w:-]{1,160}$/.test(value);

export function matchesVideoPage(url, video) {
  const parsed = parseVideoUrl(url);
  return Boolean(parsed && parsed.part === video.part
    && (parsed.bvid ? parsed.bvid === video.bvid : parsed.aid === video.aid));
}

/** Each click creates a fresh execution target. Historical document IDs are
 * source metadata, not a permanent lease on a document that may have reloaded.
 * Seeking and opening the title have separate, explicit execution scopes. */
export function captureVideoNavigation(value) {
  const target = videoTarget(value?.target);
  const video = value.video, parsed = parseVideoUrl(target.url);
  const action = value.action || 'seek';
  if (value.version !== 1 || !['seek', 'open'].includes(action) || !video || !/^BV[a-zA-Z0-9]{10}$/.test(video.bvid || '')
    || video.platform !== 'bilibili' || !Number.isSafeInteger(video.aid) || video.aid <= 0
    || !Number.isSafeInteger(video.cid) || video.cid <= 0 || video.part !== parsed.part
    || (parsed.bvid && parsed.bvid !== video.bvid) || (parsed.aid && parsed.aid !== video.aid)
    || !Number.isFinite(video.duration) || video.duration <= 0 || !Number.isSafeInteger(Math.round(video.duration * 1000))
    || (action === 'seek' && (!Number.isSafeInteger(value.startMs) || value.startMs < 0 || value.startMs >= video.duration * 1000))
    || (action === 'open' && value.startMs !== undefined)
    || !videoNavigationToken(value.conversationId) || !videoNavigationToken(value.messageId)
    || !videoNavigationToken(value.turnId)) {
    throw videoError('VIDEO_NAVIGATION_INVALID', '视频时间引用无效，请重新打开这条笔记。');
  }
  return { version: 1, action, target,
    video: { platform: 'bilibili', bvid: video.bvid, aid: video.aid, cid: video.cid,
      part: video.part, duration: video.duration }, ...(action === 'seek' ? { startMs: value.startMs } : {}),
    conversationId: value.conversationId, messageId: value.messageId, turnId: value.turnId };
}

import { videoTranscriptForMessage } from './video-notes-presentation.js';
import { videoTimeForLink } from './video-timestamps.js';
import { videoTimestamp, videoDisplayTitle } from './video-request.js';
import { matchesVideoPage } from './video-navigation-request.js';
import { navigateVideoTimestamp } from './video-navigation-client.js';

/** Owns user clicks only, never conversation generation or persistence. */
export function createVideoTimestampNavigation({ root, getConversation, getPlaybackTarget = () => null, connect,
  onNotice = () => {}, navigate = navigateVideoTimestamp }) {
  let pending = null, disposed = false;
  const current = entry => {
    const page = entry.action === 'seek' ? getPlaybackTarget() : null;
    return !disposed && getConversation() === entry.conversation
      && (entry.action !== 'seek' || (page?.tabId === entry.target.tabId && page?.url === entry.target.url))
      && entry.conversation.messages.some(message => message === entry.message && message.runId === entry.runId);
  };
  function sync() {
    if (pending && !current(pending)) { pending.controller.abort(); pending = null; }
  }
  async function click(event) {
    if (disposed || event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
    const link = event.target.closest('a');
    if (!link || !root.contains(link) || !link.closest('[data-message-content], .video-notes-source-details')) return false;
    const conversation = getConversation();
    const id = link.closest('[data-message-id]')?.dataset.messageId;
    const message = conversation?.messages.find(item => item.id === id);
    const transcript = videoTranscriptForMessage(message, conversation?.messages);
    const startMs = transcript ? videoTimeForLink(transcript, link.href, link.textContent) : null;
    const title = transcript && matchesVideoPage(link.href, transcript.video)
      && [videoDisplayTitle(transcript.video), '原视频'].includes(link.textContent.trim());
    if (startMs === null && !title) {
      // A missing old snapshot must not turn a time-control click into a link
      // navigation. Keep ordinary links and title links usable.
      if (message?.videoNotesVersion === 1 && /^\[(?:\d{2,}:)?\d{2}:\d{2}\]$/.test(link.textContent)) {
        event.preventDefault(); onNotice('这条笔记的字幕记录不可用，暂时无法控制播放进度。', 'error'); return true;
      }
      return false;
    }
    event.preventDefault(); sync();
    if (pending) return true;
    const action = title ? 'open' : 'seek';
    const page = getPlaybackTarget();
    const matchingPage = page && matchesVideoPage(page.url, transcript.video);
    if (action === 'seek' && !matchingPage) {
      onNotice('请先点击笔记标题，回到这个视频的第 ' + transcript.video.part + ' 集，再调整播放进度。'); return true;
    }
    const target = { ...(matchingPage ? page : transcript.target) };
    const entry = { conversation, message, runId: message.runId, action, target, controller: new AbortController() };
    pending = entry;
    try {
      const result = await navigate(connect, { version: 1, action, target, video: transcript.video,
        ...(action === 'seek' ? { startMs } : {}), conversationId: conversation.id, messageId: message.id, turnId: message.turnId }, { signal: entry.controller.signal });
      if (current(entry) && pending === entry) onNotice(action === 'seek' ? '已定位到 ' + videoTimestamp(startMs)
        : result.outcome === 'focused' ? '已切回对应视频，播放进度保持不变' : '已打开对应视频');
    } catch (error) {
      if (current(entry) && pending === entry && !entry.controller.signal.aborted) onNotice(error.message || '视频定位失败，请核对原视频。', 'error');
    } finally { if (pending === entry) pending = null; }
    return true;
  }
  const listener = event => { void click(event); };
  root.addEventListener('click', listener);
  return Object.freeze({ click, sync, dispose() {
    if (disposed) return;
    disposed = true; pending?.controller.abort(); pending = null; root.removeEventListener('click', listener);
  } });
}

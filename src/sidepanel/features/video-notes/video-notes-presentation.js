import { assertPageTarget } from '../../../utils/page-target.js';
import { captureVideoRequest, selectedVideoTranscript, videoCaptionTitle, validateVideoResult } from './video-request.js';
import { appendVideoNotesScope, upgradeVideoAnswer, videoNotesScope } from './transcript-context.js';

export function videoTranscriptForMessage(message, messages) {
  if (message?.role !== 'assistant' || message.videoNotesVersion !== 1) return null;
  const index = (messages || []).findIndex(item => item.id === message.id);
  const user = index > 0 ? messages[index - 1] : null;
  if (user?.role !== 'user' || (message.turnId && message.turnId !== user.turnId)) return null;
  try {
    const request = captureVideoRequest(user.pageCommand);
    const transcript = selectedVideoTranscript(user.attachments);
    if (!transcript) return null;
    assertPageTarget(request.target, transcript.target);
    return transcript;
  } catch { return null; } // An old/corrupt snapshot must not break message display.
}

export function videoAttachmentName(attachment) {
  if (attachment?.type === 'video-transcript') {
    try {
      const transcript = validateVideoResult(attachment.videoTranscript);
      return videoCaptionTitle(transcript.video, transcript.track.kind);
    } catch {}
  }
  return attachment?.name;
}

/** Project saved metadata into the view/copy/export without rewriting history. */
export function presentVideoNotesMessage(message, messages, { includeScope = false } = {}) {
  const transcript = videoTranscriptForMessage(message, messages);
  if (!transcript) return message;
  const { videoNotesContext: info } = message;
  const scope = message.videoNotesOutcome === 'notes' && info?.version === 1
    ? videoNotesScope(transcript, info) : null;
  const content = upgradeVideoAnswer(transcript, message.content);
  return { ...message, content: scope && includeScope ? appendVideoNotesScope(content, scope) : content,
    ...(scope && !includeScope ? { videoNotesScope: scope } : {}),
    ...(Array.isArray(message.sources) ? { sources: message.sources.map(source =>
      source.kind === 'video-transcript' && source.url === transcript.target.url
        ? { ...source, title: videoCaptionTitle(transcript.video, transcript.track.kind) } : source) } : {}) };
}

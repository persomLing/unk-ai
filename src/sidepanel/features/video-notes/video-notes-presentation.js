import { assertPageTarget } from '../../../utils/page-target.js';
import { captureVideoRequest, selectedVideoTranscript, videoCaptionTitle, validateVideoResult } from './video-request.js';
import { upgradeVideoAnswer } from './transcript-context.js';

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
    try { return videoCaptionTitle(validateVideoResult(attachment.videoTranscript).video); } catch {}
  }
  return attachment?.name;
}

/** Project saved metadata into the view/copy/export without rewriting history. */
export function presentVideoNotesMessage(message, messages) {
  const transcript = videoTranscriptForMessage(message, messages);
  if (!transcript) return message;
  return { ...message, content: upgradeVideoAnswer(transcript, message.content),
    ...(Array.isArray(message.sources) ? { sources: message.sources.map(source =>
      source.kind === 'video-transcript' && source.url === transcript.target.url
        ? { ...source, title: videoCaptionTitle(transcript.video) } : source) } : {}) };
}

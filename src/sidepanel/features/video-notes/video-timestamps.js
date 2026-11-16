import MarkdownIt from 'markdown-it';
import { videoTimestamp, videoTimestampUrl } from './video-request.js';

export function videoCueTimes(transcript) {
  const times = new Map();
  for (const cue of transcript.cues) {
    if (cue.startMs >= transcript.video.duration * 1000) continue;
    times.set(videoTimestamp(cue.startMs), Math.floor(cue.startMs / 1000) * 1000);
  }
  return times;
}

const markdown = new MarkdownIt({ html: false });
// Record only our canonical, verified time links. Markdown still owns parsing
// them; code, images and surrounding ordinary links keep their original syntax.
markdown.inline.ruler.before('link', 'video_time_link', (state, silent) => {
  const rewrite = state.env.videoRewrite;
  if (!rewrite?.compact || state.src !== rewrite.source || state.linkLevel || silent) return false;
  const match = state.src.slice(state.pos).match(/^\[\[((?:\d{2}:)?\d{2}:\d{2})\]\]\(([^\s()]+)(?:[ \t]+"[^"\n]*")?\)/);
  if (!match) return false;
  const time = rewrite.times.get(match[1]);
  if (time !== undefined && match[2] === videoTimestampUrl(rewrite.video, time)) {
    rewrite.edits.push({ start: state.pos, end: state.pos + match[0].length, replacement: match[0], time });
  }
  return false;
});
// Let Markdown's link, image, escape and code rules claim their content first.
// Edits are collected against the original source; no Markdown is reserialized.
markdown.inline.ruler.after('link', 'video_reference', (state, silent) => {
  const rewrite = state.env.videoRewrite;
  if (!rewrite || state.src !== rewrite.source || state.linkLevel || silent) return false;
  const match = state.src.slice(state.pos).match(/^\[\[(c\d+)\]\]|^\[((?:\d{2}:)?\d{2}:\d{2})\]/);
  if (!match || (!match[1] && !rewrite.legacy)) return false;
  const following = state.src.slice(state.pos + match[0].length);
  const nextCitation = /^\[(?:\[c\d+\]|\[?(?:\d{2}:)?\d{2}:\d{2}\]?)\]/.test(following);
  // Adjacent references ([[c1]][[c2]], [00:14][00:20]) are independent
  // citations, not a Markdown reference-link suffix. Existing links have
  // already been claimed by Markdown's own rule above.
  if (!match[1] && /[\[(:]/.test(following[0] || '') && !nextCitation) return false;
  const cue = match[1] ? rewrite.cues.get(match[1]) : undefined;
  const stamp = cue ? videoTimestamp(cue.startMs) : match[2];
  const time = rewrite.times.get(stamp);
  const replacement = time !== undefined
    ? '[[' + stamp + ']](' + videoTimestampUrl(rewrite.video, time) + ' "定位到 ' + stamp + '")'
    : match[1] ? '〔无效字幕引用〕' : match[0];
  if (replacement !== match[0]) rewrite.edits.push({ start: state.pos, end: state.pos + match[0].length, replacement, time });
  state.push('text', '', 0).content = match[0];
  state.pos += match[0].length;
  return true;
});

function referenceScopes(tokens, lines) {
  const scopes = [], listItems = [];
  let nextId = 0;
  for (const token of tokens) {
    if (token.type === 'list_item_open') listItems.push(++nextId);
    if (token.type === 'list_item_close') listItems.pop();
    if (!token.map || !['inline', 'tr_open'].includes(token.type)) continue;
    scopes.push({ start: lines[token.map[0]], end: lines[token.map[1]], id: listItems.at(-1) ?? ++nextId });
  }
  return scopes;
}

export function linkVideoReferences(content, transcript, { legacy = false, compact = false } = {}) {
  const source = String(content || '');
  const env = {}, tokens = markdown.parse(source, env), lines = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lines.push(i + 1);
  lines.push(source.length);
  const scopes = compact ? referenceScopes(tokens, lines) : [], cited = new Set();
  const protectedRanges = tokens.filter(token => ['fence', 'code_block'].includes(token.type) && token.map)
    .map(token => [lines[token.map[0]], lines[token.map[1]] ?? source.length]);
  const edits = [], cues = new Map(transcript.cues.map(cue => [cue.id, cue])), times = videoCueTimes(transcript);
  let start = 0;
  for (const [end, next] of [...protectedRanges, [source.length, source.length]]) {
    if (end > start) {
      const rewrite = { source: source.slice(start, end), edits: [], cues, times, legacy, compact, video: transcript.video };
      markdown.parseInline(rewrite.source, { ...env, videoRewrite: rewrite });
      for (const edit of rewrite.edits) edits.push({ ...edit, start: edit.start + start, end: edit.end + start });
    }
    start = next;
  }
  let result = '', cursor = 0;
  for (const edit of edits) {
    // A continued list item keeps one anchor; nested items have their own scope.
    // Invalid IDs and unrelated links never consume the valid citation slot.
    const scope = compact && edit.time !== undefined
      ? scopes.find(item => edit.start >= item.start && edit.start < item.end) : null;
    const replacement = scope && cited.has(scope.id) ? '' : edit.replacement;
    if (scope) cited.add(scope.id);
    result += source.slice(cursor, edit.start) + replacement;
    cursor = edit.end;
  }
  return result + source.slice(cursor);
}

/** Only our original video, P, verified second and link label can request a seek. */
export function videoTimeForLink(transcript, href, label) {
  const stamp = String(label || '').match(/^\[((?:\d{2}:)?\d{2}:\d{2})\]$/)?.[1];
  const time = stamp ? videoCueTimes(transcript).get(stamp) : undefined;
  return time !== undefined && href === videoTimestampUrl(transcript.video, time) ? time : null;
}

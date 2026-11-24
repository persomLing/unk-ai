import MarkdownIt from 'markdown-it';
import { citedVideoCues } from './video-timestamps.js';

const markdown = new MarkdownIt({ html: false });
const originalLabel = /^[ \t>*_-]*(?:(?:代码)?来源[ \t*_]*[:：][ \t*_]*)?((?:视频字幕|字幕|视频)原文)(?=\s|[*_[(（。！：:、]|$)/;
const unverifiedLabel = '补充示例（字幕未核实）';

function normalizeLineWrap(text) {
  // Keep the contents of quoted strings intact while smoothing line wrapping
  // and indentation in the surrounding code and subtitle text.
  return text.replace(/\r\n?/g, '\n').trim().replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[ \t]*(?:\n[ \t]*)+/g,
    part => part.includes('\n') && !/^["'`]/.test(part) ? ' ' : part,
  );
}

function matchesOriginal(code, transcript, cue) {
  const index = Number(cue.id.slice(1)) - 1;
  const following = [cue.text];
  let previous = cue;
  for (const next of transcript.cues.slice(index + 1, index + 3)) {
    if (next.startMs - previous.endMs > 2000) break;
    following.push(next.text);
    previous = next;
  }
  const source = normalizeLineWrap(following.join('\n'));
  const firstCueLength = normalizeLineWrap(cue.text).length;
  let found = source.indexOf(code);
  const word = character => /[a-z\d_$]/i.test(character || '');
  while (found !== -1 && found < firstCueLength) {
    if (!(word(code[0]) && word(source[found - 1]))
      && !(word(code.at(-1)) && word(source[found + code.length]))) return true;
    found = source.indexOf(code, found + 1);
  }
  return false;
}

function verifiedFence(fence, label, lines, transcript) {
  if (!fence || transcript.track.kind === 'visual' || fence.content.length > 12000) return null;
  const lastLine = lines[fence.map[1] - 1]?.trim().replace(/^(?:>\s*)+/, '');
  if (!lastLine?.startsWith(fence.markup) || lastLine.split(fence.markup[0]).join('').trim()) return null;
  const code = normalizeLineWrap(fence.content);
  if (!code) return null;
  const direct = [...label.matchAll(/\[\[(c\d+)\]\]/g)].map(match => {
    const cue = transcript.cues[Number(match[1].slice(1)) - 1];
    return cue?.id === match[1] && cue.startMs < transcript.video.duration * 1000 ? cue : null;
  }).filter(Boolean);
  // Saved notes carry canonical video time links in place of raw cue IDs.
  if (direct.length) return direct.find(cue => matchesOriginal(code, transcript, cue));
  if (!label.includes('&t=')) return null;
  const seconds = new Set(citedVideoCues(label, transcript.cues, transcript.video).map(item => Math.floor(item.cue.startMs / 1000)));
  return transcript.cues.find(cue => seconds.has(Math.floor(cue.startMs / 1000)) && matchesOriginal(code, transcript, cue));
}

export function verifyVideoCodeSources(content, transcript) {
  if (!/原文/.test(content)) return content;
  const lines = content.split('\n');
  const tokens = markdown.parse(content, {});
  const fences = new Map(tokens.filter(token => token.type === 'fence').map(token => [token.map[0], token]));
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.map) continue;
    for (let index = token.map[0]; index < token.map[1]; index++) {
      const label = lines[index];
      const match = originalLabel.exec(label);
      if (!match) continue;
      let next = index + 1;
      while (next < lines.length && /^(?:[ \t>]|\r)*$/.test(lines[next])) next++;
      const fence = fences.get(next);
      if (!fence && !label.includes('代码来源')) continue;
      const cue = verifiedFence(fence, label, lines, transcript);
      if (!cue) lines[index] = label.replace(match[1], unverifiedLabel).replace(/\s*\[\[c\d+\]\]/g, '');
      else if (/\[\[c\d+\]\]/.test(label)) {
        // The note keeps one time link on this line. It must be the cue that
        // actually matched the block when the model supplied several IDs.
        lines[index] = label.replace(/\[\[c\d+\]\]/, `[[${cue.id}]]`);
      }
    }
  }
  return lines.join('\n');
}

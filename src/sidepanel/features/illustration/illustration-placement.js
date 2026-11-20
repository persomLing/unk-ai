const VERSION = 1;
const MAX_ANCHOR = 160;
const MAX_TEXT = 500_000;
const MAX_BLOCKS = 1024;
const NEARBY_CITATION_SECONDS = 45;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function quotation(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= MAX_ANCHOR && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text) ? text : '';
}

function plainText(value) {
  return String(value || '').slice(0, MAX_TEXT).normalize('NFKC')
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/[*_`~]/g, '')
    .replace(/\s+/gu, ' ').trim();
}

/** Persist only bounded, compatible location hints, never model selectors. */
export function copyIllustrationPlacement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION) return null;
  const anchor = quotation(value.anchor);
  return { version: VERSION, ...(anchor ? { anchor } : {}),
    ...(finite(value.time) && value.time >= 0 && value.time <= Number.MAX_SAFE_INTEGER ? { time: value.time } : {}),
    ...(finite(value.ratio) && value.ratio >= 0 && value.ratio <= 1 ? { ratio: value.ratio } : {}) };
}

function distributedRatio(index, total) {
  const count = Math.max(1, Math.min(1000, Math.floor(Number(total) || 1)));
  const position = Math.min(count - 1, Math.max(0, Math.floor(Number(index) || 0)));
  return (position + 1) / (count + 1);
}

function uniqueIndex(text, anchor) {
  const index = anchor ? text.indexOf(anchor) : -1;
  return index >= 0 && text.indexOf(anchor, index + 1) === -1 ? index : -1;
}

export function createIllustrationPlacement(content, options = {}) {
  const candidate = copyIllustrationPlacement({ ...options, version: VERSION });
  const body = plainText(content), quote = plainText(candidate.anchor);
  const offset = uniqueIndex(body, quote);
  const ratio = candidate.ratio ?? (candidate.time !== undefined && finite(options.duration) && options.duration > 0
    ? Math.min(1, candidate.time / options.duration) : distributedRatio(options.index, options.total));
  return { version: VERSION, ...(offset >= 0 ? { anchor: candidate.anchor } : {}),
    ...(candidate.time !== undefined ? { time: candidate.time } : {}), ratio };
}

function captionTokens(value) {
  const text = plainText(value).toLowerCase().slice(0, 500);
  const commonWords = new Set(['image', 'diagram', 'illustration', 'video', 'frame', 'generated', 'with', 'from', 'the', 'for', 'and', 'of', 'to', 'in', 'on', 'is', 'an', 'as']);
  const tokens = new Set((text.match(/[a-z][a-z0-9_-]{1,39}/g) || []).filter(token => !commonWords.has(token)));
  const generic = new Set(['配图', '图片', '生成', '视频', '画面', '示意', '动画', '演示', '概念', '要点', '内容', '说明', '一张', '一个']);
  for (const phrase of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let size = 4; size >= 2; size--) {
      for (let start = 0; start + size <= phrase.length && tokens.size < 96; start++) {
        const token = phrase.slice(start, start + size);
        if (!generic.has(token)) tokens.add(token);
      }
    }
  }
  return [...tokens].slice(0, 96);
}

function timestampSeconds(text) {
  return [...text.matchAll(/(?<!\d)(?:\d+:)?\d+:[0-5]\d(?!\d)/g)].map(match =>
    match[0].split(':').reduce((total, part) => total * 60 + Number(part), 0));
}

/** Unique quotation → video timestamp → legacy caption → stable distribution. */
export function findIllustrationBlock(blocks, item = {}, index = 0, total = 1) {
  if (!Array.isArray(blocks) || !blocks.length) return -1;
  let remaining = MAX_TEXT;
  const all = blocks.slice(0, MAX_BLOCKS).map((block, position) => {
    const text = plainText(String(block?.text || '').slice(0, Math.max(0, remaining)));
    remaining -= text.length;
    return { index: position, text, kind: block?.kind };
  }).filter(block => block.text);
  if (!all.length) return -1;
  const paragraphs = all.filter(block => block.kind !== 'heading');
  const candidates = paragraphs.length ? paragraphs : all;
  const placement = copyIllustrationPlacement(item.placement) || {};
  const anchor = plainText(placement.anchor);
  if (anchor) {
    const matches = all.filter(block => uniqueIndex(block.text, anchor) >= 0);
    const occurrences = all.reduce((count, block) => count + (block.text.includes(anchor) ? 1 : 0), 0);
    if (matches.length === 1 && occurrences === 1) return matches[0].index;
  }
  const time = placement.time ?? item.videoFrame?.time ?? item.frameTime;
  let nearby;
  if (finite(time) && time >= 0) {
    const timed = candidates.flatMap(block => timestampSeconds(block.text).map(at => ({ index: block.index, at })));
    const exact = timed.find(block => block.at === time);
    if (exact) return exact.index;
    nearby = timed.sort((left, right) => Math.abs(left.at - time) - Math.abs(right.at - time))[0];
  }
  const tokens = captionTokens(item.name);
  const scores = candidates.map(block => ({ index: block.index, text: block.text.toLowerCase(), terms: 0, score: 0 }));
  for (const token of tokens) {
    const matches = scores.filter(block => block.text.includes(token));
    if (!matches.length) continue;
    const technical = /^[a-z]/.test(token);
    const weight = (technical ? 5 : token.length / 2) / matches.length;
    for (const match of matches) { match.score += weight; if (technical) match.terms += weight; }
  }
  const ranked = scores.sort((a, b) => b.terms - a.terms || b.score - a.score);
  if (ranked[0]?.score > 0 && (!ranked[1] || ranked[0].terms > ranked[1].terms || ranked[0].score > ranked[1].score)) return ranked[0].index;
  if (nearby && Math.abs(nearby.at - time) <= NEARBY_CITATION_SECONDS) return nearby.index;
  const ratio = placement.ratio ?? distributedRatio(index, total);
  return candidates[Math.round((candidates.length - 1) * ratio)].index;
}

export function collectIllustrationBlocks(container) {
  const blocks = [];
  for (const node of container.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre, table')) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (node.closest('.message-illustrations, .export-illustrations, .generated-image, .export-illustration')) continue;
    if (node.matches('li') && [...node.children].some(child => child.matches('p, pre, table, h1, h2, h3, h4, h5, h6'))) continue;
    const text = node.matches('li') ? [...node.childNodes].filter(child => !['UL', 'OL'].includes(child.nodeName))
      .map(child => child.textContent || '').join(' ') : node.textContent;
    if (!text?.trim()) continue;
    blocks.push({ node, text, kind: /^H[1-6]$/.test(node.nodeName) ? 'heading' : 'paragraph' });
  }
  return blocks;
}

/** Nodes are supplied by the trusted attachment renderer, never queried from Markdown. */
export function placeIllustrationNodes(container, entries, { className = 'message-illustrations' } = {}) {
  const blocks = collectIllustrationBlocks(container), groups = new Map();
  for (const [position, entry] of entries.entries()) {
    const target = findIllustrationBlock(blocks, entry.item, entry.index ?? position, entry.total ?? entries.length);
    if (!groups.has(target)) {
      const group = container.ownerDocument.createElement('div');
      group.className = className;
      groups.set(target, group);
    }
    groups.get(target).append(entry.node);
  }
  for (const [index, group] of groups) {
    const node = blocks[index]?.node;
    if (!node) container.append(group);
    else if (node.matches('li')) {
      node.insertBefore(group, [...node.children].find(child => child.matches('ul, ol')) || null);
    } else (node.closest('.md-table-scroll, .message-code-block') || node).after(group);
  }
  return [...groups.values()];
}

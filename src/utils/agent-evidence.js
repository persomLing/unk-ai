const MAX_EVIDENCE = 20000;

function clean(value, max = 8000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/**
 * Combine the extractor's page text with the most recent visible conversation
 * turns. This is important for chat UIs where the answer lives inside a
 * message component that the generic article extractor may not select.
 */
export function combinePageEvidence(page = {}, recentMessages = []) {
  const rawBase = clean(page?.text, Number.MAX_SAFE_INTEGER);
  const recent = [...new Set((Array.isArray(recentMessages) ? recentMessages : [])
    .map((value) => clean(value, 12000))
    .filter(Boolean))].slice(0, 2);
  const recentText = recent.join('\n\n--- 最近消息 ---\n\n');
  const includedRecent = recentText.slice(0, 12000);
  const tail = includedRecent ? `\n\n<latest_conversation>\n${includedRecent}\n</latest_conversation>` : '';
  const base = rawBase.slice(0, MAX_EVIDENCE - tail.length);
  const text = `${base}${tail}`.trim();
  return {
    ...page,
    text: text.slice(0, MAX_EVIDENCE),
    truncated: page?.truncated === true
      || rawBase.length > base.length
      || recentText.length > includedRecent.length,
  };
}

/** Keep recent page bodies separate from short action logs and cap their total cost. */
export function boundedPageReadings(values = []) {
  const output = [];
  const seen = new Set();
  let remaining = 18000;
  for (const value of [...values].reverse()) {
    let url;
    try { url = new URL(value?.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const query = clean(value?.query, 200);
    const key = `${url.href}\n${query}`;
    if (seen.has(key)) continue;
    const raw = clean(value?.text, Number.MAX_SAFE_INTEGER);
    if (!raw || remaining <= 0) continue;
    const text = raw.slice(0, Math.min(10000, remaining));
    output.unshift({
      url: url.href, title: clean(value?.title, 300), query, text,
      capturedAt: clean(value?.capturedAt, 80),
      truncated: value?.truncated === true || text.length < raw.length,
    });
    seen.add(key);
    remaining -= text.length;
    if (output.length === 3) break;
  }
  return output;
}

export function agentResultWithSources(summary, readings = []) {
  let result = String(summary || '').trim();
  const used = new Set();
  const sources = [];
  for (const reading of boundedPageReadings(readings)) {
    if (used.has(reading.url) || result.includes(reading.url)) continue;
    used.add(reading.url);
    const title = clean(reading.title || reading.url, 100).replace(/[\\[\]]/g, '\\$&');
    const url = reading.url.replace(/</g, '%3C').replace(/>/g, '%3E');
    const link = `- [${title}](<${url}>)`;
    if (result.length + sources.join('\n').length + link.length + 10 <= 6000) sources.push(link);
  }
  return sources.length ? `${result}\n\n读取来源：\n${sources.join('\n')}` : result;
}

export function agentReadingSources(readings = []) {
  const sources = new Map();
  for (const reading of boundedPageReadings(readings)) {
    sources.set(reading.url, { url: reading.url, title: reading.title, capturedAt: reading.capturedAt, truncated: reading.truncated });
  }
  return [...sources.values()];
}

function chapterNumber(value) {
  const match = String(value || '').match(/第\s*([\d一二三四五六七八九十百零〇两]+)\s*章|\bchapter\s+(\d+)\b/i);
  if (!match) return null;
  const raw = match[1] || match[2];
  if (/^\d+$/.test(raw)) return Number(raw);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let number = 0, digit = 0;
  for (const char of raw) {
    if (char === '十' || char === '百') { number += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
    else digit = digits[char] || 0;
  }
  return number + digit;
}

function readingDocumentUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (/^#!?\//.test(url.hash)) {
      const [route, query = ''] = url.hash.replace(/^#!/, '#').split('?');
      const params = new URLSearchParams(query);
      params.delete('id');
      url.hash = route + (params.size ? '?' + params : '');
    } else url.hash = '';
    return url.href;
  } catch { return ''; }
}

function headingChapterNumber(value) {
  const heading = String(value || '').replace(/^\s*#+\s*/, '');
  const match = heading.match(/(?:^|[|·—:：\-（(])\s*(第\s*[\d一二三四五六七八九十百零〇两]+\s*章|chapter\s+\d+)/i);
  return match ? chapterNumber(match[1]) : null;
}

/** A narrow evidence gate for explicit chapter-reading goals, not a general answer judge. */
export function assessChapterCompletion(goal, elements = [], pageReadings = []) {
  const question = String(goal || '');
  if (!/总结|概括|摘要|阅读|读一下|解释|介绍|summari[sz]e|\bread\b/i.test(question)) return { ok: true };
  const number = chapterNumber(question);
  const locating = /找|定位|查找|find|locate/i.test(question) && /章节|章|chapter/i.test(question);
  if (number === null && !locating) return { ok: true };
  const terms = (question.match(/[a-z][a-z0-9+.-]{1,30}/gi) || [])
    .filter(term => !/^(?:find|locate|chapter|read|summari[sz]e|the|and)$/i.test(term));
  const candidates = (Array.isArray(elements) ? elements : []).filter(element => {
    if (!readingDocumentUrl(element.href) || element.navigation?.kind === 'section') return false;
    const title = String(element.name || element.text || '');
    if (number !== null) return chapterNumber(title) === number;
    return terms.length > 0 && /第.+章|chapter/i.test(title)
      && terms.every(term => (title.toLowerCase().match(/[a-z][a-z0-9+.-]*/g) || []).includes(term.toLowerCase()));
  });
  const distinct = [...new Map(candidates.map(element => [readingDocumentUrl(element.href), element])).values()];
  const readings = boundedPageReadings(pageReadings);
  if (distinct.length === 1) {
    const candidate = distinct[0];
    const target = { title: String(candidate.name || candidate.text || ''), url: candidate.href };
    const targetNumber = chapterNumber(target.title);
    const targetHeading = target.title.replace(/第\s*[\d一二三四五六七八九十百零〇两]+\s*章|chapter\s+\d+/i, '').replace(/[\s:：.、-]+/g, '').toLowerCase();
    const matchesHeading = reading => {
      const firstLine = String(reading.text || '').split('\n').find(line => line.trim()) || '';
      const titles = [String(reading.title || ''), firstLine.replace(/^#+\s*/, '')];
      return targetNumber === null || titles.some(title => headingChapterNumber(title) === targetNumber
        || (targetHeading.length >= 4 && title.replace(/[\s:：.、-]+/g, '').toLowerCase().includes(targetHeading)));
    };
    if (readings.some(reading => readingDocumentUrl(reading.url) === readingDocumentUrl(target.url) && matchesHeading(reading))) return { ok: true, target };
    return { ok: false, target, reason: `目标章节是「${target.title}」（${target.url}），尚未读取该文档正文。当前页同名概述不能替代它，请定位并 read_page 后再总结。` };
  }
  if (number !== null && !readings.some(reading => headingChapterNumber(reading.title) === number
    || headingChapterNumber(String(reading.text || '').split('\n').find(line => line.trim()) || '') === number)) {
    return { ok: false, reason: `尚未读到标题明确为第 ${number} 章的正文，不能把当前页概述当作该章完成总结。请查找章节链接或滚动对应目录，读取后再回答。` };
  }
  return { ok: true };
}

/** This compares visible observations, never claims that a business operation succeeded. */
export function observationFeedback(before, after, { action, args = {}, effect } = {}) {
  if (!before || !after || typeof before.summary !== 'string' || typeof after.summary !== 'string'
    || !Array.isArray(before.elements) || !Array.isArray(after.elements)) {
    return { changed: null, message: '缺少可比较的页面观察，尚未确认动作结果。' };
  }
  const target = before.elements.find(element => element.id === args.elementId
    || (effect?.targetKey && element.stableKey === effect.targetKey));
  const nextTarget = target && after.elements.find(element => target.stableKey
    ? element.stableKey === target.stableKey : element.id === target.id);
  if (action === 'scroll_page') {
    const from = args.elementId ? target?.scroll : before.scroll || { top: before.scrollY, left: 0 };
    const to = args.elementId ? nextTarget?.scroll : after.scroll || { top: after.scrollY, left: 0 };
    if (!from || !to) return { changed: null, message: '缺少目标滚动容器的新观察，尚未确认位移；请重新观察后选择容器。' };
    const changed = from.top !== to.top || from.left !== to.left;
    const name = target?.name || '页面';
    const boundary = !changed && (effect?.status === 'at_boundary'
      || (Array.isArray(to.directions) && !to.directions.includes(args.direction)));
    return { changed, message: changed
      ? `目标「${name}」滚动位置有变化（${from.left}, ${from.top} → ${to.left}, ${to.top}）；仍需核对目标章节和正文。`
      : boundary ? `目标「${name}」已到滚动边界，没有移动；请换方向、目标容器或根据章节链接读取。`
        : `目标「${name}」未观察到滚动位移；页面其他变化不能确认这次滚动有效。请核对容器，避免重复同一动作。` };
  }
  const semantic = element => ({ key: element.stableKey || element.href || element.name,
    name: element.name, href: element.href, role: element.role, disabled: element.disabled, state: element.state });
  const signature = page => {
    // With explicit content/region data, unrelated toolbar clocks and page
    // ornaments cannot make an ineffective chapter click look successful.
    if (action && (before.content || after.content)) {
      const region = target?.layout?.region;
      return JSON.stringify({ url: page.url, title: page.title, content: page.content,
        target: page.elements.filter(element => target?.stableKey && element.stableKey === target.stableKey).map(semantic),
        navigation: page.elements.filter(element => element.layout?.region === 'navigation'
          && (!region || region === 'navigation')).map(semantic) });
    }
    return JSON.stringify({ url: page.url, summary: page.summary, scrollY: page.scrollY, pageHeight: page.pageHeight,
      scroll: page.scroll, content: page.content,
      elements: page.elements.map(({ id, layout, ...element }) => element) });
  };
  const changed = signature(before) !== signature(after);
  return {
    changed,
    message: changed
      ? '动作后已取得新的页面观察，观察内容有变化；业务结果仍需依据页面证据确认。'
      : '动作后观察与之前一致，尚未确认可见变化。请读取正文或换一种方法，避免重复提交同一动作。',
  };
}

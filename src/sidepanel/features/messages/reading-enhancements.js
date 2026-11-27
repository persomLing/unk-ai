import { icon } from '../../icons.js';

const MAX_STEPS = 5;
const MAX_OPTIONS = 5;
const ALERT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+|$)/i;

const ALERT_META = Object.freeze({
  note: { tone: 'note', label: '核心要点', icon: 'info' },
  tip: { tone: 'tip', label: '通俗类比 · 技巧', icon: 'sparkles' },
  important: { tone: 'important', label: '核心结论', icon: 'compass' },
  warning: { tone: 'warning', label: '避坑提醒', icon: 'shield' },
  caution: { tone: 'caution', label: '风险边界', icon: 'flame' },
});

const PREFIX_PATTERNS = [
  { re: /^(?:核心结论|一句话结论|一句话总结|核心要点|关键结论)\s*[：:]/, meta: ALERT_META.important },
  { re: /^(?:通俗类比|生活类比|形象类比|举个类比|实用技巧|小技巧)\s*[：:]/, meta: ALERT_META.tip },
  { re: /^(?:避坑提醒|常见误区|容易踩坑|注意事项|关键边界|局限性)\s*[：:]/, meta: ALERT_META.warning },
];

export const READING_ALERT_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(ALERT_META).map(([k, v]) => [k, v.label])),
);

function clampString(value, maxLen = 120) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function tryParseJson(rawText) {
  const cleaned = String(rawText || '').trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** Parse global `steps` fenced JSON into normalized 2..5 horizontal stages. */
export function parseStepsSpec(rawText) {
  const parsed = typeof rawText === 'string' ? tryParseJson(rawText) : rawText;
  if (!parsed || typeof parsed !== 'object') return null;
  const rawSteps = Array.isArray(parsed) ? parsed : Array.isArray(parsed.steps) ? parsed.steps : null;
  if (!rawSteps || rawSteps.length < 2) return null;

  const validTones = new Set(['neutral', 'accent', 'warm', 'risk']);
  const steps = [];
  for (const entry of rawSteps.slice(0, MAX_STEPS)) {
    if (!entry || typeof entry !== 'object') continue;
    const title = clampString(entry.title ?? entry.label ?? entry.name, 28);
    if (!title) continue;
    const rawTone = String(entry.tone || '').trim().toLowerCase();
    steps.push({
      badge: clampString(entry.badge ?? entry.step ?? String(steps.length + 1).padStart(2, '0'), 8),
      title,
      summary: clampString(entry.summary ?? entry.desc ?? entry.subtitle, 52),
      meta: clampString(entry.meta ?? entry.tools ?? entry.note, 56),
      tone: validTones.has(rawTone) ? rawTone : 'neutral',
    });
  }
  if (steps.length < 2) return null;
  return {
    title: Array.isArray(parsed) ? '' : clampString(parsed.title, 64),
    subtitle: Array.isArray(parsed) ? '' : clampString(parsed.subtitle, 88),
    steps,
  };
}

/** Parse interactive `quiz` fenced JSON (`question` + `answer`, optional `options`/`hint`/`explanation`). */
export function parseQuizSpec(rawText) {
  const parsed = typeof rawText === 'string' ? tryParseJson(rawText) : rawText;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const question = clampString(parsed.question ?? parsed.prompt, 240);
  const answer = clampString(parsed.answer, 140);
  if (!question || !answer) return null;
  const options = Array.isArray(parsed.options)
    ? parsed.options.map(item => clampString(item, 96)).filter(Boolean).slice(0, MAX_OPTIONS)
    : [];
  return {
    title: clampString(parsed.title, 56) || '思考小测',
    question,
    hint: clampString(parsed.hint, 120),
    options,
    answer,
    explanation: clampString(parsed.explanation ?? parsed.explain ?? parsed.analysis, 360),
  };
}

/** Parse collapsible `example` fenced JSON (`body` required). */
export function parseExampleSpec(rawText) {
  const parsed = typeof rawText === 'string' ? tryParseJson(rawText) : rawText;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = clampString(parsed.body ?? parsed.content ?? parsed.story, 900);
  if (!body) return null;
  return {
    title: clampString(parsed.title, 56) || '举个例子',
    summary: clampString(parsed.summary ?? parsed.subtitle, 88) || '点击展开生活化实例，帮助建立直觉',
    body,
    takeaway: clampString(parsed.takeaway ?? parsed.key ?? parsed.conclusion, 180),
  };
}

/** Classify GitHub alert syntax (`[!TIP]`) or Chinese editorial prefixes in a blockquote. */
export function classifyCallout(firstParagraphText) {
  const text = String(firstParagraphText || '').trim();
  if (!text) return null;
  const alertMatch = text.match(ALERT_RE);
  if (alertMatch) {
    const key = alertMatch[1].toLowerCase();
    const meta = ALERT_META[key];
    return meta ? { kind: 'alert', token: alertMatch[0], ...meta } : null;
  }
  for (const rule of PREFIX_PATTERNS) {
    if (rule.re.test(text)) return { kind: 'prefix', ...rule.meta };
  }
  return null;
}

export function optionMatchesAnswer(option, index, answer) {
  const optNorm = String(option || '').trim().toLowerCase();
  const ansNorm = String(answer || '').trim().toLowerCase();
  if (!optNorm || !ansNorm) return false;
  if (optNorm === ansNorm) return true;
  const letter = String.fromCharCode(97 + index);
  if (ansNorm === letter || new RegExp(`^${letter}[.、)）]?$`).test(ansNorm)) return true;
  const optLetter = optNorm.match(/^([a-z])(?:[.、)）]|\s)/)?.[1];
  const ansLetter = ansNorm.match(/^([a-z])(?:[.、)）]|\s|$)/)?.[1];
  if (optLetter && ansLetter && optLetter === ansLetter) return true;
  const stripLabel = s => s.replace(/^[a-z0-9]+[.、)）\s]+/, '').trim();
  const strippedOpt = stripLabel(optNorm);
  return Boolean(strippedOpt) && strippedOpt === stripLabel(ansNorm);
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function buildSkeleton(doc, label) {
  const box = el(doc, 'div', 'reading-block-skeleton');
  box.dataset.readingDecoration = 'true';
  box.append(el(doc, 'span', 'reading-block-skeleton-dot'), el(doc, 'span', '', label));
  return box;
}

function buildStepsElement(doc, spec) {
  const figure = el(doc, 'figure', 'reading-steps-card');
  figure.dataset.readingDecoration = 'true';
  figure.setAttribute('aria-label', spec.title || '步骤拆解');

  if (spec.title || spec.subtitle) {
    const header = el(doc, 'div', 'reading-card-header');
    const titles = el(doc, 'div', 'reading-card-titles');
    if (spec.title) titles.append(el(doc, 'div', 'reading-card-title', spec.title));
    if (spec.subtitle) titles.append(el(doc, 'div', 'reading-card-subtitle', spec.subtitle));
    header.append(titles);
    figure.append(header);
  }

  const track = el(doc, 'div', 'reading-steps-track');
  spec.steps.forEach((step, idx) => {
    const col = el(doc, 'div', 'reading-step-col');
    const box = el(doc, 'div', `reading-step-box tone-${step.tone}`);
    box.append(
      el(doc, 'span', 'reading-step-badge', step.badge),
      el(doc, 'strong', 'reading-step-title', step.title),
    );
    if (step.summary) box.append(el(doc, 'p', 'reading-step-summary', step.summary));
    col.append(box);
    if (step.meta) col.append(el(doc, 'div', 'reading-step-meta', step.meta));
    track.append(col);

    if (idx < spec.steps.length - 1) {
      const arrow = el(doc, 'span', 'reading-step-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.innerHTML = icon('arrow-right');
      track.append(arrow);
    }
  });
  figure.append(track);
  return figure;
}

function buildQuizElement(doc, spec, { exportMode = false } = {}) {
  const card = el(doc, 'section', 'reading-interactive-card reading-quiz-card');
  card.dataset.readingDecoration = 'true';
  card.setAttribute('aria-label', spec.title);

  const head = el(doc, 'div', 'reading-card-header');
  const headLeft = el(doc, 'div', 'reading-card-label');
  headLeft.innerHTML = `${icon('sparkles')}<span>${spec.title}</span>`;
  head.append(headLeft);
  card.append(head);

  const body = el(doc, 'div', 'reading-quiz-body');
  body.append(el(doc, 'p', 'reading-quiz-question', spec.question));
  if (spec.hint) body.append(el(doc, 'p', 'reading-quiz-hint', `提示：${spec.hint}`));

  if (spec.options.length >= 2) {
    const list = el(doc, 'div', 'reading-quiz-options');
    spec.options.forEach((optionText, idx) => {
      const btn = el(doc, 'button', 'reading-quiz-option', optionText);
      btn.type = 'button';
      btn.dataset.quizOption = String(idx);
      btn.dataset.quizCorrect = optionMatchesAnswer(optionText, idx, spec.answer) ? 'true' : 'false';
      list.append(btn);
    });
    body.append(list);
    const feedback = el(doc, 'p', 'reading-quiz-feedback', '');
    feedback.hidden = true;
    body.append(feedback);
  }

  const reveal = el(doc, 'details', 'reading-reveal');
  if (exportMode) reveal.setAttribute('open', '');
  const summary = el(doc, 'summary', 'reading-reveal-summary', '查看参考答案与解析');
  const revealBody = el(doc, 'div', 'reading-reveal-body');
  revealBody.append(el(doc, 'p', 'reading-reveal-answer', `参考答案：${spec.answer}`));
  if (spec.explanation) revealBody.append(el(doc, 'p', 'reading-reveal-explanation', spec.explanation));
  reveal.append(summary, revealBody);
  body.append(reveal);
  card.append(body);
  return card;
}

function buildExampleElement(doc, spec, { exportMode = false } = {}) {
  const details = el(doc, 'details', 'reading-example-card');
  details.dataset.readingDecoration = 'true';
  if (exportMode) details.setAttribute('open', '');

  const summary = el(doc, 'summary', 'reading-example-summary');
  const head = el(doc, 'span', 'reading-example-head');
  head.innerHTML = `${icon('compass')}<strong>${spec.title}</strong>`;
  const sub = el(doc, 'span', 'reading-example-sub', spec.summary);
  const chevron = el(doc, 'span', 'reading-example-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = icon('chevron-down');
  summary.append(head, sub, chevron);

  const body = el(doc, 'div', 'reading-example-body');
  for (const para of spec.body.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)) {
    body.append(el(doc, 'p', '', para));
  }
  if (spec.takeaway) {
    body.append(el(doc, 'div', 'reading-example-takeaway', `直观收获：${spec.takeaway}`));
  }

  details.append(summary, body);
  return details;
}

function stripLeadingAlertToken(firstParagraph) {
  const firstChild = firstParagraph?.firstChild;
  if (!firstChild || firstChild.nodeType !== 3) return;
  const cleaned = String(firstChild.nodeValue || '').replace(/^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n?/i, '');
  if (cleaned) {
    firstChild.nodeValue = cleaned;
    return;
  }
  firstChild.remove();
  while (firstParagraph.firstChild?.tagName === 'BR') firstParagraph.firstChild.remove();
  if (!firstParagraph.childNodes.length && !(firstParagraph.textContent || '').trim()) {
    firstParagraph.remove();
  }
}

/**
 * Decorate global reading enhancements (`steps`, `quiz`, `example` fenced blocks
 * and semantic callouts) after Markdown/DOMPurify sanitization.
 */
export function enhanceReadingBlocks(root, { streaming = false, exportMode = false } = {}) {
  if (!root?.querySelectorAll) return;
  const doc = root.ownerDocument || globalThis.document;

  for (const code of [...root.querySelectorAll('pre > code')]) {
    const cls = code.className || '';
    const langMatch = cls.match(/\blanguage-(steps|quiz|example)\b/i);
    if (!langMatch) continue;
    const kind = langMatch[1].toLowerCase();
    const pre = code.parentElement;
    if (!pre || pre.parentNode === null) continue;
    const raw = code.textContent || '';

    let spec = null;
    let built = null;
    if (kind === 'steps') {
      spec = parseStepsSpec(raw);
      if (spec) built = buildStepsElement(doc, spec);
      else if (streaming) built = buildSkeleton(doc, '正在整理步骤卡片…');
    } else if (kind === 'quiz') {
      spec = parseQuizSpec(raw);
      if (spec) built = buildQuizElement(doc, spec, { exportMode });
      else if (streaming) built = buildSkeleton(doc, '正在生成思考小测…');
    } else if (kind === 'example') {
      spec = parseExampleSpec(raw);
      if (spec) built = buildExampleElement(doc, spec, { exportMode });
      else if (streaming) built = buildSkeleton(doc, '正在整理实例卡片…');
    }
    if (built) pre.replaceWith(built);
  }

  for (const quote of root.querySelectorAll('blockquote')) {
    if (quote.classList?.contains('fund-callout') || quote.classList?.contains('reading-callout')) continue;
    const firstP = quote.querySelector('p');
    if (!firstP) continue;
    const matched = classifyCallout(firstP.textContent || '');
    if (!matched) continue;

    quote.classList.add('reading-callout', `tone-${matched.tone}`);
    if (matched.kind === 'alert') stripLeadingAlertToken(firstP);

    const head = el(doc, 'div', 'reading-callout-head');
    head.dataset.readingDecoration = 'true';
    head.innerHTML = `${icon(matched.icon)}<span>${matched.label}</span>`;
    quote.insertBefore(head, quote.firstChild);
  }

  if (exportMode) {
    for (const details of root.querySelectorAll('details.md-details')) {
      details.setAttribute('open', '');
    }
  }
}

const boundReadingContainers = new WeakSet();

/** Bind interactive option selection on `.reading-quiz-card` widgets (idempotent). */
export function bindReadingInteractions(container) {
  if (!container?.addEventListener || boundReadingContainers.has(container)) return;
  boundReadingContainers.add(container);

  container.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-quiz-option]');
    if (!button || button.closest('[inert]')) return;
    const card = button.closest('.reading-quiz-card');
    if (!card) return;

    const options = [...card.querySelectorAll('[data-quiz-option]')];
    for (const opt of options) {
      opt.classList.remove('is-selected', 'is-correct', 'is-wrong');
      if (opt.dataset.quizCorrect === 'true') opt.classList.add('is-correct');
    }
    button.classList.add('is-selected');
    const isCorrect = button.dataset.quizCorrect === 'true';
    if (!isCorrect) button.classList.add('is-wrong');

    const feedback = card.querySelector('.reading-quiz-feedback');
    if (feedback) {
      feedback.hidden = false;
      feedback.classList.toggle('is-correct', isCorrect);
      feedback.classList.toggle('is-wrong', !isCorrect);
      feedback.textContent = isCorrect ? '回答正确，直觉很准！' : '差一点，参考下方解析对比一下：';
    }

    const reveal = card.querySelector('.reading-reveal');
    if (reveal) {
      reveal.open = true;
      reveal.setAttribute('open', '');
    }
  });
}

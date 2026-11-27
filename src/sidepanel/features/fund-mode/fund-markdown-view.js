/**
 * Fund Research Mode Markdown Enhancer
 *
 * Transforms sanitized Markdown DOM inside Fund Mode replies into an
 * institutional Paper & Ink editorial report:
 * - Pure-SVG, theme-aware charts (` ```fund-chart `): line, bar, hbar, donut, gauge
 * - Executive KPI ledger cards (` ```fund-kpi `)
 * - Accurate red-up / green-down coloring for signed returns, drawdowns & bp
 *   across both tables and prose (without breaking text selection/quote offsets)
 * - Valuation temperature & risk level pills, numeric column alignment &
 *   allocation micro-bars in tables, and editorial callout blockquotes
 *
 * Zero raw HTML injection: every generated element uses createElement /
 * createElementNS and textContent with strict schema validation.
 */

import { buildChartCardElement } from '../charts/chart-blocks.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_SERIES_COLORS = Object.freeze([
  'var(--fund-chart-1)',
  'var(--fund-chart-2)',
  'var(--fund-chart-3)',
  'var(--fund-chart-4)',
  'var(--fund-chart-5)',
  'var(--fund-chart-6)',
]);

const MAX_SERIES = 6;
const MAX_POINTS = 60;
const MAX_SCATTER_POINTS = 120;
const MAX_ITEMS = 16;
const MAX_KPI_ITEMS = 8;
const MAX_STEPS = 5;

const SKIP_TEXT_TAGS = new Set(['CODE', 'PRE', 'A', 'SVG', 'SCRIPT', 'STYLE', 'BUTTON', 'KBD']);
const SKIP_TEXT_ANCESTOR_SELECTOR = 'code, pre, a, svg, .katex, .unk-chart-card, .fund-vis-card, .fund-kpi-card, .fund-steps-card, .fund-metric, .fund-badge, .fund-risk-badge';

// Signed percentage or basis-point token:
// Must NOT be preceded by a digit, decimal point, or `%` so ranges like `10%-20%`
// or dates like `2026-11-25` are never falsely highlighted.
const SIGNED_METRIC_RE = /(^|[^\d.%a-zA-Z])([+＋\-−]\d{1,4}(?:\.\d{1,4})?(?:%|％|个百分点|bp|BP))/g;

// Valuation / temperature ratings (ordered longest-first to avoid partial matches).
const VALUATION_TOKENS = Object.freeze([
  { label: '极低估', tone: 'cold' },
  { label: '较低估', tone: 'cool' },
  { label: '低估', tone: 'cold' },
  { label: '极高估', tone: 'hot' },
  { label: '高估', tone: 'hot' },
  { label: '偏高', tone: 'warm' },
  { label: '适中', tone: 'mid' },
  { label: '合理', tone: 'mid' },
]);

const VALUATION_EXACT_RE = new RegExp(`^(${VALUATION_TOKENS.map(t => t.label).join('|')})(?:\\s*[（(][^）)]{1,18}[）)])?$`);

const RISK_LEVEL_MAP = Object.freeze({
  R1: { level: 'r1', label: 'R1' },
  R2: { level: 'r2', label: 'R2' },
  R3: { level: 'r3', label: 'R3' },
  R4: { level: 'r4', label: 'R4' },
  R5: { level: 'r5', label: 'R5' },
});

const RISK_CELL_RE = /^(R[1-5])(?:\s*[（(·\-—]?\s*(?:低风险|中低风险|中风险|中高风险|高风险)[）)]?)?$/i;
const RISK_TEXT_ONLY_MAP = Object.freeze({
  低风险: 'r1',
  中低风险: 'r2',
  中风险: 'r3',
  中高风险: 'r4',
  高风险: 'r5',
});

const ALLOC_HEADER_RE = /占比|权重|比例|仓位|配置|持仓比例|净值比/;
const CODE_HEADER_RE = /代码|基金代码|指数代码|编号/;
const PURE_PCT_RE = /^([+＋\-−]?)(\d{1,3}(?:\.\d{1,4})?)[%％]$/;
const NUMERIC_CELL_RE = /^[↑↓▲▼]?\s*[+＋\-−¥￥$]?\d[\d,]*(?:\.\d+)?(?:[%％亿万元份倍天年个月°℃]|bp|BP)?(?:\s*[（(][^）)]{1,16}[）)])?$/;
const FUND_CODE_RE = /^\d{6}$/;

const CALLOUT_PATTERNS = Object.freeze([
  {
    tone: 'summary',
    label: '核心结论',
    re: /^(?:核心结论|研报结论|一句话结论|总体结论|综合结论|诊断结论|结论摘要|核心观点)[：:\s]/,
  },
  {
    tone: 'risk',
    label: '风险提示',
    re: /^(?:风险提示|风险点|注意事项|排雷提示|避坑提示|重要提示|警示|风险与权衡|特别提醒)[：:\s]/,
  },
  {
    tone: 'strategy',
    label: '策略观察',
    re: /^(?:适配场景|观察要点|配置建议|优化建议|操作提示|持有建议|适用人群)[：:\s]/,
  },
]);

const STRONG_NON_DIRECTIONAL_RE = /费率|申购费|赎回费|管理费|托管费|服务费|销售服务|运作费|占比|权重|仓位|比例|集中度|换手率|波动率|跟踪误差|杠杆|久期|分位|排名|胜率|盈利概率|限额|起购|持有期|温度|修复天数|天数|\bPE\b|\bPB\b|\bROE\b|\bBeta\b|夏普|卡玛|R方|R²/i;
const SNAPSHOT_NON_DIRECTIONAL_RE = /代码|日期|规模|净值|份额|人数/i;
const DIRECTIONAL_ACTION_RE = /收益|回报|涨跌|涨幅|跌幅|超额|alpha|回撤|贡献|择时|选股|配置效应|利差效应|收入效应|国债效应|变动|变化|差值|盈亏/i;

/**
 * Determine whether signed values under the given financial labels represent
 * directional return/drawdown/attribution metrics suitable for red-up / green-down coloring.
 */
export function shouldColorDirectionalMetric({ label = '', colHeader = '', rowLabel = '' } = {}) {
  const contexts = [label, colHeader, rowLabel].map(v => String(v ?? '').trim()).filter(Boolean);
  for (const ctx of contexts) {
    if (STRONG_NON_DIRECTIONAL_RE.test(ctx)) return false;
    if (SNAPSHOT_NON_DIRECTIONAL_RE.test(ctx) && !DIRECTIONAL_ACTION_RE.test(ctx)) return false;
  }
  return true;
}

let svgGradientSeq = 0;

function parseNumericValue(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/,/g, '').replace(/[＋]/g, '+').replace(/[−]/g, '-');
    const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const num = Number(match[1]);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function clampString(value, maxLen = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Classify a signed metric string like "+12.34%", "-8.50%", "+0.00%".
 * Returns 'up' | 'down' | 'flat' | null.
 */
export function classifySignedMetric(raw) {
  const text = String(raw ?? '').trim().replace(/[＋]/g, '+').replace(/[−]/g, '-');
  const match = text.match(/^([+-])(\d+(?:\.\d+)?)(?:[%％]|个百分点|bp|BP)?$/);
  if (!match) return null;
  const num = Number(match[2]);
  if (!Number.isFinite(num)) return null;
  if (num === 0) return 'flat';
  return match[1] === '+' ? 'up' : 'down';
}

/**
 * Classify a blockquote lead sentence into a semantic editorial callout tone.
 */
export function classifyBlockquoteTone(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  for (const rule of CALLOUT_PATTERNS) {
    if (rule.re.test(clean)) return rule.tone;
  }
  return null;
}

/**
 * Format a numeric value with optional unit and explicit +/- sign for signed series.
 */
export function formatMetricValue(value, { unit = '', signed = false, decimals } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const abs = Math.abs(num);
  const digits = decimals !== undefined
    ? decimals
    : unit === '%' || unit === '％'
      ? (abs >= 100 ? 1 : 2)
      : (Number.isInteger(num) ? 0 : abs >= 100 ? 1 : 2);
  const fixed = num.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.00$/, (m) => (unit === '%' ? m : ''));
  const prefix = signed && num > 0 ? '+' : '';
  return `${prefix}${fixed}${unit}`;
}

function gaugeToneForValue(value, explicitTone = '') {
  const tone = String(explicitTone || '').trim().toLowerCase();
  if (['cold', 'cool', 'mid', 'neutral', 'warm', 'hot'].includes(tone)) {
    return tone === 'neutral' ? 'mid' : tone;
  }
  if (value < 15) return 'cold';
  if (value < 30) return 'cool';
  if (value < 60) return 'mid';
  if (value < 80) return 'warm';
  return 'hot';
}

function gaugeLabelForValue(value, explicitLabel = '') {
  const clean = clampString(explicitLabel, 16);
  if (clean) return clean;
  if (value < 15) return '极低估';
  if (value < 30) return '较低估';
  if (value < 60) return '适中';
  if (value < 80) return '偏高';
  return '高估';
}

function tryParseSpecJson(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Validate and normalize a `fund-chart` JSON specification.
 * Supported types: line, bar, hbar, donut, gauge.
 */
export function parseFundChartSpec(rawText) {
  const parsed = typeof rawText === 'string' ? tryParseSpecJson(rawText) : rawText;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const rawType = String(parsed.type || '').trim().toLowerCase();
  const typeAlias = {
    area: 'line',
    nav: 'line',
    column: 'bar',
    horizontalbar: 'hbar',
    'horizontal-bar': 'hbar',
    pie: 'donut',
    ring: 'donut',
    allocation: 'donut',
    temperature: 'gauge',
    meter: 'gauge',
    quadrant: 'scatter',
    bubble: 'scatter',
  };
  const type = ['line', 'bar', 'hbar', 'donut', 'gauge', 'scatter'].includes(rawType)
    ? rawType
    : typeAlias[rawType] || '';
  if (!type) return null;

  const title = clampString(parsed.title, 72);
  const subtitle = clampString(parsed.subtitle || parsed.asOf || parsed.period, 96);
  const source = clampString(parsed.source, 48);
  const unit = clampString(parsed.unit ?? '', 12);

  if (type === 'donut' || type === 'hbar' || type === 'gauge') {
    let rawItems = Array.isArray(parsed.items) ? parsed.items : null;
    if (!rawItems && Array.isArray(parsed.labels) && Array.isArray(parsed.series) && parsed.series[0]?.values) {
      rawItems = parsed.labels.map((label, idx) => ({
        label,
        value: parsed.series[0].values[idx],
      }));
    }
    if (!rawItems && Array.isArray(parsed.data)) rawItems = parsed.data;
    if (!Array.isArray(rawItems) || !rawItems.length) return null;

    const items = [];
    for (const entry of rawItems.slice(0, MAX_ITEMS)) {
      if (!entry || typeof entry !== 'object') continue;
      const label = clampString(entry.label ?? entry.name ?? entry.title, 36);
      const value = parseNumericValue(entry.value ?? entry.pct ?? entry.weight ?? entry.score);
      if (!label || value === null) continue;
      if (type === 'donut' && value <= 0) continue;
      const clampedValue = type === 'gauge' ? Math.max(0, Math.min(100, value)) : value;
      items.push({
        label,
        value: clampedValue,
        note: clampString(entry.note ?? entry.sub ?? entry.level ?? entry.rating, 28),
        tone: type === 'gauge' ? gaugeToneForValue(clampedValue, entry.tone) : clampString(entry.tone, 12),
      });
    }
    if (!items.length) return null;

    const inferredUnit = unit || (type === 'gauge' ? '°' : '%');
    const hasNegative = items.some(item => item.value < 0);
    const hasPositive = items.some(item => item.value > 0);
    const colorBySign = parsed.colorBySign === true || (type === 'hbar' && hasNegative);
    const centerLabel = clampString(parsed.centerLabel || parsed.totalLabel, 24);
    const centerValue = clampString(parsed.centerValue, 24);

    return {
      type,
      title,
      subtitle,
      source,
      unit: inferredUnit,
      colorBySign,
      hasNegative,
      hasPositive,
      centerLabel,
      centerValue,
      items,
    };
  }

  if (type === 'scatter') {
    const xLabel = clampString(parsed.xLabel || parsed.xTitle || 'X 轴', 32);
    const yLabel = clampString(parsed.yLabel || parsed.yTitle || 'Y 轴', 32);
    const inferAxisUnit = (label, explicit) => clampString(
      explicit ?? (/%|％|收益|回撤|波动|超额|胜率/.test(label) ? '%' : ''),
      10,
    );
    const xUnit = inferAxisUnit(xLabel, parsed.xUnit);
    const yUnit = inferAxisUnit(yLabel, parsed.yUnit);
    const includeZero = parsed.includeZero === true;

    const rawRefLines = Array.isArray(parsed.refLines) ? parsed.refLines.slice(0, 4) : [];
    const refLines = [];
    for (const ref of rawRefLines) {
      if (!ref || typeof ref !== 'object') continue;
      const axis = String(ref.axis || '').trim().toLowerCase();
      const value = parseNumericValue(ref.value);
      if ((axis !== 'x' && axis !== 'y') || value === null) continue;
      refLines.push({
        axis,
        value,
        label: clampString(ref.label, 24),
      });
    }

    let rawSeries = Array.isArray(parsed.series) ? parsed.series : null;
    if (!rawSeries && Array.isArray(parsed.points)) {
      rawSeries = [{ name: clampString(parsed.seriesName || title || '样本', 28), points: parsed.points }];
    }
    if (!Array.isArray(rawSeries) || !rawSeries.length) return null;

    const validShapes = new Set(['circle', 'diamond', 'hollow', 'hollow-diamond', 'square']);
    const series = [];
    let totalPoints = 0;

    for (const entry of rawSeries.slice(0, MAX_SERIES)) {
      if (!entry || typeof entry !== 'object') continue;
      const rawPoints = Array.isArray(entry.points) ? entry.points : Array.isArray(entry.data) ? entry.data : null;
      if (!rawPoints || !rawPoints.length) continue;
      const points = [];
      for (const pt of rawPoints) {
        if (totalPoints >= MAX_SCATTER_POINTS) break;
        if (!pt || typeof pt !== 'object') continue;
        const x = parseNumericValue(pt.x);
        const y = parseNumericValue(pt.y);
        if (x === null || y === null) continue;
        points.push({
          x,
          y,
          label: clampString(pt.label ?? pt.name ?? pt.code, 24),
          note: clampString(pt.note ?? pt.sub ?? pt.desc, 48),
          annotate: pt.annotate === true,
        });
        totalPoints++;
      }
      if (!points.length) continue;
      const rawShape = String(entry.shape || 'circle').trim().toLowerCase();
      series.push({
        name: clampString(entry.name || entry.label || `系列 ${series.length + 1}`, 28),
        shape: validShapes.has(rawShape) ? rawShape : 'circle',
        highlight: entry.highlight === true,
        points,
      });
    }
    if (!series.length) return null;

    const xs = series.flatMap(s => s.points.map(p => p.x));
    const ys = series.flatMap(s => s.points.map(p => p.y));
    for (const ref of refLines) {
      if (ref.axis === 'x') xs.push(ref.value);
      else ys.push(ref.value);
    }

    return {
      type,
      title,
      subtitle,
      source,
      xLabel,
      yLabel,
      xUnit,
      yUnit,
      includeZero,
      refLines,
      series,
      totalPoints,
      xMin: Math.min(...xs),
      xMax: Math.max(...xs),
      yMin: Math.min(...ys),
      yMax: Math.max(...ys),
    };
  }

  // `line` or `bar`
  let labels = Array.isArray(parsed.labels) ? parsed.labels.map(v => clampString(v, 24)).slice(0, MAX_POINTS) : [];
  let rawSeries = Array.isArray(parsed.series) ? parsed.series : null;
  if (!rawSeries && Array.isArray(parsed.items)) {
    labels = parsed.items.map(item => clampString(item?.label ?? item?.name, 24)).slice(0, MAX_POINTS);
    rawSeries = [{
      name: clampString(parsed.seriesName || parsed.title || '数值', 32),
      values: parsed.items.map(item => item?.value),
    }];
  }
  if (!labels.length || !Array.isArray(rawSeries) || !rawSeries.length) return null;

  const series = [];
  for (const entry of rawSeries.slice(0, MAX_SERIES)) {
    if (!entry || typeof entry !== 'object') continue;
    const rawVals = Array.isArray(entry.values) ? entry.values : Array.isArray(entry.data) ? entry.data : null;
    if (!rawVals || !rawVals.length) continue;
    const values = labels.map((_, idx) => parseNumericValue(rawVals[idx]));
    if (!values.some(v => v !== null)) continue;
    series.push({
      name: clampString(entry.name || entry.label || `系列 ${series.length + 1}`, 32),
      values,
      dashed: entry.dashed === true || entry.benchmark === true,
    });
  }
  if (!series.length) return null;

  const allValues = series.flatMap(s => s.values).filter(v => v !== null);
  if (!allValues.length) return null;
  if (type === 'line' && labels.length < 2) return null;

  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const hasNegative = minVal < 0;
  const hasPositive = maxVal > 0;
  const inferredUnit = unit || (/%|％|收益|回撤|涨跌|超额|回报/.test(`${title} ${subtitle}`) ? '%' : '');
  const colorBySign = parsed.colorBySign !== undefined
    ? Boolean(parsed.colorBySign)
    : (type === 'bar' && series.length === 1 && (hasNegative || inferredUnit === '%'));

  return {
    type,
    title,
    subtitle,
    source,
    unit: inferredUnit,
    colorBySign,
    hasNegative,
    hasPositive,
    minVal,
    maxVal,
    labels,
    series,
  };
}

/**
 * Validate and normalize a `fund-kpi` JSON specification.
 */
export function parseFundKpiSpec(rawText) {
  const parsed = typeof rawText === 'string' ? tryParseSpecJson(rawText) : rawText;
  if (!parsed || typeof parsed !== 'object') return null;
  const rawItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : null;
  if (!rawItems || !rawItems.length) return null;

  const items = [];
  for (const entry of rawItems.slice(0, MAX_KPI_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const label = clampString(entry.label ?? entry.name, 28);
    const value = clampString(entry.value, 32);
    if (!label || !value) continue;
    const sub = clampString(entry.sub ?? entry.note ?? entry.desc, 42);
    const explicitTrend = String(entry.trend || entry.tone || '').trim().toLowerCase();
    const directional = shouldColorDirectionalMetric({ label });
    let trend = ['up', 'down', 'flat', 'neutral', 'cold', 'cool', 'mid', 'warm', 'hot'].includes(explicitTrend)
      ? explicitTrend
      : ((directional ? classifySignedMetric(value) : null) || 'neutral');
    if (trend === 'neutral') {
      const valTone = VALUATION_TOKENS.find(t => value.includes(t.label))?.tone;
      if (valTone) trend = valTone;
    }
    items.push({ label, value, sub, trend, directional });
  }
  if (!items.length) return null;

  return {
    title: Array.isArray(parsed) ? '' : clampString(parsed.title, 48),
    asOf: Array.isArray(parsed) ? '' : clampString(parsed.asOf || parsed.subtitle || parsed.date, 48),
    items,
  };
}

/**
 * Validate and normalize a `fund-steps` horizontal methodology/SOP card JSON specification.
 */
export function parseFundStepsSpec(rawText) {
  const parsed = typeof rawText === 'string' ? tryParseSpecJson(rawText) : rawText;
  if (!parsed || typeof parsed !== 'object') return null;
  const rawSteps = Array.isArray(parsed) ? parsed : Array.isArray(parsed.steps) ? parsed.steps : null;
  if (!rawSteps || rawSteps.length < 2) return null;

  const validTones = new Set(['neutral', 'accent', 'warm', 'risk']);
  const steps = [];
  for (const entry of rawSteps.slice(0, MAX_STEPS)) {
    if (!entry || typeof entry !== 'object') continue;
    const title = clampString(entry.title ?? entry.label ?? entry.name, 26);
    if (!title) continue;
    const rawTone = String(entry.tone || '').trim().toLowerCase();
    steps.push({
      badge: clampString(entry.badge ?? entry.step ?? String(steps.length + 1), 8),
      title,
      summary: clampString(entry.summary ?? entry.desc ?? entry.subtitle, 44),
      meta: clampString(entry.meta ?? entry.tools ?? entry.note, 56),
      tone: validTones.has(rawTone) ? rawTone : 'neutral',
    });
  }
  if (steps.length < 2) return null;

  return {
    title: Array.isArray(parsed) ? '' : clampString(parsed.title, 64),
    subtitle: Array.isArray(parsed) ? '' : clampString(parsed.subtitle, 80),
    source: Array.isArray(parsed) ? '' : clampString(parsed.source, 48),
    steps,
  };
}

/* ==================== SVG Helpers ==================== */

function svgEl(doc, tag, attrs = {}) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  return node;
}

function computeNiceScale(rawMin, rawMax, { includeZero = false, tickCount = 4 } = {}) {
  let min = includeZero ? Math.min(0, rawMin) : rawMin;
  let max = includeZero ? Math.max(0, rawMax) : rawMax;
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.2 : 1;
    min -= pad;
    max += pad;
  } else {
    const span = max - min;
    const pad = span * 0.1;
    if (!includeZero || min < 0) min -= pad;
    if (!includeZero || max > 0) max += pad;
  }
  const range = max - min;
  const roughStep = range / Math.max(2, tickCount);
  const pow10 = 10 ** Math.floor(Math.log10(roughStep));
  const norm = roughStep / pow10;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = niceNorm * pow10;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.25; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

function createCardFrame(doc, { kind, title, subtitle, source }) {
  const figure = doc.createElement('figure');
  figure.className = `fund-vis-card fund-vis-${kind}`;
  figure.dataset.fundDecoration = 'true';

  if (title || subtitle) {
    const header = doc.createElement('div');
    header.className = 'fund-vis-header';
    const copy = doc.createElement('div');
    copy.className = 'fund-vis-titles';
    if (title) {
      const h = doc.createElement('div');
      h.className = 'fund-vis-title';
      h.textContent = title;
      copy.append(h);
    }
    if (subtitle) {
      const sub = doc.createElement('div');
      sub.className = 'fund-vis-subtitle';
      sub.textContent = subtitle;
      copy.append(sub);
    }
    header.append(copy);
    figure.append(header);
  }

  return { figure, addFooter: () => {
    if (!source) return;
    const cap = doc.createElement('figcaption');
    cap.className = 'fund-vis-footer';
    cap.textContent = source;
    figure.append(cap);
  } };
}

function buildLegend(doc, series, { unit = '', colorBySign = false } = {}) {
  const legend = doc.createElement('div');
  legend.className = 'fund-vis-legend';
  series.forEach((s, idx) => {
    const item = doc.createElement('span');
    item.className = 'fund-vis-legend-item';
    const swatch = doc.createElement('i');
    swatch.className = `fund-vis-swatch${s.dashed ? ' is-dashed' : ''}`;
    if (!colorBySign) {
      swatch.style.setProperty('--swatch-color', CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length]);
    }
    const name = doc.createElement('span');
    name.className = 'fund-vis-legend-name';
    name.textContent = s.name;
    item.append(swatch, name);

    const lastVal = [...s.values].reverse().find(v => v !== null);
    if (lastVal !== undefined && lastVal !== null) {
      const val = doc.createElement('strong');
      val.className = 'fund-vis-legend-val';
      const signed = unit === '%' || unit === '％';
      if (signed) {
        if (lastVal > 0) val.classList.add('is-up');
        else if (lastVal < 0) val.classList.add('is-down');
      }
      val.textContent = formatMetricValue(lastVal, { unit, signed });
      item.append(val);
    }
    legend.append(item);
  });
  return legend;
}

/**
 * Select evenly spaced X-axis label indices that guarantee pixel clearance
 * between adjacent labels and before the pinned last label.
 */
function selectVisibleTickIndices(labels, xFor, { maxLabels = 6, minGapPx = 62 } = {}) {
  const n = labels.length;
  if (n <= 2) return labels.map((_, i) => i);
  const maxChars = Math.max(...labels.map(l => String(l || '').length), 4);
  const gap = Math.max(minGapPx, Math.min(92, maxChars * 6.6 + 14));
  const last = n - 1;
  const lastX = xFor(last);
  const chosen = [0];
  let prevX = xFor(0);

  const step = Math.max(1, Math.ceil(last / Math.max(1, maxLabels - 1)));
  for (let i = step; i < last; i += step) {
    const x = xFor(i);
    if (x - prevX >= gap && lastX - x >= gap) {
      chosen.push(i);
      prevX = x;
    }
  }
  chosen.push(last);
  return chosen;
}

/* ---------- 1. Line Chart ---------- */

function buildLineChart(doc, spec) {
  const { figure, addFooter } = createCardFrame(doc, {
    kind: 'line',
    title: spec.title,
    subtitle: spec.subtitle,
    source: spec.source,
  });

  figure.append(buildLegend(doc, spec.series, { unit: spec.unit }));

  const stage = doc.createElement('div');
  stage.className = 'fund-vis-stage';

  const W = 560;
  const H = 224;
  const pad = { top: 16, right: 18, bottom: 30, left: 50 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const scale = computeNiceScale(spec.minVal, spec.maxVal, {
    includeZero: spec.hasNegative && spec.hasPositive,
    tickCount: 4,
  });
  const range = scale.max - scale.min || 1;
  const xFor = (i) => pad.left + (spec.labels.length === 1 ? plotW / 2 : (i / (spec.labels.length - 1)) * plotW);
  const yFor = (v) => pad.top + ((scale.max - v) / range) * plotH;

  const svg = svgEl(doc, 'svg', {
    class: 'fund-vis-svg',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': spec.title || '基金走势折线图',
  });

  const defs = svgEl(doc, 'defs');
  svg.append(defs);

  // Horizontal grid + Y ticks
  for (const tick of scale.ticks) {
    const y = yFor(tick);
    if (y < pad.top - 4 || y > pad.top + plotH + 4) continue;
    const isZero = Math.abs(tick) < 1e-9;
    svg.append(svgEl(doc, 'line', {
      x1: pad.left,
      y1: y.toFixed(1),
      x2: W - pad.right,
      y2: y.toFixed(1),
      class: isZero ? 'fund-svg-zero' : 'fund-svg-grid',
    }));
    const label = svgEl(doc, 'text', {
      x: pad.left - 8,
      y: (y + 3.5).toFixed(1),
      'text-anchor': 'end',
      class: 'fund-svg-axis-label',
    });
    label.textContent = formatMetricValue(tick, {
      unit: spec.unit,
      signed: spec.hasNegative && (spec.unit === '%' || spec.unit === '％'),
      decimals: Number.isInteger(tick) ? 0 : 1,
    });
    svg.append(label);
  }

  // X ticks (pixel-aware thinning so penultimate ticks never collide with the pinned end label)
  for (const i of selectVisibleTickIndices(spec.labels, xFor, { maxLabels: 6 })) {
    const x = xFor(i);
    const anchor = i === 0 ? 'start' : i === spec.labels.length - 1 ? 'end' : 'middle';
    const text = svgEl(doc, 'text', {
      x: x.toFixed(1),
      y: H - 8,
      'text-anchor': anchor,
      class: 'fund-svg-axis-label',
    });
    text.textContent = spec.labels[i];
    svg.append(text);
  }

  // Series lines + soft area under primary series
  const zeroY = scale.min <= 0 && scale.max >= 0 ? yFor(0) : pad.top + plotH;
  spec.series.forEach((s, sIdx) => {
    const color = CHART_SERIES_COLORS[sIdx % CHART_SERIES_COLORS.length];
    const pts = [];
    s.values.forEach((v, i) => {
      if (v !== null) pts.push({ i, x: xFor(i), y: yFor(v), v });
    });
    if (!pts.length) return;

    const lineD = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

    if (sIdx === 0 && spec.series.length <= 2 && !s.dashed && pts.length >= 2) {
      const gradId = `fund-area-${++svgGradientSeq}`;
      const grad = svgEl(doc, 'linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
      grad.append(
        svgEl(doc, 'stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.20' }),
        svgEl(doc, 'stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0.01' }),
      );
      defs.append(grad);
      const areaD = `${lineD} L${pts[pts.length - 1].x.toFixed(1)} ${zeroY.toFixed(1)} L${pts[0].x.toFixed(1)} ${zeroY.toFixed(1)} Z`;
      svg.append(svgEl(doc, 'path', { d: areaD, fill: `url(#${gradId})`, class: 'fund-svg-area' }));
    }

    svg.append(svgEl(doc, 'path', {
      d: lineD,
      fill: 'none',
      stroke: color,
      'stroke-width': s.dashed ? '1.75' : '2.2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      ...(s.dashed ? { 'stroke-dasharray': '5 4', opacity: '0.82' } : {}),
    }));

    const last = pts[pts.length - 1];
    svg.append(svgEl(doc, 'circle', {
      cx: last.x.toFixed(1),
      cy: last.y.toFixed(1),
      r: '3.6',
      fill: color,
      stroke: 'var(--surface)',
      'stroke-width': '1.8',
    }));
  });

  // Interactive crosshair + hit strips
  const guide = svgEl(doc, 'line', {
    x1: '0', y1: pad.top, x2: '0', y2: pad.top + plotH,
    class: 'fund-svg-crosshair',
    visibility: 'hidden',
  });
  svg.append(guide);

  const hoverGroup = svgEl(doc, 'g', { class: 'fund-svg-hover-dots', visibility: 'hidden' });
  spec.series.forEach((_s, sIdx) => {
    hoverGroup.append(svgEl(doc, 'circle', {
      r: '4.2',
      fill: CHART_SERIES_COLORS[sIdx % CHART_SERIES_COLORS.length],
      stroke: 'var(--surface)',
      'stroke-width': '2',
      'data-series-dot': String(sIdx),
    }));
  });
  svg.append(hoverGroup);

  const stepW = spec.labels.length > 1 ? plotW / (spec.labels.length - 1) : plotW;
  const hitGroup = svgEl(doc, 'g', { class: 'fund-svg-hits' });
  spec.labels.forEach((label, idx) => {
    const cx = xFor(idx);
    const x0 = idx === 0 ? pad.left : cx - stepW / 2;
    const w = idx === 0 || idx === spec.labels.length - 1 ? stepW / 2 : stepW;
    const hit = svgEl(doc, 'rect', {
      x: Math.max(pad.left, x0).toFixed(1),
      y: pad.top,
      width: Math.max(6, w).toFixed(1),
      height: plotH,
      fill: 'transparent',
      class: 'fund-svg-hit',
      'data-point-index': String(idx),
      'data-point-x': cx.toFixed(1),
      'data-point-label': label,
    });
    const ys = spec.series.map(s => (s.values[idx] !== null ? yFor(s.values[idx]).toFixed(1) : '')).join(',');
    const vals = spec.series.map(s => (s.values[idx] !== null ? String(s.values[idx]) : '')).join(',');
    hit.setAttribute('data-point-ys', ys);
    hit.setAttribute('data-point-vals', vals);
    hitGroup.append(hit);
  });
  svg.append(hitGroup);

  const tooltip = doc.createElement('div');
  tooltip.className = 'fund-vis-tooltip';
  tooltip.hidden = true;
  tooltip.dataset.fundUnit = spec.unit;
  tooltip.dataset.fundSeries = JSON.stringify(spec.series.map((s, idx) => ({
    name: s.name,
    color: CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length],
  })));

  stage.append(svg, tooltip);
  figure.append(stage);
  addFooter();
  return figure;
}

/* ---------- 2. Vertical Bar Chart ---------- */

function buildBarChart(doc, spec) {
  const { figure, addFooter } = createCardFrame(doc, {
    kind: 'bar',
    title: spec.title,
    subtitle: spec.subtitle,
    source: spec.source,
  });

  if (spec.series.length > 1) {
    figure.append(buildLegend(doc, spec.series, { unit: spec.unit, colorBySign: false }));
  }

  const stage = doc.createElement('div');
  stage.className = 'fund-vis-stage';

  const W = 560;
  const H = 224;
  const groupCount = spec.labels.length;
  const seriesCount = spec.series.length;
  const showDirectLabels = seriesCount === 1 ? groupCount <= 7 : (seriesCount <= 2 && groupCount <= 4);
  const pad = { top: 22, right: 16, bottom: spec.hasNegative && showDirectLabels ? 38 : 32, left: 48 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const scale = computeNiceScale(spec.minVal, spec.maxVal, { includeZero: true, tickCount: 4 });
  const range = scale.max - scale.min || 1;
  const yFor = (v) => pad.top + ((scale.max - v) / range) * plotH;
  const zeroY = yFor(0);

  const svg = svgEl(doc, 'svg', {
    class: 'fund-vis-svg',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': spec.title || '基金指标柱状图',
  });

  for (const tick of scale.ticks) {
    const y = yFor(tick);
    if (y < pad.top - 4 || y > pad.top + plotH + 4) continue;
    const isZero = Math.abs(tick) < 1e-9;
    svg.append(svgEl(doc, 'line', {
      x1: pad.left,
      y1: y.toFixed(1),
      x2: W - pad.right,
      y2: y.toFixed(1),
      class: isZero ? 'fund-svg-zero' : 'fund-svg-grid',
    }));
    const label = svgEl(doc, 'text', {
      x: pad.left - 8,
      y: (y + 3.5).toFixed(1),
      'text-anchor': 'end',
      class: 'fund-svg-axis-label',
    });
    label.textContent = formatMetricValue(tick, {
      unit: spec.unit,
      signed: spec.hasNegative && (spec.unit === '%' || spec.unit === '％'),
      decimals: Number.isInteger(tick) ? 0 : 1,
    });
    svg.append(label);
  }

  const slotW = plotW / Math.max(1, groupCount);
  const groupPad = Math.min(18, slotW * 0.22);
  const innerW = Math.max(10, slotW - groupPad);
  const barGap = seriesCount > 1 ? 3 : 0;
  const barW = Math.min(40, Math.max(6, (innerW - barGap * (seriesCount - 1)) / seriesCount));
  const totalBarsW = barW * seriesCount + barGap * (seriesCount - 1);
  const signedFmt = spec.colorBySign || spec.hasNegative || spec.unit === '%';

  const hoverBand = svgEl(doc, 'rect', {
    x: '0',
    y: pad.top,
    width: '0',
    height: plotH,
    rx: '6',
    class: 'fund-svg-hover-band',
    visibility: 'hidden',
  });
  svg.append(hoverBand);

  const guide = svgEl(doc, 'line', {
    x1: '0',
    y1: pad.top,
    x2: '0',
    y2: pad.top + plotH,
    class: 'fund-svg-crosshair',
    visibility: 'hidden',
  });
  svg.append(guide);

  spec.labels.forEach((label, gIdx) => {
    const slotLeft = pad.left + gIdx * slotW;
    const startX = slotLeft + (slotW - totalBarsW) / 2;

    spec.series.forEach((s, sIdx) => {
      const val = s.values[gIdx];
      if (val === null) return;
      const x = startX + sIdx * (barW + barGap);
      const valY = yFor(val);
      const y = val >= 0 ? valY : zeroY;
      const h = Math.max(2, Math.abs(zeroY - valY));
      const fill = spec.colorBySign
        ? (val > 0 ? 'var(--fund-up)' : val < 0 ? 'var(--fund-down)' : 'var(--fund-flat)')
        : CHART_SERIES_COLORS[sIdx % CHART_SERIES_COLORS.length];

      const bar = svgEl(doc, 'rect', {
        x: x.toFixed(1),
        y: y.toFixed(1),
        width: barW.toFixed(1),
        height: h.toFixed(1),
        rx: '3.5',
        fill,
        class: 'fund-svg-bar',
      });
      svg.append(bar);

      if (showDirectLabels) {
        const textY = val >= 0 ? Math.max(pad.top - 4, y - 5) : Math.min(H - 22, y + h + 12);
        const valText = svgEl(doc, 'text', {
          x: (x + barW / 2).toFixed(1),
          y: textY.toFixed(1),
          'text-anchor': 'middle',
          class: `fund-svg-bar-val${spec.colorBySign ? (val > 0 ? ' is-up' : val < 0 ? ' is-down' : '') : ''}`,
        });
        valText.textContent = formatMetricValue(val, { unit: spec.unit, signed: signedFmt });
        svg.append(valText);
      }
    });

    const xLabel = svgEl(doc, 'text', {
      x: (slotLeft + slotW / 2).toFixed(1),
      y: H - 9,
      'text-anchor': 'middle',
      class: 'fund-svg-axis-label',
    });
    xLabel.textContent = label.length > 9 ? `${label.slice(0, 8)}…` : label;
    svg.append(xLabel);

    const hit = svgEl(doc, 'rect', {
      x: slotLeft.toFixed(1),
      y: pad.top,
      width: slotW.toFixed(1),
      height: plotH,
      fill: 'transparent',
      class: 'fund-svg-hit',
      'data-point-index': String(gIdx),
      'data-point-x': (slotLeft + slotW / 2).toFixed(1),
      'data-band-x': (slotLeft + 3).toFixed(1),
      'data-band-w': Math.max(8, slotW - 6).toFixed(1),
      'data-point-label': label,
      'data-point-vals': spec.series.map(s => (s.values[gIdx] !== null ? String(s.values[gIdx]) : '')).join(','),
    });
    svg.append(hit);
  });

  const tooltip = doc.createElement('div');
  tooltip.className = 'fund-vis-tooltip';
  tooltip.hidden = true;
  tooltip.dataset.fundUnit = spec.unit;
  tooltip.dataset.fundColorBySign = spec.colorBySign ? 'true' : 'false';
  tooltip.dataset.fundSeries = JSON.stringify(spec.series.map((s, idx) => ({
    name: s.name,
    color: spec.colorBySign ? '' : CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length],
  })));

  stage.append(svg, tooltip);
  figure.append(stage);
  addFooter();
  return figure;
}

/* ---------- 3. Horizontal Bar Chart (Holdings / Allocation / Attribution) ---------- */

function buildHbarChart(doc, spec) {
  const { figure, addFooter } = createCardFrame(doc, {
    kind: 'hbar',
    title: spec.title,
    subtitle: spec.subtitle,
    source: spec.source,
  });

  const list = doc.createElement('div');
  list.className = `fund-hbar-list${spec.hasNegative ? ' is-diverging' : ''}`;
  const maxAbs = Math.max(...spec.items.map(item => Math.abs(item.value)), 0.0001);

  spec.items.forEach((item, idx) => {
    const row = doc.createElement('div');
    row.className = 'fund-hbar-row';

    const meta = doc.createElement('div');
    meta.className = 'fund-hbar-meta';
    const labelEl = doc.createElement('span');
    labelEl.className = 'fund-hbar-label';
    labelEl.textContent = item.label;
    meta.append(labelEl);
    if (item.note) {
      const noteEl = doc.createElement('small');
      noteEl.className = 'fund-hbar-note';
      noteEl.textContent = item.note;
      meta.append(noteEl);
    }

    const track = doc.createElement('div');
    track.className = 'fund-hbar-track';
    const fill = doc.createElement('i');
    fill.className = 'fund-hbar-fill';
    const pct = Math.max(2, Math.min(100, (Math.abs(item.value) / maxAbs) * 100));

    if (spec.hasNegative) {
      const halfPct = pct / 2;
      fill.style.width = `${halfPct.toFixed(2)}%`;
      if (item.value >= 0) {
        fill.classList.add('is-pos');
        fill.style.left = '50%';
      } else {
        fill.classList.add('is-neg');
        fill.style.left = `${(50 - halfPct).toFixed(2)}%`;
      }
    } else {
      fill.style.width = `${pct.toFixed(2)}%`;
      if (spec.colorBySign) {
        fill.style.setProperty('--hbar-color', item.value > 0 ? 'var(--fund-up)' : item.value < 0 ? 'var(--fund-down)' : 'var(--fund-flat)');
      } else {
        fill.style.setProperty('--hbar-color', CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length]);
      }
    }
    track.append(fill);

    const valEl = doc.createElement('span');
    valEl.className = 'fund-hbar-val';
    if (spec.colorBySign || spec.hasNegative) {
      if (item.value > 0) valEl.classList.add('is-up');
      else if (item.value < 0) valEl.classList.add('is-down');
    }
    valEl.textContent = formatMetricValue(item.value, {
      unit: spec.unit,
      signed: spec.colorBySign || spec.hasNegative,
    });

    row.append(meta, track, valEl);
    list.append(row);
  });

  figure.append(list);
  addFooter();
  return figure;
}

/* ---------- 4. Donut Chart (Asset Allocation / Portfolio Weights) ---------- */

function buildDonutChart(doc, spec) {
  const { figure, addFooter } = createCardFrame(doc, {
    kind: 'donut',
    title: spec.title,
    subtitle: spec.subtitle,
    source: spec.source,
  });

  const body = doc.createElement('div');
  body.className = 'fund-donut-body';

  const total = spec.items.reduce((sum, item) => sum + item.value, 0) || 1;
  const radius = 56;
  const circumference = 2 * Math.PI * radius;

  const ringWrap = doc.createElement('div');
  ringWrap.className = 'fund-donut-ring';

  const svg = svgEl(doc, 'svg', {
    viewBox: '0 0 156 156',
    class: 'fund-donut-svg',
    role: 'img',
    'aria-label': spec.title || '资产配置环形图',
  });

  svg.append(svgEl(doc, 'circle', {
    cx: '78', cy: '78', r: String(radius),
    fill: 'none',
    stroke: 'var(--fund-chart-grid)',
    'stroke-width': '18',
  }));

  let offset = 0;
  const segments = spec.items.map((item, idx) => {
    const share = item.value / total;
    const len = share * circumference;
    const gap = spec.items.length > 1 ? Math.min(2.2, len * 0.18) : 0;
    const color = CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length];
    const seg = svgEl(doc, 'circle', {
      cx: '78',
      cy: '78',
      r: String(radius),
      fill: 'none',
      stroke: color,
      'stroke-width': '18',
      'stroke-dasharray': `${Math.max(0.8, len - gap).toFixed(2)} ${(circumference - Math.max(0.8, len - gap)).toFixed(2)}`,
      'stroke-dashoffset': (-offset).toFixed(2),
      transform: 'rotate(-90 78 78)',
      class: 'fund-donut-seg',
      'data-donut-index': String(idx),
    });
    offset += len;
    svg.append(seg);
    return { item, share, color };
  });

  const topItem = segments[0];
  const defaultCenterVal = spec.centerValue || formatMetricValue(topItem.item.value, { unit: spec.unit });
  const defaultCenterLabel = spec.centerLabel || topItem.item.label;

  const center = doc.createElement('div');
  center.className = 'fund-donut-center';
  center.dataset.defaultVal = defaultCenterVal;
  center.dataset.defaultLabel = defaultCenterLabel;
  const centerValEl = doc.createElement('strong');
  centerValEl.textContent = defaultCenterVal;
  const centerLabelEl = doc.createElement('span');
  centerLabelEl.textContent = defaultCenterLabel;
  center.append(centerValEl, centerLabelEl);

  ringWrap.append(svg, center);

  const legend = doc.createElement('ul');
  legend.className = 'fund-donut-legend';
  segments.forEach(({ item, color }, idx) => {
    const li = doc.createElement('li');
    li.className = 'fund-donut-legend-row';
    li.dataset.donutIndex = String(idx);
    li.dataset.donutVal = formatMetricValue(item.value, { unit: spec.unit });
    li.dataset.donutLabel = item.label;

    const dot = doc.createElement('i');
    dot.className = 'fund-donut-dot';
    dot.style.backgroundColor = color;

    const name = doc.createElement('span');
    name.className = 'fund-donut-name';
    name.textContent = item.label;

    const val = doc.createElement('strong');
    val.className = 'fund-donut-val';
    val.textContent = formatMetricValue(item.value, { unit: spec.unit });

    li.append(dot, name, val);
    legend.append(li);
  });

  body.append(ringWrap, legend);
  figure.append(body);
  addFooter();
  return figure;
}

/* ---------- 5. Gauge / Temperature Strip ---------- */

function buildGaugeChart(doc, spec) {
  const { figure, addFooter } = createCardFrame(doc, {
    kind: 'gauge',
    title: spec.title,
    subtitle: spec.subtitle,
    source: spec.source,
  });

  const list = doc.createElement('div');
  list.className = 'fund-gauge-list';

  for (const item of spec.items) {
    const row = doc.createElement('div');
    row.className = `fund-gauge-row tone-${item.tone}`;

    const head = doc.createElement('div');
    head.className = 'fund-gauge-head';
    const name = doc.createElement('span');
    name.className = 'fund-gauge-name';
    name.textContent = item.label;

    const right = doc.createElement('span');
    right.className = 'fund-gauge-readout';
    const val = doc.createElement('strong');
    val.textContent = formatMetricValue(item.value, { unit: spec.unit, decimals: 1 });
    const badge = doc.createElement('em');
    badge.className = `fund-badge tone-${item.tone}`;
    badge.textContent = gaugeLabelForValue(item.value, item.note);
    right.append(val, badge);
    head.append(name, right);

    const track = doc.createElement('div');
    track.className = 'fund-gauge-track';
    const pin = doc.createElement('span');
    pin.className = 'fund-gauge-pin';
    pin.style.left = `${Math.max(2, Math.min(98, item.value)).toFixed(1)}%`;
    track.append(pin);

    row.append(head, track);
    list.append(row);
  }

  figure.append(list);
  addFooter();
  return figure;
}

/* ---------- 5b. 2D Scatter / Quadrant Chart ---------- */

function buildScatterLegend(doc, spec) {
  const legend = doc.createElement('div');
  legend.className = 'fund-vis-legend';
  spec.series.forEach((s, idx) => {
    const color = CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length];
    const item = doc.createElement('span');
    item.className = 'fund-vis-legend-item';
    const swatch = doc.createElement('i');
    swatch.className = `fund-vis-swatch-shape shape-${s.shape}`;
    swatch.style.setProperty('--swatch-color', color);
    const name = doc.createElement('span');
    name.className = 'fund-vis-legend-name';
    name.textContent = s.name;
    item.append(swatch, name);
    legend.append(item);
  });
  if (spec.refLines.length > 0) {
    const item = doc.createElement('span');
    item.className = 'fund-vis-legend-item';
    const swatch = doc.createElement('i');
    swatch.className = 'fund-vis-swatch is-dashed';
    swatch.style.setProperty('--swatch-color', 'var(--muted)');
    const name = doc.createElement('span');
    name.className = 'fund-vis-legend-name';
    name.textContent = spec.refLines[0].label || '参考分界线';
    item.append(swatch, name);
    legend.append(item);
  }
  return legend;
}

function createScatterPointShape(doc, { shape, cx, cy, r, color }) {
  const isHollow = shape === 'hollow' || shape === 'hollow-diamond';
  const isDiamond = shape === 'diamond' || shape === 'hollow-diamond';
  const fill = isHollow ? 'var(--surface)' : color;
  const stroke = isHollow ? color : 'var(--surface)';
  const strokeWidth = isHollow ? '2' : '1.4';

  if (isDiamond) {
    const d = r + 1.1;
    const pts = `${cx.toFixed(1)},${(cy - d).toFixed(1)} ${(cx + d).toFixed(1)},${cy.toFixed(1)} ${cx.toFixed(1)},${(cy + d).toFixed(1)} ${(cx - d).toFixed(1)},${cy.toFixed(1)}`;
    return svgEl(doc, 'polygon', {
      points: pts,
      fill,
      stroke,
      'stroke-width': strokeWidth,
      class: 'fund-svg-scatter-pt',
    });
  }
  if (shape === 'square') {
    const side = r * 1.7;
    return svgEl(doc, 'rect', {
      x: (cx - side / 2).toFixed(1),
      y: (cy - side / 2).toFixed(1),
      width: side.toFixed(1),
      height: side.toFixed(1),
      rx: '1.5',
      fill,
      stroke,
      'stroke-width': strokeWidth,
      class: 'fund-svg-scatter-pt',
    });
  }
  return svgEl(doc, 'circle', {
    cx: cx.toFixed(1),
    cy: cy.toFixed(1),
    r: r.toFixed(1),
    fill,
    stroke,
    'stroke-width': strokeWidth,
    class: 'fund-svg-scatter-pt',
  });
}

export function estimateSvgLabelWidth(text, fontSize = 9.5) {
  let width = 0;
  for (const ch of String(text || '')) {
    const code = ch.codePointAt(0) || 0;
    if (code > 0x2E7F) width += fontSize * 1.02;
    else if (/[A-Z0-9%]/.test(ch)) width += fontSize * 0.62;
    else if (/[().…\-\s]/.test(ch)) width += fontSize * 0.36;
    else width += fontSize * 0.54;
  }
  return Math.ceil(width + 6);
}

function rectsOverlap(a, b, pad = 0) {
  return a.left - pad < b.right + pad
    && a.right + pad > b.left - pad
    && a.top - pad < b.bottom + pad
    && a.bottom + pad > b.top - pad;
}

function overlapArea(a, b) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

function clampVal(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function labelRectForAnchor(x, y, width, anchor, height = 12) {
  const top = y - 9.2;
  const bottom = top + height;
  if (anchor === 'end') return { left: x - width, top, right: x + 1, bottom };
  if (anchor === 'middle') return { left: x - width / 2, top, right: x + width / 2, bottom };
  return { left: x - 1, top, right: x + width, bottom };
}

function leaderLineSegment(cx, cy, r, rect) {
  const ex = clampVal(cx, rect.left - 1, rect.right + 1);
  const ey = clampVal(cy, rect.top + 1, rect.bottom - 1);
  const vx = ex - cx;
  const vy = ey - cy;
  const dist = Math.hypot(vx, vy);
  if (dist < r + 9) return null;
  const startOffset = r + 2.2;
  const sx = cx + (vx / dist) * startOffset;
  const sy = cy + (vy / dist) * startOffset;
  return { x1: sx, y1: sy, x2: ex, y2: ey };
}

/**
 * Compute non-overlapping SVG label coordinates and optional leader lines for 2D scatter plots.
 * Prioritizes highlighted series first, then spreads clustered peers across open whitespace.
 */
export function layoutScatterLabels(items, { bounds, obstacles = [], points = [] } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length || !bounds) return { placements: [], hiddenCount: 0 };

  const refPts = points.length ? points : list;
  const meanX = refPts.reduce((sum, p) => sum + p.cx, 0) / refPts.length;
  const meanY = refPts.reduce((sum, p) => sum + p.cy, 0) / refPts.length;

  const placedRects = obstacles.map(o => ({ ...o }));
  const placedMap = new Map();
  let hiddenCount = 0;

  const sorted = [...list].sort((a, b) => {
    const hiDiff = Number(Boolean(b.highlight)) - Number(Boolean(a.highlight));
    if (hiDiff !== 0) return hiDiff;
    const annDiff = Number(Boolean(b.annotate)) - Number(Boolean(a.annotate));
    if (annDiff !== 0) return annDiff;
    const distA = Math.hypot(a.cx - meanX, a.cy - meanY);
    const distB = Math.hypot(b.cx - meanX, b.cy - meanY);
    return distB - distA;
  });

  const angles16 = Array.from({ length: 16 }, (_, i) => (i * Math.PI * 2) / 16);
  const ringRadii = [18, 34, 52, 74, 98, 126];
  const innerLimitX = bounds.left + 2;
  const innerLimitRight = bounds.right - 2;
  const innerLimitTop = bounds.top + 2;
  const innerLimitBottom = bounds.bottom - 2;

  for (const item of sorted) {
    const width = estimateSvgLabelWidth(item.text, item.fontSize || 9.5);
    const height = 12;
    const { cx, cy, r = 4.5 } = item;
    const candidates = [];

    const ring1 = [
      { dx: r + 5, dy: 3.5, anchor: 'start' },
      { dx: -(r + 5), dy: 3.5, anchor: 'end' },
      { dx: r + 4, dy: -(r + 3), anchor: 'start' },
      { dx: -(r + 4), dy: -(r + 3), anchor: 'end' },
      { dx: r + 4, dy: r + 11, anchor: 'start' },
      { dx: -(r + 4), dy: r + 11, anchor: 'end' },
      { dx: 0, dy: -(r + 5), anchor: 'middle' },
      { dx: 0, dy: r + 12, anchor: 'middle' },
    ];
    for (const opt of ring1) {
      candidates.push({
        x: cx + opt.dx,
        y: cy + opt.dy,
        anchor: opt.anchor,
        dist: Math.hypot(opt.dx, opt.dy),
        needsLeader: false,
      });
    }

    for (const rad of ringRadii) {
      const dist = r + rad;
      for (const theta of angles16) {
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const ax = cx + cos * dist;
        const ay = cy + sin * dist;
        const anchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle';
        candidates.push({ x: ax, y: ay + 3.2, anchor, dist, needsLeader: true });
      }
      for (const dyOff of [-28, -14, 0, 14, 28, 44, -44]) {
        const horizDist = dist + 14;
        candidates.push({ x: cx + horizDist, y: cy + dyOff, anchor: 'start', dist: Math.hypot(horizDist, dyOff), needsLeader: true });
        candidates.push({ x: cx - horizDist, y: cy + dyOff, anchor: 'end', dist: Math.hypot(horizDist, dyOff), needsLeader: true });
      }
    }

    let bestClean = null;
    let bestCleanScore = Infinity;
    let bestFallback = null;
    let bestFallbackScore = Infinity;

    for (const cand of candidates) {
      const rect = labelRectForAnchor(cand.x, cand.y, width, cand.anchor, height);
      if (rect.left < innerLimitX || rect.right > innerLimitRight || rect.top < innerLimitTop || rect.bottom > innerLimitBottom) {
        continue;
      }
      let dotHits = 0;
      for (const pt of refPts) {
        if (Math.abs(pt.cx - cx) < 0.1 && Math.abs(pt.cy - cy) < 0.1) continue;
        if (pt.cx >= rect.left - 5 && pt.cx <= rect.right + 5 && pt.cy >= rect.top - 5 && pt.cy <= rect.bottom + 5) {
          dotHits++;
        }
      }
      const rectCenterX = (rect.left + rect.right) / 2;
      const sidePenalty = ((cx < meanX && rectCenterX > cx + 22) || (cx > meanX && rectCenterX < cx - 22)) ? 24 : 0;
      const baseScore = cand.dist * 1.15 + dotHits * 160 + sidePenalty + (cand.needsLeader ? 0 : -6);

      const collides = placedRects.some(other => rectsOverlap(rect, other, 2.2));
      if (!collides) {
        if (baseScore < bestCleanScore) {
          bestCleanScore = baseScore;
          bestClean = { ...cand, rect };
        }
      } else if (item.highlight) {
        const overlap = placedRects.reduce((sum, other) => sum + overlapArea(rect, other), 0);
        const fbScore = overlap * 20 + baseScore;
        if (fbScore < bestFallbackScore) {
          bestFallbackScore = fbScore;
          bestFallback = { ...cand, rect };
        }
      }
    }

    const chosen = bestClean || bestFallback;
    if (chosen) {
      placedRects.push(chosen.rect);
      const leader = chosen.needsLeader ? leaderLineSegment(cx, cy, r, chosen.rect) : null;
      placedMap.set(item.id, {
        id: item.id,
        visible: true,
        x: chosen.x,
        y: chosen.y,
        anchor: chosen.anchor,
        rect: chosen.rect,
        needsLeader: Boolean(leader),
        leader,
      });
    } else {
      hiddenCount++;
      placedMap.set(item.id, { id: item.id, visible: false, needsLeader: false, leader: null });
    }
  }

  return {
    placements: list.map(item => placedMap.get(item.id)),
    hiddenCount,
  };
}

function buildScatterChart(doc, spec) {
  const { figure, addFooter } = createCardFrame(doc, {
    kind: 'scatter',
    title: spec.title,
    subtitle: spec.subtitle,
    source: spec.source,
  });

  figure.append(buildScatterLegend(doc, spec));

  const stage = doc.createElement('div');
  stage.className = 'fund-vis-stage';

  const W = 560;
  const H = spec.totalPoints >= 6 ? 320 : 280;
  const xScale = computeNiceScale(spec.xMin, spec.xMax, { includeZero: spec.includeZero, tickCount: 5 });
  const yScale = computeNiceScale(spec.yMin, spec.yMax, { includeZero: spec.includeZero, tickCount: 4 });
  const formatYTick = (tick) => formatMetricValue(tick, {
    unit: spec.yUnit,
    signed: spec.yMin < 0 && (spec.yUnit === '%' || spec.yUnit === '％'),
    decimals: Number.isInteger(tick) ? 0 : 1,
  });
  const formatXTick = (tick) => formatMetricValue(tick, {
    unit: spec.xUnit,
    signed: spec.xMin < 0 && (spec.xUnit === '%' || spec.xUnit === '％'),
    decimals: Number.isInteger(tick) ? 0 : 1,
  });
  const maxYTickChars = Math.max(...yScale.ticks.map(t => formatYTick(t).length), 4);
  const maxXTickChars = Math.max(...xScale.ticks.map(t => formatXTick(t).length), 3);
  const pad = { top: spec.refLines.length ? 22 : 20, right: 24, bottom: 44, left: Math.max(62, Math.round(maxYTickChars * 6.5 + 24)) };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const xRange = xScale.max - xScale.min || 1;
  const yRange = yScale.max - yScale.min || 1;
  const xFor = (v) => pad.left + ((v - xScale.min) / xRange) * plotW;
  const yFor = (v) => pad.top + ((yScale.max - v) / yRange) * plotH;

  const svg = svgEl(doc, 'svg', {
    class: 'fund-vis-svg',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': spec.title || '二维散点分布图',
  });

  // Y grid + ticks
  for (const tick of yScale.ticks) {
    const y = yFor(tick);
    if (y < pad.top - 4 || y > pad.top + plotH + 4) continue;
    const isZero = Math.abs(tick) < 1e-9;
    svg.append(svgEl(doc, 'line', {
      x1: pad.left,
      y1: y.toFixed(1),
      x2: W - pad.right,
      y2: y.toFixed(1),
      class: isZero ? 'fund-svg-zero' : 'fund-svg-grid',
    }));
    const label = svgEl(doc, 'text', {
      x: pad.left - 8,
      y: (y + 3.5).toFixed(1),
      'text-anchor': 'end',
      class: 'fund-svg-axis-label',
    });
    label.textContent = formatYTick(tick);
    svg.append(label);
  }

  // X grid + ticks (guard horizontal pixel spacing between tick labels)
  const minScatterXGap = Math.max(46, Math.round(maxXTickChars * 6.5 + 10));
  let lastScatterXLabel = -Infinity;
  for (const tick of xScale.ticks) {
    const x = xFor(tick);
    if (x < pad.left - 4 || x > pad.left + plotW + 4) continue;
    const isZero = Math.abs(tick) < 1e-9;
    svg.append(svgEl(doc, 'line', {
      x1: x.toFixed(1),
      y1: pad.top,
      x2: x.toFixed(1),
      y2: pad.top + plotH,
      class: isZero ? 'fund-svg-zero' : 'fund-svg-grid',
    }));
    if (x - lastScatterXLabel < minScatterXGap) continue;
    lastScatterXLabel = x;
    const label = svgEl(doc, 'text', {
      x: x.toFixed(1),
      y: H - 24,
      'text-anchor': 'middle',
      class: 'fund-svg-axis-label',
    });
    label.textContent = formatXTick(tick);
    svg.append(label);
  }

  // Axis titles
  const xTitle = svgEl(doc, 'text', {
    x: (pad.left + plotW / 2).toFixed(1),
    y: H - 6,
    'text-anchor': 'middle',
    class: 'fund-svg-axis-title',
  });
  xTitle.textContent = spec.xLabel;
  svg.append(xTitle);

  const yTitleX = 12;
  const yTitleY = pad.top + plotH / 2;
  const yTitle = svgEl(doc, 'text', {
    x: yTitleX,
    y: yTitleY.toFixed(1),
    'text-anchor': 'middle',
    transform: `rotate(-90 ${yTitleX} ${yTitleY.toFixed(1)})`,
    class: 'fund-svg-axis-title',
  });
  yTitle.textContent = spec.yLabel;
  svg.append(yTitle);

  // Dashed reference / threshold lines + collect obstacle boxes for label placement
  const refObstacles = [];
  for (const ref of spec.refLines) {
    if (ref.axis === 'x') {
      const rx = xFor(ref.value);
      svg.append(svgEl(doc, 'line', {
        x1: rx.toFixed(1),
        y1: pad.top,
        x2: rx.toFixed(1),
        y2: pad.top + plotH,
        class: 'fund-svg-refline',
      }));
      if (ref.label) {
        const nearRight = rx > W - pad.right - 72;
        const anchor = nearRight ? 'end' : 'start';
        const lx = nearRight ? rx - 5 : rx + 5;
        const ly = pad.top + 11;
        const txt = svgEl(doc, 'text', {
          x: lx.toFixed(1),
          y: String(ly),
          'text-anchor': anchor,
          class: 'fund-svg-refline-label',
        });
        txt.textContent = ref.label;
        svg.append(txt);
        refObstacles.push(labelRectForAnchor(lx, ly, estimateSvgLabelWidth(ref.label, 9.5), anchor, 12));
      }
    } else {
      const ry = yFor(ref.value);
      svg.append(svgEl(doc, 'line', {
        x1: pad.left,
        y1: ry.toFixed(1),
        x2: W - pad.right,
        y2: ry.toFixed(1),
        class: 'fund-svg-refline',
      }));
      if (ref.label) {
        const lx = W - pad.right - 4;
        const ly = Math.max(pad.top + 10, ry - 4);
        const txt = svgEl(doc, 'text', {
          x: lx.toFixed(1),
          y: ly.toFixed(1),
          'text-anchor': 'end',
          class: 'fund-svg-refline-label',
        });
        txt.textContent = ref.label;
        svg.append(txt);
        refObstacles.push(labelRectForAnchor(lx, ly, estimateSvgLabelWidth(ref.label, 9.5), 'end', 12));
      }
    }
  }

  // Draw non-highlighted series first, highlighted series on top
  const orderedSeries = spec.series
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => Number(a.s.highlight) - Number(b.s.highlight));

  const hitTargets = [];
  const allPointCoords = [];
  const labelRequests = [];
  const leaderGroup = svgEl(doc, 'g', { class: 'fund-svg-leaders' });
  svg.append(leaderGroup);

  for (const { s, idx } of orderedSeries) {
    const color = CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length];
    const r = s.highlight ? 5.4 : 4.1;
    const autoAnnotateSeries = s.highlight || s.points.length === 1 || spec.totalPoints <= 12;

    for (const pt of s.points) {
      const cx = xFor(pt.x);
      const cy = yFor(pt.y);
      allPointCoords.push({ cx, cy });
      svg.append(createScatterPointShape(doc, { shape: s.shape, cx, cy, r, color }));

      if (pt.label && (pt.annotate || autoAnnotateSeries)) {
        const shortText = pt.label.length > 14 ? `${pt.label.slice(0, 13)}…` : pt.label;
        labelRequests.push({
          id: `${idx}-${labelRequests.length}`,
          cx,
          cy,
          r,
          text: shortText,
          fullText: pt.label,
          highlight: Boolean(s.highlight),
          annotate: Boolean(pt.annotate),
        });
      }

      hitTargets.push({
        cx,
        cy,
        color,
        seriesName: s.name,
        label: pt.label || s.name,
        xVal: formatMetricValue(pt.x, { unit: spec.xUnit, signed: spec.xMin < 0 && spec.xUnit === '%' }),
        yVal: formatMetricValue(pt.y, { unit: spec.yUnit, signed: spec.yMin < 0 && spec.yUnit === '%' }),
        note: pt.note || '',
      });
    }
  }

  const { placements, hiddenCount } = layoutScatterLabels(labelRequests, {
    bounds: { left: pad.left, right: W - pad.right, top: pad.top, bottom: pad.top + plotH },
    obstacles: refObstacles,
    points: allPointCoords,
  });

  const labelGroup = svgEl(doc, 'g', { class: 'fund-svg-labels' });
  placements.forEach((placed, idx) => {
    if (!placed?.visible) return;
    const req = labelRequests[idx];
    if (placed.needsLeader && placed.leader) {
      leaderGroup.append(svgEl(doc, 'line', {
        x1: placed.leader.x1.toFixed(1),
        y1: placed.leader.y1.toFixed(1),
        x2: placed.leader.x2.toFixed(1),
        y2: placed.leader.y2.toFixed(1),
        class: 'fund-svg-leader-line',
      }));
    }
    const lbl = svgEl(doc, 'text', {
      x: placed.x.toFixed(1),
      y: placed.y.toFixed(1),
      'text-anchor': placed.anchor,
      class: `fund-svg-point-label${req.highlight ? ' is-highlight' : ''}`,
    });
    if (req.fullText && req.fullText !== req.text) {
      const nativeTitle = doc.createElementNS(SVG_NS, 'title');
      nativeTitle.textContent = req.fullText;
      lbl.append(nativeTitle);
    }
    lbl.append(doc.createTextNode(req.text));
    labelGroup.append(lbl);
  });
  svg.append(labelGroup);

  const activeRing = svgEl(doc, 'circle', {
    cx: '0',
    cy: '0',
    r: '7.5',
    visibility: 'hidden',
    class: 'fund-svg-scatter-active',
  });
  svg.append(activeRing);

  const hitGroup = svgEl(doc, 'g', { class: 'fund-svg-hits' });
  for (const h of hitTargets) {
    hitGroup.append(svgEl(doc, 'circle', {
      cx: h.cx.toFixed(1),
      cy: h.cy.toFixed(1),
      r: '10',
      fill: 'transparent',
      class: 'fund-svg-scatter-hit',
      'data-scatter-label': h.label,
      'data-scatter-series': h.seriesName,
      'data-scatter-x': h.xVal,
      'data-scatter-y': h.yVal,
      'data-scatter-note': h.note,
      'data-scatter-cx': h.cx.toFixed(1),
      'data-scatter-cy': h.cy.toFixed(1),
      'data-scatter-color': h.color,
    }));
  }
  svg.append(hitGroup);

  const tooltip = doc.createElement('div');
  tooltip.className = 'fund-vis-tooltip';
  tooltip.hidden = true;
  tooltip.dataset.fundXLabel = spec.xLabel;
  tooltip.dataset.fundYLabel = spec.yLabel;

  stage.append(svg, tooltip);
  figure.append(stage);
  if (hiddenCount > 0) {
    const cap = doc.createElement('figcaption');
    cap.className = 'fund-vis-footer';
    cap.textContent = `${spec.source ? `${spec.source} · ` : ''}另有 ${hiddenCount} 个密集点可悬停查看`;
    figure.append(cap);
  } else {
    addFooter();
  }
  return figure;
}

/* ---------- 6. Executive KPI Ledger Card ---------- */

function buildKpiCard(doc, spec) {
  const section = doc.createElement('section');
  section.className = 'fund-kpi-card';
  section.dataset.fundDecoration = 'true';
  section.setAttribute('aria-label', spec.title || '核心指标概览');

  if (spec.title || spec.asOf) {
    const head = doc.createElement('header');
    head.className = 'fund-kpi-head';
    if (spec.title) {
      const titleEl = doc.createElement('span');
      titleEl.className = 'fund-kpi-title';
      titleEl.textContent = spec.title;
      head.append(titleEl);
    }
    if (spec.asOf) {
      const asOfEl = doc.createElement('span');
      asOfEl.className = 'fund-kpi-asof';
      asOfEl.textContent = spec.asOf;
      head.append(asOfEl);
    }
    section.append(head);
  }

  const grid = doc.createElement('div');
  const colCount = spec.items.length === 2 ? 2 : spec.items.length === 3 ? 3 : Math.min(4, Math.max(2, spec.items.length));
  grid.className = `fund-kpi-grid cols-${colCount}`;

  for (const item of spec.items) {
    const cell = doc.createElement('div');
    cell.className = `fund-kpi-cell trend-${item.trend}`;

    const label = doc.createElement('span');
    label.className = 'fund-kpi-label';
    label.textContent = item.label;

    const value = doc.createElement('strong');
    value.className = 'fund-kpi-value';
    value.textContent = item.value;
    if (item.trend === 'neutral' && item.directional !== false && value.firstChild?.nodeType === 3) {
      decorateSignedMetricsInTextNode(doc, value.firstChild);
    }

    cell.append(label, value);
    if (item.sub) {
      const sub = doc.createElement('small');
      sub.className = 'fund-kpi-sub';
      sub.textContent = item.sub;
      cell.append(sub);
    }
    grid.append(cell);
  }

  section.append(grid);
  return section;
}

/* ---------- 7. Horizontal Methodology / SOP Steps Card ---------- */

function buildStepsCard(doc, spec) {
  const figure = doc.createElement('figure');
  figure.className = 'fund-steps-card';
  figure.dataset.fundDecoration = 'true';
  figure.setAttribute('aria-label', spec.title || '研究步骤框架');

  if (spec.title || spec.subtitle) {
    const header = doc.createElement('div');
    header.className = 'fund-vis-header';
    const copy = doc.createElement('div');
    copy.className = 'fund-vis-titles';
    if (spec.title) {
      const h = doc.createElement('div');
      h.className = 'fund-vis-title';
      h.textContent = spec.title;
      copy.append(h);
    }
    if (spec.subtitle) {
      const sub = doc.createElement('div');
      sub.className = 'fund-vis-subtitle';
      sub.textContent = spec.subtitle;
      copy.append(sub);
    }
    header.append(copy);
    figure.append(header);
  }

  const track = doc.createElement('div');
  track.className = 'fund-steps-track';

  spec.steps.forEach((step, idx) => {
    const col = doc.createElement('div');
    col.className = 'fund-step-col';

    const box = doc.createElement('div');
    box.className = `fund-step-box tone-${step.tone}`;

    const badge = doc.createElement('span');
    badge.className = 'fund-step-badge';
    badge.textContent = step.badge;

    const title = doc.createElement('strong');
    title.className = 'fund-step-title';
    title.textContent = step.title;

    box.append(badge, title);
    if (step.summary) {
      const summary = doc.createElement('p');
      summary.className = 'fund-step-summary';
      summary.textContent = step.summary;
      box.append(summary);
    }
    col.append(box);

    if (step.meta) {
      const meta = doc.createElement('div');
      meta.className = 'fund-step-meta';
      meta.textContent = step.meta;
      col.append(meta);
    }

    track.append(col);

    if (idx < spec.steps.length - 1) {
      const arrow = doc.createElement('span');
      arrow.className = 'fund-step-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      const arrowSvg = svgEl(doc, 'svg', { viewBox: '0 0 20 14', width: '16', height: '12' });
      arrowSvg.append(svgEl(doc, 'path', {
        d: 'M2 7h14m-4-4 4 4-4 4',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }));
      arrow.append(arrowSvg);
      track.append(arrow);
    }
  });

  figure.append(track);
  if (spec.source) {
    const cap = doc.createElement('figcaption');
    cap.className = 'fund-vis-footer';
    cap.textContent = spec.source;
    figure.append(cap);
  }
  return figure;
}

function buildStreamingSkeleton(doc, kind) {
  const box = doc.createElement('div');
  box.className = `fund-vis-skeleton fund-vis-skeleton-${kind}`;
  box.dataset.fundDecoration = 'true';
  const labelText = kind === 'kpi'
    ? '正在整理核心指标卡'
    : kind === 'steps'
      ? '正在整理分析步骤框架'
      : '正在绘制基金数据图表';
  box.setAttribute('aria-label', labelText);
  const label = doc.createElement('span');
  label.className = 'fund-vis-skeleton-label';
  label.textContent = `${labelText}…`;
  const bars = doc.createElement('div');
  bars.className = 'fund-vis-skeleton-bars';
  for (let i = 0; i < 4; i++) bars.append(doc.createElement('i'));
  box.append(label, bars);
  return box;
}

/* ==================== Inline, Table & Blockquote Enhancement ==================== */

function decorateSignedMetricsInTextNode(doc, textNode) {
  const value = textNode.nodeValue || '';
  if (!value || !/[+＋\-−]/.test(value)) return;
  SIGNED_METRIC_RE.lastIndex = 0;
  let match;
  let lastIndex = 0;
  let frag = null;

  while ((match = SIGNED_METRIC_RE.exec(value)) !== null) {
    const prefix = match[1] || '';
    const token = match[2];
    const dir = classifySignedMetric(token);
    if (!dir) continue;

    if (!frag) frag = doc.createDocumentFragment();
    const tokenStart = match.index + prefix.length;
    if (tokenStart > lastIndex) {
      frag.append(doc.createTextNode(value.slice(lastIndex, tokenStart)));
    }
    const span = doc.createElement('span');
    span.className = `fund-metric is-${dir}`;
    span.textContent = token;
    frag.append(span);
    lastIndex = tokenStart + token.length;
  }

  if (frag) {
    if (lastIndex < value.length) {
      frag.append(doc.createTextNode(value.slice(lastIndex)));
    }
    textNode.replaceWith(frag);
  }
}

function enhanceInlineSignedMetrics(root) {
  const doc = root.ownerDocument || globalThis.document;
  const NodeFilterApi = doc.defaultView?.NodeFilter || globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const walker = doc.createTreeWalker(root, NodeFilterApi.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || SKIP_TEXT_TAGS.has(parent.tagName)) continue;
    if (parent.closest?.(SKIP_TEXT_ANCESTOR_SELECTOR)) continue;
    if (node.nodeValue && /[+＋\-−]/.test(node.nodeValue)) {
      targets.push(node);
    }
  }
  for (const textNode of targets) {
    decorateSignedMetricsInTextNode(doc, textNode);
  }
}

function enhanceTables(root) {
  const doc = root.ownerDocument || globalThis.document;
  for (const table of root.querySelectorAll('table')) {
    table.classList.add('fund-report-table');
    const headers = [...table.querySelectorAll('thead th')].map(th => (th.textContent || '').trim());
    const allocCols = new Set();
    const codeCols = new Set();
    headers.forEach((h, idx) => {
      if (ALLOC_HEADER_RE.test(h)) allocCols.add(idx);
      if (CODE_HEADER_RE.test(h)) codeCols.add(idx);
    });

    const rows = [...table.querySelectorAll('tbody tr')];
    const colCount = headers.length || Math.max(0, ...rows.map(r => r.children.length));
    const colNumericCounts = new Array(colCount).fill(0);
    const colNonEmptyCounts = new Array(colCount).fill(0);

    for (const row of rows) {
      const cells = [...row.children].filter(el => el.tagName === 'TD');
      const rowLabel = (cells[0]?.textContent || '').trim();
      cells.forEach((cell, colIdx) => {
        const raw = (cell.textContent || '').trim();
        if (!raw || raw === '-' || raw === '—' || raw === '--' || raw === 'N/A') return;
        colNonEmptyCounts[colIdx]++;
        if (NUMERIC_CELL_RE.test(raw)) colNumericCounts[colIdx]++;

        const colHeader = headers[colIdx] || '';
        const dir = classifySignedMetric(raw);
        if (dir && shouldColorDirectionalMetric({ colHeader, rowLabel })) {
          if (dir === 'up') cell.classList.add('fund-pct-up');
          else if (dir === 'down') cell.classList.add('fund-pct-down');
          else if (dir === 'flat') cell.classList.add('fund-pct-flat');
        }

        const singleInline = !cell.children.length
          || (cell.children.length === 1 && (cell.children[0].tagName === 'CODE' || cell.children[0].tagName === 'STRONG'));

        // Valuation rating badge in table cell
        if (singleInline) {
          const valMatch = raw.match(VALUATION_EXACT_RE);
          if (valMatch) {
            const token = VALUATION_TOKENS.find(t => t.label === valMatch[1]);
            if (token) {
              const badge = doc.createElement('span');
              badge.className = `fund-badge tone-${token.tone}`;
              badge.textContent = raw;
              cell.textContent = '';
              cell.append(badge);
              return;
            }
          }

          // Risk level badge in table cell (R1..R5 or 低风险..高风险)
          const riskMatch = raw.match(RISK_CELL_RE);
          if (riskMatch) {
            const info = RISK_LEVEL_MAP[riskMatch[1].toUpperCase()];
            if (info) {
              const badge = doc.createElement('span');
              badge.className = `fund-risk-badge level-${info.level}`;
              badge.textContent = raw;
              cell.textContent = '';
              cell.append(badge);
              return;
            }
          } else if (RISK_TEXT_ONLY_MAP[raw]) {
            const badge = doc.createElement('span');
            badge.className = `fund-risk-badge level-${RISK_TEXT_ONLY_MAP[raw]}`;
            badge.textContent = raw;
            cell.textContent = '';
            cell.append(badge);
            return;
          }

          // 6-digit fund code pill in dedicated code column
          if (codeCols.has(colIdx) && FUND_CODE_RE.test(raw)) {
            const codeEl = doc.createElement('span');
            codeEl.className = 'fund-code-pill';
            codeEl.textContent = raw;
            cell.textContent = '';
            cell.append(codeEl);
            return;
          }
        }

        // Micro allocation bar for weight/ratio columns (CSS ::after, zero extra text)
        if (allocCols.has(colIdx)) {
          const pctMatch = raw.match(PURE_PCT_RE);
          if (pctMatch && !pctMatch[1]) {
            const pctNum = Number(pctMatch[2]);
            if (Number.isFinite(pctNum) && pctNum > 0 && pctNum <= 100) {
              cell.classList.add('fund-alloc-cell');
              cell.style.setProperty('--fund-bar-pct', `${Math.max(3, Math.min(100, pctNum)).toFixed(1)}%`);
            }
          }
        }
      });
    }

    // Right-align columns that are predominantly numeric (skip first label column)
    const headerCells = [...table.querySelectorAll('thead th')];
    for (let colIdx = 1; colIdx < colCount; colIdx++) {
      if (codeCols.has(colIdx)) continue;
      if (colNonEmptyCounts[colIdx] > 0 && colNumericCounts[colIdx] / colNonEmptyCounts[colIdx] >= 0.65) {
        headerCells[colIdx]?.classList.add('fund-num-col');
        for (const row of rows) {
          row.children[colIdx]?.classList.add('fund-num-col');
        }
      }
    }
  }
}

function enhanceBlockquotes(root) {
  for (const quote of root.querySelectorAll('blockquote')) {
    const text = (quote.textContent || '').trim();
    const tone = classifyBlockquoteTone(text);
    if (tone) {
      quote.classList.add('fund-callout', `tone-${tone}`);
      for (const code of quote.querySelectorAll('code')) {
        if (code.closest?.('pre')) continue;
        const codeText = (code.textContent || '').trim();
        const dir = classifySignedMetric(codeText);
        if (dir) code.classList.add('fund-code-metric', `is-${dir}`);
      }
    }
  }
}

function enhanceStructuredFences(root, { streaming = false } = {}) {
  const doc = root.ownerDocument || globalThis.document;
  for (const code of [...root.querySelectorAll('pre > code')]) {
    const cls = code.className || '';
    const isChart = /\blanguage-fund-chart\b/i.test(cls);
    const isKpi = /\blanguage-fund-kpi\b/i.test(cls);
    const isSteps = /\blanguage-fund-steps\b/i.test(cls);
    if (!isChart && !isKpi && !isSteps) continue;

    const pre = code.parentElement;
    const raw = code.textContent || '';

    if (isKpi) {
      const spec = parseFundKpiSpec(raw);
      if (spec) {
        pre.replaceWith(buildKpiCard(doc, spec));
      } else if (streaming) {
        pre.replaceWith(buildStreamingSkeleton(doc, 'kpi'));
      }
      continue;
    }

    if (isSteps) {
      const spec = parseFundStepsSpec(raw);
      if (spec) {
        pre.replaceWith(buildStepsCard(doc, spec));
      } else if (streaming) {
        pre.replaceWith(buildStreamingSkeleton(doc, 'steps'));
      }
      continue;
    }

    const spec = parseFundChartSpec(raw);
    if (spec) {
      const card = renderChartSpec(doc, spec);
      if (card) pre.replaceWith(card);
    } else if (streaming) {
      pre.replaceWith(buildStreamingSkeleton(doc, 'chart'));
    }
  }
}

const FEE_OR_RULE_RE = /费率|申购费|赎回费|管理费|托管费|服务费|持有期|确认日|到账|限额|起购/;
const RETURN_LABEL_RE = /收益|回报|涨跌|涨幅|超额|年化|近\s*\d+\s*[月年周日]|今年以来|成立以来/;
const DRAWDOWN_LABEL_RE = /回撤/;
const LEADING_PCT_RE = /^([+＋\-−]?\d{1,4}(?:\.\d{1,4})?)[%％](?:\s|$|[（(·,，])/;

function parseLeadingPct(raw) {
  const text = String(raw || '').trim();
  const m = text.match(LEADING_PCT_RE);
  if (!m) return null;
  const num = Number(m[1].replace(/[＋]/g, '+').replace(/[−]/g, '-'));
  return Number.isFinite(num) ? num : null;
}

/**
 * Deterministically infer a safe, zero-hallucination chart spec from a Fund Mode
 * Markdown table when the model did not emit an explicit `fund-chart` fence.
 * Only uses verbatim `%` values already present in the table; returns null if
 * the table is non-numeric, fee/rule-oriented, or lacks >= 2 clean comparable rows.
 */
export function inferChartSpecFromTable(table) {
  if (!table?.querySelectorAll) return null;
  const headers = [...table.querySelectorAll('thead th')].map(th => clampString(th.textContent, 28));
  const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
    [...tr.children].filter(el => el.tagName === 'TD').map(td => (td.textContent || '').trim()),
  );
  if (headers.length < 2 || rows.length < 2) return null;

  const allText = `${headers.join(' ')} ${rows.map(r => r[0] || '').join(' ')}`;
  if (FEE_OR_RULE_RE.test(allText)) return null;

  // Identify candidate numeric `%` columns (excluding column 0 and code columns)
  const pctCols = [];
  for (let c = 1; c < headers.length; c++) {
    if (CODE_HEADER_RE.test(headers[c])) continue;
    let hits = 0;
    for (const r of rows) {
      if (parseLeadingPct(r[c]) !== null) hits++;
    }
    if (hits >= 2) pctCols.push(c);
  }
  if (!pctCols.length) return null;

  // Pattern A: Allocation / Weight table (single % column whose header indicates weight/share)
  if (pctCols.length === 1 && ALLOC_HEADER_RE.test(headers[pctCols[0]])) {
    const col = pctCols[0];
    const items = rows
      .map(r => ({ label: clampString(r[0], 24), value: parseLeadingPct(r[col]) }))
      .filter(it => it.label && it.value !== null && !/^合计|总计$/.test(it.label))
      .slice(0, 8);
    if (items.length >= 2) {
      const sum = items.reduce((acc, it) => acc + Math.max(0, it.value), 0);
      const allPos = items.every(it => it.value > 0);
      const useDonut = allPos && items.length >= 3 && items.length <= 6 && sum >= 85 && sum <= 105;
      return parseFundChartSpec({
        type: useDonut ? 'donut' : 'hbar',
        title: `${headers[col]}分布`,
        subtitle: '基于上表数据自动生成',
        unit: '%',
        items,
      });
    }
  }

  // Pattern B: Metric-per-row comparison (e.g. 近1年最大回撤 / 近3年收益 across 1..4 funds)
  const seriesCols = pctCols.slice(0, 4);
  const pctRows = rows
    .map(r => ({
      label: clampString(r[0], 22),
      vals: seriesCols.map(c => parseLeadingPct(r[c])),
    }))
    .filter(r => r.label && r.vals.some(v => v !== null));

  if (pctRows.length < 2) return null;

  const drawdownRows = pctRows.filter(r => DRAWDOWN_LABEL_RE.test(r.label));
  const returnRows = pctRows.filter(r => RETURN_LABEL_RE.test(r.label) && !DRAWDOWN_LABEL_RE.test(r.label) && !/波动率/.test(r.label));

  let chosen = null;
  let title = '';
  if (returnRows.length >= 2) {
    chosen = returnRows.slice(0, 8);
    title = seriesCols.length > 1 ? '阶段收益对比' : `${headers[seriesCols[0]] || '阶段收益'}表现`;
  } else if (drawdownRows.length >= 2) {
    chosen = drawdownRows.slice(0, 8);
    title = seriesCols.length > 1 ? '最大回撤对比' : '历史最大回撤';
  } else if (pctRows.length >= 2 && pctRows.length <= 8 && !pctRows.some(r => /波动率/.test(r.label) && pctRows.some(x => DRAWDOWN_LABEL_RE.test(x.label)))) {
    // Fund-per-row comparison (e.g. col 0 = fund code/name, cols = 近1年收益 / 最大回撤)
    const metricCols = seriesCols.filter(c => RETURN_LABEL_RE.test(headers[c]) || DRAWDOWN_LABEL_RE.test(headers[c]));
    if (metricCols.length >= 1) {
      const fundLabelCol = CODE_HEADER_RE.test(headers[0]) && headers.length > 1 && !pctCols.includes(1) ? 1 : 0;
      const fundRows = rows
        .map(r => ({
          label: clampString(r[fundLabelCol] || r[0], 18),
          vals: metricCols.slice(0, 3).map(c => parseLeadingPct(r[c])),
        }))
        .filter(r => r.label && r.vals.some(v => v !== null))
        .slice(0, 6);
      if (fundRows.length >= 2) {
        return parseFundChartSpec({
          type: 'bar',
          title: metricCols.length > 1 ? '核心收益与回撤对比' : `${headers[metricCols[0]]}对比`,
          subtitle: '基于上表数据自动生成',
          unit: '%',
          labels: fundRows.map(r => r.label),
          series: metricCols.slice(0, 3).map((c, idx) => ({
            name: headers[c],
            values: fundRows.map(r => r.vals[idx]),
          })),
        });
      }
    }
  }

  if (!chosen || chosen.length < 2) return null;
  return parseFundChartSpec({
    type: 'bar',
    title,
    subtitle: '基于上表数据自动生成',
    unit: '%',
    labels: chosen.map(r => r.label),
    series: seriesCols.map((c, idx) => ({
      name: headers[c],
      values: chosen.map(r => r.vals[idx]),
    })),
  });
}

function renderChartSpec(doc, spec) {
  if (!spec) return null;
  if (spec.type === 'line') return buildLineChart(doc, spec);
  if (spec.type === 'bar') return buildBarChart(doc, spec);
  if (spec.type === 'hbar') return buildHbarChart(doc, spec);
  if (spec.type === 'donut') return buildDonutChart(doc, spec);
  if (spec.type === 'gauge') return buildGaugeChart(doc, spec);
  if (spec.type === 'scatter') return buildScatterChart(doc, spec);
  return null;
}

function synthesizeChartsFromTables(root, { useECharts = false, exportMode = false, renderStaticChartSvg = null } = {}) {
  if (root.querySelector('.fund-vis-card, .unk-chart-card')) return;
  const doc = root.ownerDocument || globalThis.document;
  let created = 0;
  for (const table of [...root.querySelectorAll('table')]) {
    if (created >= 2) break;
    const spec = inferChartSpecFromTable(table);
    const card = spec
      ? (useECharts
          ? buildChartCardElement(doc, spec, { exportMode, renderStaticSvg: renderStaticChartSvg })
          : renderChartSpec(doc, spec))
      : null;
    if (!card) continue;
    const anchor = table.closest('.md-table-scroll') || table;
    if (anchor.parentNode) {
      if (typeof anchor.after === 'function') anchor.after(card);
      else anchor.parentNode.append(card);
      created++;
    }
  }
}

/**
 * Main entry point: enhance a rendered Fund Mode DOM fragment/container.
 * Safe to run both during streaming and after completion.
 */
export function enhanceFundMarkdown(root, {
  streaming = false,
  useECharts = false,
  exportMode = false,
  renderStaticChartSvg = null,
} = {}) {
  if (!root?.querySelectorAll) return;
  enhanceStructuredFences(root, { streaming });
  if (!streaming) synthesizeChartsFromTables(root, { useECharts, exportMode, renderStaticChartSvg });
  enhanceTables(root);
  enhanceBlockquotes(root);
  enhanceInlineSignedMetrics(root);
}

/* ==================== Lightweight Delegated Chart Interactivity ==================== */

const boundContainers = new WeakSet();
const ELLIPSIS_TARGET_SELECTOR = '.fund-kpi-cell, .fund-hbar-label, .fund-hbar-note, .fund-donut-name, .fund-vis-legend-name, .fund-vis-title, .fund-vis-subtitle';
let sharedEllipsisTip = null;
let sharedEllipsisTarget = null;
let sharedEllipsisTimer = null;

export function isElementTruncated(el) {
  if (!el) return false;
  return (el.scrollWidth > el.clientWidth + 1) || (el.scrollHeight > el.clientHeight + 2);
}

function hideEllipsisTip() {
  if (sharedEllipsisTimer !== null) {
    clearTimeout(sharedEllipsisTimer);
    sharedEllipsisTimer = null;
  }
  sharedEllipsisTarget = null;
  if (sharedEllipsisTip) sharedEllipsisTip.hidden = true;
}

function populateEllipsisTipContent(doc, tip, target) {
  tip.textContent = '';
  if (target.classList?.contains('fund-kpi-cell')) {
    const labelEl = target.querySelector('.fund-kpi-label');
    const valueEl = target.querySelector('.fund-kpi-value');
    const subEl = target.querySelector('.fund-kpi-sub');
    const anyClipped = [labelEl, valueEl, subEl].some(isElementTruncated);
    if (!anyClipped) return false;

    if (labelEl?.textContent) {
      const l = doc.createElement('div');
      l.className = 'fund-ellipsis-tip-label';
      l.textContent = labelEl.textContent;
      tip.append(l);
    }
    if (valueEl?.textContent) {
      const v = doc.createElement('div');
      v.className = 'fund-ellipsis-tip-value';
      for (const t of ['up', 'down', 'flat', 'cold', 'cool', 'mid', 'warm', 'hot']) {
        if (target.classList.contains(`trend-${t}`)) v.classList.add(`trend-${t}`);
      }
      v.textContent = valueEl.textContent;
      if (target.classList.contains('trend-neutral') && shouldColorDirectionalMetric({ label: labelEl?.textContent || '' })
        && v.firstChild?.nodeType === 3) {
        decorateSignedMetricsInTextNode(doc, v.firstChild);
      }
      tip.append(v);
    }
    if (subEl?.textContent) {
      const s = doc.createElement('div');
      s.className = 'fund-ellipsis-tip-sub';
      s.textContent = subEl.textContent;
      tip.append(s);
    }
    return tip.childNodes.length > 0;
  }

  if (!isElementTruncated(target)) return false;
  const text = (target.textContent || '').trim();
  if (!text) return false;
  const line = doc.createElement('div');
  line.className = 'fund-ellipsis-tip-sub';
  line.textContent = text;
  tip.append(line);
  return true;
}

function showEllipsisTip(target) {
  if (!target?.isConnected) return;
  const doc = target.ownerDocument || globalThis.document;
  if (!sharedEllipsisTip || sharedEllipsisTip.ownerDocument !== doc) {
    sharedEllipsisTip?.remove();
    sharedEllipsisTip = doc.createElement('div');
    sharedEllipsisTip.className = 'fund-ellipsis-tip';
    sharedEllipsisTip.setAttribute('role', 'tooltip');
    sharedEllipsisTip.hidden = true;
    doc.body?.append(sharedEllipsisTip);
  }
  if (!populateEllipsisTipContent(doc, sharedEllipsisTip, target)) {
    hideEllipsisTip();
    return;
  }
  sharedEllipsisTip.hidden = false;

  const win = doc.defaultView;
  const vw = win?.innerWidth || 440;
  const vh = win?.innerHeight || 720;
  const rect = target.getBoundingClientRect();
  const tipRect = sharedEllipsisTip.getBoundingClientRect();
  const pad = 10;

  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(pad, Math.min(vw - tipRect.width - pad, left));
  let top = rect.top - tipRect.height - 8;
  if (top < pad) top = rect.bottom + 8;
  if (top + tipRect.height > vh - pad) top = Math.max(pad, vh - tipRect.height - pad);

  sharedEllipsisTip.style.left = `${Math.round(left)}px`;
  sharedEllipsisTip.style.top = `${Math.round(top)}px`;
}

function renderTooltip(tooltip, { label, vals, stage, pointX, viewBoxWidth }) {
  const doc = tooltip.ownerDocument;
  let seriesMeta = [];
  try { seriesMeta = JSON.parse(tooltip.dataset.fundSeries || '[]'); } catch {}
  const unit = tooltip.dataset.fundUnit || '';
  const colorBySign = tooltip.dataset.fundColorBySign === 'true';

  tooltip.textContent = '';
  const head = doc.createElement('div');
  head.className = 'fund-vis-tooltip-head';
  head.textContent = label;
  tooltip.append(head);

  seriesMeta.forEach((meta, idx) => {
    const rawVal = vals[idx];
    if (rawVal === '' || rawVal === undefined) return;
    const num = Number(rawVal);
    if (!Number.isFinite(num)) return;

    const row = doc.createElement('div');
    row.className = 'fund-vis-tooltip-row';

    const dot = doc.createElement('i');
    dot.className = 'fund-vis-tooltip-dot';
    dot.style.backgroundColor = colorBySign
      ? (num > 0 ? 'var(--fund-up)' : num < 0 ? 'var(--fund-down)' : 'var(--fund-flat)')
      : meta.color;

    const name = doc.createElement('span');
    name.textContent = meta.name;

    const val = doc.createElement('strong');
    const signed = unit === '%' || unit === '％' || colorBySign;
    if (signed) {
      if (num > 0) val.classList.add('is-up');
      else if (num < 0) val.classList.add('is-down');
    }
    val.textContent = formatMetricValue(num, { unit, signed });

    row.append(dot, name, val);
    tooltip.append(row);
  });

  tooltip.hidden = false;
  const pctX = Math.max(0, Math.min(1, pointX / (viewBoxWidth || 560)));
  const stageRect = stage.getBoundingClientRect?.();
  if (stageRect && stageRect.width > 0) {
    const px = pctX * stageRect.width;
    const flip = pctX > 0.62;
    tooltip.style.left = flip ? 'auto' : `${Math.min(stageRect.width - 140, Math.max(8, px + 10))}px`;
    tooltip.style.right = flip ? `${Math.min(stageRect.width - 140, Math.max(8, stageRect.width - px + 10))}px` : 'auto';
  }
}

/**
 * Bind delegated hover/pointer interactivity for SVG line/bar/donut charts
 * inside a message content container (idempotent via WeakSet).
 */
export function bindFundMarkdownInteractions(container) {
  if (!container?.addEventListener || boundContainers.has(container)) return;
  boundContainers.add(container);

  const clearStage = (stage) => {
    const tooltip = stage?.querySelector('.fund-vis-tooltip');
    if (tooltip) tooltip.hidden = true;
    const guide = stage?.querySelector('.fund-svg-crosshair');
    if (guide) guide.setAttribute('visibility', 'hidden');
    const band = stage?.querySelector('.fund-svg-hover-band');
    if (band) band.setAttribute('visibility', 'hidden');
    const dots = stage?.querySelector('.fund-svg-hover-dots');
    if (dots) dots.setAttribute('visibility', 'hidden');
    const ring = stage?.querySelector('.fund-svg-scatter-active');
    if (ring) ring.setAttribute('visibility', 'hidden');
  };

  const showScatterPointTooltip = (stage, scatterHit) => {
    const tooltip = stage?.querySelector('.fund-vis-tooltip');
    if (!stage || !tooltip || !scatterHit) return;
    const doc = tooltip.ownerDocument;
    tooltip.textContent = '';

    const head = doc.createElement('div');
    head.className = 'fund-vis-tooltip-head';
    head.textContent = scatterHit.getAttribute('data-scatter-label') || '';
    tooltip.append(head);

    const sRow = doc.createElement('div');
    sRow.className = 'fund-vis-tooltip-row';
    const dot = doc.createElement('i');
    dot.className = 'fund-vis-tooltip-dot';
    dot.style.backgroundColor = scatterHit.getAttribute('data-scatter-color') || 'var(--teal)';
    const sName = doc.createElement('span');
    sName.textContent = scatterHit.getAttribute('data-scatter-series') || '样本';
    sRow.append(dot, sName);
    tooltip.append(sRow);

    const addMetricRow = (axisLabel, valText) => {
      const row = doc.createElement('div');
      row.className = 'fund-vis-tooltip-row';
      const name = doc.createElement('span');
      name.textContent = axisLabel;
      const val = doc.createElement('strong');
      val.textContent = valText;
      row.append(name, val);
      tooltip.append(row);
    };
    addMetricRow(tooltip.dataset.fundXLabel || 'X', scatterHit.getAttribute('data-scatter-x') || '');
    addMetricRow(tooltip.dataset.fundYLabel || 'Y', scatterHit.getAttribute('data-scatter-y') || '');

    const note = scatterHit.getAttribute('data-scatter-note');
    if (note) {
      const noteEl = doc.createElement('div');
      noteEl.className = 'fund-vis-tooltip-note';
      noteEl.textContent = note;
      tooltip.append(noteEl);
    }

    const pointX = Number(scatterHit.getAttribute('data-scatter-cx') || 0);
    const pointY = Number(scatterHit.getAttribute('data-scatter-cy') || 0);
    const ring = stage.querySelector('.fund-svg-scatter-active');
    if (ring) {
      ring.setAttribute('cx', String(pointX));
      ring.setAttribute('cy', String(pointY));
      ring.setAttribute('stroke', scatterHit.getAttribute('data-scatter-color') || 'var(--teal)');
      ring.setAttribute('visibility', 'visible');
    }

    tooltip.hidden = false;
    const pctX = Math.max(0, Math.min(1, pointX / 560));
    const stageRect = stage.getBoundingClientRect?.();
    if (stageRect && stageRect.width > 0) {
      const px = pctX * stageRect.width;
      const flip = pctX > 0.62;
      tooltip.style.left = flip ? 'auto' : `${Math.min(stageRect.width - 150, Math.max(8, px + 10))}px`;
      tooltip.style.right = flip ? `${Math.min(stageRect.width - 150, Math.max(8, stageRect.width - px + 10))}px` : 'auto';
    }
  };

  const clearDonut = (card) => {
    card?.querySelectorAll('.is-active').forEach(el => el.classList.remove('is-active'));
    const center = card?.querySelector('.fund-donut-center');
    if (center) {
      const strong = center.querySelector('strong');
      const span = center.querySelector('span');
      if (strong && center.dataset.defaultVal) strong.textContent = center.dataset.defaultVal;
      if (span && center.dataset.defaultLabel) span.textContent = center.dataset.defaultLabel;
    }
  };

  container.addEventListener('pointerover', (event) => {
    const target = event.target;
    const hit = target?.closest?.('.fund-svg-hit');
    if (hit) {
      const stage = hit.closest('.fund-vis-stage');
      const tooltip = stage?.querySelector('.fund-vis-tooltip');
      if (!stage || !tooltip) return;
      const pointX = Number(hit.getAttribute('data-point-x') || 0);
      const label = hit.getAttribute('data-point-label') || '';
      const vals = (hit.getAttribute('data-point-vals') || '').split(',');
      const ys = (hit.getAttribute('data-point-ys') || '').split(',');

      const guide = stage.querySelector('.fund-svg-crosshair');
      if (guide) {
        guide.setAttribute('x1', String(pointX));
        guide.setAttribute('x2', String(pointX));
        guide.setAttribute('visibility', 'visible');
      }
      const band = stage.querySelector('.fund-svg-hover-band');
      const bandX = hit.getAttribute('data-band-x');
      const bandW = hit.getAttribute('data-band-w');
      if (band && bandX && bandW) {
        band.setAttribute('x', bandX);
        band.setAttribute('width', bandW);
        band.setAttribute('visibility', 'visible');
      }
      const dots = stage.querySelector('.fund-svg-hover-dots');
      if (dots) {
        dots.setAttribute('visibility', 'visible');
        dots.querySelectorAll('[data-series-dot]').forEach((circle, idx) => {
          const cy = ys[idx];
          if (cy) {
            circle.setAttribute('cx', String(pointX));
            circle.setAttribute('cy', cy);
            circle.setAttribute('visibility', 'visible');
          } else {
            circle.setAttribute('visibility', 'hidden');
          }
        });
      }
      renderTooltip(tooltip, { label, vals, stage, pointX, viewBoxWidth: 560 });
      return;
    }

    const scatterHit = target?.closest?.('.fund-svg-scatter-hit');
    if (scatterHit) {
      showScatterPointTooltip(scatterHit.closest('.fund-vis-stage'), scatterHit);
      return;
    }

    const donutTarget = target?.closest?.('[data-donut-index]');
    if (donutTarget) {
      const card = donutTarget.closest('.fund-vis-donut');
      if (!card) return;
      const idx = donutTarget.dataset.donutIndex;
      card.querySelectorAll('[data-donut-index]').forEach(el => {
        el.classList.toggle('is-active', el.dataset.donutIndex === idx);
      });
      const row = card.querySelector(`.fund-donut-legend-row[data-donut-index="${idx}"]`);
      const center = card.querySelector('.fund-donut-center');
      if (row && center) {
        const strong = center.querySelector('strong');
        const span = center.querySelector('span');
        if (strong) strong.textContent = row.dataset.donutVal || '';
        if (span) span.textContent = row.dataset.donutLabel || '';
      }
      return;
    }

    const ellipsisTarget = target?.closest?.(ELLIPSIS_TARGET_SELECTOR);
    if (!ellipsisTarget) {
      if (sharedEllipsisTarget) hideEllipsisTip();
      return;
    }
    if (ellipsisTarget === sharedEllipsisTarget) return;
    if (sharedEllipsisTimer !== null) clearTimeout(sharedEllipsisTimer);
    sharedEllipsisTarget = ellipsisTarget;
    sharedEllipsisTimer = setTimeout(() => {
      sharedEllipsisTimer = null;
      if (sharedEllipsisTarget === ellipsisTarget && ellipsisTarget.isConnected) {
        showEllipsisTip(ellipsisTarget);
      }
    }, 160);
  });

  container.addEventListener('pointermove', (event) => {
    const scatterStage = event.target?.closest?.('.fund-vis-scatter .fund-vis-stage');
    if (!scatterStage) return;
    const svg = scatterStage.querySelector('.fund-vis-svg');
    const rect = svg?.getBoundingClientRect?.();
    if (!svg || !rect || rect.width <= 0 || rect.height <= 0) return;
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    const vbW = vb[2] > 0 ? vb[2] : 560;
    const vbH = vb[3] > 0 ? vb[3] : 320;
    const vx = ((event.clientX - rect.left) / rect.width) * vbW;
    const vy = ((event.clientY - rect.top) / rect.height) * vbH;
    let nearest = null;
    let minDist = 18;
    for (const hit of svg.querySelectorAll('.fund-svg-scatter-hit')) {
      const cx = Number(hit.getAttribute('data-scatter-cx') || 0);
      const cy = Number(hit.getAttribute('data-scatter-cy') || 0);
      const d = Math.hypot(vx - cx, vy - cy);
      if (d <= minDist) { minDist = d; nearest = hit; }
    }
    if (nearest) showScatterPointTooltip(scatterStage, nearest);
    else clearStage(scatterStage);
  });

  container.addEventListener('pointerout', (event) => {
    const stage = event.target?.closest?.('.fund-vis-stage');
    if (stage && (!event.relatedTarget || !stage.contains(event.relatedTarget))) {
      clearStage(stage);
    }
    const donut = event.target?.closest?.('.fund-vis-donut');
    if (donut && (!event.relatedTarget || !donut.contains(event.relatedTarget))) {
      clearDonut(donut);
    }
    if (sharedEllipsisTarget) {
      const next = event.relatedTarget?.closest?.(ELLIPSIS_TARGET_SELECTOR);
      if (next !== sharedEllipsisTarget) hideEllipsisTip();
    }
  });

  container.addEventListener('scroll', hideEllipsisTip, { capture: true, passive: true });
  container.addEventListener('pointerdown', hideEllipsisTip, { capture: true });
  container.ownerDocument?.addEventListener?.('keydown', (event) => {
    if (event.key === 'Escape') hideEllipsisTip();
  });
}

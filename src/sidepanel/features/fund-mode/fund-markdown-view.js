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
const MAX_ITEMS = 16;
const MAX_KPI_ITEMS = 8;

const SKIP_TEXT_TAGS = new Set(['CODE', 'PRE', 'A', 'SVG', 'SCRIPT', 'STYLE', 'BUTTON', 'KBD']);
const SKIP_TEXT_ANCESTOR_SELECTOR = 'code, pre, a, svg, .katex, .fund-vis-card, .fund-kpi-card, .fund-metric, .fund-badge, .fund-risk-badge';

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
  };
  const type = ['line', 'bar', 'hbar', 'donut', 'gauge'].includes(rawType)
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
    let trend = ['up', 'down', 'flat', 'neutral', 'cold', 'cool', 'mid', 'warm', 'hot'].includes(explicitTrend)
      ? explicitTrend
      : (classifySignedMetric(value) || 'neutral');
    if (trend === 'neutral') {
      const valTone = VALUATION_TOKENS.find(t => value.includes(t.label))?.tone;
      if (valTone) trend = valTone;
    }
    items.push({ label, value, sub, trend });
  }
  if (!items.length) return null;

  return {
    title: Array.isArray(parsed) ? '' : clampString(parsed.title, 48),
    asOf: Array.isArray(parsed) ? '' : clampString(parsed.asOf || parsed.subtitle || parsed.date, 48),
    items,
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

  // X ticks (auto-thin to <= 6 labels)
  const maxXLabels = Math.min(6, spec.labels.length);
  const stepX = spec.labels.length <= maxXLabels ? 1 : Math.ceil((spec.labels.length - 1) / (maxXLabels - 1));
  const xIndices = new Set([0, spec.labels.length - 1]);
  for (let i = 0; i < spec.labels.length; i += stepX) xIndices.add(i);
  for (const i of [...xIndices].sort((a, b) => a - b)) {
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
  const pad = { top: 22, right: 16, bottom: 32, left: 48 };
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

  const groupCount = spec.labels.length;
  const seriesCount = spec.series.length;
  const slotW = plotW / Math.max(1, groupCount);
  const groupPad = Math.min(18, slotW * 0.22);
  const innerW = Math.max(10, slotW - groupPad);
  const barGap = seriesCount > 1 ? 3 : 0;
  const barW = Math.min(40, Math.max(6, (innerW - barGap * (seriesCount - 1)) / seriesCount));
  const totalBarsW = barW * seriesCount + barGap * (seriesCount - 1);
  const showDirectLabels = seriesCount === 1 ? groupCount <= 7 : groupCount <= 2;
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
        const textY = val >= 0 ? Math.max(pad.top - 4, y - 5) : Math.min(H - pad.bottom + 12, y + h + 12);
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

function buildStreamingSkeleton(doc, kind) {
  const box = doc.createElement('div');
  box.className = `fund-vis-skeleton fund-vis-skeleton-${kind}`;
  box.dataset.fundDecoration = 'true';
  box.setAttribute('aria-label', kind === 'kpi' ? '正在整理核心指标卡' : '正在绘制基金数据图表');
  const label = doc.createElement('span');
  label.className = 'fund-vis-skeleton-label';
  label.textContent = kind === 'kpi' ? '正在整理核心指标卡…' : '正在绘制基金数据图表…';
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
      cells.forEach((cell, colIdx) => {
        const raw = (cell.textContent || '').trim();
        if (!raw || raw === '-' || raw === '—' || raw === '--' || raw === 'N/A') return;
        colNonEmptyCounts[colIdx]++;
        if (NUMERIC_CELL_RE.test(raw)) colNumericCounts[colIdx]++;

        // Pure signed % cell (keeps backward compatibility with .fund-pct-up/.fund-pct-down)
        const dir = classifySignedMetric(raw);
        if (dir === 'up') cell.classList.add('fund-pct-up');
        else if (dir === 'down') cell.classList.add('fund-pct-down');
        else if (dir === 'flat') cell.classList.add('fund-pct-flat');

        // Valuation rating badge in table cell (only when cell has no complex child markup)
        if (!cell.children.length) {
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
    }
  }
}

function enhanceStructuredFences(root, { streaming = false } = {}) {
  const doc = root.ownerDocument || globalThis.document;
  for (const code of [...root.querySelectorAll('pre > code')]) {
    const cls = code.className || '';
    const isChart = /\blanguage-fund-chart\b/i.test(cls);
    const isKpi = /\blanguage-fund-kpi\b/i.test(cls);
    if (!isChart && !isKpi) continue;

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

    const spec = parseFundChartSpec(raw);
    if (spec) {
      let card = null;
      if (spec.type === 'line') card = buildLineChart(doc, spec);
      else if (spec.type === 'bar') card = buildBarChart(doc, spec);
      else if (spec.type === 'hbar') card = buildHbarChart(doc, spec);
      else if (spec.type === 'donut') card = buildDonutChart(doc, spec);
      else if (spec.type === 'gauge') card = buildGaugeChart(doc, spec);
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
  return null;
}

function synthesizeChartsFromTables(root) {
  if (root.querySelector('.fund-vis-card')) return;
  const doc = root.ownerDocument || globalThis.document;
  let created = 0;
  for (const table of [...root.querySelectorAll('table')]) {
    if (created >= 2) break;
    const spec = inferChartSpecFromTable(table);
    const card = renderChartSpec(doc, spec);
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
export function enhanceFundMarkdown(root, { streaming = false } = {}) {
  if (!root?.querySelectorAll) return;
  enhanceStructuredFences(root, { streaming });
  if (!streaming) synthesizeChartsFromTables(root);
  enhanceTables(root);
  enhanceBlockquotes(root);
  enhanceInlineSignedMetrics(root);
}

/* ==================== Lightweight Delegated Chart Interactivity ==================== */

const boundContainers = new WeakSet();

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
    }
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
  });
}

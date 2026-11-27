/**
 * Normalized chart specification parser, validator, height heuristic, and
 * plain-text serializer shared by live ECharts rendering, copy-text, and export.
 *
 * Pure ES module with zero DOM or ECharts dependencies so prompt layers,
 * exporters, and unit tests stay lightweight.
 */

export const CHART_TYPES = Object.freeze([
  'line',
  'bar',
  'hbar',
  'donut',
  'scatter',
  'gauge',
  'radar',
  'heatmap',
  'sankey',
  'treemap',
]);

const CHART_TYPE_SET = new Set(CHART_TYPES);

const TYPE_ALIASES = Object.freeze({
  area: 'line',
  nav: 'line',
  column: 'bar',
  stackedbar: 'bar',
  'stacked-bar': 'bar',
  horizontalbar: 'hbar',
  'horizontal-bar': 'hbar',
  pie: 'donut',
  ring: 'donut',
  allocation: 'donut',
  temperature: 'gauge',
  meter: 'gauge',
  quadrant: 'scatter',
  bubble: 'scatter',
  spider: 'radar',
  matrix: 'heatmap',
  'calendar-matrix': 'heatmap',
  flow: 'sankey',
  hierarchy: 'treemap',
});

const CHART_KIND_LABELS = Object.freeze({
  line: '折线图',
  bar: '柱状图',
  hbar: '条形图',
  donut: '环形图',
  scatter: '散点图',
  gauge: '仪表盘',
  radar: '雷达图',
  heatmap: '热力图',
  sankey: '桑基图',
  treemap: '树图',
});

const VALID_SCATTER_SHAPES = new Set(['circle', 'diamond', 'hollow', 'hollow-diamond', 'square']);
const MAX_SERIES = 6;
const MAX_POINTS = 60;
const MAX_SCATTER_POINTS = 120;
const MAX_ITEMS = 16;
const MAX_GAUGE_ITEMS = 4;
const MAX_RADAR_INDICATORS = 10;
const MAX_RADAR_SERIES = 5;
const MAX_HEATMAP_X = 24;
const MAX_HEATMAP_Y = 20;
const MAX_SANKEY_LINKS = 48;
const MAX_SANKEY_NODES = 32;
const MAX_TREEMAP_DEPTH = 3;
const MAX_TREEMAP_NODES = 48;

function clampString(value, maxLen = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

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

function tryParseSpecJson(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

function inferPctUnit(title, subtitle, items) {
  if (/%|％|占比|权重|比例|收益|回撤|配置|持仓|超额|贡献|胜率/.test(`${title} ${subtitle}`)) {
    return '%';
  }
  if (Array.isArray(items) && items.some(entry => typeof entry?.value === 'string' && /[%％]/.test(entry.value))) {
    return '%';
  }
  return '';
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

/** Format a numeric value with optional unit and explicit +/- sign for signed series. */
export function formatChartValue(value, { unit = '', signed = false, decimals } = {}) {
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

/** Human-readable Chinese label for a chart type or donut/pie variant. */
export function chartKindLabel(specOrType) {
  if (specOrType && typeof specOrType === 'object') {
    if (specOrType.type === 'donut' && specOrType.pie) return '饼图';
    if (specOrType.type === 'line' && specOrType.series?.some(s => s.area)) return '面积图';
    return CHART_KIND_LABELS[specOrType.type] || '图表';
  }
  return CHART_KIND_LABELS[String(specOrType || '').toLowerCase()] || '图表';
}

/** Compute responsive column count for multi-dial gauges across narrow/wide viewports. */
export function gaugeGridColumns(count, width = 560) {
  const w = Number(width) || 560;
  if (count <= 1) return 1;
  if (count === 2) return w < 300 ? 1 : 2;
  if (count === 3) return w >= 480 ? 3 : (w >= 290 ? 2 : 1);
  return w < 300 ? 1 : 2;
}

/** Estimate whether a category chart has too many labels for the current viewport width. */
export function shouldEnableDataZoom(spec, width = 560) {
  if (!spec || typeof spec !== 'object') return false;
  const safeW = Math.max(220, Number(width) || 560);
  const plotWidth = Math.max(160, safeW - 68);
  if (spec.type === 'line' || spec.type === 'bar') {
    const labels = Array.isArray(spec.labels) ? spec.labels : [];
    if (labels.length <= 6) return false;
    let maxUnits = 0;
    for (const label of labels) {
      let units = 0;
      for (const ch of String(label ?? '')) units += ch.charCodeAt(0) > 0x7f ? 2 : 1;
      if (units > maxUnits) maxUnits = units;
    }
    const minSlot = spec.type === 'bar' ? 46 : 42;
    const estSlot = Math.max(minSlot, Math.min(80, maxUnits * 4.4 + 14));
    return labels.length > 10 || labels.length * estSlot > plotWidth * 1.1;
  }
  if (spec.type === 'heatmap') {
    const xLabels = Array.isArray(spec.xLabels) ? spec.xLabels : [];
    return xLabels.length > 10 || (xLabels.length > 6 && xLabels.length * 44 > plotWidth);
  }
  return false;
}

/** Recommended ECharts stage pixel height tuned per chart type, density, and container width. */
export function recommendedChartHeight(spec, width = 560) {
  if (!spec || typeof spec !== 'object') return 260;
  const w = Number(width) || 560;
  const zoomPad = shouldEnableDataZoom(spec, w) ? 44 : 0;
  switch (spec.type) {
    case 'hbar': {
      const count = spec.items?.length || 4;
      return Math.max(196, Math.min(440, 56 + count * 32));
    }
    case 'donut':
      return w < 380 ? 250 : 276;
    case 'gauge': {
      const count = spec.items?.length || 1;
      const cols = gaugeGridColumns(count, w);
      const rows = Math.ceil(count / cols);
      const rowHeight = cols === 1 ? 182 : 168;
      return rows * rowHeight + 10;
    }
    case 'scatter':
      return (spec.totalPoints || 0) >= 6 ? 336 : 292;
    case 'radar':
      return 300;
    case 'heatmap': {
      const rows = spec.yLabels?.length || 4;
      return Math.max(230, Math.min(440, 108 + rows * 28)) + zoomPad;
    }
    case 'sankey': {
      const nodes = spec.nodes?.length || 6;
      return Math.max(250, Math.min(440, 110 + nodes * 18));
    }
    case 'treemap':
      return 296;
    case 'line':
    case 'bar':
    default: {
      const seriesCount = spec.series?.length || 1;
      return (seriesCount > 1 ? 268 : 244) + zoomPad;
    }
  }
}

function parseDonutOrHbarSpec(type, rawType, parsed, { title, subtitle, source, unitExplicit, unit }) {
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
    items.push({
      label,
      value,
      note: clampString(entry.note ?? entry.sub ?? entry.level ?? entry.rating, 28),
      tone: clampString(entry.tone, 12),
    });
  }
  if (!items.length) return null;

  const inferredUnit = unitExplicit
    ? unit
    : type === 'donut'
      ? '%'
      : inferPctUnit(title, subtitle, rawItems);
  const hasNegative = items.some(item => item.value < 0);
  const hasPositive = items.some(item => item.value > 0);
  const colorBySign = parsed.colorBySign !== undefined
    ? Boolean(parsed.colorBySign)
    : (type === 'hbar' && hasNegative);

  return {
    type,
    title,
    subtitle,
    source,
    unit: inferredUnit,
    colorBySign,
    hasNegative,
    hasPositive,
    ...(type === 'donut' ? {
      pie: rawType === 'pie' && parsed.donut !== true,
      centerLabel: clampString(parsed.centerLabel || parsed.totalLabel, 24),
      centerValue: clampString(parsed.centerValue, 24),
    } : {}),
    items,
  };
}

function parseGaugeSpec(parsed, { title, subtitle, source, unitExplicit, unit }) {
  const rawItems = Array.isArray(parsed.items)
    ? parsed.items
    : Array.isArray(parsed.data)
      ? parsed.data
      : (parsed.value !== undefined ? [{ label: title || parsed.label || '指标', value: parsed.value, note: parsed.note, tone: parsed.tone }] : null);
  if (!Array.isArray(rawItems) || !rawItems.length) return null;

  const rawMin = parseNumericValue(parsed.min);
  const rawMax = parseNumericValue(parsed.max);
  const min = rawMin !== null ? rawMin : 0;
  const max = rawMax !== null && rawMax > min ? rawMax : (min < 100 ? 100 : min + 100);

  const items = [];
  for (const entry of rawItems.slice(0, MAX_GAUGE_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const label = clampString(entry.label ?? entry.name ?? entry.title, 36);
    const value = parseNumericValue(entry.value ?? entry.pct ?? entry.score);
    if (!label || value === null) continue;
    const clampedValue = Math.max(min, Math.min(max, value));
    const normPct = ((clampedValue - min) / (max - min)) * 100;
    items.push({
      label,
      value: clampedValue,
      note: clampString(entry.note ?? entry.sub ?? entry.level ?? entry.rating, 28),
      tone: gaugeToneForValue(normPct, entry.tone),
    });
  }
  if (!items.length) return null;

  const inferredUnit = unitExplicit ? unit : (min === 0 && max === 100 ? '°' : '');
  return {
    type: 'gauge',
    title,
    subtitle,
    source,
    min,
    max,
    unit: inferredUnit,
    items,
  };
}

function parseScatterSpec(parsed, { title, subtitle, source }) {
  const xLabel = clampString(parsed.xLabel || parsed.xTitle || 'X 轴', 32);
  const yLabel = clampString(parsed.yLabel || parsed.yTitle || 'Y 轴', 32);
  const inferAxisUnit = (label, explicit) => clampString(
    explicit ?? (/%|％|收益|回撤|波动|超额|胜率/.test(label) ? '%' : ''),
    10,
  );
  const xUnit = inferAxisUnit(xLabel, parsed.xUnit);
  const yUnit = inferAxisUnit(yLabel, parsed.yUnit);
  const sizeUnit = clampString(parsed.sizeUnit ?? '', 10);
  const sizeLabel = clampString(parsed.sizeLabel || '', 24);
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

  const series = [];
  let totalPoints = 0;
  let hasSize = false;
  const sizes = [];

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
      const rawSize = parseNumericValue(pt.size ?? pt.r ?? pt.weight);
      const size = rawSize !== null && rawSize > 0 ? rawSize : null;
      if (size !== null) {
        hasSize = true;
        sizes.push(size);
      }
      points.push({
        x,
        y,
        ...(size !== null ? { size } : {}),
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
      shape: VALID_SCATTER_SHAPES.has(rawShape) ? rawShape : 'circle',
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
    type: 'scatter',
    title,
    subtitle,
    source,
    xLabel,
    yLabel,
    xUnit,
    yUnit,
    ...(hasSize ? {
      hasSize: true,
      sizeLabel,
      sizeUnit,
      sizeMin: Math.min(...sizes),
      sizeMax: Math.max(...sizes),
    } : { hasSize: false }),
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

function parseLineOrBarSpec(type, rawType, parsed, { title, subtitle, source, unitExplicit, unit }) {
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

  const globalStack = type === 'bar' && (parsed.stack === true || rawType === 'stacked-bar' || rawType === 'stackedbar');
  const globalArea = type === 'line' && (parsed.area === true || rawType === 'area');
  const globalSmooth = type === 'line' && parsed.smooth === true;

  const series = [];
  for (const entry of rawSeries.slice(0, MAX_SERIES)) {
    if (!entry || typeof entry !== 'object') continue;
    const rawVals = Array.isArray(entry.values) ? entry.values : Array.isArray(entry.data) ? entry.data : null;
    if (!rawVals || !rawVals.length) continue;
    const values = labels.map((_, idx) => parseNumericValue(rawVals[idx]));
    if (!values.some(v => v !== null)) continue;

    if (type === 'line') {
      const yAxisIndex = (entry.yAxisIndex === 1 || entry.axis === 'right' || entry.yAxis === 'right') ? 1 : 0;
      const area = entry.area !== undefined ? Boolean(entry.area) : globalArea;
      const smooth = entry.smooth !== undefined ? Boolean(entry.smooth) : globalSmooth;
      series.push({
        name: clampString(entry.name || entry.label || `系列 ${series.length + 1}`, 32),
        values,
        dashed: entry.dashed === true || entry.benchmark === true,
        area,
        smooth,
        yAxisIndex,
      });
    } else {
      const stack = typeof entry.stack === 'string' && entry.stack.trim()
        ? clampString(entry.stack, 24)
        : (entry.stack === true || globalStack ? 'total' : '');
      series.push({
        name: clampString(entry.name || entry.label || `系列 ${series.length + 1}`, 32),
        values,
        ...(stack ? { stack } : {}),
      });
    }
  }
  if (!series.length) return null;

  const allValues = series.flatMap(s => s.values).filter(v => v !== null);
  if (!allValues.length) return null;
  if (type === 'line' && labels.length < 2) return null;

  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const hasNegative = minVal < 0;
  const hasPositive = maxVal > 0;
  const inferredUnit = unitExplicit
    ? unit
    : (/%|％|收益|回撤|涨跌|超额|回报/.test(`${title} ${subtitle}`) ? '%' : '');
  const hasStack = type === 'bar' && series.some(s => s.stack);
  const colorBySign = parsed.colorBySign !== undefined
    ? Boolean(parsed.colorBySign)
    : (type === 'bar' && !hasStack && series.length === 1 && (hasNegative || inferredUnit === '%'));

  return {
    type,
    title,
    subtitle,
    source,
    unit: inferredUnit,
    ...(type === 'line' ? {
      yLabel: clampString(parsed.yLabel || parsed.yAxisLabel || '', 28),
      y2Label: clampString(parsed.y2Label || '', 28),
      y2Unit: clampString(parsed.y2Unit ?? '', 12),
    } : {}),
    ...(type === 'bar' && hasStack ? { stack: true } : {}),
    colorBySign,
    hasNegative,
    hasPositive,
    minVal,
    maxVal,
    labels,
    series,
  };
}

function parseRadarSpec(parsed, { title, subtitle, source, unitExplicit, unit }) {
  const rawIndicators = Array.isArray(parsed.indicators)
    ? parsed.indicators
    : Array.isArray(parsed.labels)
      ? parsed.labels
      : null;
  const rawSeries = Array.isArray(parsed.series) ? parsed.series : null;
  if (!Array.isArray(rawIndicators) || rawIndicators.length < 3 || !Array.isArray(rawSeries) || !rawSeries.length) {
    return null;
  }

  const prelimIndicators = [];
  for (const entry of rawIndicators.slice(0, MAX_RADAR_INDICATORS)) {
    if (typeof entry === 'string') {
      const name = clampString(entry, 24);
      if (name) prelimIndicators.push({ name, max: null, min: 0 });
    } else if (entry && typeof entry === 'object') {
      const name = clampString(entry.name ?? entry.label ?? entry.title, 24);
      if (!name) continue;
      const rawMax = parseNumericValue(entry.max);
      const rawMin = parseNumericValue(entry.min);
      prelimIndicators.push({
        name,
        max: rawMax !== null ? rawMax : null,
        min: rawMin !== null ? rawMin : 0,
      });
    }
  }
  if (prelimIndicators.length < 3) return null;

  const series = [];
  for (const entry of rawSeries.slice(0, MAX_RADAR_SERIES)) {
    if (!entry || typeof entry !== 'object') continue;
    const rawVals = Array.isArray(entry.values) ? entry.values : Array.isArray(entry.data) ? entry.data : null;
    if (!rawVals || !rawVals.length) continue;
    const values = prelimIndicators.map((ind, idx) => {
      const num = parseNumericValue(rawVals[idx]);
      return num !== null ? num : ind.min;
    });
    series.push({
      name: clampString(entry.name || entry.label || `系列 ${series.length + 1}`, 28),
      values,
    });
  }
  if (!series.length) return null;

  const indicators = prelimIndicators.map((ind, idx) => {
    const colVals = series.map(s => s.values[idx]);
    const dataMin = Math.min(...colVals);
    const dataMax = Math.max(...colVals);
    const min = Math.min(ind.min, dataMin);
    let max = ind.max;
    if (max === null || max <= min) {
      if (dataMax <= 0) {
        max = min + 100;
      } else if ((unit === '%' || inferPctUnit(title, subtitle) === '%') && dataMax <= 100) {
        max = 100;
      } else if (dataMax <= 10 && dataMax > 5) {
        max = 10;
      } else {
        max = Math.ceil(dataMax * 1.15);
      }
      if (max <= min) max = min + 10;
    }
    return { name: ind.name, min, max };
  });

  return {
    type: 'radar',
    title,
    subtitle,
    source,
    unit: unitExplicit ? unit : '',
    indicators,
    series,
  };
}

function parseHeatmapSpec(parsed, { title, subtitle, source, unitExplicit, unit }) {
  const xLabels = Array.isArray(parsed.xLabels || parsed.cols || parsed.xAxis)
    ? (parsed.xLabels || parsed.cols || parsed.xAxis).map(v => clampString(v, 20)).filter(Boolean).slice(0, MAX_HEATMAP_X)
    : [];
  const yLabels = Array.isArray(parsed.yLabels || parsed.rows || parsed.yAxis)
    ? (parsed.yLabels || parsed.rows || parsed.yAxis).map(v => clampString(v, 20)).filter(Boolean).slice(0, MAX_HEATMAP_Y)
    : [];
  if (!xLabels.length || !yLabels.length) return null;

  const rawGrid = Array.isArray(parsed.cells)
    ? parsed.cells
    : Array.isArray(parsed.data)
      ? parsed.data
      : Array.isArray(parsed.values)
        ? parsed.values
        : Array.isArray(parsed.matrix)
          ? parsed.matrix
          : null;
  if (!Array.isArray(rawGrid) || !rawGrid.length) return null;

  const cells = [];
  const finiteVals = [];
  const isMatrixRows = rawGrid.some((row, idx) =>
    idx < yLabels.length && Array.isArray(row) && (
      row.length !== 3
      || (row.length === xLabels.length && xLabels.length === 3 && (parseNumericValue(row[0]) ?? 99) >= 0 && typeof parsed.cells === 'undefined' && Array.isArray(parsed.matrix))
    ));

  if (Array.isArray(parsed.matrix) || (isMatrixRows && rawGrid.length === yLabels.length && rawGrid.every(r => Array.isArray(r) && r.length === xLabels.length && xLabels.length !== 3))) {
    for (let yi = 0; yi < Math.min(rawGrid.length, yLabels.length); yi++) {
      const row = rawGrid[yi];
      if (!Array.isArray(row)) continue;
      for (let xi = 0; xi < Math.min(row.length, xLabels.length); xi++) {
        const val = parseNumericValue(row[xi]);
        if (val === null) continue;
        cells.push([xi, yi, val]);
        finiteVals.push(val);
      }
    }
  } else {
    for (const entry of rawGrid) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const rawX = entry[0];
      const rawY = entry[1];
      const xi = typeof rawX === 'number' && Number.isInteger(rawX)
        ? rawX
        : xLabels.indexOf(clampString(rawX, 20));
      const yi = typeof rawY === 'number' && Number.isInteger(rawY)
        ? rawY
        : yLabels.indexOf(clampString(rawY, 20));
      if (xi < 0 || xi >= xLabels.length || yi < 0 || yi >= yLabels.length) continue;
      const val = parseNumericValue(entry[2]);
      if (val === null) continue;
      cells.push([xi, yi, val]);
      finiteVals.push(val);
    }
  }

  if (!cells.length) return null;
  const min = Math.min(...finiteVals);
  const max = Math.max(...finiteVals);
  const inferredUnit = unitExplicit ? unit : inferPctUnit(title, subtitle);
  const colorBySign = parsed.colorBySign !== undefined
    ? Boolean(parsed.colorBySign)
    : (min < 0 && max > 0);

  return {
    type: 'heatmap',
    title,
    subtitle,
    source,
    unit: inferredUnit,
    colorBySign,
    min,
    max,
    xLabels,
    yLabels,
    cells,
  };
}

function canReach(adj, from, goal) {
  if (from === goal) return true;
  const visited = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop();
    const nexts = adj.get(cur);
    if (!nexts) continue;
    for (const next of nexts) {
      if (next === goal) return true;
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

function parseSankeySpec(parsed, { title, subtitle, source, unitExplicit, unit }) {
  const rawLinks = Array.isArray(parsed.links) ? parsed.links : Array.isArray(parsed.edges) ? parsed.edges : null;
  if (!Array.isArray(rawLinks) || !rawLinks.length) return null;

  const explicitNodes = new Map();
  if (Array.isArray(parsed.nodes)) {
    for (const entry of parsed.nodes.slice(0, MAX_SANKEY_NODES)) {
      if (typeof entry === 'string') {
        const name = clampString(entry, 28);
        if (name && !explicitNodes.has(name)) explicitNodes.set(name, { name });
      } else if (entry && typeof entry === 'object') {
        const name = clampString(entry.name ?? entry.label ?? entry.id, 28);
        if (name && !explicitNodes.has(name)) {
          explicitNodes.set(name, {
            name,
            ...(Number.isInteger(entry.depth) && entry.depth >= 0 ? { depth: entry.depth } : {}),
          });
        }
      }
    }
  }

  const adj = new Map();
  const links = [];
  const usedNodes = new Map();

  const registerNode = (name) => {
    if (usedNodes.has(name)) return true;
    if (usedNodes.size >= MAX_SANKEY_NODES) return false;
    usedNodes.set(name, explicitNodes.get(name) || { name });
    return true;
  };

  for (const entry of rawLinks) {
    if (links.length >= MAX_SANKEY_LINKS) break;
    if (!entry || typeof entry !== 'object') continue;
    const s = clampString(entry.source ?? entry.from, 28);
    const t = clampString(entry.target ?? entry.to, 28);
    const value = parseNumericValue(entry.value ?? entry.weight ?? entry.amount);
    if (!s || !t || s === t || value === null || value <= 0) continue;
    // Reject links whose addition would introduce a directed cycle (ECharts Sankey requires a DAG).
    if (canReach(adj, t, s)) continue;
    if (!usedNodes.has(s) && usedNodes.size + (usedNodes.has(t) ? 0 : 1) + 1 > MAX_SANKEY_NODES) continue;
    if (!registerNode(s) || !registerNode(t)) continue;
    if (!adj.has(s)) adj.set(s, new Set());
    adj.get(s).add(t);
    links.push({ source: s, target: t, value });
  }

  if (!links.length) return null;

  return {
    type: 'sankey',
    title,
    subtitle,
    source,
    unit: unitExplicit ? unit : '',
    nodes: [...usedNodes.values()],
    links,
  };
}

function parseTreemapSpec(parsed, { title, subtitle, source, unitExplicit, unit }) {
  const rawRoot = Array.isArray(parsed.items)
    ? parsed.items
    : Array.isArray(parsed.data)
      ? parsed.data
      : Array.isArray(parsed.children)
        ? parsed.children
        : null;
  if (!Array.isArray(rawRoot) || !rawRoot.length) return null;

  let nodeCount = 0;

  function walk(list, depth) {
    if (!Array.isArray(list) || depth > MAX_TREEMAP_DEPTH) return [];
    const out = [];
    for (const entry of list) {
      if (nodeCount >= MAX_TREEMAP_NODES) break;
      if (!entry || typeof entry !== 'object') continue;
      const name = clampString(entry.name ?? entry.label ?? entry.title, 36);
      if (!name) continue;
      const note = clampString(entry.note ?? entry.sub ?? entry.desc, 36);
      const rawChildren = Array.isArray(entry.children) && depth < MAX_TREEMAP_DEPTH ? entry.children : null;
      const children = rawChildren ? walk(rawChildren, depth + 1) : [];
      const explicitValue = parseNumericValue(entry.value ?? entry.weight ?? entry.size);
      if (children.length > 0) {
        if (nodeCount >= MAX_TREEMAP_NODES) break;
        nodeCount++;
        const childSum = children.reduce((sum, c) => sum + c.value, 0);
        const value = explicitValue !== null && explicitValue > 0 ? explicitValue : childSum;
        out.push({ name, value, ...(note ? { note } : {}), children });
      } else if (explicitValue !== null && explicitValue > 0) {
        nodeCount++;
        out.push({ name, value: explicitValue, ...(note ? { note } : {}) });
      }
    }
    return out;
  }

  const items = walk(rawRoot, 1);
  if (!items.length) return null;

  return {
    type: 'treemap',
    title,
    subtitle,
    source,
    unit: unitExplicit ? unit : inferPctUnit(title, subtitle, rawRoot),
    items,
  };
}

/**
 * Validate and normalize a `chart` or `fund-chart` JSON specification across all 10 types.
 * Returns null if the JSON is malformed or missing minimum required data.
 */
export function parseChartSpec(rawText) {
  const parsed = typeof rawText === 'string' ? tryParseSpecJson(rawText) : rawText;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const rawType = String(parsed.type || '').trim().toLowerCase();
  const type = CHART_TYPE_SET.has(rawType) ? rawType : TYPE_ALIASES[rawType] || '';
  if (!type) return null;

  const meta = {
    title: clampString(parsed.title, 72),
    subtitle: clampString(parsed.subtitle || parsed.asOf || parsed.period, 96),
    source: clampString(parsed.source, 48),
    unitExplicit: parsed.unit !== undefined && parsed.unit !== null,
    unit: clampString(parsed.unit ?? '', 12),
  };

  if (type === 'donut' || type === 'hbar') return parseDonutOrHbarSpec(type, rawType, parsed, meta);
  if (type === 'gauge') return parseGaugeSpec(parsed, meta);
  if (type === 'scatter') return parseScatterSpec(parsed, meta);
  if (type === 'radar') return parseRadarSpec(parsed, meta);
  if (type === 'heatmap') return parseHeatmapSpec(parsed, meta);
  if (type === 'sankey') return parseSankeySpec(parsed, meta);
  if (type === 'treemap') return parseTreemapSpec(parsed, meta);
  return parseLineOrBarSpec(type, rawType, parsed, meta);
}

function flattenTreemapLines(items, unit, depth = 0) {
  const lines = [];
  const indent = depth > 0 ? '  '.repeat(depth) : '';
  for (const item of items) {
    lines.push(`${indent}${item.name}：${formatChartValue(item.value, { unit })}${item.note ? `（${item.note}）` : ''}`);
    if (item.children?.length) {
      lines.push(...flattenTreemapLines(item.children, unit, depth + 1));
    }
  }
  return lines;
}

/** Convert a normalized chart spec into concise readable Chinese plain text for clipboard/export preview. */
export function formatChartSpecPlainText(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const head = [spec.title, spec.subtitle].filter(Boolean).join(' · ');

  let rows = [];
  if (spec.type === 'scatter') {
    for (const s of spec.series) {
      for (const pt of s.points) {
        const xText = formatChartValue(pt.x, { unit: spec.xUnit, signed: spec.xMin < 0 && spec.xUnit === '%' });
        const yText = formatChartValue(pt.y, { unit: spec.yUnit, signed: spec.yMin < 0 && spec.yUnit === '%' });
        const sizeText = pt.size !== undefined ? `，${spec.sizeLabel || '规模'}=${formatChartValue(pt.size, { unit: spec.sizeUnit })}` : '';
        rows.push(`${s.name}${pt.label ? ` · ${pt.label}` : ''}：${spec.xLabel}=${xText}，${spec.yLabel}=${yText}${sizeText}${pt.note ? `（${pt.note}）` : ''}`);
      }
    }
  } else if (spec.type === 'radar') {
    rows = spec.series.map(s => {
      const pairs = spec.indicators.map((ind, idx) =>
        `${ind.name} ${formatChartValue(s.values[idx], { unit: spec.unit })}`).join('，');
      return `${s.name}：${pairs}`;
    });
  } else if (spec.type === 'heatmap') {
    rows = spec.cells.map(([xi, yi, val]) =>
      `${spec.yLabels[yi]} · ${spec.xLabels[xi]}：${formatChartValue(val, { unit: spec.unit, signed: spec.colorBySign })}`);
  } else if (spec.type === 'sankey') {
    rows = spec.links.map(link =>
      `${link.source} → ${link.target}：${formatChartValue(link.value, { unit: spec.unit })}`);
  } else if (spec.type === 'treemap') {
    rows = flattenTreemapLines(spec.items, spec.unit);
  } else if (spec.items) {
    rows = spec.items.map(item =>
      `${item.label}：${formatChartValue(item.value, { unit: spec.unit, signed: Boolean(spec.colorBySign || spec.hasNegative) })}${item.note ? `（${item.note}）` : ''}`);
  } else if (spec.labels && spec.series) {
    rows = spec.labels.map((label, idx) => {
      const vals = spec.series
        .map(s => {
          if (s.values[idx] === null) return null;
          const sUnit = s.yAxisIndex === 1 && spec.y2Unit ? spec.y2Unit : spec.unit;
          return `${spec.series.length > 1 ? `${s.name} ` : ''}${formatChartValue(s.values[idx], { unit: sUnit, signed: Boolean(spec.colorBySign || spec.hasNegative || sUnit === '%') })}`;
        })
        .filter(Boolean)
        .join(' / ');
      return `${label}：${vals}`;
    });
  }

  if (!rows.length) return head || null;
  return head ? `${head}\n${rows.join('\n')}` : rows.join('\n');
}

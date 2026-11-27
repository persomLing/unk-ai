/**
 * Pure Paper & Ink palette resolver and ECharts option builder for all 10 chart types.
 * Zero ECharts runtime dependency so unit tests and SSR callers can inspect options cleanly.
 */

import { formatChartValue, gaugeGridColumns, shouldEnableDataZoom } from './chart-spec.js';

const COLOR_LITERAL_RE = /^(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i;
const CHART_FONT_FALLBACK = '"Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const CHART_MONO_FALLBACK = '"Cascadia Mono", Consolas, ui-monospace, monospace';

export const EXPORT_CHART_PALETTE = Object.freeze({
  themeKey: 'export-light',
  dark: false,
  ink: '#24332c',
  inkSecondary: '#44534a',
  muted: '#69766e',
  surface: '#ffffff',
  surfaceAlt: '#f3f6f3',
  tooltipBg: '#ffffff',
  line: '#dfe6df',
  lineStrong: '#c7d3ca',
  grid: 'rgba(29, 35, 40, 0.085)',
  teal: '#20685d',
  tealSoft: 'rgba(32, 104, 93, 0.14)',
  up: '#c43b31',
  down: '#1e7a52',
  flat: '#6c757d',
  cold: '#1e7a52',
  cool: '#2f6f8f',
  mid: '#9c6621',
  warm: '#b85c22',
  hot: '#c43b31',
  fontFamily: CHART_FONT_FALLBACK,
  monoFont: CHART_MONO_FALLBACK,
  series: Object.freeze(['#2d6a58', '#c46d2d', '#3b6f9c', '#8b5a96', '#b84552', '#5d8736']),
});

export const DEFAULT_DARK_PALETTE = Object.freeze({
  themeKey: 'dark-default',
  dark: true,
  ink: '#eceff2',
  inkSecondary: '#bec5cc',
  muted: '#8f98a2',
  surface: '#1e2024',
  surfaceAlt: '#141619',
  tooltipBg: '#24272c',
  line: 'rgba(255, 255, 255, 0.10)',
  lineStrong: 'rgba(255, 255, 255, 0.18)',
  grid: 'rgba(255, 255, 255, 0.09)',
  teal: '#6ec2a8',
  tealSoft: 'rgba(110, 194, 168, 0.18)',
  up: '#f07c73',
  down: '#5cc993',
  flat: '#959fa9',
  cold: '#5cc993',
  cool: '#7ab8d9',
  mid: '#e2b46e',
  warm: '#e89662',
  hot: '#f07c73',
  fontFamily: CHART_FONT_FALLBACK,
  monoFont: CHART_MONO_FALLBACK,
  series: Object.freeze(['#6ec2a8', '#e6a96a', '#7cb4e2', '#bd96d4', '#eb7d88', '#9bc96d']),
});

function pickCssColor(cs, varName, fallback) {
  const val = cs?.getPropertyValue?.(varName)?.trim();
  if (!val || !COLOR_LITERAL_RE.test(val)) return fallback;
  return val;
}

function pickCssFont(cs, varName, fallback) {
  const val = cs?.getPropertyValue?.(varName)?.trim();
  return val || fallback;
}

function colorWithAlpha(cssColor, alpha) {
  const clean = String(cssColor || '').trim();
  const hex = clean.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split('').map(c => c + c).join('')
      : hex[1];
    const r = Number.parseInt(raw.slice(0, 2), 16);
    const g = Number.parseInt(raw.slice(2, 4), 16);
    const b = Number.parseInt(raw.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = clean.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return clean;
}

/** Format axis ticks concisely so `-11%`, `-10.8%`, `17.5%` align cleanly without trailing `.00`. */
export function formatAxisTick(value, unit = '') {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const rounded = Math.abs(num) >= 100
    ? Number(num.toFixed(1))
    : Number(num.toFixed(2));
  const text = Object.is(rounded, -0) ? '0' : String(rounded);
  return `${text}${unit}`;
}

function clampLabelText(value, maxLen = 14) {
  const str = String(value ?? '').trim();
  if (!str || str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

function clampDisplayWidth(text, maxUnits) {
  const str = String(text ?? '').trim();
  if (!str) return '';
  let units = 0;
  let cut = '';
  for (const ch of str) {
    const w = ch.charCodeAt(0) > 0x7f ? 2 : 1;
    if (units + w > maxUnits) return `${cut}…`;
    units += w;
    cut += ch;
  }
  return str;
}

/** Resolve live Paper & Ink light/dark/accent CSS variables into concrete color literals for ECharts. */
export function resolveChartPalette(doc = globalThis.document, { exportMode = false } = {}) {
  if (exportMode || !doc?.documentElement) return EXPORT_CHART_PALETTE;
  const rootEl = doc.documentElement;
  const theme = rootEl.getAttribute?.('data-theme') || rootEl.dataset?.theme || 'light';
  const accent = rootEl.getAttribute?.('data-accent') || rootEl.dataset?.accent || 'forest';
  const isDark = theme === 'dark';
  const base = isDark ? DEFAULT_DARK_PALETTE : EXPORT_CHART_PALETTE;
  const cs = doc.defaultView?.getComputedStyle?.(rootEl);
  if (!cs) {
    return Object.freeze({ ...base, themeKey: `${theme}:${accent}:fallback` });
  }

  const teal = pickCssColor(cs, '--teal', base.teal);
  const surface = pickCssColor(cs, '--surface', base.surface);
  const surfaceCard = pickCssColor(cs, '--surface-card', base.tooltipBg);
  const series = [1, 2, 3, 4, 5, 6].map((idx) =>
    pickCssColor(cs, `--fund-chart-${idx}`, idx === 1 ? teal : base.series[idx - 1]));

  const palette = {
    dark: isDark,
    ink: pickCssColor(cs, '--ink', base.ink),
    inkSecondary: pickCssColor(cs, '--ink-secondary', base.inkSecondary),
    muted: pickCssColor(cs, '--muted', base.muted),
    surface,
    surfaceAlt: pickCssColor(cs, '--surface-alt', base.surfaceAlt),
    tooltipBg: isDark ? surfaceCard : surface,
    line: pickCssColor(cs, '--line', base.line),
    lineStrong: pickCssColor(cs, '--line-strong', base.lineStrong),
    grid: pickCssColor(cs, '--fund-chart-grid', base.grid),
    teal,
    tealSoft: colorWithAlpha(teal, isDark ? 0.2 : 0.14),
    up: pickCssColor(cs, '--fund-up', base.up),
    down: pickCssColor(cs, '--fund-down', base.down),
    flat: pickCssColor(cs, '--fund-flat', base.flat),
    cold: pickCssColor(cs, '--fund-cold', base.cold),
    cool: pickCssColor(cs, '--fund-cool', base.cool),
    mid: pickCssColor(cs, '--fund-mid', base.mid),
    warm: pickCssColor(cs, '--fund-warm', base.warm),
    hot: pickCssColor(cs, '--fund-hot', base.hot),
    fontFamily: pickCssFont(cs, '--interface-font', base.fontFamily),
    monoFont: pickCssFont(cs, '--folio-font', base.monoFont),
    series: Object.freeze(series),
  };
  palette.themeKey = `${theme}:${accent}:${teal}:${surface}:${series.join(',')}`;
  return Object.freeze(palette);
}

/** Escape arbitrary LLM-supplied text before embedding inside ECharts HTML tooltip markup. */
export function escapeTooltipHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linearGradient(topColor, bottomColor) {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: topColor },
      { offset: 1, color: bottomColor },
    ],
  };
}

function tooltipShell(palette) {
  return {
    confine: true,
    renderMode: 'html',
    backgroundColor: palette.tooltipBg,
    borderColor: palette.lineStrong,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: {
      color: palette.ink,
      fontFamily: palette.fontFamily,
      fontSize: 12,
    },
    extraCssText: 'border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.12);max-width:280px;white-space:normal;',
  };
}

function scatterSymbolSpec(_shape, color) {
  return { symbol: 'circle', itemStyle: { color } };
}

function buildCategoryDataZoom(palette, { bottom = 14, defaultEnd = 60 } = {}) {
  return [
    {
      type: 'inside',
      xAxisIndex: 0,
      start: 0,
      end: defaultEnd,
      filterMode: 'none',
      zoomOnMouseWheel: 'ctrl',
      moveOnMouseMove: true,
      moveOnMouseWheel: false,
    },
    {
      type: 'slider',
      xAxisIndex: 0,
      start: 0,
      end: defaultEnd,
      filterMode: 'none',
      height: 18,
      bottom,
      brushSelect: false,
      borderColor: palette.lineStrong,
      backgroundColor: colorWithAlpha(palette.surfaceAlt, 0.85),
      fillerColor: colorWithAlpha(palette.teal, palette.dark ? 0.24 : 0.16),
      handleSize: '100%',
      handleStyle: {
        color: palette.teal,
        borderColor: palette.surface,
        borderWidth: 1,
      },
      moveHandleSize: 4,
      moveHandleStyle: {
        color: colorWithAlpha(palette.teal, 0.55),
      },
      dataBackground: {
        lineStyle: { color: colorWithAlpha(palette.teal, 0.45), width: 1 },
        areaStyle: { color: colorWithAlpha(palette.teal, 0.12) },
      },
      selectedDataBackground: {
        lineStyle: { color: palette.teal, width: 1.2 },
        areaStyle: { color: colorWithAlpha(palette.teal, 0.22) },
      },
      textStyle: {
        color: palette.muted,
        fontFamily: palette.monoFont,
        fontSize: 9.5,
      },
    },
  ];
}

function computeLegendLayout(palette) {
  return {
    type: 'scroll',
    top: 6,
    left: 12,
    right: 16,
    itemWidth: 12,
    itemHeight: 8,
    itemGap: 14,
    pageIconSize: 12,
    pageButtonItemGap: 5,
    pageButtonGap: 8,
    pageIconColor: palette.teal,
    pageIconInactiveColor: palette.muted,
    pageTextStyle: { color: palette.muted, fontSize: 11 },
    textStyle: {
      color: palette.inkSecondary,
      fontFamily: palette.fontFamily,
      fontSize: 11,
    },
  };
}

function buildLineOption(spec, palette, { exportMode, width = 560 }) {
  const hasLegend = spec.series.length > 1;
  const hasY2 = spec.series.some(s => s.yAxisIndex === 1);
  const useZoom = !exportMode && shouldEnableDataZoom(spec, width);
  const unit0 = spec.unit || '';
  const unit1 = spec.y2Unit || unit0;
  const rotateX = spec.labels.some(l => l.length > 7) && spec.labels.length > 6 ? 24 : 0;

  const leftAxis = {
    type: 'value',
    name: spec.yLabel || undefined,
    nameTextStyle: { color: palette.muted, fontSize: 10.5, align: 'left' },
    splitNumber: 4,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: palette.muted,
      fontFamily: palette.monoFont,
      fontSize: 10.5,
      formatter: (v) => formatAxisTick(v, unit0),
    },
    splitLine: { lineStyle: { color: palette.grid, type: 'dashed' } },
  };

  const rightAxis = {
    type: 'value',
    name: spec.y2Label || undefined,
    nameTextStyle: { color: palette.muted, fontSize: 10.5, align: 'right' },
    splitNumber: 4,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: palette.muted,
      fontFamily: palette.monoFont,
      fontSize: 10.5,
      formatter: (v) => formatAxisTick(v, unit1),
    },
    splitLine: { show: false },
  };

  return {
    ...(hasLegend ? { legend: computeLegendLayout(palette) } : {}),
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'axis',
      axisPointer: {
        type: 'line',
        lineStyle: { color: palette.lineStrong, width: 1, type: 'dashed' },
      },
      formatter: (params) => {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return '';
        const head = `<div style="font-weight:600;margin-bottom:4px;color:${palette.ink}">${escapeTooltipHtml(list[0].axisValueLabel)}</div>`;
        const rows = list.map((p) => {
          const sSpec = spec.series[p.seriesIndex];
          const sUnit = sSpec?.yAxisIndex === 1 ? unit1 : unit0;
          const valStr = p.value === null || p.value === undefined
            ? '—'
            : formatChartValue(p.value, { unit: sUnit, signed: spec.hasNegative || sUnit === '%' });
          return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0">
            <span style="display:inline-flex;align-items:center;gap:6px;color:${palette.inkSecondary}">${p.marker}${escapeTooltipHtml(p.seriesName)}</span>
            <strong style="font-family:${palette.monoFont};color:${palette.ink}">${escapeTooltipHtml(valStr)}</strong>
          </div>`;
        }).join('');
        return head + rows;
      },
    },
    grid: {
      containLabel: true,
      left: 12,
      right: hasY2 ? 14 : 24,
      top: hasLegend ? 42 : (spec.yLabel ? 30 : 18),
      bottom: useZoom ? 48 : 12,
    },
    ...(useZoom ? { dataZoom: buildCategoryDataZoom(palette, { bottom: 14, defaultEnd: 60 }) } : {}),
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: spec.labels,
      axisLine: { lineStyle: { color: palette.lineStrong } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontFamily: palette.monoFont,
        fontSize: 10.5,
        rotate: rotateX,
        hideOverlap: true,
        ...(rotateX === 0 ? { alignMinLabel: 'left', alignMaxLabel: 'right' } : {}),
      },
    },
    yAxis: hasY2 ? [leftAxis, rightAxis] : leftAxis,
    series: spec.series.map((s, idx) => {
      const color = palette.series[idx % palette.series.length];
      const useArea = s.area || (spec.series.length === 1 && !s.dashed);
      return {
        name: s.name,
        type: 'line',
        yAxisIndex: hasY2 ? s.yAxisIndex : 0,
        data: s.values,
        smooth: s.smooth ? 0.34 : false,
        connectNulls: false,
        showSymbol: spec.labels.length <= 14 && !exportMode ? true : spec.labels.length <= 12,
        symbol: 'circle',
        symbolSize: 5,
        itemStyle: { color },
        lineStyle: {
          width: s.dashed ? 1.8 : 2.3,
          type: s.dashed ? 'dashed' : 'solid',
          color,
        },
        ...(useArea ? {
          areaStyle: {
            color: linearGradient(colorWithAlpha(color, palette.dark ? 0.24 : 0.18), colorWithAlpha(color, 0.01)),
          },
        } : {}),
      };
    }),
  };
}

function buildBarOption(spec, palette, { exportMode = false, width = 560 } = {}) {
  const hasLegend = spec.series.length > 1;
  const useZoom = !exportMode && shouldEnableDataZoom(spec, width);
  const rotateX = spec.labels.some(l => l.length > 6) && spec.labels.length > 5 ? 24 : 0;
  const showDirectLabels = !spec.stack && spec.series.length === 1 && spec.labels.length <= 8;

  return {
    ...(hasLegend ? { legend: computeLegendLayout(palette) } : {}),
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: colorWithAlpha(palette.teal, 0.06) } },
      formatter: (params) => {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return '';
        const head = `<div style="font-weight:600;margin-bottom:4px;color:${palette.ink}">${escapeTooltipHtml(list[0].axisValueLabel)}</div>`;
        const rows = list.map((p) => {
          const val = typeof p.value === 'object' && p.value !== null ? p.value.value : p.value;
          const valStr = val === null || val === undefined
            ? '—'
            : formatChartValue(val, { unit: spec.unit, signed: spec.colorBySign || spec.hasNegative || spec.unit === '%' });
          return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0">
            <span style="display:inline-flex;align-items:center;gap:6px;color:${palette.inkSecondary}">${p.marker}${escapeTooltipHtml(p.seriesName)}</span>
            <strong style="font-family:${palette.monoFont};color:${palette.ink}">${escapeTooltipHtml(valStr)}</strong>
          </div>`;
        }).join('');
        return head + rows;
      },
    },
    grid: {
      containLabel: true,
      left: 12,
      right: 18,
      top: hasLegend ? 42 : (showDirectLabels ? 26 : 18),
      bottom: useZoom ? 48 : 12,
    },
    ...(useZoom ? { dataZoom: buildCategoryDataZoom(palette, { bottom: 14, defaultEnd: 60 }) } : {}),
    xAxis: {
      type: 'category',
      data: spec.labels,
      axisLine: { lineStyle: { color: palette.lineStrong } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.inkSecondary,
        fontFamily: palette.fontFamily,
        fontSize: 10.5,
        interval: 0,
        rotate: rotateX,
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontFamily: palette.monoFont,
        fontSize: 10.5,
        formatter: (v) => formatAxisTick(v, spec.unit),
      },
      splitLine: { lineStyle: { color: palette.grid, type: 'dashed' } },
    },
    series: spec.series.map((s, idx) => {
      const seriesColor = palette.series[idx % palette.series.length];
      return {
        name: s.name,
        type: 'bar',
        ...(s.stack ? { stack: s.stack } : {}),
        barMaxWidth: spec.series.length > 2 ? 20 : 32,
        itemStyle: { color: seriesColor },
        data: s.values.map((v) => {
          if (v === null || v === undefined) return null;
          const color = spec.colorBySign
            ? (v > 0 ? palette.up : v < 0 ? palette.down : palette.flat)
            : seriesColor;
          const radius = spec.stack ? 0 : (v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4]);
          return {
            value: v,
            itemStyle: { color, borderRadius: radius },
            ...(showDirectLabels ? {
              label: {
                show: true,
                position: v >= 0 ? 'top' : 'bottom',
                fontFamily: palette.monoFont,
                fontSize: 10,
                fontWeight: 600,
                color: spec.colorBySign ? color : palette.inkSecondary,
                formatter: () => formatChartValue(v, { unit: spec.unit, signed: spec.colorBySign || spec.hasNegative }),
              },
            } : {}),
          };
        }),
      };
    }),
  };
}

function buildHbarOption(spec, palette, { width = 560 } = {}) {
  const labels = spec.items.map(i => i.label);
  const showLeftPad = spec.hasNegative ? 54 : 12;
  const labelWidth = Math.max(76, Math.min(132, Math.round(width * 0.30)));

  return {
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: colorWithAlpha(palette.teal, 0.06) } },
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p) return '';
        const item = spec.items[p.dataIndex];
        if (!item) return '';
        const valStr = formatChartValue(item.value, { unit: spec.unit, signed: spec.colorBySign || spec.hasNegative });
        return `<div style="font-weight:600;color:${palette.ink}">${escapeTooltipHtml(item.label)}</div>
          <div style="margin-top:3px;font-family:${palette.monoFont};font-weight:700;color:${palette.ink}">${escapeTooltipHtml(valStr)}</div>
          ${item.note ? `<div style="margin-top:2px;font-size:11px;color:${palette.muted}">${escapeTooltipHtml(item.note)}</div>` : ''}`;
      },
    },
    grid: {
      containLabel: true,
      left: showLeftPad,
      right: 64,
      top: 12,
      bottom: 12,
    },
    xAxis: {
      type: 'value',
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontFamily: palette.monoFont,
        fontSize: 10,
        alignMinLabel: 'left',
        alignMaxLabel: 'right',
        formatter: (v) => formatAxisTick(v, spec.unit),
      },
      splitLine: { lineStyle: { color: palette.grid, type: 'dashed' } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: labels,
      axisLine: { lineStyle: { color: palette.lineStrong } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.ink,
        fontFamily: palette.fontFamily,
        fontSize: 11.5,
        width: labelWidth,
        overflow: 'truncate',
      },
    },
    series: [{
      name: spec.title || '数值',
      type: 'bar',
      barMaxWidth: 16,
      data: spec.items.map((item, idx) => {
        const barColor = spec.colorBySign
          ? (item.value > 0 ? palette.up : item.value < 0 ? palette.down : palette.flat)
          : palette.series[idx === 0 ? 0 : idx % palette.series.length];
        const radius = item.value >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4];
        return {
          value: item.value,
          itemStyle: { color: barColor, borderRadius: radius },
          label: {
            show: true,
            position: item.value >= 0 ? 'right' : 'left',
            fontFamily: palette.monoFont,
            fontSize: 10.5,
            fontWeight: 600,
            color: spec.colorBySign ? barColor : palette.inkSecondary,
            formatter: () => formatChartValue(item.value, { unit: spec.unit, signed: spec.colorBySign || spec.hasNegative }),
          },
        };
      }),
    }],
  };
}

function buildDonutOption(spec, palette, { width = 560 } = {}) {
  const showCenter = !spec.pie && (spec.centerValue || spec.centerLabel);
  const total = spec.items.reduce((sum, item) => sum + item.value, 0);
  const compact = width < 380;

  return {
    ...(showCenter ? {
      title: {
        text: spec.centerValue || '',
        subtext: spec.centerLabel || '',
        left: 'center',
        top: '37%',
        textAlign: 'center',
        itemGap: 2,
        textStyle: {
          color: palette.ink,
          fontFamily: palette.monoFont,
          fontSize: 15,
          fontWeight: 700,
        },
        subtextStyle: {
          color: palette.muted,
          fontFamily: palette.fontFamily,
          fontSize: 10.5,
        },
      },
    } : {}),
    legend: {
      ...computeLegendLayout(palette),
      top: undefined,
      bottom: 4,
      icon: 'circle',
      itemWidth: 9,
      itemHeight: 9,
    },
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'item',
      formatter: (p) => {
        const item = spec.items[p.dataIndex];
        const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : p.percent;
        return `<div style="display:flex;align-items:center;gap:6px;font-weight:600;color:${palette.ink}">${p.marker}${escapeTooltipHtml(p.name)}</div>
          <div style="margin-top:3px;font-family:${palette.monoFont};color:${palette.ink}"><strong>${escapeTooltipHtml(formatChartValue(p.value, { unit: spec.unit }))}</strong>（${escapeTooltipHtml(pct)}%）</div>
          ${item?.note ? `<div style="margin-top:2px;font-size:11px;color:${palette.muted}">${escapeTooltipHtml(item.note)}</div>` : ''}`;
      },
    },
    series: [{
      name: spec.title || '占比分布',
      type: 'pie',
      radius: compact ? (spec.pie ? ['0%', '62%'] : ['43%', '64%']) : (spec.pie ? ['0%', '66%'] : ['45%', '67%']),
      center: ['50%', '43%'],
      padAngle: spec.items.length > 1 ? 2 : 0,
      avoidLabelOverlap: true,
      itemStyle: {
        borderRadius: 4,
        borderColor: palette.surface,
        borderWidth: 1.5,
      },
      label: {
        show: !compact,
        color: palette.inkSecondary,
        fontFamily: palette.fontFamily,
        fontSize: 11,
        lineHeight: 16,
        formatter: (p) => `${p.name}\n${p.percent.toFixed(1)}%`,
      },
      labelLine: {
        show: !compact,
        length: 10,
        length2: 8,
        lineStyle: { color: palette.lineStrong },
      },
      labelLayout: { hideOverlap: true },
      data: spec.items.map((item, idx) => ({
        name: item.label,
        value: item.value,
        itemStyle: { color: palette.series[idx % palette.series.length] },
      })),
    }],
  };
}

function displayUnits(text) {
  let units = 0;
  for (const ch of String(text ?? '')) {
    units += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  }
  return units;
}

function boxesOverlap(a, b, pad = 2) {
  return a.left < b.right + pad && a.right + pad > b.left && a.top < b.bottom + pad && a.bottom + pad > b.top;
}

/**
 * Compute padded axis range and deterministic 2D obstacle-free label placements for scatter plots
 * so dense fund clusters never overlap dots, axes bounds, or reference line badges.
 */
function placeScatterLabels(spec, { width, height, gridLeft, gridRight, gridTop, gridBottom, narrow, dense }) {
  const rawXMin = spec.includeZero ? Math.min(0, spec.xMin) : spec.xMin;
  const rawXMax = spec.includeZero ? Math.max(0, spec.xMax) : spec.xMax;
  const rawYMin = spec.includeZero ? Math.min(0, spec.yMin) : spec.yMin;
  const rawYMax = spec.includeZero ? Math.max(0, spec.yMax) : spec.yMax;
  const xSpan = rawXMax > rawXMin ? (rawXMax - rawXMin) : Math.max(Math.abs(rawXMin) * 0.2, 1);
  const ySpan = rawYMax > rawYMin ? (rawYMax - rawYMin) : Math.max(Math.abs(rawYMin) * 0.2, 1);
  const xLo = spec.includeZero ? rawXMin : rawXMin - xSpan * 0.14;
  const xHi = rawXMax + xSpan * (spec.includeZero ? 0.08 : 0.16);
  const yLo = spec.includeZero ? rawYMin : rawYMin - ySpan * 0.24;
  const yHi = rawYMax + ySpan * (spec.includeZero ? 0.12 : 0.28);

  const plotW = Math.max(80, gridRight - gridLeft);
  const plotH = Math.max(80, gridBottom - gridTop);
  const toPx = (x) => gridLeft + ((x - xLo) / (xHi - xLo)) * plotW;
  const toPy = (y) => gridBottom - ((y - yLo) / (yHi - yLo)) * plotH;
  const estWidth = (text) => displayUnits(text) * 5.8 + 8;

  const sizeSpan = (spec.sizeMax || 0) - (spec.sizeMin || 0);
  const pointRadius = (ptSize, highlight) => {
    if (!spec.hasSize || ptSize === undefined) return (highlight ? 11 : 8) / 2;
    if (sizeSpan <= 0) return 8;
    const ratio = (ptSize - spec.sizeMin) / sizeSpan;
    return Math.round(10 + ratio * 18) / 2;
  };

  const dotBoxes = [];
  const entries = [];
  let sumX = 0;
  let sumY = 0;
  let labeledCount = 0;

  spec.series.forEach((s, sIdx) => {
    s.points.forEach((pt, pIdx) => {
      const px = toPx(pt.x);
      const py = toPy(pt.y);
      const r = pointRadius(pt.size, s.highlight);
      dotBoxes.push({ left: px - r - 2, right: px + r + 2, top: py - r - 2, bottom: py + r + 2 });
      const wantLabel = Boolean(pt.label) && (!dense || s.highlight || pt.annotate);
      if (wantLabel) {
        sumX += pt.x;
        sumY += pt.y;
        labeledCount++;
      }
      entries.push({
        key: `${sIdx}:${pIdx}`,
        px,
        py,
        r,
        x: pt.x,
        y: pt.y,
        priority: Boolean(s.highlight || pt.annotate),
        wantLabel,
        displayLabel: clampDisplayWidth(pt.label, narrow ? 14 : 18),
      });
    });
  });

  const cx = labeledCount > 0 ? sumX / labeledCount : (xLo + xHi) / 2;
  const cy = labeledCount > 0 ? sumY / labeledCount : (yLo + yHi) / 2;

  const refObstacles = [];
  for (const ref of spec.refLines) {
    if (!ref.label) continue;
    const rw = displayUnits(ref.label) * 6.0 + 14;
    if (ref.axis === 'x') {
      const rx = toPx(ref.value);
      refObstacles.push({ left: rx - rw / 2 - 6, right: rx + rw / 2 + 6, top: gridTop - 26, bottom: gridTop + 4 });
    } else {
      const ry = toPy(ref.value);
      // Reserve buffer spanning ECharts nice-tick drift for flush-right insideEndBottom badge
      refObstacles.push({ left: gridRight - rw - 18, right: gridRight + 6, top: ry - 6, bottom: ry + 28 });
    }
  }

  const ordered = entries
    .filter(e => e.wantLabel)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      const da = ((a.x - cx) / xSpan) ** 2 + ((a.y - cy) / ySpan) ** 2;
      const db = ((b.x - cx) / xSpan) ** 2 + ((b.y - cy) / ySpan) ** 2;
      return db - da;
    });

  const placedBoxes = [];
  const placements = new Map();
  const labelH = 15;
  const inBounds = (box) => box.left >= gridLeft - 14 && box.right <= gridRight + 8 && box.top >= gridTop - 2 && box.bottom <= gridBottom + 2;

  for (const item of ordered) {
    const bw = estWidth(item.displayLabel);
    const gx = item.r + 7;
    const gy = item.r + 6;
    const { px, py } = item;
    const candidates = [
      { position: 'top', distance: 6, box: { left: px - bw / 2, right: px + bw / 2, top: py - gy - labelH, bottom: py - gy } },
      { position: 'right', distance: 7, box: { left: px + gx, right: px + gx + bw, top: py - labelH / 2, bottom: py + labelH / 2 } },
      { position: 'bottom', distance: 6, box: { left: px - bw / 2, right: px + bw / 2, top: py + gy, bottom: py + gy + labelH } },
      { position: 'left', distance: 7, box: { left: px - gx - bw, right: px - gx, top: py - labelH / 2, bottom: py + labelH / 2 } },
      { position: 'top', align: 'left', distance: 6, box: { left: px, right: px + bw, top: py - gy - labelH, bottom: py - gy } },
      { position: 'top', align: 'right', distance: 6, box: { left: px - bw, right: px, top: py - gy - labelH, bottom: py - gy } },
      { position: 'bottom', align: 'left', distance: 6, box: { left: px, right: px + bw, top: py + gy, bottom: py + gy + labelH } },
      { position: 'bottom', align: 'right', distance: 6, box: { left: px - bw, right: px, top: py + gy, bottom: py + gy + labelH } },
    ];

    const clearOf = (c, { ignoreDots = false } = {}) => {
      if (!inBounds(c.box)) return false;
      if (refObstacles.some(r => boxesOverlap(c.box, r, 3))) return false;
      if (placedBoxes.some(p => boxesOverlap(c.box, p, 3))) return false;
      if (!ignoreDots && dotBoxes.some(d => boxesOverlap(c.box, d, 0))) return false;
      return true;
    };

    let chosen = candidates.find(c => clearOf(c));
    if (!chosen && item.priority) {
      chosen = candidates.find(c => clearOf(c, { ignoreDots: true }));
    }

    if (chosen) {
      placedBoxes.push(chosen.box);
      placements.set(item.key, {
        show: true,
        position: chosen.position,
        ...(chosen.align ? { align: chosen.align } : {}),
        distance: chosen.distance,
        displayLabel: item.displayLabel,
      });
    } else {
      placements.set(item.key, {
        show: false,
        position: 'top',
        distance: 6,
        displayLabel: item.displayLabel,
      });
    }
  }

  return placements;
}

function buildScatterOption(spec, palette, { exportMode, width = 560, height = 296 }) {
  const hasLegend = spec.series.length > 1;
  const dense = spec.totalPoints > 24;
  const narrow = width < 380;
  const gridTop = hasLegend ? 84 : 62;
  const gridRight = Math.max(136, width - 26);
  const gridBottom = Math.max(gridTop + 80, height - 48);
  const labelPlacements = placeScatterLabels(spec, {
    width,
    height,
    gridLeft: 56,
    gridRight,
    gridTop,
    gridBottom,
    narrow,
    dense,
  });

  const xMarkLines = spec.refLines.filter(r => r.axis === 'x').map(r => ({
    xAxis: r.value,
    name: r.label || formatAxisTick(r.value, spec.xUnit),
    label: {
      show: Boolean(r.label),
      formatter: r.label,
      position: 'end',
      rotate: 0,
      distance: 4,
      color: palette.muted,
      fontFamily: palette.monoFont,
      fontSize: 10,
      backgroundColor: colorWithAlpha(palette.surface, 0.94),
      padding: [2, 5],
      borderRadius: 4,
    },
  }));
  const yMarkLines = spec.refLines.filter(r => r.axis === 'y').map(r => ({
    yAxis: r.value,
    name: r.label || formatAxisTick(r.value, spec.yUnit),
    label: {
      show: Boolean(r.label),
      formatter: r.label,
      position: 'insideEndBottom',
      rotate: 0,
      distance: 5,
      color: palette.muted,
      fontFamily: palette.monoFont,
      fontSize: 10,
      backgroundColor: colorWithAlpha(palette.surface, 0.94),
      padding: [2, 5],
      borderRadius: 4,
    },
  }));
  const allRefLines = [...xMarkLines, ...yMarkLines];

  const computeBubbleSize = (ptSize, highlight) => {
    if (!spec.hasSize || ptSize === undefined) return highlight ? 11 : 8;
    const span = (spec.sizeMax || 0) - (spec.sizeMin || 0);
    if (span <= 0) return 16;
    const ratio = (ptSize - spec.sizeMin) / span;
    return Math.round(10 + ratio * 18);
  };

  return {
    ...(hasLegend ? {
      legend: {
        ...computeLegendLayout(palette),
        icon: 'circle',
        itemWidth: 9,
        itemHeight: 9,
      },
    } : {}),
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'item',
      formatter: (p) => {
        const d = p.data || {};
        const xVal = formatChartValue(d.rawX, { unit: spec.xUnit, signed: spec.xMin < 0 && spec.xUnit === '%' });
        const yVal = formatChartValue(d.rawY, { unit: spec.yUnit, signed: spec.yMin < 0 && spec.yUnit === '%' });
        const sizeRow = d.rawSize !== undefined
          ? `<div style="display:flex;justify-content:space-between;gap:12px"><span>${escapeTooltipHtml(spec.sizeLabel || '规模')}</span><strong style="font-family:${palette.monoFont}">${escapeTooltipHtml(formatChartValue(d.rawSize, { unit: spec.sizeUnit }))}</strong></div>`
          : '';
        return `<div style="font-weight:700;color:${palette.ink}">${escapeTooltipHtml(d.pointLabel || p.seriesName)}</div>
          <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:${palette.muted};margin:2px 0 5px">${p.marker}${escapeTooltipHtml(p.seriesName)}</div>
          <div style="display:flex;justify-content:space-between;gap:12px"><span>${escapeTooltipHtml(spec.xLabel)}</span><strong style="font-family:${palette.monoFont}">${escapeTooltipHtml(xVal)}</strong></div>
          <div style="display:flex;justify-content:space-between;gap:12px"><span>${escapeTooltipHtml(spec.yLabel)}</span><strong style="font-family:${palette.monoFont}">${escapeTooltipHtml(yVal)}</strong></div>
          ${sizeRow}
          ${d.note ? `<div style="margin-top:4px;padding-top:4px;border-top:1px solid ${palette.line};font-size:11px;color:${palette.muted}">${escapeTooltipHtml(d.note)}</div>` : ''}`;
      },
    },
    grid: {
      containLabel: true,
      left: 12,
      right: 26,
      top: gridTop,
      bottom: 30,
    },
    xAxis: {
      type: 'value',
      scale: !spec.includeZero,
      boundaryGap: ['6%', '8%'],
      name: spec.xLabel,
      nameLocation: 'middle',
      nameGap: 25,
      nameTextStyle: { color: palette.muted, fontSize: 10.5, fontWeight: 600 },
      splitNumber: 4,
      axisLine: { lineStyle: { color: palette.lineStrong } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontFamily: palette.monoFont,
        fontSize: 10,
        hideOverlap: true,
        alignMinLabel: 'left',
        alignMaxLabel: 'right',
        formatter: (v) => formatAxisTick(v, spec.xUnit),
      },
      splitLine: { lineStyle: { color: palette.grid, type: 'dashed' } },
    },
    yAxis: {
      type: 'value',
      scale: !spec.includeZero,
      boundaryGap: ['12%', '16%'],
      name: spec.yLabel,
      nameLocation: 'end',
      nameGap: 30,
      nameTextStyle: { align: 'left', color: palette.muted, fontSize: 10.5, fontWeight: 600 },
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontFamily: palette.monoFont,
        fontSize: 10,
        formatter: (v) => formatAxisTick(v, spec.yUnit),
      },
      splitLine: { lineStyle: { color: palette.grid, type: 'dashed' } },
    },
    series: spec.series.map((s, idx) => {
      const color = palette.series[idx % palette.series.length];
      const sym = scatterSymbolSpec(s.shape, color, palette);
      return {
        name: s.name,
        type: 'scatter',
        symbol: sym.symbol,
        symbolSize: (val) => val[2] || (s.highlight ? 11 : 8),
        itemStyle: sym.itemStyle,
        emphasis: {
          scale: 1.35,
          label: { show: true },
        },
        labelLayout: {
          hideOverlap: true,
        },
        data: s.points.map((pt, pIdx) => {
          const placed = labelPlacements.get(`${idx}:${pIdx}`);
          const displayLabel = placed?.displayLabel || clampDisplayWidth(pt.label, narrow ? 14 : 18);
          return {
            value: [pt.x, pt.y, computeBubbleSize(pt.size, s.highlight)],
            rawX: pt.x,
            rawY: pt.y,
            rawSize: pt.size,
            pointLabel: pt.label,
            note: pt.note,
            label: {
              show: placed?.show ?? false,
              position: placed?.position || 'top',
              ...(placed?.align ? { align: placed.align } : {}),
              distance: placed?.distance ?? 6,
              fontSize: s.highlight ? 10.5 : 10,
              fontWeight: s.highlight ? 700 : 500,
              color: s.highlight ? palette.ink : palette.inkSecondary,
              textBorderColor: palette.surface,
              textBorderWidth: 3,
              textBorderJoin: 'round',
              formatter: () => displayLabel,
            },
          };
        }),
        ...(idx === 0 && allRefLines.length ? {
          markLine: {
            silent: true,
            symbol: ['none', 'none'],
            animation: false,
            lineStyle: { color: palette.muted, width: 1.2, type: 'dashed' },
            data: allRefLines,
          },
        } : {}),
        ...(exportMode ? { animation: false } : {}),
      };
    }),
  };
}

/** Compute pixel-exact responsive multi-row gauge geometry for 1..4 dials. */
export function gaugeLayoutFor(count, width = 560, height = 178) {
  const safeW = Math.max(240, Number(width) || 560);
  const safeH = Math.max(160, Number(height) || 178);
  const cols = gaugeGridColumns(count, safeW);
  const rows = Math.ceil(count / cols);
  const rowHeight = Math.floor((safeH - 10) / rows);
  const slotWidth = Math.floor((safeW - 16) / cols);
  const radius = Math.max(36, Math.round(Math.min(slotWidth * 0.36, rowHeight * 0.39, 64)));
  const fontSize = cols >= 3 || slotWidth < 165 ? 15 : (cols === 2 ? 17 : 20);

  return Array.from({ length: count }, (_, idx) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const itemsInRow = row === rows - 1 ? count - row * cols : cols;
    const centerX = itemsInRow === 1
      ? Math.round(safeW / 2)
      : Math.round(8 + (col + 0.5) * ((safeW - 16) / itemsInRow));
    const centerY = Math.round(6 + row * rowHeight + rowHeight * 0.48);
    return {
      row,
      col,
      cols,
      rows,
      center: [centerX, centerY],
      radius,
      slotWidth,
      fontSize,
    };
  });
}

function buildGaugeOption(spec, palette, { width = 560, height = 178 } = {}) {
  const count = spec.items.length;
  const layout = gaugeLayoutFor(count, width, height);
  const cols = layout[0]?.cols || 1;
  const arcWidth = cols >= 3 || count > 2 ? 9 : 11;
  const isTemp = spec.min === 0 && spec.max === 100 && spec.unit === '°';
  const tempColors = [
    [0.15, palette.cold],
    [0.3, palette.cool],
    [0.6, palette.mid],
    [0.8, palette.warm],
    [1, palette.hot],
  ];

  return {
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'item',
      formatter: (p) => {
        const item = spec.items[p.seriesIndex];
        if (!item) return '';
        return `<div style="font-weight:600;color:${palette.ink}">${escapeTooltipHtml(item.label)}</div>
          <div style="margin-top:3px;font-family:${palette.monoFont};font-weight:700;color:${palette.ink}">${escapeTooltipHtml(formatChartValue(item.value, { unit: spec.unit }))}</div>
          ${item.note ? `<div style="margin-top:2px;font-size:11px;color:${palette.muted}">${escapeTooltipHtml(item.note)}</div>` : ''}`;
      },
    },
    series: spec.items.map((item, idx) => {
      const slot = layout[idx];
      const toneColor = palette[item.tone] || palette.teal;
      const ratio = spec.max > spec.min ? (item.value - spec.min) / (spec.max - spec.min) : 0;
      const lineColors = isTemp
        ? tempColors
        : [[Math.max(0.02, Math.min(1, ratio)), palette.teal], [1, palette.line]];
      const labelWidth = Math.max(88, Math.floor(slot.slotWidth - 14));
      const maxNameUnits = Math.max(10, Math.floor((slot.slotWidth - 18) / 6.4));
      const maxNoteUnits = Math.max(12, Math.floor((slot.slotWidth - 18) / 5.8));
      const safeName = clampDisplayWidth(item.label, maxNameUnits).replace(/[{}|]/g, '');
      const safeNote = item.note ? clampDisplayWidth(item.note, maxNoteUnits).replace(/[{}|]/g, '') : '';
      const stackedName = safeNote ? `{name|${safeName}}\n{note|${safeNote}}` : `{name|${safeName}}`;

      return {
        name: item.label,
        type: 'gauge',
        min: spec.min,
        max: spec.max,
        startAngle: 180,
        endAngle: 0,
        center: slot.center,
        radius: slot.radius,
        splitNumber: 4,
        axisLine: {
          lineStyle: {
            width: arcWidth,
            color: lineColors,
          },
        },
        pointer: {
          show: true,
          length: '58%',
          width: 3.5,
          offsetCenter: [0, 0],
          itemStyle: { color: toneColor },
        },
        anchor: {
          show: true,
          showAbove: true,
          size: 7,
          itemStyle: { color: palette.surface, borderColor: toneColor, borderWidth: 2 },
        },
        axisTick: { distance: -arcWidth, length: 4, lineStyle: { color: palette.surface, width: 1 } },
        splitLine: { distance: -arcWidth - 1, length: 8, lineStyle: { color: palette.surface, width: 1.5 } },
        axisLabel: { show: false },
        title: {
          offsetCenter: [0, '82%'],
          color: palette.inkSecondary,
          fontFamily: palette.fontFamily,
          width: labelWidth,
          overflow: 'truncate',
          lineHeight: 15,
          rich: {
            name: {
              fontFamily: palette.fontFamily,
              fontSize: cols >= 3 ? 11 : 12,
              fontWeight: 600,
              color: palette.ink,
              width: labelWidth,
              overflow: 'truncate',
              align: 'center',
              lineHeight: 15,
            },
            note: {
              fontFamily: palette.fontFamily,
              fontSize: 10.5,
              fontWeight: 500,
              color: palette.muted,
              width: labelWidth,
              overflow: 'truncate',
              align: 'center',
              lineHeight: 14,
            },
          },
        },
        detail: {
          offsetCenter: [0, '26%'],
          fontFamily: palette.monoFont,
          fontSize: slot.fontSize,
          fontWeight: 700,
          color: toneColor,
          formatter: (val) => formatChartValue(val, { unit: spec.unit }),
        },
        data: [{ value: item.value, name: stackedName }],
      };
    }),
  };
}

function buildRadarOption(spec, palette, { width = 560 } = {}) {
  const compact = width < 380;
  return {
    legend: {
      ...computeLegendLayout(palette),
      top: undefined,
      bottom: 4,
      icon: 'roundRect',
    },
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'item',
      formatter: (p) => {
        const vals = Array.isArray(p.value) ? p.value : [];
        const rows = spec.indicators.map((ind, idx) =>
          `<div style="display:flex;justify-content:space-between;gap:12px;margin:2px 0">
            <span style="color:${palette.inkSecondary}">${escapeTooltipHtml(ind.name)}</span>
            <strong style="font-family:${palette.monoFont};color:${palette.ink}">${escapeTooltipHtml(formatChartValue(vals[idx], { unit: spec.unit }))}</strong>
          </div>`).join('');
        return `<div style="display:flex;align-items:center;gap:6px;font-weight:700;margin-bottom:4px;color:${palette.ink}">${p.marker}${escapeTooltipHtml(p.name)}</div>${rows}`;
      },
    },
    radar: {
      shape: 'polygon',
      center: ['50%', '46%'],
      radius: compact ? '50%' : '58%',
      axisNameGap: compact ? 10 : 12,
      splitNumber: 4,
      indicator: spec.indicators.map(ind => ({ name: ind.name, min: ind.min, max: ind.max })),
      axisName: {
        color: palette.inkSecondary,
        fontFamily: palette.fontFamily,
        fontSize: compact ? 10.5 : 11,
        fontWeight: 550,
        ...(compact ? { width: 64, overflow: 'break' } : {}),
      },
      splitLine: { lineStyle: { color: palette.lineStrong } },
      axisLine: { lineStyle: { color: palette.lineStrong } },
      splitArea: {
        areaStyle: {
          color: [palette.surface, palette.surfaceAlt],
        },
      },
    },
    series: [{
      name: spec.title || '多维评估',
      type: 'radar',
      data: spec.series.map((s, idx) => {
        const color = palette.series[idx % palette.series.length];
        return {
          name: s.name,
          value: s.values,
          symbol: 'circle',
          symbolSize: 5,
          itemStyle: { color },
          lineStyle: { width: 2.1, color },
          areaStyle: { color: colorWithAlpha(color, palette.dark ? 0.22 : 0.16) },
        };
      }),
    }],
  };
}

function buildHeatmapOption(spec, palette, { exportMode = false, width = 560 } = {}) {
  const useZoom = !exportMode && shouldEnableDataZoom(spec, width);
  const sameBounds = spec.min === spec.max;
  const vMin = sameBounds ? spec.min - 1 : spec.min;
  const vMax = sameBounds ? spec.max + 1 : spec.max;
  const colors = spec.colorBySign
    ? [palette.down, palette.surfaceAlt, palette.up]
    : [palette.surfaceAlt, palette.tealSoft, palette.teal];

  return {
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'item',
      formatter: (p) => {
        const [xi, yi, val] = Array.isArray(p.value) ? p.value : [];
        const xName = spec.xLabels[xi] ?? '';
        const yName = spec.yLabels[yi] ?? '';
        const valText = formatChartValue(val, { unit: spec.unit, signed: spec.colorBySign });
        return `<div style="font-weight:600;color:${palette.ink}">${escapeTooltipHtml(yName)} · ${escapeTooltipHtml(xName)}</div>
          <div style="margin-top:3px;font-family:${palette.monoFont};font-weight:700;color:${palette.ink}">${escapeTooltipHtml(valText)}</div>`;
      },
    },
    grid: {
      containLabel: true,
      left: 10,
      right: 16,
      top: 14,
      bottom: useZoom ? 88 : 50,
    },
    ...(useZoom ? { dataZoom: buildCategoryDataZoom(palette, { bottom: 14, defaultEnd: 60 }) } : {}),
    xAxis: {
      type: 'category',
      data: spec.xLabels,
      axisLine: { lineStyle: { color: palette.lineStrong } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.inkSecondary,
        fontFamily: palette.monoFont,
        fontSize: 10,
        interval: 0,
        rotate: spec.xLabels.length > 8 ? 28 : 0,
      },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: spec.yLabels,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.ink,
        fontFamily: palette.fontFamily,
        fontSize: 10.5,
      },
    },
    visualMap: {
      min: vMin,
      max: vMax,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: useZoom ? 42 : 4,
      itemWidth: 12,
      itemHeight: 140,
      text: [formatChartValue(vMax, { unit: spec.unit, signed: spec.colorBySign }), formatChartValue(vMin, { unit: spec.unit, signed: spec.colorBySign })],
      textStyle: { color: palette.muted, fontFamily: palette.monoFont, fontSize: 10 },
      inRange: { color: colors },
    },
    series: [{
      name: spec.title || '矩阵热力图',
      type: 'heatmap',
      data: spec.cells,
      itemStyle: {
        borderRadius: 4,
        borderColor: palette.surface,
        borderWidth: 2,
      },
      label: {
        show: spec.cells.length <= 64,
        fontFamily: palette.monoFont,
        fontSize: 10,
        color: palette.ink,
        textBorderColor: colorWithAlpha(palette.surface, 0.72),
        textBorderWidth: 2,
        textBorderJoin: 'round',
        formatter: (p) => formatChartValue(p.value?.[2], { unit: spec.unit, signed: spec.colorBySign }),
      },
      emphasis: {
        itemStyle: {
          borderColor: palette.ink,
          borderWidth: 1.5,
        },
      },
    }],
  };
}

function buildSankeyOption(spec, palette, { exportMode, width = 560 }) {
  const rightPad = Math.max(64, Math.min(96, Math.round(width * 0.24)));
  const labelWidth = Math.max(54, Math.min(82, Math.round(width * 0.21)));
  return {
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'item',
      formatter: (p) => {
        if (p.dataType === 'edge' && p.data) {
          const valStr = formatChartValue(p.data.value, { unit: spec.unit });
          return `<div style="font-weight:600;color:${palette.ink}">${escapeTooltipHtml(p.data.source)} → ${escapeTooltipHtml(p.data.target)}</div>
            <div style="margin-top:3px;font-family:${palette.monoFont};font-weight:700;color:${palette.ink}">${escapeTooltipHtml(valStr)}</div>`;
        }
        const valStr = formatChartValue(p.value, { unit: spec.unit });
        return `<div style="font-weight:600;color:${palette.ink}">${escapeTooltipHtml(p.name)}</div>
          <div style="margin-top:3px;font-family:${palette.monoFont};color:${palette.inkSecondary}">流量：<strong>${escapeTooltipHtml(valStr)}</strong></div>`;
      },
    },
    series: [{
      type: 'sankey',
      left: 12,
      right: rightPad,
      top: 14,
      bottom: 14,
      nodeWidth: 14,
      nodeGap: 10,
      draggable: !exportMode,
      emphasis: { focus: 'adjacency' },
      data: spec.nodes.map((node, idx) => ({
        ...node,
        itemStyle: {
          color: palette.series[idx % palette.series.length],
          borderRadius: 3,
        },
      })),
      links: spec.links,
      lineStyle: {
        color: 'gradient',
        curveness: 0.48,
        opacity: palette.dark ? 0.5 : 0.42,
      },
      label: {
        color: palette.ink,
        fontFamily: palette.fontFamily,
        fontSize: 11,
        width: labelWidth,
        overflow: 'truncate',
      },
    }],
  };
}

function buildTreemapOption(spec, palette) {
  const hasNested = spec.items.some(item => Array.isArray(item.children) && item.children.length > 0);
  const total = spec.items.reduce((sum, item) => sum + item.value, 0);

  return {
    tooltip: {
      ...tooltipShell(palette),
      trigger: 'item',
      formatter: (p) => {
        const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : '';
        const note = p.data?.note;
        return `<div style="font-weight:600;color:${palette.ink}">${escapeTooltipHtml(p.name)}</div>
          <div style="margin-top:3px;font-family:${palette.monoFont};color:${palette.ink}"><strong>${escapeTooltipHtml(formatChartValue(p.value, { unit: spec.unit }))}</strong>${pct ? `（${escapeTooltipHtml(pct)}%）` : ''}</div>
          ${note ? `<div style="margin-top:2px;font-size:11px;color:${palette.muted}">${escapeTooltipHtml(note)}</div>` : ''}`;
      },
    },
    series: [{
      name: spec.title || '层级占比',
      type: 'treemap',
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      itemStyle: {
        borderColor: palette.surface,
        borderWidth: 2,
        gapWidth: 2,
        borderRadius: 4,
      },
      upperLabel: {
        show: hasNested,
        height: 22,
        color: palette.ink,
        fontFamily: palette.fontFamily,
        fontSize: 11,
        fontWeight: 650,
      },
      label: {
        show: true,
        color: '#ffffff',
        textShadowColor: 'rgba(0, 0, 0, 0.35)',
        textShadowBlur: 3,
        fontFamily: palette.fontFamily,
        fontSize: 11,
        lineHeight: 15,
        formatter: (p) => `${p.name}\n${formatChartValue(p.value, { unit: spec.unit })}`,
      },
      data: spec.items.map((item, idx) => ({
        ...item,
        itemStyle: { color: palette.series[idx % palette.series.length] },
      })),
    }],
  };
}

/** Build a complete ECharts option object matching UNK AI Paper & Ink themes for the normalized spec. */
export function buildEChartsOption(spec, palette = EXPORT_CHART_PALETTE, { exportMode = false, width = 560, height = 280 } = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('buildEChartsOption requires a normalized chart spec.');
  }

  let specific;
  switch (spec.type) {
    case 'line':
      specific = buildLineOption(spec, palette, { exportMode, width });
      break;
    case 'bar':
      specific = buildBarOption(spec, palette, { exportMode, width });
      break;
    case 'hbar':
      specific = buildHbarOption(spec, palette, { width });
      break;
    case 'donut':
      specific = buildDonutOption(spec, palette, { width });
      break;
    case 'scatter':
      specific = buildScatterOption(spec, palette, { exportMode, width, height });
      break;
    case 'gauge':
      specific = buildGaugeOption(spec, palette, { width, height });
      break;
    case 'radar':
      specific = buildRadarOption(spec, palette, { width });
      break;
    case 'heatmap':
      specific = buildHeatmapOption(spec, palette, { exportMode, width });
      break;
    case 'sankey':
      specific = buildSankeyOption(spec, palette, { exportMode, width });
      break;
    case 'treemap':
      specific = buildTreemapOption(spec, palette);
      break;
    default:
      throw new TypeError(`Unsupported chart type: ${spec.type}`);
  }

  return {
    animation: !exportMode,
    animationDuration: 320,
    animationEasing: 'cubicOut',
    backgroundColor: 'transparent',
    color: [...palette.series],
    textStyle: {
      color: palette.ink,
      fontFamily: palette.fontFamily,
    },
    ...specific,
  };
}

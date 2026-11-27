/**
 * Tree-shaken Apache ECharts runtime isolated behind dynamic import.
 *
 * Registers only the 9 chart series powering UNK AI's 10 visual types
 * (`bar` handles both vertical bar and horizontal hbar, `pie` handles donut/pie)
 * plus required components, LabelLayout, and SVGRenderer.
 */

import * as echarts from 'echarts/core';
import {
  BarChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  SankeyChart,
  ScatterChart,
  TreemapChart,
} from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { LabelLayout, LegacyGridContainLabel } from 'echarts/features';
import { SVGRenderer } from 'echarts/renderers';
import DOMPurify from 'dompurify';
import { recommendedChartHeight } from './chart-spec.js';
import { buildEChartsOption, EXPORT_CHART_PALETTE } from './chart-option.js';

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  GaugeChart,
  RadarChart,
  HeatmapChart,
  SankeyChart,
  TreemapChart,
  GridComponent,
  DataZoomComponent,
  LegendComponent,
  TooltipComponent,
  TitleComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
  RadarComponent,
  LabelLayout,
  LegacyGridContainLabel,
  SVGRenderer,
]);

const SVG_SANITIZE_CONFIG = Object.freeze({
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['style'],
  FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
});

let svgSeq = 0;

function scopeSvgIds(svgText, prefix) {
  const ids = new Set();
  svgText.replace(/\bid="([a-zA-Z_][\w:-]*)"/g, (_m, id) => {
    ids.add(id);
    return _m;
  });
  if (!ids.size) return svgText;
  let scoped = svgText;
  for (const id of ids) {
    const nextId = `${prefix}-${id}`;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    scoped = scoped
      .replace(new RegExp(`\\bid="${escaped}"`, 'g'), `id="${nextId}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, 'g'), `url(#${nextId})`)
      .replace(new RegExp(`href="#${escaped}"`, 'g'), `href="#${nextId}"`);
  }
  return scoped;
}

function fallbackSanitizeSvg(raw) {
  return String(raw || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<(?:iframe|object|embed)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

function normalizeStaticSvg(rawSvg, { width, height }) {
  const cleanImport = String(rawSvg || '').replace(/@import\s+url\([^)]*\)\s*;?/gi, '');
  if (!/<svg\b/i.test(cleanImport)) return '';
  let out = cleanImport.replace(/<svg\b([^>]*)>/i, (_whole, attrs) => {
    let nextAttrs = attrs;
    if (!/\bviewBox\s*=/i.test(nextAttrs)) {
      nextAttrs += ` viewBox="0 0 ${width} ${height}"`;
    }
    if (!/\bclass\s*=/i.test(nextAttrs)) {
      nextAttrs += ' class="unk-chart-svg"';
    }
    return `<svg${nextAttrs}>`;
  });
  out = scopeSvgIds(out, `ech-${++svgSeq}`);
  const purified = DOMPurify?.isSupported
    ? DOMPurify.sanitize(out, SVG_SANITIZE_CONFIG)
    : fallbackSanitizeSvg(out);
  return /<svg\b/i.test(purified) ? purified : '';
}

/**
 * Synchronously render a normalized chart spec into a scoped, sanitized static SVG string
 * using ECharts' zero-DOM SSR SVG mode (used for PNG/PDF/offline-HTML export and tests).
 */
export function renderEChartSvgString(spec, { width = 660, height, palette = EXPORT_CHART_PALETTE } = {}) {
  const h = height || recommendedChartHeight(spec);
  const chart = echarts.init(null, null, {
    renderer: 'svg',
    ssr: true,
    width,
    height: h,
  });
  try {
    const option = buildEChartsOption(spec, palette, { exportMode: true, width, height: h });
    chart.setOption(option, true);
    const rawSvg = chart.renderToSVGString();
    return normalizeStaticSvg(rawSvg, { width, height: h });
  } finally {
    chart.dispose();
  }
}

const WIDTH_RESPONSIVE_TYPES = new Set(['line', 'bar', 'heatmap', 'gauge', 'donut', 'hbar', 'sankey', 'scatter', 'radar']);

/**
 * Mount a live interactive ECharts SVG instance into `stageEl` with update, resize, and dispose handles.
 */
export function mountEChartInstance(stageEl, spec, palette, { width, height } = {}) {
  let effectiveWidth = width > 0 ? width : 460;
  let currentSpec = spec;
  let currentPalette = palette;

  const chart = echarts.init(stageEl, null, {
    renderer: 'svg',
    ...(width > 0 ? { width } : {}),
    ...(height > 0 ? { height } : {}),
  });
  chart.setOption(buildEChartsOption(currentSpec, currentPalette, {
    exportMode: false,
    width: effectiveWidth,
    height: height > 0 ? height : recommendedChartHeight(currentSpec, effectiveWidth),
  }), true);

  return {
    chart,
    update(nextSpec, nextPalette, dims = {}) {
      currentSpec = nextSpec;
      currentPalette = nextPalette;
      if (dims.width > 0) effectiveWidth = dims.width;
      const h = dims.height > 0 ? dims.height : recommendedChartHeight(nextSpec, effectiveWidth);
      chart.setOption(buildEChartsOption(currentSpec, currentPalette, {
        exportMode: false,
        width: effectiveWidth,
        height: h,
      }), true);
      if (dims.width > 0 && dims.height > 0) {
        chart.resize({ width: dims.width, height: dims.height });
      }
    },
    resize(dims = {}) {
      if (dims.width > 0 && dims.height > 0) {
        effectiveWidth = dims.width;
        chart.resize({ width: dims.width, height: dims.height });
        if (WIDTH_RESPONSIVE_TYPES.has(currentSpec?.type)) {
          chart.setOption(buildEChartsOption(currentSpec, currentPalette, {
            exportMode: false,
            width: dims.width,
            height: dims.height,
          }), true);
        }
      } else {
        chart.resize();
      }
    },
    dispose() {
      try {
        if (!chart.isDisposed?.()) chart.dispose();
      } catch {
        // Ignore teardown races on detached DOM nodes.
      }
    },
  };
}

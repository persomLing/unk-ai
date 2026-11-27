/**
 * Standalone IIFE entry bundled by Vite into `dist/assets/export-charts-runtime.js`
 * and inlined into offline HTML exports that contain charts so exported HTML files
 * retain full interactive ECharts tooltips, legends, dataZoom, resize, and theme switching.
 */
import { mountEChartInstance } from '../charts/echarts-runtime.js';
import { DEFAULT_DARK_PALETTE, EXPORT_CHART_PALETTE } from '../charts/chart-option.js';
import { recommendedChartHeight } from '../charts/chart-spec.js';

globalThis.__UNK_EXPORT_CHARTS__ = Object.freeze({
  mountEChartInstance,
  lightPalette: EXPORT_CHART_PALETTE,
  darkPalette: DEFAULT_DARK_PALETTE,
  recommendedChartHeight,
});

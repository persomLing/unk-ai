export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeInlineCss(cssText) {
  return String(cssText || '').replace(/<\/(style)/gi, '<\\/$1');
}

export function safeInlineScript(jsText) {
  return String(jsText || '').replace(/<\/(script)/gi, '<\\/$1');
}

export function tableExportDensity(columnCount) {
  const cols = Number(columnCount) || 0;
  if (cols >= 8) return 'dense';
  if (cols >= 6) return 'compact';
  return '';
}

export const STANDALONE_HTML_CSS = `
html, body {
  margin: 0;
  padding: 0;
  background: #f4f6f2;
  color: #24332c;
  color-scheme: light;
}
.export-html-shell {
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 20px 44px;
}
.export-html-toolbar {
  position: fixed;
  top: 16px;
  right: 20px;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 8px;
}
.export-theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid #d5dfd7;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #24332c;
  font: 600 12px/1 "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(24, 42, 33, 0.1);
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}
.export-theme-toggle:hover,
.export-theme-toggle:focus-visible {
  border-color: #20685d;
  color: #20685d;
  background: #f2f7f4;
  outline: none;
}
.export-theme-toggle svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.export-html-shell > .export-paper {
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  border: 1px solid #dfe6df;
  border-radius: 14px;
  box-shadow: 0 10px 30px rgba(24, 42, 33, 0.06);
}
.export-paper.export-mode-html .unk-chart-stage {
  text-align: left;
  position: relative;
}
.export-html-footer {
  max-width: 920px;
  margin: 14px auto 0;
  padding: 0 4px;
  text-align: center;
  color: #69766e;
  font: 11px/1.6 "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
}

/* Dark theme for interactive standalone HTML exports */
:root[data-theme="dark"],
:root[data-theme="dark"] body {
  background: #141619;
  color: #eceff2;
  color-scheme: dark;
}
:root[data-theme="dark"] .export-theme-toggle {
  background: #24272c;
  border-color: rgba(255, 255, 255, 0.16);
  color: #eceff2;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.32);
}
:root[data-theme="dark"] .export-theme-toggle:hover,
:root[data-theme="dark"] .export-theme-toggle:focus-visible {
  border-color: #6ec2a8;
  color: #6ec2a8;
  background: #2b3036;
}
:root[data-theme="dark"] .export-html-shell > .export-paper {
  --ink: #eceff2;
  --muted: #8f98a2;
  --teal: #6ec2a8;
  --teal-dark: #86d3bb;
  --surface: #1e2024;
  --surface-alt: #24272c;
  --line: rgba(255, 255, 255, 0.1);
  background: #1e2024;
  color: #eceff2;
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.42);
  color-scheme: dark;
}
:root[data-theme="dark"] .export-paper .export-heading { border-bottom-color: rgba(255, 255, 255, 0.12); }
:root[data-theme="dark"] .export-paper .export-brand,
:root[data-theme="dark"] .export-paper .export-role,
:root[data-theme="dark"] .export-paper a { color: #6ec2a8; }
:root[data-theme="dark"] .export-paper .export-title,
:root[data-theme="dark"] .export-paper .export-markdown,
:root[data-theme="dark"] .export-paper .export-markdown h1,
:root[data-theme="dark"] .export-paper .export-markdown h2,
:root[data-theme="dark"] .export-paper .export-markdown h3,
:root[data-theme="dark"] .export-paper .export-markdown h4,
:root[data-theme="dark"] .export-paper .export-markdown h5,
:root[data-theme="dark"] .export-paper .export-markdown h6 { color: #eceff2; }
:root[data-theme="dark"] .export-paper .export-meta,
:root[data-theme="dark"] .export-paper .export-turn-label,
:root[data-theme="dark"] .export-paper .export-sources,
:root[data-theme="dark"] .export-paper .export-attachment,
:root[data-theme="dark"] .export-paper .export-image-placeholder,
:root[data-theme="dark"] .export-paper .export-illustration figcaption,
:root[data-theme="dark"] .export-html-footer { color: #8f98a2; }
:root[data-theme="dark"] .export-paper .export-turn,
:root[data-theme="dark"] .export-paper hr,
:root[data-theme="dark"] .export-paper .export-sources { border-color: rgba(255, 255, 255, 0.1); }
:root[data-theme="dark"] .export-paper .export-question {
  background: rgba(110, 194, 168, 0.08);
  border-color: rgba(110, 194, 168, 0.24);
}
:root[data-theme="dark"] .export-paper .export-markdown blockquote {
  background: #24272c;
  border-left-color: #6ec2a8;
  color: #bec5cc;
}
:root[data-theme="dark"] .export-paper .export-markdown pre {
  background: #16181c;
  border-color: rgba(255, 255, 255, 0.12);
  color: #dce3ea;
}
:root[data-theme="dark"] .export-paper .export-markdown pre code { color: #dce3ea; }
:root[data-theme="dark"] .export-paper .export-markdown :not(pre) > code {
  background: rgba(110, 194, 168, 0.14);
  color: #8ad6be;
}
:root[data-theme="dark"] .export-paper .hljs-keyword,
:root[data-theme="dark"] .export-paper .hljs-selector-tag,
:root[data-theme="dark"] .export-paper .hljs-literal { color: #c79bf0; }
:root[data-theme="dark"] .export-paper .hljs-string,
:root[data-theme="dark"] .export-paper .hljs-regexp,
:root[data-theme="dark"] .export-paper .hljs-attr { color: #7ed4a6; }
:root[data-theme="dark"] .export-paper .hljs-title,
:root[data-theme="dark"] .export-paper .hljs-function,
:root[data-theme="dark"] .export-paper .hljs-built_in { color: #7cb4e2; }
:root[data-theme="dark"] .export-paper .hljs-number,
:root[data-theme="dark"] .export-paper .hljs-symbol { color: #e6a96a; }
:root[data-theme="dark"] .export-paper .hljs-comment,
:root[data-theme="dark"] .export-paper .hljs-quote { color: #8a949e; }
:root[data-theme="dark"] .export-paper.export-mode-html .md-table-scroll {
  background: #1e2024;
  border-color: rgba(255, 255, 255, 0.14);
}
:root[data-theme="dark"] .export-paper table {
  background: #1e2024;
  border-color: rgba(255, 255, 255, 0.12);
}
:root[data-theme="dark"] .export-paper th,
:root[data-theme="dark"] .export-paper td {
  border-color: rgba(255, 255, 255, 0.1);
  color: #dce3ea;
}
:root[data-theme="dark"] .export-paper th {
  background: #262a30;
  color: #eceff2;
}
:root[data-theme="dark"] .export-paper .export-status {
  background: rgba(226, 180, 110, 0.12);
  border-left-color: #e2b46e;
  color: #f0cf97;
}
:root[data-theme="dark"] .export-paper .unk-chart-card,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-card,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-vis-card,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-steps-card,
:root[data-theme="dark"] .export-paper .mermaid-vis-card,
:root[data-theme="dark"] .export-paper .reading-steps-card,
:root[data-theme="dark"] .export-paper .reading-interactive-card,
:root[data-theme="dark"] .export-paper .reading-example-card,
:root[data-theme="dark"] .export-paper details.md-details {
  background: #1e2024;
  border-color: rgba(255, 255, 255, 0.14);
}
:root[data-theme="dark"] .export-paper .unk-chart-header,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-head,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-vis-header,
:root[data-theme="dark"] .export-paper .reading-card-header,
:root[data-theme="dark"] .export-paper details.md-details > summary {
  background: #25282e;
  border-bottom-color: rgba(255, 255, 255, 0.1);
  color: #eceff2;
}
:root[data-theme="dark"] .export-paper .unk-chart-badge {
  background: rgba(110, 194, 168, 0.16);
  border-color: rgba(110, 194, 168, 0.34);
  color: #6ec2a8;
}
:root[data-theme="dark"] .export-paper .unk-chart-title,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-title,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-vis-title,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-value,
:root[data-theme="dark"] .export-paper .reading-card-title,
:root[data-theme="dark"] .export-paper .reading-quiz-question,
:root[data-theme="dark"] .export-paper .reading-reveal-answer { color: #eceff2; }
:root[data-theme="dark"] .export-paper .unk-chart-subtitle,
:root[data-theme="dark"] .export-paper .unk-chart-footer,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-asof,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-label,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-sub,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-vis-subtitle,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-vis-footer,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-step-meta,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-step-arrow,
:root[data-theme="dark"] .export-paper .reading-card-subtitle,
:root[data-theme="dark"] .export-paper .reading-step-meta,
:root[data-theme="dark"] .export-paper .reading-step-arrow,
:root[data-theme="dark"] .export-paper .reading-quiz-hint,
:root[data-theme="dark"] .export-paper .reading-example-sub { color: #9aa3ad; }
:root[data-theme="dark"] .export-paper .unk-chart-stage,
:root[data-theme="dark"] .export-paper .mermaid-vis-stage,
:root[data-theme="dark"] .export-paper .reading-example-body { background: #1e2024; }
:root[data-theme="dark"] .export-paper .unk-chart-footer,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-vis-footer {
  background: #23262b;
  border-top-color: rgba(255, 255, 255, 0.1);
}
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-cell { border-right-color: rgba(255, 255, 255, 0.1); }
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-metric.is-up,
:root[data-theme="dark"] .export-paper .export-fund-markdown td.fund-pct-up,
:root[data-theme="dark"] .export-paper .export-fund-markdown td.fund-pct-up code,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-cell.trend-up .fund-kpi-value,
:root[data-theme="dark"] .export-paper .export-fund-markdown blockquote.fund-callout code.fund-code-metric.is-up { color: #f07c73; }
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-metric.is-up,
:root[data-theme="dark"] .export-paper .export-fund-markdown blockquote.fund-callout code.fund-code-metric.is-up { background: rgba(240, 124, 115, 0.16); }
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-metric.is-down,
:root[data-theme="dark"] .export-paper .export-fund-markdown td.fund-pct-down,
:root[data-theme="dark"] .export-paper .export-fund-markdown td.fund-pct-down code,
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-kpi-cell.trend-down .fund-kpi-value,
:root[data-theme="dark"] .export-paper .export-fund-markdown blockquote.fund-callout code.fund-code-metric.is-down { color: #5cc993; }
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-metric.is-down,
:root[data-theme="dark"] .export-paper .export-fund-markdown blockquote.fund-callout code.fund-code-metric.is-down { background: rgba(92, 201, 147, 0.16); }
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-code-pill {
  background: rgba(110, 194, 168, 0.15);
  color: #84d3ba;
}
:root[data-theme="dark"] .export-paper .export-fund-markdown blockquote.fund-callout {
  background: rgba(110, 194, 168, 0.08);
  border-color: rgba(110, 194, 168, 0.25);
  border-left-color: #6ec2a8;
  color: #dce3ea;
}
:root[data-theme="dark"] .export-paper .export-fund-markdown blockquote.fund-callout.tone-risk {
  background: rgba(240, 124, 115, 0.1);
  border-color: rgba(240, 124, 115, 0.3);
  border-left-color: #f07c73;
}
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-step-box,
:root[data-theme="dark"] .export-paper .reading-step-box,
:root[data-theme="dark"] .export-paper .reading-quiz-option,
:root[data-theme="dark"] .export-paper .reading-reveal {
  background: #25282e;
  border-color: rgba(255, 255, 255, 0.15);
  color: #eceff2;
}
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-step-box.tone-accent,
:root[data-theme="dark"] .export-paper .reading-step-box.tone-accent {
  background: #6ec2a8;
  border-color: #6ec2a8;
  color: #0e1d18;
}
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-step-box.tone-warm,
:root[data-theme="dark"] .export-paper .reading-step-box.tone-warm {
  background: rgba(226, 180, 110, 0.14);
  border-color: rgba(226, 180, 110, 0.32);
  color: #eceff2;
}
:root[data-theme="dark"] .export-paper .export-fund-markdown .fund-step-box.tone-risk,
:root[data-theme="dark"] .export-paper .reading-step-box.tone-risk {
  background: rgba(240, 124, 115, 0.14);
  border-color: rgba(240, 124, 115, 0.32);
  color: #eceff2;
}
:root[data-theme="dark"] .export-paper .export-markdown blockquote.reading-callout {
  background: #24272c;
  border-color: rgba(255, 255, 255, 0.14);
  border-left-color: #6ec2a8;
  color: #dce3ea;
}
:root[data-theme="dark"] .export-paper .reading-callout-head,
:root[data-theme="dark"] .export-paper .reading-card-label,
:root[data-theme="dark"] .export-paper .reading-reveal-summary { color: #6ec2a8; }
:root[data-theme="dark"] .export-paper .reading-reveal-explanation { color: #bec5cc; }
:root[data-theme="dark"] .export-paper .reading-example-summary {
  background: rgba(226, 180, 110, 0.12);
  border-bottom-color: rgba(226, 180, 110, 0.25);
}
:root[data-theme="dark"] .export-paper .reading-example-head { color: #e2b46e; }
:root[data-theme="dark"] .export-paper .reading-example-takeaway {
  background: rgba(110, 194, 168, 0.14);
  color: #84d3ba;
}

@media (max-width: 680px) {
  .export-html-toolbar {
    top: 10px;
    right: 10px;
  }
  .export-html-shell {
    padding: 12px 8px 28px;
  }
  .export-html-shell > .export-paper {
    padding: 24px 18px 22px;
    border-radius: 10px;
  }
  .export-paper .export-fund-markdown .fund-kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .export-paper .export-fund-markdown .fund-hbar-row {
    grid-template-columns: 38% 1fr auto;
    gap: 8px;
  }
}
@media print {
  html, body {
    background: #fff !important;
  }
  .export-html-toolbar {
    display: none !important;
  }
  .export-html-shell {
    max-width: none;
    margin: 0;
    padding: 0;
  }
  .export-html-shell > .export-paper {
    max-width: none;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    padding: 16px 18px;
  }
  .export-html-shell > .export-paper .md-table-scroll {
    overflow: visible;
  }
  .export-paper tr,
  .export-paper .unk-chart-card,
  .export-paper .fund-vis-card,
  .export-paper .fund-kpi-card,
  .export-paper .fund-steps-card,
  .export-paper .mermaid-vis-card,
  .export-paper .export-illustration {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .export-html-footer {
    margin-top: 10px;
  }
}
`.trim();

const EXPORT_BOOT_SCRIPT = `(function(){
  var root = document.documentElement;
  var toggleBtn = document.getElementById('unk-export-theme-toggle');
  var iconEl = toggleBtn ? toggleBtn.querySelector('.export-theme-icon') : null;
  var labelEl = toggleBtn ? toggleBtn.querySelector('.export-theme-label') : null;
  var SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/></svg>';
  var MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>';
  var mounted = [];

  function readSavedTheme() {
    try {
      var saved = localStorage.getItem('unk-export-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (e) {}
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function currentPalette() {
    var api = window.__UNK_EXPORT_CHARTS__;
    if (!api) return null;
    return root.getAttribute('data-theme') === 'dark' ? api.darkPalette : api.lightPalette;
  }

  function measureStage(stage, spec) {
    var api = window.__UNK_EXPORT_CHARTS__;
    var rect = stage.getBoundingClientRect ? stage.getBoundingClientRect() : null;
    var cs = window.getComputedStyle ? window.getComputedStyle(stage) : null;
    var padX = cs ? ((parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)) : 0;
    var rawW = stage.clientWidth || (rect && rect.width) || 660;
    var width = Math.max(240, Math.floor(rawW - padX));
    var height = api && typeof api.recommendedChartHeight === 'function'
      ? api.recommendedChartHeight(spec, width)
      : 280;
    stage.style.height = height + 'px';
    return { width: width, height: height };
  }

  function syncThemeUi(theme) {
    root.setAttribute('data-theme', theme);
    var isDark = theme === 'dark';
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-pressed', String(isDark));
      toggleBtn.title = isDark ? '切换为浅色主题' : '切换为深色主题';
    }
    if (iconEl) iconEl.innerHTML = isDark ? SUN_SVG : MOON_SVG;
    if (labelEl) labelEl.textContent = isDark ? '浅色模式' : '深色模式';
    var palette = currentPalette();
    if (!palette) return;
    for (var i = 0; i < mounted.length; i++) {
      var item = mounted[i];
      try {
        var dims = measureStage(item.stage, item.spec);
        item.instance.update(item.spec, palette, dims);
      } catch (e) {}
    }
  }

  function hydrateCharts() {
    var api = window.__UNK_EXPORT_CHARTS__;
    if (!api || typeof api.mountEChartInstance !== 'function') return;
    var stages = document.querySelectorAll('[data-chart-stage="true"]');
    if (!stages.length) return;
    var palette = currentPalette();
    for (var i = 0; i < stages.length; i++) {
      var stage = stages[i];
      var raw = stage.getAttribute('data-chart-spec');
      if (!raw) continue;
      try {
        var spec = JSON.parse(raw);
        var dims = measureStage(stage, spec);
        stage.innerHTML = '';
        var instance = api.mountEChartInstance(stage, spec, palette, dims);
        mounted.push({ stage: stage, spec: spec, instance: instance });
      } catch (e) {}
    }
    if (!mounted.length) return;
    var rafId = null;
    function resizeAll() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(function() {
        rafId = null;
        for (var j = 0; j < mounted.length; j++) {
          var entry = mounted[j];
          try {
            var nextDims = measureStage(entry.stage, entry.spec);
            entry.instance.resize(nextDims);
          } catch (e) {}
        }
      });
    }
    window.addEventListener('resize', resizeAll);
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(resizeAll);
      var paper = document.querySelector('.export-paper');
      if (paper) ro.observe(paper);
    }
  }

  syncThemeUi(readSavedTheme());
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('unk-export-theme', next); } catch (e) {}
      syncThemeUi(next);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateCharts, { once: true });
  } else {
    hydrateCharts();
  }
})();`;

/** Assemble an offline single-file HTML export with strict offline CSP, theme toggle, and optional interactive ECharts runtime. */
export function assembleStandaloneHtml({
  title = '对话记录',
  bodyHtml = '',
  styles = '',
  chartRuntimeScript = '',
  initialTheme = 'light',
} = {}) {
  const safeTitle = escapeHtml(String(title || '对话记录').trim() || '对话记录');
  const safeStyles = safeInlineCss(styles);
  const theme = initialTheme === 'dark' ? 'dark' : 'light';
  const runtimeBlock = chartRuntimeScript
    ? `\n<script>\n${safeInlineScript(chartRuntimeScript)}\n</script>`
    : '';
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;">
<title>${safeTitle} · UNK AI</title>
<style>
${safeStyles}
</style>
</head>
<body>
<main class="export-html-shell">
<div class="export-html-toolbar">
  <button type="button" class="export-theme-toggle" id="unk-export-theme-toggle" aria-label="切换亮暗主题" aria-pressed="${theme === 'dark'}">
    <span class="export-theme-icon" aria-hidden="true"></span>
    <span class="export-theme-label">${theme === 'dark' ? '浅色模式' : '深色模式'}</span>
  </button>
</div>
${bodyHtml}
<footer class="export-html-footer">由 UNK AI 本地离线导出 · 支持亮暗主题切换、交互图表、文字复制与打印另存为 PDF</footer>
</main>${runtimeBlock}
<script>
${safeInlineScript(EXPORT_BOOT_SCRIPT)}
</script>
</body>
</html>
`;
}

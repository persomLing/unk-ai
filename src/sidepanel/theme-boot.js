/**
 * Apply the stored/system theme before the module bundle runs.
 *
 * This lives in its own file because Manifest V3 extension pages enforce
 * `script-src 'self'`; inline scripts are blocked and can prevent the main
 * module from initializing.
 */
(function applyInitialTheme() {
  try {
    const stored = localStorage.getItem('theme');
    const dark = stored
      ? stored === 'dark'
      : Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
  try {
    const cached = JSON.parse(localStorage.getItem('interfacePreferences') || 'null');
    const preferences = cached?.version === 1 ? cached : null;
    const root = document.documentElement;
    root.dataset.font = ['system', 'humanist', 'serif', 'rounded'].includes(preferences?.font) ? preferences.font : 'system';
    root.dataset.bodyFontSize = [12, 13, 14, 16, 18, 20].includes(preferences?.bodyFontSize) ? String(preferences.bodyFontSize) : '13';
    root.dataset.density = ['compact', 'comfortable', 'spacious'].includes(preferences?.density) ? preferences.density : 'comfortable';
    root.dataset.accent = ['forest', 'ocean', 'amber', 'tiffany', 'wine'].includes(preferences?.accent) ? preferences.accent : 'forest';
    const texture = ['none', 'grain'].includes(preferences?.texture) ? preferences.texture : preferences?.grain === true ? 'grain' : 'none';
    root.dataset.texture = texture;
    root.dataset.grain = texture === 'grain' ? 'on' : 'off';
  } catch {
    document.documentElement.dataset.font = 'system';
    document.documentElement.dataset.bodyFontSize = '13';
    document.documentElement.dataset.density = 'comfortable';
    document.documentElement.dataset.accent = 'forest';
    document.documentElement.dataset.texture = 'none';
    document.documentElement.dataset.grain = 'off';
  }
})();

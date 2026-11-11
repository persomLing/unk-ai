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
})();

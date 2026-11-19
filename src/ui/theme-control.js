import { icon } from '../sidepanel/icons.js';

export function paintTheme(document, button, value) {
  const theme = value === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  if (button?.dataset.themeIcon === theme) return;
  try { document.defaultView.localStorage.setItem('theme', theme); } catch {}
  if (!button) return;
  const dark = theme === 'dark';
  button.dataset.themeIcon = theme;
  button.innerHTML = icon(dark ? 'sun' : 'moon');
  button.title = dark ? '切换为亮色模式' : '切换为暗色模式';
  button.setAttribute('aria-label', button.title);
}

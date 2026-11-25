import { escape, isNil, trim } from 'lodash-es';
import { icon } from '../icons.js';

export const $ = (selector) => document.querySelector(selector);

export function text(value) {
  return isNil(value) ? '' : trim(String(value));
}

export function escapeHtml(value) {
  return escape(text(value));
}

export function toast(message, kind = '') {
  const region = $('#toast-region');
  if (!region) return;
  const label = text(message);
  for (const existing of region.querySelectorAll?.('.toast') || []) {
    if (existing.textContent === label) existing.remove?.();
  }
  while ((region.children?.length || 0) >= 2) region.firstElementChild?.remove?.();
  const element = document.createElement('div');
  element.className = `toast ${kind}`.trim();
  element.textContent = label;
  region.append(element);
  setTimeout(() => element.remove?.(), kind === 'error' ? 5500 : 2800);
}

export function renderIcon(container, name = 'file') {
  if (container) container.innerHTML = icon(name);
}

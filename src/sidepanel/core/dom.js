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
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = text(message);
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), kind === 'error' ? 5500 : 3200);
}

export function renderIcon(container, name = 'file') {
  if (container) container.innerHTML = icon(name);
}

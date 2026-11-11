import { clamp, isFinite, isNil, isString, round, trim } from 'lodash-es';

export function plainText(value) {
  return isNil(value) ? '' : String(value);
}

export function safeHttpUrl(value) {
  if (!isString(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function formatTime(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === new Date().toDateString()) return formatTime(timestamp);
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function formatBytes(bytes) {
  if (!isFinite(bytes)) return '';
  if (bytes < 1024) return `${round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, round(bytes / 1024))} KB`;
  return `${round(bytes / 1024 / 1024, 1).toFixed(1)} MB`;
}

export function truncateText(value, length = 34) {
  const source = trim(plainText(value).replace(/\s+/g, ' '));
  const size = clamp(Math.floor(Number(length) || 0), 0, 10_000);
  return source.length > size ? `${source.slice(0, size)}…` : source;
}

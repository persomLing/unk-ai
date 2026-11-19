import { escape } from 'lodash-es';
import { icon } from '../sidepanel/icons.js';

export function emptyState({ symbol, title, hint }) {
  return `<div class="ui-empty"><span class="ui-empty-symbol" aria-hidden="true">${icon(symbol)}</span><strong>${escape(title)}</strong><p>${escape(hint)}</p></div>`;
}

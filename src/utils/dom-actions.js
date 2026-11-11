/**
 * Reserved, deliberately inert DOM action contract.
 *
 * The reader currently only extracts and captures page content. Page-mutating
 * actions must go through a future reviewed executor; nothing in this module
 * can click, type, navigate, or change the DOM today.
 */
export const DOM_ACTION_TYPES = Object.freeze([
  'click',
  'type',
  'scroll',
  'select',
]);

const RISK = Object.freeze({
  click: 'medium',
  type: 'high',
  scroll: 'low',
  select: 'low',
});

export function createDomActionRequest(type, parameters = {}) {
  if (!DOM_ACTION_TYPES.includes(type)) {
    throw new Error(`不支持的 DOM 操作：${type}`);
  }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('DOM 操作参数必须是对象。');
  }
  return {
    kind: 'dom-action',
    type,
    risk: RISK[type],
    parameters,
    requiresConfirmation: RISK[type] !== 'low',
    supported: false,
  };
}

export async function executeDomAction() {
  throw new Error('当前版本只读网页，不执行 DOM 操作。');
}

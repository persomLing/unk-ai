const MODES = new Set(['auto', 'basic', 'deep']);
const STATUSES = new Set(['basic', 'sufficient', 'checked', 'supplemented', 'limited']);
const REASONS = new Set([
  'basic-mode', 'explicit-deep', 'deep-mode', 'body-gap', 'table-gap', 'form-gap',
  'visual-question', 'network-question', 'fact-recheck', 'repeated-correction',
  'style-feedback', 'enough-evidence', 'model-deep', 'model-visual', 'model-network',
  'model-enough', 'decision-unavailable',
]);
const GAPS = new Set([
  'body-truncated', 'table-coverage', 'form-state', 'target-missing', 'visual-evidence',
  'network-evidence', 'deep-unavailable', 'decision-unavailable', 'budget-exhausted', 'context-budget', 'no-new-evidence',
]);
const GAP_LABELS = Object.freeze({
  'body-truncated': '正文存在截断，不能声称已读完整页面',
  'table-coverage': '表格或列表覆盖不全，不能据此声称完整排名或总量',
  'form-state': '部分控件状态未知，不能推断为已选或未选',
  'target-missing': '所问内容尚未得到明确定位证据',
  'visual-evidence': '需要核对图像；图片索引不等于已看到截图',
  'network-evidence': '需要相关接口数据；读取建议不等于已捕获响应',
  'deep-unavailable': '本次未取得可用的深度结构',
  'decision-unavailable': '补读判断未完成，未据此扩大读取',
  'budget-exhausted': '补读已达到时间上限',
  'context-budget': '当前模型窗口不足以容纳补读判断，已跳过该判断',
  'no-new-evidence': '补读没有增加可辨识的新资料',
});

export function normalizeReadingMode(value) {
  return MODES.has(value) ? value : 'auto';
}

/** Only small known fields persist; model prose and arbitrary page fields never become instructions. */
export function normalizeReadingAssessment(value) {
  if (!value || value.version !== 1 || !STATUSES.has(value.status)) return null;
  const result = {
    version: 1,
    mode: normalizeReadingMode(value.mode),
    status: value.status,
    reason: REASONS.has(value.reason) ? value.reason : 'enough-evidence',
    rechecked: value.rechecked === true,
    attempted: Array.isArray(value.attempted) && value.attempted.includes('deep') ? ['deep'] : [],
    addedEvidence: value.addedEvidence === true,
    visualRecommended: value.visualRecommended === true,
    networkRecommended: value.networkRecommended === true,
    gaps: [...new Set((Array.isArray(value.gaps) ? value.gaps : []).filter(gap => GAPS.has(gap)))].slice(0, 8),
  };
  result.note = assessmentNote(result);
  return result;
}

function assessmentNote(value) {
  const notes = [];
  if (value.rechecked) notes.push('本轮重新核验用户指出的事实，应核对来源、单位和计算，不能重复未经证实的结论。');
  if (value.attempted.includes('deep')) notes.push(value.addedEvidence
    ? '已补充本页结构；补读成功不代表所有数据都完整。'
    : '已尝试补读；仍须以实际返回的资料为准。');
  if (value.status === 'basic') notes.push('本轮使用基础页面资料。');
  for (const gap of value.gaps) notes.push(`${GAP_LABELS[gap]}。`);
  return notes.join('').slice(0, 900);
}

/** An advisory coverage record, never a claim that a screenshot or API response was obtained. */
export function readingAssessmentForModel(value) {
  const assessment = normalizeReadingAssessment(value);
  if (!assessment?.note) return '';
  return `<reading_coverage>${assessment.note}</reading_coverage>`;
}

import { observationFeedback } from '../../../utils/agent-evidence.js';

export function agentTargetKey(action, observation) {
  const target = observation?.elements?.find(item => item.id === action.args?.elementId);
  return target?.stableKey || (target
    ? JSON.stringify([target.frameId, target.tag, target.role, target.name, target.fieldName, target.domId])
    : `${action.action}:${action.args?.url || observation?.url || ''}`);
}

function nextTarget(pending, after) {
  const previous = pending.observation?.elements?.find(item => item.id === pending.args?.elementId);
  if (!previous) return null;
  const candidates = (after?.elements || []).filter(item => previous.stableKey
    ? item.stableKey === previous.stableKey
    : item.tag === previous.tag && item.role === previous.role && item.name === previous.name
      && item.frameId === previous.frameId && item.fieldName === previous.fieldName && item.domId === previous.domId);
  return candidates.length === 1 ? candidates[0] : null;
}

export function canVerifyConsumedAgentUpload(action, result) {
  return action === 'upload_reference_image' && result?.error === 'ERR_UPLOAD_UNCERTAIN'
    && result.upload?.requiresAcceptanceVerification === true
    && result.diagnostics?.stages?.some(stage => stage.stage === 'check' && stage.valueMatched === false);
}

/** Only the controlled reader's byte-matched receipt can resolve an uncertain upload. */
export function verifyAgentUploadAcceptance(pending, after, receipt, { taskId, tabId } = {}) {
  const before = pending.observation;
  const scope = pending.result?.upload;
  const target = nextTarget(pending, after);
  const prior = before?.elements?.find(element => element.id === pending.args?.elementId);
  return Boolean(canVerifyConsumedAgentUpload(pending.action, pending.result) && prior?.stableKey && target
    && Number.isInteger(scope.epoch) && scope.epoch > 0 && Number.isInteger(scope.frameId) && scope.frameId >= 0
    && typeof scope.documentId === 'string' && scope.documentId && scope.referenceId === pending.args.referenceId
    && before.url === after?.url && before.documentId && before.documentId === after.documentId
    && after.snapshotId && after.snapshotId !== before.snapshotId && after.tabId === tabId
    && receipt?.version === 1 && receipt.accepted === true && receipt.kind === 'new-matching-preview'
    && receipt.serverConfirmed === false && receipt.actionId === pending.id && receipt.referenceId === pending.args.referenceId
    && receipt.taskId === taskId && receipt.tabId === tabId && receipt.epoch === scope.epoch
    && receipt.documentId === scope.documentId && receipt.frameId === scope.frameId && target.frameId === scope.frameId
    && receipt.url === before.url && receipt.snapshotId === after.snapshotId);
}

/** Verifies a tool's visible effect, not the overall business outcome. */
export function verifyAgentAction(pending, after) {
  if (pending.action !== 'navigate' && (pending.observation?.url !== after?.url
    || (pending.observation?.documentId && pending.observation.documentId !== after?.documentId))) {
    return { verified: false, changed: false, message: '页面或文档已变化，旧操作结果不能作为新页面控件的核验证据。' };
  }
  const feedback = observationFeedback(pending.observation, after, pending);
  const target = nextTarget(pending, after);
  const prior = pending.observation?.elements?.find(item => item.id === pending.args?.elementId);
  if (pending.action === 'select_option') {
    const verified = pending.args.value.length < 160 && Boolean(target?.select?.selected?.some(option =>
      (option.value?.length < 160 && option.value === pending.args.value) || (option.text?.length < 160 && option.text === pending.args.value)));
    return { verified, changed: verified && JSON.stringify(prior?.select?.selected) !== JSON.stringify(target?.select?.selected),
      message: verified ? '已从新观察核对选项当前值。' : '新观察尚未确认选项已生效，请核对当前选项。' };
  }
  if (pending.action === 'click_element' && prior?.state && ['checked', 'pressed', 'expanded'].some(key => key in prior.state)) {
    const changed = ['checked', 'pressed', 'expanded'].some(key => typeof prior.state[key] !== 'undefined'
      && typeof target?.state?.[key] !== 'undefined' && target.state[key] !== prior.state[key]);
    return { verified: changed, changed, message: changed ? '已核对控件状态发生变化。' : '尚未确认目标控件状态变化。' };
  }
  if (pending.action === 'type_text' && pending.args?.submit !== true) {
    const matched = pending.result?.diagnostics?.valueMatched === true
      || pending.result?.diagnostics?.stages?.some(stage => stage.stage === 'check' && stage.valueMatched === true);
    return { verified: Boolean(matched && target), changed: Boolean(matched && target), message: matched && target
      ? '执行器已核对输入值；后续业务结果仍需页面证据。' : '尚未取得输入值匹配的核验结果。' };
  }
  if (pending.action === 'upload_reference_image') {
    const verified = Boolean(target) && (pending.result?.upload?.fileSelected === true || pending.result?.fileSelected === true);
    return { verified, changed: verified, message: verified
      ? '已核对文件进入页面控件；仍需核对网站预览或上传完成状态。' : '尚未确认文件进入页面控件。' };
  }
  if (pending.action === 'wait_for') return { verified: true, changed: false, message: '等待已结束，等待本身不计为任务进展。' };
  return { ...feedback, verified: feedback.changed === true };
}

/** Compare a requested control fact against a fresh, uniquely rematched target. */
export function verifyAgentState(action, before, after) {
  if (before?.url !== after?.url || (before?.documentId && before.documentId !== after?.documentId)) {
    return { ok: false, error: 'ERR_PAGE_CHANGED', message: '页面身份已变化，不能沿用之前的状态核验。' };
  }
  const target = nextTarget({ args: action.args, observation: before }, after);
  if (!target) return { ok: false, error: 'ERR_ELEMENT_NOT_FOUND', message: '未能唯一确认原控件，请根据新观察重新选择目标。' };
  const { field, expected } = action.args;
  let matched = false;
  if (field === 'selectedValue' || field === 'selectedText') {
    matched = expected.length < 160 && Boolean(target.select?.selected?.some(option => (field === 'selectedValue' ? option.value : option.text) === expected));
  } else if (['checked', 'pressed', 'expanded'].includes(field)) {
    matched = ['true', 'false', 'mixed'].includes(expected) && String(target.state?.[field]) === expected;
  } else if (field === 'fileCount') {
    matched = /^\d{1,2}$/.test(expected) && target.fileInput?.selectedFileCount === Number(expected);
  }
  return { ok: matched, ...(matched ? {} : { error: 'ERR_STATE_NOT_MATCHED' }), target,
    message: matched ? '已从新的页面观察核对目标状态。' : '当前控件状态尚不符合目标，请根据新观察继续处理。' };
}

export function needsAgentPlan(goal) {
  const text = String(goal || '');
  const verbs = [/选择|切换|\bselect\b/i, /勾选|开启|启用|\bcheck\b|\benable\b/i,
    /上传|\bupload\b/i, /填写|输入|提示词|\bfill\b|\btype\b|\bprompt\b/i,
    /生成|提交|\bgenerate\b|\bsubmit\b/i, /下载|保存|\bdownload\b|\bsave\b/i,
    /比较|排序|\bcompare\b|\bsort\b/i];
  const mutationCount = verbs.slice(0, 6).filter(pattern => pattern.test(text)).length;
  const numbered = (text.match(/(?:^|\n)\s*\d+[.、)]/g) || []).length >= 3;
  return mutationCount >= 3 || (mutationCount > 0 && numbered);
}

/** Keep provider/model/credentials fixed; increase only already-enabled reasoning. */
export function agentRecoveryProfile(profile) {
  if (profile?.reasoningEnabled !== true || !['minimal', 'low', 'medium'].includes(profile.reasoningEffort)) return null;
  return { ...profile, reasoningEffort: profile.reasoningEffort === 'medium' ? 'high' : 'medium' };
}

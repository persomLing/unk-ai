import { AGENT_ACTIONS, findElement, isSearchForm } from './agent-schema.js';
import { acceptsAgentUpload } from './agent-upload.js';

const PAYMENT = /pay|purchase|buy|order|checkout|billing|payment|subscribe|充值|支付|付款|购买|下单|订单|结算|立即购买|确认支付|订阅/i;
const DESTRUCTIVE = /delete|remove|destroy|discard|注销|删除|移除|清空/i;
const SUBMIT = /submit|send|save|publish|post|confirm|apply|continue|next|提交|发送|保存|发布|确认|应用|继续/i;
const SEARCH = /search|query|find|搜索|查询|检索/i;
const PASSWORD = /password|passwd|pwd|密码|口令/i;
const SECURITY_CODE = /\b(?:cvv|cvc|pin|otp)\b|(?:^|[_-])(?:cvv|cvc|pin|otp)(?:$|[_-])|安全码|校验码|动态口令|一次性密码/i;
const UPLOAD = /upload|上传/i;
const CAPTCHA = /captcha|recaptcha|hcaptcha|验证码|人机验证|verify you are human|not a robot|安全验证/i;
const DOWNLOAD = /\.(?:pdf|zip|rar|7z|csv|xlsx?|docx?|pptx?|exe|dmg)(?:[?#]|$)/i;
const SENSITIVE_AUTOCOMPLETE = /(?:current|new)-password|cc-(?:number|csc|exp|name|type)|one-time-code/i;
const BLOCKED_SCHEMES = /^(?:javascript|data|file|mailto|tel):/i;

function text(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

function elementText(element) {
  return text([
    element?.name,
    element?.text,
    element?.label,
    element?.id,
    String(element?.domId || '').replace(/([a-z])([A-Z])/g, '$1 $2'),
    String(element?.fieldName || '').replace(/([a-z])([A-Z])/g, '$1 $2'),
    element?.autocomplete,
    element?.formAction,
  ].filter(Boolean).join(' '), 800);
}

function isPasswordElement(element) {
  const type = text(element?.type, 30).toLowerCase();
  const autocomplete = text(element?.autocomplete, 80).toLowerCase();
  if (type === 'password') return true;
  if (SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true;
  return ['input', 'textarea'].includes(element?.tag)
    && (PASSWORD.test(elementText(element)) || SECURITY_CODE.test(elementText(element)));
}

function isPaymentElement(element) {
  const autocomplete = text(element?.autocomplete, 80).toLowerCase();
  if (/(?:cc-(?:number|csc|exp|name|type)|one-time-code)/i.test(autocomplete)) return true;
  return PAYMENT.test(elementText(element)) || PAYMENT.test(text(element?.formAction, 300));
}

function isUploadElement(element) {
  return text(element?.type, 30).toLowerCase() === 'file' || UPLOAD.test(elementText(element));
}

function isDestructiveElement(element) {
  return DESTRUCTIVE.test(elementText(element));
}

function isCaptureElement(element) {
  return CAPTCHA.test(elementText(element));
}

function isDownloadElement(element) {
  return element?.download === true || DOWNLOAD.test(text(element?.href, 1000));
}

export function elementTargetOrigin(element) {
  return originOf(element?.formAction) || text(element?.formOrigin, 300)
    || text(element?.targetOrigin, 300) || originOf(element?.href);
}

export function pageOrigin(url) {
  return originOf(url);
}

/**
 * Deterministic risk classification. The model can see the result as a hint,
 * but the executor recomputes it from the current snapshot.
 */
export function classifyElement(element, { currentUrl = '' } = {}) {
  if (!element) return { level: 'blocked', reason: '目标元素不在当前快照中。' };
  if (element.readOnly === true) return { level: 'normal', reason: '只读内容区域，仅用于读取数据。' };
  if (element.disabled) return { level: 'normal', reason: '元素当前禁用，执行会失败。' };

  if (isPasswordElement(element)) {
    return { level: 'blocked', reason: '密码/CVV/PIN 类字段不允许自动输入。' };
  }
  if (isPaymentElement(element)) {
    return { level: 'blocked', reason: '涉及支付/下单/订阅，UNK AI 不会自动执行。' };
  }
  if (isUploadElement(element)) {
    return { level: 'blocked', reason: '文件上传仅可使用专用动作选择本任务已提交的参考图片；其他上传请由用户接管。' };
  }
  if (isCaptureElement(element)) {
    return { level: 'blocked', reason: '检测到验证码/人机验证，必须由用户接管。' };
  }
  if (element.targetBlank === true) {
    return { level: 'blocked', reason: 'P0 不支持在新标签页打开；请改用 navigate 工具打开目标地址。' };
  }

  const href = text(element.href, 1000);
  if ((href && BLOCKED_SCHEMES.test(href)) || BLOCKED_SCHEMES.test(text(element.formAction, 1000))) {
    return { level: 'blocked', reason: '这个链接协议不允许自动打开。' };
  }

  const targetOrigin = elementTargetOrigin(element);
  const currentOrigin = originOf(currentUrl);
  const crossOrigin = Boolean(targetOrigin && currentOrigin && targetOrigin !== currentOrigin);
  if (crossOrigin) {
    return {
      level: 'confirm',
      reason: `将访问其他站点 ${targetOrigin}，需要授权并确认。`,
      targetOrigin,
    };
  }

  const search = isSearchForm(element) || SEARCH.test(elementText(element));
  if (isDestructiveElement(element)) {
    return { level: 'confirm', reason: '删除/移除类操作需要逐次确认。' };
  }
  if (isDownloadElement(element)) {
    return { level: 'confirm', reason: '可能触发下载，需要确认。' };
  }
  if ((SUBMIT.test(elementText(element)) || element.type === 'submit') && !search) {
    return { level: 'confirm', reason: '提交/发送类操作需要逐次确认。' };
  }
  return { level: 'normal', reason: '' };
}

function targetFor(args, elements) {
  return findElement(elements, args?.elementId);
}

function strictConfirm(settings) {
  return settings?.strictMode === true ? { level: 'confirm', reason: '严格模式：每个页面动作都需要确认。' } : null;
}

/**
 * Assess one normalized action. The caller must still enforce origin grants
 * and user confirmation; this function only classifies risk.
 */
export function assessAgentAction({
  action,
  args = {},
  elements = [],
  settings = {},
  currentUrl = '',
  uploadReferences = [],
} = {}) {
  if (action === AGENT_ACTIONS.finish || action === AGENT_ACTIONS.fail || action === AGENT_ACTIONS.handoff) {
    return { level: 'normal', reason: '' };
  }
  if (action === AGENT_ACTIONS.wait || action === AGENT_ACTIONS.read) {
    return { level: 'normal', reason: '' };
  }
  if (action === AGENT_ACTIONS.scroll) {
    return { level: 'normal', reason: '' };
  }
  if (action === AGENT_ACTIONS.navigate) {
    const targetOrigin = originOf(args.url);
    if (!targetOrigin) return { level: 'blocked', reason: '只允许导航到 http/https 地址。' };
    const currentOrigin = originOf(currentUrl);
    if (currentOrigin && targetOrigin !== currentOrigin) {
      return {
        level: 'confirm',
        reason: `将离开当前站点并访问 ${targetOrigin}，需要授权并确认。`,
        targetOrigin,
      };
    }
    return strictConfirm(settings) || { level: 'normal', reason: '' };
  }

  const target = targetFor(args, elements);
  if (action === 'read_region') return target?.readable && target?.readOnly
    ? { level: 'normal', reason: '' } : { level: 'blocked', reason: '只能读取观察中明确标注的区域。' };
  if (target?.readOnly === true) return { level: 'blocked', reason: '这是只读内容区域，不能作为点击或输入目标。' };
  if (target?.scrollOnly === true) {
    return { level: 'blocked', reason: '这是滚动容器，请使用 scroll_page；不能把容器当作按钮、输入框或选项。' };
  }
  if (action === 'upload_reference_image') {
    if (!target || target.tag !== 'input' || target.type !== 'file' || target.disabled || !target.fileInput) {
      return { level: 'blocked', reason: '只能上传到当前观察中可用的原生文件输入框，其他上传方式请由用户接管。' };
    }
    if (Object.keys(args).some(key => !['elementId', 'referenceId'].includes(key)) || !/^reference-[1-3]$/.test(args.referenceId || '')) {
      return { level: 'blocked', reason: '上传只能指定本任务参考图片编号，不接受路径、网址或文件数据。' };
    }
    const reference = Array.isArray(uploadReferences) && uploadReferences.find(value => value?.referenceId === args.referenceId);
    if (!reference || !Number.isInteger(reference.size) || reference.size <= 0 || reference.size > 8 * 1024 * 1024
      || target.fileInput.directory === true || !acceptsAgentUpload(target.fileInput.accept, reference)) {
      return { level: 'blocked', reason: '参考图片不可用，或文件类型不符合这个上传控件的要求。' };
    }
    if (isPasswordElement(target) || isPaymentElement(target) || isCaptureElement(target) || target.targetBlank === true
      || BLOCKED_SCHEMES.test(text(target.formAction, 1000))) {
      return { level: 'blocked', reason: '涉及敏感字段、支付或人机验证，必须由用户接管上传。' };
    }
    const origin = originOf(currentUrl);
    const destination = elementTargetOrigin(target);
    if (!origin || (destination && destination !== origin) || (target.frameOrigin && target.frameOrigin !== origin)) {
      return { level: 'blocked', reason: '参考图片只能上传到当前已登记站点的同源页面。' };
    }
    return { level: 'confirm', reason: '将把本任务已提交的参考图片交给这个网站，需要逐次确认；网站可能立即开始上传。' };
  }
  if (action === AGENT_ACTIONS.type) {
    if (!target) return { level: 'blocked', reason: '目标元素不在当前快照中。' };
    const classified = classifyElement(target, { currentUrl });
    if (classified.level === 'blocked') return classified;
    const search = isSearchForm(target);
    if (args.submit === true && !search) {
      return { ...classified, level: 'confirm', reason: '输入后提交会改变页面，需要逐次确认。' };
    }
    return classified.level === 'confirm' ? classified : strictConfirm(settings) || classified;
  }

  if (action === AGENT_ACTIONS.click || action === AGENT_ACTIONS.select) {
    if (!target) return { level: 'blocked', reason: '目标元素不在当前快照中。' };
    const classified = classifyElement(target, { currentUrl });
    if (classified.level === 'blocked') return classified;
    return classified.level === 'confirm' ? classified : strictConfirm(settings) || classified;
  }

  if (action === AGENT_ACTIONS.press) {
    if (target) {
      const classified = classifyElement(target, { currentUrl });
      if (classified.level !== 'normal') return classified;
    }
    if (args.key === 'Enter') {
      return { level: 'confirm', reason: '回车可能触发表单提交，需要确认。' };
    }
    return strictConfirm(settings) || { level: 'normal', reason: '' };
  }

  return { level: 'blocked', reason: '未知动作。' };
}

export function requiresApproval(level) {
  return level === 'confirm';
}

export const IMAGE_MODEL_REQUIRED = '未配置生图模型，请先在设置中选择默认生图模型。';
export const IMAGE_PROMPT_LIMIT = 4000;
export const IMAGE_TURN_TIMEOUT_MS = 10 * 60 * 1000;
export const IMAGE_DRAFT_PREFIX = '生成图片：\n';
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

export function parseDirectImageCommand(question) {
  const source = String(question || '').trim();
  if (source.startsWith(IMAGE_DRAFT_PREFIX)) return { prompt: source.slice(IMAGE_DRAFT_PREFIX.length).trim() };
  const command = source.match(/^(?:(?:请帮我|帮我|请)\s*)?(?:生图|生成(?:一张)?(?:图片|图像))(?=$|\s|[:：]|[呀啊吧！!。]+$)\s*[:：]?\s*([\s\S]*)$/u);
  if (!command) return null;
  const prompt = command[1].trim().replace(/^[呀啊吧！!。]+$/u, '');
  if (/^(?:(?:模型|功能|接口|教程|提示词|prompt)\s*(?:的\s*)?)?(?:怎么|如何|怎样|为什么|是什么|是什么意思|是否|能否|配置方法|使用方法|how\b|what\b|why\b)/iu.test(prompt)
    || /^的\s*(?:费用|价格|成本|方法|教程|步骤|工具|软件|接口|功能|模型|提示词)/u.test(prompt)
    || /(?:只|仅)(?:要|需|需要)?(?:帮我)?(?:输出|写|整理|优化|改写|润色|修改|完善)(?:一下)?(?:提示词|prompt)/iu.test(prompt)
    || /(?:不要|不用|不必|无需|别)(?:直接)?(?:生图|画图|生成(?:图片|图像|图))/u.test(prompt)) return { skip: true };
  return { prompt };
}

export function directImageForMessage(message) {
  if (message?.pageCommand || message?.agentTask) return null;
  const command = parseDirectImageCommand(message?.displayContent ?? message?.content);
  return command && !command.skip ? command : null;
}

export function imageReferenceData(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 32) {
    throw new Error('参考图不可用或超过 8 MiB，请重新添加。');
  }
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new Error('参考图必须是可读取的 PNG、JPEG 或 WebP 图片。');
  const [, mediaType, encoded] = match;
  const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (!bytes || bytes > MAX_REFERENCE_BYTES || encoded.length % 4 === 1 || (encoded.endsWith('=') && encoded.length % 4 !== 0)) {
    throw new Error('参考图不可用或超过 8 MiB，请重新添加。');
  }
  return { mime: mediaType.toLowerCase().replace('image/jpg', 'image/jpeg'), encoded };
}

export function imageReferenceForGeneration(attachments = []) {
  if (attachments.some(item => item?.type !== 'image')) throw new Error('生成图片只使用提示词和参考图，请先移除其他附件。');
  if (attachments.length > 1) throw new Error('每次生图最多使用一张参考图，请先移除多余图片。');
  if (!attachments.length) return undefined;
  const { dataUrl } = attachments[0];
  imageReferenceData(dataUrl);
  return dataUrl;
}

export function assertImageCommand(command, attachments, profile) {
  if (!profile?.imageProfile?.model) throw new Error(IMAGE_MODEL_REQUIRED);
  if (!command?.prompt) throw new Error('请填写想生成的画面，或添加参考图后描述要修改的地方。');
  if (command.prompt.length > IMAGE_PROMPT_LIMIT) throw new Error(`生图描述过长（上限 ${IMAGE_PROMPT_LIMIT} 字），请缩短后重新提交。`);
  return imageReferenceForGeneration(attachments);
}

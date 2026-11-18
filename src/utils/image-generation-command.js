export const IMAGE_MODEL_REQUIRED = '未配置生图模型，请先在设置中选择默认生图模型。';

export function parseDirectImageCommand(question) {
  const command = String(question || '').trim().match(/^(?:(?:请帮我|帮我|请)\s*)?生图(?=$|\s|[:：])\s*[:：]?\s*([\s\S]*)$/u);
  if (!command) return null;
  const prompt = command[1].trim();
  if (/^(?:(?:模型|功能|接口|教程|提示词|prompt)\s*(?:的\s*)?)?(?:怎么|如何|怎样|为什么|是什么|是什么意思|是否|能否|配置方法|使用方法|how\b|what\b|why\b)/iu.test(prompt)
    || /(?:只|仅)(?:要|需|需要)?(?:帮我)?(?:输出|写|整理|优化|改写|润色|修改|完善)(?:一下)?(?:提示词|prompt)/iu.test(prompt)
    || /(?:不要|不用|不必|无需|别)(?:直接)?(?:生图|画图|生成(?:图片|图像|图))/u.test(prompt)) return { skip: true };
  return { prompt };
}

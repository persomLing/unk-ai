import { assertImageCommand, directImageForMessage, IMAGE_MODEL_REQUIRED } from '../../../utils/image-generation-command.js';
import { safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { createIllustrationLayout, illustrationDimensions } from './illustration-layout.js';

export function createImageReply({ repository, getProfile, makeId = () => crypto.randomUUID() }) {
  return ({ run, profile, modelRun, assertOwner }) => run.execute(async () => {
    const assertCurrent = () => {
      run.assertCurrent();
      assertOwner();
      const pair = repository.get(run.ref);
      if (!pair) throw new DOMException('本轮生图已被替换。', 'AbortError');
      return pair;
    };
    const { user } = assertCurrent();
    const command = directImageForMessage(user);
    const referenceImage = assertImageCommand(command, user.attachments || [], profile);
    if (!getProfile()?.imageProfile?.model) throw new Error(IMAGE_MODEL_REQUIRED);
    const model = profile.imageProfile.model;
    const aspectRatio = command.prompt.match(/(?<!\d)(16\s*[:：]\s*9|1\s*[:：]\s*1)(?!\d)/u)?.[1].replace(/\s/g, '').replace('：', ':');
    const layout = createIllustrationLayout({ aspectRatio });
    run.update({ model, modelId: model, reasoningEffort: undefined });
    run.phase('generating-image', referenceImage ? '正在使用参考图' : undefined);
    assertCurrent();
    const image = await modelRun.request({ requestId: 'image', purpose: 'image-generation', prompt: command.prompt,
      ...(referenceImage ? { referenceImage } : {}), size: aspectRatio === '1:1' ? '1024x1024' : 'auto' });
    assertCurrent();
    const dataUrl = safeAttachmentDataUrl(image?.dataUrl);
    if (!dataUrl) throw new Error('生图服务没有返回可显示的图片。');
    return { content: referenceImage ? '已根据参考图生成新图片。' : '图片已生成。',
      attachments: [{ id: makeId(), type: 'image', name: '生成图片', dataUrl, generated: true,
        illustrationLayout: layout, ...illustrationDimensions(image) }] };
  });
}

import { assertImageCommand, directImageForMessage, IMAGE_MODEL_REQUIRED } from '../../../utils/image-generation-command.js';
import { safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { imageReplyLayout, illustrationDimensions } from './illustration-layout.js';

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
    const layout = imageReplyLayout(command.prompt);
    run.update({ model, modelId: model, reasoningEffort: undefined });
    run.phase('generating-image', referenceImage ? '正在使用参考图' : undefined);
    assertCurrent();
    const image = await modelRun.request({ requestId: 'image', purpose: 'image-generation', prompt: command.prompt,
      ...(referenceImage ? { referenceImage } : {}), size: layout.aspectRatio === '1:1' ? '1024x1024' : 'auto' });
    assertCurrent();
    const dataUrl = safeAttachmentDataUrl(image?.dataUrl);
    if (!dataUrl) throw new Error('生图服务没有返回可显示的图片。');
    const briefPrompt = command.prompt.replace(/\s+/g, ' ').trim();
    const shortDesc = briefPrompt.length > 80 ? `${briefPrompt.slice(0, 80)}…` : briefPrompt;
    return { content: referenceImage ? `已根据参考图生成图片：${shortDesc}` : `已为你生成图片：${shortDesc}`,
      attachments: [{ id: makeId(), type: 'image', name: shortDesc || '生成图片', dataUrl, generated: true,
        illustrationLayout: layout, ...illustrationDimensions(image) }] };
  });
}

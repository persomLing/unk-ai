import { assertPageTarget } from '../../../utils/page-target.js';
import { captureVideoRequest, hasVideoTranscript, validateVideoResult } from './video-request.js';
import { canScanFrames } from './video-scan-protocol.js';
import { VIDEO_NOTES_LABEL, VIDEO_FRAME_LABEL } from './video-notes-command.js';

const LABELS = Object.freeze({ scan: VIDEO_FRAME_LABEL, partial: '先用已扫描画面整理', continue: '继续扫描' });

function frameActionState(message, conversation, getRecovery) {
  if (message?.role !== 'assistant' || !conversation || message.videoNotesVersion !== 1) return null;
  const index = conversation.messages.findIndex(item => item.id === message.id);
  const user = index > 0 ? conversation.messages[index - 1] : null;
  if (user?.role !== 'user' || (message.turnId && message.turnId !== user.turnId)) return null;
  try {
    const request = captureVideoRequest(user.pageCommand);
    if (request.frameFallback) {
      if (hasVideoTranscript(user.attachments)) return null;
      const recoverable = (message.status === 'complete' && message.videoNotesOutcome === 'scan-interrupted') || message.status === 'error';
      const recovery = recoverable && getRecovery({ conversationId: conversation.id, userId: user.id, turnId: user.turnId }, request.frameOffer);
      return { hideRetry: true, actions: recovery ? ['partial', 'continue'].filter(action => recovery[action]) : [] };
    }
    if (message.status !== 'complete' || message.videoNotesOutcome !== 'unavailable') return null;
    const offer = validateVideoResult(message.videoFrameOffer, request.target);
    if (offer.kind !== 'unavailable' || !canScanFrames(offer.reason)) return null;
    return { actions: ['scan'], request: captureVideoRequest({ ...request, frameFallback: true, frameOffer: offer }),
      prompt: user.displayContent && user.displayContent !== VIDEO_NOTES_LABEL ? user.displayContent : VIDEO_FRAME_LABEL };
  } catch { return null; }
}

export function videoFrameActionsFor(message, conversation, getRecovery) {
  const state = frameActionState(message, conversation, getRecovery);
  return state ? { hideRetry: state.hideRetry, buttons: state.actions.map(action => ({ action: `video-frame-${action}`, label: LABELS[action] })) } : null;
}

export function createVideoFrameActions({ dialog, getConversation, getState, getRecovery, submit, regenerate, leaveAgent, notify, createId }) {
  let pending = false, disposed = false;
  function capture(conversation, assistantId, action) {
    const message = conversation?.messages.find(item => item.id === assistantId);
    const data = frameActionState(message, conversation, getRecovery);
    if (!data?.actions.includes(action)) throw new Error('这条消息没有可用的画面扫描资料，请回原视频重新读取。');
    const state = getState();
    if (!state.ready || state.busy) throw new Error('请等待当前任务完成或停止后再识别画面。');
    if (!state.supportsVision) throw new Error('请先在设置中配置并选择支持图片输入的视觉模型。');
    if (action === 'scan') {
      if (!state.pageEnabled) throw new Error('请回到原视频并开启“基于当前页”。');
      assertPageTarget({ tabId: data.request.target.tabId, url: data.request.target.url }, state.target || {});
      if (state.target.documentId) assertPageTarget(data.request.target, state.target);
    } else if (action === 'continue' && !state.pagePreference) throw new Error('请先开启“基于当前页”，再继续扫描。');
    return { data, runId: message.runId };
  }

  function confirm(action) {
    dialog.querySelector('h2').textContent = LABELS[action];
    dialog.querySelector('[data-frame-consent-scan]').hidden = action === 'partial';
    dialog.querySelector('[data-frame-consent-resume]').hidden = action !== 'continue';
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'start'), { once: true }));
  }

  async function activate(assistantId, action) {
    if (pending || disposed) return;
    pending = true;
    try {
      const original = getConversation();
      const initial = capture(original, assistantId, action);
      if (!await confirm(action) || disposed || getConversation()?.id !== original.id) return;
      const { data, runId } = capture(getConversation(), assistantId, action);
      if (runId !== initial.runId) return;
      leaveAgent();
      if (action === 'scan') await submit(data.prompt, { pageCommand: data.request, commandId: createId() });
      else await regenerate(assistantId, { preparationAction: action });
    } catch (error) { if (!disposed) notify(error.message || '无法开始画面识别。', 'error'); }
    finally { pending = false; }
  }
  return Object.freeze({ activate, dispose() { disposed = true; if (dialog.open) dialog.close(); } });
}

const PHASE_LABELS = {
  preparing: '正在准备请求',
  reading: '正在读取网页',
  'checking-evidence': '正在核对页面资料',
  'reading-deep': '正在补充页面结构',
  'reading-network': '正在等待本页新的接口数据',
  'reading-index': '正在读取页面目录',
  'reading-related': '正在读取相关章节',
  researching: '正在查找并读取站内相关文章',
  'checking-research': '正在判断是否需要联网',
  'web-research': '正在搜索并读取公开网页',
  saving: '正在保存消息',
  compressing: '正在整理历史消息',
  'collecting-context': '正在收集补充资料',
  'waiting-model': '正在等待模型输出',
  'generating-image': '正在生成图片',
};

const VIDEO_PHASE_LABELS = {
  reading: '正在读取视频字幕',
  'scanning-video': '正在扫描视频画面',
  'recognizing-video': '正在识别视频画面',
  'collecting-context': '正在整理视频资料',
  'waiting-model': '正在整理视频笔记',
};

export function formatElapsedSeconds(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours && `${hours} 小时`, minutes && `${minutes} 分`, `${seconds % 60} 秒`].filter(Boolean).join(' ');
}

function formatSettledDuration(durationMs) {
  return durationMs < 1000 ? '不足 1 秒' : formatElapsedSeconds(Math.floor(durationMs / 1000));
}

export function agentElapsedLabel(agent, now = Date.now()) {
  const startedAt = Date.parse(agent?.startedAt);
  if (!Number.isFinite(startedAt)) return '';
  if (['preparing', 'running', 'paused'].includes(agent.status)) {
    return `已用时 ${formatElapsedSeconds(Math.max(0, Math.floor((now - startedAt) / 1000)))}`;
  }
  if (!['finished', 'failed', 'cancelled'].includes(agent.status)) return '';
  const finishedAt = Date.parse(agent.finishedAt);
  if (!Number.isFinite(finishedAt) || finishedAt < startedAt) return '';
  return `任务历时 ${formatSettledDuration(finishedAt - startedAt)}`;
}

export function replyElapsedLabel(message, now = Date.now()) {
  if (message?.agent) return message.agent.finishedAt ? agentElapsedLabel(message.agent, now) : '';
  const timing = message?.replyTiming;
  if (timing?.version !== 1) return '';
  if (message.status === 'streaming') {
    if (!Number.isSafeInteger(timing.startedAt) || timing.startedAt < 0) return '';
    return `已用时 ${formatElapsedSeconds(Math.max(0, Math.floor((now - timing.startedAt) / 1000)))}`;
  }
  if (!Number.isSafeInteger(timing.durationMs) || timing.durationMs < 0) return '';
  return `总耗时 ${formatSettledDuration(timing.durationMs)}`;
}

export function replyProgress(message, now = Date.now()) {
  if (message?.status !== 'streaming' || message.agent) return null;
  const hasOutput = Boolean(message.content || message.reasoning);
  const phase = message.requestPhase || (hasOutput ? '' : 'waiting-model');
  if (!phase || phase === 'reasoning' || phase === 'answering') return null;
  const elapsed = Number.isSafeInteger(message.phaseStartedAt) && message.phaseStartedAt >= 0
    ? Math.max(0, Math.floor((now - message.phaseStartedAt) / 1000)) : 0;
  const videoLabel = message.videoNotesVersion === 1
    ? VIDEO_PHASE_LABELS[phase] : '';
  const detail = (videoLabel || phase === 'generating-image') && message.requestPhaseDetail ? ` · ${message.requestPhaseDetail}` : '';
  const label = phase === 'waiting-model' && hasOutput ? '正在等待模型继续输出'
    : videoLabel || PHASE_LABELS[phase] || PHASE_LABELS['waiting-model'];
  const note = phase === 'waiting-model' && elapsed >= 15
    ? (hasOutput ? ' 尚未收到新内容。' : ' 尚未收到正文或思考内容。') : '';
  return { label, details: `${detail}${elapsed ? ` · 本阶段 ${formatElapsedSeconds(elapsed)}` : ''}…${note}` };
}

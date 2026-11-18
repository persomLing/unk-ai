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
};

/** Actual preparation/waiting progress is distinct from received model reasoning. */
export function replyProgressLabel(message, now = Date.now()) {
  if (message?.status !== 'streaming' || message.content || message.reasoning || message.agent) return '';
  const phase = message.requestPhase || 'waiting-model';
  const elapsed = message.phaseStartedAt ? Math.max(0, Math.floor((now - message.phaseStartedAt) / 1000)) : 0;
  const videoLabel = message.videoNotesVersion === 1
    ? ({ reading: '正在读取视频字幕', 'scanning-video': '正在扫描视频画面', 'recognizing-video': '正在识别视频画面',
      'collecting-context': '正在核对视频资料', 'waiting-model': '正在整理视频笔记' })[phase] : '';
  const detail = videoLabel && message.requestPhaseDetail ? ` · ${message.requestPhaseDetail}` : '';
  const label = `${videoLabel || PHASE_LABELS[phase] || PHASE_LABELS['waiting-model']}${detail}${elapsed ? ` · ${elapsed} 秒` : ''}…`;
  return phase === 'waiting-model' && elapsed >= 15 ? `${label} 尚未收到正文或思考内容。` : label;
}

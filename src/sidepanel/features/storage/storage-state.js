/**
 * Local-folder state and prompt copy.
 *
 * File System Access handles survive a browser restart, but permission may
 * return to "prompt". That is not the same as "no folder selected", so the two
 * states must render different actions.
 */

export function storageSetupState(info) {
  if (!info || !info.supported) {
    return {
      kind: 'unsupported',
      hidden: false,
      title: '当前浏览器不支持本地文件夹',
      action: 'settings',
    };
  }
  if (!info.configured) {
    return {
      kind: 'missing',
      hidden: false,
      title: '先在设置中选择本地对话存储文件夹',
      action: 'settings',
    };
  }
  if (!info.granted) {
    return {
      kind: 'permission',
      hidden: false,
      title: '本地文件夹需要重新授权',
      action: 'reauthorize',
    };
  }
  return {
    kind: 'ready',
    hidden: true,
    title: '',
    action: '',
  };
}

export function storageBadgeState(info, { temporary = true, conversationName = '', syncStatus, syncError, directoryName } = {}) {
  const granted = Boolean(info?.granted);
  const configured = Boolean(info?.configured);
  const folder = String(directoryName || info?.name || '').trim();
  if (syncStatus === 'error') {
    return { icon: 'info', label: '尚未保存 · 请勿关闭侧栏', title: syncError || '浏览器存储写入失败，请导出会话。', saveVisible: true };
  }
  if (syncStatus === 'pending') {
    return {
      icon: 'history', label: '已保存在浏览器 · 文件夹待同步',
      title: syncError || '内容已写入浏览器的持久化队列，文件夹恢复后重试。',
      saveVisible: false,
    };
  }
  if (!temporary) {
    return {
      icon: 'folder',
      label: `已保存 · ${folder || '本地文件夹'}`,
      title: `保存位置：${folder || '本地文件夹'}/conversations`,
      saveVisible: false,
    };
  }
  return {
    icon: 'history',
    label: granted
      ? '临时对话 · 自动保存到本地'
      : configured
        ? '本地文件夹待授权'
        : '临时对话 · 浏览器',
    title: granted
      ? '第一条消息发送后，会保存到已选择的本地文件夹'
      : configured
        ? `已选择“${folder || '本地文件夹'}”，点击提示条恢复权限`
        : '请先在设置中选择本地对话存储文件夹',
    saveVisible: granted && Boolean(conversationName),
  };
}

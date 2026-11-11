export function isReadablePageUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return false;
    if (url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) return false;
    return true;
  } catch { return false; }
}

/** Navigation changes availability, never the user's reading preference. */
export function pageContextEnabledForNavigation(previous, next, enabled = true) {
  return isReadablePageUrl(next?.url) && enabled !== false;
}

export function pageFaviconUrl(active) {
  if (!isReadablePageUrl(active?.url)) return '';
  const favicon = String(active?.favIconUrl || '');
  if (/^data:image\/(?:png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i.test(favicon)) return favicon;
  try {
    const icon = new URL(favicon);
    if (['http:', 'https:'].includes(icon.protocol) && !icon.username && !icon.password) return icon.href;
  } catch {}
  try {
    const page = new URL(active.url);
    return ['http:', 'https:'].includes(page.protocol) ? new URL('/favicon.ico', page).href : '';
  } catch { return ''; }
}

export function pageControlState({ active, page, enabled = true, reading = false, activity, draftPageChanged = false } = {}) {
  const url = active?.url || '';
  const available = isReadablePageUrl(url);
  const tabId = value => value?.tabId ?? value?.id;
  const different = value => Boolean(value?.url && (value.url !== url
    || Number.isInteger(tabId(value)) && Number.isInteger(tabId(active)) && tabId(value) !== tabId(active)));
  const changed = available && (draftPageChanged || different(page));
  const sameRead = activity && !different(activity.target);
  const readStatus = sameRead ? activity.status : null;
  const readingOther = activity?.status === 'reading' && !sameRead;
  let domain = '';
  try { domain = new URL(url).hostname || '本地文件'; } catch {}
  return {
    available, changed, url,
    title: active?.title || domain || '当前没有可读取的页面',
    domain: domain || '当前网页',
    label: enabled && available ? '基于当前页' : '普通提问',
    status: !available ? '当前页面不可读取 · 可继续普通提问'
      : !enabled ? '不读取当前网页 · 需要时可开启'
        : readingOther ? '正在读取已提交的原页 · 下次发送使用此页'
          : readStatus === 'reading' || reading ? '正在读取本轮页面…'
            : readStatus === 'failed' ? '页面读取失败 · 可重试，或关闭后重新提问'
              : readStatus === 'stopped' ? '读取已停止 · 下次发送重新读取'
                : changed ? '页面已切换 · 发送时将使用此页'
                  : readStatus === 'read' ? '已读取本轮页面 · 下次发送重新读取'
                    : '发送时读取页面，回答将结合页面内容',
  };
}

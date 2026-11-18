import { awaitWithTimeout } from '../../../utils/abortable.js';
import { icon } from '../../icons.js';

const pending = new WeakSet();

export function decorateCodeBlocks(fragment) {
  for (const code of fragment.querySelectorAll('pre > code')) {
    if (!code.textContent) continue;
    const pre = code.parentElement;
    const document = code.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.className = 'message-code-block';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-code-copy';
    button.dataset.action = 'copy-code';
    button.title = '复制代码';
    button.setAttribute('aria-label', '复制代码');
    button.innerHTML = icon('copy');
    pre.replaceWith(wrapper);
    wrapper.append(pre, button);
  }
}

export async function copyCodeBlock(button, { writeText, notify }) {
  const code = button.parentElement?.querySelector(':scope > pre > code');
  const text = code?.textContent;
  if (!text || pending.has(button)) return;
  pending.add(button);
  try {
    await awaitWithTimeout(writeText(text), { timeoutMs: 3000, message: '复制等待超时，请检查剪贴板。' });
    if (!button.isConnected || code.textContent !== text) return;
    button.innerHTML = icon('check');
    notify('已复制代码');
    setTimeout(() => { if (button.isConnected) button.innerHTML = icon('copy'); }, 1500);
  } catch (error) {
    if (button.isConnected) notify(error?.name === 'TimeoutError' ? error.message : '复制失败，请手动选择代码。', 'error');
  } finally { pending.delete(button); }
}

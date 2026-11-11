function string(value) {
  return typeof value === 'string' ? value : '';
}

/** Escape text that is placed in Markdown inline or heading contexts. */
function escapeMarkdown(value) {
  return string(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]<>])/g, '\\$1')
    .replace(/^(\s{0,3})(#{1,6}|[-+]|\d+[.)])(\s)/gm, '$1\\$2$3')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function inline(value) {
  return escapeMarkdown(value).replace(/[\u2028\u2029]/g, ' ');
}

function safeUrl(value) {
  const url = string(value).trim();
  // Destination escaping keeps parentheses from changing Markdown structure.
  return url.replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/[\s<>]/g, (character) => encodeURIComponent(character));
}

function filenamePart(value) {
  const cleaned = string(value)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[#\[\]()&]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. -]+$/g, '')
    .replace(/^[-. ]+/g, '')
    .trim();
  return cleaned.slice(0, 80) || 'conversation';
}

function shortId(value) {
  const cleaned = string(value).replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned.slice(0, 8) || 'unknown';
}

function messageContent(content) {
  return string(content)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '\uFFFD')
    .trim();
}

/** Export only conversation data; provider configuration is never read. */
export function exportConversationMarkdown(conversation) {
  if (!conversation || typeof conversation !== 'object') {
    throw new TypeError('A conversation is required.');
  }

  const createdAt = string(conversation.createdAt) || string(conversation.updatedAt);
  const date = /^\d{4}-\d{2}-\d{2}/.test(createdAt)
    ? createdAt.slice(0, 10)
    : 'undated';
  const title = string(conversation.title) || 'Untitled conversation';
  const lines = [`# ${inline(title)}`, ''];

  if (conversation.pageContext && typeof conversation.pageContext === 'object') {
    const pageTitle = inline(conversation.pageContext.title);
    const url = safeUrl(conversation.pageContext.url);
    if (pageTitle && url) lines.push(`Source: [${pageTitle}](${url})`);
    else if (url) lines.push(`Source: ${url}`);
    else if (pageTitle) lines.push(`Source: ${pageTitle}`);
    lines.push('');
  }
  if (createdAt) lines.push(`Created: ${inline(createdAt)}`, '');

  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? 'Assistant' : 'User';
    lines.push(`## ${role}`, '');
    lines.push(messageContent(message.content) || '_(No content)_', '');
    if (message.agent) {
      const agent = message.agent;
      const steps = Array.isArray(agent.steps) ? agent.steps : [];
      lines.push(`### Browser task: ${inline(agent.goal || '')}`, '');
      if (steps.length) {
        for (const step of steps) {
          const detail = step.detail ? ` — ${inline(step.detail)}` : '';
          lines.push(`- ${inline(step.title || '')}${detail}`);
        }
        lines.push('');
      }
    }
    if (message.model) lines.push(`Model: ${inline(message.model)}`, '');
    if (message.status && message.status !== 'complete') {
      lines.push(`Status: ${inline(message.status)}`, '');
    }
  }

  return {
    filename: `${date}-${filenamePart(title)}-${shortId(conversation.id)}.md`,
    content: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
  };
}

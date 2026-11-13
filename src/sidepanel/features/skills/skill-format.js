/** SKILL.md is imported as bounded reference text, never as executable code.
 * This deliberately supports a small YAML subset, not a general YAML runtime.
 * A clean scan means only that no known dependency was found. */
export const SKILL_LIMITS = Object.freeze({
  maxBytes: 65536, maxBodyChars: 12000, maxNameChars: 120, maxDescriptionChars: 1000,
});

const simpleKeys = new Set(['name', 'description', 'allowed-tools', 'metadata', 'license']);
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const error = (message, code = 'ERR_SKILL_FORMAT') => Object.assign(new Error(message), { code });
const excerpt = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);

function withoutComment(source) {
  let quote = null;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote === '"' && character === '\\') { index++; continue; }
    if (quote === "'" && character === "'" && source[index + 1] === "'") { index++; continue; }
    if (quote === character) { quote = null; continue; }
    if (!quote && (character === '"' || character === "'")) { quote = character; continue; }
    if (!quote && character === '#' && (index === 0 || /\s/.test(source[index - 1]))) return source.slice(0, index).trim();
  }
  return source.trim();
}

function scalar(source) {
  const value = withoutComment(source);
  if (!value) return { ok: true, value: '' };
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return { ok: typeof parsed === 'string', value: parsed };
    } catch { return { ok: false }; }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) return { ok: false };
    return { ok: true, value: value.slice(1, -1).replace(/''/g, "'") };
  }
  if (/^[!&*\[\]{}>|]/.test(value) || /:\s/.test(value)) return { ok: false };
  const plain = value.trim();
  if (/^(?:true|false)$/i.test(plain)) return { ok: true, value: plain.toLowerCase() === 'true' };
  if (/^(?:null|~)$/i.test(plain)) return { ok: true, value: null };
  if (/^[+-]?\d+(?:\.\d+)?$/.test(plain)) return { ok: true, value: Number(plain) };
  return { ok: true, value: plain };
}

function inlineList(source) {
  const value = withoutComment(source);
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const parts = inner.match(/"(?:\\.|[^"\\])*"|'(?:[^']|'')*'|[^,]+/g) || [];
  if (parts.join(',').replace(/\s/g, '') !== inner.replace(/\s/g, '')) return null;
  const parsed = parts.map(item => scalar(item.trim()));
  return parsed.every(item => item.ok && typeof item.value === 'string') ? parsed.map(item => item.value) : null;
}

function textField(group) {
  if (/^[|>][-+]?$/.test(group.value.trim())) {
    const meaningful = group.children.filter(line => line.trim());
    if (meaningful.some(line => !/^ +/.test(line))) return { ok: false };
    const indent = Math.min(...meaningful.map(line => line.match(/^ */)[0].length));
    const lines = group.children.map(line => line.slice(Math.min(indent, line.length)));
    const joined = group.value.trim()[0] === '>' ? lines.join(' ').replace(/ +/g, ' ') : lines.join('\n');
    return { ok: true, value: joined.trim() };
  }
  if (group.children.some(line => line.trim() && !/^\s*#/.test(line))) return { ok: false };
  return scalar(group.value);
}

function toolsField(group) {
  if (group.value.trim()) {
    if (group.children.some(line => line.trim() && !/^\s*#/.test(line))) return null;
    const list = inlineList(group.value);
    if (list) return list;
    const parsed = scalar(group.value);
    return parsed.ok && typeof parsed.value === 'string' ? parsed.value.split(/[\s,]+/).filter(Boolean) : null;
  }
  const lines = group.children.filter(line => line.trim() && !/^\s*#/.test(line));
  const items = lines.map(line => /^ +-[ ]+(.+)$/.exec(line));
  if (items.some(item => !item)) return null;
  const values = items.map(item => scalar(item[1]));
  return values.every(item => item.ok && typeof item.value === 'string') ? values.map(item => item.value) : null;
}

function readFrontmatter(lines, add) {
  const groups = [], seen = new Set();
  let current = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) { current?.children.push(line); continue; }
    if (/^[ \t]/.test(line)) {
      if (current) current.children.push(line);
      else add('needs-review', 'FRONTMATTER_STRUCTURE', '元数据包含尚未支持的结构，需要调整后使用。', line);
      continue;
    }
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match || dangerousKeys.has(match?.[1])) {
      add('needs-review', 'FRONTMATTER_STRUCTURE', '元数据包含尚未支持的结构，需要调整后使用。', line);
      current = null;
      continue;
    }
    const key = match[1];
    if (seen.has(key)) add('needs-review', 'DUPLICATE_FIELD', `元数据字段 ${key} 重复，不能确定应采用哪一份。`, line);
    seen.add(key);
    current = { key, value: match[2], children: [] };
    groups.push(current);
  }
  const fields = { metadata: {}, allowedTools: [] };
  for (const group of groups) {
    if (!simpleKeys.has(group.key)) {
      add('needs-review', 'UNKNOWN_FIELD', `当前导入器尚未解释元数据字段 ${group.key}。`, group.key);
      continue;
    }
    if (group.key === 'allowed-tools') {
      const tools = toolsField(group);
      if (!tools) add('needs-review', 'TOOLS_FORMAT', '工具声明的格式尚未支持。', group.value || group.children.join(' '));
      else fields.allowedTools.push(...tools);
      continue;
    }
    if (group.key === 'metadata') {
      if (group.value.trim() && group.value.trim() !== '{}') {
        add('needs-review', 'METADATA_STRUCTURE', 'metadata 目前只支持简单的缩进键值。', group.value);
        continue;
      }
      const metadataKeys = new Set();
      for (const line of group.children.filter(line => line.trim() && !/^\s*#/.test(line))) {
        const match = /^ {2}([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
        if (!match || dangerousKeys.has(match?.[1]) || metadataKeys.has(match?.[1])) {
          add('needs-review', 'METADATA_STRUCTURE', 'metadata 中有嵌套、重复或未支持的字段，需要核对。', line);
          continue;
        }
        metadataKeys.add(match[1]);
        const list = inlineList(match[2]);
        const parsed = list ? { ok: true, value: list } : scalar(match[2]);
        if (!parsed.ok) add('needs-review', 'METADATA_STRUCTURE', 'metadata 中有尚未支持的值，需要核对。', line);
        else fields.metadata[match[1]] = parsed.value;
      }
      continue;
    }
    const parsed = textField(group);
    if (!parsed.ok || typeof parsed.value !== 'string') {
      add('needs-review', 'TEXT_FIELD_FORMAT', `${group.key} 必须使用当前支持的文本格式。`, group.value);
      continue;
    }
    fields[group.key] = parsed.value;
  }
  return fields;
}

function scanDependencies(raw, allowedTools, add) {
  if (allowedTools.length) add('unsupported', 'DECLARED_TOOLS', '声明的外部工具尚未适配；导入 Skill 不会安装或授予这些工具。', allowedTools.join(', '));
  const checks = [
    ['EXECUTABLE_CONTENT', /<\s*(?:script|iframe|object|embed)\b|\bjavascript\s*:|\bon(?:load|error|click)\s*=/i,
      '包含脚本或活动网页内容，当前只支持文字指南。'],
    ['LOCAL_FILE', /(?:\b[a-z]:[\\/]|file:\/\/|\/(?:Users|home|tmp|mnt|usr|etc|var)\/|~\/[.\w]|\$(?:\{(?:HOME|CODEX_HOME|SKILL_DIR)\}|(?:HOME|CODEX_HOME|SKILL_DIR)\b))/i,
      '引用了本机路径或环境目录，浏览器扩展无法按该路径读取文件。'],
    ['PACKAGE_RESOURCE', /\b(?:scripts|references|assets|templates)\/[\w./%-]+|(?:\.\/|\.\.\/)[\w./%-]+/i,
      '依赖 Skill 包中的其他文件；本次只导入了一个 Markdown 文件。'],
    ['EXTERNAL_TOOL', /\bmcp(?:__|[_-]|\s+(?:server|tool))|MCP\s*(?:服务|工具)|\b(?:tools|functions)\.[a-z_]\w*\s*\(|\b(?:tool_search|cua_repl|playwright-cli)\b|\bchrome\.[a-z_]+\./i,
      '依赖 MCP、宿主或自动化工具，当前 Skill 接入没有这些执行接口。'],
    ['RUNTIME', /\b(?:run|execute|invoke|install|launch|require(?:s|d)?|depends? on)\b[^\n]{0,100}\b(?:python\d?|pip\d?|node(?:\.js)?|npm|npx|yarn|pnpm|bash|zsh|powershell|pwsh|shell|terminal|cli|ffmpeg|pandoc|libreoffice|docker)\b|(?:运行|执行|安装|启动|调用)[^\n]{0,55}(?:Python|Node(?:\.js)?|npm|npx|Shell|Bash|PowerShell|命令行|终端|脚本)/i,
      '要求执行本机命令、脚本或安装依赖，浏览器 Skill 暂不支持。'],
    ['NETWORK_ACTION', /\b(?:web_search|read_webpage|WebSearch|WebFetch)\b|\b(?:search the web|browse to|call (?:an? |the )?API|fetch (?:an? |the )?(?:URL|webpage))\b|\b(?:open|visit|download|request|fetch|read)\s+(?:the\s+)?https?:\/\/|(?:搜索网页|联网搜索|抓取网页|调用接口|调用\s*API|发送\s*HTTP)|(?:打开|访问|下载|请求)\s*https?:\/\//i,
      '要求主动联网或调用接口，当前 Skill 只使用本轮已经提供的资料，未适配该依赖。'],
    ['EXTERNAL_INTEGRATION', /\b(?:send|post|upload|publish)\b[^\n]{0,60}\b(?:email|e-mail|slack|gmail|notion|github|drive|sheets)\b|\b(?:slack|gmail|notion|github|drive|sheets)\s+API\b|(?:发送邮件|发送电子邮件|发布到|上传到|同步到)[^\n]{0,40}(?:邮箱|飞书|钉钉|Slack|Notion|GitHub|云盘)?/i,
      '要求操作邮件、协作平台或外部服务，当前 Skill 未接入相应账号与执行接口。'],
    ['BROWSER_ACTION', /\b(?:click|fill|submit|navigate|type into)\b[^\n]{0,60}\b(?:button|form|input|browser|selector|link)\b|(?:点击|填写|提交|导航|操作)[^\n]{0,40}(?:按钮|表单|网页|输入框)/i,
      '要求浏览器交互或页面写操作，当前 Skill 不会进入页面操作模式。'],
  ];
  for (const line of raw.split('\n')) {
    const descriptive = /^[\s#>*\-\d.)]*(?:解释|介绍|讲解|比较|分析|explain\b|describe\b|compare\b|discuss\b)/i.test(line);
    for (const [code, pattern, message] of checks) {
      if (descriptive && ['RUNTIME', 'NETWORK_ACTION', 'EXTERNAL_INTEGRATION', 'BROWSER_ACTION'].includes(code)) continue;
      if (pattern.test(line)) add('unsupported', code, message, line);
    }
    // Markdown links can refer to arbitrary sibling files, beyond conventional
    // scripts/references directories. Remote links are retained as plain text.
    const links = [...line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)].map(match => match[1]);
    const reference = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/.exec(line);
    if (reference) links.push(reference[1]);
    for (const link of links) {
      const path = link.replace(/^<|>$/g, '');
      if (!/^(?:https?:|mailto:|#)/i.test(path)) {
        add('unsupported', 'LINKED_RESOURCE', '引用了未导入的文件或不支持的资源地址，需要一并适配。', path);
      } else if (/^https?:/i.test(path) && !descriptive && /\b(?:read|load|open|visit|fetch|download)\b|(?:读取|打开|下载|访问)/i.test(line)) {
        add('unsupported', 'NETWORK_ACTION', '要求读取外部参考链接；本次没有导入这些内容，也不会自动读取该链接。', path);
      }
    }
    if (/\b(?:ignore|override)\s+(?:all\s+)?(?:previous|system|safety)\s+(?:instructions|rules)|忽略[^\n]{0,20}(?:系统指令|安全规则)/i.test(line)) {
      add('needs-review', 'AUTHORITY_CLAIM', '包含试图改变宿主规则的说明；Skill 不具备这类权限。', line);
    }
  }
  const lines = raw.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(`{3,}|~{3,})([^\s]*)/.exec(lines[i]);
    if (!match) continue;
    if (fence) { if (match[1][0] === fence[0]) fence = null; continue; }
    fence = match[1];
    if (/^(?:sh|bash|zsh|shell|console|powershell|pwsh|ps1|cmd|bat)$/i.test(match[2])) {
      const preceding = lines.slice(Math.max(0, i - 4), i).join(' ');
      const explanation = /(?:解释|讲解|示例|不执行|不要执行)|\b(?:explain|example|do not execute|do not run)\b/i.test(preceding);
      if (!explanation) add('unsupported', 'SHELL_BLOCK', '包含终端命令步骤，当前环境没有终端执行能力。', lines[i + 1] || lines[i]);
    }
  }
}

export function parseSkillMarkdown(source, { fileName = 'SKILL.md' } = {}) {
  if (typeof source !== 'string') throw error('Skill 内容必须是 Markdown 文本。');
  if (typeof fileName !== 'string' || !/\.(?:md|markdown)$/i.test(fileName)) throw error('请选择 SKILL.md 或其他 Markdown 文件。');
  if (new TextEncoder().encode(source).byteLength > SKILL_LIMITS.maxBytes) throw error('Skill 文件不能超过 64 KiB。', 'ERR_SKILL_SIZE');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) throw error('Skill 文件包含非文本控制字符。');
  const raw = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const issues = [], seen = new Set();
  let status = 'compatible';
  const add = (severity, code, message, evidence) => {
    if (severity === 'unsupported' || status === 'compatible') status = severity;
    const value = excerpt(evidence), identity = `${code}:${value}`;
    if (seen.has(identity) || issues.length >= 32) return;
    seen.add(identity); issues.push({ code, message, evidence: value });
  };
  const lines = raw.split('\n');
  let fields = { metadata: {}, allowedTools: [] }, body = raw.trim();
  if (lines[0].trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end < 0) throw error('Skill 的 YAML 元数据没有结束标记。');
    fields = readFrontmatter(lines.slice(1, end), add);
    body = lines.slice(end + 1).join('\n').trim();
  } else add('needs-review', 'MISSING_FRONTMATTER', '没有找到 YAML 元数据，请补充 name 和 description 后使用。', fileName);
  if (!body) throw error('Skill 没有可使用的正文。');
  if (body.length > SKILL_LIMITS.maxBodyChars) throw error('Skill 正文不能超过 12000 个字符；请拆分指南，不能截断必要步骤后执行。', 'ERR_SKILL_SIZE');
  let name = fields.name?.trim();
  if (!name) {
    name = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || fileName.split(/[\\/]/).at(-1).replace(/\.(?:md|markdown)$/i, '');
    add('needs-review', 'MISSING_NAME', '没有有效的 name，当前名称仅根据标题或文件名显示。', name);
  }
  if (name.length > SKILL_LIMITS.maxNameChars || /[\r\n]/.test(name)) throw error('Skill 名称必须是单行，且不超过 120 个字符。');
  const description = fields.description?.trim() || '';
  if (!description) add('needs-review', 'MISSING_DESCRIPTION', '没有有效的 description，需要补充使用范围。', 'description');
  if (description.length > SKILL_LIMITS.maxDescriptionChars) throw error('Skill 描述不能超过 1000 个字符。');
  scanDependencies(raw, fields.allowedTools, add);
  return {
    schemaVersion: 1, sourceFileName: fileName.split(/[\\/]/).at(-1).slice(0, 200),
    name, description, body, raw, allowedTools: [...new Set(fields.allowedTools)], metadata: fields.metadata,
    compatibility: { status, issues },
  };
}

export function assertSkillUsable(parsed) {
  if (parsed?.schemaVersion !== 1 || parsed?.compatibility?.status !== 'compatible' || !parsed?.body) {
    const reason = parsed?.compatibility?.issues?.[0]?.message || '技能格式或依赖尚未确认。';
    throw error(`此 Skill 暂时只能查看：${reason}`, 'ERR_SKILL_UNSUPPORTED');
  }
  return parsed;
}

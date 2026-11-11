const MAX_STEPS = 60;
const MAX_SUMMARY = 6000;

function text(value, max = 500) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

/**
 * Build the user-visible Agent turn. The goal remains an ordinary user
 * message; progress and the final answer live in one assistant message so the
 * conversation stays readable and exportable.
 */
export function createAgentTurn({ goal, taskId = '', startedAt = '', model = '' } = {}) {
  const at = startedAt || new Date().toISOString();
  return {
    goal: text(goal, 4000),
    taskId: text(taskId, 120),
    startedAt: at,
    status: 'running',
    steps: [],
    result: '',
    model: text(model, 200),
  };
}

/**
 * Idempotent assistant-turn creation for a browser task. A task can be
 * initialized by more than one UI path; only one timeline message is allowed.
 */
export function ensureAgentTurnMessage(messages, turn, createId = () => crypto.randomUUID()) {
  const list = Array.isArray(messages) ? messages : [];
  const existing = list.find((message) => (
    message?.role === 'assistant' && message?.agent?.taskId === turn?.taskId
  ));
  if (existing) return existing;
  const message = {
    id: createId(),
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: turn?.startedAt || new Date().toISOString(),
    agent: {
      taskId: text(turn?.taskId, 120),
      goal: text(turn?.goal, 4000),
      status: 'running',
      startedAt: text(turn?.startedAt, 80),
      steps: [],
      result: '',
    },
  };
  list.push(message);
  return message;
}

export function appendAgentStep(turn, step = {}) {
  if (!turn || typeof turn !== 'object') return turn;
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  steps.push({
    kind: text(step.kind, 40) || 'info',
    title: text(step.title, 220),
    detail: text(step.detail, 600),
    at: text(step.at, 80) || new Date().toISOString(),
    status: text(step.status, 40) || 'done',
  });
  turn.steps = steps.slice(-MAX_STEPS);
  return turn;
}

export function finishAgentTurn(turn, { status = 'finished', summary = '', finishedAt = '' } = {}) {
  if (!turn || typeof turn !== 'object') return turn;
  turn.status = ['finished', 'failed', 'cancelled'].includes(status) ? status : 'failed';
  turn.result = text(summary, MAX_SUMMARY);
  turn.finishedAt = text(finishedAt, 80) || new Date().toISOString();
  return turn;
}

/** Keep the failure reason separate before source links are appended to the answer. */
export function agentFailureForMessage(reason) {
  const detail = text(reason, MAX_SUMMARY);
  const firstLine = detail.split('\n').find(line => line.trim()) || '页面操作未完成，请查看执行记录。';
  const sentence = firstLine.match(/^.*?[。！？](?:\s|$)/)?.[0] || firstLine;
  return { errorMessage: sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence,
    errorCode: 'AGENT_TASK_FAILED' };
}

function stepLine(step) {
  const detail = step?.detail ? `：${step.detail}` : '';
  return `- ${text(step?.title, 220)}${detail}`;
}

/**
 * Deterministic final answer when the model cannot produce a narrative
 * summary. It is intentionally factual and never invents page state.
 */
export function fallbackAgentSummary(turn) {
  if (!turn) return '任务没有产生可用结果。';
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  const keySteps = steps
    .filter((step) => ['action', 'result', 'approval', 'warning', 'error'].includes(step.kind))
    .slice(-10);
  const lines = [];
  const status = turn.status === 'finished'
    ? '已完成'
    : turn.status === 'cancelled'
      ? '已停止'
      : '未完成';
  lines.push(`浏览器任务${status}。`);
  if (turn.goal) lines.push(`目标：${text(turn.goal, 500)}`);
  if (turn.result) lines.push(`结果：${text(turn.result, 1200)}`);
  if (keySteps.length) lines.push('执行记录：', ...keySteps.map(stepLine));
  return lines.join('\n').slice(0, MAX_SUMMARY);
}

/**
 * Build the task-summary prompt input. Page evidence must precede the action
 * trace so the summarizer explains what the page actually says rather than
 * merely reciting clicks.
 */
export function buildAgentSummaryInput({ goal, steps = [], evidence = null, toolSummary = '' } = {}) {
  const pageText = text(evidence?.text, 18000);
  return [
    `目标：${text(goal, 1000)}`,
    `页面：${[text(evidence?.title, 300), text(evidence?.url, 1000)].filter(Boolean).join(' ')}`.trim(),
    pageText ? `<page_content>\n${pageText}\n</page_content>` : '',
    evidence?.truncated ? '页面正文已截断；未知内容必须标记为未确认。' : '',
    `执行记录：\n${(Array.isArray(steps) ? steps : []).map((step) =>
      `- ${text(step.title, 220)}${step.detail ? `：${text(step.detail, 600)}` : ''}`).join('\n')}`,
    toolSummary ? `工具返回：${text(toolSummary, 2000)}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Determine whether the collected page facts already cover the common
 * "balance + model price" task shape. This is a guard against ping-ponging
 * between two already-read pages; it is not a general task solver.
 */
export function factsCoverBalanceAndModel(facts = []) {
  const text = (Array.isArray(facts) ? facts : [])
    .map((fact) => String(typeof fact === 'string' ? fact : fact?.text || ''))
    .join('\n');
  const hasBalance = /(?:余额|剩余|总额|可用|￥|¥|\$)\s*[\d,.]/i.test(text)
    || /[\d,.]+\s*(?:元|credits?|积分)/i.test(text);
  const hasModelPrice = /(?:模型|gpt|价格|输入|输出|计费|\/1m|\/1k)/i.test(text)
    && /(?:￥|¥|\$)\s*\d/i.test(text);
  return hasBalance && hasModelPrice;
}

export function agentTurnForMessage(turn) {
  if (!turn || typeof turn !== 'object') return null;
  return {
    goal: text(turn.goal, 4000),
    status: (['running', 'finished', 'failed', 'cancelled'].includes(turn.status)
      || turn.status === 'paused')
      ? turn.status
      : 'running',
    startedAt: text(turn.startedAt, 80),
    finishedAt: text(turn.finishedAt, 80),
    steps: (Array.isArray(turn.steps) ? turn.steps : []).slice(-MAX_STEPS).map((step) => ({
      kind: text(step.kind, 40),
      title: text(step.title, 220),
      detail: text(step.detail, 600),
      at: text(step.at, 80),
      status: text(step.status, 40),
    })),
    result: text(turn.result, MAX_SUMMARY),
  };
}

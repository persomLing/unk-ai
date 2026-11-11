function promptFor(message) {
  return String(message?.displayContent ?? message?.content ?? '').replace(/\s+/g, ' ').trim();
}

export function samePrompt(left, right) {
  const normalizedLeft = promptFor({ content: left });
  return Boolean(normalizedLeft && normalizedLeft === promptFor({ content: right }));
}

function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined).sort();
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

function sourceContext(value) {
  const source = value?.pageSource ?? value?.page;
  if (!source) return null;
  return {
    url: String(source.url || '').trim(),
    capturedAt: String(source.capturedAt || ''),
    documentId: String(source.documentId || source.docId || ''),
    tabId: Number.isInteger(source.tabId) ? source.tabId : null,
    unavailable: source.unavailable === true,
  };
}

/** Equal wording is a retry only when its page snapshot and user inputs agree. */
export function sameTurnContext(left, right) {
  const enabled = (value) => typeof value?.pageContextEnabled === 'boolean' ? value.pageContextEnabled : null;
  return enabled(left) === enabled(right)
    && sameValue(sourceContext(left), sourceContext(right))
    && sameValue(left?.selection || null, right?.selection || null)
    && sameValue(left?.attachments || [], right?.attachments || [])
    && Boolean(left?.agentTask) === Boolean(right?.agentTask)
    && Boolean(left?.researchEnabled) === Boolean(right?.researchEnabled)
    && sameValue(left?.readingPolicy || null, right?.readingPolicy || null)
    && (!enabled(left) || sameValue(left?.readingOptions || null, right?.readingOptions || null));
}

/** Without current context, only legacy context-free turns may auto-retry. */
export function stoppedReplyForPrompt(messages, prompt, currentContext = {}) {
  if (!Array.isArray(messages) || messages.length < 2) return null;
  const question = messages.at(-2);
  const answer = messages.at(-1);
  if (question?.role !== 'user' || answer?.role !== 'assistant' || !['stopped', 'error'].includes(answer.status)) return null;
  return !question.agentTask
    && samePrompt(prompt, question.displayContent || question.content || '')
    && sameTurnContext(question, currentContext) ? answer : null;
}

export function normalizeDuplicateRetryTurns(messages) {
  if (!Array.isArray(messages)) return [];
  const output = [...messages];
  for (let index = 1; index < output.length - 1; index += 1) {
    const stoppedAnswer = output[index];
    const repeatedQuestion = output[index + 1];
    if (
      stoppedAnswer?.role === 'assistant'
      && ['stopped', 'error'].includes(stoppedAnswer.status)
      && output[index - 1]?.role === 'user'
      && repeatedQuestion?.role === 'user'
      && !output[index - 1].agentTask
      && !repeatedQuestion.agentTask
      && samePrompt(promptFor(output[index - 1]), promptFor(repeatedQuestion))
      && sameTurnContext(output[index - 1], repeatedQuestion)
    ) {
      output.splice(index, 2);
      index -= 1;
    }
  }
  return output;
}

export function messagesForRetry(messages, assistantId, replacement) {
  if (!Array.isArray(messages) || !replacement) return null;
  const assistantIndex = messages.findIndex((message) => message?.id === assistantId && message.role === 'assistant');
  if (assistantIndex < 0) return null;
  if (messages[assistantIndex]?.agent) return null;
  let userIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') { userIndex = index; break; }
  }
  if (userIndex < 0) return null;
  const currentQuestion = messages[userIndex];
  if (currentQuestion.agentTask) return null;
  const currentPrompt = promptFor(currentQuestion);
  while (userIndex >= 2) {
    const previousUser = messages[userIndex - 2];
    const previousAnswer = messages[userIndex - 1];
    if (previousUser?.role !== 'user' || previousAnswer?.role !== 'assistant'
      || !['stopped', 'error'].includes(previousAnswer.status)
      || !samePrompt(promptFor(previousUser), currentPrompt)
      || previousUser.agentTask || currentQuestion.agentTask
      || !sameTurnContext(previousUser, currentQuestion)) break;
    userIndex -= 2;
  }
  return [...messages.slice(0, userIndex + 1), replacement];
}

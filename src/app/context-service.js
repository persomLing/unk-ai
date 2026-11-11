import { contextUsageFor, contextWindowFor, trimTextToTokenBudget } from '../utils/context.js';
import { awaitWithAbort } from '../utils/abortable.js';
import { compressionSource, compressionChunks, compressionTranscript, compressionRequestBody,
  fallbackCompression, mergeContextSummary } from '../sidepanel/features/context/context-slot.js';

/** History compression is an optional model purpose, never a reply writer.
 * A true result means the summary was applied in memory; save is a scheduling
 * port, so its return value is never treated as proof of durable storage.
 */
export function createContextService({ state, modelGateway, profileFor, save,
  onEvent = () => {}, createId = () => crypto.randomUUID(), now = () => new Date().toISOString(),
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 60000 }) {
  let requestSequence = 0;
  let disposed = false, activeController = null;
  const emit = event => { if (!disposed) { try { onEvent(event); } catch {} } };
  async function compress(conversation, beforeAssistantId, { manual = false, signal, profile: suppliedProfile, modelRun } = {}) {
    if (disposed) return false;
    signal?.throwIfAborted();
    if (state.compressing || !conversation) return false;
    let controller = null, timeout = null, connection = null;
    const cancel = () => controller?.abort(signal?.reason);
    try {
      const profile = structuredClone(suppliedProfile || profileFor());
      if (!profile) return false;
      const contextWindow = contextWindowFor(profile, state.config);
      const usage = contextUsageFor(conversation, beforeAssistantId, conversation.pageContext, contextWindow);
      if (!manual && (!usage.shouldCompress || usage.used < 8000)) return false;
      const source = compressionSource(conversation, beforeAssistantId, contextWindow, profile.maxTokens);
      if (!source.length) {
        if (manual) emit({ type: 'notice', message: '没有可整理的较早记录；当前单条内容过长时请减少输入。' });
        return false;
      }
      controller = new AbortController();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      state.compressing = true;
      state.compressionController = controller;
      activeController = controller;
      timeout = setTimer(() => controller.abort(new DOMException('历史整理超时。', 'TimeoutError')), timeoutMs);
      emit({ type: 'composer' });
      const assertOwner = () => {
        signal?.throwIfAborted();
        controller.signal.throwIfAborted();
        if (state.compressionController !== controller) throw new DOMException('本次整理已被替换。', 'AbortError');
      };
      assertOwner();
      connection = modelRun || modelGateway.createRun({ runId: `compression-${createId()}`, profile, signal: controller.signal,
        diagnosticContext: { conversationId: conversation.id } });
      const summaryBudget = Math.min(2000, Math.max(300, Math.floor(contextWindow * 0.12)));
      const chunkBudget = Math.min(24000, Math.max(1000, Math.floor(contextWindow * 0.5)));
      const summaryProfile = { ...profile, maxTokens: Math.min(profile.maxTokens || summaryBudget, summaryBudget) };
      let text = trimTextToTokenBudget(conversation.contextSummary?.text || '', summaryBudget);
      for (const chunk of compressionChunks(source, chunkBudget)) {
        assertOwner();
        const transcript = trimTextToTokenBudget(compressionTranscript(chunk), chunkBudget);
        const body = compressionRequestBody(summaryProfile,
          (text ? `已确认的旧摘要（保留页面来源）：\n${text}\n\n` : '') + `新增历史（合并后仍需保留每条事实的来源）：\n${transcript}`);
        text = await awaitWithAbort(connection.request({ requestId: `compression-${++requestSequence}`, purpose: 'compression',
          messages: body.messages, maxTokens: body.max_tokens, signal: controller.signal, timeoutMs: 30000 }), controller.signal);
        assertOwner();
        text = trimTextToTokenBudget(text, summaryBudget);
      }
      assertOwner();
      conversation.contextSummary = { ...mergeContextSummary(conversation.contextSummary, source, usage, now()),
        text: trimTextToTokenBudget(text || fallbackCompression(source), summaryBudget) };
      const saveFailed = error => emit({ type: 'notice', kind: 'error', conversationId: conversation.id,
        message: `摘要已用于本次对话，但保存未完成：${error?.message || '保存调度失败。'}` });
      try {
        // A scheduled timer or unresolved promise is not a durable-save receipt.
        // Saving remains independent from the main answer and failures are observed.
        const scheduled = save(conversation);
        Promise.resolve(scheduled).catch(saveFailed);
        emit({ type: 'notice', persistence: 'requested', conversationId: conversation.id,
          message: `${manual ? '会话记录已在本次对话中整理。' : '已整理较早记录，保留本轮页面和问题。'}保存已请求。` });
      } catch (error) { saveFailed(error); }
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name !== 'AbortError') emit({ type: 'notice', kind: 'error', message: `整理失败，将按容量限制保留近期消息：${error?.message || error}` });
      return false;
    } finally {
      if (timeout !== null) clearTimer(timeout);
      signal?.removeEventListener('abort', cancel);
      if (!modelRun && connection) {
        try { Promise.resolve(connection.dispose()).catch(() => {}); } catch { /* Cleanup cannot block the answer. */ }
      }
      if (activeController === controller) activeController = null;
      if (controller && state.compressionController === controller) {
        state.compressionController = null;
        state.compressing = false;
        emit({ type: 'settled', beforeAssistantId });
      }
    }
  }
  return Object.freeze({ compress, cancel: () => activeController?.abort(),
    dispose() { disposed = true; activeController?.abort(); } });
}

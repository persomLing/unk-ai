import { awaitWithTimeout } from '../../../utils/abortable.js';
import { beijingDate } from '../../../utils/diagnostic-schema.js';

export function diagnosticCoverageText(bundle) {
  const count = bundle.events?.length || 0;
  const shared = bundle.sharedEvents?.length || 0;
  const notes = [`本次包含 ${count} 条诊断事件${shared ? `，另有 ${shared} 条共享环境事件` : ''}。`];
  if (!count) notes.push('今天没有找到此范围的记录；功能启用前或其他日期的故障无法由今天的日志还原。');
  if (bundle.coverage?.partial || bundle.coverage?.sharedTruncated) notes.push('本次日志存在缺失或截断，已在文件中标明。');
  notes.push('日志覆盖情况见 coverage、status；没有记录不代表操作未发生。');
  return notes.join('');
}

/** Freeze the requested scope/date before any wait. No transmission or chat data access. */
export function createDiagnosticExporter({ collect, download, notify = () => {}, now = Date.now, timeoutMs = 15000 }) {
  let active = null;
  let disposed = false;
  const inform = (text, kind) => { try { notify(text, kind); } catch { /* UI only. */ } };
  return Object.freeze({
    async exportToday({ conversationId, all = false } = {}) {
      if (disposed || active) return { ok: false, reason: 'busy' };
      if (!all && !conversationId) { inform('找不到这条消息所属的对话，请从设置页导出今天全部诊断日志。', 'error'); return { ok: false, reason: 'scope' }; }
      const scope = Object.freeze({ date: beijingDate(now()), ...(all ? {} : { conversationId: String(conversationId) }) });
      const controller = new AbortController();
      active = controller;
      inform('正在整理今天的诊断日志…');
      try {
        const bundle = await awaitWithTimeout(Promise.resolve().then(() => collect(scope)), {
          signal: controller.signal, timeoutMs, message: '整理日志超时，请从设置页重试导出。',
        });
        controller.signal.throwIfAborted();
        if (disposed || active !== controller) return { ok: false, reason: 'cancelled' };
        const json = JSON.stringify(bundle, null, 2);
        if (new Blob([json]).size > 24 * 1024 * 1024) throw new Error('当日日志过大，请按单个对话导出。');
        await awaitWithTimeout(download({ blob: new Blob([json], { type: 'application/json' }),
          filename: `unk-ai-diagnostics-${scope.date}-${all ? 'all' : 'conversation'}.json`, signal: controller.signal }),
        { signal: controller.signal, timeoutMs: Math.max(timeoutMs, 60000), message: '等待下载超时，请检查浏览器下载列表。' });
        controller.signal.throwIfAborted();
        inform(`已交给浏览器下载，可将文件发给支持人员。${diagnosticCoverageText(bundle)}`, 'success');
        return { ok: true };
      } catch (error) {
        if (!disposed && error?.name !== 'AbortError') inform(error?.message || '导出日志失败，请重试。', 'error');
        return { ok: false, reason: error?.name === 'AbortError' ? 'cancelled' : 'failed' };
      } finally { if (active === controller) active = null; }
    },
    dispose() { disposed = true; active?.abort(new DOMException('日志导出已取消。', 'AbortError')); },
  });
}

export function diagnosticStatusText(status) {
  const pending = status.pending || {};
  const dropped = Object.values(status.dropped || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const directory = status.directory || {};
  const parts = [directory.configured ? `保存位置：所选文件夹 / diagnostics/（权限：${({ granted: '可写', prompt: '待授权', denied: '不可写' })[directory.permission] || '待核验'}）` : '尚未绑定文件夹，日志暂存在当前浏览器'];
  parts.push(`保留最近 7 天；待写 ${pending.events || 0} 条${pending.unbound ? `，其中 ${pending.unbound} 条未绑定目录` : ''}`);
  if (status.lastWriteAt) parts.push(`最近写入：${new Date(status.lastWriteAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  if (dropped) parts.push(`已过期或未能保留 ${dropped} 条，导出文件会附带缺失说明`);
  if (status.lastError) parts.push('有日志尚未确认写入，可重试保存；导出会同时收集浏览器暂存记录');
  return parts.join('。');
}

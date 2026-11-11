import { awaitWithTimeout } from '../../../utils/abortable.js';

/** Download is distinct from conversation persistence. A started browser save
 * cannot be undone by cancelling the local wait. */
export function createExportDownloader({ download, urls = globalThis.URL, delay = setTimeout } = {}) {
  return async ({ blob, filename, signal }) => {
    if (signal?.aborted) throw signal.reason;
    const url = urls.createObjectURL(blob);
    try {
      return await awaitWithTimeout(download({ url, filename, saveAs: true }), {
        signal, timeoutMs: 60000, message: '等待保存窗口超时，请检查浏览器下载列表。',
      });
    } finally {
      // Keep an already-issued download usable while its save dialog is open.
      delay(() => urls.revokeObjectURL(url), 120000);
    }
  };
}

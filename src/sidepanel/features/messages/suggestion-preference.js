import { awaitWithTimeout } from '../../../utils/abortable.js';

export const NEXT_EXPLORATION_KEY = 'nextExploration';

export function readNextExploration(value) {
  if (value === undefined) return true;
  if (value?.version === 1 && typeof value.enabled === 'boolean') return value.enabled;
  throw new Error('下一步探索的设置格式无法读取。');
}

export function watchNextExploration({ storage, changes, onChange, onError }) {
  const controller = new AbortController();
  let receivedChange = false;
  function publish(value) {
    if (controller.signal.aborted) return;
    try { onChange(readNextExploration(value)); }
    catch (error) { onError(error); }
  }
  function changed(values, area) {
    if (area !== 'local' || !Object.hasOwn(values, NEXT_EXPLORATION_KEY)) return;
    receivedChange = true;
    publish(values[NEXT_EXPLORATION_KEY].newValue);
  }
  changes.addListener(changed);
  const initial = awaitWithTimeout(Promise.resolve().then(() => storage.get(NEXT_EXPLORATION_KEY)), {
    signal: controller.signal, timeoutMs: 2500, message: '读取下一步探索设置超时。',
  });
  void initial.then(result => {
    if (!receivedChange) publish(result[NEXT_EXPLORATION_KEY]);
  }).catch(error => {
    if (!receivedChange && !controller.signal.aborted) onError(error);
  });
  return function dispose() {
    controller.abort();
    changes.removeListener(changed);
  };
}

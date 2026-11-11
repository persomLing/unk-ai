import { awaitWithAbort } from '../../../utils/abortable.js';

/** Presentation state belongs to one read; a late completion cannot replace a newer read. */
export function createPageReadState({ onChange = () => {} } = {}) {
  let current = null;
  return {
    current: () => current,
    invalidate(tabId) {
      if (current && (current.target.tabId ?? current.target.id) === tabId) {
        current = null;
        onChange(null);
      }
    },
    async run(target, signal, operation) {
      signal?.throwIfAborted();
      const activity = { target: { ...target }, status: 'reading' };
      current = activity;
      onChange(activity);
      const update = status => {
        if (current !== activity) return;
        activity.status = status;
        onChange(activity);
      };
      try {
        const result = await awaitWithAbort(Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return operation();
        }), signal);
        signal?.throwIfAborted();
        update('read');
        return result;
      } catch (error) {
        update(error?.name === 'AbortError' ? 'stopped' : 'failed');
        throw error;
      }
    },
  };
}

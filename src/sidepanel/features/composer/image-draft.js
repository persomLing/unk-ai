import { directImageForMessage, IMAGE_DRAFT_PREFIX } from '../../../utils/image-generation-command.js';

export function createImageDraft(draft) {
  let enabled = false;
  return Object.freeze({ ...draft,
    get enabled() { return enabled; },
    getValue() { return enabled ? IMAGE_DRAFT_PREFIX + draft.getValue() : draft.getValue(); },
    getPrompt: draft.getValue,
    setValue(value) {
      const text = String(value ?? '');
      enabled = text.startsWith(IMAGE_DRAFT_PREFIX) || text === IMAGE_DRAFT_PREFIX.trimEnd();
      draft.setValue(enabled ? text.slice(IMAGE_DRAFT_PREFIX.length) : text);
    },
    setImageMode(next) {
      if (next && !enabled) {
        const current = directImageForMessage({ content: draft.getValue() });
        if (current) draft.setValue(current.prompt);
      }
      enabled = next;
    },
  });
}

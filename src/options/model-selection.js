import { updateProfileGenerationSettings } from '../utils/profiles.js';

export function updateModelDraft(profile, settings) {
  return { ...updateProfileGenerationSettings(profile, settings),
    contextLength: settings.contextLength ?? null,
    maxOutputTokens: settings.maxOutputTokens ?? null,
    temperature: settings.temperature ?? null };
}

/** Keep the model being edited independent of the model discovery dropdown. */
export function createModelSelection({ getProfiles, setProfiles, readGeneration }) {
  let selectedId = '';
  const current = () => getProfiles().find(profile => profile.id === selectedId) || getProfiles()[0] || null;
  function remember() {
    const profile = current();
    if (!profile) return;
    const settings = readGeneration();
    setProfiles(getProfiles().map(item => item.id === profile.id ? updateModelDraft(item, settings) : item));
  }
  function reset(id) {
    selectedId = getProfiles().some(profile => profile.id === id) ? id : getProfiles()[0]?.id || '';
    return current();
  }
  function select(id) {
    if (!getProfiles().some(profile => profile.id === id)) return null;
    remember();
    return reset(id);
  }
  return Object.freeze({ current, remember, reset, select });
}

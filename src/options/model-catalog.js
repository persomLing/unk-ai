/** The fetched service catalog stays intact across library edits so a removed
 * model becomes addable again without re-fetching. */
export function createModelCatalog({ getLibrary }) {
  let catalog = [];
  return Object.freeze({
    set(all) { catalog = Array.isArray(all) ? all : []; },
    clear() { catalog = []; },
    available() { return catalog.filter((model) => !getLibrary().some((profile) => profile.id === model.id)); },
  });
}
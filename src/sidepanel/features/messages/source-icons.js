/** Source favicons are optional presentation; failure never changes evidence. */
export function createSourceIconFallback({ root = globalThis.document } = {}) {
  const document = root?.ownerDocument || root;
  let disposed = false;
  function update(image) {
    if (disposed || !image?.matches?.('img[data-source-favicon]')
      || image.isConnected === false || !root.contains(image)) return;
    const fallback = image.parentElement?.querySelector('[data-source-favicon-fallback]');
    if (!fallback) return;
    const loaded = image.complete === true && image.naturalWidth > 0;
    image.hidden = !loaded;
    fallback.hidden = loaded;
  }
  function sync(container = root) {
    if (disposed) return;
    update(container);
    container?.querySelectorAll?.('img[data-source-favicon]').forEach(update);
  }
  const onResult = event => update(event.target);
  root.addEventListener('load', onResult, true);
  root.addEventListener('error', onResult, true);
  const Observer = document.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(records => {
    if (disposed) return;
    for (const record of records) {
      if (record.type === 'attributes') update(record.target);
      else record.addedNodes?.forEach(node => sync(node));
    }
  }) : null;
  observer?.observe(root.documentElement || root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  sync();
  return Object.freeze({ sync, dispose() {
    if (disposed) return;
    disposed = true;
    root.removeEventListener('load', onResult, true);
    root.removeEventListener('error', onResult, true);
    observer?.disconnect();
  } });
}

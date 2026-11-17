/** Fixed MAIN-world inspect/seek function. The inspect phase binds this click
 * to the live document; seek repeats all identity checks in that document.
 * Setting currentTime leaves the URL and play/pause state unchanged. */
export function seekBilibiliVideo(input) {
  const expired = () => !Number.isFinite(input.deadlineAt) || Date.now() >= input.deadlineAt;
  if (expired()) return { outcome: 'expired' };
  if (location.href !== input.expectedUrl) return { outcome: 'changed' };
  const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const initial = globalThis.__INITIAL_STATE__;
  const selectedParts = [...document.querySelectorAll(
    '#bilibili-player .bpx-player-ctrl-eplist-multi-menu-item.bpx-state-multi-active-item[data-cid], '
      + '#bilibiliPlayer .bpx-player-ctrl-eplist-multi-menu-item.bpx-state-multi-active-item[data-cid]')];
  const selectedCid = selectedParts.length === 1 ? positive(selectedParts[0].getAttribute('data-cid')) : null;
  const urlBvid = location.href.match(/\/video\/(BV[a-zA-Z0-9]{10})(?:[/?#]|$)/)?.[1];
  const bvid = String((selectedCid && urlBvid) || globalThis.bvid || initial?.bvid || initial?.videoData?.bvid || urlBvid || '');
  let cid = selectedCid || positive(globalThis.cid);
  if (selectedParts.length > 1) return { outcome: 'identity-unavailable' };
  // The selected row in the player's own episode menu is a live DOM identity
  // signal. It also supports SPA part changes without depending on window.cid.
  // Some Bilibili builds do not expose window.cid. Only use the initialized
  // part when its P and video match this page; never infer a live P from a stale
  // bootstrap list after SPA navigation.
  if (!cid && bvid === input.bvid && Number(initial?.p) === input.part) {
    const parts = Array.isArray(initial?.videoData?.pages)
      ? initial.videoData.pages.filter(page => page?.page === input.part) : [];
    if (parts.length === 1) cid = positive(parts[0].cid);
  }
  if (bvid && bvid !== input.bvid) return { outcome: 'changed' };
  if (!bvid || !cid) return { outcome: 'identity-unavailable' };
  if (cid !== input.cid) return { outcome: 'changed' };
  const players = [...document.querySelectorAll('#bilibili-player video, #bilibiliPlayer video')]
    .filter(video => video.isConnected && video.readyState >= 1 && Number.isFinite(video.duration));
  if (players.length !== 1) return { outcome: 'unavailable' };
  const player = players[0], seconds = input.startMs / 1000;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= player.duration
    || Math.abs(player.duration - input.duration) > 2) return { outcome: 'unavailable' };
  if (expired()) return { outcome: 'expired' };
  if (input.inspectOnly) return { outcome: 'ready', url: location.href, bvid, cid };
  try {
    player.currentTime = seconds;
    if (Math.abs(player.currentTime - seconds) > 1) return { outcome: 'uncertain' };
    return { outcome: 'seeked', startMs: input.startMs, paused: player.paused };
  } catch { return { outcome: 'uncertain' }; }
}

/** Fixed MAIN-world frame capture. Like seek, this function is serialized into
 * the page and must stay self-contained. It seeks to the cue, waits for a real
 * presented frame, draws it to a bounded JPEG canvas, then restores the original
 * position and pause state. DRM/cross-origin taint surfaces as capture-blocked;
 * it is never bypassed. Capture only reads pixels and restores player state. */
export async function captureBilibiliFrame(input) {
  const expired = () => !Number.isFinite(input.deadlineAt) || Date.now() >= input.deadlineAt;
  if (expired()) return { ok: false, reason: 'expired' };
  const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const inspect = () => {
    if (location.href !== input.expectedUrl) return { reason: 'changed' };
    const initial = globalThis.__INITIAL_STATE__;
    const selectedParts = [...document.querySelectorAll(
      '#bilibili-player .bpx-player-ctrl-eplist-multi-menu-item.bpx-state-multi-active-item[data-cid], '
        + '#bilibiliPlayer .bpx-player-ctrl-eplist-multi-menu-item.bpx-state-multi-active-item[data-cid]')];
    const selectedCid = selectedParts.length === 1 ? positive(selectedParts[0].getAttribute('data-cid')) : null;
    const urlBvid = location.href.match(/\/video\/(BV[a-zA-Z0-9]{10})(?:[/?#]|$)/)?.[1];
    const bvid = String((selectedCid && urlBvid) || globalThis.bvid || initial?.bvid || initial?.videoData?.bvid || urlBvid || '');
    let cid = selectedCid || positive(globalThis.cid);
    if (selectedParts.length > 1) return { reason: 'identity-unavailable' };
    if (!cid && bvid === input.bvid && Number(initial?.p) === input.part) {
      const parts = Array.isArray(initial?.videoData?.pages) ? initial.videoData.pages.filter(page => page?.page === input.part) : [];
      if (parts.length === 1) cid = positive(parts[0].cid);
    }
    if ((bvid && bvid !== input.bvid) || (cid && cid !== input.cid)) return { reason: 'changed' };
    if (!bvid || !cid) return { reason: 'identity-unavailable' };
    const players = [...document.querySelectorAll('#bilibili-player video, #bilibiliPlayer video')]
      .filter(video => video.isConnected && video.readyState >= 1 && Number.isFinite(video.duration));
    return players.length === 1 ? { player: players[0] } : { reason: 'unavailable' };
  };
  const first = inspect();
  if (first.reason) return { ok: false, reason: first.reason };
  const player = first.player, seconds = input.startMs / 1000;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= player.duration
    || Math.abs(player.duration - input.duration) > 2) return { ok: false, reason: 'unavailable' };
  const samePlayer = () => {
    const state = inspect();
    return !state.reason && state.player === player && Math.abs(player.duration - input.duration) <= 2;
  };
  const originalTime = player.currentTime, originalPaused = player.paused;
  // Install listeners before setting currentTime. Updating the property is
  // only a seek request; a timeout or an old presented frame is not success.
  const positionAt = (time, timeoutMs) => {
    if (!samePlayer()) return Promise.resolve({ ready: false, reason: 'changed' });
    if (!player.seeking && player.readyState >= 2 && Math.abs(player.currentTime - time) < 0.05) return Promise.resolve({ ready: true });
    return new Promise(resolve => {
      let done = false, frameHandle = null, presented = false;
      const hasFrameCallback = typeof player.requestVideoFrameCallback === 'function';
      const ready = () => samePlayer() && !player.seeking && player.readyState >= 2 && Math.abs(player.currentTime - time) <= 1;
      const finish = result => {
        if (done) return;
        done = true; clearTimeout(timer); player.removeEventListener('seeked', onSeeked);
        if (frameHandle !== null && player.cancelVideoFrameCallback) player.cancelVideoFrameCallback(frameHandle);
        resolve(result);
      };
      // Chrome can present the requested frame before the seeked event. Keep
      // that evidence until both the frame and the completed seek are ready.
      const onSeeked = () => { if ((!hasFrameCallback || presented) && ready()) finish({ ready: true }); };
      const onFrame = (_now, metadata) => {
        frameHandle = null;
        if (!samePlayer()) { finish({ ready: false, reason: 'changed' }); return; }
        presented = !Number.isFinite(metadata?.mediaTime) || Math.abs(metadata.mediaTime - time) <= 1;
        if (ready() && presented) {
          finish({ ready: true });
        } else if (!done) frameHandle = player.requestVideoFrameCallback(onFrame);
      };
      const timer = setTimeout(() => finish({ ready: false, reason: samePlayer() ? 'frame-timeout' : 'changed' }), Math.max(1, timeoutMs));
      player.addEventListener('seeked', onSeeked);
      try {
        if (hasFrameCallback) frameHandle = player.requestVideoFrameCallback(onFrame);
        player.currentTime = time;
        if (Math.abs(player.currentTime - time) > 1) finish({ ready: false, reason: 'uncertain' });
      } catch { finish({ ready: false, reason: 'uncertain' }); }
    });
  };
  const restore = async () => {
    if (!samePlayer()) return false;
    try {
      const position = await positionAt(originalTime, Math.min(2000, Math.max(1, input.deadlineAt - Date.now())));
      if (!position.ready || !samePlayer()) return false;
      if (originalPaused) { if (!player.paused) player.pause(); }
      else if (player.paused) {
        let timer;
        const played = await Promise.race([
          Promise.resolve(player.play()).then(() => true, () => false),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.min(1000, Math.max(1, input.deadlineAt - Date.now()))); }),
        ]).finally(() => clearTimeout(timer));
        if (!played) return false;
      }
      return samePlayer() && player.paused === originalPaused && Math.abs(player.currentTime - originalTime) <= 1;
    } catch { return false; }
  };
  let result;
  try {
    if (expired() || !samePlayer()) return { ok: false, reason: expired() ? 'expired' : 'changed' };
    if (!player.paused) player.pause();
    const remaining = input.deadlineAt - Date.now();
    const restoreReserve = Math.min(2000, Math.max(0, Math.floor(remaining * 0.35)));
    const frame = await positionAt(seconds, Math.min(5000, Math.max(1, remaining - restoreReserve)));
    if (!frame.ready || expired() || !samePlayer()) throw { captureReason: !samePlayer() ? 'changed' : expired() ? 'expired' : frame.reason };
    const sourceWidth = player.videoWidth, sourceHeight = player.videoHeight;
    if (!sourceWidth || !sourceHeight) throw { captureReason: 'unavailable' };
    const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d');
    context.drawImage(player, 0, 0, canvas.width, canvas.height);
    let dataUrl;
    try { dataUrl = canvas.toDataURL('image/jpeg', 0.85); }
    catch { throw { captureReason: 'capture-blocked' }; }
    let blackFrame = false;
    try {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0, sumSquares = 0, count = 0;
      for (let index = 0; index < pixels.length; index += 4 * 97) {
        const luma = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
        sum += luma; sumSquares += luma * luma; count++;
      }
      if (count) { const mean = sum / count; blackFrame = mean < 24 && (sumSquares / count - mean * mean) < 16; }
    } catch { /* The verified frame still goes through the separate vision check. */ }
    result = { ok: true, dataUrl, width: canvas.width, height: canvas.height, currentTime: player.currentTime, blackFrame };
  } catch (error) {
    result = { ok: false, reason: error?.captureReason || (error?.name === 'SecurityError' ? 'capture-blocked' : 'uncertain') };
  }
  const restored = await restore();
  return result.ok ? { ...result, restored } : { ...result, ...(!restored ? { restored: false } : {}) };
}

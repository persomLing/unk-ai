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

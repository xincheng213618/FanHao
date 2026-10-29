// A cancelled native frame may already be queued for delivery. Keep a frame
// token as well as its media owner so it cannot clear a replacement's handle.
export function createShortVideoProgressLoop({
  getPlayer,
  isConnected,
  onProgress,
  intervalMs = 30,
  requestFrame = callback => window.requestAnimationFrame(callback),
  cancelFrame = handle => window.cancelAnimationFrame(handle)
}) {
  let current = null;
  let disposed = false;
  const interval = Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 0 ? Number(intervalMs) : 30;
  const identity = player => JSON.stringify([
    String(player.getAttribute?.("src") || player.currentSrc || player.src || ""),
    String(player.dataset?.shortVideoSourceGeneration || "0"),
    String(player.dataset?.videoId || ""),
    String(player.dataset?.shortVideoSlot || ""),
    String(player.dataset?.shortVideoPromotedAt || ""),
    String(player.dataset?.shortVideoWarmScheduleToken || ""),
    String(player.dataset?.shortVideoPlaybackIntentGeneration || "0")
  ]);
  const usable = player => Boolean(player && isConnected() && player.isConnected !== false
    && !player.classList?.contains?.("is-ghost") && !player.paused && !player.ended && !player.error);
  const owns = owner => Boolean(!disposed && current === owner && owner.player === getPlayer()
    && usable(owner.player) && owner.identity === identity(owner.player));
  const clearFrame = owner => {
    const frame = owner?.frame;
    if (!frame) return;
    owner.frame = null;
    frame.cancelled = true;
    if (frame.handle != null) frame.cancel(frame.handle);
  };
  function stop() {
    const previous = current;
    current = null;
    clearFrame(previous);
  }
  const schedule = owner => {
    if (!owns(owner) || owner.frame) return;
    const player = owner.player;
    const native = typeof player.requestVideoFrameCallback === "function";
    const frame = {
      handle: null,
      cancelled: false,
      cancel: native ? handle => player.cancelVideoFrameCallback?.(handle) : cancelFrame
    };
    owner.frame = frame;
    const paint = now => {
      if (disposed || current !== owner || owner.frame !== frame) return;
      if (!owns(owner)) {
        stop();
        sync();
        return;
      }
      owner.frame = null;
      const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      if (owner.lastAt === null || timestamp < owner.lastAt || timestamp - owner.lastAt >= interval) {
        owner.lastAt = timestamp;
        onProgress(player, timestamp);
      }
      // onProgress may synchronously stop/dispose, replace the media or call
      // sync itself. Only the surviving owner may keep the single frame chain.
      if (current !== owner || disposed) return;
      if (!owns(owner)) {
        stop();
        sync();
        return;
      }
      schedule(owner);
    };
    try {
      frame.handle = native ? player.requestVideoFrameCallback(paint) : requestFrame(paint);
    } catch (error) {
      if (current === owner && owner.frame === frame) stop();
      throw error;
    }
    // A controlled scheduler can trigger a reentrant stop before returning its
    // handle. Cancel that registration even when the handle is numeric zero.
    if (frame.cancelled && frame.handle != null) frame.cancel(frame.handle);
  };
  function sync() {
    if (disposed || !isConnected()) {
      stop();
      return;
    }
    const player = getPlayer();
    if (!usable(player)) {
      stop();
      return;
    }
    if (!current || !owns(current)) {
      stop();
      current = { player, identity: identity(player), frame: null, lastAt: null };
    }
    schedule(current);
  }
  function dispose() {
    disposed = true;
    stop();
  }
  return { sync, stop, dispose };
}

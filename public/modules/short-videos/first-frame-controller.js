// Keep poster reveal tied to a painted frame from the current source. Source
// reloads and role changes can leave an earlier media promise resolving late.
export function createShortVideoFirstFrameController({ player, stage, waitForFirstFrame, reveal, timeout, retryLimit = 4 }) {
  let pending = null;
  let retryTimer = 0;
  let generation = 0;
  let attempts = 0;
  let suspended = false;
  let lifecycleSuspended = false;
  let lifecycleOwner = null;
  const sourceIdentity = () => `${player.dataset.shortVideoSourceGeneration || "0"}:${player.getAttribute("src") || player.currentSrc || ""}`;
  const cancel = () => {
    generation += 1;
    suspended = true;
    lifecycleOwner = null;
    window.clearTimeout(retryTimer);
    retryTimer = 0;
    const previous = pending;
    pending = null;
    previous?.abort.abort();
  };
  const reset = () => {
    const wasSuspended = suspended;
    cancel();
    suspended = wasSuspended;
    attempts = 0;
    stage.classList.remove("is-video-ready");
  };
  const check = () => {
    if (!player.isConnected || suspended || player.error) return;
    if (!(player.getAttribute("src") || player.currentSrc)) return;
    if (pending) return;
    if (player.readyState >= 2 && player.dataset.shortVideoFrameReady === "1") {
      if (!stage.classList.contains("is-video-ready")) reveal();
      return;
    }
    if (attempts >= retryLimit) return;
    const request = { generation, source: sourceIdentity(), abort: new AbortController() };
    pending = request;
    attempts += 1;
    Promise.resolve(waitForFirstFrame(player, timeout, { signal: request.abort.signal })).then((ready) => {
      if (pending !== request || request.generation !== generation || request.source !== sourceIdentity()) return;
      pending = null;
      if (!player.isConnected || suspended || player.error) return;
      if (ready) {
        reveal();
      } else if (attempts < retryLimit) {
        retryTimer = window.setTimeout(() => { retryTimer = 0; check(); }, 120);
      }
    }).catch(() => {
      // A media implementation may reject while its source is being detached.
      // The visible playback status owns the bounded failure/retry feedback.
      if (pending === request) pending = null;
    });
  };
  const resume = () => {
    if (lifecycleSuspended || !player.isConnected || player.paused || player.ended || player.dataset.shortVideoExplicitPlaybackIntent === "pause") return;
    if (suspended) attempts = 0;
    suspended = false;
    check();
  };
  const suspendForPage = () => {
    cancel();
    lifecycleSuspended = true;
    lifecycleOwner = { generation, source: sourceIdentity() };
  };
  const resumeForPage = () => {
    // BFCache can preserve playing media without another play event. Re-arm
    // only the wait cancelled for this source; never replay or adopt a reload.
    const owner = lifecycleOwner;
    lifecycleSuspended = false;
    lifecycleOwner = null;
    if (!owner || owner.generation !== generation || owner.source !== sourceIdentity()) return;
    resume();
  };
  player.addEventListener("emptied", reset);
  player.addEventListener("loadstart", reset);
  player.addEventListener("play", resume);
  player.addEventListener("shortvideoframeready", check);
  player.shortVideoCancelFirstFrame = cancel;
  player.shortVideoSuspendFirstFrame = suspendForPage;
  player.shortVideoResumeFirstFrame = resumeForPage;
  return { check, get attempts() { return attempts; } };
}

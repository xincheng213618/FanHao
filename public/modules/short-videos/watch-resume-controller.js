export function createShortVideoWatchResumeController({
  stage, player, video, resume = true, getActivePlayer, getVideo = () => video,
  getWatch = (current) => current?.watch, getContext = () => [], waitForFirstFrame, persist, onResume = () => {},
  requestFrame = (callback) => window.requestAnimationFrame(callback), cancelFrame = (handle) => window.cancelAnimationFrame(handle), now = Date.now
}) {
  const videoId = String(video?.id || "");
  let currentVideo = video, pending = null, bootstrapFrame = 0, disposed = false, restored = false, initialWrite = false;
  let observedVideo = null, observedWatch = null;
  let autoSeek = null, seekOwner = null, lastValidPosition = null, reloadPosition = null, cancelledBeforePosition = false;
  const listeners = [];
  const latestVideo = () => {
    const latest = getVideo();
    if (String(latest?.id || "") === videoId && (latest !== observedVideo || latest.watch !== observedWatch)) {
      currentVideo = { ...currentVideo, ...latest,
        ...(latest.watch === undefined && currentVideo.watch !== undefined ? { watch: currentVideo.watch } : {}) };
      observedVideo = latest; observedWatch = latest.watch;
    }
    return currentVideo;
  };
  const isCurrent = () => !disposed && player.isConnected && stage.isConnected && player === getActivePlayer()
    && !player.classList.contains("is-ghost") && String(player.dataset.videoId || "") === videoId
    && String(getVideo()?.id || "") === videoId;
  const identity = () => [player.getAttribute?.("src") || player.currentSrc || "",
    String(player.dataset.shortVideoSourceGeneration || "0"), String(player.dataset.shortVideoSlot || ""),
    String(player.dataset.shortVideoPromotedAt || ""), String(player.dataset.shortVideoWarmScheduleToken || ""),
    String(player.dataset.shortVideoPlaybackIntentGeneration || "0"), ...getContext()];
  const owns = (owner) => isCurrent() && identity().every((value, index) => value === owner.identity[index]);
  const duration = () => { const value = Number(player.duration); return Number.isFinite(value) && value > 0 ? value : 0; };
  const canPersist = () => restored && !pending && isCurrent() && player.readyState >= 2
    && Number.isFinite(Number(player.currentTime))
    && (!cancelledBeforePosition || Number(player.currentTime) > 0)
    && (player.dataset.shortVideoFrameReady === "1" || typeof player.requestVideoFrameCallback !== "function");
  const write = (options = {}) => {
    if (!canPersist()) return false;
    lastValidPosition = Math.max(0, Number(player.currentTime));
    persist(latestVideo(), player, options);
    initialWrite = false;
    return true;
  };
  const markRestored = () => {
    restored = true;
    initialWrite = true;
    player.dataset.watchRestored = "1";
    player.dataset.watchRestoredAt = String(now());
  };
  const stopPending = () => {
    const previous = pending;
    pending = null;
    if (bootstrapFrame) cancelFrame(bootstrapFrame);
    bootstrapFrame = 0;
    if (previous?.frame) cancelFrame(previous.frame);
    previous?.abort.abort();
    delete player.dataset.watchRestoreScheduled;
  };
  function cancel({ settle = true } = {}) {
    if (disposed) return;
    if (!settle && restored && isCurrent() && Number.isFinite(Number(player.currentTime))) {
      reloadPosition = Math.max(0, Number(player.currentTime));
    }
    else if (!settle && reloadPosition === null) reloadPosition = lastValidPosition;
    stopPending();
    autoSeek = null;
    if (!settle) seekOwner = null;
    // Explicit seek/play/pause settles the initial resume choice in favor of
    // the user's current position. Reload only invalidates the old async work.
    if (settle) {
      if (!restored) cancelledBeforePosition = true;
      reloadPosition = null; markRestored();
    }
    else { restored = false; initialWrite = false; delete player.dataset.watchRestored; }
  }
  function scheduleRestore() {
    if (!isCurrent() || restored || pending || !duration()) return;
    const watch = getWatch(latestVideo());
    if (reloadPosition === null && resume && (!watch || typeof watch !== "object")) return;
    const progress = Number(watch?.progressMs || 0);
    const progressMs = Number.isFinite(progress) ? Math.max(0, progress) : 0;
    // completed is historical/sticky in the store. Only the latest position
    // and the existing 1.5s bounds decide whether the current viewing resumes.
    const restoringSource = reloadPosition !== null;
    const target = restoringSource ? Math.min(reloadPosition, Math.max(0, duration() - .2)) : progressMs / 1000;
    const eligible = restoringSource ? target > 0 : resume && progressMs >= 1500 && duration() * 1000 - progressMs >= 1500;
    if (!eligible) { reloadPosition = null; markRestored(); write({ force: true }); return; }
    const owner = { identity: identity(), abort: new AbortController(), frame: 0, target, restoringSource };
    pending = owner;
    player.dataset.watchRestoreScheduled = "1";
    const afterFrame = (ready) => {
      if (pending !== owner) return;
      if (!owns(owner)) { stopPending(); return; }
      if (!ready || (typeof player.requestVideoFrameCallback === "function" && player.dataset.shortVideoFrameReady !== "1")) {
        stopPending();
        return;
      }
      owner.frame = requestFrame(() => {
        if (pending !== owner) return;
        owner.frame = 0;
        if (!owns(owner) || !duration()) { stopPending(); return; }
        if (!owner.restoringSource) {
          // Detail metadata or an accepted local write may arrive while the
          // first frame/RAF is pending. Commit the latest saved point only.
          const latestWatch = getWatch(latestVideo());
          if (!latestWatch || typeof latestWatch !== "object") { stopPending(); return; }
          const latestProgress = Number(latestWatch.progressMs || 0);
          const latestMs = Number.isFinite(latestProgress) ? Math.max(0, latestProgress) : 0;
          if (latestMs < 1500 || duration() * 1000 - latestMs < 1500) {
            pending = null;
            delete player.dataset.watchRestoreScheduled;
            markRestored();
            write({ force: true });
            return;
          }
          owner.target = latestMs / 1000;
        }
        pending = null;
        delete player.dataset.watchRestoreScheduled;
        try {
          autoSeek = { identity: owner.identity, target: owner.target };
          player.currentTime = owner.target;
          reloadPosition = null;
          cancelledBeforePosition = false;
          markRestored();
          if (!owner.restoringSource) onResume(owner.target);
          write({ force: true });
        } catch {
          autoSeek = null;
          // Keep the previous stored position if the media cannot seek yet.
          // A later metadata/play event can retry; there is no polling loop.
        }
      });
    };
    try { Promise.resolve(waitForFirstFrame(player, 1800, { signal: owner.abort.signal })).then(afterFrame, () => afterFrame(false)); }
    catch { afterFrame(false); }
  }
  const listen = (event, listener) => { player.addEventListener(event, listener); listeners.push([event, listener]); };
  listen("loadedmetadata", scheduleRestore);
  listen("playing", () => { scheduleRestore(); write(initialWrite ? { force: true } : {}); });
  listen("shortvideoframeready", () => { scheduleRestore(); if (initialWrite) write({ force: true }); });
  listen("pause", () => write({ force: true }));
  listen("timeupdate", () => {
    scheduleRestore();
    if (!canPersist()) return;
    const length = duration(), current = Math.max(0, Number(player.currentTime || 0));
    if (length > 0 && length - current <= 0.8) {
      if (player.dataset.watchCompleted !== "1") { player.dataset.watchCompleted = "1"; write({ force: true, completed: true }); }
      return;
    }
    if (length > 0 && current < length * 0.5) player.dataset.watchCompleted = "";
    write(initialWrite ? { force: true } : {});
  });
  listen("ended", () => write({ force: true, completed: true }));
  listen("seeking", () => {
    if (!isCurrent() || player.readyState < 1) return;
    if (autoSeek && owns(autoSeek) && Math.abs(Number(player.currentTime) - autoSeek.target) < .01) return;
    cancel();
    cancelledBeforePosition = false;
    seekOwner = { identity: identity() };
  });
  listen("seeked", () => {
    const owner = seekOwner || (initialWrite ? autoSeek : null);
    seekOwner = null;
    autoSeek = null;
    // A paused seek can temporarily drop readyState to HAVE_METADATA, so
    // its immediate control-bar flush may fail. Save once data is ready.
    if (owner && owns(owner)) write({ force: true });
  });
  for (const event of ["emptied", "loadstart"]) listen(event, () => cancel({ settle: false }));
  bootstrapFrame = requestFrame(() => { bootstrapFrame = 0; scheduleRestore(); });
  return Object.freeze({
    cancel, canPersist, flush: (options = { force: true }) => write(options),
    update(next) {
      if (disposed || String(next?.id || "") !== videoId) return false;
      currentVideo = { ...currentVideo, ...next, ...(next.watch === undefined && currentVideo.watch !== undefined ? { watch: currentVideo.watch } : {}) };
      scheduleRestore();
      return true;
    },
    dispose() {
      if (disposed) return;
      stopPending();
      disposed = true;
      autoSeek = null;
      seekOwner = null;
      listeners.forEach(([event, listener]) => player.removeEventListener(event, listener));
    }
  });
}

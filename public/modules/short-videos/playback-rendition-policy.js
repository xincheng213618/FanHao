export function createShortVideoPlaybackRenditionPolicy({ api }) {
  const smoothFallbackIds = new Set();
  const issueReports = new Set();
  const playerRecoveries = new WeakMap();

  const playerSource = (player) => String(player?.getAttribute?.("src")
    || player?.currentSrc || player?.dataset?.streamUrl || "").trim();
  const playerIsCurrent = (player, id) => Boolean(player?.isConnected
    && !player.classList?.contains("is-ghost") && String(player.dataset?.videoId || "") === id);
  const recoveryIdentity = player => ["shortVideoSourceGeneration", "shortVideoSlot", "shortVideoPromotedAt",
    "shortVideoWarmScheduleToken", "shortVideoPlaybackIntentGeneration"].map(key => String(player.dataset?.[key] || "0"));

  function cancelPlayerRecovery(player) {
    const recovery = playerRecoveries.get(player);
    if (!recovery) return false;
    playerRecoveries.delete(player);
    if (recovery.timer) window.clearTimeout(recovery.timer);
    recovery.listeners.forEach(([event, listener]) => player.removeEventListener(event, listener));
    if (player.shortVideoCancelPlaybackRecovery === recovery.cancel) delete player.shortVideoCancelPlaybackRecovery;
    return true;
  }

  function ownsRecovery(player, recovery) {
    const owned = playerRecoveries.get(player) === recovery
      && playerIsCurrent(player, recovery.id) && playerSource(player) === recovery.source
      && recovery.options.isCurrent?.() !== false
      && recoveryIdentity(player).every((value, index) => (recovery.reloading && index === 0) || value === recovery.identity[index]);
    if (!owned && playerRecoveries.get(player) === recovery) cancelPlayerRecovery(player);
    return owned;
  }

  function beginRecovery(player, video, options, phase) {
    cancelPlayerRecovery(player);
    const recovery = {
      id: String(video?.id || player.dataset.videoId || ""), source: playerSource(player),
      phase, timer: 0, listeners: [], options, identity: recoveryIdentity(player), reloading: false,
      preservedTime: Number.isFinite(Number(options.resumeTime)) ? Math.max(0, Number(options.resumeTime))
        : Math.max(0, Number(options.lastGoodTime || 0), Number(player.currentTime || 0)),
      wantsToPlay: Boolean(options.wantsToPlay || (!player.paused && !player.ended))
    };
    const listen = (event, listener) => {
      recovery.listeners.push([event, listener]);
      player.addEventListener(event, listener);
    };
    recovery.cancel = () => cancelPlayerRecovery(player);
    playerRecoveries.set(player, recovery);
    player.shortVideoCancelPlaybackRecovery = recovery.cancel;
    // A reload owns exactly one source and player role. Native load/pause
    // events are not user pause intent; callers supply the latest intent when
    // restoring metadata and cancel explicitly on user controls or demotion.
    listen("loadedmetadata", () => {
      if (recovery.phase !== "reloading" || !ownsRecovery(player, recovery)) return;
      const duration = Math.max(0, Number(player.duration || 0));
      if (duration > 0 && recovery.preservedTime > 0) {
        try { player.currentTime = Math.min(recovery.preservedTime, Math.max(0, duration - 0.2)); } catch {}
      }
      const shouldPlay = typeof options.canResume === "function" ? options.canResume() : recovery.wantsToPlay;
      cancelPlayerRecovery(player);
      if (shouldPlay) player.play?.().catch(() => {});
    });
    const checkSource = () => { ownsRecovery(player, recovery); };
    ["emptied", "loadstart", "pause"].forEach((event) => listen(event, checkSource));
    const recovered = () => {
      if (!ownsRecovery(player, recovery)) return;
      if (recovery.phase === "waiting" && player.readyState >= 2 && !player.error) cancelPlayerRecovery(player);
    };
    ["loadeddata", "canplay", "playing"].forEach((event) => listen(event, recovered));
    return recovery;
  }

  function reloadRecovery(player, video, recovery, source, options, reason) {
    if (!ownsRecovery(player, recovery)) return false;
    recovery.phase = "reloading";
    recovery.source = source;
    // Other source changes cancel recovery in the source lifecycle. This
    // owned reload alone retains its metadata listener through load().
    recovery.reloading = true;
    let restored = false;
    try {
      restored = options.ensureSource?.(player, video, {
        source, forceReload: true, preservePlaybackRecovery: true, reason
      }) === true;
    } finally {
      recovery.identity[0] = recoveryIdentity(player)[0];
      recovery.reloading = false;
      if (!restored) cancelPlayerRecovery(player);
    }
    return restored;
  }

  function playbackUrl(video = {}) {
    const source = String(video?.streamUrl || "").trim();
    if (!source || !smoothFallbackIds.has(String(video?.id || ""))) return source;
    return smoothPlaybackUrl(video);
  }

  function smoothPlaybackUrl(video = {}) {
    const source = String(video?.streamUrl || "").trim();
    if (!source || !source.includes("/media/short-video/")) return source;
    const smoothSource = source.replace("/media/short-video/", "/media/short-video-smooth/");
    return `${smoothSource}${smoothSource.includes("?") ? "&" : "?"}rendition=2k30-v3-pinned`;
  }

  function preparePlayer(player, video = {}) {
    if (!player || String(player.dataset.videoId || "") === String(video?.id || "")) return;
    delete player.dataset.shortVideoSmoothFallback;
    delete player.dataset.shortVideoSmoothRetryCount;
  }

  function switchToSmoothFallback(player, video = {}, reason = "playback-stalled", options = {}) {
    const id = String(video?.id || player?.dataset?.videoId || "").trim();
    const smoothSource = smoothPlaybackUrl(video);
    const currentSource = String(player?.currentSrc || player?.getAttribute?.("src") || player?.dataset?.streamUrl || "").trim();
    if (options.isCurrent?.() === false || !playerIsCurrent(player, id) || !id || !smoothSource || smoothSource === String(video?.streamUrl || "").trim()
      || currentSource.includes("/media/short-video-smooth/")
      || player.dataset.shortVideoSmoothFallback === "1") return false;

    const recovery = beginRecovery(player, video, options, "waiting");
    if (!reloadRecovery(player, video, recovery, smoothSource, options, `observed-${reason}`)) return false;
    smoothFallbackIds.add(id);
    player.dataset.shortVideoSmoothFallback = "1";
    reportIssue(player, video, reason);
    return true;
  }

  function reportIssue(player, video, reason) {
    const id = String(video?.id || player?.dataset?.videoId || "").trim();
    const reportKey = `${id}:${reason}`;
    if (!id || issueReports.has(reportKey)) return;
    issueReports.add(reportKey);
    api("/api/short-videos/playback-issues", {
      method: "POST",
      body: {
        id,
        reason,
        mediaErrorCode: Number(player?.error?.code || 0),
        readyState: Number(player?.readyState || 0),
        currentTime: Math.max(0, Number(player?.currentTime || 0))
      }
    }).catch((error) => {
      issueReports.delete(reportKey);
      console.warn("播放问题记录失败", error);
    });
  }

  function retrySmoothFallback(player, video = {}, options = {}) {
    const id = String(video?.id || player?.dataset?.videoId || "").trim();
    const currentSource = playerSource(player);
    if (options.isCurrent?.() === false || !playerIsCurrent(player, id) || !currentSource.includes("/media/short-video-smooth/")) return false;
    const pending = playerRecoveries.get(player);
    if (pending?.phase === "waiting" && ownsRecovery(player, pending)) return true;
    cancelPlayerRecovery(player);
    const retryLimit = 4;
    const attempt = Math.max(0, Number(player.dataset.shortVideoSmoothRetryCount || 0)) + 1;
    if (attempt > retryLimit) return false;
    player.dataset.shortVideoSmoothRetryCount = String(attempt);
    const recovery = beginRecovery(player, video, options, "waiting");
    recovery.timer = window.setTimeout(() => {
      recovery.timer = 0;
      if (!ownsRecovery(player, recovery)) return;
      const smoothSource = smoothPlaybackUrl(video);
      const retrySource = `${smoothSource}${smoothSource.includes("?") ? "&" : "?"}retry=${attempt}`;
      reloadRecovery(player, video, recovery, retrySource, options, `smooth-rendition-retry-${attempt}`);
    }, 1200);
    options.onScheduled?.(attempt, retryLimit);
    return true;
  }

  return Object.freeze({ cancelPlayerRecovery, playbackUrl, preparePlayer, retrySmoothFallback, smoothPlaybackUrl, switchToSmoothFallback });
}

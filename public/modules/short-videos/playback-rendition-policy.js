export function createShortVideoPlaybackRenditionPolicy({ api }) {
  const smoothFallbackIds = new Set();
  const issueReports = new Set();

  function playbackUrl(video = {}) {
    const source = String(video?.streamUrl || "").trim();
    if (!source || !smoothFallbackIds.has(String(video?.id || ""))) return source;
    return smoothPlaybackUrl(video);
  }

  function smoothPlaybackUrl(video = {}) {
    const source = String(video?.streamUrl || "").trim();
    if (!source || !source.includes("/media/short-video/")) return source;
    const smoothSource = source.replace("/media/short-video/", "/media/short-video-smooth/");
    return `${smoothSource}${smoothSource.includes("?") ? "&" : "?"}rendition=2k30-v2-range2`;
  }

  function preparePlayer(player, video = {}) {
    if (!player || String(player.dataset.videoId || "") === String(video?.id || "")) return;
    delete player.dataset.shortVideoSmoothFallback;
  }

  function switchToSmoothFallback(player, video = {}, reason = "playback-stalled", options = {}) {
    const id = String(video?.id || player?.dataset?.videoId || "").trim();
    const smoothSource = smoothPlaybackUrl(video);
    const currentSource = String(player?.currentSrc || player?.getAttribute?.("src") || player?.dataset?.streamUrl || "").trim();
    if (!player || !id || !smoothSource || smoothSource === String(video?.streamUrl || "").trim()
      || currentSource.includes("/media/short-video-smooth/")
      || player.dataset.shortVideoSmoothFallback === "1") return false;

    smoothFallbackIds.add(id);
    player.dataset.shortVideoSmoothFallback = "1";
    reportIssue(player, video, reason);
    const preservedTime = Math.max(0, Number(options.lastGoodTime || 0), Number(player.currentTime || 0));
    const shouldPlay = Boolean(options.wantsToPlay || (!player.paused && !player.ended));
    player.addEventListener("loadedmetadata", () => {
      const duration = Math.max(0, Number(player.duration || 0));
      if (duration > 0 && preservedTime > 0) {
        try { player.currentTime = Math.min(preservedTime, Math.max(0, duration - 0.2)); } catch {}
      }
      if (shouldPlay) player.play?.().catch(() => {});
    }, { once: true });
    return options.ensureSource?.(player, video, {
      source: smoothSource,
      forceReload: true,
      reason: `observed-${reason}`
    }) === true;
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

  return Object.freeze({ playbackUrl, preparePlayer, smoothPlaybackUrl, switchToSmoothFallback });
}

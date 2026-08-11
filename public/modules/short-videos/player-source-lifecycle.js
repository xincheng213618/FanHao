export function createShortVideoPlayerSourceLifecycle({ markPerformance, playbackUrl, waitForFirstFrame }) {
  function ensureSource(player, video = null, options = {}) {
    if (!player) return false;
    const source = String(
      options.source
      || player.dataset.streamUrl
      || playbackUrl(video)
      || player.currentSrc
      || player.getAttribute("src")
      || ""
    ).trim();
    if (!source) return false;
    player.dataset.streamUrl = source;
    const boundSource = String(player.currentSrc || player.getAttribute("src") || "").trim();
    const shouldReload = Boolean(options.forceReload || player.error
      || player.dataset.shortVideoDecoderReleased === "1" || !boundSource);
    if (!shouldReload) return false;
    delete player.dataset.shortVideoFrameReady;
    delete player.dataset.shortVideoFrameReadyAt;
    delete player.dataset.shortVideoDecoderReleased;
    player.src = source;
    player.load?.();
    markPerformance("video-source-restored", {
      videoId: String(video?.id || player.dataset.videoId || ""),
      reason: String(options.reason || "missing-source")
    });
    return true;
  }

  async function warm(player, video, options = {}) {
    if (!player) return false;
    const source = String(player.dataset.streamUrl || playbackUrl(video)
      || player.currentSrc || player.getAttribute("src") || "").trim();
    if (!source) return false;
    const pauseAfter = options.pauseAfter !== false;
    const settleGhost = () => {
      if (!pauseAfter || !player.classList.contains("is-ghost")) return;
      player.pause?.();
      player.muted = true;
      player.preload = "metadata";
    };
    if (options.forceReload || player.error || !player.currentSrc
      || player.dataset.shortVideoDecoderReleased === "1") {
      ensureSource(player, video, {
        source,
        forceReload: true,
        reason: String(options.reason || "adjacent-warm")
      });
    }
    player.preload = "auto";
    player.muted = true;
    if (player.readyState >= 1 && player.currentTime > 0.12) {
      delete player.dataset.shortVideoFrameReady;
      delete player.dataset.shortVideoFrameReadyAt;
      try { player.currentTime = 0; } catch {}
    }
    const readyPromise = waitForFirstFrame(player, Math.max(200, Number(options.timeout || 1000)));
    player.play?.().catch(() => {});
    const ready = await readyPromise;
    settleGhost();
    return ready || player.readyState >= 2;
  }

  return {
    ensureShortVideoPlayerSource: ensureSource,
    warmAdjacentVideoPlayer: warm
  };
}

export function disposeShortVideoMedia(root, options = {}) {
  const release = options.release !== false;
  root?.querySelectorAll?.("video, audio")?.forEach?.((player) => {
    try {
      player.muted = true;
      player.onended = null;
      player.pause?.();
      if (release) {
        player.removeAttribute?.("src");
        player.load?.();
      }
    } catch {}
  });
}

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
    player.shortVideoCancelTapGuard?.();
    player.shortVideoCancelPictureInPicture?.();
    player.shortVideoCancelWatchResume?.({ settle: false });
    player.shortVideoCancelHoldSpeed?.();
    if (!options.preservePlaybackRecovery) player.shortVideoCancelPlaybackRecovery?.();
    player.shortVideoCancelFirstFrame?.();
    if (!options.preservePlaybackStatus) player.shortVideoCancelPlaybackStatus?.();
    player.dataset.shortVideoSourceGeneration = String(Number(player.dataset.shortVideoSourceGeneration || 0) + 1);
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
    if (options.forceReload || player.error || !(player.currentSrc || player.getAttribute("src"))
      || player.dataset.shortVideoDecoderReleased === "1") {
      ensureSource(player, video, {
        source,
        forceReload: true,
        reason: String(options.reason || "adjacent-warm")
      });
    }
    const warmIdentity = {
      token: player.dataset.shortVideoWarmScheduleToken,
      videoId: player.dataset.videoId,
      slot: player.dataset.shortVideoSlot,
      sourceGeneration: player.dataset.shortVideoSourceGeneration,
      source: player.getAttribute("src") || player.currentSrc || ""
    };
    const ownsWarmup = () => warmIdentity.token === player.dataset.shortVideoWarmScheduleToken
      && warmIdentity.videoId === player.dataset.videoId && warmIdentity.slot === player.dataset.shortVideoSlot
      && warmIdentity.sourceGeneration === player.dataset.shortVideoSourceGeneration
      && warmIdentity.source === (player.getAttribute("src") || player.currentSrc || "");
    const settleGhost = () => {
      if (!pauseAfter || !ownsWarmup() || !player.classList.contains("is-ghost")) return;
      player.pause?.();
      player.muted = true;
      player.preload = "metadata";
    };
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
    return ownsWarmup() && ready;
  }

  return {
    ensureShortVideoPlayerSource: ensureSource,
    warmAdjacentVideoPlayer: warm
  };
}

export function disposeShortVideoMedia(root, options = {}) {
  const release = options.release !== false;
  if (release) {
    root?.shortVideoDisposeCaption?.();
    root?.querySelectorAll?.(".short-video-reel-panel")?.forEach?.((panel) => panel.shortVideoDisposeCaption?.());
  }
  if (release) root?.querySelectorAll?.(".short-video-gallery-player")?.forEach?.((gallery) => {
    gallery.shortVideoGalleryDispose?.();
  });
  root?.querySelectorAll?.("video, audio")?.forEach?.((player) => {
    try {
      player.shortVideoCancelWarmup?.();
      player.shortVideoCancelTapGuard?.();
      player.shortVideoCancelPictureInPicture?.();
      player.shortVideoDisposeSoundPreview?.({ restorePlayback: false });
      player.shortVideoFlushWatch?.({ force: true });
      if (release) player.shortVideoDisposeWatchResume?.();
      else player.shortVideoCancelWatchResume?.();
      if (release) player.shortVideoDisposeHoldSpeed?.();
      else player.shortVideoCancelHoldSpeed?.();
      player.shortVideoCancelPlaybackRecovery?.();
      player.shortVideoCancelFirstFrame?.();
      player.shortVideoCancelPlaybackStatus?.();
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

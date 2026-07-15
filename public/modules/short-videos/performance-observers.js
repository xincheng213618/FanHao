export function startShortVideoPerformanceObservers(markShortVideoPerformance) {
  if (document.documentElement.dataset.shortVideoPerfCapture !== "1") return;
  let longTaskObserver = null;
  let frameHandle = 0;
  let sampleStartedAt = 0;
  let previousFrameAt = 0;
  let frameCount = 0;
  let frameGapTotal = 0;
  let maxFrameGap = 0;
  let frameGapsOver50 = 0;
  let mediaMonitorTimer = 0;
  let mediaFramePlayer = null;
  let mediaFrameHandle = 0;
  let mediaSampleStartedAt = 0;
  let previousMediaFrameAt = 0;
  let mediaFrameCount = 0;
  let mediaFrameGapTotal = 0;
  let maxMediaFrameGap = 0;
  let mediaFrameStallsOver100 = 0;
  let playbackQualityBaseline = { total: 0, dropped: 0 };
  try {
    if (
      typeof globalThis.PerformanceObserver === "function"
      && globalThis.PerformanceObserver.supportedEntryTypes?.includes?.("longtask")
    ) {
      longTaskObserver = new globalThis.PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          markShortVideoPerformance("main-thread-long-task", {
            durationMs: Math.round(Number(entry.duration || 0)),
            startTimeMs: Math.round(Number(entry.startTime || 0))
          });
        });
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    }
  } catch {}
  const readPlaybackQuality = (player) => {
    try {
      const quality = player?.getVideoPlaybackQuality?.();
      return {
        total: Math.max(0, Number(quality?.totalVideoFrames ?? player?.webkitDecodedFrameCount ?? 0)),
        dropped: Math.max(0, Number(quality?.droppedVideoFrames ?? player?.webkitDroppedFrameCount ?? 0))
      };
    } catch {
      return { total: 0, dropped: 0 };
    }
  };
  const mediaFrameDetails = (player, durationMs, metadata = {}) => {
    const quality = readPlaybackQuality(player);
    return {
      videoId: String(player?.dataset?.videoId || ""),
      durationMs: Math.max(0, Math.round(durationMs || 0)),
      frameCount: mediaFrameCount,
      averageGapMs: mediaFrameCount ? Math.round((mediaFrameGapTotal / mediaFrameCount) * 10) / 10 : 0,
      maxGapMs: Math.round(maxMediaFrameGap * 10) / 10,
      stallsOver100: mediaFrameStallsOver100,
      totalVideoFrames: Math.max(0, quality.total - playbackQualityBaseline.total),
      droppedVideoFrames: Math.max(0, quality.dropped - playbackQualityBaseline.dropped),
      presentedFrames: Math.max(0, Number(metadata.presentedFrames || 0)),
      quality
    };
  };
  const resetMediaFrameSample = (player, reason = "player-change") => {
    if (mediaFramePlayer && mediaFrameCount > 0) {
      const details = mediaFrameDetails(
        mediaFramePlayer,
        Math.max(0, previousMediaFrameAt - mediaSampleStartedAt)
      );
      markShortVideoPerformance("media-frame-segment", {
        ...details,
        quality: undefined,
        reason
      });
    }
    if (mediaFramePlayer && mediaFrameHandle) {
      try {
        mediaFramePlayer.cancelVideoFrameCallback?.(mediaFrameHandle);
      } catch {}
    }
    mediaFramePlayer = player || null;
    mediaFrameHandle = 0;
    mediaSampleStartedAt = 0;
    previousMediaFrameAt = 0;
    mediaFrameCount = 0;
    mediaFrameGapTotal = 0;
    maxMediaFrameGap = 0;
    mediaFrameStallsOver100 = 0;
    playbackQualityBaseline = readPlaybackQuality(mediaFramePlayer);
  };
  const sampleMediaFrame = (now, metadata = {}) => {
    const player = mediaFramePlayer;
    if (!player?.isConnected || typeof player.requestVideoFrameCallback !== "function") return;
    if (!mediaSampleStartedAt) mediaSampleStartedAt = now;
    if (previousMediaFrameAt && document.visibilityState === "visible") {
      const gap = Math.max(0, now - previousMediaFrameAt);
      mediaFrameCount += 1;
      mediaFrameGapTotal += gap;
      maxMediaFrameGap = Math.max(maxMediaFrameGap, gap);
      if (gap > 100) mediaFrameStallsOver100 += 1;
    }
    previousMediaFrameAt = now;
    if (now - mediaSampleStartedAt >= 2000) {
      const details = mediaFrameDetails(player, now - mediaSampleStartedAt, metadata);
      markShortVideoPerformance("media-frame-sample", {
        ...details,
        quality: undefined
      });
      mediaSampleStartedAt = now;
      mediaFrameCount = 0;
      mediaFrameGapTotal = 0;
      maxMediaFrameGap = 0;
      mediaFrameStallsOver100 = 0;
      playbackQualityBaseline = details.quality;
    }
    mediaFrameHandle = player.requestVideoFrameCallback(sampleMediaFrame);
  };
  const monitorActiveMediaPlayer = () => {
    const player = document.querySelector(
      ".short-video-reel-panel.is-current .short-video-player:not(.is-ghost)"
    );
    if (player !== mediaFramePlayer) {
      resetMediaFrameSample(player, "player-change");
      if (typeof player?.requestVideoFrameCallback === "function") {
        mediaFrameHandle = player.requestVideoFrameCallback(sampleMediaFrame);
      }
    }
    mediaMonitorTimer = window.setTimeout(monitorActiveMediaPlayer, 120);
  };
  const sampleFrame = (now) => {
    if (!sampleStartedAt) sampleStartedAt = now;
    if (previousFrameAt && document.visibilityState === "visible") {
      const gap = Math.max(0, now - previousFrameAt);
      frameCount += 1;
      frameGapTotal += gap;
      maxFrameGap = Math.max(maxFrameGap, gap);
      if (gap > 50) frameGapsOver50 += 1;
    }
    previousFrameAt = now;
    if (now - sampleStartedAt >= 2000) {
      markShortVideoPerformance("render-frame-sample", {
        durationMs: Math.round(now - sampleStartedAt),
        frameCount,
        averageGapMs: frameCount ? Math.round((frameGapTotal / frameCount) * 10) / 10 : 0,
        maxGapMs: Math.round(maxFrameGap * 10) / 10,
        gapsOver50: frameGapsOver50
      });
      sampleStartedAt = now;
      frameCount = 0;
      frameGapTotal = 0;
      maxFrameGap = 0;
      frameGapsOver50 = 0;
    }
    frameHandle = window.requestAnimationFrame(sampleFrame);
  };
  frameHandle = window.requestAnimationFrame(sampleFrame);
  mediaMonitorTimer = window.setTimeout(monitorActiveMediaPlayer, 0);
  window.addEventListener("pagehide", () => {
    longTaskObserver?.disconnect?.();
    if (frameHandle) window.cancelAnimationFrame(frameHandle);
    if (mediaMonitorTimer) window.clearTimeout(mediaMonitorTimer);
    resetMediaFrameSample(null, "pagehide");
  }, { once: true });
  markShortVideoPerformance("performance-observer-ready", {
    longTasks: Boolean(longTaskObserver),
    frameSampling: true,
    mediaFrameSampling: true
  });
}

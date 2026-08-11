import { shortVideoDetailApiPath } from "./router.js";

export function createShortVideoMediaCache(dependencies) {
  const {
    api,
    cacheAuthorPanelVideo,
    cachedAuthorPanelVideo,
    galleryImageEntries,
    getFeedParams,
    isGalleryPost,
    markPerformance,
    shortVideoCardCoverUrl,
    shortVideoPlaybackUrl,
    takeDirectPlaybackPrewarm,
    waitForVideoFirstFrame
  } = dependencies;

  const NAVIGATION_CACHE_LIMIT = 32;
  const NEIGHBOR_CACHE_LIMIT = 96;
  const DETAIL_NEIGHBOR_LIMIT = 1;
  const PLAYBACK_PRELOAD_LIMIT = 1;
  const PLAYBACK_PRELOAD_TIMEOUT_MS = 2800;
  const MEDIA_PREFETCH_LIMIT = 18;

  const detailRequests = new Map();
  const resolvedDetails = new Map();
  const navigation = new Map();
  const videos = new Map();
  const mediaPrefetches = new Map();
  const playbackPreloads = new Map();
  let prewarmShelf = null;

  function stats() {
    return {
      videos: videos.size,
      navigation: navigation.size,
      detailRequests: detailRequests.size,
      resolvedDetails: resolvedDetails.size,
      mediaPrefetches: mediaPrefetches.size,
      playbackPreloads: playbackPreloads.size
    };
  }

  function rememberVideo(video) {
    const id = String(video?.id || "").trim();
    if (!id) return null;
    videos.delete(id);
    videos.set(id, video);
    trimMap(videos, NAVIGATION_CACHE_LIMIT);
    return video;
  }

  function cachedVideo(id) {
    const key = String(id || "").trim();
    if (!key) return null;
    return cachedAuthorPanelVideo(key) || videos.get(key) || null;
  }

  function navigationKey(id, params = getFeedParams()) {
    const videoId = String(id || "").trim();
    return videoId ? `${params}::${videoId}` : "";
  }

  function cachedNavigation(id, params = getFeedParams()) {
    const key = navigationKey(id, params);
    return key ? navigation.get(key) || null : null;
  }

  function rememberNavigation(data, params = getFeedParams()) {
    const current = data?.video;
    const currentId = String(current?.id || "").trim();
    if (!currentId) return;
    const previous = Array.isArray(data?.neighbors?.previous) ? data.neighbors.previous.filter((video) => video?.id) : [];
    const next = Array.isArray(data?.neighbors?.next) ? data.neighbors.next.filter((video) => video?.id) : [];
    previous.forEach(rememberVideo);
    rememberVideo(current);
    next.forEach(rememberVideo);
    const chain = [...previous].reverse().concat(current, next);
    chain.forEach((video, index) => {
      const id = String(video?.id || "").trim();
      const key = navigationKey(id, params);
      if (!key) return;
      const item = { ...(navigation.get(key) || {}) };
      if (index > 0) item.prevId = String(chain[index - 1]?.id || "");
      if (index < chain.length - 1) item.nextId = String(chain[index + 1]?.id || "");
      if (id === currentId) {
        item.prevId = String(data.prevId || "");
        item.nextId = String(data.nextId || "");
      }
      navigation.delete(key);
      navigation.set(key, item);
    });
    trimMap(navigation, NEIGHBOR_CACHE_LIMIT);
  }

  function fetchDetail(videoId, params = getFeedParams()) {
    const id = String(videoId || "").trim();
    if (!id) return Promise.resolve(null);
    const cacheKey = `${params}::${id}`;
    const cached = detailRequests.get(cacheKey);
    if (cached) {
      markPerformance("video-detail-cache-hit", { videoId: id });
      return cached;
    }
    const detailParams = new URLSearchParams(params);
    detailParams.set("neighbors", String(DETAIL_NEIGHBOR_LIMIT));
    detailParams.set("metadata", "0");
    const requestStartedAt = Date.now();
    markPerformance("video-detail-request-start", { videoId: id });
    const request = api(`${shortVideoDetailApiPath(id)}?${detailParams}`).then((data) => {
      markPerformance("video-detail-request-finish", {
        videoId: id,
        durationMs: Date.now() - requestStartedAt,
        previousId: String(data?.prevId || ""),
        nextId: String(data?.nextId || "")
      });
      rememberNavigation(data, params);
      resolvedDetails.delete(cacheKey);
      resolvedDetails.set(cacheKey, data);
      trimMap(resolvedDetails, NAVIGATION_CACHE_LIMIT);
      return data;
    }).catch((error) => {
      markPerformance("video-detail-request-error", {
        videoId: id,
        durationMs: Date.now() - requestStartedAt,
        message: String(error?.message || error || "")
      });
      detailRequests.delete(cacheKey);
      resolvedDetails.delete(cacheKey);
      throw error;
    });
    detailRequests.set(cacheKey, request);
    trimMap(detailRequests, NAVIGATION_CACHE_LIMIT);
    return request;
  }

  function resolvedDetail(videoId, params = getFeedParams()) {
    const id = String(videoId || "").trim();
    if (!id) return null;
    return resolvedDetails.get(`${params}::${id}`) || null;
  }

  function ensurePrewarmShelf() {
    if (prewarmShelf?.isConnected) return prewarmShelf;
    prewarmShelf = document.createElement("div");
    prewarmShelf.className = "short-video-prewarm-shelf";
    prewarmShelf.setAttribute("aria-hidden", "true");
    Object.assign(prewarmShelf.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "2px",
      height: "2px",
      overflow: "hidden",
      opacity: "0.001",
      pointerEvents: "none"
    });
    document.body.append(prewarmShelf);
    return prewarmShelf;
  }

  function disposePlaybackPreload(entry) {
    const player = entry?.player;
    if (!player || entry.taken) return;
    player.muted = true;
    player.pause?.();
    player.removeAttribute("src");
    player.load?.();
    player.remove();
  }

  function trimPlaybackPreloads() {
    while (playbackPreloads.size > PLAYBACK_PRELOAD_LIMIT) {
      const [source, entry] = playbackPreloads.entries().next().value || [];
      if (!source) break;
      playbackPreloads.delete(source);
      disposePlaybackPreload(entry);
    }
  }

  function prewarmPlayback(video = {}, options = {}) {
    if (!video?.id || isGalleryPost(video)) return Promise.resolve(false);
    const source = shortVideoPlaybackUrl(video);
    if (!source) return Promise.resolve(false);
    const cached = playbackPreloads.get(source);
    if (cached) {
      playbackPreloads.delete(source);
      playbackPreloads.set(source, cached);
      markPerformance("video-prewarm-cache-hit", {
        videoId: String(video.id),
        readyState: Number(cached.player?.readyState || 0)
      });
      return cached.promise;
    }

    const player = document.createElement("video");
    player.className = "short-video-prewarm-player";
    player.dataset.streamUrl = source;
    player.dataset.videoId = String(video.id);
    player.dataset.shortVideoSlot = "prewarm";
    player.src = source;
    player.preload = "auto";
    player.controls = false;
    player.autoplay = false;
    player.loop = false;
    player.muted = true;
    player.volume = 0;
    player.playsInline = true;
    player.tabIndex = -1;
    player.setAttribute("aria-hidden", "true");
    ensurePrewarmShelf().append(player);
    const prewarmStartedAt = Date.now();
    markPerformance("video-prewarm-start", { videoId: String(video.id) });

    const entry = { player, promise: null, taken: false };
    entry.promise = (async () => {
      const timeout = Math.max(800, Number(options.timeout || PLAYBACK_PRELOAD_TIMEOUT_MS));
      const readyPromise = waitForVideoFirstFrame(player, timeout);
      player.load?.();
      player.play?.().catch(() => {});
      const ready = await readyPromise;
      if (!entry.taken) {
        player.pause?.();
        player.muted = true;
      }
      markPerformance("video-prewarm-finish", {
        videoId: String(video.id),
        ready: Boolean(ready || player.readyState >= 2),
        readyState: Number(player.readyState || 0),
        durationMs: Date.now() - prewarmStartedAt,
        taken: entry.taken
      });
      return ready || player.readyState >= 2;
    })().catch(() => {
      if (!entry.taken && playbackPreloads.get(source) === entry) {
        playbackPreloads.delete(source);
        disposePlaybackPreload(entry);
      }
      return false;
    });
    playbackPreloads.set(source, entry);
    trimPlaybackPreloads();
    return entry.promise;
  }

  function takePrewarmedPlayer(video = {}) {
    const source = shortVideoPlaybackUrl(video);
    const directPlayer = takeDirectPlaybackPrewarm?.(video, source) || null;
    if (directPlayer) {
      markPerformance("video-prewarm-taken", {
        videoId: String(video.id || directPlayer.dataset.videoId || ""),
        readyState: Number(directPlayer.readyState || 0),
        frameReady: directPlayer.dataset.shortVideoFrameReady === "1",
        direct: true
      });
      return directPlayer;
    }
    const entry = source ? playbackPreloads.get(source) : null;
    if (!entry?.player) return null;
    playbackPreloads.delete(source);
    entry.taken = true;
    const player = entry.player;
    player.dataset.shortVideoPrewarmed = "1";
    player.removeAttribute("aria-hidden");
    player.removeAttribute("tabindex");
    markPerformance("video-prewarm-taken", {
      videoId: String(video.id || player.dataset.videoId || ""),
      readyState: Number(player.readyState || 0),
      frameReady: player.dataset.shortVideoFrameReady === "1"
    });
    return player;
  }

  function prefetchFirstMedia(video = {}) {
    const galleryEntry = isGalleryPost(video) ? galleryImageEntries(video)[0] : null;
    const url = String(galleryEntry?.url || shortVideoCardCoverUrl(video) || "").trim();
    const playbackPromise = isGalleryPost(video) ? Promise.resolve(false) : prewarmPlayback(video);
    let imagePromise = Promise.resolve(false);
    if (url) {
      const cached = mediaPrefetches.get(url);
      if (cached) {
        imagePromise = cached.promise;
      } else {
        const image = new Image();
        image.decoding = "async";
        image.fetchPriority = "low";
        imagePromise = new Promise((resolve) => {
          const finish = (ready) => resolve(Boolean(ready));
          image.addEventListener("load", () => finish(true), { once: true });
          image.addEventListener("error", () => finish(false), { once: true });
          image.src = url;
          if (image.complete && image.naturalWidth) Promise.resolve().then(() => finish(true));
        });
        mediaPrefetches.set(url, { image, promise: imagePromise });
        trimMap(mediaPrefetches, MEDIA_PREFETCH_LIMIT);
      }
    }
    return Promise.all([imagePromise, playbackPromise]).then((results) => results.some(Boolean));
  }

  async function prefetchRelatedVideo(video = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return null;
    const params = getFeedParams();
    const cached = resolvedDetail(videoId, params);
    if (cached?.video) {
      prefetchFirstMedia(cached.video).catch(() => {});
      return cached;
    }
    const detail = await fetchDetail(videoId, params);
    if (detail?.video) {
      cacheAuthorPanelVideo(detail.video);
      await prefetchFirstMedia(detail.video).catch(() => false);
    }
    return detail;
  }

  function trimMap(map, limit) {
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  return Object.freeze({
    cachedNavigation,
    cachedVideo,
    fetchDetail,
    prefetchFirstMedia,
    prefetchRelatedVideo,
    prewarmPlayback,
    rememberVideo,
    resolvedDetail,
    stats,
    takePrewarmedPlayer
  });
}

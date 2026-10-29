import { shortVideoDetailApiPath } from "./router.js";
import { createShortVideoInteractionState } from "./interaction-state.js";
import { allowShortVideoSpeculativePrewarm } from "./prewarm-policy.js";

export function createShortVideoMediaCache(dependencies) {
  const {
    api,
    cacheAuthorPanelVideo,
    cachedAuthorPanelVideo,
    galleryImageEntries,
    getFeedParams,
    isGalleryPost,
    interactionState: suppliedInteractionState,
    markPerformance,
    shortVideoCardCoverUrl,
    shortVideoPlaybackUrl,
    canSpeculate = allowShortVideoSpeculativePrewarm,
    waitForVideoFirstFrame
  } = dependencies;

  const NAVIGATION_CACHE_LIMIT = 32;
  const NEIGHBOR_CACHE_LIMIT = 96;
  const DETAIL_NEIGHBOR_LIMIT = 1;
  const DETAIL_ACTIVE_LIMIT = 4;
  const DETAIL_QUEUE_LIMIT = 6;
  const DETAIL_OWNER_LIMIT = 32;
  const DETAIL_TIMEOUT_MS = 12000;
  const PLAYBACK_PRELOAD_LIMIT = 1;
  const PLAYBACK_PRELOAD_TIMEOUT_MS = 2800;
  const interactionState = suppliedInteractionState || createShortVideoInteractionState();
  const MEDIA_PREFETCH_LIMIT = 18;

  const detailRequests = new Map();
  const activeDetails = new Set();
  const queuedDetails = [];
  const durableDetailOwner = {};
  let pumpingDetails = false;
  const resolvedDetails = new Map();
  const navigation = new Map();
  const videos = new Map();
  const mediaPrefetches = new Map();
  const playbackPreloads = new Map();
  const deletedIds = new Set();
  const videoAliases = new Map();
  let prewarmShelf = null;
  const defaultPrewarmOwner = {};
  const requestIsCurrent = options => options.isCurrent?.() !== false;
  const mayWarm = options => !options.signal?.aborted && requestIsCurrent(options) && (options.explicit === true || canSpeculate());
  const pruneOwners = entry => {
    for (const [key, owner] of entry.owners) if (!mayWarm(owner)) entry.owners.delete(key);
  };

  function identities(video) {
    return [...new Set([video?.id, video?.awemeId].map(value => String(value || "").trim()).filter(Boolean))];
  }

  function rememberIdentity(video) {
    const ids = identities(video);
    if (!ids.length) return ids;
    const aliases = new Set();
    for (const id of ids) for (const alias of videoAliases.get(id) || []) aliases.add(alias);
    for (const id of ids) { aliases.delete(id); aliases.add(id); }
    if ([...aliases].some(id => deletedIds.has(id))) for (const id of aliases) deletedIds.add(id);
    while (aliases.size > NEIGHBOR_CACHE_LIMIT) aliases.delete(aliases.values().next().value);
    for (const id of aliases) { videoAliases.delete(id); videoAliases.set(id, aliases); }
    trimMap(videoAliases, NEIGHBOR_CACHE_LIMIT);
    return [...aliases];
  }

  function isDeleted(value) {
    const ids = value && typeof value === "object" ? rememberIdentity(value) : [String(value || "").trim()];
    return ids.some(id => deletedIds.has(id));
  }

  function deletedError(id) {
    return Object.assign(new Error("短视频已删除"), { code: "SHORT_VIDEO_DELETED", statusCode: 404, videoId: id });
  }

  function filterDeletedDetail(data, params) {
    if (!data) return data;
    if (isDeleted(data.video)) throw deletedError(String(data.video?.id || ""));
    const result = { ...data };
    const known = cachedNavigation(data.video?.id, params);
    for (const direction of ["prev", "next"]) {
      if (isDeleted(data[`${direction}Id`]) || isDeleted(data[`${direction}Video`])) {
        result[`${direction}Id`] = known?.[`${direction}Id`] || "";
        result[`${direction}Video`] = cachedVideo(result[`${direction}Id`]);
      }
    }
    if (data.neighbors) result.neighbors = { ...data.neighbors,
      previous: (data.neighbors.previous || []).filter(video => !isDeleted(video)),
      next: (data.neighbors.next || []).filter(video => !isDeleted(video)) };
    return result;
  }

  function forgetVideos(values = [], knownVideos = []) {
    for (const video of knownVideos) rememberIdentity(video);
    for (const value of values) {
      const ids = value && typeof value === "object" ? rememberIdentity(value) : [String(value || "").trim()];
      for (const id of ids) if (id) {
        deletedIds.add(id);
        for (const alias of videoAliases.get(id) || []) deletedIds.add(alias);
      }
    }
    // A deletion changes neighbor membership in every feed. Keep surviving
    // entities, but require new details instead of reusing an old membership GET.
    resolvedDetails.clear();
    for (const [key, entry] of detailRequests) {
      if (isDeleted(entry.id)) {
        if (entry.settled) detailRequests.delete(key);
        else cancelDetailRequest(entry, deletedError(entry.id));
      } else if (entry.settled) detailRequests.delete(key);
      else entry.membershipInvalidated = true;
    }
    for (const [key, item] of navigation) {
      const boundary = key.lastIndexOf("::"), params = key.slice(0, boundary), id = key.slice(boundary + 2);
      if (isDeleted(id)) continue;
      for (const direction of ["prevId", "nextId"]) {
        const visited = new Set();
        while (item[direction] && isDeleted(item[direction])) {
          const next = String(item[direction]);
          if (visited.has(next)) { delete item[direction]; break; }
          visited.add(next);
          const neighbor = navigation.get(navigationKey(next, params));
          if (!neighbor || !Object.hasOwn(neighbor, direction)) { delete item[direction]; break; }
          item[direction] = neighbor[direction];
        }
      }
    }
    for (const key of navigation.keys()) if (isDeleted(key.slice(key.lastIndexOf("::") + 2))) navigation.delete(key);
    for (const [id, video] of videos) if (isDeleted(video)) videos.delete(id);
    for (const [source, entry] of playbackPreloads) if (isDeleted(entry.player?.dataset?.videoId)) {
      playbackPreloads.delete(source);
      disposePlaybackPreload(entry);
    }
    for (const [url, entry] of mediaPrefetches) if ([...entry.videoIds].some(isDeleted)) {
      mediaPrefetches.delete(url);
      entry.dispose();
    }
    if (!playbackPreloads.size) { prewarmShelf?.remove(); prewarmShelf = null; }
    return new Set(deletedIds);
  }

  function stats() {
    return {
      videos: videos.size,
      navigation: navigation.size,
      detailRequests: detailRequests.size,
      detailActive: activeDetails.size,
      detailQueued: queuedDetails.length,
      detailConsumers: [...detailRequests.values()].reduce((total, entry) => total + entry.consumers.size, 0),
      resolvedDetails: resolvedDetails.size,
      aliases: videoAliases.size,
      mediaPrefetches: mediaPrefetches.size,
      playbackPreloads: playbackPreloads.size
    };
  }

  function rememberVideo(video) {
    if (isDeleted(video)) return null;
    interactionState.mergeVideo(video);
    const id = String(video?.id || "").trim();
    if (!id) return null;
    videos.delete(id);
    videos.set(id, video);
    trimMap(videos, NAVIGATION_CACHE_LIMIT);
    return video;
  }

  function cachedVideo(id) {
    const key = String(id || "").trim();
    if (!key || isDeleted(key)) return null;
    const video = cachedAuthorPanelVideo(key) || videos.get(key) || null;
    return isDeleted(video) ? null : interactionState.mergeVideo(video);
  }

  function mergeDetail(data, readEpoch) {
    if (!data) return data;
    for (const video of [data.video, data.prevVideo, data.nextVideo,
      ...(data.neighbors?.previous || []), ...(data.neighbors?.next || [])]) interactionState.mergeVideo(video, readEpoch);
    return data;
  }

  function navigationKey(id, params = getFeedParams()) {
    const videoId = String(id || "").trim();
    return videoId ? `${params}::${videoId}` : "";
  }

  function cachedNavigation(id, params = getFeedParams()) {
    if (isDeleted(id)) return null;
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

  function detailCancelled(message = "详情请求已取消") {
    return Object.assign(new Error(message), { name: "AbortError", code: "SHORT_VIDEO_DETAIL_CANCELLED" });
  }

  function detailPriority(entry) {
    return [...entry.consumers.values()].some(consumer => consumer.options.priority !== "speculative") ? "current" : "speculative";
  }

  function removeDetailConsumer(entry, key, error) {
    const consumer = entry.consumers.get(key);
    if (!consumer) return;
    entry.consumers.delete(key);
    consumer.cleanup();
    consumer.reject(error);
    if (!entry.settled && !entry.consumers.size) cancelDetailRequest(entry, error);
  }

  function settleDetailRequest(entry, error, data) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.timer = null;
    for (const consumer of entry.consumers.values()) {
      consumer.cleanup();
      if (error) consumer.reject(error); else consumer.resolve(data);
    }
    entry.consumers.clear();
    if (error) entry.reject(error); else entry.resolve(data);
  }

  function cancelDetailRequest(entry, error = detailCancelled()) {
    if (entry.settled) return;
    if (detailRequests.get(entry.key) === entry) {
      detailRequests.delete(entry.key);
      resolvedDetails.delete(entry.key);
    }
    const index = queuedDetails.indexOf(entry);
    if (index >= 0) queuedDetails.splice(index, 1);
    settleDetailRequest(entry, error);
    entry.controller.abort(error);
    // An aborted fetch retains its physical slot until the API promise really
    // settles, even when a transport ignores AbortSignal.
    pumpDetailRequests();
  }

  function releaseDetails({ force = false, speculativeOnly = false } = {}) {
    for (const entry of detailRequests.values()) {
      if (entry.settled) continue;
      for (const [key, consumer] of [...entry.consumers]) {
        if (speculativeOnly && consumer.options.priority !== "speculative") continue;
        if (force || consumer.options.signal?.aborted || !requestIsCurrent(consumer.options)) {
          removeDetailConsumer(entry, key, detailCancelled());
        }
      }
    }
    pumpDetailRequests();
  }

  function observeDetailRequest(entry, options) {
    const legacy = !options || (!options.owner && !options.signal && !options.isCurrent && !options.priority);
    const value = options || {};
    if (value.signal?.aborted || !requestIsCurrent(value)) return Promise.reject(detailCancelled());
    const key = legacy ? durableDetailOwner : value.signal || value.owner || Symbol();
    const existing = entry.consumers.get(key);
    if (existing) { existing.options = value; return existing.promise; }
    if (entry.consumers.size >= DETAIL_OWNER_LIMIT) {
      const expired = [...entry.consumers].find(([, consumer]) => consumer.options.signal?.aborted || !requestIsCurrent(consumer.options));
      const speculative = value.priority !== "speculative"
        ? [...entry.consumers].find(([, consumer]) => consumer.options.priority === "speculative") : null;
      if (expired || speculative) removeDetailConsumer(entry, (expired || speculative)[0], detailCancelled());
      else {
        const busy = Promise.reject(Object.assign(new Error("视频详情请求繁忙，请重试"), { code: "SHORT_VIDEO_DETAIL_BUSY", retryable: true }));
        busy.catch(() => {});
        return busy;
      }
    }
    let resolve, reject;
    const promise = legacy ? entry.promise : new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const onAbort = () => removeDetailConsumer(entry, key, detailCancelled());
    const consumer = { options: value, promise, resolve: legacy ? entry.resolve : resolve, reject: legacy ? entry.reject : reject,
      cleanup: () => value.signal?.removeEventListener("abort", onAbort) };
    entry.consumers.set(key, consumer);
    value.signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
  }

  function pumpDetailRequests() {
    if (pumpingDetails) return;
    pumpingDetails = true;
    try {
      for (const entry of [...queuedDetails]) {
        for (const [key, consumer] of [...entry.consumers]) {
          if (consumer.options.signal?.aborted || !requestIsCurrent(consumer.options)) removeDetailConsumer(entry, key, detailCancelled());
        }
      }
      while (activeDetails.size < DETAIL_ACTIVE_LIMIT && queuedDetails.length) {
        const index = queuedDetails.findIndex(entry => detailPriority(entry) === "current");
        const entry = queuedDetails.splice(index < 0 ? 0 : index, 1)[0];
        if (!entry.settled) dispatchDetailRequest(entry);
      }
      if (activeDetails.size >= DETAIL_ACTIVE_LIMIT && queuedDetails.some(entry => detailPriority(entry) === "current")) {
        const speculative = [...activeDetails].find(entry => !entry.settled && detailPriority(entry) === "speculative");
        if (speculative) cancelDetailRequest(speculative, detailCancelled("详情预热让位于当前视频"));
      }
    } finally { pumpingDetails = false; }
  }

  function dispatchDetailRequest(entry) {
    activeDetails.add(entry);
    const requestStartedAt = Date.now();
    const readEpoch = interactionState.captureRead();
    markPerformance("video-detail-request-start", { videoId: entry.id });
    entry.timer = setTimeout(() => {
      cancelDetailRequest(entry, Object.assign(new Error("视频详情加载超时，请重试"), {
        name: "TimeoutError", code: "SHORT_VIDEO_DETAIL_TIMEOUT", retryable: true
      }));
    }, DETAIL_TIMEOUT_MS);
    entry.timer.unref?.();
    let physical;
    try { physical = api(entry.url, { signal: entry.controller.signal }); }
    catch (error) { physical = Promise.reject(error); }
    Promise.resolve(physical).then((incoming) => {
      if (entry.settled || entry.controller.signal.aborted) return;
      releaseDetails();
      if (entry.settled) return;
      const filtered = deletedIds.size ? filterDeletedDetail(incoming, entry.params) : incoming;
      const data = entry.membershipInvalidated ? { ...filtered, shortVideoNavigationInvalidated: true } : filtered;
      if (isDeleted(entry.id)) throw deletedError(entry.id);
      mergeDetail(data, readEpoch);
      markPerformance("video-detail-request-finish", {
        videoId: entry.id, durationMs: Date.now() - requestStartedAt,
        previousId: String(data?.prevId || ""), nextId: String(data?.nextId || "")
      });
      if (detailRequests.get(entry.key) === entry && !entry.membershipInvalidated) {
        rememberNavigation(data, entry.params);
        resolvedDetails.delete(entry.key);
        resolvedDetails.set(entry.key, data);
        trimMap(resolvedDetails, NAVIGATION_CACHE_LIMIT);
      }
      settleDetailRequest(entry, null, data);
      if (entry.membershipInvalidated && detailRequests.get(entry.key) === entry) detailRequests.delete(entry.key);
    }).catch((error) => {
      if (entry.settled) return;
      markPerformance("video-detail-request-error", { videoId: entry.id,
        durationMs: Date.now() - requestStartedAt, message: String(error?.message || error || "") });
      if (detailRequests.get(entry.key) === entry) {
        detailRequests.delete(entry.key);
        resolvedDetails.delete(entry.key);
      }
      settleDetailRequest(entry, error);
    }).finally(() => {
      activeDetails.delete(entry);
      pumpDetailRequests();
    });
  }

  function fetchDetail(videoId, params = getFeedParams(), options) {
    const id = String(videoId || "").trim();
    if (!id) return Promise.resolve(null);
    if (isDeleted(id)) return Promise.reject(deletedError(id));
    const cacheKey = `${params}::${id}`;
    const cached = detailRequests.get(cacheKey);
    if (cached) {
      mergeDetail(resolvedDetails.get(cacheKey));
      markPerformance("video-detail-cache-hit", { videoId: id });
      if (cached.settled) return options?.signal?.aborted || (options && !requestIsCurrent(options)) ? Promise.reject(detailCancelled()) : cached.promise;
      const observed = observeDetailRequest(cached, options);
      pumpDetailRequests();
      return observed;
    }
    const detailParams = new URLSearchParams(params);
    detailParams.set("neighbors", String(DETAIL_NEIGHBOR_LIMIT));
    detailParams.set("metadata", "0");
    let resolve, reject;
    const entry = { id, key: cacheKey, params, url: `${shortVideoDetailApiPath(id)}?${detailParams}`,
      controller: new AbortController(), consumers: new Map(), settled: false, timer: null,
      promise: new Promise((yes, no) => { resolve = yes; reject = no; }) };
    Object.assign(entry, { resolve, reject }); entry.promise.catch(() => {});
    const observed = observeDetailRequest(entry, options);
    if (!entry.consumers.size) return observed;
    detailRequests.set(cacheKey, entry);
    queuedDetails.push(entry);
    if (queuedDetails.length > DETAIL_QUEUE_LIMIT) {
      const speculative = queuedDetails.find(item => detailPriority(item) === "speculative");
      cancelDetailRequest(speculative || queuedDetails[0], detailCancelled("详情请求已被较新的视频替代"));
    }
    while (detailRequests.size > NAVIGATION_CACHE_LIMIT) {
      const oldest = [...detailRequests].find(([, item]) => item.settled);
      if (!oldest) break;
      detailRequests.delete(oldest[0]);
    }
    pumpDetailRequests();
    return observed;
  }

  function resolvedDetail(videoId, params = getFeedParams()) {
    const id = String(videoId || "").trim();
    if (!id || isDeleted(id)) return null;
    return mergeDetail(resolvedDetails.get(`${params}::${id}`) || null);
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
    entry.disposed = true;
    entry.owners.clear();
    entry.abort.abort();
    player.muted = true;
    player.pause?.();
    player.removeAttribute("src");
    player.load?.();
    player.remove();
  }

  function releasePlaybackPreloads({ force = false } = {}) {
    releaseDetails({ force, speculativeOnly: true });
    for (const [source, entry] of playbackPreloads) {
      if (force) entry.owners.clear();
      else pruneOwners(entry);
      if (entry.owners.size) continue;
      playbackPreloads.delete(source);
      disposePlaybackPreload(entry);
    }
    for (const [url, entry] of mediaPrefetches) {
      if (force) entry.owners.clear();
      else pruneOwners(entry);
      if (entry.owners.size) continue;
      mediaPrefetches.delete(url);
      entry.dispose();
    }
    if (!playbackPreloads.size) { prewarmShelf?.remove(); prewarmShelf = null; }
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
    if (isDeleted(video)) return Promise.resolve(false);
    if (!mayWarm(options)) return Promise.resolve(false);
    if (!video?.id || isGalleryPost(video)) return Promise.resolve(false);
    const source = shortVideoPlaybackUrl(video);
    if (!source) return Promise.resolve(false);
    const cached = playbackPreloads.get(source);
    if (cached) {
      cached.owners.set(options.owner || options.isCurrent || defaultPrewarmOwner, options);
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

    let resolvePrewarm;
    const entry = { player, promise: new Promise(resolve => { resolvePrewarm = resolve; }), taken: false, disposed: false, abort: new AbortController(),
      owners: new Map([[options.owner || options.isCurrent || defaultPrewarmOwner, options]]) };
    playbackPreloads.set(source, entry);
    const work = (async () => {
      const timeout = Math.max(800, Number(options.timeout || PLAYBACK_PRELOAD_TIMEOUT_MS));
      const readyPromise = waitForVideoFirstFrame(player, timeout, { signal: entry.abort.signal });
      player.load?.();
      player.play?.().catch(() => {});
      const ready = await readyPromise;
      if (entry.disposed) return false;
      if (!entry.taken) {
        pruneOwners(entry);
        if (!entry.owners.size) {
          if (playbackPreloads.get(source) === entry) playbackPreloads.delete(source);
          disposePlaybackPreload(entry);
          return false;
        }
        player.pause?.();
        player.muted = true;
        player.preload = "metadata";
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
    work.then(resolvePrewarm);
    trimPlaybackPreloads();
    return entry.promise;
  }

  function takePrewarmedPlayer(video = {}) {
    if (isDeleted(video)) return null;
    const source = shortVideoPlaybackUrl(video);
    const entry = source ? playbackPreloads.get(source) : null;
    if (!entry?.player) return null;
    playbackPreloads.delete(source);
    entry.taken = true;
    entry.owners.clear();
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

  function prefetchFirstMedia(video = {}, options = {}) {
    if (isDeleted(video)) return Promise.resolve(false);
    if (!mayWarm(options)) return Promise.resolve(false);
    const galleryEntry = isGalleryPost(video) ? galleryImageEntries(video)[0] : null;
    const url = String((galleryEntry?.type === "video" ? galleryEntry.posterUrl : galleryEntry?.url)
      || shortVideoCardCoverUrl(video) || "").trim();
    const playbackPromise = isGalleryPost(video) ? Promise.resolve(false) : prewarmPlayback(video, options);
    let imagePromise = Promise.resolve(false);
    if (url) {
      const cached = mediaPrefetches.get(url);
      if (cached) {
        cached.videoIds.add(String(video.id || ""));
        cached.owners.set(options.owner || options.isCurrent || defaultPrewarmOwner, options);
        mediaPrefetches.delete(url);
        mediaPrefetches.set(url, cached);
        imagePromise = cached.promise;
      } else {
        const image = new Image();
        image.decoding = "async";
        image.fetchPriority = "low";
        let resolveImage, settled = false;
        imagePromise = new Promise(resolve => { resolveImage = resolve; });
        const entry = { image, promise: imagePromise, videoIds: new Set([String(video.id || "")]),
          owners: new Map([[options.owner || options.isCurrent || defaultPrewarmOwner, options]]), dispose: null };
        const finish = ready => {
          if (settled) return;
          settled = true;
          image.removeEventListener("load", loaded);
          image.removeEventListener("error", failed);
          resolveImage(Boolean(ready));
        };
        entry.dispose = () => {
          entry.owners.clear();
          finish(false);
          image.removeAttribute("src");
        };
        const loaded = () => {
          if (settled) return;
          pruneOwners(entry);
          if (entry.owners.size) finish(true);
          else {
            if (mediaPrefetches.get(url) === entry) mediaPrefetches.delete(url);
            entry.dispose();
          }
        };
        const failed = () => {
          if (mediaPrefetches.get(url) === entry) mediaPrefetches.delete(url);
          entry.dispose();
        };
        mediaPrefetches.set(url, entry);
        image.addEventListener("load", loaded);
        image.addEventListener("error", failed);
        image.src = url;
        if (image.complete && image.naturalWidth) Promise.resolve().then(loaded);
        while (mediaPrefetches.size > MEDIA_PREFETCH_LIMIT) {
          const [oldUrl, oldEntry] = mediaPrefetches.entries().next().value;
          mediaPrefetches.delete(oldUrl);
          oldEntry.dispose();
        }
      }
    }
    return Promise.all([imagePromise, playbackPromise]).then((results) => results.some(Boolean));
  }

  async function prefetchRelatedVideo(video = {}, options = {}) {
    if (isDeleted(video)) return null;
    if (!mayWarm(options)) return null;
    const videoId = String(video?.id || "").trim();
    if (!videoId) return null;
    const params = getFeedParams();
    const cached = resolvedDetail(videoId, params);
    if (cached?.video) {
      prefetchFirstMedia(cached.video, options).catch(() => {});
      return cached;
    }
    let detail;
    try {
      detail = await fetchDetail(videoId, params, { ...options, owner: options.owner || defaultPrewarmOwner,
        priority: options.priority || "speculative", isCurrent: () => mayWarm(options) });
    } catch (error) {
      if (error?.name === "AbortError") return null;
      throw error;
    }
    // fetchDetail still returns obsolete results to their original callers.
    // Only the result actually published for this key may warm media or write
    // the shared author cache after the await.
    if (detail?.video && resolvedDetail(videoId, params) === detail && mayWarm(options)) {
      cacheAuthorPanelVideo(detail.video);
      await prefetchFirstMedia(detail.video, options).catch(() => false);
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
    forgetVideos,
    isDeleted,
    prefetchFirstMedia,
    prefetchRelatedVideo,
    prewarmPlayback,
    releasePlaybackPreloads,
    releaseDetails,
    rememberVideo,
    resolvedDetail,
    stats,
    takePrewarmedPlayer
  });
}

import { absoluteUrl, loadPreviewImage } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatBytes, formatCompact } from "../../../js/format.js";
import { DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_SOURCE, formatDate, formatDuration, normalizeSort, normalizeSource } from "../shared.js";
export function createShortVideoMediaCache(context = {}) {
  const { api, browserState, els, getActiveUrl, listState } = context;
  const warmedMedia = new Set();
  const firstFrameCache = new Map();
  const applyQueuedReelWindow = (...args) => context.applyQueuedReelWindow(...args);
  const shortVideoApiSource = (...args) => context.shortVideoApiSource(...args);
  function warmAdjacentMedia() {
    for (const video of [browserState.prevVideo, browserState.nextVideo]) {
      if (!video?.streamUrl || warmedMedia.has(video.id)) continue;
      requestVideoFirstFrame(video);
      warmedMedia.add(video.id);
      const url = absoluteUrl(getActiveUrl(), video.streamUrl);
      fetch(url, {
        cache: "force-cache",
        headers: { Range: "bytes=0-524287" }
      }).then((response) => {
        response.body?.cancel?.();
      }).catch(() => {});
    }
    if (warmedMedia.size > 40) {
      const keep = new Set([browserState.video?.id, browserState.prevVideo?.id, browserState.nextVideo?.id].filter(Boolean));
      for (const id of [...warmedMedia]) {
        if (!keep.has(id)) warmedMedia.delete(id);
        if (warmedMedia.size <= 24) break;
      }
    }
  }

  function cachedFirstFrameUrl(video) {
    return firstFrameCache.get(video?.id || "")?.url || "";
  }

  function requestVideoFirstFrame(video) {
    const id = video?.id || "";
    if (!id || !video.streamUrl) return Promise.resolve("");
    const cached = firstFrameCache.get(id);
    if (cached?.url) return Promise.resolve(cached.url);
    if (cached?.promise) return cached.promise;

    const promise = new Promise((resolve) => {
      const probe = document.createElement("video");
      const timeout = window.setTimeout(() => finish(""), 4200);
      let finished = false;

      probe.muted = true;
      probe.defaultMuted = true;
      probe.playsInline = true;
      probe.preload = "auto";
      probe.crossOrigin = "anonymous";
      probe.className = "short-video-mobile-frame-probe";

      const cleanup = () => {
        window.clearTimeout(timeout);
        probe.pause?.();
        probe.removeAttribute("src");
        probe.load?.();
        probe.remove();
      };
      const finish = (url) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (url) {
          firstFrameCache.set(id, { status: "ready", url });
          updateVisibleFirstFrame(id, url);
          pruneFirstFrameCache();
        } else {
          firstFrameCache.set(id, { status: "failed" });
        }
        resolve(url);
      };
      const capture = () => {
        if (finished || !probe.videoWidth || !probe.videoHeight) return;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = probe.videoWidth;
          canvas.height = probe.videoHeight;
          canvas.getContext("2d")?.drawImage(probe, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            finish(blob ? URL.createObjectURL(blob) : "");
          }, "image/jpeg", 0.82);
        } catch {
          finish("");
        }
      };
      const seekToFirstFrame = () => {
        if (finished) return;
        if (probe.readyState >= 2) {
          capture();
          return;
        }
        try {
          const target = probe.duration && Number.isFinite(probe.duration) ? Math.min(0.08, Math.max(0, probe.duration / 20)) : 0.04;
          probe.currentTime = target;
        } catch {}
      };

      probe.addEventListener("loadeddata", capture, { once: true });
      probe.addEventListener("seeked", capture, { once: true });
      probe.addEventListener("loadedmetadata", seekToFirstFrame, { once: true });
      probe.addEventListener("error", () => finish(""), { once: true });
      document.body.append(probe);
      probe.src = absoluteUrl(getActiveUrl(), video.streamUrl);
      probe.load();
    });

    firstFrameCache.set(id, { status: "loading", promise });
    return promise;
  }

  function updateVisibleFirstFrame(id, url) {
    if (!id || !url) return;
    for (const node of document.querySelectorAll?.(`[data-short-video-frame-id="${cssEscape(id)}"]`) || []) {
      if (node.tagName === "IMG") {
        node.src = url;
      } else {
        const img = document.createElement("img");
        img.className = node.className;
        img.alt = "";
        img.src = url;
        img.dataset.shortVideoFrameId = id;
        node.replaceWith(img);
      }
    }
  }

  function pruneFirstFrameCache() {
    if (firstFrameCache.size <= 24) return;
    const keep = new Set([browserState.video?.id, browserState.prevVideo?.id, browserState.nextVideo?.id].filter(Boolean));
    for (const [id, item] of firstFrameCache) {
      if (keep.has(id) || item.status === "loading") continue;
      if (item.url) URL.revokeObjectURL(item.url);
      firstFrameCache.delete(id);
      if (firstFrameCache.size <= 18) break;
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  async function appendListSilently() {
    if (listState.loadingMore || !listState.data?.hasMore) return;
    listState.loadingMore = true;
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (listState.author && listState.author !== "all") params.set("author", listState.author);
    params.set("source", shortVideoApiSource());
    params.set("sort", listState.sort || DEFAULT_SORT);
    params.set("limit", String(DEFAULT_LIMIT));
    params.set("offset", String(listState.data?.videos?.length || 0));
    const data = await api.fetch(getActiveUrl(), `/api/short-videos?${params}`, { timeoutMs: 16000 });
    const seen = new Set((listState.data.videos || []).map((video) => video.id));
    const merged = [...(listState.data.videos || [])];
    for (const video of data.videos || []) {
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      merged.push(video);
    }
    listState.data = { ...data, videos: merged, offset: 0, limit: merged.length };
    listState.loadingMore = false;
    if (browserState.video?.id) applyQueuedReelWindow(browserState.video.id, { keepExisting: true });
  }

  function replaceCurrentShortVideoHistory(id) {
    if (!window.history?.replaceState) return;
    const nextParams = shortVideoBrowserParams(id);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(nextParams)) {
      if (value !== undefined && value !== null && String(value).length) params.set(key, String(value));
    }
    const state = window.history.state && typeof window.history.state === "object"
      ? { ...window.history.state, view: "shortVideoBrowser", params: nextParams }
      : window.history.state;
    window.history.replaceState(state, "", `#shortVideoBrowser?${params.toString()}`);
  }

  function shortVideoBrowserParams(id) {
    return {
      id: String(id || ""),
      ...(listState.query ? { query: listState.query } : {}),
      ...(listState.author && listState.author !== "all" ? { author: listState.author } : {}),
      ...(normalizeSource(listState.source) !== DEFAULT_SOURCE ? { source: normalizeSource(listState.source) } : {}),
      ...(normalizeSort(listState.sort) !== DEFAULT_SORT ? { sort: normalizeSort(listState.sort) } : {})
    };
  }

  return {
    warmAdjacentMedia,
    cachedFirstFrameUrl,
    requestVideoFirstFrame,
    updateVisibleFirstFrame,
    pruneFirstFrameCache,
    cssEscape,
    appendListSilently,
    replaceCurrentShortVideoHistory,
    shortVideoBrowserParams
  };
}

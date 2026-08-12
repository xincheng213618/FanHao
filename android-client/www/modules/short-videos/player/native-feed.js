import { DEFAULT_SORT } from "../shared.js";
import { clearCachedJsonByPrefix } from "../../../js/cache.js?v=20260711-short-video-cache-08";
import { stringifyNativeShortVideoFeed } from "./native-feed-contract.js";

export function createShortVideoNativeFeed(context = {}) {
  const { getActiveUrl, listState } = context;
  const invalidateShortVideoCache = context.invalidateShortVideoCache || clearCachedJsonByPrefix;
  const shortVideoApiSource = (...args) => context.shortVideoApiSource(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);
  async function openNativeShortVideoFeed(video, options = {}) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.playShortFeed || !video?.id) return false;
    if (!isNativePlayableItem(video)) {
      shortVideoToast("这条作品缺少本地媒体，暂时无法打开");
      return true;
    }
    const videos = Array.isArray(options.videos) ? options.videos : (listState.data?.videos || []);
    const playableEntries = videos
      .map((item, apiIndex) => ({ item, apiIndex }))
      .filter(({ item }) => isNativePlayableItem(item));
    const index = playableEntries.findIndex(({ item }) => item === video || item.id === video.id);
    if (index < 0) return false;
    const boundary = nextCollectionCursorBoundary(videos, playableEntries, index, options.cursorBoundaries);
    const end = boundary?.playableEnd ?? Math.min(playableEntries.length, index + 31);
    const start = Math.max(0, index - 20);
    const feedEntries = playableEntries.slice(start, end);
    const feedUrl = nativeShortVideoFeedUrl(options);
    const payload = stringifyNativeShortVideoFeed(feedEntries.map(({ item }) => item));
    const cursorAtEnd = boundary?.nextCursor || "";
    const hasMoreAtEnd = boundary
      ? boundary.hasMore || end < playableEntries.length
      : Boolean((options.hasMore ?? listState.data?.hasMore) || end < playableEntries.length);
    const launchServerBase = normalizeServerBase(getActiveUrl());
    try {
      const result = await plugin.playShortFeed({
        baseUrl: launchServerBase,
        feedUrl,
        hasMore: hasMoreAtEnd,
        nextOffset: feedEntries.length ? feedEntries[feedEntries.length - 1].apiIndex + 1 : videos.length,
        nextCursor: cursorAtEnd,
        startIndex: index - start,
        startId: video.id,
        openAuthorPanel: Boolean(options.openAuthorPanel),
        videos: payload
      });
      const resultServerBase = normalizeServerBase(result?.serverBase);
      const snapshots = normalizeActionSnapshots(result?.snapshots);
      if (launchServerBase && resultServerBase === launchServerBase && snapshots.length) {
        if (normalizeServerBase(getActiveUrl()) === launchServerBase) {
          mergeActionSnapshots(listState.data?.videos, snapshots);
          mergeActionSnapshots(options.videos, snapshots);
        }
        await invalidateShortVideoCache(launchServerBase, "/api/short-videos").catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  function nextCollectionCursorBoundary(videos, playableEntries, selectedIndex, boundaries) {
    if (!Array.isArray(boundaries) || !boundaries.length) return null;
    const selectedApiIndex = playableEntries[selectedIndex]?.apiIndex;
    if (!Number.isInteger(selectedApiIndex)) return null;
    return boundaries
      .map((boundary) => {
        const endVideoId = String(boundary?.endVideoId || "").trim();
        const apiEnd = videos.findIndex((item) => String(item?.id || "") === endVideoId);
        if (apiEnd < selectedApiIndex) return null;
        const playableEnd = playableEntries.filter(({ apiIndex }) => apiIndex <= apiEnd).length;
        if (playableEnd <= selectedIndex) return null;
        const windowStart = Math.max(0, selectedIndex - 20);
        if (playableEnd - selectedIndex > 31 || playableEnd - windowStart > 51) return null;
        const nextCursor = String(boundary?.nextCursor || "").trim();
        if (!nextCursor) return null;
        return {
          apiEnd,
          playableEnd,
          hasMore: Boolean(boundary?.hasMore),
          nextCursor
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.apiEnd - right.apiEnd)[0] || null;
  }

  function isNativePlayableItem(item) {
    if (String(item?.streamUrl || "").trim()) return true;
    if (String(item?.mediaType || "").toLowerCase() !== "gallery") return false;
    const entries = Array.isArray(item?.galleryItems) && item.galleryItems.length
      ? item.galleryItems
      : item.galleryImages;
    return Array.isArray(entries) && entries.some((entry) => String(entry?.url || "").trim());
  }

  function nativeShortVideoStreamUrl(item = {}) {
    return String(item.mobileStreamUrl || item.streamUrl || "").trim();
  }

  function nativeShortVideoFeedUrl(options = {}) {
    if (options.feedUrl) return new URL(options.feedUrl, getActiveUrl()).toString();
    const url = new URL("/api/short-videos", getActiveUrl());
    const query = options.query ?? listState.query;
    const author = options.author ?? listState.author;
    const source = options.source ?? shortVideoApiSource();
    const sort = options.sort ?? listState.sort;
    if (query) url.searchParams.set("q", query);
    if (author && author !== "all") url.searchParams.set("author", author);
    url.searchParams.set("source", source || "all");
    url.searchParams.set("sort", sort || DEFAULT_SORT);
    url.searchParams.set("facets", "0");
    return url.toString();
  }

  function nativePlayerPlugin() {
    return window.Capacitor?.Plugins?.FanHaoPlayer || null;
  }
  return {
    openNativeShortVideoFeed,
    nativeShortVideoFeedUrl,
    nativeShortVideoStreamUrl
  };
}

function normalizeActionSnapshots(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const videoId = String(entry?.videoId || "").trim();
    if (!videoId) return null;
    const snapshot = { videoId };
    if (typeof entry.liked === "boolean") snapshot.liked = entry.liked;
    if (typeof entry.collected === "boolean") snapshot.collected = entry.collected;
    if (Object.hasOwn(entry, "likes") && Number.isFinite(Number(entry.likes))) snapshot.likes = Math.max(0, Number(entry.likes));
    if (Object.hasOwn(entry, "collects") && Number.isFinite(Number(entry.collects))) snapshot.collects = Math.max(0, Number(entry.collects));
    return Object.keys(snapshot).length > 1 ? snapshot : null;
  }).filter(Boolean);
}

function mergeActionSnapshots(videos, snapshots) {
  if (!Array.isArray(videos)) return;
  const byId = new Map(snapshots.map((snapshot) => [snapshot.videoId, snapshot]));
  for (const video of videos) {
    const snapshot = byId.get(String(video?.id || "").trim());
    if (!snapshot || !video) continue;
    if ("liked" in snapshot || "collected" in snapshot) video.actions ||= {};
    if ("liked" in snapshot) video.actions.liked = snapshot.liked;
    if ("collected" in snapshot) video.actions.collected = snapshot.collected;
    if ("likes" in snapshot || "collects" in snapshot) video.stats ||= {};
    if ("likes" in snapshot) video.stats.likes = snapshot.likes;
    if ("collects" in snapshot) video.stats.collects = snapshot.collects;
  }
}

function normalizeServerBase(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

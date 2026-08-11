import { DEFAULT_SORT } from "../shared.js";
import { stringifyNativeShortVideoFeed } from "./native-feed-contract.js";

export function createShortVideoNativeFeed(context = {}) {
  const { getActiveUrl, listState } = context;
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
    const start = Math.max(0, index - 20);
    const end = Math.min(playableEntries.length, index + 31);
    const feedEntries = playableEntries.slice(start, end);
    const feedUrl = nativeShortVideoFeedUrl(options);
    const payload = stringifyNativeShortVideoFeed(feedEntries.map(({ item }) => item));
    try {
      await plugin.playShortFeed({
        baseUrl: getActiveUrl(),
        feedUrl,
        hasMore: Boolean((options.hasMore ?? listState.data?.hasMore) || end < playableEntries.length),
        nextOffset: feedEntries.length ? feedEntries[feedEntries.length - 1].apiIndex + 1 : videos.length,
        startIndex: index - start,
        startId: video.id,
        openAuthorPanel: Boolean(options.openAuthorPanel),
        videos: payload
      });
      return true;
    } catch {
      return false;
    }
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

import { DEFAULT_SORT } from "../shared.js";

export function createShortVideoNativeFeed(context = {}) {
  const { getActiveUrl, listState } = context;
  const nativePlayerPlugin = (...args) => context.nativePlayerPlugin(...args);
  const shortVideoApiSource = (...args) => context.shortVideoApiSource(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);
  async function openNativeShortVideoFeed(video) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.playShortFeed || !video?.id) return false;
    if (!isNativePlayableItem(video)) {
      shortVideoToast("这条作品缺少本地媒体，暂时无法打开");
      return true;
    }
    const videos = listState.data?.videos || [];
    const playableEntries = videos
      .map((item, apiIndex) => ({ item, apiIndex }))
      .filter(({ item }) => isNativePlayableItem(item));
    const index = playableEntries.findIndex(({ item }) => item === video || item.id === video.id);
    if (index < 0) return false;
    const start = Math.max(0, index - 20);
    const end = Math.min(playableEntries.length, index + 31);
    const feedEntries = playableEntries.slice(start, end);
    const feedUrl = nativeShortVideoFeedUrl();
    const payload = feedEntries.map(({ item }) => ({
      id: item.id,
      awemeId: item.awemeId || "",
      title: item.title || "",
      mediaType: item.mediaType || "video",
      streamUrl: item.streamUrl || "",
      coverUrl: item.coverUrl || "",
      galleryCount: Number(item.galleryCount || item.galleryImages?.length || 0),
      galleryItems: Array.isArray(item.galleryItems)
        ? item.galleryItems.map((entry, galleryIndex) => ({
            index: Number(entry?.index ?? galleryIndex),
            type: entry?.type === "video" ? "video" : "image",
            url: entry?.url || ""
          })).filter((entry) => entry.url)
        : [],
      galleryImages: Array.isArray(item.galleryImages)
        ? item.galleryImages.map((entry, galleryIndex) => ({
            index: Number(entry?.index ?? galleryIndex),
            url: entry?.url || ""
          })).filter((entry) => entry.url)
        : [],
      sound: item.sound ? {
        key: item.sound.key || "",
        id: item.sound.id || "",
        title: item.sound.title || "",
        author: item.sound.author || "",
        coverUrl: item.sound.coverUrl || "",
        previewUrl: item.sound.previewUrl || "",
        previewSource: item.sound.previewSource || "",
        localAvailable: Boolean(item.sound.localAvailable),
        original: Boolean(item.sound.original)
      } : null,
      shareUrl: item.shareUrl || "",
      originalUrl: item.originalUrl || "",
      author: {
        name: item.author?.name || "",
        secUid: item.author?.secUid || "",
        uid: item.author?.uid || "",
        avatarUrl: item.author?.avatarUrl || "",
        profileUrl: item.author?.profileUrl || "",
        uniqueId: item.author?.uniqueId || "",
        shortId: item.author?.shortId || "",
        signature: item.author?.signature || "",
        ipLocation: item.author?.ipLocation || "",
        followerCount: Number(item.author?.followerCount || 0),
        followingCount: Number(item.author?.followingCount || 0),
        totalFavorited: Number(item.author?.totalFavorited || 0),
        awemeCount: Number(item.author?.awemeCount || 0),
        favoritingCount: Number(item.author?.favoritingCount || 0),
        gender: Number(item.author?.gender || 0),
        age: Number(item.author?.age || 0),
        verification: item.author?.verification || "",
        profileCollectedAt: item.author?.profileCollectedAt || ""
      },
      publishedAt: item.publishedAt || "",
      durationMs: Number(item.durationMs || 0),
      size: Number(item.size || 0),
      stats: {
        likes: Number(item.stats?.likes || 0),
        comments: Number(item.stats?.comments || 0),
        collects: Number(item.stats?.collects || 0),
        shares: Number(item.stats?.shares || 0),
        plays: Number(item.stats?.plays || 0)
      }
    }));
    try {
      await plugin.playShortFeed({
        baseUrl: getActiveUrl(),
        feedUrl,
        hasMore: Boolean(listState.data?.hasMore || end < playableEntries.length),
        nextOffset: feedEntries.length ? feedEntries[feedEntries.length - 1].apiIndex + 1 : videos.length,
        startIndex: index - start,
        startId: video.id,
        videos: JSON.stringify(payload)
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

  function nativeShortVideoFeedUrl() {
    const url = new URL("/api/short-videos", getActiveUrl());
    if (listState.query) url.searchParams.set("q", listState.query);
    if (listState.author && listState.author !== "all") url.searchParams.set("author", listState.author);
    url.searchParams.set("source", shortVideoApiSource());
    url.searchParams.set("sort", listState.sort || DEFAULT_SORT);
    url.searchParams.set("facets", "0");
    return url.toString();
  }


  return {
    openNativeShortVideoFeed,
    nativeShortVideoFeedUrl
  };
}

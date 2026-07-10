import { DEFAULT_SORT } from "../shared.js";

export function createShortVideoNativeFeed(context = {}) {
  const { getActiveUrl, listState } = context;
  const nativePlayerPlugin = (...args) => context.nativePlayerPlugin(...args);
  const shortVideoApiSource = (...args) => context.shortVideoApiSource(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);
  async function openNativeShortVideoFeed(video) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.playShortFeed || !video?.id) return false;
    if (!String(video.streamUrl || "").trim()) {
      shortVideoToast("这条视频缺少本地文件，暂时无法播放");
      return true;
    }
    const videos = listState.data?.videos || [];
    const playableEntries = videos
      .map((item, apiIndex) => ({ item, apiIndex }))
      .filter(({ item }) => String(item?.streamUrl || "").trim());
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
      streamUrl: item.streamUrl || "",
      coverUrl: item.coverUrl || "",
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

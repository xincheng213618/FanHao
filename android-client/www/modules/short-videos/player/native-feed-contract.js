export const NATIVE_SHORT_VIDEO_FEED_SCHEMA_VERSION = 1;

export function serializeShortVideoForNative(item = {}) {
  const actualVideo = item.actualVideo && typeof item.actualVideo === "object"
    ? {
        width: finiteNumber(item.actualVideo.width),
        height: finiteNumber(item.actualVideo.height),
        longEdge: finiteNumber(item.actualVideo.longEdge),
        codec: cleanString(item.actualVideo.codec)
      }
    : null;
  return {
    id: cleanString(item.id),
    awemeId: cleanString(item.awemeId),
    title: cleanString(item.title),
    mediaType: cleanString(item.mediaType) || "video",
    galleryPresentation: cleanString(item.galleryPresentation),
    streamUrl: cleanString(item.mobileStreamUrl || item.streamUrl),
    coverUrl: cleanString(item.coverUrl),
    width: finiteNumber(actualVideo?.width || item.width),
    height: finiteNumber(actualVideo?.height || item.height),
    actualVideo,
    galleryCount: finiteNumber(item.galleryCount || item.galleryImages?.length),
    galleryItems: serializeGalleryEntries(item.galleryItems, true),
    galleryImages: serializeGalleryEntries(item.galleryImages, false),
    sound: item.sound ? {
      key: cleanString(item.sound.key),
      id: cleanString(item.sound.id),
      title: cleanString(item.sound.title),
      author: cleanString(item.sound.author),
      coverUrl: cleanString(item.sound.coverUrl),
      previewUrl: cleanString(item.sound.previewUrl),
      previewSource: cleanString(item.sound.previewSource),
      localAvailable: Boolean(item.sound.localAvailable),
      original: Boolean(item.sound.original)
    } : null,
    shareUrl: cleanString(item.shareUrl),
    originalUrl: cleanString(item.originalUrl),
    author: {
      id: cleanString(item.author?.id || item.ownerUserId),
      name: cleanString(item.author?.name),
      secUid: cleanString(item.author?.secUid),
      uid: cleanString(item.author?.uid),
      avatarUrl: cleanString(item.author?.avatarUrl),
      profileUrl: cleanString(item.author?.profileUrl),
      uniqueId: cleanString(item.author?.uniqueId),
      shortId: cleanString(item.author?.shortId),
      signature: cleanString(item.author?.signature),
      ipLocation: cleanString(item.author?.ipLocation),
      followerCount: finiteNumber(item.author?.followerCount),
      followingCount: finiteNumber(item.author?.followingCount),
      totalFavorited: finiteNumber(item.author?.totalFavorited),
      awemeCount: finiteNumber(item.author?.awemeCount),
      favoritingCount: finiteNumber(item.author?.favoritingCount),
      gender: finiteNumber(item.author?.gender),
      age: finiteNumber(item.author?.age),
      verification: cleanString(item.author?.verification),
      profileCollectedAt: cleanString(item.author?.profileCollectedAt),
      following: Boolean(item.author?.following)
    },
    publishedAt: cleanString(item.publishedAt),
    durationMs: finiteNumber(item.durationMs),
    size: finiteNumber(item.size),
    stats: {
      likes: finiteNumber(item.stats?.likes),
      comments: finiteNumber(item.stats?.comments),
      collects: finiteNumber(item.stats?.collects),
      shares: finiteNumber(item.stats?.shares),
      plays: finiteNumber(item.stats?.plays)
    },
    libraryLiked: Boolean(item.libraryLiked),
    actions: {
      liked: Boolean(item.actions?.liked),
      collected: Boolean(item.actions?.collected)
    }
  };
}

export function createNativeShortVideoFeedPayload(items = []) {
  return {
    schemaVersion: NATIVE_SHORT_VIDEO_FEED_SCHEMA_VERSION,
    videos: (Array.isArray(items) ? items : [])
      .map(serializeShortVideoForNative)
      .filter((item) => item.id)
  };
}

export function stringifyNativeShortVideoFeed(items = []) {
  return JSON.stringify(createNativeShortVideoFeedPayload(items));
}

function serializeGalleryEntries(entries, includeType) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => ({
    index: finiteNumber(entry?.index ?? index),
    ...(includeType ? { type: entry?.type === "video" ? "video" : "image" } : {}),
    ...(includeType ? { posterUrl: cleanString(entry?.posterUrl) } : {}),
    url: cleanString(entry?.url)
  })).filter((entry) => entry.url);
}

function finiteNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function cleanString(value) {
  return String(value || "").trim();
}

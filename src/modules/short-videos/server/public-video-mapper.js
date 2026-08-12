import path from "node:path";

import { douyinNoteUrl, douyinUserUrl, douyinVideoUrl } from "./import-item-mapper.js";
import { encodeShortVideoSoundKey } from "./query-contract.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const IMPORTED_SHORT_VIDEO_ACTION_SOURCES = new Set(["imported", "download_manager"]);

export function createShortVideoPublicVideoMapper(dependencies = {}) {
  const {
    clampInt,
    optionalInteger,
    parseJsonArray,
    parseJsonObject
  } = dependencies;
  if (![clampInt, optionalInteger, parseJsonArray, parseJsonObject].every((dependency) => typeof dependency === "function")) {
    throw new TypeError("short-video public mapper dependencies must be functions");
  }

  function publicVideo(row, options = {}) {
    const id = row.id || row.aweme_id || "";
    const metadata = parseJsonObject(row.metadata_json);
    const media = publicVideoMedia(row, metadata);
    const livePhotoItems = livePhotoGalleryItems(metadata, media);
    const sourceItems = livePhotoItems || media.galleryItems.map((type, sourceIndex) => ({ sourceIndex, type }));
    const galleryItems = sourceItems.map((item, index) => ({
      ...item,
      index,
      url: `/media/short-video-gallery/${encodeURIComponent(id)}/${item.sourceIndex}`,
      ...(Number.isInteger(item.posterIndex)
        ? { posterUrl: `/media/short-video-gallery/${encodeURIComponent(id)}/${item.posterIndex}` }
        : {})
    }));
    const userActions = {
      liked: Boolean(row.user_like_active),
      collected: Boolean(row.user_collect_active),
      disliked: Boolean(row.user_dislike_active)
    };
    const likeDelta = shortVideoActionMetricDelta(row.user_like_active, row.user_like_source, row.library_liked);
    const collectDelta = shortVideoActionMetricDelta(row.user_collect_active, row.user_collect_source);
    const statisticsKnown = shortVideoStatisticsKnown(row);
    const watchProgressMs = Math.max(0, Number(row.watch_progress_ms || 0));
    const watchCompletedCount = Math.max(0, Number(row.watch_completed_count || 0));
    const rawShareUrl = String(row.share_url || "").trim();
    const shareUrl = rawShareUrl || (media.type === "gallery"
      ? douyinNoteUrl(row.aweme_id || id)
      : douyinVideoUrl(row.aweme_id || id));
    const originalUrl = shareUrl || (media.type === "gallery"
      ? douyinNoteUrl(row.aweme_id || id)
      : douyinVideoUrl(row.aweme_id || id));
    const remoteCoverUrl = typeof metadata.cover_url === "string" && /^https?:\/\//i.test(metadata.cover_url)
      ? metadata.cover_url
      : (typeof metadata.coverUrl === "string" && /^https?:\/\//i.test(metadata.coverUrl) ? metadata.coverUrl : "");
    return {
      id,
      awemeId: row.aweme_id || "",
      ownerUserId: row.owner_user_id || "",
      origin: row.origin || "",
      status: row.status || "normal",
      visibility: row.visibility || "local_only",
      libraryLiked: Boolean(row.library_liked),
      deletedFromAuthor: Boolean(row.author_deleted),
      mediaType: media.type,
      galleryPresentation: livePhotoItems ? "live-photo" : (media.type === "gallery" ? "carousel" : ""),
      galleryCount: galleryItems.length,
      galleryItems,
      galleryImages: galleryItems
        .filter((item) => item.type === "image")
        .map((item) => ({ index: item.index, url: item.url })),
      title: row.title || row.description || row.file_name || "",
      description: row.description || "",
      tags: parseJsonArray(row.tags_json),
      author: {
        id: row.owner_user_id || "",
        secUid: row.author_sec_uid || "",
        uid: row.author_uid || "",
        name: row.author_name || "未知作者",
        avatarUrl: row.author_avatar_url || "",
        profileUrl: row.author_profile_url || douyinUserUrl(row.author_sec_uid),
        uniqueId: row.author_unique_id || "",
        shortId: row.author_short_id || "",
        signature: row.author_signature || "",
        ipLocation: row.author_ip_location || "",
        followerCount: optionalInteger(row.author_follower_count),
        followingCount: optionalInteger(row.author_following_count),
        totalFavorited: optionalInteger(row.author_total_favorited),
        awemeCount: optionalInteger(row.author_aweme_count),
        favoritingCount: optionalInteger(row.author_favoriting_count),
        gender: optionalInteger(row.author_gender),
        age: optionalInteger(row.author_age),
        verification: row.author_verification || "",
        profileCollectedAt: row.author_profile_collected_at || "",
        following: Boolean(row.author_following)
      },
      publishedAt: row.published_at || "",
      likedAt: row.liked_at || "",
      durationMs: Number(row.duration_ms || 0) || null,
      width: Number(row.width || 0) || null,
      height: Number(row.height || 0) || null,
      actualVideo: {
        width: Number(row.actual_width || 0) || null,
        height: Number(row.actual_height || 0) || null,
        bitRate: Number(row.actual_bit_rate || 0) || null,
        codec: row.actual_codec || "",
        frameRate: Number(row.actual_frame_rate || 0) || null,
        pixels: Number(row.actual_pixels || 0),
        longEdge: Number(row.actual_long_edge || 0),
        probedAt: row.actual_probed_at || "",
        probeError: row.actual_probe_error || ""
      },
      stats: {
        known: statisticsKnown,
        likes: Math.max(0, Number(row.digg_count || 0) + likeDelta),
        comments: Number(row.comment_count || 0),
        collects: Math.max(0, Number(row.collect_count || 0) + collectDelta),
        shares: Number(row.share_count || 0),
        plays: Number(row.play_count || 0)
      },
      actions: userActions,
      watch: {
        progressMs: watchProgressMs,
        completedCount: watchCompletedCount,
        completed: watchCompletedCount > 0,
        lastWatchedAt: row.last_watched_at || ""
      },
      recommendation: publicShortVideoRecommendation(row),
      sound: publicShortVideoSound(row, id),
      shareUrl,
      originalUrl,
      streamUrl: media.type === "video" ? shortVideoMediaUrl(id, row.mtime_ms) : "",
      coverUrl: shortVideoCoverUrl(row, id) || remoteCoverUrl,
      coverSource: row.cover_source || "",
      fileName: row.file_name || "",
      relativePath: row.relative_path || "",
      size: Number(row.size_bytes || 0),
      ...(options.detail ? {
        sourcePath: row.source_path || "",
        dataPath: row.data_path || "",
        musicPath: row.music_path || "",
        ...(options.includeMetadata === false ? {} : { metadata })
      } : {})
    };
  }

  function publicVideoMedia(row, metadata = {}) {
    const fanhaoMedia = metadata?.fanhaoMedia && typeof metadata.fanhaoMedia === "object"
      ? metadata.fanhaoMedia
      : {};
    const declaredType = String(fanhaoMedia.type || "").trim().toLowerCase();
    const storedType = String(row.media_type || "").trim().toLowerCase();
    const galleryCount = clampInt(fanhaoMedia.galleryCount, 0, 0, 1000);
    const declaredGalleryItems = Array.isArray(fanhaoMedia.galleryItems)
      ? fanhaoMedia.galleryItems.slice(0, galleryCount).map((item) => item === "video" ? "video" : "image")
      : [];
    const sourceExt = path.extname(String(row.source_path || "")).toLowerCase();
    const inferredGallery = IMAGE_EXTS.has(sourceExt) && galleryCount > 0;
    const type = storedType === "gallery"
      ? "gallery"
      : storedType === "video"
        ? "video"
        : declaredType === "gallery" || inferredGallery ? "gallery" : "video";
    return {
      type,
      galleryCount: type === "gallery" ? galleryCount : 0,
      galleryItems: type === "gallery"
        ? Array.from({ length: galleryCount }, (_, index) => declaredGalleryItems[index] || "image")
        : []
    };
  }

  function livePhotoGalleryItems(metadata = {}, media = {}) {
    const images = Array.isArray(metadata.images) ? metadata.images : [];
    if (media.type !== "gallery" || !images.length) return null;
    const items = [];
    let sourceIndex = 0;
    let liveCount = 0;
    for (const image of images) {
      if (!image || typeof image !== "object" || media.galleryItems[sourceIndex] !== "image") return null;
      const imageIndex = sourceIndex++;
      const nestedVideo = image.video && typeof image.video === "object";
      const livePhoto = Number(image.live_photo_type || 0) > 0 && nestedVideo;
      if (!livePhoto) {
        items.push({ sourceIndex: imageIndex, type: "image" });
        continue;
      }
      if (media.galleryItems[sourceIndex] !== "video") return null;
      items.push({ sourceIndex: sourceIndex++, posterIndex: imageIndex, type: "video" });
      liveCount += 1;
    }
    return liveCount > 0 && sourceIndex === media.galleryItems.length ? items : null;
  }

  function publicShortVideoSound(row = {}, id = "") {
    const rawKey = String(row.sound_key || "");
    if (!rawKey) return null;
    const localAvailable = Boolean(row.sound_local_available && row.music_path);
    const remotePreview = /^https?:\/\//i.test(String(row.sound_preview_url || "")) ? String(row.sound_preview_url) : "";
    const title = String(row.sound_title || "").trim() || (localAvailable ? "本地提取音频" : "作品原声");
    const author = String(row.sound_author || row.author_name || "").trim() || "未知作者";
    const remoteCover = /^https?:\/\//i.test(String(row.sound_cover_url || "")) ? String(row.sound_cover_url) : "";
    return {
      key: encodeShortVideoSoundKey(rawKey),
      id: String(row.sound_id || ""),
      title,
      author,
      coverUrl: remoteCover || row.author_avatar_url || shortVideoCoverUrl(row, id),
      previewUrl: localAvailable ? `/media/short-video-music/${encodeURIComponent(id)}` : remotePreview,
      previewSource: localAvailable ? "local" : (remotePreview ? "remote" : ""),
      localAvailable,
      original: /创作的原声/.test(title)
    };
  }

  return Object.freeze({ publicVideo, publicVideoMedia });
}

export function shortVideoStatisticsKnown(row) {
  return ["digg_count", "comment_count", "collect_count", "share_count"]
    .some((column) => Number(row?.[column] || 0) > 0);
}

export function shortVideoMediaVersion(value) {
  const version = Math.max(0, Math.floor(Number(value || 0)));
  return version ? String(version) : "";
}

export function shortVideoMediaUrl(id, mtimeMs) {
  const base = `/media/short-video/${encodeURIComponent(id)}`;
  const version = shortVideoMediaVersion(mtimeMs);
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

function shortVideoActionMetricDelta(active, source, libraryActive = false) {
  const baselineActive = Boolean(libraryActive)
    || IMPORTED_SHORT_VIDEO_ACTION_SOURCES.has(String(source || "").trim());
  return Number(Boolean(active)) - Number(baselineActive);
}

function shortVideoCoverUrl(row = {}, id = "") {
  const source = String(row.cover_source || "").trim();
  if (!row.cover_path && source !== "ffmpeg_sqlite") return "";
  const version = `${row.mtime_ms || ""}-${source || "file"}`;
  return `/media/short-video-cover/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`;
}

function publicShortVideoRecommendation(row = {}) {
  const engagement = Math.max(0,
    Number(row.digg_count || 0)
    + Number(row.comment_count || 0) * 6
    + Number(row.collect_count || 0) * 4
    + Number(row.share_count || 0) * 3
  );
  const reason = Boolean(row.author_following)
    ? "关注作者"
    : engagement >= 1000000
      ? "百万热度"
      : engagement >= 100000
        ? "本地高赞"
        : engagement >= 10000
          ? "近期热门"
          : "发现新内容";
  return {
    score: Math.max(0, Number(row.recommendation_score || 0)),
    reason
  };
}

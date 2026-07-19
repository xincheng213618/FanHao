export function videoFilter(params = new URLSearchParams()) {
  const q = String(params.get("q") || params.get("search") || "").trim();
  const topic = normalizeTopicFilter(params.get("topic") || params.get("tag"));
  const sound = normalizeSoundFilter(params.get("sound") || params.get("music"));
  const soundKey = decodeShortVideoSoundKey(sound);
  const author = String(params.get("author") || "").trim();
  const source = normalizeSourceFilter(params.get("source") || params.get("origin"));
  const media = normalizeMediaFilter(params.get("media") || params.get("type"));
  const quality = normalizeVideoQualityFilter(params.get("quality") || params.get("resolution"));
  const deleted = normalizeDeletedFromAuthorFilter(params.get("deleted") || params.get("authorDeleted"));
  const whereParts = [];
  const args = [];
  const includePending = includePendingShortVideos(params);
  if (!includePending) {
    whereParts.push("visibility = 'local_only'");
  }
  if (q) {
    const ftsQuery = shortVideoFtsMatchQuery(q);
    if (ftsQuery) {
      whereParts.push(`id IN (
        SELECT video_id FROM short_video_search WHERE short_video_search MATCH ?
      )`);
      args.push(ftsQuery);
    } else {
      const like = `%${escapeLike(q)}%`;
      whereParts.push(`(
        title LIKE ? ESCAPE '\\' OR
        description LIKE ? ESCAPE '\\' OR
        author_name LIKE ? ESCAPE '\\' OR
        aweme_id LIKE ? ESCAPE '\\' OR
        tags_text LIKE ? ESCAPE '\\'
      )`);
      args.push(like, like, like, like, like);
    }
  }
  if (topic) {
    whereParts.push("id IN (SELECT video_id FROM short_video_topics WHERE topic_key = LOWER(?))");
    args.push(topic);
  }
  if (soundKey) {
    whereParts.push("id IN (SELECT video_id FROM short_video_sounds WHERE sound_key = ?)");
    args.push(soundKey);
  }
  if (author && author !== "all") {
    if (author.startsWith("name:")) {
      whereParts.push("author_name = ?");
      args.push(author.slice(5));
    } else {
      whereParts.push("author_sec_uid = ?");
      args.push(author);
    }
  }
  if (media !== "all") {
    whereParts.push(shortVideoMediaWhere(media));
  }
  const qualityWhere = actualVideoQualityWhere(quality);
  if (qualityWhere) {
    if (quality === "unknown") whereParts.push(shortVideoMediaWhere("video"));
    whereParts.push(qualityWhere);
  }
  if (deleted === "deleted") {
    whereParts.push("author_deleted = 1");
  }
  if (source === "recommended") {
    whereParts.push("user_dislike_active = 0");
  } else if (source === "liked") {
    whereParts.push("is_liked = 1");
  } else if (source === "following") {
    whereParts.push("author_following = 1");
  } else if (source === "history") {
    whereParts.push("last_watched_at <> ''");
  } else if (source === "posts") {
    whereParts.push(`id IN (
      SELECT v2.id
      FROM short_videos v2
      JOIN short_video_source_memberships membership ON membership.aweme_id = v2.aweme_id
      WHERE membership.source_type = 'post'
    )`);
  } else if (source === "local") {
    whereParts.push(`id NOT IN (
      SELECT v2.id
      FROM short_videos v2
      JOIN short_video_source_memberships membership ON membership.aweme_id = v2.aweme_id
    )`);
  }
  return { q, topic, sound, soundKey, author, media, quality, deleted, source, includePending, where: whereParts.join(" AND "), args };
}

export function normalizeDeletedFromAuthorFilter(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return ["1", "true", "yes", "deleted"].includes(normalized) ? "deleted" : "all";
}
export function normalizeTopicFilter(value) {
  return String(value || "").trim().replace(/^#+/, "").slice(0, 48);
}

export function shortVideoFtsMatchQuery(value) {
  const query = String(value || "").trim();
  if (Array.from(query).length < 3) return "";
  return `"${query.replace(/"/g, '""')}"`;
}

export function normalizeSoundFilter(value) {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,1000}$/.test(token) ? token : "";
}

export function encodeShortVideoSoundKey(value) {
  const key = String(value || "");
  return key ? Buffer.from(key, "utf8").toString("base64url") : "";
}

export function decodeShortVideoSoundKey(value) {
  try {
    const decoded = Buffer.from(normalizeSoundFilter(value), "base64url").toString("utf8");
    return decoded.length <= 600 ? decoded : "";
  } catch {
    return "";
  }
}

export function normalizeMediaFilter(value) {
  const media = String(value || "all").trim().toLowerCase();
  return ["video", "gallery"].includes(media) ? media : "all";
}

export function shortVideoMediaWhere(media, prefix = "") {
  if (media === "video") return `${prefix}media_type = 'video'`;
  if (media === "gallery") return `${prefix}media_type = 'gallery'`;
  return "1 = 1";
}

export function normalizeVideoQualityFilter(value) {
  const quality = String(value || "all").trim().toLowerCase();
  return ["4k", "1440p", "1080p", "720p", "below720p", "unknown"].includes(quality)
    ? quality
    : "all";
}

export function actualVideoQualityWhere(quality, prefix = "") {
  const pixels = `${prefix}actual_pixels`;
  return {
    "4k": `COALESCE(${pixels}, 0) >= 8294400`,
    "1440p": `COALESCE(${pixels}, 0) >= 3686400 AND COALESCE(${pixels}, 0) < 8294400`,
    "1080p": `COALESCE(${pixels}, 0) >= 2073600 AND COALESCE(${pixels}, 0) < 3686400`,
    "720p": `COALESCE(${pixels}, 0) >= 921600 AND COALESCE(${pixels}, 0) < 2073600`,
    "below720p": `COALESCE(${pixels}, 0) > 0 AND COALESCE(${pixels}, 0) < 921600`,
    unknown: `COALESCE(${pixels}, 0) <= 0`
  }[quality] || "";
}

export function formatSuggestionCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Number(value || 0)));
}

export function includePendingShortVideos(params = new URLSearchParams()) {
  const value = String(params.get("includePending") || params.get("pending") || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

export function normalizeSourceFilter(value) {
  const source = String(value || "liked").trim().toLowerCase();
  return ["recommended", "liked", "following", "history", "posts", "all", "local"].includes(source) ? source : "liked";
}

export function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, (match) => `\\${match}`);
}

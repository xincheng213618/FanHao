import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";
import { SQLITE_SHORT_VIDEO_COVER_SOURCE } from "./cover-database.js";

export function followingAuthorFacet(db) {
  return db.prepare(`
    WITH followed AS (
      SELECT
        users.id AS targetUserId,
        users.sec_uid AS secUid,
        users.nickname AS name,
        users.avatar_url AS avatarUrl,
        users.profile_url AS profileUrl,
        users.unique_id AS uniqueId,
        users.total_favorited AS totalFavorited,
        users.nickname_history_json AS nameHistoryJson,
        users.total_favorited_history_json AS totalFavoritedHistoryJson,
        users.account_status AS accountStatus,
        users.account_status_reason AS accountStatusReason,
        users.account_status_detected_at AS accountStatusDetectedAt,
        follows.followed_at AS followedAt,
        COALESCE((julianday(NULLIF(follows.followed_at, '')) - 2440587.5) * 86400000, 0) AS followedTime
      FROM short_video_follows follows
      JOIN short_video_users users ON users.id = follows.target_user_id
      WHERE follows.local_user_id = '${LOCAL_SHORT_VIDEO_USER_ID}'
        AND follows.active = 1
    ),
    local_video_stats AS (
      SELECT
        videos.owner_user_id AS targetUserId,
        COUNT(*) AS count,
        COUNT(DISTINCT CASE
          WHEN videos.is_liked = 1 THEN COALESCE(NULLIF(videos.aweme_id, ''), videos.id)
          ELSE NULL
        END) AS likedCount
      FROM short_videos videos INDEXED BY idx_short_videos_following_stats
      JOIN followed ON followed.targetUserId = videos.owner_user_id
      WHERE videos.visibility = 'local_only'
      GROUP BY videos.owner_user_id
    )
    SELECT
      followed.secUid,
      followed.name,
      followed.avatarUrl,
      followed.profileUrl,
      followed.uniqueId,
      followed.totalFavorited,
      followed.nameHistoryJson,
      followed.totalFavoritedHistoryJson,
      followed.accountStatus,
      followed.accountStatusReason,
      followed.accountStatusDetectedAt,
      1 AS following,
      followed.targetUserId,
      followed.followedAt,
      followed.followedTime,
      COALESCE(local_video_stats.count, 0) AS count,
      COALESCE(local_video_stats.likedCount, 0) AS likedCount,
      '' AS coverId,
      0 AS coverMtimeMs
    FROM followed
    LEFT JOIN local_video_stats ON local_video_stats.targetUserId = followed.targetUserId
  `).all().map(publicAuthorFacet);
}

export function authorFacet(db) {
  return db.prepare(`
    WITH grouped AS (
      SELECT
        COALESCE(NULLIF(v.author_sec_uid, ''), NULLIF(v.author_name, ''), 'unknown') AS authorKey,
        MAX(NULLIF(v.author_sec_uid, '')) AS secUid,
        COALESCE(MAX(NULLIF(v.author_name, '')), '未知作者') AS name,
        MAX(NULLIF(v.author_avatar_url, '')) AS avatarUrl,
        MAX(NULLIF(v.owner_user_id, '')) AS targetUserId,
        MAX(COALESCE(v.author_following, 0)) AS following,
        MAX(CASE WHEN v.cover_source = '${SQLITE_SHORT_VIDEO_COVER_SOURCE}' OR COALESCE(NULLIF(v.cover_path, ''), '') <> '' THEN v.id ELSE '' END) AS coverId,
        MAX(CASE WHEN v.cover_source = '${SQLITE_SHORT_VIDEO_COVER_SOURCE}' OR COALESCE(NULLIF(v.cover_path, ''), '') <> '' THEN v.mtime_ms ELSE 0 END) AS coverMtimeMs,
        COUNT(*) AS count
      FROM short_videos v INDEXED BY idx_short_videos_author_facet
      WHERE v.visibility = 'local_only'
        AND (NULLIF(v.author_sec_uid, '') IS NOT NULL OR NULLIF(v.author_name, '') IS NOT NULL)
      GROUP BY authorKey
    )
    SELECT
      COALESCE(NULLIF(author_user.sec_uid, ''), grouped.secUid) AS secUid,
      COALESCE(NULLIF(author_user.nickname, ''), grouped.name, '未知作者') AS name,
      COALESCE(NULLIF(author_user.avatar_url, ''), grouped.avatarUrl) AS avatarUrl,
      NULLIF(author_user.profile_url, '') AS profileUrl,
      NULLIF(author_user.unique_id, '') AS uniqueId,
      author_user.total_favorited AS totalFavorited,
      author_user.nickname_history_json AS nameHistoryJson,
      author_user.total_favorited_history_json AS totalFavoritedHistoryJson,
      COALESCE(NULLIF(author_user.account_status, ''), 'active') AS accountStatus,
      COALESCE(NULLIF(author_user.account_status_reason, ''), '') AS accountStatusReason,
      COALESCE(NULLIF(author_user.account_status_detected_at, ''), '') AS accountStatusDetectedAt,
      grouped.targetUserId,
      grouped.following,
      grouped.coverId,
      grouped.coverMtimeMs,
      grouped.count
    FROM grouped
    LEFT JOIN short_video_users author_user ON author_user.id = grouped.targetUserId
    ORDER BY count DESC, name COLLATE NOCASE
  `).all().map(publicAuthorFacet);
}

function publicAuthorFacet(row) {
  return {
    secUid: row.secUid || "",
    name: row.name || "未知作者",
    avatarUrl: row.avatarUrl || "",
    profileUrl: row.profileUrl || "",
    uniqueId: row.uniqueId || "",
    totalFavorited: optionalHistoryNumber(row.totalFavorited),
    nameHistory: parseAuthorProfileHistory(row.nameHistoryJson, { field: "name" }),
    totalFavoritedHistory: parseAuthorProfileHistory(row.totalFavoritedHistoryJson, { numeric: true, field: "value" }),
    accountStatus: row.accountStatus === "banned" ? "banned" : "active",
    accountStatusReason: row.accountStatusReason || "",
    accountStatusDetectedAt: row.accountStatusDetectedAt || "",
    id: row.targetUserId || "",
    following: Boolean(row.following),
    followedAt: row.followedAt || "",
    followedTime: Number(row.followedTime || 0),
    likedCount: Number(row.likedCount || 0),
    fallbackCoverUrl: row.coverId ? `/media/short-video-cover/${encodeURIComponent(row.coverId)}?v=${encodeURIComponent(String(row.coverMtimeMs || ""))}` : "",
    count: Number(row.count || 0)
  };
}

export function parseAuthorProfileHistory(value, options = {}) {
  let source = value;
  if (typeof value === "string") {
    try { source = JSON.parse(value); } catch { source = []; }
  }
  const numeric = options.numeric === true;
  const field = String(options.field || "value");
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(source) ? source : []) {
    const raw = item && typeof item === "object" ? item.value : item;
    const normalized = numeric ? optionalHistoryNumber(raw) : String(raw || "").trim();
    if (normalized === null || normalized === "") continue;
    const key = `${typeof normalized}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      [field]: normalized,
      firstSeenAt: item && typeof item === "object" ? String(item.first_seen_at || "") : "",
      lastSeenAt: item && typeof item === "object" ? String(item.last_seen_at || item.first_seen_at || "") : ""
    });
  }
  return result.sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)));
}

function optionalHistoryNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

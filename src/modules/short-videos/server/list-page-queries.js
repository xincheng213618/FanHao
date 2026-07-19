import { actualVideoQualityWhere, shortVideoMediaWhere } from "./query-contract.js";

export function createShortVideoListPageQueries({ listVideoColumns }) {
  if (!String(listVideoColumns || "").trim()) {
    throw new Error("short-video list page queries require listVideoColumns");
  }

  function fastHistoryVideoPage(database, filter, sort, limit, offset) {
    const eligible = filter.source === "history"
      && sort === "watched"
      && !filter.q
      && !filter.topic
      && !filter.soundKey
      && !filter.author
      && filter.deleted === "all";
    if (!eligible) return null;

    const whereParts = [
      "w.local_user_id = 'local:self'",
      "w.last_watched_at <> ''"
    ];
    const args = [];
    if (!filter.includePending) whereParts.push("v.visibility = 'local_only'");
    const qualityWhere = actualVideoQualityWhere(filter.quality, "v.");
    if (qualityWhere) {
      if (filter.quality === "unknown") whereParts.push(shortVideoMediaWhere("video", "v."));
      whereParts.push(qualityWhere);
    } else if (filter.media !== "all") {
      whereParts.push(shortVideoMediaWhere(filter.media, "v."));
    }
    const where = whereParts.join(" AND ");
    const total = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM short_video_watch_history w INDEXED BY idx_short_video_watch_history_recent_video
      JOIN short_videos v ON v.id = w.video_id
      WHERE ${where}
    `).get(...args)?.count || 0);
    const ids = database.prepare(`
      SELECT v.id
      FROM short_video_watch_history w INDEXED BY idx_short_video_watch_history_recent_video
      JOIN short_videos v ON v.id = w.video_id
      WHERE ${where}
      ORDER BY w.last_watched_at DESC, v.published_at DESC, v.id DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset).map((row) => String(row.id || "")).filter(Boolean);
    if (!ids.length) return { total, rows: [] };

    return {
      total,
      rows: orderedCatalogRows(database, ids)
    };
  }

  function encodeShortVideoListCursor(sort, row = {}, total = 0, seen = 0) {
    if (sort !== "likes" || !row?.id) return "";
    return Buffer.from(JSON.stringify({
      v: 1,
      s: "likes",
      l: Math.max(0, Number(row.digg_count || 0)),
      a: String(row.liked_at || ""),
      i: String(row.id || ""),
      t: Math.max(0, Math.floor(Number(total || 0))),
      n: Math.max(0, Math.floor(Number(seen || 0)))
    })).toString("base64url");
  }

  function decodeShortVideoListCursor(value, sort) {
    const token = String(value || "").trim();
    if (sort !== "likes" || !token || token.length > 512) return null;
    try {
      const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      const id = String(parsed?.i || "").trim();
      const likes = Number(parsed?.l);
      const total = Math.max(0, Math.floor(Number(parsed?.t || 0)));
      const seen = Math.max(0, Math.floor(Number(parsed?.n || 0)));
      if (parsed?.v !== 1 || parsed?.s !== "likes" || !id || !Number.isFinite(likes) || seen > total) return null;
      return {
        likes: Math.max(0, likes),
        likedAt: String(parsed?.a || "").slice(0, 80),
        id,
        total,
        seen
      };
    } catch {
      return null;
    }
  }

  function fastFilteredVideoPage(database, filter, sort, limit, offset, totalOverride, listCursor = null) {
    if (!["all", "liked", "following", "posts", "local"].includes(filter.source)
      || filter.q || filter.topic || filter.soundKey || filter.author || filter.deleted !== "all") return null;
    if (["liked", "likedAsc"].includes(sort) && filter.source !== "liked") return null;
    const likedSortAt = "v.liked_sort_at";
    const orderBy = {
      liked: `v.liked_sort_time DESC, ${likedSortAt} DESC, v.published_at DESC, v.id DESC`,
      likedAsc: `COALESCE(v.liked_sort_time, 1000000000000) ASC, ${likedSortAt} ASC, v.published_at ASC, v.id DESC`,
      published: "v.published_at DESC, v.liked_at DESC, v.id DESC",
      publishedAsc: "COALESCE(NULLIF(v.published_at, ''), '9999-12-31T23:59:59.999Z') ASC, v.liked_at ASC, v.id DESC",
      likes: "v.digg_count DESC, v.liked_at DESC, v.id DESC",
      likesAsc: `
        CASE
          WHEN COALESCE(v.digg_count, 0) > 0
            OR COALESCE(v.comment_count, 0) > 0
            OR COALESCE(v.collect_count, 0) > 0
            OR COALESCE(v.share_count, 0) > 0
          THEN COALESCE(v.digg_count, 0)
          ELSE 1000000000000
        END ASC,
        v.liked_at ASC,
        v.id DESC
      `,
      comments: "COALESCE(v.comment_count, 0) DESC, v.liked_at DESC, v.id DESC",
      duration: "COALESCE(v.duration_ms, 0) DESC, v.liked_at DESC, v.id DESC"
    }[sort];
    if (!orderBy) return null;

    const whereParts = [];
    const args = [];
    if (!filter.includePending) whereParts.push("v.visibility = 'local_only'");
    const qualityWhere = actualVideoQualityWhere(filter.quality, "v.");
    if (qualityWhere) {
      if (filter.quality === "unknown") whereParts.push(shortVideoMediaWhere("video", "v."));
      whereParts.push(qualityWhere);
    } else if (filter.media !== "all") {
      whereParts.push(shortVideoMediaWhere(filter.media, "v."));
    }
    if (filter.source === "liked") {
      whereParts.push("v.is_liked = 1");
    } else if (filter.source === "following") {
      whereParts.push("v.author_following = 1");
    } else if (filter.source === "posts") {
      whereParts.push(`EXISTS (
        SELECT 1 FROM short_video_source_memberships membership
        WHERE membership.aweme_id = v.aweme_id AND membership.source_type = 'post'
      )`);
    } else if (filter.source === "local") {
      whereParts.push(`NOT EXISTS (
        SELECT 1 FROM short_video_source_memberships membership
        WHERE membership.aweme_id = v.aweme_id
      )`);
    }
    if (sort === "likes" && listCursor) {
      whereParts.push(`(
        v.digg_count < ?
        OR (v.digg_count = ? AND v.liked_at < ?)
        OR (v.digg_count = ? AND v.liked_at = ? AND v.id < ?)
      )`);
      args.push(
        listCursor.likes,
        listCursor.likes, listCursor.likedAt,
        listCursor.likes, listCursor.likedAt, listCursor.id
      );
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const indexHint = qualityWhere
      ? "INDEXED BY idx_short_videos_actual_pixels"
      : filter.source === "following" && sort === "likes" && filter.media === "video"
        ? "INDEXED BY idx_short_videos_following_media_digg"
        : filter.source === "following" && ["published", "publishedAsc"].includes(sort) && filter.media === "video"
          ? "INDEXED BY idx_short_videos_following_media_published"
          : sort === "likes" && filter.media === "video"
            ? "INDEXED BY idx_short_videos_media_digg"
            : ["published", "publishedAsc"].includes(sort) && filter.media === "video"
              ? "INDEXED BY idx_short_videos_media_published"
              : sort === "liked" && filter.source === "liked"
                ? filter.media === "all"
                  ? "INDEXED BY idx_short_videos_liked_sort_all"
                  : "INDEXED BY idx_short_videos_liked_sort"
                : "";
    const total = listCursor
      ? listCursor.total
      : Number.isFinite(totalOverride)
      ? Number(totalOverride)
      : Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM short_videos v ${indexHint}
        ${where}
      `).get(...args)?.count || 0);
    const remaining = listCursor ? Math.max(0, listCursor.total - listCursor.seen) : limit;
    if (listCursor && remaining <= 0) {
      return { total, rows: [], hasMore: false, nextCursor: "" };
    }
    const requestedRows = listCursor ? Math.min(limit, remaining) : limit;
    const queryLimit = listCursor ? requestedRows + 1 : requestedRows;
    const effectiveOffset = listCursor ? 0 : offset;
    const ids = database.prepare(`
      SELECT v.id
      FROM short_videos v ${indexHint}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...args, queryLimit, effectiveOffset).map((row) => String(row.id || "")).filter(Boolean);
    const hasExtraRow = listCursor && ids.length > requestedRows;
    const pageIds = ids.slice(0, requestedRows);
    if (!pageIds.length) return { total, rows: [], hasMore: false, nextCursor: "" };

    const rows = orderedCatalogRows(database, pageIds);
    const seen = listCursor ? listCursor.seen + rows.length : effectiveOffset + rows.length;
    const hasMore = listCursor
      ? Boolean(hasExtraRow && seen < total)
      : seen < total;
    return {
      total,
      rows,
      hasMore,
      nextCursor: sort === "likes" && rows.length
        ? encodeShortVideoListCursor(sort, rows[rows.length - 1], total, seen)
        : ""
    };
  }

  function fastPublishedVideoPage(database, filter, sort, limit, offset, totalOverride) {
    if (!["published", "publishedAsc"].includes(sort)) return null;
    if (filter.q || filter.topic || filter.soundKey || filter.media !== "all" || filter.quality !== "all" || filter.deleted !== "all") return null;
    if (!["liked", "all", "posts", "local"].includes(filter.source)) return null;
    if (filter.author?.startsWith("name:")) return null;

    const whereParts = [];
    const args = [];
    if (!filter.includePending) whereParts.push("v.visibility = 'local_only'");
    if (filter.author && filter.author !== "all") {
      whereParts.push(`(
        v.author_sec_uid = ?
        OR v.owner_user_id IN (
          SELECT id FROM short_video_users WHERE sec_uid = ?
        )
      )`);
      args.push(filter.author, filter.author);
    }
    if (filter.source === "liked") {
      whereParts.push("v.is_liked = 1");
    } else if (filter.source === "posts") {
      whereParts.push(`EXISTS (
        SELECT 1 FROM short_video_source_memberships membership
        WHERE membership.aweme_id = v.aweme_id AND membership.source_type = 'post'
      )`);
    } else if (filter.source === "local") {
      whereParts.push(`NOT EXISTS (
        SELECT 1 FROM short_video_source_memberships membership
        WHERE membership.aweme_id = v.aweme_id
      )`);
    }

    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const orderBy = sort === "publishedAsc"
      ? "v.published_at ASC, v.liked_at ASC, v.id DESC"
      : "v.published_at DESC, v.liked_at DESC, v.id DESC";
    const total = Number.isFinite(totalOverride)
      ? Number(totalOverride)
      : Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM short_videos v
        ${where}
      `).get(...args)?.count || 0);
    const ids = database.prepare(`
      SELECT v.id
      FROM short_videos v
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset).map((row) => String(row.id || "")).filter(Boolean);
    if (!ids.length) return { total, rows: [] };

    return {
      total,
      rows: orderedCatalogRows(database, ids)
    };
  }

  function fastSourceTotalCacheKey(filter = {}) {
    if (!["posts", "local"].includes(filter.source)
      || filter.includePending
      || filter.q
      || filter.topic
      || filter.soundKey
      || filter.author
      || filter.deleted !== "all") return "";
    return `${filter.source}:${filter.media || "all"}:${filter.quality || "all"}`;
  }

  function shortVideoRelationshipTotal(database, source) {
    if (source === "liked") {
      return Number(database.prepare("SELECT COUNT(*) AS count FROM short_videos WHERE is_liked = 1").get()?.count || 0);
    }
    if (source === "posts") {
      return Number(database.prepare(`
        SELECT COUNT(DISTINCT aweme_id) AS count
        FROM short_video_source_memberships
        WHERE source_type = 'post'
      `).get()?.count || 0);
    }
    return null;
  }

  function orderedCatalogRows(database, ids) {
    const placeholders = ids.map(() => "?").join(", ");
    const fetched = database.prepare(`
      SELECT ${listVideoColumns}
      FROM short_video_catalog
      WHERE id IN (${placeholders})
    `).all(...ids);
    const byId = new Map(fetched.map((row) => [String(row.id || ""), row]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  return {
    decodeShortVideoListCursor,
    fastFilteredVideoPage,
    fastHistoryVideoPage,
    fastPublishedVideoPage,
    fastSourceTotalCacheKey,
    shortVideoRelationshipTotal
  };
}

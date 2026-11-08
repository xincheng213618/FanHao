import {
  actualVideoQualityWhere,
  escapeLike,
  shortVideoFtsMatchQuery,
  shortVideoMediaWhere
} from "./query-contract.js";
import { hasCanonicalShortVideoCatalogViews, hasCanonicalShortVideoSearchIndex } from "./schema.js";

const RELATED_TAG_CANDIDATE_LIMIT = 1024;

export function indexedAuthorVideoScope(authorValue) {
  const author = String(authorValue || "").trim();
  if (!author || author === "all" || author.startsWith("name:")) return null;
  return {
    queryPrefix: `WITH author_video_ids AS (
      SELECT id
      FROM short_videos INDEXED BY idx_short_videos_author_published
      WHERE author_sec_uid = ?
      UNION ALL
      SELECT video.id
      FROM short_video_users author
      CROSS JOIN short_videos video INDEXED BY idx_short_videos_owner
        ON video.owner_user_id = author.id
      WHERE author.platform = 'douyin'
        AND author.sec_uid = ?
        AND author.sec_uid <> ''
        AND COALESCE(video.author_sec_uid, '') <> ?
    )`,
    args: [author, author, author]
  };
}

export function shortQueryVideoPageEligible(filter, sort) {
  return filter.source === "all"
    && Boolean(filter.q)
    && !shortVideoFtsMatchQuery(filter.q)
    && !filter.topic
    && !filter.soundKey
    && !filter.author
    && filter.media === "all"
    && filter.quality === "all"
    && filter.deleted === "all"
    && ["published", "publishedAsc"].includes(sort);
}

export function indexedRelatedCandidates(database, { currentTags, authorSecUid, id, candidateLimit, candidateColumns, affinity, affinityArgs }) {
  if (!authorSecUid || !currentTags.length) return null;
  const phrases = currentTags.map(tag => /^[A-Za-z0-9\p{Script=Han}]+$/u.test(tag) ? shortVideoFtsMatchQuery(tag) : "");
  if (phrases.some(phrase => !phrase)) return null;
  try {
    const schemaVersion = database.prepare("PRAGMA main.schema_version");
    const verifiedVersion = schemaVersion.get()?.schema_version;
    if (!Number.isInteger(verifiedVersion) || !hasCanonicalShortVideoSearchIndex(database)) return null;
    // Every LIKE match for these literal tags is in the trigram candidates.
    // Author matches only need their own top K before the final top K merge.
    const rows = database.prepare(`
      WITH tag_ids AS MATERIALIZED (
        SELECT video_id AS id FROM short_video_search WHERE short_video_search MATCH ?
        LIMIT ${RELATED_TAG_CANDIDATE_LIMIT + 1}
      ), tag_count AS MATERIALIZED (SELECT COUNT(*) AS total FROM tag_ids), scoped AS MATERIALIZED (
        SELECT id FROM tag_ids
        UNION
        SELECT id FROM (
          SELECT id FROM short_videos INDEXED BY idx_short_videos_author_published
          WHERE author_sec_uid = ? AND visibility = 'local_only' AND id <> ?
          ORDER BY published_at DESC, liked_at DESC, id DESC LIMIT ?
        )
      ), candidates AS MATERIALIZED (
        SELECT ${candidateColumns}
        FROM tag_count CROSS JOIN scoped
        CROSS JOIN short_videos v ON v.id = scoped.id
        LEFT JOIN short_video_stats s ON s.video_id = v.id
        WHERE tag_count.total <= ${RELATED_TAG_CANDIDATE_LIMIT}
          AND v.visibility = 'local_only' AND v.id <> ? AND (${affinity.join(" OR ")})
        ORDER BY v.published_at DESC, v.liked_at DESC, v.id DESC LIMIT ?
      )
      SELECT tag_count.total, candidates.* FROM tag_count LEFT JOIN candidates ON TRUE
      ORDER BY candidates.published_at DESC, candidates.liked_at DESC, candidates.id DESC
    `).all(`tags_text: (${phrases.join(" OR ")})`, authorSecUid, id, candidateLimit, id, ...affinityArgs, candidateLimit);
    if (rows[0].total > RELATED_TAG_CANDIDATE_LIMIT) return null;
    // Another connection may change the index or triggers after the proof.
    if (schemaVersion.get()?.schema_version !== verifiedVersion) return null;
    return rows[0].id === null ? [] : rows;
  } catch {
    return null;
  }
}

export function createShortVideoListPageQueries({ listVideoColumns }) {
  if (!String(listVideoColumns || "").trim()) {
    throw new Error("short-video list page queries require listVideoColumns");
  }

  function prepareQualityCount(database, sql, preferCovering) {
    const original = database.prepare(sql);
    if (!preferCovering) return original;
    // The media/visibility/pixels index can count this scope without visiting
    // catalogue rows. Keep the original preparation and its schema errors.
    try { return database.prepare(sql.replace("INDEXED BY idx_short_videos_actual_pixels", "")); }
    catch { return original; }
  }

  function publishedQualityPrefix(database, qualityWhere, orderBy, limit, offset) {
    const sql = `WITH prefix AS MATERIALIZED (
      SELECT v.id, v.published_at, v.liked_at, (${qualityWhere}) AS matches_quality
      FROM short_videos v INDEXED BY idx_short_videos_media_published
      WHERE v.visibility = 'local_only' AND v.media_type = 'video'
      ORDER BY ${orderBy} LIMIT 1024
    )
    SELECT v.id FROM prefix v WHERE v.matches_quality
    ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    let statement;
    try {
      const source = database.prepare(`SELECT sql FROM main.sqlite_schema
        WHERE type = 'table' AND name = 'short_videos'
          AND NOT EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE name = 'short_videos' COLLATE NOCASE)`).get();
      if (!/^CREATE\s+TABLE\s+short_videos\s*\(\s*id\s+TEXT\s+PRIMARY\s+KEY\s*,/iu.test(source?.sql || "")) return null;
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(limit, offset);
      const prefix = plan.find(row => row.detail === "MATERIALIZE prefix");
      const input = plan.filter(row => row.parent === prefix?.id);
      if (input.length !== 1 || !input[0].detail.includes("USING INDEX idx_short_videos_media_published (media_type=? AND visibility=?)")) return null;
      statement = database.prepare(sql);
    } catch {
      return null;
    }
    const rows = statement.all(limit, offset);
    // A full page proves that the sorted prefix reached the requested rank.
    return rows.length === limit ? rows : null;
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
    }
    if (filter.media !== "all") {
      whereParts.push(shortVideoMediaWhere(filter.media, "v."));
    }
    const where = whereParts.join(" AND ");
    // A selective media or quality index can put videos first. Let SQLite
    // look up each watch-history row by user and video in that case.
    const total = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM short_video_watch_history w
      JOIN short_videos v ON v.id = w.video_id
      WHERE ${where}
    `).get(...args)?.count || 0);
    const ids = database.prepare(`
      SELECT v.id
      FROM short_video_watch_history w
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

  function fastShortQueryVideoPage(database, filter, sort, limit, offset) {
    if (!shortQueryVideoPageEligible(filter, sort)) return null;

    const like = `%${escapeLike(filter.q)}%`;
    const searchWhere = `${filter.includePending ? "" : "visibility = 'local_only' AND "}(
      title LIKE ? ESCAPE '\\' OR
      description LIKE ? ESCAPE '\\' OR
      author_name LIKE ? ESCAPE '\\' OR
      aweme_id LIKE ? ESCAPE '\\' OR
      tags_text LIKE ? ESCAPE '\\'
    )`;
    const args = [like, like, like, like, like];
    const orderBy = sort === "publishedAsc"
      ? "video.published_at ASC, video.liked_at ASC, video.id DESC"
      : "video.published_at DESC, video.liked_at DESC, video.id DESC";
    const page = database.prepare(`
      WITH matched_video_ids AS MATERIALIZED (
        SELECT video_id
        FROM short_video_search
        WHERE ${searchWhere}
      )
      SELECT video.id, COUNT(*) OVER() AS match_total
      FROM matched_video_ids matched
      JOIN short_videos video ON video.id = matched.video_id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);
    const total = page.length
      ? Number(page[0].match_total || 0)
      : Number(database.prepare(`
          SELECT COUNT(*) AS count
          FROM short_video_search
          WHERE ${searchWhere}
        `).get(...args)?.count || 0);
    const ids = page.map((row) => String(row.id || "")).filter(Boolean);
    return {
      total,
      rows: ids.length ? orderedCatalogRows(database, ids) : []
    };
  }

  function fastFtsPublishedRows(database, filter, sort, total, limit, offset) {
    if (total < 4096 || filter.source !== "all" || sort !== "published" || !shortVideoFtsMatchQuery(filter.q)
      || filter.topic || filter.soundKey || filter.author || filter.media !== "all"
      || filter.quality !== "all" || filter.deleted !== "all") return null;

    const args = [...filter.args, limit, offset];
    const ranked = `SELECT id AS rank_id, published_at AS rank_published, liked_at AS rank_liked
      FROM short_video_catalog WHERE ${filter.where}
      ORDER BY published_at DESC, liked_at DESC, id DESC LIMIT ? OFFSET ?`;
    database.exec("SAVEPOINT short_video_fts_page");
    try {
      const statement = prepareRankedFtsPage(database, ranked, args);
      return statement?.all(...args) ?? null;
    } finally {
      database.exec("RELEASE short_video_fts_page");
    }
  }

  function prepareRankedFtsPage(database, ranked, args) {
    try {
      if (!hasCanonicalShortVideoCatalogViews(database)) return null;
      const scans = database.prepare(`EXPLAIN QUERY PLAN ${ranked}`).all(...args)
        .map(row => row.detail).filter(detail => /^(?:SCAN|SEARCH) /u.test(detail));
      // SQLite can omit the view joins only when they cannot multiply rows.
      if (scans.length !== 2 || !scans.some(detail => /^(?:SCAN|SEARCH) v\b/u.test(detail))
        || !scans.some(detail => detail.startsWith("SCAN short_video_search VIRTUAL TABLE INDEX"))) return null;
      return database.prepare(`WITH fts_page AS MATERIALIZED (${ranked})
        SELECT ${listVideoColumns}
        FROM fts_page CROSS JOIN short_video_catalog ON short_video_catalog.id = fts_page.rank_id
        ORDER BY fts_page.rank_published DESC, fts_page.rank_liked DESC, fts_page.rank_id DESC`);
    } catch {
      return null;
    }
  }

  function fastTopicSoundLikesRows(database, filter, sort, total, limit, offset) {
    if (total < 4096 || filter.source !== "all" || sort !== "likes" || filter.q || filter.author
      || filter.deleted !== "all" || (!filter.topic && !filter.soundKey)) return null;
    try { database.exec("SAVEPOINT short_video_topic_sound_page"); }
    catch { return null; }
    const args = [...filter.args, limit, offset];
    let readFailed = false;
    try {
      const statement = prepareTopicSoundLikesPage(database, filter, args);
      return statement?.all(...args) ?? null;
    } catch (error) {
      readFailed = true;
      throw error;
    } finally {
      try { database.exec("RELEASE short_video_topic_sound_page"); }
      catch (error) { if (!readFailed) throw error; }
    }
  }

  function prepareTopicSoundLikesPage(database, filter, args) {
    try {
      if (!hasCanonicalShortVideoCatalogViews(database)) return null;
      const stats = database.prepare(`SELECT sql FROM main.sqlite_schema
        WHERE type = 'table' AND name = 'short_video_stats'`).get();
      if (!/^CREATE\s+TABLE\s+short_video_stats\s*\(\s*video_id\s+TEXT\s+PRIMARY\s+KEY\s*,/iu.test(stats?.sql || "")) return null;
      const ranked = `SELECT id AS rank_id, digg_count AS rank_likes, liked_at AS rank_liked
        FROM short_video_catalog WHERE ${filter.where}
        ORDER BY digg_count DESC, liked_at DESC, id DESC LIMIT ? OFFSET ?`;
      const scans = database.prepare(`EXPLAIN QUERY PLAN ${ranked}`).all(...args)
        .map(row => row.detail).filter(detail => /^(?:SCAN|SEARCH) /u.test(detail));
      // The projected view must contain one video and its optional metrics.
      // SQLite leaves any other join in this plan if it could duplicate a row.
      if (scans.length !== 2 + Number(Boolean(filter.topic)) + Number(Boolean(filter.soundKey))
        || !scans.some(detail => /^(?:SCAN|SEARCH) v\b/u.test(detail))
        || !scans.includes("SEARCH s USING INDEX sqlite_autoindex_short_video_stats_1 (video_id=?) LEFT-JOIN")
        || (filter.topic && !scans.some(detail => detail.startsWith("SEARCH short_video_topics ")))
        || (filter.soundKey && !scans.some(detail => detail.startsWith("SEARCH short_video_sounds ")))) return null;
      return database.prepare(`WITH topic_sound_page AS MATERIALIZED (${ranked})
        SELECT ${listVideoColumns}
        FROM topic_sound_page CROSS JOIN short_video_catalog ON short_video_catalog.id = topic_sound_page.rank_id
        ORDER BY topic_sound_page.rank_likes DESC, topic_sound_page.rank_liked DESC, topic_sound_page.rank_id DESC`);
    } catch {
      return null;
    }
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
      duration: "COALESCE(v.duration_ms, 0) DESC, v.liked_at DESC, v.id DESC",
      size: "v.size_bytes DESC, v.liked_at DESC, v.id DESC"
    }[sort];
    if (!orderBy) return null;

    const whereParts = [];
    const args = [];
    if (!filter.includePending) whereParts.push("v.visibility = 'local_only'");
    const qualityWhere = actualVideoQualityWhere(filter.quality, "v.");
    if (qualityWhere) {
      if (filter.quality === "unknown") whereParts.push(shortVideoMediaWhere("video", "v."));
      whereParts.push(qualityWhere);
    }
    if (filter.media !== "all") {
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
      // Match the descending index keys so SQLite can seek to the cursor.
      whereParts.push("(v.digg_count, v.liked_at, v.id) < (?, ?, ?)");
      args.push(listCursor.likes, listCursor.likedAt, listCursor.id);
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
    const publishedQuality = Boolean(qualityWhere) && filter.quality !== "unknown" && filter.source === "all"
      && filter.media === "video" && !filter.includePending && sort === "published";
    const total = listCursor
      ? listCursor.total
      : Number.isFinite(totalOverride)
      ? Number(totalOverride)
      : Number(prepareQualityCount(database, `
        SELECT COUNT(*) AS count
        FROM short_videos v ${indexHint}
        ${where}
      `, publishedQuality).get(...args)?.count || 0);
    const remaining = listCursor ? Math.max(0, listCursor.total - listCursor.seen) : limit;
    if (listCursor && remaining <= 0) {
      return { total, rows: [], hasMore: false, nextCursor: "" };
    }
    const requestedRows = listCursor ? Math.min(limit, remaining) : limit;
    const queryLimit = listCursor ? requestedRows + 1 : requestedRows;
    const effectiveOffset = listCursor ? 0 : offset;
    // Keep COUNT on its filtering index. The page can stop early on the
    // published index instead of reading every visible row and sorting it.
    const pageIndexHint = !indexHint && filter.source === "all" && sort === "published"
      ? "INDEXED BY idx_short_videos_published"
      : indexHint;
    const prefixRows = publishedQuality && total >= 4096 && effectiveOffset + queryLimit <= 512
      ? publishedQualityPrefix(database, qualityWhere, orderBy, queryLimit, effectiveOffset) : null;
    const pageRows = prefixRows ?? database.prepare(`
      SELECT v.id
      FROM short_videos v ${pageIndexHint}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...args, queryLimit, effectiveOffset);
    const ids = pageRows.map((row) => String(row.id || "")).filter(Boolean);
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

    const authorScope = indexedAuthorVideoScope(filter.author);
    const whereParts = [];
    const args = [];
    if (!filter.includePending) whereParts.push("v.visibility = 'local_only'");
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
    const queryPrefix = authorScope?.queryPrefix || "";
    const from = authorScope
      ? "FROM author_video_ids author_match CROSS JOIN short_videos v ON v.id = author_match.id"
      : "FROM short_videos v";
    const queryArgs = [...(authorScope?.args || []), ...args];
    const total = Number.isFinite(totalOverride)
      ? Number(totalOverride)
      : Number(database.prepare(`
        ${queryPrefix}
        SELECT COUNT(*) AS count
        ${from}
        ${where}
      `).get(...queryArgs)?.count || 0);
    const ids = database.prepare(`
      ${queryPrefix}
      SELECT v.id
      ${from}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...queryArgs, limit, offset).map((row) => String(row.id || "")).filter(Boolean);
    if (!ids.length) return { total, rows: [] };

    return {
      total,
      rows: orderedCatalogRows(database, ids)
    };
  }

  function authorDeletedVideoTotal(database, filter = {}) {
    const author = String(filter.author || "").trim();
    if (!author || author === "all") return 0;
    const authorScope = indexedAuthorVideoScope(author);
    if (!authorScope) {
      return Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM short_video_catalog
        WHERE visibility = 'local_only'
          AND author_deleted = 1
          AND author_name = ?
      `).get(author.slice(5))?.count || 0);
    }
    return Number(database.prepare(`
      ${authorScope.queryPrefix}
      SELECT COUNT(*) AS count
      FROM author_video_ids author_match
      CROSS JOIN short_videos video ON video.id = author_match.id
      WHERE video.visibility = 'local_only'
        AND EXISTS (
          SELECT 1
          FROM short_video_source_memberships membership INDEXED BY idx_short_video_source_memberships_type
          WHERE membership.source_type = 'post'
            AND membership.aweme_id = video.aweme_id
            AND membership.is_missing_from_profile = 1
        )
    `).get(...authorScope.args)?.count || 0);
  }

  function authorVideoCount(database, authorValue) {
    const authorScope = indexedAuthorVideoScope(authorValue);
    if (!authorScope) return 0;
    return Number(database.prepare(`
      ${authorScope.queryPrefix}
      SELECT COUNT(*) AS count
      FROM author_video_ids author_match
      CROSS JOIN short_videos video ON video.id = author_match.id
      WHERE video.visibility = 'local_only'
    `).get(...authorScope.args)?.count || 0);
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
    authorDeletedVideoTotal,
    authorVideoCount,
    decodeShortVideoListCursor,
    fastFilteredVideoPage,
    fastFtsPublishedRows,
    fastHistoryVideoPage,
    fastPublishedVideoPage,
    fastShortQueryVideoPage,
    fastTopicSoundLikesRows,
    fastSourceTotalCacheKey,
    shortVideoRelationshipTotal
  };
}

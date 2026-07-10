import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_MAX_COVER_BYTES, extractCoverFrame, extractCoverFrameAsync } from "../../lib/cover-frame.js";

const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac"]);
const DEFAULT_LIMIT = 72;
const MAX_LIMIT = 300;
const DEFAULT_COVER_GENERATE_LIMIT = 0;
const DEFAULT_DOWNLOAD_MANAGER_STATS_BACKFILL_LIMIT = 50000;
const DOWNLOAD_MANAGER_BACKFILL_CHUNK_SIZE = 500;
const DOWNLOAD_MANAGER_GALLERY_IMPORT_VERSION = "1";
const SHORT_VIDEO_TOPIC_INDEX_VERSION = "1";
const SHORT_VIDEO_SOUND_INDEX_VERSION = "1";
const NORMALIZED_SCHEMA_VERSION = "2";
const LOCAL_SHORT_VIDEO_USER_ID = "local:self";
const IMPORTED_SHORT_VIDEO_ACTION_SOURCES = new Set(["imported", "download_manager"]);
const SHORT_VIDEO_MEDIA_TYPE_SQL = `CASE
  WHEN LOWER(COALESCE(json_extract(v.metadata_json, '$.fanhaoMedia.type'), json_extract(v.metadata_json, '$.media_type'), '')) = 'gallery'
    THEN 'gallery'
  ELSE 'video'
END`;
const SHORT_VIDEO_RECOMMENDATION_SCORE_SQL = `(
  CASE
    WHEN COALESCE(user_follow.active, 0) = 1 THEN 8000000000000
    ELSE 0
  END
  + CASE
    WHEN (
      COALESCE(s.digg_count, v.digg_count, 0)
      + COALESCE(s.comment_count, v.comment_count, 0) * 6
      + COALESCE(s.collect_count, v.collect_count, 0) * 4
      + COALESCE(s.share_count, v.share_count, 0) * 3
    ) >= 1000000 THEN 5000000000000
    WHEN (
      COALESCE(s.digg_count, v.digg_count, 0)
      + COALESCE(s.comment_count, v.comment_count, 0) * 6
      + COALESCE(s.collect_count, v.collect_count, 0) * 4
      + COALESCE(s.share_count, v.share_count, 0) * 3
    ) >= 100000 THEN 4000000000000
    WHEN (
      COALESCE(s.digg_count, v.digg_count, 0)
      + COALESCE(s.comment_count, v.comment_count, 0) * 6
      + COALESCE(s.collect_count, v.collect_count, 0) * 4
      + COALESCE(s.share_count, v.share_count, 0) * 3
    ) >= 10000 THEN 3000000000000
    WHEN (
      COALESCE(s.digg_count, v.digg_count, 0)
      + COALESCE(s.comment_count, v.comment_count, 0) * 6
      + COALESCE(s.collect_count, v.collect_count, 0) * 4
      + COALESCE(s.share_count, v.share_count, 0) * 3
    ) >= 1000 THEN 2000000000000
    ELSE 1000000000000
  END
  + (
    ABS(CAST(SUBSTR(v.id, -9) AS INTEGER) * 1103515245 + 12345) % 1000000000
  ) * 1000
  + COALESCE(v.create_time, 0)
)`;
const LIST_VIDEO_COLUMNS = [
  "id",
  "aweme_id",
  "owner_user_id",
  "origin",
  "status",
  "visibility",
  "title",
  "description",
  "tags_json",
  "author_sec_uid",
  "author_uid",
  "author_name",
  "author_avatar_url",
  "author_profile_url",
  "author_unique_id",
  "author_short_id",
  "author_signature",
  "author_ip_location",
  "author_follower_count",
  "author_following_count",
  "author_total_favorited",
  "author_aweme_count",
  "author_favoriting_count",
  "author_gender",
  "author_age",
  "author_verification",
  "author_profile_collected_at",
  "author_following",
  "published_at",
  "liked_at",
  "duration_ms",
  "width",
  "height",
  "digg_count",
  "comment_count",
  "collect_count",
  "share_count",
  "play_count",
  "user_like_active",
  "user_like_source",
  "user_collect_active",
  "user_collect_source",
  "user_dislike_active",
  "user_dislike_source",
  "recommendation_score",
  "recommendation_author_rank",
  "recommendation_order_score",
  "watch_progress_ms",
  "watch_completed_count",
  "last_watched_at",
  "share_url",
  "metadata_json",
  "sound_key",
  "sound_id",
  "sound_title",
  "sound_author",
  "sound_cover_url",
  "sound_preview_url",
  "sound_local_available",
  "source_path",
  "cover_path",
  "cover_source",
  "mtime_ms",
  "file_name",
  "relative_path",
  "size_bytes"
].join(", ");

export function createShortVideoStore(options = {}) {
  const dbPath = options.dbPath;
  const roots = normalizeRoots(options.roots || []);
  const ffmpegPath = options.ffmpegPath || "ffmpeg";
  const coverCacheDir = options.coverCacheDir || path.join(path.dirname(dbPath || "."), "short-video-covers");
  const coverMaxBytes = clampInt(options.coverMaxBytes, DEFAULT_MAX_COVER_BYTES, 64 * 1024, 16 * 1024 * 1024);
  const coverGenerateLimit = clampInt(options.coverGenerateLimit, DEFAULT_COVER_GENERATE_LIMIT, 0, MAX_LIMIT);
  if (!dbPath) throw new Error("short video dbPath is required");
  let db = null;

  function database() {
    if (!db) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 10000;");
      ensureSchema(db, coverCacheDir);
      cleanupSupersededFfmpegCovers(db, coverCacheDir);
    }
    return db;
  }

  function close() {
    if (!db) return;
    try {
      db.close();
    } catch {}
    db = null;
    catalogCache.key = null;
    catalogCache.summary = null;
    catalogCache.authors = null;
    recommendationCache = { key: "", ids: [] };
  }

  // 列表的 summary() 与 authorFacet() 每次分页都会重算（聚合 + GROUP BY），
  // 但二者只在入库（scan / importDownloadManagerDb）改变行集合时才会变化。
  // 用 scanned_at + download_manager_imported_at 两个 meta 戳做缓存键：
  // scan 写入 scanned_at、import 写入 download_manager_imported_at，自动失效，零额外查询。
  const catalogCache = { key: null, summary: null, authors: null };
  let recommendationRevision = 0;
  let recommendationCache = { key: "", ids: [] };
  function ensureCatalogCacheKey(key) {
    if (catalogCache.key === key) return;
    catalogCache.key = key;
    catalogCache.summary = null;
    catalogCache.authors = null;
  }
  function catalogStamp() {
    const database = databaseOrOpen();
    return `${metaValue(database, "scanned_at")}::${metaValue(database, "download_manager_imported_at")}::${metaValue(database, "deleted_at")}`;
  }
  function cachedSummary() {
    const key = catalogStamp();
    ensureCatalogCacheKey(key);
    if (catalogCache.key === key && catalogCache.summary) return catalogCache.summary;
    const result = summary();
    catalogCache.summary = result;
    return result;
  }
  function cachedAuthorFacet(database) {
    const key = catalogStamp();
    ensureCatalogCacheKey(key);
    if (catalogCache.key === key && catalogCache.authors) return catalogCache.authors;
    const result = authorFacet(database);
    catalogCache.authors = result;
    return result;
  }

  function recommendedVideoIds(database, filter = {}) {
    const cacheKey = `${catalogStamp()}::${recommendationRevision}::${filter.q || ""}::${filter.topic || ""}::${filter.sound || ""}::${filter.author || "all"}::${filter.media || "all"}`;
    if (recommendationCache.key === cacheKey) return recommendationCache.ids;
    const where = [
      "v.visibility = 'local_only'",
      "COALESCE(user_dislike.active, 0) = 0"
    ];
    const args = [];
    if (filter.q) {
      const like = `%${escapeLike(filter.q)}%`;
      where.push(`(
        v.title LIKE ? ESCAPE '\\' OR
        v.description LIKE ? ESCAPE '\\' OR
        v.author_name LIKE ? ESCAPE '\\' OR
        v.aweme_id LIKE ? ESCAPE '\\' OR
        v.tags_text LIKE ? ESCAPE '\\'
      )`);
      args.push(like, like, like, like, like);
    }
    if (filter.topic) {
      where.push("v.id IN (SELECT video_id FROM short_video_topics WHERE topic_key = LOWER(?))");
      args.push(filter.topic);
    }
    if (filter.soundKey) {
      where.push("v.id IN (SELECT video_id FROM short_video_sounds WHERE sound_key = ?)");
      args.push(filter.soundKey);
    }
    if (filter.author && filter.author !== "all") {
      if (filter.author.startsWith("name:")) {
        where.push("v.author_name = ?");
        args.push(filter.author.slice(5));
      } else {
        where.push("v.author_sec_uid = ?");
        args.push(filter.author);
      }
    }
    if (filter.media && filter.media !== "all") {
      where.push(`${SHORT_VIDEO_MEDIA_TYPE_SQL} = ?`);
      args.push(filter.media);
    }
    const rows = database.prepare(`
      SELECT
        v.id,
        MAX(${SHORT_VIDEO_RECOMMENDATION_SCORE_SQL}) AS recommendation_group_score
      FROM short_videos v
      LEFT JOIN short_video_stats s ON s.video_id = v.id
      LEFT JOIN short_video_follows user_follow
        ON user_follow.target_user_id = v.owner_user_id
       AND user_follow.local_user_id = '${LOCAL_SHORT_VIDEO_USER_ID}'
      LEFT JOIN short_video_user_actions user_dislike
        ON user_dislike.video_id = v.id
       AND user_dislike.local_user_id = '${LOCAL_SHORT_VIDEO_USER_ID}'
       AND user_dislike.action_type = 'dislike'
      WHERE ${where.join(" AND ")}
      GROUP BY COALESCE(NULLIF(v.owner_user_id, ''), NULLIF(v.author_sec_uid, ''), NULLIF(v.author_name, ''), v.id)
      ORDER BY recommendation_group_score DESC, v.published_at DESC, v.id DESC
    `).all(...args);
    recommendationCache = {
      key: cacheKey,
      ids: rows.map((row) => String(row.id || "")).filter(Boolean)
    };
    return recommendationCache.ids;
  }

  function invalidateRecommendationCache() {
    recommendationRevision += 1;
    recommendationCache = { key: "", ids: [] };
  }

  function recommendedAdjacentRow(database, row, direction, includeAllColumns, filter, fallbackOrder) {
    const ids = recommendedVideoIds(database, filter);
    const currentIndex = ids.indexOf(String(row?.id || ""));
    if (currentIndex < 0) {
      return adjacentRow(database, row, direction, fallbackOrder, includeAllColumns, filter);
    }
    const targetId = ids[currentIndex + (direction > 0 ? 1 : -1)];
    if (!targetId) return null;
    const select = includeAllColumns ? "*" : "id";
    return database.prepare(`SELECT ${select} FROM short_video_catalog WHERE id = ?`).get(targetId) || null;
  }

  function facets() {
    const database = databaseOrOpen();
    return {
      summary: cachedSummary(),
      authors: cachedAuthorFacet(database)
    };
  }

  function searchSuggestions(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const query = String(params.get("q") || params.get("search") || "").trim().slice(0, 120);
    const media = normalizeMediaFilter(params.get("media") || params.get("type"));
    const limit = clampInt(params.get("limit"), 8, 1, 12);
    if (!query) return { query, media, suggestions: [] };
    const database = databaseOrOpen();
    const like = `%${escapeLike(query)}%`;
    const mediaWhere = media === "all" ? "" : `AND ${SHORT_VIDEO_MEDIA_TYPE_SQL} = ?`;
    const mediaArgs = media === "all" ? [] : [media];
    const authorRows = database.prepare(`
      SELECT author_name AS label, COUNT(*) AS count
      FROM short_videos v
      WHERE v.visibility = 'local_only'
        AND COALESCE(v.author_name, '') <> ''
        AND v.author_name LIKE ? ESCAPE '\\'
        ${mediaWhere}
      GROUP BY v.author_name
      ORDER BY count DESC, v.author_name ASC
      LIMIT ?
    `).all(like, ...mediaArgs, limit);
    const tagRows = database.prepare(`
      SELECT tags_json
      FROM short_videos v
      WHERE v.visibility = 'local_only'
        AND v.tags_text LIKE ? ESCAPE '\\'
        ${mediaWhere}
      ORDER BY v.published_at DESC, v.id DESC
      LIMIT 160
    `).all(like, ...mediaArgs);
    const titleRows = database.prepare(`
      SELECT title, author_name
      FROM short_videos v
      WHERE v.visibility = 'local_only'
        AND COALESCE(v.title, '') <> ''
        AND v.title LIKE ? ESCAPE '\\'
        ${mediaWhere}
      ORDER BY v.published_at DESC, v.id DESC
      LIMIT ?
    `).all(like, ...mediaArgs, limit * 2);
    const suggestions = [];
    const seen = new Set();
    const append = (item) => {
      const value = String(item?.query || item?.label || "").trim();
      const key = value.toLocaleLowerCase();
      if (!value || seen.has(key) || suggestions.length >= limit) return;
      seen.add(key);
      suggestions.push({ ...item, query: value });
    };
    for (const row of authorRows) {
      append({ kind: "author", label: row.label, query: row.label, detail: `${formatSuggestionCount(row.count)} 条作品` });
    }
    const tagCounts = new Map();
    const normalizedQuery = query.toLocaleLowerCase();
    for (const row of tagRows) {
      for (const tag of recommendationTagList(row.tags_json)) {
        const label = String(tag || "").replace(/^#/, "").trim();
        if (!label || !label.toLocaleLowerCase().includes(normalizedQuery)) continue;
        tagCounts.set(label, (tagCounts.get(label) || 0) + 1);
      }
    }
    for (const [label, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))) {
      append({ kind: "tag", label: `#${label}`, query: label, detail: `${formatSuggestionCount(count)} 条相关作品` });
    }
    for (const row of titleRows) {
      const title = String(row.title || "").trim();
      append({
        kind: "title",
        label: title.length > 56 ? `${title.slice(0, 56)}…` : title,
        query: title,
        detail: row.author_name ? `@${row.author_name}` : "作品"
      });
    }
    return { query, media, suggestions };
  }

function summary() {
  const database = databaseOrOpen();
  const totals = database.prepare(`
    SELECT
      COUNT(*) AS videos,
      COUNT(DISTINCT COALESCE(NULLIF(author_sec_uid, ''), NULLIF(author_name, ''), 'unknown')) AS authors,
      COALESCE(SUM(size_bytes), 0) AS bytes,
      COALESCE(SUM(duration_ms), 0) AS durationMs
    FROM short_videos
    WHERE visibility = 'local_only'
  `).get();
    const scannedAt = metaValue(database, "scanned_at");
    const sourceRoot = metaValue(database, "source_root");
    const authorRows = database.prepare(`
      SELECT author_sec_uid, author_name, COUNT(*) AS count
      FROM short_videos
      WHERE visibility = 'local_only'
      GROUP BY author_sec_uid, author_name
      ORDER BY count DESC, author_name COLLATE NOCASE
      LIMIT 30
    `).all();
    return {
      dbPath,
      roots: roots.map(rootStatus),
      sourceRoot,
      scannedAt,
      totals: {
        videos: Number(totals?.videos || 0),
        authors: Number(totals?.authors || 0),
        bytes: Number(totals?.bytes || 0),
        durationMs: Number(totals?.durationMs || 0)
      },
      topAuthors: authorRows.map((row) => ({
        secUid: row.author_sec_uid || "",
        name: row.author_name || "未知作者",
        count: Number(row.count || 0)
      }))
    };
  }

  function listVideos(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const filter = videoFilter(params);
    const requestedSort = normalizeSort(params.get("sort"));
    const sort = filter.source === "recommended" && !params.has("sort") ? "recommended" : requestedSort;
    const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(params.get("offset"), 0, 0, 1000000);
    const includeFacets = params.get("facets") !== "0";
    const includeStats = params.get("stats") !== "0";
    const where = filter.where ? `WHERE ${filter.where}` : "";
    const orderBy = {
      recommended: "recommendation_order_score DESC, published_at DESC",
      liked: "liked_at DESC, mtime_ms DESC",
      watched: "last_watched_at DESC, published_at DESC",
      published: "published_at DESC, liked_at DESC",
      publishedAsc: "COALESCE(NULLIF(published_at, ''), '9999-12-31T23:59:59.999Z') ASC, liked_at ASC",
      likes: "digg_count DESC, liked_at DESC",
      likesAsc: "digg_count ASC, liked_at ASC",
      comments: "comment_count DESC, liked_at DESC",
      duration: "duration_ms DESC, liked_at DESC"
    }[sort] || "published_at DESC, liked_at DESC";
    const database = databaseOrOpen();
    const recommendationIds = filter.source === "recommended" ? recommendedVideoIds(database, filter) : null;
    const total = recommendationIds
      ? recommendationIds.length
      : database.prepare(`SELECT COUNT(*) AS count FROM short_video_catalog ${where}`).get(...filter.args)?.count || 0;
    const stats = !includeStats || recommendationIds ? null : videoStats(database, where, filter.args);
    let rows;
    if (recommendationIds) {
      const pageIds = recommendationIds.slice(offset, offset + limit);
      if (!pageIds.length) {
        rows = [];
      } else {
        const placeholders = pageIds.map(() => "?").join(", ");
        const fetched = database.prepare(`
          SELECT ${LIST_VIDEO_COLUMNS}
          FROM short_video_catalog
          WHERE id IN (${placeholders})
        `).all(...pageIds);
        const byId = new Map(fetched.map((row) => [String(row.id || ""), row]));
        rows = pageIds.map((id) => byId.get(id)).filter(Boolean);
      }
    } else {
      rows = database.prepare(`
          SELECT ${LIST_VIDEO_COLUMNS}
          FROM short_video_catalog
          ${where}
          ORDER BY ${orderBy}, id DESC
          LIMIT ? OFFSET ?
        `).all(...filter.args, limit, offset);
    }
    ensureGeneratedCovers(database, rows, coverGenerateLimit);
    return {
      summary: includeFacets ? cachedSummary() : null,
      total: Number(total || 0),
      limit,
      offset,
      hasMore: offset + rows.length < Number(total || 0),
      query: filter.q,
      topic: filter.topic,
      sound: filter.sound,
      author: filter.author,
      media: filter.media,
      source: filter.source,
      sort,
      stats,
      authors: includeFacets ? cachedAuthorFacet(database) : [],
      videos: rows.map(publicVideo)
    };
  }

  function videoDetail(id, urlOrOptions = {}) {
    const database = databaseOrOpen();
    const row = videoCatalogRowByAnyId(database, id);
    if (!row) return null;
    const order = adjacentOrder(urlOrOptions);
    const filter = videoFilter(urlOrOptions?.searchParams || new URLSearchParams());
    const recommended = filter.source === "recommended";
    const prev = recommended
      ? recommendedAdjacentRow(database, row, -1, false, filter, order)
      : adjacentRow(database, row, -1, order, false, filter);
    const next = recommended
      ? recommendedAdjacentRow(database, row, 1, false, filter, order)
      : adjacentRow(database, row, 1, order, false, filter);
    return {
      video: publicVideo(row, { detail: true }),
      prevId: prev?.id || "",
      nextId: next?.id || ""
    };
  }

  function adjacentVideo(id, direction, urlOrOptions = {}) {
    const database = databaseOrOpen();
    const current = videoCatalogRowByAnyId(database, id, "id, liked_at");
    if (!current) return null;
    const fullCurrent = database.prepare("SELECT * FROM short_video_catalog WHERE id = ?").get(current.id);
    const filter = videoFilter(urlOrOptions?.searchParams || new URLSearchParams());
    const order = adjacentOrder(urlOrOptions);
    const adjacent = filter.source === "recommended"
      ? recommendedAdjacentRow(database, fullCurrent, direction, false, filter, order)
      : adjacentRow(database, fullCurrent, direction, order, false, filter);
    if (!adjacent?.id) return null;
    const row = database.prepare("SELECT * FROM short_video_catalog WHERE id = ?").get(adjacent.id);
    return row ? publicVideo(row) : null;
  }

  function relatedVideos(id, urlOrOptions = {}) {
    const database = databaseOrOpen();
    const current = videoCatalogRowByAnyId(database, id);
    if (!current) return null;
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const limit = clampInt(params.get("limit"), 24, 1, 72);
    const currentTags = recommendationTagList(current.tags_json).slice(0, 8);
    const currentTagMap = new Map(currentTags.map((tag) => [tag.toLocaleLowerCase(), tag]));
    const authorSecUid = String(current.author_sec_uid || "").trim();
    const authorName = String(current.author_name || "").trim();
    const affinity = [];
    const affinityArgs = [];
    if (authorSecUid) {
      affinity.push("author_sec_uid = ?");
      affinityArgs.push(authorSecUid);
    } else if (authorName && authorName !== "未知作者") {
      affinity.push("author_name = ?");
      affinityArgs.push(authorName);
    }
    for (const tag of currentTags) {
      affinity.push("tags_text LIKE ? ESCAPE '\\'");
      affinityArgs.push(`%${escapeLike(tag)}%`);
    }

    const candidateLimit = Math.min(720, Math.max(144, limit * 14));
    let candidates = [];
    if (affinity.length) {
      candidates = database.prepare(`
        SELECT ${LIST_VIDEO_COLUMNS}
        FROM short_video_catalog
        WHERE visibility = 'local_only'
          AND id <> ?
          AND (${affinity.join(" OR ")})
        ORDER BY published_at DESC, liked_at DESC, id DESC
        LIMIT ?
      `).all(current.id, ...affinityArgs, candidateLimit);
    }

    const seen = new Set(candidates.map((item) => String(item.id || "")));
    if (candidates.length < Math.min(candidateLimit, limit * 4)) {
      const fallback = database.prepare(`
        SELECT ${LIST_VIDEO_COLUMNS}
        FROM short_video_catalog
        WHERE visibility = 'local_only'
          AND id <> ?
        ORDER BY
          COALESCE(digg_count, 0) DESC,
          COALESCE(comment_count, 0) DESC,
          published_at DESC,
          id DESC
        LIMIT ?
      `).all(current.id, Math.max(120, limit * 5));
      for (const item of fallback) {
        const candidateId = String(item.id || "");
        if (!candidateId || seen.has(candidateId)) continue;
        seen.add(candidateId);
        candidates.push(item);
      }
    }

    const currentAuthorKey = shortVideoRecommendationAuthorKey(current);
    const currentMediaType = publicVideoMedia(current, parseJsonObject(current.metadata_json)).type;
    const scored = candidates.map((candidate) => {
      const candidateTags = recommendationTagList(candidate.tags_json);
      const sharedTags = [];
      const sharedSeen = new Set();
      for (const tag of candidateTags) {
        const normalized = tag.toLocaleLowerCase();
        if (!currentTagMap.has(normalized) || sharedSeen.has(normalized)) continue;
        sharedSeen.add(normalized);
        sharedTags.push(currentTagMap.get(normalized));
      }
      const sameAuthor = Boolean(currentAuthorKey && currentAuthorKey === shortVideoRecommendationAuthorKey(candidate));
      const candidateMediaType = publicVideoMedia(candidate, parseJsonObject(candidate.metadata_json)).type;
      const engagement = Math.max(0,
        Number(candidate.digg_count || 0)
        + Number(candidate.comment_count || 0) * 2
        + Number(candidate.collect_count || 0)
      );
      const score = sharedTags.length * 36
        + (sameAuthor ? 12 : 0)
        + (candidateMediaType === currentMediaType ? 3 : 0)
        + Math.log10(engagement + 2) * 2.4;
      const reason = sharedTags.length
        ? `共同话题 #${sharedTags[0]}${sharedTags.length > 1 ? ` 等 ${sharedTags.length} 个` : ""}`
        : (sameAuthor ? "同一作者" : "本地高赞");
      return { candidate, score, sharedTags, sameAuthor, reason };
    }).sort((left, right) => (
      right.score - left.score
      || Number(right.candidate.digg_count || 0) - Number(left.candidate.digg_count || 0)
      || String(right.candidate.published_at || "").localeCompare(String(left.candidate.published_at || ""))
    ));

    const selected = [];
    const selectedIds = new Set();
    const authorCounts = new Map();
    for (const item of scored) {
      if (selected.length >= limit) break;
      const candidateId = String(item.candidate.id || "");
      const authorKey = shortVideoRecommendationAuthorKey(item.candidate) || `video:${candidateId}`;
      if (!candidateId || selectedIds.has(candidateId) || Number(authorCounts.get(authorKey) || 0) >= 3) continue;
      selected.push(item);
      selectedIds.add(candidateId);
      authorCounts.set(authorKey, Number(authorCounts.get(authorKey) || 0) + 1);
    }
    for (const item of scored) {
      if (selected.length >= limit) break;
      const candidateId = String(item.candidate.id || "");
      if (!candidateId || selectedIds.has(candidateId)) continue;
      selected.push(item);
      selectedIds.add(candidateId);
    }

    return {
      video: publicVideo(current),
      basis: {
        tags: currentTags,
        author: authorName || "未知作者"
      },
      total: selected.length,
      videos: selected.map((item) => ({
        ...publicVideo(item.candidate),
        recommendation: {
          score: Number(item.score.toFixed(2)),
          reason: item.reason,
          sharedTags: item.sharedTags,
          sameAuthor: item.sameAuthor
        }
      }))
    };
  }

  function setUserAction(id, actionType, options = {}) {
    const database = databaseOrOpen();
    const type = String(actionType || "").trim().toLowerCase();
    if (!new Set(["like", "collect", "dislike"]).has(type)) {
      const error = new Error("不支持的短视频互动类型");
      error.statusCode = 400;
      throw error;
    }
    const currentVideo = videoCatalogRowByAnyId(database, id, "id");
    if (!currentVideo?.id) {
      const error = new Error("短视频不存在");
      error.statusCode = 404;
      throw error;
    }
    const existing = database.prepare(`
      SELECT active, source, acted_at
      FROM short_video_user_actions
      WHERE local_user_id = ? AND video_id = ? AND action_type = ?
    `).get(LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id, type);
    const active = Object.prototype.hasOwnProperty.call(options || {}, "active")
      ? Boolean(options.active)
      : !Boolean(existing?.active);
    const now = new Date().toISOString();
    const source = String(existing?.source || "").trim() || "local_web";
    database.prepare(`
      INSERT INTO short_video_user_actions (
        local_user_id, video_id, action_type, active, source, acted_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_user_id, video_id, action_type) DO UPDATE SET
        active = excluded.active,
        source = CASE
          WHEN COALESCE(short_video_user_actions.source, '') = '' THEN excluded.source
          ELSE short_video_user_actions.source
        END,
        acted_at = excluded.acted_at,
        updated_at = excluded.updated_at
    `).run(LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id, type, active ? 1 : 0, source, now, now);
    if (type === "dislike") invalidateRecommendationCache();
    const updated = videoCatalogRowByAnyId(database, currentVideo.id);
    return {
      ok: true,
      videoId: currentVideo.id,
      actionType: type,
      active,
      video: publicVideo(updated, { detail: true })
    };
  }

  function setAuthorFollow(id, options = {}) {
    const database = databaseOrOpen();
    const currentVideo = videoCatalogRowByAnyId(database, id, "id, owner_user_id, author_sec_uid, author_name");
    if (!currentVideo?.id) {
      const error = new Error("短视频不存在");
      error.statusCode = 404;
      throw error;
    }
    const targetUserId = String(currentVideo.owner_user_id || "").trim();
    if (!targetUserId) {
      const error = new Error("当前作品没有可关注的作者资料");
      error.statusCode = 400;
      throw error;
    }
    const existing = database.prepare(`
      SELECT active, followed_at
      FROM short_video_follows
      WHERE local_user_id = ? AND target_user_id = ?
    `).get(LOCAL_SHORT_VIDEO_USER_ID, targetUserId);
    const active = Object.prototype.hasOwnProperty.call(options || {}, "active")
      ? Boolean(options.active)
      : !Boolean(existing?.active);
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO short_video_follows (
        local_user_id, target_user_id, active, followed_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(local_user_id, target_user_id) DO UPDATE SET
        active = excluded.active,
        followed_at = CASE
          WHEN excluded.active = 1 THEN excluded.followed_at
          ELSE short_video_follows.followed_at
        END,
        updated_at = excluded.updated_at
    `).run(LOCAL_SHORT_VIDEO_USER_ID, targetUserId, active ? 1 : 0, active ? now : (existing?.followed_at || ""), now);
    catalogCache.authors = null;
    invalidateRecommendationCache();
    const updated = videoCatalogRowByAnyId(database, currentVideo.id);
    return {
      ok: true,
      videoId: currentVideo.id,
      targetUserId,
      active,
      video: publicVideo(updated, { detail: true })
    };
  }

  function recordWatch(id, options = {}) {
    const database = databaseOrOpen();
    const currentVideo = videoCatalogRowByAnyId(database, id, "id, duration_ms");
    if (!currentVideo?.id) {
      const error = new Error("短视频不存在");
      error.statusCode = 404;
      throw error;
    }
    const rawDurationMs = Number(currentVideo.duration_ms || 0);
    const rawProgressMs = Number(options.progressMs || 0);
    const durationMs = Number.isFinite(rawDurationMs) ? Math.max(0, rawDurationMs) : 0;
    const requestedProgress = Number.isFinite(rawProgressMs) ? Math.max(0, rawProgressMs) : 0;
    const progressMs = Math.round(durationMs > 0 ? Math.min(durationMs, requestedProgress) : requestedProgress);
    const completed = options.completed === true
      || (durationMs > 0 && progressMs >= Math.max(1000, durationMs - 1000));
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO short_video_watch_history (
        local_user_id, video_id, progress_ms, completed_count, last_watched_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(local_user_id, video_id) DO UPDATE SET
        progress_ms = excluded.progress_ms,
        completed_count = CASE
          WHEN excluded.completed_count > 0 THEN MAX(short_video_watch_history.completed_count, 1)
          ELSE short_video_watch_history.completed_count
        END,
        last_watched_at = excluded.last_watched_at
    `).run(LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id, progressMs, completed ? 1 : 0, now);
    const updated = videoCatalogRowByAnyId(database, currentVideo.id);
    return {
      ok: true,
      videoId: currentVideo.id,
      progressMs,
      completed,
      watchedAt: now,
      video: publicVideo(updated, { detail: true })
    };
  }

  function localComments(id) {
    const database = databaseOrOpen();
    const currentVideo = videoCatalogRowByAnyId(database, id, "id");
    if (!currentVideo?.id) return null;
    const rows = database.prepare(`
      SELECT id, body, created_at, updated_at
      FROM short_video_local_comments
      WHERE local_user_id = ? AND video_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `).all(LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id);
    return {
      videoId: currentVideo.id,
      total: rows.length,
      comments: rows.map(publicLocalComment)
    };
  }

  function createLocalComment(id, options = {}) {
    const database = databaseOrOpen();
    const currentVideo = videoCatalogRowByAnyId(database, id, "id");
    if (!currentVideo?.id) {
      const error = new Error("短视频不存在");
      error.statusCode = 404;
      throw error;
    }
    const body = normalizeLocalCommentBody(options.body ?? options.text);
    if (!body) {
      const error = new Error("请输入评论内容");
      error.statusCode = 400;
      throw error;
    }
    const commentId = `local:${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO short_video_local_comments (
        id, local_user_id, video_id, body, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(commentId, LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id, body, now, now);
    return {
      ok: true,
      videoId: currentVideo.id,
      comment: publicLocalComment({ id: commentId, body, created_at: now, updated_at: now }),
      ...localComments(currentVideo.id)
    };
  }

  function deleteLocalComment(id, commentId) {
    const database = databaseOrOpen();
    const currentVideo = videoCatalogRowByAnyId(database, id, "id");
    if (!currentVideo?.id) {
      const error = new Error("短视频不存在");
      error.statusCode = 404;
      throw error;
    }
    const normalizedCommentId = String(commentId || "").trim();
    const result = database.prepare(`
      DELETE FROM short_video_local_comments
      WHERE id = ? AND local_user_id = ? AND video_id = ?
    `).run(normalizedCommentId, LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id);
    if (!Number(result.changes || 0)) {
      const error = new Error("本地评论不存在");
      error.statusCode = 404;
      throw error;
    }
    return {
      ok: true,
      deletedId: normalizedCommentId,
      ...localComments(currentVideo.id)
    };
  }

  function deleteVideo(id, options = {}) {
    const database = databaseOrOpen();
    const row = videoCatalogRowByAnyId(database, id);
    if (!row) {
      const error = new Error("短视频不存在");
      error.statusCode = 404;
      throw error;
    }
    const videoId = row.id || id;
    const fullRow = database.prepare("SELECT * FROM short_videos WHERE id = ?").get(videoId);
    if (!fullRow) {
      const error = new Error("短视频记录不存在");
      error.statusCode = 404;
      throw error;
    }
    return deleteShortVideos(database, [fullRow], { ...options, scope: "single" });
  }

  function deleteVideoGroup(id, options = {}) {
    const database = databaseOrOpen();
    const row = videoCatalogRowByAnyId(database, id);
    if (!row) {
      const error = new Error("短视频不存在");
      error.statusCode = 404;
      throw error;
    }
    const videoId = row.id || id;
    const fullRow = database.prepare("SELECT * FROM short_videos WHERE id = ?").get(videoId);
    if (!fullRow) {
      const error = new Error("短视频记录不存在");
      error.statusCode = 404;
      throw error;
    }
    const groupDir = shortVideoManagedParentDir(fullRow.source_path || "");
    if (!groupDir) {
      const error = new Error("这条视频没有可安全批量删除的本地同组目录");
      error.statusCode = 400;
      throw error;
    }
    const rows = database.prepare(`
      SELECT *
      FROM short_videos
      WHERE COALESCE(NULLIF(source_path, ''), '') <> ''
    `).all().filter((item) => shortVideoManagedParentDir(item.source_path || "") === groupDir);
    return deleteShortVideos(database, rows, { ...options, scope: "group", groupDir });
  }

  function deleteVideos(ids, options = {}) {
    const database = databaseOrOpen();
    const canonicalIds = [];
    const seen = new Set();
    for (const id of ids || []) {
      const value = String(id || "").trim();
      if (!value) continue;
      const row = videoCatalogRowByAnyId(database, value, "id");
      const videoId = row?.id || value;
      if (seen.has(videoId)) continue;
      seen.add(videoId);
      canonicalIds.push(videoId);
    }
    if (!canonicalIds.length) {
      const error = new Error("请选择要删除的短视频");
      error.statusCode = 400;
      throw error;
    }
    const placeholders = canonicalIds.map(() => "?").join(", ");
    const rows = database.prepare(`SELECT * FROM short_videos WHERE id IN (${placeholders})`).all(...canonicalIds);
    if (!rows.length) {
      const error = new Error("没有找到可删除的短视频记录");
      error.statusCode = 404;
      throw error;
    }
    return deleteShortVideos(database, rows, { ...options, scope: "batch" });
  }

  function deleteShortVideos(database, rows, options = {}) {
    const fullRows = [];
    const seenIds = new Set();
    for (const row of rows || []) {
      const id = String(row?.id || "").trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      fullRows.push(row);
    }
    if (!fullRows.length) {
      const error = new Error("没有可删除的短视频记录");
      error.statusCode = 404;
      throw error;
    }
    const videoIds = fullRows.map((item) => item.id);
    const firstRow = fullRows[0];
    const deleteFiles = options.deleteFiles !== false;
    const files = deleteFiles ? shortVideoFilesForDelete(database, fullRows) : [];
    const deletedFiles = [];
    const deletedFilePaths = [];
    const missingFiles = [];
    const skippedFiles = [];
    const errors = [];

    if (deleteFiles) {
      for (const filePath of files) {
        const result = deleteShortVideoFile(database, filePath, videoIds);
        if (result.deleted) {
          deletedFiles.push(result.relativePath || result.path);
          deletedFilePaths.push(result.path);
        }
        else if (result.missing) missingFiles.push(result.relativePath || result.path);
        else if (result.skipped) skippedFiles.push({ path: result.relativePath || result.path, reason: result.reason || "" });
        else if (result.error) errors.push({ path: result.relativePath || result.path, error: result.error });
      }
      if (errors.length) {
        const error = new Error(`删除本地文件失败：${errors[0].error}`);
        error.statusCode = 500;
        error.details = { errors, deletedFiles, skippedFiles };
        throw error;
      }
    }

    const emptyRemovedPaths = deleteFiles ? removeEmptyShortVideoParents(deletedFilePaths) : [];
    const now = new Date().toISOString();
    database.exec("BEGIN");
    try {
      deleteShortVideoRows(database, videoIds);
      database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('deleted_at', ?)").run(now);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    catalogCache.key = null;
    catalogCache.summary = null;
    catalogCache.authors = null;
    return {
      ok: true,
      id: firstRow.id,
      ids: videoIds,
      count: videoIds.length,
      scope: options.scope || "single",
      groupDir: options.groupDir ? shortVideoRelativePath(options.groupDir) : "",
      title: firstRow.title || firstRow.description || firstRow.file_name || "",
      deletedFiles,
      missingFiles,
      skippedFiles,
      emptyRemovedPaths
    };
  }

  function deleteShortVideoRows(database, videoIds) {
    const ids = uniqueTextArray(videoIds, { maxItems: 10000, maxLength: 200 });
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(", ");
    for (const table of [
      "short_video_stats",
      "short_video_assets",
      "short_video_user_actions",
      "short_video_collection_items",
      "short_video_watch_history",
      "short_video_local_comments",
      "short_video_import_items"
    ]) {
      database.prepare(`DELETE FROM ${table} WHERE video_id IN (${placeholders})`).run(...ids);
    }
    database.prepare(`DELETE FROM short_videos WHERE id IN (${placeholders})`).run(...ids);
  }

  function shortVideoFilesForDelete(database, rowsOrRow) {
    const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
    const ids = uniqueTextArray(rows.map((row) => row?.id || ""), { maxItems: 10000, maxLength: 200 });
    let assetRows = [];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      assetRows = database.prepare(`
        SELECT local_path
        FROM short_video_assets
        WHERE video_id IN (${placeholders})
          AND COALESCE(NULLIF(local_path, ''), '') <> ''
      `).all(...ids);
    }
    const rowFiles = [];
    for (const row of rows) {
      if (!row) continue;
      rowFiles.push(row.source_path || "", row.cover_path || "", row.music_path || "", row.data_path || "");
    }
    return uniqueTextArray([
      ...rowFiles,
      ...assetRows.map((item) => item.local_path || "")
    ].filter(Boolean), { maxItems: 10000, maxLength: 1000 });
  }

  function shortVideoManagedParentDir(filePath) {
    if (!filePath) return "";
    const resolved = path.resolve(String(filePath || ""));
    if (!isShortVideoManagedPath(resolved)) return "";
    const dir = path.dirname(resolved);
    const rootsResolved = roots.map((item) => path.resolve(item));
    if (rootsResolved.some((root) => dir === root) || dir === path.resolve(coverCacheDir)) return "";
    return dir;
  }

  function deleteShortVideoFile(database, filePath, videoIds) {
    const resolved = path.resolve(String(filePath || ""));
    const relativePath = shortVideoRelativePath(resolved);
    if (!isShortVideoManagedPath(resolved)) return { path: resolved, relativePath, skipped: true, reason: "不在短视频目录内" };
    if (isFileReferencedByOtherVideo(database, resolved, videoIds)) return { path: resolved, relativePath, skipped: true, reason: "仍被其他短视频引用" };
    const stat = safeStat(resolved);
    if (!stat) return { path: resolved, relativePath, missing: true };
    if (!stat.isFile()) return { path: resolved, relativePath, skipped: true, reason: "不是文件" };
    try {
      fs.unlinkSync(resolved);
      return { path: resolved, relativePath, deleted: true };
    } catch (error) {
      return { path: resolved, relativePath, error: error.message || String(error) };
    }
  }

  function isFileReferencedByOtherVideo(database, filePath, videoIds) {
    const ignoredIds = uniqueTextArray(Array.isArray(videoIds) ? videoIds : [videoIds], { maxItems: 10000, maxLength: 200 });
    const exact = path.resolve(filePath);
    const ignoreClause = ignoredIds.length ? `id NOT IN (${ignoredIds.map(() => "?").join(", ")}) AND` : "";
    const row = database.prepare(`
      SELECT 1
      FROM short_videos
      WHERE ${ignoreClause}
        (
          source_path = ? OR cover_path = ? OR music_path = ? OR data_path = ?
        )
      LIMIT 1
    `).get(...ignoredIds, exact, exact, exact, exact);
    if (row) return true;
    const assetIgnoreClause = ignoredIds.length ? `video_id NOT IN (${ignoredIds.map(() => "?").join(", ")}) AND` : "";
    const asset = database.prepare(`
      SELECT 1
      FROM short_video_assets
      WHERE ${assetIgnoreClause}
        local_path = ?
      LIMIT 1
    `).get(...ignoredIds, exact);
    return Boolean(asset);
  }

  function removeEmptyShortVideoParents(filePaths) {
    const removed = [];
    const rootsResolved = roots.map((item) => path.resolve(item));
    for (const filePath of filePaths || []) {
      let current = path.dirname(path.resolve(filePath));
      while (current && rootsResolved.some((root) => isPathInsideRoot(current, root)) && !rootsResolved.some((root) => current === root)) {
        try {
          const entries = fs.readdirSync(current);
          if (entries.length) break;
          fs.rmdirSync(current);
          removed.push(shortVideoRelativePath(current));
          current = path.dirname(current);
        } catch {
          break;
        }
      }
    }
    return uniqueTextArray(removed, { maxItems: 80, maxLength: 1000 });
  }

  function isShortVideoManagedPath(filePath) {
    const resolved = path.resolve(filePath);
    return roots.some((root) => isPathInsideRoot(resolved, path.resolve(root)))
      || isPathInsideRoot(resolved, path.resolve(coverCacheDir));
  }

  function shortVideoRelativePath(filePath) {
    const resolved = path.resolve(filePath);
    for (const root of roots) {
      const rootPath = path.resolve(root);
      if (isPathInsideRoot(resolved, rootPath)) return path.relative(rootPath, resolved);
    }
    const cacheRoot = path.resolve(coverCacheDir);
    if (isPathInsideRoot(resolved, cacheRoot)) return path.join("[封面缓存]", path.relative(cacheRoot, resolved));
    return resolved;
  }

  function videoFile(id, options = {}) {
    const row = videoCatalogRowByAnyId(databaseOrOpen(), id, "id, source_path");
    if (options.allowMissing && row?.source_path) {
      return { id: row.id || id, path: path.resolve(row.source_path), type: "video", ext: path.extname(row.source_path).toLowerCase() };
    }
    return fileFromRow(row, "video");
  }

  function musicFile(id) {
    const row = videoCatalogRowByAnyId(databaseOrOpen(), id, "id, music_path");
    return safeStoredFile(row?.music_path || "", "audio", row?.id || id);
  }

  function galleryFile(id, index = 0) {
    const database = databaseOrOpen();
    const row = videoCatalogRowByAnyId(database, id, "id, source_path, cover_path");
    if (!row) return null;
    const normalizedIndex = clampInt(index, 0, 0, 9999);
    const asset = database.prepare(`
      SELECT local_path
      FROM short_video_assets
      WHERE video_id = ?
        AND asset_type = ?
      LIMIT 1
    `).get(row.id, galleryAssetType(normalizedIndex));
    const fallbackPath = normalizedIndex === 0 ? (row.cover_path || row.source_path || "") : "";
    return safeStoredFile(asset?.local_path || fallbackPath, "image", `${row.id}:gallery:${normalizedIndex}`);
  }

  function coverFile(id) {
    const database = databaseOrOpen();
    const row = videoCatalogRowByAnyId(database, id);
    if (!row?.cover_path) return null;
    return safeStoredFile(row.cover_path, "image");
  }

  function coverBackfillStatus(sampleLimit = 8) {
    const database = databaseOrOpen();
    const missing = missingCoverCount(database);
    const sample = missingCoverRows(database, clampInt(sampleLimit, 8, 0, 50)).map((row) => ({
      id: row.id || "",
      awemeId: row.aweme_id || "",
      title: row.title || row.description || row.file_name || "",
      sourcePath: row.source_path || "",
      authorName: row.author_name || ""
    }));
    return {
      dbPath,
      missing,
      sample
    };
  }

  function backfillMissingCovers(options = {}) {
    const limit = clampInt(options.limit, 50, 0, 50000);
    const database = databaseOrOpen();
    const startedAt = new Date().toISOString();
    const beforeMissing = missingCoverCount(database);
    const rows = missingCoverRows(database, limit || beforeMissing);
    const generated = ensureGeneratedCovers(database, rows, rows.length);
    const afterMissing = missingCoverCount(database);
    const finishedAt = new Date().toISOString();
    if (generated > 0) {
      database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('cover_backfill_at', ?)").run(finishedAt);
      catalogCache.key = null;
      catalogCache.summary = null;
      catalogCache.authors = null;
    }
    return {
      ok: true,
      dbPath,
      startedAt,
      finishedAt,
      beforeMissing,
      selected: rows.length,
      generated,
      skipped: Math.max(0, rows.length - generated),
      afterMissing
    };
  }

  async function backfillMissingCoversAsync(options = {}) {
    const limit = clampInt(options.limit, 50, 0, 50000);
    const concurrency = clampInt(options.concurrency, 2, 1, 16);
    const database = databaseOrOpen();
    const startedAt = new Date().toISOString();
    const beforeMissing = missingCoverCount(database);
    const rows = missingCoverRows(database, limit || beforeMissing);
    const generated = await ensureGeneratedCoversAsync(database, rows, rows.length, {
      concurrency,
      onProgress: options.onProgress
    });
    const afterMissing = missingCoverCount(database);
    const finishedAt = new Date().toISOString();
    if (generated > 0) {
      database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('cover_backfill_at', ?)").run(finishedAt);
      catalogCache.key = null;
      catalogCache.summary = null;
      catalogCache.authors = null;
    }
    return {
      ok: true,
      dbPath,
      startedAt,
      finishedAt,
      beforeMissing,
      selected: rows.length,
      generated,
      skipped: Math.max(0, rows.length - generated),
      afterMissing,
      concurrency
    };
  }

  function missingCoverCount(database) {
    return Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM short_video_catalog
      WHERE COALESCE(TRIM(cover_path), '') = ''
        AND COALESCE(TRIM(source_path), '') <> ''
    `).get()?.count || 0);
  }

  function missingCoverRows(database, limit) {
    const safeLimit = clampInt(limit, 50, 0, 50000);
    if (safeLimit <= 0) return [];
    return database.prepare(`
      SELECT *
      FROM short_video_catalog
      WHERE COALESCE(TRIM(cover_path), '') = ''
        AND COALESCE(TRIM(source_path), '') <> ''
      ORDER BY liked_at DESC, published_at DESC, id DESC
      LIMIT ?
    `).all(safeLimit);
  }

  function generatedCoverStatements(database) {
    return {
      video: database.prepare(`
        UPDATE short_videos
        SET cover_path = ?,
            cover_source = 'ffmpeg',
            updated_at = ?
        WHERE id = ?
          AND COALESCE(cover_source, '') <> 'native'
      `),
      asset: normalizedUpsertStatements(database).asset
    };
  }

  function recordGeneratedCover(row, coverPath, statements) {
    if (!row?.id || !coverPath) return false;
    const now = new Date().toISOString();
    const result = runSqliteBusyRetry(() => statements.video.run(coverPath, now, row.id));
    if (Number(result?.changes || 0) <= 0) {
      removeGeneratedCoverFile(coverPath, coverCacheDir);
      return false;
    }
    row.cover_path = coverPath;
    row.cover_source = "ffmpeg";
    const stat = safeStat(coverPath);
    runAssetUpsert(statements.asset, {
      videoId: row.id,
      assetType: "ffmpeg_cover",
      localPath: coverPath,
      fileName: path.basename(coverPath),
      sizeBytes: stat?.size || 0,
      mtimeMs: Math.floor(stat?.mtimeMs || Date.now())
    }, now);
    return true;
  }

  function ensureGeneratedCovers(database, rows, maxCount) {
    if (!maxCount || maxCount <= 0) return 0;
    let generated = 0;
    const statements = generatedCoverStatements(database);
    for (const row of rows) {
      if (generated >= maxCount) return generated;
      if (!row || (row.cover_path && fs.existsSync(row.cover_path))) continue;
      const coverPath = generateCoverForRow(row);
      if (!coverPath) continue;
      if (recordGeneratedCover(row, coverPath, statements)) generated += 1;
    }
    return generated;
  }

  async function ensureGeneratedCoversAsync(database, rows, maxCount, options = {}) {
    if (!maxCount || maxCount <= 0) return 0;
    const selectedRows = rows.slice(0, maxCount);
    if (!selectedRows.length) return 0;
    const concurrency = clampInt(options.concurrency, 2, 1, 16);
    const workerCount = Math.min(concurrency, selectedRows.length);
    const statements = generatedCoverStatements(database);
    let nextIndex = 0;
    let processed = 0;
    let generated = 0;

    async function worker() {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= selectedRows.length) return;
        const row = selectedRows[index];
        let didGenerate = false;
        if (row && !(row.cover_path && fs.existsSync(row.cover_path))) {
          const coverPath = await generateCoverForRowAsync(row);
          if (coverPath) didGenerate = recordGeneratedCover(row, coverPath, statements);
        }
        processed += 1;
        if (didGenerate) generated += 1;
        options.onProgress?.({
          processed,
          total: selectedRows.length,
          generated,
          skipped: processed - generated,
          concurrency
        });
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return generated;
  }

  function generateCoverForRow(row) {
    if (!row?.source_path || !fs.existsSync(row.source_path)) return "";
    let tempInput = null;
    try {
      fs.mkdirSync(coverCacheDir, { recursive: true });
      const coverPath = path.join(coverCacheDir, coverFileName(row));
      if (fs.existsSync(coverPath) && safeStat(coverPath)?.size > 0) return coverPath;
      tempInput = asciiInputPath(row.source_path, coverCacheDir, row.id || row.aweme_id || "");
      const buffer = extractCoverFrame(tempInput.path, {
        duration: Number(row.duration_ms || 0) > 0 ? Number(row.duration_ms) / 1000 : undefined,
        ffmpegPath,
        maxBytes: coverMaxBytes,
        timeoutMs: 15000
      });
      fs.writeFileSync(coverPath, buffer);
      return coverPath;
    } catch (error) {
      console.warn("[short-video-cover]", row.id || row.source_path, error.message || error);
      return "";
    } finally {
      if (tempInput?.cleanup) tempInput.cleanup();
    }
  }

  async function generateCoverForRowAsync(row) {
    if (!row?.source_path || !fs.existsSync(row.source_path)) return "";
    let tempInput = null;
    try {
      fs.mkdirSync(coverCacheDir, { recursive: true });
      const coverPath = path.join(coverCacheDir, coverFileName(row));
      if (fs.existsSync(coverPath) && safeStat(coverPath)?.size > 0) return coverPath;
      tempInput = asciiInputPath(row.source_path, coverCacheDir, row.id || row.aweme_id || "");
      const buffer = await extractCoverFrameAsync(tempInput.path, {
        duration: Number(row.duration_ms || 0) > 0 ? Number(row.duration_ms) / 1000 : undefined,
        ffmpegPath,
        maxBytes: coverMaxBytes,
        timeoutMs: 15000
      });
      fs.writeFileSync(coverPath, buffer);
      return coverPath;
    } catch (error) {
      console.warn("[short-video-cover]", row.id || row.source_path, error.message || error);
      return "";
    } finally {
      if (tempInput?.cleanup) tempInput.cleanup();
    }
  }

  function scan(inputRoot = "") {
    const root = String(inputRoot || "").trim() ? path.resolve(String(inputRoot).trim()) : roots[0] || "";
    if (!root) {
      const error = new Error("没有配置短视频点赞目录");
      error.statusCode = 400;
      throw error;
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      const error = new Error(`短视频点赞目录不存在：${root}`);
      error.statusCode = 400;
      throw error;
    }

    const now = new Date().toISOString();
    const database = databaseOrOpen();
    const foundIds = new Set();
    const upsert = shortVideoUpsertStatement(database);
    const normalized = normalizedUpsertStatements(database, coverCacheDir);
    const resolveExistingCanonical = canonicalShortVideoBySourcePathStatement(database);
    const writeBatch = (items) => {
      if (!items.length) return;
      database.exec("BEGIN");
      try {
        for (const item of items) {
          applyCanonicalShortVideoIdentity(database, resolveExistingCanonical, item);
          foundIds.add(item.id);
          upsert.run(...videoRowValues(item, now));
          upsertNormalizedItem(normalized, item, now, { actionSource: "imported" });
          pruneSourcePathDuplicates(database, item);
        }
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanned_at', ?)").run(now);
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('source_root', ?)").run(root);
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanner_version', '2')").run();
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    };

    let scannedFiles = 0;
    let imported = 0;
    const batch = [];
    for (const filePath of walkFiles(root)) {
      if (!VIDEO_EXTS.has(path.extname(filePath).toLowerCase())) continue;
      scannedFiles += 1;
      const item = parseVideoFile(root, filePath);
      if (!item) continue;
      batch.push(item);
      imported += 1;
      if (batch.length >= 500) {
        writeBatch(batch.splice(0));
      }
    }
    if (batch.length) writeBatch(batch.splice(0));
    deleteMissingImportedVideos(database, foundIds);
    return { ok: true, root, scannedFiles, imported, scannedAt: now, summary: summary() };
  }

  function importDownloadManagerDb(inputDbPath, options = {}) {
    const rawSourceDbPath = String(inputDbPath || "").trim();
    if (!rawSourceDbPath) {
      const error = new Error("没有提供抖音下载器数据库路径");
      error.statusCode = 400;
      throw error;
    }
    const sourceDbPath = path.resolve(rawSourceDbPath);
    if (!fs.existsSync(sourceDbPath) || !safeStat(sourceDbPath)?.isFile()) {
      const error = new Error(`抖音下载器数据库不存在：${sourceDbPath}`);
      error.statusCode = 400;
      throw error;
    }

    const now = new Date().toISOString();
    const targetDb = databaseOrOpen();
    const sourceDb = new DatabaseSync(sourceDbPath, { readOnly: true });
    const upsert = shortVideoUpsertStatement(targetDb);
    const normalized = normalizedUpsertStatements(targetDb, coverCacheDir);
    const batchId = `download-manager:${hashText(`${sourceDbPath}:${now}`).slice(0, 24)}`;
    const profileColumns = new Set(sourceDb.prepare("PRAGMA table_info(profiles)").all().map((row) => row.name));
    const profileColumn = (column, alias = `profile_${column}`) => (
      profileColumns.has(column) ? `p.${column} AS ${alias}` : `NULL AS ${alias}`
    );
    const includePosts = Boolean(options.includePosts);
    const includeSummary = !options.skipSummary;
    const profileWhere = includePosts ? "p.tab IN ('like', 'post')" : "p.tab = 'like'";
    const incremental = Boolean(options.incremental);
    const backfillStatsLimit = incremental
      ? clampInt(options.backfillStatsLimit, DEFAULT_DOWNLOAD_MANAGER_STATS_BACKFILL_LIMIT, 0, 100000)
      : 0;
    const watermarkKey = "download_manager_downloaded_watermark";
    const statsBackfillWatermarkKey = "download_manager_stats_backfilled_watermark";
    const galleryImportVersionKey = "download_manager_gallery_import_version";
    const previousWatermark = incremental ? metaValue(targetDb, watermarkKey) : "";
    const previousStatsBackfillWatermark = incremental ? metaValue(targetDb, statsBackfillWatermarkKey) : "";
    const needsGalleryBackfill = metaValue(targetDb, galleryImportVersionKey) !== DOWNLOAD_MANAGER_GALLERY_IMPORT_VERSION;
    const sourceSelect = `
      SELECT
        l.*,
        p.tab AS profile_tab,
        p.sec_uid AS profile_sec_uid,
        p.url AS profile_url,
        ${profileColumn("uid")},
        ${profileColumn("nickname")},
        ${profileColumn("avatar_url")},
        ${profileColumn("unique_id")},
        ${profileColumn("short_id")},
        ${profileColumn("signature")},
        ${profileColumn("ip_location")},
        ${profileColumn("following_count")},
        ${profileColumn("follower_count")},
        ${profileColumn("total_favorited")},
        ${profileColumn("aweme_count")},
        ${profileColumn("favoriting_count")},
        ${profileColumn("gender")},
        ${profileColumn("age")},
        ${profileColumn("verification")},
        ${profileColumn("profile_collected_at")},
        ${profileColumn("profile_raw_json")}
      FROM links l
      JOIN profiles p ON p.id = l.profile_id
    `;
    const sourceHasStatsWhere = `(
      COALESCE(l.digg_count, 0) > 0 OR
      COALESCE(l.comment_count, 0) > 0 OR
      COALESCE(l.collect_count, 0) > 0 OR
      COALESCE(l.share_count, 0) > 0
    )`;
    const sourceMaxRow = sourceDb.prepare(`
      SELECT MAX(COALESCE(l.downloaded_at, '')) AS maxDownloadedAt
      FROM links l
      JOIN profiles p ON p.id = l.profile_id
      WHERE ${profileWhere}
        AND l.status = 'downloaded'
    `).get();
    const sourceMaxDownloadedAt = sourceMaxRow?.maxDownloadedAt || "";
    const sourceWhere = [profileWhere, "l.status = 'downloaded'"];
    const sourceArgs = [];
    if (incremental && previousWatermark) {
      sourceWhere.push("COALESCE(l.downloaded_at, '') > ?");
      sourceArgs.push(previousWatermark);
    }
    let sourceRows = sourceDb.prepare(`
      ${sourceSelect}
      WHERE ${sourceWhere.join(" AND ")}
      ORDER BY COALESCE(l.downloaded_at, ''), l.id ASC
    `).all(...sourceArgs);
    const incrementalRows = sourceRows.length;
    const galleryBackfillIds = needsGalleryBackfill
      ? sourceDb.prepare(`
          SELECT DISTINCT l.aweme_id
          FROM links l
          JOIN profiles p ON p.id = l.profile_id
          WHERE ${profileWhere}
            AND l.status = 'downloaded'
            AND COALESCE(l.aweme_id, '') <> ''
            AND (
              LOWER(COALESCE(l.kind, '')) = 'note' OR
              LOWER(COALESCE(l.media_type, '')) IN ('gallery', 'image', 'images')
            )
          ORDER BY l.aweme_id
        `).all().map((row) => String(row.aweme_id || "").trim()).filter(Boolean)
      : [];
    const galleryBackfillRow = needsGalleryBackfill
      ? sourceDb.prepare(`
          ${sourceSelect}
          WHERE ${profileWhere}
            AND l.status = 'downloaded'
            AND l.aweme_id = ?
          ORDER BY COALESCE(l.downloaded_at, '') DESC, l.id DESC
          LIMIT 1
        `)
      : null;
    let backfillCandidates = 0;
    let backfillRows = 0;

    const shouldBackfillStats = backfillStatsLimit > 0 && (options.forceStatsBackfill || !previousStatsBackfillWatermark);
    if (shouldBackfillStats) {
      const knownAwemeIds = new Set(sourceRows.map((row) => String(row.aweme_id || "").trim()).filter(Boolean));
      const idsNeedingStats = downloadManagerStatsBackfillIds(targetDb, backfillStatsLimit)
        .filter((id) => !knownAwemeIds.has(id));
      backfillCandidates = idsNeedingStats.length;
      const extraRows = [];
      for (const chunk of chunkArray(idsNeedingStats, DOWNLOAD_MANAGER_BACKFILL_CHUNK_SIZE)) {
        if (!chunk.length) continue;
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = sourceDb.prepare(`
          ${sourceSelect}
          WHERE ${profileWhere}
            AND l.status = 'downloaded'
            AND COALESCE(l.aweme_id, '') IN (${placeholders})
            AND ${sourceHasStatsWhere}
          ORDER BY COALESCE(l.downloaded_at, ''), l.id ASC
        `).all(...chunk);
        for (const row of rows) {
          const awemeId = String(row.aweme_id || "").trim();
          if (!awemeId || knownAwemeIds.has(awemeId)) continue;
          knownAwemeIds.add(awemeId);
          extraRows.push(row);
        }
      }
      backfillRows = extraRows.length;
      if (extraRows.length) sourceRows = sourceRows.concat(extraRows);
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let skippedNoPlayableVideo = 0;
    let skippedNotDownloaded = 0;
    let skippedDuplicate = 0;
    let galleryBackfillRows = 0;
    const seenIds = new Set();
    const importedIds = new Set();

    if (!sourceRows.length && !galleryBackfillIds.length) {
      try {
        if (sourceMaxDownloadedAt && sourceMaxDownloadedAt !== previousWatermark) {
          targetDb.prepare(`INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)`).run(watermarkKey, sourceMaxDownloadedAt);
        }
        if (shouldBackfillStats && sourceMaxDownloadedAt) {
          targetDb.prepare(`INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)`).run(statsBackfillWatermarkKey, sourceMaxDownloadedAt);
        }
        targetDb.prepare(`INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)`).run(
          galleryImportVersionKey,
          DOWNLOAD_MANAGER_GALLERY_IMPORT_VERSION
        );
        return {
          ok: true,
          sourceDbPath,
          batchId: "",
          incremental,
          sourceWatermark: sourceMaxDownloadedAt,
          scanned: 0,
          incrementalRows,
          backfillAttempted: shouldBackfillStats,
          backfillCandidates,
          backfillRows,
          galleryBackfill: needsGalleryBackfill,
          imported: 0,
          updated: 0,
          skipped: 0,
          skippedNotDownloaded: 0,
          skippedNoPlayableVideo: 0,
          skippedDuplicate: 0,
          totalImportedThisBatch: 0,
          importedAt: now,
          summary: includeSummary ? cachedSummary() : null
        };
      } finally {
        sourceDb.close();
      }
    }

    const importSourceRow = (row) => {
      if (row.status !== "downloaded") {
        skipped += 1;
        skippedNotDownloaded += 1;
        return;
      }
      const item = downloadManagerRowToItem(row);
      if (!item) {
        skipped += 1;
        skippedNoPlayableVideo += 1;
        return;
      }
      if (seenIds.has(item.id)) {
        skipped += 1;
        skippedDuplicate += 1;
        return;
      }
      seenIds.add(item.id);
      const existed = targetDb.prepare("SELECT 1 FROM short_videos WHERE id = ? LIMIT 1").get(item.id);
      upsert.run(...videoRowValues(item, now));
      upsertNormalizedItem(
        normalized,
        item,
        now,
        item.origin === "douyin_download_manager_like" ? { actionSource: "download_manager" } : {}
      );
      targetDb.prepare(`
        INSERT OR REPLACE INTO short_video_import_items (
          batch_id, video_id, source_path, data_path, imported_at
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(batchId, item.id, item.sourcePath || "", item.dataPath || "", now);
      pruneSourcePathDuplicates(targetDb, item);
      importedIds.add(item.id);
      if (existed) updated += 1;
      else imported += 1;
    };

    targetDb.exec("BEGIN");
    try {
      targetDb.prepare(`
        INSERT INTO short_video_import_batches (
          id, source_root, imported_count, started_at, finished_at, scanner_version
        )
        VALUES (?, ?, 0, ?, '', 'download-manager-v1')
      `).run(batchId, sourceDbPath, now);

      for (const row of sourceRows) importSourceRow(row);
      for (const awemeId of galleryBackfillIds) {
        const row = galleryBackfillRow?.get(awemeId);
        if (!row) continue;
        galleryBackfillRows += 1;
        importSourceRow(row);
      }

      targetDb.prepare("UPDATE short_video_import_batches SET imported_count = ?, finished_at = ? WHERE id = ?")
        .run(importedIds.size, new Date().toISOString(), batchId);
      targetDb.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_imported_at', ?)").run(now);
      targetDb.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_db_path', ?)").run(sourceDbPath);
      if (sourceMaxDownloadedAt) {
        targetDb.prepare(`INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)`).run(watermarkKey, sourceMaxDownloadedAt);
        if (shouldBackfillStats) {
          targetDb.prepare(`INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)`).run(statsBackfillWatermarkKey, sourceMaxDownloadedAt);
        }
      }
      targetDb.prepare(`INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)`).run(
        galleryImportVersionKey,
        DOWNLOAD_MANAGER_GALLERY_IMPORT_VERSION
      );
      targetDb.exec("COMMIT");
    } catch (error) {
      try {
        targetDb.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      sourceDb.close();
    }

    return {
      ok: true,
      sourceDbPath,
      batchId,
      incremental,
      sourceWatermark: sourceMaxDownloadedAt,
      scanned: sourceRows.length + galleryBackfillRows,
      incrementalRows,
      backfillAttempted: shouldBackfillStats,
      backfillCandidates,
      backfillRows,
      galleryBackfill: needsGalleryBackfill,
      galleryBackfillRows,
      imported,
      updated,
      skipped,
      skippedNotDownloaded,
      skippedNoPlayableVideo,
      skippedDuplicate,
      totalImportedThisBatch: importedIds.size,
      importedAt: now,
      summary: includeSummary ? summary() : null
    };
  }

  function databaseOrOpen() {
    return database();
  }

  return {
    adjacentVideo,
    backfillMissingCovers,
    backfillMissingCoversAsync,
    close,
    coverBackfillStatus,
    coverFile,
    dbPath,
    deleteVideo,
    deleteVideoGroup,
    deleteVideos,
    facets,
    galleryFile,
    importDownloadManagerDb,
    listVideos,
    localComments,
    createLocalComment,
    deleteLocalComment,
    musicFile,
    relatedVideos,
    recordWatch,
    roots,
    scan,
    searchSuggestions,
    setAuthorFollow,
    setUserAction,
    summary: cachedSummary,
    videoDetail,
    videoFile
  };
}

function publicLocalComment(row = {}) {
  return {
    id: String(row.id || ""),
    body: String(row.body || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || row.created_at || "")
  };
}

function normalizeLocalCommentBody(value) {
  return Array.from(String(value || "").trim()).slice(0, 500).join("");
}

function ensureSchema(db, coverCacheDir = "") {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS short_video_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS short_videos (
      id TEXT PRIMARY KEY,
      aweme_id TEXT,
      author_sec_uid TEXT NOT NULL DEFAULT '',
      author_uid TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      author_avatar_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      tags_text TEXT NOT NULL DEFAULT '',
      create_time INTEGER,
      published_at TEXT NOT NULL DEFAULT '',
      liked_at TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      width INTEGER,
      height INTEGER,
      digg_count INTEGER,
      comment_count INTEGER,
      collect_count INTEGER,
      share_count INTEGER,
      play_count INTEGER,
      share_url TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      source_path TEXT NOT NULL,
      cover_path TEXT NOT NULL DEFAULT '',
      cover_source TEXT NOT NULL DEFAULT '',
      music_path TEXT NOT NULL DEFAULT '',
      data_path TEXT NOT NULL DEFAULT '',
      relative_path TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_short_videos_author ON short_videos(author_sec_uid);
    CREATE INDEX IF NOT EXISTS idx_short_videos_liked ON short_videos(liked_at);
    CREATE INDEX IF NOT EXISTS idx_short_videos_published ON short_videos(published_at);
    CREATE INDEX IF NOT EXISTS idx_short_videos_digg ON short_videos(digg_count);
    CREATE INDEX IF NOT EXISTS idx_short_videos_aweme ON short_videos(aweme_id);
    CREATE INDEX IF NOT EXISTS idx_short_videos_source_path ON short_videos(source_path);
    CREATE TABLE IF NOT EXISTS short_video_users (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'douyin',
      sec_uid TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT '未知作者',
      avatar_url TEXT NOT NULL DEFAULT '',
      profile_url TEXT NOT NULL DEFAULT '',
      unique_id TEXT NOT NULL DEFAULT '',
      short_id TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      ip_location TEXT NOT NULL DEFAULT '',
      follower_count INTEGER,
      following_count INTEGER,
      total_favorited INTEGER,
      aweme_count INTEGER,
      favoriting_count INTEGER,
      gender INTEGER,
      age INTEGER,
      verification TEXT NOT NULL DEFAULT '',
      profile_collected_at TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_short_video_users_platform_sec_uid
      ON short_video_users(platform, sec_uid)
      WHERE sec_uid <> '';
    CREATE INDEX IF NOT EXISTS idx_short_video_users_nickname ON short_video_users(nickname);
    CREATE TABLE IF NOT EXISTS short_video_assets (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      local_path TEXT NOT NULL DEFAULT '',
      remote_url TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      file_hash TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT NOT NULL DEFAULT '',
      codec TEXT NOT NULL DEFAULT '',
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      UNIQUE(video_id, asset_type)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_assets_video ON short_video_assets(video_id);
    CREATE INDEX IF NOT EXISTS idx_short_video_assets_type ON short_video_assets(asset_type);
    CREATE TABLE IF NOT EXISTS short_video_stats (
      video_id TEXT PRIMARY KEY,
      digg_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      collect_count INTEGER NOT NULL DEFAULT 0,
      share_count INTEGER NOT NULL DEFAULT 0,
      play_count INTEGER NOT NULL DEFAULT 0,
      snapshot_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS short_video_user_actions (
      local_user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT '',
      acted_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(local_user_id, video_id, action_type)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_actions_video ON short_video_user_actions(video_id, action_type, active);
    CREATE INDEX IF NOT EXISTS idx_short_video_actions_user ON short_video_user_actions(local_user_id, action_type, active, acted_at);
    CREATE TABLE IF NOT EXISTS short_video_collections (
      id TEXT PRIMARY KEY,
      local_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS short_video_collection_items (
      collection_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(collection_id, video_id)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_collection_items_video ON short_video_collection_items(video_id);
    CREATE TABLE IF NOT EXISTS short_video_follows (
      local_user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      followed_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(local_user_id, target_user_id)
    );
    CREATE TABLE IF NOT EXISTS short_video_watch_history (
      local_user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      progress_ms INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      last_watched_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(local_user_id, video_id)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_watch_history_recent ON short_video_watch_history(local_user_id, last_watched_at);
    CREATE TABLE IF NOT EXISTS short_video_local_comments (
      id TEXT PRIMARY KEY,
      local_user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_local_comments_video
      ON short_video_local_comments(local_user_id, video_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS short_video_import_batches (
      id TEXT PRIMARY KEY,
      source_root TEXT NOT NULL DEFAULT '',
      imported_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      scanner_version TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS short_video_import_items (
      batch_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      data_path TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(batch_id, video_id)
    );
  `);
  ensureShortVideoColumns(db);
  recreateShortVideoCatalogView(db);
  migrateNormalizedShortVideoData(db, coverCacheDir);
}

function ensureShortVideoColumns(db) {
  addColumnIfMissing(db, "short_videos", "owner_user_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_videos", "origin", "TEXT NOT NULL DEFAULT 'douyin_like_import'");
  addColumnIfMissing(db, "short_videos", "status", "TEXT NOT NULL DEFAULT 'normal'");
  addColumnIfMissing(db, "short_videos", "visibility", "TEXT NOT NULL DEFAULT 'local_only'");
  addColumnIfMissing(db, "short_videos", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "short_videos", "cover_source", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "profile_url", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "unique_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "short_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "ip_location", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "total_favorited", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "aweme_count", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "favoriting_count", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "gender", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "age", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "verification", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "profile_collected_at", "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_short_videos_owner ON short_videos(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_short_videos_origin ON short_videos(origin);
    CREATE INDEX IF NOT EXISTS idx_short_video_users_unique_id ON short_video_users(unique_id);
  `);
  backfillShortVideoShareUrls(db);
  migrateShortVideoCoverSources(db);
  ensureShortVideoTopics(db);
  ensureShortVideoSounds(db);
}

function ensureShortVideoTopics(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS short_video_topics (
      video_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      topic_key TEXT NOT NULL,
      PRIMARY KEY (video_id, topic_key)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_topics_key ON short_video_topics(topic_key, video_id);
    CREATE INDEX IF NOT EXISTS idx_short_video_topics_video ON short_video_topics(video_id);

    CREATE TRIGGER IF NOT EXISTS trg_short_video_topics_insert
    AFTER INSERT ON short_videos
    BEGIN
      INSERT OR REPLACE INTO short_video_topics (video_id, topic, topic_key)
      SELECT
        NEW.id,
        TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')),
        LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')))
      FROM json_each(CASE WHEN json_valid(NEW.tags_json) THEN NEW.tags_json ELSE '[]' END) AS topic_tag
      WHERE LENGTH(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#'))) BETWEEN 1 AND 48;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_short_video_topics_update
    AFTER UPDATE OF tags_json ON short_videos
    BEGIN
      DELETE FROM short_video_topics WHERE video_id = NEW.id;
      INSERT OR REPLACE INTO short_video_topics (video_id, topic, topic_key)
      SELECT
        NEW.id,
        TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')),
        LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')))
      FROM json_each(CASE WHEN json_valid(NEW.tags_json) THEN NEW.tags_json ELSE '[]' END) AS topic_tag
      WHERE LENGTH(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#'))) BETWEEN 1 AND 48;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_short_video_topics_delete
    AFTER DELETE ON short_videos
    BEGIN
      DELETE FROM short_video_topics WHERE video_id = OLD.id;
    END;
  `);
  if (metaValue(db, "short_video_topic_index_version") === SHORT_VIDEO_TOPIC_INDEX_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM short_video_topics;
      INSERT OR REPLACE INTO short_video_topics (video_id, topic, topic_key)
      SELECT
        v.id,
        TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')),
        LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')))
      FROM short_videos v
      JOIN json_each(CASE WHEN json_valid(v.tags_json) THEN v.tags_json ELSE '[]' END) AS topic_tag
      WHERE LENGTH(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#'))) BETWEEN 1 AND 48;
      INSERT OR REPLACE INTO short_video_meta (key, value)
      VALUES ('short_video_topic_index_version', '${SHORT_VIDEO_TOPIC_INDEX_VERSION}');
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function ensureShortVideoSounds(db) {
  const insertNew = shortVideoSoundIndexSelect("NEW");
  db.exec(`
    CREATE TABLE IF NOT EXISTS short_video_sounds (
      video_id TEXT PRIMARY KEY,
      sound_key TEXT NOT NULL,
      sound_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      cover_url TEXT NOT NULL DEFAULT '',
      preview_url TEXT NOT NULL DEFAULT '',
      local_available INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_sounds_key ON short_video_sounds(sound_key, video_id);

    CREATE TRIGGER IF NOT EXISTS trg_short_video_sounds_insert
    AFTER INSERT ON short_videos
    BEGIN
      INSERT OR REPLACE INTO short_video_sounds (
        video_id, sound_key, sound_id, title, author, cover_url, preview_url, local_available
      )
      ${insertNew};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_short_video_sounds_update
    AFTER UPDATE OF metadata_json, music_path, author_name ON short_videos
    BEGIN
      DELETE FROM short_video_sounds WHERE video_id = NEW.id;
      INSERT OR REPLACE INTO short_video_sounds (
        video_id, sound_key, sound_id, title, author, cover_url, preview_url, local_available
      )
      ${insertNew};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_short_video_sounds_delete
    AFTER DELETE ON short_videos
    BEGIN
      DELETE FROM short_video_sounds WHERE video_id = OLD.id;
    END;
  `);
  if (metaValue(db, "short_video_sound_index_version") === SHORT_VIDEO_SOUND_INDEX_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM short_video_sounds;
      INSERT OR REPLACE INTO short_video_sounds (
        video_id, sound_key, sound_id, title, author, cover_url, preview_url, local_available
      )
      ${shortVideoSoundIndexSelect("v", "FROM short_videos v")};
      INSERT OR REPLACE INTO short_video_meta (key, value)
      VALUES ('short_video_sound_index_version', '${SHORT_VIDEO_SOUND_INDEX_VERSION}');
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function shortVideoSoundIndexSelect(rowReference, fromClause = "") {
  const row = String(rowReference || "v");
  return `
    SELECT
      indexed.video_id,
      indexed.sound_key,
      indexed.sound_id,
      indexed.title,
      indexed.author,
      indexed.cover_url,
      indexed.preview_url,
      indexed.local_available
    FROM (
      SELECT
        source.*,
        CASE
          WHEN source.title <> ''
            AND source.author <> ''
            AND source.is_original_sound = 0
            AND source.title NOT LIKE '%创作的原声%'
            AND LOWER(source.title) <> '模板音乐'
            THEN 'track:' || LOWER(source.title) || CHAR(31) || LOWER(source.author)
          WHEN source.sound_id <> '' THEN 'id:' || source.sound_id
          WHEN source.local_available = 1 THEN 'local:' || source.video_id
          ELSE ''
        END AS sound_key
      FROM (
        SELECT
          ${row}.id AS video_id,
          TRIM(COALESCE(
            CAST(json_extract(${row}.metadata_json, '$.music.id_str') AS TEXT),
            CAST(json_extract(${row}.metadata_json, '$.music.mid') AS TEXT),
            ''
          )) AS sound_id,
          TRIM(COALESCE(CAST(json_extract(${row}.metadata_json, '$.music.title') AS TEXT), '')) AS title,
          TRIM(COALESCE(CAST(json_extract(${row}.metadata_json, '$.music.author') AS TEXT), '')) AS author,
          TRIM(COALESCE(
            CAST(json_extract(${row}.metadata_json, '$.music.cover_medium.url_list[0]') AS TEXT),
            CAST(json_extract(${row}.metadata_json, '$.music.cover_thumb.url_list[0]') AS TEXT),
            ''
          )) AS cover_url,
          TRIM(COALESCE(
            CAST(json_extract(${row}.metadata_json, '$.music.play_url.url_list[0]') AS TEXT),
            CAST(json_extract(${row}.metadata_json, '$.music.play_url.uri') AS TEXT),
            ''
          )) AS preview_url,
          CASE WHEN COALESCE(TRIM(${row}.music_path), '') <> '' THEN 1 ELSE 0 END AS local_available,
          CASE WHEN COALESCE(CAST(json_extract(${row}.metadata_json, '$.music.is_original_sound') AS INTEGER), 0) = 1 THEN 1 ELSE 0 END AS is_original_sound
        ${fromClause}
      ) AS source
    ) AS indexed
    WHERE indexed.sound_key <> ''
  `;
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (columns.has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillShortVideoShareUrls(db) {
  db.prepare(`
    UPDATE short_videos
    SET share_url = 'https://www.douyin.com/video/' || TRIM(aweme_id),
        updated_at = ?
    WHERE COALESCE(TRIM(share_url), '') = ''
      AND COALESCE(TRIM(aweme_id), '') <> ''
      AND TRIM(aweme_id) NOT GLOB '*[^0-9]*'
      AND LENGTH(TRIM(aweme_id)) >= 8
  `).run(new Date().toISOString());
}

function migrateShortVideoCoverSources(db) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE short_videos
    SET cover_source = CASE
          WHEN cover_path LIKE '%short-video-covers%' THEN 'ffmpeg'
          WHEN COALESCE(TRIM(cover_path), '') <> '' THEN 'native'
          ELSE ''
        END,
        updated_at = CASE WHEN COALESCE(updated_at, '') = '' THEN ? ELSE updated_at END
    WHERE COALESCE(TRIM(cover_source), '') = ''
  `).run(now);

  db.prepare(`
    UPDATE short_video_assets
    SET asset_type = CASE
          WHEN local_path LIKE '%short-video-covers%' THEN 'ffmpeg_cover'
          ELSE 'native_cover'
        END,
        id = video_id || ':' || CASE
          WHEN local_path LIKE '%short-video-covers%' THEN 'ffmpeg_cover'
          ELSE 'native_cover'
        END,
        updated_at = CASE WHEN COALESCE(updated_at, '') = '' THEN ? ELSE updated_at END
    WHERE asset_type = 'cover'
  `).run(now);
}

function recreateShortVideoCatalogView(db) {
  const recommendationScoreSql = SHORT_VIDEO_RECOMMENDATION_SCORE_SQL;
  db.exec(`
    DROP VIEW IF EXISTS short_video_catalog;
    DROP VIEW IF EXISTS short_video_catalog_base;
    CREATE VIEW short_video_catalog_base AS
    SELECT
      v.id,
      v.aweme_id,
      v.owner_user_id,
      v.origin,
      v.status,
      v.visibility,
      ${SHORT_VIDEO_MEDIA_TYPE_SQL} AS media_type,
      COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) AS author_sec_uid,
      COALESCE(NULLIF(u.uid, ''), v.author_uid) AS author_uid,
      COALESCE(NULLIF(u.nickname, ''), v.author_name, '未知作者') AS author_name,
      COALESCE(NULLIF(u.avatar_url, ''), v.author_avatar_url) AS author_avatar_url,
      COALESCE(NULLIF(u.profile_url, ''), CASE WHEN COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) <> '' THEN 'https://www.douyin.com/user/' || COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) ELSE '' END) AS author_profile_url,
      COALESCE(NULLIF(u.unique_id, ''), '') AS author_unique_id,
      COALESCE(NULLIF(u.short_id, ''), '') AS author_short_id,
      COALESCE(NULLIF(u.signature, ''), '') AS author_signature,
      COALESCE(NULLIF(u.ip_location, ''), '') AS author_ip_location,
      u.follower_count AS author_follower_count,
      u.following_count AS author_following_count,
      u.total_favorited AS author_total_favorited,
      u.aweme_count AS author_aweme_count,
      u.favoriting_count AS author_favoriting_count,
      u.gender AS author_gender,
      u.age AS author_age,
      COALESCE(NULLIF(u.verification, ''), '') AS author_verification,
      COALESCE(NULLIF(u.profile_collected_at, ''), '') AS author_profile_collected_at,
      COALESCE(user_follow.active, 0) AS author_following,
      v.title,
      v.description,
      v.tags_json,
      v.tags_text,
      v.create_time,
      v.published_at,
      v.liked_at,
      v.duration_ms,
      v.width,
      v.height,
      COALESCE(s.digg_count, v.digg_count, 0) AS digg_count,
      COALESCE(s.comment_count, v.comment_count, 0) AS comment_count,
      COALESCE(s.collect_count, v.collect_count, 0) AS collect_count,
      COALESCE(s.share_count, v.share_count, 0) AS share_count,
      COALESCE(s.play_count, v.play_count, 0) AS play_count,
      COALESCE(user_like.active, 0) AS user_like_active,
      COALESCE(user_like.source, '') AS user_like_source,
      COALESCE(user_collect.active, 0) AS user_collect_active,
      COALESCE(user_collect.source, '') AS user_collect_source,
      COALESCE(user_dislike.active, 0) AS user_dislike_active,
      COALESCE(user_dislike.source, '') AS user_dislike_source,
      ${recommendationScoreSql} AS recommendation_score,
      COALESCE(watch_history.progress_ms, 0) AS watch_progress_ms,
      COALESCE(watch_history.completed_count, 0) AS watch_completed_count,
      COALESCE(watch_history.last_watched_at, '') AS last_watched_at,
      v.share_url,
      v.metadata_json,
      COALESCE(sound_index.sound_key, '') AS sound_key,
      COALESCE(sound_index.sound_id, '') AS sound_id,
      COALESCE(sound_index.title, '') AS sound_title,
      COALESCE(sound_index.author, '') AS sound_author,
      COALESCE(sound_index.cover_url, '') AS sound_cover_url,
      COALESCE(sound_index.preview_url, '') AS sound_preview_url,
      COALESCE(sound_index.local_available, 0) AS sound_local_available,
      COALESCE(NULLIF(video_asset.local_path, ''), v.source_path) AS source_path,
      COALESCE(
        NULLIF(native_cover_asset.local_path, ''),
        CASE WHEN v.cover_source = 'native' THEN NULLIF(v.cover_path, '') ELSE NULL END,
        NULLIF(ffmpeg_cover_asset.local_path, ''),
        CASE WHEN v.cover_source = 'ffmpeg' THEN NULLIF(v.cover_path, '') ELSE NULL END,
        NULLIF(legacy_cover_asset.local_path, ''),
        NULLIF(v.cover_path, '')
      ) AS cover_path,
      CASE
        WHEN NULLIF(native_cover_asset.local_path, '') IS NOT NULL
          OR (v.cover_source = 'native' AND NULLIF(v.cover_path, '') IS NOT NULL)
          THEN 'native'
        WHEN NULLIF(ffmpeg_cover_asset.local_path, '') IS NOT NULL
          OR (v.cover_source = 'ffmpeg' AND NULLIF(v.cover_path, '') IS NOT NULL)
          THEN 'ffmpeg'
        WHEN NULLIF(legacy_cover_asset.local_path, '') IS NOT NULL
          THEN CASE WHEN legacy_cover_asset.local_path LIKE '%short-video-covers%' THEN 'ffmpeg' ELSE 'native' END
        ELSE COALESCE(NULLIF(v.cover_source, ''), '')
      END AS cover_source,
      COALESCE(NULLIF(music_asset.local_path, ''), v.music_path) AS music_path,
      v.data_path,
      v.relative_path,
      COALESCE(NULLIF(video_asset.file_name, ''), v.file_name) AS file_name,
      COALESCE(NULLIF(video_asset.size_bytes, 0), v.size_bytes, 0) AS size_bytes,
      COALESCE(NULLIF(video_asset.mtime_ms, 0), v.mtime_ms, 0) AS mtime_ms,
      v.imported_at,
      v.updated_at
    FROM short_videos v
    LEFT JOIN short_video_users u ON u.id = v.owner_user_id
    LEFT JOIN short_video_stats s ON s.video_id = v.id
    LEFT JOIN short_video_user_actions user_like
      ON user_like.video_id = v.id
     AND user_like.local_user_id = 'local:self'
     AND user_like.action_type = 'like'
    LEFT JOIN short_video_user_actions user_collect
      ON user_collect.video_id = v.id
     AND user_collect.local_user_id = 'local:self'
     AND user_collect.action_type = 'collect'
    LEFT JOIN short_video_user_actions user_dislike
      ON user_dislike.video_id = v.id
     AND user_dislike.local_user_id = 'local:self'
     AND user_dislike.action_type = 'dislike'
    LEFT JOIN short_video_follows user_follow
      ON user_follow.target_user_id = v.owner_user_id
     AND user_follow.local_user_id = 'local:self'
    LEFT JOIN short_video_watch_history watch_history
      ON watch_history.video_id = v.id
     AND watch_history.local_user_id = 'local:self'
    LEFT JOIN short_video_assets video_asset ON video_asset.video_id = v.id AND video_asset.asset_type = 'video'
    LEFT JOIN short_video_assets native_cover_asset ON native_cover_asset.video_id = v.id AND native_cover_asset.asset_type = 'native_cover'
    LEFT JOIN short_video_assets ffmpeg_cover_asset ON ffmpeg_cover_asset.video_id = v.id AND ffmpeg_cover_asset.asset_type = 'ffmpeg_cover'
    LEFT JOIN short_video_assets legacy_cover_asset ON legacy_cover_asset.video_id = v.id AND legacy_cover_asset.asset_type = 'cover'
    LEFT JOIN short_video_assets music_asset ON music_asset.video_id = v.id AND music_asset.asset_type = 'music'
    LEFT JOIN short_video_sounds sound_index ON sound_index.video_id = v.id;

    CREATE VIEW short_video_catalog AS
    SELECT
      short_video_catalog_base.*,
      1 AS recommendation_author_rank,
      recommendation_score AS recommendation_order_score
    FROM short_video_catalog_base;
  `);
}

function migrateNormalizedShortVideoData(db, coverCacheDir = "") {
  if (metaValue(db, "normalized_schema_version") === NORMALIZED_SCHEMA_VERSION) return;
  const rows = db.prepare("SELECT * FROM short_videos").all();
  const now = new Date().toISOString();
  const normalized = normalizedUpsertStatements(db, coverCacheDir);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      upsertNormalizedItem(normalized, legacyRowToItem(row), row.updated_at || now, { actionSource: "imported" });
    }
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('normalized_schema_version', ?)").run(NORMALIZED_SCHEMA_VERSION);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function cleanupSupersededFfmpegCovers(db, coverCacheDir = "") {
  try {
    const rows = db.prepare(`
      SELECT f.video_id, f.local_path, n.local_path AS native_path
      FROM short_video_assets f
      JOIN short_video_assets n
        ON n.video_id = f.video_id
       AND n.asset_type = 'native_cover'
       AND COALESCE(TRIM(n.local_path), '') <> ''
      WHERE f.asset_type = 'ffmpeg_cover'
    `).all();
    if (!rows.length) return;

    db.exec("BEGIN");
    try {
      for (const row of rows) {
        db.prepare(`
          UPDATE short_videos
          SET cover_path = ?,
              cover_source = 'native',
              updated_at = ?
          WHERE id = ?
            AND (
              cover_source = 'ffmpeg'
              OR COALESCE(TRIM(cover_path), '') = ''
              OR cover_path = ?
            )
        `).run(row.native_path || "", new Date().toISOString(), row.video_id, row.local_path || "");
        db.prepare("DELETE FROM short_video_assets WHERE video_id = ? AND asset_type = 'ffmpeg_cover'").run(row.video_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    for (const row of rows) removeGeneratedCoverFile(row.local_path, coverCacheDir);
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('cover_cleanup_at', ?)").run(new Date().toISOString());
  } catch (error) {
    console.warn("[short-video-cover-cleanup]", error.message || error);
  }
}

function removeGeneratedCoverFile(filePath, coverCacheDir = "") {
  const rawPath = String(filePath || "").trim();
  if (!rawPath || !coverCacheDir) return;
  const resolvedPath = path.resolve(rawPath);
  const resolvedCacheDir = path.resolve(coverCacheDir);
  if (!resolvedPath.startsWith(`${resolvedCacheDir}${path.sep}`)) return;
  try {
    fs.rmSync(resolvedPath, { force: true });
  } catch {}
}

function parseVideoFile(root, filePath) {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) return null;
  const dir = path.dirname(filePath);
  const author = parseAuthorFolder(root, filePath);
  const files = safeReadDir(dir);
  const dataPath = findCompanion(files, dir, filePath, ".json", (name) => /_data\.json$/i.test(name)) || "";
  const data = readVideoJson(dataPath);
  const parentInfo = parseVideoName(path.basename(dir));
  const fileInfo = parseVideoName(path.basename(filePath, path.extname(filePath)));
  const awemeId = String(data?.aweme_id || parentInfo.awemeId || fileInfo.awemeId || "").trim();
  const id = awemeId || `local-${hashText(path.resolve(filePath)).slice(0, 18)}`;
  const description = String(data?.desc || parentInfo.title || fileInfo.title || path.basename(filePath, path.extname(filePath))).trim();
  const title = description || awemeId || path.basename(filePath, path.extname(filePath));
  const tags = tagsFromText(description);
  const coverPath = findCover(files, dir, filePath, data);
  const musicPath = findCompanion(files, dir, filePath, "", (name) => AUDIO_EXTS.has(path.extname(name).toLowerCase())) || "";
  const createTime = Number(data?.create_time || 0) || null;
  const publishedAt = isoFromCreateTime(createTime) || dateOnlyIso(parentInfo.date || fileInfo.date) || "";
  const likedAt = new Date(stat.mtimeMs || Date.now()).toISOString();
  const video = data?.video || {};
  const statistics = data?.statistics || {};
  const authorData = data?.author || {};
  const finalAuthor = {
    secUid: String(authorData.sec_uid || author.secUid || "").trim(),
    uid: String(authorData.uid || "").trim(),
    name: String(authorData.nickname || author.name || "").trim() || "未知作者",
    avatarUrl: firstUrl(authorData.avatar_thumb)
  };
  return {
    id,
    awemeId,
    author: finalAuthor,
    title,
    description,
    tags,
    createTime,
    publishedAt,
    likedAt,
    durationMs: Number(data?.duration || video.duration || 0) || null,
    width: Number(video.width || video.play_addr?.width || 0) || null,
    height: Number(video.height || video.play_addr?.height || 0) || null,
    diggCount: Number(statistics.digg_count || 0) || 0,
    commentCount: Number(statistics.comment_count || 0) || 0,
    collectCount: Number(statistics.collect_count || 0) || 0,
    shareCount: Number(statistics.share_count || 0) || 0,
    playCount: Number(statistics.play_count || 0) || 0,
    shareUrl: normalizedDouyinShareUrl(data?.share_url, awemeId),
    sourcePath: path.resolve(filePath),
    coverPath,
    coverSource: coverPath ? "native" : "",
    musicPath,
    dataPath,
    relativePath: path.relative(root, filePath),
    fileName: path.basename(filePath),
    sizeBytes: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs || 0)
  };
}

function downloadManagerRowToItem(row) {
  const outputDir = String(row.output_dir || "").trim() ? path.resolve(String(row.output_dir).trim()) : "";
  const localPaths = parseDownloadManagerPaths(row.local_file_paths)
    .map((filePath) => resolveDownloadManagerPath(outputDir, filePath));
  const galleryPaths = isDownloadManagerGallery(row)
    ? localPaths.filter((filePath) => IMAGE_EXTS.has(path.extname(filePath).toLowerCase()) && safeStat(filePath)?.isFile())
    : [];
  const mediaType = galleryPaths.length ? "gallery" : "video";
  const sourcePath = mediaType === "gallery"
    ? galleryPaths[0]
    : firstExistingDownloadManagerPath(localPaths, VIDEO_EXTS);
  if (!sourcePath) return null;

  const stat = safeStat(sourcePath);
  if (!stat?.isFile()) return null;
  const dataPath = firstExistingDownloadManagerPath(localPaths, new Set([".json"]));
  const data = readVideoJson(dataPath) || parseJsonObject(row.metadata_json);
  const rawMetadata = rawAwemeMetadata(data);
  const rawProfile = parseJsonObject(row.profile_raw_json);
  const video = data?.video || {};
  const statistics = rawMetadata?.statistics || data?.statistics || {};
  const authorData = rawMetadata?.author || data?.author || {};
  const awemeId = String(row.aweme_id || data?.aweme_id || "").trim();
  const id = awemeId || `local-${hashText(sourcePath).slice(0, 18)}`;
  const description = String(row.desc || data?.desc || path.basename(sourcePath, path.extname(sourcePath))).trim();
  const title = description.split(/\r?\n/)[0]?.trim() || awemeId || path.basename(sourcePath, path.extname(sourcePath));
  const tags = mergeTags(Array.isArray(data?.tags) ? data.tags : [], tagsFromText(description));
  const createTime = Number(row.create_time || data?.create_time || data?.publish_timestamp || 0) || null;
  const likedAt = normalizeIsoDate(row.discovered_at || row.last_seen_at || row.downloaded_at || data?.recorded_at)
    || new Date(stat.mtimeMs || Date.now()).toISOString();
  const publishedAt = isoFromCreateTime(createTime) || dateOnlyIso(data?.date) || "";
  const coverPath = mediaType === "gallery"
    ? galleryPaths[0]
    : downloadManagerCoverPath(row, localPaths, sourcePath, outputDir);
  const musicPath = firstExistingDownloadManagerPath(localPaths, AUDIO_EXTS);
  const durationMs = mediaType === "gallery" ? null : (Number(row.duration_ms || data?.duration || video.duration || 0) || null);
  const galleryStats = galleryPaths.map((filePath) => safeStat(filePath)).filter(Boolean);
  const mediaSizeBytes = mediaType === "gallery"
    ? galleryStats.reduce((sum, item) => sum + Number(item.size || 0), 0)
    : stat.size;
  const mediaMtimeMs = mediaType === "gallery"
    ? Math.max(0, ...galleryStats.map((item) => Math.floor(item.mtimeMs || 0)))
    : Math.floor(stat.mtimeMs || 0);
  const mediaMetadata = {
    ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
    fanhaoMedia: {
      type: mediaType,
      galleryCount: galleryPaths.length
    }
  };

  const authorSecUid = String(row.author_sec_uid || data?.author_sec_uid || authorData.sec_uid || row.profile_sec_uid || rawProfile.sec_uid || "").trim();
  const authorProfileUrl = normalizedDouyinUserUrl(row.author_url || data?.author_url, authorSecUid);
  return {
    id,
    awemeId,
    author: {
      secUid: authorSecUid,
      uid: String(row.author_uid || authorData.uid || row.profile_uid || rawProfile.uid || "").trim(),
      name: String(row.author_nickname || authorData.nickname || data?.author_name || row.profile_nickname || rawProfile.nickname || "").trim() || "未知作者",
      avatarUrl: firstUrlAny(row.author_avatar_url, data?.author_avatar_url, authorData.avatar_thumb, authorData.avatar_medium, authorData.avatar_larger, row.profile_avatar_url, rawProfile.avatar_url),
      profileUrl: authorProfileUrl,
      uniqueId: String(row.profile_unique_id || authorData.unique_id || authorData.uniqueId || rawProfile.unique_id || "").trim(),
      shortId: String(row.profile_short_id || authorData.short_id || authorData.shortId || rawProfile.short_id || "").trim(),
      signature: String(row.profile_signature || authorData.signature || rawProfile.signature || "").trim(),
      ipLocation: String(row.profile_ip_location || authorData.ip_location || authorData.ipLocation || rawProfile.ip_location || "").trim(),
      followerCount: optionalInteger(row.profile_follower_count ?? authorData.follower_count ?? authorData.followerCount ?? rawProfile.follower_count),
      followingCount: optionalInteger(row.profile_following_count ?? authorData.following_count ?? authorData.followingCount ?? rawProfile.following_count),
      totalFavorited: optionalInteger(row.profile_total_favorited ?? authorData.total_favorited ?? authorData.totalFavorited ?? rawProfile.total_favorited),
      awemeCount: optionalInteger(row.profile_aweme_count ?? authorData.aweme_count ?? authorData.awemeCount ?? rawProfile.aweme_count),
      favoritingCount: optionalInteger(row.profile_favoriting_count ?? authorData.favoriting_count ?? authorData.favoritingCount ?? rawProfile.favoriting_count),
      gender: optionalInteger(row.profile_gender ?? authorData.gender ?? rawProfile.gender),
      age: optionalInteger(row.profile_age ?? authorData.age ?? rawProfile.age),
      verification: String(row.profile_verification || authorData.custom_verify || authorData.customVerify || rawProfile.verification || "").trim(),
      profileCollectedAt: String(row.profile_collected_at || rawProfile.profile_collected_at || "").trim(),
      rawJson: JSON.stringify({
        profileUrl: authorProfileUrl,
        sourceProfileUrl: row.profile_url || "",
        profile: rawProfile || {},
        metadata: rawMetadata || data || {}
      })
    },
    title,
    description,
    tags,
    createTime,
    publishedAt,
    likedAt,
    mediaType,
    galleryPaths,
    durationMs,
    width: Number(video.width || video.play_addr?.width || 0) || null,
    height: Number(video.height || video.play_addr?.height || 0) || null,
    diggCount: Number(row.digg_count ?? statistics.digg_count ?? 0) || 0,
    commentCount: Number(row.comment_count ?? statistics.comment_count ?? 0) || 0,
    collectCount: Number(row.collect_count ?? statistics.collect_count ?? 0) || 0,
    shareCount: Number(row.share_count ?? statistics.share_count ?? 0) || 0,
    playCount: Number(statistics.play_count || 0) || 0,
    shareUrl: normalizedDouyinShareUrl(row.url || data?.share_url, awemeId),
    metadataJson: JSON.stringify(mediaMetadata),
    sourcePath,
    coverPath,
    coverSource: coverPath ? "native" : "",
    musicPath,
    dataPath,
    relativePath: outputDir ? path.relative(outputDir, sourcePath) : sourcePath,
    fileName: path.basename(sourcePath),
    sizeBytes: mediaSizeBytes,
    mtimeMs: mediaMtimeMs,
    origin: row.profile_tab === "post" ? "douyin_download_manager_post" : "douyin_download_manager_like"
  };
}

function shortVideoUpsertStatement(db) {
  return db.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, author_sec_uid, author_uid, author_name, author_avatar_url,
      title, description, tags_json, tags_text, create_time, published_at, liked_at,
      duration_ms, width, height, digg_count, comment_count, collect_count,
      share_count, play_count, share_url, metadata_json, source_path, cover_path, cover_source, music_path,
      data_path, relative_path, file_name, size_bytes, mtime_ms, imported_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      aweme_id = excluded.aweme_id,
      author_sec_uid = excluded.author_sec_uid,
      author_uid = excluded.author_uid,
      author_name = excluded.author_name,
      author_avatar_url = excluded.author_avatar_url,
      title = excluded.title,
      description = excluded.description,
      tags_json = excluded.tags_json,
      tags_text = excluded.tags_text,
      create_time = excluded.create_time,
      published_at = excluded.published_at,
      liked_at = excluded.liked_at,
      duration_ms = excluded.duration_ms,
      width = excluded.width,
      height = excluded.height,
      digg_count = excluded.digg_count,
      comment_count = excluded.comment_count,
      collect_count = excluded.collect_count,
      share_count = excluded.share_count,
      play_count = excluded.play_count,
      share_url = excluded.share_url,
      metadata_json = excluded.metadata_json,
      source_path = excluded.source_path,
      cover_path = CASE
        WHEN excluded.cover_source = 'native' AND NULLIF(excluded.cover_path, '') IS NOT NULL THEN excluded.cover_path
        WHEN short_videos.cover_source = 'native' AND NULLIF(short_videos.cover_path, '') IS NOT NULL THEN short_videos.cover_path
        WHEN NULLIF(excluded.cover_path, '') IS NOT NULL THEN excluded.cover_path
        ELSE short_videos.cover_path
      END,
      cover_source = CASE
        WHEN excluded.cover_source = 'native' AND NULLIF(excluded.cover_path, '') IS NOT NULL THEN 'native'
        WHEN short_videos.cover_source = 'native' AND NULLIF(short_videos.cover_path, '') IS NOT NULL THEN 'native'
        WHEN NULLIF(excluded.cover_source, '') IS NOT NULL THEN excluded.cover_source
        ELSE short_videos.cover_source
      END,
      music_path = excluded.music_path,
      data_path = excluded.data_path,
      relative_path = excluded.relative_path,
      file_name = excluded.file_name,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      updated_at = excluded.updated_at
  `);
}

function canonicalShortVideoBySourcePathStatement(db) {
  return db.prepare(`
    SELECT id, aweme_id, metadata_json
    FROM short_videos
    WHERE source_path = ?
      AND COALESCE(TRIM(source_path), '') <> ''
    ORDER BY
      CASE WHEN COALESCE(aweme_id, '') GLOB '[0-9]*' THEN LENGTH(aweme_id) ELSE 0 END DESC,
      CASE WHEN COALESCE(metadata_json, '{}') <> '{}' THEN 1 ELSE 0 END DESC,
      updated_at DESC,
      id DESC
    LIMIT 1
  `);
}

function applyCanonicalShortVideoIdentity(db, statement, item) {
  if (!item?.sourcePath) return;
  const existing = statement.get(item.sourcePath);
  if (!existing) return;
  const existingAwemeId = String(existing.aweme_id || existing.id || "").trim();
  const incomingAwemeId = String(item.awemeId || item.id || "").trim();
  if (!shouldPreferCanonicalAwemeId(existingAwemeId, incomingAwemeId)) return;
  item.id = existingAwemeId;
  item.awemeId = existingAwemeId;
  item.shareUrl = normalizedDouyinShareUrl(item.shareUrl, existingAwemeId);
  const metadata = parseJsonObject(item.metadataJson);
  if (metadata && Object.keys(metadata).length) {
    metadata.aweme_id = existingAwemeId;
    item.metadataJson = JSON.stringify(metadata);
  }
}

function shouldPreferCanonicalAwemeId(existingAwemeId, incomingAwemeId) {
  const existing = String(existingAwemeId || "").trim();
  const incoming = String(incomingAwemeId || "").trim();
  if (!/^\d{8,}$/.test(existing)) return false;
  if (!incoming) return true;
  if (!/^\d{8,}$/.test(incoming)) return true;
  if (existing === incoming) return false;
  if ((existing.startsWith(incoming) || incoming.startsWith(existing)) && existing.length > incoming.length) return true;
  return existing.length >= 18 && incoming.length < 18;
}

function pruneSourcePathDuplicates(db, item) {
  if (!item?.sourcePath || !item?.id) return;
  const rows = db.prepare(`
    SELECT id, aweme_id, metadata_json
    FROM short_videos
    WHERE source_path = ?
      AND id <> ?
  `).all(item.sourcePath, item.id);
  for (const row of rows) {
    if (isSafeSourcePathDuplicate(row, item)) mergeDuplicateShortVideoRow(db, row.id, item.id);
  }
}

function isSafeSourcePathDuplicate(row, item) {
  const oldId = String(row?.aweme_id || row?.id || "").trim();
  const newId = String(item?.awemeId || item?.id || "").trim();
  if (!oldId || !newId) return true;
  if (!/^\d{8,}$/.test(oldId) || !/^\d{8,}$/.test(newId)) return true;
  return oldId === newId || oldId.startsWith(newId) || newId.startsWith(oldId);
}

function mergeDuplicateShortVideoRow(db, duplicateId, keepId) {
  if (!duplicateId || !keepId || duplicateId === keepId) return;
  const duplicate = db.prepare("SELECT * FROM short_videos WHERE id = ?").get(duplicateId);
  const keep = db.prepare("SELECT * FROM short_videos WHERE id = ?").get(keepId);
  if (!duplicate || !keep) return;

  const now = new Date().toISOString();
  const mergedOrigin = mergeShortVideoOrigin(keep.origin, duplicate.origin);
  db.prepare(`
    UPDATE short_videos
    SET author_sec_uid = COALESCE(NULLIF(author_sec_uid, ''), ?),
        author_uid = COALESCE(NULLIF(author_uid, ''), ?),
        author_name = COALESCE(NULLIF(author_name, ''), ?),
        author_avatar_url = COALESCE(NULLIF(author_avatar_url, ''), ?),
        title = COALESCE(NULLIF(title, ''), ?),
        description = COALESCE(NULLIF(description, ''), ?),
        tags_json = CASE
          WHEN COALESCE(tags_json, '[]') IN ('', '[]') AND COALESCE(?, '[]') NOT IN ('', '[]') THEN ?
          ELSE tags_json
        END,
        tags_text = COALESCE(NULLIF(tags_text, ''), ?),
        create_time = COALESCE(create_time, ?),
        published_at = COALESCE(NULLIF(published_at, ''), ?),
        liked_at = CASE
          WHEN COALESCE(liked_at, '') = '' THEN ?
          WHEN COALESCE(?, '') <> '' AND ? > liked_at THEN ?
          ELSE liked_at
        END,
        duration_ms = COALESCE(duration_ms, ?),
        width = COALESCE(width, ?),
        height = COALESCE(height, ?),
        digg_count = MAX(COALESCE(digg_count, 0), ?),
        comment_count = MAX(COALESCE(comment_count, 0), ?),
        collect_count = MAX(COALESCE(collect_count, 0), ?),
        share_count = MAX(COALESCE(share_count, 0), ?),
        play_count = MAX(COALESCE(play_count, 0), ?),
        share_url = COALESCE(NULLIF(share_url, ''), ?),
        metadata_json = CASE
          WHEN COALESCE(metadata_json, '{}') IN ('', '{}') AND COALESCE(?, '{}') NOT IN ('', '{}') THEN ?
          ELSE metadata_json
        END,
        cover_path = CASE
          WHEN COALESCE(NULLIF(cover_path, ''), '') = '' AND COALESCE(?, '') <> '' THEN ?
          WHEN cover_source <> 'native' AND ? = 'native' AND COALESCE(?, '') <> '' THEN ?
          ELSE cover_path
        END,
        cover_source = CASE
          WHEN COALESCE(NULLIF(cover_source, ''), '') = '' AND COALESCE(?, '') <> '' THEN ?
          WHEN cover_source <> 'native' AND ? = 'native' THEN 'native'
          ELSE cover_source
        END,
        music_path = COALESCE(NULLIF(music_path, ''), ?),
        data_path = COALESCE(NULLIF(data_path, ''), ?),
        relative_path = COALESCE(NULLIF(relative_path, ''), ?),
        file_name = COALESCE(NULLIF(file_name, ''), ?),
        size_bytes = MAX(COALESCE(size_bytes, 0), ?),
        mtime_ms = MAX(COALESCE(mtime_ms, 0), ?),
        owner_user_id = COALESCE(NULLIF(owner_user_id, ''), ?),
        origin = ?,
        status = CASE WHEN COALESCE(status, '') = '' THEN ? ELSE status END,
        visibility = CASE WHEN COALESCE(visibility, '') = '' THEN ? ELSE visibility END,
        updated_at = ?
    WHERE id = ?
  `).run(
    duplicate.author_sec_uid || "",
    duplicate.author_uid || "",
    duplicate.author_name || "",
    duplicate.author_avatar_url || "",
    duplicate.title || "",
    duplicate.description || "",
    duplicate.tags_json || "[]",
    duplicate.tags_json || "[]",
    duplicate.tags_text || "",
    duplicate.create_time ?? null,
    duplicate.published_at || "",
    duplicate.liked_at || "",
    duplicate.liked_at || "",
    duplicate.liked_at || "",
    duplicate.liked_at || "",
    duplicate.duration_ms ?? null,
    duplicate.width ?? null,
    duplicate.height ?? null,
    Number(duplicate.digg_count || 0),
    Number(duplicate.comment_count || 0),
    Number(duplicate.collect_count || 0),
    Number(duplicate.share_count || 0),
    Number(duplicate.play_count || 0),
    duplicate.share_url || "",
    duplicate.metadata_json || "{}",
    duplicate.metadata_json || "{}",
    duplicate.cover_path || "",
    duplicate.cover_path || "",
    duplicate.cover_source || "",
    duplicate.cover_path || "",
    duplicate.cover_path || "",
    duplicate.cover_source || "",
    duplicate.cover_source || "",
    duplicate.cover_source || "",
    duplicate.music_path || "",
    duplicate.data_path || "",
    duplicate.relative_path || "",
    duplicate.file_name || "",
    Number(duplicate.size_bytes || 0),
    Number(duplicate.mtime_ms || 0),
    duplicate.owner_user_id || "",
    mergedOrigin,
    duplicate.status || "normal",
    duplicate.visibility || "local_only",
    now,
    keepId
  );

  mergeDuplicateShortVideoStats(db, duplicateId, keepId, now);
  mergeDuplicateShortVideoAssets(db, duplicateId, keepId, now);
  mergeDuplicateShortVideoActions(db, duplicateId, keepId, now);
  mergeDuplicateShortVideoCollectionItems(db, duplicateId, keepId);
  mergeDuplicateShortVideoLocalComments(db, duplicateId, keepId, now);
  mergeDuplicateShortVideoWatchHistory(db, duplicateId, keepId);
  mergeDuplicateShortVideoImportItems(db, duplicateId, keepId);
  db.prepare("DELETE FROM short_videos WHERE id = ?").run(duplicateId);
}

function mergeDuplicateShortVideoStats(db, duplicateId, keepId, now) {
  const duplicate = db.prepare("SELECT * FROM short_video_stats WHERE video_id = ?").get(duplicateId);
  if (!duplicate) return;
  const keep = db.prepare("SELECT * FROM short_video_stats WHERE video_id = ?").get(keepId);
  if (!keep) {
    db.prepare("UPDATE short_video_stats SET video_id = ?, updated_at = ? WHERE video_id = ?").run(keepId, now, duplicateId);
    return;
  }
  db.prepare(`
    UPDATE short_video_stats
    SET digg_count = MAX(COALESCE(digg_count, 0), ?),
        comment_count = MAX(COALESCE(comment_count, 0), ?),
        collect_count = MAX(COALESCE(collect_count, 0), ?),
        share_count = MAX(COALESCE(share_count, 0), ?),
        play_count = MAX(COALESCE(play_count, 0), ?),
        snapshot_at = CASE WHEN COALESCE(?, '') > COALESCE(snapshot_at, '') THEN ? ELSE snapshot_at END,
        updated_at = ?
    WHERE video_id = ?
  `).run(
    Number(duplicate.digg_count || 0),
    Number(duplicate.comment_count || 0),
    Number(duplicate.collect_count || 0),
    Number(duplicate.share_count || 0),
    Number(duplicate.play_count || 0),
    duplicate.snapshot_at || "",
    duplicate.snapshot_at || "",
    now,
    keepId
  );
  db.prepare("DELETE FROM short_video_stats WHERE video_id = ?").run(duplicateId);
}

function mergeDuplicateShortVideoAssets(db, duplicateId, keepId, now) {
  const assets = db.prepare("SELECT * FROM short_video_assets WHERE video_id = ?").all(duplicateId);
  const keepByType = db.prepare("SELECT * FROM short_video_assets WHERE video_id = ? AND asset_type = ?");
  for (const asset of assets) {
    const keep = keepByType.get(keepId, asset.asset_type);
    if (!keep) {
      db.prepare(`
        UPDATE short_video_assets
        SET id = ?, video_id = ?, updated_at = ?
        WHERE id = ?
      `).run(`${keepId}:${asset.asset_type}`, keepId, now, asset.id);
      continue;
    }
    db.prepare(`
      UPDATE short_video_assets
      SET local_path = COALESCE(NULLIF(local_path, ''), ?),
          remote_url = COALESCE(NULLIF(remote_url, ''), ?),
          file_name = COALESCE(NULLIF(file_name, ''), ?),
          file_hash = COALESCE(NULLIF(file_hash, ''), ?),
          size_bytes = MAX(COALESCE(size_bytes, 0), ?),
          mime_type = COALESCE(NULLIF(mime_type, ''), ?),
          codec = COALESCE(NULLIF(codec, ''), ?),
          mtime_ms = MAX(COALESCE(mtime_ms, 0), ?),
          updated_at = ?
      WHERE video_id = ?
        AND asset_type = ?
    `).run(
      asset.local_path || "",
      asset.remote_url || "",
      asset.file_name || "",
      asset.file_hash || "",
      Number(asset.size_bytes || 0),
      asset.mime_type || "",
      asset.codec || "",
      Number(asset.mtime_ms || 0),
      now,
      keepId,
      asset.asset_type
    );
    db.prepare("DELETE FROM short_video_assets WHERE id = ?").run(asset.id);
  }
}

function mergeDuplicateShortVideoActions(db, duplicateId, keepId, now) {
  const rows = db.prepare("SELECT * FROM short_video_user_actions WHERE video_id = ?").all(duplicateId);
  const keepStatement = db.prepare(`
    SELECT 1 FROM short_video_user_actions
    WHERE local_user_id = ? AND video_id = ? AND action_type = ?
  `);
  for (const row of rows) {
    const keep = keepStatement.get(row.local_user_id, keepId, row.action_type);
    if (!keep) {
      db.prepare(`
        UPDATE short_video_user_actions
        SET video_id = ?, updated_at = ?
        WHERE local_user_id = ? AND video_id = ? AND action_type = ?
      `).run(keepId, now, row.local_user_id, duplicateId, row.action_type);
      continue;
    }
    db.prepare(`
      UPDATE short_video_user_actions
      SET active = MAX(COALESCE(active, 0), ?),
          source = COALESCE(NULLIF(source, ''), ?),
          acted_at = CASE WHEN COALESCE(?, '') > COALESCE(acted_at, '') THEN ? ELSE acted_at END,
          updated_at = ?
      WHERE local_user_id = ?
        AND video_id = ?
        AND action_type = ?
    `).run(Number(row.active || 0), row.source || "", row.acted_at || "", row.acted_at || "", now, row.local_user_id, keepId, row.action_type);
    db.prepare(`
      DELETE FROM short_video_user_actions
      WHERE local_user_id = ? AND video_id = ? AND action_type = ?
    `).run(row.local_user_id, duplicateId, row.action_type);
  }
}

function mergeDuplicateShortVideoCollectionItems(db, duplicateId, keepId) {
  const rows = db.prepare("SELECT * FROM short_video_collection_items WHERE video_id = ?").all(duplicateId);
  for (const row of rows) {
    db.prepare(`
      INSERT OR IGNORE INTO short_video_collection_items (collection_id, video_id, added_at)
      VALUES (?, ?, ?)
    `).run(row.collection_id, keepId, row.added_at || "");
    db.prepare("DELETE FROM short_video_collection_items WHERE collection_id = ? AND video_id = ?").run(row.collection_id, duplicateId);
  }
}

function mergeDuplicateShortVideoLocalComments(db, duplicateId, keepId, now) {
  db.prepare(`
    UPDATE short_video_local_comments
    SET video_id = ?, updated_at = COALESCE(NULLIF(updated_at, ''), ?)
    WHERE video_id = ?
  `).run(keepId, now, duplicateId);
}

function mergeDuplicateShortVideoWatchHistory(db, duplicateId, keepId) {
  const rows = db.prepare("SELECT * FROM short_video_watch_history WHERE video_id = ?").all(duplicateId);
  const keepStatement = db.prepare("SELECT * FROM short_video_watch_history WHERE local_user_id = ? AND video_id = ?");
  for (const row of rows) {
    const keep = keepStatement.get(row.local_user_id, keepId);
    if (!keep) {
      db.prepare(`
        UPDATE short_video_watch_history
        SET video_id = ?
        WHERE local_user_id = ? AND video_id = ?
      `).run(keepId, row.local_user_id, duplicateId);
      continue;
    }
    db.prepare(`
      UPDATE short_video_watch_history
      SET progress_ms = MAX(COALESCE(progress_ms, 0), ?),
          completed_count = MAX(COALESCE(completed_count, 0), ?),
          last_watched_at = CASE WHEN COALESCE(?, '') > COALESCE(last_watched_at, '') THEN ? ELSE last_watched_at END
      WHERE local_user_id = ?
        AND video_id = ?
    `).run(Number(row.progress_ms || 0), Number(row.completed_count || 0), row.last_watched_at || "", row.last_watched_at || "", row.local_user_id, keepId);
    db.prepare("DELETE FROM short_video_watch_history WHERE local_user_id = ? AND video_id = ?").run(row.local_user_id, duplicateId);
  }
}

function mergeDuplicateShortVideoImportItems(db, duplicateId, keepId) {
  const rows = db.prepare("SELECT * FROM short_video_import_items WHERE video_id = ?").all(duplicateId);
  for (const row of rows) {
    db.prepare(`
      INSERT OR IGNORE INTO short_video_import_items (batch_id, video_id, source_path, data_path, imported_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.batch_id, keepId, row.source_path || "", row.data_path || "", row.imported_at || "");
    db.prepare("DELETE FROM short_video_import_items WHERE batch_id = ? AND video_id = ?").run(row.batch_id, duplicateId);
  }
}

function mergeShortVideoOrigin(keepOrigin = "", duplicateOrigin = "") {
  const keep = String(keepOrigin || "").trim();
  const duplicate = String(duplicateOrigin || "").trim();
  if (keep === "douyin_like_import" || keep === "douyin_download_manager_like") return keep;
  if (duplicate === "douyin_like_import" || duplicate === "douyin_download_manager_like") return duplicate;
  return keep || duplicate || "douyin_like_import";
}

function videoRowValues(item, now) {
  return [
    item.id,
    item.awemeId,
    item.author.secUid,
    item.author.uid,
    item.author.name,
    item.author.avatarUrl,
    item.title,
    item.description,
    JSON.stringify(item.tags || []),
    (item.tags || []).join(" "),
    item.createTime,
    item.publishedAt,
    item.likedAt,
    item.durationMs,
    item.width,
    item.height,
    item.diggCount,
    item.commentCount,
    item.collectCount,
    item.shareCount,
    item.playCount,
    item.shareUrl,
    item.metadataJson || "{}",
    item.sourcePath,
    item.coverPath,
    item.coverSource || (item.coverPath ? "native" : ""),
    item.musicPath,
    item.dataPath,
    item.relativePath,
    item.fileName,
    item.sizeBytes,
    item.mtimeMs,
    now,
    now
  ];
}

function normalizedUpsertStatements(db, coverCacheDir = "") {
  return {
    coverCacheDir,
    localUser: db.prepare(`
      INSERT INTO short_video_users (
        id, platform, sec_uid, uid, nickname, avatar_url, signature,
        follower_count, following_count, raw_json, created_at, updated_at
      )
      VALUES (?, 'local', '', ?, ?, '', '', NULL, NULL, '{}', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        nickname = excluded.nickname,
        updated_at = excluded.updated_at
    `),
    user: db.prepare(`
      INSERT INTO short_video_users (
        id, platform, sec_uid, uid, nickname, avatar_url, profile_url, signature,
        follower_count, following_count, raw_json, unique_id, short_id, ip_location,
        total_favorited, aweme_count, favoriting_count, gender, age, verification,
        profile_collected_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        platform = COALESCE(NULLIF(excluded.platform, ''), short_video_users.platform),
        sec_uid = COALESCE(NULLIF(excluded.sec_uid, ''), short_video_users.sec_uid),
        uid = COALESCE(NULLIF(excluded.uid, ''), short_video_users.uid),
        nickname = COALESCE(NULLIF(excluded.nickname, ''), short_video_users.nickname),
        avatar_url = COALESCE(NULLIF(excluded.avatar_url, ''), short_video_users.avatar_url),
        profile_url = COALESCE(NULLIF(excluded.profile_url, ''), short_video_users.profile_url),
        signature = COALESCE(NULLIF(excluded.signature, ''), short_video_users.signature),
        follower_count = COALESCE(excluded.follower_count, short_video_users.follower_count),
        following_count = COALESCE(excluded.following_count, short_video_users.following_count),
        raw_json = CASE
          WHEN excluded.raw_json <> '{}' THEN excluded.raw_json
          ELSE short_video_users.raw_json
        END,
        unique_id = COALESCE(NULLIF(excluded.unique_id, ''), short_video_users.unique_id),
        short_id = COALESCE(NULLIF(excluded.short_id, ''), short_video_users.short_id),
        ip_location = COALESCE(NULLIF(excluded.ip_location, ''), short_video_users.ip_location),
        total_favorited = COALESCE(excluded.total_favorited, short_video_users.total_favorited),
        aweme_count = COALESCE(excluded.aweme_count, short_video_users.aweme_count),
        favoriting_count = COALESCE(excluded.favoriting_count, short_video_users.favoriting_count),
        gender = COALESCE(excluded.gender, short_video_users.gender),
        age = COALESCE(excluded.age, short_video_users.age),
        verification = COALESCE(NULLIF(excluded.verification, ''), short_video_users.verification),
        profile_collected_at = COALESCE(NULLIF(excluded.profile_collected_at, ''), short_video_users.profile_collected_at),
        updated_at = excluded.updated_at
    `),
    videoCore: db.prepare(`
      UPDATE short_videos
      SET owner_user_id = ?,
          origin = CASE
            WHEN origin IN ('douyin_like_import', 'douyin_download_manager_like')
              AND ? = 'douyin_download_manager_post'
              THEN origin
            WHEN ? IN ('douyin_like_import', 'douyin_download_manager_like')
              THEN ?
            ELSE ?
          END,
          status = ?,
          visibility = ?,
          updated_at = ?
      WHERE id = ?
    `),
    stats: db.prepare(`
      INSERT INTO short_video_stats (
        video_id, digg_count, comment_count, collect_count, share_count,
        play_count, snapshot_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        digg_count = excluded.digg_count,
        comment_count = excluded.comment_count,
        collect_count = excluded.collect_count,
        share_count = excluded.share_count,
        play_count = excluded.play_count,
        snapshot_at = excluded.snapshot_at,
        updated_at = excluded.updated_at
    `),
    asset: db.prepare(`
      INSERT INTO short_video_assets (
        id, video_id, asset_type, local_path, remote_url, file_name, file_hash,
        size_bytes, mime_type, codec, mtime_ms, imported_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id, asset_type) DO UPDATE SET
        local_path = excluded.local_path,
        remote_url = excluded.remote_url,
        file_name = excluded.file_name,
        file_hash = excluded.file_hash,
        size_bytes = excluded.size_bytes,
        mime_type = excluded.mime_type,
        codec = excluded.codec,
        mtime_ms = excluded.mtime_ms,
        updated_at = excluded.updated_at
    `),
    ffmpegCoverRows: db.prepare(`
      SELECT local_path
      FROM short_video_assets
      WHERE video_id = ?
        AND asset_type = 'ffmpeg_cover'
        AND COALESCE(TRIM(local_path), '') <> ''
    `),
    deleteFfmpegCover: db.prepare(`
      DELETE FROM short_video_assets
      WHERE video_id = ?
        AND asset_type = 'ffmpeg_cover'
    `),
    deleteVideoAsset: db.prepare(`
      DELETE FROM short_video_assets
      WHERE video_id = ?
        AND asset_type = 'video'
    `),
    deleteGalleryAssets: db.prepare(`
      DELETE FROM short_video_assets
      WHERE video_id = ?
        AND asset_type LIKE 'gallery_image:%'
    `),
    action: db.prepare(`
      INSERT INTO short_video_user_actions (
        local_user_id, video_id, action_type, active, source, acted_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_user_id, video_id, action_type) DO UPDATE SET
        active = excluded.active,
        source = excluded.source,
        acted_at = excluded.acted_at,
        updated_at = excluded.updated_at
    `)
  };
}

function upsertNormalizedItem(statements, item, now, options = {}) {
  const authorId = shortVideoUserId(item.author || {});
  statements.localUser.run(LOCAL_SHORT_VIDEO_USER_ID, "self", "本地用户", now, now);
  statements.user.run(
    authorId,
    item.awemeId || item.author?.secUid ? "douyin" : "local",
    item.author?.secUid || "",
    item.author?.uid || "",
    item.author?.name || "未知作者",
    item.author?.avatarUrl || "",
    item.author?.profileUrl || douyinUserUrl(item.author?.secUid),
    item.author?.signature || "",
    optionalInteger(item.author?.followerCount),
    optionalInteger(item.author?.followingCount),
    item.author?.rawJson || "{}",
    item.author?.uniqueId || "",
    item.author?.shortId || "",
    item.author?.ipLocation || "",
    optionalInteger(item.author?.totalFavorited),
    optionalInteger(item.author?.awemeCount),
    optionalInteger(item.author?.favoritingCount),
    optionalInteger(item.author?.gender),
    optionalInteger(item.author?.age),
    item.author?.verification || "",
    item.author?.profileCollectedAt || "",
    now,
    now
  );
  const origin = shortVideoOrigin(item);
  statements.videoCore.run(authorId, origin, origin, origin, origin, "normal", "local_only", now, item.id);
  statements.stats.run(
    item.id,
    Number(item.diggCount || 0),
    Number(item.commentCount || 0),
    Number(item.collectCount || 0),
    Number(item.shareCount || 0),
    Number(item.playCount || 0),
    now,
    now
  );
  statements.deleteGalleryAssets.run(item.id);
  if (item.mediaType === "gallery" && Array.isArray(item.galleryPaths) && item.galleryPaths.length) {
    statements.deleteVideoAsset.run(item.id);
    item.galleryPaths.forEach((localPath, index) => {
      const stat = safeStat(localPath);
      if (!stat?.isFile()) return;
      runAssetUpsert(statements.asset, {
        videoId: item.id,
        assetType: galleryAssetType(index),
        localPath,
        fileName: path.basename(localPath),
        sizeBytes: Number(stat.size || 0),
        mtimeMs: Math.floor(stat.mtimeMs || 0),
        mimeType: mimeTypeForPath(localPath)
      }, now);
    });
  } else {
    runAssetUpsert(statements.asset, {
      videoId: item.id,
      assetType: "video",
      localPath: item.sourcePath || "",
      fileName: item.fileName || path.basename(item.sourcePath || ""),
      sizeBytes: Number(item.sizeBytes || 0),
      mtimeMs: Number(item.mtimeMs || 0),
      mimeType: mimeTypeForPath(item.sourcePath || item.fileName || "")
    }, now);
  }
  if (item.coverPath) {
    const stat = safeStat(item.coverPath);
    const coverAssetType = item.coverSource === "ffmpeg" ? "ffmpeg_cover" : "native_cover";
    runAssetUpsert(statements.asset, {
      videoId: item.id,
      assetType: coverAssetType,
      localPath: item.coverPath,
      fileName: path.basename(item.coverPath),
      sizeBytes: stat?.size || 0,
      mtimeMs: Math.floor(stat?.mtimeMs || 0),
      mimeType: mimeTypeForPath(item.coverPath)
    }, now);
    if (coverAssetType === "native_cover") deleteSupersededFfmpegCover(statements, item.id);
  }
  if (item.musicPath) {
    const stat = safeStat(item.musicPath);
    runAssetUpsert(statements.asset, {
      videoId: item.id,
      assetType: "music",
      localPath: item.musicPath,
      fileName: path.basename(item.musicPath),
      sizeBytes: stat?.size || 0,
      mtimeMs: Math.floor(stat?.mtimeMs || 0),
      mimeType: mimeTypeForPath(item.musicPath)
    }, now);
  }
  if (options.actionSource) {
    statements.action.run(
      LOCAL_SHORT_VIDEO_USER_ID,
      item.id,
      "like",
      1,
      options.actionSource,
      item.likedAt || now,
      now
    );
  }
}

function upsertAsset(db, asset, now = new Date().toISOString()) {
  runAssetUpsert(normalizedUpsertStatements(db).asset, asset, now);
}

function deleteSupersededFfmpegCover(statements, videoId) {
  if (!videoId || !statements?.ffmpegCoverRows || !statements?.deleteFfmpegCover) return;
  const rows = statements.ffmpegCoverRows.all(videoId);
  statements.deleteFfmpegCover.run(videoId);
  for (const row of rows) removeGeneratedCoverFile(row.local_path, statements.coverCacheDir);
}

function runAssetUpsert(statement, asset, now) {
  if (!asset?.videoId || !asset?.assetType || (!asset.localPath && !asset.remoteUrl)) return;
  const id = `${asset.videoId}:${asset.assetType}`;
  runSqliteBusyRetry(() => statement.run(
    id,
    asset.videoId,
    asset.assetType,
    asset.localPath || "",
    asset.remoteUrl || "",
    asset.fileName || path.basename(asset.localPath || ""),
    asset.fileHash || "",
    Number(asset.sizeBytes || 0),
    asset.mimeType || mimeTypeForPath(asset.localPath || asset.fileName || ""),
    asset.codec || "",
    Number(asset.mtimeMs || 0),
    now,
    now
  ));
}

function legacyRowToItem(row) {
  return {
    id: row.id,
    awemeId: row.aweme_id || "",
    author: {
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
      profileCollectedAt: row.author_profile_collected_at || ""
    },
    sourcePath: row.source_path || "",
    coverPath: row.cover_path || "",
    coverSource: row.cover_source || (String(row.cover_path || "").includes("short-video-covers") ? "ffmpeg" : (row.cover_path ? "native" : "")),
    musicPath: row.music_path || "",
    fileName: row.file_name || path.basename(row.source_path || ""),
    sizeBytes: Number(row.size_bytes || 0),
    mtimeMs: Number(row.mtime_ms || 0),
    diggCount: Number(row.digg_count || 0),
    commentCount: Number(row.comment_count || 0),
    collectCount: Number(row.collect_count || 0),
    shareCount: Number(row.share_count || 0),
    playCount: Number(row.play_count || 0),
    likedAt: row.liked_at || row.imported_at || "",
    origin: row.origin || ""
  };
}

function shortVideoUserId(author = {}) {
  if (author.secUid) return `douyin:${author.secUid}`;
  if (author.uid) return `douyin-uid:${author.uid}`;
  return `author:${hashText(author.name || "unknown").slice(0, 18)}`;
}

function shortVideoOrigin(item = {}) {
  if (item.origin) return item.origin;
  return item.awemeId || item.author?.secUid ? "douyin_like_import" : "local_import";
}

function deleteMissingImportedVideos(db, foundIds) {
  const staleIds = foundIds.size
    ? db.prepare(`SELECT id FROM short_videos WHERE origin = 'douyin_like_import' AND id NOT IN (${[...foundIds].map(() => "?").join(",")})`).all(...foundIds).map((row) => row.id)
    : db.prepare("SELECT id FROM short_videos WHERE origin = 'douyin_like_import'").all().map((row) => row.id);
  if (!staleIds.length) return;
  const placeholders = staleIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM short_videos WHERE id IN (${placeholders})`).run(...staleIds);
  deleteNormalizedVideoRows(db, staleIds);
}

function deleteNormalizedVideoRows(db, videoIds) {
  if (!videoIds.length) return;
  const placeholders = videoIds.map(() => "?").join(",");
  for (const [table, column] of [
    ["short_video_assets", "video_id"],
    ["short_video_stats", "video_id"],
    ["short_video_user_actions", "video_id"],
    ["short_video_collection_items", "video_id"],
    ["short_video_watch_history", "video_id"],
    ["short_video_local_comments", "video_id"],
    ["short_video_import_items", "video_id"]
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...videoIds);
  }
}

function recommendationTagList(value) {
  const tags = parseJsonArray(value);
  const result = [];
  const seen = new Set();
  for (const item of tags) {
    const tag = String(item || "").trim().replace(/^#+/, "");
    const normalized = tag.toLocaleLowerCase();
    if (!tag || tag.length > 48 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(tag);
  }
  return result;
}

function shortVideoRecommendationAuthorKey(row = {}) {
  const secUid = String(row.author_sec_uid || "").trim();
  if (secUid) return `uid:${secUid}`;
  const name = String(row.author_name || "").trim().toLocaleLowerCase();
  return name && name !== "未知作者" ? `name:${name}` : "";
}

function videoCatalogRowByAnyId(db, id, columns = "*") {
  const lookup = String(id || "").trim();
  if (!lookup) return null;
  const exact = db.prepare(`SELECT ${columns} FROM short_video_catalog WHERE id = ? OR aweme_id = ?`).get(lookup, lookup);
  if (exact) return exact;
  if (!/^\d{8,17}$/.test(lookup)) return null;
  const matches = db.prepare(`
    SELECT ${columns}
    FROM short_video_catalog
    WHERE id GLOB ?
       OR aweme_id GLOB ?
    ORDER BY
      CASE WHEN COALESCE(aweme_id, '') GLOB '[0-9]*' THEN LENGTH(aweme_id) ELSE 0 END DESC,
      id DESC
    LIMIT 2
  `).all(`${lookup}*`, `${lookup}*`);
  return matches.length === 1 ? matches[0] : null;
}

function publicVideo(row, options = {}) {
  const id = row.id || row.aweme_id || "";
  const metadata = parseJsonObject(row.metadata_json);
  const media = publicVideoMedia(row, metadata);
  const userActions = {
    liked: Boolean(row.user_like_active),
    collected: Boolean(row.user_collect_active),
    disliked: Boolean(row.user_dislike_active)
  };
  const likeDelta = shortVideoActionMetricDelta(row.user_like_active, row.user_like_source);
  const collectDelta = shortVideoActionMetricDelta(row.user_collect_active, row.user_collect_source);
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
    mediaType: media.type,
    galleryCount: media.galleryCount,
    galleryImages: media.galleryCount
      ? Array.from({ length: media.galleryCount }, (_, index) => ({
        index,
        url: `/media/short-video-gallery/${encodeURIComponent(id)}/${index}`
      }))
      : [],
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
    stats: {
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
    streamUrl: media.type === "video" ? `/media/short-video/${encodeURIComponent(id)}` : "",
    coverUrl: row.cover_path ? `/media/short-video-cover/${encodeURIComponent(id)}?v=${encodeURIComponent(String(row.mtime_ms || ""))}` : remoteCoverUrl,
    coverSource: row.cover_source || "",
    fileName: row.file_name || "",
    relativePath: row.relative_path || "",
    size: Number(row.size_bytes || 0),
    ...(options.detail ? {
      sourcePath: row.source_path || "",
      dataPath: row.data_path || "",
      musicPath: row.music_path || "",
      metadata
    } : {})
  };
}

function shortVideoActionMetricDelta(active, source) {
  const baselineActive = IMPORTED_SHORT_VIDEO_ACTION_SOURCES.has(String(source || "").trim());
  return Number(Boolean(active)) - Number(baselineActive);
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
    coverUrl: remoteCover || row.author_avatar_url || (row.cover_path ? `/media/short-video-cover/${encodeURIComponent(id)}?v=${encodeURIComponent(String(row.mtime_ms || ""))}` : ""),
    previewUrl: localAvailable ? `/media/short-video-music/${encodeURIComponent(id)}` : remotePreview,
    previewSource: localAvailable ? "local" : (remotePreview ? "remote" : ""),
    localAvailable,
    original: /创作的原声/.test(title)
  };
}

function publicVideoMedia(row, metadata = {}) {
  const fanhaoMedia = metadata?.fanhaoMedia && typeof metadata.fanhaoMedia === "object"
    ? metadata.fanhaoMedia
    : {};
  const declaredType = String(fanhaoMedia.type || "").trim().toLowerCase();
  const galleryCount = clampInt(fanhaoMedia.galleryCount, 0, 0, 1000);
  const sourceExt = path.extname(String(row.source_path || "")).toLowerCase();
  const inferredGallery = IMAGE_EXTS.has(sourceExt) && galleryCount > 0;
  return {
    type: declaredType === "gallery" || inferredGallery ? "gallery" : "video",
    galleryCount: declaredType === "gallery" || inferredGallery ? galleryCount : 0
  };
}

function authorFacet(db) {
  return db.prepare(`
    SELECT
      MAX(secUid) AS secUid,
      COALESCE(MAX(name), '未知作者') AS name,
      MAX(NULLIF(author_avatar_url, '')) AS avatarUrl,
      MAX(NULLIF(targetUserId, '')) AS targetUserId,
      MAX(following) AS following,
      MAX(coverId) AS coverId,
      MAX(coverMtimeMs) AS coverMtimeMs,
      COUNT(*) AS count
    FROM (
      SELECT
        COALESCE(NULLIF(author_sec_uid, ''), NULLIF(author_name, ''), 'unknown') AS authorKey,
        NULLIF(author_sec_uid, '') AS secUid,
        NULLIF(author_name, '') AS name,
        author_avatar_url,
        owner_user_id AS targetUserId,
        COALESCE(author_following, 0) AS following,
        CASE WHEN COALESCE(NULLIF(cover_path, ''), '') <> '' THEN id ELSE '' END AS coverId,
        CASE WHEN COALESCE(NULLIF(cover_path, ''), '') <> '' THEN mtime_ms ELSE 0 END AS coverMtimeMs
      FROM short_video_catalog
      WHERE visibility = 'local_only'
        AND (NULLIF(author_sec_uid, '') IS NOT NULL OR NULLIF(author_name, '') IS NOT NULL)
    )
    GROUP BY authorKey
    ORDER BY count DESC, name COLLATE NOCASE
  `).all().map((row) => ({
    secUid: row.secUid || "",
    name: row.name || "未知作者",
    avatarUrl: row.avatarUrl || "",
    id: row.targetUserId || "",
    following: Boolean(row.following),
    fallbackCoverUrl: row.coverId ? `/media/short-video-cover/${encodeURIComponent(row.coverId)}?v=${encodeURIComponent(String(row.coverMtimeMs || ""))}` : "",
    count: Number(row.count || 0)
  }));
}

function videoStats(db, where = "", args = []) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(digg_count), 0) AS likes,
      COALESCE(SUM(comment_count), 0) AS comments,
      COALESCE(SUM(collect_count), 0) AS collects,
      COALESCE(SUM(share_count), 0) AS shares,
      COALESCE(SUM(play_count), 0) AS plays,
      COALESCE(SUM(size_bytes), 0) AS bytes,
      COALESCE(SUM(duration_ms), 0) AS durationMs
    FROM short_video_catalog
    ${where}
  `).get(...args);
  return {
    likes: Number(row?.likes || 0),
    comments: Number(row?.comments || 0),
    collects: Number(row?.collects || 0),
    shares: Number(row?.shares || 0),
    plays: Number(row?.plays || 0),
    bytes: Number(row?.bytes || 0),
    durationMs: Number(row?.durationMs || 0)
  };
}

function downloadManagerStatsBackfillIds(db, limit) {
  const safeLimit = clampInt(limit, DEFAULT_DOWNLOAD_MANAGER_STATS_BACKFILL_LIMIT, 0, 100000);
  if (!safeLimit) return [];
  return db.prepare(`
    SELECT COALESCE(NULLIF(aweme_id, ''), id) AS aweme_id
    FROM short_video_catalog
    WHERE COALESCE(NULLIF(aweme_id, ''), id) GLOB '[0-9]*'
      AND (
        COALESCE(digg_count, 0) = 0 AND
        COALESCE(comment_count, 0) = 0 AND
        COALESCE(collect_count, 0) = 0 AND
        COALESCE(share_count, 0) = 0
      )
    ORDER BY published_at DESC, liked_at DESC, id DESC
    LIMIT ?
  `).all(safeLimit)
    .map((row) => String(row.aweme_id || "").trim())
    .filter(Boolean);
}

function chunkArray(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseAuthorFolder(root, filePath) {
  const relative = path.relative(root, filePath);
  const first = relative.split(/[\\/]/)[0] || "";
  const markerIndex = first.lastIndexOf("_MS4w");
  if (markerIndex >= 0) {
    return {
      name: first.slice(0, markerIndex).trim() || "未命名作者",
      secUid: first.slice(markerIndex + 1).trim()
    };
  }
  return { name: first.trim() || "未知作者", secUid: "" };
}

function parseVideoName(name) {
  const match = /^(20\d{2}-\d{2}-\d{2})_(.+?)_([0-9]{8,})$/u.exec(String(name || ""));
  if (!match) return { date: "", title: "", awemeId: "" };
  return { date: match[1], title: match[2].trim(), awemeId: match[3] };
}

function findCompanion(files, dir, videoPath, ext, predicate) {
  const videoBase = path.basename(videoPath, path.extname(videoPath));
  const exact = files.find((name) => {
    if (ext && path.extname(name).toLowerCase() !== ext) return false;
    return predicate ? predicate(name) : name.startsWith(videoBase);
  });
  if (exact) return path.join(dir, exact);
  const loose = files.find((name) => {
    if (ext && path.extname(name).toLowerCase() !== ext) return false;
    return predicate ? predicate(name) : true;
  });
  return loose ? path.join(dir, loose) : "";
}

function findCover(files, dir, videoPath, data) {
  const coverBases = companionCoverBases(videoPath);
  const local = files.find((name) => {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return false;
    const base = path.basename(name, ext).toLowerCase();
    return coverBases.some((item) => base === item || base.startsWith(`${item}_`) || base.startsWith(`${item}-`));
  }) || files.find((name) => {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return false;
    const base = path.basename(name, ext).toLowerCase();
    return base.includes("cover") || base.includes("封面");
  }) || files.find((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()));
  if (local) return path.join(dir, local);
  return "";
}

function companionCoverBases(videoPath) {
  const videoBase = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const bases = new Set([videoBase]);
  const liveMatch = /^(.*)_live_(\d+)$/i.exec(videoBase);
  if (liveMatch) {
    bases.add(`${liveMatch[1]}_${Number(liveMatch[2])}`);
    bases.add(`${liveMatch[1]}_${liveMatch[2]}`);
  }
  return [...bases].filter(Boolean);
}

function parseDownloadManagerPaths(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.flat(Infinity).filter((item) => typeof item === "string" && item.trim());
    if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
  } catch {}
  return raw.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean);
}

function isDownloadManagerGallery(row = {}) {
  const kind = String(row.kind || "").trim().toLowerCase();
  const mediaType = String(row.media_type || "").trim().toLowerCase();
  return kind === "note" || mediaType === "gallery" || mediaType === "image" || mediaType === "images";
}

function galleryAssetType(index) {
  return `gallery_image:${String(Math.max(0, Number(index) || 0)).padStart(4, "0")}`;
}

function resolveDownloadManagerPath(outputDir, filePath) {
  const value = String(filePath || "").trim();
  if (!value) return "";
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(outputDir || "", value);
}

function firstExistingDownloadManagerPath(paths, exts, predicate = null) {
  return paths.find((filePath) => {
    if (!filePath || !exts.has(path.extname(filePath).toLowerCase())) return false;
    if (predicate && !predicate(filePath)) return false;
    return safeStat(filePath)?.isFile();
  }) || "";
}

function downloadManagerCoverPath(row, localPaths, sourcePath, outputDir) {
  const rowCoverPath = row.local_cover_path ? resolveDownloadManagerPath(outputDir, row.local_cover_path) : "";
  if (rowCoverPath && IMAGE_EXTS.has(path.extname(rowCoverPath).toLowerCase()) && safeStat(rowCoverPath)?.isFile()) {
    return rowCoverPath;
  }
  const localCover = firstExistingDownloadManagerPath(localPaths, IMAGE_EXTS, (filePath) => {
    const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const coverBases = companionCoverBases(sourcePath);
    return coverBases.some((item) => base === item || base.startsWith(`${item}_`) || base.startsWith(`${item}-`))
      || base.includes("cover")
      || base.includes("封面");
  }) || firstExistingDownloadManagerPath(localPaths, IMAGE_EXTS);
  if (localCover) return localCover;
  const previewPath = row.preview_path ? resolveDownloadManagerPath(outputDir, row.preview_path) : "";
  if (previewPath && IMAGE_EXTS.has(path.extname(previewPath).toLowerCase()) && safeStat(previewPath)?.isFile()) {
    return previewPath;
  }
  return "";
}

function readVideoJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function firstUrl(value) {
  const list = value?.url_list;
  if (Array.isArray(list)) return String(list[0] || "").trim();
  if (Array.isArray(value)) return value.map((item) => firstUrl(item)).find(Boolean) || "";
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
  return "";
}

function firstUrlAny(...values) {
  for (const value of values) {
    const url = firstUrl(value);
    if (url) return url;
  }
  return "";
}

function normalizedDouyinShareUrl(value, awemeId = "") {
  const url = String(value || "").trim();
  if (url) return url;
  return douyinVideoUrl(awemeId);
}

function normalizedDouyinUserUrl(value, secUid = "") {
  const url = String(value || "").trim();
  if (url) return url;
  return douyinUserUrl(secUid);
}

function douyinVideoUrl(awemeId) {
  const id = String(awemeId || "").trim();
  if (!/^\d{8,}$/.test(id)) return "";
  return `https://www.douyin.com/video/${id}`;
}

function douyinNoteUrl(awemeId) {
  const id = String(awemeId || "").trim();
  if (!/^\d{8,}$/.test(id)) return "";
  return `https://www.douyin.com/note/${id}`;
}

function douyinUserUrl(secUid) {
  const id = String(secUid || "").trim();
  if (!id) return "";
  return `https://www.douyin.com/user/${encodeURIComponent(id)}`;
}

function rawAwemeMetadata(data = {}) {
  const raw = data?.metadata;
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  return parseJsonObject(raw);
}

function tagsFromText(text) {
  const tags = [];
  for (const match of String(text || "").matchAll(/[#_＃]([^\s#_＃@，,。；;]+)/gu)) {
    const tag = match[1].trim();
    if (tag && tag.length <= 30 && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 20);
}

function mergeTags(...groups) {
  const tags = [];
  const seen = new Set();
  for (const group of groups) {
    for (const tag of group || []) {
      const value = String(tag || "").trim();
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      tags.push(value);
      if (tags.length >= 20) return tags;
    }
  }
  return tags;
}

function isoFromCreateTime(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return "";
  }
}

function normalizeIsoDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function dateOnlyIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  return `${value}T00:00:00.000Z`;
}

function* walkFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of safeReadDirEntries(current)) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function fileFromRow(row, type) {
  if (!row?.source_path) return null;
  return safeStoredFile(row.source_path, type, row.id);
}

function safeStoredFile(filePath, type, id = "") {
  const normalized = path.resolve(filePath);
  if (!fs.existsSync(normalized)) return null;
  return { id: id || hashText(normalized).slice(0, 16), path: normalized, type, ext: path.extname(normalized).toLowerCase() };
}

function coverFileName(row) {
  const id = String(row?.id || row?.aweme_id || "short-video").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "short-video";
  const stamp = String(row?.mtime_ms || "");
  const hash = hashText(`${row?.source_path || ""}:${stamp}`).slice(0, 16);
  return `${id}-${hash}.jpg`;
}

function asciiInputPath(sourcePath, tempDir, token = "") {
  if (/^[\x00-\x7F]+$/.test(sourcePath) && sourcePath.length < 240) return { path: sourcePath, cleanup: null };
  const ext = path.extname(sourcePath) || ".mp4";
  const tempPath = path.join(tempDir, `_short-video-source-${hashText(`${sourcePath}:${token}`).slice(0, 16)}${ext}`);
  try {
    fs.rmSync(tempPath, { force: true });
  } catch {}
  try {
    fs.linkSync(sourcePath, tempPath);
  } catch {
    fs.copyFileSync(sourcePath, tempPath);
  }
  return {
    path: tempPath,
    cleanup: () => {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
    }
  };
}

function normalizeRoots(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((item) => String(item || "").trim()).filter(Boolean).map((item) => path.resolve(item)))];
}

function rootStatus(root) {
  return { path: root, exists: fs.existsSync(root) && fs.statSync(root).isDirectory() };
}

function metaValue(db, key) {
  return db.prepare("SELECT value FROM short_video_meta WHERE key = ?").get(key)?.value || "";
}

function normalizeSort(value) {
  const sort = String(value || "published").trim();
  return ["recommended", "liked", "watched", "published", "publishedAsc", "likes", "likesAsc", "comments", "duration"].includes(sort) ? sort : "published";
}

function videoFilter(params = new URLSearchParams()) {
  const q = String(params.get("q") || params.get("search") || "").trim();
  const topic = normalizeTopicFilter(params.get("topic") || params.get("tag"));
  const sound = normalizeSoundFilter(params.get("sound") || params.get("music"));
  const soundKey = decodeShortVideoSoundKey(sound);
  const author = String(params.get("author") || "").trim();
  const source = normalizeSourceFilter(params.get("source") || params.get("origin"));
  const media = normalizeMediaFilter(params.get("media") || params.get("type"));
  const whereParts = [];
  const args = [];
  if (!includePendingShortVideos(params)) {
    whereParts.push("visibility = 'local_only'");
  }
  if (q) {
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
    whereParts.push("media_type = ?");
    args.push(media);
  }
  if (source === "recommended") {
    whereParts.push("user_dislike_active = 0");
  } else if (source === "liked") {
    whereParts.push("origin IN ('douyin_like_import', 'douyin_download_manager_like')");
  } else if (source === "following") {
    whereParts.push("author_following = 1");
  } else if (source === "history") {
    whereParts.push("last_watched_at <> ''");
  } else if (source === "posts") {
    whereParts.push("origin = 'douyin_download_manager_post'");
  } else if (source === "local") {
    whereParts.push("origin NOT IN ('douyin_like_import', 'douyin_download_manager_like', 'douyin_download_manager_post')");
  }
  return { q, topic, sound, soundKey, author, media, source, where: whereParts.join(" AND "), args };
}

function normalizeTopicFilter(value) {
  return String(value || "").trim().replace(/^#+/, "").slice(0, 48);
}

function normalizeSoundFilter(value) {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,1000}$/.test(token) ? token : "";
}

function encodeShortVideoSoundKey(value) {
  const key = String(value || "");
  return key ? Buffer.from(key, "utf8").toString("base64url") : "";
}

function decodeShortVideoSoundKey(value) {
  try {
    const decoded = Buffer.from(normalizeSoundFilter(value), "base64url").toString("utf8");
    return decoded.length <= 600 ? decoded : "";
  } catch {
    return "";
  }
}

function normalizeMediaFilter(value) {
  const media = String(value || "all").trim().toLowerCase();
  return ["video", "gallery"].includes(media) ? media : "all";
}

function formatSuggestionCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Number(value || 0)));
}

function includePendingShortVideos(params = new URLSearchParams()) {
  const value = String(params.get("includePending") || params.get("pending") || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function normalizeSourceFilter(value) {
  const source = String(value || "liked").trim().toLowerCase();
  return ["recommended", "liked", "following", "history", "posts", "all", "local"].includes(source) ? source : "liked";
}

function adjacentOrder(urlOrOptions = {}) {
  const params = urlOrOptions?.searchParams || new URLSearchParams();
  const sort = normalizeSort(params.get("sort"));
  return {
    recommended: { column: "recommendation_order_score", fallback: "published_at", numeric: true },
    liked: { column: "liked_at", fallback: "mtime_ms", numeric: false },
    watched: { column: "last_watched_at", fallback: "published_at", numeric: false },
    published: { column: "published_at", fallback: "liked_at", numeric: false },
    publishedAsc: {
      column: "published_at",
      expression: "COALESCE(NULLIF(published_at, ''), '9999-12-31T23:59:59.999Z')",
      fallback: "liked_at",
      numeric: false,
      direction: "ASC",
      value: (item) => item.published_at || "9999-12-31T23:59:59.999Z"
    },
    likes: { column: "digg_count", fallback: "liked_at", numeric: true },
    likesAsc: { column: "digg_count", fallback: "liked_at", numeric: true, direction: "ASC" },
    comments: { column: "comment_count", fallback: "liked_at", numeric: true },
    duration: { column: "duration_ms", fallback: "liked_at", numeric: true }
  }[sort] || { column: "published_at", fallback: "liked_at", numeric: false };
}

function adjacentRow(database, row, direction, order, includeAllColumns = false, filter = null) {
  if (!row) return null;
  const column = order.expression || order.column;
  const fallback = order.fallback;
  const value = order.value ? order.value(row) : row[order.column] ?? (order.numeric ? 0 : "");
  const fallbackValue = row[fallback] ?? (order.numeric ? "" : "");
  const select = includeAllColumns ? "*" : "id";
  const ascending = String(order.direction || "DESC").toUpperCase() === "ASC";
  const movingNext = direction > 0;
  const operator = movingNext === ascending ? ">" : "<";
  const sortDirection = movingNext
    ? (ascending ? "ASC" : "DESC")
    : (ascending ? "DESC" : "ASC");
  const filterWhere = filter?.where ? `${filter.where} AND ` : "";
  const filterArgs = filter?.args || [];
  return database.prepare(`
    SELECT ${select}
    FROM short_video_catalog
    WHERE ${filterWhere}(
      ${column} ${operator} ?
      OR (${column} = ? AND ${fallback} ${operator} ?)
      OR (${column} = ? AND ${fallback} = ? AND id ${operator} ?)
    )
    ORDER BY ${column} ${sortDirection}, ${fallback} ${sortDirection}, id ${sortDirection}
    LIMIT 1
  `).get(...filterArgs, value, value, fallbackValue, value, fallbackValue, row.id || "");
}

function runSqliteBusyRetry(fn, attempts = 8) {
  let delayMs = 100;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= attempts) throw error;
      sleepSync(delayMs);
      delayMs = Math.min(delayMs * 2, 3000);
    }
  }
  return fn();
}

function isSqliteBusy(error) {
  return error?.errcode === 5 || /database is locked|SQLITE_BUSY/i.test(String(error?.message || error));
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function optionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, (match) => `\\${match}`);
}

function uniqueTextArray(values, options = {}) {
  const maxItems = clampInt(options.maxItems, 1000, 0, 10000);
  const maxLength = clampInt(options.maxLength, 1000, 1, 10000);
  const seen = new Set();
  const result = [];
  for (const item of values || []) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value.length > maxLength ? value.slice(0, maxLength) : value);
    if (result.length >= maxItems) break;
  }
  return result;
}

function isPathInsideRoot(filePath, rootPath) {
  const resolvedFile = path.resolve(filePath).toLowerCase();
  const resolvedRoot = path.resolve(rootPath).toLowerCase();
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${path.sep.toLowerCase()}`);
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if ([".mp4", ".m4v"].includes(ext)) return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".flac") return "audio/flac";
  return "";
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

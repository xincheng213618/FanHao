import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";
import {
  actualVideoQualityWhere,
  normalizeSourceFilter,
  shortVideoMediaWhere
} from "./query-contract.js";

export function createShortVideoNavigationQueries({
  listVideoColumns,
  normalizeSort,
  statisticsKnown
}) {
  if (!String(listVideoColumns || "").trim()) {
    throw new Error("short-video navigation queries require listVideoColumns");
  }
  if (typeof normalizeSort !== "function" || typeof statisticsKnown !== "function") {
    throw new Error("short-video navigation queries require sort and statistics contracts");
  }

  function adjacentOrder(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const requestedSort = normalizeSort(params.get("sort"));
    const source = normalizeSourceFilter(params.get("source"));
    const sort = source === "liked" && requestedSort === "published"
      ? "liked"
      : source === "liked" && requestedSort === "publishedAsc"
        ? "likedAsc"
        : requestedSort;
    return {
      recommended: { column: "recommendation_order_score", fallback: "published_at", numeric: true },
      liked: {
        column: "liked_sort_time",
        fallback: "liked_sort_at",
        numeric: true,
        keys: [
          { expression: "COALESCE(liked_sort_time, -1)", value: (item) => item.liked_sort_time ?? -1, direction: "DESC" },
          { column: "liked_sort_at", direction: "DESC" },
          { column: "published_at", direction: "DESC" },
          { column: "id", direction: "DESC" }
        ]
      },
      likedAsc: {
        column: "liked_sort_time",
        fallback: "liked_sort_at",
        numeric: true,
        direction: "ASC",
        keys: [
          { expression: "COALESCE(liked_sort_time, 1000000000000)", value: (item) => item.liked_sort_time ?? 1000000000000, direction: "ASC" },
          { column: "liked_sort_at", direction: "ASC" },
          { column: "published_at", direction: "ASC" },
          { column: "id", direction: "DESC" }
        ]
      },
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
      likesAsc: {
        column: "digg_count",
        expression: `CASE
          WHEN COALESCE(digg_count, 0) > 0
            OR COALESCE(comment_count, 0) > 0
            OR COALESCE(collect_count, 0) > 0
            OR COALESCE(share_count, 0) > 0
          THEN COALESCE(digg_count, 0)
          ELSE 1000000000000
        END`,
        fallback: "liked_at",
        numeric: true,
        direction: "ASC",
        value: (item) => statisticsKnown(item) ? Number(item.digg_count || 0) : 1000000000000
      },
      comments: { column: "comment_count", fallback: "liked_at", numeric: true },
      duration: { column: "duration_ms", fallback: "liked_at", numeric: true }
    }[sort] || { column: "published_at", fallback: "liked_at", numeric: false };
  }

  function fastHistoryAdjacentRows(database, row, direction, filter, order, limit) {
    const eligible = filter.source === "history"
      && filter.deleted === "all"
      && !filter.q
      && !filter.topic
      && !filter.soundKey
      && !filter.author
      && order?.column === "last_watched_at";
    if (!eligible) return null;

    const movingNext = direction > 0;
    const operator = movingNext ? "<" : ">";
    const sortDirection = movingNext ? "DESC" : "ASC";
    const lastWatchedAt = String(row.last_watched_at || "");
    const publishedAt = String(row.published_at || "");
    const currentId = String(row.id || "");
    const whereParts = [
      `w.local_user_id = '${LOCAL_SHORT_VIDEO_USER_ID}'`,
      "w.last_watched_at <> ''"
    ];
    if (!filter.includePending) whereParts.push("v.visibility = 'local_only'");
    const qualityWhere = actualVideoQualityWhere(filter.quality, "v.");
    if (qualityWhere) {
      if (filter.quality === "unknown") whereParts.push(shortVideoMediaWhere("video", "v."));
      whereParts.push(qualityWhere);
    } else if (filter.media !== "all") {
      whereParts.push(shortVideoMediaWhere(filter.media, "v."));
    }
    const ids = database.prepare(`
      SELECT v.id
      FROM short_video_watch_history w INDEXED BY idx_short_video_watch_history_recent_video
      JOIN short_videos v ON v.id = w.video_id
      WHERE ${whereParts.join(" AND ")} AND (
        w.last_watched_at ${operator} ?
        OR (w.last_watched_at = ? AND v.published_at ${operator} ?)
        OR (w.last_watched_at = ? AND v.published_at = ? AND v.id ${operator} ?)
      )
      ORDER BY
        w.last_watched_at ${sortDirection},
        v.published_at ${sortDirection},
        v.id ${sortDirection}
      LIMIT ?
    `).all(
      lastWatchedAt,
      lastWatchedAt,
      publishedAt,
      lastWatchedAt,
      publishedAt,
      currentId,
      Math.max(1, Number(limit || 1))
    ).map((item) => String(item.id || "")).filter(Boolean);
    if (!ids.length) return [];

    const placeholders = ids.map(() => "?").join(", ");
    const rows = database.prepare(`
      SELECT ${listVideoColumns}
      FROM short_video_catalog
      WHERE id IN (${placeholders})
    `).all(...ids);
    const byId = new Map(rows.map((item) => [String(item.id || ""), item]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function adjacentRow(database, row, direction, order, includeAllColumns = false, filter = null) {
    return adjacentRows(database, row, direction, order, includeAllColumns, filter, 1)[0] || null;
  }

  function fastLikedAdjacentRows(database, row, direction, filter, order, limit) {
    const eligible = filter.source === "liked"
      && filter.deleted === "all"
      && !filter.q
      && !filter.topic
      && !filter.soundKey
      && !filter.author
      && order?.column === "liked_sort_time";
    if (!eligible) return null;

    const likedSortAt = "v.liked_sort_at";
    const ascending = String(order.direction || "DESC").toUpperCase() === "ASC";
    const likedSortTime = `COALESCE(v.liked_sort_time, ${ascending ? "1000000000000" : "-1"})`;
    const currentTime = Number(order.value ? order.value(row) : row.liked_sort_time);
    const normalizedCurrentTime = Number.isFinite(currentTime)
      ? currentTime
      : (ascending ? 1000000000000 : -1);
    const currentSortAt = String(row.liked_sort_at || "");
    const currentPublishedAt = String(row.published_at || "");
    const currentId = String(row.id || "");
    const movingNext = direction > 0;
    const primaryOperator = movingNext === ascending ? ">" : "<";
    const idOperator = movingNext ? "<" : ">";
    const primarySortDirection = movingNext
      ? (ascending ? "ASC" : "DESC")
      : (ascending ? "DESC" : "ASC");
    const idSortDirection = movingNext ? "DESC" : "ASC";
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
    whereParts.push("v.is_liked = 1");
    const indexHint = qualityWhere ? "INDEXED BY idx_short_videos_actual_pixels" : "";
    const ids = database.prepare(`
      SELECT v.id
      FROM short_videos v ${indexHint}
      WHERE ${whereParts.join(" AND ")} AND (
        ${likedSortTime} ${primaryOperator} ?
        OR (${likedSortTime} = ? AND ${likedSortAt} ${primaryOperator} ?)
        OR (${likedSortTime} = ? AND ${likedSortAt} = ? AND v.published_at ${primaryOperator} ?)
        OR (${likedSortTime} = ? AND ${likedSortAt} = ? AND v.published_at = ? AND v.id ${idOperator} ?)
      )
      ORDER BY
        ${likedSortTime} ${primarySortDirection},
        ${likedSortAt} ${primarySortDirection},
        v.published_at ${primarySortDirection},
        v.id ${idSortDirection}
      LIMIT ?
    `).all(
      ...args,
      normalizedCurrentTime,
      normalizedCurrentTime,
      currentSortAt,
      normalizedCurrentTime,
      currentSortAt,
      currentPublishedAt,
      normalizedCurrentTime,
      currentSortAt,
      currentPublishedAt,
      currentId,
      Math.max(1, Number(limit || 1))
    ).map((item) => String(item.id || "")).filter(Boolean);
    if (!ids.length) return [];

    const placeholders = ids.map(() => "?").join(", ");
    const rows = database.prepare(`
      SELECT ${listVideoColumns}
      FROM short_video_catalog
      WHERE id IN (${placeholders})
    `).all(...ids);
    const byId = new Map(rows.map((item) => [String(item.id || ""), item]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function fastPublishedAdjacentRows(database, row, direction, filter, order, limit) {
    const author = String(filter?.author || "").trim();
    const eligible = !filter.q
      && filter.deleted === "all"
      && !filter.topic
      && !filter.soundKey
      && ["liked", "posts", "all", "local"].includes(filter.source)
      && order?.column === "published_at";
    if (!eligible) return null;

    const movingNext = direction > 0;
    const whereParts = [];
    const args = [];
    if (!filter.includePending) whereParts.push("v.visibility = 'local_only'");
    if (author && author !== "all") {
      if (author.startsWith("name:")) {
        whereParts.push("v.author_name = ?");
        args.push(author.slice(5));
      } else {
        whereParts.push("v.author_sec_uid = ?");
        args.push(author);
      }
    }
    const qualityWhere = actualVideoQualityWhere(filter.quality, "v.");
    if (qualityWhere) {
      if (filter.quality === "unknown") whereParts.push(shortVideoMediaWhere("video", "v."));
      whereParts.push(qualityWhere);
    } else if (filter.media !== "all") {
      whereParts.push(shortVideoMediaWhere(filter.media, "v."));
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
    const publishedExpression = order.expression
      ? "COALESCE(NULLIF(v.published_at, ''), '9999-12-31T23:59:59.999Z')"
      : "v.published_at";
    const publishedAt = order.value ? order.value(row) : row.published_at || "";
    const likedAt = row.liked_at || "";
    const ascending = String(order.direction || "DESC").toUpperCase() === "ASC";
    const operator = movingNext === ascending ? ">" : "<";
    const sortDirection = movingNext
      ? (ascending ? "ASC" : "DESC")
      : (ascending ? "DESC" : "ASC");
    const indexHint = qualityWhere
      ? "INDEXED BY idx_short_videos_actual_pixels"
      : author && author !== "all" && !author.startsWith("name:")
        ? "INDEXED BY idx_short_videos_author_published"
        : "INDEXED BY idx_short_videos_published";
    const ids = database.prepare(`
      SELECT v.id
      FROM short_videos v ${indexHint}
      WHERE ${whereParts.length ? `${whereParts.join(" AND ")} AND ` : ""}
        (${publishedExpression}, v.liked_at, v.id) ${operator} (?, ?, ?)
      ORDER BY ${publishedExpression} ${sortDirection}, v.liked_at ${sortDirection}, v.id ${sortDirection}
      LIMIT ?
    `).all(
      ...args,
      publishedAt,
      likedAt,
      row.id || "",
      Math.max(1, Number(limit || 1))
    ).map((item) => String(item.id || "")).filter(Boolean);
    if (!ids.length) return [];

    const placeholders = ids.map(() => "?").join(", ");
    const rows = database.prepare(`
      SELECT ${listVideoColumns}
      FROM short_video_catalog
      WHERE id IN (${placeholders})
    `).all(...ids);
    const byId = new Map(rows.map((item) => [String(item.id || ""), item]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function fastMetricAdjacentRows(database, row, direction, filter, order, limit) {
    const eligibleColumns = new Set(["digg_count", "comment_count", "collect_count", "share_count", "duration_ms"]);
    const likesAscending = order.column === "digg_count"
      && String(order.direction || "").toUpperCase() === "ASC"
      && Boolean(order.expression);
    const eligible = !filter.q
      && filter.deleted === "all"
      && !filter.topic
      && !filter.soundKey
      && !filter.author
      && ["all", "liked", "following", "posts", "local"].includes(filter.source)
      && (!order.expression || likesAscending)
      && eligibleColumns.has(order.column)
      && order.fallback === "liked_at";
    if (!eligible) return null;

    const metricExpression = likesAscending
      ? `CASE
          WHEN COALESCE(v.digg_count, 0) > 0
            OR COALESCE(v.comment_count, 0) > 0
            OR COALESCE(v.collect_count, 0) > 0
            OR COALESCE(v.share_count, 0) > 0
          THEN COALESCE(v.digg_count, 0)
          ELSE 1000000000000
        END`
      : order.column === "duration_ms"
        ? "COALESCE(v.duration_ms, 0)"
        : order.column === "digg_count"
          ? "v.digg_count"
          : `COALESCE(v.${order.column}, 0)`;
    const metricValue = Math.max(0, Number(order.value ? order.value(row) : row[order.column] || 0));
    const likedAt = String(row.liked_at || "");
    const ascending = String(order.direction || "DESC").toUpperCase() === "ASC";
    const movingNext = direction > 0;
    const operator = movingNext === ascending ? ">" : "<";
    const sortDirection = movingNext
      ? (ascending ? "ASC" : "DESC")
      : (ascending ? "DESC" : "ASC");
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
    const indexHint = qualityWhere
      ? "INDEXED BY idx_short_videos_actual_pixels"
      : filter.source === "following" && order.column === "digg_count" && filter.media === "video"
        ? "INDEXED BY idx_short_videos_following_media_digg"
        : order.column === "digg_count" && filter.media === "video"
          ? "INDEXED BY idx_short_videos_media_digg"
          : "";
    const ids = database.prepare(`
      SELECT v.id
      FROM short_videos v ${indexHint}
      WHERE ${whereParts.length ? `${whereParts.join(" AND ")} AND ` : ""}(
        ${metricExpression} ${operator} ?
        OR (${metricExpression} = ? AND v.liked_at ${operator} ?)
        OR (${metricExpression} = ? AND v.liked_at = ? AND v.id ${operator} ?)
      )
      ORDER BY ${metricExpression} ${sortDirection}, v.liked_at ${sortDirection}, v.id ${sortDirection}
      LIMIT ?
    `).all(
      ...args,
      metricValue,
      metricValue,
      likedAt,
      metricValue,
      likedAt,
      row.id || "",
      Math.max(1, Number(limit || 1))
    ).map((item) => String(item.id || "")).filter(Boolean);
    if (!ids.length) return [];

    const placeholders = ids.map(() => "?").join(", ");
    const rows = database.prepare(`
      SELECT ${listVideoColumns}
      FROM short_video_catalog
      WHERE id IN (${placeholders})
    `).all(...ids);
    const byId = new Map(rows.map((item) => [String(item.id || ""), item]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function adjacentRows(database, row, direction, order, includeAllColumns = false, filter = null, limit = 1) {
    if (!row) return [];
    if (Array.isArray(order?.keys) && order.keys.length) {
      return multiColumnAdjacentRows(database, row, direction, order.keys, includeAllColumns, filter, limit);
    }
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
      LIMIT ?
    `).all(...filterArgs, value, value, fallbackValue, value, fallbackValue, row.id || "", Math.max(1, Number(limit || 1)));
  }

  function multiColumnAdjacentRows(database, row, direction, keys, includeAllColumns = false, filter = null, limit = 1) {
    const normalizedKeys = keys.map((key) => ({
      expression: key.expression || key.column,
      value: typeof key.value === "function" ? key.value(row) : row[key.column] ?? "",
      direction: String(key.direction || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC"
    }));
    const movingNext = direction > 0;
    const conditions = [];
    const orderArgs = [];
    for (let index = 0; index < normalizedKeys.length; index += 1) {
      const current = normalizedKeys[index];
      const operator = movingNext === (current.direction === "ASC") ? ">" : "<";
      const equalities = normalizedKeys.slice(0, index).map((key) => `${key.expression} = ?`);
      conditions.push(`(${[...equalities, `${current.expression} ${operator} ?`].join(" AND ")})`);
      for (let previous = 0; previous < index; previous += 1) orderArgs.push(normalizedKeys[previous].value);
      orderArgs.push(current.value);
    }
    const orderBy = normalizedKeys.map((key) => {
      const sqlDirection = movingNext
        ? key.direction
        : key.direction === "ASC" ? "DESC" : "ASC";
      return `${key.expression} ${sqlDirection}`;
    }).join(", ");
    const filterWhere = filter?.where ? `${filter.where} AND ` : "";
    const filterArgs = filter?.args || [];
    const select = includeAllColumns ? "*" : "id";
    return database.prepare(`
      SELECT ${select}
      FROM short_video_catalog
      WHERE ${filterWhere}(${conditions.join(" OR ")})
      ORDER BY ${orderBy}
      LIMIT ?
    `).all(...filterArgs, ...orderArgs, Math.max(1, Number(limit || 1)));
  }

  return {
    adjacentOrder,
    adjacentRow,
    adjacentRows,
    fastHistoryAdjacentRows,
    fastLikedAdjacentRows,
    fastMetricAdjacentRows,
    fastPublishedAdjacentRows
  };
}

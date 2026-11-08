import { videoFilter } from "./query-contract.js";
import { hasCanonicalShortVideoCatalogViews } from "./schema.js";

const STATS_FILTER_FIELDS = [
  "q",
  "topic",
  "sound",
  "author",
  "source",
  "media",
  "quality",
  "deleted",
  "includePending"
];
const STATS_COLUMNS = "digg_count, comment_count, collect_count, share_count, play_count, size_bytes, duration_ms";
const STATS_UNUSED_JOINS = new Set([
  "u", "user_like", "user_collect", "user_dislike", "watch_history", "sound_index",
  "native_cover_asset", "ffmpeg_cover_asset", "legacy_cover_asset", "music_asset"
]);

export function normalizeShortVideoStatsFilter(input = new URLSearchParams()) {
  const params = input instanceof URLSearchParams
    ? input
    : shortVideoStatsFilterParams(input);
  const filter = videoFilter(params);
  return {
    q: filter.q,
    topic: filter.topic,
    sound: filter.sound,
    author: filter.author,
    source: filter.source,
    media: filter.media,
    quality: filter.quality,
    deleted: filter.deleted,
    includePending: filter.includePending
  };
}

export function shortVideoStatsFilterKey(input = {}) {
  const filter = normalizeShortVideoStatsFilter(input);
  return JSON.stringify(STATS_FILTER_FIELDS.map((field) => filter[field]));
}

export function queryShortVideoStats(database, input = {}) {
  const params = input instanceof URLSearchParams
    ? input
    : shortVideoStatsFilterParams(input);
  const filter = videoFilter(params);
  const where = filter.where ? `WHERE ${filter.where}` : "";
  const aggregates = `
    SELECT
      COALESCE(SUM(digg_count), 0) AS likes,
      COALESCE(SUM(comment_count), 0) AS comments,
      COALESCE(SUM(collect_count), 0) AS collects,
      COALESCE(SUM(share_count), 0) AS shares,
      COALESCE(SUM(play_count), 0) AS plays,
      COALESCE(SUM(size_bytes), 0) AS bytes,
      COALESCE(SUM(duration_ms), 0) AS durationMs
  `;
  const source = `FROM short_video_catalog ${where}`;
  const sql = `${aggregates}${source}`;
  const simple = ["all", "liked", "following"].includes(filter.source) && !filter.q && !filter.topic && !filter.soundKey
    && (!filter.author || filter.author === "all") && filter.deleted === "all";
  const row = simple
    ? readProjectedStats(database, sql, `${aggregates} FROM (SELECT ${STATS_COLUMNS} ${source} LIMIT -1 OFFSET 0)`, filter.args)
    : database.prepare(sql).get(...filter.args);
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

function readProjectedStats(database, originalSql, projectedSql, args) {
  try { database.exec("SAVEPOINT short_video_stats_projection"); }
  catch { return database.prepare(originalSql).get(...args); }
  let readFailed = false;
  try {
    const original = database.prepare(originalSql);
    let projected;
    try {
      // Read the actual view definitions and both plans in the same snapshot.
      if (hasCanonicalShortVideoCatalogViews(database)) {
        const before = database.prepare(`EXPLAIN QUERY PLAN ${originalSql}`).all(...args);
        const after = database.prepare(`EXPLAIN QUERY PLAN ${projectedSql}`).all(...args);
        if (sameStatsScan(before, after)) projected = database.prepare(projectedSql);
      }
    } catch {}
    return (projected ?? original).get(...args);
  } catch (error) {
    readFailed = true;
    throw error;
  } finally {
    try { database.exec("RELEASE short_video_stats_projection"); }
    catch (error) { if (!readFailed) throw error; }
  }
}

function sameStatsScan(before, after) {
  // OFFSET keeps this projection streaming and lets SQLite omit unused
  // one-to-one joins before SUM. Retain the scans that determine sum order.
  const [coroutine, ...steps] = after;
  if (!coroutine?.detail.startsWith("CO-ROUTINE ")
    || steps.pop()?.detail !== `SCAN ${coroutine.detail.slice("CO-ROUTINE ".length)}`
    || steps.length >= before.length || steps.some(row => row.parent !== coroutine.id)) return false;
  let next = 0;
  for (const { detail, parent } of before) {
    if (parent !== 0) return false;
    if (detail === steps[next]?.detail) next++;
    else if (!detail.endsWith(" LEFT-JOIN") || !STATS_UNUSED_JOINS.has(detail.split(" ")[1])) return false;
  }
  return next === steps.length;
}

function shortVideoStatsFilterParams(input = {}) {
  const params = new URLSearchParams();
  for (const field of STATS_FILTER_FIELDS) {
    const value = input?.[field];
    if (field === "includePending") {
      if (value === true) params.set("includePending", "1");
    } else if (value !== undefined && value !== null && String(value) !== "") {
      params.set(field, String(value));
    }
  }
  return params;
}

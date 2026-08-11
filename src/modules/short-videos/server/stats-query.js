import { videoFilter } from "./query-contract.js";

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
  const row = database.prepare(`
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
  `).get(...filter.args);
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

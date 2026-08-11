export const SHORT_VIDEO_RESERVED_DETAIL_SEGMENT_NAMES = Object.freeze([
  "authors",
  "collections",
  "facets",
  "like-distribution",
  "quality-upgrades",
  "rescan",
  "stats",
  "suggestions",
  "summary",
  "transcoding",
  "videos"
]);

export const SHORT_VIDEO_RESERVED_DETAIL_SEGMENTS = new Set(SHORT_VIDEO_RESERVED_DETAIL_SEGMENT_NAMES);

export function decodeShortVideoDetailSegment(value) {
  try {
    return { ok: true, value: decodeURIComponent(String(value || "")) };
  } catch {
    return { ok: false, value: "" };
  }
}

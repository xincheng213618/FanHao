export const DEFAULT_LIMIT = 12;
export const AUTHOR_PAGE_LIMIT = 12;
export const AUTHOR_INITIAL_COUNT = 24;
export const AUTHOR_APPEND_COUNT = 18;
export const DEFAULT_SORT = "published";
export const DEFAULT_SOURCE = "liked";
export const SHORT_VIDEO_SORT_OPTIONS = [
  ["published", "时间倒序"],
  ["publishedAsc", "时间正序"],
  ["liked", "最近点赞"],
  ["likes", "点赞最多"],
  ["likesAsc", "点赞最少"],
  ["comments", "评论最多"],
  ["duration", "时长最长"]
];

export function normalizeSort(value) {
  const sort = String(value || DEFAULT_SORT).trim();
  return ["liked", "published", "publishedAsc", "likes", "likesAsc", "comments", "duration"].includes(sort) ? sort : DEFAULT_SORT;
}

export function shortVideoSortLabel(value) {
  const sort = normalizeSort(value);
  const item = SHORT_VIDEO_SORT_OPTIONS.find(([key]) => key === sort);
  return item?.[1] || "时间倒序";
}

export function normalizeSource(value) {
  const source = String(value || DEFAULT_SOURCE).trim().toLowerCase();
  return ["liked", "authors", "posts", "all", "local"].includes(source) ? source : DEFAULT_SOURCE;
}

export function selectOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

export function formatDuration(ms) {
  const seconds = Math.round(Number(ms || 0) / 1000);
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function initials(value) {
  return String(value || "?").trim().slice(0, 2).toUpperCase();
}

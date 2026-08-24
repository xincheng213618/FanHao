export const DEFAULT_SHORT_VIDEO_SORT = "published";
export const DEFAULT_SHORT_VIDEO_SOURCE = "liked";

export function normalizeShortVideoSort(value) {
  const sort = String(value || DEFAULT_SHORT_VIDEO_SORT).trim();
  return ["recommended", "watched", "liked", "published", "publishedAsc", "likes", "likesAsc", "comments", "duration", "size"].includes(sort)
    ? sort
    : DEFAULT_SHORT_VIDEO_SORT;
}

export function normalizeShortVideoSource(value) {
  const source = String(value || DEFAULT_SHORT_VIDEO_SOURCE).trim().toLowerCase();
  return ["recommended", "liked", "following", "history", "authors", "posts", "all", "local"].includes(source)
    ? source
    : DEFAULT_SHORT_VIDEO_SOURCE;
}

export function normalizeShortVideoSortForSource(sourceValue, sortValue) {
  const source = normalizeShortVideoSource(sourceValue);
  const sort = normalizeShortVideoSort(sortValue);
  if (source === "recommended") return sort === "published" ? "recommended" : sort;
  if (source === "history") return sort === "published" ? "watched" : sort;
  return ["recommended", "watched"].includes(sort) ? DEFAULT_SHORT_VIDEO_SORT : sort;
}

export function normalizeFollowingAuthorSort(value) {
  const sort = String(value || "followed").trim().toLowerCase();
  return ["followed", "count", "liked"].includes(sort) ? sort : "followed";
}

export function normalizeFollowingAuthorFilter(value) {
  return String(value || "all").trim().toLowerCase() === "unliked" ? "unliked" : "all";
}

export function normalizeAuthorAccountStatus(value) {
  return String(value || "all").trim().toLowerCase() === "banned" ? "banned" : "all";
}

export function normalizeShortVideoSearchTab(value) {
  const tab = String(value || "all").trim().toLowerCase();
  return ["all", "videos", "authors"].includes(tab) ? tab : "all";
}

export function canonicalShortVideoViewParams(view, params = {}) {
  if (view === "shortVideoCollections") return {};
  if (view === "shortVideoCollection") {
    const collectionId = String(params.collectionId || params.id || "").trim();
    return collectionId ? { collectionId } : {};
  }
  const query = String(params.query || params.q || "").trim();
  const author = String(params.author || "all").trim() || "all";
  const source = normalizeShortVideoSource(params.source || params.origin);
  const sort = normalizeShortVideoSortForSource(source, params.sort);
  const authorSort = normalizeFollowingAuthorSort(params.authorSort);
  const authorFilter = normalizeFollowingAuthorFilter(params.authorFilter);
  const authorAccountStatus = normalizeAuthorAccountStatus(params.authorAccountStatus || params.account);
  const searchTab = normalizeShortVideoSearchTab(params.searchTab || params.tab);
  return {
    ...(query ? { query } : {}),
    ...(author !== "all" ? { author } : {}),
    ...(source !== DEFAULT_SHORT_VIDEO_SOURCE ? { source } : {}),
    ...(sort !== DEFAULT_SHORT_VIDEO_SORT ? { sort } : {}),
    ...(source === "following" && authorSort !== "followed" ? { authorSort } : {}),
    ...(source === "following" && authorFilter !== "all" ? { authorFilter } : {}),
    ...(source === "authors" && authorAccountStatus !== "all" ? { account: authorAccountStatus } : {}),
    ...(view === "shortVideoSearch" && searchTab !== "all" ? { tab: searchTab } : {})
  };
}

const SHORT_VIDEO_PATH_NAMES = new Set(["short-videos", "short-video", "douyin"]);
const SHORT_VIDEO_SORT_NAMES = new Set([
  "recommended",
  "liked",
  "watched",
  "published",
  "publishedAsc",
  "likes",
  "likesAsc",
  "comments",
  "duration"
]);
const SHORT_VIDEO_SOURCE_NAMES = new Set([
  "recommended",
  "liked",
  "following",
  "history",
  "posts",
  "authors",
  "all",
  "local"
]);
const SHORT_VIDEO_MEDIA_NAMES = new Set(["video", "gallery"]);
const SHORT_VIDEO_QUALITY_NAMES = new Set(["4k", "1440p", "1080p", "720p", "below720p", "unknown"]);

export function routeFromUrl(url = browserHref()) {
  const parsed = new URL(url, browserHref());
  const segments = normalizePath(parsed.pathname).split("/").filter(Boolean);
  if (!segments.length || !SHORT_VIDEO_PATH_NAMES.has(segments[0])) {
    return { view: "external" };
  }
  const params = parsed.searchParams;
  const likesStatsPage = segments[1] === "stats" && segments[2] === "likes";
  const transcodePage = segments[1] === "transcoding";
  const pathAuthorPage = segments[1] === "authors" ? decodeSegment(segments[2] || "") : "";
  const requestedAuthor = params.get("author") || "all";
  const requestedSource = params.get("source") || params.get("origin") || "";
  const legacyAuthorPage = !segments[1] && requestedSource === "authors" && requestedAuthor !== "all"
    ? requestedAuthor
    : "";
  const authorPage = pathAuthorPage || legacyAuthorPage;
  return normalizeRoute({
    view: "shortVideos",
    shortVideoId: pathAuthorPage || likesStatsPage || transcodePage ? "" : decodeSegment(segments[1] || ""),
    shortVideoAuthorPage: authorPage,
    shortVideoMode: transcodePage ? "transcoding" : likesStatsPage ? "likes" : "feed",
    shortVideoQuery: params.get("q") || params.get("search") || "",
    shortVideoTopic: params.get("topic") || params.get("tag") || "",
    shortVideoSound: params.get("sound") || params.get("music") || "",
    shortVideoAuthor: authorPage || requestedAuthor,
    shortVideoMedia: params.get("media") || params.get("type") || "all",
    shortVideoQuality: params.get("quality") || params.get("resolution") || "all",
    shortVideoDeleted: params.get("deleted") || "all",
    shortVideoSource: authorPage
      ? (requestedSource === "authors" ? "all" : requestedSource || "all")
      : requestedSource,
    shortVideoSort: params.get("sort")
  });
}

export function normalizeRoute(route = {}) {
  if (route.view !== "shortVideos") return { view: String(route.view || "external") };
  const authorPage = String(route.shortVideoAuthorPage || "").trim();
  return {
    view: "shortVideos",
    shortVideoId: String(route.shortVideoId || "").trim(),
    shortVideoAuthorPage: authorPage,
    shortVideoMode: ["likes", "transcoding"].includes(route.shortVideoMode) ? route.shortVideoMode : "feed",
    shortVideoQuery: String(route.shortVideoQuery || route.q || "").trim(),
    shortVideoTopic: normalizeTopic(route.shortVideoTopic || route.topic || route.tag),
    shortVideoSound: normalizeSound(route.shortVideoSound || route.sound || route.music),
    shortVideoAuthor: String(route.shortVideoAuthor || authorPage || "all").trim() || "all",
    shortVideoMedia: normalizeMedia(route.shortVideoMedia || route.media),
    shortVideoQuality: normalizeQuality(route.shortVideoQuality || route.quality || route.resolution),
    shortVideoDeleted: normalizeDeleted(route.shortVideoDeleted || route.deleted),
    shortVideoSource: normalizeSource(route.shortVideoSource || route.source),
    shortVideoSort: normalizeSort(route.shortVideoSort || route.sort)
  };
}

export function routeUrl(route, options = {}) {
  const next = normalizeRoute(route);
  if (next.view !== "shortVideos") return "/fanhao";
  const params = new URLSearchParams();
  const initialParams = options.initialParams || new URLSearchParams(browserSearch());
  for (const key of ["client", "returnTo", "perf"]) {
    const value = initialParams.get(key);
    if (value) params.set(key, value);
  }
  if (!["likes", "transcoding"].includes(next.shortVideoMode)) {
    if (next.shortVideoQuery) params.set("q", next.shortVideoQuery);
    if (next.shortVideoTopic) params.set("topic", next.shortVideoTopic);
    if (next.shortVideoSound) params.set("sound", next.shortVideoSound);
    if (
      next.shortVideoAuthor !== "all"
      && (next.shortVideoId || !next.shortVideoAuthorPage)
    ) {
      params.set("author", next.shortVideoAuthor);
    }
    if (next.shortVideoMedia !== "all") params.set("media", next.shortVideoMedia);
    if (next.shortVideoQuality !== "all") params.set("quality", next.shortVideoQuality);
    if (next.shortVideoDeleted === "deleted") params.set("deleted", "1");
    const defaultSource = next.shortVideoAuthorPage && !next.shortVideoId ? "all" : "liked";
    if (next.shortVideoSource !== defaultSource) params.set("source", next.shortVideoSource);
    if (next.shortVideoSort !== "published") params.set("sort", next.shortVideoSort);
  }
  const pathname = next.shortVideoMode === "likes"
    ? "/short-videos/stats/likes"
    : next.shortVideoMode === "transcoding"
      ? "/short-videos/transcoding"
    : next.shortVideoId
      ? `/short-videos/${encodeURIComponent(next.shortVideoId)}`
      : next.shortVideoAuthorPage
        ? `/short-videos/authors/${encodeURIComponent(next.shortVideoAuthorPage)}`
        : "/short-videos";
  const query = params.toString();
  const hash = options.hash === undefined ? browserHash() : String(options.hash || "");
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

function normalizeSort(value) {
  const normalized = String(value || "published").trim();
  return SHORT_VIDEO_SORT_NAMES.has(normalized) ? normalized : "published";
}

function normalizeSource(value) {
  const normalized = String(value || "liked").trim().toLowerCase();
  return SHORT_VIDEO_SOURCE_NAMES.has(normalized) ? normalized : "liked";
}

function normalizeDeleted(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return ["1", "true", "yes", "deleted"].includes(normalized) ? "deleted" : "all";
}

function normalizeMedia(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return SHORT_VIDEO_MEDIA_NAMES.has(normalized) ? normalized : "all";
}

function normalizeQuality(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return SHORT_VIDEO_QUALITY_NAMES.has(normalized) ? normalized : "all";
}

function normalizeTopic(value) {
  return String(value || "").trim().replace(/^#+/, "").slice(0, 48);
}

function normalizeSound(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,1000}$/.test(normalized) ? normalized : "";
}

function normalizePath(pathname) {
  return String(pathname || "/").replace(/\/+$/g, "") || "/";
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function browserHref() {
  return globalThis.window?.location?.href || "http://127.0.0.1/";
}

function browserSearch() {
  return globalThis.window?.location?.search || "";
}

function browserHash() {
  return globalThis.window?.location?.hash || "";
}

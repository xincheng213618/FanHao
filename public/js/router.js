export const URL_VIEW_NAMES = new Set(["people", "studios", "vr", "favorites", "history", "rankings", "gallery", "novels", "shortVideos", "music", "tools"]);
export const GALLERY_MODE_NAMES = new Set(["photo", "manga", "western", "media", "movie", "tv"]);
export const PEOPLE_SCOPE_NAMES = new Set(["main"]);
export const DEFAULT_GALLERY_PHOTO_CATEGORY = "all";

const GALLERY_MODE_PATHS = {
  photo: "/photo",
  manga: "/photo/manga",
  western: "/western",
  media: "/media",
  movie: "/movies",
  tv: "/tv"
};

const PATH_GALLERY_MODES = new Map([
  ["/gallery", "photo"],
  ["/photo", "photo"],
  ["/photos", "photo"],
  ["/photo-sets", "photo"],
  ["/manga", "manga"],
  ["/western", "western"],
  ["/media", "media"],
  ["/video", "media"],
  ["/videos", "media"],
  ["/movie", "movie"],
  ["/movies", "movie"],
  ["/tv", "tv"]
]);

const VIEW_PATHS = {
  studios: "/fanhao/studios",
  vr: "/fanhao/vr",
  favorites: "/fanhao/favorites",
  history: "/fanhao/history",
  rankings: "/fanhao/rankings",
  novels: "/novels",
  shortVideos: "/short-videos",
  music: "/music",
  tools: "/tools"
};

const PATH_VIEWS = new Map(Object.entries(VIEW_PATHS).map(([view, pathname]) => [pathname, view]));
const LEGACY_PATH_VIEWS = new Map([
  ["/studios", "studios"],
  ["/vr", "vr"],
  ["/favorites", "favorites"],
  ["/history", "history"],
  ["/rankings", "rankings"]
]);

export function routeFromUrl(url = window.location.href) {
  const parsed = new URL(url, window.location.href);
  const params = parsed.searchParams;
  const query = params.get("q") || params.get("search") || "";
  const rawView = params.get("view");
  const routePath = normalizeRoutePath(parsed.pathname);
  const peopleRoute = peopleRouteFromPath(routePath, params);
  if (peopleRoute) return peopleRoute;
  const galleryRoute = galleryRouteFromPath(routePath, params);
  if (galleryRoute) return galleryRoute;
  const novelRoute = novelRouteFromPath(routePath, params);
  if (novelRoute) return novelRoute;
  const shortVideoRoute = shortVideoRouteFromPath(routePath, params);
  if (shortVideoRoute) return shortVideoRoute;
  const musicRoute = musicRouteFromPath(routePath, params);
  if (musicRoute) return musicRoute;
  const pathView = PATH_VIEWS.get(routePath) || LEGACY_PATH_VIEWS.get(routePath);
  if (pathView) {
    return {
      view: pathView,
      galleryMode: "",
      novelBookId: "",
      novelChapterIndex: "",
      novelQuery: "",
      novelCategory: "all",
      novelSort: "updated",
      shortVideoId: "",
      shortVideoAuthorPage: "",
      shortVideoMode: "feed",
      shortVideoQuery: "",
      shortVideoAuthor: "all",
      shortVideoMedia: "all",
      shortVideoQuality: "all",
      shortVideoSource: "liked",
      shortVideoSort: "published",
      musicTrackId: "",
      musicArtistId: "",
      musicAlbumId: "",
      musicGenre: "",
      musicLanguage: "",
      musicMode: "library",
      musicPlaylistId: "",
      musicSmartId: "",
      musicQuery: "",
      musicSort: "album",
      musicArtistSort: "count",
      musicAlbumSort: "updated",
      musicFavorite: false,
      personId: "",
      q: "",
      workId: "",
      videoId: ""
    };
  }
  return {
    view: query ? "search" : URL_VIEW_NAMES.has(rawView) ? rawView : "people",
    galleryMode: GALLERY_MODE_NAMES.has(params.get("mode")) ? params.get("mode") : "",
    peopleScope: PEOPLE_SCOPE_NAMES.has(params.get("scope")) ? params.get("scope") : "main",
    personId: params.get("personId") || params.get("person") || "",
    q: query,
    workId: params.get("workId") || params.get("work") || "",
    videoId: params.get("videoId") || params.get("video") || ""
  };
}

export function normalizeRoute(route = {}) {
  const explicitView = URL_VIEW_NAMES.has(route.view) ? route.view : "";
  const searchQuery = String(route.q || "").trim();
  const view = explicitView || (searchQuery ? "search" : "people");
  const galleryMode = view === "gallery" && GALLERY_MODE_NAMES.has(route.galleryMode) ? route.galleryMode : "";
  const peopleScope = view === "people" && PEOPLE_SCOPE_NAMES.has(route.peopleScope) ? route.peopleScope : "main";
  return {
    view,
    galleryMode,
    peopleScope,
    galleryPhotoView: view === "gallery" && galleryMode === "photo" && route.galleryPhotoView !== "albums" ? "collections" : "albums",
    galleryPhotoCollection: view === "gallery" ? String(route.galleryPhotoCollection || "").trim() : "",
    galleryAlbumId: view === "gallery" ? String(route.galleryAlbumId || "").trim() : "",
    galleryComicId: view === "gallery" ? String(route.galleryComicId || "").trim() : "",
    galleryChapterIndex: view === "gallery" ? String(route.galleryChapterIndex || "").trim() : "",
    galleryMediaId: view === "gallery" ? String(route.galleryMediaId || "").trim() : "",
    galleryQuery: view === "gallery" ? String(route.galleryQuery || "").trim() : "",
    galleryCategory: view === "gallery" ? normalizeGalleryCategory(route) : "all",
    gallerySubCategory: view === "gallery" ? String(route.gallerySubCategory || "all").trim() || "all" : "all",
    galleryPerson: view === "gallery" ? String(route.galleryPerson || "all").trim() || "all" : "all",
    galleryPhotoDate: view === "gallery" ? String(route.galleryPhotoDate || "all").trim() || "all" : "all",
    gallerySort: view === "gallery" ? normalizeGallerySort(route.gallerySort) : "updated",
    novelBookId: view === "novels" ? String(route.novelBookId || "").trim() : "",
    novelChapterIndex: view === "novels" ? String(route.novelChapterIndex || "").trim() : "",
    novelQuery: view === "novels" ? String(route.novelQuery || route.q || "").trim() : "",
    novelCategory: view === "novels" ? String(route.novelCategory || "all").trim() || "all" : "all",
    novelSort: view === "novels" ? normalizeNovelSort(route.novelSort) : "updated",
    novelMode: view === "novels" && ["mine", "authors", "author", "search", "rankings", "manage"].includes(route.novelMode) ? route.novelMode : "books",
    novelAuthor: view === "novels" ? String(route.novelAuthor || "").trim() : "",
    novelPage: view === "novels" ? normalizeNovelPage(route.novelPage) : 0,
    shortVideoId: view === "shortVideos" ? String(route.shortVideoId || "").trim() : "",
    shortVideoAuthorPage: view === "shortVideos" ? String(route.shortVideoAuthorPage || "").trim() : "",
    shortVideoMode: view === "shortVideos" && route.shortVideoMode === "likes" ? "likes" : "feed",
    shortVideoQuery: view === "shortVideos" ? String(route.shortVideoQuery || route.q || "").trim() : "",
    shortVideoTopic: view === "shortVideos" ? normalizeShortVideoTopic(route.shortVideoTopic || route.topic || route.tag) : "",
    shortVideoSound: view === "shortVideos" ? normalizeShortVideoSound(route.shortVideoSound || route.sound || route.music) : "",
    shortVideoAuthor: view === "shortVideos" ? String(route.shortVideoAuthor || "all").trim() || "all" : "all",
    shortVideoMedia: view === "shortVideos" ? normalizeShortVideoMedia(route.shortVideoMedia || route.media) : "all",
    shortVideoQuality: view === "shortVideos" ? normalizeShortVideoQuality(route.shortVideoQuality || route.quality || route.resolution) : "all",
    shortVideoSource: view === "shortVideos" ? normalizeShortVideoSource(route.shortVideoSource || route.source) : "liked",
    shortVideoSort: view === "shortVideos" ? normalizeShortVideoSort(route.shortVideoSort) : "published",
    musicTrackId: view === "music" ? String(route.musicTrackId || "").trim() : "",
    musicArtistId: view === "music" ? String(route.musicArtistId || "").trim() : "",
    musicAlbumId: view === "music" ? String(route.musicAlbumId || "").trim() : "",
    musicGenre: view === "music" ? String(route.musicGenre || route.genre || "").trim() : "",
    musicLanguage: view === "music" ? String(route.musicLanguage || route.language || "").trim() : "",
    musicMode: view === "music" ? normalizeMusicMode(route.musicMode) : "library",
    musicPlaylistId: view === "music" ? String(route.musicPlaylistId || "").trim() : "",
    musicSmartId: view === "music" ? String(route.musicSmartId || "").trim() : "",
    musicQuery: view === "music" ? String(route.musicQuery || route.q || "").trim() : "",
    musicSort: view === "music" ? normalizeMusicSort(route.musicSort) : "album",
    musicArtistSort: view === "music" ? normalizeMusicArtistSort(route.musicArtistSort || route.artistSort) : "count",
    musicAlbumSort: view === "music" ? normalizeMusicAlbumSort(route.musicAlbumSort || route.albumSort) : "updated",
    musicFavorite: view === "music" ? Boolean(route.musicFavorite) : false,
    personId: view === "people" ? route.personId || "" : "",
    q: view === "search" ? searchQuery : "",
    workId: route.workId || "",
    videoId: route.videoId || ""
  };
}

export function routeUrl(route, options = {}) {
  const next = normalizeRoute(route);
  const params = new URLSearchParams();
  const initialParams = options.initialParams || new URLSearchParams(window.location.search);
  for (const key of ["client", "returnTo"]) {
    const value = initialParams.get(key);
    if (value) params.set(key, value);
  }
  const pathname = routePath(next);
  if (next.view && !VIEW_PATHS[next.view] && !["people", "search", "gallery", "novels", "shortVideos", "music", "tools"].includes(next.view)) {
    params.set("view", next.view);
  }
  if (next.personId) params.set("personId", next.personId);
  if (next.view === "gallery") {
    if (next.galleryQuery) params.set("q", next.galleryQuery);
    if (next.galleryCategory && shouldWriteGalleryCategory(next)) params.set("category", next.galleryCategory);
    if (next.gallerySubCategory && next.gallerySubCategory !== "all") params.set("subCategory", next.gallerySubCategory);
    if (next.galleryPerson && next.galleryPerson !== "all") {
      params.set(["tv", "media"].includes(next.galleryMode) ? "series" : "person", next.galleryPerson);
    }
    if (next.galleryMode === "photo" && next.galleryPhotoDate && next.galleryPhotoDate !== "all") params.set("date", next.galleryPhotoDate);
    if (next.gallerySort && next.gallerySort !== "updated") params.set("sort", next.gallerySort);
  } else if (next.view === "novels") {
    if (next.novelQuery) params.set("q", next.novelQuery);
    if (next.novelCategory && next.novelCategory !== "all") params.set("category", next.novelCategory);
    const defaultNovelSort = next.novelMode === "mine" ? "progress" : next.novelMode === "rankings" ? "chars" : next.novelMode === "author" ? "title" : next.novelMode === "authors" ? "books" : "updated";
    if (next.novelSort && next.novelSort !== defaultNovelSort) params.set("sort", next.novelSort);
    if (next.novelAuthor && next.novelMode !== "author") params.set("author", next.novelAuthor);
  } else if (next.view === "shortVideos") {
    if (next.shortVideoMode !== "likes") {
      if (next.shortVideoQuery) params.set("q", next.shortVideoQuery);
      if (next.shortVideoTopic) params.set("topic", next.shortVideoTopic);
      if (next.shortVideoSound) params.set("sound", next.shortVideoSound);
      if (next.shortVideoId && next.shortVideoAuthor && next.shortVideoAuthor !== "all") {
        params.set("author", next.shortVideoAuthor);
      } else if (!next.shortVideoAuthorPage && next.shortVideoAuthor && next.shortVideoAuthor !== "all") {
        params.set("author", next.shortVideoAuthor);
      }
      if (next.shortVideoMedia && next.shortVideoMedia !== "all") params.set("media", next.shortVideoMedia);
      if (next.shortVideoQuality && next.shortVideoQuality !== "all") params.set("quality", next.shortVideoQuality);
      const defaultSource = next.shortVideoAuthorPage && !next.shortVideoId ? "all" : "liked";
      if (next.shortVideoSource && next.shortVideoSource !== defaultSource) params.set("source", next.shortVideoSource);
      if (next.shortVideoSort && next.shortVideoSort !== "published") params.set("sort", next.shortVideoSort);
    }
  } else if (next.view === "music") {
    if (next.musicMode === "artists") {
      if (next.musicQuery) params.set("q", next.musicQuery);
      if (next.musicLanguage) params.set("language", next.musicLanguage);
      if (next.musicArtistSort === "name") params.set("sort", "name");
    } else if (next.musicMode === "albums") {
      if (next.musicQuery) params.set("q", next.musicQuery);
      if (next.musicLanguage) params.set("language", next.musicLanguage);
      if (next.musicAlbumSort && next.musicAlbumSort !== "updated") params.set("sort", next.musicAlbumSort);
    } else {
      if (next.musicQuery) params.set("q", next.musicQuery);
      if (next.musicSort && next.musicSort !== "album") params.set("sort", next.musicSort);
      if (next.musicFavorite) params.set("favorite", "1");
    }
  } else if (next.q) {
    params.set("q", next.q);
  }
  if (next.workId) params.set("workId", next.workId);
  if (next.videoId) params.set("videoId", next.videoId);

  const query = params.toString();
  const hash = options.hash === undefined ? window.location.hash || "" : options.hash || "";
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

function normalizeRoutePath(pathname) {
  const value = String(pathname || "/").replace(/\/+$/g, "");
  return value || "/";
}

function encodeRouteSegment(value) {
  return encodeURIComponent(String(value || ""));
}

function decodeRouteSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function normalizeGalleryCategory(route = {}) {
  const category = String(route.galleryCategory || "").trim();
  if (category) return category;
  if (route.galleryMode === "photo" && String(route.galleryQuery || "").trim()) return "all";
  return route.galleryMode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all";
}

function peopleRouteFromPath(routePath, params = new URLSearchParams()) {
  if (routePath !== "/western") return null;
  return {
    view: "people",
    galleryMode: "",
    peopleScope: "main",
    galleryPhotoView: "collections",
    galleryPhotoCollection: "",
    galleryAlbumId: "",
    galleryComicId: "",
    galleryChapterIndex: "",
    galleryMediaId: "",
    galleryQuery: "",
    galleryCategory: "all",
    gallerySubCategory: "all",
    galleryPerson: "all",
    gallerySort: "updated",
    novelBookId: "",
    novelChapterIndex: "",
    novelQuery: "",
    novelCategory: "all",
    novelSort: "updated",
    personId: params.get("personId") || params.get("person") || "",
    q: params.get("q") || params.get("search") || "",
    workId: params.get("workId") || params.get("work") || "",
    videoId: params.get("videoId") || params.get("video") || ""
  };
}

function shouldWriteGalleryCategory(route = {}) {
  if (route.galleryMode !== "photo") return route.galleryCategory !== "all";
  if (String(route.galleryQuery || "").trim()) return route.galleryCategory !== "all";
  return route.galleryCategory !== DEFAULT_GALLERY_PHOTO_CATEGORY;
}

function normalizeGallerySort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "rating", "year", "size", "title"].includes(sort) ? sort : "updated";
}

function normalizeNovelSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "size", "chars", "chapters", "progress", "books", "name"].includes(sort) ? sort : "updated";
}

function normalizeNovelPage(value) {
  const page = Number(value);
  return Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
}

function normalizeShortVideoSort(value) {
  const sort = String(value || "published").trim();
  return ["recommended", "liked", "watched", "published", "publishedAsc", "likes", "likesAsc", "comments", "duration"].includes(sort) ? sort : "published";
}

function normalizeShortVideoMedia(value) {
  const media = String(value || "all").trim().toLowerCase();
  return ["video", "gallery"].includes(media) ? media : "all";
}

function normalizeShortVideoQuality(value) {
  const quality = String(value || "all").trim().toLowerCase();
  return ["4k", "1440p", "1080p", "720p", "below720p", "unknown"].includes(quality) ? quality : "all";
}

function normalizeShortVideoTopic(value) {
  return String(value || "").trim().replace(/^#+/, "").slice(0, 48);
}

function normalizeShortVideoSound(value) {
  const sound = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,1000}$/.test(sound) ? sound : "";
}

function normalizeShortVideoSource(value) {
  const source = String(value || "liked").trim().toLowerCase();
  return ["recommended", "liked", "following", "history", "posts", "authors", "all", "local"].includes(source) ? source : "liked";
}

function normalizeMusicSort(value) {
  const sort = String(value || "album").trim();
  return ["album", "title", "artist", "duration", "played", "favorite", "rating"].includes(sort) ? sort : "album";
}

function normalizeMusicMode(value) {
  const mode = String(value || "library").trim();
  return ["home", "library", "artists", "albums", "history", "playlist", "smart", "report"].includes(mode) ? mode : "library";
}

function normalizeMusicArtistSort(value) {
  return String(value || "count").trim() === "name" ? "name" : "count";
}

function normalizeMusicAlbumSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "year", "tracks"].includes(sort) ? sort : "updated";
}

function galleryRouteFromPath(routePath, params = new URLSearchParams()) {
  const segments = normalizeRoutePath(routePath).split("/").filter(Boolean);
  if (!segments.length) return null;

  let galleryMode = PATH_GALLERY_MODES.get(`/${segments[0]}`);
  let rest = segments.slice(1);
  if (segments[0] === "gallery" && rest.length) {
    const nestedMode = PATH_GALLERY_MODES.get(`/${rest[0]}`);
    if (nestedMode) {
      galleryMode = nestedMode;
      rest = rest.slice(1);
    }
  }
  if (galleryMode === "photo" && rest[0] === "manga") {
    galleryMode = "manga";
    rest = rest.slice(1);
  }
  if (!galleryMode) return null;
  const galleryQuery = params.get("q") || params.get("search") || "";
  const photoSearch = galleryMode === "photo" && Boolean(String(galleryQuery).trim());

  const route = {
    view: "gallery",
    galleryMode,
    galleryPhotoView: galleryMode === "photo" && (params.get("photoView") === "albums" || (photoSearch && !params.has("photoView"))) ? "albums" : "collections",
    galleryPhotoCollection: params.get("collection") || "",
    galleryAlbumId: "",
    galleryComicId: "",
    galleryChapterIndex: "",
    galleryMediaId: "",
    galleryQuery,
    galleryCategory: params.has("category") ? params.get("category") || "all" : photoSearch ? "all" : galleryMode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all",
    gallerySubCategory: params.get("subCategory") || params.get("folder") || "all",
    galleryPerson: ["tv", "media"].includes(galleryMode) ? params.get("series") || params.get("person") || "all" : params.get("person") || "all",
    galleryPhotoDate: galleryMode === "photo" ? params.get("date") || "all" : "all",
    gallerySort: normalizeGallerySort(params.get("sort")),
    personId: "",
    q: "",
    workId: "",
    videoId: ""
  };

  if (galleryMode === "photo") {
    const section = rest[0] || "";
    if (section === "collections") {
      route.galleryPhotoView = "collections";
    } else if (section === "albums" && !rest[1]) {
      route.galleryPhotoView = "albums";
    } else if (section === "collection") {
      route.galleryPhotoView = "collections";
      route.galleryPhotoCollection = decodeRouteSegment(rest.slice(1).join("/"));
      if (!params.has("category")) route.galleryCategory = "all";
    } else if (["set", "sets", "album", "albums", "photo-set"].includes(section)) {
      route.galleryAlbumId = decodeRouteSegment(rest[1] || "");
    } else if (section) {
      route.galleryAlbumId = decodeRouteSegment(section);
    }
  } else if (galleryMode === "manga") {
    route.galleryComicId = decodeRouteSegment(rest[0] || "");
    route.galleryChapterIndex = decodeRouteSegment(rest[1] || "");
  } else if (["western", "media", "movie", "tv"].includes(galleryMode)) {
    route.galleryMediaId = decodeRouteSegment(rest[0] || "");
  }

  return route;
}

function novelRouteFromPath(routePath, params = new URLSearchParams()) {
  const segments = normalizeRoutePath(routePath).split("/").filter(Boolean);
  if (!segments.length || !["novel", "novels"].includes(segments[0])) return null;
  const rest = segments.slice(1);
  const authorPage = rest[0] === "authors" ? decodeRouteSegment(rest[1] || "") : "";
  const legacyAuthor = params.get("author") || "";
  const authorList = rest[0] === "authors" && !authorPage;
  const manage = rest[0] === "manage";
  const mine = ["mine", "my"].includes(rest[0]);
  const searchPage = rest[0] === "search";
  const rankings = ["rankings", "ranking", "rank"].includes(rest[0]);
  const specialRoute = authorList || Boolean(authorPage) || manage || mine || searchPage || rankings;
  const chapterSegment = specialRoute ? "" : rest[1] === "read" ? rest[2] || "" : rest[1] || "";
  return {
    view: "novels",
    galleryMode: "",
    galleryPhotoView: "collections",
    galleryPhotoCollection: "",
    galleryAlbumId: "",
    galleryComicId: "",
    galleryChapterIndex: "",
    galleryMediaId: "",
    galleryQuery: "",
    galleryCategory: "all",
    gallerySubCategory: "all",
    galleryPerson: "all",
    gallerySort: "updated",
    novelBookId: specialRoute ? "" : decodeRouteSegment(rest[0] || ""),
    novelChapterIndex: decodeRouteSegment(chapterSegment),
    novelQuery: params.get("q") || params.get("search") || "",
    novelCategory: params.get("category") || "all",
    novelSort: normalizeNovelSort(params.get("sort") || (mine ? "progress" : rankings ? "chars" : authorPage || legacyAuthor ? "title" : authorList ? "books" : "updated")),
    novelMode: manage ? "manage" : mine ? "mine" : searchPage ? "search" : rankings ? "rankings" : authorPage || legacyAuthor ? "author" : authorList || params.get("section") === "authors" ? "authors" : "books",
    novelAuthor: authorPage || legacyAuthor,
    novelPage: Math.max(0, Number(params.get("page") || 1) - 1),
    personId: "",
    q: "",
    workId: "",
    videoId: ""
  };
}

function shortVideoRouteFromPath(routePath, params = new URLSearchParams()) {
  const segments = normalizeRoutePath(routePath).split("/").filter(Boolean);
  if (!segments.length || !["short-videos", "short-video", "douyin"].includes(segments[0])) return null;
  const likesStatsPage = segments[1] === "stats" && segments[2] === "likes";
  const pathAuthorPage = segments[1] === "authors" ? decodeRouteSegment(segments[2] || "") : "";
  const requestedAuthor = params.get("author") || "all";
  const requestedSource = params.get("source") || params.get("origin") || "";
  const legacyAuthorPage = !segments[1] && requestedSource === "authors" && requestedAuthor !== "all" ? requestedAuthor : "";
  const authorPage = pathAuthorPage || legacyAuthorPage;
  return {
    view: "shortVideos",
    galleryMode: "",
    galleryPhotoView: "collections",
    galleryPhotoCollection: "",
    galleryAlbumId: "",
    galleryComicId: "",
    galleryChapterIndex: "",
    galleryMediaId: "",
    galleryQuery: "",
    galleryCategory: "all",
    gallerySubCategory: "all",
    galleryPerson: "all",
    gallerySort: "updated",
    novelBookId: "",
    novelChapterIndex: "",
    novelQuery: "",
    novelCategory: "all",
    novelSort: "updated",
    shortVideoId: pathAuthorPage || likesStatsPage ? "" : decodeRouteSegment(segments[1] || ""),
    shortVideoAuthorPage: authorPage,
    shortVideoMode: likesStatsPage ? "likes" : "feed",
    shortVideoQuery: params.get("q") || params.get("search") || "",
    shortVideoTopic: normalizeShortVideoTopic(params.get("topic") || params.get("tag")),
    shortVideoSound: normalizeShortVideoSound(params.get("sound") || params.get("music")),
    shortVideoAuthor: authorPage || requestedAuthor,
    shortVideoMedia: normalizeShortVideoMedia(params.get("media") || params.get("type")),
    shortVideoQuality: normalizeShortVideoQuality(params.get("quality") || params.get("resolution")),
    shortVideoSource: authorPage
      ? normalizeShortVideoSource(requestedSource === "authors" ? "all" : requestedSource || "all")
      : normalizeShortVideoSource(requestedSource),
    shortVideoSort: normalizeShortVideoSort(params.get("sort")),
    personId: "",
    q: "",
    workId: "",
    videoId: ""
  };
}

function musicRouteFromPath(routePath, params = new URLSearchParams()) {
  const segments = normalizeRoutePath(routePath).split("/").filter(Boolean);
  if (!segments.length || !["music", "musics", "songs"].includes(segments[0])) return null;
  const section = segments[1] || "";
  return {
    view: "music",
    galleryMode: "",
    galleryPhotoView: "collections",
    galleryPhotoCollection: "",
    galleryAlbumId: "",
    galleryComicId: "",
    galleryChapterIndex: "",
    galleryMediaId: "",
    galleryQuery: "",
    galleryCategory: "all",
    gallerySubCategory: "all",
    galleryPerson: "all",
    gallerySort: "updated",
    novelBookId: "",
    novelChapterIndex: "",
    novelQuery: "",
    novelCategory: "all",
    novelSort: "updated",
    shortVideoId: "",
    shortVideoAuthorPage: "",
    shortVideoMode: "feed",
    shortVideoQuery: "",
    shortVideoAuthor: "all",
    shortVideoSource: "liked",
    shortVideoSort: "published",
    musicTrackId: section === "track" ? decodeRouteSegment(segments[2] || "") : "",
    musicArtistId: section === "artist" ? decodeRouteSegment(segments[2] || "") : "",
    musicAlbumId: section === "album" ? decodeRouteSegment(segments[2] || "") : "",
    musicGenre: section === "genre" ? decodeRouteSegment(segments[2] || "") : params.get("genre") || "",
    musicLanguage: section === "language" ? decodeRouteSegment(segments[2] || "") : params.get("language") || "",
    musicMode: section === "history" ? "history" : section === "report" ? "report" : section === "artists" ? "artists" : section === "albums" ? "albums" : section === "playlist" ? "playlist" : section === "smart" ? "smart" : section ? "library" : "home",
    musicPlaylistId: section === "playlist" ? decodeRouteSegment(segments[2] || "") : "",
    musicSmartId: section === "smart" ? decodeRouteSegment(segments[2] || "") : "",
    musicQuery: params.get("q") || params.get("search") || "",
    musicSort: ["artists", "albums"].includes(section) ? "album" : normalizeMusicSort(params.get("sort")),
    musicArtistSort: normalizeMusicArtistSort(params.get("artistSort") || params.get("sort")),
    musicAlbumSort: normalizeMusicAlbumSort(params.get("albumSort") || params.get("sort")),
    musicFavorite: ["1", "true", "yes"].includes(String(params.get("favorite") || "").toLowerCase()),
    personId: "",
    q: "",
    workId: "",
    videoId: ""
  };
}

function routePath(route) {
  if (route.view === "gallery") {
    const mode = route.galleryMode || "photo";
    const base = GALLERY_MODE_PATHS[mode] || "/photo";
    if (mode === "photo") {
      if (route.galleryAlbumId) return `${base}/set/${encodeRouteSegment(route.galleryAlbumId)}`;
      if (route.galleryPhotoCollection) return `${base}/collection/${encodeRouteSegment(route.galleryPhotoCollection)}`;
      if (route.galleryPhotoView === "collections") return `${base}/collections`;
      return `${base}/albums`;
    }
    if (mode === "manga" && route.galleryComicId) {
      const chapter = route.galleryChapterIndex ? `/${encodeRouteSegment(route.galleryChapterIndex)}` : "";
      return `${base}/${encodeRouteSegment(route.galleryComicId)}${chapter}`;
    }
    if (mode === "western" && !route.galleryMediaId) return "/gallery/western";
    if (["western", "media", "movie", "tv"].includes(mode) && route.galleryMediaId) {
      return `${base}/${encodeRouteSegment(route.galleryMediaId)}`;
    }
    return base;
  }
  if (route.view === "novels") {
    if (route.novelBookId && route.novelChapterIndex) {
      return `/novels/${encodeRouteSegment(route.novelBookId)}/${encodeRouteSegment(route.novelChapterIndex)}`;
    }
    if (route.novelBookId) return `/novels/${encodeRouteSegment(route.novelBookId)}`;
    if (route.novelMode === "author" && route.novelAuthor) return `/novels/authors/${encodeRouteSegment(route.novelAuthor)}`;
    if (route.novelMode === "mine") return "/novels/mine";
    if (route.novelMode === "authors") return "/novels/authors";
    if (route.novelMode === "search") return "/novels/search";
    if (route.novelMode === "rankings") return "/novels/rankings";
    if (route.novelMode === "manage") return "/novels/manage";
    return "/novels";
  }
  if (route.view === "shortVideos") {
    if (route.shortVideoMode === "likes") return "/short-videos/stats/likes";
    if (route.shortVideoId) return `/short-videos/${encodeRouteSegment(route.shortVideoId)}`;
    if (route.shortVideoAuthorPage) return `/short-videos/authors/${encodeRouteSegment(route.shortVideoAuthorPage)}`;
    return "/short-videos";
  }
  if (route.view === "music") {
    if (route.musicTrackId) return `/music/track/${encodeRouteSegment(route.musicTrackId)}`;
    if (route.musicMode === "history") return "/music/history";
    if (route.musicMode === "report") return "/music/report";
    if (route.musicMode === "artists") return "/music/artists";
    if (route.musicMode === "albums") return "/music/albums";
    if (route.musicMode === "playlist" && route.musicPlaylistId) return `/music/playlist/${encodeRouteSegment(route.musicPlaylistId)}`;
    if (route.musicMode === "smart" && route.musicSmartId) return `/music/smart/${encodeRouteSegment(route.musicSmartId)}`;
    if (route.musicGenre) return `/music/genre/${encodeRouteSegment(route.musicGenre)}`;
    if (route.musicAlbumId) return `/music/album/${encodeRouteSegment(route.musicAlbumId)}`;
    if (route.musicArtistId) return `/music/artist/${encodeRouteSegment(route.musicArtistId)}`;
    if (route.musicLanguage) return `/music/language/${encodeRouteSegment(route.musicLanguage)}`;
    if (route.musicMode === "library") return "/music/library";
    return "/music";
  }
  if (VIEW_PATHS[route.view]) return VIEW_PATHS[route.view];
  return "/fanhao";
}

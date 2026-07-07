export const URL_VIEW_NAMES = new Set(["people", "studios", "vr", "favorites", "history", "rankings", "gallery", "novels", "shortVideos", "music", "tools"]);
export const GALLERY_MODE_NAMES = new Set(["photo", "manga", "western", "media", "movie", "tv"]);
export const PEOPLE_SCOPE_NAMES = new Set(["main", "western"]);
export const DEFAULT_GALLERY_PHOTO_CATEGORY = "我喜欢的";

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
  ["/media", "media"],
  ["/video", "media"],
  ["/videos", "media"],
  ["/movie", "movie"],
  ["/movies", "movie"],
  ["/tv", "tv"]
]);

const VIEW_PATHS = {
  studios: "/studios",
  vr: "/vr",
  favorites: "/favorites",
  history: "/history",
  rankings: "/rankings",
  novels: "/novels",
  shortVideos: "/short-videos",
  music: "/music",
  tools: "/tools"
};

const PATH_VIEWS = new Map(Object.entries(VIEW_PATHS).map(([view, pathname]) => [pathname, view]));

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
  const pathView = PATH_VIEWS.get(routePath);
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
      shortVideoQuery: "",
      shortVideoAuthor: "all",
      shortVideoSource: "liked",
      shortVideoSort: "published",
      musicTrackId: "",
      musicArtistId: "",
      musicAlbumId: "",
      musicMode: "home",
      musicPlaylistId: "",
      musicQuery: "",
      musicSort: "album",
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
    gallerySort: view === "gallery" ? normalizeGallerySort(route.gallerySort) : "updated",
    novelBookId: view === "novels" ? String(route.novelBookId || "").trim() : "",
    novelChapterIndex: view === "novels" ? String(route.novelChapterIndex || "").trim() : "",
    novelQuery: view === "novels" ? String(route.novelQuery || route.q || "").trim() : "",
    novelCategory: view === "novels" ? String(route.novelCategory || "all").trim() || "all" : "all",
    novelSort: view === "novels" ? normalizeNovelSort(route.novelSort) : "updated",
    shortVideoId: view === "shortVideos" ? String(route.shortVideoId || "").trim() : "",
    shortVideoQuery: view === "shortVideos" ? String(route.shortVideoQuery || route.q || "").trim() : "",
    shortVideoAuthor: view === "shortVideos" ? String(route.shortVideoAuthor || "all").trim() || "all" : "all",
    shortVideoSource: view === "shortVideos" ? normalizeShortVideoSource(route.shortVideoSource || route.source) : "liked",
    shortVideoSort: view === "shortVideos" ? normalizeShortVideoSort(route.shortVideoSort) : "published",
    musicTrackId: view === "music" ? String(route.musicTrackId || "").trim() : "",
    musicArtistId: view === "music" ? String(route.musicArtistId || "").trim() : "",
    musicAlbumId: view === "music" ? String(route.musicAlbumId || "").trim() : "",
    musicMode: view === "music" ? normalizeMusicMode(route.musicMode) : "home",
    musicPlaylistId: view === "music" ? String(route.musicPlaylistId || "").trim() : "",
    musicQuery: view === "music" ? String(route.musicQuery || route.q || "").trim() : "",
    musicSort: view === "music" ? normalizeMusicSort(route.musicSort) : "album",
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
  if (next.view && !["people", "search", "gallery", "novels", "shortVideos", "music", "tools"].includes(next.view)) params.set("view", next.view);
  if (next.personId) params.set("personId", next.personId);
  if (next.view === "people" && next.peopleScope && next.peopleScope !== "main" && pathname !== "/western") {
    params.set("scope", next.peopleScope);
  }
  if (next.view === "gallery") {
    if (next.galleryQuery) params.set("q", next.galleryQuery);
    if (next.galleryCategory && shouldWriteGalleryCategory(next)) params.set("category", next.galleryCategory);
    if (next.gallerySubCategory && next.gallerySubCategory !== "all") params.set("subCategory", next.gallerySubCategory);
    if (next.galleryPerson && next.galleryPerson !== "all") {
      params.set(["tv", "media"].includes(next.galleryMode) ? "series" : "person", next.galleryPerson);
    }
    if (next.gallerySort && next.gallerySort !== "updated") params.set("sort", next.gallerySort);
  } else if (next.view === "novels") {
    if (next.novelQuery) params.set("q", next.novelQuery);
    if (next.novelCategory && next.novelCategory !== "all") params.set("category", next.novelCategory);
    if (next.novelSort && next.novelSort !== "updated") params.set("sort", next.novelSort);
  } else if (next.view === "shortVideos") {
    if (next.shortVideoQuery) params.set("q", next.shortVideoQuery);
    if (next.shortVideoAuthor && next.shortVideoAuthor !== "all") params.set("author", next.shortVideoAuthor);
    if (next.shortVideoSource && next.shortVideoSource !== "liked") params.set("source", next.shortVideoSource);
    if (next.shortVideoSort && next.shortVideoSort !== "published") params.set("sort", next.shortVideoSort);
  } else if (next.view === "music") {
    if (next.musicQuery) params.set("q", next.musicQuery);
    if (next.musicSort && next.musicSort !== "album") params.set("sort", next.musicSort);
    if (next.musicFavorite) params.set("favorite", "1");
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

function peopleRouteFromPath(routePath, params = new URLSearchParams()) {
  if (routePath !== "/western") return null;
  return {
    view: "people",
    galleryMode: "",
    peopleScope: "western",
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
  return route.galleryMode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all";
}

function shouldWriteGalleryCategory(route = {}) {
  if (route.galleryMode !== "photo") return route.galleryCategory !== "all";
  return route.galleryCategory !== DEFAULT_GALLERY_PHOTO_CATEGORY;
}

function normalizeGallerySort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "rating", "year", "size", "title"].includes(sort) ? sort : "updated";
}

function normalizeNovelSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "size", "chapters", "progress"].includes(sort) ? sort : "updated";
}

function normalizeShortVideoSort(value) {
  const sort = String(value || "published").trim();
  return ["liked", "published", "likes", "comments", "duration"].includes(sort) ? sort : "published";
}

function normalizeShortVideoSource(value) {
  const source = String(value || "liked").trim().toLowerCase();
  return ["liked", "posts", "all", "local"].includes(source) ? source : "liked";
}

function normalizeMusicSort(value) {
  const sort = String(value || "album").trim();
  return ["album", "title", "artist", "duration", "played", "favorite"].includes(sort) ? sort : "album";
}

function normalizeMusicMode(value) {
  const mode = String(value || "home").trim();
  return ["home", "library", "history", "playlist"].includes(mode) ? mode : "home";
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

  const route = {
    view: "gallery",
    galleryMode,
    galleryPhotoView: galleryMode === "photo" && params.get("photoView") !== "albums" ? "collections" : "albums",
    galleryPhotoCollection: params.get("collection") || "",
    galleryAlbumId: "",
    galleryComicId: "",
    galleryChapterIndex: "",
    galleryMediaId: "",
    galleryQuery: params.get("q") || params.get("search") || "",
    galleryCategory: params.has("category") ? params.get("category") || "all" : galleryMode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all",
    gallerySubCategory: params.get("subCategory") || params.get("folder") || "all",
    galleryPerson: ["tv", "media"].includes(galleryMode) ? params.get("series") || params.get("person") || "all" : params.get("person") || "all",
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
  const chapterSegment = rest[1] === "read" ? rest[2] || "" : rest[1] || "";
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
    novelBookId: decodeRouteSegment(rest[0] || ""),
    novelChapterIndex: decodeRouteSegment(chapterSegment),
    novelQuery: params.get("q") || params.get("search") || "",
    novelCategory: params.get("category") || "all",
    novelSort: normalizeNovelSort(params.get("sort")),
    personId: "",
    q: "",
    workId: "",
    videoId: ""
  };
}

function shortVideoRouteFromPath(routePath, params = new URLSearchParams()) {
  const segments = normalizeRoutePath(routePath).split("/").filter(Boolean);
  if (!segments.length || !["short-videos", "short-video", "douyin"].includes(segments[0])) return null;
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
    shortVideoId: decodeRouteSegment(segments[1] || ""),
    shortVideoQuery: params.get("q") || params.get("search") || "",
    shortVideoAuthor: params.get("author") || "all",
    shortVideoSource: normalizeShortVideoSource(params.get("source") || params.get("origin")),
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
    shortVideoQuery: "",
    shortVideoAuthor: "all",
    shortVideoSource: "liked",
    shortVideoSort: "published",
    musicTrackId: section === "track" ? decodeRouteSegment(segments[2] || "") : "",
    musicArtistId: section === "artist" ? decodeRouteSegment(segments[2] || "") : "",
    musicAlbumId: section === "album" ? decodeRouteSegment(segments[2] || "") : "",
    musicMode: section === "history" ? "history" : section === "playlist" ? "playlist" : ["library", "artist", "album", "track"].includes(section) ? "library" : "home",
    musicPlaylistId: section === "playlist" ? decodeRouteSegment(segments[2] || "") : "",
    musicQuery: params.get("q") || params.get("search") || "",
    musicSort: normalizeMusicSort(params.get("sort")),
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
    if (["western", "media", "movie", "tv"].includes(mode) && route.galleryMediaId) {
      return `${base}/${encodeRouteSegment(route.galleryMediaId)}`;
    }
    return base;
  }
  if (route.view === "people" && route.peopleScope === "western") return "/western";
  if (route.view === "novels") {
    if (route.novelBookId && route.novelChapterIndex) {
      return `/novels/${encodeRouteSegment(route.novelBookId)}/${encodeRouteSegment(route.novelChapterIndex)}`;
    }
    if (route.novelBookId) return `/novels/${encodeRouteSegment(route.novelBookId)}`;
    return "/novels";
  }
  if (route.view === "shortVideos") {
    if (route.shortVideoId) return `/short-videos/${encodeRouteSegment(route.shortVideoId)}`;
    return "/short-videos";
  }
  if (route.view === "music") {
    if (route.musicTrackId) return `/music/track/${encodeRouteSegment(route.musicTrackId)}`;
    if (route.musicMode === "history") return "/music/history";
    if (route.musicMode === "playlist" && route.musicPlaylistId) return `/music/playlist/${encodeRouteSegment(route.musicPlaylistId)}`;
    if (route.musicAlbumId) return `/music/album/${encodeRouteSegment(route.musicAlbumId)}`;
    if (route.musicArtistId) return `/music/artist/${encodeRouteSegment(route.musicArtistId)}`;
    if (route.musicMode === "library") return "/music/library";
    return "/music";
  }
  if (VIEW_PATHS[route.view]) return VIEW_PATHS[route.view];
  return "/";
}

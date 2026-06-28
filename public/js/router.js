export const URL_VIEW_NAMES = new Set(["people", "favorites", "history", "rankings", "gallery", "tools"]);
export const GALLERY_MODE_NAMES = new Set(["photo", "manga", "western", "movie", "tv"]);
export const DEFAULT_GALLERY_PHOTO_CATEGORY = "我喜欢的";

const GALLERY_MODE_PATHS = {
  photo: "/photo",
  manga: "/manga",
  western: "/western",
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
  ["/movie", "movie"],
  ["/movies", "movie"],
  ["/tv", "tv"]
]);

const VIEW_PATHS = {
  favorites: "/favorites",
  history: "/history",
  rankings: "/rankings",
  tools: "/tools"
};

const PATH_VIEWS = new Map(Object.entries(VIEW_PATHS).map(([view, pathname]) => [pathname, view]));

export function routeFromUrl(url = window.location.href) {
  const parsed = new URL(url, window.location.href);
  const params = parsed.searchParams;
  const query = params.get("q") || params.get("search") || "";
  const rawView = params.get("view");
  const routePath = normalizeRoutePath(parsed.pathname);
  const galleryRoute = galleryRouteFromPath(routePath, params);
  if (galleryRoute) return galleryRoute;
  const pathView = PATH_VIEWS.get(routePath);
  if (pathView) {
    return {
      view: pathView,
      galleryMode: "",
      personId: "",
      q: "",
      workId: "",
      videoId: ""
    };
  }
  return {
    view: query ? "search" : URL_VIEW_NAMES.has(rawView) ? rawView : "people",
    galleryMode: GALLERY_MODE_NAMES.has(params.get("mode")) ? params.get("mode") : "",
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
  return {
    view,
    galleryMode: view === "gallery" && GALLERY_MODE_NAMES.has(route.galleryMode) ? route.galleryMode : "",
    galleryPhotoView: view === "gallery" && route.galleryPhotoView === "collections" ? "collections" : "albums",
    galleryPhotoCollection: view === "gallery" ? String(route.galleryPhotoCollection || "").trim() : "",
    galleryAlbumId: view === "gallery" ? String(route.galleryAlbumId || "").trim() : "",
    galleryComicId: view === "gallery" ? String(route.galleryComicId || "").trim() : "",
    galleryChapterIndex: view === "gallery" ? String(route.galleryChapterIndex || "").trim() : "",
    galleryMediaId: view === "gallery" ? String(route.galleryMediaId || "").trim() : "",
    galleryQuery: view === "gallery" ? String(route.galleryQuery || "").trim() : "",
    galleryCategory: view === "gallery" ? normalizeGalleryCategory(route) : "all",
    gallerySubCategory: view === "gallery" ? String(route.gallerySubCategory || "all").trim() || "all" : "all",
    galleryPerson: view === "gallery" ? String(route.galleryPerson || "all").trim() || "all" : "all",
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
  if (next.view && !["people", "search", "gallery", "tools"].includes(next.view)) params.set("view", next.view);
  if (next.personId) params.set("personId", next.personId);
  if (next.view === "gallery") {
    if (next.galleryQuery) params.set("q", next.galleryQuery);
    if (next.galleryCategory && shouldWriteGalleryCategory(next)) params.set("category", next.galleryCategory);
    if (next.gallerySubCategory && next.gallerySubCategory !== "all") params.set("subCategory", next.gallerySubCategory);
    if (next.galleryPerson && next.galleryPerson !== "all") {
      params.set(next.galleryMode === "tv" ? "series" : "person", next.galleryPerson);
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
  return route.galleryMode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all";
}

function shouldWriteGalleryCategory(route = {}) {
  if (route.galleryMode !== "photo") return route.galleryCategory !== "all";
  return route.galleryCategory !== DEFAULT_GALLERY_PHOTO_CATEGORY;
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
  if (!galleryMode) return null;

  const route = {
    view: "gallery",
    galleryMode,
    galleryPhotoView: params.get("photoView") === "collections" ? "collections" : "albums",
    galleryPhotoCollection: params.get("collection") || "",
    galleryAlbumId: "",
    galleryComicId: "",
    galleryChapterIndex: "",
    galleryMediaId: "",
    galleryQuery: params.get("q") || params.get("search") || "",
    galleryCategory: params.has("category") ? params.get("category") || "all" : galleryMode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all",
    gallerySubCategory: params.get("subCategory") || params.get("folder") || "all",
    galleryPerson: galleryMode === "tv" ? params.get("series") || params.get("person") || "all" : params.get("person") || "all",
    personId: "",
    q: "",
    workId: "",
    videoId: ""
  };

  if (galleryMode === "photo") {
    const section = rest[0] || "";
    if (section === "collections") {
      route.galleryPhotoView = "collections";
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
  } else if (["western", "movie", "tv"].includes(galleryMode)) {
    route.galleryMediaId = decodeRouteSegment(rest[0] || "");
  }

  return route;
}

function routePath(route) {
  if (route.view === "gallery") {
    const mode = route.galleryMode || "photo";
    const base = GALLERY_MODE_PATHS[mode] || "/photo";
    if (mode === "photo") {
      if (route.galleryAlbumId) return `${base}/set/${encodeRouteSegment(route.galleryAlbumId)}`;
      if (route.galleryPhotoCollection) return `${base}/collection/${encodeRouteSegment(route.galleryPhotoCollection)}`;
      if (route.galleryPhotoView === "collections") return `${base}/collections`;
      return base;
    }
    if (mode === "manga" && route.galleryComicId) {
      const chapter = route.galleryChapterIndex ? `/${encodeRouteSegment(route.galleryChapterIndex)}` : "";
      return `${base}/${encodeRouteSegment(route.galleryComicId)}${chapter}`;
    }
    if (["western", "movie", "tv"].includes(mode) && route.galleryMediaId) {
      return `${base}/${encodeRouteSegment(route.galleryMediaId)}`;
    }
    return base;
  }
  if (VIEW_PATHS[route.view]) return VIEW_PATHS[route.view];
  return "/";
}

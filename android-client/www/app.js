import { CLIENT_VERSION, DEFAULT_UPDATE_URLS, DEFAULT_URL, LAST_VIEW_STORAGE_KEY, SEARCH_HISTORY_STORAGE_KEY, STORAGE_KEY, THEME_STORAGE_KEY } from "./js/config.js?v=assets-07b744082137";
import { fetchJson } from "./js/api.js?v=assets-07b744082137";
import { installServerAuthentication, loginToServer, registerServerAuthentication } from "./js/server-auth.js";
import { createAccountSettings } from "./js/account-settings.js";
import { accountLoginMessage, isServerAuthenticationError, requiresUserAccount } from "./js/account-access.js";
import { cacheAgeText, clearCachedData, clearCachedImages, clearCachedResponses, getCacheStats, readCachedJson, writeCachedJson } from "./js/cache.js?v=assets-07b744082137";
import { androidModuleFallbackCatalog, loadAndroidModules, mergeAndroidModuleCatalog } from "./js/android-module-registry.js?v=assets-07b744082137";
import { getElements } from "./js/dom.js?v=assets-07b744082137";
import { formatBytes, formatCompact, formatNumber, normalizeUrl } from "./js/format.js";
import { absoluteUrl, loadPreviewImage } from "./js/image.js?v=assets-07b744082137";
import { createMediaViewer } from "./js/media-viewer.js?v=assets-07b744082137";
import { loadModuleCatalog, renderAndroidModuleNavigation } from "./js/module-navigation.js?v=assets-07b744082137";
import { clearRecentContent, readRecentContent, recordRecentContent } from "./js/recent-content.js?v=assets-07b744082137";
import { createSearchHistory } from "./js/search-history.js";
import { canonicalShortVideoViewParams } from "./js/short-video-route-contract.js?v=assets-07b744082137";
import { normalizeMediaTrail } from "./js/media-navigation-state.js?v=assets-07b744082137";
import { createChannelHistoryState } from "./js/channel-history-state.js?v=assets-07b744082137";

const els = getElements();
let activeUrl = normalizeUrl(localStorage.getItem(STORAGE_KEY) || DEFAULT_URL);
installServerAuthentication(() => activeUrl);
let accountReloadPending = false;
let accountPageOwner = "";
let accountChangeNeedsReload = false;
window.addEventListener("fanhaoAccountOwnerConfirmed", (event) => {
  if (event.detail?.origin === new URL(activeUrl).origin) accountPageOwner = event.detail.owner;
});
window.addEventListener("fanhaoAccountOwnerChanged", (event) => {
  if (event.detail?.current?.origin !== new URL(activeUrl).origin) return;
  accountChangeNeedsReload ||= Boolean(accountPageOwner || library);
  invalidateViewRender();
  ++libraryLoadGeneration;
  libraryLoadPromise = null;
  library = null;
  workViews?.pageDataService?.invalidate(activeUrl, "/");
  workViews?.favoriteFolders?.reset?.();
  for (const video of document.querySelectorAll("video")) video.pause();
  els.viewContent.replaceChildren();
  els.personPreview.replaceChildren();
  els.continuePreview.replaceChildren();
  renderUserState({ favoriteCount: 0, historyCount: 0 });
  if (event.detail.current.owner === "pending" || accountReloadPending) return;
  if (!accountChangeNeedsReload) {
    // First authenticated response on a cold start may establish the owner
    // without a saved digest. Continue in this page rather than reload-looping.
    queueMicrotask(() => {
      if (!androidModuleRegistry || accountReloadPending) return;
      void loadDashboard();
      renderCurrentView();
    });
    return;
  }
  accountReloadPending = true;
  // A fresh page also discards module-specific prefetches, playback closures and
  // navigation snapshots. Shared images/media and the current route stay intact.
  window.location.reload();
});
let connectionAttempt = 0;
let connectionPending = false;
let connectionPendingUrl = "";
let accountSettings = null;
let accountSettingsServer = "";
let readerCacheSnapshot = null;
let mangaStorageSnapshot = null;
let pendingAppConfirmation = null;
const RESTORABLE_VIEWS = new Set(["home", "people", "works", "rankings", "categories", "codePrefixes", "codePrefixDetail", "studios", "studioDetail", "history", "search", "personDetail", "workDetail", "channel", "photoDetail", "mangaDetail", "mangaChapter", "mediaDetail", "novels", "novelSearch", "novelDetail", "novelReader", "music", "shortVideos", "shortVideoSearch", "tools"]);
const DEFAULT_VIEW = "people";
const DEFAULT_PHOTO_CATEGORY = "我喜欢的";
const HOME_MODE_STORAGE_KEY = "fanhao.android.homeMode.v1";
const HOME_MODES = new Set(["fanhao", "western"]);
const GALLERY_MODE_STORAGE_KEY = "fanhao.android.galleryMode.v1";
const GALLERY_MODE_OPTIONS = Object.freeze([
  { mode: "photo", label: "套图", meta: "图片合集", glyph: "▣" },
  { mode: "manga", label: "韩漫", meta: "章节漫画", glyph: "漫" },
  { mode: "movie", label: "电影", meta: "电影片库", glyph: "影" },
  { mode: "tv", label: "电视剧", meta: "剧集与分集", glyph: "剧" },
  { mode: "anime", label: "动漫", meta: "番剧与分集", glyph: "动" }
]);
const GALLERY_MODES = new Set(GALLERY_MODE_OPTIONS.map((option) => option.mode));
const READING_MODE_STORAGE_KEY = "fanhao.android.readingMode.v1";
const READING_MODES = new Set(["novels", "music"]);
const PRIMARY_LABELS = {
  fanhao: "番号",
  photo: "图库",
  manga: "图库",
  western: "欧美",
  media: "影视",
  movie: "电影",
  tv: "电视剧",
  anime: "动漫",
  novels: "小说",
  music: "音乐",
  shortVideos: "短视频",
  tools: "我的"
};
const FAST_WORK_LIMIT = 48;
const FAST_WORK_STEP = 48;
const FAST_PEOPLE_LIMIT = 64;
const FAST_PEOPLE_STEP = 64;
const FAST_CHANNEL_LIMIT = 720;
const FAST_CHANNEL_STEP = 720;
const PHOTO_CHANNEL_LIMIT = 24;
const FAST_PHOTO_CHANNEL_LIMIT = 160;
const PHOTO_CHANNEL_STEP = 24;
const FAST_PHOTO_CHANNEL_STEP = 160;
const FAST_PHOTO_IMAGE_LIMIT = 160;
const FAST_PHOTO_IMAGE_STEP = 160;
const FAST_MANGA_IMAGE_LIMIT = 600;
const FAST_MANGA_IMAGE_STEP = 80;
const initialViewState = readInitialViewState();
const initialSettingsRequested = Boolean(initialViewState.settingsRequested);
let library = null;
let libraryLoadPromise = null;
let libraryLoadGeneration = 0;
let libraryLoadError = null;
let currentView = initialViewState.view;
let currentViewParams = initialViewState.params;
let peopleLimit = defaultPeopleLimit();
let worksLimit = defaultWorksLimitForView(initialViewState.view);
let channelLimit = defaultChannelLimitForView(initialViewState.view, initialViewState.params);
let photoImageLimit = defaultPhotoImageLimitForView(initialViewState.view);
let mangaImageLimit = defaultMangaImageLimitForView(initialViewState.view);
let viewStack = [];
const channelHistoryState = createChannelHistoryState();
let detailViews = null;
let peopleViews = null;
let workViews = null;
let channelViews = null;
let toolViews = null;
let novelViews = null;
let musicViews = null;
let shortVideoViews = null;
let androidModuleRegistry = null;
let mediaViewer = createMediaViewer();
let searchHistory = null;
let renderedSearchController = null;
let viewRenderToken = 0;
let activeViewController = null;
let pendingScrollRestore = null;
let scrollRestoreIntent = 0;
let searchSurfaceExpanded = initialViewState.view === "search" || (initialViewState.view === "channel" && Boolean(initialViewState.params.query));
let searchPrepareTimer = 0;
const HISTORY_MARKER = "fanhao-android";
const LIBRARY_CACHE_PATH = "/api/library";
const MODULE_CATALOG_CACHE_PATH = "/api/modules";
const IMAGE_LIBRARY_SUMMARY_CACHE_PATH = "/api/image-library/summary?cache=0";
const NOVEL_SUMMARY_CACHE_PATH = "/api/novels/summary";
const MUSIC_SUMMARY_CACHE_PATH = "/api/music/summary";
const SHORT_VIDEO_SUMMARY_CACHE_PATH = "/api/short-videos/summary";
const ANDROID_UPDATE_CHANNEL = "debug";
let themePreference = localStorage.getItem(THEME_STORAGE_KEY) || "system";
let imageLibrarySummary = null;
let novelSummary = null;
let musicSummary = null;
let shortVideoSummary = null;
let androidVersionInfo = null;
let androidUpdateInfo = null;
let androidUpdateStatus = "checking";
let androidUpdateError = null;
let androidUpdateErrorPhase = "check";
let androidUpdateMessage = "";
let androidUpdateGeneration = 0;
let androidUpdateCheckPromise = null;
let androidUpdateResumePromise = null;
let androidUpdateExternalFlow = "";
let androidUpdateReturnPending = false;
const FEED_VIEWS = new Set(["works", "rankings", "categories", "codePrefixes", "codePrefixDetail", "studios", "studioDetail", "people", "personDetail", "history", "channel", "photoDetail", "workDetail", "mediaDetail", "novels", "novelSearch", "novelDetail", "music", "shortVideos", "tools"]);

function readInitialViewState() {
  const state = readViewStateFromHash() || readLastViewState();
  if (state.view === "settings") return { view: "tools", params: {}, settingsRequested: true };
  return state.view === "channel" && normalizeChannelMode(state.params?.mode) === "western"
    ? { view: "people", params: { scope: "western" } }
    : state;
}

function defaultViewState() {
  return { view: DEFAULT_VIEW, params: {} };
}

function readLastViewState() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_VIEW_STORAGE_KEY) || "null");
    if (!raw || raw.view === "home" || !shouldRememberView(raw.view, raw.params || {})) return defaultViewState();
    if (raw.view === "categories") {
      return { view: "people", params: { scope: String(raw.params?.category || "").toLowerCase() === "western" ? "western" : "main" } };
    }
    return { view: raw.view, params: sanitizeViewParams(raw.view, raw.params || {}) };
  } catch {
    return defaultViewState();
  }
}

function rememberViewState(view = currentView, params = currentViewParams) {
  const cleanParams = sanitizeViewParams(view, params || {});
  if (!shouldRememberView(view, cleanParams)) return;
  localStorage.setItem(LAST_VIEW_STORAGE_KEY, JSON.stringify({
    view,
    params: cleanParams,
    updatedAt: new Date().toISOString()
  }));
}

function shouldRememberView(view, params = {}) {
  if (!RESTORABLE_VIEWS.has(view)) return false;
  if (view === "home") return false;
  if (view === "search") return Boolean(String(params.query || "").trim());
  if (view === "personDetail") return Boolean(params.personId);
  if (view === "workDetail") return Boolean(params.workId);
  if (view === "studioDetail") return Boolean(params.studioId);
  if (view === "codePrefixDetail") return Boolean(params.prefix);
  if (view === "channel") return Boolean(params.mode);
  if (view === "photoDetail") return Boolean(params.id);
  if (view === "mangaDetail") return Boolean(params.id);
  if (view === "mangaChapter") return Boolean(params.id && params.chapterIndex);
  if (view === "mediaDetail") return Boolean(params.id);
  if (view === "novelSearch") return true;
  if (view === "novelDetail") return Boolean(params.id);
  if (view === "novelReader") return Boolean(params.id && params.chapterIndex);
  return true;
}

function sanitizeViewParams(view, params = {}) {
  if (view === "works") {
    const favorite = ["1", "true", "yes"].includes(String(params.favorite || "").trim().toLowerCase());
    const folder = favorite ? String(params.folder || "").trim().slice(0, 96) : "";
    return {
      ...(favorite ? { favorite: "1" } : {}),
      ...(folder && folder !== "all" ? { folder } : {})
    };
  }
  if (view === "search") {
    const category = String(params.category || "").trim().toLowerCase() === "western" ? "western" : "censored";
    return { query: String(params.query || "").trim(), category };
  }
  if (view === "people") {
    return { scope: String(params.scope || "main").trim().toLowerCase() === "western" ? "western" : "main" };
  }
  if (view === "personDetail") return {
    personId: String(params.personId || ""),
    scope: String(params.scope || "main").trim().toLowerCase() === "western" ? "western" : "main"
  };
  if (view === "workDetail") return { workId: String(params.workId || "") };
  if (view === "studioDetail") return { studioId: String(params.studioId || ""), seriesId: String(params.seriesId || "all") || "all" };
  if (view === "categories") {
    const category = String(params.category || "censored").trim().toLowerCase();
    return { category: category === "western" ? "western" : "censored" };
  }
  if (view === "codePrefixDetail") {
    const prefix = String(params.prefix || params.codePrefix || "").trim().replaceAll("_", "-").toUpperCase();
    return { prefix, ...(String(params.family || "") === "1" || params.family === true ? { family: "1" } : {}) };
  }
  if (view === "photoDetail") return { id: String(params.id || "") };
  if (view === "mangaDetail") return { id: String(params.id || "") };
  if (view === "mangaChapter") return { id: String(params.id || ""), chapterIndex: String(params.chapterIndex || params.chapter || "") };
  if (view === "novelSearch") return { query: String(params.query || params.q || "").trim() };
  if (view === "novelDetail") return { id: String(params.id || "") };
  if (view === "novelReader") {
    const result = { id: String(params.id || ""), chapterIndex: String(params.chapterIndex || params.chapter || "1") };
    for (const key of ["chapterId", "catalogRevision", "sourceRealm"]) {
      if (typeof params[key] === "string" && params[key]) result[key] = params[key];
    }
    if (params.confirmProgress === "1") result.confirmProgress = "1";
    return result;
  }
  if (view === "music") {
    const rawMode = String(params.mode || "").trim();
    const smartId = String(params.smartId || params.smart || "").trim();
    const playlistId = String(params.playlistId || params.playlist || "").trim();
    const mode = playlistId ? "playlist" : smartId ? "smart" : (rawMode === "history" ? "history" : rawMode === "artists" ? "artists" : rawMode === "albums" ? "albums" : "library");
    const dashboard = !["0", "false", "no"].includes(String(params.dashboard || "").trim().toLowerCase());
    const query = String(params.query || params.q || "").trim();
    const rawSearchScope = String(params.searchScope || params.scope || "").trim().toLowerCase();
    const searchScope = mode === "artists" ? "artists" : mode === "albums" ? "albums" : ["songs", "lyrics", "playlists", "all"].includes(rawSearchScope) ? rawSearchScope : "all";
    const sort = normalizeMusicSort(params.sort);
    const artistSort = String(params.artistSort || "count") === "name" ? "name" : "count";
    const albumSort = normalizeMusicAlbumSort(params.albumSort);
    const favorite = ["1", "true", "yes"].includes(String(params.favorite || params.fav || "").trim().toLowerCase());
    const searchFavorite = ["1", "true", "yes"].includes(String(params.searchFavorite || "").trim().toLowerCase());
    const searchLyrics = ["1", "true", "yes"].includes(String(params.searchLyrics || params.lyrics || "").trim().toLowerCase());
    const searchMinRating = Number(params.searchMinRating || params.minRating || 0) >= 4 ? "4" : "";
    const searchQuality = String(params.searchQuality || params.quality || "").trim().toLowerCase() === "lossless" ? "lossless" : "";
    const artistId = String(params.artistId || params.artist || "").trim();
    const albumId = String(params.albumId || params.album || "").trim();
    const genre = String(params.genre || params.musicGenre || "").trim();
    const language = String(params.language || params.musicLanguage || "").trim();
    const trackId = String(params.trackId || params.track || "").trim();
    return {
      mode,
      ...(!dashboard ? { dashboard: "0" } : {}),
      ...(query ? { query } : {}),
      ...(query && searchScope !== "all" ? { searchScope } : {}),
      ...(sort !== "album" ? { sort } : {}),
      ...(mode === "artists" && artistSort !== "count" ? { artistSort } : {}),
      ...(mode === "albums" && albumSort !== "updated" ? { albumSort } : {}),
      ...(favorite && mode !== "smart" ? { favorite: "1" } : {}),
      ...(query && mode === "library" && searchFavorite ? { searchFavorite: "1" } : {}),
      ...(query && mode === "library" && searchLyrics ? { searchLyrics: "1" } : {}),
      ...(query && mode === "library" && searchMinRating ? { searchMinRating } : {}),
      ...(query && mode === "library" && searchQuality ? { searchQuality } : {}),
      ...(smartId ? { smartId } : {}),
      ...(mode === "playlist" && playlistId ? { playlistId } : {}),
      ...(mode === "library" && artistId ? { artistId } : {}),
      ...(mode === "library" && albumId ? { albumId } : {}),
      ...(mode === "library" && genre ? { genre } : {}),
      ...(["library", "artists", "albums"].includes(mode) && language ? { language } : {}),
      ...(trackId ? { trackId } : {})
    };
  }
  if (["shortVideos", "shortVideoSearch"].includes(view)) {
    return canonicalShortVideoViewParams(view, params);
  }
  if (view === "mediaDetail") {
    const mode = normalizeChannelMode(params.mode || params.type);
    const mediaTrail = normalizeMediaTrail(params.mediaTrail, mode || "movie");
    return {
      id: String(params.id || ""),
      ...(mode && ["western", "media", "movie", "tv", "anime"].includes(mode) ? { mode } : {}),
      ...(mediaTrail ? { mediaTrail } : {})
    };
  }
  if (view === "channel") {
    const query = String(params.q || params.query || "").trim();
    const mode = normalizeChannelMode(params.mode);
    const rawPhotoView = String(params.photoView || "").trim();
    const photoView = mode === "photo" && rawPhotoView !== "albums" ? "collections" : "albums";
    const requestedTvView = String(params.tvView || params.view || "").trim() === "episodes" ? "episodes" : "series";
    const collection = String(params.collection || "").trim();
    const rawCategory = String(params.category || "").trim();
    const category = mode === "photo" && !collection && !rawCategory ? DEFAULT_PHOTO_CATEGORY : rawCategory;
    const person = String(params.person || "").trim();
    const seriesKey = String(params.seriesKey || "").trim();
    const tvView = mode === "anime" && !seriesKey ? "series" : requestedTvView;
    const rawSort = String(params.sort || "").trim();
    const isSeriesMode = mode === "tv" || mode === "anime" || mode === "media";
    const mediaSearch = Boolean(query && ["movie", "tv", "anime", "media"].includes(mode));
    const mediaTrail = isSeriesMode && (seriesKey || tvView === "episodes") ? normalizeMediaTrail(params.mediaTrail, mode) : "";
    const defaultSort = mode === "photo" && photoView === "collections" && !collection && !query ? "count" : mediaSearch ? "relevance" : isSeriesMode && seriesKey ? "title" : "updated";
    const sort = mediaSearch && (rawSort || defaultSort) === "relevance" ? "relevance" : normalizeChannelSort(rawSort || defaultSort);
    return {
      mode,
      ...(query ? { query } : {}),
      ...(sort !== "updated" || defaultSort !== "updated" || mediaSearch ? { sort } : {}),
      ...(mode === "photo" ? { photoView: collection ? "albums" : photoView } : {}),
      ...(isSeriesMode && tvView === "episodes" && !seriesKey ? { tvView } : {}),
      ...(isSeriesMode && seriesKey ? { tvView: "episodes", seriesKey } : {}),
      ...(mediaTrail ? { mediaTrail } : {}),
      ...(mode === "photo" && category ? { category } : {}),
      ...(["western", "media", "movie", "tv", "anime"].includes(mode) && category && category !== "all" ? { category } : {}),
      ...(mode === "photo" && person && person !== "all" ? { person } : {}),
      ...(mode === "photo" && collection ? { collection } : {})
    };
  }
  return {};
}

function normalizeChannelSort(value) {
  const sort = String(value || "").trim();
  return ["updated", "count", "title", "size", "rating"].includes(sort) ? sort : "updated";
}

function normalizeChannelMode(value) {
  const mode = String(value || "").trim();
  if (mode === "movies") return "movie";
  if (["video", "videos", "screen", "film", "films"].includes(mode)) return "media";
  return ["photo", "manga", "western", "media", "movie", "tv", "anime"].includes(mode) ? mode : "";
}

function normalizeMusicSort(value) {
  const sort = String(value || "album").trim();
  return ["album", "artist", "title", "duration", "played", "favorite", "rating"].includes(sort) ? sort : "album";
}

function normalizeMusicAlbumSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "year", "tracks"].includes(sort) ? sort : "updated";
}

function readViewStateFromHash(hash = window.location.hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return null;

  const [rawView, rawQuery = ""] = raw.split("?");
  const view = decodeURIComponent(rawView || "");
  if (view !== "settings" && !RESTORABLE_VIEWS.has(view)) return null;

  const params = Object.fromEntries(new URLSearchParams(rawQuery));
  const cleanParams = sanitizeViewParams(view, params);
  if (view !== "settings" && !shouldRememberView(view, cleanParams)) return null;
  return { view, params: cleanParams };
}

function viewRouteHash(view, params = {}) {
  const cleanParams = sanitizeViewParams(view, params || {});
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(cleanParams)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  const suffix = query.toString();
  return `#${encodeURIComponent(view)}${suffix ? `?${suffix}` : ""}`;
}

function setStatus(message, type = "normal") {
  els.statusText.textContent = message;
  els.statusText.classList.toggle("error", type === "error");
}

function setConnection(label, online) {
  els.connectionBadge.textContent = label;
  els.connectionBadge.classList.toggle("offline", !online);
}

function connectionModeLabel(url = activeUrl, access = null) {
  const parsed = parseServerUrl(url);
  if (!parsed) return access?.mode === "lan" ? "局域网" : "远程";
  if (isLocalHost(parsed.hostname)) return "本机";
  if (isPrivateHost(parsed.hostname)) return "局域网";
  return "远程";
}

function parseServerUrl(value) {
  try {
    return new URL(normalizeUrl(value));
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;

  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

function isFastServerUrl(url = activeUrl) {
  const parsed = parseServerUrl(url);
  if (!parsed) return false;
  return isLocalHost(parsed.hostname) || isPrivateHost(parsed.hostname);
}

function resetViewLimitsForView(view = currentView) {
  peopleLimit = defaultPeopleLimit();
  worksLimit = defaultWorksLimitForView(view);
  channelLimit = defaultChannelLimitForView(view, currentViewParams);
  photoImageLimit = defaultPhotoImageLimitForView(view);
  mangaImageLimit = defaultMangaImageLimitForView(view);
}

function captureChannelRange(view = currentView, params = currentViewParams) {
  if (view !== "channel" || currentView !== view || !sameViewParams(sanitizeViewParams(view, params), currentViewParams)) return "";
  return channelHistoryState.capture(activeUrl, viewRouteHash(view, params), channelLimit);
}

function restoreChannelRange(token, view = currentView, params = currentViewParams) {
  if (view !== "channel") return;
  channelLimit = channelHistoryState.restore(token, activeUrl, viewRouteHash(view, params), channelLimit);
}

function defaultPeopleLimit() {
  return isFastServerUrl() ? FAST_PEOPLE_LIMIT : 48;
}

function worksLimitStepForView(view, fallback = 80) {
  if (isFastServerUrl()) return Math.max(Number(fallback) || 0, FAST_WORK_STEP);
  if (view === "works") return Math.min(Number(fallback) || 60, 60);
  return Math.min(Number(fallback) || 48, 48);
}

function channelLimitStepForView(view, fallback = 48, params = currentViewParams) {
  if (isPhotoChannelView(view, params)) {
    return isFastServerUrl()
      ? Math.max(Number(fallback) || 0, FAST_PHOTO_CHANNEL_STEP)
      : Math.min(Number(fallback) || PHOTO_CHANNEL_STEP, PHOTO_CHANNEL_STEP);
  }
  if (isFastServerUrl()) return Math.max(Number(fallback) || 0, FAST_CHANNEL_STEP);
  if (view === "channel") return Math.min(Number(fallback) || 36, 36);
  return Math.min(Number(fallback) || 24, 24);
}

function peopleLimitStep(fallback = 48) {
  return isFastServerUrl()
    ? Math.max(Number(fallback) || 0, FAST_PEOPLE_STEP)
    : Math.min(Number(fallback) || 48, 48);
}

function photoImageLimitStep(fallback = 24) {
  if (isFastServerUrl()) return Math.max(Number(fallback) || 0, FAST_PHOTO_IMAGE_STEP);
  return Math.min(Number(fallback) || 18, 18);
}

function mangaImageLimitStep(fallback = 12) {
  if (isFastServerUrl()) return Math.max(Number(fallback) || 0, FAST_MANGA_IMAGE_STEP);
  return Math.min(Number(fallback) || 12, 12);
}

function invalidateViewRender() {
  viewRenderToken += 1;
  activeViewController?.abort();
  activeViewController = null;
}

function beginViewRender(view, params = {}) {
  viewRenderToken += 1;
  activeViewController?.abort();
  const controller = new AbortController();
  activeViewController = controller;
  const token = viewRenderToken;
  const expectedView = view;
  const expectedParams = { ...(params || {}) };
  const guard = () =>
    !controller.signal.aborted &&
    token === viewRenderToken &&
    currentView === expectedView &&
    sameViewParams(currentViewParams, expectedParams);
  guard.signal = controller.signal;
  return guard;
}

function sameViewParams(a = {}, b = {}) {
  const aKeys = Object.keys(a || {}).sort();
  const bKeys = Object.keys(b || {}).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => key === bKeys[index] && String(a[key] ?? "") === String(b[key] ?? ""));
}

function currentScrollY() {
  return Math.max(0, Math.round(window.scrollY || document.documentElement.scrollTop || 0));
}

function scrollToTopInstant() {
  window.scrollTo({ top: 0, behavior: "auto" });
}

function queueScrollRestore(value = 0) {
  const target = Math.max(0, Math.round(Number(value) || 0));
  pendingScrollRestore = {
    target,
    token: viewRenderToken,
    attempts: 0
  };
  requestAnimationFrame(restorePendingScroll);
}

function restorePendingScroll() {
  const pending = pendingScrollRestore;
  if (!pending || pending.token !== viewRenderToken) return;

  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo({ top: Math.min(pending.target, maxScroll), behavior: "auto" });
  pending.attempts += 1;

  const closeEnough = Math.abs(currentScrollY() - Math.min(pending.target, maxScroll)) < 3;
  const settled = closeEnough && (pending.target === 0 || maxScroll >= pending.target);
  if (settled || pending.attempts >= 24) {
    pendingScrollRestore = null;
    return;
  }

  window.setTimeout(restorePendingScroll, pending.attempts < 4 ? 80 : 220);
}

function cancelPendingScrollRestore() {
  pendingScrollRestore = null;
  scrollRestoreIntent += 1;
}

function cancelScrollRestoreFromKeydown(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
  if (event.target?.isContentEditable || event.target?.closest?.("input, textarea, select, [role='textbox']")) return;
  cancelPendingScrollRestore();
}

async function updateCacheStatus() {
  if (!els.cacheStatus) return;
  try {
    const stats = await getCacheStats(activeUrl);
    if (!stats.count) {
      els.cacheStatus.textContent = "当前服务暂无缓存";
      renderCacheMetrics(stats);
      return;
    }
    const size = formatBytes(stats.bytes) || "0 B";
    els.cacheStatus.textContent = `${formatNumber(stats.count)} 项 · ${size}`;
    renderCacheMetrics(stats);
  } catch (error) {
    els.cacheStatus.textContent = `缓存不可用：${error.message}`;
    renderCacheMetrics(null);
  }
}

function renderCacheMetrics(stats) {
  const empty = !stats || !stats.count;
  if (els.cacheBytes) els.cacheBytes.textContent = empty ? "0 B" : formatBytes(stats.bytes);
  if (els.cacheResponseCount) {
    els.cacheResponseCount.textContent = empty ? "0 项" : `${formatNumber(stats.responseCount)} 项 · ${formatBytes(stats.responseBytes)}`;
  }
  if (els.cacheImageCount) {
    els.cacheImageCount.textContent = empty ? "0 张" : `${formatNumber(stats.imageCount)} 张 · ${formatBytes(stats.imageBytes)}`;
  }
  if (els.cacheUpdated) els.cacheUpdated.textContent = empty ? "-" : cacheAgeText(stats.latestUpdatedAt);
}

async function updateReaderCacheStatus() {
  if (!els.readerCacheStatus) return null;
  try {
    const payload = await fetchJson(activeUrl, "/api/image-reader/cache", { timeoutMs: 8000 });
    readerCacheSnapshot = payload?.cache || null;
    renderReaderCacheMetrics(readerCacheSnapshot);
    return readerCacheSnapshot;
  } catch (error) {
    readerCacheSnapshot = null;
    els.readerCacheStatus.textContent = `电脑端不可用：${error.message}`;
    els.readerCacheStatus.classList.add("error");
    renderReaderCacheMetrics(null);
    return null;
  }
}

async function updateMangaStorageStatus(options = {}) {
  if (!els.mangaStorageStatus) return null;
  try {
    const suffix = options.force ? "?refresh=1" : "";
    const payload = await fetchJson(activeUrl, `/api/manga/storage${suffix}`, { timeoutMs: 20000 });
    mangaStorageSnapshot = payload?.storage || null;
    renderMangaStorageMetrics(mangaStorageSnapshot);
    return mangaStorageSnapshot;
  } catch (error) {
    mangaStorageSnapshot = null;
    els.mangaStorageStatus.textContent = `电脑端不可用：${error.message}`;
    els.mangaStorageStatus.classList.add("error");
    renderMangaStorageMetrics(null);
    return null;
  }
}

function renderMangaStorageMetrics(storage) {
  const available = Boolean(storage?.exists);
  const trash = storage?.trash || {};
  const trashItems = available && Array.isArray(trash.items) ? trash.items : [];
  const trashCount = Math.max(0, Number(trash.itemCount || 0));
  const trashBytes = Math.max(0, Number(trash.bytes || 0));
  const imageTotal = available ? Math.max(0, Number(storage.imageCount || 0)) : 0;
  const failedImages = available ? Math.min(imageTotal, Math.max(0, Number(storage.failedCount || 0))) : 0;
  const downloadedImages = available
    ? Math.min(imageTotal, Math.max(0, Number(storage.downloadedCount ?? (imageTotal - failedImages))))
    : 0;
  const pendingImages = Math.max(0, imageTotal - downloadedImages - failedImages);
  const integrityPercent = imageTotal > 0 ? Math.min(100, (downloadedImages / imageTotal) * 100) : 0;
  const integrityLabel = integrityPercent >= 100
    ? "100%"
    : integrityPercent >= 99 ? `${integrityPercent.toFixed(2)}%` : `${integrityPercent.toFixed(1)}%`;
  const hasImageIssues = available && (failedImages > 0 || pendingImages > 0);
  if (els.mangaStorageStatus) {
    els.mangaStorageStatus.classList.toggle("error", !available);
    if (available) {
      els.mangaStorageStatus.textContent = Number(storage.diskFreeBytes || 0) > 0
        ? `磁盘可用 ${formatBytes(storage.diskFreeBytes)}`
        : "电脑端原图";
    }
  }
  if (els.mangaStorageBytes) els.mangaStorageBytes.textContent = available ? formatBytes(storage.bytes || 0) : "-";
  if (els.mangaStorageComics) els.mangaStorageComics.textContent = available ? `${formatNumber(storage.comicCount || 0)} 本` : "-";
  if (els.mangaStorageChapters) els.mangaStorageChapters.textContent = available ? `${formatNumber(storage.chapterCount || 0)} 话` : "-";
  if (els.mangaStorageImages) els.mangaStorageImages.textContent = available ? `${formatNumber(imageTotal)} 张` : "-";
  if (els.mangaStorageHealth) els.mangaStorageHealth.classList.toggle("has-issues", hasImageIssues);
  if (els.mangaStorageHealthStatus) {
    els.mangaStorageHealthStatus.textContent = available
      ? (imageTotal ? `${formatNumber(downloadedImages)} / ${formatNumber(imageTotal)} 张 · ${integrityLabel}` : "暂无原图")
      : "-";
  }
  if (els.mangaStorageProgressTrack) {
    els.mangaStorageProgressTrack.classList.toggle("is-over", hasImageIssues);
    els.mangaStorageProgressTrack.setAttribute("aria-valuenow", String(Number(integrityPercent.toFixed(2))));
    els.mangaStorageProgressTrack.setAttribute("aria-valuetext", available
      ? `已完成 ${formatNumber(downloadedImages)} 张，共 ${formatNumber(imageTotal)} 张`
      : "电脑端不可用");
  }
  if (els.mangaStorageProgress) els.mangaStorageProgress.style.width = `${integrityPercent}%`;
  if (els.mangaStorageIssues) {
    els.mangaStorageIssues.classList.toggle("error", hasImageIssues);
    els.mangaStorageIssues.textContent = !available
      ? "连接电脑端后显示完整性"
      : !imageTotal
        ? "书库中暂时没有原图"
        : hasImageIssues
        ? [failedImages ? `${formatNumber(failedImages)} 张下载失败` : "", pendingImages ? `${formatNumber(pendingImages)} 张待处理` : "", "可从对应书页再次更新补齐"].filter(Boolean).join(" · ")
        : "全部原图已经完成，没有失败或待处理图片";
  }
  if (els.mangaTrashStatus) {
    els.mangaTrashStatus.textContent = available
      ? (trashCount ? `${formatNumber(trashCount)} 本 · ${formatBytes(trashBytes)}` : "空")
      : "-";
  }
  renderMangaTrashItems(trashItems);
  if (els.mangaStorageHelp) {
    els.mangaStorageHelp.title = available ? String(storage.root || "") : "";
  }
  if (els.openMangaStorageButton) els.openMangaStorageButton.disabled = !available;
  if (els.clearMangaTrashButton) {
    els.clearMangaTrashButton.disabled = !available || trashCount <= 0;
    els.clearMangaTrashButton.textContent = trashCount > 0 ? "清空回收站" : "回收站为空";
  }
}

function renderMangaTrashItems(items = []) {
  if (!els.mangaTrashList) return;
  els.mangaTrashList.replaceChildren();
  els.mangaTrashList.hidden = items.length === 0;
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "storage-trash-item";

    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = String(item?.title || "未命名漫画").trim() || "未命名漫画";
    const meta = document.createElement("small");
    const deletedAt = new Date(String(item?.deletedAt || ""));
    const deletedLabel = Number.isNaN(deletedAt.getTime())
      ? "删除时间未知"
      : `${deletedAt.toLocaleDateString("zh-CN")} 删除`;
    meta.textContent = [formatBytes(item?.bytes || 0), deletedLabel].filter(Boolean).join(" · ");
    copy.append(title, meta);

    const restore = document.createElement("button");
    restore.type = "button";
    restore.dataset.mangaTrashRestore = "";
    restore.textContent = "恢复";
    restore.setAttribute("aria-label", `恢复漫画《${title.textContent}》`);
    restore.addEventListener("click", async () => {
      const confirmed = await requestAppConfirmation({
        title: "恢复漫画",
        message: `把《${title.textContent}》恢复到电脑漫画书库，并重新加入更新列表。`,
        confirmLabel: "恢复"
      });
      if (!confirmed) return;
      setCacheActionsDisabled(true);
      els.mangaStorageStatus.textContent = `正在恢复《${title.textContent}》`;
      els.mangaStorageStatus.classList.remove("error");
      try {
        const result = await fetchJson(activeUrl, `/api/manga/trash/${encodeURIComponent(item.name)}/restore`, {
          method: "POST",
          timeoutMs: 0
        });
        mangaStorageSnapshot = result?.storage || null;
        renderMangaStorageMetrics(mangaStorageSnapshot);
        els.mangaStorageStatus.textContent = `已恢复《${String(result?.comic?.title || title.textContent)}》`;
      } catch (error) {
        els.mangaStorageStatus.textContent = `恢复失败：${error.message}`;
        els.mangaStorageStatus.classList.add("error");
      } finally {
        setCacheActionsDisabled(false);
      }
    });

    row.append(copy, restore);
    els.mangaTrashList.append(row);
  }
}

function renderReaderCacheMetrics(cache) {
  const available = Boolean(cache);
  const currentBytes = Math.max(0, Number(cache?.currentBytes || 0));
  const maxBytes = Math.max(0, Number(cache?.maxBytes || 0));
  const percent = maxBytes > 0 ? Math.min(100, (currentBytes / maxBytes) * 100) : (currentBytes > 0 ? 100 : 0);
  if (els.readerCacheStatus) {
    els.readerCacheStatus.classList.toggle("error", !available);
    if (available) {
      els.readerCacheStatus.textContent = Number(cache.overBytes || 0) > 0
        ? `已超出上限 ${formatBytes(cache.overBytes)}`
        : `已使用 ${percent < 0.1 && currentBytes > 0 ? "<0.1" : percent.toFixed(1)}%`;
    }
  }
  if (els.readerCacheBytes) els.readerCacheBytes.textContent = available ? formatBytes(currentBytes) : "-";
  if (els.readerCacheLimit) els.readerCacheLimit.textContent = available ? formatBytes(maxBytes) : "-";
  if (els.readerCacheFiles) els.readerCacheFiles.textContent = available ? formatNumber(cache.fileCount || 0) : "-";
  if (els.readerCacheCleanup) {
    const minutes = Math.max(1, Math.round(Number(cache?.cleanupIntervalMs || 0) / 60000));
    els.readerCacheCleanup.textContent = available ? `${minutes} 分钟` : "-";
  }
  if (els.readerCacheProgress) els.readerCacheProgress.style.width = `${percent}%`;
  if (els.readerCacheProgressTrack) {
    els.readerCacheProgressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
    els.readerCacheProgressTrack.classList.toggle("is-over", Number(cache?.overBytes || 0) > 0);
  }
  if (available && els.readerCacheLimitInput && document.activeElement !== els.readerCacheLimitInput) {
    els.readerCacheLimitInput.value = String(Math.round((maxBytes / (1024 ** 3)) * 100) / 100);
  }
}

async function updateStorageStatus(options = {}) {
  await Promise.all([
    updateCacheStatus(),
    updateMangaStorageStatus({ force: options.forceManga === true }),
    updateReaderCacheStatus()
  ]);
}

function setCacheActionsDisabled(disabled) {
  if (els.refreshCacheButton) els.refreshCacheButton.disabled = disabled;
  if (els.clearResponseCacheButton) els.clearResponseCacheButton.disabled = disabled;
  if (els.clearImageCacheButton) els.clearImageCacheButton.disabled = disabled;
  if (els.clearCacheButton) els.clearCacheButton.disabled = disabled;
  if (els.clearMangaTrashButton) {
    els.clearMangaTrashButton.disabled = disabled || Number(mangaStorageSnapshot?.trash?.itemCount || 0) <= 0;
  }
  for (const button of els.mangaTrashList?.querySelectorAll("[data-manga-trash-restore]") || []) {
    button.disabled = disabled;
  }
  if (els.saveReaderCacheLimitButton) els.saveReaderCacheLimitButton.disabled = disabled;
  if (els.cleanupReaderCacheButton) els.cleanupReaderCacheButton.disabled = disabled;
}

async function loadImageLibrarySummary() {
  if (!els.omniGrid) return false;
  const requestUrl = activeUrl;
  if (!imageLibrarySummary) renderOmniSummary(null, { loading: true });

  const cached = await readCachedJson(requestUrl, IMAGE_LIBRARY_SUMMARY_CACHE_PATH).catch(() => null);
  if (requestUrl !== activeUrl) return false;
  if (cached?.payload) {
    imageLibrarySummary = cached.payload;
    renderOmniSummary(imageLibrarySummary, { cachedAt: cached.updatedAt });
  }

  try {
    const summary = await fetchJson(requestUrl, IMAGE_LIBRARY_SUMMARY_CACHE_PATH, { timeoutMs: 12000 });
    if (requestUrl !== activeUrl) return false;
    imageLibrarySummary = summary;
    writeCachedJson(requestUrl, IMAGE_LIBRARY_SUMMARY_CACHE_PATH, summary).catch(() => {});
    renderOmniSummary(imageLibrarySummary);
    return true;
  } catch (error) {
    if (requestUrl !== activeUrl) return false;
    renderOmniSummary(imageLibrarySummary, { error });
    return false;
  }
}

async function loadNovelSummary() {
  const requestUrl = activeUrl;
  const cached = await readCachedJson(requestUrl, NOVEL_SUMMARY_CACHE_PATH).catch(() => null);
  if (requestUrl !== activeUrl) return false;
  if (cached?.payload) {
    novelSummary = cached.payload;
    syncNovelCounts();
    renderOmniSummary(imageLibrarySummary);
  }

  try {
    const summary = await fetchJson(requestUrl, NOVEL_SUMMARY_CACHE_PATH, { timeoutMs: 10000 });
    if (requestUrl !== activeUrl) return false;
    novelSummary = summary;
    writeCachedJson(requestUrl, NOVEL_SUMMARY_CACHE_PATH, summary).catch(() => {});
    syncNovelCounts();
    renderOmniSummary(imageLibrarySummary);
    return true;
  } catch {
    if (requestUrl !== activeUrl) return false;
    syncNovelCounts();
    return false;
  }
}

async function loadMusicSummary() {
  const requestUrl = activeUrl;
  const cached = await readCachedJson(requestUrl, MUSIC_SUMMARY_CACHE_PATH).catch(() => null);
  if (requestUrl !== activeUrl) return false;
  if (cached?.payload) {
    musicSummary = cached.payload;
    syncMusicCounts();
    renderOmniSummary(imageLibrarySummary);
  }

  try {
    const summary = await fetchJson(requestUrl, MUSIC_SUMMARY_CACHE_PATH, { timeoutMs: 10000 });
    if (requestUrl !== activeUrl) return false;
    musicSummary = summary;
    writeCachedJson(requestUrl, MUSIC_SUMMARY_CACHE_PATH, summary).catch(() => {});
    syncMusicCounts();
    renderOmniSummary(imageLibrarySummary);
    return true;
  } catch {
    if (requestUrl !== activeUrl) return false;
    syncMusicCounts();
    return false;
  }
}

async function loadShortVideoSummary() {
  const requestUrl = activeUrl;
  const cached = await readCachedJson(requestUrl, SHORT_VIDEO_SUMMARY_CACHE_PATH).catch(() => null);
  if (requestUrl !== activeUrl) return false;
  if (cached?.payload) {
    shortVideoSummary = cached.payload;
    syncShortVideoCounts();
    renderOmniSummary(imageLibrarySummary);
  }

  try {
    const summary = await fetchJson(requestUrl, SHORT_VIDEO_SUMMARY_CACHE_PATH, { timeoutMs: 10000 });
    if (requestUrl !== activeUrl) return false;
    shortVideoSummary = summary;
    writeCachedJson(requestUrl, SHORT_VIDEO_SUMMARY_CACHE_PATH, summary).catch(() => {});
    syncShortVideoCounts();
    renderOmniSummary(imageLibrarySummary);
    return true;
  } catch {
    if (requestUrl !== activeUrl) return false;
    syncShortVideoCounts();
    return false;
  }
}

function renderOmniSummary(summary, state = {}) {
  if (!els.omniGrid) return;
  syncChannelCounts(summary);
  syncNovelCounts();
  syncMusicCounts();
  syncShortVideoCounts();
  els.omniGrid.innerHTML = "";

  if (!summary && state.loading) {
    els.omniMeta.textContent = "正在读取";
    els.omniGrid.innerHTML = `<div class="loading-row">正在读取图像和媒体资料库</div>`;
    return;
  }

  if (!summary) {
    els.omniMeta.textContent = state.error ? "暂不可用" : "等待数据";
    els.omniGrid.innerHTML = `<div class="loading-row">图像和媒体资料库暂时不可用</div>`;
    return;
  }

  els.omniMeta.textContent = omniMetaText(summary, state);
  for (const channel of omniChannels(summary)) {
    els.omniGrid.append(createOmniCard(channel));
  }
}

function omniMetaText(summary, state = {}) {
  if (state.error) return "离线缓存";
  if (state.cachedAt) return `缓存 ${cacheAgeText(state.cachedAt)}`;
  if (summary.scannedAt) return `更新 ${cacheAgeText(summary.scannedAt)}`;
  return "已连接";
}

function omniChannels(summary = {}) {
  const totals = summary.totals || {};
  const workTotals = library?.totals || {};
  return [
    {
      label: "番号库",
      value: formatCompact(workTotals.works),
      unit: "作品",
      detail: `${formatCompact(workTotals.videos)} 视频 · ${formatCompact(workTotals.infoFiles)} 资料`,
      view: "works"
    },
    {
      label: "套图",
      value: formatCompact(totals.photoSets),
      unit: "套",
      detail: [
        totals.manga ? `${formatCompact(totals.manga)} 韩漫` : "",
        formatBytes(totals.photoBytes),
        rootStatusText(summary.photoRoots)
      ].filter(Boolean).join(" · "),
      mode: "photo"
    },
    {
      label: "小说",
      value: formatCompact(novelSummary?.totals?.books || 0),
      unit: "本",
      detail: novelSummary?.totals?.chapters ? `${formatCompact(novelSummary.totals.chapters)} 章` : "本地 TXT 阅读",
      view: "novels"
    },
    {
      label: "音乐",
      value: formatCompact(musicSummary?.totals?.tracks || 0),
      unit: "首",
      detail: musicSummary?.totals?.albums ? `${formatCompact(musicSummary.totals.albums)} 专辑 · ${formatBytes(musicSummary.totals.bytes || 0)}` : "本地音乐播放",
      view: "music"
    },
    {
      label: "短视频",
      value: formatCompact(shortVideoSummary?.totals?.videos || 0),
      unit: "条",
      detail: shortVideoSummary?.totals?.authors ? `${formatCompact(shortVideoSummary.totals.authors)} 作者 · 可刷视频` : "本地短视频库",
      view: "shortVideos"
    },
    {
      label: "影视",
      value: formatCompact(Number(totals.movies || 0) + Number(totals.tv || 0)),
      unit: "作品",
      detail: [
        totals.movies ? `${formatCompact(totals.movies)} 电影` : "",
        totals.tv ? `${formatCompact(totals.tv)} 集` : "",
        mediaRootText(summary, "movie"),
        mediaRootText(summary, "tv")
      ].filter(Boolean).join(" · "),
      mode: "media"
    },
    {
      label: "小工具",
      value: "4",
      unit: "工具",
      detail: "开源小游戏 / TXT 排版",
      view: "tools"
    }
  ];
}

function createOmniCard(channel) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "omni-card";
  card.addEventListener("click", () => {
    if (channel.view) {
      showView(channel.view, {}, { resetStack: true });
      return;
    }
    if (channel.mode) {
      showView("channel", { mode: channel.mode }, { resetStack: true });
      return;
    }
    openInLibrary(channel.path || "/");
  });

  const head = document.createElement("span");
  head.className = "omni-card-label";
  head.textContent = channel.label;

  const value = document.createElement("strong");
  value.className = "omni-card-value";
  value.textContent = channel.value || "0";

  const unit = document.createElement("span");
  unit.className = "omni-card-unit";
  unit.textContent = channel.unit || "";

  const detail = document.createElement("span");
  detail.className = "omni-card-detail";
  detail.textContent = channel.detail || "打开频道";

  card.append(head, value, unit, detail);
  return card;
}

function rootStatusText(roots) {
  const list = Array.isArray(roots) ? roots : roots ? [roots] : [];
  if (!list.length) return "";
  const available = list.filter((item) => item.exists !== false).length;
  if (available === list.length) return `${formatNumber(available)} 个目录可用`;
  return `${formatNumber(available)}/${formatNumber(list.length)} 目录可用`;
}

function mediaRootText(summary = {}, kind) {
  const roots = (summary.mediaRoots || []).filter((item) => item.kind === kind);
  return rootStatusText(roots) || "媒体目录";
}

function syncChannelCounts(summary = imageLibrarySummary) {
  const totals = summary?.totals || {};
  if (els.channelWorksCount) els.channelWorksCount.textContent = library?.totals?.works ? `${formatCompact(library.totals.works)} 作品` : "默认库";
  if (els.channelPhotoCount) {
    els.channelPhotoCount.textContent = totals.photoSets || totals.manga
      ? [`${formatCompact(totals.photoSets)} 套图`, totals.manga ? `${formatCompact(totals.manga)} 韩漫` : ""].filter(Boolean).join(" · ")
      : "套图 / 韩漫";
  }
  if (els.channelMediaCount) {
    els.channelMediaCount.textContent = totals.movies || totals.tv
      ? [`${formatCompact(totals.movies || 0)} 电影`, `${formatCompact(totals.tv || 0)} 集`].join(" · ")
      : "电影 / 电视剧";
  }
  syncNovelCounts();
  syncMusicCounts();
  syncShortVideoCounts();
}

function syncNovelCounts() {
  if (!els.channelNovelCount) return;
  const totals = novelSummary?.totals || {};
  els.channelNovelCount.textContent = totals.books ? `${formatCompact(totals.books)} 本` : "TXT 阅读";
}

function syncMusicCounts() {
  if (!els.channelMusicCount) return;
  const totals = musicSummary?.totals || {};
  els.channelMusicCount.textContent = totals.tracks ? `${formatCompact(totals.tracks)} 首` : "本地播放";
}

function syncShortVideoCounts() {
  if (!els.channelShortVideoCount) return;
  const totals = shortVideoSummary?.totals || {};
  els.channelShortVideoCount.textContent = totals.videos ? `${formatCompact(totals.videos)} 条` : "刷视频";
}

function updateServiceHealth() {
  if (!els.serviceHealthStatus) return;
  renderConfiguredService();
}

function renderConfiguredService() {
  if (!els.serviceHealthStatus) return;
  els.serviceHealthStatus.textContent = "已按当前地址配置，打开内容时会直接使用";
  els.serviceHealthStatus.classList.remove("error");
  setHealthMetric(els.healthMode, connectionModeLabel(activeUrl));
  setHealthMetric(els.healthRoots, "不检测");
  setHealthMetric(els.healthWorks, "-");
  setHealthMetric(els.healthScannedAt, "-");
}

function setHealthMetric(element, text) {
  if (element) element.textContent = text || "-";
}

function fanhaoUpdaterPlugin() {
  return window.Capacitor?.Plugins?.FanHaoUpdater || null;
}

async function readAndroidVersionInfo() {
  const plugin = fanhaoUpdaterPlugin();
  if (!plugin?.getInstalledVersion) {
    return {
      versionName: CLIENT_VERSION,
      versionCode: 0,
      packageName: "",
      canRequestPackageInstalls: false,
      unsupported: true
    };
  }
  return plugin.getInstalledVersion();
}

function androidVersionLabel(info = {}) {
  const source = info || {};
  const name = String(source.versionName || "").trim();
  const code = Number(source.versionCode || 0);
  if (name && code) return `${name} (${formatNumber(code)})`;
  if (name) return name;
  return code ? String(code) : "-";
}

function renderAndroidUpdateState(state = {}) {
  if (!els.appUpdateStatus) return;
  if (Object.prototype.hasOwnProperty.call(state, "status")) {
    androidUpdateStatus = state.status || "idle";
    androidUpdateMessage = "";
  }
  if (Object.prototype.hasOwnProperty.call(state, "update")) androidUpdateInfo = state.update || null;
  if (Object.prototype.hasOwnProperty.call(state, "version")) androidVersionInfo = state.version || androidVersionInfo;
  if (Object.prototype.hasOwnProperty.call(state, "error")) androidUpdateError = state.error || null;
  if (Object.prototype.hasOwnProperty.call(state, "message")) androidUpdateMessage = String(state.message || "");
  if (state.errorPhase) androidUpdateErrorPhase = state.errorPhase;
  const status = androidUpdateStatus;
  const update = androidUpdateInfo;
  const version = androidVersionInfo;
  const error = androidUpdateError;

  if (els.appUpdateSources && !els.appUpdateSources.childElementCount) {
    for (const [index, source] of DEFAULT_UPDATE_URLS.entries()) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = index === 0 ? "局域网" : "公网备用";
      const address = document.createElement("strong");
      address.textContent = new URL(source).host;
      row.append(label, address);
      els.appUpdateSources.append(row);
    }
  }
  if (els.appUpdateSourceStatus) {
    els.appUpdateSourceStatus.textContent = status === "checking"
      ? "按以上顺序检查，连接失败时自动切换"
      : update?.serviceBase
        ? `本次更新源：${new URL(update.serviceBase).host}`
        : "更新地址独立于上方内容服务地址";
  }

  if (els.appCurrentVersion) els.appCurrentVersion.textContent = androidVersionLabel(version);
  if (els.appLatestVersion) {
    els.appLatestVersion.textContent = update?.versionName
      ? `${update.versionName}${update.versionCode ? ` (${formatNumber(update.versionCode)})` : ""}`
      : "-";
  }
  if (els.appUpdateButton) {
    const busy = status === "checking" || status === "installing";
    els.appUpdateButton.disabled = busy || Boolean(version?.unsupported);
    if (status === "checking") els.appUpdateButton.textContent = "正在检查";
    else if (status === "installing") els.appUpdateButton.textContent = "正在下载";
    else if (status === "permission") els.appUpdateButton.textContent = "继续更新";
    else if (status === "opened" || (error && androidUpdateErrorPhase === "resume")) els.appUpdateButton.textContent = "检查安装结果";
    else if (error && androidUpdateErrorPhase === "install") els.appUpdateButton.textContent = "重试更新";
    else if (update?.available) els.appUpdateButton.textContent = "立即更新";
    else if (error) els.appUpdateButton.textContent = "重新检查";
    else els.appUpdateButton.textContent = "检查更新";
  }

  let message = "正在自动检查更新";
  if (version?.unsupported) message = "当前环境不支持应用内更新";
  if (status === "checking") message = "正在检查调试版更新";
  if (status === "installing") message = "正在下载安装包";
  if (status === "permission") message = "已打开安装权限设置，允许后点击继续更新";
  if (status === "opened") message = "安装包已打开，请按系统提示确认";
  if (status === "ready" && update?.available) message = `发现调试版 ${update.versionName || update.versionCode}`;
  if (status === "ready" && !update?.available) message = update?.message || "当前已是最新调试版";
  if (androidUpdateMessage) message = androidUpdateMessage;
  if (error) {
    const action = androidUpdateErrorPhase === "install" ? "更新安装失败" : androidUpdateErrorPhase === "resume" ? "安装状态读取失败" : "更新检查失败";
    message = `${action}：${error.message || error}`;
  }

  els.appUpdateStatus.textContent = message;
  els.appUpdateStatus.classList.toggle("error", Boolean(error));
}

async function checkAndroidUpdate(options = {}) {
  if (!els.appUpdateStatus) return null;
  if (androidUpdateCheckPromise) return androidUpdateCheckPromise;
  if (androidUpdateStatus === "installing" || androidUpdateExternalFlow) return null;
  const generation = ++androidUpdateGeneration;
  renderAndroidUpdateState({ status: "checking", error: null, errorPhase: "check" });
  const request = (async () => {
    try {
      const version = await readAndroidVersionInfo();
      if (generation !== androidUpdateGeneration) return null;
      renderAndroidUpdateState({ version });
      const path = `/api/android/update?channel=${encodeURIComponent(ANDROID_UPDATE_CHANNEL)}&currentVersionCode=${encodeURIComponent(version.versionCode || 0)}&clientVersion=${encodeURIComponent(CLIENT_VERSION)}`;
      const update = version.unsupported
        ? { available: false, channel: ANDROID_UPDATE_CHANNEL, message: "当前环境不支持应用内更新" }
        : await fetchAndroidUpdate(path);
      if (generation !== androidUpdateGeneration) return null;
      renderAndroidUpdateState({ status: "ready", update, version, error: null });
      return update;
    } catch (error) {
      if (generation !== androidUpdateGeneration) return null;
      renderAndroidUpdateState({ status: "error", update: null, error, errorPhase: "check" });
      if (!options.silent) setStatus(`更新检查失败：${error.message || error}`, "error");
      return null;
    } finally {
      if (generation === androidUpdateGeneration) androidUpdateCheckPromise = null;
    }
  })();
  androidUpdateCheckPromise = request;
  return request;
}

function refreshAndroidUpdateSource() {
  if (androidUpdateStatus === "installing" || androidUpdateExternalFlow) return;
  ++androidUpdateGeneration;
  androidUpdateCheckPromise = null;
  renderAndroidUpdateState({ status: "idle", update: null, error: null });
  void checkAndroidUpdate({ silent: true });
}

async function fetchAndroidUpdate(path) {
  const sources = [...new Set(DEFAULT_UPDATE_URLS.map(normalizeUrl).filter(Boolean))];
  let lastError = null;
  let latest = null;
  for (const serviceBase of sources) {
    try {
      const update = await fetchJson(serviceBase, path, { timeoutMs: 8000, cache: "no-store" });
      const candidate = { ...update, serviceBase };
      if (!latest || Number(candidate.versionCode || 0) > Number(latest.versionCode || 0)) latest = candidate;
      if (candidate.available) return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  if (latest) return latest;
  throw lastError || new Error("默认更新地址不可用");
}

async function installAndroidUpdate() {
  const plugin = fanhaoUpdaterPlugin();
  if (!plugin?.downloadAndInstall) {
    renderAndroidUpdateState({ status: "error", errorPhase: "install", error: new Error("当前环境不支持应用内更新") });
    return;
  }
  if (!androidUpdateInfo?.available || !androidUpdateInfo?.downloadUrl) {
    const update = await checkAndroidUpdate();
    if (!update?.available) return;
  }

  androidUpdateExternalFlow = "";
  androidUpdateReturnPending = false;
  renderAndroidUpdateState({ status: "installing", update: androidUpdateInfo, version: androidVersionInfo, error: null, errorPhase: "install" });
  try {
    const result = await plugin.downloadAndInstall({
      url: androidUpdateInfo.downloadUrl,
      serviceBase: androidUpdateInfo.serviceBase,
      fileName: androidUpdateInfo.fileName || `fanhao-${ANDROID_UPDATE_CHANNEL}.apk`,
      sha256: androidUpdateInfo.sha256 || "",
      versionCode: Number(androidUpdateInfo.versionCode || 0),
      versionName: String(androidUpdateInfo.versionName || ""),
      size: Number(androidUpdateInfo.size || 0)
    });
    if (!result?.needsPermission && result?.started !== true) throw new Error("系统安装器未打开，请重试");
    androidUpdateExternalFlow = result.needsPermission ? "permission" : "install";
    renderAndroidUpdateState({
      status: result?.needsPermission ? "permission" : "opened",
      update: androidUpdateInfo,
      version: androidVersionInfo
    });
    if (androidUpdateReturnPending) void reconcileAndroidUpdateReturn();
  } catch (error) {
    androidUpdateReturnPending = false;
    renderAndroidUpdateState({ status: "error", error, errorPhase: "install", update: androidUpdateInfo, version: androidVersionInfo });
  }
}

async function reconcileAndroidUpdateReturn() {
  if (androidUpdateStatus === "installing") {
    androidUpdateReturnPending = true;
    return null;
  }
  if (androidUpdateResumePromise) return androidUpdateResumePromise;
  if (!androidUpdateExternalFlow) return null;
  const flow = androidUpdateExternalFlow;
  const generation = ++androidUpdateGeneration;
  androidUpdateReturnPending = false;
  renderAndroidUpdateState({ status: "checking", error: null, message: "正在确认安装结果" });
  const request = (async () => {
    try {
      const version = await readAndroidVersionInfo();
      if (generation !== androidUpdateGeneration) return null;
      if (version.unsupported) throw new Error("当前环境无法确认安装状态");
      const installed = Number(version.versionCode || 0) >= Number(androidUpdateInfo?.versionCode || Infinity);
      if (installed) {
        androidUpdateExternalFlow = "";
        renderAndroidUpdateState({ status: "ready", version, update: { ...androidUpdateInfo, available: false }, error: null, message: "更新已安装完成" });
      } else if (flow === "permission" && !version.canRequestPackageInstalls) {
        renderAndroidUpdateState({ status: "permission", version, error: null, message: "尚未允许安装更新，点击继续更新可前往设置" });
      } else {
        androidUpdateExternalFlow = "";
        renderAndroidUpdateState({ status: "ready", version, error: null, message: flow === "permission" ? "安装权限已就绪，点击立即更新继续" : "本次安装尚未完成，可以重新更新" });
      }
      return version;
    } catch (error) {
      if (generation === androidUpdateGeneration) renderAndroidUpdateState({ status: "error", error, errorPhase: "resume" });
      return null;
    } finally {
      if (generation === androidUpdateGeneration) androidUpdateResumePromise = null;
    }
  })();
  androidUpdateResumePromise = request;
  return request;
}

function watchAndroidUpdateReturn() {
  const plugin = fanhaoUpdaterPlugin();
  if (plugin?.addListener) {
    Promise.resolve(plugin.addListener("updateFlowReturned", () => {
      androidUpdateReturnPending = true;
      void reconcileAndroidUpdateReturn();
    })).catch((error) => console.warn("[android-update-return]", error));
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && androidUpdateExternalFlow) void reconcileAndroidUpdateReturn();
  });
}

async function handleAndroidUpdateAction() {
  if (androidUpdateStatus === "checking" || androidUpdateStatus === "installing") return;
  if (androidUpdateStatus === "opened" || (androidUpdateError && androidUpdateErrorPhase === "resume")) {
    await reconcileAndroidUpdateReturn();
    return;
  }
  if (androidUpdateInfo?.available) {
    await installAndroidUpdate();
    return;
  }
  await checkAndroidUpdate();
}

function applyTheme(value) {
  themePreference = ["light", "dark", "system"].includes(value) ? value : "system";
  localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  if (themePreference === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = themePreference;
  }
  for (const button of els.themeButtons || []) {
    button.classList.toggle("active", button.dataset.themeChoice === themePreference);
  }
}

function updateServer(url) {
  const previousUrl = activeUrl;
  activeUrl = normalizeUrl(url);
  localStorage.setItem(STORAGE_KEY, activeUrl);
  els.serverUrl.value = activeUrl;
  els.serverLabel.textContent = activeUrl;
  imageLibrarySummary = null;
  novelSummary = null;
  musicSummary = null;
  shortVideoSummary = null;
  resetViewLimitsForView();
  renderOmniSummary(null, { loading: true });

  for (const button of els.quickServers) {
    button.classList.toggle("active", normalizeUrl(button.dataset.url) === activeUrl);
  }
  if (previousUrl !== activeUrl) {
    ++libraryLoadGeneration;
    libraryLoadPromise = null;
    libraryLoadError = null;
    library = null;
  }
  if (previousUrl !== activeUrl) workViews?.pageDataService?.invalidate(previousUrl, "/");
  void toolViews?.refreshComputerControlAccess?.();
  syncConnectionControls();
}

function syncConnectionControls() {
  let requestedUrl = "";
  try { requestedUrl = normalizeUrl(els.serverUrl.value); } catch {}
  const busy = connectionPending || Boolean(libraryLoadPromise && requestedUrl === activeUrl);
  if (els.connectServerButton) {
    els.connectServerButton.disabled = busy;
    els.connectServerButton.textContent = busy ? "连接中" : "连接";
  }
  els.connectForm.setAttribute("aria-busy", String(busy));
  for (const button of els.quickServers) {
    const selected = normalizeUrl(button.dataset.url) === activeUrl;
    button.disabled = Boolean(libraryLoadPromise && selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

async function connectToServer(value, password = "") {
  let requestedUrl;
  try {
    const raw = String(value || "").trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) throw new Error("unsupported scheme");
    requestedUrl = normalizeUrl(raw);
    const parsed = new URL(requestedUrl);
    if (parsed.username || parsed.password) throw new Error("embedded credentials");
  } catch {
    ++connectionAttempt;
    connectionPending = false;
    connectionPendingUrl = "";
    syncConnectionControls();
    setStatus("地址格式不对，可以写成 192.168.31.86:29998。", "error");
    return null;
  }
  if (connectionPending && connectionPendingUrl === requestedUrl) return null;
  const attempt = ++connectionAttempt;
  // An explicit login or server selection must not reuse a request made with old credentials.
  if (libraryLoadPromise) {
    ++libraryLoadGeneration;
    libraryLoadPromise = null;
  }
  connectionPending = true;
  connectionPendingUrl = requestedUrl;
  els.serverUrl.value = requestedUrl;
  if (!els.settingsOverlay?.hidden && accountSettingsServer !== requestedUrl) refreshAccountSettings();
  syncConnectionControls();
  try {
    registerServerAuthentication(requestedUrl);
    let authentication = await fetchJson(requestedUrl, "/api/auth/status");
    if (attempt !== connectionAttempt) return null;
    if (password && !requiresUserAccount(authentication)) {
      setStatus("正在验证访问密码…");
      await loginToServer(requestedUrl, password);
      if (attempt !== connectionAttempt) return null;
      if (els.serverPassword) els.serverPassword.value = "";
      authentication = await fetchJson(requestedUrl, "/api/auth/status");
      if (attempt !== connectionAttempt) return null;
    }
    if (authentication.required && !authentication.authenticated) {
      showAccountLogin(requestedUrl, authentication);
      return null;
    }
  } catch (error) {
    if (attempt === connectionAttempt) {
      if (isServerAuthenticationError(error)) showAccountLogin(requestedUrl, error);
      else setStatus(error.message || "连接失败，请检查地址和密码。", "error");
    }
    return null;
  } finally {
    if (attempt === connectionAttempt) {
      connectionPending = false;
      connectionPendingUrl = "";
      syncConnectionControls();
    }
  }
  const changed = requestedUrl !== activeUrl;
  updateServer(requestedUrl);
  workViews?.pageDataService?.invalidate(requestedUrl, "/");
  const request = loadDashboard();
  updateServiceHealth();
  if (changed) refreshAndroidUpdateSource();
  void refreshModuleCatalog(requestedUrl);
  // Refresh server-backed content once for the explicit connection action.
  // Background completion must not reset a page the user subsequently opens.
  if (androidModuleRegistry && currentView !== "tools") renderCurrentViewPreservingScroll();
  return request;
}

function showAccountLogin(serverUrl, state) {
  els.serverUrl.value = serverUrl;
  const alreadyOpen = !els.settingsOverlay?.hidden;
  showSettings({ section: "account" });
  if (alreadyOpen) {
    refreshAccountSettings();
    document.getElementById("accountSettingsRoot")?.scrollIntoView({ block: "start" });
  }
  setStatus(accountLoginMessage(state), "error");
}

function openInLibrary(target = {}) {
  const options = typeof target === "string" ? { path: target } : target;
  if (openNativeLibraryRoute(options)) return;
  showView(DEFAULT_VIEW, {}, { resetStack: true });
}

function openNativeLibraryRoute(options = {}) {
  let url = null;
  try {
    url = new URL(options.path || "/", activeUrl);
  } catch {
    return false;
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeRouteSegment);
  const first = segments[0] || "";
  const query = url.searchParams;
  const navigation = { resetStack: true };

  if (!first) {
    showView(DEFAULT_VIEW, {}, navigation);
    return true;
  }
  if (first === "favorites") {
    showView("works", {
      favorite: "1",
      ...(query.get("folder") ? { folder: query.get("folder") } : {})
    }, navigation);
    return true;
  }
  if (first === "vr") {
    workViews?.setWorkFilterMode("vr", { replace: true, rerender: false });
    showView("works", {}, navigation);
    return true;
  }
  if (first === "history" || first === "rankings" || first === "tools") {
    showView(first, {}, navigation);
    return true;
  }
  if (first === "people") {
    showView("people", { scope: query.get("scope") || "main" }, navigation);
    return true;
  }
  if (first === "categories" || first === "category") {
    showView("categories", { category: query.get("category") || segments[1] || "censored" }, navigation);
    return true;
  }
  if (first === "codes" || first === "code-prefixes") {
    const prefix = segments[1] || query.get("prefix") || query.get("codePrefix") || "";
    showView(prefix ? "codePrefixDetail" : "codePrefixes", prefix ? {
      prefix,
      family: query.get("family") || ""
    } : {}, navigation);
    return true;
  }
  if (first === "music") {
    showView("music", {
      mode: query.get("mode") || "library",
      dashboard: query.get("dashboard") || "",
      query: query.get("q") || query.get("query") || "",
      searchScope: query.get("searchScope") || query.get("scope") || "",
      sort: query.get("sort") || "",
      artistSort: query.get("artistSort") || "",
      favorite: query.get("favorite") || "",
      searchFavorite: query.get("searchFavorite") || "",
      searchLyrics: query.get("searchLyrics") || query.get("lyrics") || "",
      searchMinRating: query.get("searchMinRating") || query.get("minRating") || "",
      searchQuality: query.get("searchQuality") || query.get("quality") || "",
      genre: query.get("genre") || query.get("musicGenre") || "",
      language: query.get("language") || query.get("musicLanguage") || "",
      smartId: query.get("smart") || query.get("smartId") || "",
      artistId: query.get("artist") || query.get("artistId") || "",
      albumId: query.get("album") || query.get("albumId") || "",
      trackId: segments[1] || query.get("track") || query.get("trackId") || ""
    }, navigation);
    return true;
  }
  if (first === "photo" || first === "photos" || first === "photo-sets") {
    const section = segments[1] || "";
    if (section === "manga") {
      if (segments[2] && segments[3]) {
        showView("mangaChapter", { id: segments[2], chapterIndex: segments[3] }, navigation);
        return true;
      }
      if (segments[2]) {
        showView("mangaDetail", { id: segments[2] }, navigation);
        return true;
      }
      showView("channel", { mode: "manga" }, navigation);
      return true;
    }
    if (["set", "sets", "album", "albums", "photo-set"].includes(section) && segments[2]) {
      showView("photoDetail", { id: segments[2] }, navigation);
      return true;
    }
    if (section === "collection" && segments[2]) {
      showView("channel", { mode: "photo", photoView: "albums", collection: segments.slice(2).join("/") }, navigation);
      return true;
    }
    showView("channel", {
      mode: "photo",
      photoView: section === "albums" || query.get("photoView") === "albums" ? "albums" : "collections",
      sort: query.get("sort") || undefined,
      category: query.get("category") || undefined
    }, navigation);
    return true;
  }
  if (first === "manga") {
    if (segments[1] && segments[2]) {
      showView("mangaChapter", { id: segments[1], chapterIndex: segments[2] }, navigation);
      return true;
    }
    if (segments[1]) {
      showView("mangaDetail", { id: segments[1] }, navigation);
      return true;
    }
    showView("channel", { mode: "manga" }, navigation);
    return true;
  }
  if (first === "novels" || first === "novel") {
    if (segments[1] && segments[2]) {
      const anchor = {};
      for (const key of ["chapterId", "catalogRevision", "sourceRealm"]) {
        if (query.get(key)) anchor[key] = query.get(key);
      }
      // External links carry identity, never implicit review confirmation.
      showView("novelReader", { id: segments[1], chapterIndex: segments[2], ...anchor }, navigation);
      return true;
    }
    if (segments[1]) {
      showView("novelDetail", { id: segments[1] }, navigation);
      return true;
    }
    showView("novels", {}, navigation);
    return true;
  }
  if (first === "western" || first === "media" || first === "video" || first === "videos" || first === "movie" || first === "movies" || first === "tv" || first === "anime") {
    const mode = first === "media" && query.get("kind") === "anime" ? "anime" : first === "movies" ? "movie" : normalizeChannelMode(first);
    if (segments[1]) {
      showView("mediaDetail", { id: segments[1], mode }, navigation);
      return true;
    }
    if (mode === "western") showView("people", { scope: "western" }, navigation);
    else showView("channel", {
      mode: primaryChannelMode(mode), category: query.get("category") || undefined,
      query: query.get("q") || query.get("query") || undefined, sort: query.get("sort") || undefined,
      ...(["tv", "anime"].includes(mode) ? { tvView: query.get("tvView") || undefined, seriesKey: query.get("seriesKey") || undefined } : {})
    }, navigation);
    return true;
  }
  if (first === "short-videos" || first === "short-video" || first === "douyin") {
    showView("shortVideos", {
      query: query.get("q") || query.get("search") || "",
      author: query.get("author") || "all",
      source: query.get("source") || query.get("origin") || "liked",
      sort: query.get("sort") || "published",
      account: query.get("account") || "all"
    }, navigation);
    return true;
  }
  return false;
}

function decodeRouteSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function loadDashboard() {
  if (libraryLoadPromise) return libraryLoadPromise;
  const requestUrl = activeUrl;
  const previousLibrary = isLibrarySnapshot(library) ? library : null;
  const generation = ++libraryLoadGeneration;
  const isCurrent = () => generation === libraryLoadGeneration && requestUrl === activeUrl;
  libraryLoadError = null;
  setConnection("连接中", true);
  setStatus("正在连接电脑端");
  els.personPreview.innerHTML = `<div class="loading-row">正在读取资料库</div>`;
  loadImageLibrarySummary();
  loadNovelSummary();
  loadMusicSummary();
  loadShortVideoSummary();

  const request = (async () => {
    let cached = null;
    try {
      cached = await readCachedJson(requestUrl, LIBRARY_CACHE_PATH).catch(() => null);
      if (!isCurrent()) return false;
      if (!isLibrarySnapshot(cached?.payload)) cached = null;
      if (cached?.payload) {
        library = cached.payload;
        renderDashboard(library);
        workViews?.renderContinuePreview({ preferCache: true });
        const targetMode = connectionModeLabel(requestUrl);
        setConnection(`${targetMode} · 缓存`, false);
        setStatus(`已显示${targetMode}服务的本地缓存：${cacheAgeText(cached.updatedAt)}，正在连接电脑端。`);
        refreshLibraryDependentView();
      }
      const data = await fetchJson(requestUrl, LIBRARY_CACHE_PATH);
      if (!isCurrent()) return false;
      if (!isLibrarySnapshot(data)) throw new Error("地址已响应，但未返回有效资料库，请确认电脑端服务和端口。");
      library = data;
      writeCachedJson(requestUrl, LIBRARY_CACHE_PATH, library).catch(() => {});
      renderDashboard(library);
      workViews?.renderContinuePreview();
      setConnection(connectionModeLabel(requestUrl, library.access), true);
      setStatus("已连接");
      updateServiceHealth();
      refreshLibraryDependentView();
      updateCacheStatus();
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      libraryLoadError = error;
      if (isServerAuthenticationError(error)) {
        // Cached media stays on disk, but an explicit access denial is not an offline login.
        library = null;
        setConnection("需要登录", false);
        renderOffline();
        refreshLibraryDependentView();
        showAccountLogin(requestUrl, error);
        updateServiceHealth();
        updateCacheStatus();
        return false;
      }
      const targetMode = connectionModeLabel(requestUrl);
      setConnection(`${targetMode} · 离线`, false);
      if (cached?.payload || previousLibrary) {
        library = cached?.payload || previousLibrary;
        setStatus(cached?.payload
          ? `电脑端暂时连不上，继续显示本地缓存：${cacheAgeText(cached.updatedAt)}。`
          : "电脑端暂时连不上，继续显示已加载内容。", "error");
      } else {
        library = null;
        setStatus(`连接失败：${error.message}`, "error");
        renderOffline();
        refreshLibraryDependentView();
      }
      updateServiceHealth();
      updateCacheStatus();
      return false;
    }
  })().finally(() => {
    if (isCurrent()) {
      libraryLoadPromise = null;
      syncConnectionControls();
    }
  });
  libraryLoadPromise = request;
  syncConnectionControls();
  return request;
}

function isLibrarySnapshot(value) {
  return Boolean(value && Array.isArray(value.people) && value.totals && typeof value.totals === "object" && !Array.isArray(value.totals));
}

function currentViewNeedsLibrary() {
  return currentView === "home" || (currentView === "people" && currentViewParams.scope !== "western");
}

function refreshLibraryDependentView() {
  if (currentViewNeedsLibrary()) renderCurrentViewPreservingScroll();
}

function renderDashboard(data) {
  const totals = data.totals || {};
  const user = data.user || {};
  const people = data.people || [];

  els.statRoots.textContent = formatNumber(data.availableRoots?.length || 0);
  els.statPeople.textContent = formatNumber(totals.people);
  els.statVideos.textContent = formatCompact(totals.videos);
  els.statInfo.textContent = formatCompact(totals.infoFiles);
  renderUserState(user);
  els.peopleCount.textContent = formatNumber(totals.people);
  if (els.worksCount) els.worksCount.textContent = formatCompact(totals.works);
  if (els.rankingsCount) els.rankingsCount.textContent = "TOP";
  syncChannelCounts(imageLibrarySummary);
  syncNovelCounts();
  renderOmniSummary(imageLibrarySummary, { loading: !imageLibrarySummary });

  const previewPeople = people
    .filter((person) => person?.actorProfile?.gender !== "male")
    .sort(peopleViews.sortPeople)
    .slice(0, 10);
  peopleViews.renderPreviewPeople(previewPeople);
}

function renderUserState(user = {}) {
  if (library && user !== library.user) library.user = { ...(library.user || {}), ...user };
  if (Object.hasOwn(user, "historyCount") || Object.hasOwn(user, "history")) {
    els.historyCount.textContent = formatNumber(user.historyCount || user.history || 0);
  }
  if (els.favoriteCount && (Object.hasOwn(user, "favoriteCount") || Array.isArray(user.favorites))) {
    els.favoriteCount.textContent = formatNumber(user.favoriteCount || (Array.isArray(user.favorites) ? user.favorites.length : 0));
  }
}

function renderRecentContentPreview() {
  if (!els.recentContentSection || !els.recentContentPreview) return;
  const items = readRecentContent(12);
  els.recentContentPreview.dataset.hasItems = items.length ? "1" : "0";
  els.recentContentPreview.innerHTML = "";
  els.recentContentSection.hidden = currentView !== "home" || !items.length;
  if (!items.length) return;

  for (const item of items) {
    els.recentContentPreview.append(createRecentContentCard(item));
  }
}

function createRecentContentCard(item) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `recent-content-card ${item.type || ""}`;
  card.addEventListener("click", () => showView(item.view, item.params, { push: true }));

  const thumb = document.createElement("div");
  thumb.className = "recent-content-thumb";
  thumb.textContent = item.fallback || "?";
  if (item.coverUrl) {
    const cover = absoluteUrl(activeUrl, item.coverUrl);
    if (cover) loadPreviewImage(thumb, cover, { cacheBaseUrl: activeUrl });
  }

  const label = document.createElement("span");
  label.className = "recent-content-label";
  label.textContent = item.label || "内容";
  const title = document.createElement("strong");
  title.textContent = item.title || "未命名内容";
  const meta = document.createElement("span");
  meta.className = "recent-content-meta";
  meta.textContent = [item.subtitle, item.meta].filter(Boolean).join(" · ");

  card.append(thumb, label, title);
  if (meta.textContent) card.append(meta);
  return card;
}

function rememberRecentContent(item) {
  recordRecentContent(item);
  if (currentView === "home") renderRecentContentPreview();
}

function handleChannelFavoriteChange() {
  renderUserState(library?.user || {});
}

function showHome(options = {}) {
  invalidateViewRender();
  closeGalleryModePicker();
  closeReadingModePicker();
  document.body.classList.remove("novel-reader-view");
  document.body.classList.remove("novel-search-page-view");
  document.body.classList.remove("fanhao-search-page-view");
  currentView = "home";
  currentViewParams = {};
  dispatchAppViewChanged();
  searchSurfaceExpanded = false;
  viewStack = [];
  syncSearchSurface();
  els.quickStrip.hidden = false;
  els.continueSection.hidden = els.continuePreview.dataset.hasItems !== "1";
  renderRecentContentPreview();
  els.statusCard.hidden = false;
  if (els.omniSection) els.omniSection.hidden = false;
  if (els.libraryChannelStrip) els.libraryChannelStrip.hidden = false;
  els.previewSection.hidden = false;
  els.contentPanel.hidden = true;
  els.viewBack.hidden = true;
  setActiveBottom("home");
  finishAppStartup();
  rememberViewState("home", {});
  if (!options.skipHistory) replaceCurrentHistory();
  queueScrollRestore(options.restoreScrollY ?? 0);
}

function showSettings(options = {}) {
  if (!els.settingsOverlay) return;
  const accountGroup = els.settingsPanel?.querySelector(".settings-account-group");
  if (accountGroup && (els.settingsOverlay.hidden || options.section === "account")) accountGroup.open = options.section === "account";
  if (!els.settingsOverlay.hidden) return;
  els.settingsOverlay.hidden = false;
  document.body.classList.add("settings-open");
  refreshAccountSettings();
  els.profileSettingsButton?.setAttribute("aria-expanded", "true");
  updateStorageStatus();
  updateServiceHealth();
  renderAndroidUpdateState({ version: androidVersionInfo });
  if (!options.skipHistory && !window.history.state?.settingsOpen) {
    rememberCurrentScrollInHistory();
    window.history.pushState({
      ...routeHistoryState(currentView, currentViewParams),
      settingsOpen: true
    }, "", viewRouteHash(currentView, currentViewParams));
  }
  window.requestAnimationFrame(() => {
    const target = options.section === "storage" ? els.settingsPanel?.querySelector(".storage-settings-group")
      : options.section === "account" ? els.settingsPanel?.querySelector(".settings-account-group") : null;
    if (target) {
      target.scrollIntoView({ block: "start" });
      if (els.settingsPanel) els.settingsPanel.scrollTop = Math.max(0, els.settingsPanel.scrollTop - 66);
      const heading = target.querySelector(".settings-group-title");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
      return;
    }
    els.settingsCloseButton?.focus({ preventScroll: true });
  });
}

function hideSettingsSurface() {
  if (!els.settingsOverlay || els.settingsOverlay.hidden) return;
  els.settingsOverlay.hidden = true;
  document.body.classList.remove("settings-open");
  els.profileSettingsButton?.setAttribute("aria-expanded", "false");
}

function closeSettings(options = {}) {
  if (!els.settingsOverlay || els.settingsOverlay.hidden) return;
  const shouldRestoreHistory = !options.skipHistory && Boolean(window.history.state?.settingsOpen);
  // Hide immediately so Android Back and the close button never leave the
  // settings sheet visible while WebView history dispatches asynchronously.
  hideSettingsSurface();
  if (shouldRestoreHistory) {
    window.history.back();
  }
}

function showView(view, params = {}, navigation = {}) {
  if (view === "channel" && normalizeChannelMode(params.mode) === "western") {
    view = "people";
    params = { scope: "western" };
  }
  const nextParams = sanitizeViewParams(view, params);
  const preserveShortVideoHome = shouldPreserveShortVideoHome(view, nextParams);
  const shouldWriteHistory = !navigation.skipHistory;
  if (shouldWriteHistory) rememberCurrentScrollInHistory();
  if (navigation.resetStack) viewStack = [];
  if (navigation.push && currentView) {
    const channelRange = captureChannelRange();
    viewStack.push({ view: currentView, params: currentViewParams, scrollY: currentScrollY(), ...(channelRange ? { channelRange } : {}) });
  }
  currentView = view;
  currentViewParams = nextParams;
  rememberHomeMode(currentView, currentViewParams);
  rememberGalleryMode(currentView, currentViewParams);
  rememberReadingMode(currentView);
  closeHomeModePicker();
  closeGalleryModePicker();
  closeReadingModePicker();
  searchSurfaceExpanded = view === "search" || (view === "channel" && Boolean(currentViewParams.query));
  resetViewLimitsForView(view);
  restoreChannelRange(navigation.channelRange, view, currentViewParams);
  rememberViewState(currentView, currentViewParams);
  if (shouldWriteHistory) pushViewHistory(view, currentViewParams, navigation.restoreScrollY ?? 0);
  else if (navigation.replaceHistory) replaceCurrentHistory();
  renderCurrentView({
    preserveShortVideoHome,
    restoreScrollY: navigation.restoreScrollY ?? 0
  });
  queueScrollRestore(navigation.restoreScrollY ?? 0);
}

function shouldPreserveShortVideoHome(nextView, nextParams) {
  if (currentView !== "shortVideos" || nextView !== "shortVideos") return false;
  if (!els.viewContent?.querySelector(".short-video-mobile-list")) return false;
  return JSON.stringify(sanitizeViewParams("shortVideos", currentViewParams)) !== JSON.stringify(nextParams || {});
}

function replaceViewParams(view, params = {}, navigation = {}) {
  if (view !== currentView) return false;
  currentViewParams = sanitizeViewParams(view, params);
  rememberViewState(currentView, currentViewParams);
  if (navigation.replaceHistory !== false) replaceCurrentHistory();
  return true;
}

function defaultWorksLimitForView(view) {
  const fast = isFastServerUrl();
  if (view === "rankings") return 120;
  if (view === "works" || view === "categories" || view === "codePrefixDetail" || view === "studioDetail") return fast ? FAST_WORK_LIMIT : 60;
  if (view === "search" || view === "personDetail") return fast ? FAST_WORK_LIMIT : 48;
  if (view === "history") return fast ? FAST_WORK_LIMIT : 48;
  return fast ? FAST_WORK_LIMIT : 40;
}

function defaultChannelLimitForView(view, params = currentViewParams) {
  const fast = isFastServerUrl();
  if (isPhotoChannelView(view, params)) return fast ? FAST_PHOTO_CHANNEL_LIMIT : PHOTO_CHANNEL_LIMIT;
  if (view === "channel") return fast ? FAST_CHANNEL_LIMIT : 36;
  if (view === "mangaDetail") return fast ? 120 : 32;
  return fast ? 160 : 40;
}

function isPhotoChannelView(view = currentView, params = currentViewParams) {
  return view === "channel" && normalizeChannelMode(params?.mode) === "photo";
}

function defaultPhotoImageLimitForView(view) {
  if (view !== "photoDetail") return 12;
  return isFastServerUrl() ? FAST_PHOTO_IMAGE_LIMIT : 18;
}

function defaultMangaImageLimitForView(view) {
  if (view !== "mangaChapter") return 8;
  return isFastServerUrl() ? FAST_MANGA_IMAGE_LIMIT : 12;
}

function goBack() {
  if (mediaViewer?.close()) return;
  if (androidModuleRegistry?.handleBack(currentView, currentViewParams)) return;
  if (currentView === "mangaChapter" && currentViewParams.id) {
    const previous = viewStack.at(-1);
    if (previous?.view === "mangaDetail" && String(previous.params?.id || "") === String(currentViewParams.id)) {
      returnToStackView();
      return;
    }
    showView("mangaDetail", { id: currentViewParams.id }, {
      skipHistory: true,
      replaceHistory: true,
      resetStack: true,
      restoreScrollY: 0
    });
    return;
  }
  if (currentView === "mangaDetail") {
    const previous = viewStack.at(-1);
    if (previous?.view === "channel" && normalizeChannelMode(previous.params?.mode) === "manga") {
      returnToStackView();
      return;
    }
    showView("channel", { mode: "manga" }, {
      skipHistory: true,
      replaceHistory: true,
      resetStack: true,
      restoreScrollY: 0
    });
    return;
  }
  if (returnToStackView()) return;
  if (!isRootNavigationView() && currentView !== "home" && window.history.state?.marker === HISTORY_MARKER && window.history.length > 1) {
    window.history.back();
    return;
  }
  applyBackState();
}

function returnToStackView(options = {}) {
  const previous = viewStack.pop();
  if (!previous) return false;
  if (options.discardHistoryEntry && window.history.state?.marker === HISTORY_MARKER && window.history.length > 1) {
    window.history.back();
    return true;
  }
  if (previous.view === "home") {
    showView(DEFAULT_VIEW, {}, { skipHistory: true, replaceHistory: true, restoreScrollY: previous.scrollY ?? 0 });
    return true;
  }
  showView(previous.view, previous.params, { skipHistory: true, replaceHistory: true, restoreScrollY: previous.scrollY ?? 0, channelRange: previous.channelRange });
  return true;
}

function discardPushedView() {
  return returnToStackView({ discardHistoryEntry: true });
}

function applyBackState() {
  if (returnToStackView()) return;
  showView(DEFAULT_VIEW, {}, { skipHistory: true, replaceHistory: true, restoreScrollY: 0 });
}

function routeHistoryState(view, params = {}, scrollY = currentScrollY()) {
  const channelRange = captureChannelRange(view, params);
  return {
    marker: HISTORY_MARKER,
    view,
    params: sanitizeViewParams(view, params || {}),
    scrollY: Math.max(0, Math.round(Number(scrollY) || 0)),
    ...(channelRange ? { channelRange } : {})
  };
}

function rememberCurrentScrollInHistory() {
  if (window.history.state?.marker !== HISTORY_MARKER) return;
  const state = {
    ...window.history.state,
    scrollY: currentScrollY()
  };
  const view = state.view === "settings" || RESTORABLE_VIEWS.has(state.view) ? state.view : currentView;
  const params = sanitizeViewParams(view, state.params || {});
  const channelRange = captureChannelRange(view, params);
  delete state.channelRange;
  if (channelRange) state.channelRange = channelRange;
  window.history.replaceState({ ...state, view, params }, "", viewRouteHash(view, params));
}

function pushViewHistory(view, params = {}, scrollY = 0) {
  window.history.pushState(routeHistoryState(view, params, scrollY), "", viewRouteHash(view, params));
}

function replaceCurrentHistory() {
  window.history.replaceState(routeHistoryState(currentView, currentViewParams), "", viewRouteHash(currentView, currentViewParams));
}

function restoreFromHistoryState(historyState) {
  if (mediaViewer?.close()) return;
  const hashState = !historyState || historyState.marker !== HISTORY_MARKER ? readViewStateFromHash() : null;
  const legacySettingsRoute = hashState?.view === "settings" || historyState?.view === "settings";
  if (historyState?.settingsOpen || legacySettingsRoute) {
    const settingsBaseView = legacySettingsRoute
      ? "tools"
      : (RESTORABLE_VIEWS.has(historyState?.view) ? historyState.view : "tools");
    const settingsBaseParams = legacySettingsRoute ? {} : sanitizeViewParams(settingsBaseView, historyState?.params || {});
    if (currentView !== settingsBaseView || !sameViewParams(currentViewParams, settingsBaseParams)) {
      showView(settingsBaseView, settingsBaseParams, { skipHistory: true, channelRange: historyState?.channelRange });
    }
    showSettings({ skipHistory: true });
    return;
  }
  hideSettingsSurface();
  if ((!historyState || historyState.marker !== HISTORY_MARKER) && !hashState) {
    showView(DEFAULT_VIEW, {}, { skipHistory: true });
    return;
  }

  const view = hashState?.view || (historyState.view === "settings" || RESTORABLE_VIEWS.has(historyState.view) ? historyState.view : DEFAULT_VIEW);
  const params = hashState?.params || sanitizeViewParams(view, historyState.params || {});
  const restoreScrollY = Number(hashState ? 0 : historyState.scrollY || 0);
  viewStack = [];

  if (view === "home") {
    showView(DEFAULT_VIEW, {}, { skipHistory: true, restoreScrollY });
    return;
  }
  showView(view, params, { skipHistory: true, restoreScrollY, channelRange: hashState ? "" : historyState.channelRange });
}

function renderCurrentView(options = {}) {
  const restoreScrollY = Number.isFinite(Number(options.restoreScrollY)) ? Math.max(0, Math.round(Number(options.restoreScrollY))) : null;
  const restoreIntent = scrollRestoreIntent;
  const preserveShortVideoHome = Boolean(
    options.preserveShortVideoHome
    && currentView === "shortVideos"
    && els.viewContent?.querySelector(".short-video-mobile-list")
  );
  const restoreAfterRender = (task, renderGuard) => {
    if (restoreScrollY === null || restoreScrollY === 0) return task;
    const restore = () => {
      // An old request must not acquire the new page's token, or re-arm a
      // restoration that the user canceled by interacting while it loaded.
      if (renderGuard() && restoreIntent === scrollRestoreIntent) queueScrollRestore(restoreScrollY);
    };
    void Promise.resolve(task).then(restore, restore);
    return task;
  };
  // Readers must snapshot their old layout before route classes or content change.
  window.dispatchEvent(new CustomEvent("fanhaoViewWillRender", {
    detail: { view: currentView, params: currentViewParams }
  }));
  androidModuleRegistry?.deactivateExcept(currentView, currentViewParams);

  if (currentView === "home") {
    return showHome({ restoreScrollY: restoreScrollY ?? 0 });
  }
  els.statusCard.hidden = true;
  if (els.omniSection) els.omniSection.hidden = true;
  if (els.libraryChannelStrip) els.libraryChannelStrip.hidden = true;
  els.previewSection.hidden = true;
  els.continueSection.hidden = true;
  if (els.recentContentSection) els.recentContentSection.hidden = true;
  els.quickStrip.hidden = true;
  els.contentPanel.hidden = false;
  syncContentPanelMode();
  els.viewBack.hidden = isRootNavigationView(currentView);
  if (!preserveShortVideoHome) {
    els.viewContent.innerHTML = "";
    els.viewContent.className = "content-list";
  }
  syncSearchSurface();
  if (!preserveShortVideoHome) renderRouteLoadingState();
  setActiveBottom();
  const renderGuard = beginViewRender(currentView, currentViewParams);
  finishAppStartup();
  if (!library && currentViewNeedsLibrary()) {
    renderLibraryAvailability();
    return;
  }
  return restoreAfterRender(androidModuleRegistry?.render(currentView, currentViewParams, renderGuard), renderGuard);
}

function renderLibraryAvailability() {
  if (!libraryLoadError) return;
  const authenticationFailed = isServerAuthenticationError(libraryLoadError);
  els.viewMeta.textContent = authenticationFailed ? "需要登录" : "连接暂不可用";
  const panel = document.createElement("section");
  panel.className = "library-connection-state";
  panel.setAttribute("role", "status");
  const title = document.createElement("strong");
  title.textContent = authenticationFailed ? "请登录用户账号" : "暂时连不上电脑端";
  const message = document.createElement("p");
  message.textContent = authenticationFailed ? accountLoginMessage(libraryLoadError) : "可以重新连接，或先使用下方导航中的其他功能。";
  const actions = document.createElement("div");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重新连接";
  retry.addEventListener("click", () => {
    void loadDashboard();
    renderCurrentView();
  });
  const settings = document.createElement("button");
  settings.type = "button";
  settings.textContent = authenticationFailed ? "打开用户中心" : "检查地址";
  settings.addEventListener("click", () => authenticationFailed ? showAccountLogin(activeUrl, libraryLoadError) : showSettings());
  actions.append(retry, settings);
  panel.append(title, message, actions);
  els.viewContent.replaceChildren(panel);
}

function finishAppStartup() {
  if (els.appStartup) els.appStartup.hidden = true;
  if (els.appShell) els.appShell.hidden = false;
  document.body.classList.remove("app-starting");
}

function renderCurrentViewPreservingScroll() {
  return renderCurrentView({ restoreScrollY: currentScrollY() });
}

function renderRouteLoadingState() {
  const copy = routeLoadingCopy(currentView, currentViewParams);
  els.viewKicker.textContent = copy.kicker;
  els.viewTitle.textContent = copy.title;
  els.viewMeta.textContent = copy.meta;
  els.viewContent.replaceChildren(createLoadingRow(copy.message));
}

function createLoadingRow(message) {
  const row = document.createElement("div");
  row.className = "loading-row route-loading";
  const label = document.createElement("span");
  label.textContent = message;
  row.append(label);
  return row;
}

function routeLoadingCopy(view = currentView, params = currentViewParams) {
  if (view === "channel") {
    const mode = normalizeChannelMode(params.mode);
    const label = channelViews?.channelLabel(mode) || { photo: "套图", manga: "漫画书库", western: "欧美", media: "影视", movie: "电影", tv: "电视剧", anime: "动漫" }[mode] || "频道";
    return {
      kicker: params.query ? "频道搜索" : "内容频道",
      title: params.query ? `${label}：${params.query}` : label,
      meta: params.query ? "正在筛选" : "正在读取",
      message: `正在打开${label}`
    };
  }

  if (view === "mediaDetail") {
    const label = channelViews?.channelLabel(params.mode) || "媒体";
    return { kicker: label, title: "媒体详情", meta: "正在读取", message: `正在读取${label}详情` };
  }

  if (view === "photoDetail") return { kicker: "套图", title: "套图详情", meta: "正在读取", message: "正在读取套图" };
  if (view === "mangaDetail") return { kicker: "韩漫", title: "漫画详情", meta: "正在读取", message: "正在读取漫画" };
  if (view === "mangaChapter") return { kicker: "韩漫阅读", title: "章节", meta: "正在读取", message: "正在读取章节" };
  if (view === "personDetail") return { kicker: "演员", title: "演员详情", meta: "正在读取", message: "正在加载演员资料" };
  if (view === "workDetail") return { kicker: "作品详情", title: "作品详情", meta: "正在读取", message: "正在加载作品详情" };
  if (view === "novelDetail") return { kicker: "小说", title: "书籍详情", meta: "正在读取", message: "正在读取书籍详情" };
  if (view === "novelSearch") return { kicker: "小说", title: "搜索", meta: "", message: "正在打开小说搜索" };
  if (view === "novelReader") return { kicker: "小说阅读", title: "章节", meta: "正在读取", message: "正在翻开章节" };
  if (view === "music") return { kicker: "本地音乐", title: "音乐", meta: "正在读取", message: "正在读取音乐库" };
  if (view === "shortVideoSearch") return { kicker: "短视频", title: "搜索", meta: "", message: "正在打开搜索" };
  if (view === "rankings") return { kicker: "榜单", title: "排行榜", meta: "正在加载", message: "正在加载排行榜" };
  if (view === "categories") return { kicker: "分类", title: "番号分类", meta: "正在加载", message: "正在加载分类作品" };
  if (view === "codePrefixes") return { kicker: "番号", title: "番号前缀", meta: "正在整理", message: "正在整理番号索引" };
  if (view === "codePrefixDetail") return { kicker: "番号前缀", title: params.prefix || "番号作品", meta: "正在加载", message: "正在加载番号作品" };
  if (view === "studios") return { kicker: "片商", title: "片商索引", meta: "正在加载", message: "正在加载片商" };
  if (view === "studioDetail") return { kicker: "片商", title: "片商作品", meta: "正在加载", message: "正在加载片商作品" };
  if (view === "history") return { kicker: "继续观看", title: "观看进度", meta: "正在读取", message: "正在加载观看进度" };
  if (view === "search") return { kicker: "搜索", title: params.query ? `搜索：${params.query}` : "全库搜索", meta: "正在搜索", message: "正在搜索" };
  if (view === "people") {
    const title = params.scope === "western" ? "欧美人物" : "番号人物";
    return { kicker: "人物索引", title, meta: "正在整理", message: `正在打开${title}` };
  }
  if (view === "novels") return { kicker: "小说", title: "书库", meta: "正在读取", message: "正在读取书库" };
  if (view === "shortVideos") return { kicker: "短视频", title: "短视频", meta: "正在读取", message: "正在读取短视频" };
  if (view === "tools") return { kicker: "个人中心", title: "我的", meta: "正在准备", message: "正在准备我的页面" };
  return { kicker: "作品", title: "片库", meta: "正在加载", message: "正在加载作品" };
}

function syncContentPanelMode() {
  if (!els.contentPanel) return;
  els.contentPanel.dataset.view = currentView;
  els.contentPanel.dataset.feedView = FEED_VIEWS.has(currentView) ? "true" : "false";
  els.contentPanel.dataset.channelMode = currentView === "channel" ? normalizeChannelMode(currentViewParams.mode) : "";
  document.body.classList.toggle("novel-library-view", isNovelNavigationView(currentView) && currentView !== "novelReader");
  document.body.classList.toggle("novel-reader-view", currentView === "novelReader");
  document.body.classList.toggle("novel-search-page-view", currentView === "novelSearch");
  document.body.classList.toggle("music-mobile-view", currentView === "music");
  document.body.classList.toggle("short-video-mobile-view", currentView === "shortVideos");
  document.body.classList.toggle("short-video-search-page-view", currentView === "shortVideoSearch");
  document.body.classList.toggle("fanhao-search-page-view", currentView === "search");
  document.body.classList.toggle("fanhao-person-detail-view", currentView === "personDetail");
  document.body.classList.toggle("fanhao-work-detail-view", currentView === "workDetail");
  document.body.classList.toggle("photo-detail-view", currentView === "photoDetail");
  document.body.classList.toggle("manga-detail-view", currentView === "mangaDetail");
  document.body.classList.toggle("manga-reader-view", currentView === "mangaChapter");
  dispatchAppViewChanged();
}

function dispatchAppViewChanged() {
  window.dispatchEvent(new CustomEvent("fanhaoViewChanged", {
    detail: { view: currentView, params: currentViewParams }
  }));
}

function renderOffline() {
  els.statRoots.textContent = "-";
  els.statPeople.textContent = "-";
  els.statVideos.textContent = "-";
  els.statInfo.textContent = "-";
  els.historyCount.textContent = "0";
  els.peopleCount.textContent = "0";
  if (els.worksCount) els.worksCount.textContent = "0";
  if (els.rankingsCount) els.rankingsCount.textContent = "TOP";
  syncChannelCounts(imageLibrarySummary);
  syncNovelCounts();
  syncMusicCounts();
  syncShortVideoCounts();
  els.continueSection.hidden = true;
  els.continuePreview.dataset.hasItems = "0";
  els.continuePreview.innerHTML = "";
  renderRecentContentPreview();
  els.personPreview.innerHTML = `<div class="loading-row">电脑端服务未连接，可检查地址或 29998 服务。</div>`;
}

function toggleSettings(force) {
  const shouldShow = typeof force === "boolean" ? force : Boolean(els.settingsOverlay?.hidden);
  if (shouldShow) showSettings();
  else closeSettings();
}

function showPrimaryView(view, navigation = {}) {
  showView(view, {}, navigation);
}

function primaryChannelMode(mode) {
  const normalized = normalizeChannelMode(mode);
  return normalized === "media" ? "movie" : normalized;
}

function requestAppConfirmation(options = {}) {
  if (!els.appConfirmOverlay) return Promise.resolve(false);
  if (pendingAppConfirmation) settleAppConfirmation(false);
  const danger = options.danger === true;
  const title = options.title || "确认操作";
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  els.appConfirmOverlay.dataset.tone = danger ? "danger" : "standard";
  if (els.appConfirmSheet) els.appConfirmSheet.setAttribute("role", danger ? "alertdialog" : "dialog");
  if (els.appConfirmMark) els.appConfirmMark.textContent = danger ? "!" : "i";
  if (els.appConfirmBackdrop) els.appConfirmBackdrop.setAttribute("aria-label", `取消${title}`);
  if (els.appConfirmTitle) els.appConfirmTitle.textContent = title;
  if (els.appConfirmMessage) els.appConfirmMessage.textContent = options.message || "确认继续吗？";
  if (els.appConfirmAcceptButton) {
    els.appConfirmAcceptButton.textContent = options.confirmLabel || "确认";
    els.appConfirmAcceptButton.classList.toggle("danger", danger);
    els.appConfirmAcceptButton.classList.toggle("primary", !danger);
  }
  const backgroundState = suspendAppConfirmationBackground();
  document.body.classList.add("app-confirm-open");
  els.appConfirmOverlay.hidden = false;
  return new Promise((resolve) => {
    pendingAppConfirmation = { resolve, previousFocus, backgroundState };
    window.requestAnimationFrame(() => els.appConfirmCancelButton?.focus({ preventScroll: true }));
  });
}

function settleAppConfirmation(accepted) {
  if (!pendingAppConfirmation) return;
  const state = pendingAppConfirmation;
  pendingAppConfirmation = null;
  if (els.appConfirmOverlay) els.appConfirmOverlay.hidden = true;
  document.body.classList.remove("app-confirm-open");
  restoreAppConfirmationBackground(state.backgroundState);
  state.resolve(Boolean(accepted));
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (!pendingAppConfirmation && state.previousFocus?.isConnected) {
      state.previousFocus.focus?.({ preventScroll: true });
    }
  }));
}

function suspendAppConfirmationBackground() {
  const overlay = els.appConfirmOverlay;
  const parent = overlay?.parentElement;
  if (!overlay || !parent) return [];
  return [...parent.children]
    .filter((element) => element !== overlay)
    .map((element) => {
      const state = { element, inert: Boolean(element.inert) };
      element.inert = true;
      return state;
    });
}

function restoreAppConfirmationBackground(states = []) {
  for (const state of states) {
    if (state?.element?.isConnected) state.element.inert = Boolean(state.inert);
  }
}

function trapAppConfirmationFocus(event) {
  if (event.key !== "Tab" || els.appConfirmOverlay?.hidden) return;
  const controls = [els.appConfirmCancelButton, els.appConfirmAcceptButton]
    .filter((button) => button && !button.disabled);
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const first = controls[0];
  const last = controls.at(-1);
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !els.appConfirmSheet?.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !els.appConfirmSheet?.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function homeModeForView(view = currentView, params = currentViewParams) {
  if (view === "people" || view === "personDetail") {
    return String(params?.scope || "main").toLowerCase() === "western" ? "western" : "fanhao";
  }
  if (view === "categories") return String(params?.category || "censored").toLowerCase() === "western" ? "western" : "fanhao";
  return view === "home" || view === "rankings" ? "fanhao" : "";
}

function preferredHomeMode() {
  const current = homeModeForView();
  if (current) return current;
  const stored = String(localStorage.getItem(HOME_MODE_STORAGE_KEY) || "").trim();
  return HOME_MODES.has(stored) ? stored : "fanhao";
}

function alternateHomeMode(mode = preferredHomeMode()) {
  return mode === "western" ? "fanhao" : "western";
}

function rememberHomeMode(view = currentView, params = currentViewParams) {
  const mode = homeModeForView(view, params);
  if (mode) localStorage.setItem(HOME_MODE_STORAGE_KEY, mode);
  return mode;
}

function navigateToHomeMode(mode, navigation = {}) {
  const normalized = HOME_MODES.has(mode) ? mode : preferredHomeMode();
  localStorage.setItem(HOME_MODE_STORAGE_KEY, normalized);
  closeHomeModePicker();
  closeGalleryModePicker();
  closeReadingModePicker();
  showView("people", { scope: normalized === "western" ? "western" : "main" }, { resetStack: true, ...navigation });
  scrollToTopInstant();
}

function galleryModeForView(view = currentView, params = currentViewParams) {
  if (view === "channel") {
    const mode = normalizeChannelMode(params?.mode);
    if (mode === "media") return "movie";
    return GALLERY_MODES.has(mode) ? mode : "";
  }
  if (view === "photoDetail") return "photo";
  if (view === "mangaDetail" || view === "mangaChapter") return "manga";
  if (view === "mediaDetail") {
    const mode = normalizeChannelMode(params?.mode);
    if (mode === "western") return "";
    return mode === "tv" || mode === "anime" ? mode : "movie";
  }
  return "";
}

function preferredGalleryMode() {
  const current = galleryModeForView();
  if (current) return current;
  const stored = String(localStorage.getItem(GALLERY_MODE_STORAGE_KEY) || "").trim();
  return GALLERY_MODES.has(stored) ? stored : "photo";
}

function alternateGalleryMode(mode = preferredGalleryMode()) {
  const index = GALLERY_MODE_OPTIONS.findIndex((option) => option.mode === mode);
  return GALLERY_MODE_OPTIONS[(index + 1) % GALLERY_MODE_OPTIONS.length].mode;
}

function galleryModeLabel(mode = preferredGalleryMode()) {
  return (GALLERY_MODE_OPTIONS.find((option) => option.mode === mode) || GALLERY_MODE_OPTIONS[0]).label;
}

function rememberGalleryMode(view = currentView, params = currentViewParams) {
  const mode = galleryModeForView(view, params);
  if (mode) localStorage.setItem(GALLERY_MODE_STORAGE_KEY, mode);
  return mode;
}

function galleryNavigationParams(mode = preferredGalleryMode()) {
  const normalized = GALLERY_MODES.has(mode) ? mode : "photo";
  return normalized === "photo" ? { mode: "photo", photoView: "collections" } : { mode: normalized };
}

function navigateToGalleryMode(mode, navigation = {}) {
  const normalized = GALLERY_MODES.has(mode) ? mode : preferredGalleryMode();
  localStorage.setItem(GALLERY_MODE_STORAGE_KEY, normalized);
  closeGalleryModePicker();
  closeReadingModePicker();
  showView("channel", galleryNavigationParams(normalized), { resetStack: true, ...navigation });
  scrollToTopInstant();
}

function readingModeForView(view = currentView) {
  if (isNovelNavigationView(view)) return "novels";
  return view === "music" ? "music" : "";
}

function preferredReadingMode() {
  const current = readingModeForView();
  if (current) return current;
  const stored = String(localStorage.getItem(READING_MODE_STORAGE_KEY) || "").trim();
  return READING_MODES.has(stored) ? stored : "novels";
}

function alternateReadingMode(mode = preferredReadingMode()) {
  return mode === "music" ? "novels" : "music";
}

function rememberReadingMode(view = currentView) {
  const mode = readingModeForView(view);
  if (mode) localStorage.setItem(READING_MODE_STORAGE_KEY, mode);
  return mode;
}

function navigateToReadingMode(mode, navigation = {}) {
  const normalized = READING_MODES.has(mode) ? mode : preferredReadingMode();
  localStorage.setItem(READING_MODE_STORAGE_KEY, normalized);
  closeHomeModePicker();
  closeGalleryModePicker();
  closeReadingModePicker();
  showView(normalized === "music" ? "music" : "novels", {}, { resetStack: true, ...navigation });
  scrollToTopInstant();
}

function isRootNavigationView(view = currentView, params = currentViewParams) {
  if (view === "home") return true;
  const module = androidModuleRegistry?.resolve(view, params)?.module;
  return Boolean(module?.rootViews.has(view) && (!module.isRootView || module.isRootView(view, params)));
}

function isNovelNavigationView(view = currentView) {
  return view === "novels" || view === "novelSearch" || view === "novelDetail" || view === "novelReader";
}

function syncModuleChrome() {
  if (!els.moduleChrome) return false;
  els.moduleChrome.replaceChildren();
  delete els.moduleChrome.dataset.module;
  const rendered = Boolean(androidModuleRegistry?.renderChrome(currentView, currentViewParams, els.moduleChrome));
  const visible = rendered && els.moduleChrome.childElementCount > 0;
  els.moduleChrome.hidden = !visible;
  return visible;
}

function bottomNavKeyFor(name = currentView, params = currentViewParams) {
  const view = String(name || currentView || "").trim();
  if (view === "mediaDetail" && normalizeChannelMode(params?.mode) === "western") return "fanhao";
  const directKeys = {
    home: "fanhao",
    fanhao: "fanhao",
    works: "fanhao",
    categories: "fanhao",
    people: "fanhao",
    rankings: "fanhao",
    history: "fanhao",
    photo: "photo",
    manga: "photo",
    shortVideos: "shortVideos",
    novels: "novels",
    tools: "tools",
    media: "photo",
    movie: "photo",
    tv: "photo",
    anime: "photo",
    western: "fanhao",
    music: "novels"
  };
  if (directKeys[view]) return directKeys[view];
  const resolvedKey = androidModuleRegistry?.resolve(view, params)?.module.bottomKey || "";
  if (resolvedKey === "media") return "photo";
  if (resolvedKey === "music") return "novels";
  return resolvedKey;
}

function setActiveBottom(name = currentView) {
  const activeKey = bottomNavKeyFor(name);
  for (const button of els.bottomNav) {
    const key = button.dataset.bottomKey
      || (button.dataset.fanhaoHome !== undefined ? "fanhao" : "")
      || (button.dataset.openChannel ? normalizeChannelMode(button.dataset.openChannel) : "");
    const active = Boolean(key && key === activeKey);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  syncHomeModeNavigation();
  syncGalleryModeNavigation();
  syncReadingModeNavigation();
  if (els.moduleModeSwitch) syncModuleModeSwitch(activeKey);
  if (els.profileSettingsButton) {
    const profileActive = currentView === "tools";
    els.profileSettingsButton.hidden = !profileActive;
    els.profileSettingsButton.setAttribute("aria-expanded", profileActive && !els.settingsOverlay?.hidden ? "true" : "false");
  }
}

function syncModuleModeSwitch(activeKey = bottomNavKeyFor()) {
  const options = activeKey === "fanhao" ? [{ mode: "fanhao", label: "番号" }, { mode: "western", label: "欧美" }]
    : activeKey === "photo" ? GALLERY_MODE_OPTIONS
    : activeKey === "novels" ? [{ mode: "novels", label: "小说" }, { mode: "music", label: "音乐" }] : [];
  const visible = options.length > 0 && isRootNavigationView();
  els.moduleModeSwitch.hidden = !visible;
  if (!visible) return;
  const selected = activeKey === "fanhao" ? preferredHomeMode() : activeKey === "photo" ? preferredGalleryMode() : preferredReadingMode();
  els.moduleModeSelect.replaceChildren(...options.map(({ mode, label }) => {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = label;
    option.selected = mode === selected;
    return option;
  }));
  els.moduleModeSelect.dataset.group = activeKey;
}

function homeNavigationButton() {
  return els.bottomNavBar?.querySelector("button[data-home-switcher]") || null;
}

function ensureHomeModePicker() {
  if (!els.bottomNavBar) return null;
  let picker = els.bottomNavBar.querySelector(".bottom-nav-home-picker");
  if (picker) return picker;

  picker = document.createElement("div");
  picker.className = "bottom-nav-home-picker";
  picker.hidden = true;
  picker.setAttribute("role", "menu");
  picker.setAttribute("aria-label", "选择首页类型");

  const title = document.createElement("strong");
  title.className = "bottom-nav-home-picker-title";
  title.textContent = "打开首页";
  picker.append(title);

  for (const option of [
    { mode: "fanhao", label: "番号", meta: "番号作品库", glyph: "番" },
    { mode: "western", label: "欧美", meta: "欧美作品库", glyph: "欧" }
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bottom-nav-home-choice";
    button.dataset.homeModeChoice = option.mode;
    button.setAttribute("role", "menuitemradio");

    const icon = document.createElement("span");
    icon.className = "bottom-nav-home-choice-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = option.glyph;

    const copy = document.createElement("span");
    copy.className = "bottom-nav-home-choice-copy";
    const label = document.createElement("strong");
    label.textContent = option.label;
    const meta = document.createElement("small");
    meta.textContent = option.meta;
    copy.append(label, meta);

    const check = document.createElement("span");
    check.className = "bottom-nav-home-choice-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    button.append(icon, copy, check);
    picker.append(button);
  }

  els.bottomNavBar.append(picker);
  return picker;
}

function syncHomeModeNavigation() {
  const mode = preferredHomeMode();
  const homeButton = homeNavigationButton();
  if (homeButton) {
    homeButton.dataset.homeModeCurrent = mode;
    const label = homeButton.querySelector(".bottom-nav-label");
    if (label) label.textContent = mode === "western" ? "欧美" : "番号";
    homeButton.setAttribute("aria-label", `首页，当前${mode === "western" ? "欧美" : "番号"}，点击回到当前分类，长按选择`);
  }
  const picker = els.bottomNavBar?.querySelector(".bottom-nav-home-picker");
  if (!picker) return;
  for (const choice of picker.querySelectorAll("[data-home-mode-choice]")) {
    const active = choice.dataset.homeModeChoice === mode;
    choice.classList.toggle("active", active);
    choice.setAttribute("aria-checked", String(active));
  }
}

function openHomeModePicker() {
  const picker = ensureHomeModePicker();
  const homeButton = homeNavigationButton();
  if (!picker || !homeButton) return;
  closeGalleryModePicker();
  closeReadingModePicker();
  syncHomeModeNavigation();
  picker.hidden = false;
  homeButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("home-mode-picker-open");
}

function closeHomeModePicker() {
  const picker = els.bottomNavBar?.querySelector(".bottom-nav-home-picker");
  if (picker) picker.hidden = true;
  homeNavigationButton()?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("home-mode-picker-open");
}

function galleryNavigationButton() {
  return els.bottomNavBar?.querySelector("button[data-gallery-switcher]") || null;
}

function ensureGalleryModePicker() {
  if (!els.bottomNavBar) return null;
  let picker = els.bottomNavBar.querySelector(".bottom-nav-gallery-picker");
  if (picker) return picker;

  picker = document.createElement("div");
  picker.className = "bottom-nav-gallery-picker";
  picker.hidden = true;
  picker.setAttribute("role", "menu");
  picker.setAttribute("aria-label", "选择图库或影视");

  const title = document.createElement("strong");
  title.className = "bottom-nav-gallery-picker-title";
  title.textContent = "打开图库与影视";
  picker.append(title);

  for (const option of GALLERY_MODE_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bottom-nav-gallery-choice";
    button.dataset.galleryModeChoice = option.mode;
    button.setAttribute("role", "menuitemradio");

    const icon = document.createElement("span");
    icon.className = "bottom-nav-gallery-choice-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = option.glyph;

    const copy = document.createElement("span");
    copy.className = "bottom-nav-gallery-choice-copy";
    const label = document.createElement("strong");
    label.textContent = option.label;
    const meta = document.createElement("small");
    meta.textContent = option.meta;
    copy.append(label, meta);

    const check = document.createElement("span");
    check.className = "bottom-nav-gallery-choice-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    button.append(icon, copy, check);
    picker.append(button);
  }

  els.bottomNavBar.append(picker);
  return picker;
}

function syncGalleryModeNavigation() {
  const mode = preferredGalleryMode();
  const modeLabel = galleryModeLabel(mode);
  const galleryButton = galleryNavigationButton();
  if (galleryButton) {
    galleryButton.dataset.galleryModeCurrent = mode;
    const label = galleryButton.querySelector(".bottom-nav-label");
    if (label) label.textContent = modeLabel;
    galleryButton.setAttribute("aria-label", `图库与影视，当前${modeLabel}，点击回到当前分类，长按选择`);
  }
  const picker = els.bottomNavBar?.querySelector(".bottom-nav-gallery-picker");
  if (!picker) return;
  for (const choice of picker.querySelectorAll("[data-gallery-mode-choice]")) {
    const active = choice.dataset.galleryModeChoice === mode;
    choice.classList.toggle("active", active);
    choice.setAttribute("aria-checked", String(active));
  }
}

function openGalleryModePicker() {
  const picker = ensureGalleryModePicker();
  const galleryButton = galleryNavigationButton();
  if (!picker || !galleryButton) return;
  closeHomeModePicker();
  closeReadingModePicker();
  syncGalleryModeNavigation();
  picker.hidden = false;
  galleryButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("gallery-mode-picker-open");
}

function closeGalleryModePicker() {
  const picker = els.bottomNavBar?.querySelector(".bottom-nav-gallery-picker");
  if (picker) picker.hidden = true;
  galleryNavigationButton()?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("gallery-mode-picker-open");
}

function readingNavigationButton() {
  return els.bottomNavBar?.querySelector("button[data-reading-switcher]") || null;
}

function ensureReadingModePicker() {
  if (!els.bottomNavBar) return null;
  let picker = els.bottomNavBar.querySelector(".bottom-nav-reading-picker");
  if (picker) return picker;

  picker = document.createElement("div");
  picker.className = "bottom-nav-reading-picker";
  picker.hidden = true;
  picker.setAttribute("role", "menu");
  picker.setAttribute("aria-label", "选择阅读类型");

  const title = document.createElement("strong");
  title.className = "bottom-nav-reading-picker-title";
  title.textContent = "打开阅读";
  picker.append(title);

  for (const option of [
    { mode: "novels", label: "小说", meta: "本地小说书库", glyph: "书" },
    { mode: "music", label: "音乐", meta: "本地音乐与歌单", glyph: "♪" }
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bottom-nav-reading-choice";
    button.dataset.readingModeChoice = option.mode;
    button.setAttribute("role", "menuitemradio");

    const icon = document.createElement("span");
    icon.className = "bottom-nav-reading-choice-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = option.glyph;

    const copy = document.createElement("span");
    copy.className = "bottom-nav-reading-choice-copy";
    const label = document.createElement("strong");
    label.textContent = option.label;
    const meta = document.createElement("small");
    meta.textContent = option.meta;
    copy.append(label, meta);

    const check = document.createElement("span");
    check.className = "bottom-nav-reading-choice-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    button.append(icon, copy, check);
    picker.append(button);
  }

  els.bottomNavBar.append(picker);
  return picker;
}

function syncReadingModeNavigation() {
  const mode = preferredReadingMode();
  const readingButton = readingNavigationButton();
  if (readingButton) {
    readingButton.dataset.readingModeCurrent = mode;
    const label = readingButton.querySelector(".bottom-nav-label");
    if (label) label.textContent = mode === "music" ? "音乐" : "小说";
    readingButton.setAttribute("aria-label", `阅读，当前${mode === "music" ? "音乐" : "小说"}，点击回到当前分类，长按选择`);
  }
  const picker = els.bottomNavBar?.querySelector(".bottom-nav-reading-picker");
  if (!picker) return;
  for (const choice of picker.querySelectorAll("[data-reading-mode-choice]")) {
    const active = choice.dataset.readingModeChoice === mode;
    choice.classList.toggle("active", active);
    choice.setAttribute("aria-checked", String(active));
  }
}

function openReadingModePicker() {
  const picker = ensureReadingModePicker();
  const readingButton = readingNavigationButton();
  if (!picker || !readingButton) return;
  closeHomeModePicker();
  closeGalleryModePicker();
  syncReadingModeNavigation();
  picker.hidden = false;
  readingButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("reading-mode-picker-open");
}

function closeReadingModePicker() {
  const picker = els.bottomNavBar?.querySelector(".bottom-nav-reading-picker");
  if (picker) picker.hidden = true;
  readingNavigationButton()?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("reading-mode-picker-open");
}

function syncSearchSurface() {
  const controller = activeSearchController();
  const mode = String(controller?.mode || "");
  const expanded = Boolean(controller?.isExpanded?.(currentView, currentViewParams, searchSurfaceExpanded));
  const hasModuleChrome = syncModuleChrome();
  if (renderedSearchController && renderedSearchController !== controller) {
    renderedSearchController.clearFilters?.(els.searchForm);
  }
  renderedSearchController = controller;
  if (els.searchHistory) els.searchHistory.hidden = !(expanded && controller?.showHistory?.(currentView, currentViewParams));
  if (els.bottomNavBar) els.bottomNavBar.hidden = Boolean(expanded && controller?.hideBottom?.(currentView, currentViewParams));
  if (els.moduleChrome) els.moduleChrome.hidden = expanded || !hasModuleChrome;
  if (els.searchForm) els.searchForm.hidden = !expanded;
  els.searchForm.classList.toggle("search-mode", mode === "route");
  els.searchForm.classList.toggle("channel-mode", mode === "channel");
  document.body.classList.toggle("search-view", mode === "route" && expanded);
  document.body.classList.toggle("search-expanded", expanded);
  els.searchInput.placeholder = controller?.placeholder?.(currentView, currentViewParams) || "搜索";
  if (controller) {
    if (document.activeElement !== els.searchInput) {
      els.searchInput.value = controller.value?.(currentView, currentViewParams) || "";
    }
    controller.renderFilters?.(els.searchForm, () => runSearch(els.searchInput.value));
  } else {
    els.searchInput.value = "";
    if (document.activeElement === els.searchInput) els.searchInput.blur();
  }
}

function activeSearchController() {
  if (currentView === "home") return androidModuleRegistry?.get("fanhao")?.search || null;
  return androidModuleRegistry?.searchFor(currentView, currentViewParams) || null;
}

function searchContext() {
  return { view: currentView, params: currentViewParams };
}

async function initializeAndroidModules(definitions) {
  androidModuleRegistry = await loadAndroidModules(definitions, createAndroidModuleHost());
  const fanhaoApi = androidModuleRegistry.get("fanhao")?.api || {};
  const photoApi = androidModuleRegistry.get("photos")?.api || {};
  const mediaApi = androidModuleRegistry.get("media")?.api || {};
  workViews = fanhaoApi.workViews || null;
  peopleViews = fanhaoApi.peopleViews || null;
  detailViews = fanhaoApi.detailViews || null;
  novelViews = androidModuleRegistry.get("novels")?.api.novelViews || null;
  musicViews = androidModuleRegistry.get("music")?.api.musicViews || null;
  shortVideoViews = androidModuleRegistry.get("short-videos")?.api.shortVideoViews || null;
  toolViews = androidModuleRegistry.get("tools")?.api.toolViews || null;
  channelViews = createChannelViewsFacade(photoApi.channelViews, mediaApi.channelViews);
}

function createAndroidModuleHost() {
  return Object.freeze({
    clientVersion: CLIENT_VERSION,
    onModuleError: (definition, error) => setStatus(`模块 ${definition.title || definition.id} 加载失败：${error.message || error}`, "error"),
    els,
    mediaViewer,
    getActiveUrl: () => activeUrl,
    getLibrary: () => library,
    normalizeChannelMode,
    limits: Object.freeze({
      getWorks: () => worksLimit,
      increaseWorks: (amount) => { worksLimit += worksLimitStepForView(currentView, amount); },
      getPeople: () => peopleLimit,
      increasePeople: (amount) => { peopleLimit += peopleLimitStep(amount); },
      getChannel: () => channelLimit,
      increaseChannel: (amount) => {
        channelLimit += channelLimitStepForView(currentView, amount, currentViewParams);
        if (currentView === "channel") rememberCurrentScrollInHistory();
      },
      getPhotoImages: () => photoImageLimit,
      increasePhotoImages: (amount) => { photoImageLimit += photoImageLimitStep(amount); },
      getMangaImages: () => mangaImageLimit,
      increaseMangaImages: (amount) => { mangaImageLimit += mangaImageLimitStep(amount); }
    }),
    navigation: Object.freeze({
      currentView: () => currentView,
      currentParams: () => currentViewParams,
      hasBackStack: () => viewStack.length > 0,
      returnToStackView,
      discardPushedView,
      showView,
      replaceViewParams,
      goBack,
      openInLibrary
    }),
    ui: Object.freeze({
      setActiveBottom,
      refreshChrome: syncModuleChrome,
      openSearch: openSearchSurface,
      scrollToTop: scrollToTopInstant,
      renderCurrentView,
      renderCurrentViewPreservingScroll,
      confirm: requestAppConfirmation,
      setStatus,
      openSettings: (options = {}) => showSettings(options)
    }),
    favorites: Object.freeze({
      onChannelFavoriteChange: handleChannelFavoriteChange,
      onUserStateChange: renderUserState
    }),
    recent: Object.freeze({ record: rememberRecentContent }),
    contentIndex: Object.freeze({
      updateChannelQuery: updateCurrentChannelQuery,
      updateChannelParams: (params = {}, navigation = {}) => {
        showView("channel", { ...currentViewParams, ...params }, { skipHistory: true, replaceHistory: true, ...navigation });
      },
      updateSearch: (params, query) => updateModuleChannelSearch(params, query),
      updatePhotoSearch: (params, query) => updateModuleChannelSearch(params, query, { photo: true })
    })
  });
}

function createChannelViewsFacade(photoViews, mediaViews) {
  return {
    channelLabel(mode) {
      const normalized = normalizeChannelMode(mode);
      return ["photo", "manga"].includes(normalized)
        ? photoViews?.channelLabel(mode)
        : mediaViews?.channelLabel(mode);
    }
  };
}

function updateCurrentChannelQuery(query) {
  updateModuleChannelSearch(currentViewParams, query, { photo: normalizeChannelMode(currentViewParams.mode) === "photo" });
}

function updateModuleChannelSearch(params, query, options = {}) {
  const nextQuery = String(query || "").trim();
  const startingPhotoSearch = options.photo && nextQuery && !String(params.query || "").trim();
  showView("channel", {
    ...params,
    ...(startingPhotoSearch ? { photoView: "albums", collection: "", category: "", person: "" } : {}),
    query: nextQuery
  }, { skipHistory: true, replaceHistory: true });
}

function runSearch(query) {
  window.clearTimeout(searchPrepareTimer);
  const controller = activeSearchController();
  if (!controller?.submit) return;
  searchSurfaceExpanded = false;
  controller.submit(String(query || "").trim(), searchContext());
  syncSearchSurface();
}

function focusSearchInput() {
  requestAnimationFrame(() => {
    els.searchInput.focus();
    els.searchInput.select?.();
  });
}

function openSearchSurface() {
  const controller = activeSearchController();
  if (!controller) return;
  searchSurfaceExpanded = true;
  controller.open?.(searchContext());
  syncSearchSurface();
  focusSearchInput();
}

function closeSearchSurface() {
  window.clearTimeout(searchPrepareTimer);
  const controller = activeSearchController();
  searchSurfaceExpanded = false;
  if (controller?.close?.(searchContext())) return;
  syncSearchSurface();
}

searchHistory = createSearchHistory({
  container: els.searchHistory,
  input: els.searchInput,
  storageKey: SEARCH_HISTORY_STORAGE_KEY,
  defaults: ["[A]"],
  onSearch: runSearch
});

window.addEventListener("popstate", (event) => restoreFromHistoryState(event.state));
for (const eventName of ["pointerdown", "touchstart", "wheel"]) {
  window.addEventListener(eventName, cancelPendingScrollRestore, { passive: true });
}
window.addEventListener("keydown", cancelScrollRestoreFromKeydown);

window.fanhaoHandleNativeBack = () => {
  if (mediaViewer?.close()) return true;
  if (!els.appConfirmOverlay?.hidden) {
    settleAppConfirmation(false);
    return true;
  }
  if (!els.settingsOverlay?.hidden) {
    closeSettings();
    return true;
  }
  if (searchSurfaceExpanded && (currentView === "mediaDetail" || (currentView === "channel" && ["media", "movie", "tv", "anime"].includes(normalizeChannelMode(currentViewParams.mode))))) {
    closeSearchSurface();
    return true;
  }
  if (androidModuleRegistry?.handleBack(currentView, currentViewParams)) return true;
  if (searchSurfaceExpanded || currentView === "search") {
    closeSearchSurface();
    return true;
  }
  if (currentView === "home" || isRootNavigationView()) return false;
  if (returnToStackView()) return true;
  if (window.history.state?.marker === HISTORY_MARKER && window.history.length > 1) {
    window.history.back();
    return true;
  }
  applyBackState();
  return true;
};

applyTheme(themePreference);
replaceCurrentHistory();

els.moduleModeSelect?.addEventListener("change", () => {
  const { value, dataset } = els.moduleModeSelect;
  if (dataset.group === "fanhao") navigateToHomeMode(value);
  else if (dataset.group === "photo") navigateToGalleryMode(value);
  else if (dataset.group === "novels") navigateToReadingMode(value);
});
els.profileSettingsButton?.addEventListener("click", () => toggleSettings(true));
function refreshAccountSettings() {
  const root = document.getElementById("accountSettingsRoot");
  if (!root) return;
  const serverUrl = normalizeUrl(els.serverUrl.value || activeUrl);
  accountSettingsServer = serverUrl;
  accountSettings?.destroy();
  accountSettings = createAccountSettings(root, {
    serverUrl,
    onSignedIn: () => connectToServer(serverUrl),
    onSignedOut: () => { setStatus("已退出用户账号，可重新登录或注册。"); }
  });
}
els.serverUrl?.addEventListener("change", refreshAccountSettings);
els.settingsCloseButton?.addEventListener("click", () => closeSettings());
els.settingsBackdrop?.addEventListener("click", () => closeSettings());
els.appConfirmBackdrop?.addEventListener("click", () => settleAppConfirmation(false));
els.appConfirmCancelButton?.addEventListener("click", () => settleAppConfirmation(false));
els.appConfirmAcceptButton?.addEventListener("click", () => settleAppConfirmation(true));
els.appConfirmOverlay?.addEventListener("keydown", trapAppConfirmationFocus);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!els.appConfirmOverlay?.hidden) settleAppConfirmation(false);
  else if (!els.settingsOverlay?.hidden) closeSettings();
});
els.searchCloseButton?.addEventListener("click", closeSearchSurface);
els.viewBack.addEventListener("click", goBack);

els.openLibraryButton.addEventListener("click", () => {
  showView("people", {}, { resetStack: true });
  scrollToTopInstant();
});

els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const controller = activeSearchController();
  if (controller?.useHistory) searchHistory.run(els.searchInput.value);
  else runSearch(els.searchInput.value);
});

els.searchInput.addEventListener("focus", () => {
  searchSurfaceExpanded = true;
  syncSearchSurface();
});
els.searchInput.addEventListener("input", () => {
  window.clearTimeout(searchPrepareTimer);
  const query = els.searchInput.value.trim();
  if (!query || globalThis.navigator?.connection?.saveData) return;
  searchPrepareTimer = window.setTimeout(() => activeSearchController()?.prepare?.(query, searchContext()), 160);
});

els.serverUrl.addEventListener("input", () => {
  if (els.serverPassword) els.serverPassword.value = "";
  syncConnectionControls();
});
els.connectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void connectToServer(els.serverUrl.value, els.serverPassword?.value || "");
});

els.refreshCacheButton?.addEventListener("click", async () => {
  setCacheActionsDisabled(true);
  els.cacheStatus.textContent = "正在重新统计";
  try {
    await updateStorageStatus({ forceManga: true });
  } catch (error) {
    els.cacheStatus.textContent = `刷新失败：${error.message}`;
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.clearResponseCacheButton?.addEventListener("click", async () => {
  if (!await requestAppConfirmation({ title: "清理数据缓存", message: "只清理当前服务的手机数据缓存。已收藏、观看记录和电脑端文件不会受影响。", confirmLabel: "清理数据", danger: false })) return;
  setCacheActionsDisabled(true);
  els.cacheStatus.textContent = "正在清理数据缓存";
  try {
    await clearCachedResponses(activeUrl);
    await updateCacheStatus();
  } catch (error) {
    els.cacheStatus.textContent = `清理失败：${error.message}`;
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.clearImageCacheButton?.addEventListener("click", async () => {
  if (!await requestAppConfirmation({ title: "清理图片缓存", message: "只清理当前服务缓存在手机上的图片，需要时会自动重新加载。", confirmLabel: "清理图片", danger: false })) return;
  setCacheActionsDisabled(true);
  els.cacheStatus.textContent = "正在清理图片缓存";
  try {
    await clearCachedImages(activeUrl);
    await updateCacheStatus();
  } catch (error) {
    els.cacheStatus.textContent = `清理失败：${error.message}`;
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.clearCacheButton?.addEventListener("click", async () => {
  if (!await requestAppConfirmation({ title: "清理手机缓存", message: "清理当前服务在手机上的数据和图片缓存；漫画原图、收藏和观看记录不会被删除。", confirmLabel: "全部清理", danger: false })) return;
  setCacheActionsDisabled(true);
  els.cacheStatus.textContent = "正在清理全部缓存";
  try {
    await clearCachedData(activeUrl);
    await updateCacheStatus();
  } catch (error) {
    els.cacheStatus.textContent = `清理失败：${error.message}`;
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.openMangaStorageButton?.addEventListener("click", () => {
  hideSettingsSurface();
  showView("channel", { mode: "manga" }, { resetStack: true });
});

els.clearMangaTrashButton?.addEventListener("click", async () => {
  const trashCount = Math.max(0, Number(mangaStorageSnapshot?.trash?.itemCount || 0));
  const trashBytes = Math.max(0, Number(mangaStorageSnapshot?.trash?.bytes || 0));
  if (!trashCount) return;
  const message = `电脑回收站中有 ${formatNumber(trashCount)} 本漫画，预计释放 ${formatBytes(trashBytes)}。清空后无法恢复。`;
  if (!await requestAppConfirmation({ title: "清空漫画回收站", message, confirmLabel: "永久删除", danger: true })) return;
  setCacheActionsDisabled(true);
  els.mangaStorageStatus.textContent = "正在清空电脑回收站";
  els.mangaStorageStatus.classList.remove("error");
  try {
    const result = await fetchJson(activeUrl, "/api/manga/trash", { method: "DELETE", timeoutMs: 0 });
    mangaStorageSnapshot = result?.storage || null;
    renderMangaStorageMetrics(mangaStorageSnapshot);
    els.mangaStorageStatus.textContent = Number(result?.removedCount || 0) > 0
      ? `已释放 ${formatBytes(result.removedBytes || 0)}`
      : "回收站已经为空";
  } catch (error) {
    els.mangaStorageStatus.textContent = `清理失败：${error.message}`;
    els.mangaStorageStatus.classList.add("error");
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.saveReaderCacheLimitButton?.addEventListener("click", async () => {
  const gib = Number(els.readerCacheLimitInput?.value);
  if (!Number.isFinite(gib) || gib < 0 || gib > 200) {
    els.readerCacheStatus.textContent = "请输入 0 到 200 GB";
    els.readerCacheStatus.classList.add("error");
    return;
  }
  const maxBytes = Math.round(gib * (1024 ** 3));
  if (readerCacheSnapshot && maxBytes < Number(readerCacheSnapshot.currentBytes || 0)) {
    const message = `新上限 ${formatBytes(maxBytes)} 低于当前占用 ${formatBytes(readerCacheSnapshot.currentBytes)}，整理时会删除较旧的临时缓存。继续保存吗？`;
    if (!await requestAppConfirmation({ title: "降低阅读缓存上限", message, confirmLabel: "继续保存", danger: false })) return;
  }
  setCacheActionsDisabled(true);
  els.readerCacheStatus.textContent = "正在保存上限";
  els.readerCacheStatus.classList.remove("error");
  try {
    await fetchJson(activeUrl, "/api/admin/settings/photos", {
      method: "PATCH",
      body: { values: { imageReaderCacheMaxBytes: maxBytes } },
      timeoutMs: 12000
    });
    await updateReaderCacheStatus();
  } catch (error) {
    els.readerCacheStatus.textContent = `保存失败：${error.message}`;
    els.readerCacheStatus.classList.add("error");
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.cleanupReaderCacheButton?.addEventListener("click", async () => {
  if (Number(readerCacheSnapshot?.overBytes || 0) > 0) {
    const message = `将按上限清理较旧的临时缓存，预计至少释放 ${formatBytes(readerCacheSnapshot.overBytes)}。继续吗？`;
    if (!await requestAppConfirmation({ title: "整理阅读缓存", message, confirmLabel: "开始整理", danger: false })) return;
  }
  setCacheActionsDisabled(true);
  els.readerCacheStatus.textContent = "正在按上限整理";
  els.readerCacheStatus.classList.remove("error");
  try {
    const result = await fetchJson(activeUrl, "/api/image-reader/cache/cleanup", {
      method: "POST",
      body: {},
      timeoutMs: 0
    });
    readerCacheSnapshot = result?.status || readerCacheSnapshot;
    renderReaderCacheMetrics(readerCacheSnapshot);
    els.readerCacheStatus.textContent = Number(result?.removedCount || 0) > 0
      ? `已释放 ${formatBytes(result.removedBytes || 0)}`
      : "当前未超上限，无需整理";
  } catch (error) {
    els.readerCacheStatus.textContent = `整理失败：${error.message}`;
    els.readerCacheStatus.classList.add("error");
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.appUpdateButton?.addEventListener("click", () => {
  handleAndroidUpdateAction();
});

els.recentContentClear?.addEventListener("click", () => {
  clearRecentContent();
  renderRecentContentPreview();
  setStatus("手机端最近打开已清空。");
});

for (const button of els.quickServers) {
  button.addEventListener("click", () => {
    void connectToServer(button.dataset.url);
  });
}

for (const button of els.openTargets) {
  if (button.closest(".bottom-nav")) continue;
  button.addEventListener("click", () => {
    if (button.dataset.openView) {
      showPrimaryView(button.dataset.openView, { resetStack: true });
      return;
    }
    if (button.dataset.openChannel) {
      showView("channel", { mode: primaryChannelMode(button.dataset.openChannel) }, { resetStack: true });
      return;
    }
    openInLibrary(button.dataset.openUrl || "/");
  });
}

let bottomNavLongPressTimer = 0;
let bottomNavTouchX = 0;
let bottomNavTouchY = 0;
let bottomNavLongPressButton = null;
let suppressedBottomNavButton = null;

els.bottomNavBar?.addEventListener("selectstart", (event) => event.preventDefault());

els.bottomNavBar?.addEventListener("touchstart", (event) => {
  const button = event.target.closest("button");
  if (!button || !els.bottomNavBar.contains(button) || event.touches.length !== 1) return;
  const homeLongPress = button.dataset.homeSwitcher !== undefined;
  const galleryLongPress = button.dataset.gallerySwitcher !== undefined;
  const readingLongPress = button.dataset.readingSwitcher !== undefined;
  const shortVideoSettingsLongPress = button.dataset.openView === "shortVideos" && currentView === "shortVideos";
  if (!homeLongPress && !galleryLongPress && !readingLongPress && !shortVideoSettingsLongPress) return;
  bottomNavTouchX = event.touches[0].clientX;
  bottomNavTouchY = event.touches[0].clientY;
  bottomNavLongPressButton = button;
  window.clearTimeout(bottomNavLongPressTimer);
  bottomNavLongPressTimer = window.setTimeout(() => {
    suppressedBottomNavButton = button;
    navigator.vibrate?.(18);
    if (homeLongPress) openHomeModePicker();
    else if (galleryLongPress) openGalleryModePicker();
    else if (readingLongPress) openReadingModePicker();
    else toggleSettings(true);
  }, 520);
}, { passive: true });

els.bottomNavBar?.addEventListener("touchmove", (event) => {
  if (!bottomNavLongPressButton) return;
  const touch = event.touches[0];
  if (!touch || Math.hypot(touch.clientX - bottomNavTouchX, touch.clientY - bottomNavTouchY) <= 12) return;
  window.clearTimeout(bottomNavLongPressTimer);
  bottomNavLongPressButton = null;
}, { passive: true });

for (const eventName of ["touchend", "touchcancel"]) {
  els.bottomNavBar?.addEventListener(eventName, () => {
    window.clearTimeout(bottomNavLongPressTimer);
    bottomNavLongPressButton = null;
  }, { passive: true });
}

els.bottomNavBar?.addEventListener("contextmenu", (event) => {
  const button = event.target.closest("button[data-home-switcher], button[data-gallery-switcher], button[data-reading-switcher]");
  if (!button || !els.bottomNavBar.contains(button)) return;
  event.preventDefault();
  suppressedBottomNavButton = button;
  navigator.vibrate?.(18);
  if (button.dataset.homeSwitcher !== undefined) openHomeModePicker();
  else if (button.dataset.gallerySwitcher !== undefined) openGalleryModePicker();
  else openReadingModePicker();
});

let dismissModePickerClick = false;
document.addEventListener("click", (event) => {
  if (!dismissModePickerClick) return;
  dismissModePickerClick = false;
  event.preventDefault();
  event.stopPropagation();
}, true);
document.addEventListener("pointerdown", (event) => {
  // A new physical gesture must not inherit suppression from a long press that
  // produced no synthetic click (as on some Android WebViews).
  suppressedBottomNavButton = null;
  dismissModePickerClick = false;
  if (!document.body.classList.contains("home-mode-picker-open") && !document.body.classList.contains("gallery-mode-picker-open") && !document.body.classList.contains("reading-mode-picker-open")) return;
  if (els.bottomNavBar?.contains(event.target)) return;
  dismissModePickerClick = true;
  event.preventDefault();
  event.stopPropagation();
  closeHomeModePicker();
  closeGalleryModePicker();
  closeReadingModePicker();
}, { capture: true });

els.bottomNavBar?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !els.bottomNavBar.contains(button)) return;
  if (suppressedBottomNavButton === button) {
    suppressedBottomNavButton = null;
    event.preventDefault();
    return;
  }
  suppressedBottomNavButton = null;
  if (button.classList.contains("bottom-nav-item") && button.classList.contains("active") && isRootNavigationView()) {
    closeHomeModePicker();
    closeGalleryModePicker();
    closeReadingModePicker();
    scrollToTopInstant();
    return;
  }
  if (button.dataset.homeModeChoice) {
    navigateToHomeMode(button.dataset.homeModeChoice);
    return;
  }
  if (button.dataset.galleryModeChoice) {
    navigateToGalleryMode(button.dataset.galleryModeChoice);
    return;
  }
  if (button.dataset.readingModeChoice) {
    navigateToReadingMode(button.dataset.readingModeChoice);
    return;
  }
  if (button.dataset.gallerySwitcher !== undefined) {
    const currentMode = preferredGalleryMode();
    navigateToGalleryMode(currentMode);
    return;
  }
  closeHomeModePicker();
  closeGalleryModePicker();
  closeReadingModePicker();
  if (button.dataset.focusSearch !== undefined) {
    searchHistory.run(els.searchInput.value);
    els.searchInput.focus();
    return;
  }
  if (button.dataset.homeSwitcher !== undefined || button.dataset.fanhaoHome !== undefined) {
    const currentMode = preferredHomeMode();
    navigateToHomeMode(currentMode);
    return;
  }
  if (button.dataset.readingSwitcher !== undefined) {
    const currentMode = preferredReadingMode();
    navigateToReadingMode(currentMode);
    return;
  }
  if (button.dataset.openView) {
    showPrimaryView(button.dataset.openView, { resetStack: true });
    scrollToTopInstant();
    return;
  }
  if (button.dataset.openChannel) {
    showView("channel", { mode: primaryChannelMode(button.dataset.openChannel) }, { resetStack: true });
    scrollToTopInstant();
  }
});

for (const button of els.themeButtons) {
  button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
}

async function bootApp() {
  watchAndroidUpdateReturn();
  if (els.appStartupMessage) els.appStartupMessage.textContent = initialSettingsRequested ? "正在打开设置" : routeLoadingCopy().message;
  updateServer(activeUrl);
  updateCacheStatus();
  const cachedCatalog = await readCachedJson(activeUrl, MODULE_CATALOG_CACHE_PATH).catch(() => null);
  const modules = cachedCatalog?.payload?.modules
    ? mergeAndroidModuleCatalog(cachedCatalog.payload.modules)
    : androidModuleFallbackCatalog();
  await initializeAndroidModules(modules);
  els.bottomNav = renderAndroidModuleNavigation(els.bottomNavBar, modules);
  void loadDashboard();
  renderCurrentView();
  void refreshModuleCatalog(activeUrl);
  void checkAndroidUpdate({ silent: true });
  if (initialSettingsRequested && els.settingsOverlay?.hidden) showSettings({ skipHistory: true });
}

async function refreshModuleCatalog(serviceBase) {
  try {
    const modules = await loadModuleCatalog(() => fetchJson(serviceBase, MODULE_CATALOG_CACHE_PATH));
    // Keep active readers and local tools intact; apply metadata on next launch.
    await writeCachedJson(serviceBase, MODULE_CATALOG_CACHE_PATH, { modules });
  } catch (error) {
    console.warn("[modules]", error.message || error);
  }
}

bootApp().catch((error) => {
  if (els.statusText) els.statusText.textContent = error.message || "加载失败";
  document.body.classList.add("app-starting");
  if (els.appShell) els.appShell.hidden = true;
  if (els.appStartup) {
    els.appStartup.hidden = false;
    els.appStartup.classList.add("has-error");
  }
  if (els.appStartupMessage) els.appStartupMessage.textContent = `启动失败：${error.message || "请重新打开应用"}`;
  if (els.appStartupRetry) els.appStartupRetry.hidden = false;
  console.error(error);
});

els.appStartupRetry?.addEventListener("click", () => window.location.reload());








import { CLIENT_VERSION, DEFAULT_URL, LAST_VIEW_STORAGE_KEY, SEARCH_HISTORY_STORAGE_KEY, STORAGE_KEY, THEME_STORAGE_KEY } from "./js/config.js?v=20260721-fanhao-author-portraits-06";
import { fetchJson } from "./js/api.js?v=20260706-mobile-web-sync-01";
import { cacheAgeText, clearCachedData, getCacheStats, readCachedJson, writeCachedJson } from "./js/cache.js?v=20260714-music-sleep-current-28";
import { androidModuleFallbackCatalog, loadAndroidModules, mergeAndroidModuleCatalog } from "./js/android-module-registry.js?v=20260712-module-chrome-03";
import { getElements } from "./js/dom.js?v=20260712-module-chrome-03";
import { formatBytes, formatCompact, formatNumber, normalizeUrl } from "./js/format.js";
import { absoluteUrl, loadPreviewImage } from "./js/image.js?v=20260717-fanhao-cover-prepare-01";
import { createMediaViewer } from "./js/media-viewer.js?v=20260702-novel-local-manage-74";
import { loadModuleCatalog, renderAndroidModuleNavigation } from "./js/module-navigation.js?v=20260712-module-chrome-03";
import { clearRecentContent, readRecentContent, recordRecentContent } from "./js/recent-content.js?v=20260702-novel-local-manage-74";
import { createSearchHistory } from "./js/search-history.js";

const els = getElements();
let activeUrl = normalizeUrl(localStorage.getItem(STORAGE_KEY) || DEFAULT_URL);
const RESTORABLE_VIEWS = new Set(["home", "people", "works", "rankings", "studios", "studioDetail", "history", "search", "personDetail", "workDetail", "channel", "photoDetail", "mangaDetail", "mangaChapter", "mediaDetail", "novels", "novelDetail", "novelReader", "music", "shortVideos", "shortVideoSearch", "tools"]);
const DEFAULT_VIEW = "works";
const DEFAULT_PHOTO_CATEGORY = "我喜欢的";
const PRIMARY_LABELS = {
  fanhao: "番号",
  photo: "图库",
  manga: "图库",
  western: "欧美",
  media: "影视",
  movie: "电影",
  tv: "电视剧",
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
const FAST_MANGA_IMAGE_LIMIT = 160;
const FAST_MANGA_IMAGE_STEP = 80;
const initialViewState = readInitialViewState();
const initialSettingsRequested = Boolean(initialViewState.settingsRequested);
let library = null;
let currentView = initialViewState.view;
let currentViewParams = initialViewState.params;
let peopleLimit = defaultPeopleLimit();
let worksLimit = defaultWorksLimitForView(initialViewState.view);
let channelLimit = defaultChannelLimitForView(initialViewState.view, initialViewState.params);
let photoImageLimit = defaultPhotoImageLimitForView(initialViewState.view);
let mangaImageLimit = defaultMangaImageLimitForView(initialViewState.view);
let viewStack = [];
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
let searchSurfaceExpanded = initialViewState.view === "search" || (initialViewState.view === "channel" && Boolean(initialViewState.params.query));
let searchPrepareTimer = 0;
const HISTORY_MARKER = "fanhao-android";
const LIBRARY_CACHE_PATH = "/api/library";
const IMAGE_LIBRARY_SUMMARY_CACHE_PATH = "/api/image-library/summary";
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
const FEED_VIEWS = new Set(["works", "rankings", "studios", "studioDetail", "people", "personDetail", "history", "channel", "photoDetail", "workDetail", "mediaDetail", "novels", "novelDetail", "music", "shortVideos"]);

function readInitialViewState() {
  const state = readViewStateFromHash() || readLastViewState();
  if (state.view === "settings") return { view: "tools", params: {}, settingsRequested: true };
  return state.view === "channel" && normalizeChannelMode(state.params?.mode) === "western"
    ? defaultViewState()
    : state;
}

function defaultViewState() {
  return { view: DEFAULT_VIEW, params: {} };
}

function readLastViewState() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_VIEW_STORAGE_KEY) || "null");
    if (!raw || raw.view === "home" || !shouldRememberView(raw.view, raw.params || {})) return defaultViewState();
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
  if (view === "channel") return Boolean(params.mode);
  if (view === "photoDetail") return Boolean(params.id);
  if (view === "mangaDetail") return Boolean(params.id);
  if (view === "mangaChapter") return Boolean(params.id && params.chapterIndex);
  if (view === "mediaDetail") return Boolean(params.id);
  if (view === "novelDetail") return Boolean(params.id);
  if (view === "novelReader") return Boolean(params.id && params.chapterIndex);
  return true;
}

function sanitizeViewParams(view, params = {}) {
  if (view === "search") return { query: String(params.query || "").trim() };
  if (view === "personDetail") return { personId: String(params.personId || "") };
  if (view === "workDetail") return { workId: String(params.workId || "") };
  if (view === "studioDetail") return { studioId: String(params.studioId || ""), seriesId: String(params.seriesId || "all") || "all" };
  if (view === "photoDetail") return { id: String(params.id || "") };
  if (view === "mangaDetail") return { id: String(params.id || "") };
  if (view === "mangaChapter") return { id: String(params.id || ""), chapterIndex: String(params.chapterIndex || params.chapter || "") };
  if (view === "novelDetail") return { id: String(params.id || "") };
  if (view === "novelReader") return { id: String(params.id || ""), chapterIndex: String(params.chapterIndex || params.chapter || "1") };
  if (view === "music") {
    const rawMode = String(params.mode || "").trim();
    const smartId = String(params.smartId || params.smart || "").trim();
    const playlistId = String(params.playlistId || params.playlist || "").trim();
    const mode = playlistId ? "playlist" : smartId ? "smart" : (rawMode === "history" ? "history" : rawMode === "artists" ? "artists" : rawMode === "albums" ? "albums" : "library");
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
  if (view === "shortVideos" || view === "shortVideoSearch") {
    const query = String(params.query || params.q || "").trim();
    const author = String(params.author || "all").trim() || "all";
    const source = normalizeShortVideoSource(params.source || params.origin);
    const sort = normalizeShortVideoSort(params.sort);
    const authorSort = normalizeFollowingAuthorSort(params.authorSort);
    const authorFilter = normalizeFollowingAuthorFilter(params.authorFilter);
    const searchTab = ["all", "videos", "authors"].includes(String(params.searchTab || params.tab || "").trim())
      ? String(params.searchTab || params.tab).trim()
      : "all";
    return {
      ...(query ? { query } : {}),
      ...(author !== "all" ? { author } : {}),
      ...(source !== "liked" ? { source } : {}),
      ...(sort !== "published" ? { sort } : {}),
      ...(source === "following" && authorSort !== "followed" ? { authorSort } : {}),
      ...(source === "following" && authorFilter !== "all" ? { authorFilter } : {}),
      ...(view === "shortVideoSearch" && searchTab !== "all" ? { tab: searchTab } : {})
    };
  }
  if (view === "mediaDetail") {
    const mode = normalizeChannelMode(params.mode || params.type);
    return {
      id: String(params.id || ""),
      ...(mode && ["western", "media", "movie", "tv"].includes(mode) ? { mode } : {})
    };
  }
  if (view === "channel") {
    const query = String(params.q || params.query || "").trim();
    const mode = normalizeChannelMode(params.mode);
    const rawPhotoView = String(params.photoView || "").trim();
    const photoView = mode === "photo" && rawPhotoView !== "albums" ? "collections" : "albums";
    const tvView = String(params.tvView || params.view || "").trim() === "episodes" ? "episodes" : "series";
    const collection = String(params.collection || "").trim();
    const rawCategory = String(params.category || "").trim();
    const category = mode === "photo" && !collection && !rawCategory ? DEFAULT_PHOTO_CATEGORY : rawCategory;
    const person = String(params.person || "").trim();
    const seriesKey = String(params.seriesKey || "").trim();
    const rawSort = String(params.sort || "").trim();
    const isSeriesMode = mode === "tv" || mode === "media";
    const sort = normalizeChannelSort(rawSort || (isSeriesMode && seriesKey ? "title" : ""));
    return {
      mode,
      ...(query ? { query } : {}),
      ...(sort !== "updated" ? { sort } : {}),
      ...(mode === "photo" ? { photoView: collection ? "albums" : photoView } : {}),
      ...(mode === "tv" && tvView === "episodes" && !seriesKey ? { tvView } : {}),
      ...(isSeriesMode && seriesKey ? { tvView: "episodes", seriesKey } : {}),
      ...(mode === "photo" && category ? { category } : {}),
      ...(["western", "media", "movie", "tv"].includes(mode) && category && category !== "all" ? { category } : {}),
      ...(mode === "photo" && person && person !== "all" ? { person } : {}),
      ...(mode === "photo" && collection ? { collection } : {})
    };
  }
  return {};
}

function normalizeChannelSort(value) {
  const sort = String(value || "").trim();
  return ["updated", "title", "size", "rating"].includes(sort) ? sort : "updated";
}

function normalizeChannelMode(value) {
  const mode = String(value || "").trim();
  if (mode === "movies") return "movie";
  if (["video", "videos", "screen", "film", "films"].includes(mode)) return "media";
  return ["photo", "manga", "western", "media", "movie", "tv"].includes(mode) ? mode : "";
}

function normalizeShortVideoSort(value) {
  const sort = String(value || "published").trim();
  return ["liked", "published", "publishedAsc", "likes", "likesAsc", "comments", "duration"].includes(sort) ? sort : "published";
}

function normalizeShortVideoSource(value) {
  const source = String(value || "liked").trim().toLowerCase();
  return ["liked", "following", "authors", "posts", "all", "local"].includes(source) ? source : "liked";
}

function normalizeFollowingAuthorSort(value) {
  const sort = String(value || "followed").trim().toLowerCase();
  return ["followed", "count", "liked"].includes(sort) ? sort : "followed";
}

function normalizeFollowingAuthorFilter(value) {
  return String(value || "all").trim().toLowerCase() === "unliked" ? "unliked" : "all";
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
}

function renderCurrentViewIfVisible(options = {}) {
  return renderCurrentView(options);
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
    const parts = [];
    if (stats.responseCount) parts.push(`数据 ${formatNumber(stats.responseCount)} 项`);
    if (stats.imageCount) parts.push(`图片 ${formatNumber(stats.imageCount)} 张`);
    els.cacheStatus.textContent = `${parts.join(" · ")} · ${size} · ${cacheAgeText(stats.latestUpdatedAt)}`;
    renderCacheMetrics(stats);
  } catch (error) {
    els.cacheStatus.textContent = `缓存不可用：${error.message}`;
    renderCacheMetrics(null);
  }
}

function renderCacheMetrics(stats) {
  const empty = !stats || !stats.count;
  if (els.cacheBytes) els.cacheBytes.textContent = empty ? "0 B" : formatBytes(stats.bytes);
  if (els.cacheResponseCount) els.cacheResponseCount.textContent = empty ? "0" : formatNumber(stats.responseCount);
  if (els.cacheImageCount) els.cacheImageCount.textContent = empty ? "0" : formatNumber(stats.imageCount);
  if (els.cacheUpdated) els.cacheUpdated.textContent = empty ? "-" : cacheAgeText(stats.latestUpdatedAt);
}

function setCacheActionsDisabled(disabled) {
  if (els.refreshCacheButton) els.refreshCacheButton.disabled = disabled;
  if (els.clearCacheButton) els.clearCacheButton.disabled = disabled;
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
  const status = state.status || "idle";
  const update = state.update || androidUpdateInfo;
  const version = state.version || androidVersionInfo;
  const error = state.error || null;

  if (els.appCurrentVersion) els.appCurrentVersion.textContent = androidVersionLabel(version);
  if (els.appLatestVersion) {
    els.appLatestVersion.textContent = update?.versionName
      ? `${update.versionName}${update.versionCode ? ` (${formatNumber(update.versionCode)})` : ""}`
      : "-";
  }
  if (els.installAppUpdateButton) {
    els.installAppUpdateButton.disabled = !update?.available || status === "checking" || status === "installing";
    els.installAppUpdateButton.textContent = update?.available ? "下载安装" : "暂无更新";
  }

  let message = "等待检查更新";
  if (version?.unsupported) message = "当前环境不支持应用内更新";
  if (status === "checking") message = "正在检查调试版更新";
  if (status === "installing") message = "正在下载安装包";
  if (status === "permission") message = "已打开安装权限设置，允许后再点下载安装";
  if (status === "opened") message = "安装包已打开，请按系统提示确认";
  if (status === "ready" && update?.available) message = `发现调试版 ${update.versionName || update.versionCode}`;
  if (status === "ready" && !update?.available) message = update?.message || "当前已是最新调试版";
  if (error) message = `更新检查失败：${error.message || error}`;

  els.appUpdateStatus.textContent = message;
  els.appUpdateStatus.classList.toggle("error", Boolean(error));
}

async function checkAndroidUpdate(options = {}) {
  if (!els.appUpdateStatus) return null;
  renderAndroidUpdateState({ status: "checking" });
  if (els.checkAppUpdateButton) els.checkAppUpdateButton.disabled = true;
  try {
    androidVersionInfo = await readAndroidVersionInfo();
    const path = `/api/android/update?channel=${encodeURIComponent(ANDROID_UPDATE_CHANNEL)}&currentVersionCode=${encodeURIComponent(androidVersionInfo.versionCode || 0)}&clientVersion=${encodeURIComponent(CLIENT_VERSION)}`;
    const update = androidVersionInfo.unsupported
      ? { available: false, channel: ANDROID_UPDATE_CHANNEL, message: "当前环境不支持应用内更新" }
      : await fetchJson(activeUrl, path, { timeoutMs: 8000 });
    androidUpdateInfo = update?.available ? update : null;
    renderAndroidUpdateState({ status: "ready", update, version: androidVersionInfo });
    return update;
  } catch (error) {
    if (!options.silent) renderAndroidUpdateState({ error, version: androidVersionInfo });
    else renderAndroidUpdateState({ status: "ready", update: null, version: androidVersionInfo, error });
    return null;
  } finally {
    if (els.checkAppUpdateButton) els.checkAppUpdateButton.disabled = false;
  }
}

async function installAndroidUpdate() {
  const plugin = fanhaoUpdaterPlugin();
  if (!plugin?.downloadAndInstall) {
    renderAndroidUpdateState({ error: new Error("当前环境不支持应用内更新") });
    return;
  }
  if (!androidUpdateInfo?.downloadUrl) {
    const update = await checkAndroidUpdate();
    if (!update?.available) return;
    androidUpdateInfo = update;
  }

  renderAndroidUpdateState({ status: "installing", update: androidUpdateInfo, version: androidVersionInfo });
  try {
    const result = await plugin.downloadAndInstall({
      url: androidUpdateInfo.downloadUrl,
      fileName: androidUpdateInfo.fileName || `fanhao-${ANDROID_UPDATE_CHANNEL}.apk`,
      sha256: androidUpdateInfo.sha256 || ""
    });
    renderAndroidUpdateState({
      status: result?.needsPermission ? "permission" : "opened",
      update: androidUpdateInfo,
      version: androidVersionInfo
    });
  } catch (error) {
    renderAndroidUpdateState({ error, update: androidUpdateInfo, version: androidVersionInfo });
  }
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
  if (first === "favorites" || first === "vr") {
    workViews?.setWorkFilterMode(first === "vr" ? "vr" : "favorite", { replace: true, rerender: false });
    showView("works", {}, navigation);
    return true;
  }
  if (first === "history" || first === "rankings" || first === "tools") {
    showView(first, {}, navigation);
    return true;
  }
  if (first === "people") {
    showView("people", {}, navigation);
    return true;
  }
  if (first === "music") {
    showView("music", {
      mode: query.get("mode") || "library",
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
      showView("novelReader", { id: segments[1], chapterIndex: segments[2] }, navigation);
      return true;
    }
    if (segments[1]) {
      showView("novelDetail", { id: segments[1] }, navigation);
      return true;
    }
    showView("novels", {}, navigation);
    return true;
  }
  if (first === "western" || first === "media" || first === "video" || first === "videos" || first === "movie" || first === "movies" || first === "tv") {
    const mode = first === "movies" ? "movie" : normalizeChannelMode(first);
    if (segments[1]) {
      showView("mediaDetail", { id: segments[1], mode }, navigation);
      return true;
    }
    if (mode === "western") {
      showView("works", {}, navigation);
      return true;
    }
    showView("channel", { mode: primaryChannelMode(mode), category: query.get("category") || undefined }, navigation);
    return true;
  }
  if (first === "short-videos" || first === "short-video" || first === "douyin") {
    showView("shortVideos", {
      query: query.get("q") || query.get("search") || "",
      author: query.get("author") || "all",
      source: query.get("source") || query.get("origin") || "liked",
      sort: query.get("sort") || "published"
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

async function loadDashboard() {
  setConnection("连接中", true);
  els.personPreview.innerHTML = `<div class="loading-row">正在读取资料库</div>`;
  loadImageLibrarySummary();
  loadNovelSummary();
  loadMusicSummary();
  loadShortVideoSummary();

  const cached = await readCachedJson(activeUrl, LIBRARY_CACHE_PATH).catch(() => null);
  if (cached?.payload) {
    library = cached.payload;
    renderDashboard(library);
    workViews.renderContinuePreview({ preferCache: true });
    const targetMode = connectionModeLabel(activeUrl);
    setConnection(`${targetMode} · 缓存`, false);
    setStatus(`已显示${targetMode}服务的本地缓存：${cacheAgeText(cached.updatedAt)}，正在连接电脑端。`);
    renderCurrentViewIfVisible();
  }

  try {
    library = await fetchJson(activeUrl, LIBRARY_CACHE_PATH);
    writeCachedJson(activeUrl, LIBRARY_CACHE_PATH, library).catch(() => {});
    renderDashboard(library);
    workViews.renderContinuePreview();
    setConnection(connectionModeLabel(activeUrl, library.access), true);
    setStatus("已连接");
    updateServiceHealth();
    renderCurrentViewIfVisible();
    updateCacheStatus();
    return true;
  } catch (error) {
    const targetMode = connectionModeLabel(activeUrl);
    setConnection(`${targetMode} · 离线`, false);
    if (cached?.payload) {
      setStatus(`电脑端暂时连不上，继续显示本地缓存：${cacheAgeText(cached.updatedAt)}。`, "error");
      updateServiceHealth();
      updateCacheStatus();
      return false;
    }
    library = null;
    setStatus(`连接失败：${error.message}`, "error");
    renderOffline();
    showHome();
    showSettings({ skipHistory: true });
    updateServiceHealth();
    updateCacheStatus();
    return false;
  }
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
  els.historyCount.textContent = formatNumber(user.historyCount || user.history || 0);
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
  document.body.classList.remove("novel-reader-view");
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
  rememberViewState("home", {});
  if (!options.skipHistory) replaceCurrentHistory();
  queueScrollRestore(options.restoreScrollY ?? 0);
}

function showSettings(options = {}) {
  if (!els.settingsOverlay || !els.settingsOverlay.hidden) return;
  els.settingsOverlay.hidden = false;
  document.body.classList.add("settings-open");
  els.profileSettingsButton?.setAttribute("aria-expanded", "true");
  updateCacheStatus();
  updateServiceHealth();
  renderAndroidUpdateState({ version: androidVersionInfo });
  if (!options.skipHistory && !window.history.state?.settingsOpen) {
    rememberCurrentScrollInHistory();
    window.history.pushState({
      ...routeHistoryState(currentView, currentViewParams),
      settingsOpen: true
    }, "", viewRouteHash(currentView, currentViewParams));
  }
  window.requestAnimationFrame(() => els.settingsCloseButton?.focus({ preventScroll: true }));
}

function hideSettingsSurface() {
  if (!els.settingsOverlay || els.settingsOverlay.hidden) return;
  els.settingsOverlay.hidden = true;
  document.body.classList.remove("settings-open");
  els.profileSettingsButton?.setAttribute("aria-expanded", "false");
}

function closeSettings(options = {}) {
  if (!els.settingsOverlay || els.settingsOverlay.hidden) return;
  if (!options.skipHistory && window.history.state?.settingsOpen) {
    window.history.back();
    return;
  }
  hideSettingsSurface();
}

function showView(view, params = {}, navigation = {}) {
  if (view === "channel" && normalizeChannelMode(params.mode) === "western") {
    view = "works";
    params = {};
  }
  if (!library && !canRenderWithoutLibrary(view)) {
    toggleSettings(true);
    return;
  }

  const shouldWriteHistory = !navigation.skipHistory;
  if (shouldWriteHistory) rememberCurrentScrollInHistory();
  if (navigation.resetStack) viewStack = [];
  if (navigation.push && currentView) {
    viewStack.push({ view: currentView, params: currentViewParams, scrollY: currentScrollY() });
  }
  currentView = view;
  currentViewParams = sanitizeViewParams(view, params);
  searchSurfaceExpanded = view === "search" || (view === "channel" && Boolean(currentViewParams.query));
  resetViewLimitsForView(view);
  rememberViewState(currentView, currentViewParams);
  if (shouldWriteHistory) pushViewHistory(view, currentViewParams, navigation.restoreScrollY ?? 0);
  else if (navigation.replaceHistory) replaceCurrentHistory();
  renderCurrentView();
  queueScrollRestore(navigation.restoreScrollY ?? 0);
}

function replaceViewParams(view, params = {}, navigation = {}) {
  if (view !== currentView) return false;
  currentViewParams = sanitizeViewParams(view, params);
  rememberViewState(currentView, currentViewParams);
  if (navigation.replaceHistory !== false) replaceCurrentHistory();
  return true;
}

function canRenderWithoutLibrary(view = "") {
  return view === "home"
    || view === "tools"
    || view === "novels"
    || view === "novelDetail"
    || view === "novelReader"
    || view === "music"
    || view === "shortVideos"
    || view === "shortVideoSearch";
}

function defaultWorksLimitForView(view) {
  const fast = isFastServerUrl();
  if (view === "rankings") return 120;
  if (view === "works" || view === "studioDetail") return fast ? FAST_WORK_LIMIT : 60;
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
  if (returnToStackView()) return;
  if (!isRootNavigationView() && currentView !== "home" && window.history.state?.marker === HISTORY_MARKER && window.history.length > 1) {
    window.history.back();
    return;
  }
  applyBackState();
}

function returnToStackView() {
  const previous = viewStack.pop();
  if (!previous) return false;
  if (previous.view === "home") {
    showView(DEFAULT_VIEW, {}, { skipHistory: true, replaceHistory: true, restoreScrollY: previous.scrollY ?? 0 });
    return true;
  }
  showView(previous.view, previous.params, { skipHistory: true, replaceHistory: true, restoreScrollY: previous.scrollY ?? 0 });
  return true;
}

function applyBackState() {
  if (returnToStackView()) return;
  showView(DEFAULT_VIEW, {}, { skipHistory: true, replaceHistory: true, restoreScrollY: 0 });
}

function routeHistoryState(view, params = {}, scrollY = currentScrollY()) {
  return {
    marker: HISTORY_MARKER,
    view,
    params: sanitizeViewParams(view, params || {}),
    scrollY: Math.max(0, Math.round(Number(scrollY) || 0))
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
    if (currentView !== settingsBaseView) {
      showView(settingsBaseView, settingsBaseParams, { skipHistory: true });
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
  showView(view, params, { skipHistory: true, restoreScrollY });
}

function renderCurrentView(options = {}) {
  const restoreScrollY = Number.isFinite(Number(options.restoreScrollY)) ? Math.max(0, Math.round(Number(options.restoreScrollY))) : null;
  const restoreAfterRender = (task) => {
    if (restoreScrollY === null) return task;
    Promise.resolve(task).finally(() => queueScrollRestore(restoreScrollY));
    return task;
  };
  androidModuleRegistry?.deactivateExcept(currentView, currentViewParams);

  if (currentView === "home") {
    const task = showHome();
    return restoreAfterRender(task);
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
  els.viewContent.innerHTML = "";
  els.viewContent.className = "content-list";
  syncSearchSurface();
  renderRouteLoadingState();
  const renderGuard = beginViewRender(currentView, currentViewParams);

  return restoreAfterRender(androidModuleRegistry?.render(currentView, currentViewParams, renderGuard));
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
    const label = channelViews?.channelLabel(mode) || PRIMARY_LABELS[bottomNavKeyFor(view, params)] || "频道";
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
  if (view === "personDetail") return { kicker: "作者", title: "作者详情", meta: "正在读取", message: "正在加载作者资料" };
  if (view === "workDetail") return { kicker: "作品详情", title: "作品详情", meta: "正在读取", message: "正在加载作品详情" };
  if (view === "novelDetail") return { kicker: "小说", title: "书籍详情", meta: "正在读取", message: "正在读取书籍详情" };
  if (view === "novelReader") return { kicker: "小说阅读", title: "章节", meta: "正在读取", message: "正在翻开章节" };
  if (view === "music") return { kicker: "本地音乐", title: "音乐", meta: "正在读取", message: "正在读取音乐库" };
  if (view === "shortVideoSearch") return { kicker: "短视频", title: "搜索", meta: "", message: "正在打开搜索" };
  if (view === "rankings") return { kicker: "榜单", title: "排行榜", meta: "正在加载", message: "正在加载排行榜" };
  if (view === "studios") return { kicker: "片商", title: "片商索引", meta: "正在加载", message: "正在加载片商" };
  if (view === "studioDetail") return { kicker: "片商", title: "片商作品", meta: "正在加载", message: "正在加载片商作品" };
  if (view === "history") return { kicker: "继续观看", title: "观看进度", meta: "正在读取", message: "正在加载观看进度" };
  if (view === "search") return { kicker: "搜索", title: params.query ? `搜索：${params.query}` : "全库搜索", meta: "正在搜索", message: "正在搜索" };
  if (view === "people") return { kicker: "作者索引", title: "全部作者", meta: "正在整理", message: "正在整理作者索引" };
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
  document.body.classList.toggle("music-mobile-view", currentView === "music");
  document.body.classList.toggle("short-video-mobile-view", currentView === "shortVideos");
  document.body.classList.toggle("short-video-search-page-view", currentView === "shortVideoSearch");
  document.body.classList.toggle("fanhao-search-page-view", currentView === "search");
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
  if (view === "novels") novelViews?.focusLocalSource?.();
  showView(view, {}, navigation);
}

function primaryChannelMode(mode) {
  const normalized = normalizeChannelMode(mode);
  return normalized === "media" ? "movie" : normalized;
}

function isRootNavigationView(view = currentView) {
  if (view === "home") return true;
  const resolved = androidModuleRegistry?.resolve(view, currentViewParams);
  return Boolean(resolved?.module.rootViews.has(view));
}

function isNovelNavigationView(view = currentView) {
  return view === "novels" || view === "novelDetail" || view === "novelReader";
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
  if (view === "home") return "fanhao";
  return androidModuleRegistry?.resolve(view, params)?.module.bottomKey || "";
}

function setActiveBottom(name = currentView) {
  const activeKey = bottomNavKeyFor(name);
  for (const button of els.bottomNav) {
    const key = button.dataset.bottomKey
      || (button.dataset.fanhaoHome !== undefined ? "fanhao" : "")
      || (button.dataset.openChannel ? normalizeChannelMode(button.dataset.openChannel) : "");
    button.classList.toggle("active", Boolean(key && key === activeKey));
  }
  if (els.profileSettingsButton) {
    const profileActive = currentView === "tools";
    els.profileSettingsButton.hidden = !profileActive;
    els.profileSettingsButton.setAttribute("aria-expanded", profileActive && !els.settingsOverlay?.hidden ? "true" : "false");
  }
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
      increaseChannel: (amount) => { channelLimit += channelLimitStepForView(currentView, amount, currentViewParams); },
      getPhotoImages: () => photoImageLimit,
      increasePhotoImages: (amount) => { photoImageLimit += photoImageLimitStep(amount); },
      getMangaImages: () => mangaImageLimit,
      increaseMangaImages: (amount) => { mangaImageLimit += mangaImageLimitStep(amount); }
    }),
    navigation: Object.freeze({
      currentView: () => currentView,
      currentParams: () => currentViewParams,
      hasBackStack: () => viewStack.length > 0,
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
      setStatus,
      openSettings: () => toggleSettings(true)
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
  controller.submit(String(query || "").trim(), searchContext());
  searchSurfaceExpanded = false;
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

window.fanhaoHandleNativeBack = () => {
  if (mediaViewer?.close()) return true;
  if (!els.settingsOverlay?.hidden) {
    closeSettings();
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

els.profileSettingsButton?.addEventListener("click", () => toggleSettings(true));
els.settingsCloseButton?.addEventListener("click", () => closeSettings());
els.settingsBackdrop?.addEventListener("click", () => closeSettings());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.settingsOverlay?.hidden) closeSettings();
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

els.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    updateServer(els.serverUrl.value);
    androidUpdateInfo = null;
    updateServiceHealth();
    renderAndroidUpdateState({ version: androidVersionInfo, update: null });
    setStatus("服务地址已保存，打开内容时会按这个地址使用。");
  } catch {
    setStatus("地址格式不对，可以写成 192.168.31.86:29998。", "error");
  }
});

els.refreshCacheButton?.addEventListener("click", async () => {
  setCacheActionsDisabled(true);
  setStatus("正在刷新本地缓存。");
  try {
    const refreshed = await loadDashboard();
    const rankingCache = refreshed ? await workViews.refreshRankingCache() : null;
    await updateCacheStatus();
    const rankingText = rankingCache?.cachedLists
      ? `，排行榜 ${formatNumber(rankingCache.cachedLists)} 个榜单已预缓存`
      : "，排行榜也已预缓存";
    const imageText = rankingCache?.cachedImages ? `，含 ${formatNumber(rankingCache.cachedImages)} 张榜单封面` : "";
    setStatus(refreshed ? `本地缓存已刷新${rankingText}${imageText}。` : "电脑端暂时连不上，保留已有本地缓存。", refreshed ? "normal" : "error");
  } catch (error) {
    setStatus(`刷新失败：${error.message}`, "error");
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.clearCacheButton?.addEventListener("click", async () => {
  setCacheActionsDisabled(true);
  setStatus("正在清理本地缓存。");
  try {
    await clearCachedData(activeUrl);
    await updateCacheStatus();
    setStatus("当前服务的本地缓存已清理。");
  } catch (error) {
    setStatus(`清理失败：${error.message}`, "error");
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.checkAppUpdateButton?.addEventListener("click", () => {
  checkAndroidUpdate();
});

els.installAppUpdateButton?.addEventListener("click", () => {
  installAndroidUpdate();
});

els.recentContentClear?.addEventListener("click", () => {
  clearRecentContent();
  renderRecentContentPreview();
  setStatus("手机端最近打开已清空。");
});

for (const button of els.quickServers) {
  button.addEventListener("click", () => {
    updateServer(button.dataset.url);
    androidUpdateInfo = null;
    updateServiceHealth();
    renderAndroidUpdateState({ version: androidVersionInfo, update: null });
    setStatus("服务地址已切换，打开内容时会按这个地址使用。");
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

let suppressBottomNavClick = false;
let bottomNavLongPressTimer = 0;
let bottomNavTouchX = 0;
let bottomNavTouchY = 0;

els.bottomNavBar?.addEventListener("touchstart", (event) => {
  const button = event.target.closest("button[data-open-view='shortVideos']");
  if (!button || currentView !== "shortVideos" || event.touches.length !== 1) return;
  bottomNavTouchX = event.touches[0].clientX;
  bottomNavTouchY = event.touches[0].clientY;
  window.clearTimeout(bottomNavLongPressTimer);
  bottomNavLongPressTimer = window.setTimeout(() => {
    suppressBottomNavClick = true;
    navigator.vibrate?.(18);
    toggleSettings(true);
  }, 560);
}, { passive: true });

els.bottomNavBar?.addEventListener("touchmove", (event) => {
  const touch = event.touches[0];
  if (!touch || Math.hypot(touch.clientX - bottomNavTouchX, touch.clientY - bottomNavTouchY) <= 12) return;
  window.clearTimeout(bottomNavLongPressTimer);
}, { passive: true });

for (const eventName of ["touchend", "touchcancel"]) {
  els.bottomNavBar?.addEventListener(eventName, () => window.clearTimeout(bottomNavLongPressTimer), { passive: true });
}

els.bottomNavBar?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !els.bottomNavBar.contains(button)) return;
  if (suppressBottomNavClick) {
    suppressBottomNavClick = false;
    event.preventDefault();
    return;
  }
  if (button.dataset.focusSearch !== undefined) {
    searchHistory.run(els.searchInput.value);
    els.searchInput.focus();
    return;
  }
  if (button.dataset.fanhaoHome !== undefined) {
    showView(DEFAULT_VIEW, {}, { resetStack: true });
    scrollToTopInstant();
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
  updateServer(activeUrl);
  updateCacheStatus();
  let modules = androidModuleFallbackCatalog();
  try {
    const remoteModules = await loadModuleCatalog(() => fetchJson(activeUrl, "/api/modules"));
    modules = mergeAndroidModuleCatalog(remoteModules);
  } catch (error) {
    console.warn("[modules]", error.message || error);
  }
  await initializeAndroidModules(modules);
  els.bottomNav = renderAndroidModuleNavigation(els.bottomNavBar, modules);
  await loadDashboard();
  if (initialSettingsRequested && els.settingsOverlay?.hidden) showSettings({ skipHistory: true });
}

bootApp().catch((error) => {
  if (els.statusText) els.statusText.textContent = error.message || "加载失败";
  console.error(error);
});








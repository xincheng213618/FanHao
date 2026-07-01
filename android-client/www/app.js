import { CLIENT_VERSION, DEFAULT_URL, LAST_VIEW_STORAGE_KEY, SEARCH_HISTORY_STORAGE_KEY, STORAGE_KEY, THEME_STORAGE_KEY } from "./js/config.js?v=20260701-novel-reader-05";
import { fetchJson } from "./js/api.js?v=20260701-novel-reader-05";
import { cacheAgeText, clearCachedData, getCacheStats, readCachedJson, writeCachedJson } from "./js/cache.js?v=20260701-novel-reader-05";
import { countChannelFavorites, readChannelFavorites, removeChannelFavorite } from "./js/channel-favorites.js?v=20260701-novel-reader-05";
import { createChannelViews } from "./js/channel-views.js?v=20260701-novel-reader-05";
import { createDetailViews } from "./js/detail-views.js?v=20260701-novel-reader-05";
import { getElements } from "./js/dom.js?v=20260701-novel-reader-05";
import { formatBytes, formatCompact, formatNumber, normalizeUrl } from "./js/format.js";
import { absoluteUrl, loadPreviewImage } from "./js/image.js?v=20260701-novel-reader-05";
import { createMediaViewer } from "./js/media-viewer.js?v=20260701-novel-reader-05";
import { createNovelViews } from "./js/novel-views.js?v=20260701-novel-reader-05";
import { createPeopleViews } from "./js/people-views.js";
import { clearRecentContent, readRecentContent, recordRecentContent } from "./js/recent-content.js?v=20260701-novel-reader-05";
import { createSearchHistory } from "./js/search-history.js";
import { createToolViews } from "./js/tool-views.js?v=20260701-novel-reader-05";
import { createWorkViews } from "./js/work-views.js?v=20260701-novel-reader-05";

const els = getElements();
let activeUrl = normalizeUrl(localStorage.getItem(STORAGE_KEY) || DEFAULT_URL);
const RESTORABLE_VIEWS = new Set(["home", "people", "works", "rankings", "favorites", "history", "search", "personDetail", "workDetail", "channel", "photoDetail", "mangaDetail", "mangaChapter", "mediaDetail", "novels", "novelDetail", "novelReader", "tools"]);
const DEFAULT_VIEW = "works";
const FANHAO_ROOT_VIEWS = new Set(["works", "rankings", "people", "favorites"]);
const FANHAO_SECTION_VIEWS = new Set(["works", "rankings", "people", "favorites", "history", "personDetail", "workDetail"]);
const FANHAO_TOP_TABS = [
  { label: "作品", view: "works" },
  { label: "榜单", view: "rankings" },
  { label: "人物", view: "people" },
  { label: "收藏", view: "favorites" }
];
const DEFAULT_PHOTO_CATEGORY = "我喜欢的";
const PHOTO_TOP_CATEGORY_PRIORITY = [
  DEFAULT_PHOTO_CATEGORY,
  "all",
  "[XIUREN] 秀人网",
  "[COS]",
  "内购私拍",
  "日本写真集",
  "韩国写真集",
  "国模"
];
const PHOTO_CATEGORY_LABELS = new Map([
  [DEFAULT_PHOTO_CATEGORY, "我喜欢的"],
  ["all", "全部"],
  ["[XIUREN] 秀人网", "秀人网"],
  ["[COS]", "COS"]
]);
const TV_TOP_CATEGORY_PRIORITY = ["中国", "美剧", "韩剧", "日本", "欧美", "台湾", "香港", "纪录片", "BBC纪录片合集"];
const PRIMARY_LABELS = {
  fanhao: "番号",
  photo: "套图",
  manga: "套图",
  western: "欧美",
  movie: "电影",
  tv: "电视剧",
  novels: "小说",
  tools: "小工具",
  settings: "设置"
};
const FAST_WORK_LIMIT = 720;
const FAST_WORK_STEP = 720;
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
let mediaViewer = null;
let searchHistory = null;
let viewRenderToken = 0;
let activeViewController = null;
let pendingScrollRestore = null;
let searchSurfaceExpanded = initialViewState.view === "search" || (initialViewState.view === "channel" && Boolean(initialViewState.params.query));
const HISTORY_MARKER = "fanhao-android";
const LIBRARY_CACHE_PATH = "/api/library";
const IMAGE_LIBRARY_SUMMARY_CACHE_PATH = "/api/image-library/summary";
const NOVEL_SUMMARY_CACHE_PATH = "/api/novels/summary";
const ANDROID_UPDATE_CHANNEL = "debug";
let themePreference = localStorage.getItem(THEME_STORAGE_KEY) || "system";
let imageLibrarySummary = null;
let novelSummary = null;
let topTvCategoryFacets = [];
let androidVersionInfo = null;
let androidUpdateInfo = null;
const FEED_VIEWS = new Set(["works", "rankings", "people", "favorites", "history", "channel", "photoDetail", "workDetail", "mediaDetail", "novels", "novelDetail"]);

function readInitialViewState() {
  return readViewStateFromHash() || readLastViewState();
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
  if (view === "photoDetail") return { id: String(params.id || "") };
  if (view === "mangaDetail") return { id: String(params.id || "") };
  if (view === "mangaChapter") return { id: String(params.id || ""), chapterIndex: String(params.chapterIndex || params.chapter || "") };
  if (view === "novelDetail") return { id: String(params.id || "") };
  if (view === "novelReader") return { id: String(params.id || ""), chapterIndex: String(params.chapterIndex || params.chapter || "1") };
  if (view === "mediaDetail") {
    const mode = normalizeChannelMode(params.mode || params.type);
    return {
      id: String(params.id || ""),
      ...(mode && ["western", "movie", "tv"].includes(mode) ? { mode } : {})
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
    const sort = normalizeChannelSort(rawSort || (mode === "tv" && seriesKey ? "title" : ""));
    return {
      mode,
      ...(query ? { query } : {}),
      ...(sort !== "updated" ? { sort } : {}),
      ...(mode === "photo" ? { photoView: collection ? "albums" : photoView } : {}),
      ...(mode === "tv" && tvView === "episodes" && !seriesKey ? { tvView } : {}),
      ...(mode === "tv" && seriesKey ? { tvView: "episodes", seriesKey } : {}),
      ...(mode === "photo" && category ? { category } : {}),
      ...(["western", "movie", "tv"].includes(mode) && category && category !== "all" ? { category } : {}),
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
  return ["photo", "manga", "western", "movie", "tv"].includes(mode) ? mode : "";
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
  return isFastServerUrl() ? 160 : 48;
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

function peopleLimitStep() {
  return isFastServerUrl() ? 160 : 48;
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

function renderOmniSummary(summary, state = {}) {
  if (!els.omniGrid) return;
  syncChannelCounts(summary);
  syncNovelCounts();
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
      unit: "图包",
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
      label: "欧美",
      value: formatCompact(totals.western),
      unit: "视频",
      detail: mediaRootText(summary, "western"),
      mode: "western"
    },
    {
      label: "电影",
      value: formatCompact(totals.movies),
      unit: "影片",
      detail: mediaRootText(summary, "movie"),
      mode: "movie"
    },
    {
      label: "电视剧",
      value: formatCompact(totals.tv),
      unit: "集",
      detail: mediaRootText(summary, "tv"),
      mode: "tv"
    },
    {
      label: "TXT 工具",
      value: "排版",
      unit: "工具",
      detail: "小说文本整理",
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
      ? [`${formatCompact(totals.photoSets)} 图包`, totals.manga ? `${formatCompact(totals.manga)} 韩漫` : ""].filter(Boolean).join(" · ")
      : "图包 / 韩漫";
  }
  if (els.channelWesternCount) els.channelWesternCount.textContent = totals.western ? `${formatCompact(totals.western)} 视频` : "视频";
  if (els.channelMovieCount) els.channelMovieCount.textContent = totals.movies ? `${formatCompact(totals.movies)} 影片` : "影片";
  if (els.channelTvCount) els.channelTvCount.textContent = totals.tv ? `${formatCompact(totals.tv)} 集` : "剧集";
  syncNovelCounts();
}

function syncNovelCounts() {
  if (!els.channelNovelCount) return;
  const totals = novelSummary?.totals || {};
  els.channelNovelCount.textContent = totals.books ? `${formatCompact(totals.books)} 本` : "TXT 阅读";
}

async function updateServiceHealth() {
  if (!els.serviceHealthStatus) return;
  const requestUrl = activeUrl;
  els.serviceHealthStatus.textContent = "正在检查服务状态";
  renderServiceHealth(null);
  try {
    const health = await fetchJson(requestUrl, "/api/health", { timeoutMs: 8000 });
    if (requestUrl !== activeUrl) return;
    renderServiceHealth(health);
  } catch (error) {
    if (requestUrl !== activeUrl) return;
    renderServiceHealth(null, error);
  }
}

function renderServiceHealth(health, error = null) {
  if (!els.serviceHealthStatus) return;
  const mode = health?.access ? connectionModeLabel(activeUrl, health.access) : connectionModeLabel(activeUrl);

  if (error) {
    els.serviceHealthStatus.textContent = `无法连接：${error.message}`;
    els.serviceHealthStatus.classList.add("error");
    setHealthMetric(els.healthMode, mode);
    setHealthMetric(els.healthRoots, "-");
    setHealthMetric(els.healthWorks, "-");
    setHealthMetric(els.healthScannedAt, "-");
    return;
  }

  if (!health) {
    els.serviceHealthStatus.textContent = "等待服务状态";
    els.serviceHealthStatus.classList.remove("error");
    setHealthMetric(els.healthMode, mode);
    setHealthMetric(els.healthRoots, "-");
    setHealthMetric(els.healthWorks, "-");
    setHealthMetric(els.healthScannedAt, "-");
    return;
  }

  const missingCount = Number(health.missingRootCount || 0);
  const availableCount = Number(health.availableRootCount || 0);
  const totalRoots = availableCount + missingCount;
  els.serviceHealthStatus.textContent = health.lastScanError
    ? `索引异常：${health.lastScanError}`
    : missingCount
      ? `有 ${formatNumber(missingCount)} 个根目录不可用`
      : "服务正常，全部根目录可用";
  els.serviceHealthStatus.classList.toggle("error", Boolean(health.lastScanError || missingCount));
  setHealthMetric(els.healthMode, mode);
  setHealthMetric(els.healthRoots, totalRoots ? `${formatNumber(availableCount)}/${formatNumber(totalRoots)}` : formatNumber(availableCount));
  setHealthMetric(els.healthWorks, formatCompact(health.totals?.works));
  setHealthMetric(els.healthScannedAt, health.scannedAt ? cacheAgeText(health.scannedAt) : "-");
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
  if (first === "favorites" || first === "history" || first === "rankings" || first === "tools") {
    showView(first, {}, navigation);
    return true;
  }
  if (first === "people") {
    showView("people", {}, navigation);
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
  if (first === "western" || first === "movie" || first === "movies" || first === "tv") {
    const mode = first === "movies" ? "movie" : first;
    if (segments[1]) {
      showView("mediaDetail", { id: segments[1], mode }, navigation);
      return true;
    }
    showView("channel", { mode, category: query.get("category") || undefined }, navigation);
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

  const cached = await readCachedJson(activeUrl, LIBRARY_CACHE_PATH).catch(() => null);
  if (cached?.payload) {
    library = cached.payload;
    renderDashboard(library);
    workViews.renderContinuePreview({ preferCache: true });
    const targetMode = connectionModeLabel(activeUrl);
    setConnection(`${targetMode} · 缓存`, false);
    setStatus(`已显示${targetMode}服务的本地缓存：${cacheAgeText(cached.updatedAt)}，正在连接电脑端。`);
    renderCurrentView();
  }

  try {
    library = await fetchJson(activeUrl, LIBRARY_CACHE_PATH);
    writeCachedJson(activeUrl, LIBRARY_CACHE_PATH, library).catch(() => {});
    renderDashboard(library);
    workViews.renderContinuePreview();
    setConnection(connectionModeLabel(activeUrl, library.access), true);
    setStatus(`索引时间：${library.scannedAt ? new Date(library.scannedAt).toLocaleString() : "未知"}`);
    updateServiceHealth();
    renderCurrentView();
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
    els.settingsPanel.hidden = false;
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

  const previewPeople = [...people]
    .sort((a, b) => {
      const aVisual = a.actorProfile?.avatarUrl ? 2 : a.coverId ? 1 : 0;
      const bVisual = b.actorProfile?.avatarUrl ? 2 : b.coverId ? 1 : 0;
      return bVisual - aVisual || (b.videoCount || 0) - (a.videoCount || 0);
    })
    .slice(0, 10);
  peopleViews.renderPreviewPeople(previewPeople);
}

function renderUserState(user = {}) {
  els.historyCount.textContent = formatNumber(user.historyCount || user.history || 0);
  els.favoriteCount.textContent = formatNumber((user.favoriteCount || user.favorites || 0) + countChannelFavorites());
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

function renderChannelFavoritesPanel() {
  const items = readChannelFavorites();
  if (!items.length) return;

  const panel = document.createElement("div");
  panel.className = "channel-favorites-panel";
  const head = document.createElement("div");
  head.className = "channel-favorites-head";
  const title = document.createElement("strong");
  title.textContent = "频道收藏";
  const meta = document.createElement("span");
  meta.textContent = `${formatNumber(items.length)} 个`;
  head.append(title, meta);

  const grid = document.createElement("div");
  grid.className = "channel-favorites-grid";
  for (const item of items) {
    grid.append(createChannelFavoriteCard(item));
  }

  panel.append(head, grid);
  els.viewContent.append(panel);
}

function createChannelFavoriteCard(item) {
  const wrap = document.createElement("div");
  wrap.className = `channel-favorite-card ${item.type || ""}`;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "channel-favorite-open";
  open.addEventListener("click", () => showView(item.view, item.params, { push: true }));

  const thumb = document.createElement("div");
  thumb.className = "channel-favorite-thumb";
  thumb.textContent = item.fallback || "?";
  if (item.coverUrl) {
    const cover = absoluteUrl(activeUrl, item.coverUrl);
    if (cover) loadPreviewImage(thumb, cover, { cacheBaseUrl: activeUrl });
  }

  const body = document.createElement("div");
  body.className = "channel-favorite-body";
  const label = document.createElement("span");
  label.textContent = item.label || "频道";
  const title = document.createElement("strong");
  title.textContent = item.title || "未命名内容";
  const meta = document.createElement("small");
  meta.textContent = [item.subtitle, item.meta].filter(Boolean).join(" · ");
  body.append(label, title);
  if (meta.textContent) body.append(meta);
  open.append(thumb, body);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "channel-favorite-remove";
  remove.textContent = "取消收藏";
  remove.addEventListener("click", () => {
    removeChannelFavorite(item);
    renderUserState(library?.user || {});
    renderCurrentView();
  });

  wrap.append(open, remove);
  return wrap;
}

function handleChannelFavoriteChange() {
  renderUserState(library?.user || {});
  if (currentView === "favorites") renderCurrentView();
}

function showHome(options = {}) {
  invalidateViewRender();
  document.body.classList.remove("novel-reader-view");
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
  els.settingsPanel.hidden = true;
  els.viewBack.hidden = true;
  setActiveBottom("home");
  syncFanhaoSectionNav();
  rememberViewState("home", {});
  if (!options.skipHistory) replaceCurrentHistory();
  queueScrollRestore(options.restoreScrollY ?? 0);
}

function showSettings(options = {}) {
  invalidateViewRender();
  document.body.classList.remove("novel-reader-view");
  currentView = "settings";
  currentViewParams = {};
  dispatchAppViewChanged();
  searchSurfaceExpanded = false;
  viewStack = [];
  syncSearchSurface();
  els.quickStrip.hidden = true;
  els.continueSection.hidden = true;
  if (els.recentContentSection) els.recentContentSection.hidden = true;
  els.statusCard.hidden = true;
  if (els.omniSection) els.omniSection.hidden = true;
  if (els.libraryChannelStrip) els.libraryChannelStrip.hidden = true;
  els.previewSection.hidden = true;
  els.contentPanel.hidden = true;
  els.settingsPanel.hidden = false;
  els.viewBack.hidden = true;
  setActiveBottom("settings");
  syncFanhaoSectionNav();
  updateCacheStatus();
  updateServiceHealth();
  renderAndroidUpdateState({ version: androidVersionInfo });
  checkAndroidUpdate({ silent: true });
  if (!options.skipHistory) pushViewHistory("settings", {});
  queueScrollRestore(options.restoreScrollY ?? 0);
}

function showView(view, params = {}, navigation = {}) {
  if (!library && view !== "home" && view !== "tools") {
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
  els.settingsPanel.hidden = true;
  rememberViewState(currentView, currentViewParams);
  if (shouldWriteHistory) pushViewHistory(view, currentViewParams, navigation.restoreScrollY ?? 0);
  else if (navigation.replaceHistory) replaceCurrentHistory();
  renderCurrentView();
  queueScrollRestore(navigation.restoreScrollY ?? 0);
}

function defaultWorksLimitForView(view) {
  const fast = isFastServerUrl();
  if (view === "rankings") return 120;
  if (view === "works") return fast ? FAST_WORK_LIMIT : 60;
  if (view === "search" || view === "personDetail") return fast ? 480 : 48;
  if (view === "favorites" || view === "history") return fast ? 480 : 48;
  return fast ? 160 : 40;
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
  if (currentView === "novelReader") {
    exitNovelReader();
    return;
  }
  if (!isRootNavigationView() && currentView !== "home" && window.history.state?.marker === HISTORY_MARKER && window.history.length > 1) {
    window.history.back();
    return;
  }
  applyBackState();
}

function applyBackState() {
  const previous = viewStack.pop();
  if (!previous || previous.view === "home") {
    showView(DEFAULT_VIEW, {}, { skipHistory: true, replaceHistory: true, restoreScrollY: previous?.scrollY ?? 0 });
    return;
  }
  showView(previous.view, previous.params, { skipHistory: true, replaceHistory: true, restoreScrollY: previous.scrollY ?? 0 });
}

function exitNovelReader() {
  const id = String(currentViewParams.id || "");
  if (id && !id.startsWith("local:")) {
    showView("novelDetail", { id }, { skipHistory: true, replaceHistory: true });
    return;
  }
  showView("novels", {}, { skipHistory: true, replaceHistory: true });
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
  if (view === "settings") {
    showSettings({ skipHistory: true, restoreScrollY });
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

  if (currentView === "home") {
    const task = showHome();
    return restoreAfterRender(task);
  }
  if (currentView === "settings") {
    const task = showSettings({ skipHistory: true, restoreScrollY: restoreScrollY ?? undefined });
    return restoreAfterRender(task);
  }

  els.statusCard.hidden = true;
  if (els.omniSection) els.omniSection.hidden = true;
  if (els.libraryChannelStrip) els.libraryChannelStrip.hidden = true;
  els.previewSection.hidden = true;
  els.continueSection.hidden = true;
  if (els.recentContentSection) els.recentContentSection.hidden = true;
  els.quickStrip.hidden = true;
  els.settingsPanel.hidden = true;
  els.contentPanel.hidden = false;
  syncContentPanelMode();
  els.viewBack.hidden = isRootNavigationView(currentView);
  els.viewContent.innerHTML = "";
  syncSearchSurface();
  syncFanhaoSectionNav();
  const renderGuard = beginViewRender(currentView, currentViewParams);

  if (currentView === "people") {
    return restoreAfterRender(peopleViews.renderPeopleIndex());
  }
  if (currentView === "works") {
    return restoreAfterRender(workViews.renderAllWorks(renderGuard));
  }
  if (currentView === "rankings") {
    return restoreAfterRender(workViews.renderRankings(renderGuard));
  }
  if (currentView === "favorites") {
    return restoreAfterRender(workViews.renderWorkCollection("favorites", renderGuard));
  }
  if (currentView === "history") {
    return restoreAfterRender(workViews.renderWorkCollection("history", renderGuard));
  }
  if (currentView === "search") {
    return restoreAfterRender(workViews.renderSearchResults(currentViewParams.query || "", renderGuard));
  }
  if (currentView === "personDetail") {
    return restoreAfterRender(detailViews.renderPersonDetail(currentViewParams.personId, renderGuard));
  }
  if (currentView === "workDetail") {
    return restoreAfterRender(detailViews.renderWorkDetail(currentViewParams.workId, renderGuard));
  }
  if (currentView === "channel") {
    return restoreAfterRender(channelViews.renderChannel(currentViewParams, renderGuard));
  }
  if (currentView === "photoDetail") {
    return restoreAfterRender(channelViews.renderPhotoDetail(currentViewParams.id, renderGuard));
  }
  if (currentView === "mangaDetail") {
    return restoreAfterRender(channelViews.renderMangaDetail(currentViewParams.id, renderGuard));
  }
  if (currentView === "mangaChapter") {
    return restoreAfterRender(channelViews.renderMangaChapter(currentViewParams.id, currentViewParams.chapterIndex, renderGuard));
  }
  if (currentView === "mediaDetail") {
    return restoreAfterRender(channelViews.renderMediaDetail(currentViewParams.id, currentViewParams.mode, renderGuard));
  }
  if (currentView === "novels") {
    return restoreAfterRender(novelViews.renderNovelList(renderGuard));
  }
  if (currentView === "novelDetail") {
    return restoreAfterRender(novelViews.renderNovelDetail(currentViewParams.id, renderGuard));
  }
  if (currentView === "novelReader") {
    return restoreAfterRender(novelViews.renderNovelReader(currentViewParams.id, currentViewParams.chapterIndex, renderGuard));
  }
  if (currentView === "tools") {
    return restoreAfterRender(toolViews.renderTxtTool(renderGuard));
  }
  return restoreAfterRender(undefined);
}

function renderCurrentViewPreservingScroll() {
  return renderCurrentView({ restoreScrollY: currentScrollY() });
}

function syncContentPanelMode() {
  if (!els.contentPanel) return;
  els.contentPanel.dataset.view = currentView;
  els.contentPanel.dataset.feedView = FEED_VIEWS.has(currentView) ? "true" : "false";
  els.contentPanel.dataset.channelMode = currentView === "channel" ? normalizeChannelMode(currentViewParams.mode) : "";
  document.body.classList.toggle("novel-reader-view", currentView === "novelReader");
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
  els.favoriteCount.textContent = "0";
  els.peopleCount.textContent = "0";
  if (els.worksCount) els.worksCount.textContent = "0";
  if (els.rankingsCount) els.rankingsCount.textContent = "TOP";
  syncChannelCounts(imageLibrarySummary);
  syncNovelCounts();
  els.continueSection.hidden = true;
  els.continuePreview.dataset.hasItems = "0";
  els.continuePreview.innerHTML = "";
  renderRecentContentPreview();
  els.personPreview.innerHTML = `<div class="loading-row">电脑端服务未连接，可检查地址或 29998 服务。</div>`;
}

function toggleSettings(force) {
  const shouldShow = typeof force === "boolean" ? force : currentView !== "settings";
  if (shouldShow) showSettings();
  else if (library) showView(DEFAULT_VIEW, {}, { resetStack: true });
  else showHome();
}

function isRootNavigationView(view = currentView) {
  return FANHAO_ROOT_VIEWS.has(view) || view === "channel" || view === "novels";
}

function fanhaoTabForView(view = currentView) {
  if (view === "rankings") return "rankings";
  if (view === "people" || view === "personDetail") return "people";
  if (view === "favorites") return "favorites";
  return "works";
}

function syncFanhaoSectionNav() {
  if (FANHAO_SECTION_VIEWS.has(currentView)) {
    renderTopSecondaryTabs(
      FANHAO_TOP_TABS.map((tab) => ({ ...tab, value: tab.view, dataset: { fanhaoView: tab.view } })),
      fanhaoTabForView(currentView)
    );
    return;
  }

  if (currentView === "channel" && normalizeChannelMode(currentViewParams.mode) === "tv") {
    renderTvTopCategoryTabs(currentViewParams.category || "all");
    return;
  }

  if (currentView === "channel" && normalizeChannelMode(currentViewParams.mode) === "photo") {
    renderPhotoCategoryTabs(currentViewParams.category || DEFAULT_PHOTO_CATEGORY);
    return;
  }

  hideTopSecondaryNav();
}

function hideTopSecondaryNav() {
  if (els.fanhaoSectionNav) els.fanhaoSectionNav.hidden = true;
  if (els.fanhaoSectionNav) delete els.fanhaoSectionNav.dataset.secondaryKind;
  if (els.topPrimaryLabel) els.topPrimaryLabel.hidden = false;
}

function renderTopSecondaryTabs(tabs = [], activeValue = "") {
  if (!els.fanhaoSectionNav) return;
  els.fanhaoSectionNav.dataset.secondaryKind = tabs.some((tab) => tab.dataset?.tvCategory)
    ? "tv"
    : tabs.some((tab) => tab.dataset?.photoCategory)
      ? "photo"
      : "fanhao";
  els.fanhaoSectionNav.replaceChildren(...tabs.map((tab) => createTopSecondaryButton(tab, activeValue)));
  els.fanhaoSectionNav.hidden = false;
  if (els.topPrimaryLabel) els.topPrimaryLabel.hidden = true;
}

function createTopSecondaryButton(tab, activeValue) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = tab.label;
  button.className = tab.value === activeValue ? "active" : "";
  for (const [key, value] of Object.entries(tab.dataset || {})) {
    button.dataset[key] = value;
  }
  return button;
}

function renderTvTopCategoryTabs(activeCategory = "all") {
  const categories = orderedTvTopCategories(topTvCategoryFacets);
  renderTopSecondaryTabs([
    { label: "全部", value: "all", dataset: { tvCategory: "all" } },
    ...categories.map((item) => ({ label: item.value, value: item.value, dataset: { tvCategory: item.value } }))
  ], activeCategory || "all");
}

function renderPhotoCategoryTabs(activeCategory = DEFAULT_PHOTO_CATEGORY) {
  const active = activeCategory || DEFAULT_PHOTO_CATEGORY;
  renderTopSecondaryTabs(photoTopCategoryTabs(active), active);
}

function photoTopCategoryTabs(activeCategory = DEFAULT_PHOTO_CATEGORY) {
  const seen = new Set();
  const makeTab = (value) => {
    if (!value || seen.has(value)) return null;
    seen.add(value);
    return {
      label: photoCategoryTabLabel(value),
      value,
      dataset: { photoCategory: value }
    };
  };
  const tabs = PHOTO_TOP_CATEGORY_PRIORITY.map(makeTab).filter(Boolean);
  if (activeCategory && !seen.has(activeCategory)) tabs.push(makeTab(activeCategory));
  return tabs.filter(Boolean);
}

function photoCategoryTabLabel(value) {
  return PHOTO_CATEGORY_LABELS.get(value) || photoCategoryDisplayName(value);
}

function photoCategoryDisplayName(value) {
  const text = String(value || "").trim();
  if (!text || text === "all") return "全部";
  return text.replace(/^\[[^\]]+\]\s*/, "") || text;
}

function orderedTvTopCategories(items = []) {
  const priority = new Map(TV_TOP_CATEGORY_PRIORITY.map((value, index) => [value, index]));
  return [...items]
    .filter((item) => item?.value)
    .sort((a, b) => {
      const aPriority = priority.has(a.value) ? priority.get(a.value) : 999;
      const bPriority = priority.has(b.value) ? priority.get(b.value) : 999;
      return aPriority - bPriority || Number(b.count || 0) - Number(a.count || 0) || String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: "base" });
    });
}

function setTopSecondaryTabs(kind, options = {}) {
  if (kind === "none") {
    hideTopSecondaryNav();
    return;
  }
  if (kind === "photo") {
    if (currentView === "channel" && normalizeChannelMode(currentViewParams.mode) === "photo") {
      renderPhotoCategoryTabs(options.category || currentViewParams.category || DEFAULT_PHOTO_CATEGORY);
    }
    return;
  }
  if (kind === "tv") {
    const categories = options.facets?.categories;
    if (Array.isArray(categories) && categories.length) topTvCategoryFacets = categories;
    if (currentView === "channel" && normalizeChannelMode(currentViewParams.mode) === "tv") {
      renderTvTopCategoryTabs(options.category || currentViewParams.category || "all");
    }
    return;
  }
  syncFanhaoSectionNav();
}

function bottomNavKeyFor(name = currentView, params = currentViewParams) {
  const view = String(name || currentView || "").trim();
  if (view === "channel") {
    const mode = normalizeChannelMode(params.mode);
    return mode === "manga" ? "photo" : mode;
  }
  if (view === "photo" || view === "photoDetail") return "photo";
  if (view === "manga" || view === "mangaDetail" || view === "mangaChapter") return "photo";
  if (view === "novels" || view === "novelDetail" || view === "novelReader") return "novels";
  if (view === "western" || view === "movie" || view === "tv") return view;
  if (FANHAO_SECTION_VIEWS.has(view) || view === "home" || view === "search") return "fanhao";
  return "";
}

function setActiveBottom(name = currentView) {
  const activeKey = bottomNavKeyFor(name);
  for (const button of els.bottomNav) {
    const key = button.dataset.bottomKey
      || (button.dataset.fanhaoHome !== undefined ? "fanhao" : "")
      || (button.dataset.openChannel ? normalizeChannelMode(button.dataset.openChannel) : "");
    button.classList.toggle("active", Boolean(key && key === activeKey));
  }
  if (els.topPrimaryLabel) els.topPrimaryLabel.textContent = PRIMARY_LABELS[activeKey] || "资料库";
  els.topMenuButton?.setAttribute("aria-label", currentView === "settings" ? "关闭设置" : "打开设置");
}

function syncSearchSurface() {
  const isSearch = currentView === "search";
  const isChannel = currentView === "channel";
  const expanded = isSearch || searchSurfaceExpanded || (isChannel && Boolean(currentViewParams.query));
  if (els.searchHistory) els.searchHistory.hidden = !isSearch;
  if (els.bottomNavBar) els.bottomNavBar.hidden = isSearch;
  if (els.topChannelBar) els.topChannelBar.hidden = expanded;
  if (els.searchForm) els.searchForm.hidden = !expanded;
  els.searchForm.classList.toggle("search-mode", isSearch);
  els.searchForm.classList.toggle("channel-mode", isChannel);
  document.body.classList.toggle("search-view", isSearch);
  document.body.classList.toggle("search-expanded", expanded);
  const channelLabel = isChannel ? channelViews?.channelLabel(currentViewParams.mode) : "";
  els.searchInput.placeholder = isChannel ? `搜${channelLabel || "频道"}` : "搜全库：作品/人物/频道";
  if (isChannel) {
    els.searchInput.value = currentViewParams.query || "";
    return;
  }
  if (!isSearch) {
    els.searchInput.value = "";
    if (document.activeElement === els.searchInput) els.searchInput.blur();
  }
}

workViews = createWorkViews({
  els,
  getActiveUrl: () => activeUrl,
  getWorksLimit: () => worksLimit,
  increaseWorksLimit: (amount) => {
    worksLimit += worksLimitStepForView(currentView, amount);
  },
  showView,
  openInLibrary,
  setActiveBottom,
  renderCurrentView,
  renderCurrentViewPreservingScroll,
  isHomeView: () => currentView === "home",
  renderFavoriteExtras: renderChannelFavoritesPanel
});

channelViews = createChannelViews({
  els,
  getActiveUrl: () => activeUrl,
  getChannelLimit: () => channelLimit,
  increaseChannelLimit: (amount) => {
    channelLimit += channelLimitStepForView(currentView, amount, currentViewParams);
  },
  getPhotoImageLimit: () => photoImageLimit,
  increasePhotoImageLimit: (amount) => {
    photoImageLimit += photoImageLimitStep(amount);
  },
  getMangaImageLimit: () => mangaImageLimit,
  increaseMangaImageLimit: (amount) => {
    mangaImageLimit += mangaImageLimitStep(amount);
  },
  openInLibrary,
  showPhotoDetail: (id) => showView("photoDetail", { id }, { push: true }),
  showMangaDetail: (id) => showView("mangaDetail", { id }, { push: true }),
  showMangaChapter: (id, chapterIndex) => showView("mangaChapter", { id, chapterIndex }, { push: true }),
  showMediaDetail: (id, mode) => showView("mediaDetail", { id, mode }, { push: true }),
  setActiveBottom,
  renderCurrentView,
  renderCurrentViewPreservingScroll,
  goBack,
  getMediaViewer: () => mediaViewer,
  recordRecentContent: rememberRecentContent,
  onChannelFavoriteChange: handleChannelFavoriteChange,
  setTopSecondaryTabs,
  updateChannelQuery: (query) => {
    showView("channel", { ...currentViewParams, query }, { skipHistory: true, replaceHistory: true });
  },
  updateChannelParams: (params = {}, navigation = {}) => {
    showView("channel", { ...currentViewParams, ...params }, { skipHistory: true, replaceHistory: true, ...navigation });
  }
});

toolViews = createToolViews({
  els,
  getActiveUrl: () => activeUrl,
  openInLibrary,
  setActiveBottom
});

novelViews = createNovelViews({
  els,
  getActiveUrl: () => activeUrl,
  showView,
  goBack,
  setActiveBottom,
  renderCurrentView,
  renderCurrentViewPreservingScroll,
  setStatus
});

mediaViewer = createMediaViewer();

peopleViews = createPeopleViews({
  els,
  getActiveUrl: () => activeUrl,
  getLibrary: () => library,
  getPeopleLimit: () => peopleLimit,
  increasePeopleLimit: (amount) => {
    peopleLimit += peopleLimitStep(amount);
  },
  showView,
  openInLibrary,
  setActiveBottom,
  createLoadMoreButton: workViews.createLoadMoreButton,
  renderCurrentViewPreservingScroll
});

detailViews = createDetailViews({
  els,
  getActiveUrl: () => activeUrl,
  getLibrary: () => library,
  openInLibrary,
  showView,
  setActiveBottom,
  renderWorks: workViews.renderWorks,
  renderMessage: workViews.renderMessage,
  createChip: workViews.createChip,
  mediaViewer,
  goBack,
  onUserStateChange: renderUserState
});

function runSearch(query) {
  if (currentView === "channel") {
    showView("channel", { ...currentViewParams, query: String(query || "").trim() }, { skipHistory: true, replaceHistory: true });
    return;
  }
  const navigation = currentView === "search"
    ? { skipHistory: true }
    : { resetStack: true };
  showView("search", { query }, navigation);
}

function focusSearchInput() {
  requestAnimationFrame(() => {
    els.searchInput.focus();
    els.searchInput.select?.();
  });
}

function openSearchSurface() {
  searchSurfaceExpanded = true;
  if (currentView === "channel" || currentView === "search") {
    syncSearchSurface();
    focusSearchInput();
    return;
  }
  const navigation = currentView === "home" || currentView === "settings"
    ? { resetStack: true }
    : { push: true };
  showView("search", { query: "" }, navigation);
  focusSearchInput();
}

function closeSearchSurface() {
  searchSurfaceExpanded = false;
  if (currentView === "channel") {
    if (String(currentViewParams.query || "").trim()) {
      showView("channel", { ...currentViewParams, query: "" }, { skipHistory: true, replaceHistory: true });
      return;
    }
    syncSearchSurface();
    return;
  }
  if (currentView === "search") {
    if (viewStack.length) {
      goBack();
    } else {
      showView(DEFAULT_VIEW, {}, { resetStack: true });
    }
    return;
  }
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
  if (searchSurfaceExpanded || currentView === "search") {
    closeSearchSurface();
    return true;
  }
  if (currentView === "novelReader") {
    exitNovelReader();
    return true;
  }
  if (currentView === "home" || isRootNavigationView()) return false;
  if (window.history.state?.marker === HISTORY_MARKER && window.history.length > 1) {
    window.history.back();
    return true;
  }
  applyBackState();
  return true;
};

applyTheme(themePreference);
replaceCurrentHistory();

els.settingsButton?.addEventListener("click", () => toggleSettings());
els.topMenuButton?.addEventListener("click", () => toggleSettings());
els.topSearchButton?.addEventListener("click", openSearchSurface);
els.searchCloseButton?.addEventListener("click", closeSearchSurface);
els.viewBack.addEventListener("click", goBack);

els.openLibraryButton.addEventListener("click", () => {
  els.settingsPanel.hidden = true;
  showView("people", {}, { resetStack: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
});

els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (currentView === "channel") {
    runSearch(els.searchInput.value);
    return;
  }
  searchHistory.run(els.searchInput.value);
});

els.searchInput.addEventListener("focus", () => {
  searchSurfaceExpanded = true;
  if (currentView === "search" || currentView === "channel") {
    syncSearchSurface();
    return;
  }
  const navigation = currentView === "home" || currentView === "settings"
    ? { resetStack: true }
    : { push: true };
  showView("search", { query: "" }, navigation);
  focusSearchInput();
});

els.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    updateServer(els.serverUrl.value);
    setStatus("服务地址已保存，正在刷新状态。");
    await loadDashboard();
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
  button.addEventListener("click", async () => {
    updateServer(button.dataset.url);
    await loadDashboard();
  });
}

for (const button of els.openTargets) {
  if (button.closest(".bottom-nav") || button.closest("#fanhaoSectionNav")) continue;
  button.addEventListener("click", () => {
    if (button.dataset.openView) {
      showView(button.dataset.openView, {}, { resetStack: true });
      return;
    }
    if (button.dataset.openChannel) {
      showView("channel", { mode: button.dataset.openChannel }, { resetStack: true });
      return;
    }
    openInLibrary(button.dataset.openUrl || "/");
  });
}

els.fanhaoSectionNav?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.fanhaoView) {
    const view = button.dataset.fanhaoView || DEFAULT_VIEW;
    showView(view, {}, { resetStack: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (button.dataset.tvCategory) {
    const category = button.dataset.tvCategory || "all";
    showView(
      "channel",
      {
        ...currentViewParams,
        mode: "tv",
        category: category === "all" ? "" : category,
        tvView: "series",
        seriesKey: "",
        query: ""
      },
      { skipHistory: true, replaceHistory: true }
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (button.dataset.photoCategory) {
    const category = button.dataset.photoCategory || DEFAULT_PHOTO_CATEGORY;
    const photoView = currentViewParams.collection ? "collections" : currentViewParams.photoView || "collections";
    showView(
      "channel",
      {
        ...currentViewParams,
        mode: "photo",
        photoView,
        collection: "",
        category,
        query: ""
      },
      { skipHistory: true, replaceHistory: true }
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

for (const button of els.bottomNav) {
  button.addEventListener("click", () => {
    if (button.dataset.focusSearch !== undefined) {
      searchHistory.run(els.searchInput.value);
      els.searchInput.focus();
      return;
    }
    if (button.dataset.fanhaoHome !== undefined) {
      els.settingsPanel.hidden = true;
      showView(DEFAULT_VIEW, {}, { resetStack: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (button.dataset.openView) {
      els.settingsPanel.hidden = true;
      showView(button.dataset.openView, {}, { resetStack: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (button.dataset.openChannel) {
      els.settingsPanel.hidden = true;
      showView("channel", { mode: button.dataset.openChannel }, { resetStack: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
  });
}

for (const button of els.themeButtons) {
  button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
}

updateServer(activeUrl);
updateCacheStatus();
loadDashboard();




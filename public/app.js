import { createApiClient, addQueryParam } from "./js/api.js?v=20260701-gallery-merge-01";
import { createAdminModal } from "./js/pages/admin-modal.js?v=20260701-gallery-merge-01";
import { createGalleryPage } from "./js/pages/gallery-page.js?v=20260701-gallery-merge-01";
import { createGalleryRenderer } from "./js/pages/gallery-renderer.js?v=20260701-gallery-merge-01";
import { createNovelPage } from "./js/pages/novel-page.js?v=20260701-gallery-merge-01";
import { createPeoplePage } from "./js/pages/people-page.js?v=20260701-gallery-merge-01";
import { createPersonProfile } from "./js/pages/person-profile.js?v=20260701-gallery-merge-01";
import { createRankingPage } from "./js/pages/ranking-page.js?v=20260701-gallery-merge-01";
import { createToolsPage } from "./js/pages/tools-page.js?v=20260701-gallery-merge-01";
import { createWorkDetailPage } from "./js/pages/work-detail-page.js?v=20260701-gallery-merge-01";
import { DEFAULT_GALLERY_PHOTO_CATEGORY, URL_VIEW_NAMES, normalizeRoute, routeFromUrl, routeUrl } from "./js/router.js?v=20260701-gallery-merge-01";

const state = {
  library: null,
  people: [],
  selectedPersonId: null,
  selectedPerson: null,
  works: [],
  activeView: "people",
  peopleIndexScrollTop: 0,
  personQuery: "",
  workQuery: "",
  sortMode: "title",
  filterMode: "all",
  showMissingLocalWorks: readStoredFlag("fanhao.showMissingLocalWorks", true),
  showCompilationWorks: readStoredFlag("fanhao.showCompilationWorks", false),
  uiConfig: defaultUiConfig(),
  currentWork: null,
  currentVideo: null,
  currentPlayInfo: null,
  currentStreamOffset: 0,
  progressTimer: null,
  timelineTimer: null,
  timelineAbortController: null,
  lastProgressReport: 0,
  searchReturnView: "people",
  searchTimer: null,
  searchSeq: 0,
  searchPeople: [],
  searchQuery: "",
  searchFacets: null,
  accessMode: "local",
  accessHints: {},
  workPageSize: 1000,
  workVisibleLimit: 1000,
  searchTotal: 0,
  searchLoadingMore: false,
  rankingLists: [],
  selectedRankingKey: "y2025",
  rankingTotal: 0,
  rankingMissingTotal: 0,
  rankingLocalTotal: 0,
  rankingUpdatedAt: "",
  rankingPageUrl: "",
  favoriteFolders: [],
  selectedFavoriteFolderId: "all",
  selectedHistoryRange: "30",
  personWorksTotal: 0,
  personWorksFacets: null,
  personWorksLoadingMore: false,
  personPageSize: 120,
  personVisibleLimit: 120,
  personSearchTimer: null,
  openWorkSeq: 0,
  infoRenderTimer: null,
  lastFocusedElement: null,
  adminPollTimer: null,
  handledAdminTaskIds: new Set(),
  adminTasks: [],
  adminScripts: [],
  adminScriptCategories: [],
  selectedAdminScriptId: "",
  adminScriptCategory: "all",
  txtTool: {
    fileName: "",
    fileSize: 0,
    fileBase64: "",
    text: "",
    indent: readStoredFlag("fanhao.txtTool.indent", true),
    cleanJunk: readStoredFlag("fanhao.txtTool.cleanJunk", true),
    processing: false,
    result: null,
    status: ""
  },
  gallery: {
    mode: "photo",
    photoView: "collections",
    photoCollection: null,
    query: "",
    category: DEFAULT_GALLERY_PHOTO_CATEGORY,
    subCategory: "all",
    person: "all",
    sort: "updated",
    visibleLimit: 80,
    loading: false,
    data: null,
    cache: null,
    comic: null,
    chapter: null,
    album: null,
    media: null,
    fitWidth: readStoredFlag("fanhao.gallery.fitWidth", true),
    status: ""
  },
  novel: {
    query: "",
    category: "all",
    sort: "updated",
    data: null,
    summary: null,
    book: null,
    chapters: [],
    chapter: null,
    prev: null,
    next: null,
    loading: false,
    uploading: false,
    status: "",
    catalogOpen: false,
    settingsOpen: false,
    pendingScrollRatio: 0,
    settings: null
  },
  routeReady: false,
  restoringRoute: false
};

const els = {
  productTabs: [...document.querySelectorAll("[data-product-view]")],
  topRescanButton: document.querySelector("#topRescanButton"),
  topAdminLink: document.querySelector("#topAdminLink"),
  librarySummary: document.querySelector("#librarySummary"),
  rescanButton: document.querySelector("#rescanButton"),
  adminButton: document.querySelector("#adminButton"),
  personSearch: document.querySelector("#personSearch"),
  personList: document.querySelector("#personList"),
  viewTabs: [...document.querySelectorAll(".view-tab")],
  workSearch: document.querySelector("#workSearch"),
  sortSelect: document.querySelector("#sortSelect"),
  filterSelect: document.querySelector("#filterSelect"),
  missingLocalToggle: document.querySelector("#missingLocalToggle"),
  collectionToggle: document.querySelector("#collectionToggle"),
  compilationConfigButton: document.querySelector("#compilationConfigButton"),
  personProfile: document.querySelector("#personProfile"),
  currentPath: document.querySelector("#currentPath"),
  currentTitle: document.querySelector("#currentTitle"),
  backToPeopleIndex: document.querySelector("#backToPeopleIndex"),
  statsRow: document.querySelector("#statsRow"),
  workGrid: document.querySelector("#workGrid"),
  drawerBackdrop: document.querySelector("#drawerBackdrop"),
  detailDrawer: document.querySelector("#detailDrawer"),
  closeDrawer: document.querySelector("#closeDrawer"),
  drawerPath: document.querySelector("#drawerPath"),
  drawerTitle: document.querySelector("#drawerTitle"),
  playerArea: document.querySelector("#playerArea"),
  drawerSide: document.querySelector(".drawer-side"),
  metaArea: document.querySelector("#metaArea"),
  infoArea: document.querySelector("#infoArea"),
  placeholderTemplate: document.querySelector("#placeholderTemplate"),
  adminBackdrop: document.querySelector("#adminBackdrop"),
  adminModal: document.querySelector("#adminModal"),
  closeAdmin: document.querySelector("#closeAdmin"),
  adminPersonSelect: document.querySelector("#adminPersonSelect"),
  adminRescanPerson: document.querySelector("#adminRescanPerson"),
  adminRefreshActor: document.querySelector("#adminRefreshActor"),
  adminRefreshRankings: document.querySelector("#adminRefreshRankings"),
  adminActorAvatarDataPath: document.querySelector("#adminActorAvatarDataPath"),
  adminPreviewActorAvatars: document.querySelector("#adminPreviewActorAvatars"),
  adminImportActorAvatars: document.querySelector("#adminImportActorAvatars"),
  adminActorAvatarCandidates: document.querySelector("#adminActorAvatarCandidates"),
  adminCoverLimit: document.querySelector("#adminCoverLimit"),
  adminGenerateCovers: document.querySelector("#adminGenerateCovers"),
  adminCoverStatus: document.querySelector("#adminCoverStatus"),
  adminCompilationPrefixes: document.querySelector("#adminCompilationPrefixes"),
  adminCompilationKeywords: document.querySelector("#adminCompilationKeywords"),
  adminSaveCompilationConfig: document.querySelector("#adminSaveCompilationConfig"),
  adminCompilationSection: document.querySelector("#adminCompilationSection"),
  adminConfigStatus: document.querySelector("#adminConfigStatus"),
  adminStatus: document.querySelector("#adminStatus"),
  adminTaskList: document.querySelector("#adminTaskList"),
  adminScriptCount: document.querySelector("#adminScriptCount"),
  adminRunningCount: document.querySelector("#adminRunningCount"),
  adminDoneCount: document.querySelector("#adminDoneCount"),
  adminErrorCount: document.querySelector("#adminErrorCount"),
  adminScriptCategory: document.querySelector("#adminScriptCategory"),
  adminRefreshScripts: document.querySelector("#adminRefreshScripts"),
  adminScriptList: document.querySelector("#adminScriptList"),
  adminScriptForm: document.querySelector("#adminScriptForm"),
  adminSelectedScriptCategory: document.querySelector("#adminSelectedScriptCategory"),
  adminSelectedScriptTitle: document.querySelector("#adminSelectedScriptTitle"),
  adminSelectedScriptRuntime: document.querySelector("#adminSelectedScriptRuntime"),
  adminSelectedScriptDescription: document.querySelector("#adminSelectedScriptDescription"),
  adminScriptFields: document.querySelector("#adminScriptFields"),
  adminRunScript: document.querySelector("#adminRunScript"),
  adminScriptStatus: document.querySelector("#adminScriptStatus")
};

const formatter = new Intl.NumberFormat("zh-CN");
let workRenderTimer = null;
let workRenderSeq = 0;
let workLoadMoreObserver = null;
let workLoadMoreScrollCleanup = null;
let coverLoadQueue = [];
let coverLoadTimer = null;
let coverLoadObserver = null;
const WORK_RENDER_INITIAL_COUNT = 96;
const WORK_RENDER_BATCH_SIZE = 96;
const WORK_RENDER_BATCH_DELAY = 16;
const WORK_AUTO_LOAD_ROOT_MARGIN = "0px 0px 1400px 0px";
const WORK_AUTO_LOAD_DISTANCE = 1400;
const WORK_AUTO_LOAD_RECHECK_DELAYS = [120, 480, 900];
const COVER_LOAD_BATCH_SIZE = 16;
const COVER_LOAD_BATCH_DELAY = 45;
const COVER_EAGER_COUNT = 48;
const COVER_HIGH_PRIORITY_COUNT = 24;
const COVER_OBSERVER_ROOT_MARGIN = "900px 0px";
const COVER_RETRY_DELAYS = [700, 1400, 2400, 4000, 6500, 9000];
const initialParams = new URLSearchParams(window.location.search);
const isAndroidClient = initialParams.get("client") === "android";
const api = createApiClient({ isAndroidClient });
const TXT_TOOL_MAX_FILE_BYTES = 24 * 1024 * 1024;
const HISTORY_RANGE_OPTIONS = [
  { value: "30", label: "30 天" },
  { value: "7", label: "7 天" },
  { value: "all", label: "全部" }
];
const peoplePage = createPeoplePage({
  api,
  appendEmpty,
  cancelScheduledWorkRendering,
  clearWorkFilter,
  clearWorkSearch,
  closeDrawer,
  coverUrl,
  createInfoChip,
  currentPageScrollTop,
  displayPersonName,
  els,
  formatLibraryPaths,
  formatNumber,
  hidePersonProfile,
  includesText,
  personSearchText,
  renderPersonProfile,
  renderPersonWorkStats,
  renderWorks,
  resetProgressiveCoverLoading,
  resetWorkPaging,
  restorePageScrollTop,
  setMainHeader,
  state,
  syncNavigationState,
  syncRouteAfterNavigation
});
const personProfilePage = createPersonProfile({
  api,
  coverUrl,
  els,
  formatLibraryPath,
  formatLibraryPaths,
  formatNumber,
  linesFromTextarea,
  normalizeSourcePath,
  renderPeople,
  selectPerson,
  sourcePriority,
  state
});
let novelPage = null;
const adminModal = createAdminModal({
  api,
  displayPersonName,
  els,
  formatBytes,
  formatDateTime,
  formatNumber,
  linesFromTextarea,
  loadFavorites,
  loadHistory,
  loadImageLibrary,
  loadLibrary,
  loadNovels: (options = {}) => novelPage?.loadNovels?.(options),
  loadRankings,
  normalizeUiConfig,
  personWorkPageSize,
  renderMeta,
  renderPeopleIndex,
  renderPeopleIndexStats,
  renderPlayer,
  renderWorks,
  resetWorkPaging,
  selectPerson,
  state,
  updateWorkSnapshot
});
const toolsPage = createToolsPage({
  api,
  cancelScheduledWorkRendering,
  disconnectPeopleIndexAutoload,
  els,
  formatBytes,
  formatDateTime,
  formatNumber,
  resetProgressiveCoverLoading,
  state,
  toastInline,
  txtToolMaxFileBytes: TXT_TOOL_MAX_FILE_BYTES,
  writeStoredFlag
});
novelPage = createNovelPage({
  api,
  cancelScheduledWorkRendering,
  disconnectPeopleIndexAutoload,
  els,
  formatBytes,
  formatDateTime,
  formatNumber,
  hidePersonProfile,
  openAdminScript,
  pushRoute,
  replaceRoute,
  resetProgressiveCoverLoading,
  setMainHeader,
  state,
  syncRouteAfterNavigation
});
const galleryPage = createGalleryPage({
  api,
  clearPersonSelection: () => {
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
  },
  els,
  formatDateTime,
  galleryModeLabel,
  hidePersonProfile,
  normalizeUiConfig,
  pushRoute,
  renderGalleryStats,
  renderGalleryView,
  replaceRoute,
  setMainHeader,
  state,
  syncRouteAfterNavigation
});
const galleryRenderer = createGalleryRenderer({
  api,
  cancelScheduledWorkRendering,
  disconnectPeopleIndexAutoload,
  els,
  formatBytes,
  formatDateTime,
  formatNumber,
  getGalleryPage: () => galleryPage,
  includesText,
  normalizeUiConfig,
  openAdminScript,
  resetProgressiveCoverLoading,
  setAdminBusy: adminModal.setBusy,
  state,
  writeStoredFlag
});
const rankingPage = createRankingPage({
  adminRefreshRankings: adminModal.refreshRankings,
  api,
  clearPersonSelection: () => {
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
  },
  clearWorkFilter,
  els,
  formatDate,
  formatNumber,
  hidePersonProfile,
  renderEmpty,
  renderWorks,
  resetWorkPaging,
  setMainHeader,
  state,
  syncRouteAfterNavigation,
  visibleWorks
});
const workDetailPage = createWorkDetailPage({
  addQueryParam,
  api,
  coverRetryDelays: COVER_RETRY_DELAYS,
  els,
  formatBytes,
  formatLibraryPath,
  formatTime,
  goToPerson,
  openWorkCard,
  renderFavoriteFolderControls,
  renderStatsForWorks,
  renderSummary,
  renderWorks,
  retryCoverUrl,
  state,
  syncRouteAfterNavigation,
  workCoverUrl,
  workPersonDisplayName
});
document.documentElement.classList.toggle("android-client", isAndroidClient);

function readStoredFlag(key, fallback = false) {
  try {
    const value = window.localStorage?.getItem(key);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {}
  return fallback;
}

function writeStoredFlag(key, value) {
  try {
    window.localStorage?.setItem(key, value ? "1" : "0");
  } catch {}
}

function defaultUiConfig() {
  return {
    compilationPrefixes: ["OFJE", "THN", "THU"],
    compilationKeywords: ["合集", "総集編", "総集", "コンプリート", "全タイトル", "ベスト盤"],
    actorAvatarDataPath: "",
    imageReaderCacheMaxBytes: 2 * 1024 * 1024 * 1024
  };
}

function normalizeCompilationPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/[-_\s]+$/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function uniqueConfigLines(values, options = {}) {
  const seen = new Set();
  const result = [];
  const transform = options.transform || ((value) => String(value || "").trim());
  for (const value of Array.isArray(values) ? values : []) {
    const item = transform(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result.slice(0, options.maxItems || 100);
}

function normalizeUiConfig(config = {}) {
  const fallback = defaultUiConfig();
  const input = config && typeof config === "object" ? config : {};
  const prefixes = uniqueConfigLines(input.compilationPrefixes, {
    maxItems: 80,
    transform: normalizeCompilationPrefix
  });
  const keywords = uniqueConfigLines(input.compilationKeywords, { maxItems: 120 });
  return {
    compilationPrefixes: prefixes.length ? prefixes : fallback.compilationPrefixes,
    compilationKeywords: keywords.length ? keywords : fallback.compilationKeywords,
    actorAvatarDataPath: String(input.actorAvatarDataPath || "").trim(),
    imageReaderCacheMaxBytes: normalizeCacheBytes(input.imageReaderCacheMaxBytes, fallback.imageReaderCacheMaxBytes)
  };
}

function normalizeCacheBytes(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return 0;
  return Math.max(128 * 1024 * 1024, Math.min(200 * 1024 * 1024 * 1024, Math.floor(parsed)));
}

function linesFromTextarea(value) {
  return String(value || "")
    .split(/\r?\n|[,，、;]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentPageScrollTop() {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function restorePageScrollTop(top) {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: Math.max(0, Number(top) || 0), left: 0, behavior: "auto" });
  });
}

function currentRouteSnapshot(overrides = {}) {
  const drawerOpen = els.detailDrawer?.classList.contains("open");
  const route = {
    view: state.activeView || "people",
    galleryMode: state.activeView === "gallery" ? state.gallery.mode || "photo" : "",
    galleryPhotoView: state.activeView === "gallery" ? state.gallery.photoView || "collections" : "",
    galleryPhotoCollection: state.activeView === "gallery" ? state.gallery.photoCollection || "" : "",
    galleryAlbumId: state.activeView === "gallery" ? state.gallery.album?.id || "" : "",
    galleryComicId: state.activeView === "gallery" ? state.gallery.comic?.id || "" : "",
    galleryChapterIndex: state.activeView === "gallery" ? state.gallery.chapter?.index || "" : "",
    galleryMediaId: state.activeView === "gallery" ? state.gallery.media?.id || "" : "",
    galleryQuery: state.activeView === "gallery" ? state.gallery.query || "" : "",
    galleryCategory: state.activeView === "gallery" ? state.gallery.category || "all" : "all",
    gallerySubCategory: state.activeView === "gallery" ? state.gallery.subCategory || "all" : "all",
    galleryPerson: state.activeView === "gallery" ? state.gallery.person || "all" : "all",
    gallerySort: state.activeView === "gallery" ? state.gallery.sort || "updated" : "updated",
    novelBookId: state.activeView === "novels" ? state.novel.chapter?.bookId || state.novel.book?.id || "" : "",
    novelChapterIndex: state.activeView === "novels" ? String(state.novel.chapter?.index || "") : "",
    novelQuery: state.activeView === "novels" ? state.novel.query || "" : "",
    novelCategory: state.activeView === "novels" ? state.novel.category || "all" : "all",
    novelSort: state.activeView === "novels" ? state.novel.sort || "updated" : "updated",
    personId: state.activeView === "people" ? state.selectedPersonId || "" : "",
    q: state.activeView === "search" ? state.searchQuery || state.workQuery || "" : "",
    workId: drawerOpen ? state.currentWork?.id || "" : "",
    videoId: drawerOpen ? state.currentVideo?.id || "" : ""
  };
  return normalizeRoute({ ...route, ...overrides });
}

function writeRoute(route, mode = "push") {
  if (!state.routeReady || state.restoringRoute || !window.history?.pushState) return;
  const next = normalizeRoute(route);
  const url = routeUrl(next, { initialParams });
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash || ""}`;
  const historyState = { fanhaoRoute: true, ...next };
  if (mode === "replace" || url === currentUrl) {
    window.history.replaceState(historyState, "", url);
    return;
  }
  window.history.pushState(historyState, "", url);
}

function pushRoute(overrides = {}) {
  writeRoute(currentRouteSnapshot(overrides), "push");
}

function replaceRoute(overrides = {}) {
  writeRoute(currentRouteSnapshot(overrides), "replace");
}

function syncRouteAfterNavigation(options = {}) {
  if (options.skipRoute) return;
  const overrides = options.routeOverrides || {};
  if (options.replaceRoute) {
    replaceRoute(overrides);
  } else {
    pushRoute(overrides);
  }
}

function initializeRouteHistory() {
  if (state.routeReady) return;
  state.routeReady = true;
  replaceRoute();
}

function applyGalleryRouteState(route) {
  galleryPage.applyRouteState(route);
}

async function openGalleryRouteTarget(route) {
  await galleryPage.openRouteTarget(route);
}

async function applyRoute(route) {
  const next = normalizeRoute(route);
  state.restoringRoute = true;
  try {
    if (!next.workId && els.detailDrawer.classList.contains("open")) {
      closeDrawer({ skipRoute: true });
    }

    if (next.view === "search") {
      state.workQuery = next.q;
      els.workSearch.value = next.q;
      await loadSearchResults(next.q, { skipRoute: true });
    } else if (next.view === "people") {
      clearWorkSearch();
      if (next.personId && state.people.some((person) => person.id === next.personId)) {
        await selectPerson(next.personId, { resetFilter: false, captureIndexScroll: false, skipRoute: true });
      } else {
        showPeopleIndex({ restoreScroll: true, skipRoute: true });
      }
    } else if (next.view === "gallery") {
      clearWorkSearch();
      applyGalleryRouteState(next);
      setActiveView("gallery", { skipRoute: true });
      await openGalleryRouteTarget(next);
    } else if (next.view === "novels") {
      clearWorkSearch();
      novelPage.applyRouteState(next);
      setActiveView("novels", { skipRoute: true });
      await novelPage.openRouteTarget(next);
    } else {
      clearWorkSearch();
      setActiveView(next.view, { skipRoute: true });
    }

    if (next.workId) {
      await openWork(next.workId, next.videoId || null, { skipRoute: true });
    }
  } finally {
    state.restoringRoute = false;
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.getRegistrations?.().then((registrations) => {
      for (const registration of registrations) registration.unregister().catch(() => {});
    }).catch(() => {});
  });
}

if ("caches" in window) {
  window.addEventListener("load", () => {
    caches.keys().then((names) => {
      for (const name of names) {
        if (name.startsWith("fanhao-shell-")) caches.delete(name).catch(() => {});
      }
    }).catch(() => {});
  });
}

function installAndroidClientReturn() {
  if (!isAndroidClient) return;
  if (document.querySelector(".android-client-return")) return;

  const returnTo = safeAndroidReturnUrl(initialParams.get("returnTo"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "android-client-return";
  button.textContent = "‹ 返回客户端";
  button.setAttribute("aria-label", "返回客户端首页");

  let returning = false;
  const returnToClient = () => {
    if (returning) return;
    returning = true;
    button.textContent = "正在返回";

    if (returnTo) {
      fallbackReturnToClient(returnTo);
      return;
    }

    if (window.history.length > 1) {
      const currentUrl = window.location.href;
      window.history.back();
      window.setTimeout(() => {
        if (window.location.href === currentUrl && !document.hidden) {
          fallbackReturnToClient(returnTo);
        }
      }, 700);
      return;
    }

    fallbackReturnToClient(returnTo);
  };

  button.addEventListener("click", returnToClient);
  button.addEventListener(
    "touchend",
    (event) => {
      event.preventDefault();
      returnToClient();
    },
    { passive: false }
  );
  document.body.append(button);
}

function fallbackReturnToClient(returnTo) {
  const target = returnTo || "capacitor://localhost/";
  try {
    window.location.replace(target);
  } catch {
    window.location.href = target;
  }
}

function safeAndroidReturnUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "capacitor:") return url.toString();
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if ((url.protocol === "http:" || url.protocol === "https:") && localHosts.has(url.hostname)) {
      return url.toString();
    }
  } catch {
    return "";
  }
  return "";
}

function formatNumber(value) {
  return formatter.format(value || 0);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function includesText(value, query) {
  return String(value || "").toLowerCase().includes(query.trim().toLowerCase());
}

function displayPersonName(person) {
  return person?.actorProfile?.displayName || person?.name || "";
}

function personSearchText(person) {
  return [
    person?.name,
    person?.actorProfile?.displayName,
    person?.actorProfile?.personName,
    ...(person?.actorProfile?.aliases || [])
  ].filter(Boolean).join("\n");
}

function workPersonDisplayName(work) {
  return work?.personDisplayName || work?.personName || "";
}

function workPersonSearchText(work) {
  return [
    work?.personName,
    work?.personDisplayName,
    ...(work?.personAliases || [])
  ].filter(Boolean).join("\n");
}

function workInfoSearchText(work) {
  const info = work?.infoSummary || {};
  return [
    info.code,
    info.title,
    info.director,
    info.maker,
    info.label,
    info.series,
    ...(info.actors || []),
    ...(info.tags || [])
  ].filter(Boolean).join("\n");
}

function coverUrl(coverId) {
  return coverId ? `/media/image/${encodeURIComponent(coverId)}` : "";
}

function workCoverUrl(work) {
  return coverUrl(work.coverId) || work.cachedCover?.coverUrl || work.remoteCoverUrl || work.infoSummary?.imageUrl || "";
}

function formatLibraryPath(value) {
  if (!value) return "";
  const normalized = String(value).replaceAll("/", "\\");
  return /^[A-Za-z]:\\?/.test(normalized) ? normalized : `G:\\${normalized}`;
}

function formatLibraryPaths(values) {
  const paths = (values || []).filter(Boolean).map(formatLibraryPath);
  return paths.length ? paths.join(" · ") : "G:\\ / F:\\ / O:\\ / V:\\";
}

async function loadLibrary(options = {}) {
  els.librarySummary.textContent = "正在读取索引";
  const data = await api("/api/library");
  state.library = data;
  state.accessMode = data.access?.mode || "local";
  state.accessHints = data.access?.hints || {};
  state.uiConfig = normalizeUiConfig(data.uiConfig || state.uiConfig);
  if (els.adminButton) els.adminButton.hidden = state.accessMode !== "local";
  if (els.topAdminLink) els.topAdminLink.hidden = state.accessMode !== "local";
  if (els.topRescanButton) els.topRescanButton.hidden = state.accessMode !== "local";
  if (els.missingLocalToggle) els.missingLocalToggle.checked = state.showMissingLocalWorks;
  if (els.collectionToggle) els.collectionToggle.checked = state.showCompilationWorks;
  state.workPageSize = Number(state.accessHints.workPageSize) || (state.accessMode === "remote" ? 80 : 1000);
  state.personPageSize = state.accessMode === "lan" ? 80 : 96;
  resetWorkPaging();
  state.people = sortPeopleForList(data.people || []);
  resetPersonPaging();

  if (state.selectedPersonId && !state.people.some((person) => person.id === state.selectedPersonId)) {
    state.selectedPersonId = null;
  }

  renderSummary();
  if (options.deferMainRender) {
    renderPeople();
  } else {
    setActiveView(state.activeView || "people");
  }
}

function normalizeSourcePath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function sourcePriority(value) {
  const sourcePath = normalizeSourcePath(value);
  if (sourcePath.startsWith("g:/")) return 0;
  if (sourcePath.startsWith("f:/")) return 1;
  if (sourcePath === "o:/[珍藏]" || sourcePath.startsWith("o:/[珍藏]/")) return 2;
  if (sourcePath === "o:/[珍藏1]" || sourcePath.startsWith("o:/[珍藏1]/")) return 3;
  if (sourcePath === "o:/[稀有]" || sourcePath.startsWith("o:/[稀有]/")) return 4;
  if (sourcePath === "o:/[动漫]" || sourcePath.startsWith("o:/[动漫]/")) return 5;
  if (sourcePath.startsWith("o:/")) return 6;
  if (sourcePath === "v:/[a]" || sourcePath.startsWith("v:/[a]/")) return 7;
  if (sourcePath === "v:/[a1]" || sourcePath.startsWith("v:/[a1]/")) return 8;
  if (sourcePath === "v:/av" || sourcePath.startsWith("v:/av/")) return 9;
  if (sourcePath.startsWith("v:/")) return 10;
  return 11;
}

function personSourcePriority(person) {
  const paths = [...(person.sourcePaths || []), person.relativePath].filter(Boolean);
  if (!paths.length) return 9;
  return Math.min(...paths.map(sourcePriority));
}

function sortPeopleForList(people) {
  return [...people].sort((a, b) => {
    const priority = personSourcePriority(a) - personSourcePriority(b);
    if (priority) return priority;
    return displayPersonName(a).localeCompare(displayPersonName(b), undefined, { numeric: true, sensitivity: "base" });
  });
}

function renderSummary() {
  const totals = state.library?.totals || {};
  const rootCount = state.library?.availableRoots?.length || 0;
  const favoriteCount = state.library?.user?.favoriteCount || 0;
  const mode = state.accessMode === "lan" ? "局域网" : "本机";
  els.librarySummary.textContent = `${mode} · ${formatNumber(rootCount)} 盘 · ${formatNumber(totals.people)} 人 · ${formatNumber(totals.videos)} 视频 · ${formatNumber(favoriteCount)} 收藏`;
}

function productViewForActiveView(view = state.activeView) {
  if (view === "gallery") return "gallery";
  if (view === "novels") return "novels";
  if (view === "tools") return "tools";
  return "people";
}

function productButtonActive(button, view = state.activeView) {
  const productView = button.dataset.productView || "people";
  if (productView === "gallery") {
    const mode = button.dataset.galleryMode || "photo";
    if (mode === "photo") return view === "gallery" && ["photo", "manga"].includes(state.gallery.mode);
    if (mode === "media") return view === "gallery" && ["media", "movie", "tv"].includes(state.gallery.mode);
    return view === "gallery" && mode === state.gallery.mode;
  }
  return productViewForActiveView(view) === productView;
}

function syncNavigationState(view = state.activeView) {
  for (const button of els.productTabs || []) {
    const active = productButtonActive(button, view);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const button of els.viewTabs || []) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function setActiveView(view, options = {}) {
  view = URL_VIEW_NAMES.has(view) ? view : "people";
  state.activeView = view;
  if (view !== "rankings" && state.sortMode === "ranking") {
    state.sortMode = "title";
    els.sortSelect.value = "title";
  }
  if (view !== "search") {
    state.searchPeople = [];
    state.searchQuery = "";
    state.searchFacets = null;
    state.searchTotal = 0;
  }
  syncNavigationState(view);
  updateActivePersonButton();

  if (view === "favorites") {
    loadFavorites();
    syncRouteAfterNavigation(options);
    return;
  }

  if (view === "history") {
    loadHistory();
    syncRouteAfterNavigation(options);
    return;
  }

  if (view === "rankings") {
    rankingPage.enter(options);
    return;
  }

  if (view === "gallery") {
    galleryPage.enter(options);
    return;
  }

  if (view === "novels") {
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    novelPage.enter(options);
    return;
  }

  if (view === "tools") {
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    hidePersonProfile();
    setMainHeader("小工具", "离线小游戏 / TXT 文档处理");
    toolsPage.renderStats();
    toolsPage.renderView();
    syncRouteAfterNavigation(options);
    return;
  }

  showPeopleIndex({ skipRoute: true });
  syncRouteAfterNavigation(options);
}

function renderPeople() {
  peoplePage.renderPeople();
}

function updateActivePersonButton() {
  peoplePage.updateActivePersonButton();
}

function showPeopleIndex(options = {}) {
  peoplePage.showIndex(options);
}

function renderPeopleIndexStats() {
  peoplePage.renderIndexStats();
}

function renderPeopleIndex() {
  peoplePage.renderIndex();
}

function disconnectPeopleIndexAutoload() {
  peoplePage.disconnectIndexAutoload();
}

async function selectPerson(personId, options = {}) {
  await peoplePage.selectPerson(personId, options);
}

function personWorkPageSize() {
  return peoplePage.personWorkPageSize();
}

async function fetchPersonWorksPage(personId, offset = 0) {
  return peoplePage.fetchPersonWorksPage(personId, offset);
}

async function goToPerson(personId) {
  await peoplePage.goToPerson(personId);
}


async function loadFavorites() {
  els.workGrid.innerHTML = `<div class="empty-state">正在加载收藏</div>`;
  const params = new URLSearchParams();
  if (state.selectedFavoriteFolderId && state.selectedFavoriteFolderId !== "all") {
    params.set("folder", state.selectedFavoriteFolderId);
  }
  const query = params.toString();
  const data = await api(`/api/favorites${query ? `?${query}` : ""}`);
  state.selectedPerson = null;
  state.searchPeople = [];
  state.personWorksTotal = 0;
  state.personWorksFacets = null;
  hidePersonProfile();
  state.works = data.works || [];
  state.favoriteFolders = data.folders || [];
  state.selectedFavoriteFolderId = data.selectedFolderId || state.selectedFavoriteFolderId || "all";
  resetWorkPaging();
  const folder = favoriteFolderById(state.selectedFavoriteFolderId);
  setMainHeader("收藏", folder ? `${folder.name} · ${formatNumber(folder.count || 0)} 部` : "已收藏的作品");
  renderStatsForWorks(state.works);
  renderFavoriteFolderControls();
  renderWorks("还没有收藏。");
}

function favoriteFolderById(folderId) {
  return (state.favoriteFolders || []).find((folder) => folder.id === folderId) || null;
}

function favoriteFolderTotal() {
  return (state.favoriteFolders || []).reduce((sum, folder) => sum + Number(folder.count || 0), 0);
}

function renderFavoriteFolderControls() {
  if (state.activeView !== "favorites") return;
  const folders = state.favoriteFolders || [];
  const wrap = document.createElement("div");
  wrap.className = "stat-quick-filters favorite-folder-controls";

  const group = document.createElement("div");
  group.className = "stat-filter-group";
  const heading = document.createElement("span");
  heading.className = "stat-filter-label";
  heading.textContent = "收藏夹";
  group.append(heading);

  const allButton = createFavoriteFolderFilterButton("all", "全部", favoriteFolderTotal());
  group.append(allButton);
  for (const folder of folders) {
    group.append(createFavoriteFolderFilterButton(folder.id, folder.name, folder.count || 0));
  }

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "stat-filter-chip";
  addButton.textContent = "新建";
  addButton.addEventListener("click", createFavoriteFolder);

  wrap.append(group, addButton);
  els.statsRow.append(wrap);
}

function createFavoriteFolderFilterButton(folderId, name, count) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `stat-filter-chip${state.selectedFavoriteFolderId === folderId ? " active" : ""}`;
  button.textContent = `${name} ${formatNumber(count || 0)}`;
  button.addEventListener("click", () => {
    if (state.selectedFavoriteFolderId === folderId) return;
    state.selectedFavoriteFolderId = folderId;
    loadFavorites();
  });
  return button;
}

async function createFavoriteFolder() {
  const name = window.prompt("新收藏夹名称");
  if (!name || !name.trim()) return;
  try {
    const data = await api("/api/favorite-folders", { method: "POST", body: { name } });
    state.favoriteFolders = data.folders || state.favoriteFolders;
    await loadFavorites();
  } catch (error) {
    alert(error.message);
  }
}

async function loadHistory() {
  els.workGrid.innerHTML = `<div class="empty-state">正在加载观看记录</div>`;
  const data = await api(historyPath());
  state.selectedPerson = null;
  state.searchPeople = [];
  state.personWorksTotal = 0;
  state.personWorksFacets = null;
  hidePersonProfile();
  state.works = data.works || [];
  resetWorkPaging();
  const rangeLabel = historyRangeLabel(state.selectedHistoryRange);
  const total = data.total ?? data.count ?? state.works.length;
  setMainHeader("继续观看", state.selectedHistoryRange === "all" ? "全部有播放进度的作品" : `${rangeLabel}有播放进度的作品 · ${formatNumber(total)} 部`);
  renderStatsForWorks(state.works);
  renderHistoryRangeControls(data);
  renderWorks("暂无观看记录。");
}

function historyPath() {
  const params = new URLSearchParams();
  if (state.selectedHistoryRange && state.selectedHistoryRange !== "all") {
    params.set("days", state.selectedHistoryRange);
  }
  const query = params.toString();
  return `/api/history${query ? `?${query}` : ""}`;
}

function historyRangeLabel(value) {
  return HISTORY_RANGE_OPTIONS.find((item) => item.value === value)?.label || "30 天";
}

function renderHistoryRangeControls(data = {}) {
  if (state.activeView !== "history") return;
  const wrap = document.createElement("div");
  wrap.className = "stat-quick-filters history-range-controls";

  const group = document.createElement("div");
  group.className = "stat-filter-group";
  const heading = document.createElement("span");
  heading.className = "stat-filter-label";
  heading.textContent = "最近观看";
  group.append(heading);

  for (const option of HISTORY_RANGE_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat-filter-chip${state.selectedHistoryRange === option.value ? " active" : ""}`;
    button.textContent = option.value === state.selectedHistoryRange ? `${option.label} ${formatNumber(data.total ?? state.works.length)}` : option.label;
    button.addEventListener("click", () => {
      if (state.selectedHistoryRange === option.value) return;
      state.selectedHistoryRange = option.value;
      loadHistory();
    });
    group.append(button);
  }

  wrap.append(group);
  els.statsRow.append(wrap);
}

async function loadRankings() {
  await rankingPage.loadRankings();
}

async function loadRankingWorks() {
  await rankingPage.loadRankingWorks();
}

function renderRankingStats(data = {}) {
  rankingPage.renderStats(data);
}

function setMainHeader(title, pathText) {
  els.currentTitle.textContent = title;
  els.currentPath.textContent = pathText;
  updateBackToPeopleIndexButton();
}

function updateBackToPeopleIndexButton() {
  const productView = productViewForActiveView();
  document.body.classList.toggle("fanhao-view", productView === "people");
  document.body.classList.toggle("person-detail-view", state.activeView === "people" && Boolean(state.selectedPersonId));
  document.body.classList.toggle("tools-view", state.activeView === "tools");
  document.body.classList.toggle("gallery-view", state.activeView === "gallery");
  document.body.classList.toggle("novel-view", state.activeView === "novels");
  document.body.classList.toggle("novel-reader-active", state.activeView === "novels" && Boolean(state.novel?.chapter));
  syncNavigationState();
  if (!els.backToPeopleIndex) return;
  els.backToPeopleIndex.hidden = true;
}

function returnToPeopleIndex() {
  clearWorkSearch();
  showPeopleIndex({ restoreScroll: true });
}

function hidePersonProfile() {
  personProfilePage.hide();
}

function renderPersonProfile(person) {
  personProfilePage.render(person);
}

function createStatCard(label, value) {
  const stat = document.createElement("div");
  stat.className = "stat";
  const number = document.createElement("strong");
  number.textContent = formatNumber(value);
  const caption = document.createElement("span");
  caption.textContent = label;
  stat.append(number, caption);
  return stat;
}

function renderStatsForWorks(works, person = null) {
  const hasActorCache = person
    ? (person.actorMovieCount ?? person.actorProfile?.movieCount ?? 0) > 0 || Boolean(person.actorProfile?.javdbUrl)
    : false;
  const stats = person
    ? hasActorCache
      ? [
          ["本地作品", person.workCount],
          ["视频", person.videoCount],
          ["JavDB作品", person.actorMovieCount ?? person.actorProfile?.movieCount ?? 0],
          ["未下载", person.missingLocalWorkCount ?? works.filter((work) => work.missingLocal).length]
        ]
      : [
          ["作品", person.workCount],
          ["视频", person.videoCount],
          ["可网页播放", person.playableCount],
          ["资料", person.infoCount]
        ]
    : [
        ["作品", works.length],
        ["视频", works.reduce((sum, work) => sum + work.videoCount, 0)],
        ["可网页播放", works.reduce((sum, work) => sum + work.playableCount, 0)],
        ["有进度", works.filter((work) => work.progress).length]
      ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    els.statsRow.append(createStatCard(label, value));
  }
  appendMetadataQuickFilters(works);
}

function renderSearchStats() {
  const facets = state.searchFacets || {};
  const stats = [
    ["搜索命中", facets.all ?? state.searchTotal],
    [searchFilterLabel(), state.searchTotal],
    ["已显示", searchVisibleCount()],
    ["本地", facets.localOnly ?? state.works.filter((work) => !work.missingLocal).length],
    ["未下载", facets.missingLocal ?? state.works.filter((work) => work.missingLocal).length]
  ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    els.statsRow.append(createStatCard(label, value));
  }
  appendMetadataQuickFilters(state.works);
}

function searchFilterLabel() {
  const option = els.filterSelect?.selectedOptions?.[0];
  if (!option || state.filterMode === "all") return "当前筛选";
  return `${option.textContent || "当前"}结果`;
}

function searchVisibleCount() {
  return Math.min(visibleWorks().length, state.workVisibleLimit);
}

function renderPersonWorkStats() {
  const person = state.selectedPerson;
  if (!person) {
    renderStatsForWorks(state.works);
    return;
  }

  const facets = state.personWorksFacets || {};
  const stats = [
    ["人物作品", facets.all ?? person.workCount ?? state.personWorksTotal],
    [searchFilterLabel(), state.personWorksTotal || state.works.length],
    ["已显示", searchVisibleCount()],
    ["本地", facets.localOnly ?? state.works.filter((work) => !work.missingLocal).length],
    ["未下载", facets.missingLocal ?? person.missingLocalWorkCount ?? state.works.filter((work) => work.missingLocal).length],
    ["有评分", facets.rated ?? state.works.filter((work) => numericRating(work.infoSummary?.rating) !== null).length]
  ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    els.statsRow.append(createStatCard(label, value));
  }
  appendMetadataQuickFilters(state.works);
}

function appendMetadataQuickFilters(works) {
  const groups = [
    ["类别", topInfoValues(works, (info) => info.tags, 8)],
    ["片商", topInfoValues(works, (info) => [info.maker, info.label], 6)],
    ["系列", topInfoValues(works, (info) => info.series, 4)]
  ].filter(([, items]) => items.length);

  if (!groups.length) return;

  const wrap = document.createElement("div");
  wrap.className = "stat-quick-filters";

  for (const [label, items] of groups) {
    const group = document.createElement("div");
    group.className = "stat-filter-group";
    const heading = document.createElement("span");
    heading.className = "stat-filter-label";
    heading.textContent = label;
    group.append(heading);

    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stat-filter-chip";
      button.textContent = `${item.value} ${formatNumber(item.count)}`;
      button.title = `${label}: ${item.value}`;
      button.addEventListener("click", () => applyWorkSearch(item.value));
      group.append(button);
    }

    wrap.append(group);
  }

  els.statsRow.append(wrap);
}

function topInfoValues(works, selectValues, limit) {
  const counts = new Map();
  for (const work of works || []) {
    const info = work?.infoSummary || {};
    const rawValues = selectValues(info);
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    const seenForWork = new Set();
    for (const value of values.flat()) {
      const clean = String(value || "").trim();
      if (!clean || clean.length > 32 || seenForWork.has(clean)) continue;
      seenForWork.add(clean);
      counts.set(clean, (counts.get(clean) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .filter((item) => item.count > 1)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" }))
    .slice(0, limit);
}

function visibleWorks() {
  const query = state.activeView === "search" ? "" : state.workQuery.trim().toLowerCase();
  let works = state.works.filter((work) => {
    if (!query) return true;
    return (
      includesText(work.title, query) ||
      includesText(workInfoSearchText(work), query) ||
      includesText(work.directoryName, query) ||
      includesText(work.relativePath, query) ||
      includesText(workPersonSearchText(work), query)
    );
  });

  if (!state.showCompilationWorks) {
    works = works.filter((work) => !isCompilationWork(work));
  }

  if (!state.showMissingLocalWorks && state.filterMode !== "missingLocal") {
    works = works.filter((work) => !work.missingLocal);
  }

  works = works.filter((work) => {
    if (state.filterMode === "playable") return work.playableCount > 0;
    if (state.filterMode === "favorite") return work.favorite;
    if (state.filterMode === "progress") return Boolean(work.progress);
    if (state.filterMode === "info") return work.infoCount > 0;
    if (state.filterMode === "localOnly") return !work.missingLocal;
    if (state.filterMode === "rated") return numericRating(work.infoSummary?.rating) !== null;
    if (state.filterMode === "highRating") {
      const rating = numericRating(work.infoSummary?.rating);
      return rating !== null && rating >= 4;
    }
    if (state.filterMode === "vr") return isVrWork(work);
    if (state.filterMode === "missingLocal") return Boolean(work.missingLocal);
    if (state.filterMode === "missingCover") return !workCoverUrl(work);
    return true;
  });

  works.sort((a, b) => {
    if (state.sortMode === "ranking") return compareWorkRanking(a, b) || compareWorkTitle(a, b);
    if (state.sortMode === "releaseDesc") return compareWorkReleaseDate(a, b, "desc") || compareWorkTitle(a, b);
    if (state.sortMode === "releaseAsc") return compareWorkReleaseDate(a, b, "asc") || compareWorkTitle(a, b);
    if (state.sortMode === "updated") return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
    if (state.sortMode === "ratingDesc") return compareWorkRating(a, b, "desc") || compareWorkTitle(a, b);
    if (state.sortMode === "ratingAsc") return compareWorkRating(a, b, "asc") || compareWorkTitle(a, b);
    if (state.sortMode === "progress") return String(b.progress?.updatedAt || "").localeCompare(String(a.progress?.updatedAt || ""));
    if (state.sortMode === "sizeDesc") return compareWorkSize(a, b) || compareWorkTitle(a, b);
    if (state.sortMode === "durationDesc") return compareWorkDuration(a, b) || compareWorkTitle(a, b);
    if (state.sortMode === "videos") return b.videoCount - a.videoCount || a.title.localeCompare(b.title, undefined, { numeric: true });
    return compareWorkTitle(a, b);
  });

  return works;
}

function compareWorkRanking(a, b) {
  const aRank = Number(a.ranking?.rankNo || 0);
  const bRank = Number(b.ranking?.rankNo || 0);
  const aHas = Number.isFinite(aRank) && aRank > 0;
  const bHas = Number.isFinite(bRank) && bRank > 0;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && aRank !== bRank) return aRank - bRank;
  return 0;
}

function compareWorkRating(a, b, direction = "desc") {
  const aRating = numericRating(a.infoSummary?.rating);
  const bRating = numericRating(b.infoSummary?.rating);
  const aHas = aRating !== null;
  const bHas = bRating !== null;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (!aHas && !bHas) return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
  if (aRating !== bRating) return direction === "asc" ? aRating - bRating : bRating - aRating;

  const aCount = Number(a.infoSummary?.ratingCount || 0);
  const bCount = Number(b.infoSummary?.ratingCount || 0);
  if (aCount !== bCount) return bCount - aCount;
  return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
}

function compareWorkReleaseDate(a, b, direction = "desc") {
  const aDate = workReleaseDate(a);
  const bDate = workReleaseDate(b);
  const aHas = Boolean(aDate);
  const bHas = Boolean(bDate);
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aDate !== bDate) return direction === "asc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
  return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
}

function compareWorkSize(a, b) {
  return Number(b.videoSize || 0) - Number(a.videoSize || 0);
}

function compareWorkDuration(a, b) {
  return Number(b.infoSummary?.durationMinutes || 0) - Number(a.infoSummary?.durationMinutes || 0);
}

function workReleaseDate(work) {
  return String(work.infoSummary?.releaseDate || "").trim();
}

function isCompilationWork(work) {
  if (!work?.missingLocal) return false;

  const config = normalizeUiConfig(state.uiConfig);
  const code = String(work.infoSummary?.code || extractWorkCode(work) || "").trim();
  const codePrefix = code.match(/^([A-Z0-9]+)[-_\s]?\d+/i)?.[1]?.toUpperCase() || "";
  if (codePrefix && config.compilationPrefixes.includes(codePrefix)) return true;

  const text = `${work.title || ""} ${work.directoryName || ""} ${work.infoSummary?.title || ""}`;
  const upperText = text.toUpperCase();
  if (config.compilationPrefixes.some((prefix) => new RegExp(`(^|[^A-Z0-9])${escapeRegExp(prefix)}[-_\\s]?\\d+`, "i").test(text))) {
    return true;
  }
  return config.compilationKeywords.some((keyword) => upperText.includes(String(keyword).toUpperCase()));
}

function numericRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

function compareWorkTitle(a, b) {
  return String(a.title || a.directoryName || "").localeCompare(String(b.title || b.directoryName || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function resetWorkPaging() {
  state.workVisibleLimit = state.workPageSize;
}

function resetPersonPaging() {
  peoplePage.resetPaging();
}

function clearWorkSearch() {
  window.clearTimeout(state.searchTimer);
  state.workQuery = "";
  els.workSearch.value = "";
}

function submitWorkSearch(query, options = {}) {
  const value = String(query || "").trim();
  window.clearTimeout(state.searchTimer);
  state.workQuery = value;
  els.workSearch.value = value;
  resetWorkPaging();
  return loadSearchResults(value, options);
}

function applyWorkSearch(query) {
  return submitWorkSearch(query);
}

function clearWorkFilter() {
  state.filterMode = "all";
  els.filterSelect.value = "all";
}

async function loadSearchResults(query, options = {}) {
  const normalizedQuery = String(query || "").trim();
  state.workQuery = normalizedQuery;
  if (els.workSearch && els.workSearch.value !== normalizedQuery) {
    els.workSearch.value = normalizedQuery;
  }
  if (!normalizedQuery) {
    state.searchPeople = [];
    state.searchQuery = "";
    state.searchFacets = null;
    state.searchTotal = 0;
    if (state.activeView === "search") {
      setActiveView(state.searchReturnView || "people", {
        ...options,
        replaceRoute: Object.prototype.hasOwnProperty.call(options, "replaceRoute") ? options.replaceRoute : true
      });
    } else {
      renderWorks();
    }
    return;
  }

  const enteringSearch = state.activeView !== "search";
  if (state.activeView !== "search") {
    state.searchReturnView = state.activeView || "people";
    if (state.filterMode !== "all") {
      state.filterMode = "all";
      els.filterSelect.value = "all";
    }
    if (state.sortMode === "ranking") {
      state.sortMode = "title";
      els.sortSelect.value = "title";
    }
  }

  state.activeView = "search";
  syncNavigationState("search");
  renderPeople();
  hidePersonProfile();
  setMainHeader(`搜索：${normalizedQuery}`, "全库 · 番号 / 标题 / 文件名 / 人物 / 类别 / 片商");
  els.statsRow.innerHTML = "";
  els.workGrid.innerHTML = `<div class="empty-state">正在全库搜索</div>`;
  state.searchQuery = normalizedQuery;
  state.searchTotal = 0;
  state.searchFacets = null;
  state.searchLoadingMore = false;

  const seq = ++state.searchSeq;
  try {
    const data = await fetchSearchPage(normalizedQuery, 0);
    if (seq !== state.searchSeq) return;
    state.selectedPerson = null;
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    state.searchPeople = data.people || [];
    state.works = data.works || [];
    state.searchTotal = data.total || state.works.length;
    state.searchFacets = data.facets || null;
    resetWorkPaging();
    renderSearchStats();
    renderWorks(`没有搜到「${normalizedQuery}」。`);
    syncRouteAfterNavigation({
      ...options,
      replaceRoute: Object.prototype.hasOwnProperty.call(options, "replaceRoute") ? options.replaceRoute : !enteringSearch,
      routeOverrides: { view: "search", personId: "", q: normalizedQuery, workId: "", videoId: "" }
    });
  } catch (error) {
    if (seq !== state.searchSeq) return;
    renderEmpty(error.message);
  }
}

function searchPageSize() {
  return Math.max(40, Math.min(1000, Number(state.workPageSize) || 80));
}

async function fetchSearchPage(query, offset) {
  const params = new URLSearchParams({
    q: query,
    limit: String(searchPageSize()),
    offset: String(offset || 0),
    sort: state.sortMode || "updated",
    filter: state.filterMode || "all"
  });
  return api(`/api/search?${params}`);
}

async function loadMoreSearchResults(button) {
  if (state.searchLoadingMore || state.activeView !== "search" || !state.searchQuery) return;
  state.searchLoadingMore = true;
  const originalText = button?.textContent || "";
  let restoreInFinally = true;
  if (button) {
    button.disabled = true;
    button.textContent = "正在加载";
  }

  try {
    const data = await fetchSearchPage(state.searchQuery, state.works.length);
    const seen = new Set(state.works.map((work) => work.id));
    const nextWorks = (data.works || []).filter((work) => !seen.has(work.id));
    state.works.push(...nextWorks);
    state.searchTotal = data.total || state.searchTotal || state.works.length;
    state.searchFacets = data.facets || state.searchFacets || null;
    if (!state.searchPeople.length) state.searchPeople = data.people || [];
    state.workVisibleLimit += state.workPageSize;
    renderSearchStats();
    renderWorks(`没有搜到「${state.searchQuery}」。`);
  } catch (error) {
    toastInline(button, error.message || "加载失败", originalText);
    restoreInFinally = false;
  } finally {
    state.searchLoadingMore = false;
    if (button && button.isConnected) button.disabled = false;
    if (restoreInFinally && button && button.isConnected) {
      button.disabled = false;
      button.textContent = originalText || button.textContent;
    }
  }
}

async function loadMorePersonWorks(button) {
  if (state.personWorksLoadingMore || state.activeView !== "people" || !state.selectedPersonId) return;
  if (state.works.length >= state.personWorksTotal) return;

  state.personWorksLoadingMore = true;
  const originalText = button?.textContent || "";
  let restoreInFinally = true;
  if (button) {
    button.disabled = true;
    button.textContent = "正在加载";
  }

  try {
    const personId = state.selectedPersonId;
    const data = await fetchPersonWorksPage(personId, state.works.length);
    if (state.selectedPersonId !== personId) return;
    const seen = new Set(state.works.map((work) => work.id));
    const nextWorks = (data.works || []).filter((work) => !seen.has(work.id));
    state.works.push(...nextWorks);
    state.selectedPerson = data.person || state.selectedPerson;
    state.personWorksTotal = data.total || state.personWorksTotal || state.works.length;
    state.personWorksFacets = data.facets || state.personWorksFacets || null;
    renderPersonProfile(state.selectedPerson);
    renderPersonWorkStats();
    renderWorks();
  } catch (error) {
    toastInline(button, error.message || "加载失败", originalText);
    restoreInFinally = false;
  } finally {
    state.personWorksLoadingMore = false;
    if (button && button.isConnected) button.disabled = false;
    if (restoreInFinally && button && button.isConnected) {
      button.disabled = false;
      button.textContent = originalText || button.textContent;
    }
  }
}

function toastInline(button, message, restoreText) {
  if (!button) {
    alert(message);
    return;
  }
  button.textContent = message;
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = restoreText;
  }, 1800);
}

function renderWorks(emptyMessage = "没有匹配的作品。") {
  disconnectPeopleIndexAutoload();
  disconnectWorkLoadMoreAutoload();
  cancelScheduledWorkRendering();
  resetProgressiveCoverLoading();
  const renderSeq = ++workRenderSeq;
  const works = visibleWorks();
  els.workGrid.innerHTML = "";
  renderSearchPeoplePanel();

  const hasSearchServerMore = state.activeView === "search" && state.works.length < state.searchTotal;
  const hasPersonServerMore = state.activeView === "people" && state.selectedPersonId && state.works.length < state.personWorksTotal;
  const hasServerMore = hasSearchServerMore || hasPersonServerMore;
  if (!works.length && !hasServerMore) {
    appendEmpty(emptyMessage);
    return;
  }

  const visible = works.slice(0, state.workVisibleLimit);
  const nextIndex = appendWorkCardBatch(visible, 0, Math.min(visible.length, WORK_RENDER_INITIAL_COUNT));
  if (nextIndex < visible.length) {
    scheduleRemainingWorkCards(visible, nextIndex, renderSeq, () => {
      if (visible.length < works.length || hasServerMore) {
        appendLoadMore(visible.length, works.length, { hasSearchServerMore, hasPersonServerMore });
      }
    });
    return;
  }

  if (visible.length < works.length || hasServerMore) {
    appendLoadMore(visible.length, works.length, { hasSearchServerMore, hasPersonServerMore });
  }
}

function cancelScheduledWorkRendering() {
  if (workRenderTimer) {
    window.clearTimeout(workRenderTimer);
    workRenderTimer = null;
  }
}

function appendWorkCardBatch(visible, start, end) {
  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; index += 1) {
    fragment.append(createWorkCard(visible[index], index));
  }
  els.workGrid.append(fragment);
  activateProgressiveCoverImages(els.workGrid);
  return end;
}

function scheduleRemainingWorkCards(visible, nextIndex, renderSeq, onComplete) {
  workRenderTimer = window.setTimeout(() => {
    workRenderTimer = null;
    if (renderSeq !== workRenderSeq) return;
    const end = Math.min(visible.length, nextIndex + WORK_RENDER_BATCH_SIZE);
    const afterIndex = appendWorkCardBatch(visible, nextIndex, end);
    if (afterIndex < visible.length) {
      scheduleRemainingWorkCards(visible, afterIndex, renderSeq, onComplete);
    } else {
      onComplete?.();
    }
  }, WORK_RENDER_BATCH_DELAY);
}

function appendLoadMore(visibleCount, totalCount, options = {}) {
  const hasSearchServerMore = Boolean(options.hasSearchServerMore);
  const hasPersonServerMore = Boolean(options.hasPersonServerMore);
  const wrap = document.createElement("div");
  wrap.className = "load-more-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  const loadedCount =
    state.activeView === "search"
      ? Math.max(state.works.length, visibleCount)
      : hasPersonServerMore
        ? Math.max(state.works.length, visibleCount)
        : visibleCount;
  const targetCount =
    state.activeView === "search"
      ? Math.max(state.searchTotal, totalCount)
      : hasPersonServerMore
        ? Math.max(state.personWorksTotal, totalCount)
        : totalCount;
  if (visibleCount < totalCount) {
    button.textContent =
      state.activeView === "search"
        ? `向下滑动继续加载 ${formatNumber(visibleCount)} / ${formatNumber(loadedCount)} · 总 ${formatNumber(targetCount)}`
        : `向下滑动继续加载 ${formatNumber(visibleCount)} / ${formatNumber(targetCount)}`;
  } else {
    button.textContent = `向下滑动继续加载 ${formatNumber(loadedCount)} / ${formatNumber(targetCount)}`;
  }
  const loadNext = () => {
    if (visibleCount < totalCount) {
      state.workVisibleLimit += state.workPageSize;
      renderWorks();
      return;
    }
    if (hasSearchServerMore) {
      return loadMoreSearchResults(button);
    } else if (hasPersonServerMore) {
      return loadMorePersonWorks(button);
    }
  };
  button.addEventListener("click", loadNext);

  wrap.append(button);
  els.workGrid.append(wrap);
  setupWorkLoadMoreAutoload(wrap, button, loadNext);
}

function disconnectWorkLoadMoreAutoload() {
  if (workLoadMoreObserver) {
    workLoadMoreObserver.disconnect();
    workLoadMoreObserver = null;
  }
  if (workLoadMoreScrollCleanup) {
    workLoadMoreScrollCleanup();
    workLoadMoreScrollCleanup = null;
  }
}

function setupWorkLoadMoreAutoload(trigger, button, loadNext) {
  if (!trigger || !button || typeof loadNext !== "function") return;
  trigger.dataset.autoLoad = "ready";

  const run = () => {
    if (!trigger.isConnected || !button.isConnected || button.disabled || trigger.dataset.autoConsumed === "1") return;
    trigger.dataset.autoConsumed = "1";
    button.dataset.autoloading = "1";
    button.textContent = button.textContent.replace(/^向下滑动继续加载/u, "正在接着加载");
    try {
      const result = loadNext();
      Promise.resolve(result).finally(() => {
        if (button.isConnected) delete button.dataset.autoloading;
      });
    } catch (error) {
      if (button.isConnected) delete button.dataset.autoloading;
      throw error;
    }
  };

  let scheduled = false;
  const check = () => {
    scheduled = false;
    if (!trigger.isConnected) {
      disconnectWorkLoadMoreAutoload();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    if (rect.top <= window.innerHeight + WORK_AUTO_LOAD_DISTANCE && rect.bottom >= -WORK_AUTO_LOAD_DISTANCE) {
      run();
    }
  };
  const scheduleCheck = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(check);
  };

  window.addEventListener("scroll", scheduleCheck, { passive: true });
  window.addEventListener("resize", scheduleCheck, { passive: true });
  workLoadMoreScrollCleanup = () => {
    window.removeEventListener("scroll", scheduleCheck);
    window.removeEventListener("resize", scheduleCheck);
  };

  if ("IntersectionObserver" in window) {
    workLoadMoreObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) run();
      },
      { root: null, rootMargin: WORK_AUTO_LOAD_ROOT_MARGIN, threshold: 0 }
    );
    workLoadMoreObserver.observe(trigger);
  }

  for (const delay of WORK_AUTO_LOAD_RECHECK_DELAYS) window.setTimeout(scheduleCheck, delay);
}

function renderEmpty(message) {
  els.workGrid.innerHTML = "";
  appendEmpty(message);
}

function appendEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  els.workGrid.append(empty);
}

function setGalleryStatus(message) {
  galleryRenderer.setStatus(message);
}

function renderGalleryStats() {
  galleryRenderer.renderStats();
}

async function loadImageLibrary(options = {}) {
  await galleryRenderer.loadImageLibrary(options);
}

function openAdminScript(scriptId = "", options = {}) {
  adminModal.openModal({ scriptId, scriptDefaults: options.defaults || options.scriptDefaults || {} });
}

function resetGalleryReader() {
  galleryRenderer.resetReader();
}

function syncGalleryRoute(mode = "push") {
  galleryRenderer.syncRoute(mode);
}

function galleryModeLabel(mode) {
  return galleryRenderer.modeLabel(mode);
}

function galleryMediaKindForMode(mode) {
  return galleryRenderer.mediaKindForMode(mode);
}

async function openPhotoSet(albumId, options = {}) {
  await galleryRenderer.openPhotoSet(albumId, options);
}

async function openMangaComic(comicId, options = {}) {
  await galleryRenderer.openMangaComic(comicId, options);
}

async function openMangaChapter(chapterIndex, options = {}) {
  await galleryRenderer.openMangaChapter(chapterIndex, options);
}

async function openGalleryMedia(mediaId, options = {}) {
  await galleryRenderer.openGalleryMedia(mediaId, options);
}

function renderGalleryView() {
  galleryRenderer.renderView();
}

async function saveCompilationConfig(config) {
  return adminModal.saveCompilationConfigData(config);
}

function renderSearchPeoplePanel() {
  if (state.activeView !== "search" || !state.searchPeople.length) return;

  const panel = document.createElement("div");
  panel.className = "search-people-panel";

  const label = document.createElement("div");
  label.className = "search-people-title";
  label.textContent = "人物命中";
  panel.append(label);

  const list = document.createElement("div");
  list.className = "search-people-list";

  for (const person of state.searchPeople) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-person-chip";
    button.textContent = `${displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
    button.addEventListener("click", () => {
      goToPerson(person.id);
    });
    list.append(button);
  }

  panel.append(list);
  els.workGrid.append(panel);
}

function resetProgressiveCoverLoading() {
  if (coverLoadTimer) {
    window.clearTimeout(coverLoadTimer);
    coverLoadTimer = null;
  }
  if (coverLoadObserver) {
    coverLoadObserver.disconnect();
    coverLoadObserver = null;
  }
  coverLoadQueue = [];
}

function appendProgressiveCoverImage(cover, src, index = 0) {
  const placeholder = els.placeholderTemplate.content.firstElementChild.cloneNode(true);
  placeholder.classList.add("loading-cover");
  placeholder.textContent = "";
  placeholder.setAttribute("aria-hidden", "true");
  cover.append(placeholder);

  const img = document.createElement("img");
  img.className = "progressive-cover-image";
  img.loading = index < COVER_EAGER_COUNT ? "eager" : "lazy";
  img.decoding = "async";
  img.fetchPriority = index < COVER_HIGH_PRIORITY_COUNT ? "high" : index < COVER_EAGER_COUNT ? "auto" : "low";
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.dataset.src = src;
  cover.append(img);
}

function queueCoverImage(img) {
  if (!img?.dataset?.src || img.dataset.queued === "1" || img.dataset.loaded === "1") return;
  coverLoadObserver?.unobserve(img);
  img.dataset.queued = "1";
  coverLoadQueue.push(img);
  scheduleCoverLoadDrain();
}

function activateProgressiveCoverImages(root) {
  const images = [...root.querySelectorAll('img.progressive-cover-image[data-src]')];
  const observer = ensureCoverLoadObserver();
  images.forEach((img, index) => {
    if (index < COVER_EAGER_COUNT || !observer) {
      queueCoverImage(img);
    } else {
      observer.observe(img);
    }
  });
}

function ensureCoverLoadObserver() {
  if (!("IntersectionObserver" in window)) return null;
  if (!coverLoadObserver) {
    coverLoadObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) queueCoverImage(entry.target);
        }
      },
      { rootMargin: COVER_OBSERVER_ROOT_MARGIN, threshold: 0.01 }
    );
  }
  return coverLoadObserver;
}

function retryCoverImage(img, src) {
  const retryCount = Number(img.dataset.retryCount || 0);
  const delay = COVER_RETRY_DELAYS[Math.min(retryCount, COVER_RETRY_DELAYS.length - 1)];
  img.dataset.retryCount = String(retryCount + 1);
  img.classList.remove("loaded");
  window.setTimeout(() => {
    if (!img.isConnected || img.classList.contains("loaded")) return;
    img.src = retryCoverUrl(src, retryCount + 1);
  }, delay);
}

function retryCoverUrl(src, retryCount) {
  if (!src) return "";
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}_coverRetry=${retryCount}`;
}

function scheduleCoverLoadDrain(delay = 0) {
  if (coverLoadTimer) return;
  coverLoadTimer = window.setTimeout(drainCoverLoadQueue, delay);
}

function drainCoverLoadQueue() {
  coverLoadTimer = null;
  let count = 0;
  while (coverLoadQueue.length && count < COVER_LOAD_BATCH_SIZE) {
    const img = coverLoadQueue.shift();
    if (!img?.isConnected || !img.dataset.src || img.dataset.loaded === "1") continue;
    loadQueuedCoverImage(img);
    count += 1;
  }
  if (coverLoadQueue.length) scheduleCoverLoadDrain(COVER_LOAD_BATCH_DELAY);
}

function loadQueuedCoverImage(img) {
  const src = img.dataset.src;
  const cover = img.closest(".cover-wrap");
  coverLoadObserver?.unobserve(img);
  img.dataset.loaded = "1";
  delete img.dataset.src;

  img.addEventListener(
    "load",
    () => {
      cover?.querySelector(".placeholder-cover")?.remove();
      img.classList.add("loaded");
    },
    { once: true }
  );
  img.addEventListener(
    "error",
    () => {
      retryCoverImage(img, src);
    }
  );
  img.src = src;
}

function createWorkCard(work, index = 0) {
  const card = document.createElement("article");
  card.className = `work-card${work.missingLocal ? " missing-local" : ""}`;
  card.dataset.workId = work.id;

  const cover = document.createElement("button");
  cover.type = "button";
  cover.className = "cover-wrap work-card-main";
  cover.setAttribute("aria-label", work.missingLocal ? `打开 JavDB：${work.title}` : `打开作品：${work.title}`);
  cover.addEventListener("click", () => openWorkCard(work));

  const resolvedCoverUrl = workCoverUrl(work);
  if (resolvedCoverUrl) {
    appendProgressiveCoverImage(cover, resolvedCoverUrl, index);
  } else {
    cover.append(els.placeholderTemplate.content.cloneNode(true));
  }

  const favorite = document.createElement("button");
  favorite.type = "button";
  favorite.className = `favorite-button${work.favorite ? " active" : ""}`;
  favorite.title = work.favorite ? "取消收藏" : "收藏";
  favorite.setAttribute("aria-label", work.favorite ? "取消收藏" : "收藏");
  favorite.textContent = "★";
  favorite.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFavorite(work.id);
  });

  if (work.progress?.percent) {
    const track = document.createElement("div");
    track.className = "progress-track";
    track.innerHTML = `<div class="progress-fill" style="width:${Math.min(100, Math.max(0, work.progress.percent)).toFixed(1)}%"></div>`;
    cover.append(track);
  }

  const body = document.createElement("div");
  body.className = "work-body";
  body.addEventListener("click", () => openWorkCard(work));

  const title = document.createElement("div");
  title.className = "work-title";
  title.textContent = work.title;

  const facts = document.createElement("div");
  facts.className = "work-card-facts";
  const rating = createRatingLine(work);
  const updated = document.createElement("div");
  updated.className = "work-updated";
  updated.textContent = formatDate(work.infoSummary?.releaseDate || work.modifiedAt) || (work.missingLocal ? "未下载" : "日期未知");
  facts.append(rating, updated);

  const flags = document.createElement("div");
  flags.className = "work-card-flags";
  if (work.ranking?.rankNo) flags.append(createInfoChip(`TOP ${formatNumber(work.ranking.rankNo)}`, "rank"));
  if (work.missingLocal) flags.append(createInfoChip("未下载", "missing"));
  if (work.infoCount > 0) flags.append(createInfoChip(`${formatNumber(work.infoCount)} 资料`));
  if (work.progress?.percent) flags.append(createInfoChip(`看到 ${Math.floor(work.progress.percent)}%`, "progress"));
  if (work.missingLocal && state.accessMode === "local") {
    const compilationButton = document.createElement("button");
    compilationButton.type = "button";
    compilationButton.className = "inline-rule-button";
    compilationButton.textContent = "标为合集";
    compilationButton.addEventListener("click", (event) => {
      event.stopPropagation();
      markWorkAsCompilation(work, compilationButton);
    });
    flags.append(compilationButton);
  }
  if (state.activeView === "favorites" && work.favorite) {
    flags.append(createFavoriteFolderSelect(work));
  }

  body.append(title, facts);
  if (flags.childElementCount) body.append(flags);
  if (work.missingLocal) {
    card.append(cover, body);
  } else {
    card.append(cover, favorite, body);
  }
  return card;
}

function createFavoriteFolderSelect(work) {
  const select = document.createElement("select");
  select.className = "favorite-folder-select";
  select.title = "移动到收藏夹";
  select.setAttribute("aria-label", "移动到收藏夹");
  for (const folder of state.favoriteFolders || []) {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = folder.name;
    select.append(option);
  }
  select.value = work.favoriteFolderId || "default";
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", (event) => {
    event.stopPropagation();
    moveFavoriteToFolder(work, select.value, select);
  });
  return select;
}

function openWorkCard(work) {
  if (work.missingLocal) {
    if (work.javdbUrl) {
      window.open(work.javdbUrl, "_blank", "noreferrer");
    }
    return;
  }
  openWork(work.id);
}

function workCodePrefix(work) {
  const code = String(work.infoSummary?.code || extractWorkCode(work) || "").trim();
  return normalizeCompilationPrefix(code.match(/^([A-Z0-9]+)[-_\s]?\d+/i)?.[1] || "");
}

async function markWorkAsCompilation(work, button) {
  const prefix = workCodePrefix(work);
  if (!prefix) {
    toastInline(button, "没识别到前缀", button.textContent);
    return;
  }

  const config = normalizeUiConfig(state.uiConfig);
  if (config.compilationPrefixes.includes(prefix)) {
    renderWorks();
    return;
  }

  const original = button.textContent;
  button.disabled = true;
  button.textContent = "保存中";
  try {
    await saveCompilationConfig({
      ...config,
      compilationPrefixes: [...config.compilationPrefixes, prefix]
    });
    if (els.adminConfigStatus) els.adminConfigStatus.textContent = `已添加 ${prefix}`;
  } catch (error) {
    toastInline(button, error.message || "保存失败", original);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function createRatingLine(work) {
  const row = document.createElement("div");
  row.className = "work-rating-line";

  const rating = numericRating(work.infoSummary?.rating);
  const ratingForStars = rating === null ? 0 : rating > 5 ? rating / 2 : rating;
  const percent = Math.max(0, Math.min(100, (ratingForStars / 5) * 100));

  const stars = document.createElement("span");
  stars.className = "rating-stars";
  stars.setAttribute("aria-hidden", "true");
  stars.innerHTML = `<span class="rating-stars-empty">★★★★★</span><span class="rating-stars-fill" style="width:${percent.toFixed(1)}%">★★★★★</span>`;

  const text = document.createElement("span");
  text.className = "rating-text";
  const count = Number(work.infoSummary?.ratingCount || 0);
  if (rating !== null) {
    const ratingText = Number.isInteger(rating) ? rating.toFixed(1) : String(rating);
    text.textContent = count ? `${ratingText}分, 由${formatNumber(count)}人评价` : `${ratingText}分`;
    row.setAttribute("aria-label", text.textContent);
  } else {
    text.textContent = "暂无评分";
    row.classList.add("empty");
  }

  row.append(stars, text);
  return row;
}

function formatDate(value) {
  if (!value) return "";
  const match = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(String(value));
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDate(value) || String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function extractWorkCode(work) {
  const text = `${work.directoryName || ""} ${work.title || ""}`;
  const match = text.match(/(?:\[[^\]]+\][._\s-]*)?([a-z]{2,10})[-_\s]?(\d{2,6})/i);
  if (!match) return "";
  return `${match[1].toUpperCase()}-${match[2]}`;
}

function workSourceLabel(work) {
  const sourcePath = normalizeSourcePath(work.relativePath);
  if (sourcePath === "v:/[a]" || sourcePath.startsWith("v:/[a]/")) return { label: "VR · V:[A]", vr: true };
  if (sourcePath === "v:/[a1]" || sourcePath.startsWith("v:/[a1]/")) return { label: "VR · V:[A1]", vr: true };
  if (sourcePath === "v:/av" || sourcePath.startsWith("v:/av/")) return { label: "VR · V:AV", vr: true };
  if (sourcePath === "o:/[珍藏]" || sourcePath.startsWith("o:/[珍藏]/")) return { label: "O:珍藏", vr: false };
  if (sourcePath === "o:/[珍藏1]" || sourcePath.startsWith("o:/[珍藏1]/")) return { label: "O:珍藏1", vr: false };
  if (sourcePath.startsWith("g:/")) return { label: "G:", vr: false };
  if (sourcePath.startsWith("f:/")) return { label: "F:", vr: false };
  if (sourcePath.startsWith("o:/")) return { label: "O:", vr: false };
  return { label: "", vr: false };
}

function isVrWork(work) {
  if (workSourceLabel(work).vr) return true;
  const text = [work?.title, work?.directoryName, work?.relativePath]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes("[vr]") || /\bvr\b/.test(text);
}

function createInfoChip(text, variant = "") {
  const chip = document.createElement("span");
  chip.className = `info-chip${variant ? ` ${variant}` : ""}`;
  chip.textContent = text;
  return chip;
}

async function openWork(workId, videoId = null, options = {}) {
  await workDetailPage.openWork(workId, videoId, options);
}

function closeDrawer(options = {}) {
  workDetailPage.closeDrawer(options);
}

function trapDrawerFocus(event) {
  workDetailPage.trapDrawerFocus(event);
}

async function renderPlayer(work, requestedVideoId = null, startAt = null, autoplay = false) {
  await workDetailPage.renderPlayer(work, requestedVideoId, startAt, autoplay);
}

function renderMeta(work) {
  workDetailPage.renderMeta(work);
}

async function toggleFavorite(workId) {
  await workDetailPage.toggleFavorite(workId);
}

async function moveFavoriteToFolder(work, folderId, control) {
  await workDetailPage.moveFavoriteToFolder(work, folderId, control);
}

function updateWorkSnapshot(nextWork) {
  workDetailPage.updateWorkSnapshot(nextWork);
}

function reportCurrentProgress(options = {}) {
  workDetailPage.reportCurrentProgress(options);
}

els.personSearch.addEventListener("input", (event) => {
  state.personQuery = event.target.value;
  window.clearTimeout(state.personSearchTimer);
  state.personSearchTimer = window.setTimeout(() => {
    resetPersonPaging();
    renderPeople();
    if (state.activeView === "people" && !state.selectedPersonId) {
      renderPeopleIndexStats();
      renderPeopleIndex();
    }
  }, 140);
});

els.workSearch.addEventListener("input", () => {
  window.clearTimeout(state.searchTimer);
});

els.workSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitWorkSearch(event.currentTarget.value);
    return;
  }
  if (event.key === "Escape" && event.currentTarget.value) {
    event.preventDefault();
    event.currentTarget.value = "";
    submitWorkSearch("");
  }
});

els.sortSelect.addEventListener("change", (event) => {
  state.sortMode = event.target.value;
  resetWorkPaging();
  if (state.activeView === "search" && state.searchQuery) {
    loadSearchResults(state.searchQuery);
    return;
  }
  if (state.activeView === "people" && state.selectedPersonId) {
    selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (state.activeView === "rankings") {
    renderRankingStats();
  }
  renderWorks();
});

els.filterSelect.addEventListener("change", (event) => {
  state.filterMode = event.target.value;
  resetWorkPaging();
  if (state.activeView === "search" && state.searchQuery) {
    loadSearchResults(state.searchQuery);
    return;
  }
  if (state.activeView === "people" && state.selectedPersonId) {
    selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (state.activeView === "rankings") {
    renderRankingStats();
  }
  renderWorks();
});

els.missingLocalToggle?.addEventListener("change", (event) => {
  state.showMissingLocalWorks = Boolean(event.target.checked);
  writeStoredFlag("fanhao.showMissingLocalWorks", state.showMissingLocalWorks);
  resetWorkPaging();
  renderWorks();
});

els.collectionToggle?.addEventListener("change", (event) => {
  state.showCompilationWorks = Boolean(event.target.checked);
  writeStoredFlag("fanhao.showCompilationWorks", state.showCompilationWorks);
  resetWorkPaging();
  if (state.activeView === "people" && !state.selectedPersonId) {
    renderPeopleIndexStats();
    renderPeopleIndex();
    return;
  }
  renderWorks();
});

els.backToPeopleIndex?.addEventListener("click", returnToPeopleIndex);

for (const button of els.productTabs || []) {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    clearWorkSearch();
    if (button.dataset.productView === "gallery") {
      const mode = button.dataset.galleryMode || "photo";
      const changed = state.activeView !== "gallery" || state.gallery.mode !== mode;
      state.gallery.mode = mode;
      resetGalleryReader();
      if (changed || mode !== "photo") state.gallery.photoView = mode === "photo" ? "collections" : "albums";
      state.gallery.photoCollection = null;
      state.gallery.category = mode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all";
      state.gallery.subCategory = "all";
      state.gallery.person = "all";
      state.gallery.visibleLimit = 80;
      setActiveView("gallery");
      return;
    }
    setActiveView(button.dataset.productView || "people");
  });
}

for (const button of els.viewTabs) {
  button.addEventListener("click", () => {
    clearWorkSearch();
    setActiveView(button.dataset.view);
  });
}

async function rescanFullLibrary(button) {
  if (state.activeView === "gallery") {
    openAdminScript("image-library-rescan");
    return;
  }
  if (state.activeView === "novels") {
    openAdminScript("novel-library-rescan");
    return;
  }
  openAdminScript("");
}

els.rescanButton?.addEventListener("click", () => rescanFullLibrary(els.rescanButton));
els.topRescanButton?.addEventListener("click", () => rescanFullLibrary(els.topRescanButton));

els.adminButton?.addEventListener("click", adminModal.openPage);
els.closeAdmin?.addEventListener("click", adminModal.closeModal);
els.adminBackdrop?.addEventListener("click", adminModal.closeModal);
els.adminRescanPerson?.addEventListener("click", adminModal.rescanSelectedPerson);
els.adminRefreshActor?.addEventListener("click", adminModal.refreshActorMovies);
els.adminRefreshRankings?.addEventListener("click", adminModal.refreshRankings);
els.adminPreviewActorAvatars?.addEventListener("click", adminModal.previewActorAvatarCandidates);
els.adminImportActorAvatars?.addEventListener("click", adminModal.importActorAvatars);
els.adminGenerateCovers?.addEventListener("click", adminModal.generateMissingCovers);
els.adminSaveCompilationConfig?.addEventListener("click", adminModal.saveCompilationConfig);
els.adminScriptForm?.addEventListener("submit", adminModal.runSelectedScript);
els.adminRefreshScripts?.addEventListener("click", adminModal.loadScripts);
els.adminScriptCategory?.addEventListener("change", () => {
  state.adminScriptCategory = els.adminScriptCategory.value || "all";
  adminModal.renderScripts();
});
els.compilationConfigButton?.addEventListener("click", adminModal.openCompilationConfig);

els.closeDrawer.addEventListener("click", closeDrawer);
els.drawerBackdrop.addEventListener("click", closeDrawer);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && els.adminModal?.classList.contains("open")) {
    adminModal.closeModal();
    return;
  }

  const drawerOpen = els.detailDrawer.classList.contains("open");
  if (event.key === "Escape" && drawerOpen) {
    closeDrawer();
    return;
  }
  if (event.key === "Tab" && drawerOpen) {
    trapDrawerFocus(event);
  }

  if (state.activeView === "gallery" && state.gallery.comic && state.gallery.chapter && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) {
    const chapters = state.gallery.comic.chapters || [];
    const currentIndex = chapters.findIndex((item) => item.index === state.gallery.chapter.index);
    if (event.key === "ArrowLeft" && currentIndex > 0) {
      event.preventDefault();
      openMangaChapter(chapters[currentIndex - 1].index);
    } else if (event.key === "ArrowRight" && currentIndex >= 0 && currentIndex < chapters.length - 1) {
      event.preventDefault();
      openMangaChapter(chapters[currentIndex + 1].index);
    }
  }

  if (state.activeView === "novels" && state.novel.chapter && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      novelPage.openAdjacent(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      novelPage.openAdjacent(1);
    }
  }
});

window.addEventListener("popstate", () => {
  if (!state.routeReady) return;
  applyRoute(routeFromUrl()).catch((error) => {
    console.error(error);
  });
});

window.addEventListener("beforeunload", reportCurrentProgress);
installAndroidClientReturn();

async function applyInitialUrlState() {
  await applyRoute(routeFromUrl());
}

loadLibrary({ deferMainRender: true })
  .then(async () => {
    await applyInitialUrlState();
    initializeRouteHistory();
  })
  .catch((error) => {
    els.librarySummary.textContent = "索引读取失败";
    renderEmpty(error.message);
  });

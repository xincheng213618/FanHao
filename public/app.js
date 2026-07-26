import { createApiClient } from "./js/api.js?v=20260701-gallery-merge-01";
import { installAndroidClientReturn, isTrustedNetworkFeatureAvailable, prepareClientShell } from "./js/client-shell.js?v=20260712-project-refactor-03";
import { loadModuleCatalog, renderWebModuleNavigation } from "./js/module-navigation.js?v=20260710-module-windows-01";
import {
  appendWorkCardsInPlace,
  createCodePrefixPage,
  createFanhaoState,
  createCollectionPage,
  createPeoplePage,
  createPlaybackPrefetch,
  createRankingPage,
  createSearchRequestService,
  createStudioPage,
  createViewportBatchRenderer,
  createWorkActions,
  selectVisibleWorks,
  workServerMoreState
} from "./modules/fanhao/index.js?v=20260726-work-sort-01";
import { adminUrl } from "./js/admin-navigation.js?v=20260727-admin-merge-01";
import { createLazyPersonProfile } from "./modules/fanhao/lazy-person-profile.js?v=20260717-fanhao-lazy-person-01";
import { PEOPLE_SCOPE_NAMES, URL_VIEW_NAMES, normalizeRoute, routeFromUrl, routeUrl } from "./js/router.js?v=20260724-code-prefix-catalog-01";

prepareAppShell();
prepareClientShell();

const state = {
  ...createFanhaoState({ readStoredFlag }),
  uiConfig: defaultUiConfig(),
  routeReady: false,
  restoringRoute: false
};

function prepareAppShell() {
  document.querySelector(".product-actions")?.style.setProperty("display", "flex");
}

const els = {
  productNav: document.querySelector(".product-nav"),
  productTabs: [...document.querySelectorAll("[data-product-view]")],
  topAdminLink: document.querySelector("#topAdminLink"),
  viewTabs: [...document.querySelectorAll(".view-tab")],
  workSearch: document.querySelector("#workSearch"),
  sortSelect: null,
  filterList: null,
  missingLocalToggle: document.querySelector("#missingLocalToggle"),
  collectionToggle: document.querySelector("#collectionToggle"),
  compilationConfigButton: document.querySelector("#compilationConfigButton"),
  personProfile: document.querySelector("#personProfile"),
  currentPath: document.querySelector("#currentPath"),
  currentTitle: document.querySelector("#currentTitle"),
  backToPeopleIndex: document.querySelector("#backToPeopleIndex"),
  statsRow: document.querySelector("#statsRow"),
  workGrid: document.querySelector("#workGrid"),
  placeholderTemplate: document.querySelector("#placeholderTemplate")
};

const formatter = new Intl.NumberFormat("zh-CN");
let workLoadMoreScrollCleanup = null;
let coverLoadQueue = [];
let coverLoadTimer = null;
let coverLoadObserver = null;
const activeCoverImages = new Set();
const WORK_DESKTOP_PAGE_SIZE = 64;
const WORK_MOBILE_PAGE_SIZE = 48;
const WORK_PAGE_SIZE_BY_ACCESS = Object.freeze({ local: 64, lan: 64, remote: 48 });
const WORK_AUTO_LOAD_DISTANCE = 1400;
const COVER_LOAD_BATCH_SIZE = 8;
const COVER_LOAD_BATCH_DELAY = 45;
const COVER_EAGER_COUNT = 12;
const COVER_HIGH_PRIORITY_COUNT = 8;
const COVER_OBSERVER_ROOT_MARGIN = "420px 0px";
const COVER_RETRY_DELAYS = [700, 1400, 2400, 4000, 6500, 9000];
const initialParams = new URLSearchParams(window.location.search);
const isAndroidClient = initialParams.get("client") === "android";
const api = createApiClient({ isAndroidClient });
const playbackPrefetch = createPlaybackPrefetch({ api });
playbackPrefetch.bindContainer(els.workGrid);
bindProgressiveCoverLifecycle(els.workGrid);
const workListRenderer = createViewportBatchRenderer({
  container: els.workGrid,
  appendBatch: appendWorkCardBatch
});
const searchRequests = createSearchRequestService({
  api,
  filter: serializedWorkFilterMode,
  pageSize: preferredWorkPageSize,
  sort: () => state.sortMode || "releaseDesc"
});

function preferredWorkPageSize(configuredLimit = state.workPageSize) {
  const viewportLimit = globalThis.matchMedia?.("(max-width: 720px)")?.matches
    ? WORK_MOBILE_PAGE_SIZE
    : WORK_DESKTOP_PAGE_SIZE;
  return Math.max(40, Math.min(viewportLimit, Number(configuredLimit) || viewportLimit));
}

async function initializeModuleNavigation() {
  try {
    const modules = await loadModuleCatalog(() => api("/api/modules"));
    els.productTabs = renderWebModuleNavigation(els.productNav, modules);
  } catch (error) {
    console.warn("[modules]", error.message || error);
  }
}
const peoplePage = createPeoplePage({
  api,
  appendEmpty,
  cancelScheduledWorkRendering,
  clearWorkFilter,
  clearWorkSearch,
  coverUrl,
  currentPageScrollTop,
  displayPersonName,
  els,
  formatLibraryPaths,
  formatNumber,
  getWorkFilterMode: serializedWorkFilterMode,
  hidePersonProfile,
  preparePersonProfile: () => personProfilePage.load().catch(() => {}),
  renderPersonProfile,
  renderPersonWorkStats,
  renderWorks,
  resetProgressiveCoverLoading,
  resetWorkPaging,
  restorePageScrollTop,
  setMainHeader,
  state,
  syncNavigationState,
  syncRouteAfterNavigation,
  workCoverUrl
});
const codePrefixPage = createCodePrefixPage({
  api,
  appendEmpty,
  appendLoadedWorkPage,
  appendWorkControls,
  clearWorkFilter,
  clearWorkSearch,
  els,
  formatNumber,
  hidePersonProfile,
  renderWorks,
  resetWorkPaging,
  setMainHeader,
  state,
  syncNavigationState,
  syncRouteAfterNavigation
});
const personProfilePage = createLazyPersonProfile({
  els,
  loadPersonProfile: async () => {
    const { createPersonProfile } = await import("./modules/fanhao/person-profile.js?v=20260724-person-local-refresh-01");
    return createPersonProfile({
      api,
      coverUrl,
      els,
      formatLibraryPath,
      formatNumber,
      isPersonBulkDeleteActive,
      isTrustedNetworkFeatureAvailable,
      linesFromTextarea,
      normalizeSourcePath,
      renderPeople: renderPeopleIndex,
      selectPerson,
      sourcePriority,
      state,
      togglePersonBulkDeleteMode,
      workCoverUrl
    });
  },
  onLoadError: (error) => console.warn("[person-profile]", error?.message || error)
});
const {
  moveFavoriteToFolder,
  toggleFavorite,
  updateWorkSnapshot
} = createWorkActions({
  api,
  onCollectionStateChanged: () => collectionPage.invalidatePrefetches(),
  renderFavoriteFolderControls,
  renderStatsForWorks,
  renderWorks,
  state
});
const collectionPage = createCollectionPage({
  api,
  appendLoadedWorkPage,
  els,
  formatNumber,
  hidePersonProfile,
  renderEmpty,
  renderStatsForWorks,
  renderWorks,
  resetWorkPaging,
  setMainHeader,
  state
});
const studioPage = createStudioPage({
  api,
  appendLoadedWorkPage,
  appendEmpty,
  els,
  formatNumber,
  hidePersonProfile,
  renderStatsForWorks,
  renderWorks,
  resetWorkPaging,
  setMainHeader,
  state
});
const rankingPage = createRankingPage({
  adminRefreshRankings: refreshRankingsFromLibrary,
  api,
  appendLoadedWorkPage,
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

function currentPageScrollTop() {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function restorePageScrollTop(top) {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: Math.max(0, Number(top) || 0), left: 0, behavior: "auto" });
  });
}

function currentRouteSnapshot(overrides = {}) {
  const route = {
    view: state.activeView || "people",
    peopleScope: state.activeView === "people" ? state.peopleScope || "main" : "main",
    codePrefix: state.activeView === "codes" ? state.selectedCodePrefix || "" : "",
    codePrefixFamily: state.activeView === "codes" && Boolean(state.selectedCodePrefixFamily),
    personId: state.activeView === "people" ? state.selectedPersonId || "" : "",
    q: state.activeView === "search" ? state.searchQuery || state.workQuery || "" : "",
    workId: "",
    videoId: ""
  };
  return normalizeRoute({ ...route, ...overrides });
}

function writeRoute(route, mode = "push") {
  if (!state.routeReady || !window.history?.pushState) return;
  if (state.restoringRoute && mode !== "replace") return;
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

async function applyRoute(route) {
  const next = normalizeRoute(route);
  if (["gallery", "novels", "music", "tools", "shortVideos"].includes(next.view)) {
    window.location.replace(routeUrl(next, { initialParams }));
    return;
  }
  if (routeNeedsLibrary(next)) {
    await ensureLibraryLoaded({ deferMainRender: true });
  }
  state.restoringRoute = true;
  try {
    if (next.view === "search") {
      state.workQuery = next.q;
      els.workSearch.value = next.q;
      await loadSearchResults(next.q, { skipRoute: true });
    } else if (next.view === "codes") {
      await codePrefixPage.applyRoute(next);
    } else if (next.view === "people") {
      await setPeopleScope(next.peopleScope || "main");
      clearWorkSearch();
      const routePerson = next.personId
        ? state.people.find((person) => person.id === next.personId)
        : null;
      if (routePerson) {
        await selectPerson(routePerson.id, {
          resetFilter: false,
          captureIndexScroll: false,
          skipRoute: routePerson.id === next.personId,
          replaceRoute: routePerson.id !== next.personId
        });
      } else if (next.personId) {
        await selectPerson(next.personId, {
          resetFilter: false,
          captureIndexScroll: false,
          replaceRoute: true
        });
      } else {
        showPeopleIndex({ restoreScroll: true, skipRoute: true });
      }
    } else {
      clearWorkSearch();
      setActiveView(next.view, { skipRoute: true });
    }

    if (next.workId) {
      window.location.href = playerPageUrl(next.workId, next.videoId || "");
    }
  } finally {
    state.restoringRoute = false;
  }
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

function includesText(value, query) {
  return String(value || "").toLowerCase().includes(query.trim().toLowerCase());
}

function displayPersonName(person) {
  return person?.actorProfile?.displayName || person?.name || "";
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
  const params = new URLSearchParams();
  if (state.peopleScope && state.peopleScope !== "main") params.set("scope", state.peopleScope);
  const data = await api(`/api/library${params.toString() ? `?${params}` : ""}`);
  state.library = data;
  state.peopleScope = normalizePeopleScope(data.scope || state.peopleScope);
  state.accessMode = data.access?.mode || "local";
  state.accessHints = data.access?.hints || {};
  state.uiConfig = normalizeUiConfig(data.uiConfig || state.uiConfig);
  if (els.topAdminLink) els.topAdminLink.hidden = state.accessMode !== "local";
  if (els.missingLocalToggle) els.missingLocalToggle.checked = state.showMissingLocalWorks;
  if (els.collectionToggle) els.collectionToggle.checked = state.showCompilationWorks;
  const defaultWorkPageSize = WORK_PAGE_SIZE_BY_ACCESS[state.accessMode] || WORK_PAGE_SIZE_BY_ACCESS.remote;
  state.workPageSize = preferredWorkPageSize(Math.min(defaultWorkPageSize, Number(state.accessHints.workPageSize) || defaultWorkPageSize));
  state.personPageSize = peoplePage.personIndexPageSize();
  resetWorkPaging();
  state.people = sortPeopleForList(data.people || []);
  codePrefixPage.invalidateIndex();
  resetPersonPaging();

  if (state.selectedPersonId && !state.people.some((person) => person.id === state.selectedPersonId)) {
    state.selectedPersonId = null;
  }

  if (!options.deferMainRender) {
    setActiveView(state.activeView || "people");
  }
}

let libraryLoadPromise = null;

function routeNeedsLibrary(route) {
  return Boolean(route?.view && route.view !== "search");
}

async function ensureLibraryLoaded(options = {}) {
  if (state.library) return state.library;
  if (!libraryLoadPromise) {
    libraryLoadPromise = loadLibrary(options)
      .then(() => state.library)
      .finally(() => {
        libraryLoadPromise = null;
      });
  }
  return libraryLoadPromise;
}

function normalizePeopleScope(value) {
  return PEOPLE_SCOPE_NAMES.has(value) ? value : "main";
}

async function setPeopleScope(scope, options = {}) {
  const nextScope = normalizePeopleScope(scope);
  const changed = state.peopleScope !== nextScope || options.force;
  state.peopleScope = nextScope;
  if (changed) {
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    state.filterMode = "all";
    await loadLibrary({ deferMainRender: true });
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
  if (sourcePath.startsWith("r:/")) return 11;
  return 12;
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

function productViewForActiveView(view = state.activeView) {
  return "people";
}

function syncProductShell(view = state.activeView) {
  document.body.classList.add("fanhao-view");
  document.body.classList.remove("standalone-module-view");
}

function searchWorksByText(value) {
  const query = String(value || "").trim();
  if (!query) return;
  if (els.workSearch) els.workSearch.value = query;
  loadSearchResults(query);
}

function productButtonActive(button, view = state.activeView) {
  const productView = button.dataset.productView || "people";
  if (productView === "people") {
    const buttonScope = button.dataset.peopleScope || "main";
    return productViewForActiveView(view) === "people" && (state.peopleScope || "main") === buttonScope;
  }
  return false;
}

function syncNavigationState(view = state.activeView) {
  syncProductShell(view);
  for (const button of els.productTabs || []) {
    const active = productButtonActive(button, view);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const button of els.viewTabs || []) {
    const activeView = view === "search" ? state.searchReturnView || "people" : view;
    const active = codePrefixPage.navigationButtonActive(button, activeView) ?? button.dataset.view === activeView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function setActiveView(view, options = {}) {
  view = URL_VIEW_NAMES.has(view) ? view : "people";
  if (["gallery", "novels", "music", "tools", "shortVideos"].includes(view)) {
    window.location.assign(routeUrl({ view }, { initialParams }));
    return;
  }
  if (view !== "people") peoplePage.cancelPendingSelection();
  if (view !== "codes") codePrefixPage.cancelPendingRequests();
  if (view !== "search") searchRequests.cancel();
  if (view !== "rankings") rankingPage.cancelPendingRequests();
  if (view !== "studios") studioPage.cancelPendingRequests();
  if (!["favorites", "history", "vr"].includes(view)) collectionPage.cancelPendingRequests();
  const previousView = state.activeView;
  state.activeView = view;
  if (view !== "rankings" && state.sortMode === "ranking") {
    state.sortMode = "releaseDesc";
    if (els.sortSelect) els.sortSelect.value = "releaseDesc";
  }
  if (view !== "search") {
    state.searchPeople = [];
    state.searchQuery = "";
    state.searchFacets = null;
    state.searchTotal = 0;
  }
  syncNavigationState(view);

  if (view === "codes") {
    codePrefixPage.enter(options);
    return;
  }

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

  if (view === "studios") {
    studioPage.loadStudios();
    syncRouteAfterNavigation(options);
    return;
  }

  if (view === "vr") {
    if (previousView !== "vr" && !options.keepFilter) state.filterMode = "all";
    collectionPage.loadVrWorks();
    syncRouteAfterNavigation(options);
    return;
  }

  showPeopleIndex({ skipRoute: true });
  syncRouteAfterNavigation(options);
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
  await collectionPage.loadFavorites();
}

function renderFavoriteFolderControls() {
  collectionPage.renderFavoriteFolderControls();
}

async function loadHistory() {
  await collectionPage.loadHistory();
}

async function loadRankings() {
  await rankingPage.loadRankings();
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
  syncProductShell();
  document.body.classList.toggle("search-view", state.activeView === "search");
  document.body.classList.toggle("people-index-view", state.activeView === "people" && !state.selectedPersonId);
  document.body.classList.toggle("person-detail-view", state.activeView === "people" && Boolean(state.selectedPersonId));
  document.body.classList.toggle("code-prefix-index-view", state.activeView === "codes" && !state.selectedCodePrefix);
  document.body.classList.toggle("code-prefix-detail-view", state.activeView === "codes" && Boolean(state.selectedCodePrefix));
  document.body.classList.toggle("ranking-view", state.activeView === "rankings");
  document.body.classList.toggle("studio-index-view", state.activeView === "studios" && !state.selectedStudio);
  els.missingLocalToggle?.closest(".toggle-control")?.removeAttribute("hidden");
  els.collectionToggle?.closest(".toggle-control")?.removeAttribute("hidden");
  els.compilationConfigButton?.removeAttribute("hidden");
  syncNavigationState();
  if (!els.backToPeopleIndex) return;
  const showPersonBack = state.activeView === "people" && Boolean(state.selectedPersonId);
  const showCodePrefixBack = state.activeView === "codes" && Boolean(state.selectedCodePrefix);
  els.backToPeopleIndex.hidden = !(showPersonBack || showCodePrefixBack);
  els.backToPeopleIndex.textContent = showCodePrefixBack ? "返回番号索引" : "返回人物索引";
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

const WORK_SORT_OPTIONS = [
  ["releaseDesc", "发行最新"],
  ["updated", "最近更新"],
  ["title", "标题"],
  ["ranking", "排行"],
  ["releaseAsc", "发行最早"],
  ["ratingDesc", "评分最高"],
  ["ratingCountDesc", "评价人数最多"],
  ["popularityDesc", "热度最高"],
  ["progress", "最近观看"],
  ["sizeDesc", "文件大小"],
  ["durationDesc", "时长"],
  ["videos", "视频数量"]
];

const WORK_FILTER_OPTIONS = [
  ["all", "全部"],
  ["localMarkedA", "显示A"],
  ["playable", "可播放"],
  ["favorite", "已收藏"],
  ["progress", "有进度"],
  ["info", "有资料"],
  ["localOnly", "本地"],
  ["rated", "有评分"],
  ["highRating", "高分"],
  ["vr", "VR"],
  ["hasMagnet", "有磁链"],
  ["missingLocal", "未下载"],
  ["missingCover", "无封面"]
];

function createWorkSortControls() {
  const group = document.createElement("div");
  group.className = "stat-filter-group stat-sort-group";

  const label = document.createElement("label");
  label.className = "stat-filter-label";
  label.htmlFor = "sortSelect";
  label.textContent = "排序";

  const select = document.createElement("select");
  select.id = "sortSelect";
  select.className = "stat-sort-select";
  select.title = "排序";
  select.setAttribute("aria-label", "作品排序");
  for (const [value, text] of WORK_SORT_OPTIONS) {
    select.append(new Option(text, value));
  }
  select.value = state.sortMode || "releaseDesc";
  select.addEventListener("change", handleSortModeChange);
  els.sortSelect = select;

  group.append(label, select);
  return group;
}

function createWorkFilterControls() {
  const group = document.createElement("div");
  group.className = "stat-filter-group stat-filter-list-group";

  const list = document.createElement("div");
  list.className = "stat-filter-list";
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "作品筛选");
  for (const [value, text] of WORK_FILTER_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat-filter-chip${workFilterIsActive(value) ? " active" : ""}`;
    button.textContent = text;
    button.setAttribute("aria-pressed", String(workFilterIsActive(value)));
    button.addEventListener("click", () => toggleWorkFilter(value));
    list.append(button);
  }
  els.filterList = list;

  group.append(list);
  return group;
}

function handleSortModeChange(event) {
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
  if (codePrefixPage.reloadForActiveView()) return;
  if (state.activeView === "rankings") {
    renderRankingStats();
  }
  if (state.activeView === "vr") {
    collectionPage.loadVrWorks();
    return;
  }
  if (state.activeView === "studios" && state.selectedStudio) {
    studioPage.loadStudioDetail(state.selectedStudio.id, state.selectedStudioSeriesId);
    return;
  }
  renderWorks();
}

function handleFilterModeChange() {
  resetWorkPaging();
  if (state.activeView === "search" && state.searchQuery) {
    loadSearchResults(state.searchQuery);
    return;
  }
  if (state.activeView === "people" && state.selectedPersonId) {
    selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (codePrefixPage.reloadForActiveView()) return;
  if (state.activeView === "rankings") {
    renderRankingStats();
  }
  renderWorks();
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
  appendWorkControls(works);
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
  appendWorkControls(state.works);
}

function searchFilterLabel() {
  const labels = selectedWorkFilters().map(workFilterLabel);
  return labels.length ? `${labels.join(" + ")}结果` : "当前筛选";
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

  els.statsRow.innerHTML = "";
  appendWorkControls(state.works);
}

function appendWorkControls(works) {
  const wrap = document.createElement("div");
  wrap.className = "stat-quick-filters";
  wrap.append(createWorkFilterControls(), createWorkSortControls());
  appendPersonBulkDeleteControls(works, wrap);
  appendMetadataQuickFilters(works, wrap);
  els.statsRow.append(wrap);
}

function isPersonBulkDeleteAvailable() {
  return state.activeView === "people" && Boolean(state.selectedPersonId) && isTrustedNetworkFeatureAvailable();
}

function isPersonBulkDeleteActive() {
  return Boolean(state.personBulkDeleteActive && isPersonBulkDeleteAvailable());
}

function localPersonWorks(works = state.works) {
  return (works || []).filter((work) => work?.id && !work.missingLocal);
}

function clearPersonBulkDeleteSelection() {
  state.personBulkDeleteSelectedIds.clear();
}

function togglePersonBulkDeleteMode(force = undefined) {
  if (!isPersonBulkDeleteAvailable()) return;
  state.personBulkDeleteActive = typeof force === "boolean" ? force : !state.personBulkDeleteActive;
  clearPersonBulkDeleteSelection();
  renderPersonProfile(state.selectedPerson);
  renderPersonWorkStats();
  renderWorks();
}

function togglePersonBulkDeleteSelection(workId) {
  const key = String(workId || "");
  if (!key) return;
  if (state.personBulkDeleteSelectedIds.has(key)) {
    state.personBulkDeleteSelectedIds.delete(key);
  } else {
    state.personBulkDeleteSelectedIds.add(key);
  }
  renderPersonWorkStats();
  renderWorks();
}

function appendPersonBulkDeleteControls(works, wrap) {
  if (!isPersonBulkDeleteActive()) return;
  const localWorks = localPersonWorks(works);
  if (!localWorks.length) return;

  const group = document.createElement("div");
  group.className = "stat-filter-group bulk-delete-controls";

  const selectedCount = [...state.personBulkDeleteSelectedIds].filter((id) => localWorks.some((work) => String(work.id) === id)).length;
  const summary = document.createElement("span");
  summary.className = "stat-inline-summary";
  summary.textContent = `已选 ${formatNumber(selectedCount)} / ${formatNumber(localWorks.length)}`;

  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.className = "stat-filter-chip";
  selectAll.textContent = selectedCount === localWorks.length ? "取消全选" : "全选本地";
  selectAll.addEventListener("click", () => {
    if (selectedCount === localWorks.length) {
      clearPersonBulkDeleteSelection();
    } else {
      for (const work of localWorks) state.personBulkDeleteSelectedIds.add(String(work.id));
    }
    renderPersonWorkStats();
    renderWorks();
  });

  const deleteSelected = document.createElement("button");
  deleteSelected.type = "button";
  deleteSelected.className = "stat-filter-chip danger";
  deleteSelected.disabled = selectedCount === 0;
  deleteSelected.textContent = selectedCount ? `删除已选 ${formatNumber(selectedCount)}` : "删除已选";
  deleteSelected.addEventListener("click", () => deleteSelectedPersonLocalWorks(deleteSelected));

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "stat-filter-chip";
  cancel.textContent = "退出多选";
  cancel.addEventListener("click", () => togglePersonBulkDeleteMode(false));

  group.append(summary, selectAll, deleteSelected, cancel);
  wrap.append(group);
}

async function deleteSelectedPersonLocalWorks(button) {
  if (!isPersonBulkDeleteActive()) return;
  const selectedIds = [...state.personBulkDeleteSelectedIds].filter((id) => state.works.some((work) => String(work.id) === id && !work.missingLocal));
  if (!selectedIds.length) return;
  const personName = state.selectedPerson?.name || "当前演员";
  if (!window.confirm(`确认删除 ${personName} 下已选的 ${selectedIds.length} 个本地作品文件夹？此操作会移动/删除本地文件，不能从页面撤销。`)) return;

  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = `删除中 0/${selectedIds.length}`;
  }

  const failed = [];
  try {
    const result = await api(`/api/people/${encodeURIComponent(state.selectedPersonId)}/local-files/delete`, {
      method: "POST",
      body: { workIds: selectedIds }
    });
    for (const item of result.failed || []) {
      failed.push(`${item.title || item.workId || "作品"}：${item.error || "删除失败"}`);
    }
    if (button?.isConnected) button.textContent = `删除中 ${Math.max(0, Number(result.deletedCount || 0))}/${selectedIds.length}`;
  } catch (error) {
    failed.push(error.message || "批量删除失败");
  }

  clearPersonBulkDeleteSelection();
  if (!failed.length) state.personBulkDeleteActive = false;
  if (state.selectedPersonId) {
    await selectPerson(state.selectedPersonId, { resetFilter: false, replaceRoute: true });
  } else {
    renderPersonWorkStats();
    renderWorks();
  }

  if (failed.length) {
    alert(`有 ${failed.length} 个作品删除失败：${failed.slice(0, 3).join("；")}`);
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function appendMetadataQuickFilters(works, wrap) {
  appendLocalMarkerQuickFilters(works, wrap);

  const groups = [
    ["片商", topInfoValues(works, (info) => [info.maker, info.label], 6)]
  ].filter(([, items]) => items.length);

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
}

function appendLocalMarkerQuickFilters(works, wrap) {
  const count = (works || []).filter((work) => (work.localMarkers || []).includes("A")).length;
  if (!count) return;

  const group = document.createElement("div");
  group.className = "stat-filter-group";
  const heading = document.createElement("span");
  heading.className = "stat-filter-label";
  heading.textContent = "显示";
  group.append(heading);

  const button = document.createElement("button");
  button.type = "button";
  button.className = `stat-filter-chip${workFilterIsActive("localMarkedA") ? " active" : ""}`;
  button.textContent = `显示A ${formatNumber(count)}`;
  button.title = "只显示 A 标记作品";
  button.addEventListener("click", () => setLocalMarkerFilter("A"));
  group.append(button);

  wrap.append(group);
}

function workFilterLabel(filter) {
  return {
    all: "全部",
    playable: "可播放",
    favorite: "已收藏",
    progress: "有进度",
    info: "有资料",
    localOnly: "本地",
    rated: "有评分",
    highRating: "高分",
    vr: "VR",
    hasMagnet: "有磁链",
    localMarkedA: "显示A",
    missingLocal: "未下载",
    missingCover: "无封面"
  }[filter] || "当前";
}

function selectedWorkFilters() {
  return normalizeWorkFilters(state.filterMode);
}

function normalizeWorkFilters(value) {
  const values = Array.isArray(value) ? value : String(value || "all").split(",");
  return [...new Set(values.map((item) => String(item || "").trim()).filter((item) => item && item !== "all"))];
}

function serializedWorkFilterMode() {
  const filters = selectedWorkFilters();
  return filters.length ? filters.join(",") : "all";
}

function workFilterIsActive(value) {
  const filters = selectedWorkFilters();
  return value === "all" ? filters.length === 0 : filters.includes(value);
}

function setWorkFilters(filters) {
  const normalized = normalizeWorkFilters(filters);
  state.filterMode = normalized.length ? normalized.join(",") : "all";
  handleFilterModeChange();
}

function toggleWorkFilter(value) {
  if (value === "all") {
    setWorkFilters([]);
    return;
  }
  const filters = selectedWorkFilters();
  const next = filters.includes(value) ? filters.filter((item) => item !== value) : [...filters, value];
  setWorkFilters(next);
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
  if (state.activeView === "people" && state.selectedPersonId) return state.works;
  if (state.activeView === "codes" && state.selectedCodePrefix) return state.works;
  return selectVisibleWorks(state.works, {
    query: state.activeView === "search" ? "" : state.workQuery,
    filters: selectedWorkFilters(),
    sortMode: state.sortMode,
    showCompilationWorks: state.showCompilationWorks,
    showMissingLocalWorks: state.showMissingLocalWorks,
    includesText,
    workSearchText: (work) => `${workInfoSearchText(work)} ${workPersonSearchText(work)}`,
    isCompilation: isCompilationWork,
    matchesFilter: clientWorkMatchesFilter,
    compareTitle: compareWorkTitle
  });
}

function clientWorkMatchesFilter(work, filter) {
  if (filter === "playable") return work.playableCount > 0;
  if (filter === "favorite") return work.favorite;
  if (filter === "progress") return Boolean(work.progress);
  if (filter === "info") return work.infoCount > 0;
  if (filter === "localOnly") return !work.missingLocal;
  if (filter === "rated") return numericRating(work.infoSummary?.rating) !== null;
  if (filter === "highRating") {
    const rating = numericRating(work.infoSummary?.rating);
    return rating !== null && rating >= 4;
  }
  if (filter === "vr") return isVrWork(work);
  if (filter === "hasMagnet") return Boolean(work.missingLocal && work.availability?.hasMagnet);
  if (filter === "localMarkedA") return (work.localMarkers || []).includes("A");
  if (filter === "missingLocal") return Boolean(work.missingLocal);
  if (filter === "missingCover") return !workCoverUrl(work);
  return true;
}

function isCompilationWork(work) {
  return Boolean(work?.compilation);
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
  searchRequests.cancel();
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
}

function setLocalMarkerFilter(marker = "A") {
  const nextFilter = String(marker || "").toUpperCase() === "A" ? "localMarkedA" : "all";
  state.filterMode = nextFilter;
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
}

async function loadSearchResults(query, options = {}) {
  const normalizedQuery = String(query || "").trim();
  state.workQuery = normalizedQuery;
  if (els.workSearch && els.workSearch.value !== normalizedQuery) {
    els.workSearch.value = normalizedQuery;
  }
  if (!normalizedQuery) {
    searchRequests.cancel();
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
  peoplePage.cancelPendingSelection();
  codePrefixPage.cancelPendingRequests();
  rankingPage.cancelPendingRequests();
  studioPage.cancelPendingRequests();
  collectionPage.cancelPendingRequests();
  if (state.activeView !== "search") {
    state.searchReturnView = state.activeView || "people";
    if (selectedWorkFilters().length) {
      state.filterMode = "all";
    }
    if (state.sortMode === "ranking") {
      state.sortMode = "releaseDesc";
      if (els.sortSelect) els.sortSelect.value = "releaseDesc";
    }
  }

  state.activeView = "search";
  syncNavigationState("search");
  hidePersonProfile();
  setMainHeader(`搜索：${normalizedQuery}`, "全库 · 番号 / 标题 / 文件名 / 人物 / 类别 / 片商");
  els.statsRow.innerHTML = "";
  els.workGrid.innerHTML = `<div class="empty-state">正在全库搜索</div>`;
  state.searchQuery = normalizedQuery;
  state.searchTotal = 0;
  state.searchFacets = null;
  state.searchLoadingMore = false;

  try {
    const data = await searchRequests.fetchPage(normalizedQuery, 0);
    if (!data) return;
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
    renderEmpty(error.message);
  }
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

  const query = state.searchQuery;
  const offset = state.works.length;
  try {
    const data = await searchRequests.fetchPage(query, offset);
    if (!data || state.activeView !== "search" || state.searchQuery !== query) return;
    const seen = new Set(state.works.map((work) => work.id));
    const nextWorks = (data.works || []).filter((work) => !seen.has(work.id));
    state.works.push(...nextWorks);
    state.searchTotal = data.total || state.searchTotal || state.works.length;
    state.searchFacets = data.facets || state.searchFacets || null;
    if (!state.searchPeople.length) state.searchPeople = data.people || [];
    state.workVisibleLimit += state.workPageSize;
    renderSearchStats();
    appendLoadedWorkPage();
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
    state.workVisibleLimit = Math.max(state.workVisibleLimit, state.works.length);
    state.selectedPerson = data.person || state.selectedPerson;
    state.personWorksTotal = data.total || state.personWorksTotal || state.works.length;
    state.personWorksFacets = data.facets || state.personWorksFacets || null;
    renderPersonProfile(state.selectedPerson);
    renderPersonWorkStats();
    appendLoadedWorkPage();
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
  codePrefixPage.disconnectIndexAutoload();
  disconnectWorkLoadMoreAutoload();
  cancelScheduledWorkRendering();
  resetProgressiveCoverLoading();
  const works = visibleWorks();
  els.workGrid.innerHTML = "";
  renderSearchPeoplePanel();

  const serverMore = workServerMoreState(state);
  const hasServerMore = Object.values(serverMore).some(Boolean);
  if (!works.length && !hasServerMore) {
    appendEmpty(emptyMessage);
    return;
  }

  const visible = works.slice(0, state.workVisibleLimit);
  workListRenderer.render(visible, () => {
    if (visible.length < works.length || hasServerMore) {
      appendLoadMore(visible.length, works.length, serverMore);
    }
  });
}

function appendLoadedWorkPage() {
  const works = visibleWorks();
  const visible = works.slice(0, state.workVisibleLimit);
  disconnectWorkLoadMoreAutoload();
  els.workGrid.querySelector(".load-more-row")?.remove();
  appendWorkCardsInPlace({
    activateImages: activateProgressiveCoverImages,
    container: els.workGrid,
    createCard: createWorkCard,
    items: visible
  });

  const serverMore = workServerMoreState(state);
  if (visible.length < works.length || Object.values(serverMore).some(Boolean)) {
    appendLoadMore(visible.length, works.length, serverMore);
  }
}

function cancelScheduledWorkRendering() {
  workListRenderer.cancel();
}

function appendWorkCardBatch(visible, start, end, beforeNode = null) {
  const fragment = document.createDocumentFragment();
  const images = [];
  for (let index = start; index < end; index += 1) {
    const card = createWorkCard(visible[index], index);
    const image = card.querySelector("img.progressive-cover-image[data-src]");
    if (image) images.push(image);
    fragment.append(card);
  }
  if (beforeNode?.isConnected) els.workGrid.insertBefore(fragment, beforeNode);
  else els.workGrid.append(fragment);
  activateProgressiveCoverImages(images);
  return end;
}

function appendLoadMore(visibleCount, totalCount, options = {}) {
  const hasSearchServerMore = Boolean(options.hasSearchServerMore);
  const hasPersonServerMore = Boolean(options.hasPersonServerMore);
  const hasCodePrefixServerMore = Boolean(options.hasCodePrefixServerMore);
  const hasRankingServerMore = Boolean(options.hasRankingServerMore);
  const hasCollectionServerMore = Boolean(options.hasCollectionServerMore);
  const hasVrServerMore = Boolean(options.hasVrServerMore);
  const hasStudioServerMore = Boolean(options.hasStudioServerMore);
  const wrap = document.createElement("div");
  wrap.className = "load-more-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  const serverTotal = state.activeView === "search"
    ? state.searchTotal
    : hasPersonServerMore
      ? state.personWorksTotal
      : hasCodePrefixServerMore
        ? state.codePrefixTotal
        : hasRankingServerMore
          ? state.rankingTotal
          : hasCollectionServerMore
            ? state.collectionTotal
            : hasVrServerMore
              ? state.vrTotal
              : hasStudioServerMore
                ? state.studioWorksTotal
                : null;
  const loadedCount = serverTotal === null ? visibleCount : Math.max(state.works.length, visibleCount);
  const targetCount = serverTotal === null ? totalCount : Math.max(serverTotal, totalCount);
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
      appendLoadedWorkPage();
      return;
    }
    if (hasSearchServerMore) {
      return loadMoreSearchResults(button);
    } else if (hasPersonServerMore) {
      return loadMorePersonWorks(button);
    } else if (hasCodePrefixServerMore) {
      return codePrefixPage.loadMore(button);
    } else if (hasRankingServerMore) {
      return rankingPage.loadMoreRankingWorks(button);
    } else if (hasCollectionServerMore) {
      return collectionPage.loadMoreCollectionWorks(button);
    } else if (hasVrServerMore) {
      return collectionPage.loadMoreVrWorks(button);
    } else if (hasStudioServerMore) {
      return studioPage.loadMoreStudioWorks(button);
    }
  };
  button.addEventListener("click", loadNext);

  wrap.append(button);
  els.workGrid.append(wrap);
  setupWorkLoadMoreAutoload(wrap, button, loadNext);
}

function disconnectWorkLoadMoreAutoload() {
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
    observer?.disconnect();
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

  if (!("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) run();
    },
    { root: null, rootMargin: `${WORK_AUTO_LOAD_DISTANCE}px 0px`, threshold: 0 }
  );
  observer.observe(trigger);
  workLoadMoreScrollCleanup = () => {
    observer.disconnect();
  };
}

function renderEmpty(message) {
  els.workGrid.innerHTML = "";
  appendEmpty(message);
}

function appendEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const stateInfo = emptyStateInfo(message);

  const copy = document.createElement("div");
  copy.className = "empty-state-copy";

  const title = document.createElement("strong");
  title.textContent = stateInfo.title;
  const detail = document.createElement("span");
  detail.textContent = stateInfo.detail;
  copy.append(title, detail);
  empty.append(copy);

  if (stateInfo.actions.length) {
    const actions = document.createElement("div");
    actions.className = "empty-state-actions";
    for (const action of stateInfo.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.primary ? "folder-button" : "text-button";
      button.textContent = action.label;
      button.addEventListener("click", action.run);
      actions.append(button);
    }
    empty.append(actions);
  }
  els.workGrid.append(empty);
}

function emptyStateInfo(message) {
  const activeFilters = selectedWorkFilters();
  const hasFilteredWorks = state.works.length > 0;
  const isPerson = state.activeView === "people" && Boolean(state.selectedPersonId);
  const isCodePrefix = state.activeView === "codes" && Boolean(state.selectedCodePrefix);
  const actions = [];

  if (isPerson) {
    if (hasFilteredWorks || activeFilters.length || state.workQuery.trim()) {
      actions.push({ label: "清除筛选", primary: true, run: clearEmptyStateFilters });
      if (!state.showMissingLocalWorks) actions.push({ label: "显示未下载", run: showMissingLocalFromEmptyState });
      return {
        title: "当前筛选没有作品",
        detail: "这个人物仍在资料库中，换个筛选条件可以继续查看。",
        actions
      };
    }

    actions.push({ label: "返回人物列表", primary: true, run: returnToPeopleIndex });
    if (!state.showMissingLocalWorks) actions.push({ label: "显示未下载", run: showMissingLocalFromEmptyState });
    return {
      title: "本地作品已清空",
      detail: `${state.selectedPerson?.name || "这个人物"}还保留在资料库中，目前没有本地视频文件。`,
      actions
    };
  }

  if (isCodePrefix) {
    if (hasFilteredWorks || activeFilters.length) {
      actions.push({ label: "清除筛选", primary: true, run: clearEmptyStateFilters });
    } else {
      actions.push({ label: "返回番号索引", primary: true, run: () => codePrefixPage.showIndex() });
    }
    if (!state.showMissingLocalWorks) actions.push({ label: "显示未下载", run: showMissingLocalFromEmptyState });
    return {
      title: activeFilters.length ? "当前筛选没有作品" : "这个番号暂无本地作品",
      detail: `${state.selectedCodePrefix || "该番号"}仍可保留为资料库查询入口。`,
      actions
    };
  }

  if (state.activeView === "search") {
    actions.push({ label: "清空搜索", primary: true, run: () => submitWorkSearch("") });
    return {
      title: "没有搜到结果",
      detail: message || "换一个番号、标题、人物或片商继续搜索。",
      actions
    };
  }

  if (activeFilters.length || state.workQuery.trim()) {
    actions.push({ label: "清除筛选", primary: true, run: clearEmptyStateFilters });
    if (!state.showMissingLocalWorks) actions.push({ label: "显示未下载", run: showMissingLocalFromEmptyState });
    return {
      title: "当前条件没有作品",
      detail: message || "调整筛选或搜索条件后再试。",
      actions
    };
  }

  return {
    title: message || "这里暂时没有内容",
    detail: "资料库更新后会显示在这里。",
    actions
  };
}

function clearEmptyStateFilters() {
  clearWorkSearch();
  resetWorkPaging();
  setWorkFilters([]);
}

function showMissingLocalFromEmptyState() {
  state.showMissingLocalWorks = true;
  writeStoredFlag("fanhao.showMissingLocalWorks", true);
  if (els.missingLocalToggle) els.missingLocalToggle.checked = true;
  resetWorkPaging();
  if (state.activeView === "people" && state.selectedPersonId) {
    selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (codePrefixPage.reloadForActiveView()) return;
  renderWorks();
}

function openAdminScript(scriptId = "", options = {}) {
  window.location.assign(adminUrl("scripts", {
    scriptId,
    scriptDefaults: options.defaults || options.scriptDefaults || {}
  }));
}

async function saveCompilationConfig(config) {
  const normalized = normalizeUiConfig(config);
  const data = await api("/api/admin/settings/fanhao", {
    method: "PATCH",
    body: {
      values: {
        compilationPrefixes: normalized.compilationPrefixes,
        compilationKeywords: normalized.compilationKeywords
      }
    }
  });
  state.uiConfig = normalizeUiConfig({ ...state.uiConfig, ...(data.module?.values || {}) });
  resetWorkPaging();
  if (state.activeView === "people" && !state.selectedPersonId) {
    renderPeopleIndexStats();
    renderPeopleIndex();
  } else {
    renderWorks();
  }
  return state.uiConfig;
}

async function refreshRankingsFromLibrary(event) {
  const button = event?.currentTarget;
  const originalText = button?.textContent || "刷新缓存";
  if (button) {
    button.disabled = true;
    button.textContent = "启动中";
  }
  try {
    await api("/api/admin/refresh-rankings", {
      method: "POST",
      body: { key: state.selectedRankingKey || "y2025", sleep: 2 }
    });
    window.location.assign(adminUrl("tasks"));
  } catch (error) {
    toastInline(button, error.message || "启动失败", originalText);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
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
  for (const img of activeCoverImages) {
    cancelActiveCoverImage(img);
  }
  coverLoadQueue = [];
}

function bindProgressiveCoverLifecycle(root) {
  if (!root || !("MutationObserver" in globalThis)) return;
  const observer = new MutationObserver(() => {
    for (const img of activeCoverImages) {
      if (!root.contains(img)) cancelActiveCoverImage(img);
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}

function cancelActiveCoverImage(img) {
  activeCoverImages.delete(img);
  img.dataset.coverCancelled = "1";
  img.removeAttribute("src");
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
  img.dataset.coverIndex = String(index);
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

function activateProgressiveCoverImages(images = []) {
  const observer = ensureCoverLoadObserver();
  images.forEach((img) => {
    const index = Math.max(0, Number(img.dataset.coverIndex) || 0);
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
    if (!img.isConnected || img.dataset.coverCancelled === "1" || img.classList.contains("loaded")) return;
    activeCoverImages.add(img);
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
  delete img.dataset.coverCancelled;
  delete img.dataset.src;
  activeCoverImages.add(img);

  img.addEventListener(
    "load",
    () => {
      activeCoverImages.delete(img);
      if (img.dataset.coverCancelled === "1") return;
      cover?.querySelector(".placeholder-cover")?.remove();
      img.classList.add("loaded");
    },
    { once: true }
  );
  img.addEventListener(
    "error",
    () => {
      activeCoverImages.delete(img);
      if (img.dataset.coverCancelled === "1") return;
      retryCoverImage(img, src);
    }
  );
  img.src = src;
}

function createWorkCard(work, index = 0) {
  const card = document.createElement("article");
  card.className = `work-card${work.missingLocal ? " missing-local" : ""}`;
  card.dataset.workId = work.id;
  if (isPersonBulkDeleteActive() && state.personBulkDeleteSelectedIds.has(String(work.id))) {
    card.classList.add("bulk-delete-selected");
  }

  const cover = document.createElement("button");
  cover.type = "button";
  cover.className = "cover-wrap work-card-main";
  cover.setAttribute("aria-label", work.missingLocal ? `打开 JavDB：${work.title}` : `打开作品：${work.title}`);
  cover.addEventListener("click", () => handleWorkCardPrimaryClick(work));

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
    toggleFavorite(work.id, favorite);
  });

  if (work.progress?.percent) {
    const track = document.createElement("div");
    track.className = "progress-track";
    track.innerHTML = `<div class="progress-fill" style="width:${Math.min(100, Math.max(0, work.progress.percent)).toFixed(1)}%"></div>`;
    cover.append(track);
  }

  const body = document.createElement("div");
  body.className = "work-body";
  body.addEventListener("click", () => handleWorkCardPrimaryClick(work));

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
  for (const chip of createAvailabilityChips(work)) flags.append(chip);
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

  body.append(title);
  body.append(facts);
  if (flags.childElementCount) body.append(flags);
  if (work.missingLocal) {
    card.append(cover, body);
  } else {
    cover.dataset.playbackWorkId = String(work.id);
    body.dataset.playbackWorkId = String(work.id);
    card.append(cover, favorite, createLocalMarkerButton(work, "A"));
    if (isPersonBulkDeleteActive()) card.append(createBulkDeleteSelectButton(work));
    card.append(body);
  }
  return card;
}

function createBulkDeleteSelectButton(work) {
  const selected = state.personBulkDeleteSelectedIds.has(String(work.id));
  const button = document.createElement("button");
  button.type = "button";
  button.className = `bulk-delete-select${selected ? " active" : ""}`;
  button.textContent = selected ? "✓" : "";
  button.title = selected ? "取消选择" : "选择删除";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(selected));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePersonBulkDeleteSelection(work.id);
  });
  return button;
}

function handleWorkCardPrimaryClick(work) {
  if (isPersonBulkDeleteActive() && !work.missingLocal) {
    togglePersonBulkDeleteSelection(work.id);
    return;
  }
  openWorkCard(work);
}

function createLocalMarkerButton(work, marker) {
  const key = String(marker || "").toUpperCase();
  const active = (work.localMarkers || []).includes(key);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `local-marker-button${active ? " active" : ""}`;
  button.textContent = localMarkerButtonLabel(key, active);
  button.title = active ? `移除 ${key} 标记` : `添加 ${key} 标记`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleWorkLocalMarker(work, key, button);
  });
  return button;
}

function localMarkerButtonLabel(key, active) {
  return key;
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

async function toggleWorkLocalMarker(work, marker, button) {
  const key = String(marker || "").toUpperCase();
  const nextEnabled = !(work.localMarkers || []).includes(key);
  const originalText = button.textContent;
  const compactButton = button.classList.contains("local-marker-button");
  button.disabled = true;
  button.textContent = compactButton ? localMarkerButtonLabel(key, nextEnabled) : (nextEnabled ? "标记中" : "移除中");
  try {
    const data = await api(`/api/works/${encodeURIComponent(work.id)}/local-marker`, {
      method: "POST",
      body: { marker: key, enabled: nextEnabled }
    });
    if (data.work) {
      updateWorkSnapshot(data.work);
      if (state.activeView === "codes" && state.selectedCodePrefix) codePrefixPage.renderDetailStats();
      else renderStatsForWorks(state.works, state.selectedPerson);
      if (state.activeView === "favorites") renderFavoriteFolderControls();
      renderWorks();
    }
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = originalText;
  }
}

function openWorkCard(work) {
  if (work.missingLocal) {
    if (work.javdbUrl) {
      window.open(work.javdbUrl, "_blank", "noreferrer");
    }
    return;
  }
  void playbackPrefetch.prepare(work.id);
  window.open(playerPageUrl(work.id), "_blank", "noopener");
}

function playerPageUrl(workId, videoId = "") {
  const params = new URLSearchParams({ workId: String(workId || "") });
  if (videoId) params.set("videoId", String(videoId));
  return `/player.html?${params.toString()}`;
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
  if (sourcePath.startsWith("r:/")) return { label: "欧美 · R:", vr: false };
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

function createAvailabilityChips(work) {
  const availability = work.availability || {};
  if (work.missingLocal && availability.hasMagnet === true) {
    return [createInfoChip(availability.hasSubtitles ? "中字磁链" : "含磁链", "magnet")];
  }
  return [];
}

els.workSearch.addEventListener("input", () => {
  window.clearTimeout(state.searchTimer);
  const query = els.workSearch.value.trim();
  if (!query || globalThis.navigator?.connection?.saveData) return;
  state.searchTimer = window.setTimeout(() => searchRequests.prefetch(query), 160);
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

els.missingLocalToggle?.addEventListener("change", (event) => {
  state.showMissingLocalWorks = Boolean(event.target.checked);
  writeStoredFlag("fanhao.showMissingLocalWorks", state.showMissingLocalWorks);
  resetWorkPaging();
  if (state.activeView === "people" && state.selectedPersonId) {
    selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (codePrefixPage.reloadForActiveView()) return;
  renderWorks();
});

els.collectionToggle?.addEventListener("change", (event) => {
  state.showCompilationWorks = Boolean(event.target.checked);
  writeStoredFlag("fanhao.showCompilationWorks", state.showCompilationWorks);
  resetWorkPaging();
  if (state.activeView === "people" && state.selectedPersonId) {
    selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (codePrefixPage.reloadForActiveView()) return;
  if (state.activeView === "people" && !state.selectedPersonId) {
    renderPeopleIndexStats();
    renderPeopleIndex();
    return;
  }
  renderWorks();
});

els.backToPeopleIndex?.addEventListener("click", () =>
  state.activeView === "codes" ? codePrefixPage.showIndex() : returnToPeopleIndex());

for (const button of els.viewTabs) {
  const prefetchCollection = () => collectionPage.prefetch(button.dataset.view);
  button.addEventListener("pointerenter", prefetchCollection, { passive: true });
  button.addEventListener("pointerdown", prefetchCollection, { passive: true });
  button.addEventListener("focus", prefetchCollection);
  button.addEventListener("click", () => {
    clearWorkSearch();
    if (codePrefixPage.handleNavigationButton(button)) return;
    setActiveView(button.dataset.view);
  });
}

els.compilationConfigButton?.addEventListener("click", () => {
  window.location.assign(adminUrl("settings"));
});

window.addEventListener("popstate", () => {
  if (!state.routeReady) return;
  applyRoute(routeFromUrl()).catch((error) => {
    console.error(error);
  });
});

installAndroidClientReturn({ isAndroidClient, initialParams });

async function bootApp() {
  const initialRoute = routeFromUrl();
  collectionPage.prefetch(initialRoute.view);
  const moduleNavigationPromise = initializeModuleNavigation();
  await applyRoute(initialRoute);
  document.documentElement.classList.remove("app-module-loading");
  initializeRouteHistory();
  if (!state.library) {
    ensureLibraryLoaded({ deferMainRender: true }).catch((error) => {
      console.error("[library]", error);
    });
  }
  await moduleNavigationPromise;
}

await bootApp().catch((error) => {
  renderEmpty(error.message);
  document.documentElement.classList.remove("app-module-loading");
});

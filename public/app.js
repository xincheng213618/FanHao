import { createApiClient } from "./js/api.js?v=20260812-collection-busy-01";
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
  resolveWorkPage,
  selectVisibleWorks,
  workServerMoreState
} from "./modules/fanhao/index.js?v=20261023-traits-01";
import { createBrowseNavigation } from "./modules/fanhao/browse-navigation.js?v=20260919-browse-01";
import { installWorkSearchShortcut } from "./modules/fanhao/search-shortcut.js?v=20261028-search-shortcut-01";
import { createReadRecoveryPanel, createSearchRecoveryPanel } from "./modules/fanhao/search-recovery.js";
import { createBrowseFilterControls, nextBrowseFilters } from "./modules/fanhao/browse-filters.js?v=20261023-inline-filters-03";
import { createBrowseTraitControls, createWorkEditionBadges, createWorkTagButtons, loadedTraitFacets, traitFilterLabel, workMatchesTraitFilter } from "./modules/fanhao/browse-traits.js?v=20261023-traits-wrap-02";
import { createLatestRequestGate } from "./modules/fanhao/latest-request.js?v=20260717-fanhao-latest-request-01";
import { adminUrl } from "./js/admin-navigation.js?v=20260727-admin-merge-01";
import { createLazyPersonProfile } from "./modules/fanhao/lazy-person-profile.js?v=20260717-fanhao-lazy-person-01";
import { PEOPLE_SCOPE_NAMES, URL_VIEW_NAMES, normalizeRoute, routeFromUrl, routeUrl } from "./js/router.js?v=20260724-code-prefix-catalog-01";

const browseTextCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

prepareAppShell();
prepareClientShell();

const state = {
  ...createFanhaoState({ readStoredFlag }),
  personWorksTraitFacets: null,
  searchTraitFacets: null,
  codePrefixTraitFacets: null,
  studioWorksTraitFacets: null,
  collectionTraitFacets: null,
  vrTraitFacets: null,
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
  viewTabs: [...document.querySelectorAll(".view-tab[data-view]")],
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
const libraryRequests = createLatestRequestGate();
let navigationSequence = 0;
let searchLoadMoreOwner = null;
const workLocalMarkerWrites = new Map();
const workLocalMarkerReads = new Set();
const workLocalMarkerForegroundReads = new Set();
let workLocalMarkerPresentation = null;
let pendingWorkFilterFocus = null;
const browseNavigation = createBrowseNavigation();
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
const api = createWorkLocalMarkerApi(createApiClient({ isAndroidClient }));
const playbackPrefetch = createPlaybackPrefetch({ api });
playbackPrefetch.bindContainer(els.workGrid);
bindProgressiveCoverLifecycle(els.workGrid);
const workListRenderer = createViewportBatchRenderer({
  container: els.workGrid,
  appendBatch: appendWorkCardBatch
});
const searchRequests = createSearchRequestService({
  api,
  onWorkRead: beginWorkLocalMarkerForegroundRead,
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
    syncNavigationState(state.activeView);
  } catch (error) {
    console.warn("[modules]", error.message || error);
  }
}
const peoplePage = createPeoplePage({
  api,
  onWorkRead: beginWorkLocalMarkerForegroundRead,
  appendEmpty,
  appendLoadedWorkPage,
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
  onNavigationStarted: beginNavigation,
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
  toastInline,
  workCoverUrl
});
const codePrefixPage = createCodePrefixPage({
  api,
  onWorkRead: beginWorkLocalMarkerForegroundRead,
  appendEmpty,
  appendLoadedWorkPage,
  appendWorkControls,
  clearWorkFilter,
  clearWorkSearch,
  els,
  formatNumber,
  hidePersonProfile,
  isNavigationCurrent: (intent) => intent === navigationSequence,
  onNavigationStarted: beginNavigation,
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
    const { createPersonProfile } = await import("./modules/fanhao/person-profile.js?v=20261023-person-aliases-01");
    return createPersonProfile({
      api,
      coverUrl,
      els,
      formatLibraryPath,
      formatNumber,
      linesFromTextarea,
      normalizeSourcePath,
      renderPeople: renderPeopleIndex,
      selectPerson,
      showPeopleIndex,
      sourcePriority,
      state,
      workCoverUrl
    });
  },
  onLoadError: (error) => console.warn("[person-profile]", error?.message || error)
});
const {
  isFavoriteFolderPending,
  isFavoritePending,
  moveFavoriteToFolder,
  toggleFavorite,
  updateWorkSnapshot
} = createWorkActions({
  api,
  beginFavoriteUi: beginWorkFavoriteUi,
  onCollectionStateChanged: (change) => collectionPage.onCollectionStateChanged(change),
  renderFavoriteFolderControls,
  renderStatsForWorks,
  renderWorks,
  state
});

function beginWorkFavoriteUi({ workId, control, syncControl, showError, kind = "favorite", requestedFolderId = "" }) {
  if (!control) return null;
  if (kind === "folder") syncFavoriteFolderRetry(control, true);
  else syncFavoriteErrorDismiss(control, true);
  const grid = els.workGrid;
  const owner = navigationSequence;
  const view = state.activeView;
  const hadFocus = document.activeElement === control;
  const events = new AbortController();
  let newerIntent = false;
  const folderRecoveryPanel = kind === "folder" ? control.closest(".work-card")?.querySelector(":scope > .favorite-folder-error") : null;
  const folderRetry = folderRecoveryPanel?.querySelector(".favorite-folder-retry");
  const favoriteRecoveryPanel = kind === "favorite" ? control.closest(".work-card")?.querySelector(":scope > .favorite-error") : null;
  const favoriteDismiss = favoriteRecoveryPanel?.querySelector(".favorite-error-dismiss");
  let newerRecoveryViewportGesture = false;
  let newerFavoriteRecoveryViewportGesture = false;
  const noteIntent = event => {
    if (event.type !== "focusin" || event.target !== document.body) newerIntent = true;
    if (favoriteRecoveryPanel && ["pointerdown", "keydown", "wheel", "touchmove"].includes(event.type)
      && !(event.type === "pointerdown" && favoriteDismiss?.contains(event.target))
      && (event.type !== "keydown" || ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)
        || (event.key === " " && event.target?.tagName !== "BUTTON"))) newerFavoriteRecoveryViewportGesture = true;
    if (!folderRetry || !["pointerdown", "keydown", "wheel", "touchmove"].includes(event.type)) return;
    if (event.type === "pointerdown" && folderRetry.contains(event.target)) return;
    if (event.type === "keydown" && !["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)
      && !(event.key === " " && event.target?.tagName !== "BUTTON")) return;
    newerRecoveryViewportGesture = true;
  };
  const intentEvents = ["pointerdown", "keydown", "wheel", "touchmove", "focusin"];
  if (kind !== "folder") intentEvents.push("scroll");
  for (const type of intentEvents) {
    document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: events.signal });
  }
  const ownsOrigin = () => owner === navigationSequence && view === state.activeView
    && control.isConnected && grid === els.workGrid && grid.contains(control);
  return {
    settle({ error, removedWorkIds = [], favoriteFolderId = "" }) {
      const current = ownsOrigin();
      const work = state.works.find(item => String(item.id) === String(workId));
      const cards = [...grid.querySelectorAll(".work-card")].filter(card => card.dataset.workId === String(workId));
      if (work) {
        for (const card of cards) {
          const favorite = card.querySelector(".favorite-button");
          if (favorite) syncControl(favorite, work.favorite, isFavoritePending(workId));
          if (kind === "folder") {
            const select = card.querySelector(".favorite-folder-select");
            if (select) {
              select.value = work.favoriteFolderId || "default";
              select.disabled = isFavoriteFolderPending(workId);
            }
          }
        }
      }
      if (kind === "folder") syncFavoriteFolderRetry(control, false);
      else syncFavoriteErrorDismiss(control, isFavoritePending(workId));
      if (error) {
        if (kind === "folder") {
          if (current) showFavoriteFolderError(workId, control, error, requestedFolderId, ownsOrigin);
        } else {
          if (current) showFavoriteError(workId, control, error, ownsOrigin);
        }
        return true;
      }
      if (kind === "folder") clearFavoriteFolderError(control, ownsOrigin, !newerRecoveryViewportGesture);
      else clearFavoriteError(control, ownsOrigin, !newerFavoriteRecoveryViewportGesture);
      if (kind === "folder" && favoriteFolderId) {
        const destinationRoute = normalizeRoute(routeFromUrl());
        if (destinationRoute.view === "favorites" && collectionPage.refreshMovedFavorite(workId, favoriteFolderId)) return true;
      }
      const foldersSynced = kind === "folder" && state.activeView === "favorites" && cards.length
        && collectionPage.refreshFavoriteFolderCounts();
      if (!current) {
        // A confirmed removal can affect a newer favorites page containing the
        // same work. Reconcile membership without rebuilding its other cards.
        if (state.activeView === "favorites" && !work && removedWorkIds.includes(String(workId)) && grid.querySelector(".work-card")) {
          const retainedFocus = grid.contains(document.activeElement) ? document.activeElement : null;
          cancelScheduledWorkRendering();
          renderStatsForWorks(state.works);
          renderFavoriteFolderControls();
          if (state.works.length) appendLoadedWorkPage();
          else renderWorks("还没有收藏。");
          if (retainedFocus?.isConnected && grid.contains(retainedFocus) && document.activeElement === document.body) {
            retainedFocus.focus({ preventScroll: true });
          }
        } else if (!grid.contains(control) && work && !work.favorite && cards.length && selectedWorkFilters().includes("favorite")) {
          const route = normalizeRoute(routeFromUrl());
          if (state.activeView !== "search" || (route.view === "search" && route.q === state.searchQuery)) {
            refreshFavoriteFilteredWorks();
          }
        }
        return true;
      }
      if (state.activeView === "favorites") {
        if (kind === "folder" && !removedWorkIds.length && foldersSynced) return true;
        return false;
      }
      if (work && !work.favorite && cards.length && selectedWorkFilters().includes("favorite")) {
        refreshFavoriteFilteredWorks();
        return true;
      }
      return true;
    },
    finish() {
      events.abort();
      if (kind === "folder") syncFavoriteFolderRetry(control, false);
      else syncFavoriteErrorDismiss(control, isFavoritePending(workId));
      if (hadFocus && !newerIntent && ownsOrigin()) {
        if (kind === "folder") focusWorkRecoveryControl(control, ownsOrigin);
        else control.focus({ preventScroll: true });
      }
    }
  };
}

function syncFavoriteErrorDismiss(control, pending) {
  const dismiss = control.closest(".work-card")?.querySelector(":scope > .favorite-error .favorite-error-dismiss");
  if (!dismiss) return;
  dismiss.setAttribute("aria-disabled", String(pending));
  dismiss.setAttribute("aria-busy", String(pending));
}

function showFavoriteError(workId, control, error, ownsOrigin) {
  const card = control.closest(".work-card");
  if (!card || card.parentNode !== els.workGrid) return;
  let panel = card.querySelector(":scope > .favorite-error");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "favorite-error";
    const title = document.createElement("strong");
    title.textContent = "收藏操作未确认";
    const message = document.createElement("div");
    message.className = "favorite-error-message";
    message.id = `favorite-error-${encodeURIComponent(workId)}`;
    message.setAttribute("role", "alert");
    message.setAttribute("aria-atomic", "true");
    message.setAttribute("aria-label", "收藏操作未确认原因，可滚动查看");
    message.tabIndex = 0;
    const hint = document.createElement("div");
    hint.textContent = "可刷新页面核对当前收藏状态";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "favorite-error-dismiss";
    dismiss.textContent = "关闭提示";
    dismiss.setAttribute("aria-label", "关闭收藏操作未确认提示");
    panel.append(title, message, hint, dismiss);
    card.append(panel);
  }
  const message = panel.querySelector(".favorite-error-message");
  message.textContent = error.message || "未能确认收藏结果";
  control.setAttribute("aria-describedby", message.id);
  const dismiss = panel.querySelector(".favorite-error-dismiss");
  dismiss.setAttribute("aria-describedby", message.id);
  dismiss.onclick = event => {
    event.stopPropagation();
    if (!ownsOrigin() || panel.parentNode !== card || !dismiss.isConnected || isFavoritePending(workId)) return;
    clearFavoriteError(control, ownsOrigin);
  };
  syncFavoriteErrorDismiss(control, isFavoritePending(workId));
}

function clearFavoriteError(control, ownsOrigin, reveal = true) {
  const panel = control.closest(".work-card")?.querySelector(":scope > .favorite-error");
  if (!panel) return;
  const restoreFocus = panel.contains(document.activeElement) && ownsOrigin() && !control.disabled;
  panel.remove();
  control.removeAttribute("aria-describedby");
  if (restoreFocus) focusWorkRecoveryControl(control, ownsOrigin, reveal);
}

function syncFavoriteFolderRetry(control, pending) {
  const retry = control.closest(".work-card")?.querySelector(":scope > .favorite-folder-error .favorite-folder-retry");
  if (!retry) return;
  retry.setAttribute("aria-disabled", String(pending));
  retry.setAttribute("aria-busy", String(pending));
  retry.textContent = pending ? "正在重试…" : "重试";
}

function showFavoriteFolderError(workId, control, error, requestedFolderId, ownsOrigin) {
  const card = control.closest(".work-card");
  if (!card || card.parentNode !== els.workGrid) return;
  let panel = card.querySelector(":scope > .favorite-folder-error");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "favorite-folder-error";
    const title = document.createElement("strong");
    title.textContent = "收藏夹未更改";
    const message = document.createElement("div");
    message.className = "favorite-folder-error-message";
    message.id = `favorite-folder-error-${encodeURIComponent(workId)}`;
    message.setAttribute("role", "alert");
    message.setAttribute("aria-atomic", "true");
    message.setAttribute("aria-label", "收藏夹移动失败原因，可滚动查看");
    message.tabIndex = 0;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "favorite-folder-retry";
    retry.setAttribute("aria-label", "重试移动收藏夹");
    panel.append(title, message, retry);
    card.append(panel);
  }
  const message = panel.querySelector(".favorite-folder-error-message");
  message.textContent = error.message || "移动失败，请重试";
  control.setAttribute("aria-describedby", message.id);
  const retry = panel.querySelector(".favorite-folder-retry");
  retry.setAttribute("aria-describedby", message.id);
  retry.onclick = event => {
    event.stopPropagation();
    if (!ownsOrigin() || panel.parentNode !== card || !retry.isConnected || isFavoriteFolderPending(workId)) return;
    const work = state.works.find(item => String(item.id) === String(workId));
    if (work) void moveFavoriteToFolder(work, requestedFolderId, control);
  };
  syncFavoriteFolderRetry(control, false);
}

function focusWorkRecoveryControl(control, ownsOrigin, reveal = true) {
  control.focus({ preventScroll: true });
  if (!reveal || !control.isConnected || document.activeElement !== control || !ownsOrigin()) return;
  const header = document.querySelector(".product-topbar")?.getBoundingClientRect();
  const top = Math.max(0, Math.min(window.innerHeight, header && header.top < window.innerHeight ? header.bottom : 0)) + 8;
  const bottom = window.innerHeight - 8;
  const rect = control.getBoundingClientRect();
  const delta = rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
  if (delta) window.scrollBy({ top: delta, left: 0, behavior: "instant" });
}

function clearFavoriteFolderError(control, ownsOrigin, reveal = true) {
  const panel = control.closest(".work-card")?.querySelector(":scope > .favorite-folder-error");
  if (!panel) return;
  const restoreFocus = panel.contains(document.activeElement) && ownsOrigin();
  panel.remove();
  control.removeAttribute("aria-describedby");
  if (restoreFocus) focusWorkRecoveryControl(control, ownsOrigin, reveal);
}

function refreshFavoriteFilteredWorks() {
  let refreshing;
  if (state.activeView === "people" && state.selectedPersonId) {
    refreshing = selectPerson(state.selectedPersonId, { resetFilter: false, reusePrefetch: false });
  } else if (state.activeView === "codes" && state.selectedCodePrefix) {
    refreshing = codePrefixPage.reloadSelected();
  } else if (state.activeView === "studios" && state.selectedStudio) {
    studioPage.cancelPendingRequests();
    refreshing = studioPage.loadStudioDetail(state.selectedStudio.id, state.selectedStudioSeriesId);
  } else if (state.activeView === "search") {
    searchRequests.cancel();
    refreshing = loadSearchResults(state.searchQuery, { replaceRoute: true, preserveSearchDraft: true });
  } else if (state.activeView === "history") {
    refreshing = collectionPage.loadHistory();
  } else if (state.activeView === "vr") {
    refreshing = collectionPage.loadVrWorks();
  } else {
    renderWorks();
    return;
  }
  const refreshOwner = navigationSequence;
  Promise.resolve(refreshing).catch(error => {
    if (refreshOwner === navigationSequence) renderEmpty(error.message || "收藏筛选刷新失败");
  });
}

const collectionPage = createCollectionPage({
  api,
  onWorkRead: beginWorkLocalMarkerForegroundRead,
  appendLoadedWorkPage,
  els,
  formatNumber,
  getNavigationIntent: () => navigationSequence,
  hidePersonProfile,
  renderEmpty,
  renderReadError: renderCollectionReadError,
  renderStatsForWorks,
  renderWorks,
  resetWorkPaging,
  setMainHeader,
  state
});

function renderCollectionReadError({ view, message, isCurrent, retry }) {
  const labels = { favorites: "收藏", history: "观看记录", vr: "VR 作品" };
  els.workGrid.replaceChildren(createReadRecoveryPanel({
    message, isCurrent, retry,
    heading: `${labels[view]}暂时无法读取`, hintText: "重新读取会保留当前栏目和筛选条件。",
    retryLabel: "重新读取", className: "collection-error-state", retryClass: "collection-retry-button",
    getFocusTarget: () => els.workGrid.querySelector(".collection-retry-button") || els.currentTitle
  }));
}

function renderLibraryReadError(route, error, navigationIntent) {
  const owner = { navigationIntent };
  const isCurrent = () => owner.navigationIntent === navigationSequence;
  cancelScheduledWorkRendering();
  hidePersonProfile();
  els.statsRow.replaceChildren();
  setMainHeader("资料库", "重新读取以继续浏览。");
  els.workGrid.replaceChildren(createReadRecoveryPanel({
    message: error?.message || "暂时无法载入资料库。", isCurrent,
    heading: "资料库暂时无法读取", hintText: "重新读取会保留当前页面地址和浏览条件。",
    retryLabel: "重新载入", className: "library-error-state", retryClass: "library-retry-button",
    retry() {
      collectionPage.invalidatePrefetches();
      const pending = applyRoute(route, { preserveSearchDraft: true });
      owner.navigationIntent = navigationSequence;
      return pending;
    },
    getFocusTarget: () => els.workGrid.querySelector(".library-retry-button") || els.currentTitle
  }));
}
const studioPage = createStudioPage({
  api,
  onWorkRead: beginWorkLocalMarkerForegroundRead,
  appendLoadedWorkPage,
  appendEmpty,
  els,
  formatNumber,
  getWorkFilterMode: serializedWorkFilterMode,
  hidePersonProfile,
  onNavigationStarted: beginNavigation,
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
    state.personWorksTraitFacets = null;
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

function initializeRouteHistory({ preserveUrl = false } = {}) {
  if (state.routeReady) return;
  state.routeReady = true;
  if (!preserveUrl) replaceRoute();
}

function beginNavigation(options = {}) {
  if (options.navigationIntent !== undefined) return options.navigationIntent;
  state.restoringRoute = false;
  return ++navigationSequence;
}

async function applyRoute(route, options = {}) {
  const navigationIntent = beginNavigation();
  const isCurrent = () => navigationIntent === navigationSequence;
  const next = normalizeRoute(route);
  if (["gallery", "novels", "music", "tools", "shortVideos"].includes(next.view)) {
    window.location.replace(routeUrl(next, { initialParams }));
    return;
  }
  try {
    if (routeNeedsLibrary(next)) {
      await ensureLibraryLoaded({ deferMainRender: true });
    }
    if (!isCurrent()) return false;
    state.restoringRoute = true;
    if (next.view === "search") {
      state.workQuery = next.q;
      els.workSearch.value = next.q;
      await loadSearchResults(next.q, { skipRoute: true, navigationIntent });
    } else if (next.view === "codes") {
      await codePrefixPage.applyRoute(next, { navigationIntent, preserveSearchDraft: options.preserveSearchDraft });
    } else if (next.view === "people") {
      if (!await setPeopleScope(next.peopleScope || "main") || !isCurrent()) return;
      if (!options.preserveSearchDraft) clearWorkSearch();
      const routePerson = next.personId
        ? state.people.find((person) => person.id === next.personId)
        : null;
      if (routePerson) {
        await selectPerson(routePerson.id, {
          resetFilter: false,
          navigationIntent,
          captureIndexScroll: false,
          skipRoute: routePerson.id === next.personId,
          replaceRoute: routePerson.id !== next.personId
        });
      } else if (next.personId) {
        await selectPerson(next.personId, {
          resetFilter: false,
          navigationIntent,
          captureIndexScroll: false,
          replaceRoute: true
        });
      } else {
        showPeopleIndex({ restoreScroll: true, skipRoute: true, navigationIntent });
      }
    } else {
      if (!options.preserveSearchDraft) clearWorkSearch();
      setActiveView(next.view, { skipRoute: true, navigationIntent });
    }

    if (isCurrent() && next.workId) {
      window.location.href = playerPageUrl(next.workId, next.videoId || "");
    }
    return isCurrent();
  } catch (error) {
    if (isCurrent()) renderLibraryReadError(next, error, navigationIntent);
    return false;
  } finally {
    if (isCurrent()) state.restoringRoute = false;
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
  const request = libraryRequests.begin();
  const scope = normalizePeopleScope(state.peopleScope);
  const params = new URLSearchParams();
  if (scope !== "main") params.set("scope", scope);
  try {
    const data = await api(`/api/library${params.toString() ? `?${params}` : ""}`, { signal: request.signal });
    if (!request.isCurrent() || state.peopleScope !== scope) return null;
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
    return data;
  } catch (error) {
    if (!request.isCurrent()) return null;
    throw error;
  } finally {
    request.finish();
  }
}

let libraryLoadPromise = null;
let libraryLoadScope = "";

function routeNeedsLibrary(route) {
  return Boolean(route?.view && route.view !== "search");
}

async function ensureLibraryLoaded(options = {}) {
  const scope = normalizePeopleScope(state.peopleScope);
  if (state.library && normalizePeopleScope(state.library.scope) === scope) return state.library;
  if (!libraryLoadPromise || libraryLoadScope !== scope) {
    libraryLoadScope = scope;
    const pending = loadLibrary(options)
      .finally(() => {
        if (libraryLoadPromise === pending) libraryLoadPromise = null;
      });
    libraryLoadPromise = pending;
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
    libraryRequests.cancel();
    peoplePage.cancelPendingSelection();
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    state.filterMode = "all";
  }
  const data = options.force
    ? await loadLibrary({ deferMainRender: true })
    : await ensureLibraryLoaded({ deferMainRender: true });
  return Boolean(data && state.peopleScope === nextScope);
}

async function navigatePeopleScope(scope) {
  const navigationIntent = beginNavigation();
  if (!await setPeopleScope(scope) || navigationIntent !== navigationSequence) return false;
  setActiveView("people", { navigationIntent });
  return true;
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
    return browseTextCollator.compare(displayPersonName(a), displayPersonName(b));
  });
}

function productViewForActiveView(view = state.activeView) {
  return "people";
}

function syncProductShell(view = state.activeView) {
  document.body.classList.add("fanhao-view");
  document.body.classList.remove("standalone-module-view");
  const isWesternBranch = (state.peopleScope || "main") === "western";
  document.body.classList.toggle("western-branch-view", isWesternBranch);
  const sidebar = document.querySelector(".fanhao-sidebar");
  const sidebarEyebrow = sidebar?.querySelector(".fanhao-sidebar-heading .eyebrow");
  const sidebarTitle = sidebar?.querySelector(".fanhao-sidebar-heading h2");
  if (sidebar) sidebar.setAttribute("aria-label", isWesternBranch ? "欧美分支菜单" : "番号二级菜单");
  if (sidebarEyebrow) sidebarEyebrow.textContent = isWesternBranch ? "欧美" : "番号";
  if (sidebarTitle) sidebarTitle.textContent = isWesternBranch ? "R 盘分支" : "资料库";
  document.title = isWesternBranch ? "欧美 · FanHao" : "个人视频资料库";
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
    return productViewForActiveView(view) === "people"
      && (buttonScope === "main" || (state.peopleScope || "main") === buttonScope);
  }
  return false;
}

function syncNavigationState(view = state.activeView) {
  syncProductShell(view);
  for (const button of els.productTabs || []) {
    const active = productButtonActive(button, view);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const button of els.viewTabs || []) {
    const activeView = view === "search" ? state.searchReturnView || "people" : view;
    const peopleScope = button.dataset.peopleScope;
    const active = peopleScope
      ? activeView === "people" && (state.peopleScope || "main") === peopleScope
      : codePrefixPage.navigationButtonActive(button, activeView) ?? button.dataset.view === activeView;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  browseNavigation.sync();
}

function setActiveView(view, options = {}) {
  options = { ...options, navigationIntent: beginNavigation(options) };
  view = URL_VIEW_NAMES.has(view) ? view : "people";
  if (["gallery", "novels", "music", "tools", "shortVideos"].includes(view)) {
    window.location.assign(routeUrl({ view }, { initialParams }));
    return;
  }
  if (view !== "people") peoplePage.cancelPendingSelection();
  if (view !== "codes") codePrefixPage.cancelPendingRequests();
  if (view !== "search") {
    searchRequests.cancel();
    resetSearchPagination();
  }
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
    state.searchTraitFacets = null;
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
    studioPage.loadStudios(options);
    syncRouteAfterNavigation(options);
    return;
  }

  if (view === "vr") {
    if (previousView !== "vr" && !options.keepFilter) state.filterMode = "all";
    collectionPage.loadVrWorks();
    syncRouteAfterNavigation(options);
    return;
  }

  showPeopleIndex({ ...options, skipRoute: true });
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
  const indexOnly = (state.activeView === "people" && !state.selectedPersonId)
    || (state.activeView === "codes" && !state.selectedCodePrefix)
    || (state.activeView === "studios" && !state.selectedStudio);
  els.missingLocalToggle.closest(".toolbar-controls").hidden = indexOnly;
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
  ["localMarkedA", "A 标记"],
  ["playable", "可播放"],
  ["favorite", "已收藏"],
  ["progress", "有进度"],
  ["info", "有资料"],
  ["localOnly", "本地记录"],
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
  els.filterList = createBrowseFilterControls({
    options: WORK_FILTER_OPTIONS, filters: selectedWorkFilters(),
    includeMissing: state.showMissingLocalWorks, toggle: toggleWorkFilter,
    clear: () => setWorkFilters([])
  });
  return els.filterList;
}

function handleSortModeChange(event) {
  if (event.target?.isConnected === false) return;
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
  if (state.activeView === "favorites") {
    collectionPage.loadFavorites();
    return;
  }
  if (state.activeView === "history") {
    collectionPage.loadHistory();
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
  if (state.activeView === "studios" && state.selectedStudio) {
    studioPage.loadStudioDetail(state.selectedStudio.id, state.selectedStudioSeriesId);
    return;
  }
  if (state.activeView === "favorites") {
    collectionPage.loadFavorites();
    return;
  }
  if (state.activeView === "history") {
    collectionPage.loadHistory();
    return;
  }
  if (state.activeView === "vr") {
    collectionPage.loadVrWorks();
    return;
  }
  if (state.activeView === "rankings") {
    renderRankingStats();
  } else {
    refreshLoadedWorkControls();
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
          ["来源目录记录", person.actorMovieCount ?? person.actorProfile?.movieCount ?? 0],
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

  renderWorkStatsContent(stats.map(([label, value]) => createStatCard(label, value)), works);
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

  renderWorkStatsContent(stats.map(([label, value]) => createStatCard(label, value)), state.works);
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

  const focusedFilter = document.activeElement?.dataset.workFilter;
  const summary = document.createElement("div");
  summary.className = "browse-result-summary";
  summary.textContent = `当前结果 ${formatNumber(state.personWorksTotal)} 部`;
  renderWorkStatsContent([summary], state.works);
  if (focusedFilter) focusWorkFilter(focusedFilter);
}

function focusWorkFilter(value) {
  [...els.statsRow.querySelectorAll("[data-work-filter]")]
    .find((button) => button.dataset.workFilter === value)?.focus({ preventScroll: true });
}

function currentTraitFacets(works) {
  let facets = null;
  if (state.activeView === "people" && state.selectedPersonId) facets = state.personWorksTraitFacets;
  if (state.activeView === "search") facets = state.searchTraitFacets;
  if (state.activeView === "codes" && state.selectedCodePrefix) facets = state.codePrefixTraitFacets;
  if (state.activeView === "studios" && state.selectedStudio) facets = state.studioWorksTraitFacets;
  if (["favorites", "history"].includes(state.activeView)) facets = state.collectionTraitFacets;
  if (state.activeView === "vr") facets = state.vrTraitFacets;
  return facets ? { facets, loadedOnly: false } : { facets: loadedTraitFacets(works), loadedOnly: true };
}

function refreshLoadedWorkControls() {
  const previous = els.filterList;
  const wrap = previous?.closest(".stat-quick-filters");
  if (!wrap) return;
  previous.replaceWith(createWorkFilterControls());
  wrap.querySelector(".browse-traits")?.remove();
  const traits = createBrowseTraitControls({ ...currentTraitFacets(state.works), filters: selectedWorkFilters(), toggle: toggleWorkFilter });
  if (traits) wrap.append(traits);
  if (pendingWorkFilterFocus) focusWorkFilter(pendingWorkFilterFocus);
  pendingWorkFilterFocus = null;
}

function workStatsContext() {
  const view = state.activeView;
  return JSON.stringify([view, view === "search" ? state.searchQuery : "",
    view === "people" ? state.selectedPersonId : "", view === "codes" ? state.selectedCodePrefix : "",
    view === "studios" ? [state.selectedStudio?.id, state.selectedStudioSeriesId] : "",
    view === "rankings" ? state.selectedRankingKey : "", view === "favorites" ? state.selectedFavoriteFolderId : "",
    view === "history" ? state.selectedHistoryRange : ""]);
}

function renderWorkStatsContent(content, works) {
  let controls = els.statsRow.querySelector(":scope > .work-browse-controls");
  if (controls?.dataset.workStatsContext !== workStatsContext()) controls = null;
  // Removing the sort group's ancestor would close a native picker and blur it.
  for (const child of [...els.statsRow.children]) if (child !== controls) child.remove();
  for (const node of content) els.statsRow.insertBefore(node, controls);
  appendWorkControls(works);
}

function appendWorkControls(works) {
  const wrap = els.statsRow.querySelector(":scope > .work-browse-controls") || document.createElement("div");
  wrap.className = "stat-quick-filters work-browse-controls";
  wrap.dataset.workStatsContext = workStatsContext();
  const sort = wrap.querySelector(":scope > .stat-sort-group") || createWorkSortControls();
  for (const child of [...wrap.children]) if (child !== sort) child.remove();
  if (sort.parentElement !== wrap) wrap.append(sort);
  if (els.sortSelect.value !== state.sortMode) els.sortSelect.value = state.sortMode;
  wrap.insertBefore(createWorkFilterControls(), sort);
  if (isPersonBulkDeleteAvailable() && !isPersonBulkDeleteActive()) {
    const select = document.createElement("button");
    select.type = "button";
    select.className = "folder-button browse-select-works";
    select.textContent = "多选";
    const owner = capturePersonBulkDeleteOwner();
    select.addEventListener("click", () => {
      if (isCurrentPersonBulkDeleteControl(select, owner, false)) togglePersonBulkDeleteMode();
    });
    wrap.append(select);
  }
  appendPersonBulkDeleteControls(works, wrap);
  appendMetadataQuickFilters(works, wrap);
  const traits = createBrowseTraitControls({ ...currentTraitFacets(works), filters: selectedWorkFilters(), toggle: toggleWorkFilter });
  if (traits) wrap.append(traits);
  if (wrap.parentElement !== els.statsRow) els.statsRow.append(wrap);
  if (pendingWorkFilterFocus) {
    focusWorkFilter(pendingWorkFilterFocus);
    pendingWorkFilterFocus = null;
  }
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

function personBulkDeleteSelectionState(works = state.works) {
  const localIds = new Set(localPersonWorks(works).map((work) => String(work.id)));
  let selectedCount = 0;
  for (const id of localIds) if (state.personBulkDeleteSelectedIds.has(id)) selectedCount += 1;
  return { localIds, selectedCount };
}

function capturePersonBulkDeleteOwner() {
  return { navigationIntent: navigationSequence, personId: state.selectedPersonId, scope: state.peopleScope || "main" };
}

function isCurrentPersonBulkDeleteControl(control, owner, requireActive = true) {
  return Boolean(control?.isConnected && owner.navigationIntent === navigationSequence
    && owner.personId === state.selectedPersonId && owner.scope === (state.peopleScope || "main")
    && (requireActive ? isPersonBulkDeleteActive() : isPersonBulkDeleteAvailable())
    && (els.workGrid.contains(control) || els.statsRow.contains(control)));
}

function syncPersonBulkDeleteSelectButton(button, selected) {
  button.classList.toggle("active", selected);
  const text = selected ? "✓" : "";
  const label = selected ? "取消选择" : "选择删除";
  if (button.textContent !== text) button.textContent = text;
  if (button.title !== label) button.title = label;
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  const pressed = String(selected);
  if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
}

function syncPersonBulkDeleteSelectionUi() {
  if (!isPersonBulkDeleteActive()) return;
  const { localIds, selectedCount } = personBulkDeleteSelectionState();
  const group = els.statsRow.querySelector(".bulk-delete-controls");
  if (group) {
    const summary = group.querySelector(".stat-inline-summary");
    const all = group.querySelector('[data-person-bulk-action="all"]');
    const remove = group.querySelector('[data-person-bulk-action="delete"]');
    if (summary) summary.textContent = `已选 ${formatNumber(selectedCount)} / ${formatNumber(localIds.size)}`;
    if (all) all.textContent = selectedCount === localIds.size ? "取消全选" : "全选本地";
    // A selection change must not re-enable the original in-flight action or
    // replace its progress with the ordinary selected-count label.
    if (remove && !remove.personBulkDeletePending) {
      remove.disabled = selectedCount === 0;
      remove.textContent = selectedCount ? `删除已选 ${formatNumber(selectedCount)}` : "删除已选";
    }
  }
  for (const card of els.workGrid.querySelectorAll(".work-card")) {
    const id = String(card.dataset.workId || "");
    const selected = localIds.has(id) && state.personBulkDeleteSelectedIds.has(id);
    card.classList.toggle("bulk-delete-selected", selected);
    const button = card.querySelector(".bulk-delete-select");
    if (button) syncPersonBulkDeleteSelectButton(button, selected);
  }
}

function clearPersonBulkDeleteSelection() {
  state.personBulkDeleteSelectedIds.clear();
}

function togglePersonBulkDeleteMode(force = undefined) {
  if (!isPersonBulkDeleteAvailable()) return;
  state.personBulkDeleteActive = typeof force === "boolean" ? force : !state.personBulkDeleteActive;
  if (state.personBulkDeleteActive) playbackPrefetch.cancel();
  clearPersonBulkDeleteSelection();
  renderPersonProfile(state.selectedPerson);
  renderPersonWorkStats();
  renderWorks();
}

function togglePersonBulkDeleteSelection(workId) {
  const key = String(workId || "");
  if (!key || !isPersonBulkDeleteActive() || !personBulkDeleteSelectionState().localIds.has(key)) return;
  if (state.personBulkDeleteSelectedIds.has(key)) {
    state.personBulkDeleteSelectedIds.delete(key);
  } else {
    state.personBulkDeleteSelectedIds.add(key);
  }
  syncPersonBulkDeleteSelectionUi();
}

function appendPersonBulkDeleteControls(works, wrap) {
  if (!isPersonBulkDeleteActive()) return;
  const { localIds, selectedCount } = personBulkDeleteSelectionState(works);
  if (!localIds.size) return;

  const group = document.createElement("div");
  group.className = "stat-filter-group bulk-delete-controls";

  const summary = document.createElement("span");
  summary.className = "stat-inline-summary";
  summary.textContent = `已选 ${formatNumber(selectedCount)} / ${formatNumber(localIds.size)}`;

  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.className = "stat-filter-chip";
  selectAll.dataset.personBulkAction = "all";
  selectAll.textContent = selectedCount === localIds.size ? "取消全选" : "全选本地";
  const owner = capturePersonBulkDeleteOwner();
  selectAll.addEventListener("click", () => {
    if (!isCurrentPersonBulkDeleteControl(selectAll, owner)) return;
    const current = personBulkDeleteSelectionState();
    if (current.selectedCount === current.localIds.size) {
      clearPersonBulkDeleteSelection();
    } else {
      for (const id of current.localIds) state.personBulkDeleteSelectedIds.add(id);
    }
    syncPersonBulkDeleteSelectionUi();
  });

  const deleteSelected = document.createElement("button");
  deleteSelected.type = "button";
  deleteSelected.className = "stat-filter-chip danger";
  deleteSelected.dataset.personBulkAction = "delete";
  deleteSelected.disabled = selectedCount === 0;
  deleteSelected.textContent = selectedCount ? `删除已选 ${formatNumber(selectedCount)}` : "删除已选";
  deleteSelected.addEventListener("click", () => {
    if (isCurrentPersonBulkDeleteControl(deleteSelected, owner)) deleteSelectedPersonLocalWorks(deleteSelected);
  });

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "stat-filter-chip";
  cancel.textContent = "退出多选";
  cancel.addEventListener("click", () => {
    if (isCurrentPersonBulkDeleteControl(cancel, owner)) togglePersonBulkDeleteMode(false);
  });

  group.append(summary, selectAll, deleteSelected, cancel);
  wrap.append(group);
}

async function deleteSelectedPersonLocalWorks(button) {
  if (!isPersonBulkDeleteActive()) return;
  if (button?.personBulkDeletePending) return;
  const personId = state.selectedPersonId;
  const peopleScope = state.peopleScope || "main";
  const navigationIntent = navigationSequence;
  const isCurrent = (intent = navigationIntent) => intent === navigationSequence
    && state.activeView === "people" && state.selectedPersonId === personId
    && (state.peopleScope || "main") === peopleScope;
  const selectedIds = [...state.personBulkDeleteSelectedIds].filter((id) => state.works.some((work) => String(work.id) === id && !work.missingLocal));
  if (!selectedIds.length) return;
  const personName = state.selectedPerson?.name || "当前演员";
  if (!window.confirm(`确认删除 ${personName} 下已选的 ${selectedIds.length} 个本地作品文件夹？此操作会移动/删除本地文件，不能从页面撤销。`)) return;

  const originalText = button?.textContent || "";
  if (button) {
    button.personBulkDeletePending = true;
    button.disabled = true;
    button.textContent = `删除中 0/${selectedIds.length}`;
  }

  try {
    const failed = [];
    try {
      const result = await api(`/api/people/${encodeURIComponent(personId)}/local-files/delete`, {
        method: "POST",
        body: { workIds: selectedIds }
      });
      for (const item of result.failed || []) {
        failed.push(`${item.title || item.workId || "作品"}：${item.error || "删除失败"}`);
      }
      if (isCurrent() && button?.isConnected) button.textContent = `删除中 ${Math.max(0, Number(result.deletedCount || 0))}/${selectedIds.length}`;
    } catch (error) {
      failed.push(error.message || "批量删除失败");
    }

    if (!isCurrent()) return;
    clearPersonBulkDeleteSelection();
    if (!failed.length) state.personBulkDeleteActive = false;
    const refreshing = selectPerson(personId, { resetFilter: false, replaceRoute: true, reusePrefetch: false });
    const refreshIntent = navigationSequence;
    await refreshing;
    if (!isCurrent(refreshIntent)) return;

    if (failed.length) {
      alert(`有 ${failed.length} 个作品删除失败：${failed.slice(0, 3).join("；")}`);
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  } finally {
    if (button) button.personBulkDeletePending = false;
  }
}

function appendMetadataQuickFilters(works, wrap) {
  // A marker is already available in the common filters; avoid a second control
  // with a misleading count based only on the currently loaded page.

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

function workFilterLabel(filter) {
  return traitFilterLabel(filter) || {
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
    localMarkedA: "A 标记",
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
  pendingWorkFilterFocus = document.activeElement?.dataset.workFilter || null;
  const normalized = normalizeWorkFilters(filters);
  state.filterMode = normalized.length ? normalized.join(",") : "all";
  handleFilterModeChange();
}

function toggleWorkFilter(value) {
  if ((value === "all" || value === "missingLocal") && !state.showMissingLocalWorks) {
    state.showMissingLocalWorks = true;
    els.missingLocalToggle.checked = true;
    writeStoredFlag("fanhao.showMissingLocalWorks", true);
  }
  setWorkFilters(nextBrowseFilters(selectedWorkFilters(), value));
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
    .sort((a, b) => b.count - a.count || browseTextCollator.compare(a.value, b.value))
    .slice(0, limit);
}

function visibleWorks() {
  if (state.activeView === "people" && state.selectedPersonId) return state.works;
  if (state.activeView === "codes" && state.selectedCodePrefix) return state.works;
  if (state.activeView === "studios" && state.selectedStudio) return state.works;
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
  const traitMatch = workMatchesTraitFilter(work, filter);
  if (traitMatch !== null) return traitMatch;
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
  if (filter === "hasMagnet") return work.availability?.hasMagnet === true;
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
  return browseTextCollator.compare(String(a.title || a.directoryName || ""), String(b.title || b.directoryName || ""));
}

function resetWorkPaging() {
  state.workVisibleLimit = state.workPageSize;
}

function resetPersonPaging() {
  peoplePage.resetPaging();
}

function resetSearchPagination() {
  searchLoadMoreOwner = null;
  state.searchLoadingMore = false;
  state.searchRawLoaded = null;
  state.searchHasMore = null;
}

function clearWorkSearch() {
  window.clearTimeout(state.searchTimer);
  searchRequests.cancel();
  resetSearchPagination();
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

async function loadSearchResults(query, options = {}) {
  const navigationIntent = beginNavigation(options);
  resetSearchPagination();
  const normalizedQuery = String(query || "").trim();
  state.workQuery = normalizedQuery;
  if (!options.preserveSearchDraft && els.workSearch && els.workSearch.value !== normalizedQuery) {
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
  if (enteringSearch || state.searchQuery !== normalizedQuery) els.statsRow.innerHTML = "";
  els.workGrid.innerHTML = `<div class="empty-state">正在全库搜索</div>`;
  state.searchQuery = normalizedQuery;
  state.searchTotal = 0;
  state.searchFacets = null;
  state.searchTraitFacets = null;
  state.searchLoadingMore = false;
  const sort = state.sortMode, filter = state.filterMode;
  const ownsSearch = () => navigationIntent === navigationSequence && state.activeView === "search"
    && state.searchQuery === normalizedQuery && state.sortMode === sort && state.filterMode === filter;
  const routeOptions = {
    ...options,
    replaceRoute: Object.prototype.hasOwnProperty.call(options, "replaceRoute") ? options.replaceRoute : !enteringSearch,
    routeOverrides: { view: "search", personId: "", q: normalizedQuery, workId: "", videoId: "" }
  };

  try {
    const data = await searchRequests.fetchPage(normalizedQuery, 0, () => {
      searchRequests.cancel();
      const reloadOptions = { ...routeOptions, preserveSearchDraft: true };
      delete reloadOptions.navigationIntent;
      return loadSearchResults(normalizedQuery, reloadOptions);
    });
    if (!data || !ownsSearch()) return;
    state.selectedPerson = null;
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    state.searchPeople = data.people || [];
    const page = resolveWorkPage(data);
    state.works = page.works;
    state.searchRawLoaded = page.rawLoaded;
    state.searchHasMore = page.hasMore;
    state.searchTotal = page.total;
    state.searchFacets = data.facets || null;
    state.searchTraitFacets = data.traitFacets || null;
    resetWorkPaging();
    renderSearchStats();
    renderWorks(`没有搜到「${normalizedQuery}」。`);
    syncRouteAfterNavigation(routeOptions);
  } catch (error) {
    if (!ownsSearch()) return;
    syncRouteAfterNavigation(routeOptions);
    els.workGrid.replaceChildren(createSearchRecoveryPanel({
      message: error.message,
      isCurrent: ownsSearch,
      retry: () => loadSearchResults(normalizedQuery, { ...options, replaceRoute: true, navigationIntent, preserveSearchDraft: true }),
      clear: () => submitWorkSearch(""),
      getFocusTarget: () => els.workGrid.querySelector(".search-retry-button") || els.currentTitle
    }));
  }
}

async function loadMoreSearchResults(button) {
  if (state.searchLoadingMore || state.activeView !== "search" || !state.searchQuery || state.searchHasMore === false) return;
  const owner = {};
  searchLoadMoreOwner = owner;
  state.searchLoadingMore = true;
  const originalText = button?.textContent || "";
  let restoreInFinally = true;
  if (button) {
    button.disabled = true;
    button.textContent = "正在加载";
  }

  const query = state.searchQuery;
  const offset = Number.isSafeInteger(state.searchRawLoaded) ? state.searchRawLoaded : state.works.length;
  try {
    const data = await searchRequests.fetchPage(query, offset);
    if (!data || searchLoadMoreOwner !== owner || state.activeView !== "search" || state.searchQuery !== query) return;
    const page = resolveWorkPage(data, { existingWorks: state.works, offset, previousTotal: state.searchTotal });
    state.works.push(...page.works);
    state.searchRawLoaded = page.rawLoaded;
    state.searchHasMore = page.hasMore;
    state.searchTotal = page.total;
    state.searchFacets = data.facets || state.searchFacets || null;
    state.searchTraitFacets = data.traitFacets || state.searchTraitFacets || null;
    if (!state.searchPeople.length) state.searchPeople = data.people || [];
    state.workVisibleLimit += state.workPageSize;
    renderSearchStats();
    appendLoadedWorkPage();
  } catch (error) {
    if (searchLoadMoreOwner !== owner || state.activeView !== "search" || state.searchQuery !== query) return;
    toastInline(button, error.message || "加载失败", originalText);
    restoreInFinally = false;
  } finally {
    if (searchLoadMoreOwner === owner) {
      searchLoadMoreOwner = null;
      state.searchLoadingMore = false;
      if (button && button.isConnected) button.disabled = false;
      if (restoreInFinally && button && button.isConnected) {
        button.textContent = originalText || button.textContent;
      }
    }
  }
}

async function loadMorePersonWorks(button) {
  return peoplePage.loadMoreWorks(button);
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
  workLocalMarkerPresentation = null;
  els.workGrid.innerHTML = "";
  renderSearchPeoplePanel();

  const serverMore = workServerMoreState(state);
  const hasServerMore = Object.values(serverMore).some(Boolean);
  if (!works.length && !hasServerMore) {
    appendEmpty(emptyMessage);
    captureWorkLocalMarkerPresentation(els.workGrid.lastElementChild);
    return;
  }

  const visible = works.slice(0, state.workVisibleLimit);
  workListRenderer.render(visible, () => {
    if (visible.length < works.length || hasServerMore) {
      appendLoadMore(visible.length, works.length, serverMore);
    }
  });
  captureWorkLocalMarkerPresentation();
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
  captureWorkLocalMarkerPresentation();
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
  const bulkOwner = capturePersonBulkDeleteOwner();
  card.className = `work-card${work.missingLocal ? " missing-local" : ""}`;
  const isRankingCard = state.activeView === "rankings";
  if (isRankingCard) card.classList.add("ranking-card");
  card.dataset.workId = work.id;
  if (isPersonBulkDeleteActive() && state.personBulkDeleteSelectedIds.has(String(work.id))) {
    card.classList.add("bulk-delete-selected");
  }

  const cover = document.createElement("button");
  cover.type = "button";
  cover.className = "cover-wrap work-card-main";
  cover.setAttribute("aria-label", work.missingLocal ? `打开 JavDB：${work.title}` : `打开作品：${work.title}`);
  cover.addEventListener("click", () => handleWorkCardPrimaryClick(work, cover, bulkOwner));

  const resolvedCoverUrl = workCoverUrl(work);
  if (resolvedCoverUrl) {
    appendProgressiveCoverImage(cover, resolvedCoverUrl, index);
  } else {
    cover.append(els.placeholderTemplate.content.cloneNode(true));
  }

  const rankNo = Number(work.ranking?.rankNo);
  if (Number.isInteger(rankNo) && rankNo > 0) {
    const rank = document.createElement("span");
    rank.className = `cover-ranking${rankNo <= 3 ? ` podium-${rankNo}` : ""}`;
    rank.textContent = `TOP ${formatNumber(rankNo)}`;
    rank.setAttribute("aria-hidden", "true");
    cover.setAttribute("aria-label", `${rank.textContent}，${cover.getAttribute("aria-label")}`);
    cover.append(rank);
  }

  const favorite = document.createElement("button");
  const favoritePending = isFavoritePending(work.id);
  const favoriteOwner = navigationSequence;
  favorite.type = "button";
  favorite.className = `favorite-button${work.favorite ? " active" : ""}${favoritePending ? " pending" : ""}`;
  favorite.disabled = favoritePending;
  favorite.title = work.favorite ? "取消收藏" : "收藏";
  favorite.setAttribute("aria-label", favoritePending ? `${favorite.title}中` : favorite.title);
  favorite.textContent = "★";
  favorite.addEventListener("click", (event) => {
    event.stopPropagation();
    if (favoriteOwner !== navigationSequence || !favorite.isConnected || !els.workGrid.contains(favorite)) return;
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
  body.addEventListener("click", () => handleWorkCardPrimaryClick(work, body, bulkOwner));

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
  for (const chip of createAvailabilityChips(work)) flags.append(chip);
  if (!isRankingCard && work.infoCount > 0) flags.append(createInfoChip(`${formatNumber(work.infoCount)} 资料`));
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
  const editions = createWorkEditionBadges(work);
  if (editions) body.append(editions);
  const tags = createWorkTagButtons(work, { filters: selectedWorkFilters(), toggle: toggleWorkFilter });
  if (tags) body.append(tags);
  body.append(facts);
  if (flags.childElementCount) body.append(flags);
  if (work.missingLocal) {
    card.append(cover, body);
  } else {
    if (!isPersonBulkDeleteActive()) {
      cover.dataset.playbackWorkId = String(work.id);
      body.dataset.playbackWorkId = String(work.id);
    }
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
  const owner = capturePersonBulkDeleteOwner();
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!isCurrentPersonBulkDeleteControl(button, owner)) return;
    togglePersonBulkDeleteSelection(work.id);
  });
  return button;
}

function handleWorkCardPrimaryClick(work, control, owner) {
  if (!control?.isConnected) return;
  if (isPersonBulkDeleteActive() && !work.missingLocal) {
    if (!isCurrentPersonBulkDeleteControl(control, owner)) return;
    togglePersonBulkDeleteSelection(work.id);
    return;
  }
  openWorkCard(work);
}

function createLocalMarkerButton(work, marker) {
  const key = String(marker || "").toUpperCase();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "local-marker-button";
  button.dataset.localMarker = key;
  button.dataset.localMarkerWorkId = String(work.id);
  syncWorkLocalMarkerButton(button, work, key);
  const owner = navigationSequence;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (owner !== navigationSequence || !button.isConnected || !els.workGrid.contains(button)) return;
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
  select.disabled = isFavoriteFolderPending(work.id);
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", (event) => {
    event.stopPropagation();
    moveFavoriteToFolder(work, select.value, select);
  });
  return select;
}

function createWorkLocalMarkerApi(baseApi) {
  return (path, options = {}) => {
    const pathname = String(path).split("?", 1)[0];
    const isWorkRead = /^\/api\/(?:library|search|favorites|history|works(?:\/[^/]+)?|people\/[^/]+|code-prefixes\/[^/]+|studios\/[^/]+|rankings\/top)$/.test(pathname);
    if (String(options.method || "GET").toUpperCase() !== "GET" || !isWorkRead
      || options.returnResponse || options.signal?.aborted) return baseApi(path, options);
    const read = { patches: new Map() };
    const retire = () => {
      workLocalMarkerReads.delete(read);
      read.patches.clear();
      options.signal?.removeEventListener("abort", retire);
    };
    workLocalMarkerReads.add(read);
    options.signal?.addEventListener("abort", retire, { once: true });
    try {
      return Promise.resolve(baseApi(path, options)).then(data => {
        return workLocalMarkerReads.has(read) && read.patches.size
          ? mergeWorkLocalMarkerReadPayload(data, read.patches) : data;
      }).finally(retire);
    } catch (error) {
      retire();
      throw error;
    }
  };
}

function projectWorkLocalMarkerReceipt(work) {
  const projection = { id: work.id };
  for (const field of ["localMarkers", "directoryName", "relativePath"]) {
    if (Object.prototype.hasOwnProperty.call(work, field)) {
      projection[field] = field === "localMarkers" ? [...work[field]] : work[field];
    }
  }
  for (const field of ["videos", "images", "infos"]) {
    if (!Array.isArray(work[field])) continue;
    projection[field] = work[field].filter(file => file?.id != null).map(file => {
      const next = { id: file.id };
      for (const name of ["sourcePath", "relativePath"]) {
        if (Object.prototype.hasOwnProperty.call(file, name)) next[name] = file[name];
      }
      return next;
    });
  }
  return projection;
}

function queueWorkLocalMarkerReadReceipt(work) {
  const projection = projectWorkLocalMarkerReceipt(work);
  for (const read of workLocalMarkerReads) read.patches.set(String(work.id), projection);
}

function mergeWorkLocalMarkerReadPayload(data, patches) {
  if (!data || typeof data !== "object") return data;
  const merge = work => {
    const projection = patches.get(String(work?.id));
    return projection ? mergeWorkLocalMarkerRecord(work, projection, false) : work;
  };
  let next = data;
  if (Array.isArray(data.works) && data.works.some(work => patches.has(String(work?.id)))) {
    next = { ...next, works: data.works.map(merge) };
  }
  if (data.work && patches.has(String(data.work.id))) next = { ...next, work: merge(data.work) };
  return next;
}

function workLocalMarkerKey(workId, marker) {
  return JSON.stringify([String(workId), String(marker).toUpperCase()]);
}

function invalidateWorkLocalMarkerPrefetches() {
  // Renaming can change paths and membership in any prefetched work list.
  // Clear future lookup without cancelling an already adopted foreground read.
  peoplePage.invalidatePrefetches();
  studioPage.invalidatePrefetches();
  searchRequests.invalidatePrefetches();
  collectionPage.invalidatePrefetches();
}

function syncWorkLocalMarkerButton(button, work, marker) {
  const active = (work.localMarkers || []).includes(marker);
  const pending = workLocalMarkerWrites.has(workLocalMarkerKey(work.id, marker));
  const label = active ? `移除 ${marker} 标记` : `添加 ${marker} 标记`;
  button.classList.toggle("active", active);
  button.disabled = false;
  button.textContent = localMarkerButtonLabel(marker, active);
  button.title = label;
  button.setAttribute("aria-label", pending ? `${label}中` : label);
  button.setAttribute("aria-pressed", String(active));
  button.setAttribute("aria-disabled", String(pending));
  button.setAttribute("aria-busy", String(pending));
  const retry = button.closest(".work-card")?.querySelector(":scope > .local-marker-error .local-marker-retry");
  if (retry) {
    retry.setAttribute("aria-disabled", String(pending));
    retry.setAttribute("aria-busy", String(pending));
    retry.textContent = pending ? "正在重试…" : "重试";
  }
}

function showWorkLocalMarkerError(work, key, button, error, enabled, ownsOrigin) {
  const card = button.closest(".work-card");
  if (!card || card.parentNode !== els.workGrid) return;
  let panel = card.querySelector(":scope > .local-marker-error");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "local-marker-error";
    const title = document.createElement("strong");
    title.textContent = `${key} 标记未保存`;
    const message = document.createElement("div");
    message.className = "local-marker-error-message";
    message.id = `local-marker-error-${encodeURIComponent(work.id)}-${key}`;
    message.setAttribute("role", "alert");
    message.setAttribute("aria-atomic", "true");
    message.setAttribute("aria-label", `${key} 标记保存失败原因，可滚动查看`);
    message.tabIndex = 0;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "local-marker-retry";
    panel.append(title, message, retry);
    card.append(panel);
  }
  const message = panel.querySelector(".local-marker-error-message");
  message.textContent = error.message || "保存失败，请重试";
  button.setAttribute("aria-describedby", message.id);
  const retry = panel.querySelector(".local-marker-retry");
  retry.setAttribute("aria-label", `重试${enabled ? "添加" : "移除"} ${key} 标记`);
  retry.setAttribute("aria-describedby", message.id);
  retry.onclick = event => {
    event.stopPropagation();
    if (!ownsOrigin() || panel.parentNode !== card || !retry.isConnected) return;
    void toggleWorkLocalMarker(work, key, button, enabled);
  };
}

function clearWorkLocalMarkerError(button, ownsOrigin, reveal = true) {
  const panel = button.closest(".work-card")?.querySelector(":scope > .local-marker-error");
  if (!panel) return;
  const restoreFocus = panel.contains(document.activeElement) && ownsOrigin();
  panel.remove();
  button.removeAttribute("aria-describedby");
  if (restoreFocus) focusWorkRecoveryControl(button, ownsOrigin, reveal);
}

function syncWorkLocalMarkerButtons(workId) {
  const work = state.works.find(item => String(item.id) === String(workId));
  if (!work) return;
  for (const button of els.workGrid.querySelectorAll(".local-marker-button")) {
    if (button.dataset.localMarkerWorkId === String(workId)) {
      syncWorkLocalMarkerButton(button, work, button.dataset.localMarker);
    }
  }
}

function mergeWorkLocalMarkerFiles(current, confirmed) {
  if (!Array.isArray(confirmed)) return current;
  if (!Array.isArray(current)) return confirmed.map(file => ({ ...file }));
  const byId = new Map(confirmed.filter(file => file?.id != null).map(file => [String(file.id), file]));
  return current.map(file => {
    const received = file?.id != null ? byId.get(String(file.id)) : null;
    if (!received) return file;
    const next = { ...file };
    for (const field of ["sourcePath", "relativePath"]) {
      if (Object.prototype.hasOwnProperty.call(received, field)) next[field] = received[field];
    }
    return next;
  });
}

function mergeWorkLocalMarkerRecord(work, nextWork, includeNewFiles = true) {
  const next = { ...work };
  for (const field of ["localMarkers", "directoryName", "relativePath"]) {
    if (Object.prototype.hasOwnProperty.call(nextWork, field)) {
      next[field] = field === "localMarkers" ? [...nextWork[field]] : nextWork[field];
    }
  }
  for (const field of ["videos", "images", "infos"]) {
    if (Array.isArray(nextWork[field]) && (includeNewFiles || Array.isArray(work[field]))) {
      next[field] = mergeWorkLocalMarkerFiles(work[field], nextWork[field]);
    }
  }
  return next;
}

function applyWorkLocalMarkerReceipt(work, nextWork) {
  const workId = String(work.id);
  const copies = new Set([work, state.currentWork, ...state.works, ...(state.library?.works || [])]
    .filter(item => item && String(item.id) === workId));
  for (const copy of copies) {
    const merged = mergeWorkLocalMarkerRecord(copy, nextWork);
    for (const field of ["localMarkers", "directoryName", "relativePath"]) {
      if (Object.prototype.hasOwnProperty.call(nextWork, field)) copy[field] = merged[field];
    }
    for (const field of ["videos", "images", "infos"]) {
      if (!Array.isArray(nextWork[field])) continue;
      if (!Array.isArray(copy[field])) {
        copy[field] = merged[field];
        continue;
      }
      // Existing media callbacks keep their original arrays and file records.
      // Publish only the confirmed directory paths into those live records.
      const byId = new Map(merged[field].filter(file => file?.id != null).map(file => [String(file.id), file]));
      for (const file of copy[field]) {
        const next = file?.id != null ? byId.get(String(file.id)) : null;
        if (!next) continue;
        for (const name of ["sourcePath", "relativePath"]) {
          if (Object.prototype.hasOwnProperty.call(next, name)) file[name] = next[name];
        }
      }
    }
  }
  if (String(state.currentWork?.id) === workId && state.currentVideo) {
    const [video] = mergeWorkLocalMarkerFiles([state.currentVideo], nextWork.videos);
    Object.assign(state.currentVideo, video);
  }
  queueWorkLocalMarkerReadReceipt(nextWork);
}

function workLocalMarkerMembershipScope() {
  return selectedWorkFilters().includes("localMarkedA")
    || (state.activeView === "search" && /^\[\s*A\s*\]$/i.test(String(state.searchQuery || "").trim()));
}

function hasAcceptedWorkLocalMarkerPage() {
  if (state.activeView === "search") return Boolean(state.searchQuery) && Number.isSafeInteger(state.searchRawLoaded);
  if (state.activeView === "people") return Boolean(state.selectedPersonId) && Number.isSafeInteger(state.personWorksRawLoaded);
  if (state.activeView === "codes") return Boolean(state.selectedCodePrefix) && Number.isSafeInteger(state.codePrefixRawLoaded);
  if (state.activeView === "studios") return Boolean(state.selectedStudio?.id) && Number.isSafeInteger(state.studioWorksRawLoaded);
  if (["favorites", "history"].includes(state.activeView)) return Number.isSafeInteger(state.collectionRawLoaded);
  return state.activeView === "vr" && Number.isSafeInteger(state.vrRawLoaded);
}

function captureWorkLocalMarkerPresentation(emptyAnchor = null) {
  workLocalMarkerPresentation = null;
  if (!workLocalMarkerMembershipScope() || !hasAcceptedWorkLocalMarkerPage()) return;
  const anchor = emptyAnchor || els.workGrid.querySelector(":scope > .work-card");
  if (!anchor) return;
  workLocalMarkerPresentation = { anchor, empty: Boolean(emptyAnchor), navigation: navigationSequence,
    context: workLocalMarkerReadContext(), route: routeUrl(currentRouteSnapshot(), { initialParams }) };
}

function ownsWorkLocalMarkerPresentation() {
  const owner = workLocalMarkerPresentation;
  return Boolean(owner && hasAcceptedWorkLocalMarkerPage()
    && owner.anchor.parentNode === els.workGrid && (!owner.empty || owner.anchor === els.workGrid.lastElementChild)
    && owner.navigation === navigationSequence && owner.context === workLocalMarkerReadContext()
    && owner.route === routeUrl(currentRouteSnapshot(), { initialParams })
    && owner.route === routeUrl(normalizeRoute(routeFromUrl()), { initialParams }));
}

function beginWorkLocalMarkerForegroundRead(path, isCurrent, refresh = null) {
  workLocalMarkerPresentation = null;
  const read = { owner: captureWorkLocalMarkerReadOwner(path), isCurrent, refresh };
  workLocalMarkerForegroundReads.add(read);
  return () => workLocalMarkerForegroundReads.delete(read);
}

function workLocalMarkerReadContext() {
  return JSON.stringify([workStatsContext(), state.peopleScope || "main", Boolean(state.selectedCodePrefixFamily),
    state.sortMode, serializedWorkFilterMode(), Boolean(state.showMissingLocalWorks), Boolean(state.showCompilationWorks)]);
}

function captureWorkLocalMarkerReadOwner(path) {
  return { path: String(path), navigation: navigationSequence, context: workLocalMarkerReadContext(),
    route: routeUrl(normalizeRoute(routeFromUrl()), { initialParams }) };
}

function findPendingWorkLocalMarkerMembershipRead() {
  const context = workLocalMarkerReadContext();
  const route = routeUrl(normalizeRoute(routeFromUrl()), { initialParams });
  for (const read of workLocalMarkerForegroundReads) {
    const owner = read.owner;
    if (!read.isCurrent() || !owner || owner.navigation !== navigationSequence || owner.context !== context || owner.route !== route) continue;
    const [path, query = ""] = owner.path.split("?", 2);
    const params = new URLSearchParams(query);
    const filters = String(params.get("filter") || "all").split(",").filter(value => value && value !== "all");
    const literalMarkerQuery = path === "/api/search" && /^\[\s*A\s*\]$/i.test(String(params.get("q") || "").trim());
    if (!filters.includes("localMarkedA") && !literalMarkerQuery) continue;
    const expectedFilters = [...new Set([...selectedWorkFilters(), ...(state.activeView === "vr" ? ["vr"] : [])])].sort();
    if (JSON.stringify([...new Set(filters)].sort()) !== JSON.stringify(expectedFilters)) continue;
    let current = false;
    if (state.activeView === "search") {
      current = path === "/api/search" && String(params.get("q") || "").trim() === state.searchQuery;
    } else if (state.activeView === "people" && state.selectedPersonId) {
      current = path === `/api/people/${encodeURIComponent(state.selectedPersonId)}`
        && (params.get("scope") || "main") === (state.peopleScope || "main");
    } else if (state.activeView === "codes" && state.selectedCodePrefix) {
      current = path === `/api/code-prefixes/${encodeURIComponent(state.selectedCodePrefix)}`
        && (params.get("family") === "1") === Boolean(state.selectedCodePrefixFamily);
    } else if (state.activeView === "studios") {
      current = /^\/api\/studios\/[^/]+$/.test(path) && typeof read.refresh === "function";
    } else if (state.activeView === "favorites") {
      current = path === "/api/favorites" && (params.get("folder") || "all") === (state.selectedFavoriteFolderId || "all");
    } else if (state.activeView === "history") {
      current = path === "/api/history" && (params.get("days") || "all") === (state.selectedHistoryRange || "all");
    } else if (state.activeView === "vr") current = path === "/api/works";
    if (current) return read;
  }
  return null;
}

function refreshWorkLocalMarkerMembership(pendingRead = null) {
  let refreshing;
  if (pendingRead?.refresh) refreshing = pendingRead.refresh();
  else if (state.activeView === "people" && state.selectedPersonId) {
    refreshing = selectPerson(state.selectedPersonId, { resetFilter: false, reusePrefetch: false });
  } else if (state.activeView === "codes" && state.selectedCodePrefix) {
    refreshing = codePrefixPage.reloadSelected();
  } else if (state.activeView === "studios" && state.selectedStudio) {
    studioPage.cancelPendingRequests();
    refreshing = studioPage.loadStudioDetail(state.selectedStudio.id, state.selectedStudioSeriesId);
  } else if (state.activeView === "search") {
    searchRequests.cancel();
    refreshing = loadSearchResults(state.searchQuery, { replaceRoute: true, preserveSearchDraft: true });
  } else if (["favorites", "history", "vr"].includes(state.activeView)) {
    collectionPage.invalidatePrefetches();
    refreshing = state.activeView === "favorites" ? collectionPage.loadFavorites()
      : state.activeView === "history" ? collectionPage.loadHistory() : collectionPage.loadVrWorks();
  } else {
    if (state.activeView === "rankings") renderRankingStats();
    renderWorks();
    return;
  }
  const owner = navigationSequence;
  Promise.resolve(refreshing).catch(error => {
    if (owner === navigationSequence) renderEmpty(`标记已保存，筛选刷新失败：${error.message || "请重试"}`);
  });
}

async function toggleWorkLocalMarker(work, marker, button, explicitEnabled) {
  const key = String(marker || "").toUpperCase();
  const workId = String(work.id);
  const writeKey = workLocalMarkerKey(workId, key);
  if (workLocalMarkerWrites.has(writeKey)) return;
  const current = state.works.find(item => String(item.id) === workId) || work;
  const nextEnabled = typeof explicitEnabled === "boolean" ? explicitEnabled : !(current.localMarkers || []).includes(key);
  const owner = navigationSequence, view = state.activeView;
  const context = JSON.stringify([workStatsContext(), state.sortMode, serializedWorkFilterMode(), state.peopleScope]);
  const ownsOrigin = () => owner === navigationSequence && view === state.activeView
    && context === JSON.stringify([workStatsContext(), state.sortMode, serializedWorkFilterMode(), state.peopleScope])
    && button.isConnected && els.workGrid.contains(button);
  const recoveryPanel = button.closest(".work-card")?.querySelector(":scope > .local-marker-error");
  const viewportGestures = recoveryPanel ? new AbortController() : null;
  let newerViewportGesture = false;
  const request = { workId, marker: key };
  workLocalMarkerWrites.set(writeKey, request);
  syncWorkLocalMarkerButtons(workId);
  try {
    if (viewportGestures) {
      const retry = recoveryPanel.querySelector(".local-marker-retry");
      const noteViewportGesture = event => {
        if (event.type === "pointerdown" && retry?.contains(event.target)) return;
        if (event.type === "keydown" && !["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)
          && !(event.key === " " && event.target?.tagName !== "BUTTON")) return;
        newerViewportGesture = true;
      };
      for (const type of ["pointerdown", "keydown", "wheel", "touchmove"]) {
        document.addEventListener(type, noteViewportGesture, { capture: true, passive: true, signal: viewportGestures.signal });
      }
    }
    const data = await api(`/api/works/${encodeURIComponent(workId)}/local-marker`, {
      method: "POST",
      body: { marker: key, enabled: nextEnabled }
    });
    if (!data.work || String(data.work.id) !== workId || !Array.isArray(data.work.localMarkers)) {
      throw new Error("标记保存结果无效，请重试");
    }
    clearWorkLocalMarkerError(button, ownsOrigin, !newerViewportGesture);
    applyWorkLocalMarkerReceipt(work, data.work);
    syncWorkLocalMarkerButtons(workId);
    invalidateWorkLocalMarkerPrefetches();
    const route = normalizeRoute(routeFromUrl());
    const sameRoute = routeUrl(route, { initialParams })
      === routeUrl(currentRouteSnapshot(), { initialParams });
    const hasCurrentCard = [...els.workGrid.querySelectorAll(".work-card")]
      .some(card => card.dataset.workId === workId);
    const pendingRead = workLocalMarkerMembershipScope() ? findPendingWorkLocalMarkerMembershipRead() : null;
    if (workLocalMarkerMembershipScope()
      && (ownsOrigin() || (!button.isConnected && sameRoute && hasCurrentCard) || pendingRead || ownsWorkLocalMarkerPresentation())) {
      refreshWorkLocalMarkerMembership(pendingRead);
    }
  } catch (error) {
    if (ownsOrigin()) showWorkLocalMarkerError(work, key, button, error, nextEnabled, ownsOrigin);
  } finally {
    viewportGestures?.abort();
    if (workLocalMarkerWrites.get(writeKey) === request) workLocalMarkerWrites.delete(writeKey);
    syncWorkLocalMarkerButtons(workId);
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
  if (availability.hasMagnet === true) {
    const chip = createInfoChip(availability.hasSubtitles ? "中字磁链" : "含磁链", "magnet");
    chip.title = "资料来源标记有磁链，未验证当前下载可用性。中字磁链仅表示资源资料线索，不代表本地文件有字幕。";
    return [chip];
  }
  return [];
}

installWorkSearchShortcut(els.workSearch);
let workSearchComposing = false;

function scheduleWorkSearchPrefetch(event) {
  window.clearTimeout(state.searchTimer);
  if (workSearchComposing || event?.isComposing) return;
  const query = els.workSearch.value.trim();
  if (!query || globalThis.navigator?.connection?.saveData) return;
  state.searchTimer = window.setTimeout(() => searchRequests.prefetch(query), 160);
}

els.workSearch.addEventListener("compositionstart", () => {
  workSearchComposing = true;
  window.clearTimeout(state.searchTimer);
});

els.workSearch.addEventListener("compositionend", () => {
  workSearchComposing = false;
  scheduleWorkSearchPrefetch();
});

els.workSearch.addEventListener("input", scheduleWorkSearchPrefetch);

els.workSearch.addEventListener("keydown", (event) => {
  // Confirming or cancelling an IME candidate belongs to the input method.
  // Some browsers end composition before keydown but retain keyCode 229.
  if (workSearchComposing || event.isComposing || event.keyCode === 229) return;
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
  if (state.activeView === "studios" && state.selectedStudio) {
    studioPage.loadStudioDetail(state.selectedStudio.id, state.selectedStudioSeriesId);
    return;
  }
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
  if (state.activeView === "studios" && state.selectedStudio) {
    studioPage.loadStudioDetail(state.selectedStudio.id, state.selectedStudioSeriesId);
    return;
  }
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
  button.addEventListener("click", async (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    browseNavigation.close();
    clearWorkSearch();
    beginNavigation();
    if (codePrefixPage.handleNavigationButton(button)) return;
    if (button.dataset.view === "people" && button.dataset.peopleScope) {
      await navigatePeopleScope(button.dataset.peopleScope);
      return;
    }
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
  collectionPage.prefetch(initialRoute.view, { retainFailureForActivation: true });
  const moduleNavigationPromise = initializeModuleNavigation();
  const applied = await applyRoute(initialRoute);
  document.documentElement.classList.remove("app-module-loading");
  initializeRouteHistory({ preserveUrl: !applied });
  if (applied && !state.library) {
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

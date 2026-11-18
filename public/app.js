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
} from "./modules/fanhao/index.js?v=20261113-favorite-folder-merge-01";
import { createBrowseNavigation } from "./modules/fanhao/browse-navigation.js?v=20260919-browse-01";
import { createFavoriteFolderPicker } from "./modules/fanhao/features/works/favorite-folder-picker.js";
import { installWorkSearchShortcut } from "./modules/fanhao/search-shortcut.js?v=20261028-search-shortcut-01";
import { createWorkSearchSuggestions } from "./modules/fanhao/search-suggestions.js";
import { createReadRecoveryPanel, createSearchRecoveryPanel } from "./modules/fanhao/search-recovery.js";
import { createBrowseFilterControls, nextBrowseFilters } from "./modules/fanhao/browse-filters.js?v=20261105-media-classification-01";
import { classificationQuery, createBrowseTraitControls, loadedTraitFacets, parseClassificationQuery, traitFilterLabel, workMatchesTraitFilter } from "./modules/fanhao/browse-traits.js?v=20261112-classification-01";
import { createPersonWorkSort, syncPersonWorkSort } from "./modules/fanhao/person-work-sort.js?v=20261111-person-controls-01";
import { createLatestRequestGate } from "./modules/fanhao/latest-request.js?v=20260717-fanhao-latest-request-01";
import { adminUrl } from "./js/admin-navigation.js?v=20260727-admin-merge-01";
import { createLazyPersonProfile } from "./modules/fanhao/lazy-person-profile.js?v=20260717-fanhao-lazy-person-01";
import { PEOPLE_SCOPE_NAMES, URL_VIEW_NAMES, normalizeFanhaoSearchSort, normalizeRoute, routeFromUrl, routeUrl } from "./js/router.js?v=20261113-search-route-01";
import { canManageWebLibrary, captureWebAccount } from "./platform/accounts/session-context.js";

const browseTextCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

prepareAppShell();
prepareClientShell();

const state = {
  ...createFanhaoState({ readStoredFlag }),
  personWorksTraitFacets: null,
  searchTraitFacets: null,
  searchDisplay: null,
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
  classificationLink: document.querySelector("[data-work-classifications]"),
  workSearch: document.querySelector("#workSearch"),
  sortSelect: null,
  filterList: null,
  missingLocalToggle: document.querySelector("#missingLocalToggle"),
  collectionToggle: document.querySelector("#collectionToggle"),
  compilationConfigButton: document.querySelector("#compilationConfigButton"),
  workCardSize: document.querySelector("#workCardSize"),
  personProfile: document.querySelector("#personProfile"),
  currentPath: document.querySelector("#currentPath"),
  currentTitle: document.querySelector("#currentTitle"),
  backToPeopleIndex: document.querySelector("#backToPeopleIndex"),
  statsRow: document.querySelector("#statsRow"),
  workGrid: document.querySelector("#workGrid"),
  placeholderTemplate: document.querySelector("#placeholderTemplate")
};

const formatter = new Intl.NumberFormat("zh-CN");
const compactRatingCount = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const libraryRequests = createLatestRequestGate();
let navigationSequence = 0;
let searchLoadMoreOwner = null;
const workLocalMarkerWrites = new Map();
const workLocalMarkerReads = new Set();
const workLocalMarkerForegroundReads = new Set();
const personMissingLocalPreferences = new Map();
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
if (els.classificationLink) {
  els.classificationLink.href = routeUrl({ q: classificationQuery("all") }, { initialParams, hash: "" });
}
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
const workSearchSuggestions = createWorkSearchSuggestions({
  input: els.workSearch,
  list: document.querySelector("#workSearchSuggestions"),
  visibleWorks: (works) => {
    const overrides = workSearchEntryOverrides();
    return selectWorkCards(works, { filters: normalizeWorkFilters(overrides?.filter ?? state.filterMode), sortMode: overrides?.sort });
  },
  onPerson: openSearchPerson,
  onWork: openWorkCard,
  onSearch: submitWorkSearch
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
  getAccountOwner: () => captureWebAccount().owner,
  getWorkFilterMode: serializedWorkFilterMode,
  showMissingLocalForPerson,
  hidePersonProfile,
  onNavigationStarted: beginNavigation,
  preparePersonProfile: () => personProfilePage.load().catch(() => {}),
  renderPersonProfile,
  renderPersonWorkSearch,
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
    const { createPersonProfile } = await import("./modules/fanhao/person-profile.js?v=20261114-person-search-01");
    return createPersonProfile({
      api,
      coverUrl,
      createPersonPin: peoplePage.createPinControl,
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
  removeFavorites,
  saveFavoriteToFolder,
  syncFavoriteControl,
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
const favoriteFolderPicker = createFavoriteFolderPicker({
  readFolders: (signal) => api("/api/favorite-folders", { signal }),
  async save(workId, folderId) {
    const saving = saveFavoriteToFolder(workId, folderId);
    syncVisibleFavoriteCards(workId);
    try { return await saving; }
    finally { syncVisibleFavoriteCards(workId); }
  },
  onSaved({ workId, favoriteFolder, removedWorkIds }) {
    if (state.activeView !== "favorites") return;
    if (collectionPage.refreshMovedFavorite(workId, favoriteFolder.folderId, { includeAll: true })) return;
    if (removedWorkIds.length && els.workGrid.querySelector(".work-card")) {
      cancelScheduledWorkRendering();
      renderStatsForWorks(state.works);
      renderFavoriteFolderControls();
      if (state.works.length) appendLoadedWorkPage();
      else renderWorks("还没有收藏。");
    } else collectionPage.refreshFavoriteFolderCounts();
  }
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
          const folder = card.querySelector(".work-favorite-folder-button");
          if (folder) syncWorkFavoriteFolderButton(folder, work);
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
  onFavoriteFilterChange: ({ replace = false } = {}) => replace ? replaceRoute() : pushRoute(),
  onHistoryFilterChange: () => pushRoute(),
  onWorkRead: beginWorkLocalMarkerForegroundRead,
  appendLoadedWorkPage,
  els,
  formatNumber,
  getNavigationIntent: () => navigationSequence,
  hidePersonProfile,
  isFavoriteWritePending: (id) => isFavoritePending(id) || isFavoriteFolderPending(id),
  async removeFavoriteBatch(workIds) {
    const ids = new Set(workIds);
    let result;
    try {
      result = await removeFavorites(workIds);
    } finally {
      const works = new Map();
      for (const work of state.works) {
        const id = String(work.id);
        if (ids.has(id)) works.set(id, work);
      }
      for (const card of els.workGrid.querySelectorAll(".work-card[data-work-id]")) {
        const work = works.get(card.dataset.workId);
        if (work) syncWorkFavoriteCard(card, work);
      }
      if (result && works.size && state.activeView !== "favorites" && selectedWorkFilters().includes("favorite")) {
        refreshFavoriteFilteredWorks();
      }
    }
    return result;
  },
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

function personMissingLocalPreferenceKey(personId) {
  return `fanhao.showMissingLocalWorks.person.${encodeURIComponent(personId)}`;
}

function showMissingLocalForPerson(personId) {
  const key = personMissingLocalPreferenceKey(personId);
  return readStoredFlag(key, personMissingLocalPreferences.get(key) ?? true);
}

function showMissingLocalForCurrentView() {
  if (state.activeView === "search") return state.searchDisplay?.showMissing ?? state.showMissingLocalWorks;
  return state.activeView === "people" && state.selectedPersonId
    ? showMissingLocalForPerson(state.selectedPersonId) : state.showMissingLocalWorks;
}

function showCompilationsForCurrentView() {
  return state.activeView === "search" ? state.searchDisplay?.showCompilations ?? state.showCompilationWorks : state.showCompilationWorks;
}

function setShowMissingLocalForCurrentView(enabled) {
  if (state.activeView === "people" && state.selectedPersonId) {
    const key = personMissingLocalPreferenceKey(state.selectedPersonId);
    personMissingLocalPreferences.set(key, enabled);
    writeStoredFlag(key, enabled);
  } else {
    if (state.activeView === "search") state.searchDisplay.showMissing = enabled;
    state.showMissingLocalWorks = enabled;
    writeStoredFlag("fanhao.showMissingLocalWorks", enabled);
  }
  els.missingLocalToggle.checked = enabled;
}

function installWorkCardSizePreference() {
  const control = els.workCardSize;
  if (!control) return;
  const key = "fanhao.workCardSize";
  try {
    const saved = window.localStorage?.getItem(key);
    if ([...control.options].some((option) => option.value === saved)) control.value = saved;
  } catch {}
  els.workGrid.dataset.workCardSize = control.value;
  control.addEventListener("change", () => {
    els.workGrid.dataset.workCardSize = control.value;
    try {
      window.localStorage?.setItem(key, control.value);
    } catch {}
  });
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
    personWorkQuery: state.personWorkQuery,
    q: state.activeView === "search" ? state.searchQuery || state.workQuery || "" : "",
    searchFilters: state.activeView === "search" ? selectedWorkFilters().join(",") : "",
    searchSort: state.sortMode,
    searchShowMissing: showMissingLocalForCurrentView(),
    searchShowCompilations: showCompilationsForCurrentView(),
    favoriteFolderId: state.selectedFavoriteFolderId,
    favoriteQuery: state.favoriteQuery,
    historyRange: state.selectedHistoryRange,
    historyWatch: state.selectedHistoryWatch,
    historyQuery: state.historyQuery,
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
  if (next.view === "search" && url !== currentUrl) {
    const status = els.statsRow.querySelector(".search-link-controls [role=status]");
    if (status) status.textContent = "";
  }
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
  favoriteFolderPicker.close({ restoreFocus: false });
  workSearchSuggestions.close();
  window.clearTimeout(state.searchTimer);
  state.restoringRoute = false;
  return ++navigationSequence;
}

async function applyRoute(route, options = {}) {
  const navigationIntent = beginNavigation();
  const isCurrent = () => navigationIntent === navigationSequence;
  const next = normalizeRoute(route);
  if (["gallery", "novels", "music", "shortVideos"].includes(next.view)) {
    window.location.replace(routeUrl(next, { initialParams }));
    return;
  }
  try {
    // The people branch loads the scope specified by the route.
    if (next.view !== "people" && next.view !== "search") {
      await ensureLibraryLoaded({ deferMainRender: true });
    }
    if (!isCurrent()) return false;
    state.restoringRoute = true;
    if (next.view === "search") {
      await loadSearchResults(next.q, { skipRoute: true, navigationIntent, searchRoute: next });
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
          personWorkQuery: next.personWorkQuery,
          navigationIntent,
          captureIndexScroll: false,
          skipRoute: routePerson.id === next.personId,
          replaceRoute: routePerson.id !== next.personId
        });
      } else if (next.personId) {
        await selectPerson(next.personId, {
          resetFilter: false,
          personWorkQuery: next.personWorkQuery,
          navigationIntent,
          captureIndexScroll: false,
          replaceRoute: true
        });
      } else {
        showPeopleIndex({ restoreScroll: true, skipRoute: true, navigationIntent });
      }
    } else {
      if (!options.preserveSearchDraft) clearWorkSearch();
      applyCollectionRoute(next);
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

function applyCollectionRoute(route) {
  if (route.view === "favorites") {
    state.selectedFavoriteFolderId = route.favoriteFolderId;
    state.favoriteQuery = route.favoriteQuery;
  } else if (route.view === "history") {
    state.selectedHistoryRange = route.historyRange;
    state.selectedHistoryWatch = route.historyWatch;
    state.historyQuery = route.historyQuery;
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
  const isCurrent = () => request.isCurrent() && state.peopleScope === scope;
  const params = new URLSearchParams();
  if (scope !== "main") params.set("scope", scope);
  const read = (revision = "") => {
    params.set("peopleRevision", revision);
    return api(`/api/library?${params}`, { signal: request.signal });
  };
  const isFull = (data) => Array.isArray(data?.people) && data.peopleUnchanged !== true
    && (!data.scope || data.scope === scope);
  try {
    const account = captureWebAccount();
    if (libraryPeopleAccount && !sameLibraryAccount(libraryPeopleAccount, account)) libraryPeopleSnapshots.clear();
    retireEditedLibraryPeople();
    const cached = options.force ? null : libraryPeopleSnapshots.get(scope);
    const ownsResponse = (owner) => owner.revision === account.revision && (!account.owner || owner.owner === account.owner);
    let data = await read(cached?.revision);
    if (!isCurrent()) return null;
    let owner = captureWebAccount();
    if (!ownsResponse(owner)) return null;
    retireEditedLibraryPeople();
    const merged = cached && libraryPeopleSnapshots.get(scope) === cached && mergeLibraryPeople(cached, data, scope);
    if (merged) data = merged;
    else if (cached && !isFull(data)) {
      data = await read();
      if (!isCurrent()) return null;
      owner = captureWebAccount();
      if (!ownsResponse(owner)) return null;
      retireEditedLibraryPeople();
    }
    if (!isFull(data)) throw new Error("资料库响应无效，请重试。");
    const sorted = merged ? cached.sorted : sortPeopleForList(data.people);
    if (owner.owner && data.scope === scope && typeof data.peopleRevision === "string" && /^[a-f0-9]{64}$/.test(data.peopleRevision)) {
      libraryPeopleAccount = owner;
      libraryPeopleSnapshots.set(scope, { revision: data.peopleRevision, people: data.people, sorted });
    } else libraryPeopleSnapshots.delete(scope);
    state.library = data;
    state.peopleScope = normalizePeopleScope(data.scope || state.peopleScope);
    state.accessMode = data.access?.mode || "local";
    state.accessHints = data.access?.hints || {};
    state.uiConfig = normalizeUiConfig(data.uiConfig || state.uiConfig);
    if (els.topAdminLink) els.topAdminLink.hidden = !canManageWebLibrary();
    if (els.missingLocalToggle) els.missingLocalToggle.checked = showMissingLocalForCurrentView();
    if (els.collectionToggle) els.collectionToggle.checked = showCompilationsForCurrentView();
    const defaultWorkPageSize = WORK_PAGE_SIZE_BY_ACCESS[state.accessMode] || WORK_PAGE_SIZE_BY_ACCESS.remote;
    state.workPageSize = preferredWorkPageSize(Math.min(defaultWorkPageSize, Number(state.accessHints.workPageSize) || defaultWorkPageSize));
    state.personPageSize = peoplePage.personIndexPageSize();
    resetWorkPaging();
    state.people = sorted;
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
    if (!isCurrent()) return null;
    throw error;
  } finally {
    request.finish();
  }
}

const libraryPeopleSnapshots = new Map();
let libraryPeopleAccount = null;

function sameLibraryAccount(a, b) {
  return a.owner === b.owner && a.revision === b.revision;
}

function retireEditedLibraryPeople() {
  const scope = state.library?.scope;
  const snapshot = libraryPeopleSnapshots.get(scope);
  // A person can be present in both scopes.
  if (snapshot && snapshot.sorted !== state.people) libraryPeopleSnapshots.clear();
}

function mergeLibraryPeople(snapshot, metadata, scope) {
  if (metadata?.peopleUnchanged !== true || metadata.peopleRevision !== snapshot.revision
    || metadata.scope !== scope || Object.hasOwn(metadata, "people")
    || metadata.totals?.people !== snapshot.people.length) return null;
  const { peopleUnchanged, ...fresh } = metadata;
  return { ...fresh, people: snapshot.people };
}

let libraryLoadPromise = null;
let libraryLoadScope = "";

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
    ? await loadLibrary({ deferMainRender: true, force: true })
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
  const entries = people.map((person) => ({
    person,
    priority: personSourcePriority(person),
    name: displayPersonName(person)
  }));
  entries.sort((a, b) => a.priority - b.priority || browseTextCollator.compare(a.name, b.name));
  return entries.map(({ person }) => person);
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
  loadSearchResults(query, { replaceRoute: query === state.searchQuery });
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
  els.missingLocalToggle.checked = showMissingLocalForCurrentView();
  if (els.collectionToggle) els.collectionToggle.checked = showCompilationsForCurrentView();
  const classification = activeWorkClassification(view);
  document.body.classList.toggle("work-classification-view", Boolean(classification));
  els.classificationLink?.classList.toggle("active", Boolean(classification));
  if (classification) {
    document.title = "分类 · FanHao";
    els.classificationLink?.setAttribute("aria-current", "page");
  } else els.classificationLink?.removeAttribute("aria-current");
  els.workSearch.placeholder = classification
    ? "搜索本地馆藏" : "全库搜索番号、标题、人物或分类";
  els.workSearch.setAttribute("aria-label", classification
    ? "搜索本地馆藏番号、标题或人物" : "全库搜索番号、标题、人物、类别或片商");
  for (const button of els.productTabs || []) {
    const active = productButtonActive(button, view);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const activeView = classification ? "" : view === "search" ? state.searchReturnView || "people" : view;
  for (const button of els.viewTabs || []) {
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
  if (["gallery", "novels", "music", "shortVideos"].includes(view)) {
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
    state.searchDisplay = null;
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

async function openSearchPerson(person) {
  const activeScope = state.peopleScope || "main";
  const scopes = person.searchScopes;
  try {
    if (!Array.isArray(scopes) || scopes.includes(activeScope)) {
      await goToPerson(person.id);
      return;
    }
    const scope = scopes.find(value => PEOPLE_SCOPE_NAMES.has(value));
    if (!scope) return;
    const navigationIntent = beginNavigation();
    if (!await setPeopleScope(scope) || navigationIntent !== navigationSequence) return;
    clearWorkSearch();
    await selectPerson(person.id, { navigationIntent });
  } catch (error) {
    if (error?.code !== "ACCOUNT_CHANGED") toastInline(null, error.message);
  }
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
  els.missingLocalToggle.closest(".toolbar-work-filters").hidden = Boolean(activeWorkClassification());
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
  if ((state.activeView === "people" && state.selectedPersonId) || activeWorkClassification()) group.append(createPersonWorkSort(select));
  else group.append(label, select);
  select.value = state.sortMode || "releaseDesc";
  select.addEventListener("change", handleSortModeChange);
  els.sortSelect = select;
  return group;
}

function createWorkFilterControls() {
  const classification = activeWorkClassification();
  els.filterList = createBrowseFilterControls({
    options: classification ? WORK_FILTER_OPTIONS.filter(([key]) => !["missingLocal", "localOnly"].includes(key)) : WORK_FILTER_OPTIONS,
    filters: selectedWorkFilters(), includeMissing: Boolean(classification) || showMissingLocalForCurrentView(), toggle: toggleWorkFilter,
    clear: () => setWorkFilters([])
  });
  return els.filterList;
}

function handleSortModeChange(event) {
  if (event.target?.isConnected === false) return;
  syncPersonWorkSort(event.target);
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
  const classification = activeWorkClassification();
  if (classification) {
    const summary = document.createElement("div");
    summary.className = "browse-result-summary";
    summary.textContent = `当前结果 ${formatNumber(state.searchTotal)} 部`;
    renderWorkStatsContent([summary], state.works);
    return;
  }
  const stats = [
    ["搜索命中", facets.all ?? state.searchTotal],
    [searchFilterLabel(), state.searchTotal],
    ["已显示", searchVisibleCount()],
    ["本地", facets.localOnly ?? state.works.filter((work) => !work.missingLocal).length],
    ["未下载", facets.missingLocal ?? state.works.filter((work) => work.missingLocal).length]
  ];

  renderWorkStatsContent(stats.map(([label, value]) => createStatCard(label, value)), state.works);
}

function createSearchLinkControls() {
  const group = document.createElement("div");
  group.className = "stat-filter-group search-link-controls";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "stat-filter-chip";
  button.textContent = "复制搜索链接";
  const status = document.createElement("span");
  status.className = "stat-inline-summary";
  status.setAttribute("role", "status");
  const linkPath = () => routeUrl(currentRouteSnapshot(), { initialParams: new URLSearchParams(), hash: "" });
  button.addEventListener("click", async () => {
    if (!button.isConnected || state.activeView !== "search" || button.getAttribute("aria-disabled") === "true") return;
    const owner = navigationSequence;
    const path = linkPath();
    const url = new URL(path, window.location.origin);
    const isCurrent = () => button.isConnected && owner === navigationSequence && path === linkPath();
    button.setAttribute("aria-disabled", "true");
    status.textContent = "";
    try {
      await navigator.clipboard.writeText(url.href);
      if (isCurrent()) status.textContent = "搜索链接已复制";
    } catch {
      if (isCurrent()) window.prompt("复制搜索链接", url.href);
    } finally {
      button.removeAttribute("aria-disabled");
    }
  });
  group.append(button, status);
  return group;
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
  renderPersonWorkSearch();
  renderWorkStatsContent([], state.works);
  if (focusedFilter) focusWorkFilter(focusedFilter);
}

let personWorkSearchControls = null;

function renderPersonWorkSearch({ loading = false, error = false } = {}) {
  const personId = state.selectedPersonId;
  if (state.activeView !== "people" || !personId) return;
  const scope = state.peopleScope || "main";
  let controls = personWorkSearchControls;
  if (controls?.form.parentNode !== els.personProfile || controls.personId !== personId || controls.scope !== scope) {
    controls?.form.remove();
    const form = document.createElement("form");
    form.className = "person-work-search-form";
    form.setAttribute("role", "search");
    form.setAttribute("aria-label", "当前人物作品查找");
    const field = document.createElement("div");
    field.className = "search-box work-search-field person-work-search-field";
    const icon = document.createElement("span");
    icon.className = "work-search-icon";
    icon.setAttribute("aria-hidden", "true");
    const input = document.createElement("input");
    input.type = "search";
    input.maxLength = 120;
    input.autocomplete = "off";
    input.enterKeyHint = "search";
    input.placeholder = "查找当前人物的番号或标题";
    input.setAttribute("aria-label", "当前人物的番号或标题");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "person-work-search-clear";
    clear.setAttribute("aria-label", "清除搜索");
    clear.textContent = "×";
    clear.hidden = true;
    const status = document.createElement("span");
    status.className = "person-work-search-status";
    status.setAttribute("role", "status");
    controls = { form, input, clear, status, personId, scope, committed: null, navigationIntent: null };
    personWorkSearchControls = controls;
    let composing = false;
    let timer;
    function submitQuery() {
      window.clearTimeout(timer);
      if (state.activeView !== "people" || state.selectedPersonId !== personId
        || (state.peopleScope || "main") !== scope || form.parentNode !== els.personProfile) return;
      const query = input.value.trim().slice(0, 120).toWellFormed();
      if (query === state.personWorkQuery) return;
      const navigationIntent = beginNavigation();
      pushRoute({ personWorkQuery: query });
      const options = { navigationIntent, resetFilter: false, personWorkQuery: query, skipRoute: true };
      void readPersonWorksForSearch(personId, options);
    }
    function queueQuery() {
      clear.hidden = !input.value;
      window.clearTimeout(timer);
      if (composing) return;
      const owner = navigationSequence;
      timer = window.setTimeout(() => {
        if (owner === navigationSequence) submitQuery();
      }, 300);
    }
    input.addEventListener("input", queueQuery);
    input.addEventListener("compositionstart", () => {
      composing = true;
      window.clearTimeout(timer);
    });
    input.addEventListener("compositionend", () => {
      composing = false;
      queueQuery();
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!composing) submitQuery();
    });
    clear.addEventListener("click", () => {
      input.value = "";
      input.focus({ preventScroll: true });
      clear.hidden = true;
      submitQuery();
    });
    field.append(icon, input, clear);
    form.append(field, status);
    els.personProfile.append(form);
  }
  const query = state.personWorkQuery || "";
  if (controls.committed !== query || controls.navigationIntent !== navigationSequence) {
    controls.committed = query;
    controls.navigationIntent = navigationSequence;
    if (controls.input.value.trim() !== query) controls.input.value = query;
    controls.clear.hidden = !controls.input.value;
  }
  const statusText = query && !error ? loading ? "正在查找" : `${formatNumber(state.personWorksTotal)} 部匹配` : "";
  if (controls.status.textContent !== statusText) controls.status.textContent = statusText;
}

async function readPersonWorksForSearch(personId, options) {
  const isCurrent = () => options.navigationIntent === navigationSequence && state.activeView === "people"
    && state.selectedPersonId === personId && state.personWorkQuery === options.personWorkQuery;
  try {
    await selectPerson(personId, options);
  } catch (error) {
    if (!isCurrent()) return;
    renderPersonWorkSearch({ error: true });
    els.workGrid.replaceChildren(createReadRecoveryPanel({
      message: error?.message || "暂时无法载入人物作品。", isCurrent,
      heading: "人物作品暂时无法读取", hintText: "重新读取会保留当前查找条件。",
      retryLabel: "重新读取", className: "collection-error-state", retryClass: "collection-retry-button",
      retry: () => readPersonWorksForSearch(personId, options),
      getFocusTarget: () => els.workGrid.querySelector(".collection-retry-button") || personWorkSearchControls?.input
    }));
  }
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
  if (activeWorkClassification()) {
    appendWorkControls(state.works);
    return;
  }
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
    view === "rankings" ? state.selectedRankingKey : "", view === "favorites" ? [state.selectedFavoriteFolderId, state.favoriteQuery] : "",
    view === "history" ? [state.selectedHistoryRange, state.selectedHistoryWatch, state.historyQuery] : ""]);
}

function renderWorkStatsContent(content, works) {
  let controls = els.statsRow.querySelector(":scope > .work-browse-controls");
  if (controls?.dataset.workStatsContext !== workStatsContext()) controls = null;
  const search = state.activeView === "favorites" ? els.statsRow.querySelector(":scope > .favorite-search-form")
    : state.activeView === "history" ? els.statsRow.querySelector(":scope > .history-search-form") : null;
  // Removing the sort group's ancestor would close a native picker and blur it.
  for (const child of [...els.statsRow.children]) if (child !== controls && child !== search && !content.includes(child)) child.remove();
  for (const node of content) if (node.parentElement !== els.statsRow) els.statsRow.insertBefore(node, controls || search);
  appendWorkControls(works);
}

function appendWorkControls(works) {
  const wrap = els.statsRow.querySelector(":scope > .work-browse-controls") || document.createElement("div");
  wrap.className = "stat-quick-filters work-browse-controls";
  wrap.dataset.workStatsContext = workStatsContext();
  const personView = state.activeView === "people" && Boolean(state.selectedPersonId);
  const classification = activeWorkClassification();
  const advancedPaneId = personView ? "personAdvancedFilters" : classification ? "classificationAdvancedFilters" : "";
  const sort = wrap.querySelector(":scope > .stat-sort-group") || createWorkSortControls();
  const advancedToggle = advancedPaneId ? wrap.querySelector(":scope > .browse-advanced-toggle") : null;
  const searchLink = state.activeView === "search"
    ? wrap.querySelector(":scope > .search-link-controls") || createSearchLinkControls() : null;
  for (const child of [...wrap.children]) if (child !== sort && child !== advancedToggle && child !== searchLink) child.remove();
  if (sort.parentElement !== wrap) wrap.append(sort);
  if (searchLink && searchLink.parentElement !== wrap) wrap.append(searchLink);
  if (els.sortSelect.value !== state.sortMode) els.sortSelect.value = state.sortMode;
  syncPersonWorkSort(els.sortSelect);
  wrap.insertBefore(createWorkFilterControls(), advancedToggle || sort);
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
  const traits = createBrowseTraitControls({ ...currentTraitFacets(works), filters: selectedWorkFilters(),
    toggle: toggleWorkFilter, showResultTotal: !advancedPaneId });
  if (advancedPaneId) appendAdvancedWorkFilters(wrap, sort, advancedToggle, traits, advancedPaneId);
  else {
    appendMetadataQuickFilters(works, wrap);
    if (traits) wrap.append(traits);
  }
  if (wrap.parentElement !== els.statsRow) els.statsRow.append(wrap);
  if (pendingWorkFilterFocus) {
    focusWorkFilter(pendingWorkFilterFocus);
    pendingWorkFilterFocus = null;
  }
}

function appendAdvancedWorkFilters(wrap, sort, existing, traits, paneId) {
  const pane = document.createElement("div");
  pane.className = "browse-advanced-filters";
  pane.id = paneId;
  if (traits) pane.append(traits);
  if (!pane.childElementCount) {
    existing?.remove();
    return;
  }
  const hasAdvancedFilters = Boolean(traits.querySelector('[aria-pressed="true"]'));
  const control = existing || document.createElement("button");
  if (!existing) {
    control.type = "button";
    control.className = "folder-button browse-advanced-toggle";
    control.textContent = "高级搜索";
    control.setAttribute("aria-controls", pane.id);
    control.setAttribute("aria-expanded", String(paneId === "classificationAdvancedFilters" && hasAdvancedFilters));
    control.addEventListener("click", () => {
      const current = wrap.querySelector(":scope > .browse-advanced-filters");
      if (!current) return;
      current.hidden = !current.hidden;
      control.setAttribute("aria-expanded", String(!current.hidden));
    });
    wrap.insertBefore(control, sort);
  }
  control.classList.toggle("active", hasAdvancedFilters);
  pane.hidden = control.getAttribute("aria-expanded") !== "true";
  wrap.append(pane);
}

function isPersonBulkDeleteAvailable() {
  return state.activeView === "people" && Boolean(state.selectedPersonId) && canManageWebLibrary(isTrustedNetworkFeatureAvailable());
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
  if ((value === "all" || value === "missingLocal") && !showMissingLocalForCurrentView() && !activeWorkClassification()) {
    setShowMissingLocalForCurrentView(true);
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
  return selectWorkCards(state.works, {
    query: state.activeView === "search" ? "" : state.workQuery,
    filters: selectedWorkFilters()
  });
}

function selectWorkCards(works, { query = "", filters, sortMode = state.sortMode }) {
  return selectVisibleWorks(works, {
    query,
    filters,
    sortMode,
    showCompilationWorks: showCompilationsForCurrentView(),
    showMissingLocalWorks: state.activeView === "search" ? showMissingLocalForCurrentView() : state.showMissingLocalWorks,
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
  workSearchSuggestions.close();
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
  const scopedQuery = scopedWorkSearch(value);
  return loadSearchResults(scopedQuery, { replaceRoute: !scopedQuery || scopedQuery === state.searchQuery, ...options });
}

function activeWorkClassification(view = state.activeView) {
  return view === "search" ? parseClassificationQuery(state.searchQuery) : null;
}

function scopedWorkSearch(value) {
  const classification = activeWorkClassification();
  return classification ? classificationQuery(classification.key, value) : value;
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
  const rawQuery = String(query || "").trim();
  const classification = parseClassificationQuery(rawQuery);
  const normalizedQuery = classification ? classificationQuery("all", classification.query) : rawQuery;
  const visibleQuery = classification ? classification.query : normalizedQuery;
  state.workQuery = visibleQuery;
  if (!options.preserveSearchDraft && els.workSearch && els.workSearch.value !== visibleQuery) {
    els.workSearch.value = visibleQuery;
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
  const searchRoute = options.searchRoute;
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
  }

  if (searchRoute || (classification && (classification.filter || !activeWorkClassification()))) {
    const validFilters = normalizeWorkFilters(searchRoute?.searchFilters)
      .filter(filter => WORK_FILTER_OPTIONS.some(([value]) => value === filter) || traitFilterLabel(filter));
    const filters = normalizeWorkFilters([classification?.filter, ...validFilters]);
    state.filterMode = filters.join(",") || "all";
  }
  if (searchRoute || enteringSearch) {
    state.searchDisplay = {
      showMissing: searchRoute?.searchShowMissing ?? state.showMissingLocalWorks,
      showCompilations: searchRoute?.searchShowCompilations ?? state.showCompilationWorks
    };
  }
  const searchSort = searchRoute?.searchSort ?? (enteringSearch && state.sortMode === "ranking" ? "releaseDesc" : state.sortMode);
  state.sortMode = normalizeFanhaoSearchSort(searchSort, Boolean(classification));
  state.activeView = "search";
  if (enteringSearch || state.searchQuery !== normalizedQuery) els.statsRow.innerHTML = "";
  state.searchQuery = normalizedQuery;
  syncNavigationState("search");
  hidePersonProfile();
  if (classification) {
    setMainHeader("分类", "本地馆藏 · 按番号、标题或人物搜索");
  } else setMainHeader(`搜索：${normalizedQuery}`, "全库 · 番号 / 标题 / 文件名 / 人物 / 类别 / 片商");
  els.workGrid.innerHTML = `<div class="empty-state">正在全库搜索</div>`;
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
      const reloadOptions = { ...routeOptions, preserveSearchDraft: true, searchRoute: undefined };
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
    renderWorks(visibleQuery ? `没有搜到「${visibleQuery}」。` : "此分类暂无作品。");
    syncRouteAfterNavigation(routeOptions);
  } catch (error) {
    if (!ownsSearch()) return;
    syncRouteAfterNavigation(routeOptions);
    els.workGrid.replaceChildren(createSearchRecoveryPanel({
      message: error.message,
      isCurrent: ownsSearch,
      retry: () => loadSearchResults(normalizedQuery, { ...options, replaceRoute: true, navigationIntent, preserveSearchDraft: true, searchRoute: undefined }),
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
    appendEmpty(state.activeView === "favorites" && state.favoriteQuery ? "当前收藏中没有匹配的作品。" : emptyMessage);
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
          ? state.rankingScopeTotal ?? state.rankingTotal
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
    if (state.personWorkQuery) {
      if (activeFilters.length) actions.push({ label: "清除筛选", primary: true, run: clearEmptyStateFilters });
      if (!showMissingLocalForCurrentView()) actions.push({ label: "显示未下载", run: showMissingLocalFromEmptyState });
      return { title: "当前人物没有符合条件的作品。", detail: "试试其他番号或标题。", actions };
    }
    if (hasFilteredWorks || activeFilters.length || state.workQuery.trim()) {
      actions.push({ label: "清除筛选", primary: true, run: clearEmptyStateFilters });
      if (!showMissingLocalForCurrentView()) actions.push({ label: "显示未下载", run: showMissingLocalFromEmptyState });
      return {
        title: "当前筛选没有作品",
        detail: "这个人物仍在资料库中，换个筛选条件可以继续查看。",
        actions
      };
    }

    actions.push({ label: "返回人物列表", primary: true, run: returnToPeopleIndex });
    if (!showMissingLocalForCurrentView()) actions.push({ label: "显示未下载", run: showMissingLocalFromEmptyState });
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
  setShowMissingLocalForCurrentView(true);
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
  if (state.activeView !== "search") return;
  const people = state.searchPeople.filter(person => !Array.isArray(person.searchScopes) || person.searchScopes.length);
  if (!people.length) return;

  const panel = document.createElement("div");
  panel.className = "search-people-panel";

  const label = document.createElement("div");
  label.className = "search-people-title";
  label.textContent = "人物命中";
  panel.append(label);

  const list = document.createElement("div");
  list.className = "search-people-list";

  for (const person of people) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-person-chip";
    button.textContent = `${displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
    button.addEventListener("click", () => {
      void openSearchPerson(person);
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
  card.dataset.workId = work.id;
  if (isPersonBulkDeleteActive() && state.personBulkDeleteSelectedIds.has(String(work.id))) {
    card.classList.add("bulk-delete-selected");
  }

  const cover = document.createElement("button");
  cover.type = "button";
  cover.className = "cover-wrap work-card-main";
  cover.setAttribute("aria-label", work.missingLocal ? `打开 JavDB：${work.title}` : `打开作品：${work.title}`);

  const coverFrame = document.createElement("div");
  coverFrame.className = "work-cover";
  coverFrame.addEventListener("click", () => handleWorkCardPrimaryClick(work, cover, bulkOwner));
  coverFrame.append(cover);

  const resolvedCoverUrl = workCoverUrl(work);
  if (resolvedCoverUrl) {
    appendProgressiveCoverImage(cover, resolvedCoverUrl, index);
  } else {
    cover.append(els.placeholderTemplate.content.cloneNode(true));
  }

  const coverTop = document.createElement("div");
  coverTop.className = "work-cover-top";
  const coverActions = document.createElement("div");
  coverActions.className = "work-cover-actions";
  const rankNo = Number(work.ranking?.rankNo);
  if (Number.isInteger(rankNo) && rankNo > 0) {
    const rank = document.createElement("span");
    rank.className = `cover-badge cover-ranking${rankNo <= 3 ? ` podium-${rankNo}` : ""}`;
    rank.textContent = `TOP ${formatNumber(rankNo)}`;
    rank.setAttribute("aria-hidden", "true");
    cover.setAttribute("aria-label", `${rank.textContent}，${cover.getAttribute("aria-label")}`);
    coverTop.append(rank);
  }
  if (!work.missingLocal && work.traits?.flags?.quality4k === true) {
    const quality = document.createElement("span");
    quality.className = "cover-badge cover-quality";
    quality.textContent = "4K";
    quality.setAttribute("aria-hidden", "true");
    cover.setAttribute("aria-label", `4K，${cover.getAttribute("aria-label")}`);
    coverTop.append(quality);
  }
  if (!work.missingLocal) {
    coverActions.prepend(createWorkFavoriteButton(work), createLocalMarkerButton(work, "A"));
    if (isPersonBulkDeleteActive()) coverActions.prepend(createBulkDeleteSelectButton(work));
    const flags = work.traits?.flags || {};
    const markers = [
      [flags.ltxLocal, "本机LTX", "本机 LTX 处理完成"],
      [flags.ltx && !flags.ltxLocal, "LTX", "LTX 版本标记"],
      [flags.embeddedChinese, "C", "视频文件名或目录名标记为内嵌中字"],
      [flags.uncensored, "U", "无码版本标记"],
      [flags.hasChineseSidecar, "中字", "有外挂中文字幕文件"],
      [flags.hasSidecar && !flags.hasChineseSidecar, "外挂字幕", "有独立字幕文件"]
    ];
    for (const [enabled, label, description] of markers) {
      if (!enabled) continue;
      const badge = document.createElement("span");
      badge.className = "cover-badge cover-marker";
      badge.textContent = label;
      badge.title = description;
      coverActions.append(badge);
    }
  }
  if (coverActions.childElementCount) coverTop.append(coverActions);
  if (coverTop.childElementCount) coverFrame.append(coverTop);

  const body = document.createElement("div");
  body.className = "work-body";
  body.addEventListener("click", () => handleWorkCardPrimaryClick(work, body, bulkOwner));

  const title = document.createElement("div");
  title.className = "work-title";
  title.textContent = work.title;

  const facts = document.createElement("div");
  facts.className = "work-card-facts";
  const updated = document.createElement("div");
  updated.className = "work-updated";
  const watchedDate = state.activeView === "history" ? formatDate(work.progress?.updatedAt) : "";
  updated.textContent = watchedDate ? `观看于 ${watchedDate}`
    : formatDate(work.infoSummary?.releaseDate || work.modifiedAt) || (work.missingLocal ? "未下载" : "日期未知");
  facts.append(updated);
  if (!work.missingLocal && state.activeView !== "favorites" && !isPersonBulkDeleteActive()) {
    facts.classList.add("has-favorite-folder-action");
    facts.append(createWorkFavoriteFolderButton(work));
  }

  const coverBottom = document.createElement("div");
  coverBottom.className = "work-cover-bottom";
  if (work.missingLocal && work.availability?.hasMagnet === true) {
    const magnet = document.createElement("span");
    magnet.className = "cover-badge info-chip magnet";
    magnet.textContent = work.availability.hasSubtitles ? "中字磁链" : "含磁链";
    magnet.title = "资料来源标记有磁链，未验证当前下载可用性。中字磁链仅表示资源资料线索，不代表本地文件有字幕。";
    coverBottom.append(magnet);
  }
  if (work.missingLocal && canManageWebLibrary(state.accessMode === "local")) {
    const compilationButton = document.createElement("button");
    compilationButton.type = "button";
    compilationButton.className = "cover-badge inline-rule-button";
    compilationButton.textContent = "标为合集";
    compilationButton.addEventListener("click", (event) => {
      event.stopPropagation();
      markWorkAsCompilation(work, compilationButton);
    });
    coverBottom.append(compilationButton);
  }

  const rating = createCoverRating(work);
  if (rating) {
    cover.title = rating.getAttribute("aria-label");
    coverBottom.append(rating);
  }
  if (coverBottom.childElementCount) coverFrame.append(coverBottom);

  body.append(title, facts);
  if (state.activeView === "history" && !work.missingLocal && work.progress?.videoId) {
    body.append(createHistoryPlaybackAction(work));
  }
  if (state.activeView === "favorites" && work.favorite) {
    const flags = document.createElement("div");
    flags.className = "work-card-flags";
    flags.append(createFavoriteFolderSelect(work), collectionPage.createFavoriteBatchSelection(work));
    body.append(flags);
  }
  if (!work.missingLocal && !isPersonBulkDeleteActive()) {
    cover.dataset.playbackWorkId = String(work.id);
    body.dataset.playbackWorkId = String(work.id);
  }
  card.append(coverFrame, body);
  return card;
}

function createWorkFavoriteButton(work) {
  const favorite = document.createElement("button");
  const favoritePending = isFavoritePending(work.id);
  const owner = navigationSequence;
  favorite.type = "button";
  favorite.className = `favorite-button${work.favorite ? " active" : ""}${favoritePending ? " pending" : ""}`;
  favorite.disabled = favoritePending;
  favorite.title = work.favorite ? "取消收藏" : "收藏";
  favorite.setAttribute("aria-label", favoritePending ? `${favorite.title}中` : favorite.title);
  favorite.textContent = "★";
  favorite.addEventListener("click", (event) => {
    event.stopPropagation();
    if (owner !== navigationSequence || !favorite.isConnected || !els.workGrid.contains(favorite)) return;
    toggleFavorite(work.id, favorite);
  });
  return favorite;
}

function createWorkFavoriteFolderButton(work) {
  const button = document.createElement("button");
  const owner = navigationSequence;
  button.type = "button";
  button.className = "work-favorite-folder-button";
  button.textContent = "收藏到…";
  button.setAttribute("aria-haspopup", "dialog");
  syncWorkFavoriteFolderButton(button, work);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (owner !== navigationSequence || !button.isConnected || !els.workGrid.contains(button)) return;
    const current = state.works.find(item => String(item.id) === String(work.id));
    if (current && !current.missingLocal) favoriteFolderPicker.open(current, button);
  });
  return button;
}

function syncWorkFavoriteFolderButton(button, work) {
  button.title = work.favoriteFolderName ? `当前收藏夹：${work.favoriteFolderName}` : "选择收藏夹";
  button.setAttribute("aria-label", `${work.title}：选择收藏夹`);
}

function syncVisibleFavoriteCards(workId) {
  const work = state.works.find(item => String(item.id) === String(workId));
  if (!work) return;
  for (const card of els.workGrid.querySelectorAll(`.work-card[data-work-id="${CSS.escape(String(workId))}"]`)) {
    syncWorkFavoriteCard(card, work);
  }
}

function syncWorkFavoriteCard(card, work) {
  const star = card.querySelector(".favorite-button");
  if (star) syncFavoriteControl(star, work.favorite, isFavoritePending(work.id));
  const folder = card.querySelector(".work-favorite-folder-button");
  if (folder) syncWorkFavoriteFolderButton(folder, work);
  const select = card.querySelector(".favorite-folder-select");
  if (select) {
    select.value = work.favoriteFolderId || "default";
    select.disabled = isFavoriteFolderPending(work.id);
  }
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
  openWorkCard(work, { fromHistory: state.activeView === "history" });
}

function createHistoryPlaybackAction(work) {
  const progress = work.progress;
  const percent = Math.floor(Math.max(0, Math.min(100, Number(progress.percent) || 0)));
  const finished = percent === 100;
  const action = finished ? "从头播放" : progress.position > 5 ? "继续播放" : "播放";
  const link = document.createElement("a");
  link.className = "work-history-playback";
  link.href = historyPlayerUrl(work);
  link.target = "_blank";
  link.rel = "noopener";
  link.dataset.playbackWorkId = String(work.id);
  link.setAttribute("aria-label", `${action}：${work.title}，${finished ? "已看完" : `已看 ${percent}%`}`);
  const copy = document.createElement("span");
  copy.className = "work-history-copy";
  const label = document.createElement("strong");
  label.textContent = action;
  const percentLabel = document.createElement("small");
  percentLabel.textContent = finished ? "已看完" : `${percent}%`;
  copy.append(label, percentLabel);
  const meter = document.createElement("progress");
  meter.max = 100;
  meter.value = percent;
  meter.setAttribute("aria-hidden", "true");
  link.append(copy, meter);
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!link.isConnected || state.activeView !== "history") {
      event.preventDefault();
      return;
    }
    void playbackPrefetch.prepare(work.id);
  });
  return link;
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
    state.sortMode, serializedWorkFilterMode(), showMissingLocalForCurrentView(), showCompilationsForCurrentView()]);
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
        && (params.get("scope") || "main") === (state.peopleScope || "main")
        && (params.get("q") || "") === state.personWorkQuery;
    } else if (state.activeView === "codes" && state.selectedCodePrefix) {
      current = path === `/api/code-prefixes/${encodeURIComponent(state.selectedCodePrefix)}`
        && (params.get("family") === "1") === Boolean(state.selectedCodePrefixFamily);
    } else if (state.activeView === "studios") {
      current = /^\/api\/studios\/[^/]+$/.test(path) && typeof read.refresh === "function";
    } else if (state.activeView === "favorites") {
      current = path === "/api/favorites" && (params.get("folder") || "all") === (state.selectedFavoriteFolderId || "all")
        && (params.get("q") || "") === state.favoriteQuery;
    } else if (state.activeView === "history") {
      current = path === "/api/history" && (params.get("days") || "all") === (state.selectedHistoryRange || "all")
        && (params.get("watch") || "all") === (state.selectedHistoryWatch || "all")
        && (params.get("q") || "") === (state.historyQuery || "");
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

function openWorkCard(work, { fromHistory = false } = {}) {
  if (work.missingLocal) {
    if (work.javdbUrl) {
      window.open(work.javdbUrl, "_blank", "noreferrer");
    }
    return;
  }
  void playbackPrefetch.prepare(work.id);
  window.open(fromHistory ? historyPlayerUrl(work) : playerPageUrl(work.id), "_blank", "noopener");
}

function historyPlayerUrl(work) {
  const progress = work.progress;
  return playerPageUrl(work.id, progress?.videoId, {
    returnTo: routeUrl(currentRouteSnapshot(), { initialParams }),
    fromStart: progress?.percent >= 100
  });
}

function playerPageUrl(workId, videoId = "", { returnTo, fromStart = false } = {}) {
  const params = new URLSearchParams({ workId: String(workId || "") });
  if (videoId) params.set("videoId", String(videoId));
  if (returnTo) params.set("returnTo", returnTo);
  if (fromStart) params.set("t", "0");
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

function createCoverRating(work) {
  const rating = numericRating(work.infoSummary?.rating);
  const ratingCount = work.infoSummary?.ratingCount;
  if (rating === null || (rating === 0 && (ratingCount === 0 || ratingCount === "0"))) return null;

  const count = Number(ratingCount);
  const hasCount = Number.isFinite(count) && count > 0;
  const ratingText = Number.isInteger(rating) ? rating.toFixed(1) : String(rating);
  const badge = document.createElement("span");
  badge.className = "cover-badge cover-rating";
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", hasCount ? `${ratingText}分，${formatNumber(count)}人评价` : `${ratingText}分`);
  badge.textContent = `★ ${ratingText}`;
  if (hasCount) {
    const countText = document.createElement("span");
    countText.className = "cover-rating-count";
    countText.textContent = compactRatingCount.format(count).toLowerCase();
    badge.append(countText);
  }
  return badge;
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

installWorkSearchShortcut(els.workSearch);
installWorkCardSizePreference();
let workSearchComposing = false;

function workSearchEntryOverrides() {
  return state.activeView === "search" ? undefined : {
    filter: "all",
    sort: normalizeFanhaoSearchSort(state.sortMode === "ranking" ? "releaseDesc" : state.sortMode)
  };
}

function scheduleWorkSearchPrefetch(event) {
  window.clearTimeout(state.searchTimer);
  workSearchSuggestions.close();
  if (workSearchComposing || event?.isComposing) return;
  const query = els.workSearch.value.trim();
  if (!query || globalThis.navigator?.connection?.saveData) return;
  state.searchTimer = window.setTimeout(() => {
    const overrides = workSearchEntryOverrides();
    void workSearchSuggestions.show(query, searchRequests.prefetch(scopedWorkSearch(query), overrides));
  }, 160);
}

els.workSearch.addEventListener("compositionstart", () => {
  workSearchComposing = true;
  window.clearTimeout(state.searchTimer);
  workSearchSuggestions.close();
});

els.workSearch.addEventListener("compositionend", () => {
  workSearchComposing = false;
  scheduleWorkSearchPrefetch();
});

els.workSearch.addEventListener("input", scheduleWorkSearchPrefetch);
els.workSearch.addEventListener("blur", () => window.clearTimeout(state.searchTimer));

els.workSearch.addEventListener("keydown", (event) => {
  // Confirming or cancelling an IME candidate belongs to the input method.
  // Some browsers end composition before keydown but retain keyCode 229.
  if (workSearchComposing || event.isComposing || event.keyCode === 229) return;
  if (workSearchSuggestions.handleKey(event)) return;
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
  setShowMissingLocalForCurrentView(Boolean(event.target.checked));
  resetWorkPaging();
  if (state.activeView === "search" && routeFromUrl().q === state.searchQuery) replaceRoute();
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
  if (state.activeView === "search") state.searchDisplay.showCompilations = state.showCompilationWorks;
  writeStoredFlag("fanhao.showCompilationWorks", state.showCompilationWorks);
  resetWorkPaging();
  if (state.activeView === "search" && routeFromUrl().q === state.searchQuery) replaceRoute();
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
  const initialRoute = normalizeRoute(routeFromUrl());
  applyCollectionRoute(initialRoute);
  collectionPage.prefetch(initialRoute.view, { retainFailureForActivation: true });
  const moduleNavigationPromise = initializeModuleNavigation();
  const routePromise = applyRoute(initialRoute);
  const cancelRankingEntry = initialRoute.view === "rankings" ? rankingPage.prefetchEntry() : null;
  const applied = await routePromise.finally(() => cancelRankingEntry?.());
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

import { createLatestRequestGate } from "../../latest-request.js?v=20260717-fanhao-latest-request-01";
import { resolveWorkPage } from "../works/work-page-state.js";
import { createFavoriteFolderMergeDialog } from "./favorite-folder-merge.js?v=20261113-favorite-folder-merge-01";

const HISTORY_RANGES = [
  { value: "30", label: "30 天" },
  { value: "7", label: "7 天" },
  { value: "all", label: "全部" }
];
const HISTORY_WATCH_STATES = [
  { value: "all", label: "全部状态" },
  { value: "unfinished", label: "未看完" },
  { value: "finished", label: "已看完" }
];
const COLLECTION_DESKTOP_PAGE_SIZE = 64;
const COLLECTION_MOBILE_PAGE_SIZE = 48;
const COLLECTION_PREFETCH_TTL_MS = 5 * 60 * 1000;
const COLLECTION_PREFETCH_LIMIT = 8;
const FAVORITE_BATCH_LIMIT = 500;

export function createCollectionPage(deps) {
  const { api, appendLoadedWorkPage, els, formatNumber, hidePersonProfile, onWorkRead = () => null, renderEmpty, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;
  const getNavigationIntent = deps.getNavigationIntent || (() => null);
  const onHistoryFilterChange = deps.onHistoryFilterChange || (() => {});
  const onFavoriteFilterChange = deps.onFavoriteFilterChange || (() => {});
  const isFavoriteWritePending = deps.isFavoriteWritePending || (() => false);
  const removeFavoriteBatch = deps.removeFavoriteBatch;
  const renderReadError = deps.renderReadError || (({ message }) => renderEmpty(message));
  const collectionRequests = createLatestRequestGate();
  const collectionPrefetches = new Map();
  const appendOwners = { collection: null, vr: null };
  const loadedShapes = { collection: null, vr: null };
  const loadedFavoriteIds = new Set();
  let pendingRead = null;
  let readRevision = 0;
  let folderMutationPending = false;
  let favoriteBatch = null;
  let favoriteBatchWrite = null;
  let favoriteBatchNotice = null;
  let favoriteBatchControls = null;
  const collectionSearchControls = {};
  const favoriteFolderMerge = createFavoriteFolderMergeDialog({
    formatNumber, canMerge: canMergeFavoriteFolder, merge: mergeFavoriteFolder,
    focusDestination(folderId) {
      if (state.activeView !== "favorites" || state.selectedFavoriteFolderId !== folderId) return;
      [...els.statsRow.querySelectorAll("[data-favorite-folder]")].find((button) => button.dataset.favoriteFolder === folderId)
        ?.focus({ preventScroll: true });
    }
  });

  function cancelPendingRequests() {
    favoriteFolderMerge.close({ restoreFocus: false });
    closeFavoriteBatch();
    favoriteBatchNotice = null;
    favoriteBatchControls = null;
    readRevision += 1;
    collectionRequests.cancel();
    pendingRead = null;
    resetAppendOwners();
    loadedFavoriteIds.clear();
    for (const prefix of ["collection", "vr"]) {
      state[`${prefix}RawLoaded`] = null;
      state[`${prefix}HasMore`] = null;
      loadedShapes[prefix] = null;
    }
    invalidatePrefetches();
  }

  function resetAppendOwners() {
    for (const prefix of ["collection", "vr"]) {
      appendOwners[prefix] = null;
      state[`${prefix}LoadingMore`] = false;
    }
  }

  function beginRead(prefix, append) {
    if (favoriteBatch && !ownsFavoriteBatch(favoriteBatch)) closeFavoriteBatch();
    if (favoriteBatchNotice && !ownsFavoriteBatch(favoriteBatchNotice)) favoriteBatchNotice = null;
    readRevision += 1;
    if (!append) {
      resetAppendOwners();
      state[`${prefix}RawLoaded`] = null;
      state[`${prefix}HasMore`] = false;
      loadedShapes[prefix] = null;
      if (prefix === "collection") loadedFavoriteIds.clear();
    }
    const request = collectionRequests.begin();
    pendingRead = request;
    return request;
  }

  function finishRead(request) {
    if (pendingRead === request) pendingRead = null;
    request.finish();
  }

  function showReadRecovery(view, path, error, loader) {
    const owner = { revision: readRevision, navigation: getNavigationIntent() };
    const shape = requestShape(path);
    const isCurrent = () => owner.revision === readRevision && owner.navigation === getNavigationIntent()
      && state.activeView === view && requestShape(collectionPath(view)) === shape;
    const labels = { favorites: "收藏", history: "观看记录", vr: "VR 作品" };
    renderReadError({
      view, message: error?.message || `${labels[view]}读取失败`, isCurrent,
      retry() {
        if (!isCurrent()) return;
        invalidatePrefetches();
        const pending = loader();
        owner.revision = readRevision;
        return pending;
      }
    });
  }

  function isCurrentRead(request, view, path) {
    return request.isCurrent() && state.activeView === view
      && requestShape(collectionPath(view)) === requestShape(path);
  }

  function pageOffset(prefix) {
    return Number.isSafeInteger(state[`${prefix}RawLoaded`]) ? state[`${prefix}RawLoaded`] : state.works.length;
  }

  function invalidatePrefetches() {
    collectionPrefetches.clear();
  }

  function onCollectionStateChanged({ removedWorkIds = [] } = {}) {
    invalidatePrefetches();
    if (favoriteBatch && removedWorkIds.length) {
      for (const id of removedWorkIds) favoriteBatch.ids.delete(String(id));
      syncFavoriteBatchControls();
    }
    if (state.activeView !== "favorites"
      || loadedShapes.collection !== requestShape(favoritesPath())
      || !Number.isSafeInteger(state.collectionRawLoaded)) return;
    const remaining = new Set(state.works.map(work => String(work.id)));
    const removed = [...new Set(removedWorkIds.map(String))]
      .filter(id => loadedFavoriteIds.has(id) && !remaining.has(id));
    const removedCount = removed.length;
    if (!removedCount) return;
    for (const id of removed) loadedFavoriteIds.delete(id);
    // A confirmed removal shifts the server's consumed prefix left. Any read
    // sent with the earlier offset must not overwrite this corrected cursor.
    collectionRequests.cancel();
    pendingRead = null;
    resetAppendOwners();
    state.collectionRawLoaded = Math.max(0, state.collectionRawLoaded - removedCount);
    state.collectionTotal = Math.max(0, state.collectionTotal - removedCount);
    state.collectionHasMore = Boolean(state.collectionHasMore) && state.collectionRawLoaded < state.collectionTotal;
  }

  function refreshMovedFavorite(workId, folderId, { includeAll = false } = {}) {
    if (state.activeView !== "favorites" || (state.selectedFavoriteFolderId !== folderId
      && !(includeAll && state.selectedFavoriteFolderId === "all"))) return false;
    const shape = requestShape(favoritesPath());
    const loaded = loadedShapes.collection === shape;
    const pending = pendingRead?.favoriteShape === shape;
    // A pending first read still leaves the previous folder's works in state.
    // Only a committed page of this shape can prove the moved member exists.
    if ((!loaded && !pending) || (loaded && state.works.some(work => String(work.id) === String(workId)))) return false;
    invalidatePrefetches();
    void loadFavorites();
    return true;
  }

  function collectionPageSize() {
    const viewportLimit = globalThis.matchMedia?.("(max-width: 720px)")?.matches
      ? COLLECTION_MOBILE_PAGE_SIZE
      : COLLECTION_DESKTOP_PAGE_SIZE;
    return Math.max(40, Math.min(viewportLimit, Number(state.workPageSize) || viewportLimit));
  }

  function collectionPath(view, offset = 0) {
    if (view === "favorites") return favoritesPath(offset);
    if (view === "history") return historyPath(offset);
    if (view === "vr") return vrPath(offset);
    return "";
  }

  function favoritesPath(offset = 0) {
    const params = new URLSearchParams();
    params.set("filter", state.filterMode || "all");
    params.set("sort", state.sortMode || "releaseDesc");
    if (state.selectedFavoriteFolderId && state.selectedFavoriteFolderId !== "all") params.set("folder", state.selectedFavoriteFolderId);
    if (state.favoriteQuery) params.set("q", state.favoriteQuery);
    params.set("limit", String(collectionPageSize()));
    params.set("offset", String(offset || 0));
    return `/api/favorites?${params}`;
  }

  function historyPath(offset = 0, range = state.selectedHistoryRange) {
    const params = new URLSearchParams();
    params.set("filter", state.filterMode || "all");
    params.set("sort", state.sortMode || "progress");
    if (range && range !== "all") params.set("days", range);
    if (state.selectedHistoryWatch && state.selectedHistoryWatch !== "all") params.set("watch", state.selectedHistoryWatch);
    if (state.historyQuery) params.set("q", state.historyQuery);
    params.set("limit", String(collectionPageSize()));
    params.set("offset", String(offset || 0));
    return `/api/history?${params}`;
  }

  function vrPath(offset = 0) {
    const params = new URLSearchParams({
      filter: [...new Set(["vr", ...String(state.filterMode || "all").split(",").filter((value) => value && value !== "all")])].join(","),
      sort: vrSortMode(),
      limit: String(collectionPageSize()),
      offset: String(offset || 0)
    });
    return `/api/works?${params}`;
  }

  function vrSortMode() {
    const sort = state.sortMode || "releaseDesc";
    return sort === "ranking" ? "releaseDesc" : sort;
  }

  function requestShape(path) {
    const url = new URL(path, "http://fanhao.local");
    url.searchParams.delete("limit");
    url.searchParams.delete("offset");
    return `${url.pathname}?${url.searchParams}`;
  }

  function prefetch(view, options = {}) {
    const path = collectionPath(view, 0);
    if (!path) return null;
    return prefetchPath(view, path, options);
  }

  function prefetchPath(view, path, { retainFailureForActivation = false } = {}) {
    const now = Date.now();
    const shape = requestShape(path);
    const cacheKey = `${view}:${shape}`;
    const cached = collectionPrefetches.get(cacheKey);
    if (cached?.expiresAt > now) {
      collectionPrefetches.delete(cacheKey);
      collectionPrefetches.set(cacheKey, cached);
      return cached.promise;
    }
    if (cached) collectionPrefetches.delete(cacheKey);

    // Boot overlaps this explicit read with library metadata. Keep its failure
    // until activation can show recovery; speculative hover failures are dropped.
    const entry = { view, shape, expiresAt: now + COLLECTION_PREFETCH_TTL_MS, promise: null };
    const promise = api(path).then(
      (data) => ({ data, error: null }),
      (error) => ({ data: null, error })
    ).then((result) => {
      if (result.error && !retainFailureForActivation && collectionPrefetches.get(cacheKey) === entry) {
        collectionPrefetches.delete(cacheKey);
      }
      return result;
    });
    entry.promise = promise;
    collectionPrefetches.set(cacheKey, entry);
    while (collectionPrefetches.size > COLLECTION_PREFETCH_LIMIT) {
      collectionPrefetches.delete(collectionPrefetches.keys().next().value);
    }
    return promise;
  }

  async function fetchCollectionPage(view, path, request) {
    const shape = requestShape(path);
    const prefetched = collectionPrefetches.get(`${view}:${shape}`);
    if (
      prefetched?.expiresAt > Date.now()
      && new URL(path, "http://fanhao.local").searchParams.get("offset") === "0"
    ) {
      const result = await prefetched.promise;
      if (result.error) {
        if (collectionPrefetches.get(`${view}:${shape}`) === prefetched) collectionPrefetches.delete(`${view}:${shape}`);
        throw result.error;
      }
      return trimPrefetchedPage(result.data, path);
    }
    return api(path, { signal: request.signal });
  }

  function trimPrefetchedPage(data, path) {
    const limit = Number(new URL(path, "http://fanhao.local").searchParams.get("limit") || 0);
    const sourceWorks = Array.isArray(data?.works) ? data.works : [];
    if (!limit || sourceWorks.length <= limit) return data;
    const works = sourceWorks.slice(0, limit);
    return { ...data, count: works.length, limit, works };
  }

  async function loadFavorites(options = {}) {
    if (state.activeView !== "favorites") return;
    const append = Boolean(options.append);
    const offset = append ? pageOffset("collection") : 0;
    const request = beginRead("collection", append);
    if (!append) {
      els.workGrid.innerHTML = `<div class="empty-state">正在加载收藏</div>`;
      renderCollectionSearchControl("favorites");
    }
    const path = favoritesPath(offset);
    const query = state.favoriteQuery || "";
    request.favoriteShape = requestShape(path);
    const finishWorkRead = onWorkRead(path, () => isCurrentRead(request, "favorites", path));
    try {
      const data = await fetchCollectionPage("favorites", path, request);
      if (!isCurrentRead(request, "favorites", path)) return;
      if (query && data.query !== query) throw new Error("当前服务未返回收藏搜索结果，清除搜索可继续浏览。");
      applyCollectionWorks(data, append, offset, "collection");
      state.collectionTraitFacets = data.traitFacets || null;
      state.favoriteFolders = data.folders || [];
      if (data.selectedFolderId && data.selectedFolderId !== state.selectedFavoriteFolderId) {
        state.selectedFavoriteFolderId = data.selectedFolderId;
        onFavoriteFilterChange({ replace: true });
      }
      loadedShapes.collection = requestShape(favoritesPath());
      if (!append) resetWorkPaging();
      renderStatsForWorks(state.works);
      renderFavoriteFolderControls();
      if (append) appendLoadedWorkPage();
      else renderWorks("还没有收藏。");
    } catch (error) {
      if (!isCurrentRead(request, "favorites", path)) return;
      if (append) throw error;
      showReadRecovery("favorites", path, error, loadFavorites);
    } finally {
      finishWorkRead?.();
      finishRead(request);
    }
  }

  function renderCollectionSearchControl(view) {
    if (state.activeView !== view) return;
    const history = view === "history";
    const queryKey = history ? "historyQuery" : "favoriteQuery";
    const collectionLabel = history ? "观看记录" : "收藏";
    let controls = collectionSearchControls[view];
    if (controls?.form.parentNode !== els.statsRow) {
      const form = document.createElement("form");
      form.className = history ? "history-search-form" : "favorite-search-form";
      form.setAttribute("role", "search");
      form.setAttribute("aria-label", `${collectionLabel}内查找`);
      const input = document.createElement("input");
      input.type = "search";
      input.maxLength = 120;
      input.placeholder = `在${collectionLabel}中查找番号或标题`;
      input.setAttribute("aria-label", `${collectionLabel}内查找`);
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "stat-filter-chip";
      submit.textContent = "查找";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "stat-filter-chip";
      clear.textContent = "清除搜索";
      controls = { form, input, clear, committed: null };
      collectionSearchControls[view] = controls;
      let composing = false;
      input.addEventListener("compositionstart", () => { composing = true; });
      input.addEventListener("compositionend", () => { composing = false; });
      function submitQuery(value) {
        if (state.activeView !== view || collectionSearchControls[view] !== controls || form.parentNode !== els.statsRow) return;
        const query = String(value || "").trim().slice(0, 120).toWellFormed();
        if (query === (state[queryKey] || "")) {
          input.value = query;
          return;
        }
        state[queryKey] = query;
        if (history) {
          onHistoryFilterChange();
          void loadHistory();
        } else {
          onFavoriteFilterChange();
          void loadFavorites();
        }
      }
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (!composing) submitQuery(input.value);
      });
      clear.addEventListener("click", () => {
        if (document.activeElement === clear) input.focus({ preventScroll: true });
        submitQuery("");
      });
      form.append(input, submit, clear);
      els.statsRow.append(form);
    }
    const query = state[queryKey] || "";
    const navigation = getNavigationIntent();
    if (controls.committed !== query || controls.navigation !== navigation) {
      controls.committed = query;
      controls.navigation = navigation;
      controls.input.value = query;
      controls.clear.hidden = !query;
    }
  }

  function updateFavoriteHeader() {
    const folder = folderById(state.selectedFavoriteFolderId);
    const description = state.favoriteQuery
      ? `${folder?.name || "全部收藏"} · ${formatNumber(state.collectionTotal)} 部匹配`
      : folder ? `${folder.name} · ${formatNumber(folder.count || 0)} 部` : "已收藏的作品";
    setMainHeader("收藏", description);
  }

  function renderFavoriteFolderControls() {
    if (state.activeView !== "favorites") return;
    updateFavoriteHeader();
    renderCollectionSearchControl("favorites");
    if (favoriteBatch && !ownsFavoriteBatch(favoriteBatch)) closeFavoriteBatch();
    if (favoriteBatchNotice && !ownsFavoriteBatch(favoriteBatchNotice)) favoriteBatchNotice = null;
    const wrap = document.createElement("div");
    wrap.className = "stat-quick-filters favorite-folder-controls";
    const group = document.createElement("div");
    group.className = "stat-filter-group";
    const heading = document.createElement("span");
    heading.className = "stat-filter-label";
    heading.textContent = "收藏夹";
    group.append(heading, createFolderButton("all", "全部", favoriteTotal()));
    for (const folder of state.favoriteFolders || []) group.append(createFolderButton(folder.id, folder.name, folder.count || 0));
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "stat-filter-chip";
    addButton.textContent = "新建";
    addButton.dataset.folderMutation = "create";
    addButton.disabled = folderMutationPending;
    addButton.addEventListener("click", createFavoriteFolder);
    const actions = document.createElement("div");
    actions.className = "stat-filter-group";
    actions.append(addButton);
    const batchButton = createFavoriteBatchButton("批量管理", "open", () => {
      if (favoriteBatchControls?.open !== batchButton || favoriteBatch || favoriteBatchWrite || pendingRead
        || state.activeView !== "favorites") return;
      const toolbar = createFavoriteBatchToolbar();
      favoriteBatch = { ...favoriteBatchScope(), ids: new Set(), toolbar, folderId: "", message: "" };
      favoriteBatchNotice = null;
      els.workGrid.before(toolbar);
      els.workGrid.classList.add("favorite-batch-active");
      refreshFavoriteBatchTargets();
      syncFavoriteBatchControls();
      toolbar.querySelector('[data-favorite-batch="all"]').focus({ preventScroll: true });
    });
    const canBatch = state.works.length > 0 && (removeFavoriteBatch || favoriteBatchFolders().length > 0);
    if (canBatch) actions.append(batchButton);
    wrap.append(group, actions);
    const selected = folderById(state.selectedFavoriteFolderId);
    let mergeButton = null;
    if (selected && selected.id !== "default") {
      for (const [action, label, handler] of [
        ["rename", "重命名", renameFavoriteFolder],
        ["merge", "合并到收藏夹", openFavoriteFolderMerge],
        ["delete", "删除收藏夹", deleteFavoriteFolder]
      ]) {
        if (action === "merge" && !favoriteBatchFolders().length) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "stat-filter-chip";
        button.dataset.folderMutation = action;
        button.textContent = label;
        button.setAttribute("aria-label", `${label}：${selected.name}`);
        button.disabled = folderMutationPending || action === "merge" && Boolean(favoriteBatchWrite);
        button.addEventListener("click", () => button.isConnected !== false && handler(selected, button));
        if (action === "merge") mergeButton = button;
        actions.append(button);
      }
    }
    const notice = document.createElement("span");
    notice.className = "favorite-batch-feedback";
    notice.dataset.favoriteBatch = "notice";
    notice.setAttribute("role", "status");
    wrap.append(notice);
    els.statsRow.append(wrap);
    favoriteBatchControls = { open: canBatch ? batchButton : null, notice, merge: mergeButton };
    refreshFavoriteBatchTargets();
    syncFavoriteBatchControls();
  }

  function favoriteBatchScope() {
    return { navigation: getNavigationIntent(), shape: requestShape(favoritesPath()) };
  }

  function ownsFavoriteBatch(owner) {
    return state.activeView === "favorites" && owner.navigation === getNavigationIntent()
      && owner.shape === requestShape(favoritesPath());
  }

  function favoriteBatchFolders() {
    return (state.favoriteFolders || []).filter((folder) => folder.id !== state.selectedFavoriteFolderId);
  }

  function closeFavoriteBatch() {
    if (!favoriteBatch) return;
    favoriteBatch.toolbar.remove();
    favoriteBatch = null;
    els.workGrid.classList.remove("favorite-batch-active");
    syncFavoriteBatchControls();
  }

  function createFavoriteBatchButton(label, action, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stat-filter-chip";
    button.dataset.favoriteBatch = action;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function createFavoriteBatchToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "stat-filter-group favorite-batch-toolbar";
    const select = document.createElement("select");
    select.className = "stat-sort-select";
    select.dataset.favoriteBatch = "target";
    select.setAttribute("aria-label", "目标收藏夹");
    select.addEventListener("change", () => {
      if (!favoriteBatch) return;
      favoriteBatch.folderId = select.value;
      favoriteBatch.message = "";
      syncFavoriteBatchControls();
    });
    const summary = document.createElement("span");
    summary.className = "stat-inline-summary";
    summary.dataset.favoriteBatch = "summary";
    summary.setAttribute("role", "status");
    toolbar.append(summary, createFavoriteBatchButton("选择已显示", "all", selectDisplayedFavorites),
      createFavoriteBatchButton("清空选择", "clear", () => {
        if (!favoriteBatch || favoriteBatchWrite || !ownsFavoriteBatch(favoriteBatch)) return;
        favoriteBatch.ids.clear();
        favoriteBatch.message = "";
        syncFavoriteBatchControls();
        toolbar.querySelector('[data-favorite-batch="all"]').focus({ preventScroll: true });
      }), select, createFavoriteBatchButton("移动", "move", () => submitFavoriteBatch("move")));
    if (removeFavoriteBatch) {
      const remove = createFavoriteBatchButton("取消收藏", "remove", () => submitFavoriteBatch("remove"));
      remove.classList.add("danger");
      toolbar.append(remove);
    }
    toolbar.append(createFavoriteBatchButton("退出多选", "close", () => {
        closeFavoriteBatch();
        favoriteBatchControls?.open?.focus({ preventScroll: true });
      }));
    const feedback = document.createElement("span");
    feedback.className = "favorite-batch-feedback";
    feedback.dataset.favoriteBatch = "feedback";
    feedback.setAttribute("role", "status");
    toolbar.append(feedback);
    return toolbar;
  }

  function refreshFavoriteBatchTargets() {
    if (!favoriteBatch) return;
    const select = favoriteBatch.toolbar.querySelector('[data-favorite-batch="target"]');
    const folders = [{ id: "", name: "选择目标收藏夹" }, ...favoriteBatchFolders()];
    select.hidden = folders.length === 1;
    favoriteBatch.toolbar.querySelector('[data-favorite-batch="move"]').hidden = select.hidden;
    if (select.options.length === folders.length && folders.every((folder, index) => {
      const option = select.options[index];
      return option.value === folder.id && option.textContent === folder.name;
    })) return;
    select.replaceChildren(...folders.map((folder) => {
      const option = document.createElement("option");
      option.value = folder.id;
      option.textContent = folder.name;
      return option;
    }));
    select.value = favoriteBatch.folderId;
    favoriteBatch.folderId = select.value;
  }

  function createFavoriteBatchSelection(work) {
    const id = String(work.id);
    const label = document.createElement("label");
    label.className = "favorite-batch-selection";
    label.addEventListener("click", (event) => event.stopPropagation());
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.favoriteBatchWork = id;
    input.checked = Boolean(favoriteBatch?.ids.has(id));
    input.disabled = Boolean(favoriteBatchWrite);
    input.setAttribute("aria-label", `选择 ${work.title || id}`);
    input.addEventListener("change", () => {
      if (!favoriteBatch || favoriteBatchWrite || !ownsFavoriteBatch(favoriteBatch) || !input.isConnected) return;
      favoriteBatch.message = "";
      if (!input.checked) favoriteBatch.ids.delete(id);
      else addFavoriteBatchId(id);
      syncFavoriteBatchControls();
    });
    label.append(input, "选择");
    return label;
  }

  function addFavoriteBatchId(id) {
    if (favoriteBatch.ids.has(id)) return;
    if (favoriteBatch.ids.size < FAVORITE_BATCH_LIMIT) favoriteBatch.ids.add(id);
    else favoriteBatch.message = `每批最多选择 ${FAVORITE_BATCH_LIMIT} 部作品`;
  }

  function selectDisplayedFavorites() {
    if (!favoriteBatch || favoriteBatchWrite || !ownsFavoriteBatch(favoriteBatch)) return;
    favoriteBatch.message = "";
    for (const input of els.workGrid.querySelectorAll("[data-favorite-batch-work]")) {
      addFavoriteBatchId(input.dataset.favoriteBatchWork);
    }
    syncFavoriteBatchControls();
  }

  function syncFavoriteBatchControls() {
    const { open, notice, merge } = favoriteBatchControls || {};
    if (open) {
      open.hidden = Boolean(favoriteBatch);
      open.disabled = Boolean(favoriteBatchWrite);
    }
    const noticeText = favoriteBatchNotice?.message || "";
    if (notice && notice.textContent !== noticeText) notice.textContent = noticeText;
    if (merge) merge.disabled = folderMutationPending || Boolean(favoriteBatchWrite);
    if (!favoriteBatch) return;
    const control = (action) => favoriteBatch.toolbar.querySelector(`[data-favorite-batch="${action}"]`);
    const feedback = control("feedback");
    if (feedback.textContent !== favoriteBatch.message) feedback.textContent = favoriteBatch.message;
    const count = favoriteBatch.ids.size;
    const summary = control("summary");
    const countLabel = `已选 ${formatNumber(count)} 部`;
    if (summary.textContent !== countLabel) summary.textContent = countLabel;
    for (const action of ["target", "all", "close"]) control(action).disabled = Boolean(favoriteBatchWrite);
    control("clear").disabled = !count || Boolean(favoriteBatchWrite);
    const move = control("move");
    move.disabled = !count || !control("target").value || Boolean(favoriteBatchWrite);
    move.textContent = favoriteBatchWrite === "move" ? "正在移动" : "移动";
    const remove = control("remove");
    if (remove) {
      remove.disabled = !count || Boolean(favoriteBatchWrite);
      remove.textContent = favoriteBatchWrite === "remove" ? "正在取消收藏" : "取消收藏";
    }
    for (const input of els.workGrid.querySelectorAll("[data-favorite-batch-work]")) {
      input.checked = favoriteBatch.ids.has(input.dataset.favoriteBatchWork);
      input.disabled = Boolean(favoriteBatchWrite);
    }
  }

  async function submitFavoriteBatch(action) {
    const batch = favoriteBatch;
    if (!batch || favoriteBatchWrite || !ownsFavoriteBatch(batch) || !batch.ids.size) return;
    const destination = favoriteBatchFolders().find((folder) => folder.id === batch.folderId);
    if (action === "move" && !destination) return;
    const workIds = [...batch.ids];
    if (workIds.some(isFavoriteWritePending)) {
      batch.message = "有选中的作品正在更新收藏，请稍后重试";
      syncFavoriteBatchControls();
      return;
    }
    if (action === "remove" && !window.confirm(`取消收藏选中的 ${formatNumber(workIds.length)} 部作品？`)) return;
    const hadFocus = batch.toolbar.contains(document.activeElement);
    let restoreFocus = false;
    favoriteBatchWrite = action;
    batch.message = "";
    syncFavoriteBatchControls();
    try {
      const data = action === "remove" ? await removeFavoriteBatch(workIds)
        : await api("/api/favorites/batch-move", { method: "PUT", body: { workIds, folderId: destination.id } });
      if (action === "move" && (data.ok !== true || data.folderId !== destination.id)) throw new Error("未收到批量移动结果，请重试");
      invalidatePrefetches();
      if (favoriteBatch === batch && ownsFavoriteBatch(batch)) {
        const name = destination && (data.folders?.find((folder) => folder.id === destination.id)?.name || destination.name);
        favoriteBatchNotice = { ...favoriteBatchScope(), message: action === "remove"
          ? `已取消收藏 ${formatNumber(workIds.length)} 部作品` : `已将 ${formatNumber(workIds.length)} 部作品归入「${name}」` };
        restoreFocus = action === "remove" && hadFocus;
        closeFavoriteBatch();
      }
      if (state.activeView === "favorites") {
        const shape = requestShape(favoritesPath());
        if (action === "remove" && ownsFavoriteBatch(batch) && data.removedWorkIds.length === workIds.length
          && loadedShapes.collection === shape && !pendingRead && (state.works.length || !state.collectionHasMore)) {
          state.collectionTraitFacets = null;
          renderStatsForWorks(state.works);
          renderFavoriteFolderControls();
          if (state.works.length) appendLoadedWorkPage();
          else renderWorks("还没有收藏。");
        } else if (loadedShapes.collection === shape || pendingRead?.favoriteShape === shape) await loadFavorites();
      }
    } catch (error) {
      if (favoriteBatch === batch && ownsFavoriteBatch(batch) && error?.code !== "ACCOUNT_CHANGED") {
        batch.message = error.message || (action === "remove" ? "批量取消收藏失败，请重试" : "批量移动失败，请重试");
      }
    } finally {
      favoriteBatchWrite = null;
      syncFavoriteBatchControls();
      if (restoreFocus && ownsFavoriteBatch(batch) && document.activeElement === document.body) {
        (favoriteBatchControls?.open || els.statsRow.querySelector(".favorite-search-form input"))?.focus({ preventScroll: true });
      }
    }
  }

  function refreshFavoriteFolderCounts() {
    if (state.activeView !== "favorites") return false;
    updateFavoriteHeader();
    const buttons = [...(els.statsRow.querySelector(".favorite-folder-controls")?.querySelectorAll("[data-favorite-folder]") || [])];
    const folders = [{ id: "all", name: "全部", count: favoriteTotal() }, ...(state.favoriteFolders || [])];
    if (buttons.length !== folders.length || buttons.some((button, index) => button.dataset.favoriteFolder !== folders[index].id)) return false;
    buttons.forEach((button, index) => { button.textContent = `${folders[index].name} ${formatNumber(folders[index].count || 0)}`; });
    return true;
  }

  async function loadHistory(options = {}) {
    if (state.activeView !== "history") return;
    const append = Boolean(options.append);
    const offset = append ? pageOffset("collection") : 0;
    const request = beginRead("collection", append);
    if (!append) {
      els.workGrid.innerHTML = `<div class="empty-state">正在加载观看记录</div>`;
      renderHistoryControls();
    }
    const path = historyPath(offset);
    const query = state.historyQuery || "";
    const finishWorkRead = onWorkRead(path, () => isCurrentRead(request, "history", path));
    try {
      const data = await fetchCollectionPage("history", path, request);
      if (!isCurrentRead(request, "history", path)) return;
      const watch = state.selectedHistoryWatch || "all";
      if (watch !== "all" && data.watch !== watch) throw new Error("服务未返回对应的观看状态，可切回全部状态查看记录。");
      if (query && data.query !== query) throw new Error("当前服务未返回观看记录搜索结果，清除搜索可继续浏览。");
      applyCollectionWorks(data, append, offset, "collection");
      loadedShapes.collection = requestShape(path);
      state.collectionTraitFacets = data.traitFacets || null;
      if (!append) resetWorkPaging();
      const rangeLabel = historyLabel(state.selectedHistoryRange);
      const total = state.collectionTotal;
      const statusLabel = HISTORY_WATCH_STATES.find(option => option.value === watch)?.label;
      const description = state.selectedHistoryRange === "all" ? "全部观看记录" : `近 ${rangeLabel}观看记录`;
      setMainHeader("继续观看", `${description}${watch === "all" ? "" : ` · ${statusLabel}`} · ${formatNumber(total)} 部${query ? "匹配" : ""}`);
      const focusedOption = document.activeElement?.dataset.historyOption;
      renderStatsForWorks(state.works);
      renderHistoryControls(focusedOption);
      if (append) appendLoadedWorkPage();
      else renderWorks(query ? "当前观看记录中没有匹配的作品。" : watch === "all" ? "暂无观看记录。" : `当前范围内暂无${statusLabel}的作品。`);
      if (!append && !query) warmHistoryRanges();
    } catch (error) {
      if (!isCurrentRead(request, "history", path)) return;
      if (append) throw error;
      showReadRecovery("history", path, error, loadHistory);
    } finally {
      finishWorkRead?.();
      finishRead(request);
    }
  }

  function warmHistoryRanges() {
    if (globalThis.navigator?.connection?.saveData) return;
    for (const option of HISTORY_RANGES) {
      if (option.value === state.selectedHistoryRange) continue;
      prefetchPath("history", historyPath(0, option.value));
    }
  }

  function applyCollectionWorks(data, append, offset, prefix) {
    const page = resolveWorkPage(data, {
      existingWorks: append ? state.works : [], offset,
      previousTotal: append ? state[`${prefix}Total`] : 0
    });
    resetSelection();
    if (append) {
      state.works.push(...page.works);
      state.workVisibleLimit += collectionPageSize();
    } else state.works = page.works;
    state[`${prefix}Total`] = page.total;
    state[`${prefix}RawLoaded`] = page.rawLoaded;
    state[`${prefix}HasMore`] = page.hasMore;
    if (prefix === "collection") {
      loadedFavoriteIds.clear();
      if (state.activeView === "favorites") {
        for (const work of state.works) loadedFavoriteIds.add(String(work.id));
      }
    }
  }

  async function loadMoreCollectionWorks(button) {
    const loader = state.activeView === "favorites" ? loadFavorites : state.activeView === "history" ? loadHistory : null;
    if (!loader) return;
    return appendPage("collection", loader, button);
  }

  async function appendPage(prefix, loader, button) {
    const view = state.activeView;
    const shape = requestShape(collectionPath(view));
    if (pendingRead || state[`${prefix}LoadingMore`]
      || !(state[`${prefix}HasMore`] ?? state.works.length < state[`${prefix}Total`])
      || (loadedShapes[prefix] !== null && loadedShapes[prefix] !== shape)) return;
    const owner = {};
    appendOwners[prefix] = owner;
    state[`${prefix}LoadingMore`] = true;
    const ownsButton = () => appendOwners[prefix] === owner && state.activeView === view
      && requestShape(collectionPath(view)) === shape;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    try {
      await loader({ append: true });
    } catch (error) {
      if (ownsButton() && button?.isConnected) button.textContent = error.message || "加载失败";
    } finally {
      if (appendOwners[prefix] !== owner) return;
      const updateButton = ownsButton();
      appendOwners[prefix] = null;
      state[`${prefix}LoadingMore`] = false;
      if (updateButton && button?.isConnected) {
        button.disabled = false;
        if (button.textContent === "正在加载") button.textContent = originalText;
      }
    }
  }

  async function loadVrWorks(options = {}) {
    if (state.activeView !== "vr") return;
    const append = Boolean(options.append);
    const offset = append ? pageOffset("vr") : 0;
    const request = beginRead("vr", append);
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载 VR 作品</div>`;
    const path = vrPath(offset);
    const finishWorkRead = onWorkRead(path, () => isCurrentRead(request, "vr", path));
    try {
      const data = await fetchCollectionPage("vr", path, request);
      if (!isCurrentRead(request, "vr", path)) return;
      state.selectedPersonId = null;
      state.selectedStudio = null;
      state.selectedStudioSeriesId = "all";
      applyCollectionWorks(data, append, offset, "vr");
      loadedShapes.vr = requestShape(path);
      state.vrTraitFacets = data.traitFacets || null;
      if (!append) resetWorkPaging();
      setMainHeader("VR", `全库 VR 作品 · ${formatNumber(state.vrTotal)} 部`);
      renderStatsForWorks(state.works);
      if (append) appendLoadedWorkPage();
      else renderWorks("没有 VR 作品。");
    } catch (error) {
      if (!isCurrentRead(request, "vr", path)) return;
      if (append) throw error;
      showReadRecovery("vr", path, error, loadVrWorks);
    } finally {
      finishWorkRead?.();
      finishRead(request);
    }
  }

  async function loadMoreVrWorks(button) {
    if (state.activeView !== "vr") return;
    return appendPage("vr", loadVrWorks, button);
  }

  function resetSelection() {
    state.selectedPerson = null;
    state.searchPeople = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    state.collectionTraitFacets = null;
    state.vrTraitFacets = null;
    state.collectionTotal = 0;
    state.vrTotal = 0;
    hidePersonProfile();
  }

  function folderById(folderId) {
    return (state.favoriteFolders || []).find((folder) => folder.id === folderId) || null;
  }

  function favoriteTotal() {
    return (state.favoriteFolders || []).reduce((sum, folder) => sum + Number(folder.count || 0), 0);
  }

  function createFolderButton(folderId, name, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat-filter-chip${state.selectedFavoriteFolderId === folderId ? " active" : ""}`;
    button.dataset.favoriteFolder = folderId;
    button.setAttribute("aria-pressed", String(state.selectedFavoriteFolderId === folderId));
    button.textContent = `${name} ${formatNumber(count || 0)}`;
    button.addEventListener("click", () => {
      if (button.isConnected === false || state.activeView !== "favorites" || state.selectedFavoriteFolderId === folderId) return;
      state.selectedFavoriteFolderId = folderId;
      onFavoriteFilterChange();
      loadFavorites();
    });
    return button;
  }

  async function createFavoriteFolder() {
    if (folderMutationPending) return;
    const name = window.prompt("新收藏夹名称");
    if (!name?.trim()) return;
    await mutateFavoriteFolder("/api/favorite-folders", { method: "POST", body: { name } });
  }

  async function renameFavoriteFolder(folder) {
    if (folderMutationPending) return;
    const name = window.prompt("收藏夹新名称", folder.name);
    if (name === null) return;
    await mutateFavoriteFolder(`/api/favorite-folders/${encodeURIComponent(folder.id)}`, {
      method: "PATCH", body: { name }
    }, folder.id);
  }

  async function deleteFavoriteFolder(folder) {
    if (folderMutationPending) return;
    const destination = folderById("default")?.name || "默认收藏";
    if (!window.confirm(`删除收藏夹“${folder.name}”？其中的收藏将移回“${destination}”，已收藏的作品会保留。`)) return;
    await mutateFavoriteFolder(`/api/favorite-folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" }, folder.id);
  }

  function canMergeFavoriteFolder(sourceId, targetId) {
    return state.activeView === "favorites" && state.selectedFavoriteFolderId === sourceId
      && sourceId !== "default" && !folderMutationPending && !favoriteBatchWrite
      && (targetId === undefined || targetId !== sourceId && Boolean(folderById(targetId)));
  }

  function openFavoriteFolderMerge(folder, trigger) {
    if (canMergeFavoriteFolder(folder.id)) favoriteFolderMerge.open(folder, favoriteBatchFolders(), trigger);
  }

  async function mergeFavoriteFolder(source, target) {
    return mutateFavoriteFolder(`/api/favorite-folders/${encodeURIComponent(source.id)}/merge`, {
      method: "POST",
      body: { destinationId: target.id, sourceCreatedAt: source.createdAt || "", destinationCreatedAt: target.createdAt || "" }
    }, source.id, target.id);
  }

  async function mutateFavoriteFolder(path, options, sourceFolderId = "", mergeTargetId = "") {
    folderMutationPending = true;
    setFolderMutationPending();
    invalidatePrefetches();
    try {
      const data = await api(path, options);
      if (mergeTargetId && (data.ok !== true || data.deletedFolderId !== sourceFolderId || data.destinationFolder?.id !== mergeTargetId
        || !Number.isSafeInteger(data.movedCount) || data.movedCount < 0)) {
        throw new Error("未收到收藏夹合并结果，请刷新收藏夹后重试");
      }
      invalidatePrefetches();
      // Refresh favorites without cancelling a later navigation to history or VR.
      if (state.activeView === "favorites") collectionRequests.cancel();
      state.favoriteFolders = data.folders || state.favoriteFolders;
      if (state.library && data.user) state.library.user = data.user;
      const destination = data.deletedFolderId ? data.destinationFolder || data.defaultFolder : data.folder;
      if (sourceFolderId && destination) {
        const works = new Set([...(state.works || []), ...(state.library?.works || []), state.currentWork]);
        for (const work of works) {
          if (work?.favorite && work.favoriteFolderId === sourceFolderId) {
            work.favoriteFolderId = destination.id;
            work.favoriteFolderName = destination.name;
          }
        }
      }
      if (data.deletedFolderId && state.selectedFavoriteFolderId === data.deletedFolderId) {
        state.selectedFavoriteFolderId = destination?.id || "default";
        if (state.activeView === "favorites") {
          onFavoriteFilterChange({ replace: true });
          if (mergeTargetId) favoriteBatchNotice = { ...favoriteBatchScope(), message: `已将 ${formatNumber(data.movedCount)} 部收藏合并到「${destination.name}」` };
        }
      }
      await loadFavorites();
    } catch (error) {
      if (mergeTargetId) throw error;
      if (error?.code !== "ACCOUNT_CHANGED") window.alert(error.message || "收藏夹更新失败");
    } finally {
      folderMutationPending = false;
      setFolderMutationPending();
    }
  }

  function setFolderMutationPending() {
    for (const button of els.statsRow.querySelectorAll("button[data-folder-mutation]")) {
      button.disabled = folderMutationPending || button.dataset.folderMutation === "merge" && Boolean(favoriteBatchWrite);
    }
  }

  function historyLabel(value) {
    return HISTORY_RANGES.find((item) => item.value === value)?.label || "30 天";
  }

  function renderHistoryControls(focusedOption = document.activeElement?.dataset.historyOption) {
    if (state.activeView !== "history") return;
    renderCollectionSearchControl("history");
    els.statsRow.querySelector(".history-range-controls")?.remove();
    const wrap = document.createElement("div");
    wrap.className = "stat-quick-filters history-range-controls";
    let focusTarget;
    for (const [key, label, options, fallback] of [
      ["selectedHistoryRange", "时间范围", HISTORY_RANGES, "30"],
      ["selectedHistoryWatch", "观看状态", HISTORY_WATCH_STATES, "all"]
    ]) {
      const group = document.createElement("div");
      group.className = "stat-filter-group";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", label);
      const heading = document.createElement("span");
      heading.className = "stat-filter-label";
      heading.textContent = label;
      group.append(heading);
      for (const option of options) {
        const button = document.createElement("button");
        const active = (state[key] || fallback) === option.value;
        button.type = "button";
        button.className = `stat-filter-chip${active ? " active" : ""}`;
        button.dataset.historyOption = `${key}:${option.value}`;
        button.setAttribute("aria-pressed", String(active));
        button.textContent = option.label;
        if (button.dataset.historyOption === focusedOption) focusTarget = button;
        button.addEventListener("click", () => {
          if (!button.isConnected || state.activeView !== "history" || (state[key] || fallback) === option.value) return;
          state[key] = option.value;
          onHistoryFilterChange();
          void loadHistory();
        });
        group.append(button);
      }
      wrap.append(group);
    }
    els.statsRow.append(wrap);
    focusTarget?.focus({ preventScroll: true });
  }

  return { cancelPendingRequests, createFavoriteBatchSelection, invalidatePrefetches, onCollectionStateChanged, loadFavorites, loadHistory, loadMoreCollectionWorks, loadMoreVrWorks, loadVrWorks, prefetch, refreshFavoriteFolderCounts, refreshMovedFavorite, renderFavoriteFolderControls };
}

import { createLatestRequestGate } from "../../latest-request.js?v=20260717-fanhao-latest-request-01";
import { resolveWorkPage } from "../works/work-page-state.js";

const HISTORY_RANGES = [
  { value: "30", label: "30 天" },
  { value: "7", label: "7 天" },
  { value: "all", label: "全部" }
];
const COLLECTION_DESKTOP_PAGE_SIZE = 64;
const COLLECTION_MOBILE_PAGE_SIZE = 48;
const COLLECTION_PREFETCH_TTL_MS = 5 * 60 * 1000;
const COLLECTION_PREFETCH_LIMIT = 8;

export function createCollectionPage(deps) {
  const { api, appendLoadedWorkPage, els, formatNumber, hidePersonProfile, onWorkRead = () => null, renderEmpty, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;
  const getNavigationIntent = deps.getNavigationIntent || (() => null);
  const renderReadError = deps.renderReadError || (({ message }) => renderEmpty(message));
  const collectionRequests = createLatestRequestGate();
  const collectionPrefetches = new Map();
  const appendOwners = { collection: null, vr: null };
  const loadedShapes = { collection: null, vr: null };
  const loadedFavoriteIds = new Set();
  let pendingRead = null;
  let readRevision = 0;
  let folderMutationPending = false;

  function cancelPendingRequests() {
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

  function refreshMovedFavorite(workId, folderId) {
    if (state.activeView !== "favorites" || state.selectedFavoriteFolderId !== folderId) return false;
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
    params.set("limit", String(collectionPageSize()));
    params.set("offset", String(offset || 0));
    return `/api/favorites?${params}`;
  }

  function historyPath(offset = 0, range = state.selectedHistoryRange) {
    const params = new URLSearchParams();
    params.set("filter", state.filterMode || "all");
    params.set("sort", state.sortMode || "progress");
    if (range && range !== "all") params.set("days", range);
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
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载收藏</div>`;
    const path = favoritesPath(offset);
    request.favoriteShape = requestShape(path);
    const finishWorkRead = onWorkRead(path, () => isCurrentRead(request, "favorites", path));
    try {
      const data = await fetchCollectionPage("favorites", path, request);
      if (!isCurrentRead(request, "favorites", path)) return;
      applyCollectionWorks(data, append, offset, "collection");
      state.collectionTraitFacets = data.traitFacets || null;
      state.favoriteFolders = data.folders || [];
      state.selectedFavoriteFolderId = data.selectedFolderId || state.selectedFavoriteFolderId || "all";
      loadedShapes.collection = requestShape(favoritesPath());
      if (!append) resetWorkPaging();
      const folder = folderById(state.selectedFavoriteFolderId);
      setMainHeader("收藏", folder ? `${folder.name} · ${formatNumber(folder.count || 0)} 部` : "已收藏的作品");
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

  function renderFavoriteFolderControls() {
    if (state.activeView !== "favorites") return;
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
    wrap.append(group, actions);
    const selected = folderById(state.selectedFavoriteFolderId);
    if (selected && selected.id !== "default") {
      for (const [action, label, handler] of [
        ["rename", "重命名", renameFavoriteFolder],
        ["delete", "删除收藏夹", deleteFavoriteFolder]
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "stat-filter-chip";
        button.dataset.folderMutation = action;
        button.textContent = label;
        button.setAttribute("aria-label", `${label}：${selected.name}`);
        button.disabled = folderMutationPending;
        button.addEventListener("click", () => handler(selected));
        actions.append(button);
      }
    }
    els.statsRow.append(wrap);
  }

  function refreshFavoriteFolderCounts() {
    if (state.activeView !== "favorites") return false;
    const selected = folderById(state.selectedFavoriteFolderId);
    setMainHeader("收藏", selected ? `${selected.name} · ${formatNumber(selected.count || 0)} 部` : "已收藏的作品");
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
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载观看记录</div>`;
    const path = historyPath(offset);
    const finishWorkRead = onWorkRead(path, () => isCurrentRead(request, "history", path));
    try {
      const data = await fetchCollectionPage("history", path, request);
      if (!isCurrentRead(request, "history", path)) return;
      applyCollectionWorks(data, append, offset, "collection");
      loadedShapes.collection = requestShape(path);
      state.collectionTraitFacets = data.traitFacets || null;
      if (!append) resetWorkPaging();
      const rangeLabel = historyLabel(state.selectedHistoryRange);
      const total = state.collectionTotal;
      setMainHeader("继续观看", state.selectedHistoryRange === "all" ? "全部有播放进度的作品" : `${rangeLabel}有播放进度的作品 · ${formatNumber(total)} 部`);
      renderStatsForWorks(state.works);
      renderHistoryControls(data);
      if (append) appendLoadedWorkPage();
      else renderWorks("暂无观看记录。");
      if (!append) warmHistoryRanges();
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
    button.textContent = `${name} ${formatNumber(count || 0)}`;
    button.addEventListener("click", () => {
      if (state.selectedFavoriteFolderId === folderId) return;
      state.selectedFavoriteFolderId = folderId;
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

  async function mutateFavoriteFolder(path, options, sourceFolderId = "") {
    folderMutationPending = true;
    setFolderMutationPending();
    invalidatePrefetches();
    try {
      const data = await api(path, options);
      invalidatePrefetches();
      // Refresh favorites without cancelling a later navigation to history or VR.
      if (state.activeView === "favorites") collectionRequests.cancel();
      state.favoriteFolders = data.folders || state.favoriteFolders;
      if (state.library && data.user) state.library.user = data.user;
      const destination = data.deletedFolderId ? data.defaultFolder : data.folder;
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
        state.selectedFavoriteFolderId = data.defaultFolder?.id || "default";
      }
      await loadFavorites();
    } catch (error) {
      if (error?.code !== "ACCOUNT_CHANGED") window.alert(error.message || "收藏夹更新失败");
    } finally {
      folderMutationPending = false;
      setFolderMutationPending();
    }
  }

  function setFolderMutationPending() {
    for (const button of els.statsRow.querySelectorAll("button[data-folder-mutation]")) {
      button.disabled = folderMutationPending;
    }
  }

  function historyLabel(value) {
    return HISTORY_RANGES.find((item) => item.value === value)?.label || "30 天";
  }

  function renderHistoryControls(data = {}) {
    if (state.activeView !== "history") return;
    const wrap = document.createElement("div");
    wrap.className = "stat-quick-filters history-range-controls";
    const group = document.createElement("div");
    group.className = "stat-filter-group";
    const heading = document.createElement("span");
    heading.className = "stat-filter-label";
    heading.textContent = "最近观看";
    group.append(heading);
    for (const option of HISTORY_RANGES) {
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

  return { cancelPendingRequests, invalidatePrefetches, onCollectionStateChanged, loadFavorites, loadHistory, loadMoreCollectionWorks, loadMoreVrWorks, loadVrWorks, prefetch, refreshFavoriteFolderCounts, refreshMovedFavorite, renderFavoriteFolderControls };
}

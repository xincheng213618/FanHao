import { createLatestRequestGate } from "../../latest-request.js?v=20260717-fanhao-latest-request-01";

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
  const { api, appendLoadedWorkPage, els, formatNumber, hidePersonProfile, renderEmpty, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;
  const collectionRequests = createLatestRequestGate();
  const collectionPrefetches = new Map();

  function cancelPendingRequests() {
    collectionRequests.cancel();
    invalidatePrefetches();
  }

  function invalidatePrefetches() {
    collectionPrefetches.clear();
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
    if (state.selectedFavoriteFolderId && state.selectedFavoriteFolderId !== "all") params.set("folder", state.selectedFavoriteFolderId);
    params.set("limit", String(collectionPageSize()));
    params.set("offset", String(offset || 0));
    return `/api/favorites?${params}`;
  }

  function historyPath(offset = 0, range = state.selectedHistoryRange) {
    const params = new URLSearchParams();
    if (range && range !== "all") params.set("days", range);
    params.set("limit", String(collectionPageSize()));
    params.set("offset", String(offset || 0));
    return `/api/history?${params}`;
  }

  function vrPath(offset = 0) {
    const params = new URLSearchParams({
      filter: "vr",
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

  function prefetch(view) {
    const path = collectionPath(view, 0);
    if (!path) return null;
    return prefetchPath(view, path);
  }

  function prefetchPath(view, path) {
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

    const promise = api(path).then(
      (data) => ({ data, error: null }),
      (error) => ({ data: null, error })
    ).then((result) => {
      if (result.error) collectionPrefetches.delete(cacheKey);
      return result;
    });
    collectionPrefetches.set(cacheKey, {
      view,
      shape,
      expiresAt: now + COLLECTION_PREFETCH_TTL_MS,
      promise
    });
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
      if (result.error) throw result.error;
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
    const request = collectionRequests.begin();
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载收藏</div>`;
    const path = favoritesPath(append ? state.works.length : 0);
    try {
      const data = await fetchCollectionPage("favorites", path, request);
      if (!request.isCurrent() || state.activeView !== "favorites") return;
      resetSelection();
      applyCollectionWorks(data.works || [], append);
      state.collectionTotal = data.total ?? data.count ?? state.works.length;
      state.favoriteFolders = data.folders || [];
      state.selectedFavoriteFolderId = data.selectedFolderId || state.selectedFavoriteFolderId || "all";
      if (!append) resetWorkPaging();
      const folder = folderById(state.selectedFavoriteFolderId);
      setMainHeader("收藏", folder ? `${folder.name} · ${formatNumber(folder.count || 0)} 部` : "已收藏的作品");
      renderStatsForWorks(state.works);
      renderFavoriteFolderControls();
      if (append) appendLoadedWorkPage();
      else renderWorks("还没有收藏。");
    } catch (error) {
      if (!request.isCurrent() || state.activeView !== "favorites") return;
      if (append) throw error;
      renderEmpty(error.message || "收藏读取失败");
    } finally {
      request.finish();
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
    addButton.addEventListener("click", createFavoriteFolder);
    wrap.append(group, addButton);
    els.statsRow.append(wrap);
  }

  async function loadHistory(options = {}) {
    if (state.activeView !== "history") return;
    const append = Boolean(options.append);
    const request = collectionRequests.begin();
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载观看记录</div>`;
    const path = historyPath(append ? state.works.length : 0);
    try {
      const data = await fetchCollectionPage("history", path, request);
      if (!request.isCurrent() || state.activeView !== "history") return;
      resetSelection();
      applyCollectionWorks(data.works || [], append);
      state.collectionTotal = data.total ?? data.count ?? state.works.length;
      if (!append) resetWorkPaging();
      const rangeLabel = historyLabel(state.selectedHistoryRange);
      const total = data.total ?? data.count ?? state.works.length;
      setMainHeader("继续观看", state.selectedHistoryRange === "all" ? "全部有播放进度的作品" : `${rangeLabel}有播放进度的作品 · ${formatNumber(total)} 部`);
      renderStatsForWorks(state.works);
      renderHistoryControls(data);
      if (append) appendLoadedWorkPage();
      else renderWorks("暂无观看记录。");
      if (!append) warmHistoryRanges();
    } catch (error) {
      if (!request.isCurrent() || state.activeView !== "history") return;
      if (append) throw error;
      renderEmpty(error.message || "观看记录读取失败");
    } finally {
      request.finish();
    }
  }

  function warmHistoryRanges() {
    if (globalThis.navigator?.connection?.saveData) return;
    for (const option of HISTORY_RANGES) {
      if (option.value === state.selectedHistoryRange) continue;
      prefetchPath("history", historyPath(0, option.value));
    }
  }

  function applyCollectionWorks(nextWorks, append) {
    if (!append) {
      state.works = nextWorks;
      return;
    }
    const seen = new Set(state.works.map((work) => work.id));
    state.works.push(...nextWorks.filter((work) => !seen.has(work.id)));
    state.workVisibleLimit += collectionPageSize();
  }

  async function loadMoreCollectionWorks(button) {
    if (state.collectionLoadingMore || state.works.length >= state.collectionTotal) return;
    const loader = state.activeView === "favorites" ? loadFavorites : state.activeView === "history" ? loadHistory : null;
    if (!loader) return;
    state.collectionLoadingMore = true;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    try {
      await loader({ append: true });
    } catch (error) {
      if (button?.isConnected) button.textContent = error.message || "加载失败";
    } finally {
      state.collectionLoadingMore = false;
      if (button?.isConnected) {
        button.disabled = false;
        if (button.textContent === "正在加载") button.textContent = originalText;
      }
    }
  }

  async function loadVrWorks(options = {}) {
    if (state.activeView !== "vr") return;
    const append = Boolean(options.append);
    const request = collectionRequests.begin();
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载 VR 作品</div>`;
    const path = vrPath(append ? state.works.length : 0);
    try {
      const data = await fetchCollectionPage("vr", path, request);
      if (!request.isCurrent() || state.activeView !== "vr") return;
      resetSelection();
      state.selectedPersonId = null;
      state.selectedStudio = null;
      state.selectedStudioSeriesId = "all";
      applyCollectionWorks(data.works || [], append);
      state.vrTotal = data.total ?? data.count ?? state.works.length;
      if (!append) resetWorkPaging();
      setMainHeader("VR", `全库 VR 作品 · ${formatNumber(state.vrTotal)} 部`);
      renderStatsForWorks(state.works);
      if (append) appendLoadedWorkPage();
      else renderWorks("没有 VR 作品。");
    } catch (error) {
      if (!request.isCurrent() || state.activeView !== "vr") return;
      if (append) throw error;
      renderEmpty(error.message || "VR 作品读取失败");
    } finally {
      request.finish();
    }
  }

  async function loadMoreVrWorks(button) {
    if (state.vrLoadingMore || state.works.length >= state.vrTotal) return;
    state.vrLoadingMore = true;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    try {
      await loadVrWorks({ append: true });
    } catch (error) {
      if (button?.isConnected) button.textContent = error.message || "加载失败";
    } finally {
      state.vrLoadingMore = false;
      if (button?.isConnected) {
        button.disabled = false;
        if (button.textContent === "正在加载") button.textContent = originalText;
      }
    }
  }

  function resetSelection() {
    state.selectedPerson = null;
    state.searchPeople = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
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
    if (!name?.trim()) return;
    try {
      const data = await api("/api/favorite-folders", { method: "POST", body: { name } });
      state.favoriteFolders = data.folders || state.favoriteFolders;
      await loadFavorites();
    } catch (error) {
      alert(error.message);
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

  return { cancelPendingRequests, invalidatePrefetches, loadFavorites, loadHistory, loadMoreCollectionWorks, loadMoreVrWorks, loadVrWorks, prefetch, renderFavoriteFolderControls };
}

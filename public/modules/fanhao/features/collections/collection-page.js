const HISTORY_RANGES = [
  { value: "30", label: "30 天" },
  { value: "7", label: "7 天" },
  { value: "all", label: "全部" }
];

export function createCollectionPage(deps) {
  const { api, els, formatNumber, hidePersonProfile, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;

  function collectionPageSize() {
    return Math.max(40, Math.min(96, Number(state.workPageSize) || 48));
  }

  async function loadFavorites(options = {}) {
    const append = Boolean(options.append);
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载收藏</div>`;
    const params = new URLSearchParams();
    if (state.selectedFavoriteFolderId && state.selectedFavoriteFolderId !== "all") params.set("folder", state.selectedFavoriteFolderId);
    params.set("limit", String(collectionPageSize()));
    params.set("offset", String(append ? state.works.length : 0));
    const data = await api(`/api/favorites?${params}`);
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
    renderWorks("还没有收藏。");
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
    const append = Boolean(options.append);
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载观看记录</div>`;
    const data = await api(historyPath(append ? state.works.length : 0));
    resetSelection();
    applyCollectionWorks(data.works || [], append);
    state.collectionTotal = data.total ?? data.count ?? state.works.length;
    if (!append) resetWorkPaging();
    const rangeLabel = historyLabel(state.selectedHistoryRange);
    const total = data.total ?? data.count ?? state.works.length;
    setMainHeader("继续观看", state.selectedHistoryRange === "all" ? "全部有播放进度的作品" : `${rangeLabel}有播放进度的作品 · ${formatNumber(total)} 部`);
    renderStatsForWorks(state.works);
    renderHistoryControls(data);
    renderWorks("暂无观看记录。");
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
    const append = Boolean(options.append);
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载 VR 作品</div>`;
    const params = new URLSearchParams({
      filter: "vr",
      sort: state.sortMode || "releaseDesc",
      limit: String(collectionPageSize()),
      offset: String(append ? state.works.length : 0)
    });
    const data = await api(`/api/works?${params}`);
    resetSelection();
    state.selectedPersonId = null;
    state.selectedStudio = null;
    state.selectedStudioSeriesId = "all";
    applyCollectionWorks(data.works || [], append);
    state.vrTotal = data.total ?? data.count ?? state.works.length;
    if (!append) resetWorkPaging();
    setMainHeader("VR", `全库 VR 作品 · ${formatNumber(state.vrTotal)} 部`);
    renderStatsForWorks(state.works);
    renderWorks("没有 VR 作品。");
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

  function historyPath(offset = 0) {
    const params = new URLSearchParams();
    if (state.selectedHistoryRange && state.selectedHistoryRange !== "all") params.set("days", state.selectedHistoryRange);
    params.set("limit", String(collectionPageSize()));
    params.set("offset", String(offset || 0));
    return `/api/history?${params}`;
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

  return { loadFavorites, loadHistory, loadMoreCollectionWorks, loadMoreVrWorks, loadVrWorks, renderFavoriteFolderControls };
}

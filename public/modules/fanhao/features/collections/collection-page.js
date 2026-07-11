const HISTORY_RANGES = [
  { value: "30", label: "30 天" },
  { value: "7", label: "7 天" },
  { value: "all", label: "全部" }
];

export function createCollectionPage(deps) {
  const { api, els, formatNumber, hidePersonProfile, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;

  async function loadFavorites() {
    els.workGrid.innerHTML = `<div class="empty-state">正在加载收藏</div>`;
    const params = new URLSearchParams();
    if (state.selectedFavoriteFolderId && state.selectedFavoriteFolderId !== "all") params.set("folder", state.selectedFavoriteFolderId);
    const query = params.toString();
    const data = await api(`/api/favorites${query ? `?${query}` : ""}`);
    resetSelection();
    state.works = data.works || [];
    state.favoriteFolders = data.folders || [];
    state.selectedFavoriteFolderId = data.selectedFolderId || state.selectedFavoriteFolderId || "all";
    resetWorkPaging();
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

  async function loadHistory() {
    els.workGrid.innerHTML = `<div class="empty-state">正在加载观看记录</div>`;
    const data = await api(historyPath());
    resetSelection();
    state.works = data.works || [];
    resetWorkPaging();
    const rangeLabel = historyLabel(state.selectedHistoryRange);
    const total = data.total ?? data.count ?? state.works.length;
    setMainHeader("继续观看", state.selectedHistoryRange === "all" ? "全部有播放进度的作品" : `${rangeLabel}有播放进度的作品 · ${formatNumber(total)} 部`);
    renderStatsForWorks(state.works);
    renderHistoryControls(data);
    renderWorks("暂无观看记录。");
  }

  async function loadVrWorks() {
    els.workGrid.innerHTML = `<div class="empty-state">正在加载 VR 作品</div>`;
    const params = new URLSearchParams({ filter: "vr", sort: state.sortMode || "releaseDesc", limit: "2000" });
    const data = await api(`/api/works?${params}`);
    resetSelection();
    state.selectedPersonId = null;
    state.selectedStudio = null;
    state.selectedStudioSeriesId = "all";
    state.works = data.works || [];
    resetWorkPaging();
    setMainHeader("VR", `全库 VR 作品 · ${formatNumber(data.total ?? state.works.length)} 部`);
    renderStatsForWorks(state.works);
    renderWorks("没有 VR 作品。");
  }

  function resetSelection() {
    state.selectedPerson = null;
    state.searchPeople = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
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

  function historyPath() {
    const params = new URLSearchParams();
    if (state.selectedHistoryRange && state.selectedHistoryRange !== "all") params.set("days", state.selectedHistoryRange);
    const query = params.toString();
    return `/api/history${query ? `?${query}` : ""}`;
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

  return { loadFavorites, loadHistory, loadVrWorks, renderFavoriteFolderControls };
}

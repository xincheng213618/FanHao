export function createStudioPage(deps) {
  const { api, appendEmpty, els, formatNumber, hidePersonProfile, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;

  async function loadStudios() {
    els.workGrid.innerHTML = `<div class="empty-state">正在加载片商</div>`;
    const data = await api("/api/studios?limit=500");
    resetSelection();
    state.studios = data.makers || [];
    setMainHeader("片商", "按片商浏览本地作品");
    renderIndex();
  }

  async function loadStudioDetail(studioId, seriesId = "all") {
    const params = new URLSearchParams({ seriesId, sort: state.sortMode || "releaseDesc", limit: "2000" });
    const data = await api(`/api/studios/${encodeURIComponent(studioId)}?${params}`);
    state.selectedStudio = data.studio || null;
    state.selectedStudioSeriesId = data.selectedSeriesId || seriesId || "all";
    state.works = data.works || [];
    resetWorkPaging();
    const studio = state.selectedStudio;
    const selectedSeries = (studio?.series || []).find((item) => item.id === state.selectedStudioSeriesId);
    setMainHeader(studio?.name || "片商", selectedSeries ? `${selectedSeries.name} · ${formatNumber(data.total || 0)} 部` : `${formatNumber(data.total || 0)} 部本地作品`);
    renderStatsForWorks(state.works);
    renderSeriesControls(studio);
    renderWorks("这个片商暂无本地作品。");
  }

  function resetSelection() {
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.selectedStudio = null;
    state.selectedStudioSeriesId = "all";
    state.works = [];
    state.searchPeople = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    hidePersonProfile();
  }

  function renderIndex() {
    els.statsRow.innerHTML = "";
    els.workGrid.innerHTML = "";
    if (!state.studios.length) {
      appendEmpty("还没有片商数据。");
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const studio of state.studios) fragment.append(createCard(studio));
    els.workGrid.append(fragment);
  }

  function createCard(studio) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "studio-card";
    button.addEventListener("click", () => loadStudioDetail(studio.id));
    const name = document.createElement("strong");
    name.textContent = studio.name || "未命名片商";
    const count = document.createElement("span");
    count.textContent = `(${formatNumber(studio.localWorkCount || studio.workCount || 0)})`;
    button.append(name, count);
    return button;
  }

  function renderSeriesControls(studio) {
    if (state.activeView !== "studios" || !studio) return;
    const series = (studio.series || []).filter((item) => Number(item.localWorkCount || 0) > 0);
    const wrap = document.createElement("div");
    wrap.className = "stat-quick-filters studio-series-controls";
    const group = document.createElement("div");
    group.className = "stat-filter-group";
    const heading = document.createElement("span");
    heading.className = "stat-filter-label";
    heading.textContent = "系列";
    group.append(heading, createSeriesButton(studio, "all", "全部", studio.localWorkCount || 0));
    for (const item of series) group.append(createSeriesButton(studio, item.id, item.name, item.localWorkCount || 0));
    wrap.append(group);
    els.statsRow.append(wrap);
  }

  function createSeriesButton(studio, seriesId, name, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat-filter-chip${state.selectedStudioSeriesId === seriesId ? " active" : ""}`;
    button.textContent = `${name} ${formatNumber(count)}`;
    button.addEventListener("click", () => loadStudioDetail(studio.id, seriesId));
    return button;
  }

  return { loadStudios, loadStudioDetail };
}

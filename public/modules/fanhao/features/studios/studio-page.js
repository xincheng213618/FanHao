import { createLatestRequestGate } from "../../latest-request.js?v=20260717-fanhao-latest-request-01";

export function createStudioPage(deps) {
  const { api, appendEmpty, els, formatNumber, hidePersonProfile, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;
  const studioRequests = createLatestRequestGate();

  function cancelPendingRequests() {
    studioRequests.cancel();
  }

  function studioPageSize() {
    return Math.max(40, Math.min(96, Number(state.workPageSize) || 48));
  }

  async function loadStudios() {
    const request = studioRequests.begin();
    els.workGrid.innerHTML = `<div class="empty-state">正在加载片商</div>`;
    try {
      const data = await api("/api/studios?limit=500", { signal: request.signal });
      if (!request.isCurrent() || state.activeView !== "studios") return;
      resetSelection();
      state.studios = data.makers || [];
      setMainHeader("片商", "按片商浏览本地作品");
      renderIndex();
    } catch (error) {
      if (!request.isCurrent() || state.activeView !== "studios") return;
      setMainHeader("片商", "读取失败");
      els.workGrid.innerHTML = "";
      appendEmpty(error.message || "片商读取失败");
    } finally {
      request.finish();
    }
  }

  async function loadStudioDetail(studioId, seriesId = "all", options = {}) {
    const append = Boolean(options.append);
    const request = studioRequests.begin();
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载片商作品</div>`;
    const params = new URLSearchParams({
      seriesId,
      sort: state.sortMode || "releaseDesc",
      limit: String(studioPageSize()),
      offset: String(append ? state.works.length : 0)
    });
    try {
      const data = await api(`/api/studios/${encodeURIComponent(studioId)}?${params}`, { signal: request.signal });
      if (!request.isCurrent() || state.activeView !== "studios") return;
      if (!append) resetSelection();
      state.selectedStudio = data.studio || state.selectedStudio || null;
      state.selectedStudioSeriesId = data.selectedSeriesId || seriesId || "all";
      applyStudioWorks(data.works || [], append);
      state.studioWorksTotal = data.total ?? data.count ?? state.works.length;
      if (!append) resetWorkPaging();
      const studio = state.selectedStudio;
      const selectedSeries = (studio?.series || []).find((item) => item.id === state.selectedStudioSeriesId);
      setMainHeader(studio?.name || "片商", selectedSeries ? `${selectedSeries.name} · ${formatNumber(state.studioWorksTotal)} 部` : `${formatNumber(state.studioWorksTotal)} 部本地作品`);
      renderStatsForWorks(state.works);
      renderSeriesControls(studio);
      renderWorks("这个片商暂无本地作品。");
    } catch (error) {
      if (!request.isCurrent() || state.activeView !== "studios") return;
      if (append) throw error;
      setMainHeader("片商", "读取失败");
      els.workGrid.innerHTML = "";
      appendEmpty(error.message || "片商作品读取失败");
    } finally {
      request.finish();
    }
  }

  function applyStudioWorks(nextWorks, append) {
    if (!append) {
      state.works = nextWorks;
      return;
    }
    const seen = new Set(state.works.map((work) => work.id));
    state.works.push(...nextWorks.filter((work) => !seen.has(work.id)));
    state.workVisibleLimit += studioPageSize();
  }

  async function loadMoreStudioWorks(button) {
    if (state.studioWorksLoadingMore || state.works.length >= state.studioWorksTotal || !state.selectedStudio) return;
    state.studioWorksLoadingMore = true;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    try {
      await loadStudioDetail(state.selectedStudio.id, state.selectedStudioSeriesId, { append: true });
    } catch (error) {
      if (button?.isConnected) button.textContent = error.message || "加载失败";
    } finally {
      state.studioWorksLoadingMore = false;
      if (button?.isConnected) {
        button.disabled = false;
        if (button.textContent === "正在加载") button.textContent = originalText;
      }
    }
  }

  function resetSelection() {
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.selectedStudio = null;
    state.selectedStudioSeriesId = "all";
    state.studioWorksTotal = 0;
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

  return { cancelPendingRequests, loadStudios, loadMoreStudioWorks, loadStudioDetail };
}

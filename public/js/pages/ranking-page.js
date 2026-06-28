export function createRankingPage(deps) {
  const {
    adminRefreshRankings,
    api,
    clearPersonSelection,
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
  } = deps;

  function enter(options = {}) {
    clearWorkFilter();
    state.sortMode = "ranking";
    els.sortSelect.value = "ranking";
    loadRankings();
    syncRouteAfterNavigation(options);
  }

  async function loadRankings() {
    els.workGrid.innerHTML = `<div class="empty-state">正在加载排行榜</div>`;
    clearPersonSelection();
    state.searchPeople = [];
    setMainHeader("排行榜", "JavDB TOP250 缓存");

    try {
      const summary = await api("/api/rankings");
      state.rankingLists = summary.lists || [];
      if (state.rankingLists.length && !state.rankingLists.some((item) => item.key === state.selectedRankingKey)) {
        state.selectedRankingKey = state.rankingLists.find((item) => item.key === "y2025")?.key || state.rankingLists[0].key || "";
      }
      await loadRankingWorks();
    } catch (error) {
      hidePersonProfile();
      renderEmpty(error.message || "排行榜读取失败");
    }
  }

  async function loadRankingWorks() {
    const key = state.selectedRankingKey || "";
    const params = new URLSearchParams({
      key,
      limit: "1000"
    });
    const data = await api(`/api/rankings/top?${params}`);
    state.works = data.works || [];
    state.rankingTotal = data.rankingTotal || data.total || state.works.length;
    state.rankingMissingTotal = data.missingTotal || 0;
    state.rankingLocalTotal = data.localTotal || 0;
    state.rankingUpdatedAt = data.updatedAt || "";
    state.rankingPageUrl = data.pageUrl || "";
    resetWorkPaging();
    renderPanel(data);
    renderStats(data);
    renderWorks(state.rankingLists.length ? "这个榜单没有匹配项目。" : "还没有缓存排行榜。");
  }

  function renderPanel(data = {}) {
    if (!els.personProfile) return;
    els.personProfile.hidden = false;
    els.personProfile.classList.add("ranking-profile-panel");
    els.personProfile.innerHTML = "";

    const header = document.createElement("div");
    header.className = "ranking-panel-header";
    const title = document.createElement("h3");
    title.textContent = data.label || "TOP250";
    const meta = document.createElement("div");
    meta.className = "ranking-panel-meta";
    meta.textContent = data.updatedAt ? `更新 ${formatDate(data.updatedAt) || data.updatedAt}` : "未缓存";
    header.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "ranking-panel-actions";
    if (state.rankingPageUrl) {
      const link = document.createElement("a");
      link.href = state.rankingPageUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.className = "folder-button";
      link.textContent = "打开 JavDB";
      actions.append(link);
    }
    if (state.accessMode === "local") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder-button";
      button.textContent = "刷新缓存";
      button.addEventListener("click", adminRefreshRankings);
      actions.append(button);
    }
    header.append(actions);

    const list = document.createElement("div");
    list.className = "ranking-chip-list";
    if (!state.rankingLists.length) {
      const empty = document.createElement("div");
      empty.className = "ranking-empty-note";
      empty.textContent = "后台刷新后会出现在这里";
      list.append(empty);
    } else {
      for (const item of state.rankingLists) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `ranking-chip${item.key === state.selectedRankingKey ? " active" : ""}`;
        button.textContent = `${item.label} · 缺 ${formatNumber(item.missingTotal)}`;
        button.addEventListener("click", async () => {
          state.selectedRankingKey = item.key || "";
          await loadRankingWorks();
        });
        list.append(button);
      }
    }

    els.personProfile.append(header, list);
  }

  function renderStats(data = {}) {
    const stats = [
      ["榜单", data.rankingTotal || state.rankingTotal || 0],
      ["本地已有", data.localTotal || state.rankingLocalTotal || 0],
      ["未下载", data.missingTotal || state.rankingMissingTotal || 0],
      ["当前显示", visibleWorks().length]
    ];

    els.statsRow.innerHTML = "";
    for (const [label, value] of stats) {
      const stat = document.createElement("div");
      stat.className = "stat";
      stat.innerHTML = `<strong>${formatNumber(value)}</strong><span>${label}</span>`;
      els.statsRow.append(stat);
    }
  }

  return {
    enter,
    loadRankings,
    loadRankingWorks,
    renderStats
  };
}

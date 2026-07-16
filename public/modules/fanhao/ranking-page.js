import { createLatestRequestGate } from "./latest-request.js?v=20260717-fanhao-latest-request-01";

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
  const rankingRequests = createLatestRequestGate();

  function cancelPendingRequests() {
    rankingRequests.cancel();
  }

  function enter(options = {}) {
    clearWorkFilter();
    state.sortMode = "ranking";
    if (els.sortSelect) els.sortSelect.value = "ranking";
    loadRankings();
    syncRouteAfterNavigation(options);
  }

  async function loadRankings() {
    const request = rankingRequests.begin();
    let loadSelectedRanking = false;
    els.workGrid.innerHTML = `<div class="empty-state">正在加载排行榜</div>`;
    clearPersonSelection();
    state.searchPeople = [];
    setMainHeader("排行榜", "JavDB TOP250 缓存");

    try {
      const summary = await api("/api/rankings", { signal: request.signal });
      if (!request.isCurrent() || state.activeView !== "rankings") return;
      state.rankingLists = summary.lists || [];
      if (state.rankingLists.length && !state.rankingLists.some((item) => item.key === state.selectedRankingKey)) {
        state.selectedRankingKey = state.rankingLists.find((item) => item.key === "y2025")?.key || state.rankingLists[0].key || "";
      }
      loadSelectedRanking = true;
    } catch (error) {
      if (!request.isCurrent() || state.activeView !== "rankings") return;
      hidePersonProfile();
      renderEmpty(error.message || "排行榜读取失败");
    } finally {
      request.finish();
    }
    if (loadSelectedRanking) await loadRankingWorks();
  }

  function rankingPageSize() {
    return Math.max(40, Math.min(96, Number(state.workPageSize) || 48));
  }

  async function fetchRankingPage(key, offset = 0, options = {}) {
    const params = new URLSearchParams({
      key,
      limit: String(rankingPageSize()),
      offset: String(offset || 0)
    });
    return api(`/api/rankings/top?${params}`, options.signal ? { signal: options.signal } : {});
  }

  async function loadRankingWorks(options = {}) {
    const key = state.selectedRankingKey || "";
    const append = Boolean(options.append);
    const request = rankingRequests.begin();
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载榜单作品</div>`;
    try {
      const data = await fetchRankingPage(key, append ? state.works.length : 0, { signal: request.signal });
      if (!request.isCurrent() || state.activeView !== "rankings" || key !== (state.selectedRankingKey || "")) return;
      if (append) {
        const seen = new Set(state.works.map((work) => work.id));
        state.works.push(...(data.works || []).filter((work) => !seen.has(work.id)));
        state.workVisibleLimit += rankingPageSize();
      } else {
        state.works = data.works || [];
        resetWorkPaging();
      }
      state.rankingTotal = data.rankingTotal || data.total || state.works.length;
      state.rankingMissingTotal = data.missingTotal || 0;
      state.rankingLocalTotal = data.localTotal || 0;
      state.rankingUpdatedAt = data.updatedAt || "";
      state.rankingPageUrl = data.pageUrl || "";
      renderPanel(data);
      renderStats(data);
      renderWorks(state.rankingLists.length ? "这个榜单没有匹配项目。" : "还没有缓存排行榜。");
    } catch (error) {
      if (!request.isCurrent() || state.activeView !== "rankings") return;
      if (append) throw error;
      renderEmpty(error.message || "排行榜读取失败");
    } finally {
      request.finish();
    }
  }

  async function loadMoreRankingWorks(button) {
    if (state.rankingLoadingMore || state.works.length >= state.rankingTotal) return;
    state.rankingLoadingMore = true;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    try {
      await loadRankingWorks({ append: true });
    } catch (error) {
      if (button?.isConnected) button.textContent = error.message || "加载失败";
    } finally {
      state.rankingLoadingMore = false;
      if (button?.isConnected) {
        button.disabled = false;
        if (button.textContent === "正在加载") button.textContent = originalText;
      }
    }
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

    const selector = document.createElement("div");
    selector.className = "ranking-selector";
    if (!state.rankingLists.length) {
      const empty = document.createElement("div");
      empty.className = "ranking-empty-note";
      empty.textContent = "后台刷新后会出现在这里";
      selector.append(empty);
    } else {
      selector.append(createRankingSelect(), createRankingShortcutRow());
    }

    els.personProfile.append(header, selector);
  }

  function renderStats(data = {}) {
    els.statsRow.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "ranking-toolbar";

    const summary = document.createElement("div");
    summary.className = "ranking-toolbar-summary";
    summary.textContent = [
      `${formatNumber(data.rankingTotal || state.rankingTotal || 0)} 榜单`,
      `${formatNumber(data.localTotal || state.rankingLocalTotal || 0)} 本地`,
      `${formatNumber(data.missingTotal || state.rankingMissingTotal || 0)} 未下载`,
      `${formatNumber(visibleWorks().length)} 显示`
    ].join(" · ");

    bar.append(summary, createRankingSortControl());
    els.statsRow.append(bar);
  }

  function createRankingSelect() {
    const wrap = document.createElement("label");
    wrap.className = "ranking-select-wrap";
    const label = document.createElement("span");
    label.textContent = "榜单";
    const select = document.createElement("select");
    select.className = "ranking-select";
    select.setAttribute("aria-label", "选择排行榜榜单");
    for (const item of state.rankingLists) {
      const option = new Option(rankingOptionLabel(item), item.key || "");
      select.append(option);
    }
    select.value = state.selectedRankingKey || "";
    select.addEventListener("change", async () => {
      state.selectedRankingKey = select.value;
      await loadRankingWorks();
    });
    wrap.append(label, select);
    return wrap;
  }

  function createRankingShortcutRow() {
    const row = document.createElement("div");
    row.className = "ranking-shortcut-row";
    const preferred = preferredRankingShortcuts(state.rankingLists);
    for (const item of preferred) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ranking-chip${item.key === state.selectedRankingKey ? " active" : ""}`;
      button.textContent = rankingShortLabel(item);
      button.title = rankingOptionLabel(item);
      button.addEventListener("click", async () => {
        if ((item.key || "") === (state.selectedRankingKey || "")) return;
        state.selectedRankingKey = item.key || "";
        await loadRankingWorks();
      });
      row.append(button);
    }
    return row;
  }

  function createRankingSortControl() {
    const wrap = document.createElement("label");
    wrap.className = "ranking-sort-wrap";
    const label = document.createElement("span");
    label.textContent = "排序";
    const select = document.createElement("select");
    select.className = "ranking-sort-select";
    select.setAttribute("aria-label", "排行榜排序");
    for (const [value, text] of [
      ["ranking", "榜单顺序"],
      ["releaseDesc", "发行最新"],
      ["ratingDesc", "评分最高"],
      ["title", "标题"]
    ]) {
      select.append(new Option(text, value));
    }
    select.value = ["ranking", "releaseDesc", "ratingDesc", "title"].includes(state.sortMode) ? state.sortMode : "ranking";
    select.addEventListener("change", () => {
      state.sortMode = select.value;
      resetWorkPaging();
      renderStats();
      renderWorks();
    });
    wrap.append(label, select);
    return wrap;
  }

  function preferredRankingShortcuts(items) {
    const years = items.filter((item) => /^y\d{4}$/.test(item.key || "")).sort((a, b) => String(b.key).localeCompare(String(a.key)));
    const nonYears = items.filter((item) => !/^y\d{4}$/.test(item.key || ""));
    return [...years, ...nonYears];
  }

  function rankingOptionLabel(item) {
    return `${item.label} · 本地 ${formatNumber(item.localTotal)} · 缺 ${formatNumber(item.missingTotal)}`;
  }

  function rankingShortLabel(item) {
    const year = /^y(\d{4})$/.exec(item.key || "")?.[1];
    const label = year || item.label.replace(/^TOP250\s*/i, "") || "全部";
    return `${label} · 缺 ${formatNumber(item.missingTotal)}`;
  }

  return {
    cancelPendingRequests,
    enter,
    loadMoreRankingWorks,
    loadRankings,
    loadRankingWorks,
    renderStats
  };
}

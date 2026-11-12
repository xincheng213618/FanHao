import { createLatestRequestGate } from "./latest-request.js?v=20260717-fanhao-latest-request-01";
import { resolveWorkPage } from "./features/works/work-page-state.js";

const RANKING_DESKTOP_PAGE_SIZE = 64;
const RANKING_MOBILE_PAGE_SIZE = 48;
const RANKING_YEAR_SHORTCUTS = 5;
const RANKING_SCOPES = [["all", "全部"], ["local", "本地"], ["missing", "未下载"]];

const RANKING_SORT_OPTIONS = [
  ["ranking", "榜单顺序"],
  ["releaseDesc", "发行最新"],
  ["ratingDesc", "评分最高"],
  ["ratingCountDesc", "评价人数最多"],
  ["popularityDesc", "热度最高"],
  ["title", "标题"]
];

export function createRankingPage(deps) {
  const {
    adminRefreshRankings,
    api,
    appendLoadedWorkPage,
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
  let pendingRead = null;
  let entryRead = null;
  let appendOwner = null;
  let loadedKey = null;
  let loadedScope = null;
  let selectedScope = "all";
  let pageableTotal = 0;
  let panel = null;

  function cancelPendingRequests() {
    rankingRequests.cancel();
    pendingRead = null;
    entryRead = null;
    panel = null;
    resetRankingPaging();
  }

  function resetRankingPaging() {
    appendOwner = null;
    loadedKey = null;
    loadedScope = null;
    pageableTotal = 0;
    state.rankingScopeTotal = null;
    state.rankingLoadingMore = false;
    state.rankingRawLoaded = null;
    state.rankingHasMore = null;
  }

  function beginRead(append = false, existing = null) {
    if (!append) {
      resetRankingPaging();
      state.rankingHasMore = false;
    }
    const request = existing || rankingRequests.begin();
    pendingRead = request;
    return request;
  }

  function finishRead(request) {
    if (pendingRead === request) pendingRead = null;
    request.finish();
  }

  function isCurrentRead(request, key, scope) {
    return request.isCurrent() && state.activeView === "rankings" && key === (state.selectedRankingKey || "") && scope === selectedScope;
  }

  function enter(options = {}) {
    clearWorkFilter();
    state.sortMode = "ranking";
    if (els.sortSelect) els.sortSelect.value = "ranking";
    loadRankings();
    syncRouteAfterNavigation(options);
  }

  function prefetchEntry() {
    const request = rankingRequests.begin();
    const key = state.selectedRankingKey || "y2025", limit = rankingPageSize();
    const scope = selectedScope;
    const summary = api("/api/rankings", { signal: request.signal });
    const page = fetchRankingPage(key, 0, { signal: request.signal, scope });
    summary.catch(() => {});
    page.catch(() => {});
    const entry = { request, key, scope, limit, summary, page };
    entryRead = entry;
    return () => {
      if (entryRead !== entry) return;
      entryRead = null;
      if (request.isCurrent()) rankingRequests.cancel();
    };
  }

  async function loadRankings() {
    if (state.activeView !== "rankings") return;
    let key = state.selectedRankingKey || "";
    const scope = selectedScope;
    const anticipatedKey = key || "y2025", limit = rankingPageSize();
    const prefetched = entryRead?.request.isCurrent() && entryRead.key === anticipatedKey && entryRead.scope === scope && entryRead.limit >= limit
      ? entryRead : null;
    entryRead = null;
    const request = beginRead(false, prefetched?.request);
    hidePersonProfile();
    els.statsRow.replaceChildren();
    els.workGrid.innerHTML = `<div class="empty-state">正在加载排行榜</div>`;
    clearPersonSelection();
    state.searchPeople = [];
    setMainHeader("排行榜", "JavDB TOP250 缓存");

    try {
      const [summary, anticipatedData] = await Promise.all([
        prefetched?.summary || api("/api/rankings", { signal: request.signal }),
        prefetched?.page || fetchRankingPage(anticipatedKey, 0, { signal: request.signal, scope })
      ]);
      if (!isCurrentRead(request, key, scope)) return;
      state.rankingLists = summary.lists || [];
      if (state.rankingLists.length && !state.rankingLists.some((item) => item.key === state.selectedRankingKey)) {
        state.selectedRankingKey = state.rankingLists.find((item) => item.key === "y2025")?.key || state.rankingLists[0].key || "";
      }
      key = state.selectedRankingKey || "";
      const data = key === anticipatedKey
        ? anticipatedData
        : await fetchRankingPage(key, 0, { signal: request.signal, scope });
      if (!isCurrentRead(request, key, scope)) return;
      // Library metadata can lower the initial page size after a cold read starts.
      applyRankingPage(prefetched && key === anticipatedKey ? trimRankingEntry(data, limit) : data);
    } catch (error) {
      if (!isCurrentRead(request, key, scope)) return;
      hidePersonProfile();
      renderEmpty(error.message || "排行榜读取失败");
    } finally {
      finishRead(request);
    }
  }

  function trimRankingEntry(data, limit) {
    if (!Array.isArray(data?.works) || data.works.length <= limit) return data;
    return { ...data, works: data.works.slice(0, limit), count: limit, limit };
  }

  function rankingPageSize() {
    const viewportPageSize = globalThis.matchMedia?.("(max-width: 720px)")?.matches
      ? RANKING_MOBILE_PAGE_SIZE
      : RANKING_DESKTOP_PAGE_SIZE;
    return Math.max(40, Math.min(viewportPageSize, Number(state.workPageSize) || viewportPageSize));
  }

  async function fetchRankingPage(key, offset = 0, { signal, scope = selectedScope } = {}) {
    const params = new URLSearchParams({
      key,
      limit: String(rankingPageSize()),
      offset: String(offset || 0)
    });
    if (scope !== "all") params.set("scope", scope);
    if (scope === "missing") params.set("missing", "1");
    const data = await api(`/api/rankings/top?${params}`, signal ? { signal } : {});
    if (scope === "local" && data.scope !== "local") throw new Error("当前服务未返回本地筛选结果。");
    return data;
  }

  async function loadRankingWorks(options = {}) {
    if (state.activeView !== "rankings") return;
    const key = state.selectedRankingKey || "";
    const scope = selectedScope;
    const append = Boolean(options.append);
    const offset = append ? (Number.isSafeInteger(state.rankingRawLoaded) ? state.rankingRawLoaded : state.works.length) : 0;
    const request = beginRead(append);
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载榜单作品</div>`;
    try {
      const data = await fetchRankingPage(key, offset, { signal: request.signal, scope });
      if (!isCurrentRead(request, key, scope)) return;
      applyRankingPage(data, { append, offset });
    } catch (error) {
      if (!isCurrentRead(request, key, scope)) return;
      if (append) throw error;
      renderEmpty(error.message || "排行榜读取失败");
    } finally {
      finishRead(request);
    }
  }

  function applyRankingPage(data, options = {}) {
    const page = resolveWorkPage(data, {
      existingWorks: options.append ? state.works : [], offset: options.offset || 0,
      previousTotal: options.append ? pageableTotal : 0
    });
    if (options.append) {
      state.works.push(...page.works);
      state.workVisibleLimit += rankingPageSize();
    } else {
      state.works = page.works;
      resetWorkPaging();
    }
    state.rankingRawLoaded = page.rawLoaded;
    state.rankingHasMore = page.hasMore;
    pageableTotal = page.total;
    state.rankingScopeTotal = page.total;
    loadedKey = state.selectedRankingKey || "";
    loadedScope = selectedScope;
    state.rankingTotal = data.rankingTotal ?? page.total;
    state.rankingMissingTotal = data.missingTotal ?? 0;
    state.rankingLocalTotal = data.localTotal ?? 0;
    state.rankingUpdatedAt = data.updatedAt || "";
    state.rankingPageUrl = data.pageUrl || "";
    renderPanel(data);
    renderStats(data);
    if (options.append) appendLoadedWorkPage();
    else renderWorks(!state.rankingLists.length ? "还没有缓存排行榜。" : selectedScope === "local" ? "这个榜单暂无本地作品。"
      : selectedScope === "missing" ? "这个榜单暂无未下载作品。" : "这个榜单没有匹配项目。");
  }

  async function loadMoreRankingWorks(button) {
    if (state.activeView !== "rankings" || pendingRead || state.rankingLoadingMore
      || !(state.rankingHasMore ?? state.works.length < (loadedKey === null ? state.rankingTotal : pageableTotal))
      || (loadedKey !== null && (loadedKey !== (state.selectedRankingKey || "") || loadedScope !== selectedScope))) return;
    const owner = {};
    appendOwner = owner;
    const key = state.selectedRankingKey || "";
    const scope = selectedScope;
    const ownsButton = () => appendOwner === owner && state.activeView === "rankings" && key === (state.selectedRankingKey || "") && scope === selectedScope;
    state.rankingLoadingMore = true;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    try {
      await loadRankingWorks({ append: true });
    } catch (error) {
      if (ownsButton() && button?.isConnected) button.textContent = error.message || "加载失败";
    } finally {
      if (appendOwner !== owner) return;
      const updateButton = ownsButton();
      appendOwner = null;
      state.rankingLoadingMore = false;
      if (updateButton && button?.isConnected) {
        button.disabled = false;
        if (button.textContent === "正在加载") button.textContent = originalText;
      }
    }
  }

  function renderPanel(data = {}) {
    if (!els.personProfile) return;
    els.personProfile.hidden = false;
    els.personProfile.classList.add("ranking-profile-panel");
    if (panel?.header.parentNode !== els.personProfile || panel.lists !== state.rankingLists) {
      panel = buildRankingPanel();
    }
    renderRankingSelection();
    panel.title.textContent = data.label || "TOP250";
    panel.meta.textContent = data.updatedAt ? `更新于 ${formatDate(data.updatedAt) || data.updatedAt}` : "未缓存";
    panel.sourceLink.hidden = !state.rankingPageUrl;
    panel.refreshButton.hidden = state.accessMode !== "local";
    if (state.rankingPageUrl) panel.sourceLink.href = state.rankingPageUrl;
    else panel.sourceLink.removeAttribute("href");
  }

  function buildRankingPanel() {
    const header = document.createElement("div");
    header.className = "ranking-panel-header";
    const heading = document.createElement("div");
    heading.className = "ranking-panel-heading";
    const title = document.createElement("h3");
    const meta = document.createElement("div");
    meta.className = "ranking-panel-meta";
    heading.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "ranking-panel-actions";
    const sourceLink = document.createElement("a");
    sourceLink.target = "_blank";
    sourceLink.rel = "noreferrer";
    sourceLink.className = "folder-button";
    sourceLink.textContent = "打开 JavDB";
    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "folder-button";
    refreshButton.textContent = "刷新缓存";
    refreshButton.addEventListener("click", adminRefreshRankings);
    actions.append(sourceLink, refreshButton);
    header.append(heading, actions);

    const selector = document.createElement("div");
    selector.className = "ranking-selector";
    let select = null;
    let shortcuts = null;
    if (!state.rankingLists.length) {
      const empty = document.createElement("div");
      empty.className = "ranking-empty-note";
      empty.textContent = "缓存刷新后可切换榜单。";
      selector.append(empty);
    } else {
      const field = createRankingSelect();
      select = field.querySelector("select");
      shortcuts = createRankingShortcutRow();
      selector.append(field, shortcuts);
    }

    const bar = document.createElement("div");
    bar.className = "ranking-toolbar";
    const scopes = document.createElement("div");
    scopes.className = "ranking-scope-controls";
    scopes.setAttribute("role", "group");
    scopes.setAttribute("aria-label", "榜单馆藏范围");
    const scopeCounts = new Map();
    for (const [scope, label] of RANKING_SCOPES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ranking-chip ranking-scope-chip";
      button.dataset.scope = scope;
      button.disabled = !state.rankingLists.length;
      const number = document.createElement("strong");
      button.append(label, " ", number);
      button.addEventListener("click", () => selectRankingScope(scope));
      scopeCounts.set(scope, number);
      scopes.append(button);
    }
    const summary = document.createElement("div");
    summary.className = "ranking-toolbar-summary";
    summary.setAttribute("role", "status");
    const sortField = createRankingSortControl();
    bar.append(scopes, summary, sortField);
    els.personProfile.replaceChildren(header, selector, bar);
    return { lists: state.rankingLists, header, title, meta, sourceLink, refreshButton, select, shortcuts, scopes, scopeCounts, summary, sort: sortField.querySelector("select") };
  }

  function renderStats(data = {}) {
    if (!panel || panel.header.parentNode !== els.personProfile) return;
    panel.scopeCounts.get("all").textContent = formatNumber(data.rankingTotal ?? state.rankingTotal ?? 0);
    panel.scopeCounts.get("local").textContent = formatNumber(data.localTotal ?? state.rankingLocalTotal ?? 0);
    panel.scopeCounts.get("missing").textContent = formatNumber(data.missingTotal ?? state.rankingMissingTotal ?? 0);
    panel.summary.textContent = `显示 ${formatNumber(visibleWorks().length)} 部`;
    panel.sort.value = RANKING_SORT_OPTIONS.some(([value]) => value === state.sortMode) ? state.sortMode : "ranking";
  }

  function selectRanking(key) {
    if (key === (state.selectedRankingKey || "")) return;
    state.selectedRankingKey = key;
    renderRankingSelection();
    loadRankingWorks();
  }

  function selectRankingScope(scope) {
    if (scope === selectedScope && (pendingRead || loadedScope === scope)) return;
    selectedScope = scope;
    renderRankingSelection();
    void loadRankingWorks();
  }

  function renderRankingSelection() {
    if (!panel) return;
    if (panel.select) {
      const key = state.selectedRankingKey || "";
      panel.select.value = key;
      for (const button of panel.shortcuts.children) button.setAttribute("aria-pressed", String(button.dataset.key === key));
    }
    for (const button of panel.scopes.children) {
      button.setAttribute("aria-pressed", String(button.dataset.scope === selectedScope));
    }
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
    select.addEventListener("change", () => selectRanking(select.value));
    wrap.append(label, select);
    return wrap;
  }

  function createRankingShortcutRow() {
    const row = document.createElement("div");
    row.className = "ranking-shortcut-row";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "近期年份");
    const years = state.rankingLists.filter((item) => /^y\d{4}$/.test(item.key || ""))
      .sort((a, b) => b.key.localeCompare(a.key)).slice(0, RANKING_YEAR_SHORTCUTS);
    for (const item of years) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ranking-chip";
      button.dataset.key = item.key;
      button.textContent = item.key.slice(1);
      button.title = rankingOptionLabel(item);
      button.addEventListener("click", () => selectRanking(item.key));
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
    for (const [value, text] of RANKING_SORT_OPTIONS) {
      select.append(new Option(text, value));
    }
    select.addEventListener("change", () => {
      state.sortMode = select.value;
      if (loadedKey === null) return;
      resetWorkPaging();
      renderStats();
      renderWorks();
    });
    wrap.append(label, select);
    return wrap;
  }

  function rankingOptionLabel(item) {
    return `${item.label} · 本地 ${formatNumber(item.localTotal)} · 缺 ${formatNumber(item.missingTotal)}`;
  }

  return {
    cancelPendingRequests,
    enter,
    prefetchEntry,
    loadMoreRankingWorks,
    loadRankings,
    loadRankingWorks,
    renderStats
  };
}

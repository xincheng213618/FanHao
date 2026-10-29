import { createLatestRequestGate } from "./latest-request.js?v=20260717-fanhao-latest-request-01";
import { resolveWorkPage } from "./features/works/work-page-state.js";

const PREFIX_INDEX_DESKTOP_PAGE_SIZE = 96;
const PREFIX_INDEX_MOBILE_PAGE_SIZE = 64;

export function createCodePrefixPage(deps) {
  const {
    api,
    appendEmpty,
    appendLoadedWorkPage,
    appendWorkControls,
    clearWorkFilter,
    clearWorkSearch,
    els,
    formatNumber,
    hidePersonProfile,
    isNavigationCurrent,
    onNavigationStarted,
    onWorkRead = () => null,
    renderWorks,
    resetWorkPaging,
    setMainHeader,
    state,
    syncNavigationState,
    syncRouteAfterNavigation
  } = deps;

  const detailRequests = createLatestRequestGate();
  const indexRequests = createLatestRequestGate();
  let indexLoadObserver = null;
  let indexLoadPending = false;
  let indexLoadTimer = null;
  let indexQuery = "";
  let renderedPrefixes = [];
  let detailPageOwner = null;

  state.codePrefixSortMode = readPrefixSortMode();

  async function enter(options = {}) {
    return showIndex(options);
  }

  async function applyRoute(route, options = {}) {
    if (!options.preserveSearchDraft) clearWorkSearch();
    return route?.codePrefix
      ? selectPrefix(route.codePrefix, {
          ...options,
          family: route.codePrefixFamily,
          resetFilter: false,
          skipRoute: true
        })
      : showIndex({ ...options, skipRoute: true });
  }

  function invalidateIndex() {
    indexRequests.cancel();
    state.codePrefixes = [];
    state.codePrefixIndexLocalCount = 0;
    state.codePrefixMappedCount = 0;
    state.codePrefixVisibleLimit = PREFIX_INDEX_DESKTOP_PAGE_SIZE;
  }

  function navigationButtonActive(button, activeView) {
    if (button?.dataset?.view !== "codes" || activeView !== "codes") return null;
    const shortcutPrefix = String(button.dataset.codePrefix || "").toUpperCase();
    return shortcutPrefix
      ? Boolean(state.selectedCodePrefixFamily) && shortcutPrefix === String(state.selectedCodePrefix || "").toUpperCase()
      : !state.selectedCodePrefixFamily;
  }

  function handleNavigationButton(button) {
    if (button?.dataset?.view !== "codes" || !button.dataset.codePrefix) return false;
    selectPrefix(button.dataset.codePrefix, { family: button.dataset.codeFamily === "true" });
    return true;
  }

  function reloadForActiveView() {
    if (state.activeView !== "codes" || !state.selectedCodePrefix) return false;
    reloadSelected();
    return true;
  }

  async function showIndex(options = {}) {
    const navigationIntent = onNavigationStarted?.(options);
    const request = indexRequests.begin();
    detailRequests.cancel();
    detailPageOwner = null;
    disconnectIndexAutoload();
    state.activeView = "codes";
    state.selectedCodePrefix = "";
    state.selectedCodePrefixFamily = false;
    state.selectedCodePrefixMeta = null;
    state.codePrefixTotal = 0;
    state.codePrefixRawLoaded = null;
    state.codePrefixHasMore = null;
    state.codePrefixFacets = null;
    state.codePrefixTraitFacets = null;
    state.codePrefixLoadingMore = false;
    state.searchPeople = [];
    state.works = [];
    syncNavigationState("codes");
    hidePersonProfile();
    setMainHeader("番号索引", "按番号前缀浏览本地资料库");
    renderIndexStats();
    renderIndex();
    const isCurrent = () => request.isCurrent() && state.activeView === "codes" && !state.selectedCodePrefix
      && (!isNavigationCurrent || isNavigationCurrent(navigationIntent));
    try {
      await loadIndex(request, isCurrent, options);
      if (!isCurrent()) return;
      syncRouteAfterNavigation({
        ...options,
        routeOverrides: {
          view: "codes",
          codePrefix: "",
          codePrefixFamily: false,
          personId: "",
          q: "",
          workId: "",
          videoId: ""
        }
      });
    } finally {
      request.finish();
    }
  }

  async function loadIndex(request, isCurrent, options = {}) {
    if (state.codePrefixes.length && !options.force) {
      renderIndexStats();
      renderIndex();
      return;
    }
    els.workGrid.innerHTML = `<div class="empty-state">正在整理番号与厂商对应关系</div>`;
    try {
      const data = await api("/api/code-prefixes?sort=count", { signal: request.signal });
      if (!isCurrent()) return;
      state.codePrefixes = data.prefixes || [];
      state.codePrefixIndexLocalCount = data.localWorkCount || 0;
      state.codePrefixMappedCount = data.mappedCount || 0;
      state.codePrefixVisibleLimit = prefixIndexPageSize();
      renderIndexStats();
      renderIndex();
    } catch (error) {
      if (!isCurrent()) return;
      els.workGrid.innerHTML = "";
      appendEmpty(error.message || "番号索引读取失败");
    }
  }

  function renderIndexStats() {
    if (state.activeView !== "codes" || state.selectedCodePrefix) return;
    const prefixes = state.codePrefixes || [];
    const localCount = state.codePrefixIndexLocalCount
      || prefixes.reduce((sum, item) => sum + Number(item.localCount || 0), 0);
    const mappedCount = state.codePrefixMappedCount
      || prefixes.filter((item) => Boolean(item.maker)).length;
    const fc2Count = prefixes
      .filter((item) => item.prefix === "FC2" || item.prefix.startsWith("FC2-"))
      .reduce((sum, item) => sum + Number(item.localCount || 0), 0);

    const existingControls = els.statsRow.querySelector(".code-prefix-index-controls");
    if (existingControls) {
      for (const child of [...els.statsRow.children]) if (child !== existingControls) child.remove();
    } else els.statsRow.innerHTML = "";
    for (const [label, value] of [
      ["番号前缀", prefixes.length],
      ["已识别作品", localCount],
      ["已有厂商对应", mappedCount],
      ["FC2", fc2Count]
    ]) {
      const stat = createStat(label, value);
      if (existingControls) els.statsRow.insertBefore(stat, existingControls);
      else els.statsRow.append(stat);
    }
    if (existingControls) return;

    const controls = document.createElement("div");
    controls.className = "stat-quick-filters code-prefix-index-controls";
    const searchLabel = document.createElement("label");
    searchLabel.className = "code-prefix-index-search";
    const caption = document.createElement("span");
    caption.textContent = "搜索索引";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "前缀或厂商名称";
    search.setAttribute("aria-label", "搜索番号前缀或厂商");
    search.value = indexQuery;
    search.addEventListener("input", () => {
      if (!search.isConnected || state.activeView !== "codes" || state.selectedCodePrefix) return;
      indexQuery = search.value;
      state.codePrefixVisibleLimit = prefixIndexPageSize();
      renderIndex();
    });
    searchLabel.append(caption, search);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "text-button code-prefix-index-clear";
    clear.textContent = "清空";
    clear.setAttribute("aria-label", "清空索引搜索");
    clear.addEventListener("click", () => {
      if (!clear.isConnected || state.activeView !== "codes" || state.selectedCodePrefix) return;
      search.value = indexQuery = "";
      state.codePrefixVisibleLimit = prefixIndexPageSize();
      renderIndex();
      search.focus({ preventScroll: true });
    });
    const group = document.createElement("div");
    group.className = "stat-filter-group stat-sort-group";
    const label = document.createElement("label");
    label.className = "stat-filter-label";
    label.htmlFor = "codePrefixSortSelect";
    label.textContent = "排序";
    const select = document.createElement("select");
    select.id = "codePrefixSortSelect";
    select.className = "stat-sort-select";
    select.setAttribute("aria-label", "番号索引排序");
    select.append(
      new Option("按数量排序", "count"),
      new Option("按顺序排序", "name")
    );
    select.value = state.codePrefixSortMode || "count";
    select.addEventListener("change", () => {
      if (!select.isConnected || state.activeView !== "codes" || state.selectedCodePrefix) return;
      state.codePrefixSortMode = select.value === "name" ? "name" : "count";
      writePrefixSortMode(state.codePrefixSortMode);
      state.codePrefixVisibleLimit = prefixIndexPageSize();
      renderIndex();
    });
    group.append(label, select);
    const summary = document.createElement("span");
    summary.className = "code-prefix-index-summary";
    summary.setAttribute("role", "status");
    controls.append(searchLabel, clear, group, summary);
    els.statsRow.append(controls);
  }

  function renderIndex() {
    if (state.activeView !== "codes" || state.selectedCodePrefix) return;
    disconnectIndexAutoload();
    const prefixes = sortedPrefixes();
    renderedPrefixes = prefixes;
    const summary = els.statsRow.querySelector(".code-prefix-index-summary");
    if (summary) summary.textContent = `${formatNumber(prefixes.length)} / ${formatNumber(state.codePrefixes.length)} 个番号前缀`;
    const clear = els.statsRow.querySelector(".code-prefix-index-clear");
    if (clear) clear.hidden = !indexQuery;
    els.workGrid.innerHTML = "";
    if (!prefixes.length) {
      appendEmpty(indexQuery.trim() ? "没有匹配的番号前缀或厂商，试试其他名称。" : "本地资料库里还没有可识别的番号。");
      return;
    }

    const visible = prefixes.slice(0, state.codePrefixVisibleLimit);
    const wrap = document.createElement("div");
    wrap.className = "code-prefix-table-wrap";
    const table = document.createElement("table");
    table.className = "code-prefix-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th scope="col">番号</th>
          <th scope="col">厂商 / 平台</th>
          <th scope="col" class="number-column">本地数量</th>
        </tr>
      </thead>
    `;
    const body = document.createElement("tbody");
    for (const item of visible) body.append(createPrefixRow(item));
    table.append(body);
    wrap.append(table);
    els.workGrid.append(wrap);

    if (visible.length < prefixes.length) {
      appendIndexLoadMore(visible.length, prefixes.length);
    }
  }

  function createPrefixRow(item) {
    const row = document.createElement("tr");
    row.className = "code-prefix-row";
    row.title = `查看 ${item.prefix} 番号作品`;
    row.addEventListener("click", () => {
      if (row.isConnected === false || state.activeView !== "codes" || state.selectedCodePrefix) return;
      clearWorkSearch();
      selectPrefix(item.prefix);
    });
    const prefixCell = document.createElement("th");
    prefixCell.scope = "row";
    const prefixButton = document.createElement("button");
    prefixButton.type = "button";
    prefixButton.className = "code-prefix-link";
    prefixButton.textContent = item.prefix;
    prefixCell.append(prefixButton);

    const makerCell = document.createElement("td");
    makerCell.className = "code-prefix-maker";
    if (item.maker) {
      const name = document.createElement("strong");
      name.textContent = item.maker.name;
      const detail = document.createElement("span");
      const alternatives = Math.max(0, (item.makers?.length || 0) - 1);
      detail.textContent = item.maker.kind === "platform"
        ? "平台（非单一厂商）"
        : alternatives
          ? `主要对应 · 另有 ${formatNumber(alternatives)} 个厂商记录`
          : "主要对应";
      makerCell.append(name, detail);
    } else {
      makerCell.classList.add("unmapped");
      makerCell.textContent = "待识别";
    }

    const countCell = document.createElement("td");
    countCell.className = "number-column code-prefix-count";
    countCell.textContent = formatNumber(item.localCount || 0);
    row.append(prefixCell, makerCell, countCell);
    return row;
  }

  function sortedPrefixes() {
    const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    const query = indexQuery.trim().toLocaleLowerCase();
    return (state.codePrefixes || []).filter(item => !query || [item.prefix, item.maker?.name, ...(item.makers || []).map(maker => maker.name)]
      .some(value => String(value || "").toLocaleLowerCase().includes(query))).sort((a, b) =>
      state.codePrefixSortMode === "name"
        ? collator.compare(a.prefix, b.prefix) || Number(b.localCount || 0) - Number(a.localCount || 0)
        : Number(b.localCount || 0) - Number(a.localCount || 0) || collator.compare(a.prefix, b.prefix));
  }

  function appendIndexLoadMore(visibleCount, totalCount) {
    const row = document.createElement("div");
    row.className = "load-more-row code-prefix-index-load-more";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = `向下滑动继续加载 ${formatNumber(visibleCount)} / ${formatNumber(totalCount)}`;
    button.addEventListener("click", loadMoreIndex);
    row.append(button);
    els.workGrid.append(row);
    observeIndexLoadMore(row);
  }

  function loadMoreIndex() {
    if (state.activeView !== "codes" || state.selectedCodePrefix) return;
    const prefixes = renderedPrefixes;
    const start = Math.min(state.codePrefixVisibleLimit, prefixes.length);
    if (start >= prefixes.length) return;
    const end = Math.min(prefixes.length, start + prefixIndexPageSize());
    const body = els.workGrid.querySelector(".code-prefix-table tbody");
    if (!body) {
      state.codePrefixVisibleLimit = end;
      renderIndex();
      return;
    }

    disconnectIndexAutoload();
    els.workGrid.querySelector(".code-prefix-index-load-more")?.remove();
    const fragment = document.createDocumentFragment();
    for (const item of prefixes.slice(start, end)) fragment.append(createPrefixRow(item));
    body.append(fragment);
    state.codePrefixVisibleLimit = end;
    if (end < prefixes.length) appendIndexLoadMore(end, prefixes.length);
  }

  function observeIndexLoadMore(target) {
    if (!("IntersectionObserver" in window)) return;
    indexLoadObserver = new IntersectionObserver((entries) => {
      if (!target.isConnected || indexLoadPending || !entries.some((entry) => entry.isIntersecting)) return;
      indexLoadPending = true;
      indexLoadObserver?.disconnect();
      indexLoadTimer = window.setTimeout(() => {
        indexLoadTimer = null;
        indexLoadPending = false;
        if (!target.isConnected) return;
        loadMoreIndex();
      }, 80);
    }, { root: null, rootMargin: "720px 0px", threshold: 0 });
    indexLoadObserver.observe(target);
  }

  function disconnectIndexAutoload() {
    indexLoadObserver?.disconnect();
    indexLoadObserver = null;
    if (indexLoadTimer !== null) window.clearTimeout(indexLoadTimer);
    indexLoadTimer = null;
    indexLoadPending = false;
  }

  async function selectPrefix(prefix, options = {}) {
    const navigationIntent = onNavigationStarted?.(options);
    const normalizedPrefix = String(prefix || "").trim().toUpperCase();
    if (!normalizedPrefix) return showIndex(options);
    indexRequests.cancel();
    const request = detailRequests.begin();
    detailPageOwner = null;
    disconnectIndexAutoload();
    state.activeView = "codes";
    state.selectedCodePrefix = normalizedPrefix;
    state.selectedCodePrefixFamily = Boolean(options.family);
    state.selectedCodePrefixMeta = {
      prefix: normalizedPrefix,
      family: Boolean(options.family)
    };
    state.searchPeople = [];
    state.works = [];
    state.codePrefixTotal = 0;
    state.codePrefixRawLoaded = null;
    state.codePrefixHasMore = null;
    state.codePrefixFacets = null;
    state.codePrefixTraitFacets = null;
    state.codePrefixLoadingMore = false;
    if (options.resetFilter !== false) clearWorkFilter();
    const query = detailPath(normalizedPrefix, 0, state.selectedCodePrefixFamily);
    const isCurrent = () => detailIsCurrent(request, query)
      && (!isNavigationCurrent || isNavigationCurrent(navigationIntent));
    syncNavigationState("codes");
    hidePersonProfile();
    setMainHeader(normalizedPrefix, options.family ? "正在查询全部系列" : "正在读取番号作品");
    els.statsRow.innerHTML = "";
    els.workGrid.innerHTML = `<div class="empty-state">正在加载作品</div>`;

    const finishWorkRead = onWorkRead(query, isCurrent);
    try {
      const data = await api(query, { signal: request.signal });
      if (!isCurrent()) return;
      applyDetailPayload(data, false);
      resetWorkPaging();
      renderPrefixHeader();
      renderDetailStats();
      renderWorks("这个番号暂无作品。");
      syncRouteAfterNavigation({
        ...options,
        routeOverrides: {
          view: "codes",
          codePrefix: normalizedPrefix,
          codePrefixFamily: Boolean(options.family),
          personId: "",
          q: "",
          workId: "",
          videoId: ""
        }
      });
    } catch (error) {
      if (!isCurrent()) return;
      els.statsRow.innerHTML = "";
      els.workGrid.innerHTML = "";
      appendEmpty(error.message || "番号作品读取失败");
    } finally {
      finishWorkRead?.();
      request.finish();
    }
  }

  async function reloadSelected(options = {}) {
    if (!state.selectedCodePrefix) return;
    return selectPrefix(state.selectedCodePrefix, {
      ...options,
      family: state.selectedCodePrefixFamily,
      resetFilter: false,
      skipRoute: true
    });
  }

  async function loadMore(button) {
    if (state.codePrefixLoadingMore || state.activeView !== "codes" || !state.selectedCodePrefix) return;
    if (!(state.codePrefixHasMore ?? state.works.length < state.codePrefixTotal)) return;
    const request = detailRequests.begin();
    detailPageOwner = request;
    const prefix = state.selectedCodePrefix;
    const family = state.selectedCodePrefixFamily;
    const query = detailPath(prefix, 0, family);
    const offset = Number.isSafeInteger(state.codePrefixRawLoaded) ? state.codePrefixRawLoaded : state.works.length;
    const path = detailPath(prefix, offset, family);
    state.codePrefixLoadingMore = true;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    const finishWorkRead = onWorkRead(path, () => detailIsCurrent(request, query) && detailPageOwner === request);
    try {
      const data = await api(path, { signal: request.signal });
      if (!detailIsCurrent(request, query) || detailPageOwner !== request) return;
      applyDetailPayload(data, true, offset);
      state.workVisibleLimit = Math.max(state.workVisibleLimit, state.works.length);
      renderPrefixHeader();
      renderDetailStats();
      appendLoadedWorkPage();
    } catch (error) {
      if (detailIsCurrent(request, query) && detailPageOwner === request) throw error;
    } finally {
      finishWorkRead?.();
      if (detailPageOwner === request) {
        detailPageOwner = null;
        state.codePrefixLoadingMore = false;
        if (detailIsCurrent(request, query) && button?.isConnected) {
          button.disabled = false;
          button.textContent = originalText || button.textContent;
        }
      }
      request.finish();
    }
  }

  function detailIsCurrent(request, query) {
    return request.isCurrent() && state.activeView === "codes"
      && query === detailPath(state.selectedCodePrefix, 0, state.selectedCodePrefixFamily);
  }

  function detailPath(prefix, offset, family) {
    const params = new URLSearchParams({
      limit: String(detailPageSize()),
      offset: String(offset || 0),
      sort: state.sortMode || "releaseDesc",
      filter: state.filterMode || "all",
      includeMissingLocal: state.showMissingLocalWorks ? "1" : "0",
      includeCompilation: state.showCompilationWorks ? "1" : "0"
    });
    if (family) params.set("family", "1");
    return `/api/code-prefixes/${encodeURIComponent(prefix)}?${params}`;
  }

  function cancelPendingRequests() {
    indexRequests.cancel();
    detailRequests.cancel();
    detailPageOwner = null;
    state.codePrefixLoadingMore = false;
    disconnectIndexAutoload();
  }

  function applyDetailPayload(data, append, offset = 0) {
    const page = resolveWorkPage(data, { existingWorks: append ? state.works : [], offset, previousTotal: append ? state.codePrefixTotal : 0 });
    if (append) {
      state.works.push(...page.works);
    } else {
      state.works = page.works;
    }
    state.codePrefixRawLoaded = page.rawLoaded;
    state.codePrefixHasMore = page.hasMore;
    state.selectedCodePrefixMeta = data.codePrefix || state.selectedCodePrefixMeta;
    state.codePrefixTotal = page.total;
    state.codePrefixFacets = data.facets || state.codePrefixFacets || null;
    state.codePrefixTraitFacets = data.traitFacets || (append ? state.codePrefixTraitFacets : null) || null;
  }

  function renderPrefixHeader() {
    const meta = state.selectedCodePrefixMeta || {};
    const maker = meta.maker?.name
      ? `${meta.maker.name}${meta.maker.kind === "platform" ? "（平台）" : ""}`
      : "厂商待识别";
    const missing = Number(meta.missingCount || 0);
    setMainHeader(
      meta.prefix || state.selectedCodePrefix || "番号",
      `${maker} · ${formatNumber(meta.localCount || 0)} 部本地${missing ? ` · ${formatNumber(missing)} 部未下载` : ""}`
    );
  }

  function createStat(label, value) {
    const stat = document.createElement("div");
    stat.className = "stat";
    const number = document.createElement("strong");
    number.textContent = formatNumber(value || 0);
    const caption = document.createElement("span");
    caption.textContent = label;
    stat.append(number, caption);
    return stat;
  }

  function renderDetailStats() {
    const meta = state.selectedCodePrefixMeta || {};
    const facets = state.codePrefixFacets || {};
    els.statsRow.innerHTML = "";
    for (const [label, value] of [
      ["本地作品", meta.localCount ?? facets.localOnly ?? 0],
      ["未下载", meta.missingCount ?? facets.missingLocal ?? 0],
      ["当前结果", state.codePrefixTotal || 0],
      ["已加载", state.works.length]
    ]) {
      els.statsRow.append(createStat(label, value));
    }
    appendWorkControls(state.works);
  }

  function prefixIndexPageSize() {
    return globalThis.matchMedia?.("(max-width: 720px)")?.matches
      ? PREFIX_INDEX_MOBILE_PAGE_SIZE
      : PREFIX_INDEX_DESKTOP_PAGE_SIZE;
  }

  function detailPageSize() {
    return Math.max(40, Math.min(prefixIndexPageSize(), Number(state.workPageSize) || PREFIX_INDEX_MOBILE_PAGE_SIZE));
  }

  function readPrefixSortMode() {
    try {
      return window.localStorage?.getItem("fanhao.codePrefixSortMode") === "name" ? "name" : "count";
    } catch {
      return "count";
    }
  }

  function writePrefixSortMode(value) {
    try {
      window.localStorage?.setItem("fanhao.codePrefixSortMode", value);
    } catch {
      // Storage is optional in private or restricted browser contexts.
    }
  }

  return {
    applyRoute,
    cancelPendingRequests,
    disconnectIndexAutoload,
    enter,
    handleNavigationButton,
    invalidateIndex,
    loadMore,
    navigationButtonActive,
    reloadForActiveView,
    reloadSelected,
    renderDetailStats,
    selectPrefix,
    showIndex
  };
}

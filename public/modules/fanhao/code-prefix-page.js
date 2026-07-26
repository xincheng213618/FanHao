import { createLatestRequestGate } from "./latest-request.js?v=20260717-fanhao-latest-request-01";

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
    renderWorks,
    resetWorkPaging,
    setMainHeader,
    state,
    syncNavigationState,
    syncRouteAfterNavigation
  } = deps;

  const detailRequests = createLatestRequestGate();
  let indexLoadObserver = null;
  let indexLoadPending = false;
  let indexRequest = null;

  state.codePrefixSortMode = readPrefixSortMode();

  async function enter(options = {}) {
    return showIndex(options);
  }

  async function applyRoute(route) {
    clearWorkSearch();
    return route?.codePrefix
      ? selectPrefix(route.codePrefix, {
          family: route.codePrefixFamily,
          resetFilter: false,
          skipRoute: true
        })
      : showIndex({ skipRoute: true });
  }

  function invalidateIndex() {
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
    detailRequests.cancel();
    disconnectIndexAutoload();
    state.activeView = "codes";
    state.selectedCodePrefix = "";
    state.selectedCodePrefixFamily = false;
    state.selectedCodePrefixMeta = null;
    state.codePrefixTotal = 0;
    state.codePrefixFacets = null;
    state.codePrefixLoadingMore = false;
    state.searchPeople = [];
    state.works = [];
    syncNavigationState("codes");
    hidePersonProfile();
    setMainHeader("番号索引", "按番号前缀浏览本地资料库");
    renderIndexStats();
    renderIndex();
    await loadIndex(options);
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
  }

  async function loadIndex(options = {}) {
    if (state.codePrefixes.length && !options.force) {
      renderIndexStats();
      renderIndex();
      return;
    }
    if (indexRequest) return indexRequest;
    els.workGrid.innerHTML = `<div class="empty-state">正在整理番号与厂商对应关系</div>`;
    indexRequest = api("/api/code-prefixes?sort=count")
      .then((data) => {
        state.codePrefixes = data.prefixes || [];
        state.codePrefixIndexLocalCount = data.localWorkCount || 0;
        state.codePrefixMappedCount = data.mappedCount || 0;
        state.codePrefixVisibleLimit = prefixIndexPageSize();
        if (state.activeView === "codes" && !state.selectedCodePrefix) {
          renderIndexStats();
          renderIndex();
        }
      })
      .catch((error) => {
        if (state.activeView !== "codes" || state.selectedCodePrefix) return;
        els.workGrid.innerHTML = "";
        appendEmpty(error.message || "番号索引读取失败");
      })
      .finally(() => {
        indexRequest = null;
      });
    return indexRequest;
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

    els.statsRow.innerHTML = "";
    for (const [label, value] of [
      ["番号前缀", prefixes.length],
      ["已识别作品", localCount],
      ["已有厂商对应", mappedCount],
      ["FC2", fc2Count]
    ]) {
      els.statsRow.append(createStat(label, value));
    }

    const controls = document.createElement("div");
    controls.className = "stat-quick-filters code-prefix-index-controls";
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
      state.codePrefixSortMode = select.value === "name" ? "name" : "count";
      writePrefixSortMode(state.codePrefixSortMode);
      state.codePrefixVisibleLimit = prefixIndexPageSize();
      renderIndex();
    });
    group.append(label, select);
    controls.append(group);
    els.statsRow.append(controls);
  }

  function renderIndex() {
    if (state.activeView !== "codes" || state.selectedCodePrefix) return;
    disconnectIndexAutoload();
    const prefixes = sortedPrefixes();
    els.workGrid.innerHTML = "";
    if (!prefixes.length) {
      appendEmpty("本地资料库里还没有可识别的番号。");
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
    return [...(state.codePrefixes || [])].sort((a, b) =>
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
    const prefixes = sortedPrefixes();
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
      if (indexLoadPending || !entries.some((entry) => entry.isIntersecting)) return;
      indexLoadPending = true;
      indexLoadObserver?.disconnect();
      window.setTimeout(() => {
        indexLoadPending = false;
        loadMoreIndex();
      }, 80);
    }, { root: null, rootMargin: "720px 0px", threshold: 0 });
    indexLoadObserver.observe(target);
  }

  function disconnectIndexAutoload() {
    indexLoadObserver?.disconnect();
    indexLoadObserver = null;
  }

  async function selectPrefix(prefix, options = {}) {
    const normalizedPrefix = String(prefix || "").trim().toUpperCase();
    if (!normalizedPrefix) return showIndex(options);
    const request = detailRequests.begin();
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
    state.codePrefixFacets = null;
    state.codePrefixLoadingMore = false;
    if (options.resetFilter !== false) clearWorkFilter();
    syncNavigationState("codes");
    hidePersonProfile();
    setMainHeader(normalizedPrefix, options.family ? "正在查询全部系列" : "正在读取番号作品");
    els.statsRow.innerHTML = "";
    els.workGrid.innerHTML = `<div class="empty-state">正在加载作品</div>`;

    try {
      const data = await fetchDetailPage(normalizedPrefix, 0, {
        family: Boolean(options.family),
        signal: request.signal
      });
      if (!request.isCurrent() || state.activeView !== "codes" || state.selectedCodePrefix !== normalizedPrefix) return;
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
      if (request.signal.aborted) return;
      els.statsRow.innerHTML = "";
      els.workGrid.innerHTML = "";
      appendEmpty(error.message || "番号作品读取失败");
    } finally {
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
    if (state.works.length >= state.codePrefixTotal) return;
    state.codePrefixLoadingMore = true;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    try {
      const prefix = state.selectedCodePrefix;
      const family = state.selectedCodePrefixFamily;
      const data = await fetchDetailPage(prefix, state.works.length, { family });
      if (state.activeView !== "codes" || state.selectedCodePrefix !== prefix || state.selectedCodePrefixFamily !== family) return;
      applyDetailPayload(data, true);
      state.workVisibleLimit = Math.max(state.workVisibleLimit, state.works.length);
      renderPrefixHeader();
      renderDetailStats();
      appendLoadedWorkPage();
    } finally {
      state.codePrefixLoadingMore = false;
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = originalText || button.textContent;
      }
    }
  }

  function fetchDetailPage(prefix, offset, options = {}) {
    const params = new URLSearchParams({
      limit: String(detailPageSize()),
      offset: String(offset || 0),
      sort: state.sortMode || "releaseDesc",
      filter: state.filterMode || "all",
      includeMissingLocal: state.showMissingLocalWorks ? "1" : "0",
      includeCompilation: state.showCompilationWorks ? "1" : "0"
    });
    if (options.family) params.set("family", "1");
    return api(`/api/code-prefixes/${encodeURIComponent(prefix)}?${params}`, options.signal ? { signal: options.signal } : {});
  }

  function applyDetailPayload(data, append) {
    const next = data.works || [];
    if (append) {
      const seen = new Set(state.works.map((work) => String(work.id)));
      state.works.push(...next.filter((work) => !seen.has(String(work.id))));
    } else {
      state.works = next;
    }
    state.selectedCodePrefixMeta = data.codePrefix || state.selectedCodePrefixMeta;
    state.codePrefixTotal = data.total ?? state.works.length;
    state.codePrefixFacets = data.facets || state.codePrefixFacets || null;
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
    cancelPendingRequests: detailRequests.cancel,
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

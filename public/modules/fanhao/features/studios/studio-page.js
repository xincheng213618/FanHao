import { createLatestRequestGate } from "../../latest-request.js?v=20260717-fanhao-latest-request-01";
import { createPrefetchCache } from "../../prefetch-cache.js?v=20261004-fanhao-requests-01";
import { resolveWorkPage } from "../works/work-page-state.js";
import { compareSeriesByLocalCount, createStudioSeriesPicker } from "./series-picker.js?v=20261113-studio-series-picker-01";

const STUDIO_DESKTOP_PAGE_SIZE = 48;
const STUDIO_MOBILE_PAGE_SIZE = 32;
const STUDIO_PREFETCH_TTL_MS = 60 * 1000;
const STUDIO_PREFETCH_LIMIT = 16;
const STUDIO_INDEX_INITIAL_COUNT = 64;
const STUDIO_INDEX_BATCH_SIZE = 64;
const STUDIO_INDEX_BATCH_DELAY_MS = 16;
const STUDIO_INDEX_SEARCH_DELAY_MS = 220;
const STUDIO_INDEX_PATH = "/api/studios?limit=500&sort=localCount";
const STUDIO_SERIES_QUICK_LIMIT = 6;

export function createStudioPage(deps) {
  const { api, appendLoadedWorkPage, appendEmpty, els, formatNumber, getWorkFilterMode, hidePersonProfile, onNavigationStarted, onWorkRead = () => null, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;
  const studioRequests = createLatestRequestGate();
  const studioIndexRequests = createLatestRequestGate();
  const studioPrefetches = createPrefetchCache({ limit: STUDIO_PREFETCH_LIMIT, ttlMs: STUDIO_PREFETCH_TTL_MS });
  let studioIndexRenderTimer = null;
  let studioIndexRenderSeq = 0;
  let studioIndexQuery = "";
  let studioIndexSort = "count";
  let studioIndexSummary = null;
  let studioIndexTotal = 0;
  let studioIndexSearchTimer = null;
  let studioIndexSearch = null;
  let studioPageOwner = null;
  let seriesPicker = null;
  bindStudioIntentSurface(els.workGrid, ".studio-card", (studioId) => {
    globalThis.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
    loadStudioDetail(studioId);
  });
  bindStudioIntentSurface(els.statsRow, ".studio-series-chip", (studioId, seriesId) => {
    loadStudioDetail(studioId, seriesId);
  });

  function cancelPendingRequests() {
    seriesPicker?.close();
    studioRequests.cancel();
    studioPageOwner = null;
    state.studioWorksLoadingMore = false;
    studioPrefetches.clear();
    cancelIndexRendering();
    retireStudioIndex();
  }

  function invalidatePrefetches() {
    studioPrefetches.clear();
  }

  function studioPageSize() {
    const viewportLimit = globalThis.matchMedia?.("(max-width: 720px)")?.matches
      ? STUDIO_MOBILE_PAGE_SIZE
      : STUDIO_DESKTOP_PAGE_SIZE;
    return Math.max(24, Math.min(viewportLimit, Number(state.workPageSize) || viewportLimit));
  }

  async function loadStudios(options = {}) {
    seriesPicker?.close();
    onNavigationStarted?.(options);
    studioPageOwner = null;
    state.studioWorksLoadingMore = false;
    state.studioWorksRawLoaded = null;
    state.studioWorksHasMore = null;
    cancelIndexRendering();
    retireStudioIndex();
    const request = studioRequests.begin();
    els.workGrid.innerHTML = `<div class="empty-state">正在加载片商</div>`;
    try {
      const data = await api(STUDIO_INDEX_PATH, { signal: request.signal });
      if (!request.isCurrent() || state.activeView !== "studios") return;
      resetSelection();
      state.studios = data.makers || [];
      studioIndexTotal = data.total ?? state.studios.length;
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
    if (!options.append) {
      seriesPicker?.close();
      onNavigationStarted?.(options);
      studioPageOwner = null;
      state.studioWorksLoadingMore = false;
      state.studioWorksRawLoaded = null;
      state.studioWorksHasMore = null;
      retireStudioIndex();
    }
    cancelIndexRendering();
    const append = Boolean(options.append);
    const request = studioRequests.begin();
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载片商作品</div>`;
    const offset = append ? (Number.isSafeInteger(state.studioWorksRawLoaded) ? state.studioWorksRawLoaded : state.works.length) : 0;
    const path = studioDetailPath(studioId, seriesId, offset);
    const query = studioDetailPath(studioId, seriesId, 0);
    const isCurrent = () => request.isCurrent() && state.activeView === "studios"
      && query === studioDetailPath(studioId, seriesId, 0);
    const finishWorkRead = onWorkRead(path, isCurrent, () => {
      cancelPendingRequests();
      return loadStudioDetail(studioId, seriesId);
    });
    try {
      const data = await fetchStudioDetail(path, request, !append);
      if (!isCurrent()) return;
      if (!append) resetSelection();
      state.selectedStudio = data.studio || state.selectedStudio || null;
      state.selectedStudioSeriesId = data.selectedSeriesId || seriesId || "all";
      applyStudioWorks(data, append, offset);
      state.studioWorksTraitFacets = data.traitFacets || (append ? state.studioWorksTraitFacets : null) || null;
      if (!append) resetWorkPaging();
      const studio = state.selectedStudio;
      const selectedSeries = (studio?.series || []).find((item) => String(item.id) === String(state.selectedStudioSeriesId));
      setMainHeader(studio?.name || "片商", selectedSeries ? `${selectedSeries.name} · ${formatNumber(state.studioWorksTotal)} 部` : `${formatNumber(state.studioWorksTotal)} 部本地作品`);
      const restoreSeriesFocus = options.focusOwner && document.activeElement === options.focusOwner;
      renderStatsForWorks(state.works);
      const seriesControls = renderSeriesControls(studio);
      if (restoreSeriesFocus) seriesControls?.querySelector(".studio-series-chip.active")?.focus({ preventScroll: true });
      if (append) appendLoadedWorkPage();
      else renderWorks("这个片商暂无本地作品。");
    } catch (error) {
      if (!isCurrent()) return;
      if (append) throw error;
      setMainHeader("片商", "读取失败");
      els.workGrid.innerHTML = "";
      appendEmpty(error.message || "片商作品读取失败");
    } finally {
      finishWorkRead?.();
      request.finish();
    }
  }

  function studioDetailPath(studioId, seriesId = "all", offset = 0) {
    const params = new URLSearchParams({
      seriesId,
      sort: state.sortMode || "releaseDesc",
      filter: getWorkFilterMode?.() || state.filterMode || "all",
      includeMissingLocal: state.showMissingLocalWorks ? "1" : "0",
      includeCompilation: state.showCompilationWorks ? "1" : "0",
      limit: String(studioPageSize()),
      offset: String(offset || 0)
    });
    return `/api/studios/${encodeURIComponent(studioId)}?${params}`;
  }

  function prefetchStudioDetail(studioId, seriesId = "all") {
    if (globalThis.navigator?.connection?.saveData) return null;
    const path = studioDetailPath(studioId, seriesId, 0);
    return studioPrefetches.prefetch(path, (signal) => api(path, { signal }));
  }

  async function fetchStudioDetail(path, request, allowPrefetch) {
    const prefetched = allowPrefetch ? studioPrefetches.consume(path, request.signal) : null;
    if (prefetched) {
      const result = await prefetched;
      if (!request.isCurrent()) throw new DOMException("Request aborted", "AbortError");
      if (result.error) throw result.error;
      if (result.data !== null) return result.data;
    }
    return api(path, { signal: request.signal });
  }

  function applyStudioWorks(data, append, offset) {
    const page = resolveWorkPage(data, { existingWorks: append ? state.works : [], offset, previousTotal: append ? state.studioWorksTotal : 0 });
    if (append) {
      state.works.push(...page.works);
      state.workVisibleLimit += studioPageSize();
    } else state.works = page.works;
    state.studioWorksTotal = page.total;
    state.studioWorksRawLoaded = page.rawLoaded;
    state.studioWorksHasMore = page.hasMore;
  }

  async function loadMoreStudioWorks(button) {
    if (state.activeView !== "studios" || state.studioWorksLoadingMore || !state.selectedStudio
      || !(state.studioWorksHasMore ?? state.works.length < state.studioWorksTotal)) return;
    const owner = {};
    studioPageOwner = owner;
    state.studioWorksLoadingMore = true;
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "正在加载";
    }
    try {
      await loadStudioDetail(state.selectedStudio.id, state.selectedStudioSeriesId, { append: true });
    } catch (error) {
      if (studioPageOwner === owner && button?.isConnected) button.textContent = error.message || "加载失败";
    } finally {
      if (studioPageOwner === owner) {
        studioPageOwner = null;
        state.studioWorksLoadingMore = false;
        if (button?.isConnected) {
          button.disabled = false;
          if (button.textContent === "正在加载") button.textContent = originalText;
        }
      }
    }
  }

  function resetSelection() {
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.selectedStudio = null;
    state.selectedStudioSeriesId = "all";
    state.studioWorksTotal = 0;
    state.studioWorksRawLoaded = null;
    state.studioWorksHasMore = null;
    state.studioWorksTraitFacets = null;
    state.works = [];
    state.searchPeople = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    hidePersonProfile();
  }

  function renderIndex() {
    cancelIndexRendering();
    els.statsRow.innerHTML = "";
    els.workGrid.innerHTML = "";
    const controls = document.createElement("div");
    controls.className = "studio-index-controls";
    const searchLabel = document.createElement("label");
    searchLabel.className = "studio-index-search";
    const searchCaption = document.createElement("span");
    searchCaption.textContent = "搜索片商";
    const search = document.createElement("input");
    search.type = "search";
    search.autocomplete = "off";
    search.maxLength = 120;
    search.placeholder = "输入片商名称";
    search.value = studioIndexQuery;
    search.setAttribute("aria-label", "搜索片商");
    const summary = document.createElement("span");
    const current = () => studioIndexSummary === summary && controls.isConnected;
    let composing = false;
    const submit = (delay) => {
      if (!current()) return;
      studioIndexQuery = search.value;
      searchStudioIndex(delay);
    };
    search.addEventListener("compositionstart", () => { composing = true; if (current()) cancelIndexSearch(); });
    search.addEventListener("compositionend", () => { composing = false; submit(); });
    search.addEventListener("input", (event) => { if (!composing && !event.isComposing) submit(); });
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || composing || event.isComposing) return;
      event.preventDefault();
      submit(0);
    });
    searchLabel.append(searchCaption, search);
    const sortLabel = document.createElement("label");
    sortLabel.className = "studio-index-sort";
    sortLabel.textContent = "结果排序";
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "片商排序");
    sort.append(new Option("馆藏数量", "count"), new Option("名称", "name"));
    sort.value = studioIndexSort;
    sort.addEventListener("change", () => {
      if (!current()) return;
      studioIndexSort = sort.value === "name" ? "name" : "count";
      renderIndexMatches();
    });
    sortLabel.append(sort);
    summary.className = "studio-index-summary";
    summary.setAttribute("role", "status");
    studioIndexSummary = summary;
    controls.append(searchLabel, sortLabel, summary);
    els.statsRow.append(controls);
    searchStudioIndex(0);
  }

  function cancelIndexSearch() {
    globalThis.clearTimeout(studioIndexSearchTimer);
    studioIndexSearchTimer = null;
    studioIndexRequests.cancel();
    studioIndexSearch = null;
  }

  function retireStudioIndex() {
    studioIndexSummary?.parentElement?.remove();
    studioIndexSummary = null;
    cancelIndexSearch();
  }

  function searchStudioIndex(delay = STUDIO_INDEX_SEARCH_DELAY_MS) {
    cancelIndexSearch();
    renderIndexMatches();
    const query = studioIndexQuery.trim();
    if (!query) return;
    const request = studioIndexRequests.begin();
    studioIndexSearchTimer = globalThis.setTimeout(async () => {
      studioIndexSearchTimer = null;
      try {
        const data = await api(`${STUDIO_INDEX_PATH}&${new URLSearchParams({ q: query })}`, { signal: request.signal });
        if (request.isCurrent()) studioIndexSearch = { data };
      } catch {
        if (request.isCurrent()) studioIndexSearch = { failed: true };
      } finally {
        if (request.isCurrent()) renderIndexMatches();
        request.finish();
      }
    }, delay);
  }

  function renderIndexMatches() {
    cancelIndexRendering();
    const focusId = els.workGrid.contains(document.activeElement) ? document.activeElement?.dataset.studioId : null;
    els.workGrid.innerHTML = "";
    const query = studioIndexQuery.trim().toLocaleLowerCase();
    const searched = studioIndexSearch?.data;
    const studios = searched ? [...(searched.makers || [])]
      : state.studios.filter((studio) => String(studio.name || "").toLocaleLowerCase().includes(query));
    studios.sort((a, b) => {
      const name = String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans", { numeric: true, sensitivity: "base" });
      return studioIndexSort === "name" ? name : localStudioCount(b) - localStudioCount(a) || name;
    });
    const total = searched ? searched.total ?? studios.length : studioIndexTotal;
    if (studioIndexSummary) {
      studioIndexSummary.textContent = !query || searched ? `${formatNumber(studios.length)} / ${formatNumber(total)} 家片商`
        : studioIndexSearch?.failed ? "全库搜索失败，显示已加载片商中的匹配。" : "正在搜索全部片商…";
      if (query && studioIndexSearch?.failed) {
        const summary = studioIndexSummary;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "stat-filter-chip";
        retry.textContent = "重试";
        retry.addEventListener("click", () => {
          if (summary !== studioIndexSummary || !summary.isConnected) return;
          els.statsRow.querySelector(".studio-index-search input")?.focus();
          searchStudioIndex(0);
        });
        studioIndexSummary.append(" ", retry);
      }
    }
    if (!query && !state.studios.length) {
      appendEmpty("还没有片商数据。");
    } else if (studios.length) appendIndexBatch(studios, 0, studioIndexRenderSeq);
    else if (searched) appendEmpty("没有匹配的片商，试试其他名称。");
    if (focusId) {
      const card = els.workGrid.querySelector(`.studio-card[data-studio-id="${CSS.escape(focusId)}"]`);
      (card || els.statsRow.querySelector(".studio-index-search input"))?.focus({ preventScroll: true });
    }
  }

  function appendIndexBatch(studios, start, renderSeq) {
    if (renderSeq !== studioIndexRenderSeq || state.activeView !== "studios" || state.selectedStudio) return;
    const size = start ? STUDIO_INDEX_BATCH_SIZE : STUDIO_INDEX_INITIAL_COUNT;
    const end = Math.min(studios.length, start + size);
    const fragment = document.createDocumentFragment();
    for (const studio of studios.slice(start, end)) fragment.append(createCard(studio));
    els.workGrid.append(fragment);
    if (end >= studios.length) return;
    studioIndexRenderTimer = globalThis.setTimeout(() => {
      studioIndexRenderTimer = null;
      appendIndexBatch(studios, end, renderSeq);
    }, STUDIO_INDEX_BATCH_DELAY_MS);
  }

  function cancelIndexRendering() {
    studioIndexRenderSeq += 1;
    if (studioIndexRenderTimer) globalThis.clearTimeout(studioIndexRenderTimer);
    studioIndexRenderTimer = null;
  }

  function createCard(studio) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "studio-card";
    button.dataset.studioId = studio.id;
    const countValue = localStudioCount(studio);
    button.setAttribute("aria-label", `${studio.name || "未命名片商"}，${formatNumber(countValue)} 部本地作品`);
    const visual = document.createElement("span");
    visual.className = "studio-card-visual";
    const placeholder = document.createElement("span");
    placeholder.className = "studio-card-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = String(studio.name || "片商").slice(0, 4);
    visual.append(placeholder);
    const logoUrl = safeLogoUrl(studio.logoUrl);
    if (logoUrl) {
      const logo = document.createElement("img");
      logo.alt = "";
      logo.loading = "lazy";
      logo.decoding = "async";
      logo.addEventListener("load", () => { placeholder.hidden = true; });
      logo.addEventListener("error", () => { logo.remove(); placeholder.hidden = false; });
      logo.src = logoUrl;
      visual.append(logo);
    }
    const name = document.createElement("strong");
    name.textContent = studio.name || "未命名片商";
    name.title = studio.name || "未命名片商";
    const count = document.createElement("span");
    count.className = "studio-card-count";
    count.textContent = `${formatNumber(countValue)} 部本地作品`;
    button.append(visual, name, count);
    return button;
  }

  function localStudioCount(studio) {
    return Math.max(0, Number(studio.localWorkCount ?? studio.workCount) || 0);
  }

  function safeLogoUrl(value) {
    if (!value || typeof value !== "string") return "";
    try {
      const url = new URL(value, globalThis.location?.origin || "http://fanhao.local");
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  function renderSeriesControls(studio) {
    if (state.activeView !== "studios" || !studio) return;
    const series = (studio.series || []).filter((item) => Number(item.localWorkCount || 0) > 0).sort(compareSeriesByLocalCount);
    const selectedId = String(state.selectedStudioSeriesId);
    const quick = series.slice(0, STUDIO_SERIES_QUICK_LIMIT);
    const selected = series.find(({ id }) => String(id) === selectedId);
    if (selected && !quick.includes(selected)) quick.push(selected);
    const wrap = document.createElement("div");
    wrap.className = "stat-quick-filters studio-series-controls";
    const group = document.createElement("div");
    group.className = "stat-filter-group";
    const heading = document.createElement("span");
    heading.className = "stat-filter-label";
    heading.textContent = "系列";
    group.append(heading, createSeriesButton(studio, "all", "全部", studio.localWorkCount || 0));
    for (const item of quick) group.append(createSeriesButton(studio, item.id, item.name, item.localWorkCount));
    if (series.length > 1) {
      const launch = document.createElement("button");
      launch.type = "button";
      launch.className = "stat-filter-chip studio-series-launch";
      launch.textContent = `查找系列 · ${formatNumber(series.length)}`;
      launch.setAttribute("aria-haspopup", "dialog");
      launch.addEventListener("click", () => {
        if (!launch.isConnected || state.activeView !== "studios" || String(state.selectedStudio?.id) !== String(studio.id)) return;
        seriesPicker ??= createStudioSeriesPicker({
          formatNumber,
          selectSeries(studioId, seriesId, focusOwner) {
            if (state.activeView !== "studios" || String(state.selectedStudio?.id) !== studioId
              || String(state.selectedStudioSeriesId) === seriesId) return;
            void loadStudioDetail(studioId, seriesId, { focusOwner });
          }
        });
        seriesPicker.open(studio, series, selectedId, launch);
      });
      group.append(launch);
    }
    wrap.append(group);
    els.statsRow.append(wrap);
    return wrap;
  }

  function createSeriesButton(studio, seriesId, name, count) {
    const button = document.createElement("button");
    button.type = "button";
    const selected = String(state.selectedStudioSeriesId) === String(seriesId);
    button.className = `stat-filter-chip studio-series-chip${selected ? " active" : ""}`;
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = `${name} ${formatNumber(count)}`;
    button.dataset.studioId = studio.id;
    button.dataset.seriesId = seriesId;
    return button;
  }

  function bindStudioIntentSurface(root, selector, activate) {
    if (!root) return;
    const targetButton = (target) => {
      const button = target instanceof Element ? target.closest(selector) : null;
      return button && root.contains(button) ? button : null;
    };
    const prefetch = (event) => {
      const button = targetButton(event.target);
      if (!button || (event.type === "pointerover" && button.contains(event.relatedTarget))) return;
      void prefetchStudioDetail(button.dataset.studioId, button.dataset.seriesId || "all");
    };
    root.addEventListener("pointerover", prefetch, { passive: true });
    root.addEventListener("pointerdown", prefetch, { passive: true });
    root.addEventListener("focusin", prefetch);
    root.addEventListener("click", (event) => {
      const button = targetButton(event.target);
      if (button) activate(button.dataset.studioId, button.dataset.seriesId || "all");
    });
  }

  return { cancelPendingRequests, invalidatePrefetches, loadStudios, loadMoreStudioWorks, loadStudioDetail };
}

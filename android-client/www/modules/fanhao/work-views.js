import { fetchJson } from "../../js/api.js?v=20260702-novel-local-manage-74";
import { enhanceAutoLoadMore } from "../../js/auto-load.js?v=20260720-fanhao-scroll-intent-01";
import { cacheAgeText, readCachedJson, writeCachedJson } from "../../js/cache.js?v=20260702-novel-local-manage-74";
import { formatNumber } from "../../js/format.js";
import { createWorkListState } from "../../js/work-filtering.js?v=20260721-fanhao-work-browse-density-10";
import { createWorkCards } from "./features/works/cards.js?v=20260721-fanhao-author-sort-density-08";
import { workCollectionPath } from "./features/works/collection-request.js?v=20260720-fanhao-collection-filter-01";
import { createRankingViews } from "./features/rankings/ranking-views.js?v=20260721-fanhao-person-detail-02";
import { createWorkPageDataService } from "./features/works/page-data-service.js?v=20260717-fanhao-page-race-01";
import { createWorkSearchDataService } from "./features/works/search-data-service.js?v=20260717-fanhao-search-response-01";
import { createWorkDetailDataService } from "./features/works/detail-data-service.js?v=20260717-fanhao-touch-intent-01";
import { createProgressiveWorkListRenderer } from "./features/works/progressive-list-renderer.js?v=20260717-fanhao-work-first-paint-01";
import { createFanhaoSearchPage } from "./search-page.js?v=20260721-fanhao-search-discovery-03";

const CONTINUE_PREVIEW_DAYS = 30;
const CONTINUE_PREVIEW_LIMIT = 8;
function workDataSignature(data = {}) {
  const works = Array.isArray(data.works) ? data.works : [];
  return JSON.stringify({
    total: Number(data.total || works.length),
    facets: data.facets || null,
    works: works.map((work) => [
      work.id || "",
      work.title || "",
      work.directoryName || "",
      work.modifiedAt || "",
      work.favorite ? 1 : 0,
      work.progress || 0,
      work.missingLocal ? 1 : 0,
      work.infoSummary?.rating || "",
      work.infoSummary?.ratingCount || 0,
      work.infoSummary?.releaseDate || "",
      work.ranking?.rankNo || ""
    ])
  });
}

export function createWorkViews(context) {
  const {
    els,
    getActiveUrl,
    getLibrary = () => null,
    getWorksLimit,
    increaseWorksLimit,
    showView,
    goBack,
    setActiveBottom,
    renderCurrentView,
    renderCurrentViewPreservingScroll = renderCurrentView,
    isHomeView = () => false
  } = context;
  const workListState = createWorkListState({ renderCurrentView });
  const searchListState = createWorkListState({ renderCurrentView, persist: false, initialFilterMode: "all", initialSortMode: "updated" });
  const pageDataService = createWorkPageDataService({ fetchJson, readCachedJson, writeCachedJson });
  const workDetailDataService = createWorkDetailDataService({ getActiveUrl, pageDataService });
  const workCards = createWorkCards({ getActiveUrl, roots: [els.viewContent, els.continuePreview], showView, workDetailDataService });
  const progressiveWorkListRenderer = createProgressiveWorkListRenderer();
  const searchDataService = createWorkSearchDataService({ getActiveUrl, getWorksLimit, pageDataService, workListState: searchListState });
  const searchPage = createFanhaoSearchPage({ els, goBack, showView, warmSearch: searchDataService.warm, getLibrary });
  const rankingViews = createRankingViews({
    els,
    getActiveUrl,
    renderCurrentView,
    renderCurrentViewPreservingScroll,
    renderMessage,
    renderWorks,
    setActiveBottom,
    workListState
  });
  async function renderContinuePreview(options = {}) {
    if (!els.continuePreview || !els.continueSection) return;
    els.continuePreview.dataset.hasItems = "0";
    els.continuePreview.innerHTML = `<div class="loading-row">正在读取最近进度</div>`;
    els.continueSection.hidden = !isHomeView();
    const path = `/api/history?days=${CONTINUE_PREVIEW_DAYS}&limit=${CONTINUE_PREVIEW_LIMIT}`;
    const activeUrl = getActiveUrl();

    if (options.preferCache) {
      const cached = await readCachedJson(activeUrl, path).catch(() => null);
      if (cached?.payload) {
        renderContinueData(cached.payload);
        warmPrimaryCollections(activeUrl);
        return;
      }
    }

    let renderedCache = false;
    try {
      const result = await pageDataService.load(activeUrl, path, {
        onCached(data) {
          renderedCache = true;
          renderContinueData(data);
          warmPrimaryCollections(activeUrl);
        }
      });
      if (!result.unchanged) renderContinueData(result.data);
      warmPrimaryCollections(activeUrl);
    } catch {
      if (!renderedCache) {
        els.continuePreview.dataset.hasItems = "0";
        els.continuePreview.innerHTML = "";
        els.continueSection.hidden = true;
      }
    }
  }
  function renderContinueData(data) {
    const works = (data.works || []).filter((work) => workCards.progressPercent(work) > 0).slice(0, CONTINUE_PREVIEW_LIMIT);
    els.continuePreview.innerHTML = "";

    if (!works.length) {
      els.continueSection.hidden = true;
      return;
    }

    const list = document.createElement("div");
    list.className = "continue-list";
    for (const work of works) {
      const card = workCards.createWorkCard(work);
      card.classList.add("continue-card");
      list.append(card);
    }

    els.continuePreview.dataset.hasItems = "1";
    els.continuePreview.append(list);
    els.continueSection.hidden = !isHomeView();
  }

  async function renderHistory(isActive = () => true) {
    leaveRankingSort();
    setActiveBottom("history");
    els.viewKicker.textContent = "继续观看";
    els.viewTitle.textContent = "观看进度";
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载观看进度</div>`;
    const path = historyPath(getWorksLimit());
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const applyHeader = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || data.count || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(works.length)} / ${formatNumber(total)} 个作品${suffix}`;
    };

    const renderData = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || data.count || works.length);
      applyHeader(data, cacheEntry);
      els.viewContent.innerHTML = "";
      renderWorks(works, "暂无继续观看记录。", {
        facets: data.facets,
        ...serverContinuationOptions(works, total)
      });
    };

    try {
      const result = await pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive,
        signature: workDataSignature,
        onCached(data, cacheEntry) {
          renderedCache = true;
          renderData(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      if (result.unchanged) {
        applyHeader(result.data);
        return;
      }
      renderData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) renderMessage("电脑端暂时连不上，当前显示的是本地缓存。", "quiet", false);
      else renderMessage(error.message, "error");
    }
  }

  function historyPath(limit = getWorksLimit()) {
    return workCollectionPath("history", {
      limit,
      filter: workListState.getServerFilterMode(),
      sort: workListState.getServerSortMode()
    });
  }

  async function renderAllWorks(isActive = () => true) {
    leaveRankingSort();
    setActiveBottom("works");
    els.viewKicker.textContent = "作品";
    els.viewTitle.textContent = "片库";
    els.viewMeta.textContent = "正在加载";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载作品</div>`;

    const limit = getWorksLimit();
    const serverFilter = workListState.getServerFilterMode();
    const serverSort = workListState.getServerSortMode();
    const path = `/api/works?limit=${limit}&offset=0&sort=${encodeURIComponent(serverSort)}&filter=${encodeURIComponent(serverFilter)}`;
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const applyWorksHeader = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(works.length)} / ${formatNumber(total)} 个作品${suffix}`;
    };

    const renderWorksData = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || works.length);
      applyWorksHeader(data, cacheEntry);
      els.viewContent.innerHTML = "";
      renderWorks(works, "资料库里还没有作品。", {
        compactMeta: true,
        compactSummary: true,
        coverGrid: true,
        facets: data.facets,
        ...serverContinuationOptions(works, total)
      });
    };

    try {
      const result = await pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive,
        signature: workDataSignature,
        onCached(data, cacheEntry) {
          renderedCache = true;
          renderWorksData(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      if (result.unchanged) {
        applyWorksHeader(result.data);
        return;
      }
      renderWorksData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存作品。", "quiet", false);
      } else {
        renderMessage(error.message, "error");
      }
    }
  }

  async function renderStudios(isActive = () => true) {
    leaveRankingSort();
    setActiveBottom("works");
    els.viewKicker.textContent = "片商";
    els.viewTitle.textContent = "片商索引";
    els.viewMeta.textContent = "正在加载";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载片商</div>`;

    const path = "/api/studios?limit=500";
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderData = (data, cacheEntry = null, headerOnly = false) => {
      const studios = data.makers || [];
      const total = Number(data.total || studios.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(studios.length)} / ${formatNumber(total)} 个片商${suffix}`;
      if (headerOnly) return;
      els.viewContent.innerHTML = "";
      if (!studios.length) {
        renderMessage("还没有片商数据。", "quiet", false);
        return;
      }
      const grid = document.createElement("div");
      grid.className = "studio-list";
      for (const studio of studios) grid.append(createStudioCard(studio));
      els.viewContent.append(grid);
    };

    try {
      const result = await pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive,
        onCached(data, cacheEntry) {
          renderedCache = true;
          renderData(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      renderData(result.data, null, result.unchanged);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        els.viewMeta.textContent = "离线缓存";
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存片商。", "quiet", false);
      } else {
        els.viewMeta.textContent = "加载失败";
        renderMessage(error.message, "error");
      }
    }
  }

  async function renderStudioDetail(studioId, seriesId = "all", isActive = () => true) {
    leaveRankingSort();
    setActiveBottom("works");
    els.viewKicker.textContent = "片商";
    els.viewTitle.textContent = "正在加载";
    els.viewMeta.textContent = "";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载片商作品</div>`;
    const limit = getWorksLimit();
    const path = studioDetailPath(studioId, seriesId, limit);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const applyHeader = (data, cacheEntry = null) => {
      const studio = data.studio || {};
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const selectedSeries = selectedStudioSeries(studio, data.selectedSeriesId || seriesId);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewTitle.textContent = studio.name || "片商";
      els.viewMeta.textContent = selectedSeries
        ? `${selectedSeries.name} · ${formatNumber(works.length)} / ${formatNumber(total)} 部${suffix}`
        : `${formatNumber(works.length)} / ${formatNumber(total)} 部本地作品${suffix}`;
    };

    const renderData = (data, cacheEntry = null) => {
      const studio = data.studio || {};
      const works = data.works || [];
      const total = Number(data.total || works.length);
      applyHeader(data, cacheEntry);
      els.viewContent.innerHTML = "";
      renderStudioSeriesStrip(studio, data.selectedSeriesId || seriesId || "all");
      renderWorks(works, "这个片商暂无本地作品。", {
        compactMeta: true,
        coverGrid: true,
        ...serverContinuationOptions(works, total)
      });
    };

    try {
      const result = await pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive,
        reuseWarmed: true,
        signature: workDataSignature,
        onCached(data, cacheEntry) {
          renderedCache = true;
          renderData(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      if (result.unchanged) {
        applyHeader(result.data);
        return;
      }
      renderData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存片商作品。", "quiet", false);
      } else {
        els.viewTitle.textContent = "片商";
        renderMessage(error.message, "error");
      }
    }
  }

  function studioDetailPath(studioId, seriesId = "all", limit = getWorksLimit()) {
    const params = new URLSearchParams({
      seriesId: seriesId || "all",
      filter: workListState.getServerFilterMode(),
      sort: workListState.getServerSortMode(),
      limit: String(limit),
      offset: "0"
    });
    return `/api/studios/${encodeURIComponent(studioId)}?${params}`;
  }

  function warmStudioDetail(studioId, seriesId = "all") {
    if (globalThis.navigator?.connection?.saveData) return;
    pageDataService.warm(getActiveUrl(), [studioDetailPath(studioId, seriesId)]);
  }

  function createStudioCard(studio) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "studio-card";
    const warmDetail = () => warmStudioDetail(studio.id);
    button.addEventListener("pointerdown", warmDetail, { passive: true });
    button.addEventListener("focus", warmDetail);
    button.addEventListener("click", () => showView("studioDetail", { studioId: studio.id, seriesId: "all" }, { push: true }));

    const name = document.createElement("strong");
    name.textContent = studio.name || "未命名片商";

    const meta = document.createElement("span");
    const localCount = Number(studio.localWorkCount || studio.workCount || 0);
    const seriesCount = Array.isArray(studio.series) ? studio.series.length : Number(studio.seriesCount || 0);
    meta.textContent = `${formatNumber(localCount)} 部${seriesCount ? ` · ${formatNumber(seriesCount)} 系列` : ""}`;

    button.append(name, meta);
    return button;
  }

  function renderStudioSeriesStrip(studio, activeSeriesId = "all") {
    const series = (studio.series || []).filter((item) => Number(item.localWorkCount || 0) > 0);
    if (!series.length && !studio.localWorkCount) return;

    const strip = document.createElement("div");
    strip.className = "studio-series-strip";
    strip.append(createStudioSeriesChip(studio.id, "all", "全部", studio.localWorkCount || studio.workCount || 0, activeSeriesId));
    for (const item of series) {
      strip.append(createStudioSeriesChip(studio.id, item.id, item.name, item.localWorkCount || item.workCount || 0, activeSeriesId));
    }
    els.viewContent.append(strip);
  }

  function createStudioSeriesChip(studioId, seriesId, name, count, activeSeriesId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = String(activeSeriesId || "all") === String(seriesId || "all") ? "active" : "";
    button.textContent = `${name} ${formatNumber(count || 0)}`;
    const warmDetail = () => warmStudioDetail(studioId, seriesId);
    button.addEventListener("pointerdown", warmDetail, { passive: true });
    button.addEventListener("focus", warmDetail);
    button.addEventListener("click", () => {
      showView("studioDetail", { studioId, seriesId: seriesId || "all" }, { skipHistory: true, replaceHistory: true });
    });
    return button;
  }

  function selectedStudioSeries(studio, seriesId) {
    const id = String(seriesId || "all");
    if (!id || id === "all") return null;
    return (studio.series || []).find((item) => String(item.id) === id) || null;
  }

  async function renderSearchResults(query, isActive = () => true) {
    const text = query.trim();
    setActiveBottom("search");
    els.viewKicker.textContent = "搜索";
    els.viewTitle.textContent = text ? `搜索：${text}` : "搜索番号库";
    els.viewMeta.textContent = text ? "正在搜索番号与作者" : "输入番号、作品标题或作者后搜索";
    els.contentPanel.hidden = false;
    const { results } = searchPage.render(text);

    if (!text) {
      searchListState.setFilterMode("all", { replace: true, rerender: false });
      searchListState.setSortMode("updated", { rerender: false });
      return;
    }

    results.innerHTML = `<div class="loading-row">正在搜索</div>`;
    const limit = getWorksLimit();
    const serverFilter = searchListState.getServerFilterMode();
    const serverSort = searchListState.getServerSortMode();
    const path = searchDataService.path(text, limit, serverFilter, serverSort);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderSearchData = (data, cacheEntry = null, headerOnly = false) => {
      const people = data.people || [];
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(total)} 个作品 · ${formatNumber(people.length)} 位作者${suffix}`;
      if (headerOnly) return;
      results.innerHTML = "";
      renderSearchPeople(people, results);
      if (works.length || total || !people.length) {
        renderWorks(works, `没有搜到「${text}」。`, {
          container: results,
          listState: searchListState,
          coverGrid: true,
          facets: data.facets,
          ...serverContinuationOptions(works, total)
        });
      } else {
        renderMessageInto(results, "没有匹配的番号作品，已显示作者结果。", "quiet", false);
      }
    };

    try {
      const result = await pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive,
        reuseWarmed: true,
        onCached(data, cacheEntry) {
          renderedCache = true;
          renderSearchData(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      renderSearchData(result.data, null, result.unchanged);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessageInto(results, "电脑端暂时连不上，当前显示的是本地缓存搜索结果。", "quiet", false);
      } else {
        renderMessageInto(results, error.message, "error");
      }
    }
  }

  async function renderRankings(isActive = () => true) {
    return rankingViews.renderRankings(isActive);
  }

  function warmPrimaryCollections(activeUrl) {
    pageDataService.warm(activeUrl, [historyPath(getWorksLimit())]);
  }

  async function refreshRankingCache() {
    return rankingViews.refreshRankingCache();
  }

  function leaveRankingSort() {
    rankingViews.leaveRankingSort();
  }

  function serverContinuationOptions(works, total) {
    return {
      total,
      hasServerMore: works.length < total,
      onLoadMore() {
        increaseWorksLimit(48);
        return renderCurrentViewPreservingScroll();
      }
    };
  }

  function renderSearchPeople(people, container = els.viewContent) {
    if (!people.length) return;

    const panel = document.createElement("div");
    panel.className = "chip-panel";
    for (const person of people.slice(0, 12)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "person-chip";
      chip.textContent = `${workCards.displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
      chip.addEventListener("click", () => showView("personDetail", { personId: person.id }, { push: true }));
      panel.append(chip);
    }
    container.append(panel);
  }

  function renderWorks(works, emptyMessage, options = {}) {
    const { container = els.viewContent, listState = workListState, ...renderOptions } = options;
    if (!renderOptions.allowRankingSort && listState === workListState) leaveRankingSort();
    progressiveWorkListRenderer.cancel();
    workCards.resetCoverLoading();
    const source = works || [];
    const list = listState.visibleWorks(source, renderOptions);
    const visible = list.slice(0, getWorksLimit());
    container.querySelector(".loading-row")?.remove();
    if (renderOptions.hideControls !== true) {
      container.append(listState.createWorkControls(source, list, renderOptions));
    }

    if (!list.length) {
      renderMessageInto(container, source.length ? "没有符合当前筛选的作品。" : emptyMessage, "quiet", false);
      return;
    }

    const grid = document.createElement("div");
    grid.className = `work-list${renderOptions.coverGrid ? " cover-grid" : ""}`;
    container.append(grid);
    let loadMore = null;
    if (visible.length < list.length) {
      loadMore = createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visible.length)} / ${formatNumber(list.length)}`, () => {
        increaseWorksLimit(40);
        return renderCurrentViewPreservingScroll();
      });
    } else if (renderOptions.hasServerMore && typeof renderOptions.onLoadMore === "function") {
      loadMore = createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visible.length)} / ${formatNumber(renderOptions.total || visible.length)}`, renderOptions.onLoadMore);
    }
    progressiveWorkListRenderer.render(grid, visible, (work) => workCards.createWorkCard(work, renderOptions), () => loadMore && container.append(loadMore));
  }

  function createLoadMoreButton(text, handler) {
    const wrap = document.createElement("div");
    wrap.className = "load-more";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    wrap.append(button);
    return enhanceAutoLoadMore(wrap, handler, {
      idleText: text,
      loadingText: "正在接着加载",
      retryText: "加载停住了，点一下重试",
      requireScrollIntent: true
    });
  }
  function renderMessage(message, tone = "quiet", replace = true) {
    renderMessageInto(els.viewContent, message, tone, replace);
  }
  function renderMessageInto(container, message, tone = "quiet", replace = true) {
    if (replace) container.innerHTML = "";
    const box = document.createElement("div");
    box.className = `message-box ${tone}`;
    box.textContent = message;
    container.append(box);
  }
  return {
    renderAllWorks,
    renderStudios,
    renderStudioDetail,
    renderContinuePreview,
    renderRankings,
    renderHistory,
    renderSearchResults,
    warmSearch: searchDataService.warm,
    pageDataService,
    workDetailDataService,
    getSortMode: (view) => view === "rankings" ? rankingViews.getSortMode() : workListState.getSortMode(),
    getSortOptions: (view) => workListState.getSortOptions({ allowRankingSort: view === "rankings" }),
    setSortMode: (view, value) => view === "rankings" ? rankingViews.setSortMode(value) : workListState.setSortMode(value),
    getWorkFilterMode: () => workListState.getFilterMode(),
    getWorkFilterOptions: (works, facets) => workListState.getFilterOptions(works, facets),
    setWorkFilterMode: (value, options = {}) => workListState.setFilterMode(value, options),
    getWorkListRequestState: () => ({ filter: workListState.getServerFilterMode(), sort: workListState.getServerSortMode() }),
    refreshRankingCache,
    renderWorks,
    createChip: workCards.createChip,
    createLoadMoreButton,
    renderMessage
  };
}


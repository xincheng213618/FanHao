import { fetchJson } from "../../js/api.js?v=20260702-novel-local-manage-74";
import { enhanceAutoLoadMore } from "../../js/auto-load.js?v=20260720-fanhao-scroll-intent-01";
import { cacheAgeText, readCachedJson, writeCachedJson } from "../../js/cache.js?v=20260702-novel-local-manage-74";
import { formatNumber } from "../../js/format.js";
import { createWorkListState } from "../../js/work-filtering.js?v=20260720-fanhao-combined-filter-01";
import { createWorkCards } from "./features/works/cards.js?v=20260717-fanhao-mobile-card-lifecycle-01";
import { createRankingViews } from "./features/rankings/ranking-views.js?v=20260717-fanhao-ranking-response-01";
import { createWorkPageDataService } from "./features/works/page-data-service.js?v=20260717-fanhao-page-race-01";
import { createWorkSearchDataService } from "./features/works/search-data-service.js?v=20260717-fanhao-search-response-01";
import { createWorkDetailDataService } from "./features/works/detail-data-service.js?v=20260717-fanhao-touch-intent-01";
import { createProgressiveWorkListRenderer } from "./features/works/progressive-list-renderer.js?v=20260717-fanhao-work-first-paint-01";

const CONTINUE_PREVIEW_DAYS = 30;
const CONTINUE_PREVIEW_LIMIT = 8;
function workDataSignature(data = {}) {
  const works = Array.isArray(data.works) ? data.works : [];
  const folders = Array.isArray(data.folders) ? data.folders : [];
  return JSON.stringify({
    total: Number(data.total || works.length),
    selectedFolderId: data.selectedFolderId || "",
    facets: data.facets || null,
    folders: folders.map((folder) => [folder.id || "", folder.name || "", folder.count || 0]),
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
    getWorksLimit,
    increaseWorksLimit,
    showView,
    setActiveBottom,
    renderCurrentView,
    renderCurrentViewPreservingScroll = renderCurrentView,
    isHomeView = () => false
  } = context;
  const renderFavoriteExtras = context.renderFavoriteExtras || (() => {});
  const workListState = createWorkListState({ renderCurrentView });
  let selectedFavoriteFolderId = "all";
  const pageDataService = createWorkPageDataService({ fetchJson, readCachedJson, writeCachedJson });
  const workDetailDataService = createWorkDetailDataService({ getActiveUrl, pageDataService });
  const workCards = createWorkCards({ getActiveUrl, roots: [els.viewContent, els.continuePreview], showView, workDetailDataService });
  const progressiveWorkListRenderer = createProgressiveWorkListRenderer();
  const searchDataService = createWorkSearchDataService({ getActiveUrl, getWorksLimit, pageDataService, workListState });
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

  async function renderWorkCollection(view, isActive = () => true) {
    leaveRankingSort();
    const isFavorites = view === "favorites";
    setActiveBottom(isFavorites ? "favorites" : "history");
    els.viewKicker.textContent = isFavorites ? "收藏" : "继续观看";
    els.viewTitle.textContent = isFavorites ? "已收藏作品" : "观看进度";
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载列表</div>`;
    const limit = getWorksLimit();
    const path = isFavorites ? favoriteCollectionPath(limit) : `/api/history?limit=${limit}&offset=0`;
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const applyCollectionHeader = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || data.count || works.length);
      if (isFavorites && data.selectedFolderId) selectedFavoriteFolderId = data.selectedFolderId;
      const folder = isFavorites ? favoriteFolderById(data.folders || [], selectedFavoriteFolderId) : null;
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewTitle.textContent = isFavorites && folder ? folder.name : isFavorites ? "已收藏作品" : "观看进度";
      els.viewMeta.textContent = isFavorites && folder
        ? `${formatNumber(works.length)} / ${formatNumber(folder.count || works.length)} 个作品${suffix}`
        : `${formatNumber(works.length)} / ${formatNumber(total)} 个作品${suffix}`;
    };

    const renderCollectionData = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || data.count || works.length);
      applyCollectionHeader(data, cacheEntry);
      els.viewContent.innerHTML = "";
      if (isFavorites) renderFavoriteFolderStrip(data.folders || []);
      if (isFavorites) renderFavoriteExtras();
      renderWorks(works, isFavorites ? "还没有收藏作品。" : "暂无继续观看记录。", {
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
          renderCollectionData(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      if (result.unchanged) {
        applyCollectionHeader(result.data);
        return;
      }
      renderCollectionData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存。", "quiet", false);
      } else {
        renderMessage(error.message, "error");
      }
    }
  }
  function favoriteCollectionPath(limit = getWorksLimit()) {
    const params = new URLSearchParams({ limit: String(limit), offset: "0" });
    if (selectedFavoriteFolderId && selectedFavoriteFolderId !== "all") params.set("folder", selectedFavoriteFolderId);
    return `/api/favorites?${params}`;
  }

  function favoriteFolderById(folders, folderId) {
    return (folders || []).find((folder) => folder.id === folderId) || null;
  }

  function favoriteFolderTotal(folders) {
    return (folders || []).reduce((sum, folder) => sum + Number(folder.count || 0), 0);
  }

  function renderFavoriteFolderStrip(folders) {
    if (!folders.length) return;

    const strip = document.createElement("div");
    strip.className = "favorite-folder-strip";
    strip.append(createFavoriteFolderChip("all", "全部", favoriteFolderTotal(folders)));

    for (const folder of folders) {
      strip.append(createFavoriteFolderChip(folder.id, folder.name, folder.count || 0));
    }

    els.viewContent.append(strip);
  }

  function createFavoriteFolderChip(folderId, name, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = selectedFavoriteFolderId === folderId ? "active" : "";
    button.textContent = name;
    button.title = `${name} · ${formatNumber(count || 0)}`;
    button.setAttribute("aria-label", `${name}，${formatNumber(count || 0)} 个作品`);
    button.addEventListener("click", () => {
      if (selectedFavoriteFolderId === folderId) return;
      selectedFavoriteFolderId = folderId;
      renderCurrentView();
    });
    return button;
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
        facets: data.facets,
        ...serverContinuationOptions(works, total, { activeFilterTotal: true })
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
          warmCatalogSibling(activeUrl, { limit, serverFilter, serverSort });
        }
      });
      if (!result || !isActive()) return;
      warmCatalogSibling(activeUrl, { limit, serverFilter, serverSort });
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

  async function renderVrWorks(isActive = () => true) {
    leaveRankingSort();
    setActiveBottom("works");
    els.viewKicker.textContent = "VR";
    els.viewTitle.textContent = "VR 作品";
    els.viewMeta.textContent = "正在加载";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载 VR 作品</div>`;

    const limit = getWorksLimit();
    const serverFilter = mergeServerFilters("vr", workListState.getServerFilterMode());
    const serverSort = workListState.getServerSortMode();
    const path = `/api/works?limit=${limit}&offset=0&sort=${encodeURIComponent(serverSort)}&filter=${encodeURIComponent(serverFilter)}`;
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const applyHeader = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(works.length)} / ${formatNumber(total)} 个 VR 作品${suffix}`;
    };

    const renderData = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || works.length);
      applyHeader(data, cacheEntry);
      els.viewContent.innerHTML = "";
      renderWorks(works, "没有 VR 作品。", {
        compactMeta: true,
        facets: data.facets,
        ...serverContinuationOptions(works, total, { activeFilterTotal: true })
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
          warmCatalogSibling(activeUrl, { limit, serverFilter, serverSort });
        }
      });
      if (!result || !isActive()) return;
      warmCatalogSibling(activeUrl, { limit, serverFilter, serverSort });
      if (result.unchanged) {
        applyHeader(result.data);
        return;
      }
      renderData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存 VR 作品。", "quiet", false);
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

  function mergeServerFilters(...values) {
    const filters = [];
    for (const value of values) {
      for (const item of String(value || "all").split(",")) {
        const clean = item.trim();
        if (clean && clean !== "all" && !filters.includes(clean)) filters.push(clean);
      }
    }
    return filters.length ? filters.join(",") : "all";
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
    leaveRankingSort();
    const text = query.trim();
    els.searchInput.value = text;
    setActiveBottom("search");
    els.viewKicker.textContent = "搜索";
    els.viewTitle.textContent = text ? `搜索：${text}` : "搜索番号库";
    els.viewMeta.textContent = text ? "正在搜索番号与人物" : "输入番号、作品标题或人物后搜索";
    els.contentPanel.hidden = false;

    if (!text) {
      renderMessage("可以搜索番号、作品标题、文件名或人物。", "quiet");
      return;
    }

    els.viewContent.innerHTML = `<div class="loading-row">正在搜索</div>`;
    const limit = getWorksLimit();
    const serverFilter = workListState.getFilterMode();
    const serverSort = workListState.getServerSortMode();
    const path = searchDataService.path(text, limit, serverFilter, serverSort);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderSearchData = (data, cacheEntry = null, headerOnly = false) => {
      const people = data.people || [];
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(total)} 个作品 · ${formatNumber(people.length)} 个人物${suffix}`;
      if (headerOnly) return;
      els.viewContent.innerHTML = "";
      renderSearchPeople(people);
      if (works.length || total || !people.length) {
        renderWorks(works, `没有搜到「${text}」。`, {
          facets: data.facets,
          ...serverContinuationOptions(works, total, { activeFilterTotal: true })
        });
      } else {
        renderMessage("没有匹配的番号作品，已显示人物结果。", "quiet", false);
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
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存搜索结果。", "quiet", false);
      } else {
        renderMessage(error.message, "error");
      }
    }
  }

  async function renderRankings(isActive = () => true) {
    return rankingViews.renderRankings(isActive);
  }

  function warmPrimaryCollections(activeUrl) {
    const limit = getWorksLimit();
    pageDataService.warm(activeUrl, [
      `/api/history?limit=${limit}&offset=0`,
      favoriteCollectionPath(limit)
    ]);
  }

  function warmCatalogSibling(activeUrl, { limit, serverFilter, serverSort }) {
    if (!["all", "vr"].includes(serverFilter)) return;
    const siblingFilter = serverFilter === "vr" ? "all" : "vr";
    pageDataService.warm(activeUrl, [
      `/api/works?limit=${limit}&offset=0&sort=${encodeURIComponent(serverSort)}&filter=${siblingFilter}`
    ]);
  }

  async function refreshRankingCache() {
    return rankingViews.refreshRankingCache();
  }

  function leaveRankingSort() {
    rankingViews.leaveRankingSort();
  }

  function serverContinuationOptions(works, total, options = {}) {
    return {
      total,
      activeFilterTotal: options.activeFilterTotal ? total : undefined,
      hasServerMore: works.length < total,
      onLoadMore() {
        increaseWorksLimit(48);
        return renderCurrentViewPreservingScroll();
      }
    };
  }

  function renderSearchPeople(people) {
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
    els.viewContent.append(panel);
  }

  function renderWorks(works, emptyMessage, options = {}) {
    if (!options.allowRankingSort) leaveRankingSort();
    progressiveWorkListRenderer.cancel();
    workCards.resetCoverLoading();
    const source = works || [];
    const list = workListState.visibleWorks(source, options);
    const visible = list.slice(0, getWorksLimit());
    els.viewContent.querySelector(".loading-row")?.remove();
    els.viewContent.append(workListState.createWorkControls(source, list, { ...options, displayedCount: visible.length }));

    if (!list.length) {
      renderMessage(source.length ? "没有符合当前筛选的作品。" : emptyMessage, "quiet", false);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "work-list";
    els.viewContent.append(grid);
    let loadMore = null;
    if (visible.length < list.length) {
      loadMore = createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visible.length)} / ${formatNumber(list.length)}`, () => {
        increaseWorksLimit(40);
        return renderCurrentViewPreservingScroll();
      });
    } else if (options.hasServerMore && typeof options.onLoadMore === "function") {
      loadMore = createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visible.length)} / ${formatNumber(options.total || visible.length)}`, options.onLoadMore);
    }
    progressiveWorkListRenderer.render(grid, visible, (work) => workCards.createWorkCard(work, options), () => loadMore && els.viewContent.append(loadMore));
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
    if (replace) els.viewContent.innerHTML = "";
    const box = document.createElement("div");
    box.className = `message-box ${tone}`;
    box.textContent = message;
    els.viewContent.append(box);
  }
  return {
    renderAllWorks,
    renderVrWorks,
    renderStudios,
    renderStudioDetail,
    renderContinuePreview,
    renderRankings,
    renderWorkCollection,
    renderSearchResults,
    warmSearch: searchDataService.warm,
    pageDataService,
    workDetailDataService,
    refreshRankingCache,
    renderWorks,
    createChip: workCards.createChip,
    createLoadMoreButton,
    renderMessage
  };
}


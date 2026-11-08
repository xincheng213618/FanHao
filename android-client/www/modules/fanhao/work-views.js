import { fetchJson } from "../../js/api.js?v=assets-0a663c3bea5d";
import { captureAccountOwner, isAccountOwnerCurrent } from "../../js/account-owner.js";
import { enhanceAutoLoadMore } from "../../js/auto-load.js?v=assets-0a663c3bea5d";
import { cacheAgeText, readCachedJson, writeCachedJson } from "../../js/cache.js?v=assets-0a663c3bea5d";
import { formatNumber } from "../../js/format.js";
import { createWorkListState } from "../../js/work-filtering.js?v=assets-0a663c3bea5d";
import { createWorkCards } from "./features/works/cards.js?v=assets-0a663c3bea5d";
import { workCollectionPath } from "./features/works/collection-request.js?v=assets-0a663c3bea5d";
import { createFavoriteWorkViews } from "./features/works/favorite-page.js?v=assets-0a663c3bea5d";
import { workDataSignature } from "./features/works/work-data-signature.js?v=assets-0a663c3bea5d";
import { createRankingViews } from "./features/rankings/ranking-views.js?v=assets-0a663c3bea5d";
import { createWorkPageDataService } from "./features/works/page-data-service.js?v=assets-0a663c3bea5d";
import { createWorkSearchDataService } from "./features/works/search-data-service.js?v=assets-0a663c3bea5d";
import { createWorkDetailDataService } from "./features/works/detail-data-service.js?v=assets-0a663c3bea5d";
import { createProgressiveWorkListRenderer } from "./features/works/progressive-list-renderer.js?v=assets-0a663c3bea5d";
import { mountSearchResultToolbar } from "./features/works/search-result-toolbar.js?v=assets-0a663c3bea5d";
import { createFanhaoSearchPage } from "./search-page.js?v=assets-0a663c3bea5d";
import { normalizeStudioSort, selectStudios, STUDIO_SORT_OPTIONS } from "./features/studios/index-model.js?v=assets-0a663c3bea5d";
import { createBrandModeSwitch } from "./features/brands/brand-switch.js?v=assets-0a663c3bea5d";
import { createCategoryViews } from "./features/categories/category-views.js?v=assets-0a663c3bea5d";
const CONTINUE_PREVIEW_DAYS = 30;
const CONTINUE_PREVIEW_LIMIT = 8;
const STUDIO_SORT_STORAGE_KEY = "fanhao.android.studioSort";
export function createWorkViews(context) {
  const {
    els,
    getActiveUrl,
    getLibrary = () => null,
    getCurrentParams = () => ({}),
    getCurrentView = () => "",
    getWorksLimit,
    getSearchFirstLimit = () => null,
    increaseWorksLimit,
    onUserStateChange,
    showView,
    replaceViewParams = () => false,
    goBack,
    setActiveBottom,
    refreshChrome = () => {},
    renderCurrentView,
    renderCurrentViewPreservingScroll = renderCurrentView,
    isHomeView = () => false
  } = context;
  const workListState = createWorkListState({ renderCurrentView });
  const searchListState = createWorkListState({ renderCurrentView, persist: false, initialFilterMode: "all", initialSortMode: "updated" });
  const pageDataService = createWorkPageDataService({ fetchJson, readCachedJson, writeCachedJson });
  const favoriteViews = createFavoriteWorkViews({ ...context, getLibrary, pageDataService, renderCurrentView,
    renderMessage, renderWorks, serverContinuationOptions, workDataSignature,
    initialSortMode: workListState.getSortMode() });
  const workDetailDataService = createWorkDetailDataService({ getActiveUrl, pageDataService });
  const workCards = createWorkCards({ getActiveUrl, roots: [els.viewContent, els.continuePreview], showView, workDetailDataService });
  const progressiveWorkListRenderer = createProgressiveWorkListRenderer();
  let mountedAllWorks = null;
  const searchDataService = createWorkSearchDataService({ getActiveUrl, getWorksLimit, pageDataService, workListState: searchListState });
  let activeSearchCategory = "censored";
  const searchPage = createFanhaoSearchPage({
    els,
    goBack,
    showView,
    preserveQuery: (query) => replaceViewParams("search", { query, category: activeSearchCategory }),
    getSearchParams: () => ({ category: activeSearchCategory }),
    warmSearch(query, { signal }) {
      const limit = getSearchFirstLimit();
      if (limit) return searchDataService.warm(query, activeSearchCategory, { limit, signal });
    },
    fetchSuggestions: (query, options = {}) => searchDataService.suggestions(query, { ...options, category: activeSearchCategory }),
    getActiveUrl,
    getLibrary
  });
  const rankingViews = createRankingViews({
    els,
    getActiveUrl,
    renderCurrentView,
    renderCurrentViewPreservingScroll,
    renderMessage,
    renderWorks,
    refreshChrome,
    setActiveBottom,
    workListState
  });
  const categoryViews = createCategoryViews({
    els, getActiveUrl, getWorksLimit, increaseWorksLimit, pageDataService,
    renderCurrentViewPreservingScroll, renderMessage, renderWorks, setActiveBottom,
    showView, workListState
  });
  let studioQuery = "";
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

  async function renderAllWorks(params = {}, isActive = () => true) {
    releaseAllWorks();
    if (String(params.favorite || "") === "1") {
      leaveRankingSort();
      return favoriteViews.render(params, isActive);
    }
    leaveRankingSort();
    setActiveBottom("works");
    els.viewKicker.textContent = "作品";
    els.viewTitle.textContent = "片库";
    els.viewMeta.textContent = "正在加载";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载作品</div>`;

    const activeUrl = getActiveUrl();
    const owner = {
      activeUrl, account: captureAccountOwner(activeUrl), isActive,
      params: JSON.stringify(getCurrentParams()), filter: workListState.getServerFilterMode(), sort: workListState.getServerSortMode(),
      life: new AbortController(), moreLife: null, data: null, visible: [], records: [],
      grid: null, controls: null, more: null, pending: null, retryLimit: null, request: 0, moreStep: 48, moreText: "",
      focusedMore: null, restoreMoreFocus: false, scrollRestore: null
    };
    mountedAllWorks = owner;
    owner.onAbort = () => releaseAllWorks(owner);
    isActive.signal?.addEventListener("abort", owner.onAbort, { once: true });
    const cancelScrollRestore = (event) => {
      if (event.type === "keydown" && (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
        || !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
        || event.target?.isContentEditable || event.target?.closest?.("input, textarea, select, [role='textbox']"))) return;
      owner.scrollRestore = null;
    };
    for (const type of ["wheel", "touchmove", "pointerdown"]) window.addEventListener(type, cancelScrollRestore, { passive: true, signal: owner.life.signal });
    window.addEventListener("keydown", cancelScrollRestore, { signal: owner.life.signal });
    document.addEventListener("focusin", (event) => {
      owner.focusedMore = event.target === owner.more?.querySelector("button") ? event.target : null;
      if (!owner.focusedMore) {
        owner.restoreMoreFocus = false;
        cancelScrollRestore(event);
      }
    }, { signal: owner.life.signal });
    owner.pending = loadAllWorks(owner, getWorksLimit(), true);
    return owner.pending;
  }

  function ownsAllWorks(owner) {
    return owner === mountedAllWorks && !owner.life.signal.aborted && owner.isActive()
      && owner.activeUrl === getActiveUrl() && isAccountOwnerCurrent(owner.account)
      && getCurrentView() === "works" && JSON.stringify(getCurrentParams()) === owner.params
      && workListState.getServerFilterMode() === owner.filter && workListState.getServerSortMode() === owner.sort;
  }

  function retireAllWorksPresentation(owner) {
    owner.moreLife?.abort();
    progressiveWorkListRenderer.cancel();
    workDetailDataService.cancelHover();
    workCards.resetCoverLoading();
    for (const record of owner.records) workCards.releaseWorkCard(record.card);
    owner.records = [];
    owner.visible = [];
    owner.data = null;
    owner.grid = owner.controls = owner.more = null;
    owner.moreText = "";
  }

  function releaseAllWorks(owner = mountedAllWorks) {
    if (!owner || owner !== mountedAllWorks) return;
    mountedAllWorks = null;
    owner.life.abort();
    owner.isActive.signal?.removeEventListener("abort", owner.onAbort);
    retireAllWorksPresentation(owner);
    owner.focusedMore = null;
    owner.restoreMoreFocus = false;
    owner.scrollRestore = null;
  }

  function applyAllWorksHeader(data, cacheEntry = null) {
    const works = data.works || [];
    const total = Number(data.total || works.length);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    els.viewMeta.textContent = `${formatNumber(works.length)} / ${formatNumber(total)} 个作品${suffix}`;
  }

  function allWorksOptions(owner, data) {
    const works = data.works || [];
    return {
      compactMeta: true, compactSummary: true, coverGrid: true, facets: data.facets,
      total: Number(data.total || works.length), hasServerMore: works.length < Number(data.total || works.length),
      onLoadMore: () => loadMoreAllWorks(owner),
      onVisibleMore: () => loadMoreAllWorks(owner),
      moreOptions: { signal: owner.moreLife.signal, getIdleText: () => owner.moreText },
      createControls(source, list, options) {
        const controls = workListState.createWorkControls(source, list, {
          ...options,
          onFilterChange(value) {
            if (ownsAllWorks(owner) && owner.controls === controls && controls.isConnected) workListState.setFilterMode(value);
          }
        });
        owner.controls = controls;
        return controls;
      },
      onCardCreated(card, work, index) {
        const current = owner.visible[index] || work;
        workCards.updateWorkCard(card, current);
        owner.records[index] = { card };
      },
      onComplete() {
        restoreAllWorksScroll(owner);
        syncAllWorksMore(owner);
        restoreAllWorksFocus(owner);
      }
    };
  }

  function syncAllWorksMore(owner) {
    if (!ownsAllWorks(owner) || !owner.more?.isConnected) return;
    const button = owner.more.querySelector("button");
    if (button) {
      button.disabled = Boolean(owner.pending);
      button.textContent = owner.pending ? "正在接着加载" : owner.moreText;
    }
  }

  function mountAllWorks(owner, data, cacheEntry = null) {
    if (owner.grid?.isConnected && owner.scrollRestore === null) owner.scrollRestore = window.scrollY;
    const restoreFocus = owner.restoreMoreFocus || allWorksMoreHasFocus(owner);
    retireAllWorksPresentation(owner);
    owner.restoreMoreFocus = restoreFocus;
    owner.data = data;
    owner.moreLife = new AbortController();
    els.viewContent.innerHTML = "";
    const rendered = renderWorks(data.works || [], "资料库里还没有作品。", allWorksOptions(owner, data));
    if (rendered) {
      owner.grid = rendered.grid;
      owner.more = rendered.more;
      owner.visible = rendered.visible;
      owner.moreStep = rendered.visible.length < rendered.listCount ? 40 : 48;
      owner.moreText = `向下滑动继续加载 ${formatNumber(rendered.visible.length)} / ${formatNumber(rendered.visible.length < rendered.listCount ? rendered.listCount : Number(data.total || (data.works || []).length))}`;
      if (owner.records.length === owner.visible.length) restoreAllWorksScroll(owner);
    } else {
      owner.scrollRestore = null;
    }
    applyAllWorksHeader(data, cacheEntry);
    syncAllWorksMore(owner);
  }

  function restoreAllWorksScroll(owner) {
    if (owner.scrollRestore === null || !ownsAllWorks(owner) || !owner.grid?.isConnected) return;
    const top = owner.scrollRestore;
    owner.scrollRestore = null;
    window.scrollTo({ top, behavior: "auto" });
  }

  function allWorksMoreHasFocus(owner) {
    const button = owner.more?.querySelector("button");
    return Boolean(button && (document.activeElement === button
      || document.activeElement === document.body && owner.focusedMore === button));
  }

  function restoreAllWorksFocus(owner) {
    if (!owner.restoreMoreFocus || !ownsAllWorks(owner)) return;
    if (!owner.more && owner.records.length !== owner.visible.length) return;
    if (document.activeElement === document.body) {
      const target = owner.more?.querySelector("button") || owner.records.at(-1)?.card;
      if (!target?.isConnected || target.disabled) return;
      target.focus({ preventScroll: true });
    }
    owner.restoreMoreFocus = false;
  }

  function sameWorkData(left, right) {
    try { return JSON.stringify(left) === JSON.stringify(right); }
    catch { return false; }
  }

  function appendMountedAllWorks(owner, data, cacheEntry = null) {
    if (!ownsAllWorks(owner) || !owner.grid?.isConnected || owner.grid.parentElement !== els.viewContent) return false;
    const works = data.works || [];
    const list = workListState.visibleWorks(works);
    const visible = list.slice(0, getWorksLimit());
    const needsMore = visible.length < list.length || works.length < Number(data.total || works.length);
    if (needsMore && (!owner.more || owner.moreLife.signal.aborted
      || owner.records.length === owner.visible.length && !owner.more.isConnected)) return false;
    if (!needsMore && owner.more && !owner.more.isConnected) return false;
    const keys = new Set();
    for (const work of visible) {
      const id = work?.id == null ? "" : String(work.id);
      if (!id || keys.has(id)) return false;
      keys.add(id);
    }
    if (visible.length < owner.visible.length || owner.visible.some((work, index) =>
      String(work?.id) !== String(visible[index]?.id) || !sameWorkData(work, visible[index]))) return false;
    const start = owner.visible.length;
    if (visible.length > start && (owner.records.length !== start || owner.grid.children.length !== start)) return false;
    if (owner.records.some((record, index) => record.card.parentElement !== owner.grid || owner.grid.children[index] !== record.card)) return false;

    const controlsUnchanged = sameWorkData(owner.data, data);
    const options = allWorksOptions(owner, data);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < owner.records.length; index++) workCards.updateWorkCard(owner.records[index].card, visible[index]);
    for (let index = start; index < visible.length; index++) {
      const card = workCards.createWorkCard(visible[index], options);
      owner.records[index] = { card };
      fragment.append(card);
    }
    owner.grid.append(fragment);
    owner.visible = visible;
    owner.data = data;
    owner.moreStep = visible.length < list.length ? 40 : 48;
    owner.moreText = `向下滑动继续加载 ${formatNumber(visible.length)} / ${formatNumber(visible.length < list.length ? list.length : Number(data.total || works.length))}`;
    if (!controlsUnchanged && owner.controls?.isConnected) {
      const old = owner.controls;
      const focus = [...old.querySelectorAll("button")].indexOf(document.activeElement);
      const scroll = old.querySelector(".work-filter-strip")?.scrollLeft || 0;
      const controls = options.createControls(works, list, options);
      old.replaceWith(controls);
      const strip = controls.querySelector(".work-filter-strip");
      if (strip) strip.scrollLeft = scroll;
      if (focus >= 0 && document.activeElement === document.body) controls.querySelectorAll("button")[focus]?.focus({ preventScroll: true });
    }
    if (visible.length >= list.length && works.length >= Number(data.total || works.length)) {
      const focused = allWorksMoreHasFocus(owner);
      owner.moreLife.abort();
      owner.more?.remove();
      owner.more = null;
      owner.restoreMoreFocus = focused;
      restoreAllWorksFocus(owner);
    }
    applyAllWorksHeader(data, cacheEntry);
    syncAllWorksMore(owner);
    return true;
  }

  function loadMoreAllWorks(owner) {
    if (!ownsAllWorks(owner) || !owner.grid?.isConnected || !owner.more?.isConnected) return;
    if (owner.pending) return owner.pending;
    owner.restoreMoreFocus = allWorksMoreHasFocus(owner);
    if (owner.retryLimit === null) {
      increaseWorksLimit(owner.moreStep);
      owner.retryLimit = getWorksLimit();
    }
    owner.pending = loadAllWorks(owner, owner.retryLimit, false);
    syncAllWorksMore(owner);
    return owner.pending;
  }

  async function loadAllWorks(owner, limit, initial) {
    const request = ++owner.request;
    const current = () => ownsAllWorks(owner) && owner.request === request;
    const path = `/api/works?limit=${limit}&offset=0&sort=${encodeURIComponent(owner.sort)}&filter=${encodeURIComponent(owner.filter)}`;
    let accepted = false;
    const publish = (data, cacheEntry = null) => {
      if (!current()) return;
      if (!appendMountedAllWorks(owner, data, cacheEntry)) mountAllWorks(owner, data, cacheEntry);
      accepted = true;
      owner.retryLimit = null;
    };
    try {
      const result = await pageDataService.load(owner.activeUrl, path, {
        signal: owner.life.signal,
        isActive: current,
        signature: workDataSignature,
        onCached(data, cacheEntry) {
          publish(data, cacheEntry);
        }
      });
      // Even the old coarse signature's unchanged response may contain a new
      // cover/person record. Validate the complete fresh prefix before reuse.
      if (result && current()) publish(result.data);
    } catch (error) {
      if (!current()) return;
      if (accepted) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存作品。", "quiet", false);
      } else if (initial) {
        renderMessage(error.message, "error");
      } else {
        throw error;
      }
    } finally {
      if (current()) {
        owner.pending = null;
        syncAllWorksMore(owner);
        restoreAllWorksFocus(owner);
      }
    }
  }

  async function renderStudios(isActive = () => true) {
    leaveRankingSort();
    setActiveBottom("works");
    els.viewKicker.textContent = "厂牌";
    els.viewTitle.textContent = "按片商浏览";
    els.viewMeta.textContent = "正在加载";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载片商</div>`;

    const path = "/api/studios?limit=500";
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderData = (data, cacheEntry = null, headerOnly = false) => {
      const studios = data.makers || [];
      const total = Number(data.total || studios.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      if (headerOnly) return;
      if (!studios.length) {
        els.viewMeta.textContent = `0 个片商${suffix}`;
        els.viewContent.innerHTML = "";
        renderMessage("还没有片商数据。", "quiet", false);
        return;
      }
      renderStudioIndex(studios, total, suffix);
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

  function renderCategories(category, isActive = () => true) {
    leaveRankingSort();
    return categoryViews.renderCategories(category, isActive);
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
    name.title = name.textContent;

    const meta = document.createElement("span");
    const localCount = Number(studio.localWorkCount || studio.workCount || 0);
    const activeYears = studioActiveYears(studio);
    meta.textContent = `${formatNumber(localCount)} 部${activeYears ? ` · ${activeYears}` : ""}`;
    button.setAttribute("aria-label", `${name.textContent}，${formatNumber(localCount)} 部作品${activeYears ? `，${activeYears}` : ""}`);

    button.append(name, meta);
    return button;
  }

  function renderStudioIndex(studios, total, suffix = "") {
    const toolbar = document.createElement("div");
    toolbar.className = "studio-index-tools";
    const search = document.createElement("div");
    search.className = "studio-index-search";
    search.setAttribute("role", "search");
    search.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.75" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const input = document.createElement("input");
    input.type = "search";
    input.autocomplete = "off";
    input.placeholder = "筛选片商名称";
    input.setAttribute("aria-label", "筛选片商名称");
    input.value = studioQuery;
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "studio-index-clear";
    clear.setAttribute("aria-label", "清除片商筛选");
    clear.textContent = "×";
    search.append(input, clear);

    const summary = document.createElement("output");
    summary.className = "studio-index-summary";
    summary.setAttribute("aria-live", "polite");
    const count = document.createElement("strong");
    const order = document.createElement("span");
    summary.append(count, order);
    toolbar.append(search, summary);
    const results = document.createElement("div");
    results.className = "studio-index-results";
    els.viewContent.replaceChildren(createBrandModeSwitch("studios", showView), toolbar, results);

    const paint = () => {
      const sortMode = getStudioSortMode();
      const visible = selectStudios(studios, { query: studioQuery, sort: sortMode });
      const sortLabel = studioSortDescription(sortMode);
      const countLabel = studioQuery
        ? `${formatNumber(visible.length)} / ${formatNumber(total)}`
        : studios.length === total
          ? formatNumber(total)
          : `${formatNumber(studios.length)} / ${formatNumber(total)}`;
      count.textContent = `${countLabel} 个`;
      order.textContent = sortLabel;
      clear.hidden = !studioQuery;
      els.viewMeta.textContent = `${countLabel} 个片商 · ${sortLabel}${suffix}`;
      results.replaceChildren();
      if (!visible.length) {
        renderMessageInto(results, `没有匹配「${studioQuery}」的片商。`, "quiet", false);
        return;
      }
      const grid = document.createElement("div");
      grid.className = "studio-list";
      const fragment = document.createDocumentFragment();
      for (const studio of visible) fragment.append(createStudioCard(studio));
      grid.append(fragment);
      results.append(grid);
    };

    input.addEventListener("input", () => {
      studioQuery = input.value.trim();
      paint();
    });
    clear.addEventListener("click", () => {
      studioQuery = "";
      input.value = "";
      paint();
      input.focus({ preventScroll: true });
    });
    paint();
  }

  function getStudioSortMode() {
    return normalizeStudioSort(localStorage.getItem(STUDIO_SORT_STORAGE_KEY));
  }

  function setStudioSortMode(value) {
    if (!STUDIO_SORT_OPTIONS.some((option) => option.value === value) || value === getStudioSortMode()) return false;
    localStorage.setItem(STUDIO_SORT_STORAGE_KEY, value);
    renderCurrentView();
    return true;
  }

  function studioSortDescription(mode) {
    return STUDIO_SORT_OPTIONS.find((option) => option.value === mode)?.description || STUDIO_SORT_OPTIONS[0].description;
  }

  function studioActiveYears(studio) {
    const first = String(studio.firstReleaseDate || "").slice(0, 4);
    const latest = String(studio.latestReleaseDate || "").slice(0, 4);
    if (first && latest && first !== latest) return `${first}–${latest}`;
    return latest || first;
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

  async function renderSearchResults(params = {}, isActive = () => true) {
    const text = String(params.query || "").trim();
    activeSearchCategory = normalizeSearchCategory(params.category);
    const libraryLabel = activeSearchCategory === "western" ? "欧美" : "番号";
    setActiveBottom("search");
    els.viewKicker.textContent = "搜索";
    els.viewTitle.textContent = text ? `搜索：${text}` : `搜索${libraryLabel}库`;
    els.viewMeta.textContent = text ? `正在搜索${libraryLabel}与演员` : "输入番号、作品标题或演员后搜索";
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
    const path = searchDataService.path(text, limit, serverFilter, serverSort, activeSearchCategory);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderSearchData = (data, cacheEntry = null, headerOnly = false) => {
      const people = data.people || [];
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(total)} 个作品 · ${formatNumber(people.length)} 位演员${suffix}`;
      if (headerOnly) return;
      results.innerHTML = "";
      searchPage.renderResultOverview(results, { query: text, total, people });
      if (works.length || total || !people.length) {
        renderWorks(works, `没有搜到「${text}」。`, {
          container: results,
          listState: searchListState,
          coverGrid: true,
          facets: data.facets,
          hideControls: true,
          ...serverContinuationOptions(works, total)
        });
      } else {
        renderMessageInto(results, "没有匹配的番号作品，已显示演员结果。", "quiet", false);
      }
      mountSearchResultToolbar({
        container: results, data, works, total, listState: searchListState
      });
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

  function renderWorks(works, emptyMessage, options = {}) {
    const { container = els.viewContent, listState = workListState, ...renderOptions } = options;
    if (!renderOptions.allowRankingSort && listState === workListState) leaveRankingSort();
    progressiveWorkListRenderer.cancel();
    workCards.resetCoverLoading();
    const source = works || [];
    const list = listState.visibleWorks(source, renderOptions);
    const visible = list.slice(0, getWorksLimit());
    container.querySelector(".loading-row")?.remove();
    let controls = null;
    if (renderOptions.hideControls !== true) {
      controls = renderOptions.createControls
        ? renderOptions.createControls(source, list, renderOptions)
        : listState.createWorkControls(source, list, renderOptions);
      container.append(controls);
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
        if (renderOptions.onVisibleMore) return renderOptions.onVisibleMore();
        increaseWorksLimit(40);
        return renderCurrentViewPreservingScroll();
      }, renderOptions.moreOptions);
    } else if (renderOptions.hasServerMore && typeof renderOptions.onLoadMore === "function") {
      loadMore = createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visible.length)} / ${formatNumber(renderOptions.total || visible.length)}`, renderOptions.onLoadMore, renderOptions.moreOptions);
    }
    progressiveWorkListRenderer.render(grid, visible, (work, index) => {
      const card = workCards.createWorkCard(work, renderOptions);
      renderOptions.onCardCreated?.(card, work, index);
      return card;
    }, () => {
      if (loadMore) container.append(loadMore);
      renderOptions.onComplete?.();
    });
    return { grid, controls, visible, more: loadMore, listCount: list.length };
  }
  function activeWorkListState() {
    return getCurrentView() === "works" && String(getCurrentParams()?.favorite || "") === "1"
      ? favoriteViews.listState
      : workListState;
  }

  function createLoadMoreButton(text, handler, options = {}) {
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
      requireScrollIntent: true,
      ...options
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
    releaseAllWorks,
    renderCategories,
    renderStudios,
    renderStudioDetail,
    renderContinuePreview,
    renderRankings,
    renderHistory,
    renderSearchResults,
    warmSearch: (query, category = "censored") => searchDataService.warm(query, normalizeSearchCategory(category)),
    pageDataService,
    favoriteFolders: favoriteViews.folders,
    workDetailDataService,
    getSortMode: (view) => view === "rankings" ? rankingViews.getSortMode() : activeWorkListState().getSortMode(),
    getSortOptions: (view) => activeWorkListState().getSortOptions({ allowRankingSort: view === "rankings" }),
    setSortMode: (view, value) => view === "rankings" ? rankingViews.setSortMode(value) : activeWorkListState().setSortMode(value),
    getRankingMenu: rankingViews.getYearMenu,
    getStudioSortMode,
    getStudioSortOptions: () => STUDIO_SORT_OPTIONS,
    setStudioSortMode,
    getWorkFilterMode: () => activeWorkListState().getFilterMode(),
    getWorkFilterOptions: (works, facets) => activeWorkListState().getFilterOptions(works, facets),
    setWorkFilterMode: (value, options = {}) => activeWorkListState().setFilterMode(value, options),
    getWorkListRequestState: () => ({ filter: activeWorkListState().getServerFilterMode(), sort: activeWorkListState().getServerSortMode() }),
    refreshRankingCache,
    renderWorks,
    createChip: workCards.createChip,
    createLoadMoreButton,
    renderMessage
  };
}

function normalizeSearchCategory(value) {
  return String(value || "").trim().toLowerCase() === "western" ? "western" : "censored";
}


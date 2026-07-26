import { createLatestRequestGate } from "../../latest-request.js?v=20260717-fanhao-latest-request-01";

const STUDIO_DESKTOP_PAGE_SIZE = 48;
const STUDIO_MOBILE_PAGE_SIZE = 32;
const STUDIO_PREFETCH_TTL_MS = 60 * 1000;
const STUDIO_PREFETCH_LIMIT = 16;
const STUDIO_INDEX_INITIAL_COUNT = 64;
const STUDIO_INDEX_BATCH_SIZE = 64;
const STUDIO_INDEX_BATCH_DELAY_MS = 16;

export function createStudioPage(deps) {
  const { api, appendLoadedWorkPage, appendEmpty, els, formatNumber, hidePersonProfile, renderStatsForWorks, renderWorks, resetWorkPaging, setMainHeader, state } = deps;
  const studioRequests = createLatestRequestGate();
  const studioPrefetches = new Map();
  let studioIndexRenderTimer = null;
  let studioIndexRenderSeq = 0;
  bindStudioIntentSurface(els.workGrid, ".studio-card", (studioId) => {
    globalThis.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
    loadStudioDetail(studioId);
  });
  bindStudioIntentSurface(els.statsRow, ".studio-series-chip", (studioId, seriesId) => {
    loadStudioDetail(studioId, seriesId);
  });

  function cancelPendingRequests() {
    studioRequests.cancel();
    studioPrefetches.clear();
    cancelIndexRendering();
  }

  function studioPageSize() {
    const viewportLimit = globalThis.matchMedia?.("(max-width: 720px)")?.matches
      ? STUDIO_MOBILE_PAGE_SIZE
      : STUDIO_DESKTOP_PAGE_SIZE;
    return Math.max(24, Math.min(viewportLimit, Number(state.workPageSize) || viewportLimit));
  }

  async function loadStudios() {
    cancelIndexRendering();
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
    cancelIndexRendering();
    const append = Boolean(options.append);
    const request = studioRequests.begin();
    if (!append) els.workGrid.innerHTML = `<div class="empty-state">正在加载片商作品</div>`;
    const path = studioDetailPath(studioId, seriesId, append ? state.works.length : 0);
    try {
      const data = await fetchStudioDetail(path, request, !append);
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
      if (append) appendLoadedWorkPage();
      else renderWorks("这个片商暂无本地作品。");
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

  function studioDetailPath(studioId, seriesId = "all", offset = 0) {
    const params = new URLSearchParams({
      seriesId,
      sort: state.sortMode || "releaseDesc",
      limit: String(studioPageSize()),
      offset: String(offset || 0)
    });
    return `/api/studios/${encodeURIComponent(studioId)}?${params}`;
  }

  function prefetchStudioDetail(studioId, seriesId = "all") {
    if (globalThis.navigator?.connection?.saveData) return null;
    const path = studioDetailPath(studioId, seriesId, 0);
    const now = Date.now();
    const cached = studioPrefetches.get(path);
    if (cached?.expiresAt > now) return cached.promise;
    if (cached) studioPrefetches.delete(path);
    const promise = api(path).then(
      (data) => ({ data, error: null }),
      (error) => ({ data: null, error })
    ).then((result) => {
      if (result.error) studioPrefetches.delete(path);
      return result;
    });
    studioPrefetches.set(path, { expiresAt: now + STUDIO_PREFETCH_TTL_MS, promise });
    while (studioPrefetches.size > STUDIO_PREFETCH_LIMIT) {
      studioPrefetches.delete(studioPrefetches.keys().next().value);
    }
    return promise;
  }

  async function fetchStudioDetail(path, request, allowPrefetch) {
    const prefetched = allowPrefetch ? studioPrefetches.get(path) : null;
    if (prefetched?.expiresAt > Date.now()) {
      studioPrefetches.delete(path);
      const result = await prefetched.promise;
      if (result.error) throw result.error;
      return result.data;
    }
    if (prefetched) studioPrefetches.delete(path);
    return api(path, { signal: request.signal });
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
    cancelIndexRendering();
    els.statsRow.innerHTML = "";
    els.workGrid.innerHTML = "";
    if (!state.studios.length) {
      appendEmpty("还没有片商数据。");
      return;
    }
    appendIndexBatch(state.studios, 0, studioIndexRenderSeq);
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
    button.className = `stat-filter-chip studio-series-chip${state.selectedStudioSeriesId === seriesId ? " active" : ""}`;
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

  return { cancelPendingRequests, loadStudios, loadMoreStudioWorks, loadStudioDetail };
}

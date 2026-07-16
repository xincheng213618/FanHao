import { fetchJson } from "../../../../js/api.js?v=20260702-novel-local-manage-74";
import { cacheAgeText, readCachedJson, writeCachedJson } from "../../../../js/cache.js?v=20260702-novel-local-manage-74";
import { formatDate, formatNumber } from "../../../../js/format.js";
import { absoluteUrl, imageUrlForWork, precacheImage } from "../../../../js/image.js";

const STORAGE_KEY = "fanhao.android.rankingKey";
const DEFAULT_KEY = "y2025";
const PAGE_SIZE = 80;
const IMAGE_CACHE_LIMIT = 48;
let requestedLimit = PAGE_SIZE;

export function createRankingViews(deps) {
  const { els, getActiveUrl, renderCurrentView, renderCurrentViewPreservingScroll, renderMessage, renderWorks, setActiveBottom, workListState } = deps;
  let lists = [];
  let selectedKey = readStoredKey();
  let filterMode = "all";
  let sortMode = "ranking";

  async function renderRankings(isActive = () => true) {
    setActiveBottom("rankings");
    els.viewKicker.textContent = "排行榜";
    els.viewTitle.textContent = "JavDB TOP250";
    els.viewMeta.textContent = "正在读取榜单";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载排行榜</div>`;
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderData = (summary, data, summaryCache = null, dataCache = null, options = {}) => {
      lists = summary?.lists || [];
      const dataKey = chooseKey(lists, rankingDataKey(data, selectedKey));
      const activeKey = options.displayKey === undefined ? dataKey : normalizeKey(options.displayKey);
      if (options.persistSelection !== false) {
        selectedKey = dataKey;
        localStorage.setItem(STORAGE_KEY, selectedKey);
      }
      const works = data?.works || [];
      const resultTotal = Number(data?.total || data?.rankingTotal || works.length);
      const suffix = dataCache ? ` · 缓存 ${cacheAgeText(dataCache.updatedAt)}` : "";
      els.viewTitle.textContent = data?.label || "JavDB TOP250";
      els.viewMeta.textContent = metaText(data, works.length, suffix);
      if (els.rankingsCount) els.rankingsCount.textContent = compactCount(data?.rankingTotal || data?.total || works.length);
      els.viewContent.innerHTML = "";
      els.viewContent.append(createPanel(data, summaryCache, activeKey));
      renderWorks(works, lists.length ? "这个榜单没有匹配项目。" : "还没有缓存排行榜。", {
        compactMeta: true,
        showRatingMeta: true,
        allowRankingSort: true,
        filterMode,
        sortMode,
        onFilterChange: setFilterMode,
        onSortChange: setSortMode,
        total: resultTotal,
        hasServerMore: works.length < resultTotal,
        onLoadMore: () => {
          requestedLimit = Math.min(resultTotal, requestedLimit + PAGE_SIZE);
          return renderCurrentViewPreservingScroll();
        }
      });
    };

    const cachedSummary = await readCachedJson(activeUrl, "/api/rankings").catch(() => null);
    const requestedKey = chooseKey(cachedSummary?.payload?.lists || [], selectedKey);
    const cachedData = await readCachedJson(activeUrl, topPath(requestedKey)).catch(() => null);
    if (!isActive()) return;
    if (cachedData?.payload) {
      renderedCache = true;
      renderData(cachedSummary?.payload || { lists: [] }, cachedData.payload, cachedSummary, cachedData);
    }
    try {
      const fresh = await fetchBundle(activeUrl, requestedKey, isActive.signal);
      if (!isActive()) return;
      renderData(fresh.summary, fresh.data);
      precacheImages(fresh.data?.works || [], activeUrl, isActive.signal).catch(() => {});
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存排行榜。", "quiet", false);
      } else {
        const fallback = await readFallback(activeUrl, cachedSummary, requestedKey);
        if (!isActive()) return;
        if (fallback?.data?.payload) {
          renderData(fallback.summary?.payload || { lists: [] }, fallback.data.payload, fallback.summary, fallback.data, {
            displayKey: rankingDataKey(fallback.data.payload, ""),
            persistSelection: false
          });
          renderMessage("当前榜单还没有缓存，已显示其它本地缓存排行榜。", "quiet", false);
        } else {
          renderMessage(error.message || "排行榜读取失败", "error");
        }
      }
    }
  }

  async function refreshRankingCache() {
    const activeUrl = getActiveUrl();
    const fresh = await fetchBundle(activeUrl, selectedKey);
    lists = fresh.summary?.lists || [];
    selectedKey = chooseKey(lists, rankingDataKey(fresh.data, selectedKey));
    localStorage.setItem(STORAGE_KEY, selectedKey);
    const cachedLists = await cacheLists(activeUrl, lists, selectedKey);
    const cachedImages = await precacheImages(fresh.data?.works || [], activeUrl);
    if (els.rankingsCount) els.rankingsCount.textContent = compactCount(fresh.data?.rankingTotal || fresh.data?.total || fresh.data?.works?.length || 0);
    return { ...fresh, cachedImages, cachedLists };
  }

  async function fetchBundle(activeUrl, preferredKey = selectedKey, signal = undefined) {
    const summary = await fetchJson(activeUrl, "/api/rankings", { timeoutMs: 12000, signal });
    await writeCachedJson(activeUrl, "/api/rankings", summary).catch(() => {});
    const key = chooseKey(summary.lists || [], preferredKey);
    const data = await fetchTop(activeUrl, key, signal);
    return { summary, data };
  }

  async function fetchTop(activeUrl, key, signal = undefined) {
    const path = topPath(key);
    const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal });
    await writeCachedJson(activeUrl, path, data).catch(() => {});
    return data;
  }

  async function cacheLists(activeUrl, items, alreadyCachedKey) {
    const seen = new Set();
    let cached = 0;
    const add = (key) => {
      const normalized = normalizeKey(key);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    };
    if (add(alreadyCachedKey)) cached += 1;
    for (const item of items || []) {
      const key = itemKey(item);
      if (!add(key)) continue;
      try {
        await fetchTop(activeUrl, key);
        cached += 1;
      } catch {}
    }
    return cached;
  }

  async function readFallback(activeUrl, summaryEntry = null, excludedKey = "") {
    const summary = summaryEntry || await readCachedJson(activeUrl, "/api/rankings").catch(() => null);
    for (const key of candidateKeys(summary?.payload?.lists || [])) {
      if (key === normalizeKey(excludedKey)) continue;
      const data = await readCachedJson(activeUrl, topPath(key)).catch(() => null);
      if (data?.payload) return { summary, data };
    }
    return null;
  }

  function createPanel(data = {}, summaryCache = null, activeKey = selectedKey) {
    const panel = document.createElement("div");
    panel.className = "ranking-panel";
    const stats = document.createElement("div");
    stats.className = "ranking-stats";
    for (const [label, value] of [["榜单", data.rankingTotal || data.total || 0], ["本地已有", data.localTotal || 0], ["未下载", data.missingTotal || 0]]) {
      const item = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = formatNumber(value);
      const span = document.createElement("span");
      span.textContent = label;
      item.append(strong, span);
      stats.append(item);
    }
    const chips = document.createElement("div");
    chips.className = "ranking-chip-strip";
    if (!lists.length) {
      const empty = document.createElement("span");
      empty.className = "ranking-empty-note";
      empty.textContent = summaryCache ? "缓存里暂时没有榜单摘要" : "后台刷新后会出现在这里";
      chips.append(empty);
    } else {
      for (const item of lists) {
        const button = document.createElement("button");
        button.type = "button";
        const key = itemKey(item);
        button.className = key === activeKey ? "active" : "";
        button.textContent = `${item.label || item.key || "榜单"} · 缺 ${formatNumber(item.missingTotal || 0)}`;
        button.addEventListener("click", () => {
          if (key === selectedKey && key === activeKey) return;
          selectedKey = key;
          requestedLimit = PAGE_SIZE;
          localStorage.setItem(STORAGE_KEY, selectedKey);
          renderCurrentView();
        });
        chips.append(button);
      }
    }
    panel.append(stats, chips);
    return panel;
  }

  function setFilterMode(value) {
    if (filterMode === value) return;
    filterMode = value;
    renderCurrentView();
  }

  function setSortMode(value) {
    if (sortMode === value) return;
    sortMode = value;
    renderCurrentView();
  }

  function leaveRankingSort() {
    requestedLimit = PAGE_SIZE;
    if (workListState.getSortMode() === "ranking") workListState.setSortMode("updated", { rerender: false });
  }

  return { leaveRankingSort, refreshRankingCache, renderRankings };
}

function chooseKey(lists = [], preferredKey = "") {
  if (preferredKey !== undefined && preferredKey !== null && hasKey(lists, preferredKey)) return normalizeKey(preferredKey);
  if (hasKey(lists, DEFAULT_KEY)) return DEFAULT_KEY;
  return lists.length ? itemKey(lists[0]) : normalizeKey(preferredKey);
}

function candidateKeys(lists = []) {
  const keys = [];
  const seen = new Set();
  for (const key of [DEFAULT_KEY, ...(lists || []).map(itemKey)]) {
    const normalized = normalizeKey(key);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      keys.push(normalized);
    }
  }
  return keys;
}

function hasKey(lists, key) {
  const normalized = normalizeKey(key);
  return (lists || []).some((item) => itemKey(item) === normalized);
}

function itemKey(item = {}) { return normalizeKey(item.key); }
function rankingDataKey(data, fallback = "") { return data && Object.hasOwn(data, "key") ? normalizeKey(data.key) : normalizeKey(fallback); }
function normalizeKey(key) { return key === undefined || key === null ? "" : String(key); }
function readStoredKey() { const stored = localStorage.getItem(STORAGE_KEY); return stored === null ? DEFAULT_KEY : stored; }
function topPath(key = "") { return `/api/rankings/top?${new URLSearchParams({ key, limit: String(requestedLimit), offset: "0" })}`; }
function compactCount(value) { const number = Number(value || 0); return number > 0 ? formatNumber(number) : "TOP"; }

function metaText(data = {}, visibleCount = 0, suffix = "") {
  const total = data.rankingTotal || data.total || visibleCount;
  const updated = data.updatedAt ? ` · 更新 ${formatDate(data.updatedAt) || data.updatedAt}` : "";
  return `${formatNumber(data.localTotal || 0)} 本地 / ${formatNumber(total)} 榜单 · 缺 ${formatNumber(data.missingTotal || 0)}${updated}${suffix}`;
}

async function precacheImages(works, activeUrl, signal = undefined) {
  const urls = [];
  const seen = new Set();
  for (const work of works || []) {
    const imagePath = imageUrlForWork(work);
    const url = imagePath ? absoluteUrl(activeUrl, imagePath) : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= IMAGE_CACHE_LIMIT) break;
  }
  let index = 0;
  let cached = 0;
  const workers = Array.from({ length: Math.min(4, urls.length) }, async () => {
    while (index < urls.length && !signal?.aborted) {
      const url = urls[index++];
      if (await precacheImage(url, { cacheBaseUrl: activeUrl, signal, timeoutMs: 5000 })) cached += 1;
    }
  });
  await Promise.all(workers);
  return cached;
}

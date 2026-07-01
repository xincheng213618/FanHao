import { fetchJson } from "./api.js?v=20260701-novel-reader-05";
import { enhanceAutoLoadMore } from "./auto-load.js?v=20260701-novel-reader-05";
import { cacheAgeText, readCachedJson, writeCachedJson } from "./cache.js?v=20260701-novel-reader-05";
import { formatBytes, formatDate, formatNumber } from "./format.js";
import { absoluteUrl, imageUrlForWork, loadPreviewImage, precacheImage } from "./image.js";
import { createWorkListState } from "./work-filtering.js";

const RANKING_KEY_STORAGE = "fanhao.android.rankingKey";
const DEFAULT_RANKING_KEY = "y2025";
const RANKING_LIMIT = 1000;
const RANKING_IMAGE_CACHE_LIMIT = 48;
const CONTINUE_PREVIEW_DAYS = 30;
const CONTINUE_PREVIEW_LIMIT = 8;
const SEARCH_CHANNELS = [
  { key: "photoCollections", label: "套图合集", mode: "photo", unit: "合集", params: { photoView: "collections" } },
  { key: "photo", label: "套图", mode: "photo", unit: "图包" },
  { key: "manga", label: "套图 · 韩漫", mode: "manga", unit: "部" },
  { key: "western", label: "欧美", mode: "western", unit: "视频" },
  { key: "movie", label: "电影", mode: "movie", unit: "影片" },
  { key: "tv", label: "电视剧", mode: "tv", unit: "集" }
];

export function createWorkViews(context) {
  const {
    els,
    getActiveUrl,
    getWorksLimit,
    increaseWorksLimit,
    showView,
    openInLibrary,
    setActiveBottom,
    renderCurrentView,
    renderCurrentViewPreservingScroll = renderCurrentView,
    isHomeView = () => false
  } = context;
  const renderFavoriteExtras = context.renderFavoriteExtras || (() => {});
  const workListState = createWorkListState({ renderCurrentView });
  let rankingLists = [];
  let selectedRankingKey = readStoredRankingKey();
  let rankingFilterMode = "all";
  let rankingSortMode = "ranking";
  let selectedFavoriteFolderId = "all";

  async function renderContinuePreview(options = {}) {
    if (!els.continuePreview || !els.continueSection) return;

    els.continuePreview.dataset.hasItems = "0";
    els.continuePreview.innerHTML = `<div class="loading-row">正在读取最近进度</div>`;
    els.continueSection.hidden = !isHomeView();
    const path = `/api/history?days=${CONTINUE_PREVIEW_DAYS}&limit=${CONTINUE_PREVIEW_LIMIT}`;
    const activeUrl = getActiveUrl();

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (cached?.payload) {
      renderContinueData(cached.payload);
      if (options.preferCache) return;
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 12000 });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      renderContinueData(data);
    } catch {
      if (!cached?.payload) {
        els.continuePreview.dataset.hasItems = "0";
        els.continuePreview.innerHTML = "";
        els.continueSection.hidden = true;
      }
    }
  }

  function renderContinueData(data) {
    const works = (data.works || []).filter((work) => progressPercent(work) > 0).slice(0, CONTINUE_PREVIEW_LIMIT);
    els.continuePreview.innerHTML = "";

    if (!works.length) {
      els.continueSection.hidden = true;
      return;
    }

    const list = document.createElement("div");
    list.className = "continue-list";
    for (const work of works) {
      const card = createWorkCard(work);
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
    const path = isFavorites ? favoriteCollectionPath() : "/api/history";
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderCollectionData = (data, cacheEntry = null) => {
      const works = data.works || [];
      if (isFavorites && data.selectedFolderId) selectedFavoriteFolderId = data.selectedFolderId;
      const folder = isFavorites ? favoriteFolderById(data.folders || [], selectedFavoriteFolderId) : null;
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewTitle.textContent = isFavorites && folder ? folder.name : isFavorites ? "已收藏作品" : "观看进度";
      els.viewMeta.textContent = isFavorites && folder
        ? `${formatNumber(works.length)} / ${formatNumber(folder.count || works.length)} 个作品${suffix}`
        : `${formatNumber(works.length)} 个作品${suffix}`;
      els.viewContent.innerHTML = "";
      if (isFavorites) renderFavoriteFolderStrip(data.folders || []);
      if (isFavorites) renderFavoriteExtras();
      renderWorks(works, isFavorites ? "还没有收藏作品。" : "暂无继续观看记录。");
    };

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload) {
      renderedCache = true;
      renderCollectionData(cached.payload, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 12000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderCollectionData(data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存。", "quiet", false);
      } else {
        renderMessage(error.message, "error");
      }
    }
  }

  function favoriteCollectionPath() {
    if (!selectedFavoriteFolderId || selectedFavoriteFolderId === "all") return "/api/favorites";
    return `/api/favorites?folder=${encodeURIComponent(selectedFavoriteFolderId)}`;
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

    const renderWorksData = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(works.length)} / ${formatNumber(total)} 个作品${suffix}`;
      els.viewContent.innerHTML = "";
      renderWorks(works, "资料库里还没有作品。", { compactMeta: true, facets: data.facets, total });
      if (works.length < total) {
        els.viewContent.append(createLoadMoreButton(`向下滑动继续加载 ${formatNumber(works.length)} / ${formatNumber(total)}`, () => {
          increaseWorksLimit(80);
          return renderCurrentViewPreservingScroll();
        }));
      }
    };

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload) {
      renderedCache = true;
      renderWorksData(cached.payload, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 12000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderWorksData(data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存作品。", "quiet", false);
      } else {
        renderMessage(error.message, "error");
      }
    }
  }

  async function renderSearchResults(query, isActive = () => true) {
    leaveRankingSort();
    const text = query.trim();
    els.searchInput.value = text;
    setActiveBottom("search");
    els.viewKicker.textContent = "搜索";
    els.viewTitle.textContent = text ? `搜索：${text}` : "搜索资料库";
    els.viewMeta.textContent = text ? "正在全库搜索" : "输入番号、标题、人物或频道内容后搜索";
    els.contentPanel.hidden = false;

    if (!text) {
      renderMessage("可以搜索番号、标题、文件名、人物、套图、漫画或媒体。", "quiet");
      return;
    }

    els.viewContent.innerHTML = `<div class="loading-row">正在搜索</div>`;
    const limit = getWorksLimit();
    const serverFilter = workListState.getFilterMode();
    const serverSort = workListState.getServerSortMode();
    const path = `/api/search?q=${encodeURIComponent(text)}&limit=${limit}&offset=0&sort=${encodeURIComponent(serverSort)}&filter=${encodeURIComponent(serverFilter)}`;
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderSearchData = (data, cacheEntry = null) => {
      const people = data.people || [];
      const works = data.works || [];
      const channels = data.channels || [];
      const channelTotal = channels.reduce((sum, item) => sum + Number(item.total || 0), 0);
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(total)} 个作品 · ${formatNumber(people.length)} 个人物 · ${formatNumber(channelTotal)} 个频道内容${suffix}`;
      els.viewContent.innerHTML = "";
      renderSearchPeople(people);
      renderChannelSearchResults(channels, text);
      const hasChannelResults = channels.some((channel) => (channel.items || []).length);
      const hasSideResults = people.length || hasChannelResults;
      if (works.length || total || !hasSideResults) {
        renderWorks(works, `没有搜到「${text}」。`, {
          facets: data.facets,
          total
        });
      } else {
        renderMessage("作品库没有匹配，已显示频道内容。", "quiet", false);
      }
      if (works.length < total) {
        els.viewContent.append(createLoadMoreButton(`向下滑动继续加载 ${formatNumber(works.length)} / ${formatNumber(total)}`, () => {
          increaseWorksLimit(80);
          return renderCurrentViewPreservingScroll();
        }));
      }
    };

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload) {
      renderedCache = true;
      renderSearchData(cached.payload, cached);
    }

    try {
      const data = await fetchSearchBundle(activeUrl, path, text, isActive.signal);
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderSearchData(data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存搜索结果。", "quiet", false);
      } else {
        renderMessage(error.message, "error");
      }
    }
  }

  async function fetchSearchBundle(activeUrl, path, query, signal = undefined) {
    const [worksData, channels] = await Promise.all([
      fetchJson(activeUrl, path, { timeoutMs: 12000, signal }),
      fetchChannelSearchResults(activeUrl, query, signal)
    ]);
    return { ...worksData, channels };
  }

  async function fetchChannelSearchResults(activeUrl, query, signal = undefined) {
    const results = await Promise.allSettled(
      SEARCH_CHANNELS.map(async (channel) => {
        const path = channelSearchPath(channel, query);
        const cached = await readCachedJson(activeUrl, path).catch(() => null);
        try {
          const data = await fetchJson(activeUrl, path, { timeoutMs: 12000, signal });
          writeCachedJson(activeUrl, path, data).catch(() => {});
          return { ...channel, ...data, fromCache: false };
        } catch (error) {
          if (cached?.payload) return { ...channel, ...cached.payload, fromCache: true };
          return { ...channel, error: error.message || "读取失败", items: [], total: 0, count: 0 };
        }
      })
    );
    return results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
      .filter((result) => result.error || Number(result.total || 0) > 0 || (result.items || []).length > 0);
  }

  function channelSearchPath(channel, query) {
    const params = new URLSearchParams({
      mode: channel.mode,
      q: query,
      limit: "8",
      offset: "0"
    });
    for (const [key, value] of Object.entries(channel.params || {})) {
      if (value !== undefined && value !== null && value !== "") params.set(key, value);
    }
    return `/api/image-library/items?${params}`;
  }

  async function renderRankings(isActive = () => true) {
    setActiveBottom("rankings");
    els.viewKicker.textContent = "排行榜";
    els.viewTitle.textContent = "JavDB TOP250";
    els.viewMeta.textContent = "正在读取榜单";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载排行榜</div>`;

    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderRankingData = (summary, data, summaryCache = null, dataCache = null, options = {}) => {
      rankingLists = summary?.lists || [];
      const dataKey = chooseRankingKey(rankingLists, rankingDataKey(data, selectedRankingKey));
      const activeRankingKey = options.displayKey === undefined ? dataKey : normalizeRankingKey(options.displayKey);
      if (options.persistSelection !== false) {
        selectedRankingKey = dataKey;
        localStorage.setItem(RANKING_KEY_STORAGE, selectedRankingKey);
      }

      const works = data?.works || [];
      const suffix = dataCache ? ` · 缓存 ${cacheAgeText(dataCache.updatedAt)}` : "";
      els.viewTitle.textContent = data?.label || "JavDB TOP250";
      els.viewMeta.textContent = rankingMetaText(data, works.length, suffix);
      if (els.rankingsCount) els.rankingsCount.textContent = formatCompactRankingCount(data?.rankingTotal || data?.total || works.length);
      els.viewContent.innerHTML = "";
      els.viewContent.append(createRankingPanel(data, summaryCache, activeRankingKey));
      renderWorks(works, rankingLists.length ? "这个榜单没有匹配项目。" : "还没有缓存排行榜。", {
        compactMeta: true,
        showRatingMeta: true,
        allowRankingSort: true,
        filterMode: rankingFilterMode,
        sortMode: rankingSortMode,
        onFilterChange: setRankingFilterMode,
        onSortChange: setRankingSortMode,
        total: data?.rankingTotal || data?.total || works.length
      });
    };

    const cachedSummary = await readCachedJson(activeUrl, "/api/rankings").catch(() => null);
    const requestedRankingKey = chooseRankingKey(cachedSummary?.payload?.lists || [], selectedRankingKey);
    const cachedData = await readCachedJson(activeUrl, rankingTopPath(requestedRankingKey)).catch(() => null);
    if (!isActive()) return;
    if (cachedData?.payload) {
      renderedCache = true;
      renderRankingData(cachedSummary?.payload || { lists: [] }, cachedData.payload, cachedSummary, cachedData);
    }

    try {
      const fresh = await fetchRankingBundle(activeUrl, requestedRankingKey, isActive.signal);
      if (!isActive()) return;
      renderRankingData(fresh.summary, fresh.data);
      precacheRankingImages(fresh.data?.works || [], activeUrl, isActive.signal).catch(() => {});
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存排行榜。", "quiet", false);
      } else {
        const fallback = await readCachedRankingFallback(activeUrl, cachedSummary, requestedRankingKey);
        if (!isActive()) return;
        if (fallback?.data?.payload) {
          renderRankingData(fallback.summary?.payload || { lists: [] }, fallback.data.payload, fallback.summary, fallback.data, {
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
    const fresh = await fetchRankingBundle(activeUrl, selectedRankingKey);
    rankingLists = fresh.summary?.lists || [];
    selectedRankingKey = chooseRankingKey(rankingLists, rankingDataKey(fresh.data, selectedRankingKey));
    localStorage.setItem(RANKING_KEY_STORAGE, selectedRankingKey);
    const cachedLists = await cacheRankingTopLists(activeUrl, rankingLists, selectedRankingKey);
    const cachedImages = await precacheRankingImages(fresh.data?.works || [], activeUrl);
    if (els.rankingsCount) els.rankingsCount.textContent = formatCompactRankingCount(fresh.data?.rankingTotal || fresh.data?.total || fresh.data?.works?.length || 0);
    return { ...fresh, cachedImages, cachedLists };
  }

  async function fetchRankingBundle(activeUrl, preferredKey = selectedRankingKey, signal = undefined) {
    const summary = await fetchJson(activeUrl, "/api/rankings", { timeoutMs: 12000, signal });
    await writeCachedJson(activeUrl, "/api/rankings", summary).catch(() => {});
    const key = chooseRankingKey(summary.lists || [], preferredKey);
    const data = await fetchRankingTop(activeUrl, key, signal);
    return { summary, data };
  }

  async function fetchRankingTop(activeUrl, key, signal = undefined) {
    const path = rankingTopPath(key);
    const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal });
    await writeCachedJson(activeUrl, path, data).catch(() => {});
    return data;
  }

  async function cacheRankingTopLists(activeUrl, lists, alreadyCachedKey) {
    const seen = new Set();
    let cached = 0;
    const addSeen = (key) => {
      const normalized = normalizeRankingKey(key);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    };

    if (addSeen(alreadyCachedKey)) cached += 1;

    for (const item of lists || []) {
      const key = rankingItemKey(item);
      if (!addSeen(key)) continue;
      try {
        await fetchRankingTop(activeUrl, key);
        cached += 1;
      } catch {
        // Keep the primary cache refresh useful even if one old ranking list fails.
      }
    }

    return cached;
  }

  async function readCachedRankingFallback(activeUrl, summaryEntry = null, excludedKey = "") {
    const summary = summaryEntry || await readCachedJson(activeUrl, "/api/rankings").catch(() => null);
    const lists = summary?.payload?.lists || [];
    const normalizedExcludedKey = normalizeRankingKey(excludedKey);
    for (const key of rankingCandidateKeys(lists)) {
      if (key === normalizedExcludedKey) continue;
      const data = await readCachedJson(activeUrl, rankingTopPath(key)).catch(() => null);
      if (data?.payload) return { summary, data };
    }
    return null;
  }

  function createRankingPanel(data = {}, summaryCache = null, activeRankingKey = selectedRankingKey) {
    const panel = document.createElement("div");
    panel.className = "ranking-panel";

    const stats = document.createElement("div");
    stats.className = "ranking-stats";
    const values = [
      ["榜单", data.rankingTotal || data.total || 0],
      ["本地已有", data.localTotal || 0],
      ["未下载", data.missingTotal || 0]
    ];
    for (const [label, value] of values) {
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
    if (!rankingLists.length) {
      const empty = document.createElement("span");
      empty.className = "ranking-empty-note";
      empty.textContent = summaryCache ? "缓存里暂时没有榜单摘要" : "后台刷新后会出现在这里";
      chips.append(empty);
    } else {
      for (const item of rankingLists) {
        const button = document.createElement("button");
        button.type = "button";
        const key = rankingItemKey(item);
        button.className = key === activeRankingKey ? "active" : "";
        const missing = Number(item.missingTotal || 0);
        button.textContent = `${item.label || item.key || "榜单"} · 缺 ${formatNumber(missing)}`;
        button.addEventListener("click", () => {
          if (key === selectedRankingKey && key === activeRankingKey) return;
          selectedRankingKey = key;
          localStorage.setItem(RANKING_KEY_STORAGE, selectedRankingKey);
          renderCurrentView();
        });
        chips.append(button);
      }
    }

    panel.append(stats, chips);
    return panel;
  }

  function chooseRankingKey(lists = [], preferredKey = selectedRankingKey) {
    if (preferredKey !== undefined && preferredKey !== null && rankingListHasKey(lists, preferredKey)) {
      return normalizeRankingKey(preferredKey);
    }
    if (rankingListHasKey(lists, DEFAULT_RANKING_KEY)) return DEFAULT_RANKING_KEY;
    if (lists.length) return rankingItemKey(lists[0]);
    return normalizeRankingKey(preferredKey);
  }

  function rankingCandidateKeys(lists = [], preferredKey = selectedRankingKey) {
    const keys = [];
    const seen = new Set();
    const add = (key) => {
      const normalized = normalizeRankingKey(key);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      keys.push(normalized);
    };

    if (preferredKey !== undefined && preferredKey !== null) add(preferredKey);
    if (rankingListHasKey(lists, DEFAULT_RANKING_KEY)) add(DEFAULT_RANKING_KEY);
    for (const item of lists || []) add(rankingItemKey(item));
    return keys;
  }

  function rankingListHasKey(lists = [], key) {
    const normalized = normalizeRankingKey(key);
    return (lists || []).some((item) => rankingItemKey(item) === normalized);
  }

  function rankingItemKey(item = {}) {
    return normalizeRankingKey(item.key);
  }

  function rankingDataKey(data = null, fallback = "") {
    return data && Object.prototype.hasOwnProperty.call(data, "key")
      ? normalizeRankingKey(data.key)
      : normalizeRankingKey(fallback);
  }

  function normalizeRankingKey(key) {
    return key === undefined || key === null ? "" : String(key);
  }

  function readStoredRankingKey() {
    const stored = localStorage.getItem(RANKING_KEY_STORAGE);
    return stored === null ? DEFAULT_RANKING_KEY : stored;
  }

  function rankingTopPath(key = selectedRankingKey) {
    const params = new URLSearchParams({
      key: key || "",
      limit: String(RANKING_LIMIT),
      offset: "0"
    });
    return `/api/rankings/top?${params}`;
  }

  function rankingMetaText(data = {}, visibleCount = 0, suffix = "") {
    const total = data.rankingTotal || data.total || visibleCount;
    const local = data.localTotal || 0;
    const missing = data.missingTotal || 0;
    const updated = data.updatedAt ? ` · 更新 ${formatDate(data.updatedAt) || data.updatedAt}` : "";
    return `${formatNumber(local)} 本地 / ${formatNumber(total)} 榜单 · 缺 ${formatNumber(missing)}${updated}${suffix}`;
  }

  function formatCompactRankingCount(value) {
    const number = Number(value || 0);
    return number > 0 ? formatNumber(number) : "TOP";
  }

  function leaveRankingSort() {
    if (workListState.getSortMode() === "ranking") {
      workListState.setSortMode("updated", { rerender: false });
    }
  }

  function setRankingFilterMode(value) {
    if (rankingFilterMode === value) return;
    rankingFilterMode = value;
    renderCurrentView();
  }

  function setRankingSortMode(value) {
    if (rankingSortMode === value) return;
    rankingSortMode = value;
    renderCurrentView();
  }

  async function precacheRankingImages(works, activeUrl, signal = undefined) {
    const urls = [];
    const seen = new Set();
    for (const work of works || []) {
      const imagePath = imageUrlForWork(work);
      if (!imagePath) continue;
      const url = absoluteUrl(activeUrl, imagePath);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= RANKING_IMAGE_CACHE_LIMIT) break;
    }

    let index = 0;
    let cached = 0;
    const workerCount = Math.min(4, urls.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (index < urls.length && !signal?.aborted) {
        const url = urls[index];
        index += 1;
        const entry = await precacheImage(url, { cacheBaseUrl: activeUrl, signal, timeoutMs: 5000 });
        if (entry) cached += 1;
      }
    });
    await Promise.all(workers);
    return cached;
  }

  function renderSearchPeople(people) {
    if (!people.length) return;

    const panel = document.createElement("div");
    panel.className = "chip-panel";
    for (const person of people.slice(0, 12)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "person-chip";
      chip.textContent = `${displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
      chip.addEventListener("click", () => showView("personDetail", { personId: person.id }, { push: true }));
      panel.append(chip);
    }
    els.viewContent.append(panel);
  }

  function renderChannelSearchResults(channels, query) {
    const visibleChannels = (channels || []).filter((channel) => channel.error || (channel.items || []).length);
    if (!visibleChannels.length) return;

    const wrap = document.createElement("section");
    wrap.className = "global-search-panel";
    const head = document.createElement("div");
    head.className = "global-search-head";
    const title = document.createElement("strong");
    title.textContent = "频道内容";
    const meta = document.createElement("span");
    const total = channels.reduce((sum, channel) => sum + Number(channel.total || 0), 0);
    meta.textContent = `${formatNumber(total)} 个匹配`;
    head.append(title, meta);
    wrap.append(head);

    for (const channel of visibleChannels) {
      wrap.append(createChannelSearchSection(channel, query));
    }
    els.viewContent.append(wrap);
  }

  function createChannelSearchSection(channel, query) {
    const section = document.createElement("div");
    section.className = "global-search-section";

    const head = document.createElement("div");
    head.className = "global-search-section-head";
    const title = document.createElement("strong");
    title.textContent = channel.label;
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = channel.fromCache ? "缓存" : `${formatNumber(channel.total || 0)} ${channel.unit || "项"}`;
    open.addEventListener("click", () => openChannelSearch(channel, query));
    head.append(title, open);
    section.append(head);

    if (channel.error) {
      const error = document.createElement("div");
      error.className = "global-search-error";
      error.textContent = channel.error;
      section.append(error);
      return section;
    }

    const row = document.createElement("div");
    row.className = "global-search-row";
    for (const item of (channel.items || []).slice(0, 8)) {
      row.append(createChannelSearchCard(channel, item));
    }
    section.append(row);
    return section;
  }

  function createChannelSearchCard(channel, item) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `global-result-card ${channel.mode}`;
    card.addEventListener("click", () => openChannelSearchItem(channel, item));

    const thumb = document.createElement("div");
    thumb.className = "global-result-thumb";
    thumb.textContent = thumbFallbackText(item.title || channel.label);
    const cover = item.coverUrl ? absoluteUrl(getActiveUrl(), item.coverUrl) : "";
    if (cover) loadPreviewImage(thumb, cover, { cacheBaseUrl: getActiveUrl() });

    const title = document.createElement("strong");
    title.textContent = item.title || item.collectionTitle || channel.label;
    const meta = document.createElement("span");
    meta.textContent = channelSearchItemMeta(channel, item);
    card.append(thumb, title, meta);
    return card;
  }

  function channelSearchItemMeta(channel, item) {
    if (item.type === "photoCollection") {
      return [hasNumber(item.albumCount) ? `${formatNumber(item.albumCount)} 期` : "", formatBytes(item.size)].filter(Boolean).join(" · ");
    }
    if (channel.mode === "photo") return [item.category, item.personName, formatBytes(item.size)].filter(Boolean).join(" · ");
    if (channel.mode === "manga") {
      return [
        hasNumber(item.chapterCount) ? `${formatNumber(item.chapterCount)} 话` : "",
        hasNumber(item.imageCount) ? `${formatNumber(item.imageCount)} 张` : ""
      ].filter(Boolean).join(" · ");
    }
    return [item.category, item.seriesName || item.personName, formatBytes(item.size)].filter(Boolean).join(" · ");
  }

  function hasNumber(value) {
    return value !== undefined && value !== null && value !== "";
  }

  function openChannelSearch(channel, query) {
    const params = { mode: channel.mode, query };
    if (channel.params?.photoView) params.photoView = channel.params.photoView;
    showView("channel", params, { push: true });
  }

  function openChannelSearchItem(channel, item) {
    if (item.type === "photoCollection") {
      showView("channel", { mode: "photo", collection: item.collectionId || item.id }, { push: true });
      return;
    }
    if (channel.mode === "photo" && item.id) {
      showView("photoDetail", { id: item.id }, { push: true });
      return;
    }
    if (channel.mode === "manga" && item.id) {
      showView("mangaDetail", { id: item.id }, { push: true });
      return;
    }
    if (["western", "movie", "tv"].includes(channel.mode) && item.id) {
      showView("mediaDetail", { id: item.id }, { push: true });
      return;
    }
    if (item.routePath) openInLibrary(item.routePath);
  }

  function thumbFallbackText(value) {
    return String(value || "?").trim().slice(0, 2) || "?";
  }

  function renderWorks(works, emptyMessage, options = {}) {
    if (!options.allowRankingSort) leaveRankingSort();
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
    for (const work of visible) grid.append(createWorkCard(work, options));
    els.viewContent.append(grid);

    if (visible.length < list.length) {
      els.viewContent.append(createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visible.length)} / ${formatNumber(list.length)}`, () => {
        increaseWorksLimit(40);
        return renderCurrentViewPreservingScroll();
      }));
    }
  }

  function numericRating(value) {
    if (value === null || value === undefined || value === "") return null;
    const rating = Number(value);
    return Number.isFinite(rating) ? rating : null;
  }

  function decorateWorkFallbackThumb(thumb, work) {
    const code = workCode(work);
    const label = code || thumbFallbackText(workPersonName(work) || displayWorkTitle(work, true));
    const meta = workThumbMeta(work);

    thumb.classList.add("fallback-cover");
    thumb.textContent = "";

    const codeLine = document.createElement("strong");
    codeLine.className = "work-thumb-code";
    codeLine.textContent = label;
    thumb.append(codeLine);

    if (meta) {
      const metaLine = document.createElement("span");
      metaLine.className = "work-thumb-meta";
      metaLine.textContent = meta;
      thumb.append(metaLine);
    }
  }

  function workThumbMeta(work) {
    const date = displayCardDate(work.infoSummary?.releaseDate || work.modifiedAt);
    const year = /^(\d{4})/.exec(date || "")?.[1] || "";
    const rating = numericRating(work.infoSummary?.rating);
    const percent = progressPercent(work);
    const parts = [];

    if (year) parts.push(year);
    if (rating !== null) parts.push(`${formatCompactRating(rating)}分`);
    if (rating === null && percent) parts.push(`已看 ${displayPercent(percent)}%`);
    if (work.missingLocal) parts.push("未下载");

    return parts.slice(0, 2).join(" · ");
  }

  function formatCompactRating(value) {
    const rating = Number(value);
    if (!Number.isFinite(rating)) return "";
    return Number.isInteger(rating) ? rating.toFixed(1) : rating.toFixed(2).replace(/0$/u, "");
  }

  function createWorkCard(work, options = {}) {
    const compactMeta = Boolean(options.compactMeta);
    const showRatingMeta = Boolean(options.showRatingMeta);
    const card = document.createElement("article");
    card.className = `work-card${work.missingLocal ? " missing-local" : ""}`;
    card.role = "button";
    card.tabIndex = 0;
    card.addEventListener("click", () => openWorkCard(work));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openWorkCard(work);
    });

    const imagePath = imageUrlForWork(work);
    const thumb = document.createElement("div");
    thumb.className = "work-thumb";
    decorateWorkFallbackThumb(thumb, work);
    if (imagePath) {
      const activeUrl = getActiveUrl();
      loadPreviewImage(thumb, absoluteUrl(activeUrl, imagePath), { cacheBaseUrl: activeUrl });
    }

    const body = document.createElement("div");
    body.className = "work-summary";

    const title = document.createElement("strong");
    title.className = "work-card-title";
    title.textContent = displayWorkTitle(work, compactMeta);
    const primaryFacts = createWorkPrimaryFacts(work);

    const person = document.createElement(work.personId ? "button" : "span");
    person.className = "work-person";
    person.textContent = workPersonName(work) || "未知人物";
    if (work.personId) {
      person.type = "button";
      person.addEventListener("click", (event) => {
        event.stopPropagation();
        showView("personDetail", { personId: work.personId }, { push: true });
      });
    }

    const percent = progressPercent(work);
    let chips = null;
    if (!compactMeta || showRatingMeta) {
      chips = document.createElement("div");
      chips.className = "work-chips";
      if (work.ranking?.rankNo) chips.append(createChip(`TOP ${formatNumber(work.ranking.rankNo)}`, "rank"));
      if (work.missingLocal) chips.append(createChip("未下载", "missing"));
      if (!compactMeta && work.favorite) chips.append(createChip("已收藏", "favorite"));
      if (!primaryFacts && work.infoSummary?.rating) {
        const count = work.infoSummary.ratingCount ? ` · ${formatNumber(work.infoSummary.ratingCount)} 人` : "";
        chips.append(createChip(`★ ${work.infoSummary.rating}${count}`, "rating"));
      }
    }

    body.append(title, person);
    if (primaryFacts) body.append(primaryFacts);
    if (!compactMeta && percent) body.append(createProgressMeter(work.progress, percent));
    if (chips?.children.length) body.append(chips);
    card.append(thumb, body);
    return card;
  }

  function openWorkCard(work) {
    if (work.missingLocal) {
      if (work.javdbUrl) window.open(work.javdbUrl, "_blank", "noreferrer");
      return;
    }
    showView("workDetail", { workId: work.id }, { push: true });
  }

  function workPersonName(work) {
    return work?.personDisplayName || work?.personName || "";
  }

  function displayPersonName(person) {
    return person?.actorProfile?.displayName || person?.name || "";
  }

  function createWorkPrimaryFacts(work) {
    const rating = numericRating(work.infoSummary?.rating);
    const date = displayCardDate(work.infoSummary?.releaseDate) || displayCardDate(work.modifiedAt) || (work.missingLocal ? "未下载" : "日期未知");

    const wrap = document.createElement("div");
    wrap.className = "work-card-facts";

    const ratingLine = document.createElement("div");
    ratingLine.className = `work-card-rating-line${rating === null ? " empty" : ""}`;
    const stars = document.createElement("span");
    stars.className = "work-card-stars";
    stars.textContent = ratingStars(rating || 0);
    const text = document.createElement("span");
    text.className = "work-card-rating-text";
    if (rating !== null) {
      const count = Number(work.infoSummary?.ratingCount || 0);
      const ratingText = Number.isInteger(rating) ? rating.toFixed(1) : String(rating);
      text.textContent = count ? `${ratingText}分 · ${formatNumber(count)}人` : `${ratingText}分`;
    } else {
      text.textContent = "暂无评分";
    }
    ratingLine.append(stars, text);
    wrap.append(ratingLine);

    if (date) {
      const dateLine = document.createElement("div");
      dateLine.className = "work-card-date";
      dateLine.textContent = date;
      wrap.append(dateLine);
    }

    return wrap;
  }

  function ratingStars(value) {
    const rating = Math.max(0, Math.min(5, Number(value || 0)));
    const full = Math.round(rating);
    return `${"★".repeat(full)}${"☆".repeat(5 - full)}`;
  }

  function displayCardDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    return formatDate(raw);
  }

  function displayWorkTitle(work, compactMeta) {
    const rawTitle = work.title || work.directoryName || "未命名作品";
    if (!compactMeta) return rawTitle;

    let cleaned = String(rawTitle).trim();
    for (let index = 0; index < 4; index += 1) {
      const previous = cleaned;
      cleaned = cleaned
        .replace(/^\[[^\]]+\][\s._-]*/u, "")
        .replace(/^【[^】]+】[\s._-]*/u, "")
        .replace(/^[A-Z]{2,10}[\s._-]*\d{2,6}[A-Z]?[\s._-]*/iu, "")
        .replace(/^[\s._\-:：・]+/u, "")
        .trim();
      if (cleaned === previous) break;
    }
    cleaned = cleaned.replace(/\s*生写真\d+枚セット\s*$/u, "").trim();
    return cleaned || rawTitle;
  }

  function workCode(work) {
    const candidates = [
      work?.infoSummary?.code,
      work?.code,
      work?.directoryName,
      work?.title,
      work?.relativePath
    ];

    for (const candidate of candidates) {
      const code = extractWorkCode(candidate);
      if (code) return code;
    }

    return "";
  }

  function extractWorkCode(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const match = /(?:^|[^A-Z0-9])([A-Z]{2,10})[\s._-]*(\d{2,6}[A-Z]?)(?=$|[^A-Z0-9])/iu.exec(text);
    if (!match) return "";
    return `${match[1].toUpperCase()}-${match[2].toUpperCase()}`;
  }

  function createChip(text, variant = "") {
    const chip = document.createElement("span");
    chip.className = `mini-chip${variant ? ` ${variant}` : ""}`;
    chip.textContent = text;
    return chip;
  }

  function createProgressMeter(progress, percent) {
    const meter = document.createElement("div");
    meter.className = "work-progress";

    const meta = document.createElement("div");
    meta.className = "work-progress-meta";

    const label = document.createElement("span");
    label.textContent = percent >= 98 ? "接近看完" : `已看 ${displayPercent(percent)}%`;

    const updated = document.createElement("span");
    updated.textContent = formatProgressTime(progress?.updatedAt);

    meta.append(label, updated);

    const track = document.createElement("div");
    track.className = "work-progress-track";
    const bar = document.createElement("span");
    bar.style.width = `${Math.min(100, Math.max(3, percent))}%`;
    track.append(bar);

    meter.append(meta, track);
    return meter;
  }

  function progressPercent(work) {
    const percent = Number(work?.progress?.percent || 0);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    return Math.max(0, Math.min(100, percent));
  }

  function displayPercent(percent) {
    if (percent <= 0) return 0;
    return Math.max(1, Math.min(100, Math.floor(percent)));
  }

  function formatProgressTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    if (diff >= 0 && diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;

    const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    if (date.toDateString() === now.toDateString()) return `今天 ${time}`;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;

    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
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
      retryText: "加载停住了，点一下重试"
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
    renderContinuePreview,
    renderRankings,
    renderWorkCollection,
    renderSearchResults,
    refreshRankingCache,
    renderWorks,
    createChip,
    createLoadMoreButton,
    renderMessage
  };
}




import { createWeightedCacheBudget } from "../works/work-cache-budget.js";
import { deriveWorkTraits, summarizeWorkTraits } from "../../../../../lib/work-traits.js";

const COLLECTION_PAGE_CACHE_LIMIT = 64;
const COLLECTION_PAGE_WORK_BUDGET = 4096;
const COLLECTION_QUERY_WORK_BUDGET = 50_000;
const COLLECTION_QUERY_CACHE_LIMIT = 32;
const COLLECTION_QUERY_KEY_LIMIT = 1024;
const COLLECTION_WORK_CACHE_LIMIT = 4096;
const COLLECTION_PREWARM_PAGE_SIZES = [8, 48, 64];

export function createCollectionQueryService({
  clampInteger,
  favoriteStateService,
  filterWorkList = (works) => works,
  getLibrary,
  maxWorkLimit,
  playbackProgressService,
  prewarmCoreWorkCovers,
  prewarmRemoteImagesForWorks,
  prewarmVideoProbesForWorks,
  prewarmWorkInfoDetails,
  publicWork,
  recentWatchedDays,
  sortWorkList = (works) => works,
  userStateStamp = () => "",
  withWorkInfoReadStatus = null,
  workInfoReadCacheable = () => true,
  workFacets = (works) => ({ all: works.length }),
  workInfoFacetRow = () => null,
  workQueryStamp = () => ""
}) {
  const queryBudget = createWeightedCacheBudget(COLLECTION_QUERY_WORK_BUDGET, COLLECTION_QUERY_CACHE_LIMIT);
  const queryCache = new Map();
  const historyPageWindows = new WeakMap();
  const pageBudget = createWeightedCacheBudget(COLLECTION_PAGE_WORK_BUDGET);
  let cacheStamp = "";
  let pageCache = new Map();
  let workPayloadCache = new Map();

  function favoritesPayload(url) {
    return readWorkInfo(() => readFavoritesPayload(url)).value;
  }

  function readWorkInfo(callback) {
    return withWorkInfoReadStatus ? withWorkInfoReadStatus(callback) : { value: callback(), cacheable: true };
  }

  function readFavoritesPayload(url) {
    const rawFolderId = url.searchParams.get("folder") || "";
    const selectedFolderId = rawFolderId ? favoriteStateService.normalizeFavoriteFolderId(rawFolderId) : "";
    const limit = clampInteger(url.searchParams.get("limit"), 0, 0, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const filter = requestFilter(url);
    const sort = requestSort(url);
    const cacheKey = `favorites:${selectedFolderId || "all"}:${filter}:${sort}:${limit}:${offset}`;
    const cached = readPage(cacheKey);
    if (cached) return cached;

    const queried = preparedQuery(["favorites", selectedFolderId, filter, sort],
      () => favoriteStateService.favoriteWorks(selectedFolderId), { filter, sort });
    const page = limit ? queried.works.slice(offset, offset + limit) : queried.works.slice(offset);
    const works = preparePage(page);
    return cachePage(cacheKey, {
      count: works.length,
      total: queried.works.length,
      limit,
      offset,
      filter,
      sort,
      works,
      traitFacets: queried.traitFacets,
      facets: queried.facets,
      folders: favoriteStateService.publicFavoriteFolders(),
      selectedFolderId: selectedFolderId || "all"
    });
  }

  function historyPayload(url) {
    return readWorkInfo(() => readHistoryPayload(url)).value;
  }

  function readHistoryPayload(url) {
    const rawDays = String(url.searchParams.get("days") || "").trim().toLowerCase();
    const days = rawDays && rawDays !== "all" ? clampInteger(rawDays, 0, 1, 3650) : 0;
    const limit = clampInteger(url.searchParams.get("limit"), 0, 0, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const filter = requestFilter(url);
    const sort = requestSort(url);
    const cacheKey = `history:${days}:${filter}:${sort}:${limit}:${offset}`;
    const now = days ? Date.now() : 0;
    const cached = readPage(cacheKey);
    if (cached) {
      const window = historyPageWindows.get(cached);
      if (!window || currentHistoryWindow(window, now)) return cached;
      pageBudget.drop(pageCache, cacheKey);
    }

    const loadSource = () => playbackProgressService.historyEntries({ days }).map((entry) => entry.work);
    // Providers without a timed snapshot keep their existing per-page reads.
    let queried;
    if (!days) queried = preparedQuery(["history", filter, sort], loadSource, { filter, sort });
    else if (typeof playbackProgressService.historySnapshot === "function") queried = preparedHistoryQuery(days, { filter, sort }, now);
    else queried = queryWorks(loadSource(), { filter, sort });
    const page = limit ? queried.works.slice(offset, offset + limit) : queried.works.slice(offset);
    const works = preparePage(page);
    const payload = {
      count: works.length,
      total: queried.works.length,
      days,
      limit,
      offset,
      filter,
      sort,
      recentWatchedDays,
      works,
      traitFacets: queried.traitFacets,
      facets: queried.facets
    };
    if (queried.historyWindow) {
      historyPageWindows.set(payload, queried.historyWindow);
      if (!currentHistoryWindow(queried.historyWindow, Date.now())) return payload;
    }
    return cachePage(cacheKey, payload);
  }

  function currentHistoryWindow(window, now) {
    return Number.isFinite(now) && Number.isFinite(window.observedAt)
      && (Number.isFinite(window.expiresAt) || window.expiresAt === Infinity)
      && now >= window.observedAt && now <= window.expiresAt;
  }

  function preparedHistoryQuery(days, options, now) {
    ensureCache();
    const key = JSON.stringify(["history", days, options.filter, options.sort]);
    const cached = queryBudget.read(queryCache, key);
    if (cached) {
      if (currentHistoryWindow(cached.historyWindow, now)) return cached;
      queryBudget.drop(queryCache, key);
    }
    const snapshot = playbackProgressService.historySnapshot({ days });
    const result = queryWorks(snapshot.entries.map(entry => entry.work), options);
    result.historyWindow = { observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt };
    if (key.length <= COLLECTION_QUERY_KEY_LIMIT && workInfoReadCacheable() !== false
      && currentHistoryWindow(result.historyWindow, Date.now())) {
      queryBudget.write(queryCache, key, result, result.works.length);
    }
    return result;
  }

  function preparedQuery(parts, loadSource, options) {
    ensureCache();
    const key = JSON.stringify(parts);
    const cached = queryBudget.read(queryCache, key);
    if (cached) return cached;
    const result = queryWorks(loadSource(), options);
    if (key.length <= COLLECTION_QUERY_KEY_LIMIT && workInfoReadCacheable() !== false) {
      queryBudget.write(queryCache, key, result, result.works.length);
    }
    return result;
  }

  function queryWorks(sourceWorks, { filter, sort }) {
    const source = Array.isArray(sourceWorks) ? sourceWorks : [];
    const filtered = filterWorkList(source, filter);
    return {
      works: sort ? sortWorkList(filtered, sort) : filtered,
      traitFacets: summarizeWorkTraits(filtered, (work) => deriveWorkTraits(work, workInfoFacetRow(work.id) || {})),
      facets: workFacets(source)
    };
  }

  function requestFilter(url) {
    return String(url.searchParams.get("filter") || "all").trim() || "all";
  }

  function requestSort(url) {
    return String(url.searchParams.get("sort") || "").trim();
  }

  function preparePage(sourceWorks) {
    ensureCache();
    const source = Array.isArray(sourceWorks) ? sourceWorks : [];
    const missing = source.filter((work) => {
      const key = String(work?.id || "");
      return !key || !workPayloadCache.has(key);
    });
    if (missing.length) {
      prewarmCollectionWorkPage(missing, {
        prewarmCoreWorkCovers,
        prewarmVideoProbesForWorks,
        prewarmWorkInfoDetails
      });
    }

    const works = source.map((work) => preparedWork(work));
    prewarmRemoteImagesForWorks(works);
    return works;
  }

  function preparedWork(work) {
    const key = String(work?.id || "");
    if (key && workPayloadCache.has(key)) {
      const cached = workPayloadCache.get(key);
      workPayloadCache.delete(key);
      workPayloadCache.set(key, cached);
      return cached;
    }

    const result = readWorkInfo(() => publicWork(work));
    const payload = result.value;
    if (!key || result.cacheable === false) return payload;
    workPayloadCache.set(key, payload);
    while (workPayloadCache.size > COLLECTION_WORK_CACHE_LIMIT) {
      workPayloadCache.delete(workPayloadCache.keys().next().value);
    }
    return payload;
  }

  function readPage(cacheKey) {
    ensureCache();
    return pageBudget.read(pageCache, cacheKey) || null;
  }

  function cachePage(cacheKey, payload) {
    if (workInfoReadCacheable() === false) return payload;
    ensureCache();
    return pageBudget.write(pageCache, cacheKey, payload, payload.works.length, COLLECTION_PAGE_CACHE_LIMIT);
  }

  function ensureCache() {
    const library = getLibrary();
    const nextStamp = `${library.scannedAt || ""}:${library.worksById?.size || 0}:${workQueryStamp()}:${userStateStamp()}`;
    if (cacheStamp === nextStamp) return;
    cacheStamp = nextStamp;
    pageBudget.clear();
    queryBudget.clear();
    pageCache = new Map();
    workPayloadCache = new Map();
  }

  function prewarm() {
    return readWorkInfo(prewarmCollection).value;
  }

  function prewarmCollection() {
    const historyDays = [...new Set([0, 7, Number(recentWatchedDays || 0)].filter((days) => days >= 0))];
    for (const limit of COLLECTION_PREWARM_PAGE_SIZES) {
      favoritesPayload(new URL(`http://fanhao.local/api/favorites?limit=${limit}&offset=0`));
      for (const days of historyDays) {
        const query = days ? `days=${days}&` : "";
        historyPayload(new URL(`http://fanhao.local/api/history?${query}limit=${limit}&offset=0`));
      }
    }
  }

  return {
    favoritesPayload,
    historyPayload,
    prewarm
  };
}

export function prepareCollectionWorkPage(sourceWorks, {
  prewarmCoreWorkCovers = () => {},
  prewarmRemoteImagesForWorks = () => {},
  prewarmVideoProbesForWorks = () => {},
  prewarmWorkInfoDetails = () => {},
  publicWork
}) {
  const page = prewarmCollectionWorkPage(sourceWorks, {
    prewarmCoreWorkCovers,
    prewarmVideoProbesForWorks,
    prewarmWorkInfoDetails
  });
  const works = page.map((work) => publicWork(work));
  prewarmRemoteImagesForWorks(works);
  return works;
}

export function prewarmCollectionWorkPage(sourceWorks, {
  prewarmCoreWorkCovers = () => {},
  prewarmVideoProbesForWorks = () => {},
  prewarmWorkInfoDetails = () => {}
}) {
  const page = Array.isArray(sourceWorks) ? sourceWorks : [];
  prewarmCoreWorkCovers(page);
  prewarmVideoProbesForWorks(page);
  prewarmWorkInfoDetails(page);
  return page;
}

const COLLECTION_PAGE_CACHE_LIMIT = 64;
const COLLECTION_WORK_CACHE_LIMIT = 4096;
const COLLECTION_PREWARM_PAGE_SIZES = [8, 48, 64];

export function createCollectionQueryService({
  clampInteger,
  favoriteStateService,
  getLibrary,
  maxWorkLimit,
  playbackProgressService,
  prewarmCoreWorkCovers,
  prewarmRemoteImagesForWorks,
  prewarmVideoProbesForWorks,
  prewarmWorkInfoDetails,
  publicWork,
  recentWatchedDays,
  userStateStamp = () => "",
  workQueryStamp = () => ""
}) {
  let cacheStamp = "";
  let pageCache = new Map();
  let workPayloadCache = new Map();

  function favoritesPayload(url) {
    const rawFolderId = url.searchParams.get("folder") || "";
    const selectedFolderId = rawFolderId ? favoriteStateService.normalizeFavoriteFolderId(rawFolderId) : "";
    const limit = clampInteger(url.searchParams.get("limit"), 0, 0, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const cacheKey = `favorites:${selectedFolderId || "all"}:${limit}:${offset}`;
    const cached = readPage(cacheKey);
    if (cached) return cached;

    const allWorks = favoriteStateService.favoriteWorks(selectedFolderId);
    const page = limit ? allWorks.slice(offset, offset + limit) : allWorks.slice(offset);
    const works = preparePage(page);
    return cachePage(cacheKey, {
      count: works.length,
      total: allWorks.length,
      limit,
      offset,
      works,
      folders: favoriteStateService.publicFavoriteFolders(),
      selectedFolderId: selectedFolderId || "all"
    });
  }

  function historyPayload(url) {
    const rawDays = String(url.searchParams.get("days") || "").trim().toLowerCase();
    const days = rawDays && rawDays !== "all" ? clampInteger(rawDays, 0, 1, 3650) : 0;
    const limit = clampInteger(url.searchParams.get("limit"), 0, 0, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const cacheKey = `history:${days}:${limit}:${offset}`;
    const cached = readPage(cacheKey);
    if (cached) return cached;

    const entries = playbackProgressService.historyEntries({ days });
    const page = limit ? entries.slice(offset, offset + limit) : entries.slice(offset);
    const works = preparePage(page.map((entry) => entry.work));
    return cachePage(cacheKey, {
      count: works.length,
      total: entries.length,
      days,
      limit,
      offset,
      recentWatchedDays,
      works
    });
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

    const payload = publicWork(work);
    if (!key) return payload;
    workPayloadCache.set(key, payload);
    while (workPayloadCache.size > COLLECTION_WORK_CACHE_LIMIT) {
      workPayloadCache.delete(workPayloadCache.keys().next().value);
    }
    return payload;
  }

  function readPage(cacheKey) {
    ensureCache();
    if (!pageCache.has(cacheKey)) return null;
    const cached = pageCache.get(cacheKey);
    pageCache.delete(cacheKey);
    pageCache.set(cacheKey, cached);
    return cached;
  }

  function cachePage(cacheKey, payload) {
    ensureCache();
    pageCache.set(cacheKey, payload);
    while (pageCache.size > COLLECTION_PAGE_CACHE_LIMIT) {
      pageCache.delete(pageCache.keys().next().value);
    }
    return payload;
  }

  function ensureCache() {
    const library = getLibrary();
    const nextStamp = `${library.scannedAt || ""}:${library.worksById?.size || 0}:${workQueryStamp()}:${userStateStamp()}`;
    if (cacheStamp === nextStamp) return;
    cacheStamp = nextStamp;
    pageCache = new Map();
    workPayloadCache = new Map();
  }

  function prewarm() {
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

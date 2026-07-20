const LIST_PAGE_CACHE_LIMIT = 96;
const SEARCH_PAGE_CACHE_LIMIT = 192;
const WORK_PAYLOAD_CACHE_LIMIT = 4096;
const PREWARM_PAGE_SIZES = [48, 64];
const LEGACY_MOBILE_PROGRESS_LIMIT = 720;
const LEGACY_MOBILE_PREWARM_BATCH_SIZE = 48;
const LEGACY_MOBILE_PREWARM_DELAY_MS = 500;

export function createWorkQueryService({
  actorMovieStamp,
  actorMissingSearchWorks,
  clampInteger,
  createWorkSearchMatcher,
  dedupeWorksForDisplay,
  defaultWorkLimit,
  enrichLocalWorksWithActorMovieIndex,
  fastMissingCodeSearch,
  favoriteStateService,
  hydrateMissingSearchWorks = () => {},
  isVrWork,
  library,
  localSearchWorkByCodeKey,
  localWorksByCodePrefix,
  maxWorkLimit,
  peoplePayloadStamp = () => "",
  peopleScopeService,
  playbackProgressService,
  prewarmCoreWorkCovers = () => {},
  prewarmLocalWorkCodeKeys,
  prewarmPersonMerge = () => {},
  prewarmWorkSearch = () => {},
  prewarmWorkInfoDetails = () => {},
  prewarmRemoteImagesForWorks,
  prewarmVideoProbesForWorks = () => {},
  publicPerson,
  publicWork,
  publicWorkAvailability,
  rankingMissingSearchWorks,
  scheduleBackground = (callback, delay = 0) => setTimeout(callback, delay),
  searchPeople,
  storedWorkCodeKey,
  userStateStamp = () => "",
  workHasCoreCover,
  workHasLocalMarker,
  workInfoFacetRow,
  workQueryStamp,
  workClassificationService = {
    filterForRequest: (works) => works,
    visibilityStamp: () => ""
  },
}) {
  let enrichedWorksCache = null;
  const listSourceCache = new Map();
  let listPageCache = new Map();
  let listPageCacheStamp = "";
  let workPayloadCache = new Map();
  let workPayloadCacheStamp = "";
  const searchSourceCache = new Map();
  let searchSourceCacheStamp = "";
  let searchPageCache = new Map();
  let searchPageCacheStamp = "";
  const cacheableFilters = new Set([
    "all",
    "favorite",
    "hasMagnet",
    "highRating",
    "info",
    "localMarkedA",
    "localOnly",
    "missingCover",
    "missingLocal",
    "playable",
    "progress",
    "rated",
    "vr"
  ]);
  const userStateFilters = new Set(["favorite", "progress"]);
  let staticFacetCache = new WeakMap();
  let dynamicFacetCache = new WeakMap();
  let sortedWorksCache = new WeakMap();
  const workCodeCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function currentStamp() {
    return `${library.scannedAt || ""}:${library.worksById.size}:${workQueryStamp()}:${workClassificationService.visibilityStamp()}`;
  }

  function listResponseStamp() {
    return `${currentStamp()}:${actorMovieStamp()}:${peoplePayloadStamp()}:${userStateStamp()}`;
  }

  function allWorks() {
    return [...library.worksById.values()];
  }

  function enrichedWorks() {
    const stamp = `${library.scannedAt || ""}:${library.worksById.size}:${actorMovieStamp()}`;
    if (enrichedWorksCache?.stamp === stamp) return enrichedWorksCache.works;
    const works = enrichLocalWorksWithActorMovieIndex(allWorks());
    enrichedWorksCache = { stamp, works };
    return works;
  }

  function workMatchesFilter(work, filter) {
    switch (filter) {
      case "localOnly":
        return !work.missingLocal;
      case "missingLocal":
        return Boolean(work.missingLocal);
      case "playable":
        return Number(work.playableCount || 0) > 0;
      case "favorite":
        return favoriteStateService.isFavoriteWork(work.id);
      case "progress":
        return Boolean(playbackProgressService.getWorkProgress(work));
      case "info":
        return Boolean(workInfoFacetRow(work.id)) || Number(work.infoCount || 0) > 0;
      case "rated":
        return workListRating(work) !== null;
      case "highRating": {
        const rating = workListRating(work);
        return rating !== null && rating >= 4;
      }
      case "vr":
        return isVrWork(work);
      case "localMarkedA":
        return workHasLocalMarker(work, "A");
      case "hasMagnet":
        return Boolean(work.missingLocal && publicWorkAvailability(work).hasMagnet);
      case "missingCover":
        if (work.missingLocal) return false;
        return !work.coverId && !workHasCoreCover(work.id);
      case "all":
      default:
        return true;
    }
  }

  function sortWorkList(works, sort, options = {}) {
    const stamp = currentStamp();
    const cacheKey = `${sort}:${options.lightweightInfo ? "light" : "full"}`;
    const cachedBySort = sortedWorksCache.get(works);
    const cached = cachedBySort?.get(cacheKey);
    if (cached?.stamp === stamp) return cached.works;

    const list = [...works];
    const usesMetadata = [
      "releaseDesc",
      "releaseAsc",
      "ratingAsc",
      "ratingDesc",
      "duration",
      "durationDesc",
      "durationAsc",
      "codeAsc",
      "codeDesc"
    ].includes(sort);
    const metadataByWork = usesMetadata
      ? new Map(list.map((work) => [work, workSortMetadata(work, options)]))
      : null;
    list.sort((a, b) => {
      const aMetadata = metadataByWork?.get(a);
      const bMetadata = metadataByWork?.get(b);
      if (sort === "releaseDesc" || sort === "releaseAsc") {
        const aDate = aMetadata.releaseDate;
        const bDate = bMetadata.releaseDate;
        const aHas = Boolean(aDate);
        const bHas = Boolean(bDate);
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aDate !== bDate) return sort === "releaseAsc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
      }

      if (sort === "ratingAsc" || sort === "ratingDesc") {
        const aRating = aMetadata.rating;
        const bRating = bMetadata.rating;
        const aHas = aRating !== null;
        const bHas = bRating !== null;
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aHas && aRating !== bRating) return sort === "ratingAsc" ? aRating - bRating : bRating - aRating;
        const countDiff = bMetadata.ratingCount - aMetadata.ratingCount;
        if (countDiff) return countDiff;
      }

      if (sort === "size" || sort === "sizeDesc" || sort === "sizeAsc") {
        const aSize = (a.videos || []).reduce((sum, video) => sum + Number(video.size || 0), 0);
        const bSize = (b.videos || []).reduce((sum, video) => sum + Number(video.size || 0), 0);
        if (aSize !== bSize) return sort === "sizeAsc" ? aSize - bSize : bSize - aSize;
      }

      if (sort === "duration" || sort === "durationDesc" || sort === "durationAsc") {
        const aDuration = aMetadata.duration;
        const bDuration = bMetadata.duration;
        if (aDuration !== bDuration) return sort === "durationAsc" ? aDuration - bDuration : bDuration - aDuration;
      }

      if (sort === "codeAsc" || sort === "codeDesc") {
        const result = workCodeCollator.compare(aMetadata.code, bMetadata.code);
        if (result) return sort === "codeDesc" ? -result : result;
      }

      return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
    });
    const nextCachedBySort = cachedBySort || new Map();
    nextCachedBySort.set(cacheKey, { stamp, works: list });
    if (!cachedBySort) sortedWorksCache.set(works, nextCachedBySort);
    return list;
  }

  function numericSummaryRating(work) {
    return optionalNumber(work.infoSummary?.rating);
  }

  function optionalNumber(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === "") continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function workListRating(work) {
    return optionalNumber(workInfoFacetRow(work.id)?.rating, work.infoSummary?.rating);
  }

  function workSortMetadata(work, options = {}) {
    const infoRow = options.lightweightInfo ? null : workInfoFacetRow(work.id);
    return {
      releaseDate: String(infoRow?.release_date || work.infoSummary?.releaseDate || ""),
      rating: optionalNumber(infoRow?.rating, work.infoSummary?.rating),
      ratingCount: optionalNumber(infoRow?.rating_count, work.infoSummary?.ratingCount) || 0,
      duration: optionalNumber(infoRow?.duration_minutes, work.infoSummary?.durationMinutes) || 0,
      code: infoRow?.code || work.infoSummary?.code || work.title || work.directoryName || ""
    };
  }

  function lightweightWorkMatchesFilter(work, filter) {
    switch (filter) {
      case "localOnly": return !work.missingLocal;
      case "missingLocal": return Boolean(work.missingLocal);
      case "playable": return Number(work.playableCount || 0) > 0;
      case "favorite": return favoriteStateService.isFavoriteWork(work.id);
      case "progress": return Boolean(playbackProgressService.getWorkProgress(work));
      case "info": return Boolean(work.infoSummary) || Number(work.infoCount || 0) > 0;
      case "rated": return numericSummaryRating(work) !== null;
      case "highRating": return (numericSummaryRating(work) ?? -Infinity) >= 4;
      case "vr": return isVrWork(work);
      case "localMarkedA": return workHasLocalMarker(work, "A");
      case "hasMagnet": return Boolean(work.missingLocal && work.infoSummary?.hasMagnet);
      case "missingCover": return !work.coverId && !work.remoteCoverUrl && !work.searchHasCover && !work.infoSummary?.imageUrl;
      case "all":
      default: return true;
    }
  }

  function staticWorkFacets(works) {
    const stamp = currentStamp();
    const cached = staticFacetCache.get(works);
    if (cached?.stamp === stamp) return cached.facets;

    const facets = {
      all: works.length,
      playable: 0,
      info: 0,
      localOnly: 0,
      missingLocal: 0,
      rated: 0,
      highRating: 0,
      vr: 0,
      hasMagnet: 0,
      missingCover: 0
    };

    for (const work of works) {
      const missingLocal = Boolean(work.missingLocal);
      const infoRow = workInfoFacetRow(work.id);
      const rating = optionalNumber(infoRow?.rating, work.infoSummary?.rating);
      if (Number(work.playableCount || 0) > 0) facets.playable += 1;
      if (infoRow || Number(work.infoCount || 0) > 0) facets.info += 1;
      if (missingLocal) facets.missingLocal += 1;
      else facets.localOnly += 1;
      if (rating !== null) facets.rated += 1;
      if (rating !== null && rating >= 4) facets.highRating += 1;
      if (isVrWork(work)) facets.vr += 1;
      if (missingLocal && publicWorkAvailability(work).hasMagnet) facets.hasMagnet += 1;
      if (!missingLocal && !work.coverId && !workHasCoreCover(work.id)) facets.missingCover += 1;
    }

    staticFacetCache.set(works, { stamp, facets });
    return facets;
  }

  function workFacets(works = allWorks()) {
    const stamp = `${currentStamp()}:${userStateStamp()}`;
    const cached = dynamicFacetCache.get(works);
    if (cached?.stamp === stamp) return cached.facets;
    const facets = { ...staticWorkFacets(works), favorite: 0, progress: 0 };
    for (const work of works) {
      if (favoriteStateService.isFavoriteWork(work.id)) facets.favorite += 1;
      if (playbackProgressService.getWorkProgress(work)) facets.progress += 1;
    }
    dynamicFacetCache.set(works, { stamp, facets });
    return facets;
  }

  function lightweightWorkFacets(works = []) {
    const facets = {
      all: works.length,
      playable: 0,
      favorite: 0,
      progress: 0,
      info: 0,
      localOnly: 0,
      missingLocal: 0,
      rated: 0,
      highRating: 0,
      vr: 0,
      hasMagnet: 0,
      missingCover: 0
    };

    for (const work of works) {
      const missingLocal = Boolean(work.missingLocal);
      const ratingValue = Number(work.infoSummary?.rating);
      const rating = Number.isFinite(ratingValue) ? ratingValue : null;
      if (Number(work.playableCount || 0) > 0) facets.playable += 1;
      if (favoriteStateService.isFavoriteWork(work.id)) facets.favorite += 1;
      if (playbackProgressService.getWorkProgress(work)) facets.progress += 1;
      if (work.infoSummary || Number(work.infoCount || 0) > 0) facets.info += 1;
      if (missingLocal) facets.missingLocal += 1;
      else facets.localOnly += 1;
      if (rating !== null) facets.rated += 1;
      if (rating !== null && rating >= 4) facets.highRating += 1;
      if (isVrWork(work)) facets.vr += 1;
      if (missingLocal && work.infoSummary?.hasMagnet) facets.hasMagnet += 1;
      if (!work.coverId && !work.remoteCoverUrl && !work.searchHasCover && !work.infoSummary?.imageUrl) facets.missingCover += 1;
    }

    return facets;
  }

  function pagedWorksPayload(works, url, extra = {}, options = {}) {
    ensureListResponseCache();
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const total = works.length;
    const pageSource = works.slice(offset, offset + limit);
    if (options.hydrateMissingSearchResults) hydrateMissingSearchWorks(pageSource);
    const missing = pageSource.filter((work) => !preparedWorkEntry(work, options));
    if (missing.length) {
      const coverBatch = options.lightweightInfo
        ? missing.filter((work) => work.missingLocal)
        : missing;
      if (coverBatch.length) prewarmCoreWorkCovers(coverBatch);
      if (!options.lightweightInfo) {
        prewarmVideoProbesForWorks(missing);
        prewarmWorkInfoDetails(missing);
      }
    }
    const page = pageSource.map((work) => preparedPublicWork(work, options));
    prewarmRemoteImagesForWorks(page);
    return { ...extra, count: page.length, total, limit, offset, sort, works: page };
  }

  function readPreparedWork(work, options = {}) {
    const cached = preparedWorkEntry(work, options);
    if (!cached) return null;
    const stateStamp = userStateStamp();
    if (cached.userStateStamp !== stateStamp) {
      cached.payload = { ...cached.payload, ...publicWorkUserState(work) };
      cached.userStateStamp = stateStamp;
    }
    const cacheKey = preparedWorkCacheKey(work, options);
    workPayloadCache.delete(cacheKey);
    workPayloadCache.set(cacheKey, cached);
    return cached.payload;
  }

  function preparedWorkEntry(work, options = {}) {
    const cacheKey = preparedWorkCacheKey(work, options);
    if (!cacheKey || !workPayloadCache.has(cacheKey)) return null;
    const cached = workPayloadCache.get(cacheKey);
    return cached.work === work ? cached : null;
  }

  function publicWorkUserState(work) {
    const favorite = favoriteStateService.publicFavoriteForWork?.(work.id) || null;
    return {
      favorite: Boolean(favorite),
      favoriteFolderId: favorite?.folderId || "",
      favoriteFolderName: favorite?.folderName || "",
      progress: playbackProgressService.getWorkProgress(work)
    };
  }

  function preparedPublicWork(work, options = {}) {
    const cached = readPreparedWork(work, options);
    if (cached) return cached;
    const payload = publicWork(work, false, options);
    const cacheKey = preparedWorkCacheKey(work, options);
    if (!cacheKey) return payload;
    workPayloadCache.set(cacheKey, { work, payload, userStateStamp: userStateStamp() });
    while (workPayloadCache.size > WORK_PAYLOAD_CACHE_LIMIT) {
      workPayloadCache.delete(workPayloadCache.keys().next().value);
    }
    return payload;
  }

  function preparedWorkCacheKey(work, options = {}) {
    const workId = String(work?.id || "");
    return workId ? `${options.lightweightInfo ? "light" : "full"}:${workId}` : "";
  }

  function listFromWorksPayload(sourceWorks, url, extra = {}, options = {}) {
    const filter = extra.filter || url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const matchesFilter = options.lightweightInfo ? lightweightWorkMatchesFilter : workMatchesFilter;
    const visibleWorks = workClassificationService.filterForRequest(sourceWorks, url, filter);
    const filters = requestedFilters(filter);
    const matchedWorks = filters.length
      ? visibleWorks.filter((work) => filters.every((item) => matchesFilter(work, item)))
      : visibleWorks;
    const works = sortWorkList(matchedWorks, sort, options);
    return pagedWorksPayload(works, url, {
      ...extra,
      filter,
      facets: extra.facets || workFacets(sourceWorks)
    }, options);
  }

  function listPayload(url) {
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const pageCacheKey = `${scope}:${filter}:${sort}:${limit}:${offset}`;
    const cachedPage = readListPage(pageCacheKey);
    if (cachedPage) return cachedPage;

    const stamp = currentStamp();
    const filtered = cachedListSource(scope, filter, stamp);
    const works = sortWorkList(filtered, sort);
    const payload = pagedWorksPayload(works, url, { filter, facets: workFacets(filtered) });
    return cacheListPage(pageCacheKey, payload);
  }

  function readListPage(cacheKey) {
    ensureListResponseCache();
    if (!listPageCache.has(cacheKey)) return null;
    const cached = listPageCache.get(cacheKey);
    listPageCache.delete(cacheKey);
    listPageCache.set(cacheKey, cached);
    return cached;
  }

  function cacheListPage(cacheKey, payload) {
    ensureListResponseCache();
    listPageCache.set(cacheKey, payload);
    while (listPageCache.size > LIST_PAGE_CACHE_LIMIT) {
      listPageCache.delete(listPageCache.keys().next().value);
    }
    return payload;
  }

  function ensureListResponseCache() {
    ensureWorkPayloadCache();
    const stamp = listResponseStamp();
    if (listPageCacheStamp === stamp) return;
    listPageCacheStamp = stamp;
    listPageCache = new Map();
    dynamicFacetCache = new WeakMap();
  }

  function ensureWorkPayloadCache() {
    const stamp = `${currentStamp()}:${actorMovieStamp()}:${peoplePayloadStamp()}`;
    if (workPayloadCacheStamp === stamp) return;
    workPayloadCacheStamp = stamp;
    workPayloadCache = new Map();
  }

  function cachedListSource(scope, filter, stamp = currentStamp()) {
    const filters = requestedFilters(filter);
    const filterKey = filters.length ? filters.join(",") : "all";
    const cacheKey = `${scope}:${filterKey}`;
    const cached = listSourceCache.get(cacheKey);
    const filterStamp = filters.some((item) => userStateFilters.has(item)) ? `${stamp}:${userStateStamp()}` : stamp;
    let filtered = cached?.stamp === filterStamp ? cached.works : null;

    if (!filtered) {
      const scopedCacheKey = `${scope}:all`;
      const scopedCached = listSourceCache.get(scopedCacheKey);
      const scopedWorks = scopedCached?.stamp === stamp
        ? scopedCached.works
        : enrichedWorks().filter((work) => peopleScopeService.workMatches(work, scope));
      listSourceCache.set(scopedCacheKey, { stamp, works: scopedWorks });
      filtered = filters.length
        ? scopedWorks.filter((work) => filters.every((item) => workMatchesFilter(work, item)))
        : scopedWorks;
      if (filters.every((item) => cacheableFilters.has(item))) {
        listSourceCache.set(cacheKey, { stamp: filterStamp, works: filtered });
      }
    }
    return filtered;
  }

  function prewarm() {
    enrichedWorks();
    prewarmLocalWorkCodeKeys();
    prewarmPersonMerge();
    const rankingMissingWorks = rankingMissingSearchWorks();
    const rankingMissingKeys = new Set(rankingMissingWorks
      .map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title))
      .filter(Boolean));
    const actorMissingWorks = actorMissingSearchWorks(rankingMissingKeys);
    prewarmWorkSearch([...rankingMissingWorks, ...actorMissingWorks]);
    const scope = peopleScopeService.normalize("main");
    const stamp = currentStamp();
    const works = cachedListSource(scope, "all", stamp);
    // Compact facet indexes are cheap to hydrate and keep the first list
    // request from paying synchronous catalog-query costs.
    staticWorkFacets(works);
    sortWorkList(works, "updated");
    sortWorkList(works, "releaseDesc");
    for (const filter of ["playable", "info", "rated", "highRating", "vr"]) {
      const filtered = cachedListSource(scope, filter, stamp);
      const releaseSorted = sortWorkList(filtered, "releaseDesc");
      if (filter === "rated" || filter === "highRating") sortWorkList(filtered, "ratingDesc");
    }
    const variants = [
      ["all", "updated"],
      ["all", "releaseDesc"],
      ["vr", "updated"],
      ["vr", "releaseDesc"],
      ["rated", "ratingDesc"]
    ];
    for (const limit of PREWARM_PAGE_SIZES) {
      for (const [filter, sort] of variants) {
        listPayload(new URL(`http://fanhao.local/api/works?limit=${limit}&offset=0&sort=${sort}&filter=${filter}`));
      }
    }
    scheduleLegacyMobileProgressPrewarm();
  }

  function scheduleLegacyMobileProgressPrewarm() {
    const targetLimit = Math.min(LEGACY_MOBILE_PROGRESS_LIMIT, maxWorkLimit);
    let offset = 0;
    const prepareNextBatch = () => {
      try {
        const page = listPayload(new URL(`http://fanhao.local/api/works?limit=${LEGACY_MOBILE_PREWARM_BATCH_SIZE}&offset=${offset}&sort=updated&filter=progress`));
        offset += page.count;
        if (page.count > 0 && offset < Math.min(page.total, targetLimit)) {
          scheduleBackground(prepareNextBatch, 0);
          return;
        }
        listPayload(new URL(`http://fanhao.local/api/works?limit=${targetLimit}&offset=0&sort=updated&filter=progress`));
      } catch (error) {
        console.warn("[fanhao] legacy mobile progress prewarm failed:", error.message);
      }
    };
    scheduleBackground(prepareNextBatch, LEGACY_MOBILE_PREWARM_DELAY_MS);
  }

  function searchPayload(url) {
    const rawQuery = (url.searchParams.get("q") || "").trim();
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const pageCacheKey = JSON.stringify([rawQuery, filter, sort, limit, offset]);
    const cachedPage = readSearchPage(pageCacheKey);
    if (cachedPage) return cachedPage;
    const source = cachedSearchSource(rawQuery);
    const facets = cachedSearchFacets(source);
    const filteredWorks = cachedSearchFilter(source, filter);
    const works = sortWorkList(filteredWorks, sort, { lightweightInfo: true });
    const payload = pagedWorksPayload(works, url, {
      filter,
      q: rawQuery,
      facets,
      people: source.people
    }, { hydrateMissingSearchResults: true, lightweightInfo: true });
    return cacheSearchPage(pageCacheKey, payload);
  }

  function readSearchPage(cacheKey) {
    ensureSearchResponseCache();
    if (!searchPageCache.has(cacheKey)) return null;
    const cached = searchPageCache.get(cacheKey);
    searchPageCache.delete(cacheKey);
    searchPageCache.set(cacheKey, cached);
    return cached;
  }

  function cacheSearchPage(cacheKey, payload) {
    ensureSearchResponseCache();
    searchPageCache.set(cacheKey, payload);
    while (searchPageCache.size > SEARCH_PAGE_CACHE_LIMIT) {
      searchPageCache.delete(searchPageCache.keys().next().value);
    }
    return payload;
  }

  function ensureSearchResponseCache() {
    const stamp = listResponseStamp();
    if (searchPageCacheStamp === stamp) return;
    searchPageCacheStamp = stamp;
    searchPageCache = new Map();
  }

  function cachedSearchSource(rawQuery) {
    const stamp = `${currentStamp()}:${peoplePayloadStamp()}`;
    if (searchSourceCacheStamp !== stamp) {
      searchSourceCacheStamp = stamp;
      searchSourceCache.clear();
    }

    const cacheKey = String(rawQuery || "").toLowerCase();
    if (searchSourceCache.has(cacheKey)) {
      const cached = searchSourceCache.get(cacheKey);
      searchSourceCache.delete(cacheKey);
      searchSourceCache.set(cacheKey, cached);
      return cached;
    }

    const query = rawQuery.toLowerCase();
    const localMarkerQuery = localMarkerFromSearchQuery(rawQuery);
    const exactCodeKey = /^[a-z]{2,12}[-_\s]?\d{2,}$/i.test(rawQuery) ? storedWorkCodeKey(rawQuery) : "";
    const codePrefix = storedWorkCodeKey(rawQuery);
    const codePrefixQuery = codePrefix.length >= 1 && /^[a-z][a-z0-9_-]*$/i.test(rawQuery);
    const peopleSearch = localMarkerQuery || exactCodeKey || codePrefixQuery
      ? { exact: [], matchedPersonIds: [], people: [] }
      : searchPeople(rawQuery);
    const exactPersonIds = new Set(peopleSearch.matchedPersonIds || peopleSearch.exact.map((person) => person.id));
    const exactPersonSearch = !exactCodeKey && !codePrefixQuery && peopleSearch.exact.length > 0;
    const exactLocalWork = exactCodeKey ? findExactLocalWork(exactCodeKey) : null;
    const rankingMissingWorks = localMarkerQuery || exactLocalWork || codePrefixQuery ? [] : rankingMissingSearchWorks();
    const rankingMissingKeys = new Set(rankingMissingWorks
      .map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title))
      .filter(Boolean));
    const actorMissingWorks = localMarkerQuery || exactLocalWork || codePrefixQuery ? [] : actorMissingSearchWorks(rankingMissingKeys);
    const usesTextMatcher = !localMarkerQuery && !exactCodeKey && !codePrefixQuery && !exactPersonSearch;
    if (usesTextMatcher) prewarmWorkSearch([...rankingMissingWorks, ...actorMissingWorks]);
    const matchesQuery = usesTextMatcher ? createWorkSearchMatcher(query) : null;
    const localMatches = localMarkerQuery
      ? allWorks().filter((work) => workHasLocalMarker(work, localMarkerQuery))
      : exactCodeKey
        ? (exactLocalWork ? [exactLocalWork] : [])
        : codePrefixQuery
          ? findLocalWorksByCodePrefix(codePrefix)
          : exactPersonSearch
            ? allWorks().filter((work) => exactPersonIds.has(work.personId))
            : allWorks().filter((work) => exactPersonIds.has(work.personId) || matchesQuery(work));
    const fastMissingMatches = codePrefixQuery && !exactLocalWork ? fastMissingCodeSearch(rawQuery) : null;
    const rankingMissingMatches = exactPersonSearch ? [] : rankingMissingWorks.filter((work) => exactCodeKey
      ? storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title) === exactCodeKey
      : matchesQuery(work));
    const actorMissingMatches = localMarkerQuery || exactLocalWork || codePrefixQuery
      ? []
      : actorMissingWorks.filter((work) => exactPersonSearch
        ? exactPersonIds.has(work.personId)
        : exactCodeKey
          ? storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title) === exactCodeKey
          : matchesQuery(work));
    const matchedWorks = dedupeWorksForDisplay([
      ...localMatches,
      ...(fastMissingMatches || []),
      ...rankingMissingMatches,
      ...actorMissingMatches
    ]);
    const source = {
      facetsCache: null,
      filteredByMode: new Map(),
      filteredByModeStamp: userStateStamp(),
      // Search renders compact person chips (name + work count) and opens the
      // full person endpoint on selection. Do not synchronously scan every
      // matched person's works just to synthesize an unused fallback avatar.
      people: peopleSearch.people.map((person) => publicPerson(person, { skipFallbackAvatar: true })),
      works: matchedWorks
    };
    searchSourceCache.set(cacheKey, source);
    while (searchSourceCache.size > 48) searchSourceCache.delete(searchSourceCache.keys().next().value);
    return source;
  }

  function cachedSearchFacets(source) {
    const stamp = userStateStamp();
    if (source.facetsCache?.stamp === stamp) return source.facetsCache.facets;
    const facets = lightweightWorkFacets(source.works);
    source.facetsCache = { stamp, facets };
    return facets;
  }

  function cachedSearchFilter(source, filter) {
    const filters = requestedFilters(filter);
    if (!filters.length) return source.works;
    const filterKey = filters.join(",");
    const matchesFilters = (work) => filters.every((item) => lightweightWorkMatchesFilter(work, item));
    if (!filters.every((item) => cacheableFilters.has(item))) return source.works.filter(matchesFilters);
    const stamp = userStateStamp();
    if (source.filteredByModeStamp !== stamp) {
      source.filteredByModeStamp = stamp;
      source.filteredByMode.clear();
    }
    if (!source.filteredByMode.has(filterKey)) {
      source.filteredByMode.set(filterKey, source.works.filter(matchesFilters));
    }
    return source.filteredByMode.get(filterKey);
  }

  function findExactLocalWork(codeKey) {
    return localSearchWorkByCodeKey().get(codeKey) || null;
  }

  function findLocalWorksByCodePrefix(codePrefix) {
    return localWorksByCodePrefix(codePrefix);
  }

  return {
    facets: workFacets,
    lightweightFacets: lightweightWorkFacets,
    listPayload,
    listFromWorksPayload,
    prewarm,
    searchPayload,
    visibilityStamp: workClassificationService.visibilityStamp
  };
}

function localMarkerFromSearchQuery(value) {
  const match = String(value || "").trim().match(/^\[\s*([a-z0-9]+)\s*\]$/i);
  const marker = String(match?.[1] || "").toUpperCase();
  return marker === "A" ? marker : "";
}

function requestedFilters(value) {
  return [...new Set(String(value || "all")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== "all"))];
}

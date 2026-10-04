import { classifyWorkCategory, normalizeWorkCategory, summarizeWorkCategories, WORK_CATEGORY_OPTIONS } from "./work-category.js";
import { createWorkSorter } from "./work-sorter.js";
import { createWeightedCacheBudget, normalizeWorkSortMode } from "./work-cache-budget.js";

const LIST_PAGE_CACHE_LIMIT = 96;
const SEARCH_PAGE_CACHE_LIMIT = 192;
const WORK_PAYLOAD_CACHE_LIMIT = 4096;
const FILTER_SOURCE_CACHE_LIMIT = 96;
const SORTED_SOURCE_CACHE_LIMIT = 64;
// Reference counts bound copied source/filter/order arrays without retaining
// their source identities. Normal 48/64-row response pages retain their usual
// count limits; large API pages can still be returned without being cached.
const DERIVED_WORK_REFERENCE_BUDGET = 4_000_000;
const LIST_PAGE_WORK_BUDGET = 8192;
const SEARCH_PAGE_WORK_BUDGET = 12288;
const PREWARM_PAGE_SIZES = [48, 64];
const LEGACY_MOBILE_PROGRESS_LIMIT = 720;
const LEGACY_MOBILE_PREWARM_BATCH_SIZE = 48;
const LEGACY_MOBILE_PREWARM_DELAY_MS = 500;

export function createWorkQueryService({
  actorMovieInfoStamp,
  actorMovieStamp,
  actorMissingSearchWorks,
  actorMissingSearchWorksForPeople = () => [],
  clampInteger,
  coreLocalWorkIdsForPeople = () => [],
  createWorkSearchMatcher,
  dedupeWorksForDisplay,
  defaultWorkLimit,
  displayWorkTitle = (value) => String(value || ""),
  enrichLocalWorksWithActorMovieIndex,
  enrichLocalWorksWithActorMovieInfo = (works) => works,
  fastMissingCodeSearch,
  favoriteStateService,
  hydrateMissingSearchWorks = () => {},
  isVrWork,
  library,
  localSearchWorkByCodeKey,
  localWorksByCodePrefix,
  maxWorkLimit,
  mergedActorMovieRows = () => [],
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
  recordPerformanceSpan = null,
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
  let categorySourcesCache = null;
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
  let derivedCacheStamp = "";
  const derivedBudget = createWeightedCacheBudget(DERIVED_WORK_REFERENCE_BUDGET);
  const listPageBudget = createWeightedCacheBudget(LIST_PAGE_WORK_BUDGET);
  const searchPageBudget = createWeightedCacheBudget(SEARCH_PAGE_WORK_BUDGET);
  const sharedWorkSorter = createWorkSorter({
    displayWorkTitle,
    metadataForWork: workSortMetadata,
    progressForWork: (work) => playbackProgressService.getWorkProgress(work)
  });
  const currentActorMovieInfoStamp = actorMovieInfoStamp || actorMovieStamp;

  function measure(label, callback) {
    if (!recordPerformanceSpan) return callback();
    const started = performance.now();
    try {
      return callback();
    } finally {
      recordPerformanceSpan(label, performance.now() - started);
    }
  }

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
    const stamp = `${library.scannedAt || ""}:${library.worksById.size}:${currentActorMovieInfoStamp()}`;
    if (enrichedWorksCache?.stamp === stamp) return enrichedWorksCache.works;
    const works = measure("enrich", () => enrichLocalWorksWithActorMovieIndex(allWorks()));
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
    ensureDerivedCacheStamp();
    sort = normalizeWorkSortMode(sort);
    const stamp = sort === "progress" ? `${currentStamp()}:${userStateStamp()}` : currentStamp();
    const cacheKey = `${sort}:${options.lightweightInfo ? "light" : "full"}`;
    const cachedBySort = sortedWorksCache.get(works);
    const cached = cachedBySort ? derivedBudget.read(cachedBySort, cacheKey) : null;
    if (cached?.stamp === stamp) return cached.works;

    const sortStarted = recordPerformanceSpan ? performance.now() : 0;
    const list = sharedWorkSorter(works, sort, options);
    const nextCachedBySort = cachedBySort || new Map();
    derivedBudget.write(nextCachedBySort, cacheKey, { stamp, works: list }, list.length, SORTED_SOURCE_CACHE_LIMIT);
    if (!cachedBySort) sortedWorksCache.set(works, nextCachedBySort);
    if (recordPerformanceSpan) recordPerformanceSpan("sort", performance.now() - sortStarted);
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
      case "missingCover": return !work.missingLocal && !work.coverId && !workHasCoreCover(work.id);
      case "all":
      default: return true;
    }
  }

  function staticWorkFacets(works) {
    const stamp = currentStamp();
    const cached = staticFacetCache.get(works);
    if (cached?.stamp === stamp) return cached.facets;

    const facetStarted = recordPerformanceSpan ? performance.now() : 0;
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
    if (recordPerformanceSpan) recordPerformanceSpan("facets", performance.now() - facetStarted);
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
      const rating = numericSummaryRating(work);
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
      if (!missingLocal && !work.coverId && !workHasCoreCover(work.id)) facets.missingCover += 1;
    }

    return facets;
  }

  function pagedWorksPayload(works, url, extra = {}, options = {}) {
    const pageStarted = recordPerformanceSpan ? performance.now() : 0;
    ensureListResponseCache();
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const total = works.length;
    const pageSource = works.slice(offset, offset + limit);
    if (options.hydrateMissingSearchResults) hydrateMissingSearchWorks(pageSource);
    const missing = pageSource.filter((work) => !preparedWorkEntry(work, options));
    if (missing.length) {
      const coverBatch = options.lightweightInfo && !options.includeCoreCovers
        ? missing.filter((work) => work.missingLocal && !work.cachedCover?.coverUrl)
        : missing;
      if (coverBatch.length) prewarmCoreWorkCovers(coverBatch);
      if (!options.lightweightInfo) {
        prewarmVideoProbesForWorks(missing);
        prewarmWorkInfoDetails(missing);
      }
    }
    const page = pageSource.map((work) => preparedPublicWork(work, options));
    prewarmRemoteImagesForWorks(page);
    const payload = { ...extra, count: page.length, total, limit, offset, sort, works: page };
    if (recordPerformanceSpan) recordPerformanceSpan("page-hydrate", performance.now() - pageStarted);
    return payload;
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
    const mode = options.lightweightInfo
      ? options.includeCoreCovers ? "light-cover" : "light"
      : "full";
    return workId ? `${mode}:${workId}` : "";
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
    const category = normalizeWorkCategory(url.searchParams.get("category"));
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const pageCacheKey = `${scope}:${category}:${filter}:${sort}:${limit}:${offset}`;
    const cachedPage = readListPage(pageCacheKey);
    if (cachedPage) return cachedPage;

    const stamp = currentStamp();
    const filtered = cachedListSource(scope, filter, stamp, category);
    const works = sortWorkList(filtered, sort);
    const payload = pagedWorksPayload(works, url, {
      category,
      categories: category === "all" ? undefined : categorySummaryItems(stamp),
      filter,
      facets: workFacets(filtered)
    });
    return cacheListPage(pageCacheKey, payload);
  }

  function categorySummaryPayload() {
    const stamp = currentStamp();
    return { count: WORK_CATEGORY_OPTIONS.length, categories: categorySummaryItems(stamp) };
  }

  function categorySummaryForWorks(works = []) {
    return summarizeWorkCategories(works, {
      isWestern: (work) => peopleScopeService.workMatchesDirect?.(work, "western")
        ?? peopleScopeService.workMatches(work, "western")
    });
  }

  function readListPage(cacheKey) {
    ensureListResponseCache();
    return listPageBudget.read(listPageCache, cacheKey);
  }

  function cacheListPage(cacheKey, payload) {
    ensureListResponseCache();
    listPageBudget.write(listPageCache, cacheKey, payload, payload.count, LIST_PAGE_CACHE_LIMIT);
    return payload;
  }

  function ensureListResponseCache() {
    ensureWorkPayloadCache();
    const stamp = listResponseStamp();
    if (listPageCacheStamp === stamp) return;
    listPageCacheStamp = stamp;
    listPageBudget.clear(listPageCache);
    listPageCache = new Map();
    dynamicFacetCache = new WeakMap();
  }

  function ensureWorkPayloadCache() {
    const stamp = `${currentStamp()}:${actorMovieStamp()}:${peoplePayloadStamp()}`;
    if (workPayloadCacheStamp === stamp) return;
    workPayloadCacheStamp = stamp;
    workPayloadCache = new Map();
  }

  function cachedListSource(scope, filter, stamp = currentStamp(), requestedCategory = "all") {
    ensureDerivedCacheStamp();
    const category = normalizeWorkCategory(requestedCategory);
    const filters = requestedFilters(filter);
    const filterKey = filters.length ? filters.join(",") : "all";
    const cacheKey = `${scope}:${category}:${filterKey}`;
    const cached = readFilterCache(listSourceCache, cacheKey);
    const filterStamp = filters.some((item) => userStateFilters.has(item)) ? `${stamp}:${userStateStamp()}` : stamp;
    let filtered = cached?.stamp === filterStamp ? cached.works : null;

    if (!filtered) {
      const scopedCacheKey = `${scope}:${category}:all`;
      const scopedCached = readFilterCache(listSourceCache, scopedCacheKey);
      const scopedWorks = scopedCached?.stamp === stamp
        ? scopedCached.works
        : worksForScopeAndCategory(scope, category, stamp);
      writeFilterCache(listSourceCache, scopedCacheKey, { stamp, works: scopedWorks });
      filtered = filters.length
        ? measure("filter", () => scopedWorks.filter((work) => filters.every((item) => workMatchesFilter(work, item))))
        : scopedWorks;
      if (filters.every((item) => cacheableFilters.has(item))) {
        writeFilterCache(listSourceCache, cacheKey, { stamp: filterStamp, works: filtered });
      }
    }
    return filtered;
  }

  function worksForScopeAndCategory(scope, category, stamp) {
    if (scope === "main" && category !== "all") return categorySources(stamp).get(category) || [];
    if (scope === "western" && (category === "all" || category === "western")) {
      return categorySources(stamp).get("western") || [];
    }
    return enrichedWorks().filter((work) =>
      peopleScopeService.workMatches(work, scope)
      && (category === "all" || workCategory(work) === category));
  }

  function categorySources(stamp = currentStamp()) {
    if (categorySourcesCache?.stamp === stamp) return categorySourcesCache.sources;
    const sources = new Map(WORK_CATEGORY_OPTIONS.map((option) => [option.value, []]));
    measure("category", () => {
      for (const work of enrichedWorks()) {
        if (!peopleScopeService.workMatches(work, "main")) continue;
        const category = workCategory(work);
        sources.get(category)?.push(work);
      }
    });
    categorySourcesCache = { stamp, sources };
    return sources;
  }

  function workCategory(work) {
    return classifyWorkCategory(work, { isWestern: peopleScopeService.workMatches(work, "western") });
  }

  function categorySummaryItems(stamp = currentStamp()) {
    const sources = categorySources(stamp);
    return WORK_CATEGORY_OPTIONS.map((option) => ({
      ...option,
      count: sources.get(option.value)?.length || 0
    }));
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
    categorySummaryPayload();
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
    const startedAt = performance.now();
    const timings = {};
    const mark = (name) => {
      timings[name] = Math.round(performance.now() - startedAt);
    };
    const rawQuery = (url.searchParams.get("q") || "").trim();
    const category = normalizeWorkCategory(url.searchParams.get("category"));
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const pageCacheKey = JSON.stringify([rawQuery, category, filter, sort, limit, offset]);
    const cachedPage = readSearchPage(pageCacheKey);
    mark("pageCache");
    if (cachedPage) {
      timings.pageCacheHit = true;
      return searchPayloadWithTimings(cachedPage, url, rawQuery, timings, mark);
    }
    const source = cachedSearchSource(rawQuery, timings, mark);
    mark("source");
    const categoryWorks = cachedSearchCategory(source, category);
    mark("category");
    const facets = cachedSearchFacets(source, category, categoryWorks);
    mark("facets");
    const filteredWorks = cachedSearchFilter(source, category, categoryWorks, filter);
    mark("filter");
    const works = sortWorkList(filteredWorks, sort, { lightweightInfo: true });
    mark("sort");
    const payload = pagedWorksPayload(works, url, {
      category,
      categories: categorySummaryForWorks(source.works),
      filter,
      q: rawQuery,
      facets,
      people: source.people
    }, { hydrateMissingSearchResults: true, lightweightInfo: true });
    mark("payload");
    cacheSearchPage(pageCacheKey, payload);
    return searchPayloadWithTimings(payload, url, rawQuery, timings, mark);
  }

  function searchPayloadWithTimings(payload, url, rawQuery, timings, mark) {
    mark("total");
    if (timings.total >= 500) {
      console.warn("[fanhao-search-slow]", JSON.stringify({ query: rawQuery, count: payload?.total || 0, ...timings }));
    }
    return url.searchParams.get("timing") === "1" ? { ...payload, timings } : payload;
  }

  function readSearchPage(cacheKey) {
    ensureSearchResponseCache();
    return searchPageBudget.read(searchPageCache, cacheKey);
  }

  function cacheSearchPage(cacheKey, payload) {
    ensureSearchResponseCache();
    searchPageBudget.write(searchPageCache, cacheKey, payload, payload.count, SEARCH_PAGE_CACHE_LIMIT);
    return payload;
  }

  function ensureSearchResponseCache() {
    const stamp = listResponseStamp();
    if (searchPageCacheStamp === stamp) return;
    searchPageCacheStamp = stamp;
    searchPageBudget.clear(searchPageCache);
    searchPageCache = new Map();
  }

  function cachedSearchSource(rawQuery, timings = {}, mark = () => {}) {
    ensureDerivedCacheStamp();
    const stamp = `${currentStamp()}:${peoplePayloadStamp()}`;
    mark("sourceStamp");
    if (searchSourceCacheStamp !== stamp) {
      searchSourceCacheStamp = stamp;
      derivedBudget.clear(searchSourceCache);
    }

    const cacheKey = String(rawQuery || "").toLowerCase();
    if (searchSourceCache.has(cacheKey)) {
      const cached = derivedBudget.read(searchSourceCache, cacheKey);
      timings.sourceCacheHit = true;
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
    mark("peopleSearch");
    const exactPersonIds = new Set(peopleSearch.matchedPersonIds || peopleSearch.exact.map((person) => person.id));
    const exactPersonSearch = !exactCodeKey && !codePrefixQuery && peopleSearch.exact.length > 0;
    const exactPersonLocalWorkIds = exactPersonSearch
      ? new Set(coreLocalWorkIdsForPeople([...exactPersonIds]))
      : new Set();
    if (exactPersonSearch) {
      for (const personId of exactPersonIds) {
        const person = library.peopleById?.get(String(personId));
        for (const workId of person?.works || []) exactPersonLocalWorkIds.add(String(workId));
      }
    }
    mark("localRelations");
    const exactPersonLocalWorks = exactPersonSearch
      ? enrichLocalWorksWithActorMovieInfo(
          [...exactPersonLocalWorkIds].map((workId) => library.worksById.get(String(workId))).filter(Boolean),
          peopleSearch.exact.flatMap((person) => mergedActorMovieRows(person.id))
        )
      : [];
    mark("actorEnrich");
    const matchesExactPerson = (work) => exactPersonIds.has(work.personId)
      || exactPersonLocalWorkIds.has(String(work.id || ""));
    const exactLocalWork = exactCodeKey ? findExactLocalWork(exactCodeKey) : null;
    const rankingMissingWorks = localMarkerQuery || exactLocalWork || codePrefixQuery || exactPersonSearch ? [] : rankingMissingSearchWorks();
    const rankingMissingKeys = new Set(rankingMissingWorks
      .map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title))
      .filter(Boolean));
    const actorMissingWorks = localMarkerQuery || exactLocalWork || codePrefixQuery
      ? []
      : exactPersonSearch
        ? actorMissingSearchWorksForPeople([...exactPersonIds], rankingMissingKeys)
        : actorMissingSearchWorks(rankingMissingKeys);
    mark("missingWorks");
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
            ? exactPersonLocalWorks.filter(matchesExactPerson)
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
    mark("workMatches");
    const matchedWorks = dedupeWorksForDisplay([
      ...localMatches,
      ...(fastMissingMatches || []),
      ...rankingMissingMatches,
      ...actorMissingMatches
    ]).filter((work) => peopleScopeService.workMatches(work, "main"));
    mark("dedupe");
    const source = {
      categoryWorks: new Map(),
      facetsByCategory: new Map(),
      facetsStamp: userStateStamp(),
      filteredByMode: new Map(),
      filteredByModeStamp: userStateStamp(),
      // Search renders compact person chips (name + work count) and opens the
      // full person endpoint on selection. Do not synchronously scan every
      // matched person's works just to synthesize an unused fallback avatar.
      people: peopleSearch.people.map((person) => publicPerson(person, { skipFallbackAvatar: true })),
      works: matchedWorks
    };
    mark("publicPeople");
    derivedBudget.write(searchSourceCache, cacheKey, source, source.works.length, 48);
    return source;
  }

  function cachedSearchCategory(source, category) {
    if (category === "all") return source.works;
    const cached = derivedBudget.read(source.categoryWorks, category);
    if (cached) return cached;
    const filtered = source.works.filter((work) => workCategory(work) === category);
    return derivedBudget.write(source.categoryWorks, category, filtered, filtered.length);
  }

  function cachedSearchFacets(source, category, categoryWorks) {
    const stamp = userStateStamp();
    if (source.facetsStamp !== stamp) {
      source.facetsStamp = stamp;
      source.facetsByCategory.clear();
    }
    if (source.facetsByCategory.has(category)) return source.facetsByCategory.get(category);
    const facets = lightweightWorkFacets(categoryWorks);
    source.facetsByCategory.set(category, facets);
    return facets;
  }

  function cachedSearchFilter(source, category, categoryWorks, filter) {
    const filters = requestedFilters(filter);
    if (!filters.length) return categoryWorks;
    const filterKey = `${category}:${filters.join(",")}`;
    const matchesFilters = (work) => filters.every((item) => lightweightWorkMatchesFilter(work, item));
    if (!filters.every((item) => cacheableFilters.has(item))) return categoryWorks.filter(matchesFilters);
    const stamp = userStateStamp();
    if (source.filteredByModeStamp !== stamp) {
      source.filteredByModeStamp = stamp;
      derivedBudget.clear(source.filteredByMode);
    }
    const cached = readFilterCache(source.filteredByMode, filterKey);
    if (cached) return cached;
    const filtered = measure("filter", () => categoryWorks.filter(matchesFilters));
    writeFilterCache(source.filteredByMode, filterKey, filtered);
    return filtered;
  }

  function readFilterCache(cache, key) {
    return derivedBudget.read(cache, key);
  }

  function writeFilterCache(cache, key, value) {
    return derivedBudget.write(cache, key, value, (value.works || value).length, FILTER_SOURCE_CACHE_LIMIT);
  }

  function ensureDerivedCacheStamp() {
    const stamp = currentStamp();
    if (derivedCacheStamp === stamp) return;
    derivedCacheStamp = stamp;
    derivedBudget.clear();
    sortedWorksCache = new WeakMap();
    listSourceCache.clear();
    searchSourceCache.clear();
    searchSourceCacheStamp = "";
  }

  function findExactLocalWork(codeKey) {
    return localSearchWorkByCodeKey().get(codeKey) || null;
  }

  function findLocalWorksByCodePrefix(codePrefix) {
    return localWorksByCodePrefix(codePrefix);
  }

  return {
    categorySummaryForWorks,
    categorySummaryPayload,
    facets: workFacets,
    lightweightFacets: lightweightWorkFacets,
    listPayload,
    listFromWorksPayload,
    prewarm,
    prewarmLocalMetadata: enrichedWorks,
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
    .filter((item) => item && item !== "all"))].sort();
}

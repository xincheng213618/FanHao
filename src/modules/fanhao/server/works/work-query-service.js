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
  isVrWork,
  library,
  maxWorkLimit,
  peopleScopeService,
  playbackProgressService,
  prewarmLocalWorkCodeKeys,
  prewarmWorkInfoDetails = () => {},
  prewarmRemoteImagesForWorks,
  publicPerson,
  publicWork,
  publicWorkAvailability,
  rankingMissingSearchWorks,
  searchPeople,
  storedWorkCodeKey,
  workHasCoreCover,
  workHasLocalMarker,
  workInfoFacetRow,
  workQueryStamp,
}) {
  let enrichedWorksCache = null;
  const listSourceCache = new Map();
  const cacheableFilters = new Set([
    "all",
    "hasMagnet",
    "highRating",
    "info",
    "localOnly",
    "missingCover",
    "missingLocal",
    "playable",
    "rated",
    "vr"
  ]);
  let staticFacetCache = new WeakMap();
  let sortedWorksCache = new WeakMap();
  const workCodeCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function currentStamp() {
    return `${library.scannedAt || ""}:${library.worksById.size}:${workQueryStamp()}`;
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
      case "missingCover": return !work.coverId && !work.remoteCoverUrl && !work.infoSummary?.imageUrl;
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
    const facets = { ...staticWorkFacets(works), favorite: 0, progress: 0 };
    for (const work of works) {
      if (favoriteStateService.isFavoriteWork(work.id)) facets.favorite += 1;
      if (playbackProgressService.getWorkProgress(work)) facets.progress += 1;
    }
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
      if (!work.coverId && !work.remoteCoverUrl && !work.infoSummary?.imageUrl) facets.missingCover += 1;
    }

    return facets;
  }

  function pagedWorksPayload(works, url, extra = {}, options = {}) {
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const total = works.length;
    const pageSource = works.slice(offset, offset + limit);
    if (!options.lightweightInfo) prewarmWorkInfoDetails(pageSource);
    const page = pageSource.map((work) => publicWork(work, false, options));
    prewarmRemoteImagesForWorks(page);
    return { ...extra, count: page.length, total, limit, offset, sort, works: page };
  }

  function listFromWorksPayload(sourceWorks, url, extra = {}) {
    const filter = extra.filter || url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const matchedWorks = filter === "all" ? sourceWorks : sourceWorks.filter((work) => workMatchesFilter(work, filter));
    const works = sortWorkList(matchedWorks, sort);
    return pagedWorksPayload(works, url, {
      ...extra,
      filter,
      facets: extra.facets || workFacets(sourceWorks)
    });
  }

  function listPayload(url) {
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const filter = url.searchParams.get("filter") || "all";
    const stamp = currentStamp();
    const cacheKey = `${scope}:${filter}`;
    const cached = listSourceCache.get(cacheKey);
    let filtered = cached?.stamp === stamp ? cached.works : null;

    if (!filtered) {
      const scopedCacheKey = `${scope}:all`;
      const scopedCached = listSourceCache.get(scopedCacheKey);
      const scopedWorks = scopedCached?.stamp === stamp
        ? scopedCached.works
        : enrichedWorks().filter((work) => peopleScopeService.workMatches(work, scope));
      listSourceCache.set(scopedCacheKey, { stamp, works: scopedWorks });
      filtered = filter === "all" ? scopedWorks : scopedWorks.filter((work) => workMatchesFilter(work, filter));
      if (cacheableFilters.has(filter)) listSourceCache.set(cacheKey, { stamp, works: filtered });
    }

    const sort = url.searchParams.get("sort") || "releaseDesc";
    const works = sortWorkList(filtered, sort);
    return pagedWorksPayload(works, url, { filter, facets: workFacets(filtered) });
  }

  function prewarm() {
    enrichedWorks();
    prewarmLocalWorkCodeKeys();
    const scope = peopleScopeService.normalize("main");
    const stamp = currentStamp();
    const works = enrichedWorks().filter((work) => peopleScopeService.workMatches(work, scope));
    listSourceCache.set(`${scope}:all`, { stamp, works });
    // Compact facet indexes are cheap to hydrate and keep the first list
    // request from paying synchronous catalog-query costs.
    staticWorkFacets(works);
    sortWorkList(works, "updated");
  }

  function searchPayload(url) {
    const rawQuery = (url.searchParams.get("q") || "").trim();
    const query = rawQuery.toLowerCase();
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const exactCodeKey = /^[a-z]{2,12}[-_\s]?\d{2,}$/i.test(rawQuery) ? storedWorkCodeKey(rawQuery) : "";
    const codePrefixQuery = storedWorkCodeKey(rawQuery).length >= 2 && /^[a-z][a-z0-9_-]*$/i.test(rawQuery);
    const peopleSearch = exactCodeKey || codePrefixQuery
      ? { exact: [], matchedPersonIds: [], people: [] }
      : searchPeople(rawQuery);
    const exactPersonIds = new Set(peopleSearch.matchedPersonIds || peopleSearch.exact.map((person) => person.id));
    const matchesQuery = exactCodeKey || codePrefixQuery ? null : createWorkSearchMatcher(query);
    const exactLocalWork = exactCodeKey ? findExactLocalWork(exactCodeKey) : null;
    const localMatches = exactCodeKey
      ? (exactLocalWork ? [exactLocalWork] : [])
      : codePrefixQuery
        ? findLocalWorksByCodePrefix(storedWorkCodeKey(rawQuery))
        : allWorks().filter((work) => exactPersonIds.has(work.personId) || matchesQuery(work));
    const fastMissingMatches = codePrefixQuery && !exactLocalWork ? fastMissingCodeSearch(rawQuery) : null;
    const rankingMissingWorks = exactLocalWork || codePrefixQuery ? [] : rankingMissingSearchWorks();
    const rankingMissingKeys = new Set(rankingMissingWorks
      .map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title))
      .filter(Boolean));
    const rankingMissingMatches = rankingMissingWorks.filter((work) => exactCodeKey
      ? storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title) === exactCodeKey
      : matchesQuery(work));
    const actorMissingMatches = exactLocalWork || codePrefixQuery ? [] : actorMissingSearchWorks(rankingMissingKeys).filter((work) => exactCodeKey
      ? storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title) === exactCodeKey
      : matchesQuery(work));
    const matchedWorks = dedupeWorksForDisplay([
      ...localMatches,
      ...(fastMissingMatches || []),
      ...rankingMissingMatches,
      ...actorMissingMatches
    ]);
    const facets = lightweightWorkFacets(matchedWorks);
    const works = sortWorkList(
      matchedWorks.filter((work) => lightweightWorkMatchesFilter(work, filter)),
      sort,
      { lightweightInfo: true }
    );
    return pagedWorksPayload(works, url, {
      filter,
      q: rawQuery,
      facets,
      people: peopleSearch.people.map(publicPerson)
    }, { lightweightInfo: true });
  }

  function findExactLocalWork(codeKey) {
    for (const work of library.worksById.values()) {
      const values = [work.infoSummary?.code, work.directoryName, work.title];
      if (values.some((value) => storedWorkCodeKey(value) === codeKey)) return work;
    }
    return null;
  }

  function findLocalWorksByCodePrefix(codePrefix) {
    return allWorks().filter((work) => {
      const values = [work.infoSummary?.code, work.directoryName, work.title];
      return values.some((value) => storedWorkCodeKey(value).startsWith(codePrefix));
    });
  }

  return {
    facets: workFacets,
    listPayload,
    listFromWorksPayload,
    prewarm,
    searchPayload
  };
}

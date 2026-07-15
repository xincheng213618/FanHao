export function createWorkQueryService({
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
  prewarmRemoteImagesForWorks,
  publicPerson,
  publicWork,
  publicWorkAvailability,
  rankingMissingSearchWorks,
  searchPeople,
  storedWorkCodeKey,
  workCoverRow,
  workHasLocalMarker,
  workInfoRow,
  workRating,
  workRatingCount,
  workReleaseDate,
}) {
  function allWorks() {
    return [...library.worksById.values()];
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
        return Boolean(workInfoRow(work.id)) || Number(work.infoCount || 0) > 0;
      case "rated":
        return workRating(work) !== null;
      case "highRating": {
        const rating = workRating(work);
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
        return !work.coverId && !workCoverRow(work.id);
      case "all":
      default:
        return true;
    }
  }

  function sortWorkList(works, sort, options = {}) {
    const list = [...works];
    list.sort((a, b) => {
      if (sort === "releaseDesc" || sort === "releaseAsc") {
        const aDate = options.lightweightInfo ? String(a.infoSummary?.releaseDate || "") : workReleaseDate(a);
        const bDate = options.lightweightInfo ? String(b.infoSummary?.releaseDate || "") : workReleaseDate(b);
        const aHas = Boolean(aDate);
        const bHas = Boolean(bDate);
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aDate !== bDate) return sort === "releaseAsc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
      }

      if (sort === "ratingAsc" || sort === "ratingDesc") {
        const aRating = options.lightweightInfo ? numericSummaryRating(a) : workRating(a);
        const bRating = options.lightweightInfo ? numericSummaryRating(b) : workRating(b);
        const aHas = aRating !== null;
        const bHas = bRating !== null;
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aHas && aRating !== bRating) return sort === "ratingAsc" ? aRating - bRating : bRating - aRating;
        const countDiff = options.lightweightInfo
          ? Number(b.infoSummary?.ratingCount || 0) - Number(a.infoSummary?.ratingCount || 0)
          : workRatingCount(b) - workRatingCount(a);
        if (countDiff) return countDiff;
      }

      if (sort === "size" || sort === "sizeDesc" || sort === "sizeAsc") {
        const aSize = (a.videos || []).reduce((sum, video) => sum + Number(video.size || 0), 0);
        const bSize = (b.videos || []).reduce((sum, video) => sum + Number(video.size || 0), 0);
        if (aSize !== bSize) return sort === "sizeAsc" ? aSize - bSize : bSize - aSize;
      }

      if (sort === "duration" || sort === "durationDesc" || sort === "durationAsc") {
        const aDuration = Number(a.infoSummary?.durationMinutes ?? workInfoRow(a.id)?.duration_minutes ?? 0);
        const bDuration = Number(b.infoSummary?.durationMinutes ?? workInfoRow(b.id)?.duration_minutes ?? 0);
        if (aDuration !== bDuration) return sort === "durationAsc" ? aDuration - bDuration : bDuration - aDuration;
      }

      if (sort === "codeAsc" || sort === "codeDesc") {
        const aCode = a.infoSummary?.code || workInfoRow(a.id)?.code || a.title || a.directoryName || "";
        const bCode = b.infoSummary?.code || workInfoRow(b.id)?.code || b.title || b.directoryName || "";
        const result = aCode.localeCompare(bCode, undefined, { numeric: true, sensitivity: "base" });
        if (result) return sort === "codeDesc" ? -result : result;
      }

      return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
    });
    return list;
  }

  function numericSummaryRating(work) {
    const value = Number(work.infoSummary?.rating);
    return Number.isFinite(value) ? value : null;
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

  function workFacets(works = allWorks()) {
    return {
      all: works.length,
      playable: works.filter((work) => workMatchesFilter(work, "playable")).length,
      favorite: works.filter((work) => workMatchesFilter(work, "favorite")).length,
      progress: works.filter((work) => workMatchesFilter(work, "progress")).length,
      info: works.filter((work) => workMatchesFilter(work, "info")).length,
      localOnly: works.filter((work) => workMatchesFilter(work, "localOnly")).length,
      missingLocal: works.filter((work) => workMatchesFilter(work, "missingLocal")).length,
      rated: works.filter((work) => workRating(work) !== null).length,
      highRating: works.filter((work) => {
        const rating = workRating(work);
        return rating !== null && rating >= 4;
      }).length,
      vr: works.filter((work) => workMatchesFilter(work, "vr")).length,
      hasMagnet: works.filter((work) => workMatchesFilter(work, "hasMagnet")).length,
      missingCover: works.filter((work) => workMatchesFilter(work, "missingCover")).length
    };
  }

  function lightweightWorkFacets(works = []) {
    const rating = (work) => {
      const value = Number(work.infoSummary?.rating);
      return Number.isFinite(value) ? value : null;
    };
    return {
      all: works.length,
      playable: works.filter((work) => Number(work.playableCount || 0) > 0).length,
      favorite: works.filter((work) => favoriteStateService.isFavoriteWork(work.id)).length,
      progress: works.filter((work) => Boolean(playbackProgressService.getWorkProgress(work))).length,
      info: works.filter((work) => Boolean(work.infoSummary) || Number(work.infoCount || 0) > 0).length,
      localOnly: works.filter((work) => !work.missingLocal).length,
      missingLocal: works.filter((work) => Boolean(work.missingLocal)).length,
      rated: works.filter((work) => rating(work) !== null).length,
      highRating: works.filter((work) => (rating(work) ?? -Infinity) >= 4).length,
      vr: works.filter((work) => isVrWork(work)).length,
      hasMagnet: works.filter((work) => Boolean(work.missingLocal && work.infoSummary?.hasMagnet)).length,
      missingCover: works.filter((work) => !work.coverId && !work.remoteCoverUrl && !work.infoSummary?.imageUrl).length
    };
  }

  function pagedWorksPayload(works, url, extra = {}, options = {}) {
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const total = works.length;
    const page = works.slice(offset, offset + limit).map((work) => publicWork(work, false, options));
    prewarmRemoteImagesForWorks(page);
    return { ...extra, count: page.length, total, limit, offset, sort, works: page };
  }

  function listFromWorksPayload(sourceWorks, url, extra = {}) {
    const filter = extra.filter || url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const works = sortWorkList(sourceWorks.filter((work) => workMatchesFilter(work, filter)), sort);
    return pagedWorksPayload(works, url, {
      ...extra,
      filter,
      facets: extra.facets || workFacets(sourceWorks)
    });
  }

  function listPayload(url) {
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const filter = url.searchParams.get("filter") || "all";
    const filtered = enrichLocalWorksWithActorMovieIndex(allWorks()
      .filter((work) => peopleScopeService.workMatches(work, scope)))
      .filter((work) => workMatchesFilter(work, filter));
    return listFromWorksPayload(filtered, url, { filter, facets: workFacets(filtered) });
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
    searchPayload
  };
}

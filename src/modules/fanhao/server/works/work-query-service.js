export function createWorkQueryService({
  actorMissingSearchWorks,
  clampInteger,
  defaultWorkLimit,
  enrichLocalWorksWithActorMovieIndex,
  favoriteStateService,
  isVrWork,
  library,
  matchesWorkSearch,
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

  function sortWorkList(works, sort) {
    const list = [...works];
    list.sort((a, b) => {
      if (sort === "releaseDesc" || sort === "releaseAsc") {
        const aDate = workReleaseDate(a);
        const bDate = workReleaseDate(b);
        const aHas = Boolean(aDate);
        const bHas = Boolean(bDate);
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aDate !== bDate) return sort === "releaseAsc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
      }

      if (sort === "ratingAsc" || sort === "ratingDesc") {
        const aRating = workRating(a);
        const bRating = workRating(b);
        const aHas = aRating !== null;
        const bHas = bRating !== null;
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aHas && aRating !== bRating) return sort === "ratingAsc" ? aRating - bRating : bRating - aRating;
        const countDiff = workRatingCount(b) - workRatingCount(a);
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

  function pagedWorksPayload(works, url, extra = {}) {
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const total = works.length;
    const page = works.slice(offset, offset + limit).map((work) => publicWork(work));
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
    const peopleSearch = searchPeople(rawQuery);
    const exactPersonIds = new Set(peopleSearch.matchedPersonIds || peopleSearch.exact.map((person) => person.id));
    const localMatches = enrichLocalWorksWithActorMovieIndex(allWorks().filter((work) => {
      return exactPersonIds.has(work.personId) || matchesWorkSearch(work, query);
    }));
    const rankingMissingWorks = rankingMissingSearchWorks();
    const rankingMissingKeys = new Set(rankingMissingWorks
      .map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title))
      .filter(Boolean));
    const rankingMissingMatches = rankingMissingWorks.filter((work) => matchesWorkSearch(work, query));
    const actorMissingMatches = actorMissingSearchWorks(rankingMissingKeys).filter((work) => matchesWorkSearch(work, query));
    const matchedWorks = [...localMatches, ...rankingMissingMatches, ...actorMissingMatches];
    const facets = workFacets(matchedWorks);
    const works = sortWorkList(matchedWorks.filter((work) => workMatchesFilter(work, filter)), sort);
    return pagedWorksPayload(works, url, {
      filter,
      q: rawQuery,
      facets,
      people: peopleSearch.people.map(publicPerson)
    });
  }

  return {
    facets: workFacets,
    listPayload,
    listFromWorksPayload,
    searchPayload
  };
}

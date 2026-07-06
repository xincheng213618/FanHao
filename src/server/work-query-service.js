export function createWorkQueryService({
  actorMissingSearchWorks,
  allWorks,
  enrichLocalWorksWithActorMovieIndex,
  matchesWorkSearch,
  normalizePeopleScope,
  pagedWorksPayload,
  publicPerson,
  rankingMissingSearchWorks,
  searchPeople,
  sortWorkList,
  storedWorkCodeKey,
  workFacets,
  workMatchesFilter,
  workMatchesPeopleScope
}) {
  function listPayload(url) {
    const scope = normalizePeopleScope(url.searchParams.get("scope"));
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const filtered = enrichLocalWorksWithActorMovieIndex(allWorks()
      .filter((work) => workMatchesPeopleScope(work, scope)))
      .filter((work) => workMatchesFilter(work, filter));
    const sorted = sortWorkList(filtered, sort);
    return pagedWorksPayload(sorted, url, { filter, facets: workFacets(filtered) });
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
    listPayload,
    searchPayload
  };
}

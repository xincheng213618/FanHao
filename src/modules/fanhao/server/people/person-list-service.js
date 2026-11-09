export function createPersonListService({
  actorProfileRow,
  actorMovieService,
  createCatalogueRowReader = () => actorProfileRow,
  getStamp = () => "",
  getLibrary,
  peopleScopeService,
  personMergeService
}) {
  const mainPeopleCache = new Map();

  function shouldShowPersonInMainList(person) {
    if (!person) return false;
    if (Number(person.workCount || 0) > 0) return true;
    if (actorProfileRow(person.id)) return true;
    return actorMovieService.hasMergedRows(person.id);
  }

  function mainLibraryPeople(scope = "main") {
    return mainLibraryPeopleResult(scope).people;
  }

  function mainLibraryPeopleResult(scope = "main", getProfileReader = createCatalogueRowReader) {
    const library = getLibrary();
    const normalizedScope = peopleScopeService.normalize(scope);
    const scopeStamp = peopleScopeService.cacheKey();
    const cacheKey = `${normalizedScope}:${getStamp()}:${scopeStamp}:${library.people?.length || 0}`;
    const cached = mainPeopleCache.get(cacheKey);
    if (cached) return { people: cached, cacheable: true };
    const candidates = [];
    const seen = new Set();
    let readProfile;
    const matchesScope = peopleScopeService.personMatcher?.(normalizedScope)
      || ((person) => peopleScopeService.personMatches(person, normalizedScope));
    const mergedPeople = personMergeService.records?.(library.people)
      || library.people.map((person) => personMergeService.record(person));
    for (const merged of mergedPeople) {
      if (!merged || seen.has(merged.id)) continue;
      seen.add(merged.id);
      if (!matchesScope(merged)) continue;
      const known = Number(merged.workCount || 0) > 0 || Boolean((readProfile ??= getProfileReader())(merged.id));
      candidates.push({ person: merged, known });
    }
    const pending = candidates.filter(candidate => !candidate.known);
    // One membership read per list also bounds retries while the DB is failing.
    const membership = typeof actorMovieService.hasMergedRowsResultForPeople === "function"
      ? actorMovieService.hasMergedRowsResultForPeople(pending.map(candidate => candidate.person.id))
      : { matches: new Set(pending.filter(candidate => actorMovieService.hasMergedRows(candidate.person.id))
          .map(candidate => String(candidate.person.id))), cacheable: true };
    const people = candidates.filter(candidate => candidate.known || membership.matches.has(String(candidate.person.id)))
      .map(candidate => candidate.person);
    const cacheable = readProfile?.cacheable !== false && membership.cacheable !== false;
    if (cacheable) {
      mainPeopleCache.set(cacheKey, people);
      while (mainPeopleCache.size > 6) {
        mainPeopleCache.delete(mainPeopleCache.keys().next().value);
      }
    }
    return { people, cacheable };
  }

  return {
    mainLibraryPeople,
    mainLibraryPeopleResult,
    shouldShowPersonInMainList
  };
}

export function createPersonListService({
  actorProfileRow,
  actorMovieService,
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
    const library = getLibrary();
    const normalizedScope = peopleScopeService.normalize(scope);
    const cacheKey = `${normalizedScope}:${getStamp()}:${library.people?.length || 0}`;
    const cached = mainPeopleCache.get(cacheKey);
    if (cached) return cached;
    const candidates = [];
    const seen = new Set();
    for (const person of library.people) {
      const merged = personMergeService.record(person);
      if (!merged || seen.has(merged.id)) continue;
      seen.add(merged.id);
      if (!peopleScopeService.personMatches(merged, normalizedScope)) continue;
      candidates.push({ person: merged, known: Number(merged.workCount || 0) > 0 || Boolean(actorProfileRow(merged.id)) });
    }
    const pending = candidates.filter(candidate => !candidate.known);
    // One membership read per list also bounds retries while the DB is failing.
    const membership = typeof actorMovieService.hasMergedRowsResultForPeople === "function"
      ? actorMovieService.hasMergedRowsResultForPeople(pending.map(candidate => candidate.person.id))
      : { matches: new Set(pending.filter(candidate => actorMovieService.hasMergedRows(candidate.person.id))
          .map(candidate => String(candidate.person.id))), cacheable: true };
    const people = candidates.filter(candidate => candidate.known || membership.matches.has(String(candidate.person.id)))
      .map(candidate => candidate.person);
    if (membership.cacheable !== false) {
      mainPeopleCache.set(cacheKey, people);
      while (mainPeopleCache.size > 6) {
        mainPeopleCache.delete(mainPeopleCache.keys().next().value);
      }
    }
    return people;
  }

  return {
    mainLibraryPeople,
    shouldShowPersonInMainList
  };
}

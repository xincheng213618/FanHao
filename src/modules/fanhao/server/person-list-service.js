export function createPersonListService({
  actorProfileRow,
  actorMovieService,
  getStamp = () => "",
  getLibrary,
  peopleScopeService,
  personMergeService
}) {
  const mainPeopleCache = { key: "", people: null };

  function shouldShowPersonInMainList(person) {
    if (!person) return false;
    if (Number(person.workCount || 0) > 0) return true;
    if (actorProfileRow(person.id)) return true;
    return actorMovieService.mergedRows(person.id).length > 0;
  }

  function mainLibraryPeople(scope = "main") {
    const library = getLibrary();
    const normalizedScope = peopleScopeService.normalize(scope);
    const cacheKey = `${normalizedScope}:${getStamp()}:${library.people?.length || 0}`;
    if (mainPeopleCache.key === cacheKey && mainPeopleCache.people) {
      return mainPeopleCache.people;
    }
    const people = [];
    const seen = new Set();
    for (const person of library.people) {
      const merged = personMergeService.record(person);
      if (!merged || seen.has(merged.id)) continue;
      seen.add(merged.id);
      if (!peopleScopeService.personMatches(merged, normalizedScope)) continue;
      if (shouldShowPersonInMainList(merged)) people.push(merged);
    }
    mainPeopleCache.key = cacheKey;
    mainPeopleCache.people = people;
    return people;
  }

  return {
    mainLibraryPeople,
    shouldShowPersonInMainList
  };
}

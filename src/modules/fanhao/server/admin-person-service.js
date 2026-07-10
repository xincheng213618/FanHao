export function createAdminPersonService({
  actorMovieService,
  enrichLocalWorksWithActorMovieInfo,
  getLibrary,
  pagedWorksPayload,
  personLibraryService,
  publicPerson,
  resolveLibraryPersonByPublicId,
  sortWorkList
}) {
  function mappingPayload(personId, url) {
    const person = resolveLibraryPersonByPublicId(personId);
    if (!person) return null;
    const extraSourcePaths = url.searchParams.getAll("sourcePath");
    return {
      ok: true,
      person: publicPerson(person),
      sourceCandidates: personLibraryService.sourceCandidates(person, { extraSourcePaths })
    };
  }

  function rescanPersonPayload(body = {}, url) {
    const person = resolveLibraryPersonByPublicId(body.personId);
    if (!person) return null;

    const nextPerson = personLibraryService.refreshPerson(person.id, {
      sourcePaths: Array.isArray(body.sourcePaths) ? body.sourcePaths : []
    });
    const library = getLibrary();
    const actorRows = actorMovieService.rows(nextPerson.id);
    const rawWorks = nextPerson.works
      .map((workId) => library.worksById.get(workId))
      .filter(Boolean);
    const works = sortWorkList(
      enrichLocalWorksWithActorMovieInfo(rawWorks, actorRows),
      url.searchParams.get("sort") || "title"
    );
    return {
      ok: true,
      person: publicPerson(nextPerson),
      ...pagedWorksPayload(works, url, {})
    };
  }

  return {
    mappingPayload,
    rescanPersonPayload
  };
}

export function createAdminPersonService({
  actorMovieService,
  corePersonFallbackRecord = () => null,
  enrichLocalWorksWithActorMovieInfo,
  getLibrary,
  pagedWorksPayload,
  personFolderMutationService,
  personLibraryService,
  publicPerson,
  resolveLibraryPersonByPublicId,
  sortWorkList
}) {
  function mappingPayload(personId, url) {
    const person = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
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

    const refreshResult = personLibraryService.refreshPerson(person.id, {
      sourcePaths: Array.isArray(body.sourcePaths) ? body.sourcePaths : []
    });
    const nextPerson = refreshResult.person;
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
      removedLocalWorkCount: refreshResult.removedLocalWorkCount,
      removedWorkCount: refreshResult.removedWorkCount,
      removedWorkIds: refreshResult.removedWorkIds,
      person: publicPerson(nextPerson),
      ...pagedWorksPayload(works, url, {})
    };
  }

  function mutatePersonFolderPayload(body = {}, mode = "rename") {
    const result = mode === "relink"
      ? personFolderMutationService.relinkPersonFolder(body)
      : personFolderMutationService.renamePersonFolder(body);
    const person = resolveLibraryPersonByPublicId(body.personId) || corePersonFallbackRecord(body.personId);
    return {
      ...result,
      person: person ? publicPerson(person) : null
    };
  }

  return {
    mappingPayload,
    mutatePersonFolderPayload,
    rescanPersonPayload
  };
}

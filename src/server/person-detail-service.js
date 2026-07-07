export function createPersonDetailService({
  actorProfileMergeCandidates,
  actorProfileRow,
  adminCoreMutationService,
  coreMissingWorksForPerson,
  corePersonFallbackRecord,
  dedupeWorksForDisplay,
  enrichLocalWorksWithActorMovieInfo,
  library,
  manualCoverStateService,
  maxActorAvatarBytes,
  mergedActorMovieRows,
  mergedPersonRecord,
  missingActorWorksForPerson,
  peopleScopeService,
  publicActorProfile,
  publicPerson,
  resolveLibraryPersonByPublicId,
  storedWorkCodeKey,
  workLocalMutationService,
  workCodeKeySetForWorks,
  workQueryService,
}) {
  const coverBodyLimit = Math.ceil(maxActorAvatarBytes * 1.4) + 128 * 1024;

  function actorProfilePayload(personId) {
    const person = resolveLibraryPersonByPublicId(personId);
    if (!person) return null;
    return { profile: publicActorProfile(actorProfileRow(person.id)) };
  }

  function updateActorProfile(personId, body) {
    const person = resolveLibraryPersonByPublicId(personId);
    if (!person) return null;

    const profile = adminCoreMutationService.upsertActorProfile(person, body);
    const mergeCandidates = actorProfileMergeCandidates(person.id, [
      profile?.displayName,
      ...(profile?.aliases || [])
    ]);
    return { ok: true, profile, mergeCandidates };
  }

  function setCover(personId, body) {
    const result = body.imageBase64 || body.avatarBase64
      ? manualCoverStateService.setPersonUploadedCover(personId, body)
      : manualCoverStateService.setPersonManualCover(personId, body.workId || "");
    return { ok: true, ...result };
  }

  function mergeIntoTarget(targetPersonId, body) {
    const result = adminCoreMutationService.mergePeopleIntoTarget(targetPersonId, body.sourcePersonIds || body.sources || []);
    return { ok: true, ...result };
  }

  function detailPayload(personId, url) {
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const rawPerson = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    const person = mergedPersonRecord(rawPerson);
    if (!person || !peopleScopeService.personMatches(person, scope)) return null;

    const filter = url.searchParams.get("filter") || "all";
    const actorRows = mergedActorMovieRows(person.id);
    const rawLocalWorks = person.works
      .map((workId) => library.worksById.get(workId))
      .filter((work) => work && peopleScopeService.workMatches(work, scope));
    const localWorks = enrichLocalWorksWithActorMovieInfo(rawLocalWorks, actorRows);
    const personLocalCodeKeys = workCodeKeySetForWorks(rawLocalWorks);
    const coreMissingWorks = scope === "western" ? [] : coreMissingWorksForPerson(person, personLocalCodeKeys);
    const coreMissingKeys = new Set(coreMissingWorks.map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title)).filter(Boolean));
    const missingWorks = [
      ...coreMissingWorks,
      ...(scope === "western" ? [] : missingActorWorksForPerson(person, actorRows, personLocalCodeKeys)).filter((work) => {
        const key = storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title);
        return !key || !coreMissingKeys.has(key);
      })
    ];
    const allPersonWorks = dedupeWorksForDisplay([...localWorks, ...missingWorks]);
    return {
      person: publicPerson(person, {
        actorMovieCount: actorRows.length,
        missingLocalWorkCount: missingWorks.length,
        skipFallbackAvatar: scope === "western"
      }),
      ...workQueryService.listFromWorksPayload(allPersonWorks, url, {
        filter,
        facets: workQueryService.facets(allPersonWorks)
      })
    };
  }

  function deleteLocalFiles(personId) {
    const result = workLocalMutationService.deletePersonLocalFiles(personId);
    const rawPerson = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    const person = mergedPersonRecord(rawPerson) || rawPerson;
    return {
      ok: result.failedCount === 0,
      ...result,
      person: person ? publicPerson(person) : null
    };
  }

  return {
    actorProfilePayload,
    coverBodyLimit,
    deleteLocalFiles,
    detailPayload,
    mergeIntoTarget,
    setCover,
    updateActorProfile
  };
}

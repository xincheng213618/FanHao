export function createPersonDetailService({
  actorProfileMergeCandidates,
  actorProfileRow,
  coreMissingWorksForPerson,
  corePersonFallbackRecord,
  dedupeWorksForDisplay,
  deletePersonLocalFiles,
  enrichLocalWorksWithActorMovieInfo,
  library,
  maxActorAvatarBytes,
  mergePeopleIntoTarget,
  mergedActorMovieRows,
  mergedPersonRecord,
  missingActorWorksForPerson,
  normalizePeopleScope,
  pagedWorksPayload,
  personMatchesPeopleScope,
  publicActorProfile,
  publicPerson,
  resolveLibraryPersonByPublicId,
  setPersonManualCover,
  setPersonUploadedCover,
  sortWorkList,
  storedWorkCodeKey,
  upsertActorProfile,
  workCodeKeySetForWorks,
  workFacets,
  workMatchesFilter,
  workMatchesPeopleScope
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

    const profile = upsertActorProfile(person, body);
    const mergeCandidates = actorProfileMergeCandidates(person.id, [
      profile?.displayName,
      ...(profile?.aliases || [])
    ]);
    return { ok: true, profile, mergeCandidates };
  }

  function setCover(personId, body) {
    const result = body.imageBase64 || body.avatarBase64
      ? setPersonUploadedCover(personId, body)
      : setPersonManualCover(personId, body.workId || "");
    return { ok: true, ...result };
  }

  function mergeIntoTarget(targetPersonId, body) {
    const result = mergePeopleIntoTarget(targetPersonId, body.sourcePersonIds || body.sources || []);
    return { ok: true, ...result };
  }

  function detailPayload(personId, url) {
    const scope = normalizePeopleScope(url.searchParams.get("scope"));
    const rawPerson = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    const person = mergedPersonRecord(rawPerson);
    if (!person || !personMatchesPeopleScope(person, scope)) return null;

    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const actorRows = mergedActorMovieRows(person.id);
    const rawLocalWorks = person.works
      .map((workId) => library.worksById.get(workId))
      .filter((work) => work && workMatchesPeopleScope(work, scope));
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
    const works = sortWorkList(allPersonWorks.filter((work) => workMatchesFilter(work, filter)), sort);
    return {
      person: publicPerson(person, {
        actorMovieCount: actorRows.length,
        missingLocalWorkCount: missingWorks.length,
        skipFallbackAvatar: scope === "western"
      }),
      ...pagedWorksPayload(works, url, { filter, facets: workFacets(allPersonWorks) })
    };
  }

  function deleteLocalFiles(personId) {
    const result = deletePersonLocalFiles(personId);
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

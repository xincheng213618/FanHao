import { normalizePersonWorkYear, personWorkYearOptions, worksForPersonYear } from "./person-work-year.js";

const PERSON_DETAIL_SOURCE_CACHE_LIMIT = 128;
const PERSON_DETAIL_PAGE_CACHE_LIMIT = 12;

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
  peoplePayloadStamp,
  peopleScopeService,
  publicActorProfile,
  publicPerson,
  resolveLibraryPersonByPublicId,
  storedWorkCodeKey,
  workLocalMutationService,
  workCodeKeySetForWorks,
  workQueryService,
  workQueryStamp,
  userStateStamp = () => "",
}) {
  const coverBodyLimit = Math.ceil(maxActorAvatarBytes * 1.4) + 128 * 1024;
  const detailSourceCache = new Map();
  let detailSourceCacheStamp = "";

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
    const startedAt = performance.now();
    const timings = {};
    const mark = (name) => {
      timings[name] = Math.round(performance.now() - startedAt);
    };
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const source = cachedDetailSource(personId, scope, timings, mark);
    if (!source) return null;
    mark("source");

    const pageCacheKey = detailPageCacheKey(url);
    let worksPayload = readCachedPage(source, pageCacheKey);
    if (worksPayload) {
      timings.pageCacheHit = true;
      mark("facets");
      mark("payload");
    } else {
      const filter = url.searchParams.get("filter") || "all";
      const year = normalizePersonWorkYear(url.searchParams.get("year"));
      const yearWorks = worksForPersonYear(source.works, year);
      const facets = workQueryService.lightweightFacets(yearWorks);
      mark("facets");
      worksPayload = workQueryService.listFromWorksPayload(yearWorks, url, {
        filter,
        facets
      }, { lightweightInfo: true });
      cachePage(source, pageCacheKey, worksPayload);
      mark("payload");
    }
    if (!source.person) source.person = publicPerson(source.personSource, source.personOptions);
    mark("publicPerson");
    if (timings.payload >= 500) {
      console.warn("[fanhao-person-detail-slow]", JSON.stringify({ personId: source.personId, count: source.works.length, ...timings }));
    }
    const payload = {
      categories: source.categories,
      person: source.person,
      filmographyCount: source.works.length,
      year: normalizePersonWorkYear(url.searchParams.get("year")),
      years: source.years,
      ...worksPayload
    };
    if (url.searchParams.get("timing") === "1") payload.timings = timings;
    return payload;
  }

  function cachedDetailSource(personId, scope, timings, mark) {
    const stamp = `${library.scannedAt || ""}:${peoplePayloadStamp(scope)}:${workQueryStamp()}`;
    if (detailSourceCacheStamp !== stamp) {
      detailSourceCacheStamp = stamp;
      detailSourceCache.clear();
    }

    const cacheKey = `${scope}:${String(personId || "")}`;
    if (detailSourceCache.has(cacheKey)) {
      const cached = detailSourceCache.get(cacheKey);
      detailSourceCache.delete(cacheKey);
      detailSourceCache.set(cacheKey, cached);
      timings.sourceCacheHit = true;
      return cached;
    }

    const rawPerson = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    const person = mergedPersonRecord(rawPerson);
    if (!person || !peopleScopeService.personMatches(person, scope)) {
      cacheDetailSource(cacheKey, null);
      return null;
    }
    mark("person");

    const actorRows = mergedActorMovieRows(person.id);
    mark("actorRows");
    const rawLocalWorks = person.works
      .map((workId) => library.worksById.get(workId))
      .filter((work) => work && peopleScopeService.workMatches(work, scope));
    const localWorks = enrichLocalWorksWithActorMovieInfo(rawLocalWorks, actorRows);
    const personLocalCodeKeys = workCodeKeySetForWorks(rawLocalWorks);
    mark("localWorks");
    const coreMissingWorks = scope === "western" ? [] : coreMissingWorksForPerson(person, personLocalCodeKeys);
    mark("coreMissing");
    const coreMissingKeys = new Set(coreMissingWorks.map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title)).filter(Boolean));
    const missingWorks = [
      ...coreMissingWorks,
      ...(scope === "western" ? [] : missingActorWorksForPerson(person, actorRows, personLocalCodeKeys)).filter((work) => {
        const key = storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title);
        return !key || !coreMissingKeys.has(key);
      })
    ];
    const allPersonWorks = dedupeWorksForDisplay([...localWorks, ...missingWorks]);
    mark("dedupe");
    const personOptions = {
      actorMovieCount: actorRows.length,
      missingLocalWorkCount: missingWorks.length,
      // Clients already have the indexed person and the prepared work page. Avoid
      // synchronously scanning the person's library a second time for a fallback.
      skipFallbackAvatar: true
    };
    const source = {
      categories: workQueryService.categorySummaryForWorks(allPersonWorks),
      pageCache: new Map(),
      person: null,
      personId: person.id,
      personOptions,
      personSource: person,
      years: personWorkYearOptions(allPersonWorks),
      works: allPersonWorks
    };
    cacheDetailSource(cacheKey, source);
    return source;
  }

  function detailPageCacheKey(url) {
    return [
      userStateStamp(),
      workQueryService.visibilityStamp(),
      url.searchParams.get("filter") || "all",
      normalizePersonWorkYear(url.searchParams.get("year")),
      url.searchParams.get("includeMissingLocal") || "",
      url.searchParams.get("includeCompilation") || "",
      url.searchParams.get("sort") || "releaseDesc",
      url.searchParams.get("limit") || "",
      url.searchParams.get("offset") || "0"
    ].join(":");
  }

  function readCachedPage(source, cacheKey) {
    if (!source.pageCache.has(cacheKey)) return null;
    const cached = source.pageCache.get(cacheKey);
    source.pageCache.delete(cacheKey);
    source.pageCache.set(cacheKey, cached);
    return cached;
  }

  function cachePage(source, cacheKey, payload) {
    source.pageCache.set(cacheKey, payload);
    while (source.pageCache.size > PERSON_DETAIL_PAGE_CACHE_LIMIT) {
      source.pageCache.delete(source.pageCache.keys().next().value);
    }
  }

  function cacheDetailSource(cacheKey, source) {
    detailSourceCache.set(cacheKey, source);
    while (detailSourceCache.size > PERSON_DETAIL_SOURCE_CACHE_LIMIT) {
      detailSourceCache.delete(detailSourceCache.keys().next().value);
    }
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

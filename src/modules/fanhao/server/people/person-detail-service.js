import { normalizePersonWorkYear, personWorkYearOptions, worksForPersonYear } from "./person-work-year.js";
import { createWeightedCacheBudget } from "../works/work-cache-budget.js";

const PERSON_DETAIL_SOURCE_CACHE_LIMIT = 128;
const PERSON_DETAIL_PAGE_CACHE_LIMIT = 12;
const PERSON_DETAIL_PAGE_WORK_BUDGET = 8192;
const PENDING_ACTOR_PROFILE_STATUSES = new Set(["prepared", "applying", "retry_wait"]);

function actorProfileTerminalError(operation, cause = null) {
  const status = String(operation?.status || "");
  if (!["blocked", "cancelled"].includes(status)) return null;
  const blocked = status === "blocked";
  const error = new Error(blocked
    ? "人物资料任务已被阻断，请修复原因后手动重试"
    : "人物资料任务已取消");
  error.code = blocked ? "ACTOR_PROFILE_BLOCKED" : "ACTOR_PROFILE_CANCELLED";
  error.statusCode = 409;
  error.operation = operation;
  if (cause) error.cause = cause;
  return error;
}

export function relatedLocalWorksForPerson({
  library,
  person,
  relatedWorkIds = [],
  workMatches = () => true
}) {
  const workIds = [...new Set([
    ...(person?.works || []),
    ...(relatedWorkIds || [])
  ].map((workId) => String(workId || "")).filter(Boolean))];

  return workIds
    .map((workId) => library.worksById.get(workId))
    .filter((work) => work && workMatches(work))
    .map((work) => ({
      ...work,
      personId: String(person.id || ""),
      personName: person.name || ""
    }));
}

export function personRecordWithRelatedLocalWorks(person, localWorks = []) {
  const works = [...new Map(localWorks.map((work) => [String(work.id || ""), work])).values()];
  return {
    ...person,
    coverId: person.coverId || works.find((work) => work.coverId)?.coverId || null,
    workCount: works.length,
    videoCount: works.reduce((sum, work) => sum + Number(work.videoCount || 0), 0),
    playableCount: works.reduce((sum, work) => sum + Number(work.playableCount || 0), 0),
    imageCount: works.reduce((sum, work) => sum + Number(work.imageCount || 0), 0),
    infoCount: works.reduce((sum, work) => sum + Number(work.infoCount || 0), 0),
    works: works.map((work) => String(work.id || "")).filter(Boolean)
  };
}

export function createPersonDetailService({
  actorProfileMergeCandidates,
  actorProfilePublicationLifecycleService = null,
  actorProfileRow,
  adminCoreMutationService,
  coreLocalWorkIdsForPeople = () => [],
  coreMissingWorksForPerson,
  corePersonFallbackRecord,
  dedupeWorksForDisplay,
  emptyPersonCleanupService,
  enrichLocalWorksWithActorMovieInfo,
  library,
  manualCoverStateService,
  maxActorAvatarBytes,
  mergedActorMovieRowsResult = null,
  mergedActorMovieRows,
  mergedPersonMembers = (personId) => [{ id: personId }],
  mergedPersonRecord,
  missingActorWorksResultForPerson = null,
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
  withWorkInfoReadStatus = (callback) => ({ value: callback(), cacheable: true }),
  workInfoReadCacheable = () => true,
  userStateStamp = () => "",
}) {
  const coverBodyLimit = Math.ceil(maxActorAvatarBytes * 1.4) + 128 * 1024;
  const detailSourceCache = new Map();
  const detailPageBudget = createWeightedCacheBudget(PERSON_DETAIL_PAGE_WORK_BUDGET,
    PERSON_DETAIL_SOURCE_CACHE_LIMIT * PERSON_DETAIL_PAGE_CACHE_LIMIT);
  let detailSourceCacheStamp = "";

  function completedActorProfilePayload(person, profile = publicActorProfile(actorProfileRow(person.id))) {
    const mergeCandidates = actorProfileMergeCandidates(person.id, [
      profile?.displayName,
      ...(profile?.aliases || [])
    ]);
    return { ok: true, profile, mergeCandidates };
  }

  function actorProfilePayload(personId) {
    const person = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    if (!person) return null;
    return completedActorProfilePayload(person);
  }

  function updateActorProfile(personId, body) {
    const person = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    if (!person) return null;

    let result = null;
    try {
      result = adminCoreMutationService.upsertActorProfile(person, body);
    } catch (error) {
      throw actorProfileTerminalError(error?.operation, error) || error;
    }
    if (result?.completed === false) {
      const terminal = actorProfileTerminalError(result.operation);
      if (terminal) throw terminal;
      if (!PENDING_ACTOR_PROFILE_STATUSES.has(String(result.operation?.status || ""))) {
        const error = new Error("人物资料任务状态暂时不可确认，请使用同一请求键重试");
        error.code = "ACTOR_PROFILE_PENDING";
        error.statusCode = 503;
        error.retryable = true;
        error.operation = result.operation;
        throw error;
      }
      if (body?.acceptAsyncOperation === true) {
        return { statusCode: 202, payload: { ok: true, operation: result.operation } };
      }
      const error = new Error("人物资料任务仍在恢复中，请使用同一请求键重试");
      error.code = "ACTOR_PROFILE_PENDING";
      error.statusCode = 503;
      error.retryable = true;
      error.operation = result.operation;
      throw error;
    }
    const profile = result?.completed === true ? result.profile : result;
    return { statusCode: 200, payload: completedActorProfilePayload(person, profile) };
  }

  function actorProfileOperation(operationId) {
    return adminCoreMutationService.actorProfileOperation(operationId);
  }

  function retryActorProfileOperation(operationId) {
    return adminCoreMutationService.retryActorProfileOperation(operationId);
  }

  function revokeActorProfileVersion(personId, operationId, options = {}) {
    return actorProfilePublicationLifecycleService?.revokeVersion(personId, operationId, options) || null;
  }

  function collectRevokedActorProfileImages() {
    if (!actorProfilePublicationLifecycleService?.isReady?.()) {
      const error = new Error("人物头像撤销服务尚未就绪");
      error.code = "ACTOR_PROFILE_LIFECYCLE_NOT_READY";
      error.statusCode = 503;
      throw error;
    }
    return actorProfilePublicationLifecycleService.drainRevoked();
  }

  function setCover(personId, body) {
    const result = body.imageBase64 || body.avatarBase64
      ? manualCoverStateService.setPersonUploadedCover(personId, body)
      : manualCoverStateService.setPersonManualCover(personId, body.workId || "");
    return { ok: true, ...result };
  }

  function mergeIntoTarget(targetPersonId, body) {
    const result = adminCoreMutationService.mergePeopleIntoTarget(
      targetPersonId,
      body.sourcePersonIds || body.sources || [],
      { preserveSourceNames: body.preserveSourceNames !== false, preview: body.preview === true,
        displayName: body.displayName, confirmDifferentExternalIds: body.confirmDifferentExternalIds === true }
    );
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

    const requestKeys = detailPageCacheKey(url);
    const pageCacheKey = requestKeys.page;
    let worksPayload = readCachedPage(source, pageCacheKey);
    if (worksPayload) {
      timings.pageCacheHit = true;
      mark("facets");
      mark("payload");
    } else {
      const filter = url.searchParams.get("filter") || "all";
      const year = normalizePersonWorkYear(url.searchParams.get("year"));
      const yearWorks = source.filterCache.get(requestKeys.filter)?.sourceWorks
        || worksForPersonYear(source.works, year);
      const facets = workQueryService.lightweightFacets(yearWorks);
      mark("facets");
      worksPayload = workQueryService.listFromWorksPayload(yearWorks, url, {
        filter,
        facets
      }, { lightweightInfo: true, includeCoreCovers: scope === "western" }, {
        cache: source.filterCache,
        key: requestKeys.filter
      });
      if (source.cacheable !== false) cachePage(source, pageCacheKey, worksPayload);
      mark("payload");
    }
    if (!source.person) source.person = publicPerson(source.personSource, source.personOptions);
    mark("publicPerson");
    if (timings.payload >= 500) {
      console.warn("[fanhao-person-detail-slow]", JSON.stringify({ personId: source.personId, count: source.works.length, ...timings }));
    }
    const payload = {
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
    return withWorkInfoReadStatus(() => loadDetailSource(personId, scope, timings, mark)).value;
  }

  function loadDetailSource(personId, scope, timings, mark) {
    const stamp = `${library.scannedAt || ""}:${peoplePayloadStamp(scope)}:${workQueryStamp()}`;
    if (detailSourceCacheStamp !== stamp) {
      detailSourceCacheStamp = stamp;
      detailPageBudget.clear();
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

    const actorRowsResult = mergedActorMovieRowsResult
      ? mergedActorMovieRowsResult(person.id)
      : { rows: mergedActorMovieRows(person.id), cacheable: true };
    const actorRows = actorRowsResult.rows;
    mark("actorRows");
    const relatedPersonIds = [
      person.id,
      ...mergedPersonMembers(person.id).map((member) => member.id)
    ];
    const relatedWorkIds = coreLocalWorkIdsForPeople(relatedPersonIds);
    const rawLocalWorks = relatedLocalWorksForPerson({
      library,
      person,
      relatedWorkIds,
      workMatches: (work) => peopleScopeService.workMatches(work, scope)
    });
    const personSource = personRecordWithRelatedLocalWorks(person, rawLocalWorks);
    const localWorks = enrichLocalWorksWithActorMovieInfo(rawLocalWorks, actorRows);
    const personLocalCodeKeys = workCodeKeySetForWorks(rawLocalWorks);
    mark("localWorks");
    const coreMissingWorks = scope === "western" ? [] : coreMissingWorksForPerson(personSource, personLocalCodeKeys);
    mark("coreMissing");
    const coreMissingKeys = new Set(coreMissingWorks.map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title)).filter(Boolean));
    const actorMissingResult = scope === "western"
      ? { works: [], cacheable: true }
      : missingActorWorksResultForPerson
        ? missingActorWorksResultForPerson(personSource, actorRows, personLocalCodeKeys)
        : { works: missingActorWorksForPerson(personSource, actorRows, personLocalCodeKeys), cacheable: true };
    const missingWorks = [
      ...coreMissingWorks,
      ...actorMissingResult.works.filter((work) => {
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
      cacheable: actorRowsResult.cacheable !== false && actorMissingResult.cacheable !== false && workInfoReadCacheable(),
      filterCache: new Map(),
      pageCache: new Map(),
      person: null,
      personId: person.id,
      personOptions,
      personSource,
      years: personWorkYearOptions(allPersonWorks),
      works: allPersonWorks
    };
    if (source.cacheable !== false) cacheDetailSource(cacheKey, source);
    return source;
  }

  function detailPageCacheKey(url) {
    const parts = [
      userStateStamp(),
      workQueryService.visibilityStamp(),
      url.searchParams.get("filter") || "all",
      normalizePersonWorkYear(url.searchParams.get("year")),
      url.searchParams.get("includeMissingLocal") || "",
      url.searchParams.get("includeCompilation") || "",
      url.searchParams.get("sort") || "releaseDesc",
      url.searchParams.get("limit") || "",
      url.searchParams.get("offset") || "0"
    ];
    return {
      page: JSON.stringify(parts),
      filter: JSON.stringify([
        ...parts.slice(0, 4),
        !url.searchParams.has("includeMissingLocal") || parts[4] === "1",
        !url.searchParams.has("includeCompilation") || parts[5] === "1"
      ])
    };
  }

  function readCachedPage(source, cacheKey) {
    return detailPageBudget.read(source.pageCache, cacheKey) || null;
  }

  function cachePage(source, cacheKey, payload) {
    // Page DTOs outlive work-query's prepared-work LRU. Share a reference cap
    // across every person, while returning oversized pages in full.
    detailPageBudget.write(source.pageCache, cacheKey, payload, payload.count, PERSON_DETAIL_PAGE_CACHE_LIMIT);
  }

  function cacheDetailSource(cacheKey, source) {
    detailSourceCache.set(cacheKey, source);
    while (detailSourceCache.size > PERSON_DETAIL_SOURCE_CACHE_LIMIT) {
      const oldestKey = detailSourceCache.keys().next().value;
      const oldestSource = detailSourceCache.get(oldestKey);
      if (oldestSource) detailPageBudget.clear(oldestSource.pageCache);
      detailSourceCache.delete(oldestKey);
    }
  }

  function deleteLocalFiles(personId, options = {}) {
    const result = workLocalMutationService.deletePersonLocalFiles(personId, options);
    const rawPerson = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    const person = mergedPersonRecord(rawPerson) || rawPerson;
    return {
      ok: result.failedCount === 0,
      ...result,
      person: person ? publicPerson(person) : null
    };
  }

  function cleanupEmptyPerson(personId, options = {}) {
    return options.preview === true
      ? emptyPersonCleanupService.preview(personId)
      : emptyPersonCleanupService.remove(personId, options);
  }

  return {
    actorProfileOperation,
    actorProfilePayload,
    collectRevokedActorProfileImages,
    cleanupEmptyPerson,
    coverBodyLimit,
    deleteLocalFiles,
    detailPayload,
    mergeIntoTarget,
    retryActorProfileOperation,
    revokeActorProfileVersion,
    setCover,
    updateActorProfile
  };
}

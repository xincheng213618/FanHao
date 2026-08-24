export function createPeopleScopeService({
  getLibrary,
  getRevision = () => "",
  isMainExcludedWork = () => false,
  mergedPersonRecord,
  pathWithinRoot,
  sourcePathToAbsolute,
  mainExcludedRoots = [],
  westernRoots
}) {
  let peopleScopeIndexCache = null;
  let revision = 0;

  function normalize(value) {
    return String(value || "").trim().toLowerCase() === "western" ? "western" : "main";
  }

  function sourcePathWithinAnyRoot(sourcePath, roots) {
    const absolutePath = sourcePathToAbsolute(sourcePath);
    return Boolean(absolutePath && roots.some((rootPath) => pathWithinRoot(absolutePath, rootPath)));
  }

  function sourcePathInWesternRoots(sourcePath) {
    return sourcePathWithinAnyRoot(sourcePath, westernRoots);
  }

  function workInRoots(work, roots) {
    const paths = [
      work?.relativePath,
      ...(work?.videos || []).map((file) => file.relativePath || file.path),
      ...(work?.images || []).map((file) => file.relativePath || file.path),
      ...(work?.infos || []).map((file) => file.relativePath || file.path)
    ];
    return paths.some((sourcePath) => sourcePathWithinAnyRoot(sourcePath, roots));
  }

  function personInRoots(person, roots) {
    const library = getLibrary();
    const paths = [person?.relativePath, ...(person?.sourcePaths || [])].filter(Boolean);
    if (paths.some((sourcePath) => sourcePathWithinAnyRoot(sourcePath, roots))) return true;
    return (person?.works || []).some((workId) => workInRoots(library.worksById.get(workId), roots));
  }

  function personHasNonWesternLocalSource(person) {
    const library = getLibrary();
    const paths = [person?.relativePath, ...(person?.sourcePaths || [])].filter(Boolean);
    if (paths.some((sourcePath) => !sourcePathWithinAnyRoot(sourcePath, westernRoots))) return true;
    return (person?.works || []).some((workId) => {
      const work = library.worksById.get(workId);
      return work && !workInRoots(work, westernRoots);
    });
  }

  function cacheKey() {
    const library = getLibrary();
    return [
      library.scannedAt || "",
      library.people?.length || 0,
      library.worksById?.size || 0,
      library.totals?.videos || 0,
      library.totals?.images || 0,
      library.totals?.infoFiles || 0,
      westernRoots.join("|"),
      mainExcludedRoots.join("|"),
      getRevision(),
      revision
    ].join("::");
  }

  function index() {
    const key = cacheKey();
    if (peopleScopeIndexCache?.key === key) return peopleScopeIndexCache.index;

    const library = getLibrary();
    const westernWorkIds = new Set();
    const mainExcludedWorkIds = new Set();
    const knownWorkIds = new Set();
    for (const work of library.worksById.values()) {
      const workId = String(work?.id || "");
      if (!workId) continue;
      knownWorkIds.add(workId);
      if (workInRoots(work, westernRoots)) {
        westernWorkIds.add(workId);
      }
      if (isMainExcludedWork(work) || workInRoots(work, mainExcludedRoots)) {
        mainExcludedWorkIds.add(workId);
      }
    }

    // Historical core rows may contain mojibake local paths. When a person is
    // sourced only from an excluded media root, use that trusted person source
    // to exclude every linked work even if the old work path cannot be decoded.
    const mainExcludedPersonIds = new Set();
    for (const person of library.people) {
      const merged = mergedPersonRecord(person);
      const paths = [merged?.relativePath, ...(merged?.sourcePaths || [])].filter(Boolean);
      const hasMainExcludedPath = paths.some((sourcePath) => sourcePathWithinAnyRoot(sourcePath, mainExcludedRoots));
      const hasMainEligiblePath = paths.some((sourcePath) => !sourcePathWithinAnyRoot(sourcePath, mainExcludedRoots));
      if (!hasMainExcludedPath || hasMainEligiblePath) continue;
      const excludedPersonId = String(merged?.id || "");
      if (excludedPersonId) mainExcludedPersonIds.add(excludedPersonId);
      for (const workId of merged?.works || []) {
        const normalizedWorkId = String(workId || "");
        if (knownWorkIds.has(normalizedWorkId)) mainExcludedWorkIds.add(normalizedWorkId);
      }
    }
    for (const work of library.worksById.values()) {
      const workId = String(work?.id || "");
      if (workId && mainExcludedPersonIds.has(String(work?.personId || ""))) {
        mainExcludedWorkIds.add(workId);
      }
    }

    const westernPersonIds = new Set();
    const mainPersonIds = new Set();
    const knownPersonIds = new Set();
    const seen = new Set();
    for (const person of library.people) {
      const merged = mergedPersonRecord(person);
      const personId = String(merged?.id || "");
      if (!personId || seen.has(personId)) continue;
      seen.add(personId);
      knownPersonIds.add(personId);

      const paths = [merged.relativePath, ...(merged.sourcePaths || [])].filter(Boolean);
      const hasWesternPath = paths.some(sourcePathInWesternRoots);
      const hasNonWesternPath = paths.some((sourcePath) => !sourcePathInWesternRoots(sourcePath));
      const hasMainExcludedPath = paths.some((sourcePath) => sourcePathWithinAnyRoot(sourcePath, mainExcludedRoots));
      const hasMainEligiblePath = paths.some((sourcePath) => !sourcePathWithinAnyRoot(sourcePath, mainExcludedRoots));
      const workIds = (merged.works || []).map((workId) => String(workId || "")).filter(Boolean);
      const hasWesternWork = workIds.some((workId) => westernWorkIds.has(workId));
      const hasNonWesternWork = workIds.some(
        (workId) => knownWorkIds.has(workId) && !westernWorkIds.has(workId)
      );
      const hasMainExcludedWork = workIds.some((workId) => mainExcludedWorkIds.has(workId));
      const hasMainEligibleWork = workIds.some(
        (workId) => knownWorkIds.has(workId) && !mainExcludedWorkIds.has(workId)
      );
      const isWestern = hasWesternPath || hasWesternWork;
      const isMainExcludedOnly = (hasMainExcludedPath || hasMainExcludedWork) && !hasMainEligiblePath && !hasMainEligibleWork;

      if (isWestern) westernPersonIds.add(personId);
      if (!isMainExcludedOnly && (!isWestern || hasNonWesternPath || hasNonWesternWork)) mainPersonIds.add(personId);
    }

    const nextIndex = { westernWorkIds, mainExcludedWorkIds, mainExcludedPersonIds, knownWorkIds, westernPersonIds, mainPersonIds, knownPersonIds };
    peopleScopeIndexCache = { key, index: nextIndex };
    return nextIndex;
  }

  function personMatches(person, scope) {
    const normalizedScope = normalize(scope);
    const scopeIndex = index();
    const personId = String(person?.id || "");
    if (personId && scopeIndex.knownPersonIds.has(personId)) {
      return normalizedScope === "western"
        ? scopeIndex.westernPersonIds.has(personId)
        : scopeIndex.mainPersonIds.has(personId);
    }
    const isWestern = personInRoots(person, westernRoots);
    return normalizedScope === "western"
      ? isWestern
      : !isWestern || personHasNonWesternLocalSource(person);
  }

  function workMatches(work, scope) {
    const normalizedScope = normalize(scope);
    const scopeIndex = index();
    const workId = String(work?.id || "");
    if (normalizedScope === "main") {
      if (workId && scopeIndex.knownWorkIds.has(workId)) return !scopeIndex.mainExcludedWorkIds.has(workId);
      return !isMainExcludedWork(work) && !workInRoots(work, mainExcludedRoots);
    }
    if (workId && scopeIndex.knownWorkIds.has(workId)) {
      return scopeIndex.westernWorkIds.has(workId);
    }
    return workInRoots(work, westernRoots);
  }

  function workMatchesDirect(work, scope) {
    return normalize(scope) === "main"
      ? !isMainExcludedWork(work) && !workInRoots(work, mainExcludedRoots)
      : workInRoots(work, westernRoots);
  }

  function invalidate() {
    peopleScopeIndexCache = null;
    revision += 1;
  }

  return {
    cacheKey,
    index,
    invalidate,
    normalize,
    personHasNonWesternLocalSource,
    personInRoots,
    personMatches,
    sourcePathInWesternRoots,
    sourcePathWithinAnyRoot,
    workInRoots,
    workMatches,
    workMatchesDirect
  };
}

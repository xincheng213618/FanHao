export function createPeopleScopeService({
  getLibrary,
  mergedPersonRecord,
  pathWithinRoot,
  sourcePathToAbsolute,
  westernRoots
}) {
  let peopleScopeIndexCache = null;

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
      westernRoots.join("|")
    ].join("::");
  }

  function index() {
    const key = cacheKey();
    if (peopleScopeIndexCache?.key === key) return peopleScopeIndexCache.index;

    const library = getLibrary();
    const westernWorkIds = new Set();
    const knownWorkIds = new Set();
    for (const work of library.worksById.values()) {
      const workId = String(work?.id || "");
      if (!workId) continue;
      knownWorkIds.add(workId);
      if (workInRoots(work, westernRoots)) {
        westernWorkIds.add(workId);
      }
    }

    const westernPersonIds = new Set();
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
      const workIds = (merged.works || []).map((workId) => String(workId || "")).filter(Boolean);
      const hasWesternWork = workIds.some((workId) => westernWorkIds.has(workId));
      const isWestern = hasWesternPath || hasWesternWork;

      if (isWestern) westernPersonIds.add(personId);
    }

    const nextIndex = { westernWorkIds, knownWorkIds, westernPersonIds, knownPersonIds };
    peopleScopeIndexCache = { key, index: nextIndex };
    return nextIndex;
  }

  function personMatches(person, scope) {
    const normalizedScope = normalize(scope);
    if (normalizedScope === "main") return true;
    const scopeIndex = index();
    const personId = String(person?.id || "");
    if (personId && scopeIndex.knownPersonIds.has(personId)) {
      return scopeIndex.westernPersonIds.has(personId);
    }
    return personInRoots(person, westernRoots);
  }

  function workMatches(work, scope) {
    const normalizedScope = normalize(scope);
    if (normalizedScope === "main") return true;
    const scopeIndex = index();
    const workId = String(work?.id || "");
    if (workId && scopeIndex.knownWorkIds.has(workId)) {
      return scopeIndex.westernWorkIds.has(workId);
    }
    return workInRoots(work, westernRoots);
  }

  function invalidate() {
    peopleScopeIndexCache = null;
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
    workMatches
  };
}

import path from "node:path";

function recalculateLibraryTotals(library) {
  library.scannedAt = new Date().toISOString();
  library.totals.people = library.people.length;
  library.totals.works = library.worksById.size;
  const files = [...library.filesById.values()];
  library.totals.videos = files.filter((file) => file.type === "video").length;
  library.totals.playableVideos = files.filter((file) => file.type === "video" && file.playable).length;
  library.totals.images = files.filter((file) => file.type === "image").length;
  library.totals.infoFiles = files.filter((file) => file.type === "info").length;
}

function personRecordFromWorks(person, sourcePaths, works, compareNaturalTitle) {
  const sortedWorks = works.sort(compareNaturalTitle);
  const coverId = sortedWorks.find((work) => work.coverId)?.coverId || null;
  const videoCount = sortedWorks.reduce((sum, work) => sum + work.videoCount, 0);
  const playableCount = sortedWorks.reduce((sum, work) => sum + work.playableCount, 0);
  const infoCount = sortedWorks.reduce((sum, work) => sum + work.infoCount, 0);
  const imageCount = sortedWorks.reduce((sum, work) => sum + work.imageCount, 0);
  const modifiedAt = sortedWorks
    .map((work) => work.modifiedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    id: person.id,
    name: person.name,
    relativePath: sourcePaths[0] || person.relativePath || "",
    sourcePaths,
    sourceCount: sourcePaths.length,
    coverId,
    workCount: sortedWorks.length,
    videoCount,
    playableCount,
    imageCount,
    infoCount,
    modifiedAt,
    works: sortedWorks.map((work) => work.id)
  };
}

export function createPersonLibraryService({
  actorProfileSearchNames,
  compareNaturalTitle,
  getLibrary,
  libraryIndexService,
  libraryOpenRoots,
  libraryRoots,
  normalizeSourcePath,
  pathWithinRoot,
  relativeFromRoot,
  rootLabel,
  safeStat,
  scanPersonDirectory,
  sourcePathToAbsolute,
  warn = console.warn
}) {
  function sourcePathCandidates(person, options = {}) {
    if (Array.isArray(options.sourcePaths) && options.sourcePaths.length) {
      const selected = [];
      const seenSelected = new Set();
      for (const sourcePath of options.sourcePaths) {
        const absolutePath = sourcePathToAbsolute(sourcePath);
        const stat = absolutePath ? safeStat(absolutePath) : null;
        if (!stat?.isDirectory() || !libraryOpenRoots().some((rootPath) => pathWithinRoot(absolutePath, rootPath))) continue;
        const normalized = relativeFromRoot(absolutePath);
        const key = normalizeSourcePath(normalized);
        if (!key || seenSelected.has(key)) continue;
        seenSelected.add(key);
        selected.push(normalized);
      }
      return selected;
    }

    const sourcePaths = [];
    const seen = new Set();
    const addSourcePath = (sourcePath) => {
      const normalized = String(sourcePath || "").trim();
      if (!normalized) return;
      const key = normalizeSourcePath(normalized);
      if (!key || seen.has(key)) return;
      seen.add(key);
      sourcePaths.push(normalized);
    };

    for (const name of actorProfileSearchNames(person)) {
      if (!name || /[\\/]/.test(name)) continue;
      for (const rootPath of libraryRoots) {
        const absolutePath = path.join(rootPath, name);
        const stat = safeStat(absolutePath);
        if (stat?.isDirectory()) addSourcePath(relativeFromRoot(absolutePath));
      }
    }

    for (const sourcePath of [...(person.sourcePaths || []), person.relativePath]) {
      const absolutePath = sourcePathToAbsolute(sourcePath);
      const stat = absolutePath ? safeStat(absolutePath) : null;
      if (stat?.isDirectory()) addSourcePath(relativeFromRoot(absolutePath));
    }

    return sourcePaths;
  }

  function sourceCandidates(person, options = {}) {
    const currentKeys = new Set([...(person.sourcePaths || []), person.relativePath].filter(Boolean).map(normalizeSourcePath));
    const records = [];
    const seen = new Set();
    const addRecord = (absolutePath, sourceName, reason) => {
      if (!absolutePath) return;
      const sourcePath = relativeFromRoot(absolutePath);
      const key = normalizeSourcePath(sourcePath);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const stat = safeStat(absolutePath);
      const rootIndex = libraryRoots.findIndex((rootPath) => pathWithinRoot(absolutePath, rootPath));
      records.push({
        sourcePath,
        root: rootIndex >= 0 ? rootLabel(libraryRoots[rootIndex]) : "",
        sourceName: sourceName || path.basename(absolutePath),
        exists: Boolean(stat?.isDirectory()),
        selected: currentKeys.has(key),
        reason,
        priority: rootIndex >= 0 ? rootIndex : 999
      });
    };

    for (const name of actorProfileSearchNames(person)) {
      if (!name || /[\\/]/.test(name)) continue;
      for (const rootPath of libraryRoots) {
        addRecord(path.join(rootPath, name), name, "name");
      }
    }

    for (const sourcePath of [...(person.sourcePaths || []), person.relativePath]) {
      const absolutePath = sourcePathToAbsolute(sourcePath);
      addRecord(absolutePath, path.basename(absolutePath || sourcePath), "current");
    }

    for (const sourcePath of Array.isArray(options.extraSourcePaths) ? options.extraSourcePaths : []) {
      const absolutePath = sourcePathToAbsolute(sourcePath);
      addRecord(absolutePath, path.basename(absolutePath || sourcePath), "manual");
    }

    return records.sort((a, b) =>
      Number(b.selected) - Number(a.selected) ||
      Number(b.exists) - Number(a.exists) ||
      a.priority - b.priority ||
      a.sourcePath.localeCompare(b.sourcePath, undefined, { numeric: true, sensitivity: "base" })
    );
  }

  function refreshPerson(personId, options = {}) {
    const library = getLibrary();
    const person = library.peopleById.get(personId);
    if (!person) {
      const error = new Error("人物不存在");
      error.statusCode = 404;
      throw error;
    }

    const selectedSourcePaths = sourcePathCandidates(person, options);
    if (!selectedSourcePaths.length) {
      const error = new Error("这个人物没有本地来源路径");
      error.statusCode = 400;
      throw error;
    }

    const works = [];
    const existingSourcePaths = [];
    for (const sourcePath of selectedSourcePaths) {
      const absolutePath = sourcePathToAbsolute(sourcePath);
      const stat = safeStat(absolutePath);
      if (!stat?.isDirectory()) continue;
      existingSourcePaths.push(relativeFromRoot(absolutePath));
      works.push(...scanPersonDirectory(person.id, absolutePath));
    }

    if (!existingSourcePaths.length) {
      const error = new Error("本地人物文件夹不存在");
      error.statusCode = 404;
      throw error;
    }

    for (const workId of person.works || []) {
      const oldWork = library.worksById.get(workId);
      if (!oldWork) continue;
      for (const file of [...(oldWork.videos || []), ...(oldWork.images || []), ...(oldWork.infos || [])]) {
        library.filesById.delete(file.id);
      }
      library.worksById.delete(workId);
    }

    for (const work of works) {
      libraryIndexService.registerWorkFiles(library, work);
      library.worksById.set(work.id, work);
      try {
        libraryIndexService.replaceLocalFilesForWork(work);
      } catch (error) {
        warn("[core-local-files]", error.message);
      }
    }

    const nextPerson = personRecordFromWorks(person, existingSourcePaths, works, compareNaturalTitle);
    const personIndex = library.people.findIndex((item) => item.id === person.id);
    if (personIndex >= 0) library.people[personIndex] = nextPerson;
    library.peopleById.set(person.id, nextPerson);
    recalculateLibraryTotals(library);
    libraryIndexService.saveCache(library);
    libraryIndexService.invalidateDerivedCaches?.();
    return nextPerson;
  }

  return {
    refreshPerson,
    sourceCandidates,
    sourcePathCandidates
  };
}

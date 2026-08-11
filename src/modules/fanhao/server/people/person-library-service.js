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

function workFiles(work) {
  return [...(work?.videos || []), ...(work?.images || []), ...(work?.infos || [])];
}

export function removeLocalWorksFromLibrary(library, workIds, compareNaturalTitle) {
  const requestedIds = new Set((workIds || []).map((workId) => String(workId || "")).filter(Boolean));
  const removedWorks = [...requestedIds]
    .map((workId) => library.worksById.get(workId))
    .filter(Boolean);
  if (!removedWorks.length) {
    return { removedWorkIds: [], affectedPersonIds: [] };
  }

  const removedWorkIds = new Set(removedWorks.map((work) => String(work.id)));
  const affectedPersonIds = new Set(removedWorks.map((work) => String(work.personId || "")).filter(Boolean));
  const candidateFiles = new Map();
  const removedFileRefs = new Map();
  for (const work of removedWorks) {
    for (const file of workFiles(work)) {
      if (file?.id && !candidateFiles.has(file.id)) candidateFiles.set(file.id, file);
      if (file?.id) removedFileRefs.set(file.id, Number(removedFileRefs.get(file.id) || 0) + 1);
    }
    library.worksById.delete(String(work.id));
  }

  const removedFileCounts = {
    videos: 0,
    playableVideos: 0,
    images: 0,
    infoFiles: 0
  };
  for (const [fileId, candidateFile] of candidateFiles) {
    const previousRefs = Number(library.fileRefCounts?.get(fileId) || 1);
    const remainingRefs = Math.max(0, previousRefs - Number(removedFileRefs.get(fileId) || 0));
    if (remainingRefs > 0) {
      library.fileRefCounts?.set(fileId, remainingRefs);
      if (!library.filesById.has(fileId)) library.filesById.set(fileId, candidateFile);
      continue;
    }

    library.fileRefCounts?.delete(fileId);
    const indexedFile = library.filesById.get(fileId) || candidateFile;
    if (!library.filesById.delete(fileId)) continue;
    if (indexedFile.type === "video") {
      removedFileCounts.videos += 1;
      if (indexedFile.playable) removedFileCounts.playableVideos += 1;
    } else if (indexedFile.type === "image") {
      removedFileCounts.images += 1;
    } else if (indexedFile.type === "info") {
      removedFileCounts.infoFiles += 1;
    }
  }

  for (const personId of affectedPersonIds) {
    const person = library.peopleById.get(personId);
    if (!person) continue;
    const remainingWorks = (person.works || [])
      .filter((workId) => !removedWorkIds.has(String(workId)))
      .map((workId) => library.worksById.get(String(workId)))
      .filter(Boolean);
    const personIndex = library.people.findIndex((item) => String(item.id) === personId);
    if (!remainingWorks.length) {
      if (personIndex >= 0) library.people.splice(personIndex, 1);
      library.peopleById.delete(personId);
      continue;
    }

    const sourcePaths = person.sourcePaths?.length
      ? [...person.sourcePaths]
      : [person.relativePath].filter(Boolean);
    const nextPerson = personRecordFromWorks(person, sourcePaths, remainingWorks, compareNaturalTitle);
    if (personIndex >= 0) library.people[personIndex] = nextPerson;
    library.peopleById.set(personId, nextPerson);
  }

  library.scannedAt = new Date().toISOString();
  library.totals.people = library.people.length;
  library.totals.works = library.worksById.size;
  for (const [key, removedCount] of Object.entries(removedFileCounts)) {
    library.totals[key] = Math.max(0, Number(library.totals[key] || 0) - removedCount);
  }

  return {
    removedWorkIds: [...removedWorkIds],
    affectedPersonIds: [...affectedPersonIds]
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

    const previousWorks = (person.works || [])
      .map((workId) => library.worksById.get(workId))
      .filter(Boolean);
    const previousWorksById = new Map(previousWorks.map((work) => [String(work.id), work]));
    const hasExplicitSourcePaths = Array.isArray(options.sourcePaths) && options.sourcePaths.length > 0;
    const selectedSourcePaths = sourcePathCandidates(person, options);
    const knownSourcePaths = [...(person.sourcePaths || []), person.relativePath].filter(Boolean);
    if (!selectedSourcePaths.length && (hasExplicitSourcePaths || !knownSourcePaths.length)) {
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

    for (const oldWork of previousWorks) {
      for (const file of [...(oldWork.videos || []), ...(oldWork.images || []), ...(oldWork.infos || [])]) {
        library.filesById.delete(file.id);
      }
      library.worksById.delete(oldWork.id);
    }

    for (const work of works) {
      const previousWork = previousWorksById.get(String(work.id));
      if (previousWork?.infoSummary) {
        work.infoSummary = { ...previousWork.infoSummary };
      }
      libraryIndexService.registerWorkFiles(library, work);
      library.worksById.set(work.id, work);
      try {
        libraryIndexService.replaceLocalFilesForWork(work);
      } catch (error) {
        warn("[core-local-files]", error.message);
      }
    }
    const reconciliation = libraryIndexService.reconcilePersonLocalWorks(previousWorks, works);

    const nextPerson = personRecordFromWorks(person, existingSourcePaths, works, compareNaturalTitle);
    const personIndex = library.people.findIndex((item) => item.id === person.id);
    if (personIndex >= 0) library.people[personIndex] = nextPerson;
    library.peopleById.set(person.id, nextPerson);
    recalculateLibraryTotals(library);
    libraryIndexService.saveCache(library);
    libraryIndexService.invalidateDerivedCaches?.();
    return {
      person: nextPerson,
      removedLocalWorkCount: reconciliation.deletedLocalWorkIds.length,
      removedWorkCount: reconciliation.deletedWorkIds.length,
      removedWorkIds: reconciliation.deletedWorkIds
    };
  }

  function removeLocalWorks(workIds) {
    const library = getLibrary();
    const result = removeLocalWorksFromLibrary(library, workIds, compareNaturalTitle);
    if (!result.removedWorkIds.length) return result;
    libraryIndexService.saveCache(library);
    libraryIndexService.invalidateDerivedCaches?.();
    return result;
  }

  function moveLocalWork({ beforePersonIds = [], newDir, oldDir, personDir, targetPerson, workId }) {
    const library = getLibrary();
    const normalizedWorkId = String(workId || "");
    const currentWork = library.worksById.get(normalizedWorkId);
    if (!currentWork) return { movedWorkId: normalizedWorkId, affectedPersonIds: [] };

    const relocatePath = (filePath) => {
      const absolute = path.resolve(String(filePath || ""));
      const relative = path.relative(path.resolve(oldDir), absolute);
      if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return path.join(newDir, relative);
      }
      return filePath;
    };
    const relocateFile = (file) => {
      const nextPath = relocatePath(file?.path || "");
      const nextFile = { ...file, path: nextPath, relativePath: relativeFromRoot(nextPath) };
      if (nextFile.id) library.filesById.set(nextFile.id, nextFile);
      return nextFile;
    };
    const nextWork = {
      ...currentWork,
      personId: String(targetPerson.id),
      relativePath: relativeFromRoot(newDir),
      videos: (currentWork.videos || []).map(relocateFile),
      images: (currentWork.images || []).map(relocateFile),
      infos: (currentWork.infos || []).map(relocateFile)
    };
    library.worksById.set(normalizedWorkId, nextWork);

    const affectedPersonIds = new Set([
      String(currentWork.personId || ""),
      ...beforePersonIds.map((id) => String(id || "")),
      String(targetPerson.id || "")
    ].filter(Boolean));
    for (const personId of affectedPersonIds) {
      const isTarget = personId === String(targetPerson.id);
      const currentPerson = library.peopleById.get(personId) || (isTarget ? {
        id: personId,
        name: targetPerson.name || personId,
        relativePath: targetPerson.relativePath || relativeFromRoot(personDir),
        sourcePaths: targetPerson.sourcePaths || [relativeFromRoot(personDir)],
        works: []
      } : null);
      if (!currentPerson) continue;

      const workIds = new Set((currentPerson.works || []).map(String));
      workIds.delete(normalizedWorkId);
      if (isTarget) workIds.add(normalizedWorkId);
      const works = [...workIds].map((id) => library.worksById.get(id)).filter(Boolean);
      const personIndex = library.people.findIndex((person) => String(person.id) === personId);
      if (!works.length) {
        if (personIndex >= 0) library.people.splice(personIndex, 1);
        library.peopleById.delete(personId);
        continue;
      }

      const sourcePaths = [...new Set([
        ...(currentPerson.sourcePaths || []),
        currentPerson.relativePath,
        ...(isTarget ? targetPerson.sourcePaths || [] : []),
        ...(isTarget ? [relativeFromRoot(personDir)] : [])
      ].filter(Boolean))];
      const nextPerson = personRecordFromWorks(currentPerson, sourcePaths, works, compareNaturalTitle);
      if (personIndex >= 0) library.people[personIndex] = nextPerson;
      else library.people.push(nextPerson);
      library.peopleById.set(personId, nextPerson);
    }

    recalculateLibraryTotals(library);
    libraryIndexService.saveCache(library);
    libraryIndexService.invalidateDerivedCaches?.();
    return { movedWorkId: normalizedWorkId, affectedPersonIds: [...affectedPersonIds] };
  }

  return {
    moveLocalWork,
    removeLocalWorks,
    refreshPerson,
    sourceCandidates,
    sourcePathCandidates
  };
}

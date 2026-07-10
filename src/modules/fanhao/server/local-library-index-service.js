export function createLocalLibraryIndexService({
  coreLibraryService,
  coreLibrarySyncService,
  emptyLibrary,
  getLibrary,
  invalidateDerivedCaches,
  localLibraryScanService,
  onLibraryLoaded,
  setLastScanError,
  setLibrary,
  log = console.log,
  errorLog = console.error
}) {
  function serializeLibrary(index) {
    return {
      version: 2,
      root: index.root,
      roots: index.roots,
      availableRoots: index.availableRoots,
      missingRoots: index.missingRoots,
      scannedAt: index.scannedAt,
      totals: index.totals,
      people: index.people,
      works: [...index.worksById.values()]
    };
  }

  function registerWorkFiles(index, work) {
    localLibraryScanService.registerFiles(index, [
      ...(work?.videos || []),
      ...(work?.images || []),
      ...(work?.infos || [])
    ]);
  }

  function hydrateLibrary(data) {
    const index = emptyLibrary();
    index.root = data.root || index.root;
    index.roots = data.roots || index.roots;
    index.availableRoots = data.availableRoots || [];
    index.missingRoots = data.missingRoots || [];
    index.scannedAt = data.scannedAt || null;
    index.totals = data.totals || index.totals;
    index.people = data.people || [];

    for (const person of index.people) {
      index.peopleById.set(person.id, person);
    }

    for (const work of data.works || []) {
      index.worksById.set(work.id, work);
      registerWorkFiles(index, work);
    }

    return index;
  }

  function loadCache() {
    return null;
  }

  function saveCache(index = getLibrary()) {
    return index;
  }

  function linkedScannedWork(personId, work) {
    return coreLibrarySyncService.linkedScannedWork(personId, work);
  }

  function replaceLocalFilesForWork(work) {
    return coreLibrarySyncService.replaceLocalFilesForWork(work);
  }

  function loadFromCoreDb() {
    return coreLibraryService.loadLibrary();
  }

  function loadFreshLibrary() {
    const coreLibrary = loadFromCoreDb();
    return {
      library: coreLibrary || localLibraryScanService.scanLibrary(),
      source: coreLibrary ? "core" : "scan"
    };
  }

  function announce(source, index) {
    log(
      `[${source}] ${index.totals.people} people, ${index.totals.works} works, ${index.totals.videos} videos, ${index.totals.images} images`
    );
  }

  function refreshLibrary() {
    try {
      const next = loadFreshLibrary();
      setLibrary(next.library);
      saveCache(next.library);
      invalidateDerivedCaches();
      onLibraryLoaded?.(next.library);
      setLastScanError(null);
      announce(next.source, next.library);
      return next.library;
    } catch (error) {
      setLastScanError(error);
      errorLog("[scan]", error.message);
      return null;
    }
  }

  function initializeLibrary() {
    const cachedLibrary = loadCache();
    if (cachedLibrary) {
      setLibrary(cachedLibrary);
      announce("cache", cachedLibrary);
      return cachedLibrary;
    }

    const coreLibrary = loadFromCoreDb();
    if (coreLibrary) {
      setLibrary(coreLibrary);
      invalidateDerivedCaches();
      setLastScanError(null);
      announce("core", coreLibrary);
      return coreLibrary;
    }

    return refreshLibrary();
  }

  return {
    hydrateLibrary,
    invalidateDerivedCaches,
    initializeLibrary,
    linkedScannedWork,
    loadCache,
    loadFreshLibrary,
    loadFromCoreDb,
    refreshLibrary,
    registerWorkFiles,
    replaceLocalFilesForWork,
    saveCache,
    serializeLibrary
  };
}

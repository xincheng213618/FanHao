export async function routeLibraryReadApi(req, res, url, deps) {
  const {
    appConfigService,
    getLastScanError,
    library,
    mainLibraryPeople,
    normalizePeopleScope,
    publicPerson,
    requestAccess,
    sendJson,
    userStateSummary
  } = deps;

  if (url.pathname === "/api/library" && req.method === "GET") {
    const scope = normalizePeopleScope(url.searchParams.get("scope"));
    const user = userStateSummary();
    const people = mainLibraryPeople(scope);
    const lastScanError = getLastScanError();
    sendJson(res, 200, {
      root: library.root,
      roots: library.roots,
      availableRoots: library.availableRoots,
      missingRoots: library.missingRoots,
      scannedAt: library.scannedAt,
      totals: {
        ...library.totals,
        people: people.length
      },
      user,
      uiConfig: appConfigService.publicConfig(),
      access: requestAccess(req),
      lastScanError: lastScanError?.message || null,
      scope,
      people: people.map((person) => publicPerson(person, { skipFallbackAvatar: scope === "western" }))
    });
    return true;
  }

  if (url.pathname === "/api/library/roots" && req.method === "GET") {
    sendJson(res, 200, {
      roots: library.roots || [],
      availableRoots: library.availableRoots || [],
      defaultRoot: (library.availableRoots || [])[0] || (library.roots || [])[0] || ""
    });
    return true;
  }

  return false;
}

export async function routeLibraryMutationApi(req, res, url, deps) {
  const {
    getLastScanError,
    getLibrary,
    refreshLibrary,
    requireLocalAdmin,
    sendJson,
    userStateSummary
  } = deps;

  if (url.pathname === "/api/rescan" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    refreshLibrary();
    const nextLibrary = getLibrary();
    const lastScanError = getLastScanError();
    sendJson(res, lastScanError ? 500 : 200, {
      ok: !lastScanError,
      error: lastScanError?.message || null,
      scannedAt: nextLibrary.scannedAt,
      roots: nextLibrary.roots,
      availableRoots: nextLibrary.availableRoots,
      missingRoots: nextLibrary.missingRoots,
      totals: nextLibrary.totals,
      user: userStateSummary()
    });
    return true;
  }

  return false;
}

export async function routeLibraryApi(req, res, url, deps) {
  return await routeLibraryReadApi(req, res, url, deps)
    || await routeLibraryMutationApi(req, res, url, deps);
}

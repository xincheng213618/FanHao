import { publicPersonListItem } from "../people/person-list-presenter.js";

const libraryPeoplePayloadCache = new Map();

export async function routeLibraryReadApi(req, res, url, deps) {
  const {
    appConfigService,
    getLastScanError,
    library,
    peopleScopeService,
    personListService,
    peoplePayloadStamp,
    publicPerson,
    requestAccess,
    sendJson,
    userStateSummary
  } = deps;

  if (url.pathname === "/api/library" && req.method === "GET") {
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const user = userStateSummary();
    const people = personListService.mainLibraryPeople(scope);
    const lastScanError = getLastScanError();
    const publicPeople = cachedPublicPeople({
      people,
      publicPerson,
      scope,
      stamp: typeof peoplePayloadStamp === "function" ? peoplePayloadStamp(scope) : `${library.scannedAt || ""}:${scope}:${people.length}`
    });
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
      people: publicPeople
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

function cachedPublicPeople({ people, publicPerson, scope, stamp }) {
  const cacheKey = `${scope}:${stamp}:${people.length}`;
  const cached = libraryPeoplePayloadCache.get(cacheKey);
  if (cached) return cached;
  const payload = people.map((person) => publicPersonListItem(publicPerson(person, { skipFallbackAvatar: true })));
  libraryPeoplePayloadCache.set(cacheKey, payload);
  while (libraryPeoplePayloadCache.size > 6) {
    const oldest = libraryPeoplePayloadCache.keys().next().value;
    libraryPeoplePayloadCache.delete(oldest);
  }
  return payload;
}

export function prewarmLibraryPeoplePayloads(deps, scopes = ["main", "western"]) {
  const {
    library,
    peopleScopeService,
    personListService,
    peoplePayloadStamp,
    publicPerson
  } = deps;
  const warmed = [];
  for (const requestedScope of scopes) {
    const scope = peopleScopeService.normalize(requestedScope);
    const people = personListService.mainLibraryPeople(scope);
    cachedPublicPeople({
      people,
      publicPerson,
      scope,
      stamp: typeof peoplePayloadStamp === "function" ? peoplePayloadStamp(scope) : `${library.scannedAt || ""}:${scope}:${people.length}`
    });
    warmed.push({ scope, count: people.length });
  }
  return warmed;
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

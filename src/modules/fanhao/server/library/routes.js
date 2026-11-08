import { publicPersonListItem } from "../people/person-list-presenter.js";

const libraryPeoplePayloadCache = new Map();

export async function routeLibraryReadApi(req, res, url, deps) {
  const {
    appConfigService,
    getLastScanError,
    library,
    peopleScopeService,
    personListService,
    requestAccess,
    sendJson,
    userStateSummary
  } = deps;

  if (url.pathname === "/api/library" && req.method === "GET") {
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const user = userStateSummary();
    const people = personListService.mainLibraryPeople(scope);
    const lastScanError = getLastScanError();
    const publicPeople = cachedPublicPeople(people, scope, deps);
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

export function cachedPublicPeople(people, scope, { library, peopleScopeService, publicPerson, createPublicPersonPresenter, peoplePayloadStamp }) {
  const stamp = typeof peoplePayloadStamp === "function" ? peoplePayloadStamp(scope) : `${library.scannedAt || ""}:${scope}:${people.length}`;
  const westernStamp = peopleScopeService.cacheKey();
  const cacheKey = `${scope}:${stamp}:${westernStamp}:${people.length}`;
  const cached = libraryPeoplePayloadCache.get(cacheKey);
  if (cached?.source.deref() === people) return cached.payload;
  const matchesWestern = peopleScopeService.personMatcher?.("western")
    || ((person) => peopleScopeService.personMatches(person, "western"));
  const present = (people.length && createPublicPersonPresenter?.()) || publicPerson;
  const payload = people.map((person) => publicPersonListItem(
    present(person, { skipFallbackAvatar: true }),
    { isWestern: matchesWestern(person) }
  ));
  libraryPeoplePayloadCache.set(cacheKey, { source: new WeakRef(people), payload });
  while (libraryPeoplePayloadCache.size > 6) {
    const oldest = libraryPeoplePayloadCache.keys().next().value;
    libraryPeoplePayloadCache.delete(oldest);
  }
  return payload;
}

export function prewarmLibraryPeoplePayloads(deps, scopes = ["main", "western"]) {
  const { peopleScopeService, personListService } = deps;
  const warmed = [];
  for (const requestedScope of scopes) {
    const scope = peopleScopeService.normalize(requestedScope);
    const people = personListService.mainLibraryPeople(scope);
    cachedPublicPeople(people, scope, deps);
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

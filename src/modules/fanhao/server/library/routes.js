import { createHash } from "node:crypto";
import { publicPersonListItem } from "../people/person-list-presenter.js";

const libraryPeoplePayloadCache = new Map();
const encodedPeopleByScope = new Map();
const peopleRevisionByProjection = new WeakMap();
const MAX_ENCODED_PEOPLE_BYTES = 16 * 1024 * 1024;

function encodedPeoplePart(scope, publicPeople, cacheable = true) {
  const cached = cacheable ? encodedPeopleByScope.get(scope) : undefined;
  if (cached?.source.deref() === publicPeople) return cached.part;

  const part = Buffer.from(JSON.stringify({ people: publicPeople }).slice(1));
  if (!cacheable) return part;
  encodedPeopleByScope.delete(scope);
  if (part.length <= MAX_ENCODED_PEOPLE_BYTES) {
    encodedPeopleByScope.set(scope, { source: new WeakRef(publicPeople), part });
    if (encodedPeopleByScope.size > 2) {
      encodedPeopleByScope.delete(encodedPeopleByScope.keys().next().value);
    }
  }
  return part;
}

export async function routeLibraryReadApi(req, res, url, deps) {
  const {
    appConfigService,
    getLastScanError,
    library,
    peopleScopeService,
    requestAccess,
    sendJson,
    sendJsonParts,
    userStateSummary
  } = deps;

  if (url.pathname === "/api/library" && req.method === "GET") {
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const user = userStateSummary();
    const { people, publicPeople, cacheable } = readLibraryPeople(scope, deps);
    const lastScanError = getLastScanError();
    const metadata = {
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
      scope
    };
    let part;
    const requestedRevision = url.searchParams.get("peopleRevision");
    if (requestedRevision !== null && cacheable) {
      // Each projection belongs to one normalized scope and is replaced on
      // a source or stamp change. Keep the digest even when bytes exceed the
      // encoded cache limit so a matching client need not serialize them again.
      let revision = peopleRevisionByProjection.get(publicPeople);
      if (!revision) {
        part = encodedPeoplePart(scope, publicPeople);
        revision = createHash("sha256").update(`fanhao-library-people-v1\0${scope}\0`).update(part).digest("hex");
        peopleRevisionByProjection.set(publicPeople, revision);
      }
      metadata.peopleRevision = revision;
      if (requestedRevision === revision) {
        sendJson(res, 200, { ...metadata, peopleUnchanged: true });
        return true;
      }
    }
    if (sendJsonParts) {
      // Only the public people projection can be reused across requests.
      const prefix = Buffer.from(`${JSON.stringify(metadata).slice(0, -1)},`);
      sendJsonParts(res, 200, [prefix, part ?? encodedPeoplePart(scope, publicPeople, cacheable)]);
    } else {
      sendJson(res, 200, { ...metadata, people: publicPeople });
    }
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

function lazyCatalogueProfileReader({ createCatalogueRowReader }) {
  if (!createCatalogueRowReader) return undefined;
  let reader;
  return () => reader ??= createCatalogueRowReader();
}

export function readLibraryPeople(scope, deps, getProfileReader = lazyCatalogueProfileReader(deps)) {
  const { library, peopleScopeService, personListService, publicPerson, createPublicPersonPresenter, peoplePayloadStamp } = deps;
  const list = personListService.mainLibraryPeopleResult?.(scope, getProfileReader)
    || { people: personListService.mainLibraryPeople(scope), cacheable: true };
  const { people } = list;
  if (typeof peopleScopeService?.cacheKey !== "function") {
    const publicPeople = people.map(person => publicPersonListItem(publicPerson(person, { skipFallbackAvatar: true })));
    return { ...list, publicPeople };
  }
  const stamp = typeof peoplePayloadStamp === "function" ? peoplePayloadStamp(scope) : `${library.scannedAt || ""}:${scope}:${people.length}`;
  const westernStamp = peopleScopeService.cacheKey();
  const cacheKey = `${scope}:${stamp}:${westernStamp}:${people.length}`;
  const cached = list.cacheable ? libraryPeoplePayloadCache.get(cacheKey) : undefined;
  if (cached?.source.deref() === people) return { ...list, publicPeople: cached.payload };
  const matchesWestern = peopleScopeService.personMatcher?.("western")
    || ((person) => peopleScopeService.personMatches(person, "western"));
  const readProfile = people.length && createPublicPersonPresenter ? getProfileReader?.() : undefined;
  const present = (people.length && createPublicPersonPresenter?.(readProfile)) || publicPerson;
  const publicPeople = people.map((person) => publicPersonListItem(
    present(person, { skipFallbackAvatar: true }),
    { isWestern: matchesWestern(person) }
  ));
  const cacheable = list.cacheable && readProfile?.cacheable !== false;
  if (cacheable) {
    libraryPeoplePayloadCache.set(cacheKey, { source: new WeakRef(people), payload: publicPeople });
    while (libraryPeoplePayloadCache.size > 6) {
      const oldest = libraryPeoplePayloadCache.keys().next().value;
      libraryPeoplePayloadCache.delete(oldest);
    }
  }
  return { people, publicPeople, cacheable };
}

export function prewarmLibraryPeoplePayloads(deps, scopes = ["main", "western"]) {
  const { peopleScopeService } = deps;
  const warmed = [];
  const getProfileReader = lazyCatalogueProfileReader(deps);
  for (const requestedScope of scopes) {
    const scope = peopleScopeService.normalize(requestedScope);
    const { people } = readLibraryPeople(scope, deps, getProfileReader);
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

import {
  prewarmLibraryPeoplePayloads,
  readLibraryPeople,
  routeLibraryApi,
  routeLibraryMutationApi,
  routeLibraryReadApi
} from "./routes.js";

const PERSON_INDEX_COVER_PREWARM_LIMIT = 64;
const MAX_BOUNDED_COVER_LIMIT = 128;
const personNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function normalizedSourcePath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function sourcePriority(value) {
  const sourcePath = normalizedSourcePath(value);
  if (sourcePath.startsWith("g:/")) return 0;
  if (sourcePath.startsWith("f:/")) return 1;
  if (sourcePath === "o:/[珍藏]" || sourcePath.startsWith("o:/[珍藏]/")) return 2;
  if (sourcePath === "o:/[珍藏1]" || sourcePath.startsWith("o:/[珍藏1]/")) return 3;
  if (sourcePath === "o:/[稀有]" || sourcePath.startsWith("o:/[稀有]/")) return 4;
  if (sourcePath === "o:/[动漫]" || sourcePath.startsWith("o:/[动漫]/")) return 5;
  if (sourcePath.startsWith("o:/")) return 6;
  if (sourcePath === "v:/[a]" || sourcePath.startsWith("v:/[a]/")) return 7;
  if (sourcePath === "v:/[a1]" || sourcePath.startsWith("v:/[a1]/")) return 8;
  if (sourcePath === "v:/av" || sourcePath.startsWith("v:/av/")) return 9;
  if (sourcePath.startsWith("v:/")) return 10;
  if (sourcePath.startsWith("r:/")) return 11;
  return 12;
}

function displayPersonName(person) {
  return person?.actorProfile?.displayName || person?.name || "";
}

function personSourcePriority(person) {
  return person?.relativePath ? sourcePriority(person.relativePath) : 9;
}

function compareVisiblePeople(a, b) {
  return a.priority - b.priority || personNameCollator.compare(a.name, b.name);
}

export function personIndexCoverFiles(deps, limit = PERSON_INDEX_COVER_PREWARM_LIMIT) {
  const visibleLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!visibleLimit) return [];
  const bounded = visibleLimit <= MAX_BOUNDED_COVER_LIMIT;
  const library = deps.getLibrary();
  const { people, publicPeople: items } = readLibraryPeople("main", { ...deps, library });
  const visible = [];
  let descending = bounded;
  for (const [index, item] of items.entries()) {
    if (!item || item.actorProfile?.gender === "male") continue;
    const candidate = { person: people[index], item, priority: personSourcePriority(item), name: displayPersonName(item) };
    if (descending) {
      const previous = visible.at(-1);
      if (!previous || compareVisiblePeople(candidate, previous) < 0) {
        visible.push(candidate);
        if (visible.length === visibleLimit * 2) visible.splice(0, visibleLimit);
        continue;
      }
      // Every later row in a strict descending run outranks its predecessors.
      descending = false;
      visible.reverse();
      visible.length = Math.min(visible.length, visibleLimit);
    }
    // Keep the previous sorted prefix as the cutoff while collecting better candidates.
    if (bounded && visible.length >= visibleLimit && compareVisiblePeople(candidate, visible[visibleLimit - 1]) >= 0) continue;
    visible.push(candidate);
    if (bounded && (visible.length === visibleLimit || visible.length === visibleLimit * 2)) {
      visible.sort(compareVisiblePeople);
      visible.length = visibleLimit;
    }
  }
  if (descending) visible.reverse();
  else if (!bounded || visible.length !== visibleLimit) visible.sort(compareVisiblePeople);

  const files = [];
  const seen = new Set();
  for (const { person, item } of visible.slice(0, visibleLimit)) {
    if (!String(item.avatarUrl || "").startsWith("/media/person/")) continue;
    const file = person.coverId ? library.filesById.get(person.coverId) : null;
    if (!file || file.type !== "image" || seen.has(file.id || file.path)) continue;
    seen.add(file.id || file.path);
    files.push(file);
  }
  return files;
}

export function createLibraryRuntime(deps) {
  let coverPrewarmScheduled = false;

  function requestDeps() {
    return {
      ...deps,
      library: deps.getLibrary()
    };
  }

  async function routeApi(req, res, url) {
    return routeLibraryApi(req, res, url, requestDeps());
  }

  async function routeReadApi(req, res, url) {
    return routeLibraryReadApi(req, res, url, requestDeps());
  }

  async function routeMutationApi(req, res, url) {
    return routeLibraryMutationApi(req, res, url, requestDeps());
  }

  function start() {
    prewarmLibraryPeoplePayloads(requestDeps());
  }

  function prewarmPeopleIndexCovers() {
    if (coverPrewarmScheduled) return false;
    coverPrewarmScheduled = true;
    setImmediate(async () => {
      try {
        const files = personIndexCoverFiles(deps);
        const result = await deps.mediaResponseService.prewarmLocalImages(files, { limit: PERSON_INDEX_COVER_PREWARM_LIMIT });
        if (!result.requested) return;
        console.log(`[person-cover-prewarm] requested=${result.requested} cached=${result.cached} warmed=${result.warmed} failed=${result.failed}`);
      } catch (error) {
        console.warn("[person-cover-prewarm]", error?.message || error);
      } finally {
        coverPrewarmScheduled = false;
      }
    });
    return true;
  }

  return {
    prewarmPeopleIndexCovers,
    routeApi,
    routeMutationApi,
    routeReadApi,
    start
  };
}

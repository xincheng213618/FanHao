import {
  prewarmLibraryPeoplePayloads,
  routeLibraryApi,
  routeLibraryMutationApi,
  routeLibraryReadApi
} from "./routes.js";
import { publicPersonListItem } from "../people/person-list-presenter.js";

const PERSON_INDEX_COVER_PREWARM_LIMIT = 64;

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

export function personIndexCoverFiles(deps, limit = PERSON_INDEX_COVER_PREWARM_LIMIT) {
  const library = deps.getLibrary();
  const people = deps.personListService.mainLibraryPeople("main");
  const visible = people
    .map((person) => ({
      person,
      item: publicPersonListItem(deps.publicPerson(person, { skipFallbackAvatar: true }))
    }))
    .filter(({ item }) => item && item.actorProfile?.gender !== "male")
    .sort((a, b) => (
      personSourcePriority(a.item) - personSourcePriority(b.item)
      || displayPersonName(a.item).localeCompare(displayPersonName(b.item), undefined, { numeric: true, sensitivity: "base" })
    ))
    .slice(0, Math.max(0, Math.floor(Number(limit) || 0)));

  const files = [];
  const seen = new Set();
  for (const { person, item } of visible) {
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

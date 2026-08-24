import assert from "node:assert/strict";
import { createPeopleScopeService } from "../src/modules/fanhao/server/people/people-scope-service.js";
import { galleryMediaSources } from "../src/platform/server/root-config.js";

globalThis.window = { location: { href: "http://localhost/", search: "", hash: "" } };
const { routeFromUrl, routeUrl } = await import("../public/js/router.js");

const westernWork = {
  id: "western-work",
  relativePath: "R:/Alice/movie.mp4",
  videos: [],
  images: [],
  infos: []
};
const regularWork = {
  id: "regular-work",
  relativePath: "G:/Aoi/ABC-123/movie.mp4",
  videos: [],
  images: [],
  infos: []
};
const westernPerson = {
  id: "western-person",
  relativePath: "R:/Alice",
  sourcePaths: ["R:/Alice"],
  works: [westernWork.id]
};
const regularPerson = {
  id: "regular-person",
  relativePath: "G:/Aoi",
  sourcePaths: ["G:/Aoi"],
  works: [regularWork.id]
};
const animeWork = {
  id: "anime-work",
  personId: "anime-person",
  personName: "",
  relativePath: "O:/[legacy-garbled]/Series/episode.mp4",
  videos: [],
  images: [],
  infos: []
};
const sharedPerson = {
  id: "shared-person",
  relativePath: "G:/Shared",
  sourcePaths: ["G:/Shared", "R:/Shared"],
  works: [regularWork.id, westernWork.id]
};
const profileOnlyPerson = {
  id: "profile-only-person",
  relativePath: "",
  sourcePaths: [],
  works: []
};
const animePerson = {
  id: "anime-person",
  name: "[动漫]",
  relativePath: "O:/[动漫]",
  sourcePaths: ["O:/[动漫]"],
  works: [animeWork.id]
};
const library = {
  scannedAt: "test",
  people: [westernPerson, regularPerson, sharedPerson, profileOnlyPerson, animePerson],
  worksById: new Map([
    [westernWork.id, westernWork],
    [regularWork.id, regularWork],
    [animeWork.id, animeWork]
  ]),
  totals: { videos: 2, images: 0, infoFiles: 0 }
};
const normalizePath = (value) => String(value || "").replaceAll("\\", "/").toLowerCase();
const scopeService = createPeopleScopeService({
  getLibrary: () => library,
  isMainExcludedWork: (work) => work?.personName === "[动漫]",
  mainExcludedRoots: ["O:/[动漫]"],
  mergedPersonRecord: (person) => person,
  pathWithinRoot: (target, root) => normalizePath(target).startsWith(normalizePath(root)),
  sourcePathToAbsolute: (value) => value,
  westernRoots: ["R:/"]
});

assert.equal(scopeService.workMatches(westernWork, "main"), true);
assert.equal(scopeService.workMatches(regularWork, "main"), true);
assert.equal(scopeService.workMatches(animeWork, "main"), false);
assert.equal(scopeService.personMatches(westernPerson, "main"), false);
assert.equal(scopeService.personMatches(regularPerson, "main"), true);
assert.equal(scopeService.personMatches(sharedPerson, "main"), true);
assert.equal(scopeService.personMatches(profileOnlyPerson, "main"), true);
assert.equal(scopeService.personMatches(animePerson, "main"), false);
assert.equal(scopeService.workMatches(westernWork, "western"), true);
assert.equal(scopeService.workMatches(regularWork, "western"), false);
assert.equal(scopeService.personMatches(westernPerson, "western"), true);
assert.equal(scopeService.personMatches(regularPerson, "western"), false);
assert.equal(scopeService.personMatches(sharedPerson, "western"), true);
assert.equal(scopeService.personMatches(profileOnlyPerson, "western"), false);
assert.equal(scopeService.personMatches(animePerson, "western"), false);

assert.deepEqual(
  galleryMediaSources({ FANHAO_MOVIE_ROOTS: "Z:/", FANHAO_TV_ROOTS: "Y:/" }).map((item) => item.kind),
  ["movie", "tv", "anime"]
);

const westernRoute = routeFromUrl("http://localhost/western");
assert.equal(westernRoute.view, "people");
assert.equal(westernRoute.peopleScope, "western");
assert.equal(routeUrl(westernRoute, { initialParams: new URLSearchParams(), hash: "" }), "/western");
const fanhaoRoute = routeFromUrl("http://localhost/fanhao");
assert.equal(fanhaoRoute.view, "people");
assert.equal(routeUrl(fanhaoRoute, { initialParams: new URLSearchParams(), hash: "" }), "/fanhao");
const fanhaoSearchRoute = routeFromUrl("http://localhost/fanhao?q=ABP-123");
assert.equal(fanhaoSearchRoute.view, "search");
assert.equal(routeUrl(fanhaoSearchRoute, { initialParams: new URLSearchParams(), hash: "" }), "/fanhao?q=ABP-123");
const rankingRoute = routeFromUrl("http://localhost/fanhao/rankings");
assert.equal(rankingRoute.view, "rankings");
assert.equal(routeUrl(rankingRoute, { initialParams: new URLSearchParams(), hash: "" }), "/fanhao/rankings");
const legacyRankingRoute = routeFromUrl("http://localhost/rankings");
assert.equal(legacyRankingRoute.view, "rankings");
assert.equal(routeUrl(legacyRankingRoute, { initialParams: new URLSearchParams(), hash: "" }), "/fanhao/rankings");
const legacyDetailRoute = routeFromUrl("http://localhost/western/gw_legacy");
assert.equal(legacyDetailRoute.view, "gallery");
assert.equal(legacyDetailRoute.galleryMode, "western");
assert.equal(legacyDetailRoute.galleryMediaId, "gw_legacy");
const filteredMediaRoute = routeFromUrl("http://localhost/media?kind=movie&category=%E4%B8%AD%E5%9B%BD");
assert.equal(filteredMediaRoute.view, "gallery");
assert.equal(filteredMediaRoute.galleryMode, "media");
assert.equal(filteredMediaRoute.galleryMediaKind, "movie");
assert.equal(filteredMediaRoute.galleryCategory, "中国");
assert.equal(
  routeUrl(filteredMediaRoute, { initialParams: new URLSearchParams(), hash: "" }),
  "/media?kind=movie&category=%E4%B8%AD%E5%9B%BD"
);
const animeMediaRoute = routeFromUrl("http://localhost/media?kind=anime");
assert.equal(animeMediaRoute.galleryMode, "media");
assert.equal(animeMediaRoute.galleryMediaKind, "anime");
assert.equal(routeUrl(animeMediaRoute, { initialParams: new URLSearchParams(), hash: "" }), "/media?kind=anime");

console.log("library merge verification passed");

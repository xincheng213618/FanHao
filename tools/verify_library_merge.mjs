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
const library = {
  scannedAt: "test",
  people: [westernPerson, regularPerson],
  worksById: new Map([
    [westernWork.id, westernWork],
    [regularWork.id, regularWork]
  ]),
  totals: { videos: 2, images: 0, infoFiles: 0 }
};
const normalizePath = (value) => String(value || "").replaceAll("\\", "/").toLowerCase();
const scopeService = createPeopleScopeService({
  getLibrary: () => library,
  mergedPersonRecord: (person) => person,
  pathWithinRoot: (target, root) => normalizePath(target).startsWith(normalizePath(root)),
  sourcePathToAbsolute: (value) => value,
  westernRoots: ["R:/"]
});

assert.equal(scopeService.workMatches(westernWork, "main"), true);
assert.equal(scopeService.workMatches(regularWork, "main"), true);
assert.equal(scopeService.personMatches(westernPerson, "main"), true);
assert.equal(scopeService.personMatches(regularPerson, "main"), true);
assert.equal(scopeService.workMatches(westernWork, "western"), true);
assert.equal(scopeService.workMatches(regularWork, "western"), false);
assert.equal(scopeService.personMatches(westernPerson, "western"), true);
assert.equal(scopeService.personMatches(regularPerson, "western"), false);

assert.deepEqual(
  galleryMediaSources({ FANHAO_MOVIE_ROOTS: "Z:/", FANHAO_TV_ROOTS: "Y:/" }).map((item) => item.kind),
  ["movie", "tv"]
);

const legacyRoute = routeFromUrl("http://localhost/western");
assert.equal(legacyRoute.view, "people");
assert.equal(legacyRoute.peopleScope, "main");
assert.equal(routeUrl(legacyRoute, { initialParams: new URLSearchParams(), hash: "" }), "/fanhao");
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

console.log("library merge verification passed");

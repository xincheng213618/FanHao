import assert from "node:assert/strict";
import fs from "node:fs";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";

// Actual query/sort modules and production integer parsing, synthetic works only.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-key"));
let createQuery = createWorkQueryService;
if (process.argv.includes("--legacy-key")) {
  const url = new URL("../src/modules/fanhao/server/works/work-query-service.js", import.meta.url);
  const text = fs.readFileSync(url, "utf8");
  const slot = "JSON.stringify([scope, category, filter, sort, limit, offset])";
  assert.equal(text.split(slot).length, 2);
  const previous = text.replace(slot, "`${scope}:${category}:${filter}:${sort}:${limit}:${offset}`")
    .replace(/from "(\.\/[^"]+)"/gu, (_, relative) => `from "${new URL(relative, url).href}"`);
  createQuery = (await import(`data:text/javascript;base64,${Buffer.from(previous).toString("base64")}`)).createWorkQueryService;
}
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const clampSource = server.slice(server.indexOf("function clampInteger("), server.indexOf("function allWorks("));
assert.ok(clampSource.includes("Number.isFinite"));
const clampInteger = new Function(`${clampSource}\nreturn clampInteger;`)();
let comparisons = 0;
for (const [left, right] of [
  [{ filter: "favorite:x", sort: "title" }, { filter: "favorite", sort: "x:title" }],
  [{ filter: "progress:x", sort: "releaseDesc" }, { filter: "progress", sort: "x:releaseDesc" }],
  [{ filter: "favorite:中文", sort: "title" }, { filter: "favorite", sort: "中文:title" }],
  [{ filter: "all:x", sort: "title" }, { filter: "all", sort: "x:title" }]
]) {
  for (const [first, second] of [[left, right], [right, left]]) {
    const warm = fixture(createQuery), cold = fixture(createQuery);
    warm.read(first);
    const expected = cold.read(second), actual = warm.read(second);
    assert.deepEqual(actual, expected, "a warmed filter/sort tuple must match the entire cold response"); comparisons++;
    assert.equal(warm.read(second), actual, "identical requests still hit the page cache");
  }
}
const boundaries = fixture(createQuery);
for (const params of [{}, { limit: "0" }, { limit: "bad", offset: "bad" }, { limit: "2.8", offset: "1.9" },
  { limit: "1:2", offset: "0" }, { limit: "1", offset: "2:0" }, { offset: "999" }, { limit: "16001" }]) {
  assert.deepEqual(boundaries.read(params), fixture(createQuery).read(params)); comparisons++;
}
console.log(JSON.stringify({ ok: true, comparisons, actualQuerySortAndClamp: true, pageHitsPreserved: true }));

function fixture(create) {
  const works = Array.from({ length: 8 }, (_, index) => ({ id: String(index + 1), title: `Title ${8 - index}`,
    modifiedAt: `2026-01-0${index + 1}`, playableCount: 1, infoSummary: { releaseDate: `2025-01-0${index + 1}` } }));
  const service = create({ library: { scannedAt: "scan", worksById: new Map(works.map(work => [work.id, work])) },
    actorMovieStamp: () => "actor", workQueryStamp: () => "works", peoplePayloadStamp: () => "people", userStateStamp: () => "user",
    clampInteger, defaultWorkLimit: 8, maxWorkLimit: 16000, enrichLocalWorksWithActorMovieIndex: value => value,
    favoriteStateService: { isFavoriteWork: id => Number(id) % 2 === 0, publicFavoriteForWork: () => null },
    playbackProgressService: { getWorkProgress: work => Number(work.id) % 2 ? { positionMs: 100 } : null },
    isVrWork: () => false, workHasCoreCover: () => false, workHasLocalMarker: () => false, workInfoFacetRow: () => null,
    peopleScopeService: { normalize: () => "main", workMatches: () => true },
    publicWork: work => ({ id: work.id, title: work.title }), publicWorkAvailability: () => ({}),
    prewarmRemoteImagesForWorks: () => {}
  });
  return { read: params => service.listPayload(new URL("http://fixture/works?" + new URLSearchParams(params))) };
}

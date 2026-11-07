import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createGalleryIndexSource } from "./fixtures/gallery-index-source.mjs";
import { IMAGE_QUERY_CACHE_MAX_AGE_MS, IMAGE_QUERY_CACHE_MAX_ROWS, IMAGE_QUERY_CACHE_MAX_BYTES } from "../src/modules/content-index/server/image-query-cache.js";

const args = process.argv.slice(2);
assert(args.every(arg => arg === "--disable-western-cache"), "known arguments");
const root = new URL("../src/modules/content-index/server/", import.meta.url);
// The full owner is fixed before this feature; neither HEAD nor a newly edited
// whitelist can silently redefine ordinary response compatibility.
const oldSource = execFileSync("git", ["show", "63c5fab243233e142cfd62c4eaf13812feb92405:src/modules/content-index/server/image-library-service.js"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8"
}).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(oldSource).digest("hex"), "30bef6e506a38bda3e4ee7eca57b3b9ba435ecbdffaf3d6a4de89b2e2666b4d2");
const currentSource = fs.readFileSync(new URL("image-library-service.js", root), "utf8").replace(/\r\n/g, "\n");
const currentFactory = await loadFactory(currentSource);
const beforeFactory = await loadFactory(oldSource);
const testedFactory = args.includes("--disable-western-cache") ? await loadFactory(disableWestern(currentSource)) : currentFactory;
const metricName = "__fanhaoWesternQueryFixtureMetrics";
assert.equal(globalThis[metricName], undefined, "fixture metric owner is private");
globalThis[metricName] = newMetrics();
const originalNow = Date.now;
let comparisons = 0;

try {
  verifyContracts();
  verifyClones();
  verifyInvalidation();
  verifySingleEntry();
  verifyClock();
  verifyBudgets();
  verifyLegacyProviders();
  const scale = verifyScale();
  console.log(JSON.stringify({ fixture: "western-image-query-cache", comparisons, scale }, null, 2));
} finally {
  Date.now = originalNow;
  delete globalThis[metricName];
}

function replaceOnce(source, original, replacement) {
  assert.equal(source.split(original).length, 2, "one actual owner boundary");
  return source.replace(original, replacement);
}

function disableWestern(source) {
  const original = 'const cacheEligible = cachePreparedQueries && ["photo", "western", "movie", "tv", "anime", "media"].includes(mode)';
  const replacement = 'const cacheEligible = cachePreparedQueries && ["photo", "movie", "tv", "anime", "media"].includes(mode)';
  const controlled = replaceOnce(source, original, replacement);
  assert.equal(controlled.replace(replacement, original), source, "negative changes only Western eligibility");
  return controlled;
}

async function loadFactory(source) {
  // Count real execution of the owned publication/group/sort mechanisms. The
  // untouched fixed owner still supplies every field of the DTO oracle.
  for (const [anchor, observation] of [
    ["    const sourceSeriesKey = galleryMediaSourceSeriesKey(item);", "publications += 1"],
    ["  function westernPersonGroups(items = []) {", "groupedRows += items.length"],
    ["  function sortImageLibraryItems(items, sort) {", "sortedRows += items.length; globalThis.__fanhaoWesternQueryFixtureMetrics.sortCalls += 1"]
  ]) {
    const addition = `globalThis.__fanhaoWesternQueryFixtureMetrics.${observation};`;
    source = replaceOnce(source, anchor, anchor.includes("function ") ? `${anchor}\n    ${addition}` : `    ${addition}\n${anchor}`);
  }
  source = source.replace(/from\s+"(\.{1,2}\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, root).href)}`);
  source += "\n//# sourceURL=fanhao-western-query-fixture-owner.js\n";
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createImageLibraryService;
}

function newMetrics() { return { publications: 0, groupedRows: 0, sortedRows: 0, sortCalls: 0 }; }
function measured(work) {
  globalThis[metricName] = newMetrics();
  const began = performance.now();
  const value = work();
  return { value, metrics: { ...globalThis[metricName] }, milliseconds: +(performance.now() - began).toFixed(2) };
}

function item(i, overrides = {}) {
  return { id: `western-${i}`, mediaKind: "western", title: `Video ${i}`, personName: `Actor ${i % 100}`,
    category: `Category ${i % 7}`, subCategory: `Folder ${i % 11}`, rootLabel: "Synthetic",
    sourceRoot: "synthetic", relativePath: `${i}.mp4`, size: i + 1, playable: i % 3 !== 0,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), coverUrl: `https://covers.invalid/${i}`,
    genres: ["genre", `genre-${i % 5}`], rating: i % 10, year: `${2000 + i % 26}`, ...overrides };
}

function fixture(items, { factory = testedFactory, revision = true, metadataRevision = false } = {}) {
  const snapshot = mediaItems => ({ scannedAt: "2026-01-01T00:00:00.000Z", photoSets: [], mediaItems });
  const state = { persisted: snapshot(items), metadataRevision: 1, metadataCalls: 0, forbidMetadata: true, afterProbe: null };
  const owner = createGalleryIndexSource(() => state.persisted);
  const metadataRead = result => { state.metadataCalls++; assert.equal(state.forbidMetadata, false, "Western never reads movie/TV metadata"); return result; };
  const metadataService = {
    tvSeriesRowsMap: () => metadataRead(new Map()), movieRowsMap: () => metadataRead(new Map()),
    publicTvSeries: row => metadataRead(row || null), publicMovie: row => metadataRead(row || null),
    tvSeriesRow: () => metadataRead(null), movieRow: () => metadataRead(null), tvSeriesKey: (category, name) => `${category}|${name}`,
    ...(metadataRevision ? { listRevision: () => metadataRead(state.metadataRevision) } : {})
  };
  const deps = { cachePreparedQueries: true, getImageLibraryIndex: owner.getIndex,
    getImageLibraryRevision: revision ? () => { const stamp = owner.listRevision(); const action = state.afterProbe; state.afterProbe = null; action?.(); return stamp; } : null,
    clampInteger: (value, fallback, min, max) => { const n = Number.parseInt(value, 10); return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback)); },
    metadataService, maxItemLimit: 20000, mangaService: { cacheDirs: () => [], rootStatus: () => ({}) },
    photoSetService: { coverUrl: () => "" }, photoCollectionRootValue: "__root__", galleryMediaRootStatuses: () => [],
    photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}) };
  return { state, owner, actual: factory(deps), before: beforeFactory(deps), snapshot,
    publish(mediaItems) { state.persisted = snapshot(mediaItems); owner.invalidate(); },
    request(params = {}, options = {}) { return this.actual.itemsPayload(request(params), options); },
    expected(params = {}) { return this.before.itemsPayload(request(params)); },
    expectedSnapshot(index, params = {}) { return beforeFactory({ ...deps, getImageLibraryIndex: () => index,
      getImageLibraryRevision: null }).itemsPayload(request(params)); } };
}

function request(params = {}) { return new URL(`http://fixture.invalid/?${new URLSearchParams({ mode: "western", limit: "48", ...params })}`); }
function ordinary(response) { const { listRevision, ...fields } = response; return fields; }
function equal(actual, expected, label) {
  assert.deepEqual(ordinary(actual), ordinary(expected), label);
  assert.equal(JSON.stringify(ordinary(actual)), JSON.stringify(ordinary(expected)), `${label}: wire field order`);
  assert.match(actual.listRevision, /^[0-9a-f]{64}$/);
  comparisons++;
  return actual;
}

function verifyContracts() {
  const data = Array.from({ length: 320 }, (_, i) => item(i, i % 29 === 0 ? { personName: "", subCategory: "Fallback Actor" } : {}));
  data.push(item(999, { personName: " ", subCategory: "", category: " ", title: "éclair" }));
  const value = fixture(data);
  const matrix = [
    {}, { sort: "title" }, { sort: "count" }, { sort: "size" }, { sort: "year" }, { sort: "rating" }, { sort: "unknown" },
    { category: "Category 2" }, { category: "missing" }, { person: "Actor 1" }, { person: "Fallback Actor" }, { person: "missing" },
    { person: "Actor 1", category: "Category 1", sort: "size" }, { q: "Actor 1" }, { q: "Video 1", person: "Actor 1" },
    { q: "zz-not-present" }, { search: "Actor", sort: "title" }, { kind: "movie" }, { date: "2026-01-01" },
    { collection: "synthetic" }, { seriesKey: "unused" }
  ];
  for (const params of matrix) for (const offset of ["0", "7", "10000"]) {
    equal(value.request({ ...params, offset, limit: offset === "7" ? "3" : "48" }), value.expected({ ...params, offset, limit: offset === "7" ? "3" : "48" }), `complete Western response ${JSON.stringify(params)}/${offset}`);
  }
  // Offset and limit reuse one query; they must never join the query key.
  const owner = fixture(data, { factory: currentFactory });
  measured(() => owner.request({ sort: "title", limit: "3" }));
  const changedWindow = measured(() => owner.request({ sort: "title", limit: "9", offset: "6" }));
  equal(changedWindow.value, owner.expected({ sort: "title", limit: "9", offset: "6" }), "same query, different window");
  assert.equal(changedWindow.metrics.publications, 0);
  assert.equal(owner.state.metadataCalls, 0, "absent metadata revision method is supported");
}

function verifyClones() {
  const value = fixture(Array.from({ length: 200 }, (_, i) => item(i)), { factory: currentFactory });
  const expected = measured(() => value.expected()).value;
  const cold = measured(() => value.request()).value;
  cold.items[0].samples.push("poison"); cold.items[0].categories[0].value = "poison";
  cold.items[0].categories[0].count = -1; cold.facets.categories[0].value = "poison";
  const warm = measured(() => value.request()).value;
  equal(warm, expected, "cold group response is detached");
  warm.items[0].samples[0] = "poison again"; warm.facets.people[0].value = "poison again";
  equal(measured(() => value.request()).value, expected, "warm group response is detached");
  const params = { person: "Actor 1" };
  const video = measured(() => value.request(params)).value;
  const videoExpected = measured(() => value.expected(params)).value;
  video.items[0].genres.push("poison"); video.facets.roots[0].value = "poison";
  equal(measured(() => value.request(params)).value, videoExpected, "individual video arrays are detached");
  assert(!value.owner.getIndex().mediaItems.some(row => row.genres.includes("poison")), "caller cannot mutate source through DTO");
}

function verifyInvalidation() {
  const value = fixture(Array.from({ length: 200 }, (_, i) => item(i)), { factory: currentFactory, metadataRevision: true });
  const first = measured(() => value.request()).value;
  value.state.metadataRevision++;
  const metadataOnly = measured(() => value.request());
  equal(metadataOnly.value, measured(() => value.expected()).value, "metadata-only changes preserve Western response");
  assert.equal(metadataOnly.value.listRevision, first.listRevision);
  assert.equal(metadataOnly.metrics.publications, 0);
  assert.equal(value.state.metadataCalls, 0, "Western never queries unrelated movie revision");
  const original = value.owner.getIndex();
  original.mediaItems.at(-1).title = "In-place title with explicit owner revision";
  value.owner.invalidate();
  const inPlace = measured(() => value.request());
  equal(inPlace.value, measured(() => value.expected()).value, "same object and same count with new owner revision");
  assert(inPlace.metrics.publications > 0); assert.notEqual(inPlace.value.listRevision, first.listRevision);
  assert(inPlace.value.items[0].samples.includes("In-place title with explicit owner revision"));
  value.publish(original.mediaItems.map((row, i) => i === 1 ? { ...row, size: 9999999 } : row));
  const replaced = measured(() => value.request());
  equal(replaced.value, measured(() => value.expected()).value, "same scannedAt and count, replaced index identity");
  assert(replaced.metrics.publications > 0);
  // Commit a replacement immediately after the first before-read revision.
  const oldExpected = measured(() => value.expected()).value;
  value.state.afterProbe = () => value.publish(value.owner.getIndex().mediaItems.map((row, i) => i === 2 ? { ...row, personName: "New Actor" } : row));
  const raced = measured(() => value.request());
  equal(raced.value, oldExpected, "warm page race retains its selected snapshot");
  assert.notEqual(raced.value.listRevision, replaced.value.listRevision, "changed source gets a one-use revision");
  const following = measured(() => value.request());
  equal(following.value, measured(() => value.expected()).value, "next request sees committed publication");
  assert(following.metrics.publications > 0, "raced cached page is not admitted for later reuse");
  value.actual.clearPreparedQueries();
  const oldColdExpected = measured(() => value.expected()).value;
  value.state.afterProbe = () => value.publish(value.owner.getIndex().mediaItems.map((row, i) => i === 3 ? { ...row, personName: "Cold Publication Actor" } : row));
  const coldRace = measured(() => value.request());
  equal(coldRace.value, oldColdExpected, "cold publication race retains selected source");
  assert(coldRace.metrics.publications > 0);
  const afterColdRace = measured(() => value.request());
  equal(afterColdRace.value, measured(() => value.expected()).value, "cold race is not reused by next request");
  assert(afterColdRace.metrics.publications > 0);
  // Refresh scans only the configured empty roots and writes our named index.
  const refreshed = measured(() => value.request({}, { refresh: true }));
  equal(refreshed.value, measured(() => value.expected()).value, "refresh returns the actual newly published empty snapshot");
  assert.equal(refreshed.value.total, 0);
  const afterRefresh = measured(() => value.request());
  assert.equal(afterRefresh.metrics.sortCalls, 1, "refresh response was not cached");
  let refreshSnapshot;
  value.state.afterProbe = () => { refreshSnapshot = value.owner.getIndex(); value.publish([item(777, { personName: "Published after refresh" })]); };
  const refreshRace = measured(() => value.request({}, { refresh: true }));
  equal(refreshRace.value, measured(() => value.expectedSnapshot(refreshSnapshot)).value, "refresh race retains its freshly scanned snapshot");
  assert.equal(refreshRace.value.total, 0);
  const afterRefreshRace = measured(() => value.request());
  equal(afterRefreshRace.value, measured(() => value.expected()).value, "next request sees publication after refresh");
  assert.equal(afterRefreshRace.metrics.publications, 1);
}

function verifySingleEntry() {
  const value = fixture([...Array.from({ length: 300 }, (_, i) => item(i)), item(1000, { mediaKind: "movie" })],
    { factory: currentFactory, metadataRevision: true });
  measured(() => value.request());
  const query = measured(() => value.request({ q: "Actor 1" }));
  equal(query.value, measured(() => value.expected({ q: "Actor 1" })).value, "query switch");
  assert.equal(query.metrics.publications, 300);
  const restoredQuery = measured(() => value.request());
  equal(restoredQuery.value, measured(() => value.expected()).value, "old query after single-entry replacement");
  assert.equal(restoredQuery.metrics.publications, 300);
  value.state.forbidMetadata = false;
  equal(measured(() => value.request({ mode: "movie" })).value, measured(() => value.expected({ mode: "movie" })).value, "movie mode uses its own plan");
  assert(value.state.metadataCalls > 0, "metadata boundary is exercised by real movie reads");
  value.state.forbidMetadata = true;
  const restoredMode = measured(() => value.request());
  equal(restoredMode.value, measured(() => value.expected()).value, "Western after movie single-entry replacement");
  assert.equal(restoredMode.metrics.publications, 300);
  value.actual.clearPreparedQueries();
  assert.equal(measured(() => value.request()).metrics.publications, 300, "explicit cache clear still applies");
}

function verifyClock() {
  let now = originalNow(); Date.now = () => now;
  try {
    const value = fixture(Array.from({ length: 100 }, (_, i) => item(i)), { factory: currentFactory });
    measured(() => value.request());
    now += IMAGE_QUERY_CACHE_MAX_AGE_MS - 1;
    assert.equal(measured(() => value.request()).metrics.publications, 0, "last millisecond before TTL reuses query");
    now++;
    const boundary = measured(() => value.request());
    equal(boundary.value, measured(() => value.expected()).value, "exact TTL boundary");
    assert.equal(boundary.metrics.publications, 100, "TTL is exclusive");
    now--;
    const rollback = measured(() => value.request());
    equal(rollback.value, measured(() => value.expected()).value, "clock rollback");
    assert.equal(rollback.metrics.publications, 100, "negative age invalidates query");
  } finally { Date.now = originalNow; }
}

function verifyBudgets() {
  for (const personBranch of [false, true]) for (const rows of [IMAGE_QUERY_CACHE_MAX_ROWS, IMAGE_QUERY_CACHE_MAX_ROWS + 1]) {
    const value = fixture(Array.from({ length: rows }, (_, i) => item(i, { personName: personBranch ? "One Actor" : `Actor ${i}` })), { factory: currentFactory });
    const params = personBranch ? { person: "One Actor" } : {};
    const first = measured(() => value.request(params));
    equal(first.value, measured(() => value.expected(params)).value, `row budget ${rows}/${personBranch}`);
    const second = measured(() => value.request({ ...params, offset: "48" }));
    equal(second.value, measured(() => value.expected({ ...params, offset: "48" })).value, `row budget next page ${rows}/${personBranch}`);
    assert.equal(second.metrics.publications, rows > IMAGE_QUERY_CACHE_MAX_ROWS ? rows : 0,
      "row budget counts public group rows or individual person videos");
  }
  const title = "t".repeat(20000);
  const count = 1000;
  assert(Buffer.byteLength(title) * count > IMAGE_QUERY_CACHE_MAX_BYTES, "samples alone independently exceed byte budget");
  const huge = fixture(Array.from({ length: count }, (_, i) => item(i, { title, personName: `Actor ${i}` })), { factory: currentFactory });
  measured(() => huge.request());
  const reread = measured(() => huge.request({ offset: "48" }));
  equal(reread.value, measured(() => huge.expected({ offset: "48" })).value, "over-byte-budget response remains complete");
  assert.equal(reread.metrics.publications, count, "oversized retained sample text is not cached");
}

function verifyLegacyProviders() {
  const value = fixture(Array.from({ length: 100 }, (_, i) => item(i)), { factory: currentFactory, revision: false });
  measured(() => value.request());
  value.owner.getIndex().mediaItems[0].personName = "Mutated legacy provider";
  const result = measured(() => value.request());
  equal(result.value, measured(() => value.expected()).value, "provider without revision remains uncached and observes mutation");
  assert.equal(result.metrics.publications, 100);
}

function verifyScale() {
  const value = fixture(Array.from({ length: 100000 }, (_, i) => item(i, { personName: `Actor ${i % 10000}` })));
  const run = service => measured(() => Array.from({ length: 10 }, (_, page) => service.itemsPayload(request({ offset: String(page * 48) }))));
  const before = run(value.before), after = run(value.actual);
  after.value.forEach((response, i) => equal(response, before.value[i], `100k-video, 10k-group scale page ${i}`));
  assert.equal(before.metrics.publications, 1000000);
  assert.equal(before.metrics.groupedRows, 1000000);
  assert.equal(before.metrics.sortedRows, 100000);
  // All ordinary and boundary contracts precede these execution budgets. The
  // narrow disabled negative fails on real repeated work, not a source marker.
  assert.equal(after.metrics.publications, 100000, "ten pages publish the Western source once");
  assert.equal(after.metrics.groupedRows, 100000, "ten pages group the Western source once");
  assert.equal(after.metrics.sortedRows, 10000, "ten pages sort the complete groups once");
  const warm = measured(() => value.request({ offset: "480", limit: "17" }));
  equal(warm.value, measured(() => value.expected({ offset: "480", limit: "17" })).value, "warm different page window");
  assert.deepEqual(warm.metrics, newMetrics(), "warm page does no source publication, grouping or sorting");
  assert.equal(value.state.metadataCalls, 0);
  return { inputVideos: 100000, outputGroups: 10000, before: before.metrics, after: after.metrics,
    beforeMs: before.milliseconds, afterMs: after.milliseconds, warmPageMs: warm.milliseconds };
}

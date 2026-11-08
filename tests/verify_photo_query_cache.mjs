import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createGalleryIndexSource } from "./fixtures/gallery-index-source.mjs";
import { createImageQueryCache, IMAGE_QUERY_CACHE_MAX_AGE_MS, IMAGE_QUERY_CACHE_MAX_ROWS, IMAGE_QUERY_CACHE_MAX_BYTES, IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS } from "../src/modules/content-index/server/image-query-cache.js";
import { photoCatalogCollections } from "../public/modules/content-index/photo-catalog.js";

const args = process.argv.slice(2);
assert(args.every(arg => arg === "--disable-photo-cache"), "known arguments");
const root = new URL("../src/modules/content-index/server/", import.meta.url);
const oldSource = execFileSync("git", ["show", "63c5fab243233e142cfd62c4eaf13812feb92405:src/modules/content-index/server/image-library-service.js"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8"
}).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(oldSource).digest("hex"), "30bef6e506a38bda3e4ee7eca57b3b9ba435ecbdffaf3d6a4de89b2e2666b4d2", "fixed complete pre-cache owner");
const currentSource = fs.readFileSync(new URL("image-library-service.js", root), "utf8").replace(/\r\n/g, "\n");
const metricName = "__fanhaoPhotoQueryFixtureMetrics";
// Issue-number parsing changed deliberately after the pinned owner. The
// differential checks caching, so the baseline uses the current parser.
const oldFactory = await loadFactory(withCurrentAlbumNumbers(oldSource));
const currentFactory = await loadFactory(currentSource);
const testedFactory = args.includes("--disable-photo-cache") ? await loadFactory(disablePhoto(currentSource)) : currentFactory;
assert.equal(globalThis[metricName], undefined);
const originalNow = Date.now;
let comparisons = 0;
globalThis[metricName] = newMetrics();
try {
  verifyContracts();
  verifyCollectionAggregation();
  verifyCollectionPages();
  verifyLargeCollectionPages();
  verifyCollectionProjection();
  verifyClones();
  verifyInvalidation();
  verifyClock();
  verifyBudgets();
  verifyLegacyProvider();
  console.log(`Photo query contracts passed before repeated-work budgets (${comparisons} complete DTO/wire comparisons).`);
  const scale = verifyScale();
  console.log(JSON.stringify({ fixture: "photo-query-cache", comparisons, scale }, null, 2));
} finally {
  Date.now = originalNow;
  delete globalThis[metricName];
}

function replaceOnce(source, original, replacement) {
  assert.equal(source.split(original).length, 2, "one exact owner boundary");
  return source.replace(original, replacement);
}
function disablePhoto(source) {
  const original = 'const cacheEligible = cachePreparedQueries && ["photo", "western", "movie", "tv", "anime", "media"].includes(mode)';
  const replacement = 'const cacheEligible = cachePreparedQueries && ["western", "movie", "tv", "anime", "media"].includes(mode)';
  const controlled = replaceOnce(source, original, replacement);
  assert.equal(controlled.replace(replacement, original), source, "negative only disables photo eligibility");
  return controlled;
}
function withCurrentAlbumNumbers(source) {
  source = replaceOnce(source, `  function photoAlbumNumber(value) {
    const match = String(value || "").match(/\\b(VOL|N[O0])\\.?\\s*(\\d+)\\b/i);
    if (!match) return "";
    const prefix = /^VOL$/i.test(match[1]) ? "VOL." : "NO.";
    return \`\${prefix}\${match[2]}\`;
  }
`, `  function photoAlbumNumber(value) {
    return parsePhotoAlbumNumber(value)?.label || "";
  }
`);
  source = replaceOnce(source, `    const text = stripPhotoAlbumStats(value);
    const match = text.match(/\\b(?:VOL|N[O0])\\.?\\s*\\d+\\b/i);`, `    const parsedNumber = parsePhotoAlbumNumber(value);
    const text = parsedNumber?.text ?? stripPhotoAlbumStats(value);
    const match = parsedNumber ? { index: parsedNumber.index, 0: text.slice(parsedNumber.index, parsedNumber.index + parsedNumber.length) } : null;`);
  source = replaceOnce(source, `        .replace(/^\\s*[-–—:]\\s*/u, "")`, `        .replace(/^\\s*[-–—:.、#]\\s*/u, "")`);
  const albumNumberModule = new URL("photo-album-number.js", root).href;
  return `import { parsePhotoAlbumNumber } from ${JSON.stringify(albumNumberModule)};\n${source}`;
}

async function loadFactory(source) {
  for (const [anchor, metric] of [
    ["  function filterPhotoSetsForList(items, filters = {}) {", "filteredRows += items.length"],
    ["  function photoArchiveDate(value) {", "archiveDates += 1"],
    ["  function searchImageLibraryItems(items, searchSpec) {", "searchedRows += items.length; globalThis.__fanhaoPhotoQueryFixtureMetrics.searchCalls += 1"],
    ["  function sortImageLibraryItems(items, sort) {", "sortedRows += items.length; globalThis.__fanhaoPhotoQueryFixtureMetrics.sortCalls += 1"],
    ["  function compareImageSearchResults(a, b) {", "searchComparisons += 1"]
  ]) source = replaceOnce(source, anchor, `${anchor}\n    globalThis.${metricName}.${metric};`);
  source = source.replace(/from\s+"(\.{1,2}\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, root).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createImageLibraryService;
}
function newMetrics() { return { filteredRows: 0, archiveDates: 0, searchedRows: 0, searchCalls: 0, sortedRows: 0, sortCalls: 0, searchComparisons: 0 }; }
function measured(callback) {
  globalThis[metricName] = newMetrics();
  const start = performance.now(), value = callback();
  return { value, metrics: { ...globalThis[metricName] }, instrumentedDiagnosticMs: +(performance.now() - start).toFixed(2) };
}
function item(i, overrides = {}) {
  return { id: `photo-${i}`, type: "photoSet", title: `Fixture VOL.${i + 1} 2026-01-01 主题 ${i} [120P]`,
    category: `C${i % 3}`, subCategory: `Sub${i % 5}`, personName: `Person ${i % 17}`,
    rootLabel: "Synthetic", sourceRoot: "synthetic", relativePath: `C${i % 3}/Sub${i % 5}/${i}.zip`, archiveExt: "zip",
    size: i + 1, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), imageCount: 120,
    coverUrl: `/synthetic-cover/${i}`, genres: ["fixture", `genre-${i % 4}`], ...overrides };
}
function fixture(rows, { factory = currentFactory, revision = true } = {}) {
  const snapshot = photoSets => ({ scannedAt: "2026-01-01T00:00:00.000Z", photoSets, mediaItems: [] });
  const state = { metadataCalls: 0, afterProbe: null };
  let current = snapshot(rows);
  const owner = createGalleryIndexSource(() => current);
  const metadataService = new Proxy({}, { get() { state.metadataCalls++; throw new Error("Photo never reads movie/TV metadata"); } });
  const deps = { cachePreparedQueries: true, getImageLibraryIndex: owner.getIndex,
    getImageLibraryRevision: revision ? () => { const stamp = owner.listRevision(); const action = state.afterProbe; state.afterProbe = null; action?.(); return stamp; } : null,
    clampInteger: (value, fallback, min, max) => { const n = Number.parseInt(value, 10); return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback)); },
    metadataService, maxItemLimit: 20000, mangaService: { cacheDirs: () => [], rootStatus: () => ({}) },
    photoSetService: { coverUrl: () => "" }, photoCollectionRootValue: "__root__", galleryMediaRootStatuses: () => [],
    photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}) };
  return { state, owner, actual: factory(deps), before: oldFactory(deps),
    publish(nextRows) { current = snapshot(nextRows); owner.invalidate(); },
    request(params = {}, options = {}) { return this.actual.itemsPayload(request(params), options); },
    expected(params = {}) { return this.before.itemsPayload(request(params)); },
    expectedSnapshot(index, params = {}) { return oldFactory({ ...deps, getImageLibraryIndex: () => index,
      getImageLibraryRevision: null }).itemsPayload(request(params)); } };
}
function request(params = {}) { return new URL(`http://fixture.invalid/?${new URLSearchParams({ mode: "photo", photoView: "albums", limit: "48", ...params })}`); }
function ordinary(response) { const { listRevision, ...value } = response; return value; }
function equal(actual, expected, label) {
  assert.deepEqual(ordinary(actual), ordinary(expected), label);
  assert.equal(JSON.stringify(ordinary(actual)), JSON.stringify(ordinary(expected)), `${label}: wire field order`);
  assert.match(actual.listRevision, /^[0-9a-f]{64}$/);
  comparisons++;
  return actual;
}
function verifyContracts() {
  const rows = Array.from({ length: 245 }, (_, i) => item(i));
  rows.push(item(999, { title: "无编号 🙂 Ω 裙", personName: "Person Ω" }), item(1000, { title: "[Sub0] VOL.1001 主题特写 [40P]", personName: "Sub0" }));
  const value = fixture(rows, { factory: testedFactory });
  const matrix = [{}, { q: "主题" }, { q: "VOL 1" }, { q: "🙂" }, { q: "Ω" }, { q: " ", sort: "unknown" }, { q: "no-such-photo" },
    { search: "主题特写" }, { q: "主题", sort: "title" }, { sort: "title" }, { sort: "count" }, { sort: "size" }, { sort: "year" }, { sort: "rating" },
    { category: "C1" }, { subCategory: "Sub1" }, { person: "Person 1" }, { date: "2026-01" }, { date: "2026-01-01" },
    { category: "missing" }, { person: "missing" }, { date: "missing" }, { category: "C1", subCategory: "Sub1", person: "Person 1", q: "主题" },
    { collection: "synthetic|C1/Sub1" }, { collection: "synthetic|C1/Sub1", category: "C1", q: "主题" },
    { photoView: "collections" }, { photoView: "collections", category: "C1" }, { photoView: "collections", q: "Synthetic" },
    { photoView: "collections", collection: "synthetic|C1/Sub1" }, { photoView: "unknown" }, { limit: "1", offset: "99999" }];
  for (const params of matrix) {
    equal(measured(() => value.request(params)).value, measured(() => value.expected(params)).value, `cold ${JSON.stringify(params)}`);
    const window = { ...params, offset: "3", limit: "7" };
    equal(measured(() => value.request(window)).value, measured(() => value.expected(window)).value, `next window ${JSON.stringify(params)}`);
  }
  const numbered = equal(measured(() => value.request({ q: "主题", limit: "1" })).value, measured(() => value.expected({ q: "主题", limit: "1" })).value, "numbered subject cold");
  const warm = equal(measured(() => value.request({ q: "主题", limit: "1" })).value, numbered, "numbered subject cached");
  assert(warm.items[0].albumNumber && warm.items[0].albumSubject && warm.items[0].matchFields.includes("title"));
  assert.equal(value.state.metadataCalls, 0);
}
function verifyCollectionAggregation() {
  const value = fixture([
    item(0, { category: "C0", collectionId: "synthetic|[合辑 2]", updatedAt: "2026-01-01T08:00:00+08:00", coverUrl: " " }),
    item(1, { category: "C0", collectionId: "synthetic|[合辑 2]", updatedAt: "2026-01-01T00:00:00Z" }),
    item(2, { category: "C0", collectionId: "synthetic|[合辑 2]", updatedAt: "broken legacy date" }),
    item(3, { category: "C1", collectionId: "synthetic|[合辑 2]", updatedAt: "2026-02-01T00:00:00Z" }),
    item(4, { category: "C0", collectionId: "synthetic|合辑 10", updatedAt: "" }),
    item(5, { category: "C0", collectionId: "synthetic|合辑 10", updatedAt: "1969-01-01T00:00:00Z" }),
    item(6, { category: "", relativePath: "album.zip", rootLabel: "", sourceRoot: "" }),
    item(7, { category: "C0", relativePath: "\\合辑 3\\\\目录\\album.zip", sourceRoot: "another source" })
  ]);
  const view = { photoView: "collections", sort: "count" };
  for (const params of [view, { ...view, offset: "1", limit: "2" }, { ...view, category: "C0" },
    { ...view, q: "合辑" }, { ...view, collection: "synthetic|[合辑 2]" }]) {
    equal(value.request(params), value.expected(params), `collection aggregation ${JSON.stringify(params)}`);
  }
}
function verifyCollectionPages() {
  const rows = Array.from({ length: 185 }, (_, index) => {
    const collection = index % 155;
    const label = ["Åland", "Älmhult", "Zeta"][collection] || `合辑 ${collection}`;
    return item(index, { collectionId: `root-${collection % 2}|${label}`, size: index === 55 ? "invalid legacy size" : index + 1 });
  });
  const value = fixture(rows);
  const shelf = { photoView: "collections" };
  for (const params of [{ sort: "updated" }, { sort: "count" }, { sort: "size" }, { sort: "title" },
    { sort: "count", category: "C1" }, { sort: "updated", subCategory: "Sub0", person: "Person 0", date: "2026-01" },
    { sort: "title", category: "missing" }]) {
    const legacy = value.expected({ ...shelf, ...params, limit: "1000" });
    const expected = photoCatalogCollections(legacy.items, params.sort);
    const listParams = { ...shelf, ...params, collectionPage: "1", limit: "17" };
    const pages = [value.request(listParams)];
    while (pages.at(-1).nextOffset < expected.length) {
      pages.push(value.request({ ...listParams, offset: String(pages.at(-1).nextOffset) }));
      assert(pages.at(-1).count > 0, "a nonterminal collection page must advance");
    }
    assert.deepEqual(pages.flatMap(page => page.items), expected, `same deduplication, representatives and sorting for ${JSON.stringify(params)}`);
    for (const page of pages) {
      assert.equal(page.collectionPage, true);
      assert.equal(page.total, expected.length);
      assert.equal(page.nextOffset, page.offset + page.count);
      assert.equal(page.listRevision, pages[0].listRevision);
      assert.equal(page.stats.albumCount, expected.reduce((sum, collection) => sum + collection.albumCount, 0));
      assert.deepEqual(page.facets, legacy.facets);
    }
  }
  const params = { ...shelf, sort: "title", collectionPage: "1", limit: "3" };
  const prior = value.request(params);
  const legacy = value.request({ ...shelf, sort: "title", limit: "1000" });
  assert.equal(legacy.collectionPage, undefined);
  assert(legacy.items[0].collections.length > 0, "flat and nested plans must be isolated");
  const collator = new Intl.Collator("sv", { numeric: true, sensitivity: "base" });
  const swedish = value.request({ ...params, collectionLocale: "sv", limit: "1000" });
  const expected = photoCatalogCollections(legacy.items, "title").sort((a, b) => collator.compare(a.title, b.title));
  assert.deepEqual(swedish.items, expected);
  assert.deepEqual(value.request({ ...params, collectionLocale: "invalid_locale" }).items, prior.items);
  for (const unsupported of [{ q: "合辑" }, { collection: "root-0|Åland" }, { photoView: "albums" }]) {
    assert.equal(value.request({ ...params, ...unsupported }).collectionPage, undefined);
  }
  const offset = String(Number.MAX_SAFE_INTEGER);
  const empty = value.request({ ...params, offset });
  assert.equal(empty.collectionPage, true);
  assert.equal(empty.count, 0);
  assert.equal(empty.nextOffset, Number(offset));
  value.publish(rows.slice(0, 130));
  const refreshed = value.request(params);
  assert.notEqual(refreshed.listRevision, prior.listRevision);
  assert.equal(refreshed.total, 130);
}
function verifyLargeCollectionPages() {
  const count = IMAGE_QUERY_CACHE_MAX_ROWS + 1;
  const value = fixture(Array.from({ length: count }, (_, index) => item(index, {
    category: "C0", collectionId: `synthetic|合辑 ${index}`, rootLabel: index === 100 ? "" : "Synthetic"
  })));
  const params = { photoView: "collections", collectionPage: "1", sort: "title", limit: "17" };
  const first = measured(() => value.request(params));
  const next = { ...params, offset: "99" };
  const warm = measured(() => value.request(next));
  const legacy = value.expected({ photoView: "collections", sort: "title" });
  const expected = photoCatalogCollections(legacy.items, "title").slice(99, 116);
  assert.equal(first.value.total, count);
  assert(first.metrics.sortCalls > 0);
  assert.equal(warm.metrics.sortCalls, 0, "catalog-owned collections above the ordinary row cap reuse their order");
  assert.equal(warm.value.listRevision, first.value.listRevision);
  assert.deepEqual(warm.value.items, expected);
  assert.equal(warm.value.items[1].rootLabel, "");
  assert.equal(warm.value.items[1].catalogRootLabel, "Synthetic", "a cached page keeps the original parent fallback");
  warm.value.items[1].catalogRootLabel = "poison";
  assert.deepEqual(value.request(next).items, expected);

  const filtered = { ...next, category: "C0" };
  value.request(filtered);
  const rebuilt = measured(() => value.request(filtered));
  assert(rebuilt.metrics.sortCalls > 0, "request-owned filtered rows stay subject to the ordinary row cap");
  assert.deepEqual(rebuilt.value.items, expected);

  const albums = { photoView: "albums", sort: "title", limit: "17" };
  const firstAlbums = measured(() => value.request(albums));
  equal(firstAlbums.value, value.expected(albums), "first album page from a large compact catalog");
  assert.equal(firstAlbums.metrics.archiveDates, 17);
  const laterAlbums = { ...albums, offset: "17" };
  const warmAlbums = measured(() => value.request(laterAlbums));
  equal(warmAlbums.value, value.expected(laterAlbums), "cached album page hydrates only its own rows");
  assert.equal(warmAlbums.metrics.archiveDates, 17);
  assert.equal(warmAlbums.metrics.sortCalls, 0);
}
function verifyCollectionProjection() {
  const rows = Array.from({ length: 240 }, (_, index) => item(index, {
    collectionId: `synthetic|合辑 ${index % 30}`,
    ...(index === 0 ? { title: "", dirName: "2026-01-01 无人物图册", personName: "", imageCount: "invalid old count" } : {}),
    ...(index === 30 ? { title: "2026-01-01 人物甲", personName: "人物甲" } : {}),
    ...(index === 41 ? { rating: 4, year: "1991", albumCount: 5 } : {}),
    ...(index === 72 ? { rating: 3, movieMetadata: { rating: "0", year: "2005" }, tvSeries: { rating: 8 } } : {})
  }));
  const view = { photoView: "collections", sort: "count" };
  const selected = { collection: "synthetic|合辑 0", date: "2026-01" };
  const value = fixture(rows);
  const compact = measured(() => value.request(view));
  equal(compact.value, value.expected(view), "compact collection grouping retains complete legacy data");
  assert.equal(compact.metrics.archiveDates, 0);
  const group = measured(() => value.request(selected));
  equal(group.value, value.expected(selected), "selected collection hydrates full album subjects and dates");
  assert.equal(group.metrics.archiveDates, 8, "only albums inside the chosen collection derive dates");
  for (const sort of ["updated", "title", "size", "rating", "year", "count"]) {
    const params = { sort, limit: "17", ...(sort === "updated" ? { category: "C0" } : {}) };
    const page = measured(() => value.request(params));
    equal(page.value, value.expected(params), `compact album sort ${sort}`);
    assert.equal(page.metrics.archiveDates, 17);
  }
  const upgrade = { sort: "title", limit: "17", date: "2026-01-01" };
  const upgraded = measured(() => value.request(upgrade));
  equal(upgraded.value, value.expected(upgrade), "date filters upgrade the complete album catalog");
  assert.equal(upgraded.metrics.archiveDates, rows.length);
  const warmedSort = measured(() => value.request({ sort: "title", limit: "17" }));
  equal(warmedSort.value, value.expected({ sort: "title", limit: "17" }), "full albums retain prepared compact order");
  assert.equal(warmedSort.metrics.archiveDates, 0);
  assert.equal(warmedSort.metrics.sortCalls, 0);
  equal(value.request(view), compact.value, "upgrading does not invalidate collection grouping on the same source");

  const direct = fixture(rows);
  const directRead = measured(() => direct.request(selected));
  equal(directRead.value, direct.expected(selected), "direct collection detail does not need a full album catalogue");
  assert.equal(directRead.metrics.archiveDates, 8);
  const dates = { ...view, date: "2026-01-01" };
  equal(direct.request(dates), direct.expected(dates), "date-filtered collection grouping uses the full archive dates");
}
function verifyClones() {
  const value = fixture(Array.from({ length: 100 }, (_, i) => item(i)));
  const params = { q: "主题" }, expected = measured(() => value.expected(params)).value;
  const cold = measured(() => value.request(params)).value;
  cold.items[0].genres.push("poison"); cold.items[0].matchFields.push("poison"); cold.facets.categories[0].value = "poison";
  const warm = equal(measured(() => value.request(params)).value, expected, "cold photo DTO is detached");
  warm.items[0].albumSubject = "poison"; warm.items[0].genres[0] = "poison"; warm.facets.people[0].count = -1;
  equal(measured(() => value.request(params)).value, expected, "warm photo DTO is detached");
  const groups = measured(() => value.request({ photoView: "collections" })).value;
  const groupExpected = measured(() => value.expected({ photoView: "collections" })).value;
  groups.items[0].collections[0].title = "poison"; groups.items[0].collections.push({ title: "poison" });
  equal(measured(() => value.request({ photoView: "collections" })).value, groupExpected, "nested collection DTOs are detached");
  const collection = { collection: "synthetic|C1/Sub1" };
  const selected = measured(() => value.request(collection)).value, selectedExpected = measured(() => value.expected(collection)).value;
  selected.collectionSummary.title = "poison"; selected.facets.dates[0].value = "poison";
  equal(measured(() => value.request(collection)).value, selectedExpected, "collection summary and date facets are detached");
  assert(!value.owner.getIndex().photoSets.some(row => row.genres.includes("poison")));
}
function verifyInvalidation() {
  const value = fixture(Array.from({ length: 140 }, (_, i) => item(i))), params = { q: "主题" };
  const first = measured(() => value.request(params)).value;
  assert.equal(measured(() => value.request(params)).metrics.searchedRows, 0);
  value.publish(value.owner.getIndex().photoSets.map((row, i) => i === 0 ? { ...row, title: "主题 replaced same count" } : row));
  const replaced = measured(() => value.request(params));
  equal(replaced.value, measured(() => value.expected(params)).value, "same scannedAt/count replacement publication");
  assert.equal(replaced.metrics.searchedRows, 140); assert.notEqual(replaced.value.listRevision, first.listRevision);
  const expected = measured(() => value.expected(params)).value;
  value.state.afterProbe = () => value.publish(value.owner.getIndex().photoSets.map((row, i) => i === 1 ? { ...row, title: "主题 race" } : row));
  const raced = measured(() => value.request(params));
  equal(raced.value, expected, "cache hit source race retains selected snapshot");
  assert.notEqual(raced.value.listRevision, replaced.value.listRevision);
  const next = measured(() => value.request(params));
  equal(next.value, measured(() => value.expected(params)).value, "following request observes raced publication");
  assert.equal(next.metrics.searchedRows, 140);
  value.actual.clearPreparedQueries();
  const expectedCold = measured(() => value.expected(params)).value;
  value.state.afterProbe = () => value.publish(value.owner.getIndex().photoSets.map((row, i) => i === 2 ? { ...row, title: "主题 cold race" } : row));
  equal(measured(() => value.request(params)).value, expectedCold, "cold source race retains selected snapshot");
  assert.equal(measured(() => value.request(params)).metrics.searchedRows, 140, "cold race is not reused");
  measured(() => value.request({ q: "Fixture" }));
  assert.equal(measured(() => value.request(params)).metrics.searchedRows, 140, "query switch evicts the one retained plan");
  measured(() => value.request({ mode: "western" }));
  assert.equal(measured(() => value.request(params)).metrics.searchedRows, 140, "mode switch evicts the one retained plan");
  const refreshed = measured(() => value.request(params, { refresh: true }));
  equal(refreshed.value, measured(() => value.expected(params)).value, "refresh publishes an empty fixture snapshot");
  assert.equal(refreshed.value.total, 0);
  assert.equal(measured(() => value.request(params)).metrics.searchCalls, 1, "refresh result is not admitted");
  assert.equal(value.state.metadataCalls, 0);
}
function verifyClock() {
  let now = originalNow(); Date.now = () => now;
  try {
    const value = fixture(Array.from({ length: 80 }, (_, i) => item(i))), params = { q: "主题" };
    measured(() => value.request(params));
    now += IMAGE_QUERY_CACHE_MAX_AGE_MS - 1;
    assert.equal(measured(() => value.request(params)).metrics.searchedRows, 0, "last millisecond before TTL is valid");
    now++;
    const expired = measured(() => value.request(params));
    equal(expired.value, measured(() => value.expected(params)).value, "exact 30s boundary");
    assert.equal(expired.metrics.searchedRows, 80);
    now--;
    assert.equal(measured(() => value.request(params)).metrics.searchedRows, 80, "negative cache age invalidates");
  } finally { Date.now = originalNow; }
}
function verifyBudgets() {
  for (const count of [IMAGE_QUERY_CACHE_MAX_ROWS, IMAGE_QUERY_CACHE_MAX_ROWS + 1]) {
    const value = fixture(Array.from({ length: count }, (_, i) => item(i, { personName: `主题 ${i % 17}` }))), params = { q: "主题" };
    const first = equal(measured(() => value.request(params)).value, measured(() => value.expected(params)).value, `row budget ${count}`);
    const warm = measured(() => value.request({ ...params, offset: "48" }));
    equal(warm.value, measured(() => value.expected({ ...params, offset: "48" })).value, `row budget next ${count}`);
    assert.equal(warm.metrics.searchedRows, 0);
    assert.equal(warm.value.listRevision, first.listRevision);
    if (count > IMAGE_QUERY_CACHE_MAX_ROWS) {
      assert.deepEqual(warm.value.items[0].matchFields, ["title", "person"]);
      warm.value.items[0].matchFields.push("poison");
      warm.value.items[0].genres.push("poison");
      equal(value.request({ ...params, offset: "48" }), value.expected({ ...params, offset: "48" }), "compact photo DTO is detached");
      value.publish(value.owner.getIndex().photoSets.map((row, i) => i === 0 ? { ...row, title: "主题 replaced", genres: ["changed"] } : row));
      const replaced = measured(() => value.request(params));
      equal(replaced.value, value.expected(params), "compact plan invalidated after publication");
      assert.equal(replaced.metrics.searchedRows, count);
      assert.notEqual(replaced.value.listRevision, first.listRevision);
    }
  }
  const cache = createImageQueryCache();
  for (const count of [IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS, IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS + 1]) {
    for (const extras of [{ matchMasks: new Uint8Array(count) }, { collectionLabels: new Map() }, { compactAlbumRows: true }]) {
      const plan = { header: {}, items: Array(count), ...extras };
      assert.equal(cache.set("photo", "stamp", plan), count <= IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS);
      assert.equal(cache.get("photo", "stamp"), count <= IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS ? plan : null);
    }
  }
  const title = "x".repeat(20000), count = 900;
  assert(Buffer.byteLength(title) * count > IMAGE_QUERY_CACHE_MAX_BYTES, "titles alone independently exceed retained byte budget");
  const huge = fixture(Array.from({ length: count }, (_, i) => item(i, { title: `${title} ${i}` }))), params = { q: "xxx" };
  measured(() => huge.request(params));
  const warm = measured(() => huge.request({ ...params, offset: "48" }));
  equal(warm.value, measured(() => huge.expected({ ...params, offset: "48" })).value, "over-byte-budget complete page");
  assert.equal(warm.metrics.searchedRows, count, "oversized photo text is not retained");
}
function verifyLegacyProvider() {
  const value = fixture(Array.from({ length: 90 }, (_, i) => item(i)), { revision: false }), params = { q: "主题" };
  measured(() => value.request(params));
  value.owner.getIndex().photoSets[89].genres.push("legacy mutable genre");
  const reread = measured(() => value.request(params));
  equal(reread.value, measured(() => value.expected(params)).value, "provider without revision retains former path");
  assert.equal(reread.metrics.searchedRows, 90);
  assert(reread.value.items[0].genres.includes("legacy mutable genre"));
}
function verifyScale() {
  const value = fixture(Array.from({ length: 100000 }, (_, i) => item(i, {
    title: `${i % 2 === 0 ? "Target" : "Other"} VOL.${i + 1} 主题 ${i}`, category: `C${i % 10}`
  })), { factory: testedFactory });
  const params = { q: "Target" };
  const coldBefore = measured(() => value.before.itemsPayload(request(params)));
  const coldAfter = measured(() => value.request(params));
  equal(coldAfter.value, coldBefore.value, "100k source cold query");
  const run = service => measured(() => Array.from({ length: 20 }, (_, page) => service.itemsPayload(request({ ...params, offset: String((page + 1) * 48) }))));
  const before = run(value.before), after = run(value.actual);
  after.value.forEach((page, i) => equal(page, before.value[i], `100k source warm page ${i}`));
  assert.equal(before.metrics.searchedRows, 2000000);
  assert.equal(after.metrics.searchedRows, 0, "twenty warm photo pages must not search the full source again");
  assert.equal(after.metrics.searchComparisons, 0, "twenty warm photo pages must not sort search matches again");
  const selected = { category: "C0", sort: "title" };
  measured(() => value.before.itemsPayload(request(selected))); measured(() => value.request(selected));
  const categoryBefore = measured(() => value.before.itemsPayload(request({ ...selected, offset: "48" })));
  const categoryAfter = measured(() => value.request({ ...selected, offset: "48" }));
  equal(categoryAfter.value, categoryBefore.value, "warm category page");
  assert.equal(categoryBefore.metrics.filteredRows, 100000); assert.equal(categoryBefore.metrics.sortedRows, 10000);
  assert.equal(categoryAfter.metrics.filteredRows, 0); assert.equal(categoryAfter.metrics.sortedRows, 0);
  return { sourcePhotos: 100000, matchedPhotos: coldAfter.value.total, warmPages: 20,
    cold: { before: coldBefore.instrumentedDiagnosticMs, current: coldAfter.instrumentedDiagnosticMs },
    before: { ...before.metrics, instrumentedDiagnosticMs: before.instrumentedDiagnosticMs },
    current: { ...after.metrics, instrumentedDiagnosticMs: after.instrumentedDiagnosticMs },
    category: { before: categoryBefore.metrics, current: categoryAfter.metrics } };
}

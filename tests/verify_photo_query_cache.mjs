import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION, imageLibraryCacheIdentity } from "../src/modules/content-index/server/image-library-index-contract.js";
import { IMAGE_QUERY_CACHE_MAX_AGE_MS, IMAGE_QUERY_CACHE_MAX_ROWS, IMAGE_QUERY_CACHE_MAX_BYTES } from "../src/modules/content-index/server/image-query-cache.js";

const args = process.argv.slice(2);
assert(args.every(arg => arg === "--disable-photo-cache"), "known arguments");
const root = new URL("../src/modules/content-index/server/", import.meta.url);
const oldSource = execFileSync("git", ["show", "63c5fab243233e142cfd62c4eaf13812feb92405:src/modules/content-index/server/image-library-service.js"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8"
}).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(oldSource).digest("hex"), "30bef6e506a38bda3e4ee7eca57b3b9ba435ecbdffaf3d6a4de89b2e2666b4d2", "fixed complete pre-cache owner");
const currentSource = fs.readFileSync(new URL("image-library-service.js", root), "utf8").replace(/\r\n/g, "\n");
const metricName = "__fanhaoPhotoQueryFixtureMetrics";
const oldFactory = await loadFactory(oldSource);
const currentFactory = await loadFactory(currentSource);
const testedFactory = args.includes("--disable-photo-cache") ? await loadFactory(disablePhoto(currentSource)) : currentFactory;
assert.equal(globalThis[metricName], undefined);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-photo-query-cache-"));
const files = new Set();
const originalNow = Date.now;
let sequence = 0, comparisons = 0;
globalThis[metricName] = newMetrics();
try {
  verifyContracts();
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
  // Only files created by this fixture, including actual owner's refresh
  // publications. Every configured media root is empty; no real media scan.
  for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmdirSync(temporary);
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
async function loadFactory(source) {
  for (const [anchor, metric] of [
    ["  function filterPhotoSetsForList(items, filters = {}) {", "filteredRows += items.length"],
    ["  function searchImageLibraryItems(items, searchSpec) {", "searchedRows += items.length; globalThis.__fanhaoPhotoQueryFixtureMetrics.searchCalls += 1"],
    ["  function sortImageLibraryItems(items, sort) {", "sortedRows += items.length; globalThis.__fanhaoPhotoQueryFixtureMetrics.sortCalls += 1"],
    ["  function compareImageSearchResults(a, b) {", "searchComparisons += 1"]
  ]) source = replaceOnce(source, anchor, `${anchor}\n    globalThis.${metricName}.${metric};`);
  source = source.replace(/from\s+"(\.{1,2}\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, root).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createImageLibraryService;
}
function newMetrics() { return { filteredRows: 0, searchedRows: 0, searchCalls: 0, sortedRows: 0, sortCalls: 0, searchComparisons: 0 }; }
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
  const options = { archiveExts: new Set([".zip"]), directVideoExts: new Set([".mp4"]), galleryMediaSources: [], photoSetRoots: [], videoExts: new Set([".mp4"]) };
  const indexPath = path.join(temporary, `index-${++sequence}.json`);
  files.add(indexPath);
  const snapshot = photoSets => ({ schemaVersion: CURRENT_INDEX_SCHEMA, parserVersion: PARSER_VERSION,
    cacheIdentity: imageLibraryCacheIdentity(options), scannedAt: "2026-01-01T00:00:00.000Z", photoSets, mediaItems: [] });
  const state = { metadataCalls: 0, afterProbe: null };
  const write = value => fs.writeFileSync(indexPath, JSON.stringify(value), "utf8");
  write(snapshot(rows));
  const owner = createImageLibraryIndexService({ ...options, imageLibraryIndexPath: indexPath, ensureDataDir() {},
    readJsonFile: file => JSON.parse(fs.readFileSync(file, "utf8")), safeStat: () => null,
    isExcludedDirName: () => false, isVideo: value => String(value).endsWith(".mp4"), normalizeExt: path.extname,
    createId: (prefix, key) => `${prefix}:${key}`, photoSetCoverUrl: () => "" });
  const metadataService = new Proxy({}, { get() { state.metadataCalls++; throw new Error("Photo never reads movie/TV metadata"); } });
  const deps = { cachePreparedQueries: true, getImageLibraryIndex: owner.getIndex,
    getImageLibraryRevision: revision ? () => { const stamp = owner.listRevision(); const action = state.afterProbe; state.afterProbe = null; action?.(); return stamp; } : null,
    clampInteger: (value, fallback, min, max) => { const n = Number.parseInt(value, 10); return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback)); },
    metadataService, maxItemLimit: 20000, mangaService: { cacheDirs: () => [], rootStatus: () => ({}) },
    photoSetService: { coverUrl: () => "" }, photoCollectionRootValue: "__root__", galleryMediaRootStatuses: () => [],
    photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}) };
  return { state, owner, actual: factory(deps), before: oldFactory(deps),
    publish(nextRows) { write(snapshot(nextRows)); owner.invalidate(); },
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
  equal(refreshed.value, measured(() => value.expected(params)).value, "actual refresh scans only empty configured roots");
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
    const value = fixture(Array.from({ length: count }, (_, i) => item(i))), params = { q: "主题" };
    equal(measured(() => value.request(params)).value, measured(() => value.expected(params)).value, `row budget ${count}`);
    const warm = measured(() => value.request({ ...params, offset: "48" }));
    equal(warm.value, measured(() => value.expected({ ...params, offset: "48" })).value, `row budget next ${count}`);
    assert.equal(warm.metrics.searchedRows, count > IMAGE_QUERY_CACHE_MAX_ROWS ? count : 0);
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
    title: `${i % 10 === 0 ? "Target" : "Other"} VOL.${i + 1} 主题 ${i}`, category: `C${i % 10}`
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

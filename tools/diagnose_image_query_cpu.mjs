import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createGalleryMetadataService } from "../src/modules/media/server/gallery-metadata-service.js";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";

// Private CPU diagnostic: current production functions versus the restored
// previous query algorithms, synthetic index and in-memory SQLite only.
const fixture = fs.readFileSync(new URL("./verify_image_library_performance.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const fixtureHelpers = fixture.slice(fixture.indexOf("function createProductionShapeIndex()"));
const { createProductionShapeIndex, createService, request } = await import(`data:text/javascript;base64,${Buffer.from(`${fixtureHelpers}\nexport { createProductionShapeIndex, createService, request };`).toString("base64")}`);
const source = fs.readFileSync(new URL("../src/modules/content-index/server/image-library-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const names = ["preparedPhotoCatalog", "publicImageLibraryListItem", "photoAlbumSubject", "photoArchiveDate", "photoPersonFacets", "sortImageLibraryItems", "publicGalleryMediaItem", "tvSeriesGroups", "mediaLibraryFacets", "facetCounts"];
const metrics = {};
let measured = source;
for (const name of names) {
  const start = measured.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const open = measured.indexOf(") {", start) + 3;
  const next = measured.indexOf("\n  function ", open);
  const boundary = next < 0 ? measured.indexOf("\n  return {\n    itemsPayload", open) : next;
  const tail = measured.lastIndexOf("\n  }", boundary);
  assert.ok(open > start && tail > open, `${name} boundaries`);
  measured = `${measured.slice(0, open)}\n    const __start = performance.now(); try {${measured.slice(open, tail)}\n    } finally { const entry = globalThis.__imageCpuMetrics[${JSON.stringify(name)}] ||= { calls: 0, ms: 0 }; entry.calls++; entry.ms += performance.now() - __start; }${measured.slice(tail)}`;
}
globalThis.__imageCpuMetrics = metrics;
let profiledFactory;
try { ({ createImageLibraryService: profiledFactory } = await import(`data:text/javascript;base64,${Buffer.from(measured).toString("base64")}`)); }
catch (error) { throw new Error(`instrumentation failed: ${error.message}`); }
const index = createProductionShapeIndex();
const profiled = createService(profiledFactory, index);
function measure(label, run) {
  for (const key of Object.keys(metrics)) delete metrics[key];
  const began = performance.now(), payload = run();
  console.log(JSON.stringify({ label, ms: +(performance.now() - began).toFixed(2), total: payload.total,
    metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, { calls: value.calls, ms: +value.ms.toFixed(2) }])) }));
  return payload;
}
async function simulatedFactory(code) {
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)).createImageLibraryService; }
  catch (error) { throw new Error(`private candidate failed to load: ${error.message}`); }
}
const correctnessFixture = fs.readFileSync(new URL("./verify_image_query_correctness.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const baselineBuilder = correctnessFixture.slice(correctnessFixture.indexOf("export function previousQuerySource("), correctnessFixture.indexOf("\n\nlet previousFactory;"));
const { previousQuerySource } = await import(`data:text/javascript;base64,${Buffer.from(`import assert from "node:assert/strict";\n${baselineBuilder}`).toString("base64")}`);
const previousFactory = await simulatedFactory(previousQuerySource(source));
const albums = request({ mode: "photo", photoView: "albums", limit: "48" });
const previousAlbums = measure("photo-albums-cold-previous", () => createService(previousFactory, index).itemsPayload(albums));
const currentAlbums = measure("photo-albums-cold-current-profiled", () => profiled.itemsPayload(albums));
assert.ok(JSON.stringify(currentAlbums) === JSON.stringify(previousAlbums), "all album response bytes remain equal");
measure("photo-albums-warm-current-profiled", () => profiled.itemsPayload(albums));

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE movie_metadata(media_id TEXT PRIMARY KEY); CREATE TABLE tv_series_metadata(series_key TEXT PRIMARY KEY)");
let sql = { bulk: 0, point: 0 };
const metadata = createGalleryMetadataService({ createId: (_prefix, key) => key, getImageGalleryDb: () => ({ prepare(query) {
  sql[query.includes(" WHERE ") ? "point" : "bulk"]++;
  return db.prepare(query);
} }), notFound: () => {} });
const fixtureService = createService(createImageLibraryService, index);
// Obtain the exact fixture dependencies with an injected factory.
let deps;
createService((value) => { deps = value; return {}; }, index);
const production = createImageLibraryService({ ...deps, metadataService: metadata });
const previous = previousFactory({ ...deps, metadataService: metadata });
for (const mode of ["movie", "media", "tv"]) {
  for (const offset of [0, 48]) {
    sql = { bulk: 0, point: 0 };
    const url = request({ mode, limit: "48", offset: String(offset) });
    const began = performance.now();
    const value = production.itemsPayload(url);
    const elapsed = performance.now() - began;
    assert.ok(JSON.stringify(value) === JSON.stringify(fixtureService.itemsPayload(url)), `${mode} current real SQLite output matches the fixture`);
    console.log(JSON.stringify({ label: `${mode}-page-${offset}`, ms: +elapsed.toFixed(2), count: value.count, total: value.total, sql }));
    sql = { bulk: 0, point: 0 };
    const previousBegan = performance.now(), previousValue = previous.itemsPayload(url), previousElapsed = performance.now() - previousBegan;
    assert.ok(JSON.stringify(previousValue) === JSON.stringify(value), "previous query algorithm has identical response bytes");
    console.log(JSON.stringify({ label: `${mode}-page-${offset}-previous`, ms: +previousElapsed.toFixed(2), sql }));
  }
}
db.close();

let current = index;
const lookup = createGalleryMediaService({ getImageLibraryIndex: () => current });
const selected = index.mediaItems.slice(-48);
const began = performance.now();
for (let repeat = 0; repeat < 4; repeat++) for (const item of selected) assert.equal(index.mediaItems.find((row) => row.id === item.id), item);
console.log(JSON.stringify({ label: "byId-48-tail-covers-4-checks-previous", ms: +(performance.now() - began).toFixed(2), scans: 192, rows: index.mediaItems.length }));
const mapBegan = performance.now();
for (let repeat = 0; repeat < 4; repeat++) for (const item of selected) assert.equal(lookup.byId(item.id), item);
console.log(JSON.stringify({ label: "byId-map-build-and-192-lookups-current", ms: +(performance.now() - mapBegan).toFixed(2) }));
current = { ...index, mediaItems: [] };
assert.equal(lookup.byId(selected[0].id), null, "fresh index identity immediately removes old media");
current = { ...index, mediaItems: [{ ...selected[0], title: "replacement" }] };
assert.equal(lookup.byId(selected[0].id).title, "replacement", "source replacement is observed immediately");
delete globalThis.__imageCpuMetrics;

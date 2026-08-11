import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servicePath = path.join(root, "src", "modules", "content-index", "server", "image-library-service.js");
const serviceSource = fs.readFileSync(servicePath, "utf8");
const { createImageLibraryService: createLegacyImageLibraryService } = await import(legacyServiceModuleUrl(serviceSource));
const index = createProductionShapeIndex();

assert(!serviceSource.includes("collections: photoCollectionGroups(items)"), "prepared photo catalog must not retain an unused collection list");
assert(serviceSource.includes("function preparedPhotoCollectionCategories(catalog)"), "collection categories must remain lazy");
assert(serviceSource.includes("const archiveDate = normalizedMode === \"photo\" ? photoArchiveDate(photoTitle) : \"\";"), "photo archive dates must be parsed once per list item");
assert(serviceSource.includes("archiveMonth: archiveDate.slice(0, 7)"), "photo archive month must derive from the parsed date");

const androidApp = fs.readFileSync(path.join(root, "android-client", "www", "app.js"), "utf8");
const webGalleryPage = fs.readFileSync(path.join(root, "public", "modules", "content-index", "gallery-page.js"), "utf8");
assert(androidApp.includes('const IMAGE_LIBRARY_SUMMARY_CACHE_PATH = "/api/image-library/summary?cache=0";'), "Android must skip an unused image-reader cache summary");
assert(webGalleryPage.includes('const summaryEndpoint = isImageLibraryMode() ? "/api/image-library/summary" : "/api/image-library/summary?cache=0";'), "Web image-library mode must continue to request its cache summary");

const optimizedService = createService(createImageLibraryService, index);
const summaryCold = measure(() => optimizedService.summaryPayload({ includeCache: false }));
const summaryWarm = measure(() => optimizedService.summaryPayload({ includeCache: false }));
const albumsCold = measure(() => optimizedService.itemsPayload(request({ mode: "photo", photoView: "albums", limit: "48" })));
const albumsWarm = measure(() => optimizedService.itemsPayload(request({ mode: "photo", photoView: "albums", limit: "48" })));

assert(summaryWarm.elapsedMs <= summaryCold.elapsedMs, "warm summary must reuse the static index projection");
assert(albumsWarm.elapsedMs < albumsCold.elapsedMs, "warm default albums must reuse their prepared sort");

const matrix = [
  ["summary", (service) => service.summaryPayload({ includeCache: false })],
  ["albums", (service) => service.itemsPayload(request({ mode: "photo", photoView: "albums", limit: "48" }))],
  ["albums-offset-title", (service) => service.itemsPayload(request({ mode: "photo", photoView: "albums", sort: "title", offset: "96", limit: "48" }))],
  ["albums-filtered-size", (service) => service.itemsPayload(request({ mode: "photo", photoView: "albums", category: "分类 2", subCategory: "文件夹 2", person: "人物 42", date: "2026-07", sort: "size", limit: "48" }))],
  ["albums-cjk-search", (service) => service.itemsPayload(request({ mode: "photo", photoView: "albums", q: "特别作品", offset: "24", limit: "48" }))],
  ["albums-collection", (service) => service.itemsPayload(request({ mode: "photo", photoView: "albums", collection: "T:\\[套图]|合集 7/文件夹 7", sort: "updated", limit: "48" }))],
  ["collections", (service) => service.itemsPayload(request({ mode: "photo", photoView: "collections", sort: "count", limit: "48" }))],
  ["collections-filtered", (service) => service.itemsPayload(request({ mode: "photo", photoView: "collections", category: "分类 1", sort: "title", limit: "48" }))]
];

const optimizedResponses = matrix.map(([name, run]) => [name, run(optimizedService)]);
const legacyService = createService(createLegacyImageLibraryService, index);
for (const [name, run] of matrix) {
  const legacyResponse = run(legacyService);
  const optimizedResponse = optimizedResponses.find(([candidate]) => candidate === name)[1];
  assert.deepStrictEqual(legacyResponse, optimizedResponse, `${name} must remain structurally equivalent to the legacy full facet sort`);
  assert.equal(JSON.stringify(legacyResponse), JSON.stringify(optimizedResponse), `${name} must preserve serialized response bytes`);
}

console.log(
  `image-library-performance: 50k-photo/18k-media, summary cold=${summaryCold.elapsedMs.toFixed(1)}ms warm=${summaryWarm.elapsedMs.toFixed(1)}ms, albums cold=${albumsCold.elapsedMs.toFixed(1)}ms warm=${albumsWarm.elapsedMs.toFixed(1)}ms (guidance: summary <150/<5ms; albums <500/<50ms; equivalence is the hard gate)`
);
console.log("image-library-performance: ok");

function legacyServiceModuleUrl(source) {
  const start = source.indexOf("  function photoPersonFacets(items = [], limit = Number.MAX_SAFE_INTEGER) {");
  const end = source.indexOf("  function photoDateFacets(items = []) {");
  assert(start >= 0 && end > start, "photo person facet implementation markers must stay discoverable");
  const legacyFacet = `  function photoPersonFacets(items = [], limit = Number.MAX_SAFE_INTEGER) {
    const counts = new Map();
    for (const item of items) {
      const value = photoPersonFacetValue(item);
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" }))
      .slice(0, limit);
  }

`;
  const legacySource = `${source.slice(0, start)}${legacyFacet}${source.slice(end)}`;
  return `data:text/javascript;base64,${Buffer.from(legacySource).toString("base64")}`;
}

function createProductionShapeIndex() {
  const photoSets = Array.from({ length: 50000 }, (_, index) => {
    const month = String(index % 12 + 1).padStart(2, "0");
    const day = String(index % 28 + 1).padStart(2, "0");
    const person = index % 18000;
    return {
      id: `photo-${index}`,
      title: `[分类 ${index % 4}]2026.${month}.${day} VOL.${index + 1} ${index % 500 === 0 ? "特别作品" : "普通作品"} 人物 ${person}`,
      category: `分类 ${index % 4}`,
      subCategory: `文件夹 ${index % 20}`,
      personName: `人物 ${person}`,
      relativePath: `合集 ${index % 250}/文件夹 ${index % 20}/album-${index}.zip`,
      sourceRoot: "T:\\[套图]",
      rootLabel: "[套图]",
      size: index + 1,
      imageCount: index % 30,
      updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString()
    };
  });
  const mediaItems = Array.from({ length: 18000 }, (_, index) => ({
    id: `media-${index}`,
    mediaKind: ["movie", "tv", "western"][index % 3],
    title: `媒体 ${index}`,
    category: `类别 ${index % 30}`,
    personName: `演员 ${index % 3000}`,
    seriesName: `剧集 ${index % 800}`,
    rootLabel: "媒体",
    size: index + 1,
    updatedAt: "2026-07-01T00:00:00.000Z",
    playable: true
  }));
  return { scannedAt: "2026-08-11T00:00:00.000Z", photoSets, mediaItems };
}

function createService(factory, index) {
  return factory({
    clampInteger(value, fallback, min, max) {
      const parsed = Number.parseInt(String(value ?? ""), 10);
      return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
    },
    galleryMediaRootStatuses: () => [],
    getImageLibraryIndex: () => index,
    imageReaderCacheStatus: () => ({ root: "", exists: true, maxBytes: 0, currentBytes: 0, overBytes: 0, fileCount: 0, cleanupIntervalMs: 0 }),
    mangaService: {
      cacheDirs: () => [],
      publicSummary: (value) => value,
      rootStatus: () => ({ root: "", exists: false })
    },
    maxItemLimit: 12000,
    metadataService: {
      movieRowsMap: () => new Map(),
      publicMovie: (value) => value,
      publicTvSeries: (value) => value,
      movieRow: () => null,
      tvSeriesKey: (category, seriesName) => `${category}|${seriesName}`,
      tvSeriesRow: () => null,
      tvSeriesRowsMap: () => new Map()
    },
    photoCollectionRootValue: "__fanhao_photo_collection_root__",
    photoSetRootStatuses: () => [],
    photoSetService: { coverUrl: (id) => `/cover/${id}` }
  });
}

function measure(run) {
  const startedAt = performance.now();
  const value = run();
  return { elapsedMs: performance.now() - startedAt, value };
}

function request(params) {
  const value = new URL("http://localhost/api/image-library/items");
  for (const [key, item] of Object.entries(params)) value.searchParams.set(key, item);
  return value;
}

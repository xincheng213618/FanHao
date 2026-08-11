import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servicePath = path.join(root, "src", "modules", "content-index", "server", "image-library-service.js");
const serviceSource = fs.readFileSync(servicePath, "utf8").replaceAll("\r\n", "\n");
const { createImageLibraryService: createLegacyImageLibraryService } = await import(legacyServiceModuleUrl(serviceSource));
const { createImageLibraryService: createTestableImageLibraryService } = await import(testableServiceModuleUrl(serviceSource));
const index = createProductionShapeIndex();

assert(!serviceSource.includes("collections: photoCollectionGroups(items)"), "prepared photo catalog must not retain an unused collection list");
assert(serviceSource.includes("function preparedPhotoCollectionCategories(catalog)"), "collection categories must remain lazy");
assert(serviceSource.includes("const archiveDate = normalizedMode === \"photo\" ? photoArchiveDate(photoTitle) : \"\";"), "photo archive dates must be parsed once per list item");
assert(serviceSource.includes("archiveMonth: archiveDate.slice(0, 7)"), "photo archive month must derive from the parsed date");
assert(!serviceSource.includes("catalog.collections"), "no photo catalog consumer may read the removed collection list");
assert(!functionSource(serviceSource, "preparedPhotoCatalog", "preparedPhotoCollectionCategories").includes("photoCollectionCategoryGroups"), "album catalog construction must not build collection categories");
assert(functionSource(serviceSource, "preparedPhotoCollectionCategories", "preparedPhotoSortedItems").includes("photoCollectionCategoryGroups(catalog.items)"), "collection categories must build only when the collections view asks for them");

const androidApp = fs.readFileSync(path.join(root, "android-client", "www", "app.js"), "utf8");
const webGalleryPage = fs.readFileSync(path.join(root, "public", "modules", "content-index", "gallery-page.js"), "utf8");
assert(androidApp.includes('const IMAGE_LIBRARY_SUMMARY_CACHE_PATH = "/api/image-library/summary?cache=0";'), "Android must skip an unused image-reader cache summary");
assert(webGalleryPage.includes('const summaryEndpoint = isImageLibraryMode() ? "/api/image-library/summary" : "/api/image-library/summary?cache=0";'), "Web image-library mode must continue to request its cache summary");

verifyPhotoPersonFacetBoundaries(createTestableImageLibraryService);

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
  let legacySource = source;
  legacySource = replaceOnce(legacySource, "    let sourceIsSorted = false;\n", "", "remove cached-sort state");
  legacySource = replaceOnce(legacySource, `      const defaultPhotoFilters = photoFiltersAreDefault({ category, subCategory, person, date });
      const filteredPhotoSets = defaultPhotoFilters && !collection
        ? catalog.items
        : filterPhotoSetsForList(catalog.items, { category, subCategory, person, date, collection });
`, "      const filteredPhotoSets = filterPhotoSetsForList(catalog.items, { category, subCategory, person, date, collection });\n", "restore unconditional photo filtering");
  legacySource = replaceOnce(legacySource, `      source = photoView === "collections" && !collection
        ? defaultPhotoFilters
          ? preparedPhotoCollectionCategories(catalog)
          : photoCollectionCategoryGroups(filteredPhotoSets).map(publicPhotoCollectionCategoryListItem)
        : defaultPhotoFilters && !collection && !query
          ? preparedPhotoSortedItems(catalog, sort)
          : filteredPhotoSets;
      sourceIsSorted = photoView === "albums" && defaultPhotoFilters && !collection && !query;
`, `      source = photoView === "collections" && !collection
        ? photoFiltersAreDefault({ category, subCategory, person, date })
          ? catalog.collectionCategories
          : photoCollectionCategoryGroups(filteredPhotoSets).map(publicPhotoCollectionCategoryListItem)
        : filteredPhotoSets;
`, "restore uncached photo source selection");
  legacySource = replaceOnce(legacySource, "      : sourceIsSorted ? source : sortImageLibraryItems(filtered, sort);", "      : sortImageLibraryItems(filtered, sort);", "restore per-request photo sorting");
  legacySource = replaceOnce(legacySource, "  function photoAlbumSubject(value, item = {}, collectionTitle = \"\") {", "  function photoAlbumSubject(value, item = {}) {", "restore album subject signature");
  legacySource = replaceOnce(legacySource, `    const structuralLabels = [
      collectionTitle || item?.collectionTitle,
      item?.subCategory,
      collectionTitle || item?.collectionTitle ? "" : photoCollectionDisplayName(photoCollectionDir(item))
    ]`, `    const structuralLabels = [
      item?.collectionTitle,
      item?.subCategory,
      photoCollectionDisplayName(photoCollectionDir(item))
    ]`, "restore album subject structural labels");
  legacySource = replaceOnce(legacySource, "  function photoAlbumNumber(value) {", `  function photoArchiveMonth(value) {
    return photoArchiveDate(value).slice(0, 7);
  }

  function photoAlbumNumber(value) {`, "restore archive month parser");
  legacySource = replaceOnce(legacySource, `    const archiveDate = normalizedMode === "photo" ? photoArchiveDate(photoTitle) : "";
    const albumNumber = normalizedMode === "photo" ? photoAlbumNumber(photoTitle) : "";
    const albumSubject = normalizedMode === "photo" ? photoAlbumSubject(photoTitle, item, collectionTitle) : "";
`, "", "restore inline photo list parsing");
  legacySource = replaceOnce(legacySource, `      archiveDate,
      archiveMonth: archiveDate.slice(0, 7),
      albumNumber,
      albumSubject,
`, `      archiveDate: normalizedMode === "photo" ? photoArchiveDate(photoTitle) : "",
      archiveMonth: normalizedMode === "photo" ? photoArchiveMonth(photoTitle) : "",
      albumNumber: normalizedMode === "photo" ? photoAlbumNumber(photoTitle) : "",
      albumSubject: normalizedMode === "photo" ? photoAlbumSubject(photoTitle, { ...item, collectionTitle }) : "",
`, "restore inline photo response fields");
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
  legacySource = replaceSection(legacySource, "  function photoPersonFacets(items = [], limit = Number.MAX_SAFE_INTEGER) {", "  function photoDateFacets(items = []) {", legacyFacet, "restore full person facet sort");
  legacySource = replaceOnce(legacySource, `      index,
      items,
      categories: facetCounts(items, "category"),
      people: photoPersonFacets(items, 20),
      subCategories: new Map(),
      sortedItems: new Map()
`, `      index,
      items,
      collections: photoCollectionGroups(items).map(publicPhotoCollectionListItem),
      collectionCategories: photoCollectionCategoryGroups(items).map(publicPhotoCollectionCategoryListItem),
      categories: facetCounts(items, "category"),
      people: photoPersonFacets(items, 20),
      subCategories: new Map()
`, "restore eager catalog fields");
  legacySource = replaceOnce(legacySource, `    return list
      .map((item) => ({ item, updatedAt: new Date(item.updatedAt || 0).getTime() }))
      .sort((a, b) => {
        const timeDiff = b.updatedAt - a.updatedAt;
        return timeDiff || a.item.title.localeCompare(b.item.title, undefined, { numeric: true, sensitivity: "base" });
      })
      .map(({ item }) => item);
`, `    return list.sort((a, b) => {
      const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
    });
`, "restore per-comparison updated sorting");
  return `data:text/javascript;base64,${Buffer.from(legacySource).toString("base64")}`;
}

function testableServiceModuleUrl(source) {
  const testableSource = replaceOnce(source, "  return {\n    itemsPayload,", "  return {\n    __testPhotoPersonFacets: photoPersonFacets,\n    itemsPayload,", "expose photo person facets to the verifier only");
  return `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`;
}

function verifyPhotoPersonFacetBoundaries(factory) {
  const options = { numeric: true, sensitivity: "base" };
  for (const [left, right] of [["Person Z", "Person z"], ["Person z", "Person Ž"], ["Number z01", "Number z1"], ["Number z1", "Number z001"]]) {
    assert.equal(left.localeCompare(right, undefined, options), 0, `${left} and ${right} must exercise a collation-equal boundary`);
  }

  verifyPhotoPersonFacetBoundary(factory, {
    name: "case-accent-limit-12",
    limit: 12,
    prefix: Array.from({ length: 10 }, (_, index) => `Person ${String.fromCharCode(97 + index)}`),
    ties: ["Person Z", "Person z", "Person Ž"],
    suffix: "Person zz"
  });
  verifyPhotoPersonFacetBoundary(factory, {
    name: "numeric-limit-20",
    limit: 20,
    prefix: Array.from({ length: 18 }, (_, index) => `Number ${String.fromCharCode(97 + index)}`),
    ties: ["Number z01", "Number z1", "Number z001"],
    suffix: "Number zz"
  });
}

function verifyPhotoPersonFacetBoundary(factory, { name, limit, prefix, ties, suffix }) {
  const values = [...prefix, ...ties, suffix];
  const boundaryIndex = {
    scannedAt: "2026-08-11T00:00:00.000Z",
    photoSets: values.map((personName, index) => ({
      id: `${name}-${index}`,
      title: `2026.07.01 VOL.${index + 1} 边界作品 ${index}`,
      category: "边界",
      subCategory: "",
      personName,
      relativePath: `边界/album-${index}.zip`,
      sourceRoot: "T:\\[套图]",
      rootLabel: "[套图]",
      size: index + 1,
      updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString()
    })),
    mediaItems: []
  };
  const testableService = createService(factory, boundaryIndex);
  const expected = legacyPhotoPersonFacets(boundaryIndex.photoSets, limit);
  assert.deepStrictEqual(testableService.__testPhotoPersonFacets(boundaryIndex.photoSets, 0), [], `${name} must preserve limit=0`);
  assert.deepStrictEqual(testableService.__testPhotoPersonFacets(boundaryIndex.photoSets, limit), expected, `${name} must preserve the legacy Top-K order at the cutoff`);
  assert.deepStrictEqual(testableService.__testPhotoPersonFacets(boundaryIndex.photoSets, values.length), legacyPhotoPersonFacets(boundaryIndex.photoSets, values.length), `${name} must preserve the exact all-items boundary`);
  assert.deepStrictEqual(expected.filter((item) => ties.includes(item.value)).map((item) => item.value), ties.slice(0, 2), `${name} must retain the first two Map entries from the collation-equal cutoff group`);

  const optimizedService = createService(createImageLibraryService, boundaryIndex);
  const legacyService = createService(createLegacyImageLibraryService, boundaryIndex);
  const optimizedResponse = limit === 12
    ? optimizedService.summaryPayload({ includeCache: false })
    : optimizedService.itemsPayload(request({ mode: "photo", photoView: "albums", limit: "48" }));
  const legacyResponse = limit === 12
    ? legacyService.summaryPayload({ includeCache: false })
    : legacyService.itemsPayload(request({ mode: "photo", photoView: "albums", limit: "48" }));
  assert.deepStrictEqual(optimizedResponse, legacyResponse, `${name} service response must match the restored legacy implementation`);
  assert.equal(JSON.stringify(optimizedResponse), JSON.stringify(legacyResponse), `${name} serialized response must match the restored legacy implementation`);
}

function legacyPhotoPersonFacets(items, limit) {
  const counts = new Map();
  for (const item of items) {
    const value = String(item.personName || "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" }))
    .slice(0, limit);
}

function functionSource(source, startName, endName) {
  const start = source.indexOf(`  function ${startName}`);
  const end = source.indexOf(`  function ${endName}`, start);
  assert(start >= 0 && end > start, `${startName} function boundaries must stay discoverable`);
  return source.slice(start, end);
}

function replaceOnce(source, expected, replacement, description) {
  const start = source.indexOf(expected);
  assert(start >= 0, `${description}: expected current implementation marker is missing`);
  assert.equal(source.indexOf(expected, start + expected.length), -1, `${description}: current implementation marker must be unique`);
  return `${source.slice(0, start)}${replacement}${source.slice(start + expected.length)}`;
}

function replaceSection(source, startMarker, endMarker, replacement, description) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `${description}: current implementation markers must stay discoverable`);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
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

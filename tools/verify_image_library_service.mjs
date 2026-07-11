import assert from "node:assert/strict";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

const photoSets = [
  photo("a1", "分类 A", "文件夹一", "人物甲", "合集一/001.zip", 100, "2026-07-01T00:00:00.000Z"),
  photo("a2", "分类 A", "文件夹一", "人物甲", "合集一/002.zip", 200, "2026-07-02T00:00:00.000Z"),
  photo("b1", "分类 B", "文件夹二", "人物乙", "合集一/003.zip", 300, "2026-07-03T00:00:00.000Z"),
  photo("a3", "分类 A", "文件夹二", "人物丙", "合集二/001.zip", 400, "2026-07-04T00:00:00.000Z")
];
photoSets[1].title = "就是阿朱啊 – NO.108 阳台";
let coverUrlCalls = 0;
const imageIndex = { scannedAt: "2026-07-11T00:00:00.000Z", roots: [], mediaRoots: [], photoSets, mediaItems: [] };

const service = createImageLibraryService({
  clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
  },
  galleryMediaRootStatuses: () => [],
  getImageLibraryIndex: () => imageIndex,
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
    tvSeriesKey: () => "",
    tvSeriesRow: () => null,
    tvSeriesRowsMap: () => new Map()
  },
  photoCollectionRootValue: "__fanhao_photo_collection_root__",
  photoSetRootStatuses: () => [],
  photoSetService: {
    coverUrl: (id) => {
      coverUrlCalls += 1;
      return `/cover/${id}`;
    }
  }
});

const summary = service.summaryPayload();
assert.equal(summary.totals.photoSets, 4);
assert.equal("photoSets" in summary, false, "summary payload must not include the full photo index");

const collectionList = service.itemsPayload(url({ mode: "photo", photoView: "collections", sort: "count", limit: "20" }));
assert.equal(collectionList.total, 2);
assert.equal(collectionList.items[0].title, "合集一");
assert.equal(collectionList.items[0].albumCount, 3);

const filtered = service.itemsPayload(url({
  mode: "photo",
  photoView: "albums",
  category: "分类 A",
  subCategory: "文件夹一",
  limit: "20"
}));
assert.equal(filtered.total, 2);
assert.deepEqual(filtered.items.map((item) => item.id).sort(), ["a1", "a2"]);
assert.deepEqual(filtered.facets.subCategories, [
  { value: "文件夹一", count: 2 },
  { value: "文件夹二", count: 1 }
]);

const collection = service.itemsPayload(url({
  mode: "photo",
  photoView: "albums",
  collection: "T:\\|合集一",
  category: "分类 A",
  limit: "20"
}));
assert.equal(collection.total, 2, "list filters should still apply inside a collection");
assert.equal(collection.collectionSummary.count, 3, "collection summary should describe the full collection");

const multiTermSearch = service.itemsPayload(url({
  mode: "photo",
  photoView: "albums",
  q: "就是 阿朱",
  limit: "20"
}));
assert.equal(multiTermSearch.total, 1, "space-separated terms should match across a compact title");
assert.equal(multiTermSearch.items[0].id, "a2");
assert.equal(multiTermSearch.sort, "relevance");
assert.deepEqual(multiTermSearch.searchTerms, ["就是", "阿朱"]);
assert(multiTermSearch.items[0].matchFields.includes("title"));

const punctuationSearch = service.itemsPayload(url({
  mode: "photo",
  photoView: "albums",
  q: "NO.108",
  limit: "20"
}));
assert.deepEqual(punctuationSearch.items.map((item) => item.id), ["a2"], "punctuation should normalize without broadening into unrelated terms");
assert.deepEqual(punctuationSearch.searchTerms, ["no108"]);

service.itemsPayload(url({ mode: "photo", photoView: "albums", q: "a1", limit: "20" }));
assert.equal(coverUrlCalls, photoSets.length, "prepared photo items should be reused across list and search requests");

console.log("image-library-service: ok");

function photo(id, category, subCategory, personName, relativePath, size, updatedAt) {
  return {
    id,
    title: id,
    category,
    subCategory,
    personName,
    relativePath,
    sourceRoot: "T:\\",
    rootLabel: "T:\\",
    size,
    updatedAt,
    coverUrl: ""
  };
}

function url(params) {
  const value = new URL("http://localhost/api/image-library/items");
  for (const [key, item] of Object.entries(params)) value.searchParams.set(key, item);
  return value;
}

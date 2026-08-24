import assert from "node:assert/strict";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

const photoSets = [
  photo("a1", "分类 A", "文件夹一", "人物甲", "合集一/001.zip", 100, "2026-07-01T00:00:00.000Z"),
  photo("a2", "分类 A", "文件夹一", "人物甲", "合集一/002.zip", 200, "2026-07-02T00:00:00.000Z"),
  photo("b1", "分类 B", "文件夹二", "人物乙", "合集一/003.zip", 300, "2026-07-03T00:00:00.000Z"),
  photo("a3", "分类 A", "文件夹二", "文件夹二", "合集二/001.zip", 400, "2026-07-04T00:00:00.000Z"),
  photo("y1", "[YITUYU艺图语]", "", "柳柳杨柳柳", "[YITUYU艺图语]/001.rar", 500, "2023-04-18T00:00:00.000Z"),
  photo("y2", "[YITUYU艺图语]", "", "只有作品", "[YITUYU艺图语]/002.rar", 600, "2023-04-19T00:00:00.000Z")
];
photoSets[0].title = "[分类 A]2026.07.01 VOL.100 人物甲";
photoSets[1].title = "[分类 A]2026.06.02 就是阿朱啊 – NO.108 阳台";
photoSets[2].title = "[分类 B]2026.05.03 N0.102 童颜少女";
photoSets[3].title = "文件夹二 Sira (시라) - Collection VOL.12 [95P+5V／437MB]";
photoSets[4].title = "[YITUYU艺图语]2023.04.18 午后玫瑰 柳柳杨柳柳_[22+1P／147MB]";
photoSets[5].title = "[YITUYU艺图语]2023.04.19 只有作品_[22P／100MB]";
let coverUrlCalls = 0;
let cacheStatusCalls = 0;
let mangaCount = 0;
let photoRootStatus = "ready";
let imageIndex = { scannedAt: "2026-07-11T00:00:00.000Z", photoSets, mediaItems: [] };
let tvMetadata = new Map();

const service = createImageLibraryService({
  clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
  },
  galleryMediaRootStatuses: () => [],
  getImageLibraryIndex: () => imageIndex,
  imageReaderCacheStatus: () => {
    cacheStatusCalls += 1;
    return { root: "", exists: true, maxBytes: 0, currentBytes: 0, overBytes: 0, fileCount: 0, cleanupIntervalMs: 0 };
  },
  mangaService: {
    cacheDirs: () => Array.from({ length: mangaCount }, (_, index) => `manga-${index}`),
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
    tvSeriesRow: (key) => tvMetadata.get(key) || null,
    tvSeriesRowsMap: () => tvMetadata
  },
  photoCollectionRootValue: "__fanhao_photo_collection_root__",
  photoSetRootStatuses: () => [{ root: "T:\\photos", status: photoRootStatus }],
  photoSetService: {
    coverUrl: (id) => {
      coverUrlCalls += 1;
      return `/cover/${id}`;
    }
  }
});

const summary = service.summaryPayload();
assert.equal(summary.totals.photoSets, 6);
assert.equal("photoSets" in summary, false, "summary payload must not include the full photo index");
const mediaSummary = service.summaryPayload({ includeCache: false });
assert.equal(mediaSummary.cache, null, "media summary should skip the image reader cache scan");
assert.equal(cacheStatusCalls, 1, "cache-free summary should not collect image reader cache entries");
mangaCount = 2;
photoRootStatus = "changed";
photoSets.push(photo("cached", "缓存分类", "", "缓存人物", "缓存/001.zip", 700, "2026-07-05T00:00:00.000Z"));
const cachedSummary = service.summaryPayload();
assert.equal(cachedSummary.totals.photoSets, 6, "the same index identity should reuse static summary totals");
assert.equal(cachedSummary.totals.manga, 2, "manga totals should remain dynamic");
assert.equal(cachedSummary.photoRoots[0].status, "changed", "root statuses should remain dynamic");
assert.equal(cacheStatusCalls, 2, "cache status should still refresh for a cached summary");
imageIndex = { ...imageIndex, scannedAt: "2026-07-12T00:00:00.000Z", photoSets: [...photoSets] };
const refreshedSummary = service.summaryPayload({ includeCache: false });
assert.equal(refreshedSummary.totals.photoSets, 7, "a new index identity should rebuild static summary totals");
assert.equal(refreshedSummary.scannedAt, "2026-07-12T00:00:00.000Z");
assert.equal(cacheStatusCalls, 2, "cache-free refreshed summaries should still skip cache status work");
photoSets.pop();
imageIndex = { ...imageIndex, photoSets };

const collectionList = service.itemsPayload(url({ mode: "photo", photoView: "collections", sort: "count", limit: "20" }));
assert.equal(collectionList.total, 3);
assert.equal(collectionList.items[0].title, "[套图1] / 分类 A");
assert.equal(collectionList.items[0].albumCount, 3);
assert.equal(collectionList.items[0].collectionCount, 2);
assert.deepEqual(collectionList.items[0].collections.map((item) => item.title), ["合集一", "合集二"]);

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
  collection: "T:\\[套图1]|合集一",
  category: "分类 A",
  limit: "20"
}));
assert.equal(collection.total, 2, "list filters should still apply inside a collection");
assert.equal(collection.collectionSummary.count, 3, "collection summary should describe the full collection");
assert.equal(collection.collectionSummary.largeCategoryTitle, "[套图1] / 分类 A");
assert.deepEqual(collection.facets.people, [
  { value: "人物甲", count: 2 },
  { value: "人物乙", count: 1 }
]);
assert.deepEqual(collection.facets.dates.map((item) => item.value), ["2026-07", "2026-06", "2026-05"]);

const datedCollection = service.itemsPayload(url({
  mode: "photo",
  photoView: "albums",
  collection: "T:\\[套图1]|合集一",
  date: "2026-06",
  limit: "20"
}));
assert.deepEqual(datedCollection.items.map((item) => item.id), ["a2"]);
assert.equal(datedCollection.items[0].archiveDate, "2026-06-02");
assert.equal(datedCollection.items[0].albumNumber, "NO.108");
assert.equal(datedCollection.items[0].albumSubject, "阳台");

const typoNumberItem = service.itemsPayload(url({ mode: "photo", photoView: "albums", q: "童颜少女", limit: "20" })).items[0];
assert.equal(typoNumberItem.albumNumber, "NO.102", "N0 should normalize to the NO. display prefix");
assert.equal(typoNumberItem.albumSubject, "童颜少女");

const structuralPersonCollection = service.itemsPayload(url({
  mode: "photo",
  photoView: "albums",
  collection: "T:\\[套图1]|合集二",
  limit: "20"
}));
assert.deepEqual(structuralPersonCollection.facets.people, [], "a folder label repeated as personName should not become a person facet");
assert.equal(structuralPersonCollection.items[0].albumNumber, "VOL.12");
assert.equal(structuralPersonCollection.items[0].albumSubject, "Sira (시라)", "a subject before VOL should be preserved without its collection label");

const namedWorkCollection = service.itemsPayload(url({
  mode: "photo",
  photoView: "albums",
  collection: "T:\\[套图1]|[YITUYU艺图语]",
  limit: "20"
}));
const namedWork = namedWorkCollection.items.find((item) => item.id === "y1");
assert.equal(namedWork.personName, "柳柳杨柳柳");
assert.equal(namedWork.albumSubject, "午后玫瑰", "a named YITUYU work must exclude its trailing person from the work title");
assert.deepEqual(namedWorkCollection.facets.people, [
  { value: "柳柳杨柳柳", count: 1 }
], "a middle section that cannot be split from the work title must not become a person facet");

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

imageIndex = { ...imageIndex, mediaItems: [
  media("movie-1", "movie", "电影", "电影一"),
  media("tv-1", "tv", "华语剧", "剧集一", "第 1 集"),
  media("tv-2", "tv", "华语剧", "剧集一", "第 2 集"),
  media("anime-1", "anime", "动漫", "动画一", "第 1 话"),
  media("anime-2", "anime", "动漫", "动画一", "第 2 话"),
  media("western-1", "western", "欧美", "人物甲", "视频一"),
  media("western-2", "western", "欧美", "人物甲", "视频二")
] };

const mediaWorks = service.itemsPayload(url({ mode: "media", limit: "20" }));
assert.equal(mediaWorks.total, 3, "media list should return one movie, one grouped TV work, and one grouped anime work");
assert.equal(mediaWorks.items.find((item) => item.mediaKind === "tv")?.type, "tvSeriesWork");
assert.equal(mediaWorks.items.find((item) => item.mediaKind === "tv")?.episodeCount, 2);
assert.equal(mediaWorks.items.find((item) => item.mediaKind === "anime")?.episodeCount, 2);
const movieWorks = service.itemsPayload(url({ mode: "media", kind: "movie", limit: "20" }));
assert.deepEqual(movieWorks.items.map((item) => item.id), ["movie-1"], "media kind should be independent from the library category filter");

const tvEpisodes = service.itemsPayload(url({ mode: "tv", person: "剧集一", limit: "20" }));
assert.deepEqual(tvEpisodes.items.map((item) => item.id).sort(), ["tv-1", "tv-2"], "selecting a TV work should page its episodes");
const animeWorks = service.itemsPayload(url({ mode: "media", kind: "anime", limit: "20" }));
assert.equal(animeWorks.total, 1, "anime media kind should group episodes into one work");
assert.equal(animeWorks.items[0].mediaKind, "anime");
const animeEpisodes = service.itemsPayload(url({ mode: "media", kind: "anime", seriesKey: animeWorks.items[0].seriesKey, limit: "20" }));
assert.deepEqual(animeEpisodes.items.map((item) => item.id).sort(), ["anime-1", "anime-2"], "selecting anime should page its video episodes");

const westernPeople = service.itemsPayload(url({ mode: "western", limit: "20" }));
assert.equal(westernPeople.total, 1, "western list should page grouped people instead of every video");
assert.equal(westernPeople.items[0].videoCount, 2);

tvMetadata = new Map([
  ["华语剧|示例剧 S01E01", tvMetadataRecord("100001", "示例剧 第一季")],
  ["华语剧|示例剧 S01E02", tvMetadataRecord("100001", "示例剧 第一季")],
  ["华语剧|示例剧 S02E01", tvMetadataRecord("100001", "示例剧 第一季")],
  ["华语剧|同名剧 E01", tvMetadataRecord("200001", "同名剧 A")],
  ["华语剧|同名剧 E02", tvMetadataRecord("200002", "同名剧 B")]
]);
imageIndex = {
  ...imageIndex,
  mediaItems: [
    media("cross-a", "tv", "华语剧", "示例剧 S01E01", "示例剧 S01E01 1080p"),
    media("cross-b", "tv", "华语剧", "示例剧 S01E02", "示例剧 S01E02 1080p"),
    media("different-season", "tv", "华语剧", "示例剧 S02E01", "示例剧 S02E01 1080p"),
    media("same-name-a", "tv", "华语剧", "同名剧 E01", "同名剧 E01"),
    media("same-name-b", "tv", "华语剧", "同名剧 E02", "同名剧 E02"),
    media("unconfirmed-a", "tv", "华语剧", "未确认剧 E01", "未确认剧 E01"),
    media("unconfirmed-b", "tv", "华语剧", "未确认剧 E02", "未确认剧 E02")
  ]
};

const conservativeTvWorks = service.itemsPayload(url({ mode: "tv", limit: "20" }));
const mergedCrossDirectoryWork = conservativeTvWorks.items.find((item) => item.title === "示例剧 第一季" && item.episodeCount === 2);
assert(mergedCrossDirectoryWork, "same trusted metadata plus the same normalized local season must merge cross-directory episodes");
assert.equal(conservativeTvWorks.items.filter((item) => item.title === "示例剧 第一季").length, 2, "a different local season must remain separate even when an old metadata record reuses its identity");
assert.equal(conservativeTvWorks.items.filter((item) => item.title === "同名剧 A" || item.title === "同名剧 B").length, 2, "same local names with different trusted metadata identities must remain separate");
assert.equal(conservativeTvWorks.items.filter((item) => item.seriesName.startsWith("未确认剧")).length, 2, "unconfirmed metadata must not enable a cross-directory merge");

const mergedEpisodeDetail = service.itemsPayload(url({ mode: "tv", seriesKey: mergedCrossDirectoryWork.seriesKey, limit: "20" }));
assert.deepEqual(mergedEpisodeDetail.items.map((item) => item.id).sort(), ["cross-a", "cross-b"], "a merged TV work must still open every original episode file");

console.log("image-library-service: ok");

function photo(id, category, subCategory, personName, relativePath, size, updatedAt) {
  return {
    id,
    title: id,
    category,
    subCategory,
    personName,
    relativePath,
    sourceRoot: "T:\\[套图1]",
    rootLabel: "[套图1]",
    size,
    updatedAt,
    coverUrl: ""
  };
}

function media(id, mediaKind, category, personOrSeries, title = personOrSeries) {
  return {
    id,
    mediaKind,
    category,
    title,
    personName: ["tv", "anime"].includes(mediaKind) ? "" : personOrSeries,
    seriesName: ["tv", "anime"].includes(mediaKind) ? personOrSeries : "",
    size: 100,
    updatedAt: "2026-07-12T00:00:00.000Z",
    playable: true
  };
}

function tvMetadataRecord(doubanId, title) {
  return { doubanId, title, category: "华语剧", episodeCount: 0 };
}

function url(params) {
  const value = new URL("http://localhost/api/image-library/items");
  for (const [key, item] of Object.entries(params)) value.searchParams.set(key, item);
  return value;
}

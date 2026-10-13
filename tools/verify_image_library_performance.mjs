import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createGalleryMetadataService } from "../src/modules/media/server/gallery-metadata-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servicePath = path.join(root, "src", "modules", "content-index", "server", "image-library-service.js");
const serviceSource = fs.readFileSync(servicePath, "utf8").replaceAll("\r\n", "\n")
  .replace('"./image-query-cache.js"', JSON.stringify(new URL("../src/modules/content-index/server/image-query-cache.js", import.meta.url).href));
const { createImageLibraryService: createLegacyImageLibraryService } = await import(legacyServiceModuleUrl(serviceSource));
const { createImageLibraryService: createTestableImageLibraryService } = await import(testableServiceModuleUrl(serviceSource));
const index = createProductionShapeIndex();

assert(!serviceSource.includes("collections: photoCollectionGroups(items)"), "prepared photo catalog must not retain an unused collection list");
assert(serviceSource.includes("function preparedPhotoCollectionCategories(catalog)"), "collection categories must remain lazy");
assert(serviceSource.includes("const archiveDate = normalizedMode === \"photo\" ? photoArchiveDate(photoTitle) : \"\";"), "photo archive dates must be parsed once per list item");
assert(serviceSource.includes("archiveMonth: archiveDate.slice(0, 7)"), "photo archive month must derive from the parsed date");
assert(serviceSource.includes("!deferPhotoSubject || !albumNumber") && serviceSource.includes("albumSubject: photoAlbumSubject(item.title, item, item.collectionTitle)"), "numbered album subjects must hydrate only the returned page while unnumbered facets remain eager");
assert(!serviceSource.includes("catalog.collections"), "no photo catalog consumer may read the removed collection list");
assert(!functionSource(serviceSource, "preparedPhotoCatalog", "preparedPhotoCollectionCategories").includes("photoCollectionCategoryGroups"), "album catalog construction must not build collection categories");
assert(functionSource(serviceSource, "preparedPhotoCollectionCategories", "preparedPhotoSortedItems").includes("photoCollectionCategoryGroups(catalog.items)"), "collection categories must build only when the collections view asks for them");

const androidApp = fs.readFileSync(path.join(root, "android-client", "www", "app.js"), "utf8");
const webGalleryPage = fs.readFileSync(path.join(root, "public", "modules", "content-index", "gallery-page.js"), "utf8");
assert(androidApp.includes('const IMAGE_LIBRARY_SUMMARY_CACHE_PATH = "/api/image-library/summary?cache=0";'), "Android must skip an unused image-reader cache summary");
assert(webGalleryPage.includes('const summaryEndpoint = isImageLibraryMode() ? "/api/image-library/summary" : "/api/image-library/summary?cache=0";'), "Web image-library mode must continue to request its cache summary");

verifyPhotoPersonFacetBoundaries(createTestableImageLibraryService);
verifyPreparedPhotoSortCache(createTestableImageLibraryService);
await verifyPreparedPhotoFacetCache(createTestableImageLibraryService);
await verifyImageSortBoundaries(createTestableImageLibraryService);
verifyImageCollationWork();
await verifyImageSearchWork();
await verifyYearSortWork();
await verifyTvNormalizationWork();
await verifyMetadataConnectionRecovery();

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
  const optimizedResponse = legacyListResponse(optimizedResponses.find(([candidate]) => candidate === name)[1]);
  assert.deepStrictEqual(legacyResponse, optimizedResponse, `${name} must remain structurally equivalent to the legacy full facet sort`);
  assert.equal(JSON.stringify(legacyResponse), JSON.stringify(optimizedResponse), `${name} must preserve serialized response bytes`);
}

console.log(
  `image-library-performance: 50k-photo/18k-media diagnostic sample, summary cold=${summaryCold.elapsedMs.toFixed(1)}ms warm=${summaryWarm.elapsedMs.toFixed(1)}ms, albums cold=${albumsCold.elapsedMs.toFixed(1)}ms warm=${albumsWarm.elapsedMs.toFixed(1)}ms (non-hard guidance: summary <150/<5ms; albums <500/<50ms; response equivalence is the hard gate)`
);
console.log("image-library-performance: ok");

function legacyServiceModuleUrl(source) {
  let legacySource = previousSearchSource(source);
  legacySource = replaceOnce(legacySource, '    const sourceStampBefore = listSourceStamp(index, mode);\n    let mangaSourceRevision = "";\n', "", "restore list reads before revision probes");
  legacySource = replaceOnce(legacySource, '      nextOffset: offset + items.length,\n      listRevision: publicListRevision(sourceStampBefore, listSourceStamp(index, mode), mode, mangaSourceRevision),\n', "", "restore response before additive pagination fields");
  legacySource = replaceOnce(legacySource, `      const mangaSourceHash = createHash("sha256");
      source = mangaService.cacheDirs().map((cacheDir) => {
        const item = publicImageLibraryListItem(mangaService.publicSummary(cacheDir), "manga");
        mangaSourceHash.update(JSON.stringify(item)).update("\\0");
        return item;
      });
      mangaSourceRevision = mangaSourceHash.digest("hex");`, '      source = mangaService.cacheDirs().map((cacheDir) => publicImageLibraryListItem(mangaService.publicSummary(cacheDir), "manga"));', "restore manga source before incremental revision hashing");
  legacySource = replaceOnce(legacySource, 'return imageNameCollator.compare(left, right);', 'return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });', "restore per-comparison locale construction");
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
    // Unnumbered subjects participate in the person facet guard. Numbered
    // subjects are display-only and can be derived for the returned page.
    const albumSubject = normalizedMode === "photo" && (!deferPhotoSubject || !albumNumber) ? photoAlbumSubject(photoTitle, item, collectionTitle) : "";
`, "", "restore inline photo list parsing");
  legacySource = replaceOnce(legacySource, `      if (item.type === "photo" && item.albumNumber) {
        item = { ...item, albumSubject: photoAlbumSubject(item.title, item, item.collectionTitle) };
      }
`, "", "restore eager album subject response projection");
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
        return timeDiff || compareImageNames(a.item.title, b.item.title);
      })
      .map(({ item }) => item);
`, `    return list.sort((a, b) => {
      const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
    });
`, "restore per-comparison updated sorting");
  return `data:text/javascript;base64,${Buffer.from(legacySource).toString("base64")}`;
}

function legacyListResponse(response) {
  const { listRevision, nextOffset, ...legacy } = response;
  return legacy;
}

function testableServiceModuleUrl(source) {
  const testableSource = replaceOnce(source, "  return {\n    itemsPayload,", `  return {
    __testPhotoCatalogState: () => ({ index: cachedPhotoCatalog?.index || null, sortedKeys: [...(cachedPhotoCatalog?.sortedItems?.keys() || [])], facetKeys: [...(cachedPhotoCatalog?.subCategories?.keys() || [])] }),
    __testPhotoPersonFacets: photoPersonFacets,
    __testSortImageItems: sortImageLibraryItems,
    itemsPayload,`, "expose photo catalog state to the verifier only");
  return `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`;
}

function verifyImageSortBoundaries(factory) {
  const legacySource = Buffer.from(legacyServiceModuleUrl(serviceSource).split(",")[1], "base64").toString("utf8");
  return import(testableServiceModuleUrl(legacySource)).then(({ createImageLibraryService: legacyFactory }) => {
    const current = createService(factory, { photoSets: [], mediaItems: [] });
    const previous = createService(legacyFactory, { photoSets: [], mediaItems: [] });
    const titles = ["中文 10", "中文 2", "作品 02", "作品 2", "Title 10", "Title 2", "TITLE 02", "éclair", "e\u0301clair", "Eclair", "Ångström", "ångström", "ＡＢＣ", "ABC", "", "😀 2", "😀 10", "[作品]", "作品！"];
    for (const sort of ["title", "updated", "count", "size", "rating", "year"]) {
      const items = titles.map((title, index) => ({ id: `sort-${index}`, title, updatedAt: "2026-10-05", size: 1, albumCount: 1, rating: 8, year: "2026" }));
      const actual = current.__testSortImageItems(items, sort);
      const expected = previous.__testSortImageItems(items, sort);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${sort} preserves default-locale CJK/numeric/case/accent/width/empty/punctuation ordering and stable ties`);
      for (const [left, right] of [["作品 02", "作品 2"], ["Title 2", "TITLE 02"], ["éclair", "e\u0301clair"], ["Ångström", "ångström"]]) {
        assert.equal(left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }), 0);
        assert.ok(actual.findIndex(item => item.title === left) < actual.findIndex(item => item.title === right), `${sort} retains insertion order for collation-equivalent values`);
      }
    }
  });
}

async function verifyYearSortWork() {
  const currentBlock = serviceSource.match(/    if \(sort === "year"\) \{[\s\S]*?\n    \}/)?.[0];
  const previousBlock = String.raw`    if (sort === "year") {
      return list.sort((a, b) => {
        const aYear = Number.parseInt(String(a?.year || a?.movieMetadata?.year || a?.tvSeries?.year || "").match(/\d{4}/)?.[0] || "", 10) || 0;
        const bYear = Number.parseInt(String(b?.year || b?.movieMetadata?.year || b?.tvSeries?.year || "").match(/\d{4}/)?.[0] || "", 10) || 0;
        return bYear - aYear || compareImageNames(a.title, b.title);
      });
    }`;
  assert.ok(currentBlock && currentBlock !== previousBlock, "restore the complete former year comparator");
  const privateSource = serviceSource.replace("const listRealm = randomUUID();", 'const listRealm = "private-year-sort-fixture";');
  const previousSource = privateSource.replace(currentBlock, previousBlock);
  assert.equal(previousSource.replace(previousBlock, currentBlock), privateSource, "the old oracle changes only the year branch");
  const load = async value => (await import(testableServiceModuleUrl(value))).createImageLibraryService;
  const previousFactory = await load(previousSource), currentFactory = await load(privateSource);
  const measuredFactory = process.argv.includes("--legacy-year-sort") ? previousFactory : currentFactory;
  const yearValues = ["2026", "(1999)", "年份2020年", "invalid", "0000", "", 0, null, "12345", "xx9999x", "前1900", "2026-2025"];
  let privateIndex = { scannedAt: "synthetic-year-sort", photoSets: [], mediaItems: Array.from({ length: 20000 }, (_, index) => {
    const value = index * 7919 % 20000;
    return { id: `year-${value}`, mediaKind: "movie", title: `电影 ${value}`, year: yearValues[value % yearValues.length],
      category: `分类 ${value % 13}`, rootLabel: "synthetic", size: 1, updatedAt: "2026-10-04", playable: true };
  }) };
  const metadata = new Map();
  const create = factory => createService(options => factory({ ...options,
    metadataService: { ...options.metadataService, movieRowsMap: () => metadata }
  }), () => privateIndex);
  const previous = create(previousFactory), current = create(measuredFactory);
  let oracles = 0;
  function compare(params) {
    const url = request(params), before = previous.itemsPayload(url), after = current.itemsPayload(url);
    assert.deepEqual(after, before, "year sorting preserves the complete response, including pagination and revision");
    assert.equal(JSON.stringify(after), JSON.stringify(before));
    oracles++;
    return after;
  }
  const input = structuredClone(privateIndex);
  for (const params of [
    { mode: "movie", sort: "year", limit: "48" }, { mode: "movie", sort: "year", offset: "480" },
    { mode: "movie", sort: "year", category: "分类 3" }, { mode: "movie", sort: "year", q: "电影 1" },
    { mode: "media", sort: "year" }, { mode: "movie", sort: "updated" }, { mode: "movie", sort: "title" }
  ]) compare(params);
  assert.deepEqual(privateIndex, input, "sorting does not modify the source index");

  const match = String.prototype.match;
  function measureYear(owner, sort = "year") {
    let parses = 0;
    String.prototype.match = function(pattern) {
      if (pattern instanceof RegExp && pattern.source === "\\d{4}" && pattern.flags === "") parses++;
      return match.call(this, pattern);
    };
    const start = performance.now();
    try { return { payload: owner.itemsPayload(request({ mode: "movie", sort, limit: "48" })), parses, elapsedMs: performance.now() - start }; }
    finally { String.prototype.match = match; }
  }
  const before = measureYear(previous), after = measureYear(current);
  assert.deepEqual(after.payload, before.payload, "the parse probe preserves the complete response");
  assert.equal(after.parses, 20000, "year sorting must parse each compared record at most once");
  assert.ok(before.parses > 20000 * 10, "the actual old comparator exercises repeated year parsing");
  assert.equal(measureYear(current, "title").parses, 0, "other sort modes do not build a year cache");

  const titles = ["作品 02", "作品 2", "TITLE 2", "Title 02", "éclair", "e\u0301clair", "", "中文"];
  privateIndex = { ...privateIndex, mediaItems: yearValues.flatMap((year, index) => titles.map((title, position) => ({
    id: `boundary-${index}-${position}`, mediaKind: "movie", title, year, size: position, category: "boundary", rootLabel: "synthetic", updatedAt: "" }))) };
  for (const mode of ["movie", "media"]) for (const offset of ["0", "3", "999"]) compare({ mode, sort: "year", offset, limit: "7" });
  metadata.set("boundary-5-0", { title: "元数据标题", year: "1912-1913", rating: 8, genres: [] });
  compare({ mode: "movie", sort: "year", limit: "48" });
  metadata.get("boundary-5-0").year = "2099";
  compare({ mode: "movie", sort: "year", limit: "48" });
  privateIndex.mediaItems[1].year = "2100";
  compare({ mode: "movie", sort: "year", limit: "48" });
  privateIndex = { ...privateIndex, mediaItems: [] };
  compare({ mode: "movie", sort: "year" });
  privateIndex = { ...privateIndex, mediaItems: [{ id: "singleton", mediaKind: "movie", title: "单项", year: "invalid" }] };
  compare({ mode: "movie", sort: "year" });
  assert.equal(measureYear(current).parses, 0, "a singleton still needs no comparator or year parsing");

  for (const values of [
    [{ title: "A", year: "", movieMetadata: { year: "1990" } }, { title: "B", tvSeries: { year: "2001" } }],
    [{ title: "A", year: 0, movieMetadata: { year: "2026" } }, { title: "B", year: "0000", tvSeries: { year: "9999" } }]
  ]) {
    const expected = previous.__testSortImageItems(values, "year"), result = current.__testSortImageItems(values, "year");
    assert.deepEqual(result, expected); assert.equal(JSON.stringify(result), JSON.stringify(expected)); oracles++;
  }
  const invalid = [{ title: "A", year: { toString() { throw new Error("first year conversion"); } } }, { title: "B", year: "2026" }];
  for (const owner of [previous, current]) assert.throws(() => owner.__testSortImageItems(invalid, "year"), /first year conversion/);
  const bothInvalid = ["left", "right"].map(title => ({ title, year: { toString() { throw new Error(title + " year conversion"); } } }));
  const failure = owner => { try { owner.__testSortImageItems(bothInvalid, "year"); } catch (error) { return error.message; } };
  assert.equal(failure(current), failure(previous), "year conversion keeps the former comparator operand order");
  console.log(`image-year-sort: ${oracles} complete response/value oracles; 20k records year parses ${before.parses}->${after.parses}; ${before.elapsedMs.toFixed(1)}/${after.elapsedMs.toFixed(1)}ms diagnostic`);
}

async function verifyTvNormalizationWork() {
  // Restore complete pre-change functions, retaining the earlier query cache,
  // public-TV memo and year-sort changes. Only the private opaque realm is fixed.
  const previousHelpers = `  function trustedTvMetadataIdentity(tvSeries) {
    const doubanId = String(tvSeries?.doubanId || "").trim();
    const title = String(tvSeries?.title || "").trim();
    if (!/^\\d{5,12}$/u.test(doubanId) || !title) return "";
    return \`\${doubanId}|\${title.normalize("NFKC").toLocaleLowerCase()}\`;
  }

  function normalizedTvEpisodeSeriesName(value) {
    const source = String(value || "")
      .trim()
      .replace(/\\.(?:mp4|mkv|avi|mov|wmv|m4v|webm)$/iu, "")
      .replace(/[._]+/gu, " ")
      .replace(/\\s+/gu, " ")
      .trim();
    if (!source) return "";

    const seasonEpisode = /^(?<title>.+?)\\s*(?<season>s(?:eason)?\\s*0?\\d{1,2})\\s*(?:e|ep(?:isode)?)\\s*0?\\d{1,3}(?:\\s|$)/iu.exec(source);
    if (seasonEpisode?.groups?.title && seasonEpisode.groups.season) {
      const title = normalizedTvSeriesNamePart(seasonEpisode.groups.title);
      const season = Number.parseInt(seasonEpisode.groups.season.match(/\\d+/u)?.[0] || "", 10);
      return title && Number.isFinite(season) ? \`\${title}|s\${season}\` : "";
    }

    const namedEpisode = /^(?<title>.+?)\\s*(?:e|ep(?:isode)?)\\s*0?\\d{1,3}(?:\\s|$)/iu.exec(source);
    if (namedEpisode?.groups?.title) return normalizedTvSeriesNamePart(namedEpisode.groups.title);

    const cjkEpisode = /^(?<title>.*[\\u3400-\\u9FFF])\\s*0?\\d{1,3}$/u.exec(source);
    return cjkEpisode?.groups?.title ? normalizedTvSeriesNamePart(cjkEpisode.groups.title) : "";
  }

  function normalizedTvSeriesNamePart(value) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .replace(/[._]+/gu, " ")
      .replace(/\\s+/gu, " ")
      .replace(/[\\s\\-–—:：]+$/gu, "")
      .trim()
      .toLocaleLowerCase();
    return Array.from(normalized.replace(/\\s+/gu, "")).length >= 2 ? normalized : "";
  }

  function galleryMediaSeriesKey(item, sourceSeriesKey, tvSeries) {
    if (!item || !isEpisodicMediaKind(item.mediaKind)) return "";
    const trustedIdentity = trustedTvMetadataIdentity(tvSeries);
    const localSeriesName = normalizedTvEpisodeSeriesName(item.seriesName || item.personName || item.subCategory || "");
    if (!trustedIdentity || !localSeriesName) return sourceSeriesKey;
    return metadataService.tvSeriesKey("trusted-tv", \`\${trustedIdentity}|\${localSeriesName}\`);
  }

`;
  const previousPublic = `  function publicGalleryMediaItem(item, tvMetadataByKey = null, movieMetadataById = null, publicTvSeriesByKey = null) {
    const sourceSeriesKey = galleryMediaSourceSeriesKey(item);
    let tvSeries = null;
    if (sourceSeriesKey) {
      if (publicTvSeriesByKey?.has(sourceSeriesKey)) tvSeries = publicTvSeriesByKey.get(sourceSeriesKey);
      else {
        tvSeries = metadataService.publicTvSeries(tvMetadataByKey ? tvMetadataByKey.get(sourceSeriesKey) : metadataService.tvSeriesRow(sourceSeriesKey));
        publicTvSeriesByKey?.set(sourceSeriesKey, tvSeries);
      }
    }
    const seriesKey = galleryMediaSeriesKey(item, sourceSeriesKey, tvSeries);
    const movieMetadata = item?.mediaKind === "movie" ? metadataService.publicMovie(movieMetadataById ? movieMetadataById.get(item.id) : metadataService.movieRow(item.id)) : null;
    const movieCoverUrl = movieMetadata?.coverUrl || "";
    const fallbackCoverUrl = item.mediaKind === "movie" || isEpisodicMediaKind(item.mediaKind) ? galleryMediaCoverUrl(item.id, item.updatedAt || "") : "";
    return {
      ...item,
      seriesKey,
      sourceSeriesKey,
      tvSeries,
      movieMetadata,
      coverUrl: movieCoverUrl || fallbackCoverUrl || item.coverUrl || ""
    };
  }

`;
  const previousItems = `  function itemsPayload(url, options = {}) {
    const mode = normalizeImageLibraryMode(url.searchParams.get("mode"));
    const limit = clampInteger(url.searchParams.get("limit"), 48, 1, maxItemLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
    const requestedSort = String(url.searchParams.get("sort") || "updated").trim();
    const sort = query && ["photo", "manga"].includes(mode) ? "relevance" : requestedSort;
    const photoView = normalizePhotoLibraryView(url.searchParams.get("photoView") || url.searchParams.get("view"));
    const tvView = normalizeTvLibraryView(url.searchParams.get("tvView") || url.searchParams.get("view"));
    const category = String(url.searchParams.get("category") || "all").trim() || "all";
    const mediaKind = normalizeMediaKindFilter(url.searchParams.get("kind") || url.searchParams.get("mediaKind"));
    const subCategory = String(url.searchParams.get("subCategory") || "all").trim() || "all";
    const person = String(url.searchParams.get("person") || "all").trim() || "all";
    const date = String(url.searchParams.get("date") || "all").trim() || "all";
    const collection = String(url.searchParams.get("collection") || "").trim();
    const seriesKey = String(url.searchParams.get("seriesKey") || "").trim();
    const index = getImageLibraryIndex(options);
    const sourceStampBefore = listSourceStamp(index, mode);
    let mangaSourceRevision = "";
    const cacheEligible = cachePreparedQueries && ["movie", "tv", "anime", "media"].includes(mode)
      && typeof getImageLibraryRevision === "function" && typeof metadataService.listRevision === "function";
    const queryCacheKey = JSON.stringify([mode, query, sort, photoView, tvView, category, mediaKind, subCategory, person, date, collection, seriesKey]);
    if (options.refresh || !cacheEligible) preparedQueries.clear();
    const prepared = cacheEligible && !options.refresh ? preparedQueries.get(queryCacheKey, sourceStampBefore) : null;
    if (prepared) {
      const cachedItems = prepared.items.slice(offset, offset + limit);
      const response = structuredClone({ ...prepared.header, count: cachedItems.length, total: prepared.items.length,
        limit, offset, nextOffset: offset + cachedItems.length, listRevision: "", items: cachedItems });
      const sourceStampAfter = listSourceStamp(index, mode);
      if (sourceStampBefore !== sourceStampAfter) preparedQueries.clear();
      response.listRevision = publicListRevision(sourceStampBefore, sourceStampAfter, mode, "");
      return response;
    }
    let mediaItems = [];
    if (!["photo", "manga"].includes(mode)) {
      const kinds = mode === "media" ? ["movie", "tv", "anime"] : [mode];
      const rawItems = mediaItemsByKinds(Array.isArray(index.mediaItems) ? index.mediaItems : [], kinds);
      const tvMetadataByKey = rawItems.some((item) => isEpisodicMediaKind(item.mediaKind)) ? metadataService.tvSeriesRowsMap() : new Map();
      const movieMetadataById = rawItems.some((item) => item.mediaKind === "movie") ? metadataService.movieRowsMap() : new Map();
      const publicTvSeriesByKey = new Map();
      mediaItems = rawItems.map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById, publicTvSeriesByKey));
    }

    let source = [];
    let facetsSource = [];
    let photoSubCategoryFacetsSource = [];
    let photoFacets = null;
    let collectionSummary = null;
    let seriesSummary = null;
    let sourceIsSorted = false;
    if (mode === "photo") {
      const catalog = preparedPhotoCatalog(index);
      const defaultPhotoFilters = photoFiltersAreDefault({ category, subCategory, person, date });
      const filteredPhotoSets = defaultPhotoFilters && !collection
        ? catalog.items
        : filterPhotoSetsForList(catalog.items, { category, subCategory, person, date, collection });
      photoFacets = preparedPhotoFacets(catalog, category);
      if (collection) {
        const collectionItems = filterPhotoSetsForList(catalog.items, { collection, category: "all", subCategory: "all", person: "all", date: "all" });
        collectionSummary = photoCollectionSummary(collectionItems, collection);
        photoFacets = photoLibraryFacets(collectionItems, collectionItems, { peopleLimit: 500, includeDates: true });
      }
      source = photoView === "collections" && !collection
        ? defaultPhotoFilters
          ? preparedPhotoCollectionCategories(catalog)
          : photoCollectionCategoryGroups(filteredPhotoSets).map(publicPhotoCollectionCategoryListItem)
        : defaultPhotoFilters && !collection && !query
          ? preparedPhotoSortedItems(catalog, sort)
          : filteredPhotoSets;
      sourceIsSorted = photoView === "albums" && defaultPhotoFilters && !collection && !query;
    } else if (mode === "manga") {
      const mangaSourceHash = createHash("sha256");
      source = mangaService.cacheDirs().map((cacheDir) => {
        const item = publicImageLibraryListItem(mangaService.publicSummary(cacheDir), "manga");
        mangaSourceHash.update(JSON.stringify(item)).update("\\0");
        return item;
      });
      mangaSourceRevision = mangaSourceHash.digest("hex");
    } else if (mode === "media") {
      const movieSource = mediaItemsByKind(mediaItems, "movie").map((item) => publicImageLibraryListItem(item, item.mediaKind));
      const tvSource = mediaItemsByKind(mediaItems, "tv").map((item) => publicImageLibraryListItem(item, item.mediaKind));
      const animeSource = mediaItemsByKind(mediaItems, "anime").map((item) => publicImageLibraryListItem(item, item.mediaKind));
      const episodicSource = [...tvSource, ...animeSource];
      const episodicGroups = tvSeriesGroups(episodicSource);
      const episodicSeriesSource = episodicGroups.map(publicTvSeriesListItem).filter(Boolean);
      const screenWorksSource = [...movieSource, ...episodicSeriesSource];
      facetsSource = screenWorksSource;
      if (seriesKey) {
        const categorySource = filterMediaItemsForList(episodicSource, { category, person, mediaKind });
        source = categorySource.filter((item) => item.seriesKey === seriesKey);
        seriesSummary = publicTvSeriesListItem(episodicGroups.find((group) => group.seriesKey === seriesKey) || null);
      } else if (person !== "all") {
        source = filterMediaItemsForList(episodicSource, { category, person, mediaKind });
        seriesSummary = publicTvSeriesListItem(episodicGroups.find((group) => group.seriesName === person && (mediaKind === "all" || group.mediaKind === mediaKind)) || null);
      } else {
        source = filterMediaItemsForList(screenWorksSource, { category, person, mediaKind });
      }
    } else if (["western", "movie", "tv"].includes(mode)) {
      const mediaSource = mediaItemsByKind(mediaItems, mode).map((item) => publicImageLibraryListItem(item, mode));
      const categorySource = filterMediaItemsForList(mediaSource, { category, person });
      if (mode === "tv") {
        const groups = tvSeriesGroups(mediaSource);
        const tvSeriesSource = groups.map(publicTvSeriesListItem);
        facetsSource = tvSeriesSource;
        if (seriesKey) {
          source = categorySource.filter((item) => item.seriesKey === seriesKey);
          seriesSummary = publicTvSeriesListItem(groups.find((group) => group.seriesKey === seriesKey) || null);
        } else if (person !== "all") {
          source = categorySource;
          seriesSummary = publicTvSeriesListItem(groups.find((group) => group.seriesName === person) || null);
        } else if (tvView === "episodes") {
          source = categorySource;
        } else {
          source = category === "all" ? tvSeriesSource : tvSeriesGroups(categorySource).map(publicTvSeriesListItem);
        }
      } else if (mode === "western") {
        facetsSource = mediaSource;
        source = person === "all" ? westernPersonGroups(categorySource).map(publicWesternPersonListItem) : categorySource;
      } else {
        facetsSource = mediaSource;
        source = categorySource;
      }
    }

    const searchSpec = createImageSearchQuery(query);
    const searchResults = searchSpec ? searchImageLibraryItems(source, searchSpec) : null;
    const filtered = searchResults ? searchResults.map((result) => result.item) : source;
    const sorted = sort === "relevance" && searchResults
      ? [...searchResults].sort(compareImageSearchResults).map((result) => result.item)
      : sourceIsSorted ? source : sortImageLibraryItems(filtered, sort);
    const searchResultsByItem = searchResults ? new Map(searchResults.map((result) => [result.item, result])) : null;
    const items = sorted.slice(offset, offset + limit).map((item) => {
      const match = searchResultsByItem?.get(item);
      if (item.type === "photo" && item.albumNumber) {
        item = { ...item, albumSubject: photoAlbumSubject(item.title, item, item.collectionTitle) };
      }
      return match ? { ...item, matchFields: match.matchFields } : item;
    });
    const response = {
      schemaVersion: 1,
      mode,
      mediaKind: mode === "media" ? mediaKind : "all",
      query,
      sort,
      photoView: mode === "photo" ? (collection ? "albums" : photoView) : "",
      tvView: mode === "tv" ? (seriesKey || tvView === "episodes" ? "episodes" : "series") : mode === "media" && seriesKey ? "episodes" : "",
      category: ["photo", "western", "movie", "tv", "media"].includes(mode) ? category : "",
      subCategory: mode === "photo" ? subCategory : "",
      person: ["photo", "western", "media", "tv"].includes(mode) ? person : "",
      date: mode === "photo" ? date : "",
      collection: mode === "photo" ? collection : "",
      collectionSummary,
      searchTerms: searchSpec?.terms || [],
      seriesKey: ["tv", "media"].includes(mode) ? seriesKey : "",
      seriesSummary,
      facets: mode === "photo" ? photoFacets || photoLibraryFacets(facetsSource, photoSubCategoryFacetsSource) : mediaLibraryFacets(facetsSource),
      stats: {
        ratedCount: sorted.filter((item) => Number(item?.rating || item?.movieMetadata?.rating || item?.tvSeries?.rating || 0) > 0).length,
        totalBytes: sorted.reduce((sum, item) => sum + Number(item?.size || 0), 0)
      },
      count: items.length,
      total: sorted.length,
      limit,
      offset,
      nextOffset: offset + items.length,
      listRevision: publicListRevision(sourceStampBefore, listSourceStamp(index, mode), mode, mangaSourceRevision),
      scannedAt: mode === "manga" ? latestUpdatedAt(source, index.scannedAt || "") : index.scannedAt || "",
      items
    };
    if (!cacheEligible) return response;
    // Retain field insertion order when replacing the pagination values.
    const { items: _items, ...header } = response;
    if (!options.refresh) preparedQueries.set(queryCacheKey, sourceStampBefore, { header,
      items: searchResultsByItem ? sorted.map(item => ({ ...item, matchFields: searchResultsByItem.get(item).matchFields })) : sorted });
    const detached = structuredClone(response);
    const sourceStampAfter = listSourceStamp(index, mode);
    if (sourceStampBefore !== sourceStampAfter) preparedQueries.clear();
    detached.listRevision = publicListRevision(sourceStampBefore, sourceStampAfter, mode, mangaSourceRevision);
    return detached;
  }

`;
  const privateSource = serviceSource.replace("const listRealm = randomUUID();", 'const listRealm = "private-tv-normalization";');
  let previousSource = replaceSection(privateSource, "  function trustedTvMetadataIdentity(", "  function galleryMediaCoverUrl(", previousHelpers, "restore complete TV key derivation helpers");
  previousSource = replaceSection(previousSource, "  function publicGalleryMediaItem(", "  function mediaFacets(", previousPublic, "restore complete media publication function");
  previousSource = replaceSection(previousSource, "  function itemsPayload(", "  function normalizePhotoLibraryView(", previousItems, "restore complete previous item-list owner");
  assert.notEqual(previousSource, privateSource, "the negative control must load a genuinely restored old factory");
  const load = async source => (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).createImageLibraryService;
  const previousFactory = await load(previousSource);
  // The eager factory is the complete implementation before the lazy gate.
  // It supplies a separate negative control for unique-source allocations.
  const previousWidePublic = `  function publicGalleryMediaItem(item, tvMetadataByKey = null, movieMetadataById = null, publicTvSeriesByKey = null, derivationCaches = null) {
    const sourceSeriesKey = galleryMediaSourceSeriesKey(item);
    let tvSeries = null;
    if (sourceSeriesKey) {
      if (publicTvSeriesByKey?.has(sourceSeriesKey)) tvSeries = publicTvSeriesByKey.get(sourceSeriesKey);
      else {
        tvSeries = metadataService.publicTvSeries(tvMetadataByKey ? tvMetadataByKey.get(sourceSeriesKey) : metadataService.tvSeriesRow(sourceSeriesKey));
        publicTvSeriesByKey?.set(sourceSeriesKey, tvSeries);
      }
    }
    const seriesKey = galleryMediaSeriesKey(item, sourceSeriesKey, tvSeries, derivationCaches);
    const movieMetadata = item?.mediaKind === "movie" ? metadataService.publicMovie(movieMetadataById ? movieMetadataById.get(item.id) : metadataService.movieRow(item.id)) : null;
    const movieCoverUrl = movieMetadata?.coverUrl || "";
    const fallbackCoverUrl = item.mediaKind === "movie" || isEpisodicMediaKind(item.mediaKind) ? galleryMediaCoverUrl(item.id, item.updatedAt || "") : "";
    return {
      ...item,
      seriesKey,
      sourceSeriesKey,
      tvSeries,
      movieMetadata,
      coverUrl: movieCoverUrl || fallbackCoverUrl || item.coverUrl || ""
    };
  }

`;
  let previousWideSource = replaceSection(privateSource, "  function publicGalleryMediaItem(", "  function mediaFacets(", previousWidePublic, "restore the complete eager publication function");
  previousWideSource = replaceOnce(previousWideSource, `      const derivationState = { caches: null };
      mediaItems = rawItems.map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById, publicTvSeriesByKey, derivationState));`, `      const derivationCaches = { titles: new Map(), names: new Map() };
      mediaItems = rawItems.map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById, publicTvSeriesByKey, derivationCaches));`, "restore eager request-local maps");
  const measuredSource = process.argv.includes("--legacy-tv-normalization") ? previousSource
    : process.argv.includes("--legacy-wide-tv-normalization") ? previousWideSource : privateSource;
  const measuredFactory = await load(measuredSource);
  const db = new DatabaseSync(":memory:");
  try {
    const schema = fs.readFileSync(path.join(root, "src", "modules", "content-index", "server", "image-gallery-db-service.js"), "utf8");
    for (const table of ["tv_series_metadata", "movie_metadata"]) {
      const create = schema.match(new RegExp("CREATE TABLE IF NOT EXISTS " + table + " \\([\\s\\S]*?\\n    \\);"))?.[0];
      assert.ok(create, "the private database must use the actual " + table + " schema");
      db.exec(create);
    }
    let sql = { bulk: 0, point: 0 }, publicTvCalls = 0;
    const connection = { prepare(query) {
      const statement = db.prepare(query);
      return {
        get(...args) {
          if (/^SELECT \* FROM (?:tv_series_metadata|movie_metadata) WHERE /u.test(query)) sql.point++;
          return statement.get(...args);
        },
        all(...args) {
          if (/^SELECT .+ FROM "(?:tv_series_metadata|movie_metadata)"$/u.test(query)) sql.bulk++;
          return statement.all(...args);
        }
      };
    } };
    const metadata = createGalleryMetadataService({
      createId: (prefix, value) => prefix + "_" + Buffer.from(value).toString("base64url"),
      getImageGalleryDb: () => connection, notFound: () => assert.fail("list checks must never read a cover")
    });
    const publicTv = metadata.publicTvSeries;
    metadata.publicTvSeries = row => { publicTvCalls++; return publicTv(row); };
    const insert = db.prepare("INSERT OR REPLACE INTO tv_series_metadata(series_key,category,series_name,douban_id,douban_title,status,updated_at,year,rating,info_json) VALUES(?,?,?,?,?,?,?,?,?,?)");
    let privateIndex, revision = 0;
    const create = factory => factory({
      cachePreparedQueries: true,
      clampInteger: (value, fallback, min, max) => { const n = Number.parseInt(value, 10); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback)); },
      galleryMediaRootStatuses: () => [], getImageLibraryIndex: () => privateIndex, getImageLibraryRevision: () => revision,
      imageReaderCacheStatus: () => ({}), mangaService: { cacheDirs: () => [], publicSummary: value => value, rootStatus: () => ({ root: "", exists: false }) }, maxItemLimit: 100,
      metadataService: metadata, photoCollectionRootValue: "synthetic", photoSetRootStatuses: () => [], photoSetService: { coverUrl: () => "" }
    });
    const makeIndex = (count = 10000, seriesCount = 200) => {
      db.exec("DELETE FROM tv_series_metadata");
      const rows = Array.from({ length: count }, (_, n) => {
        const series = n % seriesCount, category = "分类 " + series % 5, name = "Synthetic Show " + series + " S01E01";
        return { id: "tv-" + n, type: "media", mediaKind: "tv", title: "Episode " + n, seriesName: name, personName: name, subCategory: name,
          category, rootLabel: "synthetic", sourceRoot: "synthetic-root", relativePath: "s" + series + "/e" + n + ".mkv",
          size: n + 1, updatedAt: "2026-10-04", playable: n % 2 === 0 };
      });
      for (let series = 0; series < seriesCount; series++) {
        const category = "分类 " + series % 5, name = "Synthetic Show " + series + " S01E01";
        insert.run(metadata.tvSeriesKey(category, name), category, name, String(1000000 + series), "Synthetic Metadata " + series,
          "ok", "synthetic", "2026", 8.1, '{"集数":"50"}');
      }
      return { scannedAt: "synthetic", photoSets: [], mediaItems: rows };
    };
    privateIndex = makeIndex();
    let previous = create(previousFactory), current = create(measuredFactory), oracles = 0, errors = 0;
    function compare(params = {}, options = { refresh: true }) {
      const url = request({ mode: "tv", limit: "48", ...params });
      const before = previous.itemsPayload(url, options), after = current.itemsPayload(url, options);
      assert.deepEqual(after, before, "complete TV/media list DTO, including revision, facets, stats and pagination");
      assert.equal(JSON.stringify(after), JSON.stringify(before), "complete serialized list fields and ordering");
      oracles++;
      return after;
    }
    const unchanged = structuredClone(privateIndex);
    for (const mode of ["tv", "media", "anime", "movie"]) for (const sort of ["updated", "title", "size", "year", "rating"]) compare({ mode, sort });
    for (const category of ["all", "分类 2", "missing"]) for (const offset of ["0", "48", "999"]) compare({ category, offset });
    const first = compare().items[0];
    compare({ seriesKey: first.seriesKey }); compare({ person: first.personName }); compare({ tvView: "episodes" }); compare({ q: "Metadata 2" });
    assert.deepEqual(privateIndex, unchanged, "request-local string derivation must not mutate the source catalog");
    compare({}, {}); compare({ offset: "48" }, {});
    db.prepare("UPDATE tv_series_metadata SET douban_title='changed',year='1999' WHERE douban_id='1000000'").run();
    compare({ offset: "48" }, {});
    privateIndex = { ...privateIndex, mediaItems: privateIndex.mediaItems.slice().reverse() }; revision++;
    compare({}, {});

    const names = ["剧集第一季01", "剧集第一季02", "Show S01E01", "Show S01E02", "Show S02E01", "Show EP01", "Show E002",
      "Name___S01E01.mkv", "Ｎａｍｅ_S01E01.mp4", "e\u0301pisode S01E01", "Episode unknown", "", "x", "😀 S01E01", "lower.SEASON 2 EPISODE 3", "bad s99e9999"];
    privateIndex = { ...privateIndex, mediaItems: names.flatMap((name, n) => Array.from({ length: 3 }, (_, copy) => ({
      id: "unicode-" + n + "-" + copy, mediaKind: "tv", title: "Episode " + n, category: "unicode", seriesName: name,
      rootLabel: "synthetic", relativePath: "x.mkv", size: 1, updatedAt: "v"
    }))) }; revision++;
    for (const [n, name] of names.entries()) insert.run(metadata.tvSeriesKey("unicode", name || "Episode " + n), "unicode", name, "12345678", "Ｍｅｔａ e\u0301", "ok", "v", "2026", 8, "{}");
    for (const mode of ["tv", "media"]) for (const sort of ["updated", "title"]) for (const offset of ["0", "7"]) compare({ mode, sort, offset, limit: "7" });

    // A base64 source key can be equal for different category/name tuples.
    // These rows share the actual memoized TV DTO but must derive distinct keys.
    const shared = [
      { id: "shared-a", mediaKind: "tv", category: "x|Shared S01E01", seriesName: "Shared S02E01", title: "A", size: 1 },
      { id: "shared-b", mediaKind: "tv", category: "x", seriesName: "Shared S01E01|Shared S02E01", title: "B", size: 2 }
    ];
    const sharedKey = metadata.tvSeriesKey(shared[0].category, shared[0].seriesName);
    assert.equal(sharedKey, metadata.tvSeriesKey(shared[1].category, shared[1].seriesName));
    insert.run(sharedKey, "x", "Shared", "7654321", "One metadata object", "ok", "v", "2026", 8, "{}");
    privateIndex = { ...privateIndex, mediaItems: shared }; revision++;
    previous = create(previousFactory); current = create(measuredFactory);
    publicTvCalls = 0;
    const sharedResponse = compare();
    assert.equal(publicTvCalls, 2, "each owner publishes the shared source TV metadata only once");
    assert.equal(sharedResponse.total, 2); assert.notEqual(sharedResponse.items[0].seriesKey, sharedResponse.items[1].seriesKey);
    for (const [status, id, title] of [["missing", "12345678", "Missing"], ["ok", "", "Unknown"], ["ok", "12", "Short ID"],
      ["ok", "not-id", "Invalid ID"], ["ok", "12345678", ""], ["ok", null, null], ["ok", "12345678", "Valid"]]) {
      db.prepare("UPDATE tv_series_metadata SET status=?,douban_id=?,douban_title=? WHERE series_key=?").run(status, id, title, sharedKey);
      for (const mode of ["tv", "media"]) for (const tvView of ["series", "episodes"]) compare({ mode, tvView });
    }
    db.prepare("DELETE FROM tv_series_metadata WHERE series_key=?").run(sharedKey); compare(); compare({ mode: "media" });

    const cross = [
      { id: "cross-a", mediaKind: "tv", category: "a", seriesName: "Shared S01E01", title: "A", size: 5, rootLabel: "A", playable: true },
      { id: "cross-b", mediaKind: "tv", category: "b", seriesName: "Shared S01E02", title: "B", size: 7, rootLabel: "B", playable: true }
    ];
    for (const row of cross) insert.run(metadata.tvSeriesKey(row.category, row.seriesName), row.category, row.seriesName, "1234567", "Shared Metadata", "ok", "v", "2026", 8, "{}");
    privateIndex = { ...privateIndex, mediaItems: cross }; revision++;
    const categoryB = compare({ category: "b" }), allCategories = compare();
    assert.equal(categoryB.total, 1); assert.equal(categoryB.items[0].size, 7); assert.equal(categoryB.items[0].firstEpisodeId, "cross-b");
    assert.equal(allCategories.total, 1); assert.equal(allCategories.items[0].size, 12); assert.equal(allCategories.items[0].category, "a");
    privateIndex = { ...privateIndex, mediaItems: [] }; revision++; compare();
    privateIndex = { ...privateIndex, mediaItems: [{ id: "numeric", mediaKind: "tv", category: "a", seriesName: 12, title: "Numeric" }] }; revision++; compare();

    // No context is passed by legacy full-catalog/detail publication callers.
    for (const item of [privateIndex.mediaItems[0], cross[0]]) {
      assert.equal(JSON.stringify(current.publicGalleryMediaItem(item)), JSON.stringify(previous.publicGalleryMediaItem(item))); oracles++;
    }
    privateIndex = { ...privateIndex, mediaItems: cross }; revision++;
    assert.equal(JSON.stringify(current.payload()), JSON.stringify(previous.payload()), "the full-catalog publication remains uncached and complete"); oracles++;

    const held = new Error("private unchanged TV conversion error"), events = [];
    let coercions = 0;
    const tricky = { toString() { events.push("coercion"); if (++coercions === 2) throw held; return "Error S01E01"; } };
    privateIndex = { ...privateIndex, mediaItems: [{ id: "error", mediaKind: "tv", title: "Error", category: "errors", seriesName: tricky }] }; revision++;
    insert.run(metadata.tvSeriesKey("errors", "Error S01E01"), "errors", "Error S01E01", "12345678", "Error Meta", "ok", "v", "2026", 8, "{}");
    const bulk = metadata.tvSeriesRowsMap;
    metadata.tvSeriesRowsMap = () => { events.push("bulk"); return bulk(); };
    for (const status of ["ok", "missing"]) {
      db.prepare("UPDATE tv_series_metadata SET status=? WHERE series_key=?").run(status, metadata.tvSeriesKey("errors", "Error S01E01"));
      for (const factory of [previousFactory, measuredFactory]) {
        coercions = 0; events.length = 0;
        assert.throws(() => create(factory).itemsPayload(request({ mode: "tv" }), { refresh: true }), error => error === held);
        assert.equal(coercions, 2); assert.deepEqual(events, ["bulk", "coercion", "coercion"]); errors++;
      }
    }
    metadata.tvSeriesRowsMap = bulk;
    const normalize = String.prototype.normalize;
    privateIndex = { ...privateIndex, mediaItems: [{ id: "bad-title", mediaKind: "tv", category: "errors", seriesName: "Bad S01E01", title: "Bad" }] }; revision++;
    insert.run(metadata.tvSeriesKey("errors", "Bad S01E01"), "errors", "Bad S01E01", "12345678", "Normalize error", "ok", "v", "2026", 8, "{}");
    for (const failingString of ["Normalize error", "Bad"]) {
      for (const factory of [previousFactory, measuredFactory]) {
        const owner = create(factory);
        String.prototype.normalize = function(...args) { if (String(this) === failingString) throw held; return normalize.apply(this, args); };
        try { assert.throws(() => owner.itemsPayload(request({ mode: "tv" })), error => error === held); }
        finally { String.prototype.normalize = normalize; }
        assert.equal(owner.itemsPayload(request({ mode: "tv" })).items[0].title, "Normalize error", "failed pure normalization must not admit a result"); errors++;
      }
    }
    privateIndex = makeIndex(100, 4); revision++;
    const tvKey = metadata.tvSeriesKey;
    for (const factory of [previousFactory, measuredFactory]) {
      let calls = 0;
      metadata.tvSeriesKey = (...args) => { if (++calls === 7) throw held; return tvKey(...args); };
      try { assert.throws(() => create(factory).itemsPayload(request({ mode: "tv" }), { refresh: true }), error => error === held); assert.equal(calls, 7); errors++; }
      finally { metadata.tvSeriesKey = tvKey; }
    }
    for (const factory of [previousFactory, measuredFactory]) {
      privateIndex = { ...privateIndex, mediaItems: Array.from({ length: 3 }, (_, n) => ({ id: "getter-" + n, mediaKind: "tv", category: "errors", seriesName: "Getter S01E01", title: "Getter" })) }; revision++;
      insert.run(metadata.tvSeriesKey("errors", "Getter S01E01"), "errors", "Getter S01E01", "12345678", "Getter Meta", "ok", "v", "2026", 8, "{}");
      let titleReads = 0, idReads = 0;
      const previousPublic = metadata.publicTvSeries;
      metadata.publicTvSeries = row => { const dto = previousPublic(row); return { ...dto,
        get doubanId() { idReads++; return dto.doubanId; },
        get title() { if (++titleReads === 3) throw held; return dto.title; }
      }; };
      try {
        assert.throws(() => create(factory).itemsPayload(request({ mode: "tv" }), { refresh: true }), error => error === held);
        assert.equal(titleReads, 3); assert.equal(idReads, 3); errors++;
      } finally { metadata.publicTvSeries = previousPublic; }
    }

    // Fully unique names/titles exercise the no-reuse distribution. Timing and
    // transient heap deltas are diagnostic only, never acceptance thresholds.
    privateIndex = makeIndex(10000, 10000); revision++;
    previous = create(previousFactory); current = create(measuredFactory);
    compare();
    const unique = { old: [], current: [], heapOld: [], heapCurrent: [] };
    for (let iteration = 0; iteration < 4; iteration++) for (const [label, owner] of [["old", previous], ["current", current]]) {
      const heap = process.memoryUsage().heapUsed, began = performance.now();
      owner.itemsPayload(request({ mode: "tv", limit: "48" }), { refresh: true });
      unique[label].push(+(performance.now() - began).toFixed(1));
      unique[label === "old" ? "heapOld" : "heapCurrent"].push(process.memoryUsage().heapUsed - heap);
    }
    console.log("image-tv-normalization-unique: synthetic 10k unique series/titles, complete DTO equal; " + JSON.stringify(unique));

    // Capture the actual request-local state in private factories. No hook or
    // state enters production DTOs or prepared plans.
    const allocationResults = [];
    let capturedState = null, captureCalls = 0;
    let capturedSource = measuredSource;
    const lazyMarker = "      const derivationState = { caches: null };";
    const eagerMarker = "      const derivationCaches = { titles: new Map(), names: new Map() };";
    const contextMarker = capturedSource.includes(lazyMarker) ? lazyMarker
      : capturedSource.includes(eagerMarker) ? eagerMarker : null;
    if (contextMarker) {
      capturedSource = replaceOnce(capturedSource, contextMarker, contextMarker +
        "\n      globalThis.__imageTvNormalizationCapture(" + (contextMarker === lazyMarker ? "derivationState" : "derivationCaches") + ");",
        "observe the actual derivation context only in the private factory");
    } else assert.equal(measuredSource, previousSource, "only the original uncached oracle may have no derivation context");
    const capturedFactory = await load(capturedSource);
    globalThis.__imageTvNormalizationCapture = state => { capturedState = state; captureCalls++; };
    try {
      function inspect(distribution) {
        const oldOwner = create(previousFactory), actualOwner = create(capturedFactory);
        capturedState = null; captureCalls = 0;
        const before = oldOwner.itemsPayload(request({ mode: "tv", limit: "48" }), { refresh: true });
        const after = actualOwner.itemsPayload(request({ mode: "tv", limit: "48" }), { refresh: true });
        assert.deepEqual(after, before); assert.equal(JSON.stringify(after), JSON.stringify(before)); oracles++;
        assert.equal(captureCalls, contextMarker ? 1 : 0, "the actual cold owner must publish its private context exactly once");
        const maps = capturedState && Object.hasOwn(capturedState, "caches") ? capturedState.caches : capturedState;
        allocationResults.push({ distribution, maps: maps ? 2 : 0, titles: maps?.titles.size || 0, names: maps?.names.size || 0 });
        capturedState = null;
      }
      privateIndex = makeIndex(1, 1); revision++; inspect("singleton");
      privateIndex = makeIndex(); revision++; inspect("repeat");
      privateIndex = makeIndex(10000, 10000); revision++; inspect("unique");
      privateIndex = makeIndex(0, 0);
      insert.run(sharedKey, "x", "Shared", "7654321", "One metadata object", "ok", "v", "2026", 8, "{}");
      privateIndex = { ...privateIndex, mediaItems: Array.from({ length: 10000 }, (_, index) => ({
        ...shared[index % 2], id: "interleaved-ambiguous-" + index
      })) }; revision++; inspect("ambiguous");
      privateIndex = makeIndex(10000, 10000);
      db.prepare("UPDATE tv_series_metadata SET douban_title='Same Metadata'").run();
      revision++; inspect("same-title-different-id");
      privateIndex = makeIndex(); db.exec("DELETE FROM tv_series_metadata"); revision++; inspect("unknown");
    } finally {
      capturedState = null;
      delete globalThis.__imageTvNormalizationCapture;
    }
    console.log("image-tv-normalization-allocation: " + oracles + " complete DTO / " + errors +
      " identical-error oracles passed before allocation budget; " + JSON.stringify(allocationResults));
    const allocation = name => allocationResults.find(result => result.distribution === name);
    assert.deepEqual(allocation("unique"), { distribution: "unique", maps: 0, titles: 0, names: 0 },
      "all-unique sources must create no derivation maps or retained string entries");
    for (const name of ["singleton", "same-title-different-id"]) {
      assert.deepEqual(allocation(name), { distribution: name, maps: 0, titles: 0, names: 0 }, "first source occurrences do not allocate derivation maps");
    }
    for (const [name, maxTitles, maxNames] of [["repeat", 200, 200], ["ambiguous", 1, 2], ["unknown", 0, 200]]) {
      const result = allocation(name);
      assert.ok(result.maps <= 2 && result.titles <= maxTitles && result.names <= maxNames, "repeated source contexts retain only distinct primitive derivations");
    }

    // All response/error/source-distribution oracles finish before the budget.
    privateIndex = makeIndex(); revision++;
    previous = create(previousFactory); current = create(measuredFactory);
    const seasonPattern = /^(?<title>.+?)\s*(?<season>s(?:eason)?\s*0?\d{1,2})\s*(?:e|ep(?:isode)?)\s*0?\d{1,3}(?:\s|$)/iu.source;
    const exec = RegExp.prototype.exec, from = Array.from;
    function measure(owner) {
      const counts = { nfkc: 0, seasonRegex: 0, codePoints: 0 };
      sql = { bulk: 0, point: 0 }; publicTvCalls = 0;
      String.prototype.normalize = function(...args) { if (args[0] === "NFKC") counts.nfkc++; return normalize.apply(this, args); };
      RegExp.prototype.exec = function(value) { if (this.source === seasonPattern) counts.seasonRegex++; return exec.call(this, value); };
      Array.from = function(...args) { counts.codePoints++; return from.apply(this, args); };
      const started = performance.now();
      try { return { response: owner.itemsPayload(request({ mode: "tv", limit: "48" }), { refresh: true }),
        counts, sql: { ...sql }, publicTvCalls, elapsed: performance.now() - started }; }
      finally { String.prototype.normalize = normalize; RegExp.prototype.exec = exec; Array.from = from; }
    }
    const before = measure(previous), after = measure(current);
    assert.equal(JSON.stringify(after.response), JSON.stringify(before.response), "the real primitive operation probes preserve the complete response"); oracles++;
    assert.deepEqual(after.sql, before.sql); assert.equal(after.publicTvCalls, before.publicTvCalls);
    assert.deepEqual(after.sql, { bulk: 1, point: 0 }); assert.equal(after.publicTvCalls, 200);
    // The single extra NFKC is the existing search-spec parser on the empty query.
    assert.deepEqual(before.counts, { nfkc: 20001, seasonRegex: 10000, codePoints: 10000 }, "actual old factory establishes repeated per-episode work");
    console.log("image-tv-normalization: " + oracles + " complete DTO / " + errors + " identical-error oracles passed before budget; synthetic 10k episodes / 200 series; " + JSON.stringify({ old: before.counts, current: after.counts }));
    assert.deepEqual(after.counts, { nfkc: 801, seasonRegex: 400, codePoints: 400 }, "cold lists normalize first occurrences directly and memoize repeated sources within the request");
    console.log("image-tv-normalization: " + before.elapsed.toFixed(1) + "/" + after.elapsed.toFixed(1) + "ms diagnostic; SQL and public-TV publication unchanged");
  } finally { db.close(); }
}

function verifyImageCollationWork() {
  const privateIndex = { scannedAt: "synthetic-collation", photoSets: [], mediaItems: Array.from({ length: 2048 }, (_, index) => {
    const value = index * 7919 % 2048;
    return { id: `collation-${value}`, mediaKind: "tv", title: `中文 Title ${value}`, seriesName: `系列 ${value}`, personName: `系列 ${value}`,
      category: "合成分类", rootLabel: "synthetic", size: 1, updatedAt: "2026-10-05", playable: true };
  }) };
  const originalCompare = String.prototype.localeCompare;
  const measured = service => {
    let calls = 0;
    String.prototype.localeCompare = function (other, locale, options) {
      if (locale === undefined && options?.numeric === true && options.sensitivity === "base") calls += 1;
      return originalCompare.call(this, other, locale, options);
    };
    const started = performance.now();
    try {
      return { response: service.itemsPayload(request({ mode: "tv", tvView: "episodes", sort: "title", limit: "48" })), calls, elapsed: performance.now() - started };
    } finally { String.prototype.localeCompare = originalCompare; }
  };
  const current = measured(createService(createImageLibraryService, privateIndex));
  const previous = measured(createService(createLegacyImageLibraryService, privateIndex));
  assert.equal(JSON.stringify(legacyListResponse(current.response)), JSON.stringify(previous.response), "the old per-comparison locale implementation preserves complete TV response bytes");
  assert.equal(current.calls, 0, "numeric/base comparisons reuse the bound collator instead of calling localeCompare with options");
  assert.ok(previous.calls > privateIndex.mediaItems.length, "the restored old implementation must violate the new bounded collation work guarantee");
  console.log(`image-collation: private 2048 TV records; old numeric/base localeCompare calls=${previous.calls}, current=${current.calls}; ${previous.elapsed.toFixed(1)}ms/${current.elapsed.toFixed(1)}ms diagnostic, byte-equivalent response`);
}

function previousSearchSource(source, { fields = true, dates = true } = {}) {
  let previous = source;
  if (fields) previous = replaceOnce(previous, `      const { compactFields } = document;
      if (!searchSpec.terms.every((term) => imageSearchFieldNames.some((field) => compactFields[field].includes(term)))) continue;

      const matchFields = imageSearchFieldNames.filter((field) => searchSpec.terms.some((term) => compactFields[field].includes(term)));`, `      const entries = Object.entries(document.compactFields);
      if (!searchSpec.terms.every((term) => entries.some(([, value]) => value.includes(term)))) continue;

      const matchFields = entries.filter(([, value]) => searchSpec.terms.some((term) => value.includes(term))).map(([field]) => field);
      const { compactFields } = document;`, "restore previous per-row search entries");
  if (dates) previous = replaceOnce(previous, `    // Search results live for this request. NaN stays cached and still falls
    // through to the existing title tie-breaker.
    const aTime = a.updatedAt ?? (a.updatedAt = new Date(a.item?.updatedAt || 0).getTime());
    const bTime = b.updatedAt ?? (b.updatedAt = new Date(b.item?.updatedAt || 0).getTime());
    const timeDiff = bTime - aTime;`, `    const timeDiff = new Date(b.item?.updatedAt || 0).getTime() - new Date(a.item?.updatedAt || 0).getTime();`, "restore previous per-comparison date parsing");
  return previous;
}

async function verifyImageSearchWork() {
  const originalEntries = Object.entries;
  const OriginalDate = Date;
  let work = { entries: 0, dates: 0 };
  globalThis.__imageSearchEntries = (...args) => { work.entries += 1; return originalEntries(...args); };
  globalThis.__imageSearchDate = class extends OriginalDate {
    constructor(...args) { super(...args); work.dates += 1; }
  };
  const measuredFactory = async code => (await import(`data:text/javascript;base64,${Buffer.from(code
    .replaceAll("Object.entries(", "globalThis.__imageSearchEntries(")
    .replaceAll("new Date(", "new globalThis.__imageSearchDate(")).toString("base64")}`)).createImageLibraryService;
  try {
    const restored = previousSearchSource(serviceSource);
    let actual = serviceSource;
    if (process.argv.includes("--legacy-search-work")) actual = previousSearchSource(actual, { dates: false });
    if (process.argv.includes("--legacy-search-dates")) actual = previousSearchSource(actual, { fields: false });
    const actualFactory = await measuredFactory(actual), previousFactory = await measuredFactory(restored);
    for (const query of ["普通作品", "特别作品"]) {
      const current = createService(actualFactory, index), previous = createService(previousFactory, index);
      const first = request({ mode: "photo", q: query, limit: "48" });
      current.itemsPayload(first); previous.itemsPayload(first);
      const run = service => {
        work = { entries: 0, dates: 0 };
        const start = performance.now(), responses = [];
        for (let page = 0; page < 10; page++) responses.push(service.itemsPayload(request({ mode: "photo", q: query, offset: String(page * 48), limit: "48" })));
        return { responses, counts: { ...work }, elapsed: performance.now() - start };
      };
      const optimized = run(current), old = run(previous);
      assert.equal(optimized.counts.entries, 0, "warm search must not allocate Object.entries for each document");
      assert.equal(old.counts.entries, index.photoSets.length * 10, "the actual previous matcher violates the bounded field allocation contract");
      const maxDates = optimized.responses[0].total * 10;
      assert.ok(optimized.counts.dates <= maxDates && optimized.counts.dates > 0, "relevance must parse each matched item at most once per request");
      assert.ok(old.counts.dates > maxDates, "the actual previous comparator violates the date parsing bound");
      for (let page = 0; page < 10; page++) {
        const withoutRevision = response => { const { listRevision, ...rest } = response; return rest; };
        assert.equal(JSON.stringify(withoutRevision(optimized.responses[page])), JSON.stringify(withoutRevision(old.responses[page])),
          "complete warm search response bytes, raw offsets and EOF remain equivalent");
      }
      console.log(`image-search-work: ${query}, 50k photos/10 warm pages; entries ${old.counts.entries}->${optimized.counts.entries}, Date ${old.counts.dates}->${optimized.counts.dates}; ${old.elapsed.toFixed(1)}ms/${optimized.elapsed.toFixed(1)}ms diagnostic; 10 byte oracles passed`);
    }
  } finally {
    delete globalThis.__imageSearchEntries;
    delete globalThis.__imageSearchDate;
  }
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
  assert.deepStrictEqual(legacyListResponse(optimizedResponse), legacyResponse, `${name} service response must match the restored legacy implementation`);
  assert.equal(JSON.stringify(legacyListResponse(optimizedResponse)), JSON.stringify(legacyResponse), `${name} serialized response must match the restored legacy implementation`);
}

function verifyPreparedPhotoSortCache(factory) {
  let currentIndex = createSortCacheIndex("first");
  const service = createService(factory, () => currentIndex);
  const legacyService = createService(createLegacyImageLibraryService, () => currentIndex);
  const legacyUpdated = legacyService.itemsPayload(request({ mode: "photo", photoView: "albums", sort: "updated", limit: "24" }));

  for (let index = 0; index < 1000; index += 1) {
    const rawSort = `unknown-sort-${index}`;
    const actual = service.itemsPayload(request({ mode: "photo", photoView: "albums", sort: rawSort, limit: "24" }));
    const expected = { ...legacyUpdated, sort: rawSort };
    assert.deepStrictEqual(legacyListResponse(actual), expected, `unknown sort ${index} must preserve legacy updated behavior and its raw payload value`);
    assert.equal(JSON.stringify(legacyListResponse(actual)), JSON.stringify(expected), `unknown sort ${index} must preserve legacy updated response bytes`);
    if (index === 99) {
      assert.deepStrictEqual(service.__testPhotoCatalogState().sortedKeys, ["updated"], "100 unknown sorts must share one canonical updated cache entry");
    }
  }
  assert.deepStrictEqual(service.__testPhotoCatalogState().sortedKeys, ["updated"], "1000 unknown sorts must share one canonical updated cache entry");

  const branchSorts = ["count", "title", "size", "rating", "year"];
  for (const sort of branchSorts) {
    const actual = service.itemsPayload(request({ mode: "photo", photoView: "albums", sort, limit: "24" }));
    const expected = legacyService.itemsPayload(request({ mode: "photo", photoView: "albums", sort, limit: "24" }));
    assert.deepStrictEqual(legacyListResponse(actual), expected, `${sort} must preserve the legacy sort branch`);
    service.itemsPayload(request({ mode: "photo", photoView: "albums", sort: ` ${sort} `, limit: "24" }));
  }
  assert.deepStrictEqual(service.__testPhotoCatalogState().sortedKeys, ["updated", ...branchSorts], "every concrete sort branch must occupy exactly one cache entry");

  const relevanceWithoutQuery = service.itemsPayload(request({ mode: "photo", photoView: "albums", sort: "relevance", limit: "24" }));
  assert.deepStrictEqual(legacyListResponse(relevanceWithoutQuery), { ...legacyUpdated, sort: "relevance" }, "relevance without search terms must preserve legacy updated ordering and raw sort payload");
  const keysBeforeSearch = service.__testPhotoCatalogState().sortedKeys;
  const relevanceWithQuery = service.itemsPayload(request({ mode: "photo", photoView: "albums", sort: "count", q: "缓存作品", limit: "24" }));
  const legacyRelevanceWithQuery = legacyService.itemsPayload(request({ mode: "photo", photoView: "albums", sort: "count", q: "缓存作品", limit: "24" }));
  assert.deepStrictEqual(legacyListResponse(relevanceWithQuery), legacyRelevanceWithQuery, "search relevance must stay outside the prepared sort cache and preserve legacy results");
  assert.deepStrictEqual(service.__testPhotoCatalogState().sortedKeys, keysBeforeSearch, "search relevance must not add a prepared sort cache entry");

  const firstIndex = currentIndex;
  assert.strictEqual(service.__testPhotoCatalogState().index, firstIndex, "prepared catalog must retain the current index identity");
  currentIndex = createSortCacheIndex("second");
  const switchedResponse = service.itemsPayload(request({ mode: "photo", photoView: "albums", sort: "updated", limit: "24" }));
  const legacySwitchedResponse = legacyService.itemsPayload(request({ mode: "photo", photoView: "albums", sort: "updated", limit: "24" }));
  const switchedState = service.__testPhotoCatalogState();
  assert.strictEqual(switchedState.index, currentIndex, "a new index identity must replace the prepared catalog");
  assert.notStrictEqual(switchedState.index, firstIndex, "the old prepared catalog identity must be discarded");
  assert.deepStrictEqual(switchedState.sortedKeys, ["updated"], "a new index identity must start with a fresh sort cache");
  assert.deepStrictEqual(legacyListResponse(switchedResponse), legacySwitchedResponse, "index identity switching must preserve the legacy response");
}

async function verifyPreparedPhotoFacetCache(factory) {
  const policy = `      // Request values are unbounded; only source categories belong in the
      // prepared catalog. Unknown categories still return their normal result.
      if (key === "all" || catalog.categories.some((category) => category.value === key)) {
        catalog.subCategories.set(key, subCategories);
      }`;
  const oldSource = replaceOnce(serviceSource, policy, "      catalog.subCategories.set(key, subCategories);", "restore the actual previous unbounded category cache");
  const { createImageLibraryService: previousFactory } = await import(testableServiceModuleUrl(oldSource));
  let currentIndex = createSortCacheIndex("first");
  const current = createService(factory, () => currentIndex);
  const previous = createService(previousFactory, () => currentIndex);
  const run = (service, category) => service.itemsPayload(request({ mode: "photo", category, limit: "24" }));
  const compare = category => {
    const actual = run(current, category), expected = run(previous, category);
    assert.equal(JSON.stringify(legacyListResponse(actual)), JSON.stringify(legacyListResponse(expected)), "bounded facet retention preserves complete response bytes");
    return actual;
  };
  compare("all");
  const known = compare("分类 1");
  assert.strictEqual(compare(" 分类 1 ").facets.subCategories, known.facets.subCategories, "a real category still reuses its prepared facets");
  for (let index = 0; index < 1000; index += 1) {
    const result = compare(`Missing category ${index}`);
    assert.equal(result.total, 0);
    assert.deepStrictEqual(result.facets.subCategories, []);
  }
  assert.deepStrictEqual(current.__testPhotoCatalogState().facetKeys, ["all", "分类 1"], "unknown requests must not increase retained category state");
  assert.equal(previous.__testPhotoCatalogState().facetKeys.length, 1002, "the actual old policy violates the source-bounded cache contract");
  for (const category of ["分类 0", "分类 2", "分类 3"]) compare(category);
  assert.equal(current.__testPhotoCatalogState().facetKeys.length, 5, "all source categories and the all-categories view still cache normally");
  const firstIndex = currentIndex;
  currentIndex = { ...createSortCacheIndex("second"), photoSets: currentIndex.photoSets.map(item => ({ ...item, category: "Fresh category", subCategory: "Fresh folder" })) };
  compare("分类 1");
  compare("Fresh category");
  compare("all");
  const refreshed = current.__testPhotoCatalogState();
  assert.notStrictEqual(refreshed.index, firstIndex);
  assert.deepStrictEqual(refreshed.facetKeys, ["Fresh category", "all"], "source replacement releases old facets and permits the new real category");
  console.log("image-facet-cache: 1000 unknown categories retain 2 warm entries instead of the old 1002; byte-equivalent responses, known reuse and source replacement passed");
}

function createSortCacheIndex(label) {
  return {
    scannedAt: `2026-08-11T00:00:0${label === "first" ? 1 : 2}.000Z`,
    photoSets: Array.from({ length: 64 }, (_, index) => ({
      id: `${label}-sort-${index}`,
      title: `2026.07.01 VOL.${index + 1} 缓存作品 ${String(63 - index).padStart(2, "0")}`,
      category: `分类 ${index % 4}`,
      subCategory: `文件夹 ${index % 8}`,
      personName: `人物 ${index % 16}`,
      relativePath: `合集 ${index % 6}/album-${index}.zip`,
      sourceRoot: "T:\\[套图]",
      rootLabel: "[套图]",
      size: (index + 1) * 100,
      rating: index % 5,
      year: String(2000 + index % 20),
      updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, label === "first" ? index : index + 1000)).toISOString()
    })),
    mediaItems: []
  };
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
  const getIndex = typeof index === "function" ? index : () => index;
  return factory({
    clampInteger(value, fallback, min, max) {
      const parsed = Number.parseInt(String(value ?? ""), 10);
      return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
    },
    galleryMediaRootStatuses: () => [],
    getImageLibraryIndex: getIndex,
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

async function verifyMetadataConnectionRecovery() {
  const metadataPath = new URL("../src/modules/media/server/gallery-metadata-service.js", import.meta.url);
  const metadataSource = fs.readFileSync(metadataPath, "utf8").replaceAll("\r\n", "\n");
  const revisionRead = "return readWithFinalizedRecovery(db, listRevisions, () => readListRevision(db, mode));";
  const oldRevisionRead = "return readListRevision(db, mode);";
  const bulkRead = 'return readWithFinalizedRecovery(db, metadataProjections,\n      () => new Map(metadataStatement(table, forPublication, "", db).all().map(row => [row[key], row])));';
  const oldBulkRead = 'return new Map(metadataStatement(table, forPublication, "", db).all().map(row => [row[key], row]));';
  assert.equal(metadataSource.split(revisionRead).length, 2);
  assert.equal(metadataSource.split(bulkRead).length, 2);
  const oldSource = metadataSource.replace(revisionRead, oldRevisionRead).replace(bulkRead, oldBulkRead);
  assert.equal(oldSource.replace(oldRevisionRead, revisionRead).replace(oldBulkRead, bulkRead), metadataSource, "the negative oracle disables only finalized-statement recovery");
  const moduleUrl = source => "data:text/javascript;base64," + Buffer.from(source.replace('"../../../../lib/gallery-metadata-revision.js"',
    JSON.stringify(new URL("../lib/gallery-metadata-revision.js", import.meta.url).href))).toString("base64");
  const previousFactory = (await import(moduleUrl(oldSource))).createGalleryMetadataService;
  const selectedFactory = process.argv.includes("--legacy-finalized-metadata") ? previousFactory : createGalleryMetadataService;
  // Use the production schema/clock initializer with actual in-memory SQLite.
  const schemaSource = fs.readFileSync(new URL("../src/modules/content-index/server/image-gallery-db-service.js", import.meta.url), "utf8");
  const { ensureSchema } = await import(moduleUrl(schemaSource + "\nexport { ensureSchema };"));
  const owners = [], warnings = [], originalWarn = console.warn;
  let oracles = 0;
  console.warn = (...args) => warnings.push(args);
  const freshDb = () => { const db = new DatabaseSync(":memory:"); owners.push(db); return db; };
  const total = 1000;
  const privateIndex = { scannedAt: "synthetic", photoSets: [], mediaItems: [
    ...Array.from({ length: total }, (_, index) => ({ id: `M${index}`, mediaKind: "movie", title: `Local ${index}`, category: "fixture", size: index + 1, updatedAt: "2026-01-01" })),
    ...Array.from({ length: 6 }, (_, index) => ({ id: `T${index}`, mediaKind: "tv", title: `Show ${Math.floor(index / 3)} 第 ${index % 3 + 1} 集`, seriesName: `Show ${Math.floor(index / 3)}`, category: "fixture", size: index + 1, updatedAt: "2026-01-01" }))
  ] };
  function seed(db, prefix) {
    ensureSchema(db);
    const jsonColumns = ["aka_json", "rating_better_than_json", "directors_json", "writers_json", "genres_json", "actors_json", "countries_json", "languages_json", "release_dates_json", "durations_json"];
    const values = { status: "ok", category: "fixture", original_title: "Original", official_site: "https://synthetic.invalid/official",
      year: "2026", rating_count: 25, rating_stars_json: '{"5":25}', info_json: '{"来源":"synthetic"}',
      cover_blob: Buffer.from([7, 8]), cover_mime: "image/png", cover_bytes: 2, fetched_at: "same", updated_at: "same",
      detail_source: "synthetic", pubdate: "2026-01-01", imdb_id: "synthetic", summary: "Synthetic description" };
    for (const column of jsonColumns) values[column] = '["synthetic"]';
    const insert = (table, key) => {
      const columns = [key, table === "movie_metadata" ? "movie_title" : "series_name", "douban_title", "rating", "json_ld_json", ...Object.keys(values)];
      const statement = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      return (id, title, rating, jsonLd) => statement.run(id, title, title, rating, jsonLd, ...Object.values(values));
    };
    const movie = insert("movie_metadata", "media_id"), tv = insert("tv_series_metadata", "series_key");
    db.exec("BEGIN");
    try {
      for (let index = 0; index < total; index++) movie(`M${index}`, `${prefix} ${index}`, 10 - index % 10, '{"@type":"Movie"}');
      for (let index = 0; index < 2; index++) tv(`fixture|Show ${index}`, `${prefix} TV ${index}`, 9 - index, '{"@type":"TVSeries"}');
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function createLibrary(metadata) {
    return createImageLibraryService({ cachePreparedQueries: true, maxItemLimit: total, getImageLibraryIndex: () => privateIndex,
      getImageLibraryRevision: () => "same", metadataService: metadata, mangaService: {}, photoSetService: {},
      clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, value === null ? fallback : Number(value))) });
  }
  function fixture(factory) {
    const state = { db: freshDb() }, metrics = { publications: 0, bulkCalls: 0 };
    const metadata = factory({ getImageGalleryDb: () => state.db, createId: (_prefix, key) => key });
    const publicMovie = metadata.publicMovie, movieRowsMap = metadata.movieRowsMap;
    metadata.publicMovie = row => { metrics.publications++; return publicMovie(row); };
    metadata.movieRowsMap = () => { metrics.bulkCalls++; return movieRowsMap(); };
    const library = createLibrary(metadata);
    return { state, metadata, metrics, library, read: (mode = "movie", offset = 0) => library.itemsPayload(request({ mode, sort: "rating", limit: "24", offset: String(offset) })) };
  }
  function comparable(response) { const { listRevision, ...value } = response; return value; }
  function compare(fixture, mode = "movie", offset = 0) {
    const freshMetadata = createGalleryMetadataService({ getImageGalleryDb: () => fixture.state.db, createId: (_prefix, key) => key });
    const freshLibrary = createLibrary(freshMetadata);
    const actual = fixture.read(mode, offset);
    const expected = freshLibrary.itemsPayload(request({ mode, sort: "rating", limit: "24", offset: String(offset) }));
    assert.deepEqual(comparable(actual), comparable(expected), "the complete reopened list response must match a fresh native owner");
    assert.equal(JSON.stringify(comparable(actual)), JSON.stringify(comparable(expected)), "all serialized fields except the private revision realm must match");
    for (const [method, args] of [["movieRowsMap", []], ["tvSeriesRowsMap", []], ["tvSeriesRowsMap", [{ forPublication: true }]]]) {
      const rows = [...fixture.metadata[method](...args)], wanted = [...freshMetadata[method](...args)];
      assert.deepEqual(rows, wanted, "complete movie/TV metadata rows retain their projection contract");
      assert.equal(JSON.stringify(rows), JSON.stringify(wanted));
    }
    oracles++;
    return actual;
  }
  try {
    const previous = fixture(previousFactory), current = fixture(selectedFactory);
    for (const value of [previous, current]) {
      seed(value.state.db, "Before"); value.metadata.tvSeriesRowsMap(); value.metadata.tvSeriesRowsMap({ forPublication: true });
      value.read("movie"); value.read("tv");
    }
    const beforeRevision = current.metadata.listRevision("movie");
    for (const value of [previous, current]) { value.state.db.close(); value.state.db.open(); seed(value.state.db, "Reopened"); }
    assert.equal(current.metadata.movieRowsMap().size, total, "negative control: finalized bulk statements must recover on the reopened native DB");
    const recovered = compare(current);
    assert.equal(recovered.items[0].movieMetadata.title, "Reopened 0", "negative control: a reopened owner must restore movie metadata");
    assert.notEqual(current.metadata.listRevision("movie"), beforeRevision, "reopening advances the native connection identity even if SQLite counters match");
    for (const mode of ["tv", "media"]) compare(current, mode);
    for (const offset of [24, 48, 96]) {
      assert.equal(compare(current, "movie", offset).listRevision, recovered.listRevision, "successful reopened pagination has a stable revision");
    }
    // Prime a movie query after the other oracle modes, then count 33 reads:
    // 31 interleaved timed requests plus two revision-stability probes.
    current.read();
    for (const value of [previous, current]) Object.assign(value.metrics, { publications: 0, bulkCalls: 0 });
    const beforeTimes = [], afterTimes = [];
    const timed = (value, offset, samples) => { const began = performance.now(); value.read("movie", offset); samples.push(performance.now() - began); };
    for (let round = 0; round < 31; round++) {
      if (round % 2) { timed(current, round * 24, afterTimes); timed(previous, round * 24, beforeTimes); }
      else { timed(previous, round * 24, beforeTimes); timed(current, round * 24, afterTimes); }
    }
    const beforeProbe = previous.read(), afterProbe = current.read();
    assert.notEqual(previous.read().listRevision, beforeProbe.listRevision, "the disabled recovery keeps every failed revision uncacheable");
    assert.equal(current.read().listRevision, afterProbe.listRevision);
    assert.equal(previous.metrics.publications, 33 * total);
    assert.equal(previous.metrics.bulkCalls, 33);
    assert.equal(current.metrics.publications, 0, "warm reopened pages must retain their successful query snapshot");
    assert.equal(current.metrics.bulkCalls, 0);
    const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ check: "gallery-native-reopen", rows: total, countedRequests: 33, timedRequests: 31,
      beforeMedianMs: +median(beforeTimes).toFixed(3), afterMedianMs: +median(afterTimes).toFixed(3), before: previous.metrics, after: current.metrics }));
    current.state.db.prepare("UPDATE movie_metadata SET douban_title='Updated movie' WHERE media_id='M0'").run();
    compare(current);
    assert.equal(current.library.itemsPayload(request({ mode: "movie", q: "Updated movie" })).items[0].movieMetadata.title, "Updated movie");
    current.state.db.prepare("UPDATE tv_series_metadata SET douban_title='Updated TV' WHERE series_key='fixture|Show 0'").run();
    compare(current, "tv");
    current.state.db.exec("ALTER TABLE movie_metadata ADD COLUMN fixture_added TEXT DEFAULT 'added'");
    compare(current); assert.equal(current.metadata.movieRowsMap().get("M0").fixture_added, "added");
    const replacement = freshDb(); seed(replacement, "New owner"); current.state.db = replacement;
    assert.equal(compare(current).items[0].movieMetadata.title, "New owner 0"); compare(current, "tv");
    current.state.db.exec("DELETE FROM movie_metadata; DELETE FROM tv_series_metadata");
    compare(current); compare(current, "tv");
    assert.equal(current.metadata.movieRowsMap().size, 0); assert.equal(current.metadata.tvSeriesRowsMap().size, 0);
    const emptyRevision = current.metadata.listRevision(); assert.equal(current.metadata.listRevision(), emptyRevision);
    current.state.db.close();
    const closedRevision = current.metadata.listRevision(); assert.notEqual(current.metadata.listRevision(), closedRevision);
    assert.equal(current.metadata.movieRowsMap().size, 0); assert.equal(current.metadata.tvSeriesRowsMap().size, 0);
    current.state.db.open(); seed(current.state.db, "Second reopen"); compare(current); compare(current, "tv");
    const tvFirst = fixture(selectedFactory);
    seed(tvFirst.state.db, "Before TV");
    tvFirst.metadata.tvSeriesRowsMap(); tvFirst.metadata.tvSeriesRowsMap({ forPublication: true });
    const oldTvRevision = tvFirst.metadata.listRevision("tv");
    tvFirst.state.db.close(); tvFirst.state.db.open(); seed(tvFirst.state.db, "Reopened TV");
    compare(tvFirst, "tv");
    assert.notEqual(tvFirst.metadata.listRevision("tv"), oldTvRevision, "TV-first reads also recover their finalized schema/revision statements");
    // Controlled native/facade/proxy faults prove both retry boundaries and
    // propagation of the second failure without introducing an infinite loop.
    for (const kind of ["ordinary", "native-finalized", "facade-finalized", "proxy-finalized", "closed-finalized"]) {
      const db = freshDb(); let prepareCalls = 0;
      const fault = Object.assign(new Error(`controlled ${kind}`), { code: kind === "ordinary" ? "ERR_SQLITE_ERROR" : "ERR_INVALID_STATE" });
      db.prepare = () => { prepareCalls++; throw fault; };
      if (kind === "closed-finalized") db.close();
      const connection = kind === "facade-finalized" ? { isOpen: true, prepare: db.prepare }
        : kind === "proxy-finalized" ? new Proxy(db, { get(target, key) { return Reflect.get(target, key, target); } }) : db;
      const metadata = createGalleryMetadataService({ getImageGalleryDb: () => connection });
      assert.equal(metadata.movieRowsMap().size, 0);
      assert.equal(prepareCalls, kind === "native-finalized" ? 2 : 1, `${kind}: bulk recovery retries at most once and only for an open native DB`);
      prepareCalls = 0;
      const failedRevision = metadata.listRevision(); assert.equal(JSON.parse(failedRevision)[1], "unavailable");
      assert.equal(prepareCalls, kind === "native-finalized" ? 2 : 1, `${kind}: revision recovery follows the same bounded native rule`);
    }
    console.log(JSON.stringify({ check: "gallery-native-reopen-contract", completeResponseOracles: oracles, nativeReopen: true,
      ownerChange: true, movieAndTvRawAndPublicationRows: true, emptyResults: true, liveWritesAndSchema: true, closedFallback: true,
      ordinaryAndFacadeAndProxyFallback: true, boundedRetry: true }));
  } finally {
    console.warn = originalWarn;
    for (const db of owners) if (db.isOpen) db.close();
  }
}

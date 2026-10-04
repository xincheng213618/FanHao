import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { GALLERY_METADATA_CLOCK_TABLE, GALLERY_METADATA_CLOCK_TRIGGERS } from "../lib/gallery-metadata-revision.js";
import { createGalleryMetadataService } from "../src/modules/media/server/gallery-metadata-service.js";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION, imageLibraryCacheIdentity } from "../src/modules/content-index/server/image-library-index-contract.js";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";

// Current production code versus the previous eager/N+1/grouping algorithms,
// restored in memory. All rows and SQLite state are private synthetic doubles.
const source = fs.readFileSync(new URL("../src/modules/content-index/server/image-library-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
export function previousQuerySource(current) {
  let previous = current;
  const replace = (from, to) => { assert.ok(previous.includes(from), "previous query marker must exist"); previous = previous.replace(from, to); };
  replace('    const sourceStampBefore = listSourceStamp(index, mode);\n    let mangaSourceRevision = "";\n', "");
  replace('      nextOffset: offset + items.length,\n      listRevision: publicListRevision(sourceStampBefore, listSourceStamp(index, mode), mode, mangaSourceRevision),\n', "");
  replace(`      const mangaSourceHash = createHash("sha256");
      source = mangaService.cacheDirs().map((cacheDir) => {
        const item = publicImageLibraryListItem(mangaService.publicSummary(cacheDir), "manga");
        mangaSourceHash.update(JSON.stringify(item)).update("\\0");
        return item;
      });
      mangaSourceRevision = mangaSourceHash.digest("hex");`, '      source = mangaService.cacheDirs().map((cacheDir) => publicImageLibraryListItem(mangaService.publicSummary(cacheDir), "manga"));');
  replace(`    let tvSeries = null;
    if (sourceSeriesKey) {
      if (publicTvSeriesByKey?.has(sourceSeriesKey)) tvSeries = publicTvSeriesByKey.get(sourceSeriesKey);
      else {
        tvSeries = metadataService.publicTvSeries(tvMetadataByKey ? tvMetadataByKey.get(sourceSeriesKey) : metadataService.tvSeriesRow(sourceSeriesKey));
        publicTvSeriesByKey?.set(sourceSeriesKey, tvSeries);
      }
    }`, '    const tvSeries = sourceSeriesKey ? metadataService.publicTvSeries(tvMetadataByKey ? tvMetadataByKey.get(sourceSeriesKey) : metadataService.tvSeriesRow(sourceSeriesKey)) : null;');
  replace('return imageNameCollator.compare(left, right);', 'return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });');
  replace('tvMetadataByKey ? tvMetadataByKey.get(sourceSeriesKey) : metadataService.tvSeriesRow(sourceSeriesKey)', 'tvMetadataByKey?.get(sourceSeriesKey) || metadataService.tvSeriesRow(sourceSeriesKey)');
  replace('movieMetadataById ? movieMetadataById.get(item.id) : metadataService.movieRow(item.id)', 'movieMetadataById?.get(item.id) || metadataService.movieRow(item.id)');
  replace(`      const kinds = mode === "media" ? ["movie", "tv", "anime"] : [mode];
      const rawItems = mediaItemsByKinds(Array.isArray(index.mediaItems) ? index.mediaItems : [], kinds);
      const tvMetadataByKey = rawItems.some((item) => isEpisodicMediaKind(item.mediaKind)) ? metadataService.tvSeriesRowsMap() : new Map();
      const movieMetadataById = rawItems.some((item) => item.mediaKind === "movie") ? metadataService.movieRowsMap() : new Map();
      const publicTvSeriesByKey = new Map();
      mediaItems = rawItems.map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById, publicTvSeriesByKey));`, `      const tvMetadataByKey = metadataService.tvSeriesRowsMap();
      const movieMetadataById = metadataService.movieRowsMap();
      mediaItems = (Array.isArray(index.mediaItems) ? index.mediaItems : []).map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById));`);
  previous = previous.replaceAll('movieMetadataById, publicTvSeriesByKey)', 'movieMetadataById)');
  replace(`      const episodicGroups = tvSeriesGroups(episodicSource);
      const episodicSeriesSource = episodicGroups.map(publicTvSeriesListItem).filter(Boolean);`, '      const episodicSeriesSource = tvSeriesGroups(episodicSource).map(publicTvSeriesListItem).filter(Boolean);');
  previous = previous.replaceAll("episodicGroups.find(", "tvSeriesGroups(episodicSource).find(");
  replace(`        const groups = tvSeriesGroups(mediaSource);
        const tvSeriesSource = groups.map(publicTvSeriesListItem);`, '        const tvSeriesSource = tvSeriesGroups(mediaSource).map(publicTvSeriesListItem);');
  previous = previous.replaceAll("groups.find(", "tvSeriesGroups(mediaSource).find(");
  replace('source = category === "all" ? tvSeriesSource : tvSeriesGroups(categorySource).map(publicTvSeriesListItem);', 'source = tvSeriesGroups(categorySource).map(publicTvSeriesListItem);');
  replace(`      if (item.type === "photo" && item.albumNumber) {
        item = { ...item, albumSubject: photoAlbumSubject(item.title, item, item.collectionTitle) };
      }
`, "");
  replace('normalizedMode === "photo" && (!deferPhotoSubject || !albumNumber) ? photoAlbumSubject', 'normalizedMode === "photo" ? photoAlbumSubject');
  replace('publicImageLibraryListItem(item, "photo", { deferPhotoSubject: true })', 'publicImageLibraryListItem(item, "photo")');
  return previous;
}

function legacyListResponse(response) {
  const { listRevision, nextOffset, ...legacy } = response;
  return legacy;
}

let previousFactory;
try { ({ createImageLibraryService: previousFactory } = await import(`data:text/javascript;base64,${Buffer.from(previousQuerySource(source)).toString("base64")}`)); }
catch (error) { throw new Error(`previous query fixture failed: ${error.message}`); }

const index = {
  scannedAt: "synthetic-first", mediaItems: [
    ...["movie", "tv", "anime", "western"].flatMap((mediaKind) => Array.from({ length: 24 }, (_, i) => ({
      id: `${mediaKind}-${i}`, mediaKind, title: `${mediaKind} 第 ${i} 集`, category: i % 2 ? "境内" : "海外",
      seriesName: `系列 ${i % 4}`, personName: mediaKind === "western" ? `人物 ${i % 3}` : `系列 ${i % 4}`,
      subCategory: "folder", rootLabel: "fixture", size: i + 1, playable: i % 5 !== 0, updatedAt: `2026-10-${String(i % 20 + 1).padStart(2, "0")}`
    })))
  ],
  photoSets: Array.from({ length: 48 }, (_, i) => ({ id: `photo-${i}`,
    title: i % 3 ? `[分类]2026.07.01 VOL.${i} 编号主题 Person ${i % 5} [12P 3MB]` : `2026.07.01 无编号主题 ${i}`,
    personName: i % 3 ? ` Person ${i % 5} ` : `无编号主题 ${i}`,
    category: i % 2 ? "分类" : "其它", subCategory: i % 7 ? "文件夹" : "Person 1", relativePath: i % 2 ? `合集/文件夹/album-${i}.zip` : `album-${i}.zip`,
    sourceRoot: "T:\\[合成图库]", rootLabel: "[合成图库]", size: i + 1, imageCount: i, updatedAt: `2026-10-${String(i % 20 + 1).padStart(2, "0")}`
  }))
};
let currentIndex = index;
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE movie_metadata(media_id TEXT PRIMARY KEY,status TEXT,douban_title TEXT,year TEXT,rating REAL,cover_blob BLOB,updated_at TEXT,genres_json TEXT,info_json TEXT,episode_count INTEGER);
CREATE TABLE tv_series_metadata(series_key TEXT PRIMARY KEY,status TEXT,douban_id TEXT,douban_title TEXT,rating REAL,cover_blob BLOB,updated_at TEXT,genres_json TEXT);`);
db.prepare("INSERT INTO movie_metadata VALUES(?,?,?,?,?,?,?,?,?,?)").run("movie-0", "ok", "电影别名", "2026", 4.5, null, "old", '["fixture"]', '{}', null);
db.prepare("INSERT INTO movie_metadata VALUES(?,?,?,?,?,?,?,?,?,?)").run("movie-1", "ok", "误识别电视剧", "2025", 8, null, "old", '[]', '{}', 8);
for (const category of ["境内", "海外"]) db.prepare("INSERT INTO tv_series_metadata VALUES(?,?,?,?,?,?,?,?)").run(`${category}|系列 0`, "ok", "123456", "可信剧集", 8, null, "old", '[]');
let bulk = 0, point = 0;
const countedDb = { prepare(sql) {
  const statement = db.prepare(sql);
  const metadataQuery = /^SELECT\b/iu.test(sql) && /\b(?:movie_metadata|tv_series_metadata)\b/iu.test(sql);
  return {
    all(...args) { if (metadataQuery) bulk++; return statement.all(...args); },
    get(...args) { if (metadataQuery) point++; return statement.get(...args); }
  };
} };
const metadata = createGalleryMetadataService({ createId: (_prefix, key) => key, getImageGalleryDb: () => countedDb, notFound: () => {} });
const deps = {
  getImageLibraryIndex: () => currentIndex, maxItemLimit: 12000,
  clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback)),
  galleryMediaRootStatuses: () => [], photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}),
  photoSetService: { coverUrl: (id) => `/cover/${id}` }, photoCollectionRootValue: "__root__",
  mangaService: { cacheDirs: () => [], publicSummary: (item) => item, rootStatus: () => ({}) }, metadataService: metadata
};
const current = createImageLibraryService(deps), previous = previousFactory(deps);
const url = (query) => new URL(`http://fixture/api/image-library/items?${query}`);
const countedSource = source.replace("  function tvSeriesGroups(items = []) {", "  function tvSeriesGroups(items = []) { globalThis.__imageQueryGroupCalls++;");
const { createImageLibraryService: countedFactory } = await import(`data:text/javascript;base64,${Buffer.from(countedSource).toString("base64")}`);
const counted = countedFactory(deps);
for (const [query, expected] of [["mode=media", 1], ["mode=media&seriesKey=海外%7C系列%200", 1], ["mode=tv", 1], ["mode=tv&person=系列%200", 1], ["mode=tv&category=海外", 2]]) {
  globalThis.__imageQueryGroupCalls = 0;
  counted.itemsPayload(url(query));
  assert.equal(globalThis.__imageQueryGroupCalls, expected, "same-request grouping reuse preserves filtered regrouping when required");
}
delete globalThis.__imageQueryGroupCalls;
let compared = 0;
for (const mode of ["photo", "movie", "tv", "media", "western", "anime", "manga"]) {
  for (const extra of ["", "sort=title", "sort=size", "sort=rating", "sort=year", "category=海外", "person=系列%200", "seriesKey=海外%7C系列%200", "kind=anime", "q=系列", "offset=3", "photoView=collections", "q=编号主题", "date=2026-07", "person=Person%201", "tvView=episodes"]) {
    const query = `mode=${mode}&limit=5&${extra}`;
    const actual = current.itemsPayload(url(query));
    assert.equal(JSON.stringify(legacyListResponse(actual)), JSON.stringify(previous.itemsPayload(url(query))), query);
    compared++;
  }
}
for (const [mode, expectedBulk] of [["photo", 0], ["western", 0], ["movie", 1], ["tv", 1], ["media", 2]]) {
  bulk = 0; point = 0; current.itemsPayload(url(`mode=${mode}&limit=5`));
  assert.equal(bulk, expectedBulk, `${mode} queries only relevant metadata kinds`);
  assert.equal(point, 0, `${mode} known snapshot misses never cause per-item SQL`);
}
point = 0;
assert.equal(current.publicGalleryMediaItem(index.mediaItems[0]).movieMetadata.title, "电影别名");
assert.equal(point, 1, "standalone detail projection retains its individual lookup contract");
db.prepare("UPDATE movie_metadata SET douban_title='新标题',rating=9,updated_at='new' WHERE media_id='movie-0'").run();
assert.ok(current.itemsPayload(url("mode=movie&q=新标题")).items.some((item) => item.title.includes("新标题")), "metadata changes are visible without changing index identity");
currentIndex = { ...index, scannedAt: "synthetic-next", photoSets: [{ ...index.photoSets[1], title: "VOL.42 新相册主题" }] };
assert.equal(JSON.stringify(legacyListResponse(current.itemsPayload(url("mode=photo")))), JSON.stringify(previous.itemsPayload(url("mode=photo"))), "new photo source invalidates projection and search/sort caches");
db.close();
verifyTvPublicationSnapshots();
verifyImagePaginationContract();

let lookupIndex = { mediaItems: [{ id: "duplicate", title: "first" }, { id: "duplicate", title: "second" }, { id: 123, title: "numeric" }] };
const service = createGalleryMediaService({ getImageLibraryIndex: () => lookupIndex });
assert.equal(service.byId("duplicate"), lookupIndex.mediaItems[0], "find's first duplicate wins");
assert.equal(service.byId("123"), null, "raw ID type equality matches the previous strict find");
lookupIndex.mediaItems[0].relativePath = "changed-source.mp4";
assert.equal(service.byId("duplicate").relativePath, "changed-source.mp4", "lookup retains live raw source references for cover fencing");
lookupIndex.mediaItems = [{ id: "replacement", title: "same index, new array" }];
assert.equal(service.byId("duplicate"), null); assert.equal(service.byId("replacement"), lookupIndex.mediaItems[0]);
lookupIndex = { mediaItems: [{ id: "replacement", title: "new index" }] };
assert.equal(service.byId("replacement").title, "new index");
assert.equal(service.byId(""), null);

// Restore only the previous bulk SELECT * for a real body-copy negative.
// Publication and point-cover code remain the actual current implementation.
let metadataFactory = createGalleryMetadataService;
if (process.argv.includes("--legacy-metadata-blob")) {
  let oldMetadata = fs.readFileSync(new URL("../src/modules/media/server/gallery-metadata-service.js", import.meta.url), "utf8");
  oldMetadata = oldMetadata.replace('"../../../../lib/gallery-metadata-revision.js"',
    JSON.stringify(new URL("../lib/gallery-metadata-revision.js", import.meta.url).href));
  for (const [table, key, method] of [["movie_metadata", "media_id", "movieRowsMap"], ["tv_series_metadata", "series_key", "tvSeriesRowsMap"]]) {
    const marker = `return metadataRowsMap("${table}", "${key}");`;
    assert.ok(oldMetadata.includes(marker), `${method} bulk replacement exists`);
    oldMetadata = oldMetadata.replace(marker, `const rows = getImageGalleryDb().prepare("SELECT * FROM ${table}").all(); return new Map(rows.map(row => [row.${key}, row]));`);
  }
  ({ createGalleryMetadataService: metadataFactory } = await import(`data:text/javascript;base64,${Buffer.from(oldMetadata).toString("base64")}`));
}

function metadataFor(getDb, factory = metadataFactory) {
  return factory({ createId: (_prefix, key) => key, getImageGalleryDb: getDb, notFound: res => { res.status = 404; } });
}

function observedDb(database) {
  const counters = { bulk: 0, point: 0, blobBytes: 0, columns: 0 };
  const owner = { prepare(sql) {
    const statement = database.prepare(sql);
    const metadataQuery = /^SELECT\b/iu.test(sql) && /\b(?:movie_metadata|tv_series_metadata)\b/iu.test(sql);
    return {
      all(...args) {
        const rows = statement.all(...args);
        if (/^PRAGMA table_info\b/iu.test(sql)) counters.columns++;
        if (metadataQuery) {
          counters.bulk++;
          counters.blobBytes += rows.reduce((bytes, row) => bytes + (row.cover_blob instanceof Uint8Array ? row.cover_blob.byteLength : 0), 0);
        }
        return rows;
      },
      get(...args) { if (metadataQuery) counters.point++; return statement.get(...args); }
    };
  } };
  return { owner, counters };
}

let metadataGroups = 0;
function metadataGroup(name, run) {
  run();
  metadataGroups++;
  console.log(`metadata-projection: PASS ${name}`);
}

const wideDbService = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir: () => {} });
const wideDb = wideDbService.getDb();
try {
  const cover = Buffer.alloc(64 * 1024, 0x5a);
  const insertMovie = wideDb.prepare("INSERT INTO movie_metadata(media_id,movie_title,douban_title,status,cover_blob,updated_at,year,rating,genres_json,episode_count) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const insertTv = wideDb.prepare("INSERT INTO tv_series_metadata(series_key,series_name,douban_title,douban_id,status,cover_blob,updated_at,year,rating,genres_json) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const wideIndex = { scannedAt: "wide-private", photoSets: [], mediaItems: [] };
  for (let i = 0; i < 160; i++) {
    insertMovie.run(`wide-movie-${i}`, `电影 ${i}`, `元数据 ${i}`, i > 0 && i % 11 === 0 ? "error" : "ok", i === 0 ? Buffer.alloc(0) : i === 1 ? null : cover, "2026-10-04", "2026", i % 10, '["synthetic"]', i === 2 ? 8 : null);
    wideIndex.mediaItems.push({ id: `wide-movie-${i}`, mediaKind: "movie", title: `电影 ${i}`, category: i % 2 ? "境内" : "海外", size: i + 1, updatedAt: "2026-10-04" });
  }
  for (let i = 0; i < 40; i++) {
    const category = i % 2 ? "境内" : "海外";
    const seriesName = `剧集 ${i}`;
    insertTv.run(`${category}|${seriesName}`, seriesName, `剧集元数据 ${i}`, String(100000 + i), "ok", cover, "2026-10-04", "2026", i % 10, '[]');
    for (let episode = 0; episode < 3; episode++) wideIndex.mediaItems.push({ id: `wide-tv-${i}-${episode}`, mediaKind: "tv", title: `${seriesName} ${episode}`, category, seriesName, size: episode + 1, updatedAt: "2026-10-04" });
  }
  const observed = observedDb(wideDb);
  const narrow = metadataFor(() => observed.owner);
  const fullRows = metadataFor(() => wideDb, createGalleryMetadataService);
  const oldBulk = {
    ...fullRows,
    movieRowsMap: () => new Map(wideDb.prepare("SELECT * FROM movie_metadata").all().map(row => [row.media_id, row])),
    tvSeriesRowsMap: () => new Map(wideDb.prepare("SELECT * FROM tv_series_metadata").all().map(row => [row.series_key, row]))
  };
  const narrowLibrary = createImageLibraryService({ ...deps, metadataService: narrow, getImageLibraryIndex: () => wideIndex });
  const oldLibrary = createImageLibraryService({ ...deps, metadataService: oldBulk, getImageLibraryIndex: () => wideIndex });
  metadataGroup("wide bulk rows omit cover bodies; paging bytes match SELECT *", () => {
    const queries = ["mode=media", "mode=movie&sort=rating", "mode=movie&sort=year&offset=7", "mode=tv&sort=title", "mode=tv&tvView=episodes&offset=3", "mode=media&q=元数据", "mode=media&category=海外"];
    for (const query of queries) assert.equal(JSON.stringify(legacyListResponse(narrowLibrary.itemsPayload(url(`${query}&limit=5`)))), JSON.stringify(legacyListResponse(oldLibrary.itemsPayload(url(`${query}&limit=5`)))), `wide list ${query}`);
    observed.counters.bulk = 0; observed.counters.point = 0; observed.counters.blobBytes = 0;
    const elapsed = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      narrowLibrary.itemsPayload(url(`mode=media&limit=5&offset=${i}`));
      elapsed.push(performance.now() - start);
    }
    assert.equal(observed.counters.bulk, 20, "each page keeps one bulk execution per relevant kind");
    assert.equal(observed.counters.point, 0, "wide lists keep the no-N+1 contract");
    assert.equal(observed.counters.blobBytes, 0, "bulk metadata rows must not copy cover BLOB bodies into JS");
    assert.equal(observed.counters.columns, 2, "warm pages reuse column projections for this unchanged schema");
    console.log(`metadata-projection: private 200 rows/64 KiB covers; 10 pages copied ${observed.counters.blobBytes} cover bytes; median ${elapsed.sort((a, b) => a - b)[5].toFixed(2)} ms (diagnostic)`);
  });
  metadataGroup("point rows and cover endpoints retain complete bodies", () => {
    assert.deepEqual(narrow.movieRow("wide-movie-3"), wideDb.prepare("SELECT * FROM movie_metadata WHERE media_id=?").get("wide-movie-3"));
    assert.deepEqual(narrow.tvSeriesRow("海外|剧集 0"), wideDb.prepare("SELECT * FROM tv_series_metadata WHERE series_key=?").get("海外|剧集 0"));
    for (const [method, id, expected] of [["serveMovieCover", "wide-movie-3", cover], ["serveMovieCover", "wide-movie-0", Buffer.alloc(0)], ["serveTvSeriesCover", "海外|剧集 0", cover]]) {
      const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
      narrow[method](response, id);
      assert.equal(response.status, 200);
      assert.equal(response.headers["Content-Length"], expected.length);
      assert.deepEqual(response.body, expected);
    }
  });
  metadataGroup("actual SQLite cover value truthiness matches raw public DTOs", () => {
    const values = [["null", "NULL"], ["empty-blob", "x''"], ["blob", "x'4142'"], ["empty-text", "''"], ["text", "'AB'"], ["leading-NUL-text", "CAST(x'0041' AS TEXT)"], ["embedded-NUL-text", "CAST(x'410042' AS TEXT)"], ["integer-zero", "0"], ["integer-positive", "2"], ["integer-negative", "-2"], ["real-zero", "CAST(0 AS REAL)"], ["real-positive", "CAST(0.5 AS REAL)"]];
    for (const [label, expression] of values) {
      wideDb.prepare(`INSERT INTO movie_metadata(media_id,movie_title,status,cover_blob,updated_at) VALUES(?,'type','ok',${expression},'type-version')`).run(`type-${label}`);
      wideDb.prepare(`INSERT INTO tv_series_metadata(series_key,series_name,status,cover_blob,updated_at) VALUES(?,'type','ok',${expression},'type-version')`).run(`type-${label}`);
    }
    const movies = narrow.movieRowsMap(), series = narrow.tvSeriesRowsMap();
    for (const [label] of values) {
      for (const [map, pointRow, publish, table, key] of [[movies, narrow.movieRow, narrow.publicMovie, "movie_metadata", "media_id"], [series, narrow.tvSeriesRow, narrow.publicTvSeries, "tv_series_metadata", "series_key"]]) {
        const raw = wideDb.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(`type-${label}`), projected = map.get(`type-${label}`);
        assert.equal(JSON.stringify(publish(projected)), JSON.stringify(publish(raw)), `${label} actual SQLite public DTO bytes`);
        assert.equal(Boolean(projected.cover_blob), Boolean(raw.cover_blob), `${label} preserves Node SQLite truthiness`);
        assert.ok(!(projected.cover_blob instanceof Uint8Array), `${label} bulk rows contain no BLOB object`);
        assert.deepEqual(pointRow(`type-${label}`), raw, `${label} point rows preserve original SQLite value`);
      }
    }
  });
} finally { wideDbService.close(); }

const smallDb = new DatabaseSync(":memory:");
smallDb.exec(`CREATE TABLE movie_metadata(media_id TEXT PRIMARY KEY,status TEXT,douban_title TEXT,"extra""field" TEXT);
CREATE TABLE tv_series_metadata(series_key TEXT PRIMARY KEY,status TEXT,douban_title TEXT);
INSERT INTO movie_metadata VALUES('small','ok','small title','extra value');
INSERT INTO tv_series_metadata VALUES('small','ok','small series');`);
const smallObserved = observedDb(smallDb);
let activeDb = smallObserved.owner;
const changing = metadataFor(() => activeDb);
try {
  metadataGroup("small schemas and quoted extra columns stay compatible", () => {
    assert.deepEqual(changing.movieRowsMap().get("small"), smallDb.prepare("SELECT * FROM movie_metadata").get());
    assert.deepEqual(changing.tvSeriesRowsMap().get("small"), smallDb.prepare("SELECT * FROM tv_series_metadata").get());
    assert.equal(changing.movieRowsMap().get("small")['extra"field'], "extra value");
    assert.equal(smallObserved.counters.columns, 2, "missing cover columns need no invented schema");
  });
  metadataGroup("schema versions refresh projections; row updates stay fresh", () => {
    smallDb.exec("ALTER TABLE movie_metadata ADD COLUMN cover_blob BLOB; ALTER TABLE movie_metadata ADD COLUMN rating REAL;");
    smallDb.prepare("UPDATE movie_metadata SET cover_blob=x'',rating=9,douban_title='fresh title' WHERE media_id='small'").run();
    const first = changing.movieRowsMap().get("small");
    assert.equal(first.cover_blob, 1); assert.equal(first.rating, 9);
    assert.equal(changing.publicMovie(first).title, "fresh title");
    const columnsAfterAlter = smallObserved.counters.columns;
    smallDb.exec("UPDATE movie_metadata SET douban_title='fresh without schema',cover_blob=NULL WHERE media_id='small'");
    const updated = changing.movieRowsMap().get("small");
    assert.equal(updated.douban_title, "fresh without schema"); assert.equal(updated.cover_blob, null);
    assert.equal(smallObserved.counters.columns, columnsAfterAlter, "data updates do not rerun schema discovery");
    smallDb.exec("DROP TABLE movie_metadata; CREATE TABLE movie_metadata(media_id TEXT PRIMARY KEY,status TEXT,douban_title TEXT,cover_blob BLOB,replacement TEXT); INSERT INTO movie_metadata VALUES('small','ok','replacement',x'41','new column');");
    const replacement = changing.movieRowsMap().get("small");
    assert.equal(replacement.replacement, "new column"); assert.equal(replacement.cover_blob, 1);
    assert.equal(Object.hasOwn(replacement, "rating"), false, "drop/recreate removes obsolete projection fields");
  });
  metadataGroup("replacement connections own their separate column cache", () => {
    const replacementDb = new DatabaseSync(":memory:");
    try {
      replacementDb.exec("CREATE TABLE movie_metadata(media_id TEXT PRIMARY KEY,status TEXT,douban_title TEXT,cover_blob BLOB,connection_extra TEXT); INSERT INTO movie_metadata VALUES('replacement','ok','new connection',x'42','fresh');");
      const replacementObserved = observedDb(replacementDb);
      activeDb = replacementObserved.owner;
      smallDb.close();
      const row = changing.movieRowsMap().get("replacement");
      assert.equal(row.connection_extra, "fresh"); assert.equal(row.cover_blob, 1);
      assert.equal(changing.movieRowsMap().size, 1);
      assert.equal(replacementObserved.counters.columns, 1, "new DB schema inspected once and reused");
    } finally { replacementDb.close(); }
  });
} finally { if (smallDb.isOpen) smallDb.close(); }

console.log(`image-query-correctness: ok (${compared} byte-equivalent queries, ${metadataGroups} metadata projection groups/12 SQLite cover types, numbered/unnumbered subjects/facets/search, metadata freshness/SQL bounds, raw ID lookup and source replacement)`);

function verifyTvPublicationSnapshots() {
  const privateDbService = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir: () => {} });
  const privateDb = privateDbService.getDb();
  const createId = (prefix, key) => `${prefix}:${key}`;
  const sources = [
    { name: "Show S01E01", category: "合成分类", kind: "tv", rating: 9, title: "可信系列" },
    { name: "Show S01E02", category: "合成分类", kind: "tv", rating: 7, title: "可信系列" },
    { name: "Missing", category: "合成分类", kind: "tv", missing: true },
    { name: "Invalid", category: "合成分类", kind: "tv", invalid: true },
    { name: "Animation", category: "合成分类", kind: "anime", rating: 8, title: "合成动漫" }
  ];
  const privateIndex = { scannedAt: "synthetic-publication", photoSets: [], mediaItems: [] };
  const sourceKey = source => createId("tvs", `${source.kind === "anime" ? "动漫:" : ""}${source.category}|${source.name}`);
  const jsonColumns = ["aka_json", "rating_stars_json", "rating_better_than_json", "directors_json", "writers_json", "genres_json", "actors_json", "countries_json", "languages_json", "release_dates_json", "durations_json", "info_json"];
  const columns = ["series_key", "series_name", "category", "douban_title", "douban_id", "rating", "year", "status", "updated_at", ...jsonColumns];
  const insert = privateDb.prepare(`INSERT INTO tv_series_metadata(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
  for (const source of sources) {
    if (!source.missing) insert.run(sourceKey(source), source.name, source.category, source.title || source.name, "123456", source.rating || 0, "2026", source.invalid ? "error" : "ok", "synthetic-version",
      ...jsonColumns.map(column => column === "info_json" || column === "rating_stars_json" ? '{"说明":"合成"}' : '["合成"]'));
    for (let episode = 0; episode < 24; episode += 1) privateIndex.mediaItems.push({ id: `${source.kind}-${source.name}-${episode}`, mediaKind: source.kind,
      title: `${source.name} Episode ${episode}`, seriesName: source.name, personName: source.name, category: source.category, rootLabel: "synthetic", size: episode + 1, playable: true, updatedAt: "2026-10-05" });
  }
  let publications = 0;
  let emptyPublications = 0;
  let parses = 0;
  const originalParse = JSON.parse;
  const rawMetadata = createGalleryMetadataService({ createId, getImageGalleryDb: () => privateDb, notFound: () => {} });
  const measuredMetadata = { ...rawMetadata, publicTvSeries(row) { publications += 1; if (!row || row.status !== "ok") emptyPublications += 1; return rawMetadata.publicTvSeries(row); } };
  const privateDeps = { ...deps, getImageLibraryIndex: () => privateIndex, metadataService: measuredMetadata };
  const optimized = createImageLibraryService(privateDeps);
  const legacy = previousFactory(privateDeps);
  const read = (service, query) => {
    publications = 0; emptyPublications = 0; parses = 0;
    JSON.parse = (...args) => { parses += 1; return originalParse(...args); };
    try {
      const response = query === null ? service.payload() : service.itemsPayload(url(query));
      return { response, publications, emptyPublications, parses };
    } finally { JSON.parse = originalParse; }
  };
  try {
    const queries = ["mode=tv", "mode=tv&tvView=episodes", "mode=tv&sort=title&offset=3", "mode=tv&sort=rating", "mode=tv&sort=year", "mode=tv&person=Show%20S01E01", "mode=tv&q=可信", "mode=media", "mode=media&kind=anime", "mode=media&q=可信", null];
    for (const query of queries) {
      const actual = read(optimized, query);
      const expected = read(legacy, query);
      assert.equal(JSON.stringify(legacyListResponse(actual.response)), JSON.stringify(legacyListResponse(expected.response)), `${query || "full payload"} old per-episode publication response bytes`);
    }
    const actual = read(optimized, "mode=media");
    const expected = read(legacy, "mode=media");
    assert.equal(actual.publications, 5, "each request publishes every source key once, including missing/error nulls");
    assert.equal(actual.emptyPublications, 2);
    assert.equal(actual.parses, 36);
    assert.equal(expected.publications, 120, "restored old query actually republishes each episode");
    assert.equal(expected.emptyPublications, 48);
    assert.equal(expected.parses, 864);
    assert.ok(expected.publications > actual.publications, "the old algorithm violates the bounded publication work guarantee");
    const full = read(optimized, null);
    assert.equal(full.publications, 5, "full payload also owns one request cache");
    const shared = full.response.mediaItems.filter(item => item.seriesName.startsWith("Show"));
    assert.equal(new Set(shared.map(item => item.seriesKey)).size, 1, "trusted identity still merges these two local episode names");
    assert.deepEqual([...new Set(shared.map(item => item.tvSeries.rating))], [9, 7], "distinct source keys cannot share a DTO merely because their final trusted series key is equal");
    const another = read(optimized, "mode=media");
    assert.equal(another.publications, 5, "no publication result survives into a second request");

    privateDb.prepare("UPDATE tv_series_metadata SET douban_title=?,rating=? WHERE series_key=?").run("下一请求新标题", 6, sourceKey(sources[0]));
    privateDb.prepare("UPDATE tv_series_metadata SET status='ok' WHERE series_key=?").run(sourceKey(sources[3]));
    insert.run(sourceKey(sources[2]), sources[2].name, sources[2].category, "新补充元数据", "654321", 5, "2026", "ok", "next-version", ...jsonColumns.map(() => '[]'));
    const fresh = read(optimized, null);
    assert.equal(fresh.publications, 5);
    assert.equal(fresh.emptyPublications, 0, "a prior missing/error result is not retained across requests");
    assert.equal(fresh.response.mediaItems[0].tvSeries.title, "下一请求新标题");
    assert.equal(fresh.response.mediaItems[0].tvSeries.rating, 6);
    assert.equal(JSON.stringify(fresh.response), JSON.stringify(read(legacy, null).response));

    const rawItem = privateIndex.mediaItems[0];
    const single = optimized.publicGalleryMediaItem(rawItem);
    privateDb.prepare("UPDATE tv_series_metadata SET douban_title=? WHERE series_key=?").run("单项新标题", sourceKey(sources[0]));
    assert.equal(optimized.publicGalleryMediaItem(rawItem).tvSeries.title, "单项新标题", "standalone publication still reads the latest individual row");
    assert.notEqual(single.tvSeries.title, "单项新标题");
    const rawMap = rawMetadata.tvSeriesRowsMap();
    const firstSingle = optimized.publicGalleryMediaItem(rawItem, rawMap, new Map());
    firstSingle.tvSeries.title = "调用方修改";
    assert.equal(optimized.publicGalleryMediaItem(rawItem, rawMap, new Map()).tvSeries.title, "单项新标题", "caller-provided rows do not gain an implicit value cache");
    rawMap.get(sourceKey(sources[0])).douban_title = "调用方更新原始行";
    assert.equal(optimized.publicGalleryMediaItem(rawItem, rawMap, new Map()).tvSeries.title, "调用方更新原始行");
    console.log(`tv-publication: private 120 episodes/5 source keys; old/current DTO calls=${expected.publications}/${actual.publications}, JSON parses=${expected.parses}/${actual.parses}; ${queries.length} byte-equivalent responses, missing/error freshness, trusted grouping and standalone detail preserved`);
  } finally { JSON.parse = originalParse; privateDbService.close(); }
}

function verifyImagePaginationContract() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-image-pagination-"));
  const temporaryReal = fs.realpathSync(temporary);
  const directories = [];
  const handles = new Set();
  let mangaProbeSql = null;
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (...args) { handles.add(this); mangaProbeSql?.push(args[0]); return originalPrepare.apply(this, args); };
  const owned = value => path.resolve(value).startsWith(temporaryReal + path.sep);
  const mkdir = name => { const directory = path.join(temporary, name); assert.ok(owned(directory)); fs.mkdirSync(directory); directories.push(directory); return directory; };
  const writeJson = (file, value) => { assert.ok(owned(file)); fs.writeFileSync(file, JSON.stringify(value)); };
  const request = (service, query) => {
    const response = service.itemsPayload(url(query));
    assert.match(response.listRevision, /^[0-9a-f]{64}$/u, "opaque revisions contain no source path");
    assert.equal(response.nextOffset, response.offset + response.items.length, "the cursor advances by raw returned rows");
    assert.equal(response.count, response.items.length);
    return response;
  };
  const ids = response => response.items.map(item => item.id);
  try {
    const indexPath = path.join(temporary, "index.json");
    const indexOptions = {
      archiveExts: new Set([".zip"]), directVideoExts: new Set([".mp4"]), galleryMediaSources: [], photoSetRoots: [], videoExts: new Set([".mp4"]),
      createId: (_prefix, value) => value, ensureDataDir() {}, imageLibraryIndexPath: indexPath,
      isExcludedDirName: () => false, isVideo: () => false, normalizeExt: value => path.extname(value).toLowerCase(), photoSetCoverUrl: id => `/cover/${id}`,
      readJsonFile(file, fallback) { try { assert.ok(owned(file)); return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } },
      safeStat(file) { assert.ok(owned(file)); try { return fs.statSync(file); } catch { return null; } }
    };
    let persisted = { schemaVersion: CURRENT_INDEX_SCHEMA, parserVersion: PARSER_VERSION, cacheIdentity: imageLibraryCacheIdentity(indexOptions), scannedAt: "same-scan-time",
      photoSets: Array.from({ length: 100 }, (_, index) => ({ id: `I${index + 1}`, title: `相册 ${index + 1}`, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - index)).toISOString(), size: 1 })), mediaItems: [] };
    writeJson(indexPath, persisted);
    const indexOwner = createImageLibraryIndexService(indexOptions);
    let indexReads = 0;
    const indexDeps = { ...deps, getImageLibraryIndex: options => { indexReads += 1; return indexOwner.getIndex(options); }, getImageLibraryRevision: indexOwner.listRevision };
    const photoLibrary = createImageLibraryService(indexDeps);
    const first = request(photoLibrary, "mode=photo&limit=24");
    assert.deepEqual(ids(first), Array.from({ length: 24 }, (_, index) => `I${index + 1}`));
    const second = request(photoLibrary, `mode=photo&limit=24&offset=${first.nextOffset}`);
    assert.equal(second.listRevision, first.listRevision, "the initial cache publication is captured before reading the page");
    assert.deepEqual(ids(second), Array.from({ length: 24 }, (_, index) => `I${index + 25}`));
    assert.equal(indexReads, 2, "ending revision checks must not fetch or rescan the index");
    persisted = { ...persisted, photoSets: persisted.photoSets.map(item => item.id === "I24" ? { ...item, updatedAt: "2020-01-01" } : item) };
    writeJson(indexPath, persisted); indexOwner.invalidate();
    const movedPage = request(photoLibrary, "mode=photo&limit=24&offset=24");
    assert.notEqual(movedPage.listRevision, first.listRevision, "same-count/same-scannedAt index replacement changes the revision");
    assert.ok(![...ids(first), ...ids(movedPage)].includes("I25"), "the actual service reproduces the old offset omission before a client reload");
    const prefix = request(photoLibrary, "mode=photo&limit=48");
    assert.equal(prefix.listRevision, movedPage.listRevision);
    assert.ok(ids(prefix).includes("I25"), "reloading the requested prefix restores the displaced record");
    assert.equal(new Set(ids(prefix)).size, 48);
    assert.equal(JSON.stringify(legacyListResponse(prefix)), JSON.stringify(previousFactory(indexDeps).itemsPayload(url("mode=photo&limit=48"))), "all old prefix fields retain their response bytes");
    const eof = request(photoLibrary, "mode=photo&offset=10000&limit=24");
    assert.equal(eof.nextOffset, 10000); assert.equal(eof.count, 0); assert.equal(eof.listRevision, prefix.listRevision);
    assert.equal(request(photoLibrary, "mode=photo&limit=50000").limit, 12000, "production item limits stay compatible");
    const refresh = request(photoLibrary, "mode=photo&limit=24");
    indexOwner.getIndex({ refresh: true });
    assert.notEqual(request(photoLibrary, "mode=photo&limit=24").listRevision, refresh.listRevision, "an actual rescan publishes a new epoch even for equal empty scans");
    writeJson(indexPath, persisted); indexOwner.invalidate();

    const galleryPath = path.join(temporary, "gallery.sqlite");
    const gallery = createImageGalleryDbService({ dbPath: galleryPath, ensureDataDir() {} });
    const reader = gallery.getDb();
    const insertMovie = reader.prepare("INSERT INTO movie_metadata(media_id,movie_title,douban_title,rating,status,updated_at) VALUES(?,?,?,?,?,?)");
    for (let index = 0; index < 100; index += 1) insertMovie.run(`M${index}`, `电影 ${index}`, `元数据 ${index}`, 100 - index, "ok", "same-time");
    const insertSeries = reader.prepare("INSERT INTO tv_series_metadata(series_key,category,series_name,douban_title,rating,status,updated_at) VALUES(?,?,?,?,?,?,?)");
    for (let index = 0; index < 100; index += 1) insertSeries.run(`fixture|剧集 ${index}`, "fixture", `剧集 ${index}`, `剧集元数据 ${index}`, 100 - index, "ok", "same-time");
    const movieIndex = { scannedAt: "same-media-time", photoSets: [], mediaItems: [
      ...Array.from({ length: 100 }, (_, index) => ({ id: `M${index}`, mediaKind: "movie", title: `电影 ${index}`, updatedAt: "same-time", size: 1 })),
      ...Array.from({ length: 100 }, (_, index) => ({ id: `T${index}`, mediaKind: "tv", category: "fixture", seriesName: `剧集 ${index}`, title: `剧集 ${index} 第 1 集`, updatedAt: "same-time", size: 1 }))
    ] };
    let activeReader = reader;
    let insideRevision = false;
    let probeReads = 0, probePrepares = 0, revisionCalls = 0, revisionAllReads = 0;
    let failProbes = false;
    const observed = new WeakMap();
    const observedReader = () => {
      if (!observed.has(activeReader)) observed.set(activeReader, { prepare(sql) {
        if (insideRevision) probePrepares += 1;
        const statement = activeReader.prepare(sql);
        return { get(...args) { if (insideRevision) { probeReads += 1; if (failProbes) throw new Error("controlled revision probe failure"); } return statement.get(...args); },
          all(...args) { if (insideRevision) revisionAllReads += 1; return statement.all(...args); } };
      } });
      return observed.get(activeReader);
    };
    const actualMetadata = createGalleryMetadataService({ createId: (_prefix, key) => key, getImageGalleryDb: observedReader, notFound() {} });
    let duringPublication = null;
    const measuredMetadata = { ...actualMetadata,
      listRevision(mode) { revisionCalls += 1; insideRevision = true; try { return actualMetadata.listRevision(mode); } finally { insideRevision = false; } },
      publicMovie(row) { const action = duringPublication; duringPublication = null; action?.(); return actualMetadata.publicMovie(row); }
    };
    const movieDeps = { ...deps, metadataService: measuredMetadata, getImageLibraryIndex: () => movieIndex };
    const movieLibrary = createImageLibraryService(movieDeps);
    const movieFirst = request(movieLibrary, "mode=movie&sort=rating&limit=24");
    const movieSecond = request(movieLibrary, "mode=movie&sort=rating&limit=24&offset=24");
    assert.equal(movieSecond.listRevision, movieFirst.listRevision);
    assert.equal(revisionCalls, 4); assert.equal(probeReads, 8); assert.equal(probePrepares, 3); assert.equal(revisionAllReads, 1, "the schema contract is checked once per connection/schema");
    probeReads = 0; probePrepares = 0; revisionAllReads = 0;
    const stableMetadata = actualMetadata.listRevision("movie");
    for (let index = 0; index < 10; index += 1) assert.equal(measuredMetadata.listRevision("movie"), stableMetadata);
    assert.equal(probeReads, 20); assert.equal(probePrepares, 0, "warm scalar/PK probes reuse their statements");
    assert.equal(revisionAllReads, 0, "warm revision getters cannot scan metadata or schema rows");
    probeReads = 0;
    for (let index = 0; index < 10; index += 1) measuredMetadata.listRevision("media");
    assert.equal(probeReads, 30, "the combined channel reads two fixed PK clocks plus schema");
    assert.equal(revisionAllReads, 0);
    const writer = new DatabaseSync(galleryPath);
    const stableChannels = new Map(["movie", "tv", "media"].map(mode => [mode, request(movieLibrary, `mode=${mode}&limit=24`)]));
    const coverWrite = (db, id) => db.prepare("INSERT INTO gallery_media_covers(media_id,source_path,cover_blob,updated_at) VALUES(?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET cover_blob=excluded.cover_blob")
      .run(id, "private-synthetic.mp4", Buffer.from([1, 2, 3]), "same-time");
    coverWrite(reader, "same-connection-cover"); coverWrite(writer, "external-cover");
    reader.prepare("INSERT INTO photo_set_covers(album_id,archive_path,updated_at) VALUES('synthetic-photo','private.zip','same-time')").run();
    writer.prepare("INSERT INTO photo_set_image_indexes(archive_path,images_json,updated_at) VALUES('private.zip','[]','same-time')").run();
    for (const [mode, before] of stableChannels) {
      const after = request(movieLibrary, `mode=${mode}&limit=24`);
      assert.equal(after.listRevision, before.listRevision, `${mode} ignores local/external cover and image-index cache commits`);
      assert.equal(JSON.stringify(legacyListResponse(after)), JSON.stringify(legacyListResponse(before)));
    }
    duringPublication = () => coverWrite(writer, "during-read-cover");
    const coverRace = request(movieLibrary, "mode=movie&limit=24");
    assert.equal(coverRace.listRevision, stableChannels.get("movie").listRevision, "an irrelevant cover commit during publication also permits stable append");
    const movieBeforeTv = request(movieLibrary, "mode=movie&limit=24");
    const tvBeforeTv = request(movieLibrary, "mode=tv&limit=24");
    const mediaBeforeTv = request(movieLibrary, "mode=media&limit=24");
    writer.prepare("UPDATE tv_series_metadata SET rating=1 WHERE series_key='fixture|剧集 0'").run();
    assert.equal(request(movieLibrary, "mode=movie&limit=24").listRevision, movieBeforeTv.listRevision, "movie pages ignore TV-only commits");
    assert.notEqual(request(movieLibrary, "mode=tv&limit=24").listRevision, tvBeforeTv.listRevision);
    assert.notEqual(request(movieLibrary, "mode=media&limit=24").listRevision, mediaBeforeTv.listRevision);
    const rollbackBefore = request(movieLibrary, "mode=movie&limit=24");
    reader.exec("BEGIN");
    try { reader.prepare("UPDATE movie_metadata SET rating=0 WHERE media_id='M0'").run(); }
    finally { reader.exec("ROLLBACK"); }
    assert.equal(request(movieLibrary, "mode=movie&limit=24").listRevision, rollbackBefore.listRevision, "same-connection rollback does not advance committed table clocks");
    const tvBeforeMovie = request(movieLibrary, "mode=tv&limit=24");
    reader.prepare("UPDATE movie_metadata SET rating=0 WHERE media_id='M23'").run();
    const localMoved = request(movieLibrary, "mode=movie&sort=rating&limit=24&offset=24");
    assert.notEqual(localMoved.listRevision, movieFirst.listRevision, "same-connection writes are detected without timestamp changes");
    assert.ok(![...ids(movieFirst), ...ids(localMoved)].includes("M24"));
    assert.ok(ids(request(movieLibrary, "mode=movie&sort=rating&limit=48")).includes("M24"));
    assert.equal(request(movieLibrary, "mode=tv&limit=24").listRevision, tvBeforeMovie.listRevision, "TV pages ignore movie-only commits");
    const photoStable = request(photoLibrary, "mode=photo&limit=24").listRevision;
    const externalBefore = request(movieLibrary, "mode=movie&sort=title&limit=24");
    writer.prepare("UPDATE movie_metadata SET douban_title='外部新标题' WHERE media_id='M0'").run();
    const externalAfter = request(movieLibrary, "mode=movie&sort=title&limit=24");
    assert.notEqual(externalAfter.listRevision, externalBefore.listRevision);
    assert.ok(request(movieLibrary, "mode=movie&q=外部新标题").items.some(item => item.id === "M0"));
    assert.equal(request(photoLibrary, "mode=photo&limit=24").listRevision, photoStable, "gallery metadata/cover changes do not invalidate photo pages");
    writer.exec("BEGIN IMMEDIATE");
    try {
      writer.prepare("UPDATE movie_metadata SET douban_title='尚未提交' WHERE media_id='M0'").run();
      const held = request(movieLibrary, "mode=movie&sort=title&limit=24");
      assert.equal(held.listRevision, externalAfter.listRevision, "a held WAL writer does not change the reader's committed source");
      assert.equal(JSON.stringify(legacyListResponse(held)), JSON.stringify(legacyListResponse(externalAfter)));
    } finally { writer.exec("ROLLBACK"); }
    const schemaBefore = request(movieLibrary, "mode=movie&sort=title");
    reader.exec('ALTER TABLE movie_metadata ADD COLUMN "pagination fixture" TEXT');
    const schemaAfter = request(movieLibrary, "mode=movie&sort=title");
    assert.notEqual(schemaAfter.listRevision, schemaBefore.listRevision);
    assert.equal(JSON.stringify(legacyListResponse(schemaAfter)), JSON.stringify(legacyListResponse(schemaBefore)), "schema revisions retain every legacy field");
    const raceBefore = request(movieLibrary, "mode=movie&q=外部新标题");
    duringPublication = () => writer.prepare("UPDATE movie_metadata SET douban_title='竞争后标题' WHERE media_id='M0'").run();
    const raced = request(movieLibrary, "mode=movie&q=外部新标题");
    const raceAfter = request(movieLibrary, "mode=movie&q=竞争后标题");
    assert.equal(ids(raced)[0], "M0", "the returned page actually used the earlier bulk rows");
    assert.notEqual(raced.listRevision, raceBefore.listRevision); assert.notEqual(raced.listRevision, raceAfter.listRevision);
    assert.equal(request(movieLibrary, "mode=movie&q=竞争后标题").listRevision, raceAfter.listRevision, "stable reads following a race share their actual new source version");
    duringPublication = () => writer.prepare("UPDATE movie_metadata SET rating=1 WHERE media_id='M1'").run();
    const secondRace = request(movieLibrary, "mode=movie");
    assert.notEqual(secondRace.listRevision, raced.listRevision, "every unstable page receives a one-time token");
    failProbes = true;
    const unavailable = request(movieLibrary, "mode=movie");
    assert.notEqual(request(movieLibrary, "mode=movie").listRevision, unavailable.listRevision, "failed probes cannot authorize stable appends");
    failProbes = false;

    const updateTrigger = GALLERY_METADATA_CLOCK_TRIGGERS.find(trigger => trigger.kind === "movie" && trigger.name.endsWith("_update"));
    const intactClock = request(movieLibrary, "mode=movie&limit=24");
    writer.exec(`DROP TRIGGER ${updateTrigger.name}`);
    const droppedTrigger = request(movieLibrary, "mode=movie&limit=24");
    assert.notEqual(droppedTrigger.listRevision, intactClock.listRevision);
    const droppedMedia = request(movieLibrary, "mode=media&limit=24");
    const droppedTv = request(movieLibrary, "mode=tv&limit=24");
    coverWrite(reader, "fallback-local-cover");
    assert.notEqual(request(movieLibrary, "mode=movie&limit=24").listRevision, droppedTrigger.listRevision, "only a channel with incomplete triggers returns to conservative local-change detection");
    assert.notEqual(request(movieLibrary, "mode=media&limit=24").listRevision, droppedMedia.listRevision, "mixed media also falls back if either required clock is untrusted");
    assert.equal(request(movieLibrary, "mode=tv&limit=24").listRevision, droppedTv.listRevision, "an incomplete movie trigger cannot disable the independent trusted TV clock");
    writer.prepare("UPDATE movie_metadata SET douban_title='缺触发器更新' WHERE media_id='M0'").run();
    assert.notEqual(request(movieLibrary, "mode=movie&limit=24").listRevision, droppedTrigger.listRevision, "missing triggers fall back to actual external commit detection");
    writer.exec(`CREATE TRIGGER ${updateTrigger.name} AFTER UPDATE ON movie_metadata BEGIN SELECT 1; END`);
    const noOpTrigger = request(movieLibrary, "mode=movie&limit=24");
    const noOpMedia = request(movieLibrary, "mode=media&limit=24");
    const noOpTv = request(movieLibrary, "mode=tv&limit=24");
    coverWrite(writer, "fallback-external-cover");
    assert.notEqual(request(movieLibrary, "mode=movie&limit=24").listRevision, noOpTrigger.listRevision);
    assert.notEqual(request(movieLibrary, "mode=media&limit=24").listRevision, noOpMedia.listRevision);
    assert.equal(request(movieLibrary, "mode=tv&limit=24").listRevision, noOpTv.listRevision, "same-name no-op movie triggers leave TV reads on their valid clock");
    const clockRead = () => reader.prepare(`SELECT epoch, revision FROM ${GALLERY_METADATA_CLOCK_TABLE} WHERE kind='movie'`).get();
    const inertClock = clockRead();
    writer.prepare("UPDATE movie_metadata SET douban_title='同名无效触发器更新' WHERE media_id='M0'").run();
    assert.deepEqual(clockRead(), inertClock, "the negative control really leaves the table clock unchanged");
    assert.notEqual(request(movieLibrary, "mode=movie&limit=24").listRevision, noOpTrigger.listRevision, "same-name no-op trigger SQL must not authorize the fast path");
    writer.exec(`DROP TRIGGER ${updateTrigger.name}`); writer.exec(updateTrigger.sql);
    const restoredClock = request(movieLibrary, "mode=movie&limit=24");
    const tvBeforeClockDelete = request(movieLibrary, "mode=tv&limit=24");
    writer.prepare(`DELETE FROM ${GALLERY_METADATA_CLOCK_TABLE} WHERE kind='movie'`).run();
    const missingClock = request(movieLibrary, "mode=movie&limit=24");
    assert.notEqual(missingClock.listRevision, restoredClock.listRevision);
    writer.prepare("UPDATE movie_metadata SET douban_title='缺时钟行更新' WHERE media_id='M0'").run();
    assert.notEqual(request(movieLibrary, "mode=movie&limit=24").listRevision, missingClock.listRevision, "a missing clock row uses the old conservative probes");
    assert.equal(request(movieLibrary, "mode=tv&limit=24").listRevision, tvBeforeClockDelete.listRevision, "the surviving TV clock remains independently trustworthy");

    const equalA = new DatabaseSync(":memory:"), equalB = new DatabaseSync(":memory:");
    const equalSql = "CREATE TABLE identical(value TEXT); INSERT INTO identical VALUES('same')";
    equalA.exec(equalSql); equalB.exec(equalSql);
    activeReader = equalA; const sameCountersA = actualMetadata.listRevision();
    activeReader = equalB; const sameCountersB = actualMetadata.listRevision();
    assert.notEqual(sameCountersA, sameCountersB, "distinct connections have distinct identities even with equal schema/data/total-change counters");
    activeReader = reader;
    const replacementPath = path.join(temporary, "replacement.sqlite");
    const replacement = createImageGalleryDbService({ dbPath: replacementPath, ensureDataDir() {} });
    replacement.getDb().prepare("INSERT INTO movie_metadata(media_id,movie_title,douban_title,status,updated_at) VALUES('M0','替库电影','替库新标题','ok','same-time')").run();
    replacement.close(); writer.close(); gallery.close();
    assert.ok(owned(replacementPath) && owned(galleryPath));
    fs.renameSync(galleryPath, path.join(temporary, "previous.sqlite"));
    fs.renameSync(replacementPath, galleryPath);
    activeReader = gallery.getDb();
    const replaced = request(movieLibrary, "mode=movie&q=替库新标题");
    assert.notEqual(replaced.listRevision, raceAfter.listRevision); assert.deepEqual(ids(replaced), ["M0"]);
    gallery.close();

    const duplicateLibrary = createImageLibraryService({ ...deps, getImageLibraryIndex: () => ({ photoSets: [], mediaItems: [] }),
      mangaService: { ...deps.mangaService, cacheDirs: () => [{ id: "same", title: "第一条" }, { id: "same", title: "第二条" }] } });
    const duplicates = request(duplicateLibrary, "mode=manga&limit=2");
    assert.equal(duplicates.nextOffset, 2); assert.equal(new Set(ids(duplicates)).size, 1, "duplicate IDs never rewind the raw cursor");

    const mangaRoot = mkdir("manga");
    const mangaDirectory = path.join(mangaRoot, "smtt6_cache_fixture"); fs.mkdirSync(mangaDirectory); directories.push(mangaDirectory);
    const catalogPath = path.join(mangaDirectory, "catalog.json"), manifestPath = path.join(mangaDirectory, "manifest.json");
    writeJson(catalogPath, { title: "原始漫画", url: "https://synthetic.invalid/manga", updated_at: "same-time" });
    writeJson(manifestPath, { created_at: "same-time", chapters: [] });
    const mangaOptions = { root: mangaRoot, databasePath: path.join(temporary, "absent-manga.sqlite"),
      mimeTypes: {}, normalizeExt: value => path.extname(value), notFound() {}, spawnProcess() { assert.fail("pagination must not start a collector"); },
      safeStat(file) { assert.ok(owned(file)); try { return fs.statSync(file); } catch { return null; } }, serveArchiveMemberImage() { assert.fail("pagination must not open media"); } };
    const mangaOwner = createMangaService(mangaOptions);
    const mangaLibrary = createImageLibraryService({ ...indexDeps, mangaService: mangaOwner });
    const mangaFirst = request(mangaLibrary, "mode=manga");
    assert.equal(request(mangaLibrary, "mode=manga").listRevision, mangaFirst.listRevision, "fresh cacheDirs arrays do not create false revision changes");
    const mangaOwnerBefore = mangaOwner.listRevision();
    writeJson(catalogPath, { title: "文件内新漫画", url: "https://synthetic.invalid/manga", updated_at: "same-time" });
    assert.equal(mangaOwner.listRevision(), mangaOwnerBefore, "the control proves a file rewrite need not change the fixed root/DB stamp");
    const mangaChanged = request(mangaLibrary, "mode=manga");
    assert.notEqual(mangaChanged.listRevision, mangaFirst.listRevision); assert.equal(mangaChanged.items[0].title, "文件内新漫画");
    writeJson(manifestPath, { created_at: "same-time", chapters: [{ index: 1, image_count: 7, downloaded_count: 3, status: "done" }] });
    const manifestChanged = request(mangaLibrary, "mode=manga");
    assert.notEqual(manifestChanged.listRevision, mangaChanged.listRevision); assert.equal(manifestChanged.items[0].imageCount, 7);
    assert.equal(JSON.stringify(legacyListResponse(manifestChanged)), JSON.stringify(previousFactory({ ...indexDeps, mangaService: mangaOwner }).itemsPayload(url("mode=manga"))), "manga revisions preserve actual file-derived legacy responses");
    let mangaChangedDuringRead = false;
    const mangaRaceLibrary = createImageLibraryService({ ...indexDeps, mangaService: { ...mangaOwner, publicSummary(directory) {
      const item = mangaOwner.publicSummary(directory);
      if (!mangaChangedDuringRead) { mangaChangedDuringRead = true; indexOwner.invalidate(); }
      return item;
    } } });
    const mangaRace = request(mangaRaceLibrary, "mode=manga");
    assert.notEqual(request(mangaRaceLibrary, "mode=manga").listRevision, mangaRace.listRevision, "source invalidation during manga publication yields an unstable token");
    const collectorSource = fs.readFileSync(new URL("./manga_collector.py", import.meta.url), "utf8");
    const mangaSchema = /    schema = """([\s\S]*?)    """/u.exec(collectorSource)?.[1];
    assert.ok(mangaSchema?.includes("CREATE TABLE IF NOT EXISTS manga_comics"));
    const mangaDbPath = path.join(temporary, "manga-collector.sqlite");
    const mangaWriter = new DatabaseSync(mangaDbPath); mangaWriter.exec("PRAGMA journal_mode=WAL"); mangaWriter.exec(mangaSchema);
    mangaWriter.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url,updated_at) VALUES(?,?,?,?,?,?)")
      .run(mangaDirectory, path.basename(mangaDirectory), "synthetic", "SQL漫画", "https://synthetic.invalid/manga", "same-time");
    const sqlMangaOwner = createMangaService({ ...mangaOptions, databasePath: mangaDbPath });
    const sqlMangaLibrary = createImageLibraryService({ ...indexDeps, mangaService: sqlMangaOwner });
    const sqlMangaFirst = request(sqlMangaLibrary, "mode=manga");
    assert.equal(sqlMangaFirst.items[0].title, "SQL漫画");
    assert.equal(request(sqlMangaLibrary, "mode=manga").listRevision, sqlMangaFirst.listRevision);
    const sqlMangaStamp = sqlMangaOwner.listRevision();
    mangaProbeSql = [];
    for (let index = 0; index < 10; index += 1) assert.equal(sqlMangaOwner.listRevision(), sqlMangaStamp);
    assert.deepEqual(mangaProbeSql, Array.from({ length: 10 }, () => "PRAGMA data_version"), "warm manga owner probes cannot traverse directories or scan the comic catalog");
    mangaProbeSql = null;
    mangaWriter.prepare("UPDATE manga_comics SET title='SQL外部新漫画' WHERE cache_key=?").run(mangaDirectory);
    const sqlMangaChanged = request(sqlMangaLibrary, "mode=manga");
    assert.notEqual(sqlMangaChanged.listRevision, sqlMangaFirst.listRevision); assert.equal(sqlMangaChanged.items[0].title, "SQL外部新漫画");
    mangaWriter.exec("BEGIN IMMEDIATE");
    try {
      mangaWriter.prepare("UPDATE manga_comics SET title='SQL未提交漫画' WHERE cache_key=?").run(mangaDirectory);
      assert.equal(request(sqlMangaLibrary, "mode=manga").listRevision, sqlMangaChanged.listRevision, "the actual collector WAL writer preserves the reader's committed manga version");
    } finally { mangaWriter.exec("ROLLBACK"); }
    let sqlMangaRacePending = true;
    const sqlMangaRaceLibrary = createImageLibraryService({ ...indexDeps, mangaService: { ...sqlMangaOwner, publicSummary(directory) {
      const item = sqlMangaOwner.publicSummary(directory);
      if (sqlMangaRacePending) { sqlMangaRacePending = false; mangaWriter.prepare("UPDATE manga_comics SET title='SQL竞争后漫画' WHERE cache_key=?").run(mangaDirectory); }
      return item;
    } } });
    const sqlMangaRace = request(sqlMangaRaceLibrary, "mode=manga");
    const sqlMangaAfterRace = request(sqlMangaRaceLibrary, "mode=manga");
    assert.equal(sqlMangaRace.items[0].title, "SQL外部新漫画"); assert.equal(sqlMangaAfterRace.items[0].title, "SQL竞争后漫画");
    assert.notEqual(sqlMangaRace.listRevision, sqlMangaAfterRace.listRevision);
    assert.equal(request(sqlMangaRaceLibrary, "mode=manga").listRevision, sqlMangaAfterRace.listRevision);
    const extraMangaDirectory = path.join(mangaRoot, "smtt6_cache_added"); fs.mkdirSync(extraMangaDirectory); directories.push(extraMangaDirectory);
    writeJson(path.join(extraMangaDirectory, "manifest.json"), { chapters: [] });
    writeJson(path.join(extraMangaDirectory, "catalog.json"), { title: "新增漫画", url: "https://synthetic.invalid/added", updated_at: "same-time" });
    const mangaMembership = request(sqlMangaLibrary, "mode=manga");
    assert.notEqual(mangaMembership.listRevision, sqlMangaChanged.listRevision); assert.equal(mangaMembership.total, 2);
    console.log("image-pagination: PASS actual 100-photo/100-movie/100-TV sources, offset omissions/prefix repair, raw/EOF cursors, 12000 limit, warm movie/TV four and mixed six scalar/PK probes per request; cover/image-index/local rollback stability, channel isolation, WAL held-writer/local/external/schema/connection/file replacement races, removed/no-op triggers and missing-clock fallback, file/SQL-derived manga revisions/membership");
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    for (const handle of handles) { try { handle.close(); } catch {} }
    const resolved = fs.realpathSync(temporary);
    assert.equal(resolved.toLowerCase(), temporaryReal.toLowerCase());
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("fanhao-image-pagination-"));
    // Remove only verified individual files and empty directories; no recursive
    // deletion, real media, database, service or collector participates.
    for (const directory of [...directories].reverse().concat(resolved)) {
      const actual = fs.realpathSync(directory);
      assert.ok(actual === resolved || actual.startsWith(resolved + path.sep));
      assert.equal(actual, path.resolve(directory));
      for (const name of fs.readdirSync(actual)) {
        const file = path.resolve(actual, name); assert.equal(path.dirname(file), actual);
        assert.ok(fs.lstatSync(file).isFile(), "owned child directories must already be empty and removed"); fs.unlinkSync(file);
      }
      fs.rmdirSync(actual);
    }
    assert.equal(fs.existsSync(resolved), false);
  }
}

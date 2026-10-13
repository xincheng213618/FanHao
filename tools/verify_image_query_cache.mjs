import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createGalleryMetadataService } from "../src/modules/media/server/gallery-metadata-service.js";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION, imageLibraryCacheIdentity } from "../src/modules/content-index/server/image-library-index-contract.js";
import { createImageQueryCache, IMAGE_QUERY_CACHE_MAX_BYTES } from "../src/modules/content-index/server/image-query-cache.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

// Private SQLite/WAL and synthetic index only. Refresh scans empty roots and
// writes its index inside this owned temporary directory; no media or server.
verifyCacheBounds();
const temporary = createVerifiedTempDir("fanhao-image-query-cache-");
const dbPath = path.join(temporary.tempDir, "gallery.sqlite");
const storage = createImageGalleryDbService({ dbPath, ensureDataDir() {} });
let writer;
const originalParse = JSON.parse, originalNow = Date.now;
try {
  let metadataFactory = createGalleryMetadataService;
  if (process.argv.includes("--legacy-failure-revision")) {
    let old = fs.readFileSync(new URL("../src/modules/media/server/gallery-metadata-service.js", import.meta.url), "utf8");
    assert.ok(old.includes("clocks, failureEpochs]") && old.includes("data_version, failureEpochs]"));
    old = old.replace("clocks, failureEpochs]", "clocks]").replace("data_version, failureEpochs]", "data_version]")
      .replace('"../../../../lib/gallery-metadata-revision.js"', JSON.stringify(new URL("../lib/gallery-metadata-revision.js", import.meta.url).href));
    ({ createGalleryMetadataService: metadataFactory } = await import(`data:text/javascript;base64,${Buffer.from(old).toString("base64")}`));
  }
  const db = storage.getDb();
  writer = new DatabaseSync(dbPath);
  const insertMovie = db.prepare("INSERT INTO movie_metadata(media_id,movie_title,douban_title,rating,status,updated_at,year,genres_json,info_json,json_ld_json) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const insertTv = db.prepare("INSERT INTO tv_series_metadata(series_key,series_name,douban_title,rating,status,updated_at,year,genres_json) VALUES(?,?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 6000; i += 1) insertMovie.run(`M${i}`, `电影 ${i}`, `元数据电影 ${i}`, 10 - i % 90 / 10, "ok", "same", `${2000 + i % 25}`, '["剧情"]', "{}", "{}");
  for (const kind of ["tv", "anime"]) for (let i = 0; i < 250; i += 1) insertTv.run(`${kind === "anime" ? "动漫:" : ""}cat${i % 5}|剧集 ${i}`, `剧集 ${i}`, `可信剧集 ${i}`, 10 - i % 90 / 10, "ok", "same", `${2000 + i % 25}`, '["剧情"]');
  db.exec("COMMIT");
  const ownerOptions = { archiveExts: new Set([".zip"]), directVideoExts: new Set([".mp4"]), videoExts: [".mp4"], galleryMediaSources: [], photoSetRoots: [] };
  let persisted = { schemaVersion: CURRENT_INDEX_SCHEMA, parserVersion: PARSER_VERSION, cacheIdentity: imageLibraryCacheIdentity(ownerOptions), scannedAt: "same", photoSets: [], mediaItems: [
    ...Array.from({ length: 6000 }, (_, i) => ({ id: `M${i}`, mediaKind: "movie", title: `电影 ${i}`, category: `cat${i % 5}`, size: i + 1, playable: true, updatedAt: `2026-10-${String(i % 25 + 1).padStart(2, "0")}` })),
    ...["tv", "anime"].flatMap(kind => Array.from({ length: 6000 }, (_, i) => ({ id: `${kind}${i}`, mediaKind: kind, title: `第 ${i % 24 + 1} 集`, seriesName: `剧集 ${Math.floor(i / 24)}`, category: `cat${Math.floor(i / 24) % 5}`, size: i + 1, playable: true, updatedAt: "2026-10-04" })))
  ] };
  const owner = createImageLibraryIndexService({ ...ownerOptions, createId: (_prefix, key) => key, ensureDataDir() {},
    imageLibraryIndexPath: path.join(temporary.tempDir, "index.json"), isExcludedDirName: () => false, isVideo: () => false,
    normalizeExt: value => path.extname(value), photoSetCoverUrl: () => "", readJsonFile: () => persisted, safeStat: () => null });
  let counts = freshCounts(), failBulk = false, duringPublication = null, afterProbe = null;
  const observed = new WeakMap();
  const observedDb = () => {
    const active = storage.getDb();
    if (!observed.has(active)) observed.set(active, { prepare(sql) {
      const statement = active.prepare(sql), bulk = /^SELECT\b/iu.test(sql) && /FROM "(?:movie_metadata|tv_series_metadata)"/u.test(sql);
      return { get(...args) { counts.scalar++; return statement.get(...args); }, all(...args) {
        if (bulk && failBulk) { failBulk = false; throw new Error("controlled metadata read failure"); }
        const rows = statement.all(...args); if (bulk) { counts.bulk++; counts.rows += rows.length; } return rows;
      } };
    } });
    return observed.get(active);
  };
  const metadata = metadataFactory({ getImageGalleryDb: observedDb, createId: (_prefix, key) => key, notFound() {} });
  const measuredMetadata = { ...metadata,
    listRevision(mode) { const stamp = metadata.listRevision(mode), action = afterProbe; afterProbe = null; action?.(); return stamp; },
    publicMovie(row) { counts.movies++; const action = duringPublication; duringPublication = null; action?.(); return metadata.publicMovie(row); },
    publicTvSeries(row) { counts.tv++; return metadata.publicTvSeries(row); }
  };
  const deps = { maxItemLimit: 12000, clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback)),
    getImageLibraryIndex: owner.getIndex, getImageLibraryRevision: owner.listRevision, metadataService: measuredMetadata,
    photoSetService: { coverUrl: () => "" }, mangaService: { cacheDirs: () => [], rootStatus: () => ({}) },
    galleryMediaRootStatuses: () => [], photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}) };
  const fresh = createImageLibraryService(deps), cached = createImageLibraryService({ ...deps, cachePreparedQueries: !process.argv.includes("--disable-query-cache") });
  const request = params => new URL(`http://synthetic/items?${new URLSearchParams(params)}`);
  const legacy = response => { const { listRevision, nextOffset, ...old } = response; return JSON.stringify(old); };
  JSON.parse = (...args) => { counts.parses++; return originalParse(...args); };
  for (const params of [{ mode: "movie", sort: "rating" }, { mode: "tv", tvView: "episodes", sort: "title" }, { mode: "media", sort: "updated" }]) {
    const run = service => { counts = freshCounts(); const start = performance.now(); const responses = Array.from({ length: 10 }, (_, page) => service.itemsPayload(request({ ...params, offset: `${page * 48}`, limit: "48" }))); return { responses, counts, elapsed: performance.now() - start }; };
    const before = run(fresh), after = run(cached);
    after.responses.forEach((response, index) => assert.equal(legacy(response), legacy(before.responses[index]), "all old serialized fields retain their order and bytes"));
    assert.equal(after.counts.bulk, params.mode === "media" ? 2 : 1);
    for (const field of ["bulk", "rows", "movies", "tv", "parses"]) assert.equal(before.counts[field], after.counts[field] * 10, `${params.mode}: ${field} work happens once per prepared query`);
    counts = freshCounts(); cached.itemsPayload(request({ ...params, offset: "480", limit: "48" }));
    assert.equal(counts.bulk, 0); assert.equal(counts.movies + counts.tv + counts.parses, 0);
    assert.equal(counts.scalar, params.mode === "media" ? 6 : 4, "warm pages retain only fixed before/after version probes");
    console.log(`query-cache ${params.mode}: 10 pages bulk ${before.counts.bulk}->${after.counts.bulk}, rows ${before.counts.rows}->${after.counts.rows}, JSON.parse ${before.counts.parses}->${after.counts.parses}; ${before.elapsed.toFixed(1)}ms/${after.elapsed.toFixed(1)}ms diagnostic`);
  }
  const matrix = [{ mode: "movie", sort: "year" }, { mode: "movie", q: "电影 12", sort: "title" }, { mode: "movie", category: "cat2", sort: "size" },
    { mode: "tv", sort: "rating" }, { mode: "tv", category: "cat3", sort: "year" }, { mode: "tv", person: "剧集 3", tvView: "episodes" },
    { mode: "media", kind: "anime", sort: "title" }, { mode: "media", category: "cat1", sort: "rating" }, { mode: "media", q: "可信剧集", sort: "title" }, { mode: "media", seriesKey: "cat3|剧集 3", sort: "size" }];
  for (const params of matrix) for (const offset of [0, 48, 10000]) {
    const url = request({ ...params, offset: `${offset}`, limit: "48" }), result = cached.itemsPayload(url);
    assert.equal(legacy(result), legacy(fresh.itemsPayload(url))); assert.equal(result.nextOffset, offset + result.count);
  }
  const url = request({ mode: "movie", sort: "rating", limit: "48" });
  const first = cached.itemsPayload(url);
  const mutated = cached.itemsPayload(url); mutated.items[0].movieMetadata.title = "poison"; mutated.facets.categories[0].value = "poison";
  assert.equal(legacy(cached.itemsPayload(url)), legacy(fresh.itemsPayload(url)));
  counts = freshCounts(); writer.prepare("INSERT INTO gallery_media_covers(media_id,source_path,updated_at) VALUES('cover-only','synthetic.mp4','same')").run();
  assert.equal(cached.itemsPayload(url).listRevision, first.listRevision); assert.equal(counts.bulk, 0);
  writer.prepare("UPDATE tv_series_metadata SET rating=1 WHERE series_key='cat0|剧集 0'").run(); counts = freshCounts();
  assert.equal(cached.itemsPayload(url).listRevision, first.listRevision); assert.equal(counts.bulk, 0, "TV-only changes do not evict a movie plan");
  writer.exec("BEGIN IMMEDIATE");
  try { writer.prepare("UPDATE movie_metadata SET rating=0 WHERE media_id='M0'").run(); assert.equal(cached.itemsPayload(url).listRevision, first.listRevision); }
  finally { writer.exec("ROLLBACK"); }
  writer.prepare("UPDATE movie_metadata SET rating=0 WHERE media_id='M0'").run(); counts = freshCounts();
  const external = cached.itemsPayload(url); assert.notEqual(external.listRevision, first.listRevision); assert.equal(counts.bulk, 1);
  assert.equal(legacy(external), legacy(fresh.itemsPayload(url)));
  const rollback = cached.itemsPayload(url); db.exec("BEGIN"); db.prepare("UPDATE movie_metadata SET rating=0 WHERE media_id='M1'").run(); db.exec("ROLLBACK");
  assert.equal(cached.itemsPayload(url).listRevision, rollback.listRevision);
  counts = freshCounts(); cached.clearPreparedQueries(); cached.itemsPayload(url); assert.equal(counts.bulk, 1);
  const clock = originalNow(); Date.now = () => clock + 30001; counts = freshCounts(); cached.itemsPayload(url); assert.equal(counts.bulk, 1); Date.now = originalNow;
  const oldIndex = cached.itemsPayload(url); persisted = { ...persisted, mediaItems: persisted.mediaItems.map(item => item.id === "M1" ? { ...item, size: 999999 } : item) }; owner.invalidate();
  const replaced = cached.itemsPayload(url); assert.notEqual(replaced.listRevision, oldIndex.listRevision); assert.equal(legacy(replaced), legacy(fresh.itemsPayload(url)));
  const beforeSchema = cached.itemsPayload(url); db.exec("ALTER TABLE movie_metadata ADD COLUMN private_fixture TEXT"); assert.notEqual(cached.itemsPayload(url).listRevision, beforeSchema.listRevision);
  const beforeFailure = cached.itemsPayload(url), tvStamp = metadata.listRevision("tv"); cached.clearPreparedQueries(); failBulk = true;
  const failed = cached.itemsPayload(url); assert.notEqual(failed.listRevision, beforeFailure.listRevision); assert.equal(metadata.listRevision("tv"), tvStamp);
  counts = freshCounts(); const recovered = cached.itemsPayload(url); assert.equal(counts.bulk, 1); assert.notEqual(recovered.listRevision, failed.listRevision);
  assert.notEqual(recovered.listRevision, beforeFailure.listRevision); assert.equal(legacy(recovered), legacy(fresh.itemsPayload(url)));
  counts = freshCounts(); assert.equal(cached.itemsPayload(url).listRevision, recovered.listRevision); assert.equal(counts.bulk, 0);
  afterProbe = () => writer.prepare("UPDATE movie_metadata SET rating=1 WHERE media_id='M2'").run(); counts = freshCounts();
  const warmRace = cached.itemsPayload(url); assert.equal(counts.bulk, 0); assert.notEqual(warmRace.listRevision, recovered.listRevision);
  counts = freshCounts(); const warmAfter = cached.itemsPayload(url); assert.equal(counts.bulk, 1); assert.notEqual(warmRace.listRevision, warmAfter.listRevision);
  cached.clearPreparedQueries(); duringPublication = () => writer.prepare("UPDATE movie_metadata SET rating=2 WHERE media_id='M3'").run();
  const coldRace = cached.itemsPayload(url); counts = freshCounts(); const coldAfter = cached.itemsPayload(url); assert.equal(counts.bulk, 1); assert.notEqual(coldRace.listRevision, coldAfter.listRevision);
  const mutable = { ...persisted, mediaItems: persisted.mediaItems.map(item => ({ ...item })) };
  const legacyCaller = createImageLibraryService({ ...deps, getImageLibraryIndex: () => mutable });
  const sizeUrl = request({ mode: "movie", sort: "size" }); legacyCaller.itemsPayload(sizeUrl); mutable.mediaItems[2].size = 9999999;
  assert.equal(legacyCaller.itemsPayload(sizeUrl).items[0].id, "M2", "a legacy caller without opt-in always rebuilds mutable rows");
  const noOwner = createImageLibraryService({ ...deps, cachePreparedQueries: true, getImageLibraryRevision: null });
  counts = freshCounts(); noOwner.itemsPayload(url); noOwner.itemsPayload(url); assert.equal(counts.bulk, 2);
  counts = freshCounts(); const refresh = cached.itemsPayload(url, { refresh: true }); assert.equal(refresh.total, 0); assert.equal(counts.bulk, 0);
  owner.invalidate(); cached.itemsPayload(url); counts = freshCounts(); cached.itemsPayload(url); assert.equal(counts.bulk, 0);
  const connectionBefore = cached.itemsPayload(url); storage.close(); counts = freshCounts(); const connectionAfter = cached.itemsPayload(url);
  assert.notEqual(connectionAfter.listRevision, connectionBefore.listRevision); assert.equal(counts.bulk, 1); assert.equal(legacy(connectionAfter), legacy(fresh.itemsPayload(url)));
  persisted = { ...persisted, mediaItems: Array.from({ length: 12001 }, (_, i) => ({ id: `overflow-${i}`, mediaKind: "movie", title: `${i}` })) }; owner.invalidate();
  counts = freshCounts(); cached.itemsPayload(url); cached.itemsPayload(url); assert.equal(counts.bulk, 2, "oversized query plans remain uncached");
  console.log("query-cache: PASS 60 byte oracles, fixed warm probes, cover/WAL/rollback, metadata/schema/source/connection invalidation, cold/warm races, failure epochs/recovery, TTL/clear, mutable legacy/no-owner fallback, refresh and oversized bypass");
} finally {
  JSON.parse = originalParse; Date.now = originalNow;
  writer?.close(); storage.close(); temporary.cleanup();
}

function freshCounts() { return { bulk: 0, rows: 0, scalar: 0, movies: 0, tv: 0, parses: 0 }; }

function verifyCacheBounds() {
  let now = 0; const cache = createImageQueryCache({ now: () => now }), plan = { header: {}, items: [{ value: "small" }] };
  assert.equal(cache.set("a", "v", plan), true); assert.strictEqual(cache.get("a", "v"), plan);
  now = 29999; assert.strictEqual(cache.get("a", "v"), plan); now = 30000; assert.equal(cache.get("a", "v"), null);
  cache.set("a", "v", plan); cache.set("b", "v", plan); assert.strictEqual(cache.get("b", "v"), plan); assert.equal(cache.get("a", "v"), null);
  let visits = 0; const oversizedRows = Array.from({ length: 12001 }, () => ({ toJSON() { visits++; return 0; } }));
  assert.equal(cache.set("a", "v", { header: {}, items: oversizedRows }), false); assert.equal(visits, 0);
  const overhead = 32 + 1 + 1 + 2 + Buffer.byteLength(JSON.stringify({ value: "" })) + 1;
  assert.equal(cache.set("a", "v", { header: {}, items: [{ value: "x".repeat(IMAGE_QUERY_CACHE_MAX_BYTES - overhead) }] }), true);
  assert.equal(cache.set("a", "v", { header: {}, items: [{ value: "x".repeat(IMAGE_QUERY_CACHE_MAX_BYTES - overhead + 1) }] }), false);
  const large = "x".repeat(5 * 1024 * 1024); visits = 0;
  assert.equal(cache.set("a", "v", { header: {}, items: Array.from({ length: 5 }, () => ({ toJSON() { visits++; return large; } })) }), false);
  assert.equal(visits, 4, "weight accounting stops before serializing the remainder of a huge plan");
  cache.set("a", "v", plan); cache.clear(); assert.equal(cache.get("a", "v"), null);
  console.log("query-cache budget: PASS one entry, exact 30s/12000 row/16MiB boundaries, per-item accounting and early stop");
}

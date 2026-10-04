import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createGalleryMetadataService } from "../src/modules/media/server/gallery-metadata-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";

// Complete production publication/list/detail/cover services, synthetic records.
// SQLite schema/bulk reads, file stat and HTTP response are private in-memory
// boundaries; no disk DB opens, media reads, network or backfill execution.
const source = fs.readFileSync(new URL("../src/modules/media/server/gallery-metadata-service.js", import.meta.url), "utf8")
  .replace('"../../../../lib/gallery-metadata-revision.js"',
    JSON.stringify(new URL("../lib/gallery-metadata-revision.js", import.meta.url).href));
const tests = [];
const test = (name, run) => tests.push({ name, run });
const rawRow = (overrides = {}) => ({
  media_id: "synthetic-movie", category: "合成分类", movie_title: "合成原始电影 2019", status: "ok",
  douban_id: "1000001", douban_title: "合成电影", year: "2019", rating: 7.4,
  episode_count: null, season_count: null, episode_duration: "", info_json: "{}", json_ld_json: "{}",
  cover_blob: Buffer.from([0xff, 0xd8, 0xff]), cover_mime: "image/jpeg", updated_at: "synthetic-version", ...overrides
});
const infoOnlyConflict = () => rawRow({ douban_title: "合成剧集 第一季", year: "2010", rating: 9.4,
  info_json: JSON.stringify({ 首播: "2010-09-26", 季数: "1", 集数: "7", 单集片长: "50分钟" }) });
function fixture(factory = createGalleryMetadataService, row = rawRow()) {
  const rows = new Map([[row.media_id, row]]), reads = [];
  // Bulk projections run in SQLite, including PRAGMAs and cover presence CASE.
  // Point doubles retain the arbitrary JS values used by publication validation
  // (objects/NaN/Infinity are deliberately tested without persisting them).
  const columns = [...new Set([...Object.keys(row), "media_id", "series_key"])];
  const quote = name => `"${name.replaceAll('"', '""')}"`;
  const withSqlite = run => {
    const privateDb = new DatabaseSync(":memory:");
    try {
      for (const table of ["movie_metadata", "tv_series_metadata"]) privateDb.exec(`CREATE TABLE ${table}(${columns.map(name => quote(name)).join(",")})`);
      return run(privateDb);
    } finally { privateDb.close(); }
  };
  const db = { prepare(sql) {
    const point = /^SELECT \* FROM (?:movie_metadata|tv_series_metadata) WHERE (?:media_id|series_key) = \?$/.test(sql);
    const schema = sql === "PRAGMA schema_version" || /^PRAGMA table_info\("(?:movie_metadata|tv_series_metadata)"\)$/.test(sql);
    const bulk = /^SELECT .+ FROM "?(?:movie_metadata|tv_series_metadata)"?$/.test(sql);
    assert.ok(point || schema || bulk, "Publication boundary must remain read-only metadata/schema queries");
    reads.push(sql);
    return {
      get: id => point ? (sql.includes("movie_metadata") ? rows.get(id) : row) : withSqlite(privateDb => privateDb.prepare(sql).get()),
      all: () => withSqlite(privateDb => {
        if (bulk && sql.includes("movie_metadata")) {
          const insert = privateDb.prepare(`INSERT INTO movie_metadata(${columns.map(quote).join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
          for (const value of rows.values()) insert.run(...columns.map(name => value[name] ?? null));
        }
        return privateDb.prepare(sql).all();
      })
    };
  } };
  const metadata = factory({ createId: (prefix, value) => `${prefix}:${value}`, getImageGalleryDb: () => db,
    notFound: res => { res.status = 404; res.notFound = true; } });
  const raw = { id: row.media_id, type: "media", mediaKind: "movie", title: "合成原始电影 2019", category: "合成分类",
    relativePath: "synthetic-film.mkv", sourceRoot: "synthetic-root", ext: "mkv", updatedAt: "2026-01-01T00:00:00Z", size: 2048 };
  const index = { scannedAt: "synthetic", photoSets: [], mediaItems: [raw] };
  const library = createImageLibraryService({
    clampInteger: (value, fallback, min, max) => { const n = Number.parseInt(value, 10); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback)); },
    galleryMediaRootStatuses: () => [], getImageLibraryIndex: () => index, imageReaderCacheStatus: () => ({}),
    mangaService: { cacheDirs: () => [], publicSummary: value => value }, maxItemLimit: 100,
    metadataService: metadata, photoCollectionRootValue: "synthetic", photoSetRootStatuses: () => [], photoSetService: { coverUrl: () => "" }
  });
  const gallery = createGalleryMediaService({ getImageLibraryIndex: () => index,
    publicGalleryMediaItem: library.publicGalleryMediaItem, playbackProgressService: { getVideoProgress: () => null },
    safeChildPath: () => "synthetic-path.mkv", safeStat: () => ({ isFile: () => true, size: 2048, mtimeMs: 0 }),
    normalizeExt: () => ".mkv" });
  const response = () => ({ status: null, body: null, headers: null, notFound: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } });
  return { metadata, library, gallery, raw, row, reads, response };
}
function rejectRow(factory, overrides) {
  const row = rawRow(overrides), before = structuredClone(row), f = fixture(factory, row);
  assert.equal(f.metadata.publicMovie(row), null, "Known TV metadata must not be published as a movie");
  const res = f.response(); f.metadata.serveMovieCover(res, row.media_id);
  assert.equal(res.status, 404, "Old movie-poster URL must not bypass metadata identity protection");
  assert.equal(res.body, null, "Conflicting poster bytes must not be sent");
  assert.deepEqual(row, { ...before, cover_blob: Buffer.from(before.cover_blob) }, "Conflict must not rewrite/delete the retained source row");
}

test("real-equivalent info-only TV evidence is rejected despite null structured count fields", factory => {
  const row = infoOnlyConflict(); assert.equal(row.episode_count, null); assert.equal(row.season_count, null); assert.equal(row.episode_duration, "");
  rejectRow(factory, row);
});
for (const field of ["episode_count", "season_count"]) test(`positive ${field} blocks movie metadata and poster`, factory => {
  for (const value of [1, 7, "1", "7", "7 集", "共 2 季", "1.0", "7 episodes", "1 episode", "2 SEASONS", "1 season", "共 7.0 episodes"]) rejectRow(factory, { [field]: value });
});
test("positive episode duration blocks movie metadata and poster", factory => {
  for (const value of [50, "50", "50分钟", "约 45 分钟", "30 minutes", "PT50M", "PT1H30M", "00:50:00", "01:00:00"]) rejectRow(factory, { episode_duration: value });
});
for (const field of ["集数", "季数"]) test(`info ${field} independently blocks movie metadata`, factory => {
  rejectRow(factory, { info_json: JSON.stringify({ [field]: "7" }) });
});
test("info single-episode duration independently blocks movie metadata", factory => {
  rejectRow(factory, { info_json: JSON.stringify({ 单集片长: "50分钟" }) });
});
for (const type of ["TVSeries", "TVSeason", "TVEpisode"]) test(`JSON-LD ${type} blocks movie metadata and poster`, factory => {
  for (const json of [{ "@type": type }, { "@type": ["CreativeWork", type] }, [{ "@type": type }],
    { "@graph": [{ "@type": `https://schema.org/${type}` }] }]) rejectRow(factory, { json_ld_json: JSON.stringify(json) });
});
test("valid movie retains title metadata and cover bytes", factory => {
  const f = fixture(factory, rawRow({ json_ld_json: '{"@type":"Movie"}', info_json: JSON.stringify({ 上映日期: "2019", 片长: "122分钟" }) }));
  const result = f.metadata.publicMovie(f.row);
  assert.equal(result.title, "合成电影"); assert.equal(result.year, "2019"); assert.equal(result.rating, 7.4);
  assert.match(result.coverUrl, /^\/media\/movie-cover\/synthetic-movie\?v=/);
  const res = f.response(); f.metadata.serveMovieCover(res, f.row.media_id);
  assert.equal(res.status, 200); assert.deepEqual(res.body, f.row.cover_blob); assert.equal(res.headers["Content-Length"], 3);
});
test("missing fields and invalid zero negative unknown counts do not invent a TV identity", factory => {
  for (const value of [undefined, null, "", 0, -1, "0", "-1", "unknown", "待定", NaN, Infinity, true, false, [], {}, 1.5, "1.5"]) {
    const f = fixture(factory, rawRow({ episode_count: value, season_count: value }));
    assert(f.metadata.publicMovie(f.row), `Invalid count must not classify movie as TV: ${String(value)}`);
  }
  for (const value of [undefined, null, "", "unknown", "待定", "0分钟", "-50分钟", "PT0M", 0, -1, NaN, Infinity, true, false, [], {},
    "00:99:00", "00:00:99", "00:00:00", "unknown 50分钟", "50分钟 unknown", "00:50:00 extra", "9".repeat(310), `${"9".repeat(310)}分钟`, `PT${"9".repeat(310)}H`, `${"9".repeat(310)}:00:00`]) {
    const f = fixture(factory, rawRow({ episode_duration: value }));
    assert(f.metadata.publicMovie(f.row), `Invalid duration must not classify movie as TV: ${String(value)}`);
  }
});
test("invalid info JSON and unrelated JSON-LD remain legacy-compatible", factory => {
  for (const value of [undefined, null, "", "broken-json", "null", "[]", "1", '{"@type":"Movie"}', '{"@type":"TVSeriesExtra"}']) {
    const f = fixture(factory, rawRow({ info_json: value, json_ld_json: value })); assert(f.metadata.publicMovie(f.row));
  }
});
test("title mentioning season and year mismatch alone never changes local classification", factory => {
  const f = fixture(factory, rawRow({ douban_title: "名为第一季的合成电影", movie_title: "合成原始电影 2019", year: "1999", info_json: '{"首播":"1999"}' }));
  assert.equal(f.metadata.publicMovie(f.row).year, "1999");
  assert.equal(f.library.publicGalleryMediaItem(f.raw).mediaKind, "movie");
});
test("actual movie and mixed lists fall back to raw-derived title and frame cover without reclassification", factory => {
  const f = fixture(factory, infoOnlyConflict()), before = structuredClone(f.row);
  for (const mode of ["movie", "media"]) {
    const page = f.library.itemsPayload(new URL(`http://synthetic.invalid/api/image-library/items?mode=${mode}&limit=10`));
    assert.equal(page.items.length, 1); const item = page.items[0];
    assert.equal(item.mediaKind, "movie"); assert.equal(item.type, "movie");
    // Existing list display normalization removes a trailing year even without metadata.
    assert.equal(item.title, "合成原始电影");
    assert.equal(item.movieMetadata, null); assert.equal(item.rating, null); assert.equal(item.year, "");
    assert.match(item.coverUrl, /^\/media\/gallery-media-cover\/synthetic-movie/); assert.equal(page.stats.ratedCount, 0);
  }
  assert.deepEqual(f.row, { ...before, cover_blob: Buffer.from(before.cover_blob) });
});
test("actual gallery detail falls back without losing raw file or existing playback fields", factory => {
  const f = fixture(factory, infoOnlyConflict()), detail = f.gallery.publicDetail(f.raw);
  assert.equal(detail.title, f.raw.title); assert.equal(detail.mediaKind, "movie"); assert.equal(detail.movieMetadata, null);
  assert.equal(detail.exists, true); assert.equal(detail.videos[0].id, f.raw.id); assert.equal(detail.progress, null);
  assert.match(detail.coverUrl, /^\/media\/gallery-media-cover\/synthetic-movie/);
});
test("TV publication and TV poster remain available for the same valid TV metadata", factory => {
  const row = { ...infoOnlyConflict(), series_key: "synthetic-series", series_name: "合成剧集" }, f = fixture(factory, row);
  assert.equal(f.metadata.publicTvSeries(row).title, "合成剧集 第一季");
  const res = f.response(); f.metadata.serveTvSeriesCover(res, row.series_key);
  assert.equal(res.status, 200); assert.deepEqual(res.body, row.cover_blob);
});
test("missing and non-ok movie records preserve existing not-found semantics", factory => {
  const f = fixture(factory, rawRow({ status: "error" }));
  assert.equal(f.metadata.publicMovie(null), null); assert.equal(f.metadata.publicMovie(f.row), null);
  for (const id of [f.row.media_id, "missing"]) { const res = f.response(); f.metadata.serveMovieCover(res, id); assert.equal(res.status, 404); }
});

const controls = [
  { name: "public movie guard disconnected", target: "actual movie and mixed lists", mutate: text => text.replace('row.status !== "ok" || movieMetadataHasTvEvidence(row)', 'row.status !== "ok"') },
  { name: "old poster URL bypasses identity guard", target: "real-equivalent info-only", mutate: text => text.replace("if (movieMetadataHasTvEvidence(row)) {", "if (false) {") },
  { name: "info-only evidence ignored", target: "real-equivalent info-only", mutate: text => text.replace('const info = safeJsonObject(row.info_json);', 'const info = {};') }
];
let passed = 0, failed = 0, rejected = 0;
for (const item of tests) { try { item.run(createGalleryMetadataService); passed++; console.log(`PASS ${item.name}`); } catch (error) { failed++; console.error(`FAIL ${item.name}\n${error.stack}`); } }
if (!failed) for (const control of controls) {
  try {
    const changed = control.mutate(source); assert.notEqual(changed, source, `No-op control ${control.name}`);
    const module = await import(`data:text/javascript;base64,${Buffer.from(changed).toString("base64")}`);
    let failure; try { tests.find(item => item.name.startsWith(control.target)).run(module.createGalleryMetadataService); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Control must fail a safety assertion, not runtime: ${control.name}: ${failure?.stack || "unexpected pass"}`);
    rejected++; console.log(`REJECT ${control.name}`);
  } catch (error) { failed++; console.error(`FAIL control ${control.name}\n${error.stack}`); }
}
console.log(`Media metadata identity: ${passed}/${tests.length} scenarios; ${rejected}/${controls.length} safety controls; ${failed} failures.`);
process.exitCode = failed ? 1 : 0;

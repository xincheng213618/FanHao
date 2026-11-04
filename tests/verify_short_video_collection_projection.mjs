import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createShortVideoPublicVideoMapper } from "../src/modules/short-videos/server/public-video-mapper.js";
import { createShortVideoCollectionsRepository as currentFactory } from "../src/modules/short-videos/server/collections-repository.js";

const args = process.argv.slice(2);
assert(args.every(arg => arg === "--disable-projection"), "known arguments");
const root = new URL("../src/modules/short-videos/server/", import.meta.url);
const repositoryPath = "src/modules/short-videos/server/collections-repository.js";
// A complete, fixed repository owner is the oracle. It does not advance when
// HEAD or the production SELECT builder changes; mapper/schema stay real.
const baselineCommit = "63c5fab243233e142cfd62c4eaf13812feb92405";
const baselineSource = execFileSync("git", ["show", `${baselineCommit}:${repositoryPath}`], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8"
}).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(baselineSource).digest("hex"),
  "e86754e4274eca56d46e79858231cbe2c468d5fdcb6a5b320e0f11bc24fc141b");
const absoluteImports = source => source.replace(/from\s+"(\.{1,2}\/[^\"]+)"/g,
  (_match, relative) => `from ${JSON.stringify(new URL(relative, root).href)}`);
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const beforeFactory = (await import(dataUrl(absoluteImports(baselineSource)))).createShortVideoCollectionsRepository;
const testedFactory = args.includes("--disable-projection") ? await projectionDisabledFactory() : currentFactory;
const storeSource = fs.readFileSync(new URL("store.js", root), "utf8").replace(/\r\n/g, "\n");
// These exact, independent store dependencies run the actual resolver and
// tolerant JSON parser, including its Uint8Array coercion for old BLOB values.
const kernels = Object.fromEntries(["clampInt", "optionalInteger", "parseJsonArray", "parseJsonObject", "videoCatalogRowByAnyId"]
  .map(name => [name, new Function(`return (${functionSource(storeSource, name)});`)()]));
const schema = actualSchema();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-collection-projection-"));
const dbPath = path.join(tempRoot, "fixture.sqlite");
const db = new DatabaseSync(dbPath);
let comparisons = 0;
let errorComparisons = 0;

try {
  installSchema(db);
  const before = repository(beforeFactory);
  const actual = repository(testedFactory);
  verifyMetadata(before, actual);
  verifyMalformedMedia(before, actual);
  verifyPaging(before, actual);
  verifySchemaChanges(before, actual);
  verifySchemaProbeFailures(before);
  verifyFailures(before, actual);
  verifyWalSnapshot();
  const scale = verifyScale(before, actual);
  console.log(JSON.stringify({ fixture: "short-video-collection-projection", comparisons, errorComparisons, scale }, null, 2));
} finally {
  db.close();
  // Only the private, named fixture files can be removed; never walk a library.
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(tempRoot);
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} owner exists`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end < 0 ? source.length : end).trim();
}

async function projectionDisabledFactory() {
  const source = absoluteImports(fs.readFileSync(new URL("collections-repository.js", root), "utf8").replace(/\r\n/g, "\n"));
  const original = `import { collectionVideoProjections } from ${JSON.stringify(new URL("collection-video-projection.js", root).href)};`;
  const disabled = 'const collectionVideoProjections = () => ({ video: "video.*", candidate: "candidate.*", catalog: "*" });';
  assert.equal(source.split(original).length, 2, "one actual projection owner boundary");
  const controlled = source.replace(original, disabled);
  assert.equal(controlled.replace(disabled, original), source, "control only disables collection and resolver metadata projection");
  return (await import(dataUrl(controlled))).createShortVideoCollectionsRepository;
}

function actualSchema() {
  const prepare = DatabaseSync.prototype.prepare;
  let opened;
  DatabaseSync.prototype.prepare = function(sql) { opened = this; return prepare.call(this, sql); };
  const coverPath = path.join(os.tmpdir(), `fanhao-collection-unopened-${crypto.randomUUID()}.sqlite`);
  const store = createShortVideoStore({ dbPath: ":memory:", coverDbPath: coverPath, roots: [], skipStartupMaintenance: true });
  try {
    store.prepareSchema();
    assert(opened instanceof DatabaseSync);
    assert(!fs.existsSync(coverPath), "cover storage and real services stay unopened");
    return prepare.call(opened, "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").all();
  } finally { DatabaseSync.prototype.prepare = prepare; store.close(); }
}

function installSchema(database) {
  const retained = row => !row.name.startsWith("sqlite_") && !row.name.startsWith("short_video_search_");
  for (const row of schema.filter(row => row.type === "table" && retained(row))) database.exec(row.sql);
  for (const row of schema.filter(row => row.type === "index" && retained(row))) database.exec(row.sql);
  for (const row of schema.filter(row => row.type === "view")) database.exec(row.sql);
  // Ingestion/search-index triggers are not exercised by collection reads.
  // Historical malformed JSON/BLOB rows must remain representable here.
  database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=777");
}

function emptyMetrics() { return { returnedMetadataBytes: 0, parsedMetadataBytes: 0, returnedMetadataRows: 0, parsedMetadataRows: 0, reads: 0, businessReads: 0, schemaProbes: 0, columnInspections: 0 }; }
function byteLength(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value instanceof Uint8Array ? value.byteLength : 0;
}

function repository(factory, hooks = {}) {
  let metrics = emptyMetrics();
  let failure = null;
  let resultOverride = null;
  const observed = new Proxy(db, {
    get(target, key) {
      if (key !== "prepare") {
        const member = target[key];
        return typeof member === "function" ? member.bind(target) : member;
      }
      return sql => {
        fail("prepare", sql);
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(owner, method) {
            const member = owner[method];
            if (!["get", "all"].includes(method) || typeof member !== "function") return typeof member === "function" ? member.bind(owner) : member;
            return (...values) => {
              fail(method, sql);
              // Native column metadata catches SELECT alias.*, compact AS
              // metadata_json, whose duplicate object key would otherwise
              // conceal the original wide value from a row-byte counter.
              assert(owner.columns().filter(column => column.name === "metadata_json").length <= 1,
                "one physical metadata_json result column per row");
              let result = member.apply(owner, values);
              if (resultOverride?.phase === method && resultOverride.predicate(sql)) {
                const transform = resultOverride.transform;
                resultOverride = null;
                result = transform(result);
              }
              metrics.reads++;
              if (/^\s*PRAGMA\b/i.test(sql)) {
                if (/schema_version|table_x?info/i.test(sql)) metrics.schemaProbes++;
                if (/table_x?info/i.test(sql)) metrics.columnInspections++;
              } else metrics.businessReads++;
              for (const row of method === "all" ? result : result ? [result] : []) {
                if (!Object.hasOwn(row, "metadata_json")) continue;
                metrics.returnedMetadataRows++;
                metrics.returnedMetadataBytes += byteLength(row.metadata_json);
              }
              return result;
            };
          }
        });
      };
    }
  });
  const { publicVideo } = createShortVideoPublicVideoMapper({
    ...kernels,
    parseJsonObject(value) {
      metrics.parsedMetadataRows++;
      metrics.parsedMetadataBytes += byteLength(value);
      return kernels.parseJsonObject(value);
    }
  });
  const owner = factory({ database: () => observed, publicVideo, resolveVideo: kernels.videoCatalogRowByAnyId, testHooks: hooks });
  return {
    owner,
    reset() { metrics = emptyMetrics(); },
    metrics() { return { ...metrics }; },
    inject(phase, predicate, error) { failure = { phase, predicate, error }; },
    hasPendingFailure() { return failure !== null; },
    overrideResult(phase, predicate, transform) { resultOverride = { phase, predicate, transform }; },
    hasPendingOverride() { return resultOverride !== null; }
  };
  function fail(phase, sql) {
    if (failure?.phase === phase && failure.predicate(sql)) {
      const error = failure.error;
      failure = null;
      throw error;
    }
  }
}

function resetRows() {
  db.exec("DELETE FROM short_video_collection_items; DELETE FROM short_video_collections; DELETE FROM short_videos; DELETE FROM short_video_users; DELETE FROM short_video_user_actions; DELETE FROM short_video_watch_history; DELETE FROM short_video_source_memberships; DELETE FROM short_video_stats; DELETE FROM short_video_sounds; DELETE FROM short_video_assets");
  db.prepare("INSERT INTO short_video_collections(id,local_user_id,name,normalized_name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("fixture", "local:self", "Fixture", "fixture", "2026-01-01", "2026-01-02");
}

function insertVideo(id, options = {}) {
  const fields = {
    id, aweme_id: options.awemeId || `12345678${id.replace(/\D/g, "").padStart(9, "0")}`,
    source_path: `/synthetic/${id}.mp4`, file_name: `${id}.mp4`, title: `Title ${id}`, description: `Description ${id}`,
    metadata_json: "{}", media_type: "video", owner_user_id: "fixture-author", origin: "douyin_like_import",
    visibility: "local_only", tags_json: '["标签","two"]', published_at: "2026-04-01", liked_at: "2026-04-02",
    duration_ms: 12345, width: 1920, height: 1080, size_bytes: 98765, mtime_ms: 123456,
    digg_count: 10, comment_count: 2, collect_count: 3, share_count: 4, play_count: 50,
    ...options.fields
  };
  const names = Object.keys(fields);
  db.prepare(`INSERT INTO short_videos(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...Object.values(fields));
  if (options.member !== false) db.prepare("INSERT INTO short_video_collection_items(collection_id,video_id,added_at) VALUES(?,?,?)")
    .run(options.collection || "fixture", id, options.addedAt ?? "2026-04-03T00:00:00.000Z");
}

function url(query = "") { return new URL(`http://fixture.invalid/?${query}`); }
function compare(before, actual, method, values, label) {
  const expected = before.owner[method](...values);
  const result = actual.owner[method](...values);
  assert.deepEqual(result, expected, label);
  assert.equal(JSON.stringify(result), JSON.stringify(expected), `${label}: wire JSON`);
  assert.equal(db.isTransaction, false, `${label}: released transaction`);
  comparisons++;
  return result;
}

function verifyMetadata(before, actual) {
  resetRows();
  const fallback = "https://covers.invalid/fallback.jpg";
  const cases = [
    ["normal", { cover_url: "https://covers.invalid/snake.jpg", ignored: "x".repeat(8192) }],
    ["camel", { coverUrl: fallback }],
    ...[null, false, 0, 1e300, "", "file:///cover", " data:image/a", [], {}].map((value, i) => [`fallback-${i}`, { cover_url: value, coverUrl: fallback }]),
    ["upper-url", { cover_url: "HTTPS://covers.invalid/U" }],
    ["space-url", { cover_url: " https://covers.invalid/U", coverUrl: fallback }],
    ["nul", { cover_url: "https://covers.invalid/a\u0000tail" }],
    ["high-surrogate", { cover_url: "https://covers.invalid/\ud800" }],
    ["low-surrogate", { cover_url: "https://covers.invalid/\udfff" }],
    ["gallery", { cover_url: fallback, fanhaoMedia: { type: "gallery", galleryCount: 3, galleryItems: ["image", "video", "image"] } }, { media_type: "gallery" }],
    ["live-photo", { coverUrl: fallback, fanhaoMedia: { type: "gallery", galleryCount: 3, galleryItems: ["image", "video", "image"] }, images: [{ live_photo_type: 1, video: {} }, {}] }, { media_type: "gallery" }],
    ...["", "VIDEO", " video ", "old", "Gallery", " gallery "].map((type, i) => [`legacy-${i}`, { cover_url: fallback, fanhaoMedia: { type: "gallery", galleryCount: 2, galleryItems: ["video", "image"] } }, { media_type: type, source_path: "/synthetic/still.jpg" }]),
    ["image-inferred", { cover_url: fallback, fanhaoMedia: { galleryCount: 2, galleryItems: ["image", "video"] } }, { media_type: "", source_path: "/synthetic/still.JPG" }],
    ["stored-video-wins", { cover_url: fallback, fanhaoMedia: { type: "gallery", galleryCount: 2 } }, { source_path: "/synthetic/still.jpg" }],
    ["native-cover", { coverUrl: fallback }, { cover_path: "/synthetic/cover.jpg", cover_source: "native" }],
    ["sqlite-cover", { coverUrl: fallback }, { cover_source: "ffmpeg_sqlite" }]
  ];
  const rawCases = [
    ["bad", '{"cover_url":'], ["null", "null"], ["array", '[{"cover_url":"https://invalid/"}]'],
    ["primitive", '"https://invalid/"'], ["number", "12"], ["empty", ""],
    ["duplicate", '{"cover_url":"https://first/","cover_url":"https://last/"}'],
    ["duplicate-empty-last", '{"cover_url":"https://first/","cover_url":"","coverUrl":"https://camel/"}'],
    ["duplicate-escaped", '{"cover_\\u0075rl":"https://first/","cover_url":"https://last/"}'],
    ["duplicate-escaped-middle", '{"co\\u0076er_url":"https://first/","cover_url":"https://last/"}'],
    ["escaped-key", '{"cover_\\u0075rl":"https://escaped/"}'],
    ["nul-key", '{"cover_url\\u0000x":"https://wrong/","coverUrl":"https://right/"}'],
    ["nul-key-before-real", '{"cover_url\\u0000x":"https://wrong/","cover_url":"https://right/"}'],
    ["overflow", '{"cover_url":1e999,"coverUrl":"https://camel/"}'],
    ["infinity", '{"cover_url":Infinity,"coverUrl":"https://camel/"}'],
    ["nan", '{"cover_url":NaN,"coverUrl":"https://camel/"}'],
    ["comment", '{/*json5*/"coverUrl":"https://camel/"}'],
    ["blob", Buffer.from('{"cover_url":"https://blob/"}')],
    ["blob-bytes", Buffer.from([0xff, 0x00, 0x10])]
  ];
  for (const [name, metadata, fields] of cases) insertVideo(name, { fields: { metadata_json: JSON.stringify(metadata), ...fields } });
  for (const [name, raw] of rawCases) insertVideo(name, { fields: { metadata_json: raw } });
  db.prepare("INSERT INTO short_video_users(id,nickname,signature,avatar_url) VALUES(?,?,?,?)")
    .run("fixture-author", "Fresh Author", "signature", "https://avatars.invalid/a");
  db.prepare("INSERT INTO short_video_user_actions(local_user_id,video_id,action_type,active,source,baseline_active) VALUES(?,?,?,?,?,?)")
    .run("local:self", "normal", "like", 1, "manual", 0);
  db.prepare("INSERT INTO short_video_stats(video_id,digg_count,comment_count,collect_count,share_count,play_count) VALUES(?,?,?,?,?,?)")
    .run("normal", 123, 45, 67, 89, 1000);
  db.prepare("INSERT INTO short_video_watch_history(local_user_id,video_id,progress_ms,completed_count,last_watched_at) VALUES(?,?,?,?,?)")
    .run("local:self", "normal", 3210, 2, "2026-05-01");
  db.prepare("INSERT INTO short_video_sounds(video_id,sound_key,sound_id,title,author,cover_url,preview_url,local_available) VALUES(?,?,?,?,?,?,?,?)")
    .run("normal", "music:fixture", "music-id", "Fixture Sound", "Artist", "https://covers.invalid/sound", "https://preview.invalid/sound", 0);
  const page = compare(before, actual, "listCollectionVideos", ["fixture", url("limit=120")], "metadata mixed page");
  assert.equal(page.count, cases.length + rawCases.length);
  for (const [name] of [...cases, ...rawCases]) compare(before, actual, "collectionVideoDetail", ["fixture", name], `detail ${name}`);
  assert.equal(page.videos.find(row => row.id === "duplicate").coverUrl, "https://last/");
  assert.equal(page.videos.find(row => row.id === "blob").coverUrl, "");
  assert.equal(page.videos.find(row => row.id === "live-photo").galleryPresentation, "live-photo");
  assert.equal(page.videos.find(row => row.id === "nul-key").coverUrl, "https://right/");
  assert.equal(page.videos.find(row => row.id === "normal").watch.completedCount, 2);
  assert.equal(page.videos.find(row => row.id === "normal").stats.likes, 124);
}

function verifyMalformedMedia(before, actual) {
  // Stored video and an existing local cover do not bypass the old mapper's
  // declared-media conversions. Projection must retain their TypeErrors.
  for (const localCover of [false, true]) for (const field of ["type", "galleryCount"]) {
    resetRows();
    const value = { fanhaoMedia: { [field]: { toString: null, valueOf: null } } };
    insertVideo("bad-conversion", { fields: { metadata_json: JSON.stringify(value),
      ...(localCover ? { cover_path: "/synthetic/native.jpg", cover_source: "native" } : {}) } });
    compareError(before, actual, "listCollectionVideos", ["fixture"], `bad ${field}, local cover ${localCover}`);
    compareError(before, actual, "collectionVideoDetail", ["fixture", "bad-conversion"], `detail bad ${field}, local cover ${localCover}`);
  }
  resetRows();
  insertVideo("duplicate-media", { fields: { metadata_json: '{"fanhaoMedia":{},"fanhaoMedia":{"type":{"toString":null,"valueOf":null}}}' } });
  compareError(before, actual, "listCollectionVideos", ["fixture"], "duplicate fanhaoMedia retains final throwing value");
  resetRows();
  insertVideo("duplicate-media-safe", { fields: { metadata_json: '{"fanhaoMedia":{"type":{"toString":null}},"fanhaoMedia":{},"cover_url":"https://safe/"}' } });
  compare(before, actual, "listCollectionVideos", ["fixture"], "duplicate fanhaoMedia final safe value");
}

function verifyPaging(before, actual) {
  resetRows();
  for (let i = 0; i < 17; i++) insertVideo(`page-${String(i).padStart(3, "0")}`, { addedAt: i < 8 ? "2026-03-01" : "2026-03-02" });
  insertVideo("outsider", { member: false });
  db.prepare("INSERT INTO short_video_collections(id,local_user_id,name,normalized_name) VALUES(?,?,?,?)")
    .run("foreign", "other:user", "Other", "other");
  db.prepare("INSERT INTO short_video_collection_items(collection_id,video_id,added_at) VALUES(?,?,?)").run("foreign", "outsider", "2099");
  for (const query of ["", "limit=1", "limit=3&offset=4", "limit=120&offset=17", "limit=0&offset=-1", "limit=1000", "limit=NaN&offset=Infinity", "limit=2&offset=1000001"])
    compare(before, actual, "listCollectionVideos", ["fixture", url(query)], `page ${query}`);
  const ids = [];
  let cursor = "";
  do {
    const page = compare(before, actual, "listCollectionVideos", ["fixture", url(`limit=3${cursor ? `&cursor=${cursor}&offset=999` : ""}`)], "cursor page");
    ids.push(...page.videos.map(row => row.id));
    if (cursor) assert.equal(page.offset, 0, "valid cursor takes precedence over offset");
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 17); assert.equal(new Set(ids).size, 17);
  const awemeId = db.prepare("SELECT aweme_id FROM short_videos WHERE id=?").get("page-008").aweme_id;
  compare(before, actual, "collectionVideoDetail", ["fixture", awemeId], "aweme alias detail");
  compareError(before, actual, "collectionVideoDetail", ["fixture", "12345678"], "ambiguous numeric prefix is not a video");
  for (const [method, values] of [
    ["listCollectionVideos", ["foreign"]], ["collectionVideoDetail", ["foreign", "outsider"]],
    ["listCollectionVideos", ["missing"]], ["listCollectionVideos", ["bad/id"]],
    ["collectionVideoDetail", ["fixture", "outsider"]], ["collectionVideoDetail", ["fixture", "missing-video"]],
    ...["!", "W10", Buffer.from('["ok","bad/id"]').toString("base64url"), "x".repeat(513)].map(cursor => ["listCollectionVideos", ["fixture", url(`cursor=${cursor}`)]])
  ]) compareError(before, actual, method, values, `${method} invalid request`);
}

function compareError(before, actual, method, values, label) {
  const capture = owner => {
    let failure;
    try { owner[method](...values); } catch (error) { failure = error; }
    assert(failure, `${label}: expected error`);
    const error = failure;
    return { name: error.name, message: error.message, code: error.code, errcode: error.errcode, statusCode: error.statusCode, retryable: error.retryable };
  };
  assert.deepEqual(capture(actual.owner), capture(before.owner), label);
  assert.equal(db.isTransaction, false, `${label}: rollback`);
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 777, `${label}: restored timeout`);
  errorComparisons++;
}

function verifySchemaChanges(before, actual) {
  // Reuse both repository owners across native schema changes. The mapper does
  // not expose extra columns, but SQLite must still decode them and throw on
  // an unsafe integer exactly as SELECT alias.* did.
  compare(before, actual, "listCollectionVideos", ["fixture"], "warm normal schema before changes");
  db.exec("ALTER TABLE short_videos ADD COLUMN fixture_new_column TEXT DEFAULT 'new'");
  compare(before, actual, "listCollectionVideos", ["fixture"], "ALTER base table does not stale projection");
  const catalogSql = schema.find(row => row.type === "view" && row.name === "short_video_catalog").sql;
  db.exec('DROP VIEW main.short_video_catalog; CREATE VIEW short_video_catalog AS SELECT base.*, 9223372036854775807 AS "new""unused" FROM short_video_catalog_base base');
  compareError(before, actual, "listCollectionVideos", ["fixture"], "main catalog replacement adds quoted unsafe column");
  compareError(before, actual, "collectionVideoDetail", ["fixture", "outsider"], "main catalog resolver keeps newly added decoder error");
  db.exec(`DROP VIEW main.short_video_catalog; ${catalogSql}`);
  compare(before, actual, "listCollectionVideos", ["fixture"], "main catalog restored after replacement");
  db.exec("CREATE TEMP VIEW short_video_catalog AS SELECT original.*, 'extra' AS fixture_extra FROM main.short_video_catalog original");
  compare(before, actual, "listCollectionVideos", ["fixture"], "temporary same-name catalog shadows main view");
  db.exec("DROP VIEW temp.short_video_catalog; CREATE TEMP VIEW short_video_catalog AS SELECT original.*, 9223372036854775807 AS fixture_unsafe FROM main.short_video_catalog original");
  compareError(before, actual, "listCollectionVideos", ["fixture"], "unused unsafe integer still decodes and throws");
  compareError(before, actual, "collectionVideoDetail", ["fixture", "page-008"], "detail unused unsafe integer still throws");
  compareError(before, actual, "collectionVideoDetail", ["fixture", "outsider"], "resolver decodes unused unsafe value even for a nonmember");
  compareError(before, actual, "collectionVideoDetail", ["fixture", "12345678"], "ambiguous numeric resolver still decodes unsafe candidate values");
  db.exec("DROP VIEW temp.short_video_catalog; CREATE TEMP VIEW short_video_catalog AS SELECT id, aweme_id, media_type, source_path, title FROM main.short_video_catalog");
  compare(before, actual, "listCollectionVideos", ["fixture"], "legacy catalog missing metadata column");
  db.exec("DROP VIEW temp.short_video_catalog");
  compare(before, actual, "listCollectionVideos", ["fixture"], "main catalog restored after temporary view");
}

function verifyFailures(before, actual) {
  for (const [method, phase, predicate] of [
    ["listCollectionVideos", "prepare", sql => sql.includes("JOIN short_video_catalog")],
    ["listCollectionVideos", "all", sql => sql.includes("JOIN short_video_catalog")],
    ["collectionVideoDetail", "get", sql => sql.includes("item.video_id = ?")],
    ["collectionVideoDetail", "prepare", sql => sql.includes("JOIN short_video_catalog candidate")]
  ]) {
    for (const owner of [before, actual]) owner.inject(phase, predicate, new Error(`fixture ${phase} fault`));
    const values = method === "listCollectionVideos" ? ["fixture", url("limit=3")] : ["fixture", "page-008"];
    compareError(before, actual, method, values, `${method} ${phase} error`);
    compare(before, actual, method, values, `${method} ${phase} recovery`);
  }
}

function verifySchemaProbeFailures(before) {
  // Probe faults are a new controlled boundary. Test the real production
  // helper independently even when the budget negative disables projection.
  db.prepare("UPDATE short_videos SET metadata_json=? WHERE id=?")
    .run(JSON.stringify({ cover_url: "https://probe/", unused: "p".repeat(32768) }), "page-008");
  for (const [name, phase, predicate] of [
    ["version prepare", "prepare", sql => /schema_version/i.test(sql)],
    ["version get", "get", sql => /schema_version/i.test(sql)],
    ["temp schema prepare", "prepare", sql => /temp\.sqlite_schema/i.test(sql)],
    ["temp schema get", "get", sql => /temp\.sqlite_schema/i.test(sql)],
    ["main schema prepare", "prepare", sql => /main\.sqlite_schema/i.test(sql)],
    ["main schema get", "get", sql => /main\.sqlite_schema/i.test(sql)],
    ["columns prepare", "prepare", sql => /table_x?info/i.test(sql)],
    ["columns all", "all", sql => /table_x?info/i.test(sql)]
  ]) {
    const actual = repository(currentFactory);
    actual.inject(phase, predicate, new Error(`fixture ${name} fault`));
    compare(before, actual, "listCollectionVideos", ["fixture", url("limit=120")], `${name}: old query fallback`);
    assert.equal(actual.hasPendingFailure(), false, `${name}: fault reached the actual schema probe`);
    const fallback = actual.metrics();
    actual.reset();
    compare(before, actual, "listCollectionVideos", ["fixture", url("limit=120")], `${name}: next request retries`);
    assert(actual.metrics().returnedMetadataBytes < fallback.returnedMetadataBytes / 10, `${name}: failed probe did not cache wildcard forever`);
    assert(actual.metrics().columnInspections > 0, `${name}: retry admits actual catalog columns`);
  }
  for (const [name, schemaName, value] of [
    ["missing main version", "main", undefined],
    ["NaN temp version", "temp", { schema_version: NaN }],
    ["string main version", "main", { schema_version: "1" }],
    ["fractional temp version", "temp", { schema_version: 1.5 }]
  ]) {
    const actual = repository(currentFactory);
    compare(before, actual, "listCollectionVideos", ["fixture", url("limit=120")], `${name}: existing cache`);
    actual.overrideResult("get", sql => sql === `PRAGMA ${schemaName}.schema_version`, () => value);
    actual.reset();
    compare(before, actual, "listCollectionVideos", ["fixture", url("limit=120")], `${name}: invalid stamp uses original query`);
    assert.equal(actual.hasPendingOverride(), false, `${name}: controlled stamp was observed`);
    assert(actual.metrics().returnedMetadataBytes > 32768, `${name}: invalid stamp does not reuse old projection`);
    actual.reset();
    compare(before, actual, "listCollectionVideos", ["fixture", url("limit=120")], `${name}: next valid stamp retries`);
    assert(actual.metrics().columnInspections > 0, `${name}: cache was invalidated`);
    assert(actual.metrics().returnedMetadataBytes < 3276, `${name}: recovered projection`);
  }
}

function verifyWalSnapshot() {
  // A separate connection commits after count established the read snapshot.
  // Both repository owners must keep count, membership and DTOs in that view.
  const writer = new DatabaseSync(dbPath);
  try {
    const results = [];
    for (const factory of [beforeFactory, testedFactory]) {
      resetRows();
      insertVideo("wal-a", { fields: { metadata_json: '{"coverUrl":"https://old/"}' } });
      insertVideo("wal-b");
      let commits = 0;
      const observed = repository(factory, { afterCollectionPageCount() {
        writer.prepare("UPDATE short_videos SET title=?, metadata_json=? WHERE id=?").run("new title", '{"coverUrl":"https://new/"}', "wal-a");
        writer.prepare("DELETE FROM short_video_collection_items WHERE video_id=?").run("wal-b");
        commits++;
      } });
      const page = observed.owner.listCollectionVideos("fixture", url("limit=10"));
      assert.equal(commits, 1); assert.equal(page.total, 2); assert.equal(page.count, 2);
      assert.equal(page.videos.find(row => row.id === "wal-a").coverUrl, "https://old/");
      assert.equal(db.isTransaction, false);
      const next = repository(factory).owner.listCollectionVideos("fixture", url("limit=10"));
      assert.equal(next.total, 1); assert.equal(next.count, 1); assert.equal(next.videos[0].title, "new title");
      assert.equal(next.videos[0].coverUrl, "https://new/");
      results.push({ page, next });
    }
    assert.deepEqual(results[1], results[0]); comparisons += 2;
  } finally { writer.close(); }
}

function verifyScale(before, actual) {
  resetRows();
  const metadata = JSON.stringify({ cover_url: "https://covers.invalid/large.jpg",
    fanhaoMedia: { type: "video", galleryCount: 0, galleryItems: [] }, unused: "" });
  const largeMetadata = metadata.replace('"unused":""', `"unused":"${"x".repeat(65536 - Buffer.byteLength(metadata))}"`);
  assert.equal(Buffer.byteLength(largeMetadata), 65536);
  db.exec("BEGIN");
  try {
    for (let i = 0; i < 481; i++) {
      // Each body is distinct, as actual imported raw records are. This also
      // prevents identical-input JSON1 parser reuse from flattering timing.
      const uniqueMetadata = `${largeMetadata.slice(0, -6)}${String(i).padStart(4, "0")}${largeMetadata.slice(-2)}`;
      assert.equal(Buffer.byteLength(uniqueMetadata), 65536);
      insertVideo(`scale-${String(i).padStart(4, "0")}`, { fields: { metadata_json: uniqueMetadata } });
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const run = owner => {
    owner.reset(); const started = performance.now();
    const pages = []; let cursor = "";
    for (let i = 0; i < 10; i++) {
      const page = owner.owner.listCollectionVideos("fixture", url(`limit=48${cursor ? `&cursor=${cursor}` : ""}`));
      assert.equal(page.count, 48); assert.equal(page.hasMore, true); cursor = page.nextCursor; pages.push(page);
    }
    return { metrics: owner.metrics(), milliseconds: +(performance.now() - started).toFixed(2), pages };
  };
  const old = run(before), next = run(actual);
  assert.deepEqual(next.pages, old.pages, "ten scale pages: complete response oracle"); comparisons += 10;
  assert.equal(old.metrics.returnedMetadataRows, 490, "lookahead copies ten extra rows");
  assert.equal(old.metrics.returnedMetadataBytes, 490 * 65536);
  assert.equal(old.metrics.parsedMetadataRows, 480);
  assert.equal(old.metrics.parsedMetadataBytes, 480 * 65536);
  const detail = owner => {
    owner.reset(); const started = performance.now();
    const result = owner.owner.collectionVideoDetail("fixture", "scale-0240");
    assert(result.prevVideo && result.nextVideo);
    return { metrics: owner.metrics(), milliseconds: +(performance.now() - started).toFixed(2), result };
  };
  const oldDetail = detail(before), nextDetail = detail(actual);
  assert.deepEqual(nextDetail.result, oldDetail.result, "current plus both adjacent DTOs"); comparisons++;
  assert.equal(oldDetail.metrics.returnedMetadataRows, 4, "resolver plus three exposed rows");
  assert.equal(oldDetail.metrics.returnedMetadataBytes, 4 * 65536);
  assert.equal(oldDetail.metrics.parsedMetadataBytes, 3 * 65536);
  // Behavioral oracles run before these independent real-byte gates. The
  // disabled negative must fail here, not on a product source-marker check.
  assert(next.metrics.returnedMetadataBytes < 96 * 1024,
    `page SQL metadata-copy budget <98304 bytes for ten pages; actual ${next.metrics.returnedMetadataBytes}`);
  assert(next.metrics.parsedMetadataBytes < 96 * 1024,
    `page JSON.parse metadata-input budget <98304 bytes for ten pages; actual ${next.metrics.parsedMetadataBytes}`);
  assert(nextDetail.metrics.returnedMetadataBytes < 1024, "detail SQL includes resolver and all three rows: <1KiB metadata");
  assert(nextDetail.metrics.parsedMetadataBytes < 1024, "detail JSON.parse metadata-input budget <1KiB");
  assert.equal(next.metrics.businessReads, old.metrics.businessReads, "projection adds no per-page business SELECT reads");
  assert(next.metrics.schemaProbes <= 22, "bounded main/temp schema probes per page, plus initial column inspection");
  return { pages: { before: old.metrics, after: next.metrics, beforeMs: old.milliseconds, afterMs: next.milliseconds },
    detail: { before: oldDetail.metrics, after: nextDetail.metrics, beforeMs: oldDetail.milliseconds, afterMs: nextDetail.milliseconds } };
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { trackOrderSql } from "../src/modules/music/server/helpers.js";
import { findSmartMix } from "../src/modules/music/server/smart-mix.js";
import { MUSIC_FACET_CACHE } from "../src/modules/music/server/constants.js";
import { insertMusicShortSearchRow, insertMusicPhoneticSearchRow } from "../src/modules/music/server/search.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

// This feature deliberately specifies formerly unspecified duration ties.
// Historical DTO compatibility, that new policy, and index work are separate
// oracles. Native SQLite/store reads only; roots and source paths are synthetic.
assert(process.argv.slice(2).every(value => value === "--legacy-duration-sort"), "known arguments");
const negative = process.argv.includes("--legacy-duration-sort");
const project = fileURLToPath(new URL("../", import.meta.url));
const base = new URL("../src/modules/music/server/", import.meta.url);
const hashes = {
  "store.js": "31287963c4cb20eae132a4f6d2fc2c606cb8ebfc182ea630c4604e1030a578c8",
  "schema.js": "c790ac1781b8b8d8834d7ae2a64cbd31476fdd13d8f9caa347828133038e4c92",
  "helpers.js": "3598e4441b5b512dbddfb39bb54c24cfda59d9db4f77841236aa47e347dfd5b8",
  "smart-mix.js": "be42c21177092063b0e14899428021901f8aef8b7bff9c53743c239230189b30"
};
const historical = {};
for (const [name, hash] of Object.entries(hashes)) {
  historical[name] = execFileSync("git", ["show", `63c5fab243233e142cfd62c4eaf13812feb92405:src/modules/music/server/${name}`], { cwd: project, encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(historical[name]).digest("hex"), hash, `fixed complete ${name}`);
}
const schemaSource = fs.readFileSync(new URL("schema.js", base), "utf8").replaceAll("\r\n", "\n");
const storeSource = fs.readFileSync(new URL("store.js", base), "utf8").replaceAll("\r\n", "\n");
const ddl = 'CREATE INDEX IF NOT EXISTS main.idx_music_tracks_duration_sort ON music_tracks(status, duration_ms DESC, title COLLATE NOCASE ASC, id COLLATE BINARY ASC);';
const indexLine = `    db.exec("${ddl}");`, disabledLine = "    // Only the new duration index is disabled in this fixture.";
assert.equal(schemaSource.split(indexLine).length, 2, "one new index creation boundary");
const noIndexSchema = schemaSource.replace(indexLine, disabledLine);
assert.equal(noIndexSchema.replace(disabledLine, indexLine), schemaSource, "negative control retains the new policy and every other migration");
const oldRule = 'if (sort === "duration") return "t.duration_ms DESC, t.title COLLATE NOCASE ASC";';
const newRule = 'if (sort === "duration") return "t.duration_ms DESC, t.title COLLATE NOCASE ASC, t.id COLLATE BINARY ASC";';
assert.equal(historical["helpers.js"].split(oldRule).length, 2);
const policyHelperSource = historical["helpers.js"].replace(oldRule, newRule);
assert.equal(policyHelperSource.replace(newRule, oldRule), historical["helpers.js"], "old policy oracle changes precisely one duration rule");
assert.equal(trackOrderSql("duration"), "t.duration_ms DESC, t.title COLLATE NOCASE ASC, t.id COLLATE BINARY ASC");
assert.equal(findSmartMix("longform").order, trackOrderSql("duration"), "longform reuses the same duration policy");

function moduleUrl(source, name, replacements = {}) {
  source = source.replace(/from "(\.\/[^"]+)"/gu, (_match, relative) => `from ${JSON.stringify(replacements[relative] || new URL(relative, new URL(name, base)).href)}`);
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}
const oldSchemaUrl = moduleUrl(historical["schema.js"], "schema.js");
const oldHelperUrl = moduleUrl(historical["helpers.js"], "helpers.js");
const oldMixUrl = moduleUrl(historical["smart-mix.js"], "smart-mix.js");
const { ensureSchema: previousEnsureSchema } = await import(oldSchemaUrl);
async function oldFactory(policy) {
  return (await import(moduleUrl(historical["store.js"], "store.js", { "./schema.js": oldSchemaUrl,
    "./helpers.js": policy ? moduleUrl(policyHelperSource, "helpers.js") : oldHelperUrl, "./smart-mix.js": oldMixUrl }))).createMusicStore;
}
const beforeFactory = await oldFactory(false), policyFactory = await oldFactory(true);
const noIndexFactory = (await import(moduleUrl(storeSource, "store.js", { "./schema.js": moduleUrl(noIndexSchema, "schema.js") }))).createMusicStore;
const testedFactory = negative ? noIndexFactory : createMusicStore;
const temporary = createVerifiedTempDir("fanhao-music-duration-");
const owners = [], savedPrepare = DatabaseSync.prototype.prepare, savedExec = DatabaseSync.prototype.exec, savedNow = Date.now;
let opening = false, captured, work = null, fault = null, indexBuildAttempts = 0, clock = 1800000000000, comparisons = 0, policyCases = 0, errors = 0;
Date.now = () => clock;
const isPage = sql => sql.includes("FROM music_tracks t") && sql.includes("LEFT JOIN music_artists")
  && sql.includes("LIMIT ? OFFSET ?") && sql.includes("ORDER BY t.duration_ms DESC, t.title COLLATE NOCASE ASC");
DatabaseSync.prototype.exec = function(sql, ...args) {
  if (sql === ddl) indexBuildAttempts++;
  if (fault?.kind === "index" && sql === ddl) { const error = fault.error; fault = null; throw error; }
  return savedExec.call(this, sql, ...args);
};
DatabaseSync.prototype.prepare = function(sql, ...rest) {
  if (opening) captured = this;
  const page = isPage(sql), measured = work?.db === this && page;
  if (fault?.kind === "page" && page && fault.phase === "prepare") { const error = fault.error; fault = null; throw error; }
  let executable = sql;
  if (measured && work.instrument) executable = sql.replace("WHERE t.status = 'ok'", "WHERE t.status = 'ok' AND fixture_duration_visit(t.id) IS t.id")
    .replace("a.id = t.artist_id", "a.id = fixture_duration_artist(t.artist_id)")
    .replace("al.id = t.album_id", "al.id = fixture_duration_album(t.album_id)")
    .replace("s.track_id = t.id", "s.track_id = fixture_duration_state(t.id)");
  const statement = savedPrepare.call(this, executable, ...rest), db = this;
  if (!page) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...args) => {
      if (fault?.kind === "page" && key === fault.phase) { const error = fault.error; fault = null; throw error; }
      if (measured && key === "all") {
        const explain = text => savedPrepare.call(db, "EXPLAIN QUERY PLAN " + text).all(...args).map(row => row.detail);
        const plan = explain(sql); assert.deepEqual(explain(executable), plan, "identity probes retain the unmodified native query plan");
        const start = performance.now(), result = value.apply(target, args);
        work.pages++; work.pageMs += performance.now() - start; work.plan = plan; work.sql = sql; work.bindings = args; return result;
      }
      return value.apply(target, args);
    };
  } });
};
function open(factory) {
  const store = factory({ dbPath: ":memory:", roots: [], scanWorker: { start() { assert.fail("no worker"); }, async stop() {} } });
  opening = true; captured = null;
  try { store.summary(); } finally { opening = false; }
  const owner = { store, db: captured }; assert(owner.db); owners.push(owner);
  for (const field of ["visit", "artist", "album", "state"]) owner.db.function("fixture_duration_" + field, value => { if (work?.db === owner.db) work[field]++; return value; });
  return owner;
}
function seed(owner, rows, searchable = false) {
  const db = owner.db;
  db.exec("BEGIN; DELETE FROM music_track_state; DELETE FROM music_tracks; DELETE FROM music_artists; DELETE FROM music_albums; DELETE FROM music_search; DELETE FROM music_search_short; DELETE FROM music_search_phonetic;");
  const artist = db.prepare("INSERT INTO music_artists(id,name,language,source_root,source_path,relative_path,track_count,album_count,duration_ms,size_bytes,status,updated_at)VALUES(?,?,?,'synthetic',?,?,?,4,1000000,1000,'ok','same')");
  for (let i = 0; i < 3; i++) artist.run("a" + i, "Artist " + i, i % 2 ? "英文" : "中文", "synthetic/a" + i, "a" + i, rows.length);
  const album = db.prepare("INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,duration_ms,size_bytes,updated_at)VALUES(?,?,?,'synthetic',?,?,?,1000000,1000,'same')");
  for (let i = 0; i < 4; i++) album.run("al" + i, "a" + i % 3, "Album " + i, "synthetic/al" + i, "al" + i, rows.length);
  const insert = db.prepare("INSERT INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,track_no,disc_no,genre,language,source_root,source_path,relative_path,file_name,ext,duration_ms,size_bytes,has_lrc,codec,status,updated_at)VALUES(?,?,?,?,?,?,?,1,?,?,'synthetic',?,?,?,'.mp3',?,?,?,'mp3',?,'same')");
  const state = db.prepare("INSERT INTO music_track_state(track_id,favorite,rating,position_ms,duration_ms,play_count,last_played_at,updated_at)VALUES(?,?,?,0,0,0,'',?)");
  rows.forEach((row, i) => {
    insert.run(row.id, row.artist ?? "a" + i % 3, row.album ?? "al" + i % 4, row.title ?? "Track " + String(i).padStart(4, "0"),
      row.displayArtist ?? "Artist " + i % 3, "Album " + i % 4, i + 1, i % 2 ? "Rock" : "Pop", i % 2 ? "英文" : "中文",
      "synthetic/" + i + ".mp3", i + ".mp3", i + ".mp3", row.duration, row.size ?? i + 1, i % 2, row.status || "ok");
    state.run(row.id, i % 2, i % 6, "2026-01-" + String(i + 1).padStart(2, "0"));
  });
  if (searchable) {
    const full = db.prepare("INSERT INTO music_search(track_id,title,artist,album,lyrics)VALUES(?,?,?,?,?)"), short = db.prepare("INSERT INTO music_search_short(track_id,title,artist,album,genre,file_name)VALUES(?,?,?,?,?,?)"), phonetic = db.prepare("INSERT INTO music_search_phonetic(track_id,artist_id,album_id,title,artist,album,file_name)VALUES(?,?,?,?,?,?,?)");
    for (const row of db.prepare("SELECT * FROM music_tracks").all()) { full.run(row.id, row.title, row.display_artist, row.album_title, ""); insertMusicShortSearchRow(short, row); insertMusicPhoneticSearchRow(phonetic, row); }
  }
  db.exec("COMMIT");
}
function refresh(list) { clock += 6000; for (const owner of list) { MUSIC_FACET_CACHE.delete(owner.db); owner.store.summary(); owner.store.facets(); } }
const request = text => new URL("http://fixture.invalid/music?" + text);
const read = (owner, text = "sort=duration&limit=7") => owner.store.listTracks(request(text));
function same(left, right, text, label) { const a = read(left, text), b = read(right, text); assert.deepEqual(a, b, label); assert.equal(JSON.stringify(a), JSON.stringify(b), label + " wire"); comparisons++; return a; }
function dataRows(count = 24) { return Array.from({ length: count }, (_, i) => ({ id: "t" + String(i).padStart(3, "0"), duration: 300001 + i * 1000, title: i < 3 ? "Needle " + i : "Track " + i })); }
function measure(owner, query, instrument = true) {
  work = { db: owner.db, instrument, visit: 0, artist: 0, album: 0, state: 0, pages: 0, pageMs: 0 };
  const start = performance.now();
  try { const result = read(owner, query); const { db: _db, instrument: _instrument, ...metrics } = work; return { result, ...metrics, instrumentedDiagnosticMs: performance.now() - start }; }
  finally { work = null; assert.equal(owner.db.isTransaction, false, "list read releases its snapshot"); }
}

function verifyHistoricalAndPolicy() {
  const before = open(beforeFactory), policy = open(policyFactory), current = open(testedFactory), noIndex = open(noIndexFactory), pair = [before, policy, current, noIndex];
  for (const owner of pair) seed(owner, dataRows(), true); refresh(pair);
  const filters = ["", "artist=a1", "album=al2", "language=中文", "genre=rock", "q=Needle", "favorite=1", "minRating=4", "lyrics=1", "quality=lossless"];
  for (const filter of filters) for (const page of ["limit=5", "limit=3&offset=2", "limit=5&offset=999"]) same(current, before, `sort=duration&${filter}&${page}`, "non-tie fixed complete historical DTO");
  for (const sort of ["album", "title", "artist", "played", "favorite", "rating"]) same(current, before, `sort=${sort}&limit=5`, "ordinary sorts retain historical DTO");
  for (const [label, actual, expected] of [
    ["non-tie historical longform", current.store.smartPlaylistDetail("longform", request("limit=5")), before.store.smartPlaylistDetail("longform", request("limit=5"))],
    ["non-tie historical detail/adjacent", current.store.trackDetail("t005", request("sort=duration")), before.store.trackDetail("t005", request("sort=duration"))]
  ]) { assert.deepEqual(actual, expected, label); assert.equal(JSON.stringify(actual), JSON.stringify(expected), label + " wire"); comparisons++; }
  const ties = [
    { id: "z", title: "Same", duration: 600000, displayArtist: "Alpha" },
    { id: "A", title: "same", duration: 600000, displayArtist: "Zulu" },
    { id: "a", title: "SAME", duration: 600000 }, { id: "01", title: "Same", duration: 600000 },
    { id: "zero", title: "Zero", duration: 0 }, { id: "negative", title: "Negative", duration: -1 },
    { id: "null", title: "Null", duration: null }, { id: "fraction", title: "Fraction", duration: 0.25 }
  ];
  for (const owner of [policy, current, noIndex]) seed(owner, ties, true); refresh([policy, current, noIndex]);
  const expected = ["01", "A", "a", "z", "fraction", "zero", "negative", "null"];
  assert.deepEqual(read(current, "sort=duration&limit=80").tracks.map(row => row.id), expected, "independent explicit duration/NOCASE/BINARY-ID policy"); policyCases++;
  for (const filter of filters) for (const page of ["limit=80", "limit=2&offset=1", "limit=1&offset=4", "limit=5&offset=99"]) {
    same(current, policy, `sort=duration&${filter}&${page}`, "fixed old complete factory with only the one new duration rule");
    same(current, noIndex, `sort=duration&${filter}&${page}`, "same new policy without index");
  }
  const all = read(current, "sort=duration&limit=80").tracks;
  for (let i = 0; i < all.length; i++) {
    const detail = current.store.trackDetail(all[i].id, request("sort=duration"));
    assert.equal(detail.prevId, all[i - 1]?.id || ""); assert.equal(detail.nextId, all[i + 1]?.id || ""); policyCases++;
  }
  const smart = current.store.smartPlaylistDetail("longform", request("limit=80"));
  assert.deepEqual(smart.tracks.map(row => row.id), expected.slice(0, 4), "longform uses the identical explicit ID tie policy"); policyCases++;
  assert.deepEqual(current.store.smartPlaylistDetail("longform", request("limit=80")), noIndex.store.smartPlaylistDetail("longform", request("limit=80"))); comparisons++;
  for (const track of smart.tracks) {
    const detail = current.store.trackDetail(track.id, request("smart=longform")), position = smart.tracks.findIndex(row => row.id === track.id);
    assert.equal(detail.prevId, smart.tracks[position - 1]?.id || ""); assert.equal(detail.nextId, smart.tracks[position + 1]?.id || ""); policyCases++;
  }
  const changes = current.db.prepare("SELECT total_changes() AS n").get().n;
  read(current); current.store.trackDetail("A", request("sort=duration")); current.store.smartPlaylistDetail("longform", request("limit=2"));
  assert.equal(current.db.prepare("SELECT total_changes() AS n").get().n, changes, "list/detail/facets do not mutate data");
  const answer = read(current); answer.tracks[0].title = "changed";
  assert.notEqual(read(current).tracks[0].title, "changed", "returned tracks do not mutate later SQL results");
}

function verifyNativeAndLegacy() {
  const current = open(testedFactory), baseline = open(noIndexFactory), pair = [current, baseline];
  const rows = [
    { id: "null", duration: null }, { id: "zero", duration: 0 }, { id: "negative", duration: -2 }, { id: "float", duration: 1.5 },
    { id: "max-safe", duration: Number.MAX_SAFE_INTEGER }, { id: "real-large", duration: 1e20 },
    { id: "text", duration: "not-a-number" }, { id: "blob", duration: Buffer.from([49]) }
  ];
  for (const owner of pair) seed(owner, rows); refresh(pair);
  assert.deepEqual(read(current, "sort=duration&limit=80").tracks.map(row => row.id), ["blob", "text", "real-large", "max-safe", "float", "zero", "negative", "null"], "independent SQLite storage-class/NULL ordering"); policyCases++;
  same(current, baseline, "sort=duration&limit=80", "dynamic duration storage retains the complete DTO");
  for (const field of ["duration_ms", "size_bytes"]) {
    for (const owner of pair) owner.db.prepare(`UPDATE music_tracks SET ${field}=? WHERE id='blob'`).run(9223372036854775807n);
    const failures = pair.map(owner => { try { read(owner, "sort=duration&limit=80"); assert.fail("native unsafe INTEGER must fail"); } catch (error) { return [error.name, error.code, error.message]; } });
    assert.deepEqual(failures[0], failures[1]); assert.equal(failures[0][0], "RangeError"); errors++;
    for (const owner of pair) { owner.db.prepare(`UPDATE music_tracks SET ${field}=? WHERE id='blob'`).run(field === "duration_ms" ? Buffer.from([49]) : 1); }
    same(current, baseline, "sort=duration&limit=80", "native decode recovers after data correction");
  }
  for (const phase of ["prepare", "all"]) for (const owner of pair) {
    const held = Object.assign(new Error("controlled native page failure"), { code: "SQLITE_BUSY" });
    fault = { kind: "page", phase, error: held }; assert.throws(() => read(owner), error => error === held); assert.equal(fault, null); errors++;
    assert.equal(owner.db.isTransaction, false);
  }
  for (const owner of pair) {
    owner.db.exec("ALTER TABLE music_tracks ADD COLUMN fixture_unknown TEXT DEFAULT 'retained'");
    owner.db.exec("UPDATE music_tracks SET fixture_unknown='untouched'");
  }
  same(current, baseline, "sort=duration&limit=80", "unknown columns do not change full response");
  assert.equal(current.db.prepare("SELECT fixture_unknown FROM music_tracks LIMIT 1").get().fixture_unknown, "untouched");
}

async function verifyLegacyTitlePolicy() {
  const current = open(testedFactory), baseline = open(noIndexFactory), oldPolicy = open(policyFactory), pair = [current, baseline, oldPolicy];
  const { ensureSchema: withoutIndex } = await import(moduleUrl(noIndexSchema, "schema.js"));
  for (const owner of pair) {
    seed(owner, ["a", "A", "B", "b", "z"].map(id => ({ id, title: "Shared", duration: 600000, displayArtist: "Same artist", artist: "a0", album: "al0", size: 7 })));
    const indexed = !!owner.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get();
    const declaration = owner.db.prepare("SELECT sql FROM sqlite_schema WHERE name='music_tracks'").get().sql;
    owner.db.exec("ALTER TABLE music_tracks RENAME TO private_old_tracks;" + declaration
      .replace("id TEXT PRIMARY KEY", "id TEXT COLLATE NOCASE").replace("title TEXT NOT NULL", "title TEXT")
      .replace(/\)\s*$/u, ", PRIMARY KEY(id COLLATE BINARY))") + ";INSERT INTO music_tracks SELECT * FROM private_old_tracks;DROP TABLE private_old_tracks;");
    owner.db.exec("UPDATE music_tracks SET title=NULL WHERE id COLLATE BINARY='a';UPDATE music_tracks SET title=5 WHERE id COLLATE BINARY='A'");
    owner.db.prepare("UPDATE music_tracks SET title=? WHERE id='z'").run(Buffer.from([49]));
    (indexed ? ensureSchema : withoutIndex)(owner.db, { configureConnection: false });
  }
  refresh(pair);
  assert.deepEqual(read(current, "sort=duration&limit=80").tracks.map(row => row.id), ["a", "A", "B", "b", "z"],
    "NULL title first, TEXT-affinity numeric title, NOCASE ties and BINARY ID override the legacy column collation; BLOB title last"); policyCases++;
  for (const page of ["limit=80", "limit=1&offset=0", "limit=1&offset=2", "limit=1&offset=3", "limit=1&offset=4", "limit=1&offset=5"]) {
    same(current, baseline, "sort=duration&" + page, "legacy title storage with same-policy unindexed complete owner");
    same(current, oldPolicy, "sort=duration&" + page, "legacy title storage with the one-rule historical policy oracle");
  }
}

function verifyInitialization() {
  // Initialization contracts always exercise the shipped initializer. The
  // read/performance negative control alone omits its one new CREATE INDEX.
  const dbPath = path.join(temporary.tempDir, "upgrade.sqlite"), db = new DatabaseSync(dbPath);
  try {
    previousEnsureSchema(db); assert.equal(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get(), undefined);
    ensureSchema(db); const original = db.prepare("SELECT sql FROM main.sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get().sql;
    const version = db.prepare("PRAGMA schema_version").get().schema_version; ensureSchema(db);
    assert.equal(db.prepare("PRAGMA schema_version").get().schema_version, version); assert.equal(db.isTransaction, false);
    db.exec("DROP INDEX main.idx_music_tracks_duration_sort; BEGIN IMMEDIATE");
    db.prepare("INSERT INTO music_meta(key,value)VALUES('caller-marker','pending')").run(); ensureSchema(db, { configureConnection: false });
    assert.equal(db.isTransaction, true); db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT value FROM music_meta WHERE key='caller-marker'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get(), undefined, "caller rollback owns the new DDL");
    db.exec("BEGIN"); db.prepare("INSERT INTO music_meta(key,value)VALUES('caller-marker','committed')").run();
    ensureSchema(db, { configureConnection: false }); assert.equal(db.isTransaction, true); db.exec("COMMIT");
    assert.equal(db.prepare("SELECT value FROM music_meta WHERE key='caller-marker'").get().value, "committed");
    assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get().sql, original);
    db.exec("DROP INDEX main.idx_music_tracks_duration_sort; CREATE INDEX idx_music_tracks_duration_sort ON music_tracks(title)");
    const wrong = db.prepare("SELECT sql FROM sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get().sql; ensureSchema(db);
    assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get().sql, wrong, "same-name legacy index is neither dropped nor replaced");
    db.exec("DROP INDEX main.idx_music_tracks_duration_sort");
    const held = new Error("controlled native index-build failure"); fault = { kind: "index", error: held };
    assert.throws(() => ensureSchema(db), error => error === held); assert.equal(fault, null); errors++;
    ensureSchema(db);
    db.exec("DROP INDEX main.idx_music_tracks_duration_sort;PRAGMA busy_timeout=0");
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec("BEGIN IMMEDIATE"); const attempts = indexBuildAttempts;
      assert.throws(() => ensureSchema(db, { configureConnection: false }), error => Number(error.errcode) === 5,
        "a real competing writer's native index-build error is not swallowed");
      assert.equal(indexBuildAttempts, attempts + 1, "the real SQLITE_BUSY originates at this new index build"); errors++;
      writer.exec("ROLLBACK"); ensureSchema(db, { configureConnection: false });
    } finally { if (writer.isTransaction) writer.exec("ROLLBACK"); writer.close(); }
  } finally { db.close(); }
  for (const missing of ["duration_ms", "id"]) {
    const legacy = new DatabaseSync(":memory:");
    try {
      previousEnsureSchema(legacy); const declaration = legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='music_tracks'").get().sql;
      legacy.exec("ALTER TABLE music_tracks RENAME TO private_original_tracks");
      const columns = legacy.prepare("PRAGMA table_info(private_original_tracks)").all().filter(row => row.name !== missing);
      legacy.exec("CREATE TABLE music_tracks(" + columns.map(row => `"${row.name}" ${row.type}${row.name === "source_path" ? " UNIQUE" : ""}`).join(",") + "); DROP TABLE private_original_tracks");
      const failures = [];
      for (const initialize of [previousEnsureSchema, ensureSchema]) { try { initialize(legacy); failures.push(null); } catch (error) { failures.push([error.name, error.code, error.message]); } }
      assert.deepEqual(failures[1], failures[0], "legacy missing-column initialization keeps the original success/error");
      assert.equal(legacy.prepare("SELECT 1 FROM sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get(), undefined, "missing capability skips the new index");
      assert(declaration.includes("duration_ms")); comparisons++;
    } finally { legacy.close(); }
  }
  const shadow = new DatabaseSync(":memory:");
  try {
    previousEnsureSchema(shadow);
    shadow.exec("CREATE TEMP TABLE music_tracks AS SELECT * FROM main.music_tracks; ALTER TABLE temp.music_tracks DROP COLUMN duration_ms");
    previousEnsureSchema(shadow); ensureSchema(shadow);
    assert(shadow.prepare("SELECT sql FROM main.sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get(), "main capability creates main index despite TEMP table shadow");
    shadow.exec("DROP INDEX main.idx_music_tracks_duration_sort; CREATE TEMP TABLE decoy(title); CREATE INDEX temp.idx_music_tracks_duration_sort ON decoy(title)");
    ensureSchema(shadow); assert(shadow.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='idx_music_tracks_duration_sort'").get(), "TEMP index does not suppress the main index");
  } finally { shadow.close(); }
}

function verifyScale() {
  const baseline = open(noIndexFactory), current = open(testedFactory);
  for (const owner of [baseline, current]) {
    seed(owner, []);
    owner.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
      INSERT INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,genre,language,source_root,source_path,relative_path,file_name,ext,duration_ms,size_bytes,status,updated_at)
      SELECT printf('t%06d',x),'a0','al0',printf('Title %06d',x),'Artist 0','Album 0','Pop','中文','synthetic',printf('synthetic/%06d.mp3',x),printf('%06d.mp3',x),printf('%06d.mp3',x),'.mp3',1000000-x,x,'ok','same' FROM n`);
    owner.db.exec("UPDATE music_artists SET track_count=100000;UPDATE music_albums SET track_count=100000");
  }
  refresh([baseline, current]);
  const measurements = [];
  for (const query of ["sort=duration&limit=80", "sort=duration&limit=20&offset=80"]) {
    const before = measure(baseline, query), after = measure(current, query);
    assert.deepEqual(after.result, before.result, "performance compares the exact same policy/full current store"); assert.equal(JSON.stringify(after.result), JSON.stringify(before.result)); comparisons++;
    assert.equal(before.visit, 100000, "the unindexed same-policy page really visits the whole catalogue");
    // Both controls reach this gate after all output, policy and migration contracts.
    const bound = Number(new URLSearchParams(query).get("limit")) + Number(new URLSearchParams(query).get("offset") || 0);
    assert(after.visit <= bound, `duration index page candidates ${after.visit} <= ${bound} (LIMIT plus OFFSET)`);
    for (const key of ["artist", "album", "state"]) { assert.equal(before[key], 100000); assert(after[key] <= bound, "parent joins are bounded: " + key); }
    assert.equal(before.pages, 1); assert.equal(after.pages, 1);
    assert(before.plan.some(line => line.includes("USE TEMP B-TREE FOR ORDER BY")));
    assert(after.plan.some(line => line.includes("idx_music_tracks_duration_sort"))); assert(!after.plan.some(line => line.includes("TEMP B-TREE")));
    const clean = value => { const { result: _result, sql: _sql, bindings: _bindings, ...metrics } = value; return metrics; };
    measurements.push({ query, before: clean(before), after: clean(after) });
  }
  return measurements;
}

try {
  verifyHistoricalAndPolicy(); verifyNativeAndLegacy(); await verifyLegacyTitlePolicy(); verifyInitialization();
  console.log(`music duration contracts: ${comparisons} complete DTO/wire, ${policyCases} explicit-policy, ${errors} error PASS`);
  console.log(JSON.stringify({ fixture: "music-duration-sort", comparisons, policyCases, errors, measurements: verifyScale() }, null, 2));
} finally {
  work = null; fault = null;
  try { for (const owner of owners) await owner.store.stop(); }
  finally { DatabaseSync.prototype.prepare = savedPrepare; DatabaseSync.prototype.exec = savedExec; Date.now = savedNow; temporary.cleanup(); }
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { routeMusicApi } from "../src/modules/music/server/routes.js";
import { MUSIC_FACET_CACHE } from "../src/modules/music/server/constants.js";
import { insertMusicShortSearchRow, insertMusicPhoneticSearchRow } from "../src/modules/music/server/search.js";

// Keep the real factory, projection, search/count resolution, summaries and
// bindings. The response oracle restores only the preceding page predicates.
// It shares the new snapshot: concurrent old count/page disagreement is checked
// separately against an explicitly unpinned factory below.
const sourceUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
const guard = "const emptyPage = total === 0 || (offset >= total && trackCountBoundsPageRows(database));";
assert.equal(source.split(guard).length, 2);
const previousSource = source.replace(guard, "const emptyPage = false;");
async function factoryFrom(text) {
  const resolved = text.replace(/from "(\.\/[^"]+)"/gu, (_, relative) => "from " + JSON.stringify(new URL(relative, sourceUrl).href));
  return (await import("data:text/javascript;base64," + Buffer.from(resolved).toString("base64"))).createMusicStore;
}
const previousFactory = await factoryFrom(previousSource);
const totalCacheGate = "const reusableCount = !database.isTransaction;";
assert.equal(source.split(totalCacheGate).length, 2);
const withoutTotalCacheFactory = await factoryFrom(source.replace(totalCacheGate, "const reusableCount = false;"));
const zeroOnlyFactory = await factoryFrom(source.replace(guard, "const emptyPage = total === 0;"));
const unsafeFactory = await factoryFrom(source.replace(guard, "const emptyPage = total <= offset;"));
const referenceProof = 'return ["artist_id", "album_id"].every(key => trackColumns.some(column => column.name === key && column.type.toUpperCase() === "TEXT"));';
assert.equal(source.split(referenceProof).length, 2);
const ddlOnlyFactory = await factoryFrom(source.replace(referenceProof, "return true;"));
const unpinnedFactory = await factoryFrom(previousSource.replace('database.exec("SAVEPOINT music_track_page");', "")
  .replace('database.exec("RELEASE music_track_page");', ""));
assert(process.argv.slice(2).every(arg => ["--legacy-empty-pages", "--legacy-zero-only"].includes(arg)));
const factory = process.argv.includes("--legacy-empty-pages") ? previousFactory
  : process.argv.includes("--legacy-zero-only") ? zeroOnlyFactory : createMusicStore;
const savedPrepare = DatabaseSync.prototype.prepare, savedNow = Date.now;
const owners = [];
let opening = false, captured = null, measurement = null, fault = null, interleave = null, schemaOverride = null;
let clock = Date.parse("2026-11-04T12:00:00Z"), responseOracles = 0, errorOracles = 0;
const metrics = [], races = [];
Date.now = () => clock;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  if (opening) captured = this;
  const kind = sql.includes("FROM music_track_state s INDEXED BY") ? "helper"
    : sql.includes("FROM music_tracks t") && sql.includes("LIMIT ? OFFSET ?") && sql.includes("LEFT JOIN music_artists") ? "page"
      : /^SELECT COUNT\(\*\) AS count FROM music_(tracks|track_state)\b/u.test(sql) ? "count"
        : sql.includes("FROM pragma_data_version()") ? "totalStamp"
        : sql.startsWith("SELECT name, sql FROM sqlite_schema") || sql === "PRAGMA table_info(music_tracks)" ? "schema" : "other";
  const ownedFault = fault?.db === this && fault.kind === kind && (!fault.sql || fault.sql === sql);
  if (ownedFault && fault.phase === "prepare") throw fault.error;
  const measured = measurement?.db === this;
  if (measured) assert.equal(this.isTransaction, true, "all uncached response SQL stays inside the request snapshot");
  let executable = sql;
  if (ownedFault && fault.phase === "compile") executable = executable.replace("SELECT", "SELECT fixture_missing_column,");
  if (measured && measurement.probe && kind === "page") {
    executable = executable.replace("s.track_id = t.id", "s.track_id = fixture_empty_track_key(t.id)");
  }
  const statement = savedPrepare.call(this, executable, ...args), connection = this;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...parameters) => {
      if (ownedFault && key === fault.phase) throw fault.error;
      if (ownedFault && fault.phase === "bind" && ["get", "all"].includes(key)) parameters[0] = Symbol("invalid fixture binding");
      if (measurement?.db === connection && ((kind === "page" || kind === "helper") && key === "all" || (kind === "count" || kind === "totalStamp") && key === "get" || kind === "schema" && key === "all")) {
        measurement.executions.push({ kind, sql, parameters });
      }
      const result = value.apply(target, parameters);
      if (schemaOverride?.db === connection && kind === "schema" && key === "all") return schemaOverride.rows(result);
      if (interleave?.db === connection && interleave.kind === kind && interleave.method === key) {
        const pending = interleave; interleave = null; pending.run(result);
      }
      return result;
    };
  } });
};

try {
  const scale = pair(100000);
  await verifyCatalogueCountReuse(scale.current);
  for (const query of ["favorite=1", "favorite=1&sort=played", "minRating=4", "smart=recent"]) {
    const work = compare(scale, query + "&limit=80");
    assert.equal(work.current.result.total, 0);
    metrics.push(budget(query, work));
  }
  for (const owner of [scale.current, scale.previous]) owner.db.exec(`INSERT INTO music_track_state(track_id,favorite,rating,play_count,last_played_at,updated_at)
    SELECT id,1,5,1,'2026-01-01','2026-01-01' FROM music_tracks WHERE CAST(SUBSTR(id,2) AS INTEGER)%5000=0`);
  for (const query of ["favorite=1&offset=20", "favorite=1&offset=21", "favorite=1&sort=played&offset=20",
    "sort=duration&offset=100000", "sort=played&offset=100000", "offset=9007199254740991"]) {
    const work = compare(scale, query + "&limit=80");
    assert(work.current.result.total > 0);
    assert.equal(work.current.result.tracks.length, 0);
    metrics.push(budget(query, work));
  }
  const last = compare(scale, "favorite=1&offset=19&limit=1");
  assert.equal(last.current.result.tracks.length, 1);
  assert.equal(last.current.visits, last.previous.visits, "last nonempty page retains the former work");
  assert.equal(last.current.executions.filter(entry => entry.kind === "schema").length, 0, "ordinary pages do not inspect DDL");

  const selection = pair(64, true);
  for (const sort of ["album", "title", "artist", "duration", "played", "favorite", "rating", "unknown"]) {
    for (const extra of ["", "favorite=1&", "artist=a&", "genre=Pop&", "smart=hires&"]) {
      for (const offset of [0, 1, 64, 65]) compare(selection, `${extra}sort=${sort}&offset=${offset}&limit=7`);
    }
  }
  for (const q of ["周杰伦", "周杰仑", "zhoujielun", "zhoujielum", "晴", "NoSuchSyntheticArtist", "!!", "%", "_", "\\", "'"]) {
    for (const suffix of ["", "&offset=9999", "&sort=title", "&favorite=1"]) {
      compare(selection, "q=" + encodeURIComponent(q) + "&limit=3" + suffix);
    }
  }
  const phonetic = compare(selection, "q=" + encodeURIComponent("周杰仑") + "&limit=3").current.result;
  assert.equal(phonetic.searchMode, "phonetic"); assert(phonetic.total > 0, "zero direct matches must resolve before testing emptiness");
  const corrected = compare(selection, "q=zhoujielum&limit=3").current.result;
  assert.equal(corrected.correctedQuery, "zhoujielun"); assert(corrected.total > 0);

  for (const owner of [selection.current, selection.previous]) {
    owner.db.exec("ALTER TABLE music_tracks ADD COLUMN cover_updated_at TEXT DEFAULT 'legacy-cover';ALTER TABLE music_tracks RENAME COLUMN codec TO private_legacy_codec");
  }
  compare(selection, "offset=64&limit=3"); compare(selection, "limit=3");
  for (const owner of [selection.current, selection.previous]) owner.db.exec("ALTER TABLE music_tracks RENAME COLUMN private_legacy_codec TO codec");
  for (const value of [null, -1, 1.5, "4", "text", new Uint8Array([49])]) {
    for (const owner of [selection.current, selection.previous]) {
      owner.db.prepare("UPDATE music_track_state SET rating=?,favorite=?,play_count=?").run(value, value, value);
    }
    for (const query of ["minRating=4", "favorite=1", "smart=topplayed"]) compare(selection, query + "&offset=9999");
  }
  verifyLegacyJoinMultiplication();
  verifyNumericReferences();
  verifySchemaFallback(selection);
  verifyErrors(selection);
  await verifyWalRaces();
  console.log(JSON.stringify({ ok: true, responseOracles, errorOracles, tracks: 100000, metrics, races,
    scope: "private SQLite and synthetic metadata only; actual page/helper statements still compile, bind and execute" }, null, 2));
  for (const metric of metrics) {
    assert(metric.previousPageVisits >= 100000, "the former page must exercise catalogue-sized work");
    assert.equal(metric.pageVisits, 0, "empty and nonzero out-of-range pages do no catalogue hydration");
    assert.equal(metric.executedPages, 1, "empty pages still execute their actual SQL");
    if (metric.query.includes("sort=played")) assert.equal(metric.executedHelpers, 1, "played ID SQL still executes with the false predicate");
  }
} finally {
  measurement = null; fault = null; interleave = null; schemaOverride = null;
  try { for (const owner of owners) await owner.store.stop(); }
  finally { DatabaseSync.prototype.prepare = savedPrepare; Date.now = savedNow; }
}

function open(create, dbPath = ":memory:") {
  const store = create({ dbPath, roots: [], scanWorker: {
    start() { assert.fail("no scan worker in fixture"); }, scan() { assert.fail("no media scans in fixture"); }, async stop() {}
  } });
  opening = true; captured = null;
  try { store.summary(); } finally { opening = false; }
  assert(captured);
  const owner = { store, db: captured }; owners.push(owner);
  owner.db.function("fixture_empty_track_key", value => { if (measurement?.db === owner.db) measurement.visits++; return value; });
  return owner;
}
function pair(count, indexed = false) {
  const result = { current: open(factory), previous: open(previousFactory) };
  for (const owner of [result.current, result.previous]) seed(owner, count, indexed);
  refresh(result);
  return result;
}
function seed(owner, count, indexed = false) {
  const db = owner.db;
  db.prepare(`INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,updated_at)
    VALUES('a','周杰伦','fixture','fixture/artist','artist',?,'2026-01-01')`).run(count);
  db.prepare(`INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at)
    VALUES('al','a','Synthetic album','fixture','fixture/album','album',?,'2026-01-01')`).run(count);
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,track_no,disc_no,genre,language,
      source_root,source_path,relative_path,file_name,ext,duration_ms,codec,status,updated_at)
    SELECT printf('t%06d',x),'a','al',CASE WHEN x=1 THEN '晴天' ELSE printf('Title %06d',x%7) END,'周杰伦','Album',x%4,1,'Pop','中文',
      'fixture',printf('fixture/%06d.mp3',x),printf('%06d.mp3',x),printf('%06d.mp3',x),'.mp3',x%10*60000,'mp3','ok','2026-01-01' FROM n`);
  if (indexed) {
    const full = db.prepare("INSERT INTO music_search(track_id,title,artist,album,lyrics) VALUES(?,?,?,?,?)");
    const short = db.prepare("INSERT INTO music_search_short(track_id,title,artist,album,genre,file_name) VALUES(?,?,?,?,?,?)");
    const phonetic = db.prepare("INSERT INTO music_search_phonetic(track_id,artist_id,album_id,title,artist,album,file_name) VALUES(?,?,?,?,?,?,?)");
    for (const row of db.prepare("SELECT * FROM music_tracks").all()) {
      full.run(row.id, row.title, row.display_artist, row.album_title, "");
      insertMusicShortSearchRow(short, row); insertMusicPhoneticSearchRow(phonetic, row);
    }
  }
}
function refresh(pair) {
  clock += 6000;
  for (const owner of [pair.current, pair.previous]) {
    MUSIC_FACET_CACHE.delete(owner.db); owner.store.summary(); owner.store.facets();
  }
}
function read(owner, query) { return owner.store.listTracks(new URL("http://fixture/?" + query)); }
function measure(owner, query, probe = true) {
  measurement = { db: owner.db, visits: 0, executions: [], probe };
  try { return { result: read(owner, query), visits: measurement.visits, executions: measurement.executions }; }
  finally { measurement = null; assert.equal(owner.db.isTransaction, false, "request releases its read snapshot"); }
}
function compare(pair, query, probe = true) {
  const current = measure(pair.current, query, probe), previous = measure(pair.previous, query, probe);
  assert.deepEqual(current.result, previous.result, "complete preceding response: " + query);
  responseOracles++;
  return { current, previous };
}
function budget(query, work) {
  const pages = work.current.executions.filter(entry => entry.kind === "page");
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].parameters, work.previous.executions.find(entry => entry.kind === "page").parameters, "retain page bindings");
  return { query, total: work.current.result.total, pageVisits: work.current.visits, previousPageVisits: work.previous.visits,
    executedPages: pages.length, executedHelpers: work.current.executions.filter(entry => entry.kind === "helper").length };
}

async function verifyCatalogueCountReuse(current) {
  const previous = open(withoutTotalCacheFactory);
  seed(previous, 100000);
  refresh({ current, previous });
  const countQueries = execution => execution.kind === "count";
  const cold = measure(current, "limit=80", false);
  assert.equal(cold.executions.filter(countQueries).length, 1);
  const warm = measure(current, "limit=80&offset=80", false);
  assert.equal(warm.executions.filter(countQueries).length, 0);
  assert.equal(warm.executions.filter(item => item.kind === "totalStamp").length, 1);
  for (const query of ["artist=a&limit=80", "genre=Pop&limit=80"]) {
    const filtered = measure(current, query, false);
    assert.equal(filtered.executions.filter(countQueries).length, 1);
    assert.equal(filtered.executions.filter(item => item.kind === "totalStamp").length, 0);
  }
  async function route(owner, query) {
    const response = {};
    assert(await routeMusicApi({ method: "GET" }, response, new URL("http://fixture/api/music/tracks?" + query), {
      musicStore: owner.store,
      sendJson: (target, status, data) => Object.assign(target, { status, data })
    }));
    return response;
  }
  for (const query of ["limit=80", "limit=80&offset=80", "limit=80&offset=100000", "limit=80&sort=duration", "limit=80&artist=all&album=all"]) {
    assert.equal(JSON.stringify(await route(current, query)), JSON.stringify(await route(previous, query)), "complete catalogue route equals uncached count");
  }
  const beforeTimes = [], afterTimes = [];
  async function sample(owner, offset, expectedCounts, times) {
    const start = performance.now();
    measurement = { db: owner.db, visits: 0, executions: [], probe: false };
    try {
      const response = await route(owner, `limit=80&offset=${offset}`);
      times.push(performance.now() - start);
      assert.equal(response.status, 200);
      assert.equal(response.data.total, 100000);
      assert.equal(measurement.executions.filter(countQueries).length, expectedCounts);
    } finally { measurement = null; }
  }
  for (let round = 0; round < 11; round++) {
    const offset = round * 80;
    if (round % 2) await sample(current, offset, 0, afterTimes);
    await sample(previous, offset, 1, beforeTimes);
    if (!(round % 2)) await sample(current, offset, 0, afterTimes);
  }
  const median = values => +values.sort((a, b) => a - b)[5].toFixed(3);
  console.log(JSON.stringify({ check: "music-catalogue-count-reuse", tracks: 100000, pageSize: 80, requests: 11,
    beforeCountExecutions: 11, afterCountExecutions: 0, beforeMedianMs: median(beforeTimes), afterMedianMs: median(afterTimes), fullRouteOracle: true }));
}

function verifyLegacyJoinMultiplication() {
  for (const table of ["music_track_state", "music_artists", "music_albums"]) for (const keyType of ["BLOB", "NOCASE-column-BINARY-primary-key"]) {
    const current = open(factory), previous = open(previousFactory), unsafe = open(unsafeFactory);
    for (const owner of [current, previous, unsafe]) {
      seed(owner, 1);
      owner.db.exec("UPDATE music_tracks SET id='1',artist_id='2',album_id='3'");
      owner.db.exec("UPDATE music_artists SET id='2';UPDATE music_albums SET id='3'");
      if (keyType === "BLOB") {
        // NUMERIC affinity on the reference can compare separately unique
        // text/integer BLOB keys as equal. Keep the ordinary id key for the
        // artist/album cases so their own key proof is independently required.
        const reference = table === "music_track_state" ? "id" : table === "music_artists" ? "artist_id" : "album_id";
        const trackColumns = owner.db.prepare("PRAGMA table_info(music_tracks)").all();
        owner.db.exec("ALTER TABLE music_tracks RENAME TO private_old_tracks;CREATE TABLE music_tracks("
          + trackColumns.map(column => `"${column.name}" ${column.name === reference ? "INTEGER" : column.name === "id" ? "TEXT PRIMARY KEY" : column.type}`).join(",")
          + ");INSERT INTO music_tracks SELECT * FROM private_old_tracks;DROP TABLE private_old_tracks");
      }
      const key = table === "music_track_state" ? "track_id" : "id";
      const original = owner.db.prepare("PRAGMA table_info(" + table + ")").all();
      const columns = original.map(column => `"${column.name}" ${column.name === key ? keyType === "BLOB" ? "BLOB UNIQUE" : "TEXT COLLATE NOCASE" : column.type}`);
      if (keyType !== "BLOB") columns.push(`PRIMARY KEY(${key} COLLATE BINARY)`);
      owner.db.exec("DROP TABLE " + table + ";CREATE TABLE " + table + "(" + columns.join(",") + ")");
      const id = table === "music_track_state" ? "1" : table === "music_artists" ? "2" : "3";
      if (keyType === "BLOB") {
        for (const value of [id, Number(id)]) owner.db.prepare("INSERT INTO " + table + "(" + key + ") VALUES(?)").run(value);
      } else {
        // A column collation can compare two separately BINARY-unique keys as
        // equal. Its normal-looking TEXT affinity alone proves nothing.
        const alpha = table === "music_track_state" ? "track" : table === "music_artists" ? "artist" : "album";
        const target = table === "music_track_state" ? "id" : table === "music_artists" ? "artist_id" : "album_id";
        owner.db.prepare("UPDATE music_tracks SET " + target + "=?").run(alpha);
        for (const value of [alpha, alpha.toUpperCase()]) owner.db.prepare("INSERT INTO " + table + "(" + key + ") VALUES(?)").run(value);
      }
    }
    const compared = compare({ current, previous }, "limit=1&offset=1", false);
    assert.equal(compared.current.result.total, 1);
    assert.equal(compared.current.result.tracks.length, 1, `a legacy ${table}/${keyType} LEFT JOIN can keep a page after the old COUNT boundary`);
    assert(!compared.current.executions.find(entry => entry.kind === "page").sql.includes(" AND 0"));
    assert.equal(read(unsafe, "limit=1&offset=1").tracks.length, 0, "the naive count guard must fail this genuine native-schema control");
  }
}

function verifySchemaFallback(pair) {
  for (const declaration of [
    "/* id TEXT PRIMARY KEY, */ CREATE TABLE music_tracks(id BLOB PRIMARY KEY, title TEXT)",
    "CREATE TABLE music_tracks_fake(id TEXT PRIMARY KEY, title TEXT)",
    "CREATE TABLE music_tracks AS SELECT 'id TEXT PRIMARY KEY,' AS id",
    "CREATE TABLE music_tracks(/* id TEXT PRIMARY KEY, */ id BLOB PRIMARY KEY,title TEXT)",
    "CREATE TABLE music_tracks(id TEXT COLLATE NOCASE,title TEXT,PRIMARY KEY(id COLLATE BINARY))"
  ]) {
    schemaOverride = { db: pair.current.db, rows: rows => rows.map(row => row.name === "music_tracks" ? { ...row, sql: declaration } : row) };
    const work = compare(pair, "offset=64&limit=3");
    assert(!work.current.executions.find(entry => entry.kind === "page").sql.includes(" AND 0"), "unrecognized DDL retains the former page");
    schemaOverride = null;
  }
  const probes = compare(pair, "offset=64&limit=3").current.executions.filter(entry => entry.kind === "schema").map(entry => entry.sql);
  assert.equal(probes.length, 2, "normal nonzero empty pages inspect key and reference declarations");
  for (const sql of probes) for (const phase of ["prepare", "all"]) {
    fault = { db: pair.current.db, kind: "schema", sql, phase, error: new Error("optional schema probe unavailable") };
    const work = compare(pair, "offset=64&limit=3");
    assert(!work.current.executions.find(entry => entry.kind === "page").sql.includes(" AND 0"));
    fault = null;
  }
}

function verifyNumericReferences() {
  for (const reference of ["artist_id", "album_id"]) for (const affinity of ["INTEGER", "NUMERIC", "REAL"]) {
    const current = open(factory), previous = open(previousFactory), ddlOnly = open(ddlOnlyFactory);
    for (const owner of [current, previous, ddlOnly]) {
      seed(owner, 1);
      const columns = owner.db.prepare("PRAGMA table_info(music_tracks)").all();
      owner.db.exec("ALTER TABLE music_tracks RENAME TO private_old_tracks;CREATE TABLE music_tracks("
        + columns.map(column => `"${column.name}" ${column.name === reference ? affinity : column.name === "id" ? "TEXT PRIMARY KEY" : column.type}`).join(",")
        + ");INSERT INTO music_tracks SELECT * FROM private_old_tracks;DROP TABLE private_old_tracks");
      owner.db.prepare("UPDATE music_tracks SET " + reference + "=1").run();
      if (reference === "artist_id") {
        const insert = owner.db.prepare("INSERT INTO music_artists(id,name,source_root,source_path,relative_path,updated_at) VALUES(?,?,'fixture',?,'synthetic','2026-01-01')");
        for (const id of ["1", "01"]) insert.run(id, "Synthetic artist " + id, "fixture/artist/" + id);
      } else {
        const insert = owner.db.prepare("INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,updated_at) VALUES(?,'a',?,'fixture',?,'synthetic','2026-01-01')");
        for (const id of ["1", "01"]) insert.run(id, "Synthetic album " + id, "fixture/album/" + id);
      }
    }
    const work = compare({ current, previous }, "limit=1&offset=1", false);
    assert.equal(work.current.result.total, 1);
    assert.equal(work.current.result.tracks.length, 1, `${affinity} ${reference} can match two normal TEXT primary keys`);
    assert(!work.current.executions.find(entry => entry.kind === "page").sql.includes(" AND 0"));
    assert.equal(read(ddlOnly, "limit=1&offset=1").tracks.length, 0, "the genuine key-only proof must fail without checking reference affinity");
  }
}

function verifyErrors(pair) {
  for (const kind of ["count", "page", "helper"]) for (const phase of kind === "count" ? ["prepare", "get"] : ["prepare", "all", "compile", "bind"]) {
    for (const query of ["favorite=1&limit=3", "sort=played&offset=64&limit=3"]) {
      if (kind === "helper" && !query.includes("sort=played")) continue;
      const error = Object.assign(new Error("controlled " + kind + " " + phase), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      const errors = [];
      for (const owner of [pair.current, pair.previous]) {
        if (kind === "count" && query.includes("sort=played")) owner.db.exec("UPDATE music_tracks SET status=status WHERE id='t000001'");
        fault = { db: owner.db, kind, phase, error };
        let caught;
        try { read(owner, query); } catch (failure) { caught = failure; }
        finally { fault = null; }
        assert(caught, "the page/helper/count still produces its former error");
        assert.equal(owner.db.isTransaction, false, "errors release the request snapshot");
        errors.push([caught.name, caught.code, caught.errcode, caught.message]);
      }
      assert.deepEqual(errors[0], errors[1]); errorOracles++;
    }
  }
  for (const owner of [pair.current, pair.previous]) owner.db.exec("DROP INDEX idx_music_track_state_played");
  const errors = [pair.current, pair.previous].map(owner => {
    try { read(owner, "favorite=1&sort=played"); } catch (error) { return [error.message, error.code]; }
    assert.fail("even an empty page retains the helper's missing-index error");
  });
  assert.deepEqual(errors[0], errors[1]); errorOracles++;
  for (const owner of [pair.current, pair.previous]) owner.db.exec("CREATE INDEX idx_music_track_state_played ON music_track_state(last_played_at)");
  compare(pair, "favorite=1&sort=played");
}

async function verifyWalRaces() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-empty-pages-"));
  const dbPath = path.join(directory, "private.sqlite");
  const current = open(factory, dbPath), previous = open(previousFactory, dbPath), unpinned = open(unpinnedFactory, dbPath);
  const writer = new DatabaseSync(dbPath);
  try {
    seed({ db: writer }, 3);
    for (const offset of [0, 1]) {
      const responses = [];
      for (const owner of [current, previous, unpinned]) {
        writer.exec("DELETE FROM music_track_state");
        if (offset) writer.exec("INSERT INTO music_track_state(track_id,favorite,updated_at) VALUES('t000001',1,'2026-01-01')");
        interleave = { db: owner.db, kind: "count", method: "get", run() {
          writer.prepare("INSERT INTO music_track_state(track_id,favorite,updated_at) VALUES(?,1,'2026-01-01')").run(offset ? "t000002" : "t000001");
        } };
        responses.push(read(owner, "favorite=1&offset=" + offset + "&limit=1"));
        assert.equal(interleave, null, "the writer commits immediately after the genuine COUNT");
        assert.equal(owner.db.isTransaction, false);
        const next = read(owner, "favorite=1&offset=" + offset + "&limit=1");
        assert.equal(next.total, offset + 1); assert.equal(next.tracks.length, 1, "next request observes the external commit");
      }
      assert.deepEqual(responses[0], responses[1]); responseOracles++;
      assert.equal(responses[0].total, offset); assert.equal(responses[0].tracks.length, 0);
      assert.equal(responses[2].total, offset); assert.equal(responses[2].tracks.length, 1, "the old split snapshots must detect this race");
      races.push({ offset, count: offset, pinnedRows: 0, oldUnpinnedRows: 1, nextRequestRows: 1 });
    }
    // The played selector and DTO hydration remain inside the same expanded
    // snapshot, including state fields changed after IDs have been selected.
    writer.exec("DELETE FROM music_track_state;INSERT INTO music_track_state(track_id,position_ms,last_played_at,updated_at) SELECT id,100,'2026-01-01','2026-01-01' FROM music_tracks");
    const before = read(current, "sort=played&limit=1");
    interleave = { db: current.db, kind: "helper", method: "all", run() {
      writer.exec("UPDATE music_track_state SET position_ms=999,last_played_at='2099-01-01'");
    } };
    const pinned = read(current, "sort=played&limit=1");
    assert.equal(interleave, null); assert.deepEqual(pinned, before);
    assert.equal(read(current, "sort=played&limit=1").tracks[0].positionMs, 999);
    races.push({ playedIdToDtoSnapshot: true, nextRequestSeesNewPosition: true });

    const query = "sort=title&limit=1";
    const beforeCountReuse = read(current, query);
    interleave = { db: current.db, kind: "totalStamp", method: "get", run() {
      writer.prepare("UPDATE music_tracks SET status='missing' WHERE id=?").run(beforeCountReuse.tracks[0].id);
    } };
    assert.deepEqual(read(current, query), beforeCountReuse, "a warm exact total and its page remain in the same WAL snapshot");
    assert.equal(interleave, null);
    const afterCommit = read(current, query);
    assert.equal(afterCommit.total, 2);
    assert.notEqual(afterCommit.tracks[0].id, beforeCountReuse.tracks[0].id);

    current.db.exec("BEGIN; UPDATE music_tracks SET status='missing';");
    try {
      assert.equal(read(current, query).total, 0, "nested read sees the outer transaction's current changes");
      assert.equal(current.db.isTransaction, true);
    } finally { current.db.exec("ROLLBACK"); }
    assert.equal(read(current, query).total, 2, "a rolled-back total cannot leak from the nested snapshot");

    current.db.exec("CREATE TEMP VIEW music_tracks AS SELECT * FROM main.music_tracks WHERE id='t000002';");
    try {
      const shadow = measure(current, query, false);
      const expected = current.db.prepare("SELECT COUNT(*) AS count FROM temp.music_tracks WHERE status='ok'").get().count;
      assert.equal(shadow.result.total, expected);
      assert.equal(shadow.executions.filter(item => item.kind === "count").length, 1, "a TEMP source uses the original COUNT");
    } finally { current.db.exec("DROP VIEW temp.music_tracks"); }
    assert.equal(read(current, query).total, 2);
    current.db.exec("UPDATE music_tracks SET status='ok'");
    assert.equal(read(current, query).total, 3, "same-connection writes invalidate the exact total");
    races.push({ catalogueCountHitPinsSnapshot: true, externalCommit: true, localCommit: true, nestedRollback: true, tempShadow: true });
  } finally {
    interleave = null;
    for (const owner of [current, previous, unpinned]) await owner.store.stop();
    writer.close();
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = path.resolve(dbPath + suffix);
      assert.equal(path.dirname(file), path.resolve(directory));
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    fs.rmdirSync(directory);
  }
}

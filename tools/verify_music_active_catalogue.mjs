import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import { SMART_MIXES } from "../src/modules/music/server/smart-mix.js";
import { MUSIC_FACET_CACHE, REDISCOVER_DAYS } from "../src/modules/music/server/constants.js";
import { routeMusicApi } from "../src/modules/music/server/routes.js";
import { TRACK_LIST_COLUMNS } from "../src/modules/music/server/track-query.js";

const smartListCounts = await verifySmartListCounts();

// Actual scans of synthetic metadata preserve old listening/rating state.
// No worker, media, running service or user database participates.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-active-catalogue-"));
const dbPath = path.join(directory, "catalog.sqlite");
const database = new DatabaseSync(dbPath);
ensureSchema(database);
const store = createMusicStore({ dbPath, roots: [] });
const metrics = {};
let scenarios = 0;
try {
  publish(Array.from({ length: 100 }, (_, id) => id));
  for (let id = 0; id < 10; id++) store.saveProgress(`track-${id}`, { played: true, positionMs: 12000 });
  for (let id = 5; id < 15; id++) store.setRating(`track-${id}`, { rating: 4 });
  assertCounts({ unplayed: 90, unrated: 90 });
  scenarios++;

  // Five listened songs remain, while all ten rated songs leave the scan.
  publish([...Array.from({ length: 5 }, (_, id) => id), ...Array.from({ length: 10 }, (_, id) => id + 15)]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM music_track_state").get().count, 15);
  assertCounts({ unplayed: 10, unrated: 15 });
  metrics.removedSongs = { activeTracks: 15, retainedHistoryRows: 15, unplayed: 10, unrated: 15 };
  scenarios++;

  // Original stable IDs restore their listening and rating rather than resetting.
  publish(Array.from({ length: 25 }, (_, id) => id));
  assertCounts({ unplayed: 15, unrated: 15 });
  assert.equal(store.trackDetail("track-5").track.playCount, 1);
  assert.equal(store.trackDetail("track-5").track.rating, 4);
  scenarios++;

  // A dated listening marker also excludes a song from the unplayed collection.
  database.prepare("UPDATE music_track_state SET play_count=0,last_played_at='2026-10-04' WHERE track_id='track-5'").run();
  database.prepare("UPDATE music_track_state SET rating=0 WHERE track_id='track-6'").run();
  store.invalidate();
  assertCounts({ unplayed: 15, unrated: 16 });
  scenarios++;

  // Missing rows and non-active statuses do not consume counts in the live catalogue.
  database.prepare("UPDATE music_tracks SET status='missing' WHERE id='track-5'").run();
  database.prepare("UPDATE music_artists SET track_count=track_count-1").run();
  database.prepare("UPDATE music_albums SET track_count=track_count-1").run();
  store.invalidate();
  assertCounts({ unplayed: 15, unrated: 16 });
  scenarios++;

  publish([]);
  assertCounts({ unplayed: 0, unrated: 0 });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM music_track_state").get().count, 15);
  scenarios++;
  await verifySmartDetailCounts();
  console.log(JSON.stringify({ ok: true, scenarios, ...metrics, smartListCounts }, null, 2));
} finally {
  await store.stop();
  database.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = dbPath + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(directory);
}

function assertCounts(expected) {
  const badges = store.listSmartPlaylists().smartPlaylists;
  for (const [id, count] of Object.entries(expected)) {
    const badge = badges.find(item => item.id === id);
    const detail = store.smartPlaylistDetail(id, new URL("http://fixture?limit=1000"));
    const filtered = store.listTracks(new URL(`http://fixture?smart=${id}&limit=300`));
    assert.equal(detail.total, count, `${id}: actual detail establishes the active population`);
    assert.equal(badge.trackCount, count, `${id}: badge must exclude retained state for absent songs`);
    assert.equal(filtered.total, count, `${id}: filtered list and collection must agree`);
    assert.equal(detail.tracks.length, count);
  }
}

function publish(ids) {
  const updatedAt = "2026-10-04T00:00:00.000Z";
  const durationMs = 180000;
  const records = {
    artists: ids.length ? [{ id: "artist", name: "Synthetic", sortName: "Synthetic", language: "英文", sourceRoot: directory,
      sourcePath: directory, relativePath: "artist", albumCount: 1, trackCount: ids.length,
      durationMs: ids.length * durationMs, sizeBytes: ids.length, updatedAt }] : [],
    albums: ids.length ? [{ id: "album", artistId: "artist", title: "Album", sortTitle: "Album", year: "2026",
      coverPath: "", introPath: "", introText: "", sourceRoot: directory, sourcePath: directory, relativePath: "album",
      trackCount: ids.length, durationMs: ids.length * durationMs, sizeBytes: ids.length, updatedAt }] : [],
    tracks: ids.map(id => ({ id: `track-${id}`, artistId: "artist", albumId: "album", title: `Track ${id}`,
      sortTitle: `Track ${id}`, displayArtist: "Synthetic", albumTitle: "Album", trackNo: id + 1, discNo: 1,
      genre: "Pop", language: "英文", sourceRoot: directory, sourcePath: path.join(directory, `${id}.audio`),
      relativePath: `${id}.audio`, fileName: `${id}.audio`, ext: ".audio", sizeBytes: 1, mtimeMs: 1,
      durationMs, codec: "synthetic", sampleRate: 44100, bitDepth: 16, channels: 2, lrcPath: "", hasLrc: 0,
      status: "ok", error: "", updatedAt })), lyrics: []
  };
  writeScanRecords(database, records, [directory], updatedAt);
  store.invalidate();
}

async function verifySmartDetailCounts() {
  const stateMixes = ["recent", "topplayed", "favorites", "toprated", "rediscover"];
  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const source = fs.readFileSync(storeUrl, "utf8").replaceAll("\r\n", "\n");
  const countBlock = `    const countFrom = smartMixRequiresState(mix)
      ? "music_track_state s CROSS JOIN music_tracks t ON t.id = s.track_id"
      : isMetadataOnlySmartMix(mix)
        ? "music_tracks t"
        : "music_tracks t LEFT JOIN music_track_state s ON s.track_id = t.id";
    const total = database.prepare(\`SELECT COUNT(*) AS count FROM \${countFrom} \${where}\`).get(...condition.args)?.count || 0;`;
  assert.equal(source.split(countBlock).length, 2);
  // Restore only the complete former count SQL. Rows/ORDER BY, serializers,
  // summaries, facets and the real factory remain unchanged in this oracle.
  const previousSource = source.replace(countBlock,
    "    const total = database.prepare(`SELECT COUNT(*) AS count FROM music_tracks t LEFT JOIN music_track_state s ON s.track_id = t.id ${where}`).get(...condition.args)?.count || 0;")
    .replace(/from "(\.\/[^"]+)"/gu, (_, relative) => `from ${JSON.stringify(new URL(relative, storeUrl).href)}`);
  const { createMusicStore: previousFactory } = await import(`data:text/javascript;base64,${Buffer.from(previousSource).toString("base64")}`);
  const factory = process.argv.includes("--legacy-smart-detail-count") ? previousFactory : createMusicStore;
  const originalPrepare = DatabaseSync.prototype.prepare, originalNow = Date.now;
  const connections = [], privateStores = [];
  let clock = 1800000000000, measuring = null;
  Date.now = () => clock;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (!connections.includes(this)) {
      connections.push(this);
      this.function("fixture_active_track_visit", value => { if (measuring?.db === this) measuring.visits++; return value; });
    }
    const text = sql.replace(/\s+/gu, " ").trim();
    const count = /^SELECT COUNT\(\*\) AS count FROM music_(tracks|track_state)/u.test(text) && text.includes("WHERE t.status = 'ok' AND");
    const page = (text.startsWith("SELECT t.*,") || text.startsWith(`SELECT ${TRACK_LIST_COLUMNS},`)) && text.includes("WHERE t.status = 'ok' AND");
    if (measuring?.db === this && count) {
      // Retain the original indexed status predicate. The identity callback
      // observes SQLite candidate visits without replacing that index filter.
      sql = sql.replace("t.status = 'ok'", "t.status = 'ok' AND fixture_active_track_visit(t.status) = 'ok'");
    }
    const statement = originalPrepare.call(this, sql, ...args);
    if (!measuring || (!count && !page)) return statement;
    const connection = this;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...parameters) => {
        if (measuring?.db === connection && ["get", "all"].includes(key)) {
          measuring.executions.push({ count, parameters });
        }
        return value.apply(target, parameters);
      };
    } });
  };
  function open(targetFactory) {
    const target = targetFactory({ dbPath: ":memory:", roots: [], scanWorker: {
      start() { assert.fail("no worker start"); }, scan() { assert.fail("no scan"); }, async stop() {}
    } });
    privateStores.push(target); target.summary();
    const db = connections.at(-1);
    db.prepare("INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) VALUES('artist','Synthetic','/synthetic','/synthetic/artist','artist',38918,'ok','2026')").run();
    db.prepare("INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at) VALUES('album','artist','Album','/synthetic','/synthetic/album','album',38918,'2026')").run();
    const track = db.prepare("INSERT INTO music_tracks(id,artist_id,album_id,title,album_title,track_no,source_root,source_path,relative_path,file_name,ext,duration_ms,status,updated_at) VALUES(?,'artist','album',?,'Album',?,'/synthetic',?,?,?,'audio',1234,?,'2026')");
    const state = db.prepare("INSERT INTO music_track_state(track_id,favorite,rating,position_ms,duration_ms,play_count,last_played_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    for (let i = 0; i < 40000; i++) track.run(`t${i}`, i < 10 ? "Tied title" : `Track ${String(i).padStart(6, "0")}`,
      i < 10 ? 0 : i, `/synthetic/${i}`, `${i}.audio`, `${i}.audio`, i % 37 === 0 ? "missing" : "ok");
    for (let i = 0; i < 120; i++) state.run(`t${i * 311}`, i % 2, i % 6, i * 100, 5678, i % 4, i % 3 ? "2026-01-01" : "", "2026-02-01");
    state.run("orphan", 1, 5, 123, 456, 7, "2026-01-01", "2026-02-01");
    const cutoff = clock + 10000 - REDISCOVER_DAYS * 24 * 60 * 60 * 1000;
    for (const [i, delta] of [[39980, 0], [39981, -1], [39982, 1]]) state.run(`t${i}`, 1, 5, 123, 456, 7, new Date(cutoff + delta).toISOString(), "2026-02-01");
    state.run("t39983", null, null, 0, 0, null, null, "2026-02-01");
    db.exec("COMMIT");
    MUSIC_FACET_CACHE.delete(db);
    return { store: target, db };
  }
  function measure(target, mix, url) {
    measuring = { db: target.db, visits: 0, executions: [] };
    try { const result = target.store.smartPlaylistDetail(mix, url); return { result, ...measuring }; }
    finally { measuring = null; }
  }
  try {
    const current = open(factory), previous = open(previousFactory);
    clock += 10000;
    current.store.summary(); previous.store.summary();
    let responseOracles = 0;
    for (const mix of SMART_MIXES) for (const limit of [1, 7, 100]) for (const offset of [0, 5, 100, 40000]) {
      const url = new URL(`http://fixture?limit=${limit}&offset=${offset}`);
      assert.equal(JSON.stringify(current.store.smartPlaylistDetail(mix.id, url)), JSON.stringify(previous.store.smartPlaylistDetail(mix.id, url)),
        `full old response and tied row order ${mix.id}/${limit}/${offset}`);
      responseOracles++;
    }
    const visits = [];
    for (const id of stateMixes) {
      const url = new URL("http://fixture?limit=7&offset=5");
      const currentWork = measure(current, id, url), previousWork = measure(previous, id, url);
      assert.equal(JSON.stringify(currentWork.result), JSON.stringify(previousWork.result));
      assert.equal(previousWork.visits, 38918, "the restored count really visits the full active track population");
      assert.ok(currentWork.visits <= 125, `${id}: the count visits at most the 125 retained state rows, independent of 40,000 catalog tracks`);
      assert.deepEqual(currentWork.executions.map(query => query.count), [true, false], "one count and one unchanged page query");
      visits.push({ id, previous: previousWork.visits, current: currentWork.visits, total: currentWork.result.total });
    }
    metrics.smartDetailCounts = { tracks: 40000, stateRows: 125, responseOracles, visits };
    scenarios++;

    Date.now = () => clock++;
    const rediscover = measure(current, "rediscover", new URL("http://fixture?limit=1000"));
    assert.equal(rediscover.executions[0].parameters[0], rediscover.executions[1].parameters[0], "count and rows share one cutoff even while the clock advances");
    assert.ok(!rediscover.result.tracks.some(track => ["t39980", "t39982"].includes(track.id)), "exact/after-cutoff rows are excluded");
    assert.ok(rediscover.result.tracks.some(track => track.id === "t39981"), "the one millisecond older row is included");
    Date.now = () => clock;
    scenarios++;

    for (const sql of [
      "UPDATE music_track_state SET favorite=1,rating=5,play_count=8 WHERE track_id='t311'",
      "UPDATE music_tracks SET status='error' WHERE id='t311'",
      "UPDATE music_tracks SET status='ok' WHERE id='t311'",
      "DELETE FROM music_track_state WHERE track_id='t311'",
      "INSERT INTO music_track_state(track_id,favorite,rating,play_count,last_played_at,updated_at) VALUES('t311',1,5,8,'2026-01-01','2026-02-01')"
    ]) {
      current.db.exec(sql); previous.db.exec(sql);
      for (const id of stateMixes) {
        const url = new URL("http://fixture?limit=1000");
        const response = current.store.smartPlaylistDetail(id, url);
        assert.equal(JSON.stringify(response), JSON.stringify(previous.store.smartPlaylistDetail(id, url)), "fresh state/removal/restoration keeps all old response fields");
        assert.equal(response.total, response.tracks.length);
        responseOracles++;
      }
    }
    metrics.smartDetailCounts.responseOracles = responseOracles;
    scenarios++;
  } finally {
    measuring = null;
    try { for (const target of privateStores) await target.stop(); }
    finally { DatabaseSync.prototype.prepare = originalPrepare; Date.now = originalNow; }
  }
}
async function verifySmartListCounts() {
  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const source = fs.readFileSync(storeUrl, "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("  function listSmartPlaylists() {");
  const end = source.indexOf("\n  function smartPlaylistDetail(", start);
  assert.ok(start >= 0 && end > start, "the complete actual list entry exists");
  const currentBlock = source.slice(start, end).trimEnd();
  const previousBlock = [
    "  function listSmartPlaylists() {",
    "    const database = dbOrOpen();",
    "    const smartPlaylists = SMART_MIXES.map((mix) => publicSmartPlaylist(mix, smartMixCount(database, mix)));",
    "    return {",
    "      smartPlaylists,",
    "      total: smartPlaylists.length,",
    "      summary: summary()",
    "    };",
    "  }"
  ].join("\n");
  assert.notEqual(currentBlock, previousBlock, "legacy restores the former complete list function");
  assert.equal(source.split(currentBlock).length, 2);
  const restored = source.replace(currentBlock, previousBlock);
  assert.equal(restored.replace(previousBlock, currentBlock), source, "only the complete list entry changes in the old oracle");
  const previousSource = restored.replace(/from "(\.\/[^"]+)"/gu,
    (_, relative) => "from " + JSON.stringify(new URL(relative, storeUrl).href));
  const { createMusicStore: previousFactory } = await import("data:text/javascript;base64," + Buffer.from(previousSource).toString("base64"));
  const factory = process.argv.includes("--legacy-smart-list-count") ? previousFactory : createMusicStore;
  const originalPrepare = DatabaseSync.prototype.prepare, originalNow = Date.now;
  const owners = [], budgets = [];
  let clock = Date.parse("2026-10-04T12:00:00Z"), opening = false, captured = null, measuring = null;
  let failureKind = null, failure = new Error("synthetic smart list SQL error"), dateEvents = null;
  let responseOracles = 0;
  Date.now = () => clock;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (opening) captured = this;
    const dynamicCount = /COUNT\(/u.test(sql)
      && /FROM music_track_state s\s+CROSS JOIN music_tracks t ON t.id\s*=\s*s.track_id[\s\S]*WHERE t.status\s*=\s*'ok'/u.test(sql);
    const instrumented = measuring?.db === this && measuring.probe && dynamicCount
      ? sql.replace(/t\.id\s*=\s*s\.track_id/u, "t.id=fixture_smart_track_id(s.track_id)") : sql;
    const statement = originalPrepare.call(this, instrumented, ...args), connection = this;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!["all", "get"].includes(key)) return value.bind(target);
      return (...parameters) => {
        const artistTotal = /SUM\(track_count\).*AS count FROM music_artists/u.test(sql);
        const staticMeta = /FROM music_meta WHERE key =/u.test(sql) && parameters[0] === "smart_static_counts_json";
        const fallback = /SELECT COUNT\(\*\) AS count[\s\S]*FROM music_tracks t\s+WHERE t.status/u.test(sql);
        if (dateEvents && staticMeta) dateEvents.push("static");
        if (dateEvents && /s.last_played_at < \?/u.test(sql)) dateEvents.push("rediscover SQL");
        if (failureKind && ((failureKind === "state" && dynamicCount) || (failureKind === "artist" && artistTotal)
          || (failureKind === "static" && staticMeta) || (failureKind === "fallback" && fallback))) throw failure;
        if (measuring?.db === connection) measuring.executions.push({ sql, parameters, dynamicCount, artistTotal });
        return value.apply(target, parameters);
      };
    } });
  };
  function open(targetFactory) {
    const target = targetFactory({ dbPath: ":memory:", roots: [] });
    opening = true; captured = null;
    try { target.summary(); } finally { opening = false; }
    assert.ok(captured, "capture the actual schema owner without a test export");
    const owner = { store: target, db: captured }; owners.push(owner);
    owner.db.function("fixture_smart_track_id", value => {
      if (measuring?.db === owner.db) measuring.visits++;
      return value;
    });
    return owner;
  }
  function seed(owner, size, kind = "dense") {
    const { db } = owner;
    db.exec("BEGIN;DELETE FROM music_track_state;DELETE FROM music_tracks;DELETE FROM music_artists;DELETE FROM music_albums;DELETE FROM music_meta;");
    db.prepare("INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) VALUES('a','Synthetic','','a','a',?,'ok','2026-10-04')").run(size);
    db.prepare("INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at) VALUES('al','a','Album','','al','al',?,'2026-10-04')").run(size);
    if (size) db.exec("WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1<" + size
      + ") INSERT INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,track_no,disc_no,genre,source_root,source_path,relative_path,file_name,ext,duration_ms,codec,sample_rate,bit_depth,has_lrc,status,updated_at)"
      + " SELECT 't'||x,'a','al','Track '||x,'Synthetic','Album',x,1,'Pop','','synthetic://track/'||x,'t'||x,'song'||x||'.flac','.flac',CASE WHEN x%2=0 THEN 350000 ELSE 180000 END,'flac',48000,24,x%2,CASE WHEN x%23=0 THEN 'missing' ELSE 'ok' END,'2026-10-04' FROM n");
    if (kind !== "empty") {
      const x = "CAST(substr(id,2) AS INTEGER)";
      db.exec("INSERT INTO music_track_state(track_id,favorite,rating,play_count,last_played_at,updated_at)"
        + " SELECT id,CASE WHEN " + x + "%3=0 THEN 1 ELSE 0 END,CASE WHEN " + x + "%5=0 THEN 0 ELSE " + x + "%6 END,"
        + "CASE WHEN " + x + "%4=0 THEN 0 ELSE " + x + "%9 END,CASE WHEN " + x
        + "%4=0 THEN '' WHEN " + x + "%7=0 THEN NULL WHEN " + x + "%2=0 THEN '2026-09-04T12:00:00.000Z' ELSE '2026-10-02T01:00:00Z' END,'2026-10-04' FROM music_tracks"
        + (kind === "sparse" ? " WHERE " + x + "%100=0" : ""));
      if (kind === "zero") db.exec("UPDATE music_track_state SET favorite=0,rating=0,play_count=0,last_played_at=''");
      else db.exec("INSERT INTO music_track_state(track_id,favorite,rating,play_count,last_played_at,updated_at) VALUES('orphan',1,5,100,'2020-01-01','2026-10-04')");
    }
    const active = db.prepare("SELECT COUNT(*) AS n FROM music_tracks WHERE status='ok'").get().n;
    db.prepare("UPDATE music_artists SET track_count=?").run(active);
    const counts = { newest: active, hires: active,
      lyrics: db.prepare("SELECT COUNT(*) AS n FROM music_tracks WHERE status='ok' AND has_lrc=1").get().n,
      longform: db.prepare("SELECT COUNT(*) AS n FROM music_tracks WHERE status='ok' AND duration_ms>=300000").get().n };
    db.prepare("INSERT INTO music_meta VALUES('smart_static_counts_json',?)").run(JSON.stringify(counts));
    db.exec("COMMIT");
  }
  function read(owner, probe = false) {
    const work = { db: owner.db, probe, visits: 0, executions: [] };
    measuring = work;
    try {
      const started = performance.now(), response = owner.store.listSmartPlaylists();
      return { response, ms: performance.now() - started, ...work };
    } finally { measuring = null; }
  }
  function equal(current, previous, label) {
    assert.deepEqual(current.response, previous.response, label);
    assert.equal(JSON.stringify(current.response), JSON.stringify(previous.response), label + " complete JSON");
    responseOracles++;
  }
  const errorValue = error => ({ name: error.name, message: error.message, code: error.code });
  try {
    const current = open(factory), previous = open(previousFactory);
    const both = operation => { operation(current.db); operation(previous.db); };
    const reset = () => { seed(current, 96); seed(previous, 96); clock += 6000; };
    const compare = label => { clock += 6000; const a = read(current), b = read(previous); equal(a, b, label); return a.response; };
    for (const kind of ["empty", "sparse", "dense", "zero"]) {
      seed(current, 3000, kind); seed(previous, 3000, kind); clock += 6000;
      equal(read(current), read(previous), kind + " cold actual owner");
      const a = read(current, true), b = read(previous, true);
      equal(a, b, kind + " actual native lookup response");
      for (const work of [a, b]) for (const entry of work.executions.filter(query => query.dynamicCount)) {
        const rawPlan = originalPrepare.call(work.db, "EXPLAIN QUERY PLAN " + entry.sql).all(...entry.parameters).map(row => row.detail);
        const probePlan = originalPrepare.call(work.db, "EXPLAIN QUERY PLAN " + entry.sql.replace(/t\.id\s*=\s*s\.track_id/u,
          "t.id=fixture_smart_track_id(s.track_id)")).all(...entry.parameters).map(row => row.detail);
        assert.deepEqual(probePlan, rawPlan, "native identity probe retains the actual indexed plan");
        assert.deepEqual(rawPlan, ["SCAN s", "SEARCH t USING INDEX sqlite_autoindex_music_tracks_1 (id=?)"]);
      }
      budgets.push({ kind, current: { visits: a.visits, sql: a.executions.length,
        dynamic: a.executions.filter(query => query.dynamicCount).length, artist: a.executions.filter(query => query.artistTotal).length },
        previous: { visits: b.visits, sql: b.executions.length,
          dynamic: b.executions.filter(query => query.dynamicCount).length, artist: b.executions.filter(query => query.artistTotal).length },
        instrumentedDiagnosticMs: { current: a.ms, previous: b.ms } });
    }
    reset();
    const values = [null, 0, 1, -1, 4, 5, 0.25, "", "0", "1", "1.0", "01", "4", "NaN", "文字", new Uint8Array([0]), new Uint8Array([49])];
    for (const affinity of ["INTEGER", "TEXT", "BLOB"]) {
      both(db => {
        db.exec("DROP TABLE music_track_state;CREATE TABLE music_track_state(track_id TEXT PRIMARY KEY,favorite " + affinity
          + ",rating " + affinity + ",position_ms " + affinity + ",duration_ms " + affinity + ",play_count " + affinity + ",last_played_at " + affinity + ",updated_at TEXT NOT NULL)");
        db.exec("INSERT INTO music_track_state(track_id,favorite,rating,play_count,last_played_at,updated_at) SELECT id,1,4,2,'2026-09-04T11:59:59.999Z','2026-10-04' FROM music_tracks");
        db.exec("INSERT INTO music_track_state VALUES(NULL,1,5,0,0,100,'2020-01-01','2026-10-04'),(NULL,1,5,0,0,100,'2020-01-01','2026-10-04'),('orphan',1,5,0,0,100,'2020-01-01','2026-10-04')");
      });
      for (const field of ["favorite", "rating", "play_count", "last_played_at"]) for (const [index, value] of values.entries()) {
        both(db => db.prepare("UPDATE music_track_state SET " + field + "=?").run(value));
        compare(affinity + " field " + field + "/" + index);
      }
    }
    both(db => db.exec("DROP TABLE music_track_state;CREATE TABLE music_track_state(track_id TEXT PRIMARY KEY,favorite INTEGER DEFAULT 0,rating INTEGER DEFAULT 0,position_ms INTEGER DEFAULT 0,duration_ms INTEGER DEFAULT 0,play_count INTEGER DEFAULT 0,last_played_at TEXT,updated_at TEXT NOT NULL)"));
    reset();
    for (const [index, value] of [undefined, "", "{bad", "null", "false", "[]", "5", "{}",
      '{"newest":null,"hires":"","lyrics":false,"longform":"0"}',
      '{"newest":[],"hires":[8],"lyrics":{},"longform":"NaN"}',
      '{"newest":-1,"hires":1.5,"lyrics":"4","longform":"1e999"}'].entries()) {
      both(db => { db.exec("DELETE FROM music_meta WHERE key='smart_static_counts_json'");
        if (value !== undefined) db.prepare("INSERT INTO music_meta VALUES('smart_static_counts_json',?)").run(value); });
      compare("static metadata/fallback " + index);
    }
    reset();
    both(db => db.exec("UPDATE music_track_state SET favorite=1,play_count=0,last_played_at='';UPDATE music_tracks SET status='ok'"));
    const dateBase = Date.parse("2026-10-04T12:00:00Z");
    for (const [index, value] of ["", "2026-09-04T11:59:59.999Z", "2026-09-04T12:00:00.000Z",
      "2026-09-04T12:00:00.001Z", "2026-10-04", "0000", "bad", " ", "2026-09-04T12:00:00.000Z ", "😀"].entries()) {
      both(db => db.prepare("UPDATE music_track_state SET last_played_at=?").run(value)); clock = dateBase - 6000;
      const count = compare("date boundary " + index).smartPlaylists.find(mix => mix.id === "rediscover").trackCount;
      if (index === 1) assert.equal(count, 96);
      if (index === 2 || index === 3) assert.equal(count, 0);
    }
    both(db => db.prepare("UPDATE music_track_state SET last_played_at=?").run("2026-09-04T12:00:00.000Z"));
    clock = dateBase - 6000; compare("cutoff equality");
    clock = dateBase + 1 - 6000;
    assert.equal(compare("next request clock change").smartPlaylists.find(mix => mix.id === "rediscover").trackCount, 96);
    both(db => db.exec("UPDATE music_track_state SET favorite=0,play_count=0,rating=0,last_played_at=''")); compare("next request inert state");
    both(db => db.exec("UPDATE music_tracks SET status='missing';UPDATE music_artists SET track_count=0")); compare("next request removed tracks");
    for (const total of [null, 0, -10, 1, 3.5, "2", "NaN", new Uint8Array([49])]) {
      both(db => db.prepare("UPDATE music_artists SET track_count=?").run(total)); compare("artist SUM " + String(total));
    }
    both(db => db.exec("DELETE FROM music_artists")); compare("empty artist SUM");
    both(db => db.exec("INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) VALUES('nullable','A','','','',NULL,'missing','x')"));
    compare("NULL/nonactive artist SUM");
    for (const kind of ["state", "artist", "static", "fallback"]) {
      reset();
      if (kind === "fallback") both(db => db.exec("DELETE FROM music_meta WHERE key='smart_static_counts_json'"));
      failureKind = kind;
      if (kind === "static") compare("metaValue catches the same SQL error and falls back");
      else for (const owner of [current, previous]) assert.throws(() => read(owner), error => error === failure);
      failureKind = null; compare("recovery after " + kind + " SQL error");
    }
    reset();
    both(db => db.exec("UPDATE music_artists SET track_count=9223372036854775807;INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) VALUES('overflow','B','','','',1,'ok','x')"));
    const nativeErrors = [];
    for (const owner of [current, previous]) {
      assert.throws(() => read(owner), error => { nativeErrors.push(errorValue(error)); return /integer overflow/u.test(error.message); });
    }
    assert.deepEqual(nativeErrors[0], nativeErrors[1]);
    both(db => db.exec("UPDATE music_artists SET track_count=0")); compare("native SUM overflow recovery");
    reset(); compare("fresh response before stepped clock");
    function stepClock(owner, cold) {
      if (cold) clock += 6000;
      const startClock = clock; let calls = 0; dateEvents = [];
      Date.now = () => { dateEvents.push("Date.now"); return startClock + calls++ * 1000; };
      try { return { response: owner.store.listSmartPlaylists(), calls, events: dateEvents }; }
      finally { dateEvents = null; Date.now = () => clock; }
    }
    for (const cold of [false, true]) {
      const at = clock, a = stepClock(current, cold); clock = at;
      const b = stepClock(previous, cold); equal(a, b, "stepped request clock/" + cold);
      assert.deepEqual(a.events, b.events); assert.equal(a.calls, b.calls);
      assert.deepEqual(a.events.slice(0, 6), ["static", "static", "static", "static", "Date.now", "rediscover SQL"],
        "rediscover still resolves its cutoff after the original four metadata reads");
    }
    Date.now = () => { throw failure; };
    for (const owner of [current, previous]) assert.throws(() => read(owner), error => error === failure);
    Date.now = () => clock;
    async function route(owner) {
      const result = {}, log = console.error; console.error = () => {};
      try {
        assert.equal(await routeMusicApi({ method: "GET" }, {}, new URL("http://fixture/api/music/smart-playlists"),
          { musicStore: owner.store, sendJson(_res, status, payload) { result.status = status; result.payload = payload; },
            notFound() { assert.fail("unexpected missing list"); } }), true);
      } finally { console.error = log; }
      return result;
    }
    assert.deepEqual(await route(current), await route(previous)); responseOracles++;
    failureKind = "state";
    for (const code of ["SQLITE_BUSY", "SYNTHETIC"]) {
      failure.code = code; const a = await route(current), b = await route(previous); assert.deepEqual(a, b);
      assert.equal(a.status, code === "SQLITE_BUSY" ? 503 : 500); responseOracles++;
    }
    failureKind = null;
    both(db => db.exec("DROP TABLE music_track_state")); const missing = [];
    for (const owner of [current, previous]) assert.throws(() => read(owner), error => {
      missing.push(errorValue(error)); return /no such table: music_track_state/u.test(error.message);
    });
    assert.deepEqual(missing[0], missing[1]); assert.deepEqual(await route(current), await route(previous)); responseOracles++;
    const fresh = open(factory), oldFresh = open(previousFactory); equal(read(fresh), read(oldFresh), "replacement owner has no request cache");
    for (const owner of owners) {
      assert.equal(owner.store.scanDiagnostics().workerStarts, 0);
      await owner.store.stop(); assert.equal(owner.store.scanDiagnostics().closed, true);
      assert.throws(() => originalPrepare.call(owner.db, "SELECT 1"), /not open/u);
    }
    // All full response, affinity, fresh-date, fallback, error and lifecycle
    // oracles precede the work budget, including the restored old negative.
    console.log(JSON.stringify({ smartListOracles: responseOracles, budgets }));
    const dense = budgets.find(work => work.kind === "dense");
    assert.equal(dense.previous.visits, 11164, "the full old list repeats native track lookups");
    assert.equal(dense.current.visits, 4116, "dense smart list native track lookup budget");
    const expectedVisits = { empty: [0, 0], sparse: [22, 27], dense: [4116, 11164], zero: [0, 0] };
    for (const work of budgets) {
      assert.deepEqual([work.current.visits, work.previous.visits], expectedVisits[work.kind]);
      assert.equal(work.previous.dynamic, 7, "the full old list performs seven native state scans");
      assert.equal(work.current.dynamic, 2, work.kind + ": one shared scan plus the original rediscover scan");
      assert.equal(work.current.artist, 1); assert.equal(work.previous.artist, 2);
      assert.equal(work.current.sql, 7); assert.equal(work.previous.sql, 13);
      if (work.kind === "empty" || work.kind === "zero") assert.equal(work.current.visits, 0, "inert state avoids track lookups");
      assert.ok(work.current.visits <= work.previous.visits);
    }
    return { responseOracles, tracks: 3000, budgets };
  } finally {
    measuring = null; failureKind = null; dateEvents = null;
    try { for (const owner of owners) await owner.store.stop(); }
    finally { Date.now = originalNow; DatabaseSync.prototype.prepare = originalPrepare; }
  }
}

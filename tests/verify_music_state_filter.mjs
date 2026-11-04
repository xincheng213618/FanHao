import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { MUSIC_FACET_CACHE } from "../src/modules/music/server/constants.js";

// Restore only the former COUNT implementation. The actual page query, ties,
// serializers, search, summary and facets remain the complete response oracle.
const sourceUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
const start = source.indexOf("  function trackFilterTotal(database, filter) {");
const end = source.indexOf("\n  function trackDetail(", start);
assert(start >= 0 && end > start);
const currentBlock = source.slice(start, end);
const oldBlock = `  function trackFilterTotal(database, filter) {
    if (canUseShortVocabularyCount(filter)) return musicShortSearchDocumentCount(database, filter.q);
    const indexedTotal = musicIndexedSearchDocumentCount(database, filter);
    if (indexedTotal !== null) return indexedTotal;
    const searchJoin = musicSearchIndexJoin(filter.searchKind);
    const stateJoin = filter.needsState ? "LEFT JOIN music_track_state s ON s.track_id = t.id" : "";
    const where = filter.trackWhere ? \`WHERE \${filter.trackWhere}\` : "";
    return Number(database.prepare(\`SELECT COUNT(*) AS count FROM music_tracks t \${searchJoin} \${stateJoin} \${where}\`).get(...filter.trackArgs)?.count || 0);
  }
`;
assert.notEqual(currentBlock, oldBlock);
const oldSource = source.replace(currentBlock, oldBlock).replace(/from "(\.\/[^"]+)"/gu,
  (_, relative) => "from " + JSON.stringify(new URL(relative, sourceUrl).href));
const { createMusicStore: oldFactory } = await import("data:text/javascript;base64," + Buffer.from(oldSource).toString("base64"));
const testedFactory = process.argv.includes("--legacy-state-count") ? oldFactory : createMusicStore;
const originalPrepare = DatabaseSync.prototype.prepare;
const originalNow = Date.now;
const owners = [];
let opening = false, captured = null, measuring = null, failure = null;
let clock = Date.parse("2026-11-04T12:00:00Z"), responseOracles = 0;
const metrics = [];
Date.now = () => clock;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  if (opening) captured = this;
  const isCount = /^SELECT COUNT\(\*\) AS count FROM music_(tracks|track_state)\b/u.test(sql)
    && sql.includes("WHERE t.status = 'ok'");
  const isProbe = sql === "SELECT COUNT(*) AS count FROM (SELECT 1 FROM music_track_state LIMIT 1025)";
  const owned = failure?.db === this && (failure.kind === "count" ? isCount : isProbe);
  if (owned && failure.phase === "prepare") throw failure.error;
  const counted = measuring?.db === this && measuring.probe && isCount;
  const instrumented = !counted ? sql : sql.includes("FROM music_track_state s CROSS JOIN")
    ? sql.replace("s.track_id = t.id", "s.track_id = t.id AND fixture_state_filter_key(s.track_id) IS s.track_id")
    : sql.replace("s.track_id = t.id", "s.track_id = fixture_state_filter_key(t.id)");
  const statement = originalPrepare.call(this, instrumented, ...args);
  if (!owned && !counted && !(measuring?.db === this && isProbe)) return statement;
  const connection = this;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...parameters) => {
      if (owned && key === "get") throw failure.error;
      if (measuring?.db === connection && key === "get") {
        if (isProbe) measuring.probes++;
        if (isCount) {
          const plan = query => originalPrepare.call(connection, "EXPLAIN QUERY PLAN " + query).all(...parameters).map(row => row.detail);
          assert.deepEqual(plan(instrumented), plan(sql), "lookup probe retains the native query plan");
          measuring.plans.push(plan(sql));
        }
      }
      return value.apply(target, parameters);
    };
  } });
};

try {
  const current = open(testedFactory), previous = open(oldFactory);
  const pair = [current, previous];
  for (const owner of pair) seed(owner.db, 100000);
  refresh(pair);
  const requests = ["favorite=1", "minRating=4", "smart=recent", "smart=topplayed", "smart=favorites", "smart=toprated", "smart=rediscover"];
  for (const query of requests) {
    const a = compare(current, previous, query + "&limit=7&offset=3");
    assert(a.current.visits <= 22, "sparse count must visit only eligible state rows");
    assert.equal(a.current.probes, 1, "one bounded state-size probe");
    assert.equal(a.previous.visits, 99999, "old COUNT is a full active catalogue negative control");
    metrics.push({ query, ...a });
  }
  // Sorting and tie handling retain the exact former page query.
  for (const sort of ["album", "artist", "title", "duration", "played", "favorite", "rating"]) {
    compare(current, previous, `favorite=1&sort=${sort}&limit=3&offset=2`);
  }
  for (const query of ["smart=unplayed", "smart=unrated", "smart=hires", "favorite=1&artist=a", "favorite=1&album=al",
    "favorite=1&genre=pop", "favorite=1&language=英文", "favorite=1&q=zz-no-match"]) {
    const result = compare(current, previous, query + "&limit=3");
    assert.equal(result.current.probes, 0, "unconstrained or indexed subsets retain the original plan: " + query);
  }
  for (const owner of pair) owner.db.exec("DELETE FROM music_track_state");
  const empty = compare(current, previous, "favorite=1&limit=3");
  assert.equal(empty.current.visits, 0);
  assert.equal(empty.previous.visits, 99999);

  // At the bounded probe threshold, dense state returns to the original plan.
  for (const amount of [1024, 1025, 100000]) {
    for (const owner of pair) {
      owner.db.exec(`DELETE FROM music_track_state; INSERT INTO music_track_state(track_id,favorite,rating,play_count,last_played_at,updated_at)
        SELECT id,1,5,1,'2026-01-01','2026-01-01' FROM music_tracks ORDER BY id LIMIT ${amount}`);
    }
    const result = compare(current, previous, "favorite=1&limit=3");
    assert.equal(result.current.visits, amount <= 1024 ? amount : 99999);
    metrics.push({ stateRows: amount, ...result });
  }

  // A small catalogue covers unusual historic column affinities and values.
  for (const owner of pair) {
    owner.db.exec("DELETE FROM music_tracks WHERE id > 't000064';UPDATE music_artists SET track_count=64;UPDATE music_albums SET track_count=64");
  }
  const values = [null, 0, 1, -1, 4, 5, 0.25, "", "0", "1", "1.0", "01", "4", "NaN", "文字", new Uint8Array([0]), new Uint8Array([49])];
  for (const affinity of ["INTEGER", "TEXT", "BLOB"]) {
    for (const owner of pair) owner.db.exec(`DROP TABLE music_track_state;CREATE TABLE music_track_state(
      track_id TEXT PRIMARY KEY,favorite ${affinity},rating ${affinity},position_ms ${affinity},duration_ms ${affinity},
      play_count ${affinity},last_played_at ${affinity},updated_at TEXT NOT NULL);
      CREATE INDEX idx_music_track_state_played ON music_track_state(last_played_at);
      INSERT INTO music_track_state SELECT id,1,5,123,456,1,'2026-01-01','2026-01-01' FROM music_tracks WHERE rowid%2=0;
      INSERT INTO music_track_state VALUES('orphan',1,5,0,0,2,'2026-01-01','2026-01-01'),(NULL,1,5,0,0,2,'2026-01-01','2026-01-01');`);
    refresh(pair);
    for (const field of ["favorite", "rating", "play_count", "last_played_at"]) for (const value of values) {
      for (const owner of pair) owner.db.prepare("UPDATE music_track_state SET " + field + "=?").run(value);
      clock += 6000;
      for (const query of requests) compare(current, previous, query + "&limit=7&offset=1");
    }
  }
  // Native key comparisons keep the former ON operand direction, including
  // different affinities and a state-owned NOCASE collation. Do not wrap keys
  // in probe functions here: that could alter their native affinity itself.
  for (const trackKey of ["TEXT COLLATE BINARY", "TEXT COLLATE NOCASE", "BLOB", "INTEGER"]) {
    for (const stateKey of ["TEXT COLLATE BINARY", "TEXT COLLATE NOCASE", "BLOB", "INTEGER"]) {
      for (const owner of pair) {
        const columns = owner.db.prepare("PRAGMA table_info(music_tracks)").all();
        owner.db.exec("DROP TABLE music_tracks;CREATE TABLE music_tracks("
          + columns.map(column => `"${column.name}" ${column.name === "id" ? trackKey + " UNIQUE" : column.type}`).join(",") + ")");
        owner.db.exec(`DROP TABLE music_track_state;CREATE TABLE music_track_state(track_id ${stateKey} UNIQUE,
          favorite INTEGER,rating INTEGER,position_ms INTEGER,duration_ms INTEGER,play_count INTEGER,last_played_at TEXT,updated_at TEXT);
          CREATE INDEX idx_music_track_state_played ON music_track_state(last_played_at)`);
        const track = owner.db.prepare("INSERT OR IGNORE INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,source_path,file_name,language,genre,status,updated_at) VALUES(?,'a','al','Tied','Artist','Album',?,'synthetic.mp3','英文','pop','ok','2026-01-01')");
        const state = owner.db.prepare("INSERT OR IGNORE INTO music_track_state VALUES(?,1,5,0,0,1,'2026-01-01','2026-01-01')");
        for (const [index, id] of ["alpha", "ALPHA", "2", "02", 2, new Uint8Array([50])].entries()) track.run(id, "synthetic-" + index);
        for (const id of ["ALPHA", 2, "02", new Uint8Array([50]), null]) state.run(id);
      }
      refresh(pair);
      for (const query of requests) compare(current, previous, query + "&limit=7", false);
    }
  }
  // Query preparation and execution failures must reach the caller unchanged.
  for (const owner of pair) owner.db.exec("DELETE FROM music_track_state");
  for (const kind of ["probe", "count"]) for (const phase of ["prepare", "get"]) {
    const error = new Error(`synthetic ${kind} ${phase} failure`);
    failure = { db: current.db, kind, phase, error };
    assert.throws(() => current.store.listTracks(url("favorite=1")), caught => caught === error);
    failure = null;
  }
  console.log(JSON.stringify({ ok: true, responseOracles, tracks: 100000, metrics,
    scope: "COUNT only; complete legacy responses and page order retained; no real media or services" }, null, 2));
} finally {
  measuring = null; failure = null;
  try { for (const owner of owners) await owner.store.stop(); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; Date.now = originalNow; }
}

function open(factory) {
  const store = factory({ dbPath: ":memory:", roots: [] });
  opening = true; captured = null;
  try { store.summary(); } finally { opening = false; }
  assert(captured);
  const owner = { store, db: captured };
  owners.push(owner);
  owner.db.function("fixture_state_filter_key", value => {
    if (measuring?.db === owner.db) measuring.visits++;
    return value;
  });
  return owner;
}

function seed(db, count) {
  db.prepare(`INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,updated_at)
    VALUES('a','Synthetic artist','fixture','fixture/artist','artist',?,'2026-01-01')`).run(count);
  db.prepare(`INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at)
    VALUES('al','a','Synthetic album','fixture','fixture/album','album',?,'2026-01-01')`).run(count);
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,track_no,disc_no,genre,language,
      source_root,source_path,relative_path,file_name,ext,updated_at,status)
    SELECT printf('t%06d',x),'a','al',printf('Title %06d',x%7),'Artist','Album',x%4,1,'pop','英文',
      'fixture',printf('fixture/%06d.mp3',x),printf('%06d.mp3',x),printf('%06d.mp3',x),'.mp3','2026-01-01',
      CASE WHEN x=10000 THEN 'missing' ELSE 'ok' END FROM n;
    INSERT INTO music_track_state(track_id,favorite,rating,play_count,last_played_at,updated_at)
      SELECT id,1,5,1,'2026-01-01','2026-01-01' FROM music_tracks WHERE CAST(SUBSTR(id,2) AS INTEGER)%5000=0;
    INSERT INTO music_track_state VALUES('orphan',1,5,0,0,2,'2026-01-01','2026-01-01'),(NULL,1,5,0,0,2,'2026-01-01','2026-01-01');`);
}

function refresh(pair) {
  clock += 6000;
  for (const owner of pair) MUSIC_FACET_CACHE.delete(owner.db);
}

function url(query) { return new URL("http://fixture/?" + query); }
function measure(owner, query, probe) {
  measuring = { db: owner.db, visits: 0, probes: 0, plans: [], probe };
  try {
    const begin = performance.now();
    const result = owner.store.listTracks(url(query));
    return { result, metrics: { visits: measuring.visits, probes: measuring.probes, plans: measuring.plans,
      diagnosticMs: Number((performance.now() - begin).toFixed(3)) } };
  } finally { measuring = null; }
}
function compare(current, previous, query, probe = true) {
  const a = measure(current, query, probe), b = measure(previous, query, probe);
  assert.deepEqual(a.result, b.result, "complete old response: " + query);
  responseOracles++;
  return { current: a.metrics, previous: b.metrics };
}

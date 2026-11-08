import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { routeMusicApi } from "../src/modules/music/server/routes.js";
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
  await verifySparseFavoriteRoutes();
  console.log(JSON.stringify({ ok: true, responseOracles, tracks: 100000, metrics,
    scope: "COUNT only; complete legacy responses and page order retained; no real media or services" }, null, 2));
} finally {
  measuring = null; failure = null;
  try { for (const owner of owners) await owner.store.stop(); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; Date.now = originalNow; }
}

async function verifySparseFavoriteRoutes() {
  const serializersUrl = new URL("./serializers.js", sourceUrl);
  const serializers = fs.readFileSync(serializersUrl, "utf8").replaceAll("\r\n", "\n");
  const oldAdjacent = serializers.replace("readSparseFavoriteAlbumRows(db, filter, order, sql, args) ?? ", "");
  const oldPage = source.replace(/^      if \(offset < total && !playedIds\) rows = readSparseFavoriteAlbumRows\([^\n]+\);\n/mu, "");
  assert.notEqual(oldAdjacent, serializers);
  assert.notEqual(oldPage, source);
  const module = text => "data:text/javascript;base64," + Buffer.from(text.replace(/from "(\.\.?\/[^"]+)"/gu,
    (_, relative) => "from " + JSON.stringify(new URL(relative, sourceUrl).href))).toString("base64");
  const { createMusicStore: beforeFactory } = await import(module(oldPage.replace('"./serializers.js"', JSON.stringify(module(oldAdjacent)))));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-favorite-page-"));
  const dbPath = path.join(directory, "catalogue.sqlite");
  const opened = [];
  let writer, inspect = false, fault = null, interleave = null;
  function connect(factory) {
    const store = factory({ dbPath, roots: [] });
    const owner = { store };
    opened.push(owner);
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql, ...args) { owner.db = this; return prepare.call(this, sql, ...args); };
    try { assert.equal(store.progressClock("initialize"), null); } finally { DatabaseSync.prototype.prepare = prepare; }
    const db = owner.db, nativePrepare = db.prepare.bind(db), nativeExec = db.exec.bind(db);
    db.exec = sql => {
      if (fault === "savepoint" && sql.startsWith("SAVEPOINT music_sparse_favorite_album")) throw new Error("fixture savepoint unavailable");
      return nativeExec(sql);
    };
    db.prepare = sql => {
      if (fault === "probe" && sql.startsWith("EXPLAIN QUERY PLAN") && sql.includes("ORDER BY t.album_title")) throw new Error("fixture plan unavailable");
      const statement = nativePrepare(sql);
      if (!(inspect || fault || interleave) || !sql.includes("ORDER BY t.album_title")
        || !sql.includes("COALESCE(s.favorite, 0) = 1") || sql.startsWith("EXPLAIN")) return statement;
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== "all") return typeof value === "function" ? value.bind(target) : value;
        return (...args) => {
          owner.selected = sql.includes("t._rowid_ ASC");
          if (fault === "read") throw new Error("fixture queue read failed");
          if (owner.selected && interleave) { const write = interleave; interleave = null; write(); }
          owner.plan = nativePrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail);
          return target.all(...args);
        };
      } });
    };
    return owner;
  }
  async function route(owner, endpoint, expected = 200) {
    const response = {};
    assert(await routeMusicApi({ method: "GET" }, response, new URL(`http://fixture/api/music/${endpoint}`), {
      musicStore: owner.store,
      sendJson: (res, status, body) => Object.assign(res, { status, body }),
      notFound: res => { res.status = 404; }
    }));
    assert.equal(response.status, expected);
    return response;
  }
  try {
    const before = connect(beforeFactory), after = connect(createMusicStore);
    writer = new DatabaseSync(dbPath);
    writer.exec(`PRAGMA synchronous=OFF; BEGIN IMMEDIATE;
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,track_no,disc_no,genre,language,
        source_root,source_path,relative_path,file_name,ext,updated_at)
      SELECT printf('t-%06d',i),'a','al','Title '||i%20,'Artist',CASE WHEN i%3=0 THEN 'Album' ELSE 'album' END,
        i%24,i%2,'Rock','其他','root','synthetic/'||i,'relative/'||i,'Track-'||i||'.mp3','.mp3','fixture' FROM n ORDER BY i DESC;
      INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,updated_at)
        VALUES('a','Artist','root','path','relative',100000,'fixture');
      INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at)
        VALUES('al','a','Album','root','album','relative',100000,'fixture');
      INSERT INTO music_track_state(track_id,favorite,updated_at)
        SELECT id,CASE WHEN CAST(substr(id,3) AS INTEGER)%419=0 THEN 1 ELSE 0 END,'fixture'
        FROM music_tracks WHERE CAST(substr(id,3) AS INTEGER)%3=0 OR CAST(substr(id,3) AS INTEGER)%419=0 ORDER BY id;
      INSERT INTO music_track_state(track_id,favorite,updated_at) VALUES('orphan',1,'fixture');
      COMMIT`);
    const page = "tracks?favorite=1&limit=48";
    const detail = "tracks/t-041900?favorite=1";
    const unrelated = "tracks/t-041901?favorite=1";
    inspect = true;
    for (const endpoint of [page, page + "&offset=193", detail, unrelated]) {
      assert.deepEqual(await route(after, endpoint), await route(before, endpoint));
      assert.equal(after.selected, true);
      assert(after.plan.some(line => line.includes("idx_music_track_state_favorite (favorite=?)")));
      assert(before.plan.some(line => line === "SEARCH t USING INDEX idx_music_tracks_album_sort (status=?)"));
    }
    assert.equal((await route(after, "tracks/missing?favorite=1", 404)).status, 404);
    assert.deepEqual(await route(after, page + "&offset=9007199254740991"), await route(before, page + "&offset=9007199254740991"));
    assert.deepEqual(await route(after, page + "&artist=a"), await route(before, page + "&artist=a"));
    assert.equal(after.selected, false);
    for (fault of ["probe", "savepoint"]) {
      assert.deepEqual(await route(after, detail), await route(before, detail));
      assert.equal(after.selected, false);
      assert.equal(after.db.isTransaction, false);
    }
    const log = console.error;
    try {
      console.error = () => {}; fault = "read";
      for (const endpoint of [page, detail]) {
        assert.deepEqual(await route(after, endpoint, 500), await route(before, endpoint, 500));
        assert.equal(after.db.isTransaction, false);
      }
    } finally { console.error = log; fault = null; inspect = false; }
    const diagnostics = {};
    for (const [name, endpoint] of [["list", page], ["detail", detail]]) {
      const samples = [[], []];
      for (let pair = 0; pair < 5; pair++) {
        const replies = [];
        for (const mode of pair % 2 ? [1, 0] : [0, 1]) {
          const start = performance.now(); replies[mode] = await route([before, after][mode], endpoint);
          samples[mode].push(performance.now() - start);
        }
        assert.deepEqual(replies[0], replies[1]);
      }
      diagnostics[name] = samples.map(values => +values.sort((a, b) => a - b)[2].toFixed(2));
    }
    const pinned = await route(before, detail);
    assert(pinned.body.prevId || pinned.body.nextId);
    interleave = () => writer.exec("UPDATE music_track_state SET favorite=0 WHERE track_id='t-041900'");
    assert.deepEqual(await route(after, detail), pinned);
    assert.equal(interleave, null);
    const committed = await route(after, detail);
    assert.deepEqual(committed, await route(before, detail));
    assert.equal(committed.body.prevId, ""); assert.equal(committed.body.nextId, "");
    inspect = true;
    for (const count of [1024, 1025]) {
      writer.exec(`UPDATE music_track_state SET favorite=0;
        UPDATE music_track_state SET favorite=1 WHERE track_id IN (
          SELECT track_id FROM music_track_state WHERE track_id<>'orphan' ORDER BY track_id LIMIT ${count})`);
      assert.deepEqual(await route(after, page), await route(before, page));
      assert.equal(after.selected, count === 1024);
    }
    writer.exec(`UPDATE music_track_state SET favorite=0;
      UPDATE music_track_state SET favorite=1 WHERE CAST(substr(track_id,3) AS INTEGER)%419=0;
      ALTER TABLE music_tracks ADD COLUMN _rowid_ TEXT GENERATED ALWAYS AS (id) VIRTUAL`);
    for (const endpoint of [page, detail]) {
      assert.deepEqual(await route(after, endpoint), await route(before, endpoint));
      assert.equal(after.selected, false);
    }
    writer.exec("ALTER TABLE music_tracks DROP COLUMN _rowid_");
    const trackSchema = writer.prepare("SELECT sql FROM sqlite_schema WHERE name = 'music_tracks'").get().sql;
    const indexes = writer.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='music_tracks' AND sql IS NOT NULL").all();
    writer.exec(`ALTER TABLE music_tracks RENAME TO fixture_old_tracks;
      ${trackSchema.replace("artist_id TEXT NOT NULL", "artist_id INTEGER NOT NULL")};
      INSERT INTO music_tracks SELECT * FROM fixture_old_tracks WHERE id='t-041900';
      DROP TABLE fixture_old_tracks;
      ${indexes.map(index => index.sql).join(";")};
      UPDATE music_tracks SET artist_id=1;
      INSERT INTO music_artists(id,name,source_root,source_path,relative_path,updated_at)
        VALUES('1','Numeric Artist','root','numeric','numeric','fixture'),('01','Padded Artist','root','padded','padded','fixture')`);
    const numeric = await route(after, page);
    assert.deepEqual(numeric, await route(before, page));
    assert.equal(after.selected, false);
    assert.equal(numeric.body.tracks.length, 2);
    console.log(JSON.stringify({ check: "music-sparse-favorite-queue", tracks: 100000, medianRouteMs: diagnostics,
      reversedRowidTies: true, boundedFavorites: true, concurrentQueueSnapshot: true }));
  } finally {
    writer?.close();
    for (const { store } of opened) store.invalidate();
    const owned = fs.realpathSync(directory);
    assert.equal(path.dirname(owned), fs.realpathSync(os.tmpdir()));
    assert(path.basename(owned).startsWith("fanhao-music-favorite-page-"));
    for (const item of fs.readdirSync(owned, { withFileTypes: true })) {
      assert(item.isFile());
      fs.unlinkSync(path.join(owned, item.name));
    }
    fs.rmdirSync(owned);
  }
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

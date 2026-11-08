import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { routeMusicApi } from "../src/modules/music/server/routes.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import { ALBUM_FACET_COLUMNS } from "../src/modules/music/server/facets.js";
import { publicAlbum } from "../src/modules/music/server/serializers.js";

// Actual report/store/publication and private native SQLite. The old SQL keeps
// its bare-column aggregate choices, orphan group and original tie ordering.
// No service, worker, media or application database participates.
assert(process.argv.slice(2).every(arg => arg === "--legacy-wide-report-albums"));
const negative = process.argv.includes("--legacy-wide-report-albums");
const storePath = new URL("../src/modules/music/server/store.js", import.meta.url);
const source = readFileSync(storePath, "utf8").replaceAll("\r\n", "\n");
const originalBlock = `    const topAlbums = database
      .prepare(
        \`
        SELECT
          al.*,
          a.name AS artist_name,
          COALESCE(SUM(s.play_count), 0) AS plays,
          MAX(COALESCE(s.last_played_at, '')) AS last_played_at
        FROM music_tracks t
        LEFT JOIN music_albums al ON al.id = t.album_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        WHERE t.status = 'ok'
        GROUP BY al.id
        HAVING plays > 0
        ORDER BY plays DESC, last_played_at DESC, al.title COLLATE NOCASE
        LIMIT 8
      \`
      )
      .all()
      .map((row) => ({
        ...publicAlbum(row),
        plays: Number(row.plays || 0),
        lastPlayedAt: row.last_played_at || ""
      }));
`;
const start = source.indexOf("    const topAlbums = "), end = source.indexOf("    const topTracks = ", start);
assert(start > 0 && end > start);
const currentBlock = source.slice(start, end);
assert.equal(originalBlock.replace("const topAlbums = database\n      .prepare(", "const topAlbums = (rankings?.albums ?? prepareAlbumFacet(database,")
  .replace("al.*,", "${ALBUM_FACET_COLUMNS},").replace("      .all()", "      .all())"), currentBlock,
  "captured full-catalogue report algorithm changes only this projection/prepare");
const previousSource = source.replace(currentBlock, originalBlock);
assert.equal(previousSource.replace(originalBlock, currentBlock), source, "all non-report code restores byte-for-byte");
const absolute = previousSource.replace(/from "(\.\/[^"]+)"/gu, (_, value) => `from ${JSON.stringify(new URL(value, storePath).href)}`);
const { createMusicStore: previousStore } = await import(`data:text/javascript;base64,${Buffer.from(absolute).toString("base64")}`);
const sparseGate = "const rankings = sparseMusicReportRankings(database, trackCountBoundsPageRows);";
assert.equal(source.split(sparseGate).length, 2);
const { createMusicStore: withoutSparseRankings } = await import(moduleUrl(absoluteImports(source.replace(sparseGate, "const rankings = null;"))));
const subjectFactory = negative ? previousStore : createMusicStore;
function moduleUrl(text) { return "data:text/javascript;base64," + Buffer.from(text).toString("base64"); }
function absoluteImports(text) { return text.replace(/from "(\.\/[^"\n]+)"/gu, (_, value) => `from ${JSON.stringify(new URL(value, storePath).href)}`); }
const nativePrepare = DatabaseSync.prototype.prepare, realNow = Date.now;
const owners = [], connections = [];
let measurement = null, fault = null, clock = 1791800000000;
let responseOracles = 0, planOracles = 0, errorOracles = 0;
const normalize = sql => sql.replace(/\s+/gu, " ").trim();
const isReportAlbum = sql => /GROUP BY al\.id\s+HAVING plays > 0/u.test(sql);
const unusedFields = ["intro_text", "intro_path", "source_root", "source_path", "relative_path", "sort_title"];
Date.now = () => clock;
DatabaseSync.prototype.prepare = function(sql, ...args) {
  const db = this, album = isReportAlbum(sql), observed = measurement?.db === db ? measurement : null;
  if (!connections.includes(db)) connections.push(db);
  if (observed) observed.prepares++;
  if (fault?.db === db && album && fault.phase === "prepare") throw fault.error;
  const statement = nativePrepare.call(db, sql, ...args);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...input) => {
      if (!["get", "all"].includes(key)) return value.apply(target, input);
      const observed = measurement?.db === db ? measurement : null;
      if (observed) observed.queries.push({ sql, input, phase: key });
      if (fault?.db === db && album && fault.phase === key) throw fault.error;
      const result = value.apply(target, input);
      if (album && observed) for (const row of result) {
        observed.rows++;
        observed.fields += Object.keys(row).length;
        for (const field of unusedFields) {
          const item = row[field];
          const bytes = typeof item === "string" ? Buffer.byteLength(item) : ArrayBuffer.isView(item) ? item.byteLength : 0;
          observed.unusedBytes += bytes;
          if (field === "intro_text") observed.introBytes += bytes;
        }
      }
      return result;
    };
  } });
};
function open(factory) {
  const store = factory({ dbPath: ":memory:", roots: [], scanWorker: {
    start() { assert.fail("no worker"); }, scan() { assert.fail("no scan"); }, async stop() {}, diagnostics() { return {}; }
  } });
  store.summary();
  const owner = { store, db: connections.at(-1) }; owners.push(owner); return owner;
}
const pair = () => ({ old: open(previousStore), current: open(subjectFactory) });
const each = (value, operation) => { operation(value.old); operation(value.current); };
function seed(owner, { albums = 16, width = 0, order = "forward", orphan = true } = {}) {
  const artists = Array.from({ length: 4 }, (_, i) => ({ id: "a" + i, name: ["歌手2", "歌手10", "TEST", "test"][i], sortName: "",
    language: "中文", sourceRoot: "/synthetic", sourcePath: "/synthetic/a" + i, relativePath: "a" + i,
    albumCount: 4, trackCount: 16, durationMs: 1000, sizeBytes: 100, updatedAt: "fixture" }));
  const albumRows = Array.from({ length: albums }, (_, i) => ({ id: "al" + i, artistId: "a" + i % 4,
    title: ["专辑2", "专辑10", "ALBUM", "album"][i % 4], sortTitle: "unused-sort", year: i % 3 ? "2026" : null,
    coverPath: i % 2 ? "synthetic://cover" + i : "", introPath: "synthetic://intro" + i, introText: "x".repeat(width),
    sourceRoot: "/synthetic", sourcePath: "/synthetic/al" + i, relativePath: "al" + i, trackCount: 4,
    durationMs: i % 2 ? 1000 : null, sizeBytes: i % 3 ? 100 : null, updatedAt: "album-fixture-" + i }));
  const tracks = Array.from({ length: albums * 4 }, (_, i) => ({ id: "t" + i, artistId: "a" + i % 4, albumId: "al" + Math.floor(i / 4),
    title: "测试歌曲 " + i, sortTitle: "", displayArtist: artists[i % 4].name, albumTitle: "测试专辑", trackNo: i + 1, discNo: 1,
    genre: "测试", language: "中文", sourceRoot: "/synthetic", sourcePath: "/synthetic/t" + i, relativePath: "t" + i,
    fileName: "t" + i + ".mp3", ext: ".mp3", sizeBytes: 100, mtimeMs: 1, durationMs: 1000, codec: "mp3", sampleRate: 44100,
    bitDepth: 16, channels: 2, lrcPath: "", hasLrc: 0, status: "ok", error: "", updatedAt: "track-fixture" }));
  const arrange = rows => order === "reverse" ? rows.reverse() : order === "shuffled" ? rows.sort((a, b) => {
    const rank = id => Number(id.match(/\d+/u)?.[0] || 0) * 17 % (rows.length + 1); return rank(a.id) - rank(b.id);
  }) : rows;
  writeScanRecords(owner.db, { artists: arrange(artists), albums: arrange(albumRows), tracks: arrange(tracks), lyrics: [] }, [], "fixture-scan");
  const insert = owner.db.prepare("INSERT OR REPLACE INTO music_track_state(track_id,favorite,rating,position_ms,duration_ms,play_count,last_played_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
  for (const track of tracks) {
    const index = Number(track.id.slice(1));
    insert.run(track.id, index % 2, index % 5, index, 1000, index % 7, index % 3 ? "2026-10-01" : "2026-10-02", "state-fixture");
  }
  if (orphan && tracks.length > 8) owner.db.exec("UPDATE music_tracks SET album_id='missing',artist_id='missing' WHERE id IN ('t1','t2');"
    + "UPDATE music_tracks SET status='missing' WHERE id='t3';UPDATE music_artists SET status='missing' WHERE id='a3'");
}
function read(owner, operation = value => value.store.report(), projectionOnly = true) {
  // Keep this projection-only oracle on the historical catalogue driver.
  if (projectionOnly) owner.db.exec("SAVEPOINT fixture_report_projection");
  measurement = { db: owner.db, prepares: 0, queries: [], rows: 0, fields: 0, unusedBytes: 0, introBytes: 0 };
  try { return { result: operation(owner), ...measurement }; }
  finally { measurement = null; if (projectionOnly) owner.db.exec("RELEASE fixture_report_projection"); }
}
function equal(after, before, label, extra = 0) {
  assert.deepEqual(after.result, before.result, label + " complete report");
  assert.equal(JSON.stringify(after.result), JSON.stringify(before.result), label + " serialized report");
  assert.equal(after.prepares, before.prepares + extra, label + " prepare count");
  assert.equal(after.queries.length, before.queries.length, label + " execution count");
  for (let i = 0; i < after.queries.length; i++) {
    const a = after.queries[i], b = before.queries[i];
    assert.deepEqual(a.input, b.input, label + " binds"); assert.equal(a.phase, b.phase);
    const comparable = isReportAlbum(a.sql) ? a.sql.replace(ALBUM_FACET_COLUMNS, "al.*") : a.sql;
    assert.equal(normalize(comparable), normalize(b.sql), label + " complete unchanged SQL algorithm");
    assert.deepEqual(nativePrepare.call(after.db, "EXPLAIN QUERY PLAN " + a.sql).all(...a.input).map(row => row.detail),
      nativePrepare.call(before.db, "EXPLAIN QUERY PLAN " + b.sql).all(...b.input).map(row => row.detail), label + " actual native plan");
    planOracles++;
  }
  responseOracles++;
}
function compare(value, label, extra = 0, operation) {
  const before = read(value.old, operation), after = read(value.current, operation);
  equal(after, before, label, extra); return { before, after };
}
function caught(run) { try { run(); } catch(error) { return error; } assert.fail("report failure must remain observable"); }
function shape(error) { return { name: error.name, message: error.message, code: error.code, errcode: error.errcode }; }
function median(values) { return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]; }

async function verifySparseRankings() {
  const scale = { old: open(withoutSparseRankings), current: open(createMusicStore) };
  each(scale, ({ db }) => db.exec(`
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500)
    INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,updated_at)
    SELECT 'a'||x,'Artist '||x,'fixture','fixture','fixture',200,'fixture' FROM n;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
    INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at)
    SELECT 'al'||x,'a'||((x-1)/10+1),'Album '||x,'fixture','fixture','fixture',20,'fixture' FROM n;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
    INSERT INTO music_tracks(id,artist_id,album_id,title,album_title,track_no,source_root,source_path,relative_path,file_name,ext,updated_at)
    SELECT printf('t%06d',x),'a'||((x-1)/200+1),'al'||((x-1)/20+1),printf('Song %06d',x),'Fixture',x,'fixture',printf('fixture/%06d.mp3',x),'fixture','fixture.mp3','.mp3','fixture' FROM n;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<40)
    INSERT INTO music_track_state(track_id,play_count,last_played_at,updated_at)
    SELECT printf('t%06d',x*200),1,printf('2026-01-01T00:00:%02d.000Z',x),'fixture' FROM n;
    UPDATE music_tracks SET artist_id='a2' WHERE id='t000199';
    UPDATE music_tracks SET artist_id='a3' WHERE id='t000198';
    INSERT INTO music_track_state(track_id,play_count,last_played_at,updated_at) VALUES
      ('t000199',0,'2099-01-01','fixture'),('t000198',NULL,'2099-01-02','fixture'),('t000197',0,NULL,'fixture'),
      ('t000196',3,'2026-01-01T00:00:00.000Z','fixture');
  `));
  clock += 6000;
  function actual(owner) { return read(owner, value => value.store.report(), false); }
  function rankings(result) {
    return result.queries.filter(({ sql }) => /GROUP BY (a|al)\.id\s+HAVING plays > 0/u.test(sql));
  }
  function compareDrivers(value, eligible) {
    const before = actual(value.old), after = actual(value.current);
    assert.deepEqual(after.result, before.result, "complete report agrees with the original catalogue-driven query");
    assert.equal(JSON.stringify(after.result), JSON.stringify(before.result));
    const queries = rankings(after);
    assert.equal(queries.length, 2);
    assert.equal(queries.every(({ sql }) => sql.includes("FROM music_track_state s CROSS JOIN music_tracks t")), eligible);
    return { before, after, queries };
  }
  const measured = compareDrivers(scale, true);
  assert.equal(measured.after.result.topAlbums[0].artistName, "Artist 3", "dated NULL and zero play rows still participate in album MAX and artist selection");
  assert.equal(measured.after.result.topAlbums[0].plays, 4);
  assert.equal(measured.after.result.topArtists.find(row => row.id === "a1").plays, 4);
  assert.equal(measured.after.result.topArtists.find(row => row.id === "a2").lastPlayedAt, "2099-01-01");
  assert.equal(measured.after.result.topArtists.find(row => row.id === "a3").trackCount, 201, "the deferred artist count includes active unplayed tracks");
  const plans = measured.queries.map(({ sql, input }) => nativePrepare.call(scale.current.db, "EXPLAIN QUERY PLAN " + sql).all(...input).map(row => row.detail));
  for (const plan of plans) {
    assert(plan.some(line => /SCAN s\b/u.test(line)));
    assert(plan.some(line => /SEARCH t USING INDEX sqlite_autoindex_music_tracks_1/u.test(line)), "state drives indexed track lookups");
  }
  assert(plans[0].some(line => /SEARCH counted USING INDEX idx_music_tracks_artist/u.test(line)), "selected artist totals use indexed track ranges");

  async function route(owner) {
    const response = {};
    assert(await routeMusicApi({ method: "GET" }, response, new URL("http://fixture.invalid/api/music/report"), {
      musicStore: owner.store, sendJson: (target, status, data) => Object.assign(target, { status, data })
    }));
    return response;
  }
  assert.equal(JSON.stringify(await route(scale.current)), JSON.stringify(await route(scale.old)));
  const times = { old: [], current: [] };
  for (let round = 0; round < 9; round++) for (const key of round % 2 ? ["current", "old"] : ["old", "current"]) {
    const start = performance.now();
    assert.equal((await route(scale[key])).status, 200);
    times[key].push(performance.now() - start);
  }

  for (const [change, restore] of [
    ["UPDATE music_track_state SET last_played_at='2099-01-02' WHERE track_id='t000199'", "UPDATE music_track_state SET last_played_at='2099-01-01' WHERE track_id='t000199'"],
    ["UPDATE music_track_state SET play_count=1.5 WHERE track_id='t000200'", "UPDATE music_track_state SET play_count=1 WHERE track_id='t000200'"],
    ["UPDATE music_tracks SET album_id='orphan' WHERE id='t000200'", "UPDATE music_tracks SET album_id='al10' WHERE id='t000200'"]
  ]) {
    each(scale, ({ db }) => db.exec(change)); compareDrivers(scale, false);
    each(scale, ({ db }) => db.exec(restore));
  }
  each(scale, ({ db }) => db.exec(`INSERT OR REPLACE INTO music_track_state(track_id,play_count,last_played_at,updated_at)
    SELECT id,1,'dense-'||id,'fixture' FROM music_tracks LIMIT 1025`));
  const dense = compareDrivers(scale, false);
  assert(dense.after.queries.some(({ sql }) => sql.includes("FROM music_track_state LIMIT 1025")), "dense eligibility stays bounded");

  const collation = { old: open(withoutSparseRankings), current: open(createMusicStore) };
  each(collation, owner => {
    seed(owner, { orphan: false });
    const declaration = owner.db.prepare("SELECT sql FROM sqlite_schema WHERE name='music_tracks'").get().sql;
    assert.match(declaration, /artist_id TEXT NOT NULL/u);
    owner.db.exec(`ALTER TABLE music_tracks RENAME TO prior_music_tracks;
      ${declaration.replace("artist_id TEXT NOT NULL", "artist_id TEXT COLLATE NOCASE NOT NULL")};
      INSERT INTO music_tracks SELECT * FROM prior_music_tracks; DROP TABLE prior_music_tracks;
      CREATE INDEX idx_music_tracks_artist ON music_tracks(artist_id, album_id, track_no, title);
      DELETE FROM music_track_state; UPDATE music_tracks SET artist_id='A0' WHERE id='t4';
      INSERT INTO music_track_state(track_id,play_count,last_played_at,updated_at) VALUES('t0',1,'2026-11-01','fixture');`);
  });
  clock += 6000;
  compareDrivers(collation, false);
  each(collation, ({ db }) => db.exec(`DROP INDEX idx_music_tracks_artist;
    CREATE INDEX idx_music_tracks_artist ON music_tracks(artist_id COLLATE BINARY, album_id, track_no, title);`));
  assert.equal(compareDrivers(collation, true).after.result.topArtists[0].trackCount, 15,
    "artist counts preserve the original a.id BINARY operand even on a legacy NOCASE reference");
  each(collation, ({ db }) => db.exec(`UPDATE music_track_state SET play_count=9223372036854775807 WHERE track_id='t0';
    INSERT INTO music_track_state(track_id,play_count,last_played_at,updated_at) VALUES('t8',1,'2026-11-02','fixture');`));
  const previousError = shape(caught(() => collation.old.store.report()));
  assert.match(previousError.message, /integer overflow/u);
  assert.deepEqual(shape(caught(() => collation.current.store.report())), previousError, "the sparse path retains native integer overflow");
  assert.equal(collation.current.db.isTransaction, false, "ranking errors release their snapshot");
  console.log(JSON.stringify({ check: "music-sparse-report-rankings", tracks: 100000, stateRows: 44, beforeDriver: "catalogue", afterDriver: "state",
    beforeMedianMs: +median(times.old).toFixed(3), afterMedianMs: +median(times.current).toFixed(3),
    fullRouteOracle: true, nonPlayingTimestampWinner: true, denseTieNumericAndOrphanFallback: true, legacyBinaryJoinCount: true, plans }));
}

const distributions = [];
try {
  for (const order of ["forward", "reverse", "shuffled"]) {
    const value = pair(); each(value, owner => seed(owner, { order })); clock += 6000;
    compare(value, order + " cold full report");
    compare(value, order + " warm full report");
    each(value, owner => owner.db.exec("ANALYZE")); compare(value, order + " analyzed native plan");
    each(value, owner => owner.db.exec("CREATE INDEX fixture_report_order ON music_track_state(play_count DESC,last_played_at DESC,track_id)"));
    compare(value, order + " additional covering state index");
    each(value, owner => owner.db.exec("UPDATE music_track_state SET play_count=30,last_played_at='2026-10-03' WHERE track_id='t7';"
      + "UPDATE music_albums SET title='修改专辑',cover_path='synthetic://new-cover',updated_at='new-version' WHERE id='al1'"));
    compare(value, order + " next-request changes while summary TTL remains cached");
    clock += 5000; compare(value, order + " expired complete summary");
    value.current.store.report().topAlbums[0].plays = -999;
    compare(value, order + " caller mutation cannot alter next computed album report");
    each(value, owner => owner.db.exec("DELETE FROM music_track_state WHERE track_id='t7'"));
    compare(value, order + " removed state changes the original aggregates");
    each(value, owner => seed(owner, { order, albums: 7 })); clock += 6000;
    compare(value, order + " scan publication keeps original report ordering");
  }
  const empty = pair(); compare(empty, "native empty tables"); compare(empty, "warm empty tables");
  const noPlays = pair(); each(noPlays, owner => { seed(owner); owner.db.exec("UPDATE music_track_state SET play_count=0"); }); clock += 6000;
  compare(noPlays, "no positive plays");
  const types = pair(); each(types, owner => {
    seed(owner); owner.db.prepare("UPDATE music_albums SET year=?,duration_ms=?,size_bytes=?,intro_text=? WHERE id='al1'")
      .run(new Uint8Array([65, 66]), "3.5", "not-a-number", new Uint8Array([88, 89]));
    owner.db.exec("UPDATE music_tracks SET album_id='' WHERE id='t9';UPDATE music_albums SET id=NULL WHERE id='al4'");
  }); clock += 6000;
  compare(types, "actual native blob/null/numeric DTO types and NULL orphan group");
  const errors = pair(); each(errors, owner => seed(owner)); clock += 6000;
  compare(errors, "warm summary before faults");
  for (const phase of ["prepare", "all"]) for (const error of [new Error("controlled report failure"),
    Object.assign(new Error("no such column: al.track_count"), { code: "ERR_SQLITE_ERROR", errcode: 1 }),
    Object.assign(new Error("no such column: al.year"), { code: "ERR_SQLITE_ERROR", errcode: 5 })]) {
    each(errors, owner => { fault = { db: owner.db, phase, error };
      assert.equal(caught(() => owner.store.report()), error, "unrelated failures preserve exact error identity"); fault = null; errorOracles++; });
    compare(errors, "same-owner repair " + phase);
  }
  each(errors, owner => {
    const error = Object.assign(new Error("no such column: al.year"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
    fault = { db: owner.db, phase: "all", error };
    assert.equal(caught(() => owner.store.report()), error, "read-time errors never invoke prepare-time compatibility"); fault = null; errorOracles++;
  });
  for (const optional of ["year", "duration_ms", "size_bytes", "updated_at"]) {
    const value = pair(); each(value, owner => seed(owner)); clock += 6000; compare(value, "legacy initial " + optional);
    each(value, owner => owner.db.exec(`ALTER TABLE music_albums RENAME COLUMN ${optional} TO private_legacy_${optional}`));
    const result = compare(value, "native missing optional " + optional, negative ? 0 : 1);
    assert.equal(result.after.unusedBytes, result.before.unusedBytes, "fallback returns the complete former row");
    each(value, owner => owner.db.exec(`ALTER TABLE music_albums RENAME COLUMN private_legacy_${optional} TO ${optional}`));
    compare(value, "schema repaired restores projection " + optional);
  }
  for (const unavailable of ["cover_path", "missing-table", "closed"]) {
    const value = pair(); each(value, owner => seed(owner)); clock += 6000; compare(value, "native fault initial " + unavailable);
    each(value, owner => unavailable === "closed" ? owner.db.close() : owner.db.exec(unavailable === "missing-table"
      ? "ALTER TABLE music_albums RENAME TO private_unavailable_albums" : "ALTER TABLE music_albums RENAME COLUMN cover_path TO private_cover_path"));
    assert.deepEqual(shape(caught(() => value.current.store.report())), shape(caught(() => value.old.store.report())),
      "native report failure remains unchanged " + unavailable); errorOracles++;
  }
  for (const width of [0, 8192, 524288]) {
    const value = pair(); each(value, owner => seed(owner, { albums: 64, width, orphan: false })); clock += 6000;
    const result = compare(value, "scale report width " + width);
    const detail = owner => publicAlbum(owner.db.prepare("SELECT al.*,a.name AS artist_name FROM music_albums al LEFT JOIN music_artists a ON a.id=al.artist_id WHERE al.id=?").get("al1"), { detail: true });
    compare(value, "stored album and detail serializer retain complete original intro", 0, detail);
    assert.equal(detail(value.current).intro.length, width);
    const times = { before: [], after: [] };
    for (let i = 0; i < 11; i++) for (const key of i % 2 ? ["after", "before"] : ["before", "after"]) {
      const started = performance.now(); (key === "before" ? value.old : value.current).store.report(); times[key].push(performance.now() - started);
    }
    distributions.push({ introBytesPerAlbum: width, rows: result.after.rows, formerFields: result.before.fields, fields: result.after.fields,
      formerIntroBytes: result.before.introBytes, introBytes: result.after.introBytes, formerUnusedBytes: result.before.unusedBytes,
      unusedBytes: result.after.unusedBytes, diagnosticMedianMs: { previous: Number(median(times.before).toFixed(3)), current: Number(median(times.after).toFixed(3)) } });
  }
  console.log(JSON.stringify({ musicReportProjection: "ok", responseOracles, planOracles, errorOracles,
    privateDatabases: owners.length, negative, distributions }));
  for (const value of distributions) {
    assert.equal(value.rows, 8, "original report returns eight album groups");
    assert.equal(value.formerFields, 144, "original wide groups read eighteen columns");
    assert.equal(value.fields, 96, "report reads only twelve displayed and aggregate columns");
    assert.equal(value.formerIntroBytes, value.introBytesPerAlbum * 8, "original intro bytes are actually observed");
    assert.equal(value.introBytes, 0, "report reads zero unused intro bytes");
    assert.equal(value.unusedBytes, 0, "report reads zero unused path/intro/sort bytes");
  }
  if (!negative) await verifySparseRankings();
} finally {
  measurement = fault = null;
  DatabaseSync.prototype.prepare = nativePrepare; Date.now = realNow;
  for (const owner of owners) await owner.store.stop();
}

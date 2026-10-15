import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
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
assert.equal(originalBlock.replace("const topAlbums = database\n      .prepare(", "const topAlbums = prepareAlbumFacet(database,")
  .replace("al.*,", "${ALBUM_FACET_COLUMNS},"), currentBlock, "captured complete original report algorithm changes only this projection/prepare");
const previousSource = source.replace(currentBlock, originalBlock);
assert.equal(previousSource.replace(originalBlock, currentBlock), source, "all non-report code restores byte-for-byte");
const absolute = previousSource.replace(/from "(\.\/[^"]+)"/gu, (_, value) => `from ${JSON.stringify(new URL(value, storePath).href)}`);
const { createMusicStore: previousStore } = await import(`data:text/javascript;base64,${Buffer.from(absolute).toString("base64")}`);
const subjectFactory = negative ? previousStore : createMusicStore;
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
function read(owner, operation = value => value.store.report()) {
  measurement = { db: owner.db, prepares: 0, queries: [], rows: 0, fields: 0, unusedBytes: 0, introBytes: 0 };
  try { return { result: operation(owner), ...measurement }; } finally { measurement = null; }
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
} finally {
  measurement = fault = null;
  DatabaseSync.prototype.prepare = nativePrepare; Date.now = realNow;
  for (const owner of owners) await owner.store.stop();
}

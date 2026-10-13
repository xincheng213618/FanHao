import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import { SMART_MIXES } from "../src/modules/music/server/smart-mix.js";
import { TRACK_LIST_COLUMNS } from "../src/modules/music/server/track-query.js";

assert(process.argv.slice(2).every(value => value === "--legacy-wide-tracks"));
const negative = process.argv.includes("--legacy-wide-tracks");
assert.equal(TRACK_LIST_COLUMNS.split(",").length, 18);
const storePath = new URL("../src/modules/music/server/store.js", import.meta.url);
const lyricPath = new URL("../src/modules/music/server/lyrics-search.js", import.meta.url);
const snapshots = [
  ["music-track-projection-store-legacy.txt", "fc59887c18e98dafb9a099b9b3033d17c0d4fc8fadb28be300fa8e2a56e9a2e4"],
  ["music-track-projection-lyrics-legacy.txt", "76e0c8da898e950b517a25d5f38806f5af8b8b794277ab7b94e3e2f8eab6c94a"]
].map(([name, sha]) => {
  const source = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(source).digest("hex"), sha, "complete captured pre-projection implementation");
  return source;
});
const absolute = (source, path) => source.replace(/from "(\.\/[^"]+)"/gu, (_, value) => `from ${JSON.stringify(new URL(value, path).href)}`);
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const oldLyricUrl = moduleUrl(absolute(snapshots[1], lyricPath));
const oldStoreUrl = moduleUrl(absolute(snapshots[0].replace("from " + JSON.stringify("./lyrics-search.js"), `from ${JSON.stringify(oldLyricUrl)}`), storePath));
const { createMusicStore: previousStore } = await import(oldStoreUrl);
const subject = negative ? previousStore : createMusicStore;
const prepare = DatabaseSync.prototype.prepare, originalNow = Date.now;
const owners = [], connections = [];
let measurement = null, fault = null, clock = 1791800000000;
let responseOracles = 0, sqlOracles = 0, errorOracles = 0;
const unused = ["sort_title", "source_root", "source_path", "relative_path", "ext", "mtime_ms", "lrc_path", "status", "error", "updated_at", "private_extra_blob"];
const normalize = sql => sql.replace(/\s+/gu, " ").trim();
const isTrackRow = sql => /^SELECT t\./u.test(normalize(sql)) && sql.includes(", a.name AS artist_name");
function comparableSql(sql) {
  const value = normalize(sql), suffix = value.indexOf(", a.name AS artist_name");
  return isTrackRow(sql) ? "SELECT t.*" + value.slice(suffix) : value;
}
Date.now = () => clock;
DatabaseSync.prototype.prepare = function(sql, ...args) {
  const db = this;
  if (!connections.includes(db)) connections.push(db);
  if (measurement?.db === db) measurement.prepares++;
  if (fault?.db === db && fault.phase === "prepare" && isTrackRow(sql)) throw fault.error;
  const statement = prepare.call(db, sql, ...args);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...input) => {
      if (key === "columns" && measurement?.db === db) measurement.metadataReads++;
      if (!['get', 'all'].includes(key)) return value.apply(target, input);
      if (fault?.db === db && fault.phase === key && isTrackRow(sql)) throw fault.error;
      const result = value.apply(target, input);
      if (measurement?.db === db) {
        measurement.queries.push({ sql: comparableSql(sql), input, phase: key });
        if (isTrackRow(sql)) for (const row of key === "all" ? result : result ? [result] : []) {
          measurement.rows++; measurement.fields += Object.keys(row).length;
          for (const field of unused) {
            const item = row[field];
            measurement.unusedBytes += typeof item === "string" ? Buffer.byteLength(item) : ArrayBuffer.isView(item) ? item.byteLength : 0;
          }
        }
      }
      return result;
    };
  } });
};
function open(factory) {
  const store = factory({ dbPath: ":memory:", roots: [], scanWorker: {
    start() { assert.fail("no worker start"); }, scan() { assert.fail("no scan"); }, async stop() {}, diagnostics() { return {}; }
  } });
  store.summary(); const owner = { store, db: connections.at(-1) }; owners.push(owner); return owner;
}
const pair = () => ({ old: open(previousStore), current: open(subject) });
const each = (value, action) => { action(value.old); action(value.current); };
function seed(owner, count = 48, order = "forward", pathWidth = 1) {
  const prefix = "/synthetic/" + "Directory中文/".repeat(pathWidth);
  const artists = Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, name: ["歌手2", "歌手10", "TEST", "test"][i], language: "中文", sortName: "",
    sourceRoot: prefix, sourcePath: prefix + "artist" + i, relativePath: "artist" + i, albumCount: 1, trackCount: count / 4, durationMs: 1000, sizeBytes: 100, updatedAt: "fixture" }));
  const albums = artists.map((artist, i) => ({ id: `al${i}`, artistId: artist.id, title: ["专辑2", "专辑10", "ALBUM", "album"][i], year: "2026",
    sortTitle: "unused", coverPath: i % 2 ? "synthetic://cover" + i : "", introPath: "", introText: "", sourceRoot: prefix,
    sourcePath: prefix + "album" + i, relativePath: "album" + i, trackCount: count / 4, durationMs: 1000, sizeBytes: 100, updatedAt: "cover-fixture" }));
  const tracks = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, artistId: `a${i % 4}`, albumId: `al${i % 4}`,
    title: ["测试歌曲", "TEST", "test", "é", "E", "中文 Ａ % _ \\ 𐐀"][i % 6], sortTitle: "unused", displayArtist: i % 3 ? artists[i % 4].name : "",
    albumTitle: i % 3 ? albums[i % 4].title : "", trackNo: i % 3, discNo: i % 2, genre: "测试", language: "中文",
    sourceRoot: prefix, sourcePath: prefix + `track-${i}.mp3`, relativePath: prefix + `relative-${i}.mp3`, fileName: `歌曲${i}.mp3`, ext: ".mp3",
    sizeBytes: 100 + i, mtimeMs: 1 + i, durationMs: i % 3 ? 1000 + i : 0, codec: "mp3", sampleRate: 44100, bitDepth: 16, channels: 2,
    lrcPath: prefix + `track-${i}.lrc`, hasLrc: 1, status: "ok", error: "", updatedAt: "2026-10-01" }));
  const lyrics = tracks.map((track, i) => ({ trackId: track.id, lrcPath: track.lrcPath, rawText: "[00:01]中文 music phrase\n[00:02]second line",
    parsedJson: i % 3 ? JSON.stringify([{ timeMs: 1000, text: "中文 music phrase" }, { timeMs: 2000, text: "second line" }]) : "malformed", updatedAt: "fixture" }));
  const arrange = rows => order === "reverse" ? rows.reverse() : order === "shuffled" ? rows.sort((a, b) => Number((a.id || a.trackId).match(/\d+/u)[0]) * 17 % (rows.length + 1)
    - Number((b.id || b.trackId).match(/\d+/u)[0]) * 17 % (rows.length + 1)) : rows;
  writeScanRecords(owner.db, { artists, albums, tracks: arrange(tracks), lyrics: arrange(lyrics) }, [], "fixture-scan");
  const state = owner.db.prepare("INSERT OR REPLACE INTO music_track_state VALUES(?,?,?,?,?,?,?,?)");
  for (let i = 0; i < count; i++) if (i % 5) state.run(`t${i}`, i % 2, i % 6, i, 3456, i % 7, i % 3 ? "2026-10-01" : "", "fixture-state");
  owner.db.exec("INSERT OR REPLACE INTO music_playlists(id,name,description,created_at,updated_at) VALUES('fixture','Playlist','Synthetic','fixture','fixture'); DELETE FROM music_playlist_items WHERE playlist_id='fixture'");
  const item = owner.db.prepare("INSERT INTO music_playlist_items(playlist_id,track_id,sort_order,added_at) VALUES('fixture',?,?,?)");
  for (let i = 0; i < count; i++) item.run(`t${i}`, i % 4, "fixture");
  owner.db.exec("UPDATE music_tracks SET status='missing' WHERE id='t3';UPDATE music_tracks SET artist_id='missing',album_id='missing' WHERE id='t5'");
}
const url = values => { const result = new URL("http://fixture/api/music/tracks"); for (const [key, value] of Object.entries(values)) result.searchParams.set(key, String(value)); return result; };
function read(owner, action) {
  measurement = { db: owner.db, prepares: 0, metadataReads: 0, queries: [], rows: 0, fields: 0, unusedBytes: 0 };
  try { return { result: action(owner.store), ...measurement }; } finally { measurement = null; }
}
function compare(value, action, label) {
  const before = read(value.old, action), after = read(value.current, action);
  assert.deepEqual(after.result, before.result, `${label}: whole response`);
  assert.equal(JSON.stringify(after.result), JSON.stringify(before.result), `${label}: complete serialized response`);
  assert.deepEqual(after.queries, before.queries, `${label}: every executed SQL body, bound parameter, read kind and order`);
  responseOracles++; sqlOracles += after.queries.length; return { before, after };
}
const actions = [
  ["summary", store => store.summary()], ["report", store => store.report()], ["suggest Chinese", store => store.suggest("中文")],
  ["suggest FTS", store => store.suggest("TEST")], ["tracks default", store => store.listTracks(url({ limit: 13, offset: 7 }))],
  ...["title", "played", "favorites", "rating", "duration"].map(sort => ["tracks " + sort, store => store.listTracks(url({ sort, limit: 13, offset: 3 }))]),
  ["tracks search", store => store.listTracks(url({ q: "测试", limit: 11 }))], ["tracks escaped", store => store.listTracks(url({ q: "%", limit: 11 }))],
  ["tracks filtered", store => store.listTracks(url({ artist: "a1", language: "中文", favorite: "1", minRating: "2", lyrics: "1" }))],
  ["history", store => store.listHistory(url({ limit: 19 }))], ["playlist", store => store.playlistDetail("fixture")],
  ["short lyrics", store => store.searchLyrics(url({ q: "中", limit: 7, offset: 4 }))], ["indexed lyrics", store => store.searchLyrics(url({ q: "music phrase", limit: 7, offset: 4 }))],
  ["detail retains file fields", store => store.trackDetail("t7")],
  ...SMART_MIXES.map(mix => ["smart " + mix.id, store => store.smartPlaylistDetail(mix.id, url({ limit: 9, offset: 2 }))])
];
const errorShape = error => ({ name: error.name, message: error.message, code: error.code, errcode: error.errcode });
const caught = callback => { try { callback(); } catch (error) { return error; } assert.fail("expected observable error"); };
const metrics = [];
try {
  for (const order of ["forward", "reverse", "shuffled"]) {
    const value = pair(); each(value, owner => seed(owner, 48, order)); clock += 6000;
    for (const [name, action] of actions) compare(value, action, `${order} ${name}`);
    each(value, owner => owner.db.exec("ANALYZE;CREATE INDEX fixture_state_order ON music_track_state(play_count DESC,last_played_at DESC,track_id)"));
    for (const [name, action] of actions) compare(value, action, `${order} analyzed/indexed ${name}`);
    each(value, owner => owner.db.exec("UPDATE music_track_state SET play_count=99,position_ms=4321,last_played_at='2026-10-02' WHERE track_id='t7';UPDATE music_tracks SET title='修改歌曲',status='ok' WHERE id='t3'")); clock += 6000;
    for (const [name, action] of actions) compare(value, action, `${order} changed ${name}`);
  }
  const empty = pair(); for (const [name, action] of actions) compare(empty, action, "empty " + name);
  const upperTable = pair(); each(upperTable, owner => { seed(owner); owner.db.exec('ALTER TABLE music_tracks RENAME TO temporary_track_table;ALTER TABLE temporary_track_table RENAME TO "MUSIC_TRACKS"'); }); clock += 6000;
  compare(upperTable, store => store.playlistDetail("fixture"), "case-insensitive native table identifier keeps the complete original DTO");
  const extended = pair(); each(extended, owner => {
    seed(owner); owner.db.exec("ALTER TABLE music_tracks ADD COLUMN cover_updated_at TEXT DEFAULT 'legacy-cover';ALTER TABLE music_tracks ADD COLUMN favorite INTEGER DEFAULT 99");
    owner.db.prepare("UPDATE music_tracks SET size_bytes=?,bit_depth=?,title=? WHERE id='t7'").run("3.5", "not-a-number", new Uint8Array([65, 66]));
  }); clock += 6000;
  for (const [name, action] of actions) compare(extended, action, "legacy extensions/blob/native types " + name);
  each(extended, owner => owner.db.exec("ALTER TABLE music_tracks RENAME COLUMN cover_updated_at TO removed_cover_stamp"));
  compare(extended, store => store.playlistDetail("fixture"), "same owner changed extension schema");
  for (const column of ["disc_no", "codec", "sample_rate", "bit_depth", "channels", "has_lrc"]) {
    const value = pair(); each(value, owner => seed(owner)); clock += 6000; each(value, owner => owner.store.playlistDetail("fixture"));
    each(value, owner => owner.db.exec(`ALTER TABLE music_tracks RENAME COLUMN ${column} TO private_legacy_${column}`));
    compare(value, store => store.playlistDetail("fixture"), "native missing optional " + column);
    each(value, owner => owner.db.exec(`ALTER TABLE music_tracks RENAME COLUMN private_legacy_${column} TO ${column}`));
    compare(value, store => store.playlistDetail("fixture"), "same owner schema repair " + column);
  }
  const failures = pair(); each(failures, owner => seed(owner)); clock += 6000; each(failures, owner => owner.store.playlistDetail("fixture"));
  for (const phase of ["prepare", "all"]) for (const error of [new Error("controlled track row failure"), Object.assign(new Error("SQLITE_BUSY"), { code: "ERR_SQLITE_ERROR", errcode: 5 })]) {
    each(failures, owner => { fault = { db: owner.db, phase, error }; assert.equal(caught(() => owner.store.playlistDetail("fixture")), error); fault = null; errorOracles++; });
    compare(failures, store => store.playlistDetail("fixture"), "same owner " + phase + " recovery");
  }
  for (const kind of ["table", "closed"]) {
    const value = pair(); each(value, owner => { seed(owner); owner.store.playlistDetail("fixture");
      if (kind === "closed") owner.db.close(); else owner.db.exec("ALTER TABLE music_tracks RENAME TO unavailable_tracks"); });
    assert.deepEqual(errorShape(caught(() => value.current.store.playlistDetail("fixture"))), errorShape(caught(() => value.old.store.playlistDetail("fixture")))); errorOracles++;
  }
  for (const width of [1, 12]) {
    const value = pair(); each(value, owner => seed(owner, 1500, "forward", width)); clock += 6000; each(value, owner => owner.store.playlistDetail("fixture"));
    const measured = compare(value, store => store.playlistDetail("fixture"), "full playlist path width " + width);
    const timings = { old: [], current: [] };
    for (let i = 0; i < 9; i++) for (const key of i % 2 ? ["current", "old"] : ["old", "current"]) {
      const started = performance.now(); value[key].store.playlistDetail("fixture"); timings[key].push(performance.now() - started);
    }
    const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
    metrics.push({ tracks: measured.after.rows, pathWidth: width, previousFields: measured.before.fields, fields: measured.after.fields,
      previousUnusedBytes: measured.before.unusedBytes, unusedBytes: measured.after.unusedBytes,
      executedReads: measured.after.queries.length, prepares: measured.after.prepares, metadataReads: measured.after.metadataReads,
      diagnosticMedianMs: { previous: Number(median(timings.old).toFixed(3)), current: Number(median(timings.current).toFixed(3)) } });
    compare(value, store => store.trackDetail("t7"), "long stored path and complete detail unchanged " + width);
  }
  console.log(JSON.stringify({ musicTrackProjection: "oracles passed", negative, responseOracles, sqlOracles, errorOracles, privateDatabases: owners.length, metrics }));
  for (const metric of metrics) {
    assert.equal(metric.unusedBytes, 0, "projection gate: public track rows retain zero unused source metadata bytes");
    assert.ok(metric.fields < metric.previousFields, "projection gate: strictly fewer raw fields");
    assert.equal(metric.metadataReads, 1, "one statement metadata inspection, with no extra executed row read");
  }
  console.log("music-track-projection: PASS");
} finally {
  fault = null; measurement = null; DatabaseSync.prototype.prepare = prepare; Date.now = originalNow;
  for (const owner of owners) { await owner.store.stop(); if (owner.db.isOpen) owner.db.close(); }
}

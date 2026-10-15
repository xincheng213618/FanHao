import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { MUSIC_FACET_CACHE } from "../src/modules/music/server/constants.js";
import { SMART_MIXES } from "../src/modules/music/server/smart-mix.js";
import { insertMusicPhoneticSearchRow, insertMusicShortSearchRow } from "../src/modules/music/server/search.js";

// Store-owned :memory: connections only. Restore just the former count paths
// for a full-response oracle; schema, page queries and hydration stay real.
const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
const queryUrl = new URL("../src/modules/music/server/query.js", import.meta.url);
const metadataMixes = ["newest", "hires", "lyrics", "longform"];
const countBlock = `    const countFrom = smartMixRequiresState(mix)
      ? "music_track_state s CROSS JOIN music_tracks t ON t.id = s.track_id"
      : isMetadataOnlySmartMix(mix)
        ? "music_tracks t"
        : "music_tracks t LEFT JOIN music_track_state s ON s.track_id = t.id";`;
const formerCountBlock = `    const countFrom = smartMixRequiresState(mix)
      ? "music_track_state s CROSS JOIN music_tracks t ON t.id = s.track_id"
      : "music_tracks t LEFT JOIN music_track_state s ON s.track_id = t.id";`;
const needsState = "needsState: favorite || minRating > 0 || Boolean(smartMix && !isMetadataOnlySmartMix(smartMix)),";
let querySource = fs.readFileSync(queryUrl, "utf8");
assert.equal(querySource.split(needsState).length, 2);
querySource = querySource.replace(needsState, "needsState: favorite || minRating > 0 || Boolean(smartMix),");
const oldQueryUrl = sourceUrl(resolveImports(querySource, queryUrl));
let storeSource = fs.readFileSync(storeUrl, "utf8").replaceAll("\r\n", "\n");
assert.equal(storeSource.split(countBlock).length, 2);
storeSource = storeSource.replace(countBlock, formerCountBlock);
storeSource = resolveImports(storeSource, storeUrl, { "./query.js": oldQueryUrl });
const { createMusicStore: formerFactory } = await import(sourceUrl(storeSource));
const factory = process.argv.includes("--legacy-metadata-count") ? formerFactory : createMusicStore;
assert.ok(process.argv.slice(2).every(value => value === "--legacy-metadata-count"));
const originalPrepare = DatabaseSync.prototype.prepare;
const originalNow = Date.now;
const connections = [];
const stores = [];
let clock = 1800000000000;
let measurement = null;
Date.now = () => clock;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  if (!connections.includes(this)) {
    connections.push(this);
    this.function("fixture_state_probe", value => { if (measurement?.database === this) measurement.stateProbes++; return value; });
  }
  const text = sql.replace(/\s+/gu, " ").trim();
  const count = /^SELECT COUNT\(\*\) AS count FROM music_tracks t\b/u.test(text);
  const page = /^SELECT t\.\*,/u.test(text) && /\bLIMIT \? OFFSET \?/u.test(text);
  if (measurement?.database === this) {
    if (count) {
      measurement.countQueries++;
      measurement.countSql.push(text);
      // Only the join key becomes an identity function. Keep every original
      // filter and index predicate; the independent plan records the real SQL.
      sql = sql.replace("s.track_id = t.id", "s.track_id = fixture_state_probe(t.id)");
    }
    if (page) measurement.pageSql.push(text);
  }
  return originalPrepare.call(this, sql, ...args);
};

let responseOracles = 0;
const metrics = [];
try {
  const current = open(factory, 512), previous = open(formerFactory, 512);
  const variants = [
    {}, { favorite: "1" }, { favorite: "true", minRating: "4" }, { minRating: "3" },
    { favorite: "no", minRating: "0" }, { minRating: "bad" }, { minRating: "9" },
    { artist: "artist-1" }, { album: "album-2" }, { genre: "Rock" }, { language: "中文" },
    { q: "artist" }, { q: "曲" }, { q: "测试歌曲" }, { q: "!!" },
    { lyrics: "true", quality: "lossless" },
    { favorites: "1", playedSeconds: "30", minPlayedSeconds: "10" }
  ];
  for (const id of metadataMixes) {
    for (const extra of variants) {
      compare(current, previous, "tracks", id, { limit: "7", offset: "2", ...extra });
      compare(current, previous, "detail", id, { limit: "7", offset: "2", ...extra });
    }
    for (const sort of ["album", "title", "artist", "duration", "played", "favorite", "rating", "unknown"]) {
      compare(current, previous, "tracks", id, { sort, limit: "3" });
    }
    for (const offset of ["0", "500", "1000"]) {
      compare(current, previous, "tracks", id, { limit: "1", offset });
      compare(current, previous, "detail", id, { limit: "1", offset });
    }
    const filtered = measure(current, "tracks", id, { favorite: "yes", minRating: "4" });
    assert.ok(filtered.countSql.some(sql => sql.includes("LEFT JOIN music_track_state s")), "favorite/rating filters still require the state join");
    assert.ok(filtered.result.total > 0, "state-filtered controls must include real matching rows");
    assert.ok(filtered.result.tracks.every(track => track.favorite && track.rating >= 4));
  }
  for (const id of [...SMART_MIXES.filter(mix => !metadataMixes.includes(mix.id)).map(mix => mix.id), "unknown", ""]) {
    compare(current, previous, "tracks", id, { limit: "7", offset: "1", sort: "played" });
    compare(current, previous, "detail", id, { limit: "7", offset: "1" });
  }
  for (const key of ["playedSeconds", "minPlayedSeconds", "favorites"]) {
    for (const endpoint of ["tracks", "detail"]) {
      assert.deepEqual(call(current, endpoint, "newest", { [key]: "999999" }), call(current, endpoint, "newest", {}), `${key} retains its existing ignored-parameter behavior`);
    }
  }
  for (const sql of [
    "UPDATE music_track_state SET favorite=1,rating=5,play_count=9 WHERE track_id='track-15'",
    "UPDATE music_tracks SET status='error',has_lrc=0 WHERE id='track-15'",
    "UPDATE music_tracks SET status='ok',has_lrc=1 WHERE id='track-15'",
    "DELETE FROM music_track_state WHERE track_id='track-15'"
  ]) {
    current.database.exec(sql); previous.database.exec(sql); clock += 6000;
    for (const id of metadataMixes) {
      compare(current, previous, "tracks", id, { favorite: "1", sort: "rating" });
      compare(current, previous, "detail", id, {});
    }
  }

  const large = open(factory, 30000), largePrevious = open(formerFactory, 30000);
  for (const id of metadataMixes) for (const endpoint of ["tracks", "detail"]) {
    const currentWork = measure(large, endpoint, id, { limit: "7" });
    const previousWork = measure(largePrevious, endpoint, id, { limit: "7" });
    assert.deepEqual(currentWork.result, previousWork.result);
    assert.deepEqual(currentWork.pageSql, previousWork.pageSql, "page joins/projection/sort and state hydration must stay byte-for-byte unchanged");
    assert.equal(currentWork.countQueries, 1);
    assert.equal(previousWork.countQueries, 1);
    assert.equal(currentWork.stateProbes, 0, `${endpoint}/${id} must not probe music_track_state for its metadata-only count`);
    assert.ok(previousWork.stateProbes >= 10000, "the old count must exercise catalogue-sized state index probes");
    const countSql = currentWork.countSql[0];
    assert.doesNotMatch(countSql, /JOIN music_track_state/);
    assert.match(previousWork.countSql[0], /LEFT JOIN music_track_state/);
    const plan = originalPrepare.call(largePrevious.database, `EXPLAIN QUERY PLAN ${previousWork.countSql[0]}`).all();
    assert.ok(plan.some(row => /SEARCH s .*LEFT-JOIN/.test(row.detail)), "the uninstrumented old plan must really retain its state lookup");
    metrics.push({ endpoint, id, total: currentWork.result.total, previousStateProbes: previousWork.stateProbes, currentStateProbes: currentWork.stateProbes });
  }
  console.log(JSON.stringify({ ok: true, responseOracles, catalogTracks: 30000, metrics }, null, 2));
} finally {
  measurement = null;
  try { for (const store of stores) await store.stop(); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; Date.now = originalNow; }
}

function open(create, count) {
  const store = create({ dbPath: ":memory:", roots: [], scanWorker: {
    start() { assert.fail("fixture never starts a scan worker"); }, scan() { assert.fail("fixture never scans media"); }, async stop() {}
  } });
  stores.push(store); store.summary();
  const database = connections.at(-1);
  database.exec("BEGIN");
  for (let i = 0; i < 2; i++) database.prepare("INSERT INTO music_artists(id,name,language,source_root,source_path,relative_path,track_count,status,updated_at) VALUES(?,?,?,'synthetic',?,'artist',?,'ok','2026')")
    .run(`artist-${i}`, `Artist ${i}`, i ? "中文" : "其他", `synthetic/artist/${i}`, Math.ceil(count / 2));
  for (let i = 0; i < 4; i++) database.prepare("INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at) VALUES(?,?,?,'synthetic',?,'album',?,'2026')")
    .run(`album-${i}`, `artist-${i % 2}`, `Album ${i}`, `synthetic/album/${i}`, Math.ceil(count / 4));
  const insert = database.prepare("INSERT INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,track_no,disc_no,genre,language,source_root,source_path,relative_path,file_name,ext,duration_ms,codec,bit_depth,sample_rate,has_lrc,status,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,'synthetic',?,?,?, ?,?,?,?,?,?,?,?)");
  const state = database.prepare("INSERT INTO music_track_state(track_id,favorite,rating,position_ms,duration_ms,play_count,last_played_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
  const fullSearch = database.prepare("INSERT INTO music_search(track_id,title,artist,album,lyrics) VALUES(?,?,?,?,?)");
  const shortSearch = database.prepare("INSERT INTO music_search_short(track_id,title,artist,album,genre,file_name) VALUES(?,?,?,?,?,?)");
  const phoneticSearch = database.prepare("INSERT INTO music_search_phonetic(track_id,artist_id,album_id,title,artist,album,file_name) VALUES(?,?,?,?,?,?,?)");
  for (let i = 0; i < count; i++) {
    const id = `track-${i}`, artist = `Artist ${i % 2}`, album = `Album ${i % 4}`;
    const title = i % 17 === 0 ? "测试歌曲 !!" : `Track ${String(i).padStart(6, "0")}`;
    const ext = i % 2 ? ".flac" : ".mp3";
    const active = i % 11 !== 0;
    insert.run(id, `artist-${i % 2}`, `album-${i % 4}`, title, artist, album, i % 9, i % 3 ? "Pop" : "Rock", i % 2 ? "中文" : "其他", `synthetic/track/${i}`, `${i}${ext}`, `${i}${ext}`, ext, i % 3 ? 400000 : 12345, i % 2 ? "flac" : "mp3", i % 5 ? 16 : 24, i % 7 ? 44100 : 96000, i % 2, active ? "ok" : "missing", i % 13 ? "2026-10-13" : "");
    if (i % 3 === 0) state.run(id, i % 2, Math.floor(i / 3) % 6, i * 100, 5678, i % 5, i % 4 ? "2026-01-01" : null, "2026-02-01");
    // This active lossless track also has lyrics, a long duration and a date:
    // all four metadata mixes must exercise a nonempty favorite/rating subset.
    if (i === 17) state.run(id, 1, 5, 1700, 400000, 1, "2026-01-01", "2026-02-01");
    if (count <= 512 && active) {
      fullSearch.run(id, title, artist, album, "");
      const row = { id, artistId: `artist-${i % 2}`, albumId: `album-${i % 4}`, title, displayArtist: artist, albumTitle: album, genre: i % 3 ? "Pop" : "Rock", fileName: `${i}${ext}` };
      insertMusicShortSearchRow(shortSearch, row); insertMusicPhoneticSearchRow(phoneticSearch, row);
    }
  }
  state.run("orphan", 1, 5, 1, 1, 9, "2026-01-01", "2026-02-01");
  database.exec("COMMIT");
  MUSIC_FACET_CACHE.delete(database); clock += 6000; store.summary(); store.facets();
  return { store, database };
}
function call(target, endpoint, id, values) {
  const url = new URL("http://fixture.invalid/");
  url.search = new URLSearchParams({ ...(id ? { smart: id } : {}), ...values }).toString();
  return endpoint === "tracks" ? target.store.listTracks(url) : target.store.smartPlaylistDetail(id, url);
}
function compare(current, previous, endpoint, id, values) {
  assert.deepEqual(call(current, endpoint, id, values), call(previous, endpoint, id, values), `full response ${endpoint}/${id}/${JSON.stringify(values)}`);
  responseOracles++;
}
function measure(target, endpoint, id, values) {
  measurement = { database: target.database, stateProbes: 0, countQueries: 0, countSql: [], pageSql: [] };
  try { return { result: call(target, endpoint, id, values), ...measurement }; }
  finally { measurement = null; }
}
function resolveImports(source, owner, overrides = {}) {
  return source.replace(/from "(\.\/[^"]+)"/gu, (_, relative) => `from ${JSON.stringify(overrides[relative] || new URL(relative, owner).href)}`);
}
function sourceUrl(source) { return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`; }

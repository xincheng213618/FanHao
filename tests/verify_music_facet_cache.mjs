import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { cachedMusicFacet, albumFacet, genreFacet, artistFacet } from "../src/modules/music/server/facets.js";
import {
  MUSIC_FACET_CACHE,
  MAX_INTRO_BYTES,
  MUSIC_FACET_CACHE_MAX_ENTRIES,
  MUSIC_FACET_CACHE_MAX_ESTIMATED_BYTES,
  MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES,
  MUSIC_FACET_CACHE_MAX_KEY_BYTES
} from "../src/modules/music/server/constants.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import { artistNameForSort } from "../src/modules/music/server/helpers.js";
import { insertMusicPhoneticSearchRow } from "../src/modules/music/server/search.js";

const legacyAlbumCount = process.argv.includes("--legacy-album-count");
const legacyWideArtistCache = process.argv.includes("--legacy-wide-artist-cache");
const legacyWideArtistSql = process.argv.includes("--legacy-wide-artist-sql");
const legacyWideAlbumFacet = process.argv.includes("--legacy-wide-album-facet");
const legacyWideAlbumList = process.argv.includes("--legacy-wide-album-list");
assert(process.argv.slice(2).every(argument => ["--legacy-album-count", "--legacy-wide-artist-cache", "--legacy-wide-artist-sql", "--legacy-wide-album-facet", "--legacy-wide-album-list"].includes(argument)), "known arguments");

// This preflight uses actual store-owned :memory: connections only. Its
// old-response/error/schema oracles finish before any existing disk fixture.
const albumFacetProjection = await verifyAlbumFacetProjection();
const albumListProjection = await verifyAlbumListProjection();

// Synthetic catalog metadata only: no media files, probe, worker, server,
// existing database, browser profile or network access.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-facet-cache-"));
const dbPath = path.join(directory, "catalog.sqlite");
const records = syntheticCatalog(directory);
const database = new DatabaseSync(dbPath);
ensureSchema(database);
writeScanRecords(database, records, [directory], "2026-10-04T00:00:00.000Z");

const originalPrepare = DatabaseSync.prototype.prepare;
const sortedBuilds = [];
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const statement = originalPrepare.call(this, sql, ...args);
  if (/^SELECT (?:\*|id,name,language,album_count,track_count,duration_ms,size_bytes) FROM music_artists WHERE track_count > 0/u.test(sql)) {
    const measurement = { database: this, sql, rows: 0, nameReads: 0 };
    sortedBuilds.push(measurement);
    const all = statement.all.bind(statement);
    statement.all = (...params) => {
      const rows = all(...params); measurement.rows = rows.length;
      for (const row of rows) {
        const name = row.name;
        Object.defineProperty(row, "name", { enumerable: true, get() { measurement.nameReads++; return name; } });
      }
      return rows;
    };
  }
  return statement;
};
const store = createMusicStore({ dbPath, roots: [] });
const metrics = {};
try {
  verifyEquivalentLetters(store);
  verifyArtistFilteringAndPagination(store);
  await verifyArtistSortWork(store);
  verifyFacetFiltersAndCapacity(database);
  verifyLru(database);
  verifyEstimatedWeightAndBypass(database);
  verifyConnectionAndScanInvalidation(store, database);
  await verifyLegacyLetterCounterproof();
  verifyWeakOwnership();
  await verifyAlbumCountJoins();
  await verifyArtistCacheProjection();
  console.log(JSON.stringify({ ok: true, scenarios: 13, ...metrics, albumFacetProjection, albumListProjection }, null, 2));
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  await store.stop();
  database.close();
  // Flat, owned fixture directory; remove individual SQLite files only.
  for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
}

function verifyEquivalentLetters(target) {
  const before = sortedBuilds.length;
  const started = performance.now();
  const baseline = target.listArtists(artistUrl({ limit: 20 }));
  for (let index = 0; index < 200; index += 1) {
    const letter = `ignored-${index}`;
    const result = target.listArtists(artistUrl({ letter, limit: 20 }));
    assert.deepEqual(result.artists, baseline.artists);
    assert.equal(result.total, baseline.total);
    assert.equal(result.letter, letter, "the response preserves the requested letter");
  }
  for (const language of ["all", "全部", "ignored-language"]) {
    assert.deepEqual(target.listArtists(artistUrl({ language, limit: 20 })).artists, baseline.artists);
  }
  assert.equal(sortedBuilds.length - before, 1, "equivalent unfiltered requests build and sort the full catalog once");
  const aBefore = sortedBuilds.length;
  const upper = target.listArtists(artistUrl({ letter: "A" }));
  const lower = target.listArtists(artistUrl({ letter: "a" }));
  assert.deepEqual(upper.artists, lower.artists);
  assert.equal(lower.letter, "a");
  assert.equal(sortedBuilds.length - aBefore, 1);
  const digitBefore = sortedBuilds.length;
  const digits = target.listArtists(artistUrl({ letter: "0" }));
  for (const letter of "123456789") {
    const result = target.listArtists(artistUrl({ letter }));
    assert.deepEqual(result.artists, digits.artists);
    assert.equal(result.letter, letter);
  }
  assert.equal(sortedBuilds.length - digitBefore, 1, "each digit represents the existing entire numeric group");
  metrics.equivalentLetterRequests = { variants: 200, fullSortBuilds: 1, elapsedMs: Number((performance.now() - started).toFixed(2)) };
}

function verifyArtistFilteringAndPagination(target) {
  const all = target.listArtists(artistUrl({ limit: 300 }));
  assert.equal(all.total, records.artists.length);
  const ids = [];
  for (let offset = 0; offset < all.total; offset += 23) {
    const page = target.listArtists(artistUrl({ limit: 23, offset }));
    ids.push(...page.artists.map(artist => artist.id));
    assert.equal(page.hasMore, offset + page.artists.length < page.total);
  }
  assert.deepEqual(ids, all.artists.map(artist => artist.id), "cached sorting preserves Chinese/numeric pagination order");
  for (const [letter, matches] of [
    ["A", name => /^[Aa]/u.test(name)],
    ["4", name => /^[0-9]/u.test(name)],
    ["待", name => name === "待识别"],
    ["#", name => !/^[A-Za-z0-9]/u.test(name)]
  ]) {
    const result = target.listArtists(artistUrl({ letter, limit: 300 }));
    assert.deepEqual(new Set(result.artists.map(artist => artist.id)), new Set(records.artists.filter(artist => matches(artist.name)).map(artist => artist.id)));
  }
  const chinese = target.listArtists(artistUrl({ language: "中文", limit: 300 }));
  assert.ok(chinese.artists.length > 20);
  assert.ok(chinese.artists.every(artist => artist.language === "中文"));
  const searchBefore = sortedBuilds.length;
  for (let index = 0; index < 2; index += 1) {
    const result = target.listArtists(artistUrl({ q: "周", limit: 300 }));
    assert.ok(result.artists.length > 0);
    assert.ok(result.artists.every(artist => artist.name.includes("周")));
  }
  assert.equal(sortedBuilds.length - searchBefore, 2, "query-dependent artist results retain their existing uncached path");
}

async function verifyArtistSortWork(target) {
  const query = "Artist", limit = 20;
  const response = target.listArtists(artistUrl({ q: query, limit }));
  const measured = sortedBuilds.at(-1);
  assert.ok(measured.rows > limit);
  assert.equal(measured.nameReads, measured.rows + response.artists.length, "each sort key reads the artist name once; only the returned page reads it again");
  const source = originalPrepare.call(database, "SELECT * FROM music_artists WHERE track_count > 0").all();
  const oldOrder = rows => rows.sort((left, right) => artistNameForSort(left.name).localeCompare(artistNameForSort(right.name), "zh-CN", { numeric: true, sensitivity: "base" }));
  const expected = oldOrder(source.filter(row => row.name.toLowerCase().includes(query.toLowerCase()))).slice(0, limit);
  assert.deepEqual(response.artists.map(row => row.id), expected.map(row => row.id));
  const all = target.listArtists(artistUrl({ limit: 300 }));
  assert.deepEqual(all.artists.map(row => row.id), oldOrder(source).map(row => row.id), "NFKC, punctuation, numbers, accents and collation ties preserve the former stable order");

  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const optimized = '.map(row => ({ row, key: artistNameForSort(row.name) }))\n          .sort((left, right) => artistNameCollator.compare(left.key, right.key))\n          .map(entry => entry.row)';
  const production = fs.readFileSync(storeUrl, "utf8").replaceAll("\r\n", "\n");
  assert.equal(production.split(optimized).length, 2);
  const legacySource = production.replace(optimized, '.sort((left, right) => artistNameForSort(left.name).localeCompare(artistNameForSort(right.name), "zh-CN", { numeric: true, sensitivity: "base" }))')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (_match, start, relative, end) => `${start}${new URL(relative, storeUrl).href}${end}`);
  const legacyModule = await import(`data:text/javascript;base64,${Buffer.from(legacySource).toString("base64")}`);
  const legacy = legacyModule.createMusicStore({ dbPath, roots: [] });
  try {
    const former = legacy.listArtists(artistUrl({ q: query, limit }));
    const oldWork = sortedBuilds.at(-1);
    assert.deepEqual(former, response, "the actual legacy store returns the same complete response");
    assert.throws(() => assert.equal(oldWork.nameReads, oldWork.rows + former.artists.length), assert.AssertionError, "the former comparator really fails the bounded sort-key work assertion");
    metrics.artistSortWork = { matchedArtists: measured.rows, optimizedNameReads: measured.nameReads, legacyNameReads: oldWork.nameReads };
  } finally { await legacy.stop(); }
}

function verifyFacetFiltersAndCapacity(db) {
  MUSIC_FACET_CACHE.delete(db);
  const colonLeft = albumFacet(db, "a:b", "c");
  const colonRight = albumFacet(db, "a", "b:c");
  assert.deepEqual(colonLeft.map(album => album.id), ["album-0"]);
  assert.deepEqual(colonRight.map(album => album.id), ["album-1"], "artist/genre colons cannot alias another filter tuple");
  assert.strictEqual(albumFacet(db, "all", "all", "全部"), albumFacet(db, "", "", ""), "unfiltered aliases share one result");
  assert.strictEqual(genreFacet(db, "all"), genreFacet(db, ""));
  assert.strictEqual(artistFacet(db, "all"), artistFacet(db, ""));
  for (const artist of records.artists) {
    const albums = albumFacet(db, artist.id);
    assert.ok(albums.length > 0);
    assert.ok(albums.every(album => album.artistId === artist.id));
    const genres = genreFacet(db, artist.id);
    assert.deepEqual(genres.map(genre => genre.name), [...new Set(records.tracks.filter(track => track.artistId === artist.id).map(track => track.genre))]);
    assertBound(db);
  }
  metrics.realFilterCapacity = { uniqueArtists: records.artists.length, retainedEntries: MUSIC_FACET_CACHE.get(db).size, estimatedJsonBytes: estimatedCacheBytes(db) };
}

function verifyLru(db) {
  MUSIC_FACET_CACHE.delete(db);
  for (const artist of records.artists.slice(0, MUSIC_FACET_CACHE_MAX_ENTRIES)) genreFacet(db, artist.id);
  const cache = MUSIC_FACET_CACHE.get(db);
  const [first, second] = cache.keys();
  const firstRows = cache.get(first);
  assert.strictEqual(genreFacet(db, records.artists[0].id), firstRows);
  genreFacet(db, records.artists[MUSIC_FACET_CACHE_MAX_ENTRIES].id);
  assert.equal(cache.has(first), true, "a cache read renews recency");
  assert.equal(cache.has(second), false, "the unused oldest filter is evicted");
  assert.equal(cache.size, MUSIC_FACET_CACHE_MAX_ENTRIES);
  cache.clear();
  assert.ok(genreFacet(db, records.artists[1].id).length > 0);
  assert.equal(cache.size, 1, "clearing the compatible Map resets weight accounting");
}

function verifyEstimatedWeightAndBypass(db) {
  MUSIC_FACET_CACHE.delete(db);
  for (let index = 0; index < 20; index += 1) {
    cachedMusicFacet(db, `weight-${index}`, () => db.prepare("SELECT ? AS value").all("x".repeat(1024 * 1024)));
    assertBound(db);
  }
  const cache = MUSIC_FACET_CACHE.get(db);
  assert.ok(cache.size < 20 && cache.size > 10, "JSON weight evicts before the entry-count limit");
  assert.equal(cache.has("weight-0"), false);
  assert.equal(cache.has("weight-19"), true);
  metrics.weightCapacity = { retainedEntries: cache.size, estimatedJsonBytes: estimatedCacheBytes(db) };
  const retained = [...cache.keys()];
  let builds = 0;
  const largeKey = "é".repeat(MUSIC_FACET_CACHE_MAX_KEY_BYTES / 2 + 1);
  const largeValue = "x".repeat(MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES + 1);
  for (let index = 0; index < 2; index += 1) {
    assert.equal(cachedMusicFacet(db, largeKey, () => { builds += 1; return db.prepare("SELECT 'key-bypass' AS value").get().value; }), "key-bypass");
    assert.strictEqual(cachedMusicFacet(db, "large-entry", () => { builds += 1; return db.prepare("SELECT ? AS value").get(largeValue).value; }), largeValue);
  }
  assert.equal(builds, 4, "oversized keys and values return normally without retention");
  assert.deepEqual([...cache.keys()], retained, "bypass does not evict useful cached filters");
  MUSIC_FACET_CACHE.delete(db);
  const boundaryKey = "entry-boundary";
  const boundaryValue = "x".repeat(MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES - Buffer.byteLength(boundaryKey) - 2);
  cachedMusicFacet(db, boundaryKey, () => boundaryValue);
  assert.equal(MUSIC_FACET_CACHE.get(db).size, 1);
  assert.equal(estimatedCacheBytes(db), MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES);
  assertBound(db);
}

function verifyConnectionAndScanInvalidation(target, db) {
  target.listArtists(artistUrl());
  const oldConnection = sortedBuilds.at(-1).database;
  const oldCache = MUSIC_FACET_CACHE.get(oldConnection);
  target.invalidate();
  const before = sortedBuilds.length;
  target.listArtists(artistUrl());
  const newConnection = sortedBuilds.at(-1).database;
  assert.equal(sortedBuilds.length - before, 1);
  assert.notStrictEqual(newConnection, oldConnection);
  assert.notStrictEqual(MUSIC_FACET_CACHE.get(newConnection), oldCache, "reopened stores cannot reuse a closed connection's facets");
  MUSIC_FACET_CACHE.delete(db);
  const prior = artistFacet(db);
  const scanCache = MUSIC_FACET_CACHE.get(db);
  const nextRecords = syntheticCatalog(directory);
  nextRecords.artists[0].name = "! Published replacement";
  writeScanRecords(db, nextRecords, [directory], "2026-10-04T01:00:00.000Z");
  assert.equal(MUSIC_FACET_CACHE.has(db), false, "existing scan publication deletes the compatible connection cache");
  const published = artistFacet(db);
  assert.notStrictEqual(published, prior);
  assert.notStrictEqual(MUSIC_FACET_CACHE.get(db), scanCache);
  assert.ok(published.some(artist => artist.name === "! Published replacement"));
}

async function verifyLegacyLetterCounterproof() {
  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const source = fs.readFileSync(storeUrl, "utf8");
  const normalizedKey = 'JSON.stringify(["artist-browser", language, effectiveLetter, "name"])';
  assert.ok(source.includes(normalizedKey));
  // The legacy control changes only cache identity in memory, leaving SQL,
  // pagination, serialization and the currently bounded cache helper real.
  const legacySource = source.replace(normalizedKey, '`artist-browser:${language || "all"}:${letter || "all"}:name`')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (_match, start, relative, end) => `${start}${new URL(relative, storeUrl).href}${end}`);
  const legacyModule = await import(`data:text/javascript;base64,${Buffer.from(legacySource).toString("base64")}`);
  const legacy = legacyModule.createMusicStore({ dbPath, roots: [] });
  try {
    const before = sortedBuilds.length;
    for (let index = 0; index < 200; index += 1) legacy.listArtists(artistUrl({ letter: `ignored-${index}` }));
    assert.equal(sortedBuilds.length - before, 200, "the legacy raw-letter key reproduces redundant SQL/sort work");
    metrics.legacyLetterControl = { variants: 200, fullSortBuilds: sortedBuilds.length - before };
  } finally {
    await legacy.stop();
  }
}

function verifyWeakOwnership() {
  const helperUrl = new URL("../src/modules/music/server/facet-cache.js", import.meta.url).href;
  const constantsUrl = new URL("../src/modules/music/server/constants.js", import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import {cachedMusicFacet} from ${JSON.stringify(helperUrl)};
    import {MUSIC_FACET_CACHE} from ${JSON.stringify(constantsUrl)};
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    function probe(){const db={};const rows=[{name:'synthetic'}];cachedMusicFacet(db,'key',()=>rows);return {db:new WeakRef(db),cache:new WeakRef(MUSIC_FACET_CACHE.get(db)),rows:new WeakRef(rows)};}
    const refs=probe();
    for(let index=0;index<20;index+=1){await tick();global.gc();await tick();if(!refs.db.deref()&&!refs.cache.deref()&&!refs.rows.deref())break;}
    assert.equal(refs.db.deref(),undefined);assert.equal(refs.cache.deref(),undefined);assert.equal(refs.rows.deref(),undefined);
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "weak ownership control failed");
}

async function verifyAlbumCountJoins() {
  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const source = fs.readFileSync(storeUrl, "utf8").replaceAll("\r\n", "\n");
  const joinSlot = "        " + "$" + "{countArtistJoin}\n";
  assert.equal(source.split(joinSlot).length, 2, "the control targets only the album count join");
  // Restore only the former count JOIN; page SQL, filters, order, summaries,
  // serialization and all pre-existing caches stay in the actual factory.
  const previousSource = source.replace(joinSlot, "        LEFT JOIN music_artists a ON a.id = al.artist_id\n")
    .replace(/from "(\.\/[^"]+)"/gu, (_match, relative) => "from " + JSON.stringify(new URL(relative, storeUrl).href));
  const { createMusicStore: previousFactory } = await import("data:text/javascript;base64," + Buffer.from(previousSource).toString("base64"));
  const schemaSource = fs.readFileSync(new URL("../src/modules/music/server/schema.js", import.meta.url), "utf8");
  const oldTables = ["music_artists", "music_tracks", "music_track_state"].map(table => {
    const start = schemaSource.indexOf("CREATE TABLE IF NOT EXISTS " + table + " (");
    assert(start >= 0);
    const end = schemaSource.indexOf("    );", start);
    assert(end > start);
    // Exercise the real optional-column migrations before seeding records.
    return schemaSource.slice(start, end + 6)
      .replace(/^\s+(?:genre TEXT,|language TEXT NOT NULL DEFAULT '其他',|rating INTEGER DEFAULT 0,)\r?\n/gmu, "");
  }).join("\n");
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, now = Date.now;
  const connections = [], privateStores = [], initialized = new WeakSet();
  let clock = 1800000000000, legacyOpening = false, measuring = null;
  Date.now = () => clock;
  DatabaseSync.prototype.exec = function(sql) {
    if (legacyOpening && !initialized.has(this)) {
      initialized.add(this);
      exec.call(this, oldTables);
    }
    return exec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    if (!connections.includes(this)) {
      connections.push(this);
      const connection = this;
      this.function("fixture_album_artist_key", value => {
        if (measuring?.db === connection) measuring.lookups++;
        return value;
      });
    }
    const text = sql.replace(/\s+/gu, " ").trim();
    const count = text.startsWith("SELECT COUNT(*) AS count FROM music_albums al");
    if (measuring?.db === this && count) {
      measuring.countReads++;
      measuring.plan = prepare.call(this, "EXPLAIN QUERY PLAN " + sql);
      // Keep the PK search: count its lookup key evaluations instead of
      // replacing the table or inspecting only the SQL's appearance.
      sql = sql.replace("a.id = al.artist_id", "a.id = fixture_album_artist_key(al.artist_id)");
    }
    const statement = prepare.call(this, sql, ...args);
    if (!measuring || !count) return statement;
    const get = statement.get.bind(statement);
    statement.get = (...parameters) => {
      measuring.planRows = measuring.plan.all(...parameters);
      return get(...parameters);
    };
    return statement;
  };
  function open(factory, albums, legacySchema) {
    legacyOpening = legacySchema;
    const target = factory({ dbPath: ":memory:", roots: [], scanWorker: {
      start() { assert.fail("no worker start"); }, scan() { assert.fail("no scan"); }, async stop() {}
    } });
    privateStores.push(target);
    try { target.summary(); } finally { legacyOpening = false; }
    const db = connections.at(-1), artists = albums / 5;
    const insertArtist = db.prepare("INSERT INTO music_artists(id,name,language,source_root,source_path,relative_path,track_count,album_count,status,updated_at) VALUES(?,?,?,'synthetic','synthetic','synthetic',5,5,?,'2026')");
    const insertAlbum = db.prepare("INSERT INTO music_albums(id,artist_id,title,year,cover_path,source_root,source_path,relative_path,track_count,duration_ms,size_bytes,updated_at) VALUES(?,?,?,?,?,'synthetic','synthetic','synthetic',?,?,?,?)");
    const insertTrack = db.prepare("INSERT INTO music_tracks(id,artist_id,album_id,title,genre,language,source_root,source_path,relative_path,file_name,ext,duration_ms,status,updated_at) VALUES(?,?,?,? ,?,?,'synthetic',?,'synthetic','synthetic.audio','audio',1000,?,'2026')");
    const languages = ["中文", "英文", "日文", "韩文", "其他", "待识别"];
    db.exec("BEGIN");
    try {
      for (let index = 0; index < artists; index++) {
        insertArtist.run("a" + index, index === 1 ? "周杰伦" : index % 37 === 0 ? "待识别" : "Artist " + index,
          index === 1 ? "中文" : languages[index % 6], index % 29 === 0 ? "missing" : "ok");
      }
      db.prepare("UPDATE music_artists SET track_count=0 WHERE id='a0'").run();
      for (let index = 0; index < albums; index++) {
        const artistId = index % 19 === 0 ? "orphan-artist" : "a" + index % artists;
        const title = index === 1 ? "青花瓷" : index % 13 === 0 ? "中文探针" : index % 17 === 0 ? "123 Numeric"
          : index % 7 === 0 ? "Album tie" : "Album " + index;
        insertAlbum.run("al" + index, artistId, title, index % 4 === 0 ? null : "20" + index % 30,
          index % 11 === 0 ? "" : "synthetic-cover", index % 23 === 0 ? 0 : 1, 1000, index * 3, index % 2 ? "v1" : "v2");
        insertTrack.run("t" + index, artistId, "al" + index, "Track " + index, index % 3 ? "Rock" : " Pop ",
          languages[index % 6], "synthetic/track/" + index, index % 41 === 0 ? "missing" : "ok");
      }
      const phonetic = db.prepare("INSERT INTO music_search_phonetic(track_id,artist_id,album_id,title,artist,album,file_name) VALUES(?,?,?,?,?,?,?)");
      insertMusicPhoneticSearchRow(phonetic, {
        id: "t1", artistId: "a1", albumId: "al1", title: "探针曲", displayArtist: "周杰伦", albumTitle: "青花瓷", fileName: "synthetic.audio"
      });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    MUSIC_FACET_CACHE.delete(db);
    clock += 10000;
    target.summary();
    return { store: target, db, albums };
  }
  const url = values => new URL("http://fixture.invalid/api/music/albums?" + new URLSearchParams(values));
  function measure(target, values = {}) {
    measuring = { db: target.db, lookups: 0, countReads: 0 };
    try {
      const response = target.store.listAlbums(url(values));
      return { response, lookups: measuring.lookups, countReads: measuring.countReads, plan: measuring.planRows };
    } finally { measuring = null; }
  }
  let responseOracles = 0, mixedOracles = 0;
  const equal = (current, previous, values) => {
    assert.equal(JSON.stringify(current.store.listAlbums(url(values))), JSON.stringify(previous.store.listAlbums(url(values))),
      "complete album response retains the old fields/order: " + JSON.stringify(values));
    responseOracles++;
  };
  try {
    for (const [albums, legacySchema] of [[20000, false], [2000, true]]) {
      const current = open(legacyAlbumCount ? previousFactory : createMusicStore, albums, legacySchema);
      const previous = open(previousFactory, albums, legacySchema);
      clock += 10000; current.store.summary(); previous.store.summary();
      const filters = [{}, { artist: "a1" }, { artist: "orphan-artist" }, { genre: "Rock" }, { language: "中文" },
        { letter: "A" }, { letter: "1" }, { letter: "#" }, { q: "zhoujielun" }];
      for (const sort of ["updated", "title", "year", "tracks"])
        for (const offset of [0, 37, albums - 10, albums + 5])
          for (const filter of filters) equal(current, previous, { ...filter, sort, offset, limit: 37 });
      if (legacySchema) {
        for (const q of ["", "Album", "中文探针", "qinghuaci", "%_\\"])
          for (const language of ["", "中文", "ignored"])
            for (const letter of ["", "a", "9", "#", "待", "中", "ignored", "待 "]) {
              equal(current, previous, { q, language, letter, limit: 37, offset: [0, 37, albums - 10, albums + 5][mixedOracles % 4],
                sort: ["updated", "year", "title", "tracks"][mixedOracles % 4] });
              mixedOracles++;
            }
      }
      const plain = current.store.listAlbums(url({ limit: 80 }));
      assert.equal(plain.total, albums, "ordinary counts keep inactive/zero-track artists and orphan albums");
      assert(current.store.listAlbums(url({ artist: "orphan-artist", limit: 80 })).albums.every(album => album.artistName === ""),
        "page artist LEFT JOIN remains available for orphan names");
      const named = current.store.listAlbums(url({ artist: "a1", limit: 80 }));
      assert(named.albums.length > 0 && named.albums.every(album => album.artistName === "周杰伦"), "page still returns actual artist names");
      for (const values of [{ q: "zhoujielun" }, { q: "qinghuaci" }, { language: "中文" }, { letter: "待" }]) {
        const page = measure(current, values);
        assert(page.response.total > 0, "artist-dependent filters must match real records");
        assert(page.plan.some(row => /\b(?:SEARCH|SCAN) a\b/u.test(row.detail)), "artist-dependent counts retain the real artist table");
      }
      if (!legacySchema) {
        const before = measure(previous), after = measure(current);
        assert.equal(JSON.stringify(after.response), JSON.stringify(before.response));
        assert.equal(before.lookups, albums, "the old aggregate really probes the artist PK for every album");
        assert(before.plan.some(row => row.detail.includes("LEFT-JOIN")), "SQLite has not already removed the old aggregate join");
        assert.equal(after.countReads, 1, "count stays one SQL execution");
        assert.equal(after.lookups, 0, "album counts without artist conditions must perform zero artist lookups");
        metrics.albumCountWork = { albums, oldArtistLookups: before.lookups, artistLookups: after.lookups };
      }
    }
    metrics.albumCountWork = { ...metrics.albumCountWork, fullResponseOracles: responseOracles, mixedOracles, legacySchema: true };
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    DatabaseSync.prototype.exec = exec;
    Date.now = now;
    for (const target of privateStores) await target.stop();
  }
}

async function verifyArtistCacheProjection() {
  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const source = fs.readFileSync(storeUrl, "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("      const buildSortedRows = () => ");
  const end = source.indexOf("      const sortedRows = query", start);
  assert(start >= 0 && end > start, "locate the complete artist-name build branch");
  const currentBuild = source.slice(start, end);
  const quote = String.fromCharCode(96);
  // Restore the whole former branch, including its original SQL, key build
  // and stable ordering, rather than changing the cache or its budgets.
  const previousBuild = [
    "      const buildSortedRows = () => database",
    "          .prepare(" + quote + "SELECT * FROM music_artists WHERE " + "$" + "{conditions.join(\" AND \")}" + quote + ")",
    "          .all(...args)",
    "          .map(row => ({ row, key: artistNameForSort(row.name) }))",
    "          .sort((left, right) => artistNameCollator.compare(left.key, right.key))",
    "          .map(entry => entry.row);",
    ""
  ].join("\n");
  const previousSource = source.slice(0, start) + previousBuild + source.slice(end);
  assert.equal(previousSource.replace(previousBuild, currentBuild), source, "the oracle changes only the whole artist-name build");
  const moduleSource = previousSource.replace(/from "(\.\/[^"]+)"/gu,
    (_match, relative) => "from " + JSON.stringify(new URL(relative, storeUrl).href));
  const previousFactory = (await import("data:text/javascript;base64," + Buffer.from(moduleSource).toString("base64"))).createMusicStore;
  const sqlSlot = "const buildSortedRows = () => prepareArtistBrowserRows(database, conditions, query)";
  const wideSqlSlot = "const buildSortedRows = () => database.prepare(`SELECT * FROM music_artists WHERE ${conditions.join(\" AND \")}`)";
  assert.equal(source.split(sqlSlot).length, 2, "one artist-name query owns the SQL projection");
  const previousSqlSource = source.replace(sqlSlot, wideSqlSlot);
  assert.equal(previousSqlSource.replace(wideSqlSlot, sqlSlot), source,
    "the SQL-only control retains the current JS projection, sorting, filters and cache");
  const previousSqlFactory = (await import("data:text/javascript;base64," + Buffer.from(previousSqlSource.replace(/from "(\.\/[^"]+)"/gu,
    (_match, relative) => "from " + JSON.stringify(new URL(relative, storeUrl).href))).toString("base64"))).createMusicStore;
  const testedFactory = legacyWideArtistCache ? previousFactory : legacyWideArtistSql ? previousSqlFactory : createMusicStore;
  const schema = fs.readFileSync(new URL("../src/modules/music/server/schema.js", import.meta.url), "utf8");
  const artistTable = /CREATE TABLE IF NOT EXISTS music_artists \([\s\S]+?\n    \);/u.exec(schema)?.[0];
  assert(artistTable, "actual schema owns the legacy table definition");
  const legacyTable = artistTable.replace(/^\s+(?:album_count INTEGER DEFAULT 0,|language TEXT NOT NULL DEFAULT '其他',)\r?\n/gmu, "");
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, now = Date.now;
  const privateStores = [];
  let opening = null, measurement = null, failure = null, failureStage = "prepare", clock = 1800000000000;
  let fullResponseOracles = 0;
  Date.now = () => clock;
  DatabaseSync.prototype.exec = function(sql, ...args) {
    if (opening && !opening.db) {
      opening.db = this;
      if (opening.legacyTable) exec.call(this, opening.legacyTable);
      else if (opening.legacy) exec.call(this, legacyTable);
    }
    return exec.call(this, sql, ...args);
  };
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    const nameQuery = /^SELECT (?:\*|id,name,language,album_count,track_count,duration_ms,size_bytes) FROM music_artists WHERE track_count > 0/u.test(sql);
    if (nameQuery && measurement?.db === this) measurement.namePrepares++;
    if (nameQuery && failure && failureStage === "prepare") throw failure;
    const statement = prepare.call(this, sql, ...args);
    const measured = measurement?.db === this;
    if (!measured && !(nameQuery && failure)) return statement;
    const owner = this;
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key !== "get" && key !== "all") return value.bind(target);
        return (...parameters) => {
          if (nameQuery && key === "all" && failure && failureStage === "all") throw failure;
          const result = value.apply(target, parameters);
          if (!measured) return result;
          measurement.sqlReads++;
          if (nameQuery && key === "all") {
            measurement.builds++;
            measurement.rows += result.length;
            measurement.rawRows = result;
            measurement.nameQueries.push({ sql, parameters });
            measurement.plan = prepare.call(owner, "EXPLAIN QUERY PLAN " + sql).all(...parameters).map(row => row.detail);
          }
          return result;
        };
      }
    });
  };
  try {
    const previous = open(previousFactory, 20000), sqlPrevious = open(previousSqlFactory, 20000), current = open(testedFactory, 20000);
    clock += 10000;
    previous.store.summary(); sqlPrevious.store.summary(); current.store.summary();
    const key = JSON.stringify(["artist-browser", "", "", "name"]);
    const before = measured(previous, () => previous.store.listArtists(artistUrl({ limit: 80 })));
    const sqlBefore = measured(sqlPrevious, () => sqlPrevious.store.listArtists(artistUrl({ limit: 80 })));
    const after = measured(current, () => current.store.listArtists(artistUrl({ limit: 80 })));
    equal(after.response, before.response, "first complete response");
    equal(after.response, sqlBefore.response, "SQL-only old projection complete response");
    assert.deepEqual(after.nameQueries.map(({ sql, parameters }) => ({
      sql: sql.replace(/^SELECT (?:\*|id,name,language,album_count,track_count,duration_ms,size_bytes) FROM/u, "SELECT * FROM"), parameters
    })), sqlBefore.nameQueries, "only selected columns change; all FROM/filter SQL and bound values are identical");
    assert.deepEqual(after.plan, sqlBefore.plan, "the actual artist traversal plan and stable collation ties are unchanged");
    const rowWork = result => ({
      rows: result.rows,
      rawFields: result.rawRows.reduce((total, row) => total + Object.keys(row).length, 0),
      rawBytes: Buffer.byteLength(JSON.stringify(result.rawRows), "utf8"),
      unusedBytes: result.rawRows.reduce((total, row) => total + ["sort_name", "source_root", "source_path", "relative_path", "status", "updated_at"]
        .reduce((bytes, column) => bytes + Buffer.byteLength(String(row[column] || ""), "utf8"), 0), 0)
    });
    const beforeSqlWork = rowWork(sqlBefore), afterSqlWork = rowWork(after);
    const formerBytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify(before.rawRows), "utf8");
    assert(formerBytes > MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES, "real wide artist rows exceed the unchanged per-entry budget");
    assert.equal(MUSIC_FACET_CACHE.get(previous.db).has(key), false, "the previous wide build really bypasses retention");
    const retained = MUSIC_FACET_CACHE.get(current.db)?.get(key);
    const retainedBytes = retained
      ? Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify(retained), "utf8")
      : formerBytes;
    const pages = target => Array.from({ length: 12 }, (_, index) =>
      target.store.listArtists(artistUrl({ limit: 80, offset: (index + 1) * 80 })));
    const oldPages = measured(previous, () => pages(previous));
    const currentPages = measured(current, () => pages(current));
    const sqlOldPages = measured(sqlPrevious, () => pages(sqlPrevious));
    for (let index = 0; index < 12; index++) equal(currentPages.response[index], oldPages.response[index], "page " + index);
    for (let index = 0; index < 12; index++) equal(currentPages.response[index], sqlOldPages.response[index], "SQL-only old projection page " + index);
    assert.equal(oldPages.builds, 12, "the old branch rebuilds each page after bypassing the cache");
    assert.equal(oldPages.rows, before.response.total * 12, "the old branch sorts actual full-catalog rows again");
    for (const options of [
      { language: "中文" }, { language: "all" }, { letter: "A" }, { letter: "a" }, { letter: "0" },
      { letter: "#" }, { letter: "待" }, { letter: "unknown" }, { q: "歌" }, { q: "É" }, { q: "Artist" }, { q: "010" },
      { offset: before.response.total - 10 }, { offset: before.response.total + 10 }
    ]) {
      const result = current.store.listArtists(artistUrl({ limit: 80, ...options }));
      equal(result, previous.store.listArtists(artistUrl({ limit: 80, ...options })), JSON.stringify(options));
      equal(result, sqlPrevious.store.listArtists(artistUrl({ limit: 80, ...options })), "SQL-only " + JSON.stringify(options));
    }
    const queryWork = measured(current, () => {
      current.store.listArtists(artistUrl({ q: "歌", limit: 80 }));
      current.store.listArtists(artistUrl({ q: "歌", limit: 80 }));
    });
    assert.equal(queryWork.builds, 2, "search-dependent requests keep their existing uncached path");
    assert(queryWork.rawRows.every(row => Object.keys(row).length === 7), "query-dependent name sorting reads only public artist columns");
    for (const options of [{ sort: "count" }, { sort: "count", q: "歌" }, { sort: "count", language: "中文", offset: 17 }])
      equal(current.store.listArtists(artistUrl(options)), sqlPrevious.store.listArtists(artistUrl(options)),
        "count-sort behavior " + JSON.stringify(options));
    const returned = current.store.listArtists(artistUrl({ limit: 80 }));
    returned.artists[0].name = "private caller mutation";
    returned.artists[0].trackCount = -99;
    equal(current.store.listArtists(artistUrl({ limit: 80 })), previous.store.listArtists(artistUrl({ limit: 80 })),
      "page DTO mutation cannot change the retained raw source");
    let errorOracles = 0;
    for (const stage of ["prepare", "all"]) for (const sentinel of [
      new Error("private artist-name read failure"),
      Object.assign(new Error("no such column: album_count"), { code: "SQLITE_BUSY", errcode: 1 }),
      Object.assign(new Error("no such column: album_count"), { code: "ERR_SQLITE_ERROR", errcode: 2 }),
      Object.assign(new Error("no such column: required_fixture_column"), { code: "ERR_SQLITE_ERROR", errcode: 1 }),
      ...(stage === "all" ? [Object.assign(new Error("no such column: album_count"), { code: "ERR_SQLITE_ERROR", errcode: 1 })] : [])
    ]) {
      for (const item of [current, sqlPrevious]) {
        MUSIC_FACET_CACHE.delete(item.db);
        failure = sentinel; failureStage = stage;
        assert.throws(() => item.store.listArtists(artistUrl()), error => error === sentinel,
          "the exact " + stage + " error still propagates");
        errorOracles++;
        failure = null;
      }
    }
    failureStage = "prepare";
    equal(current.store.listArtists(artistUrl()), previous.store.listArtists(artistUrl()), "fresh retry after read failure");
    for (const item of [current, previous]) {
      item.db.exec("UPDATE music_artists SET name='! Changed source' WHERE id='a1'");
      MUSIC_FACET_CACHE.delete(item.db);
    }
    equal(current.store.listArtists(artistUrl()), previous.store.listArtists(artistUrl()), "owner invalidation sees changed metadata");
    const legacyPrevious = open(previousFactory, 1000, true), legacyCurrent = open(testedFactory, 1000, true);
    clock += 10000;
    legacyPrevious.store.summary(); legacyCurrent.store.summary();
    for (const options of [{}, { language: "中文" }, { letter: "#" }, { q: "歌" }, { q: "Null" }, { offset: 987 }])
      equal(legacyCurrent.store.listArtists(artistUrl({ limit: 80, ...options })),
        legacyPrevious.store.listArtists(artistUrl({ limit: 80, ...options })), "legacy missing album_count/language: " + JSON.stringify(options));
    const nullableArtists = legacyCurrent.store.listArtists(artistUrl({ q: "Null" })).artists;
    assert.equal(nullableArtists.length, 2, "both legitimate nullable primary-key rows remain visible");
    assert(nullableArtists.every(artist => artist.id === "" && artist.albumCount === 0),
      "nullable TEXT keys and the missing optional count retain public fallbacks");
    const legacyOwner = MUSIC_FACET_CACHE.get(legacyCurrent.db);
    assert.notStrictEqual(legacyOwner, MUSIC_FACET_CACHE.get(current.db), "a different actual connection owns a different prepared source");
    MUSIC_FACET_CACHE.delete(legacyPrevious.db); MUSIC_FACET_CACHE.delete(legacyCurrent.db);
    const legacyBefore = measured(legacyPrevious, () => legacyPrevious.store.listArtists(artistUrl()));
    const legacyAfter = measured(legacyCurrent, () => legacyCurrent.store.listArtists(artistUrl()));
    equal(legacyAfter.response, legacyBefore.response, "native prepare fallback complete legacy response");
    assert.equal(legacyAfter.namePrepares, legacyBefore.namePrepares + (!legacyWideArtistCache && !legacyWideArtistSql ? 1 : 0),
      "one failed native optional-column prepare precedes the original wide query");
    assert.equal(legacyAfter.builds, 1, "legacy fallback executes the original query exactly once");
    assert.deepEqual(legacyAfter.rawRows, legacyBefore.rawRows, "native legacy fallback retains the actual wide source");
    // The original summary itself rejects missing duration/size aggregates.
    // Preparation must still fall back before preserving that original error.
    let legacySchemaOracles = 1;
    for (const missing of [["duration_ms"], ["size_bytes"], ["album_count", "duration_ms", "size_bytes"]]) {
      const oldSchema = openSchema(previousSqlFactory, missing), newSchema = openSchema(testedFactory, missing);
      const observe = item => measured(item, () => {
        try { return { value: item.store.listArtists(artistUrl()) }; }
        catch (error) { return { error: { name: error.name, message: error.message, code: error.code, errcode: error.errcode } }; }
      });
      const oldRead = observe(oldSchema), newRead = observe(newSchema);
      equal(newRead.response, oldRead.response, "original summary error after native legacy fallback: " + missing.join("/"));
      assert(newRead.response.error, "missing required aggregate still fails normally");
      assert.equal(newRead.namePrepares, oldRead.namePrepares + (!legacyWideArtistCache && !legacyWideArtistSql ? 1 : 0));
      assert.equal(newRead.builds, 1); assert.deepEqual(newRead.rawRows, oldRead.rawRows);
      legacySchemaOracles++;
    }
    // All old response/error/schema oracles precede the old-branch negative
    // control. It must fail for repeated work, never for a changed response.
    assert.equal(currentPages.sqlReads, 0, "artist name cache pagination SQL budget: twelve pages must read no SQLite rows");
    assert.equal(currentPages.builds, 0, "artist name cache pagination sort budget: twelve pages must reuse the prepared source");
    assert.equal(currentPages.rows, 0);
    assert(retained && retainedBytes <= MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES, "the compact source fits the original per-entry budget");
    assertBound(current.db); assertBound(legacyCurrent.db);
    const artistBrowserSqlProjection = {
      fullResponseOracles, errorOracles, before: beforeSqlWork, after: afterSqlWork,
      previousWarmBuilds: sqlOldPages.builds, warmBuilds: currentPages.builds, legacySchemaOracles, legacyPrepareFallback: true, plan: after.plan
    };
    console.log(JSON.stringify({ artistBrowserSqlProjection }));
    assert.equal(beforeSqlWork.rawFields, beforeSqlWork.rows * 13, "the SQL-only old query really materializes all thirteen schema fields");
    assert(beforeSqlWork.unusedBytes > 0, "the old query really materializes unused source paths/status/sort text");
    assert.equal(afterSqlWork.rawFields, afterSqlWork.rows * 7,
      "artist browser SQL projection field budget: each sorted row reads only its seven public source fields");
    assert.equal(afterSqlWork.unusedBytes, 0, "artist browser SQL projection excludes unused source paths/status/sort text");
    assert(afterSqlWork.rawBytes < beforeSqlWork.rawBytes, "real native rows have fewer serialized intermediate bytes");
    assert.equal(sqlOldPages.builds, 0, "the SQL-only old projection retains the current warm cache");
    assert.equal(currentPages.builds, 0);
    metrics.artistCacheProjection = {
      artists: 20000, matchedArtists: before.response.total, fullResponseOracles,
      formerBytes, retainedBytes, previousPageReads: oldPages.sqlReads, pageReads: currentPages.sqlReads,
      previousSortRows: oldPages.rows, sortRows: currentPages.rows, unchangedQueryBypass: true, legacyMissingColumn: true,
      artistBrowserSqlProjection
    };
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    DatabaseSync.prototype.exec = exec;
    Date.now = now;
    for (const item of privateStores) {
      await item.store.stop();
      assert.equal(item.db?.isOpen, false, "the actual store closes the cached source's database owner");
    }
  }

  function open(factory, artists, legacy = false) {
    const item = { legacy, db: null, store: factory({ dbPath: ":memory:", roots: [], scanWorker: {
      start() { assert.fail("no worker start"); }, scan() { assert.fail("no private scan"); }, async stop() {}
    } }) };
    privateStores.push(item);
    opening = item;
    try { item.store.summary(); } finally { opening = null; }
    assert(item.db, "the actual store owns its private in-memory connection");
    const columns = legacy ? "" : ",album_count";
    const albumValue = legacy ? "" : ",?";
    const insert = item.db.prepare("INSERT INTO music_artists(id,name,language,source_root,source_path,relative_path,track_count,duration_ms,size_bytes,status,updated_at" + columns + ") VALUES (?,?,?,?,?,?,?,?,?,?,'2026-01-01'" + albumValue + ")");
    const track = item.db.prepare("INSERT INTO music_tracks(id,artist_id,album_id,title,genre,language,source_root,source_path,relative_path,file_name,ext,duration_ms,status,updated_at) VALUES (?,?,?,?,'流行',?,?,?,?,?,'.audio',1234,'ok','2026-01-01')");
    const prefixes = ["歌手", "（歌手", "_歌手", "É歌手", "E歌手", "Artist", "10歌手", "２歌手", "待识别", "中文歌手"];
    const wide = "synthetic/" + "a".repeat(110) + "/";
    item.db.exec("BEGIN");
    try {
      for (let index = 0; index < artists; index++) {
        const id = "a" + index, name = prefixes[index % prefixes.length] + String(Math.floor(index / 10)).padStart(4, "0");
        const language = ["中文", "英文", "日文", "其他"][index % 4];
        const parameters = [id, name, language, wide, wide + id, wide + id, index % 97 ? 1 : 0,
          index % 13 ? 1234 : null, index % 17 ? 1 : null, index % 31 ? "ok" : "missing"];
        if (!legacy) parameters.push(index % 11 ? 1 : null);
        insert.run(...parameters);
        track.run("t" + index, id, "none", name, language, "synthetic", "track/" + index, "t" + index, "t" + index + ".audio");
      }
      item.db.exec("INSERT INTO music_artists(id,name,language,source_root,source_path,relative_path,track_count,duration_ms,size_bytes,status,updated_at) VALUES (NULL,'ÉNull tie','中文','synthetic','synthetic/null1','null1',1,NULL,NULL,'missing','2026-01-01'),(NULL,'ENull tie','中文','synthetic','synthetic/null2','null2',1,NULL,NULL,'ok','2026-01-01')");
      item.db.exec("COMMIT");
    } catch (error) { item.db.exec("ROLLBACK"); throw error; }
    MUSIC_FACET_CACHE.delete(item.db);
    clock += 10000;
    item.store.summary();
    return item;
  }

  function openSchema(factory, missing) {
    let table = artistTable;
    for (const column of missing) table = table.replace(new RegExp("^\\s+" + column + " [^\\n]+,\\r?\\n", "mu"), "");
    const item = { legacyTable: table, db: null, store: factory({ dbPath: ":memory:", roots: [], scanWorker: {
      start() { assert.fail("no worker start"); }, scan() { assert.fail("no private scan"); }, async stop() {}
    } }) };
    privateStores.push(item); opening = item;
    try { item.store.listPlaylists(); } finally { opening = null; }
    assert(item.db);
    item.db.exec("INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) "
      + "VALUES('a','Legacy','synthetic','synthetic/a','a',1,'ok','2026')");
    return item;
  }

  function measured(item, operation) {
    measurement = { db: item.db, sqlReads: 0, namePrepares: 0, builds: 0, rows: 0, rawRows: null, nameQueries: [], plan: null };
    try { return { response: operation(), ...measurement, db: undefined }; }
    finally { measurement = null; }
  }

  function equal(current, previous, label) {
    assert.equal(JSON.stringify(current), JSON.stringify(previous), "complete artist response: " + label);
    fullResponseOracles++;
  }
}

async function verifyAlbumFacetProjection() {
  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const facetUrl = new URL("../src/modules/music/server/facets.js", import.meta.url);
  const source = fs.readFileSync(facetUrl, "utf8").replaceAll("\r\n", "\n");
  const helperStart = source.indexOf("export const ALBUM_FACET_COLUMNS = ");
  const start = source.indexOf("export function albumFacet(");
  const end = source.indexOf("export function genreFacet(", start);
  assert(helperStart >= 0 && start > helperStart && end > start, "locate the complete projection helper and album facet");
  const currentFunction = source.slice(start, end).trimEnd();
  const helper = source.slice(helperStart, start);
  const projectedColumns = JSON.parse(/^export const ALBUM_FACET_COLUMNS = ("[^"]+");$/mu.exec(helper)?.[1] || "null");
  assert.equal(projectedColumns.split(",").length, 9);
  // Literal complete pre-projection implementation. No Git checkout, schema
  // hooks, altered serializer or cache is part of the old response oracle.
  const previousFunction = [
    "export function albumFacet(db, artistId = \"\", genre = \"\", language = \"\", selectedAlbumId = \"\") {",
    "  const args = [];",
    "  const where = [];",
    "  if (artistId && artistId !== \"all\") {",
    "    where.push(\"al.artist_id = ?\");",
    "    args.push(artistId);",
    "  }",
    "  if (genre && genre !== \"all\") {",
    "    where.push(\"al.id IN (SELECT album_id FROM music_tracks WHERE status = 'ok' AND genre = ? COLLATE NOCASE)\");",
    "    args.push(genre);",
    "  }",
    "  const normalizedLanguage = normalizeMusicLanguage(language);",
    "  if (normalizedLanguage) {",
    "    where.push(\"al.id IN (SELECT album_id FROM music_tracks WHERE status = 'ok' AND language = ?)\");",
    "    args.push(normalizedLanguage);",
    "  }",
    "  const cacheKey = JSON.stringify([\"albums\", artistId && artistId !== \"all\" ? artistId : \"\", genre && genre !== \"all\" ? genre : \"\", normalizedLanguage]);",
    "  const rows = cachedMusicFacet(db, cacheKey, () => db",
    "    .prepare(",
    "      `",
    "      SELECT al.*, a.name AS artist_name",
    "      FROM music_albums al",
    "      LEFT JOIN music_artists a ON a.id = al.artist_id",
    "      ${where.length ? `WHERE ${where.join(\" AND \")}` : \"\"}",
    "      ORDER BY al.track_count DESC, al.title COLLATE NOCASE",
    "      LIMIT 60",
    "    `",
    "    )",
    "    .all(...args)",
    "    .map(publicAlbum));",
    "  if (!selectedAlbumId || selectedAlbumId === \"all\" || rows.some((album) => album.id === selectedAlbumId)) return rows;",
    "  const selected = db",
    "    .prepare(\"SELECT al.*,a.name AS artist_name FROM music_albums al LEFT JOIN music_artists a ON a.id=al.artist_id WHERE al.id=? AND al.track_count>0\")",
    "    .get(selectedAlbumId);",
    "  return selected ? [publicAlbum(selected), ...rows.slice(0, 59)] : rows;",
    "}"
  ].join("\n");
  assert.equal((previousFunction.match(/al\.\*/gu) || []).length, 2, "both former wide reads are restored");
  // The helper now also serves listAlbums. Keep that shared implementation
  // while restoring both old facet SQL reads and their direct db.prepare.
  assert.equal(previousFunction.includes("prepareAlbumFacet"), false, "the old facet never uses the shared projection helper");
  const previousSource = source.slice(0, start) + previousFunction + source.slice(start + currentFunction.length);
  assert.equal(previousSource.replace(previousFunction, currentFunction), source,
    "the control restores only the complete former albumFacet; all other callers remain current");
  const absolute = (text, url, facets) => text.replace(/from "(\.\/[^"]+)"/gu,
    (_match, relative) => "from " + JSON.stringify(relative === "./facets.js" && facets ? facets : new URL(relative, url).href));
  const previousFacetUrl = "data:text/javascript;base64," + Buffer.from(absolute(previousSource, facetUrl)).toString("base64");
  const previousFacet = (await import(previousFacetUrl)).albumFacet;
  const storeSource = fs.readFileSync(storeUrl, "utf8");
  const previousFactory = (await import("data:text/javascript;base64,"
    + Buffer.from(absolute(storeSource, storeUrl, previousFacetUrl)).toString("base64"))).createMusicStore;
  const testedFactory = legacyWideAlbumFacet ? previousFactory : createMusicStore;
  const testedFacet = legacyWideAlbumFacet ? previousFacet : albumFacet;
  const { publicAlbum } = await import("../src/modules/music/server/serializers.js");
  const { routeMusicApi } = await import("../src/modules/music/server/routes.js");
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, now = Date.now;
  const owners = [];
  let opening = null, measurement = null, failure = null, failureStage = "execute", beforeRead = null;
  let clock = 1800000000000, fullResponseOracles = 0, facetOracles = 0, heldErrorOracles = 0;
  const optional = ["year", "cover_path", "duration_ms", "size_bytes", "updated_at"];
  const facetQuery = sql => /FROM music_albums al[\s\S]*ORDER BY al.track_count DESC/u.test(sql)
    || /FROM music_albums al[\s\S]*WHERE al.id=\? AND al.track_count>0/u.test(sql);
  Date.now = () => clock;
  DatabaseSync.prototype.exec = function(sql, ...parameters) {
    if (opening && !opening.db) {
      opening.db = this;
      if (opening.missing) {
        const columns = ["id TEXT PRIMARY KEY", "artist_id TEXT", "title TEXT", "track_count INTEGER", "intro_text TEXT",
          ...optional.filter(column => !opening.missing.includes(column)).map(column => column
            + (["duration_ms", "size_bytes"].includes(column) ? " INTEGER" : " TEXT"))];
        exec.call(this, "CREATE TABLE music_albums(" + columns.join(",") + ")");
      }
    }
    return exec.call(this, sql, ...parameters);
  };
  DatabaseSync.prototype.prepare = function(sql, ...parameters) {
    const album = facetQuery(sql);
    if (measurement?.db === this && album) measurement.prepareAttempts++;
    if (failure && failureStage === "prepare" && album) throw failure;
    const statement = prepare.call(this, sql, ...parameters), db = this;
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key !== "get" && key !== "all") return value.bind(target);
        return (...values) => {
          if (failure && (failureStage === "execute" || failureStage === key) && album) throw failure;
          if (beforeRead && album) { const action = beforeRead; beforeRead = null; action(); }
          const result = value.apply(target, values);
          if (measurement?.db === db) {
            measurement.sqlReads++;
            if (album) {
              measurement.facetReads++;
              const rows = Array.isArray(result) ? result : result ? [result] : [];
              measurement.rows += rows.length;
              measurement.rawFields += rows.reduce((total, row) => total + Object.keys(row).length, 0);
              for (const row of rows) measurement.introBytes += typeof row.intro_text === "string"
                ? Buffer.byteLength(row.intro_text, "utf8") : row.intro_text?.byteLength || 0;
              measurement.queries.push({ sql, values });
            }
          }
          return result;
        };
      }
    });
  };
  try {
    const previous = open(previousFactory), current = open(testedFactory);
    let payloadWork;
    for (const bytes of [0, 8192, MAX_INTRO_BYTES]) {
      seed(previous, bytes); seed(current, bytes);
      compare(previous, current, "cold complete playlist " + bytes);
      clear(previous, current);
      const before = measured(previous, () => previous.store.playlistDetail("p"));
      const after = measured(current, () => current.store.playlistDetail("p"));
      equal(after.response, before.response, "cache miss complete playlist " + bytes);
      const warmBefore = measured(previous, () => previous.store.playlistDetail("p"));
      const warmAfter = measured(current, () => current.store.playlistDetail("p"));
      equal(warmAfter.response, warmBefore.response, "warm complete playlist " + bytes);
      assert.equal(warmBefore.facetReads, 0); assert.equal(warmAfter.facetReads, 0);
      const selectedBefore = measured(previous, () => previous.store.listTracks(trackUrl({ album: "al099", limit: 24 })));
      const selectedAfter = measured(current, () => current.store.listTracks(trackUrl({ album: "al099", limit: 24 })));
      equal(selectedAfter.response, selectedBefore.response, "complete selected album fallback " + bytes);
      assert.equal(selectedBefore.facetReads, 1, "a selected album outside the cached sixty performs its original single read");
      assert.equal(selectedAfter.facetReads, 1);
      if (bytes === MAX_INTRO_BYTES) {
        const plan = (owner, work) => prepare.call(owner.db, "EXPLAIN QUERY PLAN " + work.queries[0].sql)
          .all(...work.queries[0].values).map(row => row.detail);
        assert.deepEqual(plan(current, after), plan(previous, before), "the actual native album/artist plan and ordering are unchanged");
        for (const [former, next] of [[before, after], [selectedBefore, selectedAfter]]) {
          assert.equal(next.queries[0].sql.replace(projectedColumns, "al.*"), former.queries[0].sql,
            "only the two SELECT projections change; JOIN/WHERE/ORDER/LIMIT stay byte-identical");
          assert.deepEqual(next.queries[0].values, former.queries[0].values, "original bound parameters are preserved");
        }
        assert.equal(after.sqlReads, before.sqlReads, "no extra query is introduced on the modern schema");
        assert.equal(before.rows, 60); assert.equal(after.rows, 60);
        payloadWork = { albums: 100, facetRows: 60, introBytesPerAlbum: MAX_INTRO_BYTES,
          formerIntroBytes: before.introBytes, introBytes: after.introBytes,
          formerRawFields: before.rawFields, rawFields: after.rawFields,
          formerSelectedIntroBytes: selectedBefore.introBytes, selectedIntroBytes: selectedAfter.introBytes,
          sqlReads: after.sqlReads, plan: plan(current, after) };
        for (const owner of [previous, current]) {
          const raw = prepare.call(owner.db, "SELECT * FROM music_albums WHERE id='al000'").get();
          const detail = publicAlbum(raw, { detail: true });
          assert.equal(Buffer.byteLength(detail.intro, "utf8"), MAX_INTRO_BYTES,
            "the real detail serializer still returns the entire legitimate intro");
          assert.equal(detail.introPath, "synthetic://intro");
        }
      }
    }
    seed(previous, 64); seed(current, 64);
    const both = operation => { operation(previous.db); operation(current.db); };
    const values = [null, "", 0, 1, "0", "2026", "x&?=😀", new Uint8Array([]), new Uint8Array([1, 47, 255])];
    for (const field of optional) {
      for (const [index, value] of values.entries()) {
        if (field === "updated_at" && value === null) continue; // The current owner enforces its real NOT NULL column.
        both(db => db.prepare("UPDATE music_albums SET " + field + "=? WHERE id='al000'").run(value));
        compare(previous, current, "NULL/TEXT/BLOB public field " + field + "/" + index);
      }
    }
    both(db => db.exec("UPDATE music_albums SET title='Same title',track_count=24,year='2026',cover_path='',duration_ms=1,size_bytes=1,updated_at='2026';"
      + "INSERT INTO music_albums(id,artist_id,title,track_count,updated_at,source_root,source_path,relative_path) "
      + "VALUES(NULL,'orphan','Same title',24,'2026','','',''),(NULL,'orphan','Same title',24,'2026','','','')"));
    compare(previous, current, "native tied sort with orphan artists and nullable TEXT primary keys");
    for (const artist of ["", "all", "a", "orphan"])
      for (const selected of ["", "all", "al099", "missing"])
        compareFacet(previous, current, [artist, "", "", selected]);
    for (const genre of ["all", "Pop", "不存在"])
      for (const language of ["", "其他", "英文"])
        compareFacet(previous, current, ["", genre, language, "al099"]);
    clear(previous, current);
    const formerRows = previousFacet(previous.db), currentRows = testedFacet(current.db);
    assert.strictEqual(previousFacet(previous.db), formerRows);
    assert.strictEqual(testedFacet(current.db), currentRows);
    both(db => db.exec("UPDATE music_albums SET year='2042',intro_text='new unpublished text'"));
    assert.strictEqual(previousFacet(previous.db), formerRows);
    assert.strictEqual(testedFacet(current.db), currentRows);
    assert.notEqual(currentRows[0].year, "2042", "unpublished source writes retain the same owner's original cache semantics");
    const record = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key.replace(/_([a-z])/gu, (_match, character) => character.toUpperCase()), value]));
    both(db => {
      writeScanRecords(db, {
        artists: prepare.call(db, "SELECT * FROM music_artists").all().map(record),
        albums: prepare.call(db, "SELECT * FROM music_albums WHERE id IS NOT NULL").all().map(record),
        tracks: prepare.call(db, "SELECT * FROM music_tracks").all().map(record), lyrics: []
      }, [], "2026-10-05");
      assert.equal(MUSIC_FACET_CACHE.has(db), false, "the actual scan publisher invalidates this connection's facets");
    });
    const published = compare(previous, current, "full DTO after actual writeScanRecords publication");
    assert.equal(published[1].response.albums[0].year, "2042");
    assert.notStrictEqual(published[1].response.albums, currentRows);
    const sqlFailure = new Error("no such column: al.year");
    sqlFailure.code = "ERR_SQLITE_ERROR"; sqlFailure.errcode = 1;
    for (const [stage, operation] of [["all", owner => owner.store.playlistDetail("p")],
      ["get", owner => (owner === previous ? previousFacet : testedFacet)(owner.db, "", "", "", "al099")]]) {
      failureStage = stage;
      clear(previous, current); failure = sqlFailure;
      for (const owner of [previous, current]) {
        assert.throws(() => operation(owner), error => error === sqlFailure, "native-shaped execution errors must not trigger fallback");
        heldErrorOracles++;
      }
      failure = null;
    }
    failureStage = "prepare";
    for (const [code, message, errcode] of [
      ["SYNTHETIC", "prepare fault", 1], ["ERR_SQLITE_ERROR", "no such column: a.name", 1],
      ["ERR_SQLITE_ERROR", "no such column: al.year", 2], ["ERR_SQLITE_ERROR", "no such column: al.title", 1],
      ["SQLITE_BUSY", "database is locked", 5]
    ]) {
      const sentinel = new Error(message); sentinel.code = code; sentinel.errcode = errcode;
      clear(previous, current); failure = sentinel;
      for (const owner of [previous, current]) {
        assert.throws(() => owner.store.playlistDetail("p"), error => error === sentinel, "other prepare errors preserve the original Error object");
        heldErrorOracles++;
      }
      failure = null;
    }
    failureStage = "execute";
    clear(previous, current);
    equal(await route(current), await route(previous), "actual playlist route 200");
    for (const code of ["SQLITE_BUSY", "SYNTHETIC"]) {
      const sentinel = new Error(code); sentinel.code = code;
      clear(previous, current); failure = sentinel;
      const before = await route(previous), after = await route(current);
      equal(after, before, "actual public error route " + code);
      assert.equal(after.status, code === "SQLITE_BUSY" ? 503 : 500);
      failure = null;
    }
    compare(previous, current, "retry after original SQL errors");
    clear(previous, current);
    beforeRead = () => previous.db.exec("UPDATE music_albums SET title='interleaved' WHERE id='al000'");
    const interleavedBefore = measured(previous, () => previous.store.playlistDetail("p"));
    beforeRead = () => current.db.exec("UPDATE music_albums SET title='interleaved' WHERE id='al000'");
    const interleavedAfter = measured(current, () => current.store.playlistDetail("p"));
    equal(interleavedAfter.response, interleavedBefore.response, "real metadata update between native prepare and step");
    const legacySchemas = [];
    for (const missing of [[], ...optional.map(column => [column]), optional]) {
      const oldOwner = open(previousFactory, missing), newOwner = open(testedFactory, missing);
      for (const owner of [oldOwner, newOwner]) {
        owner.db.exec("INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) VALUES('a','Artist','','a','a',1,'ok','2026');"
          + "INSERT INTO music_albums(id,artist_id,title,track_count,intro_text) VALUES('al','a','Album',1,'legacy intro');"
          + "INSERT INTO music_tracks(id,artist_id,album_id,title,source_root,source_path,relative_path,file_name,ext,status,updated_at) "
          + "VALUES('t','a','al','Track','','synthetic://t','t','t','.mp3','ok','2026');"
          + "INSERT INTO music_playlists VALUES('p','P','','2026','2026');INSERT INTO music_playlist_items VALUES('p','t',1,'2026')");
      }
      compareFacet(oldOwner, newOwner);
      const before = measured(oldOwner, () => previousFacet(oldOwner.db, "", "", "", "missing"));
      const after = measured(newOwner, () => testedFacet(newOwner.db, "", "", "", "missing"));
      assert.deepEqual(after.response, before.response, "optional-column selected lookup fallback preserves public defaults");
      assert.equal(after.facetReads, before.facetReads);
      assert.equal(after.prepareAttempts, legacyWideAlbumFacet || !missing.length ? before.prepareAttempts : before.prepareAttempts + 1,
        "a missing optional field adds only one failed prepare before the exact original selected query");
      if (!missing.includes("cover_path")) {
        compare(oldOwner, newOwner, "actual legacy-schema playlist DTO " + missing.join("/"));
        equal(await route(newOwner), await route(oldOwner), "actual legacy-schema route 200");
      } else {
        const errors = [];
        for (const owner of [oldOwner, newOwner]) assert.throws(() => owner.store.playlistDetail("p"), error => {
          errors.push({ message: error.message, code: error.code, errcode: error.errcode });
          return /no such column: al.cover_path/u.test(error.message);
        });
        assert.deepEqual(errors[1], errors[0], "the pre-existing playlist SQL still requires cover_path");
        const beforeRoute = await route(oldOwner), afterRoute = await route(newOwner);
        equal(afterRoute, beforeRoute, "same pre-existing legacy missing-cover route 500");
        assert.equal(afterRoute.status, 500);
      }
      const raw = prepare.call(newOwner.db, "SELECT * FROM music_albums").get();
      assert.equal(publicAlbum(raw, { detail: true }).intro, "legacy intro");
      legacySchemas.push(missing);
    }
    clear(previous, current);
    beforeRead = () => previous.db.exec("DROP TABLE music_albums");
    let oldError; try { previous.store.playlistDetail("p"); } catch (error) { oldError = error; }
    beforeRead = () => current.db.exec("DROP TABLE music_albums");
    let currentError; try { current.store.playlistDetail("p"); } catch (error) { currentError = error; }
    assert(oldError && currentError);
    assert.equal(currentError.message, oldError.message); assert.equal(currentError.code, oldError.code);
    const freshPrevious = open(previousFactory), freshCurrent = open(testedFactory);
    equal(freshCurrent.store.listPlaylists(), freshPrevious.store.listPlaylists(), "replacement owners cannot inherit another connection's source");
    assert.notStrictEqual(freshCurrent.db, current.db);
    freshPrevious.store.invalidate(); freshCurrent.store.invalidate();
    assert.equal(freshPrevious.db.isOpen, false); assert.equal(freshCurrent.db.isOpen, false);
    for (const owner of owners) {
      assert.equal(owner.store.scanDiagnostics().workerStarts, 0, "the actual owner has never started a worker or scanned media");
      await owner.store.stop();
      assert.equal(owner.store.scanDiagnostics().closed, true);
      assert.equal(owner.db.isOpen, false, "the actual owner closes its private connection");
    }
    // Response, native error, legacy schema, route and lifecycle oracles all
    // precede this real payload budget, including under the legacy control.
    console.log(JSON.stringify({ albumFacetProjectionOracles: { fullResponseOracles, facetOracles, heldErrorOracles,
      legacySchemas: legacySchemas.length, owners: owners.length }, albumFacetPayloadWork: payloadWork }));
    assert.equal(payloadWork.formerIntroBytes, 60 * MAX_INTRO_BYTES, "the old facet actually materializes sixty maximum-sized intros");
    assert.equal(payloadWork.formerSelectedIntroBytes, MAX_INTRO_BYTES);
    assert.equal(payloadWork.introBytes, 0, "album facet intro payload budget: sixty modern cards must read zero intro bytes");
    assert.equal(payloadWork.selectedIntroBytes, 0, "selected album facet intro payload budget");
    assert.equal(payloadWork.rawFields, 600, "the modern facet projects exactly ten public source fields per card");
    return { fullResponseOracles, facetOracles, heldErrorOracles, legacySchemas: legacySchemas.length,
      actualOwnership: true, unchangedDetail: true, ...payloadWork };
  } finally {
    failure = null; measurement = null; beforeRead = null; opening = null;
    DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; Date.now = now;
    for (const owner of owners) await owner.store.stop();
  }

  function open(factory, missing) {
    const owner = { db: null, missing, store: factory({ dbPath: ":memory:", roots: [] }) };
    owners.push(owner); opening = owner;
    try { owner.store.listPlaylists(); } finally { opening = null; }
    assert(owner.db, "the actual store initialized and owns this in-memory SQLite");
    owner.db.exec("PRAGMA temp_store=MEMORY");
    return owner;
  }
  function seed(owner, bytes) {
    owner.db.exec("BEGIN;DELETE FROM music_playlist_items;DELETE FROM music_playlists;DELETE FROM music_track_state;"
      + "DELETE FROM music_tracks;DELETE FROM music_artists;DELETE FROM music_albums;"
      + "INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) "
      + "VALUES('a','Artist','','a','a',2400,'ok','2026')");
    try {
      const album = owner.db.prepare("INSERT INTO music_albums(id,artist_id,title,year,cover_path,intro_text,intro_path,source_root,source_path,relative_path,track_count,duration_ms,size_bytes,updated_at) "
        + "VALUES(?,'a',?,'2026','',?,'synthetic://intro','','synthetic://album',?,24,29616,24,'2026')");
      const intro = "x".repeat(bytes);
      for (let index = 0; index < 100; index++) album.run("al" + String(index).padStart(3, "0"), "Album " + index, intro, "al" + index);
      owner.db.exec("WITH RECURSIVE x(n) AS(SELECT 0 UNION ALL SELECT n+1 FROM x WHERE n<2399) "
        + "INSERT INTO music_tracks(id,artist_id,album_id,title,display_artist,album_title,track_no,disc_no,genre,source_root,source_path,relative_path,file_name,ext,duration_ms,status,updated_at) "
        + "SELECT 't'||n,'a','al'||printf('%03d',n/24),'Track '||n,'Artist','Album '||(n/24),n%24,1,'Pop','','synthetic:///'||n,'t'||n,'song'||n,'.mp3',1234,'ok','2026' FROM x;"
        + "INSERT INTO music_playlists VALUES('p','Playlist','','2026','2026');"
        + "INSERT INTO music_playlist_items SELECT 'p',id,CAST(substr(id,2) AS INTEGER),'2026' FROM music_tracks WHERE album_id='al000';COMMIT");
    } catch (error) { owner.db.exec("ROLLBACK"); throw error; }
    MUSIC_FACET_CACHE.delete(owner.db); clock += 6000;
  }
  function clear(...items) { for (const item of items) MUSIC_FACET_CACHE.delete(item.db); }
  function measured(owner, operation) {
    measurement = { db: owner.db, sqlReads: 0, facetReads: 0, prepareAttempts: 0, rows: 0, rawFields: 0, introBytes: 0, queries: [] };
    try { return { response: operation(), ...measurement, db: undefined }; } finally { measurement = null; }
  }
  function compare(previous, current, label) {
    clock += 6000; clear(previous, current);
    const before = measured(previous, () => previous.store.playlistDetail("p"));
    const after = measured(current, () => current.store.playlistDetail("p"));
    equal(after.response, before.response, label);
    return [before, after];
  }
  function compareFacet(previous, current, args = []) {
    clear(previous, current);
    const before = previousFacet(previous.db, ...args), after = testedFacet(current.db, ...args);
    assert.deepEqual(after, before, "complete album facet DTO with native ordering/defaults");
    assert.equal(JSON.stringify(after), JSON.stringify(before));
    facetOracles++;
    return [before, after];
  }
  function equal(after, before, label) {
    assert.deepEqual(after, before, label); assert.equal(JSON.stringify(after), JSON.stringify(before), label + " JSON");
    fullResponseOracles++;
  }
  function trackUrl(parameters) { return new URL("http://fixture.invalid/api/music/tracks?" + new URLSearchParams(parameters)); }
  async function route(owner) {
    const response = {}, log = console.error;
    console.error = () => {};
    try {
      assert(await routeMusicApi({ method: "GET" }, {}, new URL("http://fixture.invalid/api/music/playlists/p"), {
        musicStore: owner.store, sendJson(_res, status, payload) { response.status = status; response.payload = payload; },
        notFound() { response.status = 404; }
      }));
      return response;
    } finally { console.error = log; }
  }
}

async function verifyAlbumListProjection() {
  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const source = fs.readFileSync(storeUrl, "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("  function listAlbums("), end = source.indexOf("  function listTracks(", start);
  assert(start >= 0 && end > start, "locate the whole album list entry");
  const currentFunction = source.slice(start, end).trimEnd();
  const previousFunction = [
    "  function listAlbums(urlOrOptions = {}) {",
    "    const params = urlOrOptions?.searchParams || new URLSearchParams();",
    "    const filter = catalogFilter(params);",
    "    const letter = String(params.get(\"letter\") || \"\").trim();",
    "    let albumWhere = filter.albumWhere;",
    "    let albumArgs = filter.albumArgs ? [...filter.albumArgs] : [];",
    "    if (letter) {",
    "      const lc = buildLetterCondition(letter, \"al.title\", \"a.name\");",
    "      if (lc) {",
    "        albumWhere = albumWhere ? `${albumWhere} AND ${lc.sql}` : lc.sql;",
    "        if (lc.args.length) albumArgs.push(...lc.args);",
    "      }",
    "    }",
    "    const limit = clampInt(params.get(\"limit\"), 80, 1, MAX_PAGE_LIMIT);",
    "    const offset = clampInt(params.get(\"offset\"), 0, 0, Number.MAX_SAFE_INTEGER);",
    "    const sort = normalizeAlbumSort(params.get(\"sort\"));",
    "    const where = albumWhere ? `WHERE ${albumWhere}` : \"\";",
    "    const order = {",
    "      title: \"al.title COLLATE NOCASE ASC\",",
    "      year: \"COALESCE(al.year, '') DESC, al.title COLLATE NOCASE ASC\",",
    "      tracks: \"al.track_count DESC, al.title COLLATE NOCASE ASC\",",
    "      updated: \"al.updated_at DESC, al.title COLLATE NOCASE ASC\"",
    "    }[sort] || \"al.updated_at DESC, al.title COLLATE NOCASE ASC\";",
    "    const database = dbOrOpen();",
    "    // Search can match the artist name, language belongs to the artist, and",
    "    // the 待 letter checks its name. Other album count filters only use al.",
    "    const countArtistJoin = filter.q || filter.language || letter === \"待\"",
    "      ? \"LEFT JOIN music_artists a ON a.id = al.artist_id\"",
    "      : \"\";",
    "    const total = Number(database",
    "      .prepare(",
    "        `",
    "        SELECT COUNT(*) AS count",
    "        FROM music_albums al",
    "        ${countArtistJoin}",
    "        ${where}",
    "      `",
    "      )",
    "      .get(...albumArgs)?.count || 0);",
    "    const rows = database",
    "      .prepare(",
    "        `",
    "        SELECT al.*, a.name AS artist_name",
    "        FROM music_albums al",
    "        LEFT JOIN music_artists a ON a.id = al.artist_id",
    "        ${where}",
    "        ORDER BY ${order}",
    "        LIMIT ? OFFSET ?",
    "      `",
    "      )",
    "      .all(...albumArgs, limit, offset);",
    "    return {",
    "      albums: rows.map(publicAlbum).map((album) => decorateAlbumSearchMatch(album, filter.searchTerm || filter.q)),",
    "      total,",
    "      limit,",
    "      offset,",
    "      hasMore: offset + rows.length < total,",
    "      query: filter.q,",
    "      artistId: filter.artistId,",
    "      genre: filter.genre,",
    "      language: filter.language,",
    "      letter,",
    "      sort,",
    "      searchMode: filter.searchKind,",
    "      languages: languageFacet(database),",
    "      summary: summary()",
    "    };",
    "  }"
  ].join("\n");
  assert.equal((previousFunction.match(/SELECT al\.\*/gu) || []).length, 1);
  assert.equal(previousFunction.includes("prepareAlbumFacet"), false, "the former list page prepares its wide SQL directly");
  const previousSource = source.slice(0, start) + previousFunction + source.slice(start + currentFunction.length);
  assert.equal(previousSource.replace(previousFunction, currentFunction), source,
    "the oracle restores the complete former listAlbums entry only, including its original page SQL");
  const previousFactory = (await import("data:text/javascript;base64," + Buffer.from(previousSource
    .replace(/from "(\.\/[^"]+)"/gu, (_match, relative) => "from " + JSON.stringify(new URL(relative, storeUrl).href)))
    .toString("base64"))).createMusicStore;
  const testedFactory = legacyWideAlbumList ? previousFactory : createMusicStore;
  const { routeMusicApi } = await import("../src/modules/music/server/routes.js");
  const { ALBUM_FACET_COLUMNS } = await import("../src/modules/music/server/facets.js");
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, now = Date.now;
  const owners = [], optional = ["year", "cover_path", "duration_ms", "size_bytes", "updated_at"];
  let opening = null, measurement = null, failure = null, failureStage = "all", beforeRead = null, clock = 1800000000000;
  let fullResponseOracles = 0, errorOracles = 0, planOracles = 0;
  const pageQuery = sql => /FROM music_albums al[\s\S]*ORDER BY[\s\S]*LIMIT \? OFFSET \?/u.test(sql);
  Date.now = () => clock;
  DatabaseSync.prototype.exec = function(sql, ...parameters) {
    if (opening && !opening.db) {
      opening.db = this;
      if (opening.missing) {
        const columns = ["id TEXT PRIMARY KEY", "artist_id TEXT", "title TEXT", "track_count INTEGER", "intro_text TEXT",
          ...optional.filter(column => !opening.missing.includes(column)).map(column =>
            column + (["duration_ms", "size_bytes"].includes(column) ? " INTEGER" : " TEXT"))];
        exec.call(this, "CREATE TABLE music_albums(" + columns.join(",") + ")");
      }
    }
    return exec.call(this, sql, ...parameters);
  };
  DatabaseSync.prototype.prepare = function(sql, ...parameters) {
    const page = pageQuery(sql), db = this;
    if (page && measurement?.db === db) measurement.prepares++;
    if (page && failure && failureStage === "prepare") throw failure;
    const statement = prepare.call(db, sql, ...parameters);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key !== "all" && key !== "get") return value.bind(target);
        return (...values) => {
          if (page && failure && failureStage === key) throw failure;
          if (page && beforeRead) { const action = beforeRead; beforeRead = null; action(); }
          const result = value.apply(target, values);
          if (measurement?.db === db) {
            measurement.sqlReads++;
            if (page) {
              measurement.pageReads++;
              const rows = Array.isArray(result) ? result : result ? [result] : [];
              measurement.rows += rows.length;
              for (const row of rows) {
                measurement.rawFields += Object.keys(row).length;
                for (const field of ["intro_text", "intro_path", "source_root", "source_path", "relative_path", "sort_title"]) {
                  const raw = row[field], bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw?.byteLength || 0;
                  measurement.unusedBytes += bytes;
                  if (field === "intro_text") measurement.introBytes += bytes;
                }
              }
              measurement.queries.push({ sql, values });
            }
          }
          return result;
        };
      }
    });
  };
  try {
    const previous = open(previousFactory), current = open(testedFactory), distributions = [];
    let payloadWork;
    for (const bytes of [0, 8192, MAX_INTRO_BYTES]) {
      seed(previous, bytes); seed(current, bytes);
      const coldBefore = read(previous), coldAfter = read(current);
      equal(coldAfter, coldBefore, "complete cold default page " + bytes);
      assert.equal(coldBefore.sqlReads, 9); assert.equal(coldAfter.sqlReads, 9);
      const warmTimes = [];
      for (let index = 0; index < 3; index++) {
        const before = read(previous), after = read(current);
        equal(after, before, "complete warm default page " + bytes + "/" + index);
        assert.equal(before.sqlReads, 2); assert.equal(after.sqlReads, 2);
        assert.equal(before.pageReads, 1); assert.equal(after.pageReads, 1);
        warmTimes.push({ formerMs: before.ms, ms: after.ms });
      }
      const before = read(previous, { limit: 300 }), after = read(current, { limit: 300 });
      equal(after, before, "complete maximum page " + bytes);
      assert.equal(before.sqlReads, 2); assert.equal(after.sqlReads, 2);
      assert.equal(before.rows, 300); assert.equal(after.rows, 300);
      clock += 6000; MUSIC_FACET_CACHE.delete(previous.db); MUSIC_FACET_CACHE.delete(current.db);
      const maxColdBefore = read(previous, { limit: 300 }), maxColdAfter = read(current, { limit: 300 });
      equal(maxColdAfter, maxColdBefore, "complete cold maximum page " + bytes);
      assert.equal(maxColdBefore.sqlReads, 9); assert.equal(maxColdAfter.sqlReads, 9);
      distributions.push({ introBytesPerAlbum: bytes,
        formerDefaultIntroBytes: coldBefore.introBytes, defaultIntroBytes: coldAfter.introBytes,
        formerDefaultColdMs: coldBefore.ms, defaultColdMs: coldAfter.ms, warmTimes,
        formerMaximumIntroBytes: before.introBytes, maximumIntroBytes: after.introBytes,
        formerMaximumMs: before.ms, maximumMs: after.ms,
        coldSqlReads: coldAfter.sqlReads, warmSqlReads: after.sqlReads });
      if (bytes === MAX_INTRO_BYTES) payloadWork = { albums: 320, defaultRows: 80, maximumRows: 300,
        formerDefaultIntroBytes: coldBefore.introBytes, defaultIntroBytes: coldAfter.introBytes,
        formerIntroBytes: before.introBytes, introBytes: after.introBytes,
        formerUnusedBytes: before.unusedBytes, unusedBytes: after.unusedBytes,
        formerRawFields: before.rawFields, rawFields: after.rawFields, plan: after.plan };
    }
    seed(previous, 64); seed(current, 64);
    const filters = [{}, { artist: "a0" }, { artist: "orphan" }, { genre: "Pop" }, { genre: "all" },
      { language: "中文" }, { language: "all" }, { letter: "A" }, { letter: "1" }, { letter: "#" },
      { letter: "待" }, { letter: "中" }, { letter: "ignored" }, { q: "Album" }, { q: "周杰伦" },
      { q: "qinghuaci" }, { q: "%_\\" }, { q: "不存在" }];
    for (const sort of ["updated", "title", "year", "tracks"])
      for (const offset of [0, 37, 310, 999])
        for (const filter of filters) {
          const options = { ...filter, sort, offset, limit: 37 };
          equal(read(current, options), read(previous, options), "complete sorted/filtered/EOF page " + JSON.stringify(options));
        }
    for (const query of ["qinghuaci", "%_\\"]) {
      const before = read(previous, { q: query }), after = read(current, { q: query });
      equal(after, before, "actual nonempty phonetic/escaped-LIKE result " + query);
      assert(before.response.total > 0, "the real query must exercise actual matches");
    }
    const both = operation => { operation(previous.db); operation(current.db); };
    const values = [null, "", 0, 1, "0", "2026", " x&?=😀 ", new Uint8Array([]), new Uint8Array([1, 47, 255])];
    for (const field of optional)
      for (const [index, value] of values.entries()) {
        if (field === "updated_at" && value === null) continue;
        both(db => db.prepare("UPDATE music_albums SET " + field + "=? WHERE id='al001'").run(value));
        equal(read(current), read(previous), "NULL/TEXT/BLOB public album field " + field + "/" + index);
      }
    both(db => db.exec("UPDATE music_albums SET title='Same title',track_count=NULL,year=NULL,cover_path='',duration_ms=NULL,size_bytes=NULL,updated_at='2026';"
      + "INSERT INTO music_albums(id,artist_id,title,track_count,updated_at,source_root,source_path,relative_path) "
      + "VALUES(NULL,'orphan','Same title',NULL,'2026','','',''),(NULL,'orphan','Same title',NULL,'2026','','','')"));
    for (const sort of ["updated", "title", "year", "tracks"])
      for (const offset of [0, 300, 320])
        equal(read(current, { sort, offset, limit: 300 }), read(previous, { sort, offset, limit: 300 }),
          "native nullable keys/tied ordering " + sort + "/" + offset);
    for (const stage of ["all", "prepare"])
      for (const [code, message, errcode] of [
        ["SYNTHETIC", "held read", 1], ["SQLITE_BUSY", "database is locked", 5],
        ["ERR_SQLITE_ERROR", "no such column: a.name", 1], ["ERR_SQLITE_ERROR", "no such column: al.year", 2],
        ["ERR_SQLITE_ERROR", "no such column: al.year", 1]
      ]) {
        const sentinel = new Error(message); sentinel.code = code; sentinel.errcode = errcode;
        failure = sentinel; failureStage = stage;
        for (const owner of [previous, current]) {
          assert.throws(() => read(owner), error => error === sentinel, "the same prepare/read Error object propagates");
          errorOracles++;
        }
        failure = null;
      }
    beforeRead = () => previous.db.exec("UPDATE music_albums SET title='Changed between prepare and step' WHERE id='al001'");
    const heldBefore = read(previous);
    beforeRead = () => current.db.exec("UPDATE music_albums SET title='Changed between prepare and step' WHERE id='al001'");
    equal(read(current), heldBefore, "actual metadata update between native prepare and step");
    // Reuse the owner's real publication invalidation. Page rows themselves
    // remain uncached, while summary/language retention follows the old path.
    const record = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key.replace(/_([a-z])/gu, (_match, character) => character.toUpperCase()), value]));
    both(db => {
      writeScanRecords(db, {
        artists: prepare.call(db, "SELECT * FROM music_artists").all().map(record),
        albums: prepare.call(db, "SELECT * FROM music_albums WHERE id IS NOT NULL").all().map(record),
        tracks: prepare.call(db, "SELECT * FROM music_tracks").all().map(record), lyrics: []
      }, [], "2026-10-05");
      assert.equal(MUSIC_FACET_CACHE.has(db), false);
    });
    clock += 6000;
    equal(read(current), read(previous), "full response after actual scan publication invalidates caches");
    equal({ response: await route(current) }, { response: await route(previous) }, "actual album route 200");
    for (const code of ["SQLITE_BUSY", "SYNTHETIC"]) {
      failure = new Error(code); failure.code = code; failureStage = "all";
      const before = await route(previous), after = await route(current);
      equal({ response: after }, { response: before }, "actual public album route " + code);
      assert.equal(after.status, code === "SQLITE_BUSY" ? 503 : 500); failure = null;
    }
    const legacySchemas = [];
    for (const missing of [[], ...optional.map(column => [column]), optional]) {
      const oldOwner = open(previousFactory, missing), newOwner = open(testedFactory, missing);
      for (const owner of [oldOwner, newOwner]) owner.db.exec(
        "INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) "
        + "VALUES('a','Artist','','a','a',1,'ok','2026');"
        + "INSERT INTO music_albums(id,artist_id,title,track_count,intro_text) VALUES('al','a','Album',1,'legacy intro')");
      for (const sort of ["updated", "title", "year", "tracks"]) {
        let before, after, oldError, nextError;
        try { before = read(oldOwner, { sort }); } catch (error) { oldError = error; }
        try { after = read(newOwner, { sort }); } catch (error) { nextError = error; }
        if (oldError) {
          assert(nextError);
          assert.deepEqual({ message: nextError.message, code: nextError.code, errcode: nextError.errcode },
            { message: oldError.message, code: oldError.code, errcode: oldError.errcode },
            "the original query/sort/summary's missing-column error remains intact");
          errorOracles++;
        } else {
          equal(after, before, "complete legacy schema response " + missing.join("/") + "/" + sort);
          assert.equal(after.prepares, before.prepares + (missing.length && !legacyWideAlbumList ? 1 : 0),
            "optional-column compatibility adds only one failed prepare before the original page query");
          assert.equal(after.pageReads, 1);
          if (missing.length) assert.equal(after.introBytes, before.introBytes, "the legacy fallback remains a full original snapshot");
        }
      }
      equal({ response: await route(newOwner) }, { response: await route(oldOwner) }, "same legacy schema public album route");
      legacySchemas.push(missing);
    }
    const freshPrevious = open(previousFactory), freshCurrent = open(testedFactory);
    equal(read(freshCurrent), read(freshPrevious), "a replacement owner has the same empty catalog and no inherited caches");
    freshPrevious.store.invalidate(); freshCurrent.store.invalidate();
    assert.equal(freshPrevious.db.isOpen, false); assert.equal(freshCurrent.db.isOpen, false);
    for (const owner of owners) {
      assert.equal(owner.store.scanDiagnostics().workerStarts, 0);
      await owner.store.stop();
      assert.equal(owner.store.scanDiagnostics().closed, true);
      assert.equal(owner.db.isOpen, false, "every actual store closes its own private database");
    }
    console.log(JSON.stringify({ albumListProjectionOracles: { fullResponseOracles, errorOracles, planOracles,
      legacySchemas: legacySchemas.length, owners: owners.length }, albumListPayloadWork: payloadWork }));
    // Keep all full DTO/error/legacy/native-plan/lifecycle checks before the
    // old implementation's real payload-budget failure.
    assert.equal(payloadWork.formerIntroBytes, 300 * MAX_INTRO_BYTES, "the old maximum page really clones 150 MiB of valid intro text");
    assert.equal(payloadWork.formerDefaultIntroBytes, 80 * MAX_INTRO_BYTES);
    assert.equal(payloadWork.introBytes, 0, "album list intro payload budget: maximum page must read zero intro bytes");
    assert.equal(payloadWork.defaultIntroBytes, 0, "default album list intro payload budget");
    assert.equal(payloadWork.unusedBytes, 0, "all non-public album source paths and sort text are excluded");
    assert.equal(payloadWork.rawFields, 3000, "each maximum-page card reads the same ten public source fields");
    return { fullResponseOracles, errorOracles, planOracles, legacySchemas: legacySchemas.length,
      actualOwnership: true, distributions, ...payloadWork };
  } finally {
    failure = null; beforeRead = null; measurement = null; opening = null;
    DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; Date.now = now;
    for (const owner of owners) await owner.store.stop();
  }

  function open(factory, missing) {
    const owner = { db: null, missing, store: factory({ dbPath: ":memory:", roots: [] }) };
    owners.push(owner); opening = owner;
    try { owner.store.listPlaylists(); } finally { opening = null; }
    assert(owner.db, "the actual store owns and initializes this in-memory connection");
    owner.db.exec("PRAGMA temp_store=MEMORY"); return owner;
  }
  function seed(owner, bytes) {
    const db = owner.db;
    db.exec("BEGIN;DELETE FROM music_playlist_items;DELETE FROM music_playlists;DELETE FROM music_track_state;"
      + "DELETE FROM music_tracks;DELETE FROM music_albums;DELETE FROM music_artists");
    try {
      const artist = db.prepare("INSERT INTO music_artists(id,name,language,source_root,source_path,relative_path,track_count,album_count,status,updated_at) "
        + "VALUES(?,?,?,'synthetic','synthetic','synthetic',400,80,'ok','2026')");
      for (let index = 0; index < 4; index++) artist.run("a" + index,
        ["Artist", "周杰伦", "待识别", "10 Numeric"][index], ["中文", "英文", "日文", "其他"][index]);
      const album = db.prepare("INSERT INTO music_albums(id,artist_id,title,year,cover_path,intro_path,intro_text,source_root,source_path,relative_path,track_count,duration_ms,size_bytes,updated_at) "
        + "VALUES(?,?,?,?,?,'synthetic://intro',?,'synthetic/root','synthetic/path',?,4,4936,24,?)");
      const intro = "x".repeat(bytes);
      for (let index = 0; index < 320; index++) album.run("al" + String(index).padStart(3, "0"),
        index % 19 === 0 ? "orphan" : "a" + index % 4,
        index % 13 === 0 ? "Tie" : index === 1 ? "青花瓷" : index === 2 ? "百分%_\\" : "Album " + index,
        index % 5 === 0 ? null : "20" + index % 30, index % 7 ? "synthetic-cover" : "", intro, "album/" + index, index % 3 ? "v1" : "v2");
      const track = db.prepare("INSERT INTO music_tracks(id,artist_id,album_id,title,genre,language,source_root,source_path,relative_path,file_name,ext,duration_ms,status,updated_at) "
        + "VALUES(?,?,?,?,?,?,'synthetic',?,?,?,'.mp3',1234,?,'2026')");
      for (let index = 0; index < 1280; index++) track.run("t" + index, "a" + Math.floor(index / 4) % 4,
        "al" + String(Math.floor(index / 4)).padStart(3, "0"), "Track" + index, index % 3 ? "Pop" : "Rock",
        ["中文", "英文", "日文", "其他"][index % 4], "synthetic://t/" + index, "t" + index, "song" + index, index % 37 ? "ok" : "missing");
      db.exec("COMMIT");
      const phonetic = db.prepare("INSERT INTO music_search_phonetic(track_id,artist_id,album_id,title,artist,album,file_name) VALUES(?,?,?,?,?,?,?)");
      insertMusicPhoneticSearchRow(phonetic, { id: "t4", artistId: "a1", albumId: "al001", title: "Track4",
        displayArtist: "周杰伦", albumTitle: "青花瓷", fileName: "song4" });
      MUSIC_FACET_CACHE.delete(db); clock += 6000;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function albumUrl(parameters = {}) { return new URL("http://fixture.invalid/api/music/albums?" + new URLSearchParams(parameters)); }
  function read(owner, parameters) {
    measurement = { db: owner.db, sqlReads: 0, pageReads: 0, prepares: 0, rows: 0, rawFields: 0, introBytes: 0, unusedBytes: 0, queries: [] };
    const started = performance.now();
    try {
      const response = owner.store.listAlbums(albumUrl(parameters)), ms = performance.now() - started;
      const query = measurement.queries[0];
      const plan = query ? prepare.call(owner.db, "EXPLAIN QUERY PLAN " + query.sql).all(...query.values).map(row => row.detail) : null;
      return { response, ...measurement, db: undefined, ms, plan };
    } finally { measurement = null; }
  }
  function equal(after, before, label) {
    assert.deepEqual(after.response, before.response, label);
    assert.equal(JSON.stringify(after.response), JSON.stringify(before.response), label + " JSON"); fullResponseOracles++;
    if (after.plan && before.plan) {
      assert.deepEqual(after.plan, before.plan, "same actual SQLite plan: " + label);
      assert.deepEqual(after.queries[0].values, before.queries[0].values);
      assert.equal(after.queries[0].sql.replace(ALBUM_FACET_COLUMNS, "al.*"), before.queries[0].sql,
        "only the page projection changes; FROM/WHERE/ORDER/LIMIT/binds remain identical: " + label);
      planOracles++;
    }
  }
  async function route(owner) {
    const response = {}, log = console.error; console.error = () => {};
    try {
      assert(await routeMusicApi({ method: "GET" }, {}, albumUrl({ limit: 37 }), {
        musicStore: owner.store, sendJson(_res, status, payload) { response.status = status; response.payload = payload; },
        notFound() { response.status = 404; }
      }));
      return response;
    } finally { console.error = log; }
  }
}

function artistUrl(options = {}) {
  const url = new URL("http://fixture.invalid/api/music/artists");
  url.searchParams.set("sort", "name");
  for (const [key, value] of Object.entries(options)) url.searchParams.set(key, String(value));
  return url;
}

function estimatedCacheBytes(db) {
  return [...(MUSIC_FACET_CACHE.get(db) || [])].reduce((bytes, [key, value]) => bytes + Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify(value), "utf8"), 0);
}

function assertBound(db) {
  const cache = MUSIC_FACET_CACHE.get(db);
  assert.ok(cache instanceof Map);
  assert.ok(cache.size <= MUSIC_FACET_CACHE_MAX_ENTRIES);
  assert.ok(estimatedCacheBytes(db) <= MUSIC_FACET_CACHE_MAX_ESTIMATED_BYTES);
}

function syntheticCatalog(root) {
  const result = { artists: [], albums: [], tracks: [], lyrics: [] };
  const updatedAt = "2026-10-04T00:00:00.000Z";
  for (let index = 0; index < 256; index += 1) {
    const artistId = index === 0 ? "a:b" : index === 1 ? "a" : `artist-${index}`;
    const albumId = `album-${index}`;
    const variants = ["！Artist 2", "Artist 02", "_Ａｒｔｉｓｔ 2", "artist 2", "Édith", "edith", "９张学友", "9张学友", "🎵", "", "坂本龍一", "Ёлка", "Artist 10", "Artist 9", "—周"];
    const name = index === 255 ? "待识别" : index >= 240 ? variants[index - 240] : ["Alpha", "beta", `${index % 10} Artist`, "周", "(苏)"][index % 5] + index;
    const language = index % 2 ? "英文" : "中文";
    const genre = index === 0 ? "c" : index === 1 ? "b:c" : index % 2 ? "Rock" : "Pop";
    const sourcePath = path.join(root, `synthetic-${index}.audio`);
    result.artists.push({ id: artistId, name, sortName: name, language, sourceRoot: root, sourcePath: path.join(root, artistId), relativePath: artistId, albumCount: 1, trackCount: 1, durationMs: 180000, sizeBytes: 1, updatedAt });
    result.albums.push({ id: albumId, artistId, title: `Album ${index}`, sortTitle: `Album ${index}`, year: "2026", coverPath: "", introPath: "", introText: "", sourceRoot: root, sourcePath: path.join(root, albumId), relativePath: albumId, trackCount: 1, durationMs: 180000, sizeBytes: 1, updatedAt });
    result.tracks.push({ id: `track-${index}`, artistId, albumId, title: `Track ${index}`, sortTitle: `Track ${index}`, displayArtist: name, albumTitle: `Album ${index}`, trackNo: 1, discNo: 1, genre, language, sourceRoot: root, sourcePath, relativePath: `synthetic-${index}.audio`, fileName: `synthetic-${index}.audio`, ext: ".audio", sizeBytes: 1, mtimeMs: 1, durationMs: 180000, codec: "synthetic", sampleRate: 44100, bitDepth: 16, channels: 2, lrcPath: "", hasLrc: 0, status: "ok", error: "", updatedAt });
  }
  return result;
}

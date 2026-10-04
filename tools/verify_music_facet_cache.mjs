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
  MUSIC_FACET_CACHE_MAX_ENTRIES,
  MUSIC_FACET_CACHE_MAX_ESTIMATED_BYTES,
  MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES,
  MUSIC_FACET_CACHE_MAX_KEY_BYTES
} from "../src/modules/music/server/constants.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import { artistNameForSort } from "../src/modules/music/server/helpers.js";

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
  if (/^SELECT \* FROM music_artists WHERE track_count > 0/u.test(sql)) {
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
  console.log(JSON.stringify({ ok: true, scenarios: 9, ...metrics }, null, 2));
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

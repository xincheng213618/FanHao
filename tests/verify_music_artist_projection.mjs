import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { artistFacet, ARTIST_FACET_COLUMNS } from "../src/modules/music/server/facets.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import { MUSIC_FACET_CACHE } from "../src/modules/music/server/constants.js";

// Actual store, publication, serializers and private native SQLite only.
// No worker, application database, service or media files participate.
assert(process.argv.slice(2).every(arg => arg === "--legacy-wide-artists"));
const negative = process.argv.includes("--legacy-wide-artists");
const storePath = new URL("../src/modules/music/server/store.js", import.meta.url);
const facetPath = new URL("../src/modules/music/server/facets.js", import.meta.url);
const source = readFileSync(storePath, "utf8").replaceAll("\r\n", "\n");
const facets = readFileSync(facetPath, "utf8").replaceAll("\r\n", "\n");
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const imports = (text, file, facetUrl) => text.replace(/from "(\.\/[^"]+)"/gu,
  (_, relative) => `from ${JSON.stringify(relative === "./facets.js" && facetUrl ? facetUrl : new URL(relative, file).href)}`);
function restore(text, changes) {
  let previous = text;
  for (const [current, old] of changes) {
    assert.equal(previous.split(current).length, 2, "one complete original SQL/prepare slot");
    previous = previous.replace(current, old);
  }
  let roundTrip = previous;
  for (const [current, old] of changes.toReversed()) roundTrip = roundTrip.replace(old, current);
  assert.equal(roundTrip, text, "only the captured former prepares/projections change, byte-for-byte");
  return previous;
}
// Independent pre-change prepares: keep the prior no-query name projection,
// all existing caches, match contexts, deduplication and full SQL algorithms.
const previousFacets = restore(facets, [[
  'const selected = prepareArtistFacet(db, `SELECT ${ARTIST_FACET_COLUMNS} FROM music_artists WHERE id = ? AND track_count > 0`).get(selectedArtistId);',
  'const selected = db.prepare("SELECT * FROM music_artists WHERE id = ? AND track_count > 0").get(selectedArtistId);'
]]);
const oldFacetUrl = moduleUrl(imports(previousFacets, facetPath));
const oldStore = restore(source, [
  ['if (query) return prepareArtistFacet(database, `SELECT ${ARTIST_BROWSER_COLUMNS} FROM music_artists WHERE ${where}`);',
    'if (query) return database.prepare(`SELECT * FROM music_artists WHERE ${where}`);'],
  ['const directArtists = prepareArtistFacet(database,\n        `\n        SELECT ${ARTIST_FACET_COLUMNS}',
    'const directArtists = database\n      .prepare(\n        `\n        SELECT *'],
  ['const artistLookup = prepareArtistFacet(database, `SELECT ${ARTIST_FACET_COLUMNS} FROM music_artists WHERE id = ? AND track_count > 0`);',
    'const artistLookup = database.prepare("SELECT * FROM music_artists WHERE id = ? AND track_count > 0");'],
  ['rows = prepareArtistFacet(database,\n          `\n          SELECT ${ARTIST_FACET_COLUMNS} FROM music_artists',
    'rows = database\n        .prepare(\n          `\n          SELECT * FROM music_artists']
]);
const { createMusicStore: previousStore } = await import(moduleUrl(imports(oldStore, storePath, oldFacetUrl)));
const { artistFacet: previousFacet } = await import(oldFacetUrl);
let subjectStore = createMusicStore, subjectFacet = artistFacet;
if (negative) {
  const slot = "export function prepareArtistFacet(db, sql) {\n";
  assert.equal(facets.split(slot).length, 2);
  const changed = facets.replace(slot, slot + '  return db.prepare(sql.replace(ARTIST_FACET_COLUMNS, "*"));\n');
  assert.equal(changed.replace(slot + '  return db.prepare(sql.replace(ARTIST_FACET_COLUMNS, "*"));\n', slot), facets,
    "negative changes only the new artist projection helper");
  const url = moduleUrl(imports(changed, facetPath));
  ({ createMusicStore: subjectStore } = await import(moduleUrl(imports(source, storePath, url))));
  ({ artistFacet: subjectFacet } = await import(url));
}

const prepare = DatabaseSync.prototype.prepare, clock = Date.now;
const connections = [], owners = [];
let measurement = null, fault = null;
let responseOracles = 0, planOracles = 0, errorOracles = 0;
const columns = ARTIST_FACET_COLUMNS;
const unused = ["sort_name", "source_root", "source_path", "relative_path", "status", "updated_at"];
const compactSql = sql => sql.replace(/\s+/gu, " ").trim();
function kind(sql) {
  const text = compactSql(sql);
  if (!text.startsWith(`SELECT ${columns} FROM music_artists WHERE `) && !text.startsWith("SELECT * FROM music_artists WHERE ")) return null;
  return /WHERE id = \?/u.test(text) ? "lookup" : /LIMIT 5$/u.test(text) ? "direct"
    : /LIMIT \? OFFSET \?$/u.test(text) ? "count" : "name";
}
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const db = this, reader = kind(sql);
  if (!connections.includes(db)) connections.push(db);
  const observed = measurement?.db === db ? measurement : null;
  if (observed) observed.prepares++;
  if (fault?.db === db && fault.kind === reader && fault.phase === "prepare") throw fault.error;
  const statement = prepare.call(db, sql, ...args);
  return new Proxy(statement, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== "function") return value;
    return (...input) => {
      if (!["get", "all"].includes(name)) return value.apply(target, input);
      const observed = measurement?.db === db ? measurement : null;
      if (observed) observed.queries.push({ sql, input, phase: name });
      if (fault?.db === db && fault.kind === reader && fault.phase === name) throw fault.error;
      const result = value.apply(target, input);
      if (reader && observed) for (const row of name === "all" ? result : result ? [result] : []) {
        observed.rows++;
        observed.fields += Object.keys(row).length;
        for (const key of unused) {
          const item = row[key];
          observed.unusedBytes += typeof item === "string" ? Buffer.byteLength(item) : ArrayBuffer.isView(item) ? item.byteLength : 0;
        }
      }
      return result;
    };
  } });
};
Date.now = () => 1791800000000;
function open(factory, facet) {
  const store = factory({ dbPath: ":memory:", roots: [], scanWorker: {
    start() { assert.fail("no worker start"); }, scan() { assert.fail("no scan"); }, async stop() {}, diagnostics() { return {}; }
  } });
  store.summary();
  const owner = { store, facet, db: connections.at(-1) };
  owners.push(owner); return owner;
}
function pair() { return { old: open(previousStore, previousFacet), current: open(subjectStore, subjectFacet) }; }
function seed(owner, count = 100, width = 180, reverse = false) {
  const names = ["测试歌手2", "测试歌手10", "TEST2", "test2", "Test10", "_%'歌手", "🎵", "　", "待识别", "王菲"];
  const artists = Array.from({ length: count }, (_, i) => ({ id: "a" + i, name: names[i] || "歌手 " + i,
    sortName: "unused sort", language: i % 2 ? "中文" : "英文", sourceRoot: "/synthetic", sourcePath: "/synthetic/" + "p".repeat(width) + i,
    relativePath: "artist/" + i, albumCount: i % 3, trackCount: i % 13 ? i % 11 + 1 : 0,
    durationMs: i % 5 ? 1000 + i : null, sizeBytes: i % 7 ? 100 + i : null, updatedAt: "2026-10-04" }));
  const albums = Array.from({ length: 4 }, (_, i) => ({ id: "al" + i, artistId: "a" + i, title: "测试专辑" + i,
    sortTitle: "", year: "2026", coverPath: "", introPath: "", introText: "", sourceRoot: "/synthetic", sourcePath: "/synthetic/al" + i,
    relativePath: "al" + i, trackCount: 16, durationMs: 1000, sizeBytes: 100, updatedAt: "2026-10-04" }));
  const tracks = Array.from({ length: 64 }, (_, i) => ({ id: "t" + i, artistId: "a" + i % 4, albumId: "al" + i % 4,
    title: "测试歌曲 " + i, sortTitle: "", displayArtist: artists[i % 4].name, albumTitle: "测试专辑" + i % 4,
    trackNo: i + 1, discNo: 1, genre: "测试", language: "中文", sourceRoot: "/synthetic", sourcePath: "/synthetic/" + i + ".mp3",
    relativePath: i + ".mp3", fileName: i + ".mp3", ext: ".mp3", sizeBytes: 100, mtimeMs: 1, durationMs: 1000,
    codec: "mp3", sampleRate: 44100, bitDepth: 16, channels: 2, lrcPath: "", hasLrc: 0, status: "ok", error: "", updatedAt: "2026-10-04" }));
  if (reverse) { artists.reverse(); albums.reverse(); tracks.reverse(); }
  writeScanRecords(owner.db, { artists, albums, tracks, lyrics: [] }, [], "fixture-scan");
  owner.db.exec("UPDATE music_artists SET status='pending' WHERE id='a1';UPDATE music_tracks SET status='missing' WHERE id='t3'");
}
const url = params => { const value = new URL("http://fixture/api/music/artists");
  for (const [key, item] of Object.entries(params)) value.searchParams.set(key, item); return value; };
function read(owner, operation) {
  measurement = { db: owner.db, prepares: 0, queries: [], rows: 0, fields: 0, unusedBytes: 0 };
  try { return { result: operation(owner), ...measurement }; } finally { measurement = null; }
}
function equal(after, before, label, extraPrepares = 0) {
  assert.deepEqual(after.result, before.result, label + " complete response");
  assert.equal(JSON.stringify(after.result), JSON.stringify(before.result), label + " serialized response");
  assert.equal(after.prepares, before.prepares + extraPrepares, label + " exact prepare count");
  assert.equal(after.queries.length, before.queries.length, label + " exact execution count");
  for (let i = 0; i < after.queries.length; i++) {
    const current = after.queries[i], old = before.queries[i];
    assert.deepEqual(current.input, old.input, label + " binds");
    assert.equal(current.phase, old.phase);
    assert.equal(compactSql(current.sql).replace(columns, "*"), compactSql(old.sql).replace(columns, "*"),
      label + " complete joins/filters/order/paging/non-artist SQL");
    assert.deepEqual(prepare.call(after.db, "EXPLAIN QUERY PLAN " + current.sql).all(...current.input).map(row => row.detail),
      prepare.call(before.db, "EXPLAIN QUERY PLAN " + old.sql).all(...old.input).map(row => row.detail), label + " native query plan");
    planOracles++;
  }
  responseOracles++;
}
function compare(value, operation, label, extra = 0) {
  const before = read(value.old, operation), after = read(value.current, operation);
  equal(after, before, label, extra); return { before, after };
}
function caught(run) { try { run(); } catch (error) { return error; } assert.fail("expected read failure"); }
function shape(error) { return { name: error.name, message: error.message, code: error.code, errcode: error.errcode }; }
const each = (value, run) => { run(value.old); run(value.current); };
const distributions = [];
try {
  for (const reverse of [false, true]) {
    const value = pair(); each(value, owner => seed(owner, 100, 180, reverse));
    for (const q of ["", "歌", "测试", "ceshi", "cshi", "test", "tset", "_", "%", "'", "🎵", "missing"]) {
      for (const sort of ["name", "count"]) for (const language of ["", "中文"]) {
        for (const [limit, offset] of [[1, 0], [7, 17], [300, 0], [80, 200]]) {
          compare(value, owner => owner.store.listArtists(url({ q, sort, language, limit, offset })), JSON.stringify({ reverse, q, sort, language, limit, offset }));
        }
      }
      compare(value, owner => owner.store.suggest(q), "suggest " + q);
    }
    for (const letter of ["A", "T", "0-9", "其他", "中", "invalid"]) for (const sort of ["name", "count"])
      compare(value, owner => owner.store.listArtists(url({ sort, letter, limit: 7, offset: 1 })), "letter " + letter + sort);
    for (const selected of ["", "all", "a99", "a13", "missing"]) for (const language of ["", "中文"])
      compare(value, owner => owner.facet(owner.db, language, selected), "selected " + selected + language);
    const saved = value.current.store.listArtists(url({ q: "歌", sort: "name", limit: 7 }));
    saved.artists[0].name = "caller private mutation";
    saved.artists[0].highlights?.push("caller private mutation");
    compare(value, owner => owner.store.listArtists(url({ q: "歌", sort: "name", limit: 7 })), "independent decorated response");
    each(value, owner => {
      owner.db.exec("UPDATE music_artists SET name='新测试歌手',track_count=123,album_count=99 WHERE id='a99'");
      MUSIC_FACET_CACHE.delete(owner.db);
    });
    compare(value, owner => owner.store.listArtists(url({ q: "新测试", sort: "name" })), "next request updated metadata");
    compare(value, owner => owner.facet(owner.db, "", "a99"), "next request updated selected facet");
  }
  const types = pair(); each(types, owner => {
    seed(owner); owner.db.prepare("UPDATE music_artists SET name=?,language=?,duration_ms=?,size_bytes=? WHERE id='a1'")
      .run(new Uint8Array([65, 66]), new Uint8Array([67]), "3.5", "not-a-number");
    owner.db.exec("UPDATE music_artists SET id=NULL WHERE id='a2'");
  });
  for (const sort of ["name", "count"]) compare(types, owner => owner.store.listArtists(url({ sort, limit: 300 })), "native SQLite value types " + sort);
  compare(types, owner => owner.store.suggest("测试"), "native blob/null DTO suggestion");
  const empty = pair();
  for (const sort of ["name", "count"]) compare(empty, owner => owner.store.listArtists(url({ sort, q: "测试" })), "successful empty " + sort);
  compare(empty, owner => owner.store.suggest("测试"), "successful empty suggestions");
  compare(empty, owner => owner.facet(owner.db, "", "missing"), "successful empty selected facet");

  const failures = pair(); each(failures, owner => seed(owner));
  const operations = [
    ["count", "all", owner => owner.store.listArtists(url({ sort: "count" }))],
    ["name", "all", owner => owner.store.listArtists(url({ sort: "name", q: "歌" }))],
    ["direct", "all", owner => owner.store.suggest("歌")],
    ["lookup", "get", owner => owner.store.suggest("测试")],
    ["lookup", "get", owner => owner.facet(owner.db, "", "a99")]
  ];
  for (const [reader, phase, operation] of operations) for (const stage of ["prepare", phase]) {
    for (const error of [new Error("controlled read failure"), Object.assign(new Error("no such column: id"), { code: "ERR_SQLITE_ERROR", errcode: 1 }),
      Object.assign(new Error("no such column: language"), { code: "ERR_SQLITE_ERROR", errcode: 5 })]) {
      each(failures, owner => { fault = { db: owner.db, kind: reader, phase: stage, error };
        assert.equal(caught(() => operation(owner)), error, "other errors preserve exact identity and do not become wide retries"); errorOracles++; fault = null; });
      compare(failures, operation, "same-owner recovery " + reader + stage);
    }
    if (stage !== "prepare") each(failures, owner => {
      const error = Object.assign(new Error("no such column: album_count"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
      fault = { db: owner.db, kind: reader, phase: stage, error };
      assert.equal(caught(() => operation(owner)), error, "read-time missing-column errors never cause a prepare-time fallback");
      errorOracles++; fault = null;
    });
  }
  for (const optional of ["language", "album_count", "duration_ms", "size_bytes"]) {
    const legacy = pair(); each(legacy, owner => {
      seed(owner); owner.store.listArtists(url({ sort: "count" })); owner.facet(owner.db);
      owner.db.exec(`ALTER TABLE music_artists RENAME COLUMN ${optional} TO private_legacy_${optional}`);
    });
    for (const [params, label] of [[{ sort: "count" }, "count"], [{ sort: "name", q: "歌" }, "query/name"]])
      compare(legacy, owner => owner.store.listArtists(url(params)), "native missing optional " + optional + label, negative ? 0 : 1);
    compare(legacy, owner => owner.facet(owner.db, "", "a99"), "native missing optional selected " + optional, negative ? 0 : 1);
    const result = compare(legacy, owner => owner.store.suggest("测试"), "native missing optional suggest " + optional,
      negative ? 0 : 2); // Direct and shared related-artist statements each retry once.
    assert.equal(result.after.unusedBytes, result.before.unusedBytes, "fallback preserves the actual former wide rows");
  }
  const closed = pair(); each(closed, owner => { seed(owner); owner.facet(owner.db); owner.db.close(); });
  for (const operation of [owner => owner.store.listArtists(url({ q: "歌", sort: "name" })), owner => owner.facet(owner.db, "", "a99")]) {
    const a = caught(() => operation(closed.current)), b = caught(() => operation(closed.old));
    assert.deepEqual(shape(a), shape(b), "native closed-owner failures remain unchanged"); errorOracles++;
  }
  const scale = pair(); each(scale, owner => seed(owner, 3000));
  for (const [label, operation] of [
    ["count80", owner => owner.store.listArtists(url({ limit: 80 }))],
    ["query/name3000", owner => owner.store.listArtists(url({ q: "歌", sort: "name", limit: 80 }))],
    ["directSuggest", owner => owner.store.suggest("歌")],
    ["relatedSuggest", owner => owner.store.suggest("测试")],
    ["selectedFacet", owner => owner.facet(owner.db, "", "a2")]
  ]) { const { before, after } = compare(scale, operation, label);
    distributions.push({ label, rows: after.rows, previousFields: before.fields, fields: after.fields, previousUnusedBytes: before.unusedBytes, unusedBytes: after.unusedBytes }); }
  console.log(JSON.stringify({ musicArtistProjectionOracles: "ok", responseOracles, planOracles, errorOracles,
    privateDatabases: owners.length, negative, distributions }));
  // Deterministic payload gate follows every complete-response, plan and error
  // oracle. Timing is deliberately not used as a correctness requirement.
  for (const value of distributions) {
    assert(value.rows > 0, value.label + " really executes the affected source read");
    assert.equal(value.fields, value.rows * 7, value.label + " reads exactly seven public artist columns");
    assert.equal(value.previousFields, value.rows * 13, value.label + " independent original reads all thirteen columns");
    assert(value.previousUnusedBytes > 0, value.label + " original rows include unused source fields");
    assert.equal(value.unusedBytes, 0, value.label + " drops unused field payload");
  }
} finally {
  fault = measurement = null;
  Date.now = clock; DatabaseSync.prototype.prepare = prepare;
  for (const owner of owners) await owner.store.stop();
}

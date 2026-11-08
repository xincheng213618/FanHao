import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

assert(process.argv.slice(2).every(value => value === "--legacy-movie-bulk"), "known arguments");
const project = fileURLToPath(new URL("../", import.meta.url));
const paths = {
  metadata: "src/modules/media/server/gallery-metadata-service.js",
  library: "src/modules/content-index/server/image-library-service.js"
};
const hashes = {
  metadata: "e24a2f4c74c3b0a4539bf5ee3bb9eec65f3497d16e2adb5d2ff844d88bbfe0d4",
  library: "30bef6e506a38bda3e4ee7eca57b3b9ba435ecbdffaf3d6a4de89b2e2666b4d2"
};
const old = {}, sources = {};
for (const [kind, relative] of Object.entries(paths)) {
  old[kind] = execFileSync("git", ["show", `63c5fab243233e142cfd62c4eaf13812feb92405:${relative}`], { cwd: project, encoding: "utf8" }).replace(/\r\n/g, "\n");
  assert.equal(crypto.createHash("sha256").update(old[kind]).digest("hex"), hashes[kind], `fixed complete ${kind} owner`);
  sources[kind] = fs.readFileSync(path.join(project, relative), "utf8").replace(/\r\n/g, "\n");
}
async function factory(kind, source) {
  const owner = new URL(paths[kind], new URL("../", import.meta.url));
  source = source.replace(/from "(\.[^"]+)"/gu, (_match, relative) => `from ${JSON.stringify(new URL(relative, owner).href)}`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return module[kind === "metadata" ? "createGalleryMetadataService" : "createImageLibraryService"];
}
const previous = { metadata: await factory("metadata", old.metadata), library: await factory("library", old.library) };
const slot = "  function beginMovieListRead() {";
assert.equal(sources.metadata.split(slot).length, 2, "one optional movie read mechanism boundary");
const fallbackSource = sources.metadata.replace(slot, `${slot}\n    return null; // Controlled complete bulk publication fallback.`);
const current = { metadata: await factory("metadata", process.argv.includes("--legacy-movie-bulk") ? fallbackSource : sources.metadata), library: await factory("library", sources.library) };
const temporary = createVerifiedTempDir("fanhao-movie-cold-projection-");
const environments = [], originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec, originalParse = JSON.parse;
let work = null, fault = null, afterRead = null, comparisons = 0, errors = 0;
const isMovieRead = sql => /^\s*SELECT\b/iu.test(sql) && /\bFROM\s+(?:(?:"main"|"temp"|main|temp)\.)?["`\[]?movie_metadata\b/iu.test(sql);
function variableBytes(rows) {
  let bytes = 0;
  for (const row of rows) for (const value of Object.values(row || {})) {
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  }
  return bytes;
}
DatabaseSync.prototype.prepare = function(sql, ...rest) {
  if (fault?.phase === "prepare" && fault.matches(sql)) { const error = fault.error; fault = null; throw error; }
  const statement = originalPrepare.call(this, sql, ...rest), connection = this;
  return new Proxy(statement, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    return (...args) => {
      if (fault?.phase === property && fault.matches(sql)) { const error = fault.error; fault = null; throw error; }
      const result = Reflect.apply(value, target, args);
      if (["all", "get"].includes(property)) {
        const rows = property === "all" ? result : [result];
        if (work) {
          work.reads++;
          if (isMovieRead(sql)) {
            const plan = originalPrepare.call(connection, `EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail);
            work.movieReads++; work.rows += rows.length; work.copiedVariableBytes += variableBytes(rows);
            work.queries.push({ sql, rows: rows.length, columns: target.columns().map(column => column.name), plan });
          } else work.probes++;
        }
        if (afterRead && isMovieRead(sql)) { const action = afterRead; afterRead = null; action(connection, sql, rows); }
      }
      return result;
    };
  } });
};
DatabaseSync.prototype.exec = function(sql, ...rest) {
  if (fault?.phase === "exec" && fault.matches(sql)) { const error = fault.error; fault = null; throw error; }
  return originalExec.call(this, sql, ...rest);
};
JSON.parse = function(value, ...rest) {
  if (work) { work.parses++; if (typeof value === "string") work.parseBytes += Buffer.byteLength(value); }
  return Reflect.apply(originalParse, this, [value, ...rest]);
};
function measure(read) {
  assert.equal(work, null); work = { reads: 0, probes: 0, movieReads: 0, rows: 0, copiedVariableBytes: 0, parses: 0, parseBytes: 0, queries: [] };
  const started = performance.now();
  try { const result = read(); return { result, ...work, instrumentedDiagnosticMs: performance.now() - started }; }
  finally { work = null; }
}
function item(index, overrides = {}) {
  return { id: `M${index}`, mediaKind: "movie", category: `cat${index % 3}`, title: `Local ${String(index).padStart(5, "0")}`,
    personName: "", rootLabel: "Synthetic", sourceRoot: "synthetic", relativePath: `M${index}.mp4`, ext: ".mp4",
    size: index + 1, playable: true, updatedAt: `2026-10-${String(index % 25 + 1).padStart(2, "0")}`, ...overrides };
}
function environment({ count = 24, heavyBytes = 0, cache = false, connectionKind = "native", initialize = null } = {}) {
  const dbPath = path.join(temporary.tempDir, `fixture-${environments.length}.sqlite`);
  const storage = createImageGalleryDbService({ dbPath, ensureDataDir() {} });
  const database = storage.getDb(), connections = new Set([database]); let active = database;
  const writer = new DatabaseSync(dbPath);
  const index = { scannedAt: "synthetic", cacheIdentity: "owned", photoSets: [], mediaItems: Array.from({ length: count }, (_, i) => item(i)) };
  const connection = connectionKind === "facade" ? { prepare: (...args) => active.prepare(...args) }
    : connectionKind === "proxy" ? new Proxy(database, { get(_target, key) {
      const value = Reflect.get(active, key, active); return typeof value === "function" ? value.bind(active) : value;
    } }) : null;
  const insert = database.prepare(`INSERT INTO movie_metadata(media_id,category,movie_title,douban_title,year,rating,rating_count,aka_json,
    directors_json,writers_json,genres_json,actors_json,countries_json,languages_json,rating_stars_json,rating_better_than_json,
    release_dates_json,durations_json,info_json,json_ld_json,summary,cover_blob,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  database.exec("BEGIN");
  for (let i = 0; i < count; i++) insert.run(`M${i}`, `metadata-cat${i % 3}`, `Stored ${i}`, `电影 ${String(i).padStart(5, "0")}`, `${2000 + i % 25}`,
    10 - i % 90 / 10, i * 7, JSON.stringify([`Alias ${i}`]), '["Director"]', '["Writer"]', '["剧情"]', '["Actor"]', '["CN"]', '["ZH"]',
    '{"5":20}', '["Good"]', '["2026-01-01"]', '["120分钟"]', '{}', '{}', `Summary ${i} ${"x".repeat(heavyBytes)}`, Buffer.from([1, 2]), "ok", "v1");
  database.exec("COMMIT");
  try { initialize?.(database, index); }
  catch (error) { writer.close(); storage.close(); throw error; }
  let indexReads = 0;
  const deps = metadata => ({ maxItemLimit: 12000, clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback)),
    getImageLibraryIndex: () => { indexReads++; return index; }, getImageLibraryRevision: () => 1, metadataService: metadata, cachePreparedQueries: cache,
    photoSetService: { coverUrl: () => "" }, mangaService: { cacheDirs: () => [], publicSummary: (value) => value, rootStatus: () => ({}) },
    photoSetRootStatuses: () => [], galleryMediaRootStatuses: () => [], imageReaderCacheStatus: () => ({}) });
  const compose = owners => {
    const metadata = owners.metadata({ createId: (_prefix, key) => key, getImageGalleryDb: () => connection || active, notFound() {} });
    return { metadata, library: owners.library(deps(metadata)) };
  };
  const env = { get db() { return active; }, get indexReads() { return indexReads; }, resetIndexReads() { indexReads = 0; },
    dbPath, writer, storage, index, before: compose(previous), after: compose(current),
    reopen() { active.close(); active.open(dbPath); },
    replace(file = dbPath) { active = new DatabaseSync(file); connections.add(active); },
    close() { writer.close(); for (const connection of connections) if (connection.isOpen) connection.close(); } };
  environments.push(env); return env;
}
const request = params => new URL(`http://fixture.invalid/api/image-library/items?${new URLSearchParams({ mode: "movie", limit: "8", ...params })}`);
function normalized(payload) {
  assert.match(payload.listRevision, /^[a-f0-9]{64}$/u, "opaque revision is still a content token");
  // Independent owner realms intentionally differ. Every other field and its
  // wire insertion order is compared; revision stability/change is separate.
  return { ...payload, listRevision: "<independent-owner-revision>" };
}
function compare(env, params = {}, label = "complete DTO and wire") {
  const expected = normalized(env.before.library.itemsPayload(request(params))), actual = normalized(env.after.library.itemsPayload(request(params)));
  if (params.mode === "manga") expected.scannedAt = ""; // Empty manga has no update time of its own.
  assert.deepEqual(actual, expected, label); assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${label} serialized order`);
  for (const item of actual.items) if (item.movieMetadata) assert.equal(item.genres, item.movieMetadata.genres, "same-item genres retains the established array alias");
  assert(!actual?.then, "the established API remains synchronous"); comparisons++; return actual;
}
function quiet(read) {
  const warn = console.warn, warnings = []; console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try { return { result: read(), warnings }; } finally { console.warn = warn; }
}
function verifyNativeFailures() {
  // Qualifies by catalog size once the optimization is present. These errors
  // must still be detected in a row outside the one-item response window.
  const env = environment({ count: 13000 });
  for (const column of ["cover_bytes", "rating_count", "season_count"]) {
    env.db.prepare(`UPDATE movie_metadata SET ${column}=? WHERE media_id='M12999'`).run(9007199254740993n);
    const stamps = [env.before.metadata.listRevision("movie"), env.after.metadata.listRevision("movie")];
    const observed = quiet(() => compare(env, { limit: "1" }, `unused suffix unsafe ${column} preserves the whole bulk failure`));
    assert.equal(observed.result.items[0].movieMetadata, null, "a native decode error beyond the selected page still removes all metadata");
    assert.notEqual(observed.result.items[0].id, "M12999");
    assert.equal(observed.warnings.length, 2, "both complete owners observe native decode errors");
    assert.notEqual(env.before.metadata.listRevision("movie"), stamps[0]); assert.notEqual(env.after.metadata.listRevision("movie"), stamps[1]);
    env.db.exec(`UPDATE movie_metadata SET ${column}=NULL`); compare(env, {}, "native suffix decode recovery"); errors++;
  }
  env.db.exec("ALTER TABLE movie_metadata ADD COLUMN private_unsafe INTEGER; UPDATE movie_metadata SET private_unsafe=9007199254740993 WHERE media_id='M12999'");
  const extra = quiet(() => compare(env, { limit: "1" }, "unknown schema column retains native decoding"));
  assert.equal(extra.result.items[0].movieMetadata, null); assert.equal(extra.warnings.length, 2); errors++;
  env.db.exec("UPDATE movie_metadata SET private_unsafe=3"); compare(env, {}, "unknown schema recovery");
}
function verifyJsonAndPublication() {
  const env = environment();
  for (const json of ["broken", "null", "[]", "true", '"string"', '{"集数":"7"}', '{"season_count":0}', '{"x":1e999}', '{"__proto__":{"polluted":true}}']) {
    env.db.prepare("UPDATE movie_metadata SET info_json=?").run(json); compare(env, {}, `info JSON ${json}`);
  }
  env.db.exec("UPDATE movie_metadata SET info_json='{}'");
  for (const json of ["broken", "null", "[]", '{"@type":"Movie"}', '{"@graph":[{"@type":"TVEpisode"}]}', '{"@type":["Movie","TVSeries"]}']) {
    env.db.prepare("UPDATE movie_metadata SET json_ld_json=?").run(json); compare(env, {}, `publication JSON ${json}`);
  }
  env.db.exec("UPDATE movie_metadata SET json_ld_json='{}'");
  for (const field of ["aka_json", "directors_json", "writers_json", "genres_json", "actors_json", "countries_json", "languages_json", "rating_stars_json", "rating_better_than_json", "release_dates_json", "durations_json"]) {
    env.db.prepare(`UPDATE movie_metadata SET ${field}=? WHERE media_id='M0'`).run('{"unexpected":1e999}'); compare(env, {}, `JSON coercion ${field}`);
  }
  for (const status of ["error", "pending", "", "ok"]) { env.db.prepare("UPDATE movie_metadata SET status=?").run(status); compare(env, {}, `publication status ${status}`); }
}
function verifyLegacySchemas() {
  for (const connectionKind of ["facade", "proxy"]) {
    const env = environment({ count: 13000, connectionKind }); compare(env, {}, connectionKind); compare(env, { offset: "8" }, connectionKind);
  }
  const view = environment({ count: 13000 });
  view.db.exec("ALTER TABLE movie_metadata RENAME TO original_movies; CREATE VIEW movie_metadata AS SELECT * FROM original_movies");
  compare(view, {}, "main view uses the original projection mechanism");
  const temp = environment({ initialize(db) {
    db.exec("CREATE TEMP TABLE movie_metadata AS SELECT * FROM main.movie_metadata; UPDATE temp.movie_metadata SET douban_title='Temporary movie'");
  } });
  assert.match(compare(temp, {}, "TEMP shadow stays on raw bulk").items[0].movieMetadata.title, /Temporary/);
  const duplicate = environment({ initialize(db, index) {
    db.exec("ALTER TABLE movie_metadata RENAME TO original_movies; CREATE TABLE movie_metadata AS SELECT * FROM original_movies; INSERT INTO movie_metadata SELECT * FROM original_movies WHERE media_id='M0'; UPDATE movie_metadata SET douban_title='Last duplicate' WHERE rowid=(SELECT MAX(rowid) FROM movie_metadata)");
    index.mediaItems = [item(0), item(0), item(1)];
  } });
  const dto = compare(duplicate, { sort: "title" }, "nonunique legacy keys retain last-row Map precedence");
  assert.equal(dto.items.filter(row => row.id === "M0")[0].movieMetadata.title, "Last duplicate");
  const actual = duplicate.after.library.itemsPayload(request({ sort: "title" }));
  const copies = actual.items.filter(row => row.id === "M0"); assert.equal(copies.length, 2);
  assert.notEqual(copies[0].movieMetadata, copies[1].movieMetadata, "duplicate raw index entries keep independent DTO objects");
  const collation = environment({ count: 13000, initialize(db, index) {
    const ddl = originalPrepare.call(db, "SELECT sql FROM sqlite_schema WHERE name='movie_metadata'").get().sql;
    db.exec("ALTER TABLE movie_metadata RENAME TO original_movies");
    db.exec(ddl.replace("media_id TEXT PRIMARY KEY", "media_id TEXT COLLATE NOCASE").replace(/\)\s*$/u, ", PRIMARY KEY(media_id COLLATE BINARY))"));
    db.exec("INSERT INTO movie_metadata SELECT * FROM original_movies; UPDATE movie_metadata SET media_id='a' WHERE media_id='M0'; UPDATE movie_metadata SET media_id='A' WHERE media_id='M1'");
    index.mediaItems[0] = item(0, { id: "a" }); index.mediaItems[1] = item(1, { id: "A" });
  } });
  compare(collation, {}, "column NOCASE and primary-key BINARY preserve exact Map identity");
}
function verifyTransactions() {
  const env = environment({ count: 13000 });
  const params = { limit: "8", sort: "title" };
  const expected = normalized(env.before.library.itemsPayload(request(params)));
  const stableBefore = env.after.library.itemsPayload(request(params)).listRevision;
  let commit = false;
  afterRead = connection => {
    assert.equal(connection, env.db, "actual reader connection executes the first metadata read");
    env.writer.exec("UPDATE movie_metadata SET douban_title='Committed new title',summary='Committed new summary'"); commit = true;
  };
  const result = measure(() => env.after.library.itemsPayload(request(params)));
  assert(commit, "the independent WAL writer committed between native reads");
  assert.deepEqual(normalized(result.result), expected, "head and complete selected metadata retain one precommit snapshot");
  assert.equal(JSON.stringify(normalized(result.result)), JSON.stringify(expected)); comparisons++;
  assert.notEqual(result.result.listRevision, stableBefore, "release precedes the final stamp, so an external commit cannot authorize an old-snapshot revision");
  assert.equal(env.db.isTransaction, false, "owned read scope is released after success");
  compare(env, params, "next request observes external WAL commit");
  const stableAfter = env.after.library.itemsPayload(request(params)).listRevision;
  assert.notEqual(stableAfter, stableBefore); assert.notEqual(stableAfter, result.result.listRevision);
  assert.equal(env.after.library.itemsPayload(request(params)).listRevision, stableAfter, "subsequent committed pages have one stable revision instead of the race token");
  for (const statement of ["BEGIN", "BEGIN IMMEDIATE"]) {
    env.db.exec(statement);
    env.db.exec("UPDATE movie_metadata SET summary='Caller uncommitted update' WHERE media_id='M0'");
    const before = env.db.prepare("SELECT summary FROM movie_metadata WHERE media_id='M0'").get().summary;
    compare(env, params, `${statement}: caller transaction data stays visible`);
    assert.equal(env.db.isTransaction, true, "list does not commit or roll back a caller's transaction");
    assert.equal(env.db.prepare("SELECT summary FROM movie_metadata WHERE media_id='M0'").get().summary, before);
    env.db.exec("ROLLBACK");
    assert.notEqual(env.db.prepare("SELECT summary FROM movie_metadata WHERE media_id='M0'").get().summary, before, "caller rollback still owns its pending write");
  }
  env.db.exec("BEGIN"); env.db.prepare("SELECT count(*) FROM movie_metadata").get();
  env.writer.exec("UPDATE movie_metadata SET summary='External while caller reads'");
  compare(env, params, "preexisting read snapshot remains consistent"); assert.equal(env.db.isTransaction, true); env.db.exec("ROLLBACK");
  const revision = env.after.metadata.listRevision("movie"); env.reopen();
  compare(env, params, "same native object reopen clears finalized statements"); assert.notEqual(env.after.metadata.listRevision("movie"), revision);
  const replacement = environment({ count: 13000, initialize(db) { db.exec("UPDATE movie_metadata SET summary='Replacement database'"); } });
  env.replace(replacement.dbPath); compare(env, params, "new native connection with identical schema reads the replacement database");
}
function verifyPreparedPlanBudgets() {
  const bounded = environment({ count: 12000, cache: true, initialize(db) { db.exec("UPDATE movie_metadata SET status='error' WHERE media_id<>'M7777'"); } });
  compare(bounded, { limit: "8", sort: "size" }, "exact 12000-row full plan");
  const warm = measure(() => bounded.after.library.itemsPayload(request({ limit: "8", offset: "4218", sort: "size" })));
  assert.equal(warm.movieReads, 0, "a bounded full plan retains all pages without SQL"); assert.equal(warm.parses, 0);
  const baseline = normalized(bounded.before.library.itemsPayload(request({ limit: "8", offset: "4218", sort: "size" })));
  assert.deepEqual(normalized(warm.result), baseline); assert(warm.result.items.some(row => row.id === "M7777" && row.movieMetadata), "later cached pages retain complete metadata outside the initial page"); comparisons++;
  const exposed = warm.result.items.find(row => row.movieMetadata); exposed.movieMetadata.title = "poison";
  compare(bounded, { limit: "8", offset: "4218", sort: "size" }, "prepared result remains detached");
  const overRows = environment({ count: 12001, cache: true, initialize(db) { db.exec("UPDATE movie_metadata SET status='error'"); } });
  overRows.after.library.itemsPayload(request({ sort: "size" }));
  assert(measure(() => overRows.after.library.itemsPayload(request({ offset: "8", sort: "size" }))).movieReads > 0, "12001 rows still reject retention");
  const overBytes = environment({ count: 8000, cache: true, heavyBytes: 2048 });
  const response = overBytes.after.library.itemsPayload(request({ sort: "size" }));
  const all = overBytes.before.library.itemsPayload(request({ sort: "size", limit: "12000" }));
  const retainedLowerBound = Buffer.byteLength(JSON.stringify(all.items));
  assert(retainedLowerBound > 16 * 1024 * 1024, "independently serialized complete items exceed the established 16 MiB budget");
  assert(measure(() => overBytes.after.library.itemsPayload(request({ sort: "size", offset: "8" }))).movieReads > 0, "oversized complete DTO plans still reject retention");
  assert.equal(response.count, 8); compare(overBytes, { sort: "size", offset: "8" }, "overbyte response remains complete");
}
function verifyOpaqueProvidersAndHiddenColumns() {
  let observations = 0;
  const target = item(0);
  const env = environment({ count: 13000, initialize(_db, index) {
    index.mediaItems[0] = new Proxy(target, { getOwnPropertyDescriptor(object, key) {
      if (key === "category") object.category = `observed-${++observations}`;
      return Reflect.getOwnPropertyDescriptor(object, key);
    } });
  } });
  observations = 0;
  const expected = normalized(env.before.library.itemsPayload(request({ limit: "1" })));
  const oldObservations = observations;
  observations = 0;
  const actual = normalized(env.after.library.itemsPayload(request({ limit: "1" })));
  assert.equal(observations, oldObservations, "opaque proxy inputs retain the original own-descriptor observations");
  assert.deepEqual(actual, expected); assert.equal(JSON.stringify(actual), JSON.stringify(expected)); comparisons++;
  const kinds = [], projections = [];
  for (const service of [env.before, env.after]) {
    let reads = 0;
    const direct = item(0); Object.defineProperty(direct, "mediaKind", { enumerable: true, get() { reads++; return "movie"; } });
    projections.push(service.library.publicGalleryMediaItem(direct)); kinds.push(reads);
  }
  assert.equal(kinds[1], kinds[0], "public item API preserves observable mediaKind reads outside the optional list path");
  assert.deepEqual(projections[1], projections[0]); comparisons++;
  env.index.mediaItems[0] = item(0);
  env.db.exec("ALTER TABLE movie_metadata ADD COLUMN _rowid_ INTEGER GENERATED ALWAYS AS (1) VIRTUAL");
  assert.equal(env.db.prepare("PRAGMA table_info(movie_metadata)").all().length, 40, "table_info cannot see the row-address shadow");
  assert.equal(env.db.prepare("PRAGMA table_xinfo(movie_metadata)").all().length, 41, "native xinfo exposes the hidden extra column");
  compare(env, { limit: "8", sort: "size" }, "hidden generated rowid shadow preserves original metadata identity");
}
function verifyOptionalFailuresAndSynchronousErrors() {
  const env = environment({ count: 13000 });
  const disabled = process.argv.includes("--legacy-movie-bulk");
  const expected = normalized(env.before.library.itemsPayload(request({ sort: "size" })));
  const cases = [
    ["prepare", sql => /AS declaration/u.test(sql), "schema prepare"],
    ["get", sql => /AS declaration/u.test(sql), "schema read"],
    ["prepare", sql => /PRAGMA main\.table_xinfo/u.test(sql), "xinfo prepare"],
    ["all", sql => /PRAGMA main\.table_xinfo/u.test(sql), "xinfo read"],
    ["prepare", sql => /__movie_list_rowid/u.test(sql) && !/WHERE/u.test(sql), "head prepare"],
    ["all", sql => /__movie_list_rowid/u.test(sql) && !/WHERE/u.test(sql), "head read"],
    ["prepare", sql => /WHERE _rowid_ IN/u.test(sql), "selected prepare"],
    ["all", sql => /WHERE _rowid_ IN/u.test(sql), "selected read"],
    ["exec", sql => /^SAVEPOINT movie_list_read_/u.test(sql), "savepoint entry"],
    ["exec", sql => /^RELEASE SAVEPOINT movie_list_read_/u.test(sql), "savepoint release"]
  ];
  for (const [phase, matches, label] of cases) {
    const stamp = env.after.metadata.listRevision("movie"); env.resetIndexReads();
    fault = { phase, matches, error: new Error(`synthetic ${label} failure`) };
    const actual = normalized(env.after.library.itemsPayload(request({ sort: "size" })));
    assert.equal(Boolean(fault), disabled, `${label} targets the optional mechanism, not the established bulk fallback`); fault = null;
    assert.deepEqual(actual, expected, label); assert.equal(JSON.stringify(actual), JSON.stringify(expected), label);
    assert.equal(env.indexReads, 1, "fallback reuses the one request's index instead of rescanning/refreshing");
    assert.equal(env.db.isTransaction, false, `${label} leaves no owned transaction behind`);
    assert.equal(env.after.metadata.listRevision("movie"), stamp, "successful complete fallback does not manufacture a bulk failure epoch");
    comparisons++; errors++;
  }
  env.db.prepare("UPDATE movie_metadata SET aka_json=? WHERE media_id='M0'").run('[{"toString":null}]');
  const thrown = [];
  for (const service of [env.before, env.after]) {
    let caught = null;
    try { service.library.itemsPayload(request({ sort: "size" })); } catch (error) { caught = error; }
    assert(caught instanceof TypeError, "ordinary native JSON conversion errors stay synchronous");
    assert.equal(env.db.isTransaction, false, "ordinary conversion error releases only the owned scope");
    thrown.push({ name: caught.name, message: caught.message });
  }
  assert.deepEqual(thrown[1], thrown[0]); errors++;
  env.db.exec("UPDATE movie_metadata SET aka_json='[]'"); compare(env, {}, "ordinary error recovery");
}
function verifyFastFieldsAndKeys() {
  const env = environment({ count: 13000 });
  for (const cover of [Buffer.alloc(0), null, "\0tail", "head\0tail", -0.5]) {
    env.db.prepare("UPDATE movie_metadata SET cover_blob=? WHERE media_id='M12999'").run(cover);
    compare(env, { sort: "size" }, "eligible cold list preserves native cover truth");
  }
  for (const [field, value] of [["info_json", '{"集数":"7"}'], ["json_ld_json", '{"@graph":[{"@type":"TVEpisode"}]}']]) {
    env.db.prepare(`UPDATE movie_metadata SET ${field}=? WHERE media_id='M12999'`).run(value);
    assert.equal(compare(env, { sort: "size" }, "eligible cold list retains movie/TV publication guards").items[0].movieMetadata, null);
    env.db.exec(`UPDATE movie_metadata SET ${field}='{}'`);
  }
  env.index.mediaItems.push(item(0));
  compare(env, { sort: "size", offset: "12993" }, "eligible duplicate index entries hydrate independently");
  const duplicated = env.after.library.itemsPayload(request({ sort: "size", offset: "12993" })).items.filter(row => row.id === "M0");
  assert.equal(duplicated.length, 2); assert.notEqual(duplicated[0].movieMetadata, duplicated[1].movieMetadata);
  assert.notEqual(duplicated[0].genres, duplicated[1].genres, "duplicate items do not share their parsed arrays");
  env.index.mediaItems.pop();
  env.db.exec("UPDATE movie_metadata SET media_id=NULL WHERE media_id='M2'; UPDATE movie_metadata SET _rowid_=9223372036854775800 WHERE media_id='M4'");
  env.index.mediaItems[2] = item(2, { id: null });
  compare(env, { sort: "size", offset: "12992" }, "NULL Map identity and unsafe numeric rowid use exact original metadata");
  for (const [id, value] of [["M0", "nul\0one"], ["M1", "nul\0two"]]) env.db.prepare("UPDATE movie_metadata SET media_id=? WHERE media_id=?").run(value, id);
  env.index.mediaItems[0] = item(0, { id: "nul" }); env.index.mediaItems[1] = item(1, { id: "nul" });
  const collided = compare(env, { sort: "size", offset: "12992" }, "native NUL decoding collisions retain original last-row Map precedence");
  assert(collided.items.filter(row => row.id === "nul").every(row => row.movieMetadata.title === "电影 00001"));
  for (const params of [{ q: "Actor" }, { category: "cat1" }, { limit: "12000" }]) {
    compare(env, params, "search, bounded filtered plan and majority-page fallback");
    const measurement = measure(() => env.after.library.itemsPayload(request(params)));
    assert.equal(measurement.movieReads, 1, "unqualified requests keep the one established full bulk read");
    assert.equal(measurement.queries[0].columns.length, 40);
  }
}
function verifyCopyAndParseBudget() {
  const env = environment({ count: 13000, heavyBytes: 4096, cache: true });
  const measurements = [];
  for (const limit of [8, 48]) {
    const params = { sort: "rating", limit: `${limit}`, offset: "48" };
    const before = measure(() => env.before.library.itemsPayload(request(params)));
    const after = measure(() => env.after.library.itemsPayload(request(params)));
    assert.deepEqual(normalized(after.result), normalized(before.result), "cold projection complete DTO");
    assert.equal(JSON.stringify(normalized(after.result)), JSON.stringify(normalized(before.result)), "cold projection full wire order"); comparisons++;
    assert(before.copiedVariableBytes > 50 * 1024 * 1024, "real native bulk transfers the synthetic wide metadata");
    // This is the first failing gate for the narrow old-bulk negative control.
    assert(after.copiedVariableBytes < before.copiedVariableBytes / 10, "cold native copied string/blob bytes stay below one tenth of the complete bulk");
    assert(after.parses < before.parses / 2, "only head fields and selected complete metadata are parsed");
    assert.equal(before.movieReads, 1); assert.equal(after.movieReads, 2, "one complete head and one selected native read");
    assert.equal(after.queries[0].rows, 13000); assert.equal(after.queries[1].rows, limit);
    assert(after.queries[0].plan.some(line => /SCAN movie_metadata/u.test(line)), "the native head is a real full table traversal");
    assert(after.queries[1].plan.some(line => /SEARCH movie_metadata USING INTEGER PRIMARY KEY/u.test(line)), "native selected hydration uses bounded row-address seeks");
    assert.equal(env.db.isTransaction, false);
    const brief = ({ result: _result, queries, ...metrics }) => ({ ...metrics, queries: queries.map(({ rows, columns, plan }) => ({ rows, columnCount: columns.length, plan })) });
    measurements.push({ limit, before: brief(before), after: brief(after) });
  }
  return measurements;
}

try {
  const env = environment();
  for (const sort of ["updated", "title", "rating", "year", "size", "unknown"]) for (const offset of [0, 9, 1000]) compare(env, { sort, offset: `${offset}` });
  for (const params of [{ q: "Alias" }, { category: "cat1" }, { person: "missing" }, { mode: "media" }, { mode: "western" }, { mode: "tv" }, { mode: "photo" }, { mode: "manga" }]) compare(env, params);
  for (const value of [null, Buffer.alloc(0), Buffer.from([7]), "", "text", "\0tail", "head\0tail", 0, 3, -3, 0.5]) {
    env.db.prepare("UPDATE movie_metadata SET cover_blob=?").run(value); compare(env, {}, "native cover truth conversion");
  }
  verifyJsonAndPublication(); verifyNativeFailures(); verifyLegacySchemas(); verifyTransactions(); verifyPreparedPlanBudgets(); verifyOpaqueProvidersAndHiddenColumns(); verifyOptionalFailuresAndSynchronousErrors(); verifyFastFieldsAndKeys();
  console.log(`movie-cold-projection contracts: ${comparisons} complete DTO/wire comparisons, ${errors} error/fallback contracts PASS`);
  const measurements = verifyCopyAndParseBudget();
  console.log(JSON.stringify({ fixture: "movie-cold-projection", comparisons, errors, measurements }, null, 2));
} finally {
  DatabaseSync.prototype.prepare = originalPrepare; DatabaseSync.prototype.exec = originalExec; JSON.parse = originalParse;
  for (const env of environments) env.close();
  temporary.cleanup();
}

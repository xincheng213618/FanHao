import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRankingService } from "../src/modules/fanhao/server/catalog/ranking-service.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createFanhaoDependencies } from "../src/modules/fanhao/server/composition.js";

// Actual ranking queries and SQLite, synthetic metadata only. Failed reads
// must keep their existing response fallback while remaining retryable.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-poison"));
let createRanking = createRankingService;
if (process.argv.includes("--legacy-poison")) {
  let source = fs.readFileSync(new URL("../src/modules/fanhao/server/catalog/ranking-service.js", import.meta.url), "utf8");
  for (const [current, previous] of [
    ["if (cacheable) {", "if (true) {"],
    ["if (source.cacheable) {", "if (true) {"],
    ["if (source.cacheable && workInfoReadCacheable() !== false) cachePage(pageCacheKey, payload);", "cachePage(pageCacheKey, payload);"],
    ["if (cacheable) rankingMissingSearchCache = { stamp, works };", "rankingMissingSearchCache = { stamp, works };"]
  ]) {
    assert.equal(source.split(current).length, 2);
    source = source.replace(current, previous);
  }
  createRanking = new Function(source.replace("export function createRankingService", "function createRankingService") + "\nreturn createRankingService;")();
}
const databases = [];
const warnings = [], originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
let comparisons = 0;
try {
  for (const phase of ["prepare", "all"]) for (const kind of ["list", "missing", "cover"]) {
    const actual = fixture(createRanking), expected = fixture(createRankingService);
    actual.state.failure = { phase, kind };
    const read = kind === "missing" ? value => value.service.missingSearchWorks() : value => value.page();
    const fallback = read(actual);
    if (kind === "cover") assert.equal(fallback.count, 6, "a temporary cover error still returns the complete ranking list");
    else assert.equal(Array.isArray(fallback) ? fallback.length : fallback.count, 0);
    actual.state.failure = null;
    const recovered = read(actual);
    assert.deepEqual(recovered, read(expected), "a transient ranking read failure must not poison the same-stamp cache"); comparisons++;
    if (kind === "cover") assert.ok(recovered.works.every(work => work.remoteCoverUrl));
    const calls = { ...actual.counts };
    assert.equal(read(actual), recovered, "successful same-owner responses still reuse the cache");
    assert.deepEqual(actual.counts, calls);
    if (kind !== "missing") {
      assert.deepEqual(actual.page({ offset: "2", missing: "1" }), expected.page({ offset: "2", missing: "1" })); comparisons++;
    }
  }
  for (const phase of ["prepare", "all"]) {
    const actual = fixture(createRanking), expected = fixture(createRankingService);
    actual.state.failure = { phase, kind: "cover" };
    const partial = actual.service.missingSearchWorks(); assert.equal(partial.length, 6);
    assert.ok(partial.every(work => !work.remoteCoverUrl));
    actual.state.failure = null;
    const recovered = actual.service.missingSearchWorks();
    assert.deepEqual(recovered, expected.service.missingSearchWorks()); comparisons++;
    const calls = { ...actual.counts };
    assert.equal(actual.service.missingSearchWorks(), recovered);
    assert.deepEqual(actual.counts, calls);
  }
  for (const phase of ["prepare", "all"]) for (const kind of ["missing", "cover"]) {
    const actual = fixture(createRanking), expected = fixture(createRankingService);
    const search = searchReader(actual), cold = searchReader(expected);
    actual.state.failure = { phase, kind };
    const first = search(); assert.equal(first.count, kind === "cover" ? 1 : 0);
    actual.state.failure = null;
    const recovered = search();
    assert.deepEqual(recovered, cold(), "text-search source/page caches must also release a failed ranking fallback"); comparisons++;
    const calls = { ...actual.counts };
    assert.equal(search(), recovered);
    assert.deepEqual(actual.counts, calls);
  }
  const actual = fixture(createRanking), expected = fixture(createRankingService);
  for (const phase of ["prepare", "all"]) {
    const direct = fixture(createRanking), cold = fixture(createRankingService);
    direct.state.failure = { phase, kind: "list" };
    assert.deepEqual(direct.service.rows("top", "y2025"), []);
    direct.state.failure = null;
    const recovered = direct.service.rows("top", "y2025");
    assert.deepEqual(recovered, cold.service.rows("top", "y2025")); comparisons++;
    assert.equal(direct.service.rows("top", "y2025"), recovered);
    const warm = fixture(createRanking);
    warm.state.failure = { phase, kind: "list" }; warm.service.prewarm();
    warm.state.failure = null; warm.service.prewarm();
    assert.deepEqual(warm.page(), cold.page()); comparisons++;
  }
  const noWorks = fixture(createRanking, 0);
  const noMissing = noWorks.service.missingSearchWorks(); assert.equal(noMissing.length, 0);
  const noMissingReads = noWorks.counts.missing;
  assert.equal(noWorks.service.missingSearchWorks(), noMissing);
  assert.equal(noWorks.counts.missing, noMissingReads, "a successful empty missing-work result remains reusable");
  // Failure in a later cover batch must not cache an incomplete earlier result.
  const many = fixture(createRanking, 405), manyExpected = fixture(createRankingService, 405);
  many.state.failure = { phase: "all", kind: "cover", at: 2 };
  const partial = many.page(); assert.equal(partial.count, 405);
  assert.equal(partial.works.filter(work => work.remoteCoverUrl).length, 205);
  many.state.failure = null;
  assert.deepEqual(many.page(), manyExpected.page()); comparisons++;
  // Native closed-connection failure, followed by an equivalent fresh database.
  actual.state.db.close();
  assert.equal(actual.page().count, 0);
  actual.state.db = seed();
  assert.deepEqual(actual.page(), expected.page()); comparisons++;
  const empty = actual.page({ key: "absent" }); assert.equal(empty.count, 0);
  const emptyCalls = actual.counts.list;
  assert.equal(actual.page({ key: "absent" }), empty, "genuine empty lists remain cacheable");
  assert.equal(actual.counts.list, emptyCalls);
  for (const key of ["user", "stamp"]) {
    actual.state[key] = expected.state[key] = `${key}:next`;
    assert.deepEqual(actual.page(), expected.page()); comparisons++;
  }
  actual.service.invalidateSearch();
  assert.deepEqual(actual.page(), expected.page()); comparisons++;
  assert.ok(warnings.length >= 8);
  console.log(JSON.stringify({ ok: true, comparisons, failurePhases: 2, retryKinds: 3, laterCoverBatch: true, nativeClosedRecovery: true, emptyHitsPreserved: true }));
} finally {
  console.warn = originalWarn;
  for (const db of databases) if (db.isOpen) db.close();
}

function searchReader(target) {
  const dependencies = {
    library: { scannedAt: "same", worksById: new Map() }, actorMovieStamp: () => "same", workQueryStamp: () => "same",
    userStateStamp: () => target.state.user, actorMissingSearchWorks: () => [], rankingMissingSearchWorks: target.service.missingSearchWorks,
    actorMissingSearchResult: undefined, actorMissingSearchResultForPeople: undefined,
    mergedActorMovieRowsResult: undefined, missingActorWorksResultForPerson: undefined,
    withWorkInfoReadStatus: undefined, workInfoReadCacheable: undefined,
    withWorkSearchReadStatus: undefined, workSearchReadCacheable: undefined,
    rankingMissingSearchResult: process.argv.includes("--legacy-poison") ? undefined : target.service.missingSearchResult,
    createWorkSearchMatcher: text => work => work.title.toLowerCase().includes(text),
    searchPeople: () => ({ exact: [], matchedPersonIds: [], people: [] }), prewarmWorkSearch: () => {},
    dedupeWorksForDisplay: rows => rows, defaultWorkLimit: 48, maxWorkLimit: 1000,
    clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, value === null ? fallback : Number(value))),
    favoriteStateService: { isFavoriteWork: () => false, publicFavoriteForWork: () => null }, playbackProgressService: { getWorkProgress: () => null },
    peopleScopeService: { normalize: () => "main", workMatches: () => true }, isVrWork: () => false, workHasCoreCover: () => false,
    workHasLocalMarker: () => false, workInfoFacetRow: () => null, publicWorkAvailability: () => ({}),
    publicWork: work => ({ ...structuredClone(work), owner: target.state.user }), storedWorkCodeKey: value => String(value || ""),
    prewarmRemoteImagesForWorks: () => {}, peoplePayloadStamp: () => "same", actorMovieInfoStamp: () => "same",
    displayWorkTitle: value => String(value || ""), workClassificationService: { visibilityStamp: () => "", filterForRequest: rows => rows },
    enrichLocalWorksWithActorMovieIndex: rows => rows, enrichLocalWorksWithActorMovieInfo: rows => rows,
    prewarmCoreWorkCovers: () => {}, prewarmWorkInfoDetails: () => {}, prewarmVideoProbesForWorks: () => {}, publicPerson: person => person
  };
  // Pass through the real server dependency grouping: direct query injection
  // alone would miss a dropped optional status reader at this boundary.
  const grouped = createFanhaoDependencies(new Proxy({ ...dependencies, diskUsage: {}, getLibrary: () => dependencies.library }, {
    get: (object, key) => Object.hasOwn(object, key) ? object[key] : () => {}
  }));
  const query = createWorkQueryService({ ...grouped.works, library: dependencies.library });
  return () => query.searchPayload(new URL("http://fixture/api/works?q=Title+1&limit=48"));
}

function seed(count = 6) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec(`ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE collections(id INTEGER PRIMARY KEY,type TEXT,source_key TEXT,name TEXT,source_url TEXT);
    CREATE TABLE collection_items(collection_id INTEGER,work_id INTEGER,rank_no INTEGER,title_snapshot TEXT,rating_snapshot REAL,rating_count_snapshot INTEGER,fetched_at TEXT,updated_at TEXT);
    CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,code_search TEXT,title TEXT,release_date TEXT,rating REAL,rating_count INTEGER);
    CREATE TABLE work_external_refs(work_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY,owner_id INTEGER,owner_type TEXT,kind TEXT,source TEXT,remote_url TEXT);
    INSERT INTO collections VALUES(1,'ranking','top:y2025','Synthetic ranking','https://fixture.invalid/ranking');`);
  const work = db.prepare("INSERT INTO works VALUES(?,?,?,?,?,?,?)");
  const item = db.prepare("INSERT INTO collection_items VALUES(1,?,?,?,NULL,NULL,'fixture','2026')");
  const image = db.prepare("INSERT INTO fanhao_images.images VALUES(?,?,'work','cover','javdb_rankings',?)");
  for (let i = 1; i <= count; i++) {
    work.run(i, `ABC-${i}`, `abc${i}`, `Title ${i}`, "2025-01-01", 4.5, 10);
    item.run(i, i, `Title ${i}`); image.run(i, i, `https://fixture.invalid/${i}.jpg`);
  }
  return db;
}

function fixture(create, count = 6) {
  const state = { db: seed(count), failure: null, user: "alice", stamp: "same" };
  const counts = { list: 0, missing: 0, cover: 0 };
  const instrumented = new WeakSet();
  const getCoreDb = () => {
    const db = state.db;
    if (!instrumented.has(db)) {
      instrumented.add(db); const prepare = db.prepare.bind(db);
      db.prepare = sql => {
        const kind = sql.includes("FROM fanhao_images.images") ? "cover" : sql.includes("substr(c.source_key") ? "missing"
          : sql.includes("AND c.source_key = ?") ? "list" : null;
        if (kind && state.failure?.kind === kind && state.failure.phase === "prepare") throw new Error("synthetic ranking prepare failure");
        const statement = prepare(sql);
        return { all(...args) {
          if (kind) counts[kind]++;
          if (kind && state.failure?.kind === kind && state.failure.phase === "all"
            && (!state.failure.at || counts[kind] === state.failure.at)) throw new Error("synthetic ranking step failure");
          return statement.all(...args);
        } };
      };
    }
    return db;
  };
  const service = create({ getCoreDb, getSearchStamp: () => state.stamp, userStateStamp: () => state.user,
    clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, value === null ? fallback : Number(value))),
    maxWorkLimit: 1000, createId: (prefix, value) => `${prefix}:${value}`, dbBoolOrNull: value => value == null ? null : Boolean(value),
    localWorkByCodeKey: () => new Map(), localWorkCodeKeys: () => new Set(), looseWorkCodeKey: value => String(value || ""),
    storedWorkCodeKey: value => String(value || ""), normalizeWorkCode: value => String(value || ""), parseJsonTextArray: () => [],
    proxiedRemoteImageUrl: value => value, prewarmCoreWorkCovers: () => {}, prewarmWorkInfoDetails: () => {},
    prewarmRemoteImagesForWorks: () => {}, publicWork: work => ({ ...structuredClone(work), owner: state.user })
  });
  return { state, counts, service, page: params => service.worksPayload(new URL("http://fixture/api/rankings/top?" + new URLSearchParams({ key: "y2025", ...params }))) };
}

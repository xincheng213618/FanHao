import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { normalizeWorkCode, workCodeKey } from "../lib/code-parser.js";
import { createActorMovieService } from "../src/modules/fanhao/server/people/actor-movie-service.js";
import { prewarmLocalMetadataBeforeListen } from "../src/modules/fanhao/server/runtime.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";

const LOCAL_WORK_COUNT = 20_000;
const ACTOR_ROW_COUNT = 65_000;
// Exact code derivation is allowed only before listen. Once the port is open,
// both the first route and a concurrent health request have a strict budget.
const HTTP_HEALTH_LIMIT_MS = 500;
const FIXTURE_PRELISTEN_LIMIT_MS = 1_500;

function storedWorkCodeKey(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function workCodeKeys(work) {
  const values = work?.codeKeys || [work?.infoSummary?.code, work?.code, work?.title, work?.directoryName];
  return [...new Set(values.map(workCodeKey).filter(Boolean))];
}

function cachedMeasuredWorkCodeKeys(spans) {
  const cache = new WeakMap();
  return (work) => {
    const cached = cache.get(work);
    if (cached) return cached;
    const started = performance.now();
    try {
      const keys = workCodeKeys(work);
      cache.set(work, keys);
      return keys;
    } finally {
      spans.set("work-code-keys", (spans.get("work-code-keys") || 0) + performance.now() - started);
    }
  };
}

function createFixtureDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE works (
      id INTEGER PRIMARY KEY,
      code TEXT,
      code_search TEXT,
      title TEXT,
      release_date TEXT,
      rating REAL,
      rating_count INTEGER,
      has_magnet INTEGER,
      is_streamable INTEGER,
      has_subtitles INTEGER,
      javdb_tags_json TEXT
    );
    CREATE INDEX idx_works_code_search ON works(code_search);
    CREATE TABLE work_people (
      work_id INTEGER NOT NULL,
      person_id INTEGER NOT NULL,
      role TEXT,
      sort_order INTEGER,
      source TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (work_id, person_id, source),
      FOREIGN KEY (work_id) REFERENCES works(id),
      FOREIGN KEY (person_id) REFERENCES people(id)
    );
    CREATE INDEX idx_work_people_source_work ON work_people(source, work_id);
    CREATE TABLE person_external_refs (id INTEGER PRIMARY KEY, person_id INTEGER, provider TEXT, external_key TEXT, url TEXT);
    CREATE TABLE work_external_refs (id INTEGER PRIMARY KEY, work_id INTEGER, provider TEXT, url TEXT);
    CREATE INDEX idx_work_external_refs_work_provider ON work_external_refs(work_id, provider);
    CREATE TABLE fanhao_images.images (
      id INTEGER PRIMARY KEY,
      owner_type TEXT,
      owner_id INTEGER,
      kind TEXT,
      source TEXT,
      remote_url TEXT,
      local_path TEXT,
      updated_at TEXT,
      image_blob BLOB,
      sort_order INTEGER
    );
  `);
  return db;
}

function insertActorRow(db, {
  id,
  personId,
  code,
  codeSearch = storedWorkCodeKey(code),
  title = `Title ${code}`,
  position = 0,
  url = `https://example.test/works/${id}`
}) {
  db.prepare("INSERT OR IGNORE INTO people (id, name) VALUES (?, ?)").run(personId, `Person ${personId}`);
  db.prepare(`
    INSERT INTO works (
      id, code, code_search, title, release_date, rating, rating_count,
      has_magnet, is_streamable, has_subtitles, javdb_tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, code, codeSearch, title, `2025-01-${String((id % 28) + 1).padStart(2, "0")}`, 4.2, id, 1, 1, 0, '["fixture"]');
  db.prepare(`
    INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
    VALUES (?, ?, 'actor', ?, 'actor_movies', '2025-01-01', '2025-01-01')
  `).run(id, personId, position);
  db.prepare("INSERT INTO work_external_refs (id, work_id, provider, url) VALUES (?, ?, 'javdb-video', ?)")
    .run(id, id, url);
}

function createActorService(db, options = {}) {
  const queryLog = options.queryLog || [];
  const library = options.library || {
    people: [],
    peopleById: new Map()
  };
  return createActorMovieService({
    createId: (prefix, value) => `${prefix}:${value}`,
    dbBoolOrNull: (value) => value == null ? null : Boolean(value),
    getCoreDb: () => ({
      prepare(sql) {
        queryLog.push(sql);
        if (options.failNarrow?.() && sql.includes("WHERE w.code_search IN")) {
          throw new Error("fixture transient read failure");
        }
        const statement = db.prepare(sql);
        if (!options.recordSqlSpan) return statement;
        return {
          all(...args) {
            const started = performance.now();
            try {
              return statement.all(...args);
            } finally {
              options.recordSqlSpan(performance.now() - started);
            }
          }
        };
      }
    }),
    getInfoStamp: options.getInfoStamp || (() => "info-v1"),
    getLibrary: () => library,
    getSearchStamp: options.getFullStamp || (() => "full-v1"),
    getStamp: options.getFullStamp || (() => "full-v1"),
    localWorkCodeKeys: () => new Set(),
    looseWorkCodeKey: workCodeKey,
    mergedPersonMembers: (personId) => [{ id: String(personId) }],
    normalizeWorkCode,
    parseJsonTextArray: (value) => JSON.parse(value || "[]"),
    proxiedRemoteImageUrl: (value) => value || "",
    publicRemoteUrl: (value) => value || "",
    storedWorkCodeKey,
    workCodeKeys: options.workCodeKeys || workCodeKeys
  });
}

function enrichedBytes(service, works, optimized) {
  const enriched = optimized
    ? service.enrichLocalWorksWithIndex(works)
    : service.enrichLocalWorks(works, service.rowsForWorks(works));
  return Buffer.from(JSON.stringify(enriched));
}

function verifySemanticEquivalence() {
  const db = createFixtureDb();
  try {
    insertActorRow(db, { id: 1, personId: 2, code: "ABC-001", title: "person 2 / position 0", position: 0 });
    insertActorRow(db, { id: 2, personId: 10, code: "abc-001", title: "person 10 / position 5", position: 5 });
    insertActorRow(db, { id: 3, personId: 10, code: "ABC_001", title: "person 10 / position 1", position: 1 });
    insertActorRow(db, { id: 17, personId: 10, code: "ABC-001", title: "person 10 / position 1 / code first", position: 1 });
    db.prepare("INSERT INTO people (id, name) VALUES (11, 'Person 11')").run();
    db.prepare(`
      INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
      VALUES (3, 11, 'actor', 0, 'actor_movies', '2025-01-01', '2025-01-01')
    `).run();
    insertActorRow(db, { id: 4, personId: 3, code: "LEG-002", codeSearch: "", title: "legacy empty code_search" });
    insertActorRow(db, { id: 5, personId: 4, code: "CASE-001", codeSearch: "CASE001", title: "legacy uppercase code_search" });
    insertActorRow(db, { id: 6, personId: 5, code: "MIX-002", codeSearch: "MiX002", title: "legacy mixed-case code_search" });
    insertActorRow(db, { id: 7, personId: 6, code: "HYP-003", codeSearch: "HYP-003", title: "legacy hyphenated code_search" });
    insertActorRow(db, { id: 8, personId: 7, code: "SPC-004", codeSearch: " SPC004 ", title: "legacy spaced code_search" });
    insertActorRow(db, { id: 9, personId: 8, code: "PAR(001)", codeSearch: "par(001)", title: "legacy parenthesized code_search" });
    insertActorRow(db, { id: 10, personId: 9, code: "PLS+002", codeSearch: "pls+002", title: "legacy plus code_search" });
    insertActorRow(db, { id: 11, personId: 10, code: "COL:003", codeSearch: "col:003", title: "legacy colon code_search" });
    insertActorRow(db, { id: 12, personId: 11, code: "BRK[004]", codeSearch: "brk[004]", title: "legacy bracketed code_search" });
    insertActorRow(db, { id: 13, personId: 1, code: "DUP-001", codeSearch: "", title: "legacy empty first", position: 5 });
    insertActorRow(db, { id: 14, personId: 2, code: "DUP-001", codeSearch: "dup001", title: "canonical second", position: 0 });
    insertActorRow(db, { id: 15, personId: 1, code: "UPC-001", codeSearch: "UPC001", title: "legacy uppercase first", position: 5 });
    insertActorRow(db, { id: 16, personId: 2, code: "UPC-001", codeSearch: "upc001", title: "uppercase canonical second", position: 0 });

    db.exec("BEGIN");
    for (let index = 0; index < 1_205; index += 1) {
      const code = `TST-${10_000 + index}`;
      insertActorRow(db, { id: 100 + index, personId: 20 + (index % 17), code, position: index % 4 });
    }
    db.exec("COMMIT");

    const localWorks = [
      { id: "local-abc", title: "Folder AbC-001", infoSummary: null },
      { id: "local-legacy", title: "LEG-002", infoSummary: null },
      { id: "local-uppercase", title: "case-001", infoSummary: null },
      { id: "local-mixed-case", title: "MIX-002", infoSummary: null },
      { id: "local-hyphenated", title: "hyp-003", infoSummary: null },
      { id: "local-spaced", title: "SPC-004", infoSummary: null },
      { id: "local-parenthesized", title: "PAR-001", infoSummary: null },
      { id: "local-plus", title: "PLS-002", infoSummary: null },
      { id: "local-colon", title: "COL-003", infoSummary: null },
      { id: "local-bracketed", title: "BRK-004", infoSummary: null },
      { id: "local-empty-first-duplicate", title: "DUP-001", infoSummary: null },
      { id: "local-uppercase-first-duplicate", title: "UPC-001", infoSummary: null },
      { id: "local-empty", title: "", infoSummary: null },
      { id: "local-invalid", title: "1080p", infoSummary: null },
      ...Array.from({ length: 1_205 }, (_, index) => ({
        id: `local-${index}`,
        title: `TST-${10_000 + index}`,
        infoSummary: null
      })),
      { id: "local-cross-batch-duplicate", title: "TST-10000", infoSummary: null }
    ];
    const library = {
      people: Array.from({ length: 32 }, (_, index) => ({ id: String(index + 1), name: `Person ${index + 1}` })),
      peopleById: new Map(Array.from({ length: 32 }, (_, index) => [String(index + 1), { id: String(index + 1), name: `Person ${index + 1}` }]))
    };
    const legacy = createActorService(db, { library });
    const queryLog = [];
    const optimized = createActorService(db, { library, queryLog });
    const legacyResult = enrichedBytes(legacy, localWorks, false);
    const optimizedResult = enrichedBytes(optimized, localWorks, true);
    assert.deepEqual(optimizedResult, legacyResult, "narrow enrichment must preserve the old response bytes");

    const parsed = JSON.parse(optimizedResult);
    assert.equal(parsed[0].infoSummary.title, "person 10 / position 1 / code first", "person text order, position, and binary w.code order must select the same first row as rowsByCodeKey");
    assert.equal(parsed[1].infoSummary.title, "legacy empty code_search", "empty legacy code_search must still use the parsed w.code fallback");
    assert.equal(parsed[2].infoSummary.title, "legacy uppercase code_search", "uppercase stored code_search must preserve old normalization semantics");
    assert.equal(parsed[3].infoSummary.title, "legacy mixed-case code_search", "mixed-case stored code_search must preserve old normalization semantics");
    assert.equal(parsed[4].infoSummary.title, "legacy hyphenated code_search", "hyphenated stored code_search must preserve old normalization semantics");
    assert.equal(parsed[5].infoSummary.title, "legacy spaced code_search", "spaced stored code_search must preserve old normalization semantics");
    assert.equal(parsed[6].infoSummary.title, "legacy parenthesized code_search", "parenthesized stored code_search must preserve old normalization semantics");
    assert.equal(parsed[7].infoSummary.title, "legacy plus code_search", "plus-delimited stored code_search must preserve old normalization semantics");
    assert.equal(parsed[8].infoSummary.title, "legacy colon code_search", "colon-delimited stored code_search must preserve old normalization semantics");
    assert.equal(parsed[9].infoSummary.title, "legacy bracketed code_search", "bracketed stored code_search must preserve old normalization semantics");
    assert.equal(parsed[10].infoSummary.title, "legacy empty first", "legacy empty-key candidates must compete with direct canonical rows using old person ordering");
    assert.equal(parsed[10].infoSummary.javdbUrl, "https://example.test/works/13");
    assert.equal(parsed[10].infoSummary.ratingCount, 13);
    assert.equal(parsed[10].infoSummary.releaseDate, "2025-01-14");
    assert.equal(parsed[11].infoSummary.title, "legacy uppercase first", "legacy uppercase candidates must compete with direct canonical rows using old person ordering");
    assert.equal(parsed[11].infoSummary.javdbUrl, "https://example.test/works/15");
    assert.equal(parsed[11].infoSummary.ratingCount, 15);
    assert.equal(parsed[11].infoSummary.releaseDate, "2025-01-16");
    assert.equal(parsed[12].infoSummary, null, "empty local codes must remain unenriched");
    assert.equal(parsed[13].infoSummary, null, "invalid local codes must remain unenriched");
    assert.equal(parsed.at(-1).infoSummary, null, "duplicate local code keys must enrich only the old first local work");

    const batchQueries = queryLog.filter((sql) => sql.includes("WHERE w.code_search IN"));
    assert(batchQueries.length >= 2, "more than 999 keys must be queried in bounded batches");
    assert(batchQueries.every((sql) => (sql.match(/\?/g) || []).length <= 900), "each SQLite parameter batch must stay below the configured bound");
    assert(batchQueries.every((sql) => !sql.includes("LOWER(w.code_search) IN")), "the primary narrow lookup must retain the BINARY code_search index predicate");
    assert(queryLog.some((sql) => sql.includes("w.code_search <> LOWER(w.code_search)")), "the compatibility query must select uppercase and mixed-case stored keys for old normalization semantics");
    assert(queryLog.some((sql) => sql.includes("w.code_search GLOB '*[^A-Za-z0-9]*'")), "the compatibility query must select every stored key containing non-canonical punctuation");

    let failNextNarrow = true;
    const recoveryLog = [];
    const recovery = createActorService(db, {
      library,
      queryLog: recoveryLog,
      failNarrow: () => {
        if (!failNextNarrow) return false;
        failNextNarrow = false;
        return true;
      }
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    let startupReady;
    try {
      startupReady = prewarmLocalMetadataBeforeListen({
        prewarmLocalMetadata: () => recovery.enrichLocalWorksWithIndex(localWorks.slice(0, 2))
      }, () => {});
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(startupReady, false, "a transient metadata prewarm error must not prevent the server from continuing to listen");
    assert.deepEqual(
      enrichedBytes(recovery, localWorks.slice(0, 2), true),
      enrichedBytes(legacy, localWorks.slice(0, 2), false),
      "the first request after a transient error must retry and recover"
    );
    assert(recoveryLog.filter((sql) => sql.includes("WHERE w.code_search IN")).length >= 2, "a failed batch must not become a negative-cache hit");
  } finally {
    db.close();
  }
}

function verifyDirectAndLegacyCandidateCompetition() {
  for (const scenario of [
    { name: "empty-first", code: "DUP-001", legacyCodeSearch: "", directCodeSearch: "dup001", legacyTitle: "legacy empty first" },
    { name: "uppercase-first", code: "UPC-001", legacyCodeSearch: "UPC001", directCodeSearch: "upc001", legacyTitle: "legacy uppercase first" }
  ]) {
    const db = createFixtureDb();
    try {
      insertActorRow(db, {
        id: 1,
        personId: 1,
        code: scenario.code,
        codeSearch: scenario.legacyCodeSearch,
        title: scenario.legacyTitle,
        position: 5
      });
      insertActorRow(db, {
        id: 2,
        personId: 2,
        code: scenario.code,
        codeSearch: scenario.directCodeSearch,
        title: "canonical second",
        position: 0
      });
      const works = [{ id: `local-${scenario.name}`, title: scenario.code, infoSummary: null }];
      const legacy = createActorService(db);
      const queryLog = [];
      const optimized = createActorService(db, { queryLog });
      const legacyResult = enrichedBytes(legacy, works, false);
      const optimizedResult = enrichedBytes(optimized, works, true);
      assert.deepEqual(optimizedResult, legacyResult, `${scenario.name} direct and legacy candidates must preserve old response bytes`);
      const info = JSON.parse(optimizedResult)[0].infoSummary;
      assert.equal(info.title, scenario.legacyTitle);
      assert.equal(info.javdbUrl, "https://example.test/works/1");
      assert.equal(info.ratingCount, 1);
      assert.equal(info.releaseDate, "2025-01-02");
      assert.equal(
        queryLog.filter((sql) => sql.includes("w.code_search GLOB '*[^A-Za-z0-9]*'")).length,
        1,
        `${scenario.name} must execute compatibility competition even when the indexed direct lookup hits`
      );
    } finally {
      db.close();
    }
  }
}

function verifyInvalidationAndStaleFallback() {
  const db = createFixtureDb();
  try {
    insertActorRow(db, { id: 1, personId: 2, code: "ABC-001", title: "first", position: 0, url: "https://example.test/first" });
    insertActorRow(db, { id: 2, personId: 2, code: "ABC-001", title: "second", position: 1, url: "https://example.test/second" });
    const works = [{ id: "local", title: "ABC-001", infoSummary: null }];
    let fullStamp = "full-v1";
    let infoStamp = "info-v1";
    let failNextNarrow = false;
    const queryLog = [];
    const service = createActorService(db, {
      queryLog,
      getFullStamp: () => fullStamp,
      getInfoStamp: () => infoStamp,
      failNarrow: () => {
        if (!failNextNarrow) return false;
        failNextNarrow = false;
        return true;
      }
    });
    const narrowCount = () => queryLog.filter((sql) => sql.includes("WHERE w.code_search IN")).length;
    const first = service.enrichLocalWorksWithIndex(works);
    const firstCount = narrowCount();

    fullStamp = "images-changed";
    assert.deepEqual(service.enrichLocalWorksWithIndex(works), first, "image changes must not invalidate metadata-only enrichment");
    fullStamp = "person-external-refs-changed";
    assert.deepEqual(service.enrichLocalWorksWithIndex(works), first, "person external refs must not invalidate metadata-only enrichment");
    assert.equal(narrowCount(), firstCount, "irrelevant full actor presentation stamps must not repeat the local metadata query");

    db.prepare("UPDATE works SET title = 'work changed' WHERE id = 1").run();
    infoStamp = "works-v2";
    assert.equal(service.enrichLocalWorksWithIndex(works)[0].infoSummary.title, "work changed", "works changes must invalidate immediately");
    const afterWorks = narrowCount();

    db.prepare("UPDATE work_people SET sort_order = 5 WHERE work_id = 1").run();
    db.prepare("UPDATE work_people SET sort_order = 0 WHERE work_id = 2").run();
    infoStamp = "work-people-v3";
    assert.equal(service.enrichLocalWorksWithIndex(works)[0].infoSummary.title, "second", "work_people ordering changes must invalidate immediately");
    assert(narrowCount() > afterWorks);

    db.prepare("UPDATE work_external_refs SET url = 'https://example.test/updated' WHERE work_id = 2").run();
    infoStamp = "work-external-refs-v4";
    assert.equal(service.enrichLocalWorksWithIndex(works)[0].infoSummary.javdbUrl, "https://example.test/updated", "work external refs changes must invalidate immediately");

    infoStamp = "transient-v5";
    failNextNarrow = true;
    const originalWarn = console.warn;
    console.warn = () => {};
    let stale;
    try {
      stale = service.enrichLocalWorksWithIndex(works);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(stale[0].infoSummary.javdbUrl, "https://example.test/updated", "a failed refresh must preserve the complete prior usable value");
    infoStamp = "transient-v6";
    failNextNarrow = true;
    console.warn = () => {};
    try {
      stale = service.enrichLocalWorksWithIndex(works);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(stale[0].infoSummary.javdbUrl, "https://example.test/updated", "repeated failed stamp changes must retain the last successful metadata map");
    const failedCount = narrowCount();
    assert.equal(service.enrichLocalWorksWithIndex(works)[0].infoSummary.javdbUrl, "https://example.test/updated", "the request after stale fallback must retry successfully");
    assert(narrowCount() > failedCount, "stale fallback must not mark the failed batch as refreshed");
  } finally {
    db.close();
  }
}

function createProductionShapeDb() {
  const db = createFixtureDb();
  const insertPerson = db.prepare("INSERT INTO people (id, name) VALUES (?, ?)");
  const insertWork = db.prepare(`
    INSERT INTO works (
      id, code, code_search, title, release_date, rating, rating_count,
      has_magnet, is_streamable, has_subtitles, javdb_tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPersonWork = db.prepare(`
    INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
    VALUES (?, ?, 'actor', ?, 'actor_movies', '2025-01-01', '2025-01-01')
  `);
  const insertRef = db.prepare("INSERT INTO work_external_refs (id, work_id, provider, url) VALUES (?, ?, 'javdb-video', ?)");
  db.exec("BEGIN");
  for (let personId = 1; personId <= 256; personId += 1) insertPerson.run(personId, `Person ${personId}`);
  for (let index = 0; index < ACTOR_ROW_COUNT; index += 1) {
    const id = index + 1;
    const code = `PRD-${100_000 + index}`;
    insertWork.run(id, code, storedWorkCodeKey(code), `Production fixture ${code}`, `2025-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`, 4.0, index, 1, 1, 0, "[]");
    insertPersonWork.run(id, (index % 256) + 1, index % 8);
    if (index < LOCAL_WORK_COUNT) insertRef.run(id, id, `https://example.test/production/${id}`);
  }
  db.exec("COMMIT");
  return db;
}

function createProductionQuery(db, spans, spanCounts) {
  const localWorks = Array.from({ length: LOCAL_WORK_COUNT }, (_, index) => {
    const code = `PRD-${100_000 + index}`;
    return {
      id: String(index + 1),
      title: code,
      directoryName: code,
      relativePath: `library/${code}`,
      modifiedAt: `2025-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      videos: [], images: [], infos: [],
      playableCount: 1,
      infoCount: 0,
      missingLocal: false,
      infoSummary: null
    };
  });
  let fullStamp = "full-v1";
  const actor = createActorService(db, {
    getFullStamp: () => fullStamp,
    recordSqlSpan: (elapsedMs) => spans.set("narrow-sql", (spans.get("narrow-sql") || 0) + elapsedMs),
    workCodeKeys: cachedMeasuredWorkCodeKeys(spans)
  });
  const library = {
    scannedAt: "production-fixture-v1",
    worksById: new Map(localWorks.map((work) => [work.id, work]))
  };
  const query = createWorkQueryService({
    actorMovieInfoStamp: () => "info-v1",
    actorMovieStamp: () => fullStamp,
    actorMissingSearchWorks: () => [],
    clampInteger(value, fallback, min, max) {
      const parsed = Number.parseInt(value, 10);
      return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
    },
    defaultWorkLimit: 48,
    enrichLocalWorksWithActorMovieIndex: actor.enrichLocalWorksWithIndex,
    favoriteStateService: { isFavoriteWork: () => false, publicFavoriteForWork: () => null },
    isVrWork: () => false,
    library,
    maxWorkLimit: 1_000,
    peopleScopeService: {
      normalize: () => "main",
      workMatches: () => false,
      workMatchesDirect: () => false
    },
    playbackProgressService: { getWorkProgress: () => null },
    prewarmRemoteImagesForWorks: () => {},
    publicWork: (work) => ({
      id: work.id,
      title: work.title,
      modifiedAt: work.modifiedAt,
      playableCount: work.playableCount,
      infoSummary: work.infoSummary
    }),
    publicWorkAvailability: () => ({ hasMagnet: false }),
    recordPerformanceSpan: (label, elapsedMs) => {
      spans.set(label, (spans.get(label) || 0) + elapsedMs);
      spanCounts.set(label, (spanCounts.get(label) || 0) + 1);
    },
    userStateStamp: () => "state-v1",
    workHasCoreCover: () => false,
    workHasLocalMarker: () => false,
    workInfoFacetRow: () => null,
    workQueryStamp: () => "query-v1"
  });
  return {
    query,
    changePresentationStamp() {
      fullStamp = "images-and-person-presentation-v2";
    }
  };
}

async function waitForWorkerMessage(worker, predicate) {
  while (true) {
    const [message] = await once(worker, "message");
    if (predicate(message)) return message;
  }
}

async function verifyProductionShapeAndHttpGate() {
  const db = createProductionShapeDb();
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ type: 'ready' });
    parentPort.on('message', async ({ url }) => {
      const startedAt = Date.now();
      try {
        const response = await fetch(url + '/api/health');
        await response.arrayBuffer();
        parentPort.postMessage({ type: 'health', ok: response.ok, elapsedMs: Date.now() - startedAt, startedAt });
      } catch (error) {
        parentPort.postMessage({ type: 'health', ok: false, elapsedMs: Date.now() - startedAt, startedAt, error: error.message });
      }
    });
  `, { eval: true });
  let server;
  try {
    await waitForWorkerMessage(worker, (message) => message.type === "ready");
    const spans = new Map();
    const spanCounts = new Map();
    const { query, changePresentationStamp } = createProductionQuery(db, spans, spanCounts);
    const prewarmStarted = performance.now();
    query.prewarmLocalMetadata();
    const prewarmMs = performance.now() - prewarmStarted;
    assert(prewarmMs < FIXTURE_PRELISTEN_LIMIT_MS, `production-shape metadata prewarm took ${prewarmMs.toFixed(1)}ms`);
    const enrichCountAfterPrewarm = spanCounts.get("enrich");
    changePresentationStamp();
    const targetUrl = new URL("http://fixture/api/works?category=censored&filter=playable&sort=releaseDesc&limit=48&offset=0");
    let worksFinishedAt = 0;
    server = http.createServer((request, response) => {
      if (request.url === "/api/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      if (request.url?.startsWith("/api/works")) {
        worker.postMessage({ url: `http://127.0.0.1:${server.address().port}` });
        const payload = query.listPayload(new URL(request.url, "http://fixture"));
        const body = JSON.stringify(payload);
        worksFinishedAt = Date.now();
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const coldStarted = performance.now();
    const coldResponse = await fetch(`${baseUrl}${targetUrl.pathname}${targetUrl.search}`);
    const coldBytes = Buffer.from(await coldResponse.arrayBuffer());
    const coldMs = performance.now() - coldStarted;
    const health = await waitForWorkerMessage(worker, (message) => message.type === "health");
    assert.equal(coldResponse.status, 200);
    assert(coldMs < HTTP_HEALTH_LIMIT_MS, `first /api/works took ${coldMs.toFixed(1)}ms after pre-listen metadata preparation`);
    assert.equal(spanCounts.get("enrich"), enrichCountAfterPrewarm, "images/person presentation stamp changes must not repeat local metadata enrichment after prewarm");
    assert.equal(health.ok, true, health.error || "concurrent health request must succeed");
    assert(health.startedAt <= worksFinishedAt, "the health client must start while the cold works handler is still running");
    assert(health.elapsedMs < HTTP_HEALTH_LIMIT_MS, `concurrent /api/health took ${health.elapsedMs}ms during the cold works request`);

    const warmStarted = performance.now();
    const warmResponse = await fetch(`${baseUrl}${targetUrl.pathname}${targetUrl.search}`);
    const warmBytes = Buffer.from(await warmResponse.arrayBuffer());
    const warmMs = performance.now() - warmStarted;
    // The second works request also schedules a health probe; consume it before shutdown.
    await waitForWorkerMessage(worker, (message) => message.type === "health");
    assert.deepEqual(warmBytes, coldBytes, "cold and warm HTTP response bytes must be identical");
    const payload = JSON.parse(coldBytes);
    assert.equal(payload.count, 48);
    assert.equal(payload.total, LOCAL_WORK_COUNT);
    assert.equal(payload.category, "censored");
    assert.equal(payload.filter, "playable");
    assert.equal(payload.sort, "releaseDesc");
    const spanSummary = [...spans.entries()].map(([label, elapsedMs]) => `${label}=${elapsedMs.toFixed(1)}ms`).join(", ");
    console.log(`works-cold-performance: rows=${ACTOR_ROW_COUNT}, local=${LOCAL_WORK_COUNT}, prelisten-metadata=${prewarmMs.toFixed(1)}ms, first-request=${coldMs.toFixed(1)}ms, warm=${warmMs.toFixed(1)}ms, concurrent-health=${health.elapsedMs}ms`);
    console.log(`works-cold-performance spans: ${spanSummary}`);
    return { coldMs, warmMs, healthMs: health.elapsedMs };
  } finally {
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    await worker.terminate();
    db.close();
  }
}

async function verifyRealReadOnlyDatabase(coreDbPath, { skipPrewarm = false, readinessOnly = false } = {}) {
  const startupStarted = performance.now();
  const db = new DatabaseSync(coreDbPath, { readOnly: true });
  let server;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ type: 'ready' });
    parentPort.on('message', async ({ url }) => {
      const startedAt = Date.now();
      try {
        const response = await fetch(url + '/api/health');
        await response.arrayBuffer();
        parentPort.postMessage({ type: 'health', ok: response.ok, elapsedMs: Date.now() - startedAt, startedAt });
      } catch (error) {
        parentPort.postMessage({ type: 'health', ok: false, elapsedMs: Date.now() - startedAt, startedAt, error: error.message });
      }
    });
  `, { eval: true });
  try {
    const rows = db.prepare(`
      SELECT
        CAST(lw.id AS TEXT) AS id,
        lw.detected_code,
        lw.source_name,
        lw.local_path,
        w.code,
        w.release_date,
        w.rating,
        w.rating_count,
        MAX(lf.modified_at) AS modified_at,
        SUM(CASE WHEN lf.playable = 1 THEN 1 ELSE 0 END) AS playable_count,
        SUM(CASE WHEN lf.file_type = 'info' THEN 1 ELSE 0 END) AS info_count
      FROM local_works lw
      JOIN works w ON w.id = lw.work_id
      LEFT JOIN local_files lf ON lf.local_work_id = lw.id
      GROUP BY lw.id
    `).all();
    const worksById = new Map(rows.map((row) => [row.id, {
      id: row.id,
      title: row.detected_code || row.code || row.source_name || "",
      directoryName: row.source_name || row.detected_code || row.code || "",
      relativePath: row.local_path || "",
      modifiedAt: row.modified_at || "",
      videos: [], images: [], infos: [],
      playableCount: Number(row.playable_count || 0),
      infoCount: Number(row.info_count || 0),
      missingLocal: false,
      infoSummary: null,
      codeKeys: [row.code, row.detected_code, row.source_name, row.local_path].filter(Boolean),
      facetRow: {
        release_date: row.release_date,
        rating: row.rating,
        rating_count: row.rating_count,
        code: row.code
      }
    }]));
    for (const file of db.prepare("SELECT CAST(local_work_id AS TEXT) AS local_work_id, file_type, name, title, relative_path FROM local_files ORDER BY local_work_id").iterate()) {
      const work = worksById.get(file.local_work_id);
      if (!work) continue;
      work.codeKeys.push(file.name, file.title, file.relative_path);
    }

    const spans = new Map();
    const spanCounts = new Map();
    let fullStamp = "real-read-only-full-v1";
    const actor = createActorService(db, {
      getInfoStamp: () => "real-read-only-info-v1",
      getFullStamp: () => fullStamp,
      recordSqlSpan: (elapsedMs) => spans.set("narrow-sql", (spans.get("narrow-sql") || 0) + elapsedMs),
      workCodeKeys: cachedMeasuredWorkCodeKeys(spans)
    });
    const library = { scannedAt: "real-read-only-v1", worksById };
    const query = createWorkQueryService({
      actorMovieInfoStamp: () => "real-read-only-info-v1",
      actorMovieStamp: () => fullStamp,
      actorMissingSearchWorks: () => [],
      clampInteger(value, fallback, min, max) {
        const parsed = Number.parseInt(value, 10);
        return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
      },
      defaultWorkLimit: 48,
      enrichLocalWorksWithActorMovieIndex: actor.enrichLocalWorksWithIndex,
      favoriteStateService: { isFavoriteWork: () => false, publicFavoriteForWork: () => null },
      isVrWork: () => false,
      library,
      maxWorkLimit: 1_000,
      peopleScopeService: { normalize: () => "main", workMatches: () => false, workMatchesDirect: () => false },
      playbackProgressService: { getWorkProgress: () => null },
      prewarmRemoteImagesForWorks: () => {},
      publicWork: (work) => ({ id: work.id, title: work.title, modifiedAt: work.modifiedAt, playableCount: work.playableCount, infoSummary: work.infoSummary }),
      publicWorkAvailability: () => ({ hasMagnet: false }),
      recordPerformanceSpan: (label, elapsedMs) => {
        spans.set(label, (spans.get(label) || 0) + elapsedMs);
        spanCounts.set(label, (spanCounts.get(label) || 0) + 1);
      },
      userStateStamp: () => "state-v1",
      workHasCoreCover: () => false,
      workHasLocalMarker: () => false,
      workInfoFacetRow: (workId) => worksById.get(String(workId))?.facetRow || null,
      workQueryStamp: () => "query-v1"
    });
    let prewarmMs = 0;
    let enrichCountAfterPrewarm = 0;
    if (!skipPrewarm) {
      const prewarmStarted = performance.now();
      query.prewarmLocalMetadata();
      prewarmMs = performance.now() - prewarmStarted;
      enrichCountAfterPrewarm = spanCounts.get("enrich");
      fullStamp = "real-images-and-person-presentation-v2";
    }

    await waitForWorkerMessage(worker, (message) => message.type === "ready");
    let worksFinishedAt = 0;
    server = http.createServer((request, response) => {
      if (request.url === "/api/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      if (request.url?.startsWith("/api/works")) {
        worker.postMessage({ url: `http://127.0.0.1:${server.address().port}` });
        const payload = query.listPayload(new URL(request.url, "http://fixture"));
        const body = JSON.stringify(payload);
        worksFinishedAt = Date.now();
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const tcpReadyMs = performance.now() - startupStarted;
    const requestPath = "/api/works?category=censored&filter=playable&sort=releaseDesc&limit=48&offset=0";
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const readinessHealth = await fetch(`${baseUrl}/api/health`);
    await readinessHealth.arrayBuffer();
    const healthReadyMs = performance.now() - startupStarted;
    assert.equal(readinessHealth.status, 200);
    if (readinessOnly) {
      console.log(`works-real-readiness: mode=${skipPrewarm ? "baseline-lazy" : "prelisten-metadata"}, local=${worksById.size}, tcp=${tcpReadyMs.toFixed(1)}ms, health=${healthReadyMs.toFixed(1)}ms, prelisten-metadata=${prewarmMs.toFixed(1)}ms`);
      return { tcpReadyMs, healthReadyMs, prewarmMs };
    }
    const firstStarted = performance.now();
    const firstResponse = await fetch(`${baseUrl}${requestPath}`);
    const firstBytes = Buffer.from(await firstResponse.arrayBuffer());
    const firstMs = performance.now() - firstStarted;
    const health = await waitForWorkerMessage(worker, (message) => message.type === "health");
    assert.equal(firstResponse.status, 200);
    assert(firstMs < HTTP_HEALTH_LIMIT_MS, `real first /api/works took ${firstMs.toFixed(1)}ms after pre-listen metadata preparation`);
    if (!skipPrewarm) {
      assert.equal(spanCounts.get("enrich"), enrichCountAfterPrewarm, "real presentation-only stamp changes must preserve prewarmed local metadata enrichment");
    }
    assert.equal(health.ok, true, health.error || "real read-only concurrent health must succeed");
    assert(health.startedAt <= worksFinishedAt, "real health request must begin before the first works handler completes");
    assert(health.elapsedMs < HTTP_HEALTH_LIMIT_MS, `real concurrent /api/health took ${health.elapsedMs}ms`);
    const warmStarted = performance.now();
    const warmResponse = await fetch(`${baseUrl}${requestPath}`);
    const warmBytes = Buffer.from(await warmResponse.arrayBuffer());
    const warmMs = performance.now() - warmStarted;
    await waitForWorkerMessage(worker, (message) => message.type === "health");
    assert.deepEqual(warmBytes, firstBytes, "real read-only first/warm response bytes must match");
    const result = JSON.parse(firstBytes);
    const spanSummary = [...spans.entries()].map(([label, elapsedMs]) => `${label}=${elapsedMs.toFixed(1)}ms`).join(", ");
    console.log(`works-real-readonly: local=${worksById.size}, matched=${result.total}, tcp=${tcpReadyMs.toFixed(1)}ms, health-ready=${healthReadyMs.toFixed(1)}ms, prelisten-metadata=${prewarmMs.toFixed(1)}ms, first-request=${firstMs.toFixed(1)}ms, warm=${warmMs.toFixed(1)}ms, concurrent-health=${health.elapsedMs}ms`);
    console.log(`works-real-readonly spans: ${spanSummary}`);
    return { prewarmMs, firstMs, warmMs, healthMs: health.elapsedMs };
  } finally {
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    await worker.terminate();
    db.close();
  }
}

const realDbArgIndex = process.argv.indexOf("--real-core-db");
if (realDbArgIndex >= 0) {
  const coreDbPath = process.argv[realDbArgIndex + 1];
  assert(coreDbPath, "--real-core-db requires a path");
  await verifyRealReadOnlyDatabase(coreDbPath, {
    skipPrewarm: process.argv.includes("--skip-prewarm"),
    readinessOnly: process.argv.includes("--readiness-only")
  });
} else {
  verifySemanticEquivalence();
  verifyDirectAndLegacyCandidateCompetition();
  verifyInvalidationAndStaleFallback();
  await verifyProductionShapeAndHttpGate();
  console.log("works cold-path performance verification passed");
}

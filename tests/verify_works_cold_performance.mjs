import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { normalizeWorkCode, workCodeKey } from "../lib/code-parser.js";
import { deriveWorkTraits, matchesWorkTraitFilter, summarizeWorkTraits } from "../lib/work-traits.js";
import { createActorMovieService } from "../src/modules/fanhao/server/people/actor-movie-service.js";
import { prewarmLocalMetadataBeforeListen } from "../src/modules/fanhao/server/runtime.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createPlaybackProgressService } from "../src/modules/fanhao/server/playback/playback-progress-service.js";
import { createCollectionQueryService } from "../src/modules/fanhao/server/user-state/collection-query-service.js";
import { createWorkPresenterService } from "../src/modules/fanhao/server/works/presenter-service.js";
import { createWorkSorter } from "../src/modules/fanhao/server/works/work-sorter.js";
import { createWorkFilterService } from "../src/modules/fanhao/server/works/work-filter-service.js";
import { createFavoriteStateService } from "../src/modules/fanhao/server/collections/favorite-state-service.js";
import { createWorkClassificationService } from "../src/modules/fanhao/server/works/work-classification-service.js";
import { createWorkImageService } from "../src/modules/fanhao/server/works/image-service.js";
import { classifyWorkCategory, normalizeWorkCategory, summarizeWorkCategories, WORK_CATEGORY_OPTIONS } from "../src/modules/fanhao/server/works/work-category.js";
import { createWeightedCacheBudget, normalizeWorkSortMode } from "../src/modules/fanhao/server/works/work-cache-budget.js";
import { normalizePersonWorkYear, personWorkYearOptions, worksForPersonYear } from "../src/modules/fanhao/server/people/person-work-year.js";

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
      workMatches: (_work, scope) => scope === "main",
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
      peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope === "main", workMatchesDirect: () => false },
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


async function legacyHistoryProgressFactory() {
  const source = readFileSync(new URL("../src/modules/fanhao/server/playback/playback-progress-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const legacyScan = [
    "    for (const work of library.worksById.values()) {",
    "      if ((work.videos || []).some((video) => video.id === videoId)) return work;",
    "    }",
    "    return null;"
  ].join("\n");
  const legacySource = source
    .replace("function progressWork(videoId, progress, firstWorkForVideo) {", "function progressWork(videoId, progress) {")
    .replace("    return firstWorkForVideo(videoId);", legacyScan)
    .replace(/    const progressVideoIds = new Set\(Object\.keys\(progress\)\);[\s\S]*?(?=\n    for \(const \[videoId, progressRow\])/, "")
    .replace("progressWork(videoId, progressRow, firstWorkForVideo)", "progressWork(videoId, progressRow)");
  assert.notEqual(legacySource, source, "history legacy oracle must restore the actual production scan");
  assert(!legacySource.includes("firstWorkForVideo"), "history legacy oracle restoration hooks must match the current source");
  return (await import("data:text/javascript;base64," + Buffer.from(legacySource).toString("base64"))).createPlaybackProgressService;
}

function createHistoryFixture(factory, { count = LOCAL_WORK_COUNT, fallback = 125, early = false, allDirect = false, boundaries = false } = {}) {
  const visits = { works: 0, videos: 0 };
  class CountedWorks extends Map {
    *values() {
      for (const work of super.values()) {
        visits.works += 1;
        yield work;
      }
    }
  }
  const countedVideos = (videos) => new Proxy(videos, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) visits.videos += 1;
      return Reflect.get(target, key, receiver);
    }
  });
  const worksById = new CountedWorks();
  const filesById = new Map();
  for (let index = 0; index < count; index += 1) {
    const id = "work-" + index;
    const videoId = "video-" + index;
    const videos = countedVideos([
      { id: videoId, type: "video", size: index + 1, playable: true },
      { id: videoId + "-b", type: "video", size: 5 }
    ]);
    const work = {
      id, title: "Film " + index, directoryName: "Film " + index, relativePath: "synthetic/" + index,
      personId: "person", personName: "Person", videos, images: [], infos: [],
      videoCount: 2, playableCount: 1, imageCount: 0, infoCount: 0, modifiedAt: "2026",
      infoSummary: { rating: index % 5, ratingCount: index, durationMinutes: 90, code: "CODE-" + index, releaseDate: "2026" }
    };
    worksById.set(id, work);
    for (const video of videos) filesById.set(video.id, { type: "video" });
  }
  let library = { worksById, filesById, peopleById: new Map(), scannedAt: "v1" };
  let revision = 0;
  let userState = { favorites: {}, favoriteFolders: { default: { name: "Default" } }, progress: {} };
  for (let index = 0; index < fallback; index += 1) {
    const workIndex = early ? index : count - 1 - index;
    userState.progress["video-" + workIndex] = {
      workId: allDirect ? "work-" + workIndex : index % 2 ? null : "missing-work",
      position: 10 + index, duration: 200, updatedAt: index % 3 ? "2026-10-03T12:00:00Z" : "bad-date"
    };
  }
  if (boundaries) {
    const shared = { id: "shared", type: "video", size: 1 };
    worksById.get("work-0").videos.push(shared);
    worksById.get("work-1").videos.push(shared);
    worksById.get("work-0").videos.push({ id: 123, type: "video", size: 1 });
    for (const id of ["shared", "123", "orphan"]) filesById.set(id, { type: "video" });
    filesById.set("image-only", { type: "image" });
    userState.progress.shared = { position: 9, duration: 100, updatedAt: "2026-10-03T12:00:00Z" };
    for (const id of ["123", "orphan", "image-only", "missing-file"]) {
      userState.progress[id] = { position: 8, duration: 100, updatedAt: "2026" };
    }
    userState.progress["trusted-direct-without-file"] = { workId: "work-2", position: NaN, duration: 0, updatedAt: "2026" };
  }
  const stateService = {
    save() { revision += 1; },
    revision: () => revision,
    normalizeFavoriteRecord: (value) => value,
    normalizeFavoriteFolderId: (value) => value || "default",
    cleanFavoriteFolderName: (value) => value || "",
    defaultFavoriteFolders: () => ({ default: { name: "Default" } })
  };
  const favorites = createFavoriteStateService({
    getLibrary: () => library, getUserState: () => userState, userStateService: stateService,
    defaultFavoriteFolderId: "default", defaultFavoriteFolderName: "Default"
  });
  const progress = factory({
    getLibrary: () => library, getUserState: () => userState, userStateService: stateService,
    publicFavoriteFolders: favorites.publicFavoriteFolders, recentWatchedDays: 7
  });
  const presenter = createWorkPresenterService({
    getLibrary: () => library, playbackProgressService: progress, favoriteStateService: favorites,
    actorProfileRow: () => null, displayPersonForWork: () => null, displayWorkTitle: (value) => String(value || ""),
    localWorkMarkers: () => [], manualCoverStateService: { manualCoverForWork: () => null },
    preferredPersonDisplayName: (_row, name) => name, publicActorProfile: () => null,
    publicCoreWorkCover: () => null, workInfoDetailRow: () => null,
    publicWorkInfoSummary: (_row, summary) => summary || null, proxiedRemoteImageUrl: (value) => value || "",
    uniqueTextArray: (values) => [...new Set(values.filter(Boolean).map(String))],
    firstPresentValue: (...values) => values.find((value) => value !== null && value !== undefined) ?? null,
    dbBoolOrNull: (value) => value == null ? null : Boolean(Number(value))
  });
  const filters = createWorkFilterService({
    favoriteStateService: favorites, playbackProgressService: progress,
    workInfoFacetRow: () => null, publicWorkAvailability: presenter.publicWorkAvailability
  });
  const sorter = createWorkSorter({
    metadataForWork: (work) => ({ ...work.infoSummary, duration: work.infoSummary.durationMinutes }),
    progressForWork: progress.getWorkProgress, displayWorkTitle: (value) => String(value || "")
  });
  const collection = createCollectionQueryService({
    getLibrary: () => library, playbackProgressService: progress, favoriteStateService: favorites,
    filterWorkList: filters.filter, sortWorkList: sorter, workFacets: filters.facets, publicWork: presenter.publicWork,
    clampInteger: (value, fallback, min, max) => Number.isFinite(Number(value)) && value !== null && value !== ""
      ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback,
    maxWorkLimit: 5_000, recentWatchedDays: 7, userStateStamp: () => String(revision), workQueryStamp: () => library.scannedAt,
    prewarmCoreWorkCovers: () => {}, prewarmRemoteImagesForWorks: () => {},
    prewarmVideoProbesForWorks: () => {}, prewarmWorkInfoDetails: () => {}
  });
  return {
    progress, collection, visits, library,
    reset() { visits.works = 0; visits.videos = 0; },
    replaceProgress() { userState = { ...userState, progress: { ...userState.progress } }; revision += 1; },
    replaceLibrary() { library = { ...library, scannedAt: "v2" }; },
    bumpRevision() {
      userState.progress["video-0"] = { workId: null, position: 12, duration: 100, updatedAt: "2026-10-04T12:00:00.000Z" };
      revision += 1;
    },
    directSave(id) { progress.saveVideoProgress(id, { position: 13, duration: 100 }); }
  };
}

function createIsolatedHistoryFixture(factory, works, progressRows, files = new Map()) {
  const visits = { works: 0 };
  class CountedWorks extends Map {
    *values() {
      for (const work of super.values()) {
        visits.works += 1;
        yield work;
      }
    }
  }
  const library = { worksById: new CountedWorks(works.map((work) => [work.id, work])), filesById: files };
  const service = factory({
    getLibrary: () => library,
    userState: { progress: progressRows, favorites: {} },
    userStateService: { revision: () => 0 },
    publicFavoriteFolders: () => []
  });
  return { service, library, visits };
}

function verifyHistoryLookupBoundaries(factory) {
  const sparse = [];
  sparse.length = 3;
  sparse[2] = { id: "sparse" };
  const work = { id: "sparse-owner", videos: sparse };
  const test = createIsolatedHistoryFixture(factory, [work], { sparse: { updatedAt: "2026" } }, new Map([["sparse", { type: "video" }]]));
  assert.equal(test.service.historyEntries()[0].work, work, "sparse-array lookup must return the original work reference");
  const touched = test.visits.works;
  assert.equal(test.service.historyEntries()[0].work, work);
  assert.equal(test.visits.works, touched, "warm history must not enumerate owners again");

  const sameError = new Error("history later-video getter");
  const videos = [{ id: "first" }];
  Object.defineProperty(videos, 1, { get() { throw sameError; } });
  const firstOwner = { id: "first-owner", videos };
  const early = createIsolatedHistoryFixture(factory, [firstOwner], { first: {} }, new Map([["first", { type: "video" }]]));
  assert.equal(early.service.historyEntries()[0].work, firstOwner, "lookup must pause before a later video in the same array");
  const throws = createIsolatedHistoryFixture(factory, [firstOwner], { first: {}, second: {} },
    new Map([["first", { type: "video" }], ["second", { type: "video" }]]));
  assert.throws(() => throws.service.historyEntries(), (error) => error === sameError, "a reached getter must retain its error object");
  const laterWork = { id: "later", get videos() { throw sameError; } };
  const prefix = createIsolatedHistoryFixture(factory, [firstOwner, laterWork], { first: {} }, new Map([["first", { type: "video" }]]));
  assert.equal(prefix.service.historyEntries()[0].work, firstOwner, "lookup must not touch an unrelated later work");

  const trusted = { id: "trusted", get videos() { throw sameError; } };
  const direct = createIsolatedHistoryFixture(factory, [trusted], {
    missing: { workId: "trusted" }, image: { workId: "trusted" }
  }, new Map([["image", { type: "image" }]]));
  assert.equal(direct.service.historyEntries()[0].work, trusted, "a valid work ID must win before file existence and type checks");
  assert.equal(direct.visits.works, 0, "valid work IDs must not enumerate videos");
  const gated = createIsolatedHistoryFixture(factory, [laterWork], { missing: {}, image: {} }, new Map([["image", { type: "image" }]]));
  assert.deepEqual(gated.service.historyEntries(), []);
  assert.equal(gated.visits.works, 0, "missing and non-video files must not start an owner scan");

  const numeric = { id: "numeric", videos: [{ id: 123 }, { id: new String("boxed") }, { id: undefined }, { id: null }, { id: false }] };
  const sharedFirst = { id: "shared-first", videos: [{ id: "shared" }] };
  const sharedLast = { id: "shared-last", videos: [{ id: "shared" }] };
  const rows = Object.fromEntries(["123", "boxed", "undefined", "null", "false", "orphan", "shared"].map((id) => [id, {}]));
  const files = new Map(Object.keys(rows).map((id) => [id, { type: "video" }]));
  const owners = createIsolatedHistoryFixture(factory, [numeric, sharedFirst, sharedLast], rows, files);
  assert.deepEqual(owners.service.historyEntries().map((entry) => entry.work), [sharedFirst],
    "string progress keys must use strict video ID equality, exclude orphans, and retain the first owner");

  const tieOwner = { id: "tie-owner", videos: [{ id: "tie-a" }, { id: "tie-b" }] };
  const invalidOwner = { id: "invalid-owner", videos: [{ id: "invalid" }] };
  const ties = createIsolatedHistoryFixture(factory, [tieOwner, invalidOwner], {
    "tie-a": { updatedAt: "2026-10-03T00:00:00Z" },
    "tie-b": { updatedAt: "2026-10-03T00:00:00.000Z" },
    invalid: { updatedAt: "bad-date" }
  }, new Map([["tie-a", { type: "video" }], ["tie-b", { type: "video" }], ["invalid", { type: "video" }]]));
  assert.equal(ties.service.historyEntries()[0].updatedAt, "2026-10-03T00:00:00Z", "equal parsed timestamps must keep the first progress row");
  assert.equal(ties.service.historyEntries()[1].updatedTime, 0, "invalid dates must retain the zero-time fallback");

  for (const videos of [{}, { length: NaN }]) {
    const malformed = createIsolatedHistoryFixture(factory, [{ id: "malformed", videos }], { video: {} }, new Map([["video", { type: "video" }]]));
    assert.throws(() => malformed.service.historyEntries(), TypeError, "non-array video collections must fail instead of stalling the scan");
  }
  const customError = new Error("history custom some failure");
  const custom = createIsolatedHistoryFixture(factory, [{ id: "custom", videos: { some() { throw customError; } } }],
    { video: {} }, new Map([["video", { type: "video" }]]));
  assert.throws(() => custom.service.historyEntries(), (error) => error === customError, "custom some must retain the original error object");
  const customOwner = { id: "custom-owner", videos: { some(predicate) { return predicate({ id: "later-custom" }); } } };
  const standardOwner = { id: "standard-owner", videos: [{ id: "standard" }] };
  const customMatch = createIsolatedHistoryFixture(factory, [customOwner, standardOwner], { standard: {}, "later-custom": {} },
    new Map([["standard", { type: "video" }], ["later-custom", { type: "video" }]]));
  assert.deepEqual(customMatch.service.historyEntries().map((entry) => entry.work), [standardOwner, customOwner],
    "custom non-array some must preserve its matches for later progress keys");
}

async function verifyHistoryOwnerLookup() {
  const oldFactory = await legacyHistoryProgressFactory();
  const candidateFactory = process.argv.includes("--legacy-history-owner-scan") ? oldFactory : createPlaybackProgressService;
  // Full response bytes include saveVideoProgress's timestamp; control the clock
  // only for this synthetic scenario, and restore it before the HTTP budget tests.
  const originalNow = Date.now;
  const originalIso = Date.prototype.toISOString;
  Date.now = () => Date.parse("2026-10-04T12:00:00Z");
  Date.prototype.toISOString = () => "2026-10-04T12:00:00.000Z";
  let oracles = 0;
  let baselineVisits;
  let candidateVisits;
  try {
    const configs = [
      { count: LOCAL_WORK_COUNT, fallback: 125 },
      { count: LOCAL_WORK_COUNT, fallback: 1, early: true },
      { count: LOCAL_WORK_COUNT, fallback: 125, allDirect: true },
      { count: 16, fallback: 4, boundaries: true }
    ];
    for (const config of configs) {
      const before = createHistoryFixture(oldFactory, config);
      const after = createHistoryFixture(candidateFactory, config);
      const metrics = [];
      for (const fixture of [before, after]) {
        fixture.reset();
        const entries = fixture.progress.historyEntries();
        metrics.push({ ...fixture.visits, entries: entries.length });
        for (const entry of entries) assert.equal(entry.work, fixture.library.worksById.get(entry.work.id), "history must retain library work references");
        fixture.reset();
        fixture.progress.historyEntries();
        assert.equal(fixture.visits.works, 0, "warm history must reuse its completed owner lookup");
        assert.equal(fixture.visits.videos, 0, "warm history must not read videos");
      }
      if (config.early) {
        assert.equal(metrics[1].works, 1, "a first-video hit must visit only its first work");
        assert.equal(metrics[1].videos, 1, "a first-video hit must read only its first video");
      } else if (config.allDirect) {
        assert.equal(metrics[1].works, 0, "valid work IDs must avoid owner enumeration");
        assert.equal(metrics[1].videos, 0, "valid work IDs must avoid video reads");
      } else if (config.count === LOCAL_WORK_COUNT) {
        baselineVisits = metrics[0];
        candidateVisits = metrics[1];
        assert.equal(metrics[0].works, 2_492_250, "the actual legacy service must exhibit repeated late-owner scans");
        assert.equal(metrics[0].videos, 4_984_375);
        assert.equal(metrics[1].works, LOCAL_WORK_COUNT, "history fallback owner visits must stay within one directory pass");
        assert.equal(metrics[1].videos, LOCAL_WORK_COUNT * 2 - 1, "history fallback must stop at the last needed video");
      }
      assert.equal(JSON.stringify(after.progress.historyEntries()), JSON.stringify(before.progress.historyEntries()), "cold history entries must preserve complete legacy JSON");
      oracles += 1;
      for (const sort of ["", "title", "progress", "ratingDesc"]) {
        for (const filter of ["all", "progress", "highRating"]) {
          for (const offset of [0, 3, 999]) {
            const url = new URL("http://fixture/api/history?days=all&limit=7&offset=" + offset + "&sort=" + sort + "&filter=" + filter);
            assert.equal(JSON.stringify(after.collection.historyPayload(url)), JSON.stringify(before.collection.historyPayload(url)),
              "history payload must preserve complete legacy JSON for " + url.search);
            oracles += 1;
          }
        }
      }
      for (const change of ["replaceProgress", "replaceLibrary", "bumpRevision", "directSave"]) {
        if (change === "directSave") {
          before.directSave("video-0");
          after.directSave("video-0");
          assert.equal(after.progress.getVideoProgress("video-0").workId, null, "saving without workId must keep the supported fallback path");
        } else {
          before[change]();
          after[change]();
        }
        const url = new URL("http://fixture/api/history?days=7&sort=progress&limit=48");
        assert.equal(JSON.stringify(after.collection.historyPayload(url)), JSON.stringify(before.collection.historyPayload(url)),
          "history cache invalidation must preserve complete JSON after " + change);
        oracles += 1;
      }
      if (config.boundaries) {
        const entries = after.progress.historyEntries();
        assert(entries.some((entry) => entry.work.id === "work-2"), "valid work IDs survive missing files and invalid playback values");
        assert(entries.some((entry) => entry.work.id === "work-0"), "a shared video keeps its first owner");
      }
    }
    verifyHistoryLookupBoundaries(oldFactory);
    verifyHistoryLookupBoundaries(candidateFactory);
  } finally {
    Date.now = originalNow;
    Date.prototype.toISOString = originalIso;
  }
  console.log("works-history-owner-lookup: complete-json-oracles=" + oracles
    + ", legacy-work-visits=" + baselineVisits.works + ", current-work-visits=" + candidateVisits.works
    + ", legacy-video-reads=" + baselineVisits.videos + ", current-video-reads=" + candidateVisits.videos);
}

// Restore the complete pre-optimization functions in the actual source factories.
const LEGACY_PERSON_LIST_FROM_WORKS = String.raw`  function listFromWorksPayload(sourceWorks, url, extra = {}, options = {}) {
    const filter = extra.filter || url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const matchesFilter = options.lightweightInfo ? lightweightWorkMatchesFilter : workMatchesFilter;
    const visibleWorks = workClassificationService.filterForRequest(sourceWorks, url, filter);
    const filters = requestedFilters(filter);
    const matchedWorks = filters.length
      ? visibleWorks.filter((work) => filters.every((item) => matchesFilter(work, item)))
      : visibleWorks;
    const works = sortWorkList(matchedWorks, sort, options);
    return pagedWorksPayload(works, url, {
      ...extra,
      filter,
      facets: extra.facets || workFacets(sourceWorks)
    }, options);
  }
`;
const LEGACY_PERSON_DETAIL = String.raw`  function detailPayload(personId, url) {
    const startedAt = performance.now();
    const timings = {};
    const mark = (name) => {
      timings[name] = Math.round(performance.now() - startedAt);
    };
    const scope = peopleScopeService.normalize(url.searchParams.get("scope"));
    const source = cachedDetailSource(personId, scope, timings, mark);
    if (!source) return null;
    mark("source");

    const pageCacheKey = detailPageCacheKey(url);
    let worksPayload = readCachedPage(source, pageCacheKey);
    if (worksPayload) {
      timings.pageCacheHit = true;
      mark("facets");
      mark("payload");
    } else {
      const filter = url.searchParams.get("filter") || "all";
      const year = normalizePersonWorkYear(url.searchParams.get("year"));
      const yearWorks = worksForPersonYear(source.works, year);
      const facets = workQueryService.lightweightFacets(yearWorks);
      mark("facets");
      worksPayload = workQueryService.listFromWorksPayload(yearWorks, url, {
        filter,
        facets
      }, { lightweightInfo: true, includeCoreCovers: scope === "western" });
      cachePage(source, pageCacheKey, worksPayload);
      mark("payload");
    }
    if (!source.person) source.person = publicPerson(source.personSource, source.personOptions);
    mark("publicPerson");
    if (timings.payload >= 500) {
      console.warn("[fanhao-person-detail-slow]", JSON.stringify({ personId: source.personId, count: source.works.length, ...timings }));
    }
    const payload = {
      person: source.person,
      filmographyCount: source.works.length,
      year: normalizePersonWorkYear(url.searchParams.get("year")),
      years: source.years,
      ...worksPayload
    };
    if (url.searchParams.get("timing") === "1") payload.timings = timings;
    return payload;
  }
`;
const LEGACY_PERSON_PAGE_KEY = String.raw`  function detailPageCacheKey(url) {
    return [
      userStateStamp(),
      workQueryService.visibilityStamp(),
      url.searchParams.get("filter") || "all",
      normalizePersonWorkYear(url.searchParams.get("year")),
      url.searchParams.get("includeMissingLocal") || "",
      url.searchParams.get("includeCompilation") || "",
      url.searchParams.get("sort") || "releaseDesc",
      url.searchParams.get("limit") || "",
      url.searchParams.get("offset") || "0"
    ].join(":");
  }
`;


function personSourceFactories(legacy = false, observeBudget = () => {}) {
  function restore(source, name, next, body) {
    const start = source.indexOf("  function " + name + "(");
    const end = source.indexOf("\n  function " + next + "(", start);
    assert(start >= 0 && end > start, "person source oracle must restore the complete " + name + " function");
    return source.slice(0, start) + body + source.slice(end);
  }
  let querySource = readFileSync(new URL("../src/modules/fanhao/server/works/work-query-service.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  let personSource = readFileSync(new URL("../src/modules/fanhao/server/people/person-detail-service.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  if (legacy) {
    querySource = restore(querySource, "listFromWorksPayload", "listPayload", LEGACY_PERSON_LIST_FROM_WORKS);
    personSource = restore(personSource, "detailPayload", "cachedDetailSource", LEGACY_PERSON_DETAIL);
    personSource = restore(personSource, "detailPageCacheKey", "readCachedPage", LEGACY_PERSON_PAGE_KEY);
    personSource = personSource.replace("      filterCache: new Map(),\n", "");
  }
  const query = new Function("classifyWorkCategory", "normalizeWorkCategory", "summarizeWorkCategories", "WORK_CATEGORY_OPTIONS",
    "createWorkSorter", "createWeightedCacheBudget", "normalizeWorkSortMode",
    "deriveWorkTraits", "matchesWorkTraitFilter", "summarizeWorkTraits",
    querySource.replace(/^import .*;\n/gm, "").replace("export function createWorkQueryService", "function createWorkQueryService")
      + "\nreturn createWorkQueryService;")(
    classifyWorkCategory, normalizeWorkCategory, summarizeWorkCategories, WORK_CATEGORY_OPTIONS, createWorkSorter,
    (...args) => {
      const budget = createWeightedCacheBudget(...args);
      if (args[0] === 4_000_000) observeBudget(budget);
      return budget;
    }, normalizeWorkSortMode, deriveWorkTraits, matchesWorkTraitFilter, summarizeWorkTraits);
  const person = new Function("normalizePersonWorkYear", "personWorkYearOptions", "worksForPersonYear", "createWeightedCacheBudget",
    personSource.replace(/^import .*;\n/gm, "").replace(/export function /g, "function ") + "\nreturn createPersonDetailService;")(
    normalizePersonWorkYear, personWorkYearOptions, worksForPersonYear, createWeightedCacheBudget);
  return { query, person };
}

function createPersonSourceFixture(factories, { count = 120, missingCount = Math.floor(count / 10), imageOwner = false, ties = false } = {}) {
  const reads = { classification: 0, sort: 0, title: 0, favorite: 0, progress: 0, publicWork: 0, prewarm: 0 };
  const events = [];
  const state = { user: "alice:1", revision: "work:1", visibility: 1, images: 1, held: null, fault: "", coverWrites: false, metadataWrite: false };
  const works = Array.from({ length: count }, (_, index) => ({
    id: String(index + 1), personId: "person-fixture", personName: "合成人物",
    title: ties ? "Complete tie" : "Fixture " + String(index * 173 % Math.max(1, count)).padStart(5, "0"),
    directoryName: "Fixture " + index, relativePath: "fixture/main/" + index,
    modifiedAt: ties ? "" : "2026-01-" + String(index % 28 + 1).padStart(2, "0"),
    videos: [{ id: "video-" + index, size: index % 100, relativePath: "fixture/main/video.mp4" }], images: [], infos: [],
    videoCount: 1, playableCount: index % 3 ? 1 : 0, imageCount: 0, infoCount: index % 3, coverId: null,
    infoSummary: {
      code: index % 11 ? "ABC-" + index : "FC2-PPV-" + index,
      releaseDate: ties || index % 9 === 0 ? "" : String(2020 + index % 5) + "-01-" + String(index % 28 + 1).padStart(2, "0"),
      rating: ties ? null : [null, "", "bad", 0, "4.2", 5][index % 6],
      ratingCount: ties ? 0 : index % 27, durationMinutes: ties ? 0 : index % 200, hasMagnet: Boolean(index % 2), javdbTags: []
    }
  }));
  const missing = Array.from({ length: missingCount }, (_, index) => ({
    ...works[index % works.length], id: "missing-" + index, personId: "person-fixture", personName: "合成人物",
    title: "Missing " + index, directoryName: "COMP-" + index, relativePath: "", videos: [], images: [], infos: [],
    videoCount: 0, playableCount: 0, imageCount: 0, infoCount: 0, coverId: null, missingLocal: true,
    infoSummary: { code: index % 5 ? "ABC-" + index : "COMP-" + index, releaseDate: "2023-01-01", rating: 4.2, ratingCount: 2, hasMagnet: true }
  }));
  const record = { id: "person-fixture", name: "合成人物", works: works.map((work) => work.id), relativePath: "fixture/main", sourcePaths: [], sourceCount: 1 };
  const library = { scannedAt: "synthetic-scan", worksById: new Map(works.map((work) => [work.id, work])), peopleById: new Map([[record.id, record]]) };
  const favoriteStateService = {
    isFavoriteWork(id) { reads.favorite++; return Number.parseInt(id, 10) % 7 === (state.user.startsWith("alice") ? 1 : 2); },
    publicFavoriteForWork(id) {
      return Number.parseInt(id, 10) % 7 === (state.user.startsWith("alice") ? 1 : 2) ? { folderId: "fixture", folderName: state.user } : null;
    }
  };
  const playbackProgressService = {
    getWorkProgress(work) {
      reads.progress++;
      return Number.parseInt(work.id, 10) % 11 === (state.user.startsWith("alice") ? 1 : 2) ? { updatedAt: "2026-10-01", positionMs: 123 } : null;
    },
    getVideoProgress: () => null
  };
  const classification = createWorkClassificationService({ appConfigService: { current: () => ({
    compilationPrefixes: state.visibility % 2 ? ["COMP"] : ["ABC"], compilationKeywords: ["Anthology"]
  }) } });
  const classify = classification.filterForRequest;
  classification.filterForRequest = (values, ...args) => {
    events.push("classify"); reads.classification += values.length;
    if (state.fault === "classify") throw state.held;
    return classify(values, ...args);
  };
  let db = null, images = null;
  if (imageOwner) {
    db = new DatabaseSync(":memory:");
    db.exec("ATTACH DATABASE ':memory:' AS fanhao_images; CREATE TABLE local_works(work_id INTEGER);"
      + "CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY, owner_type TEXT, owner_id INTEGER, kind TEXT, remote_url TEXT,"
      + "local_path TEXT, source TEXT, updated_at TEXT, image_blob BLOB, sort_order INTEGER);");
    const local = db.prepare("INSERT INTO local_works VALUES (?)");
    const image = db.prepare("INSERT INTO fanhao_images.images VALUES (?, 'work', ?, 'cover', ?, NULL, 'fixture', '2026-01-01', NULL, 0)");
    for (let index = 1; index <= count; index++) {
      local.run(index); image.run(index, index, "https://fixture.invalid/cover/" + index + ".jpg");
    }
    images = createWorkImageService({
      getCoreDb: () => db, getPersonById: (id) => library.peopleById.get(id), getWorkById: (id) => library.worksById.get(id),
      getStamp: () => String(state.images), hasCoreDb: () => true, proxiedRemoteImageUrl: (value) => value || ""
    });
  }
  const presenter = createWorkPresenterService({
    getLibrary: () => library, actorProfileRow: () => null, displayPersonForWork: (id) => library.peopleById.get(id),
    displayWorkTitle: (value) => String(value || ""), favoriteStateService, playbackProgressService,
    firstPresentValue: (...values) => values.find((value) => value != null) ?? null,
    dbBoolOrNull: (value) => value == null ? null : Boolean(value), localWorkMarkers: () => [],
    manualCoverStateService: { manualCoverForWork: () => null }, publicActorProfile: () => null,
    publicActorProfileSnapshot: () => ({ profile: null, avatar: null }), publicCoreWorkCover: images?.publicCoreWorkCover || (() => null),
    publicWorkInfoSummary: (_row, summary) => summary, uniqueTextArray: (values) => [...new Set(values)],
    isGPerson: () => false, isCompilationWork: classification.isCompilation, workInfoDetailRow: () => null,
    proxiedRemoteImageUrl: (value) => value || ""
  });
  const deps = {
    library, actorMovieStamp: () => "actor-fixture", workQueryStamp: () => state.revision,
    peoplePayloadStamp: () => state.revision, userStateStamp: () => state.user,
    clampInteger: (value, fallback, min, max) => value == null || String(value).trim() === "" ? fallback : Math.max(min, Math.min(max, Math.floor(Number(value) || 0))),
    defaultWorkLimit: 48, maxWorkLimit: 16000, favoriteStateService, playbackProgressService,
    peopleScopeService: { normalize: (value) => value === "western" ? "western" : "main", personMatches: () => true, workMatches: () => true },
    workClassificationService: classification, isVrWork: (work) => Number(work.id) % 5 === 0,
    workHasCoreCover: images?.workHasCoreCover || (() => false), workHasLocalMarker: (work) => Number(work.id) % 13 === 0,
    workInfoFacetRow: () => null, publicWorkAvailability: presenter.publicWorkAvailability,
    publicWork(...args) {
      events.push("present"); reads.publicWork++;
      if (state.fault === "present") throw state.held;
      return presenter.publicWork(...args);
    },
    publicPerson: presenter.publicPerson, prewarmRemoteImagesForWorks: () => {},
    displayWorkTitle(value) {
      events.push("title"); reads.title++;
      if (state.fault === "title") throw state.held;
      return String(value || "");
    },
    prewarmCoreWorkCovers(batch) {
      events.push("prewarm"); reads.prewarm += batch.length;
      images?.prewarmCoreWorkCovers(batch);
      if (state.coverWrites) for (const work of batch) work.cachedCover = { coverUrl: "https://fixture.invalid/cached/" + work.id };
      if (state.metadataWrite && works[0]) {
        Object.assign(works[0].infoSummary, { releaseDate: "2029-01-01", rating: 5, ratingCount: 10000 });
        state.revision += ":metadata"; state.metadataWrite = false;
      }
      if (state.fault === "prewarm") throw state.held;
    },
    recordPerformanceSpan(label) { if (label === "sort") reads.sort++; }
  };
  const query = factories.query(deps);
  const detail = factories.person({
    ...deps, workQueryService: query, actorProfileMergeCandidates: () => [], adminCoreMutationService: {},
    coreMissingWorksForPerson: () => missing, corePersonFallbackRecord: () => null,
    dedupeWorksForDisplay: (values) => [...new Map(values.map((work) => [work.id, work])).values()],
    enrichLocalWorksWithActorMovieInfo: (values) => values, manualCoverStateService: {}, maxActorAvatarBytes: 1024,
    mergedActorMovieRows: () => [], mergedPersonRecord: (person) => person, missingActorWorksForPerson: () => [],
    publicActorProfile: () => null, resolveLibraryPersonByPublicId: (id) => id === record.id ? record : null,
    storedWorkCodeKey: (value) => String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(),
    workLocalMutationService: {}, workCodeKeySetForWorks: () => new Set()
  });
  return { query, detail, state, works, missing, reads, events, library, close: () => db?.close() };
}

function verifyPersonSourcePaging() {
  const baselineFactories = personSourceFactories(true);
  const selectedFactories = personSourceFactories(process.argv.includes("--legacy-person-source"));
  let oracles = 0;
  function compare(before, after, params = {}) {
    const url = new URL("http://fixture.invalid/api/people/person-fixture?" + new URLSearchParams({ limit: "48", sort: "releaseDesc", ...params }));
    const baseline = before.detail.detailPayload("person-fixture", url);
    const current = after.detail.detailPayload("person-fixture", url);
    assert.equal(JSON.stringify(current), JSON.stringify(baseline), "complete person response differs for " + url.search);
    assert.equal(current?.timings, undefined, "the full oracle uses normal timing-off requests");
    oracles++; return current;
  }
  for (const config of [{ count: 0 }, { count: 1 }, { count: 29, ties: true }, { count: 180 }]) {
    const before = createPersonSourceFixture(baselineFactories, config), after = createPersonSourceFixture(selectedFactories, config);
    try {
      for (const year of ["all", "2023", "unknown", "invalid"])
        for (const filter of ["all", "rated", "highRating,playable", "favorite", "progress", "missingLocal", "unexpected"])
          for (const offset of ["0", "48"])
            compare(before, after, { year, filter, offset, includeCompilation: "0", includeMissingLocal: "0" });
      for (const sort of ["title", "videos", "progress", "ratingAsc", "ratingDesc", "size", "sizeAsc", "duration", "durationAsc", "codeAsc", "codeDesc", "unknown"])
        compare(before, after, { sort, offset: "12" });
      for (const user of ["bob:1", "alice:1"]) {
        before.state.user = after.state.user = user;
        for (const filter of ["all", "favorite", "progress"]) compare(before, after, { filter, offset: "12" });
      }
      for (const visibility of [2, 1]) {
        before.state.visibility = after.state.visibility = visibility;
        compare(before, after, { includeCompilation: "0", includeMissingLocal: "1", offset: "12" });
      }
      before.state.revision = after.state.revision = "work:2";
      for (const fixture of [before, after]) if (fixture.works[0]) {
        fixture.works[0].title = "Updated fixture";
        fixture.works[0].infoSummary = { releaseDate: "2029-01-01", rating: 5, ratingCount: 10000, code: "UPD-1" };
      }
      compare(before, after, { sort: "ratingDesc" }); compare(before, after, { year: "2029" });
      assert.equal(after.detail.detailPayload("unknown-person", new URL("http://fixture.invalid/")), null);
      for (const params of [{}, { filter: "rated" }, { includeCompilation: "0" }, { sort: "progress" }, { sort: "unknown" }]) {
        const url = new URL("http://fixture.invalid/?" + new URLSearchParams({ limit: "48", ...params }));
        assert.equal(JSON.stringify(after.query.listFromWorksPayload(after.works, url)),
          JSON.stringify(before.query.listFromWorksPayload(before.works, url)), "callers without a person context keep the complete old response");
        oracles++;
      }
    } finally { before.close(); after.close(); }
  }
  // Missing flags default to true; an explicitly empty or non-1 value means
  // false. Distinct offsets expose filter-source collisions without changing
  // the pre-existing page-key behavior for otherwise identical requests.
  for (const flag of ["includeMissingLocal", "includeCompilation"]) {
    for (const values of [[null, "", "0", "true", "1", null], ["", null, "2", "1", "false", "unexpected"]]) {
      const before = createPersonSourceFixture(baselineFactories, { count: 60, missingCount: 60 });
      const after = createPersonSourceFixture(selectedFactories, { count: 60, missingCount: 60 });
      for (const [index, value] of values.entries()) {
        const params = { limit: "12", offset: String(index * 12) };
        if (value !== null) params[flag] = value;
        const result = compare(before, after, params);
        assert.equal(result.total, value === null || value === "1" ? 120 : 60,
          flag + " must preserve absent/empty/non-1 requestFlag semantics across offsets");
      }
    }
  }
  for (const config of [{ count: 75, missingCount: 0, imageOwner: true }, { count: 75, missingCount: 75 }]) {
    const before = createPersonSourceFixture(baselineFactories, config), after = createPersonSourceFixture(selectedFactories, config);
    try {
      const rawBefore = JSON.stringify(before.works), rawAfter = JSON.stringify(after.works);
      const params = { scope: config.imageOwner ? "western" : "main", limit: "12", year: "2023", offset: "0" };
      compare(before, after, params); compare(before, after, { ...params, offset: "12" });
      if (config.imageOwner) {
        assert.equal(JSON.stringify(before.works), rawBefore, "actual image prewarming does not rewrite year/classification metadata");
        assert.equal(JSON.stringify(after.works), rawAfter);
      }
      before.state.coverWrites = after.state.coverWrites = true;
      compare(before, after, { ...params, year: "all", offset: "24" });
      compare(before, after, { ...params, year: "all", offset: "36", includeCompilation: "0" });
      before.state.metadataWrite = after.state.metadataWrite = true;
      compare(before, after, { ...params, year: "all", offset: "48" });
      compare(before, after, { ...params, year: "2029", offset: "0" });
    } finally { before.close(); after.close(); }
  }
  for (const fault of ["classify", "title", "prewarm", "present"]) {
    const before = createPersonSourceFixture(baselineFactories), after = createPersonSourceFixture(selectedFactories);
    const held = new Error("person source fixture " + fault);
    for (const fixture of [before, after]) { fixture.state.fault = fault; fixture.state.held = held; }
    const url = new URL("http://fixture.invalid/?scope=western&sort=title&limit=12");
    assert.throws(() => before.detail.detailPayload("person-fixture", url), (error) => error === held);
    assert.throws(() => after.detail.detailPayload("person-fixture", url), (error) => error === held);
    assert.deepEqual(after.events, before.events, "cold failures preserve classification/title/prewarm/presentation order");
    const classifications = after.reads.classification;
    before.state.fault = after.state.fault = "";
    compare(before, after, { scope: "western", sort: "title", limit: "12" });
    assert.equal(after.reads.classification - classifications, 120, "failed pages must not admit a person filter selection");

    const plainBefore = createPersonSourceFixture(baselineFactories), plainAfter = createPersonSourceFixture(selectedFactories);
    for (const fixture of [plainBefore, plainAfter]) { fixture.state.fault = fault; fixture.state.held = held; }
    for (const fixture of [plainBefore, plainAfter]) {
      assert.throws(() => fixture.query.listFromWorksPayload(fixture.works, url, { facets: {} },
        { lightweightInfo: true, includeCoreCovers: true }), (error) => error === held);
    }
    assert.deepEqual(plainAfter.events, plainBefore.events, "callers without context retain cold error and lazy read order");
  }
  // Every semantic oracle runs before the stable work budget, so the negative
  // control must preserve old DTOs and fail specifically on repeated work.
  const before = createPersonSourceFixture(baselineFactories, { count: LOCAL_WORK_COUNT });
  const after = createPersonSourceFixture(selectedFactories, { count: LOCAL_WORK_COUNT });
  for (let page = 0; page < 16; page++) compare(before, after, { offset: String(page * 48) });
  assert.equal(before.reads.classification, 22_000 * 16, "the complete old factory demonstrates one full classification per page");
  assert.equal(before.reads.sort, 16);
  assert.equal(before.reads.title, 22_000 * 16);
  assert.equal(after.reads.favorite, before.reads.favorite, "dynamic favorite facets still read every source on each page");
  assert.equal(after.reads.progress, before.reads.progress, "dynamic progress facets and presenter reads remain live");
  assert.equal(after.reads.publicWork, before.reads.publicWork, "page presentation and prewarming remain page sized");
  console.log("works-person-source: complete-json-oracles=" + oracles + ", legacy-classification=" + before.reads.classification
    + ", selected-classification=" + after.reads.classification + ", legacy-sorts=" + before.reads.sort + ", selected-sorts=" + after.reads.sort
    + ", legacy-title-reads=" + before.reads.title + ", selected-title-reads=" + after.reads.title);
  assert.equal(after.reads.classification, 22_000, "person paging must reuse one successful bounded classification source");
  assert.equal(after.reads.sort, 1, "person paging must reuse its existing sorted source identity");
  assert.equal(after.reads.title, 22_000, "display title preparation stays within one complete source pass");
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
  verifyPersonSourcePaging();
  await verifyHistoryOwnerLookup();
  verifySemanticEquivalence();
  verifyDirectAndLegacyCandidateCompetition();
  verifyInvalidationAndStaleFallback();
  await verifyProductionShapeAndHttpGate();
  console.log("works cold-path performance verification passed");
}

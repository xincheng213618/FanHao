import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createActorMovieService } from "../src/modules/fanhao/server/people/actor-movie-service.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createFanhaoDependencies } from "../src/modules/fanhao/server/composition.js";

// Actual private SQLite metadata and the production provider/composition/query
// path. Discarding only the optional result reader restores the old opaque
// array boundary while leaving row selection, fallback DTOs and budgets intact.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-poison"));
const legacy = process.argv.includes("--legacy-poison");
const databases = [], warnings = [], warn = console.warn;
let comparisons = 0, fallbackComparisons = 0;
console.warn = (...args) => warnings.push(args);
try {
  for (const phase of ["prepare", "all"]) for (const kind of ["narrow", "legacy"]) {
    const actual = fixture(), expected = fixture();
    const urls = variants();
    const previous = urls.map(url => actual.query.listPayload(url));
    update(actual); update(expected);
    actual.state.failure = { phase, kind };
    for (let index = 0; index < urls.length; index++) {
      equal(actual.query.listPayload(urls[index]), previous[index], "complete old DTO remains the SQL-failure fallback", true);
    }
    const before = { ...actual.state.counts };
    actual.state.failure = null;
    for (const url of urls) equal(actual.query.listPayload(url), expected.query.listPayload(url),
      "actor local-info cache recovery: same-stamp list/filter/category/sort must retry the failed fallback");
    assert.ok(actual.state.counts.narrow > before.narrow, "a recovered list actually retries its primary metadata SQL");
    const calls = { ...actual.state.counts };
    const cached = actual.query.listPayload(urls[0]);
    assert.equal(actual.query.listPayload(urls[0]), cached, "successful normal pages still retain their identity");
    assert.deepEqual(actual.state.counts, calls);
  }

  // The result reader retains the exact old array interface. A stale complete
  // result is usable for this response, but may not become a successful cache.
  const direct = fixture(), arrayOnly = fixture({ connectResult: false });
  const works = direct.actor.enrichLocalWorksWithIndexResult(direct.state.works);
  equal(works.works, arrayOnly.actor.enrichLocalWorksWithIndex(arrayOnly.state.works), "complete success array API is unchanged");
  assert.equal(works.cacheable, true);
  update(direct); update(arrayOnly);
  for (const owner of [direct, arrayOnly]) owner.state.failure = { phase: "all", kind: "narrow" };
  const stale = direct.actor.enrichLocalWorksWithIndexResult(direct.state.works);
  equal(stale.works, arrayOnly.actor.enrichLocalWorksWithIndex(arrayOnly.state.works), "complete previous metadata fallback bytes are unchanged", true);
  assert.equal(stale.cacheable, false);
  direct.state.failure = null;
  assert.equal(direct.actor.enrichLocalWorksWithIndexResult(direct.state.works).cacheable, true);

  for (const phase of ["prepare", "all"]) for (const kind of ["narrow", "legacy"]) {
    const actual = fixture(), expected = fixture();
    actual.state.failure = { phase, kind };
    const error = errorFrom(() => actual.query.listPayload(variants()[0]));
    assert.equal(error.message, `controlled ${kind} ${phase} failure`, "no complete stale map still throws its original read error");
    assert.equal(error.code, "SQLITE_BUSY");
    actual.state.failure = null;
    equal(actual.query.listPayload(variants()[0]), expected.query.listPayload(variants()[0]), "cold throwing metadata errors remain retryable");
  }

  // A later failed batch must discard successful new rows too. The old map
  // supplies every requested code, and recovery must refresh the complete DTO.
  const many = fixture({ count: 905 }), manyExpected = fixture({ count: 905 });
  const manyUrl = url({ limit: "1000", sort: "title" });
  const beforeBatch = many.query.listPayload(manyUrl);
  update(many); update(manyExpected);
  many.state.failure = { phase: "all", kind: "narrow", at: many.state.counts.narrow + 2 };
  equal(many.query.listPayload(manyUrl), beforeBatch, "failed second metadata batch preserves the complete old map", true);
  many.state.failure = null;
  equal(many.query.listPayload(manyUrl), manyExpected.query.listPayload(manyUrl), "second-batch fallback cannot occupy list caches");

  for (const kind of ["narrow", "legacy"]) {
    const actual = fixture(), expected = fixture();
    const previous = actual.query.listPayload(variants()[0]);
    update(actual); update(expected);
    actual.state.failure = { phase: "all", kind };
    equal(actual.query.prewarmLocalMetadata(), previous.works, "failed metadata prewarm keeps its old public array result", true);
    actual.query.prewarm(); // The injected scheduler records no real timers or services.
    actual.state.failure = null;
    for (const request of variants()) equal(actual.query.listPayload(request), expected.query.listPayload(request),
      "failed prewarm may not populate enriched/category/filter/page caches");
  }

  const scoped = fixture(), scopedExpected = fixture();
  scoped.query.prewarm();
  assert.deepEqual(scoped.state.counts, { narrow: 1, legacy: 1 }, "successful prewarm reads metadata once");
  scoped.query.prewarm();
  assert.deepEqual(scoped.state.counts, { narrow: 1, legacy: 1 }, "repeated successful prewarm reads no new metadata SQL");
  update(scoped); update(scopedExpected); scoped.state.failure = { phase: "all", kind: "narrow" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = scoped.state.counts.narrow;
    scoped.query.prewarm();
    assert.equal(scoped.state.counts.narrow - before, 1, "each failed warm prewarm performs one metadata SQL attempt, formerly eighteen");
  }
  const beforeRequest = scoped.state.counts.narrow;
  scoped.query.listPayload(variants()[0]);
  assert.equal(scoped.state.counts.narrow - beforeRequest, 1, "the next independent request retries outside the released prewarm scope");
  scoped.state.failure = null;
  equal(scoped.query.listPayload(variants()[0]), scopedExpected.query.listPayload(variants()[0]), "the request after a failed scoped prewarm fully recovers");

  const scopedError = fixture(), errorExpected = fixture();
  scopedError.query.prewarmLocalMetadata(); update(scopedError); update(errorExpected);
  scopedError.state.failure = { phase: "all", kind: "narrow" };
  const sentinel = new Error("controlled prewarm body failure");
  scopedError.state.onPrewarm = () => { throw sentinel; };
  assert.throws(() => scopedError.query.prewarm(), error => error === sentinel);
  scopedError.state.onPrewarm = null; scopedError.state.failure = null;
  equal(scopedError.query.listPayload(variants()[0]), errorExpected.query.listPayload(variants()[0]),
    "a throwing prewarm releases its temporary failed result in finally");
  const coldPrewarm = fixture(); coldPrewarm.state.failure = { phase: "all", kind: "narrow" };
  assert.equal(errorFrom(() => coldPrewarm.query.prewarm()).code, "SQLITE_BUSY");
  coldPrewarm.state.failure = null;
  equal(coldPrewarm.query.listPayload(variants()[0]), fixture().query.listPayload(variants()[0]), "cold prewarm errors retain throw and release scope");
  const nested = fixture(); nested.query.prewarmLocalMetadata(); update(nested);
  nested.state.failure = { phase: "all", kind: "narrow" };
  let nesting = false;
  nested.state.onPrewarm = () => { if (!nesting) { nesting = true; nested.query.prewarm(); } };
  const beforeNested = nested.state.counts.narrow;
  nested.query.prewarm();
  assert.equal(nested.state.counts.narrow - beforeNested, 2, "nested synchronous prewarms each read once and restore the outer scope");
  nested.state.onPrewarm = null; nested.state.failure = null;
  const nestedExpected = fixture(); update(nestedExpected);
  equal(nested.query.listPayload(variants()[0]), nestedExpected.query.listPayload(variants()[0]), "nested prewarm scopes do not survive into another request");

  const closed = fixture(), closedExpected = fixture();
  const former = closed.query.listPayload(variants()[0]);
  closed.state.db.close(); closed.state.infoStamp = "info-v2";
  equal(closed.query.listPayload(variants()[0]), former, "native closed database preserves the complete metadata fallback", true);
  closed.state.db = seed(2); update(closed, false); update(closedExpected);
  equal(closed.query.listPayload(variants()[0]), closedExpected.query.listPayload(variants()[0]),
    "equivalent replacement SQLite owner recovers at the same metadata stamp");

  const metadataOnly = fixture(), metadataExpected = fixture();
  metadataOnly.query.listPayload(variants()[0]); update(metadataOnly); update(metadataExpected);
  equal(metadataOnly.query.listPayload(variants()[0]), metadataExpected.query.listPayload(variants()[0]),
    "metadata-only stamps invalidate derived lists and pages without unrelated presentation changes");
  const calls = { ...metadataOnly.state.counts };
  metadataOnly.state.fullStamp = "presentation-v2";
  metadataOnly.query.listPayload(variants()[0]);
  assert.deepEqual(metadataOnly.state.counts, calls, "presentation-only changes retain the successful narrow metadata source");

  const empty = fixture({ count: 0 });
  assert.deepEqual(empty.actor.enrichLocalWorksWithIndexResult([]), { works: [], cacheable: true });
  const emptyPage = empty.query.listPayload(variants()[0]); assert.equal(emptyPage.count, 0);
  assert.equal(empty.query.listPayload(variants()[0]), emptyPage); assert.deepEqual(empty.state.counts, { narrow: 0, legacy: 0 });
  const absent = fixture(); absent.state.works[0].directoryName = absent.state.works[0].title = "ABS-999";
  absent.state.library.worksById = new Map([[absent.state.works[0].id, absent.state.works[0]]]);
  const absentResult = absent.actor.enrichLocalWorksWithIndexResult([absent.state.works[0]]);
  assert.equal(absentResult.cacheable, true); assert.equal(absentResult.works[0].infoSummary, null);
  const absentReads = { ...absent.state.counts };
  absent.actor.enrichLocalWorksWithIndexResult([absent.state.works[0]]);
  assert.deepEqual(absent.state.counts, absentReads, "confirmed missing metadata remains negatively cached");

  const modern = fixture(), compatible = fixture({ connectResult: false });
  for (const request of variants()) equal(modern.query.listPayload(request), compatible.query.listPayload(request),
    "legacy consumers without the optional result reader keep successful complete DTOs");
  assert.ok(warnings.length > 10);
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.ok(server.includes("enrichLocalWorksWithActorMovieIndexResult: actorMovieService.enrichLocalWorksWithIndexResult"),
    "the production dependency assembly connects the actual provider result reader");
  console.log(JSON.stringify({ ok: true, comparisons, fallbackComparisons, phases: 2, metadataStages: 2,
    actualComposition: true, localListCategoryFilterPageRetry: true, failedPrewarmRetry: true, laterMetadataBatch: true,
    coldErrorUnchanged: true, nativeOwnerReplacement: true, metadataOnlyStamp: true, presentationSourceReuse: true, emptyCachesPreserved: true,
    formerFailedPrewarmReads: 18, failedPrewarmReads: 1, repeatedFailedPrewarmRetry: true, exceptionalScopeRelease: true, nestedScopeRestore: true }));
} finally {
  console.warn = warn;
  for (const db of databases) if (db.isOpen) db.close();
}

function equal(actual, expected, label, fallback = false) {
  assert.deepEqual(actual, expected, label); comparisons++; if (fallback) fallbackComparisons++;
}
function errorFrom(operation) {
  try { operation(); } catch (error) { return { message: error.message, code: error.code }; }
  assert.fail("the original cold metadata failure must remain visible");
}
function key(value) { return String(value || "").replace(/[^A-Za-z0-9]/gu, "").toLowerCase(); }
function url(values) { return new URL("http://fixture.invalid/?" + new URLSearchParams(values)); }
function variants() { return [
  url({ limit: "48", sort: "releaseDesc" }), url({ limit: "48", sort: "title" }),
  url({ limit: "1", offset: "1", sort: "ratingDesc" }), url({ filter: "highRating", sort: "ratingDesc" }),
  url({ category: "censored", filter: "rated", sort: "releaseDesc" }), url({ filter: "info", sort: "updated" })
]; }
function update(owner, bumpStamp = true) {
  if (bumpStamp) owner.state.infoStamp = "info-v2";
  owner.state.db.exec("UPDATE works SET title='Changed metadata 1',rating=4.8,release_date='2026-09-01' WHERE id=1");
}
function seed(count) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec(`CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,code_search TEXT,title TEXT,release_date TEXT,rating REAL,rating_count INTEGER,has_magnet INTEGER,is_streamable INTEGER,has_subtitles INTEGER,javdb_tags_json TEXT);
    CREATE INDEX idx_info_fixture_codes ON works(code_search);
    CREATE TABLE work_people(work_id INTEGER,person_id INTEGER,source TEXT,sort_order INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE work_external_refs(work_id INTEGER,provider TEXT,url TEXT);`);
  const work = db.prepare("INSERT INTO works VALUES(?,?,?,?,?,?,10,1,1,0,'[\"fixture\"]')");
  const people = db.prepare("INSERT INTO work_people VALUES(?,1,'actor_movies',?,'2026','2026')");
  const ref = db.prepare("INSERT INTO work_external_refs VALUES(?,'javdb-video',?)");
  for (let id = 1; id <= count; id++) {
    const code = `ABC-${String(id).padStart(3, "0")}`;
    work.run(id, code, id === count ? "" : key(code), `Old metadata ${id}`, "2026-01-01", id === 1 ? 3.1 : 4.2);
    people.run(id, id); ref.run(id, `https://fixture.invalid/work/${id}`);
  }
  return db;
}
function fixture({ count = 2, connectResult = !legacy } = {}) {
  const works = Array.from({ length: count }, (_, index) => ({ id: "local" + (index + 1), personId: "1", personName: "Person 1",
    title: `ABC-${String(index + 1).padStart(3, "0")}`, directoryName: `ABC-${String(index + 1).padStart(3, "0")}`,
    infoSummary: null, modifiedAt: "2026-01-01", videos: [], images: [], infos: [], videoCount: 1, playableCount: 1,
    imageCount: 0, infoCount: 0, missingLocal: false }));
  const state = { db: seed(count), works, infoStamp: "info-v1", fullStamp: "presentation-v1", failure: null,
    counts: { narrow: 0, legacy: 0 }, library: { scannedAt: "same", worksById: new Map(works.map(work => [work.id, work])) } };
  const actor = createActorMovieService({ createId: (prefix, value) => `${prefix}:${value}`, dbBoolOrNull: value => value == null ? null : Boolean(value),
    getCoreDb: () => ({ prepare(sql) {
      const kind = sql.includes("WHERE w.code_search IN") ? "narrow" : sql.includes("w.code_search <> LOWER") ? "legacy" : null;
      if (kind) { state.counts[kind]++; if (failed(kind, "prepare")) throw failure(kind, "prepare"); }
      const statement = state.db.prepare(sql);
      return { all(...args) { if (kind && failed(kind, "all")) throw failure(kind, "all"); return statement.all(...args); } };
    } }), getStamp: () => state.fullStamp, getInfoStamp: () => state.infoStamp, getSearchStamp: () => state.fullStamp,
    getLibrary: () => state.library, localWorkCodeKeys: () => new Set(), looseWorkCodeKey: key, storedWorkCodeKey: key,
    workCodeKeys: work => [key(work.directoryName)], mergedPersonMembers: id => [{ id }], normalizeWorkCode: value => String(value || ""),
    parseJsonTextArray: value => JSON.parse(value || "[]"), proxiedRemoteImageUrl: value => value || "", publicRemoteUrl: value => value || "" });
  const dependencies = { diskUsage: {}, getLibrary: () => state.library, actorMovieStamp: () => state.fullStamp, actorMovieInfoStamp: () => state.infoStamp,
    workQueryStamp: () => "query-v1", userStateStamp: () => "user-v1", peoplePayloadStamp: () => "people-v1",
    enrichLocalWorksWithActorMovieIndex: actor.enrichLocalWorksWithIndex,
    enrichLocalWorksWithActorMovieIndexResult: connectResult ? actor.enrichLocalWorksWithIndexResult : undefined,
    actorMissingSearchWorks: () => [], actorMissingSearchWorksForPeople: () => [], rankingMissingSearchWorks: () => [],
    actorMissingSearchResult: undefined, actorMissingSearchResultForPeople: undefined, mergedActorMovieRowsResult: undefined,
    missingActorWorksResultForPerson: undefined, rankingMissingSearchResult: undefined,
    withWorkInfoReadStatus: undefined, workInfoReadCacheable: undefined,
    withWorkSearchReadStatus: undefined, workSearchReadCacheable: undefined,
    createWorkSearchMatcher: () => () => true, searchPeople: () => ({ exact: [], matchedPersonIds: [], people: [] }),
    dedupeWorksForDisplay: rows => rows, defaultWorkLimit: 48, maxWorkLimit: 1000,
    clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, value === null ? fallback : Number(value))),
    favoriteStateService: { isFavoriteWork: () => false, publicFavoriteForWork: () => null }, playbackProgressService: { getWorkProgress: () => null },
    peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope === "main", workMatchesDirect: () => false },
    isVrWork: () => false, workHasCoreCover: () => false, workHasLocalMarker: () => false, workInfoFacetRow: () => null,
    publicWorkAvailability: () => ({}), publicWork: work => structuredClone(work), publicPerson: person => person, storedWorkCodeKey: key,
    prewarmLocalWorkCodeKeys: () => state.onPrewarm?.(), prewarmRemoteImagesForWorks: () => {}, prewarmCoreWorkCovers: () => {},
    prewarmWorkInfoDetails: () => {}, prewarmVideoProbesForWorks: () => {}, prewarmWorkSearch: () => {},
    prewarmPersonMerge: () => {}, scheduleBackground: () => {}, workClassificationService: { visibilityStamp: () => "", filterForRequest: rows => rows },
    displayWorkTitle: value => String(value || "") };
  const grouped = createFanhaoDependencies(new Proxy(dependencies, { get: (object, field) => Object.hasOwn(object, field) ? object[field] : () => {} }));
  assert.equal(grouped.works.enrichLocalWorksWithActorMovieIndexResult, dependencies.enrichLocalWorksWithActorMovieIndexResult,
    "actual composition retains the optional metadata status reader");
  return { state, actor, query: createWorkQueryService({ ...grouped.works, library: state.library }) };

  function failed(kind, phase) { return state.failure?.kind === kind && state.failure.phase === phase
    && (!state.failure.at || state.failure.at === state.counts[kind]); }
  function failure(kind, phase) { return Object.assign(new Error(`controlled ${kind} ${phase} failure`), { code: "SQLITE_BUSY" }); }
}

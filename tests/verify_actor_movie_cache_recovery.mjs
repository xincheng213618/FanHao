import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createActorMovieService } from "../src/modules/fanhao/server/people/actor-movie-service.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createPersonDetailService } from "../src/modules/fanhao/server/people/person-detail-service.js";
import { createPersonListService } from "../src/modules/fanhao/server/people/person-list-service.js";
import { createFanhaoDependencies } from "../src/modules/fanhao/server/composition.js";

// Actual service-owned state and private SQLite metadata, including the
// attached cover database. No service, worker, media or filesystem fixture.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-poison"));
const source = fs.readFileSync(new URL("../src/modules/fanhao/server/people/actor-movie-service.js", import.meta.url), "utf8");
let previousSource = source;
for (const [current, previous] of [
  ["return { rows: actorMovieCache?.rows || rowsByPersonMap, cacheable: false };",
    "if (actorMovieCache?.rows) return { rows: actorMovieCache.rows, cacheable: true };"],
  ["return { ids: actorMoviePersonIdCache?.ids || ids, cacheable: false };",
    "if (actorMoviePersonIdCache?.ids) return { ids: actorMoviePersonIdCache.ids, cacheable: true };"],
  ["if (loaded.cacheable) actorMovieByCodeKeyCache = { stamp, rows: rowsByCode };", "actorMovieByCodeKeyCache = { stamp, rows: rowsByCode };"],
  ["if (cacheable) actorMissingSearchCache = { stamp, works };", "actorMissingSearchCache = { stamp, works };"]
]) {
  assert.equal(previousSource.split(current).length, 2, "one restoration site for the former cache write");
  previousSource = previousSource.replace(current, previous);
}
const previousFactory = new Function(previousSource.replace("export function createActorMovieService", "function createActorMovieService")
  + "\nreturn createActorMovieService;")();
const factory = process.argv.includes("--legacy-poison") ? previousFactory : createActorMovieService;
const owners = new WeakMap(), databases = [], warnings = [];
const prepare = DatabaseSync.prototype.prepare, warn = console.warn;
let comparisons = 0, fallbackComparisons = 0;
console.warn = (...args) => warnings.push(args);
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const state = owners.get(this);
  const kind = /SELECT DISTINCT CAST\(person_id AS TEXT\)/u.test(sql) ? "ids"
    : sql.includes("FROM work_people wp") ? sql.includes("wp.person_id IN") ? "person" : "rows"
      : sql.includes("SELECT DISTINCT w.code_search") ? "local" : null;
  if (state && kind) {
    state.counts[kind]++;
    if (fails(state, kind, "prepare")) throw state.failure.error;
  }
  const statement = prepare.call(this, sql, ...args);
  if (!state || !kind) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...parameters) => {
      if (key === "all" && fails(state, kind, "all")) throw state.failure.error;
      return value.apply(target, parameters);
    };
  } });
};

try {
  for (const phase of ["prepare", "all"]) for (const [kind, read] of [
    ["rows", item => item.service.missingSearchResult()],
    ["person", item => item.service.missingSearchResultForPeople(["1"])],
    ["person", item => item.service.mergedRowsResult("1")],
    ["person", item => item.service.missingWorksResultForPerson(item.library.people[0])],
    ["rows", item => ({ rows: item.service.rowsByPerson() })],
    ["rows", item => ({ rows: item.service.rowsByCodeKey() })],
    ["ids", item => ({ value: item.service.hasMergedRows("1") })]
  ]) {
    const actual = fixture(factory), former = fixture(previousFactory), expected = fixture(createActorMovieService);
    fail(actual, kind, phase); fail(former, kind, phase);
    equal(dto(read(actual)), dto(read(former)), "the first SQL error preserves its complete former fallback", true);
    actual.state.failure = null;
    const recovered = read(actual);
    equal(dto(recovered), dto(read(expected)), "actor movie cache recovery: a SQL failure must retry at the same stamp");
    if (Object.hasOwn(recovered, "cacheable")) assert.equal(recovered.cacheable, true);
    const calls = { ...actual.state.counts };
    equal(dto(read(actual)), dto(recovered), "successful same-stamp data stays reusable");
    // Targeted missing DTOs retain their existing local-code queries, while
    // successful raw actor rows and membership are read only once.
    assert.equal(actual.state.counts[kind], calls[kind]);
  }

  // Complete rows from a prior stamp remain the public fallback. Neither the
  // missing-work nor code-key derivatives may bless them at the new stamp.
  for (const phase of ["prepare", "all"]) for (const read of [
    item => item.service.missingSearchResult(), item => ({ rows: item.service.rowsByCodeKey() })
  ]) {
    const actual = fixture(factory), former = fixture(previousFactory), expected = fixture(createActorMovieService);
    equal(dto(read(actual)), dto(read(former)), "complete warm response before a stamp change", true);
    for (const item of [actual, former, expected]) {
      item.state.stamp = "v2";
      item.state.db.prepare("UPDATE works SET title='Changed title' WHERE id=1").run();
    }
    fail(actual, "rows", phase); fail(former, "rows", phase);
    const first = read(actual);
    equal(dto(first), dto(read(former)), "the old complete rows remain the failed-refresh fallback", true);
    if (Object.hasOwn(first, "cacheable")) assert.equal(first.cacheable, false);
    actual.state.failure = null;
    equal(dto(read(actual)), dto(read(expected)), "failed derived data must not occupy the newer stamp");
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(factory), former = fixture(previousFactory), expected = fixture(createActorMovieService);
    actual.service.rows("1"); former.service.rows("1");
    fail(actual, "person", phase); fail(former, "person", phase);
    const partial = actual.service.missingSearchResultForPeople(["1", "2"]);
    equal(partial.works, former.service.missingSearchWorksForPeople(["1", "2"]), "cached people still appear in a partial failed result", true);
    assert.equal(partial.works.length, 2); assert.equal(partial.cacheable, false);
    actual.state.failure = null;
    equal(actual.service.missingSearchResultForPeople(["1", "2"]).works,
      expected.service.missingSearchWorksForPeople(["1", "2"]), "the uncached missing person retries");

    const local = fixture(factory, { local: true }), oldLocal = fixture(previousFactory, { local: true });
    fail(local, "local", phase); fail(oldLocal, "local", phase);
    const fallback = local.service.missingSearchResultForPeople(["1"]);
    equal(fallback.works, oldLocal.service.missingSearchWorksForPeople(["1"]), "local-code failure preserves the full-key fallback", true);
    assert.equal(fallback.cacheable, false); assert.equal(fallback.works.length, 1);
    local.state.failure = null;
    assert.equal(local.service.missingSearchResultForPeople(["1"]).cacheable, true);
  }

  const many = fixture(factory, { count: 905, local: true }), manyExpected = fixture(createActorMovieService, { count: 905, local: true });
  fail(many, "local", "all", { at: 2 });
  const secondBatch = many.service.missingSearchResultForPeople(["1", "2"]);
  equal(secondBatch.works, manyExpected.service.missingSearchWorksForPeople(["1", "2"]), "a failed later local-code batch uses the complete existing fallback", true);
  assert.equal(secondBatch.cacheable, false);
  many.state.failure = null;
  equal(many.service.missingSearchResultForPeople(["1", "2"]).works, secondBatch.works, "later-batch recovery preserves every DTO");

  const closed = fixture(factory), closedExpected = fixture(createActorMovieService);
  closed.state.localKeys = new Set(); // The independent local-code index remains available while the core DB is closed.
  closed.state.db.close();
  assert.deepEqual(closed.service.missingSearchResult(), { works: [], cacheable: false });
  closed.state.db = seed(); owners.set(closed.state.db, closed.state);
  equal(closed.service.missingSearchWorks(), closedExpected.service.missingSearchWorks(), "native closed connection recovers through a fresh same-stamp database");

  for (const targeted of [false, true]) {
    const actual = fixture(factory), expected = fixture(createActorMovieService);
    const read = item => targeted ? item.service.missingSearchResultForPeople(["1"]) : item.service.missingSearchResult();
    actual.state.db.exec("ALTER TABLE fanhao_images.images RENAME TO fixture_unavailable_covers");
    assert.deepEqual(read(actual), { works: [], cacheable: false }, "an actual attached-cover SQL failure retains the empty fallback");
    actual.state.db.exec("ALTER TABLE fanhao_images.fixture_unavailable_covers RENAME TO images");
    equal(read(actual).works, read(expected).works, "native attached-cover schema recovery retries at the same stamp");
  }
  const exclusions = fixture(factory, { local: true }), oldExclusions = fixture(previousFactory, { local: true });
  const excluded = new Set(["abc002"]);
  equal(exclusions.service.missingSearchResult(excluded).works, oldExclusions.service.missingSearchWorks(excluded), "global result wrapper preserves exclusions and complete cover DTOs");
  equal(exclusions.service.missingSearchResultForPeople(["1"], excluded).works,
    oldExclusions.service.missingSearchWorksForPeople(["1"], excluded), "targeted result wrapper preserves exclusions");
  const supplied = exclusions.service.rows("1"), formerSupplied = oldExclusions.service.rows("1");
  equal(exclusions.service.missingWorksResultForPerson(exclusions.library.people[0], supplied, excluded).works,
    oldExclusions.service.missingWorksForPerson(oldExclusions.library.people[0], formerSupplied, excluded), "person result preserves explicit rows and exclusions");

  verifyEmptyAndOwnership();
  verifyPersonListRecovery();
  for (const phase of ["prepare", "all"]) for (const exact of [false, true]) {
    const actual = fixture(factory), expected = fixture(createActorMovieService);
    const read = chain(actual, { exact }).search, cold = chain(expected, { exact }).search;
    fail(actual, exact ? "person" : "rows", phase);
    assert.equal(read().count, 0);
    actual.state.failure = null;
    const recovered = read(); equal(recovered, cold(), "actual composition/query source and page retry a failed actor fallback");
    const calls = { ...actual.state.counts };
    assert.equal(read(), recovered); assert.deepEqual(actual.state.counts, calls);
  }

  for (const phase of ["prepare", "all"]) {
    // Only exact-person enrichment fails. The later targeted missing reader
    // succeeds in this same request, so its status cannot hide that failure.
    const actual = fixture(factory, { local: true }), expected = fixture(createActorMovieService, { local: true });
    const read = chain(actual, { exact: true }).search, cold = chain(expected, { exact: true }).search;
    fail(actual, "person", phase, { remaining: 1 });
    const partial = read(); assert.equal(partial.count, 2);
    assert.equal(partial.works.find(work => !work.missingLocal)?.infoSummary, undefined);
    actual.state.failure = null;
    const recovered = read(); equal(recovered, cold(), "one-shot exact enrichment failure must not cache incomplete local metadata");
    assert.equal(recovered.works.find(work => !work.missingLocal)?.infoSummary?.rating, 4.1);

    for (const kind of ["person", "local"]) {
      const detailActual = fixture(factory, { local: true }), detailExpected = fixture(createActorMovieService, { local: true });
      const detail = chain(detailActual, { exact: true }).detail, correct = chain(detailExpected, { exact: true }).detail;
      fail(detailActual, kind, phase);
      const first = detail();
      if (kind === "person") assert.equal(first.filmographyCount, 1);
      else assert.equal(first.filmographyCount, 2, "a full-key fallback still renders the correct detail");
      detailActual.state.failure = null;
      const next = detail(); equal(next, correct(), "actual person-detail source/page must release the actor or local-code fallback");
      const calls = { ...detailActual.state.counts };
      equal(detail(), next, "successful detail still reuses its source/page");
      assert.deepEqual(detailActual.state.counts, calls);
    }
  }
  assert.ok(warnings.length > 20);
  console.log(JSON.stringify({ ok: true, comparisons, fallbackComparisons, phases: 2, laterLocalBatch: true,
    nativeClosedRecovery: true, nativeCoverSchemaRecovery: true, successfulEmptyCaches: true, actualCompositionQueryDetail: true, exactEnrichmentRetry: true,
    actualPersonListRecovery: true, pendingPeoplePerRequest: 1000, membershipReadsPerFailedRequest: 1 }));
} finally {
  DatabaseSync.prototype.prepare = prepare; console.warn = warn;
  for (const db of databases) if (db.isOpen) db.close();
}

function key(value) { return String(value || "").replace(/[^A-Za-z0-9]/gu, "").toLowerCase(); }
function dto(value) { return Object.hasOwn(value, "works") ? value.works : Object.hasOwn(value, "rows") ? value.rows : value; }
function equal(actual, expected, label, fallback = false) {
  assert.deepEqual(actual, expected, label); comparisons++; if (fallback) fallbackComparisons++;
}
function fail(item, kind, phase, extra = {}) {
  item.state.failure = { kind, phase, remaining: Infinity, ...extra,
    error: Object.assign(new Error("controlled actor SQL failure"), { code: "SQLITE_BUSY" }) };
}
function fails(state, kind, phase) {
  const failure = state.failure;
  if (!failure || failure.kind !== kind || failure.phase !== phase || failure.remaining < 1
    || failure.at && state.counts[kind] !== failure.at) return false;
  failure.remaining--; return true;
}
function seed(count = 3, local = false) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec(`ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,code_search TEXT,title TEXT,release_date TEXT,rating REAL,rating_count INTEGER,has_magnet INTEGER,is_streamable INTEGER,has_subtitles INTEGER,javdb_tags_json TEXT);
    CREATE TABLE work_people(work_id INTEGER,person_id INTEGER,source TEXT,sort_order INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE person_external_refs(id INTEGER PRIMARY KEY,person_id INTEGER,provider TEXT,external_key TEXT,url TEXT);
    CREATE TABLE work_external_refs(id INTEGER PRIMARY KEY,work_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE local_works(work_id INTEGER);
    CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY,owner_type TEXT,owner_id INTEGER,kind TEXT,remote_url TEXT,local_path TEXT,source TEXT,updated_at TEXT,image_blob BLOB,sort_order INTEGER);
    INSERT INTO people VALUES(1,'Person 1'),(2,'Person 2');
    INSERT INTO person_external_refs VALUES(1,1,'javdb-actor','fixture-actor','https://fixture.invalid/actor');`);
  const work = db.prepare("INSERT INTO works VALUES(?,?,?,?,?,4.1,10,1,1,0,'[\"fixture\"]')");
  const relation = db.prepare("INSERT INTO work_people VALUES(?,?,'actor_movies',?,'2026','2026')");
  const ref = db.prepare("INSERT INTO work_external_refs VALUES(?,?,'javdb-video',?)");
  const cover = db.prepare("INSERT INTO fanhao_images.images VALUES(?,'work',?,'cover',?,'','fixture','v1',?,0)");
  for (let id = 1; id <= count; id++) {
    work.run(id, `ABC-${String(id).padStart(3, "0")}`, `abc${String(id).padStart(3, "0")}`, `Actor title ${id}`, "2026-01-01");
    relation.run(id, id === count ? 2 : 1, id);
    ref.run(id, id, `https://fixture.invalid/work/${id}`);
    cover.run(id, id, `https://fixture.invalid/cover/${id}`, id % 2 ? new Uint8Array([1]) : null);
  }
  if (local && count) db.exec("INSERT INTO local_works VALUES(1)");
  return db;
}
function fixture(create, { count = 3, local = false, members = null } = {}) {
  const state = { db: seed(count, local), stamp: "v1", user: "u1", failure: null, counts: { rows: 0, person: 0, ids: 0, local: 0 } };
  owners.set(state.db, state);
  const people = [{ id: "1", name: "Person 1", works: local ? ["local1"] : [] }, { id: "2", name: "Person 2", works: [] }];
  const localWork = { id: "local1", personId: "1", personName: "Person 1", title: "ABC-001", directoryName: "ABC-001",
    videoCount: 1, playableCount: 1, imageCount: 0, infoCount: 0, videos: [], images: [], infos: [], modifiedAt: "2026", missingLocal: false };
  const library = { scannedAt: "same", people, peopleById: new Map(people.map(person => [person.id, person])),
    worksById: new Map(local ? [[localWork.id, localWork]] : []) };
  const workKeys = work => [key(work.infoSummary?.code || work.directoryName || work.code || work.title)].filter(Boolean);
  const service = create({ createId: (prefix, value) => `${prefix}:${value}`, dbBoolOrNull: value => value == null ? null : Boolean(value),
    getCoreDb: () => state.db, getStamp: () => state.stamp, getSearchStamp: () => state.stamp, getInfoStamp: () => state.stamp,
    getLibrary: () => library, localWorkCodeKeys: () => state.localKeys || new Set(prepare.call(state.db,
      "SELECT w.code_search FROM works w JOIN local_works lw ON lw.work_id=w.id").all().map(row => row.code_search)),
    looseWorkCodeKey: key, storedWorkCodeKey: key, normalizeWorkCode: value => String(value || ""), workCodeKeys: workKeys,
    mergedPersonMembers: members || (id => [{ id: String(id) }]), parseJsonTextArray: value => JSON.parse(value || "[]"),
    proxiedRemoteImageUrl: value => value || "", publicRemoteUrl: value => value || "" });
  return { state, library, service, local, workKeys };
}
function verifyEmptyAndOwnership() {
  const empty = fixture(factory, { count: 0 });
  const result = empty.service.missingSearchResult(); assert.deepEqual(result, { works: [], cacheable: true });
  assert.equal(empty.service.missingSearchWorks(), result.works);
  assert.equal(empty.state.counts.rows, 1);
  empty.service.rowsForPeople(["99"]); empty.service.rowsForPeople(["99"]);
  assert.equal(empty.state.counts.person, 0, "the complete empty global map also serves person lookups");
  const targeted = fixture(factory, { count: 0 }); targeted.service.rowsForPeople(["99"]); targeted.service.rowsForPeople(["99"]);
  assert.equal(targeted.state.counts.person, 1, "a genuine empty person's successful row query stays cached");
  const membership = fixture(factory, { count: 0 }); assert.equal(membership.service.hasMergedRows("1"), false);
  membership.service.hasMergedRows("1"); assert.equal(membership.state.counts.ids, 1);
  const explicit = fixture(factory);
  assert.deepEqual(explicit.service.missingWorksResultForPerson(explicit.library.people[0], []), { works: [], cacheable: true });
  assert.equal(explicit.state.counts.person, 0, "an explicitly supplied empty row array never triggers a default lookup");
  assert.deepEqual(explicit.service.missingSearchResultForPeople(["bad", 0, 1.5]), { works: [], cacheable: true });
  const one = fixture(factory), two = fixture(factory);
  one.service.missingSearchWorks(); two.state.db.exec("UPDATE works SET title='Owner two' WHERE id=1");
  assert.equal(two.service.missingSearchWorks()[0].title, "Owner two");
  assert.equal(one.service.missingSearchWorks()[0].title, "Actor title 1", "distinct owners never share cached rows");
  one.state.db.exec("INSERT INTO local_works VALUES(1)"); one.service.invalidateSearch();
  assert.equal(one.service.missingSearchWorks().length, 2); assert.equal(one.state.counts.rows, 1);
  one.state.db.exec("UPDATE works SET title='After invalidate' WHERE id=2"); one.service.invalidate();
  assert.equal(one.service.missingSearchWorks()[0].title, "After invalidate");
  one.state.stamp = "v2"; one.state.db.exec("UPDATE works SET title='After stamp' WHERE id=2");
  assert.equal(one.service.missingSearchWorks()[0].title, "After stamp");
  const cachedRows = one.service.rowsByPerson(); const calls = one.state.counts.rows;
  one.service.setRowsCache({ stamp: one.state.stamp, rows: cachedRows });
  assert.equal(one.service.rowsByPerson(), cachedRows); one.service.rowsByCodeKey(); one.service.missingSearchWorks();
  assert.equal(one.state.counts.rows, calls, "the explicit complete cache setter still supplies every derived reader");
}
function verifyPersonListRecovery() {
  const calls = [];
  const members = id => { calls.push(id); return [{ id: id === "001" ? "2" : id === "opaque-0" ? "1" : String(id) }]; };
  const alias = fixture(factory, { members });
  const batch = alias.service.hasMergedRowsResultForPeople(["001", "opaque-0", "opaque-0", 2]);
  assert.deepEqual(batch, { matches: new Set(["001", "opaque-0", "2"]), cacheable: true });
  assert.deepEqual(calls, ["001", "opaque-0", 2], "leading-zero, opaque and original numeric IDs reach mergedPersonMembers unchanged");
  assert.equal(alias.state.counts.ids, 1, "one membership SQL supplies the complete batch");
  assert.equal(alias.service.hasMergedRows("opaque-0"), true);
  assert.equal(alias.service.hasMergedRows("001"), true);
  assert.equal(alias.state.counts.ids, 1);
  const emptyBatch = fixture(factory);
  assert.deepEqual(emptyBatch.service.hasMergedRowsResultForPeople([]), { matches: new Set(), cacheable: true });
  assert.equal(emptyBatch.state.counts.ids, 0);
  for (const phase of ["prepare", "all"]) {
    const actual = fixture(factory, { members }), expected = fixture(createActorMovieService, { members });
    const list = personList(actual), correct = personList(expected);
    fail(actual, "ids", phase);
    const fallback = list.mainLibraryPeople();
    assert.deepEqual(fallback.map(person => person.id), ["known-local", "known-profile"]);
    assert.equal(actual.state.counts.ids, 1, "1,000 pending people cause only one failed membership SQL per request");
    equal(list.mainLibraryPeople(), fallback, "a repeated unavailable membership still returns known local/profile people", true);
    assert.equal(actual.state.counts.ids, 2, "a failed outer people-list cache remains retryable");
    actual.state.failure = null;
    const recovered = list.mainLibraryPeople(); equal(recovered, correct.mainLibraryPeople(), "the actual people-list cache releases same-stamp false membership");
    assert.equal(recovered.length, 4); assert.equal(actual.state.counts.ids, 3);
    assert.equal(list.mainLibraryPeople(), recovered, "successful main people lists preserve cached array identity");
    assert.equal(actual.state.counts.ids, 3);
    const other = list.mainLibraryPeople("western"); assert.equal(other.length, 0);
    assert.equal(list.mainLibraryPeople("western"), other, "a genuine empty scoped people list stays cacheable");
    assert.equal(list.shouldShowPersonInMainList({ id: "opaque-0" }), true, "the existing single-person bool entry remains compatible");
    actual.state.stamp = expected.state.stamp = "v2";
    actual.state.db.exec("DELETE FROM work_people WHERE person_id=2"); expected.state.db.exec("DELETE FROM work_people WHERE person_id=2");
    fail(actual, "ids", phase);
    assert.equal(list.mainLibraryPeople().length, 4, "warm membership failures preserve the previous complete set");
    actual.state.failure = null;
    equal(list.mainLibraryPeople(), correct.mainLibraryPeople(), "a failed new-stamp membership fallback is not promoted into the outer list cache");
    assert.equal(list.mainLibraryPeople().length, 3);
  }
  const noPending = fixture(factory);
  const known = personList(noPending, true);
  fail(noPending, "ids", "prepare");
  assert.equal(known.mainLibraryPeople().length, 2); assert.equal(noPending.state.counts.ids, 0);
  const noPeople = fixture(factory); noPeople.library.people = [];
  const emptyList = createPersonListService({ actorMovieService: noPeople.service, actorProfileRow: () => null,
    getStamp: () => noPeople.state.stamp, getLibrary: () => noPeople.library,
    peopleScopeService: { normalize: value => value, personMatches: () => true }, personMergeService: { record: value => value } });
  const none = emptyList.mainLibraryPeople(); assert.deepEqual(none, []); assert.equal(emptyList.mainLibraryPeople(), none);
  assert.equal(noPeople.state.counts.ids, 0);

  function personList(target, onlyKnown = false) {
    const pending = Array.from({ length: 1000 }, (_, index) => ({ id: index === 1 ? "001" : "opaque-" + index, name: "Synthetic " + index }));
    target.library.people = [
      ...(onlyKnown ? [] : pending),
      { id: "known-local", workCount: 1 }, { id: "known-profile" },
      ...(onlyKnown ? [] : [{ id: "merged-copy", mergeInto: "opaque-0" }, { id: "other-scope", scope: "western" }])
    ];
    return createPersonListService({ actorMovieService: target.service, actorProfileRow: id => id === "known-profile" ? { id } : null,
      getStamp: () => target.state.stamp, getLibrary: () => target.library,
      peopleScopeService: { normalize: value => value, personMatches: (person, scope) => scope === "western" ? person.scope === "western" : person.scope !== "western" },
      personMergeService: { record: person => person.mergeInto ? { ...person, id: person.mergeInto } : person } });
  }
}
function chain(target, { exact = false } = {}) {
  const service = target.service, person = target.library.people[0];
  const dependencies = { library: target.library, getLibrary: () => target.library, diskUsage: {},
    actorMovieStamp: () => target.state.stamp, actorMovieInfoStamp: () => target.state.stamp,
    workQueryStamp: () => target.state.stamp, userStateStamp: () => target.state.user, peoplePayloadStamp: () => target.state.stamp,
    actorMissingSearchWorks: service.missingSearchWorks, actorMissingSearchWorksForPeople: service.missingSearchWorksForPeople,
    actorMissingSearchResult: service.missingSearchResult, actorMissingSearchResultForPeople: service.missingSearchResultForPeople,
    mergedActorMovieRows: service.mergedRows, mergedActorMovieRowsResult: service.mergedRowsResult,
    missingActorWorksForPerson: service.missingWorksForPerson, missingActorWorksResultForPerson: service.missingWorksResultForPerson,
    rankingMissingSearchWorks: () => [], rankingMissingSearchResult: () => ({ works: [], cacheable: true }),
    withWorkInfoReadStatus: undefined, workInfoReadCacheable: undefined,
    withWorkSearchReadStatus: undefined, workSearchReadCacheable: undefined,
    createWorkSearchMatcher: text => work => work.title.toLowerCase().includes(text),
    searchPeople: () => exact ? { exact: [person], matchedPersonIds: [person.id], people: [person] } : { exact: [], matchedPersonIds: [], people: [] },
    coreLocalWorkIdsForPeople: () => target.local ? ["local1"] : [], coreMissingWorksForPerson: () => [],
    corePersonFallbackRecord: () => null, resolveLibraryPersonByPublicId: id => target.library.peopleById.get(String(id)),
    mergedPersonRecord: value => value, mergedPersonMembers: id => [{ id: String(id) }], workCodeKeySetForWorks: rows => new Set(rows.flatMap(target.workKeys)),
    enrichLocalWorksWithActorMovieIndex: rows => rows, enrichLocalWorksWithActorMovieInfo: service.enrichLocalWorks,
    dedupeWorksForDisplay: rows => rows, defaultWorkLimit: 48, maxWorkLimit: 1000, maxActorAvatarBytes: 1024,
    clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, value === null ? fallback : Number(value))),
    favoriteStateService: { isFavoriteWork: () => false, publicFavoriteForWork: () => null }, playbackProgressService: { getWorkProgress: () => null },
    peopleScopeService: { normalize: () => "main", workMatches: () => true, personMatches: () => true },
    isVrWork: () => false, workHasCoreCover: () => false, workHasLocalMarker: () => false, workInfoFacetRow: () => null,
    publicWorkAvailability: () => ({}), publicWork: work => structuredClone(work), publicPerson: (value, options) => ({ ...value, detailCounts: options }),
    storedWorkCodeKey: key, prewarmRemoteImagesForWorks: () => {}, prewarmLocalWorkCodeKeys: () => {},
    prewarmCoreWorkCovers: () => {}, prewarmWorkInfoDetails: () => {}, prewarmVideoProbesForWorks: () => {},
    workClassificationService: { visibilityStamp: () => "", filterForRequest: rows => rows },
    fastMissingCodeSearch: () => [], localWorksByCodePrefix: () => [], localSearchWorkByCodeKey: () => null,
    displayWorkTitle: value => String(value || "") };
  const grouped = createFanhaoDependencies(new Proxy(dependencies, {
    get: (object, field) => Object.hasOwn(object, field) ? object[field] : () => {}
  }));
  for (const field of ["actorMissingSearchResult", "actorMissingSearchResultForPeople", "mergedActorMovieRowsResult", "missingActorWorksResultForPerson"])
    assert.equal(grouped.works[field], dependencies[field], "actual composition retains " + field);
  const query = createWorkQueryService({ ...grouped.works, library: target.library });
  const detail = createPersonDetailService({ ...grouped.works, library: target.library, workQueryService: query });
  return {
    search: () => query.searchPayload(new URL("http://fixture.invalid/?q=" + encodeURIComponent(exact ? "Person 1" : "Actor title") + "&limit=48")),
    detail: () => detail.detailPayload("1", new URL("http://fixture.invalid/?limit=48"))
  };
}

import assert from "node:assert/strict";
import fs from "node:fs";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createFanhaoDependencies } from "../src/modules/fanhao/server/composition.js";
import { createWorkInfoCacheFixture, createWorkInfoDatabase, createActorMovieForWorkInfoFixture, workInfoUrl }
  from "./fixtures/work-info-cache-recovery.mjs";

// Native private SQLite plus actual provider, presentation, composition and
// consumer modules. The negative control drops only the optional read state.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-poison"));
const legacy = process.argv.includes("--legacy-poison");
const fixtures = [], warnings = [], warn = console.warn;
let comparisons = 0, fallbackComparisons = 0;
console.warn = (...args) => warnings.push(args);
function fixture(options = {}) {
  const value = createWorkInfoCacheFixture({ connectStatus: !legacy, ...options });
  fixtures.push(value); return value;
}
function equal(actual, expected, message, fallback = false) {
  assert.deepEqual(actual, expected, message); comparisons++;
  if (fallback) fallbackComparisons++;
}
function fault(target, reader, phase, extra = {}) { target.state.failure = { reader, phase, ...extra }; }
function update(target) {
  target.state.db.exec("UPDATE works SET rating=4.9,title=title||' refreshed',release_date='2027-01-01',raw_text=raw_text||' refreshed'");
  target.state.stamp = "next";
}
try {
  for (const phase of ["prepare", "all"]) for (const reader of ["row", "facet"]) {
    const actual = fixture(), expected = fixture();
    const method = reader === "row" ? "row" : "facetRow";
    fault(actual, reader, phase);
    const failed = actual.info.withReadStatus(() => actual.info[method]("2"));
    equal(failed, { value: null, cacheable: false }, "cold read keeps its old empty response", true);
    actual.state.failure = null;
    const recovered = actual.info.withReadStatus(() => actual.info[method]("2"));
    equal(recovered.value, expected.info[method]("2"), "cold failed index must retry at the same stamp");
    assert.equal(recovered.cacheable, true);
    assert.equal(actual.state.counts[reader], 2);
    equal(actual.info[method]("2"), recovered.value, "healthy index rows still reuse their full DTO");
    assert.equal(actual.state.counts[reader], 2);
    update(actual); update(expected); fault(actual, reader, phase);
    const stale = actual.info.withReadStatus(() => actual.info[method]("2"));
    equal(stale.value, recovered.value, "warm failed index preserves its complete old fallback", true);
    assert.equal(stale.cacheable, false);
    actual.state.failure = null;
    equal(actual.info[method]("2"), expected.info[method]("2"), "warm fallback cannot be stamped as the successful refresh");
  }

  for (const phase of ["prepare", "all"]) for (const filter of ["info", "rated", "highRating"]) {
    const actual = fixture(), expected = fixture(); fault(actual, "facet", phase);
    const request = workInfoUrl(filter);
    assert.equal(actual.query.listPayload(request).total, 0, "failed facet lookup retains the previous empty selection");
    if (!legacy) assert.equal(actual.state.counts.facet, 1, "one operation reuses its failed facet map");
    actual.state.failure = null;
    equal(actual.query.listPayload(request), expected.query.listPayload(request),
      "work-info cache recovery: same-stamp filter/source/page must retry the failed read");
    const successful = actual.query.listPayload(request), reads = { ...actual.state.counts };
    assert.equal(actual.query.listPayload(request), successful, "healthy list pages retain identity");
    assert.deepEqual(actual.state.counts, reads);
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(), expected = fixture(); fault(actual, "facet", phase);
    const failed = actual.query.listFromWorksPayload(actual.works, workInfoUrl());
    assert.deepEqual(failed.works.map(work => work.id), ["1", "2"]);
    assert.equal(failed.facets.highRating, 0);
    actual.state.failure = null;
    equal(actual.query.listFromWorksPayload(actual.works, workInfoUrl()),
      expected.query.listFromWorksPayload(expected.works, workInfoUrl()),
      "a stable source array must release failed sort/static/dynamic facet derivations");
    assert.deepEqual(actual.query.listFromWorksPayload(actual.works, workInfoUrl()).works.map(work => work.id), ["2", "1"]);
    const filterContext = { cache: new Map(), key: "highRating" };
    actual.state.stamp = expected.state.stamp = "filter-context";
    fault(actual, "facet", phase);
    assert.equal(actual.query.listFromWorksPayload(actual.works, workInfoUrl("highRating"), {}, {}, filterContext).total, 1,
      "the previous complete facet fallback is preserved on a warm failure");
    assert.equal(filterContext.cache.size, 0, "failed local facet selection cannot enter a caller's strong filter cache");
    actual.state.failure = null;
    equal(actual.query.listFromWorksPayload(actual.works, workInfoUrl("highRating"), {}, {}, filterContext),
      expected.query.listFromWorksPayload(expected.works, workInfoUrl("highRating")), "external filter contexts recover at the same stamp");
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(), previous = fixture({ connectStatus: false }), expected = fixture();
    for (const target of [actual, previous]) target.query.listPayload(workInfoUrl("highRating"));
    for (const target of [actual, previous, expected]) update(target);
    fault(actual, "facet", phase); fault(previous, "facet", phase);
    equal(actual.query.listPayload(workInfoUrl("highRating")), previous.query.listPayload(workInfoUrl("highRating")),
      "warm failed facet reads preserve the entire previous algorithm's fallback DTO", true);
    actual.state.failure = null;
    for (const filter of ["all", "info", "rated", "highRating"]) {
      equal(actual.query.listPayload(workInfoUrl(filter)), expected.query.listPayload(workInfoUrl(filter)),
        "warm facet fallback must refresh selection/sort/facets/full DTO at the same stamp");
    }
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(), expected = fixture(); fault(actual, "detail", phase);
    const failed = actual.query.listPayload(workInfoUrl());
    assert.equal(failed.works[0].infoSummary, null);
    assert.equal(actual.state.counts.detail, 3, "failed prewarm still permits the two existing row retries");
    actual.state.failure = null;
    // Change the page key first, so a fixed page cache cannot hide a poisoned
    // 4096-entry prepared DTO cache. Then repeat the original request too.
    for (const sort of ["updated", "ratingDesc", "releaseAsc", "durationDesc", "codeAsc"]) {
      equal(actual.query.listPayload(workInfoUrl("all", sort)), expected.query.listPayload(workInfoUrl("all", sort)),
        "failed detail summaries cannot enter prepared work or alternate-sort page caches");
    }
    const detail = fixture(), detailExpected = fixture(); fault(detail, "detail", phase);
    assert.equal(detail.detail.detailPayload("2").work.infoMetadata, null);
    detail.state.failure = null;
    const recovered = detail.detail.detailPayload("2");
    equal(recovered, detailExpected.detail.detailPayload("2"), "bounded work detail DTO cache admits only successful metadata reads");
    assert.equal(detail.detail.detailPayload("2"), recovered);
    const avatar = fixture(), avatarExpected = fixture(); fault(avatar, "detail", phase);
    assert.equal(avatar.presenter.publicPerson(avatar.person).avatarImage, null);
    avatar.state.failure = null;
    equal(avatar.presenter.publicPerson(avatar.person), avatarExpected.presenter.publicPerson(avatarExpected.person),
      "person fallback avatar nulls remain retryable after SQL failures");
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(), expected = fixture();
    fault(actual, "detail", phase, { once: true });
    const complete = actual.query.listPayload(workInfoUrl());
    equal(complete, expected.query.listPayload(workInfoUrl()), "one-shot failed prewarm still permits complete row-by-row recovery");
    assert.equal(actual.state.counts.detail, 3);
    const reads = actual.state.counts.detail;
    const next = actual.query.listPayload(workInfoUrl());
    assert.notEqual(next, complete, "a request with an earlier failed dependency does not admit its page");
    equal(next, complete, "successful row DTOs remain usable without altering the public response");
    assert.equal(actual.state.counts.detail, reads, "successful child rows may be cached despite their parent's earlier failure");
    assert.equal(actual.query.listPayload(workInfoUrl()), next);
  }

  const partial = fixture({ count: 205 }), partialExpected = fixture({ count: 205 });
  fault(partial, "detail", "all", { from: 2 });
  const partialPage = partial.query.listPayload(workInfoUrl("all", "updated", 0, 205));
  assert.equal(partialPage.works.filter(work => work.infoSummary).length, 200);
  assert.equal(partial.state.counts.detail, 7);
  partial.state.failure = null;
  equal(partial.query.listPayload(workInfoUrl("all", "updated", 0, 205)),
    partialExpected.query.listPayload(workInfoUrl("all", "updated", 0, 205)), "a failed second detail batch cannot freeze a partial full DTO page");

  for (const reader of ["facet", "detail"]) {
    const actual = fixture(), expected = fixture(); fault(actual, reader, "all");
    actual.query.prewarm();
    if (reader === "facet") assert.equal(actual.state.counts.facet, 1, "failed synchronous prewarm reuses one facet attempt");
    const before = actual.state.counts[reader];
    actual.query.prewarm();
    assert.ok(actual.state.counts[reader] > before, "each independent failed prewarm retries");
    actual.state.failure = null;
    for (const filter of ["all", "info", "rated", "highRating"]) {
      equal(actual.query.listPayload(workInfoUrl(filter)), expected.query.listPayload(workInfoUrl(filter)),
        "failed prewarm cannot occupy list/filter/facet/sort/DTO/page caches");
    }
  }

  const scoped = fixture(); fault(scoped, "facet", "all");
  const scope = scoped.info.withReadStatus(() => {
    for (let index = 0; index < 1000; index++) assert.equal(scoped.info.facetRow("2"), null);
    const child = scoped.info.withReadStatus(() => scoped.info.facetRow("2"));
    assert.equal(child.cacheable, false);
    const independentChild = scoped.info.withReadStatus(() => "complete independent value");
    assert.equal(independentChild.cacheable, true);
    return "unchanged response";
  });
  equal(scope, { value: "unchanged response", cacheable: false }, "nested failure status propagates without contaminating unrelated child reads", true);
  assert.equal(scoped.state.counts.facet, 1);
  assert.equal(scoped.info.readCacheable(), true);
  scoped.info.withReadStatus(() => scoped.info.facetRow("2")); assert.equal(scoped.state.counts.facet, 2);
  const sentinel = new Error("original callback exception");
  assert.throws(() => scoped.info.withReadStatus(() => { scoped.info.facetRow("2"); throw sentinel; }), error => error === sentinel);
  assert.equal(scoped.info.readCacheable(), true);
  scoped.state.failure = null; assert.equal(scoped.info.withReadStatus(() => scoped.info.facetRow("2")).value.rating, 4.8);
  const caught = scoped.info.withReadStatus(() => {
    assert.throws(() => scoped.info.withReadStatus(() => { throw sentinel; }), error => error === sentinel);
    return "parent fallback";
  });
  equal(caught, { value: "parent fallback", cacheable: false }, "caught child exceptions propagate failure status and retain the original error", true);
  scoped.info.invalidate(); fault(scoped, "facet", "all");
  const invalidated = scoped.info.withReadStatus(() => {
    assert.equal(scoped.info.facetRow("2"), null);
    scoped.state.failure = null; scoped.info.invalidate();
    assert.equal(scoped.info.facetRow("2").rating, 4.8);
    return "current complete row";
  });
  assert.equal(invalidated.cacheable, false, "invalidation clears temporary failed values without erasing an earlier dependency failure");

  const owner = fixture(), oldOwner = owner.state.db;
  owner.info.withReadStatus(() => {
    oldOwner.close(); assert.equal(owner.info.facetRow("2"), null);
    owner.state.db = createWorkInfoDatabase();
    assert.equal(owner.info.facetRow("2").rating, 4.8, "an owner change retries even inside the same failed stamp scope");
    owner.state.stamp = "other";
    fault(owner, "facet", "all"); assert.equal(owner.info.facetRow("2").rating, 4.8);
  });
  owner.state.failure = null;
  assert.equal(owner.info.withReadStatus(() => owner.info.facetRow("2")).cacheable, true);

  const native = fixture(), nativeExpected = fixture();
  native.state.db.exec("ALTER TABLE fanhao_images.images RENAME TO unavailable_images");
  assert.equal(native.detail.detailPayload("2").work.infoMetadata, null);
  native.state.db.exec("ALTER TABLE fanhao_images.unavailable_images RENAME TO images");
  equal(native.detail.detailPayload("2"), nativeExpected.detail.detailPayload("2"), "native attached-table SQL failure recovers its complete detail DTO at the same stamp");
  for (const method of ["row", "facetRow"]) {
    const actual = fixture(), expected = fixture();
    actual.state.db.exec("ALTER TABLE works RENAME TO unavailable_works");
    assert.equal(actual.info.withReadStatus(() => actual.info[method]("2")).value, null);
    actual.state.db.exec("ALTER TABLE unavailable_works RENAME TO works");
    equal(actual.info.withReadStatus(() => actual.info[method]("2")).value, expected.info[method]("2"),
      "native missing-table index error retries instead of confirming absence");
  }

  const person = fixture({ dependencies: { coreMissingWorksForPerson: (_person, keys) => keys.has("bb002") ? [] : [{
    id: "missing-bb", personId: "1", title: "BB-002", directoryName: "BB-002", missingLocal: true,
    videos: [], images: [], infos: [], infoSummary: { code: "BB-002", title: "Metadata 2", rating: 4.8 }
  }] } });
  const personExpected = fixture({ dependencies: { coreMissingWorksForPerson: () => [] } });
  fault(person, "row", "all"); assert.equal(person.personDetail.detailPayload("1", workInfoUrl()).total, 3);
  person.state.failure = null;
  equal(person.personDetail.detailPayload("1", workInfoUrl()), personExpected.personDetail.detailPayload("1", workInfoUrl()),
    "person detail sources must retry failed local-code exclusions at the same stamp");

  const actorFixture = fixture(), actor = createActorMovieForWorkInfoFixture(actorFixture);
  fault(actorFixture, "row", "all");
  const missing = actor.missingSearchResult(); assert.equal(missing.works.length, 2); assert.equal(missing.cacheable, false);
  actorFixture.state.failure = null;
  equal(actor.missingSearchResult(), { works: [], cacheable: true }, "actor derived missing cache cannot retain failed work-info code keys");
  const reads = { ...actorFixture.state.counts };
  equal(actor.missingSearchWorks(), [], "the legacy missing array API retains successful reuse");
  assert.deepEqual(actorFixture.state.counts, reads);
  actorFixture.info.invalidate(); actorFixture.code.invalidate(); fault(actorFixture, "row", "all");
  assert.equal(actor.enrichLocalWorksWithIndexResult(actorFixture.works).cacheable, false);
  actorFixture.state.failure = null;
  assert.equal(actor.enrichLocalWorksWithIndexResult(actorFixture.works).works[1].infoSummary.rating, 4.8);

  const search = fixture(), searchExpected = fixture();
  function actorQuery(target) {
    const provider = createActorMovieForWorkInfoFixture(target);
    const deps = { ...target.dependencies, actorMissingSearchResult: provider.missingSearchResult,
      actorMissingSearchWorks: provider.missingSearchWorks };
    const grouped = createFanhaoDependencies(new Proxy(deps, {
      get: (object, key) => Object.hasOwn(object, key) ? object[key] : () => {}
    }));
    return createWorkQueryService({ ...grouped.works, library: target.library });
  }
  const searchQuery = actorQuery(search), healthySearch = actorQuery(searchExpected);
  const request = new URL("http://fixture.test/api/works?q=metadata%20query&sort=ratingDesc&limit=48");
  fault(search, "row", "all"); assert.equal(searchQuery.searchPayload(request).total, 4);
  search.state.failure = null;
  equal(searchQuery.searchPayload(request), healthySearch.searchPayload(request),
    "actual composition search source and page must release actor missing results derived from failed local work-info keys");

  const empty = fixture({ count: 0 });
  for (const method of ["row", "facetRow", "detailRow"]) {
    const result = empty.info.withReadStatus(() => empty.info[method]("2"));
    equal(result, { value: null, cacheable: true }, "confirmed absence remains a successful cacheable result");
    empty.info[method]("2");
  }
  assert.deepEqual(empty.state.counts, { row: 1, facet: 1, detail: 1, other: 0 });
  const prewarmed = fixture(); prewarmed.query.prewarm();
  assert.deepEqual(prewarmed.state.counts, { row: 0, facet: 1, detail: 1, other: 0 }, "healthy prewarm still batches metadata once per projection");
  prewarmed.query.prewarm();
  assert.deepEqual(prewarmed.state.counts, { row: 0, facet: 1, detail: 1, other: 0 }, "warm prewarm retains successful facet, row DTO and page reuse");
  const full = fixture(), compatible = fixture({ connectStatus: false });
  equal(full.query.listPayload(workInfoUrl()), compatible.query.listPayload(workInfoUrl()), "optional-reader-free healthy list DTO remains compatible");
  equal(full.detail.detailPayload("2"), compatible.detail.detailPayload("2"), "optional-reader-free healthy detail DTO remains compatible");

  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const wrappers = server.slice(server.indexOf("function withWorkInfoReadStatus("), server.indexOf("function workInfoFacetRow("));
  const connect = new Function("workInfoService", wrappers + "\nreturn {withWorkInfoReadStatus,workInfoReadCacheable};");
  const production = connect(full.info);
  assert.deepEqual(production.withWorkInfoReadStatus(() => 7), { value: 7, cacheable: true });
  assert.equal(production.workInfoReadCacheable(), true);
  assert.equal(full.grouped.works.withWorkInfoReadStatus, full.info.withReadStatus);
  assert.equal(full.grouped.userState.withWorkInfoReadStatus, full.info.withReadStatus);
  assert.equal(full.grouped.works.workInfoReadCacheable, full.info.readCacheable);
  assert.equal(full.grouped.userState.workInfoReadCacheable, full.info.readCacheable);
  console.log(JSON.stringify({ ok: true, comparisons, fallbackComparisons, warnings: warnings.length,
    privateDatabases: fixtures.length + 1, failedFacetPrewarmQueries: 1, healthyPrewarmQueries: { facet: 1, detail: 1 },
    warmPrewarmQueries: 0, normalDetailOneShotQueries: 3,
    partialDetailBatchRows: 205, partialDetailQueries: 7, nestedScope: true, nativeSql: true }));
} finally {
  console.warn = warn;
  for (const target of fixtures) if (target.state.db.isOpen) target.close();
}

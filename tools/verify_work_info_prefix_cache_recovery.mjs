import assert from "node:assert/strict";
import fs from "node:fs";
import { createCodePrefixService } from "../src/modules/fanhao/server/catalog/code-prefix-service.js";
import { createWorkInfoCacheFixture, clampInteger } from "./fixtures/work-info-cache-recovery.mjs";

// Native private SQLite and the real prefix service, provider, filters, sorter,
// presenter and production constructor/page adapters. No server is started.
const args = process.argv.slice(2);
assert(args.every(value => value === "--legacy-prefix-work-info-status"));
const legacy = args.includes("--legacy-prefix-work-info-status");
const owners = [], warnings = [], warn = console.warn;
let cases = 0, comparisons = 0;
console.warn = (...values) => warnings.push(values);
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const constructorStart = server.indexOf("const codePrefixService = createCodePrefixService({");
const constructorEnd = server.indexOf("\n});", constructorStart) + 4;
assert(constructorStart > 0 && constructorEnd > constructorStart);
const pageStart = server.indexOf("function pagedWorksPayload("), pageEnd = server.indexOf("\nfunction ", pageStart + 10);
assert(pageStart > 0 && pageEnd > pageStart);

try {
  for (const phase of ["prepare", "all"]) {
    for (const filter of ["info", "rated", "highRating"]) {
      const actual = fixture(), expected = fixture(), previous = fixture({ status: false });
      actual.state.failure = previous.state.failure = { reader: "facet", phase };
      const failed = page(actual, { filter });
      equal(failed, page(previous, { filter }), "failed WorkInfo filters preserve the complete old prefix fallback");
      assert.equal(failed.total, 0);
      if (!legacy) assert.equal(actual.state.counts.facet, 1, "one failed index serves the entire synchronous prefix operation");
      actual.state.failure = null;
      // A successfully primed provider cannot conceal a poisoned prefix result.
      actual.info.facetRowsById();
      equal(page(actual, { filter, limit: "1" }), page(expected, { filter, limit: "1" }),
        "same-stamp prefix filters/facets must retry under a fresh page size");
      equal(page(actual, { filter }), page(expected, { filter }), "the original failed prefix page must recover too");
      const counts = { ...actual.state.counts }, sorts = actual.prefixCounts.sorts;
      equal(page(actual, { filter }), page(expected, { filter }), "healthy prefix responses retain their complete API");
      assert.deepEqual(actual.state.counts, counts); assert.equal(actual.prefixCounts.sorts, sorts); cases++;
    }
    for (const sort of ["ratingDesc", "releaseDesc", "durationDesc", "updated"]) {
      const actual = fixture(), expected = fixture(), previous = fixture({ status: false });
      actual.state.failure = previous.state.failure = { reader: "facet", phase };
      equal(page(actual, { sort }), page(previous, { sort }), "failed sort/facet fallbacks retain the complete previous prefix DTO");
      actual.state.failure = null;
      equal(page(actual, { sort, limit: "1", offset: "1" }), page(expected, { sort, limit: "1", offset: "1" }),
        "a prefix result must release fallback order and facets after metadata recovery");
      equal(page(actual, { sort }), page(expected, { sort }), "same-key prefix sorting and statistics recover"); cases++;
    }
    const actual = fixture(), expected = fixture(), previous = fixture({ status: false });
    actual.state.failure = previous.state.failure = { reader: "detail", phase };
    const failed = page(actual);
    equal(failed, page(previous), "permanent detail failures keep the existing prefix metadata fallback");
    assert.equal(failed.works[0].infoSummary, null);
    actual.state.failure = null;
    equal(page(actual), page(expected), "prefix presentation retries failed detail rows at the same stamp");
    equal(page(actual, { limit: "1", offset: "1" }), page(expected, { limit: "1", offset: "1" }),
      "an alternate prefix page contains complete recovered detail summaries"); cases++;

    const once = fixture(), onceExpected = fixture();
    once.state.failure = { reader: "detail", phase, once: true };
    equal(page(once), page(onceExpected), "one-shot failed detail prewarm still allows the existing per-row retries");
    assert.equal(once.state.counts.detail, 3);
    const sorts = once.prefixCounts.sorts, detailReads = once.state.counts.detail;
    equal(page(once), page(onceExpected), "successful retry DTOs remain complete");
    assert.equal(once.prefixCounts.sorts, sorts, "successful filter/sort derivations stay reusable after a later presentation failure");
    assert.equal(once.state.counts.detail, detailReads); cases++;

    const warm = fixture(), warmPrevious = fixture({ status: false }), warmExpected = fixture();
    page(warm, { filter: "highRating" }); page(warmPrevious, { filter: "highRating" });
    for (const target of [warm, warmPrevious, warmExpected]) update(target);
    warm.state.failure = warmPrevious.state.failure = { reader: "facet", phase };
    equal(page(warm, { filter: "highRating" }), page(warmPrevious, { filter: "highRating" }),
      "warm new-stamp failures preserve the complete old-facet fallback response");
    warm.state.failure = null;
    for (const filter of ["all", "info", "rated", "highRating"]) equal(page(warm, { filter }), page(warmExpected, { filter }),
      "failed warm fallbacks cannot occupy the new stamp's prefix filter/sort/facet result"); cases++;
  }

  for (const reader of ["facet", "detail"]) {
    const actual = fixture(), expected = fixture();
    actual.state.failure = { reader, phase: "all" };
    actual.prefix.prewarm();
    assert.equal(actual.state.counts[reader], 0, "prefix catalog prewarm does not introduce a WorkInfo projection or public DTO read");
    page(actual);
    actual.state.failure = null;
    equal(page(actual), page(expected), "a prewarmed catalog does not retain failed WorkInfo result derivations"); cases++;
  }

  for (const filter of ["info", "rated", "highRating", "all"]) {
    const actual = fixture(), expected = fixture();
    // The prefix's independent maker/catalog SQL is already healthy. A real
    // Works table error now isolates its WorkInfo-derived result admission.
    actual.prefix.prewarm();
    actual.state.db.exec("ALTER TABLE works RENAME TO unavailable_works");
    const failed = page(actual, { filter });
    if (filter !== "all") assert.equal(failed.total, 0);
    actual.state.db.exec("ALTER TABLE unavailable_works RENAME TO works");
    actual.info.facetRowsById();
    equal(page(actual, { filter }), page(expected, { filter }), "native missing-table prefix derivations recover without a metadata stamp bump"); cases++;
  }
  const detailNative = fixture(), detailExpected = fixture();
  detailNative.prefix.prewarm();
  detailNative.state.db.exec("ALTER TABLE fanhao_images.images RENAME TO unavailable_images");
  assert.equal(page(detailNative).works[0].infoSummary, null);
  detailNative.state.db.exec("ALTER TABLE fanhao_images.unavailable_images RENAME TO images");
  equal(page(detailNative), page(detailExpected), "native attached-cover SQL failures do not poison prefix metadata presentation"); cases++;

  const empty = fixture(), emptyExpected = fixture();
  for (const target of [empty, emptyExpected]) target.state.db.exec("UPDATE works SET rating=2.1");
  const noRows = page(empty, { filter: "highRating" });
  assert.equal(noRows.count, 0); equal(noRows, page(emptyExpected, { filter: "highRating" }), "confirmed empty prefix selections remain successful");
  const emptySorts = empty.prefixCounts.sorts, emptyCounts = { ...empty.state.counts };
  page(empty, { filter: "highRating" });
  assert.equal(empty.prefixCounts.sorts, emptySorts); assert.deepEqual(empty.state.counts, emptyCounts);
  assert.equal(empty.prefix.detailPayload("ZZ", request()), null); assert.equal(empty.prefix.detailPayload("invalid/prefix", request()), null); cases++;

  const scoped = fixture(), scopedExpected = fixture(), sentinel = new Error("original private prefix sort exception");
  scoped.state.failure = { reader: "facet", phase: "all" }; scoped.state.afterSortError = sentinel;
  const parent = scoped.info.withReadStatus(() => {
    assert.throws(() => page(scoped), error => error === sentinel);
    return "unchanged parent fallback";
  });
  assert.equal(parent.cacheable, false); assert.equal(scoped.info.readCacheable(), true);
  scoped.state.failure = null; scoped.state.afterSortError = null;
  equal(page(scoped), page(scopedExpected), "throwing prefix scopes release their failure memo and never cache their failed derivations"); cases++;

  const healthy = fixture(), oldApi = fixture({ status: false });
  healthy.prefix.prewarm(); oldApi.prefix.prewarm();
  for (const options of [{}, { filter: "highRating" }, { limit: "1", offset: "1" }, { family: "1" }, { sort: "title", includeHidden: "1" }]) {
    equal(page(healthy, options), page(oldApi, options), "healthy optional-reader-free constructor retains its entire prefix API");
  }
  equal(healthy.prefix.summaries(request()), oldApi.prefix.summaries(request()), "prefix summaries remain unchanged");
  const count = healthy.prefixCounts.sorts;
  const small = page(healthy, { limit: "1" });
  equal(page(healthy, { limit: "1", offset: "1" }), page(oldApi, { limit: "1", offset: "1" }), "pagination reuses the sorted prefix source");
  assert.equal(healthy.prefixCounts.sorts, count); assert.equal(small.limit, 1);
  for (const target of [healthy, oldApi]) update(target);
  equal(page(healthy), page(oldApi), "metadata stamp changes retain their existing prefix invalidation behavior");
  healthy.prefix.invalidate(); oldApi.prefix.invalidate();
  equal(page(healthy), page(oldApi), "explicit prefix invalidation remains compatible"); cases++;
  console.log(JSON.stringify({ ok: true, cases, completeComparisons: comparisons, nativeSql: true,
    directProductionConstructor: true, directProductionPageAdapter: true, failedIndexReadsPerOperation: 1,
    sourceAndSortReusePreserved: true, optionalConstructorCompatible: true }));
} finally {
  console.warn = warn;
  for (const owner of owners) if (owner.state.db.isOpen) owner.close();
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message); comparisons++;
}
function request(options = {}) {
  return new URL("http://fixture.test/api/code-prefixes/AA?" + new URLSearchParams({ filter: "all", sort: "ratingDesc", limit: "48", ...options }));
}
function page(owner, options = {}) { return owner.prefix.detailPayload("AA", request(options)); }
function update(owner) {
  owner.state.stamp = "next";
  owner.state.db.exec("UPDATE works SET title=title||' revised', rating=CASE id WHEN 1 THEN 4.9 ELSE 2.1 END,release_date='2027-01-01',duration_minutes=180-id*60");
}
function fixture({ status = !legacy } = {}) {
  const owner = createWorkInfoCacheFixture(); owners.push(owner);
  for (const work of owner.works) { work.code = `AA-${work.id.padStart(3, "0")}`; work.directoryName = work.code; }
  owner.state.db.exec("UPDATE works SET code='AA-002',code_search='aa002' WHERE id=2");
  owner.prefixCounts = { sorts: 0, catalog: 0 };
  const adapter = new Function("clampInteger", "DEFAULT_WORK_LIMIT", "MAX_WORK_LIMIT", "prewarmCoreWorkCovers", "prewarmWorkInfoDetails", "publicWork", "prewarmRemoteImagesForWorks",
    server.slice(pageStart, pageEnd) + "\nreturn pagedWorksPayload;")(
    clampInteger, 48, 1000, () => {}, owner.dependencies.prewarmWorkInfoDetails, owner.presenter.publicWork, () => {});
  const dependencies = {
    createCodePrefixService, withWorkInfoReadStatus: status ? owner.info.withReadStatus : undefined,
    workInfoReadCacheable: status ? owner.info.readCacheable : undefined,
    withWorkSearchReadStatus: undefined, workSearchReadCacheable: undefined,
    clampInteger, dedupeWorksForDisplay: rows => rows, DEFAULT_WORK_LIMIT: 48, MAX_WORK_LIMIT: 1000,
    missingCodeSearchService: { search: () => [], hydrate: () => {} },
    workFilterService: { filter: owner.dependencies.filterWorkList },
    getCoreDb: () => ({ prepare(sql) { owner.prefixCounts.catalog++; return owner.state.db.prepare(sql); } }),
    library: owner.library, studioCatalogStamp: () => owner.state.stamp, pagedWorksPayload: adapter,
    sortWorkList(works, sort) {
      owner.prefixCounts.sorts++;
      const value = owner.dependencies.sortWorkList(works, sort);
      if (owner.state.afterSortError) throw owner.state.afterSortError;
      return value;
    },
    accountUserStateService: { revision: () => "private user" },
    workClassificationService: owner.dependencies.workClassificationService,
    workFacets: owner.dependencies.workFacets, workQueryStamp: () => owner.state.stamp
  };
  owner.prefix = new Function(...Object.keys(dependencies), server.slice(constructorStart, constructorEnd) + "\nreturn codePrefixService;")(...Object.values(dependencies));
  return owner;
}

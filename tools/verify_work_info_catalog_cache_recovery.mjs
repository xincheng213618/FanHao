import assert from "node:assert/strict";
import fs from "node:fs";
import { createRankingService } from "../src/modules/fanhao/server/catalog/ranking-service.js";
import { createStudioService } from "../src/modules/fanhao/server/catalog/studio-service.js";
import { createWorkInfoCacheFixture, clampInteger, codeKey, looseCodeKey, parseJson } from "./fixtures/work-info-cache-recovery.mjs";

// The real provider, presenter, code index and catalog SQL over private native
// SQLite. Negatives remove only a catalog's optional status dependencies;
// provider retry behavior and the ranking's existing SQL/cover fallback stay.
const args = process.argv.slice(2);
assert(args.every(value => ["--legacy-ranking-work-info-status", "--legacy-studio-work-info-status"].includes(value)));
const owners = [], warnings = [], warn = console.warn;
let cases = 0, comparisons = 0;
console.warn = (...values) => warnings.push(values);
try {
  // Summaries build their own local/missing counts from the code index. A
  // working ranking query cannot make a failed WorkInfo dependency cacheable.
  for (const phase of ["prepare", "all"]) {
    for (const prewarm of [false, true]) {
      const actual = fixture(), expected = fixture(), previous = fixture({ rankingStatus: false });
      actual.state.failure = previous.state.failure = { reader: "row", phase };
      if (prewarm) { actual.ranking.prewarm(); previous.ranking.prewarm(); }
      const fallback = actual.ranking.summaries();
      equal(fallback, previous.ranking.summaries(), "failed code-index reads retain the complete original ranking summary fallback");
      assert.equal(fallback[0].localTotal, 0); assert.equal(fallback[0].missingTotal, 2);
      actual.state.failure = null;
      assert.equal(actual.code.localCodeKeys().size, 2, "the recovered code index alone must not hide poisoned upper summaries");
      const recovered = actual.ranking.summaries();
      equal(recovered, expected.ranking.summaries(), "direct and prewarmed ranking summaries retry their failed local counts at the same stamp");
      assert.equal(recovered[0].localTotal, 2); assert.equal(recovered[0].missingTotal, 0);
      const counts = { ...actual.state.counts };
      assert.equal(actual.ranking.summaries(), recovered, "healthy complete summary arrays still reuse their cache");
      assert.deepEqual(actual.state.counts, counts); cases++;
    }
    const actual = fixture(), expected = fixture();
    equal(actual.ranking.summaries(), expected.ranking.summaries(), "initial successful ranking summaries remain identical");
    for (const owner of [actual, expected]) {
      owner.state.stamp = "summary-revision";
      owner.state.db.exec("UPDATE works SET code='CC-777',code_search='cc777' WHERE id=1");
    }
    actual.state.failure = { reader: "row", phase };
    const fallback = actual.ranking.summaries();
    assert.equal(fallback[0].localTotal, 1, "a warm prior index remains the existing fallback after metadata changes");
    actual.state.failure = null;
    const recovered = actual.ranking.summaries();
    equal(recovered, expected.ranking.summaries(), "old successful metadata fallbacks cannot become the new stamp's ranking summary cache");
    assert.equal(recovered[0].localTotal, 2); cases++;
  }
  const nativeSummary = fixture(), nativeSummaryExpected = fixture();
  nativeSummary.state.db.exec("ALTER TABLE works DROP COLUMN has_subtitles");
  const nativeFallback = nativeSummary.ranking.summaries();
  assert.equal(nativeFallback[0].total, 2, "the ranking's own SQL still succeeds while the native WorkInfo row projection fails");
  assert.equal(nativeFallback[0].localTotal, 0);
  nativeSummary.state.db.exec("ALTER TABLE works ADD COLUMN has_subtitles INTEGER DEFAULT 1");
  assert.equal(nativeSummary.code.localCodeKeys().size, 2);
  equal(nativeSummary.ranking.summaries(), nativeSummaryExpected.ranking.summaries(), "native WorkInfo column restoration recovers full same-stamp ranking summaries"); cases++;

  for (const phase of ["prepare", "all"]) {
    for (const missing of [false, true]) {
      const actual = fixture(), expected = fixture(), previous = fixture({ rankingStatus: false });
      actual.state.failure = previous.state.failure = { reader: "row", phase };
      const read = missing ? owner => owner.ranking.missingSearchResult() : owner => rankingPage(owner);
      const fallback = read(actual);
      if (missing) equal(fallback.works, read(previous).works, "the old array API's code-index fallback response remains complete and unchanged");
      else equal(fallback, read(previous), "the old code-index fallback response remains complete and unchanged");
      if (missing) { assert.equal(fallback.works.length, 2); assert.equal(fallback.cacheable, false); }
      else { assert.equal(fallback.localTotal, 0); assert.equal(fallback.missingTotal, 2); }
      assert.equal(actual.state.counts.row, 1, "one failed row-index SQL per catalog request");
      actual.state.failure = null;
      const recovered = read(actual);
      equal(recovered, read(expected), "ranking code-index failure must not occupy its prepared source/page/missing cache at the same stamp");
      if (missing) { assert.equal(recovered.works.length, 0); assert.equal(recovered.cacheable, true); }
      else assert.equal(recovered.localTotal, 2);
      const counts = { ...actual.state.counts };
      if (missing) assert.equal(actual.ranking.missingSearchWorks(), recovered.works, "the old array API still returns the cached array");
      else assert.equal(rankingPage(actual), recovered);
      assert.deepEqual(actual.state.counts, counts);
      equal(rankingPage(actual, { limit: "1", offset: "1" }), rankingPage(expected, { limit: "1", offset: "1" }), "a different ranking page uses the recovered source");
      cases++;
    }
    for (const kind of ["ranking", "studio"]) {
      const actual = fixture(), expected = fixture(), previous = fixture({ rankingStatus: false, studioStatus: false });
      actual.state.failure = previous.state.failure = { reader: "detail", phase };
      const read = kind === "ranking" ? rankingPage : studioPage;
      const fallback = read(actual);
      equal(fallback, read(previous), "permanent detail SQL failure retains the old public catalog fallback");
      assert.equal(fallback.works[0].infoSummary, null);
      actual.state.failure = null;
      const recovered = read(actual);
      equal(recovered, read(expected), "catalog pages and prepared DTOs must retry failed detail rows at the same stamp");
      const counts = { ...actual.state.counts };
      assert.equal(read(actual), recovered); assert.deepEqual(actual.state.counts, counts);
      equal(read(actual, { limit: "1", offset: "1" }), read(expected, { limit: "1", offset: "1" }), "a fresh page cannot reuse a failed per-work DTO");
      cases++;
    }
    for (const filter of ["info", "rated", "highRating"]) {
      const actual = fixture(), expected = fixture(), previous = fixture({ studioStatus: false });
      actual.state.failure = previous.state.failure = { reader: "facet", phase };
      const fallback = studioPage(actual, { filter });
      equal(fallback, studioPage(previous, { filter }), "failed studio filters keep the exact old empty response");
      assert.equal(fallback.total, 0); assert.equal(actual.state.counts.facet, 1);
      actual.state.failure = null;
      // Bypass the previous page key to prove the filter and facets separately.
      equal(studioPage(actual, { filter, limit: "1" }), studioPage(expected, { filter, limit: "1" }), "failed filter/facet arrays cannot survive under another studio page key");
      const recovered = studioPage(actual, { filter });
      equal(recovered, studioPage(expected, { filter }), "the failed studio page also recovers at the same stamp");
      assert.equal(studioPage(actual, { filter }), recovered);
      cases++;
    }
    for (const sort of ["ratingDesc", "releaseDesc", "durationDesc", "updated"]) {
      const actual = fixture(), expected = fixture(), previous = fixture({ studioStatus: false });
      actual.state.failure = previous.state.failure = { reader: "facet", phase };
      const fallback = studioPage(actual, { sort });
      equal(fallback, studioPage(previous, { sort }), "failed studio sorting/facets retain the old complete response");
      assert.equal(fallback.facets.rated, 0); assert.equal(actual.state.counts.facet, 1);
      actual.state.failure = null;
      equal(studioPage(actual, { sort, limit: "1" }), studioPage(expected, { sort, limit: "1" }), "failed sort/facets cannot become successful derivations on a fresh page");
      equal(studioPage(actual, { sort }), studioPage(expected, { sort }), "failed studio page recovers its metadata order and counts");
      cases++;
    }
  }
  for (const kind of ["ranking", "studio"]) {
    for (const phase of ["prepare", "all"]) {
      const actual = fixture(), expected = fixture();
      actual.state.failure = { reader: "detail", phase, once: true };
      const read = kind === "ranking" ? rankingPage : studioPage;
      const first = read(actual);
      equal(first, read(expected), "one-shot detail prewarm errors still retry inside the same complete response");
      const second = read(actual);
      equal(second, first, "the next response retains the successful retry's exact DTOs");
      assert.notEqual(second, first, "an earlier failed prewarm still prevents page admission");
      assert.equal(read(actual), second); cases++;
    }
    for (const reader of kind === "ranking" ? ["row", "detail"] : ["facet", "detail"]) {
      const actual = fixture(), expected = fixture();
      actual.state.failure = { reader, phase: "all" };
      actual[kind].prewarm();
      if (reader !== "detail") assert.equal(actual.state.counts[reader], 1, "the entire synchronous prewarm shares one failed index read");
      actual.state.failure = null;
      const read = kind === "ranking" ? rankingPage : studioPage;
      equal(read(actual), read(expected), "a failed catalog prewarm cannot populate a same-stamp response or metadata derivation");
      actual[kind].prewarm(); equal(read(actual), read(expected), "healthy prewarm continues to reuse correct results"); cases++;
    }
    if (kind === "studio") {
      const actual = fixture(), expected = fixture();
      actual.state.failure = { reader: "detail", phase: "all", once: true };
      actual.studio.prewarm();
      const before = actual.catalogCounts.pages;
      equal(studioPage(actual, { sort: "releaseDesc" }), studioPage(expected, { sort: "releaseDesc" }), "a one-shot prewarm error keeps successful retry DTOs complete");
      assert.equal(actual.catalogCounts.pages, before + 1, "a failed studio prewarm cannot cache its matching 48-row page even after detail retries succeed");
      cases++;
    }
    // First populate valid code/cover/ordering sources but not the next work's
    // detail. A real attached-table prepare error now isolates page admission
    // from the ranking's already-successful, unchanged cover/cache path.
    const actual = fixture(), expected = fixture();
    const read = kind === "ranking" ? rankingPage : studioPage;
    read(actual, { limit: "1" });
    actual.state.db.exec("ALTER TABLE fanhao_images.images RENAME TO absent_images");
    assert.equal(read(actual, { limit: "1", offset: "1" }).works[0].infoSummary, null);
    actual.state.db.exec("ALTER TABLE fanhao_images.absent_images RENAME TO images");
    equal(read(actual, { limit: "1", offset: "1" }), read(expected, { limit: "1", offset: "1" }), "native attached-table failures must release the exact failed catalog page without a stamp bump"); cases++;
  }

  const sourceFailure = fixture({ sourceRead: true }), sourceExpected = fixture({ sourceRead: true });
  sourceFailure.state.failure = { reader: "row", phase: "all" };
  studioPage(sourceFailure);
  sourceFailure.state.failure = null;
  const reads = sourceFailure.state.counts.other;
  equal(studioPage(sourceFailure), studioPage(sourceExpected), "a WorkInfo read while resolving library source also stays retryable");
  assert(sourceFailure.state.counts.other > reads, "failed source admission must requery its catalog links"); cases++;

  const throwing = fixture(), throwingExpected = fixture();
  throwing.state.failure = { reader: "facet", phase: "all" };
  const sentinel = new Error("private catalog body throw after metadata fallback");
  throwing.state.afterSortError = sentinel;
  const parent = throwing.info.withReadStatus(() => {
    assert.throws(() => studioPage(throwing), error => error === sentinel);
    return "original exception preserved";
  });
  assert.equal(parent.cacheable, false, "a throwing catalog child propagates its earlier WorkInfo failure to its parent");
  assert.equal(throwing.info.readCacheable(), true, "the temporary catalog read scope is released in finally");
  throwing.state.failure = null; throwing.state.afterSortError = null;
  equal(studioPage(throwing), studioPage(throwingExpected), "a throwing catalog scope cannot retain failed metadata into another request"); cases++;

  const healthy = fixture(), oldApi = fixture({ rankingStatus: false, studioStatus: false });
  for (const owner of [healthy, oldApi]) {
    owner.ranking.prewarm(); owner.studio.prewarm();
  }
  for (const read of [rankingPage, studioPage]) {
    for (const options of [{}, { limit: "1", offset: "1" }, { filter: "highRating", sort: "ratingDesc" }, { seriesId: "1" }, { seriesId: "nonnumeric" }]) {
      equal(read(healthy, options), read(oldApi, options), "healthy legacy callers without optional status dependencies preserve the complete API");
    }
    const first = read(healthy), counts = { ...healthy.state.counts };
    assert.equal(read(healthy), first); assert.deepEqual(healthy.state.counts, counts);
  }
  equal(healthy.ranking.rows("top", "fixture"), oldApi.ranking.rows("top", "fixture"), "ranking rows array API is unchanged");
  equal(healthy.ranking.summaries(), oldApi.ranking.summaries(), "ranking summary API is unchanged");
  equal(healthy.studio.summaries(new URL("http://fixture/api/studios")), oldApi.studio.summaries(new URL("http://fixture/api/studios")), "studio summaries remain unchanged");
  for (const owner of [healthy, oldApi]) {
    owner.state.stamp = "next"; owner.state.db.exec("UPDATE works SET title='Revised metadata',rating=4.9 WHERE id=1");
    owner.studio.ensureCatalog().syncedAt = "private";
  }
  equal(rankingPage(healthy), rankingPage(oldApi), "normal metadata stamp changes still refresh ranking detail");
  equal(studioPage(healthy), studioPage(oldApi), "normal metadata stamp changes still refresh studio derivations");
  healthy.ranking.invalidateSearch(); healthy.studio.invalidate(); healthy.studio.ensureCatalog().syncedAt = "private";
  equal(rankingPage(healthy), rankingPage(oldApi), "explicit ranking invalidation preserves behavior");
  equal(studioPage(healthy), studioPage(oldApi), "explicit studio invalidation preserves behavior"); cases++;

  const empty = fixture({ count: 0 }), emptyExpected = fixture({ count: 0 });
  for (const read of [rankingPage, studioPage]) {
    const value = read(empty); assert.equal(value.count, 0);
    equal(value, read(emptyExpected), "confirmed empty catalog responses remain complete");
    assert.equal(read(empty), value);
  }
  assert.equal(empty.state.counts.row, 0); assert.equal(empty.state.counts.facet, 0); assert.equal(empty.state.counts.detail, 0);
  const missing = empty.ranking.missingSearchWorks(); assert.equal(empty.ranking.missingSearchWorks(), missing);
  const absentMaker = empty.studio.detailPayload("999", request()); assert.equal(absentMaker, null);
  assert.equal(empty.studio.detailPayload("999", request()), null); cases++;

  verifyBudgets();
  assert(warnings.length > 10);
  console.log(JSON.stringify({ ok: true, cases, completeAndSerializedComparisons: comparisons, actualSQLite: true,
    rankingSummaryCodeSourceMissingAndDetailRetry: true, studioSourceFilterSortFacetPageRetry: true,
    synchronousPrewarmFaultSQL: 1, oneShotDetailRetryPreserved: true, nativeAttachedTableRecovery: true,
    healthyLegacyAndEmptyReuse: true, originalPageAndDerivedBudgets: true }));
} finally {
  console.warn = warn;
  for (const owner of owners) if (owner.state.db.isOpen) owner.close();
  assert(owners.every(owner => !owner.state.db.isOpen), "all private native SQLite owners close on positive or negative exit");
}

function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), label + " serialized"); comparisons++;
}

function fixture({ count = 2, rankingStatus = !args.includes("--legacy-ranking-work-info-status"), studioStatus = !args.includes("--legacy-studio-work-info-status"), sourceRead = false, limits = {} } = {}) {
  const owner = createWorkInfoCacheFixture({ count }); owners.push(owner);
  owner.catalogCounts = { pages: 0, sorts: 0 };
  // Actual schema columns/relations from the shared native fixture. These
  // private indexes bound only the large-budget fixture's correlated reads.
  owner.state.db.exec(`CREATE INDEX local_catalog_work ON local_works(work_id);
    CREATE INDEX actor_catalog_work ON work_people(work_id,role);
    CREATE INDEX maker_catalog_work ON work_makers(work_id,role);
    CREATE INDEX series_catalog_work ON work_series(work_id);
    CREATE INDEX fanhao_images.cover_catalog_owner ON images(owner_type,owner_id,kind);`);
  const status = connected => connected ? { withWorkInfoReadStatus: owner.info.withReadStatus, workInfoReadCacheable: owner.info.readCacheable } : {};
  const deps = owner.dependencies;
  owner.ranking = createRankingService({ ...status(rankingStatus), clampInteger, createId: (prefix, value) => `${prefix}:${value}`,
    dbBoolOrNull: value => value == null ? null : Boolean(Number(value)), getCoreDb: owner.getCoreDb,
    getSearchStamp: () => owner.state.stamp, localWorkByCodeKey: owner.code.localWorkByCodeKey,
    localWorkCodeKeys: owner.code.localCodeKeys, looseWorkCodeKey: looseCodeKey, maxWorkLimit: limits.max || 1000,
    normalizeWorkCode: String, parseJsonTextArray: parseJson, prewarmCoreWorkCovers: () => {},
    prewarmWorkInfoDetails: deps.prewarmWorkInfoDetails, prewarmRemoteImagesForWorks: () => {},
    proxiedRemoteImageUrl: value => value || "", publicWork: owner.presenter.publicWork, storedWorkCodeKey: codeKey,
    userStateStamp: () => owner.state.stamp });
  const adapter = serverPageAdapter(owner, limits.max || 1000);
  owner.studio = createStudioService({ ...status(studioStatus), clampInteger, filterWorkList: deps.filterWorkList,
    getCoreDb: owner.getCoreDb, getLibrary: () => { if (sourceRead) owner.info.row("1"); return owner.library; },
    getStamp: () => owner.state.stamp, publicRemoteUrl: value => value || "", sortWorkList(works, sort) {
      owner.catalogCounts.sorts++;
      const result = deps.sortWorkList(works, sort);
      if (owner.state.afterSortError) throw owner.state.afterSortError;
      return result;
    },
    userStateStamp: () => owner.state.stamp, workClassificationService: deps.workClassificationService,
    workFacets: deps.workFacets, workQueryStamp: () => owner.state.stamp,
    prewarmWorkInfoDetails: deps.prewarmWorkInfoDetails, prewarmCoreWorkCovers: () => {},
    pagedWorksPayload(...input) { owner.catalogCounts.pages++; return adapter(...input); } });
  owner.studio.ensureCatalog().syncedAt = "private";
  return owner;
}

function serverPageAdapter(owner, max) {
  // Load the exact production adapter without importing/starting server.js.
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const begin = source.indexOf("function pagedWorksPayload("), end = source.indexOf("\nfunction ", begin + 10);
  assert(begin > 0 && end > begin);
  return new Function("clampInteger", "DEFAULT_WORK_LIMIT", "MAX_WORK_LIMIT", "prewarmCoreWorkCovers", "prewarmWorkInfoDetails", "publicWork", "prewarmRemoteImagesForWorks",
    source.slice(begin, end) + "\nreturn pagedWorksPayload;")(
    clampInteger, 48, max, () => {}, owner.dependencies.prewarmWorkInfoDetails, owner.presenter.publicWork, () => {});
}

function request(options = {}) {
  const url = new URL("http://fixture/api/catalog");
  for (const [key, value] of Object.entries({ key: "fixture", limit: "48", offset: "0", sort: "ratingDesc", ...options })) url.searchParams.set(key, value);
  return url;
}
function rankingPage(owner, options = {}) { return owner.ranking.worksPayload(request(options)); }
function studioPage(owner, options = {}) { return owner.studio.detailPayload("1", request(options)); }

function verifyBudgets() {
  const count = 257 * 48, actual = fixture({ count, limits: { max: 16000 } });
  const first = studioPage(actual, { sort: "updated", limit: "48" });
  for (let page = 1; page < 256; page++) assert.equal(studioPage(actual, { sort: "updated", limit: "48", offset: String(page * 48) }).count, 48);
  assert.equal(studioPage(actual, { sort: "updated", limit: "48" }), first, "all 256 normal studio pages still fit their original row budget");
  const large = studioPage(actual, { sort: "updated", limit: "16000" });
  assert.equal(large.count, count); assert.equal(large.total, count); assert.equal(large.limit, 16000);
  assert(large.works.every(work => work.infoSummary), "a page beyond retention budgets still contains complete current metadata DTOs");
  const again = studioPage(actual, { sort: "updated", limit: "16000" });
  equal(again, large, "oversized studio pages keep their complete response");
  assert.notEqual(again, large, "oversized studio pages do not enter the page budget");
  assert.equal(studioPage(actual, { sort: "updated", limit: "48" }), first, "a rejected oversized page does not evict ordinary pages");
  const rankingFirst = rankingPage(actual, { limit: "48" });
  for (let page = 1; page < 64; page++) rankingPage(actual, { limit: "48", offset: String(page * 48) });
  assert.equal(rankingPage(actual, { limit: "48" }), rankingFirst, "ranking retains its original 64-page LRU");
  rankingPage(actual, { limit: "48", offset: String(64 * 48) });
  // Touch page zero above, so adding the 65th page evicts the oldest page one.
  const pageOne = rankingPage(actual, { limit: "48", offset: "48" });
  assert.equal(rankingPage(actual, { limit: "48", offset: "48" }), pageOne);
  cases++;
}

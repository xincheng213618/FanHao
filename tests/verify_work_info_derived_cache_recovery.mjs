import assert from "node:assert/strict";
import { createWorkCodeIndexService } from "../src/modules/fanhao/server/works/work-code-index-service.js";
import { createCollectionQueryService } from "../src/modules/fanhao/server/user-state/collection-query-service.js";
import { createWorkInfoCacheFixture, createWorkInfoDatabase, codeKey, looseCodeKey } from "./fixtures/work-info-cache-recovery.mjs";

// Real provider, presenter, composition and consumers over private SQLite.
// The negative removes only these consumers' read-status dependency.
const args = process.argv.slice(2);
assert.ok(args.every(value => ["--legacy-derived", "--collections-only"].includes(value)));
const legacy = args.includes("--legacy-derived");
const owners = [], warnings = [], warn = console.warn;
console.warn = (...values) => warnings.push(values);
let comparisons = 0, cases = 0;
try {
  if (!args.includes("--collections-only")) {
    for (const phase of ["prepare", "all"]) {
      for (const reader of [owner => codeSnapshot(owner), owner => owner.code.workCodeKeys(owner.works[0]),
        owner => [...owner.code.keySetForWorks(owner.works)]]) {
        const actual = fixture(), expected = fixture();
        actual.state.failure = { reader: "row", phase };
        assert.deepEqual(reader(actual), Array.isArray(reader(expected)) ? [] : emptyCodeSnapshot());
        const failedReads = actual.state.counts.row;
        actual.state.failure = null;
        actual.info.invalidate(); actual.info.rowsById();
        equal(reader(actual), reader(expected), "code-index strong and weak caches must release failed metadata keys at the same stamp");
        assert.equal(failedReads, 1, "a batch uses one failed row-index SQL instead of retrying per work");
        const calls = { ...actual.state.counts }; reader(actual); assert.deepEqual(actual.state.counts, calls);
        cases++;
      }
      const actual = fixture(), expected = fixture();
      const old = codeSnapshot(actual);
      updateCode(actual); updateCode(expected);
      actual.state.failure = { reader: "row", phase };
      equal(codeSnapshot(actual), old, "a warm metadata failure retains its complete old code snapshot");
      actual.state.failure = null;
      equal(codeSnapshot(actual), codeSnapshot(expected), "old keys from a failed new-stamp read cannot become the new index"); cases++;
    }
    const bulk = fixture({ count: 200 });
    bulk.state.failure = { reader: "row", phase: "all" };
    assert.equal(bulk.code.localCodeKeys().size, 0); assert.equal(bulk.state.counts.row, 1);
    bulk.state.failure = null;
    assert.equal(bulk.code.localCodeKeys().size, 200); cases++;
    const native = fixture(), expected = fixture();
    native.state.db.close(); assert.equal(native.code.localCodeKeys().size, 0);
    native.state.db = createWorkInfoDatabase();
    equal(codeSnapshot(native), codeSnapshot(expected), "a native closed-owner failure is recoverable without changing the stamp"); cases++;
    const empty = fixture({ count: 0 });
    const noKeys = empty.code.localCodeKeys(); assert.equal(noKeys.size, 0);
    assert.equal(empty.code.localCodeKeys(), noKeys); assert.equal(empty.state.counts.row, 0); cases++;
    const valid = fixture();
    const keys = valid.code.workCodeKeys(valid.works[0]);
    assert.equal(valid.code.workCodeKeys(valid.works[0]), keys);
    assert.equal(valid.code.localWorkByCodeKey().get("aa001"), valid.works[0]);
    assert.deepEqual(valid.code.localWorksByCodePrefix("Local"), valid.works);
    valid.code.invalidate(); equal(codeSnapshot(valid), codeSnapshot(fixture()), "explicit code invalidation retains its healthy behavior"); cases++;
  }

  for (const phase of ["prepare", "all"]) for (const kind of ["favorites", "history"]) {
    for (const filter of ["info", "rated", "highRating"]) {
      const actual = fixture(), expected = fixture();
      actual.state.failure = { reader: "facet", phase };
      const fallback = page(actual, kind, { filter, sort: "ratingDesc" });
      assert.equal(fallback.total, 0);
      const failedReads = actual.state.counts.facet;
      actual.state.failure = null; actual.info.invalidate(); actual.info.facetRowsById();
      const recovered = page(actual, kind, { filter, sort: "ratingDesc" });
      equal(recovered, page(expected, kind, { filter, sort: "ratingDesc" }), "collection page caches must release failed metadata filters at the same stamp");
      assert.equal(failedReads, 1);
      assert.equal(page(actual, kind, { filter, sort: "ratingDesc" }), recovered);
      equal(page(actual, kind, { filter, sort: "title", limit: "1", offset: "1" }),
        page(expected, kind, { filter, sort: "title", limit: "1", offset: "1" }), "a fresh collection page also recovers its filter and facets"); cases++;
    }
    const actual = fixture(), expected = fixture();
    actual.state.failure = { reader: "detail", phase };
    const fallback = page(actual, kind);
    assert.equal(fallback.works[0].infoSummary, null);
    actual.state.failure = null;
    actual.info.detailRow("1", { includeMetadata: false });
    const recovered = page(actual, kind);
    equal(recovered, page(expected, kind), "collection prepared DTO and page caches must both retry failed detail reads");
    equal(page(actual, kind, { sort: "title", limit: "1", offset: "1" }),
      page(expected, kind, { sort: "title", limit: "1", offset: "1" }), "a different page cannot reuse a failed per-work DTO");
    const calls = { ...actual.state.counts };
    assert.equal(page(actual, kind), recovered); assert.deepEqual(actual.state.counts, calls); cases++;
  }
  for (const kind of ["favorites", "history"]) {
    const actual = fixture(), expected = fixture();
    actual.state.failure = { reader: "detail", phase: "all", once: true };
    const first = page(actual, kind);
    equal(first, page(expected, kind), "one-shot prewarm failure still retries detail rows in the same response");
    const second = page(actual, kind);
    equal(second, first, "successful per-work DTOs remain correct after a failed outer prewarm");
    assert.notEqual(second, first, "the failed prewarm response cannot enter the page cache");
    assert.equal(page(actual, kind), second); cases++;
  }
  const native = fixture(), expected = fixture();
  native.state.db.exec("ALTER TABLE fanhao_images.images RENAME TO absent_images");
  assert.equal(page(native, "favorites").works[0].infoSummary, null);
  native.state.db.exec("ALTER TABLE fanhao_images.absent_images RENAME TO images");
  equal(page(native, "favorites"), page(expected, "favorites"), "native attached-cover SQL errors cannot poison collection DTOs"); cases++;
  const empty = fixture({ count: 0 });
  const none = page(empty, "favorites"); assert.equal(none.count, 0);
  assert.equal(page(empty, "favorites"), none); assert.equal(empty.state.counts.detail, 0); cases++;
  const prewarm = fixture(), prewarmExpected = fixture();
  prewarm.state.failure = { reader: "facet", phase: "all" };
  prewarm.collection.prewarm();
  assert.equal(prewarm.state.counts.facet, 1, "one failed index read serves a complete synchronous collection prewarm");
  prewarm.state.failure = null;
  equal(page(prewarm, "favorites"), page(prewarmExpected, "favorites"), "collection prewarm cannot retain failed facets in its pages");
  equal(page(prewarm, "history"), page(prewarmExpected, "history"), "the next history request leaves the failed prewarm scope"); cases++;
  const versions = fixture(), reference = fixture();
  page(versions, "favorites");
  for (const owner of [versions, reference]) {
    owner.state.stamp = "next"; owner.state.db.exec("UPDATE works SET rating=2.1, title='New metadata' WHERE id=2");
  }
  equal(page(versions, "favorites"), page(reference, "favorites"), "successful metadata revisions still invalidate collection state");
  const legacyApi = fixture({ status: false });
  equal(page(legacyApi, "history"), page(fixture(), "history"), "healthy callers without optional scope functions retain the old public API"); cases++;
  console.log(JSON.stringify({ ok: true, cases, completeComparisons: comparisons, codeStrongAndWeakRetry: true,
    collectionFilterFacetPageAndDtoRetry: true, failedIndexReadsPerBatch: 1, oneShotDetailRetryPreserved: true,
    nativeAttachedRecovery: true, successfulEmptyCachePreserved: true }));
} finally {
  console.warn = warn;
  for (const owner of owners) if (owner.state.db.isOpen) owner.close();
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message); comparisons++;
}
function fixture({ count = 2, status = !legacy } = {}) {
  const owner = createWorkInfoCacheFixture({ count }); owners.push(owner);
  const readStatus = status ? owner.info.withReadStatus : undefined;
  owner.code = createWorkCodeIndexService({ getLibrary: () => owner.library, getStamp: () => owner.state.stamp,
    looseWorkCodeKey: looseCodeKey, storedWorkCodeKey: codeKey, workInfoRow: owner.info.row, withWorkInfoReadStatus: readStatus });
  owner.collection = createCollectionQueryService({ ...owner.grouped.userState,
    withWorkInfoReadStatus: readStatus, workInfoReadCacheable: status ? owner.info.readCacheable : undefined });
  return owner;
}
function emptyCodeSnapshot() { return { keys: [], rows: [], search: [["local1", "1"], ["local2", "2"]], prefix: ["1", "2"] }; }
function codeSnapshot(owner) {
  return owner.info.withReadStatus(() => ({ keys: [...owner.code.localCodeKeys()], rows: [...owner.code.localWorkByCodeKey()].map(([key, work]) => [key, work.id]),
    search: [...owner.code.localSearchWorkByCodeKey()].map(([key, work]) => [key, work.id]),
    prefix: owner.code.localWorksByCodePrefix("Local").map(work => work.id) })).value;
}
function updateCode(owner) {
  owner.state.stamp = "next";
  owner.state.db.exec("UPDATE works SET code='CC-003', code_search='cc003' WHERE id=1");
}
function page(owner, kind, values = {}) {
  const url = new URL(`http://fixture.test/api/${kind}?` + new URLSearchParams({ limit: "48", ...values }));
  return kind === "favorites" ? owner.collection.favoritesPayload(url) : owner.collection.historyPayload(url);
}

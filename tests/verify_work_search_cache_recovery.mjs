import assert from "node:assert/strict";
import { createWorkSearchCacheFixture, searchUrl } from "./fixtures/work-search-cache-recovery.mjs";

assert.ok(process.argv.slice(2).every(value => ["--legacy-poison", "--legacy-consumers-only"].includes(value)));
const legacy = process.argv.includes("--legacy-poison");
const legacyConsumersOnly = process.argv.includes("--legacy-consumers-only");
assert.ok(!(legacy && legacyConsumersOnly), "provider and consumer negative controls are separate");
const fixtures = [], warnings = [], warn = console.warn;
let oracles = 0, fallbacks = 0;
console.warn = (...args) => warnings.push(args);
function fixture(options = {}) { const value = createWorkSearchCacheFixture({ legacy, connectConsumers: !legacyConsumersOnly, ...options }); fixtures.push(value); return value; }
function expected(options = {}) { return fixture({ legacy: false, connectConsumers: true, ...options }); }
function previous(options = {}) { return fixture({ legacy: true, ...options }); }
function equal(actual, expectedValue, message, fallback = false) {
  assert.deepEqual(actual, expectedValue, message);
  assert.equal(JSON.stringify(actual), JSON.stringify(expectedValue), message + " serialized DTO");
  oracles++; if (fallback) fallbacks++;
}
function fault(target, reader, phase, extra = {}) { target.state.failure = { reader, phase, ...extra }; }
function matches(target, query) { const matcher = target.text.createMatcher(query); return target.works.map(work => matcher(work)); }
function verifyConsumerNegativeControl() {
  const results = [], failures = [];
  const cases = [
    { name: "text source/page", reader: "text", query: "needle phrase", filter: "all" },
    { name: "missing-prefix source/page", reader: "prefix", query: "AA", filter: "all" },
    { name: "late hydrate prepared DTO/page", reader: "hydrate", query: "AA", filter: "all", offset: 1 },
    { name: "prefix missing source/filter/result", reader: "prefix", query: "AA", filter: "missingLocal", prefix: true }
  ];
  for (const phase of ["prepare", "all"]) for (const item of cases) {
    const actual = fixture({ legacy: false, connectConsumers: false });
    const protectedConsumer = expected(), healthy = expected();
    const first = searchUrl(item.query, item.filter, "codeAsc", 1, item.offset || 0);
    const alternate = searchUrl(item.query, item.filter, item.reader === "hydrate" ? "codeAsc" : "releaseDesc", 2, item.offset || 0);
    const page = (target, url) => item.prefix ? target.prefix.detailPayload("AA", url) : target.query.searchPayload(url);
    for (const target of [actual, protectedConsumer]) {
      fault(target, item.reader, phase);
      page(target, first);
      target.state.failure = null;
      // Repair and prime only the real provider at the same stamp. The full
      // consumer DTO oracle below therefore isolates upper cache admission.
      if (item.reader === "text") {
        assert.deepEqual(matches(target, item.query), matches(healthy, item.query), "current text provider has independently recovered");
      } else {
        const rows = target.missing.hydrate(target.missing.search("AA"));
        assert.deepEqual(rows, healthy.missing.hydrate(healthy.missing.search("AA")), "current missing provider has independently recovered");
      }
    }
    for (const [variant, url] of [["alternate source/DTO", alternate], ["original page/result", first]]) {
      const message = `consumer-only same-stamp full DTO recovery: ${item.name} ${phase} ${variant}`;
      equal(page(protectedConsumer, url), page(healthy, url), "connected " + message);
      const actualDto = page(actual, url), expectedDto = page(healthy, url);
      const serializedDifferent = JSON.stringify(actualDto) !== JSON.stringify(expectedDto);
      try {
        equal(actualDto, expectedDto, message);
        results.push({ reader: item.name, phase, variant, failed: false, serializedDifferent });
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        results.push({ reader: item.name, phase, variant, failed: true, serializedDifferent });
        failures.push(error);
      }
    }
  }
  console.log(JSON.stringify({ consumerOnlyNegativeControl: results, protectedFullDtoOracles: oracles,
    nativeConnections: fixtures.length }));
  // Report the first complete recovery DTO difference, after exercising every
  // consumer boundary. No SQL-count or structural assertion masks this oracle.
  if (failures.length) throw failures[0];
  assert.fail("consumer-only negative control must expose an upper cache recovery DTO failure");
}
try {
  if (legacyConsumersOnly) {
    verifyConsumerNegativeControl();
  } else {
  for (const phase of ["prepare", "all"]) for (const reader of ["text", "actors", "makers", "series"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    for (const target of [actual, old]) fault(target, reader, phase);
    const failed = actual.text.withReadStatus(() => matches(actual, "needle phrase"));
    equal(failed.value, matches(old, "needle phrase"), "the complete old partial-map matcher fallback remains unchanged", true);
    if (!legacy) assert.equal(failed.cacheable, false);
    actual.state.failure = null;
    for (const query of ["needle phrase", "actor phrase", "label phrase", "maker", "series", "raw phrase", "fixture", "private", "", "n", "zz missing", "Metadata1"]) {
      equal(matches(actual, query), matches(healthy, query), "text/gram index retries the failed SQL at the same stamp");
    }
    const reads = { ...actual.state.counts };
    equal(matches(actual, "needle phrase"), matches(healthy, "needle phrase"), "healthy matcher keeps its successful index");
    assert.deepEqual(actual.state.counts, reads);
  }

  for (const phase of ["prepare", "all"]) for (const reader of ["text", "actors", "makers", "series", "cover", "prefix", "hydrate"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    const query = ["cover", "prefix", "hydrate"].includes(reader) ? "AA" : "needle phrase";
    const firstFilter = reader === "hydrate" ? "all" : "missingCover";
    fault(actual, reader, phase); fault(old, reader, phase);
    const failed = actual.adapters.withWorkSearchReadStatus(() => actual.query.searchPayload(searchUrl(query, firstFilter, "ratingDesc", 1)));
    if (!legacy) assert.equal(failed.cacheable, false, "each injected reader is actually consumed by its public search request");
    assert.ok(actual.state.counts[reader] > 0);
    equal(failed.value, old.query.searchPayload(searchUrl(query, firstFilter, "ratingDesc", 1)), "old public failed search DTO remains identical", true);
    actual.state.failure = null;
    // A different filter/order/page request first catches poisoned sources
    // even if the original response page was correctly kept out of its cache.
    for (const filter of ["all", "missingCover", "info", "rated", "highRating", "missingLocal"])
      for (const sort of ["ratingDesc", "releaseAsc", "updated", "codeAsc"])
        for (const offset of [0, 1]) {
          const url = searchUrl(query, filter, sort, 1, offset);
          equal(actual.query.searchPayload(url), healthy.query.searchPayload(url), "same-stamp source/filter/sort/DTO/page recovery");
        }
    const url = searchUrl(query, firstFilter, "ratingDesc", 1);
    equal(actual.query.searchPayload(url), healthy.query.searchPayload(url), "original failed page recovers at the same stamp");
    const complete = actual.query.searchPayload(url), reads = { ...actual.state.counts };
    assert.equal(actual.query.searchPayload(url), complete, "healthy public search page retains identity");
    assert.deepEqual(actual.state.counts, reads);
  }

  for (const phase of ["prepare", "all"]) for (const reader of ["cover", "prefix", "hydrate"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    fault(actual, reader, phase); fault(old, reader, phase);
    const first = searchUrl("AA", reader === "hydrate" ? "all" : "missingCover", "ratingDesc", 1, 2);
    const failed = actual.adapters.withWorkSearchReadStatus(() => actual.prefix.detailPayload("AA", first));
    if (!legacy) assert.equal(failed.cacheable, false);
    equal(failed.value, old.prefix.detailPayload("AA", first), "actual server prefix/page adapters preserve old failed DTOs", true);
    actual.state.failure = null;
    for (const filter of ["all", "missingCover", "highRating", "info", "rated", "missingLocal"])
      for (const sort of ["ratingDesc", "releaseAsc", "codeAsc"])
        for (const [limit, offset] of [[1, 0], [1, 2], [2, 1]]) {
          const url = searchUrl("AA", filter, sort, limit, offset);
          equal(actual.prefix.detailPayload("AA", url), healthy.prefix.detailPayload("AA", url),
            "same-stamp prefix source/filter/result/page/hydration recovery through actual server constructor");
        }
    equal(actual.prefix.detailPayload("AA", first), healthy.prefix.detailPayload("AA", first), "original prefix failure page also retries");
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    for (const target of [actual, old]) target.missing.prewarm();
    for (const target of [actual, old, healthy]) {
      target.state.db.exec("DELETE FROM fanhao_images.images WHERE owner_id=3");
      target.state.stamp = "next";
    }
    for (const target of [actual, old]) fault(target, "cover", phase);
    equal(actual.missing.search("AA"), old.missing.search("AA"), "warm cover failure retains the complete old cover-set fallback", true);
    actual.state.failure = null;
    equal(actual.missing.search("AA"), healthy.missing.search("AA"), "old cover fallback cannot poison prefix DTOs at the new stamp");
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    for (const target of [actual, old]) matches(target, "needle phrase");
    for (const target of [actual, old, healthy]) {
      target.state.db.exec("UPDATE works SET title=title||' refreshed phrase'");
      target.state.stamp = "next";
    }
    fault(actual, "makers", phase); fault(old, "makers", phase);
    equal(matches(actual, "refreshed phrase"), matches(old, "refreshed phrase"), "warm text failure keeps this attempt's partial map", true);
    actual.state.failure = null;
    equal(matches(actual, "label phrase"), matches(healthy, "label phrase"), "warm partial text map must retry later missing batches at the same stamp");
  }

  const native = fixture(), nativeExpected = expected();
  native.state.db.exec("ALTER TABLE fanhao_images.images RENAME TO unavailable_images");
  const nativeFailed = native.query.searchPayload(searchUrl("AA", "missingCover", "ratingDesc", 1));
  assert.ok(nativeFailed.works.every(work => work.personId === "" || work.id === "1"));
  native.state.db.exec("ALTER TABLE fanhao_images.unavailable_images RENAME TO images");
  equal(native.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1)), nativeExpected.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1)),
    "native attached-table cover and hydration errors recover without changing stamps");
  const nativePrefix = fixture(), nativePrefixExpected = expected();
  nativePrefix.state.db.exec("ALTER TABLE works RENAME TO unavailable_works");
  nativePrefix.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1));
  nativePrefix.state.db.exec("ALTER TABLE unavailable_works RENAME TO works");
  equal(nativePrefix.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1)),
    nativePrefixExpected.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1)), "native missing-work SQL schema restoration retries upper source and page");
  for (const table of ["works", "work_people", "makers", "series"]) {
    const actual = fixture(), healthy = expected();
    actual.state.db.exec(`ALTER TABLE ${table} RENAME TO unavailable_${table}`);
    actual.text.withReadStatus(() => matches(actual, "needle phrase"));
    actual.state.db.exec(`ALTER TABLE unavailable_${table} RENAME TO ${table}`);
    equal(matches(actual, "label phrase"), matches(healthy, "label phrase"), "native text query schema restoration retries the complete index");
  }

  const scoped = fixture({ count: 1002, localCount: 1002 });
  fault(scoped, "actors", "all");
  const outer = scoped.text.withReadStatus(() => {
    scoped.text.prewarm();
    for (const query of ["needle phrase", "actor phrase", "raw phrase"]) matches(scoped, query);
    assert.equal(scoped.text.withReadStatus(() => "independent value").cacheable, true);
    return "public return";
  });
  if (!legacy) {
    equal(outer, { value: "public return", cacheable: false }, "nested text status propagates without changing values", true);
    assert.equal(scoped.state.counts.actors, 1, "one operation reuses its failed map and grams across all works");
  }
  scoped.text.prewarm();
  assert.equal(scoped.state.counts.actors, 2, "an independent failed prewarm retries");
  scoped.state.failure = null;
  assert.ok(matches(scoped, "actor phrase").every(Boolean));

  const owner = fixture(), ownerExpected = expected();
  const ownerRead = owner.adapters.withWorkSearchReadStatus(() => {
    owner.state.db.close();
    equal(matches(owner, "needle phrase"), [false, false], "closed native owner uses the prior empty text fallback", true);
    owner.state.db = ownerExpected.state.db;
    equal(matches(owner, "needle phrase"), matches(ownerExpected, "needle phrase"), "new native owner retries inside the same failed outer scope");
    return "restored";
  });
  if (!legacy) assert.equal(ownerRead.cacheable, false);
  // The expected fixture owns the shared replacement; avoid closing it twice.
  owner.close = () => {};

  const missingOwner = fixture(), missingOwnerExpected = expected();
  const missingOwnerRead = missingOwner.adapters.withWorkSearchReadStatus(() => {
    missingOwner.state.db.close();
    equal(missingOwner.missing.search("AA"), [], "closed native missing owner preserves the old empty failure", true);
    missingOwner.state.db = missingOwnerExpected.state.db;
    equal(missingOwner.missing.hydrate(missingOwner.missing.search("AA")),
      missingOwnerExpected.missing.hydrate(missingOwnerExpected.missing.search("AA")),
      "replacement native owner retries cover/prefix/hydration in the same failed synchronous scope");
    return "restored owner";
  });
  if (!legacy) assert.equal(missingOwnerRead.cacheable, false);
  missingOwner.close = () => {};

  const invalidated = fixture(), invalidatedExpected = expected();
  fault(invalidated, "actors", "all");
  const invalidatedRead = invalidated.text.withReadStatus(() => {
    matches(invalidated, "actor phrase");
    invalidated.state.failure = null;
    invalidated.text.invalidate();
    equal(matches(invalidated, "actor phrase"), matches(invalidatedExpected, "actor phrase"),
      "invalidation releases operation-local failed maps and gram indexes");
    return "recovered match";
  });
  if (!legacy) assert.equal(invalidatedRead.cacheable, false, "invalidation preserves the outer operation's earlier failure");

  const scopedCovers = fixture();
  fault(scopedCovers, "cover", "all");
  const coverRead = scopedCovers.missing.withReadStatus(() => {
    scopedCovers.missing.prewarm();
    for (const prefix of ["AA", "AA0", "AA003", "BB", "missing"]) scopedCovers.missing.search(prefix);
    return "prefix arrays";
  });
  if (!legacy) {
    assert.equal(coverRead.cacheable, false);
    assert.equal(scopedCovers.state.counts.cover, 1, "one outer operation shares failed cover reads across prefixes");
  }
  scopedCovers.missing.prewarm();
  if (!legacy) assert.equal(scopedCovers.state.counts.cover, 2, "new failed cover prewarm retries at the same stamp");

  const missing = fixture(), missingExpected = expected();
  for (const reader of ["cover", "prefix", "hydrate"]) {
    fault(missing, reader, "all");
    const result = missing.adapters.withWorkSearchReadStatus(() => {
      const rows = missing.missing.search("AA");
      return missing.missing.hydrate(rows);
    });
    if (!legacy) assert.equal(result.cacheable, false);
    missing.state.failure = null;
    equal(missing.missing.hydrate(missing.missing.search("AA")), missingExpected.missing.hydrate(missingExpected.missing.search("AA")),
      "direct missing search/hydrate arrays remain retryable");
    missing.state.stamp = missingExpected.state.stamp = reader;
  }

  const healthy = fixture(), oldHealthy = previous();
  const cold = fixture();
  cold.text.prewarm();
  assert.deepEqual(cold.state.counts, { text: 1, actors: 1, makers: 1, series: 1, cover: 0, prefix: 0, hydrate: 0 },
    "healthy cold text prewarm retains the original four SQL projections");
  cold.text.prewarm(); matches(cold, "needle phrase");
  assert.deepEqual(cold.state.counts, { text: 1, actors: 1, makers: 1, series: 1, cover: 0, prefix: 0, hydrate: 0 },
    "healthy warm text prewarm and matcher construction perform no SQL");
  cold.missing.prewarm(); cold.missing.prewarm();
  assert.equal(cold.state.counts.cover, 1, "healthy cover prewarm retains one batch and warm reuse");
  const empty = fixture({ count: 0, localCount: 0 });
  assert.equal(empty.text.prewarm(), undefined);
  assert.equal(empty.text.createMatcher("empty phrase")({ id: "new", title: "empty phrase", personId: "1" }), true);
  assert.equal(empty.state.counts.text, 1, "a matcher reads metadata only when it receives an unindexed work");
  const emptyNoRead = fixture({ count: 0, localCount: 0 });
  emptyNoRead.text.prewarm(); emptyNoRead.text.prewarm();
  emptyNoRead.text.createMatcher("empty phrase"); emptyNoRead.text.createMatcher("");
  assert.deepEqual(emptyNoRead.state.counts, { text: 0, actors: 0, makers: 0, series: 0, cover: 0, prefix: 0, hydrate: 0 },
    "empty library prewarm and matcher construction preserve the original zero SQL reads");
  for (const query of ["AA", "AA003", "BB", "zz empty", "", "a"]) {
    equal(healthy.missing.search(query), oldHealthy.missing.search(query), "healthy prefix DTOs preserve full arrays, empties and order");
    const rows = healthy.missing.search(query), oldRows = oldHealthy.missing.search(query);
    assert.equal(healthy.missing.hydrate(rows), rows);
    equal(rows, oldHealthy.missing.hydrate(oldRows), "healthy hydration preserves arrays and complete row DTOs");
  }
  const extra = { id: "missing-extra", title: "extra phrase", personId: "1", videos: [], images: [], infos: [] };
  healthy.text.prewarm([extra]); oldHealthy.text.prewarm([extra]);
  equal(healthy.text.createMatcher("extra phrase")(extra), oldHealthy.text.createMatcher("extra phrase")(extra), "extra works retain prewarm coverage");
  for (const query of ["needle phrase", "raw phrase", "private", "", "n", "absent phrase"])
    equal(matches(healthy, query), matches(oldHealthy, query), "successful text and normalized matching remains identical");
  equal(healthy.missing.search("totally-empty"), [], "a successful empty prefix remains an ordinary complete value");
  const reads = { ...healthy.state.counts };
  equal(healthy.missing.search("totally-empty"), [], "successful empty prefix is reused");
  assert.deepEqual(healthy.state.counts, reads);
  const sentinel = new Error("callback exception");
  assert.throws(() => healthy.adapters.withWorkSearchReadStatus(() => { throw sentinel; }), error => error === sentinel);
  assert.equal(healthy.adapters.workSearchReadCacheable(), true, "exception cleanup releases all synchronous scopes");
  const caught = healthy.adapters.withWorkSearchReadStatus(() => {
    assert.throws(() => healthy.text.withReadStatus(() => { throw sentinel; }), error => error === sentinel);
    return "outer fallback";
  });
  if (!legacy) equal(caught, { value: "outer fallback", cacheable: false }, "caught child exceptions preserve original errors and failure admission", true);
  console.log(JSON.stringify({ workSearchCacheRecovery: "ok", oracles, fallbacks, nativeConnections: fixtures.length,
    textBatchReads: scoped.state.counts, warnings: warnings.length }));
  }
} finally {
  console.warn = warn;
  for (const value of fixtures) value.close();
}

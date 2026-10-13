import assert from "node:assert/strict";
import fs from "node:fs";
import { createCodePrefixService } from "../src/modules/fanhao/server/catalog/code-prefix-service.js";
import { createWorkSearchIndexService } from "../src/modules/fanhao/server/works/work-search-index-service.js";
import { createMissingCodeSearchService } from "../src/modules/fanhao/server/works/missing-code-search-service.js";
import { createWorkInfoCacheFixture, createWorkInfoDatabase, codeKey, parseJson, clampInteger }
  from "./fixtures/work-info-cache-recovery.mjs";

// Restore only the former opaque maker-read boundary for this negative. The
// native SQL, partial fallback map, other search scopes and budgets stay intact.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-maker-poison"));
const legacy = process.argv.includes("--legacy-maker-poison");
const moduleUrl = new URL("../src/modules/fanhao/server/catalog/code-prefix-service.js", import.meta.url);
let oldSource = fs.readFileSync(moduleUrl, "utf8");
assert.equal(oldSource.split("cacheable: loadedMakers.cacheable").length, 2);
oldSource = oldSource.replace("cacheable: loadedMakers.cacheable", "cacheable: true");
for (const relative of ["../works/work-code-prefix.js", "../works/work-cache-budget.js"]) {
  oldSource = oldSource.replace(JSON.stringify(relative), JSON.stringify(new URL(relative, moduleUrl).href));
}
const { createCodePrefixService: previousFactory } = await import(`data:text/javascript;base64,${Buffer.from(oldSource).toString("base64")}`);
const factories = [], warn = console.warn, warnings = [];
let cases = 0, comparisons = 0, fallbacks = 0, replacements = 0;
console.warn = (...values) => warnings.push(values);
function equal(actual, expected, message, fallback = false) {
  assert.deepEqual(actual, expected, message);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message + " serialized");
  comparisons++; if (fallback) fallbacks++;
}
function url(options = {}) {
  const value = new URL("http://fixture.test/api/code-prefixes");
  for (const [key, item] of Object.entries({ limit: "48", sort: "updated", ...options })) value.searchParams.set(key, item);
  return value;
}
function read(owner, endpoint, options = {}) {
  return endpoint === "summaries" ? owner.prefix.summaries(url(options)) : owner.prefix.detailPayload("AA", url(options));
}
function revise(owner) {
  owner.state.stamp = "revision";
  owner.state.db.exec("UPDATE makers SET name='Revised maker'");
}

try {
  for (const phase of ["prepare", "all", "iterate"]) for (const warm of [false, true]) {
    for (const endpoint of ["summaries", "detail"]) {
      const actual = fixture(), expected = fixture({ old: false }), previous = fixture({ old: true });
      if (warm) {
        for (const owner of [actual, expected, previous]) { read(owner, endpoint); revise(owner); }
      }
      for (const owner of [actual, previous]) owner.makerFailure = phase;
      const failed = read(actual, endpoint);
      equal(failed, read(previous, endpoint), "failed maker reads retain the complete original empty or partial fallback", true);
      actual.makerFailure = null;
      const recovered = read(actual, endpoint);
      equal(recovered, read(expected, endpoint), "code-prefix cache recovery: same-stamp catalog/source/result must retry the failed maker map");
      const reads = actual.makerReads;
      equal(read(actual, endpoint), recovered, "healthy catalog and detail results remain complete");
      assert.equal(actual.makerReads, reads, "successful maker maps still reuse their catalog pass");
      if (endpoint === "detail") {
        for (const options of [{ limit: "1", offset: "1" }, { sort: "title" }, { family: "1" }, { q: "maker", sort: "name" }]) {
          equal(read(actual, endpoint, options), read(expected, endpoint, options), "fresh detail parameters cannot reuse a failed maker source");
        }
      } else {
        equal(read(actual, endpoint, { q: warm ? "Revised maker" : "Maker" }),
          read(expected, endpoint, { q: warm ? "Revised maker" : "Maker" }), "maker-name summary searches recover all matching prefixes");
      }
      cases++;
    }
  }

  for (const warm of [false, true]) for (const entry of ["summaries", "detail", "prewarm"]) {
    const actual = fixture(), expected = fixture({ old: false }), previous = fixture({ old: true });
    if (warm) for (const owner of [actual, expected, previous]) { owner.prefix.prewarm(); read(owner, "detail"); revise(owner); }
    for (const owner of [actual, previous]) owner.state.db.exec("ALTER TABLE work_makers RENAME TO unavailable_work_makers");
    if (entry === "prewarm") { actual.prefix.prewarm(); previous.prefix.prewarm(); }
    const endpoint = entry === "prewarm" ? "summaries" : entry;
    equal(read(actual, endpoint), read(previous, endpoint), "native missing-table maker failures preserve the old full fallback response", true);
    for (const owner of [actual, previous]) owner.state.db.exec("ALTER TABLE unavailable_work_makers RENAME TO work_makers");
    equal(read(actual, "summaries"), read(expected, "summaries"), "native table recovery releases failed full catalog summaries");
    equal(read(actual, "summaries", { q: warm ? "Revised maker" : "Maker" }),
      read(expected, "summaries", { q: warm ? "Revised maker" : "Maker" }), "native table recovery restores maker-name query membership");
    equal(read(actual, "detail"), read(expected, "detail"), "native table recovery releases failed source and derived detail metadata");
    cases++;
  }

  const failedPrewarm = fixture(), prewarmExpected = fixture({ old: false });
  failedPrewarm.makerFailure = "all"; failedPrewarm.prefix.prewarm();
  failedPrewarm.prefix.prewarm(); assert.equal(failedPrewarm.makerReads, 2, "each failed prewarm retries its own catalog SQL");
  failedPrewarm.makerFailure = null;
  equal(read(failedPrewarm, "detail"), read(prewarmExpected, "detail"), "failed prewarm cannot stamp its empty maker map as success");
  const reads = failedPrewarm.makerReads; failedPrewarm.prefix.prewarm(); failedPrewarm.prefix.prewarm();
  assert.equal(failedPrewarm.makerReads, reads, "healthy repeated prewarm adds no maker SQL"); cases++;

  const owner = fixture(), ownerExpected = fixture({ old: false });
  owner.state.db.close();
  assert.equal(read(owner, "summaries").mappedCount, 0);
  owner.state.db = createWorkInfoDatabase({ count: 3 }); replacements++;
  equal(read(owner, "summaries"), read(ownerExpected, "summaries"), "a native closed database's fallback retries after same-stamp owner replacement");
  equal(read(owner, "detail"), read(ownerExpected, "detail"), "owner replacement returns complete current detail DTOs"); cases++;

  const empty = fixture(), emptyExpected = fixture({ old: false });
  for (const value of [empty, emptyExpected]) value.state.db.exec("DELETE FROM work_makers");
  equal(read(empty, "summaries"), read(emptyExpected, "summaries"), "confirmed absent makers remain a valid complete empty mapping");
  equal(read(empty, "detail"), read(emptyExpected, "detail"), "confirmed absent maker detail metadata remains complete");
  const emptyReads = empty.makerReads;
  read(empty, "summaries"); read(empty, "detail"); empty.prefix.prewarm();
  assert.equal(empty.makerReads, emptyReads, "successful empty maker mappings retain their cache"); cases++;

  const healthy = fixture(), oldApi = fixture({ old: false, status: false });
  equal(read(healthy, "summaries"), read(oldApi, "summaries"), "healthy old constructors without optional statuses retain their public summary API");
  equal(read(healthy, "detail"), read(oldApi, "detail"), "healthy old constructors without optional statuses retain full detail DTOs");
  healthy.prefix.invalidate();
  equal(read(healthy, "detail"), read(oldApi, "detail"), "explicit invalidation retains healthy responses"); cases++;
  assert.ok(warnings.length > 0);
  console.log(JSON.stringify({ ok: true, cases, completeAndSerializedComparisons: comparisons, fallbackComparisons: fallbacks,
    privateDatabases: factories.length + replacements, prepareAllAndPartialIteration: true,
    nativeColdWarmAndPrewarmRecovery: true, sameStampOwnerReplacement: true, makerNameQueryRecovery: true,
    successfulEmptyAndHealthyReuse: true, optionalStatusesUnchanged: true }));
} finally {
  console.warn = warn;
  for (const owner of factories) if (owner.state.db.isOpen) owner.close();
}

function fixture({ old = legacy, status = true } = {}) {
  const owner = createWorkInfoCacheFixture({ count: 3 }); factories.push(owner);
  for (const work of owner.works) { work.code = `${work.id === "2" ? "BB" : "AA"}-${work.id.padStart(3, "0")}`; work.directoryName = work.code; }
  owner.makerReads = 0; owner.makerFailure = null;
  const owners = new WeakMap();
  function catalogDb() {
    if (owners.has(owner.state.db)) return owners.get(owner.state.db);
    const db = owner.state.db;
    const wrapper = { prepare(sql) {
      if (!sql.includes("m.name AS maker_name")) return db.prepare(sql);
      owner.makerReads++;
      if (owner.makerFailure === "prepare") throw new Error("controlled maker prepare failure");
      const statement = db.prepare(sql);
      return { all(...params) {
        if (owner.makerFailure === "all") throw new Error("controlled maker all failure");
        const rows = statement.all(...params);
        if (owner.makerFailure !== "iterate") return rows;
        return { *[Symbol.iterator]() {
          yield rows[0];
          throw new Error("controlled maker iteration failure after one native row");
        } };
      } };
    } };
    owners.set(db, wrapper); return wrapper;
  }
  const text = createWorkSearchIndexService({ getCoreDb: owner.getCoreDb, getLibrary: () => owner.library,
    getSourceStamp: () => owner.state.stamp, getWorkInfoStamp: () => owner.state.stamp,
    normalizeSearchValue: codeKey, parseJsonArray: parseJson, parseJsonTextArray: parseJson });
  const missing = createMissingCodeSearchService({ getCoreDb: owner.getCoreDb,
    getCoverStamp: () => owner.state.stamp, getSourceStamp: () => owner.state.stamp,
    dbBoolOrNull: value => value == null ? null : Boolean(Number(value)), normalizeWorkCode: String,
    parseJsonTextArray: parseJson, proxiedRemoteImageUrl: value => value || "", publicRemoteUrl: value => value || "", storedWorkCodeKey: codeKey });
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  function code(name) {
    const begin = server.indexOf(`function ${name}(`), end = server.indexOf("\nfunction ", begin + 10);
    assert.ok(begin > 0 && end > begin); return server.slice(begin, end);
  }
  const adapters = new Function("workSearchIndexService", "missingCodeSearchService",
    code("withWorkSearchReadStatus") + "\n" + code("workSearchReadCacheable")
    + "\nreturn {withWorkSearchReadStatus,workSearchReadCacheable};")(text, missing);
  const deps = owner.dependencies;
  const page = new Function("clampInteger", "DEFAULT_WORK_LIMIT", "MAX_WORK_LIMIT", "prewarmCoreWorkCovers", "prewarmWorkInfoDetails", "publicWork", "prewarmRemoteImagesForWorks",
    code("pagedWorksPayload") + "\nreturn pagedWorksPayload;")(
    clampInteger, 48, 1000, () => {}, deps.prewarmWorkInfoDetails, owner.presenter.publicWork, () => {});
  owner.prefix = (old ? previousFactory : createCodePrefixService)({
    ...(status ? { ...adapters, withWorkInfoReadStatus: owner.info.withReadStatus, workInfoReadCacheable: owner.info.readCacheable } : {}),
    clampInteger, dedupeWorksForDisplay: rows => rows, defaultWorkLimit: 48, maxWorkLimit: 1000,
    fastMissingCodeSearch: missing.search, hydrateMissingSearchWorks: missing.hydrate,
    filterWorkList: deps.filterWorkList, getCoreDb: catalogDb, getLibrary: () => owner.library,
    getStamp: () => owner.state.stamp, pagedWorksPayload: page, sortWorkList: deps.sortWorkList,
    userStateStamp: () => "private user", workClassificationService: deps.workClassificationService,
    workFacets: deps.workFacets, workQueryStamp: () => owner.state.stamp });
  return owner;
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCodePrefixService } from "../src/modules/fanhao/server/catalog/code-prefix-service.js";
import { createWorkFilterService } from "../src/modules/fanhao/server/works/work-filter-service.js";
import { createWorkClassificationService } from "../src/modules/fanhao/server/works/work-classification-service.js";
import { createWorkSorter } from "../src/modules/fanhao/server/works/work-sorter.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servicePath = path.join(repo, "src/modules/fanhao/server/catalog/code-prefix-service.js");
const referenceBudget = 4_000_000;
const supportedFilters = ["playable", "favorite", "progress", "info", "localOnly", "rated", "highRating", "vr"];

async function factory({ withoutWeightBudget = false, smallBudget = null } = {}) {
  if (!withoutWeightBudget && smallBudget === null) return createCodePrefixService;
  let source = fs.readFileSync(servicePath, "utf8");
  if (withoutWeightBudget || smallBudget !== null) {
    // Only focused edge cases lower the same production budget in memory.
    // The large retained-array proof always uses the unchanged 4m production
    // budget; this avoids allocating millions of work objects for bypass tests.
    assert(source.includes("const DETAIL_WORK_REFERENCE_BUDGET = 4_000_000;"));
    // The negative keeps real filtering, sorting, account ownership, the two
    // 96-entry caps and GC behavior; only the shared weight bound is disabled.
    source = source.replace("const DETAIL_WORK_REFERENCE_BUDGET = 4_000_000;", `const DETAIL_WORK_REFERENCE_BUDGET = ${withoutWeightBudget ? "Infinity" : smallBudget};`);
  }
  source = source.replace(/from\s+"(\.\.\/[^"\r\n]+)"/g, (_match, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(servicePath), relative)).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createCodePrefixService;
}

function harness(createService, groups) {
  const works = Object.entries(groups).flatMap(([prefix, count]) => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}:${index}`, code: `${prefix}-${index + 100000}`, title: `${prefix} ${index}`,
    modifiedAt: String(index).padStart(7, "0"), playableCount: 1, infoCount: 1
  })));
  const state = { user: "alice", catalog: "catalog-1", metadata: "metadata-1", config: {}, favoriteIds: null };
  const library = { scannedAt: "scan-1", worksById: new Map(works.map((work) => [work.id, work])) };
  const sourceRefs = [], sortedRefs = [];
  const counts = { source: 0, sort: 0 };
  const filters = createWorkFilterService({
    favoriteStateService: { isFavoriteWork: (id) => state.favoriteIds === null || state.favoriteIds.has(id) },
    playbackProgressService: { getWorkProgress: () => ({ ratio: 0.5 }) },
    workInfoFacetRow: () => ({ rating: 5 }), isVrWork: () => true
  });
  const classification = createWorkClassificationService({ appConfigService: { current: () => state.config } });
  const sorter = createWorkSorter({ metadataForWork: () => ({}), progressForWork: () => null });
  const service = createService({
    clampInteger: (value, fallback, min, max) => value === null ? fallback : Math.max(min, Math.min(max, Number(value))),
    dedupeWorksForDisplay: (rows) => {
      counts.source += 1;
      const result = [...new Map(rows.map((work) => [work.id, work])).values()];
      sourceRefs.push({ ref: new WeakRef(result), length: result.length });
      return result;
    },
    defaultWorkLimit: 48, maxWorkLimit: 1000, fastMissingCodeSearch: () => [],
    filterWorkList: filters.filter, getCoreDb: () => ({ prepare: () => ({ all: () => [] }) }),
    getLibrary: () => library, getStamp: () => state.catalog, workQueryStamp: () => state.metadata,
    userStateStamp: () => state.user, workClassificationService: classification, workFacets: filters.facets,
    sortWorkList: (rows, sort) => {
      counts.sort += 1;
      const result = sorter(rows, sort);
      sortedRefs.push({ ref: new WeakRef(result), length: result.length });
      return result;
    },
    pagedWorksPayload: (rows, url, extra) => {
      const limit = Number(url.searchParams.get("limit") || 48), offset = Number(url.searchParams.get("offset") || 0);
      const page = rows.slice(offset, offset + limit).map((work) => ({ id: work.id, owner: state.user }));
      return { ...extra, total: rows.length, count: page.length, limit, offset, works: page };
    }
  });
  const call = (prefix, query = {}) => service.detailPayload(prefix, new URL(`http://fixture.invalid/api/code-prefixes/${prefix}?${new URLSearchParams({ sort: "updated", limit: "48", ...query })}`));
  const combination = (index, offset = 0) => call(index % 2 ? "FC2" : "FC2-PPV", {
    family: String(index % 2), filter: supportedFilters.filter((_filter, bit) => index & (1 << bit)).join(",") || "all", offset: String(offset)
  });
  return { call, combination, counts, service, state, library, sourceRefs, sortedRefs };
}

async function collect() {
  await immediate(); global.gc(); await immediate(); global.gc(); await immediate();
}

function retained(refs) {
  return refs.reduce((value, entry) => {
    if (entry.ref.deref()) { value.arrays += 1; value.references += entry.length; }
    return value;
  }, { arrays: 0, references: 0 });
}

const cases = [
  { name: "retained-supported-filters", async run(options) {
    const h = harness(await factory(options), { "FC2-PPV": 100_000 });
    await collect();
    const baseline = process.memoryUsage().heapUsed;
    for (let index = 0; index < 96; index += 1) {
      const payload = h.combination(index);
      assert.equal(payload.total, 100_000);
      assert.equal(payload.count, 48);
    }
    await collect();
    const source = retained(h.sourceRefs), sorted = retained(h.sortedRefs);
    const heapDeltaMiB = (process.memoryUsage().heapUsed - baseline) / 1048576;
    console.log(`code-prefix-cache-budget: retained source=${source.references} sorted=${sorted.references} heap-delta=${heapDeltaMiB.toFixed(2)}MiB (diagnostic)`);
    assert(source.references + sorted.references <= referenceBudget, "cached source and sorted arrays must stay within the 4m work-reference budget after real GC");
    const before = h.counts.sort;
    h.combination(95, 48);
    assert.equal(h.counts.sort, before, "a retained large result must reuse ordering across offsets");
    h.service.invalidate();
    await collect();
    assert.deepEqual(retained(h.sourceRefs), { arrays: 0, references: 0 });
    assert.deepEqual(retained(h.sortedRefs), { arrays: 0, references: 0 });
  } },
  { name: "small-pages-lru", async run(options) {
    const h = harness(await factory(options), { "FC2-PPV": 100 });
    for (let index = 0; index < 96; index += 1) h.combination(index);
    assert.equal(h.counts.sort, 96);
    const first = h.combination(0), second = h.combination(0, 48);
    assert.equal(h.counts.sort, 96, "all 96 small semantic queries must fit the existing result-count cap");
    assert.notDeepEqual(first.works.map((row) => row.id), second.works.map((row) => row.id));
    h.combination(96);
    const beforeRecent = h.counts.sort;
    h.combination(0);
    assert.equal(h.counts.sort, beforeRecent, "a touched result remains recent when the 96-entry cap evicts");
    h.combination(1);
    assert.equal(h.counts.sort, beforeRecent + 1, "the oldest result must recompute after count eviction");
    const prefixes = Array.from({ length: 97 }, (_, index) => `AA${index}`);
    const sources = harness(await factory(options), Object.fromEntries(prefixes.map((prefix) => [prefix, 2])));
    for (const prefix of prefixes.slice(0, 96)) sources.call(prefix);
    sources.call(prefixes[0]);
    assert.equal(sources.counts.source, 96, "small source reuse must fit all 96 entries");
    sources.call(prefixes[96]);
    const beforeSourceEviction = sources.counts.source;
    sources.call(prefixes[0]);
    assert.equal(sources.counts.source, beforeSourceEviction, "source LRU must preserve its touched entry");
    sources.call(prefixes[1]);
    assert.equal(sources.counts.source, beforeSourceEviction + 1, "the source-cache 96-entry cap must still evict and rebuild its oldest entry");
  } },
  { name: "source-result-lifetime", async run(options) {
    const h = harness(await factory({ ...options, smallBudget: 300 }), { AA: 200, BB: 200 });
    h.state.favoriteIds = new Set(["AA:0", "BB:0"]);
    assert.equal(h.call("AA", { filter: "favorite" }).total, 1);
    assert.equal(h.call("BB", { filter: "favorite" }).total, 1);
    await collect();
    const source = retained(h.sourceRefs), sorted = retained(h.sortedRefs);
    assert(source.references + sorted.references <= 300, "a result's strong source array must remain charged after its source-cache entry is evicted");
    assert.equal(h.sourceRefs[0].ref.deref(), undefined, "pressure must release the source held by the old filtered result");
    assert.equal(h.sortedRefs[0].ref.deref(), undefined);
    const before = h.counts.source;
    h.call("AA", { filter: "favorite" });
    assert.equal(h.counts.source, before + 1, "evicted source data must rebuild rather than reuse a stale source identity");
    await collect();
    assert(retained(h.sourceRefs).references + retained(h.sortedRefs).references <= 300);
  } },
  { name: "oversized-bypass", async run(options) {
    const h = harness(await factory({ ...options, smallBudget: 300 }), { AA: 400, BB: 40 });
    h.call("BB");
    for (let index = 0; index < 2; index += 1) {
      const payload = h.call("AA");
      assert.equal(payload.total, 400);
      assert.equal(payload.count, 48, "oversized sources must still return the requested page correctly");
    }
    assert.equal(h.counts.source, 3, "oversized source data must bypass source caching");
    assert.equal(h.counts.sort, 3, "oversized result data must bypass result caching");
    const before = h.counts.sort;
    h.call("BB", { offset: "20" });
    assert.equal(h.counts.sort, before, "uncached oversized requests must preserve useful small results");
    await collect();
    assert(retained(h.sourceRefs).references + retained(h.sortedRefs).references <= 300);
  } },
  { name: "stamp-ownership", async run(options) {
    const h = harness(await factory(options), { AA: 100 });
    h.state.favoriteIds = new Set(["AA:0"]);
    const alice = h.call("AA", { filter: "favorite" });
    h.state.user = "bob"; h.state.favoriteIds = new Set(["AA:1"]);
    const bob = h.call("AA", { filter: "favorite" });
    assert.deepEqual(alice.works, [{ id: "AA:0", owner: "alice" }]);
    assert.deepEqual(bob.works, [{ id: "AA:1", owner: "bob" }]);
    assert.equal(h.counts.source, 1, "account result invalidation must preserve catalog-only sources");
    for (const change of [() => { h.state.metadata += "-next"; }, () => { h.state.config = { compilationPrefixes: ["AA"] }; }]) {
      const before = h.counts.sort;
      change(); h.call("AA", { filter: "favorite" });
      assert.equal(h.counts.sort, before + 1, "metadata/visibility ownership must clear filtered results");
    }
    for (const change of [() => { h.state.catalog += "-next"; }, () => { h.library.scannedAt += "-next"; }]) {
      const before = h.counts.source;
      change(); h.call("AA", { filter: "favorite" });
      assert.equal(h.counts.source, before + 1, "catalog/library stamps must release source and result caches together");
    }
    await collect();
    assert.equal(retained(h.sourceRefs).arrays, 1);
    assert.equal(retained(h.sortedRefs).arrays, 1);
  } },
  { name: "explicit-weak-release", async run(options) {
    const h = harness(await factory(options), { "FC2-PPV": 20_000 });
    for (let index = 0; index < 96; index += 1) h.combination(index);
    h.service.invalidate();
    await collect();
    assert.equal(retained(h.sourceRefs).arrays, 0, "budget metadata must not keep explicitly invalidated source arrays alive");
    assert.equal(retained(h.sortedRefs).arrays, 0, "budget metadata must not keep explicitly invalidated results alive");
    h.combination(95);
    assert.equal(h.counts.sort, 97, "explicit invalidation must rebuild a fresh result");
  } }
];

export async function runCodePrefixCacheBudgetFixture({ withoutWeightBudget = false, caseName = "" } = {}) {
  const selected = cases.filter((test) => !caseName || test.name === caseName);
  assert(selected.length, `unknown case: ${caseName}`);
  for (const test of selected) {
    await test.run({ withoutWeightBudget });
    console.log(`code-prefix-cache-budget: PASS ${test.name}`);
  }
  console.log(`code-prefix-cache-budget: ${selected.length} cases PASS${withoutWeightBudget ? " (weight budget disabled in memory)" : ""}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!global.gc) {
    execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  } else {
    const caseName = process.argv.find((value) => value.startsWith("--case="))?.slice(7) || "";
    await runCodePrefixCacheBudgetFixture({ withoutWeightBudget: process.argv.includes("--without-weight-budget"), caseName });
  }
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setImmediate as immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createWeightedCacheBudget, normalizeWorkSortMode } from "../src/modules/fanhao/server/works/work-cache-budget.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createStudioService } from "../src/modules/fanhao/server/catalog/studio-service.js";
const clampInteger = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value ?? fallback)));

if (!global.gc) {
  execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], { stdio: "inherit" });
} else {
  verifyBudgetEviction();
  await verifyWeakOwnership();
  verifyQueryPages();
  verifyStudioPages();
  console.log("work-cache-budget: ok (weighted/count LRU, oversized pages, 48-row reuse, account/stamp isolation, weak owner GC and token cleanup)");
}

function verifyBudgetEviction() {
  const budget = createWeightedCacheBudget(10, 4);
  const a = new Map(), b = new Map();
  const write = (owner, key, weight, limit) => budget.write(owner, key, { key }, weight, limit);
  write(a, "old", 4); write(b, "recent", 4);
  budget.read(a, "old"); write(b, "new", 4);
  assert.ok(a.has("old")); assert.ok(!b.has("recent"), "global LRU touches span all owners");
  assert.equal(budget.diagnostics().weight, 8);
  write(a, "old", 1);
  assert.equal(budget.diagnostics().weight, 5, "replacement unregisters the previous weight");
  write(a, "large", 11);
  assert.ok(!a.has("large")); assert.equal(budget.diagnostics().weight, 5);
  write(a, "first", 1, 2); write(a, "second", 1, 2);
  assert.ok(!a.has("old"), "per-owner count eviction unregisters shared weight and token");
  assert.equal(budget.diagnostics().weight, 6);
  b.delete("new");
  assert.equal(budget.diagnostics().weight, 2, "direct owner invalidation is reconciled by sweep");
  budget.clear(a); assert.equal(budget.diagnostics().entries, 0);
  for (let i = 0; i < 10; i++) write(a, String(i), 0);
  assert.equal(a.size, 4, "zero-row results still have a metadata entry limit");
  assert.equal(budget.diagnostics().entries, 4);
  budget.clear(); assert.equal(a.size, 0); assert.equal(budget.diagnostics().weight, 0);
  assert.equal(normalizeWorkSortMode("ranking"), "updated");
  assert.equal(normalizeWorkSortMode("size"), "sizeDesc");
}

async function verifyWeakOwnership() {
  const budget = createWeightedCacheBudget(100_000);
  const sortedBySource = new WeakMap();
  const refs = [];
  function register(index) {
    const source = [{ id: index }];
    const owner = new Map();
    sortedBySource.set(source, owner);
    budget.write(owner, "updated", { works: [...source] }, 1);
    return new WeakRef(source);
  }
  for (let index = 0; index < 2000; index++) refs.push(register(index));
  assert.equal(budget.diagnostics().entries, 2000);
  await immediate(); global.gc(); await immediate(); global.gc();
  assert.ok(refs.every((ref) => !ref.deref()), "the global eviction index must not keep WeakMap source keys alive");
  assert.equal(budget.diagnostics().entries, 0, "reclaimed weak owners must not leave an accumulating token registry");
  assert.equal(budget.diagnostics().weight, 0);
}

function fixtureWorks() {
  return Array.from({ length: 20_000 }, (_, index) => ({ id: String(index), title: `Fixture ${index}`, modifiedAt: String(index), playableCount: 1 }));
}

function verifyQueryPages() {
  const works = fixtureWorks();
  let user = "alice", stamp = "one";
  const service = createWorkQueryService({
    library: { worksById: new Map(works.map((work) => [work.id, work])) },
    actorMovieStamp: () => "fixture", actorMissingSearchWorks: () => [],
    clampInteger, defaultWorkLimit: 48, maxWorkLimit: 16000,
    enrichLocalWorksWithActorMovieIndex: (items) => items,
    favoriteStateService: { isFavoriteWork: () => false }, playbackProgressService: { getWorkProgress: () => null },
    isVrWork: () => false, workHasCoreCover: () => false, workInfoFacetRow: () => null,
    peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope === "main" },
    publicWork: (work) => ({ id: work.id, owner: user }), prewarmRemoteImagesForWorks: () => {},
    publicWorkAvailability: () => ({}), workQueryStamp: () => stamp, userStateStamp: () => user,
    localWorksByCodePrefix: () => works, fastMissingCodeSearch: () => [], storedWorkCodeKey: (value) => value,
    dedupeWorksForDisplay: (items) => items
  });
  for (const [mode, count] of [["list", 96], ["search", 192]]) {
    const call = (offset, limit = 48) => service[mode === "list" ? "listPayload" : "searchPayload"](new URL(`http://fixture/api/works?q=AB&sort=updated&limit=${limit}&offset=${offset}`));
    const first = call(0);
    for (let index = 1; index < count; index++) assert.equal(call(index * 48).count, 48);
    assert.equal(call(0), first, `${mode} retains every normal 48-row page up to its existing count limit`);
    const large = call(0, 16000);
    assert.equal(large.count, 16000); assert.equal(large.limit, 16000); assert.equal(large.total, 20000);
    assert.notEqual(call(0, 16000), large, `${mode} keeps the API limit but bypasses caching for an oversized page`);
    assert.equal(call(0), first, `${mode} an uncached large page does not evict normal page responses`);
    user += "-next";
    assert.notEqual(call(0), first, `${mode} page reuse does not cross user state`);
    stamp += "-next";
    const refreshed = call(0);
    assert.equal(refreshed.works[0].owner, user, "a fresh source stamp rebuilds DTO state");
  }
}

function verifyStudioPages() {
  const works = fixtureWorks();
  let stamp = "one", owner = "alice", sortedCalls = 0;
  const service = createStudioService({
    clampInteger, getLibrary: () => ({ worksById: new Map(works.map((work) => [work.id, work])) }), getStamp: () => stamp,
    getCoreDb: () => ({ prepare(sql) {
      if (sql.includes("SELECT COUNT(*) FROM makers")) return { get: () => ({ maker_count: 1 }) };
      if (sql.includes("FROM makers m")) return { get: () => ({ maker_id: "1", name: "fixture" }) };
      if (sql.includes("FROM series s")) return { all: () => [] };
      if (sql.includes("FROM work_makers wm")) return { all: () => works.map((work) => ({ work_id: work.id })) };
      throw new Error(sql);
    } }), publicRemoteUrl: (value) => value, userStateStamp: () => owner,
    sortWorkList: (items) => { sortedCalls++; return [...items]; }, workFacets: (items) => ({ all: items.length }),
    pagedWorksPayload(items, url, extra) {
      const limit = clampInteger(url.searchParams.get("limit"), 48, 1, 16000), offset = Number(url.searchParams.get("offset"));
      const page = items.slice(offset, offset + limit).map((work) => ({ id: work.id, owner }));
      return { ...extra, count: page.length, limit, offset, total: items.length, works: page };
    }
  });
  const call = (offset, limit = 48) => service.detailPayload("1", new URL(`http://fixture/api/studios/1?limit=${limit}&offset=${offset}&sort=updated`));
  const first = call(0);
  for (let index = 1; index < 256; index++) assert.equal(call(index * 48).count, 48);
  assert.equal(call(0), first, "studio preserves all 256 normal pages under its row budget");
  const large = call(0, 16000); assert.equal(large.count, 16000); assert.equal(large.limit, 16000);
  assert.notEqual(call(0, 16000), large); assert.equal(call(0), first);
  owner = "bob"; assert.equal(call(0).works[0].owner, "bob");
  const before = sortedCalls; stamp = "two"; call(0);
  assert.equal(sortedCalls, before + 1, "source stamp clears the previous weighted derivations");
  service.invalidate(); const again = call(0); assert.notEqual(again, first);
}

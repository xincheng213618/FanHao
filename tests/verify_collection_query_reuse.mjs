import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCollectionQueryService } from "../src/modules/fanhao/server/user-state/collection-query-service.js";
import { createWeightedCacheBudget } from "../src/modules/fanhao/server/works/work-cache-budget.js";
import { createWorkFilterService } from "../src/modules/fanhao/server/works/work-filter-service.js";
import { createWorkSorter } from "../src/modules/fanhao/server/works/work-sorter.js";
import { deriveWorkTraits, summarizeWorkTraits } from "../lib/work-traits.js";

const legacy = process.argv.includes("--legacy-query-reuse");
assert(process.argv.slice(2).every(value => value === "--legacy-query-reuse"));
const source = readFileSync(new URL("../src/modules/fanhao/server/user-state/collection-query-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const start = source.indexOf("  function preparedQuery("), end = source.indexOf("  function queryWorks(", start);
assert(start >= 0 && end > start);
// Restore the preceding per-page source/filter/sort/facet work, preserving the
// actual DTO assembly, page/work caches, prewarming and source providers.
const previous = source.slice(0, start) + "  function preparedQuery(_parts, loadSource, options) {\n    return queryWorks(loadSource(), options);\n  }\n\n" + source.slice(end);
function inspectFactory(text) {
  const slot = "    favoritesPayload,\n    historyPayload,\n    prewarm";
  assert.equal(text.split(slot).length, 2);
  let budgets;
  const factory = new Function("createWeightedCacheBudget", "deriveWorkTraits", "summarizeWorkTraits", text
    .replace(/^import .*;\n/gmu, "").replaceAll("export function ", "function ")
    .replace(slot, slot + ",\n    queryCacheState: () => queryCache") + "\nreturn createCollectionQueryService;")(
    (...args) => { const budget = createWeightedCacheBudget(...args); budgets.push(budget); return budget; },
    deriveWorkTraits, summarizeWorkTraits);
  return deps => {
    budgets = [];
    const service = factory(deps), owned = budgets;
    return { ...service, budgets: () => owned.map(budget => budget.diagnostics()) };
  };
}
const currentFactory = inspectFactory(legacy ? previous : source), previousFactory = inspectFactory(previous);
const clampInteger = (value, fallback, min, max) => value == null || value === "" || !Number.isFinite(Number(value))
  ? fallback : Math.max(min, Math.min(max, Math.trunc(Number(value))));
let comparisons = 0;
function fixture(factory, count = 120) {
  const works = Array.from({ length: count }, (_, index) => ({ id: String(index), title: `Work ${index}`,
    playableCount: index % 3, infoCount: 0, missingLocal: index % 7 === 0, videos: [],
    infoSummary: { code: `FIX-${index}`, tags: [index % 2 ? "Tag A" : "Tag B"] } }));
  const library = { scannedAt: "scan-1", worksById: new Map(works.map(work => [work.id, work])) };
  const state = { user: "alice:1", work: "info-1", cacheable: true, fail: false, clock: 20,
    calls: { source: 0, filter: 0, sort: 0, facets: 0, trait: 0, public: 0 } };
  const info = id => ({ rating: Number(id) % 5, ratingCount: Number(id), releaseDate: "2026-01-01" });
  const favorites = { normalizeFavoriteFolderId: value => value === "old" ? "default" : value,
    publicFavoriteFolders: () => [{ id: "default", name: "Default", owner: state.user }],
    isFavoriteWork: () => true,
    favoriteWorks(folder) {
      state.calls.source++;
      return folder === "empty" ? [] : folder === "odd" ? works.filter(work => Number(work.id) % 2) : works.slice();
    } };
  const progress = { getWorkProgress: () => null, historyEntries({ days }) {
    state.calls.source++;
    return works.filter(work => !days || Number(work.id) + days >= state.clock).map(work => ({ work }));
  } };
  const filters = createWorkFilterService({ favoriteStateService: favorites, playbackProgressService: progress, workInfoFacetRow: info });
  const sort = createWorkSorter({ metadataForWork: work => info(work.id), progressForWork: () => null });
  const service = factory({ clampInteger, favoriteStateService: favorites, getLibrary: () => library,
    maxWorkLimit: 100000, recentWatchedDays: 7, playbackProgressService: progress,
    filterWorkList(rows, filter) { state.calls.filter += rows.length; return filters.filter(rows, filter); },
    sortWorkList(rows, mode) { state.calls.sort += rows.length; return sort(rows, mode); },
    workFacets(rows) { state.calls.facets += rows.length; return filters.facets(rows); },
    workInfoFacetRow(id) { state.calls.trait++; return state.cacheable ? info(id) : null; },
    userStateStamp: () => state.user, workQueryStamp: () => state.work,
    workInfoReadCacheable: () => state.cacheable,
    prewarmCoreWorkCovers: () => {}, prewarmVideoProbesForWorks: () => {}, prewarmWorkInfoDetails: () => {},
    prewarmRemoteImagesForWorks: () => {}, publicWork(work) {
      if (state.fail) throw new Error("controlled presentation failure");
      state.calls.public++;
      return { ...work, owner: state.user, metadata: state.work };
    }
  });
  return { service, state, works, library };
}
const pair = count => ({ current: fixture(currentFactory, count), previous: fixture(previousFactory, count) });
function read(owner, kind, values = {}) {
  return owner.service[kind + "Payload"](new URL("http://fixture/api/" + kind + "?" + new URLSearchParams({ limit: "48", ...values })));
}
function compare(owners, kind, values) {
  const expected = read(owners.previous, kind, values), actual = read(owners.current, kind, values);
  assert.deepEqual(actual, expected, "complete preceding collection response");
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), "complete preceding collection JSON");
  comparisons++;
  return actual;
}
function both(owners, callback) { callback(owners.current); callback(owners.previous); }

const scale = pair(5000);
for (const kind of ["favorites", "history"]) for (let page = 0; page < 10; page++) {
  compare(scale, kind, { offset: String(page * 48), sort: "ratingDesc" });
}
const visits = { before: { ...scale.previous.state.calls }, after: { ...scale.current.state.calls } };
assert.equal(visits.before.source, 20);
assert.equal(visits.after.public, 480, "work DTO reuse remains independent of prepared query reuse");

const selections = pair(150);
for (const kind of ["favorites", "history"]) for (const values of [
  {}, { folder: "odd", filter: "rated", sort: "ratingAsc" },
  { folder: "empty", filter: "highRating", offset: "1000" },
  { folder: "old", filter: "tag:Tag%20A", sort: "title", limit: "1" },
  { folder: "default", filter: "all", sort: "", limit: "0", offset: "12" },
  { folder: "odd", filter: "highRating", sort: "ratingDesc", offset: "48" },
  { folder: "odd", filter: "highRating", sort: "ratingDesc", offset: "96" }
]) compare(selections, kind, values);
const real = fixture(createCollectionQueryService, 150);
assert.equal(JSON.stringify(read(real, "favorites", { sort: "ratingDesc" })),
  JSON.stringify(read(fixture(currentFactory, 150), "favorites", { sort: "ratingDesc" })), "exported owner matches inspected factory");

for (const change of [owner => { owner.state.user = "bob:1"; }, owner => { owner.state.work = "info-2"; },
  owner => { owner.library.scannedAt = "scan-2"; }, owner => { owner.library.worksById.set("new", {}); }]) {
  const owners = pair(100);
  compare(owners, "favorites", { filter: "rated", sort: "ratingDesc" });
  const before = owners.current.state.calls.source;
  both(owners, change);
  compare(owners, "favorites", { filter: "rated", sort: "ratingDesc", offset: "48" });
  assert.equal(owners.current.state.calls.source, before + 1, "existing library/work/user stamps invalidate prepared membership");
}
const rolling = pair(100);
compare(rolling, "history", { days: "7" });
both(rolling, owner => { owner.state.clock = 70; });
const rolled = compare(rolling, "history", { days: "7", offset: "48" });
assert.equal(rolled.total, 37, "rolling windows still load membership for every new page without a user revision");
assert.equal(rolling.current.state.calls.source, 2);

const recovery = pair(100);
both(recovery, owner => { owner.state.cacheable = false; });
compare(recovery, "favorites", { sort: "ratingDesc" });
assert.equal(recovery.current.service.queryCacheState().size, 0, "failed metadata status cannot retain a query");
both(recovery, owner => { owner.state.cacheable = true; });
compare(recovery, "favorites", { sort: "ratingDesc", offset: "48" });
compare(recovery, "favorites", { sort: "ratingDesc", offset: "96" });
assert.equal(recovery.current.state.calls.source, legacy ? 3 : 2, "healthy same-stamp retry can publish a prepared query");
const failure = pair(100);
both(failure, owner => { owner.state.fail = true; assert.throws(() => read(owner, "favorites"), /controlled presentation failure/); owner.state.fail = false; });
compare(failure, "favorites");

const pressure = fixture(currentFactory, 5000);
for (let i = 0; i < 16; i++) read(pressure, "favorites", { folder: "selection-" + i, offset: String(i * 48) });
const queryState = pressure.service.queryCacheState();
assert([...queryState.values()].reduce((sum, query) => sum + query.works.length, 0) <= 50000, "prepared work references obey their independent budget");
const pageState = pressure.service.budgets()[1];
assert.equal(pageState.weight, 16 * 48, "prepared-query admissions preserve the separate ordinary-page budget");
const beforeOversized = [...queryState.keys()];
read(pressure, "favorites", { folder: "x".repeat(1100) });
assert.deepEqual([...queryState.keys()], beforeOversized, "oversized request keys are not retained");
const empty = fixture(currentFactory, 0);
for (let i = 0; i < 70; i++) read(empty, "favorites", { folder: String(i) });
assert(empty.service.queryCacheState().size <= 32, "zero-weight prepared queries obey the count bound");
const oversized = fixture(currentFactory, 50001);
read(oversized, "favorites", { limit: "1" });
assert.equal(oversized.service.queryCacheState().size, 0, "oversized prepared queries are served without admission");
const retired = pressure.service.queryCacheState();
pressure.state.user = "next-account";
read(pressure, "favorites", { folder: "empty" });
assert.equal(retired.size, legacy ? 0 : 1);
assert([...retired.keys()].every(key => key.includes("empty")), "account changes release prior query keys and sources");

console.log(JSON.stringify({ comparisons, collectionQueryVisits: visits, rollingWindowSourceReads: rolling.current.state.calls.source,
  maxPreparedWorkReferences: 50000, maxPreparedQueries: 32, ordinaryPageReferences: pageState.weight }));
// The genuine old mechanism must exceed these access budgets after all DTO,
// fault, scope and ownership checks have completed.
assert.equal(visits.after.source, 2, "each unbounded collection source is loaded once across ten pages");
for (const field of ["filter", "sort", "facets", "trait"]) {
  assert.equal(visits.before[field], 100000);
  assert.equal(visits.after[field], 10000, "pagination reuses prepared " + field + " work");
}

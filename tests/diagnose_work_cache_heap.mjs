import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createWorkSorter } from "../src/modules/fanhao/server/works/work-sorter.js";
import { createWorkFilterService } from "../src/modules/fanhao/server/works/work-filter-service.js";
import { createWorkClassificationService } from "../src/modules/fanhao/server/works/work-classification-service.js";
import { createWorkPresenterService } from "../src/modules/fanhao/server/works/presenter-service.js";
import { createStudioService } from "../src/modules/fanhao/server/catalog/studio-service.js";

// Private retained-heap diagnostic. Production cache/filter/sort/presenter code,
// synthetic works, and a read-only studio SQL double; no real library or service.
// Run each scenario in a fresh process: node --expose-gc ... --scenario=list.
assert.equal(typeof global.gc, "function", "run this diagnostic with --expose-gc");
const scenario = process.argv.find((value) => value.startsWith("--scenario="))?.slice(11) || "list";
const count = 65_000;
const sorts = ["releaseDesc", "updated", "title", "ranking", "releaseAsc", "ratingDesc", "ratingAsc", "ratingCountDesc", "popularityDesc", "progress", "size", "sizeDesc", "sizeAsc", "duration", "durationDesc", "durationAsc", "videos", "codeAsc", "codeDesc"];
const filterFlags = ["playable", "info", "rated", "highRating", "localOnly", "missingCover", "favorite"];
const filters = Array.from({ length: 127 }, (_, index) => filterFlags.filter((_flag, bit) => (index + 1) & (1 << bit)).join(","));
const words = ["地方", "传媒", "表演", "短篇", "系列", "制作", "高清", "发行", "本地", "收藏", "作品", "影片"];
let userStamp = 1;
let workStamp = 1;
let service;
let sourceQueries = 0;
let sortCalls = 0;
let filterCalls = 0;
let presenterCalls = 0;
const samples = [];
let sourceHeap;

function clampInteger(value, fallback, min, max) {
  const numeric = value === null || value === undefined || String(value).trim() === "" ? fallback : Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.floor(numeric))) : fallback;
}

const works = Array.from({ length: count }, (_, index) => {
  const code = `FIX-${String(index).padStart(5, "0")}`;
  const title = `${code} 地方传媒 表演短篇 系列制作 高清发行 本地收藏 作品影片`;
  return {
    id: String(index), personId: "person", personName: "合成人物", title, directoryName: title,
    relativePath: `synthetic/${code}`, modifiedAt: `2026-10-${String(index % 28 + 1).padStart(2, "0")}`,
    missingLocal: false, coverId: index % 5 === 0 ? `cover-${index}` : null,
    videoCount: 1, playableCount: index % 20 ? 1 : 0, imageCount: 0, infoCount: index % 25 ? 1 : 0,
    videos: [{ size: 1000 + index % 37 }], images: [], infos: [],
    infoSummary: { code, releaseDate: `202${index % 6}-01-01`, rating: index % 10 ? 4.5 : null,
      ratingCount: index % 500, durationMinutes: index % 150, javdbTags: ["fixture"] }
  };
});
const library = { scannedAt: "synthetic", worksById: new Map(works.map((work) => [work.id, work])), peopleById: new Map([["person", { id: "person", name: "合成人物" }]]) };
const favoriteStateService = {
  isFavoriteWork: (id) => Number(id) % 25 !== 0,
  publicFavoriteForWork: (id) => Number(id) % 25 ? { folderId: "fixture", folderName: "合成收藏" } : null
};
const playbackProgressService = { getWorkProgress: () => null };
const filterService = createWorkFilterService({ favoriteStateService, playbackProgressService, workInfoFacetRow: () => null });
const classification = createWorkClassificationService({ appConfigService: { current: () => ({}) } });
const presenter = createWorkPresenterService({
  getLibrary: () => library, actorProfileRow: () => null, displayPersonForWork: (id) => library.peopleById.get(id),
  displayWorkTitle: (value) => String(value || ""), localWorkMarkers: () => [],
  manualCoverStateService: { manualCoverForWork: () => null }, publicCoreWorkCover: () => null,
  workInfoDetailRow: () => null, publicWorkInfoSummary: (_row, summary) => summary,
  favoriteStateService, playbackProgressService, publicActorProfile: () => null,
  uniqueTextArray: (values) => [...new Set(values)],
  dbBoolOrNull: (value) => value == null ? null : Boolean(value),
  firstPresentValue: (...values) => values.find((value) => value !== null && value !== undefined) ?? null
});
const publicWork = (...args) => { presenterCalls += 1; return presenter.publicWork(...args); };
const sorter = createWorkSorter({
  metadataForWork: (work) => ({ releaseDate: work.infoSummary.releaseDate, rating: work.infoSummary.rating,
    ratingCount: work.infoSummary.ratingCount, duration: work.infoSummary.durationMinutes, code: work.infoSummary.code }),
  progressForWork: () => null
});
const queryDependencies = {
  library, clampInteger, defaultWorkLimit: 160, maxWorkLimit: 16000,
  favoriteStateService, playbackProgressService,
  peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope !== "western" },
  isVrWork: () => false, workHasCoreCover: () => false, workHasLocalMarker: () => false,
  workInfoFacetRow: () => null, publicWorkAvailability: (work) => presenter.publicWorkAvailability(work),
  publicWork, publicPerson: (person) => ({ id: person.id, name: person.name }),
  prewarmRemoteImagesForWorks: () => {}, enrichLocalWorksWithActorMovieIndex: (items) => items,
  actorMovieStamp: () => "synthetic", userStateStamp: () => String(userStamp), workQueryStamp: () => String(workStamp),
  rankingMissingSearchWorks: () => [], actorMissingSearchWorks: () => [],
  dedupeWorksForDisplay: (items) => items, storedWorkCodeKey: (value) => String(value).toLowerCase(),
  searchPeople: () => ({ exact: [], people: [], matchedPersonIds: [] }),
  createWorkSearchMatcher: (query) => (work) => work.title.toLowerCase().includes(query),
  localWorksByCodePrefix: (prefix) => works.filter((work) => work.infoSummary.code.toLowerCase().startsWith(prefix)),
  localSearchWorkByCodeKey: () => new Map(), fastMissingCodeSearch: () => [],
  workClassificationService: classification,
  recordPerformanceSpan: (label) => { if (label === "sort") sortCalls += 1; if (label === "filter") filterCalls += 1; }
};

async function sample(label, extra = {}) {
  await immediate(); global.gc(); await immediate(); global.gc();
  const memory = process.memoryUsage();
  const row = { scenario, label, heapMiB: +(memory.heapUsed / 1024 / 1024).toFixed(2),
    retainedDeltaMiB: sourceHeap === undefined ? 0 : +((memory.heapUsed - sourceHeap) / 1024 / 1024).toFixed(2),
    rssMiB: +(memory.rss / 1024 / 1024).toFixed(2), sortCalls, filterCalls, presenterCalls, sourceQueries, ...extra };
  samples.push(row); console.log(JSON.stringify(row));
  assert.ok(memory.heapUsed < 768 * 1024 * 1024, "diagnostic heap safety cap exceeded");
  if (label === "12-filters-19-orders" || label === "9-search-sources-19-orders") {
    assert.ok(row.retainedDeltaMiB < 48, "large derived result caches must remain within their weighted budget, including metadata overhead");
  }
  if (label === "24-pages-16000") assert.ok(row.retainedDeltaMiB < 12, "oversized pages must not accumulate as cached DTO responses");
  return memory.heapUsed;
}

function callQuery(mode, query = {}) {
  const url = new URL(`http://fixture/api/${mode === "list" ? "works" : "search"}`);
  for (const [key, value] of Object.entries({ limit: 1, ...query })) url.searchParams.set(key, String(value));
  return service[mode === "list" ? "listPayload" : "searchPayload"](url);
}
function callStudio(query = {}) {
  const url = new URL("http://fixture/api/studios/1");
  for (const [key, value] of Object.entries({ limit: 1, ...query })) url.searchParams.set(key, String(value));
  return service.detailPayload("1", url);
}

sourceHeap = await sample("source-only", { rows: count });
// Sorting may flatten the synthetic source's rope strings. Warm that immutable
// source without retaining returned arrays before attributing heap to caches.
sorter(works, "title"); sorter(works, "updated"); sorter(works, "codeAsc");
sourceHeap = await sample("source-text-warm", { rows: count });
if (scenario === "list" || scenario === "search" || scenario === "pages" || scenario === "weak") {
  service = createWorkQueryService(queryDependencies);
} else if (scenario === "studio") {
  service = createStudioService({
    clampInteger, getLibrary: () => library, getStamp: () => String(workStamp),
    workQueryStamp: () => String(workStamp), userStateStamp: () => String(userStamp),
    workClassificationService: classification,
    getCoreDb: () => ({ prepare(sql) {
      if (sql.includes("SELECT COUNT(*) FROM makers")) return { get: () => ({ maker_count: 1, series_count: 0, link_count: count }) };
      if (sql.includes("FROM makers m")) return { get: () => ({ maker_id: "1", name: "合成片商", work_count: count }) };
      if (sql.includes("FROM series s")) return { all: () => [] };
      if (sql.includes("FROM work_makers wm")) return { all: () => { sourceQueries += 1; return works.map((work) => ({ work_id: work.id })); } };
      throw new Error(`unexpected diagnostic studio query: ${sql}`);
    } }),
    filterWorkList: (items, filter) => { filterCalls += 1; return filterService.filter(items, filter); },
    sortWorkList: (items, sort) => { sortCalls += 1; return sorter(items, sort); },
    workFacets: filterService.facets, publicRemoteUrl: (url) => url,
    pagedWorksPayload: (items, url, extra = {}) => {
      const limit = clampInteger(url.searchParams.get("limit"), 160, 1, 16000);
      const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      const page = items.slice(offset, offset + limit).map((work) => publicWork(work));
      return { ...extra, works: page, total: items.length, count: page.length, limit, offset, sort: url.searchParams.get("sort") || "releaseDesc" };
    }
  });
} else throw new Error(`unknown scenario: ${scenario}`);

if (scenario === "list" || scenario === "search") {
  const base = scenario === "search" ? { q: words[0] } : {};
  assert.equal(callQuery(scenario, base).total, count);
  await sample("one-order-one-source");
  for (const sort of sorts) callQuery(scenario, { ...base, sort });
  await sample("19-orders-one-source");
  const largeFilters = filters.slice(0, 12);
  for (const [index, filter] of largeFilters.entries()) {
    for (const sort of sorts) assert.ok(callQuery(scenario, { ...base, filter, sort }).total >= count * 0.75);
    if ((index + 1) % 4 === 0) await sample(`${index + 1}-filters-19-orders`);
  }
  for (const filter of filters) callQuery(scenario, { ...base, filter, sort: "releaseDesc" });
  await sample("filter-LRU-churn-127");
  if (scenario === "search") {
    for (const [index, q] of words.slice(1, 9).entries()) {
      for (const sort of sorts) assert.equal(callQuery("search", { q, sort }).total, count);
      if ((index + 1) % 4 === 0) await sample(`${index + 2}-search-sources-19-orders`);
    }
    for (let index = 0; index < 60; index += 1) callQuery("search", { q: `不存在的合成查询${index}` });
    await sample("search-LRU-churn-60-empty");
  }
  userStamp += 1;
  callQuery(scenario, { ...base, sort: "releaseDesc" });
  await sample("user-stamp-replacement");
  service = null;
  await sample("drop-service-source-remains");
} else if (scenario === "studio") {
  assert.equal(callStudio().total, count);
  await sample("one-order-one-source");
  for (const sort of sorts) callStudio({ sort });
  await sample("19-orders-one-source");
  for (const [index, filter] of filters.slice(0, 12).entries()) {
    for (const sort of sorts) assert.ok(callStudio({ filter, sort }).total >= count * 0.75);
    if ((index + 1) % 4 === 0) await sample(`${index + 1}-filters-19-orders`);
  }
  for (const filter of filters) callStudio({ filter, sort: "releaseDesc" });
  await sample("filter-LRU-churn-127");
  const beforeEquivalent = filterCalls;
  callStudio({ filter: "playable,info", offset: 2 });
  callStudio({ filter: "info,playable", offset: 3 });
  await sample("equivalent-filter-keys", { newFilterCalls: filterCalls - beforeEquivalent });
  service.invalidate();
  await sample("invalidate-service-source-remains");
  service = null; await sample("drop-service-source-remains");
} else if (scenario === "pages") {
  callQuery("list", { limit: 48 });
  await sample("first-page-48");
  for (let offset = 0; offset < count; offset += 720) callQuery("list", { limit: 720, offset });
  await sample("91-pages-720");
  userStamp += 1; callQuery("list", { limit: 1 });
  await sample("drop-pages-user-stamp");
  for (let index = 0; index < 24; index += 1) {
    callQuery("list", { limit: 16000, offset: index * 1800 });
    if ((index + 1) % 6 === 0) await sample(`${index + 1}-pages-16000`);
  }
  for (let index = 0; index < 100; index += 1) callQuery("list", { limit: 1, offset: count - 1 - index });
  await sample("page-LRU-churn-100-small");
  service = null; await sample("drop-service-source-remains");
} else if (scenario === "weak") {
  service = createWorkQueryService({ ...queryDependencies,
    workClassificationService: { filterForRequest: (items) => items, visibilityStamp: () => "" } });
  let source = [...works];
  const ref = new WeakRef(source);
  for (const sort of sorts) service.listFromWorksPayload(source, new URL(`http://fixture/api/works?limit=1&sort=${sort}`));
  await sample("external-source-live-19-orders");
  source = null;
  await sample("external-source-released-19-orders");
  await immediate(); global.gc(); await immediate(); global.gc();
  const weakKeyReleased = !ref.deref();
  assert.ok(weakKeyReleased, "the shared eviction registry must not keep an external WeakMap source alive");
  console.log(JSON.stringify({ scenario, label: "weak-key-final", weakKeyReleased }));
  service = null; await sample("drop-service-source-remains");
}
console.log(JSON.stringify({ scenario, summary: samples.map(({ label, heapMiB, retainedDeltaMiB }) => ({ label, heapMiB, retainedDeltaMiB })) }));

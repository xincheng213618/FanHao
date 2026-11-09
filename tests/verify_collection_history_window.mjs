import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { removeLocalWorksFromLibrary } from "../src/modules/fanhao/server/people/person-library-service.js";
import { createCollectionQueryService } from "../src/modules/fanhao/server/user-state/collection-query-service.js";
import { createPlaybackProgressService } from "../src/modules/fanhao/server/playback/playback-progress-service.js";
import { routeUserStateApi } from "../src/modules/fanhao/server/user-state/routes.js";
import { createWorkFilterService } from "../src/modules/fanhao/server/works/work-filter-service.js";
import { createWorkSorter } from "../src/modules/fanhao/server/works/work-sorter.js";

// The oracle reads the actual history source for every request. Only history
// page admission is disabled; DTOs, facets, filtering, sorting and prewarming
// stay in the complete current collection factory. No real library is used.
const sourceUrl = new URL("../src/modules/fanhao/server/user-state/collection-query-service.js", import.meta.url);
const source = readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
const admission = "return cachePage(cacheKey, payload);";
assert.equal(source.split(admission).length, 2);
async function factory(text) {
  const absolute = text.replace(/from "(\.\.?\/[^"]+)"/gu, (_, relative) => "from " + JSON.stringify(new URL(relative, sourceUrl).href));
  return (await import("data:text/javascript;base64," + Buffer.from(absolute).toString("base64"))).createCollectionQueryService;
}
const oracleFactory = await factory(source.replace(admission, "return payload;"));
assert(process.argv.slice(2).every(value => ["--without-history-query-reuse", "--without-history-page-expiry"].includes(value)));
const withoutReuse = process.argv.includes("--without-history-query-reuse");
let subject = createCollectionQueryService;
if (withoutReuse) {
  const start = source.indexOf("  function preparedHistoryQuery("), end = source.indexOf("  function preparedQuery(", start);
  assert(start >= 0 && end > start);
  const block = source.slice(start, end), slot = "const cached = queryBudget.read(queryCache, key);";
  assert.equal(block.split(slot).length, 2);
  subject = await factory(source.replace(block, block.replace(slot, "const cached = null;")));
}
if (process.argv.includes("--without-history-page-expiry")) {
  const slot = "if (!window || currentHistoryWindow(window, now)) return cached;";
  assert.equal(source.split(slot).length, 2);
  subject = await factory(source.replace(slot, "return cached;"));
}
const DAY = 86400000, fixedNow = Date.parse("2026-11-04T12:00:00Z"), RealDate = Date;
let clock = fixedNow, comparisons = 0;
class FixtureDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
globalThis.Date = FixtureDate;
function fixture(create, timestamps, timed = true, monotonicLibraryRevision = false) {
  const works = timestamps.map((_, index) => ({ id: String(index), title: "Work " + String(index).padStart(5, "0"),
    videos: [{ id: "video-" + index }], infoSummary: { code: "FIX-" + index }, playableCount: 1 }));
  const library = { scannedAt: "scan-1", worksById: new Map(works.map(work => [work.id, work])), filesById: new Map() };
  let userState = { favorites: {}, progress: Object.fromEntries(timestamps.map((time, index) => ["video-" + index,
    { workId: String(index), position: 5, duration: 100, updatedAt: typeof time === "number" ? new Date(time).toISOString() : time }])) };
  const state = { user: 1, info: 1, libraryRevision: 0, cacheable: true, fail: false,
    calls: { source: 0, filter: 0, sort: 0, facets: 0, trait: 0 } };
  const progress = createPlaybackProgressService({ getLibrary: () => library, getUserState: () => userState,
    getLibraryRevision: monotonicLibraryRevision ? (currentLibrary) => {
      assert.equal(currentLibrary, library, "history uses the revision of the captured library");
      return state.libraryRevision;
    } : undefined,
    userStateService: { revision: () => state.user, save() { state.user++; } }, publicFavoriteFolders: () => [], recentWatchedDays: 7 });
  const info = id => ({ rating: Number(id) % 5, releaseDate: "2026-01-01" });
  const favorites = { isFavoriteWork: () => false, publicFavoriteFolders: () => [], normalizeFavoriteFolderId: id => id, favoriteWorks: () => [] };
  const filter = createWorkFilterService({ favoriteStateService: favorites, playbackProgressService: progress, workInfoFacetRow: info });
  const sort = createWorkSorter({ metadataForWork: work => info(work.id), progressForWork: work => progress.getWorkProgress(work) });
  const provider = { historyEntries(options) { state.calls.source++; return progress.historyEntries(options); } };
  if (timed) provider.historySnapshot = options => { state.calls.source++; return progress.historySnapshot(options); };
  const collection = create({ getLibrary: () => library, playbackProgressService: provider, favoriteStateService: favorites,
    clampInteger: (value, fallback, min, max) => value == null || value === "" || !Number.isFinite(Number(value)) ? fallback
      : Math.max(min, Math.min(max, Math.trunc(Number(value)))), maxWorkLimit: 100000, recentWatchedDays: 7,
    userStateStamp: () => state.user, workQueryStamp: () => state.info, workInfoReadCacheable: () => state.cacheable,
    withWorkInfoReadStatus: callback => ({ value: callback(), cacheable: state.cacheable }),
    filterWorkList(rows, value) { state.calls.filter += rows.length; return filter.filter(rows, value); },
    sortWorkList(rows, value) { state.calls.sort += rows.length; return sort(rows, value); },
    workFacets(rows) { state.calls.facets += rows.length; return filter.facets(rows); },
    workInfoFacetRow(id) { state.calls.trait++; return info(id); },
    publicWork(work) { if (state.fail) throw new Error("controlled presentation failure"); return { id: work.id, title: work.title, user: state.user, info: state.cacheable ? state.info : null }; },
    prewarmCoreWorkCovers() {}, prewarmVideoProbesForWorks() {}, prewarmWorkInfoDetails() {}, prewarmRemoteImagesForWorks() {} });
  return { collection, state, works, library, provider, progress, get userState() { return userState; },
    switchUser() { state.user++; userState = { progress: {} }; } };
}
const pair = times => ({ current: fixture(subject, times), oracle: fixture(oracleFactory, times, false) });
const each = (owners, change) => { change(owners.current); change(owners.oracle); };
function read(owner, values = {}) {
  return owner.collection.historyPayload(new URL("http://fixture.invalid/api/history?" + new URLSearchParams({ days: 7, limit: 48, ...values })));
}
function compare(owners, values = {}) {
  const expected = read(owners.oracle, values), actual = read(owners.current, values);
  assert.deepEqual(actual, expected, "complete uncached history response");
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), "complete history JSON"); comparisons++;
  return actual;
}

async function readHistoryRoute(owner, days) {
  const response = {};
  const url = new URL(`http://fixture.invalid/api/history?days=${days}`);
  assert(await routeUserStateApi({ method: "GET" }, response, url, {
    library: owner.library,
    collectionQueryService: owner.collection,
    sendJson: (res, status, body) => Object.assign(res, { status, body })
  }));
  assert.equal(response.status, 200);
  return response.body;
}

async function verifyInPlaceLibraryRemoval(monotonicLibraryRevision) {
  const owner = fixture(subject, [fixedNow - DAY, fixedNow - 8 * DAY], true, monotonicLibraryRevision);
  const { library, state, progress } = owner;
  library.people = [];
  library.totals = { works: 2, videos: 2, playableVideos: 2 };
  for (const work of owner.works) {
    const video = work.videos[0];
    Object.assign(video, { type: "video", playable: true });
    library.filesById.set(video.id, video);
  }
  if (monotonicLibraryRevision) library.scannedAt = new Date().toISOString();
  const originalScannedAt = library.scannedAt;
  const personalRevision = state.user;
  const retainedProgress = owner.userState.progress;
  const all = await readHistoryRoute(owner, "all");
  const recent = await readHistoryRoute(owner, "7");
  assert.deepEqual(all.works.map(work => work.id), ["0", "1"]);
  assert.deepEqual(recent.works.map(work => work.id), ["0"]);
  assert.equal(progress.userStateSummary().historyCount, 2);

  assert.deepEqual(removeLocalWorksFromLibrary(library, ["0"], () => 0).removedWorkIds, ["0"]);
  state.libraryRevision++;
  state.info++; // The production mutation invalidates the upper collection query stamp too.
  assert.equal(state.user, personalRevision);
  assert.equal(owner.userState.progress, retainedProgress);
  assert(Object.hasOwn(retainedProgress, "video-0"), "deletion does not change the saved progress rows");
  if (monotonicLibraryRevision) assert.equal(library.scannedAt, originalScannedAt, "deletion happened in the same clock tick");
  else assert.notEqual(library.scannedAt, originalScannedAt);

  const nextAll = await readHistoryRoute(owner, "all");
  const nextRecent = await readHistoryRoute(owner, "7");
  assert.notEqual(nextAll, all);
  assert.notEqual(nextRecent, recent);
  assert.deepEqual(nextAll.works.map(work => work.id), ["1"], "a warmed history cannot keep a deleted work");
  assert.equal(nextAll.total, 1);
  assert.equal(nextRecent.total, 0);
  const summary = progress.userStateSummary();
  assert.equal(summary.historyCount, 1);
  assert.equal(summary.recentWatchedCount, 0);
  assert.equal(summary.latestProgressAt, retainedProgress["video-1"].updatedAt);
}

try {
  const scale = pair(Array.from({ length: 5000 }, (_, index) => fixedNow - 3 * DAY - index * 1000));
  for (let page = 0; page < 10; page++) { clock++; compare(scale, { offset: page * 48, sort: "title" }); }
  const visits = { previous: { ...scale.oracle.state.calls }, current: { ...scale.current.state.calls } };

  // A source member at the exact boundary is still included. A hidden member
  // must also expire the facets and total of a filtered, already-cached page.
  clock = fixedNow;
  const boundary = pair([fixedNow - 7 * DAY + 10, fixedNow - DAY, fixedNow - DAY, fixedNow - DAY, fixedNow - DAY]);
  const first = compare(boundary, { filter: "highRating" }); assert.equal(first.total, 1); assert.equal(first.facets.all, 5);
  clock += 10; assert.equal(compare(boundary, { filter: "highRating" }), first, "expiry is inclusive at the source cutoff");
  clock++; const expired = compare(boundary, { filter: "highRating" });
  assert.notEqual(expired, first); assert.equal(expired.total, 1); assert.equal(expired.facets.all, 4);
  // Another page has its own lifetime, including when its prepared query has
  // been evicted by unrelated filter selections.
  clock = fixedNow; compare(boundary, { offset: 1 });
  for (let index = 0; index < 35; index++) compare(boundary, { filter: "selection-" + index, limit: 1 });
  clock = fixedNow + 11; assert.equal(compare(boundary, { offset: 1 }).facets.all, 4);

  clock = fixedNow;
  const rollback = pair([fixedNow - 7 * DAY - 1000, fixedNow - DAY]);
  assert.equal(compare(rollback).total, 1); clock -= 2000; assert.equal(compare(rollback).total, 2);
  clock = fixedNow; assert.equal(compare(rollback).total, 1);
  const empty = pair([fixedNow - 8 * DAY]); assert.equal(compare(empty).total, 0);
  clock += DAY; assert.equal(compare(empty).total, 0); assert.equal(empty.current.state.calls.source, 1, "empty windows remain empty as the clock advances");
  clock = fixedNow - 2 * DAY; assert.equal(compare(empty).total, 1, "clock rollback can repopulate an empty source");

  for (const times of [[-1000, 0], ["invalid date", 0], [10, -10, 0]]) {
    clock = DAY - 1; const zero = pair(times);
    compare(zero, { days: 1 }); clock = DAY; assert.equal(compare(zero, { days: 1 }).facets.all, times.length);
    clock++; compare(zero, { days: 1 });
  }
  const clocks = [-DAY - 1, -1001, -1000, -1, 0, 1, DAY - 1001, DAY - 1000, DAY - 1, DAY, DAY + 1,
    7 * DAY - 1, 7 * DAY, 7 * DAY + 1, fixedNow, NaN, Infinity, -Infinity];
  const corpus = pair([-1000, 0, 1, DAY - 1, DAY, fixedNow - 7 * DAY + 10, fixedNow + DAY, "invalid date"]);
  for (const at of [...clocks, ...clocks.toReversed()]) {
    clock = at;
    for (const days of [1, 7]) for (const values of [{}, { offset: 1 }, { filter: "highRating" }, { filter: "highRating", offset: 1 }]) {
      compare(corpus, { days, ...values });
    }
  }
  clock = fixedNow;
  for (const change of [owner => { owner.state.user++; }, owner => { owner.state.info++; },
    owner => { owner.library.scannedAt = "scan-2"; }, owner => { owner.progress.saveVideoProgress("video-0", { position: 20, duration: 100, workId: "0" }); },
    owner => owner.switchUser()]) {
    const owners = pair([fixedNow - DAY, fixedNow - 8 * DAY]); compare(owners);
    const reads = owners.current.state.calls.source; each(owners, change); compare(owners);
    assert.equal(owners.current.state.calls.source, reads + 1, "existing source/account/metadata revisions retire timed queries and pages");
  }
  await verifyInPlaceLibraryRemoval(false);
  await verifyInPlaceLibraryRemoval(true);
  const recovery = pair([fixedNow - DAY]); each(recovery, owner => { owner.state.cacheable = false; });
  compare(recovery); each(recovery, owner => { owner.state.cacheable = true; }); compare(recovery); compare(recovery, { offset: 1 });
  assert.equal(recovery.current.state.calls.source, withoutReuse ? 3 : 2, "degraded metadata is retried on the same version and healthy queries may then be reused");
  const failure = pair([fixedNow - DAY]); each(failure, owner => { owner.state.fail = true; assert.throws(() => read(owner), /controlled presentation failure/); owner.state.fail = false; });
  compare(failure);
  for (const field of ["observedAt", "expiresAt"]) for (const bad of [NaN, -Infinity, "Infinity"]) {
    const invalid = fixture(subject, [fixedNow - DAY]); const original = invalid.provider.historySnapshot;
    invalid.provider.historySnapshot = options => ({ ...original(options), [field]: bad });
    read(invalid); read(invalid); assert.equal(invalid.state.calls.source, 2, "invalid time metadata cannot retain a page or prepared query");
  }
  const oversized = fixture(subject, Array.from({ length: 50001 }, () => fixedNow - DAY));
  read(oversized, { limit: 1 }); read(oversized, { limit: 1, offset: 1 });
  assert.equal(oversized.state.calls.source, 2, "timed queries share the original reference budget");

  console.log(JSON.stringify({ comparisons, historyWindowVisits: visits, sourceWindow: "inclusive cutoff, zero tick, clock rollback, hidden facets and version changes", noRealData: true }));
  assert.equal(visits.previous.source, 10);
  assert.equal(visits.current.source, 1, "a stable rolling window is loaded once for ten pages");
  for (const field of ["filter", "sort", "facets", "trait"]) {
    assert.equal(visits.previous[field], 50000); assert.equal(visits.current[field], 5000, "rolling pagination reuses " + field);
  }
  console.log("collection-history-window: PASS");
} finally { globalThis.Date = RealDate; }

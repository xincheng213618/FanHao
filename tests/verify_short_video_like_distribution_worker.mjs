import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

import { createShortVideoCatalogWorkerClient } from "../src/modules/short-videos/server/catalog-worker-client.js";
import { createShortVideosRuntime } from "../src/modules/short-videos/server/runtime.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { shortVideoLibraryInsights } from "../src/modules/short-videos/server/library-insights.js";
import { normalizeShortVideoStatsFilter } from "../src/modules/short-videos/server/stats-query.js";

const PRODUCTION_VIDEO_COUNT = 100_000;
const failureWorkerUrl = new URL("./fixtures/short_video_like_distribution_worker_failure.mjs", import.meta.url);
const realDbPath = argumentValue("--real-db");

const LEGACY_WATCH_INSIGHTS = String.raw`function watchInsights(libraryRows) {
  const labels = new Map([
    ["under_10", "少于 10 秒"],
    ["10_20", "10–20 秒"],
    ["20_30", "20–30 秒"],
    ["30_60", "30–60 秒"],
    ["60_plus", "60 秒以上"]
  ]);
  const order = [...labels.keys()];
  const watchedRows = libraryRows.filter((row) => String(row.last_watched_at || "").trim());
  const completedTotal = watchedRows.reduce((total, row) => total + (count(row.completed_count) > 0 ? 1 : 0), 0);
  const progressRates = watchedRows
    .filter((row) => count(row.duration_ms) > 0)
    .map((row) => Math.min(1, count(row.progress_ms) / count(row.duration_ms)));
  const watchedTimes = watchedRows.map((row) => String(row.last_watched_at || "")).filter(Boolean).sort();
  const bandMap = new Map();
  for (const row of watchedRows) {
    const durationMs = count(row.duration_ms);
    if (!durationMs) continue;
    const id = durationMs < 10000 ? "under_10"
      : durationMs < 20000 ? "10_20"
        : durationMs < 30000 ? "20_30"
          : durationMs < 60000 ? "30_60"
            : "60_plus";
    const band = bandMap.get(id) || { id, watched: 0, completed: 0 };
    band.watched += 1;
    if (count(row.completed_count) > 0) band.completed += 1;
    bandMap.set(id, band);
  }
  const watchedTotal = watchedRows.length;
  const libraryTotal = libraryRows.length;
  return {
    libraryTotal,
    watchedTotal,
    completedTotal,
    completionRate: rate(completedTotal, watchedTotal),
    coverageRate: rate(watchedTotal, libraryTotal),
    averageProgressRate: progressRates.length ? progressRates.reduce((total, value) => total + value, 0) / progressRates.length : 0,
    firstWatchedAt: watchedTimes[0] || "",
    lastWatchedAt: watchedTimes.at(-1) || "",
    durationBands: [...bandMap.values()].map((row) => {
      const watched = row.watched;
      const completed = row.completed;
      return {
        id: row.id,
        label: labels.get(row.id) || row.id,
        watched,
        completed,
        completionRate: rate(completed, watched)
      };
    }).sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
  };
}`;

if (process.argv.includes("--reserved-route-only")) await verifyReservedRouteGuardOnly();
else if (process.argv.includes("--corrupt-route-only")) await verifyCorruptFailure();
else if (realDbPath) await runRealReadOnlyBenchmark(path.resolve(realDbPath));
else await runFixtureVerification();

async function runFixtureVerification() {
  const watchRegression = await verifyWatchSinglePass();
  const fixture = createProductionShapeFixture(PRODUCTION_VIDEO_COUNT);
  try {
    const watchLibraryWork = watchRegression.verifyLibrary(fixture.dbPath);
    const legacyStore = createShortVideoStore({
      dbPath: fixture.dbPath,
      coverDbPath: fixture.coverDbPath,
      roots: [fixture.root],
      skipStartupMaintenance: true
    });
    let legacy;
    let legacyMs;
    try {
      const startedAt = performance.now();
      legacy = legacyStore.likeDistribution();
      legacyMs = performance.now() - startedAt;
    } finally {
      legacyStore.close();
    }

    const client = createShortVideoCatalogWorkerClient({ dbPath: fixture.dbPath });
    let workerColdMs;
    let workerHotMs;
    try {
      const coldStartedAt = performance.now();
      const cold = await client.queryLikeDistribution({ catalogStamp: fixture.stamp });
      workerColdMs = performance.now() - coldStartedAt;
      assertEquivalentDistribution(cold, legacy, "100k fixture worker payload");
      const dispatchAfterCold = client.diagnostics().likeDistributionDispatches;
      const hotStartedAt = performance.now();
      const hot = await client.queryLikeDistribution({ catalogStamp: fixture.stamp });
      workerHotMs = performance.now() - hotStartedAt;
      assert.deepEqual(hot, cold, "hot distribution cache must preserve generatedAt and the full payload");
      assert.equal(client.diagnostics().likeDistributionDispatches, dispatchAfterCold, "hot distribution cache must not dispatch worker work");

      await delay(2);
      client.invalidateLikeDistribution();
      assert.equal(client.diagnostics().likeDistributionCacheEntries, 0, "explicit distribution invalidation must clear the client cache");
      const beforeConcurrent = client.diagnostics().likeDistributionDispatches;
      const concurrent = await Promise.all(Array.from({ length: 100 }, () => (
        client.queryLikeDistribution({ catalogStamp: fixture.stamp })
      )));
      assert(concurrent.every((item) => JSON.stringify(item) === JSON.stringify(concurrent[0])), "100 concurrent distribution callers must share one result");
      assert.equal(client.diagnostics().likeDistributionDispatches, beforeConcurrent + 1, "100 concurrent distribution callers must dispatch exactly once");
      assert.notEqual(concurrent[0].generatedAt, cold.generatedAt, "explicit distribution invalidation must also clear the worker store cache");

      const beforeCatalogMutation = concurrent[0].bins.at(-1).videoCount;
      mutateCatalogFixture(fixture.dbPath);
      const changed = await client.queryLikeDistribution({ catalogStamp: "fixture-catalog-mutated" });
      assert.equal(changed.bins.at(-1).videoCount, beforeCatalogMutation + 1, "a changed catalog stamp must invalidate both client and worker distribution caches");
    } finally {
      await client.stop();
    }

    await verifyRuntimeRouteAndInvalidation(fixture);
    await verifyRefreshRequiresLocalAdmin(fixture);
    const health = await verifyArmedRouteHealth(fixture);
    await verifyRouteAbort(fixture);
    await verifyAbortIsolation(fixture);
    await verifyInFlightInvalidation();
    const failures = await verifyBoundedFailures(fixture);

    console.log(JSON.stringify({
      check: "short-video-like-distribution-worker",
      videos: PRODUCTION_VIDEO_COUNT,
      watchWork: { ...watchRegression.metrics, actualLibrary: watchLibraryWork },
      legacyMainThreadMs: round(legacyMs),
      workerColdMs: round(workerColdMs),
      workerHotMs: round(workerHotMs),
      healthP95Ms: round(health.p95Ms),
      healthMaxMs: round(health.maxMs),
      eventLoopMaxMs: round(health.eventLoopMaxMs),
      healthObservedDuringDistribution: health.observedDuringOperation,
      singleFlightCallers: 100,
      failureBoundsMs: failures
    }));
  } finally {
    removeFixture(fixture.root);
  }
}

function watchFunctionSource(source) {
  const start = source.indexOf("function watchInsights(libraryRows) {");
  const end = source.indexOf("\nfunction managerQualityAudit", start);
  assert(start >= 0 && end > start, "actual watch insight implementation must exist");
  return source.slice(start, end).trimEnd();
}

function measureWatchWork(task, rows) {
  const trackedRows = new WeakSet([rows]);
  const methods = ["filter", "map", "reduce", "sort"];
  const original = Object.fromEntries(methods.map(name => [name, Array.prototype[name]]));
  const originalIterator = Array.prototype[Symbol.iterator];
  const work = { rowVisits: 0, arrayLengths: [], sortLengths: [], defaultSortLengths: [] };
  for (const name of ["filter", "map", "reduce"]) {
    Array.prototype[name] = function(callback, ...args) {
      const tracked = trackedRows.has(this);
      const measured = tracked ? function(...values) {
        work.rowVisits += 1;
        return callback.apply(this, values);
      } : callback;
      const result = original[name].call(this, measured, ...args);
      if (Array.isArray(result)) {
        work.arrayLengths.push(result.length);
        if (tracked && name === "filter") trackedRows.add(result);
      }
      return result;
    };
  }
  Array.prototype[Symbol.iterator] = function() {
    const iterator = originalIterator.call(this);
    if (!trackedRows.has(this)) return iterator;
    return {
      next() {
        const result = iterator.next();
        if (!result.done) work.rowVisits += 1;
        return result;
      },
      [Symbol.iterator]() { return this; }
    };
  };
  Array.prototype.sort = function(compare) {
    work.sortLengths.push(this.length);
    if (compare === undefined) work.defaultSortLengths.push(this.length);
    return original.sort.call(this, compare);
  };
  try {
    return { response: task(rows), work };
  } finally {
    for (const name of methods) Array.prototype[name] = original[name];
    Array.prototype[Symbol.iterator] = originalIterator;
  }
}

async function verifyWatchSinglePass() {
  const moduleUrl = new URL("../src/modules/short-videos/server/library-insights.js", import.meta.url);
  const source = fs.readFileSync(moduleUrl, "utf8").replaceAll("\r\n", "\n");
  const actualWatch = watchFunctionSource(source);
  const oldSource = source.replace(actualWatch, LEGACY_WATCH_INSIGHTS);
  assert.equal(watchFunctionSource(oldSource), LEGACY_WATCH_INSIGHTS, "old oracle must restore the complete former watch function");
  assert.equal(oldSource.replace(LEGACY_WATCH_INSIGHTS, actualWatch), source, "old oracle must leave every other insight phase and SQL unchanged");
  const watchCall = "() => watchInsights(libraryRows)";
  assert.equal(source.split(watchCall).length, 2, "private measurement wrapper must target only the watch phase");
  async function importMeasured(text) {
    // Export and observe the private function only in this in-memory module.
    // The production function body and all other phases remain unchanged.
    text = text.replace(watchCall, "() => options.measureWatch ? options.measureWatch(watchInsights, libraryRows) : watchInsights(libraryRows)")
      + "\nexport { watchInsights };\n";
    text = text.replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) => "from " + JSON.stringify(new URL(relative, moduleUrl).href));
    return import("data:text/javascript;base64," + Buffer.from(text).toString("base64"));
  }
  const oldModule = await importMeasured(oldSource);
  const currentModule = await importMeasured(source);
  const testedModule = process.argv.includes("--legacy-watch-insights") ? oldModule : currentModule;
  const row = (timestamp, duration = 10000, progress = 3000, completed = 0) => ({
    last_watched_at: timestamp, duration_ms: duration, progress_ms: progress, completed_count: completed
  });
  const cases = [
    [],
    [row(""), row("   "), row("\t\n"), row(null), row(undefined), row(0), row(NaN), row(false)],
    [row("2026-01-02"), row("2026-01-01"), row("2026-01-02")],
    [row(" 2026-01-01 "), row("2026-01-01"), row("invalid date"), row("2026-01-01 ")],
    [row("\ue000"), row("\ud800"), row("\ud800\udc00"), row("\udc00"), row("Z"), row("é"), row("界")],
    [row(Infinity), row(-Infinity), row(-9), row(3), row(true), row(9n), row(Symbol("date"))],
    [row("bad1", NaN, NaN, NaN), row("bad2", "oops", "oops", "oops"), row("bad3", -5, -1, -1), row("bad4", 0, 0, 0)],
    [row("a", Infinity, 100, Infinity), row("b", Infinity, Infinity, 1), row("c", 100, Infinity, 0)],
    [row("a", 1, 0.1, 1), row("b", 1, 1e-300, 1), row("c", 3, 1, 1), row("d", 7, 1, 0)],
    [row("a", 1, 1, 1), row("b", 1, 1e-16, 0), row("c", 1, 1e-16, 0)],
    [9999, 10000, 19999, 20000, 29999, 30000, 59999, 60000].map((duration, i) => row("date" + i, duration, duration + 1, i % 2))
  ];
  const finiteOrder = cases.at(-2);
  const finiteAverage = oldModule.watchInsights(finiteOrder).averageProgressRate;
  assert(Number.isFinite(finiteAverage), "finite mixed-magnitude progress must not be masked by NaN");
  assert.notEqual(oldModule.watchInsights([...finiteOrder].reverse()).averageProgressRate, finiteAverage,
    "the finite progress oracle must detect a changed summation order");
  for (const rows of cases) {
    const old = oldModule.watchInsights(rows);
    const current = testedModule.watchInsights(rows);
    assert.deepEqual(current, old, "watch boundaries must preserve the complete old DTO including NaN and Infinity");
    assert.equal(JSON.stringify(current), JSON.stringify(old), "watch boundary JSON must preserve the old response");
  }
  const sameError = new Error("watch numeric conversion");
  const badNumber = { valueOf() { throw sameError; } };
  for (const module of [oldModule, testedModule]) {
    assert.throws(() => module.watchInsights([row("watched", badNumber)]), error => error === sameError);
  }
  const dense = Array.from({ length: PRODUCTION_VIDEO_COUNT }, (_, index) => row(
    "time" + String(index * 7919 % PRODUCTION_VIDEO_COUNT).padStart(6, "0"),
    [5000, 15000, 25000, 45000, 75000][index % 5], index % 100000, index % 7 === 0 ? 1 : 0
  ));
  const before = measureWatchWork(oldModule.watchInsights, dense);
  const after = measureWatchWork(testedModule.watchInsights, dense);
  assert.deepEqual(after.response, before.response, "100k watch rows retain all values and progress sum order");
  assert.equal(JSON.stringify(after.response), JSON.stringify(before.response));
  assert.equal(before.work.rowVisits, PRODUCTION_VIDEO_COUNT * 6, "the old watch function actually traverses every dense row six times");
  assert.deepEqual(before.work.defaultSortLengths, [PRODUCTION_VIDEO_COUNT], "the old watch function actually sorts all watch strings");
  assert.equal(before.work.arrayLengths.filter(length => length === PRODUCTION_VIDEO_COUNT).length, 5, "the old watch function actually creates five full-size temporary arrays");
  assert.equal(after.work.rowVisits, PRODUCTION_VIDEO_COUNT, "watch row visit budget must be exactly one pass");
  assert.deepEqual(after.work.defaultSortLengths, [], "watch timestamps must not need an all-row string sort");
  assert.deepEqual(after.work.sortLengths, [5], "retain only the existing five-band presentation order");
  assert.equal(after.work.arrayLengths.filter(length => length > 5).length, 0, "watch arrays must stay bounded to the duration bands");
  return {
    metrics: { boundaryCases: cases.length, rows: dense.length, old: before.work, current: after.work },
    verifyLibrary(dbPath) {
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        let oldWork, currentWork;
        const former = oldModule.shortVideoLibraryInsights(database, {
          measureWatch(task, rows) { const measured = measureWatchWork(task, rows); oldWork = measured.work; return measured.response; }
        });
        const current = testedModule.shortVideoLibraryInsights(database, {
          measureWatch(task, rows) { const measured = measureWatchWork(task, rows); currentWork = measured.work; return measured.response; }
        });
        const actual = shortVideoLibraryInsights(database);
        assert.equal(JSON.stringify(current), JSON.stringify(former), "private 100k actual-schema library insights retain the complete old personal and health response");
        assert.equal(JSON.stringify(actual), JSON.stringify(current), "the measured current module must preserve the actual production response");
        assert.equal(currentWork.rowVisits, current.personal.watch.libraryTotal, "actual SQLite rows must receive exactly one watch pass");
        assert.deepEqual(currentWork.defaultSortLengths, []);
        assert(oldWork.rowVisits > currentWork.rowVisits, "the actual catalog must exercise the removed repeated watch traversals");
        assert(oldWork.defaultSortLengths[0] === former.personal.watch.watchedTotal && former.personal.watch.watchedTotal > 0);
        return { rows: actual.personal.watch.libraryTotal, watchedRows: actual.personal.watch.watchedTotal, old: oldWork, current: currentWork };
      } finally { database.close(); }
    }
  };
}

async function verifyRuntimeRouteAndInvalidation(fixture) {
  const runtime = fixtureRuntime(fixture);
  try {
    const first = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(first.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 1, "the real runtime route must dispatch to the catalog worker");
    const hot = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.deepEqual(hot.data, first.data, "the real route must preserve the hot JSON contract including generatedAt");
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 1, "the real route hot cache must stay worker-free");

    const managerWriter = openManagerWalMutation(fixture.managerDbPath);
    try {
      const afterManagerChange = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
      assert.equal(afterManagerChange.status, 200);
      assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 2, "download-manager WAL changes must invalidate the route cache without opening the main-thread store for a stamp");

      await delay(2);
      const refreshed = await runtimeRequest(runtime, "POST", "/api/short-videos/like-distribution/refresh");
      assert.equal(refreshed.status, 200);
      assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 3, "the administrator refresh route must force a new worker aggregate for an unchanged stamp");
      assert.notEqual(refreshed.data.generatedAt, afterManagerChange.data.generatedAt, "the administrator refresh route must clear the worker store cache before recomputing");
      const hotAfterRefresh = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
      assert.deepEqual(hotAfterRefresh.data, refreshed.data, "ordinary GET must continue using the freshly rebuilt cache");
      assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 3, "ordinary GET after a forced refresh must remain worker-free");
    } finally {
      managerWriter.close();
    }

    const action = await runtimeRequest(runtime, "PUT", "/api/short-videos/fixture-000001/actions/like", { active: false });
    assert.equal(action.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "a user-action mutation must clear the distribution cache");
    const afterAction = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterAction.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 4, "a user-action mutation must force a new worker aggregate");
    assert.equal(afterAction.data.insights.personal.authorEfficiency.likedVideos, first.data.insights.personal.authorEfficiency.likedVideos - 1);

    const watch = await runtimeRequest(runtime, "PUT", "/api/short-videos/fixture-000001/watch", {
      progressMs: 900,
      completed: true
    });
    assert.equal(watch.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "a watch mutation must clear the client distribution cache");
    const afterWatch = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterWatch.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 5, "a watch mutation must force a new worker aggregate");
    assert.equal(afterWatch.data.insights.personal.watch.watchedTotal, afterAction.data.insights.personal.watch.watchedTotal + 1);

    mutateCatalogFixture(fixture.dbPath, "fixture-000002");
    runtime.clearListCache();
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "catalog generation invalidation must clear the distribution cache");
    const afterCatalog = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterCatalog.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 6, "catalog generation invalidation must dispatch a new worker aggregate");

    const deleted = await runtimeRequest(runtime, "DELETE", "/api/short-videos/fixture-000004", { deleteFiles: false });
    assert.equal(deleted.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "the real delete mutation route must reset the distribution cache");
    const afterDelete = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterDelete.data.total, afterCatalog.data.total - 1, "delete mutation invalidation must expose the new catalog total");
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 7);

    const imported = await runtime.syncCatalog({ force: true });
    assert(imported && imported.catalogChanged === true && imported.imported >= 1, "the real download-manager import must report a catalog change");
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "the download-manager import callback must reset the distribution cache");
    const afterImport = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterImport.data.total, afterDelete.data.total + 1, "import invalidation must expose the imported video");
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 8);

    await verifyReservedSingletonRouting(runtime);
  } finally {
    await runtime.stop();
    runtime.store.close();
  }
}

async function verifyRefreshRequiresLocalAdmin(fixture) {
  let adminChecks = 0;
  const runtime = fixtureRuntime(fixture, {}, {
    requireLocalAdmin(_req, res) {
      adminChecks += 1;
      res.status = 403;
      res.data = { error: "forbidden" };
      return false;
    }
  });
  try {
    const response = await runtimeRequest(runtime, "POST", "/api/short-videos/like-distribution/refresh");
    assert.equal(response.status, 403, "distribution refresh must reject callers that are not local administrators");
    assert.equal(adminChecks, 1);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 0, "rejected refresh requests must not start worker work");
  } finally {
    await runtime.stop();
    runtime.store.close();
  }
}

async function verifyReservedRouteGuardOnly() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-reserved-short-video-routes-"));
  const fixture = {
    dbPath: path.join(root, "catalog.sqlite"),
    managerDbPath: "",
    cacheRoot: path.join(root, "cache")
  };
  const store = createShortVideoStore({ dbPath: fixture.dbPath, roots: [], skipStartupMaintenance: false });
  store.summary();
  store.close();
  const runtime = fixtureRuntime(fixture);
  try {
    await verifyReservedSingletonRouting(runtime);
  } finally {
    await runtime.stop();
    runtime.store.close();
    removeFixture(root);
  }
}

async function verifyReservedSingletonRouting(runtime) {
  const originalVideoFile = runtime.store.videoFile;
  const originalSummary = runtime.store.summary;
  const originalVideoDetail = runtime.store.videoDetail;
  let videoFileCalls = 0;
  let videoDetailCalls = 0;
  const videoFileIds = [];
  const videoDetailIds = [];
  runtime.store.videoFile = (id) => {
    videoFileCalls += 1;
    videoFileIds.push(id);
    return null;
  };
  runtime.store.summary = () => ({ fixture: true });
  runtime.store.videoDetail = (id) => {
    videoDetailCalls += 1;
    videoDetailIds.push(id);
    return null;
  };
  try {
    await runtimeRequest(runtime, "GET", "/api/short-videos/summary");
    await runtimeRequest(runtime, "GET", "/api/short-videos/facets");
    await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    const unsupportedGet = await runtimeRequest(runtime, "GET", "/api/short-videos/quality-upgrades");
    const unsupportedMethod = await runtimeRequest(runtime, "POST", "/api/short-videos/summary");
    const encodedReserved = await runtimeRequest(runtime, "GET", "/api/short-videos/%73ummary");
    const malformed = await runtimeRequest(runtime, "GET", "/api/short-videos/%ZZ");
    assert.equal(unsupportedGet.status, 404);
    assert.equal(unsupportedMethod.status, 404);
    assert.equal(encodedReserved.status, 404);
    assert.equal(malformed.status, 400);
    assert.equal(videoFileCalls, 0, "reserved singleton APIs must never enter detail media preloading");
    assert.equal(videoDetailCalls, 0, "reserved singleton APIs and unsupported methods must never fall through to dynamic video detail");
    await runtimeRequest(runtime, "GET", "/api/short-videos/videos/summary");
    assert.equal(videoFileCalls, 0, "the explicit reserved-video alias must bypass legacy preloading");
    assert.equal(videoDetailCalls, 1, "the explicit reserved-video alias must preserve access to a real video with a reserved ID");
    await runtimeRequest(runtime, "GET", "/api/short-videos/real%20video");
    assert.equal(videoFileCalls, 1, "a real detail-shaped route must still enter media preloading");
    assert.equal(videoDetailCalls, 2, "a real detail-shaped route must still query video detail");
    assert.deepEqual(videoFileIds, ["real video"], "preloading must use the safely decoded real video ID");
    assert.deepEqual(videoDetailIds, ["summary", "real video"], "detail lookup must preserve explicit reserved aliases and safely decoded ordinary IDs");
  } finally {
    runtime.store.videoFile = originalVideoFile;
    runtime.store.summary = originalSummary;
    runtime.store.videoDetail = originalVideoDetail;
  }
}

async function verifyRouteAbort(fixture) {
  const runtime = fixtureRuntime(fixture, { likeDistributionDelayMs: 800 });
  try {
    runtime.clearListCache();
    const request = new EventEmitter();
    request.method = "GET";
    const response = {};
    const startedAt = performance.now();
    const pending = runtime.routeApi(request, response, new URL("http://fixture/api/short-videos/like-distribution"));
    while (runtime.catalogWorkerDiagnostics().likeDistributionDispatches < 1) await delay(1);
    request.emit("aborted");
    await pending;
    const elapsed = performance.now() - startedAt;
    assert.equal(response.status, 499, "an aborted distribution route must terminate with the explicit cancellation mapping");
    assert(elapsed < 500, `an aborted route must not keep waiting for the worker aggregate (${elapsed.toFixed(1)}ms)`);
    assert.equal(runtime.catalogWorkerDiagnostics().workerStarts, 1, "caller abort must not restart the shared catalog worker");
    assert.equal(runtime.catalogWorkerDiagnostics().pendingRequests, 1, "route abort must detach only its waiter instead of terminating the shared worker flight");
  } finally {
    await runtime.stop();
    runtime.store.close();
  }
}

async function verifyAbortIsolation(fixture) {
  const client = createShortVideoCatalogWorkerClient({
    dbPath: fixture.dbPath,
    downloadManagerDbPath: fixture.managerDbPath,
    extraWorkerData: { likeDistributionDelayMs: 250 }
  });
  const controller = new AbortController();
  try {
    const cancelled = client.queryLikeDistribution({ catalogStamp: "abort-isolation", signal: controller.signal });
    const survivor = client.queryLikeDistribution({ catalogStamp: "abort-isolation" });
    while (client.diagnostics().likeDistributionDispatches < 1) await delay(1);
    const starts = client.diagnostics().workerStarts;
    controller.abort();
    const stats = client.queryStats(normalizeShortVideoStatsFilter(new URLSearchParams("source=all")), { catalogStamp: "abort-isolation" });
    const recommended = client.query(new URL("http://fixture/api/short-videos?source=recommended&stats=0&limit=4&facets=0"), "list");
    const authors = client.query(new URL("http://fixture/api/short-videos/authors"), "authors");
    await assert.rejects(cancelled, (error) => error?.name === "AbortError");
    const [distribution, statsResult, recommendedResult, authorsResult] = await Promise.all([survivor, stats, recommended, authors]);
    assert(distribution.total > 0 && statsResult.likes >= 0);
    assert(Array.isArray(recommendedResult.videos) && recommendedResult.videos.length > 0);
    assert(Array.isArray(authorsResult.authors) && authorsResult.authors.length > 0);
    assert.equal(client.diagnostics().workerStarts, starts, "one distribution caller abort must not restart or reject the shared catalog worker");
  } finally {
    await client.stop();
  }
}

async function verifyArmedRouteHealth(fixture) {
  const runtime = fixtureRuntime(fixture, { likeDistributionDelayMs: 450 });
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    const response = {};
    await runtime.routeApi({ method: "GET" }, response, new URL(`http://fixture${req.url}`));
    res.writeHead(response.status || 500, { "content-type": "application/json" });
    res.end(JSON.stringify(response.data || {}));
  });
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const healthy = await measureArmedHealth(
      () => fetch(`${baseUrl}/api/short-videos/like-distribution`).then(async (response) => {
        assert.equal(response.status, 200);
        return response.json();
      }),
      `${baseUrl}/health`
    );
    assert(healthy.probesBeforeOperation >= 2, "health probes must be armed before the distribution route starts");
    assert(healthy.observedDuringOperation > 0, "health probes must overlap the distribution worker operation");
    assert(healthy.p95Ms < 250, `worker distribution must keep armed health responsive (${healthy.p95Ms.toFixed(1)}ms)`);
    assert(healthy.eventLoopMaxMs < 250, `worker distribution must keep the event loop responsive (${healthy.eventLoopMaxMs.toFixed(1)}ms)`);

    const blocked = await measureArmedHealth(async () => {
      const until = performance.now() + 320;
      while (performance.now() < until) {}
      return { ok: true };
    }, `${baseUrl}/health`);
    assert(blocked.probesBeforeOperation >= 2, "the artificial-block gate must arm probes first");
    assert(blocked.eventLoopMaxMs >= 250 || blocked.maxMs >= 250, "the armed health gate must detect an artificial main-thread block");
    return healthy;
  } finally {
    await closeServer(server);
    await runtime.stop();
    runtime.store.close();
  }
}

async function verifyInFlightInvalidation() {
  const valueBuffer = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(valueBuffer), 0, 1);
  const client = createShortVideoCatalogWorkerClient({
    dbPath: "fixture-only",
    workerUrl: failureWorkerUrl,
    extraWorkerData: { mode: "success", delayMs: 180, valueBuffer }
  });
  try {
    const stale = client.queryLikeDistribution({ catalogStamp: "before-watch" });
    while (client.diagnostics().likeDistributionDispatches < 1) await delay(1);
    client.invalidateLikeDistribution();
    Atomics.store(new Int32Array(valueBuffer), 0, 2);
    await assert.rejects(stale, (error) => error?.code === "SHORT_VIDEO_LIKE_DISTRIBUTION_STALE" && error?.statusCode === 503);
    assert.equal(client.diagnostics().likeDistributionCacheEntries, 0, "an invalidated in-flight result must never refill the cache");
    const fresh = await client.queryLikeDistribution({ catalogStamp: "after-watch" });
    assert.equal(fresh.total, 2, "the post-invalidation worker request must observe the new revision");
  } finally {
    await client.stop();
  }
}

async function verifyBoundedFailures(fixture) {
  const bounds = {};
  bounds.busy = round(await verifyBusyFailure(fixture));
  bounds.crash = round(await verifyCrashRecovery());
  bounds.corrupt = round(await verifyCorruptFailure());
  bounds.timeout = round(await verifyTimeoutFailure());
  bounds.redacted = round(await verifyPathRedaction());
  await verifyStopStart(fixture);
  return bounds;
}

async function verifyBusyFailure(fixture) {
  const locker = new DatabaseSync(fixture.dbPath);
  locker.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;");
  const client = createShortVideoCatalogWorkerClient({ dbPath: fixture.dbPath, statsRetryLimit: 1 });
  const startedAt = performance.now();
  try {
    await assert.rejects(
      client.queryLikeDistribution({ catalogStamp: "busy" }),
      assertGenericDistribution503
    );
    const elapsed = performance.now() - startedAt;
    assert(elapsed < 5000, `busy failure must be bounded (${elapsed.toFixed(1)}ms)`);
    assert(client.diagnostics().likeDistributionDispatches <= 2, "busy retries must remain bounded");
    return elapsed;
  } finally {
    try { locker.exec("ROLLBACK"); } catch {}
    locker.close();
    await client.stop();
  }
}

async function verifyCrashRecovery() {
  const attemptBuffer = new SharedArrayBuffer(4);
  const client = createShortVideoCatalogWorkerClient({
    dbPath: "fixture-only",
    workerUrl: failureWorkerUrl,
    extraWorkerData: { mode: "crash-first", attemptBuffer }
  });
  const startedAt = performance.now();
  try {
    const result = await client.queryLikeDistribution({ catalogStamp: "crash" });
    assert.equal(result.total, 1);
    assert.equal(client.diagnostics().likeDistributionRetries, 1, "one worker crash must retry exactly once");
    assert.equal(client.diagnostics().workerStarts, 2, "one worker crash must create one replacement worker");
    return performance.now() - startedAt;
  } finally {
    await client.stop();
  }
}

async function verifyCorruptFailure() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-like-distribution-corrupt-"));
  const dbPath = path.join(root, "private-catalog.sqlite");
  fs.writeFileSync(dbPath, "not a sqlite database");
  const client = createShortVideoCatalogWorkerClient({ dbPath });
  const startedAt = performance.now();
  let elapsed;
  try {
    await assert.rejects(client.queryLikeDistribution({ catalogStamp: "corrupt" }), assertGenericDistribution503);
    assert.equal(client.diagnostics().likeDistributionDispatches, 1, "corruption must fail closed without futile retries");
    elapsed = performance.now() - startedAt;
  } finally {
    await client.stop();
  }
  const runtime = fixtureRuntime({ dbPath, managerDbPath: "", cacheRoot: path.join(root, "cache") });
  try {
    const response = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(response.status, 503, "the real corrupt-database route must return 503 without a main-thread fallback");
    assert.deepEqual(response.data, { error: "短视频统计后台线程暂时不可用" });
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 1, "the corrupt route must still use the worker operation");
    assert(!JSON.stringify(response.data).includes(path.basename(dbPath)), "the API response must not expose the corrupt database path");
  } finally {
    await runtime.stop();
    runtime.store.close();
    removeFixture(root);
  }
  return elapsed;
}

async function verifyTimeoutFailure() {
  const client = createShortVideoCatalogWorkerClient({
    dbPath: "fixture-only",
    workerUrl: failureWorkerUrl,
    likeDistributionTimeoutMs: 120,
    statsRetryLimit: 0,
    extraWorkerData: { mode: "hang" }
  });
  const startedAt = performance.now();
  try {
    await assert.rejects(client.queryLikeDistribution({ catalogStamp: "timeout" }), assertGenericDistribution503);
    const elapsed = performance.now() - startedAt;
    assert(elapsed < 1000, `hung worker timeout must be bounded (${elapsed.toFixed(1)}ms)`);
    return elapsed;
  } finally {
    await client.stop();
  }
}

async function verifyPathRedaction() {
  const client = createShortVideoCatalogWorkerClient({
    dbPath: "fixture-only",
    workerUrl: failureWorkerUrl,
    statsRetryLimit: 0,
    extraWorkerData: { mode: "path-error" }
  });
  const startedAt = performance.now();
  try {
    await assert.rejects(client.queryLikeDistribution({ catalogStamp: "redact" }), (error) => {
      assertGenericDistribution503(error);
      assert(!error.message.includes("private-user") && !error.message.includes(".sqlite") && !String(error.stack).includes("secret-catalog"));
      return true;
    });
    return performance.now() - startedAt;
  } finally {
    await client.stop();
  }
}

async function verifyStopStart(fixture) {
  const client = createShortVideoCatalogWorkerClient({ dbPath: fixture.dbPath });
  await client.stop();
  await assert.rejects(client.queryLikeDistribution({ catalogStamp: "stopped" }), assertGenericDistribution503);
  await client.start();
  assert.equal(client.diagnostics().workerActive, false, "start must reopen the worker client lazily");
  const result = await client.queryLikeDistribution({ catalogStamp: "restarted" });
  const galleryTotal = Math.floor((PRODUCTION_VIDEO_COUNT - 1) / 5) + 1;
  const pendingTotal = Math.floor((PRODUCTION_VIDEO_COUNT - 1) / 101) + 1;
  const pendingGalleryTotal = Math.floor((PRODUCTION_VIDEO_COUNT - 1) / 505) + 1;
  assert.equal(result.total, PRODUCTION_VIDEO_COUNT - galleryTotal - pendingTotal + pendingGalleryTotal);
  await client.stop();
  assert.equal(client.diagnostics().pendingRequests, 0, "stop must settle all worker requests");
}

async function runRealReadOnlyBenchmark(dbPath) {
  assert(fs.statSync(dbPath).isFile(), "--real-db must point to a SQLite file");
  const downloadManagerDbPath = argumentValue("--download-manager-db");
  const store = createShortVideoStore({
    dbPath,
    downloadManagerDbPath,
    readOnly: true,
    skipStartupMaintenance: true,
    roots: []
  });
  let legacy;
  let legacyMs;
  try {
    const startedAt = performance.now();
    legacy = store.likeDistribution({ catalogStamp: "real-read-only" });
    legacyMs = performance.now() - startedAt;
  } finally {
    store.close();
  }
  const client = createShortVideoCatalogWorkerClient({ dbPath, downloadManagerDbPath });
  try {
    const coldStartedAt = performance.now();
    const cold = await client.queryLikeDistribution({ catalogStamp: "real-read-only" });
    const workerColdMs = performance.now() - coldStartedAt;
    const hotStartedAt = performance.now();
    const hot = await client.queryLikeDistribution({ catalogStamp: "real-read-only" });
    const workerHotMs = performance.now() - hotStartedAt;
    assertEquivalentDistribution(cold, legacy, "real read-only worker payload");
    assert.deepEqual(hot, cold, "real read-only hot cache must preserve the cold payload");
    const healthClient = createShortVideoCatalogWorkerClient({
      dbPath,
      downloadManagerDbPath,
      extraWorkerData: { likeDistributionDelayMs: 300 }
    });
    let health;
    try {
      health = await measureArmedHealth(
        () => healthClient.queryLikeDistribution({ catalogStamp: "real-read-only-health" }),
        null
      );
    } finally {
      await healthClient.stop();
    }
    assert(health.probesBeforeOperation >= 2);
    assert(health.observedDuringOperation > 0);
    assert(health.p95Ms < 250 && health.eventLoopMaxMs < 250, "real read-only worker aggregate must keep health responsive");
    console.log(JSON.stringify({
      check: "short-video-like-distribution-real-readonly",
      sourceReadOnly: true,
      videos: cold.total,
      legacyMainThreadMs: round(legacyMs),
      workerColdMs: round(workerColdMs),
      workerHotMs: round(workerHotMs),
      healthP95Ms: round(health.p95Ms),
      healthMaxMs: round(health.maxMs),
      eventLoopMaxMs: round(health.eventLoopMaxMs),
      equivalent: true
    }));
  } finally {
    await client.stop();
  }
}

function createProductionShapeFixture(videoCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-like-distribution-"));
  const dbPath = path.join(root, "catalog.sqlite");
  const coverDbPath = path.join(root, "covers.sqlite");
  const managerDbPath = path.join(root, "download-manager.sqlite");
  const importedMediaPath = path.join(root, "manager-import-video.mp4");
  const store = createShortVideoStore({ dbPath, coverDbPath, roots: [], skipStartupMaintenance: false });
  store.summary();
  store.close();
  fs.writeFileSync(importedMediaPath, "fixture manager video");
  const managerDb = new DatabaseSync(managerDbPath);
  managerDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE fixture_marker (value INTEGER NOT NULL);
    INSERT INTO fixture_marker VALUES (1);
    CREATE TABLE profiles (
      id INTEGER PRIMARY KEY, tab TEXT, sec_uid TEXT, url TEXT, nickname TEXT,
      profile_collected_at TEXT, updated_at TEXT,
      account_status TEXT NOT NULL DEFAULT 'active', account_status_reason TEXT,
      account_status_detected_at TEXT
    );
    CREATE TABLE links (
      id INTEGER PRIMARY KEY, profile_id INTEGER, aweme_id TEXT, status TEXT,
      kind TEXT, media_type TEXT, output_dir TEXT, local_file_paths TEXT,
      downloaded_at TEXT, actual_width INTEGER, actual_height INTEGER,
      actual_bit_rate INTEGER, actual_codec TEXT, actual_frame_rate REAL,
      actual_pixels INTEGER, actual_long_edge INTEGER, actual_probed_at TEXT,
      actual_probe_error TEXT, digg_count INTEGER, comment_count INTEGER,
      collect_count INTEGER, share_count INTEGER
    );
    INSERT INTO profiles (
      id, tab, sec_uid, url, nickname, profile_collected_at, updated_at
    ) VALUES (
      1, 'like', 'manager-import-author', '', '导入作者',
      '2026-08-12T01:00:00.000Z', '2026-08-12T01:00:00.000Z'
    );
  `);
  managerDb.prepare(`
    INSERT INTO links (
      id, profile_id, aweme_id, status, kind, media_type, output_dir,
      local_file_paths, downloaded_at, actual_width, actual_height,
      actual_bit_rate, actual_codec, actual_frame_rate, actual_pixels,
      actual_long_edge, actual_probed_at, actual_probe_error, digg_count,
      comment_count, collect_count, share_count
    ) VALUES (
      1, 1, 'manager-import-video', 'downloaded', 'video', 'video', ?, ?,
      '2026-08-12T01:00:00.000Z', 1080, 1920, 3000000, 'h264', 30,
      2073600, 1920, '2026-08-12T01:00:01.000Z', '', 6000000, 10, 5, 2
    )
  `).run(root, JSON.stringify([importedMediaPath]));
  managerDb.close();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; BEGIN IMMEDIATE;");
  const insertVideo = db.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, is_liked, author_sec_uid, author_name,
      title, published_at, liked_at, duration_ms, actual_width, actual_height,
      actual_pixels, digg_count, comment_count, collect_count, share_count,
      play_count, source_path, size_bytes, mtime_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStats = db.prepare(`
    INSERT INTO short_video_stats (video_id, digg_count, comment_count, collect_count, share_count, play_count, snapshot_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWatch = db.prepare(`
    INSERT INTO short_video_watch_history (local_user_id, video_id, progress_ms, completed_count, last_watched_at)
    VALUES ('local:self', ?, ?, ?, ?)
  `);
  const insertTopic = db.prepare("INSERT INTO short_video_topics (video_id, topic_key, topic) VALUES (?, ?, ?)");
  const insertSound = db.prepare("INSERT INTO short_video_sounds (video_id, sound_key, title) VALUES (?, ?, ?)");
  try {
    for (let index = 0; index < videoCount; index += 1) {
      const id = `fixture-${String(index).padStart(6, "0")}`;
      const awemeId = String(900000000000000000n + BigInt(index));
      const published = `2026-${String(index % 12 + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}T00:00:00.000Z`;
      insertVideo.run(
        id, awemeId, index % 101 === 0 ? "pending" : "local_only", index % 5 === 0 ? "gallery" : "video",
        index % 2, `fixture-author-${index % 64}`, `测试作者 ${index % 64}`, `生产形状点赞分布 ${index}`,
        published, published, 1000 + index % 300000, 1080, 1920, 2073600, index % 6 === 0 ? 0 : 1000 + index % 4_999_000,
        index % 1000, index % 500, index % 250, index % 100000, `X:\\fixture\\${id}.mp4`, 1024 + index * 17, index, published
      );
      if (index % 3 === 0) insertStats.run(id, index % 6 === 0 ? 0 : 1000 + index % 4_999_000, index % 1000, index % 500, index % 250, index % 100000, published, published);
      if (index % 13 === 0) insertWatch.run(id, index % 100000, index % 2, published);
      if (index % 11 === 0) insertTopic.run(id, `topic-${index % 32}`, `主题 ${index % 32}`);
      if (index % 17 === 0) insertSound.run(id, `sound-${index % 24}`, `声音 ${index % 24}`);
    }
    const stamp = "2026-08-12T00:00:00.000Z";
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanned_at', ?)").run(stamp);
    db.exec("COMMIT");
    return { root, dbPath, coverDbPath, managerDbPath, cacheRoot: path.join(root, "cache"), stamp };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function openManagerWalMutation(managerDbPath) {
  return openWalMutation(managerDbPath, (database) => {
    database.prepare("UPDATE fixture_marker SET value = value + 1").run();
  });
}

function openWalMutation(dbPath, mutate) {
  const before = fs.statSync(dbPath, { bigint: true });
  const database = new DatabaseSync(dbPath);
  try {
    database.exec("PRAGMA wal_autocheckpoint = 0; BEGIN IMMEDIATE;");
    mutate(database);
    database.exec("COMMIT");
    const wal = fs.statSync(`${dbPath}-wal`, { bigint: true });
    const after = fs.statSync(dbPath, { bigint: true });
    assert(wal.size > 0n, "the WAL fixture mutation must remain in a live sqlite -wal file");
    assert.equal(after.size, before.size, "the WAL fixture mutation must not change the main sqlite file size");
    assert.equal(after.mtimeNs, before.mtimeNs, "the WAL fixture mutation must not change the main sqlite file mtime");
    return database;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    database.close();
    throw error;
  }
}

function mutateCatalogFixture(dbPath, id = "fixture-000003") {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE short_videos SET digg_count = 6000000 WHERE id = ?").run(id);
    db.prepare("UPDATE short_video_stats SET digg_count = 6000000 WHERE video_id = ?").run(id);
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanned_at', ?)").run(`2026-08-12T00:00:${id.slice(-2)}.000Z`);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function fixtureRuntime(fixture, extraWorkerData = {}, runtimeOverrides = {}) {
  return createShortVideosRuntime({
    dbPath: fixture.dbPath,
    downloadManagerDbPath: fixture.managerDbPath || "",
    downloadManagerSyncMs: 0,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    roots: [fixture.root],
    mediaResponseService: { serveImage() {} },
    mediaStreamService: { serveVideo() {} },
    notFound(res) { res.status = 404; res.data = { error: "not found" }; },
    readJsonBody: async (req) => req?.body || {},
    requireLocalAdmin: () => true,
    sendJson(res, status, data) { res.status = status; res.data = data; },
    sharedCache: { rootDir: fixture.cacheRoot, scheduleCleanup() {}, touch() {} },
    catalogWorkerOptions: { extraWorkerData },
    ...runtimeOverrides
  });
}

async function runtimeRequest(runtime, method, pathname, body = null) {
  const response = {};
  const handled = await runtime.routeApi({ method, body }, response, new URL(`http://fixture${pathname}`));
  assert.equal(handled, true, `${method} ${pathname} must be handled`);
  return { status: response.status, data: response.data };
}

async function measureArmedHealth(operation, healthUrl) {
  let operationActive = false;
  let operationComplete = false;
  let observedDuringOperation = 0;
  const timings = [];
  const eventLoopLags = [];
  const intervalMs = 5;
  let previousSampleAt = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    eventLoopLags.push(Math.max(0, now - previousSampleAt - intervalMs));
    previousSampleAt = now;
  }, intervalMs);
  const probe = async () => {
    const startedAt = performance.now();
    if (healthUrl) {
      const response = await fetch(healthUrl);
      await response.arrayBuffer();
      assert.equal(response.status, 200);
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
    timings.push(performance.now() - startedAt);
    if (operationActive && !operationComplete) observedDuringOperation += 1;
  };
  let probing = true;
  const probeLoop = (async () => {
    while (probing) {
      await probe();
      await delay(5);
    }
  })();
  try {
    while (timings.length < 2) await delay(1);
    const probesBeforeOperation = timings.length;
    operationActive = true;
    await operation();
    operationComplete = true;
    await delay(20);
    const sorted = [...timings].sort((left, right) => left - right);
    return {
      probesBeforeOperation,
      observedDuringOperation,
      p95Ms: percentile(sorted, 0.95),
      maxMs: Math.max(0, ...timings),
      eventLoopMaxMs: Math.max(0, ...eventLoopLags)
    };
  } finally {
    probing = false;
    clearInterval(lagTimer);
    await probeLoop;
  }
}

function assertEquivalentDistribution(actual, expected, label) {
  assert.match(actual.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(expected.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const normalize = (value) => ({ ...value, generatedAt: "<generatedAt>" });
  assert.deepEqual(normalize(actual), normalize(expected), `${label} must remain deeply equivalent after generatedAt normalization`);
  assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label} must preserve top-level JSON field order`);
  assert.deepEqual(actual.bins.map((bin) => bin.label), expected.bins.map((bin) => bin.label), `${label} must preserve bin sorting`);
}

function assertGenericDistribution503(error) {
  assert.equal(error?.statusCode, 503);
  assert.equal(error?.retryable, true);
  assert.equal(error?.expose, true, "sanitized worker failures must be explicitly marked safe for the public route");
  assert.equal(error?.message, "短视频统计后台线程暂时不可用");
  assert(!/Users|\\|\/.*sqlite|\.sqlite/i.test(error.message), "public worker errors must not expose filesystem paths");
  return true;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function removeFixture(root) {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "fixture cleanup must stay inside the temp directory");
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

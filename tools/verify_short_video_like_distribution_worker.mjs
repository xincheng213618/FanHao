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
import { normalizeShortVideoStatsFilter } from "../src/modules/short-videos/server/stats-query.js";

const PRODUCTION_VIDEO_COUNT = 100_000;
const failureWorkerUrl = new URL("./fixtures/short_video_like_distribution_worker_failure.mjs", import.meta.url);
const realDbPath = argumentValue("--real-db");

if (process.argv.includes("--reserved-route-only")) await verifyReservedRouteGuardOnly();
else if (process.argv.includes("--corrupt-route-only")) await verifyCorruptFailure();
else if (realDbPath) await runRealReadOnlyBenchmark(path.resolve(realDbPath));
else await runFixtureVerification();

async function runFixtureVerification() {
  const fixture = createProductionShapeFixture(PRODUCTION_VIDEO_COUNT);
  try {
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

      client.invalidateStats();
      const beforeConcurrent = client.diagnostics().likeDistributionDispatches;
      const concurrent = await Promise.all(Array.from({ length: 100 }, () => (
        client.queryLikeDistribution({ catalogStamp: "fixture-single-flight" })
      )));
      assert(concurrent.every((item) => JSON.stringify(item) === JSON.stringify(concurrent[0])), "100 concurrent distribution callers must share one result");
      assert.equal(client.diagnostics().likeDistributionDispatches, beforeConcurrent + 1, "100 concurrent distribution callers must dispatch exactly once");

      const beforeCatalogMutation = concurrent[0].bins.at(-1).videoCount;
      mutateCatalogFixture(fixture.dbPath);
      const changed = await client.queryLikeDistribution({ catalogStamp: "fixture-catalog-mutated" });
      assert.equal(changed.bins.at(-1).videoCount, beforeCatalogMutation + 1, "a changed catalog stamp must invalidate both client and worker distribution caches");
    } finally {
      await client.stop();
    }

    await verifyRuntimeRouteAndInvalidation(fixture);
    const health = await verifyArmedRouteHealth(fixture);
    await verifyRouteAbort(fixture);
    await verifyAbortIsolation(fixture);
    await verifyInFlightInvalidation();
    const failures = await verifyBoundedFailures(fixture);

    console.log(JSON.stringify({
      check: "short-video-like-distribution-worker",
      videos: PRODUCTION_VIDEO_COUNT,
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

async function verifyRuntimeRouteAndInvalidation(fixture) {
  const runtime = fixtureRuntime(fixture);
  try {
    const first = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(first.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 1, "the real runtime route must dispatch to the catalog worker");
    const hot = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.deepEqual(hot.data, first.data, "the real route must preserve the hot JSON contract including generatedAt");
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 1, "the real route hot cache must stay worker-free");

    touchManagerFixture(fixture.managerDbPath);
    const afterManagerChange = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterManagerChange.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 2, "download-manager mtime changes must invalidate the route cache without opening the main-thread store for a stamp");

    const action = await runtimeRequest(runtime, "PUT", "/api/short-videos/fixture-000001/actions/like", { active: false });
    assert.equal(action.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "a user-action mutation must clear the distribution cache");
    const afterAction = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterAction.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 3, "a user-action mutation must force a new worker aggregate");
    assert.equal(afterAction.data.insights.personal.authorEfficiency.likedVideos, first.data.insights.personal.authorEfficiency.likedVideos - 1);

    const watch = await runtimeRequest(runtime, "PUT", "/api/short-videos/fixture-000001/watch", {
      progressMs: 900,
      completed: true
    });
    assert.equal(watch.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "a watch mutation must clear the client distribution cache");
    const afterWatch = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterWatch.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 4, "a watch mutation must force a new worker aggregate");
    assert.equal(afterWatch.data.insights.personal.watch.watchedTotal, afterAction.data.insights.personal.watch.watchedTotal + 1);

    mutateCatalogFixture(fixture.dbPath, "fixture-000002");
    runtime.clearListCache();
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "catalog generation invalidation must clear the distribution cache");
    const afterCatalog = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterCatalog.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 5, "catalog generation invalidation must dispatch a new worker aggregate");

    const deleted = await runtimeRequest(runtime, "DELETE", "/api/short-videos/fixture-000004", { deleteFiles: false });
    assert.equal(deleted.status, 200);
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "the real delete mutation route must reset the distribution cache");
    const afterDelete = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterDelete.data.total, afterCatalog.data.total - 1, "delete mutation invalidation must expose the new catalog total");
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 6);

    const imported = await runtime.syncCatalog({ force: true });
    assert(imported && imported.catalogChanged === true && imported.imported >= 1, "the real download-manager import must report a catalog change");
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionCacheEntries, 0, "the download-manager import callback must reset the distribution cache");
    const afterImport = await runtimeRequest(runtime, "GET", "/api/short-videos/like-distribution");
    assert.equal(afterImport.data.total, afterDelete.data.total + 1, "import invalidation must expose the imported video");
    assert.equal(runtime.catalogWorkerDiagnostics().likeDistributionDispatches, 7);

    await verifyReservedSingletonRouting(runtime);
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
    client.invalidateStats();
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

function touchManagerFixture(managerDbPath) {
  const db = new DatabaseSync(managerDbPath);
  db.prepare("UPDATE fixture_marker SET value = value + 1").run();
  db.close();
  const next = new Date(Date.now() + 2000);
  fs.utimesSync(managerDbPath, next, next);
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

function fixtureRuntime(fixture, extraWorkerData = {}) {
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
    catalogWorkerOptions: { extraWorkerData }
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

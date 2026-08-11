import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createShortVideoCatalogWorkerClient } from "../src/modules/short-videos/server/catalog-worker-client.js";
import { createShortVideoListStatsService } from "../src/modules/short-videos/server/list-stats-service.js";
import { videoFilter } from "../src/modules/short-videos/server/query-contract.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { normalizeShortVideoStatsFilter } from "../src/modules/short-videos/server/stats-query.js";
import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";

const PRODUCTION_VIDEO_COUNT = 103_008;
const expectedStatsKeys = ["likes", "comments", "collects", "shares", "plays", "bytes", "durationMs"];
const realDbPath = argumentValue("--real-db");

if (realDbPath) {
  await runRealReadOnlyBenchmark(path.resolve(realDbPath));
} else {
  await runFixtureVerification();
}

async function runFixtureVerification() {
  const fixture = createProductionShapeFixture(PRODUCTION_VIDEO_COUNT);
  try {
    await verifyStatsZeroDoesNotStartWorker();
    await verifyRouteErrorMapping();
    await verifyRecommendedFailureMapping();
    await verifyEventLoopLagGate();
    const client = createShortVideoCatalogWorkerClient({ dbPath: fixture.dbPath });
    try {
      const cases = [
        ["default-liked", new URLSearchParams()],
        ["all", new URLSearchParams("source=all")],
        ["liked-video", new URLSearchParams("source=liked&media=video")],
        ["history", new URLSearchParams("source=history")],
        ["fts-query", new URLSearchParams("source=all&q=needle-fixture")],
        ["like-query", new URLSearchParams("source=all&q=针")],
        ["topic", new URLSearchParams("source=all&topic=fixture-topic")],
        ["author-name", new URLSearchParams("source=all&author=name:测试作者 7")],
        ["posts", new URLSearchParams("source=posts")],
        ["local", new URLSearchParams("source=local")],
        ["pending", new URLSearchParams("source=all&includePending=1")]
      ];
      const baselineDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        for (const [name, params] of cases) {
          const expected = legacyVideoStats(baselineDb, params);
          let actual;
          try {
            actual = await client.queryStats(normalizeShortVideoStatsFilter(params), {
              catalogStamp: `equivalence:${fixture.stamp}:${name}`
            });
          } catch (error) {
            error.message = `${name}: ${error.message}`;
            throw error;
          }
          assert.deepEqual(actual, expected, `${name} worker stats must match the legacy aggregate`);
          assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${name} JSON field order must remain stable`);
          assert.deepEqual(Object.keys(actual), expectedStatsKeys, `${name} stats field order must stay compatible`);
        }
      } finally {
        baselineDb.close();
      }
      const listStore = createShortVideoStore({
        dbPath: fixture.dbPath,
        coverDbPath: fixture.coverDbPath,
        roots: [],
        skipStartupMaintenance: true
      });
      const listService = createShortVideoListStatsService({ store: listStore, catalogWorker: client });
      try {
        for (const [name, params] of cases.filter(([caseName]) => ["default-liked", "history", "fts-query", "author-name"].includes(caseName))) {
          const legacyParams = new URLSearchParams(params);
          legacyParams.set("limit", "12");
          legacyParams.set("facets", "0");
          const legacy = listStore.listVideos({ searchParams: legacyParams });
          const actual = await listService.list({ searchParams: new URLSearchParams(legacyParams) });
          assert.deepEqual(actual, legacy, `${name} full list payload must remain deeply equivalent`);
          assert.equal(JSON.stringify(actual), JSON.stringify(legacy), `${name} full list JSON order must remain byte-compatible`);
        }
        const changedMetadata = listStore.updateActualVideoPlaybackMetadata("fixture-000001", {
          width: 3840,
          height: 2160,
          bitRate: 8000000,
          codec: "h264",
          frameRate: 30,
          probedAt: "2026-08-12T00:00:02.000Z"
        });
        assert.equal(changedMetadata?.changed, true, "new playback dimensions must report a quality-affecting mutation");
        const unchangedMetadata = listStore.updateActualVideoPlaybackMetadata("fixture-000001", {
          width: 3840,
          height: 2160,
          bitRate: 8000000,
          codec: "h264",
          frameRate: 30,
          probedAt: "2026-08-12T00:00:03.000Z"
        });
        assert.equal(unchangedMetadata?.changed, false, "a probe timestamp refresh alone must not invalidate quality stats");
      } finally {
        listStore.close();
      }

      client.invalidateStats();
      const filter = normalizeShortVideoStatsFilter(new URLSearchParams("source=all"));
      const coldStartedAt = performance.now();
      const cold = await client.queryStats(filter, { catalogStamp: "cache-stamp-a" });
      const coldMs = performance.now() - coldStartedAt;
      const dispatchAfterCold = client.diagnostics().statsDispatches;
      const hotStartedAt = performance.now();
      const hot = await client.queryStats(filter, { catalogStamp: "cache-stamp-a" });
      const hotMs = performance.now() - hotStartedAt;
      assert.deepEqual(hot, cold, "hot cache must preserve the cold result");
      assert.equal(client.diagnostics().statsDispatches, dispatchAfterCold, "hot cache must not dispatch a second worker query");
      assert(hotMs < Math.max(25, coldMs / 5), `hot cache should be materially faster (cold=${coldMs.toFixed(1)}ms hot=${hotMs.toFixed(1)}ms)`);

      mutateFixtureStats(fixture.dbPath);
      const invalidated = await client.queryStats(filter, { catalogStamp: "cache-stamp-b" });
      assert.equal(invalidated.likes, cold.likes + 1000, "a new catalog stamp must invalidate the cached aggregate");
      assert.equal(client.diagnostics().statsDispatches, dispatchAfterCold + 1, "stamp invalidation must execute once");

      client.invalidateStats();
      const beforeConcurrent = client.diagnostics().statsDispatches;
      const concurrent = await Promise.all(Array.from({ length: 100 }, () => (
        client.queryStats(filter, { catalogStamp: "single-flight-stamp" })
      )));
      assert(concurrent.every((value) => JSON.stringify(value) === JSON.stringify(concurrent[0])), "single-flight waiters must share one result");
      assert.equal(client.diagnostics().statsDispatches, beforeConcurrent + 1, "100 concurrent callers must dispatch one aggregate");
      await verifyInFlightInvalidation();

      const health = await measureConcurrentHealth(fixture.dbPath, fixture.coverDbPath);
      assert(health.observedDuringStats > 0, "health probes must overlap the cold stats aggregate");
      assert(health.p95Ms < 250, `cold stats must not block health p95 (observed ${health.p95Ms.toFixed(1)}ms)`);
      assert(health.eventLoopMaxMs < 250, `cold list+stats must not block the event loop (observed ${health.eventLoopMaxMs.toFixed(1)}ms)`);
      const recommendedHealth = await measureConcurrentRecommendedHealth(fixture.dbPath, fixture.coverDbPath);
      assert(recommendedHealth.observedDuringStats > 0, "health probes must overlap cold recommendation construction");
      assert(recommendedHealth.p95Ms < 250, `cold recommendations must stay in the catalog worker (health p95 ${recommendedHealth.p95Ms.toFixed(1)}ms)`);
      assert(recommendedHealth.eventLoopMaxMs < 250, `cold recommendations must not block the event loop (observed ${recommendedHealth.eventLoopMaxMs.toFixed(1)}ms)`);

      await verifyBusyRecovery();
      await verifyWorkerRestartAbortAndBoundedLru();
      await verifyCorruptDatabaseFailure();

      const diagnostics = client.diagnostics();
      assert(diagnostics.cacheEntries <= 32, "stats LRU must remain bounded");
      console.log(JSON.stringify({
        check: "short-video-stats-performance",
        videos: PRODUCTION_VIDEO_COUNT,
        coldMs: round(coldMs),
        hotMs: round(hotMs),
        healthP95Ms: round(health.p95Ms),
        healthMaxMs: round(health.maxMs),
        eventLoopMaxMs: round(health.eventLoopMaxMs),
        recommendedHealthP95Ms: round(recommendedHealth.p95Ms),
        recommendedEventLoopMaxMs: round(recommendedHealth.eventLoopMaxMs),
        singleFlightCallers: 100,
        statsDispatches: diagnostics.statsDispatches
      }));
    } finally {
      await client.stop();
      assert.equal(client.diagnostics().workerActive, false, "stats worker must stop with the runtime owner");
      assert.equal(client.diagnostics().pendingRequests, 0, "stats worker stop must settle pending requests");
    }
  } finally {
    removeFixture(fixture.root);
  }
}

function verifyStatsZeroDoesNotStartWorker() {
  let workerQueries = 0;
  const store = {
    catalogStamp: () => "fixture-stamp",
    listVideos: (input) => ({
      stats: input.searchParams.get("stats") === "0" ? null : { legacy: true },
      videos: []
    })
  };
  const service = createShortVideoListStatsService({
    store,
    catalogWorker: {
      query: async () => {
        workerQueries += 1;
        return { stats: null, worker: true, videos: [] };
      },
      queryStats: async () => {
        workerQueries += 1;
        return {};
      }
    }
  });
  return Promise.all([
    service.list({ searchParams: new URLSearchParams("stats=0") }),
    service.list({ searchParams: new URLSearchParams("source=recommended&stats=0") }),
    service.list({ searchParams: new URLSearchParams("source=recommended") })
  ]).then(([withoutStats, recommendedWithoutStats, recommended]) => {
    assert.equal(workerQueries, 2, "stats=0 must stay worker-free only for non-recommended lists; both recommendation shapes use the catalog worker");
    assert.equal(withoutStats.stats, null);
    assert.deepEqual(recommendedWithoutStats, { stats: null, worker: true, videos: [] });
    assert.deepEqual(recommended, { stats: null, worker: true, videos: [] });
  });
}

async function verifyRouteErrorMapping() {
  const sent = [];
  await routeShortVideoApi(
    { method: "GET" },
    {},
    new URL("http://fixture/api/short-videos"),
    {
      listVideos: async () => {
        const error = new Error("private database details must not escape");
        error.code = "SHORT_VIDEO_DATABASE_UNAVAILABLE";
        error.statusCode = 503;
        throw error;
      },
      notFound() {},
      readJsonBody: async () => ({}),
      requireLocalAdmin: () => true,
      sendJson: (_res, status, body) => sent.push({ status, body }),
      shortVideoStore: {}
    }
  );
  assert.deepEqual(sent, [{
    status: 503,
    body: { error: "短视频数据库正在恢复，请稍后重试" }
  }], "worker database failures must preserve the public 503 mapping without internal details");
}

async function verifyRecommendedFailureMapping() {
  const workerUrl = new URL("./fixtures/short_video_stats_worker_failure.mjs", import.meta.url);
  const attemptBuffer = new SharedArrayBuffer(4);
  const logged = [];
  const errorClient = createShortVideoCatalogWorkerClient({
    dbPath: "private-path-must-not-escape",
    workerUrl,
    extraWorkerData: { attemptBuffer, listMode: "error" }
  });
  const store = {
    catalogStamp: () => "recommended-failure",
    listVideos: () => ({ stats: null, videos: [] })
  };
  const service = createShortVideoListStatsService({
    store,
    catalogWorker: errorClient,
    logger: { warn: (...values) => logged.push(values.map(String).join(" ")) }
  });
  try {
    await assert.rejects(
      service.list(new URL("http://fixture/api/short-videos?source=recommended&stats=0")),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.retryable, true);
        assert.equal(error.message, "短视频推荐后台线程暂时不可用");
        assert(!error.message.includes("private-user"));
        return true;
      }
    );
    assert(logged.some((entry) => entry.includes("secret-catalog.sqlite")), "the private failure may remain in internal logs");
    const sent = [];
    await routeShortVideoApi(
      { method: "GET" },
      {},
      new URL("http://fixture/api/short-videos?source=recommended&stats=0"),
      {
        listVideos: (url) => service.list(url),
        notFound() {},
        readJsonBody: async () => ({}),
        requireLocalAdmin: () => true,
        sendJson: (_res, status, body) => sent.push({ status, body }),
        shortVideoStore: {}
      }
    );
    assert.deepEqual(sent, [{
      status: 503,
      body: { error: "短视频推荐后台线程暂时不可用" }
    }], "recommended worker errors must cross the public route as a path-free 503");
  } finally {
    await errorClient.stop();
  }

  const exitClient = createShortVideoCatalogWorkerClient({
    dbPath: "private-path-must-not-escape",
    workerUrl,
    extraWorkerData: { attemptBuffer: new SharedArrayBuffer(4), listMode: "exit" }
  });
  const exitService = createShortVideoListStatsService({
    store,
    catalogWorker: exitClient,
    logger: { warn() {} }
  });
  try {
    await assert.rejects(
      exitService.list(new URL("http://fixture/api/short-videos?source=recommended&stats=0")),
      (error) => error?.statusCode === 503
        && error?.retryable === true
        && error?.message === "短视频推荐后台线程暂时不可用"
    );
    assert.equal(exitClient.diagnostics().workerStarts, 1, "recommended worker exit must fail bounded without a restart loop");
  } finally {
    await exitClient.stop();
  }
}

function createProductionShapeFixture(videoCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-stats-"));
  const dbPath = path.join(root, "catalog.sqlite");
  const coverDbPath = path.join(root, "covers.sqlite");
  const store = createShortVideoStore({
    dbPath,
    coverDbPath,
    roots: [],
    skipStartupMaintenance: false
  });
  store.summary();
  store.close();

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; BEGIN IMMEDIATE;");
  const insertVideo = db.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, is_liked, author_following,
      author_sec_uid, author_name, title, description, tags_json, tags_text,
      published_at, liked_at, duration_ms, actual_pixels,
      digg_count, comment_count, collect_count, share_count, play_count,
      source_path, size_bytes, mtime_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWatch = db.prepare(`
    INSERT INTO short_video_watch_history (
      local_user_id, video_id, progress_ms, completed_count, last_watched_at
    ) VALUES ('local:self', ?, ?, ?, ?)
  `);
  const insertMembership = db.prepare(`
    INSERT INTO short_video_source_memberships (
      aweme_id, source_type, source_profile_id, first_seen_at, last_seen_at, updated_at
    ) VALUES (?, 'post', 'fixture-profile', '2026-01-01', '2026-01-01', '2026-01-01')
  `);
  try {
    for (let index = 0; index < videoCount; index += 1) {
      const id = `fixture-${String(index).padStart(6, "0")}`;
      const awemeId = String(900000000000000000n + BigInt(index));
      const needle = index % 997 === 0 ? "needle-fixture 针" : "fixture";
      const topic = index % 389 === 0 ? "fixture-topic" : "fixture";
      const published = `2026-${String(index % 12 + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}T00:00:00.000Z`;
      insertVideo.run(
        id,
        awemeId,
        index % 101 === 0 ? "pending" : "local_only",
        index % 5 === 0 ? "gallery" : "video",
        index % 2,
        index % 3 === 0 ? 1 : 0,
        `fixture-author-${index % 64}`,
        `测试作者 ${index % 64}`,
        `${needle} ${index}`,
        `生产形状统计夹具 ${index}`,
        JSON.stringify([topic]),
        topic,
        published,
        published,
        1000 + index % 300000,
        index % 7 === 0 ? 8294400 : 2073600,
        index % 10000,
        index % 1000,
        index % 500,
        index % 250,
        index % 100000,
        `X:\\fixture\\${id}.mp4`,
        1024 + index * 17,
        index,
        published
      );
      if (index % 13 === 0) insertWatch.run(id, index % 100000, index % 2, published);
      if (index % 17 === 0) insertMembership.run(awemeId);
    }
    const stamp = "2026-08-12T00:00:00.000Z";
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanned_at', ?)").run(stamp);
    db.exec("COMMIT;");
    return { root, dbPath, coverDbPath, stamp };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function mutateFixtureStats(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE short_videos SET digg_count = digg_count + 1000 WHERE id = 'fixture-000001'").run();
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanned_at', '2026-08-12T00:00:01.000Z')").run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function legacyVideoStats(database, params) {
  const filter = videoFilter(params);
  const where = filter.where ? `WHERE ${filter.where}` : "";
  const row = database.prepare(`
    SELECT
      COALESCE(SUM(digg_count), 0) AS likes,
      COALESCE(SUM(comment_count), 0) AS comments,
      COALESCE(SUM(collect_count), 0) AS collects,
      COALESCE(SUM(share_count), 0) AS shares,
      COALESCE(SUM(play_count), 0) AS plays,
      COALESCE(SUM(size_bytes), 0) AS bytes,
      COALESCE(SUM(duration_ms), 0) AS durationMs
    FROM short_video_catalog
    ${where}
  `).get(...filter.args);
  return {
    likes: Number(row?.likes || 0),
    comments: Number(row?.comments || 0),
    collects: Number(row?.collects || 0),
    shares: Number(row?.shares || 0),
    plays: Number(row?.plays || 0),
    bytes: Number(row?.bytes || 0),
    durationMs: Number(row?.durationMs || 0)
  };
}

async function measureConcurrentHealth(dbPath, coverDbPath) {
  const client = createShortVideoCatalogWorkerClient({ dbPath });
  const store = createShortVideoStore({ dbPath, coverDbPath, roots: [], skipStartupMaintenance: true });
  const service = createShortVideoListStatsService({ store, catalogWorker: client });
  return measureConcurrentWorkerHealth(
    () => service.list(new URL("http://fixture/api/short-videos?source=all&includePending=1&limit=12&facets=0")),
    async () => {
      await client.stop();
      store.close();
    }
  );
}

async function measureConcurrentStatsHealthReadOnly(dbPath, stamp) {
  const client = createShortVideoCatalogWorkerClient({ dbPath });
  return measureConcurrentWorkerHealth(
    () => client.queryStats(
      normalizeShortVideoStatsFilter(new URLSearchParams("source=all&includePending=1")),
      { catalogStamp: stamp }
    ),
    () => client.stop()
  );
}

async function measureConcurrentRecommendedHealth(dbPath, coverDbPath) {
  const client = createShortVideoCatalogWorkerClient({ dbPath });
  const store = createShortVideoStore({ dbPath, coverDbPath, roots: [], skipStartupMaintenance: true });
  const service = createShortVideoListStatsService({ store, catalogWorker: client });
  return measureConcurrentWorkerHealth(
    () => service.list(new URL("http://fixture/api/short-videos?source=recommended&stats=0&limit=12&facets=0")),
    async () => {
      await client.stop();
      store.close();
    }
  );
}

async function measureConcurrentWorkerHealth(operation, stop) {
  let statsComplete = false;
  let observedDuringStats = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      if (!statsComplete) observedDuringStats += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    try {
      const data = await operation();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    } finally {
      statsComplete = true;
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const eventLoopLags = [];
  const sampleIntervalMs = 5;
  let previousSampleAt = performance.now();
  const eventLoopTimer = setInterval(() => {
    const sampledAt = performance.now();
    eventLoopLags.push(Math.max(0, sampledAt - previousSampleAt - sampleIntervalMs));
    previousSampleAt = sampledAt;
  }, sampleIntervalMs);
  try {
    // Arm the lag probe before the request. A synchronous list page build would
    // otherwise delay both the first health fetch and its timer, producing a
    // deceptively healthy latency sample after the block has already ended.
    await delay(sampleIntervalMs * 3);
    const statsRequest = fetch(`${baseUrl}/stats`).then(async (response) => {
      assert.equal(response.status, 200);
      return response.json();
    });
    await delay(10);
    const timings = [];
    for (let index = 0; index < 30; index += 1) {
      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}/health`);
      await response.arrayBuffer();
      timings.push(performance.now() - startedAt);
      await delay(8);
    }
    await statsRequest;
    timings.sort((left, right) => left - right);
    return {
      observedDuringStats,
      p95Ms: percentile(timings, 0.95),
      maxMs: Math.max(...timings),
      eventLoopP95Ms: percentile([...eventLoopLags].sort((left, right) => left - right), 0.95),
      eventLoopMaxMs: Math.max(0, ...eventLoopLags)
    };
  } finally {
    clearInterval(eventLoopTimer);
    await new Promise((resolve) => server.close(resolve));
    await stop();
  }
}

async function verifyEventLoopLagGate() {
  const blocked = await measureConcurrentWorkerHealth(
    async () => {
      const blockedUntil = performance.now() + 320;
      while (performance.now() < blockedUntil) {
        // Intentional fixture-only main-thread block: the pre-armed lag probe
        // must detect this even though health requests start afterwards.
      }
      return { ok: true };
    },
    async () => {}
  );
  assert(
    blocked.eventLoopMaxMs >= 250,
    `the health gate must detect a synchronous main-thread block (observed ${blocked.eventLoopMaxMs.toFixed(1)}ms)`
  );
}

async function verifyBusyRecovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-busy-"));
  const dbPath = path.join(root, "busy.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE short_video_catalog (
      visibility TEXT, is_liked INTEGER, author_following INTEGER, last_watched_at TEXT,
      digg_count INTEGER, comment_count INTEGER, collect_count INTEGER, share_count INTEGER,
      play_count INTEGER, size_bytes INTEGER, duration_ms INTEGER
    );
    INSERT INTO short_video_catalog VALUES ('local_only', 1, 0, '', 1, 2, 3, 4, 5, 6, 7);
  `);
  db.close();
  const locker = new DatabaseSync(dbPath);
  locker.exec("BEGIN EXCLUSIVE;");
  const client = createShortVideoCatalogWorkerClient({ dbPath, statsRetryLimit: 1 });
  const release = setTimeout(() => locker.exec("ROLLBACK"), 600);
  try {
    const result = await client.queryStats(
      normalizeShortVideoStatsFilter(new URLSearchParams("source=all")),
      { catalogStamp: "busy-recovery" }
    );
    assert.equal(result.likes, 1, "a bounded SQLITE_BUSY retry must recover after the writer releases");
    assert(client.diagnostics().statsDispatches <= 2, "SQLITE_BUSY recovery must remain bounded");
  } finally {
    clearTimeout(release);
    try { locker.exec("ROLLBACK"); } catch {}
    locker.close();
    await client.stop();
    removeFixture(root);
  }
}

async function verifyInFlightInvalidation() {
  const attemptBuffer = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(attemptBuffer), 0, 1);
  const valueBuffer = new SharedArrayBuffer(4);
  const client = createShortVideoCatalogWorkerClient({
    dbPath: "ignored-by-fixture-worker",
    workerUrl: new URL("./fixtures/short_video_stats_worker_failure.mjs", import.meta.url),
    extraWorkerData: { attemptBuffer, valueBuffer, failFirst: false, delayMs: 120 }
  });
  let revision = 0;
  let pageCalls = 0;
  const store = {
    catalogStamp: () => `controlled-${revision}`,
    listVideos: () => {
      pageCalls += 1;
      return { revision, stats: null, videos: [] };
    }
  };
  const service = createShortVideoListStatsService({ store, catalogWorker: client });
  try {
    const pending = service.list(new URL("http://fixture/api/short-videos?source=all"));
    while (client.diagnostics().statsDispatches < 1) await delay(1);
    revision = 1;
    Atomics.store(new Int32Array(valueBuffer), 0, 1);
    client.invalidateStats();
    const result = await pending;
    assert.equal(pageCalls, 2, "stats invalidation must recompute the whole page once");
    assert.equal(result.revision, 1, "the retried page must use the post-mutation revision");
    assert.equal(result.stats.likes, 1, "the retried stats must use the post-mutation revision");
    assert.equal(client.diagnostics().statsDispatches, 2, "stale stats must trigger one bounded replacement aggregate");
    assert.equal(client.diagnostics().cacheEntries, 1, "the stale worker result must not re-enter the cache");
    const hot = await service.list(new URL("http://fixture/api/short-videos?source=all"));
    assert.equal(hot.revision, hot.stats.likes, "hot payload must remain revision-coherent");
    assert.equal(client.diagnostics().statsDispatches, 2, "the coherent retry result must seed the hot cache");
    client.invalidateStats();
    const repeatedlyInvalidated = service.list(new URL("http://fixture/api/short-videos?source=all"));
    while (client.diagnostics().statsDispatches < 3) await delay(1);
    revision = 2;
    Atomics.store(new Int32Array(valueBuffer), 0, 2);
    client.invalidateStats();
    while (client.diagnostics().statsDispatches < 4) await delay(1);
    revision = 3;
    Atomics.store(new Int32Array(valueBuffer), 0, 3);
    client.invalidateStats();
    await assert.rejects(repeatedlyInvalidated, (error) => (
      error?.code === "SHORT_VIDEO_STATS_STALE" && error?.statusCode === 503
    ));
    assert.equal(client.diagnostics().statsDispatches, 4, "repeated invalidation must stop after one whole-payload retry");
    assert.equal(client.diagnostics().cacheEntries, 0, "neither repeatedly stale worker result may enter the cache");
  } finally {
    await client.stop();
  }
}

async function verifyWorkerRestartAbortAndBoundedLru() {
  const attemptBuffer = new SharedArrayBuffer(4);
  const failureWorkerUrl = new URL("./fixtures/short_video_stats_worker_failure.mjs", import.meta.url);
  const client = createShortVideoCatalogWorkerClient({
    dbPath: "ignored-by-fixture-worker",
    statsCacheLimit: 4,
    statsRetryLimit: 1,
    workerUrl: failureWorkerUrl,
    extraWorkerData: { attemptBuffer, failFirst: true }
  });
  try {
    const result = await client.queryStats({}, { catalogStamp: "restart" });
    assert.equal(result.likes, 11, "a single worker crash must recover on the bounded restart");
    assert.equal(client.diagnostics().statsRetries, 1, "worker crash must retry exactly once");
    assert.equal(client.diagnostics().workerStarts, 2, "worker crash must create one replacement worker");
    for (let index = 0; index < 8; index += 1) {
      await client.queryStats({}, { catalogStamp: `lru-${index}` });
    }
    assert.equal(client.diagnostics().cacheEntries, 4, "stats cache must evict to its configured LRU bound");
  } finally {
    await client.stop();
  }
  await client.start();
  assert.equal(client.diagnostics().workerActive, false, "runtime restart must reopen the client without eagerly starting a worker");
  const restarted = await client.queryStats({}, { catalogStamp: "runtime-restart" });
  assert.equal(restarted.likes, 11, "a stopped stats client must serve again after runtime start");
  assert.equal(client.diagnostics().workerStarts, 3, "the restarted client must create exactly one lazy replacement worker");
  await client.stop();

  const abortAttempts = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(abortAttempts), 0, 1);
  const abortClient = createShortVideoCatalogWorkerClient({
    dbPath: "ignored-by-fixture-worker",
    workerUrl: failureWorkerUrl,
    extraWorkerData: { attemptBuffer: abortAttempts, failFirst: false, delayMs: 200 }
  });
  const controller = new AbortController();
  const pending = abortClient.queryStats({}, { catalogStamp: "abort", signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  await delay(240);
  assert.equal(abortClient.diagnostics().singleFlights, 0, "an aborted waiter must not leak a single-flight entry");
  await abortClient.stop();
  assert.equal(abortClient.diagnostics().pendingRequests, 0, "abort shutdown must settle worker requests");
}

async function verifyCorruptDatabaseFailure() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-corrupt-"));
  const dbPath = path.join(root, "private-catalog-name.sqlite");
  fs.writeFileSync(dbPath, Buffer.from("this is not sqlite"));
  const client = createShortVideoCatalogWorkerClient({ dbPath, statsRetryLimit: 1 });
  try {
    await assert.rejects(
      client.queryStats({}, { catalogStamp: "corrupt" }),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, "短视频数据库正在恢复，请稍后重试");
        assert(!error.message.includes(path.basename(dbPath)), "database errors must not expose the database path");
        return true;
      }
    );
    assert.equal(client.diagnostics().statsDispatches, 1, "corruption must fail closed without futile retries");
  } finally {
    await client.stop();
    assert.equal(client.diagnostics().pendingRequests, 0);
    removeFixture(root);
  }
}

async function runRealReadOnlyBenchmark(dbPath) {
  assert(fs.statSync(dbPath).isFile(), "--real-db must point to a SQLite file");
  const params = new URLSearchParams(argumentValue("--filter") || "source=all");
  const filter = normalizeShortVideoStatsFilter(params);
  const database = new DatabaseSync(dbPath, { readOnly: true });
  let expected;
  let legacyMs;
  let stamp;
  try {
    const startedAt = performance.now();
    expected = legacyVideoStats(database, params);
    legacyMs = performance.now() - startedAt;
    const values = database.prepare(`
      SELECT key, value FROM short_video_meta
      WHERE key IN ('scanned_at', 'download_manager_imported_at', 'download_manager_following_imported_at', 'deleted_at')
      ORDER BY key
    `).all();
    stamp = JSON.stringify(values);
  } finally {
    database.close();
  }
  const client = createShortVideoCatalogWorkerClient({ dbPath });
  try {
    const coldStartedAt = performance.now();
    const actual = await client.queryStats(filter, { catalogStamp: stamp });
    const workerColdMs = performance.now() - coldStartedAt;
    const hotStartedAt = performance.now();
    const hot = await client.queryStats(filter, { catalogStamp: stamp });
    const workerHotMs = performance.now() - hotStartedAt;
    assert.deepEqual(actual, expected, "real read-only worker result must match the legacy aggregate");
    assert.deepEqual(hot, expected, "real read-only hot cache must match the legacy aggregate");
    const health = await measureConcurrentStatsHealthReadOnly(dbPath, `real:${stamp}`);
    assert(health.observedDuringStats > 0, "real read-only health probes must overlap the worker aggregate");
    assert(health.p95Ms < 250, `real read-only worker health p95 must remain responsive (${health.p95Ms.toFixed(1)}ms)`);
    assert(health.eventLoopMaxMs < 250, `real read-only worker must not block the event loop (${health.eventLoopMaxMs.toFixed(1)}ms)`);
    console.log(JSON.stringify({
      check: "short-video-stats-real-readonly",
      filter: Object.fromEntries(params),
      legacyMs: round(legacyMs),
      workerColdMs: round(workerColdMs),
      workerHotMs: round(workerHotMs),
      healthP95Ms: round(health.p95Ms),
      healthMaxMs: round(health.maxMs),
      eventLoopMaxMs: round(health.eventLoopMaxMs),
      stats: actual,
      dispatches: client.diagnostics().statsDispatches
    }));
  } finally {
    await client.stop();
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
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
  fs.rmSync(resolved, { recursive: true, force: true });
}

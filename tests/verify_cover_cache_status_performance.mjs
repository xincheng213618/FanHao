import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createAdminMaintenanceTaskService } from "../src/modules/fanhao/server/admin/admin-maintenance-task-service.js";
import { routeAdminApi } from "../src/modules/system/server/admin/routes.js";
import { COVER_STATUS_STAT_CONCURRENCY, createWorkCoverMutationService } from "../src/modules/fanhao/server/works/work-cover-mutation-service.js";

const CACHED_COVER_COUNT = 32993;
const WORK_COUNT = 5000;
const CANDIDATE_COUNT = 4935;
const unhandledRejections = [];
const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
process.on("unhandledRejection", onUnhandledRejection);

try {
  const { works, cachedRows, safeStatForPath, statForPath } = createProductionShapeFixture();
  const syncStatus = legacyGenerationStatus({ cachedRows, getWorks: () => works, safeStat: safeStatForPath });
  const service = createStatusService({ cachedRows, getWorks: () => works, safeStat: safeStatForPath, stat: async (filePath) => statForPath(filePath) });

  for (const sampleLimit of [0, 8, 50]) {
    const expected = syncStatus(sampleLimit);
    const actual = await service.generationStatus(sampleLimit);
    assert.deepEqual(actual, expected, `async status must exactly preserve the legacy payload for limit=${sampleLimit}`);
  }
  assert.equal((await service.generationStatus(0)).candidates, CANDIDATE_COUNT, "fixture must retain the production candidate shape");

  let activeStats = 0;
  let peakStats = 0;
  let scanFinished = false;
  const delayedService = createStatusService({
    cachedRows,
    getWorks: () => works,
    safeStat: safeStatForPath,
    stat: async (filePath) => {
      activeStats += 1;
      peakStats = Math.max(peakStats, activeStats);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return statForPath(filePath);
      } finally {
        activeStats -= 1;
      }
    }
  });
  const startedAt = performance.now();
  const slowStatus = delayedService.generationStatus(0).then((value) => {
    scanFinished = true;
    return value;
  });
  const healthGate = await new Promise((resolve) => setImmediate(() => resolve({ elapsedMs: performance.now() - startedAt, scanFinished })));
  assert.equal(healthGate.scanFinished, false, "the event loop health gate must run while the async status scan is pending");
  assert.ok(healthGate.elapsedMs < 100, `the event loop health gate was delayed for ${healthGate.elapsedMs.toFixed(1)}ms`);
  await slowStatus;
  assert.ok(peakStats > 1, "status scan should probe more than one candidate concurrently");
  assert.ok(peakStats <= COVER_STATUS_STAT_CONCURRENCY, `status scan exceeded its stat concurrency cap: ${peakStats}`);

  await verifyMaintenanceLimits();
  await verifyAdminRoute();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandledRejections, [], "missing and permission errors must not create unhandled rejections");
  console.log(`cover-cache-status-performance: ok (cached=${CACHED_COVER_COUNT}, works=${WORK_COUNT}, candidates=${CANDIDATE_COUNT}, stat-concurrency=${peakStats}, health-gate=${healthGate.elapsedMs.toFixed(1)}ms)`);
} finally {
  process.off("unhandledRejection", onUnhandledRejection);
}

function createProductionShapeFixture() {
  const cachedRows = Array.from({ length: CACHED_COVER_COUNT }, (_, index) => ({ work_id: index < WORK_COUNT - CANDIDATE_COUNT ? `work-${index}` : `cached-${index}` }));
  const stateByPath = new Map();
  const works = Array.from({ length: WORK_COUNT }, (_, index) => {
    const workId = `work-${index}`;
    const kind = index % 4;
    const directPath = `ready:${workId}`;
    stateByPath.set(directPath, "ready");
    if (kind === 0) {
      return workFixture(workId, index, [{ path: directPath }]);
    }
    if (kind === 1) {
      const missingPath = `missing:${workId}`;
      stateByPath.set(missingPath, "missing");
      return workFixture(workId, index, [{ path: missingPath }]);
    }
    if (kind === 2) {
      const deniedPath = `denied:${workId}`;
      stateByPath.set(deniedPath, "denied");
      return workFixture(workId, index, [{ path: deniedPath }]);
    }
    const missingPath = `missing:${workId}`;
    stateByPath.set(missingPath, "missing");
    return workFixture(workId, index, [{ path: missingPath }, { path: directPath }]);
  });

  function statForPath(filePath) {
    const state = stateByPath.get(filePath);
    if (state === "ready") return { isFile: () => true };
    const error = new Error(state === "denied" ? "permission denied" : "not found");
    error.code = state === "denied" ? "EACCES" : "ENOENT";
    throw error;
  }

  function safeStatForPath(filePath) {
    try {
      return statForPath(filePath);
    } catch {
      return null;
    }
  }

  return { works, cachedRows, safeStatForPath, statForPath };
}

function workFixture(id, index, videos) {
  return {
    id,
    personId: `person-${index % 97}`,
    title: `Work ${index}`,
    directoryName: `Directory ${index}`,
    modifiedAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
    videos
  };
}

function createStatusService({ cachedRows, getWorks, safeStat, stat }) {
  return createWorkCoverMutationService({
    getCoreDb: () => ({ prepare: () => ({ all: () => cachedRows }) }),
    getWorks,
    safeStat,
    stat,
    workInfoService: { invalidate() {} }
  });
}

function legacyGenerationStatus({ cachedRows, getWorks, safeStat }) {
  return (sampleLimit) => {
    const cachedCoverIds = new Set(cachedRows.map((row) => row.work_id));
    const candidates = getWorks()
      .filter((work) => !work.missingLocal)
      .filter((work) => !work.coverId)
      .filter((work) => !cachedCoverIds.has(work.id))
      .filter((work) => (work.videos || []).length > 0)
      .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
    const sample = [];
    let ready = 0;
    let missingVideo = 0;
    for (const work of candidates) {
      const video = (work.videos || []).find((item) => safeStat(item.path));
      if (video) {
        ready += 1;
        if (sample.length < sampleLimit) {
          sample.push({
            workId: work.id,
            personId: work.personId || "",
            title: work.title || work.directoryName || "",
            videoCount: (work.videos || []).length,
            modifiedAt: work.modifiedAt || ""
          });
        }
      } else {
        missingVideo += 1;
      }
    }
    return { candidates: candidates.length, ready, missingVideo, sample };
  };
}

async function verifyMaintenanceLimits() {
  const requestedLimits = [];
  const service = createAdminMaintenanceTaskService({
    clampInteger(value, fallback, min, max) {
      if (value === null || value === undefined || String(value).trim() === "") return fallback;
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.max(min, Math.min(max, Math.floor(number)));
    },
    coverGenerationStatus: async (limit) => {
      requestedLimits.push(limit);
      return { limit };
    }
  });
  assert.deepEqual(await service.coverCacheStatusPayload("0"), { limit: 0 });
  assert.deepEqual(await service.coverCacheStatusPayload("8"), { limit: 8 });
  assert.deepEqual(await service.coverCacheStatusPayload("50"), { limit: 50 });
  assert.deepEqual(requestedLimits, [0, 8, 50], "maintenance service must preserve all supported sample limits");
}

async function verifyAdminRoute() {
  let statusCalls = 0;
  const responses = [];
  const deps = {
    adminMaintenanceTaskService: {
      async coverCacheStatusPayload(limit) {
        statusCalls += 1;
        return { limit, complete: true };
      }
    },
    requireLocalAdmin: () => true,
    sendJson: (_res, statusCode, payload) => responses.push({ statusCode, payload })
  };
  const handled = await routeAdminApi({ method: "GET" }, {}, new URL("http://localhost/api/admin/cover-cache-status?limit=0"), deps);
  assert.equal(handled, true);
  assert.equal(statusCalls, 1);
  assert.deepEqual(responses, [{ statusCode: 200, payload: { limit: "0", complete: true } }], "route must await its async payload before sending JSON");

  let blockedCalls = 0;
  await routeAdminApi({ method: "GET" }, {}, new URL("http://localhost/api/admin/cover-cache-status"), {
    adminMaintenanceTaskService: { async coverCacheStatusPayload() { blockedCalls += 1; } },
    requireLocalAdmin: () => false,
    sendJson: () => assert.fail("local-admin gate must return before the status scan")
  });
  assert.equal(blockedCalls, 0, "local-admin gate must remain ahead of the async scan");

  const errorResponses = [];
  const expectedError = new Error("status failed");
  expectedError.statusCode = 503;
  await routeAdminApi({ method: "GET" }, {}, new URL("http://localhost/api/admin/cover-cache-status"), {
    adminMaintenanceTaskService: { async coverCacheStatusPayload() { throw expectedError; } },
    requireLocalAdmin: () => true,
    sendJson: (_res, statusCode, payload) => errorResponses.push({ statusCode, payload })
  });
  assert.deepEqual(errorResponses, [{ statusCode: 503, payload: { error: "status failed" } }], "route must keep admin error mapping after awaiting the scan");
}

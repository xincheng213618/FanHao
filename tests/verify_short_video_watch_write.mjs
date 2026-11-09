import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { sendShortVideoPublicError, shortVideoPublicError } from "../src/modules/short-videos/server/public-errors.js";
import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { createShortVideosRuntime } from "../src/modules/short-videos/server/runtime.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createShortVideoWatchWriteService } from "../src/modules/short-videos/server/watch-write-service.js";
import { mergeShortVideoWatchPayload } from "../public/modules/short-videos/watch-write-payload.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-watch-write-"));
const fixtureWorkerUrl = new URL("./fixtures/short_video_watch_write_worker_fixture.mjs", import.meta.url);
const commitWorkerUrl = new URL("./fixtures/short_video_watch_write_commit_worker_fixture.mjs", import.meta.url);

try {
  verifyClientPendingMerge();
  for (const committed of [false, true]) await verifyLateReceiptDuringRetirement(committed);
  await verifyExitDuringGracefulClose();
  await verifyStopRetriesRetirementOfPendingWrite();
  await verifyLockReleaseRecovery();
  await verifySustainedLockContract();
  await verifyLatestSameVideoSemantics();
  await verifyDifferentVideoFairness();
  await verifyStopDrainAndRestart();
  await verifySameTickStartStopFence();
  await verifyCommitBeforeAckReceipt();
  await verifyQueueCongestionContract();
  await verifyWorkerTimeoutContract();
  await verifyTimeoutTerminateFailureReceiptConvergence();
  await verifyWorkerCrashRecovery();
  await verifyWorkerCrashFailure();
  await verifyWorkerStartFailure();
  await verifyRuntimeWorkerStartFailure();
  await verifyCloseFailuresRemainRetryable();
  await verifyTerminateFailureRemainsRetryable();
  console.log("short-video-watch-write: ok (SQLite busy/receipt convergence, timeout retirement fencing, lifecycle/stop recovery)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function verifyClientPendingMerge() {
  assert.deepEqual(
    mergeShortVideoWatchPayload(
      { progressMs: 60000, completed: true },
      { progressMs: 1200, completed: false }
    ),
    { progressMs: 1200, completed: true },
    "a later replay/seek keeps its latest accepted position without erasing an earlier pending completion"
  );
  assert.deepEqual(
    mergeShortVideoWatchPayload(
      { progressMs: 9000, completed: false },
      { progressMs: 100, completed: false }
    ),
    { progressMs: 100, completed: false },
    "pending progress must use the latest accepted value rather than MAX(progressMs)"
  );
}

async function verifyLateReceiptDuringRetirement(committed) {
  const workers = [];
  let releaseRetirement = false;
  const service = fixtureService({
    busyRetryBudgetMs: 500,
    workerResponseTimeoutMs: 25,
    transportRetryLimit: 0,
    workerFactory() {
      const worker = new EventEmitter();
      const index = workers.length;
      worker.messages = [];
      worker.terminateCalls = 0;
      const exit = Promise.withResolvers();
      worker.exited = exit.promise;
      worker.finishExit = (evidence = "both") => {
        if (evidence !== "promise" && !worker.exitEmitted) {
          worker.exitEmitted = true;
          worker.emit("exit", 1);
        }
        if (evidence !== "event") exit.resolve(1);
      };
      worker.postMessage = message => {
        worker.messages.push(message);
        if (index === 1) return; // Hold the receipt worker until the fixture confirms physical exit.
        if (message.type === "close") {
          queueMicrotask(() => worker.emit("message", { type: "closed", id: message.id, ok: true }));
        } else if (index > 1 && message.type === "record") {
          const data = { watch: { progressMs: message.options.progressMs } };
          queueMicrotask(() => worker.emit("message", { id: message.id, ok: true, data }));
        }
      };
      workers.push(worker);
      queueMicrotask(() => worker.emit("message", { type: "ready", ok: true }));
      return worker;
    },
    terminateWorker(worker) {
      worker.terminateCalls++;
      if (worker !== workers[1] || releaseRetirement) queueMicrotask(worker.finishExit);
      return worker.exited;
    }
  });
  let write, stopping, restarting;
  try {
    await service.start();
    write = service.record("video-a", { progressMs: 1200, completed: true });
    write.catch(() => {});
    await waitFor(() => workers[1]?.terminateCalls > 0, 1500, "receipt worker never entered retirement");
    const retiring = workers[1];
    assert.equal(retiring.terminateCalls, 1);
    assert.deepEqual(retiring.messages.map(message => message.type), ["receipt"]);
    const receipt = retiring.messages[0];
    assert.equal(receipt.acceptedAt, workers[0].messages[0].options.acceptedAt);
    const data = committed ? { ok: true, videoId: "video-a", watch: {
      progressMs: 1200, completedCount: 1, completed: true, lastWatchedAt: receipt.acceptedAt
    } } : null;
    retiring.emit("message", { id: receipt.id, ok: true, data });

    let stopSettled = false, restartSettled = false;
    stopping = service.stop().finally(() => { stopSettled = true; });
    stopping.catch(() => {});
    restarting = service.start().finally(() => { restartSettled = true; });
    restarting.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(retiring.messages.map(message => message.type), ["receipt"], "a late receipt must not make stop close a retiring worker");
    assert.equal(stopSettled, false, "stop remains pending until the retiring worker physically exits");
    assert.equal(restartSettled, false, "restart must await the old physical exit");
    assert.equal(workers.length, 2);

    retiring.emit("error", new Error("competing retirement while termination is pending"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(retiring.terminateCalls, 1, "competing retirement requests share the native terminate");
    retiring.finishExit(committed ? "event" : "promise");
    await waitFor(() => stopSettled && restartSettled, 1500, "physical exit evidence did not release stop and restart");
    if (committed) {
      assert.deepEqual(await write, data, "a matching committed receipt remains authoritative during retirement");
      assert.equal(service.diagnostics().receiptsRecovered, 1);
    } else await assert.rejects(write, { code: "SHORT_VIDEO_WATCH_WORKER_TIMEOUT" });
    await stopping;
    assert.equal(await restarting, true);
    assert.equal(workers.length, 3);
    assert.equal(retiring.terminateCalls, 1);
    assert.equal(service.diagnostics().stopFailures, 0);
    assert.equal((await service.record("video-a", { progressMs: 3400 })).watch.progressMs, 3400);
  } finally {
    releaseRetirement = true;
    workers[1]?.finishExit();
    await Promise.allSettled([write, stopping, restarting]);
    await service.stop().catch(() => {});
  }
}

async function verifyExitDuringGracefulClose() {
  const worker = new EventEmitter();
  let closeRequests = 0, terminations = 0;
  worker.postMessage = message => {
    assert.equal(message.type, "close");
    closeRequests++;
  };
  const service = fixtureService({
    workerFactory() {
      queueMicrotask(() => worker.emit("message", { type: "ready", ok: true }));
      return worker;
    },
    terminateWorker() { terminations++; return Promise.resolve(1); }
  });
  let stopping;
  try {
    await service.start();
    stopping = service.stop();
    stopping.catch(() => {});
    await waitFor(() => closeRequests === 1, 1500, "worker never received the graceful close");
    worker.emit("exit", 1);
    await stopping;
    assert.equal(terminations, 0, "a spontaneous exit already released the physical worker");
    assert.equal(service.diagnostics().stopFailures, 0);
  } finally {
    worker.emit("exit", 1);
    await stopping?.catch(() => {});
    await service.stop().catch(() => {});
  }
}

async function verifyStopRetriesRetirementOfPendingWrite() {
  const workers = [], terminating = [];
  const firstTermination = Promise.withResolvers(), nextTermination = Promise.withResolvers();
  const failedTermination = new Error("fixture could not terminate the write worker");
  const committed = { progressMs: 4800, completed: true, completedCount: 1 };
  const service = fixtureService({
    workerResponseTimeoutMs: 50,
    transportRetryLimit: 0,
    workerFactory() {
      const worker = new EventEmitter(), messages = [];
      const index = workers.length;
      workers.push({ worker, messages });
      worker.postMessage = message => {
        messages.push(message);
        if (index === 0) return;
        const { type, id } = message;
        const reply = type === "close" ? { type: "closed", id, ok: true } : {
          id, ok: true, data: { watch: type === "receipt"
            ? { ...committed, lastWatchedAt: message.acceptedAt }
            : { progressMs: message.options.progressMs } }
        };
        queueMicrotask(() => worker.emit("message", reply));
      };
      queueMicrotask(() => worker.emit("message", { type: "ready", ok: true }));
      return worker;
    },
    terminateWorker(worker) {
      terminating.push(worker);
      if (worker !== workers[0].worker) {
        queueMicrotask(() => worker.emit("exit", 1));
        return Promise.resolve(1);
      }
      return terminating.length === 1 ? firstTermination.promise : nextTermination.promise;
    }
  });
  let write, firstStop, retryStop;
  try {
    await service.start();
    let writeSettled = false, firstStopSettled = false, retryStopSettled = false;
    write = service.record("video-a", { progressMs: committed.progressMs, completed: true }).finally(() => { writeSettled = true; });
    write.catch(() => {});
    await waitFor(() => terminating.length === 1, 1500, "write timeout did not start native termination");
    const owner = workers[0];
    const { acceptedAt } = owner.messages[0].options;
    firstStop = service.stop().finally(() => { firstStopSettled = true; });
    firstStop.catch(() => {});
    assert.equal(firstStopSettled, false);
    firstTermination.reject(failedTermination);
    await waitFor(() => firstStopSettled, 1500, "stop must report a rejected termination while the write remains pending");
    await assert.rejects(firstStop, error => error?.code === "SHORT_VIDEO_WATCH_WORKER_STOP_FAILED" && error.cause === failedTermination);
    assert.equal(writeSettled, false);
    assert.equal(service.diagnostics().stopIncomplete, true);
    await assert.rejects(service.start(), { code: "SHORT_VIDEO_WATCH_WORKER_STOP_INCOMPLETE" });

    const stop = service.stop();
    assert.equal(service.stop(), stop, "a concurrent explicit stop shares the pending retry");
    retryStop = stop.finally(() => { retryStopSettled = true; });
    retryStop.catch(() => {});
    await waitFor(() => terminating.length >= 2, 1500, "explicit stop did not retry physical termination");
    assert.deepEqual(terminating, [owner.worker, owner.worker]);
    assert.equal(workers.length, 1);
    assert.deepEqual(owner.messages.map(message => message.type), ["record"]);
    assert.equal(retryStopSettled, false);
    assert.equal(writeSettled, false);

    owner.worker.emit("exit", 1);
    nextTermination.resolve(1);
    await waitFor(() => writeSettled && retryStopSettled, 1500, "confirmed exit did not allow receipt recovery and graceful stop");
    assert.deepEqual((await write).watch, { ...committed, lastWatchedAt: acceptedAt });
    await retryStop;
    assert.equal(workers.length, 2);
    assert.deepEqual(workers[1].messages.map(message => message.type), ["receipt", "close"]);
    assert.equal(workers[1].messages[0].acceptedAt, acceptedAt);
    assert.equal(service.diagnostics().receiptsRecovered, 1);
    assert.equal(service.diagnostics().stopFailures, 1);
    assert.equal(service.diagnostics().stopIncomplete, false);
    assert.equal(await service.start(), true);
    assert.equal(workers.length, 3);
    assert.equal((await service.record("video-a", { progressMs: 7200 })).watch.progressMs, 7200);
    await service.stop();
  } finally {
    workers[0]?.worker.emit("exit", 1);
    firstTermination.resolve(1); nextTermination.resolve(1);
    await Promise.allSettled([write, firstStop, retryStop]);
    await service.stop().catch(() => {});
  }
}

async function verifyLockReleaseRecovery() {
  const fixture = createDatabaseFixture("lock-release", ["video-a"]);
  const events = [];
  const service = realService(fixture.dbPath, {
    testHooks: { onBusyRetry: (event) => events.push(event) }
  });
  let locker;
  try {
    await service.start();
    locker = lockDatabase(fixture.dbPath);
    const startedAt = performance.now();
    let timerDelayMs = null;
    setTimeout(() => { timerDelayMs = performance.now() - startedAt; }, 20);
    const pending = service.record("video-a", { progressMs: 1250 });
    await waitFor(() => events.length > 0, 1000, "real SQLite lock did not produce a retryable busy attempt");
    assert.ok(timerDelayMs < 100, `SQLite contention must not block the HTTP event loop (${timerDelayMs}ms)`);
    unlockDatabase(locker);
    locker = null;
    const result = await pending;
    assert.equal(result.watch.progressMs, 1250);
    assert.deepEqual(readWatchRows(fixture.dbPath), [{ video_id: "video-a", progress_ms: 1250, completed_count: 0 }]);
  } finally {
    unlockDatabase(locker);
    await service.stop();
    fixture.close();
  }
}

async function verifySustainedLockContract() {
  const fixture = createDatabaseFixture("sustained-lock", ["video-a"]);
  const service = realService(fixture.dbPath, { busyRetryBudgetMs: 220, busyRetryDelaysMs: [20, 40, 80] });
  let locker;
  try {
    await service.start();
    locker = lockDatabase(fixture.dbPath);
    const startedAt = performance.now();
    const error = await service.record("video-a", { progressMs: 2222 }).then(
      () => null,
      (reason) => reason
    );
    const elapsedMs = performance.now() - startedAt;
    assert.equal(error?.code, "SHORT_VIDEO_DATABASE_BUSY");
    assert.equal(error?.statusCode, 503);
    assert.equal(error?.retryable, true);
    assert.ok(elapsedMs >= 180 && elapsedMs < 1000, `busy budget must be explicit and bounded (${elapsedMs.toFixed(1)}ms)`);
    assert.deepEqual(shortVideoPublicError(error, "观看进度保存失败"), {
      status: 503,
      message: "短视频数据库正忙，请稍后重试",
      log: false
    });
    let publicResponse = null;
    sendShortVideoPublicError({}, (_res, status, body) => { publicResponse = { status, body }; }, error, "观看进度保存失败", { includeRetryable: true });
    assert.deepEqual(publicResponse, {
      status: 503,
      body: { error: "短视频数据库正忙，请稍后重试", retryable: true }
    });
    unlockDatabase(locker);
    locker = null;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(readWatchRows(fixture.dbPath), [], "a rejected busy write must never commit after its HTTP failure");
  } finally {
    unlockDatabase(locker);
    await service.stop();
    fixture.close();
  }
}

async function verifyLatestSameVideoSemantics() {
  const fixture = createDatabaseFixture("same-video", ["video-a"]);
  const dispatches = [];
  const busy = [];
  const service = realService(fixture.dbPath, {
    busyRetryDelaysMs: [100],
    testHooks: {
      onBusyRetry: (event) => busy.push(event),
      onDispatch: (event) => dispatches.push(event)
    }
  });
  let locker;
  try {
    await service.start();
    locker = lockDatabase(fixture.dbPath);
    const first = service.record("video-a", { progressMs: 100, completed: true });
    await waitFor(() => busy.length > 0, 1000, "same-video fixture did not enter busy retry");
    const second = service.record("video-a", { progressMs: 200, completed: false });
    const third = service.record("video-a", { progressMs: 300, completed: false });
    unlockDatabase(locker);
    locker = null;
    const results = await Promise.all([first, second, third]);
    assert.deepEqual(results.map((item) => item.watch.progressMs), [300, 300, 300]);
    assert.deepEqual(results.map((item) => item.watch.completed), [true, true, true]);
    const finalDispatch = dispatches.at(-1);
    assert.equal(finalDispatch.options.progressMs, 300, "coalescing must keep the latest accepted position, not the maximum or first");
    assert.equal(finalDispatch.options.completed, true, "completion must remain sticky across coalesced updates");
    assert.equal(finalDispatch.batchSize, 3);
    assert.ok(service.diagnostics().coalesced >= 2);
    await service.stop();

    const persisted = readWatchDetail(fixture.dbPath, "video-a");
    assert.equal(persisted.progress_ms, 300);
    assert.equal(persisted.completed_count, 1);
    const direct = createShortVideoStore({
      dbPath: fixture.dbPath,
      roots: [],
      skipStartupMaintenance: true,
      trustWatchAcceptedAt: true
    });
    try {
      direct.recordWatch("video-a", {
        progressMs: 999,
        completed: false,
        acceptedAt: new Date(Date.parse(persisted.last_watched_at) - 1000).toISOString()
      });
      assert.equal(readWatchDetail(fixture.dbPath, "video-a").progress_ms, 300, "an older retry must not replace the latest position/history order");
      direct.recordWatch("video-a", {
        progressMs: 50,
        completed: false,
        acceptedAt: new Date(Date.parse(persisted.last_watched_at) + 1000).toISOString()
      });
      assert.equal(readWatchDetail(fixture.dbPath, "video-a").progress_ms, 50, "a newer position may legitimately rewind");
      const zeroAt = new Date(Date.parse(persisted.last_watched_at) + 2000).toISOString();
      direct.recordWatch("video-a", { progressMs: 0, completed: false, acceptedAt: zeroAt });
      const staleReceipt = direct.recordWatch("video-a", {
        progressMs: 999,
        completed: false,
        acceptedAt: new Date(Date.parse(persisted.last_watched_at) + 1000).toISOString()
      });
      assert.equal(staleReceipt.watch.progressMs, 0, "an older retry must return the committed zero, not its rejected requested position");
      assert.equal(staleReceipt.watch.lastWatchedAt, zeroAt, "the receipt position and timestamp must describe the same stored version");
    } finally {
      direct.close();
    }
    const rewound = readWatchDetail(fixture.dbPath, "video-a");
    assert.equal(rewound.progress_ms, 0, "the latest zero position must remain ordered ahead of an older nonzero retry");
    assert.equal(rewound.completed_count, 1, "completion remains idempotently sticky");
  } finally {
    unlockDatabase(locker);
    await service.stop();
    fixture.close();
  }
}

async function verifyDifferentVideoFairness() {
  const fixture = createDatabaseFixture("fairness", ["video-a", "video-b"]);
  const dispatches = [];
  let locker;
  const service = realService(fixture.dbPath, {
    busyRetryDelaysMs: [120],
    testHooks: {
      onDispatch: ({ videoId }) => dispatches.push(videoId),
      onBusyRetry: ({ videoId }) => {
        if (videoId !== "video-a" || !locker) return;
        unlockDatabase(locker);
        locker = null;
      }
    }
  });
  try {
    await service.start();
    locker = lockDatabase(fixture.dbPath);
    const firstA = service.record("video-a", { progressMs: 100 });
    const onlyB = service.record("video-b", { progressMs: 200 });
    await Promise.all([firstA, onlyB]);
    assert.deepEqual(dispatches.slice(0, 2), ["video-a", "video-b"], "a busy video retry must move behind a different ready video");
    assert.deepEqual(dispatches.slice(0, 3), ["video-a", "video-b", "video-a"], "the first video may retry only after the other ready video gets a turn");
    const rows = readWatchRows(fixture.dbPath);
    assert.deepEqual(rows, [
      { video_id: "video-a", progress_ms: 100, completed_count: 0 },
      { video_id: "video-b", progress_ms: 200, completed_count: 0 }
    ]);
    const watchedA = readWatchDetail(fixture.dbPath, "video-a");
    const watchedB = readWatchDetail(fixture.dbPath, "video-b");
    assert.ok(
      watchedA.last_watched_at < watchedB.last_watched_at,
      "history order must follow parent acceptance time even when video-b commits before video-a"
    );
  } finally {
    unlockDatabase(locker);
    await service.stop();
    fixture.close();
  }
}

async function verifyStopDrainAndRestart() {
  const fixture = createDatabaseFixture("stop-restart", ["video-a", "video-b"]);
  const busy = [];
  const service = realService(fixture.dbPath, { testHooks: { onBusyRetry: (event) => busy.push(event) } });
  let locker;
  try {
    await service.start();
    locker = lockDatabase(fixture.dbPath);
    const write = service.record("video-a", { progressMs: 444 });
    await waitFor(() => busy.length > 0, 1000, "stop fixture did not enter busy retry");
    let stopSettled = false;
    const stopping = service.stop().finally(() => { stopSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stopSettled, false, "stop must drain an accepted write instead of rejecting it first");
    await assert.rejects(service.record("video-b", { progressMs: 555 }), (error) => error?.code === "SHORT_VIDEO_WATCH_STOPPED");
    unlockDatabase(locker);
    locker = null;
    const result = await write;
    await stopping;
    assert.equal(result.watch.progressMs, 444);
    assert.equal(readWatchDetail(fixture.dbPath, "video-a").progress_ms, 444);
    await assert.rejects(
      service.record("video-b", { progressMs: 555 }),
      (error) => error?.code === "SHORT_VIDEO_WATCH_STOPPED",
      "a fully stopped service must stay closed until an explicit start"
    );

    await service.start();
    const restarted = await service.record("video-b", { progressMs: 666 });
    assert.equal(restarted.watch.progressMs, 666);
    await service.stop();
  } finally {
    unlockDatabase(locker);
    await service.stop();
    fixture.close();
  }
}

async function verifySameTickStartStopFence() {
  const service = fixtureService({ mode: "success" });
  await service.start();
  await service.stop();
  const workerStarts = service.diagnostics().workerStarts;
  const starting = service.start();
  const stopping = service.stop();
  const [startResult] = await Promise.all([starting, stopping]);
  assert.equal(startResult, false, "same-tick stop must invalidate the pending start continuation");
  assert.equal(service.diagnostics().accepting, false);
  assert.equal(service.diagnostics().desiredStarted, false);
  assert.equal(service.diagnostics().workerStarts, workerStarts, "an invalidated same-tick start must not create another worker");
  await assert.rejects(service.record("video-a", { progressMs: 1 }), (error) => error?.code === "SHORT_VIDEO_WATCH_STOPPED");
}

async function verifyCommitBeforeAckReceipt() {
  const fixture = createDatabaseFixture("commit-before-ack", ["video-a"]);
  const recordLogPath = path.join(tempRoot, "commit-before-ack-records.log");
  const service = createShortVideoWatchWriteService({
    dbPath: fixture.dbPath,
    downloadManagerDbPath: "",
    ffmpegPath: "ffmpeg",
    roots: [],
    busyTimeoutMs: 20,
    workerResponseTimeoutMs: 1000,
    workerUrl: commitWorkerUrl,
    extraWorkerData: { mode: "commit-before-ack", recordLogPath }
  });
  let onWatchMutation = 0;
  let onWatch = 0;
  const response = {};
  try {
    await service.start();
    await routeShortVideoApi(
      { method: "PUT", body: { progressMs: 4321, completed: true } },
      response,
      new URL("http://127.0.0.1/api/short-videos/video-a/watch"),
      {
        readJsonBody: async (req) => req.body,
        recordWatch: (videoId, options) => service.record(videoId, options),
        onWatchMutation: () => { onWatchMutation += 1; },
        onWatch: () => { onWatch += 1; },
        sendJson(res, status, data) { res.status = status; res.data = data; },
        shortVideoStore: {}
      }
    );
    assert.equal(response.status, 200, "a committed write with a lost ack must converge through receipt read-back");
    assert.equal(response.data?.watch?.progressMs, 4321);
    assert.equal(response.data?.watch?.completed, true);
    assert.equal(onWatchMutation, 1, "receipt recovery must run the normal route mutation hook exactly once");
    assert.equal(onWatch, 1, "receipt recovery must run the normal route watch hook exactly once");
    assert.equal(service.diagnostics().receiptsRecovered, 1);
    assert.equal(fs.readFileSync(recordLogPath, "utf8").trim().split(/\r?\n/).length, 1, "receipt recovery must not issue a second write");
    const saved = readWatchDetail(fixture.dbPath, "video-a");
    assert.equal(saved.progress_ms, 4321);
    assert.equal(saved.completed_count, 1);
    assert.equal(saved.last_watched_at, response.data.watch.lastWatchedAt, "receipt identity must be the fixed parent acceptedAt");
  } finally {
    await service.stop();
    fixture.close();
  }
}

async function verifyQueueCongestionContract() {
  const dispatches = [];
  const service = fixtureService({
    mode: "hang",
    busyRetryBudgetMs: 80,
    busyTimeoutMs: 20,
    workerResponseTimeoutMs: 500,
    transportRetryLimit: 0,
    testHooks: { onDispatch: ({ videoId }) => dispatches.push(videoId) }
  });
  try {
    await service.start();
    const first = service.record("video-a", { progressMs: 1 });
    const queued = service.record("video-b", { progressMs: 2 });
    const firstCheck = assert.rejects(first, (error) => error?.code === "SHORT_VIDEO_WATCH_WORKER_TIMEOUT");
    const queuedCheck = assert.rejects(queued, (error) => error?.code === "SHORT_VIDEO_WATCH_QUEUE_TIMEOUT" && error?.statusCode === 503);
    await Promise.all([firstCheck, queuedCheck]);
    assert.deepEqual(dispatches, ["video-a"], "an expired queued update must never be sent as a late worker message");
  } finally {
    await service.stop();
  }
}

async function verifyWorkerTimeoutContract() {
  const service = fixtureService({
    mode: "hang",
    workerResponseTimeoutMs: 60,
    transportRetryLimit: 0
  });
  try {
    await service.start();
    const startedAt = performance.now();
    await assert.rejects(
      service.record("video-a", { progressMs: 1 }),
      (error) => error?.code === "SHORT_VIDEO_WATCH_WORKER_TIMEOUT" && error?.statusCode === 503
    );
    assert.ok(performance.now() - startedAt < 500, "worker watchdog failure must be distinct and bounded");
  } finally {
    await service.stop();
  }
}

async function verifyTimeoutTerminateFailureReceiptConvergence() {
  const fixture = createDatabaseFixture("timeout-terminate-failure", ["video-a"]);
  const recordLogPath = path.join(tempRoot, "timeout-terminate-failure-records.log");
  let terminateFailures = 0;
  const service = createShortVideoWatchWriteService({
    dbPath: fixture.dbPath,
    downloadManagerDbPath: "",
    ffmpegPath: "ffmpeg",
    roots: [],
    busyRetryBudgetMs: 500,
    workerResponseTimeoutMs: 100,
    transportRetryLimit: 0,
    workerUrl: commitWorkerUrl,
    extraWorkerData: { mode: "delayed-commit-exit", delayMs: 300, recordLogPath },
    terminateWorker(activeWorker) {
      if (terminateFailures === 0) {
        terminateFailures += 1;
        return Promise.reject(new Error("fixture active worker cannot be terminated"));
      }
      return activeWorker.terminate();
    }
  });
  const response = {};
  let onWatchMutation = 0;
  let onWatch = 0;
  try {
    await service.start();
    await routeShortVideoApi(
      { method: "PUT", body: { progressMs: 2468, completed: true } },
      response,
      new URL("http://127.0.0.1/api/short-videos/video-a/watch"),
      {
        readJsonBody: async (req) => req.body,
        recordWatch: (videoId, options) => service.record(videoId, options),
        onWatchMutation: () => { onWatchMutation += 1; },
        onWatch: () => { onWatch += 1; },
        sendJson(res, status, data) { res.status = status; res.data = data; },
        shortVideoStore: {}
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    const saved = readWatchDetail(fixture.dbPath, "video-a");
    assert.equal(saved.progress_ms, 2468, "the fixture must prove that the unkillable worker committed after its timeout");
    assert.equal(response.status, 200, "a timeout must not fail while an unkillable worker can still commit later");
    assert.equal(response.data?.watch?.progressMs, 2468);
    assert.equal(onWatchMutation, 1);
    assert.equal(onWatch, 1);
    assert.equal(terminateFailures, 1, "the timeout path must exercise a rejected termination");
    assert.equal(service.diagnostics().retirementTerminationFailures, 1);
    assert.equal(service.diagnostics().receiptsRecovered, 1, "confirmed worker exit must allow receipt convergence");
    assert.equal(fs.readFileSync(recordLogPath, "utf8").trim().split(/\r?\n/).length, 1);
  } finally {
    await service.stop().catch(() => {});
    fixture.close();
  }
}

async function verifyWorkerCrashRecovery() {
  const markerPath = path.join(tempRoot, "worker-crash-once.marker");
  const service = fixtureService({ mode: "crash-once", markerPath, workerResponseTimeoutMs: 500 });
  try {
    await service.start();
    const result = await service.record("video-a", { progressMs: 777, completed: true });
    assert.equal(result.watch.progressMs, 777);
    assert.equal(result.watch.completed, true);
    assert.equal(service.diagnostics().workerRestarts, 1, "an ambiguous crash must retry the same idempotent accepted update once");
  } finally {
    await service.stop();
  }
}

async function verifyWorkerCrashFailure() {
  const service = fixtureService({ mode: "crash-always", workerResponseTimeoutMs: 500 });
  try {
    await service.start();
    await assert.rejects(
      service.record("video-a", { progressMs: 888 }),
      (error) => error?.code === "SHORT_VIDEO_WATCH_WORKER_EXIT" && error?.statusCode === 503
    );
    assert.equal(service.diagnostics().workerRestarts, 1, "persistent worker exit retries must remain bounded");
  } finally {
    await service.stop();
  }
}

async function verifyWorkerStartFailure() {
  const service = fixtureService({ mode: "start-error" });
  try {
    await assert.rejects(
      service.start(),
      (error) => error?.code === "SHORT_VIDEO_WATCH_WORKER_UNAVAILABLE" && error?.statusCode === 503
    );
    assert.equal(service.diagnostics().accepting, true, "a failed start remains retryable until the owner explicitly stops it");
  } finally {
    await service.stop();
  }

  const worker = new EventEmitter();
  const physicalExit = Promise.withResolvers();
  let terminateCalls = 0, settled = false;
  const racing = fixtureService({
    workerFactory() {
      queueMicrotask(() => {
        worker.emit("message", { type: "ready", ok: true });
        worker.emit("error", new Error("fixture worker failed immediately after ready"));
      });
      return worker;
    },
    terminateWorker() { terminateCalls++; return physicalExit.promise; }
  });
  const start = assert.rejects(racing.start(), { code: "SHORT_VIDEO_WATCH_WORKER_UNAVAILABLE", statusCode: 503 })
    .finally(() => { settled = true; });
  start.catch(() => {});
  try {
    await waitFor(() => settled, 1500, "ready followed by error must reject start before physical exit");
    await start;
    assert.equal(terminateCalls, 1);
  } finally {
    worker.emit("exit", 1);
    physicalExit.resolve(1);
    await racing.stop();
  }
}

async function verifyRuntimeWorkerStartFailure() {
  const fixture = createDatabaseFixture("runtime-start-error", ["video-a"]);
  const runtimeStates = [];
  const runtime = createShortVideosRuntime({
    dbPath: fixture.dbPath,
    downloadManagerDbPath: "",
    downloadManagerSyncMs: 0,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    roots: [],
    mediaResponseService: { serveImage() {} },
    mediaStreamService: { serveVideo() {} },
    notFound() {},
    readJsonBody: async (req) => req?.body || {},
    requireLocalAdmin: () => true,
    sendJson(res, status, data) { res.status = status; res.data = data; },
    sharedCache: { rootDir: path.join(tempRoot, "runtime-start-error-cache"), scheduleCleanup() {}, touch() {} },
    watchWriterOptions: {
      workerUrl: fixtureWorkerUrl,
      extraWorkerData: { mode: "start-error" }
    },
    runtimeTestHooks: {
      onRuntimeStartedChange(value) { runtimeStates.push(Boolean(value)); }
    }
  });
  try {
    await assert.rejects(
      runtime.start(),
      (error) => error?.code === "SHORT_VIDEO_WATCH_WORKER_UNAVAILABLE"
    );
    assert.equal(runtimeStates.includes(true), false, "runtime must not become started after watch worker startup failure");
  } finally {
    await runtime.stop().catch(() => {});
    runtime.store.close();
    fixture.close();
  }
}

async function verifyCloseFailuresRemainRetryable() {
  for (const mode of ["close-false-once", "close-throw-once"]) {
    const service = fixtureService({ mode, workerCloseTimeoutMs: 250 });
    await service.start();
    const starts = service.diagnostics().workerStarts;
    await assert.rejects(
      service.stop(),
      (error) => error?.code === "SHORT_VIDEO_WATCH_WORKER_CLOSE_FAILED" && error?.statusCode === 503
    );
    assert.equal(service.diagnostics().accepting, false);
    assert.equal(service.diagnostics().stopIncomplete, true);
    assert.equal(service.diagnostics().workerStarts, starts, `${mode} must preserve the same worker handle for retry`);
    await assert.rejects(service.record("video-a", { progressMs: 1 }), (error) => error?.code === "SHORT_VIDEO_WATCH_STOPPED");
    await service.stop();
    assert.equal(service.diagnostics().stopFailures, 1);
    assert.equal(service.diagnostics().stopIncomplete, false);
  }
}

async function verifyTerminateFailureRemainsRetryable() {
  let failTerminate = true;
  let closeRequestsAfterAck = 0;
  const fixture = createDatabaseFixture("terminate-failure", ["video-a"]);
  const service = createShortVideoWatchWriteService({
    dbPath: fixture.dbPath,
    downloadManagerDbPath: "",
    ffmpegPath: "ffmpeg",
    roots: [],
    workerUrl: commitWorkerUrl,
    extraWorkerData: {
      mode: "success",
      recordLogPath: path.join(tempRoot, "terminate-failure-records.log")
    },
    terminateWorker(activeWorker) {
      if (failTerminate) {
        const postMessage = activeWorker.postMessage.bind(activeWorker);
        activeWorker.postMessage = (message, ...args) => {
          if (message.type === "close") closeRequestsAfterAck++;
          return postMessage(message, ...args);
        };
        return Promise.reject(new Error("fixture terminate failure"));
      }
      return activeWorker.terminate();
    }
  });
  try {
    await service.start();
    const starts = service.diagnostics().workerStarts;
    await assert.rejects(
      service.stop(),
      (error) => error?.code === "SHORT_VIDEO_WATCH_WORKER_STOP_FAILED" && error?.statusCode === 503
    );
    assert.equal(service.diagnostics().accepting, false);
    assert.equal(service.diagnostics().stopIncomplete, true);
    assert.equal(service.diagnostics().workerStarts, starts, "terminate failure must retain the original worker handle");
    await assert.rejects(
      service.start(),
      (error) => error?.code === "SHORT_VIDEO_WATCH_WORKER_STOP_INCOMPLETE" && error?.statusCode === 503
    );
    assert.equal(service.diagnostics().accepting, false, "start must not reopen a worker whose store already acknowledged close");
    assert.equal(service.diagnostics().workerStarts, starts);
    failTerminate = false;
    await service.stop();
    assert.equal(closeRequestsAfterAck, 0, "after close was acknowledged, stop retries physical termination alone");
    assert.equal(service.diagnostics().stopFailures, 1);
    assert.equal(service.diagnostics().stopIncomplete, false);
    await service.start();
    assert.equal(service.diagnostics().workerStarts, starts + 1, "start after a successful stop retry must create a fresh worker");
    const saved = await service.record("video-a", { progressMs: 1357 });
    assert.equal(saved.watch.progressMs, 1357);
  } finally {
    failTerminate = false;
    await service.stop().catch(() => {});
    fixture.close();
  }
}

function realService(dbPath, options = {}) {
  return createShortVideoWatchWriteService({
    dbPath,
    downloadManagerDbPath: "",
    ffmpegPath: "ffmpeg",
    roots: [],
    busyTimeoutMs: 20,
    busyRetryBudgetMs: 1500,
    busyRetryDelaysMs: [20, 40, 80, 160],
    workerResponseTimeoutMs: 1000,
    ...options
  });
}

function fixtureService(options = {}) {
  const { mode, markerPath, ...serviceOptions } = options;
  return createShortVideoWatchWriteService({
    dbPath: path.join(tempRoot, "unused.sqlite"),
    downloadManagerDbPath: "",
    ffmpegPath: "ffmpeg",
    roots: [],
    workerUrl: fixtureWorkerUrl,
    extraWorkerData: { mode, markerPath },
    busyRetryBudgetMs: 500,
    ...serviceOptions
  });
}

function createDatabaseFixture(name, videoIds) {
  const root = path.join(tempRoot, name);
  const dbPath = path.join(root, "short-videos.sqlite");
  fs.mkdirSync(root, { recursive: true });
  const bootstrap = createShortVideoStore({ dbPath, roots: [], skipStartupMaintenance: true });
  bootstrap.warm();
  bootstrap.close();
  const seed = new DatabaseSync(dbPath);
  const insert = seed.prepare(`
    INSERT INTO short_videos (id, duration_ms, source_path, imported_at, updated_at)
    VALUES (?, 60000, ?, '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')
  `);
  for (const videoId of videoIds) insert.run(videoId, path.join(root, `${videoId}.mp4`));
  seed.close();
  return { dbPath, close() {} };
}

function lockDatabase(dbPath) {
  const locker = new DatabaseSync(dbPath);
  locker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  return locker;
}

function unlockDatabase(locker) {
  if (!locker) return;
  try { locker.exec("ROLLBACK"); } catch {}
  try { locker.close(); } catch {}
}

function readWatchRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT video_id, progress_ms, completed_count
      FROM short_video_watch_history
      ORDER BY video_id
    `).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function readWatchDetail(dbPath, videoId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT video_id, progress_ms, completed_count, last_watched_at
      FROM short_video_watch_history
      WHERE local_user_id = 'local:self' AND video_id = ?
    `).get(videoId);
  } finally {
    db.close();
  }
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

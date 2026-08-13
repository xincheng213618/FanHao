import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { createShortVideoCoverDatabase } from "../src/modules/short-videos/server/cover-database.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const WORKER = new URL("./fixtures/short_video_delete_idempotency_worker.mjs", import.meta.url);
const RESULT_KEYS = [
  "ok", "id", "ids", "count", "scope", "groupDir", "title", "deletedFiles",
  "deletedStoredCovers", "coverCleanupError", "missingFiles", "skippedFiles", "emptyRemovedPaths"
];

await verifyExactReplayBoundaries();
await verifyWorkerReplay();
await verifyConcurrentCreatorsUseConsistentReplaySnapshot();
await verifyConflictMatrixAndCanonicalBatch();
await verifyGroupMembershipTransactionFence();
await verifyRestartAndResponseLossReplay();
await verifyHttpStatesAndSanitizedErrors();
await verifyReceiptRetentionAndIncompleteIntent();
await verifyLogicalReceiptFinalizationAfterCoverCleanup();
await verifyMalformedAndLegacyContracts();

console.log("short-video-delete-idempotency: ok (strict operation IDs, immutable command digests, exact replay, receipt retention, conflict fences)");

async function verifyExactReplayBoundaries() {
  for (const [hookName, suffix] of [
    ["afterPlanPersisted", "plan"],
    ["afterAllIsolated", "isolated"],
    ["afterDatabaseCommit", "committed"]
  ]) {
    let release;
    let reached;
    let hookCalls = 0;
    const paused = new Promise((resolve) => { reached = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const fixture = createFixture({
      hooks: {
        async [hookName]() {
          hookCalls += 1;
          reached();
          await gate;
        }
      }
    });
    try {
      const id = `exact-${suffix}`;
      const source = writeMedia(fixture, `${suffix}/video.mp4`, `exact-${suffix}`);
      seedVideo(fixture, { id, sourcePath: source });
      const operationId = operationIdFor(100 + hookCalls + ["plan", "isolated", "committed"].indexOf(suffix));
      const firstPromise = fixture.store.deleteVideo(id, { operationId });
      await paused;
      const before = jobSnapshot(fixture, operationId);
      const itemBefore = itemSnapshot(fixture, operationId);
      if (suffix !== "plan") {
        const moved = itemBefore.find((item) => item.disposition === "delete");
        assert(moved && fs.existsSync(moved.quarantine_path), `${suffix} fixture must replay after the media move`);
      }
      const replay = await fixture.store.deleteVideo(id, { operationId });
      const after = jobSnapshot(fixture, operationId);
      const itemAfter = itemSnapshot(fixture, operationId);
      assert.equal(replay.jobId, operationId);
      assert.equal(replay.replayed, true);
      assert.deepEqual(after, before, `${suffix} replay must not claim or mutate the durable job`);
      assert.deepEqual(itemAfter, itemBefore, `${suffix} replay must not enter a filesystem stage`);
      assert.equal(hookCalls, 1, `${suffix} replay must not invoke execution hooks`);
      release();
      const first = await firstPromise;
      assert.equal(first.status, "completed");
      assert.equal(videoExists(fixture, id), false);
      const terminalReplay = await fixture.store.deleteVideo(id, { operationId });
      assert.equal(terminalReplay.status, "completed");
      assert.equal(terminalReplay.replayed, true);
      assert.equal(fs.existsSync(source), false);
    } finally {
      release?.();
      closeFixture(fixture);
    }
  }
}

async function verifyWorkerReplay() {
  const fixture = createFixture();
  try {
    const id = "worker-replay";
    const source = writeMedia(fixture, "worker/video.mp4", "worker-replay");
    seedVideo(fixture, { id, sourcePath: source });
    fixture.store.close();
    fixture.store = null;
    const operationId = operationIdFor(201);
    const first = createWorker(fixture, id, operationId, true);
    await waitForWorkerMessage(first, "paused");
    const before = jobSnapshot(fixture, operationId);
    const second = createWorker(fixture, id, operationId, false);
    const replay = await waitForWorkerMessage(second, "finished");
    await waitForWorkerExit(second);
    assert.equal(replay.result.replayed, true);
    assert.equal(replay.result.jobId, operationId);
    assert.equal(replay.result.status, "running");
    assert.equal(replay.result.state, "running");
    assert.equal(replay.result.httpStatus, 202);
    assert.deepEqual(jobSnapshot(fixture, operationId), before, "worker replay must not steal the active execution");
    first.postMessage({ type: "resume" });
    const finished = await waitForWorkerMessage(first, "finished");
    await waitForWorkerExit(first);
    assert.equal(finished.result.status, "completed");
    fixture.store = openStore(fixture);
    const afterRestart = await fixture.store.deleteVideo(id, { operationId });
    assert.equal(afterRestart.replayed, true);
    assert.equal(afterRestart.status, "completed");
  } finally {
    closeFixture(fixture);
  }
}

async function verifyConcurrentCreatorsUseConsistentReplaySnapshot() {
  const fixture = createFixture();
  try {
    const id = "worker-snapshot-race";
    const source = writeMedia(fixture, "worker/snapshot-race.mp4", "worker-snapshot-race");
    seedVideo(fixture, { id, sourcePath: source });
    fixture.store.close();
    fixture.store = null;
    const operationId = operationIdFor(202);
    const first = createWorker(fixture, id, operationId, { pauseBeforePlan: true });
    const second = createWorker(fixture, id, operationId, { pauseBeforePlan: true });
    await Promise.all([
      waitForWorkerMessage(first, "before-plan"),
      waitForWorkerMessage(second, "before-plan")
    ]);
    const firstFinishedPromise = waitForWorkerMessage(first, "finished");
    const secondFinishedPromise = waitForWorkerMessage(second, "finished");
    first.postMessage({ type: "resume" });
    second.postMessage({ type: "resume" });
    const [firstFinished, secondFinished] = await Promise.all([
      firstFinishedPromise,
      secondFinishedPromise
    ]);
    await Promise.all([waitForWorkerExit(first), waitForWorkerExit(second)]);
    const results = [firstFinished, secondFinished];
    assert.equal(results.filter((entry) => entry.result.replayed === false).length, 1);
    assert.equal(results.filter((entry) => entry.result.replayed === true).length, 1);
    assert.equal(results.reduce((total, entry) => total + Number(entry.fsExecutorCalls || 0), 0), 1);
    for (const entry of results) {
      assert.equal(entry.result.jobId, operationId);
      assert.notEqual(entry.result.code, "SHORT_VIDEO_DELETE_OPERATION_CONFLICT");
      assert(["running", "cleanup_pending", "completed"].includes(entry.result.status));
    }
    assert.equal(jobCount(fixture), 1);
    assert.equal(operationCount(fixture), 1);
    assert.equal(fs.existsSync(source), false);
  } finally {
    closeFixture(fixture);
  }
}

async function verifyConflictMatrixAndCanonicalBatch() {
  let release;
  let reached;
  const paused = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = createFixture({ hooks: { async afterPlanPersisted() { reached(); await gate; } } });
  try {
    const anchor = writeMedia(fixture, "conflict/group/anchor.mp4", "anchor");
    const other = writeMedia(fixture, "conflict/other/other.mp4", "other");
    seedVideo(fixture, { id: "conflict-anchor", sourcePath: anchor });
    seedVideo(fixture, { id: "conflict-other", sourcePath: other });
    const operationId = operationIdFor(301);
    const firstPromise = fixture.store.deleteVideo("conflict-anchor", { operationId });
    await paused;
    const before = databaseAndFilesSnapshot(fixture, [anchor, other]);
    for (const invoke of [
      () => fixture.store.deleteVideo("conflict-other", { operationId }),
      () => fixture.store.deleteVideoGroup("conflict-anchor", { operationId }),
      () => fixture.store.deleteVideos(["conflict-anchor"], { operationId }),
      () => fixture.store.deleteVideo("conflict-anchor", { operationId, deleteFiles: false })
    ]) {
      await assert.rejects(invoke, (error) => error?.statusCode === 409 && error?.code === "SHORT_VIDEO_DELETE_OPERATION_CONFLICT");
      assert.deepEqual(databaseAndFilesSnapshot(fixture, [anchor, other]), before, "digest conflict must have zero DB/filesystem effects");
    }
    release();
    await firstPromise;
  } finally {
    release?.();
    closeFixture(fixture);
  }

  const batch = createFixture();
  try {
    const first = writeMedia(batch, "batch/a.mp4", "a");
    const second = writeMedia(batch, "batch/b.mp4", "b");
    seedVideo(batch, { id: "batch-a", sourcePath: first });
    seedVideo(batch, { id: "batch-b", sourcePath: second });
    const operationId = operationIdFor(302);
    const created = await batch.store.deleteVideos(["batch-b", "batch-a", "batch-a"], {
      deleteFiles: false,
      operationId
    });
    assert.equal(created.status, "completed");
    const replay = await batch.store.deleteVideos(["batch-a", "batch-b"], { deleteFiles: false, operationId });
    assert.equal(replay.replayed, true, "batch command digest must deduplicate and sort original IDs");
    await assert.rejects(
      () => batch.store.deleteVideos(["batch-a"], { deleteFiles: false, operationId }),
      (error) => error?.code === "SHORT_VIDEO_DELETE_OPERATION_CONFLICT"
    );
  } finally {
    closeFixture(batch);
  }
}

async function verifyGroupMembershipTransactionFence() {
  let inserted = false;
  const fixture = createFixture({
    hooks: {
      beforePlanTransaction({ scope }) {
        if (scope !== "group" || inserted) return;
        inserted = true;
        const late = writeMedia(fixture, "group-drift/set/late.mp4", "late");
        seedVideo(fixture, { id: "group-late", sourcePath: late });
      }
    }
  });
  try {
    const anchor = writeMedia(fixture, "group-drift/set/anchor.mp4", "anchor");
    seedVideo(fixture, { id: "group-anchor", sourcePath: anchor });
    const operationId = operationIdFor(401);
    await assert.rejects(
      () => fixture.store.deleteVideoGroup("group-anchor", { operationId }),
      (error) => error?.statusCode === 409 && error?.code === "SHORT_VIDEO_DELETE_GROUP_CHANGED"
    );
    assert.equal(inserted, true);
    assert.equal(videoExists(fixture, "group-anchor"), true);
    assert.equal(videoExists(fixture, "group-late"), true);
    assert.equal(fs.readFileSync(anchor, "utf8"), "anchor");
    assert.equal(jobCount(fixture), 0);
    assert.equal(operationCount(fixture), 0);
  } finally {
    closeFixture(fixture);
  }
}

async function verifyRestartAndResponseLossReplay() {
  const fixture = createFixture();
  try {
    const source = writeMedia(fixture, "response-loss/video.mp4", "response-loss");
    seedVideo(fixture, { id: "response-loss", sourcePath: source });
    const operationId = operationIdFor(501);
    await fixture.store.deleteVideo("response-loss", { operationId });
    assert.equal(videoExists(fixture, "response-loss"), false);
    assert.equal(fs.existsSync(source), false);
    fixture.store.close();
    fixture.store = openStore(fixture);
    const replay = await fixture.store.deleteVideo("response-loss", { operationId });
    assert.equal(replay.replayed, true);
    assert.equal(replay.jobId, operationId);
    assert.deepEqual(replay.ids, ["response-loss"]);
    const known = fixture.store.deleteJobStatus({ jobId: operationId });
    assert.equal(known.job.result.ids[0], "response-loss");
    const serialized = JSON.stringify(known);
    assert.equal(serialized.includes(fixture.root), false, "known-job result must expose relative paths only");
    assert.equal(serialized.includes("request_sha256"), false);
  } finally {
    closeFixture(fixture);
  }

  const group = createFixture();
  try {
    const anchor = writeMedia(group, "group-replay/set/anchor.mp4", "anchor");
    const sibling = writeMedia(group, "group-replay/set/sibling.mp4", "sibling");
    seedVideo(group, { id: "group-replay-anchor", sourcePath: anchor });
    seedVideo(group, { id: "group-replay-sibling", sourcePath: sibling });
    const operationId = operationIdFor(502);
    const created = await group.store.deleteVideoGroup("group-replay-anchor", { operationId });
    assert.deepEqual(new Set(created.ids), new Set(["group-replay-anchor", "group-replay-sibling"]));
    const late = writeMedia(group, "group-replay/set/late.mp4", "late");
    seedVideo(group, { id: "group-replay-late", sourcePath: late });
    const replay = await group.store.deleteVideoGroup("group-replay-anchor", { operationId });
    assert.equal(replay.replayed, true);
    assert.deepEqual(new Set(replay.ids), new Set(created.ids), "group replay must use the immutable first execution target");
    assert.equal(videoExists(group, "group-replay-late"), true, "group replay must not expand to a later member");
    assert.equal(fs.readFileSync(late, "utf8"), "late");
  } finally {
    closeFixture(group);
  }
}

async function verifyHttpStatesAndSanitizedErrors() {
  const states = [
    ["running", false, 202],
    ["cleanup_pending", false, 202],
    ["rollback_pending", false, 202],
    ["rollback_pending", true, 409],
    ["completed", false, 200],
    ["rolled_back", false, 409]
  ];
  for (const [status, manual, expected] of states) {
    const result = {
      ok: status === "completed" || status === "cleanup_pending",
      keyedOperation: true,
      httpStatus: expected,
      status,
      state: manual ? "manual" : status,
      manualInterventionRequired: manual
    };
    const response = await invokeRoute("/api/short-videos/state-fixture", {
      deleteVideo: async () => result
    }, { body: { operationId: operationIdFor(600 + expected + states.indexOf(states.find((item) => item[0] === status))) } });
    assert.equal(response.status, expected, `${status}/${manual} must map to ${expected}`);
  }

  const secretSelector = "raw-selector-secret";
  const secretPath = "D:\\private\\media.mp4";
  const owner = "short-video-delete-owner-secret";
  const lease = "2099-01-01T00:00:00.000Z";
  const hash = "a".repeat(64);
  const forbidden = [secretSelector, secretPath, owner, lease, hash, "SELECT * FROM"];
  const busy = Object.assign(new Error("短视频数据库正忙，请稍后重试"), {
    statusCode: 503,
    retryable: true,
    code: "SHORT_VIDEO_DELETE_BUSY",
    details: { secretSelector, secretPath, owner, lease, hash }
  });
  const internal = Object.assign(new Error(`${secretSelector} ${secretPath} SELECT * FROM`), {
    details: { owner, lease, hash }
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const error of [busy, internal]) {
      const response = await invokeRoute("/api/short-videos/error-fixture", {
        async deleteVideo() { throw error; }
      });
      const serialized = JSON.stringify(response.payload);
      for (const value of forbidden) assert.equal(serialized.includes(value), false);
    }
  } finally {
    console.error = originalError;
  }
}

async function verifyReceiptRetentionAndIncompleteIntent() {
  let currentMs = Date.parse("2026-08-01T00:00:00.000Z");
  const fixture = createFixture({ terminalLimit: 1, now: () => new Date(currentMs).toISOString() });
  try {
    const selectors = ["receipt-a", "receipt-b"];
    const operations = [operationIdFor(701), operationIdFor(702)];
    for (let index = 0; index < selectors.length; index += 1) {
      const source = writeMedia(fixture, `receipt/${selectors[index]}.mp4`, selectors[index]);
      seedVideo(fixture, { id: selectors[index], sourcePath: source });
      await fixture.store.deleteVideo(selectors[index], { deleteFiles: false, operationId: operations[index] });
      currentMs += 1_000;
    }
    const jobs = new Set(jobIds(fixture));
    const evictedIndex = jobs.has(operations[0]) ? 1 : 0;
    const evictedOperation = operations[evictedIndex];
    const evictedSelector = selectors[evictedIndex];
    assert.equal(jobs.has(evictedOperation), false, "the keyed terminal job limit must be allowed to prune the job row");
    assert.equal(operationIds(fixture).includes(evictedOperation), true, "the terminal receipt must outlive job pruning");
    const replay = await fixture.store.deleteVideo(evictedSelector, { deleteFiles: false, operationId: evictedOperation });
    assert.equal(replay.receiptOnly, true);
    assert.equal(replay.status, "completed");
    await assert.rejects(
      () => fixture.store.deleteVideoGroup(evictedSelector, { deleteFiles: false, operationId: evictedOperation }),
      (error) => error?.code === "SHORT_VIDEO_DELETE_OPERATION_CONFLICT"
    );

    currentMs += 6 * 24 * 60 * 60 * 1_000;
    fixture.store.close();
    fixture.store = openStore(fixture);
    const retained = await fixture.store.deleteVideo(evictedSelector, { deleteFiles: false, operationId: evictedOperation });
    assert.equal(retained.receiptOnly, true, "a keyed terminal receipt must survive for at least seven days");
    assert.equal(retained.resultExpired, false);

    const reboundPath = writeMedia(fixture, `receipt/reimported-${evictedSelector}.mp4`, "reimported");
    seedVideo(fixture, { id: evictedSelector, sourcePath: reboundPath });
    const beforeExpiry = operationRow(fixture, evictedOperation);
    currentMs += 2 * 24 * 60 * 60 * 1_000 + 1_000;
    fixture.store.close();
    fixture.store = openStore(fixture);
    const compacted = operationRow(fixture, evictedOperation);
    assert(compacted, "the operation tombstone must be permanent after receipt expiry");
    assert.equal(compacted.request_sha256, beforeExpiry.request_sha256);
    assert.equal(compacted.terminal_status, "completed");
    assert.equal(compacted.result_json, "", "only the full terminal result may be compacted after seven days");
    const permanent = openDb(fixture);
    try {
      assert.throws(
        () => permanent.prepare("DELETE FROM short_video_delete_operations WHERE operation_id = ?").run(evictedOperation),
        /operation tombstones are permanent/
      );
    } finally {
      permanent.close();
    }

    const jobCountBeforeReplay = jobCount(fixture);
    const expired = await fixture.store.deleteVideo(evictedSelector, { deleteFiles: false, operationId: evictedOperation });
    assert.equal(expired.replayed, true);
    assert.equal(expired.receiptOnly, true);
    assert.equal(expired.state, "expired");
    assert.equal(expired.terminalStatus, "completed");
    assert.equal(expired.resultExpired, true);
    assert.equal(expired.httpStatus, 409);
    assert.equal(expired.code, "SHORT_VIDEO_DELETE_OPERATION_EXPIRED");
    assert.equal(jobCount(fixture), jobCountBeforeReplay, "expired exact replay must never create another job");
    assert.equal(videoExists(fixture, evictedSelector), true, "expired exact replay must not delete a reimported row");
    assert.equal(fs.readFileSync(reboundPath, "utf8"), "reimported");
    const expiredHttp = await invokeRoute(`/api/short-videos/${evictedSelector}`, fixture.store, {
      body: { deleteFiles: false, operationId: evictedOperation }
    });
    assert.equal(expiredHttp.status, 409);
    assert.equal(expiredHttp.payload.state, "expired");
    const knownExpired = fixture.store.deleteJobStatus({ jobId: evictedOperation });
    assert.equal(knownExpired.job.state, "expired");
    assert.equal(knownExpired.job.resultExpired, true);
    await assert.rejects(
      () => fixture.store.deleteVideoGroup(evictedSelector, { deleteFiles: false, operationId: evictedOperation }),
      (error) => error?.statusCode === 409 && error?.code === "SHORT_VIDEO_DELETE_OPERATION_CONFLICT"
    );
    assert.equal(videoExists(fixture, evictedSelector), true);
    assert.equal(fs.readFileSync(reboundPath, "utf8"), "reimported");

    const corrupt = openDb(fixture);
    try {
      corrupt.exec("DROP TRIGGER trg_short_video_delete_operation_receipt_immutable_v2");
      corrupt.prepare("UPDATE short_video_delete_operations SET terminal_status = '', result_json = '', finished_at = '' WHERE operation_id = ?")
        .run(evictedOperation);
    } finally {
      corrupt.close();
    }
    await assert.rejects(
      () => fixture.store.deleteVideo(evictedSelector, { deleteFiles: false, operationId: evictedOperation }),
      (error) => error?.statusCode === 409 && error?.code === "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE"
    );
  } finally {
    closeFixture(fixture);
  }
}

async function verifyLogicalReceiptFinalizationAfterCoverCleanup() {
  await verifyLogicalReceiptFinalizationCase({
    suffix: "success",
    operationBase: 750,
    seedCover: true,
    expectedDeletedStoredCovers: 1,
    expectedCoverCleanupError: ""
  });
  await verifyLogicalReceiptFinalizationCase({
    suffix: "error",
    operationBase: 760,
    deleteStoredCovers() { throw new Error("fixture cover cleanup failed"); },
    expectedDeletedStoredCovers: 0,
    expectedCoverCleanupError: "fixture cover cleanup failed"
  });
}

async function verifyLogicalReceiptFinalizationCase({
  suffix,
  operationBase,
  seedCover = false,
  deleteStoredCovers,
  expectedDeletedStoredCovers,
  expectedCoverCleanupError
}) {
  let currentMs = Date.parse("2026-08-05T00:00:00.000Z");
  const fixture = createFixture({
    terminalLimit: 1,
    now: () => new Date(currentMs).toISOString(),
    deleteStoredCovers
  });
  try {
    const id = `logical-cover-${suffix}`;
    const operationId = operationIdFor(operationBase);
    const source = writeMedia(fixture, `logical/${suffix}.mp4`, suffix);
    seedVideo(fixture, { id, sourcePath: source });
    if (seedCover) {
      const coverDatabase = createShortVideoCoverDatabase({ dbPath: fixture.coverDbPath });
      try {
        coverDatabase.put(id, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      } finally {
        coverDatabase.close();
      }
    }
    const first = await fixture.store.deleteVideo(id, { deleteFiles: false, operationId });
    assert.equal(first.status, "completed");
    assert.equal(first.deletedStoredCovers, expectedDeletedStoredCovers);
    assert.equal(first.coverCleanupError, expectedCoverCleanupError);
    const beforePrune = persistedResultPair(fixture, operationId);
    assert.deepEqual(beforePrune.job, beforePrune.operation, "job and receipt must freeze the same cleanup result");
    assert.deepEqual(beforePrune.job, businessResult(first));

    currentMs += 1_000;
    const evictId = `logical-cover-${suffix}-evict`;
    const evictSource = writeMedia(fixture, `logical/${suffix}-evict.mp4`, `${suffix}-evict`);
    seedVideo(fixture, { id: evictId, sourcePath: evictSource });
    await fixture.store.deleteVideo(evictId, {
      deleteFiles: false,
      operationId: operationIdFor(operationBase + 1)
    });
    assert.equal(jobIds(fixture).includes(operationId), false, "the first logical job must be pruned");
    const replay = await fixture.store.deleteVideo(id, { deleteFiles: false, operationId });
    assert.equal(replay.receiptOnly, true);
    assert.deepEqual(businessResult(replay), businessResult(first), "receipt-only replay must preserve the full cleanup result");
    assert.equal(replay.deletedStoredCovers, expectedDeletedStoredCovers);
    assert.equal(replay.coverCleanupError, expectedCoverCleanupError);
  } finally {
    closeFixture(fixture);
  }
}

async function verifyMalformedAndLegacyContracts() {
  const fixture = createFixture();
  try {
    const source = writeMedia(fixture, "malformed/video.mp4", "malformed");
    seedVideo(fixture, { id: "malformed-video", sourcePath: source });
    const malformed = await invokeRoute("/api/short-videos/malformed-video", fixture.store, {
      body: { operationId: "sv-delete-op-NOT-A-UUID", deleteFiles: true }
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.payload.code, "SHORT_VIDEO_DELETE_OPERATION_ID_INVALID");
    assert.equal(videoExists(fixture, "malformed-video"), true);
    assert.equal(fs.readFileSync(source, "utf8"), "malformed");

    const collisionId = operationIdFor(801);
    const collisionDb = openDb(fixture);
    try {
      const timestamp = "2026-08-01T00:00:00.000Z";
      collisionDb.prepare(`
        INSERT INTO short_video_delete_jobs (
          id, status, phase, scope, anchor_id, video_ids_json, request_sha256,
          quarantine_token, created_at, updated_at, finished_at
        ) VALUES (?, 'completed', 'completed', 'single', 'legacy-collision', '[]', '', 'legacy', ?, ?, ?)
      `).run(collisionId, timestamp, timestamp, timestamp);
    } finally {
      collisionDb.close();
    }
    const collision = await invokeRoute("/api/short-videos/malformed-video", fixture.store, {
      body: { operationId: collisionId }
    });
    assert.equal(collision.status, 409);
    assert.equal(collision.payload.code, "SHORT_VIDEO_DELETE_OPERATION_CONFLICT");
    const collisionBody = JSON.stringify(collision.payload);
    for (const forbidden of [fixture.root, "owner_id", "lease_until", "request_sha256", "legacy-collision"]) {
      assert.equal(collisionBody.includes(forbidden), false);
    }
  } finally {
    closeFixture(fixture);
  }

  const legacyLogical = createFixture();
  try {
    const source = writeMedia(legacyLogical, "legacy/logical.mp4", "legacy-logical");
    seedVideo(legacyLogical, { id: "legacy-logical", sourcePath: source });
    const result = await legacyLogical.store.deleteVideo("legacy-logical", { deleteFiles: false });
    for (const key of RESULT_KEYS) assert(Object.hasOwn(result, key), `legacy logical result must retain ${key}`);
    assert.equal(Object.hasOwn(result, "jobId"), false);
    assert.equal(jobCount(legacyLogical), 0);
    assert.equal(operationCount(legacyLogical), 0);
    assert.equal(fs.readFileSync(source, "utf8"), "legacy-logical");
  } finally {
    closeFixture(legacyLogical);
  }

  const legacyFiles = createFixture({ terminalLimit: 1 });
  try {
    const source = writeMedia(legacyFiles, "legacy/files.mp4", "legacy-files");
    seedVideo(legacyFiles, { id: "legacy-files", sourcePath: source });
    const result = await legacyFiles.store.deleteVideo("legacy-files");
    for (const key of RESULT_KEYS) assert(Object.hasOwn(result, key), `legacy file result must retain ${key}`);
    assert.match(result.jobId, /^sv-delete-(?!op-)/u);
    assert.equal(result.keyedOperation, false);
    const secondSource = writeMedia(legacyFiles, "legacy/files-2.mp4", "legacy-files-2");
    seedVideo(legacyFiles, { id: "legacy-files-2", sourcePath: secondSource });
    await legacyFiles.store.deleteVideo("legacy-files-2");
    assert.equal(jobCount(legacyFiles), 1, "unkeyed terminal jobs must retain the original independent count limit");
    assert.equal(operationCount(legacyFiles), 0);
  } finally {
    closeFixture(legacyFiles);
  }
}

function createFixture({ hooks = {}, terminalLimit, now, deleteStoredCovers } = {}) {
  const temp = createVerifiedTempDir("fanhao-short-video-idempotency-");
  const fixture = {
    temp,
    root: path.join(temp.tempDir, "media"),
    dbPath: path.join(temp.tempDir, "short-videos.sqlite"),
    coverDbPath: path.join(temp.tempDir, "covers.sqlite"),
    hooks,
    terminalLimit,
    now,
    deleteStoredCovers,
    store: null
  };
  fs.mkdirSync(fixture.root);
  fixture.store = openStore(fixture);
  return fixture;
}

function openStore(fixture) {
  const store = createShortVideoStore({
    dbPath: fixture.dbPath,
    coverDbPath: fixture.coverDbPath,
    coverCacheDir: path.join(fixture.temp.tempDir, "legacy-covers"),
    roots: [fixture.root],
    skipStartupMaintenance: true,
    deleteJobTestHooks: fixture.hooks,
    deleteJobTerminalLimit: fixture.terminalLimit,
    deleteJobNow: fixture.now,
    deleteJobDeleteStoredCovers: fixture.deleteStoredCovers,
    deleteJobWarn() {}
  });
  store.summary();
  return store;
}

function closeFixture(fixture) {
  try { fixture.store?.close(); } finally { fixture.temp.cleanup(); }
}

function openDb(fixture) {
  const db = new DatabaseSync(fixture.dbPath);
  db.exec("PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON");
  return db;
}

function seedVideo(fixture, { id, sourcePath }) {
  const db = openDb(fixture);
  try {
    const timestamp = "2026-08-01T00:00:00.000Z";
    db.prepare(`
      INSERT INTO short_videos (id, source_path, title, file_name, imported_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sourcePath, id, path.basename(sourcePath), timestamp, timestamp);
  } finally {
    db.close();
  }
}

function writeMedia(fixture, relativePath, content) {
  const target = path.join(fixture.root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function operationIdFor(value) {
  return `sv-delete-op-00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function jobSnapshot(fixture, id) {
  const db = openDb(fixture);
  try {
    return db.prepare(`
      SELECT id, status, phase, owner_id, lease_until, execution_token, version, attempts,
             error_code, request_sha256, updated_at
      FROM short_video_delete_jobs WHERE id = ?
    `).get(id);
  } finally {
    db.close();
  }
}

function itemSnapshot(fixture, id) {
  const db = openDb(fixture);
  try {
    return db.prepare(`
      SELECT ordinal, original_path, quarantine_path, disposition, state, updated_at
      FROM short_video_delete_items WHERE job_id = ? ORDER BY ordinal
    `).all(id);
  } finally {
    db.close();
  }
}

function databaseAndFilesSnapshot(fixture, files) {
  const db = openDb(fixture);
  try {
    return {
      videos: db.prepare("SELECT id, source_path FROM short_videos ORDER BY id").all(),
      jobs: db.prepare("SELECT id, status, phase, request_sha256 FROM short_video_delete_jobs ORDER BY id").all(),
      operations: db.prepare("SELECT operation_id, request_sha256, terminal_status FROM short_video_delete_operations ORDER BY operation_id").all(),
      files: files.map((file) => ({ file, exists: fs.existsSync(file), content: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" }))
    };
  } finally {
    db.close();
  }
}

function videoExists(fixture, id) {
  const db = openDb(fixture);
  try { return Boolean(db.prepare("SELECT 1 FROM short_videos WHERE id = ?").get(id)); }
  finally { db.close(); }
}

function jobCount(fixture) {
  const db = openDb(fixture);
  try { return Number(db.prepare("SELECT COUNT(*) AS count FROM short_video_delete_jobs").get().count); }
  finally { db.close(); }
}

function operationCount(fixture) {
  const db = openDb(fixture);
  try { return Number(db.prepare("SELECT COUNT(*) AS count FROM short_video_delete_operations").get().count); }
  finally { db.close(); }
}

function jobIds(fixture) {
  const db = openDb(fixture);
  try { return db.prepare("SELECT id FROM short_video_delete_jobs ORDER BY id").all().map((row) => row.id); }
  finally { db.close(); }
}

function operationIds(fixture) {
  const db = openDb(fixture);
  try { return db.prepare("SELECT operation_id FROM short_video_delete_operations ORDER BY operation_id").all().map((row) => row.operation_id); }
  finally { db.close(); }
}

function operationRow(fixture, operationId) {
  const db = openDb(fixture);
  try { return db.prepare("SELECT * FROM short_video_delete_operations WHERE operation_id = ?").get(operationId) || null; }
  finally { db.close(); }
}

function persistedResultPair(fixture, operationId) {
  const db = openDb(fixture);
  try {
    const job = db.prepare("SELECT result_json FROM short_video_delete_jobs WHERE id = ?").get(operationId);
    const operation = db.prepare("SELECT result_json FROM short_video_delete_operations WHERE operation_id = ?").get(operationId);
    assert(job?.result_json, "terminal job result must be present");
    assert(operation?.result_json, "terminal operation result must be present");
    return {
      job: businessResult(JSON.parse(job.result_json)),
      operation: businessResult(JSON.parse(operation.result_json))
    };
  } finally {
    db.close();
  }
}

function businessResult(result) {
  return Object.fromEntries(RESULT_KEYS.map((key) => [key, result?.[key]]));
}

function createWorker(fixture, videoId, operationId, options = {}) {
  const workerOptions = typeof options === "boolean" ? { pauseAfterPlan: options } : options;
  return new Worker(WORKER, {
    workerData: {
      dbPath: fixture.dbPath,
      coverDbPath: fixture.coverDbPath,
      root: fixture.root,
      videoId,
      operationId,
      pauseAfterPlan: workerOptions.pauseAfterPlan === true,
      pauseBeforePlan: workerOptions.pauseBeforePlan === true,
      deleteFiles: workerOptions.deleteFiles !== false
    }
  });
}

function waitForWorkerMessage(worker, type, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`worker timed out waiting for ${type}`)), timeoutMs);
    const onMessage = (message) => {
      if (message?.type === "error") return finish(new Error(`${message.code}: ${message.message}`));
      if (message?.type === type) finish(null, message);
    };
    const onError = (error) => finish(error);
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      if (error) reject(error); else resolve(value);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

function waitForWorkerExit(worker, timeoutMs = 10_000) {
  if (worker.threadId === -1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker exit timeout")), timeoutMs);
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`worker exited ${code}`));
    });
    worker.once("error", reject);
  });
}

async function invokeRoute(pathname, shortVideoStore, { method = "DELETE", body = {} } = {}) {
  let response = null;
  const handled = await routeShortVideoApi(
    { method },
    {},
    new URL(`http://127.0.0.1${pathname}`),
    {
      notFound() { assert.fail(`route fell through: ${pathname}`); },
      onMutation() {},
      readJsonBody: async () => body,
      requireLocalAdmin: () => true,
      sendJson(_res, status, payload) { response = { status, payload }; },
      shortVideoStore
    }
  );
  assert.equal(handled, true);
  return response;
}

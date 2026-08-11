import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { fetchJson as androidFetchJson } from "../android-client/www/js/api.js";
import { retryShortVideoCollectionRequest as retryAndroidCollectionRequest } from "../android-client/www/modules/short-videos/collections/request.js";
import { createApiClient } from "../public/js/api.js";
import { retryShortVideoCollectionRequest as retryWebCollectionRequest } from "../public/modules/short-videos/collection-request.js";
import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import {
  captureVerifiedTempDirOwnership,
  createVerifiedTempDir,
  removeVerifiedTempDir
} from "./verified-temp-cleanup.mjs";

const SERVER_BUSY_BLOCK_BUDGET_MS = 200;
const CLIENT_BUSY_TOTAL_BUDGET_MS = 8000;
const CLIENT_BUSY_SUCCESS_BUDGET_MS = 8000;
const observed = {
  busySuccessMs: 0,
  clientRetryMs: 0,
  eventLoopDelayMs: 0,
  serverAttemptMs: 0,
  slowestProbeMs: 0,
  slowestWalReadMs: 0
};
verifyTempCleanupSafety();
const fixtureDirectory = createVerifiedTempDir("fanhao-short-video-collection-busy-");
const tempRoot = fixtureDirectory.tempDir;
const dbPath = path.join(tempRoot, "short-videos.sqlite");
let mutationEvents = 0;
let store = null;
let server = null;
let baseUrl = "";

try {
  store = createShortVideoStore({
    dbPath,
    coverDbPath: path.join(tempRoot, "short-video-covers.sqlite"),
    roots: [],
    skipStartupMaintenance: true
  });
  store.listCollections();
  seedVideo(dbPath, "busy-video-a", "99000001");
  server = await startFixtureServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await verifyApiErrorMetadata();
  await verifySelectiveRetryPolicy();
  const collection = await verifyShortLockWrites();
  await verifyWalReadsDuringWriter(collection);
  await verifyLongLockResponsiveness(collection);
  await verifyLongLockClientCeiling(collection);
  console.log(
    `short-video-collection-busy: ok (server=${observed.serverAttemptMs.toFixed(1)}ms, `
    + `6.5s-success=${observed.busySuccessMs.toFixed(1)}ms, long-ceiling=${observed.clientRetryMs.toFixed(1)}ms, `
    + `loop=${observed.eventLoopDelayMs.toFixed(1)}ms, `
    + `probe=${observed.slowestProbeMs.toFixed(1)}ms, WAL read=${observed.slowestWalReadMs.toFixed(1)}ms)`
  );
} finally {
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
  } finally {
    try {
      store?.close();
    } finally {
      fixtureDirectory.cleanup();
    }
  }
}

function verifyTempCleanupSafety() {
  verifyCreationFailureCleanup();
  verifyMovedAndReplacedCleanup();
  verifyJunctionCleanupRefusal();
  verifyOriginalSwapDuringRename();
  verifyOriginalReplacementAfterQuarantine();
  verifyQuarantinePayloadConflict();
  verifyRenameFailureSemantics();
  verifyDeleteFailureRetry();
  verifyQuarantineSiblingPreservation();
  verifyLegacyNoTokenCleanup();
  verifyMappedTempRootCleanup();
  verifyZeroIdentityRefusal();
}

function verifyCreationFailureCleanup() {
  let failedPath = "";
  assert.throws(
    () => createVerifiedTempDir("fanhao-short-video-cleanup-failure-", {
      afterCreate(tempDir) {
        failedPath = tempDir;
        fs.writeFileSync(path.join(tempDir, "partial-fixture.txt"), "cleanup-owned-only");
        throw new Error("fixture creation failure injection");
      }
    }),
    /fixture creation failure injection/
  );
  assert.ok(failedPath, "failure injection must create an owned directory");
  assert.equal(fs.existsSync(failedPath), false, "a failed fixture creation must remove only its owned directory");
}

function verifyMovedAndReplacedCleanup() {
  const moved = createVerifiedTempDir("fanhao-short-video-cleanup-moved-");
  const movedPath = `${moved.tempDir}-relocated`;
  fs.renameSync(moved.tempDir, movedPath);
  try {
    assert.equal(moved.cleanup(), false, "cleanup must not chase a moved directory");
    assert.equal(fs.existsSync(movedPath), true, "a moved directory must survive refused cleanup");
  } finally {
    fs.renameSync(movedPath, moved.tempDir);
    moved.cleanup();
  }

  const replaced = createVerifiedTempDir("fanhao-short-video-cleanup-replaced-");
  const replacedMovedPath = `${replaced.tempDir}-relocated`;
  fs.renameSync(replaced.tempDir, replacedMovedPath);
  fs.mkdirSync(replaced.tempDir);
  const replacementSentinel = path.join(replaced.tempDir, "replacement-sentinel.txt");
  fs.writeFileSync(replacementSentinel, "must survive refused cleanup");
  try {
    assert.throws(() => replaced.cleanup(), /different owner identity|moved or replaced/);
    assert.equal(fs.existsSync(replacementSentinel), true, "a same-name replacement must not be removed");
  } finally {
    removeVerifiedTempDir(replaced.tempDir, captureVerifiedTempDirOwnership(replaced.tempDir));
    fs.renameSync(replacedMovedPath, replaced.tempDir);
    replaced.cleanup();
  }
}

function verifyJunctionCleanupRefusal() {
  const linked = createVerifiedTempDir("fanhao-short-video-cleanup-junction-");
  const linkedMovedPath = `${linked.tempDir}-relocated`;
  const outside = createVerifiedTempDir("fanhao-short-video-cleanup-outside-");
  fs.renameSync(linked.tempDir, linkedMovedPath);
  const outsideSentinel = path.join(outside.tempDir, "outside-sentinel.txt");
  fs.writeFileSync(outsideSentinel, "must survive refused junction cleanup");
  fs.symlinkSync(outside.tempDir, linked.tempDir, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.throws(() => linked.cleanup(), /moved or replaced|outside the temporary directory|link, junction, reparse point/);
    assert.equal(fs.existsSync(outsideSentinel), true, "a replacement junction must never reach another fixture");
  } finally {
    const linkStat = fs.lstatSync(linked.tempDir, { throwIfNoEntry: false });
    if (linkStat?.isSymbolicLink()) fs.unlinkSync(linked.tempDir);
    fs.renameSync(linkedMovedPath, linked.tempDir);
    linked.cleanup();
    outside.cleanup();
  }
}

function verifyOriginalSwapDuringRename() {
  const fixture = createVerifiedTempDir("fanhao-short-video-cleanup-race-");
  const movedPath = `${fixture.tempDir}-owned-moved`;
  const ownedSentinel = path.join(fixture.tempDir, "owned-sentinel.txt");
  fs.writeFileSync(ownedSentinel, "original token must survive the injected swap");
  let payloadPath = "";
  let swapped = false;
  let error = null;
  try {
    error = expectFailure(() => fixture.cleanup({
      fsOps: {
        renameSync(source, target) {
          if (!swapped && samePath(source, fixture.tempDir)) {
            swapped = true;
            fs.renameSync(source, movedPath);
            fs.mkdirSync(source);
            fs.writeFileSync(path.join(source, "replacement-sentinel.txt"), "must not be deleted");
            payloadPath = target;
          }
          return fs.renameSync(source, target);
        },
        rmSync() {
          assert.fail("identity mismatch must fail before any recursive removal");
        }
      }
    }));
    assert.match(error.message, /different owner identity/);
    assert.equal(error.quarantinePath, payloadPath, "a post-precheck swap must expose its preserved quarantine path");
    assert.equal(fs.existsSync(path.join(payloadPath, "replacement-sentinel.txt")), true, "the raced replacement must be preserved in quarantine");
    assert.equal(fs.existsSync(path.join(movedPath, "owned-sentinel.txt")), true, "the true token directory must survive at its injected moved path");
    assert.equal(fs.existsSync(fixture.tempDir), false, "cleanup must never fall back to deleting the original pathname");
  } finally {
    const quarantinePath = error?.quarantinePath || payloadPath;
    cleanupPlainTempDirectory(quarantinePath ? path.dirname(quarantinePath) : "");
    cleanupPlainTempDirectory(fixture.tempDir);
    cleanupPlainTempDirectory(movedPath);
  }
}

function verifyOriginalReplacementAfterQuarantine() {
  const fixture = createVerifiedTempDir("fanhao-short-video-cleanup-recreated-");
  fs.writeFileSync(path.join(fixture.tempDir, "owned-sentinel.txt"), "owned");
  let replacementSentinel = "";
  try {
    assert.equal(fixture.cleanup({
      fsOps: {
        rmSync(target, options) {
          assert.equal(path.basename(target), "payload", "recursive removal must target only the quarantined payload");
          assert.equal(fs.existsSync(fixture.tempDir), false, "the original path must be free after quarantine rename");
          fs.mkdirSync(fixture.tempDir);
          replacementSentinel = path.join(fixture.tempDir, "replacement-sentinel.txt");
          fs.writeFileSync(replacementSentinel, "must survive payload deletion");
          return fs.rmSync(target, options);
        }
      }
    }), true);
    assert.equal(fs.existsSync(replacementSentinel), true, "an original-path replacement created at rm time must survive");
  } finally {
    cleanupPlainTempDirectory(fixture.tempDir);
  }
}

function verifyQuarantinePayloadConflict() {
  const fixture = createVerifiedTempDir("fanhao-short-video-cleanup-conflict-");
  const ownedSentinel = path.join(fixture.tempDir, "owned-sentinel.txt");
  fs.writeFileSync(ownedSentinel, "owned");
  let conflictPath = "";
  let error = null;
  try {
    error = expectFailure(() => fixture.cleanup({
      fsOps: {
        renameSync(source, target) {
          conflictPath = target;
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, "foreign-sentinel.txt"), "must survive rename failure");
          return fs.renameSync(source, target);
        },
        rmSync() {
          assert.fail("payload conflict must not fall back to recursive removal");
        }
      }
    }));
    assert.ok(["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code || "").toUpperCase()));
    assert.equal(error.quarantinePath, conflictPath);
    assert.equal(fs.existsSync(ownedSentinel), true, "payload collision must leave the original owner untouched");
    assert.equal(fs.existsSync(path.join(conflictPath, "foreign-sentinel.txt")), true, "payload collision must not delete the conflicting entry");
    assert.equal(fixture.cleanup(), true, "the owner must remain cleanable after the conflict is isolated");
  } finally {
    const quarantinePath = error?.quarantinePath || conflictPath;
    cleanupPlainTempDirectory(quarantinePath ? path.dirname(quarantinePath) : "");
    cleanupPlainTempDirectory(fixture.tempDir);
  }
}

function verifyRenameFailureSemantics() {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const fixture = createVerifiedTempDir(`fanhao-short-video-cleanup-${code.toLowerCase()}-`);
    const sentinel = path.join(fixture.tempDir, "owned-sentinel.txt");
    fs.writeFileSync(sentinel, "owned");
    try {
      const error = expectFailure(() => fixture.cleanup({
        fsOps: {
          renameSync() {
            throw Object.assign(new Error(`injected ${code}`), { code });
          },
          rmSync() {
            assert.fail(`${code} must not fall back to recursive removal`);
          }
        }
      }));
      assert.equal(error.code, code);
      assert.equal(fs.existsSync(sentinel), true, `${code} must leave the original owner untouched`);
      assert.equal(fs.existsSync(error.quarantinePath), false, `${code} must not fabricate a quarantined payload`);
      assert.equal(fixture.cleanup(), true, `${code} must remain retryable from the original path`);
    } finally {
      cleanupPlainTempDirectory(fixture.tempDir);
    }
  }

  const missing = createVerifiedTempDir("fanhao-short-video-cleanup-enoent-");
  const movedPath = `${missing.tempDir}-moved-during-rename`;
  let injected = false;
  try {
    assert.equal(missing.cleanup({
      fsOps: {
        renameSync(source) {
          if (!injected) {
            injected = true;
            fs.renameSync(source, movedPath);
          }
          throw Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
        },
        rmSync() {
          assert.fail("ENOENT must not fall back to recursive removal");
        }
      }
    }), false, "ENOENT after precheck must report a moved owner without deleting it");
    assert.equal(fs.existsSync(movedPath), true);
  } finally {
    if (fs.existsSync(movedPath) && !fs.existsSync(missing.tempDir)) fs.renameSync(movedPath, missing.tempDir);
    missing.cleanup();
  }
}

function verifyDeleteFailureRetry() {
  const fixture = createVerifiedTempDir("fanhao-short-video-cleanup-delete-failure-");
  fs.writeFileSync(path.join(fixture.tempDir, "owned-sentinel.txt"), "owned");
  let firstFailure = null;
  let replacementSentinel = "";
  try {
    firstFailure = expectFailure(() => fixture.cleanup({
      fsOps: {
        rmSync() {
          throw Object.assign(new Error("injected payload delete failure"), { code: "EBUSY" });
        }
      }
    }));
    assert.equal(firstFailure.code, "EBUSY");
    assert.equal(firstFailure.ownedDirectoryPreserved, true);
    assert.equal(fs.existsSync(path.join(firstFailure.quarantinePath, "owned-sentinel.txt")), true, "rm failure must preserve the owned payload in quarantine");
    assert.equal(fs.existsSync(fixture.tempDir), false);

    fs.mkdirSync(fixture.tempDir);
    replacementSentinel = path.join(fixture.tempDir, "replacement-sentinel.txt");
    fs.writeFileSync(replacementSentinel, "must survive cleanup retry");
    assert.equal(fixture.cleanup(), true, "a second cleanup call must retry the remembered owned payload");
    assert.equal(fs.existsSync(firstFailure.quarantinePath), false);
    assert.equal(fs.existsSync(replacementSentinel), true, "retry must never fall back to the recreated original path");
  } finally {
    cleanupPlainTempDirectory(fixture.tempDir);
    cleanupPlainTempDirectory(firstFailure?.quarantinePath ? path.dirname(firstFailure.quarantinePath) : "");
  }
}

function verifyQuarantineSiblingPreservation() {
  const fixture = createVerifiedTempDir("fanhao-short-video-cleanup-sibling-");
  let siblingPath = "";
  try {
    assert.equal(fixture.cleanup({
      fsOps: {
        rmSync(target, options) {
          siblingPath = path.join(path.dirname(target), "foreign-sibling.txt");
          fs.writeFileSync(siblingPath, "must survive non-recursive parent cleanup");
          return fs.rmSync(target, options);
        }
      }
    }), true);
    assert.equal(fs.existsSync(siblingPath), true, "quarantine parent cleanup must never recursively remove an injected sibling");
  } finally {
    cleanupPlainTempDirectory(siblingPath ? path.dirname(siblingPath) : "");
  }
}

function verifyLegacyNoTokenCleanup() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-cleanup-legacy-"));
  let recursiveTarget = "";
  try {
    assert.equal(removeVerifiedTempDir(tempDir, null, {
      fsOps: {
        rmSync(target, options) {
          recursiveTarget = target;
          return fs.rmSync(target, options);
        }
      }
    }), true);
    assert.notEqual(samePath(recursiveTarget, tempDir), true, "legacy no-token cleanup must never recursively remove the original path");
    assert.equal(path.basename(recursiveTarget), "payload");
    assert.equal(fs.existsSync(tempDir), false);
  } finally {
    cleanupPlainTempDirectory(tempDir);
  }
}

function verifyMappedTempRootCleanup() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-cleanup-root-map-"));
  fs.writeFileSync(path.join(tempDir, "owned-sentinel.txt"), "owned");
  const lexicalRoot = path.resolve(os.tmpdir());
  const fakeCanonicalRoot = path.join(path.parse(lexicalRoot).root, "fanhao-canonical-temp-root");
  const mappedRealpath = (value) => {
    const lexical = path.resolve(value);
    const relative = path.relative(lexicalRoot, lexical);
    assert.equal(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`), false);
    return relative ? path.join(fakeCanonicalRoot, relative) : fakeCanonicalRoot;
  };
  try {
    assert.equal(removeVerifiedTempDir(tempDir, null, {
      fsOps: { realpathSyncNative: mappedRealpath }
    }), true, "a lexical temp root that canonicalizes elsewhere must remain cleanable");
  } finally {
    cleanupPlainTempDirectory(tempDir);
  }
}

function verifyZeroIdentityRefusal() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-cleanup-zero-id-"));
  const sentinel = path.join(tempDir, "owned-sentinel.txt");
  fs.writeFileSync(sentinel, "must survive missing identity");
  try {
    assert.throws(() => removeVerifiedTempDir(tempDir, null, {
      fsOps: {
        lstatSync(target, options) {
          const entry = fs.lstatSync(target, options);
          if (!entry || !samePath(target, tempDir)) return entry;
          return new Proxy(entry, {
            get(object, property) {
              if (property === "dev" || property === "ino") return 0;
              const value = Reflect.get(object, property);
              return typeof value === "function" ? value.bind(object) : value;
            }
          });
        }
      }
    }), /stable dev\/ino/);
    assert.equal(fs.existsSync(sentinel), true, "zero dev/ino must fail closed without deleting the directory");
  } finally {
    cleanupPlainTempDirectory(tempDir);
  }
}

function expectFailure(work) {
  let failure = null;
  try {
    work();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "the injected cleanup phase must fail");
  return failure;
}

function cleanupPlainTempDirectory(targetPath) {
  if (!targetPath || !fs.lstatSync(targetPath, { throwIfNoEntry: false })) return false;
  return removeVerifiedTempDir(targetPath);
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function verifyApiErrorMetadata() {
  const originalFetch = globalThis.fetch;
  try {
    const webApi = createApiClient();
    for (const fixture of [
      { status: 503, payload: { error: "短视频数据库正忙，请稍后重试", retryable: true }, retryable: true },
      { status: 503, payload: { error: "短视频数据库正在恢复，请稍后重试" }, retryable: false },
      { status: 500, payload: { error: "permanent failure" }, retryable: false },
      { status: 409, payload: { error: "name conflict" }, retryable: false }
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(fixture.payload), {
        status: fixture.status,
        headers: { "content-type": "application/json" }
      });
      await assert.rejects(
        () => webApi("/api/short-videos/collections"),
        (error) => error.status === fixture.status && error.retryable === fixture.retryable
      );
      await assert.rejects(
        () => androidFetchJson("http://127.0.0.1", "/api/short-videos/collections", { timeoutMs: 0 }),
        (error) => error.status === fixture.status && error.retryable === fixture.retryable
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifySelectiveRetryPolicy() {
  for (const [client, retry] of [
    ["Web", retryWebCollectionRequest],
    ["Android", retryAndroidCollectionRequest]
  ]) {
    let calls = 0;
    let sideEffects = 0;
    const sleeps = [];
    const value = await retry(() => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("temporary busy"), { status: 503, retryable: true });
      sideEffects += 1;
      return `${client}-ok`;
    }, {
      delaysMs: [7, 11],
      sleep: async (delayMs) => { sleeps.push(delayMs); }
    });
    assert.equal(value, `${client}-ok`);
    assert.equal(calls, 3, `${client} must retry only the two transient BUSY responses`);
    assert.deepEqual(sleeps, [7, 11]);
    assert.equal(sideEffects, 1, `${client} retries must expose exactly one successful side effect`);

    for (const failure of [
      Object.assign(new Error("permanent 503"), { status: 503, retryable: false }),
      Object.assign(new Error("server failure"), { status: 500, retryable: true }),
      Object.assign(new Error("name conflict"), { status: 409, retryable: false })
    ]) {
      let failureCalls = 0;
      let failureSleeps = 0;
      await assert.rejects(
        () => retry(() => {
          failureCalls += 1;
          throw failure;
        }, {
          delaysMs: [1, 1],
          sleep: async () => { failureSleeps += 1; }
        }),
        (error) => error === failure
      );
      assert.equal(failureCalls, 1, `${client} must fail immediately for HTTP ${failure.status}`);
      assert.equal(failureSleeps, 0, `${client} must not delay a permanent HTTP ${failure.status}`);
    }
  }
}

async function verifyShortLockWrites() {
  const startEvents = mutationEvents;
  const createStartedAt = performance.now();
  const created = await withPythonWriteLock(dbPath, 6500, () => retryWebCollectionRequest(
    () => requestJson("/api/short-videos/collections", { method: "POST", body: { name: "短锁恢复" } })
  ));
  observed.busySuccessMs = performance.now() - createStartedAt;
  assert.equal(created.status, 201, "a single Web create action must survive the observed 6.5s Python writer lock");
  assert.ok(observed.busySuccessMs < CLIENT_BUSY_SUCCESS_BUDGET_MS, "one Web create action must recover within the strict 8s client budget");
  const collection = created.payload.collection;
  assert.equal(countRows(dbPath, "SELECT COUNT(*) AS count FROM short_video_collections WHERE normalized_name = ?", ["短锁恢复"]), 1, "retried create must commit exactly once");

  const added = await withPythonWriteLock(dbPath, 900, () => retryAndroidCollectionRequest(
    () => requestJson(`/api/short-videos/collections/${collection.id}/videos/busy-video-a`, { method: "PUT" })
  ));
  assert.equal(added.payload.added, true, "a single Android add action must survive a short Python writer lock");
  assert.equal(countMemberships(dbPath, collection.id, "busy-video-a"), 1, "retried add must keep one membership row");

  const removed = await withPythonWriteLock(dbPath, 900, () => retryWebCollectionRequest(
    () => requestJson(`/api/short-videos/collections/${collection.id}/videos/busy-video-a`, { method: "DELETE" })
  ));
  assert.equal(removed.payload.removed, true, "a single Web remove action must survive a short Python writer lock");
  assert.equal(countMemberships(dbPath, collection.id, "busy-video-a"), 0, "retried remove must not leave duplicate side effects");

  await requestJson(`/api/short-videos/collections/${collection.id}/videos/busy-video-a`, { method: "PUT" });
  const deleted = await withPythonWriteLock(dbPath, 900, () => retryAndroidCollectionRequest(
    () => requestJson(`/api/short-videos/collections/${collection.id}`, { method: "DELETE" })
  ));
  assert.equal(deleted.payload.ok, true, "a single Android delete action must survive a short Python writer lock");
  assert.equal(countRows(dbPath, "SELECT COUNT(*) AS count FROM short_video_collections WHERE id = ?", [collection.id]), 0, "retried collection delete must commit exactly once");
  assert.equal(countMemberships(dbPath, collection.id, "busy-video-a"), 0, "retried collection delete must preserve cascade atomicity");
  assert.equal(mutationEvents - startEvents, 5, "each successful logical mutation must publish exactly one invalidation event");

  const replacement = await requestJson("/api/short-videos/collections", { method: "POST", body: { name: "读锁夹具" } });
  await requestJson(`/api/short-videos/collections/${replacement.payload.collection.id}/videos/busy-video-a`, { method: "PUT" });
  return replacement.payload.collection;
}

async function verifyWalReadsDuringWriter(collection) {
  await withPythonWriteLock(dbPath, 2000, async () => {
    for (const pathname of [
      "/api/short-videos/collections",
      `/api/short-videos/collections/${collection.id}/videos?limit=1`,
      `/api/short-videos/collections/${collection.id}/videos/busy-video-a`
    ]) {
      const startedAt = performance.now();
      const response = await requestJson(pathname);
      observed.slowestWalReadMs = Math.max(observed.slowestWalReadMs, performance.now() - startedAt);
      assert.equal(response.status, 200, `WAL read must remain available during a Python writer: ${pathname}`);
      assert.ok(performance.now() - startedAt < 250, `ordinary WAL read exceeded 250ms during a writer: ${pathname}`);
    }
  });
}

async function verifyLongLockResponsiveness(collection) {
  await withPythonWriteLock(dbPath, 5000, async () => {
    const loopDelay = monitorEventLoopDelay({ resolution: 5 });
    loopDelay.enable();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const probes = runProbeWorker([
      `${baseUrl}/api/health`,
      `${baseUrl}/api/short-videos/collections/${collection.id}/videos?limit=1`
    ], 20);
    const startedAt = performance.now();
    const mutation = await requestJson(`/api/short-videos/collections/${collection.id}`, {
      method: "PATCH",
      body: { name: "长期锁不应成功" }
    }).catch((error) => error);
    const elapsed = performance.now() - startedAt;
    const probeResults = await probes;
    await new Promise((resolve) => setTimeout(resolve, 15));
    loopDelay.disable();
    const maximumLoopDelayMs = loopDelay.max / 1e6;
    observed.serverAttemptMs = elapsed;
    observed.eventLoopDelayMs = maximumLoopDelayMs;
    assert.equal(mutation.status, 503, "a long writer lock must remain a retryable 503");
    assert.equal(mutation.retryable, true);
    assert.ok(elapsed < SERVER_BUSY_BLOCK_BUDGET_MS, `one server attempt blocked ${elapsed.toFixed(1)}ms`);
    assert.ok(maximumLoopDelayMs < 120, `one BUSY attempt stalled the main event-loop tick ${maximumLoopDelayMs.toFixed(1)}ms`);
    for (const probe of probeResults) {
      observed.slowestProbeMs = Math.max(observed.slowestProbeMs, probe.elapsedMs);
      assert.equal(probe.status, 200, `concurrent probe failed: ${probe.url}`);
      assert.ok(probe.elapsedMs < SERVER_BUSY_BLOCK_BUDGET_MS, `concurrent probe was blocked ${probe.elapsedMs.toFixed(1)}ms: ${probe.url}`);
    }
  });
}

async function verifyLongLockClientCeiling(collection) {
  const attempt = await withPythonWriteLock(dbPath, 15000, async () => {
    const startedAt = performance.now();
    const result = await retryWebCollectionRequest(
      () => requestJson(`/api/short-videos/collections/${collection.id}/videos/busy-video-a`, { method: "DELETE" })
    ).catch((error) => error);
    return { result, elapsed: performance.now() - startedAt };
  });
  const { result, elapsed } = attempt;
  observed.clientRetryMs = elapsed;
  assert.equal(result.status, 503, "a genuinely long lock must escape the bounded client retry loop as 503");
  assert.equal(result.retryable, true);
  assert.ok(elapsed < CLIENT_BUSY_TOTAL_BUDGET_MS, `client retry ceiling exceeded: ${elapsed.toFixed(1)}ms`);
  assert.equal(countMemberships(dbPath, collection.id, "busy-video-a"), 1, "failed long-lock retries must roll back every attempt");
}

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/health") return sendJson(response, 200, { ok: true });
    const handled = await routeShortVideoApi(request, response, url, {
      notFound() { sendJson(response, 404, { error: "not found" }); },
      onMutation() { mutationEvents += 1; },
      readJsonBody: () => readJsonBody(request),
      requireLocalAdmin: () => true,
      sendJson,
      shortVideoStore: store
    });
    if (!handled && !response.writableEnded) sendJson(response, 404, { error: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function requestJson(pathname, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `request failed: ${response.status}`);
    error.status = response.status;
    error.retryable = response.status === 503 && payload.retryable === true;
    throw error;
  }
  return { status: response.status, payload };
}

async function withPythonWriteLock(filePath, holdMs, work) {
  const python = String(process.env.PYTHON || "python").trim() || "python";
  const script = [
    "import sqlite3,sys,time",
    "connection=sqlite3.connect(sys.argv[1], timeout=0)",
    "connection.execute('PRAGMA busy_timeout=0')",
    "connection.execute('BEGIN IMMEDIATE')",
    "print('LOCKED', flush=True)",
    "time.sleep(float(sys.argv[2]) / 1000)",
    "connection.rollback()",
    "connection.close()"
  ].join(";");
  const child = spawn(python, ["-c", script, filePath, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit").catch((error) => { throw error; });
  await waitForLocker(child);
  try {
    return await work();
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
}

function waitForLocker(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onData = (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("LOCKED")) {
        cleanup();
        resolve();
      }
    };
    const onErrorData = (chunk) => { stderr += String(chunk); };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Python SQLite locker exited before readiness (${code}): ${stderr}`));
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function runProbeWorker(urls, delayMs) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    setTimeout(async () => {
      try {
        const results = await Promise.all(workerData.urls.map(async (url) => {
          const startedAt = performance.now();
          const response = await fetch(url);
          await response.arrayBuffer();
          return { url, status: response.status, elapsedMs: performance.now() - startedAt };
        }));
        parentPort.postMessage({ results });
      } catch (error) {
        parentPort.postMessage({ error: String(error && error.message || error) });
      }
    }, workerData.delayMs);
  `, { eval: true, workerData: { urls, delayMs } });
  return new Promise((resolve, reject) => {
    worker.once("message", (message) => {
      worker.terminate();
      if (message.error) reject(new Error(message.error));
      else resolve(message.results);
    });
    worker.once("error", reject);
  });
}

function seedVideo(filePath, id, awemeId) {
  const db = openFixtureDatabase(filePath);
  try {
    db.prepare(`
      INSERT INTO short_videos (id, aweme_id, title, source_path, published_at, liked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, awemeId, "Busy fixture", `${id}.mp4`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  } finally {
    db.close();
  }
}

function countMemberships(filePath, collectionId, videoId) {
  return countRows(filePath, `
    SELECT COUNT(*) AS count FROM short_video_collection_items
    WHERE collection_id = ? AND video_id = ?
  `, [collectionId, videoId]);
}

function countRows(filePath, sql, params = []) {
  const db = openFixtureDatabase(filePath);
  try {
    return Number(db.prepare(sql).get(...params)?.count || 0);
  } finally {
    db.close();
  }
}

function openFixtureDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  return db;
}

async function readJsonBody(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

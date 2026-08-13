import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApiClient } from "../public/js/api.js";
import {
  parseShortVideoDeleteResponse,
  requestShortVideoDelete,
  shortVideoDeletePendingMessage,
  shortVideoDeleteRecoveryMessage
} from "../public/modules/short-videos/delete-contract.js";
import {
  createShortVideoDeleteRecoveryController,
  parseShortVideoDeleteJob
} from "../public/modules/short-videos/delete-recovery.js";
import { createShortVideoDeleteActions } from "../public/modules/short-videos/delete-actions.js";
import { shortVideoDeleteApiPath, shortVideoDetailApiPath } from "../public/modules/short-videos/router.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

verifyRoutes();
await verifyWebApiStatusRetention();
await verifyWebDeleteContract();
await verifyWebDeleteActions();
await verifyWebDeleteInFlightGate();
await verifyWebDeleteRecoveryController();
await verifyWebDeleteRecoveryRebuild();
verifyWebMutationBoundary();
verifyNativeSourceBoundary();
verifyNativeContract();
console.log("short-video-delete-clients: strict contracts, persistent rebuild, manual recovery, and lifecycle cancellation verified");

function completed(overrides = {}) {
  return {
    ok: true,
    accepted: true,
    pending: false,
    status: "completed",
    jobId: "job-completed",
    logicalDeleteCommitted: true,
    physicalCleanupComplete: true,
    cleanupPendingFiles: 0,
    ids: ["video-1"],
    count: 1,
    deletedFiles: ["video-1.mp4"],
    ...overrides
  };
}

function cleanupPending(overrides = {}) {
  return {
    ...completed(),
    pending: true,
    status: "cleanup_pending",
    jobId: "job-cleanup",
    physicalCleanupComplete: false,
    cleanupPendingFiles: 2,
    ...overrides
  };
}

function rollbackPending(overrides = {}) {
  return {
    error: "短视频删除尚未提交，正在恢复",
    ok: false,
    accepted: false,
    pending: true,
    status: "rollback_pending",
    jobId: "job-rollback",
    recoveryRequired: true,
    retryable: true,
    ...overrides
  };
}

function verifyRoutes() {
  assert.equal(shortVideoDetailApiPath("fixture-video"), "/api/short-videos/fixture-video");
  assert.equal(shortVideoDetailApiPath("collections"), "/api/short-videos/videos/collections");
  assert.equal(shortVideoDeleteApiPath("fixture-video"), "/api/short-videos/videos/fixture-video");
  assert.equal(shortVideoDeleteApiPath("collections"), "/api/short-videos/videos/collections");
  assert.equal(shortVideoDeleteApiPath("slash/value"), "/api/short-videos/videos/slash%2Fvalue");
}

async function verifyWebApiStatusRetention() {
  const originalFetch = globalThis.fetch;
  let seenOptions = null;
  try {
    globalThis.fetch = async (_path, options) => {
      seenOptions = options;
      return {
        ok: true,
        status: 202,
        json: async () => cleanupPending()
      };
    };
    const response = await createApiClient()("/delete", { method: "DELETE", returnResponse: true });
    assert.equal(response.status, 202, "Web API must retain successful HTTP status when explicitly requested");
    assert.equal(response.payload.status, "cleanup_pending");
    assert.equal(Object.hasOwn(seenOptions, "returnResponse"), false, "client-only response options must not leak into fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyWebDeleteContract() {
  const done = parseShortVideoDeleteResponse(200, completed(), { expectedIds: ["video-1"] });
  assert.equal(done.committed, true);
  assert.equal(done.pending, false);

  const cleanup = parseShortVideoDeleteResponse(202, cleanupPending(), { expectedIds: ["video-1"] });
  assert.equal(cleanup.committed, true);
  assert.equal(cleanup.pending, true);
  assert.equal(shortVideoDeletePendingMessage(cleanup), "资料库记录已移除，2 个文件待清理（任务 #job-cleanup）");

  for (const invalid of [
    cleanupPending({ ok: "true" }),
    cleanupPending({ accepted: false }),
    cleanupPending({ pending: false }),
    cleanupPending({ status: "completed" }),
    cleanupPending({ jobId: "" }),
    cleanupPending({ cleanupPendingFiles: -1 }),
    cleanupPending({ cleanupPendingFiles: 1.5 }),
    cleanupPending({ physicalCleanupComplete: true }),
    cleanupPending({ logicalDeleteCommitted: false }),
    cleanupPending({ ids: [] }),
    cleanupPending({ count: 2 })
  ]) {
    assert.throws(() => parseShortVideoDeleteResponse(202, invalid, { expectedIds: ["video-1"] }));
  }
  assert.throws(() => parseShortVideoDeleteResponse(202, completed()));
  assert.throws(() => parseShortVideoDeleteResponse(200, cleanupPending()));

  const rollbackError = new Error("短视频删除尚未提交，正在恢复");
  rollbackError.status = 500;
  rollbackError.payload = rollbackPending();
  const rollback = await requestShortVideoDelete(async () => { throw rollbackError; }, "/delete", { method: "DELETE" });
  assert.equal(rollback.committed, false);
  assert.equal(rollback.status, "rollback_pending");
  assert.equal(shortVideoDeleteRecoveryMessage(rollback), "删除尚未提交，正在安全恢复（任务 #job-rollback）");
  const manual = parseShortVideoDeleteResponse(500, rollbackPending({
    retryable: false,
    manualInterventionRequired: true,
    processRestartRequired: true
  }));
  assert.equal(manual.committed, false, "manual rollback must never delete the client model");
  assert.equal(manual.retryable, false);
  assert.equal(manual.manualInterventionRequired, true);
  assert.equal(manual.processRestartRequired, true);
  for (const invalid of [
    rollbackPending({ ok: true }),
    rollbackPending({ accepted: true }),
    rollbackPending({ pending: false }),
    rollbackPending({ recoveryRequired: false }),
    rollbackPending({ retryable: "false" }),
    rollbackPending({ retryable: false }),
    rollbackPending({ manualInterventionRequired: true }),
    rollbackPending({ processRestartRequired: true }),
    rollbackPending({ jobId: "" })
  ]) {
    assert.throws(() => parseShortVideoDeleteResponse(500, invalid));
  }

  let requestedOptions = null;
  const accepted = await requestShortVideoDelete(async (_path, options) => {
    requestedOptions = options;
    return { status: 202, payload: cleanupPending() };
  }, "/delete", { method: "DELETE", body: { ids: ["video-1"] } }, { expectedIds: ["video-1"] });
  assert.equal(accepted.pending, true);
  assert.equal(requestedOptions.returnResponse, true);
}

function verifyWebMutationBoundary() {
  const source = read("public/modules/short-videos/short-video-page.js");
  const actions = read("public/modules/short-videos/delete-actions.js");
  const singleStart = source.indexOf("async function deleteShortVideo");
  const batchStart = source.indexOf("async function deleteSelectedShortVideos");
  const single = source.slice(singleStart, batchStart);
  const batch = source.slice(batchStart, source.indexOf("function decrementCurrentAuthorCount", batchStart));
  for (const [name, block] of [["single/group", single], ["batch", batch]]) {
    const requestAt = block.indexOf("deleteActions.delete");
    const rollbackAt = block.indexOf("if (!data?.committed)");
    const mutationAt = block.indexOf("loadedCoverIds.delete");
    assert(requestAt >= 0 && rollbackAt > requestAt && mutationAt > rollbackAt, `${name} delete must validate and return on rollback before model mutation`);
  }
  assert(actions.includes("shortVideoDeleteApiPath(video.id)"), "single/group delete must use the explicit video endpoint");
  assert(actions.includes('requestShortVideoDelete(api, "/api/short-videos"'), "batch delete must share the same response validator");
  assert(batch.indexOf("if (!data?.committed)") < batch.indexOf("clearShortVideoDeleteSelection()"), "rollback must preserve Web selection");
}

async function verifyWebDeleteActions() {
  const tracked = [];
  const requests = [];
  let pending = false;
  const actions = createShortVideoDeleteActions({
    api: async (path, options) => {
      requests.push({ path, options });
      const error = new Error("fixture rollback");
      error.status = 500;
      error.payload = rollbackPending();
      throw error;
    },
    confirmDelete: () => true,
    recovery: {
      hasPending: () => pending,
      track: (result) => tracked.push(result)
    },
    showToast: () => {}
  });
  const result = await actions.deleteVideo({ id: "video-1", title: "fixture" });
  assert.equal(result.committed, false);
  assert.equal(requests[0].path, "/api/short-videos/videos/video-1");
  assert.equal(tracked.length, 1, "delete actions must hand rollback responses to persistent recovery tracking");
  pending = true;
  const blocked = await actions.deleteSelected(["video-1"]);
  assert.equal(blocked, null);
  assert.equal(requests.length, 1, "a pending recovery must block another client delete request");
}

async function verifyWebDeleteInFlightGate() {
  const deferred = createDeferred();
  const tracked = [];
  const toasts = [];
  let calls = 0;
  let confirmations = 0;
  let response = deferred.promise;
  const actions = createShortVideoDeleteActions({
    api: () => {
      calls += 1;
      return response;
    },
    confirmDelete: () => {
      confirmations += 1;
      return true;
    },
    recovery: {
      hasPending: () => false,
      track: (result) => tracked.push(result)
    },
    showToast: (message) => toasts.push(message)
  });

  const first = actions.deleteVideo({ id: "video-1", title: "first" });
  const blocked = await actions.deleteSelected(["video-2"]);
  assert.equal(blocked, null);
  assert.equal(calls, 1, "single and batch deletes must share one in-flight request gate");
  assert.equal(confirmations, 1, "blocked delete must only explain the active operation, not open another confirmation");
  assert.match(toasts.at(-1), /等待上一项删除恢复完成/);

  deferred.resolve({ status: 202, payload: cleanupPending() });
  const firstResult = await first;
  assert.equal(firstResult.committed, true);
  assert.equal(tracked.length, 1, "the released first response must still enter recovery tracking");

  response = Promise.resolve({ status: 200, payload: completed() });
  const afterSuccess = await actions.deleteVideo({ id: "video-1", title: "after success" });
  assert.equal(afterSuccess.committed, true);
  assert.equal(calls, 2, "request gate must release after response tracking completes");

  let fail = true;
  let failureCalls = 0;
  const failureActions = createShortVideoDeleteActions({
    api: async () => {
      failureCalls += 1;
      if (fail) throw new Error("fixture network failure");
      return { status: 200, payload: completed() };
    },
    confirmDelete: () => true,
    recovery: { hasPending: () => false, track: () => {} },
    showToast: () => {}
  });
  await assert.rejects(failureActions.deleteVideo({ id: "video-1" }), /fixture network failure/);
  fail = false;
  const afterFailure = await failureActions.deleteVideo({ id: "video-1" });
  assert.equal(afterFailure.committed, true);
  assert.equal(failureCalls, 2, "request gate must release in finally after a failed fetch");
}

async function verifyWebDeleteRecoveryController() {
  const timers = createManualTimers();
  const rendered = [];
  const responses = [];
  const controller = createShortVideoDeleteRecoveryController({
    api: async (path, options = {}) => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert(next, `missing recovery fixture response for ${options.method || "GET"} ${path}`);
      return next;
    },
    pollDelayMs: 1,
    renderState: (state) => rendered.push(state ? { ...state } : null),
    setTimer: timers.set,
    clearTimer: timers.clear
  });

  controller.track(parseShortVideoDeleteResponse(200, completed(), { expectedIds: ["video-1"] }));
  assert.equal(controller.hasPending(), false, "200 completed must not leave a recovery banner");

  controller.track(parseShortVideoDeleteResponse(202, cleanupPending(), { expectedIds: ["video-1"] }));
  assert.equal(controller.hasPending(), true);
  assert.match(rendered.at(-1).message, /资料库记录已移除，正在安全清理2 个文件/);
  responses.push(jobPayload("job-cleanup", "cleanup_pending", "cleanup", true, false));
  await timers.runNext();
  assert.equal(rendered.at(-1).actionLabel, "", "non-recoverable cleanup must not expose recovery");
  responses.push(jobPayload("job-cleanup", "completed", "cleanup", false, false));
  await timers.runNext();
  assert.match(rendered.at(-1).message, /已安全清理完成/);
  assert.equal(rendered.at(-1).actionLabel, "知道了");

  controller.track(await rollbackResult());
  responses.push(jobPayload("job-rollback", "rollback_pending", "rollback", true, true));
  await timers.runNext();
  assert.equal(rendered.at(-1).actionLabel, "重试恢复", "recoverable rollback must expose recovery");
  responses.push(new Error("fixture recovery failure"));
  await controller.recover();
  assert.match(rendered.at(-1).message, /恢复失败：fixture recovery failure/);
  assert.equal(rendered.at(-1).actionLabel, "重试恢复", "failed recovery must remain retryable");
  responses.push(jobPayload("job-rollback", "rolled_back", "rollback", false, false));
  await controller.recover();
  assert.match(rendered.at(-1).message, /删除未生效，文件已安全恢复/);

  assert.throws(
    () => parseShortVideoDeleteJob(jobPayload("other-job", "completed", "cleanup", false, false), "expected-job"),
    /其他任务/
  );
  controller.dispose();

  let releasePoll;
  const cancellationRenders = [];
  const cancellationTimers = createManualTimers();
  const cancellationController = createShortVideoDeleteRecoveryController({
    api: () => new Promise((resolve) => { releasePoll = resolve; }),
    pollDelayMs: 1,
    renderState: (state) => cancellationRenders.push(state ? { ...state } : null),
    setTimer: cancellationTimers.set,
    clearTimer: cancellationTimers.clear
  });
  cancellationController.track(await rollbackResult());
  const pendingPoll = cancellationTimers.runNext();
  cancellationController.dispose();
  releasePoll(jobPayload("job-rollback", "rollback_pending", "rollback", true, true));
  await pendingPoll;
  assert.equal(cancellationRenders.at(-1), null, "disposed polling must not render an old response");
  assert.equal(cancellationTimers.pending(), 0, "disposed polling must not schedule another request");

  const manualTimers = createManualTimers();
  const manualRenders = [];
  const manualController = createShortVideoDeleteRecoveryController({
    api: async () => jobPayload("job-rollback", "rollback_pending", "rollback", true, false, {
      manualInterventionRequired: true,
      stalled: true,
      retryable: false
    }),
    pollDelayMs: 1,
    renderState: (state) => manualRenders.push(state ? { ...state } : null),
    setTimer: manualTimers.set,
    clearTimer: manualTimers.clear
  });
  manualController.track(await rollbackResult());
  await manualTimers.runNext();
  assert.match(manualRenders.at(-1).message, /需要人工处理，请人工检查后再恢复/);
  assert.equal(manualRenders.at(-1).actionLabel, "", "manual intervention must not expose a false retry action");
  assert.equal(manualTimers.pending(), 0, "manual intervention must stop tight automatic polling");
  manualController.dispose();

  const initialManualStorage = createMemoryStorage();
  const initialManualRenders = [];
  const initialManual = createShortVideoDeleteRecoveryController({
    api: async () => { throw new Error("initial manual rollback must not poll"); },
    apiBaseUrl: "http://fixture",
    storage: initialManualStorage,
    renderState: (state) => initialManualRenders.push(state ? { ...state } : null)
  });
  initialManual.track(parseShortVideoDeleteResponse(500, rollbackPending({
    retryable: false,
    manualInterventionRequired: true,
    processRestartRequired: true
  })));
  assert(initialManualStorage.value(), "initial manual rollback must persist its job snapshot");
  assert.match(initialManualRenders.at(-1).message, /请重启服务后再恢复/);
  assert.equal(initialManualRenders.at(-1).actionLabel, "", "initial manual rollback must not expose POST recovery");
  await initialManual.recover();
  initialManual.dispose();
}

async function verifyWebDeleteRecoveryRebuild() {
  const storage = createMemoryStorage();
  const first = createShortVideoDeleteRecoveryController({
    api: async () => { throw new Error("first instance must not poll after dispose"); },
    apiBaseUrl: "http://fixture",
    storage,
    pollDelayMs: 1000,
    renderState: () => {}
  });
  first.track(parseShortVideoDeleteResponse(202, cleanupPending(), { expectedIds: ["video-1"] }));
  assert(storage.value(), "pending Web job must persist before reload");
  first.dispose();
  assert(storage.value(), "dispose must preserve a non-terminal Web job");

  const requests = [];
  const rendered = [];
  const second = createShortVideoDeleteRecoveryController({
    api: async (path) => {
      requests.push(path);
      return jobPayload("job-cleanup", "completed", "cleanup", false, false);
    },
    apiBaseUrl: "http://fixture/",
    storage,
    renderState: (state) => rendered.push(state ? { ...state } : null)
  });
  await second.ready;
  assert.deepEqual(requests, ["/api/short-videos/delete-jobs?jobId=job-cleanup"], "reload must first GET the same persisted job");
  assert.match(rendered.at(-1).message, /已安全清理完成/);
  assert.equal(storage.value(), null, "terminal Web job must clear localStorage");

  const missingStorage = createMemoryStorage(storedPending("job-missing"));
  const missingTimers = createManualTimers();
  const missingRendered = [];
  const missing = createShortVideoDeleteRecoveryController({
    api: async () => { throw deleteJobError(404, "SHORT_VIDEO_DELETE_JOB_NOT_FOUND"); },
    apiBaseUrl: "http://fixture",
    storage: missingStorage,
    setTimer: missingTimers.set,
    clearTimer: missingTimers.clear,
    renderState: (state) => missingRendered.push(state ? { ...state } : null)
  });
  await missing.ready;
  assert.equal(missingStorage.value(), null, "explicit job-not-found must clear the stale Web snapshot");
  assert.equal(missingTimers.pending(), 0, "explicit job-not-found must not schedule another Web poll");
  assert.equal(missing.hasPending(), false, "explicit job-not-found must release the Web delete gate");
  assert.match(missingRendered.at(-1).message, /恢复记录已失效/);
  assert.equal(missingRendered.at(-1).actionLabel, "知道了", "stale Web notice must be dismissible");
  let postStaleDeletes = 0;
  const postStaleActions = createShortVideoDeleteActions({
    api: async () => { postStaleDeletes += 1; return { status: 200, payload: completed() }; },
    confirmDelete: () => true,
    recovery: missing,
    showToast: () => {}
  });
  await postStaleActions.deleteVideo({ id: "video-1", title: "after stale restore" });
  assert.equal(postStaleDeletes, 1, "explicit job-not-found must allow the next Web delete immediately");

  for (const [name, status, code] of [
    ["generic 404", 404, ""],
    ["500 with exact job-not-found code", 500, "SHORT_VIDEO_DELETE_JOB_NOT_FOUND"]
  ]) {
    const retainedStorage = createMemoryStorage(storedPending(`job-retained-${status}`));
    const retainedTimers = createManualTimers();
    const retained = createShortVideoDeleteRecoveryController({
      api: async () => { throw deleteJobError(status, code); },
      apiBaseUrl: "http://fixture",
      storage: retainedStorage,
      setTimer: retainedTimers.set,
      clearTimer: retainedTimers.clear,
      renderState: () => {}
    });
    await retained.ready;
    assert(retainedStorage.value(), `${name} must retain the Web snapshot`);
    assert.equal(retainedTimers.pending(), 1, `${name} must remain fail-closed and retry`);
    assert.equal(retained.hasPending(), true, `${name} must keep blocking a new delete`);
    retained.dispose();
  }

  for (const [name, raw, base] of [
    ["bad payload", "{bad-json", "http://fixture"],
    ["different base", JSON.stringify({ version: 1, jobId: "job-cross-base", apiBaseUrl: "http://other-fixture", kind: "rollback", cleanupPendingFiles: 0 }), "http://fixture"]
  ]) {
    const unsafeStorage = createMemoryStorage(raw);
    let calls = 0;
    const controller = createShortVideoDeleteRecoveryController({
      api: async () => { calls += 1; },
      apiBaseUrl: base,
      storage: unsafeStorage,
      renderState: () => {}
    });
    await controller.ready;
    assert.equal(calls, 0, `${name} must fail closed before GET`);
    assert.equal(unsafeStorage.value(), null, `${name} must clear unsafe localStorage`);
  }
}

function storedPending(jobId) {
  return JSON.stringify({ version: 1, jobId, apiBaseUrl: "http://fixture", kind: "cleanup", cleanupPendingFiles: 2 });
}

function deleteJobError(status, code) {
  const error = new Error(`fixture ${status}`);
  error.status = status;
  error.statusCode = status;
  error.code = code;
  error.payload = { code };
  return error;
}

async function rollbackResult() {
  const rollbackError = new Error("fixture rollback");
  rollbackError.status = 500;
  rollbackError.payload = rollbackPending();
  return requestShortVideoDelete(async () => { throw rollbackError; }, "/delete", { method: "DELETE" });
}

function jobPayload(id, status, phase, pending, recoverable, overrides = {}) {
  return {
    ok: true,
    job: {
      id,
      status,
      phase,
      pending,
      recoverable,
      requiresAttention: recoverable,
      error: "",
      ...overrides
    }
  };
}

function createManualTimers() {
  const entries = [];
  return {
    set(action) {
      const entry = { action, canceled: false };
      entries.push(entry);
      return entry;
    },
    clear(entry) {
      if (entry) entry.canceled = true;
    },
    async runNext() {
      while (entries.length) {
        const entry = entries.shift();
        if (!entry.canceled) return entry.action();
      }
      throw new Error("manual timer queue is empty");
    },
    pending() {
      return entries.filter((entry) => !entry.canceled).length;
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createMemoryStorage(initialValue = null) {
  let value = initialValue;
  return {
    getItem: () => value,
    setItem: (key, next) => { value = String(next); },
    removeItem: () => { value = null; },
    value: () => value
  };
}

function verifyNativeSourceBoundary() {
  const source = read("android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoActivity.java");
  const controller = read("android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoDeleteController.java");
  const transport = read("android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoDeleteTransport.java");
  const jobError = read("android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoDeleteJobException.java");
  const handleDelete = controller.slice(controller.indexOf("private void handleDeleteResult"), controller.indexOf("private boolean deleteOperationActive"));
  const cleanupStart = handleDelete.indexOf("if (result.cleanupPending())");
  const rollbackStart = handleDelete.indexOf("if (!result.committed())", cleanupStart);
  const applyIndexes = [...handleDelete.matchAll(/host\.applyCommittedDelete\(result, group\)/g)].map((match) => match.index);
  const cleanupBranch = handleDelete.slice(cleanupStart, rollbackStart);
  const rollbackBranch = handleDelete.slice(rollbackStart, applyIndexes[1]);
  const completedBranch = handleDelete.slice(applyIndexes[1]);
  const startTracking = controller.slice(controller.indexOf("private boolean startTracking"), controller.indexOf("private void finishTracking"));
  const apply = source.slice(source.indexOf("private void applyCommittedDelete"), source.indexOf("private ShortVideoItem nextVideoAfterDelete"));
  const urlStart = source.indexOf("private String deleteVideoUrl");
  const url = source.slice(urlStart, source.indexOf("private String apiBase()", urlStart));
  assert(transport.includes("ShortVideoDeleteJson.parse(status"), "Native delete transport must retain HTTP status for strict parsing");
  assert(transport.includes("new NativeShortVideoDeleteJobException(") && jobError.includes("statusCode") && jobError.includes("JOB_NOT_FOUND.equals"), "Native job transport must retain typed HTTP status and exact public error code");
  assert(cleanupStart >= 0 && rollbackStart > cleanupStart && applyIndexes.length === 2, "Native delete result handling must retain distinct cleanup, rollback, and completed branches");
  assert(cleanupBranch.includes("if (!startTracking(") && cleanupBranch.indexOf("startTracking(") < cleanupBranch.indexOf("host.applyCommittedDelete(result, group)"), "cleanup 202 must finish synchronous tracking setup before Activity model mutation");
  assert(startTracking.includes("if (persistActiveJob()) return true") && startTracking.indexOf("persistActiveJob()") < startTracking.indexOf("return true"), "tracking setup must synchronously save the pending identity before reporting success");
  assert(rollbackBranch.includes("KIND_ROLLBACK") && !rollbackBranch.includes("host.applyCommittedDelete"), "rollback 500 must persist tracking without mutating the Activity model");
  assert(completedBranch.includes("host.applyCommittedDelete(result, group)"), "completed 200 must still apply the committed Activity model update");
  assert(controller.includes("requestInFlight") && controller.includes("if (deleteOperationActive())"), "Native controller must gate confirmations while a DELETE request is in flight");
  assert(!source.includes("private DeleteResult requestDeleteVideo"), "Activity must delegate DELETE transport to NativeShortVideoDeleteController");
  assert(source.includes("deleteController.confirmDelete(") && source.includes("if (deleteController != null) deleteController.destroy()"), "Activity must delegate confirmation and cancel the controller during destroy");
  assert(source.includes("deleteController.restorePending(apiBase());"), "Activity must restore the persisted delete job after its UI is ready");
  assert(apply.includes("releaseAllPlayers()"), "committed Native deletion must retain the existing model/player cleanup");
  assert(url.indexOf('.appendPath("videos")') < url.indexOf(".appendPath(item.id)"), "Native deletion must use the explicit /videos/:id route");
}

function verifyNativeContract() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-delete-contract-"));
  const javaHome = String(process.env.JAVA_HOME || "").trim();
  const bundledJavaHome = "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
  const javaTool = (name) => javaHome
    ? path.join(javaHome, "bin", `${name}.exe`)
    : fs.existsSync(path.join(bundledJavaHome, "bin", `${name}.exe`))
      ? path.join(bundledJavaHome, "bin", `${name}.exe`)
      : name;
  try {
    const sources = [
      path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "ShortVideoDeleteResult.java"),
      path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoDeleteJobState.java"),
      path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoPendingJob.java"),
      path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoDeleteSession.java"),
      path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoDeleteTaskRunner.java"),
      path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoDeleteJobException.java"),
      path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoDeleteController.java"),
      path.join(root, "tools", "fixtures", "NativeShortVideoDeleteContractHarness.java"),
      path.join(root, "tools", "fixtures", "NativeShortVideoDeleteControllerHarness.java")
    ];
    const compiled = spawnSync(javaTool("javac"), ["-encoding", "UTF-8", "-d", tempRoot, ...sources], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(compiled.status, 0, `native delete contract harness must compile:\n${compiled.stderr || compiled.stdout}`);
    const executed = spawnSync(javaTool("java"), ["-cp", tempRoot, "local.fanhao.library.NativeShortVideoDeleteContractHarness"], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(executed.status, 0, `native delete contract harness must pass:\n${executed.stderr || executed.stdout}`);
    process.stdout.write(executed.stdout);
    const controllerExecuted = spawnSync(javaTool("java"), ["-cp", tempRoot, "local.fanhao.library.NativeShortVideoDeleteControllerHarness"], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(controllerExecuted.status, 0, `native delete controller harness must pass:\n${controllerExecuted.stderr || controllerExecuted.stdout}`);
    process.stdout.write(controllerExecuted.stdout);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

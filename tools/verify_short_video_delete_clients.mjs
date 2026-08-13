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
await verifyWebDeleteRecoveryController();
verifyWebMutationBoundary();
verifyNativeSourceBoundary();
verifyNativeContract();
console.log("short-video-delete-clients: strict Web and Native response contracts verified");

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
  for (const invalid of [
    rollbackPending({ ok: true }),
    rollbackPending({ accepted: true }),
    rollbackPending({ pending: false }),
    rollbackPending({ recoveryRequired: false }),
    rollbackPending({ retryable: false }),
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

function verifyNativeSourceBoundary() {
  const source = read("android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoActivity.java");
  const controller = read("android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoDeleteController.java");
  const transport = read("android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoDeleteTransport.java");
  const apply = source.slice(source.indexOf("private void applyCommittedDelete"), source.indexOf("private ShortVideoItem nextVideoAfterDelete"));
  const urlStart = source.indexOf("private String deleteVideoUrl");
  const url = source.slice(urlStart, source.indexOf("private String apiBase()", urlStart));
  assert(transport.includes("ShortVideoDeleteJson.parse(status"), "Native delete transport must retain HTTP status for strict parsing");
  assert(controller.includes("if (result.committed()) host.applyCommittedDelete") && controller.indexOf("if (result.committed()) host.applyCommittedDelete") < controller.indexOf("if (!result.committed())"), "Native controller must apply only committed responses and track rollback without mutation");
  assert(!source.includes("private DeleteResult requestDeleteVideo"), "Activity must delegate DELETE transport to NativeShortVideoDeleteController");
  assert(source.includes("deleteController.confirmDelete(") && source.includes("if (deleteController != null) deleteController.destroy()"), "Activity must delegate confirmation and cancel the controller during destroy");
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

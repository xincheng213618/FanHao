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
import { shortVideoDeleteApiPath, shortVideoDetailApiPath } from "../public/modules/short-videos/router.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

verifyRoutes();
await verifyWebApiStatusRetention();
await verifyWebDeleteContract();
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
  const singleStart = source.indexOf("async function deleteShortVideo");
  const batchStart = source.indexOf("async function deleteSelectedShortVideos");
  const single = source.slice(singleStart, batchStart);
  const batch = source.slice(batchStart, source.indexOf("function decrementCurrentAuthorCount", batchStart));
  for (const [name, block] of [["single/group", single], ["batch", batch]]) {
    const requestAt = block.indexOf("requestShortVideoDelete(");
    const rollbackAt = block.indexOf("if (!data.committed)");
    const mutationAt = block.indexOf("loadedCoverIds.delete");
    assert(requestAt >= 0 && rollbackAt > requestAt && mutationAt > rollbackAt, `${name} delete must validate and return on rollback before model mutation`);
  }
  assert(single.includes("shortVideoDeleteApiPath(video.id)"), "single/group delete must use the explicit video endpoint");
  assert(batch.includes('requestShortVideoDelete(api, "/api/short-videos"'), "batch delete must share the same response validator");
  assert(batch.indexOf("if (!data.committed)") < batch.indexOf("clearShortVideoDeleteSelection()"), "rollback must preserve Web selection");
}

function verifyNativeSourceBoundary() {
  const source = read("android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoActivity.java");
  const request = source.slice(source.indexOf("private DeleteResult requestDeleteVideo"), source.indexOf("private void applyDeleteResult"));
  const apply = source.slice(source.indexOf("private void applyDeleteResult"), source.indexOf("private ShortVideoItem nextVideoAfterDelete"));
  const urlStart = source.indexOf("private String deleteVideoUrl");
  const url = source.slice(urlStart, source.indexOf("private String apiBase()", urlStart));
  assert(request.includes("ShortVideoDeleteJson.parse(status"), "Native delete transport must retain HTTP status for strict parsing");
  assert(!request.includes("status < 200 || status >= 300"), "Native transport must let the contract parse rollback_pending HTTP 500");
  assert(apply.indexOf("if (!result.committed())") < apply.indexOf("releaseAllPlayers()"), "Native rollback must return before player/model/navigation mutation");
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
      path.join(root, "tools", "fixtures", "NativeShortVideoDeleteContractHarness.java")
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
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

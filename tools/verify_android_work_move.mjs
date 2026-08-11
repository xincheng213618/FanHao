import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeWorksApi } from "../src/modules/fanhao/server/works/routes-api.js";
import {
  createAndroidWorkMoveController,
  normalizeMoveTargetCandidate,
  workMoveCanManualRetry,
  workMoveNeedsCleanupRetry,
  workMoveRequestStorageKey,
  workMoveStatusLabel
} from "../android-client/www/modules/fanhao/features/works/work-move.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

for (const [status, label] of Object.entries({
  queued: "等待开始",
  running: "正在迁移",
  cleanup_pending: "等待清理",
  rollback_pending: "正在回滚",
  blocked: "需要人工处理",
  failed: "迁移失败",
  completed: "已完成"
})) assert.equal(workMoveStatusLabel(status), label);
assert.equal(workMoveNeedsCleanupRetry({ id: "cleanup", status: "cleanup_pending", retryRequired: true }), true);
assert.equal(workMoveNeedsCleanupRetry({ id: "cleanup", status: "cleanup_pending", retryRequired: false }), false);
assert.equal(workMoveCanManualRetry({ status: "failed" }), true);
assert.equal(workMoveCanManualRetry({ status: "blocked" }), false);
assert.deepEqual(normalizeMoveTargetCandidate({ id: 9, name: "目标人物" }), { id: "9", name: "目标人物" });
assert.equal(normalizeMoveTargetCandidate({ id: "", name: "无效" }), null);
assert.notEqual(workMoveRequestStorageKey("http://a:29998", "1"), workMoveRequestStorageKey("http://b:29998", "1"), "move recovery state must be server-scoped");

const source = read("android-client/www/modules/fanhao/features/works/work-move.js");
assert.match(source, /\/move-targets\?query=/, "Android target picker must use the server-approved target contract");
assert.match(source, /aria-modal/, "Android picker/status dialogs must be accessible dialogs");
assert.match(source, /cleanupAlreadyRetried/, "cleanup recovery needs a durable one-shot fence");
assert.match(source, /linkAbort\(isActive\.signal, controller\)/, "navigation must abort stale Android move requests");
assert.doesNotMatch(source, /targetDirectory|targetPath|rootPath/, "Android must never construct or submit a filesystem path");
assert.match(read("android-client/www/modules/fanhao/features/works/actions.js"), /迁移作品 \/ 查看状态/, "work detail must expose the durable move action from its More menu");
assert.match(read("src/modules/fanhao/server/works/routes-api.js"), /move-targets[\s\S]{0,500}requireLocalAdmin/, "server target list must keep the local-admin boundary");
assert.match(read("src/modules/fanhao/server/admin/admin-core-mutation-service.js"), /function listWorkMoveTargets/, "server must own target-directory resolution");

let routeResponse = null;
let routeOptions = null;
await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/works/42/move-targets?query=%E7%9B%AE%E6%A0%87&limit=9"), {
  notFound: () => assert.fail("target route must be handled"),
  personDetailService: {},
  readJsonBody: async () => ({}),
  requireLocalAdmin: () => true,
  requireTrustedFileMutation: () => true,
  sendJson: (_res, status, payload) => { routeResponse = { status, payload }; },
  workDetailService: {},
  workMutationService: {
    moveTargets: (workId, options) => {
      routeOptions = { workId, options };
      return { workId, candidates: [{ id: "7", name: "服务端人物" }] };
    }
  },
  workQueryService: {}
});
assert.equal(routeResponse?.status, 200);
assert.deepEqual(routeOptions, { workId: "42", options: { query: "目标", limit: "9" } });
assert.deepEqual(routeResponse?.payload?.candidates, [{ id: "7", name: "服务端人物" }]);

const storage = new Map();
const previousWindow = globalThis.window;
globalThis.window = {
  confirm: () => true,
  localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  }
};
const calls = [];
const controller = createAndroidWorkMoveController({
  getActiveUrl: () => "http://fixture:29998",
  request: async (_baseUrl, requestPath, options = {}) => {
    calls.push({ requestPath, method: options.method || "GET", body: options.body });
    if (requestPath.includes("/move-job")) return { job: null };
    if (requestPath.includes("/move-to-person")) return { job: { id: "job-1", status: "queued", phase: "queued" } };
    return { job: { id: "job-1", status: "queued", phase: "queued" } };
  },
  delay: async () => {
    const error = new Error("fixture poll stop");
    error.name = "AbortError";
    throw error;
  }
});
await controller.attach({ id: "42", title: "fixture" });
await controller.startMove({ id: "42", title: "fixture" }, { id: "7", name: "服务端人物" });
controller.detach();
globalThis.window = previousWindow;
const startCall = calls.find((call) => call.requestPath.includes("/move-to-person"));
assert.ok(startCall, "fixture must create a durable job command");
assert.equal(startCall.method, "POST");
assert.deepEqual(Object.keys(startCall.body).sort(), ["idempotencyKey", "personId"], "Android command must contain only the server-selected person and idempotency key");
assert.equal(startCall.body.personId, "7");

console.log("android-work-move: ok (server-approved targets, path-free command, durable restore, status labels, cleanup fence)");

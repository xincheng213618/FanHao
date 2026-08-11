import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeWorksApi } from "../src/modules/fanhao/server/works/routes-api.js";
import {
  createAndroidWorkMoveController,
  installModalFocusTrap,
  listenAbort,
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
  rolled_back: "已回滚",
  completed: "已完成"
})) assert.equal(workMoveStatusLabel(status), label);
assert.equal(workMoveNeedsCleanupRetry({ id: "cleanup", status: "cleanup_pending", retryRequired: true }), true);
assert.equal(workMoveNeedsCleanupRetry({ id: "cleanup", status: "cleanup_pending", retryRequired: false }), false);
assert.equal(workMoveCanManualRetry({ status: "failed" }), true);
assert.equal(workMoveCanManualRetry({ id: "cleanup", status: "cleanup_pending", retryRequired: true }), true);
assert.equal(workMoveCanManualRetry({ status: "blocked" }), false);
assert.deepEqual(normalizeMoveTargetCandidate({ id: 9, name: "目标人物" }), { id: "9", name: "目标人物" });
assert.equal(normalizeMoveTargetCandidate({ id: "", name: "无效" }), null);
assert.notEqual(workMoveRequestStorageKey("http://a:29998", "1"), workMoveRequestStorageKey("http://b:29998", "1"), "move recovery state must be server-scoped");

const source = read("android-client/www/modules/fanhao/features/works/work-move.js");
assert.match(source, /\/move-targets\?query=/, "Android target picker must use the server-approved target contract");
assert.match(source, /aria-modal/, "Android picker/status dialogs must be accessible dialogs");
assert.match(source, /cleanupAlreadyRetried/, "cleanup recovery needs a durable one-shot fence");
assert.match(source, /linkAbort\(isActive\.signal, controller\)/, "navigation must abort stale Android move requests");
assert.match(source, /trackOverlay\(close\)/, "navigation detach must close all move dialogs");
assert.match(source, /listenAbort\(attached\?\.controller\?\.signal, close\)/, "move dialogs must close when their route guard aborts");
assert.match(source, /installModalFocusTrap/, "Android move dialogs must trap focus at document scope");
assert.doesNotMatch(source, /targetDirectory|targetPath|rootPath/, "Android must never construct or submit a filesystem path");
assert.match(read("android-client/www/modules/fanhao/features/works/actions.js"), /迁移作品 \/ 查看状态/, "work detail must expose the durable move action from its More menu");
assert.match(read("android-client/www/modules/fanhao/android-module.js"), /handleBack: \(\) => detailViews\.handleBack/, "native Android back must close a work-move dialog before leaving its detail route");
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

let androidMoveCalls = 0;
routeResponse = null;
await routeWorksApi({ method: "POST", headers: { "x-fanhao-client": "android" } }, {}, new URL("http://fixture/api/works/42/move-to-person"), {
  notFound: () => assert.fail("move route must be handled"),
  personDetailService: {},
  readJsonBody: async () => ({ personId: "7", idempotencyKey: "fixture", targetDirectory: "C:\\forbidden" }),
  requireLocalAdmin: () => true,
  requireTrustedFileMutation: () => true,
  sendJson: (_res, status, payload) => { routeResponse = { status, payload }; },
  workDetailService: {},
  workMutationService: { moveToPerson: () => { androidMoveCalls += 1; } },
  workQueryService: {}
});
assert.equal(routeResponse?.status, 400, "Android path overrides must be rejected before the journal service");
assert.equal(routeResponse?.payload?.code, "WORK_MOVE_ANDROID_TARGET_FORBIDDEN");
assert.equal(androidMoveCalls, 0);

routeResponse = null;
let androidBody = null;
await routeWorksApi({ method: "POST", headers: { "x-fanhao-client": "android" } }, {}, new URL("http://fixture/api/works/42/move-to-person"), {
  notFound: () => assert.fail("move route must be handled"),
  personDetailService: {},
  readJsonBody: async () => ({ personId: "7", idempotencyKey: "fixture", ignored: "not forwarded" }),
  requireLocalAdmin: () => true,
  requireTrustedFileMutation: () => true,
  sendJson: (_res, status, payload) => { routeResponse = { status, payload }; },
  workDetailService: {},
  workMutationService: { moveToPerson: (_workId, body) => { androidBody = body; return { ok: true, job: null }; } },
  workQueryService: {}
});
assert.equal(routeResponse?.status, 202);
assert.deepEqual(androidBody, { personId: "7", idempotencyKey: "fixture" }, "Android command facade must whitelist its request body");

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
    if (requestPath.includes("/move-to-person")) return { job: { id: "job-1", workId: "42", status: "queued", phase: "queued" } };
    return { job: { id: "job-1", workId: "42", status: "queued", phase: "queued" } };
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

let activeServer = "http://a:29998";
const slowPost = deferred();
const slowTargets = deferred();
const scopeStorage = new Map();
const scopeMessages = [];
globalThis.window = {
  confirm: () => true,
  localStorage: {
    getItem: (key) => scopeStorage.get(key) || null,
    setItem: (key, value) => scopeStorage.set(key, String(value)),
    removeItem: (key) => scopeStorage.delete(key)
  }
};
const scopedController = createAndroidWorkMoveController({
  getActiveUrl: () => activeServer,
  renderMessage: (message) => scopeMessages.push(message),
  request: async (baseUrl, requestPath) => {
    if (requestPath.includes("/move-targets")) return slowTargets.promise;
    if (requestPath.includes("/move-to-person")) return slowPost.promise;
    if (requestPath.includes("/move-job")) return { job: null };
    return { job: null };
  },
  delay: async () => {
    const error = new Error("fixture poll stop");
    error.name = "AbortError";
    throw error;
  }
});
await scopedController.attach({ id: "42", title: "A" });
const pendingTargets = scopedController.loadMoveTargets({ id: "42" });
const pendingStart = scopedController.startMove({ id: "42", title: "A" }, { id: "7", name: "A target" });
activeServer = "http://b:29998";
await scopedController.attach({ id: "42", title: "B" });
slowTargets.resolve({ candidates: [{ id: "7", name: "old server target" }] });
slowPost.resolve({ job: { id: "a-job", workId: "42", status: "queued" } });
assert.equal(await pendingTargets, null, "a pending target response must be discarded after a server switch");
await pendingStart;
assert.equal(scopeStorage.get(workMoveRequestStorageKey("http://b:29998", "42")), undefined, "a POST completed after switch must not write B recovery state");
assert.equal(scopeMessages.length, 0, "a POST completed after switch must not announce into B");
scopedController.detach();

activeServer = "http://a:29998";
const slowRecovery = deferred();
const recoveryStorage = new Map([[workMoveRequestStorageKey(activeServer, "42"), JSON.stringify({ idempotencyKey: "a-key" })]]);
globalThis.window = {
  confirm: () => true,
  localStorage: {
    getItem: (key) => recoveryStorage.get(key) || null,
    setItem: (key, value) => recoveryStorage.set(key, String(value)),
    removeItem: (key) => recoveryStorage.delete(key)
  }
};
const recoveryController = createAndroidWorkMoveController({
  getActiveUrl: () => activeServer,
  request: async (requestBaseUrl, requestPath) => requestBaseUrl === "http://a:29998" && requestPath.includes("/move-job") ? slowRecovery.promise : { job: null }
});
const pendingRecovery = recoveryController.attach({ id: "42", title: "A" });
activeServer = "http://b:29998";
await recoveryController.attach({ id: "42", title: "B" });
slowRecovery.reject(new Error("A recovery failed"));
await pendingRecovery;
assert.equal(recoveryStorage.get(workMoveRequestStorageKey("http://b:29998", "42")), undefined, "a stale recovery failure must not clear or create B state");
recoveryController.detach();

activeServer = "http://same:29998";
let sameRouteActive = true;
const sameRoutePost = deferred();
const sameRouteMessages = [];
globalThis.window = {
  confirm: () => true,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
};
const sameRouteController = createAndroidWorkMoveController({
  getActiveUrl: () => activeServer,
  renderMessage: (message) => sameRouteMessages.push(message),
  request: async (_baseUrl, requestPath) => {
    if (requestPath.includes("/move-job")) return { job: null };
    if (requestPath.includes("/move-to-person")) return sameRoutePost.promise;
    return { job: null };
  }
});
await sameRouteController.attach({ id: "42", title: "same" }, { isActive: () => sameRouteActive });
const staleSameRouteStart = sameRouteController.startMove({ id: "42", title: "same" }, { id: "7", name: "target" });
sameRouteActive = false;
sameRoutePost.resolve({ job: { id: "same-job", workId: "42", status: "queued" } });
await staleSameRouteStart;
assert.equal(sameRouteMessages.length, 0, "a same-server route change must fence a completed POST");
sameRouteController.detach();

let cleanupAttempts = 0;
const cleanupJob = { id: "cleanup-job", workId: "42", status: "cleanup_pending", retryRequired: true };
const cleanupController = createAndroidWorkMoveController({
  getActiveUrl: () => "http://cleanup:29998",
  request: async (_baseUrl, requestPath) => {
    if (requestPath.endsWith("/retry")) {
      cleanupAttempts += 1;
      throw new Error("temporary retry failure");
    }
    return { job: cleanupJob };
  }
});
await cleanupController.attach({ id: "42", title: "cleanup" });
await waitFor(() => cleanupAttempts === 1);
cleanupController.detach();
await cleanupController.attach({ id: "42", title: "cleanup" });
await waitFor(() => cleanupAttempts === 2);
cleanupController.detach();
assert.equal(cleanupAttempts, 2, "a failed cleanup retry must not consume the durable one-shot marker");

let completedReload = "";
let completedCache = "";
const completedController = createAndroidWorkMoveController({
  getActiveUrl: () => "http://complete:29998",
  clearDetailCache: async (base, suffix) => { completedCache = `${base}${suffix}`; },
  renderWorkDetail: (workId) => { completedReload = workId; },
  request: async () => ({ job: { id: "complete-job", workId: "42", status: "completed" } })
});
await completedController.attach({ id: "42", title: "complete" });
assert.equal(completedReload, "42", "a restored completed job must safely reload its work");
assert.equal(completedCache, "http://complete:29998/api/works/42");
completedController.detach();

const listeners = new Map();
const fakeDocument = {
  activeElement: null,
  addEventListener: (type, listener) => listeners.set(type, listener),
  removeEventListener: (type) => listeners.delete(type)
};
const first = { offsetParent: {}, focus() { fakeDocument.activeElement = this; } };
const last = { offsetParent: {}, focus() { fakeDocument.activeElement = this; } };
const panel = {
  contains: (target) => target === first || target === last,
  focus() { fakeDocument.activeElement = this; },
  querySelectorAll: () => [first, last]
};
const trigger = { focused: false, focus() { this.focused = true; fakeDocument.activeElement = this; } };
let closeCount = 0;
const releaseTrap = installModalFocusTrap({ close: () => { closeCount += 1; }, documentRef: fakeDocument, initialFocus: first, panel, trigger });
assert.equal(fakeDocument.activeElement, first, "dialog must receive focus immediately");
const tab = { key: "Tab", shiftKey: false, preventDefault() { this.prevented = true; } };
listeners.get("keydown")(tab);
assert.equal(fakeDocument.activeElement, last, "Tab must stay inside a slow/failing dialog");
listeners.get("focusin")({ target: {} });
assert.equal(fakeDocument.activeElement, first, "background focus must be redirected into the dialog");
listeners.get("keydown")({ key: "Escape", preventDefault() {} });
assert.equal(closeCount, 1, "document-level Escape must close the dialog");
releaseTrap();
assert.equal(trigger.focused, true, "dialog cleanup must restore the trigger focus");

let abortedOverlay = 0;
const overlayAbort = new AbortController();
const unlistenOverlay = listenAbort(overlayAbort.signal, () => { abortedOverlay += 1; });
overlayAbort.abort();
unlistenOverlay();
assert.equal(abortedOverlay, 1, "route abort must execute the registered dialog closer");

globalThis.window = previousWindow;

console.log("android-work-move: ok (server-approved targets, path-free command, durable restore, switch fences, cleanup fence, focus trap)");

async function waitFor(predicate, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("fixture condition did not settle");
}

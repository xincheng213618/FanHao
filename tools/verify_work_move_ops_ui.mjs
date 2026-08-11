import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchWorkMoveJobWithBackoff,
  isTransientWorkMovePollError,
  workMovePollRetryDelay
} from "../public/modules/fanhao/work-move-polling.js";
import {
  createWorkMoveOpsController,
  fallbackCopyText,
  moveJobCanRetry,
  moveJobStatusLabel,
  workMoveOpsPanelIsVisible
} from "../public/modules/system/work-move-ops-panel.js";
import { createCompletedWorkMoveReloader } from "../public/modules/fanhao/work-move-completion.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

assert.equal(isTransientWorkMovePollError({ statusCode: 408 }), true);
assert.equal(isTransientWorkMovePollError({ status: 429 }), true);
assert.equal(isTransientWorkMovePollError({ statusCode: 503 }), true);
assert.equal(isTransientWorkMovePollError({ statusCode: 500 }), false);
assert.equal(isTransientWorkMovePollError(new TypeError("network failed")), true);
assert.deepEqual([0, 1, 2, 3, 8].map(workMovePollRetryDelay), [500, 1000, 2000, 2000, 2000]);

const attempts = [];
const waits = [];
const payload = await fetchWorkMoveJobWithBackoff({
  api: async () => {
    attempts.push(Date.now());
    if (attempts.length === 1) throw Object.assign(new Error("timeout"), { statusCode: 408 });
    if (attempts.length === 2) throw Object.assign(new Error("busy"), { statusCode: 503 });
    return { job: { id: "fixture", status: "running" } };
  },
  jobId: "fixture",
  signal: new AbortController().signal,
  wait: async (ms) => waits.push(ms)
});
assert.equal(payload.job.id, "fixture");
assert.deepEqual(waits, [500, 1000], "transient polling must use bounded backoff");

let finiteAttempts = 0;
await assert.rejects(
  fetchWorkMoveJobWithBackoff({
    api: async () => {
      finiteAttempts += 1;
      throw Object.assign(new Error("busy"), { statusCode: 503 });
    },
    jobId: "finite",
    maxRetries: 2,
    signal: new AbortController().signal,
    wait: async () => {}
  }),
  /busy/
);
assert.equal(finiteAttempts, 3, "polling must stop after the configured retry budget");

assert.equal(moveJobCanRetry({ status: "failed", recoverable: true }), true);
assert.equal(moveJobCanRetry({ status: "rolled_back", recoverable: true }), true);
assert.equal(moveJobCanRetry({ status: "blocked", recoverable: true }), false);
assert.equal(moveJobCanRetry({ status: "running", recoverable: true }), false);
assert.equal(moveJobStatusLabel("blocked"), "需人工处理");

const view = { classList: { contains: (name) => name === "active" } };
const visibleRoot = { closest: () => view };
assert.equal(workMoveOpsPanelIsVisible(visibleRoot, { visibilityState: "visible" }), true);
assert.equal(workMoveOpsPanelIsVisible(visibleRoot, { visibilityState: "hidden" }), false);
view.classList.contains = () => false;
assert.equal(workMoveOpsPanelIsVisible(visibleRoot, { visibilityState: "visible" }), false, "background admin views must not auto-poll migration jobs");

let selected = false;
let removed = false;
let appended = null;
let focusRestored = 0;
const copyDocument = {
  activeElement: { focus: () => { focusRestored += 1; } },
  body: { append: (node) => { appended = node; } },
  createElement: () => ({
    hidden: false,
    style: {},
    setAttribute() {},
    focus() {},
    select() { selected = true; },
    remove() { removed = true; }
  }),
  execCommand: (command) => command === "copy" && selected
};
assert.equal(fallbackCopyText("move_fixture", copyDocument), true);
assert.equal(appended.hidden, false, "fallback copy textarea must remain selectable instead of using hidden=true");
assert.equal(appended.style.left, "-10000px");
assert.equal(removed, true);
assert.equal(focusRestored, 1, "fallback copy must restore the previously focused control");

removed = false;
focusRestored = 0;
copyDocument.execCommand = () => { throw new Error("copy denied"); };
assert.throws(() => fallbackCopyText("move_fixture", copyDocument), /copy denied/);
assert.equal(removed, true, "fallback textarea must be removed when execCommand throws");
assert.equal(focusRestored, 1, "focus must also be restored when fallback copying fails");

const statusElement = { value: "failed", addEventListener() {} };
const workIdElement = { value: "", addEventListener() {} };
const deferred = [];
let inFlight = 0;
let maxInFlight = 0;
const controller = createWorkMoveOpsController({
  api: (requestPath) => new Promise((resolve) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    deferred.push({
      requestPath,
      resolve(payload) {
        inFlight -= 1;
        resolve(payload);
      }
    });
  }),
  formatBytes: String,
  formatDateTime: String,
  root: {
    querySelector(selector) {
      if (selector === "[data-work-move-status]") return statusElement;
      if (selector === "[data-work-move-work-id]") return workIdElement;
      return null;
    }
  }
});
const slowLoad = controller.load({ quiet: true });
assert.equal(controller.state.loading, true);
deferred[0].resolve({ jobs: [{ id: "slow", status: "failed" }], summary: { failed: 1 } });
await slowLoad;
assert.deepEqual(controller.state.jobs.map((job) => job.id), ["slow"], "a slow response must render when it completes");

const olderLoad = controller.load({ quiet: true });
statusElement.value = "blocked";
const newerLoad = controller.load({ quiet: true });
assert.match(deferred[1].requestPath, /status=failed/);
assert.equal(deferred.length, 2, "a newer load must queue instead of overlapping the active request");
deferred[1].resolve({ jobs: [{ id: "older", status: "failed" }], summary: { failed: 1 } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(deferred.length, 3, "the latest queued generation must start after the active request completes");
assert.match(deferred[2].requestPath, /status=blocked/);
deferred[2].resolve({ jobs: [{ id: "newer", status: "blocked" }], summary: { blocked: 1 } });
await Promise.all([olderLoad, newerLoad]);
assert.deepEqual(controller.state.jobs.map((job) => job.id), ["newer"], "an older GET must not overwrite a newer filter generation");
assert.equal(maxInFlight, 1, "ops loads must remain single-flight");
assert.equal(controller.state.loading, false);

const playerDom = { title: "旧作品", files: ["old-video"], actions: "old-actions" };
let fixtureWork = { id: "fixture-work", title: "旧作品", videos: [{ id: "old-video" }] };
const completionRequests = [];
const completionFailures = [];
const completionReloader = createCompletedWorkMoveReloader({
  api: async (requestPath) => {
    completionRequests.push(requestPath);
    return { work: { id: "fixture-work", title: "迁移后作品", videos: [{ id: "new-video" }] } };
  },
  getCurrentWork: () => fixtureWork,
  applyWork(work) {
    fixtureWork = work;
    playerDom.title = work.title;
    playerDom.files = work.videos.map((video) => video.id);
    playerDom.actions = "refreshed-actions";
  },
  showReloadFailure: (error) => completionFailures.push(error.message)
});
const sanitizedCompletedJob = { id: "completed-fixture", workId: "fixture-work", status: "completed" };
assert.equal("result" in sanitizedCompletedJob, false, "fixture must use the public sanitized completed-job payload");
assert.equal(await completionReloader.reload(sanitizedCompletedJob), true);
assert.deepEqual(completionRequests, ["/api/works/fixture-work"], "completed moves must reload the work through the safe detail API exactly once");
assert.deepEqual(playerDom, { title: "迁移后作品", files: ["new-video"], actions: "refreshed-actions" }, "safe reload must update the player DOM fixture");
assert.deepEqual(completionFailures, []);

let resolveStaleNavigation;
fixtureWork = { id: "fixture-work", title: "迁移前", videos: [{ id: "before-video" }] };
playerDom.title = "迁移前";
playerDom.files = ["before-video"];
playerDom.actions = "before-actions";
const staleNavigationReloader = createCompletedWorkMoveReloader({
  api: () => new Promise((resolve) => { resolveStaleNavigation = resolve; }),
  getCurrentWork: () => fixtureWork,
  applyWork(work) {
    fixtureWork = work;
    playerDom.title = work.title;
  },
  showReloadFailure: (error) => completionFailures.push(error.message)
});
const staleNavigation = staleNavigationReloader.reload(sanitizedCompletedJob);
fixtureWork = { id: "other-work", title: "已导航作品", videos: [] };
resolveStaleNavigation({ work: { id: "fixture-work", title: "不应覆盖", videos: [] } });
assert.equal(await staleNavigation, false, "a completed move reload must not apply after navigation to another work");
assert.equal(playerDom.title, "迁移前", "stale navigation must leave the visible player DOM untouched");

fixtureWork = { id: "fixture-work", title: "当前作品", videos: [] };
playerDom.title = "当前作品";
const jobResolvers = [];
const currentJobReloader = createCompletedWorkMoveReloader({
  api: () => new Promise((resolve) => jobResolvers.push(resolve)),
  getCurrentWork: () => fixtureWork,
  applyWork(work) { playerDom.title = work.title; },
  showReloadFailure: (error) => completionFailures.push(error.message)
});
const olderJobReload = currentJobReloader.reload({ ...sanitizedCompletedJob, id: "older-job" });
const newerJobReload = currentJobReloader.reload({ ...sanitizedCompletedJob, id: "newer-job" });
jobResolvers[0]({ work: { id: "fixture-work", title: "旧任务结果", videos: [] } });
assert.equal(await olderJobReload, false, "an older completed job must not apply after a newer job becomes current");
assert.equal(playerDom.title, "当前作品", "an older completed job must not overwrite the player DOM fixture");
jobResolvers[1]({ work: { id: "fixture-work", title: "最新任务结果", videos: [] } });
assert.equal(await newerJobReload, true);
assert.equal(playerDom.title, "最新任务结果", "the current completed job must still update the player DOM fixture");

const stableWork = { id: "fixture-work", title: "稳定作品", videos: [{ id: "stable-video" }] };
fixtureWork = stableWork;
playerDom.title = "稳定作品";
playerDom.files = ["stable-video"];
playerDom.actions = "stable-actions";
const failedReload = createCompletedWorkMoveReloader({
  api: async () => { throw new Error("fixture work detail unavailable"); },
  getCurrentWork: () => fixtureWork,
  applyWork() { throw new Error("failed reload must not apply work"); },
  showReloadFailure: () => completionFailures.push("迁移已完成，但刷新作品资料失败。请手动刷新页面后重试。")
});
assert.equal(await failedReload.reload(sanitizedCompletedJob), false);
assert.equal(fixtureWork, stableWork, "a failed safe reload must retain the current work");
assert.deepEqual(playerDom, { title: "稳定作品", files: ["stable-video"], actions: "stable-actions" }, "a failed safe reload must not damage the player DOM fixture");
assert.deepEqual(completionFailures, ["迁移已完成，但刷新作品资料失败。请手动刷新页面后重试。"], "a failed reload must surface one manual-refresh failure without retry polling");

const originalDocument = globalThis.document;
const focusDocument = { activeElement: null };
function fakeNode(tag) {
  const node = {
    tag,
    children: [],
    dataset: {},
    classList: { toggle() {} },
    append(...children) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    },
    addEventListener() {},
    setAttribute() {},
    focus(options) {
      this.focusOptions = options;
      focusDocument.activeElement = this;
    }
  };
  node.contains = (target) => target === node || node.children.some((child) => child.contains?.(target));
  node.querySelectorAll = (selector) => {
    const all = node.children.flatMap((child) => [child, ...child.querySelectorAll?.(selector) || []]);
    return selector === "[data-work-move-job-id]"
      ? all.filter((child) => child.dataset?.workMoveJobId)
      : [];
  };
  Object.defineProperty(node, "innerHTML", {
    set() { node.children = []; }
  });
  return node;
}
focusDocument.createElement = fakeNode;
const focusList = fakeNode("list");
const focusDetail = fakeNode("detail");
globalThis.document = focusDocument;
try {
  const focusController = createWorkMoveOpsController({
    api: async () => ({ jobs: [], summary: {} }),
    formatBytes: String,
    formatDateTime: String,
    root: {
      querySelector(selector) {
        if (selector === "[data-work-move-list]") return focusList;
        if (selector === "[data-work-move-detail]") return focusDetail;
        return null;
      }
    }
  });
  focusController.state.jobs = [{ id: "focus-job", workId: "1", status: "failed", phase: "copying", recoverable: true }];
  focusController.state.selectedId = "focus-job";
  focusController.render();
  const previousCard = focusList.children[0];
  previousCard.focus();
  focusController.render();
  assert.notEqual(focusDocument.activeElement, previousCard, "poll rendering must replace the old card in this fixture");
  assert.equal(focusDocument.activeElement?.dataset?.workMoveJobId, "focus-job");
  assert.deepEqual(focusDocument.activeElement?.focusOptions, { preventScroll: true }, "selection focus must be restored without scrolling");

  const previousRetry = focusDetail.querySelectorAll("[data-work-move-job-id]")
    .find((node) => node.dataset.workMoveAction === "retry");
  previousRetry.focus();
  focusController.render();
  assert.notEqual(focusDocument.activeElement, previousRetry, "poll rendering must replace the old action control in this fixture");
  assert.equal(focusDocument.activeElement?.dataset?.workMoveAction, "retry", "retry focus must survive a DOM rebuild for the same job");
  assert.equal(focusDocument.activeElement?.dataset?.workMoveJobId, "focus-job");
  assert.deepEqual(focusDocument.activeElement?.focusOptions, { preventScroll: true });

  const disappearedRetry = focusDocument.activeElement;
  focusController.state.jobs[0].status = "blocked";
  focusController.render();
  assert.notEqual(focusDocument.activeElement, disappearedRetry);
  assert.equal(focusDocument.activeElement?.dataset?.workMoveAction, "card", "a disappeared action must fall back to its job card");
  assert.equal(focusDocument.activeElement?.dataset?.workMoveJobId, "focus-job");

  const outsideFocus = fakeNode("outside");
  outsideFocus.focus();
  focusController.render();
  assert.equal(focusDocument.activeElement, outsideFocus, "rendering must not steal focus from controls outside the ops panel");
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}

const adminHtml = read("public/admin.html");
const adminSource = read("public/admin.js");
const panelSource = read("public/modules/system/work-move-ops-panel.js");
const playerSource = read("public/js/player-page.js");
assert.match(adminHtml, /id="adminWorkMoveOps"/);
assert.match(adminHtml, /data-work-move-status/);
assert.match(adminHtml, /data-work-move-work-id/);
assert.match(adminHtml, /data-work-move-detail/);
assert.match(adminHtml, /role="status" aria-live="polite" data-work-move-notice/);
assert.match(adminSource, /createWorkMoveOpsController/);
assert.match(adminSource, /workMoveOpsController\.load/);
assert.match(adminSource, /workMoveOpsPanelIsVisible/);
assert.match(adminSource, /scheduleWorkMoveOpsPoll/);
assert.match(adminSource, /await workMoveOpsController\.load/);
assert.match(panelSource, /queuedLoad/);
assert.match(panelSource, /preventScroll: true/);
assert.match(panelSource, /WORK_MOVE|\/api\/work-move-jobs/);
assert.match(panelSource, /复制任务 ID/);
assert.match(panelSource, /人工处理/);
assert.match(panelSource, /aria-pressed/);
assert.doesNotMatch(panelSource, /setAttribute\("aria-hidden"/);
assert.match(playerSource, /fetchWorkMoveJobWithBackoff/);
assert.match(playerSource, /createCompletedWorkMoveReloader/);
assert.match(playerSource, /await applyCompletedMoveJob\(completedJob\)/);
assert.match(playerSource, /if \(await applyCompletedMoveJob\(completed\)\) showNotice\("迁移任务已完成"\)/);
assert.match(playerSource, /showReloadFailure: \(\) => showNotice\("迁移已完成，但刷新作品资料失败。请手动刷新页面后重试。"\)/);
assert.doesNotMatch(playerSource, /completedJob\.result|result\.work/);
assert.doesNotMatch(panelSource, /plan_json|request_json|result_json|oldDir|newDir/);

console.log("work-move-ops-ui: ok (sanitized retry UX, single-flight polling, focus restoration, finite player backoff)");

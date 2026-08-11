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
const copyDocument = {
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

const statusElement = { value: "failed", addEventListener() {} };
const workIdElement = { value: "", addEventListener() {} };
const deferred = [];
const controller = createWorkMoveOpsController({
  api: (requestPath) => new Promise((resolve) => deferred.push({ requestPath, resolve })),
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
const olderLoad = controller.load({ quiet: true });
statusElement.value = "blocked";
const newerLoad = controller.load({ quiet: true });
assert.match(deferred[0].requestPath, /status=failed/);
assert.match(deferred[1].requestPath, /status=blocked/);
deferred[1].resolve({ jobs: [{ id: "newer", status: "blocked" }], summary: { blocked: 1 } });
await newerLoad;
deferred[0].resolve({ jobs: [{ id: "older", status: "failed" }], summary: { failed: 1 } });
await olderLoad;
assert.deepEqual(controller.state.jobs.map((job) => job.id), ["newer"], "an older GET must not overwrite a newer filter generation");

const adminHtml = read("public/admin.html");
const adminSource = read("public/admin.js");
const panelSource = read("public/modules/system/work-move-ops-panel.js");
const playerSource = read("public/js/player-page.js");
assert.match(adminHtml, /id="adminWorkMoveOps"/);
assert.match(adminHtml, /data-work-move-status/);
assert.match(adminHtml, /data-work-move-work-id/);
assert.match(adminHtml, /data-work-move-detail/);
assert.match(adminSource, /createWorkMoveOpsController/);
assert.match(adminSource, /workMoveOpsController\.load/);
assert.match(adminSource, /workMoveOpsPanelIsVisible/);
assert.match(panelSource, /WORK_MOVE|\/api\/work-move-jobs/);
assert.match(panelSource, /复制任务 ID/);
assert.match(panelSource, /人工处理/);
assert.match(playerSource, /fetchWorkMoveJobWithBackoff/);
assert.doesNotMatch(panelSource, /plan_json|request_json|result_json|oldDir|newDir/);

console.log("work-move-ops-ui: ok (server discovery panel, blocked UX, retry visibility, finite poll backoff)");

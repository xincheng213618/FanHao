import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { channelAccountBoundary, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { setAccountOwner } from "../android-client/www/js/account-owner.js";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";

// Full current channel factory/task/summary methods run against synthetic DOM,
// clocks, HTTP and cache boundaries. Accepted mutations are not aborted. This
// never connects to an application service, collector, media or real database.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("android-client/www/platform/content-index/channel-views.js");
const legacy = JSON.parse(read("tests/fixtures/android-manga-task-ownership-before-fix.json"));
assert.equal(createHash("sha256").update(JSON.stringify(legacy.functions)).digest("hex"),
  "2af5416150a877c3387d2dc02856370f8ad88c9780643da889babd72cbe5c7a3");
const legacyDelete = JSON.parse(read("tests/fixtures/android-manga-delete-navigation-before-fix.json"));
assert.equal(createHash("sha256").update(legacyDelete.source).digest("hex"),
  "d2a41b061aaadcfceb98f0a525260d43f7bef0e1a926990f729ce3eb6adcddf0");
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const comic = title => ({ id: "same-comic", title, sourceUrl: "https://synthetic.invalid/comic", chapters: [] });
const running = (title = "old", kind = "update") => ({ id: "same-job", comicId: "same-comic", title, kind, status: "running", progressPercent: 12 });
const complete = title => ({ ...running(title), status: "complete", progressPercent: 100 });
let sequence = 0;

function oldInput() {
  let input = source;
  for (const [name, value] of Object.entries(legacy.functions)) {
    const at = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(input);
    assert(at, name);
    const tail = input.slice(at.index), end = /^  \}/m.exec(tail);
    assert(end, name);
    input = input.slice(0, at.index) + value + input.slice(at.index + end.index + 3);
  }
  return input;
}

function oldDeleteInput() {
  const at = /^  async function deleteMangaComic\(/m.exec(source);
  assert(at);
  const end = /^  \}/m.exec(source.slice(at.index));
  assert(end);
  return source.slice(0, at.index) + legacyDelete.source + source.slice(at.index + end.index + 3);
}

function harness(input = source) {
  const A = `https://synthetic-manga-${++sequence}-a.invalid`, B = `https://synthetic-manga-${sequence}-b.invalid`;
  let activeUrl = A, clockId = 0;
  setAccountOwner(A, "guest", { force: true }); setAccountOwner(B, "guest", { force: true });
  const document = createNavigationFixtureDocument(), proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) Object.defineProperty(proto, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  if (!proto.__mangaPanelDom) {
    const queryAll = proto.querySelectorAll, attribute = proto.getAttribute;
    proto.querySelectorAll = function(selector) {
      const parts = selector.trim().split(/\s+/u);
      if (parts.length < 2 || selector.startsWith(":scope")) return queryAll.call(this, selector);
      return queryAll.call(this, parts.at(-1)).filter(node => {
        let ancestor = node.parentNode;
        for (let index = parts.length - 2; index >= 0; index--) {
          while (ancestor && ancestor !== this.parentNode && !ancestor.matches?.(parts[index])) ancestor = ancestor.parentNode;
          if (!ancestor || ancestor === this.parentNode) return false;
          ancestor = ancestor.parentNode;
        }
        return true;
      });
    };
    proto.getAttribute = function(name) { return name === "hidden" ? (this.hidden ? "" : null) : attribute.call(this, name); };
    Object.defineProperty(proto, "__mangaPanelDom", { value: true });
  }
  document.activeElement = document.body;
  const focusEvents = [];
  const create = document.createElement;
  document.createElement = tag => {
    const node = create(tag), focus = node.focus;
    node.style = { removeProperty() {} };
    if (["INPUT", "BUTTON", "SELECT", "TEXTAREA"].includes(node.tagName)) node.disabled = false;
    if (["INPUT", "TEXTAREA"].includes(node.tagName)) node.readOnly = false;
    node.focus = (...args) => { focusEvents.push(node); focus.apply(node, args); };
    return node;
  };
  const els = Object.fromEntries(["viewContent", "viewTitle", "viewMeta", "viewKicker"].map(key => [key, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const timers = new Map(), network = [], confirmations = [];
  const calls = { fetch: [], writes: [], renders: 0, backs: 0, errors: [] };
  const context = vm.createContext({
    ...channelAccountBoundary, document, console, URL, URLSearchParams, AbortController,
    absoluteUrl, formatBytes, formatDate, formatNumber, formatTime,
    isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }),
    window: { history: { back() {} }, requestAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
      setTimeout(fn, delay) { const id = ++clockId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } },
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    readCachedJson: async () => null, writeCachedJson: async (...args) => { calls.writes.push(args); },
    fetchJson: async (base, path, options = {}) => {
      assert([A, B].includes(base), "Synthetic source only");
      calls.fetch.push({ base, path, options });
      assert(network.length, `Unexpected HTTP ${options.method || "GET"} ${path}`);
      const value = network.shift();
      if (value instanceof Error) throw value;
      return await (value?.promise || value);
    }
  });
  const exposure = /  return \{\r?\n(?=    deactivate:)/;
  assert(exposure.test(input));
  const execute = input.replace(exposure, `  return {
    __tasks: { startMangaAdd, startMangaUpdate, watchMangaAdd, watchMangaUpdate, refreshMangaDetail,
      refreshMangaTaskJobs, ensureMangaTaskMonitor, retryMangaTask, clearFinishedMangaTaskHistory,
      syncMangaLibraryActions, syncMangaTaskManager,
      deleteMangaComic, renderMangaComic, createMangaLibraryActions, createMangaTaskManager,
      state: () => ({ add: mangaAddJob, jobs: mangaTaskJobs, updates: [...mangaUpdateJobs],
        error: mangaTaskError, actionError: mangaTaskActionError, clearing: mangaTaskClearing,
        retrying: [...mangaTaskRetrying], actionErrors: [...mangaTaskActionErrors], monitor: mangaTaskMonitor }),
      seed: (job) => { mergeMangaTaskJob(job); if (job.kind === 'add') updateMangaAddState(job); } },
`).replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(execute, context, { filename: "actual-manga-task-channel.js" });
  const factory = context.createChannelViews({
    els, getActiveUrl: () => activeUrl, getChannelLimit: () => 24, increaseChannelLimit() {},
    openInLibrary() {}, setActiveBottom() {}, renderCurrentView() { calls.renders++; },
    renderCurrentViewPreservingScroll() { calls.renders++; }, goBack() { calls.backs++; },
    requestConfirmation: async () => { const value = confirmations.length ? confirmations.shift() : true; return await (value?.promise || value); }
  });
  const tasks = factory.__tasks;
  return {
    A, B, tasks, factory, els, document, timers, network, confirmations, calls, focusEvents,
    state: () => plain(tasks.state()),
    render(title = "current") { tasks.renderMangaComic(comic(title)); },
    library() { els.viewContent.replaceChildren(tasks.createMangaLibraryActions(), tasks.createMangaTaskManager()); },
    switchSource() { activeUrl = activeUrl === A ? B : A; },
    switchAccount() { setAccountOwner(activeUrl, "account:synthetic", { force: true }); },
    async tick(delay = 1200) {
      const due = [...timers].filter(([, value]) => value.delay === delay);
      for (const [id, value] of due) { timers.delete(id); value.fn(); }
      await flush();
    }
  };
}

const tests = [];
const test = (name, run, control = false) => tests.push({ name, run, control });
const testDelete = (name, run, deleteControl = true) => tests.push({ name, run, deleteControl });
for (const change of ["source", "account"]) {
  const switchOwner = h => change === "source" ? h.switchSource() : h.switchAccount();
  for (const kind of ["add", "update"]) test(`${kind} accepted POST after ${change} switch cannot populate new task state`, async input => {
    const h = harness(input), pending = deferred(); h.render("old"); h.network.push(pending);
    const task = kind === "add" ? h.tasks.startMangaAdd("https://synthetic.invalid/book") : h.tasks.startMangaUpdate(comic("old"));
    await flush(); switchOwner(h); h.render("fresh");
    pending.resolve({ job: running("old", kind) }); await task; await flush();
    assert.equal(h.state().jobs.length, 0, "Late accepted old mutation must not enter the new owner task list");
    assert.equal(h.state().updates.length, 0, "Old task state must not disable the same comic in the new owner");
    assert.equal(h.calls.fetch.length, 1, "No follow-up polling or cancellation request may be sent to the new source");
    assert.equal(h.calls.fetch[0].options.signal, undefined, "Accepted server mutation remains independent of the view lifecycle");
  }, true);
  for (const kind of ["add", "update"]) test(`${kind} poll delay stops before issuing HTTP after ${change} switch`, async input => {
    const h = harness(input); h.render(); const job = running("old", kind); h.tasks.seed(job);
    const poll = kind === "add" ? h.tasks.watchMangaAdd(job.id) : h.tasks.watchMangaUpdate(job.comicId, comic("old"));
    switchOwner(h); h.network.push({ job: complete("old") }, { comic: comic("old") }); await h.tick(); await poll;
    assert.equal(h.calls.fetch.length, 0, "Stale polling delay must not issue a request under the new owner");
  }, true);
  test(`late detail refresh after ${change} switch cannot repaint same-ID page or cache`, async input => {
    const h = harness(input), pending = deferred(); h.render("old"); h.network.push(pending);
    const refresh = h.tasks.refreshMangaDetail("same-comic");
    switchOwner(h); h.render("fresh"); const panel = h.els.viewContent.querySelector(".manga-detail-summary");
    pending.resolve({ comic: comic("old-response"), update: { status: "idle" } }); await refresh;
    assert.equal(h.els.viewContent.querySelector(".manga-detail-summary"), panel, "Same-ID new page must remain mounted");
    assert(h.els.viewContent.textContent.includes("fresh")); assert.equal(h.calls.writes.length, 0);
  }, true);
  for (const reject of [false, true]) test(`late ${reject ? "failed" : "successful"} update poll after ${change} switch cannot alter new same-ID job`, async input => {
    const h = harness(input), pending = deferred(); h.render("old"); h.tasks.seed(running());
    h.network.push(pending); const poll = h.tasks.watchMangaUpdate("same-comic", comic("old")); await h.tick();
    switchOwner(h); h.render("fresh"); h.tasks.seed(running("fresh"));
    if (reject) pending.reject(new Error("Old source unavailable")); else pending.resolve({ job: complete("old") });
    await poll; await flush();
    assert.equal(h.state().updates[0][1].title, "fresh", "Old poll must not overwrite new job state");
    assert.equal(h.state().updates[0][1].status, "running");
    assert(!h.els.viewContent.textContent.includes("Old source unavailable"));
  }, true);
  test(`late add polling success or failure after ${change} switch preserves the replacement add task`, async input => {
    for (const reject of [false, true]) {
      const h = harness(input), pending = deferred(); h.library(); h.tasks.seed(running("old", "add"));
      h.network.push(pending); const poll = h.tasks.watchMangaAdd("same-job"); await h.tick();
      switchOwner(h); h.library(); h.tasks.seed(running("fresh", "add"));
      if (reject) pending.reject(new Error("Old add polling failed")); else pending.resolve({ job: complete("old") });
      await poll;
      assert.equal(h.state().add.title, "fresh", "Late add status cannot change the new owner's same-ID job");
      assert.equal(h.state().add.status, "running"); assert.equal(h.calls.renders, 0);
    }
  }, true);
  test(`late task list after ${change} switch cannot publish old jobs`, async input => {
    const h = harness(input), pending = deferred(); h.library(); h.network.push(pending);
    const read = h.tasks.refreshMangaTaskJobs(); switchOwner(h); h.library();
    pending.resolve({ jobs: [running("old")] }); await read;
    assert.equal(h.state().jobs.length, 0, "Old list response must not populate the new owner state");
  }, true);
}
test("current add polling settles normally and keeps single-flight", async input => {
  const h = harness(input); h.library(); h.network.push({ job: running("current", "add") });
  await h.tasks.startMangaAdd("https://synthetic.invalid/book");
  const first = h.tasks.watchMangaAdd("same-job"), second = h.tasks.watchMangaAdd("same-job");
  assert.equal(first, second);
  h.network.push({ job: complete("current") }); await h.tick(); await first;
  assert.equal(h.state().add.status, "complete"); assert.equal(h.calls.renders, 1);
  assert.equal(h.calls.fetch.length, 2);
  assert(h.calls.fetch.every(call => call.base === h.A && call.options.accountScope?.origin === h.A));
});
test("current update continues after ordinary module deactivation and refreshes its owner", async input => {
  const h = harness(input); h.render(); h.network.push({ job: running("current") });
  await h.tasks.startMangaUpdate(comic("current"));
  const first = h.tasks.watchMangaUpdate("same-comic"), second = h.tasks.watchMangaUpdate("same-comic");
  assert.equal(first, second); h.factory.deactivate();
  h.network.push({ job: complete("current") }, { comic: comic("refreshed"), update: complete("current") });
  await h.tick(); await first;
  assert(h.els.viewContent.textContent.includes("refreshed"));
  assert.equal(h.calls.writes.length, 1); assert.equal(h.calls.writes[0][0], h.A);
  assert.equal(h.calls.writes[0][3].fence.account.origin, h.A);
  assert.equal(h.calls.fetch.length, 3);
});
test("new source same-ID update can start and old poll finalization cannot remove its monitor", async input => {
  const h = harness(input), old = deferred(), fresh = deferred(); h.render("old"); h.tasks.seed(running());
  h.network.push(old); const oldPoll = h.tasks.watchMangaUpdate("same-comic"); await h.tick();
  h.switchSource(); h.render("fresh"); h.network.push({ job: running("fresh") });
  await h.tasks.startMangaUpdate(comic("fresh"));
  const freshPoll = h.tasks.watchMangaUpdate("same-comic");
  h.network.push(fresh); await h.tick(); old.resolve({ job: complete("old") }); await oldPoll;
  assert.equal(h.tasks.watchMangaUpdate("same-comic"), freshPoll, "Old finalization cannot remove a new same-ID poll");
  fresh.resolve({ job: { status: "idle" } }); await freshPoll;
});
test("accepted add survives ordinary navigation, while old controls cannot start writes after source switch", async input => {
  const h = harness(input), pending = deferred(); h.render("old");
  const update = h.els.viewContent.querySelector("[data-manga-update]");
  h.switchSource(); h.render("fresh"); update.click(); await flush();
  assert.equal(h.calls.fetch.length, 0);
  h.network.push(pending); const start = h.tasks.startMangaAdd("https://synthetic.invalid/book");
  h.factory.deactivate(); pending.resolve({ job: running("fresh", "add") }); await start;
  assert.equal(h.state().add.status, "running");
  assert.equal(h.calls.fetch[0].options.signal, undefined);
});
test("clear-history confirmation cannot target a replacement source", async input => {
  const h = harness(input), confirm = deferred(); h.library(); h.tasks.seed(complete("old"));
  h.confirmations.push(confirm); const clear = h.tasks.clearFinishedMangaTaskHistory();
  h.switchSource(); h.library(); confirm.resolve(true); await clear;
  assert.equal(h.calls.fetch.length, 0, "An obsolete confirmation cannot delete the replacement source's history");
}, true);
test("accepted retry success/failure cannot modify replacement owner state", async input => {
  for (const reject of [false, true]) {
    const h = harness(input), pending = deferred(); h.library(); h.network.push(pending);
    const retry = h.tasks.retryMangaTask({ ...running(), status: "failed" });
    h.switchSource(); h.library(); h.tasks.seed(running("fresh"));
    if (reject) pending.reject(new Error("Old retry failed")); else pending.resolve({ job: running("old") });
    await retry;
    assert.equal(h.state().jobs[0].title, "fresh"); assert.equal(h.state().actionErrors.length, 0);
    assert.equal(h.calls.fetch.length, 1);
  }
}, true);
test("accepted history cleanup cannot prune new source jobs or leave its controls busy", async input => {
  for (const reject of [false, true]) {
    const h = harness(input), pending = deferred(); h.library(); h.tasks.seed(complete("old"));
    h.network.push(pending); const clear = h.tasks.clearFinishedMangaTaskHistory(); await flush();
    h.switchSource(); h.library(); h.tasks.seed(complete("fresh"));
    if (reject) pending.reject(new Error("Old clear failed")); else pending.resolve({ ok: true });
    await clear;
    assert.equal(h.state().jobs.length, 1, "Old cleanup must not remove the new owner's finished task");
    assert.equal(h.state().jobs[0].title, "fresh"); assert.equal(h.state().clearing, false);
    assert.equal(h.state().actionError, ""); assert.equal(h.calls.fetch.length, 1);
  }
}, true);
test("delete confirmation and accepted completion cannot act on a replacement source", async input => {
  for (const stage of ["confirmation", "success", "failure"]) {
    const h = harness(input), pending = deferred(); h.render("old");
    if (stage === "confirmation") h.confirmations.push(pending); else h.network.push(pending);
    const remove = h.tasks.deleteMangaComic(comic("old")); await flush();
    h.switchSource(); h.render("fresh"); h.tasks.seed(running("fresh"));
    if (stage === "failure") pending.reject(new Error("Old delete failed")); else pending.resolve(stage === "confirmation" ? true : { ok: true });
    await remove;
    assert.equal(h.calls.fetch.length, stage === "confirmation" ? 0 : 1);
    assert.equal(h.calls.backs, 0, "Old delete completion must not navigate away from the new source");
    assert.equal(h.state().updates[0][1].title, "fresh");
    assert(h.els.viewContent.textContent.includes("fresh"));
  }
}, true);
test("current history cleanup and retry retain their normal results", async input => {
  const h = harness(input); h.library(); h.tasks.seed(complete("finished"));
  h.network.push({ ok: true }, { jobs: [] }); await h.tasks.clearFinishedMangaTaskHistory();
  assert.equal(h.state().jobs.length, 0); assert.equal(h.state().clearing, false);
  h.tasks.seed({ ...running("retry"), status: "failed" });
  h.network.push({ job: running("retry") }, { jobs: [running("retry")] });
  await h.tasks.retryMangaTask({ ...running("retry"), status: "failed" }); await flush();
  assert.equal(h.state().jobs[0].status, "running"); assert.equal(h.state().retrying.length, 0);
  h.els.viewContent.replaceChildren();
});
test("task monitor drops a late old-source failure and its finalizer preserves the new monitor", async input => {
  const h = harness(input), old = deferred(), fresh = deferred(); h.library(); h.network.push(old);
  const oldMonitor = h.tasks.ensureMangaTaskMonitor();
  h.switchSource(); h.library(); h.network.push(fresh); const freshMonitor = h.tasks.ensureMangaTaskMonitor();
  old.reject(new Error("Old monitor failed")); await flush();
  assert.equal(h.tasks.state().monitor, freshMonitor);
  assert.equal(h.state().error, "");
  fresh.resolve({ jobs: [] }); await flush(); h.els.viewContent.replaceChildren();
  await h.tick(12000); await h.tick(6000); await h.tick(2500); await oldMonitor;
});

for (const destination of ["music", "other-comic", "same-comic"]) {
  const navigate = h => {
    h.factory.deactivate();
    if (destination === "music") {
      const current = h.document.createElement("main"); current.textContent = "Current music page";
      h.els.viewContent.replaceChildren(current);
    } else h.tasks.renderMangaComic({ ...comic("fresh-detail"), id: destination });
  };
  testDelete(`delete confirmation after navigating to ${destination} cannot issue DELETE`, async input => {
    const h = harness(input), pending = deferred(); h.render("deleting"); h.confirmations.push(pending);
    h.network.push({ ok: true }); const remove = h.tasks.deleteMangaComic(comic("deleting"));
    await flush(); navigate(h);
    const currentNodes = [...h.els.viewContent.children], text = h.els.viewContent.textContent;
    pending.resolve(true); await remove;
    assert.equal(h.calls.fetch.length, 0, "An old panel's confirmation must not start deletion on the replacement page");
    assert.equal(h.calls.backs, 0); assert.equal(h.els.viewContent.textContent, text);
    assert(currentNodes.every((node, index) => h.els.viewContent.children[index] === node));
  });
  for (const reject of [false, true]) testDelete(`accepted delete ${reject ? "failure" : "success"} after navigating to ${destination} leaves the current page alone`, async input => {
    const h = harness(input), pending = deferred(); h.render("deleting");
    const oldPanel = h.els.viewContent.querySelector(".manga-detail-summary");
    const oldButton = oldPanel.querySelector("[data-manga-delete]");
    h.network.push(pending); const remove = h.tasks.deleteMangaComic(comic("deleting")); await flush();
    assert.equal(h.calls.fetch.length, 1); assert.equal(h.calls.fetch[0].options.method, "DELETE");
    assert.equal(h.calls.fetch[0].options.signal, undefined, "Leaving a view must not abort an accepted deletion");
    assert.equal(oldButton.textContent, "正在删除"); navigate(h);
    const currentNodes = [...h.els.viewContent.children], text = h.els.viewContent.textContent;
    if (reject) pending.reject(new Error("Synthetic old delete failed")); else pending.resolve({ ok: true });
    await remove;
    assert.equal(h.calls.backs, 0, "A retired deletion must not consume the current page's Back action");
    assert.equal(h.els.viewContent.textContent, text);
    assert(currentNodes.every((node, index) => h.els.viewContent.children[index] === node));
    assert.equal(oldPanel.isConnected, false);
    assert.equal(oldButton.textContent, "正在删除", "Retired callbacks must not update detached controls");
    assert(!oldPanel.textContent.includes("Synthetic old delete failed"));
    assert.equal(h.calls.fetch.length, 1, "No cancellation or duplicate deletion request is sent");
  });
}
for (const outcome of ["cancel", "success", "failure"]) testDelete(`current-panel delete ${outcome} retains its normal result`, async input => {
  const h = harness(input); h.render("current");
  const panel = h.els.viewContent.querySelector(".manga-detail-summary"), button = panel.querySelector("[data-manga-delete]");
  if (outcome === "cancel") h.confirmations.push(false);
  else h.network.push(outcome === "failure" ? new Error("Synthetic current delete failed") : { ok: true });
  await h.tasks.deleteMangaComic(comic("current"));
  assert.equal(h.calls.fetch.length, outcome === "cancel" ? 0 : 1);
  assert.equal(h.calls.backs, outcome === "success" ? 1 : 0);
  if (outcome === "failure") {
    assert.equal(button.disabled, false); assert.equal(button.textContent, "删除漫画");
    assert(panel.textContent.includes("Synthetic current delete failed"));
  }
}, false);
testDelete("missing or mismatched current manga panels cannot start deletion", async input => {
  for (const mounted of [false, true]) {
    const h = harness(input);
    if (mounted) h.tasks.renderMangaComic({ ...comic("other"), id: "other-comic" });
    h.network.push({ ok: true }); await h.tasks.deleteMangaComic(comic("wrong-target"));
    assert.equal(h.calls.fetch.length, 0, "Deletion must belong to the actual mounted comic");
    assert.equal(h.calls.backs, 0);
  }
});

// These additions exercise the current factory's real user/sync paths. The
// original 41 scenarios and their 32 frozen ownership controls stay unchanged.
const focusTests = [];
const focusTest = (name, run) => focusTests.push({ name, run });
const libraryPanel = h => h.els.viewContent.querySelector(".manga-library-actions");
const addToggle = h => libraryPanel(h).querySelector("[data-manga-add-toggle]");
const manager = h => h.els.viewContent.querySelector("[data-manga-task-manager]");
const managerAction = (h, action, jobId = "") => {
  const parent = jobId ? manager(h).querySelector(`[data-manga-task-id="${jobId}"]`) : manager(h);
  return parent?.querySelector(`[data-manga-task-action="${action}"]`);
};
const panelJobs = () => [
  { ...running("采集中"), id: "panel-running", comicId: "running-comic", comicAvailable: true },
  { ...running("失败记录"), id: "panel-failed", comicId: "failed-comic", comicAvailable: true, status: "failed" },
  { ...complete("已完成"), id: "panel-complete", comicId: "complete-comic", comicAvailable: true }
];
async function setupManager(input) {
  const h = harness(input); h.library(); h.network.push({ jobs: panelJobs() });
  await h.tasks.refreshMangaTaskJobs();
  assert.equal(manager(h).hidden, false);
  return h;
}
async function openHistory(h) {
  h.network.push({ jobs: panelJobs() });
  h.els.viewContent.querySelector(".manga-task-history-toggle").click();
  await flush();
  assert(managerAction(h, "clear"), "Real history toggle exposes finished-record actions");
}

focusTest("user add toggle names and focuses its new input, then its new trigger", async input => {
  const h = harness(input); h.library();
  const previous = addToggle(h); previous.focus(); previous.click();
  const field = libraryPanel(h).querySelector("input"), expanded = addToggle(h);
  assert(field); assert.equal(field.getAttribute("aria-label"), "漫画作品链接");
  assert(h.document.activeElement === field, "Explicit opening focuses the new mounted input");
  assert.equal(previous.isConnected, false);
  assert.equal(expanded.getAttribute("aria-expanded"), "true");
  assert.equal(libraryPanel(h).querySelector("form").id, expanded.getAttribute("aria-controls"));
  field.value = "https://synthetic.invalid/draft";
  field.dispatchEvent({ type: "input", target: field });
  expanded.click();
  assert(h.document.activeElement === addToggle(h), "Explicit closing focuses the replacement trigger");
  assert.equal(addToggle(h).getAttribute("aria-expanded"), "false");
  assert.equal(libraryPanel(h).querySelector("form"), null);
  addToggle(h).click(); assert.equal(libraryPanel(h).querySelector("input").value, field.value);
  assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.renders, 0); assert.equal(h.calls.backs, 0);
});

focusTest("replaced, detached, source and account retired add toggles cannot alter or focus the current panel", async input => {
  for (const change of ["replaced", "detached", "source", "account"]) {
    const h = harness(input); h.library(); const old = addToggle(h), oldPanel = libraryPanel(h);
    if (change === "replaced") h.library();
    else if (change === "detached") oldPanel.remove();
    else if (change === "source") h.switchSource();
    else h.switchAccount();
    const outside = h.document.createElement("input"); h.document.body.append(outside); outside.focus();
    const before = h.focusEvents.length, current = libraryPanel(h);
    old.click();
    assert.equal(h.focusEvents.length, before, `${change}: a retired toggle must not attempt focus`);
    assert(h.document.activeElement === outside);
    assert(libraryPanel(h) === current, `${change}: a retired toggle cannot replace the current panel`);
    if (change === "detached") h.library();
    assert.equal(libraryPanel(h).querySelector("form"), null, `${change}: old controls cannot open new state`);
    assert.equal(h.calls.fetch.length, 0);
  }
});

focusTest("accepted add startup and response sync do not take focus from an external input", async input => {
  const h = harness(input); h.library(); addToggle(h).click();
  const outside = h.document.createElement("input"); h.document.body.append(outside); outside.focus();
  const before = h.focusEvents.length, pending = deferred(); h.network.push(pending);
  const add = h.tasks.startMangaAdd("https://synthetic.invalid/book"); await flush();
  assert(h.document.activeElement === outside);
  pending.resolve({ job: { ...running("采集中", "add"), comicAvailable: false } }); await add;
  assert(h.document.activeElement === outside); assert.equal(h.focusEvents.length, before);
  assert.equal(h.calls.fetch.length, 1); assert.equal(h.calls.fetch[0].options.method, "POST");
  assert.equal(h.calls.fetch[0].options.signal, undefined, "Accepted add remains a background write");
  assert.equal(libraryPanel(h).querySelector("input").readOnly, true);
  assert.equal(libraryPanel(h).querySelector("input").disabled, false);
  assert.equal(libraryPanel(h).querySelector("form").querySelector("button").disabled, true);
});

focusTest("manager swaps preserve exact open, retry, history, clear and connect action focus", async input => {
  const h = await setupManager(input);
  for (const [action, jobId] of [["open", "panel-running"], ["retry", "panel-failed"], ["history", ""]]) {
    const previous = managerAction(h, action, jobId); assert(previous); previous.focus();
    h.network.push({ jobs: panelJobs() }); await h.tasks.refreshMangaTaskJobs();
    assert.equal(previous.isConnected, false);
    assert(h.document.activeElement === managerAction(h, action, jobId), `${action}: focus follows semantic identity`);
  }
  await openHistory(h);
  const clear = managerAction(h, "clear"); clear.focus();
  h.network.push({ jobs: panelJobs() }); await h.tasks.refreshMangaTaskJobs();
  assert.equal(clear.isConnected, false); assert(h.document.activeElement === managerAction(h, "clear"));
  const offline = await setupManager(input); offline.network.push(new Error("Synthetic offline"));
  void offline.tasks.ensureMangaTaskMonitor(); await flush();
  const connect = managerAction(offline, "connect"); assert(connect); connect.focus();
  assert.equal(offline.tasks.syncMangaTaskManager(), true);
  assert.equal(connect.isConnected, false); assert(offline.document.activeElement === managerAction(offline, "connect"));
});

focusTest("a held manager GET does not reclaim focus after the user moves outside", async input => {
  const h = await setupManager(input), previous = managerAction(h, "open", "panel-running"); previous.focus();
  const pending = deferred(); h.network.push(pending); const refresh = h.tasks.refreshMangaTaskJobs();
  const outside = h.document.createElement("input"); h.document.body.append(outside); outside.focus();
  const before = h.focusEvents.length; pending.resolve({ jobs: panelJobs() }); await refresh;
  assert.equal(previous.isConnected, false); assert(h.document.activeElement === outside);
  assert.equal(h.focusEvents.length, before, "Background sync must not schedule or attempt replacement focus");
});

focusTest("removed job focus falls back to stable history instead of the same action on another job", async input => {
  const h = await setupManager(input); managerAction(h, "open", "panel-running").focus();
  h.network.push({ jobs: panelJobs().filter(job => job.id !== "panel-running") }); await h.tasks.refreshMangaTaskJobs();
  assert.equal(managerAction(h, "open", "panel-running"), undefined);
  assert(managerAction(h, "open", "panel-failed"));
  assert(h.document.activeElement === h.els.viewContent.querySelector(".manga-task-history-toggle"), "A different job must never inherit old focus");
});

focusTest("disabled clear action falls back while its accepted deletion continues", async input => {
  const h = await setupManager(input); await openHistory(h); managerAction(h, "clear").focus();
  const pending = deferred(); h.network.push(pending, { jobs: [panelJobs()[0]] });
  const clearing = h.tasks.clearFinishedMangaTaskHistory(); await flush();
  assert.equal(h.state().clearing, true); assert.equal(managerAction(h, "clear").disabled, true);
  assert(h.document.activeElement === h.els.viewContent.querySelector(".manga-task-history-toggle"));
  const request = h.calls.fetch.find(call => call.options.method === "DELETE"); assert(request);
  assert.equal(request.options.signal, undefined);
  pending.resolve({ ok: true }); await clearing; assert.equal(h.state().clearing, false);
});

focusTest("connected old-source and old-account manager panels do not restore focus", async input => {
  for (const change of ["source", "account"]) {
    const h = await setupManager(input), previous = manager(h);
    managerAction(h, "open", "panel-running").focus();
    if (change === "source") h.switchSource(); else h.switchAccount();
    const before = h.focusEvents.length; assert.equal(h.tasks.syncMangaTaskManager(), true);
    assert(manager(h) !== previous); assert.equal(previous.isConnected, false);
    assert.equal(h.focusEvents.length, before, `${change}: invalid owner cannot restore into a new manager`);
  }
});

function mutateFocusMethod(name, mutate) {
  const at = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source); assert(at, name);
  const end = /^  \}/m.exec(source.slice(at.index)); assert(end, name);
  const original = source.slice(at.index, at.index + end.index + 3), changed = mutate(original);
  assert.notEqual(changed, original, `${name}: negative control must alter actual source`);
  return source.slice(0, at.index) + changed + source.slice(at.index + end.index + 3);
}
const focusControls = [
  { name: "user-toggle focus disconnected", scenario: 0, input: () => mutateFocusMethod("createMangaLibraryActions", text => text.replace("target?.focus({ preventScroll: true });", "void target;")) },
  { name: "retired-toggle mounted checks removed", scenario: 1, input: () => mutateFocusMethod("isMangaLibraryActionViewCurrent", text => text.replace("view.panel.isConnected", "true").replace('els.viewContent.querySelector(".manga-library-actions") === view.panel', "true")) },
  { name: "manager replacement focus disabled", scenario: 3, input: () => mutateFocusMethod("syncMangaTaskManager", text => text.replace("if (focused && isMangaTaskScopeCurrent(scope)", "if (false && focused && isMangaTaskScopeCurrent(scope)")) },
  { name: "manager job identity omitted", scenario: 5, input: () => mutateFocusMethod("syncMangaTaskManager", text => text.replace('&& (button.closest("[data-manga-task-id]")?.dataset.mangaTaskId || "") === taskId', "&& true")) }
];

const recoveryTests = [];
const recoveryTest = (name, run) => recoveryTests.push({ name, run });
function addControls(h) {
  const panel = libraryPanel(h), form = panel?.querySelector("form");
  return { panel, form, field: form?.querySelector("input"), submit: form?.querySelector("button") };
}
function editAdd(field, value) {
  field.value = value;
  field.dispatchEvent({ type: "input", target: field, bubbles: true });
}
function submitAdd(h) {
  const form = addControls(h).form;
  assert(form, "The actual mounted form is submitted");
  const event = { type: "submit", target: form, bubbles: true, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; } };
  form.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}
function assertSameAddControls(h, before, reason) {
  const after = addControls(h);
  for (const key of ["panel", "form", "field", "submit"]) assert(after[key] === before[key], `${reason}: keep ${key} identity`);
  return after;
}
function assertLinkedAddError(h, controls, expected) {
  const error = controls.panel.querySelector(".manga-operation-error");
  assert(error?.id, "Inline failure has a stable nonempty ID");
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(controls.field.getAttribute("aria-describedby"), error.id);
  assert.notEqual(controls.field.getAttribute("aria-invalid"), "true", "A server failure does not prove the URL invalid");
  assert(error.textContent.includes(expected));
  assert.equal(error.isConnected, true);
  return error;
}

recoveryTest("actual submit keeps form nodes, focuses the readable input and blocks duplicate pending writes", async input => {
  const h = harness(input); h.library(); addToggle(h).click();
  const before = addControls(h), pending = deferred();
  editAdd(before.field, "https://synthetic.invalid/readonly-book"); before.submit.focus();
  h.network.push(pending); submitAdd(h);
  assertSameAddControls(h, before, "Starting collection");
  assert(h.document.activeElement === before.field, "Explicit submit synchronously focuses the retained input");
  assert.equal(before.field.readOnly, true); assert.equal(before.field.disabled, false); assert.equal(before.submit.disabled, true);
  assert.equal(before.field.value, "https://synthetic.invalid/readonly-book");
  submitAdd(h); await flush(); assert.equal(h.calls.fetch.length, 1, "A pending form cannot POST twice");
  assert.equal(h.calls.fetch[0].options.signal, undefined);
  pending.resolve({ job: { ...running("collecting", "add"), comicAvailable: false } }); await flush();
  assertSameAddControls(h, before, "Accepted running response");
  assert(h.document.activeElement === before.field);
  assert.equal(before.field.readOnly, true); assert.equal(before.submit.disabled, true);
});

recoveryTest("server failure and retry retain controls and stable accessible error association until editing", async input => {
  const h = harness(input); h.library(); addToggle(h).click(); const before = addControls(h);
  editAdd(before.field, "https://synthetic.invalid/failed-book");
  for (const message of ["Synthetic HTTP 503", "Synthetic retry 503"]) {
    const pending = deferred(); h.network.push(pending); before.submit.focus(); submitAdd(h);
    pending.reject(new Error(message)); await flush();
    assertSameAddControls(h, before, message);
    assert(h.document.activeElement === before.field);
    assert.equal(before.field.readOnly, false); assert.equal(before.field.disabled, false); assert.equal(before.submit.disabled, false);
    assert.equal(before.field.value, "https://synthetic.invalid/failed-book");
    assert.equal(before.submit.textContent, "重新采集");
    const error = assertLinkedAddError(h, before, message);
    if (message === "Synthetic HTTP 503") h.firstErrorId = error.id;
    else assert.equal(error.id, h.firstErrorId, "Retry failures reuse the same field-error identity");
  }
  editAdd(before.field, "https://synthetic.invalid/corrected-book");
  assertSameAddControls(h, before, "Editing the failed URL");
  assert.equal(before.panel.querySelector(".manga-operation-error"), null);
  assert.equal(before.field.getAttribute("aria-describedby"), null);
  assert.notEqual(before.field.getAttribute("aria-invalid"), "true");
  assert.equal(h.calls.fetch.length, 2); assert.equal(h.calls.writes.length, 0);
});

recoveryTest("a delayed submission failure never takes the user's newer external focus", async input => {
  const h = harness(input); h.library(); addToggle(h).click(); const before = addControls(h), pending = deferred();
  editAdd(before.field, "https://synthetic.invalid/held-book"); h.network.push(pending); submitAdd(h);
  const outside = h.document.createElement("input"); h.document.body.append(outside); outside.focus();
  const count = h.focusEvents.length; pending.reject(new Error("Synthetic delayed 503")); await flush();
  assertSameAddControls(h, before, "Delayed failure"); assertLinkedAddError(h, before, "Synthetic delayed 503");
  assert(h.document.activeElement === outside); assert.equal(h.focusEvents.length, count);
});

recoveryTest("old source and account submit responses cannot publish errors or focus into a fresh form", async input => {
  for (const owner of ["source", "account"]) for (const failed of [false, true]) {
    const h = harness(input); h.library(); addToggle(h).click(); const old = addControls(h), pending = deferred();
    editAdd(old.field, "https://synthetic.invalid/old-owner"); h.network.push(pending); submitAdd(h);
    if (owner === "source") h.switchSource(); else h.switchAccount();
    h.library(); addToggle(h).click(); const fresh = addControls(h);
    editAdd(fresh.field, "https://synthetic.invalid/fresh-draft"); fresh.field.focus(); const count = h.focusEvents.length;
    if (failed) pending.reject(new Error("Synthetic retired error"));
    else pending.resolve({ job: { ...running("retired", "add"), comicAvailable: false } });
    await flush();
    assertSameAddControls(h, fresh, `${owner} replacement`);
    assert(h.document.activeElement === fresh.field); assert.equal(h.focusEvents.length, count);
    assert.equal(fresh.field.value, "https://synthetic.invalid/fresh-draft");
    assert.equal(fresh.field.readOnly, false); assert.equal(fresh.submit.disabled, false);
    assert.equal(fresh.panel.querySelector(".manga-operation-error"), null);
    assert.equal(fresh.field.getAttribute("aria-describedby"), null);
    assert.equal(h.calls.fetch.length, 1); assert.equal(h.calls.fetch[0].options.signal, undefined);
  }
});

recoveryTest("accepted submit callbacks after leaving the form cannot publish focus into another route", async input => {
  for (const failed of [false, true]) {
    const h = harness(input); h.library(); addToggle(h).click(); const old = addControls(h), pending = deferred();
    editAdd(old.field, "https://synthetic.invalid/old-route"); h.network.push(pending); submitAdd(h);
    h.render("Another manga page"); const current = [...h.els.viewContent.children];
    const outside = h.document.createElement("button"); h.document.body.append(outside); outside.focus(); const count = h.focusEvents.length;
    if (failed) pending.reject(new Error("Synthetic retired route error"));
    else pending.resolve({ job: { ...running("accepted", "add"), comicAvailable: false } });
    await flush();
    assert(h.document.activeElement === outside); assert.equal(h.focusEvents.length, count);
    assert.equal(old.panel.isConnected, false);
    assert(current.every((node, index) => h.els.viewContent.children[index] === node));
    assert(!h.els.viewContent.textContent.includes("Synthetic retired route error"));
    assert.equal(h.calls.fetch.length, 1); assert.equal(h.calls.fetch[0].options.signal, undefined);
  }
});

recoveryTest("background add poll failure patches the retained form without automatic focus", async input => {
  const h = harness(input); h.library(); addToggle(h).click(); const before = addControls(h);
  editAdd(before.field, "https://synthetic.invalid/poll-book");
  h.network.push({ job: { ...running("polling", "add"), comicAvailable: false } }); submitAdd(h); await flush();
  const poll = h.tasks.watchMangaAdd("same-job"), outside = h.document.createElement("input");
  h.document.body.append(outside); outside.focus(); const count = h.focusEvents.length;
  h.network.push(new Error("Synthetic poll 503")); await h.tick(); await poll;
  assertSameAddControls(h, before, "Background poll failure"); assertLinkedAddError(h, before, "Synthetic poll 503");
  assert(h.document.activeElement === outside); assert.equal(h.focusEvents.length, count);
  assert.equal(before.field.readOnly, false); assert.equal(before.submit.disabled, false);
  assert.equal(h.calls.fetch.length, 2);
});

// The host render callback is an observed boundary in this VM. Full-library
// refresh completion/final focus is verified by the real browser counterpart.
recoveryTest("local completion sync hands internal focus to the replacement toggle and leaves external focus alone", async input => {
  for (const internal of [true, false]) {
    const h = harness(input); h.library(); addToggle(h).click(); const before = addControls(h);
    editAdd(before.field, "https://synthetic.invalid/completed-book");
    h.network.push({ job: { ...running("finishing", "add"), comicAvailable: false } }); submitAdd(h); await flush();
    const outside = h.document.createElement("input"); h.document.body.append(outside);
    if (internal) before.field.focus(); else outside.focus();
    const count = h.focusEvents.length, poll = h.tasks.watchMangaAdd("same-job");
    h.network.push({ job: { ...complete("finished"), kind: "add", comicAvailable: false } }); await h.tick(); await poll;
    assert.equal(addControls(h).form, null); assert.equal(before.panel.isConnected, false);
    assert(h.document.activeElement === (internal ? addToggle(h) : outside));
    if (!internal) assert.equal(h.focusEvents.length, count, "Completion cannot reclaim unrelated focus");
    assert.equal(h.calls.fetch.length, 2);
  }
});

recoveryTest("retired forms cannot start another write after replacement or owner change", async input => {
  for (const change of ["replacement", "source", "account"]) {
    const h = harness(input); h.library(); addToggle(h).click(); const old = addControls(h);
    editAdd(old.field, "https://synthetic.invalid/retired-form");
    if (change === "source") h.switchSource(); else if (change === "account") h.switchAccount();
    h.library(); if (!addControls(h).form) addToggle(h).click();
    const fresh = addControls(h); fresh.field.focus(); const count = h.focusEvents.length;
    old.form.dispatchEvent({ type: "submit", target: old.form, bubbles: true, preventDefault() {} }); await flush();
    assert.equal(h.calls.fetch.length, 0, `${change}: detached form cannot submit under the current route`);
    assertSameAddControls(h, fresh, change); assert(h.document.activeElement === fresh.field); assert.equal(h.focusEvents.length, count);
  }
});

const recoveryControls = [
  { name: "same-shape patch disabled", scenario: 0, input: () => mutateFocusMethod("syncMangaLibraryActions", text => text.replace("if (view.open === mangaAddOpen)", "if (false && view.open === mangaAddOpen)")) },
  { name: "explicit submit focus disconnected", scenario: 0, input: () => mutateFocusMethod("createMangaLibraryActions", text => text.replace("input.focus({ preventScroll: true });", "void input;")) },
  { name: "failure field association disconnected", scenario: 1, input: () => mutateFocusMethod("patchMangaLibraryActions", text => text.replace('input.setAttribute("aria-describedby", view.error.id);', "void view.error.id;")) },
  { name: "background patch unconditionally takes focus", scenario: 2, input: () => mutateFocusMethod("patchMangaLibraryActions", text => text.replace("if (!input) return;", "if (!input) return;\n    input.focus({ preventScroll: true });")) }
];

if (process.argv.includes("--reproduce-before-fix")) {
  for (const { name, run, control, deleteControl } of tests) if (control || deleteControl) {
    await assert.rejects(() => run(deleteControl ? oldDeleteInput() : oldInput()), { name: "AssertionError" }, name);
    console.log(`REPRODUCED old ownership defect: ${name}`);
  }
} else {
  for (const { name, run } of tests) { await run(source); console.log(`manga-task-requests: ${name}: ok`); }
  let controls = 0;
  for (const { name, run, control, deleteControl } of tests) if (control || deleteControl) {
    await assert.rejects(() => run(deleteControl ? oldDeleteInput() : oldInput()), { name: "AssertionError" }, `Frozen old methods must fail: ${name}`); controls++;
  }
  console.log(`android-manga-task-requests: ${tests.length} scenarios and ${controls} actual pre-fix controls: ok`);
  for (const { name, run } of focusTests) { await run(source); console.log(`manga-panel-focus: ${name}: ok`); }
  for (const { name, scenario, input } of focusControls) {
    await assert.rejects(() => focusTests[scenario].run(input()), { name: "AssertionError" }, `Focused control must fail: ${name}`);
    console.log(`REPRODUCED focused regression: ${name}`);
  }
  console.log(`android-manga-panel-focus: ${focusTests.length} scenarios and ${focusControls.length} focused controls: ok`);
  for (const { name, run } of recoveryTests) { await run(source); console.log(`manga-add-recovery: ${name}: ok`); }
  for (const { name, scenario, input } of recoveryControls) {
    await assert.rejects(() => recoveryTests[scenario].run(input()), { name: "AssertionError" }, `Recovery control must fail: ${name}`);
    console.log(`REPRODUCED recovery regression: ${name}`);
  }
  console.log(`android-manga-add-recovery: ${recoveryTests.length} scenarios and ${recoveryControls.length} focused controls: ok`);
}

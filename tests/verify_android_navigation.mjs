import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "android-client/www/app.js"), "utf8");

// Exercise the real shell functions without bootstrapping unrelated modules,
// network requests or device plugins. Only the renderer and DOM are fixtures.
function appFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Android shell must define ${name}`);
  const remaining = source.slice(start);
  const next = /\r?\n(?:async )?function\s/.exec(remaining);
  assert.ok(next, `Android shell function ${name} must have a clear boundary`);
  return remaining.slice(0, next.index);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function shell() {
  const frames = [];
  const timers = [];
  const elements = new Map();
  const context = {
    AbortController,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    events: [],
    currentView: "channel",
    currentViewParams: { mode: "photo", category: "first" },
    viewRenderToken: 0,
    activeViewController: null,
    pendingScrollRestore: null,
    scrollRestoreIntent: 0,
    library: {},
    task: undefined,
    els: new Proxy({}, {
      get(_target, name) {
        if (!elements.has(name)) elements.set(name, { hidden: false, querySelector: () => null });
        return elements.get(name);
      }
    }),
    window: {
      scrollY: 0,
      innerHeight: 820,
      dispatchEvent(event) { context.events.push(event); context.onEvent?.(event); return true; },
      scrollTo({ top }) { context.window.scrollY = top; },
      setTimeout(callback) { timers.push(callback); return timers.length; }
    },
    document: { documentElement: { scrollHeight: 4000, scrollTop: 0 } },
    requestAnimationFrame: (callback) => frames.push(callback),
    syncContentPanelMode() {},
    isRootNavigationView: () => true,
    syncSearchSurface() {},
    renderRouteLoadingState() {},
    setActiveBottom() {},
    finishAppStartup() {},
    currentViewNeedsLibrary: () => false,
    showHome(options = {}) {
      context.invalidateViewRender();
      context.currentView = "home";
      context.currentViewParams = {};
      context.queueScrollRestore(options.restoreScrollY ?? 0);
    },
    androidModuleRegistry: {
      deactivateExcept() {},
      render: () => context.task
    }
  };
  vm.runInNewContext([
    "invalidateViewRender", "beginViewRender", "sameViewParams", "currentScrollY",
    "queueScrollRestore", "restorePendingScroll", "cancelPendingScrollRestore", "cancelScrollRestoreFromKeydown", "renderCurrentView"
  ].map(appFunction).join("\n"), context, { filename: "android-app-navigation-fixture.js" });
  return { context, frames, timers };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("reader lifecycle is notified before route layout and content are replaced", () => {
  const { context } = shell();
  context.els.viewContent.innerHTML = "old-reader-content";
  let oldLayoutObserved = false;
  context.onEvent = (event) => {
    assert.equal(event.type, "fanhaoViewWillRender");
    assert.equal(context.els.viewContent.innerHTML, "old-reader-content");
    assert.equal(event.detail.view, context.currentView);
    oldLayoutObserved = true;
  };
  context.syncContentPanelMode = () => assert.equal(oldLayoutObserved, true);
  context.renderCurrentView();
  assert.equal(context.events.length, 1);
});

test("current async render restores its requested position once content arrives", async () => {
  const { context } = shell();
  const request = deferred();
  context.task = request.promise;
  assert.equal(context.renderCurrentView({ restoreScrollY: 840 }), request.promise);
  assert.equal(context.pendingScrollRestore, null);
  request.resolve();
  await flushPromises();
  assert.equal(context.pendingScrollRestore.target, 840);
  assert.equal(context.pendingScrollRestore.token, context.viewRenderToken);
});

for (const outcome of ["success", "failure"]) {
  test(`late ${outcome} from another page must not restore an obsolete scroll position`, async () => {
    const { context } = shell();
    const request = deferred();
    context.task = request.promise;
    context.renderCurrentView({ restoreScrollY: 840 }).catch(() => {});
    context.currentView = "music";
    context.currentViewParams = {};
    context.task = undefined;
    context.renderCurrentView({ restoreScrollY: 0 });
    context.queueScrollRestore(0);
    const nextRestore = context.pendingScrollRestore;
    if (outcome === "success") request.resolve();
    else request.reject(new Error("obsolete request failed"));
    await flushPromises();
    assert.equal(context.pendingScrollRestore, nextRestore, "old completion must not replace the new page's restoration");
  });
}

test("a newer render of the same route owns scroll restoration", async () => {
  const { context } = shell();
  const oldRequest = deferred();
  const newRequest = deferred();
  context.task = oldRequest.promise;
  context.renderCurrentView({ restoreScrollY: 840 });
  context.task = newRequest.promise;
  context.renderCurrentView({ restoreScrollY: 260 });
  newRequest.resolve();
  await flushPromises();
  const latestRestore = context.pendingScrollRestore;
  oldRequest.resolve();
  await flushPromises();
  assert.equal(context.pendingScrollRestore, latestRestore);
  assert.equal(context.pendingScrollRestore.target, 260);
});

test("changed route parameters invalidate a pending restoration", async () => {
  const { context } = shell();
  const request = deferred();
  context.task = request.promise;
  context.renderCurrentView({ restoreScrollY: 840 });
  context.currentViewParams = { mode: "photo", category: "second" };
  request.resolve();
  await flushPromises();
  assert.equal(context.pendingScrollRestore, null);
});

test("an aborted render cannot schedule scroll restoration", async () => {
  const { context } = shell();
  const request = deferred();
  context.task = request.promise;
  context.renderCurrentView({ restoreScrollY: 840 });
  context.activeViewController.abort();
  request.resolve();
  await flushPromises();
  assert.equal(context.pendingScrollRestore, null);
});

test("user interaction while content loads must not be undone on completion", async () => {
  const { context } = shell();
  const request = deferred();
  context.task = request.promise;
  context.renderCurrentView({ restoreScrollY: 840 });
  context.queueScrollRestore(840);
  context.cancelPendingScrollRestore();
  context.window.scrollY = 150;
  request.resolve();
  await flushPromises();
  assert.equal(context.pendingScrollRestore, null, "a completed request must not re-arm canceled restoration");
  assert.equal(context.window.scrollY, 150);
});

test("a new navigation may restore after an earlier user cancellation", async () => {
  const { context } = shell();
  context.cancelPendingScrollRestore();
  const request = deferred();
  context.task = request.promise;
  context.renderCurrentView({ restoreScrollY: 420 });
  request.resolve();
  await flushPromises();
  assert.equal(context.pendingScrollRestore.target, 420);
});

test("failed current render is observed without a detached rejecting finally promise", async () => {
  const { context } = shell();
  const request = deferred();
  context.task = request.promise;
  const returned = context.renderCurrentView({ restoreScrollY: 420 });
  request.reject(new Error("current request failed"));
  await assert.rejects(returned, /current request failed/);
  await flushPromises();
});

test("home restoration stays synchronous and does not re-arm after user input", async () => {
  const { context } = shell();
  context.currentView = "home";
  context.currentViewParams = {};
  context.renderCurrentView({ restoreScrollY: 300 });
  assert.equal(context.pendingScrollRestore.target, 300);
  context.cancelPendingScrollRestore();
  await flushPromises();
  assert.equal(context.pendingScrollRestore, null);
});

test("canceling a queued restoration makes its animation frame inert", () => {
  const { context, frames } = shell();
  context.queueScrollRestore(420);
  context.cancelPendingScrollRestore();
  context.window.scrollY = 160;
  frames.shift()();
  assert.equal(context.window.scrollY, 160);
});

test("keyboard scrolling cancels late restoration and is wired to the real shell", async () => {
  assert.match(source, /window\.addEventListener\("keydown", cancelScrollRestoreFromKeydown\)/);
  for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]) {
    const { context } = shell();
    const request = deferred();
    context.task = request.promise;
    context.renderCurrentView({ restoreScrollY: 420 });
    context.cancelScrollRestoreFromKeydown({ key, target: { closest: () => null } });
    request.resolve();
    await flushPromises();
    assert.equal(context.pendingScrollRestore, null, `${JSON.stringify(key)} must preserve the user's new scroll intent`);
  }
});

test("typing, modified keys and handled events do not cancel restoration", () => {
  for (const event of [
    { key: "a" }, { key: "PageDown", defaultPrevented: true },
    { key: "Home", altKey: true }, { key: "End", ctrlKey: true }, { key: "ArrowDown", metaKey: true },
    { key: " ", target: { isContentEditable: true } },
    { key: "ArrowDown", target: { closest: () => ({ tagName: "SELECT" }) } }
  ]) {
    const { context } = shell();
    context.queueScrollRestore(420);
    const restore = context.pendingScrollRestore;
    context.cancelScrollRestoreFromKeydown(event);
    assert.equal(context.pendingScrollRestore, restore);
    assert.equal(context.scrollRestoreIntent, 0);
  }
});

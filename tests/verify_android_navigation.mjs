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
  const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source)?.index ?? -1;
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
    modePickerRetirements: 0,
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
    // Menu behavior belongs to the actual gallery shell harness; this isolated
    // navigation fixture observes only its lifecycle boundary.
    retireModePickerSession() { context.modePickerRetirements += 1; },
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
    "invalidateViewRender", "beginViewRender", "sameViewParams", "currentScrollY", "requestedViewScrollY",
    "queueScrollRestore", "restorePendingScroll", "cancelPendingScrollRestore", "cancelScrollRestoreFromKeydown", "renderCurrentView",
    "renderCurrentViewPreservingScroll", "refreshLibraryDependentView", "renderModuleUnavailable", "createLoadingRow",
    "publishAndroidModules", "createChannelViewsFacade", "bootApp"
  ].map(appFunction).join("\n"), context, { filename: "android-app-navigation-fixture.js" });
  return { context, frames, timers };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function startBoot(context) {
  const progress = deferred();
  const finalRegistry = deferred();
  Object.assign(context, {
    androidModuleRegistry: null,
    accountReloadPending: false,
    initialSettingsRequested: false,
    CLIENT_VERSION: "fixture",
    activeUrl: "http://127.0.0.1:1",
    MODULE_CATALOG_CACHE_PATH: "/api/modules",
    bottomLayout: { refresh() {} },
    watchAndroidUpdateReturn() {},
    routeLoadingCopy: () => ({}),
    updateServer() {},
    prepareAndroidModuleImports() {},
    readCachedJson: async () => null,
    androidModuleFallbackCatalog: () => [],
    renderAndroidModuleNavigation: () => [],
    createAndroidModuleHost() {},
    currentViewUsesLibrary: () => false,
    refreshModuleCatalog() {},
    checkAndroidUpdate() {},
    loadAndroidModules(_modules, _host, _imports, { onProgress }) {
      progress.resolve(onProgress);
      return finalRegistry.promise;
    }
  });
  const done = context.bootApp();
  const publish = await Promise.race([
    progress.promise,
    done.then(() => { throw new Error("Android startup finished before module registration began"); })
  ]);
  return { publish: (registry) => publish({}, () => registry), finish: finalRegistry.resolve, done };
}

function moduleRegistry(context, resolve, renders = []) {
  return {
    get: () => null,
    deactivateExcept() {},
    resolve,
    render(view, params) {
      renders.push([view, params.category]);
      return context.task;
    }
  };
}

for (const canceled of [false, true]) {
  test(`pre-prefix navigation ${canceled ? "respects canceled" : "retains"} scroll restoration through first mount`, async () => {
    const { context, frames, timers } = shell();
    const boot = await startBoot(context);
    const request = deferred();
    context.task = request.promise;
    const renders = [];
    const registry = moduleRegistry(context, () => ({}), renders);
    try {
      context.document.documentElement.scrollHeight = 820;
      // Match showView's render and restore calls while startup is still held.
      context.renderCurrentView({ restoreScrollY: 840 });
      context.queueScrollRestore(840);
      frames.shift()();
      assert.equal(context.events.length, 0, "the loading shell has not mounted a route");
      assert.equal(context.pendingScrollRestore.attempts, 0, "waiting for a module consumes no scroll retries");
      assert.deepEqual(timers, []);

      if (canceled) context.cancelPendingScrollRestore();
      boot.publish(registry);
      assert.deepEqual(renders, [["channel", "first"]]);
      context.document.documentElement.scrollHeight = 4000;
      request.resolve();
      await flushPromises();
      if (canceled) {
        assert.equal(context.pendingScrollRestore, null);
        assert.equal(frames.length, 0);
      } else {
        assert.equal(context.pendingScrollRestore.target, 840);
        assert.equal(context.pendingScrollRestore.token, context.viewRenderToken);
        frames.shift()();
        assert.equal(context.window.scrollY, 840);
      }
    } finally {
      boot.finish(registry);
      await boot.done;
    }
    assert.equal(renders.length, 1, "terminal registration leaves the mounted route intact");
  });
}

test("the latest parameters and scroll own a pending suffix route", async () => {
  const { context } = shell();
  context.currentView = "works";
  const boot = await startBoot(context);
  const renders = [];
  const prefix = moduleRegistry(context, (view) => view === "works" ? {} : null, renders);
  const final = moduleRegistry(context, () => ({}), renders);
  try {
    boot.publish(prefix);
    context.currentView = "channel";
    context.currentViewParams = { mode: "movie", category: "old" };
    context.renderCurrentView({ restoreScrollY: 840 });
    const old = context.androidModuleRegistry.startup.pendingRender;
    context.currentViewParams = { mode: "movie", category: "latest" };
    context.renderCurrentView({ restoreScrollY: 260 });
    assert.equal(old.renderGuard(), false);

    boot.publish(final);
    await flushPromises();
    assert.deepEqual(renders, [["works", "first"], ["channel", "latest"]]);
    assert.equal(context.pendingScrollRestore.target, 260);
  } finally {
    boot.finish(final);
    await boot.done;
  }
  assert.equal(renders.length, 2, "finishing the registry does not remount the suffix route");
});

test("a throwing deferred route stays local and later modules still publish", async () => {
  const { context } = shell();
  context.currentView = "works";
  const boot = await startBoot(context);
  const renders = [];
  const errors = [];
  const rows = [];
  const removedClasses = [];
  context.console = { error: (...args) => errors.push(args) };
  context.document.createElement = () => ({
    children: [],
    classList: { remove: (name) => removedClasses.push(name) },
    append(child) { this.children.push(child); }
  });
  context.els.viewContent.replaceChildren = (row) => rows.push(row.children[0].textContent);
  const prefix = moduleRegistry(context, (view) => view === "works" ? {} : null, renders);
  const later = moduleRegistry(context, () => ({}), renders);
  const failure = new Error("synthetic route render failure");
  let failedGuard;
  try {
    boot.publish(prefix);
    context.currentView = "channel";
    context.renderCurrentView();
    boot.publish({
      ...later,
      render(_view, _params, guard) {
        failedGuard = guard;
        throw failure;
      }
    });
    assert.equal(failedGuard(), false, "work started by the failed route no longer owns the view");
    assert.equal(failedGuard.signal.aborted, true);
    assert.deepEqual(errors, [["[android-route]", failure]]);
    assert.deepEqual(removedClasses, ["route-loading"]);
    assert.deepEqual(rows, ["页面暂时无法显示，可以返回或切换到其他页面。"]);

    boot.publish(later);
    assert.deepEqual(renders, [["works", "first"]], "tail registration must not retry the failed view");
    context.currentView = "works";
    context.renderCurrentView();
    assert.deepEqual(renders, [["works", "first"], ["works", "first"]]);
  } finally {
    boot.finish(later);
    await boot.done;
  }
});

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

test("library arrival preserves a pending People scroll unless the user canceled it", async () => {
  for (const canceled of [false, true]) {
    const { context } = shell();
    context.currentView = "people";
    context.currentViewParams = { scope: "main" };
    context.currentViewNeedsLibrary = () => true;
    context.queueScrollRestore(840);
    if (canceled) {
      context.cancelPendingScrollRestore();
      context.window.scrollY = 150;
    }
    context.refreshLibraryDependentView();
    await flushPromises();
    assert.equal(context.pendingScrollRestore.target, canceled ? 150 : 840);
    assert.equal(context.pendingScrollRestore.token, context.viewRenderToken);
  }
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
  assert.equal(context.modePickerRetirements, 1, "home navigation retires the previous menu lifecycle");
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

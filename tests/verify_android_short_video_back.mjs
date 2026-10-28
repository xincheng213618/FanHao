import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as shared from "../android-client/www/modules/short-videos/shared.js";
import { closeMobileActionSheet } from "../android-client/www/js/mobile-action-sheet.js";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

// Actual short-video module, views/controller, chrome/dialog, normalized registry
// and shell native-Back dispatcher. DOM/layout, navigation and API completion are
// controlled boundaries. No device, application service or user data is touched.
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const moduleSource = read("android-client/www/modules/short-videos/android-module.js")
  .replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
const entryUrl = new URL("../android-client/www/modules/short-videos/index.js", import.meta.url);
const entrySource = read("android-client/www/modules/short-videos/index.js");
const controllerUrl = new URL("../android-client/www/modules/short-videos/list/controller.js", import.meta.url);
const controllerSource = read("android-client/www/modules/short-videos/list/controller.js");
const registrySource = read("android-client/www/js/android-module-registry.js").replace(/^export /gm, "");
const appSource = read("android-client/www/app.js");
const mainSource = read("android-client/android/app/src/main/java/local/fanhao/library/MainActivity.java");
const appFunction = name => {
  const start = appSource.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  return appSource.slice(start, appSource.indexOf("\n}", start) + 2);
};
const backStart = appSource.indexOf("window.fanhaoHandleNativeBack = () => {");
assert(backStart >= 0, "actual shell native-Back dispatcher");
const backSource = appSource.slice(backStart, appSource.indexOf("\n};", backStart) + 3);
const mainBack = mainSource.slice(mainSource.indexOf("  private void dispatchBackToWebView()"), mainSource.indexOf("  private void dispatchTextIntentToWebView"));
assert(mainBack.includes('if (!"true".equals(handled)) {\n          moveTaskToBack(true);'),
  "the source-verified native fallback backgrounds an unhandled Back; this is not device acceptance");
const original = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const copy = value => JSON.parse(JSON.stringify(value));
const page = (ids = ["A"], source = "all", overrides = {}) => ({
  videos: ids.map(id => ({ id, streamUrl: `/fixture/${id}.mp4` })),
  authors: ids.map(id => ({ secUid: `author-${id}` })), source, total: 20, hasMore: true, ...overrides
});
const importSource = (source, url) => import(`data:text/javascript;base64,${Buffer.from(source.replace(
  /from "(\.\.?\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, url).href)}`
)).toString("base64")}`);
const controllerModule = await importSource(controllerSource, controllerUrl);
let fixtureId = 0, cases = 0, selectedCase = "";

async function fixture({ code = moduleSource, source = "all", view = "shortVideos", stack = false, history = false } = {}) {
  const document = globalThis.document = createNavigationFixtureDocument();
  const prototype = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(prototype, "isConnected")) {
    Object.defineProperty(prototype, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  }
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const navigation = [], requests = [], writes = [], listeners = new Map();
  const window = globalThis.window = {
    addEventListener(name, callback) { const values = listeners.get(name) || []; values.push(callback); listeners.set(name, values); },
    history: { state: { marker: history ? "fixture-history" : "other" }, length: history ? 3 : 1,
      back: () => navigation.push("history-back") }
  };
  globalThis.fetch = () => { throw new Error("No real HTTP is allowed in the Back fixture"); };
  const key = `__fanhaoShortVideoBack${++fixtureId}`;
  const capture = globalThis[key] = {
    context: null, factory: controllerModule.createShortVideoListController,
    api: {
      fetchCached(...args) { const request = { args, ...deferred() }; requests.push(request); return request.promise; },
      fetchCachedRevalidated(...args) { const request = { args, ...deferred() }; requests.push(request); return request.promise; }
    }
  };
  const importLine = /^import \{ createShortVideoListController \} from "[^\"]+";$/m;
  assert(importLine.test(entrySource), "actual views compose the real list controller");
  const instrumentedEntry = entrySource.replace(importLine, `const createShortVideoListController = context => {
    const capture = globalThis[${JSON.stringify(key)}];
    capture.context = context;
    context.api = capture.api;
    return capture.factory(context);
  };`);
  const entry = await importSource(instrumentedEntry, entryUrl);
  const container = document.createElement("nav"), content = document.createElement("main");
  document.body.append(container, content);
  const els = { viewContent: content, viewKicker: {}, viewTitle: {}, viewMeta: {},
    appConfirmOverlay: { hidden: true }, settingsOverlay: { hidden: true } };
  const host = { els, getActiveUrl: () => "http://short-back.fixture.invalid:29998",
    navigation: { showView: (...args) => navigation.push(args), goBack: () => navigation.push("host-back") },
    ui: { setActiveBottom() {}, openSettings() {}, scrollToTop() {} } };
  const sandbox = vm.createContext({ ...shared, createShortVideoViews: entry.createShortVideoViews, window, document });
  const create = vm.runInContext(`(function(){${code}\nreturn createAndroidModule;})()`, sandbox);
  const rawModule = create({ host });
  delete globalThis[key];
  const context = capture.context;
  // Rendering is a layout boundary; data/loading and request generations are real.
  context.renderListShell = () => {
    writes.push("render");
    if (!content.querySelector(".short-video-mobile-list")) {
      const grid = document.createElement("div"); grid.className = "short-video-mobile-list"; content.append(grid);
    }
  };
  context.appendListVideos = rows => writes.push({ append: rows.map(row => row.id) });
  context.setListLoadingMore = (...args) => writes.push({ loading: args });
  context.setListRefreshing = (...args) => writes.push({ refreshing: args });
  context.shortVideoToast = message => writes.push({ toast: message });
  const registryApi = vm.runInContext(`(function(){${registrySource}\nreturn { normalizeModule, createRegistry };})()`, sandbox);
  const normalized = registryApi.normalizeModule(rawModule, { id: "short-videos", client: { android: {} } });
  const registry = registryApi.createRegistry([normalized]);
  const params = { source, sort: "published", authorSort: "followed", authorFilter: "all" };
  assert(registry.renderChrome("shortVideos", params, container));
  const tag = container.querySelector(".short-video-chrome-tag.active"); assert(tag);
  const app = vm.createContext({ window, document, androidModuleRegistry: registry, els, closeMobileActionSheet,
    mediaViewer: { close: () => false }, searchSurfaceExpanded: false,
    currentView: view, currentViewParams: params, HISTORY_MARKER: "fixture-history",
    normalizeChannelMode: value => value,
    returnToStackView: () => { if (stack) navigation.push("stack"); return stack; },
    applyBackState: () => navigation.push("apply-back"),
    // Navigation menus are closed in this fixture; the gallery gate runs their
    // actual close/keyboard/Back behavior.
    closeActiveModePicker: () => false,
    settleAppConfirmation() {}, closeSettings() {}, closeSearchSurface() {} });
  vm.runInContext(appFunction("isRootNavigationView") + "\n" + backSource, app);
  const open = () => { tag.click(); assert(document.querySelector(".short-video-sort-overlay")); };
  const load = async () => {
    const pending = rawModule.api.shortVideoViews.renderList(params);
    requests.at(-1).resolve({ data: page(["A"], source), revalidation: null });
    await pending;
  };
  return { rawModule, registry, document, container, tag, context, state: context.listState, requests, writes, navigation, params,
    back: () => window.fanhaoHandleNativeBack(), open, load,
    overlay: () => document.querySelector(".short-video-sort-overlay"),
    snapshot: () => ({ data: copy(context.listState.data), loading: context.listState.loading,
      loadingMore: context.listState.loadingMore, allowLoadMore: context.listState.allowLoadMore,
      writes: copy(writes), navigation: copy(navigation) }) };
}

async function test(name, body, options = {}) {
  if (selectedCase && name !== selectedCase) return;
  const f = await fixture(options);
  await body(f); cases++;
}

async function verify(code = moduleSource) {
  const options = extra => ({ code, ...extra });
  for (const source of ["recommended", "liked", "history", "all", "following", "authors"]) {
    await test(`root closes ${source}`, async f => {
      f.open(); const before = f.snapshot();
      assert.equal(f.back(), true, "native Back must be consumed by the sort overlay");
      assert.equal(f.overlay(), null, "native Back removes the sort overlay");
      assert.deepEqual(f.snapshot(), before, "closing a sort dialog must preserve route, data and loading");
      assert.equal(f.back(), false, "a second root Back remains unhandled without a dialog");
      assert.equal(f.navigation.length, 0);
    }, options({ source }));
  }
  for (const route of [
    { view: "shortVideoSearch", stack: true, expected: "stack" },
    { view: "shortVideoSearch", history: true, expected: "history-back" },
    { view: "shortVideoSearch", expected: "apply-back" }
  ]) {
    await test(`search Back order ${route.expected}`, async f => {
      f.open(); assert.equal(f.back(), true); assert.equal(f.overlay(), null);
      assert.equal(f.navigation.length, 0, "first Back closes the overlay before history/stack fallback");
      assert.equal(f.back(), true);
      assert.deepEqual(f.navigation, [route.expected], "second Back preserves normal navigation fallback");
    }, options(route));
  }
  await test("root empty Back is not consumed", async f => {
    assert.equal(f.back(), false, "no overlay must not trap the root Back");
    assert.equal(f.navigation.length, 0);
  }, options({ history: true }));
  await test("reopening and backdrop dismissal", async f => {
    f.open(); const first = f.overlay();
    f.document.querySelector(".short-video-sort-backdrop").click();
    assert.equal(f.overlay(), null);
    f.open(); assert.notEqual(f.overlay(), first);
    assert.equal(f.back(), true); assert.equal(f.overlay(), null);
    f.open(); f.rawModule.deactivate(); assert.equal(f.overlay(), null);
  }, options());
  for (const source of ["all", "following"]) {
    await test(`sort option still navigates ${source}`, async f => {
      f.open(); const button = f.document.querySelectorAll(".short-video-sort-option").find(row => !row.classList.contains("active"));
      assert(button); button.click();
      assert.equal(f.overlay(), null);
      assert.equal(f.navigation.length, 1);
      const [view, params, navigation] = f.navigation[0];
      assert.equal(view, "shortVideos");
      assert.equal(params.source, source);
      assert.equal(navigation.skipHistory, true); assert.equal(navigation.replaceHistory, true);
      assert.notEqual(source === "following" ? params.authorSort : params.sort, source === "following" ? "followed" : "published");
    }, options({ source }));
  }
  for (const source of ["all", "following"]) {
    await test(`pending pagination survives Back ${source}`, async f => {
      await f.load();
      const pending = f.context.loadList(null, { append: true }), request = f.requests.at(-1);
      assert.equal(f.state.loadingMore, true);
      f.open(); const before = f.snapshot();
      assert.equal(f.back(), true); assert.equal(f.overlay(), null);
      assert.deepEqual(f.snapshot(), before, "dialog Back must not deactivate or reset a pending list");
      assert.notEqual(request.args[2]?.signal?.aborted, true, "dialog Back cannot abort the underlying HTTP read");
      request.resolve(page(["B"], source)); await pending;
      const ids = source === "following" ? f.state.data.authors.map(row => row.secUid) : f.state.data.videos.map(row => row.id);
      assert.deepEqual(ids, source === "following" ? ["author-A", "author-B"] : ["A", "B"], "the pending page still commits after dialog Back");
      assert.equal(f.state.loadingMore, false);
    }, options({ source }));
  }
  await test("pending initial read survives Back", async f => {
    const pending = f.rawModule.api.shortVideoViews.renderList(f.params), request = f.requests.at(-1);
    assert.equal(f.state.loading, true); f.open(); const before = f.snapshot();
    assert.equal(f.back(), true); assert.deepEqual(f.snapshot(), before);
    request.resolve({ data: page(["first"]), revalidation: null }); await pending;
    assert.equal(f.state.loading, false); assert.equal(f.state.data.videos[0].id, "first");
  }, options());
  await test("module leave still retires pending read", async f => {
    await f.load(); const pending = f.context.loadList(null, { append: true }), request = f.requests.at(-1);
    f.open(); f.rawModule.deactivate(); assert.equal(f.overlay(), null);
    const before = f.snapshot(); request.resolve(page(["late"])); await pending;
    assert.deepEqual(f.snapshot(), before, "real module leave still rejects late page publication");
  }, options());
  await test("dialog Back preserves pending native open", async f => {
    const response = deferred(); let owner;
    f.context.openNativeShortVideoFeed = (_video, options) => { owner = options.owner; return response.promise; };
    const pending = f.context.openShortVideoFromList({ id: "A" });
    assert(owner?.isCurrent()); f.open(); assert.equal(f.back(), true);
    assert(owner.isCurrent(), "dialog dismissal must not cancel an accepted native-open intent");
    assert.equal(owner.controller.signal.aborted, false);
    response.resolve(true); assert.equal(await pending, true);
  }, options());
  await test("non-active module cannot consume sort Back", async f => {
    f.open(); assert.equal(f.registry.handleBack("home", {}), false);
    assert(f.overlay(), "registry does not call an inactive module's Back hook");
    assert.equal(f.back(), true); assert.equal(f.overlay(), null);
  }, options());
  for (const action of ["native", "backdrop", "Escape"]) {
    await test(`dismissal restores focus ${action}`, async f => {
      f.tag.focus(); f.open(); assert.notEqual(f.document.activeElement, f.tag);
      if (action === "native") assert.equal(f.back(), true);
      else if (action === "backdrop") f.document.querySelector(".short-video-sort-backdrop").click();
      else {
        const event = { type: "keydown", key: "Escape", bubbles: true,
          preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
        f.document.activeElement.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true, "handled Escape must prevent a second Back-like action");
        assert.equal(event.stopped, true, "handled Escape must stop propagation");
      }
      assert.equal(f.overlay(), null);
      assert.equal(f.document.activeElement, f.tag, "closing the live dialog restores its connected opener");
      assert.equal(f.navigation.length, 0);
    }, options());
  }
  await test("disconnected opener does not steal focus", async f => {
    f.open(); f.container.remove();
    const other = f.document.createElement("button"); f.document.body.append(other); other.focus();
    assert.equal(f.back(), true); assert.equal(f.overlay(), null);
    assert.equal(f.document.activeElement, other, "a detached opener must not steal focus from the current page");
  }, options());
  await test("reopening skips obsolete focus restoration", async f => {
    let restored = 0;
    const focus = f.tag.focus.bind(f.tag); f.tag.focus = () => { restored++; focus(); };
    f.open(); const old = f.overlay(); f.open();
    assert.notEqual(f.overlay(), old);
    assert.equal(restored, 0, "replacing an overlay must not focus its old opener between dialogs");
    assert.equal(f.back(), true); assert.equal(restored, 1);
  }, options());
  for (const dismissedBy of ["Back", "reopen", "leave"]) {
    for (const control of ["sort", "filter"]) {
      await test(`retired ${control} callback after ${dismissedBy}`, async f => {
        f.open();
        const buttons = f.document.querySelectorAll(".short-video-sort-option");
        const old = control === "filter" ? buttons.at(-1) : buttons.find(row => !row.classList.contains("active"));
        assert(old);
        if (dismissedBy === "Back") assert.equal(f.back(), true);
        else if (dismissedBy === "reopen") f.open();
        else f.rawModule.deactivate();
        const current = f.overlay(), before = f.snapshot(), active = f.document.activeElement;
        old.click(); await settle();
        assert.deepEqual(f.snapshot(), before, "a retired sort/filter callback cannot navigate or mutate the list");
        assert.equal(f.overlay(), current, "retired controls cannot dismiss a newer dialog");
        assert.equal(f.document.activeElement, active, "retired controls cannot move current focus");
      }, options({ source: "following" }));
    }
  }
  await test("legacy unregistered dialog can close", async f => {
    const overlay = f.document.createElement("div"); overlay.className = "short-video-sort-overlay";
    f.document.body.append(overlay);
    assert.equal(f.back(), true); assert.equal(f.overlay(), null);
    assert.equal(f.back(), false);
  }, options());
}

try {
  await verify();
  console.log(`Android short-video Back: ${cases} actual module/views/registry/app behavior cases passed.`);
  const mutations = [
    ["missing module hook", moduleSource.replace("handleBack: () => closeSortDialog(),", "handleBack: () => false,"),
      "root closes all", /native Back must be consumed/],
    ["destructive whole-view retirement", moduleSource.replace("handleBack: () => closeSortDialog(),",
      "handleBack: () => { const closed = closeSortDialog(); if (closed) shortVideoViews.deactivate(); return closed; },"),
      "pending pagination survives Back all", /dialog Back must not deactivate or reset/],
    ["unconditional Back consumption", moduleSource.replace("handleBack: () => closeSortDialog(),", "handleBack: () => { closeSortDialog(); return true; },"),
      "root empty Back is not consumed", /no overlay must not trap/],
    ["retired callback ownership", moduleSource.replace("if (!ownsDialog()) return false;", "/* ownership omitted */"),
      "retired sort callback after Back", /retired sort\/filter callback cannot navigate/],
    ["missing focus restore", moduleSource.replace("if (restoreFocus && opener?.isConnected) opener.focus();", "/* focus restoration omitted */"),
      "dismissal restores focus native", /restores its connected opener/],
    ["detached opener focus", moduleSource.replace("restoreFocus && opener?.isConnected", "restoreFocus && opener"),
      "disconnected opener does not steal focus", /detached opener must not steal focus/],
    ["reopen focus steal", moduleSource.replace("  closeSortDialog(false);", "  closeSortDialog(true);"),
      "reopening skips obsolete focus restoration", /must not focus its old opener/],
    ["Escape propagation", moduleSource.replace("event.preventDefault();\n      event.stopPropagation();", "/* Escape consumption omitted */"),
      "dismissal restores focus Escape", /handled Escape must prevent/]
  ];
  for (const [name, code, scenario, expected] of mutations) {
    assert.notEqual(code, moduleSource, `${name}: mutation must alter actual module`);
    selectedCase = scenario;
    await assert.rejects(() => verify(code), expected, `${name}: behavioral negative control survived`);
  }
  console.log(`Android short-video Back: ${mutations.length} behavioral negative controls rejected.`);
} finally {
  globalThis.document = original.document; globalThis.window = original.window; globalThis.fetch = original.fetch;
}

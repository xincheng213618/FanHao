import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createDetailViews, createPeopleViews, createWorkViews } from "../android-client/www/modules/fanhao/index.js";
import { createCodePrefixViews } from "../android-client/www/modules/fanhao/features/code-prefixes/prefix-views.js";
import { formatNumber } from "../android-client/www/js/format.js";
import { appFunction, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

// Complete shared-sheet implementation, actual FanHao module/view constructors,
// chrome/search toolbar, registry and app Back/account dispatch execute. DOM,
// layout, storage, navigation and accepted async actions are controlled; no
// service, real mutation, browser, native task movement or device is exercised.
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const source = read("android-client/www/js/mobile-action-sheet.js");
const appSource = read("android-client/www/app.js");
const moduleSource = read("android-client/www/modules/fanhao/android-module.js");
const chromeSource = read("android-client/www/modules/fanhao/chrome.js");
const toolbarSource = read("android-client/www/modules/fanhao/features/works/search-result-toolbar.js");
const registrySource = read("android-client/www/js/android-module-registry.js");
const mainSource = read("android-client/android/app/src/main/java/local/fanhao/library/MainActivity.java");
assert.match(appSource, /import \{ closeMobileActionSheet \} from "\.\/js\/mobile-action-sheet\.js\?v=[^"]+";/,
  "the live shell must import the shared close implementation");
assert.match(mainSource, /if \(!"true"\.equals\(handled\)\) \{\s*moveTaskToBack\(true\);/,
  "JavaScript false retains the native root fallback (source boundary only)");
const plain = code => code.replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
const callback = (code, startText, endText) => {
  const start = code.indexOf(startText), end = code.indexOf(endText, start);
  assert(start >= 0 && end > start, startText);
  return code.slice(start, end + endText.length);
};
const original = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
const elementPrototype = Object.getPrototypeOf(createNavigationFixtureDocument().createElement("button"));
const basicMatches = elementPrototype.matches;
elementPrototype.matches = function(selector) {
  if (selector.includes(":not(:disabled)")) return selector.split(",").some(part => !this.disabled
    && basicMatches.call(this, part.trim().replace(":not(:disabled)", "")));
  return basicMatches.call(this, selector);
};
let sequence = 0, cases = 0;

function fixture({ sheet = source, app = appSource } = {}) {
  const document = globalThis.document = createNavigationFixtureDocument();
  document.activeElement = document.body;
  const listeners = new Map(), navigation = [], selection = [], store = new Map();
  const base = `http://shared-sheet-${++sequence}.fixture.invalid:29998`;
  const window = globalThis.window = {
    addEventListener(type, listener) { const values = listeners.get(type) || []; values.push(listener); listeners.set(type, values); },
    removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter(value => value !== listener)); },
    dispatchEvent(event) { for (const listener of [...listeners.get(event.type) || []]) listener(event); return true; },
    history: { state: { marker: "sheet-history" }, length: 3, back: () => navigation.push("history-back") },
    location: { reload: () => navigation.push("reload") }
  };
  globalThis.localStorage = { getItem: key => store.get(key) || null,
    setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  globalThis.fetch = () => { throw new Error("Shared-sheet verification must not make HTTP requests"); };
  const noop = () => {};
  const els = {
    viewContent: document.createElement("main"), moduleChrome: document.createElement("header"),
    continuePreview: document.createElement("div"), personPreview: document.createElement("div"),
    appConfirmOverlay: { hidden: true }, settingsOverlay: { hidden: true }
  };
  document.body.append(els.moduleChrome, els.viewContent, els.personPreview, els.continuePreview);
  const trigger = document.createElement("button"); trigger.textContent = "Open";
  els.viewContent.append(trigger); trigger.focus();
  const host = {
    els, getActiveUrl: () => base, getLibrary: () => ({ works: [], people: [] }),
    navigation: { currentParams: () => ({ scope: "main" }), currentView: () => "people", showView: (...args) => navigation.push(args),
      replaceViewParams: noop, goBack: () => navigation.push("host-back"), openInLibrary: noop },
    limits: { getWorks: () => 80, increaseWorks: noop, getPeople: () => 80, increasePeople: noop },
    ui: { setActiveBottom: noop, refreshChrome: noop, renderCurrentView: () => navigation.push("rerender"),
      renderCurrentViewPreservingScroll: () => navigation.push("rerender-preserved"), scrollToTop: noop },
    favorites: { onUserStateChange: noop }, mediaViewer: { close: () => false }
  };
  const sandbox = vm.createContext({ window, document, console, URL, formatNumber,
    createDetailViews, createPeopleViews, createWorkViews, createCodePrefixViews });
  const sheetApi = vm.runInContext(`(function(){${plain(sheet)}\nreturn {openMobileActionSheet,closeMobileActionSheet};})()`, sandbox);
  Object.assign(sandbox, sheetApi, { openFanhaoSheet: sheetApi.openMobileActionSheet });
  Object.assign(sandbox, vm.runInContext(`(function(){${plain(chromeSource)}\nreturn {renderFanhaoChrome,FANHAO_ROOT_VIEWS};})()`, sandbox));
  const createModule = vm.runInContext(`(function(){${plain(moduleSource)}\nreturn createAndroidModule;})()`, sandbox);
  const rawModule = createModule({ host });
  const registryApi = vm.runInContext(`(function(){${plain(registrySource)}\nreturn {normalizeModule,createRegistry};})()`, sandbox);
  const module = registryApi.normalizeModule(rawModule, { id: "fanhao", client: { android: {} } });
  const registry = registryApi.createRegistry([module]);
  Object.assign(sandbox, {
    els, mediaViewer: host.mediaViewer, androidModuleRegistry: registry,
    currentView: "people", currentViewParams: { scope: "main" }, searchSurfaceExpanded: false, HISTORY_MARKER: "sheet-history",
    normalizeChannelMode: value => value, returnToStackView: () => { navigation.push("stack"); return true; },
    settleAppConfirmation: () => { els.appConfirmOverlay.hidden = true; navigation.push("confirm"); },
    closeSettings: () => { els.settingsOverlay.hidden = true; navigation.push("settings"); },
    // This fixture has no navigation menu; the gallery gate exercises its real
    // close/keyboard/Back behavior. Keep this unrelated boundary closed.
    closeActiveModePicker: () => false,
    closeSearchSurface: () => { sandbox.searchSurfaceExpanded = false; navigation.push("search"); },
    applyBackState: () => navigation.push("fallback"),
    activeUrl: base, accountPageOwner: "", accountChangeNeedsReload: false, library: null, libraryLoadGeneration: 0,
    libraryLoadPromise: null, accountReloadPending: false, workViews: null, invalidateViewRender: noop, renderUserState: noop,
    queueMicrotask: noop, loadDashboard: noop, renderCurrentView: noop
  });
  vm.runInContext(appFunction(app, "isRootNavigationView") + "\n"
    + callback(app, "window.fanhaoHandleNativeBack = () => {", "\n};") + "\n"
    + callback(app, 'window.addEventListener("fanhaoAccountOwnerChanged", (event) => {', "\n});"), sandbox);
  const toolbarApi = vm.runInContext(`(function(){${plain(toolbarSource)}\nreturn {createSearchResultToolbar};})()`, sandbox);
  const open = (config = {}) => sheetApi.openMobileActionSheet({ title: "Fixture actions", trigger,
    value: "b", options: [{ value: "a", label: "A", select: value => selection.push(value) },
      { value: "b", label: "B", select: value => selection.push(value) }], ...config });
  const fire = (node, type, values = {}) => {
    const event = { type, bubbles: true, defaultPrevented: false, ...values,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    node.dispatchEvent(event); return event;
  };
  const emit = (type, detail) => window.dispatchEvent({ type, detail });
  const toolbar = () => {
    const value = toolbarApi.createSearchResultToolbar({ sortMode: "updated",
      sortOptions: [{ value: "updated", label: "Recent" }, { value: "title", label: "Title" }],
      onSortChange: value => selection.push(value) });
    els.viewContent.append(value); return value;
  };
  return { document, window, els, trigger, host, sandbox, rawModule, registry, selection, navigation, listeners,
    open, fire, emit, toolbar, close: sheetApi.closeMobileActionSheet,
    overlay: () => document.querySelector(".mobile-action-sheet-overlay"),
    options: () => document.querySelectorAll(".mobile-action-sheet-option"),
    back: () => window.fanhaoHandleNativeBack(),
    cleanup() { sheetApi.closeMobileActionSheet(false); }
  };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
test("actual people chrome consumes sheet Back before native root fallback", f => {
  f.registry.renderChrome("people", { scope: "main" }, f.els.moduleChrome);
  const sort = f.els.moduleChrome.querySelector(".fanhao-feed-appbar-action"); sort.focus(); sort.click();
  assert(f.overlay());
  assert.equal(f.back(), true, "shared sheet must consume native Back before the root fallback");
  assert.equal(f.overlay(), null); assert.equal(f.document.activeElement, sort);
  assert.deepEqual(f.navigation, []); assert.equal(f.back(), false, "a closed sheet must not swallow root Back forever");
});
test("shared sheet precedes detail history navigation", f => {
  f.sandbox.currentView = "workDetail"; f.open();
  assert.equal(f.back(), true); assert.equal(f.overlay(), null); assert.deepEqual(f.navigation, []);
  assert.equal(f.back(), true); assert.deepEqual(f.navigation, ["stack"]);
});
test("shared sheet precedes underlying expanded media search", f => {
  f.sandbox.currentView = "mediaDetail"; f.sandbox.searchSurfaceExpanded = true; f.open();
  assert.equal(f.back(), true); assert.equal(f.sandbox.searchSurfaceExpanded, true); assert.deepEqual(f.navigation, []);
  assert.equal(f.back(), true); assert.deepEqual(f.navigation, ["search"]);
});
for (const priority of ["viewer", "confirm", "settings"]) test(`existing ${priority} Back priority is retained`, f => {
  f.open();
  if (priority === "viewer") f.sandbox.mediaViewer = { close: () => { f.navigation.push("viewer"); return true; } };
  if (priority === "confirm") f.els.appConfirmOverlay.hidden = false;
  if (priority === "settings") f.els.settingsOverlay.hidden = false;
  assert.equal(f.back(), true); assert(f.overlay(), "higher-priority existing surface is handled before a shared sheet");
  assert.deepEqual(f.navigation, [priority]);
});
for (const method of ["backdrop", "escape", "close", "visible-close"]) test(`${method} restores the current opener focus`, f => {
  const opened = f.open(); const active = f.options().at(1);
  assert.equal(f.document.activeElement, active, "the actual selected option receives initial focus");
  if (method === "backdrop") f.document.querySelector(".mobile-action-sheet-backdrop").click();
  if (method === "escape") { const event = f.fire(opened.overlay, "keydown", { key: "Escape" }); assert(event.defaultPrevented); assert(event.stopped); }
  if (method === "close") assert.equal(opened.close(), true);
  if (method === "visible-close") {
    assert.equal(opened.panel.children[0], opened.header);
    assert.equal(opened.panel.querySelectorAll(".mobile-action-sheet-head").length, 1);
    assert.equal(opened.panel.querySelector(".mobile-action-sheet-head"), opened.header);
    assert.equal(opened.header.querySelector("strong").textContent, "Fixture actions");
    assert.equal(opened.panel.querySelectorAll(".mobile-action-sheet-close").length, 1);
    assert.equal(opened.header.querySelector(".mobile-action-sheet-close"), opened.closeButton);
    assert.equal(opened.closeButton.type, "button"); assert.equal(opened.closeButton.textContent, "关闭");
    assert.equal(opened.closeButton.getAttribute("aria-label"), "关闭Fixture actions");
    opened.closeButton.click();
  }
  assert.equal(f.overlay(), null); assert.equal(f.document.activeElement, f.trigger);
  assert.equal(opened.close(), false);
});
test("no active option initially focuses the first enabled option before the close control", f => {
  const opened = f.open({ value: "missing" });
  assert.equal(f.document.activeElement, f.options()[0]);
  assert.notEqual(f.document.activeElement, opened.closeButton);
});
for (const mode of ["empty", "all-disabled"]) test(`${mode} options initially focus the visible close fallback`, f => {
  const options = mode === "empty" ? [] : [
    { value: "a", label: "Disabled A", disabled: true },
    { value: "b", label: "Disabled B", disabled: true }
  ];
  const opened = f.open({ options });
  assert.equal(f.document.activeElement, opened.closeButton);
  opened.closeButton.click();
  assert.equal(f.overlay(), null); assert.equal(f.document.activeElement, f.trigger); assert.deepEqual(f.selection, []);
});
test("hidden and disabled options keep their contract", f => {
  f.open({ value: "off", options: [
    { value: "hide", label: "Hidden", hidden: true, select: () => assert.fail("hidden option") },
    { value: "off", label: "Disabled", disabled: true, select: () => f.selection.push("disabled") },
    { value: "live", label: "Enabled", select: value => f.selection.push(value) }
  ] });
  assert.equal(f.options().length, 2); assert.equal(f.document.activeElement, f.options().at(1));
  f.options().at(0).click(); assert.deepEqual(f.selection, []); assert(f.overlay());
  f.options().at(1).click(); assert.deepEqual(f.selection, ["live"]); assert.equal(f.overlay(), null);
});
test("runtime-disabled retained option rejects a late click", f => {
  f.open(); const option = f.options()[0]; option.disabled = true; option.click();
  assert.deepEqual(f.selection, []); assert(f.overlay());
});
test("normal option selection is accepted exactly once after close", f => {
  f.open(); const option = f.options()[0]; option.click(); option.click();
  assert.deepEqual(f.selection, ["a"]); assert.equal(f.overlay(), null);
});
test("explicit trigger remains the focus return target", f => {
  const explicit = f.document.createElement("button"); f.els.viewContent.append(explicit);
  assert.notEqual(f.document.activeElement, explicit, "the explicit opener differs from the current focus snapshot");
  const opened = f.open({ trigger: explicit }); opened.closeButton.click(); assert.equal(f.document.activeElement, explicit);
});
test("removed or disabled opener is never refocused", f => {
  const opened = f.open(); f.trigger.remove(); const sentinel = f.document.createElement("input"); f.els.viewContent.append(sentinel); sentinel.focus();
  opened.close(); assert.equal(f.document.activeElement, sentinel);
  f.els.viewContent.append(f.trigger); const next = f.open(); f.trigger.disabled = true; sentinel.focus();
  next.close(); assert.equal(f.document.activeElement, sentinel);
});
for (const reason of ["route", "pagehide", "account"]) test(`${reason} retires old sheet without focus stealing`, f => {
  const opened = f.open(); const oldOption = f.options()[0];
  const sentinel = f.document.createElement("input"); f.document.body.append(sentinel); sentinel.focus();
  if (reason === "route") f.emit("fanhaoViewWillRender", { view: "music", params: {} });
  if (reason === "pagehide") f.emit("pagehide");
  if (reason === "account") f.emit("fanhaoAccountOwnerChanged", { current: { origin: f.host.getActiveUrl(), owner: "pending" } });
  assert.equal(f.overlay(), null, `${reason} must retire the old shared sheet`);
  assert.equal(f.document.activeElement, sentinel);
  oldOption.click(); assert.deepEqual(f.selection, []); assert.equal(opened.close(), false);
});
test("unrelated account response cannot dismiss current server sheet", f => {
  f.open(); f.emit("fanhaoAccountOwnerChanged", { current: { origin: "http://other.fixture.invalid", owner: "pending" } });
  assert(f.overlay());
});
test("actual search toolbar sheet cannot cover the next route", f => {
  const toolbar = f.toolbar(); toolbar.querySelectorAll("button").at(1).click();
  const oldOption = f.options().at(1); assert(f.overlay());
  f.emit("fanhaoViewWillRender", { view: "music", params: {} }); f.els.viewContent.replaceChildren();
  assert.equal(f.overlay(), null, "route retirement must remove the body-level toolbar sheet");
  oldOption.click(); assert.deepEqual(f.selection, []);
});
test("reopening skips old focus and retires every old control", f => {
  const old = f.open(), option = f.options()[0], backdrop = f.document.querySelector(".mobile-action-sheet-backdrop");
  const other = f.document.createElement("button"); f.els.viewContent.append(other); other.focus();
  const next = f.open({ trigger: other }); const focused = f.document.activeElement;
  option.click(); backdrop.click(); old.closeButton.click(); const event = f.fire(old.overlay, "keydown", { key: "Escape" });
  assert.equal(event.defaultPrevented, false); assert.equal(old.close(), false);
  assert.equal(f.overlay(), next.overlay); assert.equal(f.document.activeElement, focused); assert.deepEqual(f.selection, []);
});
test("Back-closed options remain retired after reopening", f => {
  const old = f.open(), option = f.options()[0]; assert.equal(f.back(), true);
  const next = f.open(); option.click(); old.close();
  assert.equal(f.overlay(), next.overlay); assert.deepEqual(f.selection, []);
});
test("nonclosing async action continues after dismissal but cannot close its replacement", async f => {
  let finish, completed = 0, accepted = 0, closeAccepted;
  const pending = new Promise(resolve => { finish = resolve; });
  f.open({ options: [{ value: "async", label: "Async", closeOnSelect: false,
    select: (_value, button, close) => { accepted++; button.disabled = true; closeAccepted = close;
      pending.then(() => { completed++; close(); }); } }] });
  const button = f.options()[0]; button.click(); assert(f.overlay()); button.click(); assert.equal(accepted, 1);
  f.emit("fanhaoViewWillRender", { view: "music" });
  const next = f.open(); const focused = f.document.activeElement; finish(); await pending; await Promise.resolve();
  assert.equal(completed, 1, "already accepted async action must not be canceled by sheet retirement");
  assert.equal(closeAccepted(), false); assert.equal(f.overlay(), next.overlay); assert.equal(f.document.activeElement, focused);
});
test("nonclosing action can explicitly close its still-owned sheet", f => {
  f.open({ options: [{ value: "handoff", label: "Handoff", closeOnSelect: false,
    select: (_value, _button, close) => { assert.equal(close(), true); f.selection.push("accepted"); } }] });
  f.options()[0].click(); assert.equal(f.overlay(), null); assert.deepEqual(f.selection, ["accepted"]);
});
test("lifecycle listeners are installed once per window", f => {
  const before = new Map(["fanhaoViewWillRender", "pagehide"].map(type => [type, (f.listeners.get(type) || []).length]));
  f.open(); f.open(); f.open();
  for (const [type, count] of before) assert.equal(f.listeners.get(type).length, count + 1);
});
test("legacy shared overlay can be dismissed by the shell", f => {
  const legacy = f.document.createElement("div"); legacy.className = "mobile-action-sheet-overlay"; f.document.body.append(legacy);
  assert.equal(f.back(), true); assert.equal(f.overlay(), null); assert.equal(f.back(), false);
});

async function run(options = {}, only = "") {
  for (const entry of tests) {
    if (only && only !== entry.name) continue;
    const f = fixture(options);
    try { await entry.run(f); if (!only) cases++; }
    catch (error) { error.message = `${entry.name}: ${error.message}`; throw error; }
    finally { f.cleanup(); }
  }
}
try {
  await run();
  console.log(`Android shared action sheet: ${cases} actual sheet/module/toolbar/registry/app cases passed.`);
  const mutations = [
    ["native Back hook", { app: appSource.replace("  if (closeMobileActionSheet()) return true;", "  /* shared modal hook omitted */") },
      "actual people chrome consumes sheet Back before native root fallback", /shared sheet must consume native Back/],
    ["route retirement", { sheet: source.replace('  target.addEventListener("fanhaoViewWillRender", retire);', "  /* route retirement omitted */") },
      "actual search toolbar sheet cannot cover the next route", /route retirement must remove/],
    ["pagehide retirement", { sheet: source.replace('  target.addEventListener("pagehide", retire);', "  /* pagehide retirement omitted */") },
      "pagehide retires old sheet without focus stealing", /pagehide must retire/],
    ["active account retirement", { app: appSource.replace("  closeMobileActionSheet(false);", "  /* account retirement omitted */") },
      "account retires old sheet without focus stealing", /account must retire/],
    ["disabled option", { sheet: source.replace("if (!ownsSheet() || button.disabled) return;", "if (!ownsSheet()) return;") },
      "runtime-disabled retained option rejects a late click", /deep-equal/],
    ["retired callback", { sheet: source.replace("if (!ownsSheet() || button.disabled) return;", "if (button.disabled) return;") },
      "Back-closed options remain retired after reopening", /deep-equal/],
    ["lifecycle focus", { sheet: source.replace("activeSheet.close(false);", "activeSheet.close(true);") },
      "route retires old sheet without focus stealing", /reference-equal/],
    ["selected focus", { sheet: source.replace('(panel.querySelector(".mobile-action-sheet-option.active:not(:disabled)")\n    || panel.querySelector(".mobile-action-sheet-option:not(:disabled)") || closeButton).focus();',
      'panel.querySelector(".mobile-action-sheet-option.active:not(:disabled), .mobile-action-sheet-option:not(:disabled)")?.focus();') },
      "close restores the current opener focus", /actual selected option/]
  ];
  for (const [name, options, only, expected] of mutations) {
    assert((options.sheet && options.sheet !== source) || (options.app && options.app !== appSource), `${name}: mutation must change current source`);
    await assert.rejects(() => run(options, only), expected, `${name}: behavioral negative control survived`);
  }
  console.log(`Android shared action sheet: ${mutations.length} behavioral negative controls rejected.`);
} finally {
  elementPrototype.matches = basicMatches;
  globalThis.document = original.document; globalThis.window = original.window;
  globalThis.localStorage = original.localStorage; globalThis.fetch = original.fetch;
}

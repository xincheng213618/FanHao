import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { captureAccountOwner, isAccountOwnerCurrent, setAccountOwner } from "../android-client/www/js/account-owner.js";
import { normalizeUrl } from "../android-client/www/js/format.js";
import { appFunction, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

// Actual helper, shell functions and event registrations, with DOM/history/RAF
// and unrelated data rendering as controlled boundaries. No service or OS runs.
const read = path => fs.readFileSync(new URL("../" + path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const product = {
  app: read("android-client/www/app.js"),
  helper: read("android-client/www/js/settings-dialog-focus.js"),
  tools: read("android-client/www/modules/tools/tool-views.js")
};
const plain = code => code.replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
let sequence = 0;
function actualSlice(source, start, end) {
  const at = source.indexOf(start), to = source.indexOf(end, at);
  assert(at >= 0 && to > at, "Actual shell registration exists: " + start);
  return source.slice(at, to);
}

function fixture(input = product) {
  const document = createNavigationFixtureDocument(), nativeCreate = document.createElement;
  const Element = Object.getPrototypeOf(document.body).constructor;
  const focusCalls = [], frames = new Map(), allFrames = new Map(), listeners = new Map(), store = new Map();
  const observations = { renders: 0, backs: 0, accountReads: 0, sections: [], requests: 0, modeRetirements: 0 };
  let clock = 0;
  function decorate(node) {
    node.style = {}; node.disabled = false; node.inert = false; node.open = false; node.scrollTop = 0;
    Object.defineProperty(node, "isConnected", { get: () => document.body.contains(node) });
    Object.defineProperty(node, "parentElement", { get: () => node.parentNode?.tagName ? node.parentNode : null });
    Object.defineProperty(node, "tabIndex", {
      get() { const value = node.getAttribute("tabindex"); return value === null ? (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(node.tagName) || node.tagName === "A" && node.getAttribute("href") ? 0 : -1) : Number(value); },
      set(value) { node.setAttribute("tabindex", String(value)); }
    });
    const matches = node.matches, attribute = node.getAttribute, setAttribute = node.setAttribute;
    node.matches = selector => selector === ":disabled" ? Boolean(node.disabled || node.closest("fieldset")?.disabled) : matches.call(node, selector);
    node.getAttribute = name => ["hidden", "inert", "disabled", "open"].includes(name)
      ? (node[name] ? "" : null) : attribute.call(node, name);
    node.setAttribute = (name, value) => {
      setAttribute.call(node, name, value);
      if (["hidden", "inert", "disabled", "open"].includes(name)) node[name] = true;
    };
    // Explicit native visibility, independent of the product's availability
    // predicate. Inert/visibility:hidden keep geometry, as in the browser.
    node.getClientRects = () => {
      if (!node.isConnected || node.tagName === "INPUT" && node.type === "hidden") return [];
      for (let parent = node; parent; parent = parent.parentElement) {
        if (parent.hidden || parent.style?.display === "none") return [];
        if (parent.tagName === "DETAILS" && !parent.open) {
          const summary = parent.children.find(child => child.tagName === "SUMMARY");
          if (!summary?.contains(node)) return [];
        }
      }
      return [{}];
    };
    // Deliberately retain focus on hidden controls until another focus occurs.
    // Browser Back can run before rendering clears a hidden confirmation's
    // activeElement; resetting to BODY here would hide that real regression.
    node.focus = () => { focusCalls.push(node); document.activeElement = node; };
    node.scrollIntoView = () => observations.sections.push(node);
    return node;
  }
  decorate(document.body); document.activeElement = document.body;
  document.createElement = tag => decorate(nativeCreate(tag));
  const make = (tag, properties = {}, parent) => {
    const node = document.createElement(tag); Object.assign(node, properties); parent?.append(node); return node;
  };
  const main = make("main", {}, document.body);
  const trigger = make("button", { textContent: "设置入口" }, main);
  const outside = make("input", {}, main);
  const viewContent = make("div", {}, main), sentinel = make("p", { textContent: "原页面" }, viewContent);
  const alreadyInert = make("aside", { inert: true }, document.body);
  const overlay = make("div", { hidden: true }, document.body), backdrop = make("button", {}, overlay);
  const panel = make("section", {}, overlay), head = make("header", {}, panel), close = make("button", {}, head);
  const url = make("input", {}, panel), select = make("select", {}, panel), readonly = make("input", { readOnly: true }, panel);
  const account = make("details", { className: "settings-account-group" }, panel);
  const summary = make("summary", { className: "settings-group-title" }, account), accountInput = make("input", {}, account);
  const storage = make("section", { className: "storage-settings-group" }, panel);
  const storageHeading = make("strong", { className: "settings-group-title" }, storage), last = make("button", {}, panel);
  const disabled = make("button", { disabled: true }, panel);
  const hiddenGroup = make("div", { hidden: true }, panel), hidden = make("button", {}, hiddenGroup);
  const inertGroup = make("div", { inert: true }, panel), inert = make("button", {}, inertGroup);
  const invisible = make("button", {}, panel); invisible.style.visibility = "hidden";
  const fieldset = make("fieldset", { disabled: true }, panel), fieldsetInput = make("input", {}, fieldset);
  const hiddenInput = make("input", { type: "hidden" }, panel);
  const confirmOverlay = make("div", { hidden: true }, document.body), confirmBackdrop = make("button", {}, confirmOverlay);
  const confirmSheet = make("section", {}, confirmOverlay), cancel = make("button", {}, confirmSheet), accept = make("button", {}, confirmSheet);
  const els = {
    settingsOverlay: overlay, settingsPanel: panel, settingsCloseButton: close, settingsBackdrop: backdrop,
    profileSettingsButton: trigger, appConfirmOverlay: confirmOverlay, appConfirmSheet: confirmSheet,
    appConfirmBackdrop: confirmBackdrop, appConfirmCancelButton: cancel, appConfirmAcceptButton: accept,
    appConfirmMark: make("i", {}, confirmSheet), appConfirmTitle: make("strong", {}, confirmSheet), appConfirmMessage: make("p", {}, confirmSheet),
    viewContent, viewTitle: make("h2", {}, main), viewMeta: make("p", {}, main), viewKicker: make("p", {}, main),
    serverUrl: url, serverLabel: make("span", {}, main), quickServers: []
  };
  const A = normalizeUrl("https://settings-" + (++sequence) + "-a.invalid"), B = normalizeUrl("https://settings-" + sequence + "-b.invalid");
  setAccountOwner(A, "guest", { force: true }); setAccountOwner(B, "guest", { force: true });
  const base = { marker: "settings-fixture", view: "tools", params: {}, scrollY: 640 };
  const window = {
    scrollY: 640, history: { state: base, length: 3, back() { observations.backs++; },
      pushState(state) { this.state = state; }, replaceState(state) { this.state = state; } },
    requestAnimationFrame(callback) { const id = ++clock; frames.set(id, callback); allFrames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, callback) { const entries = listeners.get(type) || []; entries.push(callback); listeners.set(type, entries); },
    dispatchEvent(event) { for (const callback of [...listeners.get(event.type) || []]) callback(event); },
    getComputedStyle(node) { let visibility = "visible"; for (let current = node; current; current = current.parentElement) if (current.style?.visibility) { visibility = current.style.visibility; break; } return { visibility }; },
    location: { assign() { throw new Error("No external tool navigation"); } }
  };
  const no = () => {};
  const context = vm.createContext({
    window, document, HTMLElement: Element, Element, console, URL, URLSearchParams, normalizeUrl, captureAccountOwner, isAccountOwnerCurrent,
    els, activeUrl: A, currentView: "tools", currentViewParams: {}, viewRenderToken: 7, viewStack: [{ view: "works", marker: "keep-stack" }],
    HISTORY_MARKER: "settings-fixture", DEFAULT_VIEW: "people", STORAGE_KEY: "synthetic-server",
    RESTORABLE_VIEWS: new Set(["tools", "works", "people", "novels", "channel", "music"]),
    androidVersionInfo: {}, searchSurfaceExpanded: false, libraryLoadGeneration: 0, libraryLoadPromise: null, libraryLoadError: null,
    library: null, imageLibrarySummary: null, novelSummary: null, musicSummary: null, shortVideoSummary: null,
    workViews: null, toolViews: { refreshComputerControlAccess: no }, mediaViewer: { close: () => false },
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) },
    refreshAccountSettings() { observations.accountReads++; }, updateStorageStatus: no, updateServiceHealth: no, renderAndroidUpdateState: no,
    currentScrollY: () => window.scrollY, captureChannelRange: () => null, sanitizeViewParams: (_view, params) => ({ ...params }),
    viewRouteHash: (view, params) => "#" + view + "?" + new URLSearchParams(params), readViewStateFromHash: () => null,
    renderCurrentView() { observations.renders++; context.viewRenderToken++; viewContent.replaceChildren(make("p", { textContent: "新页面" })); },
    queueScrollRestore: no, shouldPreserveShortVideoHome: () => false, normalizeChannelMode: value => value,
    rememberHomeMode: no, rememberGalleryMode: no, rememberReadingMode: no, rememberViewState: no,
    closeHomeModePicker: no, closeGalleryModePicker: no, closeReadingModePicker: no,
    resetViewLimitsForView: no, restoreChannelRange: no, renderOmniSummary: no, syncConnectionControls: no,
    retireModePickerSession() { observations.modeRetirements++; }, cancelBottomNavPress: no,
    closeMobileActionSheet: () => false, closeActiveModePicker: () => false,
    androidModuleRegistry: { handleBack: () => false }, closeSearchSurface: no,
    isRootNavigationView: () => context.currentView === "tools", returnToStackView: () => false, applyBackState: no
  });
  vm.runInContext(plain(input.helper), context, { filename: "actual-settings-dialog-focus.js" });
  const names = ["captureSettingsFocusOwner", "isSettingsFocusOwnerCurrent", "sameViewParams", "showSettings", "hideSettingsSurface", "closeSettings",
    "restoreFromHistoryState", "showView", "routeHistoryState", "rememberCurrentScrollInHistory", "pushViewHistory", "replaceCurrentHistory", "updateServer",
    "requestAppConfirmation", "isAppConfirmationFocusCurrent", "settleAppConfirmation", "suspendAppConfirmationBackground", "restoreAppConfirmationBackground", "trapAppConfirmationFocus"];
  vm.runInContext(names.map(name => appFunction(input.app, name)).join("\n"), context);
  for (const name of ["pendingAppConfirmation", "appConfirmationGeneration", "closingSettingsSession", "settingsSourceRevision"]) {
    const declaration = new RegExp("^let " + name + " =[^\\n]+;", "m").exec(input.app);
    assert(declaration, name); vm.runInContext(declaration[0], context);
  }
  const initialize = /^const settingsDialogFocus = createSettingsDialogFocus\(\{[^]*?^\}\);/m.exec(input.app);
  assert(initialize); vm.runInContext(initialize[0], context);
  const profileBinding = /^els\.profileSettingsButton\?\.addEventListener\("click",[^\n]+/m.exec(input.app);
  assert(profileBinding); vm.runInContext(profileBinding[0], context);
  vm.runInContext(actualSlice(input.app, 'els.settingsCloseButton?.addEventListener', 'els.searchCloseButton?.addEventListener'), context);
  vm.runInContext(actualSlice(input.app, "window.fanhaoHandleNativeBack = () => {", "\napplyTheme("), context);
  const popBinding = /^window\.addEventListener\("popstate",[^\n]+/m.exec(input.app);
  assert(popBinding); vm.runInContext(popBinding[0], context);
  const focus = vm.runInContext("settingsDialogFocus", context);
  return {
    document, window, context, els, main, trigger, outside, sentinel, alreadyInert, base, A, B, store, observations, frames, allFrames, focusCalls, focus,
    controls: { url, select, readonly, summary, accountInput, storageHeading, last, disabled, hidden, inert, invisible, fieldsetInput, hiddenInput },
    open() { trigger.focus(); trigger.click(); },
    pop(state = base) { window.history.state = state; window.dispatchEvent({ type: "popstate", state }); },
    flush() { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(); },
    flushAll() { for (let count = 0; frames.size; count++) { assert(count < 12, "Bounded RAF chain"); this.flush(); } },
    fire(node, type, values = {}) { const event = { type, target: node, bubbles: true, defaultPrevented: false, ...values,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }; node.dispatchEvent(event); return event; }
  };
}

const cases = [];
const test = (name, run) => cases.push({ name, run });
test("real profile opening and Tab boundaries retain the modal with eligible controls only", f => {
  f.document.activeElement = f.document.body; f.trigger.click(); f.flushAll();
  assert(f.document.activeElement === f.els.settingsCloseButton);
  assert.equal(f.main.inert, true); assert.equal(f.alreadyInert.inert, true);
  for (const name of ["disabled", "hidden", "inert", "invisible", "fieldsetInput", "hiddenInput", "accountInput"]) assert.equal(f.focus.available(f.controls[name]), false, name);
  assert.equal(f.focus.available(f.controls.readonly), true); assert.equal(f.focus.available(f.controls.summary), true);
  f.controls.last.focus(); assert.equal(f.fire(f.controls.last, "keydown", { key: "Tab" }).defaultPrevented, true);
  assert(f.document.activeElement === f.els.settingsCloseButton);
  assert.equal(f.fire(f.els.settingsCloseButton, "keydown", { key: "Tab", shiftKey: true }).defaultPrevented, true);
  assert(f.document.activeElement === f.controls.last);
  f.controls.url.focus(); assert.equal(f.fire(f.controls.url, "keydown", { key: "Tab" }).defaultPrevented, false);
});
test("actual close plus same-base popstate preserves exact DOM and viewStack", f => {
  const stack = f.context.viewStack; f.open(); f.flushAll(); f.els.settingsCloseButton.click();
  assert.equal(f.els.settingsOverlay.hidden, true); assert.equal(f.observations.backs, 1); f.pop();
  assert(f.document.activeElement === f.trigger); assert(f.els.viewContent.children[0] === f.sentinel);
  assert(f.context.viewStack === stack); assert.equal(f.observations.renders, 0);
  assert.equal(f.main.inert, false); assert.equal(f.alreadyInert.inert, true);
});
test("browser Back during nested confirmation restores the trigger while hidden cancel still owns focus", async f => {
  f.open(); f.flushAll(); f.controls.url.focus();
  const confirmation = f.context.requestAppConfirmation({ title: "合成确认", message: "不执行操作" }); f.flushAll();
  assert(f.document.activeElement === f.els.appConfirmCancelButton);
  // Do not blur the hidden confirmation to BODY before actual history restore.
  f.pop(); assert.equal(await confirmation, false);
  assert.equal(f.els.settingsOverlay.hidden, true); assert.equal(f.els.appConfirmOverlay.hidden, true);
  assert(f.document.activeElement === f.trigger); assert.equal(f.main.inert, false);
  f.flushAll(); assert(f.document.activeElement === f.trigger);
});

test("real tools rows pass their exact trigger from BODY into actual settings open/close", async (f, input) => {
  vm.runInContext(plain(input.tools), f.context, { filename: "actual-settings-tool-views.js" });
  const received = [];
  const tools = f.context.createToolViews({
    els: f.els, setActiveBottom() {}, getActiveUrl: () => f.context.activeUrl,
    openSettings(options) { received.push(options); f.context.showSettings(options); },
    getComputerControlStatus: async () => ({ actions: [], platform: "unsupported" })
  });
  tools.renderTools();
  await Promise.resolve(); await Promise.resolve();
  const rows = f.els.viewContent.querySelector(".tools-settings-section").querySelectorAll("button");
  assert.equal(rows.length, 3);
  for (const [index, section] of ["account", undefined, "storage"].entries()) {
    f.document.activeElement = f.document.body; rows[index].click();
    assert(received[index].trigger === rows[index], "A touch-like click must capture its actual row without native focus");
    assert.equal(received[index].section, section); f.flushAll();
    const target = section === "account" ? f.controls.summary : section === "storage" ? f.controls.storageHeading : f.els.settingsCloseButton;
    assert(f.document.activeElement === target); f.els.settingsCloseButton.click(); f.pop();
    assert(f.document.activeElement === rows[index], "Closing returns to the row that opened this section");
  }
  assert.equal(f.observations.renders, 0);
});
test("section headings keep native middle Tab and no eligible controls use the panel fallback", f => {
  f.trigger.focus(); f.context.showSettings({ trigger: f.trigger, section: "storage", skipHistory: true }); f.flushAll();
  assert(f.document.activeElement === f.controls.storageHeading); assert.equal(f.controls.storageHeading.tabIndex, -1);
  const before = f.focusCalls.length;
  assert.equal(f.fire(f.controls.storageHeading, "keydown", { key: "Tab" }).defaultPrevented, false);
  assert.equal(f.focusCalls.length, before, "A non-boundary heading leaves real native Tab order alone");
  const account = f.els.settingsPanel.querySelector(".settings-account-group");
  account.open = true; assert.equal(f.focus.available(f.controls.accountInput), true);
  account.open = false; assert.equal(f.focus.available(f.controls.accountInput), false);
  for (const child of f.els.settingsPanel.children) child.hidden = true;
  assert.equal(f.fire(f.els.settingsPanel, "keydown", { key: "Tab" }).defaultPrevented, true);
  assert(f.document.activeElement === f.els.settingsPanel); assert.equal(f.els.settingsPanel.tabIndex, -1);
});
test("restoration accepts only the original live enabled and visible trigger", (_f, input) => {
  for (const condition of ["live", "disabled", "hidden", "inert", "visibility", "detached", "closed-details"]) {
    const f = fixture(input); f.open(); f.flushAll();
    if (condition === "disabled") f.trigger.disabled = true;
    if (condition === "hidden") f.trigger.hidden = true;
    if (condition === "inert") f.trigger.inert = true;
    if (condition === "visibility") f.trigger.style.visibility = "hidden";
    if (condition === "detached") f.trigger.remove();
    if (condition === "closed-details") {
      const group = f.document.createElement("details"); f.main.append(group); group.append(f.trigger);
    }
    const before = f.focusCalls.length; f.els.settingsCloseButton.click(); f.pop();
    assert.equal(f.els.settingsOverlay.hidden, true);
    if (condition === "live") assert(f.document.activeElement === f.trigger);
    else assert.equal(f.focusCalls.length, before, condition + ": no forbidden focus attempt");
    assert.equal(f.observations.renders, 0);
  }
});
test("a newer visible external focus during history close is never reclaimed", f => {
  f.open(); f.flushAll(); const stack = f.context.viewStack;
  f.els.settingsCloseButton.click(); f.outside.focus(); const before = f.focusCalls.length; f.pop();
  assert(f.document.activeElement === f.outside); assert.equal(f.focusCalls.length, before);
  assert(f.context.viewStack === stack); assert(f.els.viewContent.children[0] === f.sentinel);
});
test("closed and reopened sessions reject cancelled and manually delivered old opening frames", f => {
  f.open(); const old = [...f.frames.values()][0]; assert(old);
  f.els.settingsCloseButton.click(); assert.equal(f.frames.size, 0); f.pop();
  let before = f.focusCalls.length; old(); assert.equal(f.focusCalls.length, before);
  f.trigger.click(); const current = f.focus.current(); assert.equal(f.frames.size, 1);
  before = f.focusCalls.length; old();
  assert.equal(f.focusCalls.length, before); assert(f.focus.current() === current); assert.equal(f.frames.size, 1);
  f.flushAll(); assert(f.document.activeElement === f.els.settingsCloseButton);
});
test("opening frames respect a newer input focus and actual source/account ABA ownership", (_f, input) => {
  for (const change of ["input", "source", "source-ABA", "account-ABA", "token", "route", "media"]) {
    const f = fixture(input); f.open();
    if (change === "input") f.controls.url.focus();
    if (change === "source" || change === "source-ABA") f.context.updateServer(f.B);
    if (change === "source-ABA") f.context.updateServer(f.A);
    if (change === "account-ABA") {
      setAccountOwner(f.A, "account:other", { force: true }); setAccountOwner(f.A, "guest", { force: true });
    }
    if (change === "token") f.context.viewRenderToken++;
    if (change === "route") f.context.currentViewParams = { scope: "changed" };
    if (change === "media") f.document.body.classList.add("media-viewer-open");
    const before = f.focusCalls.length; f.flushAll(); assert.equal(f.focusCalls.length, before, change + ": stale opening cannot focus");
    f.context.closeSettings({ skipHistory: true }); assert.equal(f.els.settingsOverlay.hidden, true);
  }
});
test("different-route history and actual navigation hide without restoring an old trigger", (_f, input) => {
  for (const navigation of ["history", "showView"]) {
    const f = fixture(input); f.open(); const old = [...f.frames.values()][0]; f.flushAll();
    const before = f.focusCalls.length;
    if (navigation === "history") {
      f.els.settingsCloseButton.click(); f.pop({ ...f.base, view: "works", params: { scope: "other" }, scrollY: 123 });
      assert.equal(f.context.viewStack.length, 0);
    } else f.context.showView("works", { scope: "other" }, { skipHistory: true });
    assert.equal(f.els.settingsOverlay.hidden, true); assert.equal(f.context.currentView, "works");
    assert.equal(f.observations.renders, 1); assert.equal(f.sentinel.isConnected, false);
    old(); f.flushAll(); assert.equal(f.focusCalls.length, before);
  }
});
test("real Escape and NativeBack cancel the top confirmation before closing settings", async (_f, input) => {
  for (const action of ["Escape", "NativeBack"]) {
    const f = fixture(input); f.open(); f.flushAll(); f.controls.url.focus();
    const pending = f.context.requestAppConfirmation({ title: "仅测试关闭" }); f.flushAll();
    assert.equal(f.els.settingsOverlay.inert, true); assert(f.document.activeElement === f.els.appConfirmCancelButton);
    assert.equal(f.fire(f.els.appConfirmCancelButton, "keydown", { key: "Tab", shiftKey: true }).defaultPrevented, true);
    assert(f.document.activeElement === f.els.appConfirmAcceptButton);
    assert.equal(f.fire(f.controls.last, "keydown", { key: "Tab" }).defaultPrevented, false, "Underlying settings does not compete with confirmation");
    if (action === "Escape") f.fire(f.els.appConfirmAcceptButton, "keydown", { key: "Escape" });
    else assert.equal(f.window.fanhaoHandleNativeBack(), true);
    assert.equal(await pending, false); assert.equal(f.els.appConfirmOverlay.hidden, true);
    assert.equal(f.els.settingsOverlay.hidden, false); assert.equal(f.main.inert, true); assert.equal(f.els.settingsOverlay.inert, false);
    f.flushAll(); assert(f.document.activeElement === f.controls.url);
    if (action === "Escape") f.fire(f.controls.url, "keydown", { key: "Escape" });
    else assert.equal(f.window.fanhaoHandleNativeBack(), true);
    f.pop(); assert(f.document.activeElement === f.trigger);
  }
});
test("rapid navigation cancels nested confirmation and releases inert without late focus", async f => {
  f.open(); const opening = [...f.frames.values()][0];
  const pending = f.context.requestAppConfirmation({ title: "尚未显示的合成确认" });
  const confirmationFrame = [...f.frames.values()].at(-1);
  f.context.showView("works", {}, { skipHistory: true }); f.outside.focus();
  const before = f.focusCalls.length; opening(); confirmationFrame(); f.flushAll();
  assert.equal(await pending, false); assert.equal(f.els.settingsOverlay.hidden, true); assert.equal(f.els.appConfirmOverlay.hidden, true);
  assert.equal(f.main.inert, false); assert.equal(f.alreadyInert.inert, true);
  assert(f.document.activeElement === f.outside); assert.equal(f.focusCalls.length, before);
});
test("confirmation initial and double-RAF returns cannot own a reopened settings session", async f => {
  f.open(); f.flushAll(); f.controls.url.focus();
  const pending = f.context.requestAppConfirmation({ title: "旧确认" }), initial = [...f.frames.values()][0];
  f.flushAll(); f.context.settleAppConfirmation(false);
  const restoreFrame = [...f.frames.values()][0]; assert(restoreFrame);
  f.context.hideSettingsSurface(); f.document.activeElement = f.document.body;
  f.context.showSettings({ skipHistory: true, trigger: f.trigger });
  const before = f.focusCalls.length; initial(); restoreFrame();
  const oldInner = [...f.frames.values()].at(-1); assert(oldInner); oldInner();
  assert.equal(f.focusCalls.length, before, "An obsolete confirmation must not return into the new modal");
  f.flushAll(); assert.equal(await pending, false); assert(f.document.activeElement === f.els.settingsCloseButton);
});

function changed(field, mutate) {
  const value = mutate(product[field]); assert(value !== product[field], "Negative must alter actual " + field);
  return { ...product, [field]: value };
}
const controls = [
  { name: "settings keydown registration disconnected", scenario: 0, input: () => changed("app", text => text.replace('els.settingsOverlay?.addEventListener("keydown", settingsDialogFocus.trap);', "/* missing actual keydown binding */")) },
  { name: "trigger eligibility check removed", scenario: 5, input: () => changed("helper", text => text.replace("|| previous.trigger === document.body || !available(previous.trigger)", "|| previous.trigger === document.body")) },
  { name: "same-base history preservation disconnected", scenario: 1, input: () => changed("app", text => text.replace("if (settingsDialogFocus.owns(settingsSession) && settingsSession.owner.view === view", "if (false && settingsDialogFocus.owns(settingsSession) && settingsSession.owner.view === view")) },
  { name: "hidden confirmation mistaken for live user focus", scenario: 2, input: () => changed("helper", text => text.replace(" && available(active)", "")) },
  { name: "source ABA revision increment removed", scenario: 8, input: () => changed("app", text => text.replace("settingsSourceRevision += 1;", "/* missing source ABA revision */")) },
  { name: "tools native row loses explicit trigger", scenario: 3, input: () => changed("tools", text => text.replace("item.onOpen(button)", "item.onOpen()")) },
  { name: "Escape confirmation priority disconnected", scenario: 10, input: () => changed("app", text => text.replace('else if (!els.appConfirmOverlay?.hidden) settleAppConfirmation(false);', "else if (false) settleAppConfirmation(false);")) }
];
for (const { name, run } of cases) { await run(fixture(), product); console.log("settings-focus: " + name + ": ok"); }
for (const { name, scenario, input } of controls) {
  const mutation = input();
  await assert.rejects(async () => cases[scenario].run(fixture(mutation), mutation), { name: "AssertionError" }, name);
  console.log("REPRODUCED settings focus regression: " + name);
}
console.log("Android settings focus verification passed (" + cases.length + " actual helper/shell scenarios and " + controls.length + " effective controls; no browser, service or OS actions).");

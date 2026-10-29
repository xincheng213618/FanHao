import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoPanelLoadingController } from "../public/modules/short-videos/panel-loading-controller.js";
import { shouldHandleShortVideoShortcut } from "../public/modules/short-videos/playback-keyboard-policy.js";

// Exercise the page/action entry points with independently gated lazy modules.
// Navigation, repeated panel choices and module failures do not need a live
// browser, media file, service, application database or elapsed wall time.
const pageSource = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actionsSource = fs.readFileSync(new URL("../public/modules/short-videos/actions-controller.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function sourceFunction(source, name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, `missing current function: ${name}`);
  const end = source.indexOf("\n  }", match.index);
  assert(end > match.index, `missing function boundary: ${name}`);
  return source.slice(match.index, end + 4);
}
const implementation = [
  sourceFunction(pageSource, "captureShortVideoPanelContext"),
  sourceFunction(pageSource, "isCurrentShortVideoPanelContext"),
  sourceFunction(pageSource, "requestShortVideoPanel"),
  sourceFunction(pageSource, "cancelShortVideoPanelLoading"),
  sourceFunction(pageSource, "showPlaybackSettings"),
  sourceFunction(pageSource, "showAuthorPanel"),
  sourceFunction(pageSource, "showShortVideoSearchOverlay"),
  sourceFunction(pageSource, "closeShortVideoSearchOverlay"),
  sourceFunction(pageSource, "closePlaybackSettings"),
  sourceFunction(actionsSource, "shareShortVideo")
].join("\n");
const keyHandlerStart = pageSource.indexOf('    window.addEventListener("keydown", (event) => {');
const keyHandlerEnd = pageSource.indexOf('    document.addEventListener("visibilitychange",', keyHandlerStart);
assert(keyHandlerStart >= 0 && keyHandlerEnd > keyHandlerStart);
const keyHandlerSource = pageSource.slice(keyHandlerStart, keyHandlerEnd);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A superseded request may be cancelled before it calls the cached loader.
  // Keep its independent module gate observed while preserving its rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 32; turn++) await Promise.resolve(); }
function element(videoId = "A") {
  const classes = new Set();
  return {
    isConnected: true, dataset: { videoId }, attributes: new Map(), children: [],
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    contains: () => true,
    append(...children) { this.children.push(...children); children.forEach(child => { if (typeof child === "object") child.parentElement = this; }); }, addEventListener() {},
    querySelector(selector) {
      return this.children.find(child => child.isConnected && selector.split(",").some(part => String(child.className || "").split(/\s+/).includes(part.trim().slice(1)))) || null;
    },
    querySelectorAll: () => [], focus() {}, remove() { this.isConnected = false; },
    closest(selector) {
      if (selector.split(",").some(part => String(this.className || "").split(/\s+/).includes(part.trim().slice(1)))) return this;
      return this.parentElement?.closest?.(selector) || null;
    },
    classList: {
      contains: value => classes.has(value), add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value))
    }
  };
}

function fixture() {
  const gates = { settings: deferred(), author: deferred(), share: deferred() };
  const rendered = [], notices = [], loads = [], triggers = [];
  let keyHandler = null;
  const browser = element(), state = { activeView: "shortVideos", shortVideo: {
    current: { id: "A" }, mode: "feed", collectionId: "", query: "", source: "liked"
  } };
  browser.className = "short-video-browser";
  let panel = element(), epoch = 1;
  const scope = () => JSON.stringify([state.shortVideo.mode, state.shortVideo.collectionId, state.shortVideo.query, state.shortVideo.source]);
  const context = vm.createContext({
    state, Promise, shortVideoOpenRequestId: 1, shortVideoNavigationState: { id: "A", epoch },
    shortVideoFullscreenController: null, cancelShortVideoFullscreen() {},
    shortVideoNavigationScope: scope,
    activeReelStack: () => ({ querySelector: () => panel }),
    getBrowser: () => browser,
    els: { workGrid: { querySelector: selector => selector === ".short-video-browser" ? browser : browser.querySelector(selector) } },
    document: { createElement: element, activeElement: null, fullscreenElement: null },
    window: { addEventListener(name, handler) { if (name === "keydown") keyHandler = handler; }, requestAnimationFrame: () => 1 },
    shortVideoSearch: { renderForm: element, focus() {} }, createIcon: element,
    isolateShortVideoTransientModal() {}, restoreShortVideoTransientModalIsolation() {}, bindShortVideoModalFocusLoop() {},
    commitShortVideoSearch() {}, shouldHandleShortVideoShortcut,
    isShortVideoOverlayTarget: () => false, isGalleryPost: () => false, shortVideoWheelController: null,
    closeOrRevealBrowser() {}, closeAuthorPanel() {},
    ensureShortVideoPlaybackSettings: () => { loads.push("settings"); return gates.settings.promise; },
    ensureShortVideoAuthorPanel: () => { loads.push("author"); return gates.author.promise; },
    ensureShortVideoSharePanel: () => { loads.push("share"); return gates.share.promise; },
    showBrowserToast: message => notices.push(message), showToast: message => notices.push(message)
  });
  const controller = createShortVideoPanelLoadingController({
    captureContext: () => context.captureShortVideoPanelContext(),
    isCurrentContext: owner => context.isCurrentShortVideoPanelContext(owner),
    showError: (error, fallback) => notices.push(error?.message || fallback)
  });
  context.shortVideoPanelLoadingController = controller;
  context.requestPanel = options => controller.open(options);
  vm.runInContext(`${implementation}\n${keyHandlerSource}\nglobalThis.panelApi = { settings: showPlaybackSettings, author: showAuthorPanel, share: shareShortVideo, showShortVideoSearchOverlay, closeShortVideoSearchOverlay, closePlaybackSettings };`, context);
  const fixture = {
    state, browser, context, gates, rendered, notices, loads, controller,
    trigger() {
      const trigger = element(state.shortVideo.current.id);
      trigger.closest = selector => selector.includes("short-video-browser") ? browser : panel;
      triggers.push(trigger);
      return trigger;
    },
    open(kind, options = {}) { return context.panelApi[kind](state.shortVideo.current, options); },
    key(key, options = {}) {
      const event = { key, target: element(), preventDefault() { this.defaultPrevented = true; }, ...options };
      keyHandler(event);
      return event;
    },
    navigate(id) {
      epoch += 1;
      state.shortVideo.current = { id };
      context.shortVideoOpenRequestId += 1;
      context.shortVideoNavigationState = { id, epoch };
      panel = element(id);
      triggers.forEach(trigger => { trigger.isConnected = false; });
    },
    resolve(kind) {
      gates[kind].resolve((video, options = {}) => {
        rendered.push({ kind, id: video.id, current: state.shortVideo.current?.id, options });
      });
    },
    reject(kind, message = `${kind} failed`) { gates[kind].reject(new Error(message)); }
  };
  return fixture;
}

for (const kind of ["settings", "author", "share"]) {
  const f = fixture(), trigger = f.trigger();
  f.open(kind, { trigger });
  f.navigate("B");
  f.resolve(kind);
  await settle();
  assert.equal(f.rendered.length, 0, `${kind}: an old A module cannot mount a panel into B`);
  assert.equal(trigger.getAttribute("aria-busy"), null, `${kind}: navigation releases the old trigger busy state`);
}

for (const kind of ["settings", "author", "share"]) {
  const f = fixture();
  f.open(kind);
  f.navigate("B");
  f.navigate("A");
  f.resolve(kind);
  await settle();
  assert.equal(f.rendered.length, 0, `${kind}: A to B to A cannot revive the original pending panel intent`);
}

for (const [kind, firstOptions, lastOptions] of [
  ["settings", {}, { speedOnly: true }],
  ["settings", { speedOnly: true }, {}],
  ["author", { initialTab: "comments" }, { initialTab: "ai" }],
  ["share", {}, { source: "latest-share-button" }]
]) {
  const f = fixture(), trigger = f.trigger();
  f.open(kind, { trigger, ...firstOptions });
  f.open(kind, { trigger, ...lastOptions });
  f.resolve(kind);
  await settle();
  assert.equal(f.rendered.length, 1, `${kind}: repeated choices mount only the most recent panel`);
  for (const [key, value] of Object.entries(lastOptions)) assert.equal(f.rendered[0].options[key], value);
  assert.equal(Boolean(f.rendered[0].options.speedOnly), Boolean(lastOptions.speedOnly));
  assert.equal(trigger.getAttribute("aria-busy"), null);
}

for (const [oldKind, newKind] of [["settings", "author"], ["author", "share"], ["share", "settings"]]) {
  const f = fixture(), oldTrigger = f.trigger(), newTrigger = f.trigger();
  f.open(oldKind, { trigger: oldTrigger });
  f.open(newKind, { trigger: newTrigger });
  f.resolve(newKind);
  await settle();
  f.resolve(oldKind);
  await settle();
  assert.deepEqual(f.rendered.map(value => value.kind), [newKind], "late old imports cannot replace a newer requested panel type");
}

for (const kind of ["settings", "author", "share"]) {
  const f = fixture();
  f.open(kind, { trigger: f.trigger() });
  f.navigate("B");
  f.reject(kind);
  await settle();
  assert.equal(f.notices.length, 0, `${kind}: a stale import failure must not toast over another video`);
}

{
  const f = fixture(), trigger = f.trigger();
  f.open("settings", { trigger });
  f.open("share", { trigger });
  f.resolve("settings");
  await settle();
  assert.equal(trigger.getAttribute("aria-busy"), "true", "an old settings finally cannot clear the shared trigger owned by the pending share choice");
  f.resolve("share");
  await settle();
  assert.equal(trigger.getAttribute("aria-busy"), null);
}

for (const kind of ["settings", "author", "share"]) {
  const f = fixture(), trigger = f.trigger();
  f.open(kind, { trigger });
  f.reject(kind, "current import failed");
  await settle();
  assert.deepEqual(f.notices, ["current import failed"], `${kind}: the current failed panel still reports its error`);
  assert.equal(trigger.getAttribute("aria-busy"), null);
  f.gates[kind] = deferred();
  f.open(kind, { trigger });
  f.resolve(kind);
  await settle();
  assert.equal(f.rendered.length, 1, `${kind}: a current import failure permits a new request`);
}

for (const kind of ["settings", "author", "share"]) {
  const f = fixture(), trigger = f.trigger();
  f.open(kind, { trigger });
  assert.equal(f.controller.isPending(), true);
  f.controller.cancel();
  assert.equal(f.controller.isPending(), false);
  assert.equal(trigger.getAttribute("aria-busy"), null, "cancelling a pending panel releases its own loading affordance");
  f.resolve(kind);
  await settle();
  assert.equal(f.rendered.length, 0, `${kind}: a user-cancelled loading panel stays closed when its module arrives`);
}

for (const invalidate of [
  f => { f.state.shortVideo.query = "another feed"; },
  f => { f.context.shortVideoOpenRequestId += 1; },
  f => { f.context.shortVideoNavigationState = { id: "A", epoch: "new" }; },
  f => { f.state.activeView = "home"; },
  f => { f.browser.isConnected = false; }
]) {
  const f = fixture();
  f.open("settings", { trigger: f.trigger() });
  invalidate(f);
  f.resolve("settings");
  await settle();
  assert.equal(f.rendered.length, 0, "a panel belongs to its original navigation scope, page and DOM");
}

{
  const f = fixture();
  f.open("settings", { trigger: f.trigger() });
  f.resolve("settings");
  await settle();
  const isCurrent = f.rendered[0].options.isCurrent;
  assert.equal(typeof isCurrent, "function", "the actual panel receives a continuing request guard");
  assert.equal(isCurrent(), true, "successful mount does not immediately obsolete panel-internal asynchronous work");
  f.open("author", { trigger: f.trigger() });
  assert.equal(isCurrent(), false, "a newer panel intent invalidates asynchronous work from the earlier panel");
  f.resolve("author");
  await settle();
  assert.equal(f.rendered[1].options.isCurrent(), true);
  f.controller.cancel();
  assert.equal(f.rendered[1].options.isCurrent(), false, "explicit close also invalidates an already mounted panel request");
}

{
  let current = {}, mountedGuard = null;
  const errors = [];
  const controller = createShortVideoPanelLoadingController({
    captureContext: () => current, isCurrentContext: owner => owner === current,
    showError: error => errors.push(error)
  });
  await controller.open({
    load: async () => "loaded",
    show: (value, { isCurrent }) => {
      assert.equal(value, "loaded");
      controller.cancel(); // Closing/replacing old UI is part of this synchronous mount.
      assert.equal(isCurrent(), true, "synchronous mounting must not cancel itself through shared close helpers");
      mountedGuard = isCurrent;
    }
  });
  assert.equal(controller.isPending(), false);
  assert.equal(mountedGuard(), true);
  controller.cancel();
  assert.equal(mountedGuard(), false, "the same cancel must work again after mounting has returned");
  assert.equal(errors.length, 0);
}

{
  const oldRender = deferred(), oldLoad = deferred(), latestLoad = deferred(), notices = [];
  const current = {}, controller = createShortVideoPanelLoadingController({
    captureContext: () => current, isCurrentContext: owner => owner === current,
    showError: error => notices.push(error.message)
  });
  const oldRequest = controller.open({ load: () => oldLoad.promise, show: () => oldRender.promise });
  oldLoad.resolve("old module");
  await settle();
  const latestRequest = controller.open({ load: () => latestLoad.promise, show() {} });
  oldRender.reject(new Error("obsolete async render failure"));
  await oldRequest;
  assert.equal(notices.length, 0, "an old asynchronous panel failure cannot toast after another intent owns the UI");
  latestLoad.resolve("latest module");
  await latestRequest;
}

{
  const f = fixture(), trigger = f.trigger();
  f.open("settings", { trigger });
  const event = f.key("Escape");
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.controller.isPending(), false, "the page's actual Escape handler cancels pending lazy panels");
  f.resolve("settings");
  await settle();
  assert.equal(f.rendered.length, 0);
  assert.equal(trigger.getAttribute("aria-busy"), null);
}

{
  const f = fixture();
  f.open("settings");
  f.key("Escape", { ctrlKey: true });
  assert.equal(f.controller.isPending(), true, "the page preserves browser-reserved modified key events");
  f.resolve("settings");
  await settle();
  assert.equal(f.rendered.length, 1);
}

{
  const f = fixture();
  f.open("settings", { trigger: f.trigger() });
  f.context.panelApi.showShortVideoSearchOverlay(f.trigger());
  assert(f.browser.querySelector(".short-video-search-overlay"), "the actual search action still mounts search");
  assert.equal(f.controller.isPending(), false, "opening search cancels an earlier lazy settings choice");
  f.resolve("settings");
  await settle();
  assert.equal(f.rendered.length, 0, "a late settings import cannot cover the newer search overlay");
}

for (const [className, close] of [
  ["short-video-more-overlay", "closePlaybackSettings"],
  ["short-video-search-overlay", "closeShortVideoSearchOverlay"]
]) {
  const f = fixture(), overlay = element();
  overlay.className = className;
  f.browser.append(overlay);
  f.open("author", { trigger: f.trigger() });
  f.context.panelApi[close](overlay, { restoreFocus: false });
  assert.equal(f.controller.isPending(), false, `${close}: actual close handlers cancel pending panel work`);
  f.resolve("author");
  await settle();
  assert.equal(f.rendered.length, 0);
}

{
  const f = fixture(), overlay = element();
  overlay.className = "short-video-more-overlay";
  f.browser.append(overlay);
  let mountedGuard;
  await f.controller.open({
    load: async () => true,
    show: (_, { isCurrent }) => {
      f.context.panelApi.closePlaybackSettings(overlay, { restoreFocus: false });
      mountedGuard = isCurrent;
      assert.equal(isCurrent(), true, "actual synchronous old-panel cleanup cannot cancel the incoming panel that owns the mount");
    }
  });
  assert.equal(overlay.isConnected, false);
  assert.equal(mountedGuard(), true);
  f.controller.cancel();
  assert.equal(mountedGuard(), false);
}

console.log("Short-video lazy panel loading ownership checks passed.");

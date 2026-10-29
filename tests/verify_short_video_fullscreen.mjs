import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoFullscreenController } from "../public/modules/short-videos/fullscreen-controller.js";
import { shouldHandleShortVideoShortcut } from "../public/modules/short-videos/playback-keyboard-policy.js";

// Independently control native requests and fullscreenchange events. No real
// browser, user activation, media, service or database is used by this fixture.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 32; turn++) await Promise.resolve(); }
function fixture() {
  const entries = [], exits = [], errors = [], changes = [];
  let target;
  const document = {
    fullscreenElement: null,
    exitFullscreen() {
      const request = { ...deferred(), target: document.fullscreenElement };
      exits.push(request);
      return request.promise;
    }
  };
  const grid = {
    isConnected: true,
    requestFullscreen() {
      const request = { ...deferred(), target: grid };
      entries.push(request);
      return request.promise;
    }
  };
  target = grid;
  const controller = createShortVideoFullscreenController({
    document, getTarget: () => target,
    onChange: () => changes.push({ pending: controller.isPending(), active: controller.isActive() }),
    onError: (error, phase) => errors.push({ error, phase })
  });
  return {
    controller, grid, document, entries, exits, errors, changes,
    leave() { target = null; },
    returnToViewer() { target = grid; },
    change(element) { document.fullscreenElement = element; return controller.changed(); },
    enter(index = entries.length - 1, { native = true } = {}) {
      if (native) document.fullscreenElement = entries[index].target;
      entries[index].resolve();
    },
    exit(index = exits.length - 1) {
      if (document.fullscreenElement === exits[index].target) document.fullscreenElement = null;
      exits[index].resolve();
    }
  };
}

{
  const f = fixture();
  const request = f.controller.toggle();
  assert.equal(f.entries.length, 1, "the native enter API must run synchronously on the initial click stack");
  assert.equal(f.controller.isPending(), true);
  f.enter();
  await request;
  assert.equal(f.controller.isActive(), true);
  assert.equal(f.controller.isPending(), false);
  assert.equal(f.errors.length, 0);
  const exit = f.controller.toggle();
  assert.equal(f.exits.length, 1);
  f.exit();
  await exit;
  assert.equal(f.controller.isActive(), false);
}

for (const toggles of [2, 3, 8, 9]) {
  const f = fixture(), requests = [];
  for (let count = 0; count < toggles; count++) requests.push(f.controller.toggle());
  assert.equal(f.entries.length, 1, "rapid toggles share the native enter already in flight");
  f.enter();
  await settle();
  if (toggles % 2 === 0) {
    assert.equal(f.exits.length, 1, "the latest even toggle compensates a late native enter once");
    f.exit();
  } else assert.equal(f.exits.length, 0, "the latest odd toggle retains the first native enter");
  await Promise.all(requests);
  assert.equal(f.controller.isActive(), toggles % 2 === 1);
  assert.equal(f.controller.isPending(), false);
}

{
  const f = fixture(), request = f.controller.toggle();
  f.leave();
  const cancelled = f.controller.cancel();
  f.enter();
  await settle();
  assert.equal(f.exits.length, 1, "leaving the viewer compensates its late successful native entry");
  assert.equal(f.exits[0].target, f.grid);
  f.exit();
  await Promise.all([request, cancelled]);
  assert.equal(f.document.fullscreenElement, null);
  assert.equal(f.errors.length, 0);
}

{
  const f = fixture(), first = f.controller.toggle();
  f.controller.toggle(); // The user has cancelled entering with another F.
  f.entries[0].reject(new Error("superseded native entry denied"));
  await first;
  assert.equal(f.errors.length, 0, "an obsolete enter failure cannot toast over the newer off intent");
  assert.equal(f.controller.isPending(), false);
}

{
  const f = fixture(), request = f.controller.toggle();
  f.leave();
  f.controller.cancel();
  f.entries[0].reject(new Error("left viewer"));
  await request;
  assert.equal(f.errors.length, 0, "old failures after leaving the viewer are silent");
}

{
  const f = fixture(), request = f.controller.toggle();
  const foreign = { isConnected: true };
  f.leave();
  f.controller.cancel();
  f.document.fullscreenElement = foreign;
  f.enter(0, { native: false });
  await request;
  assert.equal(f.exits.length, 0, "late cleanup cannot exit somebody else's fullscreen element");
  assert.equal(f.document.fullscreenElement, foreign);
}

{
  const f = fixture(), foreign = { isConnected: true };
  f.document.fullscreenElement = foreign;
  assert.equal(f.controller.isActive(), false);
  const request = f.controller.toggle();
  assert.equal(f.exits.length, 0, "an explicit click to enter our viewer must not call exitFullscreen on a foreign element");
  assert.equal(f.entries.length, 1);
  f.enter();
  await request;
  assert.equal(f.controller.isActive(), true);
}

{
  const f = fixture(), request = f.controller.toggle();
  f.enter();
  await request;
  await f.change(null); // Browser Escape.
  assert.equal(f.controller.isActive(), false);
  assert.equal(f.entries.length, 1, "native Escape cannot trigger automatic re-entry");
  assert.equal(f.exits.length, 0);
}

{
  const f = fixture(), request = f.controller.toggle();
  f.change(f.grid);
  f.change(null); // Native entry and Escape happened before its promise settled.
  f.enter(0, { native: false });
  await request;
  assert.equal(f.entries.length, 1);
  assert.equal(f.exits.length, 0);
  assert.equal(f.controller.isActive(), false, "a late fulfilled promise cannot undo native Escape");
}

{
  const f = fixture(), first = f.controller.toggle();
  f.enter();
  await first;
  const leaving = f.controller.toggle();
  const returning = f.controller.toggle();
  assert.equal(f.entries.length, 1, "an exit in flight serializes a newer enter choice");
  f.exit();
  await settle();
  assert.equal(f.entries.length, 2);
  f.enter();
  await Promise.all([leaving, returning]);
  assert.equal(f.controller.isActive(), true);
}

{
  const f = fixture(), oldRequest = f.controller.toggle();
  f.leave();
  f.controller.cancel();
  f.returnToViewer();
  const latestRequest = f.controller.toggle();
  f.enter(0);
  await settle();
  assert.equal(f.exits.length, 1, "returning to the same reused grid cannot adopt the previous viewer session's request");
  f.exit();
  await settle();
  assert.equal(f.entries.length, 2, "the new explicit intent enters only after the old session has been cleaned up");
  f.enter(1);
  await Promise.all([oldRequest, latestRequest]);
  assert.equal(f.controller.isActive(), true);
  assert.equal(f.errors.length, 0);
}

{
  const f = fixture(), request = f.controller.toggle();
  f.enter();
  await request;
  f.leave();
  const cancelled = f.controller.cancel();
  f.exits[0].reject(new Error("cleanup exit rejected"));
  await cancelled;
  assert.equal(f.exits.length, 1, "failed cleanup must not spin through repeated native exits");
  assert.equal(f.errors.length, 0, "cleanup failure does not toast over another page");
  assert.equal(f.controller.isPending(), false);
}

for (const kind of ["enter", "exit"]) {
  const f = fixture();
  if (kind === "exit") {
    const enter = f.controller.toggle(); f.enter(); await enter;
    f.document.exitFullscreen = undefined;
  } else f.grid.requestFullscreen = undefined;
  await f.controller.toggle();
  assert.equal(f.errors.length, 1, `the current missing ${kind} API still reports its problem`);
  assert.equal(f.errors[0].phase, kind);
  assert.equal(f.errors[0].error.name, "NotSupportedError");
  assert.equal(f.controller.isPending(), false);
}

{
  const f = fixture();
  const request = f.controller.toggle();
  f.entries[0].reject(Object.assign(new Error("permission denied"), { name: "NotAllowedError" }));
  await request;
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].phase, "enter");
  const retry = f.controller.toggle();
  assert.equal(f.entries.length, 2, "a denied current request still allows an explicit retry");
  f.enter();
  await retry;
  assert.equal(f.controller.isActive(), true);
}

const pageSource = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function pageFunction(name, required = true) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(pageSource);
  if (!match && !required) return "";
  assert(match, `missing current page function: ${name}`);
  return pageSource.slice(match.index, pageSource.indexOf("\n  }", match.index) + 4);
}
const pageImplementation = [
  ...["activeShortVideoFullscreenTarget", "shortVideoFullscreenActive", "toggleShortVideoFullscreen",
    "syncShortVideoFullscreenControls", "syncShortVideoFullscreenControl", "handleShortVideoFullscreenChange", "syncShortVideoNativePlaybackModes",
    "cancelShortVideoNativePlaybackModes", "showHome", "refreshShortVideoHome", "renderView"].map(name => pageFunction(name)),
  pageFunction("ensureShortVideoFullscreenController", false), pageFunction("cancelShortVideoFullscreen", false)
].join("\n");
const keyHandlerStart = pageSource.indexOf('    window.addEventListener("keydown", (event) => {');
const keyHandlerEnd = pageSource.indexOf('    document.addEventListener("visibilitychange",', keyHandlerStart);
assert(keyHandlerStart >= 0 && keyHandlerEnd > keyHandlerStart);
const keyHandlerSource = pageSource.slice(keyHandlerStart, keyHandlerEnd);
function pageFixture() {
  const f = fixture(), notices = [], events = new Map();
  let browserPresent = true;
  const browser = { isConnected: true, classList: { contains: () => false } };
  f.grid.querySelector = selector => selector === ".short-video-browser" && browserPresent ? browser : null;
  f.grid.querySelectorAll = () => [];
  Object.defineProperty(f.grid, "innerHTML", { set() { browserPresent = false; } });
  const state = { activeView: "shortVideos", shortVideo: { current: { id: "A" }, data: {}, mode: "feed" } };
  const context = vm.createContext({
    state, document: f.document, els: { workGrid: f.grid }, createShortVideoFullscreenController,
    shortVideoFullscreenController: null, shortVideoPictureInPictureController: null, shortVideoHomePresentation: null,
    shortVideoOpenRequestId: 1, shortVideoOpeningId: "", shortVideoOpenError: "", authorPanelReturnFeed: null,
    collectionsController: { returnFromCollectionVideo: () => false },
    window: { addEventListener: (name, handler) => events.set(name, handler) },
    ensureState() {}, releaseUnusedShortVideoPreloads() {}, cancelShortVideoNavigation() {}, flushActiveShortVideoWatch() {}, setBodyClass() {}, renderStats() {},
    cancelShortVideoPanelLoading() {}, stopShortVideoSoundPreview() {}, cancelShortVideoAutoNext() {}, cancelShortVideoBrowseGestures() {},
    resetShortVideoWindow() {}, clearPendingPlayerClick() {}, disposeShortVideoMedia() {},
    clearAuthorPanelCaches() {},
    transcodeManagementPage: { stop() {}, render() {} }, renderLikeDistributionPage() {}, renderHome() {},
    renderBrowser() { browserPresent = true; }, renderBrowserLoading() {}, pushRoute() {},
    loadVideos: async () => {}, showError() {}, showBrowserToast: message => notices.push(message),
    shouldHandleShortVideoShortcut, shortVideoWheelController: null, isShortVideoOverlayTarget: () => false,
    isGalleryPost: () => false, closeOrRevealBrowser() {}
  });
  const pagehide = pageSource.split("\n").find(line => line.includes('window.addEventListener("pagehide", cancelShortVideoNativePlaybackModes)'));
  const fullscreenchange = pageSource.split("\n").find(line => line.includes('document.addEventListener("fullscreenchange", handleShortVideoFullscreenChange)'));
  assert(pagehide && fullscreenchange, "the page must register native mode lifecycle handlers");
  f.document.addEventListener = (name, handler) => events.set(name, handler);
  vm.runInContext(`${pageImplementation}\n${keyHandlerSource}\n${pagehide}\n${fullscreenchange}\nglobalThis.fullscreenApi = { toggleShortVideoFullscreen, shortVideoFullscreenActive, showHome, renderView, handleShortVideoFullscreenChange, cancelShortVideoNativePlaybackModes };`, context);
  return { ...f, context, state, notices, events, api: context.fullscreenApi,
    key(key, options = {}) {
      const event = { key, target: { closest: () => null }, preventDefault() { this.defaultPrevented = true; }, ...options };
      events.get("keydown")(event); return event;
    }
  };
}

{
  const f = pageFixture(), request = f.api.toggleShortVideoFullscreen();
  assert.equal(f.entries.length, 1, "the actual page wrapper preserves synchronous native activation");
  f.api.showHome();
  assert.equal(f.state.shortVideo.current, null);
  f.enter();
  await settle();
  assert.equal(f.exits.length, 1, "actual showHome/renderView lifecycle compensates a delayed native enter");
  f.exit();
  await request;
  assert.equal(f.api.shortVideoFullscreenActive(), false);
  assert.equal(f.document.fullscreenElement, null);
  assert.equal(f.notices.length, 0);
}

{
  const f = pageFixture(), request = f.api.toggleShortVideoFullscreen();
  f.enter();
  await request;
  f.state.shortVideo.current = { id: "B" };
  f.api.renderView();
  assert.equal(f.entries.length, 1);
  assert.equal(f.exits.length, 0, "a rebuilt reel inside the same stable viewer grid retains fullscreen");
  assert.equal(f.api.shortVideoFullscreenActive(), true);
  f.document.fullscreenElement = null;
  f.events.get("fullscreenchange")();
  await settle();
  assert.equal(f.api.shortVideoFullscreenActive(), false);
  assert.equal(f.entries.length, 1, "the actual native Escape listener cannot reopen fullscreen");
}

{
  const f = pageFixture(), request = f.api.toggleShortVideoFullscreen();
  f.enter();
  await request;
  f.events.get("pagehide")();
  assert.equal(f.exits.length, 1, "actual pagehide exits the native surface owned by this viewer");
  f.exit();
  await settle();
  assert.equal(f.context.shortVideoFullscreenController.isPending(), false);
}

for (const mode of ["likes", "transcoding"]) {
  const f = pageFixture(), request = f.api.toggleShortVideoFullscreen();
  f.state.shortVideo.mode = mode;
  f.api.renderView();
  f.enter();
  await settle();
  assert.equal(f.exits.length, 1, `${mode}: rendering another short-video surface invalidates its pending viewer fullscreen`);
  f.exit();
  await request;
}

{
  const f = pageFixture(), request = f.api.toggleShortVideoFullscreen();
  f.api.showHome();
  f.entries[0].reject(new Error("late old request failed"));
  await request;
  assert.equal(f.notices.length, 0, "the actual page does not report an obsolete fullscreen failure on its home view");
}

{
  const f = pageFixture(), request = f.api.toggleShortVideoFullscreen();
  f.key("Escape");
  f.enter();
  await settle();
  assert.equal(f.exits.length, 1, "the actual Escape handler cancels a native enter that has not produced a fullscreenchange event yet");
  f.exit(); await request;
  assert.equal(f.document.fullscreenElement, null);
}

{
  const f = pageFixture();
  f.document.fullscreenElement = f.grid;
  f.key("Escape");
  assert.equal(f.exits.length, 1, "Escape can adopt and exit the current viewer's native surface before its lazy controller has been created");
  f.exit(); await settle();
  assert.equal(f.document.fullscreenElement, null);
}

{
  const f = pageFixture(), foreign = { classList: { contains: value => value === "short-video-browser" } };
  f.document.fullscreenElement = foreign;
  assert.equal(f.api.shortVideoFullscreenActive(), false, "the actual fullscreen indicator uses the exact owned surface, not another matching CSS class");
  f.key("Escape");
  assert.equal(f.exits.length, 0, "the actual Escape handler cannot exit another feature's fullscreen surface");
  assert.equal(f.document.fullscreenElement, foreign);
}

console.log("Short-video fullscreen native ownership checks passed.");

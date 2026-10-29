import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoPlaybackSettings } from "../public/modules/short-videos/playback-settings.js";
import { formatPlaybackRate, normalizePlaybackRate } from "../public/modules/short-videos/state.js";
import { createShortVideoPictureInPictureController } from "../public/modules/short-videos/picture-in-picture-controller.js";

// Render the actual settings UI against the existing controlled DOM helper.
// Native mode state and user-activation timing are explicit; no service or media.
const helperFile = new URL("./verify_short_video_playback_settings.mjs", import.meta.url);
let helper = fs.readFileSync(helperFile, "utf8");
helper = helper.slice(0, helper.indexOf("\nfunction fixture("));
helper = helper.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helperFile).href}"`);
const { Element } = await import(`data:text/javascript;base64,${Buffer.from(`${helper}\nexport { Element };`).toString("base64")}`);
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const page = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8");
const pageFunctions = ["shortVideoPictureInPicturePlayer", "ensureShortVideoPictureInPictureController",
  "shortVideoPictureInPictureState", "toggleShortVideoPictureInPicture", "syncShortVideoPictureInPictureControls",
  "handleShortVideoPictureInPictureChange"].map(name => {
  const start = page.indexOf(`  function ${name}(`), end = page.indexOf("\n  function ", start + 5);
  assert(start >= 0 && end > start);
  return page.slice(start, end);
}).join("\n");
const nativeBindings = page.match(/^    document.addEventListener\("(?:enterpictureinpicture|leavepictureinpicture)", handleShortVideoPictureInPictureChange, true\);$/gm);
assert.equal(nativeBindings?.length, 2, "both native PiP transitions must reach the actual page controller");

function fixture(initial = {}, usePage = false) {
  globalThis.document = {
    activeElement: null,
    createElement: tag => new Element(tag),
    createTextNode: text => { const node = new Element("#text"); node.textContent = text; return node; },
    exitPictureInPicture() { throw new Error("the UI must delegate native mode operations"); }
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const browser = new Element("div"); browser.connected = true;
  const trigger = new Element("button"); browser.append(trigger);
  const video = { id: "A", actions: {} };
  const state = { activeView: "shortVideos", shortVideo: { current: video, playbackRate: 1, autoNext: false } };
  const firstPlayer = { requestPictureInPicture() { throw new Error("the UI must delegate native mode operations"); } };
  let currentPlayer = firstPlayer, ownerCurrent = true;
  const status = { supported: true, active: false, pending: false, ...initial };
  const calls = [], requests = [], nativeListeners = new Map();
  const emitNative = (type, player = firstPlayer) => nativeListeners.get(type)?.({ type, target: player });
  const overlay = () => browser.querySelector(".short-video-more-overlay");
  const deps = {
    state, playbackRates: [.5, .75, 1, 1.25, 1.5, 2], formatPlaybackRate, normalizePlaybackRate,
    activePlayer: () => currentPlayer, getBrowser: () => browser, getWorkGrid: () => browser,
    isCurrentShortVideo: item => item?.id === state.shortVideo.current?.id,
    isGalleryPost: () => false,
    createIcon: () => new Element("span"), isolateShortVideoTransientModal() {}, bindShortVideoModalFocusLoop() {},
    focusShortVideoTransientModal: (_sheet, target) => target.focus(),
    closePlaybackSettings: (node, options) => { calls.push({ type: "close", node, options }); node.remove(); },
    shortVideoPictureInPictureState: () => ({ ...status }),
    toggleShortVideoPictureInPicture: expectedPlayer => {
      const request = { expectedPlayer, kind: status.active ? "exit" : "enter", connectedAtCall: Boolean(overlay()?.isConnected) };
      calls.push({ type: "toggle", request }); requests.push(request);
      status.pending = true;
      request.promise = new Promise(resolve => { request.resolve = resolve; });
      return request.promise;
    },
    syncShortVideoFullscreenControl() {}, syncActivePlaybackMode() {}, writeAutoNextPreference() {},
    originalDouyinUrl: () => "", setPlaybackRate() {}, showBrowserToast() {},
    toggleClearScreen() {}, toggleShortVideoFullscreen() {},
    shareShortVideo() {}, runShortVideoLocalAction() {}, openDouyinLink() {},
    deleteShortVideo: async () => { throw new Error("unexpected delete"); },
    toggleShortVideoDislike: async () => false, loadVideos: async () => {}, openAdjacent: async () => {},
    showError(error) { throw error; }
  };
  if (usePage) {
    Object.assign(firstPlayer, {
      tagName: "VIDEO", isConnected: true, readyState: 3, error: null, src: "/fixture/A",
      dataset: { videoId: "A", shortVideoSlot: "current", shortVideoSourceGeneration: "1" },
      classList: { contains: () => false }, getAttribute(name) { return name === "src" ? this.src : null; },
      pause() {},
      requestPictureInPicture() {
        const request = { kind: "enter", connectedAtCall: Boolean(overlay()?.isConnected) };
        calls.push({ type: "native-enter", request }); requests.push(request);
        const promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
        return promise.then(() => { document.pictureInPictureElement = firstPlayer; emitNative("enterpictureinpicture"); });
      }
    });
    document.pictureInPictureEnabled = true;
    document.pictureInPictureElement = null;
    document.addEventListener = (type, listener, capture) => { assert.equal(capture, true); nativeListeners.set(type, listener); };
    document.exitPictureInPicture = () => {
      const player = document.pictureInPictureElement;
      calls.push({ type: "native-exit", player, connectedAtCall: Boolean(overlay()?.isConnected) });
      document.pictureInPictureElement = null; emitNative("leavepictureinpicture", player);
      return Promise.resolve();
    };
    const env = {
      document, state, activePlayer: () => currentPlayer, isGalleryPost: () => false,
      createShortVideoPictureInPictureController,
      showBrowserToast: text => calls.push({ type: "error", text }),
      els: { workGrid: { querySelectorAll: () => browser.querySelectorAll("button").filter(button => button.dataset.shortVideoPictureInPictureControl) } }
    };
    const bridge = vm.runInNewContext(`let shortVideoPictureInPictureController = null;\n${pageFunctions}\n${nativeBindings.join("\n")}\n({ shortVideoPictureInPictureState, toggleShortVideoPictureInPicture });`, env);
    deps.shortVideoPictureInPictureState = bridge.shortVideoPictureInPictureState;
    deps.toggleShortVideoPictureInPicture = bridge.toggleShortVideoPictureInPicture;
  }
  const show = createShortVideoPlaybackSettings(deps);
  const reopen = () => {
    show(video, { trigger, isCurrent: () => ownerCurrent });
    return overlay().querySelectorAll("button").find(item => item.dataset.shortVideoPictureInPictureControl === "settings");
  };
  reopen();
  const node = overlay();
  const button = node.querySelectorAll("button").find(item => item.dataset.shortVideoPictureInPictureControl === "settings");
  assert(button, "the settings PiP control participates in the shared native-state sync");
  return { browser, trigger, video, state, status, firstPlayer, calls, requests, button, node, reopen, emitNative,
    sync: () => button.shortVideoSyncPictureInPicture(),
    setPlayer: player => { currentPlayer = player; },
    invalidateOwner: () => { ownerCurrent = false; } };
}

const label = f => f.button.querySelector("b").textContent;
const detail = f => f.button.querySelector("small").textContent;
const previousDocument = globalThis.document, previousWindow = globalThis.window;
try {
  {
    const f = fixture({ active: true });
    assert.equal(label(f), "退出画中画");
    assert.equal(f.button.getAttribute("aria-pressed"), "true");
    f.status.active = false; // Model native close while the settings stay open.
    f.sync();
    assert.equal(label(f), "画中画");
    assert.equal(f.button.title, "画中画");
    assert.equal(f.button.getAttribute("aria-label"), "画中画");
    assert.equal(f.button.getAttribute("aria-pressed"), "false");
    assert.equal(f.button.disabled, false);
    f.button.click();
    assert.deepEqual(f.calls.map(call => call.type), ["toggle", "close"]);
    assert.equal(f.requests[0].kind, "enter", "a native close must not leave the old exit branch captured in the action");
    assert.equal(f.requests[0].expectedPlayer, f.firstPlayer);
    assert.equal(f.requests[0].connectedAtCall, true, "native mode is requested synchronously before dialog closure");
    assert.deepEqual(f.calls[1].options, { restoreFocus: false });
    f.requests[0].resolve(true); await settle();
    assert.equal(f.node.isConnected, false, "settling the independent request cannot reopen the settings");
  }
  {
    const f = fixture();
    f.status.active = true; // Model a native entry after the menu snapshot.
    f.button.click();
    assert.equal(f.requests[0].kind, "exit", "clicks reread current state even before the external sync callback runs");
    f.requests[0].resolve(true); await settle();
  }
  {
    const f = fixture({ supported: true, ready: false });
    assert.equal(f.button.disabled, true);
    assert.equal(detail(f), "视频加载后可用");
    f.status.ready = true; f.sync();
    assert.equal(f.button.disabled, false);
    f.status.pending = true; f.sync();
    assert.equal(f.button.disabled, true);
    assert.equal(f.button.getAttribute("aria-busy"), "true");
    assert.equal(detail(f), "正在打开画中画");
    f.button.dispatchEvent(new Event("click"));
    assert.deepEqual(f.calls, [], "pending operations cannot be duplicated even by a programmatic click");
    f.status.pending = false; f.status.supported = false; f.status.ready = false; f.status.active = true; f.sync();
    assert.equal(f.button.getAttribute("aria-busy"), "false");
    assert.equal(f.button.disabled, false, "an active window can be exited even when entry readiness/capability is no longer available");
    assert.equal(label(f), "退出画中画");
  }
  {
    const f = fixture({ supported: false });
    assert.equal(f.button.disabled, true);
    assert.equal(detail(f), "当前作品不支持");
    f.button.dispatchEvent(new Event("click"));
    assert.deepEqual(f.calls, []);
  }
  for (const makeStale of [
    f => f.invalidateOwner(),
    f => { f.state.shortVideo.current = { id: "B" }; },
    f => f.setPlayer({ requestPictureInPicture() {} }),
    f => f.node.remove()
  ]) {
    const f = fixture();
    assert.equal(f.button.disabled, false);
    makeStale(f);
    f.button.dispatchEvent(new Event("click"));
    assert.equal(f.button.disabled, true);
    assert.equal(detail(f), "当前作品已切换");
    assert.deepEqual(f.calls, [], "a detached/obsolete menu never affects replacement playback or closes another menu");
  }
  {
    const f = fixture({}, true);
    f.button.click();
    assert.deepEqual(f.calls.map(call => call.type), ["native-enter", "close"]);
    assert.equal(f.requests[0].connectedAtCall, true, "the actual page/controller preserves the original settings click activation");
    f.requests[0].resolve(); await settle();
    assert.equal(document.pictureInPictureElement, f.firstPlayer, "closing the settings does not cancel its valid external playback request");
    let button = f.reopen();
    assert.equal(button.querySelector("b").textContent, "退出画中画");
    document.pictureInPictureElement = null;
    f.emitNative("leavepictureinpicture");
    assert.equal(button.querySelector("b").textContent, "画中画");
    assert.equal(button.title, "画中画");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.disabled, false, "the page's native leave handler refreshes the mounted control without another media event");
    button.click();
    assert.equal(f.requests.length, 2, "after native closure the actual page controller enters rather than exiting an absent window");
    f.requests[1].resolve(); await settle();
    button = f.reopen();
    button.click(); await settle();
    assert.equal(f.calls.filter(call => call.type === "native-exit").length, 1);
    assert.equal(f.calls.find(call => call.type === "native-exit").connectedAtCall, true);
    assert.equal(document.pictureInPictureElement, null);
    assert.equal(f.calls.some(call => call.type === "error"), false);
  }
  {
    const f = fixture({}, true);
    f.firstPlayer.readyState = 0; f.sync();
    assert.equal(f.button.disabled, true);
    assert.equal(detail(f), "视频加载后可用");
    f.firstPlayer.readyState = 3;
    f.firstPlayer.disablePictureInPicture = true; f.sync();
    assert.equal(f.button.disabled, true);
    document.pictureInPictureElement = f.firstPlayer;
    f.emitNative("enterpictureinpicture");
    assert.equal(f.button.disabled, false, "the actual page state permits exit from an already active native window");
    assert.equal(label(f), "退出画中画");
    f.button.click(); await settle();
    assert.equal(document.pictureInPictureElement, null);
    assert.equal(f.requests.length, 0, "native entry adoption never creates a duplicate request");
  }
  {
    const f = fixture({}, true);
    f.button.click();
    f.state.activeView = "music";
    f.requests[0].reject(new Error("late native denial")); await settle();
    assert.equal(f.calls.some(call => call.type === "error"), false, "a rejected native request cannot toast after the user leaves its view");
    assert.equal(f.node.isConnected, false);
  }
} finally {
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
}
console.log("short-video-picture-controls: actual page/controller native events, readiness, activation, UI refresh and stale-menu ownership passed");

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoPlayerSourceLifecycle, disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function sourceFunction(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert.notEqual(start, undefined, name);
  const end = source.indexOf("\n  }", start);
  return source.slice(start, end + 4);
}
const implementation = ["attachPrimaryPlayerControls", "clearPendingPlayerClick", "bindShortVideoPlaybackStatus", "captureShortVideoPlaybackOwner", "ownsShortVideoPlaybackOwner", "shortVideoNavigationScope"].map(sourceFunction).join("\n");
function element() {
  const listeners = new Map(), classes = new Set();
  return {
    dataset: {}, children: [], isConnected: true, attributes: {},
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
      toggle(name, force) { const value = force ?? !classes.has(name); if (value) classes.add(name); else classes.delete(name); return value; } },
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, callback) { const values = listeners.get(name) || new Set(); values.add(callback); listeners.set(name, values); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name, extra = {}) { for (const callback of [...(listeners.get(name) || [])]) callback({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra }); },
    listenerCount(name) { return listeners.get(name)?.size || 0; },
    focus() { this.focusCalls = (this.focusCalls || 0) + 1; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(playing = false) {
  const stage = element(), player = element(), timers = new Map(), requests = [], likes = [];
  let nextTimer = 0;
  Object.assign(player, { paused: !playing, ended: false, readyState: 3, currentTime: 7, currentSrc: "/fixture/a", muted: false, volume: 1, playbackRate: 1,
    pause() { const changed = !this.paused; this.paused = true; if (changed) this.emit("pause"); },
    play() { this.paused = false; this.emit("play"); return new Promise((resolve, reject) => requests.push({ resolve, reject })); },
    getAttribute(name) { return name === "src" ? this.currentSrc : null; }, closest() { return stage; } });
  Object.assign(player.dataset, { videoId: "a", shortVideoSlot: "current", shortVideoSourceGeneration: "1", shortVideoFrameReady: "1", shortVideoPlaybackIntentGeneration: "0" });
  const state = { activeView: "shortVideos", shortVideo: { current: { id: "a" }, muted: false, mode: "feed", query: "", deleted: "all", collectionId: "", authorAccountStatus: "all" } };
  const context = vm.createContext({
    state, Date, Promise, playerClickTimer: 0, pendingPlayerTap: null, shortVideoTapGuardPlayer: null,
    shortVideoOpenRequestId: 1, shortVideoNavigationState: {}, shortVideoPlaybackLifecycleGeneration: 0, shortVideoPageSuspended: false,
    queuedAdjacentDirection: 0, suppressNextPlayerClick: false, SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS: 520,
    document: { createElement: element, createTextNode: text => ({ textContent: text }) },
    window: { setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } },
    activePlayer: () => player, activeGalleryPlayer: () => null, isGalleryPost: () => false,
    shortVideoFeedParams: () => "", setIconButton() {}, createIcon: element, syncActiveControlBar() {},
    clearPlayerSoundBlocked() {}, wasClearScreenJustRevealed: () => false, isShortVideoGestureClickBlocked: () => false,
    revealShortVideoClearScreen: () => false, restorePlayerSound() {}, bindHoldToSpeed() {}, bindShortVideoWatchTracking() {}, syncActivePlaybackMode() {},
    toggleShortVideoAction(...args) { likes.push(args); }, showHeartBurst() {}, handleAutoNextEnded() {}, cancelShortVideoAutoNext() {}, warmVisibleAdjacentVideoPlayers() {},
    playbackRenditionPolicy: { cancelPlayerRecovery() {}, switchToSmoothFallback: () => false, retrySmoothFallback: () => false },
    normalizePlaybackRate: Number
  });
  vm.runInContext(`${implementation}\nglobalThis.api={attachPrimaryPlayerControls,clearPendingPlayerClick};`, context);
  context.api.attachPrimaryPlayerControls(stage, player, () => "rail", { id: "a" });
  const center = stage.children.find(child => child.className === "short-video-center-play");
  const doubleTap = () => { player.emit("click"); player.emit("click"); stage.emit("dblclick"); };
  return { stage, player, center, state, context, requests, likes, timers, doubleTap, clear: context.api.clearPendingPlayerClick };
}

{
  const f = fixture(true);
  f.player.emit("click");
  assert.equal(f.player.paused, true, "single tap pauses immediately");
  assert.equal(f.player.dataset.shortVideoExplicitPlaybackIntent, "pause");
  f.player.emit("click"); f.stage.emit("dblclick");
  assert.equal(f.player.paused, false);
  assert.equal(f.player.dataset.shortVideoExplicitPlaybackIntent, "play", "double-like restores a real play intent");
  assert.equal(f.requests.length, 1);
  assert.equal(f.likes.length, 1);
}
{
  const f = fixture(); f.doubleTap();
  assert.equal(f.player.paused, true);
  assert.equal(f.player.dataset.shortVideoExplicitPlaybackIntent, "pause", "a paused double-like settles explicit pause intent");
  assert.equal(typeof f.player.shortVideoCancelTapGuard, "function");
  f.player.paused = false; f.player.emit("play");
  assert.equal(f.player.paused, true, "an old in-flight play cannot undo the double-like pause");
  f.player.shortVideoSetPlaybackIntent(true); f.player.play();
  assert.equal(f.player.paused, false, "immediate user play wins over the old 240ms guard");
  assert.equal(f.player.shortVideoCancelTapGuard, undefined);
  assert.equal(f.timers.size, 0, "new intent removes the old timer, including zero timer handles");
}
for (const invalidation of ["seek intent", "reloaded source", "ghost role", "detach", "new video", "pagehide"]) {
  const f = fixture(); f.doubleTap();
  const queuedTimer = [...f.timers.values()].find(timer => timer.delay === 240).callback;
  if (invalidation === "seek intent") f.player.dataset.shortVideoPlaybackIntentGeneration = "99";
  if (invalidation === "reloaded source") f.player.dataset.shortVideoSourceGeneration = "2";
  if (invalidation === "ghost role") f.player.classList.add("is-ghost");
  if (invalidation === "detach") f.player.isConnected = false;
  if (invalidation === "new video") f.state.shortVideo.current = { id: "b" };
  if (invalidation === "pagehide") f.context.shortVideoPlaybackLifecycleGeneration++;
  f.player.paused = false; f.player.emit("play");
  assert.equal(f.player.paused, false, `${invalidation}: obsolete guard cannot pause another intent/owner`);
  queuedTimer();
  assert.equal(f.player.shortVideoCancelTapGuard, undefined);
}
{
  const f = fixture(true); f.player.emit("click");
  f.player.shortVideoSetPlaybackIntent(false);
  f.stage.emit("dblclick");
  assert.equal(f.requests.length, 0, "a new explicit pause invalidates the earlier tap's restore choice");
  assert.equal(f.player.paused, true);
  assert.equal(f.likes.length, 1, "a current double-like still likes the work without restoring obsolete intent");
}
{
  const f = fixture(); f.center.emit("click");
  assert.equal(f.requests.length, 1);
  f.state.shortVideo.current = { id: "b" }; f.player.isConnected = false;
  f.requests[0].resolve(); await settle();
  assert.equal(f.stage.focusCalls || 0, 0, "late center-play completion cannot focus the previous work");
  f.center.emit("dblclick");
  assert.equal(f.likes.length, 0, "detached center controls cannot like the new work");
}
for (const moveFocus of [false, true]) {
  const f = fixture(); f.context.document.activeElement = f.center;
  f.center.emit("click");
  if (moveFocus) f.context.document.activeElement = { tagName: "INPUT" };
  f.requests[0].resolve(); await settle();
  assert.equal(f.stage.focusCalls || 0, moveFocus ? 0 : 1, "center play completion transfers focus only while the original focus still belongs to that action");
}
{
  const f = fixture(); f.doubleTap();
  const baselinePlayListeners = f.player.listenerCount("play") - 1;
  f.clear(); f.clear();
  assert.equal(f.player.listenerCount("play"), baselinePlayListeners);
  assert.equal(f.timers.size, 0);
  f.player.shortVideoSetPlaybackIntent(true); f.player.play();
  assert.equal(f.player.paused, false);
}
{
  const f = fixture(true); f.player.emit("click");
  f.player.shortVideoSetPlaybackIntent(true); f.player.play();
  f.player.emit("click");
  assert.equal(f.player.paused, true, "a later single click after an explicit play is a new tap, never swallowed as the old pair");
  assert.equal(f.player.dataset.shortVideoExplicitPlaybackIntent, "pause");
}
{
  const f = fixture(); f.doubleTap();
  const oldGuardTimer = [...f.timers.values()].find(timer => timer.delay === 240).callback;
  f.player.shortVideoSetPlaybackIntent(true); f.player.play();
  f.player.shortVideoSetPlaybackIntent(false); f.player.pause();
  f.doubleTap();
  const newGuard = f.player.shortVideoCancelTapGuard;
  oldGuardTimer();
  assert.equal(f.player.shortVideoCancelTapGuard, newGuard, "an old queued timeout cannot remove the new guard");
  assert.equal(f.context.shortVideoTapGuardPlayer, f.player, "old timeout keeps the new cancellation owner intact");
  f.clear();
  assert.equal(f.player.shortVideoCancelTapGuard, undefined);
}
{
  const f = fixture(true); f.player.emit("click");
  const oldTapTimer = [...f.timers.values()].find(timer => timer.delay === 520).callback;
  f.clear(); f.player.emit("click");
  oldTapTimer();
  f.player.emit("click"); f.stage.emit("dblclick");
  assert.equal(f.player.paused, true, "the old tap timeout cannot clear a new pair even when timestamp tokens collide");
  assert.equal(f.requests.length, 1);
  f.clear();
}
for (const kind of ["reload", "dispose"]) {
  const f = fixture(); f.doubleTap(); f.player.load = () => {};
  if (kind === "reload") {
    createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: () => "/fixture/a", waitForFirstFrame: async () => true })
      .ensureShortVideoPlayerSource(f.player, { id: "a" }, { forceReload: true });
  } else {
    disposeShortVideoMedia({ querySelectorAll: selector => selector === "video, audio" ? [f.player] : [] });
  }
  assert.equal(f.player.shortVideoCancelTapGuard, undefined, `${kind}: source lifecycle releases the guard`);
  assert.equal(f.timers.size, 0, `${kind}: no guard timer remains`);
}
console.log("short-video-tap-intent: actual primary controls preserve double-like playback intent, newer actions, ownership, focus and guard disposal");

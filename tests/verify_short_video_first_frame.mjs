import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoFirstFrameController } from "../public/modules/short-videos/first-frame-controller.js";
import { createShortVideoPlayerSourceLifecycle, disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

// Run the page's real status/paint handlers and the real controller/lifecycle
// with a controlled clock. No service, database, media files or browser profile.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8");
const takeFunction = (name, next) => {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  function ${next}(`, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
};
const statusSource = takeFunction("bindShortVideoPlaybackStatus", "attachPrimaryPlayerControls");
const waitSource = takeFunction("waitForVideoFirstFrame", "resumeActiveSound");
const playbackOwnerSource = ["captureShortVideoPlaybackOwner", "ownsShortVideoPlaybackOwner", "shortVideoNavigationScope", "stopShortVideoSoundPreview"].map(name => {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf("\n  }", start);
  assert(start >= 0 && end > start, `missing current playback owner function: ${name}`);
  return source.slice(start, end + 4);
}).join("\n");

class Element extends EventTarget {
  constructor(tag = "div") {
    super(); this.tagName = tag; this.dataset = {}; this.attributes = new Map(); this.children = []; this.className = "";
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); this.classList[on ? "add" : "remove"](name); }
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { this.children.push(...children); }
}
class Media extends Element {
  constructor() {
    super("video"); this.dataset = { videoId: "clip", shortVideoSlot: "current" }; this.src = "/fixture/clip";
    this.isConnected = true; this.autoplay = true; this.readyState = 2; this.currentTime = 0; this.duration = 60;
    this.paused = false; this.ended = false; this.error = null; this.muted = true; this.volume = .5; this.playbackRate = 1;
    this.frames = new Map(); this.frameId = 0; this.playCalls = 0;
  }
  set src(value) { this.setAttribute("src", value); }
  get src() { return this.getAttribute("src"); }
  get currentSrc() { return this.src; }
  requestVideoFrameCallback(callback) { const id = ++this.frameId; this.frames.set(id, callback); return id; }
  cancelVideoFrameCallback(id) { this.frames.delete(id); }
  emit(name) { this.dispatchEvent(new Event(name)); }
  paint() { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach((callback) => callback()); }
  async play() { this.playCalls += 1; this.paused = false; this.emit("play"); }
  pause() { this.paused = true; this.emit("pause"); }
  load() { this.readyState = 0; this.currentTime = 0; this.error = null; this.emit("emptied"); this.emit("loadstart"); }
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
function fixture({ smooth = false, bind = true, media = {}, controllerFactory = createShortVideoFirstFrameController } = {}) {
  let now = 0, timerId = 0, reveals = 0;
  const timers = new Map(), fallbacks = [], metrics = [];
  const clock = {
    setTimeout: (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  globalThis.window = clock;
  const player = new Media(), stage = new Element();
  Object.assign(player, media);
  stage.classList.add("is-video-loading");
  const video = { id: "clip", streamUrl: player.src };
  let lifecycle;
  const env = {
    window: clock, document: { createElement: (tag) => new Element(tag), createTextNode: (text) => text }, Event,
    queuedAdjacentDirection: 0,
    state: { activeView: "shortVideos", shortVideo: { current: video, mode: "feed" } },
    shortVideoOpenRequestId: 1, shortVideoNavigationState: null, shortVideoSoundPreviewAudio: null,
    shortVideoPlaybackLifecycleGeneration: 0, shortVideoPageSuspended: false,
    syncShortVideoModalPlayback() {},
    shortVideoFeedParams: () => "", activePlayer: () => player, activeGalleryPlayer: () => null, isGalleryPost: () => false,
    cancelShortVideoAutoNext() {},
    createIcon: () => new Element("span"), markShortVideoPerformance: (...args) => metrics.push(args),
    warmVisibleAdjacentVideoPlayers() {}, normalizePlaybackRate: (value) => Number(value || 1),
    shortVideoPlaybackUrl: () => video.streamUrl,
    ensureShortVideoPlayerSource: (...args) => lifecycle.ensureShortVideoPlayerSource(...args),
    playbackRenditionPolicy: {
      switchToSmoothFallback: (...args) => { fallbacks.push(args[2]); return smooth; },
      retrySmoothFallback: () => false, cancelPlayerRecovery() {}
    }
  };
  const context = vm.createContext(env);
  const handlers = vm.runInContext(`${statusSource}\n${waitSource}\n${playbackOwnerSource}\n({ bindShortVideoPlaybackStatus, waitForVideoFirstFrame });`, context);
  lifecycle = createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: () => video.streamUrl, waitForFirstFrame: handlers.waitForVideoFirstFrame });
  const controller = controllerFactory({ player, stage, waitForFirstFrame: handlers.waitForVideoFirstFrame,
    reveal: () => { reveals += 1; stage.classList.add("is-video-ready"); }, timeout: 1600, retryLimit: 4 });
  if (bind) handlers.bindShortVideoPlaybackStatus(stage, player, video);
  const tick = async (duration) => {
    const end = now + duration;
    for (;;) {
      const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    now = end; await flush();
  };
  const status = stage.children.find((child) => child?.className === "short-video-playback-status");
  const cleanup = () => disposeShortVideoMedia({ querySelectorAll: (selector) => selector === "video, audio" ? [player] : [] });
  return { player, stage, video, controller, lifecycle, handlers, context, tick, status, timers, fallbacks, metrics, cleanup,
    queueNavigation(direction) { env.queuedAdjacentDirection = direction; },
    get queuedNavigation() { return env.queuedAdjacentDirection; },
    get reveals() { return reveals; } };
}

{
  const f = fixture({ media: { autoplay: false, paused: false, readyState: 0 } });
  await f.tick(420);
  assert.equal(f.status.dataset.state, "loading", "a cold incoming reel already playing before status binding must show loading without another play event");
  await f.tick(8000);
  assert.equal(f.fallbacks[0], "first-frame-timeout");
  assert.equal(f.status.dataset.state, "error", "cold promotion must retain the eventual retry path");
  f.cleanup();
}
{
  const f = fixture({ media: { autoplay: false, paused: true, readyState: 0 } });
  await f.tick(10000);
  assert.equal(f.fallbacks.length, 0, "an intentionally paused cold source must not start automatic recovery");
  f.player.shortVideoSetPlaybackIntent(true);
  await f.tick(420);
  assert.equal(f.status.dataset.state, "loading", "explicit promotion intent restarts feedback even if the browser has no new play event");
  await f.tick(8000);
  assert.equal(f.status.dataset.state, "error"); f.cleanup();
}
{
  const f = fixture(); f.controller.check();
  f.player.emit("loadeddata"); f.player.emit("canplay"); f.player.emit("playing");
  await f.tick(420);
  assert.equal(f.status.dataset.state, "loading", "decoded data without a painted frame must retain visible loading feedback");
  await f.tick(8000);
  assert.equal(f.fallbacks[0], "first-frame-timeout");
  assert.equal(f.status.dataset.state, "error", "exhausted frame attempts must expose a retry instead of a stuck poster");
  assert.equal(f.reveals, 0); assert.equal(f.player.dataset.shortVideoFrameReady, undefined);
  f.cleanup(); assert.equal(f.timers.size, 0);
}
{
  const f = fixture(); f.controller.check(); await f.tick(420);
  f.player.paint(); await flush();
  assert.equal(f.reveals, 1); assert.equal(f.status.getAttribute("aria-hidden"), "true");
  assert.equal(f.stage.getAttribute("aria-busy"), "false");
  await f.tick(9000); assert.equal(f.fallbacks.length, 0); assert.equal(f.timers.size, 0);
  f.cleanup();
}
{
  const f = fixture(); f.controller.check(); f.player.paint(); await flush();
  f.player.readyState = 1; f.player.emit("waiting"); await f.tick(420);
  assert.equal(f.status.dataset.state, "buffering");
  assert.equal(f.stage.classList.contains("is-video-ready"), true, "a stall after first paint must retain the last video frame instead of restoring the poster");
  await f.tick(8000); assert.equal(f.fallbacks[0], "playback-stalled"); f.cleanup();
}
{
  const f = fixture(); f.controller.check(); await f.tick(420);
  f.queueNavigation(1);
  f.player.shortVideoSetPlaybackIntent(false); f.player.pause();
  assert.equal(f.queuedNavigation, 0, "an explicit pause must cancel a delayed navigation intent as well as media recovery");
  await f.tick(10000);
  assert.equal(f.fallbacks.length, 0, "an explicit pause must cancel automatic conversion/reload");
  assert.equal(f.player.frames.size, 0); assert.equal(f.timers.size, 0);
  f.player.emit("play");
  assert.equal(f.player.frames.size, 0); assert.equal(f.timers.size, 0, "a queued old play event cannot restart painted-frame waits after user pause");
  assert.equal(f.stage.getAttribute("aria-busy"), "false");
  assert.equal(f.stage.classList.contains("is-video-ready"), false, "pausing must not reveal an unpainted frame");
  f.player.shortVideoSetPlaybackIntent(true); await f.player.play();
  assert.equal(f.player.frames.size, 1, "resuming must restart painted-frame tracking");
  f.player.paint(); await flush(); assert.equal(f.reveals, 1); f.cleanup();
}
for (const obsoleteState of ["ended", "explicit-pause", "disconnected"]) {
  const f = fixture(); f.controller.check();
  f.player.shortVideoSetPlaybackIntent(false); f.player.pause();
  f.player.paused = false;
  if (obsoleteState !== "explicit-pause") delete f.player.dataset.shortVideoExplicitPlaybackIntent;
  if (obsoleteState === "ended") f.player.ended = true;
  if (obsoleteState === "disconnected") f.player.isConnected = false;
  f.player.emit("play");
  assert.equal(f.player.frames.size, 0, `${obsoleteState}: an obsolete native event cannot revive a cancelled frame wait`);
  assert.equal(f.timers.size, 0);
  f.player.isConnected = true; f.player.ended = false;
  f.player.shortVideoSetPlaybackIntent(true); await f.player.play();
  assert.equal(f.player.frames.size, 1, `${obsoleteState}: a new valid play request still resumes first-frame tracking`);
  f.player.paint(); await flush(); assert.equal(f.reveals, 1); f.cleanup();
}
{
  const f = fixture(); f.player.shortVideoCancelFirstFrame();
  f.player.classList.add("is-ghost");
  await f.player.play();
  assert.equal(f.player.frames.size, 1, "a connected ghost prewarm with actual playback may still wait for its first frame");
  f.player.paint(); await flush(); assert.equal(f.reveals, 1); f.cleanup();
}
{
  const f = fixture(); f.controller.check();
  const oldFrame = [...f.player.frames.values()][0];
  f.lifecycle.ensureShortVideoPlayerSource(f.player, f.video, { source: "/fixture/reloaded", forceReload: true });
  oldFrame(); await flush();
  assert.equal(f.player.dataset.shortVideoFrameReady, undefined, "a late callback from the old source must not mark the new source ready");
  assert.equal(f.reveals, 0); assert.equal(f.controller.attempts, 0, "source reload resets the bounded frame retry budget");
  f.player.readyState = 2; await f.player.play(); f.player.paint(); await flush();
  assert.equal(f.reveals, 1); f.cleanup();
}
for (const invalidate of [
  (f) => { f.player.isConnected = false; },
  (f) => { f.player.classList.add("is-ghost"); f.player.shortVideoCancelFirstFrame(); f.player.shortVideoCancelPlaybackStatus(); },
  (f) => f.cleanup()
]) {
  const f = fixture(); f.controller.check(); await f.tick(420); invalidate(f);
  await f.tick(10000); f.player.paint(); await flush();
  assert.equal(f.reveals, 0); assert.equal(f.fallbacks.length, 0, "off-screen/disposed players must not start recovery");
  assert.equal(f.timers.size, 0); f.cleanup();
}
{
  const f = fixture({ bind: false });
  const wait = f.handlers.waitForVideoFirstFrame(f.player, 1600);
  const oldFrame = [...f.player.frames.values()][0];
  f.player.src = "/fixture/replaced-before-emptied";
  oldFrame(); assert.equal(await wait, false, "source identity must protect even before the browser emits emptied");
  assert.equal(f.player.dataset.shortVideoFrameReady, undefined); f.cleanup();
}
{
  const f = fixture(); f.controller.check();
  await f.tick(7000); assert.equal(f.controller.attempts, 4);
  f.lifecycle.ensureShortVideoPlayerSource(f.player, f.video, { forceReload: true });
  f.player.readyState = 2; await f.player.play(); f.player.paint(); await flush();
  assert.equal(f.reveals, 1, "a manual/new-source retry gets a fresh frame budget after exhaustion"); f.cleanup();
}

{
  const f = fixture();
  const retry = f.status.children.find((child) => child?.tagName === "button");
  f.player.currentTime = 17;
  retry.dispatchEvent(new Event("click", { cancelable: true }));
  f.player.shortVideoSetPlaybackIntent(false);
  f.player.readyState = 2; f.player.emit("loadedmetadata"); f.player.emit("canplay");
  await f.tick(10000);
  assert.equal(f.player.playCalls, 0, "a manual reload callback must not undo a later user pause");
  assert.equal(f.player.currentTime, 0, "cancelled metadata restoration must not overwrite a later position");
  assert.equal(f.fallbacks.length, 0); f.cleanup();
}
{
  const f = fixture();
  const retry = f.status.children.find((child) => child?.tagName === "button");
  f.player.currentTime = 17;
  retry.dispatchEvent(new Event("click", { cancelable: true }));
  f.player.readyState = 1; f.player.emit("loadedmetadata");
  assert.equal(f.player.currentTime, 17, "manual reload must preserve the original progress");
  f.player.shortVideoCancelPlaybackStatus(); f.player.classList.add("is-ghost");
  f.player.readyState = 2; f.player.emit("canplay"); await flush();
  assert.equal(f.player.playCalls, 0, "manual resume waiting for canplay must be cancelled on demotion"); f.cleanup();
}
{
  const f = fixture({ bind: false });
  let resolveWarm;
  const lifecycle = createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: () => f.player.src,
    waitForFirstFrame: () => new Promise((resolve) => { resolveWarm = resolve; }) });
  f.player.classList.add("is-ghost"); f.player.dataset.shortVideoSlot = "next";
  f.player.dataset.shortVideoWarmScheduleToken = "old";
  const warm = lifecycle.warmAdjacentVideoPlayer(f.player, f.video);
  f.player.classList.remove("is-ghost"); f.player.dataset.shortVideoSlot = "current";
  f.player.classList.add("is-ghost"); f.player.dataset.shortVideoSlot = "next";
  f.player.dataset.shortVideoWarmScheduleToken = "new";
  f.player.muted = false; f.player.preload = "auto";
  resolveWarm(true); assert.equal(await warm, false);
  assert.equal(f.player.paused, false, "a warmup from an earlier role cycle must not pause the new owner");
  assert.equal(f.player.muted, false); assert.equal(f.player.preload, "auto"); f.cleanup();
}
{
  const f = fixture({ bind: false });
  f.player.requestVideoFrameCallback = undefined;
  f.controller.check(); await flush();
  assert.equal(f.reveals, 1, "browsers without painted-frame callbacks retain their decoded-data fallback"); f.cleanup();
}

const lifecycleSource = ["handleShortVideoPageHide", "handleShortVideoPageShow"].map(name => {
  const start = source.indexOf(`  function ${name}(`), end = source.indexOf("\n  }", start);
  assert(start >= 0 && end > start); return source.slice(start, end + 4);
}).join("\n");
function lifecycle(f, implementation = lifecycleSource) {
  Object.assign(f.context, {
    shortVideoOpeningId: "", shortVideoOpenError: "", els: { workGrid: null },
    cancelShortVideoNavigation() {}, collectionsController: { cancelReads() {} },
    releaseUnusedShortVideoPreloads() {}, cancelShortVideoPanelLoading() {}, shortVideoWheelController: null,
    cancelShortVideoBrowseGestures() {}, clearPendingPlayerClick() {}, syncActiveControlBar() {}
  });
  const start = source.indexOf("      const markVideoReady = () => firstFrameController.check();");
  const end = source.indexOf("      window.requestAnimationFrame", start);
  assert(start >= 0 && end > start);
  Object.assign(f.context, { firstFrameController: f.controller, player: f.player, markMediaEvent() {}, applyVideoOrientation() {}, panel: {}, stage: f.stage });
  vm.runInContext(source.slice(start, end), f.context);
  return vm.runInContext(`${implementation}\n({ hide: handleShortVideoPageHide, show: handleShortVideoPageShow });`, f.context);
}

async function verifyLifecycleFrameReturn(implementation = lifecycleSource) {
  const f = fixture(), page = lifecycle(f, implementation);
  f.controller.check(); const oldFrame = [...f.player.frames.values()][0];
  page.hide();
  assert.equal(f.player.frames.size, 0, "pagehide cancels the outstanding painted-frame wait");
  f.player.emit("play");
  assert.equal(f.player.frames.size, 0, "a queued native play event cannot restart a suspended page's frame wait");
  page.show();
  assert.equal(f.player.frames.size, 1, "pageshow must resume the same playing source's painted-frame wait without another play transition");
  f.player.currentTime = 2; f.player.emit("loadeddata"); f.player.emit("canplay"); f.player.emit("playing");
  assert.equal(f.player.frames.size, 1, "subsequent ready events share the restored wait");
  oldFrame(); await flush(); assert.equal(f.reveals, 0, "the cancelled pre-pagehide frame cannot reveal the restored stage");
  f.player.paint(); await flush();
  assert.equal(f.reveals, 1); assert.equal(f.player.playCalls, 0, "pageshow tracks frames without issuing play");
  page.show(); assert.equal(f.player.frames.size, 0, "duplicate pageshow cannot allocate another frame wait");
  f.cleanup();
}
await verifyLifecycleFrameReturn();

for (const pause of ["already-paused", "pause-while-away"]) {
  const f = fixture({ media: { paused: pause === "already-paused" } }), page = lifecycle(f);
  f.controller.check(); page.hide();
  if (pause === "pause-while-away") { f.player.shortVideoSetPlaybackIntent(false); f.player.pause(); }
  page.show(); f.player.emit("playing");
  assert.equal(f.player.frames.size, 0, `${pause}: BFCache return preserves paused intent`);
  assert.equal(f.player.playCalls, 0); assert.equal(f.reveals, 0);
  f.player.shortVideoSetPlaybackIntent(true); await f.player.play(); f.player.paint(); await flush();
  assert.equal(f.reveals, 1, "a later explicit play remains available"); f.cleanup();
}

async function verifyLifecycleSourceOwner(controllerFactory = createShortVideoFirstFrameController) {
  const f = fixture({ controllerFactory }), page = lifecycle(f);
  f.controller.check(); const oldFrame = [...f.player.frames.values()][0]; page.hide();
  // A source can change before the browser emits loadstart/emptied. The resume
  // owner must reject it independently of those events and the old wait.
  f.player.src = "/fixture/new-during-pagehide";
  page.show(); oldFrame(); await flush();
  assert.equal(f.player.frames.size, 0, "pageshow cannot resume an earlier source owner into a replacement source");
  assert.equal(f.reveals, 0); assert.equal(f.player.dataset.shortVideoFrameReady, undefined);
  await f.player.play(); f.player.paint(); await flush();
  assert.equal(f.reveals, 1, "a legitimate play event can track the replacement source"); f.cleanup();
}
await verifyLifecycleSourceOwner();

const withoutFrameResume = lifecycleSource.replace(/^.*shortVideoResumeFirstFrame.*\n/m, "");
assert.notEqual(withoutFrameResume, lifecycleSource, "the negative control must remove actual pageshow frame wiring");
await assert.rejects(verifyLifecycleFrameReturn(withoutFrameResume), /pageshow must resume the same playing source/);
const controllerSource = fs.readFileSync(new URL("../public/modules/short-videos/first-frame-controller.js", import.meta.url), "utf8");
const unownedResume = controllerSource.replace("owner.source !== sourceIdentity()", "false");
assert.notEqual(unownedResume, controllerSource, "the negative control must remove the production source-owner guard");
const mutated = await import(`data:text/javascript;base64,${Buffer.from(unownedResume).toString("base64")}`);
await assert.rejects(verifyLifecycleSourceOwner(mutated.createShortVideoFirstFrameController), /earlier source owner/);

console.log("short-video-first-frame: painted readiness, timeout feedback, source/role cancellation, BFCache ownership and paused intent passed");

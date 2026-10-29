import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoWatchResumeController } from "../public/modules/short-videos/watch-resume-controller.js";
import { createShortVideoPlayerSourceLifecycle } from "../public/modules/short-videos/player-source-lifecycle.js";
import { createShortVideoWatchWriteController } from "../public/modules/short-videos/watch-write-controller.js";

// Exercise the production page adapter, frame waiter and source lifecycle with
// controlled media events/paint/RAF. No service, database or media is accessed.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8");
function takeFunction(name, next) {
  const start = source.indexOf(`  function ${name}(`), end = source.indexOf(`  function ${next}(`, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
class Media extends EventTarget {
  constructor() {
    super(); this.dataset = { videoId: "A", shortVideoSlot: "current", shortVideoSourceGeneration: "1" };
    this.isConnected = true; this.src = "/fixture/A.mp4"; this.readyState = 2; this.duration = 60;
    this.time = 0; this.paused = false; this.ended = false; this.error = null; this.ghost = false;
    this.frameId = 0; this.frames = new Map(); this.listeners = new Map();
    this.classList = { contains: name => name === "is-ghost" && this.ghost };
  }
  addEventListener(name, callback, options) { super.addEventListener(name, callback, options); this.listeners.set(callback, name); }
  removeEventListener(name, callback, options) { super.removeEventListener(name, callback, options); this.listeners.delete(callback); }
  getAttribute(name) { return name === "src" ? this.src : null; }
  get currentSrc() { return this.src; }
  get currentTime() { return this.time; }
  set currentTime(value) { this.time = value; if (this.dropReadinessOnSeek) this.readyState = 1; this.emit("seeking"); }
  emit(name) { this.dispatchEvent(new Event(name)); }
  requestVideoFrameCallback(callback) { const id = ++this.frameId; this.frames.set(id, callback); return id; }
  cancelVideoFrameCallback(id) { this.frames.delete(id); }
  paint() { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach(callback => callback()); }
  load() { this.readyState = 0; this.time = 0; this.error = null; this.emit("emptied"); this.emit("loadstart"); }
}
function fixture({ watch = { progressMs: 12000 }, resume = true, queue = null } = {}) {
  let now = 1000, sequence = 0, active, scope = "scope-a";
  const frames = new Map(), cancelledFrames = new Map(), timers = new Map(), writes = [], toasts = [];
  const clock = {
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { if (frames.has(id)) cancelledFrames.set(id, frames.get(id)); frames.delete(id); },
    setTimeout(callback, delay = 0) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  globalThis.window = clock;
  const player = new Media(), stage = { isConnected: true }, surfaceAbort = new AbortController();
  const video = { id: "A", ...(watch === undefined ? {} : { watch }) };
  const state = { activeView: "shortVideos", shortVideo: { current: video } };
  active = player;
  const env = { window: clock, Event, AbortController, state, createShortVideoWatchResumeController,
    activePlayer: () => active, shortVideoWatchWriteController: queue,
    shortVideoOpenRequestId: 1, shortVideoNavigationState: {}, shortVideoNavigationScope: () => scope,
    persistShortVideoWatch: (item, media, options) => writes.push({ video: item, time: media.currentTime, options }),
    showBrowserToast: message => toasts.push(message), formatSeconds: seconds => String(seconds), markShortVideoPerformance() {} };
  const handlers = vm.runInNewContext(`${takeFunction("bindShortVideoWatchTracking", "persistShortVideoWatch")}\n${takeFunction("waitForVideoFirstFrame", "resumeActiveSound")}\n({ bind: bindShortVideoWatchTracking, wait: waitForVideoFirstFrame, replaceWait(fn) { waitForVideoFirstFrame = fn; } });`, env);
  handlers.bind(stage, player, video, { resume });
  const lifecycle = createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: () => player.src, waitForFirstFrame: handlers.wait });
  const raf = async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); await settle(); };
  const paint = async () => { player.paint(); await settle(); };
  const tick = async delay => {
    const end = now + delay;
    for (;;) {
      const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
    }
    now = end; await settle();
  };
  const metadata = () => {
    player.readyState = 2; player.emit("loadedmetadata"); player.emit("loadeddata");
    // The page also observes painted frames independently of resume eligibility.
    void handlers.wait(player, 1800, { signal: surfaceAbort.signal });
  };
  const restore = async () => { metadata(); await paint(); await raf(); player.emit("seeked"); };
  return { player, stage, state, env, handlers, lifecycle, writes, toasts, frames, cancelledFrames, timers,
    raf, paint, tick, metadata, restore, setActive: value => { active = value; }, setScope: value => { scope = value; },
    hydrate(next) { state.shortVideo.current = next; handlers.bind(stage, player, next, { resume }); },
    dispose: () => { player.shortVideoDisposeWatchResume(); surfaceAbort.abort(); } };
}

{
  const f = fixture({ watch: { progressMs: 12000, completed: true, completedCount: 1 } });
  f.metadata();
  assert.equal(f.player.shortVideoWatchCanPersist(), false);
  assert.equal(f.player.shortVideoFlushWatch(), false, "leaving before resume cannot overwrite the saved point with zero");
  await f.paint(); await f.raf();
  assert.equal(f.player.currentTime, 12, "sticky historical completion does not suppress the latest middle position");
  assert.deepEqual(f.writes.map(write => write.time), [12]);
  assert.equal(f.toasts.length, 1);
  assert.equal(f.player.shortVideoWatchCanPersist(), true);
  f.dispose();
}
for (const progressMs of [0, 1499, 59000, 60000, NaN, Infinity]) {
  const f = fixture({ watch: { progressMs, completed: true } });
  f.metadata(); await f.raf();
  assert.equal(f.player.currentTime, 0, `ineligible saved point ${progressMs} starts at zero`);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.writes.length, 0, "unpainted bootstrap must not persist zero");
  f.player.dataset.shortVideoFrameReady = "1"; f.player.emit("shortvideoframeready");
  assert.equal(f.writes[0].time, 0);
  f.dispose();
}
for (const progressMs of [1500, 58500]) {
  const f = fixture({ watch: { progressMs } }); await f.restore();
  assert.equal(f.player.currentTime, progressMs / 1000, "the existing inclusive 1.5s bounds remain unchanged");
  f.dispose();
}
{
  const f = fixture(); f.player.duration = NaN; f.metadata(); await f.paint(); await f.raf();
  assert.equal(f.player.dataset.watchRestored, undefined); assert.equal(f.writes.length, 0);
  f.player.duration = 60; f.player.emit("loadedmetadata"); await settle(); await f.raf();
  assert.equal(f.player.currentTime, 12, "unknown duration waits for valid metadata instead of accepting zero");
  f.dispose();
}
for (const change of [
  f => { f.player.src = "/fixture/new-source.mp4"; },
  f => { f.player.dataset.shortVideoSourceGeneration = "2"; },
  f => { f.player.dataset.shortVideoPlaybackIntentGeneration = "2"; },
  f => { f.player.dataset.shortVideoPromotedAt = "2"; },
  f => { f.player.dataset.shortVideoWarmScheduleToken = "2"; },
  f => { f.player.dataset.shortVideoSlot = "prev"; f.player.ghost = true; },
  f => { f.player.isConnected = false; },
  f => { f.stage.isConnected = false; },
  f => { f.state.activeView = "library"; },
  f => { f.state.shortVideo.current = { id: "B" }; },
  f => { f.env.shortVideoOpenRequestId = 2; },
  f => { f.env.shortVideoNavigationState = {}; },
  f => { f.setScope("scope-b"); },
  f => { f.setActive(new Media()); }
]) {
  const f = fixture(); f.metadata(); await f.paint();
  change(f); f.player.time = 7;
  await f.raf();
  assert.equal(f.player.currentTime, 7, "old restore RAF cannot seek a different source/role/navigation owner");
  assert.equal(f.writes.length, 0); assert.equal(f.toasts.length, 0);
  f.dispose();
}
{
  const f = fixture(); f.metadata(); await f.paint();
  f.player.currentTime = 7; // Actual seeking listener cancels the pending restore.
  await f.raf();
  for (const callback of f.cancelledFrames.values()) callback();
  await settle();
  assert.equal(f.player.currentTime, 7);
  assert.equal(f.toasts.length, 0);
  f.player.dataset.shortVideoFrameReady = "1";
  assert.equal(f.player.shortVideoFlushWatch(), true);
  assert.equal(f.writes.at(-1).time, 7);
  f.dispose();
}
{
  const f = fixture(); await f.restore(); f.player.paused = true;
  const before = f.writes.length;
  // Chrome may drop to HAVE_METADATA when a paused range/keyboard seek is
  // assigned, with timeupdate preceding the final seeked/HAVE_CURRENT_DATA.
  f.player.readyState = 1; f.player.currentTime = 20;
  f.player.shortVideoCancelWatchResume(); // The page control-bar onChange.
  assert.equal(f.player.shortVideoFlushWatch({ force: true }), false);
  f.player.emit("timeupdate");
  assert.equal(f.writes.length, before);
  f.player.readyState = 2; f.player.emit("seeked");
  assert.deepEqual(f.writes.slice(before).map(write => write.time), [20]);
  assert.equal(f.writes.at(-1).options.force, true);
  assert.equal(f.player.paused, true, "saving a paused seek must not resume playback");
  f.dispose();
}
{
  const f = fixture(); f.player.dropReadinessOnSeek = true;
  f.metadata(); await f.paint(); await f.raf();
  assert.equal(f.player.currentTime, 12); assert.equal(f.player.readyState, 1); assert.equal(f.writes.length, 0);
  f.player.readyState = 2; f.player.emit("seeked");
  assert.deepEqual(f.writes.map(write => write.time), [12], "the initial automatic restore also saves after its seek becomes readable");
  f.dispose();
}
for (const change of [
  f => { f.player.ghost = true; f.player.dataset.shortVideoSlot = "prev"; },
  f => { f.player.dataset.shortVideoSourceGeneration = "2"; },
  f => { f.player.dataset.shortVideoPromotedAt = "2"; },
  f => { f.env.shortVideoNavigationState = {}; },
  f => { f.state.shortVideo.current = { id: "B" }; }
]) {
  const f = fixture(); await f.restore(); const before = f.writes.length;
  f.player.readyState = 1; f.player.currentTime = 20; change(f);
  f.player.time = 0; f.player.readyState = 2; f.player.emit("seeked");
  assert.equal(f.writes.length, before, "late seeked cannot save zero for a different source/role/navigation owner");
  f.dispose();
}
{
  const f = fixture(); f.metadata(); await f.paint();
  f.player.shortVideoCancelWatchResume(); f.player.paused = true; f.player.emit("pause");
  await f.raf();
  assert.equal(f.player.shortVideoFlushWatch(), false, "pausing an initial zero frame is not a seek to zero");
  assert.equal(f.writes.length, 0); assert.equal(f.toasts.length, 0);
  f.player.currentTime = 0;
  assert.equal(f.player.shortVideoFlushWatch(), true, "an explicit seek to zero is a valid new position");
  assert.equal(f.writes.at(-1).time, 0);
  f.dispose();
}
{
  const f = fixture(); f.metadata(); await f.paint();
  f.player.shortVideoCancelWatchResume(); f.player.paused = true; f.player.emit("pause");
  f.lifecycle.ensureShortVideoPlayerSource(f.player, f.state.shortVideo.current, { forceReload: true });
  f.metadata(); await f.paint(); await f.raf();
  assert.equal(f.player.currentTime, 0, "source reload cannot revive a resume choice cancelled by the user");
  assert.equal(f.writes.length, 0, "the cancelled initial zero also stays protected after reload");
  f.dispose();
}
{
  const f = fixture(); f.metadata();
  await f.tick(1800); await f.raf();
  assert.equal(f.player.currentTime, 0);
  assert.equal(f.player.dataset.watchRestored, undefined, "first-frame timeout does not claim a successful resume");
  assert.equal(f.toasts.length, 0); assert.equal(f.writes.length, 0);
  f.player.emit("playing"); await f.paint(); await f.raf();
  assert.equal(f.player.currentTime, 12, "a later real painted frame can retry recovery");
  f.dispose();
}
{
  const f = fixture(); f.handlers.replaceWait(() => Promise.reject(new Error("no painted frame")));
  f.metadata(); await settle(); await f.raf();
  assert.equal(f.player.currentTime, 0); assert.equal(f.toasts.length, 0); assert.equal(f.writes.length, 0);
  f.dispose();
}
{
  const f = fixture(); await f.restore();
  f.player.currentTime = 25; f.player.emit("timeupdate");
  const count = f.writes.length;
  f.player.ghost = true; f.player.dataset.shortVideoSlot = "prev"; f.player.time = 0;
  f.player.emit("pause"); f.player.emit("timeupdate"); f.player.emit("ended");
  assert.equal(f.writes.length, count, "offscreen warmup pause/reset/ended cannot overwrite active progress");
  f.dispose();
}
{
  const f = fixture({ watch: null });
  // A minimal incoming item can receive its watch metadata after promotion.
  delete f.state.shortVideo.current.watch;
  f.metadata(); await f.raf();
  assert.equal(f.player.dataset.watchRestored, undefined); assert.equal(f.writes.length, 0);
  f.hydrate({ id: "A", watch: { progressMs: 12000 } }); await f.paint(); await f.raf();
  assert.equal(f.player.currentTime, 12, "late detail watch metadata resumes the still untouched item");
  f.dispose();
}
{
  const f = fixture(); delete f.state.shortVideo.current.watch;
  f.metadata(); await f.raf(); f.player.currentTime = 7;
  f.hydrate({ id: "A", watch: { progressMs: 12000 } }); await f.raf();
  assert.equal(f.player.currentTime, 7, "late metadata cannot undo the user's earlier seek");
  f.player.dataset.shortVideoFrameReady = "1"; f.player.emit("shortvideoframeready");
  assert.equal(f.writes.at(-1).time, 7);
  f.dispose();
}
{
  const queue = createShortVideoWatchWriteController({ write: () => new Promise(() => {}) });
  queue.submit("A", { progressMs: 24000, completed: false }, { force: true, watch: { progressMs: 3000 } });
  const f = fixture({ watch: { progressMs: 3000 }, queue });
  await f.restore();
  assert.equal(f.player.currentTime, 24, "accepted local progress resumes while the server acknowledgement is still pending");
  f.dispose();
}
for (const updateAfterPaint of [false, true]) {
  const f = fixture(); f.metadata();
  if (updateAfterPaint) await f.paint();
  f.hydrate({ id: "A", watch: { progressMs: 24000, completed: true } });
  if (!updateAfterPaint) await f.paint();
  await f.raf();
  assert.equal(f.player.currentTime, 24, "late same-item detail supersedes a cached target before the restore commits");
  assert.deepEqual(f.writes.map(write => write.time), [24]);
  assert.deepEqual(f.toasts, ["已续播至 24"]);
  f.dispose();
}
{
  const queue = createShortVideoWatchWriteController({ write: () => new Promise(() => {}) });
  const f = fixture({ queue }); f.metadata(); await f.paint();
  queue.submit("A", { progressMs: 24000, completed: false }, { force: true });
  await f.raf();
  assert.equal(f.player.currentTime, 24, "a newer accepted local position also replaces the pending target");
  assert.deepEqual(f.writes.map(write => write.time), [24]);
  f.dispose();
}
for (const progressMs of [0, 59000]) {
  const f = fixture(); f.metadata(); await f.paint();
  f.hydrate({ id: "A", watch: { progressMs } }); await f.raf();
  assert.equal(f.player.currentTime, 0, "eligibility is recalculated when the latest saved point changes");
  assert.equal(f.toasts.length, 0);
  assert.deepEqual(f.writes.map(write => write.time), [0]);
  f.dispose();
}
for (const resume of [true, false]) {
  const f = fixture({ resume }); await f.restore();
  f.player.currentTime = 25; f.player.emit("timeupdate");
  const before = f.writes.length;
  // Invoke the production lifecycle, including its pre-load resume hook.
  f.lifecycle.ensureShortVideoPlayerSource(f.player, f.state.shortVideo.current, { forceReload: true });
  assert.equal(f.player.currentTime, 0); assert.equal(f.player.shortVideoFlushWatch(), false);
  f.metadata(); f.player.emit("playing"); f.player.emit("pause");
  f.hydrate({ id: "A", watch: { progressMs: 3000 } });
  assert.equal(f.writes.length, before, "new-source zero cannot persist while its restore awaits a frame");
  await f.paint();
  f.player.emit("timeupdate");
  assert.equal(f.writes.length, before, "even a real frame at source time zero cannot bypass the restore RAF");
  await f.raf();
  assert.equal(f.player.currentTime, 25, "reload recovers the last valid current position even for resume:false promotion");
  assert.deepEqual(f.writes.slice(before).map(write => write.time), [25]);
  f.dispose();
}
{
  const f = fixture(); await f.restore(); f.player.currentTime = 25; f.player.emit("timeupdate");
  f.lifecycle.ensureShortVideoPlayerSource(f.player, f.state.shortVideo.current, { forceReload: true });
  f.metadata();
  // Playback recovery/status may restore the point at metadata before paint.
  f.player.currentTime = 25;
  assert.equal(f.player.shortVideoFlushWatch(), false);
  await f.paint(); await f.raf();
  assert.equal(f.player.currentTime, 25);
  assert.equal(f.writes.at(-1).time, 25);
  f.dispose();
}
{
  const f = fixture(); f.metadata(); await f.paint();
  const oldCallbacks = [...f.frames.values()];
  f.player.shortVideoCancelWatchResume({ settle: false });
  f.player.dataset.shortVideoSourceGeneration = "2"; delete f.player.dataset.shortVideoFrameReady;
  f.metadata(); await f.paint();
  const newFrameIds = [...f.frames.keys()];
  oldCallbacks.forEach(callback => callback());
  assert.deepEqual([...f.frames.keys()], newFrameIds, "an old completion must not clear the new restore frame");
  await f.raf(); assert.equal(f.player.currentTime, 12);
  assert.equal(f.toasts.length, 1);
  f.dispose();
}
{
  const f = fixture(); f.metadata(); await f.paint();
  const listeners = f.player.listeners.size;
  f.handlers.bind(f.stage, f.player, f.state.shortVideo.current);
  assert.equal(f.player.listeners.size, listeners, "rebinding the same item updates metadata without duplicate listeners");
  await f.raf(); assert.equal(f.toasts.length, 1); assert.equal(f.writes.length, 1);
  f.dispose();
}
{
  const f = fixture(); f.metadata(); await f.paint();
  const oldCallbacks = [...f.frames.values()];
  f.dispose(); oldCallbacks.forEach(callback => callback()); await settle();
  f.player.emit("playing"); f.player.emit("pause");
  assert.equal(f.player.currentTime, 0); assert.equal(f.writes.length, 0);
  assert.equal(f.player.shortVideoWatchCanPersist(), false);
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.player.frames.size, 0);
  assert.equal(f.player.listeners.size, 0, "dispose releases all controller/waiter listeners");
}

// Author-panel outgoing flush and late metadata are exercised with the shared
// navigation/hydration functions in verify_short_video_author_handoff.mjs.

console.log("Short-video watch resume verification passed.");

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoPlayerSourceLifecycle } from "../public/modules/short-videos/player-source-lifecycle.js";
import { allowShortVideoSpeculativePrewarm } from "../public/modules/short-videos/prewarm-policy.js";

// Run the page's real warm/release/visibility code and first-frame wait with
// the production source lifecycle. Native frame delivery and timers remain
// independently controllable; no browser, service or media file is needed.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function pageFunction(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, name);
  return source.slice(match.index, source.indexOf("\n  }", match.index) + 4);
}
const implementation = ["scheduleAdjacentVideoWarmup", "warmVisibleAdjacentVideoPlayers", "releaseOffscreenVideoDecoder",
  "canSpeculativelyWarmShortVideo", "handleShortVideoVisibilityChange", "waitForVideoFirstFrame"].map(pageFunction).join("\n");
const settle = async () => { for (let turn = 0; turn < 24; turn++) await Promise.resolve(); };
class Media extends EventTarget {
  constructor(id, slot) {
    super();
    this.dataset = { videoId: id, shortVideoSlot: slot, streamUrl: `/fixture/${id}` };
    this.attributes = new Map([["src", `/fixture/${id}`]]);
    this.classes = new Set(slot === "current" ? [] : ["is-ghost"]);
    this.classList = { contains: value => this.classes.has(value), add: value => this.classes.add(value), remove: value => this.classes.delete(value) };
    this.isConnected = true; this.readyState = slot === "current" ? 3 : 0;
    this.currentTime = slot === "current" ? 9 : 0; this.paused = slot !== "current"; this.muted = slot !== "current";
    this.playCalls = 0; this.pauseCalls = 0; this.loadCalls = 0; this.frames = new Map(); this.frameId = 0;
  }
  get src() { return this.attributes.get("src") || ""; }
  set src(value) { this.attributes.set("src", String(value)); }
  get currentSrc() { return this.src; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  emit(name) { this.dispatchEvent(new Event(name)); }
  load() { this.loadCalls += 1; this.readyState = 0; this.currentTime = 0; this.emit("emptied"); this.emit("loadstart"); }
  pause() { this.pauseCalls += 1; this.paused = true; this.emit("pause"); }
  async play() { this.playCalls += 1; this.paused = false; this.emit("play"); }
  requestVideoFrameCallback(callback) { const handle = this.frameId++; this.frames.set(handle, callback); return handle; }
  cancelVideoFrameCallback(handle) { this.frames.delete(handle); }
  ready() { this.readyState = 2; this.emit("loadeddata"); this.emit("canplay"); this.emit("playing"); }
  paint() { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach(callback => callback(0)); }
}
function fixture() {
  let now = 1000, sequence = 0, controlSyncs = 0;
  const timers = new Map(), metrics = [], active = new Media("active", "current"), next = new Media("next", "next"), previous = new Media("previous", "prev");
  active.dataset.shortVideoFrameReady = "1";
  active.dataset.shortVideoFrameReadyAt = "1";
  const document = { hidden: false }, state = { activeView: "shortVideos", shortVideo: { current: { id: "active" } } };
  const window = {
    setTimeout(callback, delay = 0) { const handle = ++sequence; timers.set(handle, { callback, at: now + delay }); return handle; },
    clearTimeout(handle) { timers.delete(handle); }
  };
  let lifecycle;
  const context = vm.createContext({
    state, document, window, Date: { now: () => now }, Promise, Event, allowShortVideoSpeculativePrewarm,
    releaseUnusedShortVideoPreloads() {},
    shortVideoAdjacentWarmScheduleId: 0, shortVideoAdjacentWarmDirection: 1, shortVideoLastNavigationAt: 0,
    SHORT_VIDEO_RAPID_NAV_WARM_WINDOW_MS: 1200, SHORT_VIDEO_ADJACENT_WARM_RAPID_MS: 80, SHORT_VIDEO_ADJACENT_WARM_STABLE_MS: 650,
    shortVideoWatchWriteController: null,
    activePlayer: () => active,
    activeReelStack: () => ({ querySelector: selector => selector.includes("is-next") ? next : previous }),
    els: { workGrid: { querySelectorAll: () => [next, previous].filter(player => player.classList.contains("is-ghost")) } },
    warmAdjacentVideoPlayer: (...args) => lifecycle.warmAdjacentVideoPlayer(...args),
    markShortVideoPerformance: (...args) => metrics.push(args), flushActiveShortVideoWatch() {},
    syncActiveControlBar() { controlSyncs += 1; }
  });
  vm.runInContext(`${implementation}\nglobalThis.warmApi = { scheduleAdjacentVideoWarmup, warmVisibleAdjacentVideoPlayers, releaseOffscreenVideoDecoder, handleShortVideoVisibilityChange, waitForVideoFirstFrame };`, context);
  lifecycle = createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: video => video?.streamUrl || "", waitForFirstFrame: context.warmApi.waitForVideoFirstFrame });
  return {
    active, next, previous, timers, metrics, document, state, context, api: context.warmApi,
    schedule(player = next, slot = player.dataset.shortVideoSlot) { context.warmApi.scheduleAdjacentVideoWarmup(player, { id: player.dataset.videoId }, slot); },
    hide() { document.hidden = true; context.warmApi.handleShortVideoVisibilityChange(); },
    show() { document.hidden = false; context.warmApi.handleShortVideoVisibilityChange(); },
    promote(player = next) {
      player.classes.delete("is-ghost"); player.dataset.shortVideoSlot = "current";
      player.dataset.shortVideoWarmScheduleToken = String(++context.shortVideoAdjacentWarmScheduleId);
      player.paused = false; player.muted = false;
    },
    async tick(duration) {
      const end = now + duration;
      for (;;) {
        const entry = [...timers].filter(([, value]) => value.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!entry) break;
        const [handle, timer] = entry; timers.delete(handle); now = timer.at; timer.callback(); await settle();
      }
      now = end; await settle();
    },
    get controlSyncs() { return controlSyncs; }
  };
}

const mediaState = player => ({ src: player.src, time: player.currentTime, paused: player.paused, muted: player.muted,
  plays: player.playCalls, pauses: player.pauseCalls, loads: player.loadCalls });
{
  const f = fixture(), active = mediaState(f.active);
  f.schedule();
  f.hide();
  const afterHidden = mediaState(f.next);
  assert.equal(f.next.src, "");
  await f.tick(6000);
  assert.deepEqual(mediaState(f.next), afterHidden, "a queued pre-hide warm timer cannot restore or play a released ghost");
  assert.deepEqual(mediaState(f.active), active, "hiding the tab preserves existing active background playback");
}

{
  const f = fixture();
  delete f.active.dataset.shortVideoFrameReady;
  f.schedule();
  await f.tick(40); // Warmup deferred again while the active first frame is cold.
  assert.equal(typeof f.next.shortVideoCancelWarmup, "function", "cold-current work waits on owned readiness events");
  assert.equal(f.timers.size, 0, "waiting for a first frame does not poll or force a deadline warmup");
  f.hide();
  const afterHidden = mediaState(f.next);
  await f.tick(6000);
  assert.deepEqual(mediaState(f.next), afterHidden, "a deferred first-frame/cooldown retry also loses its old warm ownership on hide");
}

{
  const f = fixture();
  f.schedule(); await f.tick(40);
  assert.equal(f.next.playCalls, 1);
  f.next.ready();
  const oldFrame = [...f.next.frames.values()][0];
  assert.equal(typeof oldFrame, "function");
  f.hide();
  assert.equal(f.next.frames.size, 0, "decoder release cancels its pending painted-frame callback, including handle zero");
  const afterHidden = mediaState(f.next);
  oldFrame(0); await settle(); await f.tick(2000);
  assert.deepEqual(mediaState(f.next), afterHidden, "an in-flight old frame result cannot reload, play or resettle a released ghost");
}

{
  const f = fixture();
  f.schedule(); await f.tick(40); f.next.ready();
  f.next.paint(); // Resolve the wait; its async warm completion has not resumed yet.
  f.hide();
  const afterHidden = mediaState(f.next);
  await settle();
  assert.deepEqual(mediaState(f.next), afterHidden, "hide invalidates an already-resolved warm promise before its completion microtask can settle media");
}

{
  const f = fixture(), active = mediaState(f.active);
  f.hide();
  f.schedule(); f.api.warmVisibleAdjacentVideoPlayers();
  await f.tick(2000);
  assert.equal(f.next.src, ""); assert.equal(f.previous.src, "");
  assert.equal(f.next.playCalls, 0);
  assert.deepEqual(mediaState(f.active), active, "hidden prewarm entry points cannot touch the current player");
  f.show();
  assert.equal(f.controlSyncs, 1);
  assert.equal(f.next.src, "/fixture/next");
  assert.equal(f.next.playCalls, 1, "visibility return starts a fresh owned warmup");
  f.next.ready(); f.next.paint(); await settle();
  assert.equal(f.next.paused, true); assert.equal(f.next.preload, "metadata");
  assert.deepEqual(mediaState(f.active), active);
}

{
  const f = fixture();
  f.schedule(); await f.tick(40); f.next.ready();
  const oldFrame = [...f.next.frames.values()][0];
  f.hide(); f.show(); f.next.ready();
  f.promote();
  const promoted = mediaState(f.next);
  oldFrame?.(0); f.next.paint(); await settle();
  assert.deepEqual(mediaState(f.next), promoted, "old and new ghost warm completions cannot mute, pause or rewind a promoted visible player");
}

{
  const f = fixture();
  f.schedule(f.previous, "prev");
  f.promote(f.previous);
  const promoted = mediaState(f.previous);
  await f.tick(200);
  assert.deepEqual(mediaState(f.previous), promoted, "an old opposite-slot release timer cannot release a promoted player");
}

{
  const f = fixture(), active = mediaState(f.active);
  f.document.hidden = true;
  f.schedule(f.active, "current");
  assert.deepEqual(mediaState(f.active), active, "release invalidation still respects the active-slot boundary");
}

console.log("short-video-adjacent-visibility: hidden timer/frame invalidation, active playback preservation and fresh visible/promoted ownership passed");

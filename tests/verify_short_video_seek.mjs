import assert from "node:assert/strict";
import { createShortVideoSeekController } from "../public/modules/short-videos/seek-controller.js";

// Exercise the production seek controller with controlled pointer/media
// ownership and animation frames. No service, browser or real media is used.
class Element extends EventTarget {
  constructor() {
    super();
    this.dataset = {}; this.attributes = new Map(); this.classes = new Set();
    this.style = { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } };
    this.classList = {
      contains: (name) => this.classes.has(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, force) => { const enabled = force ?? !this.classes.has(name); this.classList[enabled ? "add" : "remove"](name); return enabled; }
    };
    this.isConnected = true; this.value = "0"; this.textContent = "";
    this.min = "0"; this.max = "1000"; this.step = "1";
    this.rect = { left: 100, top: 0, width: 400, height: 20 };
    this.clientWidth = 400; this.captures = new Set(); this.listeners = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width }; }
  focus() { this.focusCalls = Number(this.focusCalls || 0) + 1; }
  addEventListener(type, callback, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) { this.listeners.get(type)?.delete(callback); super.removeEventListener(type, callback, options); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) {
    if (!this.captures.delete(id)) return;
    // Browsers may deliver capture loss as a result of releasing capture.
    // Dispatch synchronously to catch finish paths that re-enter themselves.
    this.emit("lostpointercapture", { pointerId: id });
  }
  emit(type, properties = {}) {
    const event = new Event(type, { cancelable: true });
    for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, { value, configurable: true });
    this.dispatchEvent(event);
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0); }
}

class Media extends Element {
  constructor(id = "a", { paused = false, duration = 100 } = {}) {
    super();
    this.dataset = {
      videoId: id, shortVideoSlot: "current", shortVideoSourceGeneration: "1",
      shortVideoWarmScheduleToken: "3", shortVideoPromotedAt: "100", shortVideoPlaybackIntentGeneration: "0"
    };
    this.src = `/fixture/${id}`; this.duration = duration; this._time = 12.5;
    this.paused = paused; this.ended = false; this.readyState = 4;
    this.exact = []; this.fast = []; this.intents = []; this.playCalls = 0; this.pauseCalls = 0;
  }
  get src() { return this.getAttribute("src") || ""; }
  set src(value) { this.setAttribute("src", value); }
  get currentSrc() { return this.src; }
  get currentTime() { return this._time; }
  set currentTime(value) {
    this.exact.push(value);
    if (this.rejectSeeks || !Number.isFinite(value)) throw new Error("invalid media seek");
    this._time = value;
  }
  fastSeek(value) {
    this.fast.push(value);
    if (this.rejectFastSeek || !Number.isFinite(value)) throw new Error("fast seek unavailable");
    this._time = value;
  }
  shortVideoSetPlaybackIntent(value) {
    this.intents.push(Boolean(value));
    this.dataset.shortVideoPlaybackIntentGeneration = String(Number(this.dataset.shortVideoPlaybackIntentGeneration) + 1);
  }
  pause() { this.pauseCalls += 1; this.paused = true; this.emit("pause"); }
  async play() { this.playCalls += 1; this.paused = false; this.emit("play"); }
}

function fixture({ paused = false, duration = 100, reentrant = false } = {}) {
  const progress = new Element(), progressWrap = new Element(), time = new Element(), seekPreview = new Element();
  const player = new Media("a", { paused, duration }), frames = new Map();
  let active = player, nextFrame = 0, changes = 0, controller;
  const formatSeconds = (value) => { assert(Number.isFinite(value), "display formatting must receive only finite times"); return `t${Math.floor(value)}`; };
  controller = createShortVideoSeekController({
    progress, progressWrap, time, seekPreview, getPlayer: () => active, formatSeconds,
    onChange: () => { changes += 1; if (reentrant) controller?.sync(); },
    requestFrame: (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelFrame: (id) => frames.delete(id)
  });
  const event = (type, properties = {}) => progress.emit(type, { pointerId: 1, button: 0, isPrimary: true, clientX: 200, ...properties });
  return {
    progress, progressWrap, time, seekPreview, player, controller, frames, event,
    changes: () => changes,
    replacePlayer: (value) => { active = value; },
    flushFrame() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); }
  };
}
const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

{
  const f = fixture({ reentrant: true });
  const previousChanges = f.changes();
  f.controller.sync();
  assert.equal(f.progress.value, "125");
  assert.equal(f.time.textContent, "t12 / t100");
  assert.equal(f.progress.getAttribute("aria-valuetext"), "t12 / t100");
  assert.equal(f.progress.style["--short-video-progress"], "12.5%");
  assert.equal(f.changes(), previousChanges, "sync cannot recursively emit a UI change");
  f.controller.dispose();
}

{
  const f = fixture({ reentrant: true });
  f.event("pointerdown");
  assert.equal(f.controller.isScrubbing(), true);
  assert.equal(f.player.pauseCalls, 1);
  assert.deepEqual(f.player.intents, [false]);
  assert.equal(f.progress.hasPointerCapture(1), true);
  f.event("pointermove", { clientX: 300 });
  f.event("pointermove", { clientX: 340 });
  assert.equal(f.frames.size, 1, "multiple pointer moves must share one frame seek");
  assert.deepEqual(f.player.fast, []);
  f.flushFrame();
  assert.deepEqual(f.player.fast, [60]);
  f.event("pointermove", { clientX: 380 });
  f.event("pointermove", { clientX: 420 });
  f.flushFrame();
  assert.deepEqual(f.player.fast, [60, 80]);
  f.event("pointermove", { clientX: 440 });
  f.event("pointerup", { clientX: 460 });
  await flush();
  assert.equal(f.player.currentTime, 90, "pointer release uses an exact final seek");
  assert.equal(f.player.exact.at(-1), 90);
  assert.equal(f.frames.size, 0);
  assert.equal(f.progress.captures.size, 0);
  assert.equal(f.controller.isScrubbing(), false);
  assert.deepEqual(f.player.intents, [false, true]);
  assert.equal(f.player.playCalls, 1, "capture-loss re-entry must not resume twice");
  assert.equal(f.progress.value, "900");
  assert(f.changes() > 0);
  f.controller.dispose();
}

{
  const f = fixture();
  f.progress.rect = { left: -100, width: 400 };
  f.event("pointerdown", { clientX: 0 }); f.flushFrame();
  assert.equal(f.player.currentTime, 25, "clientX=0 is a real coordinate, not a missing coordinate");
  f.event("pointerup", { clientX: 0 }); await flush();
  assert.equal(f.player.currentTime, 25);
  f.controller.dispose();
}

for (const invalidDuration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
  const f = fixture();
  f.player.duration = invalidDuration;
  const initial = f.player.currentTime;
  f.controller.sync();
  assert.equal(f.progress.disabled, true, "unknown duration is communicated through the native range control");
  f.event("pointerdown"); f.event("pointermove", { clientX: 400 }); f.flushFrame(); f.event("pointerup");
  f.progress.value = "800"; f.event("input"); f.event("keydown", { key: "ArrowRight" });
  assert.equal(f.player.currentTime, initial, "unknown or unbounded duration cannot produce a seek");
  assert.equal(f.player.pauseCalls, 0);
  assert.equal(f.player.playCalls, 0);
  assert.equal(f.progress.captures.size, 0);
  assert.equal(f.controller.isScrubbing(), false);
  f.controller.dispose();
}

{
  const f = fixture();
  f.controller.sync();
  f.event("pointerenter", { clientX: 300 });
  assert.equal(f.seekPreview.textContent, "t50");
  assert.equal(f.progressWrap.classList.contains("is-hovering"), true);
  assert.equal(f.player.currentTime, 12.5, "hover previews must not seek or pause playback");
  assert.equal(f.player.pauseCalls, 0);
  f.event("pointerleave");
  assert.equal(f.progressWrap.classList.contains("is-hovering"), false);
  assert.equal(f.seekPreview.textContent, "t12");
  f.progress.rect.width = 0;
  f.event("pointerdown");
  assert.equal(f.controller.isScrubbing(), false, "a zero-width progress bar cannot start an invalid pointer seek");
  assert.equal(f.player.pauseCalls, 0);
  assert.equal(f.frames.size, 0);
  f.controller.dispose();
}

for (const properties of [{ button: 2 }, { button: 1 }, { isPrimary: false }]) {
  const f = fixture();
  f.event("pointerdown", properties);
  assert.equal(f.controller.isScrubbing(), false);
  assert.equal(f.player.pauseCalls, 0, "non-primary input must not disturb playback");
  assert.equal(f.frames.size, 0);
  f.controller.dispose();
}

{
  const f = fixture();
  f.event("pointerdown", { clientX: 220 });
  f.event("pointerdown", { pointerId: 2, clientX: 480 });
  f.event("pointerdown", { clientX: 480 });
  f.event("pointermove", { pointerId: 2, clientX: 480 });
  f.event("pointerup", { pointerId: 2, clientX: 480 });
  assert.equal(f.controller.isScrubbing(), true);
  assert.equal(f.player.pauseCalls, 1, "a second pointer or duplicate down cannot replace the current session");
  f.flushFrame();
  assert.equal(f.player.currentTime, 30);
  f.event("pointerup", { clientX: 220 }); await flush();
  assert.equal(f.player.playCalls, 1);
  f.controller.dispose();
}

for (const finish of ["pointercancel", "lostpointercapture", "dispose"]) {
  const f = fixture();
  f.event("pointerdown", { clientX: 220 });
  f.event("pointermove", { clientX: 300 });
  const oldFrame = [...f.frames.values()][0];
  if (finish === "dispose") f.controller.dispose({ restorePlayback: true });
  else {
    if (finish === "lostpointercapture") f.progress.captures.delete(1);
    f.event(finish, { clientX: 500 });
  }
  await flush();
  assert.equal(f.player.currentTime, 50, "cancelling commits the last valid target without reading a cancel event's unrelated coordinate");
  assert.equal(f.player.playCalls, 1, "same-owner cancellation restores prior playing intent");
  assert.equal(f.progress.captures.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.controller.isScrubbing(), false);
  const attempts = f.player.exact.length + f.player.fast.length;
  oldFrame?.(0);
  assert.equal(f.player.exact.length + f.player.fast.length, attempts, "an already cancelled frame cannot seek after cleanup");
  f.controller.dispose();
  assert.equal(f.progress.listenerCount(), 0);
}

{
  const f = fixture();
  f.controller.sync();
  f.event("pointerenter", { clientX: 220 });
  assert.equal(f.seekPreview.textContent, "t30");
  const previewPosition = f.seekPreview.style.left;
  for (const current of [20, 35, 45]) {
    f.player._time = current;
    f.controller.sync();
    assert.equal(f.seekPreview.textContent, "t30", "playback progress must not overwrite the user's hovered preview time");
    assert.equal(f.seekPreview.style.left, previewPosition);
    assert.equal(f.time.textContent, `t${current} / t100`, "the normal playback clock continues while hover preview stays fixed");
  }
  f.event("pointerleave");
  assert.equal(f.seekPreview.textContent, "t45", "leaving the progress bar returns its preview to the live playback position");
  f.controller.dispose();
}

for (const invalidate of [
  (player) => player.shortVideoSetPlaybackIntent(false),
  (player) => { player.src = "/fixture/replaced-during-capture-loss"; }
]) {
  const f = fixture();
  f.event("pointerdown", { clientX: 200 });
  f.event("pointermove", { clientX: 300 });
  const externalCaptureLoss = () => invalidate(f.player);
  f.progress.addEventListener("lostpointercapture", externalCaptureLoss);
  f.event("pointerup", { clientX: 300 }); await flush();
  assert.equal(f.player.playCalls, 0, "capture release listeners can revoke source/intent ownership before playback restoration");
  assert(!f.player.intents.includes(true), "restoration must recheck ownership after external capture-loss handlers run");
  assert.equal(f.controller.isScrubbing(), false);
  assert.equal(f.progress.captures.size, 0);
  assert.equal(f.frames.size, 0);
  f.progress.removeEventListener("lostpointercapture", externalCaptureLoss);
  f.controller.dispose();
  assert.equal(f.progress.listenerCount(), 0);
}

for (const options of [undefined, { restorePlayback: false }]) {
  const f = fixture({ reentrant: true });
  f.event("pointerdown", { clientX: 200 });
  f.event("pointermove", { clientX: 300 });
  const staleFrame = [...f.frames.values()][0];
  f.controller.dispose(options); await flush();
  assert.equal(f.player.currentTime, 12.5, "page disposal must not commit a pending drag to a media element being torn down");
  assert.equal(f.player.exact.length + f.player.fast.length, 0);
  assert.equal(f.player.playCalls, 0, "default or explicit no-restore disposal must not restart a destroyed player");
  assert.deepEqual(f.player.intents, [false]);
  assert.equal(f.controller.isScrubbing(), false);
  assert.equal(f.progress.captures.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.progress.listenerCount(), 0);
  assert.equal(f.progressWrap.classList.contains("is-scrubbing"), false);
  staleFrame?.(0);
  f.controller.dispose({ restorePlayback: true });
  assert.equal(f.player.exact.length + f.player.fast.length, 0, "late callbacks and repeated disposal cannot resurrect the abandoned drag");
  assert.equal(f.player.playCalls, 0);
}

{
  const f = fixture({ paused: true });
  f.event("pointerdown"); f.event("pointermove", { clientX: 300 }); f.event("pointerup", { clientX: 300 }); await flush();
  assert.equal(f.player.currentTime, 50);
  assert.equal(f.player.paused, true);
  assert.equal(f.player.playCalls, 0, "seeking a paused video must not start playback");
  assert(!f.player.intents.includes(true));
  f.controller.dispose();
}

for (const invalidate of [
  (f) => f.replacePlayer(new Media("b")),
  (f) => { f.player.src = "/fixture/new-source"; },
  (f) => { f.player.dataset.shortVideoSourceGeneration = "2"; },
  (f) => { f.player.dataset.videoId = "b"; },
  (f) => { f.player.dataset.shortVideoWarmScheduleToken = "4"; },
  (f) => { f.player.dataset.shortVideoPromotedAt = "200"; },
  (f) => { f.player.dataset.shortVideoSlot = "prev"; },
  (f) => { f.player.classes.add("is-ghost"); },
  (f) => { f.player.isConnected = false; },
  (f) => { f.progress.isConnected = false; },
  (f) => { f.player.shortVideoSetPlaybackIntent(false); f.player.pause(); },
  (f) => {
    f.player.dataset.shortVideoSlot = "prev"; f.player.classes.add("is-ghost");
    f.player.dataset.shortVideoWarmScheduleToken = "4"; f.player.dataset.shortVideoPromotedAt = "200";
    f.player.dataset.shortVideoSlot = "current"; f.player.classes.delete("is-ghost");
  }
]) {
  const f = fixture();
  f.event("pointerdown", { clientX: 200 });
  const oldFrame = [...f.frames.values()][0];
  invalidate(f);
  const attempts = f.player.exact.length + f.player.fast.length, plays = f.player.playCalls;
  f.event("pointermove", { clientX: 400 }); oldFrame?.(0); f.event("pointerup", { clientX: 400 }); await flush();
  assert.equal(f.player.exact.length + f.player.fast.length, attempts, "a stale seek cannot mutate a new source, role, intent or detached element");
  assert.equal(f.player.playCalls, plays, "a stale seek cannot resume an element whose playback intent belongs to a newer owner");
  assert.equal(f.progress.captures.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.controller.isScrubbing(), false);
  f.controller.dispose();
}

{
  const f = fixture();
  f.event("pointerdown", { clientX: 200 });
  const stale = [...f.frames.values()][0];
  f.event("pointercancel"); await flush();
  f.event("pointerdown", { pointerId: 2, clientX: 400 });
  const attempts = f.player.exact.length + f.player.fast.length;
  stale?.(0);
  assert.equal(f.player.exact.length + f.player.fast.length, attempts, "an old session frame cannot seek a newer session on the same video");
  assert.equal(f.frames.size, 1, "an old callback cannot consume the new session's queued frame");
  f.event("pointermove", { pointerId: 2, clientX: 420 });
  assert.equal(f.frames.size, 1, "an old callback cannot clear the new session's frame budget and allow a duplicate frame seek");
  f.flushFrame();
  assert.equal(f.player.currentTime, 80);
  f.event("pointerup", { pointerId: 2, clientX: 400 });
  f.controller.dispose();
}

{
  const f = fixture();
  f.event("pointerdown", { clientX: 450 });
  f.player.duration = 40;
  f.event("pointercancel"); await flush();
  assert.equal(f.player.currentTime, 40, "a same-owner duration correction clamps the target to the latest valid duration");
  assert.equal(f.player.playCalls, 1);
  f.controller.dispose();
}

{
  const f = fixture();
  f.player.rejectFastSeek = true;
  f.event("pointerdown", { clientX: 300 }); f.flushFrame();
  assert.equal(f.player.currentTime, 50, "an unavailable fastSeek falls back to an exact seek");
  f.event("pointerup", { clientX: 300 });
  f.controller.dispose();
}

for (const paused of [false, true]) {
  const f = fixture({ paused });
  f.player._time = 50;
  for (const [key, expected] of [["ArrowRight", 55], ["ArrowLeft", 50], ["PageUp", 60], ["PageDown", 50], ["Home", 0], ["End", 100]]) {
    const event = f.event("keydown", { key });
    assert.equal(event.defaultPrevented, true, "seek keys must be consumed before global player/navigation shortcuts");
    assert.equal(f.player.currentTime, expected);
    assert.equal(f.player.paused, paused);
  }
  f.progress.value = "250"; f.event("input");
  assert.equal(f.player.currentTime, 25);
  assert.equal(f.player.paused, paused);
  assert.equal(f.player.pauseCalls, 0);
  assert.equal(f.player.playCalls, 0, "keyboard and input seeks preserve the current playback state");
  f.controller.dispose();
}

{
  const f = fixture();
  f.player._time = 50;
  const modified = f.event("keydown", { key: "ArrowRight", shiftKey: true });
  assert.equal(modified.defaultPrevented, true);
  assert.equal(f.player.currentTime, 51, "Shift plus an arrow provides an exact one-second adjustment");
  for (const properties of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    const event = f.event("keydown", { key: "ArrowRight", ...properties });
    assert.equal(event.defaultPrevented, false, "application seek shortcuts must leave modified or composing input to its owner");
    assert.equal(f.player.currentTime, 51);
  }
  f.controller.dispose();
}

{
  const f = fixture();
  f.event("pointerdown", { clientX: 300 });
  assert.equal(f.progress.value, "500");
  const event = f.event("keydown", { key: "ArrowRight" }); await flush();
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.player.currentTime, 55, "keyboard takeover continues from the displayed scrub target rather than an older unflushed media time");
  assert.equal(f.controller.isScrubbing(), false);
  assert.equal(f.player.playCalls, 1);
  assert.equal(f.frames.size, 0);
  f.controller.dispose();
}

{
  const f = fixture();
  f.controller.dispose();
  assert.equal(f.progress.listenerCount(), 0);
  f.event("pointerdown"); f.event("input"); f.event("keydown", { key: "End" });
  assert.equal(f.player.pauseCalls, 0);
  assert.equal(f.player.exact.length, 0);
  assert.equal(f.frames.size, 0);
}

{
  const f = fixture();
  f.event("pointerdown", { clientX: 200 });
  f.event("pointermove", { clientX: 300 });
  f.event("pointerenter", { clientX: 480 });
  assert.equal(f.frames.size, 1, "pointer re-entry cannot cancel or replace the active drag's frame");
  f.flushFrame();
  assert.equal(f.player.currentTime, 50, "hover re-entry cannot change an owned drag's latest sample");
  f.event("pointerup", { clientX: 300 });
  f.controller.dispose();
}

{
  const f = fixture();
  f.event("pointerenter", { clientX: 200 });
  f.event("pointermove", { clientX: 400 });
  const staleFrame = [...f.frames.values()][0];
  f.replacePlayer(new Media("b"));
  f.controller.sync();
  assert.equal(f.frames.size, 0, "sync cancels an obsolete hover rendering frame immediately");
  assert.equal(f.progressWrap.classList.contains("is-hovering"), false);
  staleFrame?.(0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.player.fast.length + f.player.exact.length, 0);
  f.controller.dispose();
}

for (const event of ["pointercancel", "lostpointercapture"]) {
  const f = fixture();
  f.event("pointerdown", { clientX: 200 });
  f.event("pointermove", { clientX: 300 });
  f.progress.rect = { left: 100, width: 800 };
  f.event(event, { clientX: 700 });
  assert.equal(f.player.currentTime, 25, "cancellation consumes the last legitimate pointer sample with fresh layout, not the cancel event's coordinate");
  assert.equal(f.frames.size, 0);
  assert.equal(f.progress.captures.size, 0);
  f.controller.dispose();
}

{
  const f = fixture();
  f.event("pointerdown", { clientX: 200 }); f.event("pointermove", { clientX: 400 });
  const lateFrame = [...f.frames.values()][0];
  f.controller.cancel(); f.controller.cancel();
  assert.equal(f.controller.isScrubbing(), false); assert.equal(f.frames.size, 0); assert.equal(f.progress.captures.size, 0);
  lateFrame?.(0); f.event("pointercancel"); f.event("lostpointercapture"); f.event("pointerup", { clientX: 480 });
  assert.equal(f.player.currentTime, 12.5, "lifecycle cancellation retires pending samples without committing a seek");
  assert.equal(f.player.playCalls, 0, "lifecycle cancellation never restores the pre-drag playing state");
  assert.equal(f.player.paused, true); assert.deepEqual(f.player.intents, [false]);
  f.event("pointerdown", { clientX: 200 }); f.event("pointerup", { clientX: 300 });
  assert.equal(f.player.currentTime, 50, "cancellation leaves the control usable for a new interaction");
  assert.equal(f.player.playCalls, 0, "the new drag preserves the now-paused state"); f.controller.dispose();
}
{
  const f = fixture();
  f.event("pointerenter"); f.event("pointermove", { clientX: 400 });
  const lateFrame = [...f.frames.values()][0]; f.controller.cancel();
  assert.equal(f.frames.size, 0); assert.equal(f.progressWrap.classList.contains("is-hovering"), false);
  lateFrame?.(0); assert.equal(f.frames.size, 0); assert.equal(f.player.fast.length + f.player.exact.length, 0);
  f.controller.dispose(); f.controller.cancel();
}

console.log("short-video-seek: frame budget, exact seek, pointer ownership, media/intent generations, lifecycle cancellation, keyboard and disposal passed");

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoHoldSpeedController } from "../public/modules/short-videos/hold-speed-controller.js";
import { createShortVideoPlayerSourceLifecycle, disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

// Actual controller and source lifecycle, controlled pointer/media events and
// timers. No service, database, physical media or browser profile is involved.
class Target extends EventTarget {
  constructor() { super(); this.listeners = new Map(); this.isConnected = true; }
  addEventListener(name, listener, capture = false) {
    const listeners = this.listeners.get(name) || new Set(); listeners.add(listener); this.listeners.set(name, listeners);
    super.addEventListener(name, listener, capture);
  }
  removeEventListener(name, listener, capture = false) {
    this.listeners.get(name)?.delete(listener); super.removeEventListener(name, listener, capture);
  }
  get count() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
  emit(name, props = {}) {
    const event = new Event(name, { cancelable: true });
    const { target, ...attributes } = props;
    Object.assign(event, attributes);
    if (target) Object.defineProperty(event, "target", { value: target });
    this.dispatchEvent(event); return event;
  }
}
function fixture({ base = 1.5, captureFails = false } = {}) {
  const timers = new Map(), callbacks = new Map(), activated = [], finished = [], arms = [];
  let timerId = 0;
  const windowTarget = new Target(), documentTarget = new Target(), player = new Target(), stage = new Target();
  documentTarget.hidden = false;
  const state = { shortVideo: { playbackRate: base } };
  player.dataset = { videoId: "a", shortVideoSlot: "current", holdSpeedBound: "1" };
  player.src = "/fixture/a"; player.getAttribute = () => player.src;
  player.classes = new Set(); player.classList = { contains: (name) => player.classes.has(name) };
  player.paused = false; player.ended = false; player.error = null; player.playbackRate = base;
  player.playCalls = 0; player.pauseCalls = 0; player.captured = null;
  player.setPointerCapture = (id) => { if (captureFails) throw new Error("capture unavailable"); player.captured = id; };
  player.hasPointerCapture = (id) => player.captured === id;
  player.releasePointerCapture = (id) => { if (player.captured !== id) return; player.captured = null; player.emit("lostpointercapture", { pointerId: id }); };
  player.play = async () => { player.playCalls += 1; player.paused = false; };
  player.pause = () => { player.pauseCalls += 1; player.paused = true; player.emit("pause"); };
  player.load = () => { player.emit("emptied"); player.emit("loadstart"); };
  player.removeAttribute = () => { player.src = ""; };
  let activePlayer = player;
  const options = {
    player, stage, state, getActivePlayer: () => activePlayer, getBaseRate: () => state.shortVideo.playbackRate,
    normalizeRate: Number, onArm: () => arms.push(true), onActivate: (rate) => activated.push(rate), onFinish: (detail) => finished.push(detail),
    windowTarget, documentTarget,
    setTimer: (callback) => { const id = ++timerId; timers.set(id, callback); callbacks.set(id, callback); return id; },
    clearTimer: (id) => timers.delete(id)
  };
  const controller = createShortVideoHoldSpeedController(options);
  player.shortVideoCancelHoldSpeed = controller.cancel; player.shortVideoDisposeHoldSpeed = controller.dispose;
  const pointer = (target, type, props = {}) => target.emit(type, { pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX: 0, clientY: 0, ...props });
  const tick = () => { const pending = [...timers.entries()]; timers.clear(); pending.forEach(([, callback]) => callback()); };
  const arm = (props) => pointer(player, "pointerdown", props);
  const hold = (props) => { arm(props); tick(); assert.equal(player.playbackRate, 2); };
  const clean = () => {
    controller.dispose(); assert.equal(timers.size, 0); assert.equal(windowTarget.count, 0); assert.equal(documentTarget.count, 0);
    assert.equal(player.count, 0); assert.equal(player.captured, null); assert.equal(player.dataset.holdSpeedActive, undefined);
    assert.equal(player.playCalls, 0, "hold changes rate only, never playback intent");
  };
  return { player, stage, state, controller, options, timers, callbacks, windowTarget, documentTarget, activated, finished, arms,
    pointer, tick, arm, hold, clean, setActive: (value) => { activePlayer = value; } };
}

for (const captureFails of [false, true]) {
  const f = fixture({ captureFails }); f.hold();
  assert.deepEqual(f.activated, [1.5]);
  f.pointer(f.windowTarget, "pointerup", { clientX: 1200 });
  assert.equal(f.player.playbackRate, 1.5, "release outside the element restores the base rate");
  assert.equal(f.finished.length, 1); assert.equal(f.finished[0].suppressClick, true);
  assert.equal(f.windowTarget.count, 0); f.clean();
}

{
  const f = fixture({ base: 3 }); f.hold(); f.state.shortVideo.playbackRate = 1.25;
  f.pointer(f.player, "lostpointercapture");
  assert.equal(f.player.playbackRate, 1.25, "restoration uses the newest preference rather than the armed value");
  assert.equal(f.finished.length, 1, "synchronous lostcapture during release cannot finish twice"); f.clean();
}
{
  const f = fixture({ base: 3 }); f.hold(); f.controller.cancel();
  assert.equal(f.player.playbackRate, 3); assert.equal(f.state.shortVideo.playbackRate, 3); f.clean();
}
for (const event of ["pointercancel", "pause", "emptied", "loadstart", "blur", "visibilitychange"]) {
  const f = fixture(); f.hold();
  if (event === "blur") f.windowTarget.emit(event);
  else if (event === "visibilitychange") { f.documentTarget.hidden = true; f.documentTarget.emit(event); }
  else f.pointer(f.player, event);
  assert.equal(f.player.playbackRate, 1.5, `${event} cannot leave temporary speed behind`); f.clean();
}

for (const invalidate of [
  (f) => { f.player.isConnected = false; }, (f) => { f.stage.isConnected = false; },
  (f) => { f.player.dataset.videoId = "b"; }, (f) => { f.player.src = "/fixture/new"; },
  (f) => { f.player.dataset.shortVideoSourceGeneration = "1"; }, (f) => { f.player.dataset.shortVideoSlot = "prev"; },
  (f) => { f.player.dataset.shortVideoPromotedAt = "new"; }, (f) => { f.player.dataset.shortVideoWarmScheduleToken = "new"; },
  (f) => { f.player.dataset.shortVideoPlaybackIntentGeneration = "1"; }, (f) => { f.setActive({}); },
  (f) => { f.player.classes.add("is-ghost"); }, (f) => { f.player.paused = true; }
]) {
  const f = fixture(); f.arm(); invalidate(f); f.tick();
  assert.equal(f.activated.length, 0, "a delayed timer cannot activate a different source/role/intent");
  assert.equal(f.player.playbackRate, 1.5); f.clean();
}

{
  const f = fixture(); f.arm(); const old = [...f.callbacks.values()][0]; f.controller.cancel();
  f.arm(); old(); assert.equal(f.timers.size, 1, "a late cancelled callback cannot clear a new timer");
  assert.equal(f.activated.length, 0); f.tick(); assert.equal(f.activated.length, 1); f.clean();
}
{
  const f = fixture(); f.arm(); const oldRelease = [...f.windowTarget.listeners.get("pointerup")][0];
  f.controller.cancel(); f.hold();
  oldRelease({ pointerId: 1 });
  assert.equal(f.player.playbackRate, 2, "a late previous release listener cannot cancel a new gesture with the same pointer id");
  f.pointer(f.windowTarget, "pointerup"); assert.equal(f.player.playbackRate, 1.5); f.clean();
}
for (const type of ["touch", "pen"]) {
  const f = fixture(); f.hold({ pointerType: type });
  f.pointer(f.windowTarget, "pointerdown", { pointerId: 2, pointerType: type, isPrimary: false });
  assert.equal(f.player.playbackRate, 1.5); assert.equal(f.windowTarget.count, 0); f.clean();
}
{
  const f = fixture(); f.arm(); f.arm();
  assert.equal(f.timers.size, 1); assert.equal(f.arms.length, 1);
  f.pointer(f.player, "pointermove", { clientX: 13 }); f.tick(); assert.equal(f.activated.length, 0);
  f.hold(); f.pointer(f.player, "pointermove", { clientX: 33 }); assert.equal(f.player.playbackRate, 1.5); f.clean();
}
for (const props of [{ button: 2 }, { isPrimary: false }, { clientX: NaN }, { pointerId: undefined }]) {
  const f = fixture(); f.arm(props); f.tick(); assert.equal(f.activated.length, 0); f.clean();
}
{
  const f = fixture(); f.hold(); f.controller.cancel();
  const click = f.player.emit("click", { detail: 1 }); assert.equal(click.defaultPrevented, true);
  const keyboardClick = f.player.emit("click", { detail: 0 }); assert.equal(keyboardClick.defaultPrevented, false);
  f.arm(); const realClick = f.player.emit("click", { detail: 1 }); assert.equal(realClick.defaultPrevented, false); f.clean();
}

for (const release of [false, true]) {
  const f = fixture(); f.hold();
  disposeShortVideoMedia({ querySelectorAll: (selector) => selector === "video, audio" ? [f.player] : [] }, { release });
  assert.equal(f.player.playbackRate, 1.5); assert.equal(f.windowTarget.count, 0);
  assert.equal(f.player.dataset.holdSpeedActive, undefined);
  if (release) assert.equal(f.player.count, 0, "real disposal removes controller bindings");
  f.clean();
}
{
  const f = fixture(); f.hold();
  const lifecycle = createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: () => "/fixture/a", waitForFirstFrame: async () => true });
  lifecycle.ensureShortVideoPlayerSource(f.player, { id: "a" }, { source: "/fixture/new", forceReload: true });
  assert.equal(f.player.playbackRate, 1.5); assert.equal(f.player.dataset.holdSpeedActive, undefined);
  assert.equal(f.player.dataset.shortVideoSourceGeneration, "1"); f.clean();
}

const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function pageFunction(name) {
  const start = source.indexOf(`  function ${name}(`), end = source.indexOf("\n  }", start);
  assert(start >= 0 && end > start); return source.slice(start, end + 4);
}
{
  const f = fixture(), preferences = [];
  const context = vm.createContext({ state: f.state, normalizePlaybackRate: Number, writePlaybackRatePreference: (value) => preferences.push(value),
    els: { workGrid: { querySelectorAll: () => [f.player], querySelector: () => null } }, formatPlaybackRate: (value) => `${value}x`, showBrowserToast() {} });
  vm.runInContext(`${pageFunction("setPlaybackRate")}\nglobalThis.changeRate = setPlaybackRate;`, context);
  f.hold(); context.changeRate(1.25);
  assert.equal(f.player.playbackRate, 1.25); assert.equal(f.player.dataset.holdSpeedActive, undefined);
  assert.deepEqual(preferences, [1.25], "only the explicit base-speed action persists a preference"); f.clean();
}

{
  const f = fixture(); f.controller.dispose();
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = Object.assign(f.windowTarget, { setTimeout: f.options.setTimer, clearTimeout: f.options.clearTimer });
  globalThis.document = f.documentTarget;
  try {
    const context = vm.createContext({ createShortVideoHoldSpeedController, state: f.state, activePlayer: () => f.player,
      normalizePlaybackRate: Number, pendingPlayerTap: null, clearPendingPlayerClick() {}, snapStackBack() {},
      SHORT_VIDEO_HOLD_ARM_MOVE_TOLERANCE: 12, SHORT_VIDEO_HOLD_ACTIVE_MOVE_TOLERANCE: 32,
      holdSpeedGestureConsumed: false, suppressNextPlayerClick: false, window: globalThis.window,
      showHoldSpeedFeedback() {}, clearHoldSpeedFeedback() {} });
    vm.runInContext(`${pageFunction("bindHoldToSpeed")}\nglobalThis.bind = bindHoldToSpeed;`, context);
    context.bind(f.stage, f.player);
    const previousRateButton = new Target();
    f.stage.focus = () => f.windowTarget.emit("blur", { target: previousRateButton });
    f.stage.addEventListener("pointerdown", () => f.stage.focus());
    let nativeClicks = 0;
    f.player.addEventListener("click", () => { if (!context.suppressNextPlayerClick) nativeClicks += 1; });
    f.arm();
    // Native pointerdown bubbles from video to stage; stage.focus() blurs the
    // previously focused rate button. Window capture sees that child blur,
    // but it is not a window deactivation and must not cancel the new hold.
    f.pointer(f.stage, "pointerdown");
    assert.equal(f.timers.size, 1);
    f.tick(); assert.equal(f.player.playbackRate, 2, "first hold still activates after focus moves from the rate button to the stage");
    f.pointer(f.windowTarget, "pointerup");
    f.player.emit("click", { detail: 1 }); assert.equal(nativeClicks, 0, "the long hold's tail click is consumed");
    f.arm({ pointerId: 2 }); f.pointer(f.windowTarget, "pointerup", { pointerId: 2 });
    f.player.emit("click", { detail: 1 });
    assert.equal(nativeClicks, 1, "an immediate new tap can pause without a global click-suppression delay");
    assert.equal(context.suppressNextPlayerClick, false);
    f.arm(); f.tick();
    f.windowTarget.emit("blur");
    assert.equal(f.player.playbackRate, 1.5, "actual window deactivation must still cancel the hold");
    f.player.shortVideoDisposeHoldSpeed();
    assert.equal(f.windowTarget.count, 0); assert.equal(f.documentTarget.count, 0); assert.equal(f.timers.size, 0);
  } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
}

console.log("short-video-hold-speed: pointer/capture ownership, late timers, source/intent cancellation, base preference and disposal passed");

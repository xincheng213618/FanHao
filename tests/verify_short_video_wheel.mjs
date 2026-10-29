import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoWheelController, normalizeShortVideoWheelDelta } from "../public/modules/short-videos/wheel-controller.js";

// Exercise actual wheel state and event dispatch with an explicit clock. Timer
// callbacks can be delivered after cancellation to reproduce queued callbacks
// racing a pointer gesture, route replacement or controller disposal.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function sourceFunction(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, `missing current page function: ${name}`);
  const end = source.indexOf("\n  }", match.index);
  assert(end > match.index, `missing function boundary: ${name}`);
  return source.slice(match.index, end + 4);
}
const event = (extra = {}) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; }, ...extra });

function fixture() {
  let time = 1000, timerId = 0, key = "a", scope = "feed:a", connected = true, locked = false, pointer = false, ignoreUntil = 0;
  let navigationResult = Promise.resolve();
  const calls = [], pending = new Map(), history = new Map();
  const owner = () => ({ key, scope });
  const controller = createShortVideoWheelController({
    captureOwner: () => connected ? owner() : null,
    ownsOwner: value => Boolean(value && connected && value.key === key && value.scope === scope),
    clearOwner: (...args) => calls.push({ name: "clear-owner", args }),
    onDrag: (...args) => calls.push({ name: "drag", args }),
    onSnap: (...args) => calls.push({ name: "snap", args }),
    onCancelDrag: (...args) => calls.push({ name: "cancel-drag", args }),
    onFlushDrag: (...args) => calls.push({ name: "flush-drag", args }),
    onNavigate: (...args) => { calls.push({ name: "navigate", args }); return navigationResult; },
    queueDirection: (...args) => calls.push({ name: "queue", args }),
    onError: error => calls.push({ name: "error", error }),
    isLocked: () => locked, getIgnoreUntil: () => ignoreUntil, getScope: () => scope,
    hasPointerSession: () => pointer, now: () => time,
    pageHeight: () => 640,
    setTimer(callback, delay) {
      const id = ++timerId, timer = { callback, at: time + delay, delay };
      pending.set(id, timer); history.set(id, timer); return id;
    },
    clearTimer(id) { pending.delete(id); }
  });
  const advance = (milliseconds, run = true) => {
    time += milliseconds;
    if (!run) return;
    for (let count = 0; count < 100; count++) {
      const due = [...pending].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) return;
      const [id, timer] = due[0]; pending.delete(id); timer.callback();
    }
    assert.fail("wheel timers did not reach a stable future deadline");
  };
  return { controller, calls, pending, history, advance,
    input: (deltaY, extra = {}) => controller.handle(event({ deltaY, ...extra })),
    setOwner: value => { key = value; }, setScope: value => { scope = value; },
    setPointer: value => { pointer = value; }, setLocked: value => { locked = value; },
    setConnected: value => { connected = value; }, setIgnoreUntil: value => { ignoreUntil = value; },
    setNavigationResult: value => { navigationResult = value; },
    now: () => time,
    count: name => calls.filter(call => call.name === name).length
  };
}

assert.equal(normalizeShortVideoWheelDelta(event({ deltaY: 48 })), 48);
assert.equal(normalizeShortVideoWheelDelta(event({ deltaY: 3, deltaMode: 1 })), 48, "line-mode wheel input must use a physical-distance scale");
assert.equal(normalizeShortVideoWheelDelta(event({ deltaY: 1, deltaMode: 2 }), { pageHeight: 640 }), 640, "page-mode input must not be dropped by a pixel-noise threshold");
for (const detail of [
  { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true },
  { deltaX: 140, deltaY: 90 }, { deltaY: NaN }, { deltaY: Infinity }, { deltaY: -Infinity }
]) assert(!normalizeShortVideoWheelDelta(event({ deltaY: 100, ...detail })), "native modified, handled, horizontal or invalid wheel input must remain unconsumed");

{
  const f = fixture();
  assert.equal(f.input(40), true);
  assert.equal(f.count("navigate"), 0);
  assert.equal(f.count("drag"), 1);
  f.advance(20);
  f.input(45);
  assert.equal(f.count("navigate"), 1, "ordinary pixel deltas accumulate into one navigation");
  assert.equal(f.calls.find(call => call.name === "navigate").args[0], 1);
  f.controller.dispose();
}

{
  const f = fixture();
  assert.equal(f.input(1, { deltaMode: 2 }), true);
  assert.equal(f.count("navigate"), 1);
  f.controller.dispose();
}

{
  const f = fixture();
  f.input(100);
  assert.equal(f.count("navigate"), 1);
  f.setOwner("b");
  for (const delta of [45, 30, 20, 12, 6]) { f.advance(25); f.input(delta); }
  assert.equal(f.count("navigate"), 1, "momentum after promotion remains part of the consumed gesture");
  f.advance(240);
  f.input(100);
  assert.equal(f.count("navigate"), 2, "a new gesture after the quiet window is accepted");
  f.controller.dispose();
}

{
  const f = fixture();
  f.input(100);
  f.advance(170, false);
  f.input(-100);
  assert.deepEqual(f.calls.filter(call => call.name === "navigate").map(call => call.args[0]), [1, -1], "a clear reverse gesture must be accepted without waiting for old inertia to time out");
  f.controller.dispose();
}

{
  const f = fixture();
  f.input(100);
  f.setLocked(true);
  f.advance(170, false);
  f.input(-100);
  assert.equal(f.count("navigate"), 1);
  assert.equal(f.calls.find(call => call.name === "queue")?.args[0], -1, "an explicit reverse during handoff retains the latest direction");
  f.controller.dispose();
}

{
  const f = fixture();
  f.setPointer(true);
  assert.equal(f.input(100), false, "wheel input cannot take over an active pointer/touch drag");
  assert.equal(f.count("navigate"), 0);
  assert.equal(f.count("drag"), 0);
  f.controller.dispose();
}

for (const takeover of ["pointer", "owner", "scope", "disconnect", "dispose"]) {
  const f = fixture();
  f.input(40);
  const late = [...f.history.values()].map(timer => timer.callback);
  if (takeover === "pointer") { f.setPointer(true); f.controller.cancel(); }
  if (takeover === "owner") f.setOwner("replacement");
  if (takeover === "scope") f.setScope("new feed");
  if (takeover === "disconnect") f.setConnected(false);
  if (takeover === "dispose") f.controller.dispose();
  const mark = f.calls.length;
  f.advance(500, false);
  late.forEach(callback => callback());
  const newCalls = f.calls.slice(mark);
  assert(!newCalls.some(call => ["snap", "cancel-drag", "flush-drag", "navigate", "drag"].includes(call.name)), `${takeover}: a cancelled or obsolete reset cannot alter a new interaction`);
  f.controller.dispose();
}

{
  const f = fixture();
  f.input(40);
  const oldCallbacks = [...f.history.values()].map(timer => timer.callback);
  f.controller.cancel();
  f.advance(20);
  f.input(40);
  const pending = f.pending.size, mark = f.calls.length;
  oldCallbacks.forEach(callback => callback());
  assert.equal(f.pending.size, pending, "a queued cancelled callback cannot clear a newer wheel timer");
  assert.equal(f.calls.length, mark, "a queued cancelled callback cannot snap a newer wheel gesture");
  f.controller.dispose();
  assert.equal(f.pending.size, 0);
  assert.equal(f.input(100), false, "disposed wheel controllers ignore later native events");
}

{
  const f = fixture();
  let finish;
  f.setNavigationResult(new Promise(resolve => { finish = resolve; }));
  f.input(100);
  f.controller.cancel();
  f.advance(20);
  f.input(40);
  assert.equal(f.pending.size, 1);
  finish();
  for (let index = 0; index < 8; index++) await Promise.resolve();
  assert.equal(f.pending.size, 1, "a late navigation completion cannot clear a replacement gesture's reset timer");
  f.controller.dispose();
}

{
  const f = fixture();
  let fail;
  f.setNavigationResult(new Promise((resolve, reject) => { fail = reject; }));
  f.input(100);
  f.controller.cancel();
  f.advance(20); f.input(40);
  fail(new Error("superseded navigation"));
  for (let index = 0; index < 8; index++) await Promise.resolve();
  assert.equal(f.count("error"), 0, "a cancelled navigation cannot surface an obsolete playback error");
  assert.equal(f.pending.size, 1, "an obsolete navigation rejection cannot clear the current reset timer");
  f.controller.dispose();
}

{
  const f = fixture();
  let fail;
  f.setNavigationResult(new Promise((resolve, reject) => { fail = reject; }));
  f.input(100);
  f.controller.cancel({ preserveConsumed: true });
  fail(new Error("current fallback navigation failed"));
  for (let index = 0; index < 8; index++) await Promise.resolve();
  assert.equal(f.count("error"), 1, "a preserved current navigation must still report its own failure");
  assert.equal(f.count("navigate"), 1, "reporting the original navigation failure cannot repeat the action");
  f.controller.dispose();
}

function pageFixture() {
  const calls = [], listeners = new Map(), timers = new Map(), frames = new Map();
  let handle = 0, now = 1000, modal = "", stack;
  const state = { activeView: "shortVideos", shortVideo: { current: { id: "a" }, query: "", dragging: false } };
  function node(tagName = "div", names = [], parentElement = null) {
    const classes = new Set(names);
    const result = { nodeType: 1, tagName: tagName.toUpperCase(), classes, parentElement, isConnected: true, dataset: {}, attrs: {},
      scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      classList: { add: (...items) => items.forEach(item => classes.add(item)), remove: (...items) => items.forEach(item => classes.delete(item)),
        contains: item => classes.has(item), toggle(item, force) { if (force ?? !classes.has(item)) classes.add(item); else classes.delete(item); } },
      style: { setProperty(name, value) { calls.push({ name: "style", node: result, property: name, value }); } },
      getAttribute(name) { return this.attrs[name] ?? null; },
      contains(candidate) { for (let current = candidate; current; current = current.parentElement) if (current === this) return true; return false; },
      closest(selector) {
        for (let current = this; current; current = current.parentElement) for (const part of selector.split(",").map(item => item.trim())) {
          const requested = [...part.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
          const tag = /^([a-z]+)/i.exec(part)?.[1];
          const attribute = /^\[([\w-]+)=["']?([^"'\]]+)/.exec(part);
          if (requested.length && requested.every(value => current.classes?.has(value))) return current;
          if (!requested.length && tag && tag.toUpperCase() === current.tagName) return current;
          if (attribute && current.attrs?.[attribute[1]] === attribute[2]) return current;
        }
        return null;
      }, querySelector: () => null
    };
    return result;
  }
  const browser = node("div", ["short-video-browser"]);
  const player = node("video", ["short-video-player"]);
  player.dataset = { videoId: "a", shortVideoSourceGeneration: "1", shortVideoSlot: "current" };
  player.attrs.src = "/fixture/a";
  const replaceStack = () => { stack = node("div", ["short-video-reel-stack"], browser); player.parentElement = stack; };
  replaceStack();
  const windowDouble = {
    innerHeight: 640,
    addEventListener(name, callback) { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); },
    setTimeout(callback, delay) { const id = ++handle; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++handle; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  const context = vm.createContext({
    state, Math, Number, String, Boolean, Map, Set, Array, Date: { now: () => now },
    window: windowDouble, document: { addEventListener() {}, querySelector: selector => modal && selector.includes(modal) ? {} : null },
    els: { workGrid: { querySelector(selector) { return selector === ".short-video-browser" ? browser : modal && selector.includes(modal) ? {} : null; } } },
    createShortVideoWheelController: options => createShortVideoWheelController({ ...options, now: () => now, setTimer: windowDouble.setTimeout, clearTimer: windowDouble.clearTimeout }),
    shortVideoWheelController: null, wheelLocked: false, wheelIgnoreUntil: 0, queuedAdjacentDirection: 0,
    eventsInstalled: false, touchGestureOwner: null, pointerGestureOwner: null, touchIdentifier: null, pointerIdentifier: null,
    touchBlockedUntilLift: false, touchControlInteraction: false, touchHorizontalDragging: false, pointerHorizontalDragging: false, pointerDragging: false,
    touchStartX: 0, touchStartY: 0, touchDeltaX: 0, touchDeltaY: 0, touchLastX: 0, touchLastY: 0, touchLastAt: 0, touchVelocityX: 0, touchVelocityY: 0,
    pointerStartX: 0, pointerStartY: 0, pointerDeltaX: 0, pointerDeltaY: 0, pointerLastX: 0, pointerLastY: 0, pointerLastAt: 0, pointerVelocityX: 0, pointerVelocityY: 0,
    suppressNextPlayerClick: false, holdSpeedGestureConsumed: false, holdSpeedGestureBlockUntil: 0,
    reelDragRaf: 0, reelDragDeltaY: 0, reelDragOwner: null, reelDragToken: 0, reelBoundaryResetTimer: 0,
    shortVideoNavigationState: null, shortVideoOpenRequestId: 0,
    SHORT_VIDEO_WHEEL_DISTANCE: 82, WHEEL_GESTURE_IDLE_MS: 220, WHEEL_NEW_GESTURE_GAP_MS: 160,
    activeReelStack: () => stack, activePlayer: () => player, activeGalleryPlayer: () => null,
    shortVideoNavigationScope: () => state.shortVideo.query,
    openAdjacent: direction => { calls.push({ name: "navigate", direction }); return Promise.resolve(); },
    applyDragDelta: delta => { stack.style.setProperty("--short-video-drag-y", `${delta}px`); },
    clearBoundaryPulse() {}, handleShortVideoVisibilityChange() {}, syncShortVideoFullscreenControls() {}, flushActiveShortVideoWatch() {},
    handleShortVideoFullscreenChange() {}, handleShortVideoPictureInPictureChange() {},
    shortVideoFullscreenController: null, cancelShortVideoFullscreen() {},
    cancelShortVideoNativePlaybackModes() {},
    handleShortVideoPageHide() {}, handleShortVideoPageShow() {},
    clearPendingPlayerClick() {}, showError: error => { throw error; },
    isShortVideoAuthorIndexPage: () => false, shouldHandleShortVideoShortcut: () => false
  });
  const ownerStart = source.indexOf("  function hasShortVideoBrowseOverlay(");
  const ownerEnd = source.indexOf("  function installBrowseEvents(", ownerStart);
  assert(ownerStart >= 0 && ownerEnd > ownerStart);
  vm.runInContext([source.slice(ownerStart, ownerEnd), ...[
    "installBrowseEvents", "getShortVideoWheelController", "handleWheelSwipe", "scheduleWheelGestureRelease",
    "isShortVideoOverlayTarget", "isShortVideoKeyboardControl", "isHorizontalSwipe",
    "scheduleReelDragDelta", "flushReelDragDelta", "cancelReelDragDelta", "snapStackBack"
  ].map(sourceFunction), "installBrowseEvents();"].join("\n"), context);
  const dispatch = (name, extra = {}) => {
    const value = event({ target: player, pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, clientX: 180, clientY: 500, ...extra });
    for (const callback of listeners.get(name) || []) callback(value);
    return value;
  };
  return { context, calls, state, node, player, browser, timers, frames, dispatch, replaceStack,
    get stack() { return stack; },
    setModal: value => { modal = value; }, advance: value => { now += value; },
    dispose() { context.shortVideoWheelController?.dispose(); }
  };
}

for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 140, deltaY: 90 }, { defaultPrevented: true }]) {
  const f = pageFixture();
  const input = f.dispatch("wheel", { deltaY: 100, ...extra });
  assert.equal(input.defaultPrevented, Boolean(extra.defaultPrevented), "the installed native handler must leave zoom, horizontal and previously handled events to their owners");
  assert(!f.calls.some(call => call.name === "navigate"));
  f.dispose();
}

for (const kind of ["input", "caption", "picker"]) {
  const f = pageFixture();
  let target = f.player;
  if (kind === "input") target = f.node("input", [], f.browser);
  if (kind === "caption") {
    const copy = f.node("div", ["short-video-caption-copy", "is-expanded"], f.browser);
    target = f.node("p", [], copy); target.scrollHeight = 500; target.clientHeight = 100;
    copy.querySelector = selector => selector === "p" ? target : null;
  }
  if (kind === "picker") f.setModal("short-video-collection-picker");
  const input = f.dispatch("wheel", { target, deltaY: 100 });
  assert.equal(input.defaultPrevented, false, `${kind}: native scrolling is preserved before preventDefault`);
  assert(!f.calls.some(call => call.name === "navigate"));
  f.dispose();
}

{
  const f = pageFixture();
  const input = f.dispatch("wheel", { deltaY: 1, deltaMode: 2 });
  assert.equal(input.defaultPrevented, true);
  assert.equal(f.calls.filter(call => call.name === "navigate").length, 1, "page-mode input reaches the current page's navigation callback");
  f.dispose();
}

for (const takeover of ["pointer", "route"]) {
  const f = pageFixture();
  f.dispatch("wheel", { deltaY: 40 });
  const oldReset = [...f.timers.values()][0].callback;
  if (takeover === "route") { f.replaceStack(); f.state.shortVideo.current = { id: "b" }; }
  f.dispatch("pointerdown"); f.advance(40); f.dispatch("pointermove", { clientY: 300 });
  assert.equal(f.stack.classes.has("is-dragging"), true);
  const frameCount = f.frames.size;
  oldReset();
  assert.equal(f.stack.classes.has("is-dragging"), true, `${takeover}: a queued old wheel reset cannot snap a current pointer drag`);
  assert.equal(f.frames.size, frameCount, `${takeover}: a queued old wheel reset cannot cancel the pointer frame`);
  f.dispose();
}

console.log("short-video-wheel: native event gates, normalization, scrolling controls, momentum, reverse gestures, handoff and timer ownership passed");

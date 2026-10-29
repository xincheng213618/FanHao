import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Run the current page's installed event listeners. Inputs and media are
// independent doubles; no browser, real media, database or wall-clock wait.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function sourceFunction(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, `missing current page function: ${name}`);
  const end = source.indexOf("\n  }", match.index);
  assert(end > match.index, `missing function boundary: ${name}`);
  return source.slice(match.index, end + 4);
}

const ownerStart = source.indexOf("  function hasShortVideoBrowseOverlay(");
const ownerEnd = source.indexOf("  function installBrowseEvents(", ownerStart);
assert(ownerStart >= 0 && ownerEnd > ownerStart, "the page must expose its current browse-gesture ownership helpers");
const gestureImplementation = [source.slice(ownerStart, ownerEnd), ...[
  "installBrowseEvents", "handleShortVideoVisibilityChange", "isHorizontalSwipe", "scheduleReelDragDelta", "flushReelDragDelta", "cancelReelDragDelta"
].map(sourceFunction)].join("\n");

function fixture() {
  const calls = [], mutations = [], handlers = new Map(), documentHandlers = new Map(), timers = new Map(), frames = new Map();
  let handle = 0, now = 1000, currentStack, currentPanel, currentPlayer, currentGallery, modal = "";
  const state = { activeView: "shortVideos", shortVideo: {
    current: { id: "a" }, mode: "feed", collectionId: "", query: "", source: "liked", deleted: "all", authorAccountStatus: "all", dragging: false
  } };
  function makeNode(name) {
    const classes = new Set();
    return {
      name, isConnected: true, dataset: {}, classes,
      classList: {
        add(...values) { values.forEach(value => classes.add(value)); mutations.push({ node: name, operation: "add", values }); },
        remove(...values) { values.forEach(value => classes.delete(value)); mutations.push({ node: name, operation: "remove", values }); },
        contains: value => classes.has(value),
        toggle(value, force) { const next = force ?? !classes.has(value); if (next) classes.add(value); else classes.delete(value); mutations.push({ node: name, operation: "toggle", values: [value, next] }); }
      },
      style: {
        setProperty(key, value) { mutations.push({ node: name, operation: "style", key, value }); },
        removeProperty(key) { mutations.push({ node: name, operation: "remove-style", key }); }
      }
    };
  }
  const browser = makeNode("browser");
  function replaceStack(id = state.shortVideo.current.id) {
    currentStack = makeNode(`stack:${id}:${++handle}`);
    currentPanel = makeNode(`panel:${id}:${handle}`);
    currentPanel.dataset.videoId = id;
    currentPlayer = makeNode(`player:${id}:${handle}`);
    currentPlayer.dataset = { videoId: id, shortVideoSourceGeneration: "1", shortVideoPromotedAt: "1", shortVideoSlot: "current" };
    currentPlayer.currentSrc = `/fixture/${id}`;
    currentPlayer.getAttribute = function(key) { return key === "src" ? this.currentSrc : null; };
    currentPlayer.closest = selector => selector.includes("short-video-stage") ? currentPanel : null;
    currentGallery = makeNode(`gallery:${id}:${handle}`);
    const capturedGallery = currentGallery;
    currentGallery.shortVideoGalleryDragCancel = () => calls.push({ name: "gallery-cancel", stack: capturedGallery.name, id });
    currentStack.querySelector = selector => selector.includes("is-current") ? currentPanel : null;
    currentPanel.querySelector = selector => selector.includes("gallery") ? currentGallery : selector.includes("player") ? currentPlayer : null;
  }
  replaceStack();
  const target = { closest(selector) {
    if (selector === ".short-video-browser") return browser;
    if (selector === ".short-video-reel-stack") return currentStack;
    if (selector.includes("short-video-reel-panel")) return currentPanel;
    return null;
  } };
  browser.contains = node => node === target;
  const call = (name, detail = {}) => calls.push({ name, stack: currentStack.name, id: state.shortVideo.current?.id, ...detail });
  const context = vm.createContext({
    state, Math, Number, String, Boolean, Map, Set, Array,
    Date: { now: () => now }, eventsInstalled: false,
    touchStartX: 0, touchStartY: 0, touchDeltaX: 0, touchDeltaY: 0, touchHorizontalDragging: false,
    touchLastX: 0, touchLastY: 0, touchLastAt: 0, touchVelocityX: 0, touchVelocityY: 0, touchControlInteraction: false,
    pointerStartX: 0, pointerStartY: 0, pointerDeltaX: 0, pointerDeltaY: 0, pointerHorizontalDragging: false,
    pointerDragging: false, pointerLastX: 0, pointerLastY: 0, pointerLastAt: 0, pointerVelocityX: 0, pointerVelocityY: 0,
    suppressNextPlayerClick: false, holdSpeedGestureConsumed: false, holdSpeedGestureBlockUntil: 0,
    reelDragRaf: 0, reelDragDeltaY: 0, reelDragOwner: null, reelDragToken: 0,
    touchGestureOwner: null, touchIdentifier: null, touchBlockedUntilLift: false,
    pointerGestureOwner: null, pointerIdentifier: null,
    shortVideoOpenRequestId: 0, shortVideoNavigationState: null,
    shortVideoWheelController: null,
    shortVideoWatchWriteController: null,
    window: {
      addEventListener(name, listener) { const list = handlers.get(name) || []; list.push(listener); handlers.set(name, list); },
      removeEventListener(name, listener) { handlers.set(name, (handlers.get(name) || []).filter(item => item !== listener)); },
      requestAnimationFrame(callback) { const id = ++handle; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
      setTimeout(callback) { const id = ++handle; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    document: {
      addEventListener(name, listener) { const list = documentHandlers.get(name) || []; list.push(listener); documentHandlers.set(name, list); },
      querySelector: selector => modal && selector.includes(modal) ? {} : null,
      hidden: false
    },
    els: { workGrid: { querySelector(selector) {
      if (selector === ".short-video-browser") return browser;
      if (selector.includes("short-video-reel-stack")) return currentStack;
      if (selector.includes("is-current")) return currentPanel;
      if (modal && selector.includes(modal)) return {};
      return null;
    }, querySelectorAll: () => [] } },
    activeReelStack: () => currentStack, activePlayer: () => currentPlayer, activeGalleryPlayer: () => currentGallery,
    shortVideoNavigationScope: () => JSON.stringify([state.shortVideo.mode, state.shortVideo.collectionId, state.shortVideo.query]),
    isShortVideoOverlayTarget: node => Boolean(node?.overlay), isShortVideoKeyboardControl: node => Boolean(node?.control),
    snapStackBack: () => call("snap"),
    startActiveGalleryDrag: () => { call("gallery-start"); return true; },
    updateActiveGalleryDrag: delta => { call("gallery-move", { delta }); return true; },
    finishActiveGalleryDrag: (delta, velocity) => { call("gallery-finish", { delta, velocity }); return true; },
    cancelActiveGalleryDrag: () => { call("gallery-cancel"); return true; },
    applyDragDelta: delta => call("reel-move", { delta }),
    clearBoundaryPulse() {},
    finishDrag: (delta, velocity) => { state.shortVideo.dragging = false; call("finish", { delta, velocity }); },
    handleHorizontalSwipe: delta => call("horizontal", { delta }),
    markShortVideoGestureClickBlocked: () => call("block-click"),
    syncActiveControlBar() {}, warmVisibleAdjacentVideoPlayers() {}, releaseOffscreenVideoDecoder() {}, releaseUnusedShortVideoPreloads() {},
    syncShortVideoFullscreenControls() {}, flushActiveShortVideoWatch() {},
    handleShortVideoFullscreenChange() {}, handleShortVideoPictureInPictureChange() {},
    shortVideoFullscreenController: null, cancelShortVideoFullscreen() {},
    cancelShortVideoNativePlaybackModes() {},
    handleShortVideoPageHide() {}, handleShortVideoPageShow() {},
    isShortVideoAuthorIndexPage: () => false, handleWheelSwipe() {}, shouldHandleShortVideoShortcut: () => false
  });
  vm.runInContext(`${gestureImplementation}\ninstallBrowseEvents();`, context);
  function event(name, detail = {}) {
    const value = { target, pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, clientX: 180, clientY: 500,
      touches: [], changedTouches: [], defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...detail };
    for (const handler of handlers.get(name) || []) handler(value);
    return value;
  }
  const point = (identifier, x = 180, y = 500) => ({ identifier, clientX: x, clientY: y });
  return { context, state, calls, mutations, frames, browser, target, event, point,
    advance: milliseconds => { now += milliseconds; },
    setModal: value => { modal = value; },
    dispatchDocument(name) { for (const listener of documentHandlers.get(name) || []) listener(); },
    get stack() { return currentStack; }, get player() { return currentPlayer; }, get gallery() { return currentGallery; },
    replaceStack,
    clearCalls() { calls.length = 0; mutations.length = 0; }
  };
}

const navigated = f => f.calls.some(call => (call.name === "finish" && call.delta !== 0) || call.name === "gallery-finish" || call.name === "horizontal");

{
  const f = fixture();
  f.event("touchmove", { touches: [f.point(1, 180, 120)] });
  f.event("touchend", { changedTouches: [f.point(1, 180, 120)] });
  assert.equal(f.calls.length, 0, "an orphan touchmove/end cannot use the coordinates of a previous or nonexistent gesture");
  assert.equal(f.state.shortVideo.dragging, false);
}

for (const input of ["touch", "pointer"]) {
  const f = fixture();
  if (input === "touch") {
    f.event("touchstart", { touches: [f.point(7)] });
    f.advance(40);
    f.event("touchmove", { touches: [f.point(7, 180, 300)] });
    f.event("touchend", { changedTouches: [f.point(7, 180, 300)] });
  } else {
    f.event("pointerdown"); f.advance(40);
    f.event("pointermove", { clientY: 300 });
    f.event("pointerup", { clientY: 300 });
  }
  const finish = f.calls.find(call => call.name === "finish" && call.delta !== 0);
  assert.equal(finish?.delta, -200, `${input}: a valid single-contact vertical swipe preserves its distance`);
  assert(finish.velocity < 0, `${input}: a valid swipe preserves directional velocity`);
}

for (const input of ["touch", "pointer"]) {
  const f = fixture();
  if (input === "touch") {
    f.event("touchstart", { touches: [f.point(7)] }); f.advance(40);
    f.event("touchmove", { touches: [f.point(7, 20, 500)] });
    f.event("touchend", { changedTouches: [f.point(7, 20, 500)] });
  } else {
    f.event("pointerdown"); f.advance(40);
    f.event("pointermove", { clientX: 20 }); f.event("pointerup", { clientX: 20 });
  }
  assert(f.calls.some(call => call.name === "gallery-start"));
  assert.equal(f.calls.find(call => call.name === "gallery-finish")?.delta, -160, `${input}: horizontal gallery drag remains usable`);
  assert(!f.calls.some(call => call.name === "finish" && call.delta !== 0), "gallery swipes must not also navigate the reel");
}

{
  const f = fixture();
  f.event("pointerdown", { pointerId: 2, isPrimary: false });
  f.event("pointermove", { pointerId: 2, isPrimary: false, clientY: 200 });
  f.event("pointerup", { pointerId: 2, isPrimary: false, clientY: 200 });
  assert.equal(f.calls.length, 0, "a non-primary pointer cannot begin a reel gesture");
}

{
  const f = fixture();
  f.event("pointerdown", { pointerId: 4 }); f.advance(40);
  f.event("pointermove", { pointerId: 4, clientY: 300 });
  f.event("pointermove", { pointerId: 9, clientY: 50 });
  f.event("pointerup", { pointerId: 9, clientY: 50 });
  assert.equal(navigated(f), false, "an unrelated pointerup cannot finish the tracked pointer");
  f.event("pointerup", { pointerId: 4, clientY: 300 });
  assert.equal(f.calls.find(call => call.name === "finish" && call.delta)?.delta, -200);
}

{
  const f = fixture();
  f.event("touchstart", { touches: [f.point(7)] }); f.advance(40);
  f.event("touchmove", { touches: [f.point(7, 180, 300)] });
  f.event("touchend", { touches: [f.point(7, 180, 300)], changedTouches: [f.point(8, 180, 50)] });
  assert.equal(navigated(f), false, "lifting another touch cannot finish the tracked finger");
}

{
  const f = fixture();
  f.event("touchstart", { touches: [f.point(7)] }); f.advance(40);
  f.event("touchmove", { touches: [f.point(7, 180, 300)] });
  f.event("touchstart", { touches: [f.point(7, 180, 300), f.point(8, 180, 100)], changedTouches: [f.point(8, 180, 100)] });
  f.event("touchend", { touches: [f.point(7, 180, 300)], changedTouches: [f.point(8, 180, 100)] });
  f.event("touchend", { changedTouches: [f.point(7, 180, 300)] });
  assert.equal(navigated(f), false, "adding a second finger cancels reel navigation for that contact sequence");
  assert.equal(f.state.shortVideo.dragging, false);
}

for (const input of ["touch", "pointer"]) for (const change of [
  "id", "stack", "scope", "source", "source-url", "video-id", "slot", "promotion", "warm", "intent",
  "inactive", "open-generation", "navigation-owner", "ghost", "detached", "gallery-detached"
]) {
  const f = fixture();
  const originalStack = f.stack;
  if (input === "touch") {
    f.event("touchstart", { touches: [f.point(7)] }); f.advance(40);
    f.event("touchmove", { touches: [f.point(7, 180, 300)] });
  } else {
    f.event("pointerdown"); f.advance(40); f.event("pointermove", { clientY: 300 });
  }
  if (change === "id") f.state.shortVideo.current = { id: "b" };
  if (change === "stack") f.replaceStack();
  if (change === "scope") f.state.shortVideo.query = "new query";
  if (change === "source") f.player.dataset.shortVideoSourceGeneration = "2";
  if (change === "source-url") f.player.currentSrc = "/fixture/replacement";
  if (change === "video-id") f.player.dataset.videoId = "replacement";
  if (change === "slot") f.player.dataset.shortVideoSlot = "next";
  if (change === "promotion") f.player.dataset.shortVideoPromotedAt = "2";
  if (change === "warm") f.player.dataset.shortVideoWarmScheduleToken = "2";
  if (change === "intent") f.player.dataset.shortVideoPlaybackIntentGeneration = "2";
  if (change === "inactive") f.state.activeView = "home";
  if (change === "open-generation") f.context.shortVideoOpenRequestId += 1;
  if (change === "navigation-owner") f.context.shortVideoNavigationState = { id: "new-navigation" };
  if (change === "ghost") f.player.classes.add("is-ghost");
  if (change === "detached") f.stack.isConnected = false;
  if (change === "gallery-detached") f.gallery.isConnected = false;
  f.clearCalls();
  if (input === "touch") f.event("touchend", { changedTouches: [f.point(7, 180, 300)] });
  else f.event("pointerup", { clientY: 300 });
  assert.equal(navigated(f), false, `${input}/${change}: an obsolete gesture cannot navigate the current work`);
  if (change === "stack") assert(!f.mutations.some(mutation => mutation.node === f.stack.name), "stale cleanup must not alter the replacement stack");
  assert.equal(originalStack.classes.has("is-dragging"), false, `${input}/${change}: old drag visuals are cleared`);
}

for (const modal of ["short-video-more-overlay", "short-video-search-overlay", "short-video-author-panel", "short-video-collection-picker"]) {
  const f = fixture();
  f.event("pointerdown"); f.advance(40); f.event("pointermove", { clientY: 300 });
  f.setModal(modal);
  f.clearCalls();
  f.event("pointerup", { clientY: 300 });
  assert.equal(navigated(f), false, `${modal}: opening an overlay invalidates an in-flight reel gesture`);
  assert.equal(f.state.shortVideo.dragging, false);
}

{
  const f = fixture();
  f.event("touchstart", { touches: [f.point(7)] }); f.advance(40);
  f.event("touchmove", { touches: [f.point(7, 180, 300)] });
  f.event("touchend", { touches: [f.point(8)], changedTouches: [f.point(7, 180, 300)] });
  f.event("touchend", { changedTouches: [f.point(8, 180, 50)] });
  assert.equal(navigated(f), false, "a release with another finger remaining cancels even if its earlier touchstart was not delivered");
  assert.equal(f.state.shortVideo.dragging, false);
}

{
  const f = fixture();
  f.event("pointerdown"); f.advance(40); f.event("pointermove", { clientY: 300 });
  f.event("pointerup", { clientY: 300, target: { overlay: true, closest: () => null } });
  assert.equal(navigated(f), false, "releasing over an overlay cannot commit reel navigation");
}

for (const reason of ["blur", "hidden", "pointercancel", "touchcancel"]) {
  const f = fixture();
  const touch = reason === "touchcancel";
  if (touch) {
    f.event("touchstart", { touches: [f.point(7)] }); f.advance(40);
    f.event("touchmove", { touches: [f.point(7, 180, 300)] });
  } else {
    f.event("pointerdown"); f.advance(40); f.event("pointermove", { clientY: 300 });
  }
  f.clearCalls();
  if (reason === "hidden") {
    f.context.document.hidden = true;
    f.dispatchDocument("visibilitychange");
  } else f.event(reason);
  if (touch) f.event("touchend", { changedTouches: [f.point(7, 180, 300)] });
  else f.event("pointerup", { clientY: 300 });
  assert.equal(navigated(f), false, `${reason}: cancellation cannot turn into navigation on a later release`);
  assert.equal(f.state.shortVideo.dragging, false, `${reason}: drag state must release without another user gesture`);
  assert.equal(f.stack.classes.has("is-dragging"), false);
  assert.equal(f.frames.size, 0, `${reason}: pending drag rendering is released`);
}

{
  const f = fixture();
  f.event("pointerdown"); f.advance(40); f.event("pointermove", { clientY: 300 });
  assert.equal(f.frames.size, 1, "drag rendering is coalesced into a single animation frame");
  const staleFrame = [...f.frames.values()][0];
  f.replaceStack("b");
  f.clearCalls();
  staleFrame(0);
  assert(!f.calls.some(call => call.name === "reel-move"), "a queued drag frame cannot move the replacement reel stack");
  assert(!f.mutations.some(mutation => mutation.node === f.stack.name), "a queued old frame cannot clear or style the replacement stack");
}

{
  const f = fixture();
  f.event("pointerdown", { pointerId: 4 }); f.advance(40); f.event("pointermove", { pointerId: 4, clientY: 300 });
  const staleFrame = [...f.frames.values()][0];
  f.event("blur");
  f.event("pointerdown", { pointerId: 8 }); f.advance(40); f.event("pointermove", { pointerId: 8, clientY: 350 });
  assert.equal(f.frames.size, 1);
  staleFrame(0);
  f.event("pointermove", { pointerId: 8, clientY: 320 });
  assert.equal(f.frames.size, 1, "a cancelled old callback cannot consume a newer gesture's frame budget");
  assert.equal(f.calls.filter(call => call.name === "reel-move").length, 0, "a cancelled callback cannot paint the newer gesture using stale timing");
}

console.log("short-video-gestures: single-contact navigation, pointer/touch identity, orphan events, route/source ownership, modal/blur cancellation and queued-frame safety passed");

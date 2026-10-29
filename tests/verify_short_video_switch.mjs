import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the page's actual switch/prime functions. Media preparation and
// animation completion are independently controlled; no media, service or
// database is used, and a cold preparation deliberately never resolves.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  function shortVideoNavigationScope(");
const end = source.indexOf("  function adjacentPlayer(", start);
assert(start >= 0 && end > start, "the current page must expose its adjacent-switch implementation");
const switchSource = source.slice(start, end);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 24; index++) await Promise.resolve(); }
function observe(promise) {
  const result = { state: "pending" };
  promise.then((value) => { result.state = "fulfilled"; result.value = value; }, (error) => { result.state = "rejected"; result.error = error; });
  return result;
}

function fixture({ galleryIds = [], current = "a" } = {}) {
  const videos = new Map(["a", "b", "c", "d"].map((id) => [id, { id, gallery: galleryIds.includes(id) }]));
  const ids = [...videos.keys()];
  const panels = new Map();
  const animations = [], warms = [], preparations = [], calls = [], errors = [], timers = new Map();
  let stack, timerId = 0;
  const state = { activeView: "shortVideos", shortVideo: { current: videos.get(current), playbackRate: 1, muted: false } };
  const panelFor = (id) => {
    if (!id) return null;
    if (panels.has(id)) return panels.get(id);
    const video = videos.get(id);
    const player = video.gallery ? null : {
      dataset: { videoId: id }, currentTime: 0, currentSrc: `/fixture/${id}`, readyState: 0,
      isConnected: true, muted: true, volume: 0.5, playbackRate: 1, playCalls: 0,
      classes: new Set(["is-ghost"]),
      classList: { contains: (name) => panels.get(id)?.player.classes.has(name) || false },
      getAttribute: () => `/fixture/${id}`,
      play() { this.playCalls += 1; return Promise.resolve(); }
    };
    const gallery = video.gallery ? {
      shortVideoGallerySetActive() {},
      shortVideoGalleryPrepare() { const pending = deferred(); preparations.push({ ...pending, id }); return pending.promise; }
    } : null;
    const panel = {
      dataset: { videoId: id }, isConnected: true, player, gallery,
      querySelector(selector) {
        if (selector === ".short-video-gallery-player") return gallery;
        if (selector.includes("short-video-player")) return player;
        return null;
      }
    };
    panels.set(id, panel);
    return panel;
  };
  const makeStack = () => ({
    current: null, prev: null, next: null,
    querySelector(selector) {
      return selector.includes("is-prev") ? this.prev : selector.includes("is-next") ? this.next : this.current;
    }
  });
  stack = makeStack();
  const update = (video) => {
    const index = ids.indexOf(video.id);
    state.shortVideo.current = video;
    state.shortVideo.prevId = ids[index - 1] || "";
    state.shortVideo.nextId = ids[index + 1] || "";
    state.shortVideo.prevVideo = videos.get(state.shortVideo.prevId) || null;
    state.shortVideo.nextVideo = videos.get(state.shortVideo.nextId) || null;
    stack.current = panelFor(video.id);
    stack.prev = panelFor(state.shortVideo.prevId);
    stack.next = panelFor(state.shortVideo.nextId);
    stack.current?.player?.classes.delete("is-ghost");
    stack.prev?.player?.classes.add("is-ghost");
    stack.next?.player?.classes.add("is-ghost");
  };
  update(videos.get(current));
  const context = vm.createContext({
    state, Date, Promise, AbortController,
    wheelLocked: false, wheelDeltaY: 0, wheelIgnoreUntil: 0, wheelResetTimer: 0,
    shortVideoWheelController: null, cancelShortVideoAutoNext() {}, flushShortVideoAutoNext() {},
    queuedAdjacentDirection: 0, shortVideoAdjacentWarmDirection: 1, shortVideoLastNavigationAt: 0,
    shortVideoAdjacentWarmScheduleId: 0, SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS: 1200,
    shortVideoNavigationState: null, shortVideoOpenRequestId: 0, shortVideoAdjacentRequestId: 0, shortVideoOpenReadController: null,
    isDeletedShortVideo: () => false,
    window: {
      setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    els: { workGrid: { querySelector: () => null } },
    activeReelStack: () => stack,
    activePlayer: () => stack.current?.player || null,
    cancelShortVideoBrowseGestures() {},
    adjacentPlayer: (direction) => (direction < 0 ? stack.prev : stack.next)?.player || null,
    cachedShortVideo: (id) => videos.get(id),
    shortVideoFeedParams: () => "",
    hydratePromotedShortVideo: async () => {},
    syncCurrentNavigationDom() {}, showBrowserToast() {},
    isGalleryPost: (video) => Boolean(video?.gallery),
    markShortVideoPerformance: (name, detail) => calls.push({ name, detail }),
    markShortVideoCacheState: () => calls.push({ name: "cache" }),
    clearPendingPlayerClick() {}, closeTransientPlayerControls() {},
    flushActiveShortVideoWatch: () => calls.push({ name: "flush-watch" }),
    pulseBoundaryStack: (direction) => calls.push({ name: "boundary", direction }),
    animateActiveStack: (direction, motion) => {
      const pending = deferred(); animations.push({ ...pending, direction, motion }); return pending.promise;
    },
    warmAdjacentVideoPlayer: (player, video, options) => {
      const pending = deferred(); warms.push({ ...pending, player, video, options }); return pending.promise;
    },
    currentShortVideoVolume: () => 0.5,
    normalizePlaybackRate: (value) => Number(value || 1),
    promoteAdjacentPanelDom: (direction, video) => { calls.push({ name: "promote-panel", direction, id: video.id }); return Promise.resolve(); },
    promoteAdjacentMedia: (video, direction, options = {}) => {
      calls.push({ name: "promote-media", direction, id: video.id, renderCurrent: Boolean(options.renderCurrent) });
      update(video);
    },
    openVideo: async (id, options) => { calls.push({ name: "open-video", id, options }); update({ id }); },
    scheduleWheelGestureRelease: () => calls.push({ name: "gesture-release" }),
    showError: (error) => errors.push(error)
  });
  vm.runInContext(`${switchSource}\nglobalThis.switchApi = { openAdjacent, prepareAdjacentGallery, primeAdjacentSound };`, context);
  return {
    context, state, videos, panels, calls, errors, animations, warms, preparations, timers,
    get stack() { return stack; },
    replaceStack() { stack = { ...stack }; },
    navigate: (direction) => observe(context.switchApi.openAdjacent(direction)),
    prime: (direction) => context.switchApi.primeAdjacentSound(direction, direction < 0 ? state.shortVideo.prevVideo : state.shortVideo.nextVideo)
  };
}

{
  const f = fixture();
  const first = f.navigate(1);
  assert.equal(f.animations.length, 1);
  assert.equal(f.warms.length, 1);
  f.animations[0].resolve(); await flush();
  assert.equal(first.state, "fulfilled", "a cold media warmup must not hold the navigation after its animation");
  assert.equal(f.state.shortVideo.current.id, "b");
  assert.equal(f.context.wheelLocked, false);
  assert(f.calls.some((call) => call.name === "adjacent-switch-promoting-unready"), "cold switches retain diagnostics and may show the incoming poster");
  const second = f.navigate(1);
  f.animations[1].resolve(); await flush();
  assert.equal(second.state, "fulfilled");
  assert.equal(f.state.shortVideo.current.id, "c", "another switch must be accepted while the first warmup is still pending");
  assert.equal(f.context.wheelLocked, false);
}

{
  const f = fixture({ galleryIds: ["b"] });
  const result = f.navigate(1);
  assert.equal(f.preparations.length, 1);
  assert.equal(f.animations.length, 1, "gallery decode must run beside the animation rather than before it");
  f.animations[0].resolve(); await flush();
  assert.equal(result.state, "fulfilled", "a gallery with a pending first image must remain navigable");
  assert.equal(f.state.shortVideo.current.id, "b");
  assert(f.calls.some((call) => call.name === "promote-panel" && call.id === "b"), "the prepared gallery node is still promoted for reuse");
  assert.equal(f.timers.size, 0, "gallery decode must not introduce a separate blocking timeout");
}

{
  const f = fixture();
  const player = f.stack.next.player;
  player.currentTime = 7;
  player.muted = false;
  const priming = observe(f.prime(1));
  assert.equal(f.warms.length, 1);
  assert.equal(player.muted, true, "the destination must be silent before asynchronous first-frame preparation starts");
  player.currentTime = 9;
  player.muted = false;
  player.volume = 0.8;
  player.playbackRate = 2;
  const playCalls = player.playCalls;
  f.warms[0].resolve(true); await flush();
  assert.equal(priming.state, "fulfilled");
  assert.equal(player.currentTime, 9, "late priming must not seek a promoted/reused video back to zero");
  assert.equal(player.muted, false, "late priming must not mute the current video");
  assert.equal(player.volume, 0.8);
  assert.equal(player.playbackRate, 2);
  assert.equal(player.playCalls, playCalls, "late priming must not issue another play request");
}

for (const invalidate of [
  (player) => { player.isConnected = false; },
  (player) => { player.classes.delete("is-ghost"); },
  (player) => { player.dataset.videoId = "another-video"; }
]) {
  const f = fixture();
  const player = f.stack.next.player;
  player.muted = false;
  invalidate(player);
  assert.equal(await f.prime(1), false);
  assert.equal(f.warms.length, 0, "priming must reject an element that no longer owns the requested ghost role");
  assert.equal(player.muted, false, "a rejected prime must not mutate the new owner's sound state");
}

{
  const f = fixture();
  const first = f.navigate(1);
  f.navigate(-1);
  assert.equal(f.context.queuedAdjacentDirection, -1);
  f.animations[0].resolve(); await flush();
  assert.equal(first.state, "fulfilled");
  assert.equal(f.state.shortVideo.current.id, "b");
  assert.equal(f.animations.length, 2, "a queued reverse request must start as soon as the first switch completes");
  assert.equal(f.animations[1].direction, -1);
  f.animations[1].resolve(); await flush();
  assert.equal(f.state.shortVideo.current.id, "a");
  assert.equal(f.context.wheelLocked, false);
  f.warms.forEach((warm) => warm.resolve(true)); await flush();
  assert.equal(f.state.shortVideo.current.id, "a", "late preparations must not reorder completed navigation");
}

for (const invalidate of [
  (f) => { f.state.activeView = "home"; f.state.shortVideo.current = null; },
  (f) => { f.state.shortVideo.current = f.videos.get("c"); },
  (f) => { f.replaceStack(); }
]) {
  const f = fixture();
  const result = f.navigate(1);
  f.context.queuedAdjacentDirection = 1;
  invalidate(f);
  f.animations[0].resolve(); await flush();
  assert.equal(result.state, "fulfilled");
  assert(!f.calls.some((call) => ["promote-panel", "promote-media", "open-video"].includes(call.name)), "an obsolete animation must not navigate a different view or stack");
  assert.equal(f.context.wheelLocked, false);
  assert.equal(f.context.queuedAdjacentDirection, 0, "obsolete scene requests must not leak into the replacement scene");
}

{
  const f = fixture();
  const result = f.navigate(1);
  const oldPanel = f.stack.next;
  oldPanel.isConnected = false;
  f.stack.next = { ...oldPanel, isConnected: true, dataset: { videoId: "c" } };
  f.animations[0].resolve(); await flush();
  assert.equal(result.state, "fulfilled");
  assert(!f.calls.some((call) => call.name === "promote-panel"), "a replaced adjacent panel cannot stand in for the originally requested video");
  assert(f.calls.some((call) => call.name === "promote-media" && call.id === "b" && call.renderCurrent), "cached requested content must render safely if its original panel disappeared");
}

{
  const f = fixture();
  f.state.shortVideo.nextVideo = null;
  f.videos.delete("b");
  const result = f.navigate(1);
  f.animations[0].resolve(); await flush();
  assert.equal(result.state, "fulfilled");
  assert(f.calls.some((call) => call.name === "open-video" && call.id === "b"), "uncached neighbors must still use normal detail loading");
  assert.equal(f.context.wheelLocked, false);
}

for (const failurePhase of ["animation", "promotion"]) {
  const f = fixture();
  const failure = new Error(`${failurePhase} fixture`);
  if (failurePhase === "promotion") f.context.promoteAdjacentPanelDom = () => { throw failure; };
  const result = f.navigate(1);
  f.animations[0][failurePhase === "animation" ? "reject" : "resolve"](failure);
  await flush();
  assert.equal(result.state, "rejected");
  assert.equal(result.error, failure);
  assert.equal(f.context.wheelLocked, false, "navigation errors must release the input lock");
  assert(f.calls.some((call) => call.name === "gesture-release"));
}

{
  const f = fixture();
  const result = f.navigate(1);
  f.warms[0].reject(new Error("unavailable warmup")); await flush();
  f.animations[0].resolve(); await flush();
  assert.equal(result.state, "fulfilled", "failed warmup must not prevent reaching or leaving a failed item");
  assert.equal(f.state.shortVideo.current.id, "b");
}

{
  const f = fixture();
  const result = f.navigate(-1);
  await flush();
  assert.equal(result.state, "fulfilled");
  assert(f.calls.some((call) => call.name === "boundary" && call.direction === -1));
  assert.equal(f.animations.length, 0);
  assert.equal(f.context.wheelLocked, false);
}

console.log("short-video-switch: cold preparation, queued reverse navigation, late results, ownership, fallback and failure release passed");

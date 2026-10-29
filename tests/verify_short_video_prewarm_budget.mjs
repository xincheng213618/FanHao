import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoMediaCache } from "../public/modules/short-videos/media-cache.js";
import { createShortVideoPlayerSourceLifecycle } from "../public/modules/short-videos/player-source-lifecycle.js";
import { allowShortVideoSpeculativePrewarm } from "../public/modules/short-videos/prewarm-policy.js";
import { createShortVideoFirstFrameController } from "../public/modules/short-videos/first-frame-controller.js";
import { runShortVideoRead } from "../public/modules/short-videos/read-request.js";

// Actual page scheduler, cache, first-frame waiter and source lifecycle. The
// controlled clocks/media count requested work, not browser bytes or timings.
const helpersFile = new URL("./verify_short_video_adjacent_visibility.mjs", import.meta.url);
let helpers = fs.readFileSync(helpersFile, "utf8");
helpers = helpers.slice(0, helpers.indexOf("\nconst mediaState ="));
helpers = helpers.replaceAll("import.meta.url", JSON.stringify(helpersFile.href));
helpers = helpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helpersFile).href}"`);
const { fixture: adjacentFixture, source: pageSource, pageFunction } = await import(`data:text/javascript;base64,${Buffer.from(`${helpers}\nexport { fixture, source, pageFunction };`).toString("base64")}`);
const settle = async () => { for (let turn = 0; turn < 24; turn++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class Element extends EventTarget {
  constructor(tag, environment) {
    super(); this.tagName = tag.toUpperCase(); this.environment = environment; this.dataset = {}; this.attributes = new Map();
    this.children = []; this.style = {}; this.className = ""; this.readyState = 0; this.paused = true; this.ended = false;
    this.currentTime = 0; this.plays = 0; this.pauses = 0; this.loads = 0; this.frames = new Map(); this.frameId = 0;
    this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
  }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  get firstElementChild() { return this.children[0] || null; }
  get src() { return this.getAttribute("src") || ""; }
  set src(value) { this.setAttribute("src", value); }
  get currentSrc() { return this.pendingSelection ? "" : this.src; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { nodes.forEach(node => { node.remove(); node.parentElement = this; this.children.push(node); }); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith(".") ? node.classList.contains(selector.slice(1)) : node.tagName.toLowerCase() === selector;
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return selector.startsWith(".") && this.classList.contains(selector.slice(1)) ? this : this.parentElement?.closest(selector) || null; }
  load() { this.loads++; if (this.readyState) this.dispatchEvent(new Event("emptied")); this.readyState = 0; }
  pause() { this.pauses++; this.paused = true; this.dispatchEvent(new Event("pause")); }
  async play() { this.plays++; this.paused = false; this.dispatchEvent(new Event("play")); this.environment?.onPlay?.(this); }
  requestVideoFrameCallback(callback) { const id = this.frameId++; this.frames.set(id, callback); return id; }
  cancelVideoFrameCallback(id) { this.frames.delete(id); }
  ready() { this.readyState = 3; ["loadeddata", "canplay", "playing"].forEach(name => this.dispatchEvent(new Event(name))); }
  paint() { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach(callback => callback(0)); }
}

const saved = Object.fromEntries(["window", "document", "navigator", "Image"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

// Reuse the existing controlled reel DOM, replacing its media stubs with the
// real source lifecycle and first-frame controller for this regression.
const reelHelpersFile = new URL("./verify_short_video_reel_metadata.mjs", import.meta.url);
let reelHelpers = fs.readFileSync(reelHelpersFile, "utf8");
reelHelpers = reelHelpers.slice(0, reelHelpers.indexOf("\ntry {"));
reelHelpers = reelHelpers.replaceAll("import.meta.url", JSON.stringify(reelHelpersFile.href));
reelHelpers = reelHelpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, reelHelpersFile).href}"`);
reelHelpers = reelHelpers.replace("function fixture({ canonical = null } = {})", "function fixture({ canonical = null, renderOptions = {}, rendererSource = '', setup = () => ({}) } = {})");
reelHelpers = reelHelpers.replace("currentTime: 12, paused: true, readyState: 3", "currentTime: 0, paused: true, readyState: 0");
reelHelpers = reelHelpers.replace("  vm.runInContext(`${implementation}", "  Object.assign(context, setup({ context, cached, create, doc, win, frames, timers }));\n  vm.runInContext(`${implementation}");
reelHelpers = reelHelpers.replace("`${implementation}\\nglobalThis.render = renderReelPanel;`", "`${implementation}\\n${rendererSource}\\nglobalThis.render = renderReelPanel;`");
reelHelpers = reelHelpers.replace("const rendered = context.render(cached)", "const rendered = context.render(cached, renderOptions)");
reelHelpers = reelHelpers.replace("...rendered, root, player, cached, cachedSnapshot, state, calls, frames,", "...rendered, root, player, cached, cachedSnapshot, state, calls, frames, timers, context,");
const { fixture: reelFixture } = await import(`data:text/javascript;base64,${Buffer.from(`${reelHelpers}\nexport { fixture };`).toString("base64")}`);

function renderFixture({ ghost = true, prewarmed = false, rendererSource = "" } = {}) {
  let waits = 0;
  const controllers = [], scheduled = [];
  const f = reelFixture({ renderOptions: { ghost, slot: ghost ? "next" : "current" }, rendererSource, setup({ cached, create }) {
    const lifecycle = createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: video => video.streamUrl, waitForFirstFrame: async () => true });
    let player = null;
    if (prewarmed) { player = create("video"); player.src = cached.streamUrl; player.dataset.streamUrl = cached.streamUrl; }
    return { ensureShortVideoPlayerSource: lifecycle.ensureShortVideoPlayerSource,
      scheduleAdjacentVideoWarmup: (...args) => scheduled.push(args), takePrewarmedShortVideoPlayer: () => player,
      waitForVideoFirstFrame: media => { waits++; return Promise.resolve(media.readyState >= 2); },
      createShortVideoFirstFrameController: options => { const controller = createShortVideoFirstFrameController(options); controllers.push(controller); return controller; }
    };
  } });
  return { ...f, controllers, scheduled, get waits() { return waits; } };
}

async function renderDoesNotIssueGhostMedia(rendererSource = "") {
  for (const constrained of [false, true]) {
    const gate = adjacentFixture();
    if (constrained) gate.context.navigator = { connection: { saveData: true, effectiveType: "2g" } };
    else { gate.active.readyState = 0; delete gate.active.dataset.shortVideoFrameReady; }
    const f = renderFixture({ rendererSource });
    assert.equal(f.player.src, "", "initial ghost construction cannot bind a source ahead of the warm budget");
    assert.equal(f.player.loadCalls, 0); assert.equal(f.player.playCalls, 0);
    assert.equal(f.player.dataset.streamUrl, f.cached.streamUrl); assert.equal(f.scheduled.length, 1);
    // Even spurious readiness events for a source-less ghost must not create
    // first-frame waits or retries.
    ["loadeddata", "canplay", "playing", "shortvideoframeready"].forEach(name => f.player.dispatchEvent(new Event(name)));
    f.controllers[0].check(); f.flushFrames(); await settle();
    assert.equal(f.waits, 0); assert.equal(f.controllers[0].attempts, 0); assert.equal(f.timers.size, 0);
    gate.api.scheduleAdjacentVideoWarmup(f.player, f.cached, "next"); await gate.tick(60000);
    assert.equal(f.player.src, ""); assert.equal(f.player.loadCalls, 0, "denied/cold ghost cleanup cannot call load before budget admission");
    assert.equal(f.player.playCalls, 0); f.dispose();
  }
}
await renderDoesNotIssueGhostMedia();
{
  const gate = adjacentFixture(), f = renderFixture();
  gate.api.scheduleAdjacentVideoWarmup(f.player, f.cached, "next"); await gate.tick(40);
  assert.equal(f.player.src, f.cached.streamUrl); assert.equal(f.player.loadCalls, 1); assert.equal(f.player.playCalls, 1);
  f.player.readyState = 3; f.player.dispatchEvent(new Event("canplay")); await settle();
  assert.equal(f.player.paused, true, "admitted real ghost warmup still loads and settles normally"); f.dispose();
}
{
  const gate = adjacentFixture(), f = renderFixture();
  gate.context.navigator = { connection: { saveData: true, effectiveType: "2g" } };
  Object.assign(gate.context, { adjacentPlayer: () => f.player, currentShortVideoVolume: () => .5, normalizePlaybackRate: Number, SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS: 300 });
  gate.state.shortVideo.playbackRate = 1;
  vm.runInContext(`${pageFunction("primeAdjacentSound")}\nglobalThis.prime=primeAdjacentSound;`, gate.context);
  const prime = gate.context.prime(1, f.cached); f.player.readyState = 3; f.player.dispatchEvent(new Event("canplay")); await settle();
  assert.equal(await prime, true); assert.equal(f.player.src, f.cached.streamUrl); assert.equal(f.player.loadCalls, 1);
  f.dispose();
}
for (const prewarmed of [false, true]) {
  const f = renderFixture({ ghost: false, prewarmed });
  assert.equal(f.player.src, f.cached.streamUrl); assert.equal(f.player.loadCalls, prewarmed ? 0 : 1,
    "active construction loads normally and a canonical prewarmed player retains its source without reload");
  f.dispose();
}

function fixture({ factory = createShortVideoMediaCache } = {}) {
  const environment = {}, elements = [], timers = new Map(), requests = [], metrics = [], writes = [];
  let clock = 1000, timerId = 0;
  const connection = { saveData: false, effectiveType: "4g" };
  const window = { setTimeout(callback, delay = 0) { const id = timerId++; timers.set(id, { callback, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id) };
  const body = new Element("body", environment); body.connected = true;
  const document = { body, hidden: false, createElement: tag => { const node = new Element(tag, environment); elements.push(node); return node; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { connection } });
  globalThis.window = window; globalThis.document = document;
  globalThis.Image = class extends Element { constructor() { super("img", environment); elements.push(this); this.complete = !environment.pendingImages; this.naturalWidth = this.complete ? 1 : 0; } };
  const context = vm.createContext({ window, document, Event, Promise, Date: { now: () => clock }, markShortVideoPerformance: (...args) => metrics.push(args) });
  vm.runInContext(`${pageFunction("waitForVideoFirstFrame")}\nglobalThis.wait = waitForVideoFirstFrame;`, context);
  const cache = factory({
    api: url => { const request = { url, ...deferred() }; requests.push(request); return request.promise; },
    cacheAuthorPanelVideo: video => writes.push(video), cachedAuthorPanelVideo: () => null, getFeedParams: () => "source=liked",
    galleryImageEntries: video => video.images || [], isGalleryPost: video => Boolean(video?.gallery), markPerformance: (...args) => metrics.push(args),
    shortVideoCardCoverUrl: video => video.coverUrl || "", shortVideoPlaybackUrl: video => video?.streamUrl || "", waitForVideoFirstFrame: context.wait
  });
  const root = new Element("main", environment); body.append(root);
  const video = id => ({ id, streamUrl: `/media/short-video/${id}?v=123` });
  const players = () => elements.filter(node => node.tagName === "VIDEO");
  const ready = async player => { player.ready(); player.paint(); await settle(); };
  const tick = async duration => {
    const end = clock + duration;
    for (;;) {
      const item = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      timers.delete(item[0]); clock = item[1].at; item[1].callback(); await settle();
    }
    clock = end; await settle();
  };
  return { environment, cache, root, document, window, connection, requests, elements, metrics, writes, timers, video, players, ready, tick };
}

async function rejectsConstrainedAdjacent(policy = allowShortVideoSpeculativePrewarm) {
  for (const connection of [{ saveData: true }, { effectiveType: "slow-2g" }, { effectiveType: "2g" }]) {
    const f = adjacentFixture(); f.context.navigator = { connection }; f.context.allowShortVideoSpeculativePrewarm = policy;
    f.schedule(); await f.tick(6000);
    assert.equal(f.next.playCalls, 0, "constrained connections cannot initiate adjacent speculative playback");
    f.api.warmVisibleAdjacentVideoPlayers(); assert.equal(f.next.playCalls, 0);
  }
}
await rejectsConstrainedAdjacent();

for (const constraint of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }, { hidden: true }]) {
  const f = adjacentFixture(); f.context.navigator = { connection: constraint }; f.document.hidden = Boolean(constraint.hidden);
  f.previous.readyState = 3; f.previous.dataset.shortVideoPlayed = "1";
  const current = { src: f.active.src, loads: f.active.loadCalls, plays: f.active.playCalls, pauses: f.active.pauseCalls, time: f.active.currentTime };
  assert.equal(f.api.releaseOffscreenVideoDecoder(f.previous, "adjacent-prev"), true);
  assert.equal(f.previous.src, ""); assert.equal(f.previous.preload, "none"); assert.equal(f.previous.dataset.shortVideoDecoderReleased, "1");
  assert.equal(f.previous.loadCalls, 1, "a played neighbor still releases its bound source under a constrained/hidden budget");
  assert.equal(f.api.releaseOffscreenVideoDecoder(f.active, "adjacent-current"), false);
  assert.deepEqual({ src: f.active.src, loads: f.active.loadCalls, plays: f.active.playCalls, pauses: f.active.pauseCalls, time: f.active.currentTime }, current);
}
{
  const f = adjacentFixture(); f.previous.readyState = 3; f.previous.dataset.shortVideoPlayed = "1";
  // Current readiness is deliberately cold: ordinary network retention should
  // keep the played reverse neighbor without initiating another load/play.
  f.active.readyState = 0; delete f.active.dataset.shortVideoFrameReady;
  assert.equal(f.api.releaseOffscreenVideoDecoder(f.previous, "adjacent-prev"), false);
  assert.equal(f.previous.src, "/fixture/previous"); assert.equal(f.previous.preload, "metadata");
  assert.equal(f.previous.loadCalls, 0); assert.equal(f.previous.playCalls, 0); assert.equal(f.previous.paused, true);
  assert.equal(f.previous.dataset.shortVideoDecoderReleased, undefined);
  f.api.releaseOffscreenVideoDecoder(f.previous, "adjacent-prev");
  assert.equal(f.previous.loadCalls, 0); assert.equal(f.previous.playCalls, 0);
  assert.equal(f.metrics.filter(([name]) => name === "video-decoder-retained").length, 1);
}

for (const buffering of [false, true]) {
  const f = adjacentFixture(); f.active.readyState = buffering ? 1 : 0;
  if (!buffering) delete f.active.dataset.shortVideoFrameReady;
  f.schedule(); await f.tick(60000);
  assert.equal(f.next.playCalls, 0, "neither a cold nor buffering current video yields its budget after a timeout");
  assert.equal(f.timers.size, 0, "current readiness is event-driven rather than indefinitely polled");
  f.api.warmVisibleAdjacentVideoPlayers(); assert.equal(f.next.playCalls, 0, "visibility return shares the same readiness gate");
  f.active.readyState = 3; f.active.dataset.shortVideoFrameReady = "1";
  f.active.dataset.shortVideoFrameReadyAt = String(f.context.Date.now()); f.active.emit("shortvideoframeready");
  await f.tick(649); assert.equal(f.next.playCalls, 0);
  await f.tick(1); assert.equal(f.next.playCalls, 1, "a current painted frame and its cooldown release the preferred warmup");
  f.hide();
}
{
  const f = adjacentFixture(); f.next.readyState = 3; f.next.dataset.shortVideoFrameReady = "1";
  f.api.warmVisibleAdjacentVideoPlayers(); f.api.warmVisibleAdjacentVideoPlayers();
  assert.equal(f.next.playCalls, 0, "an already painted same-source ghost does not repeatedly play just to warm again");
}
{
  const f = adjacentFixture(); f.context.navigator = { connection: { saveData: true, effectiveType: "2g" } };
  Object.assign(f.context, { adjacentPlayer: () => f.next, currentShortVideoVolume: () => .5, normalizePlaybackRate: Number, SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS: 300 });
  f.state.shortVideo.playbackRate = 1;
  vm.runInContext(`${pageFunction("primeAdjacentSound")}\nglobalThis.prime = primeAdjacentSound;`, f.context);
  const prime = f.context.prime(1, { id: "next" }); f.next.ready(); f.next.paint();
  assert.equal(await prime, true); assert.equal(f.next.playCalls, 1, "an explicit navigation can prime its target on a constrained connection");
}

async function boundSourceDoesNotReload(factory = createShortVideoPlayerSourceLifecycle) {
  const f = fixture(), player = new Element("video"); player.connected = true; player.className = "is-ghost"; player.pendingSelection = true;
  const lifecycle = factory({ markPerformance() {}, playbackUrl: video => video.streamUrl, waitForFirstFrame: async () => true });
  lifecycle.ensureShortVideoPlayerSource(player, f.video("A")); const generation = player.dataset.shortVideoSourceGeneration;
  await lifecycle.warmAdjacentVideoPlayer(player, f.video("A"));
  assert.equal(player.loads, 1, "an already bound source waiting for selection must not reload");
  assert.equal(player.dataset.shortVideoSourceGeneration, generation);
  player.error = { code: 3 }; await lifecycle.warmAdjacentVideoPlayer(player, f.video("A")); assert.equal(player.loads, 2);
  player.error = null; player.dataset.shortVideoDecoderReleased = "1";
  await lifecycle.warmAdjacentVideoPlayer(player, f.video("A")); assert.equal(player.loads, 3);
}
await boundSourceDoesNotReload();

for (const connection of [{ saveData: true }, { effectiveType: "slow-2g" }, { effectiveType: "2g" }]) {
  const f = fixture(); Object.assign(f.connection, connection);
  assert.equal(await f.cache.prewarmPlayback(f.video("A")), false);
  assert.equal(await f.cache.prefetchRelatedVideo(f.video("A")), null);
  assert.equal(await f.cache.prefetchFirstMedia({ id: "gallery", gallery: true, images: [{ url: "/fixture/image" }] }), false);
  assert.equal(f.elements.length, 0); assert.equal(f.requests.length, 0);
  const explicit = f.cache.prewarmPlayback(f.video("A"), { explicit: true });
  assert.equal(f.players().length, 1); await f.ready(f.players()[0]); assert.equal(await explicit, true);
  f.cache.releasePlaybackPreloads({ force: true });
}

{
  const f = fixture(); let a = true, b = true;
  const first = f.cache.prewarmPlayback(f.video("A"), { owner: "A", isCurrent: () => a });
  const second = f.cache.prewarmPlayback(f.video("A"), { owner: "B", isCurrent: () => b });
  assert.equal(first, second); assert.equal(f.players().length, 1);
  a = false; f.cache.releasePlaybackPreloads(); assert.equal(f.cache.stats().playbackPreloads, 1);
  const player = f.players()[0]; await f.ready(player); assert.equal(await first, true);
  assert.equal(player.preload, "metadata"); assert.equal(player.paused, true);
  b = false; f.cache.releasePlaybackPreloads(); assert.equal(f.cache.stats().playbackPreloads, 0);
  assert.equal(player.src, ""); assert.equal(player.isConnected, false);
}
{
  const f = fixture(); let current = true;
  const speculative = f.cache.prewarmPlayback(f.video("A"), { owner: "hover", isCurrent: () => current });
  const explicit = f.cache.prewarmPlayback(f.video("A"), { explicit: true, owner: "open", isCurrent: () => true });
  assert.equal(speculative, explicit); current = false; f.connection.saveData = true; f.cache.releasePlaybackPreloads();
  assert.equal(f.cache.stats().playbackPreloads, 1, "an explicit owner keeps shared work alive after the speculative owner expires");
  const player = f.cache.takePrewarmedPlayer(f.video("A")); f.root.append(player);
  player.muted = false; player.paused = false; const before = { pauses: player.pauses, loads: player.loads, src: player.src };
  f.document.hidden = true; f.cache.releasePlaybackPreloads({ force: true }); await f.ready(player); await explicit;
  assert.deepEqual({ pauses: player.pauses, loads: player.loads, src: player.src }, before, "release and old warm completion cannot pause or reload a taken current player");
}
{
  const f = fixture(), pending = f.cache.prewarmPlayback(f.video("A")); const player = f.players()[0];
  player.ready(); const oldFrame = [...player.frames.values()][0];
  f.document.hidden = true; f.cache.releasePlaybackPreloads({ force: true });
  const before = { pauses: player.pauses, loads: player.loads, src: player.src };
  oldFrame(0); assert.equal(await pending, false);
  assert.deepEqual({ pauses: player.pauses, loads: player.loads, src: player.src }, before);
  assert.equal(player.frames.size, 0); assert.equal(f.timers.size, 0);
}

async function lateRelatedOwnerDoesNotWarm(factory = createShortVideoMediaCache) {
  const f = fixture({ factory }); let current = true;
  const pending = f.cache.prefetchRelatedVideo(f.video("A"), { owner: "panel", isCurrent: () => current });
  current = false; f.requests[0].resolve({ video: f.video("A") }); await pending;
  assert.equal(f.players().length, 0, "a late detail cannot create media after its caller closes");
  assert.equal(f.writes.length, 0); assert.equal(f.cache.stats().playbackPreloads, 0);
}
await lateRelatedOwnerDoesNotWarm();
{
  const f = fixture(); let a = true;
  const first = f.cache.prefetchRelatedVideo(f.video("A"), { owner: "closed", isCurrent: () => a });
  const second = f.cache.prefetchRelatedVideo(f.video("A"), { owner: "live", isCurrent: () => true });
  assert.equal(f.requests.length, 1); a = false; f.requests[0].resolve({ video: f.video("A") }); await settle();
  assert.equal(f.players().length, 1, "the other live caller may still warm the shared result");
  await f.ready(f.players()[0]); await Promise.all([first, second]); f.cache.releasePlaybackPreloads({ force: true });
}
{
  const f = fixture(), pending = f.cache.prefetchRelatedVideo(f.video("A"));
  f.connection.saveData = true; f.requests[0].resolve({ video: f.video("A") }); await pending;
  assert.equal(f.players().length, 0, "a network budget change during detail loading prevents media creation");
}
{
  const f = fixture(); let repeated;
  f.environment.onPlay = () => { f.environment.onPlay = null; repeated = f.cache.prewarmPlayback(f.video("A")); };
  const first = f.cache.prewarmPlayback(f.video("A")); assert.equal(first, repeated, "native play reentrancy sees the established shared promise");
  await f.ready(f.players()[0]); await first;
  const player = f.cache.takePrewarmedPlayer(f.video("A")); f.root.append(player);
  const lifecycle = createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: video => video.streamUrl, waitForFirstFrame: async () => true });
  assert.equal(lifecycle.ensureShortVideoPlayerSource(player, f.video("A"), { source: f.video("A").streamUrl, forceReload: player.dataset.streamUrl !== f.video("A").streamUrl }), false);
  assert.equal(player.loads, 1); assert.equal(player.plays, 1); assert.equal(player.src, "/media/short-video/A?v=123");
}

{
  const f = fixture(), list = new Element("section"); f.root.append(list);
  const env = vm.createContext({ els: { workGrid: f.root }, state: { activeView: "shortVideos", shortVideo: { current: null } },
    shortVideoNavigationScope: () => "feed",
    prewarmShortVideoPlayback: (...args) => f.cache.prewarmPlayback(...args), releaseShortVideoMediaPreloads: options => f.cache.releasePlaybackPreloads(options) });
  vm.runInContext(`${pageFunction("prewarmShortVideoListCard")}\n${pageFunction("releaseUnusedShortVideoPreloads")}\nglobalThis.api={prewarmShortVideoListCard,releaseUnusedShortVideoPreloads};`, env);
  const pending = env.api.prewarmShortVideoListCard(f.video("A")); list.remove(); env.api.releaseUnusedShortVideoPreloads();
  assert.equal(f.cache.stats().playbackPreloads, 0); assert.equal(await pending, false, "the actual list adapter releases untaken warmup when its DOM is replaced");
}
{
  const f = fixture(), panel = new Element("section"), content = new Element("div"), list = new Element("div");
  panel.className = "short-video-author-panel"; panel.dataset.activeTab = "related"; content.className = "short-video-author-content";
  content.append(list); panel.append(content); f.root.append(panel);
  const env = vm.createContext({ els: { workGrid: f.root }, state: { activeView: "shortVideos" }, prefetchRelatedShortVideoMedia: (...args) => f.cache.prefetchRelatedVideo(...args) });
  vm.runInContext(`${pageFunction("prefetchRelatedVideo")}\nglobalThis.prefetch=prefetchRelatedVideo;`, env);
  const pending = env.prefetch(f.video("A")); panel.dataset.closing = "1";
  f.requests[0].resolve({ video: f.video("A") }); await pending;
  assert.equal(f.players().length, 0, "the actual related-panel adapter guards the caller across the detail await");
}

function listOwnerFixture(wrapper = pageFunction("prewarmShortVideoListCard")) {
  const f = fixture(), home = new Element("section"); home.className = "short-video-home"; f.root.append(home);
  const state = { activeView: "shortVideos", shortVideo: { mode: "feed", source: "liked", author: "author-A", query: "", current: null, data: { videos: [f.video("old")] } } };
  let listLoads = 0;
  const context = vm.createContext({ els: { workGrid: f.root }, state,
    shortVideoFeedParams: () => JSON.stringify([state.shortVideo.author, state.shortVideo.source, state.shortVideo.query]),
    prewarmShortVideoPlayback: (...args) => f.cache.prewarmPlayback(...args), releaseShortVideoMediaPreloads: options => f.cache.releasePlaybackPreloads(options),
    shortVideoSearch: { remember() {} }, clearShortVideoDeleteSelection() {}, showError(error) { throw error; },
    loadVideos() { listLoads++; context.preserveShortVideoHomeDuringLoad(false); return new Promise(() => {}); }
  });
  vm.runInContext([wrapper, ...["shortVideoNavigationScope", "releaseUnusedShortVideoPreloads", "syncShortVideoHomeToolbar", "preserveShortVideoHomeDuringLoad", "commitShortVideoSearch"].map(pageFunction)].join("\n"), context);
  return { ...f, home, state, context, get listLoads() { return listLoads; } };
}

async function listOwnerTracksScope(wrapper) {
  for (const [field, value] of [["query", "new-query"], ["author", "author-B"], ["source", "all"], ["mode", "collection"]]) {
    const f = listOwnerFixture(wrapper), pending = f.context.prewarmShortVideoListCard(f.video("old"));
    f.state.shortVideo[field] = value; f.context.releaseUnusedShortVideoPreloads();
    assert.equal(f.cache.stats().playbackPreloads, 0, "a changed list scope must revoke old media even while its DOM stays connected");
    assert.equal(await pending, false); assert.equal(f.players()[0].src, "");
  }
}
await listOwnerTracksScope();

async function listOwnerTracksBusy(wrapper) {
  const f = listOwnerFixture(wrapper), pending = f.context.prewarmShortVideoListCard(f.video("old"));
  assert.equal(f.context.preserveShortVideoHomeDuringLoad(false), true);
  assert.equal(f.home.getAttribute("aria-busy"), "true");
  assert.equal(f.cache.stats().playbackPreloads, 0, "a busy retained home must release its speculative media without waiting for replacement");
  assert.equal(await pending, false);
  const created = f.elements.length;
  assert.equal(await f.context.prewarmShortVideoListCard(f.video("another")), false);
  assert.equal(f.elements.length, created, "hovering old cards while a new list loads cannot restart prewarming");
}
await listOwnerTracksBusy();
{
  const f = listOwnerFixture(), pending = f.context.prewarmShortVideoListCard(f.video("old"));
  f.context.commitShortVideoSearch("global-query", { global: true });
  assert.equal(f.listLoads, 1); assert.equal(f.home.isConnected, true); assert.equal(f.home.getAttribute("aria-busy"), "true");
  assert.equal(f.state.shortVideo.author, "all"); assert.equal(f.state.shortVideo.source, "all");
  assert.equal(await pending, false); assert.equal(f.cache.stats().playbackPreloads, 0, "the actual search/preserve-home path revokes the old author/feed warmup");
  // The user's explicit opening remains independent from a busy list owner.
  const explicit = f.cache.prewarmPlayback(f.video("chosen"), { explicit: true, owner: "open", isCurrent: () => true });
  f.context.releaseUnusedShortVideoPreloads(); assert.equal(f.cache.stats().playbackPreloads, 1);
  const player = f.cache.takePrewarmedPlayer(f.video("chosen")); f.root.append(player); const pauses = player.pauses;
  f.context.preserveShortVideoHomeDuringLoad(false); f.cache.releasePlaybackPreloads({ force: true }); await f.ready(player); await explicit;
  assert.equal(player.pauses, pauses); assert.equal(player.src, f.video("chosen").streamUrl);
}

async function livePhotoNeverUsesImageForVideo(factory = createShortVideoMediaCache) {
  const f = fixture({ factory });
  assert.equal(await f.cache.prefetchFirstMedia({ id: "live", gallery: true, images: [{ type: "video", url: "/media/short-video-gallery/live/0?v=1" }] }), false,
    "a LivePhoto video URL cannot start image prefetch");
  assert.equal(f.elements.filter(node => node.tagName === "IMG").length, 0, "a LivePhoto MP4 cannot be fetched by an image element");
  assert.equal(f.players().length, 0);
}
await livePhotoNeverUsesImageForVideo();
{
  const f = fixture();
  assert.equal(await f.cache.prefetchFirstMedia({ id: "live", gallery: true, images: [{ type: "video", url: "/live.mp4", posterUrl: "/poster.jpg" }] }), true);
  assert.deepEqual(f.elements.filter(node => node.tagName === "IMG").map(node => node.src), ["/poster.jpg"]);
  f.cache.releasePlaybackPreloads({ force: true }); assert.equal(f.cache.stats().mediaPrefetches, 0);
}

async function imageOwnersShareAndRelease(factory = createShortVideoMediaCache) {
  const f = fixture({ factory }); f.environment.pendingImages = true;
  let a = true, b = true;
  const video = { id: "gallery", gallery: true, images: [{ type: "image", url: "/shared.jpg" }] };
  const first = f.cache.prefetchFirstMedia(video, { owner: "a", isCurrent: () => a });
  const second = f.cache.prefetchFirstMedia(video, { owner: "b", isCurrent: () => b });
  const images = f.elements.filter(node => node.tagName === "IMG"); assert.equal(images.length, 1, "same-url image requests share one native load");
  a = false; f.cache.releasePlaybackPreloads(); assert.equal(f.cache.stats().mediaPrefetches, 1); assert.equal(images[0].src, "/shared.jpg");
  images[0].naturalWidth = 1; images[0].dispatchEvent(new Event("load"));
  assert.equal(await first, true); assert.equal(await second, true, "one expired caller cannot cancel the remaining image owner");
  b = false; f.cache.releasePlaybackPreloads();
  assert.equal(f.cache.stats().mediaPrefetches, 0, "the last expired image owner releases its cache entry and source");
  assert.equal(images[0].src, "");
}
await imageOwnersShareAndRelease();
for (const force of [false, true]) {
  const f = fixture(); f.environment.pendingImages = true; let current = true;
  const pending = f.cache.prefetchFirstMedia({ id: "gallery", gallery: true, images: [{ url: "/pending.jpg" }] }, { owner: "panel", isCurrent: () => current });
  const image = f.elements.find(node => node.tagName === "IMG"); current = false;
  f.cache.releasePlaybackPreloads({ force }); assert.equal(await pending, false);
  assert.equal(image.src, ""); assert.equal(f.cache.stats().mediaPrefetches, 0);
  image.dispatchEvent(new Event("load")); image.dispatchEvent(new Event("error"));
  assert.equal(f.cache.stats().mediaPrefetches, 0, "late events cannot republish a released image");
}
{
  const f = fixture(); f.environment.pendingImages = true;
  const video = { id: "gallery", gallery: true, images: [{ url: "/retry.jpg" }] };
  const failed = f.cache.prefetchFirstMedia(video), image = f.elements.find(node => node.tagName === "IMG");
  image.dispatchEvent(new Event("error")); assert.equal(await failed, false); assert.equal(image.src, "");
  const retry = f.cache.prefetchFirstMedia(video), fresh = f.elements.filter(node => node.tagName === "IMG")[1];
  image.dispatchEvent(new Event("error")); assert.equal(f.cache.stats().mediaPrefetches, 1); assert.equal(fresh.src, "/retry.jpg");
  fresh.dispatchEvent(new Event("load")); assert.equal(await retry, true); f.cache.releasePlaybackPreloads({ force: true });
}
{
  const f = fixture(); f.environment.pendingImages = true; const requests = [];
  for (let index = 0; index < 19; index++) requests.push(f.cache.prefetchFirstMedia({ id: `g${index}`, gallery: true, images: [{ url: `/image-${index}.jpg` }] }));
  assert.equal(f.cache.stats().mediaPrefetches, 18); assert.equal(f.elements[0].src, ""); assert.equal(await requests[0], false,
    "image cache eviction cancels old native work instead of merely dropping the map entry");
  f.cache.releasePlaybackPreloads({ force: true }); assert((await Promise.all(requests)).every(value => value === false));
  assert(f.elements.every(node => !node.src));
}

{
  const styles = deferred(), captured = [];
  let scope = "feed";
  const video = { id: "A", streamUrl: "/media/short-video/A?v=123" };
  const context = vm.createContext({ state: { activeView: "shortVideos", shortVideo: { mode: "feed", data: { videos: [video] } } },
    document: { documentElement: { dataset: {} } }, shortVideoOpenRequestId: 0, shortVideoOpeningId: "", shortVideoOpenError: "",
    AbortController, runShortVideoRead, shortVideoOpenReadController: null,
    ensureState() {}, flushActiveShortVideoWatch() {}, cancelShortVideoNavigation() {}, cancelAuthorCollectorPolling() {},
    ensureShortVideoViewerStyles: () => styles.promise, markShortVideoPerformance() {}, cachedShortVideo: () => null, rememberShortVideo() {},
    shortVideoNavigationScope: () => scope,
    shortVideoListScope: () => scope, isDeletedShortVideo: () => false,
    prewarmShortVideoPlayback: (record, options) => { captured.push({ record, options }); return Promise.resolve(false); }
  });
  vm.runInContext(`${pageFunction("openVideo")}\nglobalThis.open=openVideo;`, context);
  const opening = context.open("A"); assert.equal(captured.length, 1);
  const { record, options } = captured[0]; assert.equal(record, video); assert.equal(options.explicit, true);
  assert.equal(options.isCurrent(), true); scope = "likes";
  assert.equal(options.isCurrent(), false, "explicit prewarm cannot outlive its route scope even before the request ID changes");
  scope = "feed"; context.shortVideoOpenRequestId++;
  assert.equal(options.isCurrent(), false, "a newer navigation revokes the explicit opening owner");
  styles.resolve(); assert.equal(await opening, false);
}
{
  const f = adjacentFixture(), connection = { saveData: true, effectiveType: "2g" }, releases = [];
  f.context.navigator = { connection }; f.context.releaseUnusedShortVideoPreloads = options => releases.push(options);
  vm.runInContext(`${pageFunction("handleShortVideoPrewarmConnectionChange")}\nglobalThis.changed=handleShortVideoPrewarmConnectionChange;`, f.context);
  const current = { src: f.active.src, plays: f.active.playCalls, pauses: f.active.pauseCalls, time: f.active.currentTime };
  f.context.changed(); assert.equal(f.next.src, ""); assert.equal(f.previous.src, ""); assert.equal(f.next.playCalls, 0);
  connection.saveData = false; connection.effectiveType = "4g"; f.context.changed();
  assert.equal(f.next.playCalls, 1); assert.equal(releases.length, 2);
  assert.deepEqual({ src: f.active.src, plays: f.active.playCalls, pauses: f.active.pauseCalls, time: f.active.currentTime }, current,
    "a connection change releases speculative work and preserves current playback");
  f.hide();
}
{
  let connectionListeners = 0;
  const context = vm.createContext({ eventsInstalled: false,
    window: { addEventListener() {} }, document: { addEventListener() {} },
    navigator: { connection: { addEventListener: name => { assert.equal(name, "change"); connectionListeners++; } } },
    handleShortVideoVisibilityChange() {}, handleShortVideoFullscreenChange() {}, handleShortVideoPictureInPictureChange() {},
    cancelShortVideoNativePlaybackModes() {}, flushActiveShortVideoWatch() {}, handleShortVideoPageHide() {}, handleShortVideoPageShow() {},
    handleShortVideoPrewarmConnectionChange() {}
  });
  vm.runInContext(`${pageFunction("installBrowseEvents")}\ninstallBrowseEvents(); installBrowseEvents();`, context);
  assert.equal(connectionListeners, 1, "network budget changes have one page listener instead of a listener for every prewarm");
}

// Regression controls deliberately remove individual guards in memory; the
// same behavioral assertions must then fail.
const originalRenderer = pageFunction("renderReelPanel");
const sourceBoundGhost = originalRenderer.replace("if (ghost) player.dataset.streamUrl = playbackUrl;\n      else ensureShortVideoPlayerSource", "ensureShortVideoPlayerSource");
assert.notEqual(sourceBoundGhost, originalRenderer);
await assert.rejects(renderDoesNotIssueGhostMedia(sourceBoundGhost), /initial ghost construction cannot bind a source/);
await assert.rejects(rejectsConstrainedAdjacent(() => true), /constrained connections cannot initiate/);
const lifecycleFile = new URL("../public/modules/short-videos/player-source-lifecycle.js", import.meta.url);
let oldSelection = fs.readFileSync(lifecycleFile, "utf8").replace('!(player.currentSrc || player.getAttribute("src"))', "!player.currentSrc");
assert.notEqual(oldSelection, fs.readFileSync(lifecycleFile, "utf8"));
const oldLifecycle = (await import(`data:text/javascript;base64,${Buffer.from(oldSelection).toString("base64")}`)).createShortVideoPlayerSourceLifecycle;
await assert.rejects(boundSourceDoesNotReload(oldLifecycle), /already bound source waiting for selection/);
const cacheFile = new URL("../public/modules/short-videos/media-cache.js", import.meta.url);
let unowned = fs.readFileSync(cacheFile, "utf8").replace("const requestIsCurrent = options => options.isCurrent?.() !== false;", "const requestIsCurrent = options => true;");
assert.notEqual(unowned, fs.readFileSync(cacheFile, "utf8"));
unowned = unowned.replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, cacheFile).href}"`);
const unownedCache = (await import(`data:text/javascript;base64,${Buffer.from(unowned).toString("base64")}`)).createShortVideoMediaCache;
// Complete any incorrectly created warmup so the broken implementation can
// reach the resource assertion instead of leaving its controlled frame pending.
const negativeFixture = fixture({ factory: unownedCache }); let negativeCurrent = true;
const negativePending = negativeFixture.cache.prefetchRelatedVideo(negativeFixture.video("A"), { isCurrent: () => negativeCurrent });
negativeCurrent = false; negativeFixture.requests[0].resolve({ video: negativeFixture.video("A") }); await settle();
assert.equal(negativeFixture.players().length, 1, "negative control reproduces the forbidden late media creation");
await negativeFixture.ready(negativeFixture.players()[0]); await negativePending;
negativeFixture.cache.releasePlaybackPreloads({ force: true });

const listWrapper = pageFunction("prewarmShortVideoListCard");
const noListScope = listWrapper.replace("&& scope === shortVideoNavigationScope()", "");
assert.notEqual(noListScope, listWrapper);
await assert.rejects(listOwnerTracksScope(noListScope), /changed list scope must revoke/);
const noListBusy = listWrapper.replace(' && root.getAttribute("aria-busy") !== "true"', "");
assert.notEqual(noListBusy, listWrapper);
await assert.rejects(listOwnerTracksBusy(noListBusy), /busy retained home must release/);

const currentCacheSource = fs.readFileSync(cacheFile, "utf8");
async function cacheFactoryFrom(changed) {
  assert.notEqual(changed, currentCacheSource);
  changed = changed.replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, cacheFile).href}"`);
  return (await import(`data:text/javascript;base64,${Buffer.from(changed).toString("base64")}`)).createShortVideoMediaCache;
}
const videoAsImage = currentCacheSource.replace('galleryEntry?.type === "video" ? galleryEntry.posterUrl : galleryEntry?.url', "galleryEntry?.url");
await assert.rejects(livePhotoNeverUsesImageForVideo(await cacheFactoryFrom(videoAsImage)), /LivePhoto video URL cannot start image/);
const releaseFunctionStart = currentCacheSource.indexOf("  function releasePlaybackPreloads(");
assert(releaseFunctionStart >= 0);
const imageReleaseStart = currentCacheSource.indexOf("    for (const [url, entry] of mediaPrefetches)", releaseFunctionStart);
const imageReleaseEnd = currentCacheSource.indexOf("    if (!playbackPreloads.size)", imageReleaseStart);
assert(imageReleaseStart >= 0 && imageReleaseEnd > imageReleaseStart);
const noImageRelease = currentCacheSource.slice(0, imageReleaseStart) + currentCacheSource.slice(imageReleaseEnd);
await assert.rejects(imageOwnersShareAndRelease(await cacheFactoryFrom(noImageRelease)), /last expired image owner releases/);

for (const [key, descriptor] of Object.entries(saved)) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
}
console.log("short-video-prewarm-budget: passed actual network/current readiness gates, list scope/busy cancellation, shared image/video owners, LivePhoto poster policy, explicit handoff, canonical URL reuse and negative controls");

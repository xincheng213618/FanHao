import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoAutoNextController } from "../public/modules/short-videos/auto-next-controller.js";

// Run the page's real ended/mode/control handlers with the real controller.
// Navigation promises, DOM and media are controlled; no service, files or
// database are used, and there is no polling clock to drive indefinitely.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8");
const pageFunction = (name) => {
  const start = source.indexOf(`  function ${name}(`), end = source.indexOf("\n  }", start);
  assert(start >= 0 && end > start, `missing current page function: ${name}`);
  return source.slice(start, end + 4);
};
const names = ["handleAutoNextEnded", "handleGalleryAutoNext", "captureShortVideoAutoNextOwner", "ownsShortVideoAutoNextOwner",
  "renderShortVideoAutoNextState", "ensureShortVideoAutoNextController", "cancelShortVideoAutoNext", "flushShortVideoAutoNext",
  "syncActivePlaybackMode", "createAutoNextControl", "isCurrentShortVideoNavigation"];
class Element extends EventTarget {
  constructor() {
    super(); this.dataset = {}; this.attributes = new Map(); this.children = []; this.isConnected = true; this.className = "";
    this.classList = { contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, on) => { const values = this.className.split(/\s+/).filter(Boolean); this.className = values.filter((item) => item !== name).concat(on ? [name] : []).join(" "); } };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
  querySelector(selector) { return this.children.find((node) => node.className === selector.slice(1)) || null; }
}
const flush = async () => { for (let count = 0; count < 12; count += 1) await Promise.resolve(); };
function fixture({ gallery = false, known = false, next = "", enabled = true, overlay = false } = {}) {
  const stage = new Element(), controls = [], toasts = [], advances = [], requests = [], preferences = [];
  let modal = overlay, activePlayer, activeGallery = null, handlers;
  const player = new Element();
  player.dataset = { videoId: "A", shortVideoSourceGeneration: "1", shortVideoPlaybackIntentGeneration: "0", shortVideoPromotedAt: "1" };
  player.setAttribute("src", "/fixture/A"); player.ended = true; player.paused = true; player.loop = true; player.currentTime = 10;
  player.playCalls = 0; player.pauseCalls = 0;
  player.play = async () => { player.playCalls += 1; player.paused = false; player.ended = false; };
  player.pause = () => { player.pauseCalls += 1; player.paused = true; };
  player.closest = () => stage;
  activePlayer = player;
  const galleryPlayer = new Element();
  galleryPlayer.dataset = { galleryIndex: "2", shortVideoPlaybackIntentGeneration: "0" }; galleryPlayer.paused = false;
  galleryPlayer.shortVideoGalleryIsPaused = () => galleryPlayer.paused;
  galleryPlayer.closest = () => stage;
  galleryPlayer.pauseCalls = 0;
  galleryPlayer.shortVideoGalleryPause = () => {
    galleryPlayer.pauseCalls += 1; galleryPlayer.paused = true;
    galleryPlayer.dataset.shortVideoPlaybackIntentGeneration = String(Number(galleryPlayer.dataset.shortVideoPlaybackIntentGeneration) + 1);
    handlers?.cancel();
  };
  if (gallery) { activeGallery = galleryPlayer; activePlayer = null; }
  const state = { activeView: "shortVideos", shortVideo: { current: { id: "A", gallery }, autoNext: enabled, nextId: next, playbackRate: 1, query: "" } };
  const navigation = { id: "A", scope: "scope:", openRequestId: 0, nextKnown: known, status: known ? "ready" : "pending" };
  const context = vm.createContext({
    createShortVideoAutoNextController, state, shortVideoAutoNextController: null, shortVideoAutoNextStatus: null,
    shortVideoNavigationState: navigation, shortVideoOpenRequestId: 0,
    shortVideoNavigationScope: () => `scope:${state.shortVideo.query}`,
    activePlayer: () => activePlayer, activeGalleryPlayer: () => activeGallery,
    hasShortVideoBrowseOverlay: () => modal, isGalleryPost: (video) => Boolean(video?.gallery),
    isCurrentShortVideo: (video) => video?.id === state.shortVideo.current?.id,
    normalizePlaybackRate: Number, createIcon: () => new Element(), writeAutoNextPreference: (value) => preferences.push(value),
    showBrowserToast: (text) => toasts.push(text),
    els: { workGrid: { querySelectorAll: () => controls } }, document: { createElement: () => new Element() },
    hydratePromotedShortVideo: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    openAdjacent: async (direction) => { advances.push(direction); handlers.cancel(); }
  });
  handlers = vm.runInContext(`${names.map(pageFunction).join("\n")}\n({ ended: handleAutoNextEnded, galleryEnded: handleGalleryAutoNext,
    sync: syncActivePlaybackMode, flush: flushShortVideoAutoNext, cancel: cancelShortVideoAutoNext, createControl: createAutoNextControl });`, context);
  const control = handlers.createControl(); controls.push(control);
  return { handlers, context, player, galleryPlayer, state, navigation, control, toasts, advances, requests, preferences, stage,
    setOverlay: (value) => { modal = value; }, setPlayer: (value) => { activePlayer = value; },
    status: () => stage.children.find((node) => node.className === "short-video-auto-next-status"),
    toggle: () => control.dispatchEvent(new Event("click")),
    ready(nextId = "B") { state.shortVideo.nextId = nextId; navigation.nextKnown = true; navigation.status = "ready"; }
  };
}

{
  const f = fixture(); f.handlers.sync();
  assert.equal(f.player.loop, false, "unknown neighbors must not turn auto-next into a full-video replay");
  f.handlers.ended(f.player);
  assert.equal(f.requests.length, 1); assert.equal(f.player.currentTime, 10); assert.equal(f.player.playCalls, 0);
  assert.equal(f.control.getAttribute("aria-busy"), "true"); assert.match(f.status().textContent, /准备下一条/);
  f.handlers.ended(f.player); f.handlers.ended(f.player); assert.equal(f.requests.length, 1, "duplicate ended events share one navigation request");
  f.ready(); f.handlers.flush(); await flush();
  assert.deepEqual(f.advances, [1]); assert.equal(f.control.getAttribute("aria-busy"), "false"); assert.equal(f.status(), undefined);
  f.handlers.ended(f.player); assert.deepEqual(f.advances, [1], "the navigation callback's synchronous cancel cannot permit duplicate completion");
  f.requests[0].resolve(true); await flush(); assert.deepEqual(f.advances, [1]);
}
{
  const f = fixture(); f.handlers.ended(f.player); f.handlers.cancel();
  f.handlers.sync(); f.handlers.sync();
  assert.equal(f.requests.length, 1, "mode/control synchronization must not recreate a cancelled ended request");
  assert.equal(f.control.getAttribute("aria-busy"), "false");
  f.ready(); f.requests[0].resolve(true); await flush(); f.handlers.sync();
  assert.equal(f.advances.length, 0, "a cancelled completion stays cancelled even though the media remains ended");
}
{
  const f = fixture({ known: true, next: "B" }); f.handlers.ended(f.player); f.handlers.ended(f.player);
  assert.deepEqual(f.advances, [1]); assert.equal(f.requests.length, 0, "known-next completion does not fetch navigation again");
}
{
  const f = fixture(); f.player.dataset.shortVideoExplicitPlaybackIntent = "pause";
  f.handlers.ended(f.player);
  assert.equal(f.requests.length, 0, "an ended event queued before an explicit pause cannot create a newer completion request");
  f.player.dataset.shortVideoExplicitPlaybackIntent = "play"; f.handlers.ended(f.player);
  assert.equal(f.requests.length, 1, "natural ended remains eligible after explicit play intent");
}
for (const gallery of [false, true]) {
  const f = fixture({ gallery, known: true });
  if (gallery) { assert.equal(f.handlers.galleryEnded(f.state.shortVideo.current), true); f.handlers.galleryEnded(f.state.shortVideo.current); }
  else { f.handlers.sync(); f.handlers.ended(f.player); }
  assert.equal(f.toasts.filter((text) => text === "已经是最后一条").length, 1, "a true boundary is announced once without a repeated slideshow timer");
  assert.equal(f.advances.length, 0);
  assert.equal(gallery ? f.galleryPlayer.paused : f.player.paused, true);
  assert.equal(f.player.currentTime, 10); assert.equal(f.player.playCalls, 0, "end of feed must not rewind/restart the video");
}
{
  const f = fixture(); f.handlers.ended(f.player);
  f.requests[0].reject(new Error("navigation unavailable")); await flush();
  assert.equal(f.control.getAttribute("aria-busy"), "false"); assert.match(f.status().textContent, /无法读取/);
  f.handlers.ended(f.player); f.handlers.flush(); await flush();
  assert.equal(f.requests.length, 1, "failed completion must not enter an automatic fetch loop"); assert.equal(f.toasts.length, 1);
}
{
  const f = fixture(); f.handlers.ended(f.player);
  f.requests[0].resolve(true); await flush();
  f.handlers.flush(); f.handlers.ended(f.player); await flush();
  assert.equal(f.requests.length, 1, "a settled request that still lacks neighbor knowledge must terminate with feedback rather than poll forever");
  assert.match(f.status().textContent, /无法读取/); assert.equal(f.advances.length, 0);
}
for (const invalidate of [
  (f) => { f.player.dataset.shortVideoPlaybackIntentGeneration = "1"; },
  (f) => { f.player.setAttribute("src", "/fixture/replaced"); },
  (f) => { f.player.dataset.shortVideoSourceGeneration = "2"; },
  (f) => { f.player.dataset.shortVideoPromotedAt = "2"; },
  (f) => { f.player.isConnected = false; },
  (f) => { f.player.ended = false; },
  (f) => { f.setOverlay(true); },
  (f) => { f.state.activeView = "home"; },
  (f) => { f.state.shortVideo.current = { id: "B" }; },
  (f) => { f.state.shortVideo.query = "new"; },
  (f) => { f.context.shortVideoNavigationState = { ...f.navigation }; },
  (f) => { f.context.shortVideoOpenRequestId += 1; },
  (f) => { f.toggle(); },
  (f) => { f.handlers.cancel(); }
]) {
  const f = fixture(); f.handlers.ended(f.player); invalidate(f); f.ready(); f.requests[0].resolve(true); await flush();
  assert.equal(f.advances.length, 0, "a late ended continuation cannot navigate after user/source/route/modal cancellation");
  assert.equal(f.control.getAttribute("aria-busy"), "false"); assert.equal(f.status(), undefined);
}
{
  const f = fixture({ gallery: true }); assert.equal(f.handlers.galleryEnded(f.state.shortVideo.current), true);
  assert.match(f.status().textContent, /准备下一条/);
  const music = new Element(); music.loop = true; music.dataset = {}; f.setPlayer(music);
  f.ready(); f.requests[0].resolve(true); await flush();
  assert.deepEqual(f.advances, [1], "late background-audio attachment must not invalidate a gallery's ended owner");
}
for (const invalidate of [
  (f) => { f.galleryPlayer.dataset.shortVideoPlaybackIntentGeneration = "1"; },
  (f) => { f.galleryPlayer.dataset.galleryIndex = "1"; },
  (f) => { f.galleryPlayer.shortVideoGalleryPause(); f.galleryPlayer.paused = false; f.galleryPlayer.dataset.shortVideoPlaybackIntentGeneration = "2"; }
]) {
  const f = fixture({ gallery: true }); f.handlers.galleryEnded(f.state.shortVideo.current); invalidate(f);
  f.ready(); f.requests[0].resolve(true); await flush();
  assert.equal(f.advances.length, 0, "gallery user pause/resume or manual image changes cancel pending completion");
}
{
  const f = fixture({ overlay: true }); f.handlers.ended(f.player); assert.equal(f.requests.length, 0);
  const g = fixture({ gallery: true, overlay: true }); assert.equal(g.handlers.galleryEnded(g.state.shortVideo.current), true, "blocked auto-next must not fall through to gallery wraparound");
  assert.equal(g.requests.length, 0);
}
{
  const f = fixture({ enabled: false }); f.handlers.sync(); assert.equal(f.player.loop, true); assert.equal(f.requests.length, 0);
  f.toggle(); assert.equal(f.requests.length, 1, "explicitly enabling auto-next on an ended video may start one new completion request");
  const g = fixture({ gallery: true, enabled: false }); assert.equal(g.handlers.galleryEnded(g.state.shortVideo.current), false, "auto-next off retains ordinary gallery cycling");
}

for (const known of [true, false]) {
  const target = {}, owner = { id: "A", kind: "video", target };
  let controller, cancelled = false, advances = 0, loads = 0;
  controller = createShortVideoAutoNextController({
    capture: () => owner, owns: () => true, getNavigation: () => known ? { nextId: "B", known: true } : { known: false },
    loadNavigation: () => { loads += 1; return Promise.resolve(true); }, advance: () => { advances += 1; }, boundary() {},
    onStateChange: (state) => {
      if (!cancelled && state.owner && (known || state.waiting)) { cancelled = true; controller.cancel(); }
    }
  });
  controller.ended("video", target); await flush();
  assert.equal(advances, 0, "a state callback cancellation must be checked before navigation starts");
  assert.equal(loads, 0, "a waiting callback cancellation must be checked before loading starts");
}

console.log("short-video-auto-next: unknown-next waiting, one-shot completion, final boundary, gallery parity and stale-owner cancellation passed");

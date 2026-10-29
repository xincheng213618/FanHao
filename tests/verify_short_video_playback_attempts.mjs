import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoPlaybackRenditionPolicy } from "../public/modules/short-videos/playback-rendition-policy.js";

// Execute the current renderer, sound restore and reel promotion with their
// actual ownership helpers. Play promises, DOM replacement and RAF callbacks
// are controlled independently without a browser, service or media file.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function sourceFunction(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, `missing current function: ${name}`);
  const end = source.indexOf("\n  }", match.index);
  assert(end > match.index, `missing function boundary: ${name}`);
  return source.slice(match.index, end + 4);
}
const implementation = [
  "captureShortVideoPlaybackOwner", "ownsShortVideoPlaybackOwner", "shortVideoNavigationScope", "stopShortVideoSoundPreview",
  "renderBrowser", "restorePlayerSound", "promoteAdjacentPanelDom", "bindShortVideoPlaybackStatus", "toggleActiveMute"
].map(sourceFunction).join("\n");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 24; turn++) await Promise.resolve(); }
function element() {
  const classes = new Set();
  const listeners = new Map();
  return {
    classes, dataset: {}, children: [], isConnected: true,
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value),
      toggle(value, force) { if (force ?? !classes.has(value)) classes.add(value); else classes.delete(value); }
    },
    append(...children) { this.children.push(...children); },
    setAttribute() {}, removeAttribute() {},
    addEventListener(name, callback, options = {}) {
      const entries = listeners.get(name) || [];
      entries.push({ callback, once: Boolean(options.once) });
      listeners.set(name, entries);
    },
    removeEventListener(name, callback) { listeners.set(name, (listeners.get(name) || []).filter(entry => entry.callback !== callback)); },
    emit(name) {
      for (const entry of [...(listeners.get(name) || [])]) {
        if (entry.once) this.removeEventListener(name, entry.callback);
        entry.callback({ preventDefault() {}, stopPropagation() {} });
      }
    },
    querySelector: () => null, querySelectorAll: () => []
  };
}

function fixture() {
  const pending = deferred(), frames = [], calls = [], timers = new Map();
  let timerId = 0;
  const stage = element(), incoming = element(), outgoing = element();
  const player = {
    ...element(), paused: true, ended: false, muted: false, volume: 0.5,
    readyState: 2, currentTime: 2, currentSrc: "/fixture/a", playCalls: 0,
    getAttribute(name) { return name === "src" ? this.currentSrc : null; },
    closest: () => stage,
    pause() { this.paused = true; },
    play() { this.playCalls += 1; this.paused = false; return this.playCalls === 1 ? pending.promise : Promise.resolve(); },
    shortVideoSetPlaybackIntent(playing) {
      this.dataset.shortVideoExplicitPlaybackIntent = playing ? "play" : "pause";
      this.dataset.shortVideoPlaybackIntentGeneration = String(Number(this.dataset.shortVideoPlaybackIntentGeneration || 0) + 1);
    }
  };
  player.dataset = {
    videoId: "a", shortVideoSlot: "current", primaryControlsBound: "1",
    shortVideoSourceGeneration: "1", shortVideoPlaybackIntentGeneration: "0"
  };
  incoming.querySelector = selector => selector.includes("short-video-player") ? player
    : selector === ".short-video-stage" ? stage : null;
  const stack = {
    ...element(), querySelector: selector => selector.includes("is-current") ? outgoing : incoming,
    querySelectorAll: () => [outgoing]
  };
  const state = { activeView: "shortVideos", shortVideo: {
    current: { id: "a" }, muted: false, playbackRate: 1, mode: "feed", collectionId: "", query: "", deleted: "all", authorAccountStatus: "all"
  } };
  let visiblePlayer = player;
  const context = vm.createContext({
    state, Date, Promise,
    shortVideoOpenRequestId: 1, shortVideoNavigationState: { id: "a" }, shortVideoAdjacentWarmScheduleId: 0,
    shortVideoSoundPreviewAudio: null,
    shortVideoPlaybackLifecycleGeneration: 0, shortVideoPageSuspended: false,
    syncShortVideoModalPlayback() {},
    shortVideoFeedParams: () => `q=${state.shortVideo.query}`,
    shortVideoPlaybackUrl: () => "/fixture/a",
    document: { createElement: element, createTextNode: text => text },
    window: {
      requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
      setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    els: { workGrid: { append() {} } },
    activePlayer: () => visiblePlayer, activeGalleryPlayer: () => null,
    activeReelStack: () => stack,
    renderBrowserTop: element, renderBrowserNav: element, renderControlBar: element,
    isGalleryPost: () => false,
    renderReelPanel: () => ({ panel: incoming, player, syncPlayToggle: () => calls.push("sync-play-toggle") }),
    bindBrowserControlVisibility() {}, setReelPanelInteractionState() {}, disposeReelPanel() {},
    ensureShortVideoPlayerSource(media, video, options = {}) {
      if (!options.forceReload) return false;
      media.currentSrc = options.source || media.currentSrc;
      media.dataset.shortVideoSourceGeneration = String(Number(media.dataset.shortVideoSourceGeneration || 0) + 1);
      return true;
    },
    attachPrimaryPlayerControls() {}, markShortVideoPerformance() {}, createIcon: element,
    normalizePlaybackRate: value => value, cancelShortVideoAutoNext() {}, warmVisibleAdjacentVideoPlayers() {},
    playbackRenditionPolicy: {
      cancelPlayerRecovery() {},
      switchToSmoothFallback() { calls.push("smooth-fallback"); return false; },
      retrySmoothFallback: () => false
    },
    writeMutedPreference: value => calls.push(["muted-preference", value]),
    currentShortVideoVolume: () => 0.5,
    clearPlayerSoundBlocked: () => calls.push("clear-sound-blocked"), syncActiveControlBar: () => calls.push("sync-control-bar"),
    markPlayerSoundBlocked: () => calls.push("sound-blocked")
  });
  vm.runInContext(`${implementation}\nglobalThis.playbackApi = { renderBrowser, restorePlayerSound, promoteAdjacentPanelDom, captureShortVideoPlaybackOwner, ownsShortVideoPlaybackOwner, bindShortVideoPlaybackStatus, toggleActiveMute };`, context);
  return {
    context, state, player, stage, frames, calls, api: context.playbackApi,
    setVisiblePlayer(value) { visiblePlayer = value; },
    reject(name = "NotAllowedError") { player.paused = true; pending.reject(Object.assign(new Error(name), { name })); },
    firstFrame() { assert(frames.length, "renderer must queue a frame"); frames.shift()(); },
    start(kind) {
      if (kind === "render") { this.api.renderBrowser(); this.firstFrame(); }
      else if (kind === "sound") this.api.restorePlayerSound(player, stage);
      else {
        state.shortVideo.current = { id: "previous" };
        player.classList.add("is-ghost");
        player.dataset.shortVideoSlot = "next";
        this.api.promoteAdjacentPanelDom(1, { id: "a" });
        state.shortVideo.current = { id: "a" };
        context.shortVideoNavigationState = { id: "a", promoted: true };
      }
      assert.equal(player.playCalls, 1, `${kind}: initial attempt starts once`);
    }
  };
}

const invalidations = [
  ["explicit pause", f => { f.player.shortVideoSetPlaybackIntent(false); f.player.pause(); }],
  ["pause followed by a new play intent", f => { f.player.shortVideoSetPlaybackIntent(false); f.player.shortVideoSetPlaybackIntent(true); }],
  ["replacement player for same video", f => f.setVisiblePlayer({ dataset: { videoId: "a" }, isConnected: true })],
  ["detached player", f => { f.player.isConnected = false; }],
  ["demoted ghost", f => { f.player.classList.add("is-ghost"); f.player.dataset.shortVideoSlot = "prev"; }],
  ["another current video", f => { f.state.shortVideo.current = { id: "b" }; }],
  ["another app view", f => { f.state.activeView = "home"; }],
  ["new source bytes", f => { f.player.currentSrc = "/fixture/new-source"; }],
  ["reloaded same source", f => { f.player.dataset.shortVideoSourceGeneration = String(Number(f.player.dataset.shortVideoSourceGeneration || 0) + 1); }],
  ["another feed scope", f => { f.state.shortVideo.query = "changed"; }],
  ["another open request", f => { f.context.shortVideoOpenRequestId += 1; }],
  ["new sound intent", f => { f.player.dataset.shortVideoSoundIntentGeneration = String(Number(f.player.dataset.shortVideoSoundIntentGeneration || 0) + 1); }]
];

for (const [label, invalidate] of invalidations) {
  const f = fixture();
  f.api.renderBrowser();
  invalidate(f);
  f.firstFrame();
  assert.equal(f.player.playCalls, 0, `${label}: obsolete initial RAF cannot start playback`);
}

for (const kind of ["render", "sound", "promote"]) {
  for (const [label, invalidate] of invalidations) {
    const f = fixture();
    f.start(kind);
    invalidate(f);
    f.reject();
    const muted = f.player.muted;
    await settle();
    assert.equal(f.player.playCalls, 1, `${kind}/${label}: stale rejection cannot restart playback`);
    assert.equal(f.player.paused, true, `${kind}/${label}: stale rejection preserves paused media`);
    assert.equal(f.player.muted, muted, `${kind}/${label}: stale rejection cannot change sound`);
    assert(!f.calls.includes("sound-blocked"), `${kind}/${label}: stale rejection cannot display sound-blocked state`);
  }
  for (const name of ["AbortError", "NotSupportedError", "NetworkError"]) {
    const f = fixture();
    f.start(kind);
    f.reject(name);
    await settle();
    assert.equal(f.player.playCalls, 1, `${kind}/${name}: non-permission failures must not trigger a silent retry`);
    assert(!f.calls.includes("sound-blocked"), `${kind}/${name}: non-permission failures must not be labelled as blocked sound`);
  }
  const f = fixture();
  f.start(kind);
  f.reject();
  await settle();
  assert.equal(f.player.playCalls, 2, `${kind}: current NotAllowedError keeps its one muted fallback`);
  assert.equal(f.player.muted, true);
  assert.equal(f.calls.filter(value => value === "sound-blocked").length, 1);
}

for (const kind of ["render", "sound"]) {
  const f = fixture();
  f.start(kind);
  f.context.shortVideoNavigationState = { id: "a", replacement: true };
  f.reject();
  await settle();
  assert.equal(f.player.playCalls, 1, `${kind}: replacement navigation owner invalidates its pending attempt`);
}

{
  const f = fixture();
  f.player.shortVideoSetPlaybackIntent(false);
  f.api.restorePlayerSound(f.player, f.stage);
  assert.equal(f.player.dataset.shortVideoExplicitPlaybackIntent, "play", "an explicit restore-sound click may resume intentionally paused playback");
  assert.equal(f.player.playCalls, 1);
}

{
  const f = fixture();
  f.api.restorePlayerSound(f.player, f.stage);
  f.api.restorePlayerSound(f.player, f.stage);
  f.reject();
  await settle();
  assert.equal(f.player.playCalls, 2, "an earlier sound attempt cannot retry over a later sound choice");
  assert.equal(f.player.muted, false);
}

for (const [label, invalidate] of invalidations) {
  const f = fixture();
  f.player.autoplay = true;
  f.player.dataset.shortVideoFrameReady = "1";
  f.api.bindShortVideoPlaybackStatus(f.stage, f.player, { id: "a" }, () => f.calls.push("sync-status"));
  const retry = f.stage.children[0].children[2];
  retry.emit("click");
  f.player.emit("loadedmetadata");
  assert.equal(f.player.playCalls, 1);
  invalidate(f);
  f.reject("AbortError");
  const syncCount = f.calls.filter(value => value === "sync-status").length;
  await settle();
  assert.equal(f.calls.filter(value => value === "sync-status").length, syncCount,
    `manual retry/${label}: a stale play rejection cannot clear newer playback intent or its status`);
}

{
  const f = fixture();
  f.player.autoplay = true;
  f.player.dataset.shortVideoFrameReady = "1";
  f.api.bindShortVideoPlaybackStatus(f.stage, f.player, { id: "a" });
  f.stage.children[0].children[2].emit("click");
  f.player.emit("loadedmetadata");
  f.player.shortVideoSetPlaybackIntent(false);
  f.player.shortVideoSetPlaybackIntent(true);
  f.player.emit("playing");
  f.reject("AbortError");
  await settle();
  f.player.error = { code: 3 };
  f.player.emit("error");
  assert(f.calls.includes("smooth-fallback"), "an old retry rejection cannot cancel a newer explicit play request");
}

for (const [label, invalidate] of invalidations) {
  const f = fixture();
  f.player.paused = false;
  f.player.muted = true;
  const result = f.api.toggleActiveMute();
  assert.equal(f.player.playCalls, 1);
  invalidate(f);
  f.reject();
  const preferences = f.calls.filter(value => Array.isArray(value) && value[0] === "muted-preference").length;
  assert.equal(await result, null, `mute/${label}: obsolete unmute attempt reports no current result`);
  assert.equal(f.player.playCalls, 1, `mute/${label}: old unmute rejection cannot restart the previous player`);
  assert.equal(f.state.shortVideo.muted, false, `mute/${label}: old rejection cannot overwrite the latest global sound preference`);
  assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === "muted-preference").length, preferences,
    `mute/${label}: obsolete rejection cannot persist another sound preference`);
}

for (const name of ["AbortError", "NotAllowedError"]) {
  const f = fixture();
  f.player.paused = false;
  f.player.muted = true;
  const result = f.api.toggleActiveMute();
  f.reject(name);
  const value = await result;
  assert.equal(value, name === "AbortError", "only a current permission denial falls back to muted playback");
  assert.equal(f.player.playCalls, name === "AbortError" ? 1 : 2);
  assert.equal(f.state.shortVideo.muted, name === "NotAllowedError");
}

{
  const f = fixture();
  f.player.paused = false;
  f.player.muted = true;
  const first = f.api.toggleActiveMute(); // Pending unmute.
  assert.equal(await f.api.toggleActiveMute(), false); // Mute.
  assert.equal(await f.api.toggleActiveMute(), true); // Unmute again.
  f.reject();
  assert.equal(await first, null, "sound ABA must invalidate the first unmute even when the visible muted value matches again");
  assert.equal(f.player.playCalls, 2);
  assert.equal(f.player.muted, false);
  assert.equal(f.state.shortVideo.muted, false);
}

for (const staleEvent of ["play", "playing"]) {
  for (const obsoleteState of ["paused", "ended", "explicit-pause", "ghost", "disconnected", "other-video"]) {
    const f = fixture(), video = { id: "a", streamUrl: "/media/short-video/a" };
    globalThis.window = f.context.window;
    f.context.playbackRenditionPolicy = createShortVideoPlaybackRenditionPolicy({ api: async () => ({}) });
    f.player.currentSrc = video.streamUrl; f.player.dataset.streamUrl = video.streamUrl;
    f.api.bindShortVideoPlaybackStatus(f.stage, f.player, video);
    f.player.shortVideoSetPlaybackIntent(false); f.player.pause();
    if (obsoleteState !== "paused") f.player.paused = false;
    if (obsoleteState !== "explicit-pause") delete f.player.dataset.shortVideoExplicitPlaybackIntent;
    if (obsoleteState === "ended") f.player.ended = true;
    if (obsoleteState === "ghost") f.player.classList.add("is-ghost");
    if (obsoleteState === "disconnected") f.player.isConnected = false;
    if (obsoleteState === "other-video") f.player.dataset.videoId = "previous";
    f.player.emit(staleEvent);
    // The element can be current again by the time an actual decode failure
    // arrives. A queued old start event must not have changed its pause intent.
    f.player.paused = true; f.player.ended = false; f.player.isConnected = true;
    f.player.classList.remove("is-ghost"); f.player.dataset.videoId = "a";
    f.player.error = { code: 3 }; f.player.emit("error"); f.player.emit("loadedmetadata");
    assert.equal(f.player.currentSrc, video.streamUrl, `${staleEvent}/${obsoleteState}: obsolete native events cannot start a fallback reload`);
    assert.equal(f.player.playCalls, 0, `${staleEvent}/${obsoleteState}: recovery preserves the latest paused choice`);
    assert.equal(f.player.paused, true);
  }
}

console.log("Short-video playback attempt ownership checks passed.");

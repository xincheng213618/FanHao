import assert from "node:assert/strict";
import { createShortVideoPlaybackRenditionPolicy } from "../public/modules/short-videos/playback-rendition-policy.js";
import { createShortVideoPlayerSourceLifecycle, disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

// Real playback policy and source lifecycle; media events and the 1.2s clock
// are controlled without opening a service, database, media file or browser.
class Media extends EventTarget {
  constructor(source) {
    super();
    this.dataset = { videoId: "clip", streamUrl: source };
    this.attributes = new Map([["src", source]]);
    this.classes = new Set();
    this.classList = { contains: (name) => this.classes.has(name) };
    this.isConnected = true;
    this.readyState = 0;
    this.currentTime = 12;
    this.duration = 60;
    this.paused = true;
    this.ended = false;
    this.error = { code: 3 };
    this.playCalls = 0;
    this.loadCalls = 0;
    this.listenerCount = 0;
  }
  get src() { return this.getAttribute("src") || ""; }
  set src(value) { this.attributes.set("src", value); }
  get currentSrc() { return this.src; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(...args) { this.listenerCount += 1; super.addEventListener(...args); }
  removeEventListener(...args) { this.listenerCount -= 1; super.removeEventListener(...args); }
  emit(name) { this.dispatchEvent(new Event(name)); }
  load() {
    this.loadCalls += 1;
    this.currentTime = 0;
    this.readyState = 0;
    this.error = null;
    this.emit("emptied");
    this.emit("loadstart");
  }
  pause() { this.paused = true; this.emit("pause"); }
  async play() { this.playCalls += 1; this.paused = false; this.emit("play"); }
  metadata() { this.readyState = 1; this.emit("loadedmetadata"); }
}

function fixture({ original = false } = {}) {
  const timers = new Map(), reports = [], scheduled = [], restores = [];
  let timerId = 0;
  globalThis.window = {
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const video = { id: "clip", streamUrl: "/media/short-video/clip?v=fixture" };
  const policy = createShortVideoPlaybackRenditionPolicy({ api: async (...args) => { reports.push(args); } });
  const player = new Media(original ? video.streamUrl : policy.smoothPlaybackUrl(video));
  const lifecycle = createShortVideoPlayerSourceLifecycle({
    markPerformance() {}, playbackUrl: policy.playbackUrl, waitForFirstFrame: async () => true
  });
  let wantsToPlay = true;
  const options = {
    wantsToPlay: true, canResume: () => wantsToPlay, lastGoodTime: 18,
    ensureSource: (...args) => { restores.push(args[2]); return lifecycle.ensureShortVideoPlayerSource(...args); },
    onScheduled: (...args) => scheduled.push(args)
  };
  const retry = () => policy.retrySmoothFallback(player, video, options);
  const tick = () => {
    const pending = [...timers.entries()];
    pending.forEach(([id, callback]) => { if (timers.delete(id)) callback(); });
  };
  const clean = () => {
    assert.equal(timers.size, 0, "recovery must release its timer");
    assert.equal(player.listenerCount, 0, "recovery must release its media listeners");
    assert.equal(player.shortVideoCancelPlaybackRecovery, undefined, "completed recovery must release its cancellation hook");
  };
  return { player, video, policy, lifecycle, options, retry, tick, timers, reports, scheduled, restores, clean,
    pauseIntent: () => { wantsToPlay = false; } };
}

{
  const f = fixture();
  assert(f.retry());
  assert(f.retry());
  assert.equal(f.timers.size, 1, "duplicate errors must share one pending retry");
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.player.dataset.shortVideoSmoothRetryCount, "1", "duplicate errors must not exhaust the retry budget");
  f.tick();
  assert.equal(f.player.loadCalls, 1);
  assert.match(f.player.src, /retry=1$/);
  assert.equal(f.restores[0].preservePlaybackRecovery, true);
  f.player.metadata();
  assert.equal(f.player.currentTime, 18, "owned reload must restore the last playable time");
  assert.equal(f.player.playCalls, 1, "owned reload must resume requested playback");
  f.player.metadata();
  assert.equal(f.player.playCalls, 1, "metadata restoration must run once");
  f.clean();
}

for (const invalidate of [
  (f) => { f.player.classes.add("is-ghost"); },
  (f) => { f.player.isConnected = false; },
  (f) => { f.player.dataset.videoId = "different-video"; },
  (f) => { f.player.src = "/media/short-video/changed-source"; },
  (f) => { f.policy.cancelPlayerRecovery(f.player); }
]) {
  const f = fixture();
  assert(f.retry());
  invalidate(f);
  f.tick();
  f.player.metadata();
  assert.equal(f.player.loadCalls, 0, "obsolete retry must never reload the media element");
  assert.equal(f.player.playCalls, 0, "obsolete retry must never restart playback");
  f.clean();
}

for (const event of ["loadeddata", "canplay", "playing"]) {
  const f = fixture();
  assert(f.retry());
  f.player.error = null;
  f.player.readyState = 3;
  f.player.emit(event);
  f.tick();
  assert.equal(f.player.loadCalls, 0, "recovered media must cancel an obsolete retry");
  f.clean();
}

{
  const f = fixture();
  assert(f.retry());
  f.tick();
  f.pauseIntent();
  f.player.pause();
  f.player.metadata();
  assert.equal(f.player.currentTime, 18);
  assert.equal(f.player.playCalls, 0, "metadata restoration must read the latest playback intent");
  f.clean();
}

for (const sourceChange of ["manual", "dispose"]) {
  const f = fixture();
  assert(f.retry());
  f.tick();
  if (sourceChange === "manual") {
    f.lifecycle.ensureShortVideoPlayerSource(f.player, f.video, {
      source: "/media/short-video/new-manual-source", forceReload: true, reason: "fixture-manual"
    });
  } else {
    disposeShortVideoMedia({ querySelectorAll: (selector) => selector === "video, audio" ? [f.player] : [] });
  }
  f.player.currentTime = 3;
  f.player.metadata();
  assert.equal(f.player.currentTime, 3, "old metadata restoration must not seek a replacement source");
  assert.equal(f.player.playCalls, 0, "manual reload or disposal must cancel old playback intent");
  f.clean();
}

{
  const f = fixture({ original: true });
  assert(f.policy.switchToSmoothFallback(f.player, f.video, "decode-error", f.options));
  assert.equal(f.reports.length, 1);
  assert.equal(f.player.loadCalls, 1);
  f.player.metadata();
  assert.equal(f.player.currentTime, 18);
  assert.equal(f.player.playCalls, 1, "initial fallback must retain metadata restoration through its own source reload");
  assert.equal(f.policy.playbackUrl(f.video), f.policy.smoothPlaybackUrl(f.video));
  f.clean();
}

for (const phase of ["before-reload", "awaiting-metadata"]) {
  const f = fixture();
  assert(f.retry());
  if (phase === "awaiting-metadata") f.tick();
  f.player.classes.add("is-ghost");
  f.player.pause();
  f.tick();
  f.player.metadata();
  assert.equal(f.player.playCalls, 0, "demoted reels must not restart from a pending recovery");
  f.clean();
}

for (const invalidate of [
  (f) => { f.policy.cancelPlayerRecovery(f.player); },
  (f) => { f.player.src = "/media/short-video/changed-after-reload"; },
  (f) => { f.player.isConnected = false; }
]) {
  const f = fixture();
  assert(f.retry());
  f.tick();
  invalidate(f);
  f.player.currentTime = 4;
  f.player.metadata();
  assert.equal(f.player.currentTime, 4, "late metadata must not seek after cancellation or source replacement");
  assert.equal(f.player.playCalls, 0, "late metadata must not play after cancellation or source replacement");
  f.clean();
}

{
  const f = fixture();
  f.options.ensureSource = () => false;
  assert(f.retry());
  f.tick();
  f.player.metadata();
  assert.equal(f.player.playCalls, 0, "failed source restoration must not retain a playback callback");
  f.clean();
}

{
  const f = fixture();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert(f.retry());
    f.tick();
  }
  assert.equal(f.retry(), false, "failed recovery episodes must keep the existing finite retry budget");
  assert.equal(f.player.loadCalls, 4);
  f.clean();
}

console.log("short-video-playback-recovery: passed");

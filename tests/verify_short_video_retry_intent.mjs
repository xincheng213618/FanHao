import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoFirstFrameController } from "../public/modules/short-videos/first-frame-controller.js";
import { createShortVideoPlayerSourceLifecycle, disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";
import { createShortVideoPlaybackRenditionPolicy } from "../public/modules/short-videos/playback-rendition-policy.js";

// Reuse the existing controlled media/clock fixture, executing current page
// status, lifecycle and actual policy. No API, service, media or DB is accessed.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function take(name) {
  const start = source.indexOf(`  function ${name}(`), end = source.indexOf("\n  }", start);
  assert(start >= 0 && end > start); return source.slice(start, end + 4);
}
const previousFixture = fs.readFileSync(new URL("./verify_short_video_first_frame.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const helpers = previousFixture.slice(previousFixture.indexOf("class Element extends EventTarget"), previousFixture.indexOf("\n{\n  const f = fixture("))
  .replace("return { player, stage, video, controller", "return { env, player, stage, video, controller");
const fixtureContext = vm.createContext({ EventTarget, Event, AbortController, assert, vm,
  createShortVideoFirstFrameController, createShortVideoPlayerSourceLifecycle, disposeShortVideoMedia,
  statusSource: take("bindShortVideoPlaybackStatus"), waitSource: take("waitForVideoFirstFrame"),
  playbackOwnerSource: ["captureShortVideoPlaybackOwner", "ownsShortVideoPlaybackOwner", "shortVideoNavigationScope", "stopShortVideoSoundPreview"].map(take).join("\n") });
vm.runInContext(`${helpers}\nglobalThis.make = fixture;`, fixtureContext);
function fixture({ paused = false, smooth = false } = {}) {
  const f = fixtureContext.make({ bind: false, media: { currentTime: 30, autoplay: !paused, paused,
    dataset: { videoId: "clip", shortVideoSlot: "current", shortVideoFrameReady: "1" } } });
  globalThis.window = f.env.window;
  f.video.streamUrl = "/media/short-video/clip?v=fixture";
  f.player.src = f.video.streamUrl; f.player.dataset.streamUrl = f.player.src;
  const reports = [], policy = createShortVideoPlaybackRenditionPolicy({ api: async (...args) => { reports.push(args); return {}; } });
  if (smooth) { f.player.src = policy.smoothPlaybackUrl(f.video); f.player.dataset.streamUrl = f.player.src; }
  f.env.playbackRenditionPolicy = policy;
  Object.assign(f.env, { releaseUnusedShortVideoPreloads() {}, cancelShortVideoPanelLoading() {}, shortVideoWheelController: null,
    shortVideoOpeningId: "", shortVideoOpenError: "", els: { workGrid: null },
    cancelShortVideoNavigation() {}, collectionsController: { cancelReads() {} },
    cancelShortVideoBrowseGestures() {}, clearPendingPlayerClick() {}, syncActiveControlBar() {}, warmVisibleAdjacentVideoPlayers() {} });
  vm.runInNewContext(`${take("handleShortVideoPageHide")}\n${take("handleShortVideoPageShow")}`, f.env);
  f.handlers.bindShortVideoPlaybackStatus(f.stage, f.player, f.video);
  const status = f.stage.children.find(child => child?.className === "short-video-playback-status"), retry = status.children[2];
  return { ...f, status, retry, policy, reports, metadata() { f.player.readyState = 1; f.player.emit("loadedmetadata"); } };
}

let groups = 0;
for (const target of [0, 5, 45]) {
  for (const seekEvent of ["seeking", "seeked"]) {
    const f = fixture({ paused: true });
    f.player.currentTime = target; f.player.readyState = 1; f.player.emit(seekEvent);
    f.player.error = { code: 2 }; f.player.emit("error");
    f.retry.dispatchEvent(new Event("click")); f.metadata();
    assert.equal(f.player.currentTime, target, "manual retry preserves the newest seek before data became available, including backward seeks and zero");
    assert.equal(f.player.playCalls, 0); assert.equal(f.player.paused, true); assert.equal(f.reports.length, 0);
    f.cleanup(); groups++;
  }
}
{
  const f = fixture();
  f.player.currentTime = 5; f.player.readyState = 1; f.player.emit("seeking");
  f.player.error = { code: 3 }; f.player.emit("error"); f.metadata();
  assert.equal(f.player.currentTime, 5, "automatic compatible recovery uses the same last seek intent");
  assert.equal(f.player.playCalls, 1); assert.equal(f.reports.length, 1); assert.match(f.player.src, /short-video-smooth/);
  f.cleanup(); groups++;
}
{
  const f = fixture({ paused: true });
  f.player.readyState = 0; f.player.currentTime = 0; f.player.emit("loadstart"); f.player.emit("seeking"); f.player.emit("timeupdate");
  f.player.error = { code: 2 }; f.player.emit("error"); f.retry.dispatchEvent(new Event("click")); f.metadata();
  assert.equal(f.player.currentTime, 30, "source reset events without metadata cannot erase the last playable position");
  assert.equal(f.player.playCalls, 0); f.cleanup(); groups++;
}
{
  const f = fixture();
  f.player.currentTime = 5; f.player.readyState = 1; f.player.emit("seeking");
  f.player.readyState = 2; f.player.currentTime = 8; f.player.emit("timeupdate");
  f.player.error = { code: 2 }; f.player.emit("error"); f.retry.dispatchEvent(new Event("click")); f.metadata();
  assert.equal(f.player.currentTime, 8, "real subsequent progress replaces an earlier seek target");
  f.cleanup(); groups++;
}
for (const invalidate of ["pagehide", "role", "source-generation"]) {
  const f = fixture({ smooth: true });
  f.player.error = { code: 2 }; f.player.emit("error");
  assert.equal(f.player.dataset.shortVideoSmoothRetryCount, "1");
  const before = f.player.dataset.shortVideoSourceGeneration || "0";
  if (invalidate === "pagehide") f.env.handleShortVideoPageHide();
  if (invalidate === "role") f.player.dataset.shortVideoPromotedAt = "new-owner";
  if (invalidate === "source-generation") f.player.dataset.shortVideoSourceGeneration = "999";
  await f.tick(1300); f.metadata();
  assert.equal(f.player.playCalls, 0, `${invalidate}: the retired retry cannot play`);
  assert.equal(f.player.dataset.shortVideoSourceGeneration || "0", invalidate === "source-generation" ? "999" : before,
    `${invalidate}: the retired timer cannot reload`);
  f.cleanup(); groups++;
}
{
  const f = fixture(); f.env.handleShortVideoPageHide();
  f.player.error = { code: 3 }; f.player.emit("error");
  f.retry.dispatchEvent(new Event("click")); await f.tick(10000); f.metadata();
  assert.equal(f.player.src, f.video.streamUrl); assert.equal(f.reports.length, 0);
  assert.equal(f.player.playCalls, 0, "late errors, old retry controls and metadata stay inert while pagehide owns the player");
  f.env.handleShortVideoPageShow(); f.player.shortVideoSetPlaybackIntent(true); f.player.emit("error"); f.metadata();
  assert.equal(f.reports.length, 1, "a new explicit intent after pageshow can still recover a real decode failure");
  assert.equal(f.player.playCalls, 1); f.cleanup(); groups++;
}
{
  const f = fixture(); f.player.error = { code: 2 }; f.player.emit("error");
  f.retry.dispatchEvent(new Event("click")); f.env.handleShortVideoPageHide(); f.env.handleShortVideoPageShow(); f.metadata();
  assert.equal(f.player.playCalls, 0, "a pre-pagehide manual metadata listener cannot revive after pageshow");
  f.cleanup(); groups++;
}
{
  const f = fixture({ smooth: true }); f.player.error = { code: 2 }; f.player.emit("error"); await f.tick(1200); f.metadata();
  assert.equal(f.player.currentTime, 30); assert.equal(f.player.playCalls, 1);
  assert.match(f.player.src, /retry=1$/); f.cleanup(); groups++;
}
console.log(`short-video-retry-intent: ${groups} actual status/policy/source lifecycle groups passed`);

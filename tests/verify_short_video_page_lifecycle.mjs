import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Exercise the actual page listeners, playback owner and audio-focus bridge
// with the real preview controller/gallery. Media promises settle independently
// of lifecycle events; no browser, service or real media is accessed.
const helpersFile = new URL("./verify_short_video_sound_focus.mjs", import.meta.url);
let helpers = fs.readFileSync(helpersFile, "utf8");
helpers = helpers.slice(0, helpers.indexOf("\nconst failures = []"));
helpers = helpers.replaceAll("import.meta.url", JSON.stringify(helpersFile.href));
helpers = helpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helpersFile).href}"`);
const { fixture: focusFixture, settle, source, sourceFunction } = await import(`data:text/javascript;base64,${Buffer.from(`${helpers}\nexport { fixture, settle, source, sourceFunction };`).toString("base64")}`);
const handlersSource = ["handleShortVideoPageHide", "handleShortVideoPageShow", "handleShortVideoVisibilityChange",
  "cancelShortVideoNativePlaybackModes", "flushActiveShortVideoWatch"].map(sourceFunction).join("\n");
const registrations = source.split("\n").filter(line => /window\.addEventListener\("(?:pagehide|pageshow)",/.test(line)).join("\n");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const denied = () => Object.assign(new Error("late media denial"), { name: "NotAllowedError" });

async function fixture(options, lifecycleSource = handlersSource) {
  const f = await focusFixture(options), events = new Map(), lifecycleCalls = [];
  Object.assign(f.context, {
    shortVideoOpeningId: "", shortVideoOpenError: "",
    shortVideoFullscreenController: { cancel: () => lifecycleCalls.push("native-fullscreen") },
    shortVideoPictureInPictureController: { cancel: () => lifecycleCalls.push("native-pip") },
    shortVideoWatchWriteController: { flush: () => lifecycleCalls.push("flush") },
    window: { addEventListener(type, callback) { const listeners = events.get(type) || []; listeners.push(callback); events.set(type, listeners); } },
    document: { hidden: false }, els: { workGrid: { querySelectorAll: () => [] } },
    persistShortVideoWatch: () => lifecycleCalls.push("gallery-watch"),
    cancelShortVideoPanelLoading: () => lifecycleCalls.push("cancel-panel"),
    cancelShortVideoNavigation() {}, collectionsController: { cancelReads() {} },
    syncActiveControlBar: () => lifecycleCalls.push("sync"),
    warmVisibleAdjacentVideoPlayers: () => lifecycleCalls.push("warm"),
    releaseOffscreenVideoDecoder: () => lifecycleCalls.push("release-ghost"),
    releaseUnusedShortVideoPreloads() {}
  });
  vm.runInContext(`${lifecycleSource}\n${registrations}\nglobalThis.visibility = handleShortVideoVisibilityChange;`, f.context);
  const event = (type, persisted) => { for (const callback of events.get(type) || []) callback({ type, persisted }); };
  const owner = () => f.api.captureShortVideoPlaybackOwner(f.main(), { allowPaused: true });
  return { ...f, events, lifecycleCalls, event, owner };
}

for (const persisted of [false, true]) {
  for (const complete of ["reject", "resolve"]) {
    const f = await fixture(), pending = deferred();
    f.audio.play = () => { f.audio.playCalls++; f.audio.paused = false; f.audio.dispatchEvent(new Event("play")); return pending.promise; };
    const preview = f.controller.toggle(), oldOwner = f.owner();
    f.event("pagehide", persisted);
    assert.equal(f.audio.paused, true, "pagehide stops both active and pending preview without returning audio focus");
    assert.equal(f.button.getAttribute("aria-busy"), "false");
    assert.equal(f.main().paused, true);
    assert.equal(f.api.ownsShortVideoPlaybackOwner(oldOwner), false);
    const suspendedOwner = f.owner();
    const lifecycleGeneration = f.context.shortVideoPlaybackLifecycleGeneration;
    f.event("pagehide", persisted);
    assert.equal(f.context.shortVideoPlaybackLifecycleGeneration, lifecycleGeneration, "repeated pagehide is idempotent");
    assert.equal(f.lifecycleCalls.filter(value => value === "cancel-panel").length, 1);
    assert(f.lifecycleCalls.includes("flush")); assert(f.lifecycleCalls.includes("native-pip"));
    if (complete === "reject") pending.reject(denied()); else pending.resolve();
    await preview; await settle();
    assert.equal(f.main().playCalls, 0, "a stale preview result cannot restore the old main playback lease");
    assert.equal(f.audio.paused, true);
    assert.equal(f.calls.some(value => Array.isArray(value) && value[0] === "error"), false, "late preview failures stay silent");
    f.event("pageshow", persisted); f.event("pageshow", persisted);
    assert.equal(f.main().paused, true, "BFCache return preserves paused media rather than replaying the old lease");
    assert.equal(f.main().playCalls, 0);
    assert.equal(f.api.ownsShortVideoPlaybackOwner(oldOwner), false, "pageshow cannot resurrect an old playback owner");
    assert.equal(f.api.ownsShortVideoPlaybackOwner(suspendedOwner), false, "an owner captured by a suspended callback stays invalid after pageshow");
    assert.equal(f.lifecycleCalls.filter(value => value === "warm").length, 1);
    f.audio.play = async () => { f.audio.playCalls++; f.audio.paused = false; f.audio.dispatchEvent(new Event("play")); };
    await f.controller.toggle();
    assert.equal(f.audio.paused, false, "the same preview control can start a new intent after pageshow");
    f.controller.stop(); f.api.toggleActivePlayer(); await settle();
    assert.equal(f.main().paused, false, "new explicit main play is available after pageshow");
    await f.clean();
  }
}

for (const persisted of [false, true]) {
  const f = await fixture(), pending = deferred();
  await f.controller.toggle();
  f.main().play = () => { f.main().playCalls++; return pending.promise; };
  f.controller.stop();
  assert.equal(f.main().playCalls, 1);
  f.event("pagehide", persisted);
  f.event("pageshow", persisted);
  pending.reject(denied()); await settle();
  assert.equal(f.main().playCalls, 1, "late resume failure after pagehide/pageshow cannot start a muted fallback");
  assert.equal(f.main().muted, false); assert.equal(f.calls.includes("blocked"), false);
  await f.clean();
}

for (const paused of [false, true]) {
  const f = await fixture({ paused });
  const owner = f.owner();
  f.context.document.hidden = true; f.context.visibility();
  assert.equal(f.main().paused, paused, "ordinary tab visibility preserves the current playback choice");
  assert.equal(f.api.ownsShortVideoPlaybackOwner(owner), true, "hidden alone does not invalidate playback ownership");
  f.context.document.hidden = false; f.context.visibility();
  f.event("pagehide", true); f.event("pageshow", true);
  assert.equal(f.main().paused, paused, "pagehide/pageshow does not force a new play or pause on normal active media");
  assert.equal(f.main().playCalls, 0);
  await f.clean();
}

for (const sound of [false, true]) {
  const f = await fixture({ gallery: true, sound });
  await f.controller.toggle();
  f.event("pagehide", true); f.event("pageshow", true); await settle();
  assert.equal(f.audio.paused, true);
  assert.equal(f.g.gallery.shortVideoGalleryIsPaused(), true, "pagehide cannot release preview timing into an automatic gallery advance");
  if (sound) assert.equal(f.main().paused, true);
  f.api.toggleActivePlayer(); await settle();
  assert.equal(f.g.gallery.shortVideoGalleryIsPaused(), false, "a restored gallery still accepts explicit user play");
  await f.clean();
}

const seekHelpersFile = new URL("./verify_short_video_seek.mjs", import.meta.url);
let seekHelpers = fs.readFileSync(seekHelpersFile, "utf8").split("const flush = async")[0];
seekHelpers = seekHelpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, seekHelpersFile).href}"`);
const { fixture: seekFixture } = await import(`data:text/javascript;base64,${Buffer.from(`${seekHelpers}\nexport { fixture };`).toString("base64")}`);

async function verifySeekPageLifecycle(lifecycleSource = handlersSource) {
  for (const persisted of [false, true]) for (const release of ["pointerup", "pointercancel", "lostpointercapture"]) {
    const f = await fixture(undefined, lifecycleSource), seek = seekFixture(), bar = {};
    const hook = source.match(/^    bar\.shortVideoCancelSeek = .*;$/m)?.[0];
    if (hook) vm.runInNewContext(hook, { bar, seekController: seek.controller });
    f.context.activePlayer = () => seek.player;
    f.context.els.workGrid.querySelector = selector => selector === ".short-video-control-bar" ? bar : null;
    f.context.syncActiveControlBar = () => seek.controller.sync();
    seek.event("pointerdown", { clientX: 200 });
    seek.event("pointermove", { clientX: 340 });
    const lateFrame = [...seek.frames.values()][0];
    f.event("pagehide", persisted);
    assert.equal(seek.controller.isScrubbing(), false, "pagehide must cancel the active seek session");
    assert.equal(seek.frames.size, 0); assert.equal(seek.progress.captures.size, 0);
    f.event("pageshow", persisted);
    lateFrame?.(0); seek.event(release, { clientX: 480 });
    assert.equal(seek.player.currentTime, 12.5, "a retired seek cannot commit a delayed sample after BFCache return");
    assert.equal(seek.player.playCalls, 0, "a retired release cannot restore pre-background playback");
    assert.equal(seek.player.paused, true);
    // The same control still accepts a fresh, explicit interaction after return.
    await seek.player.play();
    seek.event("pointerdown", { clientX: 200 }); seek.event("pointerup", { clientX: 300 });
    assert.equal(seek.player.currentTime, 50); assert.equal(seek.player.playCalls, 2);
    seek.controller.dispose(); await f.clean();
  }
}
await verifySeekPageLifecycle();
const withoutSeekCancel = handlersSource.replace(/^.*shortVideoCancelSeek.*\n/m, "");
assert.notEqual(withoutSeekCancel, handlersSource, "the negative control must remove the real pagehide wiring");
await assert.rejects(verifySeekPageLifecycle(withoutSeekCancel), /pagehide must cancel the active seek session/);

console.log("short-video-page-lifecycle: passed actual pagehide/pageshow listeners, preview cancellation, stale play errors, hidden playback policy and restored video/gallery intent");

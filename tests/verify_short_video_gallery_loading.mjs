import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

// Reuse the controlled DOM/media factory while running the actual lazy page
// wrapper, modal lifecycle and gallery module. No service or media is used.
const helpersFile = new URL("./verify_short_video_gallery_metadata.mjs", import.meta.url);
let helpers = fs.readFileSync(helpersFile, "utf8");
helpers = helpers.slice(0, helpers.indexOf("\n{\n  const f = fixture();"));
helpers = helpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helpersFile).href}"`);
const oldReturn = "return { root, stage, video, state, gallery, timers, frames, elements, watches, intents, advances, ready, readyAll, flushFrames, dispose };";
assert(helpers.includes(oldReturn));
helpers = helpers.replace(oldReturn, oldReturn.replace("return {", "return { render,"));
const { fixture: galleryFixture, Element } = await import(`data:text/javascript;base64,${Buffer.from(`${helpers}\nexport { fixture, Element };`).toString("base64")}`);
Element.prototype.replaceWith = function (...nodes) {
  const parent = this.parent;
  if (!parent) return;
  const index = parent.children.indexOf(this);
  nodes.forEach(node => { node.remove(); node.parent = parent; });
  parent.children.splice(index, 1, ...nodes); this.parent = null;
};
Element.prototype.hasAttribute = function (name) { return this.attributes.has(name); };
Object.defineProperty(Element.prototype, "parentElement", { get() { return this.parent || null; } });

const page = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8");
function takeFunction(name, next) {
  const start = page.indexOf(`  function ${name}(`), end = page.indexOf(`  function ${next}(`, start);
  assert(start >= 0 && end > start); return page.slice(start, end);
}
const wrapperSource = takeFunction("renderGalleryPlayer", "applyVideoOrientation");
const modalSource = takeFunction("isolateShortVideoTransientModal", "focusShortVideoTransientModal");
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const sound = { localAvailable: true, previewUrl: "/fixture/latest-sound" };
async function fixture({ ghost = false, initialSound = null } = {}) {
  const f = galleryFixture({ ghost: true });
  f.gallery.shortVideoGalleryDispose(); f.gallery.remove(); f.frames.clear(); f.timers.clear();
  f.state.activeView = "shortVideos";
  if (initialSound) f.video.sound = initialSound;
  let releaseModule, rejectModule, moduleRequests = 0, autoCancels = 0, controlSyncs = 0;
  const module = new Promise((resolve, reject) => { releaseModule = resolve; rejectModule = reject; });
  const env = { window: globalThis.window, document: globalThis.document, state: f.state,
    ensureShortVideoGalleryPlayer: () => { moduleRequests++; return module; },
    markShortVideoPerformance() {}, isCurrentShortVideo: video => f.state.shortVideo.current?.id === video.id,
    syncActiveControlBar: () => { controlSyncs++; }, showBrowserToast() {}, activePlayer: () => null,
    syncShortVideoModalPlayback() {}, cancelShortVideoPanelLoading() {},
    activeGalleryPlayer: () => f.stage.querySelector(".short-video-gallery-player"),
    waitForVideoFirstFrame: () => Promise.resolve(true), SHORT_VIDEO_FIRST_FRAME_TIMEOUT_MS: 1000,
    shortVideoWheelController: null, cancelShortVideoAutoNext: () => { autoCancels++; }, cancelShortVideoBrowseGestures() {} };
  const handlers = vm.runInNewContext(`${wrapperSource}\n${modalSource}\n({ renderGalleryPlayer, isolateShortVideoTransientModal, restoreShortVideoTransientModalIsolation });`, env);
  const placeholder = handlers.renderGalleryPlayer(f.video, { ghost, stage: f.stage }); f.stage.append(placeholder);
  await f.flushFrames(); await settle();
  const release = async () => { releaseModule(f.render); await settle(); };
  const overlay = () => {
    const node = new Element("section"); f.root.append(node); handlers.isolateShortVideoTransientModal(node); return node;
  };
  return { ...f, placeholder, handlers, release, rejectModule, overlay,
    mounted: () => f.stage.querySelector(".short-video-gallery-player"),
    get moduleRequests() { return moduleRequests; }, get autoCancels() { return autoCancels; }, get controlSyncs() { return controlSyncs; } };
}

{
  const f = await fixture();
  assert.equal(f.placeholder.shortVideoGalleryTogglePlayback(), true);
  assert.equal(f.placeholder.shortVideoGalleryIsPaused(), true);
  assert.equal(f.placeholder.shortVideoGalleryUpdateMetadata({ id: "gallery", sound }), true);
  assert.equal(f.placeholder.shortVideoGalleryUpdateMetadata({ id: "other", sound: { ...sound, previewUrl: "/wrong" } }), false);
  await f.release(); await f.flushFrames();
  const actual = f.mounted(), audio = actual.querySelector("audio");
  assert.notEqual(actual, f.placeholder); assert.equal(f.placeholder.isConnected, false);
  assert.equal(f.placeholder.shortVideoGalleryResolve(), actual);
  assert.equal(actual.shortVideoGalleryIsPaused(), true); assert.equal(actual.dataset.shortVideoPlaybackIntentGeneration, "1");
  assert.equal(audio.src, sound.previewUrl); assert.equal(audio.autoplay, false); assert.equal(audio.playCalls, 0);
  assert.equal(f.autoCancels, 1, "a user action during module loading still cancels post-level auto-next");
  f.placeholder.shortVideoGalleryResume("user"); await settle(); assert.equal(actual.shortVideoGalleryIsPaused(), false);
  assert.equal(audio.paused, false, "saved placeholder references must forward after mounting");
  await f.dispose();
}
{
  const f = await fixture(); const overlay = f.overlay();
  assert.equal(overlay._shortVideoPausedGallery, f.placeholder);
  f.placeholder.shortVideoGalleryUpdateMetadata({ id: "gallery", sound });
  await f.release(); await f.flushFrames();
  const actual = f.mounted(), audio = actual.querySelector("audio");
  assert.equal(actual.classList.contains("is-gallery-timing-paused"), true); assert.equal(audio.playCalls, 0);
  f.handlers.restoreShortVideoTransientModalIsolation(overlay); await settle();
  assert.equal(overlay._shortVideoPausedGallery, null);
  assert.equal(actual.classList.contains("is-gallery-timing-paused"), false);
  assert.equal(audio.paused, false, "the actual restore hook resolves the detached placeholder before its connection check");
  await f.dispose();
}
{
  const f = await fixture({ initialSound: sound }); const overlay = f.overlay();
  f.placeholder.shortVideoGalleryPause("user");
  await f.release(); await f.flushFrames(); const actual = f.mounted(), audio = actual.querySelector("audio");
  f.handlers.restoreShortVideoTransientModalIsolation(overlay); await settle();
  assert.equal(actual.shortVideoGalleryIsPaused(), true); assert.equal(audio.playCalls, 0);
  f.placeholder.shortVideoGalleryResume("user"); await settle(); assert.equal(audio.paused, false);
  await f.dispose();
}
{
  const f = await fixture({ initialSound: sound });
  f.placeholder.shortVideoGalleryPause("visibility"); await f.release(); await f.flushFrames();
  const actual = f.mounted(), audio = actual.querySelector("audio");
  assert.equal(audio.playCalls, 0); assert.equal(actual.classList.contains("is-gallery-timing-paused"), true);
  f.placeholder.shortVideoGalleryResume("visibility"); await settle(); assert.equal(audio.paused, false);
  await f.dispose();
}
{
  const f = await fixture({ initialSound: sound }); const overlay = f.overlay();
  f.handlers.restoreShortVideoTransientModalIsolation(overlay);
  await f.release(); await f.flushFrames();
  assert.equal(f.mounted().classList.contains("is-gallery-timing-paused"), false);
  assert.equal(f.mounted().querySelector("audio").paused, false, "closing before mount must not leave a stale modal pause");
  await f.dispose();
}
{
  const f = await fixture({ initialSound: sound });
  f.placeholder.shortVideoGallerySetActive(false); await f.release(); await f.flushFrames();
  const actual = f.mounted(); assert(actual.classList.contains("is-ghost")); assert.equal(actual.querySelector("audio"), null);
  assert.equal(f.watches.length, 0, "demotion before module readiness must render a quiet preview");
  actual.shortVideoGallerySetActive(true); await f.flushFrames();
  assert.equal(actual.querySelector("audio").paused, false);
  await f.dispose();
}
{
  const f = await fixture({ ghost: true, initialSound: sound });
  f.placeholder.shortVideoGallerySetActive(true); await f.release(); await f.flushFrames();
  assert.equal(f.mounted().classList.contains("is-ghost"), false);
  assert.equal(f.mounted().querySelector("audio").paused, false, "promotion during module loading must use the latest active role");
  assert.equal(f.moduleRequests, 1, "prepare/promotion share the pending lazy import");
  await f.dispose();
}
for (const invalidate of [f => f.placeholder.shortVideoGalleryDispose(), f => disposeShortVideoMedia(f.root), f => f.placeholder.remove()]) {
  const f = await fixture({ initialSound: sound }); invalidate(f);
  await f.release(); await f.flushFrames();
  assert.equal(f.stage.querySelector("audio"), null);
  assert.equal(f.placeholder.shortVideoGalleryResolve(), f.placeholder, "a disposed/detached loading view cannot mount after its module arrives");
  await f.dispose();
}

delete globalThis.window; delete globalThis.document;
console.log("short-video-gallery-loading: lazy intent/metadata/role handoff, actual modal restore and stale mount cancellation passed");

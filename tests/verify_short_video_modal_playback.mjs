import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Run the actual gallery, lazy wrapper and page modal hooks with controlled
// DOM/media/timers. No application service, database or real media is used.
const fixtureFile = new URL("./verify_short_video_gallery_metadata.mjs", import.meta.url);
let helpers = fs.readFileSync(fixtureFile, "utf8");
helpers = helpers.slice(0, helpers.indexOf("\n{\n  const f = fixture();"));
helpers = helpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, fixtureFile).href}"`);
const fixtureReturn = "return { root, stage, video, state, gallery, timers, frames, elements, watches, intents, advances, ready, readyAll, flushFrames, dispose };";
assert(helpers.includes(fixtureReturn));
helpers = helpers.replace(fixtureReturn, fixtureReturn.replace("return {", "return { render,"));
const { fixture: galleryFixture, Element } = await import(`data:text/javascript;base64,${Buffer.from(`${helpers}\nexport { fixture, Element };`).toString("base64")}`);
Element.prototype.hasAttribute = function (name) { return this.attributes.has(name); };
Element.prototype.focus = function () { document.activeElement = this; };
Element.prototype.replaceWith = function (...nodes) {
  const parent = this.parent;
  if (!parent) return;
  const index = parent.children.indexOf(this);
  nodes.forEach(node => { node.remove(); node.parent = parent; });
  parent.children.splice(index, 1, ...nodes); this.parent = null;
};
Object.defineProperty(Element.prototype, "parentElement", { get() { return this.parent || null; } });

const page = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8");
const takeFunctions = (name, next) => {
  const start = page.indexOf(`  function ${name}(`), end = page.indexOf(`  function ${next}(`, start);
  assert(start >= 0 && end > start);
  return page.slice(start, end);
};
const modalSource = takeFunctions("isolateShortVideoTransientModal", "focusShortVideoTransientModal");
const authorSource = takeFunctions("isolateAuthorPanelAsMobileModal", "bindAuthorPanelDragToClose");
const wrapperSource = takeFunctions("renderGalleryPlayer", "applyVideoOrientation");
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const advanceTimers = f => [...f.timers.entries()].filter(([, timer]) => timer.delay > 2000 && timer.delay <= 4000).map(([id]) => id);
const sound = { localAvailable: true, previewUrl: "/fixture/modal-sound" };

async function fixture({ mobile = false, lazy = false, live = false } = {}) {
  const f = galleryFixture({ ghost: lazy, live });
  f.state.activeView = "shortVideos";
  let currentGallery = f.gallery, releaseModule;
  const galleryModule = new Promise(resolve => { releaseModule = resolve; });
  window.matchMedia = () => ({ matches: mobile });
  const env = {
    window, document, state: f.state,
    els: { workGrid: { querySelector: () => f.root } },
    activeGalleryPlayer: () => currentGallery,
    activePlayer: () => null,
    shortVideoWheelController: { cancel() {} },
    cancelShortVideoAutoNext() {}, cancelShortVideoBrowseGestures() {}, cancelShortVideoPanelLoading() {},
    bindShortVideoModalFocusLoop() {}, closeAuthorPanel() {},
    ensureShortVideoGalleryPlayer: () => galleryModule,
    markShortVideoPerformance() {}, isCurrentShortVideo: video => f.state.shortVideo.current?.id === video.id,
    syncActiveControlBar() {}, showBrowserToast() {},
    waitForVideoFirstFrame: () => Promise.resolve(true), SHORT_VIDEO_FIRST_FRAME_TIMEOUT_MS: 1000
  };
  const hooks = vm.runInNewContext(`${modalSource}\n${authorSource}\n${wrapperSource}\n({ isolateShortVideoTransientModal, restoreShortVideoTransientModalIsolation, isolateAuthorPanelAsMobileModal, restoreAuthorPanelModalIsolation, syncShortVideoModalPlayback, renderGalleryPlayer });`, env);
  if (lazy) {
    f.gallery.shortVideoGalleryDispose(); f.gallery.remove(); f.frames.clear(); f.timers.clear();
    f.video.sound = sound;
    currentGallery = hooks.renderGalleryPlayer(f.video, { ghost: false, stage: f.stage });
    f.stage.append(currentGallery);
    await f.flushFrames();
  } else {
    await f.readyAll();
  }
  const overlay = (author = false) => {
    const node = new Element("section"); f.root.append(node);
    if (author) {
      const sheet = new Element("section"), close = new Element("button");
      sheet.append(close); node.append(sheet);
      hooks.isolateAuthorPanelAsMobileModal(node, sheet, f.root, close);
    } else hooks.isolateShortVideoTransientModal(node);
    return node;
  };
  const close = (node, author = false) => {
    if (author) hooks.restoreAuthorPanelModalIsolation(node);
    else hooks.restoreShortVideoTransientModalIsolation(node);
    node.remove();
  };
  const release = async () => {
    releaseModule(f.render); await settle(); await f.flushFrames();
    currentGallery = currentGallery.shortVideoGalleryResolve?.() || currentGallery;
    return currentGallery;
  };
  return { ...f, hooks, overlay, close, release,
    current: () => currentGallery, setCurrent: gallery => { currentGallery = gallery; } };
}

{
  const f = await fixture();
  const first = {}, second = {};
  f.gallery.shortVideoGalleryPause(first);
  f.gallery.shortVideoGalleryPause(second);
  f.gallery.shortVideoGalleryResume(second);
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), true);
  assert.equal(advanceTimers(f).length, 0, "releasing one reason cannot restart another owner's slideshow");
  f.gallery.shortVideoGalleryResume(first);
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), false);
  const timer = advanceTimers(f);
  assert.equal(timer.length, 1);
  f.gallery.shortVideoGalleryResume(first);
  f.gallery.shortVideoGalleryResume(second);
  f.gallery.shortVideoGalleryResume("never-acquired");
  assert.deepEqual(advanceTimers(f), timer, "repeated/unknown resume must not create overlapping advance timers");
  await f.dispose();
}

for (const outOfOrder of [false, true]) {
  const f = await fixture();
  const existingInert = new Element("div"); existingInert.setAttribute("inert", ""); f.root.append(existingInert);
  const first = f.overlay();
  f.hooks.isolateShortVideoTransientModal(first);
  const second = f.overlay();
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), true);
  assert(f.stage.hasAttribute("inert"));
  f.close(outOfOrder ? first : second);
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), true, "either close order must retain the other pause owner");
  assert(f.stage.hasAttribute("inert"), "late closure of an old modal cannot release the newer modal's background isolation");
  assert.equal(advanceTimers(f).length, 0);
  f.close(outOfOrder ? second : first);
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), false);
  assert.equal(f.stage.hasAttribute("inert"), false);
  assert(existingInert.hasAttribute("inert"), "initial inert state must survive the last release");
  assert.equal(f.stage._shortVideoModalInertLease, undefined);
  const timers = advanceTimers(f);
  assert.equal(timers.length, 1);
  f.hooks.restoreShortVideoTransientModalIsolation(first);
  f.hooks.restoreShortVideoTransientModalIsolation(second);
  assert.deepEqual(advanceTimers(f), timers, "close callbacks are safe to run twice");
  await f.dispose();
}

{
  const f = await fixture({ live: true });
  const clip = f.gallery.querySelector(".short-video-gallery-image");
  clip.currentTime = 2.75;
  const first = f.overlay(), second = f.overlay(), plays = clip.playCalls;
  assert.equal(clip.paused, true);
  f.close(second);
  assert.equal(clip.paused, true, "a remaining modal keeps the live-photo clip paused");
  assert.equal(clip.playCalls, plays);
  f.close(first); await settle();
  assert.equal(clip.paused, false);
  assert.equal(clip.currentTime, 2.75, "last-owner restoration preserves the live-photo position");
  assert.equal(clip.playCalls, plays + 1);
  f.hooks.restoreShortVideoTransientModalIsolation(first);
  assert.equal(clip.playCalls, plays + 1, "duplicate close never restarts the live-photo clip");
  await f.dispose();
}

{
  const f = await fixture();
  f.gallery.shortVideoGalleryUpdateMetadata({ id: f.video.id, sound }); await f.flushFrames();
  const audio = f.gallery.querySelector("audio");
  f.gallery.shortVideoGalleryPause("user");
  const modal = f.overlay();
  f.close(modal);
  assert.equal(f.gallery.shortVideoGalleryIsPaused(), true);
  assert.equal(advanceTimers(f).length, 0);
  const nextModal = f.overlay(), plays = audio.playCalls;
  f.gallery.shortVideoGalleryResume("user"); await settle();
  assert.equal(audio.playCalls, plays, "play intent cannot bypass a remaining modal pause");
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), true);
  f.close(nextModal); await settle();
  assert.equal(audio.playCalls, plays + 1, "the last owner release fulfills deferred user play intent once");
  assert.equal(audio.paused, false);
  assert.equal(advanceTimers(f).length, 1);
  await f.dispose();
}

{
  const f = await fixture({ mobile: true });
  const author = f.overlay(true), settings = f.overlay();
  assert.equal(author.getAttribute("aria-modal"), "true");
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), true);
  f.close(author, true);
  assert(f.stage.hasAttribute("inert"));
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), true);
  f.close(settings);
  assert.equal(f.stage.hasAttribute("inert"), false);
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), false);
  await f.dispose();
}

{
  const f = await fixture();
  const author = f.overlay(true);
  assert.equal(author.getAttribute("aria-modal"), null, "desktop author panels keep their non-modal playback semantics");
  assert.equal(f.stage.hasAttribute("inert"), false);
  assert.equal(f.gallery.classList.contains("is-gallery-timing-paused"), false);
  f.close(author, true);
  await f.dispose();
}

{
  const f = await fixture({ lazy: true });
  const placeholder = f.current(), first = f.overlay(), second = f.overlay();
  const actual = await f.release();
  assert.notEqual(actual, placeholder);
  assert.equal(placeholder.isConnected, false);
  assert.equal(actual.classList.contains("is-gallery-timing-paused"), true);
  const audio = actual.querySelector("audio");
  assert.equal(audio.playCalls, 0);
  f.close(second);
  assert.equal(actual.classList.contains("is-gallery-timing-paused"), true, "all placeholder pause owners must transfer to the mounted gallery");
  f.close(first); await settle();
  assert.equal(actual.classList.contains("is-gallery-timing-paused"), false);
  assert.equal(audio.playCalls, 1, "restoration resolves the captured lazy placeholder and releases exactly its owner");
  await f.dispose();
}

{
  const f = await fixture();
  const modal = f.overlay();
  f.gallery.shortVideoGalleryDispose(); f.gallery.remove();
  const nextVideo = { ...f.video, id: "next-gallery" };
  f.state.shortVideo.current = nextVideo;
  const nextGallery = f.render(nextVideo, { ghost: false, stage: f.stage });
  f.stage.append(nextGallery); f.setCurrent(nextGallery);
  const before = [...f.timers.keys()];
  f.close(modal);
  assert.equal(nextGallery.classList.contains("is-gallery-timing-paused"), false);
  assert.deepEqual([...f.timers.keys()], before, "closing a previous work's modal never resumes or reschedules its replacement gallery");
  await f.dispose();
}

{
  const f = await fixture({ mobile: true });
  const author = f.overlay(true), settings = f.overlay();
  f.gallery.shortVideoGalleryDispose(); f.gallery.remove(); f.stage.remove();
  const nextStage = new Element("div"); f.root.append(nextStage);
  const nextVideo = { ...f.video, id: "direct-replacement", sound };
  f.state.shortVideo.current = nextVideo;
  const next = f.render(nextVideo, { ghost: false, stage: nextStage });
  nextStage.append(next); f.setCurrent(next);
  f.hooks.syncShortVideoModalPlayback(f.root);
  await f.ready(next.querySelector(".short-video-gallery-image")); await f.flushFrames();
  const audio = next.querySelector("audio");
  assert.equal(author._shortVideoPausedGallery, next);
  assert.equal(settings._shortVideoPausedGallery, next);
  assert.equal(next.classList.contains("is-gallery-timing-paused"), true, "a different work acquires all open-modal pause owners before playback starts");
  assert.equal(audio.playCalls, 0, "replacement music cannot start behind an open author modal");
  assert(nextStage.hasAttribute("inert"), "replacement background controls acquire the existing modal isolation");
  assert.equal(f.stage.hasAttribute("inert"), false, "detached backgrounds release stale leases promptly");
  assert.equal(settings.hasAttribute("inert"), false, "reconciliation never disables the top dialog");
  f.hooks.syncShortVideoModalPlayback(f.root);
  assert.equal(audio.playCalls, 0);
  f.close(author, true);
  assert(nextStage.hasAttribute("inert"));
  assert.equal(next.classList.contains("is-gallery-timing-paused"), true);
  f.close(settings); await settle();
  assert.equal(nextStage.hasAttribute("inert"), false);
  assert.equal(next.classList.contains("is-gallery-timing-paused"), false);
  assert.equal(audio.playCalls, 1);
  await f.dispose();
}

{
  const f = await fixture({ mobile: true });
  const author = f.overlay(true), settings = f.overlay();
  f.gallery.shortVideoGalleryDispose(); f.gallery.remove();
  const nextVideo = { ...f.video, id: "lazy-replacement", sound };
  f.state.shortVideo.current = nextVideo;
  const placeholder = f.hooks.renderGalleryPlayer(nextVideo, { ghost: false, stage: f.stage });
  f.stage.append(placeholder); f.setCurrent(placeholder);
  f.hooks.syncShortVideoModalPlayback(f.root);
  assert.equal(placeholder.classList.contains("is-gallery-timing-paused"), true);
  const actual = await f.release();
  assert.notEqual(actual, placeholder);
  assert.equal(actual.classList.contains("is-gallery-timing-paused"), true);
  const audio = actual.querySelector("audio");
  assert.equal(audio.playCalls, 0, "actual lazy mounting retains replacement pause owners before its sound frame");
  assert(f.stage.hasAttribute("inert"));
  assert.equal(settings.hasAttribute("inert"), false);
  f.hooks.syncShortVideoModalPlayback(f.root);
  f.hooks.syncShortVideoModalPlayback(f.root);
  f.close(settings);
  assert.equal(actual.classList.contains("is-gallery-timing-paused"), true);
  f.close(author, true); await settle();
  assert.equal(actual.classList.contains("is-gallery-timing-paused"), false);
  assert.equal(audio.playCalls, 1, "repeated sync and placeholder resolution never duplicate final resumption");
  await f.dispose();
}

delete globalThis.window;
delete globalThis.document;
console.log("short-video-modal-playback: independent owners, close ordering, inert leases, lazy/direct replacement, user intent and handoff passed");

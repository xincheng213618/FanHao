import assert from "node:assert/strict";
import { createShortVideoGalleryPlayer } from "../public/modules/short-videos/gallery-player.js";
import { disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

// The actual gallery runs against controlled DOM, image/media readiness and
// scheduled work. No service, database, browser profile or media is accessed.
class Element extends EventTarget {
  constructor(tag) {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map();
    this.style = { setProperty() {}, removeProperty() {} }; this.className = "";
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const active = force ?? !this.classList.contains(name); this.classList[active ? "add" : "remove"](name); return active; }
    };
    this.paused = true; this.ended = false; this.currentTime = 0; this.readyState = 0; this.autoplay = false;
    this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.playCalls = 0;
    this.decode = async () => {};
    this.play = async () => { this.playCalls++; this.paused = false; this.dispatchEvent(new Event("play")); };
    this.pause = () => { this.paused = true; this.dispatchEvent(new Event("pause")); };
    this.load = () => {};
  }
  get isConnected() { return this.connected || Boolean(this.parent?.isConnected); }
  set src(value) { this.attributes.set("src", value); }
  get src() { return this.attributes.get("src") || ""; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) {
    nodes.forEach(node => {
      node.remove(); node.parent = this; this.children.push(node);
      // Model the native autoplay opportunity when a new audio joins the DOM.
      if (node.tagName === "AUDIO" && node.autoplay && node.isConnected) void node.play();
    });
  }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  closest() { return null; }
  getBoundingClientRect() { return { width: 1280, height: 720 }; }
  querySelectorAll(selector) {
    const matches = node => selector.split(",").some(part => part.trim().startsWith(".")
      ? node.classList.contains(part.trim().slice(1)) : node.tagName.toLowerCase() === part.trim());
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const localSound = { localAvailable: true, previewUrl: "/fixture/sound" };
function fixture({ ghost = false, live = false, count = 3, autoNext = false } = {}) {
  let sequence = 0;
  const timers = new Map(), frames = new Map(), elements = [], watches = [], intents = [], advances = [];
  globalThis.window = {
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id), matchMedia: () => ({ matches: false })
  };
  globalThis.document = { createElement: tag => { const node = new Element(tag); elements.push(node); return node; } };
  const root = new Element("div"), stage = new Element("div"); root.connected = true; root.append(stage);
  const video = { id: "gallery", title: "Fixture", images: Array.from({ length: count }, (_, index) => ({
    type: live ? "video" : "image", url: `/fixture/item/${index}`
  })), ...(live ? { galleryPresentation: "live-photo" } : {}) };
  const state = { shortVideo: { current: video, muted: false } };
  const render = createShortVideoGalleryPlayer({
    api: async () => { throw new Error("unexpected network request"); }, applyVideoOrientation() {}, clearPlayerSoundBlocked() {},
    createIcon: () => new Element("span"), currentShortVideoVolume: () => .5, els: { workGrid: root },
    galleryImageEntries: current => current.images, handleGalleryAutoNext: current => { advances.push(current); return autoNext; },
    isShortVideoGestureClickBlocked: () => false, isShortVideoKeyboardControl: () => false,
    markPlayerSoundBlocked() {}, onGalleryUserPlaybackIntent: current => intents.push(current),
    persistShortVideoWatch: (...args) => watches.push(args), revealShortVideoClearScreen: () => false, setIconButton() {},
    SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS: 200, SHORT_VIDEO_GALLERY_ADVANCE_MS: 4000,
    SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY: "fixture", SHORT_VIDEO_GALLERY_GESTURE_HINT_MS: 2000,
    showBrowserToast() {}, showHeartBurst() {}, state, toggleShortVideoAction() {},
    wasClearScreenJustRevealed: () => false, writeMutedPreference() {}
  });
  const gallery = render(video, { ghost, stage }); stage.append(gallery);
  const flushFrames = async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); await settle(); };
  const ready = async node => {
    node.complete = true; node.naturalWidth = 800; node.naturalHeight = 1200;
    node.readyState = 3; node.videoWidth = 800; node.videoHeight = 1200;
    node.dispatchEvent(new Event(node.tagName === "VIDEO" ? "canplay" : "load")); await settle();
  };
  const readyAll = async () => {
    await ready(gallery.querySelector(".short-video-gallery-image"));
    for (const node of [...elements].filter(node => ["IMG", "VIDEO"].includes(node.tagName))) await ready(node);
  };
  const dispose = async () => { disposeShortVideoMedia(root); await flushFrames(); };
  return { root, stage, video, state, gallery, timers, frames, elements, watches, intents, advances, ready, readyAll, flushFrames, dispose };
}

{
  const f = fixture(); await f.readyAll();
  f.gallery.shortVideoGalleryMove(1); await settle(); f.gallery.shortVideoGalleryMove(1); await settle();
  f.gallery.shortVideoGalleryPause("user");
  const foreground = f.gallery.querySelector(".short-video-gallery-image"), timers = [...f.timers.keys()], intent = f.gallery.dataset.shortVideoPlaybackIntentGeneration;
  assert.equal(f.gallery.dataset.galleryIndex, "2");
  assert.equal(f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: localSound }), true);
  const audio = f.gallery.querySelector("audio");
  assert(audio); assert.equal(audio.autoplay, false); assert.equal(audio.paused, true);
  await f.flushFrames();
  assert.equal(audio.playCalls, 0, "late audio must not start while the gallery is user-paused");
  assert.equal(f.gallery.querySelector(".short-video-gallery-image"), foreground);
  assert.equal(f.gallery.dataset.galleryIndex, "2"); assert.equal(f.gallery.dataset.galleryRequestedIndex, "2");
  assert.equal(f.gallery.shortVideoGalleryIsPaused(), true); assert.equal(f.gallery.dataset.shortVideoPlaybackIntentGeneration, intent);
  assert.deepEqual([...f.timers.keys()], timers, "metadata must not restart advance/animation timers");
  f.gallery.shortVideoGalleryResume("user"); await settle();
  assert.equal(audio.paused, false);
  await f.dispose();
}
for (const reason of ["modal", "visibility"]) {
  const f = fixture(); await f.readyAll(); f.gallery.shortVideoGalleryPause(reason);
  f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: localSound }); await f.flushFrames();
  const audio = f.gallery.querySelector("audio");
  assert.equal(audio.playCalls, 0, `${reason} pause must guard both native and explicit audio playback`);
  f.gallery.shortVideoGalleryResume(reason); await settle();
  assert.equal(audio.paused, false, "new audio deferred during a modal/visibility pause starts once timing is restored");
  await f.dispose();
}
{
  const f = fixture(); await f.readyAll(); f.gallery.shortVideoGalleryPause("modal"); f.gallery.shortVideoGalleryPause("user");
  f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: localSound }); await f.flushFrames();
  const audio = f.gallery.querySelector("audio");
  f.gallery.shortVideoGalleryResume("modal"); await settle();
  assert.equal(audio.playCalls, 0, "closing a modal cannot override a user pause");
  f.gallery.shortVideoGalleryResume("user"); await settle(); assert.equal(audio.playCalls, 1);
  await f.dispose();
}
{
  const f = fixture({ live: true, count: 1 }); await f.readyAll();
  const clip = f.gallery.querySelector("video"); clip.currentTime = 7.25;
  f.gallery.shortVideoGalleryPause("user");
  const ended = clip.onended, timers = [...f.timers.keys()];
  f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: localSound }); await f.flushFrames();
  assert.equal(f.gallery.querySelector("video"), clip); assert.equal(clip.currentTime, 7.25);
  assert.equal(clip.paused, true); assert.equal(clip.onended, ended);
  assert.deepEqual([...f.timers.keys()], timers);
  assert.equal(f.gallery.querySelector("audio").playCalls, 0);
  await f.dispose();
}
{
  const f = fixture({ autoNext: true }); await f.readyAll();
  f.gallery.shortVideoGalleryMove(1); await settle(); f.gallery.shortVideoGalleryMove(1); await settle();
  await f.flushFrames();
  const advance = [...f.timers].find(([, timer]) => timer.delay === 4000);
  assert(advance);
  const watches = f.watches.length, intents = f.intents.length;
  f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: localSound }); await f.flushFrames();
  assert.equal(f.timers.get(advance[0]), advance[1], "late sound preserves the current image's original auto-next deadline");
  assert.equal(f.watches.length, watches); assert.equal(f.intents.length, intents);
  f.timers.delete(advance[0]); advance[1].callback(); await settle();
  assert.equal(f.advances.length, 1); assert.equal(f.gallery.dataset.galleryIndex, "2");
  await f.dispose();
}
{
  const f = fixture(); await f.readyAll();
  assert.equal(f.gallery.shortVideoGalleryUpdateMetadata({ id: "other", sound: localSound }), false);
  assert.equal(f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: { localAvailable: false, previewUrl: "/remote" } }), false);
  assert.equal(f.gallery.querySelector("audio"), null);
  assert.equal(f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: localSound }), true);
  const audio = f.gallery.querySelector("audio"), frames = [...f.frames.keys()];
  assert.equal(f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: { ...localSound, previewUrl: "/fixture/replacement" } }), true);
  assert.equal(f.gallery.querySelectorAll("audio").length, 1); assert.equal(f.gallery.querySelector("audio"), audio);
  assert.equal(audio.src, localSound.previewUrl, "same-id metadata cannot replace an attached audio source");
  assert.deepEqual([...f.frames.keys()], frames, "idempotent metadata does not enqueue playback again");
  await f.dispose();
}
for (const invalidate of [
  f => f.gallery.shortVideoGallerySetActive(false),
  f => f.gallery.shortVideoGalleryDispose(),
  f => f.gallery.remove()
]) {
  const f = fixture(); await f.readyAll(); invalidate(f);
  const elementCount = f.elements.length, sound = f.video.sound;
  assert.equal(f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: localSound }), false);
  assert.equal(f.elements.length, elementCount); assert.equal(f.video.sound, sound);
  assert.equal(f.gallery.querySelector("audio"), null, "ghost/disposed/detached galleries cannot receive late audio");
  await f.dispose();
}
{
  const f = fixture(); await f.readyAll();
  f.gallery.shortVideoGalleryUpdateMetadata({ id: "gallery", sound: localSound });
  const audio = f.gallery.querySelector("audio");
  f.gallery.shortVideoGallerySetActive(false); await f.flushFrames();
  assert.equal(audio.playCalls, 0, "an attachment RAF cannot play music after demotion");
  await f.dispose();
}

delete globalThis.window; delete globalThis.document;
console.log("short-video-gallery-metadata: node/index/pause/live-time/timer retention, deferred audio and ownership passed");

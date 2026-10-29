import assert from "node:assert/strict";
import { createShortVideoGalleryPlayer } from "../public/modules/short-videos/gallery-player.js";
import { disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

// Exercise the real gallery lifecycle with controlled image decoding and media
// promises. No service, database, real media or browser profile is used.
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.style = { setProperty() {}, removeProperty() {} };
    this.className = "";
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const active = force ?? !this.classList.contains(name);
        this.classList[active ? "add" : "remove"](name);
        return active;
      }
    };
    this.paused = true;
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.decode = async () => {};
    this.play = async () => { this.paused = false; };
    this.pause = () => { this.paused = true; };
    this.load = () => {};
  }
  get isConnected() { return this.connected || Boolean(this.parent?.isConnected); }
  set src(value) { this.attributes.set("src", value); }
  get src() { return this.attributes.get("src") || ""; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { nodes.forEach((node) => { node.remove(); node.parent = this; this.children.push(node); }); }
  replaceChildren(...nodes) { this.children.forEach((node) => { node.parent = null; }); this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = null; }
  closest() { return null; }
  getBoundingClientRect() { return { width: 1280, height: 720 }; }
  querySelectorAll(selector) {
    const matches = (node) => selector.split(",").some((part) => part.trim().startsWith(".")
      ? node.classList.contains(part.trim().slice(1))
      : node.tagName.toLowerCase() === part.trim());
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture({ ghost = true, count = 5, firstVideo = false } = {}) {
  const timers = new Map(), frames = new Map(), elements = [], watches = [], intents = [];
  let clock = 0;
  globalThis.window = {
    setTimeout: (callback, delay) => { const id = ++clock; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => { const id = ++clock; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    matchMedia: () => ({ matches: false })
  };
  globalThis.document = { createElement: (tag) => { const element = new Element(tag); elements.push(element); return element; } };
  const root = new Element("div");
  root.connected = true;
  const stage = new Element("div");
  root.append(stage);
  const video = {
    id: "gallery-fixture", title: "Gallery fixture",
    sound: { localAvailable: true, previewUrl: "/fixture/audio" },
    images: Array.from({ length: count }, (_, index) => ({ type: "image", url: `/fixture/image/${index}` }))
  };
  if (firstVideo) video.images[0] = { type: "video", url: "/fixture/clip", posterUrl: "/fixture/poster" };
  const render = createShortVideoGalleryPlayer({
    api: async () => { throw new Error("unexpected network request"); },
    applyVideoOrientation() {}, clearPlayerSoundBlocked() {},
    createIcon: () => new Element("span"), currentShortVideoVolume: () => 0.5,
    els: { workGrid: root }, galleryImageEntries: (item) => item.images,
    handleGalleryAutoNext: () => false, isShortVideoGestureClickBlocked: () => false,
    onGalleryUserPlaybackIntent: (gallery) => intents.push(gallery),
    isShortVideoKeyboardControl: () => false, markPlayerSoundBlocked() {},
    persistShortVideoWatch: (...args) => watches.push(args), revealShortVideoClearScreen: () => false,
    setIconButton() {}, SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS: 200, SHORT_VIDEO_GALLERY_ADVANCE_MS: 4000,
    SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY: "fixture", SHORT_VIDEO_GALLERY_GESTURE_HINT_MS: 2000,
    showBrowserToast() {}, showHeartBurst() {}, state: { shortVideo: { current: video, muted: false } },
    toggleShortVideoAction() {}, wasClearScreenJustRevealed: () => false, writeMutedPreference() {}
  });
  const gallery = render(video, { ghost, stage });
  stage.append(gallery);
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()); };
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const load = async (image) => {
    image.complete = true; image.naturalWidth = 800; image.naturalHeight = 1200;
    image.dispatchEvent(new Event("load"));
    await tick();
  };
  return { root, gallery, video, timers, elements, watches, intents, flushFrames, tick, load };
}

{
  const f = fixture();
  const image = f.gallery.querySelector(".short-video-gallery-image");
  assert.deepEqual(f.elements.filter((e) => e.tagName === "IMG").map((e) => e.src), ["/fixture/image/0"], "a preview prepares only its first image");
  await f.load(image);
  assert.equal(await f.gallery.shortVideoGalleryReady, true);
  f.flushFrames();
  assert.equal(f.watches.length, 0, "preview loading must not count as watching");
  assert.equal(f.gallery.querySelector("audio"), null);
  assert(![...f.timers.values()].some((timer) => timer.delay === 4000), "previews must not auto advance");
  f.gallery.shortVideoGallerySetActive(true);
  f.flushFrames(); await f.tick();
  const audio = f.gallery.querySelector("audio");
  assert.equal(f.gallery.querySelector(".short-video-gallery-image"), image, "promotion must retain the decoded foreground node");
  assert.equal(f.watches.length, 1);
  assert.equal(audio.paused, false);
  assert.equal(audio.muted, false);
  assert.equal(f.elements.filter((e) => e.tagName === "IMG").length, 5, "active galleries can prefetch nearby images");
  f.gallery.shortVideoGallerySetActive(false);
  assert.equal(audio.paused, true);
  assert.equal(audio.muted, true);
  assert(![...f.timers.values()].some((timer) => timer.delay === 4000), "demotion cancels auto advance");
  f.gallery.shortVideoGallerySetActive(true);
  f.flushFrames(); await f.tick();
  assert.equal(f.gallery.querySelector(".short-video-gallery-image"), image, "reverse navigation also reuses the foreground");
  assert.equal(audio.paused, false);
  disposeShortVideoMedia(f.root);
  f.flushFrames(); await f.tick();
  assert.equal(audio.src, "");
  assert(f.elements.filter((e) => e.tagName === "IMG").every((e) => !e.src), "disposal releases active and pending images");
  assert.equal(f.timers.size, 0, "disposed galleries must leave no scheduled work");
}

{
  const f = fixture();
  const image = f.gallery.querySelector(".short-video-gallery-image");
  let resolveDecode;
  image.decode = () => new Promise((resolve) => { resolveDecode = resolve; });
  await f.load(image);
  f.gallery.shortVideoGalleryDispose();
  resolveDecode(); await f.tick();
  assert.equal(await f.gallery.shortVideoGalleryReady, false, "late decode cannot revive a disposed preview");
  assert.equal(image.src, "");
  assert.equal(f.watches.length, 0);
  assert.equal(f.timers.size, 0);
}

{
  const f = fixture({ count: 1, firstVideo: true });
  const clip = f.gallery.querySelector("video");
  assert.equal(clip.preload, "metadata", "a live-photo preview must not start playback");
  const ready = f.gallery.shortVideoGalleryPrepare();
  assert.equal(clip.preload, "auto", "explicit navigation must finish preparing a live-photo clip");
  clip.readyState = 3;
  clip.videoWidth = 800; clip.videoHeight = 1200;
  clip.dispatchEvent(new Event("canplay")); await f.tick();
  assert.equal(await ready, true);
  assert.equal(clip.paused, true);
  f.gallery.shortVideoGallerySetActive(true); await f.tick();
  assert.equal(clip.paused, false, "only the active live-photo clip starts playing");
  f.gallery.shortVideoGallerySetActive(false);
  assert.equal(clip.paused, true);
  disposeShortVideoMedia(f.root);
  assert.equal(f.timers.size, 0);
}

{
  const f = fixture();
  await f.load(f.gallery.querySelector(".short-video-gallery-image"));
  f.gallery.shortVideoGallerySetActive(true);
  const audio = f.gallery.querySelector("audio");
  let rejectPlay, attempts = 0;
  audio.play = () => { attempts += 1; return new Promise((_, reject) => { rejectPlay = reject; }); };
  f.flushFrames();
  f.gallery.shortVideoGallerySetActive(false);
  rejectPlay(new Error("late autoplay rejection")); await f.tick();
  assert.equal(attempts, 1, "a late play rejection after demotion must not restart background music");
  assert.equal(audio.paused, true);
  disposeShortVideoMedia(f.root);
}

{
  const f = fixture({ ghost: false, count: 2 });
  await f.load(f.gallery.querySelector(".short-video-gallery-image"));
  f.flushFrames(); await f.tick();
  f.gallery.shortVideoGalleryPause("user");
  f.gallery.shortVideoGalleryResume("user");
  assert.equal(f.intents.length, 2, "manual pause/resume must invalidate a pending post-level auto-next request");
  assert.equal(f.gallery.dataset.shortVideoPlaybackIntentGeneration, "2");
  f.gallery.shortVideoGalleryPause("modal");
  const timersBeforeResume = new Set(f.timers.keys());
  f.gallery.shortVideoGalleryResume("modal");
  assert.equal(f.intents.length, 2, "modal timing restoration is not a new user playback action");
  const advance = [...f.timers.entries()].find(([id]) => !timersBeforeResume.has(id));
  assert(advance, "the active gallery must still schedule ordinary image advancement");
  f.timers.delete(advance[0]); advance[1].callback(); await f.tick();
  assert.equal(f.intents.length, 2, "automatic image advancement must not masquerade as manual navigation");
  f.gallery.shortVideoGalleryMove(-1);
  assert.equal(f.intents.length, 3, "manual image navigation must cancel a pending auto-next even while media is loading");
  assert(f.intents.every((gallery) => gallery === f.gallery));
  disposeShortVideoMedia(f.root);
}

delete globalThis.window;
delete globalThis.document;
console.log("short-video-gallery-handoff: preview budget, node reuse, sound, timers, late decode/play and disposal passed");

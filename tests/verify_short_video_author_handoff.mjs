import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoInteractionState } from "../public/modules/short-videos/interaction-state.js";
import { runShortVideoRead } from "../public/modules/short-videos/read-request.js";

// Execute the current author switch/renderer and the page's shared navigation,
// hydration and playback bridge. Details, frames, transitions and play promises
// have independent gates. No browser, real media or database is involved.
const pageSource = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const authorSource = fs.readFileSync(new URL("../public/modules/short-videos/author-panel.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function sourceFunction(source, name, required = true) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  if (!match && !required) return "";
  assert(match, `missing current function: ${name}`);
  const end = source.indexOf("\n  }", match.index);
  assert(end > match.index, `missing function boundary: ${name}`);
  return source.slice(match.index, end + 4);
}
const implementation = [
  pageSource.slice(pageSource.indexOf("  function hasShortVideoBrowseOverlay("), pageSource.indexOf("  function installBrowseEvents(")),
  ...["shortVideoNavigationScope", "cancelShortVideoNavigation", "beginShortVideoNavigation", "isCurrentShortVideoNavigation",
    "hydratePromotedShortVideo", "resumeActiveSound", "flushActiveShortVideoWatch", "restoreAuthorPanelFeed", "syncActiveControlBar",
    "captureShortVideoPlaybackOwner", "ownsShortVideoPlaybackOwner", "stopShortVideoSoundPreview"].map(name => sourceFunction(pageSource, name)),
  sourceFunction(pageSource, "beginShortVideoPanelNavigation"),
  ...["isCurrentPanel", "replaceVideoFromAuthorPanel", "replaceCurrentReelDom", "isCurrentShortVideo", "openRelatedVideo"].map(name => sourceFunction(authorSource, name)),
  ...["refreshAuthorPanelNavigation", "switchToAuthorWorksFeed", "authorScopeId", "enterShortVideoSoundFeed", "enterShortVideoTopicFeed"].map(name => sourceFunction(authorSource, name, false))
].join("\n");

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let index = 0; index < 24; index++) await Promise.resolve(); }
function observe(promise) { const result = { status: "pending" }; Promise.resolve(promise).then(value => { result.status = "fulfilled"; result.value = value; }, error => { result.status = "rejected"; result.error = error; }); return result; }

function fixture({ reducedMotion = true } = {}) {
  let handle = 0, authorRequest = 0;
  const calls = [], details = [], adjacent = [], frames = new Map(), timers = new Map(), errors = [];
  const videos = new Map(["A", "B", "C", "D"].map(id => [id, { id, title: `${id} cached`, watch: { progressMs: 0, completed: false } }]));
  const state = { activeView: "shortVideos", shortVideo: {
    current: videos.get("A"), mode: "feed", collectionId: "", author: "all", source: "liked", query: "", topic: "", sound: "",
    deleted: "all", authorAccountStatus: "all", muted: false, playbackRate: 1, prevId: "", nextId: "", prevVideo: null, nextVideo: null
  } };
  const panel = { isConnected: true, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } };
  function node(video, ghost = false) {
    const classes = new Set(["short-video-reel-panel", ghost ? "is-ghost-panel" : "is-current", ...(video.gallery ? ["is-gallery-post"] : [])]);
    const listeners = new Map();
    const element = {
      dataset: { videoId: video.id }, isConnected: false, parentNode: null, classes,
      classList: { contains: value => classes.has(value), add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)),
        toggle(value, force) { if (force ?? !classes.has(value)) classes.add(value); else classes.delete(value); } },
      addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); },
      querySelector(selector) {
        if (selector.includes("short-video-gallery-player")) return this.gallery || null;
        if (selector.includes("short-video-gallery-audio")) return this.audio || null;
        if (selector.includes("short-video-player")) return this.player || null;
        return null;
      }, querySelectorAll: () => [], removeAttribute() {}, setAttribute() {},
      remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(value => value !== this); },
      cloneNode() { const copy = node(video, ghost); copy.classes.clear(); classes.forEach(value => copy.classes.add(value)); return copy; }
    };
    if (video.gallery) {
      element.gallery = { isConnected: false, dataset: { videoId: video.id, galleryIndex: "2" }, paused: false,
        shortVideoGalleryPlaySound() { calls.push({ name: "gallery-play", id: video.id }); this.paused = false; },
        shortVideoGalleryIsPaused() { return this.paused; },
        shortVideoGalleryUpdateMetadata(next) { calls.push({ name: "gallery-metadata", id: video.id, next }); return true; }
      };
    } else {
      const playerClasses = new Set(ghost ? ["is-ghost"] : []);
      const player = { isConnected: false, paused: true, ended: false, currentTime: 0, readyState: 4, muted: true, volume: 0.5,
        dataset: { videoId: video.id, shortVideoSlot: ghost ? "next" : "current", shortVideoSourceGeneration: "1", shortVideoPlaybackIntentGeneration: "0" },
        classList: { contains: value => playerClasses.has(value) },
        source: `/fixture/${video.id}`, currentSrc: `/fixture/${video.id}`, playResult: null,
        getAttribute(name) { return name === "src" ? this.source : null; },
        closest: () => element,
        shortVideoSetPlaybackIntent(playing) { this.dataset.shortVideoPlaybackIntentGeneration = String(Number(this.dataset.shortVideoPlaybackIntentGeneration) + 1); this.dataset.shortVideoExplicitPlaybackIntent = playing ? "play" : "pause"; },
        shortVideoFlushWatch() { calls.push({ name: "save", id: state.shortVideo.current?.id, playerId: video.id, time: this.currentTime }); return true; },
        shortVideoUpdateWatchMetadata(next) { calls.push({ name: "metadata", id: video.id, next }); },
        pause() { this.paused = true; },
        play() { calls.push({ name: "play", id: video.id, player: this }); this.paused = false; return this.playResult?.promise || Promise.resolve(); }
      };
      element.player = player;
    }
    return element;
  }
  const stack = { isConnected: true, children: [], classes: new Set(), _shortVideoDirectTransitionTimer: 0,
    classList: { add: (...values) => values.forEach(value => stack.classes.add(value)), remove: (...values) => values.forEach(value => stack.classes.delete(value)), contains: value => stack.classes.has(value) },
    style: { setProperty() {} },
    querySelector(selector) { return this.children.find(value => selector.includes("is-current") ? value.classes.has("is-current") : selector.includes("is-next") ? value.classes.has("is-next") : selector.includes("is-prev") ? value.classes.has("is-prev") : false) || null; },
    querySelectorAll(selector) { return selector.includes("is-transition-outgoing") ? this.children.filter(value => value.classes.has("is-transition-outgoing")) : []; },
    replaceChildren(...children) {
      this.children.forEach(value => { value.isConnected = false; if (value.player) value.player.isConnected = false; if (value.gallery) value.gallery.isConnected = false; });
      this.children = []; this.append(...children);
    },
    append(...children) { children.forEach(value => { value.parentNode = this; value.isConnected = true; if (value.player) value.player.isConnected = true; if (value.gallery) value.gallery.isConnected = true; this.children.push(value); }); }
  };
  const currentPanel = () => stack.querySelector(".short-video-reel-panel.is-current");
  const activePlayer = () => currentPanel()?.player || null;
  const activeGalleryPlayer = () => currentPanel()?.gallery || null;
  let controlBar;
  const makeBar = gallery => ({ gallery,
    classList: { contains: name => name === "is-gallery" && gallery },
    shortVideoDispose: () => calls.push({ name: "dispose-bar", gallery }),
    shortVideoSync: () => calls.push({ name: "sync-bar", gallery }),
    replaceWith(next) { controlBar = next; calls.push({ name: "replace-bar", gallery: next.gallery }); }
  });
  controlBar = makeBar(false);
  stack.append(node(videos.get("A"))); activePlayer().currentTime = 21.5; activePlayer().paused = false;
  const requestDetail = (kind, id) => { const request = { ...deferred(), kind, id, settled: false }; details.push(request); return request.promise; };
  const env = vm.createContext({
    state, Date, Promise, URLSearchParams, AbortController, runShortVideoRead,
    shortVideoInteractionState: createShortVideoInteractionState(),
    console: { warn: error => errors.push(error) },
    shortVideoOpenRequestId: 0, shortVideoAdjacentRequestId: 0, shortVideoNavigationState: null, shortVideoOpeningId: "", shortVideoOpenError: "", shortVideoOpenReadController: null,
    shortVideoSoundPreviewAudio: null,
    shortVideoPlaybackLifecycleGeneration: 0, shortVideoPageSuspended: false,
    syncShortVideoModalPlayback() {}, cancelShortVideoPanelLoading() {},
    syncShortVideoNativePlaybackModes() {},
    shortVideoWatchWriteController: null, shortVideoWheelController: null, queuedAdjacentDirection: 0, wheelLocked: false,
    authorPanelReturnFeed: null,
    touchGestureOwner: null, pointerGestureOwner: null, reelDragOwner: null,
    touchIdentifier: null, pointerIdentifier: null, touchBlockedUntilLift: false,
    document: { hidden: false, querySelector: () => null },
    window: { requestAnimationFrame(callback) { const id = ++handle; frames.set(id, callback); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
      setTimeout(callback, delay) { const id = ++handle; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
      matchMedia: () => ({ matches: reducedMotion }) },
    els: { workGrid: { querySelector: selector => selector === ".short-video-control-bar" ? controlBar : selector.includes("is-current") ? currentPanel() : selector.includes("short-video-author-panel") && panel.isConnected ? panel : null } },
    activePlayer, activeGalleryPlayer, activeReelStack: () => stack,
    nextAuthorPanelVideoRequestId: () => ++authorRequest, currentAuthorPanelVideoRequestId: () => authorRequest,
    fetchShortVideoDetail: id => requestDetail("author", id), contextualShortVideoDetail: id => requestDetail("page", id),
    resolvedShortVideoDetail: () => null,
    shortVideoFeedParams: () => new URLSearchParams({ author: state.shortVideo.author, source: state.shortVideo.source, query: state.shortVideo.query, sound: state.shortVideo.sound, topic: state.shortVideo.topic }).toString(),
    isGalleryPost: video => Boolean(video?.gallery), currentShortVideoVolume: () => 0.5,
    cacheAuthorPanelVideo: video => calls.push({ name: "cache", id: video.id, video }), cachedShortVideo: id => videos.get(String(id)) || null,
    collectionsController: { collectionNavigation: () => null },
    loadAdjacentVideos: async (id, owner) => { adjacent.push({ id, owner }); return true; },
    refreshAdjacentPanelsDom: () => calls.push({ name: "refresh-neighbors", id: state.shortVideo.current?.id }),
    syncAuthorPanelCurrentTile: () => calls.push({ name: "sync-author", id: state.shortVideo.current?.id }),
    syncRelatedPanelCurrentItem: () => calls.push({ name: "sync-related", id: state.shortVideo.current?.id }),
    syncCurrentNavigationDom() {}, syncShortVideoBrowserSearchDom() {}, syncActiveControlBar() {},
    replaceRoute: route => calls.push({ name: "route", id: route.shortVideoId }),
    flushQueuedAdjacent() {}, flushShortVideoAutoNext() {}, cancelShortVideoAutoNext() {}, cancelShortVideoBrowseGestures() {},
    clearPendingPlayerClick() {}, closeTransientPlayerControls() {}, cancelAuthorCollectorPolling() {}, markShortVideoPerformance() {}, cancelReelDragDelta() {},
    setAuthorPanelReturnFeed() {}, clearShortVideoDeleteSelection() {}, isShortVideoAuthorDetailPage: () => false,
    normalizeShortVideoSound: value => String(value || ""), normalizeShortVideoTopic: value => String(value || "").replace(/^#/, ""), normalizeShortVideoSortValue: value => value,
    closeAuthorPanel: () => { panel.isConnected = false; authorRequest += 1; }, renderStats: () => calls.push({ name: "stats" }),
    applyShortVideoFeedSnapshot(snapshot) { Object.assign(state.shortVideo, snapshot); state.shortVideo.data = null; calls.push({ name: "restore-feed", snapshot }); },
    renderGalleryControlBar: () => { calls.push({ name: "create-bar", gallery: true }); return makeBar(true); },
    renderControlBar: () => { calls.push({ name: "create-bar", gallery: false }); return makeBar(false); },
    markPlayerSoundBlocked: () => calls.push({ name: "sound-blocked" }),
    showBrowserToast: message => calls.push({ name: "toast", message }), showError: error => errors.push(error),
    persistShortVideoWatch: (video, player, options) => { assert(video.gallery && !player && options.completed, "video must use its guarded watch flush"); calls.push({ name: "save", id: video.id, playerId: "gallery", time: 0 }); },
    disposeShortVideoMedia: target => { calls.push({ name: "dispose", id: state.shortVideo.current?.id }); target.children.forEach(value => value.player?.pause()); },
    setReelPanelInteractionState() {},
    renderReelPanel(video, options = {}) { calls.push({ name: "render", id: video.id, ghost: Boolean(options.ghost) }); const panel = node(video, options.ghost); if (options.slot) panel.classes.add(`is-${options.slot}`); return { panel, player: panel.player || null, syncPlayToggle: () => calls.push({ name: "sync-play", id: video.id }) }; }
  });
  vm.runInContext(`${implementation}\nglobalThis.handoff = { replaceVideoFromAuthorPanel, hydratePromotedShortVideo, beginShortVideoNavigation, resumeActiveSound, restoreAuthorPanelFeed, enterShortVideoSoundFeed, enterShortVideoTopicFeed, switchToAuthorWorksFeed };`, env);
  env.handoff.beginShortVideoNavigation(state.shortVideo.current, { prevKnown: true, nextKnown: true, pending: false });
  return { state, calls, details, adjacent, frames, timers, errors, videos, panel, stack, env, activePlayer, activeGalleryPlayer,
    open: (id, neighbors = {}) => observe(env.handoff.replaceVideoFromAuthorPanel(typeof id === "string" ? videos.get(id) : id, panel, neighbors)),
    pause() { const player = activePlayer(); if (player) { player.shortVideoSetPlaybackIntent(false); player.pause(); } else if (activeGalleryPlayer()) activeGalleryPlayer().paused = true; },
    closePanel() { panel.isConnected = false; authorRequest += 1; },
    async raf() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); await settle(); },
    resolve(request, detail = {}) { request.settled = true; request.resolve({ video: { ...videos.get(request.id), title: `${request.id} detail`, ...detail.video }, prevId: "", nextId: "", ...detail }); },
    owner: () => env.shortVideoNavigationState,
    bar: () => controlBar
  };
}

{
  const f = fixture();
  const opening = f.open("B"); await settle();
  assert.deepEqual(f.calls.filter(call => call.name === "save").map(call => [call.id, call.playerId, call.time]), [["A", "A", 21.5]], "author direct switches flush the outgoing work before changing state");
  assert.equal(f.state.shortVideo.current.id, "B");
  assert.equal(f.owner()?.id, "B", "direct author navigation must own the new current video's shared navigation");
  await f.raf(); f.pause();
  const playCount = f.calls.filter(call => call.name === "play").length;
  f.resolve(f.details.at(-1), { video: { id: "B", watch: { progressMs: 7000 } }, nextId: "C" });
  await settle(); await f.raf();
  assert.equal(opening.status, "fulfilled");
  assert.equal(f.activePlayer().paused, true, "late detail hydration cannot reverse a user pause");
  assert.equal(f.calls.filter(call => call.name === "play").length, playCount);
  assert.equal(f.calls.filter(call => call.name === "metadata").at(-1)?.next.watch.progressMs, 7000, "accepted metadata still reaches the current resume controller");
}

{
  const f = fixture();
  f.open("B"); await settle();
  const player = f.activePlayer(); f.pause();
  await f.raf();
  assert.equal(player.paused, true, "a queued initial play callback cannot undo a pause made before the frame");
  assert.equal(f.calls.filter(call => call.name === "play" && call.id === "B").length, 0);
}

{
  const f = fixture();
  f.open("B"); await settle(); const oldPlayer = f.activePlayer();
  f.open("C"); await settle();
  await f.raf();
  assert.equal(f.calls.filter(call => call.name === "play" && call.player === oldPlayer).length, 0, "a queued callback cannot play a detached author item");
  assert.equal(f.calls.filter(call => call.name === "play" && call.id === "C").length, 1, "the newest author handoff starts once");
}

for (const takeover of ["pause", "replacement"]) {
  const f = fixture(); f.open("B"); await settle();
  const player = f.activePlayer(); player.playResult = deferred();
  await f.raf();
  assert.equal(f.calls.filter(call => call.name === "play" && call.id === "B").length, 1);
  if (takeover === "pause") f.pause(); else { f.open("C"); await settle(); }
  player.playResult.reject(new Error("late blocked play")); await settle();
  assert.equal(f.calls.filter(call => call.name === "play" && call.id === "B").length, 1, `${takeover}: a rejected old play request cannot retry after intent or ownership changes`);
  assert.equal(f.calls.filter(call => call.name === "sound-blocked").length, 0, "late rejection cannot add stale blocked-sound feedback");
}

{
  const f = fixture(); f.open("B"); await settle();
  f.closePanel();
  f.resolve(f.details.at(-1), { nextId: "C" }); await settle();
  assert.equal(f.state.shortVideo.current.id, "B");
  assert.equal(f.state.shortVideo.nextId, "C", "closing the author sheet must not discard the current work's pending navigation metadata");
  assert.equal(f.owner().status, "ready");
}

{
  const f = fixture();
  const oldOwner = f.owner();
  const oldHydration = observe(f.env.handoff.hydratePromotedShortVideo(f.state.shortVideo.current, oldOwner)); await settle();
  const oldDetail = f.details.at(-1);
  f.open("B"); await settle(); f.open({ ...f.videos.get("A"), title: "A newest handoff" }); await settle();
  const currentOwner = f.owner();
  assert.notEqual(currentOwner, oldOwner, "A→B→A creates a fresh owner even when the video id repeats");
  f.resolve(oldDetail, { video: { id: "A", title: "stale A detail", watch: { progressMs: 1000 } }, nextId: "stale-next" }); await settle();
  assert.equal(oldHydration.value, false);
  assert.equal(f.state.shortVideo.current.title, "A newest handoff", "old same-id hydration cannot overwrite a later A handoff");
  assert.notEqual(f.state.shortVideo.nextId, "stale-next");
  assert.equal(f.owner(), currentOwner);
}

{
  const f = fixture(); f.open("B"); await settle(); const old = f.details.at(-1);
  f.open("C"); await settle();
  f.resolve(old, { video: { id: "B", watch: { progressMs: 19000 } }, nextId: "D" }); await settle();
  assert.equal(f.state.shortVideo.current.id, "C");
  assert(!f.calls.some(call => call.name === "metadata" && call.id === "B"), "obsolete author metadata cannot reach a replacement player's resume controller");
}

{
  const f = fixture();
  f.open({ id: "B", title: "gallery cached", gallery: true, watch: { progressMs: 0 } }); await settle(); await f.raf();
  const gallery = f.activeGalleryPlayer(); gallery.dataset.galleryIndex = "2"; f.pause();
  const rendered = f.calls.filter(call => call.name === "render").length;
  f.resolve(f.details.at(-1), { video: { id: "B", gallery: true, sound: { localAvailable: true, previewUrl: "/fixture/music" } }, nextId: "C" });
  await settle(); await f.raf();
  assert.equal(f.activeGalleryPlayer(), gallery, "late gallery sound metadata must not rebuild the active gallery");
  assert.equal(gallery.dataset.galleryIndex, "2"); assert.equal(gallery.paused, true);
  assert.equal(f.calls.filter(call => call.name === "render").length, rendered);
  assert(f.calls.some(call => call.name === "gallery-metadata" && call.id === "B"), "late gallery sound reaches the current gallery metadata adapter");
}

for (const kind of ["sound", "topic", "author"]) {
  const f = fixture(); f.pause(); const player = f.activePlayer(), oldOwner = f.owner();
  f.state.shortVideo.prevId = "old-prev"; f.state.shortVideo.nextId = "old-next";
  const work = kind === "sound" ? f.env.handoff.enterShortVideoSoundFeed({ key: "sound-key" }, f.state.shortVideo.current, f.panel)
    : kind === "topic" ? f.env.handoff.enterShortVideoTopicFeed("topic-key", f.state.shortVideo.current, f.panel)
      : f.env.handoff.switchToAuthorWorksFeed(f.state.shortVideo.current, { secUid: "author-key" }, f.panel, "published");
  const result = observe(work); await settle();
  assert.notEqual(f.owner(), oldOwner, `${kind}: same-item filter changes receive a new shared navigation owner`);
  assert.equal(f.state.shortVideo.prevId, ""); assert.equal(f.state.shortVideo.nextId, "", "old-scope neighbors cannot be reused as seeds");
  f.resolve(f.details.at(-1), { video: { ...f.videos.get("A"), title: `${kind} scope` }, nextId: "D" }); await settle(); await f.raf();
  assert.equal(result.status, "fulfilled"); assert.equal(f.activePlayer(), player);
  assert.equal(player.paused, true); assert.equal(player.currentTime, 21.5);
  assert.equal(f.calls.filter(call => call.name === "render" || call.name === "play").length, 0, `${kind}: changing scope preserves the current media and its pause`);
}

{
  const f = fixture({ reducedMotion: false });
  f.open("B"); await settle(); const oldTimer = f.stack._shortVideoDirectTransitionTimer, oldCallback = f.timers.get(oldTimer).callback;
  f.open("C"); await settle(); const currentTimer = f.stack._shortVideoDirectTransitionTimer;
  assert.notEqual(currentTimer, oldTimer);
  oldCallback();
  assert.equal(f.stack._shortVideoDirectTransitionTimer, currentTimer, "a late old crossfade cannot clear the latest transition timer");
  assert(f.timers.has(currentTimer)); assert(f.stack.classes.has("is-direct-switching"));
  assert(f.stack.querySelector(".short-video-reel-panel.is-current").classes.has("is-transition-incoming"));
}

{
  const f = fixture(); f.pause(); const player = f.activePlayer(), oldOwner = f.owner();
  f.state.shortVideo.author = "panel-author";
  f.state.shortVideo.prevId = "old-prev"; f.state.shortVideo.nextId = "old-next";
  f.state.shortVideo.prevVideo = { id: "old-prev" }; f.state.shortVideo.nextVideo = { id: "old-next" };
  f.env.authorPanelReturnFeed = { author: "all", source: "liked", query: "restored feed", sound: "", topic: "" };
  const restoring = observe(f.env.handoff.restoreAuthorPanelFeed()); await settle();
  assert.notEqual(f.owner(), oldOwner, "restoring the previous feed creates a fresh navigation owner");
  assert.equal(f.state.shortVideo.author, "all"); assert.equal(f.state.shortVideo.query, "restored feed");
  assert.equal(f.state.shortVideo.prevId, ""); assert.equal(f.state.shortVideo.nextId, "");
  assert.equal(f.state.shortVideo.prevVideo, null); assert.equal(f.state.shortVideo.nextVideo, null, "panel-scope neighbors are not reused in the restored scope");
  f.resolve(f.details.at(-1), { video: { ...f.videos.get("A"), title: "restored A" }, nextId: "D" }); await settle(); await f.raf();
  assert.equal(restoring.status, "fulfilled"); assert.equal(f.owner().status, "ready");
  assert.equal(f.state.shortVideo.nextId, "D"); assert.equal(f.activePlayer(), player);
  assert.equal(player.paused, true); assert.equal(player.currentTime, 21.5);
  assert(!f.calls.some(call => call.name === "render" || call.name === "play"), "restoring the feed preserves the current DOM, position and pause");
}

{
  const f = fixture();
  f.env.authorPanelReturnFeed = { author: "all", source: "liked", query: "restored feed" };
  const restoring = observe(f.env.handoff.restoreAuthorPanelFeed()); await settle(); const oldDetail = f.details.at(-1);
  f.open("B"); await settle(); f.open({ ...f.videos.get("A"), title: "A after another handoff" }); await settle();
  const currentOwner = f.owner(), newDetail = f.details.at(-1);
  f.resolve(newDetail, { video: { ...f.videos.get("A"), title: "A accepted latest" }, nextId: "C" }); await settle();
  const routes = f.calls.filter(call => call.name === "route").length;
  f.resolve(oldDetail, { video: { id: "A", title: "A obsolete feed return" }, nextId: "stale-next" }); await settle();
  assert.equal(restoring.status, "fulfilled"); assert.equal(f.owner(), currentOwner);
  assert.equal(f.state.shortVideo.current.title, "A accepted latest"); assert.equal(f.state.shortVideo.nextId, "C");
  assert.equal(f.calls.filter(call => call.name === "route").length, routes, "an ABA return-to-feed completion cannot write a route after another handoff");
}

for (const muted of [false, true]) {
  const f = fixture(); f.state.shortVideo.muted = muted;
  f.open({ id: "B", gallery: true, title: "gallery", watch: { progressMs: 0 } }); await settle();
  assert.equal(f.bar().gallery, true, "video→gallery handoff replaces the control-bar type");
  f.open("C"); await settle();
  assert.equal(f.bar().gallery, false, "gallery→video handoff restores video controls");
  assert.deepEqual(f.calls.filter(call => call.name === "replace-bar").map(call => call.gallery), [true, false]);
  assert.deepEqual(f.calls.filter(call => call.name === "dispose-bar").map(call => call.gallery), [false, true]);
  assert.deepEqual(f.calls.filter(call => call.name === "sync-bar").map(call => call.gallery), [true, false], "new control bars are synchronized even when sound is muted");
  if (muted) { await f.raf(); assert(!f.calls.some(call => call.name === "play" || call.name === "gallery-play")); }
}

{
  const f = fixture(); const opening = f.open("B"); await settle(); await f.raf(); f.pause();
  f.details.at(-1).reject(new Error("current author detail unavailable")); await settle();
  assert.equal(opening.status, "fulfilled"); assert.equal(opening.value, false);
  assert.equal(f.owner().status, "error"); assert.equal(f.panel.attributes["aria-busy"], undefined);
  const plays = f.calls.filter(call => call.name === "play").length;
  const retry = observe(f.env.handoff.hydratePromotedShortVideo(f.state.shortVideo.current, f.owner())); await settle();
  f.resolve(f.details.at(-1), { video: { ...f.videos.get("B"), watch: { progressMs: 9000 } }, nextId: "C" }); await settle(); await f.raf();
  assert.equal(retry.value, true); assert.equal(f.owner().status, "ready");
  assert.equal(f.activePlayer().paused, true); assert.equal(f.calls.filter(call => call.name === "play").length, plays, "a detail retry repairs navigation without restarting paused playback");
}

{
  const f = fixture(); f.open("B"); await settle(); const old = f.details.at(-1);
  f.open("C"); await settle(); const current = f.details.at(-1);
  old.reject(new Error("obsolete B failure")); await settle();
  assert.equal(f.owner().id, "C"); assert.equal(f.owner().status, "pending");
  assert.equal(f.panel.attributes["aria-busy"], "true", "an old failure cannot clear a newer author request's busy state");
  assert(!f.calls.some(call => call.name === "toast"), "obsolete failures do not surface current-work notices");
  f.resolve(current); await settle();
  assert.equal(f.panel.attributes["aria-busy"], undefined);
}

console.log("short-video-author-handoff: shared navigation ownership, guarded hydration and playback handoff passed");

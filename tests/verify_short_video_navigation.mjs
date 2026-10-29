import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoInteractionState } from "../public/modules/short-videos/interaction-state.js";
import { runShortVideoRead } from "../public/modules/short-videos/read-request.js";

// Run the current page's navigation ownership, hydration and dispatch code.
// Detail/adjacent requests and animations have independent gates, so these
// cases do not depend on a service, SQLite, real media or elapsed wall time.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ownerStart = source.indexOf("  function shortVideoNavigationScope(");
const ownerEnd = source.indexOf("  function adjacentPlayer(", ownerStart);
assert(ownerStart >= 0 && ownerEnd > ownerStart);
function sourceFunction(text, name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(text);
  assert(match, `missing current page function: ${name}`);
  const end = text.indexOf("\n  }", match.index);
  assert(end > match.index, `missing function boundary: ${name}`);
  return text.slice(match.index, end + 4);
}
const implementation = [source.slice(ownerStart, ownerEnd), ...[
  "promoteAdjacentMedia", "hydratePromotedShortVideo", "loadAdjacentVideos",
  "syncCurrentNavigationDom", "renderBrowserNav", "showHome"
].map((name) => sourceFunction(source, name))].join("\n");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); }
function observe(promise) {
  const result = { state: "pending" };
  Promise.resolve(promise).then((value) => { result.state = "fulfilled"; result.value = value; }, (error) => { result.state = "rejected"; result.error = error; });
  return result;
}

function fixture() {
  const videos = new Map(["a", "b", "c", "d"].map((id) => [id, { id, title: `${id} cached` }]));
  const details = [], adjacent = [], animations = [], collections = [], calls = [], notices = [], errors = [];
  const cachedNavigation = new Map(), collectionNavigation = new Map();
  let pendingCollection = false, modal = "";
  const playback = { paused: false, playCalls: 0 };
  const state = { activeView: "shortVideos", shortVideo: {
    mode: "feed", collectionId: "", query: "", source: "liked", deleted: "all", authorAccountStatus: "all",
    current: videos.get("a"), prevId: "", prevVideo: null, nextId: "b", nextVideo: videos.get("b"),
    playbackRate: 1, muted: false, data: {}, collectionData: null
  } };
  const buttons = [{ disabled: false, setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } },
    { disabled: false, setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } }];
  const panel = (video) => video ? {
    isConnected: true, dataset: { videoId: video.id }, querySelector: () => null
  } : null;
  const stack = { current: panel(state.shortVideo.current), prev: null, next: panel(state.shortVideo.nextVideo),
    querySelector(selector) { return selector.includes("is-prev") ? this.prev : selector.includes("is-next") ? this.next : this.current; } };
  const refresh = () => {
    stack.current = panel(state.shortVideo.current);
    stack.prev = panel(state.shortVideo.prevVideo);
    stack.next = panel(state.shortVideo.nextVideo);
    calls.push("refresh-panels");
  };
  const context = vm.createContext({
    state, Date, Promise, URLSearchParams, AbortController, runShortVideoRead,
    shortVideoInteractionState: createShortVideoInteractionState(),
    console: { warn: (error) => errors.push(error) },
    shortVideoNavigationState: null, shortVideoOpenRequestId: 0, shortVideoAdjacentRequestId: 0, shortVideoOpenReadController: null,
    shortVideoOpeningId: "", shortVideoOpenError: "", authorPanelReturnFeed: null,
    shortVideoVideoPrefetches: new Map(), shortVideoAdjacentWarmDirection: 1,
    shortVideoLastNavigationAt: 0, shortVideoAdjacentWarmScheduleId: 0,
    wheelLocked: false, wheelDeltaY: 0, wheelIgnoreUntil: 0, wheelResetTimer: 0, queuedAdjacentDirection: 0,
    shortVideoWheelController: null, cancelShortVideoAutoNext() {}, flushShortVideoAutoNext() {}, cancelShortVideoPanelLoading() {},
    syncShortVideoNativePlaybackModes() {},
    SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS: 1200,
    window: { clearTimeout() {}, setTimeout: () => 1, requestAnimationFrame: (callback) => callback() },
    document: { createElement: () => ({ children: [], append(...children) { this.children.push(...children); } }) },
    els: { workGrid: {
      querySelector: (selector) => modal && selector.split(",").some((part) => part.trim() === modal) ? {} : null,
      querySelectorAll: () => buttons
    } },
    activeReelStack: () => stack, adjacentPlayer: () => null, activeGalleryPlayer: () => null,
    activePlayer: () => playback,
    cancelShortVideoBrowseGestures() {},
    shortVideoFeedParams: () => new URLSearchParams({ q: state.shortVideo.query || "", source: state.shortVideo.source }).toString(),
    cachedShortVideo: (id) => videos.get(String(id)),
    isDeletedShortVideo: () => false,
    cachedShortVideoNavigation: (id) => cachedNavigation.get(String(id)) || null,
    contextualShortVideoDetail: (id) => {
      const request = { ...deferred(), id, query: state.shortVideo.query, mode: state.shortVideo.mode, collectionId: state.shortVideo.collectionId };
      details.push(request); return request.promise;
    },
    api: (url) => { const request = { ...deferred(), url }; adjacent.push(request); return request.promise; },
    collectionsController: {
      collectionNavigation: (id) => state.shortVideo.mode === "collection" ? collectionNavigation.get(String(id)) || null : null,
      prepareCollectionNavigation: (id) => {
        if (!pendingCollection) return Promise.resolve(collectionNavigation.get(String(id)) || null);
        const request = { ...deferred(), id }; collections.push(request); return request.promise;
      },
      returnFromCollectionVideo: () => false
    },
    rememberShortVideo: (video) => { if (video?.id) { videos.set(video.id, video); calls.push(`remember:${video.id}`); } },
    cacheAuthorPanelVideo: (video) => { if (video?.id) calls.push(`author-cache:${video.id}`); },
    isGalleryPost: (video) => Boolean(video?.gallery), normalizePlaybackRate: (rate) => rate, currentShortVideoVolume: () => 0.5,
    clearPendingPlayerClick() {}, closeTransientPlayerControls() {},
    flushActiveShortVideoWatch: () => calls.push("flush-watch"),
    markShortVideoPerformance() {}, markShortVideoCacheState() {},
    pulseBoundaryStack: (direction) => calls.push(`boundary:${direction}`),
    animateActiveStack: (direction) => { const pending = { ...deferred(), direction }; animations.push(pending); return pending.promise; },
    warmAdjacentVideoPlayer: async () => false,
    promoteAdjacentPanelDom: (direction, video) => { calls.push(`promote:${video.id}`); return Promise.resolve(); },
    openVideo: async (id) => { calls.push(`open:${id}`); state.shortVideo.current = videos.get(id) || { id }; },
    replaceRoute: (route) => calls.push(`route:${route.shortVideoId}`),
    pushRoute: (route) => calls.push(`push-route:${route.shortVideoId}`),
    syncActiveControlBar() {}, renderStats() {}, renderView: refresh,
    stopShortVideoSoundPreview() {},
    syncShortVideoModalPlayback() {},
    refreshAdjacentPanelsDom: refresh, resumeActiveSound: () => {
      calls.push("resume-sound"); playback.paused = false; playback.playCalls += 1;
    },
    syncAuthorPanelCurrentTile: () => calls.push("sync-author"), scheduleAdjacentNavigationPrefetch() {},
    scheduleWheelGestureRelease() {}, showBrowserToast: (notice) => notices.push(notice), showError: (error) => errors.push(error),
    railNav: (label, callback, disabled) => ({ label, callback, disabled,
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } }),
    setBodyClass() {}, loadVideos: async () => {}, applyShortVideoFeedSnapshot() {}
  });
  vm.runInContext(`${implementation}\nglobalThis.navigationApi = { beginShortVideoNavigation, cancelShortVideoNavigation, isCurrentShortVideoNavigation, shortVideoNavigationUnknown, hydratePromotedShortVideo, promoteAdjacentMedia, loadAdjacentVideos, openAdjacent, flushQueuedAdjacent, syncCurrentNavigationDom, renderBrowserNav, showHome };`, context);
  return {
    context, state, videos, details, adjacent, animations, collections, calls, notices, errors, playback,
    cachedNavigation, collectionNavigation, buttons, stack, api: context.navigationApi,
    setPendingCollection(value) { pendingCollection = value; },
    setModal(value) { modal = value; },
    currentOwner: () => context.shortVideoNavigationState,
    promote: (id, direction = 1) => context.navigationApi.promoteAdjacentMedia(videos.get(id), direction),
    navigate: (direction) => observe(context.navigationApi.openAdjacent(direction)),
    detail(index, data = {}) {
      const request = details[index];
      request.resolve({ video: { ...videos.get(request.id), title: `${request.id} detail ${index}` }, prevId: "", nextId: "", ...data });
    }
  };
}

{
  const f = fixture();
  f.promote("b"); await flush();
  assert.equal(f.details.length, 1);
  assert.equal(f.state.shortVideo.prevId, "a", "promotion retains a known reverse neighbor while forward detail is pending");
  assert.equal(f.state.shortVideo.nextId, "");
  f.api.syncCurrentNavigationDom();
  assert.equal(f.buttons[1].disabled, false, "unknown forward navigation must stay available rather than appear as a confirmed boundary");
  assert.equal(f.buttons[1]["aria-busy"], "true");
  assert.equal(f.api.renderBrowserNav().children[1].disabled, false, "initial rendering must also expose an unknown direction as available");
  const pending = f.navigate(1); await flush();
  assert.equal(pending.state, "fulfilled");
  assert.equal(f.context.queuedAdjacentDirection, 1);
  f.navigate(1); await flush();
  assert.equal(f.details.length, 1, "repeated gestures share the current pending navigation request");
  assert.equal(f.notices.length, 1, "repeated pending gestures do not repeat the loading notice");
  f.detail(0, { prevId: "a", prevVideo: f.videos.get("a"), nextId: "c", nextVideo: f.videos.get("c") }); await flush();
  assert.equal(f.animations.length, 1, "the retained direction advances automatically when its neighbor arrives");
  assert.equal(f.animations[0].direction, 1);
  f.animations[0].resolve(); await flush();
  assert.equal(f.state.shortVideo.current.id, "c");
  assert.equal(f.context.queuedAdjacentDirection, 0);
}

{
  const f = fixture();
  f.promote("b"); await flush();
  f.navigate(1); await flush();
  f.videos.delete("c");
  f.detail(0, { prevId: "a", prevVideo: f.videos.get("a"), nextId: "c" }); await flush();
  assert.equal(f.adjacent.length, 1, "the cold neighbor thumbnail/detail can still be pending after ids arrive");
  assert.equal(f.animations.length, 1, "knowing the requested id is sufficient to release its retained gesture");
  f.animations[0].resolve(); await flush();
  assert.equal(f.state.shortVideo.current.id, "c");
  f.adjacent[0].resolve({ video: { id: "c", title: "old neighbor completion" } }); await flush();
  assert.equal(f.state.shortVideo.current.id, "c");
  assert(!f.calls.includes("remember:c"), "the obsolete b hydration cannot commit a neighbor payload after navigation has moved on");
}

{
  const f = fixture();
  f.promote("b"); await flush();
  f.navigate(1); await flush();
  const reverse = f.navigate(-1);
  assert.equal(f.animations.length, 1, "known reverse navigation remains immediate while forward metadata is unknown");
  assert.equal(f.animations[0].direction, -1);
  f.animations[0].resolve(); await flush();
  assert.equal(reverse.state, "fulfilled");
  assert.equal(f.state.shortVideo.current.id, "a");
  f.detail(0, { nextId: "d", nextVideo: f.videos.get("d") }); await flush();
  assert.equal(f.state.shortVideo.current.id, "a", "the older forward response cannot undo the latest reverse gesture");
}

{
  const f = fixture();
  f.state.shortVideo.current = f.videos.get("b");
  f.promote("a", -1); await flush();
  const oldA = f.currentOwner();
  f.promote("b", 1); await flush();
  f.promote("a", -1); await flush();
  const latestA = f.currentOwner();
  assert.notEqual(oldA, latestA);
  f.detail(0, { nextId: "d", nextVideo: f.videos.get("d") }); await flush();
  assert.notEqual(f.state.shortVideo.current.title, "a detail 0", "same-id A→B→A navigation requires request ownership, not only an id comparison");
  assert.notEqual(f.state.shortVideo.nextId, "d");
  f.detail(2, { nextId: "c", nextVideo: f.videos.get("c") }); await flush();
  assert.equal(f.state.shortVideo.current.title, "a detail 2");
  assert.equal(f.state.shortVideo.nextId, "c");
}

{
  const f = fixture();
  f.promote("b"); await flush();
  f.promote("c"); await flush();
  f.navigate(1); await flush();
  f.details[0].reject(new Error("obsolete b request")); await flush();
  assert.equal(f.context.queuedAdjacentDirection, 1, "an old request failure cannot clear a newer video's retained gesture");
  assert(!f.notices.some((notice) => /失败/.test(notice)), "obsolete failures must not show an error for the new current video");
}

for (const changeScope of [
  (f) => { f.state.shortVideo.query = "new search"; },
  (f) => { f.state.shortVideo.mode = "collection"; f.state.shortVideo.collectionId = "another-list"; },
  (f) => { f.state.shortVideo.deleted = "deleted"; },
  (f) => { f.state.shortVideo.authorAccountStatus = "unfollowed"; },
  (f) => { f.context.shortVideoOpenRequestId += 1; }
]) {
  const f = fixture();
  f.promote("b"); await flush();
  const owner = f.currentOwner();
  changeScope(f);
  assert.equal(f.api.isCurrentShortVideoNavigation(owner), false);
  f.detail(0, { prevId: "d", nextId: "d", nextVideo: f.videos.get("d") }); await flush();
  assert.notEqual(f.state.shortVideo.current.title, "b detail 0", "an old request cannot commit to another route/feed scope with the same video id");
  assert.notEqual(f.state.shortVideo.nextId, "d");
}

for (const modal of [".short-video-more-overlay", ".short-video-search-overlay", ".short-video-author-panel", ".short-video-share-panel"]) {
  const f = fixture();
  f.promote("b"); await flush();
  f.navigate(1); await flush();
  f.setModal(modal);
  f.detail(0, { prevId: "a", prevVideo: f.videos.get("a"), nextId: "c", nextVideo: f.videos.get("c") }); await flush();
  assert.equal(f.context.queuedAdjacentDirection, 0, "opening a modal cancels the earlier retained direction");
  assert.equal(f.animations.length, 0, "late metadata cannot navigate beneath an active modal");
  assert.equal(f.state.shortVideo.current.id, "b");
  f.setModal("");
  f.api.flushQueuedAdjacent(); await flush();
  assert.equal(f.animations.length, 0, "closing the modal must not replay a cancelled gesture");
}

{
  const f = fixture();
  f.promote("b"); await flush();
  f.navigate(1); await flush();
  f.api.showHome();
  assert.equal(f.currentOwner(), null, "returning home must revoke the pending navigation owner");
  assert.equal(f.context.queuedAdjacentDirection, 0);
  assert.equal(f.state.shortVideo.current, null);
  f.detail(0, { nextId: "c", nextVideo: f.videos.get("c") }); await flush();
  assert.equal(f.state.shortVideo.current, null);
  assert.equal(f.animations.length, 0);
}

{
  const f = fixture();
  f.promote("b"); await flush();
  f.navigate(1); await flush();
  f.details[0].reject(new Error("detail unavailable")); await flush();
  assert.equal(f.context.queuedAdjacentDirection, 0, "failed requests must release the retained gesture");
  assert(f.notices.some((notice) => /失败|重试/.test(notice)), "failure must leave a visible recovery path");
  f.api.syncCurrentNavigationDom();
  assert.equal(f.buttons[1].disabled, false, "a failed unknown neighbor can be retried from its navigation button");
  f.navigate(1); await flush();
  assert.equal(f.details.length, 2, "a later gesture must be able to retry a failed metadata request");
  f.detail(1, { nextId: "", prevId: "a", prevVideo: f.videos.get("a") }); await flush();
  assert.equal(f.context.queuedAdjacentDirection, 0, "confirmed end-of-feed must clear the gesture rather than hang");
  f.api.syncCurrentNavigationDom();
  assert.equal(f.buttons[1].disabled, true);
  const nav = f.api.renderBrowserNav();
  assert.equal(nav.children[1].disabled, true, "initial render and later navigation synchronization must agree about confirmed boundaries");
  const count = f.details.length;
  f.navigate(1); await flush();
  assert.equal(f.details.length, count, "a confirmed boundary must not issue another metadata request");
}

for (const payload of [{ video: { id: "b" } }, { video: { id: "wrong-video" }, prevId: "", nextId: "" }]) {
  const f = fixture();
  f.promote("b"); await flush();
  f.navigate(1); await flush();
  f.details[0].resolve(payload); await flush();
  assert.equal(f.context.queuedAdjacentDirection, 0);
  assert.equal(f.state.shortVideo.current.id, "b");
  f.api.syncCurrentNavigationDom();
  assert.equal(f.buttons[1].disabled, false, "malformed or mismatched detail cannot masquerade as a confirmed final item");
  assert(f.notices.some((notice) => /失败|重试/.test(notice)));
}

{
  const f = fixture();
  f.state.shortVideo.current = f.videos.get("b");
  f.state.shortVideo.prevId = ""; f.state.shortVideo.prevVideo = null;
  f.state.shortVideo.nextId = "unloaded"; f.state.shortVideo.nextVideo = null;
  const owner = f.api.beginShortVideoNavigation(f.state.shortVideo.current, { pending: false, prevKnown: true, nextKnown: true });
  const request = observe(f.api.loadAdjacentVideos("b", owner)); await flush();
  assert.equal(f.adjacent.length, 1);
  f.state.shortVideo.query = "replaced scope";
  f.adjacent[0].resolve({ video: { id: "unloaded", title: "stale adjacent" } }); await flush();
  assert.equal(request.state, "fulfilled");
  assert.equal(f.state.shortVideo.nextVideo, null, "adjacent payloads require the same owner and scope after their own awaits");
  assert(!f.calls.includes("remember:unloaded"));
}

{
  const f = fixture();
  f.state.shortVideo.nextId = "unloaded"; f.state.shortVideo.nextVideo = null;
  const owner = f.api.beginShortVideoNavigation(f.state.shortVideo.current, { pending: false, prevKnown: true, nextKnown: true });
  const request = observe(f.api.loadAdjacentVideos("a", owner)); await flush();
  f.adjacent[0].resolve({ video: { id: "different-id" } }); await flush();
  assert.equal(request.state, "fulfilled");
  assert.equal(f.state.shortVideo.nextVideo, null, "a neighbor response must match the requested id before being attached");
  assert(!f.calls.includes("remember:different-id"));
}

{
  const f = fixture();
  f.state.shortVideo.mode = "collection";
  f.state.shortVideo.collectionId = "list";
  f.state.shortVideo.collectionData = { videos: [f.videos.get("a"), f.videos.get("b")], hasMore: true };
  f.collectionNavigation.set("b", { prevId: "a", prevVideo: f.videos.get("a"), nextId: "", nextVideo: null });
  f.setPendingCollection(true);
  f.promote("b"); await flush();
  f.detail(0, { nextId: "server-neighbor", nextVideo: { id: "server-neighbor" } }); await flush();
  assert.equal(f.collections.length, 1);
  f.api.syncCurrentNavigationDom();
  assert.equal(f.buttons[1].disabled, false, "a collection page with hasMore is not a confirmed final item");
  f.navigate(1); await flush();
  assert.equal(f.context.queuedAdjacentDirection, 1);
  f.collectionNavigation.set("b", { prevId: "a", prevVideo: f.videos.get("a"), nextId: "c", nextVideo: f.videos.get("c") });
  f.state.shortVideo.collectionData.hasMore = false;
  f.state.shortVideo.nextId = "c"; f.state.shortVideo.nextVideo = f.videos.get("c");
  f.collections[0].resolve(f.collectionNavigation.get("b")); await flush();
  assert.equal(f.animations.length, 1, "a retained collection gesture continues when the next page supplies its neighbor");
  f.animations[0].resolve(); await flush();
  assert.equal(f.state.shortVideo.current.id, "c");
}

{
  const f = fixture();
  f.state.shortVideo.mode = "collection";
  f.state.shortVideo.collectionId = "list";
  f.state.shortVideo.collectionData = { videos: [f.videos.get("a"), f.videos.get("b")], hasMore: true };
  f.collectionNavigation.set("b", { prevId: "a", prevVideo: f.videos.get("a"), nextId: "", nextVideo: null });
  f.setPendingCollection(true);
  f.promote("b"); await flush();
  f.detail(0); await flush();
  f.navigate(1); await flush();
  f.collections[0].resolve(null); await flush();
  f.api.syncCurrentNavigationDom();
  assert.equal(f.buttons[1].disabled, false, "superseded collection paging cannot turn hasMore into a confirmed boundary");
  assert.equal(f.context.queuedAdjacentDirection, 0, "a cancelled page request must release its gesture with a retry path");
}

const collectionSource = fs.readFileSync(new URL("../public/modules/short-videos/collections-controller.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const collectionImplementation = ["collectionNavigation", "prepareCollectionNavigation"]
  .map((name) => sourceFunction(collectionSource, name)).join("\n");
function collectionFixture() {
  const requests = [], notifications = [];
  const state = { shortVideo: {
    mode: "collection", collectionId: "list", prevId: "previous", nextId: "current-next",
    collectionData: { videos: [{ id: "b" }], hasMore: true, nextCursor: "page-1" }
  } };
  let current = true;
  const context = vm.createContext({
    state, onNavigationChange: () => notifications.push("changed"),
    loadCollection: (id, options) => { const request = { ...deferred(), id, options }; requests.push(request); return request.promise; }
  });
  vm.runInContext(`${collectionImplementation}\nglobalThis.prepare = prepareCollectionNavigation;`, context);
  return {
    state, requests, notifications,
    run: () => observe(context.prepare("b", { isCurrent: () => current })),
    revoke: () => { current = false; },
    resolve(index, { videos, hasMore, nextCursor }) {
      if (videos) state.shortVideo.collectionData.videos = videos;
      state.shortVideo.collectionData.hasMore = hasMore;
      state.shortVideo.collectionData.nextCursor = nextCursor;
      requests[index].resolve(state.shortVideo.collectionData);
    }
  };
}

{
  const f = collectionFixture();
  const request = f.run();
  assert.equal(f.requests.length, 1);
  f.resolve(0, { hasMore: true, nextCursor: "page-2" }); await flush();
  assert.equal(request.state, "pending");
  assert.equal(f.requests.length, 2, "an empty page with an advancing cursor must not become a false boundary");
  f.resolve(1, { videos: [{ id: "b" }, { id: "c" }], hasMore: false, nextCursor: null }); await flush();
  assert.equal(request.state, "fulfilled");
  assert.equal(f.state.shortVideo.nextId, "c");
  assert.equal(f.notifications.length, 1);
}

{
  const f = collectionFixture();
  const request = f.run();
  f.revoke();
  f.state.shortVideo.nextId = "new-scene-next";
  f.resolve(0, { videos: [{ id: "b" }, { id: "stale-c" }], hasMore: false, nextCursor: null }); await flush();
  assert.equal(request.state, "fulfilled");
  assert.equal(request.value, null);
  assert.equal(f.state.shortVideo.nextId, "new-scene-next", "revoked collection preparation cannot rewrite a new scene's neighbors");
  assert.equal(f.notifications.length, 0);
}

{
  const f = collectionFixture();
  const request = f.run();
  f.resolve(0, { hasMore: true, nextCursor: "page-1" }); await flush();
  assert.equal(request.state, "rejected", "a page that changes neither cursor nor available neighbor must fail instead of spinning");
  assert.match(request.error.message, /没有前进/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.notifications.length, 0);
}

{
  const f = collectionFixture();
  const request = f.run();
  f.resolve(0, { hasMore: false, nextCursor: null }); await flush();
  assert.equal(request.state, "fulfilled");
  assert.equal(f.state.shortVideo.nextId, "", "an exhausted collection can confirm its boundary even when its final page is empty");
  assert.equal(f.notifications.length, 1);
}

{
  const f = collectionFixture();
  f.revoke();
  const request = f.run(); await flush();
  assert.equal(request.state, "fulfilled");
  assert.equal(request.value, null);
  assert.equal(f.requests.length, 0, "an already obsolete owner must not request another collection page");
}

for (const gallery of [false, true]) {
  const f = fixture();
  f.videos.get("b").gallery = gallery;
  f.promote("b"); await flush();
  f.playback.paused = true;
  const playsBeforeMetadata = f.playback.playCalls;
  f.detail(0, { prevId: "a", nextId: "" }); await flush();
  assert.equal(f.currentOwner().status, "ready");
  assert.equal(f.playback.paused, true, `${gallery ? "gallery" : "video"} metadata must not override a later user pause`);
  assert.equal(f.playback.playCalls, playsBeforeMetadata, "navigation hydration is not a new playback request");
}

{
  const f = fixture();
  f.videos.delete("c");
  f.promote("b"); await flush();
  f.detail(0, { prevId: "a", nextId: "c" }); await flush();
  assert.equal(f.adjacent.length, 1);
  f.playback.paused = true;
  f.adjacent[0].resolve({ video: { id: "c" } }); await flush();
  assert.equal(f.currentOwner().status, "ready");
  assert.equal(f.playback.paused, true, "late neighbor metadata must also preserve the user's pause");
  assert.equal(f.playback.playCalls, 0);
}

console.log("short-video-navigation: unknown-neighbor gestures, request ownership, retry, boundaries, route cancellation, collection paging and playback intent passed");

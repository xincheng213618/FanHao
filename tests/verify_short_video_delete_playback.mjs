import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoInteractionState } from "../public/modules/short-videos/interaction-state.js";
import { createShortVideoMediaCache } from "../public/modules/short-videos/media-cache.js";
import { createShortVideoWatchWriteController } from "../public/modules/short-videos/watch-write-controller.js";
import { runShortVideoRead } from "../public/modules/short-videos/read-request.js";

// Run real page deletion, navigation, cache and watch code against controlled
// receipts. This never calls a service, database, media file or real DELETE.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const navigationFixture = fs.readFileSync(new URL("./verify_short_video_navigation.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function take(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, `missing actual function ${name}`);
  return source.slice(match.index, source.indexOf("\n  }", match.index) + 4);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let turn = 0; turn < 50; turn++) await Promise.resolve(); }
const implementation = source.slice(source.indexOf("  function shortVideoNavigationScope("), source.indexOf("  function adjacentPlayer("))
  + ["promoteAdjacentMedia", "hydratePromotedShortVideo", "loadAdjacentVideos", "syncCurrentNavigationDom", "renderBrowserNav", "showHome"].map(take).join("\n");
const fixtureContext = vm.createContext({ vm, createShortVideoInteractionState, implementation, deferred, URLSearchParams, AbortController, runShortVideoRead });
vm.runInContext(navigationFixture.slice(navigationFixture.indexOf("function fixture()"), navigationFixture.indexOf("\n{\n  const f = fixture();")) + "\nglobalThis.make = fixture;", fixtureContext);

function fixture() {
  const f = fixtureContext.make(), deleted = new Set(), requests = [], deletions = [], authorCache = new Map();
  const server = [...f.videos.values()];
  const detail = id => {
    const rows = server.filter(video => !deleted.has(video.id)), index = rows.findIndex(video => video.id === id);
    assert(index >= 0, `unexpected detail for deleted ${id}`);
    return { video: rows[index], prevId: rows[index - 1]?.id || "", nextId: rows[index + 1]?.id || "",
      prevVideo: rows[index - 1] || null, nextVideo: rows[index + 1] || null,
      neighbors: { previous: rows[index - 1] ? [rows[index - 1]] : [], next: rows[index + 1] ? [rows[index + 1]] : [] } };
  };
  let readDetail = detail;
  const cache = createShortVideoMediaCache({
    api: async url => { requests.push(url); return readDetail(decodeURIComponent(url.split("?")[0].split("/").at(-1))); },
    cachedAuthorPanelVideo: id => authorCache.get(id), cacheAuthorPanelVideo() {}, getFeedParams: f.context.shortVideoFeedParams,
    markPerformance() {}, isGalleryPost: () => true, galleryImageEntries: () => [], shortVideoCardCoverUrl: () => ""
  });
  server.forEach(cache.rememberVideo);
  f.state.shortVideo.data = { videos: [...server], total: server.length };
  f.state.shortVideo.deleteSelection = new Set();
  const deleteRequest = (video, options) => { const request = { ...deferred(), video, options }; deletions.push(request); return request.promise; };
  Object.assign(f.context, {
    shortVideoListRequestId: 0, shortVideoWatchWrites: new Map(), authorPanelVideoCache: authorCache, authorPanelTileMap: new Map(),
    deleteActions: { deleteVideo: deleteRequest, deleteSelected: ids => deleteRequest(ids) },
    loadedCoverIds: new Set(server.map(video => video.id)),
    shortVideoDeletePendingMessage: () => "cleanup pending", shortVideoDeleteCompletedMessage: () => "deleted",
    ensureState() {}, ensureShortVideoViewerStyles: async () => true, cancelAuthorCollectorPolling() {},
    cachedShortVideo: cache.cachedVideo, cachedShortVideoNavigation: cache.cachedNavigation,
    contextualShortVideoDetail: cache.fetchDetail, fetchShortVideoDetail: cache.fetchDetail,
    forgetCachedShortVideos: cache.forgetVideos, isDeletedShortVideo: cache.isDeleted,
    prewarmShortVideoPlayback: async () => false, loadShortVideoSummary: async () => {}, handleSummaryLoadError() {},
    scheduleInitialAdjacentPanelsRefresh() {},
    isShortVideoAuthorDetailPage: () => false,
    shortVideoDeleteSelection: () => f.state.shortVideo.deleteSelection,
    clearShortVideoDeleteSelection: () => { f.state.shortVideo.deleteSelection.clear(); f.state.shortVideo.deleteMode = false; },
    loadVideos: async options => { f.calls.push(["load", options]); f.context.shortVideoListRequestId++; }
  });
  f.context.collectionsController.forgetVideos = ids => f.calls.push(["forget-collection", [...ids]]);
  f.context.document.documentElement = { dataset: {} };
  f.context.window.scrollTo = () => {};
  vm.runInContext(["shortVideoListScope", "openVideo", "deleteShortVideo", "deleteSelectedShortVideos", "captureShortVideoDeleteContext", "isCurrentShortVideoDeleteContext", "applyShortVideoDeletion", "decrementCurrentAuthorCount", "persistShortVideoWatch"].map(take).join("\n")
    + "\nglobalThis.remove = deleteShortVideo; globalThis.removeSelected = deleteSelectedShortVideos; globalThis.persist = persistShortVideoWatch;", f.context);
  return { ...f, cache, server, deleted, requests, deletions, authorCache, detail,
    setReadDetail(callback) { readDetail = callback; },
    commit(index, ids, extra = {}) { ids.forEach(id => deleted.add(id)); deletions[index].resolve({ committed: true, ids, ...extra }); },
    async open(id) { await f.context.openVideo(id); await flush(); },
    loads: () => f.calls.filter(value => Array.isArray(value) && value[0] === "load") };
}

let checks = 0;
{
  const f = fixture();
  await f.cache.fetchDetail("a"); await f.cache.fetchDetail("b");
  const operation = f.context.remove(f.videos.get("a")); f.commit(0, ["a"]); await operation; await flush();
  assert.equal(f.state.shortVideo.current.id, "b");
  assert.equal(f.state.shortVideo.prevId, "");
  assert.equal(f.cache.cachedVideo("a"), null);
  assert.equal(f.cache.cachedNavigation("a"), null);
  assert(!f.state.shortVideo.data.videos.some(video => video.id === "a"));
  await f.api.openAdjacent(-1); await flush();
  assert.equal(f.state.shortVideo.current.id, "b", "reverse must not resurrect deleted A");
  assert.equal(f.errors.length, 0); checks++;
}
for (const move of ["another-video", "home", "another-feed"]) {
  const f = fixture(), operation = f.context.remove(f.videos.get("a"));
  if (move === "another-video") await f.open("c");
  else { f.api.showHome(); if (move === "another-feed") f.state.shortVideo.query = "new search"; }
  const before = f.state.shortVideo.current, routes = f.calls.filter(value => typeof value === "string" && value.includes("route:")).length;
  const loads = f.loads().length;
  f.commit(0, ["a"]); await operation; await flush();
  assert.equal(f.state.shortVideo.current, before, `${move}: stale success cannot reopen or replace the current media`);
  assert.equal(f.loads().length, loads, `${move}: stale success cannot reload a new list`);
  assert.equal(f.calls.filter(value => typeof value === "string" && value.includes("route:")).length, routes);
  assert.equal(f.cache.cachedVideo("a"), null); checks++;
}
{
  const f = fixture(), operation = f.context.remove(f.videos.get("a"), { scope: "group" });
  await f.open("b"); f.commit(0, ["a", "b"]); await operation; await flush();
  assert.equal(f.state.shortVideo.current.id, "c", "group result removes the different member opened while DELETE was pending");
  assert(![f.state.shortVideo.prevId, f.state.shortVideo.nextId].some(id => ["a", "b"].includes(id))); checks++;
}
{
  const f = fixture(); await f.open("b");
  const player = f.playback; player.currentTime = 12.5; player.paused = true;
  const current = f.state.shortVideo.current, playCalls = player.playCalls, operation = f.context.remove(f.videos.get("c"));
  f.commit(0, ["c"]); await operation; await flush();
  assert.equal(f.state.shortVideo.current, current); assert.equal(f.playback, player);
  assert.equal(player.currentTime, 12.5); assert.equal(player.paused, true); assert.equal(player.playCalls, playCalls);
  assert.equal(f.state.shortVideo.nextId, "d", "deleting a neighbor skips it without replacing the active player");
  assert.equal(f.loads().length, 0); checks++;
}
for (const move of ["new-list-selection", "current-deleted"]) {
  const f = fixture(); f.api.showHome();
  f.state.shortVideo.deleteSelection = new Set(["a", "b"]);
  const oldSelection = f.state.shortVideo.deleteSelection, operation = f.context.removeSelected();
  if (move === "new-list-selection") {
    f.state.shortVideo.query = "new search"; f.context.shortVideoListRequestId++;
    f.state.shortVideo.deleteSelection = new Set(["c"]);
  } else await f.open("b");
  const loads = f.loads().length;
  f.commit(0, ["a", "b"]); await operation; await flush();
  assert.equal(oldSelection.size, 0);
  if (move === "new-list-selection") {
    assert.deepEqual([...f.state.shortVideo.deleteSelection], ["c"]); assert.equal(f.state.shortVideo.current, null);
    assert.equal(f.loads().length, loads);
  } else assert.equal(f.state.shortVideo.current.id, "c");
  checks++;
}
{
  const f = fixture(); f.api.showHome();
  const operation = f.context.remove(f.videos.get("a")); f.commit(0, ["a"]); await operation;
  assert.equal(f.loads().length, 1, "a deletion owned by the same list still refreshes its authoritative total"); checks++;
}
{
  const f = fixture(), operation = f.context.remove(f.videos.get("a"));
  f.deletions[0].resolve({ committed: false, ids: ["a"] }); await operation;
  assert.equal(f.cache.cachedVideo("a").id, "a"); assert.equal(f.state.shortVideo.current.id, "a"); checks++;
}
{
  const f = fixture(); await f.open("b");
  const animation = f.api.openAdjacent(1); await flush();
  assert.equal(f.animations.length, 1);
  const operation = f.context.remove(f.videos.get("c")); f.commit(0, ["c"]); await operation;
  f.animations[0].resolve(); await animation; await flush();
  assert.equal(f.state.shortVideo.current.id, "b", "an animation's cached target cannot promote after its deletion receipt");
  assert(!f.calls.includes("promote:c")); checks++;
}
{
  const f = fixture(), updates = [], writes = [];
  f.videos.get("a").awemeId = "alias-a";
  f.context.shortVideoWatchWrites.set("alias-a", { stale: true });
  const controller = createShortVideoWatchWriteController({ entries: f.context.shortVideoWatchWrites,
    write: (id, payload) => { const request = { ...deferred(), id, payload }; writes.push(request); return request.promise; },
    onUpdate: (id, watch, options) => updates.push({ id, watch, options }) });
  f.context.ensureShortVideoWatchWriteController = () => controller;
  f.context.flushActiveShortVideoWatch = () => {
    f.context.persist(f.state.shortVideo.current, { currentTime: 9 }, { force: true });
    controller.flush({ keepalive: true });
  };
  assert.equal(f.context.persist(f.videos.get("a"), { currentTime: 9 }, { force: true }), true);
  const updateCount = updates.length, operation = f.context.remove(f.videos.get("a"));
  f.commit(0, ["a"]); await operation; await flush();
  assert.equal(f.context.persist(f.videos.get("a"), { currentTime: 10 }, { force: true }), false);
  assert.equal(f.context.persist({ id: "alias-a" }, { currentTime: 10 }, { force: true }), false);
  assert.equal(f.context.shortVideoWatchWrites.has("alias-a"), false);
  writes[0].resolve({ videoId: "a", watch: { progressMs: 9000 } }); await flush();
  assert.equal(updates.length, updateCount, "an accepted deletion invalidates the already-sent watch receipt");
  assert.equal(controller.stats().size, 0); assert.equal(writes.length, 1);
  assert.equal(f.context.persist(f.videos.get("b"), { currentTime: 3 }, { force: true }), true);
  writes[1].resolve({ videoId: "b", watch: { progressMs: 3000 } }); await flush(); checks++;
}
{
  const f = fixture(); await f.open("b");
  f.state.shortVideo.prevVideo = null;
  f.context.cachedShortVideo = id => id === "a" ? null : f.cache.cachedVideo(id);
  const loading = f.api.loadAdjacentVideos("b"); await flush();
  assert.equal(f.adjacent.length, 1);
  const operation = f.context.remove(f.videos.get("a")); f.commit(0, ["a"]); await operation;
  f.adjacent[0].resolve({ video: f.videos.get("a") });
  assert.equal(await loading, false, "deletion invalidates an older adjacent GET even while the current item survives");
  assert.equal(f.state.shortVideo.prevVideo, null); assert.equal(f.state.shortVideo.prevId, ""); checks++;
}
{
  const requests = [], authorWrites = [], author = new Map();
  const cache = createShortVideoMediaCache({ api: url => { const request = { ...deferred(), url }; requests.push(request); return request.promise; },
    getFeedParams: () => "feed", cachedAuthorPanelVideo: id => author.get(id), cacheAuthorPanelVideo: video => authorWrites.push(video),
    markPerformance() {}, isGalleryPost: () => true, galleryImageEntries: () => [], shortVideoCardCoverUrl: () => "" });
  cache.rememberVideo({ id: "a", awemeId: "alias-a" });
  const pendingA = cache.fetchDetail("a").then(data => ({ data }), error => ({ error }));
  const pendingB = cache.fetchDetail("b");
  cache.forgetVideos(["a"]);
  author.set("a", { id: "a", awemeId: "alias-a" });
  assert.equal(cache.cachedVideo("a"), null); assert.equal(cache.cachedVideo("alias-a"), null);
  requests[0].resolve({ video: { id: "a" }, nextId: "b" });
  assert.equal((await pendingA).error.code, "SHORT_VIDEO_DELETED");
  requests[1].resolve({ video: { id: "b" }, prevId: "a", prevVideo: { id: "a" }, nextId: "c", neighbors: { previous: [{ id: "a" }], next: [{ id: "c" }] } });
  const b = await pendingB;
  assert.equal(b.prevId, ""); assert.equal(b.prevVideo, null); assert.equal(b.neighbors.previous.length, 0);
  assert.equal(cache.resolvedDetail("b"), null, "an invalidated membership request must not publish a cache entry");
  await assert.rejects(cache.fetchDetail("alias-a"), error => error.code === "SHORT_VIDEO_DELETED");
  assert.equal(await cache.prefetchRelatedVideo({ id: "a" }), null);
  assert.equal(cache.rememberVideo({ id: "a" }), null);
  assert.deepEqual(authorWrites, []); checks++;
}
{
  const f = fixture(), original = f.videos.get("a");
  original.awemeId = "alias-a";
  const operation = f.context.remove(original); f.commit(0, ["a"]); await operation; await flush();
  const before = f.state.shortVideo.current, requests = f.requests.length;
  assert.equal(await f.context.openVideo("a", { video: original }), false);
  assert.equal(await f.context.openVideo("alias-a", { video: original }), false);
  assert.equal(f.state.shortVideo.current, before); assert.equal(f.requests.length, requests);
  checks++;
}
{
  const f = fixture(); await f.open("b");
  const styles = deferred(); f.context.ensureShortVideoViewerStyles = () => styles.promise;
  const opening = f.context.openVideo("a", { video: f.videos.get("a") });
  const operation = f.context.remove(f.videos.get("a")); f.commit(0, ["a"]); await operation;
  styles.resolve(true); assert.equal(await opening, false); await flush();
  assert.equal(f.state.shortVideo.current.id, "b", "a deleted pending viewer cannot commit when its stylesheet arrives"); checks++;
}
for (const gateKind of ["styles", "detail"]) {
  const f = fixture(), gate = deferred(), operation = f.context.remove(f.videos.get("a"));
  if (gateKind === "styles") f.context.ensureShortVideoViewerStyles = () => gate.promise;
  else {
    f.context.cachedShortVideo = id => id === "d" ? null : f.cache.cachedVideo(id);
    f.state.shortVideo.data.videos = f.state.shortVideo.data.videos.filter(video => video.id !== "d");
    f.context.contextualShortVideoDetail = id => id === "d" ? gate.promise : f.cache.fetchDetail(id);
  }
  const opening = f.context.openVideo("d", gateKind === "styles" ? { video: f.videos.get("d") } : {});
  await flush(); assert.equal(f.context.shortVideoOpeningId, "d");
  f.commit(0, ["a"]); await operation; await flush();
  assert.equal(f.state.shortVideo.current, null, `${gateKind}: remove the deleted old media while the explicit destination waits`);
  assert.equal(f.context.shortVideoOpeningId, "d");
  assert.equal(f.state.shortVideo.loading, true);
  gate.resolve(gateKind === "styles" ? true : f.detail("d"));
  assert.equal(await opening, true); await flush();
  assert.equal(f.state.shortVideo.current.id, "d", `${gateKind}: deletion fallback must not replace a newer explicit open`);
  assert(!f.calls.includes("push-route:b")); assert.equal(f.errors.length, 0); checks++;
}
{
  const f = fixture(), styles = deferred(), operation = f.context.remove(f.videos.get("a"));
  f.context.ensureShortVideoViewerStyles = () => styles.promise;
  const opening = f.context.openVideo("d", { video: { id: "d", awemeId: "a" } });
  f.commit(0, ["a"]); await flush(); styles.resolve(true);
  await operation; assert.equal(await opening, false); await flush();
  assert.equal(f.state.shortVideo.current.id, "b", "a pending destination known to alias the deletion must use a surviving fallback");
  assert.equal(f.state.shortVideo.loading, false); checks++;
}
for (const newerOpen of [false, true]) {
  const f = fixture(), detail = deferred(), operation = f.context.remove(f.videos.get("a"));
  f.context.cachedShortVideo = id => id === "d" ? null : f.cache.cachedVideo(id);
  f.state.shortVideo.data.videos = f.state.shortVideo.data.videos.filter(video => video.id !== "d");
  f.setReadDetail(id => id === "d" ? detail.promise : f.detail(id));
  const opening = f.context.openVideo("d"); await flush();
  f.commit(0, ["a"]); await operation;
  assert.equal(f.state.shortVideo.loading, true);
  if (newerOpen) await f.open("c");
  detail.resolve({ video: { id: "a", awemeId: "d" }, prevId: "", nextId: "b" });
  assert.equal(await opening, false); await flush();
  assert.equal(f.state.shortVideo.loading, false, "a destination revealed as a deleted alias must settle its loading state");
  assert.equal(f.context.shortVideoOpeningId, "");
  assert.equal(f.state.shortVideo.current?.id || null, newerOpen ? "c" : null,
    "a late deleted alias cannot clear a newer destination"); checks++;
}
{
  const f = fixture();
  f.cache.rememberVideo({ id: "old", awemeId: "old-alias" }); f.cache.forgetVideos(["old"]);
  for (let index = 0; index < 2000; index++) {
    f.cache.rememberVideo({ id: `browse-${index}`, awemeId: `alias-${index}` });
    f.cache.isDeleted({ id: `read-${index}`, awemeId: `read-alias-${index}` });
  }
  assert(f.cache.stats().aliases <= 96, "normal browsing cannot grow the alias index beyond the neighbor cache budget");
  assert(f.cache.stats().videos <= 32);
  assert.equal(f.cache.isDeleted("old-alias"), true, "confirmed deletion aliases outlive normal alias eviction");
  assert.equal(f.cache.cachedVideo("old"), null); checks++;
}
{
  const previousDocument = globalThis.document;
  class Element {
    constructor() { this.dataset = {}; this.style = {}; this.isConnected = true; this.pauses = 0; this.loads = 0; }
    setAttribute() {} removeAttribute(name) { if (name === "src") this.src = ""; }
    append(child) { child.isConnected = true; } remove() { this.isConnected = false; }
    play() { return Promise.resolve(); } pause() { this.pauses++; } load() { this.loads++; }
  }
  globalThis.document = { body: new Element(), createElement: () => new Element() };
  try {
    const cache = createShortVideoMediaCache({ cachedAuthorPanelVideo: () => null, getFeedParams: () => "", markPerformance() {},
      isGalleryPost: () => false, shortVideoPlaybackUrl: video => `/test/${video.id}`, waitForVideoFirstFrame: async () => true });
    await cache.prewarmPlayback({ id: "playing" }, { explicit: true });
    const active = cache.takePrewarmedPlayer({ id: "playing" }), pauses = active.pauses, loads = active.loads;
    await cache.prewarmPlayback({ id: "queued" }, { explicit: true });
    cache.forgetVideos(["playing", "queued"]);
    assert.equal(active.isConnected, true); assert.equal(active.pauses, pauses); assert.equal(active.loads, loads);
    assert.equal(cache.stats().playbackPreloads, 0, "only owned preloads are disposed; a taken active player belongs to the page");
    assert.equal(await cache.prewarmPlayback({ id: "queued" }, { explicit: true }), false); checks++;
  } finally { globalThis.document = previousDocument; }
}
console.log(`short-video-delete-playback: ${checks} actual page/cache/watch lifecycle groups passed`);

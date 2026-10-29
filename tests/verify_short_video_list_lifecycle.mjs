import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as normalizers from "../public/modules/short-videos/state.js";
import { isCurrentShortVideoLoadRequest, settleShortVideoLoad, SHORT_VIDEO_LOAD_STALE } from "../public/modules/short-videos/author-navigation.js";
import { createShortVideoCollectionsController } from "../public/modules/short-videos/collections-controller.js";
import { disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";
import { runShortVideoRead } from "../public/modules/short-videos/read-request.js";

// Compose the real page read/open/render functions with its real collection
// controller and media disposer. Only API responses, media and layout are
// controlled; no service, database, browser profile or user media is accessed.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function take(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert(start != null, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}
const names = ["shortVideoNavigationScope", "shortVideoFeedParams", "shortVideoListScope", "invalidateShortVideoListWork",
  "captureShortVideoListOwner", "ownsShortVideoListOwner", "shortVideoListHasViewer", "staleShortVideoListResult", "handleShortVideoListFailure",
  "loadVideos", "loadSearchUsers", "openVideo", "refreshShortVideoHome", "renderView", "applyRouteState", "openRouteTarget"];
const implementation = names.map(take).join("\n");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); };
const video = id => ({ id, title: id, streamUrl: `/fixture/${id}` });
const page = (ids, options = {}) => ({ videos: ids.map(video), total: ids.length, source: "liked", hasMore: false, ...options });
const toJSON = value => JSON.parse(JSON.stringify(value));

function fixture({ code = implementation, authorIndex = false, authorPage = "" } = {}) {
  const requests = [], views = [], routes = [], warnings = [], metrics = [], deleted = new Set(), authors = [], styles = deferred();
  const state = { activeView: "shortVideos", shortVideo: {
    mode: "feed", collectionId: "", authorPage, author: authorPage || "all", source: authorIndex ? "authors" : "liked", query: "", sort: "likes",
    authorSort: "followed", authorFilter: "all", media: "all", quality: "all", deleted: "all", authorAccountStatus: "all", current: null,
    loading: false, loadingMore: false, authorLoadingMore: false, authorHasMore: true, authors: [{ id: "author-old" }],
    data: page(["A", "B"], { hasMore: true, nextCursor: "cursor-1" })
  } };
  let media = null, mediaId = 0, stats = 0, pendingStyles = false;
  const frames = [];
  const root = { append() {}, querySelector: () => null,
    querySelectorAll: selector => selector === "video, audio" && media ? [media] : [],
    set innerHTML(value) { assert.equal(value, ""); media = null; }
  };
  const env = vm.createContext({
    ...normalizers, state, Date, Promise, URLSearchParams, AbortController, runShortVideoRead, console: { warn: (...args) => warnings.push(args) },
    document: { documentElement: { dataset: {}, classList: { remove() {} } }, activeElement: null },
    window: { scrollY: 0, scrollTo() {}, history: { length: 1 }, requestAnimationFrame: callback => { frames.push(callback); return frames.length; } },
    // This VM has no mounted home DOM; the actual retention helper takes its null-view fallback.
    shortVideoHomePresentation: null, els: { workGrid: root }, shortVideoListRequestId: 0, searchUsersGeneration: 0, shortVideoOpenRequestId: 0,
    shortVideoOpeningId: "", shortVideoOpenError: "", shortVideoOpenReadController: null, shortVideoListCards: {}, initialVideoLimit: 36, appendVideoLimit: 48, AUTHOR_PAGE_SIZE: 36,
    ensureState() {}, syncAuthorCollectorRouteLifecycle() {}, cancelAuthorCollectorPolling() {}, cancelShortVideoNavigation() {},
    preserveShortVideoHomeDuringLoad: () => true,
    isShortVideoAuthorIndexPage: () => ["authors", "following"].includes(state.shortVideo.source) && !state.shortVideo.authorPage,
    restoreSavedAuthorIndexWindow: () => false, shortVideoAuthorFilterValue: author => author.id,
    isShortVideoAuthorDetailPage: () => Boolean(state.shortVideo.authorPage),
    resolveShortVideoAuthor: id => { const request = { id, ...deferred() }; authors.push(request); return request.promise; },
    shortVideoApiSource: () => state.shortVideo.source,
    isCurrentShortVideoLoadRequest, settleShortVideoLoad, SHORT_VIDEO_LOAD_STALE,
    isDeletedShortVideo: value => deleted.has(String(value?.id || value)),
    discardAuthorIndexWindowAfterRouteChange() {},
    renderStats() { stats++; }, markShortVideoPerformance: (...args) => metrics.push(args), shortVideosWithCovers: values => values,
    renderShortVideoWindow() { views.push({ append: true, mode: state.shortVideo.mode }); },
    scheduleShortVideoWindowUpdate() {}, scheduleShortVideoAppendContinuation() {},
    loadShortVideoSummary: async () => {}, handleSummaryLoadError() {},
    pushRoute: value => routes.push(value), replaceRoute: value => routes.push(value),
    api: (url, options) => { const request = { url, options, ...deferred() }; requests.push(request); return request.promise; },
    cachedShortVideo: () => null, cachedShortVideoNavigation: () => null, rememberShortVideo() {}, prewarmShortVideoPlayback: async () => false,
    ensureShortVideoViewerStyles: () => pendingStyles ? styles.promise : Promise.resolve(true),
    flushActiveShortVideoWatch() {}, beginShortVideoNavigation() {}, resumeActiveSound() {}, hydratePromotedShortVideo: async () => {},
    loadAdjacentVideos: async () => false, scheduleInitialAdjacentPanelsRefresh() {}, shortVideoFriendlyError: (error, fallback) => error?.message || fallback,
    syncShortVideoNativePlaybackModes() {}, cancelShortVideoPanelLoading() {}, stopShortVideoSoundPreview() {}, cancelShortVideoAutoNext() {},
    cancelShortVideoBrowseGestures() {}, resetShortVideoWindow() {}, clearPendingPlayerClick() {}, releaseUnusedShortVideoPreloads() {},
    disposeShortVideoMedia, setBodyClass() {}, transcodeManagementPage: { stop() {}, activate() {}, render() { views.push({ transcode: true }); } },
    renderLikeDistributionPage() { views.push({ likes: true }); }, isLikeDistributionAuthorTableRoute: () => false,
    readLikeDistributionCache: () => ({}), setMainHeader() {}, loadLikeDistribution: async () => {},
    renderHome() { views.push({ home: true, mode: state.shortVideo.mode }); }, renderBrowserLoading() { views.push({ loading: true }); },
    renderAggregateSearchResults: data => ({ users: data.users }),
    renderBrowser() {
      media = { dataset: { videoId: state.shortVideo.current.id, shortVideoSlot: "current" }, currentTime: 0,
        id: ++mediaId, src: `/fixture/${state.shortVideo.current.id}`, paused: false, muted: false, pauses: 0, loads: 0, plays: 0,
        pause() { this.pauses++; this.paused = true; }, play() { this.plays++; this.paused = false; return Promise.resolve(); },
        removeAttribute(name) { if (name === "src") this.src = ""; }, load() { this.loads++; } };
      views.push({ current: state.shortVideo.current.id, media: media.id, mode: state.shortVideo.mode });
    }
  });
  vm.runInContext(code, env);
  const collections = createShortVideoCollectionsController({
    api: env.api, createIcon() {}, ensureListCards: async () => {}, getListCards: () => null,
    onScopeChange: () => env.invalidateShortVideoListWork(),
    onOpenVideo: (record, options) => env.openVideo(record.id, { ...options, video: record }),
    loadFeed: () => env.loadVideos({ skipRoute: true }), pushRoute: env.pushRoute, replaceRoute: env.replaceRoute,
    render: () => env.renderView(), setMainHeader() {}, showToast() {}, state
  });
  env.collectionsController = { ...collections, renderCollectionPage: () => ({}) };
  const playerState = () => media && ({ id: media.id, time: media.currentTime, paused: media.paused, muted: media.muted,
    src: media.src, pauses: media.pauses, loads: media.loads, plays: media.plays });
  const openCollection = async (id = "C", ids = ["C1"]) => {
    const previous = requests.length, pending = collections.openCollection(id, { skipRoute: true }); await settle();
    const batch = requests.slice(previous);
    batch.find(request => request.url === "/api/short-videos/collections")?.resolve({ collections: [{ id, name: id }] });
    batch.find(request => request.url.includes(`/collections/${id}/videos?`)).resolve({ collection: { id, name: id }, ...page(ids, { nextCursor: `${id}-cursor`, hasMore: true }) });
    await pending;
  };
  return { env, state, requests, views, routes, warnings, metrics, deleted, authors, styles, frames, collections, openCollection, playerState,
    holdStyles() { pendingStyles = true; }, get media() { return media; }, get stats() { return stats; } };
}

async function oldFeedCannotReplaceCollection(code) {
  for (const append of [false, true]) {
    const f = fixture({ code }), old = f.env.loadVideos({ append, keepCurrent: append, skipRoute: true });
    await f.openCollection(); const before = toJSON(f.state.shortVideo.data);
    f.requests[0].resolve(page(["old-feed"], { nextCursor: "wrong-feed-cursor", hasMore: true }));
    assert.equal(await old, SHORT_VIDEO_LOAD_STALE);
    assert.deepEqual(toJSON(f.state.shortVideo.data), before, "a previous feed response cannot replace or append into a collection window");
    assert.equal(f.state.shortVideo.mode, "collection"); assert.equal(f.state.shortVideo.collectionId, "C");
  }
}
await oldFeedCannotReplaceCollection();

async function sameScopeListPreservesPlayer(code) {
  for (const append of [false, true]) {
    for (const paused of [false, true]) {
      const f = fixture({ code }), old = f.env.loadVideos({ append, keepCurrent: append });
      await f.env.openVideo("A", { video: video("A") });
      f.media.currentTime = 7.9682; if (paused) f.media.pause();
      const player = f.media, before = f.playerState(), routes = f.routes.length, views = f.views.length;
      f.requests[0].resolve(page(["B", "C"], { hasMore: true, nextCursor: "cursor-2" })); await old;
      assert.equal(f.media === player, true, "a late same-scope list result cannot replace the current player node");
      assert.deepEqual(f.playerState(), before, "late list completion must preserve user pause, position and native media operations");
      assert.equal(f.views.length, views); assert.equal(f.routes.length, routes, "a background list cannot remove the opened video from its URL");
      assert.deepEqual(f.state.shortVideo.data.videos.map(item => item.id), append ? ["A", "B", "C"] : ["B", "C"], "legitimate same-scope data still publishes to the list cache");
      assert.equal(f.state.shortVideo.data.nextCursor, "cursor-2");
    }
  }
}
await sameScopeListPreservesPlayer();

for (const authorIndex of [false, true]) {
  for (const failure of [false, true]) {
    const f = fixture({ authorIndex }), old = f.env.loadVideos({ skipRoute: true });
    f.state.activeView = "other-module"; const before = toJSON(f.state.shortVideo.data), views = f.views.length;
    if (failure) f.requests[0].reject(new Error("old failure"));
    else f.requests[0].resolve(authorIndex ? { authors: [{ id: "late-author" }], total: 1 } : page(["late"]));
    assert.equal(await old, SHORT_VIDEO_LOAD_STALE); assert.equal(f.views.length, views);
    assert.deepEqual(toJSON(f.state.shortVideo.data), before, "leaving the module prevents late success/error from touching its former view");
  }
}
for (const authorIndex of [false, true]) {
  const f = fixture({ authorIndex }), first = f.env.loadVideos({ skipRoute: true });
  f.state.shortVideo.query = "new"; const newer = f.env.loadVideos({ skipRoute: true });
  f.requests[1].resolve(authorIndex ? { authors: [{ id: "new-author" }], total: 1 } : page(["new"])); await newer;
  const before = toJSON(f.state.shortVideo); f.requests[0].reject(new Error("old request rejected"));
  assert.equal(await first, SHORT_VIDEO_LOAD_STALE); assert.deepEqual(toJSON(f.state.shortVideo), before);
}
{
  const f = fixture(), old = f.env.loadVideos({ skipRoute: true });
  await f.env.openVideo("A", { video: video("A"), skipRoute: true }); f.media.pause(); f.media.currentTime = 8;
  const before = f.playerState(); f.requests[0].reject(new Error("list offline"));
  assert.equal(await old, false); assert.deepEqual(f.playerState(), before); assert.equal(f.state.shortVideo.loading, false);
  assert.match(f.state.shortVideo.status, /list offline/);
}
{
  const f = fixture({ authorPage: "author-A" }), list = f.env.loadVideos({ skipRoute: true });
  await f.env.openVideo("A", { video: video("A"), skipRoute: true }); f.media.pause(); const before = f.playerState();
  f.authors[0].resolve({ secUid: "author-A", name: "richer author" }); await settle();
  assert.deepEqual(f.playerState(), before, "late author profile metadata cannot rebuild a same-scope active player");
  f.requests[0].resolve(page(["A", "B"])); await list; assert.deepEqual(f.playerState(), before);
}

{
  const f = fixture(), first = f.env.loadVideos({ append: true, keepCurrent: true, skipRoute: true });
  await f.env.loadVideos({ append: true, keepCurrent: true, skipRoute: true }); assert.equal(f.requests.length, 1, "concurrent append entry points share the loading gate");
  assert.equal(new URL(f.requests[0].url, "http://fixture").searchParams.get("cursor"), "cursor-1");
  f.requests[0].resolve(page(["B", "C"], { nextCursor: "cursor-2", hasMore: true })); await first;
  assert.deepEqual(f.state.shortVideo.data.videos.map(item => item.id), ["A", "B", "C"]);
  const second = f.env.loadVideos({ append: true, keepCurrent: true, skipRoute: true });
  assert.equal(new URL(f.requests[1].url, "http://fixture").searchParams.get("cursor"), "cursor-2");
  f.requests[1].resolve(page(["C", "D"])); await second;
  assert.deepEqual(f.state.shortVideo.data.videos.map(item => item.id), ["A", "B", "C", "D"]);
}
for (const replacement of ["cursor", "window"]) {
  const f = fixture(), old = f.env.loadVideos({ append: true, keepCurrent: true, skipRoute: true });
  if (replacement === "cursor") f.state.shortVideo.data.nextCursor = "new-cursor";
  else f.state.shortVideo.data.videos = [video("different-window")];
  const before = toJSON(f.state.shortVideo.data); f.requests[0].resolve(page(["old"], { nextCursor: "old-next" }));
  assert.equal(await old, SHORT_VIDEO_LOAD_STALE); assert.deepEqual(toJSON(f.state.shortVideo.data), before);
  assert.equal(f.state.shortVideo.loadingMore, false, "an obsolete window cannot strand its append busy flag");
}
{
  const f = fixture(), append = f.env.loadVideos({ append: true, keepCurrent: true, skipRoute: true });
  f.deleted.add("A"); f.state.shortVideo.data.videos = [video("B")];
  f.requests[0].resolve(page(["A", "C"], { nextCursor: "cursor-2" })); await append;
  assert.deepEqual(f.state.shortVideo.data.videos.map(item => item.id), ["B", "C"], "accepted deletes are filtered without discarding legitimate in-flight pagination");
}

async function coldOpenCannotCrossScope(code) {
  for (const destination of ["collection", "likes", "transcoding", "other-module"]) {
    for (const failure of [false, true]) {
      const f = fixture({ code }), detail = deferred(); f.state.shortVideo.data.videos = [];
      const opening = f.env.openVideo("outside", { detailData: detail.promise, renderLoading: false, skipRoute: true }); await settle();
      if (destination === "collection") await f.openCollection();
      else if (destination === "other-module") f.state.activeView = destination;
      else { f.state.shortVideo.mode = destination; await f.env.openRouteTarget({ shortVideoMode: destination }); }
      const current = f.state.shortVideo.current, views = f.views.length;
      if (failure) detail.reject(new Error("old open rejected")); else detail.resolve({ video: video("outside") });
      assert.equal(await opening, false); assert.equal(f.state.shortVideo.current, current, "a cold open cannot install old video after a view/scope change");
      assert.equal(f.views.length, views); assert.equal(f.media, null);
    }
  }
}
await coldOpenCannotCrossScope();
{
  const f = fixture(), detail = deferred(); f.state.shortVideo.data.videos = [];
  const old = f.env.openVideo("outside", { detailData: detail.promise, renderLoading: false, skipRoute: true });
  await f.openCollection(); f.state.shortVideo.mode = "feed"; f.state.shortVideo.collectionId = "";
  detail.resolve({ video: video("outside") }); assert.equal(await old, false, "the collection intent also closes the feed→collection→feed ABA hole");
}
{
  const f = fixture(), old = f.env.loadVideos({ skipRoute: true }); await f.openCollection();
  f.state.shortVideo.mode = "feed"; f.state.shortVideo.collectionId = ""; const before = toJSON(f.state.shortVideo.data);
  f.requests[0].resolve(page(["old"])); assert.equal(await old, SHORT_VIDEO_LOAD_STALE); assert.deepEqual(toJSON(f.state.shortVideo.data), before);
}
{
  const f = fixture(); f.holdStyles(); const opening = f.env.openVideo("A", { video: video("A"), skipRoute: true });
  f.state.shortVideo.query = "new-scope"; f.styles.resolve(); assert.equal(await opening, false); assert.equal(f.media, null);
}

// Mutate only the guards in memory to confirm the production behavior tests
// detect their original races instead of merely checking source strings.
const unsafeRender = implementation.replaceAll("if (!shortVideoListHasViewer()) {", "if (true) {");
assert.notEqual(unsafeRender, implementation);
await assert.rejects(sameScopeListPreservesPlayer(unsafeRender), /late same-scope list result cannot replace/);
const unsafeList = implementation.replace('state.activeView !== "shortVideos" || owner.requestId !== shortVideoListRequestId || owner.scope !== shortVideoListScope()', "owner.requestId !== shortVideoListRequestId");
assert.notEqual(unsafeList, implementation);
{
  const f = fixture({ code: unsafeList }), old = f.env.loadVideos({ skipRoute: true });
  f.state.activeView = "other-module"; f.requests[0].resolve(page(["late"])); await old;
  assert.equal(f.views.length, 1, "negative control reproduces old list rendering after module leave");
}
const unsafeOpen = implementation.replace('requestId === shortVideoOpenRequestId && state.activeView === "shortVideos" && requestScope === shortVideoListScope()', "requestId === shortVideoOpenRequestId");
assert.notEqual(unsafeOpen, implementation);
await assert.rejects(coldOpenCannotCrossScope(unsafeOpen), /Expected values|cold open cannot install/);

console.log("short-video-list-lifecycle: passed actual list/open/collection ownership, paused player and URL retention, append windows/cursors, deleted filtering, stale errors and negative controls");

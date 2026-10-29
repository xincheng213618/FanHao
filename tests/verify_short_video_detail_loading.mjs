import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoMediaCache } from "../public/modules/short-videos/media-cache.js";
import { retryShortVideoCollectionRequest } from "../public/modules/short-videos/collection-request.js";

// Compose the actual page read/render/navigation functions, collection factory,
// media-cache and read deadline. API, layout and time alone are controlled.
// No real service, database, account, media or browser profile is touched.
async function prefix(relative, marker, names, transform = value => value) {
  const url = new URL(relative, import.meta.url);
  let code = fs.readFileSync(url, "utf8").replace(/\r\n/g, "\n");
  const end = code.indexOf(marker); assert(end > 0, marker); code = transform(code.slice(0, end));
  code = code.replace(/from "(\.\.?\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  code = code.replaceAll("import.meta.url", JSON.stringify(url.href));
  return import(`data:text/javascript;base64,${Buffer.from(`${code}\nexport {${names.join(",")}};`).toString("base64")}`);
}
const list = await prefix("./verify_short_video_list_lifecycle.mjs", "\nasync function oldFeedCannotReplaceCollection", ["fixture", "settle", "video", "take"]);
const collection = await prefix("./verify_short_video_collection_lifecycle.mjs", "\ntry {", ["fixture", "settle", "video", "page"]);
const previous = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  document: globalThis.document, window: globalThis.window, CSS: globalThis.CSS };
let clock = 0, sequence = 0, cases = 0;
const timers = new Map();
globalThis.setTimeout = (callback, delay = 0) => { const id = sequence++; timers.set(id, { callback, at: clock + Number(delay) }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
async function tick(duration) {
  const end = clock + duration;
  for (;;) {
    await list.settle();
    const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    clock = next[1].at; timers.delete(next[0]); next[1].callback();
  }
  clock = end; await list.settle();
}
function observe(promise) {
  const result = { status: "pending" };
  result.done = promise.then(value => { result.status = "fulfilled"; result.value = value; }, error => { result.status = "rejected"; result.error = error; });
  return result;
}
function detail(id) { return { video: list.video(id), prevId: "", nextId: "" }; }
function pageFixture({ honorAbort = true, deadline = true, actualAdjacent = false, preserveInvalidated = true } = {}) {
  const f = list.fixture(); collection.fixture();
  const nodes = [], requests = [], adjacent = [], toasts = [];
  let physical = 0, highWater = 0;
  const cache = createShortVideoMediaCache({
    api(url, options = {}) {
      physical++; highWater = Math.max(highWater, physical);
      return new Promise((resolve, reject) => {
        const request = { url, signal: options.signal, settled: false,
          resolve(value) { if (request.settled) return; request.settled = true; physical--; options.signal?.removeEventListener("abort", abort); resolve(value); },
          reject(error) { if (request.settled) return; request.settled = true; physical--; options.signal?.removeEventListener("abort", abort); reject(error); } };
        const abort = () => { if (honorAbort) request.reject(Object.assign(new Error("transport abort"), { name: "AbortError" })); };
        options.signal?.addEventListener("abort", abort, { once: true }); requests.push(request);
      });
    }, cacheAuthorPanelVideo() {}, cachedAuthorPanelVideo: () => null,
    getFeedParams: () => f.env.shortVideoFeedParams(), markPerformance() {},
    isGalleryPost: () => true, galleryImageEntries: () => [], shortVideoCardCoverUrl: () => "", canSpeculate: () => true
  });
  Object.assign(f.env, {
    shortVideoOpenReadController: null, shortVideoNavigationState: null, shortVideoAdjacentRequestId: 0,
    shortVideoWheelController: null, queuedAdjacentDirection: 0, shortVideoPageSuspended: false,
    shortVideoPlaybackLifecycleGeneration: 0, shortVideoInteractionState: { mergeVideo: value => value },
    fetchShortVideoDetail: cache.fetchDetail, shortVideoSearch: { label: () => "搜索短视频" },
    showShortVideoSearchOverlay() {}, authorPanelReturnFeed: null, showError: error => toasts.push(error.message),
    createIcon: () => document.createElement("span"), showBrowserToast: message => toasts.push(message),
    activePlayer: () => f.media, syncActiveControlBar() {}, warmVisibleAdjacentVideoPlayers() {},
    syncCurrentNavigationDom() {}, flushShortVideoAutoNext() {}, flushQueuedAdjacent() {}, cacheAuthorPanelVideo() {},
    refreshAdjacentPanelsDom() {}, syncAuthorPanelCurrentTile() {}, activeGalleryPlayer: () => null
  });
  f.env.isDeletedShortVideo = cache.isDeleted;
  f.env.rememberShortVideo = cache.rememberVideo;
  f.env.shortVideoVideoPrefetches = new Map();
  f.env.scheduleAdjacentNavigationPrefetch = () => {};
  if (actualAdjacent) f.env.api = (url, options) => new Promise((resolve, reject) => adjacent.push({ url, options, resolve, reject }));
  f.env.document.createElement = document.createElement;
  f.env.document.createTextNode = document.createTextNode;
  f.env.els.workGrid.append = node => nodes.push(node);
  let functions = ["contextualShortVideoDetail", "cancelShortVideoNavigation", "beginShortVideoNavigation", "isCurrentShortVideoNavigation",
    "hydratePromotedShortVideo", "prefetchAdjacentNavigation", "renderBrowserTop", "renderBrowserLoading", "showHome", "handleShortVideoPageHide", "handleShortVideoPageShow",
    ...(actualAdjacent ? ["loadAdjacentVideos"] : [])].map(list.take).join("\n");
  if (!preserveInvalidated) functions = functions.replace("if (data.shortVideoNavigationInvalidated === true)", "if (false)");
  vm.runInContext(functions, f.env);
  if (!deadline) f.env.runShortVideoRead = request => Promise.resolve().then(() => request(new AbortController().signal));
  return { ...f, nodes, requests, adjacent, toasts, cache, get media() { return f.media; }, get physical() { return physical; }, get highWater() { return highWater; },
    async close() {
      f.env.cancelShortVideoNavigation(); f.collections.cancelReads(); cache.releaseDetails({ force: true });
      requests.forEach(request => request.resolve(detail("closed"))); await list.settle();
      assert.equal(physical, 0); assert.equal(timers.size, 0);
    } };
}
const currentShell = f => f.nodes.at(-1);
const retryButton = f => currentShell(f).querySelectorAll("button").find(button => button.textContent === "重新加载");

async function invalidatedHydration(preserveInvalidated = true) {
  const f=pageFixture({actualAdjacent:true,preserveInvalidated});
  try {
    const rows=["p","a","b","c"].map(list.video); rows.forEach(f.cache.rememberVideo);
    f.state.shortVideo.data.videos=rows; f.state.shortVideo.current=rows[2];
    f.state.shortVideo.prevId="a"; f.state.shortVideo.prevVideo=rows[1]; f.state.shortVideo.nextId="c"; f.state.shortVideo.nextVideo=rows[3];
    const owner=f.env.beginShortVideoNavigation(rows[2],{prevKnown:true,nextKnown:true});
    const hydration=observe(f.env.hydratePromotedShortVideo(rows[2],owner)); await list.settle();
    f.cache.forgetVideos(["a"],rows); f.state.shortVideo.data.videos=rows.filter(video=>video.id!=="a");
    // The actual deletion consumer has already repaired the surviving B's
    // reverse neighbor to P before B's first metadata GET completes.
    f.state.shortVideo.prevId="p"; f.state.shortVideo.prevVideo=rows[0];
    f.requests[0].resolve({video:{...rows[2],title:"richer B metadata"},prevId:"a",prevVideo:rows[1],nextId:"c",nextVideo:rows[3]});
    await list.settle();
    assert.equal(f.state.shortVideo.current.title,"richer B metadata");
    assert.equal(f.state.shortVideo.prevId,"p","late invalidated membership cannot clear the repaired previous P");
    assert.equal(f.state.shortVideo.nextId,"c"); assert.equal(f.adjacent.length,2);
    f.adjacent.forEach(request=>request.resolve({video:request.url.includes("direction=prev")?rows[0]:rows[3]}));
    await hydration.done; assert.equal(hydration.value,true); assert.equal(owner.refreshNavigation,false);
    assert.equal(f.state.shortVideo.prevId,"p"); assert.equal(f.state.shortVideo.prevVideo.id,"p");
  } finally { await f.close(); }
}

try {
  {
    const f = pageFixture({ honorAbort: false }); f.state.shortVideo.data.videos = [];
    const classes = new Set(["app-module-loading"]);
    f.env.document.documentElement.classList = { remove: name => classes.delete(name) };
    const opening = observe(f.env.openVideo("cold", { skipRoute: true })); await list.settle();
    assert.equal(classes.has("app-module-loading"), false, "the rendered loading shell is visible while detail is still pending");
    assert.equal(f.state.shortVideo.loading, true); assert.equal(retryButton(f), undefined);
    await tick(12000);
    assert.equal(opening.status, "fulfilled"); assert.equal(opening.value, false);
    assert.equal(f.state.shortVideo.loading, false); assert.match(f.env.shortVideoOpenError, /超时/);
    assert(retryButton(f)); assert.equal(f.requests[0].signal.aborted, true);
    f.requests[0].resolve(detail("cold")); await list.settle(); assert.equal(f.state.shortVideo.current, null);
    retryButton(f).click(); await list.settle(); assert.equal(f.requests.length, 2);
    f.requests[1].resolve(detail("cold")); await list.settle(); assert.equal(f.state.shortVideo.current.id, "cold");
    await f.close(); cases++;
  }
  {
    const f = pageFixture(); f.state.shortVideo.data.videos = [];
    const old = observe(f.env.openVideo("same", {skipRoute:true})); await list.settle();
    f.env.showHome(); await list.settle();
    assert.equal(old.status, "fulfilled"); assert.equal(old.value, false); assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(f.state.shortVideo.loading, false); assert.equal(f.env.shortVideoOpeningId, "");
    const fresh = f.env.openVideo("same", {skipRoute:true}); await list.settle();
    assert.equal(f.requests.length, 2, "return/reopen cannot join a permanently waiting former owner");
    f.requests[1].resolve(detail("same")); assert.equal(await fresh, true);
    await f.close(); cases++;
  }
  for (const hadCurrent of [false, true]) {
    const f = pageFixture();
    if (hadCurrent) { await f.env.openVideo("A", {video:list.video("A"),skipRoute:true}); f.media.currentTime=7.9682; f.media.pause(); }
    const before = f.playerState(), player = f.media; f.holdStyles();
    const opening = observe(f.env.openVideo("B", {video:list.video("B"),skipRoute:true})); await list.settle();
    await tick(12000); assert.equal(opening.value, false);
    if (hadCurrent) {
      assert.equal(f.media, player); assert.deepEqual(f.playerState(), before, "stylesheet timeout retains the paused current player and its time");
      assert.match(f.toasts.at(-1), /界面加载超时/);
    } else { assert.match(f.env.shortVideoOpenError, /界面加载超时/); assert(retryButton(f)); }
    f.styles.resolve(); await list.settle(); assert.equal(f.state.shortVideo.current?.id || "", hadCurrent ? "A" : "");
    await f.close(); cases++;
  }
  {
    const f = pageFixture({honorAbort:false}); f.state.shortVideo.data.videos=[]; f.holdStyles();
    const opening = observe(f.env.openVideo("cold", {skipRoute:true})); await list.settle();
    f.requests[0].reject(new Error("detail failed before styles")); await list.settle();
    await tick(12000); assert.equal(opening.value, false); assert(retryButton(f));
    f.styles.resolve(); await f.close(); cases++;
  }
  {
    const f = pageFixture({honorAbort:false}); f.state.shortVideo.data.videos=[];
    const opens = [];
    for (let i=0;i<30;i++) { opens.push(observe(f.env.openVideo(`cold-${i}`, {skipRoute:true}))); await list.settle(); }
    assert.equal(f.highWater, 4, "page owners use the real cache physical budget even if a transport ignores abort");
    assert(opens.slice(0,-1).every(open => open.status === "fulfilled" && open.value === false));
    assert(f.cache.stats().detailQueued <= 1); assert.equal(f.env.shortVideoOpeningId, "cold-29");
    await tick(12000); assert.equal(opens.at(-1).value, false); assert(retryButton(f));
    await f.close(); cases++;
  }
  {
    const f = pageFixture(); await f.env.openVideo("A", {video:list.video("A"),skipRoute:true});
    const owner = f.env.shortVideoNavigationState;
    const old = observe(f.env.hydratePromotedShortVideo(f.state.shortVideo.current, owner)); await list.settle();
    await tick(12000); assert.equal(old.status, "rejected"); assert.equal(owner.status, "error"); assert.equal(owner.promise, null);
    const retry = f.env.hydratePromotedShortVideo(f.state.shortVideo.current, owner); await list.settle();
    assert.equal(f.requests.length, 2); f.requests[1].resolve(detail("A")); assert.equal(await retry, false);
    // The existing fixture deliberately returns false for adjacent layout work;
    // metadata completion itself must have made navigation known and retriable.
    assert.equal(owner.prevKnown, true); assert.equal(owner.promise, null);
    await f.close(); cases++;
  }
  {
    const f = pageFixture(); f.state.shortVideo.data.videos=[];
    const opening = observe(f.env.openVideo("cold", {skipRoute:true})); await list.settle();
    f.env.handleShortVideoPageHide(); await list.settle();
    assert.equal(opening.value, false); assert.equal(f.requests[0].signal.aborted, true);
    f.env.handleShortVideoPageShow(); assert.match(f.env.shortVideoOpenError, /中断/); assert(retryButton(f));
    await f.close(); cases++;
  }
  {
    const f = collection.fixture(); f.mount();
    const thumb = f.body.querySelector(".short-video-thumb-open");
    for (let i=0;i<25;i++) thumb.click(); await collection.settle();
    assert.equal(f.requests.length, 1); assert.equal(thumb.disabled, true); assert.equal(thumb.getAttribute("aria-busy"), "true");
    await tick(12000); assert.equal(f.requests[0].options.signal.aborted, true);
    assert.equal(thumb.disabled, false); assert.match(f.toasts.at(-1), /超时/);
    thumb.click(); await collection.settle(); assert.equal(f.requests.length, 2);
    f.requests[1].resolve(detail("a")); await collection.settle(); assert.equal(f.opens.at(-1).id, "a");
    f.requests[0].resolve(detail("old")); await collection.settle(); assert.equal(f.opens.length, 1);
    f.controller.cancelReads(); f.close(); assert.equal(timers.size, 0); cases++;
  }
  {
    const f = collection.fixture(); f.mount(); const thumbs=f.body.querySelectorAll(".short-video-thumb-open");
    thumbs[0].click(); await collection.settle(); thumbs[1].click(); await collection.settle();
    assert.equal(f.requests[0].options.signal.aborted, true); assert.equal(f.requests[1].options.signal.aborted, false);
    assert.equal(f.toasts.length, 0); f.controller.returnToFeed(); await collection.settle();
    assert.equal(f.requests[1].options.signal.aborted, true);
    f.requests.forEach(request=>request.resolve(detail("late"))); await collection.settle(); assert.equal(f.opens.length, 0);
    f.close(); assert.equal(timers.size, 0); cases++;
  }
  for (const deepLink of [false,true]) {
    const f=collection.fixture({mode:"feed"}); f.state.shortVideo.collectionsLoaded=false;
    const opening=observe(f.controller.openCollection("A",{skipRoute:true,...(deepLink?{videoId:"a"}:{})})); await collection.settle();
    f.requests.find(request=>/collections\/A\/videos\?/.test(request.path)).resolve(collection.page("A",["a"])); await collection.settle();
    if (deepLink) { f.requests.find(request=>/collections\/A\/videos\/a$/.test(request.path)).resolve(detail("a")); await collection.settle(); assert.equal(f.opens[0].id,"a"); }
    assert.equal(opening.status,"fulfilled", "a hung sidebar index cannot block ready collection content or its deep-link detail");
    if (!deepLink) assert.equal(f.renders.length,2);
    assert.equal(f.state.shortVideo.collectionsLoading,true);
    await tick(12000); assert.equal(f.state.shortVideo.collectionsLoading,false);
    assert.equal(f.toasts.length,0); f.controller.cancelReads(); f.close(); assert.equal(timers.size,0); cases++;
  }
  {
    const f=collection.fixture({mode:"feed"}), opens=[];
    for(let i=0;i<20;i++) { opens.push(observe(f.controller.openCollection(`scope-${i}`,{skipRoute:true}))); await collection.settle(); }
    const pages=f.requests.filter(request=>/\/videos\?/.test(request.path));
    assert.equal(pages.filter(request=>!request.options.signal.aborted).length,1);
    assert(opens.slice(0,-1).every(open=>open.status==="fulfilled"));
    f.controller.returnToFeed(); await collection.settle(); assert(pages.every(request=>request.options.signal.aborted));
    assert.equal(opens.at(-1).status,"fulfilled"); f.close(); assert.equal(timers.size,0); cases++;
  }
  {
    const f=collection.fixture({mode:"feed"}); f.mount();
    const opening=observe(f.controller.openCollection("cold-collection",{skipRoute:true})); await collection.settle();
    assert.match(f.body.querySelector(".short-video-status").textContent,/读取清单/);
    await tick(12000); assert.equal(opening.status,"rejected");
    assert.match(f.body.querySelector(".short-video-status").textContent,/超时/);
    const retry=f.body.querySelectorAll("button").find(button=>button.textContent==="重新加载"); assert(retry);
    retry.click(); await collection.settle(); assert.equal(f.requests.length,2);
    f.requests[1].resolve(collection.page("cold-collection",["fresh"])); await collection.settle();
    assert.equal(f.state.shortVideo.collectionData.videos[0].id,"fresh");
    assert.equal(f.body.querySelectorAll(".short-video-thumb-open").length,1);
    f.controller.cancelReads(); f.close(); assert.equal(timers.size,0); cases++;
  }
  {
    const f=collection.fixture(); f.mount(); f.removeButton("a").click(); await collection.settle();
    assert.equal(f.requests[0].options.method,"DELETE"); assert.equal(f.requests[0].options.signal,undefined);
    f.controller.cancelReads(); await tick(60000);
    assert.equal(f.requests.length,1,"read disposal does not retry or cancel an accepted mutation");
    f.requests[0].resolve({removed:true}); await collection.settle();
    assert.deepEqual(f.state.shortVideo.collectionData.videos.map(video=>video.id),["b","c"]);
    f.close(); assert.equal(timers.size,0); cases++;
  }
  {
    const controller=new AbortController(); let attempts=0;
    const pending=observe(retryShortVideoCollectionRequest(()=>{attempts++;return Promise.reject(Object.assign(new Error("busy"),{status:503,retryable:true}));},{signal:controller.signal}));
    await list.settle(); assert.equal(attempts,1); assert.equal(timers.size,1); controller.abort(); await list.settle();
    assert.equal(pending.status,"rejected"); assert.equal(pending.error.name,"AbortError");
    await tick(20000); assert.equal(attempts,1); assert.equal(timers.size,0); cases++;
  }
  await invalidatedHydration(); cases++;
  for (const knownFeed of [false,true]) {
    const f=pageFixture({actualAdjacent:true}); f.state.shortVideo.data.videos=[];
    const opening=observe(f.env.openVideo("b",{skipRoute:true})); await list.settle();
    const rows=["p","a","b","c"].map(list.video);
    f.cache.forgetVideos(["a"],rows);
    if(knownFeed) f.state.shortVideo.data.videos=rows.filter(video=>video.id!=="a");
    f.requests[0].resolve({video:rows[2],prevId:"a",prevVideo:rows[1],nextId:"c",nextVideo:rows[3]}); await list.settle();
    assert.equal(opening.value,true); assert.equal(f.state.shortVideo.prevId,knownFeed?"p":"");
    const owner=f.env.shortVideoNavigationState; assert.equal(owner.prevKnown,knownFeed); assert.equal(owner.nextKnown,knownFeed);
    assert.equal(owner.status,"pending"); assert.equal(f.adjacent.length,2,"an invalidated cold open refreshes both directions even without a known id");
    f.adjacent.forEach(request=>request.resolve({video:request.url.includes("direction=prev")?rows[0]:rows[3]})); await list.settle();
    assert.equal(f.state.shortVideo.prevId,"p"); assert.equal(f.state.shortVideo.nextId,"c"); assert.equal(owner.status,"ready");
    await f.close(); cases++;
  }
  {
    const f=pageFixture({actualAdjacent:true}); const rows=["p","a","b","c"].map(list.video);
    f.state.shortVideo.current=rows[2]; const owner=f.env.beginShortVideoNavigation(rows[2],{prevKnown:true,nextKnown:true});
    const prefetch=f.env.prefetchAdjacentNavigation(rows[3],1,f.env.shortVideoFeedParams(),owner); await list.settle();
    f.cache.forgetVideos(["a"],rows); f.requests[0].resolve({video:rows[3],prevId:"b",nextId:"far",nextVideo:list.video("far")}); await prefetch;
    assert.equal(f.adjacent.length,0,"invalidated membership cannot launch a far-neighbor speculation chain");
    await f.close(); cases++;
  }
  await assert.rejects(invalidatedHydration(false),/late invalidated membership cannot clear/); cases++;
  // Behavioral negative control: remove the actual read deadline at the seam.
  // A hung stylesheet is again a permanent opening, proving the UI assertion.
  async function stylesheetIsBounded(deadline) {
    const f=pageFixture({deadline}); f.holdStyles(); const opening=observe(f.env.openVideo("A",{video:list.video("A"),skipRoute:true}));
    await list.settle(); await tick(12000);
    try { assert.equal(opening.status,"fulfilled","stylesheet wait must settle at the read deadline"); }
    finally { f.styles.resolve(); await list.settle(); await f.close(); }
  }
  await assert.rejects(stylesheetIsBounded(false),/stylesheet wait must settle/); cases++;
  console.log(`short-video-detail-loading: passed ${cases} actual page/cache/collection groups (deadlines, retry, cancellation, bounded owners, sidebar independence, paused player, BFCache and negative control)`);
} finally {
  Object.assign(globalThis,previous); timers.clear();
}

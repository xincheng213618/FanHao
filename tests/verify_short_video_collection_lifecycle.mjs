import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoCollectionsController } from "../public/modules/short-videos/collections-controller.js";

// Real controller and restoration helpers; independently settle its API
// requests and native events without a service, database or actual media.
const domFixture = fs.readFileSync(new URL("./verify_short_video_reel_metadata.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const dom = vm.createContext({ EventTarget, Event });
vm.runInContext(`${domFixture.slice(domFixture.indexOf("class Element extends EventTarget"), domFixture.indexOf("\nconst page ="))}\nglobalThis.Element=Element;`, dom);
const Element = dom.Element;
const originalGlobals = { document: globalThis.document, window: globalThis.window, CSS: globalThis.CSS };
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const video = id => ({ id, title: id });
const page = (id, ids = [], extra = {}) => ({ collection: { id, name: id, itemCount: ids.length }, videos: ids.map(video), total: ids.length, hasMore: false, nextCursor: null, ...extra });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); return { promise, resolve, reject }; }

function fixture({ mode = "collection", collectionId = "A", ids = ["a", "b", "c"], hasMore = false } = {}) {
  const requests = [], opens = [], renders = [], toasts = [], notifications = [], scopes = [], frames = new Map(), scrolls = [];
  let frameSequence = 0, mounted = false;
  const collectionData = page(collectionId, ids, { hasMore, nextCursor: hasMore ? "cursor-1" : null });
  const state = { activeView: "shortVideos", shortVideo: { mode, collectionId: mode === "collection" ? collectionId : "", current: null,
    collectionData: mode === "collection" ? collectionData : null, data: { videos: ids.map(video), total: ids.length },
    collections: [{ id: "A", name: "A", itemCount: ids.length }, { id: "B", name: "B", itemCount: 2 }], collectionsLoaded: true,
    source: "liked", sort: "published", query: "", author: "all", prevId: "", nextId: "", prevVideo: null, nextVideo: null } };
  const body = new Element("body"); body.connected = true;
  globalThis.document = { body, activeElement: null, createElement: tag => new Element(tag),
    createTextNode: text => { const node = new Element("#text"); node.textContent = text; return node; },
    querySelector: selector => body.querySelector(selector) };
  dom.document = document;
  globalThis.window = { scrollY: 0, history: { length: 1, back() {} }, prompt: () => "Renamed", confirm: () => true,
    requestAnimationFrame(callback) { const handle = frameSequence++; frames.set(handle, callback); return handle; },
    cancelAnimationFrame: handle => frames.delete(handle), scrollTo: value => scrolls.push(value.top) };
  globalThis.CSS = { escape: String };
  let controller;
  const render = () => {
    renders.push({ view: state.activeView, collectionId: state.shortVideo.collectionId, current: state.shortVideo.current?.id || "" });
    if (mounted) body.replaceChildren(controller.renderCollectionPage());
  };
  const cards = { renderVideoCard(item) {
    const card = new Element("article"), thumb = new Element("button"); thumb.className = "short-video-thumb-open"; card.append(thumb); return card;
  } };
  controller = createShortVideoCollectionsController({
    state, render, createIcon: () => new Element("span"), ensureListCards: async () => cards, getListCards: () => cards,
    api(path, options) { const request = { path, options, ...deferred() }; requests.push(request); return request.promise; },
    onOpenVideo(item) { state.shortVideo.current = item; opens.push({ id: item.id, collectionId: state.shortVideo.collectionId, view: state.activeView }); return true; },
    onNavigationChange: () => notifications.push({ prev: state.shortVideo.prevId, next: state.shortVideo.nextId }),
    onScopeChange: () => scopes.push(true), loadFeed: () => {}, pushRoute() {}, replaceRoute() {}, setMainHeader() {}, showToast: value => toasts.push(value)
  });
  return { state, controller, body, requests, opens, renders, toasts, notifications, scopes, frames, scrolls,
    mount() { mounted = true; render(); },
    removeButton(id) { return body.querySelectorAll(".short-video-collection-remove").find(button => button.dataset.videoId === id); },
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
    close() { body.replaceChildren(); for (let i = 0; i < 3; i++) { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); } }
  };
}

try {
  for (const oldFirst of [true, false]) {
    const f = fixture();
    const old = f.controller.loadCollections({ force: true }), fresh = f.controller.loadCollections({ force: true });
    if (oldFirst) {
      f.requests[0].resolve({ collections: [{ id: "old" }] }); await old;
      assert.equal(f.state.shortVideo.collectionsLoading, true, "old completion cannot clear the new force request's busy owner");
      const shared = f.controller.loadCollections(); assert.equal(f.requests.length, 2, "ordinary callers join the latest forced download");
      f.requests[1].resolve({ collections: [{ id: "new" }] }); await shared;
    } else {
      f.requests[1].resolve({ collections: [{ id: "new" }] }); await fresh;
      f.requests[0].resolve({ collections: [{ id: "old" }] }); await old;
    }
    await fresh;
    assert.deepEqual(f.state.shortVideo.collections.map(item => item.id), ["new"]);
    assert.equal(f.state.shortVideo.collectionsLoading, false); f.close();
  }

  {
    const f = fixture();
    const a = f.controller.openCollection("A", { skipRoute: true, videoId: "a" });
    const b = f.controller.openCollection("B", { skipRoute: true, videoId: "b" });
    f.requests[1].resolve(page("B", ["b"])); await settle();
    assert.match(f.requests[2].path, /collections\/B\/videos\/b$/);
    f.requests[2].resolve({ video: video("b") }); await b;
    f.requests[0].resolve(page("A", ["a"])); await a;
    assert.equal(f.requests.length, 3, "old A cannot request A's video through the new B collection");
    assert.deepEqual(f.opens.map(item => `${item.collectionId}/${item.id}`), ["B/b"]); f.close();
  }
  {
    const f = fixture();
    const old = f.controller.openCollection("A", { skipRoute: true, videoId: "old" });
    const other = f.controller.openCollection("B", { skipRoute: true });
    const fresh = f.controller.openCollection("A", { skipRoute: true, videoId: "new" });
    f.requests[2].resolve(page("A", ["new"])); await settle();
    f.requests[3].resolve({ video: video("new") }); await fresh;
    f.requests[1].resolve(page("B", ["other"])); f.requests[0].resolve(page("A", ["old"]));
    await Promise.all([old, other]);
    assert.equal(f.requests.length, 4, "A-to-B-to-A requires the latest view intent, not an ID comparison");
    assert.deepEqual(f.opens.map(item => item.id), ["new"]); f.close();
  }
  for (const failure of [false, true]) {
    const f = fixture(); const pending = f.controller.openCollection("A", { skipRoute: true, videoId: "a" });
    const before = f.state.shortVideo.collectionData;
    f.state.activeView = "people";
    if (failure) f.requests[0].reject(new Error("obsolete")); else f.requests[0].resolve(page("A", ["late"]));
    await pending;
    assert.deepEqual(f.renders.map(item => item.view), ["shortVideos"]);
    assert.equal(f.opens.length, 0); assert.equal(f.toasts.length, 0);
    assert.equal(f.state.shortVideo.collectionData, before, "leaving the module prevents an old page from replacing its state"); f.close();
  }

  {
    const f = fixture({ ids: ["a"], hasMore: true });
    const first = f.controller.loadCollection("A", { append: true }), second = f.controller.loadCollection("A", { append: true });
    assert.equal(f.requests.length, 1, "same collection/cursor paging is single flight");
    f.requests[0].resolve(page("A", ["b"], { total: 2 })); await Promise.all([first, second]);
    assert.deepEqual(f.state.shortVideo.collectionData.videos.map(item => item.id), ["a", "b"]); f.close();
  }
  {
    const f = fixture({ ids: ["old"], hasMore: true });
    const refresh = f.controller.loadCollection("A"), append = f.controller.loadCollection("A", { append: true });
    assert.equal(f.requests.length, 1, "a retained old load-more control cannot supersede an initial refresh");
    f.requests[0].resolve(page("A", ["fresh"], { hasMore: true, nextCursor: "fresh-cursor", total: 2 })); await refresh; await settle();
    assert.match(f.requests[1].path, /cursor=fresh-cursor/);
    f.requests[1].resolve(page("A", ["next"], { total: 2 })); await append;
    assert.deepEqual(f.state.shortVideo.collectionData.videos.map(item => item.id), ["fresh", "next"]); f.close();
  }

  {
    const f = fixture(); f.mount(); f.removeButton("b").click();
    const open = f.controller.openCollection("B", { skipRoute: true });
    f.requests[1].resolve(page("B", ["b", "d"])); await open;
    const renders = f.renders.length;
    f.requests[0].resolve({ removed: true }); await settle();
    assert.deepEqual(f.state.shortVideo.collectionData.videos.map(item => item.id), ["b", "d"], "an A deletion cannot filter B's current dataset");
    assert.equal(f.state.shortVideo.collectionData.total, 2);
    assert.equal(f.state.shortVideo.collections.find(item => item.id === "A").itemCount, 2);
    assert.equal(f.renders.length, renders); assert.equal(f.toasts.length, 0); f.close();
  }
  {
    const f = fixture(); f.mount(); f.removeButton("b").click();
    f.state.shortVideo.current = video("a"); f.state.shortVideo.nextId = "b"; f.state.shortVideo.nextVideo = video("b");
    const renders = f.renders.length;
    f.requests[0].resolve({ removed: true }); await settle();
    assert.equal(f.state.shortVideo.nextId, "c", "a membership acknowledgement refreshes the surviving video's neighbors");
    assert.equal(f.renders.length, renders, "a late list control never rebuilds the player opened meanwhile");
    assert.equal(f.notifications.at(-1).next, "c"); f.close();
  }
  {
    const f = fixture({ ids: ["a", "b"], hasMore: true }); f.mount();
    const pending = f.controller.loadCollection("A", { append: true }); f.removeButton("b").click();
    f.requests[1].resolve({ removed: true }); await settle();
    f.requests[0].resolve(page("A", ["b", "late"], { total: 3 })); assert.equal(await pending, null);
    assert.deepEqual(f.state.shortVideo.collectionData.videos.map(item => item.id), ["a"], "an old GET cannot resurrect acknowledged membership deletion"); f.close();
  }
  {
    const f = fixture(); f.mount();
    const removeCollection = f.body.querySelectorAll("button").find(button => button.textContent === "删除清单");
    removeCollection.click();
    const next = f.controller.openCollection("B", { skipRoute: true }); f.requests[1].resolve(page("B", ["b"])); await next;
    const renders = f.renders.length;
    f.requests[0].resolve({ ok: true }); await settle();
    assert.equal(f.state.shortVideo.mode, "collection"); assert.equal(f.state.shortVideo.collectionId, "B");
    assert.equal(f.state.shortVideo.collectionData.collection.id, "B");
    assert.equal(f.state.shortVideo.collections.some(item => item.id === "A"), false);
    assert.equal(f.renders.length, renders); assert.equal(f.toasts.length, 0); f.close();
  }

  {
    const f = fixture({ mode: "feed" });
    const first = f.controller.openCollection("A"); f.requests[0].resolve(page("A", ["a"])); await first; f.mount();
    f.body.querySelectorAll("button").find(button => button.textContent === "删除清单").click();
    const next = f.controller.openCollection("B", { skipRoute: true }); f.requests[2].resolve(page("B", ["b"])); await next;
    f.requests[1].resolve({ ok: true }); await settle();
    f.controller.returnToFeed();
    assert.equal(f.state.shortVideo.mode, "feed");
    assert.equal(f.state.shortVideo.collections.some(item => item.id === "A"), false, "a retained feed snapshot cannot resurrect an acknowledged deleted collection");
    f.close();
  }

  {
    const f = fixture();
    const read = f.controller.loadCollectionVideoDetail("b");
    const append = f.controller.loadCollection("A");
    f.state.shortVideo.current = video("a"); f.controller.forgetVideos(["b"]);
    f.requests[0].resolve({ video: video("b") }); f.requests[1].resolve(page("A", ["a", "b", "c"]));
    assert.equal(await read, null); assert.equal(await append, null);
    assert.deepEqual(f.state.shortVideo.collectionData.videos.map(item => item.id), ["a", "c"]);
    assert.equal(f.state.shortVideo.nextId, "c");
    const later = f.controller.loadCollection("A"); f.requests[2].resolve(page("A", ["a", "b", "c"])); await later;
    assert.deepEqual(f.state.shortVideo.collectionData.videos.map(item => item.id), ["a", "c"], "a deleted video cannot return through another cached response"); f.close();
  }
  {
    const f = fixture();
    const opening = f.controller.openCollection("B", { skipRoute: true, videoId: "d" });
    f.controller.forgetVideos(["a"]);
    assert.equal(f.state.shortVideo.collectionLoading, true, "an unrelated deletion cannot clear the new collection's initial busy owner");
    f.requests[0].resolve(page("B", ["d"])); await settle();
    assert.match(f.requests[1].path, /collections\/B\/videos\/d$/);
    f.controller.forgetVideos(["other"]);
    f.requests[1].resolve({ video: video("d") }); await opening;
    assert.deepEqual(f.opens.map(item => item.id), ["d"], "an unrelated receipt cannot revoke a newer collection video choice"); f.close();
  }
  {
    const f = fixture(); f.mount();
    const thumb = f.body.querySelector(".short-video-thumb-open"); thumb.click();
    f.requests[0].resolve({ video: video("a") }); await settle();
    f.controller.forgetVideos(["b"]); f.controller.returnFromCollectionVideo();
    assert.deepEqual(f.state.shortVideo.collectionData.videos.map(item => item.id), ["a", "c"], "the collection return window is pruned with its live data");
    f.state.activeView = "people"; f.flushFrames(); f.flushFrames();
    assert.equal(f.scrolls.length, 0, "restoration callbacks retain the controller's module/view owner"); f.close();
  }

  {
    const f = fixture({ mode: "feed" });
    const index = f.controller.loadCollections({ force: true });
    const picker = f.controller.showPicker(null, { createOnly: true }); await picker;
    const overlay = f.body.querySelector(".short-video-collection-picker"), input = overlay.querySelector("input"); input.value = "Created";
    overlay.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }));
    overlay._closeCollectionPicker(); const renders = f.renders.length;
    f.requests[1].resolve({ collection: { id: "Created", name: "Created", itemCount: 0 } }); await settle();
    f.requests[0].resolve({ collections: [{ id: "old", name: "old" }] }); await index;
    assert.equal(f.state.shortVideo.collections.some(item => item.id === "Created"), true, "an old index snapshot cannot erase a completed create");
    assert.equal(f.state.shortVideo.collections.some(item => item.id === "old"), false);
    assert.equal(f.renders.length, renders); assert.equal(f.opens.length, 0); assert.equal(f.toasts.length, 0); f.close();
  }

  console.log("short-video-collection-lifecycle: passed actual force refresh ordering, view/ABA ownership, page single flight, membership/delete acknowledgements, neighbor continuity, deleted-video fences and restoration ownership");
} finally {
  Object.assign(globalThis, originalGlobals);
}

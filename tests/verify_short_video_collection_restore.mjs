import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/modules/short-videos/collection-navigation.js", import.meta.url), "utf8");
function fixture(implementation = source) {
  const frames = new Map(), cancelled = [], scrolls = [], focuses = [], roots = [];
  let frameId = 0, onScroll = null;
  function root() { const value = { isConnected: true, busy: false, getAttribute: () => value.busy ? "true" : null }; roots.push(value); return value; }
  let currentRoot = root();
  const context = vm.createContext({
    Date, CSS: { escape: value => value },
    window: {
      requestAnimationFrame(callback) { const id = frameId++; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { cancelled.push(id); frames.delete(id); },
      scrollTo(value) { scrolls.push(value); onScroll?.(); }
    },
    document: { querySelector(selector) { return selector === ".short-video-home" ? currentRoot : { focus: () => focuses.push(selector) }; } }
  });
  vm.runInContext(`${implementation.replace(/^export /gm, "")}\nglobalThis.api={captureCollectionWindow,restoreCollectionWindow,restoreCollectionPosition,captureCollectionFeedWindow,restoreCollectionFeedWindow};`, context);
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  const collection = { mode: "collection", collectionId: "A", current: null,
    collectionData: { collection: { id: "A", name: "A" }, videos: [{ id: "v1" }], total: 1, hasMore: false } };
  const feed = { mode: "feed", collectionId: "", current: null, source: "liked", query: "", data: { videos: [{ id: "v1" }], total: 1 } };
  return { api: context.api, frames, cancelled, scrolls, focuses, collection, feed, roots, flush,
    get root() { return currentRoot; },
    replaceRoot() { currentRoot.isConnected = false; currentRoot = root(); },
    onScroll(callback) { onScroll = callback; },
    snapshot: () => context.api.captureCollectionWindow(collection, 420, "v1"),
    feedSnapshot: () => context.api.captureCollectionFeedWindow(feed, 710, { closest: () => ({ dataset: { collectionId: "A" } }) }) };
}

{
  const f = fixture(), snapshot = f.snapshot();
  assert.equal(f.api.restoreCollectionWindow(f.collection, snapshot), true);
  assert.notEqual(f.collection.collectionData, snapshot.data);
  assert.notEqual(f.collection.collectionData.videos, snapshot.data.videos);
  f.flush(); assert.equal(f.scrolls.length, 0); f.flush();
  assert.equal(f.scrolls[0].top, 420); assert.match(f.focuses[0], /v1/); assert.equal(f.frames.size, 0);
}
{
  const f = fixture(), snapshot = f.feedSnapshot();
  assert.equal(f.api.restoreCollectionFeedWindow(f.feed, snapshot), true);
  f.flush(); f.flush(); assert.equal(f.scrolls[0].top, 710); assert.match(f.focuses[0], /sidebar-item/);
}
for (const phase of [0, 1]) {
  for (const change of ["route", "current", "data", "view", "root", "busy"]) {
    const f = fixture(); let currentView = true;
    f.api.restoreCollectionWindow(f.collection, f.snapshot(), () => {}, { isCurrent: () => currentView });
    if (phase) f.flush();
    if (change === "route") f.collection.collectionId = "B";
    if (change === "current") f.collection.current = { id: "new-player" };
    if (change === "data") f.collection.collectionData = { ...f.collection.collectionData };
    if (change === "view") currentView = false;
    if (change === "root") f.replaceRoot();
    if (change === "busy") f.root.busy = true;
    f.flush(); f.flush();
    assert.equal(f.scrolls.length, 0, `${change} before frame ${phase + 1} cannot scroll a superseding page`);
    assert.equal(f.focuses.length, 0); assert.equal(f.frames.size, 0);
  }
}
for (const change of ["query", "data", "current", "view"]) {
  const f = fixture(); let owned = true;
  f.api.restoreCollectionFeedWindow(f.feed, f.feedSnapshot(), () => {}, null, { isCurrent: () => owned });
  f.flush();
  if (change === "query") f.feed.query = "new search";
  if (change === "data") f.feed.data = { videos: [] };
  if (change === "current") f.feed.current = { id: "new-player" };
  if (change === "view") owned = false;
  f.flush(); assert.equal(f.scrolls.length, 0, `feed ${change} invalidates pending restoration`); assert.equal(f.focuses.length, 0);
}
{
  const f = fixture(); f.api.restoreCollectionPosition({ scrollY: 1 });
  const staleCallback = [...f.frames.values()][0];
  f.api.restoreCollectionPosition({ scrollY: 2 });
  assert.equal(f.cancelled[0], 0, "the first native RAF handle may be zero");
  staleCallback(); f.flush(); f.flush();
  assert.deepEqual(f.scrolls.map(value => value.top), [2], "latest restoration owns the scroll even if a cancelled callback is delivered");
}
{
  const f = fixture(); const cancel = f.api.restoreCollectionPosition({ scrollY: 5 });
  const late = [...f.frames.values()][0]; cancel(); late();
  assert.equal(f.frames.size, 0); assert.equal(f.scrolls.length, 0);
}
{
  const f = fixture(); f.api.restoreCollectionPosition({ scrollY: 6 });
  f.api.restoreCollectionPosition({ scrollY: 9 }, { isCurrent: () => false });
  f.flush(); f.flush(); assert.deepEqual(f.scrolls.map(value => value.top), [6], "an invalid stale restoration cannot cancel a current restoration");
  const collectionData = f.collection.collectionData, feedData = f.feed.data;
  assert.equal(f.api.restoreCollectionWindow(f.collection, f.snapshot(), () => assert.fail("stale render"), { isCurrent: () => false }), false);
  assert.equal(f.collection.collectionData, collectionData);
  assert.equal(f.api.restoreCollectionFeedWindow(f.feed, f.feedSnapshot(), () => assert.fail("stale render"), null, { isCurrent: () => false }), false);
  assert.equal(f.feed.data, feedData);
}
{
  const f = fixture(); f.api.restoreCollectionPosition({ scrollY: 5, focusVideoId: "old" });
  f.onScroll(() => f.replaceRoot()); f.flush(); f.flush();
  assert.equal(f.scrolls.length, 1); assert.equal(f.focuses.length, 0, "reentrant navigation during scroll must not focus a new page");
}
{
  const f = fixture(); const snapshot = f.snapshot();
  f.api.restoreCollectionWindow(f.collection, snapshot, () => { f.collection.collectionData = { videos: [] }; });
  f.flush(); f.flush(); assert.equal(f.scrolls.length, 0, "a render that supersedes restored data cannot receive its scroll");
}
{
  const f = fixture(); const before = f.feed.data;
  assert.equal(f.api.restoreCollectionFeedWindow(f.feed, f.feedSnapshot(), () => {}, { shortVideoMode: "feed", shortVideoSource: "history" }), false);
  assert.equal(f.feed.data, before); assert.equal(f.frames.size, 0);
  const expired = { ...f.snapshot(), createdAt: Date.now() - 301000 };
  assert.equal(f.api.restoreCollectionWindow(f.collection, expired), false); assert.equal(f.frames.size, 0);
}

function assertOldRestoreCannotScroll(implementation) {
  const f = fixture(implementation); f.api.restoreCollectionWindow(f.collection, f.snapshot());
  f.flush(); f.collection.current = { id: "new-player" }; f.flush();
  assert.equal(f.scrolls.length, 0, "a pending return cannot scroll after a new player opens");
}
assertOldRestoreCannotScroll(source);
const noStateGuard = source.replace('isCurrent: () => options.isCurrent?.() !== false && shortVideo.mode === "collection"', 'isCurrent: () => true || shortVideo.mode === "collection"');
assert.notEqual(noStateGuard, source);
assert.throws(() => assertOldRestoreCannotScroll(noStateGuard), /pending return cannot scroll/);
const noRootGuard = source.replace('&& document.querySelector(".short-video-home") === root', '&& true');
const old = fixture(noRootGuard); old.api.restoreCollectionPosition({ scrollY: 1 }); old.flush();
old.root.isConnected = true;
// A retained old root can remain connected while another home becomes active.
const doc = old.roots[0]; old.replaceRoot(); doc.isConnected = true; old.flush();
assert.equal(old.scrolls.length, 1, "negative control reproduces scrolling a replacement home when root identity is ignored");

console.log("short-video-collection-restore: passed real helper RAF ownership, route/data/view/root changes, zero-handle cancellation, latest return, focus and negative controls");

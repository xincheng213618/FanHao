import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { photoCatalogCollections } from "../public/modules/content-index/photo-catalog.js";
import { photoCatalogCollections as androidPhotoCatalogCollections } from "../android-client/www/platform/content-index/photo-catalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

// Validate only the standard DOM behavior added to the shared controlled double.
// Reader/card behavior below still executes production source, not this model.
{
  const document = createNavigationFixtureDocument();
  const left = document.createElement("div"), right = document.createElement("div"), nested = document.createElement("div");
  const first = document.createElement("button"), deep = document.createElement("button"), other = document.createElement("button");
  for (const node of [first, deep, other]) node.className = "channel-more";
  document.body.append(left, right); left.append(first, nested); nested.append(deep); right.append(other);
  assert.deepEqual(left.querySelectorAll(":scope > .channel-more"), [first]);
  assert.deepEqual(right.querySelectorAll(":scope > .channel-more"), [other]);
  const replacement = document.createElement("button"); first.replaceWith(replacement); replacement.focus({ preventScroll: true });
  assert.equal(document.activeElement, replacement); assert.equal(first.parentNode, null); assert.equal(replacement.parentNode, left);
  replacement.before(other); assert.deepEqual(right.children, []); assert.deepEqual(left.children, [other, replacement, nested]);
  other.remove(); assert.deepEqual(left.children, [replacement, nested]); assert.equal(other.parentNode, null);
}

const webPage = read("public", "modules", "content-index", "gallery-page.js");
assert(webPage.includes('sort: query ? "relevance"'), "Web photo search must request relevance order");
assert(webPage.includes("mergeImageLibraryListItems"), "Web photo pagination must merge offset pages");
assert(webPage.includes("targetCount - (options.force ? 0 : loadedCount)"), "Web photo pagination must request only the missing visible range");
assert(webPage.includes("const offset = options.force ? 0 : rawLoaded"), "Web photo pagination must advance over raw records independently of deduplicated cards");
assert(webPage.includes("refreshGalleryAfterLibraryChange({ preserveScroll: true })"), "Async Web gallery refreshes must preserve the current page position");
assert(webPage.includes("renderGalleryView({ preserveScroll: true })"), "Async Web gallery states must not reset the current page position");

const router = read("public", "js", "router.js");
assert(router.includes("photoSearch ? \"all\""), "A direct Web photo search must default to the full library");
assert(router.includes('galleryPhotoView === "collections" && !photoSearch ? "count" : "updated"'), "The photo collection catalog must default to count order");
assert(router.includes("next.gallerySort !== defaultGallerySort"), "The default photo collection order must keep the clean catalog URL");

const webRenderer = read("public", "modules", "content-index", "gallery-renderer.js");
assert(!webRenderer.includes('createGalleryFilterField("文件夹"'), "Web photo controls must not render the folder dropdown");
assert(!webRenderer.includes("galleryMoreObserver"), "Web photo pagination must not cascade through an intersection observer");
for (const marker of [
  "renderPagedImageLibrarySearchSummary",
  "gallerySearchMatchText",
  "多个词可同时匹配",
  "startingPhotoSearch",
  "photoSearchActive",
  '[["updated", "相关性排序"]]',
  'state.gallery.sort = "updated"',
  "search.value = nextQuery",
  "controls.append(searchRow, hierarchy)",
  "按相关性排序",
  "GALLERY_MORE_SCROLL_INTENT_MS",
  "GALLERY_MORE_GESTURE_IDLE_MS",
  "galleryMoreScrollCleanup",
  "galleryMoreGestureConsumed = true",
  "scheduleGestureRelease",
  "userScrollIntentUntil = 0",
  'addEventListener("touchend", handleTouchEnd',
  "captureGalleryScrollPosition",
  "restoreGalleryScrollPosition",
  "renderGalleryResults({ preserveScroll: true })",
  "renderGalleryView({ preserveScroll: true })",
  "item.albumSubject || fallbackSubject || meaningfulPerson",
  "collectionView ? collectionPerson"
]) {
  assert(webRenderer.includes(marker), `Web photo search is missing: ${marker}`);
}

const webStyles = read("public", "modules", "content-index", "styles.css");
assert(webStyles.includes("grid-template-columns: repeat(4, minmax(0, 1fr));"), "Desktop media lists must render four items per row");
assert(webStyles.includes("@media (max-width: 1100px)"), "The four-column media list must retain a responsive tablet fallback");

const photoStyles = read("public", "modules", "photos", "styles.css");
assert(photoStyles.includes("grid-template-columns: repeat(6, minmax(0, 1fr));"), "Desktop photo catalogs must render six items per row");
assert(photoStyles.includes(".gallery-photo-catalog-card .gallery-card-badges span"), "Photo catalog cards must expose their issue-count badge styling");

const catalogItems = photoCatalogCollections([
  {
    category: "分类甲",
    rootLabel: "根目录",
    collections: [
      { id: "new", title: "最近", albumCount: 2, size: 20, updatedAt: "2026-08-10T00:00:00.000Z" },
      { id: "large", title: "最多", albumCount: 20, size: 200, updatedAt: "2026-01-01T00:00:00.000Z" }
    ]
  }
], "updated");
assert.deepEqual(catalogItems.map((item) => item.id), ["new", "large"], "Photo catalog sorting must follow the selected order");
assert.equal(catalogItems[0].catalogCategory, "分类甲", "Flattened photo collections must keep their category context");
const sharedCatalogFixture = [{ category: "甲", collections: [
  { id: "a", title: "A2", albumCount: 10, size: 30, updatedAt: "2026-01-01" },
  { id: "b", title: "A10", albumCount: 20, size: 10, updatedAt: "2026-02-01" }
] }, { category: "乙", collections: [
  { id: "b", title: "duplicate", albumCount: 100 },
  { id: "c", title: "A1", albumCount: 20, size: 20, updatedAt: "2026-03-01" }
] }];
for (const sort of ["count", "updated", "size", "title"]) {
  assert.deepEqual(androidPhotoCatalogCollections(sharedCatalogFixture, sort), photoCatalogCollections(sharedCatalogFixture, sort), `Android and Web collection flattening, deduplication and ${sort} ordering must agree`);
}

const androidViews = read("android-client", "www", "platform", "content-index", "channel-views.js");
for (const marker of [
  "mergeChannelPageData",
  "rawLoaded",
  "channelSearchMatchText",
  "同时包含",
  '"relevance"'
]) {
  assert(androidViews.includes(marker), `Android photo search is missing: ${marker}`);
}
// Execute the actual path builder: media supports explicit search ordering,
// while photo search still requires relevance irrespective of a prior sort.
const photoSearchPath = source => {
  const functions = ["channelItemsPath", "normalizeChannelSort"].map(name => {
    const match = new RegExp(`^  function ${name}\\([\\s\\S]*?^  \\}`, "m").exec(source);
    assert(match, `Missing Android path function ${name}`);
    return match[0];
  });
  return vm.runInNewContext(`(() => {${functions.join("\n")}\nreturn channelItemsPath;})()`, { URLSearchParams });
};
const verifyPhotoSearchOrder = source => {
  const buildPath = photoSearchPath(source);
  for (const sort of ["updated", "count", "title", "size", "rating"]) {
    const query = new URL(buildPath("photo", 24, { query: "  合成 人物  ", sort, category: "分类甲", person: "人物甲" }, 24), "https://synthetic.invalid").searchParams;
    assert.equal(query.get("sort"), "relevance");
    assert.equal(query.get("q"), "合成 人物");
    assert.equal(query.get("category"), "分类甲");
    assert.equal(query.get("person"), "人物甲");
    assert.equal(query.get("offset"), "24");
    assert.equal(query.get("limit"), "24");
  }
  assert.equal(new URL(buildPath("photo", 24, { sort: "count", photoView: "collections" }), "https://synthetic.invalid").searchParams.get("sort"), "count");
};
verifyPhotoSearchOrder(androidViews);
const searchOrderBranch = ': text ? "relevance" : normalizeChannelSort(filters.sort)';
assert.equal(androidViews.split(searchOrderBranch).length, 2, "One photo search ordering branch");
assert.throws(() => verifyPhotoSearchOrder(androidViews.replace(searchOrderBranch, ': normalizeChannelSort(filters.sort)')), assert.AssertionError,
  "Removing photo relevance must fail the behavioral check");

// Execute current request/merge functions with controlled cache and transport.
// DOM rendering is a capture boundary here; real nodes/observers are covered by
// the Android channel Chromium verifier. No service, media or database is used.
const androidFunction = (name, source = androidViews) => {
  const match = new RegExp(`^  (?:async )?function ${name}\\([\\s\\S]*?^  \\}`, "m").exec(source);
  assert(match, `Missing actual Android function ${name}`);
  return match[0];
};
const plain = value => JSON.parse(JSON.stringify(value));
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const track = number => ({ type: "photo", id: `I${number}`, title: `Album ${number}` });
function pagingHarness(source = androidViews) {
  const calls = [], renders = [], writes = [];
  let limit = 24, activeUrl = "https://synthetic-a.invalid", reply = () => assert.fail("Unexpected request"), cached = null;
  const context = vm.createContext({ URLSearchParams, AbortController, Symbol,
    getChannelLimit: () => limit, getActiveUrl: () => activeUrl,
    normalizeChannelMode: value => value || "photo", channelConfig: () => ({ label: "相册" }),
    channelDataSignature: value => JSON.stringify(value), resetMangaReaderProgressTracker() {}, resetPreviewImageObserver() {},
    setActiveBottom() {}, updateModuleChrome() {}, setChannelMeta() {}, applyChannelHeader() {},
    renderCurrentViewPreservingScroll() {}, renderMessage: () => ({ dataset: {} }),
    els: { viewKicker: {}, viewTitle: {}, viewContent: { innerHTML: "" } },
    window: { setTimeout: () => 1, clearTimeout() {} },
    readCachedJson: async (base, path) => typeof cached === "function" ? cached(base, path) : cached,
    writeCachedJson: async (base, path, payload) => writes.push({ base, path, payload: plain(payload) }),
    renderChannelData: (mode, data, cache, paging) => renders.push({ mode, data: plain(data), cache, paging }),
    fetchJson: async (base, path, options) => {
      const url = new URL(path, base), call = { base, path, options, offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")) };
      calls.push(call); return await reply(call);
    }
  });
  vm.runInContext(`let channelPageState=null, channelRequestGeneration=0, channelRequestController=null, channelRenderingKey="", mountedChannelList=null;
    ${["renderChannel", "channelPageKey", "channelRevisionChanged", "loadConsistentChannelPage", "mergeChannelPageData", "channelItemKey", "channelItemsPath", "normalizeChannelSort", "cancelChannelRequest"].map(name => androidFunction(name, source)).join("\n")}
    globalThis.snapshot=()=>channelPageState;`, context);
  return { calls, renders, writes, render: params => context.renderChannel({ mode: "photo", photoView: "albums", ...params }),
    merge: context.mergeChannelPageData, changed: context.channelRevisionChanged, snapshot: () => plain(context.snapshot()),
    cancel: context.cancelChannelRequest, setLimit: value => { limit = value; }, setUrl: value => { activeUrl = value; },
    setReply: value => { reply = value; }, setCached: value => { cached = value; } };
}
let pagingGroups = 0;
{
  const h = pagingHarness();
  const first = h.merge(null, { items: [track(1), track(2)], total: 5, nextOffset: 2, listRevision: "A" });
  const next = h.merge(first, { items: [track(2), track(3)], total: 5, nextOffset: 4, listRevision: "A" }, 2);
  assert.deepEqual(plain(next.items).map(item => item.id), ["I1", "I2", "I3"]);
  assert.equal(next.rawLoaded, 4); assert.equal(next.hasMore, true);
  const end = h.merge(next, { items: [track(3)], total: 5, nextOffset: 5, listRevision: "A" }, 4);
  assert.equal(end.items.length, 3); assert.equal(end.rawLoaded, 5); assert.equal(end.hasMore, false);
  assert.equal(h.merge(first, { items: [track(3)] }, 2).total, 5, "legacy missing total retains the known total");
  assert.equal(h.merge(first, { items: [] }, 2).hasMore, false, "empty raw tail terminates even with stale total");
  assert.equal(h.merge(null, { items: [{ title: "No ID A" }, { title: "No ID B" }], total: 2 }).items.length, 2, "unidentified cards are not silently deduplicated");
  assert.equal(h.changed({ listRevision: "A", scannedAt: "same" }, { scannedAt: "same" }), true);
  assert.equal(h.changed({ scannedAt: "old" }, { scannedAt: "new" }), true);
  assert.equal(h.changed({}, { scannedAt: "new" }), true);
  assert.equal(h.changed({ scannedAt: "old" }, {}), true);
  assert.equal(h.changed({}, {}), false); pagingGroups++;
}
async function verifyRevisionRebuild(source = androidViews) {
  const h = pagingHarness(source); let revision = "A", items = Array.from({ length: 100 }, (_, i) => track(i + 1)), cap = 5000;
  h.setReply(call => ({ items: items.slice(call.offset, call.offset + Math.min(call.limit, cap)), total: items.length,
    listRevision: revision, nextOffset: Math.min(items.length, call.offset + Math.min(call.limit, cap)) }));
  await h.render(); h.setLimit(48); revision = "B"; items = [...items.slice(0, 23), ...items.slice(24), items[23]]; cap = 13;
  await h.render();
  assert.deepEqual(h.snapshot().data.items.map(item => item.id), items.slice(0, 48).map(item => item.id), "moving only the last loaded row cannot omit I25");
  assert.deepEqual(h.calls.slice(1).map(call => call.offset), [24, 0, 13, 26, 39]);
  assert.equal(h.snapshot().data.rawLoaded, 48); assert.equal(h.snapshot().data.listRevision, "B");
}
await verifyRevisionRebuild(); pagingGroups++;
for (const [previous, next] of [["", "new"], ["old", ""]]) {
  const h = pagingHarness(); let stamp = previous, items = Array.from({ length: 100 }, (_, i) => track(i + 1));
  h.setReply(call => ({ items: items.slice(call.offset, call.offset + call.limit), total: 100, scannedAt: stamp,
    nextOffset: Math.min(100, call.offset + call.limit) }));
  await h.render(); h.setLimit(48); stamp = next; items = [...items.slice(0, 23), ...items.slice(24), items[23]];
  await h.render();
  assert.deepEqual(h.calls.slice(1).map(call => call.offset), [24, 0]);
  assert.deepEqual(h.snapshot().data.items.map(item => item.id), items.slice(0, 48).map(item => item.id), "legacy empty scan stamps cannot prove the same snapshot"); pagingGroups++;
}
await assert.rejects(verifyRevisionRebuild(androidViews.replace('if (offset > 0 && channelRevisionChanged(base, data)) {', 'if (false) {')), assert.AssertionError,
  "Ignoring changed snapshots must fail the actual missing-I25 prefix assertion");
async function verifyRawCursor(source = androidViews) {
  const h = pagingHarness(source); h.setLimit(2);
  let response = 0;
  h.setReply(() => [
    { items: [track(1), track(2)], total: 5, nextOffset: 2 },
    { items: [track(2), track(3)], total: 5, nextOffset: 4 },
    { items: [track(4)], total: 5, nextOffset: 5 }
  ][response++]);
  await h.render(); h.setLimit(4); await h.render(); h.setLimit(6); await h.render();
  assert.equal(h.calls.at(-1).offset, 4, "deduplicated cards cannot replace the raw cursor");
  assert.equal(h.snapshot().data.hasMore, false); assert.equal(h.snapshot().data.items.length, 4);
}
await verifyRawCursor(); pagingGroups++;
await assert.rejects(verifyRawCursor(androidViews.replace('const offset = retryPage ? retryPage.offset : pageComplete ? 0 : rawLoaded;', 'const offset = retryPage ? retryPage.offset : pageComplete ? 0 : loadedCount;')), assert.AssertionError,
  "Restoring the previous unique-count offset must fail the actual request assertion");
{
  const h = pagingHarness(); let revision = "A";
  h.setReply(call => ({ items: Array.from({ length: call.limit }, () => track(1)), total: 1000, listRevision: revision,
    nextOffset: call.offset + call.limit }));
  await h.render(); h.setLimit(48); revision = "B";
  await h.render();
  assert.deepEqual(h.calls.map(call => [call.offset, call.limit]), [[0, 24], [24, 47], [0, 71]], "overlapping IDs rebuild only the original requested raw range");
  assert.equal(h.snapshot().data.rawLoaded, 71); assert.equal(h.snapshot().data.items.length, 1);
  assert.equal(h.snapshot().data.hasMore, true); pagingGroups++;
}
{
  const h = pagingHarness(); h.setLimit(6000);
  h.setReply(call => ({ items: Array.from({ length: call.limit }, (_, i) => track(call.offset + i + 1)), total: 9000,
    listRevision: "large", nextOffset: call.offset + call.limit }));
  await h.render(); assert.equal(h.snapshot().data.items.length, 6000);
  await h.render();
  assert.deepEqual(h.calls.map(call => [call.offset, call.limit]), [[0, 5000], [5000, 1000], [0, 5000], [5000, 1000]], "a same-range refresh retains all previously loaded rows across capped server segments");
  assert.equal(h.snapshot().data.rawLoaded, 6000); assert.equal(h.snapshot().data.items.length, 6000); pagingGroups++;
  const complete = h.writes.filter(entry => new URL(entry.path, entry.base).searchParams.get("limit") === "6000").at(-1);
  assert(complete, "completed segmented prefix is cached under the original requested range");
  const cold = pagingHarness(); cold.setLimit(6000);
  cold.setCached((_base, path) => path === complete.path ? { payload: complete.payload } : null);
  cold.setReply(() => { throw new Error("Cold offline"); }); await cold.render();
  assert.equal(cold.snapshot().data.items.length, 6000); assert.equal(cold.snapshot().data.rawLoaded, 6000); pagingGroups++;
  const partial = h.writes.find(entry => new URL(entry.path, entry.base).searchParams.get("limit") === "5000");
  const firstSegment = pagingHarness(); firstSegment.setLimit(6000);
  firstSegment.setCached((_base, path) => path === partial.path ? { payload: partial.payload } : null);
  firstSegment.setReply(() => { throw new Error("Offline before complete range"); }); await firstSegment.render();
  assert.equal(firstSegment.snapshot().data.items.length, 5000); assert.equal(firstSegment.snapshot().data.rawLoaded, 5000); pagingGroups++;
}
{
  const h = pagingHarness(); h.setReply(() => ({ items: Array.from({ length: 24 }, (_, i) => track(i + 1)), total: 28, listRevision: "same", nextOffset: 24 }));
  await h.render(); h.setLimit(72);
  h.setReply(() => ({ items: [track(1), track(25)], total: 28, listRevision: "same", nextOffset: 26 })); await h.render();
  assert.equal(h.calls.length, 2, "a stable short append commits its raw page without fetching more than the user's requested page");
  assert.equal(h.snapshot().data.rawLoaded, 26); assert.equal(h.snapshot().data.hasMore, true); pagingGroups++;
}
{
  const h = pagingHarness(); h.setLimit(48);
  h.setReply(call => ({ items: Array.from({ length: call.limit }, (_, i) => track(call.offset + i + 1)), total: 100,
    listRevision: "stable", nextOffset: call.offset + call.limit }));
  await h.render(); h.setLimit(24); await h.render();
  assert.deepEqual([h.calls.at(-1).offset, h.calls.at(-1).limit], [0, 24], "an explicit smaller restored range cannot inherit the larger prior range");
  assert.equal(h.snapshot().data.items.length, 24); pagingGroups++;
}
{
  const h = pagingHarness(), items = Array.from({ length: 24 }, (_, i) => track(i + 1));
  h.setReply(() => ({ items, total: 100, listRevision: "A", nextOffset: 24 })); await h.render(); h.setLimit(48);
  let changing = 0;
  h.setReply(() => ({ items, total: 100, listRevision: `changing-${++changing}`, nextOffset: 24 })); await h.render();
  assert.equal(changing, 7, "one append plus at most three two-segment prefix attempts");
  assert.equal(h.snapshot().data.listRevision, "A"); assert.equal(h.snapshot().retry.offset, 24);
  assert.equal(h.snapshot().retry.limit, 24); assert.equal(h.renders.at(-1).paging.status, "error");
  h.setReply(call => ({ items: Array.from({ length: call.limit }, (_, i) => track(call.offset + i + 1)), total: 100, listRevision: "B", nextOffset: call.offset + call.limit }));
  await h.render(); assert.deepEqual(h.calls.slice(-2).map(call => call.offset), [24, 0]); assert.equal(h.snapshot().data.items.length, 48); pagingGroups++;
}
{
  const h = pagingHarness(); h.setReply(() => ({ items: Array.from({ length: 24 }, (_, i) => track(i + 1)), total: 100, listRevision: "A", nextOffset: 24 }));
  await h.render(); h.setLimit(48);
  h.setCached({ payload: { items: Array.from({ length: 24 }, (_, i) => track(i + 25)), total: 100, listRevision: "A", nextOffset: 48 } });
  h.setReply(() => { throw new Error("Controlled offline tail"); }); await h.render();
  assert.equal(h.snapshot().data.items.length, 48); assert.equal(h.snapshot().retry.offset, 24);
  h.setCached(null); h.setReply(call => ({ items: Array.from({ length: call.limit }, (_, i) => track(i + call.offset + 1)), total: 100, listRevision: "A", nextOffset: call.offset + call.limit }));
  await h.render(); assert.equal(h.calls.at(-1).offset, 24); assert.equal(h.calls.at(-1).limit, 24); assert.equal(h.snapshot().data.items.length, 48); pagingGroups++;
}
{
  const h = pagingHarness(); h.setReply(() => ({ items: Array.from({ length: 24 }, (_, i) => track(i + 1)), total: 100, listRevision: "A", nextOffset: 24 }));
  await h.render(); h.setLimit(48); let requests = 0;
  h.setReply(call => {
    if (++requests === 2) throw new Error("Controlled prefix read failure");
    return { items: [track(90)], total: 100, listRevision: "B", nextOffset: call.offset + 1 };
  });
  await h.render(); assert.deepEqual(h.calls.slice(-2).map(call => call.offset), [24, 0]);
  assert.equal(h.snapshot().data.items.length, 24); assert.equal(h.snapshot().data.listRevision, "A");
  assert.equal(h.snapshot().retry.offset, 24); assert.equal(h.snapshot().retry.base.listRevision, "A"); pagingGroups++;
}
for (const obsolete of ["success", "error", "server", "deactivate"]) {
  const h = pagingHarness(), held = gate(); h.setReply(() => held.promise);
  const old = h.render(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.calls.length, 1);
  if (obsolete === "deactivate") h.cancel();
  else {
    if (obsolete === "server") h.setUrl("https://synthetic-b.invalid");
    h.setReply(() => ({ query: "new", items: [track(90)], total: 1, listRevision: "B", nextOffset: 1 })); await h.render({ query: "new" });
  }
  assert.equal(h.calls[0].options.signal.aborted, true);
  const rendered = h.renders.length, written = h.writes.length;
  if (obsolete === "error") held.reject(new Error("Late old error")); else held.resolve({ items: [track(1)], total: 1, listRevision: "A", nextOffset: 1 });
  await old; assert.equal(h.renders.length, rendered); assert.equal(h.writes.length, written, "obsolete transport cannot overwrite the same cached path"); pagingGroups++;
}
console.log(`android-channel-paging: ${pagingGroups} actual-source groups PASS (raw cursor/EOF, rebase, bounded changing snapshots, original-range retry, cancelled late success/error)`);
assert(androidViews.includes('{ requireScrollIntent: mode === "photo" }'), "Android photo list pagination must require fresh downward scroll intent");
assert(androidViews.includes("}, { requireScrollIntent: true });"), "Android photo reader pagination must require fresh downward scroll intent");

const androidAutoLoad = read("android-client", "www", "js", "auto-load.js");
for (const marker of [
  "options.requireScrollIntent === true",
  "AUTO_LOAD_SCROLL_INTENT_MS",
  "AUTO_LOAD_GESTURE_IDLE_MS",
  "markUserScrollIntent",
  "scrollGestureConsumed = true",
  "scheduleScrollGestureRelease",
  "movedDown",
  "userScrollIntentUntil = 0",
  'addEventListener("touchend", handleTouchEnd'
]) {
  assert(androidAutoLoad.includes(marker), `Android photo auto-load intent guard is missing: ${marker}`);
}
assert(!androidAutoLoad.includes("entries.some((entry) => entry.isIntersecting)) run()"), "Android photo auto-load must not run directly from intersection alone");

const androidApp = read("android-client", "www", "app.js");
assert(androidApp.includes("startingPhotoSearch"), "Android must reset implicit photo filters when starting a search");

const service = read("src", "modules", "content-index", "server", "image-library-service.js");
for (const marker of [
  "preparedPhotoCatalog",
  "createImageSearchQuery",
  "compareImageSearchResults",
  "matchFields"
]) {
  assert(service.includes(marker), `photo search service is missing: ${marker}`);
}

console.log("photo-search-clients: ok");

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { channelAccountBoundary, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureAccountOwner, rememberAccountPayload, setAccountOwner } from "../android-client/www/js/account-owner.js";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { formatBytes, formatDate, formatNumber } from "../android-client/www/js/format.js";

// The full current channel factory and actual photo-tile click handler execute.
// DOM, image loading, viewer presentation, HTTP/cache completion and clocks are
// synthetic boundaries. No real server, media, account or database is accessed.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("android-client/www/platform/content-index/channel-views.js");
const autoLoadSource = read("android-client/www/js/auto-load.js").replace(/^export /gm, "");
const legacy = JSON.parse(read("tests/fixtures/android-photo-viewer-requests-before-fix.json"));
assert.equal(createHash("sha256").update(JSON.stringify(legacy.functions)).digest("hex"),
  "bd1b271f2bb09ded7e17fc7cb985308be08082398d067ffddd4404d677e84ef7");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));
let harnessId = 0;
const album = (tag = "current", id = "same-album", count = 3) => ({
  id, title: `Synthetic ${tag}`, imageCount: count,
  images: Array.from({ length: count }, (_, i) => ({ index: i + 1, url: `/synthetic/${tag}-${i + 1}.svg` }))
});
const indexedAlbum = () => {
  const value = album();
  return { ...value, updatedAt: "2026-10-01", imageOffset: 0, imageLimit: 1, imagesTruncated: true,
    images: value.images.map(image => ({ ...image, url: `/media/gallery/${value.id}/${image.index}` })) };
};

function oldInput() {
  let input = source;
  for (const [name, old] of Object.entries(legacy.functions)) {
    const at = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(input);
    assert(at, name);
    const tail = input.slice(at.index), end = /^  \}/m.exec(tail);
    assert(end, name);
    input = input.slice(0, at.index) + old + input.slice(at.index + end.index + 3);
  }
  return input;
}

function harness(input = source) {
  const A = `https://synthetic-photo-${++harnessId}-a.invalid`, B = `https://synthetic-photo-${harnessId}-b.invalid`;
  let activeUrl = A;
  setAccountOwner(A, "guest", { force: true });
  setAccountOwner(B, "guest", { force: true });
  const document = createNavigationFixtureDocument(), proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) Object.defineProperty(proto, "isConnected", {
    get() { return this.ownerDocument.body.contains(this); }
  });
  const create = document.createElement;
  document.createElement = tag => {
    const element = create(tag);
    element.style = { removeProperty() {} };
    return element;
  };
  const cacheQueue = [], networkQueue = [];
  const calls = { cache: [], fetch: [], writes: [], updates: [], accepted: [] };
  const viewer = {
    current: null,
    openImage(url, title, options) { this.current = { url, title, ...plain(options) }; },
    close() { this.current = null; },
    updateItems(items, options) {
      calls.updates.push({ items: plain(items), options: plain(options) });
      if (!this.current || this.current.sourceKey !== options.sourceKey) return false;
      this.current.items = plain(items);
      calls.accepted.push(plain(items));
      return true;
    }
  };
  const window = { history: { back() {} }, navigator: { onLine: true }, requestAnimationFrame() {},
    addEventListener() {}, removeEventListener() {}, setTimeout() {}, clearTimeout() {}, scrollTo() {} };
  const context = vm.createContext({
    ...channelAccountBoundary, document, console, URL, URLSearchParams, AbortController, absoluteUrl, formatBytes, formatDate, formatNumber,
    HTMLButtonElement: document.body.constructor, cacheAgeText: () => "合成缓存", isChannelFavorite: () => false,
    window,
    readCachedJson: async (base, path) => {
      calls.cache.push({ base, path });
      const value = cacheQueue.length ? cacheQueue.shift() : null;
      return await (value?.promise || value);
    },
    fetchJson: async (base, path, options = {}) => {
      assert([A, B].includes(base), "Only synthetic sources are permitted");
      calls.fetch.push({ base, path, options });
      assert(networkQueue.length, "Every network response must be explicitly supplied");
      const value = networkQueue.shift();
      if (value instanceof Error) throw value;
      // Deliberately ignore AbortSignal to exercise late responses as well.
      return await (value?.promise || value);
    },
    writeCachedJson: async (...args) => { calls.writes.push(args); return {}; }
  });
  vm.runInContext(autoLoadSource, context, { filename: "actual-auto-load.js" });
  const exposure = /  return \{\r?\n(?=    deactivate:)/;
  assert(exposure.test(input));
  const executable = input.replace(exposure, "  return {\n    __createPhotoTile: createPhotoTile,\n    __rememberPhotoViewerRange: rememberPhotoViewerRange,\n")
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(executable, context, { filename: "actual-photo-channel-views.js" });
  const els = { viewContent: document.body, viewKicker: create("span"), viewTitle: create("span"), viewMeta: create("span") };
  let photoImageLimit = 2;
  const factory = context.createChannelViews({
    els, getActiveUrl: () => activeUrl,
    getChannelLimit: () => 24, increaseChannelLimit() {}, openInLibrary() {},
    getPhotoImageLimit: () => photoImageLimit, increasePhotoImageLimit: amount => { photoImageLimit += amount; },
    setActiveBottom() {}, renderCurrentView() {}, getMediaViewer: () => viewer
  });
  return {
    A, B, calls, viewer, factory, cacheQueue, networkQueue, window, document, els,
    switchServer(value = B) { activeUrl = value; },
    switchAccount() { setAccountOwner(activeUrl, "account:synthetic", { force: true }); },
    verify(value, scope = captureAccountOwner(activeUrl)) {
      const data = rememberAccountPayload({ album: { ...value, images: value.images.slice(0, 1) } }, scope);
      factory.__rememberPhotoViewerRange(value, data, activeUrl);
    },
    mount(value = album(), { loaded = 1 } = {}) {
      const images = value.images.slice(0, loaded);
      const tile = factory.__createPhotoTile(value, images[0], images, { index: 0 });
      document.body.append(tile);
      return tile;
    },
    open(value, options) {
      const tile = this.mount(value, options);
      tile.click();
      return tile;
    }
  };
}

const tests = [];
const test = (name, run, oldFails = false) => tests.push({ name, run, oldFails });
const photoPage = (value, imageOffset, imageLimit) => ({ album: {
  ...value, imageOffset, imageLimit, imagesTruncated: imageOffset + imageLimit < value.imageCount,
  images: value.images.slice(imageOffset, imageOffset + imageLimit)
} });
const requestOffsets = h => h.calls.fetch.map(({ path }) => Number(new URL(path, h.A).searchParams.get("imageOffset") || 0));
const visiblePhotoUrls = h => h.document.querySelectorAll(".photo-preview-tile").map(tile => tile.querySelector("img").dataset.photoSrc);

test("Android photo detail rebases after an archive shrinks before the library is rescanned", async input => {
  const h = harness(input);
  const old = { ...album("old", "replacement", 4), archiveIdentity: "same-index-entry", updatedAt: "2026-10-01" };
  const fresh = { ...old, ...album("fresh", old.id, 1) };
  h.networkQueue.push(photoPage(old, 0, 2), photoPage(fresh, 2, 24), photoPage(fresh, 0, 26));
  await h.factory.renderPhotoDetail(old.id);
  h.document.querySelector(".channel-more").click(); await flush();
  assert.deepEqual(requestOffsets(h), [0, 2, 0], "an obsolete offset must restart at the first page");
  assert.deepEqual(visiblePhotoUrls(h), [h.A + fresh.images[0].url]);
  assert.equal(h.document.querySelector(".channel-more"), null);
});

test("Android photo detail appends on the same archive and retries an empty page at the same offset", async input => {
  const h = harness(input), value = album("unchanged", "same-archive", 4);
  h.networkQueue.push(photoPage(value, 0, 2), photoPage(value, 2, 0), photoPage(value, 2, 24));
  await h.factory.renderPhotoDetail(value.id);
  const first = h.document.querySelector(".photo-preview-tile");
  const more = h.document.querySelector(".channel-more");
  more.click(); await flush();
  assert.equal(more.dataset.autoLoad, "error", "an empty non-final page must leave a retry control");
  assert.equal(visiblePhotoUrls(h).length, 2);
  more.click(); await flush();
  assert.deepEqual(requestOffsets(h), [0, 2, 2]);
  assert.equal(h.calls.fetch[1].path, h.calls.fetch[2].path, "retry must keep the original window");
  assert.deepEqual(visiblePhotoUrls(h), value.images.map(image => h.A + image.url));
  assert.equal(h.document.querySelector(".photo-preview-tile"), first, "ordinary append keeps existing tiles");
  assert.equal(h.document.querySelector(".channel-more"), null);
});

test("Android photo detail retries a failed archive reset from offset zero", async input => {
  const h = harness(input);
  const old = { ...album("old", "archive-change", 4), updatedAt: "2026-10-01", archiveIdentity: "before" };
  const fresh = { ...old, ...album("fresh", old.id, 4), archiveIdentity: "after" };
  h.networkQueue.push(photoPage(old, 0, 2), photoPage(fresh, 2, 24), new Error("Synthetic unavailable"), photoPage(fresh, 0, 26));
  await h.factory.renderPhotoDetail(old.id);
  const more = h.document.querySelector(".channel-more");
  more.click(); await flush();
  assert.equal(more.dataset.autoLoad, "error");
  assert.deepEqual(visiblePhotoUrls(h), old.images.slice(0, 2).map(image => h.A + image.url));
  more.click(); await flush();
  assert.deepEqual(requestOffsets(h), [0, 2, 0, 0]);
  assert.deepEqual(visiblePhotoUrls(h), fresh.images.map(image => h.A + image.url));
  assert.equal(h.calls.writes.at(-1)[3].fence.account.origin, h.A);
});

test("Android photo detail refreshes cached tiles when only the live archive identity changed", async input => {
  const h = harness(input), refresh = deferred();
  const cached = { ...album("same-pages", "new-identity", 4), updatedAt: "2026-10-01", archiveIdentity: "before" };
  h.cacheQueue.push({ payload: photoPage(cached, 0, 2) });
  h.networkQueue.push(refresh);
  const ready = h.factory.renderPhotoDetail(cached.id);
  await flush();
  const oldTile = h.document.querySelector(".photo-preview-tile");
  assert(oldTile?.isConnected);
  refresh.resolve(photoPage({ ...cached, archiveIdentity: "after" }, 0, 2));
  await ready;
  assert.equal(oldTile.isConnected, false, "the same-count archive can replace the mounted detail before a rescan");
  assert.deepEqual(visiblePhotoUrls(h), cached.images.slice(0, 2).map(image => h.A + image.url));
});

test("Android photo detail ignores a stale first-page refresh after a cached detail rebases", async input => {
  const h = harness(input), staleRefresh = deferred();
  const old = album("old", "cached-archive", 4), fresh = album("fresh", old.id, 1);
  h.cacheQueue.push({ payload: photoPage(old, 0, 2) });
  h.networkQueue.push(staleRefresh, photoPage(fresh, 2, 24), photoPage(fresh, 0, 26));
  const ready = h.factory.renderPhotoDetail(old.id);
  await flush();
  h.document.querySelector(".channel-more").click(); await flush();
  assert.deepEqual(visiblePhotoUrls(h), [h.A + fresh.images[0].url]);
  staleRefresh.resolve(photoPage(old, 0, 2));
  await ready;
  assert.deepEqual(visiblePhotoUrls(h), [h.A + fresh.images[0].url]);
  assert.equal(h.calls.writes.length, 1, "a stale first-page refresh must not overwrite the cache");
});

for (const boundary of ["navigation", "account", "server"]) {
  test(`Android photo detail discards an archive reset after a ${boundary} change`, async input => {
    const h = harness(input), pending = deferred(), controller = new AbortController();
    const guard = Object.assign(() => !controller.signal.aborted, { signal: controller.signal });
    const old = album("old", "retired-archive", 4), fresh = album("fresh", old.id, 1);
    h.networkQueue.push(photoPage(old, 0, 2), photoPage(fresh, 2, 24), pending);
    await h.factory.renderPhotoDetail(old.id, guard);
    h.document.querySelector(".channel-more").click(); await flush();
    assert.deepEqual(requestOffsets(h), [0, 2, 0]);
    assert.equal(h.calls.fetch.at(-1).options.signal, controller.signal);
    assert.equal(h.calls.fetch.at(-1).options.accountScope.origin, h.A);
    if (boundary === "navigation") controller.abort();
    else if (boundary === "account") h.switchAccount();
    else h.switchServer();
    pending.resolve(photoPage(fresh, 0, 26)); await flush();
    assert.deepEqual(visiblePhotoUrls(h), old.images.slice(0, 2).map(image => h.A + image.url));
    assert.equal(h.calls.writes.length, 1, "a retired reset cannot publish a new cached first page");
  });
}

test("fresh numbered photo prefix opens the full viewer without cache or HTTP", async input => {
  const h = harness(input), value = indexedAlbum();
  h.verify(value); h.open(value); await flush();
  assert.deepEqual(h.viewer.current.items.map(item => item.url), value.images.map(image => h.A + image.url));
  assert(h.viewer.current.items.every(item => item.title === value.title));
  assert.equal(h.calls.cache.length, 0); assert.equal(h.calls.fetch.length, 0);
  const [base, path, payload, options] = h.calls.writes[0];
  assert.equal(base, h.A);
  assert.equal(path, `android:photo-viewer-range/${value.id}`);
  assert.deepEqual(plain(payload), { id: value.id, total: value.imageCount, updatedAt: value.updatedAt });
  assert.equal(options.fence.account.origin, h.A);
  h.open(value); await flush();
  assert.equal(h.calls.writes.length, 1, "reopening the same live detail does not rewrite the descriptor");
});
for (const mode of ["cached-only", "offline", "legacy-url", "noncontiguous", "changed-stamp", "large-count", "retired-payload"]) {
  test(`numbered photo viewer preserves hydration for ${mode}`, async input => {
    const h = harness(input), value = indexedAlbum();
    if (mode === "legacy-url") value.images[0].url = "/legacy/first";
    if (mode === "noncontiguous") value.images[0] = value.images[1];
    if (mode === "large-count") value.imageCount = 10001;
    if (mode === "offline") h.window.navigator.onLine = false;
    const scope = captureAccountOwner(h.A);
    if (mode === "retired-payload") h.switchAccount();
    if (mode !== "cached-only") h.verify(value, scope);
    if (mode === "changed-stamp") value.updatedAt = "2026-10-02";
    h.networkQueue.push(new Error("Synthetic unavailable"));
    h.open(value);
    assert.equal(h.viewer.current.items.length, 1);
    await flush();
    assert.equal(h.viewer.current.items.length, 1);
    assert.equal(h.calls.cache.length, ["legacy-url", "noncontiguous", "large-count"].includes(mode) ? 1 : 2);
    assert.equal(h.calls.fetch.length, 1);
  });
}
for (const mode of ["descriptor", "full-legacy", "stale-descriptor"]) {
  test(`numbered photo viewer uses the expected cached source for ${mode}`, async input => {
    const h = harness(input), value = indexedAlbum();
    const complete = album("full-cached");
    const descriptor = { id: value.id, total: value.imageCount, updatedAt: mode === "stale-descriptor" ? "older" : value.updatedAt };
    h.cacheQueue.push(mode === "full-legacy" ? { payload: { album: complete } } : null, { payload: descriptor });
    if (mode === "stale-descriptor") h.networkQueue.push(new Error("Synthetic unavailable"));
    h.open(value); await flush();
    assert.equal(h.calls.fetch.length, mode === "stale-descriptor" ? 1 : 0);
    assert.deepEqual(h.viewer.current.items.map(item => item.url),
      (mode === "full-legacy" ? complete.images : mode === "descriptor" ? value.images : value.images.slice(0, 1))
        .map(image => h.A + image.url));
  });
}
test("a complete legacy cache renders while the separate descriptor lookup is pending", async input => {
  const h = harness(input), value = indexedAlbum(), index = deferred(), complete = album("full-cached");
  h.cacheQueue.push({ payload: { album: complete } }, index);
  h.open(value); await flush();
  assert.deepEqual(h.viewer.current.items.map(item => item.url), complete.images.map(image => h.A + image.url));
  index.resolve(null);
});
for (const mismatch of ["updatedAt", "archiveIdentity", "imageCount"]) {
  test(`a complete photo viewer cache with mismatched ${mismatch} requires fresh data`, async input => {
    const h = harness(input), value = { ...indexedAlbum(), archiveIdentity: "current-archive" };
    const stale = { ...value, images: album("stale-directory").images };
    if (mismatch === "updatedAt") {
      // Older responses have only the publication timestamp.
      delete stale.archiveIdentity;
      stale.updatedAt = "2026-09-30";
    } else if (mismatch === "archiveIdentity") {
      stale.archiveIdentity = "old-archive";
    } else {
      stale.images = album("stale-directory", value.id, value.imageCount + 2).images;
      stale.imageCount = stale.images.length;
    }
    h.cacheQueue.push({ payload: { album: stale } }, null);
    h.networkQueue.push({ album: value });
    h.open(value); await flush();
    assert.equal(h.calls.fetch.length, 1, "inconsistent full-directory cache must not suppress refresh");
    assert.deepEqual(h.viewer.current.items.map(item => item.url), value.images.map(image => h.A + image.url));
  });
}
for (const boundary of ["account", "server"]) {
  test(`late cached range cannot hydrate after a ${boundary} change`, async input => {
    const h = harness(input), value = indexedAlbum(), index = deferred();
    h.cacheQueue.push(null, index);
    h.open(value); await flush();
    if (boundary === "account") h.switchAccount();
    else h.switchServer();
    index.resolve({ payload: { id: value.id, total: value.imageCount, updatedAt: value.updatedAt } });
    await flush();
    assert.equal(h.viewer.current.items.length, 1);
    assert.equal(h.calls.fetch.length, 0);
  });
}
for (const boundary of ["account", "server"]) {
  test(`retired ${boundary} tile cannot start a viewer or hydration`, async input => {
    const h = harness(input), value = indexedAlbum();
    h.verify(value);
    const tile = h.mount(value);
    if (boundary === "account") h.switchAccount();
    else h.switchServer();
    tile.click(); await flush();
    assert.equal(h.viewer.current, null);
    assert.equal(h.calls.cache.length, 0); assert.equal(h.calls.fetch.length, 0);
  });
}
test("current network hydration preserves source, title, account and cache ownership", async input => {
  const h = harness(input), value = album();
  h.networkQueue.push({ album: value }); h.open(value); await flush();
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0].base, h.A);
  assert.equal(h.calls.fetch[0].options.accountScope.origin, h.A);
  assert.equal(h.calls.fetch[0].options.signal.aborted, false);
  assert.equal(h.calls.accepted.length, 1);
  assert.deepEqual(h.viewer.current.items.map(item => item.url), value.images.map(item => h.A + item.url));
  assert(h.viewer.current.items.every(item => item.title === value.title));
  assert.equal(h.calls.writes[0][3].fence.account.origin, h.A);
});
test("complete cached hydration avoids HTTP and already loaded albums avoid all hydration", async input => {
  const h = harness(input), value = album();
  h.cacheQueue.push({ payload: { album: value } }); h.open(value); await flush();
  assert.equal(h.calls.accepted.length, 1); assert.equal(h.calls.fetch.length, 0);
  const cacheReads = h.calls.cache.length;
  h.open(value, { loaded: value.imageCount }); await flush();
  assert.equal(h.calls.cache.length, cacheReads); assert.equal(h.calls.fetch.length, 0);
});
test("reopening the same album rejects an older completion even if cancellation is ignored", async input => {
  const h = harness(input), old = deferred(), fresh = deferred();
  h.networkQueue.push(old); h.open(album("old")); await flush();
  const oldSignal = h.calls.fetch[0].options.signal;
  h.viewer.close(); h.networkQueue.push(fresh); h.open(album("fresh")); await flush();
  fresh.resolve({ album: album("fresh") }); await flush();
  old.resolve({ album: album("old") }); await flush();
  assert(h.viewer.current.items.every(item => item.url.includes("/fresh-")), "Old same-album hydration must not replace the new viewer");
  if (oldSignal) assert.equal(oldSignal.aborted, true);
  assert.equal(h.calls.writes.length, 1, "Only the current response may write its cache");
}, true);
test("switching servers while cache is pending prevents HTTP and stale URL construction", async input => {
  const h = harness(input), cache = deferred();
  h.cacheQueue.push(cache); h.open(album("old"));
  h.switchServer(); cache.resolve({ payload: { album: album("old") } }); await flush();
  assert.equal(h.calls.updates.length, 0, "Old cache data must not hydrate on a different source");
  assert.equal(h.calls.fetch.length, 0);
}, true);
test("a cache miss after changing servers cannot start an obsolete network request", async input => {
  const h = harness(input), cache = deferred();
  h.cacheQueue.push(cache); h.networkQueue.push({ album: album("old") }); h.open();
  h.switchServer(); cache.resolve(null); await flush();
  assert.equal(h.calls.fetch.length, 0, "A stale cache continuation must not start HTTP");
}, true);
test("late server-A response cannot replace same-ID server-B viewer or write cache", async input => {
  const h = harness(input), old = deferred();
  h.networkQueue.push(old); h.open(album("old")); await flush();
  h.switchServer(); h.networkQueue.push({ album: album("fresh") }); h.open(album("fresh")); await flush();
  old.resolve({ album: album("old") }); await flush();
  assert(h.viewer.current.items.every(item => item.url === h.B + new URL(item.url).pathname && item.url.includes("/fresh-")), "Viewer must retain the current server's images");
  assert.equal(h.calls.writes.length, 1);
}, true);
for (const duringCache of [true, false]) test(`account change during ${duringCache ? "cache" : "HTTP"} drops late image lists`, async input => {
  const h = harness(input), wait = deferred();
  if (duringCache) h.cacheQueue.push(wait); else h.networkQueue.push(wait);
  h.open(); await flush(); h.switchAccount();
  wait.resolve(duringCache ? { payload: { album: album("old") } } : { album: album("old") }); await flush();
  assert.equal(h.calls.updates.length, 0, "A replaced account cannot update the viewer");
  assert.equal(h.calls.writes.length, 0);
}, true);
test("module deactivation aborts hydration and ignores transport completions", async input => {
  const h = harness(input), pending = deferred();
  h.networkQueue.push(pending); h.open(); await flush();
  const signal = h.calls.fetch[0].options.signal;
  h.factory.deactivate(); pending.resolve({ album: album() }); await flush();
  assert.equal(h.calls.updates.length, 0, "Leaving the module must stop viewer hydration");
  assert.equal(h.calls.writes.length, 0);
  if (signal) assert.equal(signal.aborted, true);
}, true);
test("old finalization cannot release the active request controller", async input => {
  const h = harness(input), old = deferred(), fresh = deferred();
  h.networkQueue.push(old); h.open(album("old")); await flush();
  h.networkQueue.push(fresh); h.open(album("fresh")); await flush();
  old.resolve({ album: album("old") }); await flush();
  const signal = h.calls.fetch.at(-1).options.signal;
  h.open(album("complete"), { loaded: 3 });
  assert.equal(signal.aborted, true);
  fresh.resolve({ album: album("fresh") }); await flush();
  assert(h.viewer.current.items.every(item => item.url.includes("/complete-")));
});
test("hydration failure preserves the initial selection and a later open succeeds", async input => {
  const h = harness(input);
  h.networkQueue.push(new Error("Synthetic unavailable")); h.open(); await flush();
  assert.equal(h.viewer.current.items.length, 1); assert.equal(h.calls.updates.length, 0);
  h.networkQueue.push({ album: album("retry") }); h.open(album("retry")); await flush();
  assert.equal(h.viewer.current.items.length, 3);
});

for (const { name, run } of tests) {
  await run(source); console.log(`photo-viewer-requests: ${name}: ok`);
}
let controls = 0;
for (const { name, run, oldFails } of tests) {
  if (!oldFails) continue;
  await assert.rejects(() => run(oldInput()), { name: "AssertionError" }, `Actual pre-fix methods must fail: ${name}`);
  controls++;
}
console.log(`android-photo-viewer-requests: ${tests.length} scenarios and ${controls} pre-fix negative controls: ok`);

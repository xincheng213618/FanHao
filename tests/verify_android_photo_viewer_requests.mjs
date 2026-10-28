import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { channelAccountBoundary, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { setAccountOwner } from "../android-client/www/js/account-owner.js";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { formatNumber } from "../android-client/www/js/format.js";

// The full current channel factory and actual photo-tile click handler execute.
// DOM, image loading, viewer presentation, HTTP/cache completion and clocks are
// synthetic boundaries. No real server, media, account or database is accessed.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("android-client/www/platform/content-index/channel-views.js");
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
  const context = vm.createContext({
    ...channelAccountBoundary, document, console, URL, URLSearchParams, AbortController, absoluteUrl, formatNumber,
    window: { history: { back() {} }, requestAnimationFrame() {}, clearTimeout() {} },
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
    writeCachedJson: async (...args) => { calls.writes.push(args); }
  });
  const exposure = /  return \{\r?\n(?=    deactivate:)/;
  assert(exposure.test(input));
  const executable = input.replace(exposure, "  return {\n    __createPhotoTile: createPhotoTile,\n")
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(executable, context, { filename: "actual-photo-channel-views.js" });
  const factory = context.createChannelViews({
    els: { viewContent: document.body }, getActiveUrl: () => activeUrl,
    getChannelLimit: () => 24, increaseChannelLimit() {}, openInLibrary() {},
    setActiveBottom() {}, renderCurrentView() {}, getMediaViewer: () => viewer
  });
  return {
    A, B, calls, viewer, factory, cacheQueue, networkQueue,
    switchServer(value = B) { activeUrl = value; },
    switchAccount() { setAccountOwner(activeUrl, "account:synthetic", { force: true }); },
    open(value = album(), { loaded = 1 } = {}) {
      const images = value.images.slice(0, loaded);
      const tile = factory.__createPhotoTile(value, images[0], images, { index: 0 });
      document.body.append(tile);
      tile.click();
      return tile;
    }
  };
}

const tests = [];
const test = (name, run, oldFails = false) => tests.push({ name, run, oldFails });
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

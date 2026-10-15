import assert from "node:assert/strict";
import fs from "node:fs";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { setAccountOwner } from "../android-client/www/js/account-owner.js";

// Full current modules and synthetic IndexedDB/HTTP. The touch gate delays only
// an existing async boundary; no production hooks, browser, media or disk state.
globalThis.window = globalThis;
globalThis.indexedDB = new IDBFactory();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
let cacheSource = fs.readFileSync(new URL("../android-client/www/js/cache.js", import.meta.url), "utf8");
cacheSource = cacheSource.replace(/from "(\.\/[^"\r\n]+)"/gu, (_match, relative) => `from ${JSON.stringify(new URL(relative, new URL("../android-client/www/js/cache.js", import.meta.url)).href)}`);
const touch = "async function touchCachedImage(entry, options, fence) {";
assert.equal(cacheSource.split(touch).length, 2);
cacheSource = cacheSource.replace(touch, `${touch}\n  await globalThis.__privateImageTouchGate?.();`);
if (process.argv.includes("--legacy-image-clear")) {
  const guard = "function isCachedImageFenceCurrent(fence) {";
  assert.equal(cacheSource.split(guard).length, 2);
  cacheSource = cacheSource.replace(guard, `${guard}\n  return true;`);
}
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const cacheUrl = moduleUrl(cacheSource), cache = await import(cacheUrl);
const imageSource = fs.readFileSync(new URL("../android-client/www/js/image.js", import.meta.url), "utf8")
  .replace(/from "\.\/cache\.js\?v=[^"\r\n]+"/u, `from ${JSON.stringify(cacheUrl)}`);
const image = await import(moduleUrl(imageSource));
const base = "http://image-cache.fixture", other = "http://other-image-cache.fixture";
const blob = text => new Blob([text], { type: "image/svg+xml" });
const networks = new Map(), calls = [];
globalThis.fetch = async (url, options) => {
  calls.push(String(url));
  const response = networks.get(String(url)); assert(response, `unmodelled private request: ${url}`);
  return response(options);
};
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
async function hold(url, options = {}) {
  const requested = deferred(), response = deferred();
  networks.set(url, async () => { requested.resolve(); await response.promise; return new Response(blob(url)); });
  const pending = image.precacheImage(url, { cacheBaseUrl: base, ...options });
  await requested.promise;
  return { pending, release: () => response.resolve() };
}
let passed = 0;
async function run(name, task) { await task(); passed++; console.log(`PASS ${name}`); }
try {
  for (const clearBase of [base, ""]) await run(`${clearBase ? "base" : "global"} clear rejects an older actual image preload`, async () => {
    const url = `${base}/late-${passed}`, request = await hold(url);
    try {
      await cache.clearCachedImages(clearBase); request.release();
      assert.equal(await request.pending, null, "a pre-clear response must not repopulate image storage");
      assert.equal(await cache.readCachedImage(url), null);
    } finally { request.release(); await request.pending; }
  });
  await run("clearing one base preserves another preload and permits fresh work", async () => {
    const url = `${other}/unrelated`, request = await hold(url, { cacheBaseUrl: other });
    await cache.clearCachedImages(base); request.release(); assert(await request.pending);
    assert.equal((await cache.readCachedImage(url, { baseUrl: other })).blob.size, blob(url).size);
    assert(await cache.writeCachedImage(`${base}/fresh`, blob("fresh"), { baseUrl: base }));
    assert.equal(await cache.writeCachedImage(`${base}/wrong-base`, blob("wrong"), {
      baseUrl: base, fence: cache.captureCachedImageFence(url, { baseUrl: other })
    }), null);
  });
  await run("an old image touch cannot resurrect a cleared entry", async () => {
    const url = `${base}/touch-cleared`; await cache.writeCachedImage(url, blob("old"), { baseUrl: base });
    const gate = deferred(), started = deferred();
    globalThis.__privateImageTouchGate = () => { started.resolve(); return gate.promise; };
    await cache.readCachedImage(url, { baseUrl: base }); await started.promise;
    await cache.clearCachedImages(base); gate.resolve(); globalThis.__privateImageTouchGate = null;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await cache.readCachedImage(url, { baseUrl: base }), null);
  });
  await run("an old touch preserves the latest stored image and metadata", async () => {
    const url = `${base}/touch-newer`; await cache.writeCachedImage(url, blob("old"), { baseUrl: base });
    const gate = deferred(), started = deferred();
    globalThis.__privateImageTouchGate = () => { started.resolve(); return gate.promise; };
    await cache.readCachedImage(url, { baseUrl: base }); await started.promise;
    await cache.writeCachedImage(url, blob("new-content"), { baseUrl: base });
    gate.resolve(); globalThis.__privateImageTouchGate = null;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await (await cache.readCachedImage(url)).blob.text(), "new-content");
  });
  await run("shared images retain existing account and size boundaries", async () => {
    const url = `${base}/shared`; await cache.writeCachedImage(url, blob("shared"), { baseUrl: base });
    setAccountOwner(base, "account:alpha"); setAccountOwner(base, "account:beta");
    assert.equal(await (await cache.readCachedImage(url)).blob.text(), "shared");
    assert.equal(await cache.writeCachedImage(`${base}/empty`, new Blob()), null);
    assert.equal(await cache.writeCachedImage(`${base}/large`, new Blob([new Uint8Array(5 * 1024 * 1024 + 1)])), null);
    assert.equal((await cache.getCacheStats(base)).imageCount, 2);
  });
  await run("cancelled warming cannot publish a late body", async () => {
    const controller = new AbortController(); controller.abort(); const before = calls.length;
    assert.equal(await image.precacheImage(`${base}/already-aborted`, { signal: controller.signal }), null);
    assert.equal(calls.length, before);
    const active = new AbortController(), request = await hold(`${base}/abort-body`, { signal: active.signal });
    active.abort(); request.release(); assert.equal(await request.pending, null);
    assert.equal(await cache.readCachedImage(`${base}/abort-body`), null);
  });
  await run("image writes report transaction abort rather than request success", async () => {
    const original = IDBObjectStore.prototype.put, url = `${base}/aborted-transaction`;
    IDBObjectStore.prototype.put = function (entry, ...args) {
      const request = original.call(this, entry, ...args);
      if (entry.key === url) request.addEventListener("success", () => this.transaction.abort(), { once: true });
      return request;
    };
    try { await assert.rejects(cache.writeCachedImage(url, blob("uncommitted"), { baseUrl: base }), /事务已中止/); }
    finally { IDBObjectStore.prototype.put = original; }
    assert.equal(await cache.readCachedImage(url), null);
  });
  console.log(`Android image cache: ${passed} full-source synthetic IndexedDB scenarios passed; no real service or media`);
} finally {
  globalThis.__privateImageTouchGate = null;
  await cache.clearCachedData();
}

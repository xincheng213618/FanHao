import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

// Full Android entry and real IndexedDB in private Chromium. The cached records
// and all API results are synthetic and isolated to a disposable context.
const project = path.resolve(import.meta.dirname, "..");
const www = path.join(project, "android-client", "www");
const previousApp = execFileSync("git", ["show", "f110040d02b1eb579461248da9960e97370fa4d2:android-client/www/app.js"], { cwd: project, encoding: "utf8" });
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const errors = [];
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/seed" || url.pathname === "/favicon.ico") {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>Isolated cache fixture</title>"); return;
    }
    const filename = path.resolve(www, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert(filename.startsWith(`${www}${path.sep}`));
    let source = fs.readFileSync(filename);
    if (url.pathname === "/app.js") {
      source = url.searchParams.get("v") === "fixture-previous" ? previousApp : source.toString("utf8");
      const metrics = "async function updateCacheStatus() {";
      assert.equal(source.split(metrics).length, 2);
      source = source.replace(metrics, `function updateCacheStatus() {
  const task = measuredCacheStatus();
  window.__cacheStatusTasks.push(task);
  return task;
}
async function measuredCacheStatus() {`);
      const boot = "bootApp().catch((error) => {";
      assert.equal(source.split(boot).length, 2);
      source = source.replace(boot, `window.__cacheProbe = { loadDashboard, showSettings, dashboard: () => libraryLoadPromise };
window.__cacheProbe.boot = ${boot}`);
    }
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(filename)];
    response.writeHead(200, { "Content-Type": contentType || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(source);
  } catch (error) { errors.push(error.message); response.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const seed = { responses: 80, responseBytes: 512 * 1024, images: 1000 };
const bootstrapReadout = results => ({
  reads: results.map(read => read.store),
  jsonMiB: results.reduce((sum, read) => sum + read.payloadChars, 0) / 1024 ** 2,
  imageHandles: results.filter(read => read.store === "images").reduce((sum, read) => sum + read.count, 0)
});

async function fixture(browser, previous) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route(url => url.origin !== base, route => route.abort());
    if (previous) await page.route("**/app.js?*", route => route.continue({ url: `${base}/app.js?v=fixture-previous` }));
    let libraryGate = null, libraryStatus = 200;
    await page.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/library") {
        if (libraryGate) await libraryGate;
        return route.fulfill({ status: libraryStatus,
          json: libraryStatus === 200 ? { people: [], works: [], totals: {}, access: { mode: "loopback" } } : { error: "Synthetic offline" } });
      }
      if (pathname === "/api/modules") return route.fulfill({ json: { modules: [] } });
      return route.fulfill({ json: {} });
    });
    await page.goto(`${base}/seed`);
    await page.evaluate(async seed => {
      localStorage.setItem("fanhao.serverUrl", location.origin);
      const { CLIENT_VERSION } = await import("/js/config.js");
      const version = `responses:${CLIENT_VERSION}`;
      const request = indexedDB.open("fanhao-android-cache", 3);
      request.onupgradeneeded = () => {
        for (const name of ["responses", "images"]) {
          const store = request.result.createObjectStore(name, { keyPath: "key" });
          store.createIndex("baseUrl", "baseUrl");
          store.createIndex("updatedAt", "updatedAt");
          store.createIndex("trimMetadata", ["key", "bytes", "accessedAt", "updatedAt"]);
        }
      };
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      const tx = db.transaction(["responses", "images"], "readwrite");
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; tx.onabort = reject; });
      const baseUrl = location.origin, updatedAt = new Date().toISOString(), accessedAt = updatedAt;
      const payload = { synthetic: "x".repeat(seed.responseBytes) };
      for (let index = 0; index < seed.responses; index++) {
        const path = `/cache-fixture/response-${index}`;
        tx.objectStore("responses").put({ key: `${baseUrl} ${version} ${path}`, baseUrl, path, version, payload,
          bytes: seed.responseBytes + 256, updatedAt, accessedAt });
      }
      const blob = new Blob(["x".repeat(2048)]);
      for (let index = 0; index < seed.images; index++) {
        const key = `${baseUrl}/cache-fixture/image-${index}`;
        tx.objectStore("images").put({ key, baseUrl, blob, bytes: blob.size, updatedAt, accessedAt });
      }
      await done;
      db.close();
    }, seed);
    await page.addInitScript(() => {
      window.__cacheStatusTasks = [];
      window.__cacheStatsReads = [];
      const original = IDBIndex.prototype.getAll;
      IDBIndex.prototype.getAll = function (...args) {
        const request = original.apply(this, args);
        if (this.name === "baseUrl" && this.objectStore.transaction.mode === "readonly") {
          const store = this.objectStore.name;
          const started = performance.now();
          request.addEventListener("success", () => {
            const rows = request.result;
            __cacheStatsReads.push({ store, count: rows.length, ms: performance.now() - started,
              payloadChars: rows.reduce((sum, row) => sum + (row.payload?.synthetic?.length || 0), 0) });
          }, { once: true });
        }
        return request;
      };
    });
    await page.goto(base);
    const startup = await page.evaluate(async () => {
      await __cacheProbe.boot;
      await __cacheProbe.dashboard();
      await Promise.all(__cacheStatusTasks);
      return { reads: __cacheStatsReads.slice(), hidden: document.querySelector("#settingsOverlay").hidden };
    });
    assert.equal(startup.hidden, true);
    const metrics = bootstrapReadout(startup.reads);
    if (previous) {
      assert.deepEqual([...metrics.reads].sort(), ["images", "images", "responses", "responses"]);
      assert.equal(metrics.jsonMiB, 80);
      assert.equal(metrics.imageHandles, 2000);
    } else {
      assert.deepEqual(metrics.reads, [], "closed Settings must not scan the cache during startup");
      await page.evaluate(() => __cacheProbe.loadDashboard());
      assert.deepEqual(await page.evaluate(() => __cacheStatsReads), [], "a hidden refresh must also avoid a cache scan");
    }

    await page.evaluate(async () => {
      __cacheStatsReads.length = 0;
      __cacheProbe.showSettings({ section: "storage" });
      await Promise.all(__cacheStatusTasks);
    });
    assert.match(await page.locator("#cacheImageCount").innerText(), /^1,000 张/);
    assert.match(await page.locator("#cacheStatus").innerText(), /^1,0\d\d 项/);
    assert.deepEqual(await page.evaluate(() => __cacheStatsReads.map(read => read.store)), ["responses", "images"]);
    if (!previous) {
      await page.evaluate(async () => {
        __cacheStatsReads.length = 0;
        await __cacheProbe.loadDashboard();
        await Promise.all(__cacheStatusTasks);
      });
      assert.deepEqual(await page.evaluate(() => __cacheStatsReads.map(read => read.store)), ["responses", "images"], "a visible dashboard refresh updates storage metrics");
      await page.evaluate(() => { __cacheStatsReads.length = 0; });
      await page.locator("#refreshCacheButton").click();
      await page.evaluate(() => Promise.all(__cacheStatusTasks));
      assert.deepEqual(await page.evaluate(() => __cacheStatsReads.map(read => read.store)), ["responses", "images"], "manual storage refresh remains available");

      const release = Promise.withResolvers();
      libraryGate = release.promise;
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === "/api/library");
      await page.evaluate(() => { __cacheStatsReads.length = 0; window.__heldDashboard = __cacheProbe.loadDashboard(); });
      try {
        await requested;
        await page.locator("#settingsCloseButton").click();
      } finally { release.resolve(); libraryGate = null; }
      await page.evaluate(() => __heldDashboard);
      assert.deepEqual(await page.evaluate(() => __cacheStatsReads), [], "a refresh settling after Settings closes must not scan");
      libraryStatus = 503;
      assert.equal(await page.evaluate(() => __cacheProbe.loadDashboard()), false);
      assert.deepEqual(await page.evaluate(() => __cacheStatsReads), [], "an offline refresh also skips hidden cache statistics");
    }
    return { ...metrics, readMs: Number(startup.reads.reduce((sum, read) => sum + read.ms, 0).toFixed(1)) };
  } finally { await context.close(); }
}

let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const baselineOnly = process.argv.includes("--baseline-only");
  const previous = await fixture(browser, true);
  console.log(JSON.stringify({ mode: "previous", ...previous }));
  if (!baselineOnly) console.log(JSON.stringify({ mode: "current", ...await fixture(browser, false) }));
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

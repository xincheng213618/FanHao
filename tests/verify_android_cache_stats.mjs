import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

// Actual Chromium/IndexedDB regression. Each invocation uses a fresh private
// browser context and a dynamic loopback origin; no application server is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(root, "android-client/www/js");
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for the private cache fixture");
const source = fs.readFileSync(path.join(androidRoot, "cache.js"), "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const legacySource = payloadTrim(unfilteredStats(source));
const databasePrefix = `fanhao-private-cache-${randomUUID()}`;
const databaseVersion = Number(source.match(/const DB_VERSION = (\d+);/u)?.[1]);
assert.equal(databaseVersion, 3);
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
let imageSource = fs.readFileSync(path.join(androidRoot, "image.js"), "utf8");
if (process.argv.includes("--legacy-image-fence")) {
  const marker = "const cacheOptions = { baseUrl: options.cacheBaseUrl, fence: captureCachedImageFence(imageUrl, { baseUrl: options.cacheBaseUrl }) };";
  assert.equal(imageSource.split(marker).length, 3, "missing actual preview/precache fence hooks");
  imageSource = imageSource.replaceAll(marker, "const cacheOptions = { baseUrl: options.cacheBaseUrl };");
}
const maintenance = "\nexport async function __waitCacheMaintenance() { await Promise.all([responseTrimPromise, imageTrimPromise, staleResponsePrunePromise].filter(Boolean)); } export const __privateCache = { openCacheDb, trimResponseCache, trimImageCache, pruneStaleResponseCache };\n";
let servedSource = process.argv.includes("--legacy-unfiltered") ? unfilteredStats(source) : source;
if (process.argv.includes("--legacy-trim-payload")) servedSource = payloadTrim(servedSource);
if (process.argv.includes("--legacy-stale-prune")) servedSource = stalePayloadPrune(servedSource);
servedSource += maintenance;
const faults = [], blocked = [], requests = [];
let browser, checks = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://private-fixture");
  requests.push(url.pathname);
  if (url.pathname === "/sandbox") return send(res, "<!doctype html><title>Private cache transaction fixture</title>", "text/html");
  if (url.pathname === "/probe") return send(res, '<!doctype html><title>Private cache statistics fixture</title><script type="module">window.version = (await import("/android/js/config.js")).CLIENT_VERSION; window.api = await import("/android/js/cache.js?v=" + version); window.legacy = await import("/android/js/legacy-cache.js"); window.image = await import("/android/js/image.js"); window.ready = true;</script>', "text/html");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  const names = new Map([["/android/js/cache.js", servedSource], ["/android/js/legacy-cache.js", legacySource + maintenance], ["/android/js/old-prune-cache.js", stalePayloadPrune(source) + maintenance], ["/android/js/image.js", imageSource]]);
  if (names.has(url.pathname)) {
    const value = names.get(url.pathname).replace('const DB_NAME = "fanhao-android-cache";', `const DB_NAME = ${JSON.stringify(`${databasePrefix}-${url.searchParams.get("db") || "main"}`)};`);
    return send(res, value, "text/javascript");
  }
  if (["/android/js/config.js", "/android/js/account-owner.js"].includes(url.pathname)) return send(res, fs.readFileSync(path.join(androidRoot, path.basename(url.pathname))), "text/javascript");
  faults.push(`unmodelled route: ${url.pathname}`); res.writeHead(404); res.end("unmodelled private route");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => faults.push(error.message));
  await page.goto(`${origin}/probe`); await page.waitForFunction(() => window.ready);
  await page.evaluate(async ({ databaseName, databaseVersion }) => {
    const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    // Finish startup pruning before seeding. Later reads can then be attributed
    // to the operation under test, rather than overlapping initialization.
    await api.getCacheStats(); await api.__waitCacheMaintenance();
    await legacy.getCacheStats(); await legacy.__waitCacheMaintenance();
    const db = await request(indexedDB.open(databaseName, databaseVersion));
    const base = location.origin + "/source-one", other = location.origin + "/source-two";
    const text = "s".repeat(1024 * 1024), blob = new Blob([new Uint8Array(128 * 1024)], { type: "image/png" });
    const tx = db.transaction(["responses", "images"], "readwrite"), done = complete(tx);
    for (let index = 0; index < 60; index++) {
      const baseUrl = index < 3 ? base : other, path = `/api/synthetic/${index}`;
      tx.objectStore("responses").put({ key: `${baseUrl} responses:${version} ${path}`, baseUrl, path, accountOwner: "guest", version: `responses:${version}`, payload: { large: text, id: index }, bytes: text.length + 256, updatedAt: "2026-10-04T00:00:00.000Z", accessedAt: "2026-10-04T00:00:00.000Z" });
    }
    for (let index = 0; index < 1000; index++) {
      const baseUrl = index < 10 ? base : other, url = `${baseUrl}/image/${index}`;
      tx.objectStore("images").put({ key: url, url, baseUrl, blob, bytes: blob.size, mime: blob.type, updatedAt: "2026-10-04T00:00:00.000Z", accessedAt: "2026-10-04T00:00:00.000Z" });
    }
    await done;
    let reads = [], buffers = 0;
    const originalBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (...args) { buffers++; return originalBuffer.apply(this, args); };
    for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) for (const method of ["getAll", "getAllKeys"]) {
      const original = prototype[method];
      prototype[method] = function (...args) {
        const start = performance.now(), req = original.apply(this, args), store = this.objectStore?.name || this.name, index = this.objectStore ? this.name : null;
        req.addEventListener("success", () => {
          const rows = req.result;
          reads.push({ store, index, method, rows: rows.length, jsonChars: rows.reduce((sum, row) => sum + (typeof row?.payload?.large === "string" ? row.payload.large.length : 0), 0), blobHandles: rows.filter(row => row?.blob instanceof Blob).length, ms: performance.now() - start });
        });
        return req;
      };
    }
    const originalCursor = IDBIndex.prototype.openKeyCursor;
    IDBIndex.prototype.openKeyCursor = function (...args) {
      const start = performance.now(), req = originalCursor.apply(this, args), store = this.objectStore.name, index = this.name;
      let rows = 0;
      req.addEventListener("success", () => {
        if (req.result) { rows++; return; }
        reads.push({ store, index, method: "openKeyCursor", rows, jsonChars: 0, blobHandles: 0, ms: performance.now() - start });
      });
      return req;
    };
    const gates = new Map(), loads = new Map();
    const originalFetch = window.fetch;
    window.fetch = function (url, options) {
      const gate = [...gates.values()].find(value => value.url === String(url));
      if (!gate) return originalFetch.call(this, url, options);
      gate.requested = true;
      return new Promise(resolve => { gate.release = () => resolve(new Response('<svg xmlns="http://www.w3.org/2000/svg" width="17" height="23"><rect width="17" height="23" fill="green"/></svg>', { status: 200, headers: { "Content-Type": "image/svg+xml" } })); });
    };
    window.fixture = {
      base, other, db, request, complete,
      gates, loads,
      startPrecache(name, baseUrl = base) {
        const url = `${baseUrl}/controlled-image-${name}`;
        gates.set(name, { url, requested: false }); loads.set(name, image.precacheImage(url, { cacheBaseUrl: baseUrl }));
        return url;
      },
      async releaseImage(name) { gates.get(name).release(); return loads.get(name); },
      async measure(task) {
        reads = []; buffers = 0;
        let lag = 0, previous = performance.now();
        const timer = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - previous - 4); previous = now; }, 4);
        const start = performance.now();
        try { const value = await task(); const elapsed = performance.now() - start; await new Promise(resolve => setTimeout(resolve, 8)); return { value, ms: elapsed, maxHeartbeatLag: lag, arrayBufferCalls: buffers, reads: reads.slice() }; }
        finally { clearInterval(timer); }
      },
      async addCompatibilityRows() {
        const records = [
          { key: "version-only", baseUrl: base, path: "/legacy-v", accountOwner: "account:fixture", version: `responses:${version}`, payload: { title: "中文", value: 3 }, updatedAt: "2026-10-04T01:00:00.000Z" },
          { key: `${base} responses:${version} /legacy-key`, baseUrl: base, path: "/legacy-key", payload: { title: "无bytes兼容" }, updatedAt: "2026-10-04T02:00:00.000Z" },
          { key: "stale-version", baseUrl: base, path: "/stale", version: "responses:old", payload: { ignored: true }, bytes: 9999, updatedAt: "2027-01-01T00:00:00.000Z" },
          { key: "missing-base-current", version: `responses:${version}`, payload: { value: 1 }, bytes: 15, updatedAt: "2026-10-04T03:00:00.000Z" }
        ];
        const images = [{ key: "old-image", baseUrl: base, blob: new Blob(["abc"]), bytes: 0, updatedAt: "2026-10-04T02:30:00.000Z" }, { key: "missing-image-base", blob: new Blob(["xy"]), updatedAt: "2026-10-04T02:00:00.000Z" }];
        const tx = db.transaction(["responses", "images"], "readwrite"), done = complete(tx);
        records.forEach(row => tx.objectStore("responses").put(row)); images.forEach(row => tx.objectStore("images").put(row)); await done;
        return records.slice(0, 2).reduce((sum, row) => sum + new Blob([JSON.stringify(row)]).size, 0);
      }
    };
  }, { databaseName: `${databasePrefix}-main`, databaseVersion });
  const run = async (name, task) => { if (caseFilter && !name.includes(caseFilter)) return; await task(); checks++; console.log(`PASS ${name}`); };
  const benchmarks = [];
  await run("base statistics use both existing indexes and match the full-read oracle", async () => {
    for (let round = 0; round < 3; round++) {
      const measured = await page.evaluate(async () => ({ current: await fixture.measure(() => api.getCacheStats(fixture.base)), legacy: await fixture.measure(() => legacy.getCacheStats(fixture.base)) }));
      assert.deepEqual(measured.current.value, measured.legacy.value);
      assert.equal(measured.current.value.responseCount, 3); assert.equal(measured.current.value.imageCount, 10);
      assert.deepEqual(readShape(measured.current), [["responses", "baseUrl", "getAll", 3], ["images", "baseUrl", "getAll", 10]]);
      assert.deepEqual(readShape(measured.legacy), [["responses", null, "getAll", 60], ["images", null, "getAll", 1000]]);
      assert.equal(measured.current.reads[0].jsonChars, 3 * 1024 * 1024); assert.equal(measured.legacy.reads[0].jsonChars, 60 * 1024 * 1024);
      assert.equal(measured.current.arrayBufferCalls, 0); assert.equal(measured.legacy.arrayBufferCalls, 0);
      benchmarks.push(measured);
    }
  });
  const trimBenchmarks = [];
  await run("normal five response and image writes avoid payload clones against the old trim oracle", async () => {
    const values = await page.evaluate(async () => {
      const response = client => fixture.measure(async () => { for (let index = 0; index < 5; index++) { await client.writeCachedJson(fixture.base, "/api/trim-tiny", { value: index }); await client.__waitCacheMaintenance(); } });
      const image = client => fixture.measure(async () => { for (let index = 0; index < 5; index++) { await client.writeCachedImage(fixture.base + "/trim-tiny", new Blob(["tiny"]), { baseUrl: fixture.base }); await client.__waitCacheMaintenance(); } });
      const values = { response: await response(api), oldResponse: await response(legacy), image: await image(api), oldImage: await image(legacy) };
      const tx = fixture.db.transaction(["responses", "images"], "readwrite"), done = fixture.complete(tx);
      tx.objectStore("responses").delete(`${fixture.base} responses:${version} /api/trim-tiny`); tx.objectStore("images").delete(fixture.base + "/trim-tiny"); await done;
      return values;
    });
    assert.deepEqual(readShape(values.response), []); assert.deepEqual(readShape(values.image), []);
    assert.deepEqual(values.response.reads.map(row => [row.method, row.rows]), Array.from({ length: 5 }, () => ["openKeyCursor", 61]));
    assert.deepEqual(values.image.reads.map(row => [row.method, row.rows]), Array.from({ length: 5 }, () => ["openKeyCursor", 1001]));
    assert.equal(values.oldResponse.reads.length, 5); assert.equal(values.oldResponse.reads.reduce((sum, row) => sum + row.jsonChars, 0), 300 * 1024 * 1024);
    assert.equal(values.oldImage.reads.length, 5); assert.equal(values.oldImage.reads.reduce((sum, row) => sum + row.blobHandles, 0), 5005);
    for (const value of Object.values(values)) assert.equal(value.arrayBufferCalls, 0);
    trimBenchmarks.push(...Object.entries(values).map(([name, value]) => ({ name, ms: value.ms, heartbeatLag: value.maxHeartbeatLag, fullReads: readShape(value).length, jsonMiB: value.reads.reduce((sum, row) => sum + row.jsonChars, 0) / 1024 / 1024, blobHandles: value.reads.reduce((sum, row) => sum + row.blobHandles, 0) })));
  });
  const legacyBytes = await page.evaluate(() => fixture.addCompatibilityRows());
  await run("version-only/key-only compatibility, account entries and missing bytes retain their totals", async () => {
    const measured = await page.evaluate(async () => ({ current: await fixture.measure(() => api.getCacheStats(fixture.base)), legacy: await legacy.getCacheStats(fixture.base) }));
    assert.deepEqual(measured.current.value, measured.legacy);
    assert.deepEqual(readShape(measured.current), [["responses", "baseUrl", "getAll", 6], ["images", "baseUrl", "getAll", 11]]);
    assert.equal(measured.current.value.responseCount, 5); assert.equal(measured.current.value.imageCount, 11);
    assert.equal(measured.current.value.responseBytes, 3 * (1024 * 1024 + 256) + legacyBytes);
    assert.equal(measured.current.value.imageBytes, 10 * 128 * 1024 + 3);
    assert.equal(measured.current.value.latestUpdatedAt, "2026-10-04T02:30:00.000Z");
  });
  await run("trailing slashes preserve the same indexed base", async () => {
    const measured = await page.evaluate(async () => ({ normalized: await api.getCacheStats(fixture.base), current: await fixture.measure(() => api.getCacheStats(fixture.base + "///")) }));
    assert.deepEqual(measured.current.value, measured.normalized);
    assert.deepEqual(readShape(measured.current), [["responses", "baseUrl", "getAll", 6], ["images", "baseUrl", "getAll", 11]]);
  });
  await run("an unknown base reads no unrelated payloads or Blob handles", async () => {
    const measured = await page.evaluate(() => fixture.measure(() => api.getCacheStats(location.origin + "/missing")));
    assert.deepEqual(measured.value, { count: 0, responseCount: 0, imageCount: 0, responseBytes: 0, imageBytes: 0, bytes: 0, latestUpdatedAt: "" });
    assert.deepEqual(readShape(measured), [["responses", "baseUrl", "getAll", 0], ["images", "baseUrl", "getAll", 0]]);
  });
  await run("empty and slash-only bases retain full-store statistics including missing-base legacy entries", async () => {
    const values = await page.evaluate(async () => ({ empty: await fixture.measure(() => api.getCacheStats()), slash: await fixture.measure(() => api.getCacheStats("/")), legacy: await legacy.getCacheStats() }));
    assert.deepEqual(values.empty.value, values.legacy); assert.deepEqual(values.slash.value, values.legacy);
    assert.deepEqual(readShape(values.empty), [["responses", null, "getAll", 64], ["images", null, "getAll", 1002]]);
    assert.deepEqual(readShape(values.slash), readShape(values.empty));
    assert.equal(values.empty.value.responseCount, 63); assert.equal(values.empty.value.imageCount, 1002);
    assert.equal(values.empty.value.latestUpdatedAt, "2026-10-04T03:00:00.000Z");
  });
  await run("the other server keeps its complete independent totals", async () => {
    const measured = await page.evaluate(async () => ({ current: await fixture.measure(() => api.getCacheStats(fixture.other)), legacy: await legacy.getCacheStats(fixture.other) }));
    assert.deepEqual(measured.current.value, measured.legacy);
    assert.deepEqual(readShape(measured.current), [["responses", "baseUrl", "getAll", 57], ["images", "baseUrl", "getAll", 990]]);
    assert.equal(measured.current.value.responseCount, 57); assert.equal(measured.current.value.imageCount, 990);
  });
  await run("response writes still trim globally without deleting a cache below its budget", async () => {
    const measured = await page.evaluate(() => fixture.measure(async () => { await api.writeCachedJson(fixture.base, "/api/tiny", { value: 1 }); await api.__waitCacheMaintenance(); }));
    assert.deepEqual(readShape(measured), [["responses", null, "getAll", 65]]);
    assert.equal(measured.reads.find(row => row.method === "getAll").jsonChars, 60 * 1024 * 1024);
    assert.equal(await page.evaluate(() => fixture.request(fixture.db.transaction("responses", "readonly").objectStore("responses").count())), 65);
  });
  await run("image writes still trim globally and do not materialize Blob contents", async () => {
    const measured = await page.evaluate(() => fixture.measure(async () => { await api.writeCachedImage(fixture.base + "/extra", new Blob(["tiny"]), { baseUrl: fixture.base }); await api.__waitCacheMaintenance(); }));
    assert.deepEqual(readShape(measured), [["images", null, "getAll", 1003]]);
    assert.equal(measured.reads.find(row => row.method === "getAll").blobHandles, 1003); assert.equal(measured.arrayBufferCalls, 0);
  });
  await run("prefix selection stays within its base and base deletion remains key-only", async () => {
    const prefix = await page.evaluate(() => fixture.measure(() => api.clearCachedJsonByPrefix(fixture.base, "/never")));
    assert.deepEqual(readShape(prefix), [["responses", "baseUrl", "getAll", 7]]);
    const cleared = await page.evaluate(() => fixture.measure(() => api.clearCachedData(fixture.base)));
    assert.deepEqual(readShape(cleared), [["responses", "baseUrl", "getAllKeys", 7], ["images", "baseUrl", "getAllKeys", 12]]);
    assert.equal(cleared.reads.reduce((sum, row) => sum + row.jsonChars + row.blobHandles, 0), 0);
    const values = await page.evaluate(async () => ({ empty: await api.getCacheStats(fixture.base), other: await api.getCacheStats(fixture.other) }));
    assert.equal(values.empty.count, 0); assert.equal(values.other.count, 1047);
  });
  await run("an actual precache completing after base clear cannot restore its old image", async () => {
    await page.evaluate(() => fixture.startPrecache("late-a"));
    await page.waitForFunction(() => fixture.gates.get("late-a").requested);
    await page.evaluate(() => api.clearCachedImages(fixture.base));
    assert.equal(await page.evaluate(() => fixture.releaseImage("late-a")), null);
    assert.equal(await page.evaluate(() => api.readCachedImage(fixture.gates.get("late-a").url, { baseUrl: fixture.base })), null);
  });
  await run("base clear leaves a parallel other-base precache valid and permits a new write", async () => {
    await page.evaluate(() => { fixture.startPrecache("parallel-a"); fixture.startPrecache("parallel-b", fixture.other); });
    await page.waitForFunction(() => fixture.gates.get("parallel-a").requested && fixture.gates.get("parallel-b").requested);
    await page.evaluate(() => api.clearCachedImages(fixture.base));
    const values = await page.evaluate(async () => ({ a: await fixture.releaseImage("parallel-a"), b: Boolean(await fixture.releaseImage("parallel-b")) }));
    assert.equal(values.a, null); assert.equal(values.b, true);
    await page.evaluate(() => fixture.startPrecache("new-a"));
    await page.waitForFunction(() => fixture.gates.get("new-a").requested);
    assert.equal(await page.evaluate(async () => Boolean(await fixture.releaseImage("new-a"))), true);
    assert.equal(await page.evaluate(async () => Boolean(await api.readCachedImage(fixture.gates.get("new-a").url, { baseUrl: fixture.base }))), true);
  });
  await run("a preview may display its late SVG after global clear without rebuilding the cache", async () => {
    await page.evaluate(() => {
      const url = `${fixture.base}/controlled-image-preview`, target = document.createElement("div");
      target.id = "private-preview"; document.body.append(target);
      fixture.gates.set("preview", { url, requested: false });
      fixture.loads.set("preview", image.loadPreviewImage(target, url, { cacheBaseUrl: fixture.base, cacheReadTimeoutMs: 0, decorate: img => { img.id = "private-preview"; } }));
    });
    await page.waitForFunction(() => fixture.gates.get("preview").requested);
    await page.evaluate(() => api.clearCachedImages());
    await page.evaluate(() => fixture.releaseImage("preview"));
    await page.waitForFunction(() => { const image = document.querySelector("#private-preview"); return image?.tagName === "IMG" && image.naturalWidth === 17 && image.naturalHeight === 23; });
    const preview = await page.evaluate(async () => ({ source: document.querySelector("#private-preview").dataset.imageSource, cached: await api.readCachedImage(fixture.gates.get("preview").url, { baseUrl: fixture.base }) }));
    assert.equal(preview.source, "network"); assert.equal(preview.cached, null);
    await page.evaluate(() => { const image = document.querySelector("#private-preview"); URL.revokeObjectURL(image.dataset.objectUrl); image.remove(); });
  });
  let sandboxNumber = 0;
  const sandbox = async label => {
    const testPage = await context.newPage(), databaseName = `${databasePrefix}-${label}-${sandboxNumber++}`;
    await testPage.goto(`${origin}/sandbox`);
    await installSandbox(testPage, databaseName, `${origin}/android/js/cache.js?db=${encodeURIComponent(databaseName.slice(databasePrefix.length + 1))}`);
    return testPage;
  };
  for (const oldVersion of [1, 2]) await run(`migration v${oldVersion} preserves old response and Blob values without backfill`, async () => {
    const testPage = await sandbox(`migration-${oldVersion}`);
    try {
      const result = await testPage.evaluate(async oldVersion => {
        const db = await test.oldDatabase(oldVersion);
        await test.seedLegacy(db); const before = await test.snapshot(db); db.close();
        await test.load(); const after = await test.snapshot(test.db), schema = test.schema(test.db);
        const responseTrim = await test.measureTrim("responses"), imageTrim = await test.measureTrim("images");
        return { before, after, schema, version: test.db.version, responseTrim, imageTrim };
      }, oldVersion);
      assert.equal(result.version, 3);
      assert.deepEqual(result.after.responses, result.before.responses); assert.deepEqual(result.after.images, result.before.images || []);
      assert.deepEqual(result.schema.responses, ["baseUrl", "trimMetadata", "updatedAt"]); assert.deepEqual(result.schema.images, result.schema.responses);
      assert.equal(result.responseTrim.fullReads, 1); assert.equal(result.imageTrim.fullReads, oldVersion === 2 ? 1 : 0);
    } finally { await testPage.close(); }
  });
  for (const store of ["responses", "images"]) await run(`${store} budget matches the old cumulative oracle at limits and legacy numeric/time values`, async () => {
    const testPage = await sandbox(`budget-${store}`);
    try {
      const results = await testPage.evaluate(async store => {
        await test.load();
        const maxCount = store === "responses" ? 600 : 2500, maxBytes = (store === "responses" ? 120 : 250) * 1024 * 1024;
        const scenarios = [
          ["count below", maxCount - 1, () => ({ bytes: 1 })], ["count equal", maxCount, () => ({ bytes: 1 })], ["count above", maxCount + 1, () => ({ bytes: 1 })],
          ["bytes below", 3, index => ({ bytes: index ? 1 : maxBytes - 3 })], ["bytes equal", 3, index => ({ bytes: index ? 1 : maxBytes - 2 })], ["bytes above", 3, index => ({ bytes: index ? 1 : maxBytes - 1 })],
          ["large newest retains cumulative behavior", 3, index => ({ bytes: index ? 1 : maxBytes + 1, accessedAt: index ? test.time : "2027-01-01" })],
          ["equal timestamp primary-key order", 5, () => ({ bytes: Math.floor(maxBytes / 3) })],
          ["mixed bases and accounts", 7, index => ({ bytes: Math.floor(maxBytes / 3), baseUrl: index % 2 ? test.other : test.base, accountOwner: index % 2 ? "account:fixture" : "guest", accessedAt: `2026-10-0${index + 1}` })],
          ["legacy zero", 4, () => ({ bytes: 0 })], ["legacy missing bytes", 4, () => ({ bytes: undefined })],
          ["legacy missing time", 4, index => ({ bytes: Math.floor(maxBytes / 2), accessedAt: index % 2 ? undefined : "", updatedAt: `2026-10-0${index + 1}` })],
          ["typed array bytes", 4, () => ({ bytes: new Uint32Array([Math.floor(maxBytes / 2) + 1]) })], ["array bytes", 4, () => ({ bytes: [Math.floor(maxBytes / 2) + 1] })],
          ["Date time", 4, index => ({ bytes: Math.floor(maxBytes / 2), accessedAt: new Date(`2026-10-0${index + 1}`) })],
          ["array time", 4, index => ({ bytes: Math.floor(maxBytes / 2), accessedAt: [`2026-10-0${index + 1}`] })],
          ["typed array time", 4, index => ({ bytes: Math.floor(maxBytes / 2) + 1, accessedAt: new Uint8Array([20 + index]) })],
          ["negative bytes", 4, index => ({ bytes: index ? Math.floor(maxBytes / 2) : -10 })], ["infinite bytes", 3, () => ({ bytes: Infinity })],
          ["NaN bytes", 4, () => ({ bytes: NaN })], ["nonnumeric bytes", 4, () => ({ bytes: "not-a-number" })]
        ];
        const results = [];
        for (const [name, count, change] of scenarios) {
          const rows = Array.from({ length: count }, (_, index) => ({ ...test.row(store, index), ...change(index) }));
          if (name === "mixed bases and accounts") for (const row of rows) {
            if (store === "responses") row.key = `${row.baseUrl} responses:${test.version}${row.accountOwner === "guest" ? "" : " " + row.accountOwner} ${row.path}`;
            else row.key = row.url = `${row.baseUrl}/mixed-${rows.indexOf(row)}`;
          }
          await test.replace(store, rows);
          const before = await test.all(store), deleted = test.oldDeletes(store, before, maxCount, maxBytes);
          const measured = await test.measureTrim(store), after = await test.all(store);
          results.push({ name, expected: before.filter(row => !deleted.includes(row.key)).map(row => row.key), actual: after.map(row => row.key), countBefore: before.length, countAfter: after.length, fullReads: measured.fullReads });
        }
        return results;
      }, store);
      for (const result of results) assert.deepEqual(result.actual, result.expected, `${store}: ${result.name}`);
      assert(results.some(result => result.fullReads === 1)); assert(results.some(result => result.fullReads === 0));
      for (const name of ["count below", "count equal", "bytes below", "bytes equal"]) { const result = results.find(value => value.name === name); assert.equal(result.countAfter, result.countBefore, name); }
      assert.equal(results.find(value => value.name === "count above").countAfter, store === "responses" ? 600 : 2500);
      assert.equal(results.find(value => value.name === "large newest retains cumulative behavior").countAfter, 0);
      for (const name of ["legacy zero", "legacy missing bytes", "legacy missing time", "typed array bytes", "array bytes", "Date time", "array time", "typed array time", "NaN bytes"]) assert.equal(results.find(value => value.name === name).fullReads, 1, `${store}: ${name} must retain the full-entry fallback`);
    } finally { await testPage.close(); }
  });
  await run("blocked migration leaves the old database intact and retries after its owner closes", async () => {
    const testPage = await sandbox("blocked");
    try {
      const result = await testPage.evaluate(async () => {
        const held = await test.oldDatabase(2); await test.seedLegacy(held); const before = await test.snapshot(held);
        const api = await test.importApi(); let error = "";
        try { await api.getCacheStats(); } catch (failure) { error = failure.message; }
        const blocked = { version: held.version, schema: test.schema(held), values: await test.snapshot(held) };
        held.close(); await api.getCacheStats(); await api.__waitCacheMaintenance(); test.db = await api.__privateCache.openCacheDb();
        return { error, before, blocked, after: await test.snapshot(test.db), version: test.db.version };
      });
      assert.match(result.error, /升级被占用/u); assert.equal(result.blocked.version, 2);
      assert(!result.blocked.schema.responses.includes("trimMetadata")); assert.deepEqual(result.blocked.values, result.before);
      assert.equal(result.version, 3); assert.deepEqual(result.after, result.before);
    } finally { await testPage.close(); }
  });
  for (const oldVersion of [1, 2]) await run(`upgrade abort v${oldVersion} rolls back new stores/indexes and permits a retry`, async () => {
    const testPage = await sandbox(`upgrade-abort-${oldVersion}`);
    try {
      const result = await testPage.evaluate(async oldVersion => {
        const held = await test.oldDatabase(oldVersion); await test.seedLegacy(held); const before = await test.snapshot(held), schema = test.schema(held); held.close();
        const original = IDBObjectStore.prototype.createIndex; let injected = false;
        IDBObjectStore.prototype.createIndex = function (...args) { const value = original.apply(this, args); if (args[0] === "trimMetadata" && !injected) { injected = true; const tx = this.transaction; queueMicrotask(() => tx.abort()); } return value; };
        const api = await test.importApi(); let error = "";
        try { await api.getCacheStats(); } catch (failure) { error = failure.name + ": " + failure.message; } finally { IDBObjectStore.prototype.createIndex = original; }
        const reopened = await test.open(oldVersion), rolledBack = { version: reopened.version, values: await test.snapshot(reopened), schema: test.schema(reopened) }; reopened.close();
        await test.load();
        return { injected, error, before, schema, rolledBack, retryVersion: test.db.version };
      }, oldVersion);
      assert(result.injected); assert.match(result.error, /Abort/u); assert.equal(result.rolledBack.version, oldVersion);
      assert.deepEqual(result.rolledBack.values, result.before); assert.deepEqual(result.rolledBack.schema, result.schema); assert.equal(result.retryVersion, 3);
    } finally { await testPage.close(); }
  });
  for (const store of ["responses", "images"]) await run(`${store} trim delete request success followed by transaction abort rolls back all values and index keys`, async () => {
    const testPage = await sandbox(`trim-abort-${store}`);
    try {
      const result = await testPage.evaluate(async store => {
        await test.load(); await test.replace(store, Array.from({ length: 5 }, (_, index) => test.row(store, index, true)));
        const before = await test.snapshot(test.db), indexBefore = await test.request(test.db.transaction(store).objectStore(store).index("trimMetadata").getAllKeys());
        const original = IDBObjectStore.prototype.delete; let injected = false;
        IDBObjectStore.prototype.delete = function (...args) { const req = original.apply(this, args); if (this.name === store && !injected) { injected = true; const tx = this.transaction; req.addEventListener("success", () => tx.abort(), { once: true }); } return req; };
        let error = "";
        try { await test.trim(store); } catch (failure) { error = failure.message; } finally { IDBObjectStore.prototype.delete = original; }
        return { injected, error, before, after: await test.snapshot(test.db), indexBefore, indexAfter: await test.request(test.db.transaction(store).objectStore(store).index("trimMetadata").getAllKeys()) };
      }, store);
      assert(result.injected); assert.match(result.error, /中止|aborted/u); assert.deepEqual(result.after, result.before); assert.deepEqual(result.indexAfter, result.indexBefore);
    } finally { await testPage.close(); }
  });
  await run("versionchange closes the cached connection so a fresh private database can reopen", async () => {
    const testPage = await sandbox("versionchange");
    try {
      const result = await testPage.evaluate(async () => { await test.load(); await test.request(indexedDB.deleteDatabase(test.databaseName)); await test.api.getCacheStats(); return { version: (await test.api.__privateCache.openCacheDb()).version }; });
      assert.equal(result.version, 3);
    } finally { await testPage.close(); }
  });
  for (const store of ["responses", "images"]) for (const action of ["overwrite", "clear", "touch"]) await run(`${store} external ${action} serializes with a real same-origin trim transaction`, async () => {
    const first = await sandbox(`external-${store}-${action}`), second = await context.newPage();
    try {
      const shared = await first.evaluate(async store => { await test.load(); await test.replace(store, Array.from({ length: 5 }, (_, index) => test.row(store, index, true))); return { name: test.databaseName, module: test.moduleUrl, key: test.row(store, 4).key, path: test.row("responses", 4).path }; }, store);
      await second.goto(`${origin}/sandbox`); await installSandbox(second, shared.name, shared.module); await second.evaluate(() => test.load());
      if (action === "touch") {
        await second.evaluate(({ store, key, path }) => {
          test.holdTransaction("touch", store, key);
          test.pending = store === "responses" ? test.api.readCachedJson(test.base, path) : test.api.readCachedImage(key, { baseUrl: test.base });
        }, { store, ...shared });
        await second.waitForFunction(() => test.gate?.ready);
        await first.evaluate(store => { test.settled = false; test.pending = test.trim(store).then(() => { test.settled = true; }); }, store);
        assert.equal(await first.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return test.settled; }), false, "trim must wait for the earlier touch transaction");
        await second.evaluate(() => { test.gate.release = true; });
        await first.evaluate(() => test.pending);
        const rows = await first.evaluate(store => test.all(store), store);
        assert(rows.some(row => row.key === shared.key), "the committed touch must protect the recently accessed victim");
        assert.equal(rows.length, store === "responses" ? 3 : 2);
      } else {
        await first.evaluate(({ store, key }) => { test.holdTransaction("trim", store, key); test.pending = test.trim(store); }, { store, ...shared });
        await first.waitForFunction(() => test.gate?.ready);
        assert.equal(await first.evaluate(() => test.gate.mode), "readwrite");
        await second.evaluate(({ store, action, key, path }) => {
          test.settled = false;
          const operation = action === "clear" ? (store === "responses" ? test.api.clearCachedResponses(test.base) : test.api.clearCachedImages(test.base))
            : store === "responses" ? test.api.writeCachedJson(test.base, path, { title: "external-new" }) : test.api.writeCachedImage(key, new Blob(["external-new"]), { baseUrl: test.base });
          test.pending = operation.then(async () => { await test.api.__waitCacheMaintenance(); test.settled = true; });
        }, { store, action, ...shared });
        assert.equal(await second.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return test.settled; }), false, "external mutation must wait for the trim readwrite transaction");
        await first.evaluate(() => { test.gate.release = true; }); await first.evaluate(() => test.pending); await second.evaluate(() => test.pending);
        const values = await first.evaluate(async ({ store, key }) => ({ count: (await test.all(store)).length, current: await test.request(test.db.transaction(store).objectStore(store).get(key)) }), { store, ...shared });
        if (action === "clear") assert.equal(values.count, 0);
        else if (store === "responses") assert.equal(values.current?.payload?.title, "external-new");
        else assert.equal(await first.evaluate(key => test.request(test.db.transaction("images").objectStore("images").get(key)).then(row => row?.blob.text()), shared.key), "external-new");
      }
    } finally {
      await first.evaluate(() => { if (test.gate) test.gate.release = true; }).catch(() => {}); await second.evaluate(() => { if (test.gate) test.gate.release = true; }).catch(() => {});
      await first.close(); await second.close();
    }
  });
  const pruneBenchmarks = [];
  await run("cold stale prune skips 60MiB of current-key JSON against the old full-read oracle", async () => {
    const testPage = await sandbox("cold-prune");
    try {
      const result = await testPage.evaluate(async () => {
        const db = await test.oldDatabase(2), tx = db.transaction("responses", "readwrite"), done = test.complete(tx);
        const large = "s".repeat(1024 * 1024);
        for (let index = 0; index < 60; index++) {
          const row = test.row("responses", index); row.payload.large = large; row.bytes = large.length + 256;
          if (index % 3 === 0) { row.accountOwner = "account:fixture"; row.key = `${test.base} responses:${test.version} account:fixture ${row.path}`; }
          if (index % 3 === 1) delete row.version;
          tx.objectStore("responses").put(row);
        }
        await done; db.close();
        const current = await test.measurePrune(async () => { await test.importApi(); test.db = await test.api.__privateCache.openCacheDb(); await test.api.__waitCacheMaintenance(); });
        const oldApi = await import(test.moduleUrl.replace("/cache.js?", "/old-prune-cache.js?"));
        const old = await test.measurePrune(async () => { await oldApi.__privateCache.openCacheDb(); await oldApi.__waitCacheMaintenance(); });
        const txCheck = test.db.transaction("responses"), checkDone = test.complete(txCheck), count = await test.request(txCheck.objectStore("responses").count()); await checkDone;
        return { current, old, count };
      });
      assert.equal(result.count, 60); assert.equal(result.current.fullReads, 0); assert.equal(result.current.entryGets, 0); assert.equal(result.current.jsonChars, 0);
      assert.equal(result.current.keyReads, 1); assert.equal(result.current.keys, 60); assert.deepEqual(result.current.modes, ["readwrite"]);
      assert.equal(result.old.fullReads, 1); assert.equal(result.old.jsonChars, 60 * 1024 * 1024); assert.equal(result.old.keyReads, 0);
      pruneBenchmarks.push(result);
    } finally { await testPage.close(); }
  });
  await run("stale prune preserves version-only key-only account and special legal primary-key semantics", async () => {
    const testPage = await sandbox("prune-keys");
    try {
      const result = await testPage.evaluate(async () => {
        await test.load();
        const current = `responses:${test.version}`, tag = `${test.base} ${current} /api/key-only`;
        const definitions = [
          ["version-only", "version-only", current], ["key-only", tag, "responses:old"], ["account", `${test.base} ${current} account:fixture /api/a`, undefined],
          ["obsolete", "obsolete", "responses:old"], ["old-tag-new-field", `${test.base} responses:old /api/a`, current],
          ["zero", 0, "responses:old"], ["empty-string", "", "responses:old"], ["number-current", 2, current], ["number-stale", 1, "responses:old"],
          ["negative-current", -1, current], ["infinity-stale", Infinity, "responses:old"],
          ["array-current-tag", [tag, 1], "responses:old"], ["array-stale", [1, 2], "responses:old"], ["empty-array-stale", [], "responses:old"],
          ["date-current", new Date("2026-10-01"), current], ["date-stale", new Date("2026-10-02"), "responses:old"],
          ["binary-current", new Uint8Array([3, 4]).buffer, current], ["typed-binary-stale", new Uint8Array([5, 6]), "responses:old"]
        ];
        await test.replace("responses", definitions.map(([marker, key, version], index) => ({ ...test.row("responses", index), key, version, payload: { marker } })));
        const before = await test.all("responses"), expected = before.filter(row => !row.key || row.version === current || String(row.key).includes(` ${current} `)).map(row => row.payload.marker).sort();
        const measured = await test.measurePrune(() => test.api.__privateCache.pruneStaleResponseCache(test.db));
        return { measured, expected, actual: (await test.all("responses")).map(row => row.payload.marker).sort(), truthyCandidates: before.filter(row => row.key && !(typeof row.key === "string" && String(row.key).includes(` ${current} `))).length };
      });
      assert.deepEqual(result.actual, result.expected); assert(result.actual.includes("zero")); assert(result.actual.includes("empty-string"));
      assert(!result.actual.includes("empty-array-stale")); assert(result.actual.includes("array-current-tag"));
      assert.equal(result.measured.fullReads, 0); assert.equal(result.measured.keyReads, 1); assert.equal(result.measured.entryGets, result.truthyCandidates);
    } finally { await testPage.close(); }
  });
  await run("stale prune serializes a same-origin page update so its latest version survives", async () => {
    const first = await sandbox("prune-external"), second = await context.newPage();
    try {
      const shared = await first.evaluate(async () => { await test.load(); return { name: test.databaseName, module: test.moduleUrl }; });
      await second.goto(`${origin}/sandbox`); await installSandbox(second, shared.name, shared.module); await second.evaluate(() => test.load());
      await first.evaluate(async () => {
        await test.replace("responses", [{ ...test.row("responses", 0), key: "old-external-key", version: "responses:old", payload: { title: "old" } }]);
        test.holdTransaction("prune", "responses", "old-external-key"); test.pending = test.api.__privateCache.pruneStaleResponseCache(test.db);
      });
      await first.waitForFunction(() => test.gate?.ready);
      assert.equal(await first.evaluate(() => test.gate.mode), "readwrite");
      await second.evaluate(() => {
        test.settled = false; const tx = test.db.transaction("responses", "readwrite"), done = test.complete(tx);
        tx.objectStore("responses").put({ ...test.row("responses", 0), key: "old-external-key", version: `responses:${test.version}`, payload: { title: "latest" } });
        test.pending = done.then(() => { test.settled = true; });
      });
      assert.equal(await second.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return test.settled; }), false);
      await first.evaluate(() => { test.gate.release = true; }); await first.evaluate(() => test.pending); await second.evaluate(() => test.pending);
      assert.equal(await first.evaluate(() => test.request(test.db.transaction("responses").objectStore("responses").get("old-external-key")).then(row => row?.payload?.title)), "latest");
    } finally { await first.evaluate(() => { if (test.gate) test.gate.release = true; }).catch(() => {}); await first.close(); await second.close(); }
  });
  await run("old split stale-prune snapshot counterexample deletes another page's newer version", async () => {
    const first = await sandbox("prune-old-external"), second = await context.newPage();
    try {
      const shared = await first.evaluate(async () => { await test.load(); return { name: test.databaseName, module: test.moduleUrl }; });
      await second.goto(`${origin}/sandbox`); await installSandbox(second, shared.name, shared.module); await second.evaluate(() => test.load());
      await first.evaluate(async () => {
        const oldApi = await import(test.moduleUrl.replace("/cache.js?", "/old-prune-cache.js?")); await oldApi.__privateCache.openCacheDb(); await oldApi.__waitCacheMaintenance();
        await test.replace("responses", [{ ...test.row("responses", 0), key: "old-external-key", version: "responses:old", payload: { title: "old" } }]);
        globalThis.__privateOldPruneSnapshotGate = () => { test.snapshotReady = true; return new Promise(resolve => { test.releaseSnapshot = resolve; }); };
        test.pending = oldApi.__privateCache.pruneStaleResponseCache(test.db);
      });
      await first.waitForFunction(() => test.snapshotReady);
      await second.evaluate(async () => { const tx = test.db.transaction("responses", "readwrite"), done = test.complete(tx); tx.objectStore("responses").put({ ...test.row("responses", 0), key: "old-external-key", version: `responses:${test.version}`, payload: { title: "latest" } }); await done; });
      await first.evaluate(() => { test.releaseSnapshot(); globalThis.__privateOldPruneSnapshotGate = null; }); await first.evaluate(() => test.pending);
      assert.equal(await first.evaluate(() => test.request(test.db.transaction("responses").objectStore("responses").get("old-external-key"))), undefined);
    } finally { await first.evaluate(() => test.releaseSnapshot?.()).catch(() => {}); await first.close(); await second.close(); }
  });
  await run("stale-prune delete request success then abort rejects and restores all values and index keys", async () => {
    const testPage = await sandbox("prune-abort");
    try {
      const result = await testPage.evaluate(async () => {
        await test.load(); await test.replace("responses", [test.row("responses", 0), { ...test.row("responses", 1), key: "obsolete-a", version: "responses:old" }]);
        const before = await test.snapshot(test.db), keysBefore = await test.request(test.db.transaction("responses").objectStore("responses").index("trimMetadata").getAllKeys());
        const original = IDBObjectStore.prototype.delete; let injected = false, error = "";
        IDBObjectStore.prototype.delete = function (...args) { const req = original.apply(this, args); if (this.name === "responses" && !injected) { injected = true; const tx = this.transaction; req.addEventListener("success", () => tx.abort(), { once: true }); } return req; };
        try { await test.api.__privateCache.pruneStaleResponseCache(test.db); } catch (failure) { error = failure.name + ": " + failure.message; } finally { IDBObjectStore.prototype.delete = original; }
        return { injected, error, before, after: await test.snapshot(test.db), keysBefore, keysAfter: await test.request(test.db.transaction("responses").objectStore("responses").index("trimMetadata").getAllKeys()) };
      });
      assert(result.injected); assert.match(result.error, /abort|中止/iu); assert.deepEqual(result.after, result.before); assert.deepEqual(result.keysAfter, result.keysBefore);
    } finally { await testPage.close(); }
  });
  if (caseFilter) assert(checks > 0, `no cache fixture case matched: ${caseFilter}`);
  assert.deepEqual(faults, []); assert.deepEqual(blocked, []);
  assert(requests.every(value => value === "/probe" || value === "/sandbox" || value === "/favicon.ico" || value.startsWith("/android/js/")));
  console.log(JSON.stringify({ sourceHash, pruneBenchmarks, trimBenchmarks, rounds: benchmarks.map(value => ({ currentMs: value.current.ms, legacyMs: value.legacy.ms, currentHeartbeatLag: value.current.maxHeartbeatLag, legacyHeartbeatLag: value.legacy.maxHeartbeatLag, currentJsonMiB: value.current.reads[0].jsonChars / 1024 / 1024, legacyJsonMiB: value.legacy.reads[0].jsonChars / 1024 / 1024, currentBlobHandles: value.current.reads[1].blobHandles, legacyBlobHandles: value.legacy.reads[1].blobHandles, blobContentReads: value.current.arrayBufferCalls + value.legacy.arrayBufferCalls })) }));
  console.log(`Verified ${checks} Android cache statistics groups with private Chromium/IndexedDB`);
  await context.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

function readShape(measured) { return measured.reads.filter(row => row.method !== "openKeyCursor").map(row => [row.store, row.index, row.method, row.rows]); }
function payloadTrim(value) {
  const marker = "async function readCacheTrimRows(store) {";
  assert.equal(value.split(marker).length, 2, "missing actual trim projection hook");
  return value.replace(marker, marker + "\n  return requestToPromise(store.getAll());");
}
function stalePayloadPrune(value) {
  const begin = value.indexOf("async function pruneStaleResponseCache(db) {"), end = value.indexOf("\nfunction scheduleResponseCacheTrim()", begin);
  assert(begin >= 0 && end > begin, "missing actual stale-prune oracle boundary");
  return value.slice(0, begin) + `async function pruneStaleResponseCache(db) {
    if (!db?.objectStoreNames?.contains(RESPONSE_STORE)) return;
    const rows = await requestToPromise(db.transaction(RESPONSE_STORE, "readonly").objectStore(RESPONSE_STORE).getAll());
    const staleKeys = rows.filter(entry => entry?.key && !isCurrentResponseCache(entry)).map(entry => entry.key);
    if (!staleKeys.length) return;
    // The optional fixture gate holds the old gap between separate transactions.
    if (globalThis.__privateOldPruneSnapshotGate) await globalThis.__privateOldPruneSnapshotGate();
    const transaction = db.transaction(RESPONSE_STORE, "readwrite"), store = transaction.objectStore(RESPONSE_STORE);
    await Promise.all(staleKeys.map(key => requestToPromise(store.delete(key))));
  }
` + value.slice(end);
}
function send(res, data, contentType) { res.writeHead(200, { "Content-Type": contentType }); res.end(data); }
function unfilteredStats(value) {
  for (const name of ["responseStore", "imageStore"]) {
    const marker = `${name}.index("baseUrl").getAll(normalizedBase)`;
    assert.equal(value.split(marker).length, 2, `missing actual ${name} statistics hook`);
    value = value.replace(marker, `${name}.getAll()`);
  }
  return value;
}

async function installSandbox(page, databaseName, moduleUrl) {
  await page.evaluate(async ({ databaseName, moduleUrl }) => {
    const version = (await import("/android/js/config.js")).CLIENT_VERSION;
    const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("aborted")); });
    const base = location.origin + "/one", other = location.origin + "/two", time = "2026-10-04T00:00:00.000Z";
    window.test = {
      databaseName, moduleUrl, version, base, other, time, request, complete,
      open(version, upgrade) { return new Promise((resolve, reject) => { const req = indexedDB.open(databaseName, version); req.onupgradeneeded = () => upgrade?.(req.result, req.transaction); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); },
      oldDatabase(version) { return this.open(version, db => { for (const name of version === 1 ? ["responses"] : ["responses", "images"]) { const store = db.createObjectStore(name, { keyPath: "key" }); store.createIndex("baseUrl", "baseUrl"); store.createIndex("updatedAt", "updatedAt"); } }); },
      async importApi() { return this.api ||= await import(moduleUrl); },
      async load() { await this.importApi(); await this.api.getCacheStats(); await this.api.__waitCacheMaintenance(); this.db = await this.api.__privateCache.openCacheDb(); },
      schema(db) { return Object.fromEntries([...db.objectStoreNames].map(name => [name, [...db.transaction(name).objectStore(name).indexNames]])); },
      async snapshot(db) { const value = {}; for (const name of db.objectStoreNames) { const tx = db.transaction(name), done = complete(tx), rows = await request(tx.objectStore(name).getAll()); await done; value[name] = await Promise.all(rows.map(async row => row.blob ? { ...row, blob: { size: row.blob.size, type: row.blob.type, text: await row.blob.text() } } : row)); } return value; },
      row(store, index, overBudget = false) {
        const key = `${base} responses:${version} /api/row${String(index).padStart(4, "0")}`, url = `${base}/image-${String(index).padStart(4, "0")}`;
        const common = { baseUrl: base, bytes: overBudget ? (store === "responses" ? 40 : 100) * 1024 * 1024 : 1, accessedAt: time, updatedAt: time };
        return store === "responses" ? { ...common, key, path: `/api/row${String(index).padStart(4, "0")}`, accountOwner: "guest", version: `responses:${version}`, payload: { index, title: "私有fixture" } } : { ...common, key: url, url, blob: new Blob([`image-${index}`], { type: "image/svg+xml" }) };
      },
      async seedLegacy(db) {
        const names = [...db.objectStoreNames], tx = db.transaction(names, "readwrite"), done = complete(tx);
        const rows = [this.row("responses", 0), { ...this.row("responses", 1), bytes: undefined, accessedAt: undefined }, { ...this.row("responses", 2), bytes: 0, accountOwner: "account:fixture", payload: { title: "中文旧值" } }, { ...this.row("responses", 3), bytes: new Uint8Array([5]) }, { ...this.row("responses", 4), bytes: [5], accessedAt: [time] }, { ...this.row("responses", 5), accessedAt: new Date(time) }];
        rows.forEach(row => tx.objectStore("responses").put(row));
        if (names.includes("images")) [{ ...this.row("images", 0), bytes: 0 }, { ...this.row("images", 1), accessedAt: undefined }, { ...this.row("images", 2), bytes: new Uint8Array([5]), updatedAt: new Date(time) }, { ...this.row("images", 3), bytes: [5], accessedAt: [time] }].forEach(row => tx.objectStore("images").put(row));
        await done;
      },
      async replace(store, rows) { const tx = this.db.transaction(store, "readwrite"), done = complete(tx); tx.objectStore(store).clear(); rows.forEach(row => tx.objectStore(store).put(row)); await done; },
      all(store) { return request(this.db.transaction(store).objectStore(store).getAll()); },
      trim(store) { return this.api.__privateCache[store === "responses" ? "trimResponseCache" : "trimImageCache"](); },
      async measureTrim(store) { const original = IDBObjectStore.prototype.getAll; let fullReads = 0; IDBObjectStore.prototype.getAll = function (...args) { if (this.name === store) fullReads++; return original.apply(this, args); }; try { await this.trim(store); return { fullReads }; } finally { IDBObjectStore.prototype.getAll = original; } },
      async measurePrune(operation) {
        const originals = {}, measured = { fullReads: 0, entryGets: 0, keyReads: 0, keys: 0, jsonChars: 0, modes: [] };
        for (const method of ["getAll", "getAllKeys", "get"]) {
          originals[method] = IDBObjectStore.prototype[method];
          IDBObjectStore.prototype[method] = function (...args) {
            const req = originals[method].apply(this, args);
            if (this.name !== "responses") return req;
            if (method === "getAllKeys") { measured.keyReads++; measured.modes.push(this.transaction.mode); }
            else if (method === "getAll") measured.fullReads++; else measured.entryGets++;
            req.addEventListener("success", () => { if (method === "getAllKeys") measured.keys += req.result.length; else { const rows = method === "getAll" ? req.result : req.result ? [req.result] : []; measured.jsonChars += rows.reduce((sum, row) => sum + (row.payload?.large?.length || 0), 0); } });
            return req;
          };
        }
        const start = performance.now();
        try { await operation(); return { ...measured, ms: performance.now() - start }; }
        finally { for (const method of Object.keys(originals)) IDBObjectStore.prototype[method] = originals[method]; }
      },
      holdTransaction(kind, storeName, key) {
        const originalGet = IDBObjectStore.prototype.get, originalCursor = IDBIndex.prototype.openKeyCursor, originalKeys = IDBObjectStore.prototype.getAllKeys;
        const gate = this.gate = { ready: false, release: false };
        const start = store => {
          if (gate.ready) return; gate.ready = true; gate.mode = store.transaction.mode;
          const keepAlive = () => { if (gate.release) return; const req = originalGet.call(store, key); req.onsuccess = keepAlive; req.onerror = () => {}; }; keepAlive();
        };
        if (kind === "prune") IDBObjectStore.prototype.getAllKeys = function (...args) { const req = originalKeys.apply(this, args); if (this.name === storeName) { const store = this; req.addEventListener("success", () => start(store), { once: true }); } return req; };
        else if (kind === "trim") IDBIndex.prototype.openKeyCursor = function (...args) { const req = originalCursor.apply(this, args); if (this.objectStore.name === storeName && this.name === "trimMetadata") { const store = this.objectStore; req.addEventListener("success", () => { if (!req.result) start(store); }); } return req; };
        else IDBObjectStore.prototype.get = function (...args) { const req = originalGet.apply(this, args); if (this.name === storeName && this.transaction.mode === "readwrite" && args[0] === key) { const store = this; req.addEventListener("success", () => start(store), { once: true }); } return req; };
      },
      oldDeletes(store, rows, maxEntries, maxBytes) {
        const bytes = row => Number(row.bytes || (store === "images" ? row.blob?.size || 0 : new Blob([JSON.stringify(row)]).size));
        if (rows.length <= maxEntries && rows.reduce((sum, row) => sum + bytes(row), 0) <= maxBytes) return [];
        let count = 0, size = 0;
        return rows.slice().sort((a, b) => String(b.accessedAt || b.updatedAt || "").localeCompare(String(a.accessedAt || a.updatedAt || ""))).filter(row => { count++; size += bytes(row); return count > maxEntries || size > maxBytes; }).map(row => row.key);
      }
    };
  }, { databaseName, moduleUrl });
}

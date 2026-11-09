import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "private Chromium required");
const path = "android-client/www/platform/content-index/channel-views.js";
const baseline = execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:${path}`], { cwd: root, encoding: "utf8" });
const current = fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function restoreBaseline(name, next, currentNext = next) {
  const pattern = end => new RegExp(`^  (?:async )?function ${name}\\([\\s\\S]*?(?=^  (?:async )?function ${end}\\()`, "m");
  const body = baseline.match(pattern(next))?.[0];
  assert(body && pattern(currentNext).test(current), `snapshot matches ${name}`);
  return source => source.replace(pattern(currentNext), () => body);
}
const legacy = [
  restoreBaseline("renderPhotoDetail", "renderPhotoAlbum"),
  restoreBaseline("renderPhotoAlbum", "applyPhotoAlbumHeader"),
  restoreBaseline("appendPhotoDetailLoadMore", "mergePhotoDetailImages"),
  restoreBaseline("createPhotoTile", "photoViewerItems"),
  restoreBaseline("photoViewerItems", "hydratePhotoViewerItems", "rememberPhotoViewerRange")
].reduce((source, replace) => replace(source), current);
const server = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serverExit = once(server, "exit");
const id = "fixture-photo-album", total = 480, delayMs = 175;
const photoPath = `/media/gallery/${id}/`;
const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="64"><rect width="32" height="64" fill="#507886"/></svg>';
const images = Array.from({ length: total }, (_, i) => ({
  index: i + 1, name: `页-${i + 1}.jpg`, archivePath: `private-fixture/volume-${i + 1}.jpg`, bytes: 10240, url: photoPath + (i + 1)
}));
const args = process.argv.slice(2);
assert(args.every(arg => ["--baseline-only", "--current-first"].includes(arg)));
const variants = args.includes("--baseline-only") ? [true] : args.includes("--current-first") ? [false, true] : [true, false];
let browser;
try {
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error("private fixture startup timed out")), 10000);
    server.stdout.on("data", bytes => {
      output += bytes;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once("error", error => { clearTimeout(timer); reject(error); });
    server.once("exit", code => { clearTimeout(timer); reject(Error(`private fixture exited (${code})`)); });
  });
  browser = await chromium.launch({ executablePath, headless: true });
  for (const previous of variants) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(10000);
    const requests = [], media = [], faults = [];
    let reloading = false;
    const refreshedDetail = Promise.withResolvers();
    page.on("pageerror", error => faults.push(error.message));
    await page.route(url => url.origin !== origin, route => route.abort());
    if (previous) await page.route(url => url.pathname.endsWith("/platform/content-index/channel-views.js"),
      route => route.fulfill({ contentType: "text/javascript", body: legacy }));
    await page.route(url => url.pathname === `/api/photo-sets/${id}`, async route => {
      const url = new URL(route.request().url());
      const limit = url.searchParams.get("imageLimit");
      const offset = Number(url.searchParams.get("imageOffset") || 0);
      if (reloading && limit === "all") {
        requests.push({ limit, bytes: 0 });
        await route.fulfill({ status: 503, json: { error: "合成目录不可用" } });
        return;
      }
      if (reloading) await refreshedDetail.promise;
      const count = limit === "all" ? total : Number(limit || total);
      const body = JSON.stringify({ album: { id, title: "合成相册", category: "写真", imageCount: total,
        imageOffset: offset, imageLimit: count, imagesTruncated: offset + count < total,
        updatedAt: "2026-10-01T00:00:00Z", images: images.slice(offset, offset + count) } });
      requests.push({ limit, bytes: Buffer.byteLength(body) });
      if (limit === "all") await new Promise(resolve => setTimeout(resolve, delayMs));
      await route.fulfill({ contentType: "application/json", body });
    });
    await page.route(url => url.pathname.startsWith(photoPath), route => {
      media.push(new URL(route.request().url()).pathname);
      return route.fulfill({ contentType: "image/svg+xml", body: poster });
    });
    await page.addInitScript(({ total }) => {
      document.addEventListener("click", event => {
        if (event.target.closest(".photo-preview-tile")) window.rangeOpenAt = performance.now();
      }, { capture: true });
      new MutationObserver(() => {
        if (window.rangeOpenAt === undefined || window.rangeReadyAt !== undefined) return;
        const range = document.querySelector(".media-viewer-range");
        if (range) window.rangeFirstMax ??= Number(range.max);
        if (Number(range?.max) === total) window.rangeReadyAt = performance.now();
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["max"] });
    }, { total });
    try {
      const run = await page.request.post(`${origin}/fixture/new-run?scenario=photo-categories`);
      assert(run.ok(), await run.text());
      const url = new URL((await run.json()).url, origin);
      url.hash = `photoDetail?id=${id}`;
      await page.goto(url.href);
      const tile = page.locator(".photo-preview-tile").first();
      await tile.waitFor();
      await page.waitForFunction(() => document.querySelector(".photo-preview-tile img")?.naturalWidth > 0);
      assert.equal(requests.length, 1, "entering the album requests only its initial page");
      await tile.tap();
      await page.waitForFunction(() => Number.isFinite(window.rangeReadyAt));
      const { firstMax, rangeMs } = await page.evaluate(() => ({
        firstMax: window.rangeFirstMax, rangeMs: Math.round(window.rangeReadyAt - window.rangeOpenAt)
      }));
      await page.locator(".media-viewer-range").evaluate((input, index) => {
        input.value = String(index); input.dispatchEvent(new Event("input"));
      }, total);
      await page.waitForFunction(total => document.querySelector(".media-viewer-count")?.textContent === `${total} / ${total}`
        && document.querySelector(".media-viewer-stage")?.dataset.imageState === "ready", total);
      assert(media.includes(photoPath + total), "tail image uses its real numbered route");
      const hydration = requests.filter(request => request.limit === "all");
      assert.equal(hydration.length, previous ? 1 : 0);
      assert.equal(previous ? firstMax < total : firstMax === total, true, "initial range availability");
      assert.deepEqual(faults, []);
      console.log(JSON.stringify({ variant: previous ? "baseline" : "current", firstMax, rangeMs,
        extraRequests: hydration.length, extraBytes: hydration.reduce((sum, request) => sum + request.bytes, 0) }));
      if (!previous) {
        const descriptorPath = `android:photo-viewer-range/${id}`;
        const cacheModule = await page.evaluate(() => performance.getEntriesByType("resource")
          .find(entry => new URL(entry.name).pathname.endsWith("/js/cache.js"))?.name);
        assert(cacheModule, "actual cache module is loaded");
        await page.waitForFunction(async ({ module, path, total }) => {
          const { readCachedJson } = await import(module);
          return (await readCachedJson(location.origin, path))?.payload?.total === total;
        }, { module: cacheModule, path: descriptorPath, total });
        // A held fresh response makes this a real IndexedDB-only render.
        reloading = true;
        await page.reload({ waitUntil: "domcontentloaded" });
        await tile.waitFor();
        await page.waitForFunction(() => document.querySelector(".photo-preview-tile img")?.naturalWidth > 0);
        assert.match(await page.locator("#viewMeta").textContent(), /缓存/u);
        const cachedTile = await tile.elementHandle();
        const range = page.locator(".media-viewer-range");
        await tile.tap();
        await page.waitForFunction(total => Number(document.querySelector(".media-viewer-range")?.max) === total, total);
        assert.equal(requests.filter(request => request.limit === "all").length, 0, "the persisted range is available offline");
        await page.locator(".media-viewer-close").tap();
        await page.evaluate(async ({ module, path }) => {
          const { clearCachedJsonByPrefix } = await import(module);
          await clearCachedJsonByPrefix(location.origin, path);
        }, { module: cacheModule, path: descriptorPath });
        const failedHydration = page.waitForResponse(response => response.status() === 503
          && new URL(response.url()).searchParams.get("imageLimit") === "all");
        await tile.tap();
        await failedHydration;
        assert(Number(await range.getAttribute("max")) < total, "an offline metadata miss retains the cached prefix");
        await page.locator(".media-viewer-close").tap();
        refreshedDetail.resolve();
        await page.waitForFunction(() => !document.getElementById("viewMeta").textContent.includes("缓存"));
        assert.equal(await cachedTile.evaluate(element => element.isConnected), true, "identical refresh must retain existing tiles");
        await tile.tap();
        assert.equal(Number(await range.getAttribute("max")), total, "the same cached tile adopts the verified full range");
        assert.equal(requests.filter(request => request.limit === "all").length, 1, "only the offline opening tried hydration");
        assert.deepEqual(faults, []);
      }
    } finally {
      refreshedDetail.resolve();
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.kill();
  await serverExit;
}

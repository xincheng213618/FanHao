import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed Chromium required");
const path = "android-client/www/platform/content-index/channel-views.js";
const original = execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:${path}`], { cwd: root, encoding: "utf8" });
const current = fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const method = /^  async function renderMediaDetail\([\s\S]*?(?=^  function renderGalleryMedia\()/m;
const currentMethod = /^  async function renderMediaDetail\([\s\S]*?(?=^  function (?:applyGalleryMediaMeta|renderGalleryMedia)\()/m;
assert(method.test(original) && currentMethod.test(current));
const legacy = current.replace(currentMethod, () => original.match(method)[0]);
const server = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serverExit = once(server, "exit");
const seriesKey = "synthetic-detail-reuse-series", total = 480, position = 250;
const episodes = Array.from({ length: total }, (_, index) => ({
  id: `synthetic-reuse-${index + 1}`, seriesKey, seriesName: "合成影集", type: "tv", mediaKind: "tv",
  title: `合成影集 S01E${String(index + 1).padStart(3, "0")}`, ext: "mkv", size: 40000000, category: "合成",
  coverUrl: "/fixture/poster/movie-one.svg", updatedAt: "2026-11-01T00:00:00Z", playable: false
}));
const detailItem = { ...episodes[position - 1], type: "media", exists: false, streamUrl: "", progress: null, relativePath: "synthetic/target.mkv" };
const endpoint = `/api/gallery-media/${detailItem.id}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    const faults = [], scans = [], details = [];
    const allowFresh = Promise.withResolvers(), allowEarlyScan = Promise.withResolvers(),
      allowFailedScan = Promise.withResolvers(), allowRetryConfirmation = Promise.withResolvers(),
      allowChanged = Promise.withResolvers();
    let phase = "cold";
    page.on("pageerror", error => faults.push(error.message));
    await page.route(url => url.origin !== origin, route => route.abort());
    if (previous) await page.route(url => url.pathname.endsWith("/platform/content-index/channel-views.js"),
      route => route.fulfill({ contentType: "text/javascript", body: legacy }));
    await page.route(url => url.pathname === endpoint, async route => {
      const currentPhase = phase;
      details.push(currentPhase);
      if (currentPhase === "warm") await allowFresh.promise;
      if (currentPhase === "retry-after-error") await allowRetryConfirmation.promise;
      if (currentPhase === "changed") await allowChanged.promise;
      if (currentPhase === "offline") return route.fulfill({ status: 503, json: { error: "合成离线" } });
      const item = currentPhase === "changed" ? { ...detailItem, ext: "mp4" } : detailItem;
      return route.fulfill({ json: { item } });
    });
    await page.route(url => url.pathname === "/api/image-library/items" && url.searchParams.get("tvView") === "episodes", async route => {
      const query = new URL(route.request().url()).searchParams;
      const offset = Number(query.get("offset") || 0);
      const limit = Math.min(240, Number(query.get("limit")));
      const forNavigation = query.get("sort") === "title" && !query.has("q");
      const items = forNavigation ? episodes.slice(offset, offset + limit) : [episodes[position - 1]];
      const body = JSON.stringify({ mode: "tv", tvView: "episodes", seriesKey, items, offset, limit,
        total: forNavigation ? total : 1, scannedAt: "2026-11-01T00:00:00Z", listRevision: "synthetic-detail-reuse-v1",
        facets: { categories: [], people: [] }, seriesSummary: { title: "合成影集", episodeCount: total } });
      if (forNavigation) {
        const currentPhase = phase;
        const scanCount = scans.filter(scan => scan.phase === currentPhase).length + 1;
        scans.push({ phase: currentPhase, offset, count: items.length, bytes: Buffer.byteLength(body) });
        if (scanCount === 1 && currentPhase === "fast-fresh") await allowEarlyScan.promise;
        if (scanCount === 1 && currentPhase === "retry-in-flight") await allowFailedScan.promise;
        if (currentPhase === "offline" || (scanCount === 1 && currentPhase === "retry-in-flight")
          || (scanCount <= 2 && currentPhase === "retry-after-error")) {
          return route.fulfill({ status: 503, json: { error: "合成目录暂不可用" } });
        }
        await delay(70);
      }
      await route.fulfill({ contentType: "application/json", body });
    });
    try {
      const response = await page.request.post(`${origin}/fixture/new-run?scenario=media-layout`);
      assert(response.ok(), await response.text());
      const url = new URL((await response.json()).url, origin);
      url.hash = `channel?mode=tv&tvView=episodes&seriesKey=${seriesKey}&q=250`;
      await page.goto(url.href);
      const card = page.locator(".media-episode-card");
      const readyNav = page.locator(".media-episode-nav[data-state=ready]");
      await card.tap();
      await readyNav.waitFor();
      assert.match(await readyNav.textContent(), /第 250 \/ 480 集/);
      const cacheModule = await page.evaluate(() => performance.getEntriesByType("resource")
        .find(entry => new URL(entry.name).pathname.endsWith("/js/cache.js"))?.name);
      assert(cacheModule);
      await page.waitForFunction(async ({ cacheModule, endpoint }) => {
        const { readCachedJson } = await import(cacheModule);
        return Boolean((await readCachedJson(location.origin, endpoint))?.payload?.item);
      }, { cacheModule, endpoint });
      const reopen = async (next) => {
        await page.locator(".media-back-action").tap();
        await card.waitFor();
        phase = next;
        await card.tap();
      };
      const waitConfirmed = () => page.waitForFunction(() => Boolean(document.querySelector(".media-episode-nav"))
        && !document.getElementById("viewMeta").textContent.includes("缓存"));
      const phaseOffsets = (name) => scans.filter(scan => scan.phase === name).map(scan => scan.offset);
      await reopen("warm");
      await readyNav.waitFor();
      assert.match(await page.locator("#viewMeta").textContent(), /缓存/u);
      const mounted = await readyNav.elementHandle();
      const playSurface = await page.locator(".media-native-play-surface").elementHandle();
      const started = performance.now();
      allowFresh.resolve();
      await waitConfirmed();
      await readyNav.waitFor();
      const postRefreshMs = Math.round(performance.now() - started);
      const retainedNav = await mounted.evaluate(node => node.isConnected);
      const retainedPlay = await playSurface.evaluate(node => node.isConnected);
      assert.equal(retainedNav, !previous);
      assert.equal(retainedPlay, !previous);
      const reads = scans.filter(scan => scan.phase === "warm");
      assert.deepEqual(reads.map(read => read.offset), previous ? [0, 240, 0, 240] : [0, 240]);
      assert.equal(details.filter(value => value === "warm").length, 1, "fresh detail itself remains required");
      assert.deepEqual(faults, []);
      console.log(JSON.stringify({ variant: previous ? "baseline" : "current", postRefreshMs, retainedNav, retainedPlay,
        requests: reads.length, rows: reads.reduce((sum, item) => sum + item.count, 0),
        bytes: reads.reduce((sum, item) => sum + item.bytes, 0) }));
      if (!previous) {
        await reopen("fast-fresh");
        const pendingNav = await page.locator(".media-episode-nav").elementHandle();
        await waitConfirmed();
        assert.equal(await pendingNav.evaluate(node => node.isConnected), true);
        assert.deepEqual(phaseOffsets("fast-fresh"), [0]);
        allowEarlyScan.resolve();
        await readyNav.waitFor();
        assert.deepEqual(phaseOffsets("fast-fresh"), [0, 240], "early detail shares the pending scan");

        await reopen("retry-in-flight");
        const retryNav = await page.locator(".media-episode-nav").elementHandle();
        await waitConfirmed();
        allowFailedScan.resolve();
        await readyNav.waitFor();
        assert.equal(await retryNav.evaluate(node => node.isConnected), true);
        assert.deepEqual(phaseOffsets("retry-in-flight"), [0, 0, 240], "a pending failure retries once after confirmation");

        await reopen("retry-after-error");
        const failedNav = await page.locator(".media-episode-nav[data-state=error]").elementHandle();
        const failedRetry = page.waitForResponse(response => response.status() === 503
          && new URL(response.url()).pathname === "/api/image-library/items");
        allowRetryConfirmation.resolve();
        await failedRetry;
        await page.locator(".media-episode-nav[data-state=error]").waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(phaseOffsets("retry-after-error"), [0, 0], "a second failure does not schedule another automatic retry");
        await page.getByRole("button", { name: "重新读取集数" }).tap();
        await readyNav.waitFor();
        assert.equal(await failedNav.evaluate(node => node.isConnected), true);
        assert.deepEqual(phaseOffsets("retry-after-error"), [0, 0, 0, 240], "manual retry remains available after the automatic retry");

        await reopen("offline");
        await page.locator(".media-episode-nav[data-state=error]").waitFor();
        await page.getByText("电脑端暂时连不上，当前显示的是本地缓存媒体信息。", { exact: true }).waitFor();
        assert.match(await page.locator("#viewMeta").textContent(), /缓存/u);
        assert.deepEqual(phaseOffsets("offline"), [0], "offline detail cannot trigger an automatic scan retry");

        await reopen("changed");
        await readyNav.waitFor();
        const oldNav = await readyNav.elementHandle();
        allowChanged.resolve();
        await waitConfirmed();
        await readyNav.waitFor();
        assert.equal(await oldNav.evaluate(node => node.isConnected), false);
        assert.match(await page.locator("#viewMeta").textContent(), /MP4/u);
        assert.deepEqual(phaseOffsets("changed"), [0, 240, 0, 240], "changed detail uses the normal replacement");
        assert.deepEqual(faults, []);
      }
    } finally {
      for (const gate of [allowFresh, allowEarlyScan, allowFailedScan, allowRetryConfirmation, allowChanged]) gate.resolve();
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.kill();
  await serverExit;
}

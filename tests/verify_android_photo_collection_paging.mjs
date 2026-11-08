import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

const executable = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executable, "Chrome or Edge is required for the Android collection fixture");
const baseline = process.argv.includes("--baseline"), count = 5600;
const rows = Array.from({ length: count * 2 }, (_, i) => {
  const index = Math.floor(i / 2), collection = `合成收藏 ${String(index + 1).padStart(4, "0")}`;
  return { id: `synthetic-album-${i + 1}`, title: `${collection} 第 ${i % 2 + 1} 期`,
    sourceRoot: "synthetic-root", rootLabel: "合成目录", relativePath: `${collection}/第 ${i % 2 + 1} 期`, collectionId: `synthetic-root|${collection}`,
    category: index % 3 ? "国模" : "我喜欢的", subCategory: "合成子分类", personName: "合成人物",
    size: 2000 + index, imageCount: 12, coverUrl: "/fixture/poster/photo-one.svg",
    updatedAt: new Date(Date.UTC(2026, 9, 5) - i * 60000).toISOString() };
});
let revision = 1;
let snapshot = { scannedAt: "synthetic-library", photoSets: rows, mediaItems: [] };
const oracle = createImageLibraryService({
  cachePreparedQueries: true,
  clampInteger(value, fallback, min, max) {
    const number = Number.parseInt(String(value ?? ""), 10);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
  },
  getImageLibraryIndex: () => snapshot, getImageLibraryRevision: () => revision,
  maxItemLimit: 5000,
  galleryMediaRootStatuses: () => [], photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}),
  mangaService: { cacheDirs: () => [], publicSummary: value => value, rootStatus: () => ({ root: "", exists: false }) },
  metadataService: {}, photoSetService: { coverUrl: () => "" }, photoCollectionRootValue: "synthetic"
});
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "inherit"] });
const exited = new Promise(resolve => service.once("exit", resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic service start timed out")), 15000);
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`Synthetic service exited ${code}`)); });
    let output = "";
    service.stdout.on("data", data => { output += data; const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (url) { clearTimeout(timer); resolve(url[0]); } });
  });
  const created = await fetch(`${origin}/fixture/new-run?scenario=photo-categories`, { method: "POST" });
  assert.equal(created.status, 200);
  const run = await created.json();
  const entry = `${origin}${run.url}#channel?mode=photo&photoView=collections&category=all`;
  browser = await chromium.launch({ executablePath: executable, headless: true });
  const samples = [], bodies = new Map();
  for (let iteration = 0; iteration < 4; iteration++) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const requests = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
          errors.push(`${request.method()} ${url.origin}${url.pathname}`);
          return route.abort();
        }
        if (url.pathname !== "/api/image-library/items" || url.searchParams.get("mode") !== "photo") return route.continue();
        const key = url.search;
        if (!bodies.has(key)) {
          const data = oracle.itemsPayload(url);
          const body = JSON.stringify(data);
          bodies.set(key, { data, body, gzip: gzipSync(body).length,
            brotli: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }).length });
        }
        const { data, body, gzip, brotli } = bodies.get(key);
        requests.push({ url, bytes: Buffer.byteLength(body), wireRows: data.items.length,
          collectionRows: data.items.reduce((sum, item) => sum + (item.collections?.length ?? 1), 0), gzip, brotli });
        await route.fulfill({ contentType: "application/json", body });
      });
      if (baseline) await page.route(url => url.pathname.endsWith("/platform/content-index/channel-views.js"), async route => {
        const response = await route.fetch(), body = await response.text();
        const marker = 'const collectionPage = normalizedMode === "photo" && photoView === "collections" && !collection && !query;';
        assert.equal(body.split(marker).length, 2, "baseline changes only whether Android opts into the flat collection protocol");
        await route.fulfill({ response, body: body.replace(marker, "const collectionPage = false;") });
      });
      await page.addInitScript(() => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector(".photo-collection-card")) return;
          window.firstCollectionCardMs = performance.now();
          observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      });
      await page.goto(entry);
      const cards = page.locator(".photo-collection-card");
      await cards.first().waitFor();
      assert.deepEqual(errors, []);
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.equal(request.url.searchParams.get("collectionPage"), baseline ? null : "1");
      const locale = await page.evaluate(() => new Intl.Collator().resolvedOptions().locale);
      if (!baseline) assert.equal(request.url.searchParams.get("collectionLocale"), locale);
      const limit = Number(request.url.searchParams.get("limit"));
      assert.equal(await cards.count(), limit);
      const expectedUrl = new URL(request.url);
      expectedUrl.searchParams.set("collectionPage", "1");
      expectedUrl.searchParams.set("collectionLocale", locale);
      const expected = oracle.itemsPayload(expectedUrl).items;
      assert.deepEqual(await cards.locator("strong").allTextContents(), expected.map(item => item.title));
      // The first navigation prepares and compresses the service fixture's
      // response. Measured navigations use new, empty browser contexts.
      if (iteration > 0) samples.push({ bytes: request.bytes, gzip: request.gzip, brotli: request.brotli, wireRows: request.wireRows, collectionRows: request.collectionRows,
        rendered: limit, firstCardMs: await page.evaluate(() => firstCollectionCardMs) });
    } finally { await page.close(); }
  }
  const medianMs = samples.map(row => row.firstCardMs).toSorted((a, b) => a - b)[1];
  console.log(JSON.stringify({ baseline, count, samples, medianMs }));
  if (!baseline) await verifyPagingAndCompatibility(origin, entry);
} finally {
  await browser?.close(); service.kill("SIGTERM"); await Promise.race([exited, delay(3000)]);
}

async function verifyPagingAndCompatibility(origin, entry) {
  for (const scenario of ["append and revision", "response shape transition", "old server and offline cache", "flat offline append", "album and search routes"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const requests = [], details = [], errors = [];
    const initialSnapshot = snapshot;
    let protocol = scenario === "old server and offline cache" ? "reject" : "flat";
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
          errors.push(`${request.method()} ${url.origin}${url.pathname}`);
          return route.abort();
        }
        if (url.pathname.startsWith("/api/photo-sets/")) {
          details.push(url);
          const album = rows.find(item => item.id === decodeURIComponent(url.pathname.split("/").at(-1)));
          return route.fulfill({ json: { album: { ...album, imageCount: 0, images: [] } } });
        }
        if (url.pathname !== "/api/image-library/items" || url.searchParams.get("mode") !== "photo") return route.continue();
        requests.push(url);
        if (protocol === "offline") return route.abort();
        const dtoUrl = new URL(url);
        if (protocol === "ignore") {
          dtoUrl.searchParams.delete("collectionPage");
          dtoUrl.searchParams.delete("collectionLocale");
        }
        if (protocol === "reject" && dtoUrl.searchParams.has("collectionPage")) return route.fulfill({ status: 400, json: { error: "不支持合集分页参数" } });
        return route.fulfill({ json: oracle.itemsPayload(dtoUrl) });
      });
      await page.goto(entry);
      const cards = page.locator(".photo-collection-card");
      await cards.first().waitFor();
      const initial = requests[0], limit = Number(initial.searchParams.get("limit"));
      assert.equal(limit, 160, "exercise the complete actual loopback WebView prefix");
      const titles = () => cards.locator("strong").allTextContents();
      const offset = url => Number(url.searchParams.get("offset"));
      const opted = url => url.searchParams.get("collectionPage") === "1";
      const expected = visible => {
        const url = new URL(initial);
        url.searchParams.set("limit", String(visible));
        return oracle.itemsPayload(url).items.map(item => item.title);
      };
      const waitForCount = count => page.waitForFunction(count => document.querySelectorAll(".photo-collection-card").length === count, count);
      const cached = (url, flat) => page.waitForFunction(async ({ path, flat }) => {
        const { readCachedJson } = await import(new URL("./js/cache.js", location.href));
        const entry = await readCachedJson(location.origin, path);
        return Boolean(entry?.payload) && (entry.payload.collectionPage === true) === flat;
      }, { path: url.pathname + url.search, flat });
      const more = page.locator(".channel-more");
      assert.deepEqual(await titles(), expected(limit));
      if (scenario === "append and revision") {
        const firstCard = await cards.first().elementHandle();
        await more.click(); await waitForCount(limit * 2);
        assert.equal(await firstCard.evaluate(node => node.isConnected), true, "flat append keeps the mounted prefix");
        assert.deepEqual(await titles(), expected(limit * 2));
        assert.deepEqual(requests.map(offset), [0, limit]);
        await cached(requests[0], true); await cached(requests[1], true);
        const previous = snapshot;
        snapshot = { ...previous, scannedAt: "synthetic-rescan", photoSets: previous.photoSets.map((item, index) =>
          index < 2 ? { ...item, size: item.size + 1000000 } : item) };
        revision++;
        try {
          await more.click(); await waitForCount(limit * 3);
          assert.deepEqual(requests.map(offset), [0, limit, limit * 2, 0], "new revision rebuilds one coherent prefix");
          assert.deepEqual(await titles(), expected(limit * 3));
          assert.equal(await firstCard.evaluate(node => node.isConnected), false);
        } finally { snapshot = previous; revision++; }
      } else if (scenario === "response shape transition") {
        protocol = "ignore";
        await more.click(); await waitForCount(limit * 2);
        assert.deepEqual(requests.map(offset), [0, limit, 0], "same revision but grouped data cannot append to flat offsets");
        assert.deepEqual(await titles(), expected(limit * 2));
        protocol = "flat";
        await more.click(); await waitForCount(limit * 3);
        assert.deepEqual(requests.map(offset), [0, limit, 0, 0], "a flat response replaces the entire grouped prefix");
        assert.deepEqual(await titles(), expected(limit * 3));
      } else if (scenario === "old server and offline cache") {
        assert.deepEqual(requests.map(opted), [true, false], "an explicit legacy rejection retries once without the opt-in");
        await cached(requests[1], false);
        const { pathname, search } = initial;
        assert.equal(await page.evaluate(async path => {
          const { readCachedJson } = await import(new URL("./js/cache.js", location.href));
          return await readCachedJson(location.origin, path);
        }, pathname + search), null, "legacy response must not contaminate the flat key");
        protocol = "offline";
        await page.reload(); await waitForCount(limit);
        await page.locator("[data-channel-cache-notice]").waitFor();
        assert.deepEqual(await titles(), expected(limit));
        assert.deepEqual(requests.map(opted), [true, false, true], "offline network failure does not probe the legacy endpoint");
      } else if (scenario === "flat offline append") {
        await more.click(); await waitForCount(limit * 2);
        await cached(requests[0], true); await cached(requests[1], true);
        protocol = "offline";
        await page.reload(); await waitForCount(limit);
        await page.locator("[data-channel-cache-notice]").waitFor();
        await more.click(); await waitForCount(limit * 2);
        await page.getByRole("button", { name: "加载失败，点击重试", exact: true }).waitFor();
        assert.deepEqual(await titles(), expected(limit * 2));
        assert.deepEqual(requests.map(offset), [0, limit, 0, limit]);
        assert(requests.every(opted), "modern offline page cache retains the flat cursor namespace");
      } else {
        await page.locator(".photo-sort-action").click();
        await page.getByRole("dialog").getByRole("button", { name: "名称排序", exact: true }).click();
        await cards.first().waitFor();
        assert.equal(requests.at(-1).searchParams.get("sort"), "title");
        assert.deepEqual(await titles(), oracle.itemsPayload(requests.at(-1)).items.map(item => item.title));
        const selected = oracle.itemsPayload(requests.at(-1)).items[0];
        const selectedAlbums = rows.filter(item => item.collectionId === selected.collectionId);
        const totalIssues = limit + 4;
        snapshot = { ...snapshot, photoSets: [...rows, ...Array.from({ length: totalIssues - selectedAlbums.length }, (_, index) => {
          const number = index + selectedAlbums.length + 1;
          return { ...selectedAlbums[0], id: `extra-issue-${number}`, title: `VOL.${number} 期号样例`,
            updatedAt: "2025-01-01T00:00:00Z" };
        })] };
        revision++;
        await cards.first().click();
        const albumCards = page.locator(".photo-album-card");
        const firstAlbumTitle = albumCards.first().locator("strong");
        await albumCards.getByText(`VOL.${totalIssues} 期号样例`, { exact: true }).waitFor();
        assert.equal(await firstAlbumTitle.textContent(), `VOL.${totalIssues} 期号样例`);
        assert.equal(await albumCards.count(), limit);
        assert.equal(requests.at(-1).searchParams.get("collection"), selected.collectionId);
        assert.equal(requests.at(-1).searchParams.get("sort"), "issue");
        assert.equal(requests.at(-1).searchParams.get("direction"), null);
        assert.equal(opted(requests.at(-1)), false);
        const ascending = "期号正序（VOL / NO）";
        const descending = "期号倒序（VOL / NO）";
        const selectIssueOrder = async label => {
          await page.locator(".photo-sort-action").click();
          await page.getByRole("dialog").getByRole("button", { name: label, exact: true }).click();
        };
        await selectIssueOrder(ascending);
        await albumCards.getByText(selectedAlbums[0].title, { exact: true }).waitFor();
        assert.equal(await firstAlbumTitle.textContent(), selectedAlbums[0].title);
        assert.equal(requests.at(-1).searchParams.get("direction"), "asc");
        assert.equal(offset(requests.at(-1)), 0);
        await more.click();
        await page.waitForFunction(total => document.querySelectorAll(".photo-album-card").length === total, totalIssues);
        assert.equal(requests.at(-1).searchParams.get("direction"), "asc");
        assert.equal(offset(requests.at(-1)), limit);
        await albumCards.first().click(); await page.locator(".photo-detail-summary").waitFor();
        assert.equal(details.length, 1); assert(details[0].searchParams.has("imageLimit"));
        await page.locator("#viewBack").click(); await albumCards.first().waitFor();
        await page.getByRole("button", { name: `套图排序，当前${ascending}` }).waitFor();
        assert.equal(await firstAlbumTitle.textContent(), selectedAlbums[0].title);
        await selectIssueOrder(descending);
        await albumCards.getByText(`VOL.${totalIssues} 期号样例`, { exact: true }).waitFor();
        assert.equal(await firstAlbumTitle.textContent(), `VOL.${totalIssues} 期号样例`);
        assert.equal(requests.at(-1).searchParams.get("direction"), null);
        assert.equal(offset(requests.at(-1)), 0);
        await page.getByRole("button", { name: "返回分类", exact: true }).click(); await cards.first().waitFor();
        await page.locator(".photo-search-action").click();
        const input = page.locator("#searchInput");
        await input.fill("合成收藏 0001"); await input.press("Enter");
        await albumCards.first().waitFor();
        assert.equal(requests.at(-1).searchParams.get("q"), "合成收藏 0001");
        assert.equal(requests.at(-1).searchParams.get("sort"), "relevance");
        assert.equal(opted(requests.at(-1)), false);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${scenario}`);
    } finally {
      if (snapshot !== initialSnapshot) { snapshot = initialSnapshot; revision++; }
      await page.close();
    }
  }
}

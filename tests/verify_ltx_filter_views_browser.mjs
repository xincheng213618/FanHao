import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createCatalogRuntime } from "../src/modules/fanhao/server/catalog/runtime.js";
import { readJsonBody } from "../src/platform/server/request-io.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const root = fileURLToPath(new URL("../public", import.meta.url));
const locationPath = "/fanhao/ltx";
const actor = "样本甲";
const fullHd = { width: 1920, height: 1080 };
const fourK = { width: 3840, height: 2160 };
const localMedia = new Map([
  ["FIX-001", [fullHd, { width: 2160, height: 3840 }]],
  ["FIX-002", [fullHd]],
  ["FIX-003", [fourK]],
  ["FIX-004", [{ width: null, height: null }]],
  ["FIX-006", [fourK]]
]);
function item(index, size, overrides = {}) {
  const code = `FIX-${String(index).padStart(3, "0")}`;
  return {
    code, title: `Focus fixture ${index}`, actors: [actor], score: 8, addedAt: 0,
    links: [{ type: "magnet", url: `magnet:?xt=fixture${index}`, size, subtitledLtx: true }],
    local: { library: 1, downloads: 0, marked: 0 }, ...overrides
  };
}
const items = [
  item(1, 1024, { coverUrl: "/media/core-image/1?v=fixture", coverFallbacks: ["/media/image/fixture-cover"] }),
  item(2, 2048),
  item(3, 4096, { actors: ["样本乙"], local: { library: 0, downloads: 1, marked: 0 } }),
  item(4, 8192, { pending: true }),
  item(5, 16384, { local: { library: 0, downloads: 0, marked: 0 } }),
  item(6, 32768, { links: [{ type: "magnet", url: "magnet:?xt=fixture6", size: 32768 }],
    local: { library: 1, downloads: 0, marked: 1 } })
];
const requests = [];
let routeSnapshot;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  requests.push({ url, method: request.method });
  if (url.pathname === "/media/image/fixture-cover") {
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }
  if (routeSnapshot && (url.pathname === "/api/fanhao/ltx/sync"
    || (url.pathname === "/api/fanhao/ltx" && url.searchParams.get("fixture") === "runtime"))) {
    return routeSnapshot(request, response, url);
  }
  if (url.pathname.startsWith("/api/")) {
    const payload = url.pathname === "/api/fanhao/ltx"
      ? { items, libraryChecked: true, downloadsChecked: true, fetchedAt: "2026-11-13T00:00:00.000Z" }
      : url.pathname === "/api/fanhao/ltx/local-media" ? { copies: localMedia.get(url.searchParams.get("code")) || [] }
      : url.pathname === "/api/fanhao/search" ? { works: [], total: 0 } : null;
    response.writeHead(payload ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return response.end(JSON.stringify(payload || { error: "unexpected fixture endpoint" }));
  }
  const pathname = url.pathname === locationPath ? "/modules/fanhao/ltx/index.html" : url.pathname;
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(`${root}${path.sep}`) || !statSync(target, { throwIfNoEntry: false })?.isFile()) {
    return response.writeHead(404).end();
  }
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  response.writeHead(200, { "Content-Type": `${mime[path.extname(target)] || "application/octet-stream"}; charset=utf-8` });
  createReadStream(target).pipe(response);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
let temporary;
try {
  const executablePath = process.env.FANHAO_CHROME_PATH || [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"
  ].find(existsSync);
  assert.ok(executablePath, "Chrome or Chromium is required for the LTX filter views fixture");
  browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async () => { throw new Error("fixture clipboard unavailable"); } }
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const filters = { q: "Focus", actor, status: "confirmed", local: "present", subtitle: "ltx-c", sort: "size", order: "asc" };
  const initialUrl = `${origin}${locationPath}?${new URLSearchParams({ ...filters, fixture: "preserved" })}`;
  const codes = () => page.locator("#grid .code").allTextContents();
  const waitCount = (count) => page.waitForFunction((expected) => document.querySelectorAll("#grid .code").length === expected, count);
  const openViews = () => page.getByRole("button", { name: "筛选视图", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "筛选视图" });
  const filterName = "待检查的本地中字";
  await page.goto(initialUrl);
  await waitCount(2);
  assert.deepEqual(await codes(), ["FIX-001", "FIX-002"]);
  await page.waitForFunction(() => document.querySelector('#grid img[alt="FIX-001 封面"]')?.naturalWidth === 1);
  assert.equal(requests.some(({ url }) => url.pathname === "/media/core-image/1"), true);
  assert.equal(await page.locator("#search").inputValue(), "Focus");
  assert.equal(await page.locator("#actorChip").textContent(), `${actor} ×`);
  assert.equal(await page.locator("#filter").inputValue(), "present");
  assert.equal(await page.locator("#subtitleFilter").inputValue(), "ltx-c");
  assert.equal(await page.getByRole("button", { name: "文件大小" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#status button.confirmed").getAttribute("aria-pressed"), "true");

  await page.getByRole("button", { name: "文件大小" }).click();
  assert.deepEqual(await codes(), ["FIX-002", "FIX-001"]);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector("#grid .code")?.textContent === "FIX-001");
  await page.reload();
  await waitCount(2);
  assert.deepEqual(await codes(), ["FIX-001", "FIX-002"]);

  await openViews();
  await dialog.getByLabel("视图名称").fill(filterName);
  await dialog.getByRole("button", { name: "保存当前筛选" }).click();
  await dialog.getByText(`已保存「${filterName}」。`).waitFor();
  assert.equal(await dialog.getByRole("button", { name: filterName, exact: true }).getAttribute("aria-current"), "true");
  await dialog.getByRole("button", { name: "复制当前筛选链接" }).click();
  const linkInput = dialog.getByLabel("当前筛选链接");
  await linkInput.waitFor();
  const copiedLink = await linkInput.inputValue();
  assert.deepEqual(Object.fromEntries(new URL(copiedLink).searchParams), filters);
  assert.equal(await linkInput.evaluate((input) => input.selectionEnd - input.selectionStart), copiedLink.length);
  await dialog.getByRole("button", { name: "重置当前筛选" }).click();
  await waitCount(items.length);
  assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { fixture: "preserved" });
  await page.reload();
  await waitCount(items.length);
  await openViews();
  await dialog.getByRole("button", { name: filterName, exact: true }).click();
  await waitCount(2);
  assert.deepEqual(await codes(), ["FIX-001", "FIX-002"]);
  assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { fixture: "preserved", ...filters });
  const localSearch = page.waitForResponse((response) => response.url().includes("/api/fanhao/search") && response.ok());
  await page.locator("#filter").selectOption("ltx-local");
  await waitCount(0);
  await localSearch;
  await page.goBack();
  await waitCount(2);

  const independentContext = await browser.newContext();
  await independentContext.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  const independent = await independentContext.newPage();
  await independent.goto(copiedLink);
  await independent.waitForFunction(() => document.querySelectorAll("#grid .code").length === 2);
  assert.deepEqual(await independent.locator("#grid .code").allTextContents(), ["FIX-001", "FIX-002"]);
  await independentContext.close();

  await openViews();
  await dialog.getByRole("button", { name: `删除 ${filterName}` }).click();
  await dialog.getByText("此浏览器还没有保存筛选。").waitFor();
  await page.reload();
  await waitCount(2);
  await openViews();
  await dialog.getByText("此浏览器还没有保存筛选。").waitFor();
  await dialog.getByRole("button", { name: "关闭筛选视图" }).click();
  await page.locator("#actorChip").click();
  await waitCount(3);
  assert.equal(new URL(page.url()).searchParams.has("actor"), false);
  await page.locator("#status button.all").click();
  await waitCount(4);
  assert.equal(new URL(page.url()).searchParams.has("status"), false);
  await page.locator("#subtitleFilter").selectOption("all");
  await waitCount(5);
  assert.equal(new URL(page.url()).searchParams.has("subtitle"), false);
  await page.locator("#search").fill("no matches");
  await waitCount(0);
  assert.equal(new URL(page.url()).searchParams.get("q"), "no matches");
  await page.setViewportSize({ width: 390, height: 780 });
  await openViews();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(requests.some(({ method }) => method !== "GET"), false);
  assert.deepEqual(errors, []);
  await dialog.getByRole("button", { name: "关闭筛选视图" }).click();

  await page.locator("#search").fill("");
  const localFilter = page.locator("#filter");
  const waitForResolutions = () => page.waitForFunction(() => !document.querySelector("#results").textContent.includes("正在读取"));
  await localFilter.selectOption("unmarked-4k");
  await waitForResolutions();
  assert.deepEqual((await codes()).sort(), ["FIX-001", "FIX-003"]);
  assert.equal(new URL(page.url()).searchParams.get("local"), "unmarked-4k");
  const resolutionReads = requests.filter(({ url }) => url.pathname === "/api/fanhao/ltx/local-media");
  assert.deepEqual(resolutionReads.map(({ url }) => url.searchParams.get("code")).sort(), ["FIX-001", "FIX-002", "FIX-003", "FIX-004"]);
  await localFilter.selectOption("unmarked-non4k");
  assert.deepEqual((await codes()).sort(), ["FIX-002", "FIX-004"]);
  assert.equal(requests.filter(({ url }) => url.pathname === "/api/fanhao/ltx/local-media").length, resolutionReads.length);
  await page.goto(`${origin}${locationPath}?local=unmarked`);
  await waitCount(4);
  assert.deepEqual((await codes()).sort(), ["FIX-001", "FIX-002", "FIX-003", "FIX-004"]);
  assert.deepEqual(errors, []);

  const actorItems = Array.from({ length: 96 }, (_, index) => {
    const number = index + 1;
    return item(number, 1024, {
      actors: [`人物${String(number).padStart(3, "0")}`],
      addedAt: Date.UTC(2026, 10, 14) - number,
      coverUrl: `/media/image/fixture-${number}`,
      local: { library: 0, downloads: 0, marked: 0 }
    });
  });
  const actorPage = await context.newPage();
  const legacyCatalogReads = [];
  await actorPage.route((url) => url.origin === origin && url.pathname === "/api/fanhao/ltx", (route) => {
    legacyCatalogReads.push(new URL(route.request().url()).searchParams.get("preview"));
    return route.fulfill({
      json: { items: actorItems, libraryChecked: true, downloadsChecked: true, fetchedAt: "2026-11-14T00:00:00.000Z" }
    });
  });
  const coverRequests = new Set();
  await actorPage.route(`${origin}/media/image/fixture-*`, (route) => {
    coverRequests.add(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
  });
  await actorPage.goto(`${origin}${locationPath}?sort=recent`);
  await actorPage.getByText("96 人", { exact: true }).waitFor();
  assert.deepEqual(legacyCatalogReads, ["recent"]);
  const cards = actorPage.locator("#grid .card");
  const initialCardCount = await cards.count();
  assert.ok(initialCardCount > 1 && initialCardCount <= 20);
  await actorPage.waitForFunction(() => document.querySelector("#grid .card img")?.naturalWidth === 1);
  assert.ok(coverRequests.size > 0 && coverRequests.size < initialCardCount);
  const distantCover = `/media/image/fixture-${initialCardCount}`;
  assert.ok(!coverRequests.has(distantCover));
  const loadedDistantCover = actorPage.waitForResponse((response) => new URL(response.url()).pathname === distantCover && response.ok());
  await cards.nth(initialCardCount - 1).scrollIntoViewIfNeeded();
  await loadedDistantCover;
  if (await cards.count() === initialCardCount) await actorPage.locator("#sentinel").scrollIntoViewIfNeeded();
  await actorPage.waitForFunction((initialCount) => document.querySelectorAll("#grid .card").length > initialCount, initialCardCount);
  await actorPage.evaluate(() => window.scrollTo(0, 0));
  const actors = actorPage.locator("#actors .actor");
  const initialActorCount = await actors.count();
  assert.ok(initialActorCount > 1 && initialActorCount < actorItems.length + 1);
  const firstActor = await actors.nth(1).elementHandle();
  await actorPage.getByRole("button", { name: "最近收录", exact: true }).click();
  await actorPage.waitForFunction(() => document.querySelector("#grid .code")?.textContent === "FIX-096");
  assert.equal(await firstActor.evaluate((row) => row === document.querySelectorAll("#actors .actor")[1]), true);
  const actorList = actorPage.locator("#actors");
  const distantActor = actorList.getByRole("button", { name: /人物096/ });
  assert.equal(await distantActor.count(), 0);
  const actorSearch = actorPage.locator("#actorSearch");
  await actorSearch.fill("人物096");
  await distantActor.click();
  assert.equal(new URL(actorPage.url()).searchParams.get("actor"), "人物096");
  assert.deepEqual(await actorPage.locator("#grid .code").allTextContents(), ["FIX-096"]);
  await actorPage.locator("#actorChip").click();
  await actorSearch.fill("");
  await actorPage.getByText("96 人", { exact: true }).waitFor();
  await actorList.evaluate((list) => { list.scrollTop = list.scrollHeight; });
  await actorPage.waitForFunction((initialCount) => document.querySelectorAll("#actors .actor").length > initialCount, initialActorCount);
  await actorPage.close();

  const resolutionPage = await context.newPage();
  const nextResolutions = Promise.withResolvers();
  const firstResolution = Promise.withResolvers();
  try {
    const indices = [...Array.from({ length: 64 }, (_, index) => index + 2), 1];
    const resolutionItems = indices.map((number) => item(number, 1024, {
      addedAt: Date.UTC(2026, 10, 14) - number,
      local: { library: 1, downloads: 0, marked: 0, copies: [{ source: "library", size: 512 }] }
    }));
    await resolutionPage.route(`${origin}/api/fanhao/ltx`, (route) => route.fulfill({
      json: { items: resolutionItems, libraryChecked: true, downloadsChecked: true }
    }));
    await resolutionPage.route(`${origin}/api/fanhao/ltx/local-media?**`, async (route) => {
      const code = new URL(route.request().url()).searchParams.get("code");
      if (code === "FIX-001") await firstResolution.promise;
      if (Number(code.slice(4)) > 61) await nextResolutions.promise;
      return route.fulfill({ json: { copies: [{ source: "library", size: 512, ...fourK }] } });
    });
    const resolved = (count) => resolutionPage.locator("#results").getByText(`${count} 部 ·`, { exact: false }).waitFor();
    await resolutionPage.goto(`${origin}${locationPath}?sort=recent&local=unmarked-4k`);
    await resolved(60);
    const resolutionCards = resolutionPage.locator("#grid .card");
    await resolutionPage.locator("#loadMore").evaluate((button) => {
      button.click();
      button.click();
    });
    assert.equal(await resolutionCards.count(), 60);
    const retainedCode = await resolutionCards.first().locator(".code").elementHandle();
    await retainedCode.evaluate((button) => {
      button.focus({ preventScroll: true });
      window.fixtureCardChanges = [];
      const observer = new MutationObserver((changes) => {
        for (const change of changes) window.fixtureCardChanges.push([change.addedNodes.length, change.removedNodes.length]);
      });
      observer.observe(button.closest("#grid"), { childList: true });
    });
    nextResolutions.resolve();
    await resolved(64);
    assert.deepEqual(await resolutionPage.evaluate(() => window.fixtureCardChanges), []);
    assert.equal(await resolutionPage.locator("#loadMore").isVisible(), true);
    firstResolution.resolve();
    await resolved(65);
    assert.equal(await resolutionCards.count(), 60);
    assert.equal(await resolutionCards.first().locator(".code").textContent(), "FIX-001");
    assert.equal(await retainedCode.evaluate((button) => button.isConnected && button === document.activeElement), true);
    assert.deepEqual(await resolutionPage.evaluate(() => window.fixtureCardChanges.toSorted()),
      [[0, 1], [1, 0]]);
  } finally {
    nextResolutions.resolve();
    firstResolution.resolve();
    await resolutionPage.close();
  }

  const recentItems = Array.from({ length: 56 }, (_, index) => item(index + 1, 1024, {
    addedAt: Date.UTC(2026, 10, 14) - index,
    pending: index >= 53,
    local: { library: Number(index >= 50), downloads: 0, marked: Number(index >= 54) }
  }));
  const recentCatalog = {
    items: recentItems, avatars: {}, libraryChecked: true, downloadsChecked: true,
    fetchedAt: "2026-11-14T00:00:00.000Z"
  };
  const recentPreview = {
    ...recentCatalog, preview: "recent", items: recentItems.slice(0, 20),
    counts: { total: 56, local: 6, marked: 2, pending: 3 }, actors: [[actor, 56]]
  };
  for (const search of ["", "FIX-045"]) {
    const startupPage = await context.newPage();
    const releaseCatalog = Promise.withResolvers();
    const catalogReads = [];
    try {
      await startupPage.route((url) => url.origin === origin && url.pathname === "/api/fanhao/ltx", async (route) => {
        const preview = new URL(route.request().url()).searchParams.get("preview");
        catalogReads.push(preview);
        if (preview === "recent") return route.fulfill({ json: recentPreview });
        await releaseCatalog.promise;
        return route.fulfill({ json: recentCatalog });
      });
      await startupPage.goto(`${origin}${locationPath}?sort=recent`, { waitUntil: "domcontentloaded" });
      await startupPage.locator("#results").getByText("56 部 · 本地 6 · LTX 2", { exact: true }).waitFor();
      const startupCards = startupPage.locator("#grid .code");
      assert.equal(await startupCards.count(), 20);
      assert.equal(await startupCards.first().textContent(), "FIX-001");
      assert.equal(await startupPage.locator("#status .pending i").textContent(), "3");
      assert.equal(await startupPage.locator("#actors .actor").nth(1).locator("i").textContent(), "56");
      const firstCard = await startupCards.first().elementHandle();
      if (search) await startupPage.locator("#search").fill(search);
      releaseCatalog.resolve();
      if (search) {
        await startupPage.waitForFunction((code) => document.querySelector("#grid .code")?.textContent === code, search);
        assert.deepEqual(await startupCards.allTextContents(), [search]);
        assert.equal(new URL(startupPage.url()).searchParams.get("q"), search);
      } else {
        await startupPage.locator("#sentinel").scrollIntoViewIfNeeded();
        await startupPage.waitForFunction(() => document.querySelectorAll("#grid .card").length > 20);
        assert.equal(await firstCard.evaluate((button) => button === document.querySelector("#grid .code")), true);
      }
      assert.deepEqual(catalogReads, ["recent", null]);
    } finally {
      releaseCatalog.resolve();
      await startupPage.close();
    }
  }

  temporary = createVerifiedTempDir("fanhao-ltx-sync-");
  const snapshotPath = path.join(temporary.tempDir, "ltx-catalog.json");
  const original = JSON.stringify({ schema_version: 1, items: [] });
  await fs.writeFile(snapshotPath, original);
  const publicLink = "magnet:?xt=fixture";
  const pendingLink = "magnet:?xt=pending";
  const catalog = { items: [{ code: "FIX-007", links: [publicLink, pendingLink], pending_links: [pendingLink] }] };
  const runtime = createCatalogRuntime({
    readJsonBody,
    sendJson(response, status, value) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    },
    ltx: { snapshotPath, requireLocalAdmin: () => true, getDb: () => null, incomingRoots: [], libraryRoots: [], coverUrl: () => "",
      requestAccess: (request) => ({ mode: request.headers["x-fixture-remote"] ? "lan" : "local" }) }
  });
  routeSnapshot = runtime.routeApi;
  const syncUrl = `${origin}/api/fanhao/ltx/sync`;
  const previewUrl = `${origin}/api/fanhao/ltx?fixture=runtime&preview=recent`;
  const postSync = (body, headers = {}) => fetch(syncUrl, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body
  });
  assert.equal((await postSync(JSON.stringify(catalog), { "x-fixture-remote": "1" })).status, 403);
  await page.getByRole("button", { name: "更新目录" }).click();
  const importer = page.getByRole("dialog", { name: "更新目录" });
  await importer.getByRole("button", { name: "打开并同步" }).waitFor();
  const scriptHref = await importer.getByRole("link", { name: "安装或更新同步脚本" }).getAttribute("href");
  assert.equal(scriptHref, "/modules/fanhao/ltx/fanhao-ltx-sync-v2.user.js?v=2.0.0");
  const clipboardImport = importer.getByRole("button", { name: "从剪贴板导入目录" });
  await page.evaluate(() => { navigator.clipboard.readText = async () => '{"body":"fixture"}'; });
  const requestCount = requests.filter(({ method, url }) => method === "POST" && url.pathname === "/api/fanhao/ltx/sync").length;
  await clipboardImport.click();
  await importer.getByRole("status").getByText(/没有可导入的目录 JSON/).waitFor();
  assert.equal(requests.filter(({ method, url }) => method === "POST" && url.pathname === "/api/fanhao/ltx/sync").length, requestCount);
  await page.evaluate(() => { navigator.clipboard.readText = async () => { throw new Error("Permission denied"); }; });
  await clipboardImport.click();
  await importer.getByRole("status").getByText(/未允许读取剪贴板/).waitFor();
  assert.equal(await fs.readFile(snapshotPath, "utf8"), original);
  await importer.getByLabel("目录 JSON").fill("invalid JSON");
  await importer.getByRole("button", { name: "导入目录", exact: true }).click();
  await importer.getByRole("status").getByText("JSON 格式无效").waitFor();
  assert.equal(await fs.readFile(snapshotPath, "utf8"), original);
  await page.evaluate((json) => { navigator.clipboard.readText = async () => json; }, JSON.stringify({ data: catalog }));
  await clipboardImport.click();
  await importer.waitFor({ state: "hidden" });
  await page.locator("#feedback").getByText(/目录已更新/).waitFor();
  const saved = await fs.readFile(snapshotPath, "utf8");
  assert.deepEqual(JSON.parse(saved).items, [{ code: "FIX-007", links: [publicLink] }]);
  const previewResponse = await fetch(previewUrl);
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get("cache-control"), "no-store");
  const runtimePreview = await previewResponse.json();
  assert.equal(runtimePreview.preview, "recent");
  assert.deepEqual(runtimePreview.counts, { total: 1, local: 0, marked: 0, pending: 0 });
  assert.deepEqual(runtimePreview.items.map(({ code }) => code), ["FIX-007"]);

  const local = "http://127.0.0.1:29998";
  const official = "https://ltxlib.dpdns.org";
  assert.equal(JSON.parse(saved).source, `${official}/api/items`);
  const popupCatalog = { items: [{ code: "FIX-008", links: [publicLink] }] };
  const scriptResponse = await fetch(new URL(scriptHref, origin));
  assert.equal(scriptResponse.status, 200);
  const userscript = await scriptResponse.text();
  assert.ok(userscript.includes(`// @match        ${official}/*`));
  const { publicKey } = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverKey = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  const session = { v: 1, sid: "fixture", publicKey: serverKey, salt: "Zml4dHVyZQ" };
  let popupVerified = false;
  const popupContext = await browser.newContext();
  await popupContext.addInitScript({ content: `if (location.origin === ${JSON.stringify(official)}) {
    const unsafeWindow = window;
    ${userscript}
  }` });
  await popupContext.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === local) {
      return route.fulfill({ response: await route.fetch({ url: origin + url.pathname + url.search }) });
    }
    if (url.origin !== official) return route.abort();
    if (url.pathname === "/api/crypto/session") {
      return popupVerified ? route.fulfill({ json: session }) : route.fulfill({ status: 403 });
    }
    if (url.pathname === "/api/items") return route.fulfill({ json: { ...popupCatalog, snapshot: "fixture" } });
    if (url.pathname === "/api/items/query") return route.fulfill({ json: { items: [], hasMore: false } });
    if (url.pathname === "/api/verify") {
      popupVerified = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<button>完成验证</button><script>
      document.querySelector("button").onclick = () => fetch("/api/verify", { method: "POST" });
    </script>` });
  });
  const popupHost = await popupContext.newPage();
  await popupHost.clock.install();
  await popupHost.goto(local + locationPath);
  await popupHost.getByRole("button", { name: "更新目录" }).click();
  const [officialWindow] = await Promise.all([
    popupHost.waitForEvent("popup"),
    popupHost.getByRole("button", { name: "打开并同步" }).click()
  ]);
  await popupHost.locator("#catalogImportStatus").getByText(/已连接官网小窗/).waitFor();
  await popupHost.clock.fastForward(16_000);
  await popupHost.locator("#catalogImportStatus").getByText(/尚未收到完整目录/).waitFor();
  assert.equal(await fs.readFile(snapshotPath, "utf8"), saved);
  await Promise.all([
    officialWindow.waitForEvent("close"),
    officialWindow.getByRole("button", { name: "完成验证" }).click()
  ]);
  await popupHost.locator("#feedback").getByText(/目录已更新/).waitFor();
  await popupContext.unrouteAll({ behavior: "wait" });
  await popupContext.close();
  const afterPopup = await fs.readFile(snapshotPath, "utf8");
  assert.deepEqual(JSON.parse(afterPopup).items.map(({ code, links }) => ({ code, links })), popupCatalog.items);
  assert.deepEqual((await (await fetch(previewUrl)).json()).items.map(({ code }) => code), ["FIX-008"]);

  assert.equal((await postSync(JSON.stringify({ items: [] }))).status, 422);
  assert.equal(await fs.readFile(snapshotPath, "utf8"), afterPopup);
  assert.equal((await postSync(JSON.stringify(catalog))).status, 200);
  const latest = await fs.readFile(snapshotPath, "utf8");
  runtime.beginStop();
  assert.match((await (await postSync(JSON.stringify(catalog))).json()).error, /正在停止/);
  await runtime.stop();
  assert.equal(await fs.readFile(snapshotPath, "utf8"), latest);
  console.log("LTX filter views browser verification passed.");
} finally {
  await browser?.close();
  await temporary?.cleanup();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

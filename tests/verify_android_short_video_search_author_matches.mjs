import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual Android entry and cover loader, with a private API and no real media.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(project, "android-client/www");
const controllerPath = "/modules/short-videos/list/controller.js";
const previousController = execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:android-client/www${controllerPath}`], { cwd: project });
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const errors = [];
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    const filename = path.resolve(www, `.${pathname}`);
    assert(filename.startsWith(`${www}${path.sep}`));
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(filename)];
    response.writeHead(200, { "Content-Type": type || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(pathname === controllerPath && url.searchParams.get("v") === "fixture-previous" ? previousController : fs.readFileSync(filename));
  } catch (error) {
    errors.push(error.message);
    response.destroy();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const videoCount = 12;
const videos = Array.from({ length: videoCount }, (_, index) => ({ id: `video-${index}`, title: `视频 ${index}`, coverUrl: `/fixture-cover/${index}.svg`, streamUrl: `/fixture-video/${index}.mp4` }));
const authors = [{ secUid: "fixture-author", name: "相关用户 甲", count: 5 }];

async function open(previous = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.addInitScript(() => {
    localStorage.setItem("fanhao.serverUrl", location.origin);
    window.__coverFetches = 0;
    const fetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (String(url).includes("/fixture-cover/")) __coverFetches++;
      return fetch(url, options);
    };
  });
  const hints = Promise.withResolvers();
  const covers = Promise.withResolvers();
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => url.origin !== base, route => route.abort());
  if (previous) await page.route(`**${controllerPath}?*`, route => route.continue({ url: `${base}${controllerPath}?v=fixture-previous` }));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/short-videos/authors") {
      await hints.promise;
      await route.fulfill({ json: { authors, total: authors.length } });
    } else if (url.pathname === "/api/short-videos") {
      await route.fulfill({ json: { videos, source: "all", total: videoCount + 1, hasMore: true } });
    } else if (url.pathname === "/api/modules") await route.fulfill({ json: { modules: [] } });
    else if (url.pathname === "/api/library") await route.fulfill({ json: { people: [], works: [], totals: {}, user: {}, availableRoots: [], access: { mode: "loopback" } } });
    else await route.fulfill({ json: {} });
  });
  await page.route("**/fixture-cover/**", async route => {
    await covers.promise;
    await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>' });
  });
  await Promise.all([
    page.waitForRequest(request => new URL(request.url()).pathname === "/api/short-videos/authors"),
    page.goto(`${base}/#shortVideoSearch?source=all&query=fixture`)
  ]);
  await page.waitForFunction(count => __coverFetches === count, videoCount);
  assert.equal(await page.locator(".short-video-search-authors").count(), 0);
  return { page, hints, covers, async close() {
    hints.resolve(); covers.resolve(); await context.close();
  } };
}

async function lateMatches(previous) {
  const fixture = await open(previous);
  const { page, hints, covers } = fixture;
  try {
    await page.evaluate(() => {
      const input = document.querySelector(".short-video-search-page-field input");
      input.focus({ preventScroll: true });
      input.value = "unsent draft";
      window.__mounted = { input, cards: [...document.querySelectorAll(".short-video-mobile-card-wrap")], sentinel: document.querySelector(".short-video-mobile-load-more") };
    });
    hints.resolve();
    await page.locator(".short-video-search-author-item").getByText("相关用户 甲").waitFor();
    await page.waitForFunction(count => __coverFetches === count, previous ? videoCount * 2 : videoCount);
    assert.equal(await page.evaluate(() => document.querySelector(".short-video-search-result-meta").nextElementSibling.className), "short-video-search-authors");
    covers.resolve();
    await page.waitForFunction(count => document.querySelectorAll(".short-video-mobile-thumb img").length === count, videoCount);
    return await page.evaluate(() => ({
      reusedCards: [...document.querySelectorAll(".short-video-mobile-card-wrap")].filter((card, index) => card === __mounted.cards[index]).length,
      reusedSentinel: document.querySelector(".short-video-mobile-load-more") === __mounted.sentinel,
      retainedDraft: document.activeElement === __mounted.input && __mounted.input.value === "unsent draft",
      coverFetches: __coverFetches
    }));
  } finally { await fixture.close(); }
}

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const before = await lateMatches(true);
  const after = await lateMatches(false);
  assert.deepEqual(before, { reusedCards: 0, reusedSentinel: false, retainedDraft: false, coverFetches: 24 });
  assert.deepEqual(after, { reusedCards: 12, reusedSentinel: true, retainedDraft: true, coverFetches: 12 });
  const fixture = await open();
  try {
    await fixture.page.getByRole("tab", { name: "视频", exact: true }).click();
    await fixture.page.locator('[role="tab"][aria-selected="true"]').getByText("视频", { exact: true }).waitFor();
    fixture.hints.resolve();
    fixture.covers.resolve();
    await fixture.page.waitForLoadState("networkidle");
    assert.equal(await fixture.page.locator(".short-video-search-authors").count(), 0, "retired hints cannot appear under the videos tab");
  } finally { await fixture.close(); }
  assert.deepEqual(errors, []);
  console.log(`Android short-video related authors: covers ${before.coverFetches}→${after.coverFetches}; video cards retained ${before.reusedCards}→${after.reusedCards}; input, load-more sentinel and tab ownership verified in Chromium.`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

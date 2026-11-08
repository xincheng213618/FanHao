import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual Android shell and routes on a private server, with synthetic pages.
const www = fileURLToPath(new URL("../android-client/www/", import.meta.url));
const controllerPath = "/modules/short-videos/list/controller.js";
const previousScrollGuard = 'if (!document.body.classList.contains("short-video-mobile-view")) return;';
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const errors = [];
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    const filename = path.resolve(www, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert(filename.startsWith(www));
    let source = fs.readFileSync(filename);
    if (url.pathname === controllerPath && url.searchParams.get("v") === "fixture-root-only") {
      const current = source.toString().replaceAll("\r\n", "\n");
      const guard = 'if (!document.body.classList.contains("short-video-mobile-view") && !isSearchResults) return;';
      assert(current.includes(guard) || current.includes(previousScrollGuard));
      source = current.replace(guard, previousScrollGuard);
    }
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(filename)];
    response.writeHead(200, { "Content-Type": type || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(source);
  } catch (error) { errors.push(error.message); response.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const videos = Array.from({ length: 31 }, (_, index) => ({ id: `video-${index}`, title: `影片 ${index}`, streamUrl: `/fixture-video/${index}.mp4` }));
const authors = Array.from({ length: 43 }, (_, index) => ({ secUid: `author-${index}`, name: `fixture ${index}`, count: 43 - index }));
const videoCards = ".short-video-mobile-card-wrap";
const authorCards = ".short-video-mobile-author-card:not(.is-loading)";
const moreButton = ".short-video-mobile-load-more";

async function open({ tab = "all", height = 600, rootOnly = false, holdAppend = false, failAppend = false, searchPage } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height }, isMobile: true });
  await context.addInitScript(() => {
    localStorage.setItem("fanhao.serverUrl", location.origin);
    window.__native = [];
    window.Capacitor = { Plugins: { FanHaoPlayer: { async playShortFeed(payload) {
      __native.push(payload);
      return { opened: true, canceled: true };
    } } } };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => url.origin !== base, route => route.abort());
  if (rootOnly) await page.route(`**${controllerPath}?*`, route => route.continue({ url: `${base}${controllerPath}?v=fixture-root-only` }));
  const requests = [];
  const release = Promise.withResolvers();
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const query = url.searchParams;
    if (url.pathname === "/api/short-videos" || url.pathname === "/api/short-videos/authors") {
      const kind = url.pathname.endsWith("/authors") ? "authors" : "videos";
      const offset = Number(query.get("offset") || 0), limit = Number(query.get("limit") || 0);
      requests.push({ kind, query: query.get("q"), offset, limit });
      if (holdAppend && kind === "videos" && offset) await release.promise;
      if (failAppend && kind === "videos" && offset) {
        failAppend = false;
        return route.fulfill({ status: 503, json: { error: "续页测试失败" } });
      }
      const records = kind === "authors" ? authors : videos;
      const envelope = searchPage?.(kind, offset, limit) || { [kind]: records.slice(offset, offset + limit), total: records.length, hasMore: offset + limit < records.length };
      return route.fulfill({ json: { source: "all", offset, ...envelope } });
    }
    if (url.pathname === "/api/modules") return route.fulfill({ json: { modules: [] } });
    if (url.pathname === "/api/library") return route.fulfill({ json: { people: [], works: [], totals: {}, user: {}, availableRoots: [], access: { mode: "loopback" } } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/#shortVideoSearch?source=${tab === "authors" ? "authors" : "all"}&query=fixture&tab=${tab}`);
  await rows(page, tab === "authors" ? authorCards : videoCards, tab === "authors" ? 24 : 12);
  await page.waitForLoadState("networkidle");
  return { page, requests, release, async close() { release.resolve(); await context.close(); } };
}

const rows = (page, selector, count) => page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length >= count, { selector, count });
const offsets = (fixture, kind) => fixture.requests.filter(item => item.kind === kind && item.limit !== 6).map(item => item.offset);
const scrollEnd = page => page.evaluate(async () => {
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const before = await open({ rootOnly: true });
  try {
    await scrollEnd(before.page);
    assert(await before.page.evaluate(() => window.scrollY > 0), "the old route had real scroll range");
    await before.page.waitForLoadState("networkidle");
    assert.deepEqual(offsets(before, "videos"), [0]);
    assert.equal(await before.page.locator(videoCards).count(), 12);
    console.log("Former root-only scroll: 12/31 videos, 1 list request after scrolling to the bottom.");
  } finally { await before.close(); }

  if (!process.argv.includes("--baseline-only")) {
    const after = await open();
    try {
      const { page } = after;
      await page.evaluate(selector => { window.__firstCards = [...document.querySelectorAll(selector)]; }, videoCards);
      await page.locator(`${videoCards}[data-video-id="video-0"] button`).click();
      await page.waitForFunction(() => __native.length === 1);
      const firstLaunch = await page.evaluate(() => __native[0]);
      assert.equal(firstLaunch.nextOffset, 12);
      assert.equal(firstLaunch.hasMore, true);
      await scrollEnd(page); await rows(page, videoCards, 24);
      await scrollEnd(page); await rows(page, videoCards, 31);
      assert.equal(await page.evaluate(() => __firstCards.every(node => node.isConnected)), true);
      assert.deepEqual(await page.locator(videoCards).evaluateAll(cards => cards.map(card => card.dataset.videoId)), videos.map(video => video.id));
      assert.equal(await page.locator(moreButton).count(), 0);
      await scrollEnd(page);
      assert.deepEqual(offsets(after, "videos"), [0, 12, 24]);
      assert(after.requests.every(request => request.query === "fixture"));
      await page.locator(`${videoCards}[data-video-id="video-30"] button`).click();
      await page.waitForFunction(() => __native.length === 2);
      const launch = await page.evaluate(() => __native[1]);
      assert.equal(launch.startId, "video-30");
      assert.equal(launch.nextOffset, 31);
      assert.equal(launch.hasMore, false);
      assert.equal(new URL(launch.feedUrl).searchParams.get("q"), "fixture");
      console.log("Current all tab: 31/31 videos, 3 list requests at offsets 0/12/24, native handoff at EOF.");
    } finally { await after.close(); }

    const manual = await open({ tab: "videos", height: 2400, failAppend: true });
    try {
      const { page } = manual;
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), true);
      const more = page.getByRole("button", { name: "加载更多", exact: true });
      await more.focus(); await page.keyboard.press("Enter");
      const retry = page.getByRole("button", { name: /续页测试失败.*重试/ });
      await retry.waitFor();
      await page.waitForLoadState("networkidle");
      assert.deepEqual(offsets(manual, "videos"), [0, 12]);
      assert.equal(await retry.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press("Enter"); await rows(page, videoCards, 24);
      assert.equal(await more.evaluate(node => node === document.activeElement), true);
      assert.deepEqual(offsets(manual, "videos"), [0, 12, 12]);
      assert.equal(await page.locator(".short-video-search-authors").count(), 0);
      await page.keyboard.press("Enter"); await rows(page, videoCards, 31);
      assert.equal(await page.evaluate(() => document.activeElement.closest("[data-video-id]")?.dataset.videoId), "video-30");
      assert.deepEqual(offsets(manual, "videos"), [0, 12, 12, 24]);
      console.log("Videos tab: keyboard retry repeats offset 12 once, then loads offset 24 and moves focus to the final card.");
    } finally { await manual.close(); }

    const retired = await open({ tab: "videos", holdAppend: true });
    try {
      const { page } = retired;
      const oldButton = await page.locator(moreButton).elementHandle();
      await Promise.all([
        page.waitForRequest(request => new URL(request.url()).searchParams.get("offset") === "12"),
        oldButton.evaluate(node => { node.click(); node.click(); })
      ]);
      await page.getByRole("tab", { name: "用户", exact: true }).click();
      await rows(page, authorCards, 24);
      retired.release.resolve();
      await oldButton.evaluate(node => node.click());
      await page.waitForLoadState("networkidle");
      assert.equal(await page.locator(videoCards).count(), 0);
      assert.deepEqual(offsets(retired, "videos"), [0, 12]);
      await scrollEnd(page); await rows(page, authorCards, 42);
      await page.getByRole("button", { name: "继续加载更多作者", exact: true }).click();
      await rows(page, authorCards, 43);
      assert.deepEqual(offsets(retired, "authors"), [0, 24, 42]);
      assert.equal(await page.locator(".short-video-mobile-author-index-more").count(), 0);
      assert(retired.requests.every(request => request.query === "fixture"));
      console.log("Users tab: 43/43 results via scroll and More, stale video response and retired control ignored.");
    } finally { await retired.close(); }

    const moreVideos = [...videos, ...Array.from({ length: 12 }, (_, index) => ({ id: `extra-${index}`, streamUrl: `/fixture-video/extra-${index}.mp4` }))];
    const rawVideos = [...moreVideos.slice(0, 12), ...moreVideos.slice(0, 12), ...moreVideos.slice(11)];
    let emptyResponse = true;
    const overlap = await open({ tab: "videos", searchPage: (kind, offset, limit) => {
      if (kind !== "videos") return null;
      const hasMore = offset + limit < rawVideos.length;
      if (offset === 24 && emptyResponse) {
        emptyResponse = false;
        return { videos: [], total: rawVideos.length, hasMore: true };
      }
      return { videos: rawVideos.slice(offset, offset + limit), total: rawVideos.length, hasMore };
    } });
    try {
      const { page } = overlap;
      const more = page.getByRole("button", { name: "加载更多", exact: true });
      const requestAt = offset => page.waitForRequest(request => new URL(request.url()).searchParams.get("offset") === String(offset));
      await Promise.all([requestAt(12), scrollEnd(page)]);
      await more.waitFor();
      await page.waitForLoadState("networkidle");
      assert.equal(await page.locator(videoCards).count(), 12);
      await page.evaluate(() => window.scrollTo(0, 0));
      await scrollEnd(page);
      assert.deepEqual(offsets(overlap, "videos"), [0, 12], "duplicate-only page must stop automatic continuation");
      await page.locator(`${videoCards}[data-video-id="video-11"] button`).click();
      await page.waitForFunction(() => __native.length === 1);
      assert.equal(await page.evaluate(() => __native[0].nextOffset), 24);
      await Promise.all([requestAt(24), more.click()]);
      const retry = page.getByRole("button", { name: /搜索续页没有返回结果.*重试/ });
      await retry.waitFor();
      await page.waitForLoadState("networkidle");
      assert.deepEqual(offsets(overlap, "videos"), [0, 12, 24], "empty hasMore page must pause without skipping its offset");
      await Promise.all([requestAt(24), retry.click()]);
      await rows(page, videoCards, 23);
      await scrollEnd(page); await rows(page, videoCards, 35);
      await page.locator(`${videoCards}[data-video-id="video-0"] button`).click();
      await page.waitForFunction(() => __native.length === 2);
      assert.equal(await page.evaluate(() => __native[1].nextOffset), 44, "bounded native windows use raw position for their last supplied item");
      await scrollEnd(page); await rows(page, videoCards, moreVideos.length);
      assert.deepEqual(offsets(overlap, "videos"), [0, 12, 24, 24, 36, 48]);
      assert.deepEqual(await page.locator(videoCards).evaluateAll(cards => cards.map(card => card.dataset.videoId)), moreVideos.map(video => video.id));
      await page.locator(`${videoCards}[data-video-id="extra-11"] button`).click();
      await page.waitForFunction(() => __native.length === 3);
      const launch = await page.evaluate(() => __native[2]);
      assert.equal(launch.nextOffset, rawVideos.length);
      assert.equal(launch.hasMore, false);
      console.log("Duplicate/empty video pages: raw offsets 0/12/24/retry 24/36/48, 43 distinct videos and correct native boundaries.");
    } finally { await overlap.close(); }

    const rawAuthors = [...authors.slice(0, 24), ...authors.slice(0, 18), ...authors.slice(24)];
    let emptyAuthorResponse = true;
    const duplicateAuthors = await open({ tab: "authors", searchPage: (kind, offset, limit) => {
      if (kind !== "authors") return null;
      if (offset === 42 && emptyAuthorResponse) {
        emptyAuthorResponse = false;
        return { authors: [], total: rawAuthors.length, hasMore: true };
      }
      return { authors: rawAuthors.slice(offset, offset + limit), total: rawAuthors.length, hasMore: offset + limit < rawAuthors.length };
    } });
    try {
      const { page } = duplicateAuthors;
      const more = page.getByRole("button", { name: "继续加载更多作者", exact: true });
      await Promise.all([page.waitForRequest(request => new URL(request.url()).searchParams.get("offset") === "24"), scrollEnd(page)]);
      await more.waitFor();
      await page.waitForLoadState("networkidle");
      assert.equal(await page.locator(authorCards).count(), 24);
      await more.click();
      const retry = page.getByRole("button", { name: /搜索续页没有返回结果.*重试/ });
      await retry.waitFor();
      assert.deepEqual(offsets(duplicateAuthors, "authors"), [0, 24, 42]);
      await retry.click(); await rows(page, authorCards, 42);
      await more.click(); await rows(page, authorCards, 43);
      assert.deepEqual(offsets(duplicateAuthors, "authors"), [0, 24, 42, 42, 60]);
      assert.equal(await more.count(), 0);
      console.log("Duplicate/empty author pages: raw offsets 0/24/42/retry 42/60, 43 distinct users.");
    } finally { await duplicateAuthors.close(); }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

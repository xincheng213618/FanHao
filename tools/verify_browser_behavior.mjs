import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.FANHAO_BROWSER_TEST_PORT || 0);
const suppliedBaseUrl = String(process.env.FANHAO_BROWSER_TEST_BASE_URL || "").trim();
const ownedServer = suppliedBaseUrl ? null : await startFixtureServer(port);
const fixturePort = Number(ownedServer?.address()?.port || 0);
const baseUrl = suppliedBaseUrl || `http://127.0.0.1:${fixturePort}`;
let delayedAuthorDetail = null;

try {
  await waitForHealth(baseUrl);
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    await verifyStandaloneStyles(browser);
    await verifyMobileGallery(browser);
    await verifyAuthorIndexReturn(browser);
    await verifyAuthorReturnDiscardsDelayedDetail(browser);
    await verifyDirectAuthorDeepLink(browser);
  } finally {
    await browser.close();
  }
  console.log("Executable browser behavior checks passed.");
} finally {
  if (ownedServer) await stopServer(ownedServer);
}

async function startFixtureServer(serverPort) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, await fixtureApi(url));
      return;
    }
    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = path.resolve(root, "public", relative);
    const publicRoot = path.resolve(root, "public");
    const safeFile = filePath.startsWith(`${publicRoot}${path.sep}`) || filePath === publicRoot ? filePath : "";
    const fallback = path.join(publicRoot, "index.html");
    const target = safeFile && fs.statSync(safeFile, { throwIfNoEntry: false })?.isFile() ? safeFile : fallback;
    response.writeHead(200, { "content-type": contentType(target), "cache-control": "no-store" });
    fs.createReadStream(target).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(serverPort, "127.0.0.1", resolve);
  });
  return server;
}

async function stopServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitForHealth(base) {
  let lastError = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`isolated browser-test server did not become healthy: ${lastError?.message || "unknown error"}`);
}

async function verifyStandaloneStyles(browser) {
  const cases = [
    {
      path: "/gallery",
      required: ["/css/foundation.css", "/css/shell.css", "/modules/content-index/styles.css", "/modules/photos/styles.css"],
      forbidden: ["/styles.css", "/modules/novels/", "/modules/fanhao/", "/modules/tools/", "/modules/short-videos/", "/modules/music/"],
      selector: ".gallery-shell"
    },
    {
      path: "/novels",
      required: ["/css/foundation.css", "/css/shell.css", "/modules/novels/styles.css"],
      forbidden: ["/styles.css", "/modules/content-index/", "/modules/fanhao/", "/modules/tools/", "/modules/short-videos/", "/modules/music/"],
      selector: ".novel-home"
    },
    {
      path: "/music",
      required: ["/css/foundation.css", "/css/shell.css", "/modules/music/styles/foundation.css", "/modules/music/styles/library.css", "/modules/music/styles/player.css", "/modules/music/styles/responsive.css"],
      forbidden: ["/styles.css", "/modules/content-index/", "/modules/fanhao/", "/modules/tools/", "/modules/short-videos/", "/modules/novels/"],
      selector: ".music-layout"
    },
    {
      path: "/tools",
      required: ["/css/foundation.css", "/css/shell.css", "/modules/tools/styles.css"],
      forbidden: ["/styles.css", "/modules/content-index/", "/modules/fanhao/", "/modules/short-videos/", "/modules/music/", "/modules/novels/"],
      selector: ".game-library"
    }
  ];

  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}${item.path}`, { waitUntil: "domcontentloaded" });
      await page.locator(item.selector).waitFor({ state: "visible", timeout: 30000 });
      const styles = await page.evaluate(() => performance.getEntriesByType("resource")
        .map((entry) => new URL(entry.name).pathname)
        .filter((pathname) => pathname.endsWith(".css")));
      for (const required of item.required) assert(styles.includes(required), `${item.path} must request ${required}`);
      for (const forbidden of item.forbidden) assert(!styles.includes(forbidden), `${item.path} must not request ${forbidden}`);
    } finally {
      await page.close();
    }
  }
}

async function verifyMobileGallery(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${baseUrl}/gallery`, { waitUntil: "domcontentloaded" });
    await page.locator(".gallery-shell").waitFor({ state: "visible", timeout: 30000 });
    const layout = await page.evaluate(() => ({
      shellWidth: document.querySelector(".gallery-shell")?.getBoundingClientRect().width || 0,
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    assert(layout.shellWidth > 0, "390px gallery must render its real shell");
    assert(layout.shellWidth <= layout.viewportWidth, "390px gallery shell must fit the viewport");
    assert(layout.scrollWidth <= layout.viewportWidth, "390px gallery must not introduce horizontal overflow");
  } finally {
    await page.close();
  }
}

async function verifyAuthorIndexReturn(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  const apiRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/")) apiRequests.push(request.url());
  });
  try {
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.__browserTestFetches = [];
      window.fetch = (...args) => {
        window.__browserTestFetches.push(String(args[0] || ""));
        return originalFetch(...args);
      };
    });
    await page.goto(`${baseUrl}/short-videos?perf=1`, { waitUntil: "domcontentloaded" });
    await page.locator(".short-video-home").waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(1200);
    const authorTab = page.locator('.short-video-source-tab[data-source="authors"]');
    const tabStateBefore = await authorTab.getAttribute("aria-pressed");
    await authorTab.click({ force: true });
    await waitFor(() => authorTab.getAttribute("aria-pressed"), (value) => value === "true", 5000).catch(async (error) => {
      const body = await page.locator("body").innerText().catch(() => "");
      throw new Error(`author source tab did not activate (before=${tabStateBefore}): ${body.slice(0, 500)}`, { cause: error });
    });
    try {
      await page.locator("article button").first().waitFor({ state: "visible", timeout: 30000 });
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "");
      const fetches = await page.evaluate(() => window.__browserTestFetches || []);
      const trace = await page.locator("html").getAttribute("data-short-video-perf-trace").catch(() => "");
      throw new Error(`author fixture did not render index cards: ${body.slice(0, 500)} ${apiRequests.join(" | ")} ${fetches.join(" | ")} ${trace || ""} ${consoleErrors.join(" | ")}`, { cause: error });
    }
    await loadMoreAuthorPages(page, 3);
    const before = await page.evaluate(() => ({
      authors: document.querySelectorAll("article").length,
      scrollY: window.scrollY,
      firstVisible: [...document.querySelectorAll("article")].findIndex((article) => article.getBoundingClientRect().bottom > 0)
    }));
    assert(before.authors >= 384, "author test must enter a deep loaded window");
    assert(before.firstVisible >= 192, "author test must scroll beyond the first author page");
    const authorCards = page.locator(".short-video-author-index-card-main");
    const openedCard = authorCards.nth(before.firstVisible + 4);
    const openedAuthorId = await openedCard.getAttribute("data-short-video-author-id");
    await openedCard.click();
    await page.locator(".short-video-author-page-back").waitFor({ state: "visible", timeout: 30000 });
    await page.locator(".short-video-author-page-back").focus();
    await page.keyboard.press("Enter");
    const restored = await waitFor(() => authorWindow(page), (value) => value.authors >= before.authors && value.firstVisible >= before.firstVisible - 1, 30000).catch(async (error) => {
      const current = await authorWindow(page);
      throw new Error(`author return did not restore the loaded window: before=${JSON.stringify(before)} current=${JSON.stringify(current)} requests=${apiRequests.join(" | ")}`, { cause: error });
    });
    assert(Math.abs(restored.firstVisible - before.firstVisible) <= 1, "returning from an author detail must restore the same deep scroll anchor");
    await waitForAuthorFocus(page, openedAuthorId, "keyboard return must restore focus to its triggering author card");

    const historyCard = authorCards.nth(before.firstVisible + 8);
    const historyAuthorId = await historyCard.getAttribute("data-short-video-author-id");
    await historyCard.click();
    await page.locator(".short-video-author-page-back").waitFor({ state: "visible", timeout: 30000 });
    await page.goBack();
    const historyRestored = await waitFor(() => authorWindow(page), (value) => value.authors >= before.authors && value.firstVisible >= before.firstVisible - 1, 30000);
    assert(Math.abs(historyRestored.firstVisible - before.firstVisible) <= 1, "browser history return must restore the same deep scroll anchor");
    await waitForAuthorFocus(page, historyAuthorId, "browser history return must restore focus to its triggering author card");
  } finally {
    await page.close();
  }
}

async function verifyAuthorReturnDiscardsDelayedDetail(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/short-videos?perf=1`, { waitUntil: "domcontentloaded" });
    await page.locator(".short-video-home").waitFor({ state: "visible", timeout: 30000 });
    await page.locator('.short-video-source-tab[data-source="authors"]').click({ force: true });
    const authorCards = page.locator(".short-video-author-index-card-main");
    await authorCards.first().waitFor({ state: "visible", timeout: 30000 });
    const openedCard = authorCards.nth(7);
    const openedAuthorId = await openedCard.getAttribute("data-short-video-author-id");
    const delayed = deferNextAuthorDetail();
    await openedCard.click();
    await delayed.requested;
    await page.goBack();
    const restored = await waitFor(() => authorWindow(page), (value) => value.authors === 96 && new URL(value.href).searchParams.get("source") === "authors", 30000);
    await waitForAuthorFocus(page, openedAuthorId, "immediate history return must restore focus before the delayed detail resolves");
    delayed.release();
    await page.waitForTimeout(250);
    const afterDelayedDetail = await authorWindow(page);
    assert.equal(afterDelayedDetail.authors, restored.authors, "a stale detail response must not replace the restored author index");
    assert.equal(new URL(afterDelayedDetail.href).searchParams.get("source"), "authors", "a stale detail response must not change the restored author-index URL");
    await waitForAuthorFocus(page, openedAuthorId, "a stale detail response must not steal restored author-card focus");
  } finally {
    await page.close();
  }
}

async function verifyDirectAuthorDeepLink(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const authorRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/short-videos/authors?")) authorRequests.push(request.url());
  });
  try {
    await page.goto(`${baseUrl}/short-videos/authors/fixture-author-7?perf=1`, { waitUntil: "domcontentloaded" });
    await page.locator(".short-video-author-page-back").waitFor({ state: "visible", timeout: 30000 });
    assert.equal(authorRequests.length, 0, "a direct author deep link must not have an author-index snapshot");
    await page.locator(".short-video-author-page-back").click();
    await page.locator(".short-video-author-index-card-main").first().waitFor({ state: "visible", timeout: 30000 });
    assert.equal(authorRequests.length, 1, "a direct author deep link must load a fresh author index instead of restoring a snapshot");
    await waitForAuthorFocus(page, "", "direct author return must focus the author-list heading when no triggering card exists");
  } finally {
    await page.close();
  }
}

async function authorWindow(page) {
  return page.evaluate(() => ({
    authors: document.querySelectorAll("article").length,
    scrollY: window.scrollY,
    firstVisible: [...document.querySelectorAll("article")].findIndex((article) => article.getBoundingClientRect().bottom > 0),
    href: window.location.href
  }));
}

async function waitForAuthorFocus(page, authorId, message) {
  const attribute = authorId ? "shortVideoAuthorId" : "shortVideoAuthorIndexHeading";
  const expected = authorId || "1";
  const actual = await waitFor(
    () => page.evaluate((key) => document.activeElement?.dataset[key] || "", attribute),
    (value) => value === expected,
    5000
  );
  assert.equal(actual, expected, message);
}

async function loadMoreAuthorPages(page, pages) {
  for (let index = 0; index < pages; index += 1) {
    const before = await page.locator("article").count();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await waitFor(() => page.locator("article").count(), (count) => count > before, 30000);
  }
}

async function waitFor(read, condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (condition(value)) return value;
    await delay(120);
  } while (Date.now() < deadline);
  throw new Error("browser condition did not become true before timeout");
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Chrome or Edge is required for verify:browser-behavior; set CHROME_PATH when it is installed elsewhere");
  return executable;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferNextAuthorDetail() {
  let requestedResolve;
  let releaseResolve;
  const deferred = {
    requested: new Promise((resolve) => { requestedResolve = resolve; }),
    release: () => releaseResolve()
  };
  delayedAuthorDetail = {
    requested: () => requestedResolve(),
    response: new Promise((resolve) => { releaseResolve = resolve; })
  };
  return deferred;
}

async function fixtureApi(url) {
  if (url.pathname === "/api/health") return { ok: true };
  if (url.pathname === "/api/short-videos/authors") {
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const limit = Math.max(1, Number(url.searchParams.get("limit") || 96));
    const all = Array.from({ length: 480 }, (_, index) => ({
      secUid: `fixture-author-${index + 1}`,
      name: `作者 ${index + 1}`,
      count: 480 - index,
      avatarUrl: ""
    }));
    const authors = all.slice(offset, offset + limit);
    return { authors, total: all.length, scopeTotal: all.length, hasMore: offset + authors.length < all.length };
  }
  if (url.pathname.startsWith("/api/short-videos/authors/resolve")) {
    const secUid = url.searchParams.get("mention") || "fixture-author-1";
    return { author: { secUid, name: secUid.replace("fixture-author-", "作者 "), count: 1 } };
  }
  if (url.pathname === "/api/short-videos") {
    const author = url.searchParams.get("author") || "fixture-author-1";
    if (url.searchParams.get("author") && delayedAuthorDetail) {
      const delayed = delayedAuthorDetail;
      delayedAuthorDetail = null;
      delayed.requested();
      await delayed.response;
    }
    return {
      videos: [{
        id: `fixture-video-${author}`,
        author: { secUid: author, name: author.replace("fixture-author-", "作者 "), count: 1 },
        title: "浏览器行为测试视频",
        media: "video",
        publishedAt: "2026-01-01T00:00:00.000Z",
        stats: {}
      }],
      total: 1,
      hasMore: false
    };
  }
  return {};
}

function sendJson(response, body) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json"
  }[extension] || "text/html; charset=utf-8";
}

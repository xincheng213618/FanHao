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
const fixtureCollections = new Map();
let fixtureCollectionSequence = 0;

try {
  await waitForHealth(baseUrl);
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    await verifyStandaloneStyles(browser);
    await verifyMobileGallery(browser);
    await verifyAuthorIndexReturn(browser);
    await verifyAuthorReturnDiscardsDelayedDetail(browser);
    await verifyAuthorReturnDiscardsDelayedError(browser);
    await verifyDirectAuthorDeepLink(browser);
    await verifyShortVideoCollections(browser);
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
      try {
        sendJson(response, await fixtureApi(url, {
          method: request.method || "GET",
          body: await readFixtureJson(request)
        }));
      } catch (error) {
        sendJson(response, { error: String(error?.message || error || "fixture request failed") }, 503);
      }
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

async function verifyAuthorReturnDiscardsDelayedError(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/short-videos?perf=1`, { waitUntil: "domcontentloaded" });
    await page.locator(".short-video-home").waitFor({ state: "visible", timeout: 30000 });
    await page.locator('.short-video-source-tab[data-source="authors"]').click({ force: true });
    const authorCards = page.locator(".short-video-author-index-card-main");
    await authorCards.first().waitFor({ state: "visible", timeout: 30000 });
    const openedCard = authorCards.nth(40);
    await openedCard.scrollIntoViewIfNeeded();
    const openedAuthorId = await openedCard.getAttribute("data-short-video-author-id");
    const delayed = deferNextAuthorDetail({ reject: true });
    await openedCard.click();
    await delayed.requested;
    await page.goBack();
    await waitFor(() => authorWindow(page), (value) => value.authors === 96 && new URL(value.href).searchParams.get("source") === "authors", 30000);
    await waitForAuthorFocus(page, openedAuthorId, "immediate history return must restore focus before the delayed detail rejects");
    await page.waitForTimeout(120);
    const beforeReject = await authorIndexFingerprint(page);
    assert(beforeReject.scrollY > 0, "the delayed rejection test must restore a meaningful non-zero scroll position");
    const rejectedResponse = page.waitForResponse((response) => response.status() === 503 && new URL(response.url()).searchParams.has("author"));
    delayed.release();
    await rejectedResponse;
    await page.waitForTimeout(250);
    const afterReject = await authorIndexFingerprint(page);
    assert.deepEqual(afterReject, beforeReject, "a stale detail rejection must not change author count, URL, scroll, focus, status, or DOM");
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

async function verifyShortVideoCollections(browser) {
  fixtureCollections.clear();
  fixtureCollectionSequence = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/short-videos`, { waitUntil: "domcontentloaded" });
    const firstCard = page.locator(".short-video-card .short-video-thumb-open").first();
    await firstCard.waitFor({ state: "visible", timeout: 30000 });
    await firstCard.click();
    const addToCollection = page.locator(".short-video-rail-button.is-collection");
    await addToCollection.waitFor({ state: "visible", timeout: 30000 });
    await addToCollection.click();
    const picker = page.locator(".short-video-collection-picker");
    await picker.waitFor({ state: "visible", timeout: 5000 });
    await picker.locator('input[name="collectionName"]').fill("E2E 稍后看");
    await picker.locator('button[type="submit"]').click();
    await picker.waitFor({ state: "detached", timeout: 5000 });

    await page.goBack();
    await page.locator(".short-video-collection-sidebar").waitFor({ state: "visible", timeout: 30000 });
    const collection = page.locator(".short-video-collection-sidebar-item", { hasText: "E2E 稍后看" });
    await collection.waitFor({ state: "visible", timeout: 5000 });
    await collection.click();
    await page.waitForURL(/\/short-videos\/collections\/svc_fixture_1$/u, { timeout: 5000 });
    const remove = page.locator('.short-video-collection-remove[data-video-id="fixture-video-fixture-author-1"]');
    await remove.waitFor({ state: "visible", timeout: 5000 });
    await remove.click();
    await page.locator(".short-video-empty", { hasText: "这个清单还没有视频" }).waitFor({ state: "visible", timeout: 5000 });
    assert.equal(fixtureCollections.get("svc_fixture_1")?.videoIds.size, 0, "Chromium remove must persist through the collection API fixture");
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

async function authorIndexFingerprint(page) {
  return page.evaluate(() => {
    const home = document.querySelector(".short-video-home");
    return {
      authors: document.querySelectorAll(".short-video-author-index-card-main").length,
      href: window.location.href,
      scrollY: window.scrollY,
      focusedAuthorId: document.activeElement?.dataset.shortVideoAuthorId || "",
      focusedHeading: document.activeElement?.dataset.shortVideoAuthorIndexHeading || "",
      status: [...document.querySelectorAll(".short-video-home .short-video-status, .short-video-home .short-video-author-index-status")]
        .map((element) => `${element.className}:${element.textContent}`),
      dom: home?.innerHTML || ""
    };
  });
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

function deferNextAuthorDetail(options = {}) {
  let requestedResolve;
  let releaseResolve;
  const deferred = {
    requested: new Promise((resolve) => { requestedResolve = resolve; }),
    release: () => releaseResolve()
  };
  delayedAuthorDetail = {
    reject: Boolean(options.reject),
    requested: () => requestedResolve(),
    response: new Promise((resolve) => { releaseResolve = resolve; })
  };
  return deferred;
}

async function fixtureApi(url, request = {}) {
  if (url.pathname === "/api/health") return { ok: true };
  if (url.pathname === "/api/short-videos/collections") {
    if (request.method === "POST") {
      const id = `svc_fixture_${++fixtureCollectionSequence}`;
      const collection = { id, name: String(request.body?.name || ""), itemCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      fixtureCollections.set(id, { collection, videoIds: new Set() });
      return { collection };
    }
    return { collections: [...fixtureCollections.values()].map((entry) => ({ ...entry.collection, itemCount: entry.videoIds.size })), total: fixtureCollections.size };
  }
  const collectionVideos = /^\/api\/short-videos\/collections\/([^/]+)\/videos$/.exec(url.pathname);
  if (collectionVideos) {
    const entry = fixtureCollections.get(decodeURIComponent(collectionVideos[1]));
    if (!entry) throw new Error("fixture collection not found");
    const videos = [...entry.videoIds].map((id) => fixtureVideo(id));
    return {
      collection: { ...entry.collection, itemCount: videos.length },
      videos,
      count: videos.length,
      total: videos.length,
      limit: 48,
      offset: 0,
      hasMore: false,
      nextOffset: null
    };
  }
  const collectionVideo = /^\/api\/short-videos\/collections\/([^/]+)\/videos\/([^/]+)$/.exec(url.pathname);
  if (collectionVideo) {
    const entry = fixtureCollections.get(decodeURIComponent(collectionVideo[1]));
    if (!entry) throw new Error("fixture collection not found");
    const videoId = decodeURIComponent(collectionVideo[2]);
    if (request.method === "DELETE") {
      const removed = entry.videoIds.delete(videoId);
      return { removed, collectionId: entry.collection.id, videoId };
    }
    const before = entry.videoIds.size;
    entry.videoIds.add(videoId);
    return { added: entry.videoIds.size > before, collectionId: entry.collection.id, videoId, addedAt: "2026-01-02T00:00:00.000Z" };
  }
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
      if (delayed.reject) throw new Error("fixture delayed author detail rejection");
    }
    return {
      videos: [fixtureVideo(`fixture-video-${author}`, author)],
      total: 1,
      hasMore: false
    };
  }
  const detail = /^\/api\/short-videos\/([^/]+)$/.exec(url.pathname);
  if (detail) {
    const video = fixtureVideo(decodeURIComponent(detail[1]));
    return { video, prevId: "", nextId: "", neighbors: { previous: [], next: [] } };
  }
  return {};
}

function fixtureVideo(id, author = "fixture-author-1") {
  return {
    id,
    author: { secUid: author, name: author.replace("fixture-author-", "作者 "), count: 1 },
    title: "浏览器行为测试视频",
    media: "video",
    mediaType: "video",
    coverUrl: "/fixture-cover.svg",
    streamUrl: `/media/short-video/${encodeURIComponent(id)}`,
    publishedAt: "2026-01-01T00:00:00.000Z",
    actions: {},
    stats: {}
  };
}

async function readFixtureJson(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "")) return {};
  let text = "";
  for await (const chunk of request) text += chunk;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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

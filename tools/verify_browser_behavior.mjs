import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { verifyAndroidNavigationRestoration } from "./fixtures/android-navigation-browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.FANHAO_BROWSER_TEST_PORT || 0);
const suppliedBaseUrl = String(process.env.FANHAO_BROWSER_TEST_BASE_URL || "").trim();
const ownedServer = suppliedBaseUrl ? null : await startFixtureServer(port);
const fixturePort = Number(ownedServer?.address()?.port || 0);
const baseUrl = suppliedBaseUrl || `http://127.0.0.1:${fixturePort}`;
let delayedAuthorDetail = null;
const delayedNovelRequests = [];
let delayedNovelCollection = null;
let fixtureNovelCollectionRequests = 0;
let fixtureNovelSummaryRequests = 0;
const fixtureCollections = new Map();
let fixtureCollectionSequence = 0;
const fixtureCollectionDetailRequests = [];
const fixtureCollectionPageRequests = [];
const fixtureFanhaoCollectionRequests = [];
const fixturePersonDetailRequests = [];
const authorCardSelector = ".short-video-author-index-card-main";

try {
  await waitForHealth(baseUrl);
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    if (process.argv.includes("--android-person-first")) {
      await verifyAndroidPersonFirstLibraries(browser);
    } else {
    await verifyFanhaoRequestLifecycle(browser);
    if (!process.argv.includes("--fanhao-requests")) {
    await verifyAndroidNavigationRestoration(browser, baseUrl, fixtureApi);
    await verifyAndroidMangaAddLifecycle(browser);
    await verifyAndroidMangaTaskNotices(browser);
    await verifyAndroidMangaReadingProgress(browser);
    await verifyStandaloneStyles(browser);
    await verifyNovelLibraryIntent(browser);
    await verifyNovelLibraryAppendRecovery(browser);
    await verifyNovelCardAccessibility(browser);
    await verifyNovelRankingClampHistory(browser);
    await verifyNovelManageExitStopsPolling(browser);
    await verifyMobileGallery(browser);
    await verifyAndroidStartupSurface(browser);
    await verifyAndroidOfflineStartup(browser);
    await verifyAndroidReconnectFlow(browser);
    await verifyAndroidUpdateLifecycle(browser);
    await verifyAndroidAppConfirmation(browser);
    await verifyAndroidPersonFirstLibraries(browser);
    await verifyAndroidPhotoCatalog(browser);
    await verifyAuthorIndexReturn(browser);
    await verifyAuthorReturnDiscardsDelayedDetail(browser);
    await verifyAuthorReturnDiscardsDelayedError(browser);
    await verifyDirectAuthorDeepLink(browser);
    await verifyAndroidCollectionPicker(browser);
    await verifyAndroidCollectionRefresh(browser);
    await verifyAndroidCollectionManagement(browser);
    await verifyAndroidCollectionStackReturn(browser);
    await verifyAndroidNativeActionCardRefresh(browser);
    await verifyAndroidRestartActionConvergence(browser);
    await verifyAndroidColdRestartBootstrapConvergence(browser);
    await verifyAndroidFavoriteFolders(browser);
    await verifyAndroidFavoriteRoute(browser);
    await verifyAndroidFavoriteServerSwitch(browser);
    await verifyShortVideoCollections(browser);
    }
    }
  } finally {
    await browser.close();
  }
  console.log("Executable browser behavior checks passed.");
} finally {
  if (ownedServer) await stopServer(ownedServer);
}

async function verifyFanhaoRequestLifecycle(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  let delayedLibrary = null, delayedAppend = null, delayedPrefixIndex = null, delayedPrefixAppend = null;
  const studioRequests = [];
  const delayedRequests = new Set();
  function delayed() {
    let arrived, release, requested = false;
    const pending = { requested: new Promise((resolve) => { arrived = resolve; }), wait: new Promise((resolve) => { release = resolve; }), arrived: () => { requested = true; arrived(); }, isRequested: () => requested, release: () => { delayedRequests.delete(pending); release(); } };
    delayedRequests.add(pending);
    return pending;
  }
  const people = [{ id: "request-person", name: "请求测试人物", workCount: 128, sourceCount: 1 }];
  try {
    await page.route((url) => url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/api/"), async (route) => {
      const url = new URL(route.request().url());
      let payload;
      if (url.pathname === "/api/library") {
        if (url.searchParams.get("scope") === "western" && delayedLibrary) {
          const pending = delayedLibrary;
          delayedLibrary = null;
          pending.arrived();
          await pending.wait;
        }
        payload = { scope: url.searchParams.get("scope") || "main", people, works: [], access: { mode: "local" }, totals: {}, user: {} };
      } else if (url.pathname === "/api/people/request-person") {
        const offset = Number(url.searchParams.get("offset") || 0);
        const sort = url.searchParams.get("sort") || "releaseDesc";
        if (offset && delayedAppend) {
          const pending = delayedAppend;
          delayedAppend = null;
          pending.arrived();
          await pending.wait;
        }
        const favorite = (url.searchParams.get("filter") || "").split(",").includes("favorite");
        const prefix = favorite ? "filtered" : sort === "ratingDesc" ? "fresh" : "obsolete";
        payload = {
          person: people[0], total: 128, facets: { all: 128 },
          works: Array.from({ length: 64 }, (_, index) => ({
            id: `${prefix}-${offset + index}`, title: `${prefix} ${offset + index}`, personId: people[0].id,
            favorite, videoCount: 1, playableCount: 1, infoSummary: { rating: 4, releaseDate: "2026-10-04" }
          }))
        };
      } else if (url.pathname === "/api/modules") payload = { modules: [] };
      else if (url.pathname === "/api/code-prefixes") {
        if (delayedPrefixIndex) {
          const pending = delayedPrefixIndex; delayedPrefixIndex = null; pending.arrived(); await pending.wait;
        }
        payload = { prefixes: [{ prefix: "ABC", localCount: 128 }], localWorkCount: 128 };
      } else if (url.pathname === "/api/code-prefixes/ABC") {
        const offset = Number(url.searchParams.get("offset") || 0);
        if (offset && delayedPrefixAppend) {
          const pending = delayedPrefixAppend; delayedPrefixAppend = null; pending.arrived(); await pending.wait;
        }
        const favorite = (url.searchParams.get("filter") || "").split(",").includes("favorite");
        const prefix = favorite ? "code-filtered" : "code-obsolete";
        payload = { codePrefix: { prefix: "ABC", localCount: 128 }, total: 128, facets: { all: 128 }, works: Array.from({ length: Number(url.searchParams.get("limit")) }, (_, index) => ({ id: `${prefix}-${offset + index}`, title: `${prefix} ${offset + index}`, favorite, videoCount: 1, playableCount: 1 })) };
      } else if (url.pathname === "/api/studios") {
        payload = { makers: [{ id: "request-studio", name: "请求测试片商", localWorkCount: 160 }] };
      } else if (url.pathname === "/api/studios/request-studio") {
        studioRequests.push(url);
        const favorite = (url.searchParams.get("filter") || "").split(",").includes("favorite");
        // Matches occur beyond the first unfiltered page. Filtering precedes
        // slicing, so both the visible first page and total must be complete.
        const all = Array.from({ length: 160 }, (_, index) => ({ id: `studio-${index}`, title: `studio ${index}`, favorite: index >= 100, videoCount: 1, playableCount: 1 }));
        const matches = favorite ? all.filter((work) => work.favorite) : all;
        const offset = Number(url.searchParams.get("offset") || 0);
        payload = { studio: { id: "request-studio", name: "请求测试片商", series: [] }, total: matches.length, facets: { all: 160, favorite: 60 }, works: matches.slice(offset, offset + Number(url.searchParams.get("limit"))) };
      }
      else if (url.pathname === "/api/favorites") payload = { works: [], total: 0, folders: [], selectedFolderId: "all" };
      else payload = {};
      // Superseded fetches are deliberately fulfilled after cancellation to
      // exercise the real shell, while their client-side abort remains valid.
      await route.fulfill({ json: payload }).catch((error) => {
        if (!/already handled|Target closed|Invalid InterceptionId|cancel/i.test(String(error))) throw error;
      });
    });
    await page.goto(`${baseUrl}/fanhao`, { waitUntil: "domcontentloaded" });
    await page.locator(".person-index-card", { hasText: people[0].name }).waitFor();
    const firstScope = delayed();
    delayedLibrary = firstScope;
    await page.locator('[data-view="people"][data-people-scope="western"]').click();
    await firstScope.requested;
    await page.locator('[data-view="people"][data-people-scope="main"]').click();
    await page.locator('[data-view="people"][data-people-scope="main"][aria-current="page"]').waitFor();
    firstScope.release();
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#currentTitle").textContent(), "人物", "a late western scope must not replace the latest main navigation");

    const secondScope = delayed();
    delayedLibrary = secondScope;
    await page.locator('[data-view="people"][data-people-scope="western"]').click();
    await secondScope.requested;
    await page.locator('[data-view="favorites"]').click();
    await page.locator("#currentTitle", { hasText: "收藏" }).waitFor();
    secondScope.release();
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#currentTitle").textContent(), "收藏", "a completed scope request must not pull the user away from favorites");

    await page.locator('[data-view="people"][data-people-scope="main"]').click();
    await page.locator(".person-index-card", { hasText: people[0].name }).click();
    await page.locator('.work-card[data-work-id="obsolete-0"]').waitFor();
    const oldPage = delayed();
    delayedAppend = oldPage;
    // Reach the progressive renderer's final batch before its server-page
    // continuation becomes available; the production observer then loads it.
    for (let attempt = 0; attempt < 10 && !oldPage.isRequested(); attempt++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(50);
    }
    assert(oldPage.isRequested(), "scrolling the real list must request its next server page");
    await oldPage.requested;
    await page.locator("#sortSelect").selectOption("ratingDesc");
    await page.locator('.work-card[data-work-id="fresh-0"]').waitFor();
    oldPage.release();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.work-card[data-work-id^="obsolete-"]').count(), 0, "late pagination must not contaminate the changed sort");

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#sortSelect").selectOption("releaseDesc");
    await page.locator('.work-card[data-work-id="obsolete-0"]').waitFor();
    const oldFilterPage = delayed();
    delayedAppend = oldFilterPage;
    for (let attempt = 0; attempt < 10 && !oldFilterPage.isRequested(); attempt++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(50);
    }
    assert(oldFilterPage.isRequested());
    await page.locator('[data-work-filter="favorite"]').click();
    await page.locator('.work-card[data-work-id="filtered-0"]').waitFor();
    oldFilterPage.release();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.work-card[data-work-id^="obsolete-"]').count(), 0, "late pagination must not contaminate the changed filter");

    const index = delayed(); delayedPrefixIndex = index;
    const codesTab = page.locator('[data-view="codes"]:not([data-code-prefix])');
    await codesTab.click(); await index.requested;
    await page.locator('[data-view="favorites"]').click();
    await page.locator("#currentTitle", { hasText: "收藏" }).waitFor();
    const favoriteUrl = page.url(); index.release(); await page.waitForTimeout(50);
    assert.equal(page.url(), favoriteUrl, "a late prefix index must preserve the newer favorites URL");
    assert.equal(await page.locator("#currentTitle").textContent(), "收藏");
    await codesTab.click();
    await page.locator(".code-prefix-row", { hasText: "ABC" }).click();
    await page.locator('.work-card[data-work-id="code-obsolete-0"]').waitFor();
    const prefixAppend = delayed(); delayedPrefixAppend = prefixAppend;
    for (let attempt = 0; attempt < 12 && !prefixAppend.isRequested(); attempt++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(50);
    }
    assert(prefixAppend.isRequested(), "the real prefix list must request server pagination");
    await page.locator('[data-work-filter="favorite"]').click();
    await page.locator('.work-card[data-work-id="code-filtered-0"]').waitFor();
    prefixAppend.release(); await page.waitForTimeout(50);
    assert.equal(await page.locator('.work-card[data-work-id^="code-obsolete-"]').count(), 0);

    await page.locator('[data-work-filter="favorite"][aria-pressed="true"]').click();
    await page.locator('[data-view="studios"]').click();
    await page.locator(".studio-card", { hasText: "请求测试片商" }).click();
    await page.locator('.work-card[data-work-id="studio-0"]').waitFor();
    await page.locator('[data-work-filter="favorite"]').click();
    await page.locator('.work-card[data-work-id="studio-100"]').waitFor();
    assert.equal(await page.locator("#currentPath").textContent(), "60 部本地作品", "the studio total must describe all server-side filter matches");
    for (let attempt = 0; attempt < 12 && !studioRequests.some((url) => url.searchParams.get("filter") === "favorite" && Number(url.searchParams.get("offset")) > 0); attempt++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(50);
    }
    assert(studioRequests.some((url) => url.searchParams.get("filter") === "favorite" && url.searchParams.get("offset") === "48"), "studio pagination must retain its server filter and use matching-result offset");
    await page.locator('.work-card[data-work-id="studio-159"]').waitFor();
    assert.equal(await page.locator('.work-card[data-work-id="studio-0"]').count(), 0);
    assert.deepEqual(pageErrors, [], "FanHao request fixtures must not emit browser script errors");
  } finally {
    for (const pending of delayedRequests) pending.release();
    await page.close();
  }
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
        sendJson(
          response,
          { error: String(error?.message || error || "fixture request failed") },
          Math.max(400, Math.min(599, Number(error?.statusCode || 503)))
        );
      }
      return;
    }
    if (url.pathname === "/android-picker-fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><html><body><main id=fixture></main></body></html>");
      return;
    }
    const androidAsset = url.pathname.startsWith("/android-client/");
    const staticRoot = path.resolve(root, androidAsset ? "android-client/www" : "public");
    const relative = androidAsset
      ? url.pathname.slice("/android-client/".length)
      : url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = path.resolve(staticRoot, relative);
    const safeFile = filePath.startsWith(`${staticRoot}${path.sep}`) || filePath === staticRoot ? filePath : "";
    const fallback = path.join(root, "public", "index.html");
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

async function verifyNovelLibraryIntent(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const search = page.locator("input[aria-label='搜索小说']");
  const bookTitle = () => page.locator(".novel-book-row h3");
  async function submitSearch(value) {
    await search.fill(value);
    await search.press("Enter");
  }
  try {
    await page.goto(`${baseUrl}/novels`, { waitUntil: "domcontentloaded" });
    await bookTitle().waitFor({ state: "visible", timeout: 5000 });

    const staleSuccess = deferNextNovelRequest();
    await submitSearch("旧成功");
    await staleSuccess.requested;
    await submitSearch("最新成功");
    await bookTitle().filter({ hasText: "最新成功" }).waitFor({ state: "visible", timeout: 5000 });
    staleSuccess.release();
    await page.waitForTimeout(50);
    assert.equal(await bookTitle().textContent(), "最新成功", "a stale successful novel response must not replace the latest search");
    assert.match(page.url(), /\?q=%E6%9C%80%E6%96%B0%E6%88%90%E5%8A%9F/, "the URL must retain the latest successful search");

    const staleFailure = deferNextNovelRequest({ reject: true });
    await submitSearch("旧失败");
    await staleFailure.requested;
    await submitSearch("最新失败后搜索");
    await bookTitle().filter({ hasText: "最新失败后搜索" }).waitFor({ state: "visible", timeout: 5000 });
    staleFailure.release();
    await page.waitForTimeout(50);
    assert.equal(await bookTitle().textContent(), "最新失败后搜索", "a stale failed novel response must not replace the latest search status or result");
    assert.equal(await page.locator(".novel-empty-card", { hasText: "fixture stale novel request failed" }).count(), 0, "a stale error must not render an error state");

    const staleFinally = deferNextNovelRequest();
    await submitSearch("旧 finally");
    await staleFinally.requested;
    const latestPending = deferNextNovelRequest();
    await submitSearch("最新仍在读取");
    await latestPending.requested;
    staleFinally.release();
    await page.locator(".novel-home-loading", { hasText: "正在读取小说书库" }).waitFor({ state: "visible", timeout: 5000 });
    assert.match(page.url(), /\?q=%E6%9C%80%E6%96%B0%E4%BB%8D%E5%9C%A8%E8%AF%BB%E5%8F%96/, "a stale completion must not rewrite the pending latest route");
    latestPending.release();
    await bookTitle().filter({ hasText: "最新仍在读取" }).waitFor({ state: "visible", timeout: 5000 });

    await page.getByRole("button", { name: "测试作者" }).click();
    await page.locator(".novel-author-profile-head").waitFor({ state: "visible", timeout: 5000 });
    assert.match(page.url(), /\/novels\/authors\//, "author navigation must write an author route");
    await page.getByRole("button", { name: "书库" }).click();
    await page.getByRole("button", { name: /科幻/ }).click();
    await bookTitle().filter({ hasText: "科幻" }).waitFor({ state: "visible", timeout: 5000 });
    assert.match(page.url(), /category=%E7%A7%91%E5%B9%BB/, "category navigation must write its route");

    await submitSearch("前进后退一");
    await bookTitle().filter({ hasText: "前进后退一" }).waitFor({ state: "visible", timeout: 5000 });
    await submitSearch("前进后退二");
    await bookTitle().filter({ hasText: "前进后退二" }).waitFor({ state: "visible", timeout: 5000 });
    await page.goBack();
    await bookTitle().filter({ hasText: "前进后退一" }).waitFor({ state: "visible", timeout: 5000 });
    await page.goForward();
    await bookTitle().filter({ hasText: "前进后退二" }).waitFor({ state: "visible", timeout: 5000 });

    await submitSearch("当前失败");
    await page.locator(".novel-empty-card", { hasText: "fixture current novel request failed" }).waitFor({ state: "visible", timeout: 5000 });
    assert.match(page.url(), /\?q=%E5%BD%93%E5%89%8D%E5%A4%B1%E8%B4%A5/, "a current failed search must retain its intended URL");
    assert.equal(await page.locator(".novel-home-loading").count(), 0, "a current failed search must clear its loading state");
    await submitSearch("失败后恢复");
    await bookTitle().filter({ hasText: "失败后恢复" }).waitFor({ state: "visible", timeout: 5000 });

  } finally {
    await page.close();
  }
}

async function verifyNovelLibraryAppendRecovery(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  const pageErrors = [];
  const total = 120;
  const draft = "尚未提交的搜索草稿";
  const base = fixtureNovels(new URL("/api/novels", baseUrl));
  const books = Array.from({ length: total }, (_, index) => ({
    ...base.books[0],
    id: `fixture-append-novel-${index + 1}`,
    title: `分页测试小说 ${String(index + 1).padStart(3, "0")}`
  }));
  let releaseAppend;
  let releaseRetry;
  const pendingAppend = new Promise((resolve) => { releaseAppend = resolve; });
  const pendingRetry = new Promise((resolve) => { releaseRetry = resolve; });
  let failLastPage = true;
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  async function assertRetained(snapshot, message) {
    const actual = await page.evaluate((original) => {
      const rows = [...document.querySelectorAll(".novel-book-row")];
      return {
        rows: original.rows.every((row, index) => row === rows[index] && row.isConnected),
        list: original.list === document.querySelector(".novel-book-list"),
        search: original.search === document.querySelector("input[aria-label='搜索小说']"),
        draft: original.search.value,
        focus: document.activeElement === original.focusTarget
      };
    }, snapshot);
    assert.deepEqual(actual, { rows: true, list: true, search: true, draft, focus: true }, message);
  }
  async function scrollToTail() {
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  }
  try {
    await page.route((url) => url.pathname === "/api/novels", async (route) => {
      const url = new URL(route.request().url());
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 48);
      requests.push(offset);
      if (offset === 48) await pendingAppend;
      if (offset === 96) {
        if (failLastPage) return route.fulfill({ status: 503, json: { error: "fixture next page unavailable" } });
        await pendingRetry;
      }
      return route.fulfill({ json: {
        ...base,
        books: books.slice(offset, offset + limit),
        limit,
        offset,
        total,
        facets: [{ name: "科幻", count: total }],
        summary: { categories: [{ name: "科幻", count: total }], totals: { authors: 1, books: total, bytes: total * 12000, chapters: total * 3 } }
      } });
    });
    await page.goto(`${baseUrl}/novels`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll(".novel-book-row").length === 48);
    assert.equal(await page.locator(".novel-library h1").textContent(), "小说书库");
    assert.equal(await page.locator(".novel-results-heading h2").textContent(), "全部作品");
    assert.equal(await page.locator(".novel-results-count").textContent(), "120 本", "the result count must describe all matching books, not only the loaded page");
    const search = page.getByRole("searchbox", { name: "搜索小说" });
    await search.fill(draft);
    const originalNodes = await page.evaluateHandle(() => {
      const rows = [...document.querySelectorAll(".novel-book-row")];
      const focusTarget = rows.at(-1).querySelector(".novel-book-detail");
      focusTarget.focus({ preventScroll: true });
      return { rows, list: rows[0].parentElement, search: document.querySelector("input[aria-label='搜索小说']"), focusTarget };
    });
    await scrollToTail();
    await page.locator(".novel-library-autoload", { hasText: "正在继续加载" }).waitFor({ state: "visible" });
    assert.deepEqual(requests, [0, 48], "scrolling into the tail must request exactly the next page");
    await assertRetained(originalNodes, "starting an append must preserve all existing rows, row focus and the unsubmitted search draft");
    const scrollBeforeAppend = await page.evaluate(() => window.scrollY);
    releaseAppend();
    await page.waitForFunction(() => document.querySelectorAll(".novel-book-row").length === 96);
    await assertRetained(originalNodes, "a successful append must retain the existing DOM and focused detail button");
    assert(Math.abs(await page.evaluate(() => window.scrollY) - scrollBeforeAppend) < 4, "appending books must retain the current scroll position");
    assert.match(await page.locator(".novel-library-autoload").textContent(), /已显示 96 \/ 120 本/);

    const loadedNodes = await page.evaluateHandle(() => {
      const rows = [...document.querySelectorAll(".novel-book-row")];
      const search = document.querySelector("input[aria-label='搜索小说']");
      search.focus({ preventScroll: true });
      return { rows, list: rows[0].parentElement, search, focusTarget: search };
    });
    await scrollToTail();
    const retry = page.getByRole("button", { name: "重试加载", exact: true });
    await retry.waitFor({ state: "visible" });
    assert.match(await page.locator(".novel-library-autoload").textContent(), /加载中断：fixture next page unavailable/);
    await assertRetained(loadedNodes, "a failed append must retain every loaded row and the focused search draft");
    for (let index = 0; index < 2; index += 1) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.waitForTimeout(50);
      await scrollToTail();
      await page.waitForTimeout(100);
    }
    assert.deepEqual(requests, [0, 48, 96], "a visible failed sentinel must not retry automatically, including after scrolling away and back");
    assert.equal(await page.locator(".novel-book-row").count(), 96, "a failed page must leave already loaded books available");

    failLastPage = false;
    await retry.click();
    await page.locator(".novel-library-autoload", { hasText: "正在继续加载" }).waitFor({ state: "visible" });
    await page.evaluate((original) => original.search.focus({ preventScroll: true }), loadedNodes);
    await assertRetained(loadedNodes, "explicit retry must preserve the list and search input while pending");
    releaseRetry();
    await page.waitForFunction(() => document.querySelectorAll(".novel-book-row").length === 120);
    await assertRetained(loadedNodes, "the successful retry must append without replacing any previous rows or focused input");
    assert.deepEqual(await page.locator(".novel-book-row h3").allTextContents(), books.map((book) => book.title), "successful pages must retain order without duplicates or omissions");
    assert.match(await page.locator(".novel-library-autoload").textContent(), /已显示 120 \/ 120 本/);
    assert.equal(await retry.count(), 0);
    assert.equal(await page.getByRole("button", { name: "加载更多", exact: true }).count(), 0);
    await scrollToTail();
    await page.waitForTimeout(150);
    assert.deepEqual(requests, [0, 48, 96, 96], "loading every book must stop further pagination requests");
    assert.equal(await search.inputValue(), draft);
    assert.deepEqual(pageErrors, [], "novel pagination recovery must not produce browser errors");
  } finally {
    releaseAppend();
    releaseRetry();
    await page.close();
  }
}

async function verifyAndroidAppConfirmation(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#appConfirmOverlay").waitFor({ state: "attached", timeout: 5000 });
    await page.evaluate(() => {
      const settings = document.querySelector("#settingsOverlay");
      if (settings) settings.hidden = false;
    });
    await page.locator("#clearResponseCacheButton").click();
    await page.locator("#appConfirmOverlay").waitFor({ state: "visible", timeout: 5000 });

    const opened = await page.evaluate(() => {
      const overlay = document.querySelector("#appConfirmOverlay");
      const sheet = document.querySelector("#appConfirmSheet");
      const mark = document.querySelector("#appConfirmMark");
      const accept = document.querySelector("#appConfirmAcceptButton");
      const siblings = [...(overlay?.parentElement?.children || [])].filter((element) => element !== overlay);
      return {
        tone: overlay?.dataset.tone,
        role: sheet?.getAttribute("role"),
        mark: mark?.textContent,
        acceptPrimary: accept?.classList.contains("primary"),
        acceptDanger: accept?.classList.contains("danger"),
        bodyLocked: document.body.classList.contains("app-confirm-open"),
        backgroundInert: siblings.length > 0 && siblings.every((element) => element.inert)
      };
    });
    assert.deepEqual(opened, {
      tone: "standard",
      role: "dialog",
      mark: "i",
      acceptPrimary: true,
      acceptDanger: false,
      bodyLocked: true,
      backgroundInert: true
    });

    await page.locator("#appConfirmCancelButton").focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "appConfirmAcceptButton", "Shift+Tab must wrap to the last confirmation action");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "appConfirmCancelButton", "Tab must wrap to the first confirmation action");

    await page.locator("#appConfirmCancelButton").click();
    await page.locator("#appConfirmOverlay").waitFor({ state: "hidden", timeout: 5000 });
    await page.waitForTimeout(80);
    const closed = await page.evaluate(() => {
      const overlay = document.querySelector("#appConfirmOverlay");
      const siblings = [...(overlay?.parentElement?.children || [])].filter((element) => element !== overlay);
      return {
        bodyLocked: document.body.classList.contains("app-confirm-open"),
        backgroundRestored: siblings.every((element) => !element.inert),
        focusedId: document.activeElement?.dataset?.bottomKey || document.activeElement?.id || document.activeElement?.tagName || ""
      };
    });
    assert.deepEqual(closed, { bodyLocked: false, backgroundRestored: true, focusedId: "clearResponseCacheButton" });
  } finally {
    await page.close();
  }
}

async function verifyAndroidUpdateLifecycle(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  const initialCode = 26083000;
  let latestCode = initialCode;
  let manifestFailure = false;
  let lanManifestFailure = false;
  let holdNextManifest = false;
  let releaseManifest = null;
  let markManifestPending = null;
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = page.locator("#appUpdateButton");
  const status = page.locator("#appUpdateStatus");
  const waitButton = (label) => button.filter({ hasText: label }).waitFor({ state: "visible", timeout: 10000 });
  const waitMessage = (message) => status.filter({ hasText: message }).waitFor({ state: "visible", timeout: 10000 });
  const fixtureCounts = () => page.evaluate(() => ({ reads: window.updateFixture.reads, installs: window.updateFixture.calls.length }));
  try {
    await page.addInitScript((versionCode) => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
      localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "tools", params: {} }));
      const fixture = window.updateFixture = {
        versionCode, permission: true, reads: 0, calls: [], result: { started: true },
        failVersion: false, failInstall: false, earlyReturn: false, onReturn: () => {}
      };
      window.Capacitor = { Plugins: { FanHaoUpdater: {
        async getInstalledVersion() {
          fixture.reads += 1;
          if (fixture.failVersion) throw new Error("fixture version read failure");
          return { versionCode: fixture.versionCode, versionName: `0.1.${fixture.versionCode}-debug`, packageName: "local.fanhao.library", canRequestPackageInstalls: fixture.permission };
        },
        async addListener(name, listener) {
          if (name === "updateFlowReturned") fixture.onReturn = listener;
          return { remove() {} };
        },
        async downloadAndInstall(args) {
          fixture.calls.push(args);
          if (fixture.failInstall) throw new Error("fixture download failure");
          if (fixture.earlyReturn) fixture.onReturn();
          return fixture.result;
        }
      } } };
    }, initialCode);
    // Switching the content server must first pass its independent access probe.
    // This reserved test host has no server; only this scenario's auth response is synthetic.
    await page.route((url) => url.hostname === "updates-new.test" && url.pathname === "/api/auth/status", (route) => {
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, OPTIONS" };
      return route.fulfill(route.request().method() === "OPTIONS"
        ? { status: 204, headers }
        : { status: 200, headers, contentType: "application/json", body: JSON.stringify({ required: false, authenticated: true, accountLoginRequired: false, reason: "trusted-network" }) });
    });
    await page.route((url) => url.pathname === "/api/android/update", async (route) => {
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, OPTIONS" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const url = new URL(route.request().url());
      requests.push(url.href);
      const payload = {
        available: latestCode > Number(url.searchParams.get("currentVersionCode") || 0),
        versionCode: latestCode, versionName: `0.1.${latestCode}-debug`, channel: "debug",
        fileName: `fanhao-debug-${latestCode}.apk`, downloadUrl: `${url.origin}/api/android/update/apk/debug/fanhao-debug-${latestCode}.apk`,
        size: 4096, sha256: "a".repeat(64)
      };
      const statusCode = manifestFailure || (lanManifestFailure && url.hostname === "192.168.31.86") ? 503 : 200;
      if (holdNextManifest) {
        holdNextManifest = false;
        const pending = new Promise((resolve) => { releaseManifest = resolve; });
        markManifestPending?.();
        await pending;
      }
      await route.fulfill({ status: statusCode, headers, contentType: "application/json", body: JSON.stringify(statusCode === 200 ? payload : { error: "fixture manifest failure" }) });
    });
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    await page.locator(".tools-settings-section button").first().click();
    await waitButton("检查更新");
    assert.match(await status.textContent(), /已是最新/);
    assert.deepEqual(await page.locator("#appUpdateSources strong").allTextContents(), ["192.168.31.86:29998", "xc213618.ddns.me:29998"], "settings must show the two configured update addresses, not the saved content-service address");
    assert.deepEqual(requests.map((url) => new URL(url).origin), ["http://192.168.31.86:29998", "http://xc213618.ddns.me:29998"], "startup must check only the two default update sources in order");
    assert.equal(await page.locator("#appUpdateSourceStatus").textContent(), "本次更新源：192.168.31.86:29998");
    const initialCounts = await fixtureCounts();
    latestCode += 1;
    lanManifestFailure = true;
    holdNextManifest = true;
    const recheckPending = new Promise((resolve) => { markManifestPending = resolve; });
    await button.click();
    await recheckPending;
    assert.equal(await button.isDisabled(), true, "an update check must disable duplicate taps");
    await button.evaluate((node) => { node.click(); node.click(); });
    assert.equal((await fixtureCounts()).reads, initialCounts.reads + 1, "one manual recheck must read the actual installed version only once");
    releaseManifest();
    await waitButton("立即更新");
    assert.match(await page.locator("#appLatestVersion").textContent(), new RegExp(String(latestCode)), "manual recheck must discover a manifest published since startup without reloading the app");
    assert.equal(await page.locator("#appUpdateSourceStatus").textContent(), "本次更新源：xc213618.ddns.me:29998", "a failed LAN source must fall back to DDNS and show the source actually used");
    fs.mkdirSync(path.join(root, ".codex-artifacts"), { recursive: true });
    await page.locator('[aria-labelledby="appUpdateTitle"]').screenshot({ path: path.join(root, ".codex-artifacts", "android-default-update-sources.png") });
    lanManifestFailure = false;

    await page.evaluate(() => { window.updateFixture.failInstall = true; });
    await button.click();
    await waitMessage("更新安装失败");
    await waitButton("重试更新");
    const download = await page.evaluate(() => window.updateFixture.calls.at(-1));
    assert.equal(download.serviceBase, "http://xc213618.ddns.me:29998", "native downloads must bind to the successful fallback update source");
    assert.equal(new URL(download.url).origin, download.serviceBase, "the APK and manifest must share their origin even when the content server is different");
    assert.doesNotMatch(await status.textContent(), /检查失败/, "an installer/download failure must not be mislabeled as a check failure");
    await page.evaluate(() => { window.updateFixture.failInstall = false; });
    await button.click();
    await waitButton("检查安装结果");
    assert.equal(await button.isDisabled(), false, "returning without a lifecycle signal must still leave manual recovery available");
    const beforeReturn = await fixtureCounts();
    const requestsBeforeReturn = requests.length;
    await page.evaluate(() => { window.updateFixture.onReturn(); window.updateFixture.onReturn(); });
    await waitMessage("本次安装尚未完成");
    await waitButton("立即更新");
    assert.deepEqual(await fixtureCounts(), { reads: beforeReturn.reads + 1, installs: beforeReturn.installs }, "duplicate native return signals must reconcile once and never auto-reinstall");
    assert.equal(requests.length, requestsBeforeReturn, "installer return must check the local package rather than wait on another manifest request");
    await button.click();
    await waitButton("检查安装结果");
    await button.click();
    await waitMessage("本次安装尚未完成");

    await page.evaluate(() => { window.updateFixture.permission = false; window.updateFixture.result = { started: false, needsPermission: true }; });
    await button.click();
    await waitButton("继续更新");
    await page.evaluate(() => window.updateFixture.onReturn());
    await waitMessage("尚未允许安装更新");
    const permissionCounts = await fixtureCounts();
    await page.evaluate(() => { window.updateFixture.permission = true; window.updateFixture.onReturn(); });
    await waitMessage("安装权限已就绪");
    assert.equal((await fixtureCounts()).installs, permissionCounts.installs, "granting permission must not automatically start installation");

    await page.evaluate(() => { window.updateFixture.result = { started: false }; });
    await button.click();
    await waitMessage("系统安装器未打开");
    await page.evaluate(() => { window.updateFixture.result = { started: true }; window.updateFixture.earlyReturn = true; });
    await button.click();
    await waitMessage("本次安装尚未完成");
    assert.equal(await button.textContent(), "立即更新", "a native return that precedes the bridge result must not be lost");

    await page.evaluate(() => { window.updateFixture.earlyReturn = false; });
    await button.click();
    await waitButton("检查安装结果");
    await page.evaluate(() => { window.updateFixture.failVersion = true; window.updateFixture.onReturn(); });
    await waitMessage("安装状态读取失败");
    const beforeVersionRetry = await fixtureCounts();
    await page.evaluate((versionCode) => { window.updateFixture.failVersion = false; window.updateFixture.versionCode = versionCode; }, latestCode);
    await button.click();
    await waitMessage("更新已安装完成");
    await waitButton("检查更新");
    assert.equal((await fixtureCounts()).installs, beforeVersionRetry.installs, "retrying a package-state read must not download an already installed update");

    manifestFailure = true;
    await button.click();
    await waitMessage("更新检查失败");
    await waitButton("重新检查");
    manifestFailure = false;
    await button.click();
    await waitButton("检查更新");

    latestCode = initialCode + 20;
    holdNextManifest = true;
    const stalePending = new Promise((resolve) => { markManifestPending = resolve; });
    await button.click();
    await stalePending;
    latestCode = initialCode + 3;
    await page.locator("#serverUrl").fill("http://updates-new.test");
    await page.locator("#connectForm button[type='submit']").click();
    await waitButton("立即更新");
    releaseManifest();
    await page.waitForTimeout(100);
    assert.match(await page.locator("#appLatestVersion").textContent(), new RegExp(String(latestCode)), "a late result from a previous update check must not overwrite the refreshed result");
    assert(requests.every((url) => ["http://192.168.31.86:29998", "http://xc213618.ddns.me:29998"].includes(new URL(url).origin)), "changing the saved content server must not override either default update address");
    assert.equal(await page.locator("#appUpdateSources li").count(), 2, "repeated checks must not duplicate the visible update-source list");
    assert.deepEqual(errors, [], "the updater lifecycle must not raise unhandled page errors");
  } finally {
    releaseManifest?.();
    await page.close();
  }
}

async function verifyAndroidStartupSurface(browser) {
  const cases = [
    { saved: { view: "tools", params: {} }, view: "tools", bottom: "tools", label: "我的", message: "正在准备我的页面", theme: "light" },
    { saved: { view: "channel", params: { mode: "manga" } }, view: "channel", bottom: "photo", label: "韩漫", message: "正在打开漫画书库", theme: "dark" },
    { saved: { view: "channel", params: { mode: "photo", photoView: "collections" } }, view: "channel", bottom: "photo", label: "套图", message: "正在打开套图", theme: "light" },
    { saved: { view: "channel", params: { mode: "manga" } }, hash: "#people?scope=western", view: "people", bottom: "fanhao", label: "欧美", message: "正在打开欧美人物", theme: "dark" },
    { saved: null, view: "people", bottom: "fanhao", label: "番号", message: "正在打开番号人物", theme: "light" }
  ];
  for (const scenario of cases) {
    const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseScript;
    let releaseCatalog;
    let releaseLibrary;
    const scriptGate = new Promise((resolve) => { releaseScript = resolve; });
    const catalogGate = new Promise((resolve) => { releaseCatalog = resolve; });
    const libraryGate = new Promise((resolve) => { releaseLibrary = resolve; });
    let markCatalog;
    let markLibrary;
    const catalogRequested = new Promise((resolve) => { markCatalog = resolve; });
    const libraryRequested = new Promise((resolve) => { markLibrary = resolve; });
    try {
      await page.addInitScript(({ saved, theme }) => {
        localStorage.clear();
        localStorage.setItem("fanhao.serverUrl", location.origin);
        localStorage.setItem("fanhao.theme", theme);
        localStorage.setItem("fanhao.android.readingMode.v1", "music");
        if (saved) localStorage.setItem("fanhao.android.lastView", JSON.stringify(saved));
      }, scenario);
      await page.route((url) => url.pathname === "/android-client/app.js", async (route) => {
        await scriptGate;
        await route.continue();
      });
      await page.route((url) => url.pathname === "/api/modules", async (route) => {
        markCatalog();
        await catalogGate;
        await route.continue();
      });
      await page.route((url) => url.pathname === "/api/library", async (route) => {
        markLibrary();
        await libraryGate;
        await route.continue();
      });
      await page.goto(`${baseUrl}/android-client/index.html${scenario.hash || ""}`, { waitUntil: "commit" });
      await page.locator("#appStartup").waitFor({ state: "visible", timeout: 5000 });
      assert.equal(await page.locator(".app-shell").isVisible(), false, "static HTML must not expose the old homepage before the application script loads");
      assert.equal(await page.locator(".bottom-nav").isVisible(), false, "the uninitialized default navigation must not be exposed to sighted or keyboard users");
      releaseScript();
      await Promise.race([catalogRequested, page.waitForTimeout(10000).then(() => { throw new Error("Android startup did not request its catalog"); })]);
      assert.equal(await page.locator("#appStartupMessage").textContent(), scenario.message, "startup feedback must describe the restored route, with deep links taking precedence");
      assert.equal(await page.locator("html").getAttribute("data-theme"), scenario.theme, "the startup surface must use the selected application theme");
      await Promise.race([libraryRequested, page.waitForTimeout(10000).then(() => { throw new Error("Android startup did not request its library"); })]);
      await page.locator("#appStartup").waitFor({ state: "hidden", timeout: 5000 });
      assert.equal(await page.locator(".bottom-nav").isVisible(), true, "bundled navigation must be ready before either remote startup dependency resolves");
      const currentNav = page.locator(".bottom-nav > button[aria-current='page']");
      assert.equal(await currentNav.count(), 1, "exactly one navigation destination must be selected on the first revealed route");
      assert.equal(await currentNav.getAttribute("data-bottom-key"), scenario.bottom);
      assert.equal(await currentNav.locator(".bottom-nav-label").textContent(), scenario.label);
      assert.equal(await page.locator(".bottom-nav [data-reading-switcher] .bottom-nav-label").textContent(), "音乐", "inactive navigation labels must also restore their saved selection before appearing");
      assert.equal(await page.locator("#contentPanel").getAttribute("data-view"), scenario.view);
      for (const selector of [".library-channel-strip", ".quick-strip", "#statusCard", "#omniSection"]) {
        assert.equal(await page.locator(selector).isVisible(), false, `${selector} must stay hidden after the initial route is revealed`);
      }
      if (scenario.view === "people" && !scenario.hash) {
        assert.equal(await page.locator(".route-loading").isVisible(), true, "uncached main people must show loading, not a false empty library");
      }
      if (scenario.view === "tools") {
        await page.evaluate(() => { window.startupToolsNode = document.querySelector(".tools-profile-header"); });
      }
      releaseCatalog();
      releaseLibrary();
      await page.waitForFunction(() => document.querySelector("#statusText")?.textContent === "已连接");
      if (scenario.view === "tools") {
        assert.equal(await page.evaluate(() => window.startupToolsNode === document.querySelector(".tools-profile-header")), true, "successful background bootstrap must not replace the active local tools DOM");
      }
      assert.deepEqual(errors, [], `startup ${scenario.label} must not raise page errors`);
    } finally {
      releaseScript();
      releaseCatalog();
      releaseLibrary();
      await page.close();
    }
  }

  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  let failNavigationOnce = true;
  try {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
    });
    await page.route((url) => url.pathname === "/android-client/js/module-navigation.js", async (route) => {
      if (!failNavigationOnce) return route.continue();
      failNavigationOnce = false;
      const response = await route.fetch();
      const original = await response.text();
      const patched = original.replace("export function renderAndroidModuleNavigation(container, modules) {", 'export function renderAndroidModuleNavigation(container, modules) { throw new Error("fixture startup failure");');
      assert.notEqual(patched, original, "the failure fixture must exercise the real bootstrap error boundary");
      await route.fulfill({ response, body: patched });
    });
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#appStartupRetry").waitFor({ state: "visible", timeout: 10000 });
    assert.match(await page.locator("#appStartupMessage").textContent(), /启动失败.*fixture startup failure/);
    assert.equal(await page.locator(".app-startup-spinner").isVisible(), false, "a failed bootstrap must not keep showing an indefinite spinner");
    assert.equal(await page.locator(".app-shell").isVisible(), false, "a failed bootstrap must not expose unusable navigation");
    await page.locator("#appStartupRetry").click();
    await page.locator(".fanhao-primary-nav").waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await page.locator("#appStartup").isVisible(), false, "retrying startup must recover without a permanent overlay");
  } finally {
    await page.close();
  }
}

async function verifyAndroidOfflineStartup(browser) {
  for (const saved of [
    { view: "tools", params: {} },
    { view: "channel", params: { mode: "manga" } },
    { view: "channel", params: { mode: "photo", photoView: "collections" } }
  ]) {
    const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.addInitScript((saved) => {
        localStorage.clear();
        localStorage.setItem("fanhao.serverUrl", location.origin);
        localStorage.setItem("fanhao.android.lastView", JSON.stringify(saved));
      }, saved);
      await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture server unavailable" })
      }));
      await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
      await page.locator("#appStartup").waitFor({ state: "hidden", timeout: 5000 });
      await page.waitForFunction(() => document.querySelector("#statusText")?.textContent.includes("连接失败"));
      assert.equal(await page.locator("#contentPanel").getAttribute("data-view"), saved.view, "an unavailable uncached library must not redirect the restored route to the legacy home");
      assert.equal(await page.locator("#settingsOverlay").isVisible(), false, "connection failure must not force a settings sheet over the user's route");
      assert.equal(await page.locator(".bottom-nav").isVisible(), true);
      await page.locator(".bottom-nav [data-module-id='tools']").click();
      await page.locator(".tools-profile-header").waitFor({ state: "visible", timeout: 5000 });
      await page.locator(".tools-settings-section button").first().click();
      await page.locator("#settingsOverlay").waitFor({ state: "visible" });
      await page.locator("[data-theme-choice='dark']").click();
      assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "local settings must be usable while every API is unavailable");
      await page.locator("#settingsCloseButton").click();
      await page.locator("#settingsOverlay").waitFor({ state: "hidden" });
      assert.deepEqual(errors, [], `offline ${saved.params.mode || saved.view} must not raise unhandled errors`);
    } finally {
      await page.close();
    }
  }

  const retryPage = await browser.newPage({ viewport: { width: 412, height: 820 } });
  let libraryRequests = 0;
  let offlineCacheMode = false;
  let releaseRetry;
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  try {
    await retryPage.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
    });
    await retryPage.route((url) => url.pathname === "/api/library" && !url.search, async (route) => {
      libraryRequests += 1;
      if (libraryRequests === 1 || offlineCacheMode) return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture library offline"}' });
      await retryGate;
      await route.continue();
    });
    await retryPage.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    const retry = retryPage.getByRole("button", { name: "重新连接", exact: true });
    await retry.waitFor({ state: "visible", timeout: 5000 });
    fs.mkdirSync(path.join(root, ".codex-artifacts"), { recursive: true });
    await retryPage.screenshot({ path: path.join(root, ".codex-artifacts", "228-offline-startup-fixture.png") });
    assert.equal(await retryPage.locator("#contentPanel").getAttribute("data-view"), "people");
    await retry.evaluate((button) => { button.click(); button.click(); });
    await retryPage.locator(".route-loading").waitFor({ state: "visible" });
    await retryPage.waitForTimeout(80);
    assert.equal(libraryRequests, 2, "repeated retry taps must share one library request");
    releaseRetry();
    await retryPage.locator(".people-grid .index-person-card").first().waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await retryPage.locator("#settingsOverlay").isVisible(), false);
    await retryPage.waitForFunction(async () => {
      const { readCachedJson } = await import("/android-client/js/cache.js");
      return Boolean((await readCachedJson(location.origin, "/api/library"))?.payload?.people?.length);
    });
    offlineCacheMode = true;
    await retryPage.reload({ waitUntil: "domcontentloaded" });
    await retryPage.locator(".people-grid .index-person-card").first().waitFor({ state: "visible", timeout: 5000 });
    await retryPage.waitForFunction(() => document.querySelector("#statusText")?.textContent.includes("继续显示本地缓存"));
    assert.equal(await retryPage.locator("#settingsOverlay").isVisible(), false, "a cached offline cold start must keep the library and navigation usable");
    assert.equal(await retryPage.locator(".library-connection-state").count(), 0, "available cached people must not be replaced with an uncached failure state");
  } finally {
    releaseRetry();
    await retryPage.close();
  }

  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releaseOld;
  let markOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const oldRequested = new Promise((resolve) => { markOld = resolve; });
  try {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
      localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "tools", params: {} }));
    });
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/library" && !url.search && url.origin === baseUrl) {
        markOld();
        await oldGate;
      }
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
      const payload = await fixtureApi(url);
      if (url.pathname === "/api/library" && url.origin !== baseUrl) {
        payload.people[0].name = "新服务人物";
        payload.people[0].actorProfile.displayName = "新服务人物";
      }
      await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(payload) });
    });
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    await oldRequested;
    await page.locator(".tools-profile-header").waitFor({ state: "visible", timeout: 5000 });
    await page.evaluate(() => { window.startupToolsNode = document.querySelector(".tools-profile-header"); });
    await page.locator(".tools-settings-section button").first().click();
    const nextBase = baseUrl.replace("127.0.0.1", "localhost");
    await page.locator("#serverUrl").fill(nextBase);
    await page.locator("#connectForm").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("#statusText")?.textContent === "已连接");
    await page.locator("#settingsCloseButton").click();
    await page.locator("#settingsOverlay").waitFor({ state: "hidden" });
    await page.evaluate(() => { window.startupToolsNode = document.querySelector(".tools-profile-header"); });
    releaseOld();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.startupToolsNode === document.querySelector(".tools-profile-header")), true, "late background library completion must not rebuild an active local tool");
    await page.locator(".bottom-nav [data-home-switcher]").click();
    await page.locator(".people-grid").waitFor({ state: "visible", timeout: 5000 });
    assert.match(await page.locator(".people-grid").textContent(), /新服务人物/, "late old-source library results must not overwrite the current service");
    assert.doesNotMatch(await page.locator(".people-grid").textContent(), /测试女优/);
    assert.deepEqual(errors, [], "source changes during background bootstrap must not raise unhandled errors");
  } finally {
    releaseOld();
    await page.close();
  }
}

async function verifyAndroidReconnectFlow(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let mode = "offline";
  let libraryRequests = 0;
  const libraryRequestOrigins = [];
  let mangaRequests = 0;
  let releaseLibrary;
  let heldLibrary = null;
  const comic = { id: "reconnect-comic", title: "重连后的漫画", site: "fixture", chapterCount: 1, doneChapterCount: 1, imageCount: 2, chapters: [] };
  try {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
      localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "channel", params: { mode: "manga" } }));
    });
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const url = new URL(route.request().url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const libraryRequest = url.pathname === "/api/library";
      const mangaRequest = url.pathname === "/api/image-library/items";
      if (libraryRequest) {
        libraryRequests += 1;
        libraryRequestOrigins.push(url.origin);
      }
      if (mangaRequest) mangaRequests += 1;
      if (mode === "offline" && (libraryRequest || mangaRequest)) {
        return route.fulfill({ status: 503, headers, contentType: "application/json", body: '{"error":"fixture backend stopped"}' });
      }
      const payload = libraryRequest && mode === "malformed" ? { ok: true }
        : mangaRequest ? { mode: "manga", items: [comic], total: 1 }
        : url.pathname === "/api/manga/jobs" ? { jobs: [] }
        : await fixtureApi(url);
      if (libraryRequest && heldLibrary) await heldLibrary;
      await route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    await page.locator(".manga-connection-failure").waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(() => document.querySelector("#statusText")?.textContent.includes("连接失败"));
    await page.evaluate(() => document.querySelector("#profileSettingsButton").click());
    const connect = page.locator("#connectServerButton");
    await connect.waitFor({ state: "visible" });
    assert.deepEqual(await page.locator(".server-list [data-url]").evaluateAll((buttons) => buttons.map((button) => ({ url: button.dataset.url, label: button.textContent }))), [
      { url: "http://192.168.31.86:29998", label: "192.168.31.86" },
      { url: "http://xc213618.ddns.me:29998", label: "xc213618.ddns.me" }
    ], "the content-service section must show exactly the requested LAN and DDNS presets, not the obsolete private addresses");
    fs.mkdirSync(path.join(root, ".codex-artifacts"), { recursive: true });
    await page.locator(".settings-connection-group").screenshot({ path: path.join(root, ".codex-artifacts", "android-content-server-defaults.png") });
    const initialLibraryRequests = libraryRequests;
    const initialMangaRequests = mangaRequests;
    mode = "online";
    heldLibrary = new Promise((resolve) => { releaseLibrary = resolve; });
    await page.locator("#serverUrl").fill(new URL(baseUrl).host);
    await page.locator("#connectForm").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
    await page.waitForFunction(() => document.querySelector("#connectServerButton")?.textContent === "连接中");
    assert.equal(await connect.isDisabled(), true, "same-source connection must disable its duplicate action while in flight");
    assert.equal(await page.locator("#connectForm").getAttribute("aria-busy"), "true");
    await page.locator(".channel-card.manga").waitFor({ state: "attached", timeout: 5000 });
    await page.waitForTimeout(80);
    assert.equal(libraryRequests, initialLibraryRequests + 1, "submitting the unchanged address must actually reconnect exactly once");
    assert.equal(mangaRequests, initialMangaRequests + 1, "same-address reconnect must refresh the failed independent manga route exactly once");
    assert.equal(await page.locator("#serverUrl").inputValue(), baseUrl, "a scheme-less host:port must normalize and connect instead of being blocked by native URL validation");
    await page.evaluate(() => { window.reconnectedMangaCard = document.querySelector(".channel-card.manga"); });
    releaseLibrary();
    heldLibrary = null;
    await page.waitForFunction(() => !document.querySelector("#connectServerButton")?.disabled && document.querySelector("#statusText")?.textContent === "已连接");
    assert.equal(await page.evaluate(() => window.reconnectedMangaCard === document.querySelector(".channel-card.manga")), true, "library completion must not replace the refreshed independent route again");
    assert.equal(mangaRequests, initialMangaRequests + 1);

    mode = "offline";
    const quick = page.locator(".server-list [data-url]").first();
    await quick.evaluate((button) => { button.dataset.url = location.origin; });
    await quick.click();
    await page.waitForFunction(() => !document.querySelector("#connectServerButton")?.disabled && document.querySelector("#statusText")?.textContent.includes("继续显示本地缓存"));
    assert.equal(libraryRequests, initialLibraryRequests + 2, "selecting the current quick address must reconnect as well");
    assert.equal(await page.locator(".channel-card.manga").count(), 1, "failed reconnect must preserve usable cached content");

    await page.evaluate(async () => {
      const { clearCachedResponses } = await import("/android-client/js/cache.js");
      await clearCachedResponses(location.origin);
    });
    await quick.click();
    await page.waitForFunction(() => !document.querySelector("#connectServerButton")?.disabled && document.querySelector("#statusText")?.textContent.includes("继续显示已加载内容"));
    await page.locator("#settingsCloseButton").click();
    await page.locator("#settingsOverlay").waitFor({ state: "hidden" });
    await page.locator(".bottom-nav [data-home-switcher]").click();
    await page.locator(".people-grid .index-person-card").first().waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await page.locator(".library-connection-state").count(), 0, "failed reconnect must not discard in-memory people when disk cache was cleared");
    await page.evaluate(() => document.querySelector("#profileSettingsButton").click());
    await connect.waitFor({ state: "visible" });

    mode = "malformed";
    await page.locator("#serverUrl").fill("http://wrong-service.local:29998");
    await connect.click();
    await page.waitForFunction(() => !document.querySelector("#connectServerButton")?.disabled && document.querySelector("#statusText")?.textContent.includes("未返回有效资料库"));
    assert.equal(await page.locator("#statusText").getAttribute("class"), "status-text error");
    const invalidCached = await page.evaluate(async () => {
      const { readCachedJson } = await import("/android-client/js/cache.js");
      return await readCachedJson("http://wrong-service.local:29998", "/api/library");
    });
    assert.equal(invalidCached, null, "an arbitrary 200 OK payload must not be cached or reported as a valid library");
    const requestsBeforeInvalidInput = libraryRequests;
    await page.locator("#serverUrl").fill("ftp://wrong-service.local:29998");
    await connect.click();
    assert.match(await page.locator("#statusText").textContent(), /地址格式不对/);
    assert.equal(await page.evaluate(() => localStorage.getItem("fanhao.serverUrl")), "http://wrong-service.local:29998", "invalid input must leave the configured address untouched");
    assert.equal(libraryRequests, requestsBeforeInvalidInput);
    mode = "online";
    const domainPreset = page.locator('.server-list [data-url="http://xc213618.ddns.me:29998"]');
    await domainPreset.click();
    await page.waitForFunction(() => !document.querySelector("#connectServerButton")?.disabled && document.querySelector("#statusText")?.textContent === "已连接");
    assert.equal(await page.locator("#serverUrl").inputValue(), "http://xc213618.ddns.me:29998", "the domain preset must fill the content-service input");
    assert.equal(await page.evaluate(() => localStorage.getItem("fanhao.serverUrl")), "http://xc213618.ddns.me:29998", "the domain preset must persist as the selected content service");
    assert.equal(libraryRequestOrigins.at(-1), "http://xc213618.ddns.me:29998", "selecting the domain preset must send content requests to that domain");
    assert.equal(await domainPreset.getAttribute("aria-pressed"), "true");
    assert.deepEqual(errors, [], "reconnection flow must not produce unhandled errors");
  } finally {
    releaseLibrary?.();
    await page.close();
  }
}

async function verifyAndroidPersonFirstLibraries(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 }, hasTouch: true, isMobile: true });
  const touchSession = await page.context().newCDPSession(page);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error?.message || String(error)));
  async function longPressChoice(button, choice) {
    const box = await button.boundingBox();
    assert(box, "the switcher must be visible before the touch gesture");
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    try {
      await choice.waitFor({ state: "visible", timeout: 5000 });
    } finally {
      await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await choice.click();
  }
  try {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
    });
    fixturePersonDetailRequests.length = 0;
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    const primaryNav = page.locator(".fanhao-primary-nav");
    await primaryNav.waitFor({ state: "visible", timeout: 10000 }).catch(() => {
      assert.fail(`Android person-first fixture did not boot: ${pageErrors.join(" | ")}`);
    });
    assert.deepEqual(await primaryNav.locator("button").allTextContents(), ["人物", "番号", "排行"], "FanHao must expose only person, number, and ranking browsing modes");
    assert.equal(await primaryNav.locator("button.active").textContent(), "人物", "FanHao must open on people instead of an undifferentiated work feed");
    await page.locator(".index-person-card", { hasText: "测试女优" }).waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await page.locator(".people-category-strip button", { hasText: "欧美" }).count(), 0, "the FanHao people page must not duplicate the independent western library");

    await page.locator(".index-person-card", { hasText: "测试女优" }).click();
    await page.locator(".person-detail-hero").waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await page.locator(".person-category-strip").count(), 0, "person details must not restore FanHao/western/FC2/anime partition chips");
    assert.equal(new URL(fixturePersonDetailRequests.at(-1), baseUrl).searchParams.get("scope"), "main", "FanHao person details must retain the main scope");
    await page.locator(".fanhao-detail-chrome-back").click();
    await page.locator(".index-person-card", { hasText: "测试女优" }).waitFor({ state: "visible", timeout: 5000 });

    const homeSwitcher = page.locator("button[data-home-switcher]");
    await homeSwitcher.click();
    assert.equal(await homeSwitcher.locator(".bottom-nav-label").textContent(), "番号", "ordinary home clicks must return to the current category without switching it");
    await page.locator(".index-person-card", { hasText: "测试女优" }).waitFor({ state: "visible", timeout: 5000 });
    await longPressChoice(homeSwitcher, page.locator('[data-home-mode-choice="western"]'));
    await page.locator("button[data-home-switcher] .bottom-nav-label", { hasText: "欧美" }).waitFor({ state: "visible", timeout: 5000 });
    assert.deepEqual(await primaryNav.locator("button").allTextContents(), ["人物", "作品"], "western must expose person-first browsing with an optional work view");
    assert.equal(await primaryNav.locator("button.active").textContent(), "人物", "western must open on people");
    await page.locator(".index-person-card", { hasText: "Western Star" }).waitFor({ state: "visible", timeout: 5000 });
    await page.locator(".index-person-card", { hasText: "Western Star" }).click();
    await page.locator(".person-detail-hero").waitFor({ state: "visible", timeout: 5000 });
    assert.equal(new URL(fixturePersonDetailRequests.at(-1), baseUrl).searchParams.get("scope"), "western", "western person details must retain the western scope");
    await page.locator(".fanhao-detail-chrome-back").click();
    await page.locator(".index-person-card", { hasText: "Western Star" }).waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(() => !document.body.classList.contains("fanhao-person-detail-view"), null, { timeout: 5000 });

    const readingSwitcher = page.locator("button[data-reading-switcher]");
    await readingSwitcher.waitFor({ state: "visible", timeout: 5000 });
    await readingSwitcher.click();
    await readingSwitcher.locator(".bottom-nav-label", { hasText: "小说" }).waitFor({ state: "visible", timeout: 5000 });
    await readingSwitcher.click();
    assert.equal(await readingSwitcher.locator(".bottom-nav-label").textContent(), "小说", "ordinary reading clicks must retain the selected reading category");
    await longPressChoice(readingSwitcher, page.locator('[data-reading-mode-choice="music"]'));
    await readingSwitcher.locator(".bottom-nav-label", { hasText: "音乐" }).waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await readingSwitcher.getAttribute("aria-current"), "page", "music must keep the shared reading destination selected");
    assert.deepEqual(pageErrors, [], "person-first category gestures must not produce script errors");
  } finally {
    await touchSession.detach();
    await page.close();
  }
}

async function verifyAndroidPhotoCatalog(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  const errors = [];
  const requests = [];
  let adminRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  const collections = [
    { id: "many", title: "A 最多", albumCount: 214, size: 300, updatedAt: "2026-01-01" },
    { id: "large", title: "B 最大", albumCount: 153, size: 400, updatedAt: "2026-02-01" },
    { id: "new", title: "C 最近", albumCount: 92, size: 200, updatedAt: "2026-03-01" }
  ].map((item, index) => ({ ...item, type: "photoCollection", collectionId: item.id, category: "我喜欢的", coverUrl: index < 2 ? `/photo-catalog-cover-${index}.svg` : "" }));
  const lazyCollections = Array.from({ length: 12 }, (_, index) => ({
    id: `lazy-${index}`, collectionId: `lazy-${index}`, type: "photoCollection", category: "新增分类",
    title: `懒加载${index}`, albumCount: 20 - index, coverUrl: `/photo-catalog-cover-lazy-${index}.svg`
  }));
  let releaseCovers;
  const coversReady = new Promise((resolve) => { releaseCovers = resolve; });
  try {
    await page.route("**/photo-catalog-cover-*.svg", async (route) => {
      await coversReady;
      const wide = route.request().url().includes("cover-0");
      await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${wide ? 1200 : 300}" height="${wide ? 400 : 1600}"><rect width="100%" height="100%" fill="#527ba3"/></svg>` });
    });
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
      localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "channel", params: { mode: "photo", photoView: "collections", category: "我喜欢的" } }));
    });
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/admin/")) adminRequests += 1;
      if (url.pathname === "/api/photo-sets/photo-issue") return route.fulfill({ json: { album: {
        id: "photo-issue", title: "本合集第一期", category: "我喜欢的", imageCount: 0, images: []
      } } });
      if (url.pathname !== "/api/image-library/items") return route.fulfill({ json: await fixtureApi(url) });
      requests.push(url);
      const collection = url.searchParams.get("collection") || "";
      const category = url.searchParams.get("category") || "all";
      const selected = collections.find((item) => item.id === collection);
      const items = collection
        ? [{ id: "photo-issue", type: "photo", title: "本合集第一期", category, size: 10, coverUrl: "/photo-catalog-cover-0.svg" }]
        : [{ id: "outer-directory", type: "photoCollectionCategory", title: "T:/ 我喜欢的", category, collections: category === "新增分类" ? lazyCollections : collections }];
      await route.fulfill({ json: {
        mode: "photo", photoView: collection ? "albums" : "collections", collection, category,
        sort: url.searchParams.get("sort"), items, total: items.length,
        collectionSummary: selected ? { ...selected, count: 1 } : null,
        scannedAt: "2026-08-30T00:00:00Z", facets: { people: [], categories: [{ value: "新增分类", count: 12 }] }
      } });
    });
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    const cards = page.locator(".photo-catalog-grid .channel-summary > strong");
    await cards.first().waitFor({ state: "visible", timeout: 10000 });
    assert.deepEqual(await cards.allTextContents(), ["A 最多", "B 最大", "C 最近"], "the category must show real collections ordered by issue count, not its outer directory");
    assert.equal(requests[0].searchParams.get("sort"), "count", "restored legacy photo roots must adopt the Web default sort");
    assert.equal(await page.locator(".photo-mode-row, .photo-index-manager, .photo-filter-wrap").count(), 0, "catalog browsing must not duplicate navigation, maintenance or an empty people filter");
    assert.doesNotMatch(await page.locator("#viewMeta").textContent(), /索引|缓存|更新/);
    assert.match(await page.locator("#viewMeta").textContent(), /3 \/ 3 合集/, "catalog totals must count child collections");
    assert.equal(await page.locator(".photo-chrome-tabs [aria-current='page']").textContent(), "我喜欢的");
    const chromeStyle = await page.locator(".photo-chrome-tabs .active").evaluate((button) => ({
      size: getComputedStyle(button).fontSize,
      underline: getComputedStyle(button, "::after").height,
      fill: getComputedStyle(button).backgroundColor
    }));
    assert.deepEqual(chromeStyle, { size: "16px", underline: "3px", fill: "rgba(0, 0, 0, 0)" }, "photo tabs must share the FanHao text-and-underline style");
    const geometry = await page.locator(".photo-feed-appbar").evaluate((bar) => {
      const nav = bar.querySelector("nav").getBoundingClientRect();
      const actions = bar.querySelector(".fanhao-feed-appbar-actions").getBoundingClientRect();
      return { overlaps: nav.right > actions.left, overflows: bar.getBoundingClientRect().right > innerWidth };
    });
    assert.deepEqual(geometry, { overlaps: false, overflows: false }, "categories must not overlap fixed sort and search actions");
    const coverGeometry = () => page.locator(".photo-collection-card").evaluateAll((cards) => cards.map((card) => {
      const cover = card.firstElementChild.getBoundingClientRect();
      const title = card.querySelector(".channel-summary").getBoundingClientRect();
      return { width: cover.width, height: cover.height, titleTop: title.top };
    }));
    const beforeCovers = await coverGeometry();
    releaseCovers();
    await page.waitForFunction(() => document.querySelectorAll(".photo-collection-card img").length === 2);
    const afterCovers = await coverGeometry();
    assert.deepEqual(afterCovers, beforeCovers, "landscape and tall covers must not resize collection cards or move their titles after loading");
    assert.ok(afterCovers.every(({ width, height }) => Math.abs(height - width * 4 / 3) < 1), "loaded and missing covers must share the same 3:4 frame");
    assert.equal(afterCovers[0].titleTop, afterCovers[1].titleTop, "titles in the same collection row must align");
    for (const [label, order] of [["最近更新", ["C 最近", "B 最大", "A 最多"]], ["容量最大", ["B 最大", "A 最多", "C 最近"]], ["名称排序", ["A 最多", "B 最大", "C 最近"]]]) {
      await page.locator(".photo-sort-action").click();
      await page.getByRole("dialog", { name: "套图排序" }).getByRole("button", { name: label, exact: true }).click();
      await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll(".photo-catalog-grid .channel-summary > strong")].map((node) => node.textContent)) === JSON.stringify(expected), order);
      await page.waitForFunction(() => document.querySelectorAll(".photo-collection-card img").length === 2);
      assert.ok((await coverGeometry()).every(({ width, height }) => Math.abs(height - width * 4 / 3) < 1), "cached covers must retain their frame after sorting");
    }
    await page.locator(".photo-collection-card").first().click();
    await page.locator(".photo-masonry-list").waitFor({ state: "visible" });
    await page.locator(".photo-masonry-list img").waitFor({ state: "visible" });
    const albumCover = await page.locator(".photo-masonry-list img").boundingBox();
    assert.ok(Math.abs(albumCover.height - albumCover.width / 3) < 1, "album masonry must retain its source aspect ratio instead of being cropped like collection covers");
    assert.equal(requests.at(-1).searchParams.get("collection"), "many", "collection clicks must request the actual child id");
    assert.equal(requests.at(-1).searchParams.get("category"), "我喜欢的", "opening a collection must preserve its category");
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true, "system Back must handle the first collection visit instead of sending Android to the desktop");
    await cards.first().waitFor({ state: "visible" });
    assert.match(await page.locator(".photo-sort-action").getAttribute("aria-label"), /名称排序/, "system Back must restore the parent catalog sort");
    await page.locator(".photo-collection-card").first().click();
    await page.locator(".photo-masonry-list").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "返回分类", exact: true }).click();
    await cards.first().waitFor({ state: "visible" });
    assert.equal(await page.locator(".photo-chrome-tabs [aria-current='page']").textContent(), "我喜欢的");
    assert.match(await page.locator(".photo-sort-action").getAttribute("aria-label"), /名称排序/, "the explicit return button must restore the same parent as system Back");
    await page.locator(".photo-collection-card").first().click();
    await page.locator(".photo-masonry-list .channel-card").first().click();
    await page.locator(".photo-detail-summary").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await page.locator(".photo-masonry-list").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true, "returning from a detail must not trap Back in duplicate collection history entries");
    await cards.first().waitFor({ state: "visible" });
    assert.match(await page.locator(".photo-sort-action").getAttribute("aria-label"), /名称排序/);
    await page.locator(".photo-chrome-tabs").getByRole("button", { name: "新增分类", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".photo-chrome-tabs [aria-current='page']")?.textContent === "新增分类");
    await cards.filter({ hasText: "懒加载0" }).waitFor({ state: "visible" });
    assert.equal(requests.at(-1).searchParams.get("category"), "新增分类", "server categories must remain reachable through the top navigation");
    assert.equal(requests.at(-1).searchParams.get("collection"), null);
    assert.equal(requests.at(-1).searchParams.get("sort"), "count");
    const lazyCard = page.locator(".photo-collection-card").last();
    assert.equal(await lazyCard.locator("img").count(), 0, "offscreen collection covers must remain lazy");
    const placeholderFrame = await lazyCard.locator(".photo-collection-cover").boundingBox();
    await lazyCard.scrollIntoViewIfNeeded();
    await lazyCard.locator("img").waitFor({ state: "visible" });
    const loadedFrame = await lazyCard.locator(".photo-collection-cover").boundingBox();
    assert.deepEqual({ width: loadedFrame.width, height: loadedFrame.height }, { width: placeholderFrame.width, height: placeholderFrame.height }, "lazy-loaded covers must not change their frame dimensions");
    const parentScrollY = await page.evaluate(() => window.scrollY);
    await lazyCard.click({ position: { x: 20, y: 20 } });
    await page.locator(".photo-masonry-list").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await cards.filter({ hasText: "懒加载11" }).waitFor({ state: "visible" });
    await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 3, parentScrollY, { timeout: 3000 });
    await page.addInitScript(() => {
      localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "channel", params: { mode: "photo", photoView: "albums", collection: "many", category: "我喜欢的" } }));
    });
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    await page.locator(".photo-masonry-list").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true, "restored collection routes without a memory stack must return to their category");
    await cards.first().waitFor({ state: "visible" });
    assert.equal(await page.locator(".photo-chrome-tabs [aria-current='page']").textContent(), "我喜欢的");
    await page.locator(".photo-collection-card").first().click();
    await page.locator(".photo-masonry-list").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true, "a second collection visit must behave exactly like the first");
    await cards.first().waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), false, "only the actual photo catalog root may hand Back to Android");
    assert.equal(adminRequests, 0, "photo browsing must not poll index maintenance");
    assert.deepEqual(errors, [], "photo catalog flow must not produce browser errors");
  } finally {
    releaseCovers();
    await page.close();
  }
}

async function verifyAndroidMangaReadingProgress(browser) {
  const mangaId = "reading-progress-fixture";
  const progressKey = "fanhao.android.mangaReadingProgress.v1";
  const resumeKey = "fanhao.android.mangaResumeRequest.v1";
  const chapterPath = `/api/manga/${mangaId}/chapters/1`;
  const comic = { id: mangaId, title: "阅读进度测试", chapters: [{ index: 1, title: "第一话", imageCount: 36, downloadedCount: 36 }] };
  const chapter = {
    index: 1, title: "第一话", imageCount: 36, navigation: { position: 1, total: 1 },
    images: Array.from({ length: 36 }, (_, index) => ({ index: index + 1, url: `/manga-reading-fixture/${index + 1}.svg` }))
  };
  for (const scenario of ["first-page", "quick-return", "pagehide", "visibility-hidden", "deactivate", "abort", "append-more", "real-scroll", "resume-after-error", "resume-late-images", "resume-refreshed-cache", "resume-move-before-refresh", "inline-resume"]) {
    const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
    const errors = [];
    let chapterRequests = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseImages;
    let releaseFresh;
    const imageGate = new Promise((resolve) => { releaseImages = resolve; });
    const freshGate = new Promise((resolve) => { releaseFresh = resolve; });
    const lateImages = scenario === "resume-late-images";
    const refreshedCache = ["resume-refreshed-cache", "resume-move-before-refresh"].includes(scenario);
    try {
      await page.route("**/manga-reading-fixture/*.svg", async (route) => {
        if (lateImages) await imageGate;
        await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000"><rect width="400" height="1000" fill="#526782"/></svg>' });
      });
      await page.route((url) => url.pathname.startsWith("/api/manga/"), async (route) => {
        if (new URL(route.request().url()).pathname === chapterPath) {
          chapterRequests += 1;
          if (scenario === "resume-after-error" && chapterRequests === 1) return route.fulfill({ status: 503, json: { error: "电脑端暂时未连接" } });
          if (refreshedCache) await freshGate;
          await route.fulfill({ json: { comic, chapter: { ...chapter, title: refreshedCache ? "第一话（已更新）" : chapter.title } } });
        } else await route.fulfill({ json: { comic } });
      });
      await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
      await page.addStyleTag({ url: `${baseUrl}/android-client/styles.css` });
      await page.evaluate(async ({ mangaId, chapterPath, comic, chapter, progressKey, resumeKey, scenario }) => {
        const { createChannelViews } = await import("/android-client/platform/content-index/channel-views.js?manga-reading-fixture=1");
        const { writeCachedJson } = await import("/android-client/js/cache.js");
        const observers = [];
        if (scenario !== "real-scroll") window.IntersectionObserver = class {
          constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
          observe(target) { this.targets.add(target); }
          unobserve(target) { this.targets.delete(target); }
          disconnect() { this.targets.clear(); }
        };
        window.emitReadingPage = (position) => {
          for (const observer of observers) {
            const targets = [...observer.targets].filter((target) => target.matches(".manga-reader-page"));
            if (targets.length) observer.callback(targets.map((target) => ({ target, isIntersecting: Number(target.dataset.mangaPagePosition) === position, intersectionRatio: Number(target.dataset.mangaPagePosition) === position ? 1 : 0 })));
          }
        };
        const viewContent = document.getElementById("fixture");
        const viewMeta = document.createElement("div");
        viewMeta.id = "reading-fixture-meta";
        document.body.prepend(viewMeta);
        let limit = 12;
        let views;
        const controller = new AbortController();
        window.readingFixtureController = controller;
        const isActive = () => !controller.signal.aborted;
        isActive.signal = controller.signal;
        window.renderReadingChapter = () => views.renderMangaChapter(mangaId, 1, isActive);
        views = createChannelViews({
          els: { viewContent, viewMeta, viewKicker: document.createElement("div"), viewTitle: document.createElement("div") },
          getActiveUrl: () => location.origin, getChannelLimit: () => 48, increaseChannelLimit() {},
          getMangaImageLimit: () => limit, increaseMangaImageLimit: (amount) => { limit += amount; },
          openInLibrary() {}, setActiveBottom() {},
          showMangaCatalog: () => views.renderMangaDetail(mangaId),
          renderCurrentView: () => window.renderReadingChapter(),
          renderCurrentViewPreservingScroll: () => window.renderReadingChapter()
        });
        window.readingFixtureViews = views;
        if (scenario.startsWith("resume-") || scenario === "inline-resume") {
          localStorage.setItem(progressKey, JSON.stringify({ [mangaId]: { chapterIndex: 1, pageIndex: 25, pageTotal: 36 } }));
          if (scenario !== "inline-resume") sessionStorage.setItem(resumeKey, JSON.stringify({ mangaId, chapterIndex: 1, pageIndex: 25 }));
        }
        if (["resume-refreshed-cache", "resume-move-before-refresh"].includes(scenario)) await writeCachedJson(location.origin, chapterPath, { comic, chapter });
        void window.renderReadingChapter();
      }, { mangaId, chapterPath, comic, chapter, progressKey, resumeKey, scenario });
      if (scenario === "resume-after-error") await page.getByRole("button", { name: "重新读取", exact: true }).click();
      await page.locator(".manga-reader-list").waitFor({ state: "visible" });
      const saved = () => page.evaluate(({ progressKey, mangaId }) => JSON.parse(localStorage.getItem(progressKey) || "{}")[mangaId], { progressKey, mangaId });
      if (scenario === "first-page") {
        await page.evaluate(() => window.emitReadingPage(1));
        await page.waitForFunction(({ progressKey, mangaId }) => JSON.parse(localStorage.getItem(progressKey) || "{}")[mangaId]?.pageIndex === 1, { progressKey, mangaId }, { timeout: 1500 });
      } else if (["quick-return", "pagehide", "visibility-hidden", "deactivate", "abort"].includes(scenario)) {
        await page.evaluate((scenario) => {
          window.emitReadingPage(3);
          if (scenario === "quick-return") document.querySelector(".manga-chapter-position").click();
          if (scenario === "pagehide") window.dispatchEvent(new Event("pagehide"));
          if (scenario === "deactivate") window.readingFixtureViews.deactivate();
          if (scenario === "abort") window.readingFixtureController.abort();
          if (scenario === "visibility-hidden") {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
            document.dispatchEvent(new Event("visibilitychange"));
          }
        }, scenario);
        assert.equal((await saved())?.pageIndex, 3, `${scenario} must flush the pending reading position before the debounce fires`);
        if (scenario === "quick-return") {
          await page.locator(".manga-continue").waitFor({ state: "visible" });
          assert.match(await page.locator(".manga-continue").textContent(), /第 3 张/);
        }
      } else if (scenario === "real-scroll") {
        await page.locator('[data-manga-page-position="3"]').evaluate((target) => target.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.waitForFunction(() => [...document.querySelectorAll(".manga-reader-page img")].slice(0, 3).every((img) => img.complete && img.naturalHeight === 1000));
        await page.locator('[data-manga-page-position="3"]').evaluate((target) => target.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.waitForFunction(() => document.querySelector('[aria-label="本话阅读进度"]')?.getAttribute("aria-valuenow") === "3");
        await page.evaluate((mangaId) => window.readingFixtureViews.renderMangaDetail(mangaId), mangaId);
        assert.equal((await saved())?.pageIndex, 3, "real viewport observation must save the visible page on catalog return");
      } else if (scenario === "append-more") {
        const beforeRequests = chapterRequests;
        const originalCount = await page.locator(".manga-reader-page").count();
        await page.evaluate(() => {
          window.originalReadingPage = document.querySelector(".manga-reader-page");
          window.emitReadingPage(3);
          document.querySelector(".auto-load-trigger button, button.auto-load-trigger").click();
        });
        await page.waitForFunction((count) => document.querySelectorAll(".manga-reader-page").length > count, originalCount);
        assert.equal(await page.evaluate(() => document.querySelector(".manga-reader-page") === window.originalReadingPage), true, "showing more manga pages must append without rebuilding the chapter");
        assert.equal(chapterRequests, beforeRequests, "showing more manga pages must not refetch the chapter");
        await page.evaluate(() => {
          window.emitReadingPage(18);
          window.dispatchEvent(new Event("pagehide"));
        });
        assert.equal((await saved())?.pageIndex, 18, "appended manga pages must participate in reading progress tracking");
      } else {
        if (scenario === "inline-resume") await page.getByRole("button", { name: "回到第 25 张", exact: true }).click();
        const target = page.locator('[data-manga-page-position="25"]');
        await target.waitFor({ state: "attached", timeout: 2000 });
        await page.waitForFunction(() => Math.abs(document.querySelector('[data-manga-page-position="25"]').getBoundingClientRect().top - 60) < 3, null, { timeout: 3000 });
        releaseImages();
        if (lateImages) await page.waitForFunction(() => [...document.querySelectorAll(".manga-reader-page img")].slice(0, 2).every((img) => img.complete && img.naturalHeight === 1000));
        const expectedPage = scenario === "resume-move-before-refresh" ? 24 : 25;
        if (expectedPage === 24) await page.evaluate(() => {
          window.dispatchEvent(new WheelEvent("wheel", { deltaY: -500 }));
          const previous = document.querySelector('[data-manga-page-position="24"]');
          window.scrollBy(0, previous.getBoundingClientRect().top - 60);
          window.emitReadingPage(24);
        });
        releaseFresh();
        if (refreshedCache) await page.waitForFunction(() => document.querySelector(".manga-reader-page img")?.alt.includes("已更新"));
        await page.waitForFunction((position) => Math.abs(document.querySelector(`[data-manga-page-position="${position}"]`).getBoundingClientRect().top - 60) < 3, expectedPage, { timeout: 3000 });
        if (lateImages) {
          await page.evaluate(() => {
            window.dispatchEvent(new WheelEvent("wheel", { deltaY: 500 }));
            window.scrollBy(0, 500);
            document.querySelector(".manga-reader-page").style.minHeight = "1600px";
          });
          await page.waitForTimeout(100);
          assert.ok(Math.abs((await target.boundingBox()).y - 60) > 200, "late image changes must not pull the reader back after user scrolling");
        }
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        assert.equal((await saved())?.pageIndex, expectedPage, `${scenario} must retain the latest reading position`);
      }
      assert.deepEqual(errors, [], `${scenario} must not produce browser errors`);
    } finally {
      releaseImages();
      releaseFresh();
      await page.close();
    }
  }
}

async function verifyAndroidMangaAddLifecycle(browser) {
  const comic = { id: "manga-add-fixture", title: "新增流程测试", chapters: [], chapterCount: 1, imageCount: 3 };
  const chapter = { index: 1, title: "测试章节", navigation: { position: 1, total: 1 }, images: [1, 2, 3].map((index) => ({ index, url: "/fixture-cover.svg" })) };
  for (const scenario of ["complete", "immediate", "reader-start", "reader-poll", "reader-error", "collapse", "failed", "superseded", "catalog-ready"]) {
    const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let job = null;
    let postRequests = 0;
    let chapterRequests = 0;
    let libraryRequests = 0;
    let pollFails = false;
    let releaseStart;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });
    let releaseOldPoll;
    let oldPollHeld = false;
    let markOldPoll;
    const oldPollGate = new Promise((resolve) => { releaseOldPoll = resolve; });
    const oldPollPending = new Promise((resolve) => { markOldPoll = resolve; });
    try {
      await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/manga/add") {
          postRequests += 1;
          job = { id: postRequests === 1 ? "add-fixture-job" : "add-fixture-job-2", comicId: comic.id, comicAvailable: scenario !== "catalog-ready", title: postRequests === 1 ? comic.title : "下一任务测试", kind: "add", status: scenario === "immediate" ? "complete" : "running", startedAt: postRequests === 1 ? "2026-08-30T06:00:00Z" : "2026-08-30T06:02:00Z", totalChapters: 1, completedChapters: 0, progressPercent: 5 };
          const body = JSON.stringify({ job });
          if (scenario === "reader-start") await startGate;
          return route.fulfill({ contentType: "application/json", body });
        }
        if (url.pathname === "/api/manga/jobs") return route.fulfill({ json: { jobs: job ? [job] : [] } });
        if (url.pathname.startsWith("/api/manga/jobs/")) {
          if (scenario === "superseded" && url.pathname === "/api/manga/jobs/add-fixture-job" && !oldPollHeld) {
            oldPollHeld = true;
            const body = JSON.stringify({ job: { ...job, status: "failed", message: "旧任务迟到错误" } });
            markOldPoll();
            await oldPollGate;
            return route.fulfill({ contentType: "application/json", body });
          }
          return route.fulfill(pollFails ? { status: 503, json: { error: "测试轮询断线" } } : { json: { job } });
        }
        if (url.pathname.endsWith("/chapters/1")) {
          chapterRequests += 1;
          return route.fulfill({ json: { comic, chapter } });
        }
        if (url.pathname === "/api/image-library/items") {
          libraryRequests += 1;
          const items = scenario === "catalog-ready" && !job?.comicAvailable ? [] : [comic];
          return route.fulfill({ json: { mode: "manga", items, total: items.length } });
        }
        return route.fulfill({ json: { comic, update: job } });
      });
      await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
      await page.evaluate(async (comicId) => {
        const { createChannelViews } = await import("/android-client/platform/content-index/channel-views.js?manga-add-fixture=1");
        const viewContent = document.getElementById("fixture");
        let mode = "library";
        let views;
        window.renderMangaAddFixture = (nextMode = mode) => {
          mode = nextMode;
          return mode === "reader" ? views.renderMangaChapter(comicId, 1) : views.renderChannel({ mode: "manga" });
        };
        views = createChannelViews({
          els: { viewContent, viewKicker: document.createElement("div"), viewTitle: document.createElement("div"), viewMeta: document.createElement("div") },
          getActiveUrl: () => location.origin, getChannelLimit: () => 48, increaseChannelLimit() {},
          openInLibrary() {}, setActiveBottom() {},
          renderCurrentView: () => window.renderMangaAddFixture(), renderCurrentViewPreservingScroll: () => window.renderMangaAddFixture()
        });
        await window.renderMangaAddFixture();
      }, comic.id);
      await page.getByRole("button", { name: "添加漫画", exact: true }).click();
      await page.locator(".manga-add-form input").fill("https://example.com/book/add-fixture");
      const started = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/manga/add");
      await page.getByRole("button", { name: "开始采集", exact: true }).click();
      await started;
      if (scenario.startsWith("reader-")) {
        if (scenario !== "reader-start") await page.locator(".manga-task-card.is-running").waitFor({ state: "visible" });
        await page.evaluate(async () => {
          await window.renderMangaAddFixture("reader");
          window.addFixtureReader = document.querySelector(".manga-reader-list");
        });
        const originalRequests = chapterRequests;
        if (scenario === "reader-start") {
          const startResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/manga/add");
          releaseStart();
          await startResponse;
        } else {
          const polled = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/manga/jobs/add-fixture-job");
          if (scenario === "reader-error") pollFails = true;
          else job = { ...job, status: "complete", finishedAt: "2026-08-30T06:01:00Z", completedChapters: 1, progressPercent: 100 };
          await polled;
        }
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => window.addFixtureReader === document.querySelector(".manga-reader-list")), true, `${scenario}: background collection work must not rebuild the current reader`);
        assert.equal(chapterRequests, originalRequests, `${scenario}: task responses must not refetch the chapter being read`);
      } else {
        if (scenario !== "immediate") {
          await page.locator(".manga-task-card.is-running").waitFor({ state: "visible" });
          if (scenario === "catalog-ready") {
            assert.equal(await page.locator(".channel-card.manga").count(), 0);
            job = { ...job, comicAvailable: true };
            await page.locator(".channel-card.manga").waitFor({ state: "visible" });
            assert.equal(await page.locator(".manga-task-card.is-running").getByRole("button", { name: "书页", exact: true }).isVisible(), true, "the book and catalog entry must become available before collection finishes");
            const requestsBeforeProgress = libraryRequests;
            const progressPoll = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/manga/jobs/add-fixture-job");
            job = { ...job, progressPercent: 40, completedImages: 2 };
            await progressPoll;
            await page.waitForTimeout(100);
            assert.equal(libraryRequests, requestsBeforeProgress, "ordinary image progress must not refetch the whole library");
          }
          if (scenario === "collapse") {
            await page.getByRole("button", { name: "收起", exact: true }).click();
            assert.equal(await page.locator(".manga-add-form").count(), 0, "an active add form can be collapsed without cancelling its task");
            assert.equal(await page.locator(".manga-task-card.is-running").isVisible(), true);
          }
          if (scenario === "failed") {
            job = { ...job, status: "failed", message: "测试采集失败", finishedAt: "2026-08-30T06:01:00Z" };
            await page.locator(".manga-library-actions .manga-operation-error").waitFor({ state: "visible" });
            assert.equal(await page.locator(".manga-add-form input").inputValue(), "https://example.com/book/add-fixture", "failure must retain the URL for correction or retry");
            await page.getByRole("button", { name: "重新采集", exact: true }).click();
            await page.locator('[data-manga-task-id="add-fixture-job-2"].is-running').waitFor({ state: "visible" });
          }
          if (scenario === "superseded") {
            await Promise.race([oldPollPending, new Promise((_, reject) => setTimeout(() => reject(new Error("old add poll did not start")), 5000))]);
            job = { ...job, status: "complete", finishedAt: "2026-08-30T06:01:00Z", completedChapters: 1, progressPercent: 100 };
            await page.locator(".manga-task-history-toggle").click();
            await page.locator(".manga-task-card.is-complete").waitFor({ state: "visible" });
            await page.getByRole("button", { name: "添加漫画", exact: true }).click();
            await page.locator(".manga-add-form input").fill("https://example.com/book/next-task");
            await page.getByRole("button", { name: "开始采集", exact: true }).click();
            await page.locator('[data-manga-task-id="add-fixture-job-2"].is-running').waitFor({ state: "visible" });
            const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/manga/jobs/add-fixture-job");
            releaseOldPoll();
            await oldResponse;
            await page.waitForTimeout(100);
            assert.equal(await page.locator('[data-manga-task-id="add-fixture-job-2"].is-running').isVisible(), true, "a late response from the preceding task must not replace the new running task");
            assert.doesNotMatch(await page.locator(".manga-library-actions").textContent(), /旧任务迟到错误/);
          }
          job = { ...job, status: "complete", finishedAt: postRequests > 1 ? "2026-08-30T06:03:00Z" : "2026-08-30T06:01:00Z", completedChapters: 1, progressPercent: 100 };
        }
        await page.locator("[data-manga-completion-notice]").waitFor({ state: "visible", timeout: 5000 });
        if (["superseded", "failed"].includes(scenario)) {
          await page.locator("[data-manga-completion-notice]", { hasText: "下一任务测试" }).waitFor({ state: "visible", timeout: 5000 });
        }
        assert.equal(await page.locator(".manga-add-form").count(), 0, "successful collection must close the add form rather than leaving its completed URL and button on screen");
        if (await page.locator(".manga-task-history-toggle").getAttribute("aria-expanded") === "true") await page.locator(".manga-task-history-toggle").click();
        await page.getByRole("button", { name: "添加漫画", exact: true }).click();
        assert.equal(await page.locator(".manga-add-form input").inputValue(), "", "the next add starts with a clean input");
        await page.locator(".manga-add-form input").fill("https://example.com/book/next-draft");
        await page.evaluate(() => { window.nextAddDraftInput = document.querySelector(".manga-add-form input"); });
        await page.locator(".manga-task-history-toggle").click();
        await page.locator(".manga-task-card.is-complete").waitFor({ state: "visible" });
        assert.equal(await page.locator(".manga-add-form input").inputValue(), "https://example.com/book/next-draft", "refreshing completed history must not close or clear a new draft");
        assert.equal(await page.evaluate(() => window.nextAddDraftInput === document.querySelector(".manga-add-form input")), true, "unchanged task history must not replace the draft input node");
      }
      assert.equal(postRequests, ["failed", "superseded"].includes(scenario) ? 2 : 1);
      assert.deepEqual(errors, [], `${scenario} add lifecycle must not produce browser errors`);
    } finally {
      releaseStart();
      releaseOldPoll();
      await page.close();
    }
  }
}

async function verifyAndroidMangaTaskNotices(browser) {
  const comic = {
    id: "manga-notice-fixture", title: "任务提示测试", site: "fixture", sourceUrl: "https://example.com/book/1",
    chapters: [], chapterCount: 1, doneChapterCount: 1, imageCount: 1, downloadedCount: 1, failedCount: 0
  };
  const oldJob = { id: "notice-old", comicId: comic.id, title: comic.title, kind: "add", status: "complete", startedAt: "2026-08-29T00:00:00Z", finishedAt: "2026-08-29T00:01:00Z" };
  for (const initialView of ["library", "switch", "detail", "restored", "idle", "empty", "offline", "failed", "manual-refresh"]) {
    comic.imageCount = 1;
    const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let job = {
      id: `notice-${initialView}`, comicId: comic.id, title: comic.title, kind: "update", status: "running",
      startedAt: "2026-08-30T00:00:00Z", totalChapters: null, cachedChapters: null, completedChapters: 0, progressPercent: 3
    };
    if (["restored", "idle", "empty", "offline", "manual-refresh"].includes(initialView)) job = { ...job, status: "complete", finishedAt: "2026-08-30T00:01:00Z", completedChapters: 1 };
    if (initialView === "failed") job = { ...job, status: "failed", finishedAt: "2026-08-30T00:01:00Z", message: "测试任务下载失败" };
    let jobsUnavailable = false;
    let retryRequests = 0;
    let holdNextList = false;
    let markListPending;
    let releaseList;
    const listPending = new Promise((resolve) => { markListPending = resolve; });
    try {
      await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/manga/jobs" && jobsUnavailable) return route.fulfill({ status: 503, json: { error: "测试连接中断" } });
        if (url.pathname.endsWith("/retry")) {
          retryRequests += 1;
          job = { ...job, id: `${job.id}-retry`, status: "running", finishedAt: "", startedAt: "2026-08-30T00:02:00Z", message: "正在重试" };
          return route.fulfill({ json: { job } });
        }
        const payload = url.pathname === "/api/image-library/items"
          ? { mode: "manga", items: [comic], total: 1 }
          : url.pathname === "/api/manga/jobs"
            ? { jobs: initialView === "empty" ? [] : [job, oldJob] }
            : url.pathname.endsWith("/update") ? { job } : { comic, update: job };
        const body = JSON.stringify(payload);
        if (holdNextList && url.pathname === "/api/manga/jobs") {
          holdNextList = false;
          const gate = new Promise((resolve) => { releaseList = resolve; });
          markListPending();
          await gate;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body });
      });
      await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
      await page.addStyleTag({ url: `${baseUrl}/android-client/styles.css` });
      await page.evaluate(async ({ initialView, comicId }) => {
        const { createChannelViews } = await import("/android-client/platform/content-index/channel-views.js?manga-notice-fixture=1");
        const viewContent = document.getElementById("fixture");
        let currentView = initialView;
        let views;
        window.renderMangaNoticeFixture = async (view = currentView) => {
          currentView = view;
          if (view === "detail") await views.renderMangaDetail(comicId);
          else await views.renderChannel({ mode: "manga" });
        };
        views = createChannelViews({
          els: { viewContent, viewKicker: document.createElement("div"), viewTitle: document.createElement("div"), viewMeta: document.createElement("div") },
          getActiveUrl: () => location.origin,
          getChannelLimit: () => 48,
          increaseChannelLimit() {},
          openInLibrary() {},
          setActiveBottom() {},
          showMangaDetail: () => window.renderMangaNoticeFixture("detail"),
          renderCurrentView: () => window.renderMangaNoticeFixture(),
          renderCurrentViewPreservingScroll: () => window.renderMangaNoticeFixture()
        });
        await window.renderMangaNoticeFixture();
      }, { initialView: initialView === "restored" ? "detail" : initialView === "switch" ? "library" : initialView, comicId: comic.id });
      if (["idle", "empty", "offline", "manual-refresh"].includes(initialView)) {
        const manager = page.locator("[data-manga-task-manager]");
        const history = page.locator(".manga-task-history-toggle");
        await history.click();
        if (initialView === "empty") await page.getByText("暂无下载与更新记录", { exact: true }).waitFor({ state: "visible" });
        else await page.locator(".manga-task-card.is-complete").waitFor({ state: "visible" });
        await history.click();
        assert.equal(await manager.isVisible(), false, "opening an idle library must not leave an empty task panel even when history exists");
        assert.equal(await page.locator("[data-manga-completion-notice]").count(), 0, "history must not replay old completion notices");
        if (initialView === "offline") {
          jobsUnavailable = true;
          await history.click();
          await page.locator(".manga-task-connection").waitFor({ state: "visible" });
          await history.click();
          assert.equal(await page.locator(".manga-task-connection").isVisible(), true, "connection retry must remain accessible when the only tasks are old completed records and history is closed");
          jobsUnavailable = false;
          await page.locator(".manga-task-connection").getByRole("button", { name: "重试", exact: true }).click();
          await manager.waitFor({ state: "hidden" });
        }
        if (initialView === "manual-refresh") {
          job = { ...job, id: "notice-manual-refresh-new", status: "running", finishedAt: "", startedAt: "2026-08-30T00:03:00Z" };
          await history.click();
          await page.locator(".manga-task-card.is-running").waitFor({ state: "visible" });
          await history.click();
          comic.imageCount = 2;
          job = { ...job, status: "complete", finishedAt: "2026-08-30T00:04:00Z", totalChapters: 1, cachedChapters: 1, pendingChapters: 0, progressPercent: 100 };
          await history.click();
          await page.locator("[data-manga-completion-notice]").waitFor({ state: "visible" });
          await page.waitForFunction(() => document.querySelector(".channel-card.manga .channel-facts")?.textContent.includes("2 张"), null, { timeout: 5000 });
        }
        for (const width of [320, 412]) {
          await page.setViewportSize({ width, height: 820 });
          const layout = await page.locator(".manga-library-actions-head").evaluate((head) => {
            const copy = head.firstElementChild.getBoundingClientRect();
            const actions = head.lastElementChild.getBoundingClientRect();
            return { overlap: copy.right > actions.left, overflow: actions.right > innerWidth };
          });
          assert.deepEqual(layout, { overlap: false, overflow: false }, `manga history and add controls must fit at ${width}px`);
          if (initialView === "idle") {
            await page.screenshot({ path: path.join(root, ".codex-artifacts", `352-manga-tasks-idle-${width}.png`) });
          }
        }
        assert.deepEqual(pageErrors, [], `${initialView} task manager must not produce browser errors`);
        continue;
      }
      if (initialView === "failed") {
        const failed = page.locator(".manga-task-card.is-failed");
        await failed.waitFor({ state: "visible" });
        await failed.getByRole("button", { name: "重试", exact: true }).click();
        await page.locator(".manga-task-card.is-running").waitFor({ state: "visible" });
        assert.equal(await failed.count(), 0, "retry must replace the failed card instead of leaving an obsolete error");
        assert.equal(retryRequests, 1);
        assert.deepEqual(pageErrors, [], "failed task retry must not produce browser errors");
        continue;
      }
      if (initialView === "restored") {
        assert.equal(await page.locator("[data-manga-completion-notice]").count(), 0, "a cold-started app must not replay old completion notices");
        assert.equal(await page.locator(".manga-job-progress").count(), 0, "a cold-started book must not restore old completion cards");
        continue;
      }
      await page.locator(".manga-job-progress.is-running").waitFor({ state: "visible", timeout: 5000 });
      assert.doesNotMatch(await page.locator(".manga-job-progress.is-running").textContent(), /目录 0 章/, "a catalog that is still loading must not claim to contain zero chapters");
      assert.equal(await page.locator("[data-manga-completion-notice]").count(), 0, "loading old history must not replay a completion notice");
      if (["library", "switch"].includes(initialView)) {
        assert.equal(await page.locator(".manga-task-card.is-complete").count(), 0, "old completed tasks must stay out of the library feed");
      }
      if (initialView === "switch") {
        holdNextList = true;
        await page.evaluate(() => window.renderMangaNoticeFixture("detail"));
        await page.evaluate(() => window.renderMangaNoticeFixture("library"));
        await Promise.race([listPending, new Promise((_, reject) => setTimeout(() => reject(new Error("manga list race fixture did not start")), 5000))]);
      }
      comic.imageCount = 2;
      job = { ...job, status: "complete", finishedAt: "2026-08-30T00:01:00Z", totalChapters: 1, cachedChapters: 1, pendingChapters: 0, completedChapters: 0, progressPercent: 100 };
      const notice = page.locator("[data-manga-completion-notice]");
      await notice.waitFor({ state: "visible", timeout: 5000 });
      releaseList?.();
      await page.waitForTimeout(100);
      assert.match(await notice.textContent(), /任务提示测试.*更新完成/, `${initialView} polling must display a completion notice`);
      assert.match(await notice.textContent(), /已是最新/, "an incremental check with no pending chapters must clearly report that the comic is up to date");
      assert.equal(await page.locator(".manga-job-progress.is-running").count(), 0, "a delayed running list snapshot must not undo the completion observed by the book poll");
      assert.equal(await page.locator(".manga-job-progress.is-complete").count(), 0, "completed progress must be replaced by the short notice, not a permanent 100% card");
      if (["library", "switch"].includes(initialView)) {
        await page.waitForFunction(() => document.querySelector(".channel-card.manga .channel-facts")?.textContent.includes("2 张"), null, { timeout: 5000 });
      }
      await page.evaluate(() => window.renderMangaNoticeFixture());
      await notice.waitFor({ state: "visible", timeout: 5000 });
      await notice.waitFor({ state: "detached", timeout: 7500 });
      if (["library", "switch"].includes(initialView)) {
        assert.equal(await page.locator("[data-manga-task-manager]").isVisible(), false, "an idle task manager must disappear after its completion notice expires");
        const history = page.getByRole("button", { name: "下载记录", exact: true });
        await history.click();
        await page.locator(".manga-task-card.is-complete").waitFor({ state: "visible" });
        assert.equal(await page.locator(".manga-task-history-toggle").getAttribute("aria-expanded"), "true");
        await page.locator(".manga-task-history-toggle").click();
        assert.equal(await page.locator("[data-manga-task-manager]").isVisible(), false, "closing history must reclaim the entire empty task region");
      }
      await page.evaluate(() => window.renderMangaNoticeFixture("detail"));
      assert.equal(await notice.count(), 0, "reopening a finished book must not replay the expired notice");
      assert.equal(await page.locator(".manga-job-progress").count(), 0, "reopening a finished book must not restore its old progress card");
      assert.deepEqual(pageErrors, [], `manga ${initialView} fixture must not produce browser errors`);
    } finally {
      releaseList?.();
      await page.close();
    }
  }
}

async function verifyNovelCardAccessibility(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${baseUrl}/novels`, { waitUntil: "domcontentloaded" });
    const card = page.locator("article.novel-book-row").first();
    await card.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await card.getAttribute("tabindex"), null, "novel cards must not add a non-semantic tab stop");
    assert.notEqual(await card.evaluate((element) => getComputedStyle(element).cursor), "pointer", "a static novel card must not advertise a click target");
    const detail = card.getByRole("button", { name: "书籍详情" });
    await detail.focus();
    assert.equal(await detail.evaluate((element) => document.activeElement === element), true, "the named book-detail control must be keyboard focusable");
    assert.equal(await detail.evaluate((element) => getComputedStyle(element).cursor), "pointer", "the real detail button must retain its interactive cursor");
    await page.keyboard.press("Enter");
    await page.locator(".novel-detail").waitFor({ state: "visible", timeout: 5000 });
  } finally {
    await page.close();
  }
}

async function verifyNovelRankingClampHistory(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/novels`, { waitUntil: "domcontentloaded" });
    await page.locator(".novel-book-row").waitFor({ state: "visible", timeout: 5000 });
    const historyLengthBefore = await page.evaluate(() => history.length);
    await page.evaluate(() => {
      history.pushState({}, "", "/novels/rankings?page=100");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.locator(".novel-ranking-board").waitFor({ state: "visible", timeout: 5000 });
    assert.match(await page.locator(".novel-ranking-board").textContent(), /第 1 \/ 1 页/, "the restored ranking view must show the clamped page");
    assert.equal(await page.evaluate(() => history.length), historyLengthBefore + 1, "an out-of-range history route must be replaced instead of adding another entry");
    assert.match(page.url(), /\/novels\/rankings$/, "the clamped ranking route must omit its invalid page parameter");
    await page.goBack();
    await page.locator(".novel-book-row").waitFor({ state: "visible", timeout: 5000 });
    assert.match(page.url(), /\/novels$/, "Back must return before the provisional out-of-range ranking request");
    await page.goForward();
    await page.locator(".novel-ranking-board").waitFor({ state: "visible", timeout: 5000 });
    assert.match(page.url(), /\/novels\/rankings$/, "Forward must visit only the clamped ranking route");
  } finally {
    await page.close();
  }
}

async function verifyNovelManageExitStopsPolling(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    fixtureNovelCollectionRequests = 0;
    fixtureNovelSummaryRequests = 0;
    const delayed = deferNovelCollection();
    await page.goto(`${baseUrl}/novels`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "管理" }).click();
    await delayed.requested;
    await page.getByRole("button", { name: "书库" }).click();
    await page.locator(".novel-book-row").waitFor({ state: "visible", timeout: 5000 });
    delayed.release();
    await page.waitForTimeout(1800);
    assert.equal(fixtureNovelCollectionRequests, 1, "a completed stale manage load must not schedule a collection poll after leaving management");
    assert.equal(fixtureNovelSummaryRequests, 1, "a stale succeeded collection task must not refresh or clear the current books intent");
    await page.locator(".novel-book-row").waitFor({ state: "visible", timeout: 5000 });
  } finally {
    delayedNovelCollection = null;
    await page.close();
  }
}

async function verifyAndroidCollectionPicker(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  async function openPicker() {
    await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const { createShortVideoCollections } = await import("/android-client/modules/short-videos/collections/controller.js?picker-fixture=1");
      let resolveCollections;
      let rejectCollections;
      const pendingCollections = new Promise((resolve, reject) => {
        resolveCollections = resolve;
        rejectCollections = reject;
      });
      window.finishAndroidCollectionPickerRequest = (outcome) => {
        if (outcome === "reject") rejectCollections(new Error("fixture collection request failed"));
        else resolveCollections({ collections: [], total: 0 });
      };
      const trigger = document.createElement("button");
      trigger.id = "android-picker-trigger";
      trigger.textContent = "加入清单";
      document.body.append(trigger);
      trigger.focus();
      const controller = createShortVideoCollections({
        api: { fetch: () => pendingCollections },
        els: {
          viewContent: document.getElementById("fixture"),
          viewKicker: document.createElement("div"),
          viewMeta: document.createElement("div"),
          viewTitle: document.createElement("div")
        },
        getActiveUrl: () => location.origin,
        openNativeShortVideoFeed: () => false,
        renderCard: () => document.createElement("div"),
        setActiveBottom() {},
        shortVideoToast() {},
        showView() {}
      });
      window.androidCollectionPickerPromise = controller.showCollectionPicker({
        id: "fixture-video",
        streamUrl: "/media/fixture-video.mp4"
      });
    });
  }

  try {
    await openPicker();
    const picker = page.locator(".short-video-mobile-collection-picker");
    const input = picker.locator("input[aria-label='新清单名称']");
    await picker.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await input.evaluate((element) => document.activeElement === element), true, "Android picker must focus inside the modal before the collections request settles");
    await picker.locator("header button").focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await picker.evaluate((element) => element.contains(document.activeElement)), true, "Android picker Tab trap must work while the collections request is pending");
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await page.locator("#android-picker-trigger").evaluate((element) => document.activeElement === element), true, "Android picker Escape must close and restore trigger focus during a slow request");
    await page.evaluate(() => window.finishAndroidCollectionPickerRequest("resolve"));

    await openPicker();
    const failedPicker = page.locator(".short-video-mobile-collection-picker");
    await failedPicker.waitFor({ state: "visible", timeout: 5000 });
    await page.evaluate(() => window.finishAndroidCollectionPickerRequest("reject"));
    await failedPicker.locator(".short-video-mobile-collection-status", { hasText: "fixture collection request failed" }).waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await failedPicker.evaluate((element) => element.contains(document.activeElement)), true, "Android picker must retain modal focus after a failed request");
    await page.keyboard.press("Tab");
    assert.equal(await failedPicker.evaluate((element) => element.contains(document.activeElement)), true, "Android picker Tab trap must remain active after a failed request");
    await page.keyboard.press("Escape");
    await failedPicker.waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await page.locator("#android-picker-trigger").evaluate((element) => document.activeElement === element), true, "Android picker must restore trigger focus when closing after a failed request");
  } finally {
    await page.close();
  }
}

async function verifyAndroidCollectionRefresh(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  try {
    await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async () => {
      const { createShortVideoCollections } = await import("/android-client/modules/short-videos/collections/controller.js?refresh-fixture=1");
      let serviceCollections = [{ id: "stale", name: "已删除清单", itemCount: 0 }];
      let requestCount = 0;
      let nextRequestGate = null;
      let resolveCreatedCollection;
      const createdCollectionNavigation = new Promise((resolve) => {
        resolveCreatedCollection = resolve;
      });
      const controller = createShortVideoCollections({
        api: {
          fetch: (_base, requestPath, options = {}) => {
            if (requestPath !== "/api/short-videos/collections") {
              throw new Error(`unexpected Android collection fixture request: ${requestPath}`);
            }
            const method = String(options?.method || "GET").toUpperCase();
            if (method === "POST") {
              const collection = {
                id: "created-during-refresh",
                name: String(options?.body?.name || ""),
                itemCount: 0
              };
              serviceCollections = [...serviceCollections, collection];
              return Promise.resolve({ collection: { ...collection } });
            }
            if (method !== "GET") throw new Error(`unexpected Android collection fixture method: ${method}`);
            requestCount += 1;
            const payload = {
              collections: serviceCollections.map((collection) => ({ ...collection })),
              total: serviceCollections.length
            };
            const gate = nextRequestGate;
            nextRequestGate = null;
            return gate ? gate.then(() => payload) : Promise.resolve(payload);
          }
        },
        els: {
          viewContent: document.getElementById("fixture"),
          viewKicker: document.createElement("div"),
          viewMeta: document.createElement("div"),
          viewTitle: document.createElement("div")
        },
        getActiveUrl: () => location.origin,
        openNativeShortVideoFeed: () => false,
        renderCard: () => document.createElement("div"),
        setActiveBottom() {},
        shortVideoToast() {},
        showView(view, params) {
          if (view === "shortVideoCollection") resolveCreatedCollection(params?.collectionId || "");
        }
      });

      await controller.renderCollections();
      const initiallyLoadedIds = [...document.querySelectorAll(".short-video-mobile-collection-row")]
        .map((element) => element.dataset.collectionId);

      serviceCollections = [];
      await controller.renderCollections();
      const refreshedPageIds = [...document.querySelectorAll(".short-video-mobile-collection-row")]
        .map((element) => element.dataset.collectionId);
      const refreshedPageEmpty = document.querySelector(".short-video-mobile-empty")?.textContent || "";

      serviceCollections = [{ id: "picker-fresh", name: "服务端新清单", itemCount: 2 }];
      await controller.showCollectionPicker({ id: "fixture-video", streamUrl: "/media/fixture-video.mp4" });
      const refreshedPickerIds = [...document.querySelectorAll(".short-video-mobile-collection-picker-list button")]
        .map((element) => element.dataset.collectionId);

      serviceCollections = [{ id: "shared-refresh", name: "并发刷新清单", itemCount: 3 }];
      let releaseRequest;
      nextRequestGate = new Promise((resolve) => {
        releaseRequest = resolve;
      });
      const beforeConcurrentRefresh = requestCount;
      const pageRefresh = controller.renderCollections();
      const pickerRefresh = controller.showCollectionPicker({ id: "fixture-video", streamUrl: "/media/fixture-video.mp4" });
      const concurrentRequestCount = requestCount - beforeConcurrentRefresh;
      releaseRequest();
      await Promise.all([pageRefresh, pickerRefresh]);
      const concurrentPageIds = [...document.querySelectorAll(".short-video-mobile-collection-row")]
        .map((element) => element.dataset.collectionId);
      const concurrentPickerIds = [...document.querySelectorAll(".short-video-mobile-collection-picker-list button")]
        .map((element) => element.dataset.collectionId);

      serviceCollections = [];
      let releaseMutationRace;
      nextRequestGate = new Promise((resolve) => {
        releaseMutationRace = resolve;
      });
      const mutationRacePage = controller.renderCollections();
      const createInput = document.querySelector("#fixture .short-video-mobile-collection-create input");
      createInput.value = "刷新中创建";
      createInput.form.requestSubmit();
      const createdCollectionId = await createdCollectionNavigation;
      serviceCollections = [];
      releaseMutationRace();
      await mutationRacePage;
      const mutationRaceIds = [...document.querySelectorAll(".short-video-mobile-collection-row")]
        .map((element) => element.dataset.collectionId);

      await controller.renderCollections();
      const afterMutationDeleteIds = [...document.querySelectorAll(".short-video-mobile-collection-row")]
        .map((element) => element.dataset.collectionId);

      return {
        afterMutationDeleteIds,
        concurrentPageIds,
        concurrentPickerIds,
        concurrentRequestCount,
        createdCollectionId,
        initiallyLoadedIds,
        mutationRaceIds,
        refreshedPageEmpty,
        refreshedPageIds,
        refreshedPickerIds,
        requestCount
      };
    });

    assert.deepEqual(result.initiallyLoadedIds, ["stale"], "Android collection fixture must first enter the loaded cache state");
    assert.deepEqual(result.refreshedPageIds, [], "re-entering the Android collection index must discard a collection deleted by another client");
    assert.equal(result.refreshedPageEmpty, "还没有清单", "the refreshed Android collection index must render the server's empty list");
    assert.deepEqual(result.refreshedPickerIds, ["picker-fresh"], "opening the Android picker must refresh collections after the server list changes");
    assert.equal(result.concurrentRequestCount, 1, "concurrent Android index and picker refreshes must share one in-flight request");
    assert.deepEqual(result.concurrentPageIds, ["shared-refresh"], "the Android collection index must render the shared refresh result");
    assert.deepEqual(result.concurrentPickerIds, ["shared-refresh"], "the Android picker must render the shared refresh result");
    assert.equal(result.createdCollectionId, "created-during-refresh", "the Android collection form must complete while the preceding refresh is pending");
    assert.deepEqual(result.mutationRaceIds, ["created-during-refresh"], "a stale pending refresh must merge a collection created after that request started");
    assert.deepEqual(result.afterMutationDeleteIds, [], "a later refresh must trust a server deletion after the local creation revision is covered");
    assert.equal(result.requestCount, 6, "each separate Android collection entry must refresh while only concurrent entries stay de-duplicated");
  } finally {
    await page.close();
  }
}

async function verifyAndroidCollectionManagement(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  try {
    await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const { createShortVideoCollections } = await import("/android-client/modules/short-videos/collections/controller.js?management-fixture=1");
      let collection = { id: "manage", name: "原清单", itemCount: 0 };
      let confirmDelete = false;
      let deleteAttempts = 0;
      let listRequests = 0;
      let nextListGate = null;
      let patchAttempts = 0;
      let pickerPromise = null;
      let releaseList = null;
      let route = null;
      const confirmations = [];
      const toasts = [];
      window.confirm = (message) => {
        confirmations.push(String(message || ""));
        return confirmDelete;
      };
      const controller = createShortVideoCollections({
        api: {
          fetch: (_base, requestPath, options = {}) => {
            const url = new URL(requestPath, location.origin);
            const method = String(options?.method || "GET").toUpperCase();
            if (url.pathname === "/api/short-videos/collections/manage/videos" && method === "GET") {
              return Promise.resolve({
                collection: { ...collection },
                hasMore: false,
                nextCursor: null,
                total: 0,
                videos: []
              });
            }
            if (url.pathname === "/api/short-videos/collections" && method === "GET") {
              listRequests += 1;
              const payload = { collections: collection ? [{ ...collection }] : [], total: collection ? 1 : 0 };
              const gate = nextListGate;
              nextListGate = null;
              return gate ? gate.then(() => payload) : Promise.resolve(payload);
            }
            if (url.pathname === "/api/short-videos/collections/manage" && method === "PATCH") {
              patchAttempts += 1;
              if (patchAttempts === 1) {
                throw Object.assign(new Error("fixture rename busy"), { retryable: true, status: 503 });
              }
              collection = { ...collection, name: String(options?.body?.name || "") };
              return Promise.resolve({ collection: { ...collection } });
            }
            if (url.pathname === "/api/short-videos/collections/manage" && method === "DELETE") {
              deleteAttempts += 1;
              if (deleteAttempts === 1) {
                throw Object.assign(new Error("fixture delete busy"), { retryable: true, status: 503 });
              }
              collection = null;
              return Promise.resolve({ id: "manage", name: "新清单", ok: true, removedItems: 0 });
            }
            throw new Error(`unexpected Android collection management fixture request: ${method} ${url.pathname}`);
          }
        },
        els: {
          viewContent: document.getElementById("fixture"),
          viewKicker: document.createElement("div"),
          viewMeta: document.createElement("div"),
          viewTitle: document.createElement("div")
        },
        getActiveUrl: () => location.origin,
        openNativeShortVideoFeed: () => false,
        renderCard: () => document.createElement("div"),
        setActiveBottom() {},
        shortVideoToast(message) {
          toasts.push(message);
        },
        showView(view, params, navigation) {
          route = { navigation, params, view };
        }
      });
      window.androidCollectionManagementFixture = {
        allowDelete(value) {
          confirmDelete = Boolean(value);
        },
        metrics() {
          return { confirmations: [...confirmations], deleteAttempts, listRequests, patchAttempts, route, toasts: [...toasts] };
        },
        releasePendingList() {
          releaseList?.();
        },
        renderIndex() {
          return controller.renderCollections();
        },
        startPendingPicker() {
          nextListGate = new Promise((resolve) => {
            releaseList = resolve;
          });
          pickerPromise = controller.showCollectionPicker({ id: "fixture-video", streamUrl: "/media/fixture-video.mp4" });
        },
        waitForPicker() {
          return pickerPromise;
        }
      };
      await controller.renderCollection({ collectionId: "manage" }, () => true);
    });

    const empty = page.locator("#fixture .short-video-mobile-empty");
    await empty.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await empty.textContent(), "这个清单还没有视频", "Android collection management must remain available on an empty detail page");
    const rename = page.locator(".short-video-mobile-collection-actions button", { hasText: "重命名" });
    const removeCollection = page.locator(".short-video-mobile-collection-actions button", { hasText: "删除清单" });
    await rename.click();
    const renameInput = page.locator(".short-video-mobile-collection-rename input");
    assert.equal(await renameInput.evaluate((element) => document.activeElement === element), true, "Android collection rename must focus its input");
    await renameInput.fill("");
    await page.locator(".short-video-mobile-collection-rename button", { hasText: "保存" }).click();
    await page.locator(".short-video-mobile-collection-status", { hasText: "请输入清单名称" }).waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await renameInput.evaluate((element) => document.activeElement === element), true, "an empty Android collection name must keep focus without sending a request");
    assert.equal((await page.evaluate(() => window.androidCollectionManagementFixture.metrics())).patchAttempts, 0, "an empty Android collection name must not reach the API");

    await renameInput.fill("新清单");
    await page.locator(".short-video-mobile-collection-rename button", { hasText: "保存" }).click();
    await page.locator("#fixture h2", { hasText: "新清单" }).waitFor({ state: "visible", timeout: 5000 });
    assert.equal((await page.evaluate(() => window.androidCollectionManagementFixture.metrics())).patchAttempts, 2, "Android collection rename must retry an explicitly retryable 503 exactly once before success");
    assert.equal(await rename.evaluate((element) => document.activeElement === element), true, "successful Android collection rename must restore focus to its trigger");

    await removeCollection.click();
    let metrics = await page.evaluate(() => window.androidCollectionManagementFixture.metrics());
    assert.equal(metrics.deleteAttempts, 0, "canceling Android collection deletion must not call the API");
    assert.match(metrics.confirmations.at(-1), /视频文件不会被删除/u, "Android collection deletion must confirm that video files are preserved");
    assert.equal(await removeCollection.evaluate((element) => document.activeElement === element), true, "canceling Android collection deletion must restore trigger focus");

    await page.evaluate(() => window.androidCollectionManagementFixture.startPendingPicker());
    await page.locator(".short-video-mobile-collection-picker").waitFor({ state: "visible", timeout: 5000 });
    await page.evaluate(() => {
      window.androidCollectionManagementFixture.allowDelete(true);
      document.querySelector(".short-video-mobile-collection-actions .is-danger").click();
    });
    await page.waitForFunction(() => window.androidCollectionManagementFixture.metrics().route?.view === "shortVideoCollections", null, { timeout: 5000 });
    await page.evaluate(() => window.androidCollectionManagementFixture.releasePendingList());
    await page.evaluate(() => window.androidCollectionManagementFixture.waitForPicker());
    assert.equal(await page.locator(".short-video-mobile-collection-picker-list button").count(), 0, "a stale in-flight Android list response must not resurrect a deleted collection");
    metrics = await page.evaluate(() => window.androidCollectionManagementFixture.metrics());
    assert.equal(metrics.deleteAttempts, 2, "Android collection deletion must retry an explicitly retryable 503 exactly once before success");
    assert.deepEqual(metrics.route, {
      navigation: { replaceHistory: true, skipHistory: true },
      params: {},
      view: "shortVideoCollections"
    }, "Android collection deletion must replace the deleted detail route with the collection index");
    assert.deepEqual(metrics.toasts, ["清单已重命名", "清单已删除"], "Android collection management must report both successful mutations");

    await page.evaluate(() => window.androidCollectionManagementFixture.renderIndex());
    await page.locator("#fixture .short-video-mobile-empty", { hasText: "还没有清单" }).waitFor({ state: "visible", timeout: 5000 });
    assert.equal((await page.evaluate(() => window.androidCollectionManagementFixture.metrics())).listRequests, 2, "a later Android refresh must trust the server deletion after covering the tombstone revision");
  } finally {
    await page.close();
  }
}

async function verifyAndroidCollectionStackReturn(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  try {
    await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const { createShortVideoCollections } = await import("/android-client/modules/short-videos/collections/controller.js?stack-return-fixture=1");
      let discardCalls = 0;
      let showCalls = 0;
      window.confirm = () => true;
      const controller = createShortVideoCollections({
        api: {
          fetch: (_base, requestPath, options = {}) => {
            const url = new URL(requestPath, location.origin);
            const method = String(options?.method || "GET").toUpperCase();
            if (url.pathname === "/api/short-videos/collections/stacked/videos" && method === "GET") {
              return Promise.resolve({
                collection: { id: "stacked", itemCount: 0, name: "栈内清单" },
                hasMore: false,
                nextCursor: null,
                total: 0,
                videos: []
              });
            }
            if (url.pathname === "/api/short-videos/collections/stacked" && method === "DELETE") {
              return Promise.resolve({ id: "stacked", name: "栈内清单", ok: true, removedItems: 0 });
            }
            throw new Error(`unexpected Android collection stack fixture request: ${method} ${url.pathname}`);
          }
        },
        els: {
          viewContent: document.getElementById("fixture"),
          viewKicker: document.createElement("div"),
          viewMeta: document.createElement("div"),
          viewTitle: document.createElement("div")
        },
        getActiveUrl: () => location.origin,
        discardPushedView() {
          discardCalls += 1;
          return true;
        },
        openNativeShortVideoFeed: () => false,
        renderCard: () => document.createElement("div"),
        setActiveBottom() {},
        shortVideoToast() {},
        showView() {
          showCalls += 1;
        }
      });
      window.androidCollectionStackFixture = {
        metrics: () => ({ discardCalls, showCalls })
      };
      await controller.renderCollection({ collectionId: "stacked" }, () => true);
    });

    await page.locator(".short-video-mobile-collection-actions .is-danger").click();
    await page.waitForFunction(() => window.androidCollectionStackFixture.metrics().discardCalls === 1, null, { timeout: 5000 });
    assert.deepEqual(
      await page.evaluate(() => window.androidCollectionStackFixture.metrics()),
      { discardCalls: 1, showCalls: 0 },
      "deleting an Android collection opened with push must discard its stack and browser-history entry instead of rendering a duplicate index"
    );
  } finally {
    await page.close();
  }
}

async function verifyAndroidNativeActionCardRefresh(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  try {
    await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const [{ createShortVideoListView }, { createShortVideoNativeFeed }] = await Promise.all([
        import("/android-client/modules/short-videos/list/view.js?action-card-fixture=1"),
        import("/android-client/modules/short-videos/player/native-feed.js?action-card-fixture=1")
      ]);
      const root = document.getElementById("fixture");
      root.style.height = "120px";
      root.style.overflow = "auto";
      const before = document.createElement("div");
      before.style.height = "360px";
      const after = document.createElement("div");
      after.style.height = "360px";
      const listHost = document.createElement("section");
      listHost.className = "fixture-list-cards";
      const collectionHost = document.createElement("section");
      collectionHost.className = "fixture-collection-cards";
      const listVideo = {
        id: "action-card-video",
        streamUrl: "/media/action-card-video.mp4",
        title: "列表作品",
        actions: { liked: false, collected: false },
        stats: { likes: 10, collects: 2 }
      };
      const collectionVideo = {
        ...listVideo,
        title: "清单作品",
        actions: { ...listVideo.actions },
        stats: { ...listVideo.stats }
      };
      const listState = { data: { videos: [listVideo], hasMore: false } };
      const els = { viewContent: root };
      const listView = createShortVideoListView({
        bindReliableTap(element, handler) { element.addEventListener("click", handler); },
        createIcon(name) {
          const icon = document.createElement("span");
          icon.className = `short-video-mobile-icon short-video-mobile-icon-${name}`;
          return icon;
        },
        els,
        getActiveUrl: () => location.origin,
        listState,
        openShortVideoFromList() {},
        showCollectionPicker() {}
      });
      const listCard = listView.renderCard(listVideo, { allowCollections: false });
      const collectionCard = listView.renderCard(collectionVideo, { allowCollections: false });
      listHost.append(listCard);
      collectionHost.append(collectionCard);
      root.append(before, listHost, collectionHost, after);
      root.scrollTop = 240;
      const initialScrollTop = root.scrollTop;
      const calls = [];
      const invalidations = [];
      let nextResult = { serverBase: location.origin, snapshots: [] };
      window.Capacitor = { Plugins: { FanHaoPlayer: {
        async playShortFeed(payload) {
          calls.push(payload);
          return nextResult;
        }
      } } };
      const nativeFeed = createShortVideoNativeFeed({
        getActiveUrl: () => location.origin,
        invalidateShortVideoCache: async (...args) => invalidations.push(args),
        listState,
        refreshVideoCards: listView.refreshVideoCards,
        shortVideoApiSource: () => "all",
        shortVideoToast() {}
      });
      window.androidNativeActionCardFixture = {
        async run(result) {
          nextResult = result;
          return nativeFeed.openNativeShortVideoFeed(collectionVideo, { videos: [collectionVideo] });
        },
        metrics() {
          const read = (host) => {
            const metric = host.querySelector(".short-video-mobile-thumb-metric");
            const card = host.querySelector(".short-video-mobile-card");
            return {
              aria: card?.getAttribute("aria-label") || "",
              count: metric?.textContent || "",
              icon: metric?.querySelector(".short-video-mobile-icon")?.className || "",
              liked: Boolean(metric?.classList.contains("is-liked"))
            };
          };
          return {
            calls: calls.map((payload) => JSON.parse(payload.videos).videos[0]),
            collection: read(collectionHost),
            collectionStable: collectionHost.firstElementChild === collectionCard,
            initialScrollTop,
            invalidations: [...invalidations],
            list: read(listHost),
            listStable: listHost.firstElementChild === listCard,
            scrollTop: root.scrollTop
          };
        }
      };
    });

    const fixture = "window.androidNativeActionCardFixture";
    assert.equal(await page.evaluate(`${fixture}.run({ serverBase: location.origin, snapshots: [{ videoId: "action-card-video", liked: true, likes: 11 }] })`), true);
    let metrics = await page.evaluate(`${fixture}.metrics()`);
    for (const card of [metrics.list, metrics.collection]) {
      assert.equal(card.liked, true, "Native ACK must refresh both list and collection cards to liked");
      assert.equal(card.count, "11", "Native ACK must refresh both rendered like counts");
      assert.match(card.icon, /short-video-mobile-icon-heart(?:\s|$)/u, "Native ACK must replace the outline icon with the liked heart");
      assert.match(card.aria, /已点赞，11 个赞/u, "Native ACK must refresh the rendered card accessibility label");
    }
    assert.equal(metrics.listStable && metrics.collectionStable, true, "targeted Native ACK refresh must retain both card DOM nodes");
    assert.equal(metrics.scrollTop, metrics.initialScrollTop, "targeted Native ACK refresh must preserve the list scroll position");
    assert.deepEqual(metrics.invalidations, [[baseUrl, "/api/short-videos"]]);

    await page.evaluate(`${fixture}.run({ serverBase: location.origin, snapshots: [{ videoId: "action-card-video", liked: false, likes: 10 }] })`);
    metrics = await page.evaluate(`${fixture}.metrics()`);
    assert.equal(metrics.calls[1].actions.liked, true, "immediate reopen must serialize the first acknowledged liked state before accepting the next result");
    for (const card of [metrics.list, metrics.collection]) {
      assert.equal(card.liked, false, "a later Native ACK must refresh both cards back to unliked");
      assert.equal(card.count, "10");
      assert.match(card.icon, /short-video-mobile-icon-heartOutline(?:\s|$)/u);
      assert.match(card.aria, /未点赞，10 个赞/u);
    }
    assert.equal(metrics.listStable && metrics.collectionStable, true);
    assert.equal(metrics.scrollTop, metrics.initialScrollTop);

    const unchangedInvalidations = metrics.invalidations.length;
    const oversized = Array.from({ length: 513 }, (_, index) => ({ videoId: `oversized-${index}`, liked: true }));
    await page.evaluate(({ snapshots }) => window.androidNativeActionCardFixture.run({ serverBase: location.origin, snapshots }), { snapshots: oversized });
    await page.evaluate(`${fixture}.run({ serverBase: location.origin, snapshots: [{ videoId: "x".repeat(513), liked: true }] })`);
    await page.evaluate(`${fixture}.run({ serverBase: location.origin, snapshots: [{ videoId: "action-card-video", liked: "true" }] })`);
    await page.evaluate(`${fixture}.run({ serverBase: "", snapshots: [{ videoId: "action-card-video", liked: true, likes: 99 }] })`);
    metrics = await page.evaluate(`${fixture}.metrics()`);
    assert.equal(metrics.list.liked, false, "oversized, malformed, long-id, and invalid-base results must not patch rendered cards");
    assert.equal(metrics.list.count, "10");
    assert.equal(metrics.invalidations.length, unchangedInvalidations, "rejected result payloads must not invalidate persistent caches");
    assert.equal(metrics.listStable && metrics.collectionStable, true);
    assert.equal(metrics.scrollTop, metrics.initialScrollTop);
  } finally {
    await page.close();
  }
}

async function verifyAndroidRestartActionConvergence(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  try {
    await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const { CLIENT_VERSION } = await import("/android-client/js/config.js");
      const [{ createShortVideoViews }, cache, { createShortVideoApi }, { createShortVideoListController }] = await Promise.all([
        import("/android-client/modules/short-videos/index.js?restart-action-fixture=1"),
        import(`/android-client/js/cache.js?v=${CLIENT_VERSION}`),
        import("/android-client/modules/short-videos/api.js?restart-action-fixture=2"),
        import("/android-client/modules/short-videos/list/controller.js?restart-action-fixture=2")
      ]);
      await cache.clearCachedData();
      const host = document.getElementById("fixture");
      const active = { value: location.origin };
      const requests = [];
      const pending = [];
      const relatedPending = [];
      const nativePayloads = [];
      let relatedQuery = "";
      let networkMode = "immediate";
      const payloads = new Map();
      window.Capacitor = { Plugins: { FanHaoPlayer: {
        async playShortFeed(payload) {
          nativePayloads.push(JSON.parse(payload.videos).videos);
          return { serverBase: new URL(payload.baseUrl).origin, snapshots: [] };
        }
      } } };
      const nativeFetch = window.fetch.bind(window);
      const canonicalResponseUrl = (url) => {
        const normalized = new URL(url.href);
        normalized.searchParams.delete("refresh");
        return normalized;
      };
      const responseFor = (url) => {
        const canonicalUrl = canonicalResponseUrl(url);
        const payload = payloads.get(`${canonicalUrl.origin}${canonicalUrl.pathname}${canonicalUrl.search}`)
          || payloads.get(`${url.origin}${url.pathname}`);
        return new Response(JSON.stringify(payload || {}), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };
      window.fetch = (input, options) => {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        if (url.pathname === "/api/short-videos/authors" && url.searchParams.get("q") === relatedQuery) {
          return new Promise((resolve) => relatedPending.push(() => resolve(new Response(JSON.stringify({
            authors: [{ secUid: "related-author", name: "延迟相关作者", count: 1 }],
            hasMore: false,
            total: 1
          }), { status: 200, headers: { "content-type": "application/json" } }))));
        }
        if (url.pathname !== "/api/short-videos") return nativeFetch(input, options);
        requests.push(url.href);
        if (networkMode === "offline") return Promise.reject(new TypeError("fixture offline"));
        if (networkMode === "delay") {
          return new Promise((resolve) => pending.push(() => resolve(responseFor(url))));
        }
        return Promise.resolve(responseFor(url));
      };
      const pathFor = (query) => `/api/short-videos?${new URLSearchParams({
        q: query,
        source: "all",
        sort: "published",
        limit: "12",
        facets: "0",
        stats: "0"
      })}`;
      const video = (id, liked, collected = liked) => ({
        id,
        title: `缓存收敛 ${id}`,
        mediaType: "video",
        streamUrl: `/media/short-video/${id}`,
        actions: { liked, collected },
        stats: { likes: liked ? 11 : 10, collects: collected ? 4 : 3 }
      });
      const feed = (item) => ({ videos: [item], total: 1, hasMore: false, source: "all" });
      const deps = () => ({
        els: {
          viewContent: host,
          viewKicker: document.createElement("div"),
          viewMeta: document.createElement("div"),
          viewTitle: document.createElement("div")
        },
        getActiveUrl: () => active.value,
        goBack() {},
        setActiveBottom() {},
        showView() {}
      });
      const renderSearch = (views, query, guard = null) => views.renderSearch({
        query,
        source: "all",
        sort: "published",
        tab: "all"
      }, guard);
      const cardState = () => {
        const card = host.querySelector(".short-video-mobile-card");
        const metric = host.querySelector(".short-video-mobile-thumb-metric");
        return {
          aria: card?.getAttribute("aria-label") || "",
          count: metric?.textContent || "",
          liked: Boolean(metric?.classList.contains("is-liked")),
          videoId: card?.closest("[data-video-id]")?.dataset.videoId || ""
        };
      };
      const waitFor = async (predicate, message) => {
        const deadline = Date.now() + 3000;
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error(message);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((promiseResolve, promiseReject) => {
          resolve = promiseResolve;
          reject = promiseReject;
        });
        return { promise, reject, resolve };
      };
      const createControllerState = () => ({
        allowLoadMore: false,
        author: "all",
        authorAccountStatus: "all",
        authorFilter: "all",
        authorSort: "followed",
        data: null,
        loading: false,
        loadingMore: false,
        query: "",
        searchAuthors: [],
        searchPage: false,
        searchTab: "all",
        sort: "published",
        source: "all",
        status: ""
      });
      const createControllerFixture = (api, state, observations = {}) => createShortVideoListController({
        api,
        appendListVideos(videos) {
          observations.appended = [...(observations.appended || []), ...videos.map((item) => item.id)];
        },
        getActiveUrl: () => active.value,
        listState: state,
        openNativeShortVideoFeed: async () => false,
        refreshVideoCards(item) {
          observations.refreshed = [...(observations.refreshed || []), item.id];
        },
        renderListShell() {
          observations.renders = Number(observations.renders || 0) + 1;
        },
        setListLoadingMore() {},
        setListRefreshing() {},
        shortVideoToast() {},
        showView() {}
      });
      const controllerFeed = (videos, overrides = {}) => ({
        authors: [],
        hasMore: false,
        limit: 12,
        offset: 0,
        source: "all",
        sort: "published",
        total: videos.length,
        videos,
        ...overrides
      });

      const appendFresh = deferred();
      const appendPage = deferred();
      const appendState = createControllerState();
      const appendObservations = {};
      const appendController = createControllerFixture({
        async fetchCached(_base, requestPath) {
          const offset = new URL(requestPath, location.href).searchParams.get("offset");
          if (offset !== "2") throw new Error(`unexpected append fixture path: ${requestPath}`);
          return appendPage.promise;
        },
        async fetchCachedRevalidated() {
          return {
            data: controllerFeed([
              video("append-a", false, false),
              video("append-b", false, false)
            ], { hasMore: true, total: 3 }),
            revalidation: appendFresh.promise
          };
        }
      }, appendState, appendObservations);
      await appendController.loadList();
      const appendRequest = appendController.loadList(null, { append: true });
      appendPage.resolve(controllerFeed([video("append-c", false, false)], {
        hasMore: false,
        offset: 2,
        total: 3
      }));
      await appendRequest;
      const appendRenderBeforeFresh = appendObservations.renders;
      appendFresh.resolve(controllerFeed([
        video("append-b", false, false),
        video("append-a", true, true)
      ], { hasMore: true, total: 0 }));
      await waitFor(
        () => appendState.data?.videos?.find((item) => item.id === "append-a")?.actions?.liked,
        "initial cached revalidation did not converge after append"
      );
      const appendConvergence = {
        freshRendered: appendObservations.renders > appendRenderBeforeFresh,
        hasMore: appendState.data?.hasMore,
        ids: (appendState.data?.videos || []).map((item) => item.id),
        liked: appendState.data?.videos?.find((item) => item.id === "append-a")?.actions?.liked,
        loadingMore: appendState.loadingMore,
        status: appendState.status,
        total: appendState.data?.total
      };

      const envelopeFresh = deferred();
      const envelopeState = createControllerState();
      const envelopeObservations = {};
      const envelopeController = createControllerFixture({
        async fetchCached() {
          throw new Error("envelope fixture must not append");
        },
        async fetchCachedRevalidated() {
          return {
            data: controllerFeed([video("envelope-a", false, false)], { hasMore: false, total: 1 }),
            revalidation: envelopeFresh.promise
          };
        }
      }, envelopeState, envelopeObservations);
      await envelopeController.loadList();
      const envelopeRenderBeforeFresh = envelopeObservations.renders;
      envelopeFresh.resolve(controllerFeed([video("envelope-a", false, false)], { hasMore: true, total: 2 }));
      await waitFor(() => envelopeState.data?.total === 2, "fresh pagination envelope did not replace the cached list state");
      const envelopeConvergence = {
        freshRendered: envelopeObservations.renders > envelopeRenderBeforeFresh,
        hasMore: envelopeState.data?.hasMore,
        total: envelopeState.data?.total
      };

      const staleFresh = deferred();
      const staleState = createControllerState();
      const staleObservations = {};
      const staleController = createControllerFixture({
        async fetchCachedRevalidated() {
          return {
            data: controllerFeed([video("stale-guard", false, false)]),
            revalidation: staleFresh.promise
          };
        }
      }, staleState, staleObservations);
      const staleUnhandled = [];
      const onStaleUnhandled = (event) => {
        staleUnhandled.push(String(event.reason?.message || event.reason || "unknown"));
        event.preventDefault();
      };
      window.addEventListener("unhandledrejection", onStaleUnhandled);
      await staleController.loadList(() => false);
      staleFresh.reject(new Error("stale guard fixture rejection"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      window.removeEventListener("unhandledrejection", onStaleUnhandled);

      const observeTransaction = async (eventName, error = null) => {
        const transaction = new EventTarget();
        Object.defineProperty(transaction, "error", { get: () => error });
        const outcome = cache.transactionToPromise(transaction).then(
          () => ({ resolved: true }),
          (reason) => ({ name: String(reason?.name || "Error"), resolved: false })
        );
        transaction.dispatchEvent(new Event(eventName));
        return outcome;
      };
      const transactionCompletion = await observeTransaction("complete");
      const transactionAbort = await observeTransaction("abort", new DOMException("fixture abort", "AbortError"));
      const transactionError = await observeTransaction("error", new DOMException("fixture error", "UnknownError"));

      const quotaQuery = "quota-write";
      const quotaPath = pathFor(quotaQuery);
      payloads.set(`${active.value}${quotaPath}`, feed(video("quota-video", true, true)));
      networkMode = "immediate";
      const quotaApi = createShortVideoApi({
        getActiveUrl: () => active.value,
        async writeResponseCache() {
          throw new DOMException("fixture quota", "QuotaExceededError");
        }
      });
      const quotaResult = await quotaApi.fetchCachedRevalidated(active.value, quotaPath, { timeoutMs: 16000 });
      const quotaNetworkData = {
        fromCache: quotaResult.fromCache,
        liked: quotaResult.data?.videos?.[0]?.actions?.liked
      };

      const restartQuery = "restart-action";
      const restartPath = pathFor(restartQuery);
      const cachedRestart = feed(video("restart-video", false, false));
      const freshRestart = feed(video("restart-video", true, true));
      relatedQuery = restartQuery;
      await cache.writeCachedJson(active.value, restartPath, cachedRestart);
      payloads.set(`${active.value}${restartPath}`, freshRestart);
      networkMode = "delay";
      const restartedViews = createShortVideoViews(deps());
      await Promise.all([renderSearch(restartedViews, restartQuery), renderSearch(restartedViews, restartQuery)]);
      const cachedCard = host.querySelector("[data-video-id='restart-video']");
      const cachedState = cardState();
      const restartRequests = requests.filter((value) => new URL(value).searchParams.get("q") === restartQuery);
      if (restartRequests.length !== 1) throw new Error(`restart revalidation was not deduplicated: ${restartRequests.length}`);
      const exact = new URL(restartRequests[0]);
      if (exact.pathname !== "/api/short-videos" || exact.searchParams.get("source") !== "all"
        || exact.searchParams.get("sort") !== "published" || exact.searchParams.get("facets") !== "0"
        || exact.searchParams.get("stats") !== "0") throw new Error(`unexpected exact search path: ${exact.href}`);
      pending.splice(0).forEach((release) => release());
      await waitFor(() => cardState().liked, "fresh restart action state did not reach the mounted card");
      const freshState = cardState();
      const canonicalRestartCache = await cache.readCachedJson(active.value, restartPath);
      const transportRestartCache = await cache.readCachedJson(active.value, `${restartPath}&refresh=1`);
      const targetedStable = cachedCard === host.querySelector("[data-video-id='restart-video']");
      host.querySelector("[data-video-id='restart-video'] .short-video-mobile-card").click();
      await waitFor(() => nativePayloads.length === 1, "fresh restart model was not available to the Native bridge");
      const freshModelActions = nativePayloads[0][0].actions;
      relatedPending.splice(0).forEach((release) => release());
      await waitFor(() => Boolean(host.querySelector(".short-video-search-author-item")), "delayed related authors did not render");
      const afterRelatedAuthorsState = cardState();
      relatedQuery = "";

      const offlineQuery = "offline-retry";
      const offlinePath = pathFor(offlineQuery);
      await cache.writeCachedJson(active.value, offlinePath, feed(video("offline-video", false, false)));
      payloads.set(`${active.value}${offlinePath}`, feed(video("offline-video", true, true)));
      networkMode = "offline";
      const offlineViews = createShortVideoViews(deps());
      await renderSearch(offlineViews, offlineQuery);
      const offlineCachedState = cardState();
      await new Promise((resolve) => setTimeout(resolve, 20));
      networkMode = "immediate";
      await renderSearch(offlineViews, offlineQuery);
      await waitFor(() => cardState().liked, "offline cached page did not converge after retry");
      const offlineRetriedState = cardState();

      const otherOrigin = "http://second.invalid:39999";
      const originQuery = "origin-race";
      const originPath = pathFor(originQuery);
      await cache.writeCachedJson(location.origin, originPath, feed(video("origin-a", false, false)));
      await cache.writeCachedJson(otherOrigin, originPath, feed(video("origin-b", false, false)));
      payloads.set(`${location.origin}${originPath}`, feed(video("origin-a", true, true)));
      payloads.set(`${otherOrigin}${originPath}`, feed(video("origin-b", false, false)));
      networkMode = "delay";
      active.value = location.origin;
      const originViews = createShortVideoViews(deps());
      await renderSearch(originViews, originQuery);
      active.value = otherOrigin;
      networkMode = "immediate";
      await renderSearch(originViews, originQuery);
      pending.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 50));
      const originState = cardState();

      active.value = location.origin;
      const lateQuery = "late-write";
      const latePath = pathFor(lateQuery);
      await cache.writeCachedJson(active.value, latePath, feed(video("late-video", false, false)));
      payloads.set(`${active.value}${latePath}`, feed(video("late-video", false, false)));
      networkMode = "delay";
      const directApi = createShortVideoApi({ getActiveUrl: () => active.value });
      const late = await directApi.fetchCachedRevalidated(active.value, latePath, { timeoutMs: 16000 });
      await cache.clearCachedJsonByPrefix(active.value, "/api/short-videos");
      const emptyAfterClear = await cache.readCachedJson(active.value, latePath);
      pending.splice(0).forEach((release) => release());
      await late.revalidation.catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const emptyAfterLateWrite = await cache.readCachedJson(active.value, latePath);
      payloads.set(`${active.value}${latePath}`, feed(video("late-video", true, true)));
      networkMode = "immediate";
      const afterFence = await directApi.fetchCachedRevalidated(active.value, latePath, { timeoutMs: 16000 });

      window.androidRestartActionFixture = {
        appendConvergence,
        cachedState,
        afterRelatedAuthorsState,
        envelopeConvergence,
        emptyAfterClear: emptyAfterClear === null,
        emptyAfterLateWrite: emptyAfterLateWrite === null,
        exactSearch: exact.pathname + exact.search,
        canonicalRestartCacheActions: canonicalRestartCache?.payload?.videos?.[0]?.actions || null,
        transportRestartCacheMissing: transportRestartCache === null,
        freshState,
        freshModelActions,
        freshWriteAfterFence: Boolean(afterFence.data?.videos?.[0]?.actions?.liked),
        offlineCachedState,
        offlineRetriedState,
        originState,
        quotaNetworkData,
        requestCount: requests.length,
        staleUnhandled,
        transactionAbort,
        transactionCompletion,
        transactionError,
        targetedStable
      };
    });
    const metrics = await page.evaluate(() => window.androidRestartActionFixture);
    assert.equal(metrics.cachedState.liked, false, "process-restart-like list creation must render its persisted cached action state immediately");
    assert.equal(metrics.cachedState.videoId, "restart-video");
    assert.equal(metrics.freshState.liked, true, "successful server revalidation must update the current list model and DOM in bounded time");
    assert.deepEqual(metrics.freshModelActions, { collected: true, liked: true }, "restart convergence must update both authoritative action fields in the model passed to Native");
    assert.match(metrics.freshState.aria, /已点赞，11 个赞/u);
    assert.equal(metrics.targetedStable, true, "action-only convergence must retain the mounted card instead of rebuilding the list");
    assert.equal(metrics.afterRelatedAuthorsState.liked, true, "a delayed related-author response must render from the current fresh video state instead of restoring the stale cached video object");
    assert.match(metrics.exactSearch, /^\/api\/short-videos\?q=restart-action&source=all&sort=published&limit=12&facets=0&stats=0&refresh=1$/u,
      "restart convergence transport must force-refresh the exact active search endpoint");
    assert.deepEqual(metrics.canonicalRestartCacheActions, { collected: true, liked: true },
      "authoritative transport data must still be stored under the canonical exact-list key");
    assert.equal(metrics.transportRestartCacheMissing, true,
      "the transport-only refresh=1 URL must never become a second IndexedDB key");
    assert.equal(metrics.offlineCachedState.liked, false, "offline restart must retain the persisted list");
    assert.equal(metrics.offlineRetriedState.liked, true, "an offline cached restart must retry and converge when the server returns");
    assert.deepEqual(metrics.originState, {
      aria: "缓存收敛 origin-b，未点赞，10 个赞",
      count: "10",
      liked: false,
      videoId: "origin-b"
    }, "a delayed response from the previous server origin must not update the current model or DOM");
    assert.equal(metrics.emptyAfterClear, true, "cache invalidation must remove the matching persisted response before returning");
    assert.equal(metrics.emptyAfterLateWrite, true, "a pre-invalidation refresh/touch must not resurrect its response after clear completes");
    assert.equal(metrics.freshWriteAfterFence, true, "a post-invalidation request must use a new generation instead of deduplicating onto the rejected old refresh");
    assert.deepEqual(metrics.appendConvergence, {
      freshRendered: true,
      hasMore: false,
      ids: ["append-b", "append-a", "append-c"],
      liked: true,
      loadingMore: false,
      status: "",
      total: 3
    }, "initial revalidation must converge fresh actions/order without dropping a successful append or regressing its pagination envelope");
    assert.deepEqual(metrics.envelopeConvergence, {
      freshRendered: true,
      hasMore: true,
      total: 2
    }, "fresh pagination fields must replace the cached envelope and trigger a full render even when IDs are unchanged");
    assert.deepEqual(metrics.quotaNetworkData, {
      fromCache: false,
      liked: true
    }, "best-effort IndexedDB write failures must not reject successful server data");
    assert.deepEqual(metrics.staleUnhandled, [], "stale render guards must still install a rejection handler on live revalidation");
    assert.deepEqual(metrics.transactionCompletion, { resolved: true }, "cache transactions must resolve only from their completion event");
    assert.deepEqual(metrics.transactionAbort, { name: "AbortError", resolved: false }, "cache transaction aborts must reject with their transaction error");
    assert.deepEqual(metrics.transactionError, { name: "UnknownError", resolved: false }, "cache transaction errors must reject with their transaction error");
  } finally {
    await page.close();
  }
}

async function verifyAndroidColdRestartBootstrapConvergence(browser) {
  const context = await browser.newContext({ viewport: { width: 412, height: 820 } });
  const query = "cold-restart-action";
  const videoId = "cold-restart-video";
  const expectedPath = `/api/short-videos?${new URLSearchParams({
    q: query,
    source: "all",
    sort: "published",
    limit: "12",
    facets: "0",
    stats: "0"
  })}`;
  const transportRequests = [];
  let serverActions = { liked: false, collected: false };
  const staleActions = { liked: false, collected: false };
  let coldRequestStartedResolve;
  let releaseColdRequestResolve;
  const coldRequestStarted = new Promise((resolve) => { coldRequestStartedResolve = resolve; });
  const releaseColdRequest = new Promise((resolve) => { releaseColdRequestResolve = resolve; });
  let holdColdRequest = false;
  let refreshMode = "fresh";
  const feed = (actions = serverActions, envelope = {}) => ({
    videos: [{
      id: videoId,
      title: "冷启动缓存收敛",
      mediaType: "video",
      streamUrl: `/media/short-video/${videoId}`,
      actions: { ...actions },
      stats: {
        likes: actions.liked ? 11 : 10,
        collects: actions.collected ? 4 : 3
      }
    }],
    total: 1,
    hasMore: false,
    limit: 12,
    offset: 0,
    source: "all",
    sort: "published",
    ...envelope
  });

  await context.route((url) => url.pathname === "/api/short-videos" && url.searchParams.get("q") === query, async (route) => {
    const requestUrl = new URL(route.request().url());
    transportRequests.push(`${requestUrl.pathname}${requestUrl.search}`);
    if (holdColdRequest) {
      coldRequestStartedResolve();
      await releaseColdRequest;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(requestUrl.searchParams.get("refresh") === "1"
        ? refreshMode === "fresh"
          ? feed(serverActions)
          : feed(staleActions, refreshMode === "offline"
            ? { cached: true, stale: true, offline: true, cacheState: "offline" }
            : { cached: true, stale: true, cacheState: "stale-refreshing" })
        : feed(staleActions, { cached: true, stale: true, cacheState: "stale-refreshing" }))
    });
  });
  await context.addInitScript(({ initialQuery }) => {
    localStorage.setItem("fanhao.serverUrl", location.origin);
    localStorage.setItem("fanhao.android.lastView", JSON.stringify({
      view: "shortVideoSearch",
      params: { query: initialQuery, source: "all", sort: "published", tab: "all" },
      updatedAt: new Date().toISOString()
    }));
    globalThis.__coldRestartNativePayloads = [];
    globalThis.Capacitor = { Plugins: { FanHaoPlayer: {
      async playShortFeed(payload) {
        globalThis.__coldRestartNativePayloads.push(JSON.parse(payload.videos));
        return { serverBase: new URL(payload.baseUrl).origin, snapshots: [] };
      }
    } } };
    globalThis.__coldRestartUnhandled = [];
    window.addEventListener("unhandledrejection", (event) => {
      globalThis.__coldRestartUnhandled.push(String(event.reason?.message || event.reason || "unknown"));
    });
    globalThis.__coldRestartSamples = [];
    const sample = () => {
      const card = document.querySelector("[data-video-id='cold-restart-video'] .short-video-mobile-card");
      const like = document.querySelector("[data-video-id='cold-restart-video'] .short-video-mobile-thumb-metric");
      if (!card || !like) return;
      const value = {
        aria: card.getAttribute("aria-label") || "",
        liked: like.classList.contains("is-liked"),
        text: like.textContent || ""
      };
      const previous = globalThis.__coldRestartSamples.at(-1);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(value)) globalThis.__coldRestartSamples.push(value);
    };
    window.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(sample).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["aria-label", "class"],
        childList: true,
        subtree: true
      });
      sample();
    }, { once: true });
  }, { initialQuery: query });

  const firstPage = await context.newPage();
  const firstErrors = [];
  firstPage.on("pageerror", (error) => firstErrors.push(error?.message || String(error)));
  try {
    await firstPage.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    const firstCard = firstPage.locator(`[data-video-id='${videoId}']`);
    await firstCard.waitFor({ state: "visible", timeout: 10000 }).catch(async () => {
      assert.fail(`initial Android bootstrap did not render the cache seed: ${firstErrors.join(" | ")} / ${await firstPage.locator("#statusText").textContent()}`);
    });
    assert.equal(await firstPage.locator(`[data-video-id='${videoId}'] .short-video-mobile-thumb-metric`).evaluate((node) => node.classList.contains("is-liked")), false);
    await waitFor(
      () => firstPage.evaluate(async ({ requestPath }) => {
        const { CLIENT_VERSION } = await import("/android-client/js/config.js");
        const cache = await import(`/android-client/js/cache.js?v=${CLIENT_VERSION}`);
        const entry = await cache.readCachedJson(location.origin, requestPath);
        return entry?.payload?.videos?.[0]?.actions?.liked;
      }, { requestPath: expectedPath }),
      (liked) => liked === false,
      5000
    );
  } finally {
    await firstPage.close();
  }

  // The authoritative mutation occurs only after the first renderer is gone,
  // matching a Native PUT followed by force-stop before Activity result delivery.
  serverActions = { liked: true, collected: true };
  holdColdRequest = true;
  const coldPage = await context.newPage();
  const coldErrors = [];
  coldPage.on("pageerror", (error) => coldErrors.push(error?.message || String(error)));
  try {
    await coldPage.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    await coldRequestStarted;
    const coldCard = coldPage.locator(`[data-video-id='${videoId}']`);
    await coldCard.waitFor({ state: "visible", timeout: 10000 }).catch(async () => {
      assert.fail(`cold Android bootstrap did not render persisted data before revalidation: ${coldErrors.join(" | ")} / ${await coldPage.locator("#statusText").textContent()}`);
    });
    await coldCard.evaluate((node) => { node.dataset.coldRestartMount = "persisted"; });
    assert.equal(await coldPage.locator(`[data-video-id='${videoId}'] .short-video-mobile-thumb-metric`).evaluate((node) => node.classList.contains("is-liked")), false,
      "cold bootstrap must expose the persisted pre-Native action while its authoritative GET is pending");
    releaseColdRequestResolve();
    await coldPage.waitForFunction((id) => document.querySelector(`[data-video-id='${id}'] .short-video-mobile-thumb-metric`)?.classList.contains("is-liked"), videoId, { timeout: 5000 });
    const targetedStable = await coldCard.evaluate((node) => node.dataset.coldRestartMount === "persisted");
    await coldPage.locator(`[data-video-id='${videoId}'] .short-video-mobile-card`).click();
    await coldPage.waitForFunction(() => globalThis.__coldRestartNativePayloads.length > 0, null, { timeout: 5000 });
    const observed = await coldPage.evaluate(async ({ requestPath }) => {
      const { CLIENT_VERSION } = await import("/android-client/js/config.js");
      const cache = await import(`/android-client/js/cache.js?v=${CLIENT_VERSION}`);
      const entry = await cache.readCachedJson(location.origin, requestPath);
      const transportEntry = await cache.readCachedJson(location.origin, `${requestPath}&refresh=1`);
      return {
        cacheActions: entry?.payload?.videos?.[0]?.actions || null,
        nativeActions: globalThis.__coldRestartNativePayloads.at(-1)?.videos?.[0]?.actions || null,
        samples: globalThis.__coldRestartSamples,
        transportCacheMissing: transportEntry === null
      };
    }, { requestPath: expectedPath });
    assert.deepEqual(observed.cacheActions, { liked: true, collected: true }, "cold authoritative GET must replace the persisted action cache");
    assert.deepEqual(observed.nativeActions, { liked: true, collected: true }, "the actual bootstrap list model passed to Native must contain authoritative actions");
    assert(observed.samples.some((sample) => sample.liked === false), "cold bootstrap observability must capture the persisted false state");
    assert(observed.samples.some((sample) => sample.liked === true), "cold bootstrap observability must capture the authoritative apply");
    assert.equal(observed.transportCacheMissing, true, "cold authoritative data must not be persisted under its refresh=1 transport URL");
    assert.equal(targetedStable, true, "action-only cold convergence must patch the mounted card instead of rebuilding it");
    const authoritativePath = `${expectedPath}&refresh=1`;
    const authoritativeRequests = transportRequests.filter((requestPath) => requestPath === authoritativePath);
    assert.equal(authoritativeRequests.length, 2, "warm seed plus cold double-render must issue one authoritative exact-list GET per process");
    assert.equal(transportRequests.some((requestPath) => requestPath === expectedPath), false, "Android revalidation transport must bypass stale list cache with refresh=1");
    assert.deepEqual(coldErrors, [], "real Android bootstrap convergence must not raise page errors");

    // A server that can only return a stale/offline envelope is not authority.
    // Reboot the same real app route for both envelope variants and prove they
    // preserve the canonical model without leaking a background rejection.
    await coldPage.close();
    holdColdRequest = false;
    serverActions = { liked: true, collected: true };
    for (const rejectedMode of ["stale", "offline"]) {
      refreshMode = rejectedMode;
      const stalePage = await context.newPage();
      const staleErrors = [];
      stalePage.on("pageerror", (error) => staleErrors.push(error?.message || String(error)));
      try {
        await stalePage.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
        const staleCard = stalePage.locator(`[data-video-id='${videoId}']`);
        await staleCard.waitFor({ state: "visible", timeout: 10000 });
        await stalePage.waitForTimeout(900);
        assert.equal(await stalePage.locator(`[data-video-id='${videoId}'] .short-video-mobile-thumb-metric`).evaluate((node) => node.classList.contains("is-liked")), true,
          `${rejectedMode} authoritative retries must retain the last canonical true state instead of applying their stale false envelope`);
        await stalePage.locator(`[data-video-id='${videoId}'] .short-video-mobile-card`).click();
        await stalePage.waitForFunction(() => globalThis.__coldRestartNativePayloads.length > 0, null, { timeout: 5000 });
        const retained = await stalePage.evaluate(async ({ requestPath }) => {
          const { CLIENT_VERSION } = await import("/android-client/js/config.js");
          const cache = await import(`/android-client/js/cache.js?v=${CLIENT_VERSION}`);
          const entry = await cache.readCachedJson(location.origin, requestPath);
          const transportEntry = await cache.readCachedJson(location.origin, `${requestPath}&refresh=1`);
          return {
            cacheActions: entry?.payload?.videos?.[0]?.actions || null,
            nativeActions: globalThis.__coldRestartNativePayloads.at(-1)?.videos?.[0]?.actions || null,
            transportCacheMissing: transportEntry === null,
            unhandled: globalThis.__coldRestartUnhandled
          };
        }, { requestPath: expectedPath });
        assert.deepEqual(retained.cacheActions, { liked: true, collected: true }, `${rejectedMode} envelopes must not overwrite the canonical IndexedDB key`);
        assert.deepEqual(retained.nativeActions, { liked: true, collected: true }, `${rejectedMode} envelopes must not overwrite the model passed to Native`);
        assert.equal(retained.transportCacheMissing, true, `${rejectedMode} envelopes must not create a refresh=1 IndexedDB key`);
        assert.deepEqual(staleErrors, [], `${rejectedMode} retries must not raise page errors`);
        assert.deepEqual(retained.unhandled, [], `${rejectedMode} retries must keep their background rejection handled`);
      } finally {
        await stalePage.close();
      }
    }

    // Without any local response, the explicit server stale/offline payload is
    // still useful for temporary offline rendering. It must remain
    // non-authoritative: neither canonical nor transport cache keys may exist.
    const cacheClearingPage = await context.newPage();
    await cacheClearingPage.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
    await cacheClearingPage.evaluate(async () => {
      const { CLIENT_VERSION } = await import("/android-client/js/config.js");
      const cache = await import(`/android-client/js/cache.js?v=${CLIENT_VERSION}`);
      await cache.clearCachedData();
    });
    await cacheClearingPage.close();
    refreshMode = "offline";
    const noLocalPage = await context.newPage();
    const noLocalErrors = [];
    noLocalPage.on("pageerror", (error) => noLocalErrors.push(error?.message || String(error)));
    try {
      await noLocalPage.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
      const noLocalCard = noLocalPage.locator(`[data-video-id='${videoId}']`);
      await noLocalCard.waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await noLocalPage.locator(`[data-video-id='${videoId}'] .short-video-mobile-thumb-metric`).evaluate((node) => node.classList.contains("is-liked")), false,
        "no-local offline bootstrap may render the explicit non-authoritative server fallback instead of a blank screen");
      await noLocalPage.locator(`[data-video-id='${videoId}'] .short-video-mobile-card`).click();
      await noLocalPage.waitForFunction(() => globalThis.__coldRestartNativePayloads.length > 0, null, { timeout: 5000 });
      const noLocal = await noLocalPage.evaluate(async ({ requestPath }) => {
        const { CLIENT_VERSION } = await import("/android-client/js/config.js");
        const cache = await import(`/android-client/js/cache.js?v=${CLIENT_VERSION}`);
        return {
          canonical: await cache.readCachedJson(location.origin, requestPath),
          nativeActions: globalThis.__coldRestartNativePayloads.at(-1)?.videos?.[0]?.actions || null,
          transport: await cache.readCachedJson(location.origin, `${requestPath}&refresh=1`),
          unhandled: globalThis.__coldRestartUnhandled
        };
      }, { requestPath: expectedPath });
      assert.equal(noLocal.canonical, null, "a no-local offline fallback must not become the canonical IndexedDB response");
      assert.equal(noLocal.transport, null, "a no-local offline fallback must not create a refresh=1 IndexedDB response");
      assert.deepEqual(noLocal.nativeActions, { liked: false, collected: false }, "Native may receive the same temporary non-authoritative fallback shown by Web");
      assert.deepEqual(noLocalErrors, [], "no-local offline fallback must not raise page errors");
      assert.deepEqual(noLocal.unhandled, [], "no-local offline fallback must not leak an unhandled rejection");
    } finally {
      await noLocalPage.close();
    }

    refreshMode = "fresh";
    const recoveredPage = await context.newPage();
    try {
      await recoveredPage.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
      await recoveredPage.locator(`[data-video-id='${videoId}']`).waitFor({ state: "visible", timeout: 10000 });
      await recoveredPage.waitForFunction((id) => document.querySelector(`[data-video-id='${id}'] .short-video-mobile-thumb-metric`)?.classList.contains("is-liked"), videoId, { timeout: 5000 });
      const recovered = await recoveredPage.evaluate(async ({ requestPath }) => {
        const { CLIENT_VERSION } = await import("/android-client/js/config.js");
        const cache = await import(`/android-client/js/cache.js?v=${CLIENT_VERSION}`);
        const canonical = await cache.readCachedJson(location.origin, requestPath);
        const transport = await cache.readCachedJson(location.origin, `${requestPath}&refresh=1`);
        return {
          canonicalActions: canonical?.payload?.videos?.[0]?.actions || null,
          transport
        };
      }, { requestPath: expectedPath });
      assert.deepEqual(recovered.canonicalActions, { liked: true, collected: true }, "the next connected cold bootstrap must converge and persist authority");
      assert.equal(recovered.transport, null, "connected recovery must still preserve the single canonical IndexedDB key");
    } finally {
      await recoveredPage.close();
    }
  } finally {
    releaseColdRequestResolve?.();
    if (!coldPage.isClosed()) await coldPage.close();
    await context.close();
  }
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
      await page.locator(authorCardSelector).first().waitFor({ state: "visible", timeout: 30000 });
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
    const authorCards = page.locator(authorCardSelector);
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

async function verifyAndroidFavoriteFolders(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  try {
    await page.goto(`${baseUrl}/android-picker-fixture`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const { createFavoriteFolderFeature } = await import("/android-client/modules/fanhao/features/works/favorite-folders.js?browser-fixture=1");
      let activeUrl = "http://fixture-a.local";
      let folders = [
        { id: "default", name: "默认收藏", count: 1 },
        { id: "planned", name: "待观看", count: 0 }
      ];
      let postAttempts = 0;
      let putAttempts = 0;
      let failNextMove = true;
      let pendingList = null;
      let slowCreateResolve = null;
      let selectedFolderId = "";
      const calls = [];
      const work = { id: "work-1", favorite: true, favoriteFolderId: "default", favoriteFolderName: "默认收藏" };
      const feature = createFavoriteFolderFeature({
        api: async (base, requestPath, options = {}) => {
          const method = String(options.method || "GET").toUpperCase();
          calls.push(`${base} ${method} ${requestPath}`);
          if (requestPath === "/api/favorite-folders" && method === "GET") {
            if (pendingList) return pendingList.promise;
            return { folders: base.includes("fixture-b") ? [{ id: "b", name: "服务器 B", count: 0 }] : folders.map((folder) => ({ ...folder })) };
          }
          if (requestPath === "/api/favorite-folders" && method === "POST") {
            const name = String(options.body?.name || "");
            if (name === "慢速收藏") {
              return new Promise((resolve) => {
                slowCreateResolve = () => {
                  const folder = { id: "slow-folder", name, count: 0 };
                  folders = [...folders.filter((item) => item.id !== folder.id), folder];
                  resolve({ folder: { ...folder }, folders: folders.map((item) => ({ ...item })) });
                };
              });
            }
            postAttempts += 1;
            if (postAttempts === 1) throw Object.assign(new Error("fixture busy"), { status: 503, retryable: true });
            let folder = folders.find((item) => item.name === name);
            if (!folder) {
              folder = { id: `folder-${folders.length}`, name, count: 0 };
              folders = [...folders, folder];
            }
            return { folder: { ...folder }, folders: folders.map((item) => ({ ...item })), user: { favoriteCount: 1 } };
          }
          if (requestPath === "/api/favorites/work-1/folder" && method === "PUT") {
            putAttempts += 1;
            if (failNextMove) {
              failNextMove = false;
              throw new Error("fixture move failed");
            }
            const target = folders.find((folder) => folder.id === options.body?.folderId);
            folders = folders.map((folder) => ({
              ...folder,
              count: folder.id === "default" ? 0 : folder.id === target.id ? 1 : folder.count
            }));
            return {
              favorite: { folderId: target.id, folderName: target.name },
              folders: folders.map((folder) => ({ ...folder })),
              user: { favoriteCount: 1 }
            };
          }
          throw new Error(`unexpected favorite folder fixture request: ${method} ${requestPath}`);
        },
        clearCachedJsonByPrefix: async () => {},
        getActiveUrl: () => activeUrl,
        getLibrary: () => ({ works: [work] }),
        pageDataService: { invalidate() {} }
      });
      feature.rememberFolders(folders);
      const strip = feature.createFolderStrip("default", {
        onSelect(folderId) { selectedFolderId = folderId; }
      });
      document.getElementById("fixture").append(strip);
      let moveChangeCount = 0;
      window.androidFavoriteFolderFixture = {
        calls: () => [...calls],
        featureFolders: () => feature.folders(),
        finishSlowCreate: () => slowCreateResolve?.(),
        metrics: () => ({ postAttempts, putAttempts, selectedFolderId, work: { ...work }, moveChangeCount }),
        openMove() {
          feature.openMovePicker(work, { onMoved: () => { moveChangeCount += 1; } });
        },
        async startStaleListRace() {
          const callsBefore = calls.filter((call) => call.endsWith("GET /api/favorite-folders")).length;
          let release;
          const oldFolders = folders.map((folder) => ({ ...folder }));
          pendingList = {
            promise: new Promise((resolve) => {
              release = () => {
                pendingList = null;
                resolve({ folders: oldFolders });
              };
            })
          };
          const stale = feature.loadFolders(true);
          await Promise.resolve();
          await feature.createFolder("竞态新夹");
          release();
          await stale;
          return {
            folders: feature.folders(),
            getCount: calls.filter((call) => call.endsWith("GET /api/favorite-folders")).length - callsBefore
          };
        },
        async switchServer() {
          activeUrl = "http://fixture-b.local";
          await feature.loadFolders(true);
          return feature.folders();
        }
      };
    });

    const strip = page.locator(".favorite-folder-strip");
    await strip.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await strip.getAttribute("aria-label"), "收藏夹筛选", "Android favorite folders must expose a labelled navigation strip");
    assert.equal(await strip.locator("button.active").getAttribute("aria-pressed"), "true", "Android favorite folder selection must be announced");
    assert.equal(await strip.locator('button[aria-label^="默认收藏"]').getAttribute("aria-label"), "默认收藏，1 个作品", "Android favorite folders must render non-empty authoritative folder counts");
    await strip.locator(".favorite-folder-create").click();
    const createInput = page.locator(".favorite-folder-sheet input");
    await createInput.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await createInput.evaluate((element) => document.activeElement === element), true, "Android favorite folder dialogs must move focus inside immediately");
    assert.equal(await page.locator(".favorite-folder-sheet").getAttribute("role"), "dialog", "Android favorite folder forms must use dialog semantics");
    await createInput.fill("旅行收藏");
    await page.locator(".favorite-folder-form button").click();
    await page.locator(".favorite-folder-overlay").waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await strip.locator(".favorite-folder-create").evaluate((element) => document.activeElement === element), true, "closing Android favorite folder creation must restore focus to its trigger");
    let metrics = await page.evaluate(() => window.androidFavoriteFolderFixture.metrics());
    assert.equal(metrics.postAttempts, 2, "Android favorite folder creation must retry one explicitly retryable 503 and then stop");
    assert.equal(metrics.selectedFolderId, "folder-2", "new Android favorite folders must become the selected works-filter folder");

    await page.evaluate(() => window.androidFavoriteFolderFixture.openMove());
    await page.locator(".favorite-folder-options button", { hasText: "待观看" }).click();
    await page.locator(".favorite-folder-status", { hasText: "fixture move failed" }).waitFor({ state: "visible", timeout: 5000 });
    metrics = await page.evaluate(() => window.androidFavoriteFolderFixture.metrics());
    assert.equal(metrics.work.favoriteFolderId, "default", "failed Android favorite moves must roll the work back to its original folder");
    const callbacksAfterFailure = metrics.moveChangeCount;
    await page.locator(".favorite-folder-options button", { hasText: "待观看" }).click();
    await page.locator(".favorite-folder-overlay").waitFor({ state: "detached", timeout: 5000 });
    metrics = await page.evaluate(() => window.androidFavoriteFolderFixture.metrics());
    assert.equal(metrics.work.favoriteFolderId, "planned", "successful Android favorite moves must reconcile the detail work state");
    assert.equal(metrics.moveChangeCount, callbacksAfterFailure + 1, "successful Android favorite moves must notify their UI exactly once");

    const staleListRace = await page.evaluate(() => window.androidFavoriteFolderFixture.startStaleListRace());
    assert(staleListRace.folders.some((folder) => folder.name === "竞态新夹"), "an older folder GET must not overwrite a newer Android create response");
    assert.equal(staleListRace.getCount, 2, "a mutation completed behind an initial Android folder GET must force one newer authoritative GET");
    const serverBFolders = await page.evaluate(() => window.androidFavoriteFolderFixture.switchServer());
    assert.deepEqual(serverBFolders.map((folder) => folder.id), ["b"], "Android favorite folder state must be partitioned by active server");

    await strip.locator(".favorite-folder-create").click();
    await createInput.waitFor({ state: "visible", timeout: 5000 });
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.locator(".favorite-folder-form button").evaluate((element) => document.activeElement === element), true, "Android favorite folder dialogs must wrap reverse Tab focus inside the modal");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".favorite-folder-sheet > header > button").evaluate((element) => document.activeElement === element), true, "Android favorite folder dialogs must wrap forward Tab focus inside the modal");
    await page.keyboard.press("Escape");
    await page.locator(".favorite-folder-overlay").waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await strip.locator(".favorite-folder-create").evaluate((element) => document.activeElement === element), true, "escaping Android favorite folder dialogs must restore focus to their trigger");

    await strip.locator(".favorite-folder-create").click();
    await createInput.fill("慢速收藏");
    await page.locator(".favorite-folder-form button").click();
    await page.waitForFunction(() => document.querySelector(".favorite-folder-sheet input")?.disabled === true, null, { timeout: 5000 });
    assert.equal(await page.locator(".favorite-folder-sheet > header > button").evaluate((element) => document.activeElement === element), true, "pending Android favorite mutations must move focus to an enabled dialog control");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".favorite-folder-sheet").evaluate((panel) => panel.contains(document.activeElement)), true, "pending Android favorite mutations must keep Tab focus inside the dialog");
    await page.keyboard.press("Escape");
    await page.locator(".favorite-folder-overlay").waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await strip.locator(".favorite-folder-create").evaluate((element) => document.activeElement === element), true, "pending Android favorite mutations must keep Escape and trigger restoration active");
    await page.evaluate(() => window.androidFavoriteFolderFixture.finishSlowCreate());

    const mutationRace = await page.evaluate(async () => {
      const [{ createFavoriteFolderFeature }, { createWorkActions }] = await Promise.all([
        import("/android-client/modules/fanhao/features/works/favorite-folders.js?mutation-race=2"),
        import("/android-client/modules/fanhao/features/works/actions.js?mutation-race=2")
      ]);
      const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((accept, decline) => {
          resolve = accept;
          reject = decline;
        });
        return { promise, reject, resolve };
      };
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
      const waitFor = async (predicate) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if (predicate()) return;
          await tick();
        }
        throw new Error("favorite mutation fixture timed out");
      };
      const defaultFolder = { id: "default", name: "默认收藏", count: 1 };
      const plannedFolder = { id: "planned", name: "待观看", count: 0 };
      const newFolder = { id: "new", name: "竞态新夹", count: 0 };

      const createReply = deferred();
      const toggleReply = deferred();
      const createFeature = createFavoriteFolderFeature({
        api: async (_base, requestPath, options = {}) => {
          if (requestPath === "/api/favorite-folders" && options.method === "POST") return createReply.promise;
          if (requestPath === "/api/favorite-folders") return { folders: [defaultFolder, plannedFolder, newFolder] };
          if (requestPath === "/api/favorites/create-work") return toggleReply.promise;
          throw new Error(`unexpected create race request: ${requestPath}`);
        },
        clearCachedJsonByPrefix: async () => {},
        getActiveUrl: () => "http://create-race.local",
        getLibrary: () => ({ works: [] }),
        pageDataService: { invalidate() {} }
      });
      createFeature.rememberFolders([defaultFolder, plannedFolder]);
      const createWork = { id: "create-work", favorite: false };
      const creating = createFeature.createFolder("竞态新夹");
      const toggling = createFeature.toggleFavorite(createWork);
      createReply.resolve({ folder: newFolder, folders: [defaultFolder, plannedFolder, newFolder] });
      await creating;
      toggleReply.resolve({ favorite: true, favoriteFolder: { folderId: "default", folderName: "默认收藏" }, folders: [defaultFolder, plannedFolder] });
      await toggling;
      await tick();

      const firstMoveReply = deferred();
      const secondMoveReply = deferred();
      let serializedMoveCalls = 0;
      const rollbackFeature = createFavoriteFolderFeature({
        api: async (_base, requestPath, options = {}) => {
          if (requestPath === "/api/favorite-folders") return { folders: [defaultFolder, plannedFolder, newFolder] };
          if (requestPath === "/api/favorites/rollback-work/folder") {
            serializedMoveCalls += 1;
            return options.body?.folderId === "planned" ? firstMoveReply.promise : secondMoveReply.promise;
          }
          throw new Error(`unexpected rollback race request: ${requestPath}`);
        },
        clearCachedJsonByPrefix: async () => {},
        getActiveUrl: () => "http://rollback-race.local",
        getLibrary: () => ({ works: [] }),
        pageDataService: { invalidate() {} }
      });
      rollbackFeature.rememberFolders([defaultFolder, plannedFolder, newFolder]);
      const rollbackWork = { id: "rollback-work", favorite: true, favoriteFolderId: "default", favoriteFolderName: "默认收藏" };
      const firstMove = rollbackFeature.moveFavorite(rollbackWork, "planned").catch(() => {});
      const secondMove = rollbackFeature.moveFavorite(rollbackWork, "new").catch(() => {});
      await tick();
      const callsBeforeFirstSettled = serializedMoveCalls;
      firstMoveReply.reject(new Error("first move failed"));
      await firstMove;
      await waitFor(() => serializedMoveCalls === 2);
      secondMoveReply.reject(new Error("second move failed"));
      await secondMove;
      await tick();

      const actionToggleReply = deferred();
      const actionMoveReply = deferred();
      let actionMoveCalls = 0;
      const actionWork = { id: "action-work", favorite: true, favoriteFolderId: "default", favoriteFolderName: "默认收藏" };
      const actionFeature = createFavoriteFolderFeature({
        api: async (_base, requestPath) => {
          if (requestPath === "/api/favorite-folders") return { folders: [{ ...defaultFolder, count: 0 }, { ...plannedFolder, count: 1 }] };
          if (requestPath === "/api/favorites/action-work") return actionToggleReply.promise;
          if (requestPath === "/api/favorites/action-work/folder") {
            actionMoveCalls += 1;
            return actionMoveReply.promise;
          }
          throw new Error(`unexpected action race request: ${requestPath}`);
        },
        clearCachedJsonByPrefix: async () => {},
        getActiveUrl: () => "http://action-race.local",
        getLibrary: () => ({ works: [actionWork] }),
        pageDataService: { invalidate() {} }
      });
      actionFeature.rememberFolders([defaultFolder, plannedFolder]);
      const actionMessages = [];
      const actions = createWorkActions({
        detailErrorMessage: (error) => error.message,
        extractWorkCode: () => "",
        favoriteFolders: actionFeature,
        formatNumber: String,
        getActiveUrl: () => "http://action-race.local",
        renderMessage: (message) => actionMessages.push(message),
        renderWorkDetail() {}
      });
      const actionRow = actions.createActionRow(actionWork);
      document.body.append(actionRow);
      actionRow.querySelector(".favorite-action").click();
      await tick();
      const queuedMove = actionFeature.moveFavorite(actionWork, "planned");
      await tick();
      const actionCallsBeforeToggleFailed = actionMoveCalls;
      actionToggleReply.reject(new Error("old toggle failed"));
      await waitFor(() => actionMoveCalls === 1);
      actionMoveReply.resolve({
        favorite: { folderId: "planned", folderName: "待观看" },
        folders: [{ ...defaultFolder, count: 0 }, { ...plannedFolder, count: 1 }]
      });
      await queuedMove;
      await tick();
      actionRow.remove();

      const firstUserReply = deferred();
      const secondUserReply = deferred();
      const userUpdates = [];
      const userWorks = [{ id: "user-1", favorite: false }, { id: "user-2", favorite: false }];
      const userFeature = createFavoriteFolderFeature({
        api: async (_base, requestPath) => {
          if (requestPath === "/api/favorites/user-1") return firstUserReply.promise;
          if (requestPath === "/api/favorites/user-2") return secondUserReply.promise;
          if (requestPath === "/api/favorite-folders") return { folders: [{ ...defaultFolder, count: 1 }] };
          throw new Error(`unexpected user race request: ${requestPath}`);
        },
        clearCachedJsonByPrefix: async () => {},
        getActiveUrl: () => "http://user-race.local",
        getLibrary: () => ({ works: userWorks }),
        onUserStateChange: (user) => userUpdates.push({ ...user }),
        pageDataService: { invalidate() {} }
      });
      userFeature.rememberFolders([{ ...defaultFolder, count: 0 }]);
      userUpdates.length = 0;
      const firstUserMutation = userFeature.toggleFavorite(userWorks[0]);
      const secondUserMutation = userFeature.toggleFavorite(userWorks[1]).catch(() => {});
      await tick();
      secondUserReply.reject(new Error("second user mutation failed"));
      await secondUserMutation;
      firstUserReply.resolve({
        favorite: true,
        favoriteFolder: { folderId: "default", folderName: "默认收藏" },
        folders: [{ ...defaultFolder, count: 1 }],
        user: { favoriteCount: 1 }
      });
      await firstUserMutation;
      await waitFor(() => userUpdates.some((user) => user.favoriteCount === 1));

      const refreshReplies = [];
      let refreshGetCalls = 0;
      const refreshFeature = createFavoriteFolderFeature({
        api: async (_base, requestPath, options = {}) => {
          if (requestPath === "/api/favorite-folders" && options.method === "POST") {
            const id = String(options.body?.name || "").toLowerCase();
            const folder = { id, name: options.body.name, count: 0 };
            return { folder, folders: [{ ...defaultFolder, count: 0 }, folder] };
          }
          if (requestPath === "/api/favorite-folders") {
            refreshGetCalls += 1;
            const reply = deferred();
            refreshReplies.push(reply);
            return reply.promise;
          }
          throw new Error(`unexpected refresh race request: ${requestPath}`);
        },
        clearCachedJsonByPrefix: async () => {},
        getActiveUrl: () => "http://refresh-race.local",
        pageDataService: { invalidate() {} }
      });
      refreshFeature.rememberFolders([{ ...defaultFolder, count: 0 }]);
      await refreshFeature.createFolder("B");
      await waitFor(() => refreshGetCalls === 1);
      await refreshFeature.createFolder("C");
      refreshReplies[0].resolve({ folders: [defaultFolder, { id: "b", name: "B", count: 0 }] });
      await waitFor(() => refreshGetCalls === 2);
      refreshReplies[1].resolve({ folders: [{ ...defaultFolder, count: 1 }, { id: "b", name: "B", count: 0 }, { id: "c", name: "C", count: 0 }] });
      await waitFor(() => refreshFeature.folders().find((folder) => folder.id === "default")?.count === 1);
      await tick();
      await refreshFeature.createFolder("D");
      await waitFor(() => refreshGetCalls === 3);
      refreshReplies[2].reject(new Error("authoritative refresh failed"));
      await tick();
      await tick();
      const refreshCallsAfterFailure = refreshGetCalls;
      await refreshFeature.createFolder("E");
      await waitFor(() => refreshGetCalls === 4);
      refreshReplies[3].resolve({ folders: [{ ...defaultFolder, count: 2 }, { id: "b", name: "B", count: 0 }, { id: "c", name: "C", count: 0 }, { id: "d", name: "D", count: 0 }, { id: "e", name: "E", count: 0 }] });
      await waitFor(() => refreshFeature.folders().find((folder) => folder.id === "default")?.count === 2);

      let activeScope = "http://scope-a.local";
      const scopeAFolder = { id: "a-default", name: "A 默认", count: 1 };
      const scopeAPlannedFolder = { id: "a-planned", name: "A 待观看", count: 0 };
      const createScopeFeature = (replies, libraries) => createFavoriteFolderFeature({
        api: async (_base, requestPath) => {
          if (requestPath === "/api/favorite-folders") return { folders: [scopeAFolder, scopeAPlannedFolder] };
          const reply = replies.get(requestPath);
          if (reply) return reply.promise;
          throw new Error(`unexpected scope race request: ${requestPath}`);
        },
        clearCachedJsonByPrefix: async () => {},
        getActiveUrl: () => activeScope,
        getLibrary: () => libraries.get(activeScope),
        pageDataService: { invalidate() {} }
      });
      const scopeAToggleReply = deferred();
      const scopeToggleCallbacks = [];
      const scopeToggleAWork = { id: "shared-work", favorite: false, favoriteFolderId: "", favoriteFolderName: "" };
      const scopeToggleBWork = { id: "shared-work", favorite: true, favoriteFolderId: "b-only", favoriteFolderName: "B 专属" };
      const scopeToggleLibraries = new Map([
        ["http://scope-a.local", { works: [scopeToggleAWork] }],
        ["http://scope-b.local", { works: [scopeToggleBWork] }]
      ]);
      const scopeToggleFeature = createScopeFeature(new Map([["/api/favorites/shared-work", scopeAToggleReply]]), scopeToggleLibraries);
      const scopeToggle = scopeToggleFeature.toggleFavorite(scopeToggleAWork, () => scopeToggleCallbacks.push(activeScope)).catch((error) => error.message);
      await tick();
      activeScope = "http://scope-b.local";
      scopeAToggleReply.resolve({ favorite: true, favoriteFolder: { folderId: "a-default", folderName: "A 默认" } });
      const scopeToggleError = await scopeToggle;

      activeScope = "http://scope-a.local";
      const scopeAMoveReply = deferred();
      const scopeMoveCallbacks = [];
      const scopeMoveAWork = { id: "shared-work", favorite: true, favoriteFolderId: "a-default", favoriteFolderName: "A 默认" };
      const scopeMoveBWork = { id: "shared-work", favorite: true, favoriteFolderId: "b-only", favoriteFolderName: "B 专属" };
      const scopeMoveLibraries = new Map([
        ["http://scope-a.local", { works: [scopeMoveAWork] }],
        ["http://scope-b.local", { works: [scopeMoveBWork] }]
      ]);
      const scopeMoveFeature = createScopeFeature(new Map([["/api/favorites/shared-work/folder", scopeAMoveReply]]), scopeMoveLibraries);
      scopeMoveFeature.rememberFolders([scopeAFolder, scopeAPlannedFolder]);
      const scopeMove = scopeMoveFeature.moveFavorite(scopeMoveAWork, "a-planned", () => scopeMoveCallbacks.push(activeScope)).catch((error) => error.message);
      await tick();
      activeScope = "http://scope-b.local";
      scopeAMoveReply.reject(new Error("A move failed"));
      const scopeMoveError = await scopeMove;

      activeScope = "http://scope-a.local";
      const queuedFirstReply = deferred();
      const queuedCallbacks = [];
      const queuedAWork = { id: "shared-work", favorite: true, favoriteFolderId: "a-default", favoriteFolderName: "A 默认" };
      const queuedBWork = { id: "shared-work", favorite: true, favoriteFolderId: "b-only", favoriteFolderName: "B 专属" };
      const queuedLibraries = new Map([
        ["http://scope-a.local", { works: [queuedAWork] }],
        ["http://scope-b.local", { works: [queuedBWork] }]
      ]);
      const queuedFeature = createScopeFeature(new Map([["/api/favorites/shared-work/folder", queuedFirstReply]]), queuedLibraries);
      queuedFeature.rememberFolders([scopeAFolder, scopeAPlannedFolder]);
      const queuedFirstMove = queuedFeature.moveFavorite(queuedAWork, "a-planned", () => queuedCallbacks.push(activeScope)).catch((error) => error.message);
      const queuedSecondMove = queuedFeature.moveFavorite(queuedAWork, "a-default", () => queuedCallbacks.push(activeScope)).catch((error) => error.message);
      await tick();
      activeScope = "http://scope-b.local";
      queuedFirstReply.reject(new Error("A first move failed"));
      const [queuedFirstError, queuedSecondError] = await Promise.all([queuedFirstMove, queuedSecondMove]);

      return {
        folders: createFeature.folders().map((folder) => folder.id),
        rollbackWork: { ...rollbackWork },
        callsBeforeFirstSettled,
        actionCallsBeforeToggleFailed,
        actionMessages,
        actionWork: { ...actionWork },
        userUpdates,
        refreshCallsAfterFailure,
        refreshGetCalls,
        refreshFolders: refreshFeature.folders(),
        scopeMoveAWork: { ...scopeMoveAWork },
        scopeMoveBWork: { ...scopeMoveBWork },
        scopeMoveCallbacks,
        scopeMoveError,
        scopeToggleAWork: { ...scopeToggleAWork },
        scopeToggleBWork: { ...scopeToggleBWork },
        scopeToggleCallbacks,
        scopeToggleError,
        queuedAWork: { ...queuedAWork },
        queuedBWork: { ...queuedBWork },
        queuedCallbacks,
        queuedFirstError,
        queuedSecondError
      };
    });
    assert(mutationRace.folders.includes("new"), "an older Android mutation response must merge instead of removing a concurrently created folder");
    assert.equal(mutationRace.folders.filter((folderId) => folderId === "new").length, 1, "Android create responses must not duplicate a folder returned in both folder and folders");
    assert.equal(mutationRace.callsBeforeFirstSettled, 1, "same-work Android favorite mutations must serialize their requests");
    assert.equal(mutationRace.rollbackWork.favoriteFolderId, "default", "two failed serialized Android moves must converge to the original work folder");
    assert.equal(mutationRace.actionCallsBeforeToggleFailed, 0, "a later Android move must wait for the earlier same-work toggle");
    assert.equal(mutationRace.actionWork.favorite, true, "an older failed Android toggle must not reapply an outer rollback after a later move succeeds");
    assert.equal(mutationRace.actionWork.favoriteFolderId, "planned", "an older failed Android toggle must preserve the later successful folder move");
    assert(mutationRace.actionMessages.includes("old toggle failed"), "serialized Android favorite failures must remain visible to the user");
    assert(mutationRace.userUpdates.some((user) => user.favoriteCount === 1 && Object.keys(user).length === 1), "authoritative Android folder refreshes must publish a partial favorite count after mixed mutation outcomes");
    assert.equal(mutationRace.refreshCallsAfterFailure, 3, "a failed Android favorite refresh must pause instead of retrying forever");
    assert.equal(mutationRace.refreshGetCalls, 4, "Android favorite refreshes must follow stale and failed GETs with the next required authoritative request");
    assert.equal(new Set(mutationRace.refreshFolders.map((folder) => folder.id)).size, mutationRace.refreshFolders.length, "Android authoritative favorite state must not retain duplicate folders");
    assert.equal(mutationRace.refreshFolders.find((folder) => folder.id === "default")?.count, 2, "Android favorite counts must converge to the final authoritative refresh");
    assert.equal(mutationRace.scopeToggleError, "服务器已切换，请重新操作", "a successful old-server toggle response must become a scope-switch failure");
    assert.deepEqual(mutationRace.scopeToggleAWork, { id: "shared-work", favorite: false, favoriteFolderId: "", favoriteFolderName: "" }, "an old-server toggle must restore its passed work object after a scope switch");
    assert.deepEqual(mutationRace.scopeToggleBWork, { id: "shared-work", favorite: true, favoriteFolderId: "b-only", favoriteFolderName: "B 专属" }, "an old-server toggle must not sync a same-ID work in the current server library");
    assert.deepEqual(mutationRace.scopeToggleCallbacks, ["http://scope-a.local"], "an old-server toggle must not call a UI callback after scope switch");
    assert.equal(mutationRace.scopeMoveError, "A move failed", "a failed old-server move must preserve its request failure after a scope switch");
    assert.deepEqual(mutationRace.scopeMoveAWork, { id: "shared-work", favorite: true, favoriteFolderId: "a-default", favoriteFolderName: "A 默认" }, "an old-server move must restore its passed work object after a scope switch");
    assert.deepEqual(mutationRace.scopeMoveBWork, { id: "shared-work", favorite: true, favoriteFolderId: "b-only", favoriteFolderName: "B 专属" }, "an old-server move must not sync a same-ID work in the current server library");
    assert.deepEqual(mutationRace.scopeMoveCallbacks, ["http://scope-a.local"], "an old-server move must not call a UI callback after scope switch");
    assert.equal(mutationRace.queuedFirstError, "A first move failed", "an in-flight old-server move must preserve its request failure after the server changes");
    assert.equal(mutationRace.queuedSecondError, "服务器已切换，请重新操作", "a queued old-server move must reject before applying optimistic state after the server changes");
    assert.deepEqual(mutationRace.queuedAWork, { id: "shared-work", favorite: true, favoriteFolderId: "a-default", favoriteFolderName: "A 默认" }, "a queued old-server move must leave the passed work restored instead of optimistic");
    assert.deepEqual(mutationRace.queuedBWork, { id: "shared-work", favorite: true, favoriteFolderId: "b-only", favoriteFolderName: "B 专属" }, "queued old-server moves must not mutate the current server library");
    assert.deepEqual(mutationRace.queuedCallbacks, ["http://scope-a.local"], "queued old-server moves must not call a current-server UI callback");

    const cacheScopeRace = await page.evaluate(async () => {
      const { CLIENT_VERSION } = await import("/android-client/js/config.js");
      const [{ createFavoriteFolderFeature }, { createWorkActions }, cache] = await Promise.all([
        import("/android-client/modules/fanhao/features/works/favorite-folders.js?cache-scope-race=3"),
        import("/android-client/modules/fanhao/features/works/actions.js?cache-scope-race=3"),
        import(`/android-client/js/cache.js?v=${CLIENT_VERSION}`)
      ]);
      const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((accept, decline) => {
          resolve = accept;
          reject = decline;
        });
        return { promise, reject, resolve };
      };
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
      const waitForAsync = async (predicate) => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const value = await predicate();
          if (value) return value;
          await tick();
        }
        throw new Error("favorite cache scope fixture timed out");
      };
      const scopeA = "http://cache-scope-a.local";
      const scopeB = "http://cache-scope-b.local";
      const cachePath = "/api/works/cache-shared-work";
      const scopeBSentinel = {
        sentinel: "scope-b",
        work: { id: "cache-shared-work", favorite: false, favoriteFolderId: "b-only", favoriteFolderName: "B 专属", title: "B sentinel" }
      };
      let activeUrl = `${scopeA}/`;
      const invalidationEntered = deferred();
      const invalidationRelease = deferred();
      let heldInvalidation = false;
      const scopeAWork = { id: "cache-shared-work", favorite: false, favoriteFolderId: "", favoriteFolderName: "", title: "A work" };
      const cacheFeature = createFavoriteFolderFeature({
        api: async (_base, requestPath) => {
          if (requestPath === "/api/favorites/cache-shared-work") {
            return { favorite: true, favoriteFolder: { folderId: "a-default", folderName: "A 默认" }, folders: [] };
          }
          if (requestPath === "/api/favorite-folders") return { folders: [] };
          throw new Error(`unexpected cache scope request: ${requestPath}`);
        },
        clearCachedJsonByPrefix: async (baseUrl, prefix) => {
          if (!heldInvalidation) {
            heldInvalidation = true;
            invalidationEntered.resolve({ baseUrl, prefix });
            await invalidationRelease.promise;
          }
          return cache.clearCachedJsonByPrefix(baseUrl, prefix);
        },
        getActiveUrl: () => activeUrl,
        getLibrary: () => ({ works: [scopeAWork] }),
        pageDataService: { invalidate() {} }
      });
      const cacheActions = createWorkActions({
        detailErrorMessage: (error) => error.message,
        extractWorkCode: () => "",
        favoriteFolders: cacheFeature,
        formatNumber: String,
        getActiveUrl: () => activeUrl,
        renderMessage() {},
        renderWorkDetail() {}
      });
      const cacheRow = cacheActions.createActionRow(scopeAWork);
      document.body.append(cacheRow);
      cacheRow.querySelector(".favorite-action").click();
      const enteredInvalidation = await invalidationEntered.promise;
      activeUrl = `${scopeB}/`;
      await cache.writeCachedJson(scopeB, cachePath, scopeBSentinel);
      invalidationRelease.resolve();
      await waitForAsync(() => !cacheRow.querySelector(".favorite-action").classList.contains("pending"));
      const scopeACache = await waitForAsync(async () => {
        const entry = await cache.readCachedJson(scopeA, cachePath);
        return entry?.payload?.work?.favorite === true ? entry : null;
      });
      const scopeBCache = await cache.readCachedJson(scopeB, cachePath);
      cacheRow.remove();

      const rejectScope = "http://cache-reject.local";
      const rejectPath = "/api/works/cache-reject-work";
      const rejectSentinel = {
        sentinel: "reject-unchanged",
        work: { id: "cache-reject-work", favorite: false, title: "reject sentinel" }
      };
      activeUrl = `${rejectScope}/`;
      await cache.writeCachedJson(rejectScope, rejectPath, rejectSentinel);
      let rejectInvalidations = 0;
      const rejectWork = { id: "cache-reject-work", favorite: false, favoriteFolderId: "", favoriteFolderName: "" };
      const rejectFeature = createFavoriteFolderFeature({
        api: async (_base, requestPath) => {
          if (requestPath === "/api/favorites/cache-reject-work") throw new Error("favorite feature rejected");
          throw new Error(`unexpected reject cache request: ${requestPath}`);
        },
        clearCachedJsonByPrefix: async () => {
          rejectInvalidations += 1;
        },
        getActiveUrl: () => activeUrl,
        getLibrary: () => ({ works: [rejectWork] }),
        pageDataService: { invalidate() {} }
      });
      const rejectMessages = [];
      const rejectActions = createWorkActions({
        detailErrorMessage: (error) => error.message,
        extractWorkCode: () => "",
        favoriteFolders: rejectFeature,
        formatNumber: String,
        getActiveUrl: () => activeUrl,
        renderMessage: (message) => rejectMessages.push(message),
        renderWorkDetail() {}
      });
      const rejectRow = rejectActions.createActionRow(rejectWork);
      document.body.append(rejectRow);
      rejectRow.querySelector(".favorite-action").click();
      await waitForAsync(() => rejectMessages.includes("favorite feature rejected"));
      await tick();
      const rejectCache = await cache.readCachedJson(rejectScope, rejectPath);
      rejectRow.remove();

      return {
        enteredInvalidation,
        rejectCache: rejectCache?.payload,
        rejectInvalidations,
        scopeACache: scopeACache?.payload,
        scopeBCache: scopeBCache?.payload,
        scopeBSentinel
      };
    });
    assert.deepEqual(cacheScopeRace.enteredInvalidation, { baseUrl: "http://cache-scope-a.local", prefix: "/api/favorites" }, "the cache race fixture must switch servers only after the successful A response reaches cache invalidation");
    assert.equal(cacheScopeRace.scopeACache.work.favorite, true, "a successful A favorite action may update its captured A detail cache after switching to B");
    assert.equal(cacheScopeRace.scopeACache.work.favoriteFolderId, "a-default", "the captured A detail cache must receive the successful A favorite folder");
    assert.deepEqual(cacheScopeRace.scopeBCache, cacheScopeRace.scopeBSentinel, "a completed A favorite action must leave the same-ID B detail cache completely unchanged");
    assert.deepEqual(cacheScopeRace.rejectCache, { sentinel: "reject-unchanged", work: { id: "cache-reject-work", favorite: false, title: "reject sentinel" } }, "a rejected favorite feature must not write the cached work detail");
    assert.equal(cacheScopeRace.rejectInvalidations, 0, "a rejected favorite feature must not start cache invalidation");
  } finally {
    await page.close();
  }
}

async function verifyAndroidFavoriteRoute(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error?.message || String(error)));
  try {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
      localStorage.setItem("fanhao.android.workFilter", "favorite");
    });
    fixtureFanhaoCollectionRequests.length = 0;
    await page.goto(`${baseUrl}/android-client/index.html#works?favorite=1`, { waitUntil: "domcontentloaded" });
    const title = page.locator(".fanhao-feed-appbar-title", { hasText: "收藏" });
    await title.waitFor({ state: "visible", timeout: 10000 }).catch(async () => {
      assert.fail(`Android favorite route fixture did not boot: ${pageErrors.join(" | ")} / ${await page.locator("#statusText").textContent()}`);
    });
    const settings = page.locator("#settingsOverlay");
    if (await settings.isVisible()) {
      await page.locator("#settingsCloseButton").click();
      await settings.waitFor({ state: "hidden", timeout: 5000 });
    }
    assert.equal(await page.locator(".fanhao-chrome-tabs").count(), 0, "Android FanHao must not restore the removed root partition row on favorite deep routes");
    assert.equal(await title.textContent(), "收藏", "Android favorite deep routes must keep a clear native app-bar title");
    assert.equal(await page.locator("#favoriteCount").textContent(), "0", "Android home shortcut must render the empty favorite count from user state");
    await page.locator(".favorite-folder-strip").waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".message-box", { hasText: "还没有收藏作品" }).waitFor({ state: "visible", timeout: 5000 });
    const firstRequest = fixtureFanhaoCollectionRequests.find((requestPath) => requestPath.startsWith("/api/favorites?"));
    assert(firstRequest, "Android favorite entry must request the favorite collection endpoint");
    assert.equal(new URL(firstRequest, baseUrl).searchParams.get("filter"), "all", "a legacy persisted favorite filter must not leak into the folder collection state");
    assert.equal(fixtureFanhaoCollectionRequests.some((requestPath) => requestPath.startsWith("/api/works?")), false, "Android favorite folders must not start a competing works request");

    await page.locator('.favorite-folder-strip button[aria-label^="默认收藏"]').click();
    await page.waitForFunction(() => location.hash === "#works?favorite=1&folder=default", null, { timeout: 5000 });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.hash === "#works?favorite=1", null, { timeout: 5000 });
    assert.equal(await page.locator('.favorite-folder-strip button[aria-label^="全部"]').getAttribute("aria-pressed"), "true", "Android back navigation must restore the prior favorite folder selection");
  } finally {
    await page.close();
  }
}

async function verifyAndroidFavoriteServerSwitch(browser) {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
  let releaseOldFavorite;
  let oldFavoriteStarted;
  const serverBRequests = [];
  const oldFavoriteReply = new Promise((resolve) => { releaseOldFavorite = resolve; });
  const oldFavoriteRequest = new Promise((resolve) => { oldFavoriteStarted = resolve; });
  const response = (payload) => ({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(payload)
  });
  try {
    await page.route((url) => url.origin === new URL(baseUrl).origin && url.pathname === "/api/favorites", async (route) => {
      oldFavoriteStarted();
      await oldFavoriteReply;
      await route.fulfill(response({
        count: 0,
        facets: { all: 0 },
        folders: [{ id: "old", name: "旧服务器", count: 0 }],
        selectedFolderId: "all",
        total: 0,
        works: []
      })).catch(() => {});
    });
    await page.route((url) => url.origin === "http://favorite-server-b.local:29998", (route) => {
      serverBRequests.push(route.request().url());
      if (new URL(route.request().url()).pathname !== "/api/favorites") return route.fulfill(response({ ok: true }));
      return route.fulfill(response({
        count: 0,
        facets: { all: 0 },
        folders: [{ id: "new", name: "新服务器", count: 0 }],
        selectedFolderId: "all",
        total: 0,
        works: []
      }));
    });
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("fanhao.serverUrl", location.origin);
    });
    await page.goto(`${baseUrl}/android-client/index.html#works?favorite=1`, { waitUntil: "domcontentloaded" });
    await page.locator(".fanhao-feed-appbar-title", { hasText: "收藏" }).waitFor({ state: "visible", timeout: 10000 });
    const settings = page.locator("#settingsOverlay");
    if (await settings.isVisible()) await page.locator("#settingsCloseButton").click();
    await oldFavoriteRequest;
    await page.evaluate(() => document.querySelector("#profileSettingsButton")?.click());
    await settings.waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#serverUrl").fill("http://favorite-server-b.local:29998");
    await page.locator("#connectForm button[type='submit']").click();
    await page.locator('.favorite-folder-strip button[aria-label^="新服务器"]').waitFor({ state: "visible", timeout: 10000 }).catch(() => {
      assert.fail(`switching Android servers must request and render the new favorite collection: ${serverBRequests.join(" | ")}`);
    });
    releaseOldFavorite();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('.favorite-folder-strip button[aria-label^="旧服务器"]').count(), 0, "switching Android servers must prevent an older favorite GET from rendering over the new server state");
  } finally {
    releaseOldFavorite?.();
    await page.close();
  }
}

async function verifyShortVideoCollections(browser) {
  fixtureCollections.clear();
  fixtureCollectionSequence = 0;
  fixtureCollectionDetailRequests.length = 0;
  fixtureCollectionPageRequests.length = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/short-videos`, { waitUntil: "domcontentloaded" });
    const firstCard = page.locator(".short-video-card .short-video-thumb-open").first();
    await firstCard.waitFor({ state: "visible", timeout: 30000 });
    await firstCard.click();
    const addToCollection = page.locator(".short-video-rail-button.is-collection");
    await addToCollection.waitFor({ state: "visible", timeout: 30000 });
    await addToCollection.click();
    let picker = page.locator(".short-video-collection-picker");
    await picker.waitFor({ state: "visible", timeout: 5000 });
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await addToCollection.evaluate((element) => document.activeElement === element), true, "Escape must close the picker and restore its trigger focus");

    await addToCollection.click();
    picker = page.locator(".short-video-collection-picker");
    await picker.waitFor({ state: "visible", timeout: 5000 });
    const closePicker = picker.locator(".short-video-collection-picker-close");
    await closePicker.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await picker.evaluate((element) => element.contains(document.activeElement)), true, "picker focus must wrap inside the modal");
    await picker.locator('input[name="collectionName"]').fill("E2E 稍后看");
    await picker.locator('button[type="submit"]').click();
    await picker.waitFor({ state: "detached", timeout: 5000 });

    await page.goBack();
    await page.locator(".short-video-collection-sidebar").waitFor({ state: "visible", timeout: 30000 });
    const collection = page.locator(".short-video-collection-sidebar-item", { hasText: "E2E 稍后看" });
    await collection.waitFor({ state: "visible", timeout: 5000 });
    const feedBeforeCollection = await page.evaluate((collectionId) => {
      const button = document.querySelector(`.short-video-collection-sidebar-item[data-collection-id="${CSS.escape(collectionId)}"]`);
      button?.focus({ preventScroll: true });
      window.scrollTo(0, 420);
      return {
        cardCount: document.querySelectorAll(".short-video-grid .short-video-card").length,
        scrollY: window.scrollY,
        collectionId: button?.dataset.collectionId || ""
      };
    }, "svc_fixture_1");
    await collection.evaluate((element) => element.click());
    await page.waitForURL(/\/short-videos\/collections\/svc_fixture_1$/u, { timeout: 5000 });
    assert.equal(await collection.getAttribute("aria-current"), "page", "the active collection must be exposed through aria-current");
    await page.locator(".short-video-collection-back").click();
    await page.waitForURL((url) => url.pathname === "/short-videos" && !url.searchParams.has("source"), { timeout: 5000 });
    const restoredFeed = await waitFor(
      () => page.evaluate(() => ({
        cardCount: document.querySelectorAll(".short-video-grid .short-video-card").length,
        scrollY: window.scrollY,
        focusedCollectionId: document.activeElement?.dataset.collectionId || ""
      })),
      (value) => value.focusedCollectionId === "svc_fixture_1",
      5000
    );
    assert.equal(restoredFeed.cardCount, feedBeforeCollection.cardCount, "collection back must restore the captured feed data/DOM window");
    assert.ok(Math.abs(restoredFeed.scrollY - feedBeforeCollection.scrollY) <= 2, "collection back must restore feed scroll");

    await collection.evaluate((element) => element.click());
    await page.waitForURL(/\/short-videos\/collections\/svc_fixture_1$/u, { timeout: 5000 });
    await page.evaluate(() => {
      history.pushState({}, "", "/short-videos?source=authors");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.locator(".short-video-author-index-card-main").first().waitFor({ state: "visible", timeout: 30000 });
    assert.equal(new URL(page.url()).searchParams.get("source"), "authors");
    assert.equal(await page.locator('.short-video-source-tab[data-source="authors"]').getAttribute("aria-pressed"), "true", "collection-to-authors navigation must not be overwritten by an old feed snapshot");

    await page.goto(`${baseUrl}/short-videos`, { waitUntil: "domcontentloaded" });
    await page.locator(".short-video-collection-sidebar").waitFor({ state: "visible", timeout: 30000 });
    await page.locator(".short-video-collection-sidebar-item", { hasText: "E2E 稍后看" }).click();
    await page.waitForURL(/\/short-videos\/collections\/svc_fixture_1$/u, { timeout: 5000 });
    const remove = page.locator('.short-video-collection-remove[data-video-id="fixture-video-fixture-author-1"]');
    const actualRemove = remove.or(page.locator(".short-video-collection-remove").first());
    await actualRemove.waitFor({ state: "visible", timeout: 5000 });
    await actualRemove.click();
    await page.locator(".short-video-empty", { hasText: "这个清单还没有视频" }).waitFor({ state: "visible", timeout: 5000 });
    assert.equal(fixtureCollections.get("svc_fixture_1")?.videoIds.size, 0, "Chromium remove must persist through the collection API fixture");

    seedDeepCollection();
    await page.goto(`${baseUrl}/short-videos/collections/svc_deep`, { waitUntil: "domcontentloaded" });
    await page.locator(".short-video-collection-load-more").waitFor({ state: "visible", timeout: 30000 });
    await page.locator(".short-video-collection-load-more").click();
    await waitFor(() => page.locator("[data-collection-video-id]").count(), (count) => count === 60, 10000);
    assert.ok(fixtureCollectionPageRequests.some((requestUrl) => new URL(requestUrl).searchParams.has("cursor")), "Web collection pagination must advance with nextCursor");
    const returnCard = page.locator('[data-collection-video-id="fixture-deep-55"] .short-video-thumb-open');
    await returnCard.focus();
    await page.evaluate(() => window.scrollTo(0, Math.max(500, document.documentElement.scrollHeight - window.innerHeight - 160)));
    const collectionScroll = await page.evaluate(() => window.scrollY);
    await returnCard.click();
    await page.locator('.short-video-reel-panel.is-current[data-video-id="fixture-deep-55"]').waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".short-video-close").click();
    await page.waitForURL(/\/short-videos\/collections\/svc_deep$/u, { timeout: 5000 });
    const restoredCollection = await waitFor(
      () => page.evaluate(() => ({
        count: document.querySelectorAll("[data-collection-video-id]").length,
        scrollY: window.scrollY,
        focusVideoId: document.activeElement?.closest?.("[data-collection-video-id]")?.dataset.collectionVideoId || ""
      })),
      (value) => value.focusVideoId === "fixture-deep-55",
      5000
    );
    assert.equal(restoredCollection.count, 60, "collection video back must restore all cursor-appended rows");
    assert.ok(Math.abs(restoredCollection.scrollY - collectionScroll) <= 2, "collection video back must restore collection scroll");

    await page.goto(`${baseUrl}/short-videos/collections/svc_deep/videos/fixture-deep-58`, { waitUntil: "domcontentloaded" });
    await page.locator('.short-video-reel-panel.is-current[data-video-id="fixture-deep-58"]').waitFor({ state: "visible", timeout: 30000 });
    assert.ok(fixtureCollectionDetailRequests.includes("svc_deep:fixture-deep-58"), "deep members beyond the first 48 rows must use the membership detail API");
    const directHistoryLength = await page.evaluate(() => history.length);
    await page.locator(".short-video-close").click();
    await page.waitForURL(/\/short-videos\/collections\/svc_deep$/u, { timeout: 5000 });
    assert.equal(await page.evaluate(() => history.length), directHistoryLength, "direct collection deep-link return must replace instead of pushing history");

    await page.goto(`${baseUrl}/short-videos/collections/svc_deep/videos/fixture-outsider`, { waitUntil: "domcontentloaded" });
    await waitFor(
      () => page.locator("#workGrid").innerText().catch(() => ""),
      (text) => text.includes("outside this collection"),
      30000
    );
    assert.equal(await page.locator(".short-video-reel-panel.is-current").count(), 0, "an outsider must never render from a global detail stub");
  } finally {
    await page.close();
  }
}

async function authorWindow(page) {
  return page.evaluate((selector) => ({
    authors: document.querySelectorAll(selector).length,
    scrollY: window.scrollY,
    firstVisible: [...document.querySelectorAll(selector)].findIndex((card) => card.getBoundingClientRect().bottom > 0),
    href: window.location.href
  }), authorCardSelector);
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
  const authorCards = page.locator(authorCardSelector);
  const initialCount = await authorCards.count();
  assert(initialCount > 0, "author pagination must start from a rendered author index page");
  for (let index = 0; index < pages; index += 1) {
    const expectedCount = initialCount * (index + 2);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await waitFor(() => authorCards.count(), (count) => count >= expectedCount, 30000);
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

function deferNextNovelRequest(options = {}) {
  let requestedResolve;
  let releaseResolve;
  const response = new Promise((resolve) => { releaseResolve = resolve; });
  const deferred = {
    requested: new Promise((resolve) => { requestedResolve = resolve; }),
    release: () => releaseResolve()
  };
  delayedNovelRequests.push({
    reject: Boolean(options.reject),
    requested: () => requestedResolve(),
    response
  });
  return deferred;
}

function deferNovelCollection() {
  let requestedResolve;
  let releaseResolve;
  delayedNovelCollection = {
    requested: new Promise((resolve) => { requestedResolve = resolve; }),
    release: () => releaseResolve(),
    response: new Promise((resolve) => { releaseResolve = resolve; })
  };
  delayedNovelCollection.requestedResolve = requestedResolve;
  return delayedNovelCollection;
}

function fixtureNovels(url, options = {}) {
  const query = String(url.searchParams.get("q") || "").trim();
  const category = String(url.searchParams.get("category") || "").trim();
  const author = String(options.author || url.searchParams.get("author") || "测试作者").trim();
  const title = query || category || author || "测试小说";
  const book = {
    id: `fixture-novel-${encodeURIComponent(title)}`,
    author,
    category: category || "科幻",
    chapterCount: 3,
    charCount: 12000,
    latestChapterTitle: "第三章 测试章节",
    relativePath: `${title}.txt`,
    sizeBytes: 12000,
    summary: "浏览器行为验证小说",
    title,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  return {
    author: options.authorMode ? { name: author, bookCount: 1, chapterCount: 3, charCount: 12000, sizeBytes: 12000 } : null,
    books: [book],
    facets: [{ name: "科幻", count: 1 }],
    limit: Number(url.searchParams.get("limit") || 48),
    offset: Number(url.searchParams.get("offset") || 0),
    summary: { categories: [{ name: "科幻", count: 1 }], totals: { authors: 1, books: 1, bytes: 12000, chapters: 3 } },
    total: 1
  };
}

async function fixtureApi(url, request = {}) {
  if (url.pathname === "/api/library") {
    const western = url.searchParams.get("scope") === "western";
    const people = western
      ? [{ id: "western-person", name: "Western Star", isWestern: true, workCount: 2, sourceCount: 1 }]
      : [{ id: "main-person", name: "测试女优", isWestern: false, workCount: 3, sourceCount: 1, actorProfile: { displayName: "测试女优", gender: "female", avatarUrl: "/media/person/main-person/avatar" } }];
    return {
      access: { mode: "loopback" },
      availableRoots: [],
      people,
      totals: { infoFiles: 0, people: people.length, videos: western ? 2 : 3, works: western ? 2 : 3 },
      user: { favoriteCount: 0, historyCount: 0 },
      works: []
    };
  }
  const personDetail = /^\/api\/people\/([^/]+)$/.exec(url.pathname);
  if (personDetail) {
    fixturePersonDetailRequests.push(`${url.pathname}${url.search}`);
    const western = url.searchParams.get("scope") === "western";
    const name = western ? "Western Star" : "测试女优";
    return {
      categories: [
        { value: "censored", label: "番号", count: western ? 0 : 3 },
        { value: "western", label: "欧美", count: western ? 2 : 0 },
        { value: "fc2", label: "FC2", count: 0 },
        { value: "anime", label: "动漫", count: 0 }
      ],
      count: 0,
      facets: { all: 0 },
      filmographyCount: western ? 2 : 3,
      person: { id: decodeURIComponent(personDetail[1]), name, isWestern: western, workCount: western ? 2 : 3 },
      total: 0,
      works: [],
      year: "all",
      years: [{ value: "all", label: "全部年份", count: 0 }]
    };
  }
  if (url.pathname === "/api/favorites") {
    fixtureFanhaoCollectionRequests.push(`${url.pathname}${url.search}`);
    return {
      count: 0,
      facets: { all: 0 },
      folders: [{ id: "default", name: "默认收藏", count: 0, createdAt: "" }],
      limit: Number(url.searchParams.get("limit") || 0),
      offset: Number(url.searchParams.get("offset") || 0),
      selectedFolderId: url.searchParams.get("folder") || "all",
      total: 0,
      works: []
    };
  }
  if (url.pathname === "/api/works") {
    fixtureFanhaoCollectionRequests.push(`${url.pathname}${url.search}`);
    return { count: 0, facets: { all: 0 }, total: 0, works: [] };
  }
  if (url.pathname === "/api/health") return { ok: true };
  if (url.pathname === "/api/novels") {
    const delayed = delayedNovelRequests.shift();
    if (delayed) {
      delayed.requested();
      await delayed.response;
      if (delayed.reject) throw new Error("fixture stale novel request failed");
    }
    if (url.searchParams.get("q") === "当前失败") throw new Error("fixture current novel request failed");
    return fixtureNovels(url);
  }
  if (url.pathname === "/api/novels/summary") {
    fixtureNovelSummaryRequests += 1;
    return fixtureNovels(url).summary;
  }
  if (url.pathname === "/api/novels/collection") {
    fixtureNovelCollectionRequests += 1;
    if (delayedNovelCollection) {
      const delayed = delayedNovelCollection;
      delayedNovelCollection = null;
      delayed.requestedResolve();
      await delayed.response;
    }
    return {
      adapters: [],
      credentials: {},
      runtime: {},
      summary: {},
      tasks: [{ id: "fixture-active-collection", status: "succeeded", bookId: "fixture-novel" }]
    };
  }
  const novelDetail = /^\/api\/novels\/([^/]+)$/.exec(url.pathname);
  if (novelDetail) {
    const title = decodeURIComponent(novelDetail[1]).replace(/^fixture-novel-/, "") || "测试小说";
    return { book: fixtureNovels(new URL(`/api/novels?q=${encodeURIComponent(title)}`, url)).books[0], chapterTotal: 3 };
  }
  const novelAuthor = /^\/api\/novels\/authors\/([^/]+)$/.exec(url.pathname);
  if (novelAuthor) {
    const author = decodeURIComponent(novelAuthor[1]);
    return fixtureNovels(url, { author, authorMode: true });
  }
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
    if (!entry) throw fixtureHttpError(404, "fixture collection not found");
    fixtureCollectionPageRequests.push(url.toString());
    const cursor = String(url.searchParams.get("cursor") || "");
    const start = cursor ? Number(/^cursor-(\d+)$/.exec(cursor)?.[1] || -1) : 0;
    if (start < 0) throw fixtureHttpError(400, "fixture collection cursor invalid");
    const limit = Math.max(1, Math.min(120, Number(url.searchParams.get("limit") || 48)));
    const allVideoIds = [...entry.videoIds];
    const pageVideoIds = allVideoIds.slice(start, start + limit);
    const videos = pageVideoIds.map((id) => fixtureVideo(id));
    const hasMore = start + videos.length < allVideoIds.length;
    return {
      collection: { ...entry.collection, itemCount: allVideoIds.length },
      videos,
      count: videos.length,
      total: allVideoIds.length,
      limit,
      cursor: cursor || null,
      hasMore,
      nextCursor: hasMore ? `cursor-${start + videos.length}` : null
    };
  }
  const collectionVideo = /^\/api\/short-videos\/collections\/([^/]+)\/videos\/([^/]+)$/.exec(url.pathname);
  if (collectionVideo) {
    const entry = fixtureCollections.get(decodeURIComponent(collectionVideo[1]));
    if (!entry) throw fixtureHttpError(404, "fixture collection not found");
    const videoId = decodeURIComponent(collectionVideo[2]);
    if (request.method === "DELETE") {
      const removed = entry.videoIds.delete(videoId);
      return { removed, collectionId: entry.collection.id, videoId };
    }
    if (request.method === "GET") {
      fixtureCollectionDetailRequests.push(`${entry.collection.id}:${videoId}`);
      const videoIds = [...entry.videoIds];
      const index = videoIds.indexOf(videoId);
      if (index < 0) throw fixtureHttpError(404, "fixture video is outside this collection");
      const previous = index > 0 ? fixtureVideo(videoIds[index - 1]) : null;
      const next = index + 1 < videoIds.length ? fixtureVideo(videoIds[index + 1]) : null;
      return {
        collection: { ...entry.collection, itemCount: videoIds.length },
        video: fixtureVideo(videoId),
        prevId: previous?.id || "",
        nextId: next?.id || "",
        prevVideo: previous,
        nextVideo: next
      };
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
    const videos = author !== "all"
      ? [fixtureVideo(`fixture-video-${author}`, author)]
      : Array.from({ length: 60 }, (_, index) => fixtureVideo(`fixture-feed-${String(index + 1).padStart(2, "0")}`));
    return { videos, total: videos.length, hasMore: false };
  }
  const detail = /^\/api\/short-videos\/([^/]+)$/.exec(url.pathname);
  if (detail) {
    const video = fixtureVideo(decodeURIComponent(detail[1]));
    return { video, prevId: "", nextId: "", neighbors: { previous: [], next: [] } };
  }
  return {};
}

function seedDeepCollection() {
  fixtureCollections.set("svc_deep", {
    collection: {
      id: "svc_deep",
      name: "深链清单",
      itemCount: 60,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    },
    videoIds: new Set(Array.from({ length: 60 }, (_, index) => `fixture-deep-${String(index).padStart(2, "0")}`))
  });
}

function fixtureHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

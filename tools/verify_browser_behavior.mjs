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
const fixtureCollectionDetailRequests = [];
const fixtureCollectionPageRequests = [];
const fixtureFanhaoCollectionRequests = [];

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
    await verifyAndroidCollectionPicker(browser);
    await verifyAndroidCollectionRefresh(browser);
    await verifyAndroidCollectionManagement(browser);
    await verifyAndroidCollectionStackReturn(browser);
    await verifyAndroidFavoriteFolders(browser);
    await verifyAndroidFavoriteRoute(browser);
    await verifyAndroidFavoriteServerSwitch(browser);
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
        refreshFolders: refreshFeature.folders()
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
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    const entry = page.locator(".fanhao-chrome-tag", { hasText: "收藏" });
    await entry.waitFor({ state: "visible", timeout: 10000 }).catch(async () => {
      assert.fail(`Android favorite route fixture did not boot: ${pageErrors.join(" | ")} / ${await page.locator("#statusText").textContent()}`);
    });
    const settings = page.locator("#settingsOverlay");
    if (await settings.isVisible()) {
      await page.locator("#settingsCloseButton").click();
      await settings.waitFor({ state: "hidden", timeout: 5000 });
    }
    assert.equal(await entry.textContent(), "收藏", "Android FanHao chrome must make favorite folders discoverable without an external deep link");
    assert.equal(await page.locator("#favoriteCount").textContent(), "0", "Android home shortcut must render the empty favorite count from user state");
    fixtureFanhaoCollectionRequests.length = 0;
    await entry.click();
    await page.waitForFunction(() => location.hash === "#works?favorite=1", null, { timeout: 10000 });
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
    await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
    const entry = page.locator(".fanhao-chrome-tag", { hasText: "收藏" });
    await entry.waitFor({ state: "visible", timeout: 10000 });
    const settings = page.locator("#settingsOverlay");
    if (await settings.isVisible()) await page.locator("#settingsCloseButton").click();
    await entry.click();
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
  if (url.pathname === "/api/library") {
    return {
      access: { mode: "loopback" },
      availableRoots: [],
      people: [],
      totals: { infoFiles: 0, people: 0, videos: 0, works: 0 },
      user: { favoriteCount: 0, historyCount: 0 },
      works: []
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

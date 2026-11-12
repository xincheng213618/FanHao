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
const foldersPath = "android-client/www/modules/fanhao/features/works/favorite-folders.js";
const cachePath = "android-client/www/js/cache.js";
const frozen = path => execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:${path}`], { cwd: root, encoding: "utf8" });
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const invalidatePrefixes = /^  async function invalidatePrefixes\([\s\S]*?^  \}/m;
const currentFolders = read(foldersPath), previousInvalidate = frozen(foldersPath).match(invalidatePrefixes)?.[0];
assert(previousInvalidate && invalidatePrefixes.test(currentFolders));
const previousFolders = currentFolders.replace("import { clearCachedJsonByPrefixes }", "import { clearCachedJsonByPrefix }")
  .replace(invalidatePrefixes, () => previousInvalidate.replace("clearCache(", "(clearCachePrefix || clearCachedJsonByPrefix)("));
const singleClear = /^export async function clearCachedJsonByPrefix\([\s\S]*?^\}/m;
const currentCache = read(cachePath), previousClear = frozen(cachePath).match(singleClear)?.[0];
assert(previousClear && singleClear.test(currentCache));
const previousCache = currentCache.replace(singleClear, () => previousClear);
const server = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serverExit = once(server, "exit");
const nameBefore = "稍后观看", nameAfter = "周末合成清单", folderId = "synthetic-later";
const nameOffline = "离线合成名称";
const workId = "synthetic-favorite";
const affected = ["/api/favorite-folders", "/api/favorites", "/api/works", "/api/history", "/api/library", "/api/search",
  "/api/fanhao/search", "/api/people", "/api/studios", "/api/code-prefixes", "/api/rankings"];
const rowCount = 320, payloadBytes = 64 * 1024;
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
    const faults = [], mutations = [], favoriteMutations = [];
    let folderName = nameBefore, offline = false, favorite = true;
    const folders = () => [{ id: "default", name: "默认收藏", count: 0 }, { id: folderId, name: folderName, count: Number(favorite) }];
    const work = () => ({ id: workId, title: "合成收藏作品", directoryName: "SYN-101", category: "censored",
      favorite, favoriteFolderId: favorite ? folderId : "", favoriteFolderName: favorite ? folderName : "",
      videos: [], images: [], infoMetadata: { fields: [{ label: "来源", value: "合成测试" }] } });
    page.on("pageerror", error => faults.push(error.message));
    await page.route(url => url.origin !== origin, route => route.abort());
    if (previous) await page.route(url => url.pathname.endsWith("/features/works/favorite-folders.js"),
      route => route.fulfill({ contentType: "text/javascript", body: previousFolders }));
    if (previous) await page.route(url => url.pathname.endsWith("/js/cache.js"),
      route => route.fulfill({ contentType: "text/javascript", body: previousCache }));
    await page.route(url => url.pathname === "/api/favorites", route => route.fulfill({ json: {
      folders: folders(), selectedFolderId: folderId, total: Number(favorite), works: favorite ? [work()] : []
    } }));
    await page.route(url => url.pathname === `/api/works/${workId}`, route => route.fulfill({ json: { work: work() } }));
    await page.route(url => url.pathname === `/api/works/${workId}/move-job`, route => route.fulfill({ json: { ok: true, job: null } }));
    await page.route(url => url.pathname === `/api/favorites/${workId}`, route => {
      assert.equal(route.request().method(), "POST");
      favoriteMutations.push(route.request().method());
      favorite = !favorite;
      return route.fulfill({ json: { favorite, favoriteFolder: null, folders: folders() } });
    });
    await page.route(url => url.pathname.startsWith("/api/favorite-folders"), route => {
      const request = route.request();
      if (request.method() === "GET") return route.fulfill({ json: { folders: folders() } });
      assert.equal(request.method(), "PATCH");
      assert.equal(new URL(request.url()).pathname, `/api/favorite-folders/${folderId}`);
      const body = request.postDataJSON();
      assert.deepEqual(body, { name: offline ? nameOffline : nameAfter });
      mutations.push(body);
      if (offline) return route.fulfill({ status: 503, json: { error: "合成连接中断" } });
      folderName = body.name;
      return route.fulfill({ json: { folder: folders()[1], folders: folders() } });
    });
    await page.addInitScript(() => {
      const getAll = IDBIndex.prototype.getAll;
      IDBIndex.prototype.getAll = function(...args) {
        const request = getAll.apply(this, args);
        const stats = window.favoriteCacheProbe;
        if (stats && this.name === "baseUrl" && this.objectStore.name === "responses" && this.objectStore.transaction.mode === "readwrite") {
          stats.scans++;
          request.addEventListener("success", () => {
            stats.rows += request.result.length;
            stats.bytes += request.result.reduce((bytes, entry) => bytes + Number(entry.bytes || 0), 0);
          });
        }
        return request;
      };
      document.addEventListener("submit", event => {
        if (!event.target.matches(".favorite-folder-form")) return;
        const start = performance.now();
        const stats = window.favoriteCacheProbe = { scans: 0, rows: 0, bytes: 0 };
        const observer = new MutationObserver(() => {
          if (document.querySelector(".favorite-folder-sheet")) return;
          stats.closeMs = Math.round(performance.now() - start);
          observer.disconnect();
        });
        observer.observe(document.body, { childList: true });
      }, { capture: true });
      document.addEventListener("click", event => {
        const button = event.target.closest(".work-detail-hero .favorite-action");
        if (!button) return;
        const start = performance.now();
        const stats = window.favoriteCacheProbe = { scans: 0, rows: 0, bytes: 0 };
        const observer = new MutationObserver(() => {
          if (button.classList.contains("pending")) return;
          stats.closeMs = Math.round(performance.now() - start);
          observer.disconnect();
        });
        observer.observe(button, { attributes: true, attributeFilter: ["class"] });
      }, { capture: true });
    });
    try {
      const run = await page.request.post(`${origin}/fixture/new-run?scenario=fanhao-search`);
      assert(run.ok(), await run.text());
      const url = new URL((await run.json()).url, origin);
      url.hash = `works?favorite=1&folder=${folderId}`;
      await page.goto(url.href);
      await page.locator(".favorite-folder-strip").waitFor();
      await page.locator(".work-card").waitFor();
      const seeded = await page.evaluate(async ({ affected, rowCount, payloadBytes }) => {
        const open = indexedDB.open("fanhao-android-cache");
        const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        const read = db.transaction("responses").objectStore("responses").getAll();
        const records = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
        const version = records.find(entry => entry.path?.startsWith("/api/favorites?"))?.version;
        if (!version) throw Error("favorite response must enter the real cache before measurement");
        const tx = db.transaction("responses", "readwrite"), store = tx.objectStore("responses");
        const at = new Date().toISOString();
        const body = "x".repeat(payloadBytes);
        const keyFor = (base, path, owner) => `${base} ${version}${owner === "guest" ? "" : ` ${owner}`} ${path}`;
        const put = (base, path, owner, payload) => store.put({ key: keyFor(base, path, owner), baseUrl: base,
          path, accountOwner: owner, version, payload, updatedAt: at, accessedAt: at, bytes: payload?.body?.length || 1024 });
        const retired = affected.map(path => path + "?seed=1");
        for (const path of retired) put(location.origin, path, "guest", { body, path });
        for (let index = retired.length; index < rowCount; index++) put(location.origin, `/api/music/tracks?seed=${index}`, "guest", { body, index });
        put(location.origin, retired[0], "account:other-fixture", { sentinel: "other account" });
        put("http://other-favorite-fixture.invalid", retired[0], "guest", { sentinel: "other server" });
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
        db.close();
        return { retired: retired.map(path => keyFor(location.origin, path, "guest")),
          keep: [keyFor(location.origin, retired[0], "account:other-fixture"), keyFor("http://other-favorite-fixture.invalid", retired[0], "guest"),
            keyFor(location.origin, `/api/music/tracks?seed=${rowCount - 1}`, "guest")] };
      }, { affected, rowCount, payloadBytes });

      await page.getByRole("button", { name: "管理收藏夹", exact: true }).tap();
      const dialog = page.getByRole("dialog", { name: "管理收藏夹", exact: true });
      const input = dialog.getByLabel("收藏夹新名称");
      await input.waitFor();
      await input.fill(nameAfter);
      await dialog.getByRole("button", { name: "保存名称", exact: true }).tap();
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: `${nameAfter}，1 个作品` }).waitFor();
      const stats = await page.evaluate(() => window.favoriteCacheProbe);
      assert.equal(stats.scans, previous ? affected.length : 1);
      assert(stats.closeMs >= 0);
      const stored = await page.evaluate(async ({ retired, keep }) => {
        const open = indexedDB.open("fanhao-android-cache");
        const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        const request = db.transaction("responses").objectStore("responses").getAllKeys();
        const keys = new Set(await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }));
        db.close();
        return { removed: retired.every(key => !keys.has(key)), kept: keep.every(key => keys.has(key)) };
      }, seeded);
      assert.deepEqual(stored, { removed: true, kept: true });
      assert.equal(mutations.length, 1);
      console.log(JSON.stringify({ action: "rename", variant: previous ? "baseline" : "current", ...stats, mutations: mutations.length }));

      await page.locator(".work-card").tap();
      const favoriteButton = page.locator(".work-detail-hero .favorite-action");
      await favoriteButton.waitFor();
      await favoriteButton.tap();
      await page.waitForFunction(() => Number.isFinite(window.favoriteCacheProbe?.closeMs)
        && document.querySelector(".work-detail-hero .favorite-action")?.getAttribute("aria-pressed") === "false");
      const favoriteStats = await page.evaluate(() => window.favoriteCacheProbe);
      assert.equal(favoriteStats.scans, previous ? 3 : 1);
      assert.equal(favoriteMutations.length, 1);
      console.log(JSON.stringify({ action: "toggle", variant: previous ? "baseline" : "current",
        ...favoriteStats, mutations: favoriteMutations.length }));
      if (!previous) {
        offline = true;
        await page.getByRole("button", { name: "返回上一页", exact: true }).tap();
        await page.getByRole("button", { name: "管理收藏夹", exact: true }).tap();
        await input.waitFor();
        await input.fill(nameOffline);
        await dialog.getByRole("button", { name: "保存名称", exact: true }).tap();
        await dialog.getByText("合成连接中断", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.favoriteCacheProbe.scans), 0, "a failed PATCH does not start cache invalidation");
        assert.equal(await dialog.getAttribute("aria-busy"), "false");
        assert.equal(folderName, nameAfter);
        await verifyFavoriteSearch(page, url);
      }
      assert.deepEqual(faults, []);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.kill();
  await serverExit;
}

async function verifyFavoriteSearch(page, url) {
  const query = "C++ & 合成", deepId = "search-deep-73";
  const work = id => ({ id, title: `合成作品 ${id}`, directoryName: id, category: "censored",
    favorite: true, favoriteFolderId: folderId, favoriteFolderName: nameAfter, videos: [], images: [] });
  const folders = [{ id: "default", name: "默认收藏", count: 1 }, { id: folderId, name: nameAfter, count: 73 }];
  const requests = [];
  const delayed = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  await page.route(request => request.pathname === "/api/favorites", async route => {
    const params = new URL(route.request().url()).searchParams;
    const q = params.get("q"), folder = params.get("folder") || "all", limit = Number(params.get("limit"));
    requests.push({ q, folder, limit });
    if (q === "延迟结果") { delayed.started.resolve(); await delayed.release.promise; }
    const candidates = q === query && folder !== "default" ? [...Array.from({ length: 72 }, (_, index) => work(`search-result-${index + 1}`)), work(deepId)]
      : q === "延迟结果" ? [work("retired-result")] : q && q !== "旧服务" ? [] : [work("unfiltered-work")];
    await route.fulfill({ json: { folders, selectedFolderId: folder, total: candidates.length, works: candidates.slice(0, limit),
      ...(q && q !== "旧服务" ? { query: q } : {}) } }).catch(() => {});
  });
  await page.route(request => request.pathname === `/api/works/${deepId}`, route => route.fulfill({ json: { work: work(deepId) } }));
  await page.route(request => request.pathname === `/api/works/${deepId}/move-job`, route => route.fulfill({ json: { ok: true, job: null } }));
  const field = page.getByRole("searchbox", { name: "搜索收藏", exact: true });
  const clear = page.getByRole("button", { name: "清除搜索", exact: true });
  const submit = async value => { await field.fill(value); await field.press("Enter"); };
  const card = id => page.locator(`[data-work-detail-id="${id}"]`);
  try {
    await page.setViewportSize({ width: 320, height: 620 });
    await page.goto(url.href);
    await card("unfiltered-work").waitFor();
    const initialLimit = requests.at(-1).limit;
    assert(initialLimit < 73);
    await field.fill("未提交");
    await field.evaluate(input => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.form.requestSubmit();
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    assert.equal(requests.some(request => request.q === "未提交"), false);

    await submit("延迟结果");
    await delayed.started.promise;
    await submit(`  ${query}  `);
    await card("search-result-1").waitFor();
    delayed.release.resolve();
    assert.equal(await field.inputValue(), query);
    assert.equal(await card("retired-result").count(), 0);
    assert.equal(await card("unfiltered-work").count(), 0);
    assert.equal(await card(deepId).count(), 0);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("query"), query);
    assert.deepEqual(requests.at(-1), { q: query, folder: folderId, limit: initialLimit });
    await page.locator(".load-more button").click();
    await card(deepId).waitFor();
    assert(requests.at(-1).limit > initialLimit && requests.at(-1).q === query && requests.at(-1).folder === folderId);
    await card(deepId).click();
    await page.locator(".work-detail-hero").waitFor();
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    await card("search-result-1").waitFor();
    assert.equal(await field.inputValue(), query);

    await page.getByRole("button", { name: "默认收藏，1 个作品", exact: true }).click();
    await page.getByText("没有符合收藏搜索的作品。", { exact: true }).waitFor();
    assert.equal(await field.inputValue(), query);
    assert.equal(requests.at(-1).folder, "default");
    await submit("旧服务");
    await page.getByText("当前服务不支持收藏搜索。可清除搜索继续浏览。", { exact: true }).waitFor();
    assert.equal(await card("unfiltered-work").count(), 0);
    const cached = await page.evaluate(async () => {
      const module = performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname.endsWith("/js/cache.js"));
      const { readCachedJson } = await import(module.name);
      const path = performance.getEntriesByType("resource").map(entry => new URL(entry.name))
        .findLast(url => url.pathname === "/api/favorites" && url.searchParams.get("q") === "旧服务");
      return Boolean(await readCachedJson(location.origin, path.pathname + path.search));
    });
    assert.equal(cached, false, "an unfiltered legacy response never enters the search cache");
    await clear.click();
    await card("unfiltered-work").waitFor();
    assert.equal(await field.inputValue(), "");
    assert.deepEqual(requests.at(-1), { q: null, folder: "default", limit: initialLimit });
    const sizes = await page.locator(".favorite-search-form :is(input, button:not([hidden]))").evaluateAll(nodes =>
      nodes.map(node => ({ height: node.getBoundingClientRect().height, right: node.getBoundingClientRect().right })));
    assert(sizes.every(box => box.height >= 44 && box.right <= 320));
    console.log("Android favorite search: preserved folder, pagination, navigation, request ownership and old-server recovery");
  } finally { delayed.release.resolve(); }
}

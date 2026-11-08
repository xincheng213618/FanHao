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
let legacy = fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
for (const [start, end] of [["renderMangaChapterData", "createMangaChapterNavigation"],
  ["createMangaReaderProgress", "bindMangaReaderProgress"], ["bindMangaReaderProgress", "restoreRequestedMangaPage"],
  ["restoreRequestedMangaPage", "resetMangaReaderProgressTracker"]]) {
  const pattern = new RegExp(`^  function ${start}\\([\\s\\S]*?(?=^  function ${end}\\()`, "m");
  const old = original.match(pattern)?.[0];
  assert(old && pattern.test(legacy));
  legacy = legacy.replace(pattern, () => old);
}

const server = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serverExit = once(server, "exit");
const id = "fixture-manga-layout-1", chapterIndex = 1, target = 142, total = 180;
const endpoint = `/api/manga/${id}/chapters/${chapterIndex}`;
const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="760"><rect width="360" height="760" fill="#507886"/></svg>';
const images = Array.from({ length: total }, (_, i) => ({
  index: i + 1, name: `合成第 ${i + 1} 页`, width: 360, height: 760, url: `/synthetic/manga-page-${i + 1}.svg`
}));
const payload = { comic: { id, title: "合成长篇漫画" }, chapter: { index: chapterIndex, title: "合成章节", imageCount: total,
  images, navigation: { position: chapterIndex, total: 3, next: { index: 2, title: "下话" } } } };
const refreshedPayload = { ...payload, chapter: { ...payload.chapter, title: "更新后的合成章节" } };
const app = fs.readFileSync(new URL("../android-client/www/app.js", import.meta.url), "utf8");
const hostMarker = "function createAndroidModuleHost() {";
assert.equal(app.split(hostMarker).length, 2);
const instrumentedApp = app.replace(hostMarker, hostMarker + "\n  window.fixtureUpdateServer = updateServer;");
const args = process.argv.slice(2);
assert(args.every(arg => ["--baseline-only", "--current-first"].includes(arg)));
const variants = args.includes("--baseline-only") ? [true] : args.includes("--current-first") ? [false, true] : [true, false];
let browser;
try {
  const loopback = await new Promise((resolve, reject) => {
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
  browser = await chromium.launch({ executablePath, headless: true,
    args: ["--host-resolver-rules=MAP manga-resume.test 127.0.0.1", "--no-proxy-server"] });
  for (const wan of [false, true]) {
    for (const previous of variants) {
      const origin = wan ? loopback.replace("127.0.0.1", "manga-resume.test") : loopback;
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      page.setDefaultTimeout(10000);
      const requests = [], faults = [];
      let phase = "timing";
      const allowRefresh = Promise.withResolvers();
      const allowChanged = Promise.withResolvers();
      page.on("pageerror", error => faults.push(error.message));
      await page.route(url => url.origin !== origin, route => route.abort());
      if (wan) await page.route(url => url.origin === origin, async route => {
        const request = route.request();
        if (request.method() !== "GET") return route.abort();
        const referer = request.headers().referer?.replace(origin, loopback);
        const response = await page.request.get(request.url().replace(origin, loopback), {
          headers: referer ? { referer } : {}
        });
        return route.fulfill({ response });
      });
      if (previous) await page.route(url => url.pathname.endsWith("/platform/content-index/channel-views.js"),
        route => route.fulfill({ contentType: "text/javascript", body: legacy }));
      if (!previous && !wan) await page.route(url => url.pathname.endsWith("/app.js"),
        route => route.fulfill({ contentType: "text/javascript", body: instrumentedApp }));
      await page.route(url => url.pathname === endpoint, async route => {
        requests.push(phase);
        if (phase === "offline") return route.fulfill({ status: 503, json: { error: "合成离线" } });
        if (phase === "short-cache") {
          await allowRefresh.promise;
          return route.fulfill({ json: payload }).catch(() => {});
        }
        if (phase === "changed-cache") {
          await allowChanged.promise;
          return route.fulfill({ json: refreshedPayload });
        }
        if (requests.length > 1) await new Promise(resolve => setTimeout(resolve, 150));
        await route.fulfill({ json: payload });
      });
      await page.route(url => url.pathname.startsWith("/synthetic/manga-page-"),
        route => route.fulfill({ contentType: "image/svg+xml", body: poster }));
      await page.addInitScript(({ id, chapterIndex, target, total }) => {
        const runId = location.pathname.split("/")[2];
        localStorage.setItem(`gallery-navigation-fixture:${runId}:fanhao.android.mangaReadingProgress.v1`, JSON.stringify({
          [id]: { chapterIndex, pageIndex: target, pageTotal: total, updatedAt: "2026-10-01" }
        }));
        document.addEventListener("click", event => {
          if (!event.target.closest(".manga-reader-resume")) return;
          const openedAt = performance.now();
          const before = [...document.querySelectorAll(".manga-reader-page")];
          const check = () => {
            const node = document.querySelector(`[data-manga-page-position="${target}"]`);
            const aligned = node && Math.abs(node.getBoundingClientRect().top - 60) <= 2;
            const progress = document.querySelector(".manga-reader-progress-track")?.getAttribute("aria-valuenow");
            if (aligned && progress === String(target)) {
              window.fixtureResume = { resumeMs: Math.round(performance.now() - openedAt), initialNodes: before.length,
                mountedNodes: document.querySelectorAll(".manga-reader-page").length,
                retainedNodes: before.filter(element => element.isConnected).length };
            } else if (performance.now() - openedAt < 5000) requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }, { capture: true });
      }, { id, chapterIndex, target, total });
      try {
        const response = await page.request.post(`${loopback}/fixture/new-run?scenario=manga-layout`);
        assert(response.ok(), await response.text());
        const url = new URL((await response.json()).url, origin);
        url.hash = `mangaChapter?id=${id}&chapterIndex=${chapterIndex}`;
        await page.goto(url.href);
        const resume = page.locator(".manga-reader-resume");
        await resume.waitFor();
        await page.waitForFunction(() => document.querySelector(".manga-reader-page img")?.naturalWidth > 0);
        const cacheModule = await page.evaluate(() => performance.getEntriesByType("resource")
          .find(entry => new URL(entry.name).pathname.endsWith("/js/cache.js"))?.name);
        assert(cacheModule);
        await page.waitForFunction(async ({ cacheModule, endpoint, total }) => {
          const { readCachedJson } = await import(cacheModule);
          return (await readCachedJson(location.origin, endpoint))?.payload?.chapter?.images?.length === total;
        }, { cacheModule, endpoint, total });
        assert.equal(requests.length, 1);
        const extraResponse = previous ? page.waitForResponse(response => new URL(response.url()).pathname === endpoint) : null;
        await resume.tap();
        await page.waitForFunction(() => Boolean(window.fixtureResume));
        const result = await page.evaluate(() => window.fixtureResume);
        const extraBytes = extraResponse ? (await (await extraResponse).body()).length : 0;
        assert.equal(requests.length, previous ? 2 : 1, "resume request budget");
        assert.equal(result.retainedNodes, previous ? 0 : result.initialNodes);
        assert.equal(await resume.count(), 0, "accepted resume no longer offers the old action");
        assert.deepEqual(faults, []);
        console.log(JSON.stringify({ mode: wan ? "WAN" : "LAN", variant: previous ? "baseline" : "current", ...result,
          extraRequests: requests.length - 1, extraBytes }));
        if (!previous && !wan) {
          phase = "offline";
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.locator(".manga-cache-notice").waitFor();
          await resume.waitFor();
          const offlineReads = requests.length;
          await resume.tap();
          await page.waitForFunction(() => Boolean(window.fixtureResume));
          assert.equal(requests.length, offlineReads, "resuming cached pages does not repeat a failed refresh");
          assert.equal(await page.locator(".manga-cache-notice").count(), 1);
          assert.equal(await page.evaluate(() => window.fixtureResume.retainedNodes), total);

          phase = "changed-cache";
          const changedRefresh = page.waitForRequest(request => new URL(request.url()).pathname === endpoint);
          await page.reload({ waitUntil: "domcontentloaded" });
          await changedRefresh;
          await resume.waitFor();
          const cachedList = await page.locator(".manga-reader-list").elementHandle();
          const requestsBeforeResume = requests.length;
          await resume.tap();
          await page.waitForFunction(() => Boolean(window.fixtureResume));
          allowChanged.resolve();
          await page.waitForFunction(({ title, target }) => {
            const anchor = document.querySelector(`[data-manga-page-position="${target}"]`);
            return document.querySelector(".manga-reader-title")?.textContent === title
              && document.querySelector(".manga-reader-progress-track")?.getAttribute("aria-valuenow") === String(target)
              && anchor && Math.abs(anchor.getBoundingClientRect().top - 60) <= 2;
          }, { title: refreshedPayload.chapter.title, target });
          assert.equal(await cachedList.evaluate(element => element.isConnected), false, "the changed fresh payload actually replaced the reader");
          assert.equal(requests.length, requestsBeforeResume, "refresh reuses the mounted restore intent");

          const old = { ...payload, chapter: { ...payload.chapter, imageCount: 12, images: images.slice(0, 12) } };
          await page.evaluate(async ({ cacheModule, endpoint, old }) => {
            const { captureCachedJsonFence, writeCachedJson } = await import(cacheModule);
            await writeCachedJson(location.origin, endpoint, old, { fence: captureCachedJsonFence(location.origin) });
          }, { cacheModule, endpoint, old });
          phase = "short-cache";
          const pendingRefresh = page.waitForRequest(request => new URL(request.url()).pathname === endpoint);
          await page.reload({ waitUntil: "domcontentloaded" });
          await pendingRefresh;
          await resume.waitFor();
          assert.equal(await page.locator(".manga-reader-page").count(), 12);
          const renewed = page.waitForRequest(request => new URL(request.url()).pathname === endpoint);
          await resume.tap();
          await renewed;
          await page.waitForFunction(() => document.querySelector(".manga-reader-progress-track")?.getAttribute("aria-valuenow") === "12");
          await page.waitForTimeout(480);
          const storedPage = () => page.evaluate(id =>
            JSON.parse(localStorage.getItem("fanhao.android.mangaReadingProgress.v1"))[id].pageIndex, id);
          assert.equal(await storedPage(), target, "a temporary cached anchor must not overwrite saved progress");
          allowRefresh.resolve();
          await page.waitForFunction(() => Boolean(window.fixtureResume));
          assert.equal(await page.locator(".manga-reader-page").count(), total);

          await page.evaluate(async ({ cacheModule, endpoint, old }) => {
            const { captureCachedJsonFence, writeCachedJson } = await import(cacheModule);
            await writeCachedJson(location.origin, endpoint, old, { fence: captureCachedJsonFence(location.origin) });
          }, { cacheModule, endpoint, old });
          phase = "offline";
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.locator(".manga-cache-notice").waitFor();
          await resume.tap();
          await page.locator(".manga-cache-notice").waitFor();
          await page.waitForTimeout(480);
          assert.equal(await storedPage(), target, "a failed refresh must not save the temporary cached anchor");
          await page.getByRole("navigation", { name: "章节导航", exact: true })
            .getByRole("button", { name: "返回章节目录" }).click();
          await page.locator(".manga-detail-summary").waitFor();
          assert.equal(await storedPage(), target, "leaving the reader must not flush a temporary anchor");

          await page.locator(".manga-chapter-open").first().click();
          await page.locator(".manga-cache-notice").waitFor();
          await resume.tap();
          await page.locator(".manga-cache-notice").waitFor();
          await page.waitForFunction(() => document.querySelector(".manga-reader-progress-track")?.getAttribute("aria-valuenow") === "12");
          await page.mouse.wheel(0, -1300);
          await page.waitForFunction(({ id, target }) => {
            const saved = JSON.parse(localStorage.getItem("fanhao.android.mangaReadingProgress.v1"))?.[id]?.pageIndex;
            return saved > 0 && saved < 12 && saved !== target;
          }, { id, target });

          phase = "timing";
          await page.reload({ waitUntil: "domcontentloaded" });
          await resume.waitFor();
          const sourceGuard = await page.evaluate(() => {
            const button = document.querySelector(".manga-reader-resume");
            window.fixtureUpdateServer("http://127.0.0.1:1");
            button.click();
            return { attached: button.isConnected, progress: document.querySelector(".manga-reader-progress-track")?.getAttribute("aria-valuenow") };
          });
          assert.deepEqual(sourceGuard, { attached: true, progress: "1" }, "source change retires even a still-mounted button");
          const accountModule = await page.evaluate(() => performance.getEntriesByType("resource")
            .find(entry => new URL(entry.name).pathname.endsWith("/js/account-owner.js"))?.name);
          assert(accountModule);
          const accountGuard = await page.evaluate(async ({ accountModule }) => {
            const { setAccountOwner } = await import(accountModule);
            window.fixtureUpdateServer(location.origin);
            const button = document.querySelector(".manga-reader-resume");
            setAccountOwner(location.origin, "account:fixture-manga-new");
            button.click();
            return { retired: !button.isConnected, resume: sessionStorage.getItem("fanhao.android.mangaResumeRequest.v1") };
          }, { accountModule });
          assert.deepEqual(accountGuard, { retired: true, resume: null }, "account transition retires the previous reader intent");
          assert.deepEqual(faults, []);
        }
      } finally {
        allowRefresh.resolve();
        allowChanged.resolve();
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  server.kill();
  await serverExit;
}

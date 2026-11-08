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
const path = "android-client/www/modules/fanhao/features/rankings/ranking-views.js";
const previousSource = execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:${path}`], { cwd: root, encoding: "utf8" });
const server = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serverExit = once(server, "exit");
const key = "y2025", total = 48, resultCount = total / 2;
const list = { key, label: "合成年度榜单", total, localTotal: total };
const summary = { lists: [list] };
const ranking = { ...list, rankingTotal: total, missingTotal: 0, updatedAt: "2026-10-01", offset: 0, limit: total,
  works: Array.from({ length: total }, (_, index) => ({
    id: `fixture-ranked-${index + 1}`, title: `合成榜单作品 ${index + 1}`, directoryName: `SYN-${String(index + 1).padStart(3, "0")}`,
    category: "censored", playableCount: index % 2 ? 0 : 1, videoCount: index % 2 ? 0 : 1, ranking: { rankNo: index + 1 },
    infoSummary: { rating: 7.5, ratingCount: 42 }, videos: [], images: []
  })) };
const refreshedRanking = { ...ranking, works: ranking.works.map((work, index) => ({
  ...work, playableCount: index % 2 ? 1 : 0
})) };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    const requests = [], faults = [];
    const allowHeld = Promise.withResolvers();
    let phase = "initial";
    page.on("pageerror", error => faults.push(error.message));
    await page.route(url => url.origin !== origin, route => route.abort());
    if (previous) await page.route(url => url.pathname.endsWith("/features/rankings/ranking-views.js"),
      route => route.fulfill({ contentType: "text/javascript", body: previousSource }));
    await page.route(url => /^\/api\/rankings(?:\/top)?$/.test(url.pathname), async route => {
      const path = new URL(route.request().url()).pathname;
      const body = JSON.stringify(path === "/api/rankings" ? summary : phase === "held" ? refreshedRanking : ranking);
      requests.push({ phase, path, bytes: Buffer.byteLength(body) });
      if (phase === "filter") await delay(150);
      if (phase === "offline") return route.fulfill({ status: 503, json: { error: "合成离线" } });
      if (phase === "held") await allowHeld.promise;
      await route.fulfill({ contentType: "application/json", body });
    });
    await page.addInitScript(({ resultCount }) => {
      document.addEventListener("click", event => {
        if (!event.target.closest(".work-filter-strip button") || event.target.textContent !== "可播") return;
        const start = performance.now();
        const observed = new WeakSet(document.querySelectorAll(".work-card"));
        const stats = window.fixtureFilter = { firstMs: null, stableMs: null, cardsCreated: 0, loadingFlash: false };
        let firstCard = null;
        const observer = new MutationObserver(() => {
          const cards = [...document.querySelectorAll(".work-card")];
          for (const card of cards) {
            if (observed.has(card)) continue;
            observed.add(card);
            stats.cardsCreated++;
          }
          stats.loadingFlash ||= Boolean(document.querySelector("#viewContent .loading-row"));
          const chosen = [...document.querySelectorAll(".work-filter-strip button")].some(button =>
            button.textContent === "可播" && button.getAttribute("aria-pressed") === "true");
          if (chosen && cards.length === resultCount && cards[0] !== firstCard) {
            firstCard = cards[0];
            stats.stableMs = Math.round(performance.now() - start);
            stats.firstMs ??= stats.stableMs;
          }
        });
        observer.observe(document.getElementById("viewContent"), { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 3000);
      }, { capture: true });
    }, { resultCount });
    try {
      const response = await page.request.post(`${origin}/fixture/new-run?scenario=fanhao-search`);
      assert(response.ok(), await response.text());
      const url = new URL((await response.json()).url, origin);
      url.hash = "rankings";
      await page.goto(url.href);
      const cards = page.locator(".work-card");
      const filter = page.getByRole("button", { name: /^可播，/u });
      const cardCount = expected => page.waitForFunction(expected => document.querySelectorAll(".work-card").length === expected, expected);
      await cardCount(total);
      assert.equal(requests.length, 2);
      phase = "filter";
      const duplicateReads = previous ? ["/api/rankings", "/api/rankings/top"].map(path =>
        page.waitForResponse(response => new URL(response.url()).pathname === path)) : [];
      await filter.tap();
      await page.waitForFunction(() => Number.isFinite(window.fixtureFilter?.firstMs));
      const firstFilteredCard = await cards.first().elementHandle();
      await Promise.all(duplicateReads.map(async response => (await response).finished()));
      await page.waitForFunction(() => !document.getElementById("viewMeta").textContent.includes("缓存"));
      await cardCount(resultCount);
      const retainedFilteredCard = await firstFilteredCard.evaluate(element => element.isConnected);
      assert.equal(retainedFilteredCard, !previous, "cache result should not be replaced by an unnecessary refresh");
      assert.equal(await cards.count(), resultCount);
      const reads = requests.filter(entry => entry.phase === "filter");
      assert.equal(reads.length, previous ? 2 : 0);
      const stats = await page.evaluate(() => window.fixtureFilter);
      assert.equal(stats.cardsCreated, previous ? resultCount * 2 : resultCount);
      assert.equal(stats.loadingFlash, previous);
      console.log(JSON.stringify({ variant: previous ? "baseline" : "current", ...stats, retainedFilteredCard,
        rows: resultCount, requests: reads.length, bytes: reads.reduce((total, request) => total + request.bytes, 0) }));
      if (!previous) {
        phase = "held";
        const freshReads = ["/api/rankings", "/api/rankings/top"].map(path =>
          page.waitForRequest(request => new URL(request.url()).pathname === path));
        await page.reload({ waitUntil: "domcontentloaded" });
        await Promise.all(freshReads);
        await cardCount(total);
        const heldReads = requests.length;
        await filter.tap();
        await cardCount(resultCount);
        assert.equal(requests.length, heldReads, "the mounted filter does not restart a pending refresh");
        const oldFirst = await cards.first().elementHandle();
        allowHeld.resolve();
        await page.waitForFunction(() => !document.getElementById("viewMeta").textContent.includes("缓存"));
        await cardCount(resultCount);
        assert.equal(await oldFirst.evaluate(card => card.isConnected), false, "changed fresh DTOs still update the local filter result");
        assert.match(await filter.getAttribute("aria-pressed"), /true/u);

        phase = "offline";
        await page.reload({ waitUntil: "domcontentloaded" });
        const notice = page.getByText("电脑端暂时连不上，当前显示的是本地缓存排行榜。", { exact: true });
        await notice.waitFor();
        await cardCount(total);
        const offlineReads = requests.length;
        await filter.tap();
        await cardCount(resultCount);
        assert.equal(requests.length, offlineReads, "filtering a mounted offline cache does not retry HTTP");
        await notice.waitFor();
        assert.match(await page.locator("#viewMeta").textContent(), /缓存/u);
      }
      assert.deepEqual(faults, []);
    } finally {
      allowHeld.resolve();
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.kill();
  await serverExit;
}

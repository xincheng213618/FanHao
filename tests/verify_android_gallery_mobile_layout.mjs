import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

// Complete Android shell and real navigation; only the loopback API and posters
// are synthetic. The reading history case also seeds isolated device storage.
const root = path.resolve(import.meta.dirname, "..");
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executablePath, "Chrome or Edge required for the actual Android shell fixture");
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const legacyTitle = process.argv.includes("--legacy-title");
const legacyPhotoReturn = process.argv.includes("--legacy-photo-return");
const legacyFacts = process.argv.includes("--legacy-facts");
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serviceExit = new Promise(resolve => service.once("exit", resolve));
let browser, origin, mediaFixtureUrl, photoFixtureUrl, checks = 0;
const faults = [], frozenRuns = [], profiles = [];
const viewports = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const selected = name => (!caseFilter || name.includes(caseFilter)) && (!legacyPhotoReturn || name.startsWith("photo:"))
  && (!(legacyTitle || legacyFacts) || name.startsWith("media:"));
async function run(name, task) {
  if (!selected(name)) return;
  await task(); checks++; console.log(`PASS ${name}`);
}

try {
  origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("synthetic fixture startup timed out")), 15000);
    service.stdout.on("data", bytes => { output += bytes; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited before startup (${code})`)); });
  });
  browser = await chromium.launch({ executablePath, headless: true });
  for (const viewport of viewports) {
    const profile = `${viewport.width}x${viewport.height}`;
    await run(`media: ${profile} Chinese and unbroken Latin movie details remain fully readable`, async () => {
      const page = await newPage(viewport);
      try {
        await launch(page, "影视布局压力（长片名、剧名与文件信息）");
        const cards = page.locator(".media-poster-card");
        await cards.first().waitFor(); assert.equal(await cards.count(), 2);
        for (let index = 0; index < 2; index++) {
          const title = await cards.nth(index).locator("strong").textContent();
          await cards.nth(index).click();
          await page.locator(".media-player-title strong").waitFor(); await frames(page);
          const layout = await assertDetail(page, title, profile);
          profiles.push({ profile, kind: `movie-${index + 1}`, ...layout });
          await page.locator(".media-back-action").click();
          await cards.first().waitFor(); assert.equal(await cards.count(), 2);
          assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("mode"), "movie");
        }
      } finally { await page.close(); }
    });
    await run(`media: ${profile} long series and episode navigation preserve their catalogue`, async () => {
      const page = await newPage(viewport);
      try {
        await launch(page, "影视布局压力（长片名、剧名与文件信息）");
        await galleryMode(page, "电视剧");
        await page.locator(".media-poster-card").click();
        await page.locator(".media-episode-card").first().waitFor();
        assert.equal(await page.locator(".media-episode-card").count(), 2);
        const title = await page.locator(".media-episode-card strong").first().textContent();
        await page.locator(".media-episode-card").first().click();
        await page.locator(".media-player-title strong").waitFor(); await frames(page);
        profiles.push({ profile, kind: "episode-1", ...await assertDetail(page, title, profile) });
        await page.locator('.media-episode-nav[data-state="ready"]').waitFor();
        const next = page.getByRole("button", { name: "下一集", exact: true });
        assert.equal(await next.isEnabled(), true); await next.click();
        await page.waitForURL(url => url.hash.includes("fixture-media-layout-episode-2"));
        await page.locator(".media-player-title strong").waitFor(); await frames(page);
        profiles.push({ profile, kind: "episode-2", ...await assertDetail(page, "SyntheticEpisodeTwoContinuousLatinFilenameForPortraitAndLandscapeNavigationWithoutAnyRealVideo", profile) });
        await page.locator(".media-back-action").click();
        await page.locator(".media-player-title strong").waitFor();
        assert((await page.locator(".media-player-title strong").textContent()).includes(title), "first Back retains the previous episode in the actual stack");
        await page.locator(".media-back-action").click();
        await page.locator(".media-episode-card").first().waitFor();
        assert.equal(await page.locator(".media-episode-card").count(), 2);
        assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("seriesKey"), "fixture-media-layout-series");
      } finally { await page.close(); }
    });
    await run(`photo: ${profile} category return has a 44px target and restores actual filters`, async () => {
      const page = await newPage(viewport);
      try {
        await launch(page, "影视布局压力（长片名、剧名与文件信息）");
        await galleryMode(page, "套图");
        await page.locator('.photo-chrome-tabs button[aria-label="COS"]').click();
        await page.locator(".photo-collection-card").waitFor();
        await page.locator(".photo-sort-action").click();
        await page.getByRole("dialog").getByRole("button", { name: "名称排序", exact: true }).click();
        await page.locator(".photo-collection-card").waitFor(); await frames(page);
        const before = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
        assert.equal(before.get("category"), "[COS]"); assert.equal(before.get("sort"), "title");
        await page.locator(".photo-collection-card").click();
        const back = page.getByRole("button", { name: "返回分类", exact: true });
        await back.waitFor(); await back.scrollIntoViewIfNeeded(); await frames(page);
        const box = await back.boundingBox();
        assert(box.width >= 44 && box.height >= 44, `photo return hit target must be 44px: ${JSON.stringify(box)}`);
        await back.click(); await page.locator(".photo-collection-card").waitFor();
        const after = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
        for (const key of ["mode", "category", "photoView", "sort"]) assert.equal(after.get(key), before.get(key), `actual category return preserves ${key}`);
        assert.equal(after.get("collection"), null);
        await assertNoHorizontalOverflow(page);
        profiles.push({ profile, kind: "photo-return", width: box.width, height: box.height });
      } finally { await page.close(); }
    });
  }
  await run("media: 320px watchlist saves locally and reopens a movie or the exact series directory", async () => {
    const page = await newPage(viewports[0]);
    try {
      await launch(page, "影视布局压力（长片名、剧名与文件信息）", { reuseMediaFixture: true });
      const trigger = page.getByRole("button", { name: "待看清单", exact: true });
      const list = page.getByRole("dialog", { name: "本机待看清单" });
      const movie = page.locator(".media-watch-card").first();
      const movieTitle = await movie.locator("strong").textContent();
      const toggle = movie.locator(".media-watch-toggle");
      const target = await toggle.boundingBox();
      assert(target && target.width >= 44 && target.height >= 44, "the watchlist action has a 44px hit target");
      await page.evaluate(() => {
        window.__watchSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.includes("fanhao.android.media.watchlist.v1:")) throw new DOMException("Synthetic quota", "QuotaExceededError");
          return __watchSetItem.call(this, key, value);
        };
      });
      await toggle.click();
      assert.equal(await page.locator(".media-watch-message").textContent(), "待看清单保存失败，请检查手机存储。");
      assert.equal(await toggle.getAttribute("aria-pressed"), "false");
      await page.evaluate(() => { Storage.prototype.setItem = __watchSetItem; });
      const originalRoute = page.url();
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-pressed"), "true");
      assert.equal(page.url(), originalRoute);
      await trigger.click();
      await assertNoHorizontalOverflow(page);
      await list.getByRole("button", { name: `打开 · ${movieTitle}`, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      await list.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate(button => document.activeElement === button), true);
      await trigger.click();
      await list.getByRole("button", { name: `打开 · ${movieTitle}`, exact: true }).click();
      await page.locator(".media-player-title strong").waitFor();
      assert(page.url().includes("fixture-media-layout-movie-1"));
      await page.locator(".media-back-action").click();
      await toggle.waitFor();
      assert.equal(page.url(), originalRoute);
      await galleryMode(page, "电视剧");
      const tvToggle = page.locator(".media-watch-card .media-watch-toggle");
      await tvToggle.waitFor();
      const seriesTitle = await page.locator(".media-watch-card strong").textContent();
      await tvToggle.click();
      await galleryMode(page, "电影");
      await page.reload();
      await page.locator(".media-watch-card").first().waitFor();
      await trigger.click();
      await list.getByRole("combobox", { name: "待看类型" }).selectOption("tv");
      await list.getByRole("button", { name: `打开 · ${seriesTitle}`, exact: true }).click();
      await page.locator(".media-episode-card").first().waitFor();
      assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("seriesKey"), "fixture-media-layout-series");
      assert.equal(await page.locator(".media-episode-card").count(), 2);
      const savedSeries = page.locator(".media-watch-entry .media-watch-toggle");
      assert.equal(await savedSeries.getAttribute("aria-pressed"), "true");
      await trigger.click();
      await list.getByRole("button", { name: `移出待看 · ${seriesTitle}`, exact: true }).click();
      assert.equal(await savedSeries.getAttribute("aria-pressed"), "false");
      await assertNoHorizontalOverflow(page);
    } finally { await page.close(); }
  });
  await run("media: 320px watchlist searches later pages and scopes records to this server and account", async () => {
    const page = await newPage(viewports[0]);
    try {
      await launch(page, "影视布局压力（长片名、剧名与文件信息）", { reuseMediaFixture: true });
      await page.locator(".media-watch-toggle").first().click();
      const key = await page.evaluate(() => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .find(value => value.startsWith("fanhao.android.media.watchlist.v1:")));
      await page.evaluate(key => {
        const prefix = "fanhao.android.media.watchlist.v1:", [origin] = JSON.parse(key.slice(prefix.length));
        const movie = (id, title) => ({ kind: "movie", id, title });
        localStorage.setItem(key, JSON.stringify([movie("target", "Ｆｉｌｍ 目标"), ...Array.from({ length: 42 }, (_, index) => movie(`fixture-${index}`, `片名 ${index}`))]));
        localStorage.setItem(prefix + JSON.stringify([origin, "account:other"]), JSON.stringify([movie("foreign", "其他账号") ]));
        localStorage.setItem(prefix + JSON.stringify(["http://127.0.0.1:1", "guest"]), JSON.stringify([movie("foreign", "其他服务器") ]));
      }, key);
      await page.getByRole("button", { name: "待看清单", exact: true }).click();
      const list = page.getByRole("dialog", { name: "本机待看清单" });
      await list.getByText("43 部待看", { exact: true }).waitFor();
      assert.equal(await list.locator("li").count(), 20);
      await list.getByRole("button", { name: "下一页", exact: true }).click();
      await list.getByText("2 / 3", { exact: true }).waitFor();
      const search = list.getByRole("searchbox", { name: "搜索待看片名" });
      await search.evaluate(input => {
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.value = "film 目标";
        input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      });
      assert.equal(await list.locator("li").count(), 20);
      await search.evaluate(input => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
      assert.equal(await list.locator("li").count(), 1);
      await list.getByRole("button", { name: "打开 · Ｆｉｌｍ 目标", exact: true }).waitFor();
      await search.fill("其他");
      await list.getByText("没有匹配的作品。", { exact: true }).waitFor();
      await search.fill("film 目标");
      await list.getByRole("button", { name: "移出待看 · Ｆｉｌｍ 目标", exact: true }).evaluate(async (button, key) => {
        const prefix = "fanhao.android.media.watchlist.v1:", [origin] = JSON.parse(key.slice(prefix.length));
        const { setAccountOwner } = await import(new URL("js/account-owner.js", location.href));
        setAccountOwner(origin, "account:other");
        button.click();
      }, key);
      await list.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).length, key), 43);
    } finally { await page.close(); }
  });
  await run("media: 320px continue watching ignores a retired scope and opens the confirmed native position", async () => {
    const page = await newPage(viewports[0]);
    const id = "fixture-media-layout-episode-2";
    let releaseOld, startOld, finishOld, tvReads = 0, detailReads = 0;
    const movieGate = new Promise(resolve => { releaseOld = resolve; });
    const movieStarted = new Promise(resolve => { startOld = resolve; });
    const movieFinished = new Promise(resolve => { finishOld = resolve; });
    await page.addInitScript(() => {
      const original = window.fetch;
      window.fetch = (input, options) => {
        const url = new URL(input, location.href);
        const retire = url.pathname === "/api/gallery-media/continue-watching" && url.searchParams.get("kind") === "movie";
        return original(input, retire ? { ...options, signal: undefined } : options);
      };
      window.resumeBridgeCalls = [];
      window.Capacitor = { Plugins: { FanHaoPlayer: {
        async play(options) { window.resumeBridgeCalls.push(options); return { opened: true }; }
      } } };
    });
    await page.route(url => url.pathname === "/api/gallery-media/continue-watching", async route => {
      const kind = new URL(route.request().url()).searchParams.get("kind");
      assert.equal(route.request().headers()["x-fanhao-account-owner"], "guest");
      if (kind === "movie") {
        startOld(); await movieGate;
        try { await route.fulfill({ json: { items: [{ id: "retired-movie", title: "已离开的电影列表", percent: 22 }] } }); }
        finally { finishOld(); }
      } else {
        assert.equal(kind, "tv");
        const items = ++tvReads === 1 ? [{ id, title: "合成断点剧集", episodeTitle: "第 2 集", percent: 96.7,
          coverUrl: "/fixture/poster/tv-one.svg" }, ...[1, 2, 3, 4, 5].map(i => ({ id: `extra-${i}`, title: `合成作品 ${i}`, percent: 40 }))] : [];
        await route.fulfill({ json: { items } });
      }
    });
    await page.route(url => url.pathname === `/api/gallery-media/${id}`, async route => {
      detailReads++;
      const response = await route.fetch(), { item } = await response.json();
      await route.fulfill({ json: { item: { ...item, exists: true, streamUrl: "/fixture/resume.mp4", progress: { position: 116, duration: 120 } } } });
    });
    await page.route(url => url.pathname === `/api/playinfo/${id}`, route => route.fulfill({ json: { mode: "direct", duration: 120 } }));
    try {
      await launch(page, "影视布局压力（长片名、剧名与文件信息）", { reuseMediaFixture: true });
      await movieStarted;
      assert.equal(await page.locator(".media-continue-shelf").count(), 0, "slow progress must leave the catalogue usable");
      await galleryMode(page, "电视剧");
      const shelf = page.getByRole("region", { name: "继续观看" });
      const choice = shelf.getByRole("button", { name: /合成断点剧集 第 2 集 已看 96%/ });
      await choice.waitFor();
      releaseOld(); await movieFinished; await frames(page);
      assert.equal(await page.getByText("已离开的电影列表").count(), 0);
      assert(await shelf.locator("ul").evaluate(list => list.scrollWidth > list.clientWidth), "the six cards scroll within the section");
      await assertNoHorizontalOverflow(page);
      await choice.click();
      await page.waitForFunction(() => window.resumeBridgeCalls.length === 1);
      const [call] = await page.evaluate(() => window.resumeBridgeCalls);
      assert.equal(call.videoId, id);
      assert.equal(call.position, 116, "resume uses authoritative progress even near the end");
      assert.equal(detailReads, 1, "a direct resume consumes its fresh detail only once");
      await page.locator(".media-back-action").click();
      await page.locator(".media-poster-card").waitFor();
      assert.equal(tvReads, 2, "return from playback rechecks the shelf");
      await shelf.waitFor({ state: "hidden" });
    } finally { releaseOld(); await page.close(); }
  });
  await run("media: 320px older server without continue watching still opens an ordinary catalogue detail", async () => {
    const page = await newPage(viewports[0]);
    let reads = 0;
    await page.route(url => url.pathname === "/api/gallery-media/continue-watching", route => {
      reads++;
      return route.fulfill({ status: 404, json: { error: "旧版合成服务没有该入口" } });
    });
    try {
      await launch(page, "影视布局压力（长片名、剧名与文件信息）", { reuseMediaFixture: true });
      assert.equal(reads, 1);
      assert.equal(await page.locator(".media-continue-shelf").count(), 0);
      await page.locator(".media-poster-card").first().click();
      await page.locator(".media-player-title strong").waitFor();
    } finally { await page.close(); }
  });
  await run("media: continue watching manages older records locally and restores new progress", async () => {
    const page = await newPage(viewports[0]);
    const id = "fixture-media-layout-movie-1", latestTitle = "合成试看片", deepTitle = "合成较早断点";
    const longTitle = "SyntheticContinueWatchingLongTitleWithoutBreaks".repeat(8);
    let revision = "old", reads = 0;
    const writes = [];
    await page.addInitScript(() => {
      window.resumeBridgeCalls = [];
      window.Capacitor = { Plugins: { FanHaoPlayer: {
        async play(options) { window.resumeBridgeCalls.push(options); return { opened: true }; }
      } } };
    });
    await page.route(url => url.pathname === "/api/gallery-media/continue-watching", route => {
      const params = new URL(route.request().url()).searchParams;
      assert.equal(params.get("limit"), "24");
      assert.equal(params.get("includeProgressRevision"), "1");
      reads++;
      return route.fulfill({ json: { items: [
        { id: "fixture-try", title: latestTitle, percent: revision === "old" ? 12 : 28, progressRevision: revision },
        ...Array.from({ length: 7 }, (_, i) => ({ id: `fixture-row-${i + 1}`, title: i === 1 ? longTitle : `合成播放 ${i + 1}`,
          percent: 30, ...(i === 0 ? {} : { progressRevision: `r${i + 1}` }) })),
        { id, title: deepTitle, percent: 76, progressRevision: "deep" }
      ] } });
    });
    page.on("request", request => {
      if (request.method() !== "GET" && /\/api\/(?:gallery-media|progress)/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    await page.route(url => url.pathname === `/api/gallery-media/${id}`, async route => {
      const response = await route.fetch(), { item } = await response.json();
      await route.fulfill({ json: { item: { ...item, exists: true, streamUrl: "/fixture/deep-resume.mp4", progress: { position: 182, duration: 240 } } } });
    });
    await page.route(url => url.pathname === `/api/playinfo/${id}`, route => route.fulfill({ json: { mode: "direct", duration: 240 } }));
    const shelf = page.getByRole("region", { name: "继续观看", exact: true });
    const manage = shelf.getByRole("button", { name: "管理记录", exact: true });
    const panel = page.getByRole("dialog", { name: "继续观看记录", exact: true });
    const hide = title => panel.getByRole("button", { name: `隐藏「${title}」`, exact: true });
    const restore = title => panel.getByRole("button", { name: `恢复「${title}」`, exact: true });
    try {
      await launch(page, "影视布局压力（长片名、剧名与文件信息）", { reuseMediaFixture: true });
      await manage.waitFor();
      const key = `fanhao.android.media.continueHidden.v1:${JSON.stringify([origin, "guest"])}`;
      await page.evaluate(({ origin, revision }) => {
        for (const scope of [[origin, "account:other"], ["http://127.0.0.1:1", "guest"]]) {
          localStorage.setItem(`fanhao.android.media.continueHidden.v1:${JSON.stringify(scope)}`, JSON.stringify([["fixture-try", revision]]));
        }
      }, { origin, revision });
      await page.reload();
      await shelf.getByRole("button", { name: new RegExp(latestTitle) }).waitFor();
      assert.equal(await shelf.locator("li").count(), 6);
      assert.equal(await shelf.getByText(deepTitle, { exact: true }).count(), 0);
      const size = await manage.boundingBox();
      assert(size.width >= 44 && size.height >= 44);
      await manage.click();
      await panel.getByText("9 条记录", { exact: true }).waitFor();
      assert.equal(await panel.locator("li").count(), 9);
      assert.equal(await hide("合成播放 1").count(), 0, "legacy progress without a revision remains playable");
      await assertNoHorizontalOverflow(page);
      await page.setViewportSize(viewports[2]);
      assert.equal(await panel.locator("ul").evaluate(list => list.scrollHeight > list.clientHeight), true);
      await assertNoHorizontalOverflow(page);
      const beforeLocalChanges = reads;

      await hide(latestTitle).click();
      await panel.getByText(`已隐藏「${latestTitle}」`, { exact: true }).waitFor();
      assert.equal(await shelf.getByText(latestTitle, { exact: true }).count(), 0);
      assert.equal(await shelf.locator("li").count(), 6, "the next candidate fills the shelf");
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), JSON.stringify([["fixture-try", "old"]]));
      await panel.getByRole("button", { name: "已隐藏 1", exact: true }).click();
      await restore(latestTitle).click();
      await shelf.getByText(latestTitle, { exact: true }).waitFor();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
      await panel.getByRole("button", { name: "可继续", exact: true }).click();
      await hide(latestTitle).click();
      assert.equal(reads, beforeLocalChanges, "management is entirely local after the shelf load");
      assert.deepEqual(writes, []);
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      await panel.waitFor({ state: "hidden" });
      assert.equal(await manage.evaluate(button => button === document.activeElement), true);

      await page.reload();
      await manage.waitFor();
      assert.equal(await shelf.getByText(latestTitle, { exact: true }).count(), 0, "hiding survives reload");
      revision = "new";
      await page.reload();
      await shelf.getByRole("button", { name: /合成试看片 已看 28%/ }).waitFor();
      await manage.click();
      await panel.getByRole("button", { name: "已隐藏 0", exact: true }).waitFor();
      const stale = await hide(latestTitle).elementHandle();
      await stale.evaluate(async (control, origin) => {
        const { setAccountOwner } = await import(new URL("js/account-owner.js", location.href));
        setAccountOwner(origin, "account:other");
        control.click();
      }, origin);
      await panel.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), JSON.stringify([["fixture-try", "old"]]));
      await manage.waitFor();
      await manage.click();
      await panel.getByRole("button", { name: new RegExp(deepTitle) }).filter({ hasText: deepTitle }).first().click();
      await page.waitForFunction(() => window.resumeBridgeCalls.length === 1);
      assert.equal(await page.evaluate(() => window.resumeBridgeCalls[0].position), 182);
    } finally { await page.close(); }
  });
  await run("media: 320px restart keeps a separate resume action and opens at zero", async () => {
    const page = await newPage(viewports[0]);
    const id = "fixture-media-layout-movie-1";
    let position = 60;
    await page.addInitScript(() => {
      window.restartBridgeCalls = [];
      window.Capacitor = { Plugins: { FanHaoPlayer: {
        async play(options) { window.restartBridgeCalls.push(options); return { opened: true }; }
      } } };
    });
    await page.route(url => url.pathname === `/api/gallery-media/${id}`, async route => {
      const response = await route.fetch(), { item } = await response.json();
      await route.fulfill({ json: { item: { ...item, exists: true, streamUrl: "/fixture/restart.mp4", progress: { position, duration: 240 } } } });
    });
    await page.route(url => url.pathname === `/api/playinfo/${id}`, route => route.fulfill({ json: { mode: "direct", duration: 240 } }));
    try {
      await launch(page, "影视布局压力（长片名、剧名与文件信息）", { reuseMediaFixture: true });
      await page.locator(".media-poster-card").first().click();
      const restart = page.getByRole("button", { name: "从头播放", exact: true });
      await restart.waitFor();
      await page.getByRole("button", { name: "继续播放 · 1:00", exact: true }).waitFor();
      const target = await restart.boundingBox();
      assert(target.width >= 44 && target.height >= 44);
      await assertNoHorizontalOverflow(page);
      position = 92;
      await restart.click();
      await page.waitForFunction(() => window.restartBridgeCalls.length === 1);
      const resume = page.getByRole("button", { name: "继续播放 · 1:32", exact: true });
      await resume.click();
      await page.waitForFunction(() => window.restartBridgeCalls.length === 2);
      const calls = await page.evaluate(() => window.restartBridgeCalls);
      assert.deepEqual(calls.map(call => [call.videoId, call.position]), [[id, 0], [id, 92]]);
      assert(calls.every(call => new URL(call.progressUrl).pathname === `/api/progress/${id}`));
    } finally { await page.close(); }
  });
  await run("media: 320px continue watching checks for completion before opening playback", async () => {
    const page = await newPage(viewports[0]);
    const id = "fixture-media-layout-movie-1";
    let detailReads = 0;
    await page.addInitScript(() => {
      window.resumeBridgeCalls = [];
      window.Capacitor = { Plugins: { FanHaoPlayer: {
        async play(options) { window.resumeBridgeCalls.push(options); return { opened: true }; }
      } } };
    });
    await page.route(url => url.pathname === "/api/gallery-media/continue-watching", route => route.fulfill({
      json: { items: [{ id, title: "其他设备已完成的电影", percent: 87 }] }
    }));
    await page.route(url => url.pathname === `/api/gallery-media/${id}`, async route => {
      detailReads++;
      const response = await route.fetch(), { item } = await response.json();
      await route.fulfill({ json: { item: { ...item, exists: true, streamUrl: "/fixture/resume.mp4", progress: { position: 120, duration: 120 } } } });
    });
    await page.route(url => url.pathname === `/api/playinfo/${id}`, route => route.fulfill({ json: { mode: "direct", duration: 120 } }));
    try {
      await launch(page, "影视布局压力（长片名、剧名与文件信息）", { reuseMediaFixture: true });
      await page.getByRole("button", { name: /其他设备已完成的电影/ }).click();
      await page.getByText("观看进度已变化，可以在详情页重新播放。", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.resumeBridgeCalls.length), 0, "a retired resume intent must not start over");
      await page.getByRole("button", { name: "点击播放", exact: true }).click();
      await page.waitForFunction(() => window.resumeBridgeCalls.length === 1);
      assert.equal(await page.evaluate(() => window.resumeBridgeCalls[0].position), 0);
      assert.equal(detailReads, 2, "manual replay reads its own fresh detail");
    } finally { await page.close(); }
  });
  await run("photo: 320px adjacent albums preserve list order, reader and history", async () => {
    const page = await newPage(viewports[0]);
    let firstPageSize = 0, failAlbum = true, held = null;
    const listRequests = [], albumRequests = [];
    const item = (index) => ({
      id: `browse-${index}`, type: "photo", title: `合成相册 ${String(index).padStart(3, "0")}`,
      category: "我喜欢的", coverUrl: "/fixture/poster/photo-one.svg", imageCount: 1
    });
    await page.addInitScript(() => {
      const realFetch = window.fetch;
      window.fetch = (input, options) => {
        const url = new URL(input, location.href);
        return realFetch(input, window.fixtureIgnoreAlbumAbort === url.pathname ? { ...options, signal: undefined } : options);
      };
    });
    await page.route(url => url.origin === origin && url.pathname === "/api/image-library/items"
      && url.searchParams.get("collection") === "fixture-photo", async route => {
      const params = new URL(route.request().url()).searchParams;
      const offset = Number(params.get("offset")), limit = Number(params.get("limit"));
      if (!firstPageSize) firstPageSize = limit;
      listRequests.push(Object.fromEntries(params));
      const total = firstPageSize + 2;
      const items = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => item(offset + i + 1));
      await route.fulfill({ json: {
        mode: "photo", photoView: "albums", category: params.get("category"), collection: "fixture-photo",
        sort: params.get("sort"), items, total, offset, limit, listRevision: "photo-browse-fixture",
        collectionSummary: { id: "fixture-photo", title: "合成套图合集" }, facets: { categories: [], people: [] }
      } });
    });
    await page.route(url => url.origin === origin && /^\/api\/photo-sets\/browse-\d+$/u.test(url.pathname), async route => {
      const pathname = new URL(route.request().url()).pathname;
      const index = Number(pathname.split("-").at(-1));
      albumRequests.push(index);
      if (index === firstPageSize + 1 && failAlbum) {
        failAlbum = false;
        await route.fulfill({ status: 503, json: { error: "相邻套图暂时读取失败" } });
        return;
      }
      if (index === firstPageSize + 2 && held) {
        const wait = held;
        wait.started.resolve();
        await wait.release.promise;
      }
      await route.fulfill({ json: { album: { ...item(index), size: 512,
        images: [{ index: 1, name: "中性合成预览", url: "/fixture/poster/photo-one.svg" }] } } });
    });
    try {
      await launch(page, "新建隔离运行并打开真实页面");
      await page.locator(".photo-collection-card").click();
      const cards = page.locator(".photo-album-card");
      await cards.first().waitFor();
      await page.locator(".photo-sort-action").click();
      const ascending = page.waitForResponse(response => {
        const params = new URL(response.url()).searchParams;
        return params.get("collection") === "fixture-photo" && params.get("direction") === "asc";
      });
      await page.getByRole("dialog").getByRole("button", { name: "期号正序（VOL / NO）", exact: true }).click();
      await ascending;
      await cards.nth(firstPageSize - 1).waitFor();
      await cards.nth(firstPageSize - 1).scrollIntoViewIfNeeded();
      const scroll = await page.evaluate(() => scrollY);
      assert(scroll > 0, "the originating album starts below the list fold");
      await cards.nth(firstPageSize - 1).click();
      const title = page.locator(".photo-detail-main strong");
      await title.waitFor();
      const next = page.getByRole("button", { name: "下一套", exact: true });
      const previous = page.getByRole("button", { name: "上一套", exact: true });
      await next.waitFor();
      for (const control of [previous, next]) {
        const box = await control.boundingBox();
        assert(box.width >= 44 && box.height >= 44);
      }
      await next.click();
      await page.getByText("相邻套图暂时读取失败").waitFor();
      assert.equal(await title.textContent(), item(firstPageSize).title, "failed next album keeps the originating reader");
      assert.equal(await page.locator(".photo-preview-tile").count(), 1);
      const boundary = listRequests.filter(request => Number(request.offset) > 0);
      assert.deepEqual(boundary.map(request => [request.offset, request.category, request.collection, request.sort, request.direction]),
        [[String(firstPageSize), "我喜欢的", "fixture-photo", "issue", "asc"]]);
      const historyLength = await page.evaluate(() => history.length);
      await next.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(url => url.hash === `#photoDetail?id=browse-${firstPageSize + 1}`);
      await title.waitFor();
      assert.equal(await title.textContent(), item(firstPageSize + 1).title);
      assert.equal(await next.evaluate(button => button === document.activeElement), true);
      assert.equal(await page.evaluate(() => history.length), historyLength);
      assert.deepEqual(albumRequests, [firstPageSize, firstPageSize + 1, firstPageSize + 1]);
      assert.equal(listRequests.filter(request => Number(request.offset) > 0).length, 1);
      await page.goBack();
      await cards.nth(firstPageSize - 1).waitFor();
      await frames(page);
      await page.waitForFunction(() => history.state?.scrollY > 0 && Math.abs(scrollY - history.state.scrollY) < 32, null, { timeout: 5000 });
      const original = await cards.nth(firstPageSize - 1).boundingBox();
      assert(original.y < viewports[0].height && original.y + original.height > 0, "Back restores the originating card to the viewport");
      const returnUrl = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
      assert.equal(returnUrl.get("direction"), "asc");
      assert.equal(await cards.count(), firstPageSize);
      await page.goForward();
      await next.waitFor();
      assert.equal(await title.textContent(), item(firstPageSize + 1).title, "Forward restores the in-document album list");
      held = { started: Promise.withResolvers(), release: Promise.withResolvers() };
      await page.evaluate(path => { window.fixtureIgnoreAlbumAbort = path; }, `/api/photo-sets/browse-${firstPageSize + 2}`);
      await next.click();
      await held.started.promise;
      await page.goBack();
      await cards.nth(firstPageSize - 1).waitFor();
      const lateResponse = page.waitForResponse(response => response.url().includes(`/api/photo-sets/browse-${firstPageSize + 2}?`));
      held.release.resolve();
      await lateResponse;
      await frames(page);
      assert.equal(await title.count(), 0, "late adjacent reply cannot reopen the reader");
      await page.goForward();
      await previous.click();
      await page.waitForURL(url => url.hash === `#photoDetail?id=browse-${firstPageSize}`);
      assert.equal(await title.textContent(), item(firstPageSize).title, "Previous reopens the previous album in the same order");
      await next.click();
      await page.waitForURL(url => url.hash === `#photoDetail?id=browse-${firstPageSize + 1}`);
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      await cards.nth(firstPageSize - 1).waitFor();
      assert.equal(await cards.count(), firstPageSize, "native Back also returns to the originating list range");
      await cards.nth(firstPageSize - 1).click();
      await next.waitFor();
      await page.reload();
      await title.waitFor();
      assert.equal(await next.count(), 0, "a fresh direct reader does not claim the old document's list");
      await assertNoHorizontalOverflow(page);
    } finally {
      held?.release.resolve();
      await page.close();
    }
  });
  await run("photo: deep resume remembers the last loaded page and verifies the archive", async () => {
    const page = await newPage(viewports[0]);
    const id = "fixture-photo-album", title = "合成套图：湖畔晨光";
    const total = 30, firstRevision = "a".repeat(24);
    let revision = firstRevision, held = null;
    const metadataRequests = [], viewerRequests = [];
    await page.route(url => url.origin === origin && url.pathname === `/api/photo-sets/${id}`, async route => {
      const params = new URL(route.request().url()).searchParams;
      const limit = params.get("imageLimit"), offset = Number(params.get("imageOffset") || 0);
      const length = Math.min(total - offset, limit === "all" ? total : Number(limit || 12));
      metadataRequests.push(limit);
      if (held && limit !== "all") {
        const wait = held;
        wait.started.resolve();
        await wait.release.promise;
      }
      await route.fulfill({ json: { album: { id, title, type: "photo", category: "我喜欢的", size: 1024,
        updatedAt: "2026-01-01T00:00:00.000Z", imageCount: total, imageRevision: revision,
        imageOffset: offset, imageLimit: length, imagesTruncated: length < total,
        coverUrl: "/fixture/poster/photo-one.svg",
        images: Array.from({ length }, (_, i) => ({
          index: offset + i + 1, name: `合成图片 ${offset + i + 1}`, url: `/media/gallery/${id}/${offset + i + 1}`
        }))
      } } });
    });
    await page.route(url => url.origin === origin && url.pathname.startsWith(`/media/gallery/${id}/`), async route => {
      const url = new URL(route.request().url());
      const index = Number(url.pathname.split("/").at(-1)), archive = url.searchParams.get("archive");
      if (archive) viewerRequests.push([index, archive]);
      if (index === 23) {
        await route.fulfill({ status: 503, headers: { "cache-control": "no-store" } });
        return;
      }
      await route.fulfill({ contentType: "image/svg+xml", headers: { "cache-control": "no-store" },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#68a"/></svg>' });
    });
    const ready = page.locator('.media-viewer-stage[data-image-state="ready"]');
    const counter = page.locator(".media-viewer-count");
    const resume = index => page.getByRole("button", { name: `继续第 ${index} 张`, exact: true });
    const shelf = page.getByRole("region", { name: "继续浏览套图" });
    const jump = index => page.locator(".media-viewer-range").evaluate((range, value) => {
      range.value = String(value);
      range.dispatchEvent(new Event("input", { bubbles: true }));
    }, index);
    try {
      await launch(page, "新建隔离运行并打开真实页面");
      await page.locator(".photo-collection-card").click();
      await page.locator(".photo-album-card").click();
      await page.locator(".photo-preview-tile").first().click();
      await ready.waitFor();
      assert.equal(await counter.textContent(), "1 / 30");
      assert.equal(await resume(1).count(), 0);
      await jump(22);
      await ready.waitFor();
      assert.equal(await counter.textContent(), "22 / 30");
      await jump(23);
      await page.locator('.media-viewer-stage[data-image-state="error"]').waitFor();
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      await resume(22).waitFor();
      const box = await resume(22).boundingBox();
      assert(box.width >= 44 && box.height >= 44);
      await resume(22).click();
      await ready.waitFor();
      assert.equal(await counter.textContent(), "22 / 30", "a failed page preserves the last successfully loaded page");
      assert(viewerRequests.some(([index, archive]) => index === 22 && archive === firstRevision));
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      await page.locator(".photo-album-card").waitFor();
      await page.getByRole("button", { name: "返回分类", exact: true }).click();
      await shelf.getByRole("button", { name: /合成套图：湖畔晨光.*第 22 张/u }).waitFor();
      await page.reload();
      await shelf.locator("ul").getByRole("button").click();
      await ready.waitFor();
      assert.equal(await counter.textContent(), "22 / 30", "shelf resumes the exact page after reloading the shell");
      assert.equal(metadataRequests.includes("all"), false, "numbered media deep links avoid full archive metadata");
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      held = { started: Promise.withResolvers(), release: Promise.withResolvers() };
      await page.reload();
      await held.started.promise;
      await page.locator(".photo-preview-tile").nth(2).click();
      await ready.waitFor();
      assert.match(await counter.textContent(), /^3 \//u, "the cached detail is usable while verifying its revision");
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      assert.equal(await resume(3).count(), 0, "unverified cached metadata cannot write a saved position");
      held.release.resolve();
      held = null;
      await resume(3).waitFor();
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      await shelf.waitFor();
      revision = "b".repeat(24);
      await shelf.locator("ul").getByRole("button").click();
      await page.getByText("套图已变化，已清除旧的浏览位置。").waitFor();
      assert.equal(await counter.count(), 0, "stale cached metadata must not open the old archive page");
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      await page.locator(".photo-collection-card").waitFor();
      assert.equal(await shelf.count(), 0);
      await assertNoHorizontalOverflow(page);
    } finally { held?.release.resolve(); await page.close(); }
  });
  await run("photo: reading history searches older records and updates the device shelf", async () => {
    const page = await newPage(viewports[0]);
    const id = "fixture-photo-album", title = "Ａlbum 湖畔晨光";
    const revision = "c".repeat(24), total = 30;
    const records = Array.from({ length: 40 }, (_, index) => ({
      id: index === 39 ? id : `history-${index + 1}`,
      title: index === 39 ? title : `合成浏览记录 ${index + 1}`,
      page: index === 39 ? 22 : index + 2,
      revision
    }));
    await page.addInitScript(records => {
      const run = /^\/run\/([a-f0-9-]{36})\//.exec(location.pathname);
      if (!run) return;
      const prefix = `gallery-navigation-fixture:${run[1]}:`;
      if (sessionStorage.getItem(prefix + "photo-history-fixture")) return;
      sessionStorage.setItem(prefix + "photo-history-fixture", "1");
      const key = owner => `${prefix}fanhao.android.photoReadingPositions.v1:${JSON.stringify([location.origin, owner])}`;
      localStorage.setItem(key("guest"), JSON.stringify(records));
      localStorage.setItem(key("account:otherFixture"), JSON.stringify([{ ...records[0], title: "另一账号的记录" }]));
    }, records);
    const requests = [];
    await page.route(url => url.origin === origin && url.pathname === `/api/photo-sets/${id}`, async route => {
      const params = new URL(route.request().url()).searchParams;
      const offset = Number(params.get("imageOffset") || 0), limit = params.get("imageLimit");
      const length = Math.min(total - offset, limit === "all" ? total : Number(limit || 12));
      requests.push(limit);
      await route.fulfill({ json: { album: { id, title, type: "photo", category: "我喜欢的", size: 1024,
        updatedAt: "2026-01-01T00:00:00.000Z", imageCount: total, imageRevision: revision,
        imageOffset: offset, imageLimit: length, imagesTruncated: length < total,
        coverUrl: "/fixture/poster/photo-one.svg",
        images: Array.from({ length }, (_, index) => ({
          index: offset + index + 1, name: `合成图片 ${offset + index + 1}`, url: `/media/gallery/${id}/${offset + index + 1}`
        }))
      } } });
    });
    await page.route(url => url.origin === origin && url.pathname.startsWith(`/media/gallery/${id}/`), route => route.fulfill({
      contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#68a"/></svg>'
    }));
    const shelf = page.getByRole("region", { name: "继续浏览套图" });
    const trigger = shelf.getByRole("button", { name: "浏览记录", exact: true });
    const dialog = page.getByRole("dialog", { name: "套图浏览记录", exact: true });
    const search = dialog.getByRole("searchbox", { name: "搜索套图浏览记录" });
    try {
      await launch(page, "新建隔离运行并打开真实页面", { reusePhotoFixture: true });
      assert.equal(await shelf.locator("li").count(), 4);
      assert.equal(await shelf.getByText(title, { exact: true }).count(), 0);
      await trigger.click();
      assert.equal(await dialog.locator("li").count(), 40);
      assert.equal(await dialog.getByText("另一账号的记录").count(), 0);
      assert.equal(await dialog.locator("ul").evaluate(node => node.scrollHeight > node.clientHeight), true);
      await assertNoHorizontalOverflow(page);

      await search.fill("合成浏览记录 1");
      const remove = dialog.getByRole("button", { name: "移除「合成浏览记录 1」的浏览记录", exact: true });
      await remove.click();
      await dialog.getByText("已移除浏览记录 · 剩余 39 条", { exact: true }).waitFor();
      assert.equal(await search.inputValue(), "合成浏览记录 1");
      assert.equal(await shelf.getByText("合成浏览记录 1", { exact: true }).count(), 0);
      assert.equal(await shelf.getByText("合成浏览记录 5", { exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      assert.equal(await dialog.count(), 0);
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);

      await page.reload();
      await trigger.click();
      assert.equal(await dialog.locator("li").count(), 39);
      await search.fill("没有这条记录");
      await dialog.getByText("没有匹配的套图", { exact: true }).waitFor();
      await search.fill("合成浏览记录 19");
      await page.evaluate(() => {
        const key = `fanhao.android.photoReadingPositions.v1:${JSON.stringify([location.origin, "guest"])}`;
        const history = JSON.parse(localStorage.getItem(key));
        history.find(record => record.id === "history-19").page = 27;
        localStorage.setItem(key, JSON.stringify(history));
      });
      await dialog.getByRole("button", { name: "移除「合成浏览记录 19」的浏览记录", exact: true }).click();
      await dialog.getByText("无法移除这条浏览记录，请重新打开后重试", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: /合成浏览记录 19.*第 20 张/u }).click();
      await dialog.getByText("浏览位置已更新，请重新选择", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: /合成浏览记录 19.*第 27 张/u }).waitFor();
      await search.fill(" album 湖畔 ");
      assert.equal(await dialog.locator("li").count(), 1);
      assert.deepEqual(requests, [], "reading, filtering and removing positions use device storage");
      await dialog.getByRole("button", { name: /Ａlbum 湖畔晨光.*第 22 张/u }).click();
      await page.locator('.media-viewer-stage[data-image-state="ready"]').waitFor();
      assert.equal(await dialog.count(), 0);
      assert.equal(await page.locator(".media-viewer-count").textContent(), "22 / 30");
      assert.equal(requests.includes("all"), false);
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      await shelf.getByText(title, { exact: true }).waitFor();
    } finally { await page.close(); }
  });
  await run("default: 320x568 original photo, movies and series remain reachable", async () => {
    const page = await newPage(viewports[0]);
    try {
      await launch(page, "新建隔离运行并打开真实页面");
      assert.equal(await page.locator(".photo-collection-card").count(), 1);
      await galleryMode(page, "电影"); await page.locator(".media-poster-card").first().waitFor();
      assert.deepEqual(await page.locator(".media-poster-card strong").allTextContents(), ["合成电影：远航计划", "合成电影：暮色列车"]);
      await page.locator(".media-poster-card").first().click(); await page.locator(".media-player-title strong").waitFor();
      await visibleTail(page.locator(".media-player-title strong"), "ordinary movie title"); await assertNoHorizontalOverflow(page);
      await page.locator(".media-back-action").click(); await page.locator(".media-poster-card").first().waitFor();
      await galleryMode(page, "电视剧"); await page.locator(".media-poster-card").waitFor();
      assert.equal(await page.locator(".media-poster-card strong").textContent(), "合成剧集：春日车站");
      await page.locator(".media-poster-card").click(); await page.locator(".media-episode-card").first().waitFor();
      assert.equal(await page.locator(".media-episode-card").count(), 2); await assertNoHorizontalOverflow(page);
    } finally { await page.close(); }
  });
  assert(checks > 0, "case filter must select a scenario"); assert.deepEqual(faults, []);
  console.log(JSON.stringify({ result: "PASS", scenarios: checks, profiles, frozenRuns,
    boundary: "Actual Chromium full shell and synthetic GET DTOs; no real library, media bytes, native player or device claim" }, null, 2));
} finally {
  await browser?.close(); service.kill("SIGTERM");
  await Promise.race([serviceExit, new Promise(resolve => setTimeout(resolve, 3000))]);
}

async function newPage(viewport) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", error => faults.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) { faults.push(`external ${url.origin}${url.pathname}`); return route.abort(); }
    if (!["GET", "HEAD"].includes(request.method()) && url.pathname !== "/fixture/new-run") { faults.push(`unexpected write ${request.method()} ${url.pathname}`); return route.abort(); }
    if (/^\/media\/(?:gallery-video|gallery-stream|video)\//.test(url.pathname)) { faults.push(`unexpected media ${url.pathname}`); return route.abort(); }
    await route.continue();
  });
  // Mutation hooks operate on the exact served product CSS, retaining the rest
  // of its current cascade and the fixture's real app/modules.
  if (legacyTitle || legacyFacts) await page.route(url => url.pathname.endsWith("/modules/media/styles.css"), async route => {
    const response = await route.fetch(); let body = await response.text();
    if (legacyTitle) {
      const marker = ' .media-player-title strong {\n  display: block;\n  overflow: visible;\n  white-space: normal;\n  -webkit-line-clamp: unset;';
      assert.equal(body.replaceAll("\r\n", "\n").split(marker).length, 2, "title negative changes one actual detail rule");
      body = body.replaceAll("\r\n", "\n").replace(marker, ' .media-player-title strong {');
    }
    if (legacyFacts) {
      const marker = '.content-panel[data-view="mediaDetail"]:is([data-channel-mode="movie"], [data-channel-mode="tv"], [data-channel-mode="anime"], [data-channel-mode="media"]) .media-detail-facts > span {\n  min-width: 0;\n  max-width: 100%;\n  white-space: normal;\n  overflow-wrap: anywhere;\n}';
      assert.equal(body.replaceAll("\r\n", "\n").split(marker).length, 2, "facts negative removes one actual scoped wrap rule");
      body = body.replaceAll("\r\n", "\n").replace(marker, "/* scoped file-fact wrapping omitted */");
    }
    await route.fulfill({ response, body });
  });
  if (legacyPhotoReturn) await page.route(url => url.pathname.endsWith("/modules/photos/styles.css"), async route => {
    const response = await route.fetch(); let body = await response.text();
    const marker = '.content-panel[data-channel-mode="photo"] .channel-context-row button {\n  min-height: 44px;\n}';
    assert.equal(body.replaceAll("\r\n", "\n").split(marker).length, 2, "photo negative removes one actual contextual return rule");
    body = body.replaceAll("\r\n", "\n").replace(marker, "/* contextual return 44px target omitted */");
    await route.fulfill({ response, body });
  });
  return page;
}
async function launch(page, label, { reuseMediaFixture = false, reusePhotoFixture = false } = {}) {
  // These read-only cases share frozen assets within the fixture's run cap.
  // Each new page still owns its own browser context, storage and routes.
  if (reuseMediaFixture && mediaFixtureUrl) {
    await page.goto(mediaFixtureUrl);
    await page.locator(".media-poster-card").first().waitFor(); await frames(page);
    return;
  }
  if (reusePhotoFixture && photoFixtureUrl) {
    await page.goto(photoFixtureUrl);
    await page.locator(".photo-collection-card").first().waitFor(); await frames(page);
    return;
  }
  await page.goto(origin);
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForURL(url => url.pathname.startsWith("/run/"));
  const runId = new URL(page.url()).pathname.split("/")[2];
  const frozen = (await (await page.request.get(`${origin}/fixture/requests?run=${runId}`)).json()).runs[0];
  if (frozen.scenario === "media-layout" && !mediaFixtureUrl) mediaFixtureUrl = new URL(frozen.url, origin).href;
  if (frozen.scenario === "default" && !photoFixtureUrl) photoFixtureUrl = new URL(frozen.url, origin).href;
  frozenRuns.push({ runId: frozen.runId, scenario: frozen.scenario,
    files: frozen.files.filter(file => ["app.js", "modules/media/styles.css", "modules/photos/styles.css"].includes(file.name)).map(file => ({ name: file.name, sha256: file.servedSha256 })) });
  await page.locator(frozen.scenario === "default" ? ".photo-collection-card" : ".media-poster-card").first().waitFor(); await frames(page);
}
async function galleryMode(page, label) {
  const trigger = page.locator(".bottom-nav [data-gallery-switcher]");
  await trigger.focus(); await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "选择图库或影视", exact: true });
  await menu.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
}
async function assertNoHorizontalOverflow(page) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth,
    panel: document.querySelector("#contentPanel").getBoundingClientRect().toJSON() }));
  assert(geometry.html <= geometry.width + 1 && geometry.body <= geometry.width + 1, `page has no horizontal overflow: ${JSON.stringify(geometry)}`);
  assert(geometry.panel.left >= -1 && geometry.panel.right <= geometry.width + 1, "content panel remains within the viewport");
}
async function visibleTail(locator, message) {
  const geometry = await locator.evaluate(node => {
    const text = node.textContent, walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) if (walker.currentNode.textContent) nodes.push(walker.currentNode);
    const last = nodes.at(-1), range = document.createRange();
    range.setStart(last, Math.max(0, last.textContent.length - 12)); range.setEnd(last, last.textContent.length);
    return { text, box: node.getBoundingClientRect().toJSON(), tail: [...range.getClientRects()].map(rect => rect.toJSON()),
      width: node.clientWidth, scrollWidth: node.scrollWidth, viewport: innerWidth };
  });
  assert(geometry.tail.length > 0, `${message}: actual trailing text has layout`);
  for (const tail of geometry.tail) assert(tail.left >= geometry.box.left - 1 && tail.right <= geometry.box.right + 1
    && tail.top >= geometry.box.top - 1 && tail.bottom <= geometry.box.bottom + 1
    && tail.left >= -1 && tail.right <= geometry.viewport + 1, `${message}: trailing text is inside its visible box: ${JSON.stringify(geometry)}`);
  assert(geometry.scrollWidth <= geometry.width + 1, `${message}: no internal horizontal overflow: ${JSON.stringify(geometry)}`);
  return { textLength: geometry.text.length, height: geometry.box.height };
}
async function assertDetail(page, expectedTitle, profile) {
  const title = page.locator(".media-player-title strong");
  assert((await title.textContent()).includes(expectedTitle), "real detail retains the selected title");
  const titleGeometry = await visibleTail(title, `${profile} detail title`);
  await page.locator(".media-detail-summary > summary").click();
  const facts = page.locator(".media-detail-facts"), rootLabel = facts.locator("span").last();
  await rootLabel.scrollIntoViewIfNeeded(); await frames(page);
  await visibleTail(rootLabel, `${profile} root label`);
  const rootBounds = await rootLabel.boundingBox(), factsBounds = await facts.boundingBox();
  assert(rootBounds.x >= factsBounds.x - 1 && rootBounds.x + rootBounds.width <= factsBounds.x + factsBounds.width + 1, "root label wraps inside facts");
  await visibleTail(page.locator(".media-detail-path"), `${profile} relative path`);
  await assertNoHorizontalOverflow(page);
  return titleGeometry;
}

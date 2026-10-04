import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual Web host/modules and Chromium; all API responses/images are synthetic.
// Ignoring AbortSignal deliberately proves ownership independently of transport.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
export async function runGalleryReaderFixture({ timings = false, legacy = false, legacyHost = false, casePattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for the private browser fixture");
  const overrides = new Map(), held = new Set(), requests = new Map(), faults = [];
  if (legacy) for (const file of ["gallery-page.js", "gallery-renderer.js"]) {
    const relative = `public/modules/content-index/${file}`;
    const result = spawnSync("git", ["show", `HEAD:${relative}`], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set(`/${relative.slice(7)}`, result.stdout);
  }
  if (legacyHost) {
    const result = spawnSync("git", ["show", "HEAD:public/js/standalone-host.js"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set("/js/standalone-host.js", result.stdout);
  }
  let browser = null, checks = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    try {
      const gate = [...held].find(value => !value.used && value.match(url));
      if (gate) {
        gate.used = true; gate.url = key; res.once("close", () => { gate.closed = true; });
        gate.requestedResolve(); await gate.promise;
        if (gate.error) { sendJson(res, { error: gate.error }, 503); return; }
      }
      if (url.pathname === "/probe") { sendText(res, harness(), "text/html; charset=utf-8"); return; }
      const albumMatch = /^\/api\/photo-sets\/([^/]+)$/.exec(url.pathname);
      if (albumMatch) {
        const offset = Number(url.searchParams.get("imageOffset") || 0);
        const limit = url.searchParams.get("imageLimit") === "all" ? 10000 : Number(url.searchParams.get("imageLimit") || 160);
        sendJson(res, { album: album(albumMatch[1], offset, limit), cache: null }); return;
      }
      const chapterMatch = /^\/api\/manga\/([^/]+)\/chapters\/([^/]+)$/.exec(url.pathname);
      if (chapterMatch) {
        const comic = manga(chapterMatch[1]), index = Number(chapterMatch[2]);
        sendJson(res, { comic, chapter: { index, title: `Chapter ${index}`, imageCount: 3, images: album(`C-${index}`, 0, 3).images } }); return;
      }
      const comicMatch = /^\/api\/manga\/([^/]+)$/.exec(url.pathname);
      if (comicMatch) { sendJson(res, { comic: manga(comicMatch[1]) }); return; }
      if (url.pathname === "/api/manga") { sendJson(res, { comics: [manga("C")] }); return; }
      const mediaMatch = /^\/api\/gallery-media\/([^/]+)$/.exec(url.pathname);
      if (mediaMatch) { sendJson(res, { item: { id: mediaMatch[1], title: `Media ${mediaMatch[1]}`, mediaKind: mediaMatch[1] === "Movie" ? "movie" : "western", streamUrl: "" } }); return; }
      if (url.pathname === "/api/image-library/items") { sendJson(res, { items: [listItem("A"), listItem("B")], count: 2, total: 2, facets: {} }); return; }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname === "/api/image-library/summary") { sendJson(res, { totals: { photoSets: 2, manga: 1 }, facets: {}, scannedAt: "synthetic", cache: null }); return; }
      if (url.pathname.startsWith("/synthetic/")) {
        sendText(res, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#729b7c"/></svg>', "image/svg+xml", "public, max-age=86400"); return;
      }
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), "text/javascript"); return; }
      const target = /^\/(?:photo|manga|media|western)(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`));
      sendText(res, await fs.promises.readFile(target), target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : "text/css");
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(error.message); } }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    for (const error of ["", "old reader error"]) {
      await run(`host late album ${error ? "error" : "success"}`, async () => {
        const page = await newPage({ real: true });
        try {
          const late = hold(url => url.pathname === "/api/photo-sets/A", error);
          await clickAlbum(page, "A"); await requested(late); await clickAlbum(page, "B"); await readerTitle(page, "Album B"); await settle(page, late);
          assert.equal(await page.locator(".gallery-reader-title strong").textContent(), "Album B");
          assert.match(page.url(), /\/photo\/set\/B/, "stale album must not rewrite the actual standalone route");
          assert(!(await page.locator("#workGrid").textContent()).includes("old reader error"));
          assert(await page.evaluate(() => __transport.aborted.length > 0), "new intent must abort even when the transport ignores the signal");
        } finally { await page.close(); }
      });
      await run(`host back late pagination ${error ? "error" : "success"}`, async () => {
        const page = await newPage({ real: true });
        try {
          await clickAlbum(page, "A"); await readerTitle(page, "Album A");
          const late = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"), error);
          await more(page); await requested(late); await page.locator(".gallery-reader-back").click(); await page.locator(".gallery-card").first().waitFor(); await settle(page, late);
          assert.equal(await page.locator(".gallery-reader-title").count(), 0, "back must not be undone by late pagination");
          assert(!(await page.locator("#workGrid").textContent()).includes("old reader error")); assert.equal(new URL(page.url()).pathname, "/photo/albums");
        } finally { await page.close(); }
      });
      await run(`pagination owner and finally ${error ? "error" : "success"}`, async () => {
        const page = await newPage();
        try {
          await open(page, "A"); const old = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"), error);
          await more(page); await requested(old); await open(page, "B");
          const current = hold(url => url.pathname === "/api/photo-sets/B" && url.searchParams.has("imageOffset"));
          await more(page); await requested(current); await settle(page, old);
          assert.deepEqual(await page.evaluate(() => ({ id: fixture.state.gallery.album.id, count: fixture.state.gallery.album.images.length, status: fixture.state.gallery.status, disabled: document.querySelector(".gallery-more").disabled })),
            { id: "B", count: 160, status: "正在继续读取图片", disabled: true }, "old finally/error must not clear the current loading owner");
          await settle(page, current); assert.equal(await page.evaluate(() => fixture.state.gallery.album.images.length), 320); assert.equal(await page.locator(".gallery-more").isDisabled(), false);
        } finally { await page.close(); }
      });
    }
    await run("normal transport abort", async () => {
      const page = await newPage({ ignoreAbort: false });
      try {
        const old = hold(url => url.pathname === "/api/photo-sets/A");
        await page.evaluate(() => { fixture.pending = fixture.page.openPhotoSet("A"); }); await requested(old); await open(page, "B"); await page.evaluate(() => fixture.pending);
        assert.equal(await page.evaluate(() => fixture.state.gallery.album.id), "B"); await until(() => old.closed, "aborted transport must close"); old.release();
      } finally { await page.close(); }
    });
    await run("same album reopened generation", async () => {
      const page = await newPage();
      try {
        await open(page, "A"); const old = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"), "old reader error");
        await more(page); await requested(old); await page.locator(".gallery-reader-back").click(); await open(page, "A");
        const current = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset")); await more(page); await requested(current);
        await settle(page, old); assert.equal(await page.locator(".gallery-more").isDisabled(), true);
        assert.equal(await page.evaluate(() => fixture.state.gallery.status), "正在继续读取图片"); assert.equal(await page.evaluate(() => fixture.state.gallery.album.images.length), 160);
        await settle(page, current); assert.equal(await page.evaluate(() => fixture.state.gallery.album.images.length), 320);
      } finally { await page.close(); }
    });
    await run("shared reader album manga gallery navigation", async () => {
      const page = await newPage();
      try {
        const oldAlbum = hold(url => url.pathname === "/api/photo-sets/A"); await page.evaluate(() => { fixture.page.openPhotoSet("A"); }); await requested(oldAlbum);
        await page.evaluate(() => { fixture.state.gallery.mode = "manga"; return fixture.page.openMangaComic("C"); }); await settle(page, oldAlbum);
        assert.deepEqual(await page.evaluate(() => [fixture.state.gallery.album, fixture.state.gallery.comic.id, fixture.state.gallery.chapter.index]), [null, "C", 1]);
        const oldChapter = hold(url => url.pathname === "/api/manga/C/chapters/2", "old chapter error"); await page.evaluate(() => { fixture.page.openMangaChapter(2); }); await requested(oldChapter);
        await page.evaluate(() => { fixture.state.gallery.mode = "western"; return fixture.page.openGalleryMedia("W"); }); await settle(page, oldChapter);
        assert.deepEqual(await page.evaluate(() => [fixture.state.gallery.comic, fixture.state.gallery.chapter, fixture.state.gallery.media.id, fixture.state.gallery.status]), [null, null, "W", ""]);
        const oldMedia = hold(url => url.pathname === "/api/gallery-media/Movie"); await page.evaluate(() => { fixture.page.openGalleryMedia("Movie"); }); await requested(oldMedia);
        await page.evaluate(() => { fixture.state.gallery.mode = "photo"; return fixture.page.openPhotoSet("B"); }); await settle(page, oldMedia);
        assert.equal(await page.evaluate(() => fixture.state.gallery.album.id), "B"); assert(!page.url().includes("player.html"), "old movie must not redirect the album");
      } finally { await page.close(); }
    });
    await run("chapter and directory late responses", async () => {
      const page = await newPage();
      try {
        await page.evaluate(() => { fixture.state.gallery.mode = "manga"; return fixture.page.openMangaComic("C"); });
        const old = hold(url => url.pathname === "/api/manga/C/chapters/1"); await page.evaluate(() => { fixture.page.openMangaChapter(1); }); await requested(old);
        await page.evaluate(() => fixture.page.openMangaChapter(2)); await settle(page, old); assert.equal(await page.evaluate(() => fixture.state.gallery.chapter.index), 2);
        const lateComic = hold(url => url.pathname === "/api/manga/D"); await page.evaluate(() => { fixture.page.openMangaComic("D"); }); await requested(lateComic);
        await page.evaluate(() => { fixture.page.resetReader(); fixture.renderer.renderView(); }); const before = countRequests(url => url.pathname.startsWith("/api/manga/D/chapters/")); await settle(page, lateComic);
        assert.equal(await page.evaluate(() => fixture.state.gallery.comic), null); assert.equal(countRequests(url => url.pathname.startsWith("/api/manga/D/chapters/")), before, "late directory must not launch a chapter");
      } finally { await page.close(); }
    });
    await run("host pager late metadata retains page and zoom", async () => {
      const page = await newPage({ real: true });
      try {
        await clickAlbum(page, "A"); await readerTitle(page, "Album A"); const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
        await page.locator(".gallery-reader-open").click(); await requested(full);
        const next = page.locator(".gallery-image-pager-controls").getByRole("button", { name: "下一张", exact: true }); await next.click(); await next.click();
        await page.locator(".gallery-image-pager-top-actions").getByRole("button", { name: "放大图片", exact: true }).click();
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 3 \/ 160 张/);
        const src = await page.locator(".gallery-image-pager-stage img").getAttribute("src"); await settle(page, full);
        await page.waitForFunction(() => document.querySelector(".gallery-image-pager-range")?.max === "10000");
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 3 \/ 10,000 张/); assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%");
        assert.equal(await page.locator(".gallery-image-pager-stage img").getAttribute("src"), src);
      } finally { await page.close(); }
    });
    await run("full metadata single flight and stale overlay", async () => {
      const page = await newPage();
      try {
        await open(page, "A"); const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all"), before = countRequests(full.match);
        await page.locator(".gallery-reader-open").click(); await requested(full); await page.keyboard.press("Escape"); await page.locator(".gallery-reader-open").click(); await tick(page);
        assert.equal(countRequests(full.match) - before, 1, "reopening shares the full metadata task"); await open(page, "B"); await settle(page, full);
        assert.equal(await page.evaluate(() => fixture.state.gallery.album.id), "B"); assert.equal(await page.evaluate(() => Boolean(fixture.state.gallery.album.fullImages)), false); assert.equal(await page.locator(".gallery-image-pager").count(), 0);
      } finally { await page.close(); }
    });
    for (const observer of [true, false]) await run(`append retains DOM queue ${observer ? "observer" : "fallback"}`, async () => {
      const page = await newPage({ observer });
      try {
        await open(page, "A"); await page.waitForFunction(() => document.querySelector(".gallery-reader-figure")?.classList.contains("loaded")); await tick(page);
        const pending = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"));
        const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all"), before = countRequests(pending.match);
        await page.evaluate(() => {
          fixture.first = document.querySelector(".gallery-reader-figure"); fixture.img = fixture.first.querySelector("img"); fixture.readerObserver = __readerObservers.at(-1); fixture.viewer = document.querySelector(".gallery-reader-images");
          const button = document.querySelector(".gallery-more"); button.dispatchEvent(new MouseEvent("click")); button.dispatchEvent(new MouseEvent("click"));
        }); await requested(pending); await page.locator(".gallery-reader-open").click(); await requested(full);
        await page.locator(".gallery-image-pager-controls").getByRole("button", { name: "下一张", exact: true }).click(); await page.evaluate(() => { fixture.overlay = document.querySelector(".gallery-image-pager"); }); await settle(page, pending);
        assert.equal(countRequests(pending.match) - before, 1, "double append click issues one page request"); assert.equal(await page.locator(".gallery-reader-figure").count(), 320);
        assert.equal(await page.evaluate(() => new Set(fixture.state.gallery.album.images.map(image => image.index)).size), 320);
        assert.equal(await page.evaluate(() => fixture.first === document.querySelector(".gallery-reader-figure") && fixture.img === fixture.first.querySelector("img") && fixture.viewer === document.querySelector(".gallery-reader-images")), true);
        assert.equal(await page.evaluate(() => fixture.overlay === document.querySelector(".gallery-image-pager")), true); assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 2 \/ 160 张/);
        if (observer) assert.deepEqual(await page.evaluate(() => ({ same: fixture.readerObserver === __readerObservers.at(-1), disconnected: fixture.readerObserver.disconnected, observed: fixture.readerObserver.observed.size })), { same: true, disconnected: false, observed: 320 });
        await settle(page, full); assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 2 \/ 10,000 张/); await page.keyboard.press("Escape");
        // Decoding the synthetic 800x1000 neighbours changes intrinsic heights.
        // Keep the target in view while those heights settle, just as scrolling
        // toward it would; an unregistered appended figure still never loads.
        const deadline = Date.now() + 5000;
        while (!await page.evaluate(() => document.querySelector('.gallery-reader-figure[data-image-index="161"]')?.classList.contains("loaded"))) {
          assert(Date.now() < deadline, "appended figure must enter the existing image loader");
          await page.locator('.gallery-reader-figure[data-image-index="161"]').scrollIntoViewIfNeeded(); await tick(page);
        }
      } finally { await page.close(); }
    });
    await run("page task single flight and summary preserves overlay", async () => {
      const page = await newPage();
      try {
        await open(page, "A"); const pending = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"));
        await page.evaluate(() => { const a = fixture.page.loadPhotoReaderImages(320), b = fixture.page.loadPhotoReaderImages(320); fixture.sameTask = a === b; fixture.task = a; }); await requested(pending);
        assert.equal(await page.evaluate(() => fixture.sameTask), true); await settle(page, pending); await page.evaluate(() => fixture.task);
        const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all"); await page.locator(".gallery-reader-open").click(); await requested(full);
        await page.evaluate(() => { fixture.first = document.querySelector(".gallery-reader-figure"); fixture.overlay = document.querySelector(".gallery-image-pager"); }); await page.evaluate(() => fixture.page.loadImageLibrary({ reload: true }));
        assert.equal(await page.evaluate(() => fixture.first === document.querySelector(".gallery-reader-figure") && fixture.overlay === document.querySelector(".gallery-image-pager")), true); await settle(page, full);
      } finally { await page.close(); }
    });
    await run("append retains in flight startup queue", async () => {
      const page = await newPage();
      try {
        const before = countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname));
        const first = hold(url => url.pathname === "/synthetic/A/1.svg"); await open(page, "A"); await requested(first);
        await page.evaluate(() => { fixture.first = document.querySelector(".gallery-reader-figure"); fixture.img = fixture.first.querySelector("img"); fixture.readerObserver = __readerObservers.at(-1); });
        const pending = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset")); await more(page); await requested(pending); await settle(page, pending);
        assert.equal(await page.evaluate(() => fixture.first === document.querySelector(".gallery-reader-figure") && fixture.img === fixture.first.querySelector("img") && fixture.first.dataset.galleryLoading === "1"), true);
        assert.equal(await page.evaluate(() => fixture.readerObserver === __readerObservers.at(-1) && !fixture.readerObserver.disconnected), true);
        assert.equal(countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname)) - before, 1, "pending startup image must retain the one-slot queue gate across append");
        first.release(); await page.waitForFunction(() => fixture.first.classList.contains("loaded"));
        await page.waitForFunction(() => document.querySelector('.gallery-reader-figure[data-image-index="2"]')?.classList.contains("loaded"));
      } finally { await page.close(); }
    });
    for (const ignoreAbort of [true, false]) for (const error of ["", "old route error"]) await run(`route boot B ${ignoreAbort ? "ignores abort" : "normal abort"} ${error ? "error" : "success"}`, async () => {
      const old = hold(url => url.pathname === "/api/photo-sets/A", error), current = hold(url => url.pathname === "/api/photo-sets/B");
      const page = await newPage({ real: true, route: "/photo/set/A", waitReady: false, ignoreAbort });
      try {
        await requested(old); await navigateRoute(page, "/photo/set/B");
        await requested(current, 1500);
        assert(await page.evaluate(() => __transport.aborted.some(url => url.startsWith("/api/photo-sets/A"))), "popstate intent must abort A before B settles");
        await settle(page, current); await readerTitle(page, "Album B");
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("app-module-loading")), false, "latest route must finish bootstrap while the obsolete transport is still held");
        assert.equal(new URL(page.url()).pathname, "/photo/set/B");
        await finishOld(page, old, ignoreAbort);
        assert.equal(await page.locator(".gallery-reader-title strong").textContent(), "Album B"); assert.equal(new URL(page.url()).pathname, "/photo/set/B");
        assert(!(await page.locator("#workGrid").textContent()).includes("old route error"));
        await page.locator(".gallery-reader-back").click();
        assert.equal(new URL(page.url()).pathname, "/photo/collections", "bootstrap must initialize routeReady for the current intent");
      } finally { await page.close(); }
    });
    for (const error of ["", "old route error"]) await run(`route initial deep link browser back ${error ? "error" : "success"}`, async () => {
      const old = hold(url => url.pathname === "/api/photo-sets/A", error);
      const page = await newPage({ real: true, route: "/photo/set/A", waitReady: false, initialBack: true });
      try {
        await requested(old); await page.goBack();
        await page.waitForFunction(() => __transport.aborted.some(url => url.startsWith("/api/photo-sets/A")), null, { timeout: 1500 });
        await page.locator(".gallery-card").first().waitFor({ state: "visible", timeout: 5000 });
        assert.equal(new URL(page.url()).pathname, "/photo/albums"); assert.equal(await page.locator(".gallery-reader-title").count(), 0);
        await settle(page, old); assert.equal(new URL(page.url()).pathname, "/photo/albums"); assert.equal(await page.locator(".gallery-reader-title").count(), 0);
        assert(!(await page.locator("#workGrid").textContent()).includes("old route error"));
        // A usable current history owner must also accept an ordinary card click.
        await clickAlbum(page, "B"); await readerTitle(page, "Album B"); assert.equal(new URL(page.url()).pathname, "/photo/set/B");
      } finally { await page.close(); }
    });
    for (const error of ["", "old route error"]) await run(`route old settles while latest boot pending ${error ? "error" : "success"}`, async () => {
      const old = hold(url => url.pathname === "/api/photo-sets/A", error), current = hold(url => url.pathname === "/api/photo-sets/B");
      const page = await newPage({ real: true, route: "/photo/set/A", waitReady: false });
      try {
        await requested(old); await navigateRoute(page, "/photo/set/B"); await requested(current, 1500); await settle(page, old);
        assert.equal(new URL(page.url()).pathname, "/photo/set/B"); assert.equal(await page.locator(".gallery-reader-title").count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("app-module-loading")), true, "old completion must not finish the pending latest boot");
        assert(!(await page.locator("#workGrid").textContent()).includes("old route error"));
        await settle(page, current); await readerTitle(page, "Album B");
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("app-module-loading")), false);
      } finally { await page.close(); }
    });
    for (const action of ["list", "search"]) await run(`route boot local ${action} intent`, async () => {
      const old = hold(url => url.pathname === "/api/photo-sets/A"), page = await newPage({ real: true, route: "/photo/set/A", waitReady: false });
      try {
        await requested(old); await page.locator(".gallery-controls").waitFor({ state: "attached" });
        // The initial loading stylesheet hides the body. Dispatch the actual
        // DOM handlers here without altering that stylesheet; the separate
        // post-boot case below exercises an ordinary visible pointer click.
        await page.evaluate(action => {
          if (action === "list") [...document.querySelectorAll(".gallery-submode-button")].find(button => button.textContent === "全部套图").click();
          else { const input = document.querySelector(".gallery-search"); input.value = "B"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
        }, action);
        await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 1500 });
        assert.equal(new URL(page.url()).pathname, "/photo/albums"); assert.equal(new URL(page.url()).searchParams.get("q"), action === "search" ? "B" : null);
        assert(await page.evaluate(() => __transport.aborted.some(url => url.startsWith("/api/photo-sets/A"))));
        await settle(page, old); assert.equal(await page.locator(".gallery-reader-title").count(), 0); assert.equal(new URL(page.url()).pathname, "/photo/albums");
      } finally { await page.close(); }
    });
    await run("route visible local list click", async () => {
      const page = await newPage({ real: true });
      try {
        const old = hold(url => url.pathname === "/api/photo-sets/A"); await navigateRoute(page, "/photo/set/A"); await requested(old);
        await page.getByRole("button", { name: "全部套图", exact: true }).click();
        assert.equal(new URL(page.url()).pathname, "/photo/albums"); await settle(page, old);
        assert.equal(await page.locator(".gallery-reader-title").count(), 0); assert.equal(new URL(page.url()).pathname, "/photo/albums");
      } finally { await page.close(); }
    });
    for (const target of ["/photo/set/B", "/manga"]) await run(`route module import late startup ${target}`, async () => {
      const module = hold(url => url.pathname === "/modules/content-index/gallery-page.js");
      const firstTarget = hold(url => ["/api/photo-sets/A", "/api/photo-sets/B", "/api/manga"].includes(url.pathname));
      const before = countRequests(url => url.pathname === "/api/photo-sets/A"), page = await newPage({ real: true, route: "/photo/set/A", waitReady: false });
      try {
        await requested(module); await navigateRoute(page, target); module.release();
        await requested(firstTarget);
        assert.equal(new URL(firstTarget.url, base).pathname, target === "/manga" ? "/api/manga" : "/api/photo-sets/B", "module await must select the latest route's first API request");
        firstTarget.release();
        if (target === "/manga") await page.locator(".manga-library").waitFor({ state: "visible", timeout: 5000 });
        else { await readerTitle(page, "Album B"); await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 }); }
        assert.equal(new URL(page.url()).pathname, target); assert.equal(countRequests(url => url.pathname === "/api/photo-sets/A"), before, "module await must read the latest startup URL before requesting the old target");
      } finally { await page.close(); }
    });
    for (const [initial, endpoint, target, title] of [
      ["/photo/set/A", "/api/photo-sets/A", "/media/W", "Media W"],
      ["/media/Movie", "/api/gallery-media/Movie", "/photo/set/B", "Album B"]
    ]) await run(`route gallery mode ${initial} to ${target}`, async () => {
      const old = hold(url => url.pathname === endpoint), page = await newPage({ real: true, route: initial, waitReady: false });
      try {
        await requested(old); await navigateRoute(page, target); await readerTitle(page, title);
        await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 });
        await settle(page, old); assert.equal(await page.locator(".gallery-reader-title strong").textContent(), title);
        assert.equal(new URL(page.url()).pathname, target, "late media must not redirect to player or restore the old gallery mode");
      } finally { await page.close(); }
    });
    for (const [initial, endpoint, target, selector] of [
      ["/photo/set/A", "/api/photo-sets/A", "/manga", ".manga-library"],
      ["/manga/C", "/api/manga/C", "/photo/set/B", ".gallery-reader-title"]
    ]) await run(`route module handoff ${initial} to ${target}`, async () => {
      const old = hold(url => url.pathname === endpoint), page = await newPage({ real: true, route: initial, waitReady: false });
      try {
        await requested(old); await navigateRoute(page, target);
        await page.locator(selector).waitFor({ state: "visible", timeout: 5000 });
        assert.equal(new URL(page.url()).pathname, target); await until(() => old.closed, "module handoff must unload/close the obsolete document's request"); old.release(); await tick(page);
        assert.equal(new URL(page.url()).pathname, target); assert.equal(await page.locator(selector).count(), 1);
        assert(!(await page.locator("#workGrid").textContent()).includes("old route error"));
      } finally { await page.close(); }
    });
    if (timings) await run("incremental render timing", async () => {
      const page = await newPage();
      try {
        await open(page, "A"); const results = [];
        for (const retained of [160, 800, 1600, 3200]) for (let sample = 0; sample < 3; sample++) {
          await page.evaluate(count => {
            const images = Array.from({ length: count }, (_, i) => ({ index: i + 1, name: `synthetic ${i + 1}`, url: `/synthetic/A/${i + 1}.svg` }));
            fixture.state.gallery.album = { ...fixture.state.gallery.album, images, imageCount: 10000 }; fixture.renderer.renderView();
          }, retained); await tick(page);
          const data = await page.evaluate(async () => {
            const viewer = document.querySelector(".gallery-reader-images"), first = viewer.firstElementChild, count = viewer.childElementCount, before = performance.now();
            const completion = new Promise(resolve => { const obs = new MutationObserver(() => { if (document.querySelector(".gallery-reader-images")?.childElementCount > count) { obs.disconnect(); resolve(); } }); obs.observe(document.querySelector("#workGrid"), { childList: true, subtree: true }); });
            document.querySelector(".gallery-more").click(); await completion;
            const current = document.querySelector(".gallery-reader-images");
            return { elapsedMs: +(performance.now() - before).toFixed(2), updateMs: +(performance.now() - (__transport.lastAlbumJsonAt || before)).toFixed(2), sameFirst: first === current.firstElementChild, figures: current.childElementCount };
          }); if (!legacy) assert.equal(data.sameFirst, true); assert.equal(data.figures, retained + 160); results.push({ retained, sample, ...data });
        }
        console.log(`incremental-render ${JSON.stringify(results)}`);
      } finally { await page.close(); }
    });
    assert.deepEqual(faults, [], "private browser must not hide page errors"); console.log(`Web gallery reader fixture passed (${checks} cases; private Chromium, synthetic responses)`); return { checks };
  } finally {
    for (const value of held) value.release(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  function countRequests(match) { return [...requests].filter(([url]) => match(new URL(url, base))).reduce((sum, [, count]) => sum + count, 0); }
  function hold(match, error = "") {
    let release, requestedResolve; const value = { match, error, used: false, closed: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve }; held.add(value); return value;
  }
  async function requested(gate, timeout = 5000) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("held request did not start")), timeout); })]); } finally { clearTimeout(timer); } }
  async function finishOld(page, gate, ignoreAbort) { if (ignoreAbort) await settle(page, gate); else { await until(() => gate.closed, "old aborted request must close"); gate.release(); await tick(page); } }
  async function settle(page, gate) {
    const before = await page.evaluate(url => __transport.settled.filter(item => item.url === url).length, gate.url); gate.release();
    await page.waitForFunction(({ url, before }) => __transport.settled.filter(item => item.url === url).length > before, { url: gate.url, before }); await tick(page);
  }
  async function newPage({ real = false, ignoreAbort = true, observer = true, route = "/photo?photoView=albums", waitReady = true, initialBack = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(({ ignoreAbort, observer, initialBack }) => {
      const originalFetch = window.fetch.bind(window); window.__transport = { settled: [], aborted: [], lastAlbumJsonAt: 0 };
      window.fetch = async (url, options = {}) => {
        const key = new URL(String(url), location.href), relative = `${key.pathname}${key.search}`;
        options.signal?.addEventListener("abort", () => __transport.aborted.push(relative), { once: true });
        // Bypass Chromium's cache-key lock so two deliberately uncancelled
        // requests for the same album/page can reach separate controlled gates.
        const response = await originalFetch(url, ignoreAbort ? { ...options, cache: "no-store", signal: undefined } : options), originalJson = response.json.bind(response);
        response.json = async () => { try { return await originalJson(); } finally { __transport.settled.push({ url: relative, ok: response.ok }); if (relative.startsWith("/api/photo-sets/")) __transport.lastAlbumJsonAt = performance.now(); } }; return response;
      };
      window.__readerObservers = [];
      if (observer) {
        const NativeObserver = window.IntersectionObserver;
        window.IntersectionObserver = class extends NativeObserver {
          constructor(callback, options) { super(callback, options); this.observed = new Set(); this.disconnected = false; if (options?.rootMargin === "900px 0px 1400px 0px") __readerObservers.push(this); }
          observe(node) { this.observed.add(node); super.observe(node); }
          disconnect() { this.disconnected = true; super.disconnect(); }
        };
      } else delete window.IntersectionObserver;
      if (initialBack && location.pathname === "/photo/set/A") {
        // Same-document history at bootstrap: a real goBack delivers popstate
        // while A is held, rather than unloading the entire reader document.
        const deepLink = `${location.pathname}${location.search}`;
        history.replaceState(null, "", "/photo/albums"); history.pushState(null, "", deepLink);
      }
    }, { ignoreAbort, observer, initialBack });
    await page.goto(real ? `${base}${route}` : `${base}/probe`, { waitUntil: waitReady ? "load" : "commit" });
    if (waitReady) { if (real) await page.locator(".gallery-card").first().waitFor(); else await page.waitForFunction(() => Boolean(window.fixture?.ready)); } return page;
  }
}
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function open(page, id) { await page.evaluate(value => fixture.page.openPhotoSet(value), id); }
async function more(page) { await page.evaluate(() => document.querySelector(".gallery-more").click()); }
async function clickAlbum(page, id) { await page.getByRole("button").filter({ hasText: `Album ${id}` }).click(); }
async function readerTitle(page, title) { await page.waitForFunction(text => document.querySelector(".gallery-reader-title strong")?.textContent === text, title, { timeout: 5000 }); }
async function navigateRoute(page, target) { await page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, target); }
function sendText(res, body, type, cache = "no-store") { res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); res.end(body); }
function sendJson(res, body, status = 200) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function listItem(id) { return { id, type: "photo", title: `Album ${id}`, category: "fixture", imageCount: 10000, coverUrl: `/synthetic/${id}/cover.svg` }; }
function album(id, offset, limit) { return { ...listItem(id), images: Array.from({ length: Math.min(limit, 10000 - offset) }, (_, i) => ({ index: offset + i + 1, name: `synthetic ${offset + i + 1}`, url: `/synthetic/${id}/${offset + i + 1}.svg` })) }; }
function manga(id) { return { id, title: `Comic ${id}`, chapters: [1, 2].map(index => ({ index, title: `Chapter ${index}` })) }; }
function harness() {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/modules/content-index/styles.css><style>body{margin:0;background:#1c2220;color:white}main{max-width:1050px;margin:auto}</style><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createGalleryPage} from '/modules/content-index/gallery-page.js';
import {createGalleryRenderer} from '/modules/content-index/gallery-renderer.js';
const state={activeView:'gallery',accessMode:'local',uiConfig:{},gallery:{mode:'photo',photoView:'albums',category:'all',subCategory:'all',person:'all',photoDate:'all',query:'',sort:'updated',mediaKind:'all',seriesKey:'',visibleLimit:80,fitWidth:true,album:null,comic:null,media:null,data:{totals:{photoSets:2,manga:1},facets:{}},status:''}};
const els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')};
const noop=()=>{},formatNumber=value=>new Intl.NumberFormat('zh-CN').format(value||0);
const api=async(url,options={})=>{const res=await fetch(url,options);const data=await res.json();if(!res.ok)throw new Error(data.error||'controlled error');return data;};
let page;const route=()=>history.replaceState(null,'',state.gallery.album?'/photo/'+state.gallery.album.id:'/photo?photoView=albums');
const shared={api,state,els,formatNumber,formatBytes:value=>String(value||0),formatDateTime:value=>String(value||''),cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,writeStoredFlag:noop,includesText:(text,q)=>String(text||'').includes(q),openAdminScript:noop};
const renderer=createGalleryRenderer({...shared,getGalleryPage:()=>page});
page=createGalleryPage({...shared,clearPersonSelection:noop,hidePersonProfile:noop,setMainHeader:noop,normalizeUiConfig:value=>value,galleryModeLabel:renderer.modeLabel,renderGalleryStats:renderer.renderStats,renderGalleryView:renderer.renderView,pushRoute:route,replaceRoute:route,syncRouteAfterNavigation:route});
state.gallery.list={key:page.imageLibraryListKey(),items:${JSON.stringify([listItem("A"), listItem("B")])},total:2,facets:{}};
window.fixture={state,page,renderer,ready:true};renderer.renderView();
</script>`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runGalleryReaderFixture();

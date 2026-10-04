import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Private loopback server, actual /manga index/host/module and Chromium.
// Synthetic APIs/SVGs only; simulated update/delete calls never reach an app.
// ignoreAbort proves ownership even when obsolete transport still completes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");

export async function runMangaReaderFixture({ legacyManga = false, legacyHost = false, sourceOverrides = {}, casePattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    .filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for the private manga browser fixture");
  const overrides = new Map(sourceOverrides instanceof Map ? sourceOverrides : Object.entries(sourceOverrides));
  for (const [enabled, relative] of [[legacyManga, "public/modules/photos/manga-page.js"], [legacyHost, "public/js/standalone-host.js"]]) {
    if (!enabled) continue;
    const result = spawnSync("git", ["show", `HEAD:${relative}`], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set(`/${relative.slice(7)}`, result.stdout);
  }
  const held = new Set(), requests = new Map(), faults = [], unexpected = [];
  let browser = null, checks = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    try {
      const syntheticMutation = (req.method === "POST" && /^\/api\/manga\/[CD]\/update$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/manga\/[CD]$/.test(url.pathname));
      assert(req.method === "GET" || syntheticMutation, `unexpected fixture mutation: ${req.method} ${key}`);
      const gate = [...held].find(value => !value.used && value.match(url, req));
      if (gate) {
        gate.used = true; gate.url = key; res.once("close", () => { gate.closed = true; });
        gate.requestedResolve(); await gate.promise;
        if (gate.error) { sendJson(res, { error: gate.error }, 503); return; }
      }
      if (url.pathname === "/probe") { sendText(res, harness(), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (syntheticMutation) {
        sendJson(res, req.method === "DELETE" ? { ok: true } : { job: { status: "complete", message: "Synthetic update complete" } }); return;
      }
      const chapterMatch = /^\/api\/manga\/([^/]+)\/chapters\/([^/]+)$/.exec(url.pathname);
      if (chapterMatch) { sendJson(res, { comic: comic(chapterMatch[1]), chapter: chapter(chapterMatch[1], Number(chapterMatch[2])) }); return; }
      const comicMatch = /^\/api\/manga\/([^/]+)$/.exec(url.pathname);
      if (comicMatch) { sendJson(res, { comic: comic(comicMatch[1]), update: { status: "idle" } }); return; }
      if (url.pathname === "/api/manga") { sendJson(res, { comics: [comic("C"), comic("D")] }); return; }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname.startsWith("/api/")) { unexpected.push(key); sendJson(res, { error: "unexpected synthetic API" }, 404); return; }
      if (url.pathname.startsWith("/synthetic/")) {
        sendText(res, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1400"><rect width="800" height="1400" fill="#729b7c"/></svg>', "image/svg+xml", "public, max-age=86400"); return;
      }
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), "text/javascript"); return; }
      const target = /^\/manga(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`), "static fixture paths must stay inside public");
      const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      sendText(res, await fs.promises.readFile(target), type);
    } catch (error) { unexpected.push(`${key}: ${error.message}`); if (!res.destroyed) sendJson(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    for (const ignoreAbort of [true, false]) {
      const transport = ignoreAbort ? "ignore-abort" : "normal";
      for (const error of ["", "old manga error"]) {
        const result = error ? "error" : "success";
        for (const navigation of ["detail", "list", "back"]) await run(`host initial C held to ${navigation} ${result} ${transport}`, async () => {
          const old = hold(url => url.pathname === "/api/manga/C", error);
          const endpoint = navigation === "detail" ? "/api/manga/D" : "/api/manga";
          const next = hold(url => url.pathname === endpoint);
          const page = await newPage({ real: true, ignoreAbort, route: "/manga/C", waitReady: false, initialBack: navigation === "back" });
          try {
            await requested(old); const token = await page.evaluate(() => __documentToken);
            if (navigation === "back") await page.goBack({ waitUntil: "commit" });
            else await navigateRoute(page, navigation === "detail" ? "/manga/D" : "/manga");
            await requested(next, 2000); // New history intent must start before old C is released.
            await settle(page, next); await ready(page);
            if (navigation === "detail") await detailTitle(page, "Comic D"); else await page.locator(".manga-card").first().waitFor();
            assert.equal(await page.evaluate(() => __documentToken), token, "history must stay in the initial document");
            await finishOld(page, old, ignoreAbort);
            assert.equal(new URL(page.url()).pathname, navigation === "detail" ? "/manga/D" : "/manga");
            assert.equal(await page.locator(navigation === "detail" ? ".manga-detail" : ".manga-library").count(), 1);
            if (navigation === "detail") assert.equal(await page.locator(".manga-detail h1").textContent(), "Comic D", "old C must not replace the latest detail");
            assert(!(await page.locator("#workGrid").textContent()).includes("old manga error"));
            assert(await page.evaluate(() => __transport.aborted.includes("/api/manga/C")), "new route must abort old C even with ignored AbortSignal");
          } finally { await page.close(); }
        });

        await run(`rapid comic owner and finally ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/manga/C", error); await launch(page, { mangaComicId: "C" }); await requested(old);
            const current = hold(url => url.pathname === "/api/manga/D"); await launch(page, { mangaComicId: "D" }); await requested(current);
            await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await stateSnapshot(page), { comic: null, chapter: null, loading: true, status: "正在读取作品资料和目录" }, "old error/finally must not clear D loading owner");
            await settle(page, current); await detailTitle(page, "Comic D");
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: null, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`rapid chapter owner and finally ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "C" });
            const old = hold(url => url.pathname === "/api/manga/C/chapters/1", error); await clickChapter(page, 1); await requested(old);
            const current = hold(url => url.pathname === "/api/manga/C/chapters/2"); await clickChapter(page, 2); await requested(current);
            await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await stateSnapshot(page), { comic: "C", chapter: null, loading: true, status: "正在读取章节" }, "old chapter error/finally must not clear chapter 2 owner");
            assert.equal(await progress(page, "C"), null, "superseded chapter must not persist progress");
            await settle(page, current); await readerTitle(page, "Comic C", "Chapter 2"); assert.equal(await progress(page, "C"), 2);
          } finally { await page.close(); }
        });

        await run(`cross comic old chapter ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "C" });
            const old = hold(url => url.pathname === "/api/manga/C/chapters/1", error); await clickChapter(page, 1); await requested(old);
            await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
            const before = await rememberReader(page); await finishOld(page, old, ignoreAbort); await assertReaderPreserved(page, before);
            assert.equal(await progress(page, "C"), null); assert.equal(await progress(page, "D"), 2);
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`host reader return directory late chapter ${result} ${transport}`, async () => {
          const page = await newPage({ real: true, ignoreAbort, route: "/manga/C/read/1" });
          try {
            const old = hold(url => url.pathname === "/api/manga/C/chapters/2", error);
            await page.locator('.manga-reader-bar [data-action="next"]').evaluate(button => button.click()); await requested(old);
            await page.locator('.manga-reader-bar [data-action="detail"]').evaluate(button => button.click()); await detailTitle(page, "Comic C");
            assert.equal(new URL(page.url()).pathname, "/manga/C"); await finishOld(page, old, ignoreAbort);
            assert.equal(await page.locator(".manga-reader").count(), 0); assert.equal(new URL(page.url()).pathname, "/manga/C");
            assert.equal(await progress(page, "C"), 1, "returning to directory must not save the superseded chapter");
          } finally { await page.close(); }
        });

        await run(`background library preserves reader ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/manga", error);
            await page.evaluate(() => { fixture.state.manga.data = null; fixture.page.enter({ skipRoute: true }); }); await requested(old);
            await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
            const before = await rememberReader(page); await finishOld(page, old, ignoreAbort); await assertReaderPreserved(page, before);
            assert.equal(await progress(page, "D"), 2);
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });
      }

      await run(`late comic must not chain chapter ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const old = hold(url => url.pathname === "/api/manga/C"); const before = countRequests(url => url.pathname === "/api/manga/C/chapters/1");
          await launch(page, { mangaComicId: "C", mangaChapterIndex: "1" }); await requested(old);
          await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
          await finishOld(page, old, ignoreAbort);
          assert.equal(countRequests(url => url.pathname === "/api/manga/C/chapters/1"), before, "superseded comic success must not launch its old chapter continuation");
          assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" }); assert.equal(await progress(page, "C"), null);
        } finally { await page.close(); }
      });

      await run(`host chapter popstate retains newest ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/manga/C/read/1" });
        try {
          const old = hold(url => url.pathname === "/api/manga/C/chapters/1", "old manga error");
          await navigateRoute(page, "/manga/C/read/1"); await requested(old);
          const current = hold(url => url.pathname === "/api/manga/C/chapters/2"); await navigateRoute(page, "/manga/C/read/2"); await requested(current, 2000);
          await finishOld(page, old, ignoreAbort); await settle(page, current); await readerTitle(page, "Comic C", "Chapter 2");
          assert.equal(new URL(page.url()).pathname, "/manga/C/read/2"); assert.equal(await progress(page, "C"), 2);
          await page.goBack({ waitUntil: "commit" }); await readerTitle(page, "Comic C", "Chapter 1"); assert.equal(new URL(page.url()).pathname, "/manga/C/read/1");
        } finally { await page.close(); }
      });

      for (const error of ["", "old background error"]) {
        const result = error ? "error" : "success";
        await run(`reader catalog background refresh ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
            const background = hold(url => url.pathname === "/api/manga", error);
            await page.evaluate(() => { fixture.state.manga.data = null; fixture.page.enter({ skipRoute: true }); }); await requested(background);
            const before = await rememberReader(page); await settle(page, background); await assertReaderPreserved(page, before);
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`update completion preserves mounted reader ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "C" });
            const update = hold((url, req) => req.method === "POST" && url.pathname === "/api/manga/C/update", error);
            await page.locator('[data-action="update"]').evaluate(button => button.click()); await requested(update);
            await openTarget(page, { mangaComicId: "C", mangaChapterIndex: "2" }); await readerTitle(page, "Comic C", "Chapter 2");
            const detail = error ? null : hold((url, req) => req.method === "GET" && url.pathname === "/api/manga/C");
            const library = error ? null : hold(url => url.pathname === "/api/manga");
            const before = await rememberReader(page); await settle(page, update);
            if (!error) { await requested(detail); await requested(library); await settle(page, detail); await settle(page, library); }
            await assertReaderPreserved(page, before); assert.deepEqual(await stateSnapshot(page), { comic: "C", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`late delete C preserves D reader ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "C" });
            const deletion = hold((url, req) => req.method === "DELETE" && url.pathname === "/api/manga/C", error);
            await page.locator('[data-action="delete"]').evaluate(button => button.click()); await requested(deletion);
            await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
            const before = await rememberReader(page); await settle(page, deletion); await assertReaderPreserved(page, before);
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" });
            assert.equal(await page.evaluate(() => fixture.state.manga.deletingComicId), "");
            if (!error) assert.equal(await page.evaluate(() => fixture.state.manga.data.comics.some(comic => comic.id === "C")), false, "simulated deletion must still remove C from cached library");
          } finally { await page.close(); }
        });
      }

      await run(`delete filters held current library without losing D ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/manga/C" });
        try {
          const deletion = hold((url, req) => req.method === "DELETE" && url.pathname === "/api/manga/C");
          await page.locator('[data-action="delete"]').evaluate(button => button.click()); await requested(deletion);
          const library = hold(url => url.pathname === "/api/manga"); await navigateRoute(page, "/manga"); await requested(library);
          await settle(page, deletion); await settle(page, library); await page.locator(".manga-card").first().waitFor();
          assert.equal(new URL(page.url()).pathname, "/manga");
          assert.deepEqual(await page.locator(".manga-card-body strong").allTextContents(), ["Comic D"], "current C+D list response must retain D while filtering the completed C deletion");
          assert.equal(await page.locator(".manga-status").count(), 0, "current library finally must release its loading status");
          assert.equal(await page.locator(".manga-detail").count(), 0);
        } finally { await page.close(); }
      });
    }
    assert(checks > 0, `no manga fixture cases matched: ${casePattern}`);
    assert.deepEqual(faults, [], "private Chromium must not hide page errors");
    assert.deepEqual(unexpected, [], "private fixture must not access unmodelled APIs or files");
    console.log(`Manga reader fixture passed (${checks} cases; private Chromium, actual manga host and synthetic responses)`);
    return { checks };
  } finally {
    for (const gate of held) gate.release();
    if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }

  function countRequests(match) { return [...requests].filter(([url]) => match(new URL(url, base))).reduce((sum, [, count]) => sum + count, 0); }
  function hold(match, error = "") {
    let release, requestedResolve;
    const gate = { match, error, used: false, closed: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve };
    held.add(gate); return gate;
  }
  async function requested(gate, timeout = 5000) {
    let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`new request did not start before obsolete I/O finished (${timeout}ms)`)), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async function settle(page, gate) {
    const before = await page.evaluate(url => __transport.settled.filter(item => item.url === url).length, gate.url); gate.release();
    await page.waitForFunction(({ url, before }) => __transport.settled.filter(item => item.url === url).length > before, { url: gate.url, before }, { timeout: 5000 }); await tick(page);
  }
  async function finishOld(page, gate, ignoreAbort) {
    if (ignoreAbort) await settle(page, gate);
    else { await until(() => gate.closed, "obsolete aborted request must close in the normal transport"); gate.release(); await tick(page); }
  }
  async function newPage({ real = false, ignoreAbort = true, route = "/manga", waitReady = true, initialBack = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    page.on("dialog", dialog => dialog.accept()); // Only synthetic delete endpoints exist in this fixture.
    await page.addInitScript(({ ignoreAbort, initialBack }) => {
      window.__documentToken = Math.random(); window.__transport = { settled: [], aborted: [] };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const key = new URL(String(url), location.href), relative = `${key.pathname}${key.search}`;
        options.signal?.addEventListener("abort", () => __transport.aborted.push(relative), { once: true });
        // no-store removes Chromium cache-key serialization for same-chapter races.
        const response = await originalFetch(url, ignoreAbort ? { ...options, cache: "no-store", signal: undefined } : options), originalJson = response.json.bind(response);
        response.json = async () => { try { return await originalJson(); } finally { __transport.settled.push({ url: relative, ok: response.ok }); } }; return response;
      };
      if (initialBack && location.pathname === "/manga/C") {
        const deepLink = `${location.pathname}${location.search}`; history.replaceState(null, "", "/manga"); history.pushState(null, "", deepLink);
      }
    }, { ignoreAbort, initialBack });
    await page.goto(real ? `${base}${route}` : `${base}/probe`, { waitUntil: waitReady ? "load" : "commit" });
    if (waitReady) { if (real) await ready(page); else await page.waitForFunction(() => Boolean(window.fixture?.ready)); }
    return page;
  }
}

async function ready(page) { await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 }); }
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function navigateRoute(page, target) { await page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, target); }
async function launch(page, route) { await page.evaluate(value => { fixture.pending.push(fixture.page.openRouteTarget(value)); }, route); }
async function openTarget(page, route) { await page.evaluate(value => fixture.page.openRouteTarget(value), route); }
async function clickChapter(page, index) { await page.locator(".manga-chapter-row button").nth(index - 1).evaluate(button => button.click()); }
async function detailTitle(page, title) { await page.waitForFunction(value => document.querySelector(".manga-detail h1")?.textContent === value, title, { timeout: 5000 }); }
async function readerTitle(page, title, chapterTitle) { await page.waitForFunction(([title, chapter]) => document.querySelector(".manga-reader-identity strong")?.textContent === title && document.querySelector(".manga-reader-identity span")?.textContent === chapter, [title, chapterTitle], { timeout: 5000 }); }
async function stateSnapshot(page) { return page.evaluate(() => ({ comic: fixture.state.manga.comic?.id ?? null, chapter: fixture.state.manga.chapter?.index ?? null, loading: fixture.state.manga.loading, status: fixture.state.manga.status })); }
async function progress(page, id) { return page.evaluate(id => JSON.parse(localStorage.getItem("fanhao.manga.progress") || "{}")[id] ?? null, id); }
async function rememberReader(page) {
  await page.waitForFunction(() => [...document.querySelectorAll(".manga-reader-pages img")].slice(0, 2).every(image => image.complete && image.naturalWidth > 0));
  await page.evaluate(() => { fixture.reader = document.querySelector(".manga-reader"); fixture.firstImage = fixture.reader.querySelector("img"); window.scrollTo(0, 420); }); await tick(page);
  const before = await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}`, progress: localStorage.getItem("fanhao.manga.progress") }));
  assert(before.scroll > 0, "reader preservation must measure actual nonzero document scroll"); return before;
}
async function assertReaderPreserved(page, before) {
  assert.equal(await page.evaluate(() => fixture.reader === document.querySelector(".manga-reader") && fixture.firstImage === document.querySelector(".manga-reader-pages img")), true, "obsolete read must preserve the mounted reader and images");
  assert.deepEqual(await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}`, progress: localStorage.getItem("fanhao.manga.progress") })), before, "obsolete read must not rewrite scroll, route or progress");
}
function sendText(res, body, type, cache = "no-store") { if (res.destroyed) return; res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); res.end(body); }
function sendJson(res, body, status = 200) { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function comic(id) {
  return { id, title: `Comic ${id}`, site: "fixture", author: "Synthetic", sourceUrl: `https://example.invalid/${id}`, coverUrl: `/synthetic/${id}/cover.svg`, chapterCount: 2, doneChapterCount: 2, imageCount: 6, downloadedCount: 6, failedCount: 0, updatedAt: "2026-01-01T00:00:00Z",
    chapters: [1, 2].map(index => ({ index, title: `Chapter ${index}`, status: "done", imageCount: 3, downloadedCount: 3 })) };
}
function chapter(id, index) { return { index, title: `Chapter ${index}`, images: [1, 2, 3].map(page => ({ url: `/synthetic/${id}/${index}/${page}.svg` })) }; }
function harness() {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/modules/photos/manga.css><style>body{margin:0;background:#1c2220;color:white}main{max-width:1050px;margin:auto}</style><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createMangaPage} from '/modules/photos/manga-page.js';
const state={activeView:'manga',manga:{data:{comics:${JSON.stringify([comic("C"), comic("D")])}},comic:null,chapter:null,loading:false,status:''}};
const els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')},noop=()=>{};
const api=async(url,options={})=>{const res=await fetch(url,options),data=await res.json();if(!res.ok)throw new Error(data.error||'controlled error');return data;};
const route=(overrides={})=>{const id=overrides.mangaComicId??state.manga.comic?.id??'',chapter=overrides.mangaChapterIndex??state.manga.chapter?.index??'';history.replaceState(null,'',id?'/manga/'+id+(chapter?'/read/'+chapter:''):'/manga');};
const page=createMangaPage({api,state,els,formatNumber:value=>new Intl.NumberFormat('zh-CN').format(value||0),formatDateTime:value=>String(value||''),cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,hidePersonProfile:noop,setMainHeader:noop,writeStoredFlag:noop,pushRoute:route,syncRouteAfterNavigation:options=>{if(!options?.skipRoute)route(options?.routeOverrides)}});
window.fixture={state,page,pending:[],ready:true};page.enter({skipRoute:true,deferInitialLoad:true});
</script>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMangaReaderFixture({ legacyManga: process.argv.includes("--legacy-manga"), legacyHost: process.argv.includes("--legacy-host"), casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || "" });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright-core";

// Actual index/app/registry/photos adapter, full owners, DOM/CSS/IDB and image
// loader. Only private synthetic JSON/SVG and observational counters are used.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(project, "android-client/www"), before = "24416052";
const hashes = { "/app.js": "104f717519f93ea9afb0446ac599ce2961194a0d607c9c59e32b4894e4be2f74",
  "/platform/content-index/channel-views.js": "881f96377121cee4b336d2f73af8f7767ace7e64b0abbd711b88bfee15611490",
  "/js/auto-load.js": "2c7aa82b3360287e2e78521060d1343ff2c6003d64c9a427ad7bcabfd56f5c32" };
const frozen = {}, candidate = {};
for (const [url, hash] of Object.entries(hashes)) {
  frozen[url] = execFileSync("git", ["show", `${before}:android-client/www${url}`], { cwd: project, encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(frozen[url]).digest("hex"), hash, `fixed complete ${url}`);
  candidate[url] = fs.readFileSync(path.join(www, url), "utf8").replaceAll("\r\n", "\n");
}
assert.ok(process.argv.slice(2).every(value => ["--legacy-dom-reuse", "--legacy-auto-retry"].includes(value) || value.startsWith("--case=")));
const negative = process.argv.includes("--legacy-dom-reuse"), pattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
if (negative) {
  const marker = "  function appendMountedMangaDetail(owner, comic, signature, visible) {";
  assert.equal(candidate["/platform/content-index/channel-views.js"].split(marker).length, 2);
  candidate["/platform/content-index/channel-views.js"] = candidate["/platform/content-index/channel-views.js"].replace(marker, `${marker}\n    return false; // Only disable equivalent-snapshot DOM reuse.`);
}
if (process.argv.includes("--legacy-auto-retry")) {
  const marker = "    if (options.canAutoLoad?.() === false) return;";
  assert.equal(candidate["/js/auto-load.js"].split(marker).length, 2);
  candidate["/js/auto-load.js"] = candidate["/js/auto-load.js"].replace(marker, "");
}
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert.ok(executablePath, "installed Chrome or Edge required");
const failures = [], surfaces = []; let browser, sequence = 0, comparisons = 0, groups = 0;
function comic(count = 1000, id = "comic-a") {
  return { id, title: `合成漫画 ${id}`, site: "synthetic", category: "合成", chapterCount: count, doneChapterCount: count, imageCount: count * 12,
    description: "合成长简介。".repeat(30), updatedAt: "2026-11-05", coverUrl: "/synthetic/cover.svg",
    chapters: Array.from({ length: count }, (_, i) => ({ index: i + 1, title: `合成章节 ${String(i + 1).padStart(5, "0")}`,
      imageCount: 12, downloadedCount: i % 7 ? 12 : 0, status: i % 7 ? "complete" : "pending", coverUrl: `/synthetic/${i}.svg` })) };
}
function startup() {
  localStorage.setItem("fanhao.serverUrl", location.origin);
  localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "mangaDetail", params: { id: "comic-a" } }));
  const records = {};
  for (let i = 0; i < 60; i++) records[i ? `synthetic-${i}` : "comic-a"] = { chapterIndex: 1 + i, chapterTitle: `合成进度 ${i}`, pageIndex: 7, pageTotal: 12, updatedAt: "2026-11-05" };
  localStorage.setItem("fanhao.android.mangaReadingProgress.v1", JSON.stringify(records));
  window.__mangaAudit = { realm: `${Date.now()}:${Math.random()}`, cards: 0, elements: 0, rows: new WeakMap(), host: null, effects: [], comic: null, readers: [] };
  const create = document.createElement;
  document.createElement = function (...args) { __mangaAudit.elements++; return create.apply(this, args); };
  const fetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => fetch(input, __mangaAudit.ignoreAbort ? { ...options, signal: undefined } : options);
}
function instrument(source, url) {
  if (url === "/app.js") {
    const marker = "function createAndroidModuleHost() {\n  return Object.freeze({";
    assert.equal(source.split(marker).length, 2);
    return source.replace(marker, "function createAndroidModuleHost() {\n  window.__mangaAudit.updateServer = updateServer;\n  return window.__mangaAudit.host = Object.freeze({");
  }
  const create = /  function createMangaChapterButton\(comic, chapter = \{\}(?:, owner = null)?\) \{/g;
  assert.equal([...source.matchAll(create)].length, 1);
  source = source.replace(create, value => `${value}\n    window.__mangaAudit.cards++;`);
  const card = '    card.className = "manga-chapter-card";'; assert.equal(source.split(card).length, 2);
  source = source.replace(card, `${card}\n    window.__mangaAudit.rows.set(card, chapter);`);
  const render = /  function renderMangaComic\(comic = \{\}, cacheEntry = null, update = null(?:, owner = mountedMangaDetail)?\) \{/g;
  assert.equal([...source.matchAll(render)].length, 1);
  source = source.replace(render, value => `${value}\n    window.__mangaAudit.comic = comic;`);
  for (const name of ["recordMangaRecent", "rememberMangaUpdateJob"]) {
    const marker = name === "recordMangaRecent" ? "  function recordMangaRecent(comic = {}) {" : "  function rememberMangaUpdateJob(job = {}) {";
    assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, `${marker}\n    window.__mangaAudit.effects.push(${JSON.stringify(name)});`);
  }
  return source;
}
async function surface(sources, wan = false) {
  const cases = new Map(), held = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), f = cases.get(req.headers["x-fixture-case"]);
    const send = (body, type = "application/json", status = 200) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } };
    try {
      const p = url.pathname.replace(/^\/source-two/, "");
      if (p.startsWith("/api/")) {
        assert.ok(f); assert.equal(req.method, "GET", "stale controls cannot dispatch a mutation through the synthetic API");
        const record = { path: p, query: Object.fromEntries(url.searchParams), chapters: 0 }; f.requests.push(record); let payload = {};
        if (/^\/api\/manga\/comic-[ab]$/.test(p)) {
          const value = p.endsWith("comic-b") ? f.other : f.comic;
          payload = { comic: value, update: f.update }; record.chapters = value.chapters.length;
        } else if (/^\/api\/manga\/comic-[ab]\/chapters\/\d+$/.test(p)) {
          const index = Number(p.split("/").at(-1)); payload = { comic: f.comic, chapter: { ...f.comic.chapters[index - 1], images: [{ index: 1, name: "合成页", url: "/synthetic/page.svg" }], navigation: { position: index, total: f.comic.chapters.length } } };
        } else if (p === "/api/library") payload = { people: [], works: [], totals: { people: 0, works: 0, videos: 0, infoFiles: 0 }, user: { favorites: [], historyCount: 0 }, availableRoots: [], access: { mode: "loopback" } };
        else if (p === "/api/modules") payload = { modules: [] };
        else if (p === "/api/accounts/status") payload = { user: f.accountId ? { id: f.accountId, username: "Synthetic" } : null, accountLoginRequired: false, registrationEnabled: true };
        else if (p === "/api/auth/status") payload = { authenticated: Boolean(f.accountId), user: f.accountId ? { id: f.accountId, username: "Synthetic" } : null };
        else if (p === "/api/history") payload = { works: [], total: 0 };
        else if (p === "/api/favorites/folders") payload = { folders: [] };
        else if (p === "/api/system/control") payload = { ok: true, platform: "unsupported", actions: [] };
        else if (p === "/api/android/update") payload = { available: false, versionCode: 0 };
        else if (p.endsWith("/summary")) payload = { totals: {}, items: [], channels: [] };
        else failures.push(`unexpected API ${p}`);
        const body = JSON.stringify(payload); if (record.chapters) record.bytes = Buffer.byteLength(body);
        const gate = f.holds.find(gate => !gate.used && gate.match(url));
        if (gate) { gate.used = true; held.add(gate); gate.requested(); await gate.promise; held.delete(gate); if (gate.error) return send(JSON.stringify({ error: gate.error }), "application/json", 503); }
        if (f.offline && record.chapters) return send(JSON.stringify({ error: "合成持续离线" }), "application/json", 503);
        return send(body);
      }
      if (p.startsWith("/synthetic/")) return send('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="340"><rect width="240" height="340" fill="#759477"/></svg>', "image/svg+xml");
      if (p === "/favicon.ico") return send("", "image/x-icon", 204);
      const relative = url.pathname === "/" ? "/index.html" : url.pathname, target = path.resolve(www, `.${relative}`); assert.ok(target.startsWith(`${www}${path.sep}`));
      let body = sources[relative] || fs.readFileSync(target);
      if (relative === "/app.js" || relative === "/platform/content-index/channel-views.js") body = instrument(body.toString().replaceAll("\r\n", "\n"), relative);
      if (relative === "/index.html") body = body.toString().replace("<head>", `<head><script>(${startup.toString()})()</script>`);
      send(body, relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : relative.endsWith(".html") ? "text/html" : "application/octet-stream");
    } catch (error) { failures.push(`${url.pathname}: ${error.message}`); send(error.message, "text/plain", 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const host = wan ? "manga-fixture.test" : "127.0.0.1", base = `http://${host}:${server.address().port}`;
  const result = { base, wan, async open(count = 1000) {
    const id = `case-${++sequence}`, f = { id, comic: comic(count), other: comic(count, "comic-b"), update: { status: "idle" }, requests: [], holds: [] };
    cases.set(id, f); f.context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, extraHTTPHeaders: { "X-Fixture-Case": id } });
    f.page = await f.context.newPage(); f.page.on("pageerror", error => failures.push(error.message));
    await f.page.route(new RegExp(`^https?://(?!${host.replaceAll(".", "\\.")}:${server.address().port}(?:/|$))`), route => route.abort());
    await f.page.goto(base, { waitUntil: "networkidle" }); await ready(f.page, Math.min(count, wan ? 32 : 120)); return f;
  }, async close() { for (const gate of held) gate.release(); await new Promise(resolve => server.close(resolve)); } };
  surfaces.push(result); return result;
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function ready(page, count, cached = false) {
  await page.waitForFunction(({ count, cached }) => document.querySelectorAll("#viewContent .manga-chapter-card").length === count
    && !document.querySelector("#viewContent .channel-more:disabled") && (cached || !document.querySelector("#viewMeta").textContent.includes("缓存")), { count, cached }, { timeout: 30000 });
  await frames(page);
  await page.waitForFunction(() => { const cover = document.querySelector("#viewContent .manga-detail-cover"); return !cover
    || cover.tagName === "IMG" && cover.complete && cover.naturalWidth > 0; }, null, { timeout: 10000 });
}
async function snapshot(page) {
  return page.evaluate(() => ({
    view: __mangaAudit.host.navigation.currentView(), params: __mangaAudit.host.navigation.currentParams(), comic: __mangaAudit.comic,
    title: document.querySelector("#viewTitle").textContent, meta: document.querySelector("#viewMeta").textContent,
    cards: [...document.querySelectorAll("#viewContent .manga-chapter-card")].map(card => ({ chapter: __mangaAudit.rows.get(card), text: card.textContent,
      disabled: card.querySelector("button").disabled, download: card.querySelector("a") ? new URL(card.querySelector("a").href).pathname : "" })),
    summary: {
      text: document.querySelector("#viewContent .manga-detail-summary")?.textContent || "",
      controls: [...document.querySelectorAll("#viewContent .manga-detail-summary button, #viewContent .manga-detail-summary a")].map(node => ({
        text: node.textContent, disabled: Boolean(node.disabled), aria: node.getAttribute("aria-label"), expanded: node.getAttribute("aria-expanded"),
        href: node.tagName === "A" ? new URL(node.href).pathname + new URL(node.href).search : ""
      }))
    },
    more: document.querySelector("#viewContent .channel-more")?.textContent || "", effects: __mangaAudit.effects
  }));
}
function compare(actual, expected, label) {
  const same = isDeepStrictEqual(actual, expected);
  assert.ok(same, label); comparisons++;
}
const details = f => f.requests.filter(request => request.chapters);
async function more(f, count) { await f.page.evaluate(() => document.querySelector("#viewContent .channel-more").click()); await ready(f.page, count); }
function hold(f, match, error = "") { let release, requested; const gate = { match, error, used: false, promise: new Promise(resolve => { release = resolve; }), request: new Promise(resolve => { requested = resolve; }) }; gate.release = release; gate.requested = requested; f.holds.push(gate); return gate; }
async function navigate(f, view, params = {}) { await f.page.evaluate(({ view, params }) => __mangaAudit.host.navigation.showView(view, params), { view, params }); }
async function scale(oldSurface, nextSurface, count, pages) {
  const old = await oldSurface.open(count), next = await nextSurface.open(count);
  try {
    const first = oldSurface.wan ? 32 : 120, step = oldSurface.wan ? 24 : 720;
    for (let index = 0; index < pages; index++) {
      const visible = Math.min(count, first + index * step);
      if (index) { await more(old, visible); await more(next, visible); }
      compare(await snapshot(next.page), await snapshot(old.page), `${oldSurface.wan ? "WAN" : "LAN"} complete comic/cards/effects page ${index + 1}`);
    }
    compare(details(next), details(old), "GET order, complete response chapters and bytes stay unchanged");
    const read = async f => f.page.evaluate(() => ({ cards: __mangaAudit.cards, elements: __mangaAudit.elements }));
    const oldStats = await read(old), nextStats = await read(next);
    console.log(`Manga detail ${count}/${pages} ${oldSurface.wan ? "WAN" : "LAN"}: cards ${oldStats.cards} -> ${nextStats.cards}; elements ${oldStats.elements} -> ${nextStats.elements}; GET ${details(next).length}`);
    return { actual: nextStats.cards, expected: Math.min(count, first + (pages - 1) * step) };
  } finally { await old.context.close(); await next.context.close(); }
}
async function changedSnapshots(oldSurface, nextSurface) {
  for (const [name, change] of [
    ["comic title", f => { f.comic.title += " 已更新"; }],
    ["chapter title and availability", f => { f.comic.chapters[0].title = "最新章节标题"; f.comic.chapters[0].imageCount = 0; f.comic.chapters[0].downloadedCount = 0; }],
    ["chapter order", f => { [f.comic.chapters[0], f.comic.chapters[1]] = [f.comic.chapters[1], f.comic.chapters[0]]; }],
    ["duplicate chapter indexes", f => { f.comic.chapters[1].index = f.comic.chapters[0].index; }],
    ["job payload", f => { f.update = { id: "synthetic-job", comicId: "comic-a", kind: "update", status: "failed", message: "合成更新失败", totalChapters: 1000, completedChapters: 12 }; }],
    ["reading progress", async f => { await f.page.evaluate(() => { const key = "fanhao.android.mangaReadingProgress.v1", records = JSON.parse(localStorage.getItem(key)); records["comic-a"].chapterIndex = 2; records["comic-a"].pageIndex = 9; localStorage.setItem(key, JSON.stringify(records)); }); }],
    ["empty catalog", f => { f.comic.chapters = []; f.comic.chapterCount = 0; f.comic.imageCount = 0; }]
  ]) {
    const old = await oldSurface.open(), next = await nextSurface.open();
    try {
      for (const f of [old, next]) { await change(f); await more(f, name === "empty catalog" ? 0 : 840); }
      compare(await snapshot(next.page), await snapshot(old.page), `${name} keeps the original complete reset output`);
    } finally { await old.context.close(); await next.context.close(); }
  }
}
async function nativeSurface(surface) {
  const f = await surface.open(200);
  try {
    await f.page.locator("img.manga-detail-cover").evaluate(image => image.decode());
    await f.page.locator(".manga-detail-description-toggle").click();
    await f.page.evaluate(() => {
      __mangaAudit.first = document.querySelector(".manga-chapter-card"); __mangaAudit.summary = document.querySelector(".manga-detail-summary");
      __mangaAudit.cover = document.querySelector("img.manga-detail-cover"); __mangaAudit.more = document.querySelector(".channel-more");
      window.scrollTo({ top: 500, behavior: "instant" }); document.querySelector(".channel-more").focus({ preventScroll: true });
    }); await frames(f.page);
    const y = await f.page.evaluate(() => scrollY);
    await f.page.keyboard.press("Enter"); await ready(f.page, 200);
    const state = await f.page.evaluate(() => ({
      first: __mangaAudit.first === document.querySelector(".manga-chapter-card"), summary: __mangaAudit.summary === document.querySelector(".manga-detail-summary"),
      cover: __mangaAudit.cover === document.querySelector("img.manga-detail-cover"), expanded: document.querySelector(".manga-detail-description-toggle").getAttribute("aria-expanded"),
      focus: document.activeElement === document.querySelector(".manga-chapter-card:last-child button"), y: scrollY,
      decoded: document.querySelector("img.manga-detail-cover")?.naturalWidth
    }));
    assert.equal(state.first, !negative); assert.equal(state.summary, !negative); assert.equal(state.cover, !negative);
    assert.equal(state.expanded, negative ? "false" : "true"); assert.equal(state.focus, true, "EOF focuses the final available chapter");
    assert.ok(Math.abs(state.y - y) <= 1); assert.ok(state.decoded > 0, "the actual loader decoded the synthetic cover");
  } finally { await f.context.close(); }
}
async function cacheAndRetry(surface) {
  const f = await surface.open();
  try {
    const gate = hold(f, url => url.pathname === "/api/manga/comic-a", "合成离线");
    await f.page.evaluate(() => document.querySelector(".channel-more").focus()); await f.page.keyboard.press(" "); await gate.request;
    await f.page.waitForFunction(() => document.querySelectorAll("#viewContent .manga-chapter-card").length === 840);
    assert.equal(await f.page.locator("#viewContent .channel-more").isDisabled(), true, "cached reveal keeps the fresh request pending fence");
    gate.release(); await ready(f.page, 840, true);
    assert.match(await f.page.locator(".manga-cache-notice").textContent(), /当前书籍资料和目录来自手机缓存/);
    assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector(".channel-more")), true);
    await more(f, 1000); assert.equal(await f.page.locator(".manga-cache-notice").count(), 0, "a new successful reveal removes an obsolete offline notice");
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
  const fresh = await surface.open();
  try {
    await fresh.page.evaluate(async () => { const { clearCachedJsonByPrefix } = await import("/js/cache.js"); await clearCachedJsonByPrefix(location.origin, "/api/manga/comic-a"); });
    const gate = hold(fresh, url => url.pathname === "/api/manga/comic-a", "合成纯失败");
    await fresh.page.evaluate(() => document.querySelector(".channel-more").click()); await gate.request; gate.release();
    await fresh.page.waitForFunction(() => document.querySelector(".channel-more")?.textContent.includes("重试"));
    assert.equal(await fresh.page.locator(".manga-chapter-card").count(), 120);
    await more(fresh, 840); assert.equal(details(fresh).length, 3, "a pure failure retries the same reveal target and still performs its original GET");
  } finally { for (const gate of fresh.holds) gate.release(); await fresh.context.close(); }
}
async function fullResetIntent(surface) {
  const f = await surface.open();
  try {
    await f.page.evaluate(() => {
      window.scrollTo({ top: 500, behavior: "instant" }); document.querySelector(".channel-more").focus({ preventScroll: true });
      __mangaAudit.oldCard = document.querySelector(".manga-chapter-card"); __mangaAudit.oldMore = document.querySelector(".channel-more"); __mangaAudit.oldSummary = document.querySelector(".manga-detail-summary");
    });
    f.comic.chapters[0].title = "响应更新旧章节";
    const gate = hold(f, url => url.pathname === "/api/manga/comic-a");
    await f.page.keyboard.press("Enter"); await gate.request;
    await f.page.mouse.wheel(0, -180); await frames(f.page);
    const y = await f.page.evaluate(() => scrollY);
    gate.release(); await ready(f.page, 840);
    assert.ok(Math.abs(await f.page.evaluate(() => scrollY) - y) <= 1, "a fresh changed snapshot preserves the current viewport after a held-request gesture");
    const requests = details(f).length, state = await snapshot(f.page);
    await f.page.evaluate(() => {
      __mangaAudit.oldCard.hidden = true; document.querySelector(".manga-chapter-list").append(__mangaAudit.oldCard);
      const holder = document.createElement("div"); holder.hidden = true; holder.append(__mangaAudit.oldMore, __mangaAudit.oldSummary); document.body.append(holder);
      __mangaAudit.oldCard.querySelector("button").click(); __mangaAudit.oldCard.querySelector("a")?.click();
      __mangaAudit.oldMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (const button of __mangaAudit.oldSummary.querySelectorAll("button")) button.click();
    });
    assert.equal(await f.page.evaluate(() => __mangaAudit.oldCard.isConnected && __mangaAudit.oldCard.parentElement === document.querySelector(".manga-chapter-list")), true);
    await f.page.evaluate(() => __mangaAudit.oldCard.remove()); await frames(f.page);
    assert.equal(details(f).length, requests); compare(await snapshot(f.page), state, "retired chapters/anchors/More/summary cannot revive after reset");
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
}
async function retirement(surface) {
  for (const change of ["comic", "reopen", "source"]) {
    const f = await surface.open();
    try {
      await f.page.evaluate(() => { __mangaAudit.ignoreAbort = true; __mangaAudit.oldList = document.querySelector(".manga-chapter-list"); __mangaAudit.oldMore = document.querySelector(".channel-more"); });
      const gate = hold(f, url => url.pathname === "/api/manga/comic-a");
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === "/api/manga/comic-a");
      await f.page.evaluate(() => document.querySelector(".channel-more").click()); await gate.request;
      const request = await requested;
      const finished = Promise.race(["requestfinished", "requestfailed"].map(event => f.page.waitForEvent(event, { predicate: value => value === request, timeout: 10000 })));
      if (change === "comic") await navigate(f, "mangaDetail", { id: "comic-b" });
      if (change === "reopen") { await navigate(f, "history"); await navigate(f, "mangaDetail", { id: "comic-a" }); }
      if (change === "source") await f.page.evaluate(base => { __mangaAudit.updateServer(`${base}/source-two`); __mangaAudit.host.ui.renderCurrentView(); }, surface.base);
      await ready(f.page, 120); const state = await snapshot(f.page), requests = details(f).length;
      await f.page.evaluate(() => {
        __mangaAudit.currentList = document.querySelector(".manga-chapter-list"); const holder = document.createElement("div"); holder.hidden = true;
        holder.append(__mangaAudit.oldList, __mangaAudit.oldMore); document.body.append(holder);
        __mangaAudit.oldList.querySelector("button").click(); __mangaAudit.oldList.querySelector("a")?.click();
        __mangaAudit.oldMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      gate.release(); await finished; await frames(f.page);
      assert.equal(details(f).length, requests); compare(await snapshot(f.page), state, `${change} fences old controls and an ignored-abort response`);
      assert.equal(await f.page.evaluate(() => __mangaAudit.currentList === document.querySelector("#viewContent .manga-chapter-list")), true);
    } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
  }
}
async function automaticRecovery(surface) {
  const failed = await surface.open();
  try {
    await failed.page.evaluate(async () => { const { clearCachedJsonByPrefix } = await import("/js/cache.js"); await clearCachedJsonByPrefix(location.origin, "/api/manga/comic-a"); });
    failed.offline = true;
    const gate = hold(failed, url => url.pathname === "/api/manga/comic-a", "合成自动离线");
    await failed.page.evaluate(() => window.scrollTo({ top: document.querySelector(".channel-more").offsetTop - 300, behavior: "instant" }));
    await gate.request; gate.release();
    await failed.page.waitForFunction(() => document.querySelector(".channel-more")?.textContent.includes("重试"));
    assert.equal(await failed.page.locator(".manga-chapter-card").count(), 120);
    assert.equal(await failed.page.evaluate(() => document.querySelector(".channel-more").getBoundingClientRect().top < innerHeight + 1600), true);
    const requests = details(failed).length;
    // Observe the real 120/420/900ms auto-load rechecks while More remains in range.
    await failed.page.waitForTimeout(1200);
    assert.equal(details(failed).length, requests, "a pure failed reveal pauses automatic retries");
    failed.offline = false; await more(failed, 840);
    assert.equal(details(failed).length, requests + 1, "manual retry keeps the original target after automatic failure");
  } finally { for (const gate of failed.holds) gate.release(); await failed.context.close(); }
  const pending = await surface.open();
  try {
    await pending.page.evaluate(() => { const key = "fanhao.android.mangaReadingProgress.v1", values = JSON.parse(localStorage.getItem(key)); values["comic-a"].chapterIndex = 2; localStorage.setItem(key, JSON.stringify(values)); });
    const gate = hold(pending, url => url.pathname === "/api/manga/comic-a");
    await pending.page.evaluate(() => document.querySelector(".channel-more").click()); await gate.request;
    await pending.page.waitForFunction(() => document.querySelectorAll("#viewContent .manga-chapter-card").length === 840);
    await pending.page.evaluate(() => window.scrollTo({ top: document.querySelector(".channel-more").offsetTop - 300, behavior: "instant" }));
    await pending.page.waitForTimeout(1100);
    assert.equal(details(pending).length, 2, "a cached-reset More waits on the existing slow request");
    assert.equal(await pending.page.locator(".channel-more").isDisabled(), true);
    gate.release(); await ready(pending.page, 1000);
    assert.equal(details(pending).length, 3, "normal auto reveal resumes after a slow same-signature fresh response without another gesture");
  } finally { for (const gate of pending.holds) gate.release(); await pending.context.close(); }
}
async function accountChange(surface) {
  const f = await surface.open();
  try {
    const previousRealm = await f.page.evaluate(() => __mangaAudit.realm);
    const nativeAuth = () => { globalThis.Capacitor = { Plugins: { FanHaoAuth: {
      getSession: async () => ({ token: localStorage.getItem("synthetic.fixture.session") || "" }),
      loginAccount: async () => { localStorage.setItem("synthetic.fixture.session", "usr.synthetic_A"); return { token: "usr.synthetic_A" }; }
    } } }; };
    await f.context.addInitScript(nativeAuth); await f.page.evaluate(nativeAuth);
    await f.page.evaluate(() => { __mangaAudit.ignoreAbort = true; });
    const gate = hold(f, url => url.pathname === "/api/manga/comic-a");
    await f.page.evaluate(() => document.querySelector(".channel-more").click()); await gate.request;
    f.accountId = "syntheticA"; f.comic.title = "新账号的合成漫画";
    const navigation = f.page.waitForNavigation({ waitUntil: "networkidle" });
    const auth = f.page.evaluate(async () => {
      const { authenticateAccount } = await import("/js/server-auth.js"); const { fetchJson } = await import("/js/api.js");
      await authenticateAccount(location.origin, "login", { username: "Synthetic" }); await fetchJson(location.origin, "/api/accounts/status");
    }).catch(error => assert.match(error.message, /Execution context was destroyed|navigation/));
    await Promise.all([navigation, auth]); await ready(f.page, 120);
    assert.notEqual(await f.page.evaluate(() => __mangaAudit.realm), previousRealm);
    assert.equal((await snapshot(f.page)).comic.title, f.comic.title);
    gate.release(); await frames(f.page); await more(f, 840);
    assert.equal((await snapshot(f.page)).comic.title, f.comic.title, "native account preparation leaves the new account's More usable");
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
}
try {
  browser = await chromium.launch({ headless: true, executablePath, args: ["--host-resolver-rules=MAP manga-fixture.test 127.0.0.1", "--no-proxy-server"] });
  const oldLan = await surface(frozen), nextLan = await surface(candidate), oldWan = await surface(frozen, true), nextWan = await surface(candidate, true);
  const budgets = [];
  if (!pattern || pattern === "scale") {
    for (const count of [200, 1000, 3000]) budgets.push(await scale(oldLan, nextLan, count, 1 + Math.ceil(Math.max(0, count - 120) / 720)));
    budgets.push(await scale(oldWan, nextWan, 1000, 20));
    groups++;
  }
  for (const [name, run] of [["snapshots", () => changedSnapshots(oldLan, nextLan)], ["native", () => nativeSurface(nextLan)],
    ["cache", () => cacheAndRetry(nextLan)], ["intent", () => fullResetIntent(nextLan)], ["retirement", () => retirement(nextLan)],
    ["auto", () => automaticRecovery(nextLan)], ["account", () => accountChange(nextLan)]]) {
    if (!pattern || name === pattern) { await run(); groups++; console.log(`PASS ${name}`); }
  }
  assert.ok(groups > 0, "case selector must execute an actual-entry group");
  assert.deepEqual(failures, []);
  for (const budget of budgets) assert.equal(budget.actual, budget.expected, "only newly revealed manga chapter cards are constructed");
  console.log(`Android manga detail rendering passed (${groups} groups, ${comparisons} complete comparisons; actual index, synthetic data only)`);
} finally { await browser?.close(); for (const owner of surfaces) await owner.close(); }

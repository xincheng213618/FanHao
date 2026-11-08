import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright-core";

// Actual Android index/app/registry/adapter, IndexedDB, full factory and CSS.
// The private HTTP server supplies synthetic JSON only. Covers are the actual
// text-based novel covers; this suite makes no image decoding claim.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(project, "android-client/www");
const before = "63c5fab243233e142cfd62c4eaf13812feb92405";
const hashes = {
  "/modules/novels/novel-views.js": "9356d0922883f88b649420b7304648344c60f8c06de13d60d2882537cdda1cc1",
  "/modules/novels/android-module.js": "9ee3f0c8a05bc58dc0cc3b984fdcc1cbab278a9e0c173ef83a58c057a213327b"
};
const frozen = {}, current = {};
for (const [url, hash] of Object.entries(hashes)) {
  frozen[url] = execFileSync("git", ["show", `${before}:android-client/www${url}`], { cwd: project, encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(frozen[url]).digest("hex"), hash, `fixed complete ${url}`);
  current[url] = fs.readFileSync(path.join(www, url), "utf8").replaceAll("\r\n", "\n");
}
assert.ok(process.argv.slice(2).every(value => ["--legacy-dom-reuse", "--entry-overlap", "--entry-baseline-only"].includes(value) || value.startsWith("--case=")));
const negative = process.argv.includes("--legacy-dom-reuse");
const entryBaselineOnly = process.argv.includes("--entry-baseline-only");
const entryOverlap = entryBaselineOnly || process.argv.includes("--entry-overlap");
const casePattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
if (negative) {
  const marker = "  function appendMountedNovelCollection(mount, data) {";
  assert.equal(current["/modules/novels/novel-views.js"].split(marker).length, 2);
  current["/modules/novels/novel-views.js"] = current["/modules/novels/novel-views.js"].replace(marker, `${marker}\n    return false; // Only restore the complete render fallback.`);
}
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert.ok(executablePath, "installed private Chromium required");
const realm = "server:00000000-0000-4000-8000-000000000001", otherRealm = "server:00000000-0000-4000-8000-000000000002";
const failures = [], surfaces = [];
let browser, sequence = 0, comparisons = 0;
function book(index, changes = {}) {
  return { id: `book-${String(index).padStart(5, "0")}`, title: `合成小说 ${String(index).padStart(5, "0")}`,
    author: `合成作者 ${index % 30}`, category: index % 2 ? "科幻" : "历史", chapterCount: 20 + index,
    charCount: 200000 + index * 1000, sizeBytes: 600000 + index * 3000,
    updatedAt: new Date(Date.UTC(2026, 10, 5) - index * 1000).toISOString(), sourceRealm: realm,
    catalogRevision: `synthetic-${index}`, summary: "合成故事简介。".repeat(24), status: "ok", ...changes };
}
const pool = count => Array.from({ length: count }, (_, index) => book(index));
function startup() {
  localStorage.setItem("fanhao.serverUrl", location.origin);
  localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "novels", params: {} }));
  window.__novelAudit = { realm: crypto.randomUUID(), cards: 0, elements: 0, cardBooks: new WeakMap(), records: null, api: null, host: null, read: null, scrollWrites: [] };
  const create = document.createElement;
  document.createElement = function (...args) { __novelAudit.elements++; return create.apply(this, args); };
  const fetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    if (window.__novelEntryProbe && new URL(input, location.href).pathname === "/api/novels") __novelEntryProbe.events.push(["network", performance.now()]);
    return fetch(input, __novelAudit.ignoreAbort ? { ...options, signal: undefined } : options);
  };
  const scroll = window.scrollTo;
  window.scrollTo = function (...args) { __novelAudit.scrollWrites.push(args); return scroll.apply(this, args); };
}
function instrument(source, url) {
  if (url === "/app.js") {
    const marker = "function createAndroidModuleHost() {\n  return Object.freeze({";
    assert.equal(source.split(marker).length, 2);
    return source.replace(marker, "function createAndroidModuleHost() {\n  window.__novelAudit.updateServer = updateServer;\n  return window.__novelAudit.host = Object.freeze({");
  }
  if (url !== "/modules/novels/novel-views.js") return source;
  const start = "export function createNovelViews(context) {", returned = "  return {\n    renderNovelList,";
  assert.equal(source.split(start).length, 2); assert.equal(source.split(returned).length, 2);
  source = source.replace(start, `${start}\n  window.__novelAudit.read = () => ({ page: novelPage, listState });`)
    .replace(returned, "  return window.__novelAudit.api = {\n    renderNovelList,");
  const create = /  function createNovelCard\(book = \{\}(?:, mount = null)?\) \{/g;
  assert.equal([...source.matchAll(create)].length, 1);
  source = source.replace(create, value => `${value}\n    window.__novelAudit.cards++;`);
  const card = '    card.className = "novel-mobile-card novel-mobile-book-row";';
  assert.equal(source.split(card).length, 2);
  source = source.replace(card, `${card}\n    window.__novelAudit.cardBooks.set(card, book);`);
  if (source.includes("  const novelCardRecords = new WeakMap();")) source = source.replace("  const novelCardRecords = new WeakMap();", "  const novelCardRecords = new WeakMap();\n  window.__novelAudit.records = novelCardRecords;");
  if (entryOverlap) {
    const imports = 'import { cacheAgeText, clearCachedJsonByPrefix, readCachedJson, writeCachedJson }';
    assert.equal(source.split(imports).length, 2);
    source = source.replace(imports, 'import { cacheAgeText, clearCachedJsonByPrefix, readCachedJson as readCachedJsonActual, writeCachedJson }');
    const local = "  async function loadLocalListData() {";
    assert.equal(source.split(local).length, 2);
    source = source.replace(local, `${local}\n    await delayShelfRead("local", 240);`);
    const render = "  function renderNovelListData(data = {}, cacheEntry = null) {";
    assert.equal(source.split(render).length, 2);
    source = source.replace(render, `${render}\n    if (novelPage?.remoteStatus === "loaded" && !cacheEntry) requestAnimationFrame(() => __novelEntryProbe.events.push(["fresh-visible", performance.now()]));`);
    source += `
async function delayShelfRead(type, delay) {
  __novelEntryProbe.events.push([type, performance.now()]);
  await new Promise(resolve => setTimeout(resolve, delay));
  __novelEntryProbe.events.push([type + "-ready", performance.now()]);
}
async function readCachedJson(base, path, ...rest) {
  if (path.startsWith("/api/novels?")) await delayShelfRead("cache", 150);
  return readCachedJsonActual(base, path, ...rest);
}`;
  }
  return source;
}
async function surface(sources) {
  const cases = new Map(), held = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), f = cases.get(req.headers["x-fixture-case"]);
    const send = (body, type = "application/json", status = 200) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } };
    try {
      const apiPath = url.pathname.replace(/^\/source-two/, "");
      if (apiPath.startsWith("/api/")) {
        assert.ok(f); const record = { path: apiPath, query: Object.fromEntries(url.searchParams), rows: 0 };
        f.requests.push(record); let payload = {};
        if (apiPath === "/api/novels") {
          let books = f.books;
          if (url.pathname.startsWith("/source-two")) books = books.map(item => ({ ...item, id: `other-${item.id}`, sourceRealm: otherRealm }));
          if (url.searchParams.get("q")) books = books.filter(item => `${item.title} ${item.author}`.includes(url.searchParams.get("q")));
          if (url.searchParams.get("category")) books = books.filter(item => item.category === url.searchParams.get("category"));
          const sort = url.searchParams.get("sort");
          books = [...books].sort(sort === "title" ? (a, b) => a.title.localeCompare(b.title, "zh-Hans-CN")
            : sort === "chapters" ? (a, b) => b.chapterCount - a.chapterCount
              : (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
          const limit = Math.min(5000, Number(url.searchParams.get("limit") || 80)), offset = Number(url.searchParams.get("offset") || 0);
          payload = { books: books.slice(offset, offset + limit), total: books.length, limit, offset, nextOffset: Math.min(books.length, offset + limit),
            sourceRealm: url.pathname.startsWith("/source-two") ? otherRealm : f.realm, listRevision: "synthetic-1",
            summary: { totals: { books: f.books.length }, categories: [{ name: "科幻", count: Math.floor(f.books.length / 2) }, { name: "历史", count: Math.ceil(f.books.length / 2) }] },
            facets: [{ name: "科幻", count: Math.floor(f.books.length / 2) }, { name: "历史", count: Math.ceil(f.books.length / 2) }] };
          payload.books = payload.books.map(item => ({ ...item, sourceRealm: payload.sourceRealm })); record.rows = payload.books.length;
        } else if (/^\/api\/novels\/[^/]+(?:\/catalog|\/chapters\/\d+)?$/.test(apiPath)) {
          const id = decodeURIComponent(apiPath.split("/")[3]), item = f.books.find(item => item.id === id) || book(0);
          const chapters = Array.from({ length: item.chapterCount }, (_, index) => ({ id: `${id}-c${index + 1}`, index: index + 1, title: `章节 ${index + 1}`, charCount: 500 }));
          const index = Number(apiPath.split("/")[5] || 1), chapter = { ...chapters[index - 1], content: "合成正文。\n".repeat(30) };
          payload = { book: item, chapters, chapter, prev: chapters[index - 2] || null, next: chapters[index] || null, sourceRealm: f.realm, catalogRevision: item.catalogRevision };
        } else if (apiPath === "/api/library") payload = { people: [], works: [], totals: { people: 0, works: 0, videos: 0, infoFiles: 0 }, user: { favorites: [], historyCount: 0 }, availableRoots: [], access: { mode: "loopback" } };
        else if (apiPath === "/api/modules") payload = { modules: [] };
        else if (apiPath === "/api/accounts/status") payload = { user: f.accountId ? { id: f.accountId, username: "Synthetic" } : null, accountLoginRequired: false, registrationEnabled: true };
        else if (apiPath === "/api/auth/status") payload = { authenticated: Boolean(f.accountId), user: f.accountId ? { id: f.accountId, username: "Synthetic" } : null };
        else if (apiPath === "/api/history") payload = { works: [], total: 0 };
        else if (apiPath === "/api/favorites/folders") payload = { folders: [] };
        else if (apiPath === "/api/system/control") payload = { ok: true, platform: "unsupported", actions: [] };
        else if (apiPath === "/api/android/update") payload = { available: false, versionCode: 0 };
        else if (apiPath.endsWith("/summary")) payload = { totals: {}, items: [], channels: [] };
        else failures.push(`unexpected API ${apiPath}`);
        const gate = f.holds.find(gate => !gate.used && gate.match(url));
        if (gate) { gate.used = true; held.add(gate); gate.requested(); await gate.promise; held.delete(gate); if (gate.error) return send(JSON.stringify({ error: gate.error }), "application/json", 503); }
        if (f.entryOverlap && apiPath === "/api/novels") await new Promise(resolve => setTimeout(resolve, 180));
        send(JSON.stringify(payload)); return;
      }
      if (url.pathname === "/favicon.ico") return send("", "image/x-icon", 204);
      const relative = url.pathname === "/" ? "/index.html" : url.pathname, target = path.resolve(www, `.${relative}`);
      assert.ok(target.startsWith(`${www}${path.sep}`));
      let body = sources[relative] || fs.readFileSync(target);
      if (relative === "/app.js" || relative === "/modules/novels/novel-views.js") body = instrument(body.toString().replaceAll("\r\n", "\n"), relative);
      if (relative === "/index.html") body = body.toString().replace("<head>", `<head><script>(${startup.toString()})()</script>`);
      send(body, relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : relative.endsWith(".html") ? "text/html" : "application/octet-stream");
    } catch (error) { failures.push(`${url.pathname}: ${error.message}`); send(error.message, "text/plain", 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = { base, async open(count = 240, prepareBooks) {
    const id = `case-${++sequence}`, f = { id, books: pool(count), realm, requests: [], holds: [], entryOverlap };
    prepareBooks?.(f.books);
    cases.set(id, f); f.context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, extraHTTPHeaders: { "X-Fixture-Case": id } });
    if (entryOverlap) await f.context.addInitScript(() => { window.__novelEntryProbe = { events: [] }; });
    f.page = await f.context.newPage(); f.page.on("pageerror", error => failures.push(error.message));
    await f.page.route(new RegExp(`^https?://(?!127\\.0\\.0\\.1:${server.address().port}(?:/|$))`), route => route.abort());
    await f.page.goto(base, { waitUntil: "networkidle" }); await ready(f.page, Math.min(80, count)); return f;
  }, async close() { for (const gate of held) gate.release(); await new Promise(resolve => server.close(resolve)); } };
  surfaces.push(result); return result;
}
async function ready(page, count) {
  await page.waitForFunction(count => document.querySelectorAll("#viewContent .novel-mobile-list > .novel-mobile-card").length === count
    && !document.querySelector("#viewContent .novel-mobile-load-more:disabled") && !__novelAudit.read().page?.collectionPending, count, { timeout: 30000 });
  await frames(page);
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const listRequests = f => f.requests.filter(record => record.path === "/api/novels");
async function snapshot(page) {
  return page.evaluate(() => ({
    view: __novelAudit.host.navigation.currentView(), params: __novelAudit.host.navigation.currentParams(),
    title: document.querySelector("#viewTitle").textContent, meta: document.querySelector("#viewMeta").textContent,
    cards: [...document.querySelectorAll("#viewContent .novel-mobile-list > .novel-mobile-card")].map(card => ({
      book: __novelAudit.records?.get(card)?.book || __novelAudit.cardBooks.get(card), text: card.textContent, className: card.className,
      buttons: [...card.querySelectorAll("button")].map(button => [button.textContent, button.getAttribute("aria-label")])
    })), more: document.querySelector("#viewContent .novel-mobile-load-more")?.textContent || "",
    sources: [...document.querySelectorAll("#viewContent .novel-mobile-shelf-toolbar button")].map(button => [button.textContent, button.getAttribute("aria-pressed")]),
    search: document.querySelector(".novel-mobile-search-result-meta")?.textContent || ""
  }));
}
function compare(actual, expected, label) {
  const same = isDeepStrictEqual(actual, expected);
  const key = !same && [...new Set([...Object.keys(actual), ...Object.keys(expected)])].find(key => !isDeepStrictEqual(actual[key], expected[key]));
  const detail = key && !Array.isArray(actual[key]) ? `: ${JSON.stringify(actual[key])} vs ${JSON.stringify(expected[key])}` : "";
  assert.ok(same, `${label}${key ? ` (${key}${detail})` : ""}`); comparisons++;
}
async function more(f, count) { await f.page.locator("#viewContent .novel-mobile-load-more").click(); await ready(f.page, count); }
function hold(f, match, error = "") {
  let release, requested;
  const gate = { match, error, used: false, promise: new Promise(resolve => { release = resolve; }), request: new Promise(resolve => { requested = resolve; }) };
  gate.release = release; gate.requested = requested; f.holds.push(gate); return gate;
}
async function navigate(f, view, params = {}) {
  await f.page.evaluate(({ view, params }) => __novelAudit.host.navigation.showView(view, params), { view, params });
  await f.page.waitForFunction(view => __novelAudit.host.navigation.currentView() === view, view);
}
async function scale(oldSurface, nextSurface) {
  const old = await oldSurface.open(2400), next = await nextSurface.open(2400);
  try {
    for (let index = 1; index <= 20; index++) {
      if (index > 1) { await more(old, index * 80); await more(next, index * 80); }
      compare(await snapshot(next.page), await snapshot(old.page), `complete prefix page ${index}`);
    }
    compare(listRequests(next), listRequests(old), "same twenty cumulative GETs and rows");
    const stats = async f => f.page.evaluate(() => ({ cards: __novelAudit.cards, elements: __novelAudit.elements }));
    const first = await stats(old), second = await stats(next);
    assert.equal(first.cards, 16800); assert.equal(listRequests(next).reduce((sum, request) => sum + request.rows, 0), 16800);
    console.log(`Android novel 20-page scale: ${first.cards} -> ${second.cards} cards; ${first.elements} -> ${second.elements} elements; 20 GET / 16800 rows unchanged`);
    return second.cards;
  } finally { await old.context.close(); await next.context.close(); }
}
async function fallbacks(oldSurface, nextSurface) {
  for (const [name, change] of [
    ["prefix title", books => { books[0].title = "更新后的旧书标题"; }],
    ["operation-only fields", books => { books[0].summary += "新摘要"; }],
    ["progress changes", books => { books[0].progress = { chapterIndex: 7, chapterId: "book-00000-c7", scrollRatio: 0.4, catalogRevision: books[0].catalogRevision, updatedAt: "2026-11-05" }; }],
    ["sort reorder", books => { books[180].updatedAt = "2027-01-01"; }],
    ["duplicate IDs", books => { books[1].id = books[0].id; }],
    ["missing ID", books => { delete books[2].id; }],
    ["source realm", () => {}]
  ]) {
    const old = await oldSurface.open(), next = await nextSurface.open();
    try {
      change(old.books); change(next.books);
      if (name === "source realm") { old.realm = otherRealm; next.realm = otherRealm; }
      await more(old, 160); await more(next, 160);
      compare(await snapshot(next.page), await snapshot(old.page), `full fallback preserves ${name}`);
    } finally { await old.context.close(); await next.context.close(); }
  }
  const old = await oldSurface.open(), next = await nextSurface.open();
  try {
    for (const f of [old, next]) { await navigate(f, "novelSearch", { query: "合成" }); await ready(f.page, 80); await more(f, 160); }
    compare(await snapshot(next.page), await snapshot(old.page), "actual search prefix paging");
  } finally { await old.context.close(); await next.context.close(); }
}
async function failureRecovery(surface) {
  const f = await surface.open();
  try {
    const gate = hold(f, url => url.pathname === "/api/novels" && url.searchParams.get("limit") === "160", "合成离线");
    await f.page.locator(".novel-mobile-load-more").focus(); await f.page.keyboard.press("Enter"); await gate.request;
    assert.equal(await f.page.locator(".novel-mobile-card").count(), 80, "accepted prefix stays visible while held");
    await f.page.evaluate(() => document.querySelector(".novel-mobile-load-more").click());
    assert.equal(listRequests(f).length, 2, "disabled/mount pending blocks another dispatch");
    gate.release(); await f.page.waitForFunction(() => document.querySelector(".novel-mobile-load-more")?.textContent.includes("重试")); await ready(f.page, 80);
    assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector(".novel-mobile-load-more")), true);
    await more(f, 160); assert.deepEqual(listRequests(f).map(request => request.query.limit), ["80", "160", "160"]);
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
}
async function localReadRecovery(surface) {
  const f = await surface.open();
  try {
    await f.page.evaluate(() => {
      __novelAudit.nativeGetAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        if (this.transaction.db.name === "fanhao-local-novels" && this.name === "bookMetadata") throw new DOMException("合成本机摘要故障", "UnknownError");
        return __novelAudit.nativeGetAll.apply(this, args);
      };
    });
    await more(f, 160);
    assert.equal(await f.page.locator("[data-local-novel-error]").count(), 1);
    assert.match(await f.page.locator("#viewMeta").textContent(), /本机库读取失败/);
    const requests = listRequests(f).length;
    await f.page.evaluate(() => { IDBObjectStore.prototype.getAll = __novelAudit.nativeGetAll; });
    await f.page.locator("[data-local-novel-error] button").first().click();
    await f.page.waitForFunction(() => !document.querySelector("[data-local-novel-error]")); await ready(f.page, 160);
    assert.equal(listRequests(f).length, requests, "local-summary retry neither increments the remote target nor sends another GET");
  } finally { await f.context.close(); }
}
async function nativeSurface(surface) {
  const f = await surface.open(160, ([first]) => {
    first.progress = { chapterIndex: 7, chapterId: `${first.id}-c7`, scrollRatio: 0.4, catalogRevision: first.catalogRevision };
  });
  try {
    await f.page.locator(".novel-mobile-load-more").scrollIntoViewIfNeeded(); await frames(f.page);
    await f.page.locator(".novel-mobile-load-more").focus();
    const saved = await f.page.evaluate(() => {
      __novelAudit.oldCard = document.querySelector(".novel-mobile-card");
      __novelAudit.oldBook = __novelAudit.records.get(__novelAudit.oldCard).book;
      __novelAudit.oldMore = document.querySelector(".novel-mobile-load-more");
      __novelAudit.beforeScrollWrites = __novelAudit.scrollWrites.length;
      return { y: scrollY, top: document.querySelectorAll(".novel-mobile-card")[78].getBoundingClientRect().top };
    });
    await f.page.keyboard.press("Enter"); await ready(f.page, 160);
    const after = await f.page.evaluate(() => ({
      retained: __novelAudit.oldCard === document.querySelector(".novel-mobile-card"), y: scrollY,
      top: document.querySelectorAll(".novel-mobile-card")[78].getBoundingClientRect().top,
      rebound: __novelAudit.records.get(__novelAudit.oldCard)?.book !== __novelAudit.oldBook,
      focused: document.activeElement === document.querySelectorAll(".novel-mobile-book-detail")[159],
      writes: __novelAudit.scrollWrites.length - __novelAudit.beforeScrollWrites
    }));
    assert.equal(after.retained, !negative); assert.equal(after.rebound, true);
    assert.equal(after.focused, true, "EOF moves focus to the last actual book detail button");
    assert.ok(Math.abs(after.y - saved.y) <= 1); assert.ok(Math.abs(after.top - saved.top) <= 1);
    if (!negative) assert.equal(after.writes, 0, "stable append does not write window scroll");
    await f.page.locator(".novel-mobile-book-read").first().click();
    await f.page.waitForFunction(() => __novelAudit.host.navigation.currentView() === "novelReader");
    const params = await f.page.evaluate(() => __novelAudit.host.navigation.currentParams());
    assert.equal(params.id, "book-00000");
    assert.equal(params.chapterIndex, "7", "the separate reading control must open the saved chapter");
  } finally { await f.context.close(); }
}
async function seedCache(f, limit, books, total = f.books.length) {
  await f.page.evaluate(async ({ limit, books, total, realm }) => {
    const { writeCachedJson } = await import("/js/cache.js");
    await writeCachedJson(location.origin, `/api/novels?limit=${limit}`, { books, total, limit, offset: 0, sourceRealm: realm,
      facets: [{ name: "科幻", count: Math.floor(total / 2) }, { name: "历史", count: Math.ceil(total / 2) }],
      summary: { totals: { books: total } } });
  }, { limit, books, total, realm: f.realm });
}
async function cachedRefresh(surface) {
  const f = await surface.open();
  try {
    const cached = structuredClone(f.books.slice(0, 160)); cached[0].title = "缓存中的新标题";
    await seedCache(f, 160, cached);
    const gate = hold(f, url => url.pathname === "/api/novels" && url.searchParams.get("limit") === "160", "合成刷新失败");
    await f.page.locator(".novel-mobile-load-more").scrollIntoViewIfNeeded(); await frames(f.page);
    await f.page.locator(".novel-mobile-load-more").focus(); await f.page.keyboard.press("Enter"); await gate.request;
    await f.page.waitForFunction(() => document.querySelectorAll("#viewContent .novel-mobile-card").length === 160 && document.querySelector(".novel-mobile-load-more")?.disabled);
    assert.equal(await f.page.locator(".novel-mobile-card strong").first().textContent(), cached[0].title);
    await f.page.evaluate(() => document.querySelector(".novel-mobile-load-more").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(listRequests(f).length, 2, "cached full reset keeps a page-wide pending fence");
    gate.release(); await ready(f.page, 160);
    assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector(".novel-mobile-load-more")), true, "cached reset restores focus after fresh failure enables the new More");
    assert.match(await f.page.locator("#viewContent").textContent(), /当前显示的是上次内容/);
    await more(f, 240); assert.deepEqual(listRequests(f).map(record => record.query.limit), ["80", "160", "240"], "an accepted cached prefix advances the next target");
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
  const eof = await surface.open();
  try {
    await seedCache(eof, 160, eof.books.slice(0, 160), 160);
    const gate = hold(eof, url => url.pathname === "/api/novels" && url.searchParams.get("limit") === "160");
    await eof.page.locator(".novel-mobile-load-more").click(); await gate.request;
    await eof.page.waitForFunction(() => document.querySelectorAll("#viewContent .novel-mobile-card").length === 160 && !document.querySelector(".novel-mobile-load-more"));
    gate.release(); await ready(eof.page, 160);
    assert.equal(await eof.page.locator(".novel-mobile-load-more").count(), 1, "fresh total revives More after cached EOF");
    await more(eof, 240);
  } finally { for (const gate of eof.holds) gate.release(); await eof.context.close(); }
}
async function fallbackIntent(surface) {
  for (const action of ["wheel", "focus"]) {
    const f = await surface.open();
    try {
      f.books[0].title = "响应更新旧书";
      await f.page.locator(".novel-mobile-load-more").scrollIntoViewIfNeeded(); await frames(f.page);
      await f.page.locator(".novel-mobile-load-more").focus();
      const gate = hold(f, url => url.pathname === "/api/novels" && url.searchParams.get("limit") === "160");
      await f.page.keyboard.press("Enter"); await gate.request;
      if (action === "wheel") { await f.page.mouse.wheel(0, -180); await frames(f.page); }
      else await f.page.locator(".novel-mobile-shelf-toolbar button").first().focus();
      const y = await f.page.evaluate(() => scrollY);
      gate.release(); await ready(f.page, 160);
      assert.ok(Math.abs(await f.page.evaluate(() => scrollY) - y) <= 1, "full reset preserves the latest viewport, including a held-request wheel");
      if (action === "focus") assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector(".novel-mobile-load-more")), false, "new More cannot steal a newer focus choice");
    } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
  }
}
async function retirement(surface) {
  for (const change of ["reopen", "query", "sort", "source", "local"]) {
    const f = await surface.open();
    try {
      await f.page.evaluate(() => {
        __novelAudit.ignoreAbort = true;
        __novelAudit.oldList = document.querySelector(".novel-mobile-list");
        __novelAudit.oldMore = document.querySelector(".novel-mobile-load-more");
        __novelAudit.oldControls = document.querySelector(".novel-mobile-shelf-toolbar");
      });
      const gate = hold(f, url => url.pathname === "/api/novels" && url.searchParams.get("limit") === "160");
      const clientRequest = f.page.waitForRequest(request => { const url = new URL(request.url()); return url.pathname === "/api/novels" && url.searchParams.get("limit") === "160"; });
      await f.page.locator(".novel-mobile-load-more").click(); await gate.request;
      const request = await clientRequest;
      const finished = Promise.race(["requestfinished", "requestfailed"].map(event => f.page.waitForEvent(event, { predicate: value => value === request, timeout: 10000 })));
      if (change === "reopen") { await navigate(f, "history"); await navigate(f, "novels"); await ready(f.page, 160); }
      if (change === "query") { await navigate(f, "novelSearch", { query: "合成小说 001" }); await ready(f.page, 100); }
      if (change === "sort") { await f.page.evaluate(() => { __novelAudit.api.setNovelSort("title"); __novelAudit.host.ui.renderCurrentView(); }); await ready(f.page, 80); }
      if (change === "source") { await f.page.evaluate(base => { __novelAudit.updateServer(`${base}/source-two`); __novelAudit.host.ui.renderCurrentView(); }, surface.base); await ready(f.page, 160); }
      if (change === "local") { await f.page.locator(".novel-mobile-shelf-toolbar button").nth(1).click(); await ready(f.page, 0); }
      const state = await snapshot(f.page), requests = listRequests(f).length;
      await f.page.evaluate(() => {
        __novelAudit.currentFirst = document.querySelector("#viewContent .novel-mobile-card");
        __novelAudit.currentMore = document.querySelector("#viewContent .novel-mobile-load-more");
        const holder = document.createElement("div"); holder.hidden = true; holder.id = "retired-novel-fixture";
        holder.append(__novelAudit.oldList, __novelAudit.oldMore, __novelAudit.oldControls); document.body.append(holder);
        __novelAudit.oldMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        __novelAudit.oldList.querySelector(".novel-mobile-book-detail").click();
        __novelAudit.oldList.querySelector(".novel-mobile-book-read").click();
        __novelAudit.oldList.querySelector(".novel-mobile-book-more").click();
        __novelAudit.oldControls.querySelectorAll("button")[1].click();
      });
      assert.equal(await f.page.evaluate(() => [__novelAudit.oldList, __novelAudit.oldMore, __novelAudit.oldControls].every(node => node.isConnected)), true);
      gate.release(); await finished; await frames(f.page);
      assert.equal(listRequests(f).length, requests, "connected retired controls issue no list request");
      compare(await snapshot(f.page), state, `${change} retires controls, book actions and ignored-abort completion`);
      assert.equal(await f.page.evaluate(() => __novelAudit.currentFirst === document.querySelector("#viewContent .novel-mobile-card")
        && __novelAudit.currentMore === document.querySelector("#viewContent .novel-mobile-load-more")), true, "late completion cannot replace even an identical reopened presentation");
    } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
  }
}
async function accountChange(surface) {
  const f = await surface.open();
  try {
    const previousRealm = await f.page.evaluate(() => __novelAudit.realm);
    const nativeAuth = () => { globalThis.Capacitor = { Plugins: { FanHaoAuth: {
      getSession: async () => ({ token: localStorage.getItem("synthetic.fixture.session") || "" }),
      loginAccount: async () => { localStorage.setItem("synthetic.fixture.session", "usr.synthetic_A"); return { token: "usr.synthetic_A" }; }
    } } }; };
    await f.context.addInitScript(nativeAuth); await f.page.evaluate(nativeAuth);
    await f.page.evaluate(() => { __novelAudit.ignoreAbort = true; });
    const gate = hold(f, url => url.pathname === "/api/novels" && url.searchParams.get("limit") === "160");
    await f.page.locator(".novel-mobile-load-more").click(); await gate.request;
    f.accountId = "syntheticA"; f.books = f.books.map(item => ({ ...item, id: `accountA-${item.id}` }));
    const navigation = f.page.waitForNavigation({ waitUntil: "networkidle" });
    const auth = f.page.evaluate(async () => {
      const { authenticateAccount } = await import("/js/server-auth.js"); const { fetchJson } = await import("/js/api.js");
      await authenticateAccount(location.origin, "login", { username: "Synthetic" }); await fetchJson(location.origin, "/api/accounts/status");
    }).catch(error => assert.match(error.message, /Execution context was destroyed|navigation/));
    await Promise.all([navigation, auth]); await ready(f.page, 80);
    assert.notEqual(await f.page.evaluate(() => __novelAudit.realm), previousRealm, "account change destroys the old JS realm");
    const state = await snapshot(f.page); assert.ok(state.cards.every(item => item.book.id.startsWith("accountA-")));
    gate.release(); await frames(f.page); compare(await snapshot(f.page), state, "old account cannot publish into the new account realm");
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
}
async function entryTiming(surface, previous) {
  const f = await surface.open(160);
  const phases = async () => f.page.evaluate(() => Object.fromEntries(__novelEntryProbe.events));
  const timing = (events) => ({ startSkewMs: Math.round(Math.max(events.local, events.cache, events.network) - Math.min(events.local, events.cache, events.network)),
    remoteBeforeLocalReady: events.network < events["local-ready"], cacheBeforeLocalReady: events.cache < events["local-ready"] });
  try {
    const initial = await phases();
    assert(Number.isFinite(initial["fresh-visible"]), "fresh shelf rendered an actual frame");
    const entry = { ...timing(initial), firstFreshMs: Math.round(initial["fresh-visible"] - Math.min(initial.local, initial.cache, initial.network)) };
    const moreStarted = performance.now();
    await f.page.evaluate(() => { __novelEntryProbe.events.length = 0; document.querySelector(".novel-mobile-load-more").click(); });
    await ready(f.page, 160);
    const next = { ...timing(await phases()), moreReadyMs: Math.round(performance.now() - moreStarted) };
    assert.deepEqual(listRequests(f).map(request => request.rows), [80, 160]);
    for (const result of [entry, next]) {
      assert.equal(result.remoteBeforeLocalReady, !previous);
      assert.equal(result.cacheBeforeLocalReady, !previous);
    }
    if (!previous) {
      const requests = listRequests(f).length;
      await f.page.locator(".novel-mobile-shelf-toolbar button").filter({ hasText: "手机离线" }).click();
      await f.page.waitForFunction(() => __novelAudit.read().page?.localData && __novelAudit.read().listState.source === "local");
      assert.equal(listRequests(f).length, requests, "the pure local shelf must not dispatch a remote read");
    }
    return { entry, next };
  } finally { await f.context.close(); }
}

try {
  browser = await chromium.launch({ headless: true, executablePath });
  if (entryOverlap) {
    const url = "/modules/novels/novel-views.js";
    const original = execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:android-client/www${url}`], { cwd: project, encoding: "utf8" });
    let restored = current[url];
    for (const [start, end] of [["  async function renderNovelCollection(", "  function novelCollectionScope("], ["  async function loadMoreNovelCollection(", "  function renderNovelListData("]]) {
      const first = restored.indexOf(start), stop = restored.indexOf(end, first), oldFirst = original.indexOf(start), oldStop = original.indexOf(end, oldFirst);
      assert(first >= 0 && oldFirst >= 0 && stop > first && oldStop > oldFirst);
      restored = restored.slice(0, first) + original.slice(oldFirst, oldStop) + restored.slice(stop);
    }
    console.log(JSON.stringify({ mode: "previous", ...await entryTiming(await surface({ ...current, [url]: restored }), true) }));
    if (!entryBaselineOnly) console.log(JSON.stringify({ mode: "current", ...await entryTiming(await surface(current), false) }));
    assert.deepEqual(failures, []);
  } else {
    const oldSurface = await surface(frozen), nextSurface = await surface(current);
    let createdCards, groups = 0;
    for (const [name, run] of [
      ["scale", async () => { createdCards = await scale(oldSurface, nextSurface); }],
      ["fallbacks", () => fallbacks(oldSurface, nextSurface)], ["failure", () => failureRecovery(nextSurface)], ["local-read", () => localReadRecovery(nextSurface)],
      ["native", () => nativeSurface(nextSurface)], ["cache", () => cachedRefresh(nextSurface)],
      ["intent", () => fallbackIntent(nextSurface)], ["retirement", () => retirement(nextSurface)], ["account", () => accountChange(nextSurface)]
    ]) if (!casePattern || name.includes(casePattern)) { await run(); groups++; console.log(`PASS ${name}`); }
    assert.ok(groups > 0, "case selector must execute an actual-entry group");
    assert.deepEqual(failures, []);
    if (createdCards !== undefined) assert.equal(createdCards, 1600, "only the newly accepted eighty cards are constructed");
    console.log(`Android novel list rendering passed (${groups} actual-entry groups, ${comparisons} complete oracle comparisons; synthetic data only)`);
  }
} finally {
  await browser?.close();
  for (const owner of surfaces) await owner.close();
}

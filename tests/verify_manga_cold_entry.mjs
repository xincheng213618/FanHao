import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual /manga index, standalone host, complete manga owner, CSS, geometry,
// history and native images. Only loopback synthetic API/SVG data is supplied.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public"), ownerPath = "/modules/photos/manga-page.js";
const before = execFileSync("git", ["show", "63c5fab243233e142cfd62c4eaf13812feb92405:public/modules/photos/manga-page.js"], { cwd: root, encoding: "utf8" }).replaceAll("\r\n", "\n");
assert.equal(createHash("sha256").update(before).digest("hex"), "bc37a3a42d618a1a5d489395da8b314c50b01cbe161a39522a43ead2bede878f");
let current = fs.readFileSync(path.join(publicRoot, ownerPath), "utf8").replaceAll("\r\n", "\n");
assert.ok(process.argv.slice(2).every(value => value === "--legacy-temporary-catalog"));
const negative = process.argv.includes("--legacy-temporary-catalog");
if (negative) {
  const marker = "else if (options.coldEntry) els.workGrid.replaceChildren(renderStatus());";
  assert.equal(current.split(marker).length, 2);
  current = current.replace(marker, "else if (options.coldEntry) renderView();");
}
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert.ok(executablePath, "installed Chrome or Edge required");
let browser, sequence = 0, comparisons = 0;
const surfaces = [], failures = [];
function comic(id, count = 1000) {
  return { id, title: `Comic ${id}`, site: "fixture", author: "Synthetic", sourceUrl: `https://example.invalid/${id}`, coverUrl: `/synthetic/${id}/cover.svg`,
    chapterCount: count, doneChapterCount: count, imageCount: count * 3, downloadedCount: count * 3, failedCount: 0, updatedAt: "2026-01-01T00:00:00Z",
    chapters: Array.from({ length: count }, (_, index) => ({ index: index + 1, title: `Chapter ${index + 1}`, status: "done", imageCount: 3, downloadedCount: 3 })) };
}
function startup() {
  window.__cold = { created: 0, state: null, api: null, started: [], settled: [], ignoreAbort: true };
  const create = document.createElement;
  document.createElement = function (...args) { __cold.created++; return create.apply(this, args); };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href), relative = `${url.pathname}${url.search}`;
    __cold.started.push({ url: relative, at: performance.now() });
    const response = await nativeFetch(input, __cold.ignoreAbort ? { ...options, signal: undefined } : options);
    const json = response.json.bind(response);
    response.json = async () => { try { return await json(); } finally { __cold.settled.push({ url: relative, at: performance.now() }); } };
    return response;
  };
}
function instrument(source) {
  const marker = "export function createMangaPage(deps) {";
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, `${marker}\n  window.__cold.state = deps.state;`);
  const returned = "return { applyRouteState, enter, openRouteTarget, renderStats, renderView, resetReader };";
  assert.equal(source.split(returned).length, 2);
  return source.replace(returned, "return window.__cold.api = { applyRouteState, enter, openRouteTarget, renderStats, renderView, resetReader };");
}
async function surface(source) {
  const cases = new Map(), pending = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), f = cases.get(req.headers["x-fixture-case"]);
    const send = (body, type = "application/json", status = 200) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } };
    try {
      if (url.pathname === "/favicon.ico") return send("", "image/x-icon", 204);
      if (url.pathname.startsWith("/api/")) {
        assert.ok(f); assert.equal(req.method, "GET"); f.requests.push(`${url.pathname}${url.search}`);
        const gate = f.holds.find(gate => !gate.used && gate.match(url));
        if (gate) { gate.used = true; gate.url = `${url.pathname}${url.search}`; pending.add(gate); res.once("close", () => { gate.closed = true; }); gate.requested(); await gate.promise; pending.delete(gate); if (gate.error) return send(JSON.stringify({ error: gate.error }), "application/json", 503); }
        const chapter = /^\/api\/manga\/([^/]+)\/chapters\/(\d+)$/.exec(url.pathname);
        if (chapter) {
          const value = f.comics.get(chapter[1]), index = Number(chapter[2]);
          assert.ok(value); const { chapters, ...summary } = value;
          return send(JSON.stringify({ comic: summary, chapter: { index, title: `Chapter ${index}`, images: [1, 2, 3].map(page => ({ index: page, name: `Page ${page}`, width: 800, height: 1400, url: `/synthetic/${value.id}/${index}/${page}.svg` })) } }));
        }
        const detail = /^\/api\/manga\/([^/]+)$/.exec(url.pathname);
        if (detail) return send(JSON.stringify({ comic: f.comics.get(detail[1]), update: { status: "idle" } }));
        if (url.pathname === "/api/manga") return send(JSON.stringify({ comics: [...f.comics.values()].map(({ chapters, ...value }) => value) }));
        if (url.pathname === "/api/modules") return send(JSON.stringify({ product: { id: "suite" }, modules: [] }));
        throw new Error(`unexpected synthetic API ${url.pathname}`);
      }
      if (url.pathname.startsWith("/synthetic/")) return send('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1400"><rect width="800" height="1400" fill="#729b7c"/></svg>', "image/svg+xml");
      if (url.pathname === ownerPath) return send(instrument(source), "text/javascript");
      const target = /^\/manga(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, `.${url.pathname}`);
      assert.ok(target.startsWith(`${publicRoot}${path.sep}`));
      let body = fs.readFileSync(target);
      if (target.endsWith("index.html")) body = body.toString().replace("<head>", `<head><script>(${startup.toString()})();__cold.ignoreAbort=${f.ignoreAbort};</script>`);
      send(body, target.endsWith(".html") ? "text/html" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "application/octet-stream");
    } catch (error) { failures.push(`${url.pathname}: ${error.message}`); send(error.message, "text/plain", 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = { async open(count, chapter = Math.floor(count * .77), { error = "", holdChapter = true, route, ignoreAbort = true } = {}) {
    const id = `case-${++sequence}`, f = { requests: [], holds: [], ignoreAbort, comics: new Map([["C", comic("C", count)], ["D", comic("D", 3)]]) };
    cases.set(id, f); f.context = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "X-Fixture-Case": id } });
    f.page = await f.context.newPage(); f.page.on("pageerror", error => failures.push(error.message));
    await f.page.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
    f.gate = holdChapter ? hold(f, url => url.pathname === `/api/manga/C/chapters/${chapter}`, error) : null;
    await f.page.goto(`${base}${route || `/manga/C/read/${chapter}`}`, { waitUntil: "commit" });
    if (f.gate) await f.gate.request;
    else await f.page.waitForFunction(() => Boolean(__cold.api));
    return f;
  }, async close() { for (const gate of pending) gate.release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
  surfaces.push(api); return api;
}
function hold(f, match, error = "") {
  let release, requested;
  const gate = { match, error, used: false, closed: false, promise: new Promise(resolve => { release = resolve; }), request: new Promise(resolve => { requested = resolve; }) };
  gate.release = release; gate.requested = requested; f.holds.push(gate); return gate;
}
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function settle(f, gate) {
  const count = await f.page.evaluate(url => __cold.settled.filter(item => item.url === url).length, gate.url);
  gate.release(); await f.page.waitForFunction(({ url, count }) => __cold.settled.filter(item => item.url === url).length > count, { url: gate.url, count }, { timeout: 5000 }); await frames(f.page);
}
async function reader(f, id = "C", chapter) {
  await f.page.waitForFunction(({ id, chapter }) => document.querySelector(".manga-reader")?.dataset.comicId === id && document.querySelector(".manga-reader")?.dataset.chapterIndex === String(chapter), { id, chapter });
  await f.page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading")); await frames(f.page);
}
async function snapshot(f) {
  return f.page.evaluate(() => ({ comic: __cold.state.manga.comic, chapter: __cold.state.manga.chapter, status: __cold.state.manga.status, loading: __cold.state.manga.loading,
    reader: document.querySelector(".manga-reader") ? { className: document.querySelector(".manga-reader").className, title: document.querySelector(".manga-reader-identity strong").textContent,
      chapter: document.querySelector(".manga-reader-identity span").textContent,
      buttons: [...document.querySelectorAll(".manga-reader button")].map(node => ({ text: node.textContent, disabled: node.disabled, action: node.dataset.action || "" })),
      images: [...document.querySelectorAll(".manga-reader-pages img")].map(node => ({ src: node.getAttribute("src"), alt: node.alt, loading: node.loading, width: node.getAttribute("width"), height: node.getAttribute("height") })) } : null,
    progress: JSON.parse(localStorage.getItem("fanhao.manga.progress") || "{}"), route: location.pathname }));
}
async function navigate(f, url) { await f.page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, url); }
async function verifyFailure(surface) {
  const f = await surface.open(1000, 777, { error: "Synthetic chapter unavailable" });
  try {
    await settle(f, f.gate);
    await f.page.locator(".manga-detail h1").waitFor();
    assert.equal(await f.page.locator(".manga-chapter-row").count(), 1000);
    const feedback = f.page.locator(".manga-chapter-feedback"); await feedback.waitFor(); assert.match(await feedback.textContent(), /Synthetic chapter unavailable/);
    assert.equal((await snapshot(f)).progress.C, undefined, "failed cold entry does not record reading progress");
    await feedback.locator("button").click(); await reader(f, "C", 777);
    assert.equal(f.requests.filter(url => url === "/api/manga/C/chapters/777").length, 2);
    assert.equal((await snapshot(f)).progress.C, 777); comparisons++;
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
}
async function verifySuperseded(surface) {
  for (const error of ["", "obsolete chapter failure"]) {
    const f = await surface.open(1000, 777, { error });
    try {
      await navigate(f, "/manga/D/read/2"); await reader(f, "D", 2);
      const latest = await snapshot(f); await settle(f, f.gate);
      assert.deepEqual(await snapshot(f), latest, "obsolete cold success/failure cannot replace the later reader or progress"); comparisons++;
    } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
  }
  const f = await surface.open(200, 154, { ignoreAbort: false });
  try {
    const aborted = f.page.waitForEvent("requestfailed", { predicate: request => new URL(request.url()).pathname === "/api/manga/C/chapters/154", timeout: 5000 });
    await navigate(f, "/manga"); await f.page.locator(".manga-library-controls").waitFor();
    const route = f.page.url(); await aborted; f.gate.release(); await frames(f.page);
    assert.equal(f.page.url(), route); assert.equal(await f.page.locator(".manga-reader,.manga-detail").count(), 0); comparisons++;
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
}
async function verifyExistingView(surface) {
  for (const source of ["detail", "reader"]) {
    const f = await surface.open(200, 154, { holdChapter: false, route: source === "detail" ? "/manga/C" : "/manga/C/read/1" });
    try {
      if (source === "detail") await f.page.locator(".manga-chapter-row").first().waitFor(); else await reader(f, "C", 1);
      const target = source === "detail" ? 154 : 2, gate = hold(f, url => url.pathname === `/api/manga/C/chapters/${target}`, "Synthetic retained-view failure");
      await f.page.evaluate(source => { __cold.previousView = document.querySelector(source === "detail" ? ".manga-detail" : ".manga-reader"); }, source);
      if (source === "detail") await f.page.locator('.manga-chapter-row[data-chapter-index="154"] button').click();
      else await f.page.locator('.manga-reader-bar [data-action="next"]').click();
      await gate.request;
      assert.equal(await f.page.evaluate(() => __cold.previousView.isConnected), true);
      await settle(f, gate); assert.equal(await f.page.evaluate(() => __cold.previousView.isConnected), true);
      assert.match(await f.page.locator(".manga-chapter-feedback").textContent(), /Synthetic retained-view failure/); comparisons++;
    } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
  }
}

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const old = await surface(before), next = await surface(current), measurements = [];
  for (const count of [200, 1000, 3000]) {
    const target = Math.floor(count * .77), a = await old.open(count, target), b = await next.open(count, target);
    try {
      const pending = async f => f.page.evaluate(() => { const comic = __cold.settled.find(value => value.url === "/api/manga/C"), chapter = __cold.started.find(value => value.url.startsWith("/api/manga/C/chapters/")); return { rows: document.querySelectorAll(".manga-chapter-row").length, created: __cold.created, chapterRequestDelayMs: chapter.at - comic.at }; });
      const scale = { count, before: await pending(a), current: await pending(b) };
      await settle(a, a.gate); await settle(b, b.gate); await reader(a, "C", target); await reader(b, "C", target);
      assert.deepEqual(await snapshot(b), await snapshot(a), "complete frozen/current final reader DTO and DOM");
      assert.deepEqual(b.requests, a.requests, "chapter GET follows the comic GET exactly once"); comparisons += 2;
      assert.equal(scale.before.rows, count); measurements.push(scale);
      await b.page.locator('.manga-reader-bar [data-action="detail"]').press("Enter");
      await b.page.locator(".manga-directory-search-input").waitFor();
      assert.equal(await b.page.locator(".manga-chapter-row").count(), count);
      assert.equal(await b.page.locator(".manga-directory-search-input").inputValue(), "");
      assert.equal(await b.page.locator('.manga-catalog [aria-current="true"]').evaluate(node => node.closest(".manga-chapter-row").dataset.chapterIndex), String(target));
    } finally { await a.context.close(); await b.context.close(); }
  }
  await verifyFailure(next); await verifySuperseded(next); await verifyExistingView(next);
  assert.deepEqual(failures, []); console.log(JSON.stringify({ comparisons, negativeControl: negative, measurements }));
  for (const result of measurements) {
    assert.equal(result.current.rows, 0, "cold read does not build a temporary full chapter directory");
    assert.ok(result.current.created <= 64, "cold read construction stays independent of the chapter count");
  }
} finally { await browser?.close(); for (const value of surfaces) await value.close(); }

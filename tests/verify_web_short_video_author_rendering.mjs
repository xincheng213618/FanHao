import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Actual index, entry, API client, page composition, cards and complete CSS.
// Only the three complete owners vary. Instrumentation counts their actual
// renderer/createElement calls; it never assigns image src or loaded classes.
const args = process.argv.slice(2);
assert(args.every(value => value === "--legacy-author-rendering"), "known arguments");
const negative = args.includes("--legacy-author-rendering");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(project, "public");
const commit = "63c5fab243233e142cfd62c4eaf13812feb92405";
const hashes = {
  "author-pages.js": "dc9ec9acb1a42818f66f2371e90b0e55e9590e2bf9810560e16faad9d51b0c79",
  "short-video-page.js": "3197e10d5ea766087cc5ef0f34dace8a815549728e113a88e8048c678643740f",
  "list-cards.js": "ff14b18a8b4648f3f6347ed534d8eb65461b6875cef4dad7dc1ab1c0cc2e9ec3"
};
const before = {}, current = {};
for (const [name, hash] of Object.entries(hashes)) {
  const relative = `public/modules/short-videos/${name}`;
  before[name] = execFileSync("git", ["show", `${commit}:${relative}`], { cwd: project, encoding: "utf8" }).replace(/\r\n/g, "\n");
  assert.equal(crypto.createHash("sha256").update(before[name]).digest("hex"), hash, `fixed complete old ${name}`);
  current[name] = fs.readFileSync(path.join(project, relative), "utf8").replace(/\r\n/g, "\n");
}
if (negative) {
  const marker = "  function reconcileAuthorIndex(content) {";
  assert.equal(current["author-pages.js"].split(marker).length, 2, "one mounted reconcile boundary");
  current["author-pages.js"] = current["author-pages.js"].replace(marker, `${marker}\n    return null; // Controlled original whole-author-list render fallback.`);
}
const bundles = new Map();
function measureCards(source) {
  const marker = /(^  function renderAuthorIndexCard\([^\n]*\) \{)/m;
  assert.equal([...source.matchAll(new RegExp(marker.source, "gm"))].length, 1, "one actual card renderer");
  let measured = source.replace(marker, "$1\n    globalThis.__authorMetrics.cardCalls += 1;");
  const end = measured.indexOf("    return card;", measured.search(marker));
  assert(end > 0, "actual author renderer returns its native card");
  measured = measured.slice(0, end) + "    globalThis.__authorMetrics.cardElements += card.querySelectorAll('*').length + 1;\n" + measured.slice(end);
  return measured;
}
for (const [version, sources] of [["before", before], ["current", current]]) {
  const result = await build({ entryPoints: [path.join(publicRoot, "short-video-app.js")], bundle: true, write: false,
    format: "esm", platform: "browser", target: ["chrome110"], charset: "utf8", legalComments: "none",
    plugins: [{ name: "complete-owner-oracles", setup(builder) {
      builder.onLoad({ filter: /(?:author-pages|short-video-page|list-cards|short-video-app)\.js$/ }, async ({ path: file }) => {
        const name = path.basename(file);
        let source = sources[name] || await fs.promises.readFile(file, "utf8");
        if (name === "short-video-app.js") {
          const marker = "async function applyShortVideoRoute(route) {";
          assert.equal(source.split(marker).length, 2, "one real entry composition exposure");
          source = source.replace(marker, `globalThis.__authorFixture = { state, page: shortVideoPage };\n${marker}`);
        }
        if (name === "list-cards.js") source = measureCards(source);
        return { contents: source, loader: "js", resolveDir: path.dirname(file) };
      });
    } }] });
  bundles.set(version, result.outputFiles[0].text);
}

const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executablePath, "private Chromium requires Chrome or Edge");
const sessions = new Map(), unexpected = [];
let browser, base, sequence = 0, comparisons = 0;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    const session = sessions.get(req.headers["x-author-fixture"]);
    const send = (body, type = "application/json", status = 200) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body);
    };
    if (url.pathname.startsWith("/api/")) {
      assert(session, "every private API belongs to a synthetic session");
      assert.equal(req.method, "GET", "synthetic browsing is read-only");
      session.requests.push(url.pathname + url.search);
      const gate = session.gates.find(gate => !gate.used && url.pathname === gate.pathname);
      if (gate) { gate.used = true; gate.url = url; gate.respond = (body, status = 200) => send(JSON.stringify(body), "application/json", status); return; }
      return send(JSON.stringify(api(session, url)));
    }
    if (url.pathname.startsWith("/short-videos")) return send(await fs.promises.readFile(path.join(publicRoot, "index.html")), "text/html");
    if (url.pathname === "/short-video-app.min.js" && session?.version !== "disk") return send(bundles.get(session.version), "text/javascript");
    // The real page imports its cards through a runtime URL, outside esbuild's
    // static graph. Keep that complete owner in the same frozen/current variant.
    if (url.pathname === "/modules/short-videos/list-cards.js" && session?.version !== "disk") {
      return send(measureCards((session.version === "before" ? before : current)["list-cards.js"]), "text/javascript");
    }
    if (url.pathname.startsWith("/synthetic/")) {
      if (session) session.images.push(url.pathname);
      return send('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#477f72"/><circle cx="80" cy="65" r="30" fill="#efe4ce"/></svg>', "image/svg+xml");
    }
    if (url.pathname === "/favicon.ico") return send("", "image/x-icon", 204);
    const file = path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
    assert(file.startsWith(`${publicRoot}${path.sep}`), "private static stays under public");
    return send(await fs.promises.readFile(file), file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream");
  } catch (error) {
    unexpected.push(`${req.url}: ${error.message}`);
    if (!res.destroyed) { res.writeHead(500); res.end(error.message); }
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const contracts = [];
  for (const [label, scenario] of [["ordinary append, duplicate, empty EOF", ordinary], ["global author sorting and metadata fallback", sorting],
    ["following controls and request errors", controls], ["navigation, saved window and retired owners", ownership]]) {
    const expected = await run("before", scenario), actual = await run("current", scenario);
    assert.deepEqual(actual, expected, label);
    comparisons += actual.length; contracts.push({ label, snapshots: actual.length });
  }
  // This recovery intentionally improves the fixed old scope-mixing behavior;
  // assert the request and exact replacement independently of that old oracle.
  await recovery();
  const scale = await measureScale();
  const retained = negative ? null : await retention();
  const entry = await diskSmoke();
  assert.deepEqual(unexpected, [], "private entry does not contact unconfigured APIs or throw");
  console.log(JSON.stringify({ fixture: "web-short-video-author-rendering", comparisons, contracts, scale, retained, entry }, null, 2));
} finally {
  await browser?.close();
  for (const session of sessions.values()) for (const gate of session.gates) if (gate.respond && !gate.done) gate.respond({ authors: [], total: 0, hasMore: false });
  await new Promise(resolve => server.close(resolve));
}

function author(index, overrides = {}) {
  // Followed order deliberately disagrees with count/name sorting. The same
  // rows exercise both server-order following and globally sorted authors.
  return { secUid: `author-${index}`, name: `作者 ${String(index).padStart(4, "0")}`, count: 1000 + (index * 37 % 173),
    likedCount: index % 7, avatarUrl: `/synthetic/avatar-${index}.svg`, following: true,
    accountStatus: "active", accountStatusReason: "", ...overrides };
}
function range(start, count) { return Array.from({ length: count }, (_, index) => author(start + index)); }
function api(session, url) {
  if (url.pathname === "/api/modules") return { modules: [{ id: "short-videos", title: "短视频", order: 50, client: { web: { href: "/short-videos", view: "shortVideos" } } }] };
  if (url.pathname === "/api/short-videos/collections") return { collections: [], total: 0 };
  if (url.pathname === "/api/short-videos/summary") return { totals: { videos: 18000, authors: 1200, bytes: 64000000, durationMs: 3600000 }, sources: [], authors: [] };
  if (url.pathname === "/api/short-videos/authors/resolve") return { author: session.rows.find(row => row.secUid === url.searchParams.get("mention")) || null };
  if (url.pathname === "/api/short-videos/authors") {
    const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 96);
    const rows = session.rows;
    return { authors: rows.slice(offset, offset + limit), total: rows.length, scopeTotal: rows.length + 13,
      unlikedTotal: 17, bannedTotal: 2, hasMore: offset + limit < rows.length };
  }
  if (url.pathname === "/api/short-videos") return { videos: [], total: 0, hasMore: false, authors: [], source: url.searchParams.get("source") || "all" };
  if (/^\/api\/short-videos\/authors\/[^/]+\/collector$/.test(url.pathname)) return { profile: null, jobs: [], running: false };
  assert.fail(`Unexpected private API ${url.pathname}`);
}
async function open(version, source = "following", rows = range(0, 1200)) {
  const id = `s${++sequence}`;
  const session = { version, rows, requests: [], images: [], gates: [] };
  sessions.set(id, session);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-author-fixture": id }, serviceWorkers: "block" });
  const page = await context.newPage();
  page.on("pageerror", error => unexpected.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true, effectiveType: "2g" } });
    window.__authorMetrics = { cardCalls: 0, cardElements: 0, createElementCalls: 0 };
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (...args) { window.__authorMetrics.createElementCalls++; return Reflect.apply(create, this, args); };
  });
  await page.goto(`${base}/short-videos?source=${source}`, { waitUntil: "networkidle" });
  if (version !== "disk") await page.waitForFunction(() => window.__authorFixture?.state.routeReady);
  if (rows.length) await page.locator(".short-video-author-index-card").first().waitFor();
  else await page.locator(".short-video-author-index-status").first().waitFor();
  await settle(page);
  return { page, context, session };
}
async function run(version, scenario) {
  const env = await open(version);
  try { return await scenario(env); } finally { await env.context.close(); }
}
async function settle(page) {
  await page.evaluate(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function idle(page) {
  await page.waitForFunction(() => { const view = window.__authorFixture?.state.shortVideo; return view && !view.loading && !view.authorLoadingMore; });
  await settle(page);
}
async function append(page) {
  await page.evaluate(() => __authorFixture.page.loadVideos({ append: true, skipRoute: true }));
  await idle(page);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const view = __authorFixture.state.shortVideo;
    const state = JSON.parse(JSON.stringify(view));
    // Saved-window wall clock is session-local; keep its complete payload and
    // scroll position while normalizing only the independently sampled time.
    if (state.authorIndexWindow) state.authorIndexWindow.createdAt = 0;
    // The legacy implementation's generated describedby IDs change with full
    // remounts; compare the actual accessible description instead of its token.
    const cards = [...document.querySelectorAll(".short-video-author-index-card")].map(card => {
      const button = card.querySelector("button"), image = card.querySelector("img");
      return { id: button.dataset.shortVideoAuthorId || "", text: button.textContent, label: button.getAttribute("aria-label"),
        description: (button.getAttribute("aria-describedby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" "),
        image: image?.getAttribute("src") || "", alt: image?.alt || "", bannedTitle: card.querySelector(".short-video-author-index-banned")?.title || "" };
    });
    return { state, cards, stats: document.querySelector("#statsRow")?.textContent || "",
      total: document.querySelector(".short-video-home-total")?.textContent || "", heading: document.querySelector("[data-short-video-author-index-heading]")?.textContent || "",
      more: document.querySelector(".short-video-author-index-more")?.textContent || "", route: location.pathname + location.search };
  });
}
function hold(session, pathname = "/api/short-videos/authors") { const gate = { pathname, used: false, done: false }; session.gates.push(gate); return gate; }
async function waitGate(gate) { for (let i = 0; i < 100 && !gate.respond; i++) await new Promise(resolve => setTimeout(resolve, 20)); assert(gate.respond, "actual request reached synthetic response gate"); }
function release(gate, body, status = 200) { gate.done = true; gate.respond(body, status); }
async function ordinary({ page, session }) {
  const results = [await snapshot(page)];
  assert.deepEqual(results[0].cards.map(card => card.id), range(0, 96).map(row => row.secUid), "following preserves server order even when counts are nonmonotonic");
  await append(page); results.push(await snapshot(page));
  const gate = hold(session);
  const pending = append(page); await waitGate(gate);
  release(gate, { authors: [...range(0, 2), ...range(192, 4)], total: 1200, scopeTotal: 1213, unlikedTotal: 17, bannedTotal: 2, hasMore: true });
  await pending; results.push(await snapshot(page));
  assert.equal(results.at(-1).cards.length, 196, "duplicate keys do not create duplicate authors");
  const eof = hold(session); const last = append(page); await waitGate(eof);
  release(eof, { authors: [], total: 196, hasMore: false }); await last; results.push(await snapshot(page));
  assert.equal(results.at(-1).more, "");
  assert.equal(results.at(-1).state.authorScopeTotal, 196);
  return results;
}
async function sorting({ page, session }) {
  const results = [];
  await page.evaluate(() => { __authorFixture.state.shortVideo.source = "authors"; return __authorFixture.page.loadVideos({ skipRoute: true }); }); await idle(page);
  results.push(await snapshot(page));
  const gate = hold(session), pending = append(page); await waitGate(gate);
  release(gate, { authors: [author(9900, { name: "顶端", count: 99999 }), author(9901, { name: "阿", count: 3000 }), author(9902, { name: "啊", count: 3000 })], total: 99, hasMore: false });
  await pending; results.push(await snapshot(page));
  assert.equal(results.at(-1).cards[0].id, "author-9900", "new higher count sorts ahead of retained rows");
  const expected = [...results.at(-1).state.authors].sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || a.name.localeCompare(b.name, "zh-CN")).map(row => row.secUid);
  assert.deepEqual(results.at(-1).cards.map(row => row.id), expected, "ties use actual zh-CN name comparator");
  await page.evaluate(() => {
    const view = __authorFixture.state.shortVideo;
    view.authors[0] = { ...view.authors[0], name: "已更新作者", count: 200000, likedCount: 93, avatarUrl: "/synthetic/updated-avatar.svg", accountStatus: "banned", accountStatusReason: "合成封禁原因" };
    view.authorUnlikedTotal = 901; view.authorScopeTotal = 9999; __authorFixture.page.renderView({ appendAuthors: true });
  }); await settle(page); results.push(await snapshot(page));
  assert.equal(results.at(-1).cards[0].label.includes("已更新作者"), true);
  assert.equal(results.at(-1).cards[0].bannedTitle, "合成封禁原因");
  await page.evaluate(() => {
    const view = __authorFixture.state.shortVideo; view.authors[0].name = "原地更新"; view.authors[0].avatarUrl = ""; view.authors[0].fallbackCoverUrl = "/synthetic/fallback.svg";
    __authorFixture.page.renderView({ appendAuthors: true });
  }); await settle(page); results.push(await snapshot(page));
  assert.equal(results.at(-1).cards[0].image, "/synthetic/fallback.svg");
  return results;
}
async function controls({ page, session }) {
  const results = [];
  await page.locator('select[aria-label="我的关注排序"]').selectOption("count"); await idle(page); results.push(await snapshot(page));
  assert.equal(new URL(session.requests.filter(value => value.startsWith("/api/short-videos/authors?")).at(-1), base).searchParams.get("sort"), "count");
  await page.locator(".short-video-following-unliked").click(); await idle(page); results.push(await snapshot(page));
  assert.equal(results.at(-1).state.authorFilter, "unliked");
  // Real native scroll invokes the actual listener and its actual showError.
  const fail = hold(session);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await waitGate(fail);
  release(fail, { error: "synthetic append failure" }, 503); await idle(page); results.push(await snapshot(page));
  assert.equal(results.at(-1).state.status, "synthetic append failure");
  await page.evaluate(() => { scrollTo(0, 0); }); await settle(page);
  const retry = hold(session);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await waitGate(retry);
  assert.equal(retry.url.searchParams.get("offset"), "96", "ordinary append failure retains its accepted scope offset");
  release(retry, api(session, retry.url)); await idle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).cards.length, 192, "append failure retries from the unchanged offset");
  await page.evaluate(() => scrollTo(0, 0)); await settle(page);
  return results;
}
async function ownership({ page, session }) {
  const results = [];
  const gate = hold(session), pending = append(page); await waitGate(gate);
  await page.locator('.short-video-source-tab').filter({ hasText: /^作者$/ }).click(); await idle(page);
  release(gate, { authors: [author(8888)], total: 1, hasMore: false }); await pending;
  results.push(await snapshot(page));
  assert(!results.at(-1).cards.some(card => card.id === "author-8888"), "old source response cannot change current authors");
  await append(page);
  await page.evaluate(() => { window.__retiredAuthor = document.querySelector(".short-video-author-index-card-main"); });
  await page.locator(".short-video-author-index-card-main").first().press("Enter"); await idle(page);
  results.push(await snapshot(page));
  assert.match(results.at(-1).route, /\/short-videos\/authors\/author-/);
  await page.locator(".short-video-author-page-back").click(); await idle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).cards.length, 192, "Back restores the loaded author window");
  return results;
}
async function recovery() {
  for (const oldCount of [96, 0]) {
    const { page, context, session } = await open("current", "following", range(0, oldCount));
    try {
      assert.equal((await snapshot(page)).state.authorHasMore, false, "old scope is already at EOF");
      const gate = hold(session);
      if (oldCount) await page.locator('select[aria-label="我的关注排序"]').selectOption("count");
      else {
        // Use the actual author-index form (suggestions are disabled by the
        // product), including its commit/search/load/showError chain.
        await page.locator('input[aria-label="搜索我的关注作者"]').fill("Fresh");
        await page.locator('input[aria-label="搜索我的关注作者"]').press("Enter");
      }
      await waitGate(gate);
      assert.equal(gate.url.searchParams.get("offset"), "0");
      if (!oldCount) assert.equal(gate.url.searchParams.get("q"), "Fresh");
      release(gate, { error: "new scope first page failed" }, 503); await idle(page);
      const retry = page.locator("button.short-video-author-index-more"); await retry.waitFor();
      if (!oldCount) assert.match(await page.locator(".short-video-author-index").textContent(), /读取失败，请重试读取作者/);
      const count = session.requests.length;
      await page.evaluate(() => { scrollTo(0, document.documentElement.scrollHeight); dispatchEvent(new Event("scroll")); }); await settle(page);
      assert.equal(session.requests.length, count, "failed first page does not auto-retry on scrolling");
      const failedAgain = hold(session); await retry.click(); await waitGate(failedAgain);
      assert.equal(failedAgain.url.searchParams.get("offset"), "0", "repeated first-page failure never appends the old scope");
      release(failedAgain, { error: "first page failed again" }, 503); await idle(page);
      const fresh = range(oldCount ? 5000 : 6000, 96).map(row => oldCount ? row : { ...row, name: `Fresh ${row.name}` }); session.rows = fresh;
      await retry.click(); await idle(page);
      const request = new URL(session.requests.filter(value => value.startsWith("/api/short-videos/authors?")).at(-1), base);
      assert.equal(request.searchParams.get("offset"), "0", "failed scope retries first page, independent of old EOF/empty state");
      assert.deepEqual((await snapshot(page)).cards.map(card => card.id), fresh.map(row => row.secUid), "successful retry replaces all old-scope IDs");
      comparisons++;
    } finally { await context.close(); }
  }
}
async function measureScale() {
  const result = {};
  for (const version of ["before", "current"]) {
    const { page, context } = await open(version);
    try {
      const counts = [];
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => { __authorMetrics.cardCalls = 0; __authorMetrics.cardElements = 0; __authorMetrics.createElementCalls = 0; });
        const start = performance.now(); await append(page);
        counts.push({ ...await page.evaluate(() => ({ ...__authorMetrics })), instrumentedRoundTripMs: performance.now() - start });
      }
      result[version] = { cardCalls: counts.reduce((sum, item) => sum + item.cardCalls, 0), cardElements: counts.reduce((sum, item) => sum + item.cardElements, 0), createElementCalls: counts.reduce((sum, item) => sum + item.createElementCalls, 0), tail: counts.at(-1), cards: await page.locator(".short-video-author-index-card").count() };
    } finally { await context.close(); }
  }
  const authors = {};
  for (const version of ["before", "current"]) {
    const { page, context } = await open(version, "authors");
    try {
      await page.evaluate(() => { __authorMetrics.cardCalls = 0; __authorMetrics.cardElements = 0; __authorMetrics.createElementCalls = 0; });
      for (let i = 0; i < 3; i++) await append(page);
      authors[version] = { ...await page.evaluate(() => ({ ...__authorMetrics })), cards: await page.locator(".short-video-author-index-card").count() };
    } finally { await context.close(); }
  }
  result.authors = authors;
  assert.equal(result.before.cards, 1056); assert.equal(result.current.cards, 1056);
  assert.equal(result.before.cardCalls, 11520, "old complete owner really remounts both loading and completion windows");
  assert.equal(result.current.cardCalls, 960, "ten pages create only their 960 new author cards");
  assert.equal(result.current.tail.cardCalls, 96, "last append creates only its new page");
  assert.equal(result.current.cardElements, 960 * 7, "native author-card descendants, including images, are created only for new rows");
  assert(result.current.createElementCalls < result.before.createElementCalls / 5, "native createElement budget retains controls and existing author cards");
  assert.equal(authors.before.cards, 384); assert.equal(authors.current.cards, 384);
  assert.equal(authors.before.cardCalls, 1440, "old author mode remounts both accumulated windows");
  assert.equal(authors.current.cardCalls, 288, "three sorted author pages create only their 288 new cards");
  return result;
}
async function decodeVisible(page) {
  await page.waitForFunction(() => [...document.querySelectorAll(".short-video-author-index-card img")].filter(image => {
    const box = image.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0;
  }).every(image => image.getAttribute("src") && image.complete && image.naturalWidth > 0));
  return page.evaluate(async () => {
    const images = [...document.querySelectorAll(".short-video-author-index-card img")].filter(image => { const box = image.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; });
    await Promise.all(images.map(image => image.decode())); return images.length;
  });
}
async function retention() {
  const { page, context, session } = await open("current");
  try {
    const decoded = await decodeVisible(page); assert(decoded > 0, "native visible avatars really decoded");
    await page.evaluate(() => {
      window.__remembered = { wrap: document.querySelector(".short-video-author-index"), card: document.querySelector(".short-video-author-index-card"),
        image: document.querySelector(".short-video-author-index-card img"), button: document.querySelector(".short-video-author-index-card-main"), toolbar: document.querySelector(".short-video-home-toolbar") };
      __remembered.button.focus({ preventScroll: true }); scrollTo(0, 240);
    }); await settle(page);
    const top = await page.evaluate(() => scrollY); await append(page);
    const retained = await page.evaluate(() => ({ wrap: __remembered.wrap === document.querySelector(".short-video-author-index"),
      card: __remembered.card === document.querySelector(".short-video-author-index-card"), image: __remembered.image === document.querySelector(".short-video-author-index-card img"),
      focus: document.activeElement === __remembered.button, scroll: scrollY, decoded: __remembered.image.complete && __remembered.image.naturalWidth > 0 }));
    assert.deepEqual(retained, { wrap: true, card: true, image: true, focus: true, scroll: top, decoded: true });
    // Connected shell may remain while its source owner changes. Retired card
    // events must not open an author or issue any API work in the new scope.
    await page.locator('.short-video-source-tab').filter({ hasText: /^作者$/ }).click(); await idle(page);
    const beforeRequests = session.requests.length, beforeRoute = page.url();
    await page.evaluate(() => __remembered.button.click()); await settle(page);
    assert.equal(page.url(), beforeRoute); assert.equal(session.requests.length, beforeRequests);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-web-authors-")), screenshotPath = path.join(folder, "web-authors-1280x900.png");
    await page.evaluate(() => scrollTo(0, 0)); await settle(page); await decodeVisible(page); await page.screenshot({ path: screenshotPath });
    return { visibleDecodedAvatars: decoded, ...retained, screenshotPath };
  } finally { await context.close(); }
}
async function diskSmoke() {
  const { page, context, session } = await open("disk");
  try {
    const decoded = await decodeVisible(page); assert(decoded > 0);
    await page.evaluate(() => { window.__diskFirst = document.querySelector(".short-video-author-index-card img"); scrollTo(0, document.documentElement.scrollHeight); });
    await page.waitForFunction(() => document.querySelectorAll(".short-video-author-index-card").length >= 192);
    await settle(page);
    assert(session.requests.some(value => value.includes("/authors?") && value.includes("offset=96")), "unmodified actual index and on-disk entry wire native append");
    assert(await page.evaluate(() => __diskFirst === document.querySelector(".short-video-author-index-card img")), "on-disk bundle retains the decoded initial avatar node");
    return { cards: await page.locator(".short-video-author-index-card").count(), decoded, authorRequests: session.requests.filter(value => value.startsWith("/api/short-videos/authors?")).length };
  } finally { await context.close(); }
}

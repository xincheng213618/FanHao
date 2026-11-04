import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright-core";

// Full Android index/app/registry/adapters and real DOM/IO/image/cache owners.
// The private server supplies synthetic JSON/SVG only; no real service is used.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(project, "android-client/www");
const before = "63c5fab243233e142cfd62c4eaf13812feb92405";
const hashes = {
  "/app.js": "a788da62ffd3e3e32ad017cf273907be590cb3bc6d38a5efac9e9a4c2883df0c",
  "/platform/content-index/channel-views.js": "4a3f39235df9a112a445684b6dae7d94bafc7d873f75166212448858488c0f63"
};
const oldSources = {}, currentSources = {};
for (const [url, hash] of Object.entries(hashes)) {
  oldSources[url] = execFileSync("git", ["show", `${before}:android-client/www${url}`], { cwd: project, encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(oldSources[url]).digest("hex"), hash);
  currentSources[url] = fs.readFileSync(path.join(www, url), "utf8").replaceAll("\r\n", "\n");
}
assert.ok(process.argv.slice(2).every(value => value === "--legacy-host-reset"));
const negative = process.argv.includes("--legacy-host-reset");
if (negative) {
  const condition = "!preserveShortVideoHome && !preserveMangaLibraryActions && !preserveChannelList";
  assert.equal(currentSources["/app.js"].split(condition).length, 3);
  // Keep request/mount/focus ownership; disable only the host DOM retention.
  currentSources["/app.js"] = currentSources["/app.js"].replaceAll(condition, "!preserveShortVideoHome && !preserveMangaLibraryActions");
}
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert.ok(executablePath, "installed Chrome or Edge required");
let browser, sequence = 0, comparisons = 0;
const surfaces = [], failures = [];
function item(index, prefix = "") {
  return { id: `${prefix}movie-${String(index).padStart(5, "0")}`, type: "media", mediaKind: "movie", title: `合成影片 ${index}`,
    category: "Synthetic", year: "2026", size: 1000000 + index, updatedAt: "2026-11-05T00:00:00Z",
    coverUrl: `/synthetic/${prefix}cover-${index}.svg`, movieMetadata: { title: `合成影片 ${index}`, year: "2026", rating: 7.5, genres: ["合成"] } };
}
function startup() {
  localStorage.setItem("fanhao.serverUrl", location.origin);
  localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "channel", params: { mode: "movie" } }));
  window.__channelAudit = { realm: crypto.randomUUID(), host: null, updateServer: null, readers: [], cards: new WeakMap(), createdCards: 0, elements: 0, scrollWrites: [] };
  const create = document.createElement;
  document.createElement = function (...args) { __channelAudit.elements++; return create.apply(this, args); };
  const fetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => fetch(input, __channelAudit.ignoreAbort ? { ...options, signal: undefined } : options);
  const scroll = window.scrollTo;
  window.scrollTo = function (...args) { __channelAudit.scrollWrites.push(args); return scroll.apply(this, args); };
}
function instrument(source, url) {
  if (url === "/app.js") {
    const marker = "function createAndroidModuleHost() {\n  return Object.freeze({";
    assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, "function createAndroidModuleHost() {\n  window.__channelAudit.updateServer = updateServer;\n  return window.__channelAudit.host = Object.freeze({");
  } else {
    const marker = "export function createChannelViews(context) {";
    assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, `${marker}\n  window.__channelAudit.readers.push(() => ({ page: channelPageState, mounted: mountedChannelList }));`);
    const create = "  function createChannelCard(mode, item, options = {}) {";
    assert.equal(source.split(create).length, 2);
    source = source.replace(create, `${create}\n    window.__channelAudit.createdCards++;`);
    const card = "    card.className = `channel-card ${mode}`;";
    assert.equal(source.split(card).length, 2);
    source = source.replace(card, `${card}\n    window.__channelAudit.cards.set(card, item);`);
  }
  return source;
}
async function surface(sources) {
  const cases = new Map(), pending = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), f = cases.get(req.headers["x-fixture-case"]);
    const send = (body, type = "application/json", status = 200) => {
      if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); }
    };
    try {
      const apiPath = url.pathname.replace(/^\/source-two/, "");
      if (apiPath.startsWith("/api/")) {
        assert.ok(f); assert.equal(req.method, "GET");
        const record = { path: apiPath, query: Object.fromEntries(url.searchParams), rows: 0 };
        f.requests.push(record);
        let payload = {};
        if (apiPath === "/api/image-library/items") {
          const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 720);
          let items = url.pathname.startsWith("/source-two") ? f.items.map(value => ({ ...value, id: `source2-${value.id}` })) : f.items;
          if (url.searchParams.get("q")) items = items.filter(value => value.title.includes(url.searchParams.get("q")));
          if (url.searchParams.get("sort") === "title") items = [...items].sort((a, b) => a.title.localeCompare(b.title));
          const mode = url.searchParams.get("mode") || "movie";
          if (mode === "photo") items = items.map(value => ({ ...value, type: "photo", imageCount: 2 }));
          payload = { mode, items: items.slice(offset, offset + limit), total: items.length, nextOffset: Math.min(items.length, offset + limit),
            listRevision: f.revision, sort: url.searchParams.get("sort") || "updated", query: url.searchParams.get("q") || "", photoView: "albums", facets: {} };
          record.rows = payload.items.length;
        } else if (apiPath === "/api/library") payload = { people: [], works: [], totals: { people: 0, works: 0, videos: 0, infoFiles: 0 }, user: { favorites: [], historyCount: 0 }, availableRoots: [], access: { mode: "loopback" } };
        else if (apiPath === "/api/modules") payload = { modules: [] };
        else if (apiPath === "/api/accounts/status") payload = { user: f.accountId ? { id: f.accountId, username: "Synthetic" } : null, registrationEnabled: true, accountLoginRequired: false };
        else if (apiPath === "/api/auth/status") payload = { authenticated: Boolean(f.accountId), user: f.accountId ? { id: f.accountId, username: "Synthetic" } : null };
        else if (apiPath === "/api/history") payload = { works: [], total: 0 };
        else if (apiPath === "/api/favorites/folders") payload = { folders: [] };
        else if (apiPath === "/api/system/control") payload = { ok: true, platform: "unsupported", actions: [] };
        else if (apiPath === "/api/android/update") payload = { available: false, versionCode: 0 };
        else if (apiPath.endsWith("/summary")) payload = { totals: {}, items: [], channels: [] };
        else if (apiPath.startsWith("/api/gallery-media/")) payload = { item: f.items.find(value => value.id === decodeURIComponent(apiPath.split("/").at(-1))) || item(0) };
        else failures.push(`unexpected API ${url.pathname}`);
        const gate = f.holds.find(value => !value.used && value.match(url));
        if (gate) { gate.used = true; pending.add(gate); gate.requested(); await gate.promise; pending.delete(gate); if (gate.error) return send(JSON.stringify({ error: gate.error }), "application/json", 503); }
        return send(JSON.stringify(payload));
      }
      if (apiPath.startsWith("/synthetic/")) { f?.covers.push(apiPath); return send('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="340"><rect width="240" height="340" fill="#759477"/></svg>', "image/svg+xml"); }
      if (url.pathname === "/favicon.ico") return send("", "image/x-icon", 204);
      const relative = url.pathname === "/" ? "/index.html" : url.pathname;
      const target = path.resolve(www, `.${relative}`); assert.ok(target.startsWith(`${www}${path.sep}`));
      let body = sources[relative] ? instrument(sources[relative], relative) : fs.readFileSync(target);
      if (relative === "/index.html") body = body.toString().replace("<head>", `<head><script>(${startup.toString()})()</script>`);
      send(body, relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : relative.endsWith(".html") ? "text/html" : "application/octet-stream");
    } catch (error) { failures.push(`${url.pathname}: ${error.message}`); send(error.message, "text/plain", 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = { base, async open(count = 12000) {
    const id = `case-${++sequence}`, f = { id, items: Array.from({ length: count }, (_, index) => item(index)), requests: [], covers: [], holds: [], revision: "synthetic-stable" };
    cases.set(id, f);
    f.context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, extraHTTPHeaders: { "X-Fixture-Case": id } });
    f.page = await f.context.newPage(); f.page.on("pageerror", error => failures.push(error.message));
    await f.page.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
    await f.page.goto(base, { waitUntil: "networkidle" }); await ready(f.page, Math.min(720, count)); return f;
  }, async close() { for (const gate of pending) gate.release(); await new Promise(resolve => server.close(resolve)); } };
  surfaces.push(result); return result;
}
function hold(f, match, error = "") {
  let release, requested;
  const gate = { match, error, used: false, promise: new Promise(resolve => { release = resolve; }), request: new Promise(resolve => { requested = resolve; }) };
  gate.release = release; gate.requested = requested; f.holds.push(gate); return gate;
}
async function ready(page, count) {
  await page.waitForFunction(count => document.querySelectorAll("#viewContent .channel-card").length === count &&
    !document.querySelector("#viewContent .channel-more:disabled"), count, { timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function snapshot(page) {
  return page.evaluate(() => {
    const active = __channelAudit.readers.map(read => read()).find(value => value.mounted?.list?.isConnected);
    return { view: __channelAudit.host.navigation.currentView(), params: __channelAudit.host.navigation.currentParams(), data: active?.page?.data,
      title: document.querySelector("#viewTitle").textContent, meta: document.querySelector("#viewMeta").textContent,
      cards: [...document.querySelectorAll("#viewContent .channel-card")].map(node => ({ item: __channelAudit.cards.get(node), text: node.querySelector(".channel-summary")?.textContent, aria: node.getAttribute("aria-label"), className: node.className })),
      controls: [...document.querySelectorAll("#viewContent > :not(.channel-list):not(.photo-masonry-list):not(.channel-more)")].map(node => node.textContent), more: document.querySelector("#viewContent .channel-more")?.textContent || "" };
  });
}
async function more(f, count) { await f.page.evaluate(() => document.querySelector("#viewContent .channel-more").click()); await ready(f.page, count); }
function compare(actual, expected, label) { assert.ok(isDeepStrictEqual(actual, expected), label); comparisons++; }
async function saveNodes(page) {
  await page.evaluate(() => { __channelAudit.oldCard = document.querySelector("#viewContent .channel-card"); __channelAudit.oldMore = document.querySelector("#viewContent .channel-more"); __channelAudit.oldControls = document.querySelector("#viewContent .channel-filter-wrap"); });
}
async function verifyFailure(surface) {
  const f = await surface.open(2160);
  try {
    const gate = hold(f, url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "720", "Synthetic offline");
    await saveNodes(f.page); await f.page.evaluate(() => document.querySelector("#viewContent .channel-more").focus({ preventScroll: true }));
    await f.page.keyboard.press("Enter"); await gate.request;
    assert.equal(await f.page.locator("#viewContent .channel-card").count(), 720); gate.release();
    await f.page.waitForFunction(() => document.querySelector("#viewContent .channel-more")?.textContent.includes("重试"));
    assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector("#viewContent .channel-more")), true);
    await more(f, 1440);
    const reads = f.requests.filter(value => value.path === "/api/image-library/items");
    assert.deepEqual(reads.map(value => [value.query.offset, value.query.limit]), [["0", "720"], ["720", "720"], ["720", "720"]]);
    assert.equal((await snapshot(f.page)).cards.at(-1).item.id, "movie-01439");
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
}
async function settleViewport(page) {
  return page.evaluate(async () => {
    const node = document.elementFromPoint(95, 450)?.closest(".channel-card"); if (!node) throw new Error("visible native card required");
    __channelAudit.anchorId = __channelAudit.cards.get(node).id;
    let last, stable = 0;
    for (let frame = 0; frame < 60 && stable < 3; frame++) { await new Promise(requestAnimationFrame); const rect = node.getBoundingClientRect(), next = [scrollY, rect.top, rect.height]; stable = last && next.every((value, index) => Math.abs(value - last[index]) < .25) ? stable + 1 : 0; last = next; }
    return { y: scrollY, top: node.getBoundingClientRect().top, stable };
  });
}
async function verifyNative(surface) {
  const f = await surface.open(2160);
  try {
    await f.page.waitForFunction(() => { const img = document.querySelector("#viewContent .channel-card img"); return img?.complete && img.naturalWidth > 0; });
    await saveNodes(f.page); await f.page.evaluate(() => { __channelAudit.oldImage = __channelAudit.oldCard.querySelector("img"); window.scrollTo({ top: 5000, behavior: "auto" }); });
    const position = await settleViewport(f.page); assert.equal(position.stable, 3);
    // Focus without moving the viewport; trusted keyboard activation still
    // runs the native button and complete real host/registry route.
    await f.page.evaluate(() => document.querySelector("#viewContent .channel-more").focus({ preventScroll: true }));
    await f.page.keyboard.press("Enter"); await ready(f.page, 1440);
    const after = await f.page.evaluate(() => { const node = [...document.querySelectorAll("#viewContent .channel-card")].find(node => __channelAudit.cards.get(node).id === __channelAudit.anchorId); return { y: scrollY, top: node.getBoundingClientRect().top,
      focus: document.activeElement === document.querySelector("#viewContent .channel-more"), card: __channelAudit.oldCard === document.querySelector("#viewContent .channel-card"), image: __channelAudit.oldImage === document.querySelector("#viewContent .channel-card img") }; });
    assert.equal(after.focus, true); assert.ok(Math.abs(after.y - position.y) <= 2); assert.ok(Math.abs(after.top - position.top) <= 2);
    await f.page.locator("#viewContent .channel-card").nth(720).scrollIntoViewIfNeeded();
    await f.page.waitForFunction(() => { const img = document.querySelectorAll("#viewContent .channel-card")[720]?.querySelector("img"); return img?.complete && img.naturalWidth > 0; });
    assert.ok(f.covers.includes("/synthetic/cover-720.svg"));
    await f.page.evaluate(() => document.querySelector("#viewContent .channel-more").focus({ preventScroll: true }));
    await f.page.keyboard.press("Space"); await ready(f.page, 2160);
    assert.equal(await f.page.evaluate(() => __channelAudit.cards.get(document.activeElement)?.id), "movie-02159", "EOF focuses the actual final card");
    return after;
  } finally { await f.context.close(); }
}
async function verifyRetirement(surface) {
 for (const change of ["query", "sort", "source"]) {
  const f = await surface.open(2160);
  try {
    await saveNodes(f.page); await f.page.evaluate(() => { __channelAudit.ignoreAbort = true; });
    const gate = hold(f, url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "720");
    const clientRequest = f.page.waitForRequest(request => { const url = new URL(request.url()); return url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "720"; });
    await f.page.evaluate(() => document.querySelector("#viewContent .channel-more").click()); await gate.request;
    const oldRequest = await clientRequest;
    const retiredRequest = Promise.race(["requestfinished", "requestfailed"].map(event => f.page.waitForEvent(event, { predicate: request => request === oldRequest, timeout: 10000 })));
    await f.page.evaluate(({ change, base }) => {
      if (change === "source") { __channelAudit.updateServer(`${base}/source-two`); __channelAudit.host.ui.renderCurrentView(); }
      else __channelAudit.host.navigation.showView("channel", { mode: "movie", ...(change === "query" ? { query: "合成影片 1" } : { sort: "title" }) });
    }, { change, base: surface.base }); await ready(f.page, 720);
    const state = await snapshot(f.page), requests = f.requests.length;
    await f.page.evaluate(() => { const holder = document.createElement("div"); holder.hidden = true; document.querySelector("#viewContent").parentElement.append(holder); holder.append(__channelAudit.oldCard, __channelAudit.oldMore, __channelAudit.oldControls); __channelAudit.oldCard.click(); __channelAudit.oldMore.click(); __channelAudit.oldControls.querySelector("button")?.click(); });
    assert.equal(await f.page.evaluate(() => [__channelAudit.oldCard, __channelAudit.oldMore, __channelAudit.oldControls].every(node => node.isConnected)), true);
    gate.release(); await retiredRequest;
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(f.requests.length, requests, "retired connected controls issue no request"); compare(await snapshot(f.page), state, `old ${change} controls and ignored-abort reply cannot own the new page`);
    await f.page.evaluate(() => __channelAudit.host.navigation.showView("channel", { mode: "movie" })); await ready(f.page, 720);
    assert.notEqual(await f.page.evaluate(() => document.querySelector("#viewContent .channel-card") === __channelAudit.oldCard), true, "explicit route reload rebuilds its presentation");
    console.log(`PASS mounted ${change} retirement and full route reset`);
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
 }
}

async function verifyPhotoAdapter(surface) {
  const f = await surface.open(1440);
  try {
    await f.page.evaluate(() => __channelAudit.host.navigation.showView("channel", { mode: "photo", photoView: "albums" })); await ready(f.page, 160);
    await saveNodes(f.page); await more(f, 320);
    assert.equal((await snapshot(f.page)).cards.at(-1).item.id, "movie-00319");
    assert.equal(await f.page.evaluate(() => __channelAudit.oldCard === document.querySelector("#viewContent .channel-card")), true, "photo adapter preserves the same mounted masonry presentation");
    assert.equal(await f.page.locator("#viewContent .photo-masonry-column").count(), 2);
    comparisons++;
  } finally { await f.context.close(); }
}

async function verifyAccount(surface) {
  const f = await surface.open(2160);
  try {
    const previousRealm = await f.page.evaluate(() => __channelAudit.realm);
    const installAuth = () => { globalThis.Capacitor = { Plugins: { FanHaoAuth: {
      getSession: async () => ({ token: localStorage.getItem("synthetic.fixture.session") || "" }),
      loginAccount: async () => { localStorage.setItem("synthetic.fixture.session", "usr.synthetic_A"); return { token: "usr.synthetic_A" }; }
    } } }; };
    await f.context.addInitScript(installAuth); await f.page.evaluate(installAuth);
    await f.page.evaluate(() => { __channelAudit.ignoreAbort = true; });
    const gate = hold(f, url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "720");
    await f.page.evaluate(() => document.querySelector("#viewContent .channel-more").click()); await gate.request;
    f.accountId = "syntheticA"; f.items = f.items.map(value => ({ ...value, id: `accountA-${value.id}` }));
    const navigation = f.page.waitForNavigation({ waitUntil: "networkidle" });
    const authenticate = f.page.evaluate(async () => { const { authenticateAccount } = await import("/js/server-auth.js"); const { fetchJson } = await import("/js/api.js"); await authenticateAccount(location.origin, "login", { username: "Synthetic" }); await fetchJson(location.origin, "/api/accounts/status"); }).catch(error => { assert.match(error.message, /Execution context was destroyed|navigation/); });
    await Promise.all([navigation, authenticate]); await ready(f.page, 720);
    assert.notEqual(await f.page.evaluate(() => __channelAudit.realm), previousRealm, "account reload destroys the preceding JavaScript realm");
    const current = await snapshot(f.page); assert.ok(current.cards.every(row => row.item.id.startsWith("accountA-")));
    // The old document was destroyed, so no old continuation can publish.
    // Releasing this server gate is cleanup, not evidence of client consumption.
    gate.release();
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    compare(await snapshot(f.page), current, "account-owner reload cannot retain the previous owner's held page");
    console.log("PASS account reload retires its preceding request realm");
  } finally { for (const gate of f.holds) gate.release(); await f.context.close(); }
}

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const oldSurface = await surface(oldSources), nextSurface = await surface(currentSources);
  const old = await oldSurface.open(), next = await nextSurface.open();
  try {
    compare(await snapshot(next.page), await snapshot(old.page), "complete initial channel DTO/DOM/header");
    for (let page = 2; page <= 10; page++) { await more(old, page * 720); await more(next, page * 720); compare(await snapshot(next.page), await snapshot(old.page), `complete channel page ${page}`); }
    const stats = async f => ({ ...(await f.page.evaluate(() => ({ cards: __channelAudit.createdCards, elements: __channelAudit.elements }))), api: f.requests.filter(value => value.path === "/api/image-library/items") });
    const scale = { before: await stats(old), current: await stats(next) };
    compare(scale.current.api, scale.before.api, "network retains true offset page requests");
    console.log(JSON.stringify({ comparisons, negativeControl: negative, scale }));
    assert.equal(scale.before.cards, 39600); assert.equal(scale.current.cards, 7200, "actual host creates only each new page's cards");
    assert.ok(scale.current.elements < 60000, "actual host DOM work remains proportional to accepted rows");
    await verifyFailure(nextSurface); await verifyRetirement(nextSurface); await verifyPhotoAdapter(nextSurface); await verifyAccount(nextSurface); const native = await verifyNative(nextSurface);
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ comparisons, native }));
    assert.equal(native.card, true); assert.equal(native.image, true);
  } finally { await old.context.close(); await next.context.close(); }
} finally { await browser?.close(); for (const value of surfaces) await value.close(); }

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright-core";

// Actual Android index/app/adapter/factories, native DOM/IO/images and full CSS.
// Only loopback synthetic API/SVG responses and observational counters are used.
// Prefix GETs still return 10,080 rows; the budget concerns card construction.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(project, "android-client", "www");
const BEFORE = "63c5fab243233e142cfd62c4eaf13812feb92405";
const owners = {
  "/modules/fanhao/work-views.js": "4355a1cd220c8c81ba628978f6c8f63b6e6973ad06affa528ff42e2e8a3ffb5a",
  "/modules/fanhao/features/works/cards.js": "71bc3246937a731d2b3020c3e7c26b75aeb5c31aa5d520a724db6fdb070c1990",
  "/modules/fanhao/android-module.js": "818ad6278af708a04de8e655896c2db6b760298913b6c9071c053529812c0c79",
  "/js/auto-load.js": "06cc19e44fdb59d9fdd559ff9690f7969a07ae0898a61f6cb9ea309a4375c6f4"
};
assert.ok(process.argv.slice(2).every(value => value === "--legacy-dom-reuse"));
const negative = process.argv.includes("--legacy-dom-reuse");
const frozen = {}, candidate = {};
for (const [url, hash] of Object.entries(owners)) {
  const relative = `android-client/www${url}`;
  frozen[url] = execFileSync("git", ["show", `${BEFORE}:${relative}`], { cwd: project, encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(frozen[url]).digest("hex"), hash, `fixed complete ${relative}`);
  candidate[url] = fs.readFileSync(path.join(www, url), "utf8").replaceAll("\r\n", "\n");
}
if (negative) {
  const marker = "  function appendMountedAllWorks(owner, data, cacheEntry = null) {";
  assert.equal(candidate["/modules/fanhao/work-views.js"].split(marker).length, 2, "one actual DOM reuse fallback boundary");
  candidate["/modules/fanhao/work-views.js"] = candidate["/modules/fanhao/work-views.js"].replace(marker, `${marker}\n    return false; // Controlled full-render fallback.`);
}
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert.ok(executablePath, "the private native browser fixture requires installed Chrome or Edge");
const failures = [], surfaces = [];
let browser, sequence = 0, comparisons = 0;
function work(index, overrides = {}) {
  const id = `work-${String(index).padStart(5, "0")}`;
  return { id, title: `合成作品 ${String(index).padStart(5, "0")}`, directoryName: `SYN-${index}`, personId: `person-${index % 20}`, personName: `合成人物 ${index % 20}`,
    relativePath: `Synthetic/${id}`, videoCount: 1, playableCount: index % 2 === 0 ? 1 : 0, imageCount: 2, infoCount: 1, videoSize: 1000000 + index,
    modifiedAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(), coverId: `cover-${index}`, favorite: index % 4 === 0,
    progress: index % 3 === 0 ? { position: 25, duration: 100, updatedAt: "2026-01-01", videoId: `video-${index}` } : null,
    infoSummary: { code: `SYN-${index}`, title: `完整合成标题 ${index}`, rating: 4.2, ratingCount: 100 + index, releaseDate: "2026-01-01", durationMinutes: 120,
      tags: ["合成", index % 2 ? "普通" : "可播"], description: "Synthetic metadata ".repeat(8) }, videos: [], images: [], infos: [], ...overrides };
}
const pool = count => Array.from({ length: count }, (_, index) => work(index));
function instrument(source, url) {
  if (url === "/modules/fanhao/work-views.js") {
    const start = "export function createWorkViews(context) {";
    assert.equal(source.split(start).length, 2);
    source = source.replace(start, `${start}\n  window.__worksAudit.context = context;`);
    const returned = "  return {\n    renderAllWorks,";
    assert.equal(source.split(returned).length, 2);
    source = source.replace(returned, "  return window.__worksAudit.api = {\n    renderAllWorks,");
  }
  if (url === "/modules/fanhao/features/works/cards.js") {
    const map = "  const cardWorks = new WeakMap();", create = "  function createWorkCard(work, options = {}) {";
    assert.equal(source.split(map).length, 2); assert.equal(source.split(create).length, 2);
    source = source.replace(map, `${map}\n  window.__worksAudit.cardWorks = cardWorks;`)
      .replace(create, `${create}\n    window.__worksAudit.createdCards++;`);
  }
  return source;
}
function startupScript() {
  localStorage.setItem("fanhao.serverUrl", location.origin);
  localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "works", params: {} }));
  window.__worksAudit = { createdCards: 0, createElementCalls: 0, context: null, api: null, cardWorks: null };
  const create = document.createElement;
  document.createElement = function (...args) { __worksAudit.createElementCalls++; return create.apply(this, args); };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => nativeFetch(input, __worksAudit.ignoreAbort ? { ...options, signal: undefined } : options);
}
async function surface(code) {
  const cases = new Map(), pending = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), id = req.headers["x-fixture-case"];
    const fixture = cases.get(id);
    const send = (body, type = "application/json", status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body);
    };
    try {
      if (url.pathname.startsWith("/api/")) {
        assert.ok(fixture, "API requests belong to a private fixture case"); assert.equal(req.method, "GET");
        const record = { path: url.pathname, query: Object.fromEntries(url.searchParams), owner: req.headers["x-fanhao-account-owner"] || "", rows: 0 };
        fixture.requests.push(record);
        let payload;
        if (url.pathname === "/api/works") {
          let works = fixture.works;
          const filter = url.searchParams.get("filter") || "all", sort = url.searchParams.get("sort") || "updated";
          if (filter === "playable") works = works.filter(item => item.playableCount > 0);
          if (filter === "progress") works = works.filter(item => item.progress);
          works = [...works].sort(sort === "title" ? (a, b) => a.title.localeCompare(b.title)
            : sort === "ratingDesc" ? (a, b) => (b.infoSummary?.rating || 0) - (a.infoSummary?.rating || 0) || a.title.localeCompare(b.title)
              : (a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)) || a.title.localeCompare(b.title));
          const limit = Number(url.searchParams.get("limit") || 48), offset = Number(url.searchParams.get("offset") || 0);
          payload = { works: works.slice(offset, offset + limit), total: works.length, count: Math.max(0, Math.min(limit, works.length - offset)), limit, offset,
            hasMore: offset + limit < works.length, facets: { all: works.length, playable: works.filter(item => item.playableCount > 0).length, progress: works.filter(item => item.progress).length } };
          record.rows = payload.works.length;
        } else if (/^\/api\/works\/[^/]+$/.test(url.pathname)) {
          const item = fixture.works.find(item => item.id === decodeURIComponent(url.pathname.split("/").at(-1))) || work(0);
          payload = { work: { ...item, infoMetadata: { title: item.title, tags: [], fields: [], rawText: "Synthetic detail" } }, person: null };
        } else if (/^\/api\/works\/[^/]+\/move-job$/.test(url.pathname)) payload = { job: null };
        else if (url.pathname === "/api/library") payload = { people: [], works: [], totals: { people: 0, videos: fixture.works.length, works: fixture.works.length, infoFiles: fixture.works.length },
          user: { historyCount: 0, favorites: [] }, availableRoots: [], access: { mode: "loopback" } };
        else if (url.pathname === "/api/modules") payload = { modules: [] };
        else if (url.pathname === "/api/accounts/status") payload = { user: fixture.accountId ? { id: fixture.accountId, username: "Synthetic" } : null, registrationEnabled: true, invitationRequired: true, accountLoginRequired: false, setupAvailable: false };
        else if (url.pathname === "/api/history") payload = { works: [], total: 0 };
        else if (url.pathname === "/api/favorites/folders") payload = { folders: [] };
        else if (url.pathname === "/api/system/control") payload = { ok: true, platform: "unsupported", actions: [] };
        else if (url.pathname === "/api/android/update") payload = { available: false, versionCode: 0 };
        else if (url.pathname.endsWith("/summary")) payload = { totals: {}, items: [], channels: [] };
        else { failures.push(`Unexpected synthetic API ${url.pathname}`); payload = {}; }
        const hold = fixture.holds.find(item => !item.used && item.match(url));
        if (hold) {
          hold.used = true; hold.requested(record); pending.add(hold);
          await hold.gate; pending.delete(hold);
          if (hold.error) return send(JSON.stringify({ error: hold.error, retryable: true }), "application/json", 503);
        }
        record.payload = payload;
        return send(JSON.stringify(payload));
      }
      if (url.pathname.startsWith("/media/image/")) {
        fixture?.covers.push(url.pathname);
        return send('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="340"><rect width="240" height="340" fill="#759477"/></svg>', "image/svg+xml");
      }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const relative = url.pathname === "/" ? "/index.html" : url.pathname;
      const target = path.resolve(www, `.${relative}`);
      assert.ok(target.startsWith(`${www}${path.sep}`), "all static files stay in the Android source root");
      let body = code[relative] ?? fs.readFileSync(target);
      if (code[relative]) body = instrument(body, relative);
      if (relative === "/index.html") body = body.toString().replace("<head>", `<head><script>(${startupScript.toString()})()</script>`);
      return send(body, relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : relative.endsWith(".html") ? "text/html" : relative.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream");
    } catch (error) { failures.push(`${req.url}: ${error.message}`); send(error.message, "text/plain", 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = { base, cases,
    async open(count = 1200) {
      const id = `case-${++sequence}`, fixture = { id, works: pool(count), requests: [], covers: [], holds: [] };
      cases.set(id, fixture);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, extraHTTPHeaders: { "X-Fixture-Case": id } });
      const page = await context.newPage(); fixture.page = page; fixture.context = context;
      page.on("pageerror", error => failures.push(error.message));
      await page.route(new RegExp(`^https?://(?!127\\.0\\.0\\.1:${server.address().port}(?:/|$))`), route => route.abort());
      await page.goto(base, { waitUntil: "networkidle" });
      await ready(page, Math.min(48, count));
      return fixture;
    },
    async close() { for (const hold of pending) hold.release(); await new Promise(resolve => server.close(resolve)); }
  };
  surfaces.push(result); return result;
}
async function ready(page, count) {
  await page.waitForFunction(count => document.querySelectorAll("#viewContent .work-card").length === count &&
    (count === 0 || document.querySelector("#viewContent .load-more button")?.disabled === false || !document.querySelector("#viewContent .load-more")), count, { timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function snapshot(page) {
  return page.evaluate(() => ({ view: __worksAudit.context.getCurrentView(), params: __worksAudit.context.getCurrentParams(),
    title: document.querySelector("#viewTitle")?.textContent || "", meta: document.querySelector("#viewMeta")?.textContent || "",
    cards: [...document.querySelectorAll("#viewContent .work-card")].map(card => ({ work: __worksAudit.cardWorks.get(card), text: card.querySelector(".work-summary")?.textContent,
      badges: [...card.querySelectorAll(".work-cover-badge")].map(node => node.textContent),
      role: card.getAttribute("role"), tabIndex: card.tabIndex, className: card.className })),
    filters: [...document.querySelectorAll("#viewContent .work-filter-strip button")].map(button => ({ text: button.textContent, title: button.title, pressed: button.getAttribute("aria-pressed") })),
    summary: document.querySelector("#viewContent .work-control-summary")?.textContent || "", more: document.querySelector("#viewContent .load-more button")?.textContent || "" }));
}
async function more(fixture, count) {
  await fixture.page.locator("#viewContent .load-more button").click(); await ready(fixture.page, count);
}
function hold(fixture, match, error = "") {
  let requested, release;
  const result = { match, error, used: false, requested: null, gate: new Promise(resolve => { release = resolve; }) };
  result.request = new Promise(resolve => { requested = resolve; }); result.requested = requested; result.release = release;
  fixture.holds.push(result); return result;
}
async function navigate(fixture, view, params = {}) {
  await fixture.page.evaluate(({ view, params }) => __worksAudit.context.showView(view, params), { view, params });
  await fixture.page.waitForFunction(view => __worksAudit.context.getCurrentView() === view, view);
  await fixture.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function commonFallbacks(before, current) {
  for (const [label, change] of [
    ["new leading record", works => { works[100].modifiedAt = "2027-01-01"; }],
    ["old presentation changes", works => { works[0].title = "已更新的旧作品标题"; }],
    ["old nonpresentation metadata changes", works => { works[0].infoSummary.description += " Updated metadata"; }],
    ["duplicate IDs remain duplicate cards", works => { works[1].id = works[0].id; }],
    ["missing ID retains the previous full-render output", works => { delete works[2].id; }]
  ]) {
    const old = await before.open(144), next = await current.open(144);
    try {
      for (const f of [old, next]) {
        let viewport;
        if (label === "old presentation changes") {
          await f.page.locator("#viewContent .load-more button").scrollIntoViewIfNeeded();
          await f.page.locator("#viewContent .load-more button").focus();
          viewport = await settleVisibleViewport(f.page);
        }
        await f.page.evaluate(() => { __worksAudit.initialCard = document.querySelector("#viewContent .work-card"); });
        change(f.works);
        if (f === next && viewport) {
          // Intentional new behavior: the accepted prefix remains browsable
          // while the request waits. Preserve a newer user position when the
          // eventual response requires the original complete-render fallback.
          const waiting = hold(f, url => url.pathname === "/api/works" && url.searchParams.get("limit") === "96");
          await f.page.locator("#viewContent .load-more button").click(); await waiting.request;
          assert.equal(await f.page.locator("#viewContent .work-card").count(), 48);
          assert.equal(await f.page.evaluate(() => __worksAudit.initialCard.isConnected), true);
          const previousY = viewport.scrollY;
          await f.page.mouse.wheel(0, -180);
          viewport = await settleVisibleViewport(f.page);
          assert.ok(viewport.scrollY < previousY - 10, "the real wheel moves the retained old prefix before publication");
          waiting.release(); await ready(f.page, 96);
        } else await more(f, 96);
        assert.equal(await f.page.evaluate(() => __worksAudit.initialCard.isConnected), false, `${label}: a changed prefix retains the complete fallback`);
        if (f === next && viewport) {
          const after = await settleVisibleViewport(f.page);
          assert.ok(Math.abs(after.scrollY - viewport.scrollY) <= 2, `full-render fallback preserves the settled viewport: ${viewport.scrollY} -> ${after.scrollY}`);
          assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector("#viewContent .load-more button")), true, "fallback restores focus to its enabled replacement More");
          assert.equal(await f.page.locator("#viewContent .load-more button").isEnabled(), true);
          assert.equal((await snapshot(f.page)).cards[0].work.title, "已更新的旧作品标题");
        }
      }
      compare(await snapshot(next.page), await snapshot(old.page), label);
      if (label === "old presentation changes") {
        next.works[0].title = "再次更新的旧作品标题";
        await next.page.evaluate(() => { __worksAudit.cancelOldGrid = document.querySelector("#viewContent .work-list"); });
        await next.page.locator("#viewContent .load-more button").click();
        await next.page.waitForFunction(() => !__worksAudit.cancelOldGrid.isConnected &&
          document.querySelectorAll("#viewContent .work-card").length > 0 && document.querySelectorAll("#viewContent .work-card").length < 144);
        await next.page.evaluate(() => {
          const button = document.querySelector("#viewContent .work-filter-strip button");
          button.addEventListener("pointerdown", () => { __worksAudit.userIntentY = scrollY; __worksAudit.userIntentRows = document.querySelectorAll("#viewContent .work-card").length; }, { once: true });
        });
        await next.page.getByRole("button", { name: /^全部，/ }).click();
        assert.ok(await next.page.evaluate(() => __worksAudit.userIntentRows < 144), "the real pointer gesture occurs before progressive fallback completion");
        await ready(next.page, 144);
        const after = await settleVisibleViewport(next.page);
        const intent = await next.page.evaluate(() => ({ scrollY: __worksAudit.userIntentY, focusedFilter: document.activeElement === document.querySelector("#viewContent .work-filter-strip button") }));
        assert.ok(Math.abs(after.scrollY - intent.scrollY) <= 2, "a real user gesture cancels the pending fallback viewport restoration");
        assert.equal(intent.focusedFilter, true, "fallback completion does not steal the user's filter focus");
      }
    } finally { await old.context.close(); await next.context.close(); }
  }
  const old = await before.open(96), next = await current.open(96);
  try {
    await more(old, 96); await more(next, 96);
    compare(await snapshot(next.page), await snapshot(old.page), "complete EOF removes More");
    assert.equal(await next.page.locator("#viewContent .load-more").count(), 0);
    assert.equal(await next.page.evaluate(() => document.activeElement === [...document.querySelectorAll("#viewContent .work-card")].at(-1)), true, "EOF moves native More focus to the last card");
  } finally { await old.context.close(); await next.context.close(); }
}
async function commonFilters(before, current) {
  const old = await before.open(240), next = await current.open(240);
  try {
    for (const f of [old, next]) {
      const response = f.page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/works" && url.searchParams.get("filter") === "playable"; });
      await f.page.getByRole("button", { name: /^可播，/ }).click(); await (await response).finished(); await ready(f.page, 48);
    }
    compare(await snapshot(next.page), await snapshot(old.page), "native filter changes replace the list");
    for (const f of [old, next]) {
      for (let index = 0; index < f.works.length; index++) f.works[index].infoSummary.rating = index % 5;
      const response = f.page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/works" && url.searchParams.get("sort") === "ratingDesc"; });
      await f.page.evaluate(() => __worksAudit.api.setSortMode("works", "ratingDesc")); await (await response).finished(); await ready(f.page, 48);
    }
    compare(await snapshot(next.page), await snapshot(old.page), "actual sort callback changes order and complete DTOs");
  } finally { await old.context.close(); await next.context.close(); }
}
async function verifyRetries(surface) {
  // Intentional new failure policy: keep the accepted prefix and retry the same
  // target limit. This is separate from the frozen owner's successful DTO oracle.
  const f = await surface.open(144);
  try {
    const failed = hold(f, url => url.pathname === "/api/works" && url.searchParams.get("limit") === "96", "Synthetic append failure");
    await f.page.locator("#viewContent .load-more button").focus();
    await f.page.locator("#viewContent .load-more button").click(); await failed.request;
    assert.equal(await f.page.locator("#viewContent .work-card").count(), 48, "pending append retains the accepted prefix");
    await f.page.evaluate(() => document.querySelector("#viewContent .load-more button").click());
    assert.equal(f.requests.filter(record => record.path === "/api/works" && record.query.limit === "96").length, 1, "a disabled pending More cannot duplicate the request");
    failed.release();
    await f.page.waitForFunction(() => document.querySelector("#viewContent .load-more")?.dataset.autoLoad === "error");
    assert.equal(await f.page.locator("#viewContent .work-card").count(), 48);
    await more(f, 96);
    assert.deepEqual(f.requests.filter(record => record.path === "/api/works").map(record => record.query.limit), ["48", "96", "96"], "retry sends the failed target limit rather than skipping a prefix");
  } finally { for (const item of f.holds) item.release(); await f.context.close(); }
}
async function verifyCachedFresh(surface) {
  const f = await surface.open(144);
  try {
    const cached = structuredClone(f.requests.find(record => record.path === "/api/works").payload);
    cached.works = structuredClone(f.works.slice(0, 96)); cached.count = cached.limit = 96;
    await f.page.evaluate(async cached => {
      const { writeCachedJson } = await import("/js/cache.js");
      await writeCachedJson(location.origin, "/api/works?limit=96&offset=0&sort=updated&filter=all", cached);
    }, cached);
    f.works[90].title = "Fresh changed tail 00090";
    const fresh = hold(f, url => url.pathname === "/api/works" && url.searchParams.get("limit") === "96");
    await f.page.locator("#viewContent .load-more button").click(); await fresh.request;
    await f.page.waitForFunction(() => document.querySelectorAll("#viewContent .work-card").length > 48);
    const freshResponse = f.page.waitForResponse(response => new URL(response.url()).pathname === "/api/works" && new URL(response.url()).searchParams.get("limit") === "96");
    fresh.release(); await (await freshResponse).finished();
    await f.page.waitForFunction(() => [...document.querySelectorAll("#viewContent .work-card")].some(card => __worksAudit.cardWorks.get(card)?.title === "Fresh changed tail 00090"));
    await ready(f.page, 96);
    const state = await snapshot(f.page);
    assert.equal(state.cards.length, 96);
    assert.equal(new Set(state.cards.map(card => card.work.id)).size, 96, "retired progressive timers cannot append duplicate or missing cached rows");
    assert.equal(state.cards.find(card => card.work.id === "work-00090").work.title, "Fresh changed tail 00090");
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    assert.equal(await f.page.locator("#viewContent .work-card").count(), 96);
  } finally { for (const item of f.holds) item.release(); await f.context.close(); }
}
async function verifyRetirement(surface) {
  const f = await surface.open(144);
  try {
    const hoveredWork = await f.page.locator("#viewContent .work-card").first().getAttribute("data-work-detail-id");
    const oldDetails = f.requests.filter(record => record.path === `/api/works/${hoveredWork}`).length;
    await f.page.locator("#viewContent .work-card").first().hover();
    await navigate(f, "history"); // No mouse movement/pointerout cancels this timer for us.
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 180)));
    assert.equal(f.requests.filter(record => record.path === `/api/works/${hoveredWork}`).length, oldDetails, "leaving the actual route cancels a queued detail hover");
    await navigate(f, "works"); await ready(f.page, 48);
    await f.page.evaluate(() => {
      __worksAudit.ignoreAbort = true;
      __worksAudit.retiredMore = document.querySelector("#viewContent .load-more");
      __worksAudit.retiredCard = document.querySelector("#viewContent .work-card");
    });
    const oldPage = hold(f, url => url.pathname === "/api/works" && url.searchParams.get("limit") === "96");
    await f.page.locator("#viewContent .load-more button").click(); await oldPage.request;
    await navigate(f, "history");
    await f.page.waitForFunction(() => !document.querySelector("#viewContent .work-card"));
    const requestsBefore = f.requests.filter(record => record.path === "/api/works").length;
    await f.page.evaluate(() => {
      const retained = document.createElement("div"); retained.hidden = true; retained.id = "retired-fixture-nodes";
      retained.append(__worksAudit.retiredMore, __worksAudit.retiredCard); document.querySelector("#viewContent").append(retained);
      __worksAudit.retiredMore.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      __worksAudit.retiredCard.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(f.requests.filter(record => record.path === "/api/works").length, requestsBefore, "connected retired controls cannot issue a new list request");
    assert.equal(await f.page.evaluate(() => __worksAudit.context.getCurrentView()), "history", "connected retired cards cannot reopen a work");
    await f.page.evaluate(() => document.querySelector("#retired-fixture-nodes").remove());
    await navigate(f, "works"); await ready(f.page, 48);
    const before = await snapshot(f.page);
    oldPage.release();
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 120)));
    compare(await snapshot(f.page), before, "late uncooperative old page cannot replace a reopened mount");
  } finally { for (const item of f.holds) item.release(); await f.context.close(); }
}
async function verifyCachedEof(surface) {
  const initial = await surface.open(24);
  try {
    initial.works = pool(96);
    await navigate(initial, "history");
    const fresh = hold(initial, url => url.pathname === "/api/works" && url.searchParams.get("limit") === "48");
    await navigate(initial, "works"); await fresh.request;
    await initial.page.waitForFunction(() => document.querySelectorAll("#viewContent .work-card").length === 24);
    fresh.release(); await ready(initial.page, 48);
    assert.equal(await initial.page.locator("#viewContent .load-more button").count(), 1, "a cached EOF must regain More when fresh data grows");
    await more(initial, 96);
  } finally { for (const item of initial.holds) item.release(); await initial.context.close(); }
  const continuation = await surface.open(144);
  try {
    const cached = structuredClone(continuation.requests.find(record => record.path === "/api/works").payload);
    cached.works = structuredClone(continuation.works.slice(0, 96)); cached.count = cached.limit = cached.total = 96; cached.hasMore = false;
    await continuation.page.evaluate(async cached => {
      const { writeCachedJson } = await import("/js/cache.js");
      await writeCachedJson(location.origin, "/api/works?limit=96&offset=0&sort=updated&filter=all", cached);
    }, cached);
    const fresh = hold(continuation, url => url.pathname === "/api/works" && url.searchParams.get("limit") === "96");
    await continuation.page.locator("#viewContent .load-more button").click(); await fresh.request;
    await continuation.page.waitForFunction(() => document.querySelectorAll("#viewContent .work-card").length === 96 && !document.querySelector("#viewContent .load-more"));
    const freshResponse = continuation.page.waitForResponse(response => new URL(response.url()).pathname === "/api/works" && new URL(response.url()).searchParams.get("limit") === "96");
    fresh.release(); await (await freshResponse).finished();
    await continuation.page.waitForFunction(() => document.querySelector("#viewMeta")?.textContent.includes("144") && document.querySelector("#viewContent .load-more button")?.disabled === false);
    await ready(continuation.page, 96);
    assert.equal(await continuation.page.locator("#viewContent .load-more button").count(), 1, "fresh continuation restores a retired cached-EOF control");
    await more(continuation, 144);
  } finally { for (const item of continuation.holds) item.release(); await continuation.context.close(); }
}
async function settleVisibleViewport(page) {
    await page.waitForFunction(() => {
      const visible = [...document.querySelectorAll("#viewContent .work-card")].filter(card => { const rect = card.getBoundingClientRect(); return rect.top < innerHeight && rect.bottom > 0; });
      return visible.length > 0 && visible.every(card => { const image = card.querySelector("img"); return image?.complete && image.naturalWidth > 0; });
    });
    const baseline = await page.evaluate(async () => {
      const cards = [...document.querySelectorAll("#viewContent .work-card")];
      const visible = cards.filter(card => { const rect = card.getBoundingClientRect(); return rect.top < innerHeight && rect.bottom > 0; });
      const anchor = visible.find(card => { const rect = card.getBoundingClientRect(); return rect.top >= 100 && rect.bottom <= innerHeight; }) || visible[0];
      __worksAudit.anchorCard = anchor;
      __worksAudit.anchorId = __worksAudit.cardWorks.get(anchor)?.id;
      let previous = null, stable = 0;
      for (let frame = 0; frame < 60 && stable < 3; frame++) {
        await new Promise(requestAnimationFrame);
        const current = [scrollY, anchor.getBoundingClientRect().top, anchor.getBoundingClientRect().height];
        stable = previous && current.every((value, index) => Math.abs(value - previous[index]) < 0.25) ? stable + 1 : 0;
        previous = current;
      }
      return { scrollY, anchorTop: anchor.getBoundingClientRect().top, anchorHeight: anchor.getBoundingClientRect().height,
        anchorId: __worksAudit.cardWorks.get(anchor)?.id, stableFrames: stable };
    });
    assert.equal(baseline.stableFrames, 3, "visible old cards and scroll position settle before the pagination gesture");
    return baseline;
}
async function verifyNativeSurface(surface) {
  const f = await surface.open(144);
  try {
    await f.page.waitForFunction(() => { const image = document.querySelector("#viewContent .work-card img"); return image?.complete && image.naturalWidth > 0; });
    await f.page.evaluate(() => {
      __worksAudit.firstCard = document.querySelector("#viewContent .work-card");
      __worksAudit.firstImage = __worksAudit.firstCard.querySelector("img");
      __worksAudit.firstWork = __worksAudit.cardWorks.get(__worksAudit.firstCard);
      __worksAudit.more = document.querySelector("#viewContent .load-more button");
    });
    await f.page.locator("#viewContent .load-more button").scrollIntoViewIfNeeded();
    await f.page.locator("#viewContent .load-more button").focus();
    const baseline = await settleVisibleViewport(f.page);
    await f.page.locator("#viewContent .load-more button").press("Enter"); await ready(f.page, 96);
    const after = await f.page.evaluate(() => {
      // Viewport equivalence concerns the same work even in the deliberately
      // unoptimized full-render control; node identity is checked separately.
      const anchor = [...document.querySelectorAll("#viewContent .work-card")].find(card => __worksAudit.cardWorks.get(card)?.id === __worksAudit.anchorId);
      return {
      retainedCard: __worksAudit.firstCard === document.querySelector("#viewContent .work-card"),
      retainedImage: __worksAudit.firstImage.isConnected && __worksAudit.firstImage === document.querySelector("#viewContent .work-card img"),
      retainedMore: __worksAudit.more === document.querySelector("#viewContent .load-more button"),
      reboundWork: __worksAudit.cardWorks.get(__worksAudit.firstCard) !== __worksAudit.firstWork,
      focusedMore: document.activeElement === document.querySelector("#viewContent .load-more button"), scrollY,
      anchorTop: anchor.getBoundingClientRect().top, anchorHeight: anchor.getBoundingClientRect().height
    }; });
    assert.equal(after.focusedMore, true, "native keyboard pagination restores More focus");
    await f.page.locator("#viewContent .work-card").nth(48).scrollIntoViewIfNeeded();
    await f.page.waitForFunction(() => { const image = document.querySelectorAll("#viewContent .work-card")[48]?.querySelector("img"); return image?.complete && image.naturalWidth > 0; });
    assert.ok(f.covers.some(url => url.endsWith("cover-48")), "the actual viewport loader fetched a newly appended synthetic cover");
    const opened = await f.page.locator("#viewContent .work-card").first().getAttribute("data-work-detail-id");
    await f.page.locator("#viewContent .work-card").first().press("Enter");
    await f.page.waitForFunction(id => __worksAudit.context.getCurrentView() === "workDetail" && __worksAudit.context.getCurrentParams().workId === id, opened);
    return { ...after, beforeY: baseline.scrollY, baseline, nativeCoverFetched: true, keyboardWorkId: opened };
  } finally { await f.context.close(); }
}
async function verifyScopeFailure(surface) {
  const f = await surface.open(144);
  try {
    const failed = hold(f, url => url.pathname === "/api/works" && url.searchParams.get("filter") === "playable", "Synthetic scope failure");
    await f.page.getByRole("button", { name: /^可播，/ }).click(); await failed.request; failed.release();
    await f.page.waitForFunction(() => document.querySelector("#viewContent .message-box.error")?.textContent.includes("Synthetic scope failure"));
    assert.equal(await f.page.locator("#viewContent .work-card").count(), 0, "a failed new scope cannot display the preceding scope's prefix");
    const response = f.page.waitForResponse(response => new URL(response.url()).pathname === "/api/works" && response.status() === 200);
    await f.page.evaluate(() => __worksAudit.context.renderCurrentView()); await (await response).finished(); await ready(f.page, 48);
    const attempts = f.requests.filter(record => record.path === "/api/works" && record.query.filter === "playable");
    assert.deepEqual(attempts.map(record => [record.query.limit, record.query.offset]), [["48", "0"], ["48", "0"]]);
    assert.ok((await snapshot(f.page)).cards.every(card => card.work.playableCount > 0));
  } finally { for (const item of f.holds) item.release(); await f.context.close(); }
}
async function verifyOwnerChange(surface) {
  const f = await surface.open(144);
  try {
    // The native auth boundary returns only a synthetic session. Real owner,
    // HTTP auth, account events, cache fences and app reload all remain active.
    const installSyntheticAuth = () => {
      globalThis.Capacitor = { Plugins: { FanHaoAuth: {
        getSession: async () => ({ token: localStorage.getItem("synthetic.fixture.session") || "" }),
        loginAccount: async () => { localStorage.setItem("synthetic.fixture.session", "usr.synthetic_A"); return { token: "usr.synthetic_A" }; }
      } } };
    };
    await f.context.addInitScript(installSyntheticAuth);
    await f.page.evaluate(installSyntheticAuth);
    await f.page.evaluate(() => { __worksAudit.ignoreAbort = true; });
    const oldPage = hold(f, url => url.pathname === "/api/works" && url.searchParams.get("limit") === "96");
    await f.page.locator("#viewContent .load-more button").click(); await oldPage.request;
    f.accountId = "syntheticA";
    f.works = f.works.map(item => ({ ...item, id: `accountA-${item.id}`, title: `Account A ${item.title}` }));
    const navigation = f.page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });
    const authenticate = f.page.evaluate(async () => {
      const { authenticateAccount } = await import("/js/server-auth.js");
      const { fetchJson } = await import("/js/api.js");
      await authenticateAccount(location.origin, "login", { username: "Synthetic" });
      await fetchJson(location.origin, "/api/accounts/status");
    }).catch(error => { assert.match(error.message, /Execution context was destroyed|navigation/); });
    await Promise.all([navigation, authenticate]); await ready(f.page, 48);
    const state = await snapshot(f.page);
    assert.ok(state.cards.every(card => card.work.id.startsWith("accountA-")));
    assert.equal(f.requests.filter(record => record.path === "/api/works").at(-1).owner, "account:syntheticA");
    oldPage.release(); await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 120)));
    compare(await snapshot(f.page), state, "actual account-owner reload rejects the preceding owner's held page");
  } finally { for (const item of f.holds) item.release(); await f.context.close(); }
}
function compare(actual, expected, label) {
  function mismatch(a, b, at = "state") {
    if (isDeepStrictEqual(a, b)) return "";
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) { const difference = mismatch(a[key], b[key], `${at}.${key}`); if (difference) return difference; }
    }
    return `${at}: ${JSON.stringify(a)?.slice(0, 160)} versus ${JSON.stringify(b)?.slice(0, 160)}`;
  }
  assert.ok(isDeepStrictEqual(actual, expected), `${label}: ${mismatch(actual, expected)}`); comparisons++;
}

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const before = await surface(frozen), current = await surface(candidate);
  const old = await before.open(), next = await current.open();
  try {
    assert.deepEqual(failures, [], "actual entry has no unexpected API or browser errors");
    compare(await snapshot(next.page), await snapshot(old.page), "actual entry initial complete DTO/DOM/header/facets");
    for (let page = 2; page <= 20; page++) {
      await more(old, page * 48); await more(next, page * 48);
      compare(await snapshot(next.page), await snapshot(old.page), `actual entry page ${page}`);
    }
    const measured = async fixture => ({ ...(await fixture.page.evaluate(() => ({ createdCards: __worksAudit.createdCards, createElementCalls: __worksAudit.createElementCalls }))),
      api: fixture.requests.filter(record => record.path === "/api/works").map(({ query, rows }) => ({ query, rows })), covers: fixture.covers.length });
    const scale = { before: await measured(old), current: await measured(next) };
    await commonFallbacks(before, current);
    await commonFilters(before, current);
    await verifyRetries(current);
    await verifyCachedFresh(current);
    await verifyRetirement(current);
    await verifyCachedEof(current);
    await verifyScopeFailure(current);
    await verifyOwnerChange(current);
    const native = await verifyNativeSurface(current);
    compare(scale.current.api, scale.before.api, "the network retains the complete prefix GET policy");
    assert.equal(scale.before.api.reduce((sum, record) => sum + record.rows, 0), 10080);
    assert.equal(scale.current.api.reduce((sum, record) => sum + record.rows, 0), 10080);
    assert.equal(scale.before.createdCards, 10080);
    assert.deepEqual(failures, [], "all functional cases have no unexpected API or browser errors");
    assert.ok(Math.abs(native.scrollY - native.beforeY) <= 2, `native pagination keeps the existing viewport: ${native.beforeY} -> ${native.scrollY}`);
    assert.ok(Math.abs(native.anchorTop - native.baseline.anchorTop) <= 2, "the same visible work keeps its viewport position");
    console.log(JSON.stringify({ comparisons, negativeControl: negative, scale, native }));
    assert.equal(scale.current.createdCards, 960, "twenty prefix pages create each actual card once");
    assert.ok(scale.current.createElementCalls <= 16000, "actual DOM creation remains bounded by new cards and small controls");
    assert.equal(native.retainedCard, true); assert.equal(native.retainedImage, true); assert.equal(native.retainedMore, true); assert.equal(native.reboundWork, true);
  } finally { await old.context.close(); await next.context.close(); }
} finally {
  await browser?.close();
  for (const item of surfaces) await item.close();
}

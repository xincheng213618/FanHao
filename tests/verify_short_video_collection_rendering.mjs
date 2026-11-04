import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
assert(args.every(value => ["--legacy-page-render", "--without-cover-activation"].includes(value)), "known arguments");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(project, "public");
const ownerPath = "public/modules/short-videos/collections-controller.js";
const beforeSource = execFileSync("git", ["show", `63c5fab243233e142cfd62c4eaf13812feb92405:${ownerPath}`], { cwd: project, encoding: "utf8" }).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(beforeSource).digest("hex"), "637df6434d636f07cb5c8eee6cd8e85f56cb6539275fe49434703637e2f71f61");
let currentSource = fs.readFileSync(path.join(project, ownerPath), "utf8").replace(/\r\n/g, "\n");
if (args.includes("--legacy-page-render")) {
  const marker = "  function appendMountedCollectionVideos(mount, data) {";
  assert.equal(currentSource.split(marker).length, 2, "one mounted update fallback boundary");
  currentSource = currentSource.replace(marker, `${marker}\n    return false; // Controlled whole-page fallback.`);
}
if (args.includes("--without-cover-activation")) {
  const marker = "activateCardCovers?.([card]);";
  assert.equal(currentSource.split(marker).length, 2, "one production collection cover activation boundary");
  currentSource = currentSource.replace(marker, "/* Controlled missing collection cover activation. */");
}
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "private Chromium fixture requires Chrome or Edge");
const unexpected = [];
let browser, base, checks = 0, oracles = 0;
const fullEntryRequests = [];
function entryVideo(index) {
  return { id: `v${index}`, title: `Synthetic ${index}`, author: { name: "Synthetic", secUid: "author" },
    coverUrl: `/synthetic/full-cover-${index}.svg`, streamUrl: `/synthetic/video-${index}.mp4`, durationMs: 10000,
    stats: { likes: 0 }, actions: {} };
}
function entryApi(url) {
  const collection = { id: "A", name: "Synthetic", itemCount: 96 };
  const page = offset => ({ collection, videos: Array.from({ length: 48 }, (_, i) => entryVideo(offset + i)),
    total: 96, hasMore: offset === 0, nextCursor: offset === 0 ? "next" : null });
  if (url.pathname === "/api/modules") return { modules: [{ id: "short-videos", title: "短视频", order: 50,
    client: { web: { href: "/short-videos", view: "shortVideos" } } }] };
  if (url.pathname === "/api/short-videos/collections") return { collections: [collection], total: 1 };
  if (url.pathname === "/api/short-videos/collections/A/videos") return page(url.searchParams.has("cursor") ? 48 : 0);
  if (url.pathname === "/api/short-videos/authors") return { authors: [], total: 0, hasMore: false };
  if (url.pathname === "/api/short-videos/summary") return { totals: {}, authors: [], sources: [] };
  if (url.pathname === "/api/short-videos") return { videos: page(0).videos, total: 48, hasMore: false };
  assert.fail(`Unexpected actual-entry API: ${url.pathname}`);
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    const send = (body, type) => { res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
    if (url.pathname.startsWith("/api/")) {
      assert.equal(req.method, "GET", "actual-entry smoke is read-only against synthetic API");
      fullEntryRequests.push(url.pathname + url.search);
      return send(JSON.stringify(entryApi(url)), "application/json");
    }
    if (url.pathname.startsWith("/short-videos")) return send(await fs.promises.readFile(path.join(publicRoot, "index.html")), "text/html");
    if (url.pathname === "/probe") return send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Private Web collection fixture</title><body class="short-video-view"><main><div id="workGrid" class="work-grid"></div></main><script type="module">(${browserHarness.toString()})(${JSON.stringify({ version: url.searchParams.get("version") || "current", coverMode: url.searchParams.get("coverMode") || "native" })});</script></body></html>`, "text/html");
    if (url.pathname === "/modules/short-videos/fixture-controller.js") {
      const old = url.searchParams.get("version") === "before";
      return send(old ? beforeSource : currentSource, "text/javascript");
    }
    if (url.pathname === "/synthetic/failure.svg") { res.writeHead(404); res.end(); return; }
    if (url.pathname.startsWith("/synthetic/")) return send('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="#739183"/></svg>', "image/svg+xml");
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    const file = path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
    assert(file.startsWith(`${publicRoot}${path.sep}`), "private static path stays within public");
    return send(await fs.promises.readFile(file), file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
  } catch (error) {
    unexpected.push(`${req.url}: ${error.message}`);
    if (!res.destroyed) { res.writeHead(500); res.end(error.message); }
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const before = await newPage("before"), current = await newPage("current");
  try {
    await contract(before, current, "success/failure/retry and duplicate EOF", pageFlow);
    await contract(before, current, "delete failure/success/empty and concurrent page", deleteFlow);
    await contract(before, current, "stale page, navigation and acknowledged delete", ownershipFlow);
    await contract(before, current, "initial loading/error Back keeps feed navigation available", initialBackFlow);
    await verifyRetainedControls(current);
    const scale = await verifyScale(before, current);
    await verifyCovers(current);
    const entry = await verifyActualEntry();
    const visualRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-web-collection-rendering-"));
    const screenshotPath = path.join(visualRoot, "web-collection-1280x900.png");
    await current.evaluate(() => scrollTo({ top: 0, behavior: "instant" })); await settle(current);
    await current.waitForFunction(() => [...document.querySelectorAll('.short-video-card img')].filter(image => {
      const bounds = image.getBoundingClientRect(); return bounds.top < innerHeight && bounds.bottom > 0;
    }).every(image => image.complete && image.naturalWidth > 0 && image.classList.contains("is-loaded") && getComputedStyle(image).opacity === "1"));
    await current.screenshot({ path: screenshotPath });
    assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ fixture: "short-video-collection-rendering", checks, oracles, scale, entry, screenshotPath }, null, 2));
  } finally { await before.close(); await current.close(); }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }

async function newPage(version, { coverMode = "native" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => unexpected.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.goto(`${base}/probe?version=${version}&coverMode=${coverMode}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.fixture?.ready);
  return page;
}
function settle(page) { return page.evaluate(() => fixture.settle()); }
function reset(page, options = {}) { return page.evaluate(options => fixture.reset(options), options); }
function snapshot(page) { return page.evaluate(() => fixture.snapshot()); }
async function contract(before, current, label, scenario) {
  const expected = await scenario(before), actual = await scenario(current);
  assert.deepEqual(actual, expected, label);
  oracles += actual.length; checks++;
}

async function pageFlow(page) {
  await reset(page, { count: 145 });
  const results = [await snapshot(page)];
  await page.locator(".short-video-collection-load-more").click(); await settle(page);
  results.push(await snapshot(page));
  await page.evaluate(() => fixture.hold("GET", "videos?", "failure"));
  await page.locator(".short-video-collection-load-more").click();
  await page.evaluate(() => fixture.reject("failure", "fixture page failure")); await settle(page);
  results.push(await snapshot(page));
  await page.locator(".short-video-collection-load-more").press("Enter"); await settle(page);
  results.push(await snapshot(page));
  await page.evaluate(() => fixture.hold("GET", "videos?", "last"));
  await page.locator(".short-video-collection-load-more").evaluate(button => { button.click(); button.click(); });
  await page.evaluate(() => fixture.resolve("last")); await settle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).cardIds.length, 145);
  await page.locator(".short-video-thumb-open").first().press("Enter"); await settle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).opens.at(-1).loaded.length, 145, "retained old card opens the newest loaded window");
  assert.equal(results.at(-1).opens.at(-1).hasMore, false);
  await reset(page, { count: 100, initial: 48 });
  await page.evaluate(() => fixture.hold("GET", "videos?", "duplicate"));
  await page.locator(".short-video-collection-load-more").click();
  await page.evaluate(() => fixture.resolve("duplicate", { videos: fixture.videoRange(0, 48), total: 100, hasMore: true, nextCursor: "cursor-96" })); await settle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).cardIds.length, 48);
  await page.evaluate(() => fixture.hold("GET", "videos?", "empty"));
  await page.locator(".short-video-collection-load-more").click();
  await page.evaluate(() => fixture.resolve("empty", { videos: [], total: 100, hasMore: false, nextCursor: null })); await settle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).hasMoreButton, false);
  await reset(page, { count: 150 });
  await page.locator(".short-video-collection-load-more").click(); await settle(page);
  await page.locator('.short-video-card[data-video-id="v47"] .short-video-thumb-open').press("Enter"); await settle(page);
  results.push(await snapshot(page));
  const opened = results.at(-1).opens.at(-1);
  assert.equal(opened.loaded.length, 96);
  assert.equal(opened.nextCursor, "cursor-96");
  assert.equal(opened.navigation.nextId, "v48", "retained first-page card uses newly appended neighbor");
  return results;
}

async function deleteFlow(page) {
  await reset(page, { count: 100 });
  const results = [];
  await page.evaluate(() => fixture.hold("DELETE", "/videos/", "delete-fail"));
  await page.locator('.short-video-collection-remove[data-video-id="v0"]').click();
  await page.evaluate(() => fixture.reject("delete-fail", "fixture remove failure")); await settle(page);
  results.push(await snapshot(page));
  await page.locator('.short-video-collection-remove[data-video-id="v0"]').click(); await settle(page);
  results.push(await snapshot(page));
  assert(!results.at(-1).cardIds.includes("v0"));
  await page.evaluate(() => { fixture.hold("GET", "videos?", "page"); fixture.hold("DELETE", "/videos/", "remove"); });
  await page.locator(".short-video-collection-load-more").click();
  await page.locator('.short-video-collection-remove[data-video-id="v1"]').click();
  await page.evaluate(() => fixture.resolve("remove")); await settle(page);
  await page.evaluate(() => fixture.resolve("page")); await settle(page);
  results.push(await snapshot(page));
  await reset(page, { count: 1, initial: 1 });
  await page.locator(".short-video-collection-remove").press("Enter"); await settle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).emptyText, "这个清单还没有视频");
  return results;
}

async function ownershipFlow(page) {
  const results = [];
  await reset(page, { count: 100 });
  await page.evaluate(() => fixture.hold("GET", "videos?", "stale-page"));
  await page.locator(".short-video-collection-load-more").click();
  await page.evaluate(() => fixture.navigate("B")); await settle(page);
  await page.evaluate(() => fixture.resolve("stale-page")); await settle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).state.shortVideo.collectionId, "B");
  await reset(page, { count: 100 });
  await page.evaluate(() => fixture.hold("DELETE", "/videos/", "old-delete"));
  await page.locator('.short-video-collection-remove[data-video-id="v0"]').click();
  await page.evaluate(() => fixture.navigate("B")); await settle(page);
  await page.evaluate(() => fixture.resolve("old-delete")); await settle(page);
  results.push(await snapshot(page));
  assert.equal(results.at(-1).state.shortVideo.collectionId, "B");
  await reset(page, { count: 100 });
  await page.evaluate(() => fixture.hold("DELETE", "/videos/", "reopen-delete"));
  await page.locator('.short-video-collection-remove[data-video-id="v0"]').click();
  await page.evaluate(() => fixture.navigate("A")); await settle(page);
  await page.evaluate(() => fixture.resolve("reopen-delete")); await settle(page);
  results.push(await snapshot(page));
  assert(!results.at(-1).state.shortVideo.collectionData.videos.some(row => row.id === "v0"), "old same-page delete acknowledgement still prunes latest source data");
  await reset(page, { count: 100 });
  await page.evaluate(() => fixture.hold("GET", "videos?", "left-page"));
  await page.locator(".short-video-collection-load-more").click();
  await page.evaluate(() => { fixture.state.shortVideo.source = "changed-account-source"; fixture.leave(); });
  await page.evaluate(() => fixture.resolve("left-page")); await settle(page);
  results.push(await snapshot(page));
  return results;
}

async function initialBackFlow(page) {
  const results = [];
  for (const failure of [false, true]) {
    await reset(page, { count: 100 });
    await page.evaluate(() => { fixture.hold("GET", "/collections/C/videos?", "initial"); fixture.navigate("C"); }); await settle(page);
    assert.equal(await page.evaluate(() => fixture.state.shortVideo.collectionData), null);
    if (failure) { await page.evaluate(() => fixture.reject("initial", "fixture initial failure")); await settle(page); }
    await page.locator(".short-video-collection-back").press("Enter"); await settle(page);
    if (!failure) { await page.evaluate(() => fixture.resolve("initial")); await settle(page); }
    results.push(await snapshot(page));
    assert.equal(results.at(-1).state.shortVideo.mode, "feed", "Back works without collection data");
    assert.equal(results.at(-1).state.shortVideo.collectionId, "");
  }
  return results;
}

async function verifyRetainedControls(page) {
  await reset(page, { count: 120 });
  await page.evaluate(() => fixture.rememberNodes());
  await page.locator(".short-video-collection-load-more").press("Enter"); await settle(page);
  const retained = await page.evaluate(() => fixture.retained());
  if (!args.includes("--legacy-page-render")) {
    assert(retained.cards && retained.header && retained.sidebar && retained.more, "append preserves cards/header/sidebar/more identities");
    assert(retained.moreFocused, "native Enter keeps focus on the retained load-more control");
  }
  await page.evaluate(() => { document.querySelector('.short-video-collection-remove[data-video-id="v1"]').focus(); fixture.rememberNodes(); });
  await page.locator('.short-video-collection-remove[data-video-id="v1"]').press("Enter"); await settle(page);
  if (!args.includes("--legacy-page-render")) {
    const removed = await page.evaluate(() => fixture.retained());
    assert(removed.header && removed.sidebar && removed.more);
    assert.equal(await page.evaluate(() => document.activeElement.closest("[data-collection-video-id]")?.dataset.collectionVideoId), "v2", "removed control focuses next retained card");
  }
  await reset(page, { count: 120 });
  await page.evaluate(() => { fixture.hold("GET", "videos?", "focus-intent"); fixture.rememberNodes(); });
  await page.locator(".short-video-collection-load-more").press("Enter");
  await page.locator(".short-video-collection-page-actions button").first().focus();
  await page.evaluate(() => { scrollTo({ top: 300, behavior: "instant" }); fixture.captureUserPosition(); fixture.resolve("focus-intent"); }); await settle(page);
  if (!args.includes("--legacy-page-render")) assert(await page.evaluate(() => fixture.userPositionRetained()), "page reply preserves the user's newer focus and scroll");
  await reset(page, { count: 120 });
  await page.evaluate(() => fixture.rememberNodes());
  await page.evaluate(() => fixture.navigate("A")); await settle(page);
  if (!args.includes("--legacy-page-render")) {
    const stale = await page.evaluate(async () => { const before = fixture.snapshot().requests.length; fixture.activateOldControls(); await fixture.settle(); return { before, after: fixture.snapshot().requests.length }; });
    assert.equal(stale.after, stale.before, "detached old controls cannot issue new reads or mutations on reopened page");
  }
  for (const field of ["source", "activeView"]) {
    await reset(page, { count: 120 });
    await page.evaluate(field => { fixture.rememberNodes(); if (field === "source") fixture.state.shortVideo.source = "other-account-source"; else fixture.state.activeView = "people"; }, field);
    if (!args.includes("--legacy-page-render")) {
      const stale = await page.evaluate(async () => { const before = fixture.snapshot().requests.length; fixture.activateOldControls(); await fixture.settle(); return { before, after: fixture.snapshot().requests.length, connected: document.querySelector('.short-video-collection-page')?.isConnected }; });
      assert.equal(stale.connected, true, "stale-owner test retains the old shell in DOM");
      assert.equal(stale.after, stale.before, `${field} changed: connected stale controls cannot capture a new owner at click time`);
    }
  }
  await reset(page, { count: 120 });
  await page.evaluate(() => { fixture.hold("GET", "/collections/C/videos?", "stale-initial"); fixture.navigate("C"); }); await settle(page);
  await page.evaluate(() => fixture.rememberNodes());
  await page.evaluate(() => fixture.navigate("B")); await settle(page);
  await page.evaluate(() => fixture.resolve("stale-initial")); await settle(page);
  if (!args.includes("--legacy-page-render")) {
    await page.evaluate(() => fixture.activateOldBack()); await settle(page);
    assert.equal(await page.evaluate(() => fixture.state.shortVideo.collectionId), "B", "detached initial Back cannot leave the newly mounted collection");
  }
  await reset(page, { count: 120 });
  await page.evaluate(() => fixture.hold("DELETE", "/videos/", "delete-focus-intent"));
  await page.locator('.short-video-collection-remove[data-video-id="v1"]').press("Enter");
  await page.locator(".short-video-collection-page-actions button").first().focus();
  await page.evaluate(() => { scrollTo({ top: 300, behavior: "instant" }); fixture.captureUserPosition(); fixture.resolve("delete-focus-intent"); }); await settle(page);
  if (!args.includes("--legacy-page-render")) assert(await page.evaluate(() => fixture.userPositionRetained()), "delete acknowledgement preserves newer toolbar focus and user scroll");
  await reset(page, { count: 1, initial: 1 });
  await page.locator(".short-video-collection-remove").press("Enter"); await settle(page);
  if (!args.includes("--legacy-page-render")) assert(await page.locator(".short-video-collection-back").evaluate(button => button === document.activeElement), "empty deletion focuses retained Back control");
  await reset(page, { count: 49 });
  await page.locator(".short-video-collection-load-more").press("Enter"); await settle(page);
  if (!args.includes("--legacy-page-render")) assert.equal(await page.evaluate(() => document.activeElement.closest('[data-collection-video-id]')?.dataset.collectionVideoId), "v48", "EOF focuses new last card when More disappears");
  checks++;
}

async function verifyScale(before, current) {
  const run = async page => {
    await reset(page, { count: 1056 });
    const began = Date.now();
    const points = [];
    for (let i = 0; i < 20; i++) {
      if (i === 19) await page.evaluate(() => { fixture.rememberNodes(); fixture.resetMetrics(); });
      await page.locator(".short-video-collection-load-more").click(); await settle(page);
      if ([0, 9, 19].includes(i)) points.push(await snapshot(page));
    }
    const growth = { points, milliseconds: Date.now() - began, ...(await page.evaluate(() => ({ metrics: fixture.totalMetrics(), tail: fixture.metrics(), retained: fixture.retained(), cards: document.querySelectorAll('.short-video-card').length,
      images: document.querySelectorAll('.short-video-card img').length, liveElements: document.querySelectorAll('*').length }))) };
    await page.evaluate(() => { fixture.rememberNodes(); fixture.resetMetrics(); });
    await page.locator('.short-video-collection-remove[data-video-id="v500"]').press("Enter"); await settle(page);
    growth.deleted = await snapshot(page);
    growth.removal = await page.evaluate(() => ({ metrics: fixture.metrics(), retained: fixture.retained("v500"), cards: document.querySelectorAll('.short-video-card').length }));
    return growth;
  };
  const old = await run(before), next = await run(current);
  assert.deepEqual(next.points, old.points, "large real-click Web pagination preserves full state and visible card order"); oracles += next.points.length;
  assert.equal(old.metrics.cards, 11088, "fixed old Web owner rebuilds each successful prefix once");
  assert.equal(next.cards, 1008); assert.equal(next.images, 1008);
  assert.equal(next.metrics.cards, 1008, "growing 48 to 1008 creates each actual Web card once");
  assert.equal(next.tail.cards, 48, "960 to 1008 creates only the new page");
  assert(next.tail.cardElements < 48 * 27, "tail creation has a fixed 48-card element budget");
  assert(next.liveElements < 1008 * 27 + 200, "only the current cards and fixed chrome remain live");
  assert(next.retained.cards && next.retained.header && next.retained.sidebar && next.retained.more);
  assert.deepEqual(next.deleted, old.deleted, "large deletion preserves the fixed old response and membership state"); oracles++;
  assert.equal(old.removal.metrics.cards, 1007);
  assert.equal(next.removal.metrics.cards, 0, "one removal creates no replacement cards");
  assert.equal(next.removal.cards, 1007);
  assert(next.removal.retained.cards && next.removal.retained.header && next.removal.retained.sidebar && next.removal.retained.more);
  checks++;
  return { old: { metrics: old.metrics, tail: old.tail, milliseconds: old.milliseconds },
    current: { metrics: next.metrics, tail: next.tail, milliseconds: next.milliseconds, liveElements: next.liveElements },
    removal: { before: old.removal.metrics, current: next.removal.metrics } };
}

async function verifyCovers(page) {
  await reset(page, { count: 120 });
  assert.equal((await page.evaluate(() => fixture.coverState())).activated.length, 48, "the product activates all newly created first-page cards");
  await page.waitForFunction(() => fixture.coverState().images.some(image => image.id === "v0" && image.loaded && image.width > 0));
  const initial = await page.evaluate(() => fixture.coverState());
  assert(initial.images.some(image => !image.src && image.pending), "native IO retains offscreen covers as lazy");
  await page.locator(".short-video-collection-load-more").click(); await settle(page);
  const appended = await page.evaluate(() => fixture.coverState());
  assert.deepEqual(appended.activated, Array.from({ length: 96 }, (_, i) => `v${i}`), "append only activates its new cards");
  await page.locator('.short-video-card[data-video-id="v95"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => fixture.coverState().images.some(image => image.id === "v95" && image.loaded && image.width > 0));
  assert.equal((await page.evaluate(() => fixture.coverState())).images.find(image => image.id === "v95").pending, false);

  const fallback = await newPage("current", { coverMode: "none" });
  const controlled = await newPage("current", { coverMode: "controlled" });
  try {
    await reset(fallback, { count: 48 });
    await fallback.waitForFunction(() => fixture.coverState().images.length === 48 && fixture.coverState().images.every(image => image.started && image.src && !image.pending));
    await fallback.waitForFunction(() => fixture.coverState().images.some(image => image.id === "v0" && image.loaded && image.width > 0));
    assert.equal((await fallback.evaluate(() => fixture.coverState())).observed.length, 0, "no-IO mode loads through the actual bounded queue");

    await reset(controlled, { count: 48 });
    let state = await controlled.evaluate(() => fixture.coverState());
    assert(state.observed.includes("v47"), "lazy cover belongs to the real loader observer");
    assert(!state.images.find(image => image.id === "v47").src);
    await controlled.locator('.short-video-collection-remove[data-video-id="v47"]').click(); await settle(controlled);
    state = await controlled.evaluate(() => fixture.coverState());
    assert(!state.observed.includes("v47"), "deleting a lazy card releases its observer target");

    // Hold one actual image response to retain its production load/error
    // listeners. Only IO/event delivery is controlled; the fixture never sets
    // an image source or loaded class on the loader's behalf.
    let heldResponse;
    await controlled.route("**/synthetic/47.svg", route => { heldResponse = route; });
    try {
      await reset(controlled, { count: 48 });
      const requested = controlled.waitForRequest("**/synthetic/47.svg");
      await controlled.evaluate(() => fixture.intersectCover("v47"));
      await controlled.locator('.short-video-card[data-video-id="v47"]').scrollIntoViewIfNeeded();
      await requested;
      await settle(controlled);
      assert(heldResponse, "the synthetic image request reached its held response boundary");
      await controlled.waitForFunction(() => fixture.coverState().images.some(image => image.id === "v47" && image.started));
      const retired = await controlled.evaluate(async () => {
        fixture.captureCoverCallbacks("v46", "v47");
        fixture.resetCoverLoader();
        fixture.reactivateCoverNodes();
        const before = fixture.coverState();
        fixture.deliverRetiredCoverCallbacks();
        await new Promise(resolve => setTimeout(resolve, 80));
        return { before, after: fixture.coverState() };
      });
      assert(retired.before.observed.includes("v46"));
      assert(retired.after.observed.includes("v46"), "retired IO cannot unobserve the new generation's target");
      assert(!retired.after.images.find(image => image.id === "v46").src, "retired IO cannot enqueue a connected old-generation target");
      const staleImage = retired.after.images.find(image => image.id === "v47");
      assert(!staleImage.loaded && !staleImage.error && !retired.after.loadedIds.includes("v47"), "retired load/error events cannot publish into the current owner");
    } finally {
      await heldResponse?.abort();
      await controlled.unroute("**/synthetic/47.svg");
    }

    const stopped = await controlled.evaluate(async () => {
      fixture.reset({ count: 48 });
      fixture.rememberCoverImages();
      fixture.leave();
      await new Promise(resolve => setTimeout(resolve, 80));
      return fixture.coverState(true);
    });
    assert.equal(stopped.observed.length, 0, "leave resets the actual cover observer");
    assert(stopped.images.every(image => !image.src && !image.loaded), "leave cancels queued starts before the next task");

    await reset(controlled, { count: 48, failCoverIds: ["v0"] });
    await controlled.waitForFunction(() => fixture.coverState().images.some(image => image.id === "v0" && image.error));
    const failed = (await controlled.evaluate(() => fixture.coverState())).images.find(image => image.id === "v0");
    assert(failed.started && !failed.pending && !failed.loaded && failed.width === 0, "actual image error path clears pending source and marks failure");
  } finally { await fallback.close(); await controlled.close(); }
  checks++;
}

async function verifyActualEntry() {
  // Unmodified index and its current built bundle: unlike the owner harness,
  // no callback is supplied here by the fixture. This catches missing page
  // composition wiring as well as missing controller activation.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  page.on("pageerror", error => unexpected.push(`actual entry: ${error.message}`));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/synthetic/full-cover-")) requests.push(new URL(request.url()).pathname); });
  await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true } }));
  try {
    await page.goto(`${base}/short-videos/collections/A`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelectorAll(".short-video-card").length === 48);
    await page.waitForFunction(() => { const image = document.querySelector(".short-video-cover-image"); return image?.naturalWidth > 0 && image.classList.contains("is-loaded"); });
    const read = () => page.evaluate(() => [...document.querySelectorAll(".short-video-cover-image")].map(image => ({ id: image.dataset.videoId,
      src: image.getAttribute("src"), pending: Boolean(image.dataset.src), width: image.naturalWidth, loaded: image.classList.contains("is-loaded") })));
    const initial = await read();
    assert.equal(initial.length, 48);
    assert(initial.some(image => image.src && image.width > 0 && image.loaded), "actual entry decodes a first-page cover through production wiring");
    await page.evaluate(() => { window.__entryFirstCard = document.querySelector(".short-video-card"); });
    await page.locator(".short-video-collection-load-more").click();
    await page.waitForFunction(() => document.querySelectorAll(".short-video-card").length === 96);
    await page.locator('.short-video-card[data-video-id="v95"]').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => { const image = document.querySelector('.short-video-card[data-video-id="v95"] img'); return image?.naturalWidth > 0 && image.classList.contains("is-loaded"); });
    const after = await read();
    assert(after.slice(48).some(image => image.src && image.width > 0 && image.loaded), "actual bundle activates and decodes appended covers");
    assert(await page.evaluate(() => window.__entryFirstCard === document.querySelector(".short-video-card")), "actual bundle retains first-page card identity");
    assert(requests.some(value => value === "/synthetic/full-cover-0.svg"));
    assert(requests.some(value => value === "/synthetic/full-cover-95.svg"));
    assert(fullEntryRequests.some(value => value.startsWith("/api/short-videos/collections/A/videos?")));
    checks++;
    return { initial: { cards: initial.length, decoded: initial.filter(image => image.loaded && image.width > 0).length },
      appended: { cards: after.length, newDecoded: after.slice(48).filter(image => image.loaded && image.width > 0).length },
      syntheticSvgRequests: requests.length };
  } finally { await page.close(); }
}

async function browserHarness({ version, coverMode }) {
  const { createShortVideoCollectionsController } = await import(`/modules/short-videos/fixture-controller.js?version=${version}`);
  const { createShortVideoListCards } = await import("/modules/short-videos/list-cards.js");
  const { createIcon } = await import("/modules/short-videos/icons.js");
  const { createShortVideoListWindow } = await import("/modules/short-videos/list-window.js");
  const workGrid = document.querySelector("#workGrid");
  let controller, listWindow, state, records, opens, toasts, routes, gates, nodes, metrics, total, serverVideos, userPosition, navigationErrors;
  let coverActivations = [], loadedCoverIds = new Set(), failedCoverIds = new Set(), rememberedImages = [], retiredCover = null;
  const observers = [];
  if (coverMode === "none") delete window.IntersectionObserver;
  if (coverMode === "controlled") window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(image) { this.observed.add(image); }
    unobserve(image) { this.observed.delete(image); }
    disconnect() { this.observed.clear(); }
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  const video = i => ({ id: `v${i}`, title: `Synthetic video ${i}`, coverUrl: failedCoverIds.has(`v${i}`) ? "/synthetic/failure.svg" : `/synthetic/${i}.svg`, mediaType: i % 13 === 0 ? "gallery" : "video",
    galleryCount: i % 13 === 0 ? 3 : 0, durationMs: 12000, author: { id: "fixture-author", secUid: "fixture-author", name: "Private Author" },
    stats: { likes: i * 3, comments: 2 }, actions: { liked: i % 7 === 0 }, publishedAt: "2026-01-01", watch: { lastWatchedAt: i % 5 === 0 ? "2026-01-02" : "", progressMs: 1200 } });
  const videoRange = (start, length) => Array.from({ length }, (_, i) => video(start + i));
  const collection = id => ({ id, name: `Collection ${id}`, itemCount: serverVideos[id]?.length || 0 });
  const body = (id, offset = 0, size = 48) => ({ collection: collection(id), videos: copy((serverVideos[id] || []).slice(offset, offset + size)), total: serverVideos[id]?.length || 0,
    hasMore: offset + size < (serverVideos[id]?.length || 0), nextCursor: offset + size < (serverVideos[id]?.length || 0) ? `cursor-${offset + size}` : null, limit: 48, offset: 0, cursor: offset ? `cursor-${offset}` : null });
  const emptyMetrics = () => ({ cards: 0, cardElements: 0, images: 0 });
  function api(requestPath, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    records.push({ path: requestPath, method, body: options.body || null });
    const complete = override => {
      const url = new URL(requestPath, location.origin), match = /^\/api\/short-videos\/collections\/([^/]+)\/videos(?:\/([^/]+))?$/.exec(url.pathname);
      if (url.pathname === "/api/short-videos/collections") return { collections: Object.keys(serverVideos).map(collection) };
      if (!match) throw new Error(`Unexpected fixture API: ${requestPath}`);
      const id = decodeURIComponent(match[1]), videoId = match[2] && decodeURIComponent(match[2]);
      if (method === "DELETE") { serverVideos[id] = (serverVideos[id] || []).filter(row => row.id !== videoId); return { ok: true, removed: true, collectionId: id, videoId }; }
      if (videoId) {
        const index = serverVideos[id].findIndex(row => row.id === videoId), rows = serverVideos[id];
        return { collection: collection(id), video: copy(rows[index]), prevId: rows[index - 1]?.id || "", nextId: rows[index + 1]?.id || "", prevVideo: rows[index - 1] || null, nextVideo: rows[index + 1] || null };
      }
      const offset = Number(/^cursor-(\d+)$/.exec(url.searchParams.get("cursor") || "")?.[1] || 0);
      return { ...body(id, offset), ...override };
    };
    const gate = gates.find(gate => !gate.used && gate.method === method && requestPath.includes(gate.part));
    if (!gate) return Promise.resolve().then(() => complete());
    gate.used = true;
    return new Promise((resolve, reject) => { gate.resolve = override => resolve(complete(override)); gate.reject = message => reject(new Error(message)); });
  }
  function render() {
    // Mirrors the actual page owner's full-render/leave lifecycle. Appends do
    // not call render, so the product must activate just their new cards.
    listWindow?.reset();
    workGrid.replaceChildren();
    if (state.activeView !== "shortVideos") { workGrid.textContent = "Other view"; return; }
    if (state.shortVideo.current) { const viewer = document.createElement("div"); viewer.textContent = "Private playback boundary"; workGrid.append(viewer); return; }
    if (state.shortVideo.mode === "collection") workGrid.append(controller.renderCollectionPage());
  }
  async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }
  function reset({ count = 145, initial = 48, failCoverIds = [] } = {}) {
    controller?.cancelReads();
    listWindow?.reset();
    coverActivations = []; loadedCoverIds = new Set(); failedCoverIds = new Set(failCoverIds); rememberedImages = [];
    records = []; opens = []; toasts = []; routes = []; gates = []; nodes = null; navigationErrors = []; metrics = emptyMetrics(); total = emptyMetrics();
    serverVideos = { A: videoRange(0, count), B: videoRange(2000, 3) };
    const data = body("A", 0, Math.min(initial, count));
    state = { activeView: "shortVideos", shortVideo: { mode: "collection", collectionId: "A", collectionData: data,
      data: { videos: data.videos, total: data.total, hasMore: data.hasMore, nextCursor: data.nextCursor }, collections: [collection("A"), collection("B")],
      collectionsLoaded: true, collectionsLoading: false, collectionLoading: false, collectionError: "", current: null, prevId: "", nextId: "", prevVideo: null, nextVideo: null,
      source: "all", sort: "published", query: "", author: "all", deleteMode: false } };
    const cards = createShortVideoListCards({ state, createIcon, coverEagerCount: 8, applyShortVideoLikeBadgeState: (node, row) => node.classList.toggle("is-liked", Boolean(row.actions?.liked)),
      authorScopeId: row => row.author?.secUid || "fixture-author", cardTitle: row => row.title, ensureShortVideoViewerStyles: async () => {},
      formatDate: value => value, formatDuration: ms => `${Math.floor(ms / 1000)}s`, formatNumber: String, formatSeconds: String,
      formatShortVideoMetric: (row, key) => String(row.stats?.[key] || 0), galleryBadge: row => { const span = document.createElement("span"); span.textContent = `图文 ${row.galleryCount}`; return span; },
      galleryLabel: () => "图文", initials: value => value.slice(0, 1), isGalleryPost: row => row.mediaType === "gallery", isShortVideoAuthorDetailPage: () => false,
      openShortVideoAuthorPage() {}, openVideo: async () => { throw new Error("collection capture must own card opening"); }, prewarmShortVideoPlayback: async () => {}, rememberShortVideo() {},
      shortVideoAuthorHandle: value => value, shortVideoCardCoverUrl: row => row.coverUrl, shortVideoDeleteSelection: () => new Set(), showError: error => toasts.push(error.message), toggleShortVideoSelected() {} });
    const measuredCards = { ...cards, renderVideoCard(...args) {
      const card = cards.renderVideoCard(...args);
      const local = metrics, aggregate = total;
      local.cards++; aggregate.cards++;
      const images = card?.querySelectorAll("img").length || 0;
      local.images += images; aggregate.images += images;
      // Observe after the controller appended its actual remove control. This
      // includes SVG descendants created by icon innerHTML, without retaining
      // old detached cards merely to count them later.
      queueMicrotask(() => { const elements = card ? card.querySelectorAll("*").length + 1 : 0;
        local.cardElements += elements; aggregate.cardElements += elements; });
      return card;
    } };
    listWindow = createShortVideoListWindow({ getState: () => state, isAuthorDetailPage: () => false,
      loadVideos: async () => {}, markCacheState() {}, markPerformance() {},
      rememberLoadedCoverId: id => loadedCoverIds.add(String(id)), renderVideoCard: measuredCards.renderVideoCard,
      shortVideoCardCoverUrl: row => row.coverUrl, shortVideosWithCovers: rows => rows,
      showError: error => toasts.push(error.message), wasCoverLoaded: id => loadedCoverIds.has(String(id)) });
    controller = createShortVideoCollectionsController({ state, api, createIcon, ensureListCards: async () => measuredCards, getListCards: () => measuredCards,
      activateCardCovers(cards) { coverActivations.push(...cards.map(card => card.dataset.videoId)); listWindow.activateCoversForNodes(cards); },
      releaseCardCovers: cards => listWindow.releaseCoversForNodes(cards),
      render, showToast: value => toasts.push(value), pushRoute: value => routes.push(value), replaceRoute: value => routes.push(value), setMainHeader() {}, loadFeed() {}, onScopeChange() {}, onNavigationChange() {},
      onOpenVideo(row, options) { opens.push({ video: copy(row), options: copy(options), loaded: state.shortVideo.collectionData.videos.map(row => row.id),
        hasMore: state.shortVideo.collectionData.hasMore, nextCursor: state.shortVideo.collectionData.nextCursor, navigation: copy(controller.collectionNavigation(row.id)) });
        state.shortVideo.current = row; render(); return true; } });
    render();
  }
  function snapshot() {
    return copy({ state, requests: records, opens, toasts, routes, navigationErrors, cardIds: [...document.querySelectorAll('.short-video-card')].map(card => card.dataset.videoId),
      header: document.querySelector('.short-video-collection-page-header h2')?.textContent || "", meta: document.querySelector('.short-video-collection-page-header p')?.textContent || "",
      emptyText: document.querySelector('.short-video-empty')?.textContent || "", hasMoreButton: Boolean(document.querySelector('.short-video-collection-load-more')) });
  }
  function rememberNodes() { nodes = { cards: [...document.querySelectorAll('.short-video-card')], header: document.querySelector('.short-video-collection-page-header'), sidebar: document.querySelector('.short-video-collection-sidebar'), more: document.querySelector('.short-video-collection-load-more'), back: document.querySelector('.short-video-collection-back') }; }
  function retained(removedId = "") { return { cards: Boolean(nodes && nodes.cards.filter(card => card.dataset.videoId !== removedId).every(card => card.isConnected)), header: nodes?.header === document.querySelector('.short-video-collection-page-header'), sidebar: nodes?.sidebar === document.querySelector('.short-video-collection-sidebar'), more: nodes?.more === document.querySelector('.short-video-collection-load-more'), moreFocused: document.activeElement === nodes?.more }; }
  window.fixture = { ready: true, reset, settle, snapshot, videoRange, rememberNodes, retained,
    intersectCover(id) { const image = workGrid.querySelector(`.short-video-card[data-video-id="${id}"] img`);
      const observer = observers.findLast(value => value.observed.has(image));
      if (!observer) throw new Error(`No observed synthetic cover ${id}`);
      observer.callback([{ target: image, isIntersecting: true }]); },
    captureCoverCallbacks(observerId, loadingId) { retiredCover = { observer: observers.at(-1),
      target: workGrid.querySelector(`.short-video-card[data-video-id="${observerId}"] img`),
      image: workGrid.querySelector(`.short-video-card[data-video-id="${loadingId}"] img`) }; },
    resetCoverLoader() { listWindow.reset(); loadedCoverIds.clear(); },
    reactivateCoverNodes() { listWindow.activateCoversForNodes([...workGrid.querySelectorAll(".short-video-card")]); },
    deliverRetiredCoverCallbacks() { retiredCover.observer.callback([{ target: retiredCover.target, isIntersecting: true }]);
      retiredCover.image.dispatchEvent(new Event("load")); retiredCover.image.dispatchEvent(new Event("error")); },
    rememberCoverImages() { rememberedImages = [...workGrid.querySelectorAll("img.short-video-cover-image")]; },
    coverState(remembered = false) { return { activated: [...coverActivations], loadedIds: [...loadedCoverIds],
      observed: observers.flatMap(observer => [...observer.observed].map(image => image.dataset.videoId)),
      images: [...(remembered ? rememberedImages : workGrid.querySelectorAll("img.short-video-cover-image"))].map(image => ({ id: image.dataset.videoId,
        src: image.getAttribute("src"), pending: Boolean(image.dataset.src), started: image.dataset.loaded === "1",
        loaded: image.classList.contains("is-loaded"), error: image.classList.contains("is-cover-error"), width: image.naturalWidth })) }; },
    get state() { return state; }, metrics: () => ({ ...metrics }), totalMetrics: () => ({ ...total }), resetMetrics: () => { metrics = emptyMetrics(); },
    hold(method, part, name) { gates.push({ method, part, name, used: false }); },
    resolve(name, body) { const gate = gates.find(gate => gate.name === name); if (!gate?.resolve) throw new Error(`Unreached gate ${name}`); gate.resolve(body); },
    reject(name, message) { const gate = gates.find(gate => gate.name === name); if (!gate?.reject) throw new Error(`Unreached gate ${name}`); gate.reject(message); },
    activateOldControls() { nodes.cards[0]?.querySelector('.short-video-collection-remove')?.click(); nodes.cards[0]?.querySelector('.short-video-thumb-open')?.click(); nodes.more?.click(); },
    activateOldBack() { nodes.back?.click(); },
    captureUserPosition() { userPosition = { focused: document.activeElement, scrollY }; },
    userPositionRetained() { return document.activeElement === userPosition.focused && Math.abs(scrollY - userPosition.scrollY) < 2; },
    navigate(id) { controller.openCollection(id, { skipRoute: true }).catch(error => navigationErrors.push(error.message)); },
    leave() { controller.cancelReads(); state.activeView = "people"; render(); }
  };
  reset();
}

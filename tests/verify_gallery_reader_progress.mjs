import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

const args = process.argv.slice(2);
assert(args.length <= 1 && args.every(value => ["--linear-progress", "--repeat-progress-writes"].includes(value)), "known single negative control");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(project, "public");
const owner = "public/modules/content-index/gallery-renderer.js";
const beforeSource = execFileSync("git", ["show", `63c5fab243233e142cfd62c4eaf13812feb92405:${owner}`], { cwd: project, encoding: "utf8" }).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(beforeSource).digest("hex"), "1e5c4b9cf39924d46ce2e036e4facd0bbe70bf1e7fd0778b7cd2ba58d1da2982", "fixed complete original renderer");
let currentSource = fs.readFileSync(path.join(project, owner), "utf8").replace(/\r\n/g, "\n");
if (args.includes("--linear-progress")) {
  const start = currentSource.indexOf("    // Reader figures occupy consecutive rows."), endMarker = "    const current = figures[Math.min(start, figures.length - 1)];";
  const end = currentSource.indexOf(endMarker, start);
  assert(start >= 0 && end > start, "one binary selection boundary");
  currentSource = currentSource.slice(0, start) + "    const current = figures.find((figure) => figure.getBoundingClientRect().bottom >= readingLine) || figures.at(-1);" + currentSource.slice(end + endMarker.length);
}
if (args.includes("--repeat-progress-writes")) for (const [checked, unconditional] of [
  ["if (progress.dataset.currentIndex !== indexValue) progress.dataset.currentIndex = indexValue;", "progress.dataset.currentIndex = indexValue;"],
  ["if (progress.textContent !== progressText) progress.textContent = progressText;", "progress.textContent = progressText;"],
  ['if (toolbar.style.getPropertyValue("--reader-progress") !== progressValue) toolbar.style.setProperty("--reader-progress", progressValue);', 'toolbar.style.setProperty("--reader-progress", progressValue);']
]) {
  assert.equal(currentSource.split(checked).length, 2, "one production write guard"); currentSource = currentSource.replace(checked, unconditional);
}
function observedSource(source) {
  // Shared, reversible observation only: retain the entire owner and native
  // geometry. No loader implementation, dimensions, src or loaded class is faked.
  const start = source.indexOf("  const reportProgress = () => {"), end = source.indexOf("  const requestProgress = () => {", start);
  assert(start >= 0 && end > start);
  let report = source.slice(start, end);
  report = report.replace("    progressTicking = false;", "    const measured = window.__progressMeter?.enabled;\n    if (measured) { __progressMeter.reports++; window.__progressReporting = true; }\n    try {\n    progressTicking = false;");
  report = report.replace(/  \};\s*$/u, "    } finally { window.__progressReporting = false; }\n  };\n");
  source = source.slice(0, start) + report + "  window.__progressReport = reportProgress;\n" + source.slice(end);
  const slot = "  return {\n    mediaKindForMode:";
  assert.equal(source.split(slot).length, 2);
  return source.replace(slot, "  window.__progressCleanup = resetGalleryRenderedState;\n" + slot);
}
const sources = { before: observedSource(beforeSource), current: observedSource(currentSource) };
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executablePath, "private fixture needs Chromium");
const unexpected = [], imageRequests = [];
let browser, base, comparisons = 0;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture"), send = (body, type) => { res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
    if (url.pathname === "/probe") return send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/modules/content-index/styles.css"><body class="gallery-view"><main><div id="statsRow"></div><div id="workGrid"></div></main><script type="module">(${harness.toString()})(${JSON.stringify(url.searchParams.get("version"))});</script></body></html>`, "text/html; charset=utf-8");
    if (url.pathname === "/modules/content-index/fixture-gallery-renderer.js") return send(sources[url.searchParams.get("version")], "text/javascript");
    if (url.pathname.startsWith("/synthetic/")) {
      imageRequests.push(url.pathname); const tall = url.pathname.includes("tall");
      return send(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${tall ? 1200 : 850}"><rect width="600" height="${tall ? 1200 : 850}" fill="#547b6b"/></svg>`, "image/svg+xml");
    }
    const file = path.resolve(publicRoot, url.pathname.replace(/^\/+/, "")); assert(file.startsWith(`${publicRoot}${path.sep}`));
    return send(await fs.promises.readFile(file), file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
  } catch (error) { unexpected.push(`${req.url}: ${error.message}`); res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${server.address().port}`;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const before = await open("before"), current = await open("current");
  let screenshotPath;
  try {
    const expected = await contracts(before), actual = await contracts(current);
    // Independent native decodes and content-visibility remembered sizes can
    // produce different live reading positions. Compare all static visible DOM
    // across complete owners; each check separately asserts the exact progress
    // tuple against the original linear rule on that same current native DOM.
    const visible = rows => rows.map(({ index: _index, text: _text, percentage: _percentage, ...row }) => ({ ...row,
      figures: row.figures.map(({ loading: _loading, ...figure }) => figure) }));
    assert.deepEqual(visible(actual), visible(expected), "complete renderer static visible DOM"); comparisons = actual.length;
    const measurements = [];
    for (const count of [200, 1000, 3000]) {
      const previous = await measure(before, count), next = await measure(current, count);
      measurements.push({ count, before: previous, after: next });
    }
    // Both controls run every output/lifecycle contract before these independent
    // work budgets fail. Time is diagnostic and has no pass/fail threshold.
    for (const row of measurements) {
      assert(row.before.rectReads > row.before.reports * row.count / 2, "original actual rAF callback scans the late reading position");
      assert(row.after.rectReads <= row.after.reports * (Math.ceil(Math.log2(row.count)) + 1), "live progress geometry reads are logarithmic per rAF report");
      assert.equal(row.after.mutations, 0, "same index/total creates no repeated native toolbar mutations");
      assert(row.before.mutations >= row.before.reports, "original actual DOM writes are observable independently of geometry");
    }
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-reader-progress-")); screenshotPath = path.join(folder, "reader-progress-320.png");
    await current.setViewportSize({ width: 320, height: 640 }); await reset(current, 12); await current.screenshot({ path: screenshotPath });
    console.log(JSON.stringify({ fixture: "gallery-reader-progress", comparisons, measurements, screenshotPath }, null, 2));
  } finally { await before.close(); await current.close(); }
  assert.deepEqual(unexpected, []); assert(imageRequests.length > 0, "native SVG loader really requested private images");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
// Reuse the existing private original-index/standalone-module composition,
// synthetic API and native image transport instead of duplicating its server.
assert.equal((await runGalleryReaderFixture({ casePattern: "host late album success" })).checks, 1);
console.log("Gallery reader progress: actual standalone entry PASS");

async function open(version) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => unexpected.push(error.message));
  await page.route(new RegExp(`^https?://(?!127\\.0\\.0\\.1:${server.address().port}(?:/|$))`), route => route.abort());
  await page.goto(`${base}/probe?version=${version}`, { waitUntil: "networkidle" }); await page.waitForFunction(() => window.fixture?.ready); return page;
}
function tick(page) { return page.evaluate(() => fixture.tick()); }
async function reset(page, count, total = count) {
  await page.evaluate(({ count, total }) => fixture.reset(count, total), { count, total }); await tick(page);
  if (count) {
    await page.waitForFunction(() => { const image = document.querySelector(".gallery-reader-figure img"); return image?.getAttribute("src") && image.complete && image.naturalWidth > 0; });
    await page.locator(".gallery-reader-figure img").first().evaluate(image => image.decode());
  }
  return check(page);
}
function check(page) { return page.evaluate(() => fixture.check()); }
async function contracts(page) {
  const output = [await reset(page, 12)];
  assert.equal(output[0].index, "1", "native top starts at the first figure");
  for (const at of [0, 5, 11]) { await page.locator(".gallery-reader-figure").nth(at).scrollIntoViewIfNeeded(); await tick(page); output.push(await check(page)); }
  const bottom = await page.evaluate(() => { scrollTo(0, document.documentElement.scrollHeight); return fixture.check(); });
  assert.equal(bottom.index, "12", "native document bottom resolves the final figure"); output.push(bottom);
  for (const name of ["原始大小", "适应宽度"]) { await page.getByRole("button", { name, exact: true }).press("Enter"); await tick(page); output.push(await check(page)); }
  for (const viewport of [{ width: 320, height: 640 }, { width: 740, height: 320 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport); await tick(page); output.push(await check(page));
  }
  output.push(await page.evaluate(() => fixture.boundary(false)), await page.evaluate(() => fixture.boundary(true)));
  await page.evaluate(() => { const viewer = document.querySelector(".gallery-reader-images"); viewer.dataset.totalCount = "1000"; }); output.push(await check(page));
  await page.evaluate(() => { document.querySelector(".gallery-reader-images").dataset.totalCount = "1"; }); output.push(await check(page));
  await page.evaluate(() => fixture.replaceToolbar()); output.push(await check(page));
  await page.evaluate(() => { const progress = document.querySelector(".gallery-reader-progress"); progress.dataset.currentIndex = "wrong"; progress.textContent = "wrong"; progress.closest(".gallery-reader-toolbar").style.setProperty("--reader-progress", "wrong"); }); output.push(await check(page));
  await page.evaluate(() => { const progress = document.querySelector(".gallery-reader-progress"); progress.replaceWith(progress.cloneNode(false)); }); output.push(await check(page));
  // Real image load changes dimensions. This changes image data, rather than
  // substituting geometry or pretending that the loader decoded a response.
  await reset(page, 12); await page.evaluate(() => { const first = fixture.state.gallery.album.images[0]; first.url = "/synthetic/tall.svg"; fixture.renderer.renderView(); }); await tick(page);
  await page.waitForFunction(() => document.querySelector(".gallery-reader-figure img")?.naturalHeight === 1200); output.push(await check(page));
  await reset(page, 12, 24); await page.locator(".gallery-more").click(); await tick(page); output.push(await check(page));
  assert.equal(output.at(-1).figures.length, 24);
  await reset(page, 0); output.push(await check(page));
  await reset(page, 8); await page.evaluate(() => fixture.leave()); await tick(page);
  assert.deepEqual(await page.evaluate(async () => { fixture.startMeter(); dispatchEvent(new Event("scroll")); dispatchEvent(new Event("resize")); await fixture.tick(); return fixture.stopMeter(); }), { reports: 0, rectReads: 0, mutations: 0, addedText: 0 }, "leaving removes native progress listeners");
  return output;
}
async function measure(page, count) {
  await page.setViewportSize({ width: 1280, height: 900 }); await reset(page, count);
  await page.locator(".gallery-reader-figure").nth(Math.floor(count * 0.8)).scrollIntoViewIfNeeded(); await tick(page);
  await page.waitForFunction(() => [...document.querySelectorAll(".gallery-reader-figure img")].filter(image => { const box = image.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; }).every(image => image.complete && image.naturalWidth > 0));
  await check(page); await tick(page);
  return page.evaluate(async () => {
    const baseTop = scrollY; fixture.startMeter(); const started = performance.now();
    for (let i = 0; i < 32; i++) { scrollTo(0, baseTop + (i % 2) * 2); dispatchEvent(new Event("scroll")); await new Promise(requestAnimationFrame); }
    await fixture.tick(); const result = fixture.stopMeter();
    if (result.reports < 24) throw Error("actual rAF progress reports were not observed");
    return { ...result, instrumentedDiagnosticMs: performance.now() - started };
  });
}

async function harness(version) {
  const { createGalleryRenderer } = await import(`/modules/content-index/fixture-gallery-renderer.js?version=${version}`);
  const state = { activeView: "gallery", accessMode: "local", uiConfig: {}, gallery: { mode: "photo", photoView: "albums", category: "all", subCategory: "all", person: "all", photoDate: "all", query: "", sort: "updated", mediaKind: "all", seriesKey: "", visibleLimit: 80, fitWidth: true,
    album: null, comic: null, media: null, data: { totals: {}, facets: {}, photoSets: [] }, status: "" } };
  const workGrid = document.querySelector("#workGrid"), formatNumber = value => new Intl.NumberFormat("zh-CN").format(value || 0);
  const images = count => Array.from({ length: count }, (_, index) => ({ index: index + 1, name: `Synthetic ${index + 1}`, url: `/synthetic/${index + 1}.svg` }));
  const page = { setStatus() {}, setListRefreshHandler() {}, syncRoute() {},
    async loadPhotoReaderImages(limit) { const album = state.gallery.album; album.images = images(Math.min(album.imageCount, limit)); return album; },
    fullPhotoReaderImages: async () => state.gallery.album.images };
  const renderer = createGalleryRenderer({ state, els: { workGrid, statsRow: document.querySelector("#statsRow") }, getGalleryPage: () => page,
    api: async () => { throw Error("private renderer must not request an external API"); }, formatNumber, formatBytes: String, formatDateTime: String,
    includesText: (text, query) => String(text).includes(String(query)), writeStoredFlag() {}, openAdminScript() {}, disconnectPeopleIndexAutoload() {}, cancelScheduledWorkRendering() {}, resetProgressiveCoverLoading() {} });
  const nativeRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function(...args) {
    if (window.__progressMeter?.enabled && window.__progressReporting && this.tagName === "FIGURE") __progressMeter.rectReads++;
    return Reflect.apply(nativeRect, this, args);
  };
  let observer;
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
  function startMeter() {
    observer?.disconnect(); window.__progressMeter = { enabled: true, reports: 0, rectReads: 0, mutations: 0, addedText: 0 };
    observer = new MutationObserver(records => { if (!__progressMeter.enabled) return; __progressMeter.mutations += records.length;
      for (const record of records) __progressMeter.addedText += [...record.addedNodes].filter(node => node.nodeType === Node.TEXT_NODE).length; });
    const toolbar = workGrid.querySelector(".gallery-reader-toolbar"); if (toolbar) observer.observe(toolbar, { subtree: true, attributes: true, childList: true, characterData: true });
  }
  function stopMeter() { observer?.disconnect(); const { enabled: _enabled, ...result } = __progressMeter; __progressMeter.enabled = false; return result; }
  function reset(count, total = count) {
    window.__progressReport = null; state.activeView = "gallery"; state.gallery.fitWidth = true;
    state.gallery.album = { id: "A", title: "Synthetic album", category: "Private", imageCount: total, images: images(count) };
    renderer.renderView(); scrollTo(0, 0);
  }
  function check() {
    const figures = [...workGrid.querySelectorAll(".gallery-reader-figure")], viewer = workGrid.querySelector(".gallery-reader-images"), progress = workGrid.querySelector(".gallery-reader-progress"), toolbar = progress?.closest(".gallery-reader-toolbar");
    const bottoms = figures.map(figure => figure.getBoundingClientRect().bottom);
    if (!bottoms.every((value, index) => index === 0 || value >= bottoms[index - 1])) throw Error("actual single-column figure bottoms ceased to be monotonic");
    if (figures.length) {
      const line = Math.max(1, innerHeight * 0.46), current = figures.find(figure => figure.getBoundingClientRect().bottom >= line) || figures.at(-1);
      const index = Math.max(1, Number(current?.dataset.imageIndex || 1)), total = Math.max(index, Number(viewer.dataset.totalCount || figures.length));
      window.__progressReport();
      if (progress.dataset.currentIndex !== String(index) || progress.textContent !== `${formatNumber(index)} / ${formatNumber(total)}` || toolbar.style.getPropertyValue("--reader-progress") !== `${Math.min(100, index / Math.max(1, total) * 100)}%`) throw Error("real current DOM disagrees with the complete original first-bottom>=readingLine rule");
    } else if (!progress.hidden || progress.textContent !== "" || progress.dataset.currentIndex !== "1") throw Error("empty reader retains the original hidden initial counter");
    return { index: progress?.dataset.currentIndex, text: progress?.textContent, percentage: toolbar?.style.getPropertyValue("--reader-progress"), hidden: progress?.hidden,
      viewerClass: viewer?.className, total: viewer?.dataset.totalCount, title: workGrid.querySelector(".gallery-reader-title")?.textContent,
      controls: [...workGrid.querySelectorAll(".gallery-reader-toolbar button")].map(button => ({ text: button.textContent, pressed: button.getAttribute("aria-pressed"), disabled: button.disabled })),
      figures: figures.map(figure => ({ index: figure.dataset.imageIndex, role: figure.getAttribute("role"), tabIndex: figure.tabIndex, label: figure.getAttribute("aria-label"), caption: figure.querySelector("figcaption")?.textContent, alt: figure.querySelector("img")?.alt, loading: figure.querySelector("img")?.loading, decoding: figure.querySelector("img")?.decoding })) };
  }
  function boundary(duplicates) {
    const viewer = workGrid.querySelector(".gallery-reader-images"), figures = [...viewer.children], target = figures[duplicates ? 1 : 4];
    const styles = [viewer.getAttribute("style"), figures[0].getAttribute("style"), figures[1].getAttribute("style")];
    if (duplicates) { viewer.style.gap = "0px"; for (const figure of figures.slice(0, 2)) { figure.style.height = "0px"; figure.style.minHeight = "0px"; } }
    const line = Math.max(1, innerHeight * 0.46), delta = line - target.getBoundingClientRect().bottom; viewer.style.transform = `translateY(${delta}px)`;
    if (Math.abs(target.getBoundingClientRect().bottom - line) > 0.02) throw Error("native exact-boundary geometry was not established");
    const result = check(); const expected = duplicates ? figures[0].dataset.imageIndex : target.dataset.imageIndex;
    if (result.index !== expected) throw Error("equal bottom must choose the first matching figure");
    [viewer, figures[0], figures[1]].forEach((node, index) => styles[index] === null ? node.removeAttribute("style") : node.setAttribute("style", styles[index]));
    return result;
  }
  function replaceToolbar() { const toolbar = workGrid.querySelector(".gallery-reader-toolbar"), clone = toolbar.cloneNode(true); clone.style.removeProperty("--reader-progress"); clone.querySelector(".gallery-reader-progress").textContent = ""; toolbar.replaceWith(clone); }
  window.fixture = { ready: true, state, renderer, tick, reset, check, boundary, startMeter, stopMeter, replaceToolbar,
    leave() { window.__progressCleanup(); state.activeView = "tools"; workGrid.replaceChildren(); } };
}

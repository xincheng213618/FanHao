import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual IndexedDB and Android app served on private loopback with synthetic text.
const www = fileURLToPath(new URL("../android-client/www/", import.meta.url));
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const errors = [];
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    if (url.pathname === "/seed") { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>Local reader fixture</title>"); return; }
    const filename = path.resolve(www, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert(filename.startsWith(www));
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(filename)];
    response.writeHead(200, { "Content-Type": type || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(fs.readFileSync(filename));
  } catch (error) { errors.push(error.message); response.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const id = "local:reader-scale";
const chapterCount = 20000;
const middle = 10000;
let browser;

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.addInitScript(() => {
    localStorage.setItem("fanhao.serverUrl", location.origin);
    window.__chapterReads = { catalogRows: 0, chapterBodies: 0, pointRows: 0, neighborRows: 0 };
    const getAll = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function (...args) {
      const request = getAll.apply(this, args);
      if (this.objectStore.name === "chapterMetadata" && this.objectStore.transaction.mode === "readonly") {
        request.addEventListener("success", () => { __chapterReads.catalogRows += request.result.length; });
      }
      return request;
    };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      if (this.transaction.mode === "readonly" && this.name === "chapterBodies") __chapterReads.chapterBodies++;
      if (this.transaction.mode === "readonly" && this.name === "chapterMetadata") __chapterReads.pointRows++;
      return get.apply(this, args);
    };
    const openCursor = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = function (...args) {
      const request = openCursor.apply(this, args);
      if (this.transaction.mode === "readonly" && this.name === "chapterMetadata") {
        request.addEventListener("success", () => { if (request.result) __chapterReads.neighborRows++; });
      }
      return request;
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => url.origin !== base, route => route.abort());
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/modules") return route.fulfill({ json: { modules: [] } });
    if (pathname === "/api/library") return route.fulfill({ json: { people: [], works: [], totals: {}, user: {}, availableRoots: [], access: { mode: "loopback" } } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/seed`);
  const measured = await page.evaluate(async ({ id, chapterCount, middle }) => {
    const { saveLocalNovelEntry, readLocalNovelChapter } = await import("/js/local-novels.js");
    await saveLocalNovelEntry({ book: { id, title: "合成大部头", sourceType: "local-file" }, chapters: Array.from({ length: chapterCount }, (_, i) => ({
      index: i + 1, title: `章节 ${i + 1}`, content: `仅用于验证的第 ${i + 1} 章。\n\n${"合成文本。".repeat(160)}`
    })) }, { expectedGeneration: null });
    const timings = { full: [], narrow: [] };
    for (let i = 0; i < 7; i++) {
      const index = middle + i;
      let start = performance.now();
      const full = await readLocalNovelChapter(id, index);
      timings.full.push(performance.now() - start);
      start = performance.now();
      const narrow = await readLocalNovelChapter(id, index, { includeCatalog: false, chapterId: full.chapter.id, catalogRevision: full.book.catalogRevision });
      timings.narrow.push(performance.now() - start);
      if (full?.chapter?.index !== index || JSON.stringify({ ...full, chapters: [] }) !== JSON.stringify(narrow)) {
        throw new Error("bounded read changed the requested body, neighbors, or book snapshot");
      }
    }
    return { reads: { ...__chapterReads }, timings };
  }, { id, chapterCount, middle });
  assert.deepEqual(measured.reads, { catalogRows: chapterCount * 7, chapterBodies: 14, pointRows: 7, neighborRows: 14 });
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(`IndexedDB chapter read: ${chapterCount}→3 metadata records and one body per chapter, median ${median(measured.timings.full).toFixed(1)}→${median(measured.timings.narrow).toFixed(1)} ms (7 paired reads).`);

  await page.goto(`${base}/#novelReader?id=${encodeURIComponent(id)}&chapterIndex=${middle}`);
  const content = page.locator(".novel-reader-content p").first();
  const assertChapter = index => page.locator(".novel-reader-content").getByText(`仅用于验证的第 ${index} 章。`, { exact: true }).waitFor();
  await assertChapter(middle);
  assert.deepEqual(await page.evaluate(() => __chapterReads), { catalogRows: 0, chapterBodies: 1, pointRows: 1, neighborRows: 2 });
  await content.click();
  await page.getByRole("button", { name: "下一章", exact: true }).click();
  await assertChapter(middle + 1);
  assert.deepEqual(await page.evaluate(() => __chapterReads), { catalogRows: 0, chapterBodies: 2, pointRows: 2, neighborRows: 4 });
  await content.click();
  await page.getByRole("button", { name: "目录", exact: true }).click();
  const drawer = page.locator(".novel-reader-catalog-drawer");
  await drawer.getByText(`章节 ${middle + 1}`, { exact: true }).waitFor();
  assert.equal(await drawer.locator(".novel-mobile-chapter").count(), 80);
  assert.deepEqual(await page.evaluate(() => __chapterReads), { catalogRows: chapterCount, chapterBodies: 2, pointRows: 2, neighborRows: 4 });
  console.log("Actual Android app: first chapter and next chapter use the bounded window; opening the drawer loads the catalog at the current chapter without more bodies.");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

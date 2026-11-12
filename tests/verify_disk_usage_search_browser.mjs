import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const publicRoot = fileURLToPath(new URL("../public", import.meta.url));
const diskPath = "/modules/fanhao/disk-usage/index.html";
const drives = ["A", "B", "C", "D", "E", "F"].map((id) => ({
  id, name: `Fixture ${id}`, root: `${id}:/`,
  capacity: { available: id !== "B" },
  cache: id === "F" ? null : { scanId: `scan-${id}`, completedAt: "2026-11-13T00:00:00.000Z" }
}));
const driveA = drives[0];
const driveB = drives[1];
const makeItem = (drive, name, size, { directory = false, parent = drive.root } = {}) => ({
  name, path: `${parent}${name}`, parentPath: drive.root, size,
  extension: directory ? "" : path.extname(name), isDirectory: directory,
  fileCount: directory ? 2 : 0, directoryCount: 0
});
const reportA = makeItem(driveA, "report-a.txt", 120);
const reportB = makeItem(driveB, "report-b.png", 310);
const folderB = makeItem(driveB, "report-folder", 210, { directory: true });
const requests = [];
const firstWaveStarted = Promise.withResolvers();
const releaseFirstWave = Promise.withResolvers();
const outdatedStarted = Promise.withResolvers();
const releaseOutdated = Promise.withResolvers();
let failB = true;
let activeReads = 0;
let peakReads = 0;

function json(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  const drive = drives.find(({ id }) => id === url.searchParams.get("drive"));
  const query = url.searchParams.get("q");
  requests.push({ url, method: request.method });
  if (url.pathname === "/api/modules") return json(response, { modules: [] });
  if (url.pathname === "/api/disk-usage/summary") return json(response, { drives });
  if (url.pathname === "/api/disk-usage/tree") {
    const target = url.searchParams.get("path");
    const root = makeItem(drive, "", 1000, { directory: true });
    root.name = drive.name;
    root.parentPath = "";
    const children = target === folderB.path ? [] : drive === driveA ? [reportA] : [];
    const node = target === folderB.path ? folderB : root;
    return json(response, { drive, cache: drive.cache, node, path: target, children });
  }
  if (url.pathname === "/api/disk-usage/search") {
    activeReads++;
    peakReads = Math.max(peakReads, activeReads);
    try {
      if (query === "report" && drive.id === "C") {
        firstWaveStarted.resolve();
        await releaseFirstWave.promise;
      }
      if (query === "report" && drive === driveB && failB) {
        failB = false;
        return json(response, { error: "fixture cache unavailable" }, 503);
      }
      if (query === "outdated" && drive === driveA) {
        outdatedStarted.resolve();
        await releaseOutdated.promise;
        return json(response, { items: [makeItem(drive, "outdated.txt", 1000)] });
      }
      if (query === "newest" && drive === driveB) return json(response, { items: [makeItem(drive, "newest.txt", 400)] });
      if (query === "archive" && ["A", "B"].includes(drive.id)) {
        const count = drive === driveA ? 120 : 6;
        const items = Array.from({ length: count }, (_, index) => makeItem(drive, `archive-${drive.id}-${index}.txt`, 500 + count - index + (drive === driveB ? 200 : 0)));
        return json(response, { items });
      }
      const items = query === "report" ? drive === driveA ? [reportA] : drive === driveB ? [reportB, folderB] : [] : [];
      return json(response, { items });
    } finally {
      activeReads--;
    }
  }
  if (url.pathname === "/api/disk-usage/media") {
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="teal"/></svg>');
    return;
  }
  if (url.pathname === "/api/disk-usage/open" && request.method === "POST") {
    return json(response, { ok: true });
  }
  const target = path.resolve(publicRoot, `.${url.pathname === "/disk-usage" ? diskPath : url.pathname}`);
  if (!target.startsWith(`${publicRoot}${path.sep}`) || !statSync(target, { throwIfNoEntry: false })?.isFile()) {
    response.writeHead(404).end();
    return;
  }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)];
  response.writeHead(200, { "Content-Type": `${type || "application/octet-stream"}; charset=utf-8` });
  createReadStream(target).pipe(response);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath = process.env.FANHAO_CHROME_PATH || [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"
  ].find(existsSync);
  assert.ok(executablePath, "Chrome or Chromium is required for the disk cache search fixture");
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1150, height: 840 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/disk-usage`);
  const scope = page.locator("#searchScope");
  const search = page.locator("#pathSearch");
  const rows = page.locator(".entry-row");
  const searchCalls = () => requests.filter(({ url }) => url.pathname === "/api/disk-usage/search");
  const statusIncludes = (text) => page.waitForFunction((expected) => document.querySelector("#searchStatus").textContent.includes(expected), text);
  const rowWithName = (name) => rows.filter({ hasText: name });
  const source = (record) => record.url.searchParams.get("drive");

  await page.locator(".drive-card[aria-pressed=true]").waitFor();
  assert.equal(await scope.inputValue(), "drive");
  await search.fill("r");
  await page.getByText("请输入至少两个字符。").waitFor();
  assert.equal(searchCalls().length, 0);
  await search.fill("report");
  await rowWithName(reportA.name).waitFor();
  assert.deepEqual(searchCalls().map(source), ["A"]);

  await scope.selectOption("all");
  await firstWaveStarted.promise;
  await rowWithName(reportA.name).waitFor();
  assert.match(await page.locator("#searchStatus").textContent(), /搜索中/);
  assert.ok(peakReads <= 3);
  releaseFirstWave.resolve();
  await page.locator("#searchRetry").waitFor();
  assert.deepEqual(searchCalls().slice(1).map(source).sort(), ["A", "B", "C", "D", "E"]);
  assert.match(await page.locator("#searchStatus").textContent(), /4\/5.*Fixture B/);
  const beforeRetry = searchCalls().length;
  await page.locator("#searchRetry").click();
  await rowWithName(reportB.name).waitFor();
  assert.deepEqual(searchCalls().slice(beforeRetry).map(source), ["B"]);
  assert.deepEqual(await rows.locator(".entry-name").allTextContents(), [reportB.name, folderB.name, reportA.name]);
  assert.match(await rowWithName(reportB.name).textContent(), /Fixture B/);

  const imageRequest = page.waitForRequest((request) => request.url().includes("/api/disk-usage/media"));
  await rowWithName(reportB.name).click();
  assert.equal(new URL((await imageRequest).url()).searchParams.get("drive"), "B");
  const openRequest = page.waitForRequest((request) => request.url().endsWith("/api/disk-usage/open"));
  await page.locator("#previewReveal").click();
  assert.deepEqual((await openRequest).postDataJSON(), { action: "reveal", driveId: "B", path: reportB.path });
  await page.locator("#previewClose").click();

  const treeRequest = page.waitForRequest((request) => new URL(request.url()).searchParams.get("path") === folderB.path);
  await rowWithName(folderB.name).click({ button: "right" });
  await page.getByRole("menuitem", { name: "进入此文件夹" }).click();
  assert.equal(new URL((await treeRequest).url()).searchParams.get("drive"), "B");
  await page.waitForFunction((expected) => new URLSearchParams(location.hash.slice(1)).get("path") === expected, folderB.path);
  assert.equal(await search.inputValue(), "");
  await page.goBack();
  await rowWithName(reportB.name).waitFor();
  assert.equal(await search.inputValue(), "report");
  assert.equal(await scope.inputValue(), "all");
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("drive"), "A");

  await search.fill("outdated");
  await outdatedStarted.promise;
  await search.fill("newest");
  await rowWithName("newest.txt").waitFor();
  releaseOutdated.resolve();
  await statusIncludes("5/5");
  assert.equal(await rowWithName("outdated.txt").count(), 0);
  await search.fill("archive");
  await statusIncludes("最多显示 120 项");
  await statusIncludes("5/5");
  assert.equal(await rows.count(), 120);
  assert.equal(await rows.first().locator(".entry-name").textContent(), "archive-B-0.txt");

  await page.getByRole("button", { name: /Fixture F/ }).click();
  await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get("drive") === "F");
  assert.equal(await search.isEnabled(), true);
  await scope.selectOption("drive");
  assert.equal(await search.isEnabled(), false);
  await scope.selectOption("all");
  assert.equal(await search.isEnabled(), true);
  assert.deepEqual(requests.filter(({ method }) => method !== "GET").map(({ url }) => url.pathname), ["/api/disk-usage/open"]);
  assert.deepEqual(pageErrors, []);
  console.log("Disk cache search browser verification passed.");
} finally {
  releaseFirstWave.resolve();
  releaseOutdated.resolve();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createFileWorkflowService } from "../src/modules/fanhao/server/workflows/file-workflow-service.js";
import { routeFileWorkflows } from "../src/modules/fanhao/server/workflows/routes.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { readJsonBody } from "../src/platform/server/request-io.js";
import { sendJson, notFound } from "../src/platform/server/responses.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = createVerifiedTempDir("fanhao-workflows-ui-");
const source = path.join(temporary.tempDir, "incoming"), target = path.join(temporary.tempDir, "library");
fs.mkdirSync(source); fs.mkdirSync(target);
fs.writeFileSync(path.join(source, "ABC-123-U.mp4"), "synthetic-media-fixture");
fs.writeFileSync(path.join(source, "DEF-456.mp4"), "indexed-fixture");
fs.writeFileSync(path.join(source, "notes.txt"), "notes-fixture");
const service = createFileWorkflowService({ dataDir: path.join(temporary.tempDir, "state"), roots: [source, target], indexedPaths: () => [path.join(source, "DEF-456.mp4")] });
const staticFiles = createStaticFileServer({ publicDir: path.join(repository, "public"),
  mimeTypes: { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" },
  normalizeExt: (file) => path.extname(file), notFound });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    if (await routeFileWorkflows(req, res, url, { service, requireLocalAdmin: () => true, readJsonBody, sendJson })) return;
    staticFiles.serveStatic(req, res, url.pathname);
  } catch (error) { sendJson(res, 500, { error: error.message }); }
});
let browser;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((file) => file && fs.existsSync(file));
  assert(executablePath, "Set CHROME_PATH to Chrome or Edge for the UI fixture");
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/fanhao/file-workflows`);
  await page.waitForFunction(() => document.querySelectorAll("#allowedRoots li").length === 2);
  await page.locator("#source").fill(source); await page.locator("#target").fill(target);
  await page.locator("#preview").click();
  await page.waitForFunction(() => document.getElementById("statusBadge").textContent === "待确认");
  assert.equal(await page.locator("#totalFiles").textContent(), "1");
  assert.equal(await page.locator("#skippedFiles").textContent(), "2");
  assert((await page.locator("#files").textContent()).includes("已入库文件"));
  assert(fs.existsSync(path.join(source, "ABC-123-U.mp4"))); assert.equal(fs.readdirSync(target).length, 0);
  await page.locator("#execute").click(); await page.getByRole("button", { name: "返回检查" }).click();
  assert(fs.existsSync(path.join(source, "ABC-123-U.mp4")), "cancelling confirmation must preserve source");
  const artifacts = path.join(repository, ".codex-artifacts", "product-split"); fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "file-workflows-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page must not overflow");
  await page.screenshot({ path: path.join(artifacts, "file-workflows-mobile.png"), fullPage: true });
  await page.locator("#execute").click(); await page.getByRole("button", { name: "开始执行" }).click();
  await page.waitForFunction(() => document.getElementById("statusBadge").textContent === "已完成");
  assert.equal(fs.readFileSync(path.join(target, "ABC-123", "ABC-123-U.mp4"), "utf8"), "synthetic-media-fixture");
  assert(fs.existsSync(path.join(source, "DEF-456.mp4")));
  await page.reload(); await page.locator(".history-item").first().click();
  await page.waitForFunction(() => document.getElementById("statusBadge").textContent === "已完成");
  assert.equal(await page.locator("#execute").isDisabled(), true); assert.deepEqual(errors, []);
  console.log("file-workflows-ui: desktop/mobile layout, preview, cancel, confirm, execution and persisted history passed (temporary fixtures only)");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await service.close(); temporary.cleanup();
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { buildTasteProfile } from "../src/modules/fanhao/server/taste/profile.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const fixtures = Array.from({ length: 40 }, (_, id) => ({ id, code: `ABC-${String(id).padStart(3, "0")}`,
  title: `测试馆藏作品 ${id}`, marked: id < 8, people: ["收藏人物甲"], tags: [id < 14 ? "眼镜" : "剧情"], makers: ["厂牌甲"], series: ["系列甲"], prefixes: ["ABC"] }));
const profile = buildTasteProfile(fixtures);
let failing = false;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/api/fanhao/taste") {
    res.writeHead(failing ? 503 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(failing ? { error: "测试读取失败，请重新读取。" } : profile)); return;
  }
  const pathname = url.pathname === "/fanhao/taste" ? "/modules/fanhao/taste/index.html" : url.pathname;
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404); res.end(); return; }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); fs.createReadStream(target).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath = process.env.FANHAO_CHROME_PATH || [
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"
  ].find((candidate) => fs.existsSync(candidate));
  assert(executablePath, "a Chromium browser is required for the taste page behavior checks");
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const address = `http://127.0.0.1:${server.address().port}/fanhao/taste`;
  await page.goto(address); await page.waitForSelector("#content:not([hidden])");
  assert.match(await page.locator("#summary").innerText(), /40/);
  await page.getByRole("button", { name: "标签", exact: true }).click();
  assert.match(await page.locator("#features").innerText(), /眼镜/);
  assert.match(await page.locator("#coverage").innerText(), /40 \/ 40/);
  assert.match(await page.locator("#features a").first().getAttribute("href"), /^\/fanhao\?q=ABC-/);
  await page.locator("#sort").selectOption("favorites");
  assert.match(await page.locator("#features").innerText(), /眼镜/);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出本次分析" }).click();
  const download = await downloadPromise;
  assert.equal(JSON.parse(fs.readFileSync(await download.path(), "utf8")).summary.marked, 8);
  const screenshotIndex = process.argv.indexOf("--screenshots");
  const screenshotDir = screenshotIndex >= 0 ? path.resolve(process.argv[screenshotIndex + 1]) : null;
  if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive: true }); await page.screenshot({ path: path.join(screenshotDir, "taste-desktop.png"), fullPage: true }); }
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the mobile page must not overflow horizontally");
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "taste-mobile.png"), fullPage: true });
  failing = true;
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("status").classList.contains("error"));
  assert.equal(await page.locator("#content").isVisible(), false);
  assert.equal(await page.locator("#export").isDisabled(), true);
  failing = false;
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForSelector("#content:not([hidden])");
  assert.deepEqual(errors, []);
  console.log("Taste page browser checks passed: dimensions, comparison, source links, export, 390px layout, failure and retry.");
} finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }

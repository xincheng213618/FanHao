import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { buildTasteAnalysis, pageTasteEvidence } from "../src/modules/fanhao/server/taste/profile.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const fixtures = Array.from({ length: 40 }, (_, id) => ({ id, code: `ABC-${String(id).padStart(3, "0")}`,
  title: `测试馆藏作品 ${id}`, marked: id < 8, people: ["收藏人物甲"], tags: [id < 14 ? "眼镜" : "剧情"], makers: ["厂牌甲"], series: ["系列甲"], prefixes: ["ABC"] }));
const { profile, evidence } = buildTasteAnalysis(fixtures, { snapshot: "fixture-taste" });
let failing = false, evidenceError = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/api/fanhao/taste/evidence") {
    const params = Object.fromEntries(url.searchParams);
    const result = pageTasteEvidence(evidence, { ...params, offset: Number(params.offset) });
    const status = evidenceError || (params.snapshot === profile.snapshot && result ? 200 : 404);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    const payload = status === 409 ? { code: "TASTE_SNAPSHOT_EXPIRED", error: "快照已过期" } : { error: "测试作品读取失败" };
    res.end(JSON.stringify(status === 200 ? result : payload));
    return;
  }
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
  const openEvidence = page.getByRole("button", { name: "查看「眼镜」的作品" });
  await openEvidence.click();
  const dialog = page.getByRole("dialog", { name: "标签 · 眼镜" });
  await dialog.getByText(/第 1–8 部，共 8 部/).waitFor();
  assert.equal(await dialog.locator("li").count(), 8);
  assert.equal(await dialog.getByRole("link", { name: "ABC-000" }).getAttribute("target"), "_blank");
  await dialog.getByRole("button", { name: /未标记/ }).click();
  await dialog.getByText(/第 1–6 部，共 6 部/).waitFor();
  assert.deepEqual(await dialog.locator("li a").allTextContents(), ["ABC-008", "ABC-009", "ABC-010", "ABC-011", "ABC-012", "ABC-013"]);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await openEvidence.evaluate((button) => document.activeElement === button), true);
  await page.getByRole("button", { name: "收藏人物", exact: true }).click();
  const personDialog = page.getByRole("dialog", { name: "收藏人物 · 收藏人物甲" });
  await page.getByRole("button", { name: "查看「收藏人物甲」的作品" }).click();
  await personDialog.getByRole("button", { name: /未标记/ }).click();
  await personDialog.getByText(/第 1–24 部，共 32 部/).waitFor();
  assert.equal(await personDialog.locator("li").count(), 24);
  evidenceError = 503;
  await personDialog.getByRole("button", { name: "下一页" }).click();
  await personDialog.getByText("测试作品读取失败").waitFor();
  evidenceError = 0;
  await personDialog.getByRole("button", { name: "重试", exact: true }).click();
  await personDialog.getByText(/第 25–32 部，共 32 部/).waitFor();
  assert.equal(await personDialog.locator("li a").first().textContent(), "ABC-032");
  assert.equal(await personDialog.getByRole("button", { name: "下一页" }).isDisabled(), true);
  await personDialog.getByRole("button", { name: "上一页" }).click();
  await personDialog.getByText(/第 1–24 部，共 32 部/).waitFor();
  evidenceError = 409;
  await personDialog.getByRole("button", { name: "下一页" }).click();
  await personDialog.getByText("快照已过期").waitFor();
  evidenceError = 0;
  await personDialog.getByRole("button", { name: "重读分析" }).click();
  await personDialog.waitFor({ state: "hidden" });
  await page.waitForSelector("#content:not([hidden])");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出本次分析" }).click();
  const download = await downloadPromise;
  assert.equal(JSON.parse(fs.readFileSync(await download.path(), "utf8")).summary.marked, 8);
  const screenshotIndex = process.argv.indexOf("--screenshots");
  const screenshotDir = screenshotIndex >= 0 ? path.resolve(process.argv[screenshotIndex + 1]) : null;
  if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive: true }); await page.screenshot({ path: path.join(screenshotDir, "taste-desktop.png"), fullPage: true }); }
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the mobile page must not overflow horizontally");
  await page.getByRole("button", { name: "查看「收藏人物甲」的作品" }).click();
  const bounds = await personDialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, "evidence dialog must fit the mobile viewport");
  await personDialog.getByRole("button", { name: "关闭作品清单" }).click();
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
  console.log("Taste page browser checks passed: dimensions, paged evidence, snapshot recovery, source links, export and 390px layout.");
} finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }

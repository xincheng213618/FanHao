import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public", import.meta.url));
const locationPath = "/fanhao/ltx";
const actor = "样本甲";
function item(index, size, overrides = {}) {
  const code = `FIX-${String(index).padStart(3, "0")}`;
  return {
    code, title: `Focus fixture ${index}`, actors: [actor], score: 8, addedAt: 0,
    links: [{ type: "magnet", url: `magnet:?xt=fixture${index}`, size, subtitledLtx: true }],
    local: { library: 1, downloads: 0, marked: 0 }, ...overrides
  };
}
const items = [
  item(1, 1024),
  item(2, 2048),
  item(3, 4096, { actors: ["样本乙"] }),
  item(4, 8192, { pending: true }),
  item(5, 16384, { local: { library: 0, downloads: 0, marked: 0 } }),
  item(6, 32768, { links: [{ type: "magnet", url: "magnet:?xt=fixture6", size: 32768 }] })
];
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  requests.push({ url, method: request.method });
  if (url.pathname.startsWith("/api/")) {
    const payload = url.pathname === "/api/fanhao/ltx"
      ? { items, libraryChecked: true, downloadsChecked: true, fetchedAt: "2026-11-13T00:00:00.000Z" }
      : url.pathname === "/api/fanhao/search" ? { works: [], total: 0 } : null;
    response.writeHead(payload ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return response.end(JSON.stringify(payload || { error: "unexpected fixture endpoint" }));
  }
  const pathname = url.pathname === locationPath ? "/modules/fanhao/ltx/index.html" : url.pathname;
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(`${root}${path.sep}`) || !statSync(target, { throwIfNoEntry: false })?.isFile()) {
    return response.writeHead(404).end();
  }
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  response.writeHead(200, { "Content-Type": `${mime[path.extname(target)] || "application/octet-stream"}; charset=utf-8` });
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
  assert.ok(executablePath, "Chrome or Chromium is required for the LTX filter views fixture");
  browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async () => { throw new Error("fixture clipboard unavailable"); } }
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const filters = { q: "Focus", actor, status: "confirmed", local: "present", subtitle: "ltx-c", sort: "size", order: "asc" };
  const initialUrl = `${origin}${locationPath}?${new URLSearchParams({ ...filters, fixture: "preserved" })}`;
  const codes = () => page.locator("#grid .code").allTextContents();
  const waitCount = (count) => page.waitForFunction((expected) => document.querySelectorAll("#grid .code").length === expected, count);
  const openViews = () => page.getByRole("button", { name: "筛选视图", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "筛选视图" });
  const filterName = "待检查的本地中字";
  await page.goto(initialUrl);
  await waitCount(2);
  assert.deepEqual(await codes(), ["FIX-001", "FIX-002"]);
  assert.equal(await page.locator("#search").inputValue(), "Focus");
  assert.equal(await page.locator("#actorChip").textContent(), `${actor} ×`);
  assert.equal(await page.locator("#filter").inputValue(), "present");
  assert.equal(await page.locator("#subtitleFilter").inputValue(), "ltx-c");
  assert.equal(await page.getByRole("button", { name: "文件大小" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#status button.confirmed").getAttribute("aria-pressed"), "true");

  await page.getByRole("button", { name: "文件大小" }).click();
  assert.deepEqual(await codes(), ["FIX-002", "FIX-001"]);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector("#grid .code")?.textContent === "FIX-001");
  await page.reload();
  await waitCount(2);
  assert.deepEqual(await codes(), ["FIX-001", "FIX-002"]);

  await openViews();
  await dialog.getByLabel("视图名称").fill(filterName);
  await dialog.getByRole("button", { name: "保存当前筛选" }).click();
  await dialog.getByText(`已保存「${filterName}」。`).waitFor();
  assert.equal(await dialog.getByRole("button", { name: filterName, exact: true }).getAttribute("aria-current"), "true");
  await dialog.getByRole("button", { name: "复制当前筛选链接" }).click();
  const linkInput = dialog.getByLabel("当前筛选链接");
  await linkInput.waitFor();
  const copiedLink = await linkInput.inputValue();
  assert.deepEqual(Object.fromEntries(new URL(copiedLink).searchParams), filters);
  assert.equal(await linkInput.evaluate((input) => input.selectionEnd - input.selectionStart), copiedLink.length);
  await dialog.getByRole("button", { name: "重置当前筛选" }).click();
  await waitCount(items.length);
  assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { fixture: "preserved" });
  await page.reload();
  await waitCount(items.length);
  await openViews();
  await dialog.getByRole("button", { name: filterName, exact: true }).click();
  await waitCount(2);
  assert.deepEqual(await codes(), ["FIX-001", "FIX-002"]);
  assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { fixture: "preserved", ...filters });
  const localSearch = page.waitForResponse((response) => response.url().includes("/api/fanhao/search") && response.ok());
  await page.locator("#filter").selectOption("ltx-local");
  await waitCount(0);
  await localSearch;
  await page.goBack();
  await waitCount(2);

  const independentContext = await browser.newContext();
  await independentContext.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  const independent = await independentContext.newPage();
  await independent.goto(copiedLink);
  await independent.waitForFunction(() => document.querySelectorAll("#grid .code").length === 2);
  assert.deepEqual(await independent.locator("#grid .code").allTextContents(), ["FIX-001", "FIX-002"]);
  await independentContext.close();

  await openViews();
  await dialog.getByRole("button", { name: `删除 ${filterName}` }).click();
  await dialog.getByText("此浏览器还没有保存筛选。").waitFor();
  await page.reload();
  await waitCount(2);
  await openViews();
  await dialog.getByText("此浏览器还没有保存筛选。").waitFor();
  await dialog.getByRole("button", { name: "关闭筛选视图" }).click();
  await page.locator("#actorChip").click();
  await waitCount(3);
  assert.equal(new URL(page.url()).searchParams.has("actor"), false);
  await page.locator("#status button.all").click();
  await waitCount(4);
  assert.equal(new URL(page.url()).searchParams.has("status"), false);
  await page.locator("#subtitleFilter").selectOption("all");
  await waitCount(5);
  assert.equal(new URL(page.url()).searchParams.has("subtitle"), false);
  await page.locator("#search").fill("no matches");
  await waitCount(0);
  assert.equal(new URL(page.url()).searchParams.get("q"), "no matches");
  await page.setViewportSize({ width: 390, height: 780 });
  await openViews();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(requests.some(({ method }) => method !== "GET"), false);
  assert.deepEqual(errors, []);
  console.log("LTX filter views browser verification passed.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

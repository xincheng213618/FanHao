import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public", import.meta.url));
const series = Array.from({ length: 149 }, (_, index) => ({
  id: index + 1, name: `样本系列 ${149 - index}`, localWorkCount: 200 - index,
  primaryPrefix: `SER-${index + 1}`, prefixes: [{ prefix: `ALT-${index + 1}` }]
}));
const maker = {
  id: "fixture-studio", name: "合成片商", localWorkCount: 19_000,
  series: [...series, { id: 150, name: "仅资料系列", localWorkCount: 0 }]
};
const reads = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname.startsWith("/api/")) {
    reads.push({ method: request.method, url });
    let payload = {};
    if (url.pathname === "/api/library") payload = { people: [], works: [], totals: {}, user: {}, access: { mode: "local" } };
    if (url.pathname === "/api/studios") payload = { makers: [maker], total: 1 };
    if (url.pathname === "/api/studios/fixture-studio") {
      const id = url.searchParams.get("seriesId");
      payload = {
        studio: maker, selectedSeriesId: id, total: 1, facets: { all: 1, localOnly: 1 },
        works: [{ id: `work-${id}`, title: `合成作品 ${id}`, videoCount: 1 }]
      };
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return response.end(JSON.stringify(payload));
  }
  const target = path.resolve(root, `.${url.pathname}`);
  if (!target.startsWith(`${root}${path.sep}`)) return response.writeHead(404).end();
  const file = statSync(target, { throwIfNoEntry: false })?.isFile() ? target : path.join(root, "index.html");
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  response.writeHead(200, { "Content-Type": `${type[path.extname(file)] || "application/octet-stream"}; charset=utf-8` });
  createReadStream(file).pipe(response);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath = process.env.FANHAO_CHROME_PATH || [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"
  ].find(existsSync);
  assert.ok(executablePath, "Chrome or Chromium is required for the studio series picker fixture");
  browser = await chromium.launch({ executablePath });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 390, height: 840 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
  });
  const detailReads = () => reads.filter(({ url }) => url.pathname === "/api/studios/fixture-studio");
  await page.goto(`${origin}/fanhao/studios`);
  await page.getByRole("button", { name: /合成片商/ }).click();
  const launch = page.getByRole("button", { name: /查找系列 · 149/ });
  const chips = page.locator(".studio-series-controls .studio-series-chip");
  await launch.waitFor();
  assert.equal(await chips.count(), 7, "long catalogs must retain a bounded group of quick choices");
  assert.equal(await chips.first().getAttribute("aria-pressed"), "true");
  assert.match(await chips.nth(1).textContent(), /样本系列 149/);
  const favoriteRead = page.waitForResponse((response) => new URL(response.url()).searchParams.get("filter") === "favorite");
  await page.locator('[data-work-filter="favorite"]').click();
  await favoriteRead;
  await page.locator('[data-work-filter="favorite"][aria-pressed="true"]').waitFor();
  const sortRead = page.waitForResponse((response) => new URL(response.url()).searchParams.get("sort") === "title");
  await page.getByRole("combobox", { name: "作品排序" }).selectOption("title");
  await sortRead;
  await launch.waitFor();
  const before = detailReads().at(-1).url;
  const beforeCount = detailReads().length;
  assert.equal(before.searchParams.get("filter"), "favorite");
  assert.equal(before.searchParams.get("sort"), "title");

  await launch.click();
  const dialog = page.getByRole("dialog", { name: "查找系列" });
  const input = dialog.getByRole("searchbox");
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
  await dialog.getByText("149 / 149 个系列").waitFor();
  const rows = dialog.getByRole("listitem");
  assert.equal(await rows.count(), 60);
  await dialog.getByRole("button", { name: "显示更多系列" }).click();
  assert.equal(await rows.count(), 120);
  await dialog.getByLabel("系列排序").selectOption("name");
  assert.equal(await rows.count(), 60);
  assert.match(await rows.first().textContent(), /样本系列 1SER-149/);
  await input.fill("仅资料系列");
  await dialog.getByText("没有匹配的系列。").waitFor();
  await input.fill("ＡＬＴ－１４９");
  await dialog.getByText("1 / 149 个系列").waitFor();
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().textContent(), /SER-149.*ALT-149/);
  assert.equal(detailReads().length, beforeCount, "search and sort must use the loaded series metadata");
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await page.locator('.studio-series-chip[data-series-id="149"][aria-pressed="true"]').waitFor();
  assert.equal(await chips.count(), 8, "a series beyond the quick list remains visible when selected");
  assert.equal(await chips.last().evaluate((node) => document.activeElement === node), true);
  const after = detailReads().at(-1).url;
  assert.equal(after.searchParams.get("seriesId"), "149");
  assert.equal(after.searchParams.get("filter"), before.searchParams.get("filter"));
  assert.equal(after.searchParams.get("sort"), before.searchParams.get("sort"));

  await launch.click();
  await dialog.locator('button[aria-current="true"]').waitFor();
  assert.match(await dialog.locator('button[aria-current="true"]').textContent(), /SER-149/);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await chips.first().click();
  await page.locator('.studio-series-chip[data-series-id="all"][aria-pressed="true"]').waitFor();
  assert.equal(await chips.count(), 7);
  assert.equal(detailReads().length, beforeCount + 2);
  assert.ok(reads.every(({ method }) => method === "GET"));
  assert.deepEqual(errors, []);
  console.log("Studio series picker browser verification passed.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

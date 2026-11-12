import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public", import.meta.url));
const makeWorks = (key, length, local) => Array.from({ length }, (_, index) => {
  const rankNo = index + 1;
  return {
    id: `${key}-${rankNo}`, title: `合成作品 ${rankNo}`, videoCount: local(rankNo) ? 1 : 0, playableCount: 0,
    missingLocal: !local(rankNo), ranking: { key, rankNo }
  };
});
const boards = new Map([
  ["y2025", makeWorks("y2025", 160, (rank) => rank >= 61 && rank <= 120)],
  ["y2024", makeWorks("y2024", 10, () => false)]
]);
const summaries = [...boards].map(([key, rows]) => ({
  key, label: `合成榜单 ${key.slice(1)}`, localTotal: rows.filter(({ missingLocal }) => !missingLocal).length,
  missingTotal: rows.filter(({ missingLocal }) => missingLocal).length
}));
const reads = [];
const oldAppend = { arrived: Promise.withResolvers(), release: Promise.withResolvers() };
let holdMissingAppend = false, localFailures = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname.startsWith("/api/")) {
    let payload = {}, status = 200;
    if (url.pathname === "/api/library") payload = { people: [], works: [], totals: {}, user: {}, access: { mode: "local" } };
    if (url.pathname === "/api/rankings") payload = { lists: summaries };
    if (url.pathname === "/api/rankings/top") {
      const key = url.searchParams.get("key"), scope = url.searchParams.get("scope") || "all";
      const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      const all = boards.get(key) || [];
      const source = scope === "local" ? all.filter(({ missingLocal }) => !missingLocal)
        : scope === "missing" ? all.filter(({ missingLocal }) => missingLocal) : all;
      reads.push({ key, scope, offset, limit, method: request.method, legacyMissing: url.searchParams.get("missing") });
      if (scope === "missing" && offset > 0 && holdMissingAppend) {
        oldAppend.arrived.resolve();
        await oldAppend.release.promise;
      }
      if (scope === "local" && localFailures > 0) {
        localFailures--;
        status = 503;
        payload = { error: "测试榜单读取失败" };
      } else {
        const works = source.slice(offset, offset + limit);
        payload = {
          key, scope, offset, limit, works, count: works.length, total: source.length,
          rankingTotal: all.length, ...summaries.find((summary) => summary.key === key)
        };
      }
    }
    if (!response.destroyed) {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(payload));
    }
    return;
  }
  const target = path.resolve(root, `.${url.pathname}`);
  if (!target.startsWith(`${root}${path.sep}`)) return response.writeHead(404).end();
  const file = statSync(target, { throwIfNoEntry: false })?.isFile() ? target : path.join(root, "index.html");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  response.writeHead(200, { "Content-Type": `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8` });
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
  assert.ok(executablePath, "Chrome or Chromium is required for the ranking coverage fixture");
  browser = await chromium.launch({ executablePath });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 390, height: 840 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; }
      observe(target) {
        if (target.classList.contains("work-render-sentinel")) queueMicrotask(() => this.callback([{ target, isIntersecting: true }]));
      }
      unobserve() {}
      disconnect() {}
    };
  });
  await page.goto(`${origin}/fanhao/rankings`);
  const group = page.getByRole("group", { name: "榜单馆藏范围" });
  const scope = (name) => group.getByRole("button", { name, exact: false });
  const cards = page.locator(".work-card[data-work-id]");
  const card = (id) => page.locator(`.work-card[data-work-id="${id}"]`);
  const more = page.locator(".load-more-row button");
  await scope("全部 160").waitFor();
  assert.equal(await scope("全部 160").getAttribute("aria-pressed"), "true");
  await card("y2025-1").waitFor();
  assert.equal(await card("y2025-61").count(), 0);
  await scope("本地 60").click();
  await card("y2025-61").waitFor();
  assert.equal(await scope("本地 60").getAttribute("aria-pressed"), "true");
  assert.equal(await card("y2025-1").count(), 0);
  assert.match(await more.textContent(), /48 \/ 60/);
  await more.click();
  await card("y2025-120").waitFor();
  assert.equal(await cards.count(), 60);
  assert.match(await card("y2025-120").locator(".cover-ranking").textContent(), /TOP 120/);
  assert.deepEqual(reads.filter(({ scope }) => scope === "local").map(({ offset }) => offset), [0, 48]);

  await scope("未下载 100").click();
  await card("y2025-1").waitFor();
  assert.equal(reads.at(-1).legacyMissing, "1");
  assert.match(await more.textContent(), /48 \/ 100/);
  holdMissingAppend = true;
  const staleRequest = page.waitForRequest((request) => {
    const params = new URL(request.url()).searchParams;
    return params.get("scope") === "missing" && params.get("offset") === "48";
  });
  await more.click();
  await staleRequest;
  await oldAppend.arrived.promise;
  await scope("本地 60").click();
  await card("y2025-61").waitFor();
  oldAppend.release.resolve();
  assert.equal(await card("y2025-49").count(), 0);

  await page.getByRole("combobox", { name: "选择排行榜榜单" }).selectOption("y2024");
  await scope("本地 0").waitFor();
  await page.getByText("这个榜单暂无本地作品。").waitFor();
  assert.equal(await scope("本地 0").getAttribute("aria-pressed"), "true");
  assert.equal(reads.at(-1).scope, "local");
  await page.getByRole("combobox", { name: "选择排行榜榜单" }).selectOption("y2025");
  await card("y2025-61").waitFor();
  await scope("全部 160").click();
  await card("y2025-1").waitFor();
  localFailures = 1;
  await scope("本地 60").click();
  await page.getByText("测试榜单读取失败").waitFor();
  await scope("本地 60").click();
  await card("y2025-61").waitFor();
  assert.equal(reads.at(-1).offset, 0);
  const bounds = await group.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(reads.every(({ method }) => method === "GET"));
  assert.deepEqual(errors, []);
  console.log("Ranking coverage browser verification passed.");
} finally {
  oldAppend.release.resolve();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

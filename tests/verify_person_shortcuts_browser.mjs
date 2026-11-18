import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public", import.meta.url));
const initialOwner = "account:shortcut-fixture-alpha";
const prefix = "fanhao.people-shortcuts.v1:";
let owner = initialOwner;
const makePerson = (scope, id, gender = "female") => ({
  id, name: `${scope === "western" ? "欧美" : "普通"}样本人物 ${id}`,
  workCount: 1, videoCount: 1, playableCount: 1, sourcePaths: [], actorProfile: { gender }
});
const ids = ["A", "B", "C", "hidden"];
const reads = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname.startsWith("/api/")) {
    reads.push({ method: request.method, path: url.pathname });
    const scope = url.searchParams.get("scope") || "main";
    let payload = {};
    if (url.pathname === "/api/library") {
      const people = ids.map((id) => makePerson(scope, id, id === "hidden" ? "male" : "female"));
      payload = { people, works: [], totals: { people: people.length }, scope, user: {}, access: { mode: "local" } };
    }
    if (url.pathname.startsWith("/api/people/")) {
      const id = url.pathname.split("/").at(-1);
      payload = { person: makePerson(scope, id), works: [{ id: `work-${id}`, title: `合成作品 ${id}`, videoCount: 1, playableCount: 1 }], total: 1 };
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-FanHao-Account-Owner": owner });
    return response.end(JSON.stringify(payload));
  }
  if (url.pathname === "/blank") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end("<!doctype html><title>Shortcut fixture</title>");
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
  assert.ok(executablePath, "Chrome or Chromium is required for the person shortcuts fixture");
  browser = await chromium.launch({ executablePath });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 390, height: 840 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
  });
  await page.goto(`${origin}/blank`);
  const mainKey = `${prefix}${encodeURIComponent(initialOwner)}:main`;
  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({ pinned: ["retired"], recent: ["B", "hidden"] }));
  }, mainKey);
  const navigation = page.getByRole("navigation", { name: "人物快捷入口" });
  const pinned = navigation.getByRole("group", { name: "已固定" });
  const recentRow = page.locator('[aria-label="最近浏览"], .person-shortcuts-clear');
  const history = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).recent, mainKey);
  const card = (scope, id) => page.locator(".person-index-card").filter({ hasText: makePerson(scope, id).name });
  const pin = page.getByRole("button", { name: "固定人物", exact: true });
  const unpin = page.getByRole("button", { name: "取消固定", exact: true });
  async function index(pathname, scope) {
    await page.goto(`${origin}${pathname}`);
    await card(scope, "A").waitFor();
  }
  async function back(scope) {
    await page.getByRole("button", { name: "返回人物索引" }).click();
    await card(scope, "A").waitFor();
  }
  await index("/fanhao", "main");
  assert.equal(await navigation.count(), 0, "visits and invalid pins must not produce shortcuts");
  assert.deepEqual(await history(), ["B", "hidden"]);
  await card("main", "A").click();
  await pin.click();
  assert.equal(await unpin.getAttribute("aria-pressed"), "true");
  await back("main");
  await pinned.getByRole("button", { name: "普通样本人物 A" }).waitFor();
  assert.equal(await recentRow.count(), 0);

  await card("main", "B").click();
  await pin.waitFor();
  await back("main");
  await card("main", "C").click();
  await pin.waitFor();
  await back("main");
  assert.equal(await recentRow.count(), 0);
  assert.deepEqual(await history(), ["C", "B", "A", "hidden"]);
  await page.reload();
  await pinned.getByRole("button", { name: "普通样本人物 A" }).waitFor();
  assert.equal(await recentRow.count(), 0);
  assert.deepEqual(await history(), ["C", "B", "A", "hidden"]);

  await index("/western", "western");
  assert.equal(await navigation.count(), 0, "even matching IDs must be isolated by people scope");
  await card("western", "A").click();
  await pin.click();
  await back("western");
  await pinned.getByRole("button", { name: "欧美样本人物 A" }).waitFor();
  await index("/fanhao", "main");
  await pinned.getByRole("button", { name: "普通样本人物 A" }).waitFor();

  owner = "account:shortcut-fixture-beta";
  await index("/fanhao", "main");
  assert.equal(await navigation.count(), 0, "another account on the same origin must not see shortcuts");
  owner = initialOwner;
  await index("/fanhao", "main");
  const fixed = pinned.getByRole("button", { name: "普通样本人物 A" });
  await fixed.waitFor();
  const bounds = await navigation.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await fixed.click();
  await unpin.click();
  await pin.waitFor();
  await back("main");
  assert.equal(await navigation.count(), 0);
  assert.deepEqual(await history(), ["A", "C", "B", "hidden"]);
  assert.ok(reads.every(({ method }) => method === "GET"));
  assert.deepEqual(errors, []);
  console.log("Person shortcuts browser verification passed.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

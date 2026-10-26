import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const specialTag = '剧情,组合/"[]<img>';
const tags = ["单体作品", "美少女电影", specialTag, ...Array.from({ length: 15 }, (_, i) => `资料标签 ${i}`)];
const requests = [];
let legacyCollections = false;
const works = Array.from({ length: 96 }, (_, id) => ({
  id: `trait-${id}`, title: `ZZZ-${100 + id} 测试作品`, personId: "trait-person", videoCount: 1, playableCount: 1,
  favorite: id >= 70, infoCount: 1, modifiedAt: "2026-10-23", infoSummary: { rating: 4, releaseDate: "2026-10-23" },
  availability: { hasMagnet: true, hasSubtitles: true },
  traits: {
    tags: id >= 70 ? tags : ["单体作品"],
    flags: { uncensored: id >= 80, uncensoredAi: false, subtitled: false, quality4k: false },
    editions: id >= 80 ? [{ key: "uncensored", label: "无码", evidence: ["文件名：ZZZ-U.mp4"] }] : []
  }
}));
const person = { id: "trait-person", name: "标签测试人物", workCount: works.length, videoCount: works.length, sourceCount: 1 };
const studios = [
  { id: "alpha", name: "Alpha Studio", localWorkCount: 4, logoUrl: "/fixture-logo.svg" },
  { id: "beta", name: "Beta Studio", localWorkCount: 96 },
  { id: "broken", name: "缺失 Logo", localWorkCount: 3, logoUrl: "/fixture-missing.svg" },
  { id: "unsafe", name: "其他片商", localWorkCount: 2, logoUrl: "javascript:alert(1)" }
];

function traitFacets(items) {
  const tagCounts = new Map();
  const editions = new Map();
  for (const work of items) {
    for (const name of new Set(work.traits.tags)) tagCounts.set(name, (tagCounts.get(name) || 0) + 1);
    for (const edition of work.traits.editions) editions.set(edition.key, (editions.get(edition.key) || 0) + 1);
  }
  return { total: items.length, tags: [...tagCounts].map(([name, count]) => ({ name, count })), editions: [...editions].map(([key, count]) => ({ key, name: "无码", count })) };
}

function matches(work, filter) {
  if (filter.startsWith("tag:")) return work.traits.tags.includes(decodeURIComponent(filter.slice(4)));
  if (filter === "favorite") return work.favorite;
  if (filter === "hasMagnet") return work.availability.hasMagnet;
  if (["uncensored", "uncensoredAi", "subtitled", "quality4k"].includes(filter)) return work.traits.flags[filter];
  return true;
}

function paged(url, extra = {}) {
  const filters = (url.searchParams.get("filter") || "all").split(",");
  const selected = works.filter((work) => filters.every((filter) => matches(work, filter)));
  const offset = Number(url.searchParams.get("offset")) || 0;
  const limit = Number(url.searchParams.get("limit")) || 64;
  return { ...extra, total: selected.length, facets: { all: works.length }, traitFacets: traitFacets(selected), works: selected.slice(offset, offset + limit) };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname.startsWith("/api/")) {
    requests.push(url);
    let data = {};
    if (url.pathname === "/api/modules") data = { modules: [] };
    if (url.pathname === "/api/library") data = { scope: "main", people: [person], access: { mode: "local" }, totals: {}, user: {} };
    if (url.pathname === "/api/people/trait-person") data = paged(url, { person });
    if (url.pathname === "/api/search") data = paged(url, { people: [] });
    if (url.pathname === "/api/code-prefixes") data = { prefixes: [{ prefix: "ZZZ", localCount: 96 }], localWorkCount: 96 };
    if (url.pathname === "/api/code-prefixes/ZZZ") data = paged(url, { codePrefix: { prefix: "ZZZ", localCount: 96 } });
    if (url.pathname === "/api/studios") data = { makers: studios };
    if (url.pathname.startsWith("/api/studios/")) data = paged(url, { studio: { ...studios.find((item) => item.id === url.pathname.split("/").at(-1)), series: [] } });
    if (url.pathname === "/api/favorites") data = legacyCollections
      ? { total: 96, works: works.slice(0, 8), folders: [], selectedFolderId: "all" }
      : paged(url, { folders: [], selectedFolderId: "all" });
    if (url.pathname === "/api/history") data = paged(url);
    if (url.pathname === "/api/works") {
      data = paged(url);
      data.works = data.works.map((work) => ({ ...work, title: `${work.title} [VR]` }));
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); return;
  }
  if (url.pathname === "/fixture-logo.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect fill="#e4efe9" width="120" height="120"/><text x="60" y="70" text-anchor="middle">Alpha</text></svg>'); return;
  }
  const pathname = /^\/fanhao(?:\/|$)/.test(url.pathname) ? "/index.html" : url.pathname;
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404); res.end(); return; }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(target)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); fs.createReadStream(target).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath = process.env.FANHAO_CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  assert(executablePath, "a Chromium browser is required");
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const address = `http://127.0.0.1:${server.address().port}`;
  const screenshotIndex = process.argv.indexOf("--screenshots");
  const screenshotDir = screenshotIndex >= 0 ? path.resolve(process.argv[screenshotIndex + 1]) : null;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const traitButton = (name) => page.locator(".browse-traits").getByRole("button", { name: new RegExp(`^${name}，`) });
  const cardId = () => page.locator(".work-card").first().getAttribute("data-work-id");
  const filteredRequest = (pathname, filter) => requests.some((url) => url.pathname === pathname && (url.searchParams.get("filter") || "").split(",").includes(filter) && Number(url.searchParams.get("offset")) === 0);

  await page.goto(`${address}/fanhao?personId=trait-person`);
  await traitButton("美少女电影").waitFor();
  assert.equal(await traitButton("美少女电影").getAttribute("aria-label"), "美少女电影，26 部", "facet counts include matches beyond the first page");
  await traitButton("美少女电影").focus(); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".browse-result-summary")?.textContent.includes("26"));
  assert.equal(await cardId(), "trait-70");
  assert(filteredRequest("/api/people/trait-person", `tag:${encodeURIComponent("美少女电影")}`));
  assert.equal(await traitButton("美少女电影").getAttribute("aria-pressed"), "true");
  await traitButton("无码").click();
  await page.waitForFunction(() => document.querySelector(".browse-result-summary")?.textContent.includes("16"));
  assert.equal(await cardId(), "trait-80");
  const combined = requests.findLast((url) => url.pathname === "/api/people/trait-person");
  assert.deepEqual(combined.searchParams.get("filter").split(","), [`tag:${encodeURIComponent("美少女电影")}`, "uncensored"]);
  assert.match(await page.locator(".work-edition-badge").first().getAttribute("title"), /文件名.*未核验视频画面/);
  assert.equal(await page.locator(".work-tag-buttons").first().locator("button").count(), 3);
  assert.match(await page.locator(".info-chip.magnet").first().getAttribute("title"), /未验证当前下载可用性/);
  assert.equal(await page.locator(".edition-subtitled").count(), 0, "subtitle magnets must not become local subtitle badges");
  const popup = []; page.on("popup", (child) => { popup.push(child); });
  await page.locator(".work-tag-buttons").first().getByRole("button", { name: `筛选标签：${specialTag}`, exact: true }).click();
  const specialFilter = `tag:${encodeURIComponent(specialTag)}`;
  // The tag already exists in the old facets. Wait for the replacement controls
  // to acknowledge selection, rather than observing the outgoing list's text.
  await page.waitForFunction((filter) => [...document.querySelectorAll(".browse-traits button")]
    .some((button) => button.dataset.workFilter === filter && button.getAttribute("aria-pressed") === "true"), specialFilter);
  assert(filteredRequest("/api/people/trait-person", `tag:${encodeURIComponent(specialTag)}`), "commas and punctuation remain one tag condition");
  assert.equal(popup.length, 0, "tag buttons do not open playback");
  assert.equal(await page.locator(".browse-traits img").count(), 0, "tag text must not create markup");
  // Select and measure in one browser evaluation so a control replacement cannot
  // leave a detached element with zero dimensions between locator and evaluate.
  await page.waitForFunction((count) => {
    const row = document.querySelector('.browse-trait-scroll[aria-label="内容标签"]');
    const buttons = row?.querySelectorAll("button");
    return row?.isConnected && buttons.length === count && row.clientWidth > 0
      && row.scrollWidth <= row.clientWidth + 1
      && buttons[buttons.length - 1].offsetTop > buttons[0].offsetTop;
  }, tags.length);
  assert(await page.evaluate(() => {
    const scopes = document.querySelector('.browse-filter-scopes');
    const extras = document.querySelector('.browse-filter-controls > [data-work-filter="favorite"]');
    return Math.abs(scopes.getBoundingClientRect().top - extras.getBoundingClientRect().top) < 3;
  }), "desktop scope and extra filters share one row when they fit");
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "browse-traits-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "390px layout must not overflow");
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "browse-traits-mobile.png"), fullPage: false });
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".browse-result-summary")?.textContent.includes("96"));
  assert.equal(await page.locator('.browse-traits button[aria-pressed="true"]').count(), 0);
  await page.setViewportSize({ width: 1366, height: 900 });

  for (const [route, pathname] of [["/fanhao?q=测试", "/api/search"], ["/fanhao/codes?prefix=ZZZ", "/api/code-prefixes/ZZZ"]]) {
    await page.goto(`${address}${route}`); await traitButton("美少女电影").waitFor();
    await traitButton("美少女电影").click(); await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
    assert(filteredRequest(pathname, `tag:${encodeURIComponent("美少女电影")}`), `${pathname} must refetch with its tag filter`);
  }

  await page.goto(`${address}/fanhao/studios`); await page.locator(".studio-card").first().waitFor();
  assert.equal(await page.locator(".studio-card").first().getAttribute("data-studio-id"), "beta");
  await page.locator('.studio-card[data-studio-id="alpha"] img').waitFor();
  await page.waitForFunction(() => document.querySelector('.studio-card[data-studio-id="alpha"] .studio-card-placeholder')?.hidden);
  await page.waitForFunction(() => !document.querySelector('.studio-card[data-studio-id="broken"] img'));
  assert.equal(await page.locator('.studio-card[data-studio-id="unsafe"] img').count(), 0);
  await page.getByRole("combobox", { name: "片商排序" }).selectOption("name");
  const sortedIds = await page.locator(".studio-card").evaluateAll((nodes) => nodes.map((node) => node.dataset.studioId));
  assert(sortedIds.indexOf("alpha") < sortedIds.indexOf("beta"), "name ordering replaces the default collection count order");
  await page.getByRole("searchbox", { name: "搜索已加载的片商" }).fill("beta");
  assert.equal(await page.locator(".studio-card").count(), 1);
  await page.getByRole("searchbox", { name: "搜索已加载的片商" }).fill("找不到片商");
  assert.match(await page.locator("#workGrid").innerText(), /没有匹配/);
  await page.getByRole("searchbox", { name: "搜索已加载的片商" }).fill("");
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "studio-index-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.equal(await page.locator("#workGrid").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length), 2);
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "studio-index-mobile.png"), fullPage: false });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.locator('.studio-card[data-studio-id="beta"]').click();
  await traitButton("美少女电影").click(); await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
  assert(filteredRequest("/api/studios/beta", `tag:${encodeURIComponent("美少女电影")}`));
  for (const [route, pathname] of [["favorites", "/api/favorites"], ["history", "/api/history"], ["vr", "/api/works"]]) {
    await page.goto(`${address}/fanhao/${route}`); await traitButton("美少女电影").waitFor();
    assert.match(await page.locator(".browse-traits-note").innerText(), /当前结果 96 部/);
    await traitButton("美少女电影").click(); await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
    assert(filteredRequest(pathname, `tag:${encodeURIComponent("美少女电影")}`), `${route} must filter all server results`);
    await page.locator("#sortSelect").selectOption("title");
    await page.waitForFunction(() => document.querySelector("#sortSelect")?.value === "title");
    assert(requests.some((url) => url.pathname === pathname && url.searchParams.get("sort") === "title" && (url.searchParams.get("filter") || "").includes("tag:")), `${route} must preserve tag filters when changing server sort`);
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".browse-traits-note")?.textContent.includes("96"));
  }
  legacyCollections = true;
  await page.goto(`${address}/fanhao/favorites`); await page.locator(".work-card").first().waitFor();
  assert.match(await page.locator(".browse-traits-note").innerText(), /仅统计已加载的 8 部/);
  assert.equal(await page.locator(".browse-traits").getByRole("button", { name: /美少女电影/ }).count(), 0, "another view must not retain prior facets");
  assert.deepEqual(errors, []);
  console.log("Browse traits browser checks passed: full-result facets, AND request filters across seven paged views, safe tag text, card actions, magnet evidence, clear, keyboard, 390px layout, studio search/sort/logos and old-API loaded-only scope.");
} finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }

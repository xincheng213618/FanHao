import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { mediaClassificationSearch } from "../lib/work-traits.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const specialTag = '剧情,组合/"[]<img>';
const tags = ["单体作品", "美少女电影", specialTag, ...Array.from({ length: 15 }, (_, i) => `资料标签 ${i}`)];
const fixtureClassifications = [["ltx", "LTX"], ["ltxLocal", "LTX 本地"], ["quality1080p", "1080p"], ["formatMkv", "MKV"]];
const requests = [];
let legacyCollections = false;
let watchedHistory = false;
let failHistorySearch = false;
let legacyHistorySearch = false;
let failStudioSearch = false;
let failPersonSearch = false;
const works = Array.from({ length: 96 }, (_, id) => ({
  id: `trait-${id}`, title: `ZZZ-${100 + id} 测试作品`, personId: "trait-person", videoCount: 1, playableCount: 1,
  favorite: id >= 70, infoCount: 1, modifiedAt: "2026-10-23", infoSummary: { rating: 4, releaseDate: "2026-10-23" },
  progress: id === 80 ? { percent: 42 } : null,
  availability: { hasMagnet: true, hasSubtitles: true },
  traits: {
    tags: id >= 70 ? tags : id === 0 ? ["单体作品", "人物范围标签"] : ["单体作品"],
    flags: { uncensored: id >= 80, uncensoredAi: false, subtitled: false, quality4k: false,
      ...Object.fromEntries(fixtureClassifications.map(([key]) => [key, id === 95])) },
    editions: id >= 80 ? [{ key: "uncensored", label: "无码", evidence: ["文件名：ZZZ-U.mp4"] }] : []
  }
}));
for (const [key, label] of fixtureClassifications) {
  works.at(-1).traits.editions.push({ key, label, evidence: ["fixture"] });
}
Object.assign(works[81].infoSummary, { rating: 0, ratingCount: 0 });
Object.assign(works[82].infoSummary, { rating: 0, ratingCount: 2 });
const person = { id: "trait-person", name: "标签测试人物", workCount: works.length, videoCount: works.length, sourceCount: 1 };
const secondPerson = { ...person, id: "second-person", name: "另一位人物", workCount: 1, videoCount: 1 };
const remoteWorks = [true, false].map((hasMagnet) => ({
  ...works[0], id: hasMagnet ? "remote-magnet" : "remote-no-magnet", missingLocal: true,
  videoCount: 0, playableCount: 0, availability: { hasMagnet }, javdbUrl: "/fixture-javdb/source"
}));
const studios = [
  { id: "alpha", name: "Alpha Studio", localWorkCount: 4, logoUrl: "/fixture-logo.svg" },
  { id: "beta", name: "Beta Studio", localWorkCount: 96 },
  { id: "broken", name: "缺失 Logo", localWorkCount: 3, logoUrl: "/fixture-missing.svg" },
  { id: "unsafe", name: "其他片商", localWorkCount: 2, logoUrl: "javascript:alert(1)" }
];
const hiddenStudio = { id: "hidden", name: "Hidden Studio", localWorkCount: 0 };

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
  if (Object.hasOwn(work.traits.flags, filter)) return work.traits.flags[filter];
  return true;
}

function paged(url, extra = {}, source = works) {
  const filters = (url.searchParams.get("filter") || "all").split(",");
  const classification = url.pathname === "/api/search" && mediaClassificationSearch(url.searchParams.get("q"));
  const query = url.pathname.startsWith("/api/people/") || (url.pathname === "/api/history" && !legacyHistorySearch)
    ? url.searchParams.get("q") || "" : "";
  const selected = source.filter((work) => filters.every((filter) => matches(work, filter)) && (!classification
    || ((classification.key === "all" || work.traits.flags[classification.key]) && (!classification.query || work.title.includes(classification.query))))
    && (!query || work.title.toLowerCase().includes(query.toLowerCase())));
  const offset = Number(url.searchParams.get("offset")) || 0;
  const limit = Number(url.searchParams.get("limit")) || 64;
  const facetSource = url.searchParams.get("traitScope") === "person" ? source : selected;
  return { ...extra, ...(query ? { query } : {}), total: selected.length, facets: { all: source.length },
    traitFacets: traitFacets(facetSource), works: selected.slice(offset, offset + limit) };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname.startsWith("/api/")) {
    requests.push(url);
    let data = {};
    if (url.pathname === "/api/modules") data = { modules: [] };
    if (url.pathname === "/api/library") data = { scope: "main", people: [person, secondPerson], access: { mode: "local" }, totals: {}, user: {} };
    if (url.pathname === "/api/people/trait-person") {
      if (failPersonSearch && url.searchParams.get("q")) {
        failPersonSearch = false;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Synthetic person search failure" }));
        return;
      }
      data = paged(url, { person });
    }
    if (url.pathname === "/api/people/second-person") data = { person: secondPerson, total: 1, works: [{ ...works[0], id: "second-work", personId: secondPerson.id }] };
    if (url.pathname === "/api/search") data = url.searchParams.get("q") === "remote-fixture"
      ? { people: [], works: remoteWorks, total: remoteWorks.length }
      : paged(url, { people: [] });
    if (url.pathname === "/api/code-prefixes") data = { prefixes: [{ prefix: "ZZZ", localCount: 96 }], localWorkCount: 96 };
    if (url.pathname === "/api/code-prefixes/ZZZ") data = paged(url, { codePrefix: { prefix: "ZZZ", localCount: 96 } });
    if (url.pathname === "/api/studios") {
      const query = url.searchParams.get("q");
      if (query && failStudioSearch) {
        failStudioSearch = false;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Synthetic studio search failure" }));
        return;
      }
      const makers = query ? [...studios, hiddenStudio].filter(studio => studio.name.toLowerCase().includes(query.toLowerCase())) : studios;
      data = { makers, total: query ? makers.length : 501 };
    }
    if (url.pathname.startsWith("/api/studios/")) data = paged(url, { studio: { ...studios.find((item) => item.id === url.pathname.split("/").at(-1)), series: [] } });
    if (url.pathname === "/api/favorites") data = legacyCollections
      ? { total: 96, works: works.slice(0, 8), folders: [], selectedFolderId: "all" }
      : paged(url, { folders: [], selectedFolderId: "all" });
    if (url.pathname === "/api/history") {
      const watch = url.searchParams.get("watch");
      if (url.searchParams.get("q") && failHistorySearch) {
        failHistorySearch = false;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Synthetic history search failure" }));
        return;
      }
      if (watchedHistory) {
        const history = works.map((work, index) => ({ ...work, progress: { videoId: `video-${index}`,
          position: index < 72 ? 40 : 100, duration: 100, percent: index < 72 ? 40 : 100, updatedAt: "2026-11-12T20:00:00Z" } }));
        const selected = watch === "unfinished" ? history.slice(0, 72) : watch === "finished" ? history.slice(72) : history;
        data = paged(url, watch ? { watch } : {}, selected);
      } else data = paged(url);
    }
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
  if (url.pathname === "/fixture-javdb/source") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Synthetic source"); return;
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
  const advancedSearch = page.getByRole("button", { name: "高级搜索", exact: true });

  await page.goto(`${address}/fanhao?personId=trait-person`);
  await advancedSearch.waitFor();
  assert.equal(await advancedSearch.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".browse-traits").isVisible(), false, "advanced person filters start collapsed");
  assert.equal(await page.locator(".browse-result-summary, .browse-traits-note").count(), 0, "person pages omit duplicate result totals");
  await advancedSearch.press("Enter");
  await traitButton("美少女电影").waitFor();
  assert.equal(await traitButton("美少女电影").getAttribute("aria-label"), "美少女电影，26 部", "facet counts include matches beyond the first page");
  await traitButton("美少女电影").focus(); await page.keyboard.press("Enter");
  await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
  assert.equal(await cardId(), "trait-70");
  assert.equal(await advancedSearch.getAttribute("aria-expanded"), "true", "the same person's advanced panel stays open after a filter");
  assert(filteredRequest("/api/people/trait-person", `tag:${encodeURIComponent("美少女电影")}`));
  assert.equal(await traitButton("美少女电影").getAttribute("aria-pressed"), "true");
  assert.equal(await traitButton("人物范围标签").getAttribute("aria-label"), "人物范围标签，1 部", "the person-wide option remains visible despite no intersection");
  await traitButton("人物范围标签").click();
  await page.getByText("当前筛选没有作品", { exact: true }).waitFor();
  assert.equal(await traitButton("美少女电影").getAttribute("aria-label"), "美少女电影，26 部");
  await traitButton("人物范围标签").click();
  await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
  await traitButton("无码").click();
  await page.locator('.work-card[data-work-id="trait-80"]').waitFor();
  assert.equal(await cardId(), "trait-80");
  const combined = requests.findLast((url) => url.pathname === "/api/people/trait-person");
  assert.deepEqual(combined.searchParams.get("filter").split(","), [`tag:${encodeURIComponent("美少女电影")}`, "uncensored"]);
  const localCard = page.locator('.work-card[data-work-id="trait-80"]');
  assert.equal(await localCard.locator(".work-edition-badges, .work-tag-buttons, .info-chip, .progress-track").count(), 0,
    "local cards omit editions, tags, magnet and info chips, and viewing progress");
  assert.match(await localCard.locator(".work-card-facts").innerText(), /2026-10-23/, "local cards still show rating and date");
  const unratedCard = page.locator('.work-card[data-work-id="trait-81"]');
  await unratedCard.waitFor();
  assert.equal(await unratedCard.locator(".cover-rating").count(), 0, "a zero score with no votes does not appear as a rating");
  assert.equal(await page.locator('.work-card[data-work-id="trait-82"] .cover-rating').getAttribute("aria-label"), "0.0分，2人评价");
  const popup = []; page.on("popup", (child) => { popup.push(child); });
  const specialFilter = `tag:${encodeURIComponent(specialTag)}`;
  await page.locator(`.browse-traits button[data-work-filter="${specialFilter}"]`).click();
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
  }, tags.length + 1);
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
  await page.locator('.work-card[data-work-id="trait-0"]').waitFor();
  assert.equal(await page.locator('.browse-traits button[aria-pressed="true"]').count(), 0);
  await advancedSearch.click();
  assert.equal(await page.locator(".browse-traits").isVisible(), false);
  await page.setViewportSize({ width: 1366, height: 900 });

  const showMissing = page.locator("#missingLocalToggle");
  assert.equal(await showMissing.isChecked(), true);
  const personRequest = (id, show) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/people/${id}` && url.searchParams.get("includeMissingLocal") === show;
  });
  await Promise.all([personRequest("trait-person", "0"), showMissing.uncheck()]);
  await page.goto(`${address}/fanhao?personId=second-person`);
  await page.locator('.work-card[data-work-id="second-work"]').waitFor();
  assert.equal(await showMissing.isChecked(), true, "a different person retains the default");
  await page.goto(`${address}/fanhao?personId=trait-person`);
  await page.locator('.work-card[data-work-id="trait-0"]').waitFor();
  assert.equal(await showMissing.isChecked(), false, "the saved person preference survives a reload");
  assert.equal(await page.evaluate(() => localStorage.getItem("fanhao.showMissingLocalWorks")), null, "the global preference is untouched");
  await Promise.all([personRequest("trait-person", "1"), showMissing.check()]);

  const personSearch = page.getByRole("search", { name: "当前人物作品查找" });
  const personQuery = personSearch.getByRole("searchbox");
  const personSearchStatus = personSearch.getByRole("status").filter({ hasText: "1 部匹配" });
  const personMatch = page.locator('.work-card[data-work-id="trait-95"]');
  await page.locator('.work-card[data-work-id="trait-0"]').waitFor();
  assert.equal(await personMatch.count(), 0, "the target starts beyond the first person page");
  const personSearchStart = requests.length;
  await personQuery.fill("ZZZ-195");
  await personQuery.dispatchEvent("compositionstart");
  await personQuery.press("Enter");
  assert.equal(requests.length, personSearchStart, "an IME composition is never submitted as a search");
  await personQuery.dispatchEvent("compositionend");
  failPersonSearch = true;
  await personQuery.press("Enter");
  await page.waitForURL(`${address}/fanhao?personId=trait-person&workQuery=ZZZ-195`);
  await page.getByText("Synthetic person search failure").waitFor();
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await personMatch.waitFor();
  await personSearchStatus.waitFor();
  assert.equal(await page.locator(".work-card").count(), 1);
  assert.equal(await page.locator("#workSearch").inputValue(), "");
  assert(!requests.slice(personSearchStart).some(url => url.pathname === "/api/search"));
  await advancedSearch.click();
  const filteredPersonSearch = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/people/trait-person" && url.searchParams.get("q") === "ZZZ-195"
      && url.searchParams.get("filter") === `tag:${encodeURIComponent("美少女电影")}`;
  });
  await Promise.all([filteredPersonSearch, traitButton("美少女电影").click()]);
  await personMatch.waitFor();
  await page.reload();
  await personMatch.waitFor();
  assert.equal(await personQuery.inputValue(), "ZZZ-195");
  await page.goBack();
  await page.locator('.work-card[data-work-id="trait-0"]').waitFor();
  assert.equal(await personQuery.inputValue(), "");
  await page.goForward();
  await personMatch.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "person search fits a phone-width page");
  await personQuery.fill("missing fixture title");
  await personSearch.getByRole("button", { name: "查找", exact: true }).click();
  await page.getByText("当前人物没有符合条件的作品。").waitFor();
  await personSearch.getByRole("button", { name: "清除搜索", exact: true }).click();
  await page.locator('.work-card[data-work-id="trait-0"]').waitFor();
  assert.equal(await personQuery.inputValue(), "");
  assert.equal(new URL(page.url()).searchParams.has("workQuery"), false);
  await page.setViewportSize({ width: 1366, height: 900 });
  console.log("Person work search browser checks passed: complete candidate set, IME, retry, filtered search, reload, Back/Forward and phone-width clear.");

  for (const [route, pathname] of [["/fanhao?q=测试", "/api/search"], ["/fanhao/codes?prefix=ZZZ", "/api/code-prefixes/ZZZ"]]) {
    await page.goto(`${address}${route}`); await traitButton("美少女电影").waitFor();
    await traitButton("美少女电影").click(); await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
    assert(filteredRequest(pathname, `tag:${encodeURIComponent("美少女电影")}`), `${pathname} must refetch with its tag filter`);
  }

  await page.goto(`${address}/fanhao?q=测试&returnTo=%2Ffixture#transient`);
  const searchTag = `tag:${encodeURIComponent("美少女电影")}`;
  const searchBox = page.locator("#workSearch");
  const copySearch = page.getByRole("button", { name: "复制搜索链接", exact: true });
  const waitForSearch = (query, filter, sort) => page.waitForURL(url => url.pathname === "/fanhao"
    && url.searchParams.get("q") === query && url.searchParams.get("filter") === filter
    && url.searchParams.get("sort") === sort);
  await traitButton("美少女电影").click();
  await waitForSearch("测试", searchTag, null);
  await page.getByRole("button", { name: "本地记录", exact: true }).click();
  const searchFilters = `${searchTag},localOnly`;
  await waitForSearch("测试", searchFilters, null);
  await page.locator("#sortSelect").selectOption("title");
  await waitForSearch("测试", searchFilters, "title");
  await page.locator("#missingLocalToggle").uncheck();
  await page.locator("#collectionToggle").check();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "search filters and copy must fit on phones");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.copiedSearchFixture = text; }
    } });
  });
  await copySearch.press("Enter");
  await page.getByText("搜索链接已复制", { exact: true }).waitFor();
  const copiedSearch = new URL(await page.evaluate(() => window.copiedSearchFixture));
  assert.equal(copiedSearch.origin, address);
  assert.deepEqual(Object.fromEntries(copiedSearch.searchParams), {
    q: "测试", filter: searchFilters, sort: "title", missing: "0", compilations: "1"
  });
  assert.equal(copiedSearch.hash, "");
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error("clipboard denied in fixture"); };
  });
  const fallback = page.waitForEvent("dialog").then(async dialog => {
    const result = [dialog.type(), dialog.defaultValue()];
    await dialog.dismiss();
    return result;
  });
  const [prompt] = await Promise.all([fallback, copySearch.click()]);
  assert.deepEqual(prompt, ["prompt", copiedSearch.href]);
  await page.setViewportSize({ width: 1366, height: 900 });

  await searchBox.fill("另一条检索");
  await searchBox.press("Enter");
  await waitForSearch("另一条检索", searchFilters, "title");
  await page.locator("#sortSelect").selectOption("updated");
  await waitForSearch("另一条检索", searchFilters, "updated");
  await page.goBack();
  await waitForSearch("测试", searchFilters, "title");
  await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
  assert.equal(await searchBox.inputValue(), "测试");
  assert.equal(await page.locator("#sortSelect").inputValue(), "title");
  await page.goForward();
  await waitForSearch("另一条检索", searchFilters, "updated");
  await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
  assert.equal(await page.locator("#sortSelect").inputValue(), "updated");

  await page.evaluate(() => {
    localStorage.setItem("fanhao.showMissingLocalWorks", "1");
    localStorage.setItem("fanhao.showCompilationWorks", "0");
  });
  const readsBeforeLink = requests.length;
  await page.goto(copiedSearch.href);
  await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
  assert.equal(await page.locator("#sortSelect").inputValue(), "title");
  assert.equal(await traitButton("美少女电影").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#missingLocalToggle").isChecked(), false);
  assert.equal(await page.locator("#collectionToggle").isChecked(), true);
  assert(requests.slice(readsBeforeLink).some(url => url.pathname === "/api/search"
    && url.searchParams.get("q") === "测试" && url.searchParams.get("sort") === "title"
    && url.searchParams.get("filter") === searchFilters), "opening a copied link uses all selected conditions on the first read");
  await page.reload();
  await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
  assert.equal(await page.locator("#sortSelect").inputValue(), "title");
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem("fanhao.showMissingLocalWorks"),
    localStorage.getItem("fanhao.showCompilationWorks")]), ["1", "0"], "opening a link must not rewrite browser preferences");
  const specialSearch = new URL("/fanhao", address);
  specialSearch.search = new URLSearchParams({ q: "测试", filter: `tag:${encodeURIComponent(specialTag)},unknown-filter`, sort: "invalid" });
  await page.goto(specialSearch.href);
  await page.locator('.work-card[data-work-id="trait-70"]').waitFor();
  assert.equal(await page.locator("#sortSelect").inputValue(), "releaseDesc");
  assert.equal(new URL(page.url()).searchParams.get("filter"), `tag:${encodeURIComponent(specialTag)}`);
  assert.equal(await page.locator(`[data-work-filter="tag:${encodeURIComponent(specialTag)}"]`).getAttribute("aria-pressed"), "true");
  console.log("Search links passed: combined scope and encoded tags, clipboard and manual copy, Back/Forward, reload and isolated display preferences.");

  await page.goto(`${address}/fanhao/studios`); await page.locator(".studio-card").first().waitFor();
  assert.equal(await page.locator(".studio-card").first().getAttribute("data-studio-id"), "beta");
  await page.locator('.studio-card[data-studio-id="alpha"] img').waitFor();
  await page.waitForFunction(() => document.querySelector('.studio-card[data-studio-id="alpha"] .studio-card-placeholder')?.hidden);
  await page.waitForFunction(() => !document.querySelector('.studio-card[data-studio-id="broken"] img'));
  assert.equal(await page.locator('.studio-card[data-studio-id="unsafe"] img').count(), 0);
  await page.getByRole("combobox", { name: "片商排序" }).selectOption("name");
  const sortedIds = await page.locator(".studio-card").evaluateAll((nodes) => nodes.map((node) => node.dataset.studioId));
  assert(sortedIds.indexOf("alpha") < sortedIds.indexOf("beta"), "name ordering replaces the default collection count order");
  const studioSearch = page.getByRole("searchbox", { name: "搜索片商", exact: true });
  const isOldStudioSearch = url => url.pathname === "/api/studios" && url.searchParams.get("q") === "Alpha";
  let releaseOld;
  const release = new Promise(resolve => { releaseOld = resolve; });
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (path, init) => {
      const url = new URL(path, location.href);
      return nativeFetch(path, url.pathname === "/api/studios" && url.searchParams.get("q") === "Alpha"
        ? { ...init, signal: undefined } : init);
    };
  });
  await page.route(isOldStudioSearch, async route => {
    await release;
    await route.continue();
  });
  try {
    const oldRequest = page.waitForRequest(request => isOldStudioSearch(new URL(request.url())), { timeout: 5000 });
    await studioSearch.fill("Alpha");
    await oldRequest;
    await studioSearch.fill("Hidden");
    await page.locator('.studio-card[data-studio-id="hidden"]').waitFor();
    const oldResponse = page.waitForResponse(response => isOldStudioSearch(new URL(response.url())));
    releaseOld();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.studio-card[data-studio-id="hidden"]').count(), 1, "an old studio search cannot replace the new query");
  } finally { releaseOld(); }
  assert.equal(await page.locator(".studio-index-summary").textContent(), "1 / 1 家片商");
  assert.equal(await studioSearch.evaluate(input => input === document.activeElement), true);
  failStudioSearch = true;
  await studioSearch.fill("beta");
  await page.getByText("全库搜索失败，显示已加载片商中的匹配。").waitFor();
  assert.equal(await page.locator(".studio-card").count(), 1);
  await page.locator(".studio-index-summary").getByRole("button", { name: "重试" }).click();
  await page.waitForFunction(() => document.querySelector(".studio-index-summary")?.textContent === "1 / 1 家片商");
  await studioSearch.fill("找不到片商");
  await page.getByText("没有匹配的片商，试试其他名称。").waitFor();
  await studioSearch.fill("");
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
  watchedHistory = true;
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto(`${address}/fanhao/history?days=7&watch=unfinished`);
  const firstResume = page.locator('.work-card[data-work-id="trait-0"] .work-history-playback');
  await firstResume.waitFor();
  assert.equal(await firstResume.locator("progress").evaluate(node => node.value), 40);
  assert.match(await firstResume.getAttribute("aria-label"), /继续播放.*已看 40%/);
  assert.equal(await page.locator('.work-card[data-work-id="trait-0"] .work-updated').textContent(), "观看于 2026-11-12");
  assert(await firstResume.evaluate(node => node.getBoundingClientRect().height >= 44 && node.getBoundingClientRect().right <= innerWidth));
  const resumeUrl = new URL(await firstResume.getAttribute("href"), address);
  assert.equal(resumeUrl.pathname, "/player.html");
  assert.equal(resumeUrl.searchParams.get("videoId"), "video-0");
  assert.equal(resumeUrl.searchParams.get("t"), null);
  assert.equal(resumeUrl.searchParams.get("returnTo"), "/fanhao/history?days=7&watch=unfinished");
  await page.waitForFunction(() => {
    if (document.querySelector('.work-card[data-work-id="trait-71"]')) return true;
    window.scrollTo(0, document.documentElement.scrollHeight);
    return false;
  });
  assert(requests.some(url => url.pathname === "/api/history" && url.searchParams.get("days") === "7"
    && url.searchParams.get("watch") === "unfinished" && url.searchParams.get("offset") === "48"));
  const historyStatus = page.getByRole("group", { name: "观看状态" });
  await historyStatus.getByRole("button", { name: /^已看完/ }).press("Enter");
  await page.waitForURL(`${address}/fanhao/history?days=7&watch=finished`);
  const restart = page.locator('.work-card[data-work-id="trait-72"] .work-history-playback');
  await restart.waitFor();
  assert.equal(await historyStatus.getByRole("button", { name: /^已看完/ }).evaluate(node => node === document.activeElement), true);
  assert.match(await restart.getAttribute("aria-label"), /从头播放.*已看完/);
  await page.context().route("**/player.html?**", route => route.fulfill({ contentType: "text/html", body: "<title>Synthetic player</title>" }));
  const [historyPopup] = await Promise.all([page.waitForEvent("popup"), restart.press("Enter")]);
  await historyPopup.waitForURL(url => url.pathname === "/player.html");
  const restartUrl = new URL(historyPopup.url());
  assert.equal(restartUrl.searchParams.get("workId"), "trait-72");
  assert.equal(restartUrl.searchParams.get("videoId"), "video-72");
  assert.equal(restartUrl.searchParams.get("t"), "0");
  assert.equal(restartUrl.searchParams.get("returnTo"), "/fanhao/history?days=7&watch=finished");
  await historyPopup.close();
  await page.goBack();
  await firstResume.waitFor();
  assert.equal(await historyStatus.getByRole("button", { name: /^未看完/ }).getAttribute("aria-pressed"), "true");
  watchedHistory = false;
  await page.goto(`${address}/fanhao/history?watch=unfinished`);
  await page.getByText("服务未返回对应的观看状态，可切回全部状态查看记录。", { exact: true }).waitFor();
  await historyStatus.getByRole("button", { name: /^全部状态/ }).click();
  await page.waitForURL(`${address}/fanhao/history`);
  await page.locator('.work-card[data-work-id="trait-0"]').waitFor();

  watchedHistory = true;
  await page.goto(`${address}/fanhao/history?days=7&watch=unfinished`);
  await firstResume.waitFor();
  const historySearch = page.getByRole("searchbox", { name: "观看记录内查找" });
  assert(await historySearch.evaluate(input => input.getBoundingClientRect().right <= innerWidth));
  await historySearch.fill("ZZZ-171");
  await historySearch.evaluate(input => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.form.requestSubmit();
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  assert.equal(new URL(page.url()).searchParams.get("q"), null, "IME composition must not submit a history search");
  failHistorySearch = true;
  await historySearch.press("Enter");
  await page.getByText("Synthetic history search failure", { exact: true }).waitFor();
  assert.equal(await historySearch.inputValue(), "ZZZ-171");
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  const matchedHistory = page.locator('.work-card[data-work-id="trait-71"] .work-history-playback');
  await matchedHistory.waitFor();
  assert.equal(await page.locator(".work-card").count(), 1);
  const historyUrl = "/fanhao/history?days=7&watch=unfinished&q=ZZZ-171";
  assert.equal(new URL(await matchedHistory.getAttribute("href"), address).searchParams.get("returnTo"), historyUrl);
  assert(requests.some(url => url.pathname === "/api/history" && url.searchParams.get("days") === "7"
    && url.searchParams.get("watch") === "unfinished" && url.searchParams.get("q") === "ZZZ-171" && url.searchParams.get("offset") === "0"));
  await historyStatus.getByRole("button", { name: /^已看完/ }).click();
  await page.getByText("当前观看记录中没有匹配的作品。", { exact: true }).waitFor();
  await page.goBack();
  await matchedHistory.waitFor();
  assert.equal(await historySearch.inputValue(), "ZZZ-171");
  await page.reload();
  await matchedHistory.waitFor();
  assert.equal(await historySearch.inputValue(), "ZZZ-171");
  legacyHistorySearch = true;
  await page.reload();
  await page.getByText("当前服务未返回观看记录搜索结果，清除搜索可继续浏览。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await firstResume.waitFor();
  legacyHistorySearch = false;
  await historySearch.fill("测试作品");
  await historySearch.press("Enter");
  await page.waitForURL(url => url.searchParams.get("q") === "测试作品");
  await page.locator("#sortSelect").selectOption("title");
  await page.waitForFunction(() => {
    if (document.querySelector('.work-card[data-work-id="trait-71"]')) return true;
    window.scrollTo(0, document.documentElement.scrollHeight);
    return false;
  });
  assert(requests.some(url => url.pathname === "/api/history" && url.searchParams.get("q") === "测试作品"
    && url.searchParams.get("days") === "7" && url.searchParams.get("watch") === "unfinished"
    && url.searchParams.get("sort") === "title" && url.searchParams.get("offset") === "48"),
  "history pagination must keep the committed search, time range, status and sort");
  watchedHistory = false;
  await page.setViewportSize({ width: 1366, height: 900 });
  console.log("History browser checks passed: deep-link filters, mobile pagination, playback return, scoped search, IME, retry and old-service recovery.");
  await page.goto(`${address}/fanhao?personId=trait-person`);
  await advancedSearch.click();
  await traitButton("LTX").click();
  await page.locator("[data-work-classifications]").click();
  await page.waitForURL(`${address}/fanhao?classification=all&missing=1&compilations=0`);
  await page.locator(".work-card[data-work-id='trait-0']").waitFor();
  assert.equal(await page.title(), "分类 · FanHao");
  assert.equal(await page.getByRole("navigation", { name: "媒体分类" }).count(), 0);
  assert.equal(await advancedSearch.getAttribute("aria-expanded"), "false");
  assert.equal(await traitButton("LTX").isVisible(), false);
  assert.equal(await page.locator("#missingLocalToggle").isVisible(), false, "local classifications hide the download visibility toggle");
  assert.equal(await page.getByRole("button", { name: "未下载", exact: true }).count(), 0);
  const scopedSearch = page.getByRole("combobox", { name: "搜索本地馆藏番号、标题或人物" });
  await scopedSearch.fill("ZZZ-100");
  await scopedSearch.press("Enter");
  await page.waitForURL(`${address}/fanhao?classification=all&q=ZZZ-100&missing=1&compilations=0`);
  assert(requests.some((url) => url.pathname === "/api/search" && url.searchParams.get("q") === "class:all ZZZ-100"));
  assert.equal(await page.locator(".work-card").count(), 1);
  await scopedSearch.press("Escape");
  await page.waitForURL(`${address}/fanhao?classification=all&missing=1&compilations=0`);
  await advancedSearch.click();
  assert.equal(await traitButton("LTX").getAttribute("aria-pressed"), "false");
  await traitButton("LTX").click();
  await page.waitForURL(`${address}/fanhao?classification=all&filter=ltx&missing=1&compilations=0`);
  await page.locator(".work-card .work-cover .cover-marker").filter({ hasText: /^本机LTX$/ }).waitFor();
  await traitButton("LTX").click();
  await page.waitForURL(`${address}/fanhao?classification=all&missing=1&compilations=0`);
  await page.locator(".work-card[data-work-id='trait-0']").waitFor();
  await traitButton("MKV").click();
  await page.waitForURL(`${address}/fanhao?classification=all&filter=formatMkv&missing=1&compilations=0`);
  await page.locator(".work-card[data-work-id='trait-95']").waitFor();
  const classificationSort = page.getByRole("group", { name: "作品排序", exact: true });
  await classificationSort.getByRole("button", { name: "评分", exact: true }).click();
  await classificationSort.getByRole("button", { name: "评分，降序", exact: true }).waitFor();
  assert(requests.some((url) => url.pathname === "/api/search" && url.searchParams.get("q") === "class:all"
    && url.searchParams.get("filter") === "formatMkv" && url.searchParams.get("sort") === "ratingDesc"));
  await page.waitForURL(`${address}/fanhao?classification=all&filter=formatMkv&sort=ratingDesc&missing=1&compilations=0`);
  await page.reload();
  await page.locator(".work-card[data-work-id='trait-95']").waitFor();
  await classificationSort.getByRole("button", { name: "评分，降序", exact: true }).waitFor();
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "classification-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "classification must fit at phone width");
  assert.equal(await page.locator("#workGrid").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length), 2);
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "classification-mobile.png"), fullPage: false });
  await page.goto(`${address}/fanhao?classification=ltx`);
  await traitButton("LTX").waitFor();
  assert.equal(await traitButton("LTX").getAttribute("aria-pressed"), "true", "old links select an ordinary filter");
  await page.locator(".work-card[data-work-id='trait-95']").waitFor();
  await traitButton("LTX").click();
  await page.waitForURL(`${address}/fanhao?classification=all&missing=1&compilations=0`);
  await page.locator(".work-card[data-work-id='trait-0']").waitFor();
  await page.setViewportSize({ width: 1366, height: 900 });

  await page.goto(`${address}/fanhao?q=remote-fixture`);
  const remoteMagnet = page.locator('.work-card.missing-local[data-work-id="remote-magnet"]');
  const remoteNoMagnet = page.locator('.work-card.missing-local[data-work-id="remote-no-magnet"]');
  await remoteMagnet.waitFor();
  await remoteNoMagnet.waitFor();
  const magnetCue = remoteMagnet.locator(".info-chip.magnet");
  assert.equal(await magnetCue.innerText(), "含磁链");
  assert.match(await magnetCue.getAttribute("title"), /未验证当前下载可用性/);
  assert.equal(await remoteNoMagnet.locator(".info-chip.magnet").count(), 0, "a gray card without a magnet has no magnet chip");
  const [sourcePopup] = await Promise.all([page.waitForEvent("popup"), remoteMagnet.locator(".work-card-main").click()]);
  await sourcePopup.waitForURL(`${address}/fixture-javdb/source`);
  await sourcePopup.close();

  legacyCollections = true;
  await page.goto(`${address}/fanhao/favorites`); await page.locator(".work-card").first().waitFor();
  assert.match(await page.locator(".browse-traits-note").innerText(), /仅统计已加载的 8 部/);
  assert.equal(await page.locator(".browse-traits").getByRole("button", { name: /美少女电影/ }).count(), 0, "another view must not retain prior facets");
  assert.deepEqual(errors, []);
  console.log("Browse traits browser checks passed: full-result facets, AND request filters across seven paged views, safe tag text, compact cards and remote magnet source, clear, keyboard, 390px layout, classification navigation and scoped search, studio search/sort/logos and old-API loaded-only scope.");
} finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }

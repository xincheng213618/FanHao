import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

// Complete real Android launcher/app/modules/cascade with synthetic metadata
// and reader bodies. Reader progress POSTs terminate in browser route doubles.
const root = path.resolve(import.meta.dirname, "..");
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executablePath, "Chrome or Edge required for the actual Android novel shell");
const legacyLayout = process.argv.includes("--legacy-layout");
const legacyInput = process.argv.includes("--legacy-input42");
const legacyResize = process.argv.includes("--legacy-resize-reveal");
const unguardedWidth = process.argv.includes("--unguarded-same-width");
const rotationOnly = process.argv.includes("--rotation-only") || legacyResize || unguardedWidth;
const legacyMetadata = process.argv.includes("--legacy-detail-metadata");
const legacyCatalogError = process.argv.includes("--legacy-catalog-error");
const detailOnly = process.argv.includes("--detail-only") || legacyMetadata || legacyCatalogError;
const baselineDetailActions = process.argv.includes("--baseline-detail-actions");
const measureDetailActions = baselineDetailActions || process.argv.includes("--measure-detail-actions");
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const longQuery = "SyntheticNovelSearchQueryWithoutWordBreaksForCheckingNarrowScreenEmptyStateAndRetry";
const textSearchBookId = "fixture-novel-detail-cn";
const textSearchPath = `/api/novels/${textSearchBookId}/search-text`;
const matchChapterIndex = 93;
const matchChapterId = `${textSearchBookId}-chapter-${matchChapterIndex}`;
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serviceExit = new Promise(resolve => service.once("exit", resolve));
const faults = [], profiles = [], frozenRuns = [], reads = new WeakMap(), apiReads = new WeakMap(), initialData = new WeakMap();
let browser, origin, checks = 0;
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function run(name, task) {
  if (caseFilter && !name.includes(caseFilter)) return;
  if (detailOnly && !name.startsWith("detail:")) return;
  if (rotationOnly && !name.startsWith("rotation:")) return;
  if ((legacyLayout || legacyInput) && !name.startsWith("search:")) return;
  await task(); checks++; console.log(`PASS ${name}`);
}
try {
  origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("synthetic novel fixture startup timed out")), 15000);
    service.stdout.on("data", bytes => { output += bytes; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited before startup (${code})`)); });
  });
  browser = await chromium.launch({ executablePath, headless: true });
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
    const profile = `${viewport.width}x${viewport.height}`;
    await run(`search: ${profile} long empty text, native clear focus and real result/back stay usable`, async () => {
      const page = await launch(viewport);
      try {
        const category = "历史军事";
        await page.getByRole("navigation", { name: "小说分类", exact: true }).getByRole("button", { name: category, exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".novel-mobile-book-row").length === 1);
        assert.equal(await page.locator(".novel-mobile-card-body > strong").textContent(), "旧城漫步");
        await page.locator(".novel-chrome-action.module-chrome-search").click();
        const input = page.getByRole("searchbox", { name: "搜索小说", exact: true });
        await input.fill(longQuery);
        const emptyReply = novelResponse(page, url => url.searchParams.get("q") === longQuery);
        await page.locator(".novel-mobile-search-page-submit").click();
        const emptyData = await emptyReply; assert.equal(emptyData.books.length, 0); assert.equal(emptyData.query, longQuery);
        await page.waitForFunction(query => document.querySelector(".novel-mobile-search-prompt")?.textContent === `没有搜到「${query}」`, longQuery);
        await frames(page);
        const prompt = await visibleTail(page.locator(".novel-mobile-search-prompt"), `${profile} long unmatched search prompt`);
        await searchTargets(page); await horizontalBounds(page);
        const beforeClear = page.url(), readCount = reads.get(page).length;
        await page.getByRole("button", { name: "清除搜索内容", exact: true }).click();
        assert.equal(await input.inputValue(), ""); assert.equal(await input.evaluate(node => document.activeElement === node), true, "native clear focuses the current search input");
        assert.equal(await page.locator(".novel-mobile-search-page-clear").isVisible(), false);
        assert.equal(page.url(), beforeClear); assert.equal(reads.get(page).length, readCount, "clearing the draft does not fetch or navigate");
        await input.fill("合成作者1");
        const foundReply = novelResponse(page, url => url.searchParams.get("q") === "合成作者1");
        await input.press("Enter"); const found = await foundReply;
        assert.equal(found.total, 1); assert.equal(found.books[0].title, "山海之间");
        await page.waitForFunction(() => document.querySelectorAll(".novel-mobile-book-row").length === 1 && document.querySelector(".novel-mobile-card-body > strong")?.textContent === "山海之间");
        await searchTargets(page); await horizontalBounds(page);
        await page.getByRole("button", { name: "返回小说", exact: true }).click();
        await page.locator(".novel-chrome-tabs").waitFor();
        await page.waitForFunction(() => document.querySelector(".novel-mobile-card-body > strong")?.textContent === "旧城漫步");
        assert.equal(await page.getByRole("navigation", { name: "小说分类", exact: true }).getByRole("button", { name: category, exact: true }).getAttribute("aria-pressed"), "true", "actual Back restores the prior library category");
        assert.equal(await page.locator(".novel-mobile-book-row").count(), 1);
        await horizontalBounds(page); profiles.push({ profile, case: "search", prompt, clearedInputFocus: true, matchingBook: found.books[0].title, returnedCategory: category });
      } finally { await page.close(); }
    });
    await run(`catalogue: ${profile} real sort-sheet close/last option and long category execute GET filters`, async () => {
      const page = await launch(viewport);
      try {
        const sort = page.locator(".novel-chrome-sort"); await sort.click();
        const sheet = page.getByRole("dialog", { name: "小说排序", exact: true }); await sheet.waitFor();
        assert.equal(await sheet.locator(".mobile-action-sheet-option").count(), 5, "count options separately from the shared close header");
        await sheet.getByRole("button", { name: "关闭小说排序", exact: true }).click();
        await sheet.waitFor({ state: "hidden" }); assert.equal(await sort.evaluate(node => document.activeElement === node), true, "sheet close restores its live sort trigger");
        await sort.click(); await sheet.waitFor();
        const last = sheet.locator(".mobile-action-sheet-option").last(); assert.equal(await last.textContent(), "篇幅最长");
        await last.scrollIntoViewIfNeeded(); await frames(page);
        assert.equal(await last.evaluate(node => { const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.top >= 0 && r.bottom <= innerHeight + 1 && node.contains(hit); }), true, "the actual last sort option is visible and receives pointer input");
        const sortedReply = novelResponse(page, url => url.searchParams.get("sort") === "chars");
        await last.click(); const sorted = await sortedReply; assert.equal(sorted.sort, "chars"); assert.equal(sorted.books.length, 8);
        assert(sorted.books.every((book, index) => index === 0 || sorted.books[index - 1].charCount > book.charCount), "the synthetic GET actually applies descending character count");
        await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll(".novel-mobile-card-body > strong")].map(node => node.textContent)) === JSON.stringify(expected), sorted.books.map(book => book.title));
        assert.match(await sort.getAttribute("aria-label"), /篇幅最长/);
        const lastCategory = initialData.get(page).facets.at(-1).name;
        const categoryReply = novelResponse(page, url => url.searchParams.get("category") === lastCategory);
        await page.getByRole("navigation", { name: "小说分类", exact: true }).getByRole("button", { name: lastCategory, exact: true }).click();
        const filtered = await categoryReply; assert.equal(filtered.total, 1); assert.equal(filtered.books[0].category, lastCategory);
        await page.waitForFunction(expected => document.querySelectorAll(".novel-mobile-book-row").length === 1 && document.querySelector(".novel-mobile-card-body > strong")?.textContent === expected, filtered.books[0].title);
        assert.equal(await page.getByRole("navigation", { name: "小说分类", exact: true }).getByRole("button", { name: lastCategory, exact: true }).getAttribute("aria-pressed"), "true");
        await horizontalBounds(page); profiles.push({ profile, case: "catalogue", sortedBy: "chars", descendingCharCounts: sorted.books.map(book => book.charCount), filteredBooks: 1, lastCategory });
      } finally { await page.close(); }
    });
    await run(`detail: ${profile} four metadata-only books and real paged catalogue remain readable`, async () => {
      await verifyDetails(viewport);
    });
  }
  for (const noRO of [false, true]) await run(`rotation: ${noRO ? "window resize fallback" : "native ResizeObserver"} reveals the selected category only after width changes`, async () => {
    await verifyRotation(noRO);
  });
  if (!legacyMetadata && !legacyCatalogError) await run("detail: reading actions and catalogue load independently", verifyDetailActionTiming);
  for (const mode of ["scroll", "page"]) await run(`chapter search: ${mode} finds literal matches in the mounted reader`, () => verifyChapterSearch(mode));
  await run("chapter search: same chapter revalidation preserves input and match", () => verifyChapterSearch("scroll", { refresh: true }));
  for (const mode of ["scroll", "page"]) await run(`book text search: ${mode} paginates and opens the exact match in the reader`, () => verifyBookTextSearch(mode));
  await run("book text search: stale searches, changed chapters and older services preserve the current page", verifyBookTextSearchOwnership);
  await run("book text search: phone-only books keep chapter search offline", verifyBookTextSearchLocal);
  await run("reader bookmarks: phone-only books keep and reopen exact positions across chapters", verifyLocalBookmarks);
  await run("reader bookmarks: remote jumps validate chapter identity, account and version", verifyRemoteBookmarks);
  await run("read later: real Android shelf saves, searches, reopens and removes on 320px", verifyReadLater);
  await run("read later: device records stay separate and saved remote opens reject another source", verifyReadLaterSources);
  assert(checks > 0); assert.deepEqual(faults, []);
  console.log(JSON.stringify({ result: "PASS", scenarios: checks, profiles, frozenRuns,
    boundary: "Actual Chromium full shell; synthetic metadata and chapters; progress writes intercepted locally; no downloads, real novels/database or native-device claim" }, null, 2));
} finally {
  await browser?.close(); service.kill("SIGTERM"); await Promise.race([serviceExit, new Promise(resolve => setTimeout(resolve, 3000))]);
}
async function launch(viewport, { noRO = false, detailScene = false, prepare, fixtureRunId } = {}) {
  const page = await browser.newPage({ viewport }); reads.set(page, []); apiReads.set(page, []);
  if (noRO) await page.addInitScript(() => { window.ResizeObserver = undefined; });
  page.on("pageerror", error => faults.push(error.message));
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/api/novels") reads.get(page).push(request.url()); if (request.method() === "GET" && url.pathname.startsWith("/api/")) apiReads.get(page).push(request.url()); });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) { faults.push(`external ${url.origin}${url.pathname}`); return route.abort(); }
    if (!["GET", "HEAD"].includes(request.method()) && url.pathname !== "/fixture/new-run") { faults.push(`unexpected mutation ${request.method()} ${url.pathname}`); return route.abort(); }
    const detailPath = /^\/api\/novels\/fixture-novel-detail-(?:cn|latin|empty|error)(\/catalog)?$/.exec(url.pathname);
    const metadataRead = detailScene && request.method() === "GET" && detailPath && (detailPath[1] || url.searchParams.get("catalog") === "0");
    if (url.pathname.startsWith("/api/novels/") && url.pathname !== "/api/novels/summary" && !metadataRead) { faults.push(`unsupported novel flow ${url.pathname}`); return route.abort(); }
    await route.continue();
  });
  if (legacyLayout || legacyInput) await page.route(url => url.pathname.endsWith("/modules/novels/styles.css"), async route => {
    const response = await route.fetch(); let body = (await response.text()).replaceAll("\r\n", "\n");
    const change = (from, to) => { assert.equal(body.split(from).length, 2, "negative changes one exact novel CSS hook"); body = body.replace(from, to); };
    if (legacyLayout) {
      change(".novel-mobile-search-page-content {\n  grid-template-columns: minmax(0, 1fr);\n  min-width: 0;", ".novel-mobile-search-page-content {");
      change(".novel-mobile-search-page-head {\n  min-width: 0;\n  max-width: 100%;", ".novel-mobile-search-page-head {");
      change(".novel-mobile-search-page-form {\n  display: grid;\n  min-width: 0;\n  max-width: 100%;", ".novel-mobile-search-page-form {\n  display: grid;");
      change(".novel-mobile-search-prompt {\n  display: grid;\n  min-width: 0;\n  max-width: 100%;\n  min-height: 180px;\n  overflow-wrap: anywhere;", ".novel-mobile-search-prompt {\n  display: grid;\n  min-height: 180px;");
    }
    if (legacyInput) change(".novel-mobile-search-page-field input {\n  width: 100%;\n  min-width: 0;\n  height: 44px;", ".novel-mobile-search-page-field input {\n  width: 100%;\n  min-width: 0;\n  height: 42px;");
    await route.fulfill({ response, body });
  });
  if (legacyResize || unguardedWidth) await page.route(url => url.pathname.endsWith("/modules/novels/android-module.js"), async route => {
    const response = await route.fetch(); let body = (await response.text()).replaceAll("\r\n", "\n");
    const change = (from, to) => { assert.equal(body.split(from).length, 2, "rotation negative changes one exact actual module hook"); body = body.replace(from, to); };
    if (legacyResize) change("  const scheduleReveal = () => {\n    if (!isCurrent()) return;", "  const scheduleReveal = () => {\n    if (!isCurrent()) return;\n    if (lastWidth !== null) return;");
    if (unguardedWidth) {
      change("    if (width === lastWidth) return;", "    /* equal-width reveal guard omitted */");
      change("    if (width === lastWidth || frame) return;", "    if (frame) return;");
    }
    await route.fulfill({ response, body });
  });
  if (legacyMetadata || legacyCatalogError) await page.route(url => url.pathname.endsWith("/modules/novels/mobile-refinements.css"), async route => {
    const response = await route.fetch(); let body = (await response.text()).replaceAll("\r\n", "\n");
    const marker = legacyMetadata
      ? ".novel-mobile-detail-body > span { color: var(--muted); font-size: 12px; font-weight: 400; line-height: 1.8; white-space: normal; overflow-wrap: anywhere; }"
      : "#novelDetailCatalog .novel-reader-catalog-loading { min-width: 0; overflow-wrap: anywhere; }";
    assert.equal(body.split(marker).length, 2, "detail negative changes one exact actual refinement rule");
    body = body.replace(marker, legacyMetadata ? marker.replace(" overflow-wrap: anywhere;", "") : "/* catalogue error wrapping omitted */");
    await route.fulfill({ response, body });
  });
  await prepare?.(page);
  if (!fixtureRunId) await page.goto(origin);
  const initial = novelResponse(page, () => true);
  if (fixtureRunId) {
    await page.goto(`${origin}/run/${fixtureRunId}/www/index.html#novels`);
  } else {
    await page.getByRole("button", { name: detailScene ? "小说详情与章节目录（长书名、简介与分页）" : "小说分类测试（8个书库分类，含长名称）", exact: true }).click();
  }
  await page.waitForURL(url => url.pathname.startsWith("/run/"));
  const runId = new URL(page.url()).pathname.split("/")[2], frozen = (await (await page.request.get(`${origin}/fixture/requests?run=${runId}`)).json()).runs[0];
  frozenRuns.push({ runId, scenario: frozen.scenario, files: frozen.files.filter(file => ["app.js", "modules/novels/styles.css", "modules/novels/mobile-refinements.css", "modules/novels/novel-views.js", "modules/novels/android-module.js", "modules/novels/chapter-search.js", "modules/novels/book-text-search.js"].includes(file.name)).map(file => ({ name: file.name, sha256: file.servedSha256 })) });
  const data = await initial, expectedCount = detailScene ? 4 : 8; assert.equal(data.books.length, expectedCount); initialData.set(page, data);
  await page.waitForFunction(count => document.querySelectorAll(".novel-mobile-book-row").length === count, expectedCount); await frames(page); return page;
}
async function novelResponse(page, predicate) {
  const response = await page.waitForResponse(value => new URL(value.url()).pathname === "/api/novels" && predicate(new URL(value.url())));
  assert.equal(response.status(), 200); return response.json();
}
async function visibleTail(locator, label) {
  const result = await locator.evaluate(node => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), texts = []; while (walker.nextNode()) if (walker.currentNode.textContent) texts.push(walker.currentNode);
    const last = texts.at(-1), range = document.createRange(); range.setStart(last, Math.max(0, last.textContent.length - 14)); range.setEnd(last, last.textContent.length);
    return { text: node.textContent, box: node.getBoundingClientRect().toJSON(), tails: [...range.getClientRects()].map(rect => rect.toJSON()), width: node.clientWidth, scroll: node.scrollWidth, viewport: document.documentElement.clientWidth };
  });
  assert(result.tails.length > 0);
  for (const tail of result.tails) assert(tail.left >= result.box.left - 1 && tail.right <= result.box.right + 1 && tail.top >= result.box.top - 1 && tail.bottom <= result.box.bottom + 1 && tail.left >= -1 && tail.right <= result.viewport + 1,
    `${label}: actual trailing text fits its rendered box and horizontal viewport: ${JSON.stringify(result)}`);
  assert(result.scroll <= result.width + 1, `${label}: no internal horizontal overflow`); return { length: result.text.length, width: result.box.width, height: result.box.height };
}
async function horizontalBounds(page) {
  const result = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert(result.scroll <= result.client + 1 && result.body <= result.client + 1, `page remains within horizontal document bounds: ${JSON.stringify(result)}`);
}
async function searchTargets(page) {
  const controls = await page.locator(".novel-mobile-search-page-head button, .novel-mobile-search-page-head input").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => ({ tag: node.tagName, label: node.getAttribute("aria-label") || node.textContent, rect: node.getBoundingClientRect().toJSON(), client: document.documentElement.clientWidth })));
  assert.equal(controls.length, 4);
  for (const control of controls) {
    assert(control.rect.width >= 44 && control.rect.height >= 44, `search input/buttons have 44px hit targets: ${JSON.stringify(control)}`);
    assert(control.rect.left >= -1 && control.rect.right <= control.client + 1, `all search header controls remain horizontally visible: ${JSON.stringify(control)}`);
  }
  const field = await page.locator(".novel-mobile-search-page-field").boundingBox(); assert(field.height >= 46, "field accommodates the 44px native input and border");
}
async function rotationState(page) {
  return { ...await page.evaluate(() => ({ url: location.href, history: history.length, scrollY })), apiGets: apiReads.get(page).length };
}
async function categoryGeometry(nav) {
  return nav.evaluate(node => { const box = node.getBoundingClientRect(), selected = node.querySelector('[aria-pressed="true"]'), rect = selected.getBoundingClientRect();
    return { width: node.clientWidth, height: box.height, scrollLeft: node.scrollLeft, left: box.left + node.clientLeft,
      right: box.left + node.clientLeft + node.clientWidth, selectedLeft: rect.left, selectedRight: rect.right, selected: selected.textContent }; });
}
async function assertSelectedVisible(nav, label) {
  const geometry = await categoryGeometry(nav);
  assert(geometry.selectedLeft >= geometry.left - 1 && geometry.selectedRight <= geometry.right + 1, `${label}: selected category is inside the live nav viewport: ${JSON.stringify(geometry)}`);
  return geometry;
}
async function changeObservedHeight(nav, height) {
  return nav.evaluate((node, height) => new Promise((resolve, reject) => {
    const initialHeight = node.getBoundingClientRect().height;
    const observer = new ResizeObserver(entries => {
      if (!entries.some(entry => entry.target === node) || node.getBoundingClientRect().height === initialHeight) return;
      clearTimeout(timer); observer.disconnect(); resolve({ height: node.getBoundingClientRect().height, width: node.clientWidth, scrollLeft: node.scrollLeft });
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("private geometry probe did not produce a real ResizeObserver height notification")); }, 3000);
    observer.observe(node); node.style.height = height;
  }), height);
}
async function verifyRotation(noRO) {
  const page = await launch({ width: 568, height: 320 }, { noRO });
  try {
    assert.equal(await page.evaluate(() => typeof ResizeObserver), noRO ? "undefined" : "function");
    await page.getByRole("navigation", { name: "小说分类", exact: true }).getByRole("button", { name: "科幻未来", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".novel-mobile-book-row").length === 1 && document.querySelector(".novel-mobile-card-body > strong")?.textContent === "群星入海");
    await page.waitForLoadState("networkidle"); await frames(page);
    const nav = page.locator(".novel-chrome-tabs"), navNode = await nav.elementHandle(), selectedNode = await nav.locator('[aria-pressed="true"]').elementHandle();
    const cardNode = await page.locator(".novel-mobile-book-row").elementHandle(), sortNode = await page.locator(".novel-chrome-sort").elementHandle();
    await page.locator(".novel-chrome-sort").focus();
    const before = await rotationState(page), steps = [await assertSelectedVisible(nav, "initial landscape")];
    const stable = async () => {
      for (const [node, selector] of [[navNode, ".novel-chrome-tabs"], [selectedNode, '.novel-chrome-tabs [aria-pressed="true"]'], [cardNode, ".novel-mobile-book-row"]]) {
        assert.equal(await node.evaluate((node, selector) => node.isConnected && document.querySelector(selector) === node, selector), true, "rotation preserves exact mounted nav, selected button and book row");
      }
      assert.equal(await sortNode.evaluate(node => node.isConnected && document.activeElement === node), true, "category reveal never steals sort-button focus");
      assert.deepEqual(await rotationState(page), before, "viewport/category reveal does not navigate, fetch or scroll the document");
      await horizontalBounds(page);
    };
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
      await page.setViewportSize(viewport); await frames(page); await frames(page);
      steps.push(await assertSelectedVisible(nav, `${viewport.width}px ${noRO ? "fallback" : "RO"} resize`)); await stable();
    }
    await page.setViewportSize({ width: 320, height: 568 }); await frames(page); await frames(page); await assertSelectedVisible(nav, "manual-pan start");
    const bounds = await nav.boundingBox(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(-1200, 0);
    await page.waitForFunction(() => document.querySelector(".novel-chrome-tabs")?.scrollLeft === 0); await frames(page);
    const panned = await categoryGeometry(nav);
    assert(panned.selectedRight > panned.right + 1, "real horizontal wheel intentionally pans the selected category out of view");
    if (noRO) {
      assert.equal(await page.evaluate(() => { let observed = false; window.addEventListener("resize", () => { observed = true; }, { once: true }); window.dispatchEvent(new Event("resize")); return observed; }), true);
      await frames(page); await frames(page);
    } else {
      const original = await nav.evaluate(node => node.style.height);
      const changed = await changeObservedHeight(nav, `${panned.height + 1}px`); await frames(page);
      assert.equal(changed.width, panned.width, "height-only RO probe preserves exact clientWidth"); assert.equal(changed.height, panned.height + 1, "private probe causes a real one-pixel height change");
      assert.equal((await categoryGeometry(nav)).scrollLeft, panned.scrollLeft, "same-width RO height notification does not undo the user's pan");
      const restored = await changeObservedHeight(nav, original); await frames(page);
      assert.equal(restored.width, panned.width); assert.equal(restored.height, panned.height, "geometry probe restores the actual original height");
    }
    const unchanged = await categoryGeometry(nav); assert.equal(unchanged.width, panned.width); assert.equal(unchanged.scrollLeft, panned.scrollLeft, "same-width callbacks keep manual nav scroll position"); await stable();
    await page.setViewportSize({ width: 390, height: 844 }); await frames(page); await frames(page); await assertSelectedVisible(nav, "real width change after manual pan"); await stable();
    await page.locator(".novel-chrome-action.module-chrome-search").click();
    const input = page.getByRole("searchbox", { name: "搜索小说", exact: true }); await input.fill("保持旋转输入"); await input.press("ArrowLeft");
    const inputNode = await input.elementHandle(), searchState = await rotationState(page);
    await page.setViewportSize({ width: 568, height: 320 }); await frames(page); await frames(page);
    assert.equal(await navNode.evaluate(node => node.isConnected), false, "leaving the library retires the old nav");
    assert.equal(await inputNode.evaluate(node => node.isConnected && document.activeElement === node), true, "resize after leaving preserves the actual search input focus");
    assert.equal(await input.inputValue(), "保持旋转输入"); assert.deepEqual(await rotationState(page), searchState);
    profiles.push({ case: "rotation", observer: noRO ? "window-resize-fallback" : "native-RO", steps, manualPan: panned.scrollLeft, sameWidthScroll: unchanged.scrollLeft, searchInputFocusPreserved: true });
  } finally { await page.close(); }
}
async function catalogueResponse(page, id, predicate = () => true) {
  const response = await page.waitForResponse(value => new URL(value.url()).pathname === `/api/novels/${id}/catalog` && predicate(new URL(value.url())));
  return { status: response.status(), payload: await response.json() };
}
async function catalogueRendered(page, payload) {
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll(".novel-mobile-catalog-list .novel-mobile-chapter > strong")].map(node => node.textContent)) === JSON.stringify(expected), payload.chapters.map(chapter => chapter.title));
  await frames(page);
  assert(payload.chapters.every(chapter => chapter.content === ""), "catalogue remains metadata-only");
}
async function wholeText(locator, label) {
  const result = await visibleTail(locator, label);
  const layout = await locator.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return { box: node.getBoundingClientRect().toJSON(), rects: [...range.getClientRects()].map(rect => rect.toJSON()), width: document.documentElement.clientWidth }; });
  for (const rect of layout.rects) assert(rect.left >= layout.box.left - 1 && rect.right <= layout.box.right + 1 && rect.top >= layout.box.top - 1 && rect.bottom <= layout.box.bottom + 1 && rect.left >= -1 && rect.right <= layout.width + 1,
    `${label}: every text range fits its visible box: ${JSON.stringify(layout)}`);
  return result;
}
async function detailUiState(page) {
  return page.evaluate(() => { const storage = value => Object.fromEntries(Array.from({ length: value.length }, (_, index) => value.key(index)).sort().map(key => [key, value.getItem(key)]));
    return { url: location.href, history: history.length, local: storage(localStorage), session: storage(sessionStorage) }; });
}
async function detailTargets(page) {
  const controls = await page.locator(".novel-mobile-detail-actions button, .novel-mobile-catalog-tools input, .novel-mobile-catalog-tools select, .novel-mobile-catalog-tools button").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => ({ text: node.getAttribute("aria-label") || node.textContent, rect: node.getBoundingClientRect().toJSON(), width: document.documentElement.clientWidth })));
  assert(controls.length >= 7);
  for (const control of controls) {
    assert(control.rect.height >= 44 && control.rect.width >= 44, `detail/catalogue controls keep 44px targets: ${JSON.stringify(control)}`);
    assert(control.rect.left >= -1 && control.rect.right <= control.width + 1, `detail/catalogue controls remain horizontally visible: ${JSON.stringify(control)}`);
  }
}
async function verifyReadLater() {
  const fixtureRunId = frozenRuns.findLast(run => run.scenario === "novel-detail-layout")?.runId;
  const page = await launch({ width: 320, height: 568 }, { detailScene: true, fixtureRunId });
  const remote = page.getByRole("button", { name: "电脑书库待读", exact: true });
  const sheet = page.getByRole("dialog", { name: "电脑书库待读", exact: true });
  const rows = sheet.locator(".novel-mobile-read-later-open");
  try {
    const [first, second] = initialData.get(page).books;
    await saveFromNovelCard(page, first.title);
    await page.getByRole("button", { name: `查看《${second.title}》详情`, exact: true }).click();
    const save = page.locator(".novel-mobile-detail-read-later");
    await save.waitFor();
    await save.click();
    assert.equal(await save.getAttribute("aria-pressed"), "true");
    await detailTargets(page);
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await remote.click();
    await sheet.waitFor();
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.firstChild.textContent)), [second.title, first.title]);
    const query = sheet.getByRole("searchbox", { name: "搜索待读清单" });
    await query.fill(first.title.slice(0, 25));
    assert.equal(await rows.count(), 1);
    await rows.first().click();
    await page.locator(".novel-mobile-detail-body h1").waitFor();
    assert.equal(await page.locator(".novel-mobile-detail-body h1").textContent(), first.title);
    assert.equal(await save.getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await page.reload();
    await remote.click();
    await sheet.waitFor();
    await horizontalBounds(page);
    await sheet.getByRole("button", { name: `从待读移除 ${first.title}`, exact: true }).click();
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.firstChild.textContent)), [second.title]);
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await sheet.waitFor({ state: "detached" });
    assert.equal(await remote.evaluate(node => document.activeElement === node), true);
  } finally { await page.close(); }
}

async function verifyReadLaterSources() {
  let signedIn = false;
  const fixtureRunId = frozenRuns.findLast(run => run.scenario === "novel-detail-layout")?.runId;
  const page = await launch({ width: 320, height: 568 }, { detailScene: true, fixtureRunId, prepare: async page => {
    await page.addInitScript(() => {
      window.Capacitor = { Plugins: { FanHaoAuth: { getSession: async () => ({
        token: sessionStorage.getItem("fixture-read-later-login") ? "usr.synthetic-read-later-session" : ""
      }) } } };
    });
    await page.route(url => url.pathname === "/api/novels", async route => {
      if (!signedIn) return route.fallback();
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), "x-fanhao-account-owner": "account:read-later-fixture" } });
    });
  } });
  const remote = page.getByRole("button", { name: "电脑书库待读", exact: true });
  const local = page.getByRole("button", { name: "手机离线待读", exact: true });
  try {
    const book = initialData.get(page).books[0];
    const otherRealm = "server:00000000-0000-4000-8000-000000000001";
    await saveFromNovelCard(page, book.title);
    await page.route(url => url.pathname === `/api/novels/${book.id}`, route => route.fulfill({ json: {
      sourceRealm: otherRealm, book: { ...book, sourceRealm: otherRealm, title: "不应打开的同编号书籍" }, chapterTotal: book.chapterCount
    } }));
    await remote.click();
    await page.locator(".novel-mobile-read-later-open").click();
    await page.getByText("待读记录与当前书库中的书籍不一致。", { exact: true }).waitFor();
    assert.equal(await page.locator(".novel-mobile-detail-hero").count(), 0);
    assert.equal(apiReads.get(page).filter(value => new URL(value).pathname.endsWith(`/${book.id}/catalog`)).length, 0);
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await remote.waitFor();
    await page.evaluate(async () => {
      const id = "local:read-later-fixture";
      const { saveLocalNovelEntry } = await import(new URL("./js/local-novels.js", location.href).href);
      await saveLocalNovelEntry({ book: { id, title: "手机合成小说", author: "手机合成作者", local: true, sourceType: "local-file" },
        chapters: [{ id: "device-read-later-chapter", index: 1, title: "合成章节", content: "合成离线正文。" }] });
    });
    await page.getByRole("button", { name: "手机离线", exact: true }).click();
    await local.click();
    await page.getByText("还没有待读小说", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await saveFromNovelCard(page, "手机合成小说");
    await local.click();
    assert.equal(await page.locator(".novel-mobile-read-later-open").evaluate(node => node.firstChild.textContent), "手机合成小说");
    const beforeLocalOpen = apiReads.get(page).length;
    await page.locator(".novel-mobile-read-later-open").click();
    const localTitle = page.locator(".novel-mobile-detail-body h1");
    await localTitle.waitFor();
    assert.equal(await localTitle.textContent(), "手机合成小说");
    assert.equal(apiReads.get(page).length, beforeLocalOpen, "phone read-later detail uses only local storage");
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await page.getByRole("button", { name: "电脑书库", exact: true }).click();
    await remote.click();
    assert.equal(await page.locator(".novel-mobile-read-later-open").evaluate(node => node.firstChild.textContent), book.title);
    const storage = await page.evaluate(realm => [JSON.stringify(["guest", realm]), '["device"]'].map(scope =>
      JSON.parse(localStorage.getItem(`fanhao.android.novelReadLater.v1:${scope}`)).books.map(item => item.id)), book.sourceRealm);
    assert.deepEqual(storage, [[book.id], ["local:read-later-fixture"]]);
    await page.evaluate(() => sessionStorage.setItem("fixture-read-later-login", "1"));
    signedIn = true;
    await page.reload();
    await page.waitForFunction(async () => {
      const { captureAccountOwner } = await import(new URL("./js/account-owner.js", location.href).href);
      return captureAccountOwner(location.origin).owner === "account:read-later-fixture";
    });
    await remote.click();
    await page.getByText("还没有待读小说", { exact: true }).waitFor();
    assert.equal(await page.locator(".novel-mobile-read-later-open").count(), 0);
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    await saveFromNovelCard(page, book.title);
    const remoteStorage = await page.evaluate(realm => ["guest", "account:read-later-fixture"].map(owner =>
      JSON.parse(localStorage.getItem(`fanhao.android.novelReadLater.v1:${JSON.stringify([owner, realm])}`)).books.map(item => item.id)), book.sourceRealm);
    assert.deepEqual(remoteStorage, [[book.id], [book.id]]);
    const invalid = `fanhao.android.novelReadLater.v1:${JSON.stringify(["account:read-later-fixture", book.sourceRealm])}`;
    await page.evaluate(key => localStorage.setItem(key, "invalid synthetic storage"), invalid);
    await saveFromNovelCard(page, book.title);
    await page.getByText("无法读取待读清单，请检查浏览器存储", { exact: true }).waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), invalid), "invalid synthetic storage");
  } finally { await page.close(); }
}

async function saveFromNovelCard(page, title) {
  await page.getByRole("button", { name: `《${title}》更多操作`, exact: true }).click();
  await page.getByRole("dialog", { name: "小说操作", exact: true }).getByRole("button", { name: "加入待读", exact: true }).click();
}

async function verifyChapterSearch(mode, { refresh = false } = {}) {
  const bookId = "fixture-novel-detail-cn";
  const chapterId = `${bookId}-chapter-1`;
  const chapterPath = `/api/novels/${bookId}/chapters/1`;
  const body = Array.from({ length: 140 }, (_, index) => {
    const text = index === 34 ? "首处 A.[甲] 合成命中。" : index === 100 ? "末处 A.[甲] 合成命中。" : "阅读正文的合成占位段落。";
    return `${index + 1}。 ${text}`;
  }).join("\n\n");
  let book, chapterReads = 0, releaseRefresh;
  const held = new Promise(resolve => { releaseRefresh = resolve; });
  const writes = [];
  const fixtureRunId = frozenRuns.findLast(run => run.scenario === "novel-detail-layout")?.runId;
  const page = await launch({ width: 320, height: 568 }, { detailScene: true, fixtureRunId, prepare: async page => {
    if (mode === "page") await page.addInitScript(() => Object.defineProperty(CSS, "highlights", { value: undefined }));
    await page.route(url => url.pathname === chapterPath, async route => {
      const updating = refresh && ++chapterReads === 2;
      if (updating) await held;
      await route.fulfill({ json: {
        sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision,
        book: updating ? { ...book, author: "更新后的合成作者" } : book,
        chapter: { id: chapterId, bookId, index: 1, title: "合成正文查找", content: body, charCount: body.length }
      } });
    });
    await page.route(url => url.pathname === `/api/novels/${bookId}/progress`, route => {
      assert.equal(route.request().method(), "POST");
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    });
  } });
  try {
    book = initialData.get(page).books.find(item => item.id === bookId);
    await page.getByRole("button", { name: `查看《${book.title}》详情`, exact: true }).click();
    await page.locator(".novel-mobile-detail-actions .primary").click();
    const content = page.locator(".novel-reader-content");
    await content.locator("p").first().waitFor();
    if (refresh) {
      const requestUrl = new URL(apiReads.get(page).find(url => new URL(url).pathname === chapterPath));
      await page.waitForFunction(async path => {
        const { readCachedJson } = await import(new URL("./js/cache.js", location.href).href);
        return Boolean((await readCachedJson(location.origin, path))?.payload?.chapter?.content);
      }, requestUrl.pathname + requestUrl.search);
      assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
      const nextRead = page.waitForRequest(request => new URL(request.url()).pathname === chapterPath);
      await page.locator(".novel-mobile-detail-actions .primary").click();
      await nextRead;
      await content.locator("p").first().waitFor();
      assert.match(await page.locator("#viewMeta").textContent(), /缓存/);
    }
    assert.equal(await content.locator("p").count(), 140);
    await page.locator(".novel-reader-screen h1").click();
    if (mode === "page") {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      const settings = page.getByRole("region", { name: "阅读设置", exact: true });
      await settings.getByRole("button", { name: "翻页", exact: true }).click();
      await settings.getByRole("button", { name: "完成", exact: true }).click();
      await page.locator(".novel-reader-screen.mode-page").waitFor();
    }
    const find = page.getByRole("button", { name: "查找", exact: true });
    await find.click();
    const panel = page.getByRole("search", { name: "本章正文", exact: true });
    const input = panel.getByRole("searchbox", { name: "查找本章正文", exact: true });
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    const status = panel.getByRole("status");
    const position = () => content.evaluate(node => ({ x: node.scrollLeft, y: window.scrollY }));
    const start = await position();
    const before = { url: page.url(), gets: apiReads.get(page).filter(url => new URL(url).pathname.startsWith(`/api/novels/${bookId}/`)).length };
    await input.evaluate(node => {
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      node.value = "a.[甲]";
      node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    });
    assert.equal(await panel.getByRole("button", { name: "下一处匹配", exact: true }).isDisabled(), true);
    await input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    assert.equal(await status.textContent(), "2 处匹配");
    assert.deepEqual(await position(), start, "counting matches keeps the current reading position");
    await input.press("Enter");
    assert.equal(await status.textContent(), "第 1 / 2 处");
    await assertChapterMatch(page, "首处");
    const first = await position();
    assert(first[mode === "page" ? "x" : "y"] > start[mode === "page" ? "x" : "y"],
      `first match changes ${mode} position from ${JSON.stringify(start)} to ${JSON.stringify(first)}`);
    if (refresh) {
      const activeInput = await input.elementHandle();
      await input.evaluate(node => {
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        node.value = "a.[甲]候选";
        node.setSelectionRange(2, 2);
        node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      });
      releaseRefresh();
      await page.waitForFunction(() => document.querySelector(".novel-reader-meta")?.textContent.includes("更新后的合成作者"));
      assert.equal(await activeInput.evaluate(node => node === document.activeElement && node.selectionStart === 2), true);
      assert.equal(await input.inputValue(), "a.[甲]候选");
      assert.equal(await status.textContent(), "第 1 / 2 处");
      assert.deepEqual(await position(), first);
      await assertChapterMatch(page, "首处");
      await input.evaluate(node => {
        node.value = "a.[甲]";
        node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      });
    }
    await panel.getByRole("button", { name: "上一处匹配", exact: true }).click();
    assert.equal(await status.textContent(), "第 2 / 2 处");
    await assertChapterMatch(page, "末处");
    const saving = refresh ? page.waitForRequest(request => new URL(request.url()).pathname === `/api/novels/${bookId}/progress`
      && request.postDataJSON()?.scrollRatio > 0) : null;
    await panel.getByRole("button", { name: "下一处匹配", exact: true }).click();
    assert.equal(await status.textContent(), "第 1 / 2 处");
    await assertChapterMatch(page, "首处");
    if (saving) {
      const saved = await saving;
      const progress = saved.postDataJSON();
      assert.equal(progress.chapterId, chapterId);
      assert.equal(progress.catalogRevision, book.catalogRevision);
      assert.equal(progress.chapterIndex, 1);
    }
    const controls = await panel.locator("input, button").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    assert(controls.every(rect => rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= 320));
    await input.fill("无法匹配");
    assert.equal(await status.textContent(), "本章无匹配");
    assert.equal(await panel.getByRole("button", { name: "下一处匹配", exact: true }).isDisabled(), true);
    await input.fill("a.[甲]");
    await input.press("Enter");
    await assertChapterMatch(page, "首处");
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    assert.equal(await panel.count(), 0);
    assert.equal(await find.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => CSS.highlights?.has("novel-reader-search-match")
      || Boolean(document.querySelector(".novel-reader-content mark"))), false);
    assert.equal(page.url(), before.url);
    assert.equal(apiReads.get(page).filter(url => new URL(url).pathname.startsWith(`/api/novels/${bookId}/`)).length, before.gets);
    assert.equal(await content.locator("p").allTextContents().then(parts => parts.join("\n\n")), body);
    assert(writes.every(write => write.chapterId === chapterId && write.catalogRevision === book.catalogRevision));
  } finally { releaseRefresh(); await page.close(); }
}
async function assertChapterMatch(page, expectedParagraph) {
  await frames(page);
  const actual = await page.evaluate(() => {
    const ranges = CSS.highlights?.get("novel-reader-search-match");
    const match = ranges ? [...ranges][0] : document.querySelector(".novel-reader-content mark");
    const rect = match.getClientRects()[0];
    const paragraph = match.startContainer?.parentElement || match.closest("p");
    const searchBottom = document.querySelector(".novel-reader-chapter-search").getBoundingClientRect().bottom;
    return { text: match instanceof Element ? match.textContent : String(match),
      paragraph: paragraph.textContent, rect: rect.toJSON(), searchBottom, width: innerWidth, height: innerHeight };
  });
  assert.equal(actual.text, "A.[甲]");
  assert(actual.paragraph.includes(expectedParagraph));
  assert(actual.rect.left >= 0 && actual.rect.right <= actual.width && actual.rect.top >= actual.searchBottom
    && actual.rect.bottom <= actual.height, `highlight is visible in the current column or viewport: ${JSON.stringify(actual)}`);
}

function bookTextSearchPage(book, query, index, nextAfter = null) {
  return { bookId: book.id, sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision, query,
    matches: [{ id: `${book.id}-chapter-${index}`, index, title: `合成正文第 ${index} 章`, before: "定位之前 ", match: "A.[甲]", after: " 定位之后" }], nextAfter };
}

async function launchBookTextSearch(prepare) {
  return launch({ width: 320, height: 568 }, {
    detailScene: true, fixtureRunId: frozenRuns.findLast(run => run.scenario === "novel-detail-layout")?.runId, prepare
  });
}

async function openBookTextSearch(page, book) {
  await page.getByRole("button", { name: `查看《${book.title}》详情`, exact: true }).click();
  await page.locator(".novel-mobile-detail-book-search").click();
  return page.getByRole("dialog", { name: "搜索全书正文", exact: true });
}

async function verifyBookTextSearch(mode) {
  let book;
  const reads = [], chapterReads = [], writes = [];
  const initialChapterId = `${textSearchBookId}-chapter-1`;
  const body = Array.from({ length: 140 }, (_, index) => `${index + 1}。 ${index === 34 ? "目标位置 A.[甲] 合成命中。" : "阅读正文的合成占位段落。"}`).join("\n\n");
  const page = await launchBookTextSearch(async page => {
    if (mode === "page") await page.addInitScript(() => Object.defineProperty(CSS, "highlights", { value: undefined }));
    await page.route(url => url.pathname === textSearchPath, async route => {
      const params = new URL(route.request().url()).searchParams;
      reads.push(Object.fromEntries(params));
      assert.equal(params.get("sourceRealm"), book.sourceRealm);
      assert.equal(params.get("catalogRevision"), book.catalogRevision);
      assert.equal(params.get("q"), "a.[甲]");
      const data = params.get("after") === "0" ? bookTextSearchPage(book, "a.[甲]", 1, 1) : bookTextSearchPage(book, "a.[甲]", matchChapterIndex);
      await route.fulfill({ json: data });
    });
    await page.route(url => url.pathname === `/api/novels/${textSearchBookId}/chapters/${matchChapterIndex}`, async route => {
      chapterReads.push(Object.fromEntries(new URL(route.request().url()).searchParams));
      await route.fulfill({ json: { book, sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision,
        chapter: { id: matchChapterId, bookId: book.id, index: matchChapterIndex, title: "打开的合成匹配章", content: body, charCount: body.length } } });
    });
    await page.route(url => url.pathname === `/api/novels/${textSearchBookId}/chapters/1`, route => route.fulfill({ json: {
      book, sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision,
      chapter: { id: initialChapterId, bookId: book.id, index: 1, title: "开始的合成章节", content: body, charCount: body.length }
    } }));
    await page.route(url => url.pathname === `/api/novels/${textSearchBookId}/progress`, route => {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    });
  });
  try {
    book = initialData.get(page).books.find(item => item.id === textSearchBookId);
    const dialog = page.getByRole("dialog", { name: "搜索全书正文", exact: true });
    if (mode === "page") {
      await page.getByRole("button", { name: `查看《${book.title}》详情`, exact: true }).click();
      await page.locator(".novel-mobile-detail-actions .primary").click();
      await page.locator(".novel-reader-screen h1").filter({ hasText: "开始的合成章节" }).click();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      const settings = page.getByRole("region", { name: "阅读设置", exact: true });
      await settings.getByRole("button", { name: "翻页", exact: true }).click();
      await settings.getByRole("button", { name: "完成", exact: true }).click();
      await page.locator(".novel-reader-screen.mode-page").waitFor();
      await page.getByRole("button", { name: "查找", exact: true }).click();
      await page.getByRole("button", { name: "搜索全书正文", exact: true }).click();
    } else {
      await openBookTextSearch(page, book);
    }
    const input = dialog.getByRole("searchbox", { name: "全书正文关键词" });
    await input.fill("a.[甲]");
    await input.press("Enter");
    const first = dialog.getByRole("button", { name: /^1 · 合成正文第 1 章/ });
    await first.waitFor();
    const retained = await first.elementHandle();
    const more = dialog.getByRole("button", { name: "加载更多匹配章节" });
    await more.press("Enter");
    const target = dialog.getByRole("button", { name: /^93 · 合成正文第 93 章/ });
    await target.waitFor();
    assert.equal(await target.evaluate(node => node === document.activeElement), true);
    assert.equal(await retained.evaluate(node => node.isConnected), true);
    assert.deepEqual(reads.map(item => item.after), ["0", "1"]);
    assert.equal(await dialog.locator("mark").first().textContent(), "A.[甲]");
    const bounds = await dialog.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.height <= 568);
    await target.press("Enter");
    await page.locator(".novel-reader-screen h1").filter({ hasText: "打开的合成匹配章" }).waitFor();
    await page.getByRole("search", { name: "本章正文" }).getByRole("status").filter({ hasText: "第 1 / 1 处" }).waitFor();
    await assertChapterMatch(page, "目标位置");
    assert.deepEqual(chapterReads, [{ catalogRevision: book.catalogRevision, chapterId: matchChapterId, sourceRealm: book.sourceRealm }]);
    assert(!page.url().includes(encodeURIComponent("a.[甲]")), "正文关键词不进入章节路由");
    assert(await page.locator(`.novel-reader-screen.mode-${mode}`).count());
    const bookSearch = page.getByRole("button", { name: "搜索全书正文", exact: true });
    await bookSearch.click();
    await target.waitFor();
    assert.equal(await input.inputValue(), "a.[甲]");
    assert.equal(reads.length, 2, "同一目录版本从本章查找打开保留结果和分页");
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    assert.equal(await dialog.count(), 0);
    assert.equal(await bookSearch.evaluate(node => node === document.activeElement), true);
    await bookSearch.click();
    await target.click();
    await assertChapterMatch(page, "目标位置");
    assert.equal(chapterReads.length, 1, "当前已核对的正文直接定位，避免重复读取");
    const openedChapterIds = mode === "page" ? [initialChapterId, matchChapterId] : [matchChapterId];
    assert(writes.every(write => openedChapterIds.includes(write.chapterId) && write.catalogRevision === book.catalogRevision));
  } finally { await page.close(); }
}

async function verifyBookTextSearchOwnership() {
  let book, release;
  const pending = new Promise(resolve => { release = resolve; });
  const page = await launchBookTextSearch(async page => {
    await page.route(url => url.pathname === textSearchPath, async route => {
      const query = new URL(route.request().url()).searchParams.get("q");
      if (query === "旧搜索") await pending;
      if (query === "旧服务") return route.fulfill({ status: 404, json: {} });
      await route.fulfill({ json: bookTextSearchPage(book, query, query === "旧搜索" ? 1 : matchChapterIndex) }).catch(error => {
        if (!route.request().failure()) throw error;
      });
    });
    await page.route(url => url.pathname === `/api/novels/${textSearchBookId}/chapters/${matchChapterIndex}`, route => route.fulfill({ json: {
      book: { ...book, catalogRevision: "replacement" }, sourceRealm: book.sourceRealm, catalogRevision: "replacement",
      chapter: { id: matchChapterId, index: matchChapterIndex, content: "版本已变化" }
    } }));
  });
  try {
    book = initialData.get(page).books.find(item => item.id === textSearchBookId);
    const dialog = await openBookTextSearch(page, book);
    const input = dialog.getByRole("searchbox");
    const before = page.url();
    await input.fill("旧搜索");
    const old = page.waitForRequest(request => new URL(request.url()).searchParams.get("q") === "旧搜索");
    await input.press("Enter");
    await old;
    await input.fill("新搜索");
    await input.press("Enter");
    const target = dialog.getByRole("button", { name: /^93 · 合成正文第 93 章/ });
    await target.waitFor();
    release();
    await frames(page);
    assert.equal(await dialog.locator(".novel-book-text-result").count(), 1);
    assert.match(await dialog.getByRole("status").textContent(), /新搜索/);
    await target.click();
    await dialog.getByRole("status").filter({ hasText: "目录版本已变化" }).waitFor();
    assert.equal(await dialog.locator(".novel-book-text-result").count(), 0);
    assert.equal(page.url(), before);
    await input.fill("旧服务");
    await input.press("Enter");
    await dialog.getByRole("status").filter({ hasText: "电脑端未提供全书搜索" }).waitFor();
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    assert.equal(await dialog.count(), 0);
    assert.equal(page.url(), before);
    assert.equal(await page.locator(".novel-mobile-detail-actions .primary").isEnabled(), true);
  } finally { release(); await page.close(); }
}

async function verifyBookTextSearchLocal() {
  const page = await launchBookTextSearch();
  try {
    await page.evaluate(async () => {
      const { saveLocalNovelEntry } = await import(new URL("./js/local-novels.js", location.href).href);
      await saveLocalNovelEntry({
        book: { id: "local:text-search-fixture", title: "离线正文查找样本", local: true, sourceType: "local-file" },
        chapters: [{ id: "local-text-search-chapter", index: 1, title: "离线合成章节", content: "本章有合成关键词。" }]
      });
    });
    await page.getByRole("button", { name: "手机离线", exact: true }).click();
    await page.getByRole("button", { name: "查看《离线正文查找样本》详情", exact: true }).click();
    assert.equal(await page.locator(".novel-mobile-detail-book-search").count(), 0);
    const networkCount = apiReads.get(page).length;
    await page.locator(".novel-mobile-detail-actions .primary").click();
    await page.locator(".novel-reader-screen h1").filter({ hasText: "离线合成章节" }).click();
    await page.getByRole("button", { name: "查找", exact: true }).click();
    const panel = page.getByRole("search", { name: "本章正文", exact: true });
    assert.equal(await panel.getByRole("button", { name: "搜索全书正文", exact: true }).count(), 0);
    const input = panel.getByRole("searchbox");
    await input.fill("合成关键词");
    await input.press("Enter");
    await panel.getByRole("status").filter({ hasText: "第 1 / 1 处" }).waitFor();
    assert.equal(apiReads.get(page).length, networkCount);
  } finally { await page.close(); }
}

async function readerBookmarkPanel(page) {
  const screen = page.locator(".novel-reader-screen");
  await screen.evaluate(node => { if (!node.classList.contains("menu-open")) node.click(); });
  await page.getByRole("button", { name: "书签", exact: true }).click();
  return page.getByRole("dialog", { name: "本书书签", exact: true });
}

async function scrollBookmarkRatio(page, ratio) {
  await page.locator(".novel-reader-screen").evaluate((node, ratio) => {
    const top = scrollY + node.getBoundingClientRect().top;
    scrollTo(0, top + (node.scrollHeight - innerHeight) * ratio);
  }, ratio);
  await frames(page);
}

async function expectBookmarkRatio(page, ratio) {
  await page.waitForFunction(ratio => {
    const node = document.querySelector(".novel-reader-screen");
    const readable = node.scrollHeight - innerHeight;
    return readable > 0 && Math.abs(-node.getBoundingClientRect().top / readable - ratio) < .01;
  }, ratio);
}

async function verifyLocalBookmarks() {
  const page = await launchBookTextSearch();
  try {
    await page.evaluate(async () => {
      const { saveLocalNovelEntry } = await import(new URL("./js/local-novels.js", location.href).href);
      await saveLocalNovelEntry({ book: { id: "local:bookmark-fixture", title: "书签合成样本", local: true, sourceType: "local-file" },
        chapters: [1, 2].map(index => ({ index, title: `书签第 ${index} 章`, content: "完全合成的正文，供手机书签回归使用。".repeat(8).concat("\n\n").repeat(90) })) });
    });
    await page.getByRole("button", { name: "手机离线", exact: true }).click();
    await page.getByRole("button", { name: "查看《书签合成样本》详情", exact: true }).click();
    await page.locator(".novel-mobile-detail-actions .primary").click();
    await page.getByRole("heading", { name: "书签第 1 章", exact: true }).waitFor();
    const reads = apiReads.get(page).length;
    await frames(page);
    await scrollBookmarkRatio(page, .27);
    let panel = await readerBookmarkPanel(page);
    const bounds = await panel.boundingBox();
    assert(bounds.width <= 320 && bounds.height <= 568);
    await panel.getByRole("button", { name: "保存当前位置", exact: true }).click();
    assert.equal(await panel.locator(".novel-bookmark-open").count(), 1);
    await panel.getByRole("button", { name: "保存当前位置", exact: true }).click();
    assert.equal(await panel.getByRole("status").textContent(), "当前位置已保存");
    assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
    assert.equal(await page.getByRole("button", { name: "书签", exact: true }).evaluate(node => node === document.activeElement), true);
    await scrollBookmarkRatio(page, .63);
    panel = await readerBookmarkPanel(page);
    await panel.getByRole("button", { name: "保存当前位置", exact: true }).click();
    assert.equal(await panel.locator(".novel-bookmark-open").count(), 2);
    await panel.locator(".novel-bookmark-open").nth(1).click();
    await expectBookmarkRatio(page, .27);
    await page.getByRole("button", { name: "下一章", exact: true }).click();
    await page.getByRole("heading", { name: "书签第 2 章", exact: true }).waitFor();
    panel = await readerBookmarkPanel(page);
    await panel.locator(".novel-bookmark-open").first().click();
    await page.getByRole("heading", { name: "书签第 1 章", exact: true }).waitFor();
    await expectBookmarkRatio(page, .63);
    panel = await readerBookmarkPanel(page);
    await panel.locator(".novel-bookmark-remove").first().click();
    assert.equal(await panel.locator(".novel-bookmark-open").count(), 1);
    assert.equal(await apiReads.get(page).length, reads, "phone-only marks do not require a server read");
  } finally { await page.close(); }
}

async function verifyRemoteBookmarks() {
  let book, updated = false, offline = false, signedIn = false;
  const requests = [];
  const prefix = `/api/novels/${textSearchBookId}`;
  const body = "用于核对书签跳转的合成正文。".repeat(8).concat("\n\n").repeat(85);
  const page = await launchBookTextSearch(async page => {
    await page.addInitScript(() => {
      window.Capacitor = { Plugins: { FanHaoAuth: { getSession: async () => ({
        token: sessionStorage.getItem("fixture-bookmark-login") ? "usr.synthetic-bookmark-session" : ""
      }) } } };
    });
    await page.route(url => url.pathname.startsWith(`${prefix}/chapters/`), route => {
      const url = new URL(route.request().url());
      const index = Number(url.pathname.split("/").at(-1));
      const chapter = { id: `${book.id}-chapter-${index}`, bookId: book.id, index, title: `远程书签第 ${index} 章`, content: body, charCount: body.length };
      requests.push({ index, params: Object.fromEntries(url.searchParams) });
      if (updated && url.searchParams.has("catalogRevision")) return route.fulfill({ status: 409, json: { error: "目录版本已变化" } });
      if (offline && index === 1) return route.fulfill({ status: 503, json: { error: "电脑暂时离线" } });
      return route.fulfill({ headers: signedIn ? { "x-fanhao-account-owner": "account:bookmark-fixture" } : {},
        json: { book, sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision, chapter,
        ...(index === 1 ? { next: { index: 2, id: `${book.id}-chapter-2` } } : {}) } });
    });
    await page.route(url => url.pathname === `${prefix}/progress`, route => route.fulfill({ json: {} }));
  });
  try {
    book = initialData.get(page).books.find(item => item.id === textSearchBookId);
    await page.getByRole("button", { name: `查看《${book.title}》详情`, exact: true }).click();
    await page.locator(".novel-mobile-detail-actions .primary").click();
    await page.getByRole("heading", { name: "远程书签第 1 章", exact: true }).waitFor();
    await frames(page);
    await scrollBookmarkRatio(page, .41);
    let panel = await readerBookmarkPanel(page);
    await panel.getByRole("button", { name: "保存当前位置", exact: true }).click();
    await page.evaluate(() => window.fanhaoHandleNativeBack());
    await page.getByRole("button", { name: "下一章", exact: true }).click();
    await page.getByRole("heading", { name: "远程书签第 2 章", exact: true }).waitFor();
    panel = await readerBookmarkPanel(page);
    await panel.locator(".novel-bookmark-open").click();
    await page.getByRole("heading", { name: "远程书签第 1 章", exact: true }).waitFor();
    await expectBookmarkRatio(page, .41);
    assert.deepEqual(requests.filter(request => request.index === 1).at(-1).params,
      { chapterId: `${book.id}-chapter-1`, catalogRevision: book.catalogRevision, sourceRealm: book.sourceRealm });
    await page.locator(".novel-reader-screen").evaluate(node => { if (!node.classList.contains("menu-open")) node.click(); });
    await page.getByRole("button", { name: "下一章", exact: true }).click();
    await page.getByRole("heading", { name: "远程书签第 2 章", exact: true }).waitFor();
    offline = true;
    panel = await readerBookmarkPanel(page);
    await panel.locator(".novel-bookmark-open").click();
    await page.getByText(/电脑端暂时连不上，当前显示的是本地缓存章节/).waitFor();
    await expectBookmarkRatio(page, .41);
    offline = false;
    await page.locator(".novel-reader-screen").evaluate(node => { if (!node.classList.contains("menu-open")) node.click(); });
    await page.getByRole("button", { name: "下一章", exact: true }).click();
    await page.getByRole("heading", { name: "远程书签第 2 章", exact: true }).waitFor();
    panel = await readerBookmarkPanel(page);
    const oldSave = await panel.getByRole("button", { name: "保存当前位置", exact: true }).elementHandle();
    updated = true;
    await panel.locator(".novel-bookmark-open").click();
    await page.getByText(/目录已更新，旧位置未覆盖/).waitFor();
    assert.equal(await page.locator(".novel-reader-screen").count(), 0, "known old cached content cannot bypass the new version response");
    await oldSave.evaluate(node => node.click());
    const keys = ["guest", "account:bookmark-fixture"].map(owner => `fanhao.android.novelBookmarks.v1:${JSON.stringify([owner, book.sourceRealm, book.id])}`);
    const readMarks = () => page.evaluate(keys => keys.map(key => JSON.parse(localStorage.getItem(key))), keys);
    const saved = await readMarks();
    assert.equal(saved[0].length, 1);
    assert.equal(saved[1], null);
    updated = false;
    signedIn = true;
    await page.evaluate(() => sessionStorage.setItem("fixture-bookmark-login", "1"));
    await page.reload();
    await page.getByRole("heading", { name: "远程书签第 1 章", exact: true }).waitFor();
    panel = await readerBookmarkPanel(page);
    assert.equal(await panel.locator(".novel-bookmark-open").count(), 0);
    const retiredSave = await panel.getByRole("button", { name: "保存当前位置", exact: true }).elementHandle();
    const afterOwnerChange = await retiredSave.evaluate(async (node, keys) => {
      const { setAccountOwner } = await import(new URL("./js/account-owner.js", location.href).href);
      setAccountOwner(location.origin, "guest");
      node.click();
      return { connected: node.isConnected, storage: keys.map(key => JSON.parse(localStorage.getItem(key))) };
    }, keys);
    assert.deepEqual(afterOwnerChange, { connected: false, storage: saved });
  } finally { await page.close(); }
}

async function verifyDetailActionTiming() {
  const bookId = "fixture-novel-detail-cn";
  const metaPath = `/api/novels/${bookId}`;
  const delayMs = 225;
  const chapterIndex = 137, chapterId = `${bookId}-chapter-${chapterIndex}`;
  const chapterPath = `${metaPath}/chapters/${chapterIndex}`;
  const body = "用于测量续读实际正文的合成内容。";
  const actionSamples = [], bodySamples = [];
  // The fixture keeps at most twelve source snapshots. Each newPage still
  // starts with a fresh context and its own browser storage.
  let fixtureRunId;
  for (const resume of [false, true]) {
    const repetitions = measureDetailActions ? 3 : 1;
    for (let iteration = 0; iteration < repetitions; iteration++) {
      let catalogueStarted = 0, catalogueReleased = false, meta;
      let releaseCatalogue;
      const catalogueGate = new Promise(resolve => { releaseCatalogue = resolve; });
      const page = await launch({ width: 390, height: 844 }, { detailScene: true, fixtureRunId, prepare: async page => {
        if (baselineDetailActions) await page.route(url => url.pathname.endsWith("/modules/novels/novel-views.js"), async route => {
          const response = await route.fetch();
          let body = await response.text();
          const marker = "const replaceDetail = renderedCache || !normalizeSourceRealm(book.sourceRealm) || !book.catalogRevision;";
          assert.equal(body.split(marker).length, 2, "the comparison changes only whether the actual metadata mount waits for the catalogue");
          body = body.replace(marker, "const replaceDetail = true;");
          await route.fulfill({ response, body });
        });
        await page.route(url => url.pathname === `${metaPath}/catalog`, async route => {
          catalogueStarted++;
          if (measureDetailActions) await new Promise(resolve => setTimeout(resolve, delayMs));
          else await catalogueGate;
          catalogueReleased = true;
          await route.continue();
        });
        if (!resume) return;
        await page.route(url => url.pathname === metaPath && url.searchParams.get("catalog") === "0", async route => {
          const response = await route.fetch();
          meta = await response.json();
          meta.book.progress = { status: "resolved", chapterId, chapterIndex, catalogRevision: meta.catalogRevision,
            scrollRatio: 0, updatedAt: meta.book.updatedAt };
          await route.fulfill({ response, json: meta });
        });
        await page.route(url => url.pathname === chapterPath, async route => {
          const url = new URL(route.request().url());
          assert.equal(route.request().method(), "GET");
          assert.deepEqual(Object.fromEntries(url.searchParams), { chapterId, catalogRevision: meta.catalogRevision, sourceRealm: meta.sourceRealm });
          await route.fulfill({ json: { sourceRealm: meta.sourceRealm, catalogRevision: meta.catalogRevision, book: meta.book,
            chapter: { id: chapterId, bookId, index: chapterIndex, title: "合成续读章", content: body, charCount: body.length }, prev: null, next: null } });
        });
      } });
      try {
        fixtureRunId ||= new URL(page.url()).pathname.split("/")[2];
        const book = initialData.get(page).books.find(book => book.id === bookId);
        const card = page.getByRole("button", { name: `查看《${book.title}》详情`, exact: true });
        const read = page.locator(".novel-mobile-detail-actions .primary");
        await card.evaluate((node, resume) => node.addEventListener("click", () => {
          const start = performance.now();
          const observer = new MutationObserver(() => {
            const read = document.querySelector(".novel-mobile-detail-actions .primary");
            if (read && !read.disabled && !window.detailActionTiming) window.detailActionTiming = performance.now() - start;
            if (!resume) { if (window.detailActionTiming) observer.disconnect(); return; }
            if (!document.querySelector(".novel-reader-content p")) return;
            window.detailBodyTiming = performance.now() - start;
            observer.disconnect();
          });
          observer.observe(document.getElementById("viewContent"), { childList: true, subtree: true });
        }, { once: true, capture: true }), resume);
        const catalogue = resume ? null : catalogueResponse(page, bookId);
        const requested = page.waitForRequest(request => new URL(request.url()).pathname === `${metaPath}/catalog`);
        await card.click();
        await requested;
        await read.waitFor();
        assert.equal(!catalogueReleased, !baselineDetailActions, "enabled action and held directory GET are independent");
        assert.equal(await read.textContent(), resume ? "继续阅读" : "开始阅读");
        if (!measureDetailActions) assert.equal(await page.locator("#novelDetailCatalog .novel-reader-catalog-loading").textContent(), "正在读取章节目录…");
        if (resume) {
          const cancelled = baselineDetailActions ? null : page.waitForEvent("requestfailed", { predicate: request => new URL(request.url()).pathname === `${metaPath}/catalog` });
          await read.click({ force: true });
          await page.locator(".novel-reader-content").getByText(body, { exact: true }).waitFor();
          assert.equal(!catalogueReleased, !baselineDetailActions, "actual chapter body can render while the catalogue response is held");
          if (cancelled) assert.match((await cancelled).failure().errorText, /ERR_ABORTED/);
          assert.equal(await page.locator("#novelDetailCatalog").count(), 0, "the old directory cannot replace the reader");
          bodySamples.push(await page.evaluate(() => window.detailBodyTiming));
        } else {
          const mounted = await read.elementHandle();
          releaseCatalogue();
          const result = await catalogue;
          await catalogueRendered(page, result.payload);
          assert.equal(await mounted.evaluate(node => node.isConnected), true, "directory load preserves the already mounted action");
        }
        assert.equal(catalogueStarted, 1);
        const count = pathname => apiReads.get(page).filter(url => new URL(url).pathname === pathname).length;
        assert.equal(count(metaPath), 1);
        assert.equal(count(`${metaPath}/catalog`), 1);
        assert.equal(count(chapterPath), resume ? 1 : 0);
        if (!resume) actionSamples.push(await page.evaluate(() => window.detailActionTiming));
      } finally { releaseCatalogue(); await page.close(); }
    }
  }
  assert([...actionSamples, ...bodySamples].every(Number.isFinite));
  const median = samples => samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
  profiles.push({ case: "detail-action-timing", baseline: baselineDetailActions, delayMs: measureDetailActions ? delayMs : null, actionSamples, bodySamples,
    medianActionMs: median(actionSamples), medianBodyMs: median(bodySamples), metadataGets: 1, catalogueGets: 1, resumeChapterGets: 1 });
}
async function verifyDetails(viewport) {
  const page = await launch(viewport, { detailScene: true });
  try {
    for (const suffix of ["cn", "latin", "empty", "error"]) {
      const book = initialData.get(page).books.find(book => book.id === `fixture-novel-detail-${suffix}`); assert(book);
      const initialCatalogue = catalogueResponse(page, book.id);
      await page.getByRole("button", { name: `查看《${book.title}》详情`, exact: true }).click();
      const initial = await initialCatalogue; assert.equal(initial.status, suffix === "error" ? 503 : 200);
      await page.locator(".novel-mobile-detail-body h1").waitFor(); await page.waitForLoadState("networkidle"); await frames(page);
      assert.equal(await page.locator(".novel-mobile-detail-body h1").textContent(), book.title);
      const title = await wholeText(page.locator(".novel-mobile-detail-body h1"), `${suffix} detail title`);
      const metadata = await wholeText(page.locator(".novel-mobile-detail-body > span"), `${suffix} detail metadata`);
      const summary = page.locator(".novel-mobile-summary-panel"), toggle = page.locator(".novel-mobile-summary-toggle");
      if (suffix === "cn") {
        assert.equal(await toggle.count(), 1); assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        const nodes = await Promise.all([".novel-mobile-summary-toggle", ".novel-mobile-summary-panel p", ".novel-mobile-detail-body h1"].map(selector => page.locator(selector).elementHandle()));
        const state = await detailUiState(page), gets = apiReads.get(page).length;
        await toggle.click(); await frames(page); assert.equal(await toggle.getAttribute("aria-expanded"), "true");
        await wholeText(summary.locator("p"), "expanded long synopsis including the unbroken Latin paragraph");
        assert.equal(await toggle.evaluate(node => document.activeElement === node), true);
        await toggle.click(); await frames(page); assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        for (const node of nodes) assert.equal(await node.evaluate(node => node.isConnected), true, "synopsis toggling preserves its actual mounted controls/text");
        assert.deepEqual(await detailUiState(page), state); assert.equal(apiReads.get(page).length, gets, "synopsis expansion/collapse makes no HTTP request");
      } else if (suffix === "empty") { assert.equal(await summary.count(), 0, "empty synopsis is omitted without invented fallback text"); assert.equal(await toggle.count(), 0); }
      else { assert.equal(await toggle.count(), 0); assert.equal(await summary.locator("p").textContent(), book.summary); await wholeText(summary.locator("p"), `${suffix} short synopsis`); }
      await page.locator(".novel-mobile-book-tools > summary").click();
      await detailTargets(page); await horizontalBounds(page);
      if (suffix === "error") {
        const error = page.locator("#novelDetailCatalog .novel-reader-catalog-loading.error"); await error.waitFor();
        await wholeText(error, "catalogue error text"); await detailTargets(page); await horizontalBounds(page);
        assert.equal(await page.locator(".novel-mobile-catalog-list .novel-mobile-chapter").count(), 0);
      } else {
        const data = initial.payload; assert.equal(data.bookId, book.id); assert.equal(data.sourceRealm, book.sourceRealm); assert.equal(data.catalogRevision, book.catalogRevision);
        await catalogueRendered(page, data);
        if (suffix === "cn") await verifyPagedDetail(page, book, data);
        else if (suffix === "latin") assert.equal(data.chapters.length, 3);
        else { assert.equal(data.total, 0); assert.equal(data.chapters.length, 0); assert.equal(await page.locator(".novel-mobile-catalog-empty").textContent(), "没有匹配的章节"); }
      }
      profiles.push({ profile: `${viewport.width}x${viewport.height}`, case: "detail", book: suffix, title, metadata, chapters: book.chapterCount, catalogueStatus: initial.status });
      await page.locator("#viewBack").click(); await page.waitForFunction(() => document.querySelectorAll(".novel-mobile-book-row").length === 4);
    }
  } finally { await page.close(); }
}
async function verifyPagedDetail(page, book, initial) {
  assert.equal(initial.chapters.length, 80); assert.equal(initial.firstIndex, 1); assert.equal(initial.lastIndex, 80);
  const pagination = page.locator(".novel-mobile-catalog-pagination"), search = page.getByRole("searchbox", { name: "搜索章节", exact: true }), order = page.locator(".novel-mobile-catalog-order");
  let reply = catalogueResponse(page, book.id, url => url.searchParams.get("offset") === "80"); await pagination.getByRole("button", { name: "下一段", exact: true }).click();
  let next = await reply; assert.equal(next.status, 200); assert.equal(next.payload.firstIndex, 81); assert.equal(next.payload.lastIndex, 160); await catalogueRendered(page, next.payload);
  reply = catalogueResponse(page, book.id, url => url.searchParams.get("offset") === "160"); await page.getByRole("combobox", { name: "目录分段", exact: true }).selectOption("2");
  next = await reply; assert.equal(next.payload.chapters.length, 1); assert.equal(next.payload.firstIndex, 161); await catalogueRendered(page, next.payload);
  for (const [query, index] of [["syntheticcatalogchapter", 80], ["161", 161], ["不存在的合成章节", 0]]) {
    reply = catalogueResponse(page, book.id, url => url.searchParams.get("q") === query); await search.fill(query); next = await reply;
    assert.equal(next.status, 200); assert.equal(next.payload.filteredTotal, index ? 1 : 0); assert.equal(next.payload.total, 161);
    if (index) assert.equal(next.payload.chapters[0].index, index); await catalogueRendered(page, next.payload);
  }
  reply = catalogueResponse(page, book.id, url => !url.searchParams.has("q") && url.searchParams.get("offset") === "0"); await search.fill(""); next = await reply; await catalogueRendered(page, next.payload);
  reply = catalogueResponse(page, book.id, url => url.searchParams.get("order") === "desc" && url.searchParams.get("anchor") === "1"); await order.click(); next = await reply;
  assert.equal(next.payload.order, "desc"); assert.equal(next.payload.offset, 160); assert.equal(next.payload.firstIndex, 1); await catalogueRendered(page, next.payload);
  reply = catalogueResponse(page, book.id, url => url.searchParams.get("order") === "desc" && url.searchParams.get("offset") === "0"); await page.getByRole("combobox", { name: "目录分段", exact: true }).selectOption("0"); next = await reply;
  assert.equal(next.payload.firstIndex, 161); assert.equal(next.payload.lastIndex, 82); await catalogueRendered(page, next.payload); await horizontalBounds(page);
}

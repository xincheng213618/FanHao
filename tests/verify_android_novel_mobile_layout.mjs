import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

// Complete real Android launcher/app/modules/cascade. Synthetic list and
// metadata-only detail/catalogue GETs; no reader text, downloads or write flows.
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
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const longQuery = "SyntheticNovelSearchQueryWithoutWordBreaksForCheckingNarrowScreenEmptyStateAndRetry";
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
  assert(checks > 0); assert.deepEqual(faults, []);
  console.log(JSON.stringify({ result: "PASS", scenarios: checks, profiles, frozenRuns,
    boundary: "Actual Chromium full shell; synthetic list/bookMeta/catalogue GETs only; no reader text, authors, downloads, writes, real novels/database or native-device claim" }, null, 2));
} finally {
  await browser?.close(); service.kill("SIGTERM"); await Promise.race([serviceExit, new Promise(resolve => setTimeout(resolve, 3000))]);
}
async function launch(viewport, { noRO = false, detailScene = false } = {}) {
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
  await page.goto(origin);
  const initial = novelResponse(page, () => true);
  await page.getByRole("button", { name: detailScene ? "小说详情与章节目录（长书名、简介与分页）" : "小说分类测试（8个书库分类，含长名称）", exact: true }).click();
  await page.waitForURL(url => url.pathname.startsWith("/run/"));
  const runId = new URL(page.url()).pathname.split("/")[2], frozen = (await (await page.request.get(`${origin}/fixture/requests?run=${runId}`)).json()).runs[0];
  frozenRuns.push({ runId, scenario: frozen.scenario, files: frozen.files.filter(file => ["app.js", "modules/novels/styles.css", "modules/novels/mobile-refinements.css", "modules/novels/novel-views.js", "modules/novels/android-module.js"].includes(file.name)).map(file => ({ name: file.name, sha256: file.servedSha256 })) });
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

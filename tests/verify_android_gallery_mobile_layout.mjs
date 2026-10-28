import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

// Complete Android shell and real navigation; only the loopback API and posters
// are synthetic. DOM evaluation below measures layout, never seeds app state.
const root = path.resolve(import.meta.dirname, "..");
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executablePath, "Chrome or Edge required for the actual Android shell fixture");
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const legacyTitle = process.argv.includes("--legacy-title");
const legacyPhotoReturn = process.argv.includes("--legacy-photo-return");
const legacyFacts = process.argv.includes("--legacy-facts");
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serviceExit = new Promise(resolve => service.once("exit", resolve));
let browser, origin, checks = 0;
const faults = [], frozenRuns = [], profiles = [];
const viewports = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const selected = name => (!caseFilter || name.includes(caseFilter)) && (!legacyPhotoReturn || name.startsWith("photo:"))
  && (!(legacyTitle || legacyFacts) || name.startsWith("media:"));
async function run(name, task) {
  if (!selected(name)) return;
  await task(); checks++; console.log(`PASS ${name}`);
}

try {
  origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("synthetic fixture startup timed out")), 15000);
    service.stdout.on("data", bytes => { output += bytes; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited before startup (${code})`)); });
  });
  browser = await chromium.launch({ executablePath, headless: true });
  for (const viewport of viewports) {
    const profile = `${viewport.width}x${viewport.height}`;
    await run(`media: ${profile} Chinese and unbroken Latin movie details remain fully readable`, async () => {
      const page = await newPage(viewport);
      try {
        await launch(page, "影视布局压力（长片名、剧名与文件信息）");
        const cards = page.locator(".media-poster-card");
        await cards.first().waitFor(); assert.equal(await cards.count(), 2);
        for (let index = 0; index < 2; index++) {
          const title = await cards.nth(index).locator("strong").textContent();
          await cards.nth(index).click();
          await page.locator(".media-player-title strong").waitFor(); await frames(page);
          const layout = await assertDetail(page, title, profile);
          profiles.push({ profile, kind: `movie-${index + 1}`, ...layout });
          await page.locator(".media-back-action").click();
          await cards.first().waitFor(); assert.equal(await cards.count(), 2);
          assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("mode"), "movie");
        }
      } finally { await page.close(); }
    });
    await run(`media: ${profile} long series and episode navigation preserve their catalogue`, async () => {
      const page = await newPage(viewport);
      try {
        await launch(page, "影视布局压力（长片名、剧名与文件信息）");
        await galleryMode(page, "电视剧");
        await page.locator(".media-poster-card").click();
        await page.locator(".media-episode-card").first().waitFor();
        assert.equal(await page.locator(".media-episode-card").count(), 2);
        const title = await page.locator(".media-episode-card strong").first().textContent();
        await page.locator(".media-episode-card").first().click();
        await page.locator(".media-player-title strong").waitFor(); await frames(page);
        profiles.push({ profile, kind: "episode-1", ...await assertDetail(page, title, profile) });
        await page.locator('.media-episode-nav[data-state="ready"]').waitFor();
        const next = page.getByRole("button", { name: "下一集", exact: true });
        assert.equal(await next.isEnabled(), true); await next.click();
        await page.waitForURL(url => url.hash.includes("fixture-media-layout-episode-2"));
        await page.locator(".media-player-title strong").waitFor(); await frames(page);
        profiles.push({ profile, kind: "episode-2", ...await assertDetail(page, "SyntheticEpisodeTwoContinuousLatinFilenameForPortraitAndLandscapeNavigationWithoutAnyRealVideo", profile) });
        await page.locator(".media-back-action").click();
        await page.locator(".media-player-title strong").waitFor();
        assert((await page.locator(".media-player-title strong").textContent()).includes(title), "first Back retains the previous episode in the actual stack");
        await page.locator(".media-back-action").click();
        await page.locator(".media-episode-card").first().waitFor();
        assert.equal(await page.locator(".media-episode-card").count(), 2);
        assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("seriesKey"), "fixture-media-layout-series");
      } finally { await page.close(); }
    });
    await run(`photo: ${profile} category return has a 44px target and restores actual filters`, async () => {
      const page = await newPage(viewport);
      try {
        await launch(page, "影视布局压力（长片名、剧名与文件信息）");
        await galleryMode(page, "套图");
        await page.locator('.photo-chrome-tabs button[aria-label="COS"]').click();
        await page.locator(".photo-collection-card").waitFor();
        await page.locator(".photo-sort-action").click();
        await page.getByRole("dialog").getByRole("button", { name: "名称排序", exact: true }).click();
        await page.locator(".photo-collection-card").waitFor(); await frames(page);
        const before = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
        assert.equal(before.get("category"), "[COS]"); assert.equal(before.get("sort"), "title");
        await page.locator(".photo-collection-card").click();
        const back = page.getByRole("button", { name: "返回分类", exact: true });
        await back.waitFor(); await back.scrollIntoViewIfNeeded(); await frames(page);
        const box = await back.boundingBox();
        assert(box.width >= 44 && box.height >= 44, `photo return hit target must be 44px: ${JSON.stringify(box)}`);
        await back.click(); await page.locator(".photo-collection-card").waitFor();
        const after = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
        for (const key of ["mode", "category", "photoView", "sort"]) assert.equal(after.get(key), before.get(key), `actual category return preserves ${key}`);
        assert.equal(after.get("collection"), null);
        await assertNoHorizontalOverflow(page);
        profiles.push({ profile, kind: "photo-return", width: box.width, height: box.height });
      } finally { await page.close(); }
    });
  }
  await run("default: 320x568 original photo, movies and series remain reachable", async () => {
    const page = await newPage(viewports[0]);
    try {
      await launch(page, "新建隔离运行并打开真实页面");
      assert.equal(await page.locator(".photo-collection-card").count(), 1);
      await galleryMode(page, "电影"); await page.locator(".media-poster-card").first().waitFor();
      assert.deepEqual(await page.locator(".media-poster-card strong").allTextContents(), ["合成电影：远航计划", "合成电影：暮色列车"]);
      await page.locator(".media-poster-card").first().click(); await page.locator(".media-player-title strong").waitFor();
      await visibleTail(page.locator(".media-player-title strong"), "ordinary movie title"); await assertNoHorizontalOverflow(page);
      await page.locator(".media-back-action").click(); await page.locator(".media-poster-card").first().waitFor();
      await galleryMode(page, "电视剧"); await page.locator(".media-poster-card").waitFor();
      assert.equal(await page.locator(".media-poster-card strong").textContent(), "合成剧集：春日车站");
      await page.locator(".media-poster-card").click(); await page.locator(".media-episode-card").first().waitFor();
      assert.equal(await page.locator(".media-episode-card").count(), 2); await assertNoHorizontalOverflow(page);
    } finally { await page.close(); }
  });
  assert(checks > 0, "case filter must select a scenario"); assert.deepEqual(faults, []);
  console.log(JSON.stringify({ result: "PASS", scenarios: checks, profiles, frozenRuns,
    boundary: "Actual Chromium full shell and synthetic GET DTOs; no real library, media bytes, native player or device claim" }, null, 2));
} finally {
  await browser?.close(); service.kill("SIGTERM");
  await Promise.race([serviceExit, new Promise(resolve => setTimeout(resolve, 3000))]);
}

async function newPage(viewport) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", error => faults.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) { faults.push(`external ${url.origin}${url.pathname}`); return route.abort(); }
    if (!["GET", "HEAD"].includes(request.method()) && url.pathname !== "/fixture/new-run") { faults.push(`unexpected write ${request.method()} ${url.pathname}`); return route.abort(); }
    if (/^\/media\/(?:gallery-video|gallery-stream|video)\//.test(url.pathname)) { faults.push(`unexpected media ${url.pathname}`); return route.abort(); }
    await route.continue();
  });
  // Mutation hooks operate on the exact served product CSS, retaining the rest
  // of its current cascade and the fixture's real app/modules.
  if (legacyTitle || legacyFacts) await page.route(url => url.pathname.endsWith("/modules/media/styles.css"), async route => {
    const response = await route.fetch(); let body = await response.text();
    if (legacyTitle) {
      const marker = ' .media-player-title strong {\n  display: block;\n  overflow: visible;\n  white-space: normal;\n  -webkit-line-clamp: unset;';
      assert.equal(body.replaceAll("\r\n", "\n").split(marker).length, 2, "title negative changes one actual detail rule");
      body = body.replaceAll("\r\n", "\n").replace(marker, ' .media-player-title strong {');
    }
    if (legacyFacts) {
      const marker = '.content-panel[data-view="mediaDetail"]:is([data-channel-mode="movie"], [data-channel-mode="tv"], [data-channel-mode="anime"], [data-channel-mode="media"]) .media-detail-facts > span {\n  min-width: 0;\n  max-width: 100%;\n  white-space: normal;\n  overflow-wrap: anywhere;\n}';
      assert.equal(body.replaceAll("\r\n", "\n").split(marker).length, 2, "facts negative removes one actual scoped wrap rule");
      body = body.replaceAll("\r\n", "\n").replace(marker, "/* scoped file-fact wrapping omitted */");
    }
    await route.fulfill({ response, body });
  });
  if (legacyPhotoReturn) await page.route(url => url.pathname.endsWith("/modules/photos/styles.css"), async route => {
    const response = await route.fetch(); let body = await response.text();
    const marker = '.content-panel[data-channel-mode="photo"] .channel-context-row button {\n  min-height: 44px;\n}';
    assert.equal(body.replaceAll("\r\n", "\n").split(marker).length, 2, "photo negative removes one actual contextual return rule");
    body = body.replaceAll("\r\n", "\n").replace(marker, "/* contextual return 44px target omitted */");
    await route.fulfill({ response, body });
  });
  return page;
}
async function launch(page, label) {
  await page.goto(origin);
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForURL(url => url.pathname.startsWith("/run/"));
  const runId = new URL(page.url()).pathname.split("/")[2];
  const frozen = (await (await page.request.get(`${origin}/fixture/requests?run=${runId}`)).json()).runs[0];
  frozenRuns.push({ runId: frozen.runId, scenario: frozen.scenario,
    files: frozen.files.filter(file => ["app.js", "modules/media/styles.css", "modules/photos/styles.css"].includes(file.name)).map(file => ({ name: file.name, sha256: file.servedSha256 })) });
  await page.locator(frozen.scenario === "default" ? ".photo-collection-card" : ".media-poster-card").first().waitFor(); await frames(page);
}
async function galleryMode(page, label) {
  const trigger = page.locator(".bottom-nav [data-gallery-switcher]");
  await trigger.focus(); await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "选择图库或影视", exact: true });
  await menu.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
}
async function assertNoHorizontalOverflow(page) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth,
    panel: document.querySelector("#contentPanel").getBoundingClientRect().toJSON() }));
  assert(geometry.html <= geometry.width + 1 && geometry.body <= geometry.width + 1, `page has no horizontal overflow: ${JSON.stringify(geometry)}`);
  assert(geometry.panel.left >= -1 && geometry.panel.right <= geometry.width + 1, "content panel remains within the viewport");
}
async function visibleTail(locator, message) {
  const geometry = await locator.evaluate(node => {
    const text = node.textContent, walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) if (walker.currentNode.textContent) nodes.push(walker.currentNode);
    const last = nodes.at(-1), range = document.createRange();
    range.setStart(last, Math.max(0, last.textContent.length - 12)); range.setEnd(last, last.textContent.length);
    return { text, box: node.getBoundingClientRect().toJSON(), tail: [...range.getClientRects()].map(rect => rect.toJSON()),
      width: node.clientWidth, scrollWidth: node.scrollWidth, viewport: innerWidth };
  });
  assert(geometry.tail.length > 0, `${message}: actual trailing text has layout`);
  for (const tail of geometry.tail) assert(tail.left >= geometry.box.left - 1 && tail.right <= geometry.box.right + 1
    && tail.top >= geometry.box.top - 1 && tail.bottom <= geometry.box.bottom + 1
    && tail.left >= -1 && tail.right <= geometry.viewport + 1, `${message}: trailing text is inside its visible box: ${JSON.stringify(geometry)}`);
  assert(geometry.scrollWidth <= geometry.width + 1, `${message}: no internal horizontal overflow: ${JSON.stringify(geometry)}`);
  return { textLength: geometry.text.length, height: geometry.box.height };
}
async function assertDetail(page, expectedTitle, profile) {
  const title = page.locator(".media-player-title strong");
  assert((await title.textContent()).includes(expectedTitle), "real detail retains the selected title");
  const titleGeometry = await visibleTail(title, `${profile} detail title`);
  await page.locator(".media-detail-summary > summary").click();
  const facts = page.locator(".media-detail-facts"), rootLabel = facts.locator("span").last();
  await rootLabel.scrollIntoViewIfNeeded(); await frames(page);
  await visibleTail(rootLabel, `${profile} root label`);
  const rootBounds = await rootLabel.boundingBox(), factsBounds = await facts.boundingBox();
  assert(rootBounds.x >= factsBounds.x - 1 && rootBounds.x + rootBounds.width <= factsBounds.x + factsBounds.width + 1, "root label wraps inside facts");
  await visibleTail(page.locator(".media-detail-path"), `${profile} relative path`);
  await assertNoHorizontalOverflow(page);
  return titleGeometry;
}
